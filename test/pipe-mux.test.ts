import { describe, expect, test } from "bun:test";
import { PipeMux } from "../src/pipe-mux.ts";

// The service owns the one CDP pipe to Grok Bot; each connected CLI or MCP process is a client.
function setup() {
  const toBrowser: Record<string, unknown>[] = [];
  const mux = new PipeMux((raw) => toBrowser.push(JSON.parse(raw)));
  const inbox = (): { got: Record<string, unknown>[]; id: number } => {
    const got: Record<string, unknown>[] = [];
    return { got, id: mux.addClient((raw) => got.push(JSON.parse(raw))) };
  };
  return { mux, toBrowser, inbox };
}

describe("PipeMux", () => {
  test("two clients using the same message id each get their own reply", () => {
    const { mux, toBrowser, inbox } = setup();
    const a = inbox();
    const b = inbox();

    mux.fromClient(a.id, JSON.stringify({ id: 1, method: "Target.getTargets" }));
    mux.fromClient(b.id, JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    const [first, second] = toBrowser as { id: number }[];
    expect(first.id).not.toBe(second.id);
    mux.fromBrowser(JSON.stringify({ id: second.id, result: { product: "Chrome" } }));
    mux.fromBrowser(JSON.stringify({ id: first.id, result: { targetInfos: [] } }));

    expect(a.got).toEqual([{ id: 1, result: { targetInfos: [] } }]);
    expect(b.got).toEqual([{ id: 1, result: { product: "Chrome" } }]);
  });

  test("page events go only to the client that attached that session", () => {
    const { mux, toBrowser, inbox } = setup();
    const a = inbox();
    const b = inbox();
    mux.fromClient(a.id, JSON.stringify({ id: 7, method: "Target.attachToTarget", params: { targetId: "T", flatten: true } }));
    mux.fromBrowser(JSON.stringify({ id: (toBrowser[0] as { id: number }).id, result: { sessionId: "S1" } }));

    mux.fromBrowser(JSON.stringify({ method: "Runtime.bindingCalled", params: { name: "x" }, sessionId: "S1" }));

    expect(a.got.at(-1)).toEqual({ method: "Runtime.bindingCalled", params: { name: "x" }, sessionId: "S1" });
    expect(b.got).toEqual([]);
  });

  test("a client that leaves has its sessions detached and late replies dropped", () => {
    const { mux, toBrowser, inbox } = setup();
    const a = inbox();
    mux.fromClient(a.id, JSON.stringify({ id: 1, method: "Target.attachToTarget", params: { targetId: "T", flatten: true } }));
    mux.fromBrowser(JSON.stringify({ id: (toBrowser[0] as { id: number }).id, result: { sessionId: "S1" } }));
    mux.fromClient(a.id, JSON.stringify({ id: 2, method: "Runtime.evaluate", params: {}, sessionId: "S1" }));
    const pendingId = (toBrowser[1] as { id: number }).id;

    mux.removeClient(a.id);
    mux.fromBrowser(JSON.stringify({ id: pendingId, result: {} }));

    expect(toBrowser.at(-1)).toMatchObject({ method: "Target.detachFromTarget", params: { sessionId: "S1" } });
    expect(a.got).toHaveLength(1);
  });

  test("a malformed client message is answered with an error instead of reaching the app", () => {
    const { mux, toBrowser, inbox } = setup();
    const a = inbox();

    mux.fromClient(a.id, "not json");

    expect(toBrowser).toEqual([]);
    expect(a.got[0]).toMatchObject({ error: { message: expect.stringContaining("not json") } });
  });
});
