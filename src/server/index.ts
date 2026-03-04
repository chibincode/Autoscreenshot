import { DEFAULT_HOST, DEFAULT_PORT } from "../core/defaults.js";
import { loadDotEnvFile } from "../core/env.js";
import { buildServer } from "./app.js";

async function main(): Promise<void> {
  await loadDotEnvFile(process.cwd());
  const host = process.env.HOST ?? DEFAULT_HOST;
  const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;

  const app = await buildServer();
  await app.listen({ host, port });
  process.stdout.write(`Autoscreenshot Web App running at http://${host}:${port}\n`);
}

main().catch((error) => {
  process.stderr.write(`Failed to start server: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
