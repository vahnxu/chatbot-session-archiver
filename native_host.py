#!/usr/bin/python3
"""Native writer for Local Chatbot Session Archiver.

Chrome extensions cannot silently write to arbitrary local paths. This native
messaging host receives one Markdown payload and writes it to the configured
local archive directory without network access.
"""

from __future__ import annotations

import json
import os
import base64
import binascii
from pathlib import Path
import re
import struct
import sys
import time
import traceback

_DEBUG_LOG = os.environ.get("CHATBOT_ARCHIVER_DEBUG_LOG")


def _trace(line: str) -> None:
    if not _DEBUG_LOG:
        return
    try:
        with open(_DEBUG_LOG, "a") as f:
            f.write(f"{time.strftime('%H:%M:%S')} pid={os.getpid()} {line}\n")
    except Exception:
        pass


_trace(f"start argv={sys.argv} cwd={os.getcwd()} python={sys.executable}")


HOST_NAME = "com.chatbotarchiver.host"
DEFAULT_TARGET_DIR = str(Path.home() / "Documents" / "chatbot-archives")
TARGET_DIR = Path(os.environ.get("CHATBOT_ARCHIVER_TARGET_DIR", DEFAULT_TARGET_DIR))
MAX_INPUT_BYTES = 80 * 1024 * 1024
FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.md$")
SAFE_FILE_RE = re.compile(r"^[A-Za-z0-9._ -]+$")
FOLDER_RE = re.compile(r"^[A-Za-z0-9._ -]+$")


def main() -> int:
    try:
        request = read_native_message()
        _trace(f"got request type={request.get('type')!r}")
        response = handle_request(request)
        _trace(f"handled ok={response.get('ok')}")
    except Exception as exc:  # Keep host failures visible to the extension.
        _trace(f"EXCEPTION {type(exc).__name__}: {exc}\n{traceback.format_exc()}")
        response = {"ok": False, "error": str(exc)}

    try:
        write_native_message(response)
        _trace("wrote response")
    except Exception as exc:
        _trace(f"WRITE_EXCEPTION {type(exc).__name__}: {exc}")
    return 0


