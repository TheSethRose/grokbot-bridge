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
  constructor(ws) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
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
  async pressKey(key, shift = false) {
    const base = { key, code: key, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: shift ? 8 : 0 };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: shift ? undefined : "\r" });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
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
var SEL = {
  agentItem: ".sand-agent-item[data-agent-id]",
  prompt: '.sand-prompt-field[aria-label="Prompt"], [role="textbox"].ProseMirror',
  row: ".sand-transcript-row[data-row-key]",
  busy: '[data-grok-state]:not([data-grok-state="idle"])'
};
var sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
var PAGE_LIST_BOTS = `(sel) => [...document.querySelectorAll(sel)].map((e) => {
  const label = e.getAttribute("aria-label") || e.innerText.trim();
  return { id: e.dataset.agentId, label, name: label.split(", ")[0].trim(), active: e.dataset.active === "true",
    preview: e.getAttribute("aria-description") };
})`;
var PAGE_ROWS = `(rowSel) => {
  const withLinks = (el) => {
    let text = el.innerText.trim(), from = 0;
    const links = [];
    for (const a of el.querySelectorAll("a[href]")) {
      const href = a.href, label = a.innerText.trim();
      if (!/^https?:/.test(href)) continue;
      links.push(href);
      if (!label || label === href) continue;
      const at = text.indexOf(label, from);
      if (at < 0) continue;
      const md = "[" + label + "](" + href + ")";
      text = text.slice(0, at) + md + text.slice(at + label.length);
      from = at + md.length;
    }
    return { text, links };
  };
  return [...document.querySelectorAll(rowSel)].flatMap((r) => {
    const key = r.dataset.rowKey;
    if (key.endsWith(":timestamp")) return [];
    const m = r.querySelector("[data-role]");
    const role = m ? m.dataset.role : "card";
    const prose = [...r.querySelectorAll(".sand-message-prose")].map(withLinks).filter((p) => p.text);
    const body = prose.length ? { text: prose.map((p) => p.text).join("\\n\\n"), links: prose.flatMap((p) => p.links) } : withLinks(m || r);
    return [{ key, role: role === "user" || role === "assistant" ? role : "card", text: body.text, links: [...new Set(body.links)] }];
  });
}`;
async function listBots(cdp) {
  const bots = await cdp.call(PAGE_LIST_BOTS, SEL.agentItem);
  if (!bots.length)
    throw new Error("No Bots found in the sidebar. Is Grok Bot signed in and showing its main window?");
  return bots;
}
function matchBot(bots, query) {
  const q = query.trim().toLowerCase();
  const exact = bots.filter((b) => b.id === query || b.name.toLowerCase() === q || b.label.toLowerCase() === q);
  if (exact.length === 1)
    return exact[0];
  const partial = bots.filter((b) => b.name.toLowerCase().startsWith(q));
  if (exact.length === 0 && partial.length === 1)
    return partial[0];
  const names = bots.map((b) => b.name).join(", ");
  throw new Error(exact.length + partial.length > 1 ? `"${query}" matches several Bots: ${names}` : `No Bot named "${query}". Bots: ${names}`);
}
async function openBot(cdp, query) {
  const bot = matchBot(await listBots(cdp), query);
  if (!bot.active) {
    await cdp.call(`(sel, id) => document.querySelector(sel + '[data-agent-id="' + id + '"]').click()`, SEL.agentItem, bot.id);
  }
  let last = "";
  let stable = 0;
  for (let i = 0;i < 40 && stable < 3; i++) {
    await sleep2(200);
    const snap = await cdp.call(`(sel, rowSel, prompt, id) => { const a = document.querySelector(sel + '[data-active="true"]');
        return (a && a.dataset.agentId === id && document.querySelector(prompt)) ? [...document.querySelectorAll(rowSel)].map(r => r.dataset.rowKey).join("|") : "" }`, SEL.agentItem, SEL.row, SEL.prompt, bot.id);
    stable = snap && snap === last ? stable + 1 : 0;
    last = snap;
  }
  if (!last)
    throw new Error(`Couldn't open ${bot.name}'s conversation.`);
  return { ...bot, active: true };
}
async function readVisible(cdp) {
  return cdp.call(PAGE_ROWS, SEL.row);
}
async function read(cdp, botQuery, limit = 10) {
  const bot = await openBot(cdp, botQuery);
  await cdp.call(`() => { const log = document.querySelector('[role="log"]'); if (log) log.scrollTop = log.scrollHeight; }`);
  await sleep2(300);
  const msgs = await readVisible(cdp);
  return { bot: bot.name, messages: msgs.slice(-limit) };
}
async function sendToOpen(cdp, text) {
  const before = new Set((await readVisible(cdp)).map((m) => m.key));
  const focused = await cdp.call(`(sel) => { const f = document.querySelector(sel); if (!f) return false; f.focus(); return true; }`, SEL.prompt);
  if (!focused)
    throw new Error("Message box not found.");
  const existing = await cdp.call(`(sel) => document.querySelector(sel).innerText.trim()`, SEL.prompt);
  if (existing)
    throw new Error("The message box already has a draft in it. Send or clear it in Grok Bot first.");
  const lines = text.replace(/\r\n/g, `
`).split(`
`);
  for (let i = 0;i < lines.length; i++) {
    if (lines[i])
      await cdp.send("Input.insertText", { text: lines[i] });
    if (i < lines.length - 1)
      await cdp.pressKey("Enter", true);
  }
  await sleep2(150);
  await cdp.pressKey("Enter");
  for (let i = 0;i < 50; i++) {
    await sleep2(200);
    const sent = (await readVisible(cdp)).find((m) => m.role === "user" && !before.has(m.key));
    if (sent)
      return sent.key;
  }
  throw new Error("The message didn't appear in the conversation after sending.");
}
async function send(cdp, botQuery, text) {
  if (!text.trim())
    throw new Error("Message is empty.");
  const bot = await openBot(cdp, botQuery);
  return { bot: bot.name, key: await sendToOpen(cdp, text) };
}
async function ask(cdp, botQuery, text, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 300000;
  const settleMs = opts.settleMs ?? 8000;
  const t0 = Date.now();
  const target = await openBot(cdp, botQuery);
  const sentKey = await sendToOpen(cdp, text);
  const bot = target.name;
  const replies = new Map;
  let idleSince = null;
  while (Date.now() - t0 < timeoutMs) {
    await sleep2(700);
    const activeId = await cdp.call(`(sel) => document.querySelector(sel + '[data-active="true"]')?.dataset.agentId ?? null`, SEL.agentItem);
    if (activeId !== target.id) {
      return { bot, status: "interrupted", messages: [...replies.values()], elapsedMs: Date.now() - t0 };
    }
    const rows = await readVisible(cdp);
    const idx = rows.findIndex((m) => m.key === sentKey);
    const after = idx >= 0 ? rows.slice(idx + 1) : rows;
    for (const m of after) {
      if (m.role === "user")
        continue;
      const prev = replies.get(m.key);
      if (!prev || prev.text !== m.text) {
        replies.set(m.key, m);
        opts.onUpdate?.(m);
      }
    }
    const busy = await cdp.call(`(sel) => !!document.querySelector(sel)`, SEL.busy);
    if (busy || replies.size === 0)
      idleSince = null;
    else
      idleSince ??= Date.now();
    if (idleSince !== null && Date.now() - idleSince >= settleMs) {
      return { bot, status: "done", messages: [...replies.values()], elapsedMs: Date.now() - t0 };
    }
  }
  return { bot, status: "timeout", messages: [...replies.values()], elapsedMs: Date.now() - t0 };
}
async function status(cdp) {
  const bots = await listBots(cdp);
  const busy = await cdp.call(`(sel) => !!document.querySelector(sel)`, SEL.busy);
  return { bots, busy };
}

