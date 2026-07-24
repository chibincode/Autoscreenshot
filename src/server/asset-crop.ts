import { constants, existsSync } from "node:fs";
import { copyFile, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import sharp from "sharp";
import type { AssetRecord } from "../types.js";
import { getAssetImageMetadata, type AssetImageMetadata } from "./asset-thumbnails.js";

const MIN_RETAINED_HEIGHT = 64;
const CROP_MANIFEST_VERSION = 1;

export class AssetCropError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "AssetCropError";
  }
}

export type AssetCropOperation =
  | {
      type: "remove-bottom";
      keepHeight: number;
    }
  | {
      type: "remove-band";
      startY: number;
      endY: number;
    };

export interface AssetCropResult extends AssetImageMetadata {
  removedHeight: number;
  canRestoreOriginal: boolean;
}

interface RetainedSegment {
  startY: number;
  endY: number;
}

interface AssetCropManifest {
  version: typeof CROP_MANIFEST_VERSION;
  sourceWidth: number;
  sourceHeight: number;
  retainedSegments: RetainedSegment[];
}

export function getAssetOriginalBackupPath(filePath: string): string {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.autoscreenshot-original`);
}

export function getAssetCropManifestPath(filePath: string): string {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.autoscreenshot-crop.json`);
}

export function canRestoreAssetOriginal(filePath: string): boolean {
  return existsSync(getAssetOriginalBackupPath(filePath));
}

