// Minimal Chrome DevTools Protocol client for the Grok Bot desktop window.
// Uses the global WebSocket (Node 22+, Bun), so the package has no runtime dependencies.

export const DEFAULT_PORT = 9333;

export function cdpPort(): number {
  const n = Number(process.env.GROKBOT_CDP_PORT || DEFAULT_PORT);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid GROKBOT_CDP_PORT: ${process.env.GROKBOT_CDP_PORT}`);
  return n;
}

type Target = { type: string; url: string; title: string; webSocketDebuggerUrl: string };

export async function listTargets(port = cdpPort()): Promise<Target[] | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    return (await res.json()) as Target[];
  } catch {
    return null;
  }
}

export class NotConnectedError extends Error {
  constructor(port: number) {
    super(`Grok Bot isn't reachable on debug port ${port}. Run \`grokbot launch\` first.`);
    this.name = "NotConnectedError";
  }
}

export class CDP {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = msg.id ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }

  static async connect(port = cdpPort()): Promise<CDP> {
    const targets = await listTargets(port);
    if (!targets) throw new NotConnectedError(port);
    // The main window is the renderer page loaded from the app bundle.
    const page = targets.find((t) => t.type === "page" && /app\.asar|\/renderer\/index\.html/.test(t.url));
    if (!page) throw new Error(`Debug port ${port} is open, but no Grok Bot window was found on it.`);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("Could not open the CDP websocket")), { once: true });
    });
    return new CDP(ws);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  /** Call a function in the page with JSON-serializable arguments. */
  call<T = unknown>(fn: string, ...args: unknown[]): Promise<T> {
    return this.eval<T>(`(${fn})(...${JSON.stringify(args)})`);
  }

  async pressKey(key: "Enter", shift = false): Promise<void> {
    const base = { key, code: key, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: shift ? 8 : 0 };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: shift ? undefined : "\r" });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  close(): void {
    this.ws.close();
  }
}
