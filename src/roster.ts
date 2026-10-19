// Create, update and delete Bots through the app's own roster client (see page.ts).
import { listBots, matchBot } from "./bot.ts";
import type { CDP } from "./cdp.ts";
import { PAGE_ERROR, store } from "./page.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type BotProfile = { id: string; name: string; description: string; hidden: boolean; running: boolean };

const NO_ROSTER = "Couldn't reach Grok Bot's Bot list. This app version may not support managing Bots.";

// Runs a roster operation in the page. Errors come back as values so messages stay clean.
// Profile writes go to the Bot's cloud computer, which the app parks while nobody is at the
// Mac; signalBoxIntent is the same wake-up the app sends when you click into a message box.
const PAGE_OP = `async (op, arg) => {
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

async function op<T>(cdp: CDP, name: string, arg?: unknown): Promise<T> {
  const r = await cdp.call<{ value?: T; error?: string }>(PAGE_OP, name, arg ?? null);
  if (r.error !== undefined) throw new Error(r.error);
  return r.value as T;
}

/** Create a Bot. It starts work when it gets its first message. */
export async function createBot(cdp: CDP, input: { name: string; description?: string }): Promise<BotProfile> {
  const name = input.name.trim();
  if (!name) throw new Error("A Bot needs a name.");
  const profiles = await listBots(cdp).catch(() => []);
  if (profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new Error(`You already have a Bot named "${name}".`);
  const bot = await op<BotProfile>(cdp, "create", { name, description: input.description?.trim() ?? "" });
  // Wait for it to show up in the sidebar so `ask`/`send` can open it right away.
  for (let i = 0; i < 25; i++) {
    if ((await listBots(cdp).catch(() => [])).some((b) => b.id === bot.id)) break;
    await sleep(400);
  }
  return bot;
}

/** Rename a Bot or change its description. Omitted fields keep their current value. */
export async function updateBot(cdp: CDP, query: string, changes: { name?: string; description?: string }): Promise<BotProfile> {
  const current = matchBot(await listBots(cdp), query);
  const name = changes.name?.trim() || current.name;
  const description = changes.description?.trim() ?? current.description;
  if (name === current.name && description === current.description) {
    return { id: current.id, name, description, hidden: current.hidden, running: current.running };
  }
  return op<BotProfile>(cdp, "update", { id: current.id, name, description });
}

/**
 * Permanently delete a Bot. `query` must be the Bot's exact name or id: no prefix
 * matching for something that can't be undone.
 */
export async function deleteBot(cdp: CDP, query: string): Promise<{ id: string; name: string }> {
  const q = query.trim().toLowerCase();
  const matches = (await listBots(cdp)).filter((p) => p.id === query.trim() || p.name.toLowerCase() === q);
  if (matches.length !== 1) {
    throw new Error(matches.length ? `"${query}" matches several Bots. Use the Bot's id.` : `No Bot named exactly "${query}".`);
  }
  const [bot] = matches;
  await op(cdp, "delete", { id: bot.id });
  return { id: bot.id, name: bot.name };
}
