const PLATFORM_PATTERNS = [
  { id: "chatgpt", name: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com"] },
  { id: "claude", name: "Claude", hosts: ["claude.ai"] },
  { id: "gemini", name: "Gemini", hosts: ["gemini.google.com"] },
  { id: "deepseek", name: "DeepSeek", hosts: ["chat.deepseek.com"] },
  { id: "kimi", name: "Kimi", hosts: ["kimi.moonshot.cn", "kimi.com"] },
  { id: "doubao", name: "Doubao", hosts: ["www.doubao.com", "doubao.com"] },
  { id: "perplexity", name: "Perplexity", hosts: ["www.perplexity.ai", "perplexity.ai"] },
  { id: "grok", name: "Grok", hosts: ["grok.com"] },
  { id: "qianwen", name: "Qianwen", hosts: ["www.qianwen.com", "qianwen.com"] },
  { id: "poe", name: "Poe", hosts: ["poe.com"] },
  { id: "copilot", name: "Copilot", hosts: ["copilot.microsoft.com"] },
  { id: "mistral", name: "Mistral", hosts: ["chat.mistral.ai"] }
];

const saveButton = document.getElementById("saveButton");
const pageStatus = document.getElementById("pageStatus");
const platformName = document.getElementById("platformName");
const logEl = document.getElementById("log");

let activeTab = null;

document.addEventListener("DOMContentLoaded", init);
saveButton.addEventListener("click", saveCurrentSession);

async function init() {
  const params = new URLSearchParams(location.search);

  if (params.get("reload") === "1") {
    saveButton.disabled = true;
    platformName.textContent = "Reload";
    pageStatus.textContent = "Reloading unpacked extension...";
    setStatus("Calling chrome.runtime.reload().");
    setTimeout(() => chrome.runtime.reload(), 100);
    return;
  }

  if (params.get("selftest") === "1") {
    await runSelfTest();
    return;
  }

  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || !activeTab.url) {
    setStatus("No active tab found.");
    saveButton.disabled = true;
    return;
  }

  const platform = detectPlatform(activeTab.url);
  platformName.textContent = platform ? platform.name : "Generic page";
  pageStatus.textContent = activeTab.title || activeTab.url;
  setStatus(platform ? "Ready." : "Ready for generic capture.");
}

async function runSelfTest() {
  saveButton.disabled = true;
  platformName.textContent = "Self test";
  pageStatus.textContent = "Testing background bundle and attachment save path...";
  setStatus("Running self test...");

  try {
    const nativeResult = await runBundleSelfTest();
    const savedCount = nativeResult.savedAttachments.filter(item => item.status === "saved").length;
    setStatus(`Self test passed.\nFolder: ${nativeResult.relativeDir}\nFile: ${nativeResult.path}\nSaved attachments: ${savedCount}`);
  } catch (error) {
    setStatus(`Self test failed: ${error.message || error}`);
  }
}

function runBundleSelfTest() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "selfTestBundle" }, response => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(`extension background unavailable: ${lastError.message}`));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "bundle self test failed"));
        return;
      }
      resolve(response);
    });
  });
}

async function saveCurrentSession() {
  if (!activeTab?.id) return;
  saveButton.disabled = true;
  setStatus("Capturing current tab...");

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ["content.js"]
    });

    const session = results?.[0]?.result;
    if (!session?.ok) {
      throw new Error(session?.error || "Capture returned no data.");
    }

    const markdown = renderMarkdown(session);
    const filename = buildArchiveRelativePath(session);
    const nativeResult = await saveMarkdownNative(filename, markdown, session);

    await chrome.storage.local.set({
      lastCapture: {
        capturedAt: session.capturedAt,
        platform: session.platform.name,
        title: session.title,
        url: session.url,
        messageCount: session.messages.length,
        attachmentCount: session.attachments.length,
        savedPath: nativeResult.path,
        savedFilename: nativeResult.filename,
        nativeHost: nativeResult.host
      }
    });

    const message = `Saved ${session.messages.length} messages, ${session.attachments.length} attachments.`;
    setStatus(`${message}\nFile: ${nativeResult.path}`);
    await showPageToast(activeTab.id, `Saved to ${nativeResult.targetDir || nativeResult.path}`);
  } catch (error) {
    const message = `Failed: ${error.message || error}\nReload this unpacked extension in chrome://extensions if native messaging was just installed.`;
    setStatus(message);
    if (activeTab?.id) await showPageToast(activeTab.id, message, true);
  } finally {
    saveButton.disabled = false;
  }
}

function saveMarkdownNative(filename, markdown, session) {
  return new Promise((resolve, reject) => {
    const metadata = {
      capturedAt: session.capturedAt,
      platform: session.platform,
      title: session.title,
      url: session.url,
      messageCount: session.messages.length,
      attachmentCount: session.attachments.length
    };

    try {
      chrome.runtime.sendMessage(
        {
          type: "saveMarkdownNative",
          payload: {
            filename,
            relativePath: filename,
            markdown,
            metadata
          }
        },
        response => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(`extension background unavailable: ${lastError.message}`));
            return;
          }
          if (!response?.ok) {
            reject(new Error(response?.error || "native host save failed"));
            return;
          }
          resolve(response);
        }
      );
    } catch (error) {
      reject(error);
    }
  });
}

