# Spec — Local Chatbot Session Archiver

Authoritative spec for the project. The README is the user-facing entry point; this file is the engineering contract.

## 1. Goals and non-goals

### Goals

- Manually export the conversation **currently rendered** in a chatbot tab to a local folder, in two forms:
  - `session.md` — human-readable transcript with YAML frontmatter
  - `session.json` — machine-readable structured payload for other agents (Codex, Claude Code, custom pipelines)
- Save **page-exposed attachments** alongside the transcript when the page exposes a fetchable URL/blob/data source.
- Record every attachment outcome in `attachments/manifest.json`: `saved` when a file is written, `skipped` when the page exposes only metadata such as a filename/chip, and `failed` when a source exists but cannot be fetched or is over the safety limit.
- Stay **offline-first**. No analytics. No fixed remote endpoint. No background activity unless the user clicks.
- Stay **resumable**: the saved bundle should be enough for the user to either paste into another chatbot to keep talking, or hand to a coding agent for follow-up work.

### Non-goals

- Bulk extraction, crawling, scheduling, automation hooks.
- Reconstructing original local files when the page does not expose a URL/blob.
- Bypassing any chatbot platform's terms of service.
- Distribution via the Chrome Web Store. The native messaging host architecture cannot be packaged through the Web Store, and a Web Store version would have to fall back to Chrome's `downloads` API, which the design explicitly rejects.

## 2. Architecture

```
┌────────────────────┐  user click   ┌──────────────────┐  scripting.executeScript  ┌─────────────┐
│  Toolbar action    │──────────────▶│  background.js   │──────────────────────────▶│ content.js  │
│ (no popup)         │               │  (service worker)│                           │  (in tab)   │
└────────────────────┘               └────────┬─────────┘                           └──────┬──────┘
                                              │ sendNativeMessage (stdio)                  │ DOM read +
                                              ▼                                            │ attachment fetch
                                       ┌────────────────┐                                  │
                                       │ native_host.py │◀─────────────────────────────────┘
                                       │  (local proc)  │   bundle protocol over stdio
                                       └──────┬─────────┘
                                              │ writes
                                              ▼
                                  ~/Documents/chatbot-archives/<Platform>/<date>/<bundle>/
```

Components:

| File | Role |
|---|---|
| `manifest.json` | Chrome MV3 manifest. Declares the stable extension `key`, the toolbar action (no popup), the service worker, the options page, and minimum permissions. |
| `background.js` | Service worker. On toolbar click: runs `content.js` in the active tab, talks to the native host using the bundle protocol, draws toast/badge feedback. Also implements the self-test bundle. |
| `content.js` | Runs inside the chatbot tab. Detects platform, walks DOM via a layered selector list, normalizes messages, infers roles, collects attachment references, hydrates inline `data:`/`blob:` payloads, deduplicates. Returns a session object. |
| `popup.html` / `popup.js` / `styles.css` | Options/self-test page. Not used as a popup — `manifest.json` does not declare `default_popup`. Drives `?selftest=1` and `?reload=1` modes. |
| `native_host.py` | Local Python process. Receives length-prefixed JSON messages from Chrome over stdio. Writes the bundle. Has no network capability. |
| `icons/` | Toolbar/option-page PNGs at 16/32/48/128 plus the source SVG. |
| `scripts/` | `verify_no_network.sh` (static safety check), `test_native_host_bundle.py` (e2e bundle protocol test against a temp dir), `render_icons.py` (rebuild icons). |

## 3. Permissions and minimization

| Permission | Why needed | Could it be smaller? |
|---|---|---|
| `activeTab` | Inject `content.js` into the tab the user just clicked from. | Required for the click model. |
| `scripting` | The actual API used to inject. | Required. |
| `nativeMessaging` | Talk to `native_host.py` over stdio. | Required for local file write without `downloads`. |
| `storage` | Persist `lastCapture` summary in `chrome.storage.local`. | Could be dropped if the options page learns to live without diagnostic context. Kept for now. |
| `<all_urls>` | The set of chatbot domains is open-ended; capture only happens on the active tab on user click. | Could be replaced with an explicit host list, at the cost of needing an extension update for every new chatbot. |
| ❌ `downloads` | Not declared. Saves go through native messaging only. | — |

## 4. Native messaging contract

### Wire format

Chrome native messaging stdio: each message is `<uint32 little-endian length><utf8 JSON body>` in both directions, one request → one response per Chrome `sendNativeMessage` call.

### Bundle protocol (current)

