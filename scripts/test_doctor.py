#!/usr/bin/env python3
"""Tests for scripts/doctor.py using temp Chrome profile and manifest roots."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent.parent
DOCTOR = ROOT / "scripts" / "doctor.py"
HOST_NAME = "com.chatbotarchiver.host"
EXTENSION_ID = "jomoepphgememdnpipkhojpjmkjeehdl"


def write_native_manifest(manifest_dir: Path, wrapper: Path) -> None:
    manifest_dir.mkdir(parents=True)
    (manifest_dir / f"{HOST_NAME}.json").write_text(
        json.dumps(
            {
                "name": HOST_NAME,
                "description": "test",
                "path": str(wrapper),
                "type": "stdio",
                "allowed_origins": [f"chrome-extension://{EXTENSION_ID}/"],
            }
        ),
        encoding="utf-8",
    )


def write_profile(profile_root: Path, *, loaded: bool) -> None:
    default = profile_root / "Default"
    default.mkdir(parents=True)
    extensions = {"pinned_extensions": [EXTENSION_ID], "settings": {}}
    if loaded:
        extensions["settings"][EXTENSION_ID] = {
            "state": 1,
            "location": 4,
            "path": str(ROOT),
            "manifest": {"name": "Local Chatbot Session Archiver", "version": "0.1.0"},
        }
    (default / "Preferences").write_text(json.dumps({"extensions": extensions}), encoding="utf-8")


def run_doctor(manifest_dir: Path, profile_root: Path, wrapper: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(DOCTOR),
            "--manifest-dir",
            str(manifest_dir),
            "--profile-root",
            str(profile_root),
            "--skip-wrapper-smoke",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        env={**dict(os.environ), "PYTHONDONTWRITEBYTECODE": "1"},
        check=False,
    )


def test_doctor_passes_when_extension_loaded() -> None:
    with tempfile.TemporaryDirectory(prefix="chatbot_archiver_doctor_") as tmp:
        root = Path(tmp)
        manifest_dir = root / "NativeMessagingHosts"
        profile_root = root / "Chrome"
        wrapper = root / "host.sh"
        wrapper.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
        wrapper.chmod(0o755)
        write_native_manifest(manifest_dir, wrapper)
        write_profile(profile_root, loaded=True)

        result = run_doctor(manifest_dir, profile_root, wrapper)

        assert result.returncode == 0, result.stdout + result.stderr
        assert "OK: Native host install is usable" in result.stdout


def test_doctor_fails_when_extension_only_pinned() -> None:
    with tempfile.TemporaryDirectory(prefix="chatbot_archiver_doctor_") as tmp:
        root = Path(tmp)
        manifest_dir = root / "NativeMessagingHosts"
        profile_root = root / "Chrome"
        wrapper = root / "host.sh"
        wrapper.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
        wrapper.chmod(0o755)
        write_native_manifest(manifest_dir, wrapper)
        write_profile(profile_root, loaded=False)

        result = run_doctor(manifest_dir, profile_root, wrapper)

        assert result.returncode == 0, result.stdout + result.stderr
        assert "only pinned as stale toolbar state" in result.stdout
        assert "Load unpacked" in result.stdout
        assert "Native host install is usable" in result.stdout


if __name__ == "__main__":
    test_doctor_passes_when_extension_loaded()
    test_doctor_fails_when_extension_only_pinned()
    print("PASS: doctor detects loaded extension and warns on stale pinned-only state")
