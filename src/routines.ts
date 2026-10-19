// A Bot's routines: saved prompts the Bot runs on a schedule.
//
// Changes go through the Bot itself: a message asks it to use its own routine tools. That works while
// Grok Bot has put the Bot's computer to sleep (see BOX_PHASE in page.ts) and never needs the Grok Bot
// window in front. Routines added through the app's store from here didn't persist in testing, so the
// store is only used to read routines and to run one now, and only while the computer is awake.
import { ask, findBot, type Message, type WaitOptions, type WaitStatus } from "./bot.ts";
import type { CDP } from "./cdp.ts";
import { BOX_PHASE, PAGE_ERROR, store } from "./page.ts";

export type Routine = {
  id: string;
  name: string;
  prompt: string;
  /** e.g. "cron 0 9 * * 1-5", "webhook", "email". */
  trigger: string;
  enabled: boolean;
  lastRun: { at: string | null; status: string | null; trigger: string | null } | null;
};
export type RoutineSpec = { name: string; prompt: string; schedule: string; enabled?: boolean };

// Reads the Bot's routines through the app's store, or runs one now. Errors come back as values.
const PAGE_ROUTINES = `async (op, id, arg) => {
  const phase = ${BOX_PHASE};
  if (phase !== "settled") return { asleep: phase || "unknown" };
  const routines = ${store("automations", "snapshotsFor")};
  if (!routines) return { error: "Couldn't reach Grok Bot's routines. This app version may not support them." };
  const errorText = ${PAGE_ERROR};
  const iso = (ms) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : typeof ms === "string" ? ms : null);
  const trigger = (t) => !t ? "" : t.type === "cron" ? "cron " + t.schedule : t.type === "group" ? (t.listeners || []).map(trigger).join(" + ") : t.type;
  const toRoutine = (a) => {
    const runs = Array.isArray(a.runs) ? a.runs : [];
    const last = runs.slice().sort((x, y) => (Date.parse(iso(y.startedAt ?? y.createdAt ?? y.at) || "") || 0) - (Date.parse(iso(x.startedAt ?? x.createdAt ?? x.at) || "") || 0))[0];
    const spec = a.spec || a;
    return { id: a.id, name: spec.name ?? a.name ?? "", prompt: spec.prompt ?? a.prompt ?? "", trigger: trigger(spec.trigger ?? a.trigger),
      enabled: (a.isEnabled ?? spec.isEnabled ?? a.enabled) !== false,
      lastRun: last ? { at: iso(last.startedAt ?? last.createdAt ?? last.at), status: last.status ?? last.state ?? last.outcome ?? null, trigger: last.trigger ?? null } : null };
  };
  routines.connect();
  const snaps = routines.snapshotsFor(id);
  const unsubscribe = snaps.subscribe(() => {});
  const installed = () => { const s = snaps.get() || {}; return s.installed ?? (s.value && s.value.installed) ?? (Array.isArray(s.value) ? s.value : []); };
  try {
    routines.refresh(id);
    for (const t0 = Date.now(); ; await new Promise((r) => setTimeout(r, 200))) {
      const s = snaps.get() || {};
      if (s.status !== "loading" && s.status !== "idle") {
        if (s.status === "failed") throw new Error("Couldn't load routines: " + errorText(s.failure || s.error || "failed"));
        break;
      }
      if (Date.now() - t0 > 20000) throw new Error("Timed out loading routines.");
    }
    // The computer can fall asleep while loading, which also reads as no routines.
    if (${BOX_PHASE} !== "settled") return { asleep: ${BOX_PHASE} || "unknown" };
    if (op === "list") return { value: installed().map(toRoutine) };
    if (op === "run") {
      const target = installed().find((a) => a.id === arg);
      if (!target) return { error: "That routine is gone." };
      await routines.runNow(id, target.id);
      return { value: toRoutine(target) };
    }
    return { error: "Unknown routines operation " + op };
  } catch (e) {
    return { error: errorText(e) };
  } finally {
    unsubscribe();
  }
}`;

function asleepMessage(bot: string, phase: string): string {
  return `${bot}'s computer is asleep (Grok Bot phase "${phase}"), so Grok Bot can't show its routines right now. It wakes the next time you open Grok Bot. Routine changes still work: they go through the Bot.`;
}

async function pageOp<T>(cdp: CDP, op: "list" | "run", bot: { id: string; name: string }, arg?: string): Promise<T> {
  const r = await cdp.call<{ value?: T; error?: string; asleep?: string }>(PAGE_ROUTINES, op, bot.id, arg ?? null);
  if (r.asleep !== undefined) {
    throw new Error(
      op === "run"
        ? `${bot.name}'s computer is asleep, and Bots can't start a routine on demand. It will run on its schedule, or run this again after you next open Grok Bot.`
        : asleepMessage(bot.name, r.asleep),
    );
  }
  if (r.error !== undefined) throw new Error(r.error);
  return r.value as T;
}

/** List a Bot's routines. Needs the Bot's computer awake; throws a clear error when it's asleep. */
export async function listRoutines(cdp: CDP, botQuery: string): Promise<{ bot: string; routines: Routine[] }> {
  const bot = await findBot(cdp, botQuery);
  return { bot: bot.name, routines: await pageOp<Routine[]>(cdp, "list", bot) };
}

