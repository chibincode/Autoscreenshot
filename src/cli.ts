#!/usr/bin/env node

import path from "node:path";
import { resolveJobOptions, executeInstruction, retryImportByManifestPath, summarizeManifest } from "./core/job-service.js";
import { loadDotEnvFile } from "./core/env.js";
import type { DprOption, JobExecutionOptions, SectionScope } from "./types.js";

type ParsedArgs =
  | { command: "help" }
  | { command: "capture"; instruction: string; options: Partial<JobExecutionOptions> }
  | { command: "retry-import"; manifestPath: string };

function printHelp(): void {
  process.stdout.write(
    `
autosnap "<instruction>" [options]
autosnap retry-import <manifestPath>

Options:
  --quality <1-100>                 JPG quality (default: 92)
  --dpr <auto|1|2>                  Device pixel ratio (default: auto)
  --section-scope <classic|all-top-level|manual>
                                     Section capture policy (default: classic)
  --max-sections <1-20>              Classic mode max selected sections (default: 10)
  --output-dir <path>               Output base directory (default: ./output)
  -h, --help                        Show help
`.trimStart(),
  );
}

function parseCliArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    return { command: "help" };
  }

  if (argv[0] === "retry-import") {
    const manifestPath = argv[1];
    if (!manifestPath) {
      throw new Error("retry-import requires a manifest path");
    }
    return { command: "retry-import", manifestPath };
  }

  const options: Partial<JobExecutionOptions> = {};
  const freeArgs: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      freeArgs.push(arg);
      continue;
    }

    if (arg === "--quality") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 1 || value > 100) {
        throw new Error("--quality must be a number between 1 and 100");
      }
      options.quality = Math.round(value);
      i += 1;
      continue;
    }

    if (arg === "--dpr") {
      const value = argv[i + 1];
      if (value !== "auto" && value !== "1" && value !== "2") {
        throw new Error("--dpr must be one of: auto, 1, 2");
      }
      options.dpr = (value === "auto" ? "auto" : value === "1" ? 1 : 2) as DprOption;
      i += 1;
      continue;
    }

    if (arg === "--section-scope") {
      const value = argv[i + 1];
      if (value !== "classic" && value !== "all-top-level" && value !== "manual") {
        throw new Error("--section-scope must be one of: classic, all-top-level, manual");
      }
      options.sectionScope = value as SectionScope;
      i += 1;
      continue;
    }

    if (arg === "--output-dir") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--output-dir requires a path");
      }
      options.outputDir = value;
      i += 1;
      continue;
    }

    if (arg === "--max-sections") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 1 || value > 20) {
        throw new Error("--max-sections must be a number between 1 and 20");
      }
      options.classicMaxSections = Math.round(value);
      i += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  const instruction = freeArgs.join(" ").trim();
  if (!instruction) {
    throw new Error("Missing instruction. Example: autosnap \"open https://example.com\"");
  }

  return { command: "capture", instruction, options };
}

async function runCapture(instruction: string, rawOptions: Partial<JobExecutionOptions>): Promise<void> {
  const options = resolveJobOptions(rawOptions);
  const result = await executeInstruction({
    instruction,
    options,
    cwd: process.cwd(),
    log: (level, message) => {
      const prefix = level.toUpperCase();
      process.stdout.write(`[${prefix}] ${message}\n`);
    },
  });

  const summary = summarizeManifest(result.manifest);
  process.stdout.write(
    [
      `Run ID: ${result.runId}`,
      `Output: ${result.manifest.outputDir}`,
      `Manifest: ${result.manifestPath}`,
      `Assets: ${summary.total} (imported: ${summary.imported}, failed: ${summary.failed})`,
    ].join("\n") + "\n",
  );
}

async function runRetryImport(manifestPath: string): Promise<void> {
  const resolvedPath = path.resolve(process.cwd(), manifestPath);
  const manifest = await retryImportByManifestPath(resolvedPath, (level, message) => {
    process.stdout.write(`[${level.toUpperCase()}] ${message}\n`);
  });
  const summary = summarizeManifest(manifest);
  process.stdout.write(
    [
      `Manifest: ${resolvedPath}`,
      `Assets: ${summary.total} (imported: ${summary.imported}, failed: ${summary.failed})`,
    ].join("\n") + "\n",
  );
}

async function main(): Promise<void> {
  await loadDotEnvFile(process.cwd());
  const parsed = parseCliArgs(process.argv.slice(2));

  if (parsed.command === "help") {
    printHelp();
    return;
  }
  if (parsed.command === "retry-import") {
    await runRetryImport(parsed.manifestPath);
    return;
  }

  await runCapture(parsed.instruction, parsed.options);
}

main().catch((error) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
