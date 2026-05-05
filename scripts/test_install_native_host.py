#!/usr/bin/env python3
"""Installer behaviour tests.

These tests keep the public install path honest without touching the user's
real Chrome NativeMessagingHosts directory.
"""

from __future__ import annotations

import json
import importlib.util
import subprocess
import sys
import tempfile
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
INSTALLER = ROOT / "scripts" / "install_native_host.py"
HOST_NAME = "com.chatbotarchiver.host"
sys.dont_write_bytecode = True


def shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def run_dry_run(*args: str) -> str:
    result = subprocess.run(
        [sys.executable, str(INSTALLER), "--dry-run", *args],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
        env={**dict(os.environ), "PYTHONDONTWRITEBYTECODE": "1"},
    )
    return result.stdout


def extract_manifest(output: str) -> dict:
    start = output.index("{")
    return json.loads(output[start:])


def load_installer_module():
    spec = importlib.util.spec_from_file_location("install_native_host", INSTALLER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_default_install_uses_wrapper_with_current_python() -> None:
    output = run_dry_run()
    manifest = extract_manifest(output)
    wrapper_name = f"{HOST_NAME}.sh"

    assert "would write wrapper:" in output
    assert "would not write wrapper" not in output
    assert manifest["path"].endswith(f"/{wrapper_name}")
    assert not manifest["path"].endswith("/native_host.py")
    expected_python = str(Path(sys.executable).resolve())
    assert f"exec {shell_quote(expected_python)} {shell_quote(str(ROOT / 'native_host.py'))}" in output


def test_custom_target_dir_is_exported_by_wrapper() -> None:
    target = str(ROOT / "tmp archives")
    output = run_dry_run("--target-dir", target)

    assert f"export CHATBOT_ARCHIVER_TARGET_DIR={shell_quote(target)}" in output


def test_backup_path_uses_increment_when_timestamp_exists() -> None:
    installer = load_installer_module()
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "com.chatbotarchiver.host.json"
        first = target.with_name("com.chatbotarchiver.host.json.20260505T000000Z.bak")
        first.write_text("old backup", encoding="utf-8")

        backup = installer.unique_backup_path(target, "20260505T000000Z")

        assert backup.name == "com.chatbotarchiver.host.json.20260505T000000Z.1.bak"


if __name__ == "__main__":
    test_default_install_uses_wrapper_with_current_python()
    test_custom_target_dir_is_exported_by_wrapper()
    test_backup_path_uses_increment_when_timestamp_exists()
    print("PASS: installer writes a wrapper with explicit Python and target-dir support")
