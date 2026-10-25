import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { JobsRepository } from "../src/server/db.js";
import { hasActiveMotion, MotionError, readMotionSummary, registerMotionRoutes, resolveMotionAnchor, validateMotionOptions, type MotionClient } from "../src/server/asset-motion.js";
import type { RunManifest } from "../src/types.js";

const disposers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "asset-motion-"));
  const repo = new JobsRepository(path.join(dir, "jobs.sqlite"));
  disposers.push(async () => fs.rm(dir, { recursive: true, force: true }));
  disposers.push(async () => repo.close());
  const assetFile = path.join(dir, "feature.jpg");
  await fs.writeFile(assetFile, "screenshot");
  const manifest = { runId: "motion-job", instruction: "test", task: { url: "https://inflight.co/", viewport: { width: 1920, height: 1080 } },
    assets: [{ kind: "section", sectionType: "feature", label: "feature", fileName: "feature.jpg", filePath: assetFile, sourceUrl: "https://inflight.co/", quality: 92, dpr: 2, capturedAt: new Date().toISOString(), import: { ok: false, status: "pending_confirmation", selected: true } }],
    sectionDebug: { selectedCandidates: [{ sectionType: "feature", selector: "#features", bbox: { x: 0, y: 1700, width: 1920, height: 5300 } }, { sectionType: "feature", selector: "#second", bbox: { x: 0, y: 900, width: 1920, height: 500 } }] },
  } as unknown as RunManifest;
  const manifestPath = path.join(dir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  repo.createJob({ id: "motion-job", instruction: "test", options: { mode: "single", outputDir: dir } as never });
  repo.setJobResult({ jobId: "motion-job", status: "awaiting_confirmation", outputDir: dir, manifestPath });
  repo.replaceAssets("motion-job", manifest);
  const asset = repo.getJobDetail("motion-job")!.assets[0];
  const output = path.join(dir, "output", "run");
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "export.mp4"), "0123456789");
  await fs.writeFile(path.join(output, "frame-0000.jpg"), "poster");
  let status = "running", recordCalls = 0;
  const calls: string[][] = [];
  const client: MotionClient = { projectDir: dir, async call(args) {
    calls.push(args);
    if (args[0] === "record") recordCalls++;
    if (args[0] === "cancel") status = "cancelled";
    return { id: "remote-task", status, stage: "capturing", progress: .5,
      result: status === "completed" ? { filePath: path.join(output, "export.mp4"), duration: 10, width: 1920, height: 1080, verified: true, warnings: [] } : null };
  } };
  const app = Fastify(); registerMotionRoutes(app, repo, client);
  disposers.push(() => app.close());
  const url = `/api/assets/${asset.id}/motion`;
  return { app, repo, asset, url, manifest, calls, client, done: () => { status = "completed"; }, running: () => { status = "running"; }, recordCalls: () => recordCalls };
}
const settings = { mode: "scroll", duration: 10, selector: "#features", from: 0, to: 100 };
describe("asset motion", () => {
  it("validates bounded settings and retains detector ordering for legacy nested sections", async () => {
    const f = await fixture();
    expect(resolveMotionAnchor(f.asset, f.manifest)?.selector).toBe("#features");
    expect(resolveMotionAnchor({ ...f.asset, label: "feature_2" }, f.manifest)?.selector).toBe("#second");
    for (const body of [{ ...settings, duration: NaN }, { ...settings, duration: 31 }, { ...settings, selector: "" }, { ...settings, from: 99.5 }]) expect(() => validateMotionOptions(body)).toThrow();
    expect(validateMotionOptions({ ...settings, mode: "manual", selector: "" }).mode).toBe("manual");
  });
  it("deduplicates concurrent starts, persists the task, copies verified media and supports ranges", async () => {
    const f = await fixture();
    const responses = await Promise.all([1, 2].map(() => f.app.inject({ method: "POST", url: f.url, payload: settings })));
    expect(responses.map(r => r.statusCode).sort()).toEqual([202, 409]);
    expect(f.recordCalls()).toBe(1);
    expect(await hasActiveMotion([f.asset])).toBe(true);
    expect(f.calls.find(c => c[0] === "record")).toContain("--target-json");
    f.done();
    const result = (await f.app.inject({ method: "GET", url: f.url })).json().motion;
    expect(result.status).toBe("completed"); expect(await hasActiveMotion([f.asset])).toBe(false);
    expect(await fs.readFile(f.asset.filePath, "utf8")).toBe("screenshot");
    expect((await readMotionSummary(f.asset)).videoUrl).toBe(result.videoUrl);
    const media = await f.app.inject({ method: "GET", url: result.videoUrl, headers: { range: "bytes=2-5" } });
    expect(media.statusCode).toBe(206); expect(media.body).toBe("2345"); expect(media.headers["content-range"]).toBe("bytes 2-5/10");
    expect((await f.app.inject({ method: "GET", url: result.videoUrl, headers: { range: "bytes=99-" } })).statusCode).toBe(416);
    expect((await f.app.inject({ method: "GET", url: result.videoUrl.replace(/media\/[^/]+/, "media/unrelated") })).statusCode).toBe(404);
    f.running();
    await f.app.inject({ method: "POST", url: f.url, payload: settings });
    expect((await readMotionSummary(f.asset)).videoUrl).toBe(result.videoUrl);
  });
  it("resumes status after server restart and cancels independently of screenshot import state", async () => {
    const f = await fixture();
    await f.app.inject({ method: "POST", url: f.url, payload: settings });
    await f.app.close();
    const restarted = Fastify(); registerMotionRoutes(restarted, f.repo, f.client); disposers.push(() => restarted.close());
    expect((await restarted.inject({ method: "GET", url: f.url })).json().motion.remoteId).toBe("remote-task");
    expect((await restarted.inject({ method: "POST", url: f.url + "/cancel" })).json().motion.status).toBe("cancelled");
    expect(await hasActiveMotion([f.asset])).toBe(false);
    expect((await restarted.inject({ method: "GET", url: "/api/assets/9999/motion" })).statusCode).toBe(404);
  });
  it("reports unavailable services without modifying the screenshot or creating a stuck task", async () => {
    const f = await fixture(); f.client.call = async () => { throw new MotionError("service offline", 503); };
    const response = await f.app.inject({ method: "POST", url: f.url, payload: settings });
    expect(response.statusCode).toBe(503); expect(response.json().error).toBe("service offline");
    expect(await hasActiveMotion([f.asset])).toBe(false);
  });
  it("treats capture failures as terminal and keeps prior successful media after failed retries", async () => {
    const f = await fixture();
    await f.app.inject({ method: "POST", url: f.url, payload: settings }); f.done();
    const previous = (await f.app.inject({ method: "GET", url: f.url })).json().motion.videoUrl;
    f.client.call = async () => ({ id: "failed-task", status: "failed", stage: "failed", progress: null, error: { message: "Section target matched 0 elements." } });
    const response = await f.app.inject({ method: "POST", url: f.url, payload: settings });
    expect(response.statusCode).toBe(202); expect(response.json().motion.status).toBe("failed");
    expect(response.json().motion.videoUrl).toBe(previous);
    expect(await hasActiveMotion([f.asset])).toBe(false);
  });
  it("rejects unverified and out-of-project output paths without exposing media", async () => {
    const f = await fixture();
    f.client.call = async () => ({ id: "invalid-output", status: "completed", stage: "completed", progress: 1,
      result: { filePath: f.asset.filePath, verified: true, width: 1920, height: 1080, duration: 10, warnings: [] } });
    const response = await f.app.inject({ method: "POST", url: f.url, payload: settings });
    expect(response.statusCode).toBe(502); expect(response.json().error).toContain("Invalid Motion Capture result path");
    expect((await readMotionSummary(f.asset)).videoUrl).toBeUndefined();
    expect(await hasActiveMotion([f.asset])).toBe(true);
    expect((await f.app.inject({ method: "POST", url: f.url + "/cancel" })).json().motion.status).toBe("cancelled");
  });
  it("isolates damaged motion history from screenshot responses and server startup", async () => {
    const f = await fixture();
    const folder = path.join(path.dirname(f.asset.filePath), ".motion", String(f.asset.id));
    await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, "state.json"), "broken history");
    expect((await readMotionSummary(f.asset)).status).toBe("unavailable");
    expect((await f.app.inject({ method: "GET", url: f.url })).statusCode).toBe(409);
    expect(await fs.readFile(f.asset.filePath, "utf8")).toBe("screenshot");
  });
});
