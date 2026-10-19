// Grok Bot's renderer keeps its stores (Bot list, transcripts, send queue, routines) in
// React context rather than on window, so they're found by walking up the component tree
// from a rendered element. This is internal to Grok Bot (0.71.x) and may change on app
// updates; keep the lookups here.

/** Page-side expression for the first React context value that passes `test` (a JS expression over `v`). Null if none. */
function contextValue(test: string): string {
  return `(() => {
    for (const start of [document.querySelector(".sand-agent-item[data-agent-id]"), document.querySelector("button")]) {
      const key = start && Object.keys(start).find((k) => k.startsWith("__reactFiber"));
      for (let f = key ? start[key] : null; f; f = f.return) {
        const v = f.memoizedProps && f.memoizedProps.value;
        if (v && typeof v === "object" && (${test})) return v;
      }
    }
    return null;
  })()`;
}

/** Page-side expression for the app store `name`, recognized by one of its methods. Null if not found. */
export function store(name: string, method: string): string {
  const n = JSON.stringify(name);
  return `(${contextValue(`v[${n}] && typeof v[${n}][${JSON.stringify(method)}] === "function"`)} || {})[${n}] || null`;
}

/** Page-side expression for the signed-in account's slot, which the app passes when reading files from a Bot's computer. */
export const ACCOUNT_SLOT = `(${contextValue(`typeof v.accountSlot === "string"`)} || {}).accountSlot || null`;

/**
 * Page-side expression for the app's Bot-computer phase: "settled" (awake), "connecting", "waking",
 * "creating", "following", "asleep" or "away". Null if not found.
 * Grok Bot puts the computer to sleep ("away") when the Mac is locked or asleep, or when the Grok Bot
 * window has been in the background for 10 minutes; only bringing the window back wakes it. Bot turns
 * (messages, routines on their schedule) still run in the cloud while it sleeps.
 */
export const BOX_PHASE = `((${contextValue(`v.boxHostPhase && v.boxHostPhase.snapshots && typeof v.boxHostPhase.snapshots.get === "function"`)} || {}).boxHostPhase || { snapshots: { get: () => null } }).snapshots.get()`;

/** Turns an app failure (which carries a code) or any thrown value into a readable message. Page-side. */
export const PAGE_ERROR = `(e) => {
  const f = e && e.failure;
  if (f && f.code === "sand-box-blocked" && /PARK/.test(f.sandBoxBlockReason || ""))
    return "Grok Bot has put the Bot's computer to sleep because its window hasn't been in front for 10 minutes (" + f.sandBoxBlockReason + "). This change needs the computer, so it will work after you next open Grok Bot.";
  if (f && f.code) return f.code + (e.message && e.message !== f.code ? ": " + e.message : "");
  return String((e && e.message) || e);
}`;

/**
 * Page-side `(agentId, fn)` that runs `fn` against the Bot's cloud computer. The app parks the
 * computer while nobody is at the Mac; signalBoxIntent is the same wake-up the app sends when
 * you click into a message box, and the call is retried while the computer comes back.
 */
export const PAGE_AWAKE = `async (id, fn) => {
  for (let i = 0; ; i++) {
    await Promise.resolve(window.desktop?.main?.signalBoxIntent?.({ agentId: id, intent: "composer_focus" })).catch(() => {});
    try { return await fn(); } catch (e) {
      const f = e && e.failure;
      // Away-park lasts until the Grok Bot window is in front again, so retrying won't help.
      if (i >= 8 || !(f && f.code === "sand-box-blocked") || f.sandBoxBlockReason === "SAND_AWAY_PARK") throw e;
      await new Promise((s) => setTimeout(s, 1500));
    }
  }
}`;
