// Minimal Chrome DevTools Protocol client for the Grok Bot desktop window.
// Uses the global WebSocket (Node 22+, Bun), so the package has no runtime dependencies.
// Two ways in: the grokbot service's Unix socket (no debug port at all), or the debug port.
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** Where `grokbot service` listens. The folder is 0700 and the socket 0600: only your user gets in. */
export function serviceSocketPath(): string {
  if (process.env.GROKBOT_SOCKET) return process.env.GROKBOT_SOCKET;
  const runtime = process.env.XDG_RUNTIME_DIR;
  return runtime ? join(runtime, "grokbot", "cdp.sock") : join(homedir(), ".grokbot", "cdp.sock");
}

type Transport = { send(text: string): void; close(): void; onMessage(cb: (text: string) => void): void; onClose(cb: () => void): void };

function socketTransport(path: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    let buf = "";
    const listeners: ((text: string) => void)[] = [];
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      for (let i = buf.indexOf("\0"); i >= 0; i = buf.indexOf("\0")) {
        const text = buf.slice(0, i);
        buf = buf.slice(i + 1);
        for (const l of listeners) l(text);
      }
    });
    sock.once("error", reject);
    sock.once("connect", () =>
      resolve({
        send: (text) => sock.write(`${text}\0`),
        close: () => sock.end(),
        onMessage: (cb) => listeners.push(cb),
        onClose: (cb) => sock.on("close", cb),
      }),
    );
  });
}

function wsTransport(ws: WebSocket): Transport {
  return {
    send: (text) => ws.send(text),
    close: () => ws.close(),
    onMessage: (cb) => ws.addEventListener("message", (ev) => cb(String(ev.data))),
    onClose: (cb) => ws.addEventListener("close", cb),
  };
}

/** True if `grokbot service` is running and accepting connections. */
export async function serviceAvailable(): Promise<boolean> {
  const path = serviceSocketPath();
  if (!existsSync(path)) return false;
  try {
    (await socketTransport(path)).close();
    return true;
  } catch {
    return false;
  }
}

// The main window is the renderer page loaded from the app bundle.
const isMainWindow = (t: { type: string; url: string }) => t.type === "page" && /app\.asar|\/renderer\/index\.html/.test(t.url);

export class NotConnectedError extends Error {
  constructor(port: number) {
    super(`Grok Bot isn't reachable on debug port ${port}. Run \`grokbot launch\` first.`);
    this.name = "NotConnectedError";
  }
}

export class CDP {
  private io: Transport;
  private sessionId?: string;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private bindings = new Map<string, (payload: string) => void>();

  private constructor(io: Transport) {
    this.io = io;
    io.onMessage((text) => {
      const msg = JSON.parse(text);
      if (msg.method === "Runtime.bindingCalled") return this.bindings.get(msg.params.name)?.(msg.params.payload);
      const p = msg.id ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
    io.onClose(() => {
      for (const p of this.pending.values()) p.reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }

  static async connect(port = cdpPort()): Promise<CDP> {
    if (await serviceAvailable()) return CDP.connectService();
    const targets = await listTargets(port);
    if (!targets) throw new NotConnectedError(port);
    const page = targets.find(isMainWindow);
    if (!page) throw new Error(`Debug port ${port} is open, but no Grok Bot window was found on it.`);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("Could not open the CDP websocket")), { once: true });
    });
    return new CDP(wsTransport(ws));
  }

  /** Connect through `grokbot service`, which holds Grok Bot's debug pipe, and attach to the main window. */
  private static async connectService(): Promise<CDP> {
    const cdp = new CDP(await socketTransport(serviceSocketPath()));
    try {
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
      const page = targetInfos.find(isMainWindow);
      if (!page) throw new Error("The grokbot service is running, but no Grok Bot window was found.");
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      cdp.sessionId = sessionId;
      return cdp;
    } catch (e) {
      cdp.close();
      throw e;
    }
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    this.io.send(JSON.stringify({ id, method, params, ...(this.sessionId ? { sessionId: this.sessionId } : {}) }));
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

  /**
   * Add a page function `window[name](string)` whose calls arrive at `fn`, so page code can
   * push events while a long evaluation is still running. Returns the name to hand to the page.
   */
  async bind(fn: (payload: string) => void): Promise<string> {
    const name = `__grokbot_${process.pid}_${this.bindings.size}`;
    this.bindings.set(name, fn);
    await this.send("Runtime.addBinding", { name });
    return name;
  }

  close(): void {
    this.io.close();
  }
}