async function preserveOriginal(filePath: string): Promise<void> {
  try {
    await copyFile(filePath, getAssetOriginalBackupPath(filePath), constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

function buildTemporaryPath(filePath: string, suffix: string): string {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${nanoid(8)}.${suffix}`);
}

function getRetainedHeight(segments: RetainedSegment[]): number {
  return segments.reduce((total, segment) => total + segment.endY - segment.startY, 0);
}

function validateManifest(
  value: unknown,
  sourceMetadata: AssetImageMetadata,
): AssetCropManifest | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<AssetCropManifest>;
  if (
    candidate.version !== CROP_MANIFEST_VERSION ||
    candidate.sourceWidth !== sourceMetadata.width ||
    candidate.sourceHeight !== sourceMetadata.height ||
    !Array.isArray(candidate.retainedSegments) ||
    candidate.retainedSegments.length === 0
  ) {
    return null;
  }

  let previousEnd = 0;
  for (const segment of candidate.retainedSegments) {
    if (
      !segment ||
      !Number.isInteger(segment.startY) ||
      !Number.isInteger(segment.endY) ||
      segment.startY < previousEnd ||
      segment.endY <= segment.startY ||
      segment.endY > sourceMetadata.height
    ) {
      return null;
    }
    previousEnd = segment.endY;
  }
  return candidate as AssetCropManifest;
}

async function loadCropManifest(params: {
  filePath: string;
  currentMetadata: AssetImageMetadata;
  sourceMetadata: AssetImageMetadata;
}): Promise<AssetCropManifest> {
  const manifestPath = getAssetCropManifestPath(params.filePath);
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
      const manifest = validateManifest(parsed, params.sourceMetadata);
      if (manifest && getRetainedHeight(manifest.retainedSegments) === params.currentMetadata.height) {
        return manifest;
      }
    } catch {
      // Fall through to the legacy bottom-crop bootstrap below.
    }
  }

  if (
    params.currentMetadata.width !== params.sourceMetadata.width ||
    params.currentMetadata.height > params.sourceMetadata.height
  ) {
    throw new AssetCropError("The existing crop state is invalid. Restore the original and try again.", 409);
  }

  return {
    version: CROP_MANIFEST_VERSION,
    sourceWidth: params.sourceMetadata.width,
    sourceHeight: params.sourceMetadata.height,
    retainedSegments: [{ startY: 0, endY: params.currentMetadata.height }],
  };
}

function subtractVirtualRange(
  segments: RetainedSegment[],
  removeStartY: number,
  removeEndY: number,
): RetainedSegment[] {
  const next: RetainedSegment[] = [];
  let virtualY = 0;

  for (const segment of segments) {
    const segmentHeight = segment.endY - segment.startY;
    const virtualEndY = virtualY + segmentHeight;
    const overlapStartY = Math.max(removeStartY, virtualY);
    const overlapEndY = Math.min(removeEndY, virtualEndY);

    if (overlapStartY >= overlapEndY) {
      next.push({ ...segment });
    } else {
      const retainedBefore = overlapStartY - virtualY;
      const retainedAfter = virtualEndY - overlapEndY;
      if (retainedBefore > 0) {
        next.push({
          startY: segment.startY,
          endY: segment.startY + retainedBefore,
        });
      }
      if (retainedAfter > 0) {
        next.push({
          startY: segment.endY - retainedAfter,
          endY: segment.endY,
        });
      }
    }
    virtualY = virtualEndY;
  }

  return next;
}

async function renderRetainedSegments(params: {
  sourcePath: string;
  outputPath: string;
  width: number;
  segments: RetainedSegment[];
  quality: number;
}): Promise<void> {
  if (params.segments.length === 1) {
    const segment = params.segments[0];
    await sharp(params.sourcePath)
      .extract({
        left: 0,
        top: segment.startY,
        width: params.width,
        height: segment.endY - segment.startY,
      })
      .jpeg({
        quality: params.quality,
        mozjpeg: true,
      })
      .toFile(params.outputPath);
    return;
  }

  const segmentBuffers = await Promise.all(
    params.segments.map((segment) =>
      sharp(params.sourcePath)
        .extract({
          left: 0,
          top: segment.startY,
          width: params.width,
          height: segment.endY - segment.startY,
        })
        .png({ compressionLevel: 6, adaptiveFiltering: true })
        .toBuffer(),
    ),
  );
  let top = 0;
  const composites = segmentBuffers.map((input, index) => {
    const segment = params.segments[index];
    const descriptor = {
      input,
      left: 0,
      top,
    };
    top += segment.endY - segment.startY;
    return descriptor;
  });
  await sharp({
    create: {
      width: params.width,
      height: getRetainedHeight(params.segments),
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite(composites)
    .jpeg({
      quality: params.quality,
      mozjpeg: true,
    })
    .toFile(params.outputPath);
}

function normalizeRemovalRange(
  operation: AssetCropOperation,
  currentHeight: number,
): { startY: number; endY: number } {
  const startY =
    operation.type === "remove-bottom" ? Math.round(operation.keepHeight) : Math.round(operation.startY);
  const endY =
    operation.type === "remove-bottom" ? currentHeight : Math.round(operation.endY);

  if (!Number.isFinite(startY) || !Number.isFinite(endY)) {
    throw new AssetCropError("Crop coordinates must be finite numbers");
  }
  if (startY < 0 || endY > currentHeight || startY >= endY) {
    throw new AssetCropError("Crop coordinates must define a non-empty range inside the image");
  }
  if (currentHeight - (endY - startY) < MIN_RETAINED_HEIGHT) {
    throw new AssetCropError(`The crop must retain at least ${MIN_RETAINED_HEIGHT}px`);
  }
  return { startY, endY };
}

export async function cropAsset(params: {
  asset: Pick<AssetRecord, "filePath" | "quality">;
  operation: AssetCropOperation;
  expectedWidth?: number;
  expectedHeight?: number;
}): Promise<AssetCropResult> {
  const currentMetadata = await getAssetImageMetadata(params.asset);
  if (
    (Number.isFinite(params.expectedWidth) &&
      Math.round(params.expectedWidth as number) !== currentMetadata.width) ||
    (Number.isFinite(params.expectedHeight) &&
      Math.round(params.expectedHeight as number) !== currentMetadata.height)
  ) {
    throw new AssetCropError("Asset dimensions changed. Refresh the preview and try again.", 409);
  }

  const removal = normalizeRemovalRange(params.operation, currentMetadata.height);
  await preserveOriginal(params.asset.filePath);

  const sourcePath = getAssetOriginalBackupPath(params.asset.filePath);
  const sourceMetadata = await getAssetImageMetadata({ filePath: sourcePath });
  const currentManifest = await loadCropManifest({
    filePath: params.asset.filePath,
    currentMetadata,
    sourceMetadata,
  });
  const retainedSegments = subtractVirtualRange(
    currentManifest.retainedSegments,
    removal.startY,
    removal.endY,
  );
  if (retainedSegments.length === 0 || getRetainedHeight(retainedSegments) < MIN_RETAINED_HEIGHT) {
    throw new AssetCropError(`The crop must retain at least ${MIN_RETAINED_HEIGHT}px`);
  }

  const nextManifest: AssetCropManifest = {
    ...currentManifest,
    retainedSegments,
  };
  const manifestPath = getAssetCropManifestPath(params.asset.filePath);
  const temporaryImagePath = buildTemporaryPath(params.asset.filePath, "tmp.jpg");
  const temporaryManifestPath = buildTemporaryPath(manifestPath, "tmp.json");
  const previousManifest = existsSync(manifestPath) ? await readFile(manifestPath) : null;

  try {
    await renderRetainedSegments({
      sourcePath,
      outputPath: temporaryImagePath,
      width: sourceMetadata.width,
      segments: retainedSegments,
      quality: params.asset.quality,
    });
    await writeFile(temporaryManifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
    await rename(temporaryManifestPath, manifestPath);
    try {
      await rename(temporaryImagePath, params.asset.filePath);
    } catch (error) {
      if (previousManifest) {
        await writeFile(manifestPath, previousManifest);
      } else {
        await unlink(manifestPath).catch(() => undefined);
      }
      throw error;
    }
  } catch (error) {
    await unlink(temporaryImagePath).catch(() => undefined);
    await unlink(temporaryManifestPath).catch(() => undefined);
    throw error;
  }

  const updatedMetadata = await getAssetImageMetadata(params.asset);
  return {
    ...updatedMetadata,
    removedHeight: currentMetadata.height - updatedMetadata.height,
    canRestoreOriginal: true,
  };
}

export async function cropAssetBottom(params: {
  asset: Pick<AssetRecord, "filePath" | "quality">;
  keepHeight: number;
  expectedWidth?: number;
  expectedHeight?: number;
}): Promise<AssetCropResult> {
  return cropAsset({
    asset: params.asset,
    operation: {
      type: "remove-bottom",
      keepHeight: params.keepHeight,
    },
    expectedWidth: params.expectedWidth,
    expectedHeight: params.expectedHeight,
  });
}

export async function restoreAssetOriginal(
  asset: Pick<AssetRecord, "filePath">,
): Promise<AssetCropResult> {
  const backupPath = getAssetOriginalBackupPath(asset.filePath);
  if (!existsSync(backupPath)) {
    throw new AssetCropError("No original image is available to restore", 404);
  }

  const currentMetadata = await getAssetImageMetadata(asset);
  const temporaryPath = buildTemporaryPath(asset.filePath, "tmp.jpg");

  try {
    await copyFile(backupPath, temporaryPath);
    await rename(temporaryPath, asset.filePath);
    await unlink(backupPath);
    await unlink(getAssetCropManifestPath(asset.filePath)).catch(() => undefined);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  const updatedMetadata = await getAssetImageMetadata(asset);
  return {
    ...updatedMetadata,
    removedHeight: Math.max(0, currentMetadata.height - updatedMetadata.height),
    canRestoreOriginal: false,
  };
}
