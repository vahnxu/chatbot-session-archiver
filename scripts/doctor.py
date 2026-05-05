#!/usr/bin/env python3
"""Diagnose the local Chrome extension + native host install.

The native host installer can only register the local Python writer. Chrome
still has to load the unpacked extension in the browser profile. This script
checks both halves and prints only sanitized profile/extension fields.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import struct
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True

from install_native_host import (  # noqa: E402
    DEFAULT_EXTENSION_ID,
    HOST_NAME,
    chrome_manifest_dir,
)


def default_profile_root(browser: str) -> Path:
    system = platform.system()
    home = Path.home()
    if system == "Darwin":
        roots = {
            "chrome": home / "Library/Application Support/Google/Chrome",
            "chromium": home / "Library/Application Support/Chromium",
            "brave": home / "Library/Application Support/BraveSoftware/Brave-Browser",
            "edge": home / "Library/Application Support/Microsoft Edge",
        }
    elif system == "Linux":
        roots = {
            "chrome": home / ".config/google-chrome",
            "chromium": home / ".config/chromium",
            "brave": home / ".config/BraveSoftware/Brave-Browser",
            "edge": home / ".config/microsoft-edge",
        }
    else:
        raise SystemExit(f"Unsupported OS for automatic Chrome profile checks: {system}")

    try:
        return roots[browser]
    except KeyError as exc:
        choices = ", ".join(sorted(roots))
        raise SystemExit(f"Unsupported browser '{browser}'. Choose one of: {choices}") from exc


def status(ok: bool, label: str) -> None:
    marker = "OK" if ok else "FAIL"
    print(f"{marker}: {label}")


def read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except json.JSONDecodeError as exc:
        status(False, f"invalid JSON: {path} ({exc})")
        return None
    if not isinstance(data, dict):
        status(False, f"JSON root is not an object: {path}")
        return None
    return data


def check_extension_source(repo_root: Path) -> bool:
    manifest_path = repo_root / "manifest.json"
    manifest = read_json(manifest_path)
    if not manifest:
        status(False, f"extension manifest missing or unreadable: {manifest_path}")
        return False

    ok = True
    status(True, f"extension source found: {repo_root}")
    status(manifest.get("manifest_version") == 3, "manifest_version is 3")
    if manifest.get("manifest_version") != 3:
        ok = False
    status(bool(manifest.get("key")), "manifest contains stable key")
    if not manifest.get("key"):
        ok = False

    blocked = [
        path.relative_to(repo_root)
        for path in repo_root.rglob("*")
        if path.name.startswith("_") and ".git" not in path.parts
    ]
    if blocked:
        status(False, f"Chrome-blocking underscore paths found: {', '.join(map(str, blocked[:8]))}")
        ok = False
    else:
        status(True, "no Chrome-blocking underscore paths found")
    return ok


def check_native_manifest(manifest_dir: Path, extension_id: str) -> tuple[bool, Path | None]:
    manifest_path = manifest_dir / f"{HOST_NAME}.json"
    manifest = read_json(manifest_path)
    if not manifest:
        status(False, f"native messaging manifest not installed: {manifest_path}")
        return False, None

    ok = True
    status(True, f"native messaging manifest found: {manifest_path}")
    expected_origin = f"chrome-extension://{extension_id}/"
    allowed = manifest.get("allowed_origins")
    if isinstance(allowed, list) and expected_origin in allowed:
        status(True, f"allowed_origins includes {expected_origin}")
    else:
        status(False, f"allowed_origins does not include {expected_origin}")
        ok = False

    host_path_value = manifest.get("path")
    host_path = Path(host_path_value).expanduser() if isinstance(host_path_value, str) else None
    if host_path and host_path.is_file():
        status(True, f"native host wrapper exists: {host_path}")
    else:
        status(False, f"native host wrapper missing: {host_path_value}")
        ok = False
        host_path = None

    if host_path:
        executable = os.access(host_path, os.X_OK)
        status(executable, "native host wrapper is executable")
        ok = ok and executable
    return ok, host_path


def smoke_wrapper(wrapper: Path) -> bool:
    request = json.dumps({"type": "doctorPing"}).encode("utf-8")
    framed = struct.pack("<I", len(request)) + request
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    result = subprocess.run(
        [str(wrapper)],
        input=framed,
        capture_output=True,
        check=False,
        env=env,
    )
    if result.returncode != 0:
        status(False, f"native host wrapper exited {result.returncode}")
        if result.stderr:
            print(result.stderr.decode("utf-8", "replace").strip())
        return False

    out = result.stdout
    if len(out) < 4:
        status(False, "native host wrapper did not return a framed response")
        return False

    length = struct.unpack("<I", out[:4])[0]
    body = out[4 : 4 + length]
    if len(body) != length:
        status(False, f"native host wrapper returned a truncated response: declared={length} got={len(body)}")
        return False

    try:
        response = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        status(False, f"native host wrapper returned invalid JSON: {exc}")
        return False

    ok = response.get("ok") is False and response.get("error") == "Unsupported request type"
    status(ok, "native host wrapper speaks Chrome native messaging protocol")
    return ok


def extension_records(profile_root: Path, extension_id: str) -> list[dict]:
    records: list[dict] = []
    if not profile_root.exists():
        return records

    for preferences in sorted(profile_root.glob("*/Preferences")):
        data = read_json(preferences)
        if not data:
            continue
        extensions = data.get("extensions", {})
        if not isinstance(extensions, dict):
            continue
        settings = extensions.get("settings", {})
        if not isinstance(settings, dict):
            settings = {}
        pinned = extensions.get("pinned_extensions", [])
        if not isinstance(pinned, list):
            pinned = []

        value = settings.get(extension_id)
        if isinstance(value, dict):
            manifest = value.get("manifest", {})
            if not isinstance(manifest, dict):
                manifest = {}
            records.append(
                {
                    "profile": preferences.parent.name,
                    "present": True,
                    "pinned": extension_id in pinned,
                    "state": value.get("state"),
                    "location": value.get("location"),
                    "path": value.get("path"),
                    "name": manifest.get("name"),
                    "version": manifest.get("version"),
                }
            )
        elif extension_id in pinned:
            records.append(
                {
                    "profile": preferences.parent.name,
                    "present": False,
                    "pinned": True,
                    "state": None,
                    "location": None,
                    "path": None,
                    "name": None,
                    "version": None,
                }
            )
    return records


def check_chrome_profile(profile_root: Path, repo_root: Path, extension_id: str) -> bool:
    records = extension_records(profile_root, extension_id)
    loaded = [record for record in records if record["present"]]
    if loaded:
        for record in loaded:
            print(
                "INFO: loaded extension profile={profile} state={state} location={location} "
                "path={path} name={name} version={version}".format(**record)
            )
        matching_path = any(
            record["path"] and Path(str(record["path"])).expanduser().resolve() == repo_root.resolve()
            for record in loaded
        )
        status(matching_path, "loaded extension path matches this checkout")
        return matching_path

    stale = [record["profile"] for record in records if record["pinned"]]
    if stale:
        status(False, f"extension ID is only pinned as stale toolbar state in profiles: {', '.join(stale)}")
    else:
        status(False, f"extension ID {extension_id} is not loaded in any checked Chrome profile")

    print("")
    print("Fix:")
    print("1. Open chrome://extensions in the Chrome profile you actually use.")
    print("2. Enable Developer mode.")
    print(f"3. Click Load unpacked and select: {repo_root}")
    print(f"4. Confirm the extension ID is: {extension_id}")
    print("5. Quit and reopen Chrome, then rerun this doctor.")
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Diagnose Local Chatbot Session Archiver installation.")
    parser.add_argument("--browser", default="chrome", help="chrome, chromium, brave, or edge")
    parser.add_argument("--extension-id", default=DEFAULT_EXTENSION_ID, help="Expected Chrome extension ID")
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument("--manifest-dir", help="Override native messaging manifest directory")
    parser.add_argument("--profile-root", help="Override Chrome profile root")
    parser.add_argument("--skip-wrapper-smoke", action="store_true", help="Skip launching the native host wrapper")
    args = parser.parse_args()

    repo_root = Path(args.repo_root).expanduser().resolve()
    manifest_dir = Path(args.manifest_dir).expanduser() if args.manifest_dir else chrome_manifest_dir(args.browser)
    profile_root = Path(args.profile_root).expanduser() if args.profile_root else default_profile_root(args.browser)

    print(f"Extension ID: {args.extension_id}")
    source_ok = check_extension_source(repo_root)
    manifest_ok, wrapper = check_native_manifest(manifest_dir, args.extension_id)
    wrapper_ok = True if args.skip_wrapper_smoke or not wrapper else smoke_wrapper(wrapper)
    profile_ok = check_chrome_profile(profile_root, repo_root, args.extension_id)

    all_ok = source_ok and manifest_ok and wrapper_ok and profile_ok
    print("")
    status(all_ok, "Local install is usable")
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
