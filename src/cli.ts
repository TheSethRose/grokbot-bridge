#!/usr/bin/env node
import { launch, restore } from "./app.ts";
import {
  ask,
  type BotEvent,
  listBots,
  type Message,
  read,
  send,
  status,
  stop,
  type Usage,
  usage,
  type WaitResult,
  wait,
  watch,
} from "./bot.ts";
import { CDP, cdpPort, listTargets } from "./cdp.ts";
import { serveMcp } from "./mcp.ts";
import { createBot, deleteBot, updateBot } from "./roster.ts";
import { VERSION } from "./version.ts";

const USAGE = `grokbot ${VERSION} — talk to your Grok Bots from the terminal or any agent

Usage:
  grokbot ask <bot> <message...>    Send a message and wait for the reply
  grokbot send <bot> <message...>   Send without waiting; prints the message key
  grokbot wait <bot>                Wait for the Bot to finish replying to your latest message
  grokbot read <bot>                Show recent messages in a conversation
  grokbot watch [bot]               Stream new replies and working/idle changes as JSON lines
  grokbot stop <bot>                Interrupt what the Bot is doing (like the Stop button)
  grokbot bots                      List your Bots and what each is doing
  grokbot create <name>             Create a Bot (--description <text>)
  grokbot update <bot>              Rename a Bot or change its description (--name, --description)
  grokbot delete <bot> --yes        Permanently delete a Bot (exact name or id)
  grokbot usage                     Show your weekly usage limit
  grokbot status                    Check the connection
  grokbot launch                    (Re)start Grok Bot with the local debug port
  grokbot restore                   Restart Grok Bot normally (closes the port)
  grokbot mcp                       Run as an MCP server over stdio

Options:
  --file <path>     ask/send: attach a file (repeat for several, 25 MB each)
  --timeout <sec>   ask/wait: max seconds to wait (ask 300, wait 1800)
  --settle <sec>    ask/wait/watch: idle seconds before a reply counts as finished (default 8)
  --since <key>     wait/read: messages after this message key (from send/ask/read --json)
  --limit <n>       read: number of messages (default 10)
  --name <text>     update: new name
  --description <t> create/update: what the Bot is for
  --yes             delete: confirm deleting the Bot
  --json            Machine-readable output
  --quiet           ask/wait: don't stream progress to stderr
  -v, --version     Print version
  -h, --help        Show this help

Use "-" as the message to read it from stdin.
Exit codes for ask/wait: 0 finished, 2 still working at the timeout, 3 the Bot needs your input in the app.
Env: GROKBOT_CDP_PORT (default 9333), GROKBOT_APP (path to the app)`;

function parse(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const files: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "--quiet" || a === "--yes") flags[a.slice(2)] = true;
    else if (a === "--file") files.push(argv[++i] ?? "");
    else if (["--timeout", "--limit", "--settle", "--since", "--name", "--description"].includes(a)) flags[a.slice(2)] = argv[++i] ?? "";
    else if (a === "-h" || a === "--help") flags.help = true;
    else if (a === "-v" || a === "--version") flags.version = true;
    else rest.push(a);
  }
  return { flags, files, cmd: rest[0], args: rest.slice(1) };
}

async function readMessage(parts: string[]): Promise<string> {
  if (parts.length === 1 && parts[0] === "-") {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  return parts.join(" ").trim();
}

const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);

function positiveNumber(v: string | boolean | undefined, name: string, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
  return n;
}

function formatUsage(u: Usage): string {
  const parts = [`Weekly usage: ${u.percentUsed}% used`];
  if (u.resetsAt) {
    const days = Math.max(0, Math.round((Date.parse(u.resetsAt) - Date.now()) / 86_400_000));
    parts.push(
      `resets ${new Date(u.resetsAt).toLocaleString()} (${days === 0 ? "within a day" : `in ${days} day${days === 1 ? "" : "s"}`})`,
    );
  }
  if (u.plan) parts.push(`plan: ${u.plan}`);
  if (!u.hasAvailableUsage) parts.push("limit reached");
  if (u.onDemand?.enabled) {
    const limit = u.onDemand.limitCents == null ? "no limit" : `$${(u.onDemand.limitCents / 100).toFixed(2)} limit`;
    parts.push(`on-demand: $${(u.onDemand.usedCents / 100).toFixed(2)} spent, ${limit}`);
  }
  return parts.join(" · ");
}

