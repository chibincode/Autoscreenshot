import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('./public/', import.meta.url));
await mkdir(`${root}assets`, { recursive: true });
const read = async (path) => {
  const response = await fetch(`http://127.0.0.1:8787${path}`);
  if (!response.ok) throw new Error(`Read failed: ${response.status} ${path}`);
  return response.json();
};
const queue = await read('/api/jobs');
const ids = ['Eni3MzSOctoF', 'zFaj5c9h8i2O', 'B8gZZvYIxKk4', 'tg_ssBhzY3Ud'];
const jobs = [];
for (const id of ids) {
  const detail = await read(`/api/jobs/${id}`);
  const summary = queue.items.find((job) => job.id === id);
  const assets = [];
  for (const asset of detail.assets) {
    const route = detail.routes.find((route) => route.url === asset.sourceUrl);
    await sharp(asset.filePath).resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(`${root}assets/${asset.id}.jpg`);
    await sharp(asset.filePath).resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(`${root}assets/${asset.id}-thumb.jpg`);
    assets.push({ id: asset.id, fileName: asset.fileName, path: route?.path || '/', sourceUrl: asset.sourceUrl,
      width: asset.imageWidth, height: asset.imageHeight, folder: asset.eagleFolderPath || 'Page_Gerneral',
      src: `/assets/${asset.id}.jpg`, thumbnail: `/assets/${asset.id}-thumb.jpg`, capturedAt: asset.capturedAt });
  }
  jobs.push({ id, domain: new URL(summary.sourceUrl).hostname.replace(/^www\./, ''), status: detail.job.status,
    date: summary.createdAt, assets, logs: detail.logs.slice(-30).map((log) => ({ ts: log.ts, level: log.level, message: log.message })),
    failed: detail.routes.filter((route) => route.status === 'failed').length,
    skipped: detail.routes.filter((route) => route.status === 'skipped').length });
}
await writeFile(`${root}fixtures.json`, JSON.stringify(jobs));
await copyFile('/private/tmp/autoscreenshot-ui-review-desktop.jpg', `${root}current-workspace.jpg`);
await copyFile('/private/tmp/autoscreenshot-ui-review-preview.jpg', `${root}current-preview.jpg`);
console.log(`Prepared ${jobs.length} read-only jobs, ${jobs.reduce((sum, job) => sum + job.assets.length, 0)} images. No application writes.`);
