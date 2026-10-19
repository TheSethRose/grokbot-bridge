// Talk to Grok Bots through the desktop app's own stores: the Bot list (roster),
// each Bot's transcript, and the send queue the message box uses. Reading them
// works for any Bot without switching the conversation on screen, and waiting is
// driven by the stores' change events rather than by polling the screen.
// Store and field names are internal to Grok Bot (0.71.x); see page.ts.
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { CDP } from "./cdp.ts";
import { PAGE_ERROR, store } from "./page.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Bot = {
  id: string;
  name: string;
  description: string;
  hidden: boolean;
  /** Working on a turn, using tools or typing. */
  running: boolean;
  /** Waiting on the user, e.g. an approval card in the app. */
  needsInput: boolean;
  unread: number;
  lastActivity: string | null;
  preview: string | null;
};
/** `key` is the transcript entry id (pass it to `since`). `text` keeps links as Markdown; `links` lists every URL. */
export type Message = { key: string; role: "user" | "assistant" | "card"; kind: string; text: string; links: string[]; at: string | null };
export type WaitStatus = "done" | "timeout" | "needs_input";
export type WaitResult = { bot: string; status: WaitStatus; messages: Message[]; elapsedMs: number };
export type AskResult = WaitResult & { key: string };
export type BotEvent = ({ type: "message"; bot: string } & Message) | { type: "working" | "idle" | "needs_input"; bot: string; at: string };

// ---- page-side library, inlined into each evaluation ----