const progress = (m: Message) =>
  console.error(`[grokbot] ${m.role === "card" ? "card" : "reply"}: ${m.text.slice(0, 100).replace(/\s+/g, " ")}`);

function printReplies(r: WaitResult, json: boolean, extra: Record<string, unknown> = {}): void {
  if (json) console.log(JSON.stringify({ ...r, ...extra }, null, 2));
  else {
    const body = r.messages.map((m) => (m.role === "card" ? `[card] ${m.text}` : m.text)).join("\n\n");
    const tail =
      r.status === "timeout"
        ? `\n\n[grokbot] ${r.bot} hasn't finished after ${Math.round(r.elapsedMs / 1000)}s. Run \`grokbot wait ${r.bot}\` to keep waiting.`
        : r.status === "needs_input"
          ? `\n\n[grokbot] ${r.bot} is waiting for you in the Grok Bot app (an approval or question). Answer it there.`
          : "";
    console.log((body || (r.status === "done" ? "(The Bot finished without replying.)" : "(no reply yet)")) + tail);
  }
  if (r.status !== "done") process.exitCode = r.status === "needs_input" ? 3 : 2;
}

async function withApp<T>(fn: (cdp: CDP) => Promise<T>): Promise<T> {
  const { restarted } = await launch();
  if (restarted) console.error("[grokbot] Restarted Grok Bot with the local debug port.");
  const cdp = await CDP.connect();
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

async function main() {
  const { flags, files, cmd, args } = parse(process.argv.slice(2));
  if (flags.version) return console.log(VERSION);
  if (flags.help || !cmd) return console.log(USAGE);
  const out = (v: unknown, text: () => string) => console.log(flags.json ? JSON.stringify(v, null, 2) : text());

  switch (cmd) {
    case "mcp":
      return serveMcp();
    case "launch": {
      const r = await launch();
      return out(r, () =>
        r.restarted ? `Grok Bot restarted with debug port ${r.port} (127.0.0.1 only).` : `Already connected on port ${r.port}.`,
      );
    }
    case "restore":
      await restore();
      return out({ ok: true }, () => "Grok Bot restarted normally. The debug port is closed.");
    case "status": {
      const port = cdpPort();
      if (!(await listTargets(port))) return out({ connected: false, port }, () => `Not connected (port ${port}). Run: grokbot launch`);
      const cdp = await CDP.connect();
      try {
        const s = await status(cdp);
        return out(
          { connected: true, port, ...s },
          () =>
            `Connected on port ${port}. ${s.bots.length} Bot(s): ${s.bots.map((b) => b.name).join(", ")}${s.busy ? " · a Bot is working" : ""}${s.usage ? `\n${formatUsage(s.usage)}` : ""}`,
        );
      } finally {
        cdp.close();
      }
    }
    case "bots": {
      const bots = await withApp(listBots);
      return out(bots, () =>
        bots
          .map((b) => {
            const state = [
              b.needsInput ? "needs your input" : b.running ? "working" : "idle",
              b.unread ? `${b.unread} unread` : "",
              b.hidden ? "hidden" : "",
            ];
            return `${b.name}${b.description ? ` — ${b.description}` : ""}  (${b.id})  [${state.filter(Boolean).join(", ")}]`;
          })
          .join("\n"),
      );
    }
    case "usage": {
      const u = await withApp(usage);
      return out(u, () => formatUsage(u));
    }
    case "create": {
      const name = args.join(" ").trim();
      if (!name) throw new Error("Usage: grokbot create <name> [--description <text>]");
      const b = await withApp((c) => createBot(c, { name, description: str(flags.description) }));
      return out(b, () => `Created ${b.name} (${b.id}). It starts working when you send it a message.`);
    }
    case "update": {
      const bot = args.join(" ").trim();
      const name = str(flags.name);
      const description = str(flags.description);
      if (!bot || (name === undefined && description === undefined)) {
        throw new Error("Usage: grokbot update <bot> [--name <new name>] [--description <text>]");
      }
      const b = await withApp((c) => updateBot(c, bot, { name, description }));
      return out(b, () => `Updated ${b.name}${b.description ? ` — ${b.description}` : ""}`);
    }
    case "delete": {
      const bot = args.join(" ").trim();
      if (!bot) throw new Error("Usage: grokbot delete <bot> --yes");
      if (!flags.yes) throw new Error(`This permanently deletes "${bot}" and its conversation. Run again with --yes to confirm.`);
      const b = await withApp((c) => deleteBot(c, bot));
      return out(b, () => `Deleted ${b.name}.`);
    }
    case "read": {
      const bot = args.join(" ").trim();
      if (!bot) throw new Error("Usage: grokbot read <bot> [--limit <n>] [--since <key>]");
      const since = str(flags.since);
      const limit = flags.limit === undefined ? undefined : positiveNumber(flags.limit, "limit", 10);
      const r = await withApp((c) => read(c, bot, { limit, since }));
      return out(r, () =>
        r.messages.map((m) => `[${m.role === "user" ? "you" : m.role === "card" ? "card" : r.bot}] ${m.text}`).join("\n\n"),
      );
    }
    case "send": {
      const [bot, ...rest] = args;
      const msg = await readMessage(rest);
      if (!bot || (!msg && !files.length)) throw new Error("Usage: grokbot send <bot> <message...> [--file <path>]");
      const r = await withApp((c) => send(c, bot, msg, files));
      return out(r, () => `Sent to ${r.bot} (key ${r.key}). Run \`grokbot wait ${r.bot}\` for the reply.`);
    }
    case "wait": {
      const bot = args.join(" ").trim();
      if (!bot) throw new Error("Usage: grokbot wait <bot> [--since <key>] [--timeout <sec>]");
      const r = await withApp((c) =>
        wait(c, bot, {
          since: str(flags.since),
          timeoutMs: positiveNumber(flags.timeout, "timeout", 1800) * 1000,
          settleMs: positiveNumber(flags.settle, "settle", 8) * 1000,
          onUpdate: flags.quiet ? undefined : progress,
        }),
      );
      return printReplies(r, !!flags.json);
    }
    case "watch": {
      const bot = args.join(" ").trim() || null;
      const line = (e: BotEvent) =>
        console.log(flags.json || e.type !== "message" ? JSON.stringify(e) : `[${e.bot}] ${e.role === "card" ? "[card] " : ""}${e.text}`);
      await withApp((c) => {
        console.error(`[grokbot] Watching ${bot ?? "all Bots"}. Press Ctrl-C to stop.`);
        return watch(c, bot, line, positiveNumber(flags.settle, "settle", 8) * 1000);
      });
      return;
    }
    case "stop": {
      const bot = args.join(" ").trim();
      if (!bot) throw new Error("Usage: grokbot stop <bot>");
      const r = await withApp((c) => stop(c, bot));
      return out(r, () => (r.stopped ? `Stopped ${r.bot}.` : `${r.bot} wasn't working.`));
    }
    case "ask": {
      const [bot, ...rest] = args;
      const msg = await readMessage(rest);
      if (!bot || (!msg && !files.length)) throw new Error("Usage: grokbot ask <bot> <message...> [--file <path>]");
      const r = await withApp((c) =>
        ask(c, bot, msg, {
          files,
          timeoutMs: positiveNumber(flags.timeout, "timeout", 300) * 1000,
          settleMs: positiveNumber(flags.settle, "settle", 8) * 1000,
          onUpdate: flags.quiet ? undefined : progress,
        }),
      );
      return printReplies(r, !!flags.json);
    }
    default:
      throw new Error(`Unknown command "${cmd}".\n\n${USAGE}`);
  }
}

main().catch((e) => {
  console.error(`grokbot: ${e?.message ?? e}`);
  process.exit(1);
});