async function showPageToast(tabId, message, isError = false) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (text, error) => {
        const id = "local-chatbot-session-archiver-toast";
        const old = document.getElementById(id);
        if (old) old.remove();

        const toast = document.createElement("div");
        toast.id = id;
        toast.textContent = text;
        Object.assign(toast.style, {
          position: "fixed",
          top: "18px",
          right: "18px",
          zIndex: "2147483647",
          maxWidth: "360px",
          padding: "12px 14px",
          borderRadius: "8px",
          boxShadow: "0 12px 30px rgba(0, 0, 0, 0.22)",
          background: error ? "#9f1d1d" : "#1f7a3f",
          color: "#fff",
          font: "13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          letterSpacing: "0",
          opacity: "0",
          transform: "translateY(-6px)",
          transition: "opacity 140ms ease, transform 140ms ease"
        });
        document.documentElement.appendChild(toast);
        requestAnimationFrame(() => {
          toast.style.opacity = "1";
          toast.style.transform = "translateY(0)";
        });
        setTimeout(() => {
          toast.style.opacity = "0";
          toast.style.transform = "translateY(-6px)";
          setTimeout(() => toast.remove(), 180);
        }, 3600);
      },
      args: [message, isError]
    });
  } catch {
    // Some pages block script injection after capture. The self-test status remains the fallback.
  }
}

function detectPlatform(urlText) {
  try {
    const { hostname } = new URL(urlText);
    return PLATFORM_PATTERNS.find(platform =>
      platform.hosts.some(host => hostname === host || hostname.endsWith(`.${host}`))
    ) || null;
  } catch {
    return null;
  }
}

function renderMarkdown(session) {
  const lines = [];
  lines.push("---");
  lines.push("source: local-chatbot-session-archiver");
  lines.push(`captured_at: ${quoteYaml(session.capturedAt)}`);
  lines.push(`platform: ${quoteYaml(session.platform.name)}`);
  lines.push(`url: ${quoteYaml(session.url)}`);
  lines.push(`title: ${quoteYaml(session.title)}`);
  lines.push(`message_count: ${session.messages.length}`);
  lines.push(`attachment_count: ${session.attachments.length}`);
  lines.push("privacy: zero-network-local-export");
  lines.push("---");
  lines.push("");
  lines.push(`# ${session.title || "Untitled Chatbot Session"}`);
  lines.push("");
  lines.push(`- Platform: ${session.platform.name}`);
  lines.push(`- URL: ${session.url}`);
  lines.push(`- Captured: ${session.capturedAt}`);
  lines.push(`- Capture mode: ${session.captureMode}`);
  lines.push("");
  lines.push("> Attachment note: browser pages usually expose uploaded files as visible chips, filenames, images, or links. Original local binary files cannot be read again unless the chatbot page exposes them.");
  lines.push("");
  lines.push("## Conversation");
  lines.push("");

  session.messages.forEach((message, index) => {
    lines.push(`### ${index + 1}. ${titleCase(message.role || "message")}`);
    lines.push("");
    lines.push(message.content || "_No visible text captured._");
    if (message.attachments?.length) {
      lines.push("");
      lines.push("Attachments in this message:");
      message.attachments.forEach(att => {
        lines.push(`- ${formatAttachment(att)}`);
      });
    }
    lines.push("");
  });

  if (session.attachments.length) {
    lines.push("## Attachment Index");
    lines.push("");
    session.attachments.forEach((att, index) => {
      lines.push(`${index + 1}. ${formatAttachment(att)}`);
    });
    lines.push("");
  }

  lines.push("## Machine-Readable Summary");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify({
    platform: session.platform,
    url: session.url,
    title: session.title,
    capturedAt: session.capturedAt,
    messageCount: session.messages.length,
    attachmentCount: session.attachments.length
  }, null, 2));
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

function buildBaseFilename(session) {
  const stamp = session.capturedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const title = slug(session.title || "chatbot-session").slice(0, 80) || "chatbot-session";
  const platform = slug(session.platform.id || "generic") || "generic";
  return `${stamp}_${platform}_${title}.md`;
}

function buildArchiveRelativePath(session) {
  const platformFolder = platformFolderName(session.platform.id || "generic", session.platform.name || "Generic");
  const dateFolder = session.capturedAt.slice(0, 10) || "unknown-date";
  return `${platformFolder}/${dateFolder}/${buildBaseFilename(session)}`;
}

function platformFolderName(platformId, platformName) {
  const known = {
    chatgpt: "ChatGPT",
    claude: "Claude",
    gemini: "Gemini",
    deepseek: "DeepSeek",
    kimi: "Kimi",
    doubao: "Doubao",
    perplexity: "Perplexity",
    grok: "Grok",
    qianwen: "Qianwen",
    poe: "Poe",
    copilot: "Copilot",
    mistral: "Mistral",
    selftest: "SelfTest",
    generic: "Generic"
  };
  return known[platformId] || slug(platformName).replace(/(^|-)([a-z])/g, (_, sep, c) => `${sep}${c.toUpperCase()}`) || "Generic";
}

function formatAttachment(att) {
  const label = att.label || att.kind || "attachment";
  const details = [];
  if (att.kind) details.push(`kind=${att.kind}`);
  if (att.source) details.push(`source=${att.source}`);
  if (att.note) details.push(`note=${att.note}`);
  return `${label}${details.length ? ` (${details.join("; ")})` : ""}`;
}

function titleCase(text) {
  return `${text}`.replace(/\b\w/g, c => c.toUpperCase());
}

function slug(text) {
  return `${text}`
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .toLowerCase();
}

function quoteYaml(value) {
  return JSON.stringify(value || "");
}

function setStatus(message) {
  logEl.textContent = message;
}
