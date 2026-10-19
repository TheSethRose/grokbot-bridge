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
- **Any MCP client:** tools to message Bots (with files), wait for and read replies, download files Bots send, manage routines, stop a Bot, check usage, and create, rename or delete Bots.

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

Every command except `status` and `restore` calls `launch` for you if the app isn't connected yet.

## CLI

| Command | What it does |
| --- | --- |
| `grokbot ask <bot> <message…> [--file <path>]` | Send a message and wait until the Bot has finished, then print its replies |
| `grokbot send <bot> <message…> [--file <path>]` | Send without waiting. Prints the message key |
| `grokbot wait <bot> [--since <key>]` | Wait for the Bot to finish replying to your latest message (or the one at `--since`) |
| `grokbot read <bot> [--limit N] [--since <key>]` | Print messages in the conversation: the last N, or everything after a key |
| `grokbot watch [bot]` | Stream new replies and `working` / `idle` / `needs_input` changes, one line each |
| `grokbot stop <bot>` | Interrupt what the Bot is doing, like the app's Stop button |
| `grokbot download <bot> [key…] [--out <dir>]` | Save files from the conversation: the messages with those keys, or the newest file the Bot sent. Never overwrites |
| `grokbot routines <bot>` | List the Bot's routines: prompts it runs on a schedule or trigger |
| `grokbot routines add <bot> --name <n> --schedule "<cron>" --prompt <text> [--disabled]` | Add a scheduled routine. `--prompt -` reads stdin |
| `grokbot routines run\|enable\|disable <bot> <routine>` | Run a routine now, or turn it on or off |
| `grokbot routines remove <bot> <routine> --yes` | Delete a routine. Needs the exact name or id |
| `grokbot bots` | List Bots with their id and whether each is working, needs your input or has unread messages |
| `grokbot create <name> [--description <text>]` | Create a Bot. It starts working when you send it a message |
| `grokbot update <bot> [--name <new>] [--description <text>]` | Rename a Bot or change its description |
| `grokbot delete <bot> --yes` | Permanently delete a Bot and its conversation. Needs the exact name or id |
| `grokbot usage` | Show your weekly usage limit: percent used, reset time, plan, on-demand spend |
| `grokbot status` | Check the connection and show usage |
| `grokbot launch` | Restart Grok Bot with the debug port (127.0.0.1 only) |
| `grokbot restore` | Restart Grok Bot normally, closing the port |
| `grokbot mcp` | Run as an MCP server over stdio |

Options: `--json` for machine-readable output, `--file <path>` to attach a file to `ask` or `send` (repeat it for several, 25 MB each), `--timeout <sec>` for `ask` (default 300) and `wait` (default 1800), `--settle <sec>` for how long a Bot must stay idle before its reply counts as finished (default 8), `--quiet` to stop progress lines on stderr. Pass `-` as the message to read it from stdin.

`ask` and `wait` exit with `0` when the Bot has finished, `2` if it's still working at the timeout, and `3` if it's waiting for you in the app (an approval card or a question). Bots often acknowledge first and report back minutes later; run `grokbot wait <bot>` again to keep waiting.

