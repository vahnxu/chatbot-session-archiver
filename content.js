(async () => {
  try {
    const platform = detectPlatform();
    const title = getTitle();
    const url = location.href;
    const capturedAt = new Date().toISOString();
    const candidates = collectMessageCandidates(platform);
    const messages = normalizeMessages(candidates);
    const captureMode = messages.length >= 2 ? "message-candidates" : "main-text-fallback";
    const finalMessages = messages.length >= 2 ? messages : buildFallbackMessages();
    const allAttachments = finalMessages.flatMap(message => message.attachments || []);
    await hydrateInlineAttachmentData(allAttachments);
    const attachments = uniqueAttachments(allAttachments);

    return {
      ok: true,
      platform,
      title,
      url,
      capturedAt,
      captureMode,
      messages: finalMessages,
      attachments
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error)
    };
  }

  function detectPlatform() {
    const host = location.hostname;
    const rules = [
      ["chatgpt", "ChatGPT", ["chatgpt.com", "chat.openai.com"]],
      ["claude", "Claude", ["claude.ai"]],
      ["gemini", "Gemini", ["gemini.google.com"]],
      ["deepseek", "DeepSeek", ["chat.deepseek.com"]],
      ["kimi", "Kimi", ["kimi.moonshot.cn", "kimi.com"]],
      ["doubao", "Doubao", ["www.doubao.com", "doubao.com"]],
      ["perplexity", "Perplexity", ["www.perplexity.ai", "perplexity.ai"]],
      ["grok", "Grok", ["grok.com"]],
      ["qianwen", "Qianwen", ["www.qianwen.com", "qianwen.com"]],
      ["poe", "Poe", ["poe.com"]],
      ["copilot", "Copilot", ["copilot.microsoft.com"]],
      ["mistral", "Mistral", ["chat.mistral.ai"]]
    ];
    const found = rules.find(([, , hosts]) => hosts.some(item => host === item || host.endsWith(`.${item}`)));
    return found ? { id: found[0], name: found[1], host } : { id: "generic", name: "Generic Chatbot", host };
  }

  function getTitle() {
    const heading = textOf(document.querySelector("main h1, h1"));
    const raw = heading || document.title || "Untitled Chatbot Session";
    return cleanText(raw).replace(/\s+[-|].*$/, "").slice(0, 180);
  }

  function collectMessageCandidates(platform) {
    const selectors = [
      "[data-message-author-role]",
      "[data-testid*='conversation-turn']",
      "[data-testid*='message']",
      "div.font-claude-response",
      "div.font-claude-message",
      "[class*='claude-response']",
      "[class*='claude-message']",
      "article",
      "user-query",
      "model-response",
      "message-content",
      "[class*='message']",
      "[class*='Message']",
      "[class*='conversation'] [role='listitem']",
      "main [role='listitem']",
      "main [data-index]"
    ];

    const seen = new Set();
    const items = [];
    selectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(element => {
        if (seen.has(element) || !isVisible(element)) return;
        seen.add(element);
        const content = cleanText(element.innerText || element.textContent || "");
        const attachments = collectAttachments(attachmentScope(element));
        if (!isUsefulMessage(content, attachments)) return;
        items.push({
          element,
          role: inferRole(element, platform),
          content,
          attachments,
          selector,
          order: documentPositionScore(element)
        });
      });
    });

    return removeContainerDuplicates(items).sort((a, b) => a.order - b.order);
  }

  function attachmentScope(element) {
    // Some sites (Claude) render attachments as siblings of the text bubble,
    // outside the matched message element. Widen the scope to the closest
    // turn-level container so sibling attachments are picked up. Falls back
    // to the element itself when no wider container exists.
    return (
      element.closest("[data-test-render-count]") ||
      element.closest("[data-message-author-role]") ||
      element.closest("[data-testid*='conversation-turn']") ||
      element.closest("article") ||
      element
    );
  }

  function normalizeMessages(items) {
    const out = [];
    const seen = new Set();

    items.forEach(item => {
      const key = `${item.role}\n${item.content}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (out.length && out[out.length - 1].content === item.content) return;
      out.push({
        role: item.role,
        content: collapseInternalRepeats(item.content),
        attachments: item.attachments
      });
    });

    return out;
  }

  function collapseInternalRepeats(text) {
    // Some chatbots (Claude) render a thinking-summary line both as a
    // collapsed-button label and as the leading sentence of the expanded body,
    // so innerText emits the same line twice in a row, separated by a single
    // newline. Collapse adjacent line repeats while preserving blank lines so
    // paragraph boundaries survive.
    const lines = `${text}`.split("\n");
    const out = [];
    let lastSig = null;
    for (const line of lines) {
      const sig = line.trim();
      if (sig && sig === lastSig) continue;
      out.push(line);
      lastSig = sig;
    }
    return out.join("\n");
  }

  function buildFallbackMessages() {
    const root = document.querySelector("main") || document.body;
    const content = cleanText(root?.innerText || document.body.innerText || "");
    const attachments = collectAttachments(root || document.body);
    return [{
      role: "page",
      content: content || "_No readable page text found._",
      attachments
    }];
  }

  function removeContainerDuplicates(items) {
    return items.filter((item, index) => {
      const current = item.content;
      // Drop fragments whose DOM element is a descendant of another candidate's
      // element AND whose text appears inside that other candidate's text.
      // Catches Claude's collapsed thinking-summary buttons that re-emit text
      // already present in the surrounding response container, regardless of
      // length.
      const nestedInsideOther = items.some((other, otherIndex) => {
        if (index === otherIndex) return false;
        if (!item.element || !other.element) return false;
        if (!other.element.contains(item.element)) return false;
        if (other.element === item.element) return false;
        return other.content.includes(current);
      });
      if (nestedInsideOther) return false;
      // Original heuristic for non-nested duplicates (e.g. one selector matched
      // the message container, another matched a near-identical sibling).
      if (current.length < 40) return true;
      return !items.some((other, otherIndex) => {
        if (index === otherIndex) return false;
        if (other.content.length <= current.length) return false;
        return other.content.includes(current) && other.content.length - current.length < 800;
      });
    });
  }

  function inferRole(element, platform) {
    const directRole = element.getAttribute("data-message-author-role");
    if (directRole) return normalizeRole(directRole);

    // Turn-level containers (e.g. ChatGPT <article>) often survive dedup in
    // place of the inner role-tagged element. When every role-tagged
    // descendant agrees, inherit that role instead of guessing from class
    // names, which mislabels user turns as assistant.
    const descendantRoles = Array.from(
      element.querySelectorAll("[data-message-author-role]")
    ).map(el => el.getAttribute("data-message-author-role"));
    if (descendantRoles.length && descendantRoles.every(r => r === descendantRoles[0])) {
      return normalizeRole(descendantRoles[0]);
    }

    const tag = element.tagName.toLowerCase();
    if (tag === "user-query") return "user";
    if (tag === "model-response") return "assistant";

    const attrs = [
      element.getAttribute("data-testid"),
      element.getAttribute("aria-label"),
      element.getAttribute("data-author"),
      element.className
    ].join(" ").toLowerCase();

    if (/font-claude-(response|message)/.test(attrs)) return "assistant";
    if (/\b(user|human|prompt|question|you|me)\b/.test(attrs)) return "user";
    if (/\b(assistant|model|response|answer|bot|ai|claude|gemini|chatgpt)\b/.test(attrs)) return "assistant";
    if (platform.id === "perplexity" && /\banswer\b/.test(attrs)) return "assistant";
    return "message";
  }

  function normalizeRole(role) {
    const value = `${role}`.toLowerCase();
    if (value.includes("user") || value.includes("human")) return "user";
    if (value.includes("assistant") || value.includes("model") || value.includes("bot")) return "assistant";
    if (value.includes("system")) return "system";
    return value || "message";
  }

  function collectAttachments(root) {
    const attachments = [];

    root.querySelectorAll("img").forEach(img => {
      if (!isVisible(img)) return;
      const src = img.currentSrc || img.src || "";
      const alt = cleanText(img.alt || img.getAttribute("aria-label") || img.title || "image");
      if (!src && !alt) return;
      if (!shouldCaptureImage(img, alt, src)) return;
      attachments.push({
        kind: "image",
        label: alt || "image",
        source: src,
        sourceType: classifySource(src),
        filename: filenameFromSource(src, alt),
        mimeType: mimeTypeFromSource(src),
        note: `${img.naturalWidth || img.width || 0}x${img.naturalHeight || img.height || 0}`
      });
    });

    root.querySelectorAll("a, [download]").forEach(link => {
      const href = link.href || link.getAttribute("href") || "";
      const label = cleanText(link.innerText || link.getAttribute("download") || link.title || href);
      if (!href && !looksLikeFileName(label)) return;
      if (!looksLikeAttachment(label, href)) return;
      attachments.push({
        kind: "link",
        label: label || "link",
        source: href,
        sourceType: classifySource(href),
        filename: cleanText(link.getAttribute("download") || filenameFromSource(href, label)),
        mimeType: mimeTypeFromSource(href),
        note: link.getAttribute("download") ? "downloadable" : ""
      });
    });

    root.querySelectorAll("[aria-label], [title]").forEach(el => {
      const label = cleanText([el.getAttribute("aria-label"), el.getAttribute("title"), el.innerText].filter(Boolean).join(" "));
      if (!looksLikeAttachment(label, "")) return;
      attachments.push({
        kind: "visible-attachment",
        label,
        source: "",
        note: "visible page metadata"
      });
    });

    const text = root.innerText || "";
    const fileMatches = text.match(/[\w .()\-\u4e00-\u9fff]+\.(?:pdf|png|jpe?g|webp|gif|csv|xlsx?|docx?|pptx?|txt|md|json|zip|py|js|ts|tsx|html|css|heic|mov|mp4)/gi) || [];
    fileMatches.slice(0, 40).forEach(name => {
      attachments.push({
        kind: "filename",
        label: cleanText(name),
        source: "",
        note: "filename visible in transcript"
      });
    });

    return uniqueAttachments(attachments);
  }

  function uniqueAttachments(attachments) {
    const seen = new Set();
    const out = [];
    attachments.forEach(item => {
      const key = `${item.kind}|${item.label}|${item.source}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(item);
    });
    return out;
  }

  function looksLikeAttachment(label, href) {
    const text = `${label} ${href}`.toLowerCase();
    return /attachment|uploaded|file|image|download|pdf|png|jpe?g|webp|gif|csv|xlsx?|docx?|pptx?|txt|md|json|zip|heic|mov|mp4/.test(text);
  }

  function looksLikeFileName(text) {
    return /\.(?:pdf|png|jpe?g|webp|gif|csv|xlsx?|docx?|pptx?|txt|md|json|zip|py|js|ts|tsx|html|css|heic|mov|mp4)\b/i.test(text || "");
  }

  function isUsefulMessage(content, attachments) {
    if (attachments.length) return true;
    if (content.length < 12) return false;
    if (content.length > 60000) return false;
    const lower = content.toLowerCase();
    if (/^(new chat|search|settings|upgrade|log in|sign up)$/.test(lower)) return false;
    return true;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function documentPositionScore(element) {
    let score = 0;
    let node = element;
    while (node && node.previousElementSibling) {
      score += 1;
      node = node.previousElementSibling;
    }
    const rect = element.getBoundingClientRect();
    return score * 100000 + Math.round(rect.top + window.scrollY);
  }

  function textOf(element) {
    return element ? cleanText(element.innerText || element.textContent || "") : "";
  }

  function cleanText(text) {
    return `${text || ""}`
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  async function hydrateInlineAttachmentData(attachments) {
    const seen = new Set();
    for (const attachment of attachments) {
      if (!attachment?.source || !["data-url", "blob-url"].includes(attachment.sourceType)) continue;
      if (seen.has(attachment.source)) continue;
      seen.add(attachment.source);
      try {
        const response = await fetch(attachment.source);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        attachment.byteSize = blob.size;
        attachment.mimeType = attachment.mimeType || blob.type || "";
        if (blob.size > 25 * 1024 * 1024) {
          attachment.inlineStatus = "skipped-too-large-for-page-inline";
          continue;
        }
        attachment.inlineDataBase64 = await blobToBase64(blob);
        attachment.inlineStatus = "captured-in-page";
      } catch (error) {
        attachment.inlineStatus = `capture-failed: ${error?.message || error}`;
      }
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = `${reader.result || ""}`;
        resolve(result.includes(",") ? result.split(",", 2)[1] : result);
      };
      reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
      reader.readAsDataURL(blob);
    });
  }

  function shouldCaptureImage(img, alt, src) {
    if (looksLikeAttachment(alt, src)) return true;
    const rect = img.getBoundingClientRect();
    const width = img.naturalWidth || img.width || rect.width || 0;
    const height = img.naturalHeight || img.height || rect.height || 0;
    if (!src) return false;
    if (src.startsWith("data:") || src.startsWith("blob:")) return width >= 24 && height >= 24;
    return width >= 72 && height >= 72;
  }

  function classifySource(source) {
    if (!source) return "";
    if (source.startsWith("data:")) return "data-url";
    if (source.startsWith("blob:")) return "blob-url";
    if (/^https?:\/\//i.test(source)) return "remote-url";
    if (source.startsWith("file:")) return "browser-file-url";
    return "other";
  }

  function filenameFromSource(source, fallback) {
    const fallbackName = cleanText(fallback || "attachment");
    try {
      if (source?.startsWith("data:")) {
        const mime = source.slice(5, source.indexOf(";") > 0 ? source.indexOf(";") : undefined);
        return `${fallbackName || "image"}${extensionFromMime(mime)}`;
      }
      if (!source || source.startsWith("blob:")) return fallbackName;
      const url = new URL(source, location.href);
      const pathName = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
      return pathName || fallbackName;
    } catch {
      return fallbackName;
    }
  }

  function mimeTypeFromSource(source) {
    if (!source?.startsWith("data:")) return "";
    const match = source.match(/^data:([^;,]+)/);
    return match ? match[1] : "";
  }

  function extensionFromMime(mime) {
    const known = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "application/pdf": ".pdf",
      "text/plain": ".txt",
      "text/markdown": ".md",
      "application/json": ".json"
    };
    return known[(mime || "").toLowerCase()] || "";
  }
})();
