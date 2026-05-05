# Local Chatbot Session Archiver

Unpacked Chrome extension for **manual, local-only export of the current AI chatbot conversation** (text + exposed attachments) to a folder on your own machine.

You click the toolbar icon → the active chatbot conversation is written as `session.md` + `session.json` + the page-exposed attachments to a local folder. No popup. No cloud. No analytics.

## Why this exists

The author's actual workflow:

- **Save a chatbot session locally**, then **import it into another chatbot to keep talking** (e.g. start in Gemini for visual reasoning, continue in Claude for writing).
- **Save a chatbot session locally**, then **hand it to Codex / Claude Code as context** so a coding agent can resume what a chat agent started.
- **Keep an archive that survives** when the chatbot UI changes, when an account is closed, or when a "shared link" stops working.

If your goal is to *keep your own chatbot conversations as files you control*, this is for you. If your goal is to scrape someone else's data or to bulk-extract conversations automatically, **this is not for you** — see [Scope and red lines](#scope-and-red-lines).

## What gets saved

For each captured session you get a folder like:

```text
~/Documents/chatbot-archives/Claude/2026-05-03/20260503T124939Z_claude_<title-slug>/
├── session.md                  # human-readable transcript with YAML frontmatter
├── session.json                # machine-readable: messages, roles, attachments, metadata
└── attachments/
    ├── manifest.json           # what was saved, what was skipped, why
    ├── 001_<filename>.jpeg
    ├── 002_<filename>.pdf
    └── …
```

`session.md` is intended to be opened by a human or pasted into another chat. `session.json` is intended to be ingested by another agent (Codex, Claude Code, custom pipelines) without HTML scraping.

### Supported chatbots

ChatGPT, Claude, Gemini, DeepSeek, Kimi, Doubao, Perplexity, Grok, Qianwen, Poe, Copilot, Mistral. A generic fallback runs on any other page.

A platform's DOM can change at any time. When that happens, capture quality drops on that platform until the selectors are updated. See [docs/Spec.md](docs/Spec.md) for how the platform list and selectors are organized.

## How it works

1. **Extension** (Chrome MV3 service worker + content script) reads the visible DOM of the active tab and infers messages + attachment references.
2. **Native messaging host** (`native_host.py`, runs on your local machine, not a server) receives a stream of length-prefixed JSON messages over stdio and writes the session bundle to a local folder. It cannot make network calls.
3. **Attachment fetch** is performed inside the page context using the browser's existing logged-in session — the same way you would right-click → Save Image. URLs that the page does not expose are reported as `skipped` with a reason.

There is no remote server, no telemetry, and no analytics. See `scripts/verify_no_network.sh`.

## Install

### 0. Prerequisites

- Google Chrome (or any Chromium with native-messaging support)
- Python 3.9+ on `PATH` (only the standard library is used)
- macOS or Linux. Windows works in principle but the install steps below are written for macOS/Linux paths.

### 1. Get the source

```bash
git clone https://github.com/vahnxu/chatbot-session-archiver.git ~/code/chatbot-session-archiver
cd ~/code/chatbot-session-archiver
```

### 2. Load the unpacked extension in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked**, select the cloned folder.
4. Note the extension ID Chrome assigns. With the bundled stable `key`, the ID should be `jomoepphgememdnpipkhojpjmkjeehdl`. **If the ID is different**, you will need to update `allowed_origins` in the next step. (See [docs/NativeMessaging.md](docs/NativeMessaging.md) for why.)

### 3. Install the native messaging host manifest

Run the installer from the cloned folder:

```bash
python3 scripts/install_native_host.py
```

The installer writes:

- A Chrome native messaging manifest named `com.chatbotarchiver.host.json` under Chrome's per-user manifest directory
- A wrapper script under `~/Library/ChatbotSessionArchiver/` on macOS, or `~/.local/share/chatbot-session-archiver/` on Linux. The wrapper launches `native_host.py` with the same Python interpreter that ran the installer, so Chrome does not have to resolve the script shebang itself.

If your browser assigned a different extension ID, pass it explicitly:

```bash
python3 scripts/install_native_host.py --extension-id <id-from-chrome-extensions>
```

For Chromium, Brave, Edge, manual JSON contents, and background, see [docs/NativeMessaging.md](docs/NativeMessaging.md).

### 4. Pick where archives should land (optional)

The default save target is `~/Documents/chatbot-archives/`. To choose a different location, reinstall the native host wrapper with `--target-dir`:

```bash
python3 scripts/install_native_host.py --target-dir "$HOME/Documents/my-chatbot-archives"
```

Chrome's native messaging manifest does not support arbitrary environment variables, so `--target-dir` writes a small wrapper script that sets `CHATBOT_ARCHIVER_TARGET_DIR` before launching `native_host.py`.
Without `--target-dir`, the same wrapper is still used, but it lets `native_host.py` choose the default `~/Documents/chatbot-archives/` destination.

