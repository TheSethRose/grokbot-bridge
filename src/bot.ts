// Talk to Grok Bots through the desktop app's own UI.
// Selectors below come from the app's renderer (Grok Bot 0.71.x). They are the
// only part likely to break on an app update; keep them together.
import type { CDP } from "./cdp.ts";

const SEL = {
  agentItem: ".sand-agent-item[data-agent-id]",
  prompt: '.sand-prompt-field[aria-label="Prompt"], [role="textbox"].ProseMirror',
  row: ".sand-transcript-row[data-row-key]",
  // Bot activity marks cycle working → running (tools) → streaming (typing) → idle.
  busy: '[data-grok-state]:not([data-grok-state="idle"])',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Bot = { id: string; name: string; label: string; active: boolean; preview: string | null };
/** `text` keeps links as Markdown (`[label](url)`); `links` lists every URL in the message. */
export type Message = { key: string; role: "user" | "assistant" | "card"; text: string; links: string[] };
export type AskResult = { bot: string; status: "done" | "timeout" | "interrupted"; messages: Message[]; elapsedMs: number };

// ---- page-side helpers (run inside the renderer) ----

const PAGE_LIST_BOTS = `(sel) => [...document.querySelectorAll(sel)].map((e) => {
  const label = e.getAttribute("aria-label") || e.innerText.trim();
  return { id: e.dataset.agentId, label, name: label.split(", ")[0].trim(), active: e.dataset.active === "true",
    preview: e.getAttribute("aria-description") };
})`;

// innerText keeps the rendered line breaks; anchors are then rewritten in place as Markdown links.
const PAGE_ROWS = `(rowSel) => {
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

// ---- public API ----

export async function listBots(cdp: CDP): Promise<Bot[]> {
  const bots = await cdp.call<Bot[]>(PAGE_LIST_BOTS, SEL.agentItem);
  if (!bots.length) throw new Error("No Bots found in the sidebar. Is Grok Bot signed in and showing its main window?");
  return bots;
}

function matchBot(bots: Bot[], query: string): Bot {
  const q = query.trim().toLowerCase();
  const exact = bots.filter((b) => b.id === query || b.name.toLowerCase() === q || b.label.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const partial = bots.filter((b) => b.name.toLowerCase().startsWith(q));
  if (exact.length === 0 && partial.length === 1) return partial[0];
  const names = bots.map((b) => b.name).join(", ");
  throw new Error(
    exact.length + partial.length > 1 ? `"${query}" matches several Bots: ${names}` : `No Bot named "${query}". Bots: ${names}`,
  );
}

/** Open a Bot's conversation and wait for its transcript to settle. */
export async function openBot(cdp: CDP, query: string): Promise<Bot> {
  const bot = matchBot(await listBots(cdp), query);
  if (!bot.active) {
    await cdp.call(`(sel, id) => document.querySelector(sel + '[data-agent-id="' + id + '"]').click()`, SEL.agentItem, bot.id);
  }
  let last = "";
  let stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    await sleep(200);
    const snap = await cdp.call<string>(
      `(sel, rowSel, prompt, id) => { const a = document.querySelector(sel + '[data-active="true"]');
        return (a && a.dataset.agentId === id && document.querySelector(prompt)) ? [...document.querySelectorAll(rowSel)].map(r => r.dataset.rowKey).join("|") : "" }`,
      SEL.agentItem,
      SEL.row,
      SEL.prompt,
      bot.id,
    );
    stable = snap && snap === last ? stable + 1 : 0;
    last = snap;
  }
  if (!last) throw new Error(`Couldn't open ${bot.name}'s conversation.`);
  return { ...bot, active: true };
}

/** Messages currently rendered in the open conversation (the list is virtualized, so this is the recent tail). */
export async function readVisible(cdp: CDP): Promise<Message[]> {
  return cdp.call<Message[]>(PAGE_ROWS, SEL.row);
}

export async function read(cdp: CDP, botQuery: string, limit = 10): Promise<{ bot: string; messages: Message[] }> {
  const bot = await openBot(cdp, botQuery);
  await cdp.call(`() => { const log = document.querySelector('[role="log"]'); if (log) log.scrollTop = log.scrollHeight; }`);
  await sleep(300);
  const msgs = await readVisible(cdp);
  return { bot: bot.name, messages: msgs.slice(-limit) };
}

/** Type a message into the open conversation and send it. Returns the key of the sent row. */
async function sendToOpen(cdp: CDP, text: string): Promise<string> {
  const before = new Set((await readVisible(cdp)).map((m) => m.key));
  const focused = await cdp.call<boolean>(
    `(sel) => { const f = document.querySelector(sel); if (!f) return false; f.focus(); return true; }`,
    SEL.prompt,
  );
  if (!focused) throw new Error("Message box not found.");
  const existing = await cdp.call<string>(`(sel) => document.querySelector(sel).innerText.trim()`, SEL.prompt);
  if (existing) throw new Error("The message box already has a draft in it. Send or clear it in Grok Bot first.");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await cdp.send("Input.insertText", { text: lines[i] });
    if (i < lines.length - 1) await cdp.pressKey("Enter", true);
  }
  await sleep(150);
  await cdp.pressKey("Enter");
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const sent = (await readVisible(cdp)).find((m) => m.role === "user" && !before.has(m.key));
    if (sent) return sent.key;
  }
  throw new Error("The message didn't appear in the conversation after sending.");
}

export async function send(cdp: CDP, botQuery: string, text: string): Promise<{ bot: string; key: string }> {
  if (!text.trim()) throw new Error("Message is empty.");
  const bot = await openBot(cdp, botQuery);
  return { bot: bot.name, key: await sendToOpen(cdp, text) };
}

export type AskOptions = { timeoutMs?: number; settleMs?: number; onUpdate?: (m: Message) => void };

/**
 * Send a message and collect the Bot's replies until it goes idle.
 * A Bot may answer in several parts or keep working for a long time; on timeout
 * the replies so far are returned with status "timeout" and the Bot keeps going.
 */
export async function ask(cdp: CDP, botQuery: string, text: string, opts: AskOptions = {}): Promise<AskResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  // Covers brief idle gaps between a Bot's turns, such as after an acknowledgment.
  const settleMs = opts.settleMs ?? 8_000;
  const t0 = Date.now();
  const target = await openBot(cdp, botQuery);
  const sentKey = await sendToOpen(cdp, text);
  const bot = target.name;

  const replies = new Map<string, Message>();
  let idleSince: number | null = null;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(700);
    const activeId = await cdp.call<string | null>(
      `(sel) => document.querySelector(sel + '[data-active="true"]')?.dataset.agentId ?? null`,
      SEL.agentItem,
    );
    if (activeId !== target.id) {
      // Someone switched conversations in the app; rows on screen now belong to another Bot.
      return { bot, status: "interrupted", messages: [...replies.values()], elapsedMs: Date.now() - t0 };
    }
    const rows = await readVisible(cdp);
    const idx = rows.findIndex((m) => m.key === sentKey);
    // The transcript is virtualized; once our row scrolls out, every row on screen is newer.
    const after = idx >= 0 ? rows.slice(idx + 1) : rows;
    for (const m of after) {
      if (m.role === "user") continue;
      const prev = replies.get(m.key);
      if (!prev || prev.text !== m.text) {
        replies.set(m.key, m);
        opts.onUpdate?.(m);
      }
    }
    const busy = await cdp.call<boolean>(`(sel) => !!document.querySelector(sel)`, SEL.busy);
    if (busy || replies.size === 0) idleSince = null;
    else idleSince ??= Date.now();
    if (idleSince !== null && Date.now() - idleSince >= settleMs) {
      return { bot, status: "done", messages: [...replies.values()], elapsedMs: Date.now() - t0 };
    }
  }
  return { bot, status: "timeout", messages: [...replies.values()], elapsedMs: Date.now() - t0 };
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
  const busy = await cdp.call<boolean>(`(sel) => !!document.querySelector(sel)`, SEL.busy);
  return { bots, busy, usage: await usage(cdp).catch(() => null) };
}
