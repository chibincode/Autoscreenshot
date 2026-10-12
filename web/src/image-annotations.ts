export interface ImagePoint {
  x: number;
  y: number;
}

export interface ImageRegion extends ImagePoint {
  width: number;
  height: number;
}

export interface ImageAnnotation {
  id: string;
  region: ImageRegion;
  comment: string;
}

export function imagePoint(
  client: ImagePoint,
  bounds: ImageRegion,
  width: number,
  height: number,
): ImagePoint {
  return {
    x: Math.round(Math.max(0, Math.min(1, (client.x - bounds.x) / bounds.width)) * width),
    y: Math.round(Math.max(0, Math.min(1, (client.y - bounds.y) / bounds.height)) * height),
  };
}

export function regionBetween(start: ImagePoint, end: ImagePoint): ImageRegion {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function annotationExcerpt(region: ImageRegion, width: number, height: number): ImageRegion {
  const padding = Math.max(40, Math.round(width * 0.05));
  const x = Math.max(0, region.x - padding);
  const y = Math.max(0, region.y - padding);
  return {
    x,
    y,
    width: Math.min(width, region.x + region.width + padding) - x,
    height: Math.min(height, region.y + region.height + padding) - y,
  };
}

export function readAnnotationDraft(value: string | null, width: number, height: number): ImageAnnotation[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ImageAnnotation => {
      if (!item || typeof item.id !== "string" || typeof item.comment !== "string") return false;
      const r = item.region;
      return r && [r.x, r.y, r.width, r.height].every(Number.isInteger) &&
        r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 &&
        r.x + r.width <= width && r.y + r.height <= height;
    }).slice(0, 20);
  } catch {
    return [];
  }
}

export function annotationFeedbackText(context: string, annotations: ImageAnnotation[], width: number, height: number): string {
  return [
    context,
    `Image annotations (original image pixels, ${width} x ${height}):`,
    ...annotations.map(({ region: r, comment }, index) =>
      `\n${index + 1}. Region x=${r.x}, y=${r.y}, width=${r.width}, height=${r.height}\n${comment.trim()}`),
  ].join("\n");
}

function wrapCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const char of paragraph) {
      if (line && ctx.measureText(line + char).width > maxWidth) {
        lines.push(line);
        line = "";
      }
      line += char;
    }
    lines.push(line);
  }
  return lines;
}

// Export focused evidence instead of shrinking a long screenshot until its details are unreadable.
export async function renderAnnotationFeedback(
  image: HTMLImageElement,
  context: string,
  annotations: ImageAnnotation[],
): Promise<Blob> {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image export is unavailable.");
  const outputWidth = 1200;
  const margin = 36;
  ctx.font = "18px sans-serif";
  const imageContext = context.split("\n").filter((line) =>
    /^(job_id|job_mode|job_status|asset_id|asset_file|asset_source_url|asset_captured_at|route_path)=/.test(line));
  imageContext.push(`image_size=${width} x ${height} (original image pixels)`);
  const headerLines = wrapCanvasText(ctx, imageContext.join("\n"), outputWidth - margin * 2);
  const excerpts = annotations.map((annotation) => {
    const excerpt = annotationExcerpt(annotation.region, width, height);
    const scale = Math.min(1, (outputWidth - margin * 2) / excerpt.width, 900 / excerpt.height);
    ctx.font = "22px sans-serif";
    const commentLines = wrapCanvasText(ctx, annotation.comment.trim(), outputWidth - margin * 2);
    return { annotation, excerpt, scale, commentLines, imageHeight: Math.ceil(excerpt.height * scale) };
  });
  canvas.width = outputWidth;
  const outputHeight = 100 + headerLines.length * 25 + excerpts.reduce((total, item) =>
    total + 110 + item.imageHeight + item.commentLines.length * 30, 0);
  if (outputHeight > 30000) throw new Error("This feedback is too large. Copy fewer regions at a time.");
  canvas.height = outputHeight;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = "top";
  ctx.fillStyle = "#171b22";
  ctx.font = "bold 28px sans-serif";
  ctx.fillText("Screenshot feedback", margin, margin);
  ctx.font = "18px sans-serif";
  let y = 86;
  for (const line of headerLines) {
    ctx.fillText(line, margin, y);
    y += 25;
  }
  excerpts.forEach(({ annotation, excerpt, scale, commentLines, imageHeight }, index) => {
    y += 28;
    ctx.fillStyle = "#2563eb";
    ctx.font = "bold 22px sans-serif";
    ctx.fillText(`Region ${index + 1}`, margin, y);
    y += 34;
    const x = margin;
    ctx.drawImage(image, excerpt.x, excerpt.y, excerpt.width, excerpt.height,
      x, y, excerpt.width * scale, excerpt.height * scale);
    const r = annotation.region;
    const boxX = x + (r.x - excerpt.x) * scale;
    const boxY = y + (r.y - excerpt.y) * scale;
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 3;
    ctx.strokeRect(boxX, boxY, r.width * scale, r.height * scale);
    ctx.fillStyle = "#2563eb";
    ctx.fillRect(boxX, boxY, 30, 30);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 20px sans-serif";
    ctx.fillText(String(index + 1), boxX + 8, boxY + 4);
    y += imageHeight + 18;
    ctx.fillStyle = "#171b22";
    ctx.font = "22px sans-serif";
    for (const line of commentLines) {
      ctx.fillText(line, margin, y);
      y += 30;
    }
    y += 30;
  });
  return new Promise((resolve, reject) => canvas.toBlob((blob) =>
    blob ? resolve(blob) : reject(new Error("Could not export the feedback image.")), "image/png"));
}
