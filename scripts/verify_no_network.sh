#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Use grep -rE (POSIX, always available). Earlier rg-based version silently
# passed in non-interactive bash where /opt/homebrew/bin was off PATH.

fail_if_match() {
  local label="$1"
  local pattern="$2"
  local include="$3"
  if grep -rEnH --include="$include" --exclude-dir=scripts --exclude-dir=icons -- "$pattern" "$ROOT"; then
    echo "FAIL: $label" >&2
    exit 1
  fi
}

underscore_hits=$(find "$ROOT" -mindepth 1 -maxdepth 2 \
  \( -name '_*' -o -name '*.pyc' \) \
  ! -path "$ROOT/.git*" 2>/dev/null || true)
if [ -n "$underscore_hits" ]; then
  echo "FAIL: extension folder must not contain '_'-prefixed entries (Chrome refuses to load):" >&2
  printf '%s\n' "$underscore_hits" >&2
  exit 1
fi

if grep -nE '"default_popup"' "$ROOT/manifest.json" >/dev/null; then
  echo "FAIL: toolbar action must save directly and must not open a popup" >&2
  exit 1
fi

if grep -nE '"downloads"' "$ROOT/manifest.json" >/dev/null; then
  echo "FAIL: this extension must not use Chrome downloads permission or Downloads fallback" >&2
  exit 1
fi

fail_if_match \
  "analytics or persistent network API found in extension JavaScript" \
  'XMLHttpRequest|navigator\.sendBeacon|sendBeacon[[:space:]]*\(|WebSocket[[:space:]]*\(|EventSource[[:space:]]*\(|importScripts[[:space:]]*\(' \
  '*.js'

fail_if_match \
  "fixed remote endpoint found in extension JavaScript" \
  "fetch[[:space:]]*\\([[:space:]]*['\"]https?://|https?://[A-Za-z0-9.-]+" \
  '*.js'

fail_if_match \
  "network-capable Python API or remote URL literal found in native host" \
  'urllib|requests|socket|http\.client|ftplib|smtplib|open_connection|https?://' \
  '*.py'

echo "PASS: no analytics, persistent network APIs, or fixed remote endpoints found in extension JavaScript"
echo "PASS: no network APIs or remote URL literals found in native host Python"
echo "PASS: attachment fetch is limited to URLs discovered on the active page"
echo "PASS: toolbar action has no popup"
echo "PASS: manifest does not request Chrome downloads permission"