// src/mcp.ts
import { createInterface } from "node:readline";

// src/version.ts
var VERSION = "0.1.0";

// src/mcp.ts
var TOOLS = [
  {
    name: "grokbot_list_bots",
    description: "List the Grok Bots in the user's Grok Bot desktop app (name, role label, id, whether open).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "grokbot_ask",
    description: "Send a message to a Grok Bot and wait for its reply. Bots run on a cloud computer with a browser and can research the web and X, use connected apps, and do multi-step work. Returns the Bot's reply messages. If the Bot is still working at the timeout, returns what it has so far with status 'timeout'; call grokbot_read later for the rest.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string", description: "Bot name (e.g. 'Chief') or id" },
        message: { type: "string", description: "The message to send, written like a request to a teammate" },
        timeout_seconds: { type: "number", description: "Max seconds to wait for replies (default 300, max 1800)" },
        settle_seconds: { type: "number", description: "Idle seconds before the reply counts as finished (default 8)" }
      },
      required: ["bot", "message"],
      additionalProperties: false
    }
  },
  {
    name: "grokbot_send",
    description: "Send a message to a Grok Bot without waiting for a reply. Use grokbot_read later to collect it.",
    inputSchema: {
      type: "object",
      properties: { bot: { type: "string" }, message: { type: "string" } },
      required: ["bot", "message"],
      additionalProperties: false
    }
  },
  {
    name: "grokbot_read",
    description: "Read the most recent messages in a Grok Bot conversation.",
    inputSchema: {
      type: "object",
      properties: { bot: { type: "string" }, limit: { type: "number", description: "Max messages (default 10)" } },
      required: ["bot"],
      additionalProperties: false
    }
  }
];
var queue = Promise.resolve();
function serialized(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}
async function withApp(fn) {
  await launch();
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
  switch (name) {
    case "grokbot_list_bots":
      return withApp((c) => listBots(c));
    case "grokbot_ask": {
      const t = Math.min(Math.max(Number(args.timeout_seconds ?? 300), 10), 1800);
      const settle = Math.min(Math.max(Number(args.settle_seconds ?? 8), 2), 120);
      return withApp((c) => ask(c, str("bot"), str("message"), { timeoutMs: t * 1000, settleMs: settle * 1000 }));
    }
    case "grokbot_send":
      return withApp((c) => send(c, str("bot"), str("message")));
    case "grokbot_read":
      return withApp((c) => read(c, str("bot"), Number(args.limit ?? 10)));
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
            const out = await serialized(() => callTool(params?.name ?? "", params?.arguments ?? {}));
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
  grokbot send <bot> <message...>   Send without waiting
  grokbot read <bot>                Show recent messages in a conversation
  grokbot bots                      List your Bots
  grokbot status                    Check the connection
  grokbot launch                    (Re)start Grok Bot with the local debug port
  grokbot restore                   Restart Grok Bot normally (closes the port)
  grokbot mcp                       Run as an MCP server over stdio

Options:
  --timeout <sec>   ask: max seconds to wait (default 300)
  --settle <sec>    ask: idle seconds before the reply counts as finished (default 8)
  --limit <n>       read: number of messages (default 10)
  --json            Machine-readable output
  --quiet           ask: don't stream progress to stderr
  -v, --version     Print version
  -h, --help        Show this help

Use "-" as the message to read it from stdin.
Env: GROKBOT_CDP_PORT (default 9333), GROKBOT_APP (path to the app)`;
function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0;i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "--quiet")
      flags[a.slice(2)] = true;
    else if (a === "--timeout" || a === "--limit" || a === "--settle")
      flags[a.slice(2)] = argv[++i] ?? "";
    else if (a === "-h" || a === "--help")
      flags.help = true;
    else if (a === "-v" || a === "--version")
      flags.version = true;
    else
      rest.push(a);
  }
  return { flags, cmd: rest[0], args: rest.slice(1) };
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
function positiveNumber(v, name, fallback) {
  if (v === undefined)
    return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`--${name} must be a positive number`);
  return n;
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
  const { flags, cmd, args } = parse(process.argv.slice(2));
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
        return out({ connected: true, port, ...s }, () => `Connected on port ${port}. ${s.bots.length} Bot(s): ${s.bots.map((b) => b.name).join(", ")}${s.busy ? " · a Bot is working" : ""}`);
      } finally {
        cdp.close();
      }
    }
    case "bots": {
      const bots = await withApp2(listBots);
      return out(bots, () => bots.map((b) => `${b.active ? "*" : " "} ${b.label}  (${b.id})`).join(`
`));
    }
    case "read": {
      const [bot] = args;
      if (!bot)
        throw new Error("Usage: grokbot read <bot>");
      const r = await withApp2((c) => read(c, bot, positiveNumber(flags.limit, "limit", 10)));
      return out(r, () => r.messages.map((m) => `[${m.role === "user" ? "you" : m.role === "card" ? "card" : r.bot}] ${m.text}`).join(`

`));
    }
    case "send": {
      const [bot, ...rest] = args;
      const msg = await readMessage(rest);
      if (!bot || !msg)
        throw new Error("Usage: grokbot send <bot> <message...>");
      const r = await withApp2((c) => send(c, bot, msg));
      return out(r, () => `Sent to ${r.bot}.`);
    }
    case "ask": {
      const [bot, ...rest] = args;
      const msg = await readMessage(rest);
      if (!bot || !msg)
        throw new Error("Usage: grokbot ask <bot> <message...>");
      const timeoutMs = positiveNumber(flags.timeout, "timeout", 300) * 1000;
      const r = await withApp2((c) => ask(c, bot, msg, {
        timeoutMs,
        settleMs: positiveNumber(flags.settle, "settle", 8) * 1000,
        onUpdate: flags.quiet ? undefined : (m) => console.error(`[grokbot] ${m.role === "card" ? "card" : "reply"}: ${m.text.slice(0, 100).replace(/\s+/g, " ")}`)
      }));
      out(r, () => {
        const body = r.messages.map((m) => m.role === "card" ? `[card] ${m.text}` : m.text).join(`

`);
        const tail = r.status === "done" ? "" : `

[grokbot] ${r.status === "timeout" ? `Still working after ${Math.round(r.elapsedMs / 1000)}s. Run \`grokbot read ${r.bot}\` later.` : "The conversation was switched in the app before the reply finished."}`;
        return (body || "(no reply yet)") + tail;
      });
      if (r.status !== "done")
        process.exitCode = 2;
      return;
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