| Request `type` | Required fields | Response on success |
|---|---|---|
| `startBundle` | `relativeDir` | `{ ok, host, path, relativeDir, targetDir }` — also creates an `attachments/` subdir |
| `writeAttachmentChunk` | `relativeDir`, `attachmentPath`, `chunkIndex`, `dataBase64` | `{ ok, host, path, relativePath, bytes }` |
| `completeAttachment` | `relativeDir`, `tempPath`, `finalPath` | `{ ok, host, path, relativePath }` |
| `finishBundle` | `relativeDir`, `markdown`, `sessionJson`, `attachmentManifest`, `metadata` | `{ ok, host, path, relativeDir, sessionJson, attachmentManifest, targetDir }` |

`attachmentPath` and `finalPath` must live under `attachments/`. Directory traversal is rejected with an error response (`relativeDir` containing `..` or `\\`, absolute paths, etc.).

### Legacy protocol (kept for backward compat)

| Request `type` | Fields | Behaviour |
|---|---|---|
| `saveMarkdown` | `relativePath`, `markdown`, `metadata?` | Writes a single Markdown file. Used by the `popup.js` "Save Current Session" button only. |

### Identity

- Native host bundle name: `com.chatbotarchiver.host`
- Manifest filename (per OS):
  - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chatbotarchiver.host.json`
  - Linux: `~/.config/google-chrome/NativeMessagingHosts/com.chatbotarchiver.host.json`
  - Windows: a registry entry, see Chrome docs
- `allowed_origins` must contain `chrome-extension://<your_extension_id>/`. With the shipped stable `key` field, the extension ID is deterministic.

## 5. Output format

### `session.md` — human-readable

```markdown
---
source: local-chatbot-session-archiver
captured_at: "2026-05-03T12:36:16.809Z"
platform: "Claude"
url: "https://claude.ai/chat/<id>"
title: "<conversation title>"
message_count: 4
attachment_count: 4
saved_attachment_count: 4
privacy: local-export-with-page-exposed-attachment-fetch
---

# <Title>

- Platform / URL / Captured / Capture mode

> Attachment note: …

## Conversation
### 1. User
…
### 2. Assistant
…

## Attachment Index
…

## Saved Attachment Files
…

## Machine-Readable Summary
```json
{ … }
```
```

### `session.json` — machine-readable

```jsonc
{
  "ok": true,
  "platform": { "id": "claude", "name": "Claude", "host": "claude.ai" },
  "title": "…",
  "url": "https://…",
  "capturedAt": "2026-05-03T12:36:16.809Z",
  "captureMode": "message-candidates" | "main-text-fallback",
  "messages": [
    {
      "role": "user" | "assistant" | "system" | "message" | "page",
      "content": "…",
      "attachments": [ { /* see attachments[] */ } ]
    }
  ],
  "attachments": [
    {
      "kind": "image" | "link" | "filename" | "visible-attachment",
      "label": "IMG_*.jpeg",
      "source": "https://…",
      "sourceType": "remote-url" | "data-url" | "blob-url" | "browser-file-url" | "other",
      "filename": "…",
      "mimeType": "image/jpeg",
      "byteSize": 12345,
      "inlineDataBase64": "…optional, only for tiny data:/blob: payloads…",
      "inlineStatus": "captured-in-page" | "skipped-too-large-for-page-inline" | "capture-failed: …"
    }
  ],
  "savedAttachments": [
    { "index": 1, "label": "…", "kind": "…", "sourceType": "…", "source": "…",
      "path": "attachments/001_…",
      "status": "saved" | "failed" | "skipped",
      "bytes": 12345,
      "mimeType": "image/jpeg",
      "reason": "<only when status != saved>"
    }
  ]
}
```

### `attachments/manifest.json`

Same as `session.savedAttachments` plus a header:

```json
{
  "source": "local-chatbot-session-archiver",
  "capturedAt": "…",
  "platform": { … },
  "url": "…",
  "totalRecords": 49,
  "savedCount": 41,
  "failedCount": 0,
  "skippedCount": 8,
  "attachments": [ /* the per-record entries */ ]
}
```

## 6. Platform support and DOM capture

`content.js` does **not** rely on a single per-platform extractor. Instead it runs a layered selector list in declaration order, then normalizes the result. The selectors include both well-known per-platform attributes and generic conventions:

- `[data-message-author-role]` — ChatGPT
- `[data-testid*='message']`, `[data-testid*='conversation-turn']` — generic + ChatGPT
- `div.font-claude-response`, `div.font-claude-message`, `[class*='claude-response']` — Claude
- `user-query`, `model-response`, `message-content` — Gemini custom elements
- `article`, `[role='listitem']`, `[data-index]`, `[class*='message']`, `[class*='Message']` — generic fallback

For each match the script computes a wider **attachment scope** (`closest('[data-test-render-count], [data-message-author-role], [data-testid*="conversation-turn"], article')`) so that attachments rendered as siblings of the text bubble (Claude) are still picked up.

### Adding a platform

