import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { AssetRecord } from "../types.js";

const THUMBNAIL_CACHE_DIR = path.resolve(process.cwd(), "data/cache/asset-thumbnails");
const DEFAULT_THUMBNAIL_WIDTH = 360;
const DEFAULT_THUMBNAIL_QUALITY = 42;
const MIN_THUMBNAIL_WIDTH = 160;
const MAX_THUMBNAIL_WIDTH = 960;
const MIN_THUMBNAIL_QUALITY = 20;
const MAX_THUMBNAIL_QUALITY = 80;

const metadataCache = new Map<string, AssetImageMetadata>();
const thumbnailInflight = new Map<string, Promise<string>>();

export interface ThumbnailDimensions {
  thumbnailWidth: number;
  thumbnailHeight: number;
}

export interface ThumbnailResult extends ThumbnailDimensions {
  filePath: string;
}

export interface AssetImageMetadata {
  width: number;
  height: number;
  mtimeMs: number;
  cacheVersion: string;
}

function clampThumbnailWidth(value?: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_THUMBNAIL_WIDTH;
  }
  return Math.max(MIN_THUMBNAIL_WIDTH, Math.min(MAX_THUMBNAIL_WIDTH, Math.round(value as number)));
}

function clampThumbnailQuality(value?: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_THUMBNAIL_QUALITY;
  }
  return Math.max(MIN_THUMBNAIL_QUALITY, Math.min(MAX_THUMBNAIL_QUALITY, Math.round(value as number)));
}

async function ensureThumbnailCacheDir(): Promise<void> {
  await mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
}

export async function getAssetImageMetadata(
  asset: Pick<AssetRecord, "filePath">,
): Promise<AssetImageMetadata> {
  const fileStat = await stat(asset.filePath, { bigint: true });
  const cacheVersion = `${fileStat.mtimeNs}-${fileStat.ctimeNs}-${fileStat.size}`;
  const cacheKey = `${asset.filePath}:${cacheVersion}`;
  const cached = metadataCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const metadata = await sharp(asset.filePath).metadata();
  const width = metadata.width && metadata.width > 0 ? metadata.width : DEFAULT_THUMBNAIL_WIDTH;
  const height = metadata.height && metadata.height > 0 ? metadata.height : Math.round(width * 0.75);
  const next = {
    width,
    height,
    mtimeMs: Number(fileStat.mtimeNs) / 1_000_000,
    cacheVersion,
  };
  metadataCache.set(cacheKey, next);
  return next;
}

function resolveThumbnailDimensions(width: number, height: number, requestedWidth?: number): ThumbnailDimensions {
  const thumbnailWidth = Math.min(width, clampThumbnailWidth(requestedWidth));
  const thumbnailHeight = Math.max(1, Math.round((height / width) * thumbnailWidth));
  return {
    thumbnailWidth,
    thumbnailHeight,
  };
}

export function buildThumbnailUrl(
  assetId: number,
  width?: number,
  quality?: number,
  cacheVersion?: string | number,
): string {
  const params = new URLSearchParams({
    w: String(clampThumbnailWidth(width)),
    q: String(clampThumbnailQuality(quality)),
  });
  if (cacheVersion !== undefined) {
    params.set("v", String(cacheVersion));
  }
  return `/api/assets/${assetId}/thumbnail?${params.toString()}`;
}

export async function getThumbnailDimensions(
  asset: Pick<AssetRecord, "filePath">,
  requestedWidth?: number,
): Promise<ThumbnailDimensions> {
  const metadata = await getAssetImageMetadata(asset);
  return resolveThumbnailDimensions(metadata.width, metadata.height, requestedWidth);
}

export async function getThumbnailPath(
  asset: Pick<AssetRecord, "id" | "filePath">,
  options?: {
    width?: number;
    quality?: number;
  },
): Promise<ThumbnailResult> {
  const metadata = await getAssetImageMetadata(asset);
  const quality = clampThumbnailQuality(options?.quality);
  const { thumbnailWidth, thumbnailHeight } = resolveThumbnailDimensions(
    metadata.width,
    metadata.height,
    options?.width,
  );
  const cacheKey = `${asset.id}-${thumbnailWidth}-${quality}-${metadata.cacheVersion}.jpg`;
  const targetPath = path.join(THUMBNAIL_CACHE_DIR, cacheKey);

  if (!existsSync(targetPath)) {
    const inflight = thumbnailInflight.get(targetPath);
    if (inflight) {
      await inflight;
    } else {
      const renderPromise = (async () => {
        await ensureThumbnailCacheDir();
        await sharp(asset.filePath)
          .rotate()
          .resize({
            width: thumbnailWidth,
            withoutEnlargement: true,
          })
          .jpeg({
            quality,
            mozjpeg: true,
          })
          .toFile(targetPath);
        return targetPath;
      })();
      thumbnailInflight.set(targetPath, renderPromise);
      try {
        await renderPromise;
      } finally {
        thumbnailInflight.delete(targetPath);
      }
    }
  }

  return {
    filePath: targetPath,
    thumbnailWidth,
    thumbnailHeight,
  };
}
