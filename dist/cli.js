#!/usr/bin/env node

// src/app.ts
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// src/cdp.ts
var DEFAULT_PORT = 9333;
function cdpPort() {
  const n = Number(process.env.GROKBOT_CDP_PORT || DEFAULT_PORT);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new Error(`Invalid GROKBOT_CDP_PORT: ${process.env.GROKBOT_CDP_PORT}`);
  return n;
}
async function listTargets(port = cdpPort()) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    return await res.json();
  } catch {
    return null;
  }
}

class NotConnectedError extends Error {
  constructor(port) {
    super(`Grok Bot isn't reachable on debug port ${port}. Run \`grokbot launch\` first.`);
    this.name = "NotConnectedError";
  }
}

class CDP {
  ws;
  nextId = 0;
  pending = new Map;
  bindings = new Map;
  constructor(ws) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.method === "Runtime.bindingCalled")
        return this.bindings.get(msg.params.name)?.(msg.params.payload);
      const p = msg.id ? this.pending.get(msg.id) : undefined;
      if (!p)
        return;
      this.pending.delete(msg.id);
      if (msg.error)
        p.reject(new Error(msg.error.message));
      else
        p.resolve(msg.result);
    });
    ws.addEventListener("close", () => {
      for (const p of this.pending.values())
        p.reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }
  static async connect(port = cdpPort()) {
    const targets = await listTargets(port);
    if (!targets)
      throw new NotConnectedError(port);
    const page = targets.find((t) => t.type === "page" && /app\.asar|\/renderer\/index\.html/.test(t.url));
    if (!page)
      throw new Error(`Debug port ${port} is open, but no Grok Bot window was found on it.`);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("Could not open the CDP websocket")), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  call(fn, ...args) {
    return this.eval(`(${fn})(...${JSON.stringify(args)})`);
  }
  async bind(fn) {
    const name = `__grokbot_${process.pid}_${this.bindings.size}`;
    this.bindings.set(name, fn);
    await this.send("Runtime.addBinding", { name });
    return name;
  }
  close() {
    this.ws.close();
  }
}

