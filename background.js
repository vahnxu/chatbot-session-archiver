const NATIVE_HOST = "com.chatbotarchiver.host";
const SAVE_EXPOSED_ATTACHMENTS_BY_DEFAULT = true;
const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024;
const ATTACHMENT_CHUNK_BYTES = 512 * 1024;

chrome.action.onClicked.addListener(tab => {
  saveActiveTab(tab);
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.type === "saveMarkdownNative") {
    saveMarkdownNative(
      request.payload?.relativePath || request.payload?.filename,
      request.payload?.markdown,
      request.payload?.metadata
    )
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message || `${error}` }));

    return true;
  }

  if (request?.type === "selfTestBundle") {
    runSelfTestBundle()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message || `${error}` }));

    return true;
  }

  return false;
});

async function saveActiveTab(tab) {
  const tabId = tab?.id;
  if (!tabId) {
    await showActionBadge("ERR", "#9f1d1d");
    return;
  }

  await showActionBadge("...", "#4b5563");

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });

    const session = results?.[0]?.result;
    if (!session?.ok) {
      throw new Error(session?.error || "Capture returned no data.");
    }

    const relativeDir = buildArchiveRelativeDir(session);
    const bundle = await startBundleNative(relativeDir);
    const savedAttachments = SAVE_EXPOSED_ATTACHMENTS_BY_DEFAULT
      ? await saveExposedAttachments(bundle.relativeDir, session.attachments)
      : [];

    session.savedAttachments = savedAttachments;
    const markdown = renderMarkdown(session);
    const manifest = buildAttachmentManifest(session, savedAttachments);
    const nativeResult = await finishBundleNative(bundle.relativeDir, markdown, session, manifest);
    const savedFileCount = savedAttachments.filter(item => item.status === "saved").length;
    const failedFileCount = savedAttachments.filter(item => item.status === "failed").length;

    await chrome.storage.local.set({
      lastCapture: {
        capturedAt: session.capturedAt,
        platform: session.platform.name,
        title: session.title,
        url: session.url,
        messageCount: session.messages.length,
        attachmentCount: session.attachments.length,
        savedAttachmentCount: savedFileCount,
        failedAttachmentCount: failedFileCount,
        savedPath: nativeResult.path,
        savedRelativeDir: nativeResult.relativeDir,
        nativeHost: nativeResult.host
      }
    });

    await showPageToast(
      tabId,
      `Saved ${session.messages.length} messages, ${session.attachments.length} attachment records, ${savedFileCount} files.\n${nativeResult.relativeDir}`
    );
    await showActionBadge("OK", "#1f7a3f");
  } catch (error) {
    const message = `Save failed: ${error.message || error}`;
    await showPageToast(tabId, message, true);
    await showActionBadge("ERR", "#9f1d1d");
  } finally {
    setTimeout(() => {
      chrome.action.setBadgeText({ text: "" });
    }, 3600);
  }
}

async function runSelfTestBundle() {
  const capturedAt = new Date().toISOString();
  const inlineDataBase64 = "c2VsZi10ZXN0IGF0dGFjaG1lbnQK";
  const session = {
    ok: true,
    capturedAt,
    platform: { id: "selftest", name: "Self test", host: "chrome-extension" },
    title: "Chatbot Archiver Bundle Self Test",
    url: chrome.runtime.getURL("popup.html?selftest=1"),
    messages: [{
      role: "system",
      content: "Self test for the extension background, bundle writer, and attachment path.",
      attachments: [{
        kind: "link",
        label: "selftest.txt",
        source: "data:text/plain;base64,c2VsZi10ZXN0IGF0dGFjaG1lbnQK",
        sourceType: "data-url",
        filename: "selftest.txt",
        mimeType: "text/plain",
        byteSize: 21,
        inlineDataBase64,
        inlineStatus: "synthetic-selftest"
      }]
    }],
    attachments: [{
      kind: "link",
      label: "selftest.txt",
      source: "data:text/plain;base64,c2VsZi10ZXN0IGF0dGFjaG1lbnQK",
      sourceType: "data-url",
      filename: "selftest.txt",
      mimeType: "text/plain",
      byteSize: 21,
      inlineDataBase64,
      inlineStatus: "synthetic-selftest"
    }],
    captureMode: "selftest-bundle"
  };

  const relativeDir = buildArchiveRelativeDir(session);
  const bundle = await startBundleNative(relativeDir);
  const savedAttachments = await saveExposedAttachments(bundle.relativeDir, session.attachments);
  session.savedAttachments = savedAttachments;
  const markdown = renderMarkdown(session);
  const manifest = buildAttachmentManifest(session, savedAttachments);
  const nativeResult = await finishBundleNative(bundle.relativeDir, markdown, session, manifest);
  return {
    ok: true,
    capturedAt,
    relativeDir: nativeResult.relativeDir,
    path: nativeResult.path,
    sessionJson: nativeResult.sessionJson,
    attachmentManifest: nativeResult.attachmentManifest,
    savedAttachments
  };
}

