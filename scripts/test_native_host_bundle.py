#!/usr/bin/env python3
"""End-to-end bundle protocol test for native_host.py.

Drives the native messaging host the way Chrome's
`chrome.runtime.sendNativeMessage` does — one process per request, one
length-prefixed JSON request in, one length-prefixed JSON response out.

Exercises the full bundle flow:
  startBundle -> writeAttachmentChunk(* N) -> completeAttachment -> finishBundle

Also exercises the legacy saveMarkdown protocol so we keep backward compat.

Usage:
  CHATBOT_ARCHIVER_TARGET_DIR=/tmp/chatbot_archiver_test python3 scripts/test_native_host_bundle.py
"""

from __future__ import annotations

import base64
import json
import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOST = ROOT / "native_host.py"


def call_host(target_dir: Path, request: dict) -> dict:
    payload = json.dumps(request, ensure_ascii=False).encode("utf-8")
    framed = struct.pack("<I", len(payload)) + payload
    env = dict(os.environ)
    env["CHATBOT_ARCHIVER_TARGET_DIR"] = str(target_dir)
    # Chrome refuses to load extensions whose folder contains anything starting
    # with "_" (e.g. __pycache__). Belt-and-suspenders: tell Python not to
    # write .pyc next to native_host.py even if a future change adds imports.
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    proc = subprocess.run(
        [sys.executable, str(HOST)],
        input=framed,
        capture_output=True,
        env=env,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"native_host exited {proc.returncode}: stderr={proc.stderr.decode('utf-8', 'replace')}"
        )
    out = proc.stdout
    if len(out) < 4:
        raise RuntimeError(f"native_host produced no framed response: {out!r}")
    length = struct.unpack("<I", out[:4])[0]
    body = out[4 : 4 + length]
    if len(body) != length:
        raise RuntimeError(f"truncated native_host response: declared={length} got={len(body)}")
    return json.loads(body.decode("utf-8"))


def assert_ok(label: str, response: dict) -> dict:
    if not response.get("ok"):
        raise AssertionError(f"{label} failed: {response}")
    return response


def run_bundle_protocol(target_dir: Path) -> None:
    relative_dir = "SelfTest/2099-12-31/20991231T000000Z_selftest_native-host"
    started = assert_ok("startBundle", call_host(target_dir, {"type": "startBundle", "relativeDir": relative_dir}))
    bundle_dir = started["relativeDir"]

    payload = b"hello from native host bundle test\n" * 64  # ~2 KiB
    chunks = [payload[i : i + 512] for i in range(0, len(payload), 512)]
    temp_path = "attachments/001_test.txt.part"
    final_path = "attachments/001_test.txt"

    for index, chunk in enumerate(chunks):
        assert_ok(
            f"writeAttachmentChunk[{index}]",
            call_host(
                target_dir,
                {
                    "type": "writeAttachmentChunk",
                    "relativeDir": bundle_dir,
                    "attachmentPath": temp_path,
                    "chunkIndex": index,
                    "dataBase64": base64.b64encode(chunk).decode("ascii"),
                },
            ),
        )

    assert_ok(
        "completeAttachment",
        call_host(
            target_dir,
            {
                "type": "completeAttachment",
                "relativeDir": bundle_dir,
                "tempPath": temp_path,
                "finalPath": final_path,
            },
        ),
    )

    session_payload = {
        "platform": {"id": "selftest", "name": "Self test"},
        "messages": [{"role": "system", "content": "bundle protocol test"}],
    }
    manifest_payload = {
        "savedCount": 1,
        "failedCount": 0,
        "skippedCount": 0,
        "attachments": [{"path": final_path, "bytes": len(payload), "status": "saved"}],
    }
    finished = assert_ok(
        "finishBundle",
        call_host(
            target_dir,
            {
                "type": "finishBundle",
                "relativeDir": bundle_dir,
                "markdown": "# bundle protocol test\nbody\n",
                "sessionJson": json.dumps(session_payload, ensure_ascii=False),
                "attachmentManifest": json.dumps(manifest_payload, ensure_ascii=False),
            },
        ),
    )

    bundle_root = target_dir / finished["relativeDir"]
    expected = [
        bundle_root / "session.md",
        bundle_root / "session.json",
        bundle_root / "attachments" / "manifest.json",
        bundle_root / final_path,
    ]
    for path in expected:
        if not path.is_file():
            raise AssertionError(f"missing expected file: {path}")

    actual_bytes = (bundle_root / final_path).read_bytes()
    if actual_bytes != payload:
        raise AssertionError(
            f"attachment bytes mismatch: expected={len(payload)} got={len(actual_bytes)}"
        )


def run_legacy_save_markdown(target_dir: Path) -> None:
    response = assert_ok(
        "saveMarkdown",
        call_host(
            target_dir,
            {
                "type": "saveMarkdown",
                "relativePath": "SelfTest/2099-12-31/legacy_save_markdown.md",
                "markdown": "# legacy\nstill supported\n",
                "metadata": {"capturedAt": "2099-12-31T00:00:00Z"},
            },
        ),
    )
    path = Path(response["path"])
    if not path.is_file():
        raise AssertionError(f"legacy saveMarkdown did not write file: {path}")
    if "legacy" not in path.read_text(encoding="utf-8"):
        raise AssertionError(f"legacy saveMarkdown wrote unexpected content: {path}")


def run_path_traversal_guard(target_dir: Path) -> None:
    dotted = assert_ok(
        "startBundle dotted-title",
        call_host(
            target_dir,
            {
                "type": "startBundle",
                "relativeDir": "Claude/2099-12-31/20991231T000000Z_claude_title-with...dots",
            },
        ),
    )
    dotted_path = target_dir / dotted["relativeDir"]
    if not dotted_path.is_dir():
        raise AssertionError(f"dotted relativeDir was not created: {dotted_path}")

    response = call_host(
        target_dir,
        {"type": "startBundle", "relativeDir": "../escape"},
    )
    if response.get("ok"):
        raise AssertionError(f"startBundle should reject ../escape but got: {response}")
    if "invalid folder name" not in (response.get("error") or ""):
        raise AssertionError(f"unexpected error message: {response}")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="chatbot_archiver_e2e_") as tmp:
        target = Path(tmp)
        run_bundle_protocol(target)
        run_legacy_save_markdown(target)
        run_path_traversal_guard(target)
    print("PASS: bundle protocol startBundle/writeAttachmentChunk/completeAttachment/finishBundle")
    print("PASS: legacy saveMarkdown still works")
    print("PASS: path-traversal guard allows dotted titles and rejects ../escape")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
