import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasLiveProcess, linuxAppCandidates, processMatchArgs } from "../src/app.ts";

describe("linuxAppCandidates", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "grokbot-home-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const touch = (dir: string, name: string): string => {
    mkdirSync(join(home, dir), { recursive: true });
    const file = join(home, dir, name);
    writeFileSync(file, "");
    return file;
  };

  test("finds a Grok Bot AppImage in the usual user folders, whatever its spelling", () => {
    const underscore = touch("AppImages", "grok_bot.appimage");
    const versioned = touch("Applications", "Grok-Bot-1.0.1-x86_64.AppImage");

    const candidates = linuxAppCandidates(home);

    expect(candidates).toContain(underscore);
    expect(candidates).toContain(versioned);
  });

  test("ignores other AppImages and keeps the system install paths", () => {
    touch("Applications", "Obsidian-1.9.AppImage");
    touch("Applications", "grok-notes.txt");

    const candidates = linuxAppCandidates(home);

    expect(candidates.some((p) => p.includes("Obsidian") || p.includes("grok-notes"))).toBe(false);
    expect(candidates).toContain("/opt/Grok Bot/grok-bot");
    expect(candidates).toContain("/usr/bin/grok-bot");
  });
});

describe("processMatchArgs", () => {
  test("on Linux matches only the app's own process name, not any command line that mentions it", () => {
    expect(processMatchArgs("linux")).toEqual(["-x", "grok-bot"]);
  });

  test("on macOS keeps matching the app bundle's executable path", () => {
    expect(processMatchArgs("darwin")).toEqual(["-f", "Grok Bot.app/Contents/MacOS/Grok Bot"]);
  });
});

describe("hasLiveProcess", () => {
  // `ps -C grok-bot -o stat=` while the app shuts down: its helpers linger as zombies for seconds.
  test("is false when only zombies are left, so quit doesn't wait for them", () => {
    expect(hasLiveProcess("Z<\nZl\n")).toBe(false);
    expect(hasLiveProcess("")).toBe(false);
  });

  test("is true while any app process is still alive", () => {
    expect(hasLiveProcess("Sl\nZ\n")).toBe(true);
    expect(hasLiveProcess(" S<sl\n")).toBe(true);
  });
});