def read_native_message() -> dict:
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) != 4:
        raise ValueError("No native message received")

    length = struct.unpack("<I", raw_length)[0]
    if length <= 0:
        raise ValueError("Empty native message")
    if length > MAX_INPUT_BYTES:
        raise ValueError(f"Native message too large: {length} bytes")

    payload = sys.stdin.buffer.read(length)
    if len(payload) != length:
        raise ValueError("Incomplete native message")

    data = json.loads(payload.decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Native message must be a JSON object")
    return data


def write_native_message(response: dict) -> None:
    payload = json.dumps(response, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def handle_request(request: dict) -> dict:
    request_type = request.get("type")
    if request_type == "saveMarkdown":
        return handle_save_markdown(request)
    if request_type == "startBundle":
        return handle_start_bundle(request)
    if request_type == "writeAttachmentChunk":
        return handle_write_attachment_chunk(request)
    if request_type == "completeAttachment":
        return handle_complete_attachment(request)
    if request_type == "finishBundle":
        return handle_finish_bundle(request)
    raise ValueError("Unsupported request type")


def handle_save_markdown(request: dict) -> dict:
    relative_path = validate_relative_path(request.get("relativePath") or request.get("filename"))
    markdown = request.get("markdown")
    if not isinstance(markdown, str) or not markdown.strip():
        raise ValueError("markdown must be a non-empty string")

    ensure_target_dir()

    path = write_without_overwrite(relative_path, markdown)
    return {
        "ok": True,
        "host": HOST_NAME,
        "path": str(path),
        "filename": path.name,
        "relativePath": str(path.relative_to(TARGET_DIR.resolve())),
        "targetDir": str(TARGET_DIR),
    }


def handle_start_bundle(request: dict) -> dict:
    relative_dir = validate_relative_dir(request.get("relativeDir"))
    ensure_target_dir()
    path = create_unique_bundle_dir(relative_dir)
    return {
        "ok": True,
        "host": HOST_NAME,
        "path": str(path),
        "relativeDir": str(path.relative_to(TARGET_DIR.resolve())),
        "targetDir": str(TARGET_DIR),
    }


def handle_write_attachment_chunk(request: dict) -> dict:
    bundle_dir = existing_bundle_dir(request.get("relativeDir"))
    attachment_path = validate_attachment_path(request.get("attachmentPath"), allow_part=True)
    chunk_index = request.get("chunkIndex")
    if not isinstance(chunk_index, int) or chunk_index < 0:
        raise ValueError("chunkIndex must be a non-negative integer")
    data_base64 = request.get("dataBase64")
    if not isinstance(data_base64, str):
        raise ValueError("dataBase64 must be a string")
    try:
        chunk = base64.b64decode(data_base64.encode("ascii"), validate=True)
    except (binascii.Error, UnicodeEncodeError) as exc:
        raise ValueError("dataBase64 is not valid base64") from exc

    path = safe_child_path(bundle_dir, attachment_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = "xb" if chunk_index == 0 else "ab"
    if chunk_index > 0 and not path.exists():
        raise ValueError("attachment chunk sequence missing first chunk")
    with path.open(mode) as handle:
        handle.write(chunk)

    return {
        "ok": True,
        "host": HOST_NAME,
        "path": str(path),
        "relativePath": str(path.relative_to(TARGET_DIR.resolve())),
        "bytes": len(chunk),
    }


def handle_complete_attachment(request: dict) -> dict:
    bundle_dir = existing_bundle_dir(request.get("relativeDir"))
    temp_path = safe_child_path(bundle_dir, validate_attachment_path(request.get("tempPath"), allow_part=True))
    final_path = safe_child_path(bundle_dir, validate_attachment_path(request.get("finalPath"), allow_part=False))
    if not temp_path.exists():
        raise ValueError(f"attachment temp file does not exist: {temp_path.name}")
    if final_path.exists():
        raise ValueError(f"attachment target already exists: {final_path.name}")
    temp_path.rename(final_path)
    return {
        "ok": True,
        "host": HOST_NAME,
        "path": str(final_path),
        "relativePath": str(final_path.relative_to(TARGET_DIR.resolve())),
    }


def handle_finish_bundle(request: dict) -> dict:
    bundle_dir = existing_bundle_dir(request.get("relativeDir"))
    markdown = request.get("markdown")
    if not isinstance(markdown, str) or not markdown.strip():
        raise ValueError("markdown must be a non-empty string")
    session_json = request.get("sessionJson")
    if not isinstance(session_json, str) or not session_json.strip():
        raise ValueError("sessionJson must be a non-empty string")
    attachment_manifest = request.get("attachmentManifest")
    if not isinstance(attachment_manifest, str) or not attachment_manifest.strip():
        raise ValueError("attachmentManifest must be a non-empty string")

    session_path = write_text_new(bundle_dir / "session.md", markdown)
    json_path = write_text_new(bundle_dir / "session.json", session_json)
    attachments_dir = bundle_dir / "attachments"
    attachments_dir.mkdir(exist_ok=True)
    manifest_path = write_text_new(attachments_dir / "manifest.json", attachment_manifest)
    return {
        "ok": True,
        "host": HOST_NAME,
        "path": str(session_path),
        "filename": session_path.name,
        "relativeDir": str(bundle_dir.relative_to(TARGET_DIR.resolve())),
        "relativePath": str(session_path.relative_to(TARGET_DIR.resolve())),
        "sessionJson": str(json_path.relative_to(TARGET_DIR.resolve())),
        "attachmentManifest": str(manifest_path.relative_to(TARGET_DIR.resolve())),
        "targetDir": str(TARGET_DIR),
    }


def validate_filename(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("filename must be a string")
    if "/" in value or "\\" in value or ".." in value:
        raise ValueError("filename must not contain path traversal")
    if len(value) > 180:
        raise ValueError("filename is too long")
    if not FILENAME_RE.fullmatch(value):
        raise ValueError("filename must use letters, numbers, dot, underscore, dash, and end with .md")
    return value


def validate_relative_path(value: object) -> Path:
    if not isinstance(value, str):
        raise ValueError("relativePath must be a string")
    if value.startswith("/") or "\\" in value or "\x00" in value or ".." in value:
        raise ValueError("relativePath must stay inside the archive directory")
    if len(value) > 260:
        raise ValueError("relativePath is too long")

    path = Path(value)
    if not path.parts:
        raise ValueError("relativePath is empty")

    for folder in path.parts[:-1]:
        if folder in ("", ".", "..") or not FOLDER_RE.fullmatch(folder):
            raise ValueError("relativePath contains an invalid folder name")

    filename = validate_filename(path.name)
    return Path(*path.parts[:-1], filename)


def validate_relative_dir(value: object) -> Path:
    if not isinstance(value, str):
        raise ValueError("relativeDir must be a string")
    if value.startswith("/") or "\\" in value or "\x00" in value or ".." in value:
        raise ValueError("relativeDir must stay inside the archive directory")
    if len(value) > 260:
        raise ValueError("relativeDir is too long")

    path = Path(value)
    if not path.parts:
        raise ValueError("relativeDir is empty")
    for folder in path.parts:
        if folder in ("", ".", "..") or not FOLDER_RE.fullmatch(folder):
            raise ValueError("relativeDir contains an invalid folder name")
    return Path(*path.parts)


def validate_attachment_path(value: object, *, allow_part: bool) -> Path:
    if not isinstance(value, str):
        raise ValueError("attachmentPath must be a string")
    if value.startswith("/") or "\\" in value or "\x00" in value or ".." in value:
        raise ValueError("attachmentPath must stay inside the session directory")
    if len(value) > 220:
        raise ValueError("attachmentPath is too long")

    path = Path(value)
    if len(path.parts) != 2 or path.parts[0] != "attachments":
        raise ValueError("attachmentPath must be under attachments/")
    filename = path.name
    if filename in ("", ".", "..") or "/" in filename or "\\" in filename:
        raise ValueError("attachment filename is invalid")
    if not allow_part and filename.endswith(".part"):
        raise ValueError("final attachment filename must not end with .part")
    if not SAFE_FILE_RE.fullmatch(filename):
        raise ValueError("attachment filename contains invalid characters")
    return Path("attachments", filename)


def ensure_target_dir() -> None:
    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    if not TARGET_DIR.is_dir():
        raise ValueError(f"Archive target is not a directory: {TARGET_DIR}")


def safe_child_path(parent: Path, relative_path: Path) -> Path:
    root = parent.resolve()
    path = (parent / relative_path).resolve(strict=False)
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise ValueError("path escapes session directory") from exc
    return path


def existing_bundle_dir(value: object) -> Path:
    relative_dir = validate_relative_dir(value)
    target_root = TARGET_DIR.resolve()
    path = (TARGET_DIR / relative_dir).resolve(strict=False)
    try:
        path.relative_to(target_root)
    except ValueError as exc:
        raise ValueError("relativeDir escapes archive directory") from exc
    if not path.is_dir():
        raise ValueError(f"session bundle directory does not exist: {relative_dir}")
    return path


def create_unique_bundle_dir(relative_dir: Path) -> Path:
    target_root = TARGET_DIR.resolve()
    base_path = (TARGET_DIR / relative_dir).resolve(strict=False)
    try:
        base_path.relative_to(target_root)
    except ValueError as exc:
        raise ValueError("relativeDir escapes archive directory") from exc

    base_path.parent.mkdir(parents=True, exist_ok=True)
    for index in range(1, 10000):
        candidate = base_path if index == 1 else base_path.with_name(f"{base_path.name}_{index}")
        try:
            candidate.mkdir()
            (candidate / "attachments").mkdir()
            return candidate
        except FileExistsError:
            continue

    raise ValueError("Could not find a non-conflicting session directory")


def write_text_new(path: Path, text: str) -> Path:
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    return path


def write_without_overwrite(relative_path: Path, markdown: str) -> Path:
    target_root = TARGET_DIR.resolve()
    base_path = (TARGET_DIR / relative_path).resolve(strict=False)
    try:
        base_path.relative_to(target_root)
    except ValueError as exc:
        raise ValueError("relativePath escapes archive directory") from exc

    base_path.parent.mkdir(parents=True, exist_ok=True)
    base = base_path.stem
    suffix = base_path.suffix

    for index in range(1, 10000):
        candidate = base_path if index == 1 else base_path.with_name(f"{base}_{index}{suffix}")
        try:
            with candidate.open("x", encoding="utf-8", newline="\n") as handle:
                handle.write(markdown)
            return candidate
        except FileExistsError:
            continue

    raise ValueError("Could not find a non-conflicting filename")


if __name__ == "__main__":
    raise SystemExit(main())
