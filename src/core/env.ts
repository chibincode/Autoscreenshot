import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function loadDotEnvFile(cwd: string): Promise<void> {
  const envPath = path.join(cwd, ".env");
  if (!existsSync(envPath)) {
    return;
  }
  const raw = await fs.readFile(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index < 0) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}
