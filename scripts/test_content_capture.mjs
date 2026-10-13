#!/usr/bin/env node
// Behaviour test for content.js role capture, run in a real Chrome page.
//
// Invariant under test: a ChatGPT or Gemini conversation that shows assistant
// replies archives them as assistant turns, in page order, without merging
// repeated prompts. If the page does show assistant replies and none are captured, the
// capture must carry a role-coverage warning instead of looking like a normal
// save.
//
// How it runs: connects to an already-running Chrome with remote debugging
// (default http://127.0.0.1:9222, override with CDP_URL). It never launches a
// browser. It opens one blank tab, answers a request to
// https://<platform host>/__csa_fixture__/... from a local fixture file via the
// CDP Fetch domain (nothing goes to the network, but the page hostname is the
// real platform host so platform detection is exercised), injects content.js, checks
// the result, and closes the tab it opened.
//
// Usage:
//   node scripts/test_content_capture.mjs            # run against ./content.js
//   node scripts/test_content_capture.mjs path.js    # run against another copy
// Exit codes: 0 all pass, 1 assertion failed, 2 could not run (no CDP).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const contentPath = path.resolve(process.argv[2] || path.join(root, "content.js"));
const cdpBase = process.env.CDP_URL || "http://127.0.0.1:9222";
const fixtureDir = path.join(here, "fixtures");

const CASES = [
  {
    name: "gemini exchanges split into user/assistant turns, chips and labels stripped",
    fixture: "gemini_turns.html",
    host: "gemini.google.com",
    platform: "gemini",
    check(result, fail) {
      const roles = result.messages.map(m => m.role).join(",");
      const want = "user,assistant,user,assistant,user,assistant,user,assistant";
      if (roles !== want) fail(`roles ${roles} != ${want}`);
      const [u1, a1, , a4] = result.messages;
      const off = "Offscreen heading\n\nOffscreen paragraph.\n\n1. first step\n\n2. second step\n\ndef f():\n    return 1";
      if (a4 && a4.content !== off) fail(`unlaid-out answer lost its line structure: ${JSON.stringify(a4.content)}`);
      if (u1 && u1.content !== "Explain the fixture handshake\nin two lines") fail(`user 1 text ${JSON.stringify(u1.content)}`);
      if (a1 && !a1.content.includes("Fixture reply one") ) fail("assistant 1 text missing");
      if (a1 && /Gemini said|Coursera|\+ 1|Copy/.test(a1.content)) fail(`assistant 1 kept chrome/chips: ${JSON.stringify(a1.content)}`);
      if (result.title !== "Fixture handshake chat") fail(`title ${JSON.stringify(result.title)}`);
      const repeats = result.messages.filter(m => m.content === "again").length;
      if (repeats !== 2) fail(`two identical prompts must stay two turns, got ${repeats}`);
      if ((result.captureWarnings || []).length) fail(`unexpected warnings: ${result.captureWarnings.join(" | ")}`);
    }
  },
  {
    name: "chatgpt turns incl. display:contents and role-less assistant bodies",
    fixture: "chatgpt_turns.html",
    check(result, fail) {
      const roles = result.messages.map(m => m.role).join(",");
      const want = "user,assistant,user,assistant,user,assistant";
      if (roles !== want) fail(`roles ${roles} != ${want}`);
      const a = result.messages.filter(m => m.role === "assistant");
      if (a.length !== 3) fail(`expected 3 assistant turns, got ${a.length}`);
      if (a[0] && !a[0].content.includes("Fixture answer one")) fail("assistant 1 text missing (display:contents body)");
      if (a[0] && /Worked for/.test(a[0].content)) fail("assistant 1 kept per-turn chrome 'Worked for'");
      if (a[1] && !a[1].content.includes("Fixture answer two")) fail("assistant 2 text missing (no role attribute)");
      const repeats = result.messages.filter(m => m.content === "look again").length;
      if (repeats !== 2) fail(`two identical prompts must stay two turns, got ${repeats}`);
      if ((result.captureWarnings || []).length) fail(`unexpected warnings: ${result.captureWarnings.join(" | ")}`);
    }
  },
  {
    name: "assistant replies present on page but not capturable -> warning",
    fixture: "chatgpt_assistant_missing.html",
    check(result, fail) {
      const a = result.messages.filter(m => m.role === "assistant").length;
      if (a !== 0) fail(`fixture should yield 0 assistant turns, got ${a}`);
      const w = (result.captureWarnings || []).join(" ");
      if (!/role-coverage/.test(w)) fail("missing role-coverage warning for a page with assistant markers");
    }
  }
];

