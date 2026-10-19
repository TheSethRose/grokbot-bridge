# AGENTS.md

## Project Overview

- `grokbot-bridge` is an unofficial CLI (`grokbot`) and stdio MCP server that drive the user's Grok Bot desktop app (Electron) over the Chrome DevTools Protocol on `127.0.0.1` (port `GROKBOT_CDP_PORT`, default 9333).
- It has no runtime dependencies and makes no network calls of its own. It runs on Node 22+ (global `WebSocket`); Bun is the dev tool.
- Everything works through the app's internal renderer stores, found in React context. These are undocumented and tied to the tested app version (Grok Bot 0.71.2). Expect breakage on app updates.

## Setup Commands

- Install dev dependencies: `bun install`
- Run from source: `bun run dev -- <command>` (or `bun src/cli.ts <command>`)

## Test and Validation Commands

- Type-check and lint: `bun run check` (tsc + Biome). Auto-fix formatting: `bun run format`.
- Build: `bun run build`. It writes `dist/cli.js`, which is committed so installing from the GitHub tarball works. Rebuild it before every commit that touches `src/`.
- There is no automated test suite. Verify behavior against the live app:
  - Read-only checks first: `status`, `bots`, `read <bot> --limit 3`, `routines <bot>`, `usage`.
  - MCP: pipe newline-delimited JSON-RPC (`initialize`, `tools/list`, `tools/call`) into `bun src/cli.ts mcp`.
- Any command except `status` and `restore` may restart the user's Grok Bot app with the debug port (`launch`). Tell the user before the first restart.

## Architecture Notes

- `src/cli.ts`: argument parsing, help text, output formatting, exit codes (`ask`/`wait`: 0 done, 2 timeout, 3 needs input).
- `src/mcp.ts`: MCP tool definitions and dispatch. Keep tool names and arguments in step with the CLI.
- `src/cdp.ts`: minimal CDP client (`eval`, `call`, `bind` for page-to-CLI events).
- `src/page.ts`: the only place that finds app internals (`store(name, method)`, `ACCOUNT_SLOT`), plus shared page-side helpers (`PAGE_ERROR`, `PAGE_AWAKE`).
- `src/bot.ts`: Bot list, transcripts, send (with files), `wait`/`watch`, `stop`, `download`, `usage`.
- `src/roster.ts`: create, update and delete Bots. `src/routines.ts`: routines. `src/app.ts`: finding, launching and restoring the app.
- Code in template strings passed to `cdp.call` runs inside the app's renderer, not in Node. Write plain JavaScript there, escape backslashes (`\\`) in regexes, and pass data as arguments instead of interpolating it.
- Long page-side waits are driven by the CLI's one-second heartbeat (`withHeartbeat` in `src/bot.ts`), because the app throttles window timers in the background. Don't rely on `setTimeout`/`setInterval` timing in page code.
- To investigate a new app version, extract `/Applications/Grok Bot.app/Contents/Resources/app.asar` into a temporary directory and probe the live window over CDP. Never commit extracted app code.

## Safety and Data Rules

- Live tests act on the user's real account: messages land in their Bot's history and use their weekly Grok Bot usage. Keep test messages short, labelled as tests, and research-only. Delete only the test routines or Bots you created yourself.
- Never answer a Bot's approval cards or questions programmatically; report `needs_input` to the user.
- `SAND_AWAY_PARK` means Grok Bot thinks nobody is at the Mac: screen locked, Mac asleep, or its window unfocused for 10 minutes with no input in macOS's idle count (`HIDIdleTime`, which Karabiner's virtual keyboard doesn't reset). Don't fake presence or focus the window yourself; ask the user to bring Grok Bot to the front, then retry.
- Don't print or log the account slot, cookies or other identifiers read from the app beyond what a command needs.
- Keep `delete` and `routines remove` behind `--yes` (CLI) and `confirm` (MCP), with exact-name matching.

## Docs

- When commands, flags or MCP tools change, update `README.md`, the CLI help text in `src/cli.ts`, the MCP tool descriptions, and `skills/grok-bot/SKILL.md` in the same change.

## PR / Commit Notes

- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`). Don't bump `version` (in `package.json` and `src/version.ts`) unless a release is requested.
