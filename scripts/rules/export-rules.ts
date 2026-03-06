#!/usr/bin/env tsx

import path from "node:path";
import { exportRulesRegistry } from "../../src/rules/exporter.js";

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const outputDir = path.join(projectRoot, "output", "rules");
  const result = await exportRulesRegistry({ projectRoot, outputDir });

  process.stdout.write(
    [
      `Rules exported: ${result.rows.length}`,
      `JSON: ${result.outputJsonPath}`,
      `CSV: ${result.outputCsvPath}`,
    ].join("\n") + "\n",
  );
}

main().catch((error) => {
  process.stderr.write(`rules:export failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