async function main() {
  let version;
  try {
    const res = await fetch(`${cdpBase}/json/version`);
    version = await res.json();
  } catch (error) {
    console.error(`CANNOT RUN: no Chrome remote-debugging endpoint at ${cdpBase} (${error.message}). Start Chrome-Debug yourself; this test never launches a browser.`);
    process.exit(2);
  }
  const source = fs.readFileSync(contentPath, "utf8").trim().replace(/;\s*$/, "");
  const cdp = await connect(version.webSocketDebuggerUrl);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", background: true });
  let failures = 0;
  try {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const hosts = [...new Set(CASES.map(c => c.host || "chatgpt.com"))];
    await cdp.send("Fetch.enable", { patterns: hosts.map(h => ({ urlPattern: `https://${h}/__csa_fixture__/*` })) }, sessionId);
    cdp.on("Fetch.requestPaused", async (params, sid) => {
      if (sid !== sessionId) return;
      const name = decodeURIComponent(new URL(params.request.url).pathname.split("/").pop());
      const file = path.join(fixtureDir, path.basename(name));
      const body = Buffer.from(fs.readFileSync(file)).toString("base64");
      await cdp.send("Fetch.fulfillRequest", {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
        body
      }, sessionId);
    });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);

    for (const testCase of CASES) {
      const loaded = cdp.once("Page.loadEventFired", sessionId);
      await cdp.send("Page.navigate", { url: `https://${testCase.host || "chatgpt.com"}/__csa_fixture__/${testCase.fixture}` }, sessionId);
      await loaded;
      const evaluation = await cdp.send("Runtime.evaluate", {
        expression: `(${source}).then(r => JSON.stringify(r))`,
        awaitPromise: true,
        returnByValue: true
      }, sessionId);
      const raw = evaluation.result?.value;
      const result = raw ? JSON.parse(raw) : { ok: false, error: JSON.stringify(evaluation.exceptionDetails || evaluation) };
      const problems = [];
      if (!result.ok) problems.push(`capture failed: ${result.error}`);
      else if (result.platform?.id !== (testCase.platform || "chatgpt")) problems.push(`platform ${result.platform?.id} != ${testCase.platform || "chatgpt"}`);
      else testCase.check(result, msg => problems.push(msg));
      if (problems.length) {
        failures += 1;
        console.log(`FAIL ${testCase.name}`);
        problems.forEach(p => console.log(`  - ${p}`));
      } else {
        console.log(`PASS ${testCase.name}`);
      }
    }
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    cdp.close();
  }
  console.log(failures ? `${failures} case(s) failed` : "all cases passed");
  process.exit(failures ? 1 : 0);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    const listeners = [];
    ws.onerror = event => reject(new Error(event.message || "websocket error"));
    ws.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: bad } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) bad(new Error(msg.error.message));
        else ok(msg.result);
        return;
      }
      listeners.filter(l => l.method === msg.method).forEach(l => l.fn(msg.params, msg.sessionId));
    };
    ws.onopen = () => resolve({
      send(method, params = {}, sessionId) {
        const id = nextId++;
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        return new Promise((ok, bad) => pending.set(id, { resolve: ok, reject: bad }));
      },
      on(method, fn) {
        listeners.push({ method, fn });
      },
      once(method, sessionId) {
        return new Promise(ok => {
          const entry = { method, fn: (params, sid) => {
            if (sessionId && sid !== sessionId) return;
            listeners.splice(listeners.indexOf(entry), 1);
            ok(params);
          } };
          listeners.push(entry);
        });
      },
      close() {
        ws.close();
      }
    });
  });
}

main().catch(error => {
  console.error(`CANNOT RUN: ${error.stack || error}`);
  process.exit(2);
});
