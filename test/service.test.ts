import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPlan } from "../src/app.ts";
import { installService, SERVICE_CONFLICT_EXIT } from "../src/service.ts";

describe("launchPlan", () => {
  test("uses the running service and never opens a port", () => {
    expect(launchPlan({ serviceUp: true, serviceInstalled: true, portOpen: false })).toBe("use-service");
  });

  // /verify, 17/11/2026: with the app closed, an agent call reopened Grok Bot with port 9333
  // outside the installed service, and the service then failed in a restart loop.
  test("starts the installed service instead of reopening the app with a port", () => {
    expect(launchPlan({ serviceUp: false, serviceInstalled: true, portOpen: false })).toBe("start-service");
    expect(launchPlan({ serviceUp: false, serviceInstalled: true, portOpen: true })).toBe("start-service");
  });

  test("keeps the port flow when the service isn't installed", () => {
    expect(launchPlan({ serviceUp: false, serviceInstalled: false, portOpen: true })).toBe("use-port");
    expect(launchPlan({ serviceUp: false, serviceInstalled: false, portOpen: false })).toBe("restart-with-port");
  });
});

describe("installService", () => {
  let config: string;
  const saved = process.env.XDG_CONFIG_HOME;
  beforeEach(() => {
    config = mkdtempSync(join(tmpdir(), "grokbot-config-"));
    process.env.XDG_CONFIG_HOME = config;
  });
  afterEach(() => {
    process.env.XDG_CONFIG_HOME = saved;
    rmSync(config, { recursive: true, force: true });
  });

  test("tells systemd not to restart the service when Grok Bot is already open without it", () => {
    const unit = readFileSync(installService("/opt/grokbot/cli.js"), "utf8");

    expect(unit).toContain(`RestartPreventExitStatus=${SERVICE_CONFLICT_EXIT}`);
    expect(unit).toContain("Restart=on-failure");
  });
});