const LIB = `
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

const page = (args: string, body: string) => `async (${args}) => {${LIB}\n${body}\n}`;

const PAGE_BOTS = page("", "return rows().map(toBot);");

const PAGE_READ = page(
  "id, limit, since",
  `const release = await open(id);
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
  } finally { release(); }`,
);

// Same path as the message box: stage files, then queue the prompt with the app's send journal.
const PAGE_SEND = page(
  "id, prompt, uploads",
  `const journal = ${store("sendJournal", "sendPrompt")};
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
  } finally { release(); }`,
);

/**
 * Resolves when the Bot has stayed idle for `settleMs` after replying to the message at `since`
 * (default: the latest message from the user), when it needs the user's input, or at the timeout.
 * Driven by the roster and transcript change events; the interval only advances the clocks.
 */
const PAGE_WAIT = page(
  "id, since, timeoutMs, settleMs, beat, sink",
  `const emit = emitter(sink);
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
  });`,
);

/** Streams events for every Bot (or one) until the CLI stops sending heartbeats. */
const PAGE_WATCH = page(
  "only, settleMs, beat, sink",
  `const emit = emitter(sink);
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
  for (const w of watched.values()) w.release();`,
);

// Same as the app's Stop button: interrupt every running session of the Bot.
const PAGE_STOP = page(
  "id",
  `const row = rowOf(id);
  if (!busy(row)) return false;
  const sessions = row.runningSessionIds || [];
  try {
    if (!sessions.length) await roster.interruptAgentRun({ agentId: id });
    else await Promise.allSettled(sessions.map((s) => roster.interruptAgentRun({ agentId: id, sessionId: s })));
  } catch (e) { throw new Error("Grok Bot couldn't stop the Bot: " + errorText(e)); }
  return true;`,
);

// ---- public API ----

/** Every Bot on the account, with what it's doing. Hidden Bots are included and marked. */
export async function listBots(cdp: CDP): Promise<Bot[]> {
  const bots = await cdp.call<Bot[]>(PAGE_BOTS);
  if (!bots.length) throw new Error("No Bots found. Is Grok Bot signed in and showing its main window?");
  return bots;
}

export function matchBot<T extends { id: string; name: string }>(bots: T[], query: string): T {
  const q = query.trim().toLowerCase();
  const exact = bots.filter((b) => b.id === query.trim() || b.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const partial = bots.filter((b) => b.name.toLowerCase().startsWith(q));
  if (exact.length === 0 && partial.length === 1) return partial[0];
  const names = bots.map((b) => b.name).join(", ");
  throw new Error(
    exact.length + partial.length > 1 ? `"${query}" matches several Bots: ${names}` : `No Bot named "${query}". Bots: ${names}`,
  );
}

export async function findBot(cdp: CDP, query: string): Promise<Bot> {
  return matchBot(await listBots(cdp), query);
}

/**
 * Messages in a Bot's conversation, oldest first. Reads the app's transcript store, so it
 * works for any Bot without switching the conversation on screen. With `since`, returns
 * everything after that message key instead of the last `limit`.
 */
export async function read(cdp: CDP, botQuery: string, opts: { limit?: number; since?: string } = {}) {
  const bot = await findBot(cdp, botQuery);
  const limit = opts.limit ?? (opts.since ? 0 : 10);
  const messages = await cdp.call<Message[]>(PAGE_READ, bot.id, limit, opts.since ?? null);
  return { bot: bot.name, messages };
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TYPES: Record<string, string> = {
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
  html: "text/html",
};

async function loadFiles(paths: string[]) {
  return Promise.all(
    paths.map(async (p) => {
      const info = await stat(p).catch(() => null);
      if (!info?.isFile()) throw new Error(`Not a file: ${p}`);
      if (info.size > MAX_FILE_BYTES) throw new Error(`${p} is over 25 MB.`);
      const name = basename(p);
      const type = TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
      return { name, type, data: (await readFile(p)).toString("base64") };
    }),
  );
}

/** Send a message, optionally with files. Returns the message key, which `wait` and `read` accept as `since`. */
export async function send(cdp: CDP, botQuery: string, text: string, files: string[] = []): Promise<{ bot: string; key: string }> {
  if (!text.trim() && !files.length) throw new Error("Message is empty.");
  const bot = await findBot(cdp, botQuery);
  const key = await cdp.call<string>(PAGE_SEND, bot.id, text.trim(), await loadFiles(files));
  return { bot: bot.name, key };
}

export type WaitOptions = { since?: string; timeoutMs?: number; settleMs?: number; onUpdate?: (m: Message) => void };

/** Keeps a long page-side wait alive and ticks its clock each second; the page gives up if the heartbeats stop. */
async function withHeartbeat<T>(cdp: CDP, fn: (beat: string) => Promise<T>): Promise<T> {
  const beat = `beat_${process.pid}_${Date.now()}`;
  const name = JSON.stringify(beat);
  const touch = () =>
    cdp.eval(`{ const g = (window.__grokbot = window.__grokbot || {}); g[${name}] = Date.now(); g.ticks?.[${name}]?.(); }`).catch(() => {});
  await touch();
  const iv = setInterval(touch, 1000);
  try {
    return await fn(beat);
  } finally {
    clearInterval(iv);
  }
}

/**
 * Wait until a Bot finishes replying to a message (default: the latest one from you) and
 * return its replies. A Bot may answer in several parts with short idle gaps; it counts as
 * finished after `settleMs` without activity. Stops early with "needs_input" when the Bot is
 * waiting on you in the app. On timeout the replies so far are returned and the Bot keeps going.
 */
export async function wait(cdp: CDP, botQuery: string, opts: WaitOptions = {}): Promise<WaitResult> {
  const bot = await findBot(cdp, botQuery);
  const sink = opts.onUpdate ? await cdp.bind((p) => opts.onUpdate?.(JSON.parse(p))) : null;
  const r = await withHeartbeat(cdp, (beat) =>
    cdp.call<Omit<WaitResult, "bot">>(
      PAGE_WAIT,
      bot.id,
      opts.since ?? null,
      opts.timeoutMs ?? 1_800_000,
      opts.settleMs ?? 8_000,
      beat,
      sink,
    ),
  );
  return { bot: bot.name, ...r };
}

/** Send a message and wait for the Bot to finish replying. */
export async function ask(cdp: CDP, botQuery: string, text: string, opts: WaitOptions & { files?: string[] } = {}): Promise<AskResult> {
  const t0 = Date.now();
  const sent = await send(cdp, botQuery, text, opts.files);
  const r = await wait(cdp, sent.bot, {
    ...opts,
    since: sent.key,
    timeoutMs: Math.max(1000, (opts.timeoutMs ?? 300_000) - (Date.now() - t0)),
  });
  return { ...r, key: sent.key, elapsedMs: Date.now() - t0 };
}

/** Stream new Bot messages and working/idle/needs_input changes until the process exits. */
export async function watch(cdp: CDP, botQuery: string | null, onEvent: (e: BotEvent) => void, settleMs = 8_000): Promise<void> {
  const only = botQuery ? (await findBot(cdp, botQuery)).id : null;
  await cdp.send("Runtime.enable");
  const sink = await cdp.bind((p) => onEvent(JSON.parse(p)));
  await withHeartbeat(cdp, (beat) => cdp.call(PAGE_WATCH, only, settleMs, beat, sink));
}

/** Interrupt what a Bot is doing, like the Stop button. Returns false if it wasn't working. */
export async function stop(cdp: CDP, botQuery: string): Promise<{ bot: string; stopped: boolean }> {
  const bot = await findBot(cdp, botQuery);
  return { bot: bot.name, stopped: await cdp.call<boolean>(PAGE_STOP, bot.id) };
}

export type Usage = {
  /** Share of the weekly included usage spent, 0–100. */
  percentUsed: number;
  resetsAt: string | null;
  plan: string | null;
  hasAvailableUsage: boolean;
  onDemand: { enabled: boolean; usedCents: number; limitCents: number | null } | null;
};

/** The weekly usage limit shown in Grok Bot's settings, read from the app's own read-only getter. */
export async function usage(cdp: CDP): Promise<Usage> {
  type Summary = {
    sandUsagePercent?: number;
    sandUsageResetTimestampMs?: number;
    grokPlanLabel?: string;
    hasAvailableUsage?: boolean;
    onDemand?: { usedCents?: number; limitCents?: number | null } | null;
    onDemandSettings?: { enabled?: boolean };
  };
  const get = () =>
    cdp.call<Summary | null>(
      `async () => { const m = window.desktop?.main; return m?.getCursorUsageSummary ? await m.getCursorUsageSummary() : null; }`,
    );
  // The app fetches this from its backend, which sometimes answers with a transient 5xx.
  const s = await get().catch(async (e) => {
    await sleep(2000);
    return get().catch(() => {
      throw new Error(`Couldn't read usage from Grok Bot: ${(e as Error).message}`);
    });
  });
  if (!s || typeof s.sandUsagePercent !== "number") throw new Error("Couldn't read usage. This Grok Bot version may not support it.");
  return {
    percentUsed: Math.round(s.sandUsagePercent * 100) / 100,
    resetsAt: s.sandUsageResetTimestampMs ? new Date(s.sandUsageResetTimestampMs).toISOString() : null,
    plan: s.grokPlanLabel ?? null,
    hasAvailableUsage: s.hasAvailableUsage !== false,
    onDemand: s.onDemand
      ? { enabled: !!s.onDemandSettings?.enabled, usedCents: s.onDemand.usedCents ?? 0, limitCents: s.onDemand.limitCents ?? null }
      : null,
  };
}

/** Basic health info for `grokbot status`. */
export async function status(cdp: CDP): Promise<{ bots: Bot[]; busy: boolean; usage: Usage | null }> {
  const bots = await listBots(cdp);
  return { bots, busy: bots.some((b) => b.running), usage: await usage(cdp).catch(() => null) };
}
