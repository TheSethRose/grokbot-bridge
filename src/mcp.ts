// Stdio MCP server exposing Grok Bot to any MCP client (Claude Code, Cursor, Codex, ...).
// Newline-delimited JSON-RPC 2.0, no SDK dependency.
import { createInterface } from "node:readline";
import { launch } from "./app.ts";
import { ask, download, listBots, read, send, stop, usage, wait } from "./bot.ts";
import { CDP } from "./cdp.ts";
import { createBot, deleteBot, updateBot } from "./roster.ts";
import { addRoutine, changeRoutine, listRoutines, type RoutineAction } from "./routines.ts";
import { VERSION } from "./version.ts";

const TOOLS = [
  {
    name: "grokbot_list_bots",
    description:
      "List the Grok Bots in the user's Grok Bot desktop app: name, description, id, and whether each is working, needs the user's input, or has unread messages.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "grokbot_ask",
    description:
      "Send a message to a Grok Bot and wait for its reply. Bots run on a cloud computer with a browser and can research the web and X, use connected apps, and do multi-step work. Returns the Bot's reply messages and the sent message's key. Status 'timeout' means it's still working: call grokbot_wait with since=key. Status 'needs_input' means the Bot is waiting on the user in the app.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string", description: "Bot name (e.g. 'Chief') or id" },
        message: { type: "string", description: "The message to send, written like a request to a teammate" },
        files: { type: "array", items: { type: "string" }, description: "Optional absolute paths of local files to attach (25 MB each)" },
        timeout_seconds: { type: "number", description: "Max seconds to wait for replies (default 300, max 1800)" },
        settle_seconds: { type: "number", description: "Idle seconds before the reply counts as finished (default 8)" },
      },
      required: ["bot", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "grokbot_send",
    description:
      "Send a message to a Grok Bot without waiting. Returns the message key; pass it to grokbot_wait or grokbot_read as 'since' to collect the reply.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string" },
        message: { type: "string" },
        files: { type: "array", items: { type: "string" }, description: "Optional absolute paths of local files to attach" },
      },
      required: ["bot", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "grokbot_wait",
    description:
      "Wait for a Grok Bot to finish replying (to the message at 'since', or the user's latest message) and return its replies. Event-driven, no polling. Returns status 'done', 'timeout' (still working) or 'needs_input' (waiting on the user in the app).",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string" },
        since: { type: "string", description: "Message key from grokbot_send or grokbot_ask" },
        timeout_seconds: { type: "number", description: "Max seconds to wait (default 600, max 3600)" },
        settle_seconds: { type: "number", description: "Idle seconds before the reply counts as finished (default 8)" },
      },
      required: ["bot"],
      additionalProperties: false,
    },
  },
  {
    name: "grokbot_stop",
    description:
      "Interrupt what a Grok Bot is doing, like the app's Stop button. Use when the user asks, or a task is clearly running away.",
    inputSchema: { type: "object", properties: { bot: { type: "string" } }, required: ["bot"], additionalProperties: false },
  },
  {
    name: "grokbot_download",
    description:
      "Save files from a Grok Bot conversation to a local folder: the messages with these keys (from grokbot_read; file messages have a 'file' field), or by default the newest file the Bot sent. Never overwrites existing files. Returns the saved paths.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string" },
        keys: { type: "array", items: { type: "string" }, description: "Message keys of file messages" },
        out_dir: { type: "string", description: "Absolute folder to save into (default: the server's working folder)" },
      },
      required: ["bot"],
      additionalProperties: false,
    },
  },
  {
    name: "grokbot_routines",
    description:
      "Manage a Grok Bot's routines (prompts it runs on a schedule). action 'list' shows them; 'add' needs name, schedule (5-field cron) and prompt; 'run', 'enable', 'disable' and 'remove' need routine (name or id; remove needs the exact name or id and confirm repeating it). Running or enabling a routine uses the user's Grok Bot usage, so only change routines when the user asked.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "run", "enable", "disable", "remove"] },
        bot: { type: "string" },
        routine: { type: "string", description: "Routine name or id (run/enable/disable/remove)" },
        confirm: { type: "string", description: "remove: repeat the routine value" },
        name: { type: "string", description: "add: routine name" },
        schedule: { type: "string", description: "add: cron schedule, e.g. '0 9 * * 1-5'" },
        prompt: { type: "string", description: "add: what the Bot does each run" },
        enabled: { type: "boolean", description: "add: start turned on (default true)" },
      },
      required: ["action", "bot"],
      additionalProperties: false,
    },
  },
  {
    name: "grokbot_create_bot",
    description:
      "Create a new Grok Bot. It starts working when it gets its first message (use grokbot_ask). Each Bot uses the user's Grok Bot usage, so only create one when the user asked for it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name shown in the sidebar" },
        description: { type: "string", description: "Optional: what the Bot is for" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "grokbot_update_bot",
    description: "Rename a Grok Bot or change its description. Omitted fields stay the same.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string", description: "Current Bot name or id" },
        name: { type: "string", description: "New name" },
        description: { type: "string", description: "New description" },
      },
      required: ["bot"],
      additionalProperties: false,
    },
  },
  {
    name: "grokbot_delete_bot",
    description:
      "Permanently delete a Grok Bot and its conversation. Only use when the user explicitly asked to delete this Bot. 'bot' must be the exact name or id, and 'confirm' must repeat it.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string", description: "Exact Bot name or id" },
        confirm: { type: "string", description: "Repeat the same value as 'bot' to confirm" },
      },
      required: ["bot", "confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "grokbot_usage",
    description:
      "Get the user's Grok Bot weekly usage limit: percent used, when it resets, plan, and on-demand spend. Check it before handing a Bot long or heavy work.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "grokbot_read",
    description:
      "Read messages in a Grok Bot conversation without switching the app's view: the most recent ones, or everything after a message key.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string" },
        limit: { type: "number", description: "Max messages (default 10)" },
        since: { type: "string", description: "Only messages after this key" },
      },
      required: ["bot"],
      additionalProperties: false,
    },
  },
];