/** Match a routine by id or exact name, or by unique name prefix. */
function matchRoutine(routines: Routine[], query: string): Routine {
  const q = query.trim().toLowerCase();
  const hits = routines.filter((r) => r.id === query.trim() || r.name.toLowerCase() === q);
  if (hits.length === 1) return hits[0];
  const partial = hits.length ? [] : routines.filter((r) => r.name.toLowerCase().startsWith(q));
  if (partial.length === 1) return partial[0];
  const names = routines.map((r) => `${r.name} (${r.id})`).join(", ") || "none";
  throw new Error(
    hits.length + partial.length > 1
      ? `"${query}" matches several routines. Use the id: ${names}`
      : `No routine "${query}". Routines: ${names}`,
  );
}

/** Run a routine now. Only possible while the Bot's computer is awake. */
export async function runRoutine(cdp: CDP, botQuery: string, routineQuery: string): Promise<{ bot: string; routine: Routine }> {
  const bot = await findBot(cdp, botQuery);
  const target = matchRoutine(await pageOp<Routine[]>(cdp, "list", bot), routineQuery);
  return { bot: bot.name, routine: await pageOp<Routine>(cdp, "run", bot, target.id) };
}

export type RoutineChange = "add" | "enable" | "disable" | "remove";
export type RoutineChangeResult = {
  bot: string;
  /** The Bot's turn: "needs_input" means it's waiting for the user to approve the change in Grok Bot. */
  status: WaitStatus;
  /** True only when the Bot confirmed the change. */
  ok: boolean;
  routine: { id?: string; name?: string; schedule?: string; enabled?: boolean } | null;
  error: string | null;
  /** The Bot's reply, without the result line. */
  reply: string;
  key: string;
};

const RESULT_TAG = "GROKBOT_RESULT";

function instruction(change: RoutineChange, target: string | RoutineSpec): string {
  const q = (s: string) => JSON.stringify(s);
  const match = (s: string) =>
    `the routine whose id or name is exactly ${q(s)} (name match ignores case). If no routine or more than one matches, change nothing and say so`;
  if (change === "add") {
    const s = target as RoutineSpec;
    return [
      "Create a routine with these exact settings:",
      `- Name: ${q(s.name)}`,
      `- Schedule (cron): ${q(s.schedule)}`,
      `- State: ${s.enabled === false ? "paused" : "active"}`,
      `- Prompt, used word for word: ${q(s.prompt)}`,
    ].join("\n");
  }
  const verb = { enable: "Resume (turn on)", disable: "Pause (turn off)", remove: "Delete" }[change];
  return `${verb} ${match(target as string)}.`;
}

function parseResult(messages: Message[]): { result: Record<string, unknown> | null; reply: string } {
  const text = messages
    .filter((m) => m.role === "assistant" && m.text)
    .map((m) => m.text)
    .join("\n");
  let result: Record<string, unknown> | null = null;
  const lines = text.split("\n");
  for (const line of lines) {
    const at = line.indexOf(RESULT_TAG);
    if (at < 0) continue;
    try {
      const v = JSON.parse(
        line
          .slice(at + RESULT_TAG.length)
          .trim()
          .replace(/^`+|`+$/g, ""),
      );
      if (v && typeof v === "object") result = v;
    } catch {}
  }
  return {
    result,
    reply: lines
      .filter((l) => !l.includes(RESULT_TAG))
      .join("\n")
      .trim(),
  };
}

/**
 * Add, turn on, turn off or delete a routine by asking the Bot to do it with its own routine tools.
 * Works while the Bot's computer is asleep. It's one short Bot turn, so it uses a little of the
 * user's weekly usage, and Grok Bot may ask the user to approve the change ("Allow <Bot> to save a
 * routine?"), which comes back as status "needs_input".
 */
export async function changeRoutine(
  cdp: CDP,
  botQuery: string,
  change: RoutineChange,
  target: string | RoutineSpec,
  opts: Pick<WaitOptions, "timeoutMs" | "settleMs" | "onUpdate"> = {},
): Promise<RoutineChangeResult> {
  if (change === "add") {
    const s = target as RoutineSpec;
    const spec = { ...s, name: s.name.trim(), prompt: s.prompt.trim(), schedule: s.schedule.trim() };
    if (!spec.name || !spec.prompt || !spec.schedule) throw new Error("A routine needs a name, a prompt and a schedule.");
    if (spec.schedule.split(/\s+/).length !== 5) throw new Error(`"${spec.schedule}" isn't a 5-field cron schedule, e.g. "0 9 * * 1-5".`);
    target = spec;
  } else if (!(target as string).trim()) {
    throw new Error("Which routine? Give its name or id.");
  }
  const message = [
    "Request from grokbot, the command-line tool the user runs on their Mac. Use your routine tools and change nothing else.",
    "",
    instruction(change, target),
    "",
    `When you're done, end your reply with exactly one line: ${RESULT_TAG} followed by JSON, either {"ok":true,"routine":{"id":"…","name":"…","schedule":"…","enabled":true}} or {"ok":false,"error":"what went wrong"}.`,
  ].join("\n");
  const r = await ask(cdp, botQuery, message, { timeoutMs: 300_000, ...opts });
  const { result, reply } = parseResult(r.messages);
  const routine = result && typeof result.routine === "object" ? (result.routine as RoutineChangeResult["routine"]) : null;
  const ok = r.status === "done" && result?.ok === true;
  const error = ok
    ? null
    : typeof result?.error === "string"
      ? result.error
      : r.status === "needs_input"
        ? `${r.bot} is waiting for you to approve the change in Grok Bot.`
        : r.status === "timeout"
          ? `${r.bot} hasn't finished yet. Run \`grokbot wait ${r.bot}\` to see its reply.`
          : `${r.bot} didn't confirm the change. Check its reply.`;
  return { bot: r.bot, status: r.status, ok, routine, error, reply, key: r.key };
}