function startBundleNative(relativeDir) {
  return sendNativeRequest({
    type: "startBundle",
    relativeDir
  });
}

function finishBundleNative(relativeDir, markdown, session, attachmentManifest) {
  return sendNativeRequest({
    type: "finishBundle",
    relativeDir,
    markdown,
    sessionJson: JSON.stringify(session, null, 2),
    attachmentManifest: JSON.stringify(attachmentManifest, null, 2),
    metadata: {
      capturedAt: session.capturedAt,
      platform: session.platform,
      title: session.title,
      url: session.url,
      messageCount: session.messages.length,
      attachmentCount: session.attachments.length,
      savedAttachmentCount: attachmentManifest.savedCount,
      failedAttachmentCount: attachmentManifest.failedCount
    }
  });
}

function saveMarkdownNative(relativePath, markdown, metadata) {
  return sendNativeRequest({
    type: "saveMarkdown",
    relativePath,
    filename: relativePath,
    markdown,
    metadata
  });
}

function writeAttachmentChunkNative(relativeDir, attachmentPath, chunkIndex, dataBase64) {
  return sendNativeRequest({
    type: "writeAttachmentChunk",
    relativeDir,
    attachmentPath,
    chunkIndex,
    dataBase64
  });
}

function completeAttachmentNative(relativeDir, tempPath, finalPath) {
  return sendNativeRequest({
    type: "completeAttachment",
    relativeDir,
    tempPath,
    finalPath
  });
}

function sendNativeRequest(payload) {
  return new Promise((resolve, reject) => {
    if (typeof chrome.runtime.sendNativeMessage !== "function") {
      reject(new Error("native messaging API is unavailable. Reload this unpacked extension in chrome://extensions."));
      return;
    }

    chrome.runtime.sendNativeMessage(
      NATIVE_HOST,
      payload,
      response => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(`native host unavailable: ${lastError.message}`));
          return;
        }

        if (!response?.ok) {
          reject(new Error(response?.error || "native host save failed"));
          return;
        }

        resolve(response);
      }
    );
  });
}