### 5. Restart Chrome and reload the unpacked extension

Quit Chrome completely (`Cmd+Q` on macOS, then re-open). Chrome only re-reads native messaging host manifests when a new connection is opened from a freshly loaded extension; a quick restart avoids confusion.

Then reload the unpacked extension code:

```text
chrome-extension://<your-extension-id>/popup.html?reload=1
```

### 6. Self-test

Open the extension's options page in your browser:

```text
chrome-extension://<your-extension-id>/popup.html?selftest=1
```

You should see `Self test passed.` and a new `SelfTest/<YYYY-MM-DD>/<bundle>/session.md` plus `attachments/001_selftest.txt` written under your archive directory.

If Chrome shows `ERR_BLOCKED_BY_CLIENT` for the `chrome-extension://...` URL, the unpacked extension is not loaded in that Chrome profile. Go back to `chrome://extensions`, enable Developer mode, and **Load unpacked** from the cloned folder that contains `manifest.json`.

If the page opens but shows `native host unavailable: Native host has exited` right after you updated the source or native host, reload the unpacked extension with `popup.html?reload=1`, then open `popup.html?selftest=1` again.

If you are not sure which half is broken, run:

```bash
python3 scripts/doctor.py
```

It checks the extension source folder, the native messaging manifest, and the host wrapper. It also prints an advisory persisted-profile check, but the self-test URL is the authority for the live Chrome extension because Chrome does not always flush unpacked extension state to `Preferences` immediately.

## Use

1. Open a chatbot conversation page.
2. **Scroll to the top of the conversation** if it lazy-loads — Gemini and similar UIs only render messages once you scroll past them. The extension can only see what the page has rendered.
3. Click the extension icon in the toolbar.
4. A green toast appears on success showing the relative path of the saved bundle. A red toast appears on failure.

The toolbar icon is a single click. There is no popup, no confirmation prompt, no cloud round-trip.

## Scope and red lines

This tool is intended for **a person manually saving their own conversations**. It is **not**:

- A bulk extractor or crawler. There is no batch mode, no scheduling, no scripting hook.
- A way to read someone else's account. It only reads what the active tab shows you.
- A way around any chatbot's terms of service. If a platform's ToS forbids exporting your conversation in a form not provided by the platform, the responsibility is on the user, not on the tool.

Many chatbot platforms restrict automated extraction in their terms. This project is designed for manual click-to-save of your own visible session. Do not turn this tool into something automated.

If a chatbot page only displays a filename for an attachment (e.g. an upload represented by a chip without a retrievable URL), the original local file cannot be reconstructed. The bundle records the filename and marks the attachment as `skipped` with a reason.

## Permissions explained

- `activeTab` + `scripting`: needed to inject the content script into the chatbot tab when you click the icon, so that the DOM can be read.
- `<all_urls>` host permission: needed because the user picks the chatbot domain at click time. The content script is **only** run on the tab that is active when you click the toolbar icon — never automatically on browsing.
- `nativeMessaging`: needed to talk to the local Python writer.
- `storage`: stores `lastCapture` summary in `chrome.storage.local` for debugging only.

The extension does **not** declare the `downloads` permission, does not open WebSockets, does not call any analytics endpoint, and does not contact any fixed remote URL.

## Verification

Run from the extension directory:

```bash
bash scripts/verify_no_network.sh
python3 scripts/check_release_safety.py
python3 scripts/doctor.py
python3 scripts/test_native_host_bundle.py
python3 scripts/test_install_native_host.py
python3 scripts/test_doctor.py
python3 scripts/install_native_host.py --dry-run
node --check background.js content.js popup.js
```

`verify_no_network.sh` is a static check: it greps the source tree for analytics APIs, fixed remote endpoints, the Chrome `downloads` permission, `default_popup`, and any `_`-prefixed file (Chrome refuses to load extensions with `_*` entries).

`check_release_safety.py` scans tracked text files for local home-directory paths, common token formats, private-key blocks, and tracked secret-looking files before public release.

`test_native_host_bundle.py` drives `native_host.py` end to end over stdio the way Chrome does, against a temp directory. It validates the full bundle protocol, the legacy `saveMarkdown` path, and the path-traversal guard.

`test_install_native_host.py` checks that the installer writes a native-messaging wrapper with an explicit Python interpreter, preserves custom archive destinations, and never reuses an existing backup filename.

`install_native_host.py --dry-run` prints the exact wrapper and native messaging manifest it would write without modifying your machine.

## Project status and support

Personal tool. Open-sourced as-is. **No commitment to respond to issues or pull requests.** A chatbot's DOM may change at any time and break a platform; fixes happen when the author needs them.

If you fork this and rename / rebrand for distribution, please remove the author's identifiers and use your own native messaging host bundle name and Chrome `key` so the original allowed_origins do not point at your build.

## License

Apache License 2.0. See [LICENSE](LICENSE).
