#!/usr/bin/env python3
"""Release safety checks for public source trees.

The check is intentionally conservative: public project files should not
contain local home-directory paths, common token formats, private-key blocks,
or tracked secret-looking files.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
TEXT_SUFFIXES = {
    ".css",
    ".html",
    ".js",
    ".json",
    ".md",
    ".py",
    ".sh",
    ".txt",
    ".yml",
    ".yaml",
}
SECRET_FILE_SUFFIXES = {".env", ".key", ".pem", ".p12", ".pfx"}
SECRET_FILE_NAMES = {".env", ".env.local", ".npmrc", ".pypirc"}
PATTERNS = [
    ("macOS home path", re.compile(r"/Users/[A-Za-z0-9._-]+")),
    ("GitHub token", re.compile(r"github_pat_[A-Za-z0-9_]+|gh[opsu]_[A-Za-z0-9_]+")),
    ("OpenAI-style API key", re.compile(r"sk-[A-Za-z0-9]{20,}")),
    ("AWS access key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("private key block", re.compile(r"-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----")),
]


def tracked_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return [ROOT / item.decode("utf-8") for item in result.stdout.split(b"\0") if item]


def is_text_candidate(path: Path) -> bool:
    return path.suffix.lower() in TEXT_SUFFIXES or path.name in {".gitignore", "LICENSE"}


def main() -> int:
    findings: list[str] = []
    for path in tracked_files():
        rel = path.relative_to(ROOT)
        lowered_name = path.name.lower()
        lowered_suffix = path.suffix.lower()

        if lowered_name in SECRET_FILE_NAMES or lowered_suffix in SECRET_FILE_SUFFIXES:
            findings.append(f"{rel}: tracked secret-looking file")
            continue

        if not is_text_candidate(path):
            continue

        text = path.read_text(encoding="utf-8", errors="replace")
        for line_no, line in enumerate(text.splitlines(), start=1):
            for label, pattern in PATTERNS:
                if pattern.search(line):
                    findings.append(f"{rel}:{line_no}: {label}")

    if findings:
        print("FAIL: release safety scan found public-source risks", file=sys.stderr)
        for finding in findings:
            print(finding, file=sys.stderr)
        return 1

    print("PASS: release safety scan found no local paths, common secrets, or tracked secret-looking files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
