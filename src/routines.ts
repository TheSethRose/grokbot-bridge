// A Bot's routines: saved prompts the Bot runs on a schedule or trigger, managed through the
// app's own routines store (see page.ts). Writes go to the Bot's cloud computer.
import { findBot } from "./bot.ts";
import type { CDP } from "./cdp.ts";
import { PAGE_AWAKE, PAGE_ERROR, store } from "./page.ts";

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

// Loads the Bot's routines into the store, then runs one operation. Errors come back as values.
const PAGE_ROUTINES = `async (op, id, arg) => {
  const routines = ${store("automations", "snapshotsFor")};
  if (!routines) return { error: "Couldn't reach Grok Bot's routines. This app version may not support them." };
  const errorText = ${PAGE_ERROR};
  const awake = ${PAGE_AWAKE};
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
  const load = async () => {
    routines.refresh(id);
    for (const t0 = Date.now(); ; await new Promise((r) => setTimeout(r, 200))) {
      const s = snaps.get() || {};
      if (s.status !== "loading" && s.status !== "idle") {
        if (s.status === "failed") throw new Error("Couldn't load routines: " + errorText(s.failure || s.error || "failed"));
        return;
      }
      if (Date.now() - t0 > 20000) throw new Error("Timed out loading routines.");
    }
  };
  try {
    await load();
    if (op === "list") return { value: installed().map(toRoutine) };
    if (op === "add") {
      const before = new Set(installed().map((a) => a.id));
      const res = await awake(id, () => routines.create(id, arg));
      await load();
      const added = installed().find((a) => !before.has(a.id)) || (res && res.id ? res : null);
      return { value: added ? toRoutine(added) : null };
    }
    const target = installed().find((a) => a.id === arg.routine);
    if (!target) return { error: "That routine is gone." };
    if (op === "run") await awake(id, () => routines.runNow(id, target.id));
    else if (op === "enable" || op === "disable") await awake(id, () => routines.setEnabled(id, target.id, op === "enable"));
    else if (op === "remove") await awake(id, () => routines.remove(id, target.id));
    else return { error: "Unknown routines operation " + op };
    await load();
    const now = installed().find((a) => a.id === target.id);
    return { value: now ? toRoutine(now) : { ...toRoutine(target), removed: true } };
  } catch (e) {
    return { error: errorText(e) };
  } finally {
    unsubscribe();
  }
}`;

async function op<T>(cdp: CDP, name: string, botId: string, arg?: unknown): Promise<T> {
  const r = await cdp.call<{ value?: T; error?: string }>(PAGE_ROUTINES, name, botId, arg ?? null);
  if (r.error !== undefined) throw new Error(r.error);
  return r.value as T;
}

export async function listRoutines(cdp: CDP, botQuery: string): Promise<{ bot: string; routines: Routine[] }> {
  const bot = await findBot(cdp, botQuery);
  return { bot: bot.name, routines: await op<Routine[]>(cdp, "list", bot.id) };
}

/** Match a routine by id or exact name; with `exact` false, also by unique name prefix. */
function matchRoutine(routines: Routine[], query: string, exact: boolean): Routine {
  const q = query.trim().toLowerCase();
  const hits = routines.filter((r) => r.id === query.trim() || r.name.toLowerCase() === q);
  if (hits.length === 1) return hits[0];
  const partial = exact || hits.length ? [] : routines.filter((r) => r.name.toLowerCase().startsWith(q));
  if (partial.length === 1) return partial[0];
  const names = routines.map((r) => `${r.name} (${r.id})`).join(", ") || "none";
  throw new Error(
    hits.length + partial.length > 1
      ? `"${query}" matches several routines. Use the id: ${names}`
      : `No routine "${query}". Routines: ${names}`,
  );
}

/** Add a scheduled routine. `schedule` is a cron expression, e.g. "0 9 * * 1-5". */
export async function addRoutine(cdp: CDP, botQuery: string, spec: RoutineSpec): Promise<{ bot: string; routine: Routine | null }> {
  const name = spec.name.trim();
  const prompt = spec.prompt.trim();
  const schedule = spec.schedule.trim();
  if (!name || !prompt || !schedule) throw new Error("A routine needs a name, a prompt and a schedule.");
  if (schedule.split(/\s+/).length !== 5) throw new Error(`"${schedule}" isn't a 5-field cron schedule, e.g. "0 9 * * 1-5".`);
  const bot = await findBot(cdp, botQuery);
  const routine = await op<Routine | null>(cdp, "add", bot.id, {
    name,
    prompt,
    trigger: { type: "cron", schedule },
    isEnabled: spec.enabled !== false,
  });
  return { bot: bot.name, routine };
}

export type RoutineAction = "run" | "enable" | "disable" | "remove";

/** Run a routine now, turn it on or off, or delete it (delete needs the exact name or id). */
export async function changeRoutine(
  cdp: CDP,
  botQuery: string,
  routineQuery: string,
  action: RoutineAction,
): Promise<{ bot: string; routine: Routine & { removed?: boolean } }> {
  const { bot, routines } = await listRoutines(cdp, botQuery);
  const target = matchRoutine(routines, routineQuery, action === "remove");
  const botId = (await findBot(cdp, bot)).id;
  return { bot, routine: await op<Routine>(cdp, action, botId, { routine: target.id }) };
}
