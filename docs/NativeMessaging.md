# Native messaging host setup

Chrome extensions cannot silently write to arbitrary local paths through any built-in extension API. They can write to the user's **Downloads** folder via the `downloads` API, with a save prompt and constrained location, or they can pass data to a **native messaging host** — a small local executable installed by the user — that does the file write itself.

This project chooses native messaging because the goal is to write a session bundle to a folder the user picks, with no save prompt, and `Downloads` does not satisfy that.

The same architecture is the reason this project is **not distributed through the Chrome Web Store**: the Web Store cannot ship the local Python writer, and a Web Store-only build would have to fall back to `downloads`, which would defeat the design.

## How Chrome finds the host

When the extension calls `chrome.runtime.sendNativeMessage("com.chatbotarchiver.host", …)`:

1. Chrome looks for a JSON manifest with that `name` in well-known per-OS directories.
2. Chrome reads the manifest's `allowed_origins`. If the calling extension's origin (`chrome-extension://<id>/`) is not in the list, the call is rejected.
3. Chrome forks the program at `path` (the manifest's `path` field), pipes stdio, and the extension and the host exchange length-prefixed JSON messages.

The bundle name `com.chatbotarchiver.host` is fixed in `background.js` and `native_host.py`. If you fork and rebrand, change all three places (`name` in the JSON manifest, `HOST_NAME` in `native_host.py`, `NATIVE_HOST` in `background.js`) and rename the manifest file accordingly.

## Manifest paths per OS

| OS | Manifest directory |
|---|---|
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` |
| Linux | `~/.config/google-chrome/NativeMessagingHosts/` |
| Windows | The registry. See [Chrome's native messaging docs](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) for the exact key. |

The manifest file must be named exactly `com.chatbotarchiver.host.json`.

## Manifest contents

```json
{
  "name": "com.chatbotarchiver.host",
  "description": "Local Chatbot Session Archiver native writer",
  "path": "/absolute/path/to/com.chatbotarchiver.host.sh",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://jomoepphgememdnpipkhojpjmkjeehdl/"
  ]
}
```

- `path` must be **absolute**. Relative paths and `~` are not expanded by Chrome.
- `path` must be **executable**. The installer writes an executable wrapper script and points the manifest at that wrapper.
- The wrapper invokes `native_host.py` with the same Python interpreter that ran the installer. This avoids relying on Chrome's process environment to resolve Python from the host script's shebang.
- `allowed_origins` must include the **exact** Chrome extension ID. With the bundled stable `key` field in `manifest.json`, the ID is deterministic and equal to `jomoepphgememdnpipkhojpjmkjeehdl`. If you replace the `key` (e.g. when forking), the ID will change — recompute it and update `allowed_origins`.

## Installer

For macOS and Linux, prefer the installer:

```bash
python3 scripts/install_native_host.py
```

Use `--browser chromium`, `--browser brave`, `--browser edge`, or `--browser atlas` (macOS only; ChatGPT Atlas browser) for those Chromium-based browsers. Use `--extension-id <id>` if your loaded extension ID differs from `jomoepphgememdnpipkhojpjmkjeehdl`.

**ChatGPT Atlas note**: Atlas is a Chromium-based browser from OpenAI; it loads MV3 extensions normally but reads native-messaging host manifests from its **own** directory (`~/Library/Application Support/OpenAI/ChatGPT Atlas/NativeMessagingHosts/`), not Chrome's. If you have the extension installed in both Chrome and Atlas, run the installer once per browser.

### Customizing the archive directory

The installer always writes a small wrapper script and points Chrome at that wrapper. By default the host writes to `~/Documents/chatbot-archives/`. Chrome's native messaging manifest does not support arbitrary environment variables, so `--target-dir` makes the wrapper set `CHATBOT_ARCHIVER_TARGET_DIR` before it launches `native_host.py`. The wrapper lives under `~/Library/ChatbotSessionArchiver/` on macOS, or `~/.local/share/chatbot-session-archiver/` on Linux. To choose a different archive directory:

```bash
python3 scripts/install_native_host.py --target-dir "$HOME/Documents/my-chatbot-archives"
```

The host will create the archive directory on first save if it does not exist.

## When edits to the manifest take effect

Chrome reads the native messaging host manifest **at the moment a fresh native messaging connection opens**. In practice that means: changes to the JSON file are not picked up by an in-flight extension session. If you change `path`, the wrapper script, or `allowed_origins`, **fully quit Chrome and reopen it** before retesting.

Reloading the extension alone is not sufficient.

## Stable extension ID

`manifest.json` ships a `"key"` field. Chrome derives the unpacked extension's ID from that key, so the ID is stable across:

- Different machines that load the same source folder
- Moves of the source folder on disk (re-Loading from a new path keeps the ID)
- Re-installs

If you fork this repo for distribution under your own identity:

1. Generate a new RSA keypair with `openssl genrsa -out private.pem 2048`.
2. Export the public key in DER form: `openssl rsa -in private.pem -pubout -outform DER -out public.der`.
3. Base64-encode `public.der` and replace the `"key"` field in `manifest.json`.
4. Compute the new extension ID: SHA-256 of the DER public key, take the first 16 bytes, map each nibble `0..15` to characters `a..p`, concatenate to a 32-character string.
5. Update `allowed_origins` in your native messaging host manifest to the new ID.
6. **Keep `private.pem` outside the repo** (it is in `.gitignore` for safety) and store it somewhere persistent. You will need it again to sign a `.crx` if you ever decide to package the extension.

## Troubleshooting

| Symptom | Most likely cause |
|---|---|
| `native host unavailable: ... name not registered` | Manifest filename does not match `com.chatbotarchiver.host.json` exactly, or it is in the wrong directory for your OS. |
| `native host unavailable: Specified native messaging host not found` | `path` in the manifest does not point at an existing executable file. |
| `native host unavailable: Access to the specified native messaging host is forbidden` | `allowed_origins` does not contain the current extension ID. Open `chrome://extensions`, copy the loaded extension's ID, and ensure it is listed. Then quit and reopen Chrome. |
| `native messaging API is unavailable` (in the page console) | The unpacked extension was loaded from a folder Chrome lost track of, or the service worker died. Click `Reload` on the extension card. |
| `Self test failed: …` after a successful manifest edit | Chrome is still using the old manifest contents. Quit Chrome completely and reopen. |
| `ERR_BLOCKED_BY_CLIENT` on `chrome-extension://<id>/popup.html?selftest=1` | That extension ID is not loaded in the current Chrome profile. Open `chrome://extensions`, enable Developer mode, and load the cloned folder that contains `manifest.json`. |
| `Cannot load extension with file or directory name __pycache__` | `python3 -m py_compile` (or running an `import` against modules in this folder) created a `__pycache__/` directory. Delete it. The bundled `scripts/verify_no_network.sh` checks for `_`-prefixed entries before launch. |