// Calls read and write the app's stores, so they can run side by side. Only launching
// (which may restart the app) must not overlap.
let launching: Promise<unknown> | null = null;

async function withApp<T>(fn: (cdp: CDP) => Promise<T>): Promise<T> {
  launching ??= launch().finally(() => {
    launching = null;
  });
  await launching;
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
  const opt = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  const files = Array.isArray(args.files) ? args.files.map(String) : [];
  const seconds = (k: string, def: number, min: number, max: number) => Math.min(Math.max(Number(args[k] ?? def) || def, min), max) * 1000;
  switch (name) {
    case "grokbot_list_bots":
      return withApp((c) => listBots(c));
    case "grokbot_ask":
      return withApp((c) =>
        ask(c, str("bot"), opt("message") ?? "", {
          files,
          timeoutMs: seconds("timeout_seconds", 300, 10, 1800),
          settleMs: seconds("settle_seconds", 8, 2, 120),
        }),
      );
    case "grokbot_send":
      return withApp((c) => send(c, str("bot"), opt("message") ?? "", files));
    case "grokbot_wait":
      return withApp((c) =>
        wait(c, str("bot"), {
          since: opt("since"),
          timeoutMs: seconds("timeout_seconds", 600, 10, 3600),
          settleMs: seconds("settle_seconds", 8, 2, 120),
        }),
      );
    case "grokbot_download": {
      const keys = Array.isArray(args.keys) ? args.keys.map(String) : [];
      return withApp((c) => download(c, str("bot"), keys, opt("out_dir")));
    }
    case "grokbot_routines": {
      const action = str("action");
      if (action === "list") return withApp((c) => listRoutines(c, str("bot")));
      if (action === "add") {
        return withApp((c) =>
          addRoutine(c, str("bot"), {
            name: str("name"),
            schedule: str("schedule"),
            prompt: str("prompt"),
            enabled: args.enabled !== false,
          }),
        );
      }
      if (!["run", "enable", "disable", "remove"].includes(action)) throw new Error(`Unknown action "${action}".`);
      if (action === "remove" && str("confirm") !== str("routine")) throw new Error('"confirm" must repeat the "routine" value exactly.');
      return withApp((c) => changeRoutine(c, str("bot"), str("routine"), action as RoutineAction));
    }
    case "grokbot_stop":
      return withApp((c) => stop(c, str("bot")));
    case "grokbot_create_bot":
      return withApp((c) => createBot(c, { name: str("name"), description: opt("description") }));
    case "grokbot_update_bot": {
      const name = opt("name");
      const description = opt("description");
      if (name === undefined && description === undefined) throw new Error('Pass "name" or "description" to change.');
      return withApp((c) => updateBot(c, str("bot"), { name, description }));
    }
    case "grokbot_delete_bot":
      if (str("confirm") !== str("bot")) throw new Error('"confirm" must repeat the "bot" value exactly.');
      return withApp((c) => deleteBot(c, str("bot")));
    case "grokbot_usage":
      return withApp((c) => usage(c));
    case "grokbot_read":
      return withApp((c) =>
        read(c, str("bot"), { limit: args.limit === undefined ? undefined : Number(args.limit) || 10, since: opt("since") }),
      );
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
            const out = await callTool(params?.name ?? "", params?.arguments ?? {});
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
