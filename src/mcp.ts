// Stdio MCP server exposing Grok Bot to any MCP client (Claude Code, Cursor, Codex, ...).
// Newline-delimited JSON-RPC 2.0, no SDK dependency.
import { createInterface } from "node:readline";
import { launch } from "./app.ts";
import { ask, listBots, read, send } from "./bot.ts";
import { CDP } from "./cdp.ts";
import { VERSION } from "./version.ts";

const TOOLS = [
  {
    name: "grokbot_list_bots",
    description: "List the Grok Bots in the user's Grok Bot desktop app (name, role label, id, whether open).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "grokbot_ask",
    description:
      "Send a message to a Grok Bot and wait for its reply. Bots run on a cloud computer with a browser and can research the web and X, use connected apps, and do multi-step work. Returns the Bot's reply messages. If the Bot is still working at the timeout, returns what it has so far with status 'timeout'; call grokbot_read later for the rest.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string", description: "Bot name (e.g. 'Chief') or id" },
        message: { type: "string", description: "The message to send, written like a request to a teammate" },
        timeout_seconds: { type: "number", description: "Max seconds to wait for replies (default 300, max 1800)" },
        settle_seconds: { type: "number", description: "Idle seconds before the reply counts as finished (default 12)" },
      },
      required: ["bot", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "grokbot_send",
    description: "Send a message to a Grok Bot without waiting for a reply. Use grokbot_read later to collect it.",
    inputSchema: {
      type: "object",
      properties: { bot: { type: "string" }, message: { type: "string" } },
      required: ["bot", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "grokbot_read",
    description: "Read the most recent messages in a Grok Bot conversation.",
    inputSchema: {
      type: "object",
      properties: { bot: { type: "string" }, limit: { type: "number", description: "Max messages (default 10)" } },
      required: ["bot"],
      additionalProperties: false,
    },
  },
];

// Calls are serialized: the bridge drives one shared app window.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

async function withApp<T>(fn: (cdp: CDP) => Promise<T>): Promise<T> {
  await launch();
  const cdp = await CDP.connect();
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const str = (k: string) => {
    const v = args[k];
    if (typeof v !== "string" || !v.trim()) throw new Error(`"${k}" is required`);
    return v;
  };
  switch (name) {
    case "grokbot_list_bots":
      return withApp((c) => listBots(c));
    case "grokbot_ask": {
      const t = Math.min(Math.max(Number(args.timeout_seconds ?? 300), 10), 1800);
      const settle = Math.min(Math.max(Number(args.settle_seconds ?? 12), 2), 120);
      return withApp((c) => ask(c, str("bot"), str("message"), { timeoutMs: t * 1000, settleMs: settle * 1000 }));
    }
    case "grokbot_send":
      return withApp((c) => send(c, str("bot"), str("message")));
    case "grokbot_read":
      return withApp((c) => read(c, str("bot"), Number(args.limit ?? 10)));
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

export function serveMcp(): void {
  const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg: {
      id?: number | string;
      method?: string;
      params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const { id, method, params } = msg;
    if (id === undefined) return; // notifications (initialized, cancelled) need no reply
    const reply = (result: unknown) => write({ jsonrpc: "2.0", id, result });
    try {
      switch (method) {
        case "initialize":
          return reply({
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "grokbot-bridge", version: VERSION },
          });
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: TOOLS });
        case "tools/call": {
          try {
            const out = await serialized(() => callTool(params?.name ?? "", params?.arguments ?? {}));
            return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
          } catch (e) {
            return reply({ content: [{ type: "text", text: String((e as Error).message ?? e) }], isError: true });
          }
        }
        default:
          write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (e) {
      write({ jsonrpc: "2.0", id, error: { code: -32603, message: String((e as Error).message ?? e) } });
    }
  });
}