async function saveExposedAttachments(relativeDir, attachments) {
  const results = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const plannedPath = `attachments/${buildAttachmentFilename(attachment, index)}`;
    const tempPath = `${plannedPath}.part`;
    const base = {
      index: index + 1,
      label: attachment.label || attachment.kind || "attachment",
      kind: attachment.kind || "",
      sourceType: attachment.sourceType || "",
      source: attachment.source || "",
      path: plannedPath
    };

    if (!isDownloadCandidate(attachment)) {
      results.push({ ...base, status: "skipped", reason: "no downloadable source exposed by page" });
      continue;
    }

    try {
      let bytesWritten = 0;
      let mimeType = attachment.mimeType || "";
      if (attachment.inlineDataBase64) {
        bytesWritten = await writeBase64StringInChunks(relativeDir, tempPath, attachment.inlineDataBase64);
      } else {
        const response = await fetch(attachment.source, {
          credentials: "include",
          cache: "no-store",
          redirect: "follow"
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        mimeType = mimeType || response.headers.get("content-type") || "";
        const contentLength = Number(response.headers.get("content-length") || 0);
        if (contentLength > MAX_ATTACHMENT_BYTES) {
          throw new Error(`attachment too large: ${contentLength} bytes`);
        }
        bytesWritten = await writeResponseBodyInChunks(relativeDir, tempPath, response);
      }
      await completeAttachmentNative(relativeDir, tempPath, plannedPath);

      results.push({
        ...base,
        status: "saved",
        bytes: bytesWritten,
        mimeType
      });
    } catch (error) {
      results.push({
        ...base,
        status: "failed",
        reason: error?.message || `${error}`
      });
    }
  }
  return results;
}

function isDownloadCandidate(attachment) {
  if (!attachment?.source) return false;
  return ["data-url", "blob-url", "remote-url"].includes(attachment.sourceType);
}

async function writeResponseBodyInChunks(relativeDir, attachmentPath, response) {
  if (!response.body?.getReader) {
    const blob = await response.blob();
    return writeBlobInChunks(relativeDir, attachmentPath, blob);
  }

  const reader = response.body.getReader();
  let bytesWritten = 0;
  let chunkIndex = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const bytes = value || new Uint8Array();
    for (let offset = 0; offset < bytes.length; offset += ATTACHMENT_CHUNK_BYTES) {
      const piece = bytes.slice(offset, offset + ATTACHMENT_CHUNK_BYTES);
      bytesWritten += piece.byteLength;
      if (bytesWritten > MAX_ATTACHMENT_BYTES) {
        throw new Error(`attachment too large: ${bytesWritten} bytes`);
      }
      await writeAttachmentChunkNative(relativeDir, attachmentPath, chunkIndex, bytesToBase64(piece));
      chunkIndex += 1;
    }
  }
  if (chunkIndex === 0) {
    await writeAttachmentChunkNative(relativeDir, attachmentPath, 0, "");
  }
  return bytesWritten;
}

async function writeBlobInChunks(relativeDir, attachmentPath, blob) {
  if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error(`attachment too large: ${blob.size} bytes`);
  let bytesWritten = 0;
  let chunkIndex = 0;
  for (let offset = 0; offset < blob.size; offset += ATTACHMENT_CHUNK_BYTES) {
    const slice = blob.slice(offset, offset + ATTACHMENT_CHUNK_BYTES);
    const buffer = await slice.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    bytesWritten += bytes.byteLength;
    await writeAttachmentChunkNative(relativeDir, attachmentPath, chunkIndex, bytesToBase64(bytes));
    chunkIndex += 1;
  }
  if (chunkIndex === 0) {
    await writeAttachmentChunkNative(relativeDir, attachmentPath, 0, "");
  }
  return bytesWritten;
}