// src/app.ts
var run = promisify(execFile);
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var PROCESS_NAME = "Grok Bot";
function appCandidates() {
  if (process.env.GROKBOT_APP)
    return [process.env.GROKBOT_APP];
  switch (process.platform) {
    case "darwin":
      return ["/Applications/Grok Bot.app", join(homedir(), "Applications/Grok Bot.app")];
    case "win32": {
      const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local");
      return [join(local, "Programs/Grok Bot/Grok Bot.exe"), join(process.env.ProgramFiles ?? "C:/Program Files", "Grok Bot/Grok Bot.exe")];
    }
    default:
      return ["/opt/Grok Bot/grok-bot", "/usr/bin/grok-bot", "/usr/local/bin/grok-bot"];
  }
}
function findApp() {
  const found = appCandidates().find((p) => existsSync(p));
  if (!found)
    throw new Error(`Grok Bot app not found. Looked in:
  ${appCandidates().join(`
  `)}
Set GROKBOT_APP to its path.`);
  return found;
}
async function isRunning() {
  try {
    if (process.platform === "win32") {
      const { stdout } = await run("tasklist", ["/FI", `IMAGENAME eq ${PROCESS_NAME}.exe`, "/NH"]);
      return stdout.includes(PROCESS_NAME);
    }
    const pattern = process.platform === "darwin" ? "Grok Bot.app/Contents/MacOS/Grok Bot" : "grok-bot|Grok Bot";
    await run("pgrep", ["-f", pattern]);
    return true;
  } catch {
    return false;
  }
}
async function quit() {
  if (!await isRunning())
    return;
  if (process.platform === "darwin")
    await run("osascript", ["-e", `tell application "${PROCESS_NAME}" to quit`]).catch(() => {});
  else if (process.platform === "win32")
    await run("taskkill", ["/IM", `${PROCESS_NAME}.exe`]).catch(() => {});
  else
    await run("pkill", ["-TERM", "-f", "grok-bot|Grok Bot"]).catch(() => {});
  for (let i = 0;i < 40 && await isRunning(); i++)
    await sleep(250);
  if (await isRunning())
    throw new Error("Grok Bot didn't quit. Quit it yourself, then rerun.");
}
function start(app, args) {
  if (process.platform === "darwin") {
    spawn("open", ["-a", app, ...args.length ? ["--args", ...args] : []], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn(app, args, { detached: true, stdio: "ignore" }).unref();
  }
}
async function launch() {
  const port = cdpPort();
  if (await listTargets(port))
    return { port, restarted: false };
  const app = findApp();
  await quit();
  start(app, [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"]);
  for (let i = 0;i < 80; i++) {
    if (await listTargets(port))
      return { port, restarted: true };
    await sleep(250);
  }
  throw new Error(`Grok Bot started but debug port ${port} never opened.`);
}
async function restore() {
  const app = findApp();
  await quit();
  start(app, []);
}

// src/bot.ts
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

// src/page.ts
function store(name, method) {
  return `(() => {
    for (const start of [document.querySelector(".sand-agent-item[data-agent-id]"), document.querySelector("button")]) {
      const key = start && Object.keys(start).find((k) => k.startsWith("__reactFiber"));
      for (let f = key ? start[key] : null; f; f = f.return) {
        const s = f.memoizedProps && f.memoizedProps.value && f.memoizedProps.value[${JSON.stringify(name)}];
        if (s && typeof s[${JSON.stringify(method)}] === "function") return s;
      }
    }
    return null;
  })()`;
}
var PAGE_ERROR = `(e) => (e && e.failure && e.failure.code ? e.failure.code + (e.message && e.message !== e.failure.code ? ": " + e.message : "") : String((e && e.message) || e))`;

// src/bot.ts
var sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
var LIB = `
  const roster = ${store("roster", "createAgent")};
  const transcript = ${store("transcript", "snapshotsFor")};
  if (!roster || !transcript) throw new Error("Couldn't reach Grok Bot's conversations. Is the app signed in and showing its main window? This app version may also have changed.");
  const errorText = ${PAGE_ERROR};
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = () => roster.snapshots.get().agents.rows.filter((r) => !r.isGroup);
  const rowOf = (id) => roster.snapshots.get().agentsById.get(id);
  const busy = (r) => !!(r && (r.isRunning || r.isRunningTurn || r.isComposingMessage));
  const iso = (ms) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null);
  const toBot = (r) => ({ id: r.id, name: r.name, description: r.description || "", hidden: !!r.isHiddenFromSidebar,
    running: busy(r), needsInput: r.awaitingUserResponse != null, unread: r.unreadCount || 0,
    lastActivity: iso(r.lastActivityAt), preview: r.lastMessagePreview ?? null });
  const snap = (id) => transcript.snapshotsFor(id).get();
  const isUser = (e) => (e.kind === "message" && e.role === "user") || e.kind === "user-attachment";
  // Tool-call rows are the Bot's internal steps; the app folds them away too.
  const hidden = (e) => e.kind === "tool-call";
  const urls = (t) => [...new Set((t.match(/https?:\\/\\/[^\\s<>()\\[\\]"']+/g) || []).map((u) => u.replace(/[.,;:!?]+$/, "")))];
  const label = (o) => { for (const k of ["title", "summary", "text", "content", "prompt", "label", "name"]) if (typeof o[k] === "string" && o[k]) return " " + o[k].slice(0, 500); return ""; };
  const toMessage = (e) => {
    const m = e.message;
    let role = "card", text;
    if (e.kind === "message") { role = e.role === "user" ? "user" : "assistant"; text = e.content || ""; }
    else if (e.kind === "user-attachment") { role = "user"; text = "[file] " + (e.file_name || e.file_path || ""); }
    else if (e.kind === "send-message" && m && m.type === "text") { role = "assistant"; text = m.content || ""; }
    else if (e.kind === "send-message" && m && m.type === "attachment") { role = "assistant"; text = "[attachment]" + label(m) + (m.url ? " " + m.url : ""); }
    else if (e.kind === "send-message" && m && m.type === "widget" && m.widget) {
      const opts = (m.widget.options || []).map((o) => o.label).filter(Boolean);
      text = (m.widget.prompt || "[question]") + (opts.length ? "\\nOptions: " + opts.join(" / ") : "");
    } else text = "[" + (m ? m.type : e.kind) + "]" + label(m || e);
    text = text.trim();
    const out = { key: e.id, role, kind: m ? e.kind + "/" + m.type : e.kind, text, links: urls(text), at: iso(e.timestampMs) };
    return e.isStreaming ? { ...out, streaming: true } : out;
  };
  // Load a Bot's transcript into the store (the app loads only the ones you open) and keep it live until release().
  const open = async (id) => {
    const release = transcript.observeEntries(id, () => {});
    try {
      if (snap(id).loadState !== "ready") transcript.load(id);
      for (const t0 = Date.now(); snap(id).loadState !== "ready"; await pause(150)) {
        const s = snap(id);
        if (s.failure) throw new Error("Couldn't load the conversation: " + errorText(s.failure));
        if (Date.now() - t0 > 20000) throw new Error("Timed out loading the conversation (" + s.loadState + ").");
      }
    } catch (e) { release(); throw e; }
    return release;
  };
  const indexOf = (entries, key) => entries.findIndex((e) => e.id === key || (e.clientNonce != null && e.clientNonce === key));
  // The CLI's heartbeat keeps long waits alive (without it, the CLI exited and the page cleans up)
  // and drives their clock: the app's window timers are throttled while it's in the background.
  const alive = (name) => !name || Date.now() - ((window.__grokbot || {})[name] || Date.now()) < 45000;
  const onBeat = (name, fn) => { const g = (window.__grokbot = window.__grokbot || {}); g.ticks = g.ticks || {}; g.ticks[name] = fn; return () => { delete g.ticks[name]; delete g[name]; }; };
  const emitter = (name) => (ev) => { try { if (name && typeof window[name] === "function") window[name](JSON.stringify(ev)); } catch {} };
  const listen = (subscribable, fn) => { const u = subscribable.subscribe(fn); return typeof u === "function" ? u : () => {}; };
`;
var page = (args, body) => `async (${args}) => {${LIB}
${body}
}`;
var PAGE_BOTS = page("", "return rows().map(toBot);");
var PAGE_READ = page("id, limit, since", `const release = await open(id);
  try {
    const visible = () => snap(id).entries.filter((e) => !hidden(e));
    if (since) {
      const all = snap(id).entries, i = indexOf(all, since);
      if (i < 0) throw new Error("No message with key " + since + " in this conversation.");
      const after = all.slice(i + 1).filter((e) => !hidden(e)).map(toMessage);
      return limit ? after.slice(-limit) : after;
    }
    for (let n = 0; n < 20 && visible().length < limit && snap(id).hasOlder; n++) await transcript.loadOlder(id);
    return visible().slice(-limit).map(toMessage);
  } finally { release(); }`);
var PAGE_SEND = page("id, prompt, uploads", `const journal = ${store("sendJournal", "sendPrompt")};
  const stager = ${store("desktop", "stageAttachmentFile")};
  if (!journal) throw new Error("Couldn't reach Grok Bot's send queue. This app version may not support it.");
  const release = await open(id);
  try {
    await Promise.resolve(window.desktop?.main?.signalBoxIntent?.({ agentId: id, intent: "composer_focus" })).catch(() => {});
    const attachments = [];
    for (const f of uploads) {
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: f.type });
      const staged = stager ? await stager.stageAttachmentFile({ filename: f.name, file: blob }) : await window.desktop.local.stageAttachmentFile(f.name, blob);
      if (!staged || !staged.ok) throw new Error("Grok Bot wouldn't accept " + f.name + ": " + errorText((staged && (staged.error || staged.reason)) || "staging failed"));
      attachments.push({ path: staged.path, name: f.name, size: bytes.length });
    }
    let nonce = null;
    try {
      await journal.sendPrompt({ agentId: id, prompt, attachments, onNonceAssigned: (n) => { nonce = n.nonce; } });
    } catch (e) { throw new Error("Grok Bot didn't send the message: " + errorText(e)); }
    for (let n = 0; n < 50; n++) {
      const entry = snap(id).entries.find((e) => e.clientNonce === nonce);
      if (entry) return entry.clientNonce;
      await pause(100);
    }
    return nonce;
  } finally { release(); }`);
var PAGE_WAIT = page("id, since, timeoutMs, settleMs, beat, sink", `const emit = emitter(sink);
  const release = await open(id);
  const entries0 = snap(id).entries;
  let anchor = since;
  if (anchor && indexOf(entries0, anchor) < 0) { release(); throw new Error("No message with key " + anchor + " in this conversation."); }
  if (!anchor) { const last = [...entries0].reverse().find(isUser); anchor = last ? (last.clientNonce || last.id) : null; }
  return await new Promise((resolve) => {
    const t0 = Date.now(), seen = new Map();
    let lastBusy = 0, finished = false;
    const stops = [];
    const finish = (status) => {
      if (finished) return;
      finished = true;
      stops.forEach((s) => s());
      release();
      resolve({ status, messages: [...seen.values()], elapsedMs: Date.now() - t0 });
    };
    const tick = () => {
      if (finished) return;
      const row = rowOf(id);
      if (!row) return finish("done");
      const all = snap(id).entries, i = anchor ? indexOf(all, anchor) : -1;
      for (const e of i >= 0 ? all.slice(i + 1) : anchor ? [] : all) {
        if (isUser(e) || hidden(e)) continue;
        const m = toMessage(e), prev = seen.get(m.key);
        if (prev && prev.text === m.text && !!prev.streaming === !!m.streaming) continue;
        seen.set(m.key, m);
        if (!m.streaming) emit(m);
      }
      if (row.awaitingUserResponse != null) return finish("needs_input");
      const replies = [...seen.values()];
      if (busy(row) || replies.some((m) => m.streaming)) lastBusy = Date.now();
      // Done once idle for settleMs after replying, or after working without a reply (e.g. stopped).
      else if (replies.length || lastBusy) {
        const idleSince = Math.max(lastBusy, row.lastActivityAt || 0, ...replies.map((m) => Date.parse(m.at || "") || 0));
        if (Date.now() - idleSince >= settleMs) return finish("done");
      }
      if (Date.now() - t0 >= timeoutMs || !alive(beat)) finish("timeout");
    };
    stops.push(listen(roster.snapshots, tick), listen(transcript.snapshotsFor(id), tick), onBeat(beat, tick));
    const iv = setInterval(tick, 1000);
    stops.push(() => clearInterval(iv));
    tick();
  });`);
var PAGE_WATCH = page("only, settleMs, beat, sink", `const emit = emitter(sink);
  const watched = new Map();
  const now = () => new Date().toISOString();
  const track = async (r) => {
    if (watched.has(r.id)) return;
    const w = { name: r.name, seen: new Map(), state: null, lastBusy: 0, release: () => {}, ready: false };
    watched.set(r.id, w);
    try { w.release = await open(r.id); } catch { return; }
    for (const e of snap(r.id).entries) w.seen.set(e.id, toMessage(e).text);
    w.state = r.awaitingUserResponse != null ? "needs_input" : busy(r) ? "working" : "idle";
    w.ready = true;
    stops.push(listen(transcript.snapshotsFor(r.id), tick));
  };
  const stops = [];
  const tick = () => {
    for (const r of rows()) {
      if (only && r.id !== only) continue;
      const w = watched.get(r.id);
      if (!w) { track(r); continue; }
      if (!w.ready) continue;
      w.name = r.name;
      for (const e of snap(r.id).entries) {
        if (isUser(e) || hidden(e)) continue;
        const m = toMessage(e);
        if (m.streaming || w.seen.get(m.key) === m.text) continue;
        w.seen.set(m.key, m.text);
        emit({ type: "message", bot: r.name, ...m });
      }
      let state = r.awaitingUserResponse != null ? "needs_input" : busy(r) ? "working" : null;
      if (state === "working") w.lastBusy = Date.now();
      if (!state) state = w.state === "working" && Date.now() - w.lastBusy < settleMs ? "working" : "idle";
      if (state !== w.state) { w.state = state; emit({ type: state, bot: r.name, at: now() }); }
    }
  };
  stops.push(listen(roster.snapshots, tick), onBeat(beat, tick));
  tick();
  await new Promise((resolve) => {
    const iv = setInterval(() => { if (!alive(beat)) { clearInterval(iv); resolve(); } }, 5000);
  });
  stops.forEach((s) => s());
  for (const w of watched.values()) w.release();`);
var PAGE_STOP = page("id", `const row = rowOf(id);
  if (!busy(row)) return false;
  const sessions = row.runningSessionIds || [];
  try {
    if (!sessions.length) await roster.interruptAgentRun({ agentId: id });
    else await Promise.allSettled(sessions.map((s) => roster.interruptAgentRun({ agentId: id, sessionId: s })));
  } catch (e) { throw new Error("Grok Bot couldn't stop the Bot: " + errorText(e)); }
  return true;`);
async function listBots(cdp) {
  const bots = await cdp.call(PAGE_BOTS);
  if (!bots.length)
    throw new Error("No Bots found. Is Grok Bot signed in and showing its main window?");
  return bots;
}
function matchBot(bots, query) {
  const q = query.trim().toLowerCase();
  const exact = bots.filter((b) => b.id === query.trim() || b.name.toLowerCase() === q);
  if (exact.length === 1)
    return exact[0];
  const partial = bots.filter((b) => b.name.toLowerCase().startsWith(q));
  if (exact.length === 0 && partial.length === 1)
    return partial[0];
  const names = bots.map((b) => b.name).join(", ");
  throw new Error(exact.length + partial.length > 1 ? `"${query}" matches several Bots: ${names}` : `No Bot named "${query}". Bots: ${names}`);
}
async function findBot(cdp, query) {
  return matchBot(await listBots(cdp), query);
}
async function read(cdp, botQuery, opts = {}) {
  const bot = await findBot(cdp, botQuery);
  const limit = opts.limit ?? (opts.since ? 0 : 10);
  const messages = await cdp.call(PAGE_READ, bot.id, limit, opts.since ?? null);
  return { bot: bot.name, messages };
}
var MAX_FILE_BYTES = 25 * 1024 * 1024;
var TYPES = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  html: "text/html"
};
async function loadFiles(paths) {
  return Promise.all(paths.map(async (p) => {
    const info = await stat(p).catch(() => null);
    if (!info?.isFile())
      throw new Error(`Not a file: ${p}`);
    if (info.size > MAX_FILE_BYTES)
      throw new Error(`${p} is over 25 MB.`);
    const name = basename(p);
    const type = TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
    return { name, type, data: (await readFile(p)).toString("base64") };
  }));
}
async function send(cdp, botQuery, text, files = []) {
  if (!text.trim() && !files.length)
    throw new Error("Message is empty.");
  const bot = await findBot(cdp, botQuery);
  const key = await cdp.call(PAGE_SEND, bot.id, text.trim(), await loadFiles(files));
  return { bot: bot.name, key };
}
async function withHeartbeat(cdp, fn) {
  const beat = `beat_${process.pid}_${Date.now()}`;
  const name = JSON.stringify(beat);
  const touch = () => cdp.eval(`{ const g = (window.__grokbot = window.__grokbot || {}); g[${name}] = Date.now(); g.ticks?.[${name}]?.(); }`).catch(() => {});
  await touch();
  const iv = setInterval(touch, 1000);
  try {
    return await fn(beat);
  } finally {
    clearInterval(iv);
  }
}
async function wait(cdp, botQuery, opts = {}) {
  const bot = await findBot(cdp, botQuery);
  const sink = opts.onUpdate ? await cdp.bind((p) => opts.onUpdate?.(JSON.parse(p))) : null;
  const r = await withHeartbeat(cdp, (beat) => cdp.call(PAGE_WAIT, bot.id, opts.since ?? null, opts.timeoutMs ?? 1800000, opts.settleMs ?? 8000, beat, sink));
  return { bot: bot.name, ...r };
}
async function ask(cdp, botQuery, text, opts = {}) {
  const t0 = Date.now();
  const sent = await send(cdp, botQuery, text, opts.files);
  const r = await wait(cdp, sent.bot, {
    ...opts,
    since: sent.key,
    timeoutMs: Math.max(1000, (opts.timeoutMs ?? 300000) - (Date.now() - t0))
  });
  return { ...r, key: sent.key, elapsedMs: Date.now() - t0 };
}
async function watch(cdp, botQuery, onEvent, settleMs = 8000) {
  const only = botQuery ? (await findBot(cdp, botQuery)).id : null;
  await cdp.send("Runtime.enable");
  const sink = await cdp.bind((p) => onEvent(JSON.parse(p)));
  await withHeartbeat(cdp, (beat) => cdp.call(PAGE_WATCH, only, settleMs, beat, sink));
}
async function stop(cdp, botQuery) {
  const bot = await findBot(cdp, botQuery);
  return { bot: bot.name, stopped: await cdp.call(PAGE_STOP, bot.id) };
}
async function usage(cdp) {
  const get = () => cdp.call(`async () => { const m = window.desktop?.main; return m?.getCursorUsageSummary ? await m.getCursorUsageSummary() : null; }`);
  const s = await get().catch(async (e) => {
    await sleep2(2000);
    return get().catch(() => {
      throw new Error(`Couldn't read usage from Grok Bot: ${e.message}`);
    });
  });
  if (!s || typeof s.sandUsagePercent !== "number")
    throw new Error("Couldn't read usage. This Grok Bot version may not support it.");
  return {
    percentUsed: Math.round(s.sandUsagePercent * 100) / 100,
    resetsAt: s.sandUsageResetTimestampMs ? new Date(s.sandUsageResetTimestampMs).toISOString() : null,
    plan: s.grokPlanLabel ?? null,
    hasAvailableUsage: s.hasAvailableUsage !== false,
    onDemand: s.onDemand ? { enabled: !!s.onDemandSettings?.enabled, usedCents: s.onDemand.usedCents ?? 0, limitCents: s.onDemand.limitCents ?? null } : null
  };
}
async function status(cdp) {
  const bots = await listBots(cdp);
  return { bots, busy: bots.some((b) => b.running), usage: await usage(cdp).catch(() => null) };
}

// src/mcp.ts
import { createInterface } from "node:readline";

// src/roster.ts
var sleep3 = (ms) => new Promise((r) => setTimeout(r, ms));
var NO_ROSTER = "Couldn't reach Grok Bot's Bot list. This app version may not support managing Bots.";
var PAGE_OP = `async (op, arg) => {
  const roster = ${store("roster", "createAgent")};
  if (!roster) return { error: ${JSON.stringify(NO_ROSTER)} };
  const profile = (r) => ({ id: r.id, name: r.name, description: r.description || "", hidden: !!r.isHiddenFromSidebar, running: !!r.isRunning });
  const message = ${PAGE_ERROR};
  const awake = async (id, fn) => {
    for (let i = 0; ; i++) {
      await Promise.resolve(window.desktop?.main?.signalBoxIntent?.({ agentId: id, intent: "composer_focus" })).catch(() => {});
      try { return await fn(); } catch (e) {
        if (i >= 8 || !(e && e.failure && e.failure.code === "sand-box-blocked")) throw e;
        await new Promise((s) => setTimeout(s, 1500));
      }
    }
  };
  try {
    if (op === "create") {
      const res = await roster.createAgent({ name: arg.name, description: arg.description, origin: "user", isKickstartRequested: false });
      return { value: profile(res.agent) };
    }
    if (op === "update") {
      await awake(arg.id, () => roster.updateAgent(arg.id, { name: arg.name, description: arg.description }));
      const row = roster.snapshots.get().agentsById.get(arg.id);
      return { value: row ? profile(row) : { id: arg.id, name: arg.name, description: arg.description, hidden: false, running: false } };
    }
    if (op === "delete") {
      const res = await awake(arg.id, () => roster.deleteAgents([arg.id]));
      const refused = (res && res.refusedAgentIds) || [], failed = (res && res.failedAgentIds) || [];
      if (refused.includes(arg.id)) return { error: "Grok Bot refused to delete this Bot. Your main Bot can't be deleted; choose another main Bot in the app first." };
      if (failed.includes(arg.id)) return { error: "Grok Bot couldn't delete this Bot. Try again, or delete it in the app." };
      return { value: true };
    }
    return { error: "Unknown roster operation " + op };
  } catch (e) {
    return { error: message(e) };
  }
}`;
async function op(cdp, name, arg) {
  const r = await cdp.call(PAGE_OP, name, arg ?? null);
  if (r.error !== undefined)
    throw new Error(r.error);
  return r.value;
}
async function createBot(cdp, input) {
  const name = input.name.trim();
  if (!name)
    throw new Error("A Bot needs a name.");
  const profiles = await listBots(cdp).catch(() => []);
  if (profiles.some((p) => p.name.toLowerCase() === name.toLowerCase()))
    throw new Error(`You already have a Bot named "${name}".`);
  const bot = await op(cdp, "create", { name, description: input.description?.trim() ?? "" });
  for (let i = 0;i < 25; i++) {
    if ((await listBots(cdp).catch(() => [])).some((b) => b.id === bot.id))
      break;
    await sleep3(400);
  }
  return bot;
}
async function updateBot(cdp, query, changes) {
  const current = matchBot(await listBots(cdp), query);
  const name = changes.name?.trim() || current.name;
  const description = changes.description?.trim() ?? current.description;
  if (name === current.name && description === current.description) {
    return { id: current.id, name, description, hidden: current.hidden, running: current.running };
  }
  return op(cdp, "update", { id: current.id, name, description });
}
async function deleteBot(cdp, query) {
  const q = query.trim().toLowerCase();
  const matches = (await listBots(cdp)).filter((p) => p.id === query.trim() || p.name.toLowerCase() === q);
  if (matches.length !== 1) {
    throw new Error(matches.length ? `"${query}" matches several Bots. Use the Bot's id.` : `No Bot named exactly "${query}".`);
  }
  const [bot] = matches;
  await op(cdp, "delete", { id: bot.id });
  return { id: bot.id, name: bot.name };
}

// src/version.ts
var VERSION = "0.1.0";

// src/mcp.ts
var TOOLS = [
  {
    name: "grokbot_list_bots",
    description: "List the Grok Bots in the user's Grok Bot desktop app: name, description, id, and whether each is working, needs the user's input, or has unread messages.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "grokbot_ask",
    description: "Send a message to a Grok Bot and wait for its reply. Bots run on a cloud computer with a browser and can research the web and X, use connected apps, and do multi-step work. Returns the Bot's reply messages and the sent message's key. Status 'timeout' means it's still working: call grokbot_wait with since=key. Status 'needs_input' means the Bot is waiting on the user in the app.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string", description: "Bot name (e.g. 'Chief') or id" },
        message: { type: "string", description: "The message to send, written like a request to a teammate" },
        files: { type: "array", items: { type: "string" }, description: "Optional absolute paths of local files to attach (25 MB each)" },
        timeout_seconds: { type: "number", description: "Max seconds to wait for replies (default 300, max 1800)" },
        settle_seconds: { type: "number", description: "Idle seconds before the reply counts as finished (default 8)" }
      },
      required: ["bot", "message"],
      additionalProperties: false
    }
  },
  {
    name: "grokbot_send",
    description: "Send a message to a Grok Bot without waiting. Returns the message key; pass it to grokbot_wait or grokbot_read as 'since' to collect the reply.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string" },
        message: { type: "string" },
        files: { type: "array", items: { type: "string" }, description: "Optional absolute paths of local files to attach" }
      },
      required: ["bot", "message"],
      additionalProperties: false
    }
  },
  {
    name: "grokbot_wait",
    description: "Wait for a Grok Bot to finish replying (to the message at 'since', or the user's latest message) and return its replies. Event-driven, no polling. Returns status 'done', 'timeout' (still working) or 'needs_input' (waiting on the user in the app).",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string" },
        since: { type: "string", description: "Message key from grokbot_send or grokbot_ask" },
        timeout_seconds: { type: "number", description: "Max seconds to wait (default 600, max 3600)" },
        settle_seconds: { type: "number", description: "Idle seconds before the reply counts as finished (default 8)" }
      },
      required: ["bot"],
      additionalProperties: false
    }
  },
  {
    name: "grokbot_stop",
    description: "Interrupt what a Grok Bot is doing, like the app's Stop button. Use when the user asks, or a task is clearly running away.",
    inputSchema: { type: "object", properties: { bot: { type: "string" } }, required: ["bot"], additionalProperties: false }
  },
  {
    name: "grokbot_create_bot",
    description: "Create a new Grok Bot. It starts working when it gets its first message (use grokbot_ask). Each Bot uses the user's Grok Bot usage, so only create one when the user asked for it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name shown in the sidebar" },
        description: { type: "string", description: "Optional: what the Bot is for" }
      },
      required: ["name"],
      additionalProperties: false
    }
  },
  {
    name: "grokbot_update_bot",
    description: "Rename a Grok Bot or change its description. Omitted fields stay the same.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string", description: "Current Bot name or id" },
        name: { type: "string", description: "New name" },
        description: { type: "string", description: "New description" }
      },
      required: ["bot"],
      additionalProperties: false
    }
  },
  {
    name: "grokbot_delete_bot",
    description: "Permanently delete a Grok Bot and its conversation. Only use when the user explicitly asked to delete this Bot. 'bot' must be the exact name or id, and 'confirm' must repeat it.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string", description: "Exact Bot name or id" },
        confirm: { type: "string", description: "Repeat the same value as 'bot' to confirm" }
      },
      required: ["bot", "confirm"],
      additionalProperties: false
    }
  },
  {
    name: "grokbot_usage",
    description: "Get the user's Grok Bot weekly usage limit: percent used, when it resets, plan, and on-demand spend. Check it before handing a Bot long or heavy work.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "grokbot_read",
    description: "Read messages in a Grok Bot conversation without switching the app's view: the most recent ones, or everything after a message key.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string" },
        limit: { type: "number", description: "Max messages (default 10)" },
        since: { type: "string", description: "Only messages after this key" }
      },
      required: ["bot"],
      additionalProperties: false
    }
  }
];
var launching = null;
async function withApp(fn) {
  launching ??= launch().finally(() => {
    launching = null;
  });
  await launching;
  const cdp = await CDP.connect();
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}
async function callTool(name, args) {
  const str = (k) => {
    const v = args[k];
    if (typeof v !== "string" || !v.trim())
      throw new Error(`"${k}" is required`);
    return v;
  };
  const opt = (k) => typeof args[k] === "string" ? args[k] : undefined;
  const files = Array.isArray(args.files) ? args.files.map(String) : [];
  const seconds = (k, def, min, max) => Math.min(Math.max(Number(args[k] ?? def) || def, min), max) * 1000;
  switch (name) {
    case "grokbot_list_bots":
      return withApp((c) => listBots(c));
    case "grokbot_ask":
      return withApp((c) => ask(c, str("bot"), opt("message") ?? "", {
        files,
        timeoutMs: seconds("timeout_seconds", 300, 10, 1800),
        settleMs: seconds("settle_seconds", 8, 2, 120)
      }));
    case "grokbot_send":
      return withApp((c) => send(c, str("bot"), opt("message") ?? "", files));
    case "grokbot_wait":
      return withApp((c) => wait(c, str("bot"), {
        since: opt("since"),
        timeoutMs: seconds("timeout_seconds", 600, 10, 3600),
        settleMs: seconds("settle_seconds", 8, 2, 120)
      }));
    case "grokbot_stop":
      return withApp((c) => stop(c, str("bot")));
    case "grokbot_create_bot":
      return withApp((c) => createBot(c, { name: str("name"), description: opt("description") }));
    case "grokbot_update_bot": {
      const name2 = opt("name");
      const description = opt("description");
      if (name2 === undefined && description === undefined)
        throw new Error('Pass "name" or "description" to change.');
      return withApp((c) => updateBot(c, str("bot"), { name: name2, description }));
    }
    case "grokbot_delete_bot":
      if (str("confirm") !== str("bot"))
        throw new Error('"confirm" must repeat the "bot" value exactly.');
      return withApp((c) => deleteBot(c, str("bot")));
    case "grokbot_usage":
      return withApp((c) => usage(c));
    case "grokbot_read":
      return withApp((c) => read(c, str("bot"), { limit: args.limit === undefined ? undefined : Number(args.limit) || 10, since: opt("since") }));
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
function serveMcp() {
  const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}
`);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim())
      return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const { id, method, params } = msg;
    if (id === undefined)
      return;
    const reply = (result) => write({ jsonrpc: "2.0", id, result });
    try {
      switch (method) {
        case "initialize":
          return reply({
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "grokbot-bridge", version: VERSION }
          });
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: TOOLS });
        case "tools/call": {
          try {
            const out = await callTool(params?.name ?? "", params?.arguments ?? {});
            return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
          } catch (e) {
            return reply({ content: [{ type: "text", text: String(e.message ?? e) }], isError: true });
          }
        }
        default:
          write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (e) {
      write({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e.message ?? e) } });
    }
  });
}

// src/cli.ts
var USAGE = `grokbot ${VERSION} — talk to your Grok Bots from the terminal or any agent

Usage:
  grokbot ask <bot> <message...>    Send a message and wait for the reply
  grokbot send <bot> <message...>   Send without waiting; prints the message key
  grokbot wait <bot>                Wait for the Bot to finish replying to your latest message
  grokbot read <bot>                Show recent messages in a conversation
  grokbot watch [bot]               Stream new replies and working/idle changes as JSON lines
  grokbot stop <bot>                Interrupt what the Bot is doing (like the Stop button)
  grokbot bots                      List your Bots and what each is doing
  grokbot create <name>             Create a Bot (--description <text>)
  grokbot update <bot>              Rename a Bot or change its description (--name, --description)
  grokbot delete <bot> --yes        Permanently delete a Bot (exact name or id)
  grokbot usage                     Show your weekly usage limit
  grokbot status                    Check the connection
  grokbot launch                    (Re)start Grok Bot with the local debug port
  grokbot restore                   Restart Grok Bot normally (closes the port)
  grokbot mcp                       Run as an MCP server over stdio

Options:
  --file <path>     ask/send: attach a file (repeat for several, 25 MB each)
  --timeout <sec>   ask/wait: max seconds to wait (ask 300, wait 1800)
  --settle <sec>    ask/wait/watch: idle seconds before a reply counts as finished (default 8)
  --since <key>     wait/read: messages after this message key (from send/ask/read --json)
  --limit <n>       read: number of messages (default 10)
  --name <text>     update: new name
  --description <t> create/update: what the Bot is for
  --yes             delete: confirm deleting the Bot
  --json            Machine-readable output
  --quiet           ask/wait: don't stream progress to stderr
  -v, --version     Print version
  -h, --help        Show this help

Use "-" as the message to read it from stdin.
Exit codes for ask/wait: 0 finished, 2 still working at the timeout, 3 the Bot needs your input in the app.
Env: GROKBOT_CDP_PORT (default 9333), GROKBOT_APP (path to the app)`;
function parse(argv) {
  const flags = {};
  const files = [];
  const rest = [];
  for (let i = 0;i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "--quiet" || a === "--yes")
      flags[a.slice(2)] = true;
    else if (a === "--file")
      files.push(argv[++i] ?? "");
    else if (["--timeout", "--limit", "--settle", "--since", "--name", "--description"].includes(a))
      flags[a.slice(2)] = argv[++i] ?? "";
    else if (a === "-h" || a === "--help")
      flags.help = true;
    else if (a === "-v" || a === "--version")
      flags.version = true;
    else
      rest.push(a);
  }
  return { flags, files, cmd: rest[0], args: rest.slice(1) };
}
async function readMessage(parts) {
  if (parts.length === 1 && parts[0] === "-") {
    const chunks = [];
    for await (const c of process.stdin)
      chunks.push(c);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  return parts.join(" ").trim();
}
var str = (v) => typeof v === "string" ? v : undefined;
function positiveNumber(v, name, fallback) {
  if (v === undefined)
    return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`--${name} must be a positive number`);
  return n;
}
function formatUsage(u) {
  const parts = [`Weekly usage: ${u.percentUsed}% used`];
  if (u.resetsAt) {
    const days = Math.max(0, Math.round((Date.parse(u.resetsAt) - Date.now()) / 86400000));
    parts.push(`resets ${new Date(u.resetsAt).toLocaleString()} (${days === 0 ? "within a day" : `in ${days} day${days === 1 ? "" : "s"}`})`);
  }
  if (u.plan)
    parts.push(`plan: ${u.plan}`);
  if (!u.hasAvailableUsage)
    parts.push("limit reached");
  if (u.onDemand?.enabled) {
    const limit = u.onDemand.limitCents == null ? "no limit" : `$${(u.onDemand.limitCents / 100).toFixed(2)} limit`;
    parts.push(`on-demand: $${(u.onDemand.usedCents / 100).toFixed(2)} spent, ${limit}`);
  }
  return parts.join(" · ");
}
var progress = (m) => console.error(`[grokbot] ${m.role === "card" ? "card" : "reply"}: ${m.text.slice(0, 100).replace(/\s+/g, " ")}`);
function printReplies(r, json, extra = {}) {
  if (json)
    console.log(JSON.stringify({ ...r, ...extra }, null, 2));
  else {
    const body = r.messages.map((m) => m.role === "card" ? `[card] ${m.text}` : m.text).join(`

`);
    const tail = r.status === "timeout" ? `

[grokbot] ${r.bot} hasn't finished after ${Math.round(r.elapsedMs / 1000)}s. Run \`grokbot wait ${r.bot}\` to keep waiting.` : r.status === "needs_input" ? `

[grokbot] ${r.bot} is waiting for you in the Grok Bot app (an approval or question). Answer it there.` : "";
    console.log((body || (r.status === "done" ? "(The Bot finished without replying.)" : "(no reply yet)")) + tail);
  }
  if (r.status !== "done")
    process.exitCode = r.status === "needs_input" ? 3 : 2;
}
async function withApp2(fn) {
  const { restarted } = await launch();
  if (restarted)
    console.error("[grokbot] Restarted Grok Bot with the local debug port.");
  const cdp = await CDP.connect();
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}
async function main() {
  const { flags, files, cmd, args } = parse(process.argv.slice(2));
  if (flags.version)
    return console.log(VERSION);
  if (flags.help || !cmd)
    return console.log(USAGE);
  const out = (v, text) => console.log(flags.json ? JSON.stringify(v, null, 2) : text());
  switch (cmd) {
    case "mcp":
      return serveMcp();
    case "launch": {
      const r = await launch();
      return out(r, () => r.restarted ? `Grok Bot restarted with debug port ${r.port} (127.0.0.1 only).` : `Already connected on port ${r.port}.`);
    }
    case "restore":
      await restore();
      return out({ ok: true }, () => "Grok Bot restarted normally. The debug port is closed.");
    case "status": {
      const port = cdpPort();
      if (!await listTargets(port))
        return out({ connected: false, port }, () => `Not connected (port ${port}). Run: grokbot launch`);
      const cdp = await CDP.connect();
      try {
        const s = await status(cdp);
        return out({ connected: true, port, ...s }, () => `Connected on port ${port}. ${s.bots.length} Bot(s): ${s.bots.map((b) => b.name).join(", ")}${s.busy ? " · a Bot is working" : ""}${s.usage ? `
${formatUsage(s.usage)}` : ""}`);
      } finally {
        cdp.close();
      }
    }
    case "bots": {
      const bots = await withApp2(listBots);
      return out(bots, () => bots.map((b) => {
        const state = [
          b.needsInput ? "needs your input" : b.running ? "working" : "idle",
          b.unread ? `${b.unread} unread` : "",
          b.hidden ? "hidden" : ""
        ];
        return `${b.name}${b.description ? ` — ${b.description}` : ""}  (${b.id})  [${state.filter(Boolean).join(", ")}]`;
      }).join(`
`));
    }
    case "usage": {
      const u = await withApp2(usage);
      return out(u, () => formatUsage(u));
    }
    case "create": {
      const name = args.join(" ").trim();
      if (!name)
        throw new Error("Usage: grokbot create <name> [--description <text>]");
      const b = await withApp2((c) => createBot(c, { name, description: str(flags.description) }));
      return out(b, () => `Created ${b.name} (${b.id}). It starts working when you send it a message.`);
    }
    case "update": {
      const bot = args.join(" ").trim();
      const name = str(flags.name);
      const description = str(flags.description);
      if (!bot || name === undefined && description === undefined) {
        throw new Error("Usage: grokbot update <bot> [--name <new name>] [--description <text>]");
      }
      const b = await withApp2((c) => updateBot(c, bot, { name, description }));
      return out(b, () => `Updated ${b.name}${b.description ? ` — ${b.description}` : ""}`);
    }
    case "delete": {
      const bot = args.join(" ").trim();
      if (!bot)
        throw new Error("Usage: grokbot delete <bot> --yes");
      if (!flags.yes)
        throw new Error(`This permanently deletes "${bot}" and its conversation. Run again with --yes to confirm.`);
      const b = await withApp2((c) => deleteBot(c, bot));
      return out(b, () => `Deleted ${b.name}.`);
    }
    case "read": {
      const bot = args.join(" ").trim();
      if (!bot)
        throw new Error("Usage: grokbot read <bot> [--limit <n>] [--since <key>]");
      const since = str(flags.since);
      const limit = flags.limit === undefined ? undefined : positiveNumber(flags.limit, "limit", 10);
      const r = await withApp2((c) => read(c, bot, { limit, since }));
      return out(r, () => r.messages.map((m) => `[${m.role === "user" ? "you" : m.role === "card" ? "card" : r.bot}] ${m.text}`).join(`

`));
    }
    case "send": {
      const [bot, ...rest] = args;
      const msg = await readMessage(rest);
      if (!bot || !msg && !files.length)
        throw new Error("Usage: grokbot send <bot> <message...> [--file <path>]");
      const r = await withApp2((c) => send(c, bot, msg, files));
      return out(r, () => `Sent to ${r.bot} (key ${r.key}). Run \`grokbot wait ${r.bot}\` for the reply.`);
    }
    case "wait": {
      const bot = args.join(" ").trim();
      if (!bot)
        throw new Error("Usage: grokbot wait <bot> [--since <key>] [--timeout <sec>]");
      const r = await withApp2((c) => wait(c, bot, {
        since: str(flags.since),
        timeoutMs: positiveNumber(flags.timeout, "timeout", 1800) * 1000,
        settleMs: positiveNumber(flags.settle, "settle", 8) * 1000,
        onUpdate: flags.quiet ? undefined : progress
      }));
      return printReplies(r, !!flags.json);
    }
    case "watch": {
      const bot = args.join(" ").trim() || null;
      const line = (e) => console.log(flags.json || e.type !== "message" ? JSON.stringify(e) : `[${e.bot}] ${e.role === "card" ? "[card] " : ""}${e.text}`);
      await withApp2((c) => {
        console.error(`[grokbot] Watching ${bot ?? "all Bots"}. Press Ctrl-C to stop.`);
        return watch(c, bot, line, positiveNumber(flags.settle, "settle", 8) * 1000);
      });
      return;
    }
    case "stop": {
      const bot = args.join(" ").trim();
      if (!bot)
        throw new Error("Usage: grokbot stop <bot>");
      const r = await withApp2((c) => stop(c, bot));
      return out(r, () => r.stopped ? `Stopped ${r.bot}.` : `${r.bot} wasn't working.`);
    }
    case "ask": {
      const [bot, ...rest] = args;
      const msg = await readMessage(rest);
      if (!bot || !msg && !files.length)
        throw new Error("Usage: grokbot ask <bot> <message...> [--file <path>]");
      const r = await withApp2((c) => ask(c, bot, msg, {
        files,
        timeoutMs: positiveNumber(flags.timeout, "timeout", 300) * 1000,
        settleMs: positiveNumber(flags.settle, "settle", 8) * 1000,
        onUpdate: flags.quiet ? undefined : progress
      }));
      return printReplies(r, !!flags.json);
    }
    default:
      throw new Error(`Unknown command "${cmd}".

${USAGE}`);
  }
}
main().catch((e) => {
  console.error(`grokbot: ${e?.message ?? e}`);
  process.exit(1);
});
