// `grokbot service`: runs Grok Bot with Chromium's --remote-debugging-pipe instead of a port and
// shares that pipe over a Unix socket only your user can open. Grok Bot closes when the pipe's
// owner goes away, so this process has to outlive agent sessions: run it under systemd --user.
import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { findApp, isRunning, SERVICE_UNIT, serviceUnitPath } from "./app.ts";
import { serviceAvailable, serviceSocketPath } from "./cdp.ts";
import { PipeMux } from "./pipe-mux.ts";

const run = promisify(execFile);
export const UNIT_NAME = SERVICE_UNIT;
/** Exit code for "another Grok Bot or service is already open": retrying can't fix it, so systemd mustn't. */
export const SERVICE_CONFLICT_EXIT = 2;

/** Splits a stream of NUL-terminated messages, the framing of both the CDP pipe and the socket. */
function onFrames(stream: Readable, cb: (text: string) => void): void {
  let buf = "";
  stream.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    for (let i = buf.indexOf("\0"); i >= 0; i = buf.indexOf("\0")) {
      cb(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
}

export async function runService(): Promise<void> {
  const path = serviceSocketPath();
  const conflict = (await serviceAvailable())
    ? `The grokbot service is already running (${path}).`
    : (await isRunning())
      ? "Grok Bot is already open without the service. Quit it, then start the service."
      : null;
  if (conflict) {
    console.error(`grokbot: ${conflict}`);
    process.exitCode = SERVICE_CONFLICT_EXIT;
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  rmSync(path, { force: true });

  const app = spawn(findApp(), ["--remote-debugging-pipe"], { stdio: ["ignore", "inherit", "inherit", "pipe", "pipe"] });
  const toApp = app.stdio[3] as Writable;
  const mux = new PipeMux((text) => toApp.write(`${text}\0`));
  onFrames(app.stdio[4] as Readable, (text) => mux.fromBrowser(text));

  const server = createServer((sock: Socket) => {
    const client = mux.addClient((text) => sock.write(`${text}\0`));
    onFrames(sock, (text) => mux.fromClient(client, text));
    sock.on("close", () => mux.removeClient(client));
    sock.on("error", () => sock.destroy());
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  chmodSync(path, 0o600);
  console.error(`[grokbot] Service ready on ${path}.`);

  const stopApp = () => app.kill("SIGTERM");
  process.once("SIGTERM", stopApp);
  process.once("SIGINT", stopApp);
  // Quitting Grok Bot ends the service too, and it must not come back by itself: the app exits
  // with code 1 even on a normal quit, so the exit code can't tell a quit from a crash. Reopening
  // is the launcher's job (`grokbot open`); systemd's Restart=on-failure only covers a failed start.
  const code = await new Promise<number | string>((resolve) => app.once("exit", (c, signal) => resolve(c ?? signal ?? "unknown")));
  console.error(`[grokbot] Grok Bot exited (${code}); stopping the service.`);
  server.close();
  rmSync(path, { force: true });
}

/** What the desktop launcher runs: open Grok Bot through the service, or bring the open window forward. */
export async function openApp(args: string[]): Promise<void> {
  if (await serviceAvailable()) {
    // Grok Bot is single-instance: a second start hands its arguments (a grokbot:// link) to the open window and exits.
    spawn(findApp(), args, { detached: true, stdio: "ignore" }).unref();
    return;
  }
  await run("systemctl", ["--user", "start", UNIT_NAME]);
}

/** Write the systemd --user unit that keeps the service running for the graphical session. */
export function installService(cliPath: string): string {
  const unitPath = serviceUnitPath();
  const env = process.env.GROKBOT_APP ? `Environment=${JSON.stringify(`GROKBOT_APP=${process.env.GROKBOT_APP}`)}\n` : "";
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(
    unitPath,
    `[Unit]
Description=Grok Bot with a private debug pipe for grokbot-bridge
PartOf=graphical-session.target
After=graphical-session.target

[Service]
${env}ExecStart=${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} service
Restart=on-failure
RestartSec=3
RestartPreventExitStatus=${SERVICE_CONFLICT_EXIT}

[Install]
WantedBy=graphical-session.target
`,
  );
  return unitPath;
}
