// Start, stop and locate the Grok Bot desktop app on each platform.
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CDP, cdpPort, listTargets } from "./cdp.ts";
import { APP_READY } from "./page.ts";

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
      return linuxAppCandidates(homedir());
  }
}

// AppImages have no install path: users keep them under any name (grok_bot.appimage, Grok-Bot-1.0.1-x86_64.AppImage).
const APPIMAGE_DIRS = ["Applications", "AppImages", ".local/bin", "Downloads"];
const APPIMAGE_NAME = /^grok[-_ ]?bot.*\.appimage$/i;

export function linuxAppCandidates(home: string): string[] {
  const appImages = APPIMAGE_DIRS.flatMap((dir) => {
    const full = join(home, dir);
    try {
      return readdirSync(full)
        .filter((name) => APPIMAGE_NAME.test(name))
        .map((name) => join(full, name));
    } catch {
      return [];
    }
  });
  return ["/opt/Grok Bot/grok-bot", "/usr/bin/grok-bot", "/usr/local/bin/grok-bot", ...appImages];
}

/** pgrep/pkill arguments that match the running app and nothing else. */
export function processMatchArgs(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") return ["-f", "Grok Bot.app/Contents/MacOS/Grok Bot"];
  // The .deb, .rpm and AppImage builds all run an executable named grok-bot. A -f pattern would also
  // match unrelated command lines that mention it (an editor, a shell, a wrapper script) and pkill them.
  return ["-x", "grok-bot"];
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
    if (process.platform === "darwin") {
      await run("pgrep", processMatchArgs(process.platform));
      return true;
    }
    const { stdout } = await run("ps", ["-C", "grok-bot", "-o", "stat="]);
    return hasLiveProcess(stdout);
  } catch {
    return false;
  }
}

/**
 * True if `ps -o stat=` output lists a process that isn't a zombie. On Linux the app's helpers stay
 * zombies for seconds after it exits, and pgrep counts them, so quit() used to time out.
 */
export function hasLiveProcess(psStat: string): boolean {
  return psStat.split("\n").some((line) => line.trim() !== "" && !line.trim().startsWith("Z"));
}

async function quit(): Promise<void> {
  if (!(await isRunning())) return;
  if (process.platform === "darwin") await run("osascript", ["-e", `tell application "${PROCESS_NAME}" to quit`]).catch(() => {});
  else if (process.platform === "win32") await run("taskkill", ["/IM", `${PROCESS_NAME}.exe`]).catch(() => {});
  else await run("pkill", ["-TERM", ...processMatchArgs(process.platform)]).catch(() => {});
  // Electron on Linux took 6-10+ s to shut down in testing; 10 s was too tight.
  for (let i = 0; i < 120 && (await isRunning()); i++) await sleep(250);
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
    if (await listTargets(port)) {
      await waitForMainWindow(port);
      return { port, restarted: true };
    }
    await sleep(250);
  }
  throw new Error(`Grok Bot started but debug port ${port} never opened.`);
}

// The debug port opens before the renderer has mounted the Bot list, so a command run right after a
// restart failed with "Couldn't reach Grok Bot's conversations". On timeout we return anyway and let
// that command report the real problem (signed out, no Bots, changed app version).
async function waitForMainWindow(port: number): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const cdp = await CDP.connect(port).catch(() => null);
    const ready = cdp ? await cdp.eval<boolean>(APP_READY).catch(() => false) : false;
    cdp?.close();
    if (ready) return;
    await sleep(250);
  }
}

/** Relaunch Grok Bot normally, closing the debug port. */
export async function restore(): Promise<void> {
  const app = findApp();
  await quit();
  start(app, []);
}
