import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

type RuntimeTarget = "chromium";
type RuntimeStatus = "healthy" | "needs_repair";
type BrowserName = "chromium" | "chromium-headless-shell";

interface BrowserDescriptor {
  name: string;
  revision: string;
}

interface ExecutableDescriptor {
  name: BrowserName;
  browserRoot: string;
  executablePath: string;
}

interface RepairCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface PlaywrightRuntimeState {
  healthy: boolean;
  needsRepair: boolean;
  repairing: boolean;
  repairFailed?: boolean;
  status: RuntimeStatus;
  target: RuntimeTarget;
  message: string;
  detail?: string;
  lastCheckedAt: string;
}

export interface PlaywrightRuntimeService {
  check(): Promise<PlaywrightRuntimeState>;
  ensure?(): Promise<PlaywrightRuntimeState>;
  repair(): Promise<PlaywrightRuntimeState>;
}

export interface BuildPlaywrightRuntimeServiceOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  runInstall?: (cwd: string, env: NodeJS.ProcessEnv) => Promise<RepairCommandResult>;
}

const EXECUTABLE_PATHS: Record<BrowserName, Record<string, string[] | undefined>> = {
  chromium: {
    "linux-x64": ["chrome-linux64", "chrome"],
    "linux-arm64": ["chrome-linux", "chrome"],
    "mac-x64": [
      "chrome-mac-x64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    ],
    "mac-arm64": [
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    ],
    "win-x64": ["chrome-win64", "chrome.exe"],
  },
  "chromium-headless-shell": {
    "linux-x64": ["chrome-headless-shell-linux64", "chrome-headless-shell"],
    "linux-arm64": ["chrome-linux", "headless_shell"],
    "mac-x64": ["chrome-headless-shell-mac-x64", "chrome-headless-shell"],
    "mac-arm64": ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
    "win-x64": ["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
  },
};

function getShortPlatform(): string {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === "darwin") {
    return arch === "arm64" ? "mac-arm64" : "mac-x64";
  }
  if (platform === "linux") {
    return arch === "arm64" ? "linux-arm64" : "linux-x64";
  }
  if (platform === "win32") {
    return "win-x64";
  }
  return "<unknown>";
}

function normalizeDirectoryName(browserName: string, revision: string): string {
  return `${browserName.replaceAll("-", "_")}-${revision}`;
}

function getInstallCommand(): string[] {
  return [process.platform === "win32" ? "npx.cmd" : "npx", "playwright", "install", "chromium"];
}

function looksLikeRelativePath(value: string): boolean {
  return !path.isAbsolute(value);
}

export function resolvePlaywrightBrowsersPath(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured === "0") {
    return path.join(cwd, "node_modules", "playwright-core", ".local-browsers");
  }
  if (configured && configured.trim()) {
    const base = env.INIT_CWD?.trim() ? env.INIT_CWD : cwd;
    return looksLikeRelativePath(configured) ? path.resolve(base, configured) : configured;
  }
  return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
}