1. Add the host to `detectPlatform()` in `content.js` and to `platformFolderName()` in `background.js`.
2. If the platform exposes message containers via a unique attribute, add a selector to `collectMessageCandidates()`.
3. If the platform exposes attachments outside the matched container (siblings, sticky header, lightbox), extend `attachmentScope()`.
4. If role inference is wrong, update `inferRole()` with platform-specific signals.
5. Re-run `scripts/test_native_host_bundle.py` and a manual save against a real conversation; commit a screenshot to `docs/` if helpful.

### Known limitations

- Long conversations: messages above the current scroll position may not be in the DOM yet. The user should scroll to the earliest message before saving so the page has loaded the full history.
- Thinking summaries: some platforms (Claude) render a collapsed-summary line that duplicates the first sentence of the body. `collapseInternalRepeats()` collapses adjacent repeated lines and `removeContainerDuplicates()` drops nested fragments by DOM containment.
- Pages that expose attachments only as filenames or chips with no fetchable URL/blob: the bundle records the metadata as `kind: "filename"` or `kind: "visible-attachment"` and marks them `skipped`.
- Platform-hidden uploads: some chatbot platforms keep uploaded files behind internal APIs and render only a visible file card. The archiver must not pretend to reconstruct those files; it records the platform-visible metadata and the skip reason.
- DOM is not a stable API. A platform redesign breaks selectors with no warning. Mitigation is fast manual repair, not a contract.

## 7. Install / upgrade / rollback

### Install

See README.md §Install. Summary:

1. Clone the repo.
2. `Load unpacked` in `chrome://extensions`.
3. Run `python3 scripts/install_native_host.py` to write the native messaging host JSON manifest and the Python-launch wrapper.
4. Quit + reopen Chrome.
5. Run the `?selftest=1` URL.

### Upgrade

`git pull`, then click `Reload` on the extension card. The native messaging host manifest does not need to change unless `path` or `allowed_origins` moves.

### Rollback

1. `Remove` the extension from `chrome://extensions`.
2. Delete `com.chatbotarchiver.host.json` from your browser's NativeMessagingHosts directory. The exact path depends on the browser (`scripts/install_native_host.py --browser <name> --dry-run` prints the location). Defaults: Chrome `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`, ChatGPT Atlas `~/Library/Application Support/OpenAI/ChatGPT Atlas/NativeMessagingHosts/`, plus Chromium/Brave/Edge analogues; see `docs/NativeMessaging.md` for the full table.
3. Optionally delete the archive directory.

## 8. Testing matrix

| Check | Command | What it covers |
|---|---|---|
| Static safety | `bash scripts/verify_no_network.sh` | analytics APIs, fixed remote endpoints, `downloads` permission, `default_popup`, `_`-prefixed entries |
| Bundle protocol e2e | `python3 scripts/test_native_host_bundle.py` | startBundle / writeAttachmentChunk / completeAttachment / finishBundle, legacy `saveMarkdown`, path traversal |
| Installer behaviour | `python3 scripts/test_install_native_host.py` and `python3 scripts/install_native_host.py --dry-run` | native messaging manifest, explicit Python wrapper generation, target-dir export, dry-run without modifying the machine |
| Manifest JSON | `python3 -m json.tool manifest.json` | manifest is well-formed |
| JS syntax | `node --check background.js content.js popup.js` | no syntax errors |
| Python syntax | `python3 -c "import ast; ast.parse(open('native_host.py').read())"` | no syntax errors, no `__pycache__` written |
| Manual save | toolbar click on a real chatbot tab | end-to-end DOM extraction + native host write |
| Self-test page | open `chrome-extension://<id>/popup.html?selftest=1` | extension ↔ background ↔ native host plumbing |

## 9. Compliance and ethics

- The tool only acts on a **user-initiated click**. There is no scheduled, headless, or background capture.
- The tool only reads the **active tab** at click time.
- Attachment fetches use the **current browser session** (cookies) just like a manual right-click → Save would.
- No data leaves the user's machine. No telemetry.
- The user is responsible for obeying the terms of service of any chatbot they save from. Most ToS forbid *automated* extraction; clicking once to save your own conversation is generally consistent with normal product use, but the user is the responsible party, not the tool.

## 10. Roadmap and known limitations

- Selectors will rot. Fixes are best-effort and tied to the maintainer's actual usage.
- No support yet for Tencent Yuanbao.
- No CRX signing pipeline. The repo ships a stable `key` so the unpacked extension ID is deterministic; signed CRX is out of scope unless someone explicitly wants it.
- CI runs the static safety checks, native-host protocol test, and JS/Python syntax checks on GitHub Actions.
- No issue templates and no PR labelling. Forks are welcome under the Apache-2.0 license; please rename and use your own `key` if you redistribute.
