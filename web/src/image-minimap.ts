export interface MinimapMetrics {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  imageTop: number;
  imageHeight: number;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function minimapGeometry(metrics: MinimapMetrics, width: number, height: number) {
  if (width <= 0 || height <= 0 || metrics.imageHeight <= 0 || metrics.viewportHeight <= 0 ||
    metrics.scrollHeight <= metrics.viewportHeight + 2) return null;
  const mapHeight = Math.min(420, metrics.viewportHeight * 0.6, 104 * height / width);
  const mapWidth = Math.max(44, mapHeight * width / height);
  const start = clamp(metrics.scrollTop - metrics.imageTop, 0, metrics.imageHeight);
  const end = clamp(metrics.scrollTop + metrics.viewportHeight - metrics.imageTop, start, metrics.imageHeight);
  const indicatorHeight = Math.min(mapHeight, Math.max(8, (end - start) / metrics.imageHeight * mapHeight));
  return { width: mapWidth, height: mapHeight, indicatorHeight,
    indicatorTop: clamp(start / metrics.imageHeight * mapHeight, 0, mapHeight - indicatorHeight) };
}

export function minimapJump(y: number, mapHeight: number, metrics: MinimapMetrics): number {
  if (mapHeight <= 0) return metrics.scrollTop;
  return clamp(metrics.imageTop + clamp(y / mapHeight, 0, 1) * metrics.imageHeight - metrics.viewportHeight / 2,
    0, Math.max(0, metrics.scrollHeight - metrics.viewportHeight));
}

export function minimapDrag(deltaY: number, startScroll: number, mapHeight: number, metrics: MinimapMetrics): number {
  if (mapHeight <= 0) return startScroll;
  return clamp(startScroll + deltaY / mapHeight * metrics.imageHeight,
    0, Math.max(0, metrics.scrollHeight - metrics.viewportHeight));
}