async function writeBase64StringInChunks(relativeDir, attachmentPath, dataBase64) {
  let bytesWritten = 0;
  let chunkIndex = 0;
  const base64ChunkChars = Math.floor(ATTACHMENT_CHUNK_BYTES / 3) * 4;
  for (let offset = 0; offset < dataBase64.length; offset += base64ChunkChars) {
    const piece = dataBase64.slice(offset, offset + base64ChunkChars);
    bytesWritten += Math.floor((piece.length * 3) / 4);
    if (bytesWritten > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment too large: ${bytesWritten} bytes`);
    }
    await writeAttachmentChunkNative(relativeDir, attachmentPath, chunkIndex, piece);
    chunkIndex += 1;
  }
  if (chunkIndex === 0) {
    await writeAttachmentChunkNative(relativeDir, attachmentPath, 0, "");
  }
  return bytesWritten;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const slice = bytes.subarray(offset, offset + 0x8000);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
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
          maxWidth: "420px",
          padding: "12px 14px",
          borderRadius: "8px",
          boxShadow: "0 12px 30px rgba(0, 0, 0, 0.22)",
          background: error ? "#9f1d1d" : "#1f7a3f",
          color: "#fff",
          font: "13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          letterSpacing: "0",
          whiteSpace: "pre-wrap",
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
    // Chrome pages and browser-internal surfaces may block script injection.
  }
}

async function showActionBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
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
  lines.push(`saved_attachment_count: ${(session.savedAttachments || []).filter(item => item.status === "saved").length}`);
  lines.push("privacy: local-export-with-page-exposed-attachment-fetch");
  lines.push("---");
  lines.push("");
  lines.push(`# ${session.title || "Untitled Chatbot Session"}`);
  lines.push("");
  lines.push(`- Platform: ${session.platform.name}`);
  lines.push(`- URL: ${session.url}`);
  lines.push(`- Captured: ${session.capturedAt}`);
  lines.push(`- Capture mode: ${session.captureMode}`);
  lines.push("");
  lines.push("> Attachment note: this archive saves files only when the chatbot page exposes a data/blob/http(s) source. Original local files cannot be recovered if the page exposes only a filename or chip.");
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

  if (session.savedAttachments?.length) {
    lines.push("## Saved Attachment Files");
    lines.push("");
    session.savedAttachments.forEach(item => {
      const details = [`status=${item.status}`];
      if (item.path) details.push(`path=${item.path}`);
      if (item.bytes) details.push(`bytes=${item.bytes}`);
      if (item.reason) details.push(`reason=${item.reason}`);
      lines.push(`- ${item.label || "attachment"} (${details.join("; ")})`);
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
    attachmentCount: session.attachments.length,
    savedAttachments: session.savedAttachments || []
  }, null, 2));
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

function buildArchiveRelativeDir(session) {
  const platformFolder = platformFolderName(session.platform.id || "generic", session.platform.name || "Generic");
  const dateFolder = session.capturedAt.slice(0, 10) || "unknown-date";
  return `${platformFolder}/${dateFolder}/${buildBaseName(session)}`;
}

function buildBaseName(session) {
  const stamp = session.capturedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const title = slug(session.title || "chatbot-session").slice(0, 80) || "chatbot-session";
  const platform = slug(session.platform.id || "generic") || "generic";
  return `${stamp}_${platform}_${title}`;
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
  if (att.sourceType) details.push(`sourceType=${att.sourceType}`);
  if (att.source) details.push(`source=${shortenForMarkdown(att.source)}`);
  if (att.filename) details.push(`filename=${att.filename}`);
  if (att.byteSize) details.push(`bytes=${att.byteSize}`);
  if (att.inlineStatus) details.push(`inline=${att.inlineStatus}`);
  if (att.note) details.push(`note=${att.note}`);
  return `${label}${details.length ? ` (${details.join("; ")})` : ""}`;
}

function buildAttachmentManifest(session, savedAttachments) {
  const savedCount = savedAttachments.filter(item => item.status === "saved").length;
  const failedCount = savedAttachments.filter(item => item.status === "failed").length;
  return {
    source: "local-chatbot-session-archiver",
    capturedAt: session.capturedAt,
    platform: session.platform,
    url: session.url,
    totalRecords: session.attachments.length,
    savedCount,
    failedCount,
    skippedCount: savedAttachments.filter(item => item.status === "skipped").length,
    attachments: savedAttachments
  };
}

function buildAttachmentFilename(att, index) {
  const base = slug(att.filename || att.label || att.kind || `attachment-${index + 1}`).slice(0, 90) || `attachment-${index + 1}`;
  const extension = chooseAttachmentExtension(att, base);
  const withoutExtension = extension && base.toLowerCase().endsWith(extension) ? base.slice(0, -extension.length) : base;
  return `${String(index + 1).padStart(3, "0")}_${withoutExtension}${extension}`;
}

function chooseAttachmentExtension(att, base) {
  const existing = (base.match(/\.[a-z0-9]{1,8}$/i) || [""])[0].toLowerCase();
  if (existing) return existing;
  const mime = `${att.mimeType || ""}`.toLowerCase().split(";")[0];
  const known = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "application/json": ".json",
    "text/csv": ".csv",
    "application/zip": ".zip"
  };
  if (known[mime]) return known[mime];
  if (att.kind === "image") return ".png";
  return ".bin";
}

function shortenForMarkdown(source) {
  if (!source) return "";
  if (source.startsWith("data:")) return `${source.slice(0, 80)}...`;
  if (source.startsWith("blob:")) return `${source.slice(0, 120)}...`;
  return source.length > 240 ? `${source.slice(0, 240)}...` : source;
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
