(async () => {
  try {
    const platform = detectPlatform();
    const title = getTitle(platform);
    const url = location.href;
    const capturedAt = new Date().toISOString();
    const candidates = collectMessageCandidates(platform);
    const messages = normalizeMessages(candidates);
    const captureMode = messages.length >= 2 ? "message-candidates" : "main-text-fallback";
    const finalMessages = messages.length >= 2 ? messages : buildFallbackMessages();
    const captureWarnings = checkRoleCoverage(platform, finalMessages, captureMode);
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
      captureWarnings,
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
    // Google AI Mode lives on the normal Search host (www.google.com), so it
    // cannot be matched by hostname alone — that would also swallow ordinary
    // search. Gate on the AI Mode query param (udm=50), with the rendered AI
    // container as a secondary signal, and check it before the host rules.
    if (isGoogleAiMode(host)) {
      return { id: "google-ai-mode", name: "Google AI Mode", host };
    }
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

  function isGoogleAiMode(host) {
    // Restrict to Google Search hosts (www.google.com / google.com / country
    // TLDs like google.co.jp). Subdomain products such as gemini.google.com are
    // excluded so they keep routing to their own platform rule.
    const isGoogleSearchHost = /^(www\.)?google\.[a-z]{2,}(\.[a-z]{2,})?$/.test(host);
    if (!isGoogleSearchHost) return false;
    const params = new URLSearchParams(location.search);
    if (params.get("udm") === "50") return true;
    return Boolean(document.querySelector('[data-subtree="aimc"]'));
  }

  function getTitle(platform) {
    // Google AI Mode has no clean conversation heading (the first <h1> is often
    // hidden chrome), so derive the title from the search query instead.
    if (platform?.id === "google-ai-mode") {
      const query = new URLSearchParams(location.search).get("q");
      if (query) return cleanText(query).slice(0, 180);
    }
    // Gemini's only <h1> is the fixed, visually hidden "Conversation with
    // Gemini" label, so every archive got the same name; the real chat title
    // is in document.title ("<title> - Google Gemini").
    if (platform?.id === "gemini") {
      const fromTab = cleanText(document.title).replace(/\s+[-|]\s+(Google\s+)?Gemini\s*$/i, "");
      if (fromTab && !/^(Google\s+)?Gemini$/i.test(fromTab)) return fromTab.slice(0, 180);
    }
    const heading = textOf(document.querySelector("main h1, h1"));
    const raw = heading || document.title || "Untitled Chatbot Session";
    return cleanText(raw).replace(/\s+[-|].*$/, "").slice(0, 180);
  }

  // Google AI Mode renders its turns inside the Search results page, so the
  // generic selector list would pull in search chrome (tabs, "People also
  // ask", related searches). Use a dedicated, narrow pair instead:
  //   - user turns:  div.tbIZh.wQN2Jd.Odbbif  (the "You said:" bubble)
  //   - AI answers:  [data-subtree="aimc"]    (the answer body)
  // data-subtree is a semantic attribute and the most stable anchor; the
  // user-bubble utility classes are Google-internal and may need updating if
  // the AI Mode DOM is redesigned.
  //
  // These lists are functions, not top-level consts: the capture runs in the
  // try block at the top of this IIFE, *before* any const declared down here
  // is initialised, so a const would throw "Cannot access ... before
  // initialization" (temporal dead zone). Function declarations are hoisted.
  function googleAiModeSelectors() {
    return [
      "div.tbIZh.wQN2Jd.Odbbif",
      "[data-subtree='aimc']"
    ];
  }

  // ChatGPT renders one container per turn: <section data-turn="user|assistant"
  // data-testid="conversation-turn-N">. That container is the stable unit; the
  // inner [data-message-author-role] element is NOT reliable on its own — some
  // assistant turns render it inside display:contents wrappers (zero-size box,
  // which the generic isVisible() gate rejects) and the generic class-name
  // dedup can swallow it, leaving an archive with user turns but no assistant
  // turns. So ChatGPT is captured turn-by-turn,
  // role taken from the turn container, ordered by real DOM position.
  // (A function, not a const, for the same hoisting reason as
  // googleAiModeSelectors().)
  function chatGptTurnSelector() {
    return [
      "[data-testid^='conversation-turn']",
      "section[data-turn]",
      "article[data-turn]"
    ].join(", ");
  }

  function collectChatGptTurns(platform) {
    let turns = Array.from(document.querySelectorAll(chatGptTurnSelector()));
    if (!turns.length) turns = Array.from(document.querySelectorAll("[data-message-author-role]"));
    turns = outermostOnly(turns);
    const items = [];
    turns.forEach((turn, index) => {
      if (isHiddenSubtree(turn)) return;
      const role = chatGptTurnRole(turn, platform);
      const content = chatGptTurnText(turn);
      const attachments = collectAttachments(turn);
      if (!content && !attachments.length) return;
      items.push({
        element: turn,
        role,
        content,
        attachments,
        selector: "chatgpt-turn",
        turnKey: turn.getAttribute("data-turn-id") || turn.getAttribute("data-testid") || `turn-${index}`,
        order: index
      });
    });
    return items.sort((a, b) => compareDomOrder(a.element, b.element));
  }

  // Gemini renders each turn as a custom element: <user-query> for the prompt
  // and <model-response> for the reply, both inside one
  // div.conversation-container per exchange. That container's class list
  // contains "message-actions-hover-boundary", so the generic
  // [class*='message'] selector matched the whole exchange and dedup then
  // dropped the inner turns: archives came out as one role-less "message"
  // per exchange with prompt and reply run together. So Gemini, like
  // ChatGPT, is captured turn-by-turn from the custom elements.
  function collectGeminiTurns() {
    const turns = outermostOnly(Array.from(document.querySelectorAll("user-query, model-response")));
    const items = [];
    turns.forEach((turn, index) => {
      if (isHiddenSubtree(turn)) return;
      const role = turn.tagName.toLowerCase() === "user-query" ? "user" : "assistant";
      const content = role === "user" ? geminiUserText(turn) : geminiAssistantText(turn);
      const attachments = collectAttachments(turn);
      if (!content && !attachments.length) return;
      const exchange = turn.closest(".conversation-container");
      items.push({
        element: turn,
        role,
        content,
        attachments,
        selector: "gemini-turn",
        turnKey: `${exchange?.id || "x"}:${role}:${index}`,
        order: index
      });
    });
    return items.sort((a, b) => compareDomOrder(a.element, b.element));
  }

  function geminiUserText(turn) {
    // The prompt bubble also holds a screen-reader "You said" label; the
    // prompt itself is one p.query-text-line per line.
    const lines = Array.from(turn.querySelectorAll(".query-text-line"));
    if (lines.length) return cleanText(lines.map(line => line.innerText || line.textContent || "").join("\n"));
    const body = turn.querySelector(".query-text") || turn;
    return readableText(body).replace(/^You said\s*:?\s*/i, "");
  }

  function geminiAssistantText(turn) {
    // message-content holds the answer only (no "Gemini said" label, no
    // thinking panel, no action bar). Text is rebuilt from the DOM structure
    // rather than innerText: Gemini skips layout for turns scrolled out of
    // view, and innerText of an unlaid-out subtree has no line breaks, so
    // older answers came out as one run-on paragraph. Inline source chips
    // ("Coursera + 1") are skipped while walking.
    const bodies = outermostOnly(Array.from(turn.querySelectorAll("message-content")));
    if (!bodies.length) return readableText(turn).replace(/^Gemini said\s*/i, "");
    return bodies
      .map(body => structuredText(body, "source-inline-chip, sources-carousel-inline, source-footnote, button, mat-icon, .cdk-visually-hidden"))
      .filter(Boolean)
      .join("\n\n");
  }

  function isNotShownText(element) {
    // Walking the DOM (unlike innerText) also reaches text that is never
    // painted: display:none parts and screen-reader-only labels (Gemini step
    // cards carry a hidden "1.<title>:<subtitle>." line that duplicated every
    // step heading). Computed style is available even where layout is skipped.
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return true;
    if (style.position !== "absolute" && style.position !== "fixed") return false;
    if (/rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(style.clip)) return true;
    if (/inset\(50%\)/.test(style.clipPath)) return true;
    return parseFloat(style.width) <= 1 && parseFloat(style.height) <= 1 && style.overflow === "hidden";
  }

  function structuredText(root, skipSelector) {
    // Layout-independent text: paragraphs/headings/lists/tables/code become
    // line breaks from the tag structure, so the result is the same whether
    // or not the browser has laid the subtree out.
    const PARA = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "PRE", "TABLE", "BLOCKQUOTE", "HR"]);
    const LINE = new Set(["DIV", "LI", "TR", "SECTION", "ARTICLE", "HEADER", "FOOTER", "DT", "DD"]);
    let out = "";
    // Code blocks are kept verbatim (indentation matters) and spliced back in
    // after the whitespace cleanup below.
    const verbatim = [];
    const walk = (node, inPre) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += inPre ? node.nodeValue : node.nodeValue.replace(/\s+/g, " ");
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (skipSelector && node.matches(skipSelector)) return;
      if (isNotShownText(node)) return;
      const tag = node.tagName;
      if (tag === "BR") { out += "\n"; return; }
      if (tag === "STYLE" || tag === "SCRIPT" || tag === "TEMPLATE") return;
      const sep = PARA.has(tag) ? "\n\n" : LINE.has(tag) ? "\n" : "";
      out += sep;
      if (tag === "LI") {
        const list = node.parentElement;
        if (list && list.tagName === "OL") {
          const index = Array.from(list.children).filter(child => child.tagName === "LI").indexOf(node);
          out += `${(Number(list.getAttribute("start")) || 1) + index}. `;
        } else {
          out += "- ";
        }
      }
      if (tag === "TD" || tag === "TH") out += " | ";
      if (tag === "PRE" && !inPre) {
        verbatim.push(node.textContent.replace(/\n+$/, ""));
        out += `\u0000${verbatim.length - 1}\u0000${sep}`;
        return;
      }
      node.childNodes.forEach(child => walk(child, inPre));
      out += sep;
    };
    walk(root, false);
    return out
      .split("\n")
      .map(line => line.replace(/^[ \t]+(?=- |\d+\. )/, "").replace(/[ \t]+$/, "").replace(/^ +/, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      // A list item whose body is a <p> leaves its marker alone on a line
      // ("1." then the text); join them back.
      .replace(/(^|\n)(-|\d+\.)\n+/g, "$1$2 ")
      .trim()
      .replace(/\u0000(\d+)\u0000/g, (_, i) => verbatim[Number(i)]);
  }

  function chatGptTurnRole(turn, platform) {
    const turnRole = turn.getAttribute("data-turn") || turn.getAttribute("data-message-author-role");
    if (turnRole) return normalizeRole(turnRole);
    return inferRole(turn, platform);
  }

  function chatGptTurnText(turn) {
    // Prefer the role-tagged message bodies: they exclude per-turn chrome such
    // as "Worked for 11s", source chips and action buttons. A turn can hold
    // several bodies (tool call + final answer), so join all of them.
    const bodies = turn.matches("[data-message-author-role]")
      ? [turn]
      : outermostOnly(Array.from(turn.querySelectorAll("[data-message-author-role]")));
    const fromBodies = bodies.map(readableText).filter(Boolean).join("\n\n");
    return fromBodies || readableText(turn);
  }

  function readableText(element) {
    // innerText is "" / textContent-like for elements without a layout box
    // (display:contents); fall back to textContent so such turns still yield
    // their words instead of being dropped as empty.
    return cleanText(element.innerText || "") || cleanText(element.textContent || "");
  }

  function outermostOnly(elements) {
    return elements.filter(el => !elements.some(other => other !== el && other.contains(el)));
  }

  function isHiddenSubtree(element) {
    // Unlike isVisible(), do not require a non-zero box: display:contents
    // containers have none yet render their children normally.
    // aria-hidden is deliberately ignored: apps set it on the whole thread
    // while a modal is open, which must not empty the archive.
    if (element.closest("[hidden]")) return true;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return true;
    if (style.display === "contents") return false;
    const rect = element.getBoundingClientRect();
    return rect.width === 0 && rect.height === 0 && !element.textContent.trim();
  }

  function checkRoleCoverage(platform, messages, captureMode) {
    // Invariant: a chat with assistant replies on screen must archive assistant
    // turns. When it does not, the archive is silently half-empty — say so in
    // the output instead of reporting a normal save.
    const warnings = [];
    const capturedAssistant = messages.filter(m => m.role === "assistant").length;
    const capturedUser = messages.filter(m => m.role === "user").length;
    const domAssistant = document.querySelectorAll(
      "[data-message-author-role='assistant'], [data-turn='assistant'], model-response"
    ).length;
    if (domAssistant > 0 && capturedAssistant === 0) {
      warnings.push(`role-coverage: the page shows ${domAssistant} assistant marker(s) but 0 assistant turns were captured; the capture selectors are probably out of date for ${platform.name}.`);
    } else if (platform.id !== "generic" && captureMode === "message-candidates" && capturedUser >= 2 && capturedAssistant === 0) {
      warnings.push(`role-coverage: captured ${capturedUser} user turns and 0 assistant turns on ${platform.name}; assistant replies were probably missed.`);
    }
    return warnings;
  }

  function collectMessageCandidates(platform) {
    if (platform.id === "chatgpt") {
      const turns = collectChatGptTurns(platform);
      if (turns.length) return turns;
    }
    if (platform.id === "gemini") {
      const turns = collectGeminiTurns();
      if (turns.length) return turns;
    }
    const isAiMode = platform.id === "google-ai-mode";
    const selectors = isAiMode ? googleAiModeSelectors() : [
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
        const role = inferRole(element, platform);
        let content = cleanText(element.innerText || element.textContent || "");
        if (isAiMode) content = cleanAiModeContent(role, content);
        const attachments = collectAttachments(attachmentScope(element));
        // AI Mode elements come from trusted, narrow selectors, so any non-empty
        // turn is real — bypass the generic min-length gate that would otherwise
        // drop short queries like "千问 4折".
        const useful = isAiMode
          ? (content.length > 0 || attachments.length > 0)
          : isUsefulMessage(content, attachments);
        if (!useful) return;
        items.push({
          element,
          role,
          content,
          attachments,
          selector,
          order: documentPositionScore(element)
        });
      });
    });

    const deduped = removeContainerDuplicates(items);
    // The generic sibling-count score (documentPositionScore) is only
    // comparable between elements that share the same parent chain. Google AI
    // Mode mixes two element types living at different DOM depths (the answer
    // body vs the question bubble), so order by true document position instead.
    if (isAiMode) {
      return deduped.sort((a, b) => compareDomOrder(a.element, b.element));
    }
    return deduped.sort((a, b) => a.order - b.order);
  }

  function compareDomOrder(a, b) {
    if (!a || !b || a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function cleanAiModeContent(role, content) {
    // The user bubble text is prefixed with a "You said:" marker and suffixed
    // with a timestamp (e.g. "9:40 pm"). When the user pastes a link, Google
    // echoes the linked page's title above the real prompt, followed by its own
    // "You said:" marker — so the actual prompt is whatever follows the marker.
    if (role !== "user") return content;
    return content
      // Echoed link-card title sits on a single line above the real marker;
      // [^\n]* (not [\s\S]*?) keeps the strip to that one line so a legitimate
      // multi-line prompt that merely happens to contain "You said:" survives.
      .replace(/^[^\n]*\nYou said:\s*/i, "")
      .replace(/^You said:\s*/i, "")
      // The timestamp is always alone on the final line, so require the leading
      // newline — otherwise a prompt ending in a time ("…meeting at 9:40 pm")
      // would be truncated.
      .replace(/\n\d{1,2}:\d{2}\s*(?:am|pm)\s*$/i, "")
      .trim();
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
      // Items that carry a turn identity (ChatGPT turn containers) are distinct
      // by construction; two identical short prompts ("你看看" twice) are two
      // real turns, so only fall back to content dedup without that identity.
      const key = item.turnKey ? `turn:${item.turnKey}` : `${item.role}\n${item.content}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (!item.turnKey && out.length && out[out.length - 1].content === item.content) return;
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
    if (platform.id === "google-ai-mode") {
      if (element.matches("[data-subtree='aimc']")) return "assistant";
      if (/^You said:/.test((element.innerText || "").trim())) return "user";
      if (element.matches("div.tbIZh")) return "user";
    }

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
