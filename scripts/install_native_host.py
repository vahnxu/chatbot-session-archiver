#!/usr/bin/env python3
"""Install the Chrome native messaging host manifest for this checkout.

The manifest itself cannot set environment variables or choose a Python
interpreter. This installer writes a tiny wrapper script and points Chrome at
that wrapper.
"""

from __future__ import annotations

import argparse
import json
import platform
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path

HOST_NAME = "com.chatbotarchiver.host"
DEFAULT_EXTENSION_ID = "jomoepphgememdnpipkhojpjmkjeehdl"


def chrome_manifest_dir(browser: str) -> Path:
    system = platform.system()
    home = Path.home()

    if system == "Darwin":
        roots = {
            "chrome": home / "Library/Application Support/Google/Chrome/NativeMessagingHosts",
            "chromium": home / "Library/Application Support/Chromium/NativeMessagingHosts",
            "brave": home / "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
            "edge": home / "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
        }
    elif system == "Linux":
        roots = {
            "chrome": home / ".config/google-chrome/NativeMessagingHosts",
            "chromium": home / ".config/chromium/NativeMessagingHosts",
            "brave": home / ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
            "edge": home / ".config/microsoft-edge/NativeMessagingHosts",
        }
    else:
        raise SystemExit(
            f"Unsupported OS for automatic install: {system}. "
            "See docs/NativeMessaging.md for manual setup."
        )

    try:
        return roots[browser]
    except KeyError as exc:
        choices = ", ".join(sorted(roots))
        raise SystemExit(f"Unsupported browser '{browser}'. Choose one of: {choices}") from exc


def wrapper_dir() -> Path:
    if platform.system() == "Darwin":
        return Path.home() / "Library/ChatbotSessionArchiver"
    return Path.home() / ".local/share/chatbot-session-archiver"


def shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def unique_backup_path(path: Path, stamp: str) -> Path:
    first = path.with_name(f"{path.name}.{stamp}.bak")
    if not first.exists():
        return first

    for index in range(1, 10000):
        candidate = path.with_name(f"{path.name}.{stamp}.{index}.bak")
        if not candidate.exists():
            return candidate

    raise SystemExit(f"Could not find a non-conflicting backup name for {path}")


def write_text_safely(path: Path, text: str, mode: int | None = None) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except PermissionError as exc:
        raise SystemExit(
            f"Cannot create {path.parent}: permission denied. "
            "Run this installer from a normal user terminal, or choose a browser/profile "
            "whose native messaging directory is writable by your user."
        ) from exc

    if path.exists():
        existing = path.read_text(encoding="utf-8")
        if existing == text:
            if mode is not None:
                path.chmod(mode)
            print(f"unchanged: {path}")
            return

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = unique_backup_path(path, stamp)
        path.rename(backup)
        print(f"backed up existing file: {backup}")

    path.write_text(text, encoding="utf-8")
    if mode is not None:
        path.chmod(mode)
    print(f"wrote: {path}")


def build_wrapper(host_path: Path, target_dir: str | None, python_executable: str) -> str:
    lines = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "export PYTHONDONTWRITEBYTECODE=1",
    ]
    if target_dir:
        lines.append(f"export CHATBOT_ARCHIVER_TARGET_DIR={shell_quote(target_dir)}")
    lines.append(f"exec {shell_quote(python_executable)} {shell_quote(str(host_path))}")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Install Local Chatbot Session Archiver native messaging host manifest."
    )
    parser.add_argument(
        "--browser",
        default="chrome",
        help="Browser manifest location to use: chrome, chromium, brave, or edge.",
    )
    parser.add_argument(
        "--extension-id",
        default=DEFAULT_EXTENSION_ID,
        help="Chrome extension ID from chrome://extensions.",
    )
    parser.add_argument(
        "--target-dir",
        help="Optional archive directory. If omitted, native_host.py uses ~/Documents/chatbot-archives.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the files that would be written without modifying them.",
    )
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    host_path = root / "native_host.py"
    if not host_path.is_file():
        raise SystemExit(f"native_host.py not found: {host_path}")

    host_path.chmod(host_path.stat().st_mode | stat.S_IXUSR)
    manifest_dir = chrome_manifest_dir(args.browser)
    manifest_path = manifest_dir / f"{HOST_NAME}.json"

    python_executable = str(Path(sys.executable).resolve())
    wrapper_path = wrapper_dir() / f"{HOST_NAME}.sh"
    wrapper_text = build_wrapper(host_path, args.target_dir, python_executable)
    manifest_program = wrapper_path
    manifest = {
        "name": HOST_NAME,
        "description": "Local Chatbot Session Archiver native writer",
        "path": str(manifest_program),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{args.extension_id}/"],
    }
    manifest_text = json.dumps(manifest, indent=2) + "\n"

    if args.dry_run:
        print(f"would write wrapper: {wrapper_path}")
        print(wrapper_text)
        print(f"would write manifest: {manifest_path}")
        print(manifest_text)
        return 0

    write_text_safely(wrapper_path, wrapper_text, 0o755)
    write_text_safely(manifest_path, manifest_text, 0o644)
    print("")
    print("Next steps:")
    print("1. Load this folder in chrome://extensions if it is not already loaded.")
    print("2. Quit and reopen Chrome.")
    print(f"3. Open chrome-extension://{args.extension_id}/popup.html?reload=1")
    print(f"4. Open chrome-extension://{args.extension_id}/popup.html?selftest=1")
    print("5. If the self-test URL does not open, run: python3 scripts/doctor.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
