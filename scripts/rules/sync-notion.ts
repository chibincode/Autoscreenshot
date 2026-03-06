#!/usr/bin/env tsx

import { loadDotEnvFile } from "../../src/core/env.js";
import {
  loadRulesRegistryFile,
  resolveRulesSyncConfigFromEnv,
  syncRulesToNotion,
} from "../../src/rules/notion-sync.js";

async function main(): Promise<void> {
  const cwd = process.cwd();
  await loadDotEnvFile(cwd);

  const config = resolveRulesSyncConfigFromEnv(cwd, process.env);
  if (!config.rulesJsonPath) {
    throw new Error("rulesJsonPath is required");
  }

  const rows = await loadRulesRegistryFile(config.rulesJsonPath);
  const summary = await syncRulesToNotion(rows, config);

  process.stdout.write(
    [
      `Notion sync complete`,
      `Database: ${summary.databaseId}`,
      `Local rules: ${summary.totalLocal}`,
      `Remote rules: ${summary.totalRemote}`,
      `Created: ${summary.created}`,
      `Updated: ${summary.updated}`,
      `Deprecated: ${summary.deprecated}`,
    ].join("\n") + "\n",
  );
}

main().catch((error) => {
  process.stderr.write(`rules:sync:notion failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
