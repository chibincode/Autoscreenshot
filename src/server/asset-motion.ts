import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import type { AssetRecord, MotionAnchor, RunManifest } from "../types.js";
import type { JobsRepository } from "./db.js";
import { readManifest } from "../utils/manifest.js";

const run = promisify(execFile);
const active = new Set(["submitting", "queued", "running"]);
const fileLocks = new Map<string, Promise<unknown>>();
export async function withMotionFiles<T>(jobId: string, action: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(jobId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  fileLocks.set(jobId, next);
  try { return await next; } finally { if (fileLocks.get(jobId) === next) fileLocks.delete(jobId); }
}
export interface MotionOptions {
  duration: number;
  mode: "scroll" | "hold" | "manual";
  selector: string;
  from: number;
  to: number;
}
interface RemoteCapture {
  id: string; status: string; stage: string; progress: number | null;
  error?: { message: string } | null;
  result?: { filePath: string; duration: number; width: number; height: number; verified: boolean; warnings: string[] } | null;
}
export interface MotionClient {
  projectDir: string;
  call(args: string[]): Promise<RemoteCapture>;
}
interface Recording {
  id: string; remoteId?: string; status: string; stage: string; progress: number | null;
  options: MotionOptions; createdAt: string; error?: string;
  result?: { duration: number; width: number; height: number; warnings: string[] };
}
interface State { recordings: Recording[] }
export class MotionError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}
export function createMotionClient(): MotionClient {
  const projectDir = path.resolve(process.env.MOTION_CAPTURE_PROJECT_DIR ?? path.join(process.cwd(), "../website-motion-capture"));
  return {
    projectDir,
    async call(args) {
      let stdout = "";
      try {
        ({ stdout } = await run(process.env.MOTION_CAPTURE_NODE ?? process.execPath, [path.join(projectDir, "motion.cjs"), ...args], {
          cwd: projectDir, timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
        }));
      } catch (error) {
        stdout = typeof (error as { stdout?: unknown }).stdout === "string" ? (error as { stdout: string }).stdout : "";
        if (!stdout) throw new MotionError("Motion Capture is unavailable. Check its local installation and service.", 503);
      }
      let payload;
      try { payload = JSON.parse(stdout); } catch { throw new MotionError("Motion Capture returned an invalid response.", 502); }
      if (payload.error && !payload.id) throw new MotionError(payload.error.message, 503);
      return payload;
    },
  };
}
const directory = (asset: AssetRecord) => path.join(path.dirname(asset.filePath), ".motion", String(asset.id));
async function load(asset: AssetRecord): Promise<State> {
  try {
    const state = JSON.parse(await fs.readFile(path.join(directory(asset), "state.json"), "utf8"));
    if (!Array.isArray(state.recordings) || state.recordings.some((record: Recording) => !/^[a-f\d-]{36}$/.test(record.id))) throw Error("Invalid history");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { recordings: [] };
    throw new MotionError("Motion history could not be read. Original media has not been changed.", 409);
  }
}
async function save(asset: AssetRecord, state: State) {
  const dir = directory(asset);
  await fs.mkdir(dir, { recursive: true });
  const temporary = path.join(dir, `state-${randomUUID()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(state, null, 2));
  await fs.rename(temporary, path.join(dir, "state.json"));
}
export function resolveMotionAnchor(asset: Pick<AssetRecord, "fileName" | "kind" | "label" | "sectionType">, manifest: RunManifest | null): MotionAnchor | null {
  const original = manifest?.assets.find(item => item.fileName === asset.fileName);
  if (original?.motionAnchor) return original.motionAnchor;
  if (asset.kind !== "section" || !manifest?.sectionDebug) return null;
  // Legacy labels follow detector order, not vertical position (nested candidates can overlap).
  const candidates = manifest.sectionDebug.selectedCandidates.filter(item => item.sectionType === asset.sectionType);
  const suffix = asset.label.match(/_(\d+)$/);
  const candidate = candidates[(suffix ? Number(suffix[1]) : 1) - 1];
  return candidate ? { selector: candidate.selector, bbox: candidate.bbox, viewport: manifest.task.viewport } : null;
}
export function validateMotionOptions(input: unknown): MotionOptions {
  const value = input as Partial<MotionOptions> | null;
  if (!value || typeof value !== "object" || !["scroll", "hold", "manual"].includes(value.mode ?? "")) throw new MotionError("Choose a recording mode.");
  if (typeof value.duration !== "number" || value.duration < 5 || value.duration > 30 || !Number.isFinite(value.duration) || value.duration * 2 % 1) throw new MotionError("Duration must be 5-30 seconds in half-second steps.");
  const from = value.from ?? 0, to = value.to ?? 100;
  if (![from, to].every(n => typeof n === "number" && Number.isFinite(n)) || from < 0 || to > 100 || to - from < 1) throw new MotionError("Set a valid 0-100% range of at least 1%.");
  const selector = typeof value.selector === "string" ? value.selector.trim() : "";
  if (value.mode !== "manual" && (!selector || selector.length > 2000)) throw new MotionError("A section selector is required. Alternatively, choose a manual range.");
  return { duration: value.duration, mode: value.mode as MotionOptions["mode"], from, to, selector };
}
function summary(asset: AssetRecord, state: State) {
  const current = state.recordings.at(-1);
  const ready = [...state.recordings].reverse().find(record => record.result);
  return { ...current, videoUrl: ready ? `/api/assets/${asset.id}/motion/media/${ready.id}/video` : undefined,
    posterUrl: ready ? `/api/assets/${asset.id}/motion/media/${ready.id}/poster` : undefined,
    result: ready?.result, historyCount: state.recordings.length };
}
export async function readMotionSummary(asset: AssetRecord) {
  try { return summary(asset, await load(asset)); }
  catch { return { ...summary(asset, { recordings: [] }), status: "unavailable", error: "Motion history could not be read." }; }
}
export async function hasActiveMotion(assets: AssetRecord[]) {
  for (const asset of assets) if (active.has((await load(asset)).recordings.at(-1)?.status ?? "")) return true;
  return false;
}

export function registerMotionRoutes(app: FastifyInstance, repo: JobsRepository, client = createMotionClient(), onChanged: (jobId: string) => void = () => {}) {
  const locks = new Map<number, Promise<unknown>>();
  const watched = new Map<number, AssetRecord>();
  async function exclusive<T>(assetId: number, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(assetId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    locks.set(assetId, next);
    try { return await next; } finally { if (locks.get(assetId) === next) locks.delete(assetId); }
  }
  async function context(assetId: string) {
    const asset = repo.getAssetById(Number(assetId));
    const job = asset && repo.getJob(asset.jobId);
    if (!asset || !job || job.cleanedAt) throw new MotionError("Screenshot files are no longer available.", 404);
    if (["queued", "running"].includes(job.status)) throw new MotionError("Wait for the screenshot job to finish.", 409);
    const manifest = job.manifestPath ? await readManifest(job.manifestPath).catch(() => null) : null;
    return { asset, job, anchor: resolveMotionAnchor(asset, manifest) };
  }
  async function reconcile(asset: AssetRecord, state: State) {
    const record = state.recordings.at(-1);
    if (!record || !active.has(record.status)) { watched.delete(asset.id); return; }
    const previousStatus = record.status;
    const args = record.remoteId ? ["status", record.remoteId] : ["record", "--url", asset.sourceUrl!, "--request-id", record.id,
      "--duration", String(record.options.duration), "--fps", "60", "--width", "1920", "--viewport-height", "1080", "--quality", "high",
      "--from", String(record.options.from), "--to", String(record.options.to),
      ...(record.options.mode !== "manual" ? ["--target-json", JSON.stringify({ selector: record.options.selector, mode: record.options.mode })] : [])];
    const remote = await client.call(args);
    record.remoteId = remote.id;
    record.status = remote.status === "completed" ? previousStatus : remote.status;
    record.stage = remote.stage; record.progress = remote.progress;
    record.error = remote.error?.message.slice(0, 2000);
    if (remote.status === "completed") {
      await save(asset, state);
      if (!remote.result?.verified) throw new MotionError("The recording did not pass video verification.", 502);
      const root = await fs.realpath(path.join(client.projectDir, "output"));
      const source = await fs.realpath(remote.result.filePath);
      if (!source.startsWith(root + path.sep) || path.extname(source) !== ".mp4") throw new MotionError("Invalid Motion Capture result path.", 502);
      const destination = path.join(directory(asset), record.id);
      await fs.mkdir(destination, { recursive: true });
      for (const [from, to] of [[source, "video.mp4"], [path.join(path.dirname(source), "frame-0000.jpg"), "poster.jpg"]]) {
        const resolved = await fs.realpath(from);
        if (!resolved.startsWith(root + path.sep)) throw new MotionError("Invalid media path.", 502);
        await fs.copyFile(resolved, path.join(destination, to + ".tmp"));
        await fs.rename(path.join(destination, to + ".tmp"), path.join(destination, to));
      }
      record.result = { duration: remote.result.duration, width: remote.result.width, height: remote.result.height, warnings: remote.result.warnings };
      record.status = "completed";
      repo.addLog(asset.jobId, "info", `Motion recording completed for asset #${asset.id} (${record.options.duration}s)`);
    }
    await save(asset, state);
    if (!active.has(record.status)) watched.delete(asset.id);
    if (previousStatus !== record.status) onChanged(asset.jobId);
  }
  app.addHook("onReady", async () => {
    for (const archivedOnly of [false, true]) {
      for (let page = 1; ; page++) {
        const jobs = repo.listJobs({ page, pageSize: 100, archivedOnly });
        for (const job of jobs.items.filter(job => !job.cleanedAt)) {
          for (const asset of repo.getJobDetail(job.id)?.assets ?? []) {
            try {
              if (active.has((await load(asset)).recordings.at(-1)?.status ?? "")) watched.set(asset.id, asset);
            } catch (error) { app.log.warn({ err: error, assetId: asset.id }, "Motion recovery skipped unreadable history"); }
          }
        }
        if (page * 100 >= jobs.total) break;
      }
    }
  });
  const timer = setInterval(() => {
    for (const asset of watched.values()) {
      if (locks.has(asset.id)) continue;
      void exclusive(asset.id, async () => {
        const state = await load(asset);
        try { await reconcile(asset, state); }
        catch (error) {
          const record = state.recordings.at(-1);
          if (record) {
            record.error = error instanceof Error ? error.message.slice(0, 2000) : "Motion Capture connection failed.";
            // Keep transient errors resumable; terminal capture failures arrive as task statuses.
            await save(asset, state);
          }
        }
      }).catch(error => app.log.warn({ err: error, assetId: asset.id }, "Motion status could not be saved"));
    }
  }, 4000);
  timer.unref();
  app.addHook("onClose", async () => { clearInterval(timer); await Promise.allSettled(locks.values()); });
  const fail = (reply: { code(n: number): unknown }, error: unknown) => {
    reply.code(error instanceof MotionError ? error.statusCode : 500);
    return { error: error instanceof Error ? error.message : "Motion Capture request failed." };
  };
  app.get<{ Params: { assetId: string } }>("/api/assets/:assetId/motion", async (request, reply) => {
    try {
      const { asset, anchor } = await context(request.params.assetId);
      return await exclusive(asset.id, async () => {
        const state = await load(asset);
        if (active.has(state.recordings.at(-1)?.status ?? "")) { watched.set(asset.id, asset); await reconcile(asset, state); }
        return { anchor, motion: summary(asset, state) };
      });
    } catch (error) { return fail(reply, error); }
  });
  app.post<{ Params: { assetId: string }; Body: unknown }>("/api/assets/:assetId/motion", async (request, reply) => {
    try {
      const { asset } = await context(request.params.assetId);
      if (!asset.sourceUrl) throw new MotionError("This screenshot has no source URL.");
      const options = validateMotionOptions(request.body);
      return await exclusive(asset.id, () => withMotionFiles(asset.jobId, async () => {
        if (!repo.getAssetById(asset.id)) throw new MotionError("This page was removed from the task.", 409);
        const state = await load(asset);
        if (active.has(state.recordings.at(-1)?.status ?? "")) throw new MotionError("A recording is already in progress for this screenshot.", 409);
        await client.call(["start"]);
        if (repo.getJob(asset.jobId)?.cleanedAt) throw new MotionError("Screenshot files were cleaned while connecting to Motion Capture.", 409);
        state.recordings.push({ id: randomUUID(), status: "submitting", stage: "loading", progress: null, options, createdAt: new Date().toISOString() });
        await save(asset, state);
        watched.set(asset.id, asset);
        await reconcile(asset, state);
        repo.addLog(asset.jobId, "info", `Motion recording requested for asset #${asset.id}`);
        reply.code(202);
        return { motion: summary(asset, state) };
      }));
    } catch (error) { return fail(reply, error); }
  });
  app.post<{ Params: { assetId: string } }>("/api/assets/:assetId/motion/cancel", async (request, reply) => {
    try {
      const { asset } = await context(request.params.assetId);
      return await exclusive(asset.id, async () => {
        const state = await load(asset), record = state.recordings.at(-1);
        if (record && active.has(record.status)) {
          if (!record.remoteId) await reconcile(asset, state);
          const remote = await client.call(["cancel", record.remoteId!]);
          record.status = remote.status === "completed" ? "cancelled" : remote.status; record.stage = record.status;
          await save(asset, state); watched.delete(asset.id);
          onChanged(asset.jobId);
        }
        return { motion: summary(asset, state) };
      });
    } catch (error) { return fail(reply, error); }
  });
  app.get<{ Params: { assetId: string; recordId: string; kind: string } }>("/api/assets/:assetId/motion/media/:recordId/:kind", async (request, reply) => {
    try {
      const asset = repo.getAssetById(Number(request.params.assetId));
      if (!asset) throw new MotionError("Asset not found.", 404);
      const record = (await load(asset)).recordings.find(item => item.id === request.params.recordId && item.result);
      if (!record || !["video", "poster"].includes(request.params.kind)) throw new MotionError("Media not found.", 404);
      const video = request.params.kind === "video";
      const file = path.join(directory(asset), record.id, video ? "video.mp4" : "poster.jpg");
      const { size } = await fs.stat(file);
      reply.type(video ? "video/mp4" : "image/jpeg").header("Accept-Ranges", "bytes").header("Cache-Control", "private, max-age=31536000, immutable");
      const range = request.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        let start = match?.[1] ? Number(match[1]) : 0;
        let end = match?.[2] ? Number(match[2]) : size - 1;
        if (match && !match[1] && match[2]) { start = Math.max(0, size - Number(match[2])); end = size - 1; }
        if (!match || (!match[1] && !match[2]) || start >= size || end < start || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return reply.code(416).header("Content-Range", `bytes */${size}`).send();
        end = Math.min(end, size - 1);
        reply.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`).header("Content-Length", end - start + 1);
        return reply.send(createReadStream(file, { start, end }));
      }
      reply.header("Content-Length", size);
      return reply.send(createReadStream(file));
    } catch (error) { return fail(reply, error); }
  });
}
