// Grok Bot's renderer keeps its stores (Bot list, transcripts, send queue) in React
// context rather than on window, so they're found by walking up the component tree
// from a rendered element. This is internal to Grok Bot (0.71.x) and may change on
// app updates; keep the lookups here.

/** Page-side expression for the app store `name`, recognized by one of its methods. Null if not found. */
export function store(name: string, method: string): string {
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

/** Turns an app failure (which carries a code) or any thrown value into a readable message. Page-side. */
export const PAGE_ERROR = `(e) => (e && e.failure && e.failure.code ? e.failure.code + (e.message && e.message !== e.failure.code ? ": " + e.message : "") : String((e && e.message) || e))`;
