import { promises as fs } from "node:fs";
import path from "node:path";
import type { RunManifest } from "../types.js";

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export function timestampForFile(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export async function writeManifest(
  outputDir: string,
  manifest: RunManifest,
): Promise<string> {
  await ensureDir(outputDir);
  const manifestPath = path.join(outputDir, "manifest.json");
  await writeManifestToPath(manifestPath, manifest);
  return manifestPath;
}

export async function readManifest(manifestPath: string): Promise<RunManifest> {
  const raw = await fs.readFile(manifestPath, "utf8");
  return JSON.parse(raw) as RunManifest;
}

export async function writeManifestToPath(
  manifestPath: string,
  manifest: RunManifest,
): Promise<void> {
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}