In `--json` output, file messages carry a `file` field (`name`, and `path` on the Bot's computer); pass their `key` to `download`. Schedules are standard 5-field cron, for example `"0 9 * * 1-5"` for 9:00 on weekdays.

### Getting told when a Bot replies

You don't need to sleep and check. `wait` returns the moment the Bot finishes, so start it in the background and let your shell or agent tell you when it exits:

```bash
grokbot send Chief "$(cat brief.md)" --file data.csv   # prints the message key
grokbot wait Chief --json > reply.json &               # returns when Chief is done
```

In Claude Code, run `grokbot ask …` or `grokbot wait …` as a background command; Claude is notified when it exits and reads the reply then. For a running feed across all Bots, `grokbot watch --json` prints one JSON object per event, which works with Claude Code's Monitor tool or any `while read` loop:

```console
$ grokbot watch --json
{"type":"working","bot":"Chief","at":"2026-10-19T04:40:00.133Z"}
{"type":"message","bot":"Chief","key":"t15s0","role":"assistant","kind":"send-message/text","text":"grokbot-bridge attachment check 7Q4K","links":[],"at":"2026-10-19T04:40:05.973Z"}
{"type":"idle","bot":"Chief","at":"2026-10-19T04:40:33.275Z"}
```

## Use it from your agent

### MCP (Claude Code, Cursor, Codex and others)

The server exposes twelve tools: `grokbot_list_bots`, `grokbot_ask`, `grokbot_send`, `grokbot_wait`, `grokbot_read`, `grokbot_stop`, `grokbot_download`, `grokbot_routines`, `grokbot_usage`, `grokbot_create_bot`, `grokbot_update_bot` and `grokbot_delete_bot`. `grokbot_ask` and `grokbot_send` take an optional `files` list. `grokbot_routines` takes an `action` (`list`, `add`, `run`, `enable`, `disable`, `remove`). `grokbot_delete_bot` and removing a routine require a `confirm` argument that repeats the exact name.

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

Grok Bot is an Electron app. `grokbot launch` restarts it with Chromium's `--remote-debugging-port` bound to `127.0.0.1`. The bridge then uses the same in-app stores the app's own screens use:

- **Reading:** each Bot's transcript store holds its whole conversation as structured entries, so `read` works for any Bot without switching the conversation on screen.
- **Sending:** messages and files go through the send queue the message box uses (files are staged first, the same way dragging a file onto the box does), so they show up in your history like anything you typed. The bridge never types into the message box, so your drafts are safe.
- **Waiting:** `wait`, `ask` and `watch` subscribe to the Bot list and transcript change events. A Bot counts as finished when it hasn't been working, using tools or typing for the settle time. If it's blocked on an approval card, they return `needs_input` right away.
- **Stopping:** `stop` calls the same interrupt as the Stop button, for every session the Bot is running.
- **Files:** `download` reads a file from the Bot's computer the way the app's file previews do, then saves it locally.
- **Routines:** `routines` uses the store behind the app's routines screen.

`grokbot usage` calls the read-only getter that the app's own settings card uses, so it returns the same "Weekly usage limit" numbers.

```console
$ grokbot usage
Weekly usage: 1.37% used · resets 10/22/2026, 11:44:33 AM (in 4 days) · plan: X Premium+
```

`create`, `update` and `delete` call the same Bot-list client the app's own New Bot, rename and delete actions use. The main Bot can't be deleted.

Bot edits and routine changes are saved on the Bot's cloud computer. The bridge first sends the app's own "user is here" signal, the same one clicking into a message box sends. If nobody has used the Mac for a while, Grok Bot parks the computer (`SAND_AWAY_PARK`) and these changes fail with a message saying so until someone uses the Mac again. Messages still go through while it's parked.

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

- **App updates can break it.** The bridge relies on internal stores of the app's renderer. The lookups live in [`src/page.ts`](src/page.ts) and the field names in [`src/bot.ts`](src/bot.ts), so fixes are usually small. Please open an issue with your Grok Bot version.
- **A Stop leaves no trace in the transcript.** A `wait` that is running when you stop a Bot returns with no messages, but one started afterwards can't tell a stopped message from one the Bot hasn't picked up yet, so it waits until its timeout.
- The Bot's internal tool steps are left out of `read` and `wait`, as the app folds them away too.
- **Routines and Bot edits need someone at the Mac.** See [How it works](#how-it-works).

## Development

```bash
bun install
bun run dev -- status       # run from source
bun run check               # tsc + Biome
bun run build               # bundle to dist/cli.js (Node 22+)
```

`dist/cli.js` is committed so installing from GitHub works without a build step. Rebuild it before you commit. Notes for coding agents are in [`AGENTS.md`](AGENTS.md).

## License

[MIT](LICENSE)
