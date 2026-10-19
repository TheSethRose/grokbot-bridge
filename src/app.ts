// Start, stop and locate the Grok Bot desktop app on each platform.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cdpPort, listTargets } from "./cdp.ts";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PROCESS_NAME = "Grok Bot";

function appCandidates(): string[] {
  if (process.env.GROKBOT_APP) return [process.env.GROKBOT_APP];
  switch (process.platform) {
    case "darwin":
      return ["/Applications/Grok Bot.app", join(homedir(), "Applications/Grok Bot.app")];
    case "win32": {
      const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local");
      return [join(local, "Programs/Grok Bot/Grok Bot.exe"), join(process.env.ProgramFiles ?? "C:/Program Files", "Grok Bot/Grok Bot.exe")];
    }
    default:
      return ["/opt/Grok Bot/grok-bot", "/usr/bin/grok-bot", "/usr/local/bin/grok-bot"];
  }
}

export function findApp(): string {
  const found = appCandidates().find((p) => existsSync(p));
  if (!found) throw new Error(`Grok Bot app not found. Looked in:\n  ${appCandidates().join("\n  ")}\nSet GROKBOT_APP to its path.`);
  return found;
}

export async function isRunning(): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await run("tasklist", ["/FI", `IMAGENAME eq ${PROCESS_NAME}.exe`, "/NH"]);
      return stdout.includes(PROCESS_NAME);
    }
    const pattern = process.platform === "darwin" ? "Grok Bot.app/Contents/MacOS/Grok Bot" : "grok-bot|Grok Bot";
    await run("pgrep", ["-f", pattern]);
    return true;
  } catch {
    return false;
  }
}

async function quit(): Promise<void> {
  if (!(await isRunning())) return;
  if (process.platform === "darwin") await run("osascript", ["-e", `tell application "${PROCESS_NAME}" to quit`]).catch(() => {});
  else if (process.platform === "win32") await run("taskkill", ["/IM", `${PROCESS_NAME}.exe`]).catch(() => {});
  else await run("pkill", ["-TERM", "-f", "grok-bot|Grok Bot"]).catch(() => {});
  for (let i = 0; i < 40 && (await isRunning()); i++) await sleep(250);
  if (await isRunning()) throw new Error("Grok Bot didn't quit. Quit it yourself, then rerun.");
}

function start(app: string, args: string[]): void {
  if (process.platform === "darwin") {
    spawn("open", ["-a", app, ...(args.length ? ["--args", ...args] : [])], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn(app, args, { detached: true, stdio: "ignore" }).unref();
  }
}

export type LaunchResult = { port: number; restarted: boolean };

/** Ensure Grok Bot is running with a loopback-only debug port. Restarts the app if needed. */
export async function launch(): Promise<LaunchResult> {
  const port = cdpPort();
  if (await listTargets(port)) return { port, restarted: false };
  const app = findApp();
  await quit();
  start(app, [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"]);
  for (let i = 0; i < 80; i++) {
    if (await listTargets(port)) return { port, restarted: true };
    await sleep(250);
  }
  throw new Error(`Grok Bot started but debug port ${port} never opened.`);
}

/** Relaunch Grok Bot normally, closing the debug port. */
export async function restore(): Promise<void> {
  const app = findApp();
  await quit();
  start(app, []);
}
