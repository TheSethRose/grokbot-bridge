// Shares the service's single CDP pipe to Grok Bot between several clients (CLI runs, MCP servers
// in different agent sessions). Each client numbers its own messages, so ids are remapped on the
// way in and back on the way out; page events carry a sessionId and go to whoever attached it.

type Message = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown };
type Pending = { client: number; id: number; attach: boolean };

export class PipeMux {
  private nextClient = 0;
  private nextId = 0;
  private clients = new Map<number, (raw: string) => void>();
  private pending = new Map<number, Pending>();
  private sessions = new Map<string, number>();

  constructor(private toBrowser: (raw: string) => void) {}

  addClient(write: (raw: string) => void): number {
    const id = ++this.nextClient;
    this.clients.set(id, write);
    return id;
  }

  fromClient(client: number, raw: string): void {
    let msg: Message;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.clients.get(client)?.(
        JSON.stringify({ error: { message: `invalid CDP message: received ${JSON.stringify(raw.slice(0, 80))}, expected JSON` } }),
      );
      return;
    }
    if (typeof msg.id !== "number") return;
    const id = ++this.nextId;
    this.pending.set(id, { client, id: msg.id, attach: msg.method === "Target.attachToTarget" });
    this.toBrowser(JSON.stringify({ ...msg, id }));
  }

  fromBrowser(raw: string): void {
    const msg: Message = JSON.parse(raw);
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      const sessionId = (msg.result as { sessionId?: string } | undefined)?.sessionId;
      if (p.attach && sessionId) this.sessions.set(sessionId, p.client);
      this.clients.get(p.client)?.(JSON.stringify({ ...msg, id: p.id }));
      return;
    }
    // Browser-level events (no session) aren't needed by the bridge, so they aren't forwarded.
    const owner = msg.sessionId ? this.sessions.get(msg.sessionId) : undefined;
    if (owner !== undefined) this.clients.get(owner)?.(raw);
  }

  removeClient(client: number): void {
    this.clients.delete(client);
    for (const [id, p] of this.pending) if (p.client === client) this.pending.delete(id);
    for (const [sessionId, owner] of this.sessions) {
      if (owner !== client) continue;
      this.sessions.delete(sessionId);
      this.toBrowser(JSON.stringify({ id: ++this.nextId, method: "Target.detachFromTarget", params: { sessionId } }));
    }
  }
}
