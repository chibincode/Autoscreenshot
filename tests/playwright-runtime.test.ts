import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import {
  buildPlaywrightRuntimeService,
  isRepairablePlaywrightErrorText,
  resolvePlaywrightBrowsersPath,
} from "../src/server/playwright-runtime.js";

async function createFakeProject(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "autoscreenshot-playwright-runtime-"));
  const playwrightCoreDir = path.join(cwd, "node_modules", "playwright-core");
  await fs.mkdir(playwrightCoreDir, { recursive: true });
  await fs.writeFile(
    path.join(playwrightCoreDir, "browsers.json"),
    JSON.stringify(
      {
        browsers: [
          { name: "chromium", revision: "1208" },
          { name: "chromium-headless-shell", revision: "1208" },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return cwd;
}

async function writeExecutable(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  await fs.chmod(filePath, 0o755);
}

describe("playwright runtime service", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("reports healthy when chromium and headless shell exist", async () => {
    const cwd = await createFakeProject();
    tempDirs.push(cwd);
    const env = { PLAYWRIGHT_BROWSERS_PATH: path.join(cwd, "pw-cache") };
    const browserRoot = resolvePlaywrightBrowsersPath(cwd, env);

    await writeExecutable(
      path.join(
        browserRoot,
        "chromium-1208",
        "chrome-mac-arm64",
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing",
      ),
    );
    await writeExecutable(
      path.join(browserRoot, "chromium_headless_shell-1208", "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
    );

    const service = buildPlaywrightRuntimeService({ cwd, env });
    const state = await service.check();

    expect(state.healthy).toBe(true);
    expect(state.needsRepair).toBe(false);
    expect(state.message).toContain("运行环境正常");
  });

  it("reports needs repair when headless shell is missing", async () => {
    const cwd = await createFakeProject();
    tempDirs.push(cwd);
    const env = { PLAYWRIGHT_BROWSERS_PATH: path.join(cwd, "pw-cache") };
    const browserRoot = resolvePlaywrightBrowsersPath(cwd, env);

    await writeExecutable(
      path.join(
        browserRoot,
        "chromium-1208",
        "chrome-mac-arm64",
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing",
      ),
    );

    const service = buildPlaywrightRuntimeService({ cwd, env });
    const state = await service.check();

    expect(state.healthy).toBe(false);
    expect(state.needsRepair).toBe(true);
    expect(state.detail).toContain("headless shell");
  });

  it("repairs by running playwright install chromium and avoids duplicate installs", async () => {
    const cwd = await createFakeProject();
    tempDirs.push(cwd);
    const env = { PLAYWRIGHT_BROWSERS_PATH: path.join(cwd, "pw-cache") };
    const browserRoot = resolvePlaywrightBrowsersPath(cwd, env);

    let installRuns = 0;
    let releaseInstall = () => {
      // no-op
    };
    const installReady = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });

    const service = buildPlaywrightRuntimeService({
      cwd,
      env,
      runInstall: async () => {
        installRuns += 1;
        await installReady;
        await writeExecutable(
          path.join(
            browserRoot,
            "chromium-1208",
            "chrome-mac-arm64",
            "Google Chrome for Testing.app",
            "Contents",
            "MacOS",
            "Google Chrome for Testing",
          ),
        );
        await writeExecutable(
          path.join(browserRoot, "chromium_headless_shell-1208", "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
        );
        return { code: 0, stdout: "installed", stderr: "" };
      },
    });

    const repairOne = service.repair();
    const repairTwo = service.repair();
    releaseInstall();
    const [first, second] = await Promise.all([repairOne, repairTwo]);

    expect(installRuns).toBe(1);
    expect(first.healthy).toBe(true);
    expect(second.healthy).toBe(true);
  });

  it("automatically repairs a missing runtime once", async () => {
    const cwd = await createFakeProject();
    tempDirs.push(cwd);
    const env = { PLAYWRIGHT_BROWSERS_PATH: path.join(cwd, "pw-cache") };
    const browserRoot = resolvePlaywrightBrowsersPath(cwd, env);

    let installRuns = 0;
    let releaseInstall = () => {
      // no-op
    };
    const installReady = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    const service = buildPlaywrightRuntimeService({
      cwd,
      env,
      runInstall: async () => {
        installRuns += 1;
        await installReady;
        await writeExecutable(
          path.join(
            browserRoot,
            "chromium-1208",
            "chrome-mac-arm64",
            "Google Chrome for Testing.app",
            "Contents",
            "MacOS",
            "Google Chrome for Testing",
          ),
        );
        await writeExecutable(
          path.join(browserRoot, "chromium_headless_shell-1208", "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
        );
        return { code: 0, stdout: "installed", stderr: "" };
      },
    });

    const first = await service.ensure?.();
    const second = await service.ensure?.();
    expect(first?.repairing).toBe(true);
    expect(second?.repairing).toBe(true);

    releaseInstall();
    const repaired = await service.repair();
    expect(repaired.healthy).toBe(true);
    expect(installRuns).toBe(1);
  });

  it("does not loop automatic repair after an install failure", async () => {
    const cwd = await createFakeProject();
    tempDirs.push(cwd);
    const env = { PLAYWRIGHT_BROWSERS_PATH: path.join(cwd, "pw-cache") };
    let installRuns = 0;
    const service = buildPlaywrightRuntimeService({
      cwd,
      env,
      runInstall: async () => {
        installRuns += 1;
        return { code: 1, stdout: "", stderr: "network unavailable" };
      },
    });

    await service.ensure?.();
    const failed = await service.repair();
    const checkedAgain = await service.ensure?.();

    expect(failed.repairFailed).toBe(true);
    expect(checkedAgain?.repairFailed).toBe(true);
    expect(installRuns).toBe(1);
  });

  it("detects repairable playwright missing executable errors", () => {
    expect(
      isRepairablePlaywrightErrorText(
        "browserType.launch: Executable doesn't exist at /Users/me/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell",
      ),
    ).toBe(true);
    expect(isRepairablePlaywrightErrorText("navigation failed: net::ERR_CONNECTION_CLOSED")).toBe(false);
  });
});
