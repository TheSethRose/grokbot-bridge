#!/usr/bin/env node
import { launch, restore } from "./app.ts";
import { ask, listBots, read, send, status } from "./bot.ts";
import { CDP, cdpPort, listTargets } from "./cdp.ts";
import { serveMcp } from "./mcp.ts";
import { VERSION } from "./version.ts";

const USAGE = `grokbot ${VERSION} — talk to your Grok Bots from the terminal or any agent

Usage:
  grokbot ask <bot> <message...>    Send a message and wait for the reply
  grokbot send <bot> <message...>   Send without waiting
  grokbot read <bot>                Show recent messages in a conversation
  grokbot bots                      List your Bots
  grokbot status                    Check the connection
  grokbot launch                    (Re)start Grok Bot with the local debug port
  grokbot restore                   Restart Grok Bot normally (closes the port)
  grokbot mcp                       Run as an MCP server over stdio

Options:
  --timeout <sec>   ask: max seconds to wait (default 300)
  --limit <n>       read: number of messages (default 10)
  --json            Machine-readable output
  --quiet           ask: don't stream progress to stderr
  -v, --version     Print version
  -h, --help        Show this help

Use "-" as the message to read it from stdin.
Env: GROKBOT_CDP_PORT (default 9333), GROKBOT_APP (path to the app)`;

function parse(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "--quiet") flags[a.slice(2)] = true;
    else if (a === "--timeout" || a === "--limit") flags[a.slice(2)] = argv[++i] ?? "";
    else if (a === "-h" || a === "--help") flags.help = true;
    else if (a === "-v" || a === "--version") flags.version = true;
    else rest.push(a);
  }
  return { flags, cmd: rest[0], args: rest.slice(1) };
}

async function readMessage(parts: string[]): Promise<string> {
  if (parts.length === 1 && parts[0] === "-") {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  return parts.join(" ").trim();
}

function positiveNumber(v: string | boolean | undefined, name: string, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
  return n;
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
  const { flags, cmd, args } = parse(process.argv.slice(2));
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
            `Connected on port ${port}. ${s.bots.length} Bot(s): ${s.bots.map((b) => b.name).join(", ")}${s.busy ? " · a Bot is working" : ""}`,
        );
      } finally {
        cdp.close();
      }
    }
    case "bots": {
      const bots = await withApp(listBots);
      return out(bots, () => bots.map((b) => `${b.active ? "*" : " "} ${b.label}  (${b.id})`).join("\n"));
    }
    case "read": {
      const [bot] = args;
      if (!bot) throw new Error("Usage: grokbot read <bot>");
      const r = await withApp((c) => read(c, bot, positiveNumber(flags.limit, "limit", 10)));
      return out(r, () =>
        r.messages.map((m) => `[${m.role === "user" ? "you" : m.role === "card" ? "card" : r.bot}] ${m.text}`).join("\n\n"),
      );
    }
    case "send": {
      const [bot, ...rest] = args;
      const msg = await readMessage(rest);
      if (!bot || !msg) throw new Error("Usage: grokbot send <bot> <message...>");
      const r = await withApp((c) => send(c, bot, msg));
      return out(r, () => `Sent to ${r.bot}.`);
    }
    case "ask": {
      const [bot, ...rest] = args;
      const msg = await readMessage(rest);
      if (!bot || !msg) throw new Error("Usage: grokbot ask <bot> <message...>");
      const timeoutMs = positiveNumber(flags.timeout, "timeout", 300) * 1000;
      const r = await withApp((c) =>
        ask(c, bot, msg, {
          timeoutMs,
          onUpdate: flags.quiet
            ? undefined
            : (m) => console.error(`[grokbot] ${m.role === "card" ? "card" : "reply"}: ${m.text.slice(0, 100).replace(/\s+/g, " ")}`),
        }),
      );
      out(r, () => {
        const body = r.messages.map((m) => (m.role === "card" ? `[card] ${m.text}` : m.text)).join("\n\n");
        const tail =
          r.status === "done"
            ? ""
            : `\n\n[grokbot] ${r.status === "timeout" ? `Still working after ${Math.round(r.elapsedMs / 1000)}s. Run \`grokbot read ${r.bot}\` later.` : "The conversation was switched in the app before the reply finished."}`;
        return (body || "(no reply yet)") + tail;
      });
      if (r.status !== "done") process.exitCode = 2;
      return;
    }
    default:
      throw new Error(`Unknown command "${cmd}".\n\n${USAGE}`);
  }
}

main().catch((e) => {
  console.error(`grokbot: ${e?.message ?? e}`);
  process.exit(1);
});
