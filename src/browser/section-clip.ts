import type { SectionResult } from "../types.js";

export const FIXED_SECTION_CLIP_WIDTH = 1920;
export const FIXED_SECTION_CLIP_HEIGHT = 1080;
const HERO_TOP_ANCHOR_MAX_Y = 180;

export interface ClipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageSize {
  width: number;
  height: number;
}

export function buildFixedSectionClipFromBbox(
  bbox: SectionResult["bbox"],
  pageSize: PageSize,
): ClipRect {
  const targetWidth = Math.min(pageSize.width, FIXED_SECTION_CLIP_WIDTH);
  const targetHeight = Math.min(pageSize.height, FIXED_SECTION_CLIP_HEIGHT);
  const centerX = bbox.x + bbox.width / 2;
  const centerY = bbox.y + bbox.height / 2;
  const maxX = Math.max(0, pageSize.width - targetWidth);
  const maxY = Math.max(0, pageSize.height - targetHeight);
  const targetX = Math.min(maxX, Math.max(0, Math.round(centerX - targetWidth / 2)));
  const targetY = Math.min(maxY, Math.max(0, Math.round(centerY - targetHeight / 2)));

  return {
    x: targetX,
    y: targetY,
    width: targetWidth,
    height: targetHeight,
  };
}

export function buildFixedSectionClip(section: SectionResult, pageSize: PageSize): ClipRect {
  const clip = buildFixedSectionClipFromBbox(section.bbox, pageSize);

  // Only top-of-page heroes should snap to the first viewport to preserve nav/chrome.
  if (section.sectionType === "hero" && section.bbox.y <= HERO_TOP_ANCHOR_MAX_Y) {
    return {
      ...clip,
      y: 0,
    };
  }

  return clip;
}

export function calcClipIoU(a: ClipRect, b: ClipRect): number {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);

  if (right <= left || bottom <= top) {
    return 0;
  }

  const intersection = (right - left) * (bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  if (union <= 0) {
    return 0;
  }
  return intersection / union;
}
