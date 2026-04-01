import type { JobExecutionOptions } from "../types.js";

export const DEFAULT_JOB_OPTIONS: JobExecutionOptions = {
  quality: 92,
  dpr: "auto",
  sectionScope: "classic",
  classicMaxSections: 10,
  mode: "single",
  maxRoutes: 12,
  outputDir: "./output",
};

export const DEFAULT_DESKTOP_VIEWPORT = {
  width: 1920,
  height: 1080,
} as const;

export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_PORT = 8787;