async function readBrowserDescriptors(cwd: string): Promise<Map<string, BrowserDescriptor>> {
  const browsersJsonPath = path.join(cwd, "node_modules", "playwright-core", "browsers.json");
  const raw = await readFile(browsersJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { browsers?: Array<{ name: string; revision: string }> };
  const descriptors = new Map<string, BrowserDescriptor>();
  for (const browser of parsed.browsers ?? []) {
    if (typeof browser.name === "string" && typeof browser.revision === "string") {
      descriptors.set(browser.name, { name: browser.name, revision: browser.revision });
    }
  }
  return descriptors;
}

export async function resolvePlaywrightExecutables(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExecutableDescriptor[]> {
  const descriptors = await readBrowserDescriptors(cwd);
  const browserRoot = resolvePlaywrightBrowsersPath(cwd, env);
  const shortPlatform = getShortPlatform();

  return (["chromium", "chromium-headless-shell"] as const).flatMap((name) => {
    const descriptor = descriptors.get(name);
    const tokens = EXECUTABLE_PATHS[name][shortPlatform];
    if (!descriptor || !tokens) {
      return [];
    }
    return [
      {
        name,
        browserRoot: path.join(browserRoot, normalizeDirectoryName(name, descriptor.revision)),
        executablePath: path.join(
          browserRoot,
          normalizeDirectoryName(name, descriptor.revision),
          ...tokens,
        ),
      },
    ];
  });
}

async function canAccessExecutable(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function summarizeRepairOutput(result: RepairCommandResult): string {
  const combined = `${result.stderr}\n${result.stdout}\n${result.error ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (combined.length === 0) {
    return "未拿到安装输出。";
  }
  return combined.slice(-6).join(" | ");
}

function describeMissingExecutables(executables: ExecutableDescriptor[]): string {
  return executables
    .map((entry) =>
      entry.name === "chromium-headless-shell"
        ? `headless shell 缺失：${entry.executablePath}`
        : `chromium 缺失：${entry.executablePath}`,
    )
    .join("\n");
}

async function defaultRunInstall(cwd: string, env: NodeJS.ProcessEnv): Promise<RepairCommandResult> {
  const [command, ...args] = getInstallCommand();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        code: -1,
        stdout,
        stderr,
        error: error.message,
      });
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
      });
    });
  });
}

function buildState(
  now: () => Date,
  input: Omit<PlaywrightRuntimeState, "lastCheckedAt" | "status" | "needsRepair" | "repairFailed"> & {
    healthy: boolean;
    repairFailed?: boolean;
  },
): PlaywrightRuntimeState {
  return {
    ...input,
    needsRepair: !input.healthy,
    repairFailed: input.repairFailed ?? false,
    status: input.healthy ? "healthy" : "needs_repair",
    lastCheckedAt: now().toISOString(),
  };
}

export function isRepairablePlaywrightErrorText(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.toLowerCase();
  return (
    normalized.includes("executable doesn't exist") ||
    normalized.includes("playwright install chromium") ||
    normalized.includes("chromium_headless_shell") ||
    normalized.includes("chrome-headless-shell") ||
    normalized.includes("ms-playwright/chromium")
  );
}

export function buildPlaywrightRuntimeService(
  options: BuildPlaywrightRuntimeServiceOptions = {},
): PlaywrightRuntimeService {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const runInstall = options.runInstall ?? defaultRunInstall;

  let repairPromise: Promise<PlaywrightRuntimeState> | null = null;
  let lastRepairFailure: { message: string; detail?: string } | null = null;
  let autoRepairAttempted = false;

  const probe = async (): Promise<PlaywrightRuntimeState> => {
    try {
      const executables = await resolvePlaywrightExecutables(cwd, env);
      if (executables.length === 0) {
        return buildState(now, {
          healthy: false,
          repairing: false,
          target: "chromium",
          message:
            lastRepairFailure?.message ??
            "无法确认 Chromium 截图运行环境，请尝试修复。",
          detail:
            lastRepairFailure?.detail ??
            "没有找到可检查的 Chromium / headless shell 描述。",
        });
      }
      const missingExecutables: ExecutableDescriptor[] = [];
      for (const executable of executables) {
        if (!(await canAccessExecutable(executable.executablePath))) {
          missingExecutables.push(executable);
        }
      }

      if (missingExecutables.length === 0) {
        lastRepairFailure = null;
        autoRepairAttempted = false;
        return buildState(now, {
          healthy: true,
          repairing: false,
          target: "chromium",
          message: "Chromium 截图运行环境正常",
          detail: undefined,
        });
      }

      return buildState(now, {
        healthy: false,
        repairing: false,
        repairFailed: Boolean(lastRepairFailure),
        target: "chromium",
        message:
          lastRepairFailure?.message ??
          "Chromium 截图浏览器缺失，已提交任务会直接失败，请先修复。",
        detail: lastRepairFailure?.detail ?? describeMissingExecutables(missingExecutables),
      });
    } catch (error) {
      return buildState(now, {
        healthy: false,
        repairing: false,
        repairFailed: Boolean(lastRepairFailure),
        target: "chromium",
        message: lastRepairFailure?.message ?? "无法确认 Chromium 截图运行环境，请尝试修复。",
        detail: lastRepairFailure?.detail ?? (error instanceof Error ? error.message : String(error)),
      });
    }
  };

  const service: PlaywrightRuntimeService = {
    async check() {
      if (repairPromise) {
        return buildState(now, {
          healthy: false,
          repairing: true,
          target: "chromium",
          message: "正在修复 Chromium 截图运行环境…",
          detail: "正在执行 npx playwright install chromium",
        });
      }
      return probe();
    },
    async ensure() {
      if (repairPromise) {
        return service.check();
      }

      const current = await probe();
      if (current.healthy) {
        return current;
      }
      if (autoRepairAttempted) {
        return current;
      }

      autoRepairAttempted = true;
      void service.repair();
      return service.check();
    },
    async repair() {
      if (repairPromise) {
        return repairPromise;
      }

      repairPromise = (async () => {
        const current = await probe();
        if (current.healthy) {
          return current;
        }

        const result = await runInstall(cwd, env);
        if (result.code !== 0) {
          lastRepairFailure = {
            message: "Chromium 修复失败，请重试。",
            detail: summarizeRepairOutput(result),
          };
          return probe();
        }

        const checked = await probe();
        if (!checked.healthy) {
          lastRepairFailure = {
            message: "Chromium 安装命令已完成，但运行环境仍不可用。",
            detail: checked.detail,
          };
          return probe();
        }
        return checked;
      })().finally(() => {
        repairPromise = null;
      });

      return repairPromise;
    },
  };

  return service;
}
