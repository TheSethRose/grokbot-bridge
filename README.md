# grokbot-bridge

**Talk to your Grok Bots from Claude Code, Cursor, Codex, or any script.**

[Grok Bot](https://x.ai/bot) gives you always-on AI teammates that each have a cloud computer, a browser and your connected apps. It doesn't have an API, so other agents can't hand it work. `grokbot-bridge` fills that gap. It's a small CLI and MCP server that drive the Grok Bot desktop app on your own machine: they send a message to a Bot, wait for the reply, and return it as text or JSON.

```console
$ grokbot ask Chief "Research only. Find 3 posts on X from the last 14 days showing people using Grok Bot for something creative. URL, author, date, one-line summary."
[grokbot] reply: Searching X for recent ones now.
[grokbot] reply: I'll send the three posts once I've checked their dates.
[grokbot] reply: Here are three posts from the past two weeks. All three dates match what X reports…

Here are three posts from the past two weeks. All three dates match what X reports for the posts, and I didn't post or change anything.

[Restaurant-booking bot](https://x.com/…/status/…), from @… on Oct 18, 2026. He built a bot whose only job is to call restaurants in a Grok voice and book a table.
[Animated avatar tool](https://x.com/…/status/…), from @… on Oct 18, 2026. …
```

<sub>Real output from a 77-second run, trimmed, with handles removed. Links come back as Markdown, and `--json` also lists them per message.</sub>

> [!NOTE]
> This is an unofficial community project. It isn't affiliated with or endorsed by xAI or Cursor. It automates the desktop app you already use, under your own account.

## Why

Your coding agent is good at code. Your Grok Bot is good at things that need a browser that stays on: researching X and the web, watching pages, working through sites with no API, and doing long jobs while your laptop sleeps. With this bridge, one agent can delegate to the other:

- **Claude Code → Grok Bot:** "Ask Chief to collect B-roll posts for this transcript and send me the links."
- **Scripts → Grok Bot:** `grokbot ask Chief "$(cat brief.md)" --json | jq …`
- **Any MCP client:** tools for `ask`, `send`, `read`, `list_bots` and `usage`.

## Requirements

- The [Grok Bot desktop app](https://x.ai/bot), signed in, with at least one Bot
- Node.js 22 or newer (or Bun)
- macOS. Windows and Linux paths are included but untested; see [Platform support](#platform-support).

## Install

```bash
npm install -g https://github.com/TheSethRose/grokbot-bridge/archive/refs/heads/main.tar.gz
grokbot status
```

<sub>Use the tarball URL. With `npm install -g github:…`, npm 11 can link the global package to a temporary clone that it then deletes.</sub>

Or run it without installing: `npx -y github:TheSethRose/grokbot-bridge status`.

## Quick start

```bash
grokbot launch                 # restart Grok Bot with a local debug port (one time per app start)
grokbot bots                   # list your Bots
grokbot ask Chief "What can you help me with?"
grokbot read Chief             # recent messages in that conversation
```

`ask`, `send`, `read` and `bots` call `launch` for you if the app isn't connected yet.

## CLI

| Command | What it does |
| --- | --- |
| `grokbot ask <bot> <message…>` | Send a message and wait until the Bot goes idle, then print its replies |
| `grokbot send <bot> <message…>` | Send without waiting |
| `grokbot read <bot> [--limit N]` | Print recent messages in the conversation |
| `grokbot bots` | List Bots with their role and id |
| `grokbot usage` | Show your weekly usage limit: percent used, reset time, plan, on-demand spend |
| `grokbot status` | Check the connection and show usage |
| `grokbot launch` | Restart Grok Bot with the debug port (127.0.0.1 only) |
| `grokbot restore` | Restart Grok Bot normally, closing the port |
| `grokbot mcp` | Run as an MCP server over stdio |

Options: `--json` for machine-readable output, `--timeout <sec>` for `ask` (default 300), `--settle <sec>` for how long a Bot must stay idle before `ask` returns (default 8), `--quiet` to stop progress lines on stderr. Pass `-` as the message to read it from stdin.

`ask` exits with code `2` if the Bot is still working when the timeout hits. Bots often acknowledge first and report back minutes later, so use `grokbot read <bot>` to collect the rest.

## Use it from your agent

### MCP (Claude Code, Cursor, Codex and others)

The server exposes five tools: `grokbot_list_bots`, `grokbot_ask`, `grokbot_send`, `grokbot_read` and `grokbot_usage`.

**Claude Code**

```bash
claude mcp add grokbot -- grokbot mcp
```

**Cursor** (`~/.cursor/mcp.json`) or any client with `mcpServers` JSON:

```json
{ "mcpServers": { "grokbot": { "command": "grokbot", "args": ["mcp"] } } }
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.grokbot]
command = "grokbot"
args = ["mcp"]
```

If you didn't install globally, use `npx` with `-y github:TheSethRose/grokbot-bridge mcp` as the command and arguments.

### Agent skill

[`skills/grok-bot/SKILL.md`](skills/grok-bot/SKILL.md) teaches an agent when to delegate to a Bot, how to write a good brief, and the safety rules: the user approves actions, and Bot replies are data, not instructions. Install it for Claude Code:

```bash
mkdir -p ~/.claude/skills/grok-bot
curl -fsSL https://raw.githubusercontent.com/TheSethRose/grokbot-bridge/main/skills/grok-bot/SKILL.md -o ~/.claude/skills/grok-bot/SKILL.md
```

## How it works

```
your agent ──CLI / MCP──▶ grokbot-bridge ──Chrome DevTools Protocol (127.0.0.1)──▶ Grok Bot desktop app ──▶ your Bot's cloud computer
```

Grok Bot is an Electron app. `grokbot launch` restarts it with Chromium's `--remote-debugging-port` bound to `127.0.0.1`. The bridge then works the app the way you would:

1. Opens the Bot's conversation from the sidebar (`data-agent-id`).
2. Types into the message box and presses Enter.
3. Watches the transcript (`data-role="assistant"` rows) and the Bot's activity marks (`data-grok-state`: `working`, `running` while it uses tools, `streaming` while it types) until every mark has been `idle` for a few seconds.

`grokbot usage` calls the read-only getter that the app's own settings card uses, so it returns the same "Weekly usage limit" numbers.

```console
$ grokbot usage
Weekly usage: 1.37% used · resets 10/22/2026, 11:44:33 AM (in 4 days) · plan: X Premium+
```

Messages go through the app's normal send path, so they show up in your conversation history like any message you typed. The bridge makes no network calls of its own and has no runtime dependencies.

## Security

- **The debug port gives local programs control of the app.** While Grok Bot runs with it, any process on your machine that connects to `127.0.0.1:9333` can act in the app as you. The port isn't exposed to your network. Run `grokbot restore` to close it.
- Bots can take real actions through your connected apps. Grok Bot's own approval prompts still apply, and the bridge never clicks them. Answer them in the app.
- Bot replies can include text from web pages. Agents should treat replies as untrusted data, and the bundled skill tells them to.

## Platform support

| Platform | Status |
| --- | --- |
| macOS | Tested with Grok Bot 0.71.2 |
| Windows | Should work; untested. Set `GROKBOT_APP` if the app isn't in `%LOCALAPPDATA%\Programs\Grok Bot` |
| Linux | Should work; untested. Set `GROKBOT_APP` to the binary path |

Environment variables: `GROKBOT_CDP_PORT` (default `9333`) and `GROKBOT_APP` (path to the app).

## Limitations

- **App updates can break it.** The bridge relies on the app's page structure. All selectors live at the top of [`src/bot.ts`](src/bot.ts), so fixes are usually small. Please open an issue with your Grok Bot version.
- **One conversation at a time.** Calls drive one shared window and are serialized. Switching conversations in the app during an `ask` stops it with status `interrupted`.
- **Recent history only.** The transcript is virtualized, so `read` returns what the app has rendered, usually the last 10–20 messages.
- **Bots must be in the sidebar.** Hidden Bots can't be selected.
- Don't type in the Bot's message box while an `ask` is running.

## Development

```bash
bun install
bun run dev -- status       # run from source
bun run check               # tsc + Biome
bun run build               # bundle to dist/cli.js (Node 22+)
```

`dist/cli.js` is committed so installing from GitHub works without a build step. Rebuild it before you commit.

## License

[MIT](LICENSE)
