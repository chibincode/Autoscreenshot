import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  root: __dirname,
  test: {
    include: [resolve(__dirname, "tests/**/*.test.ts")],
    environment: "node",
    globals: true,
    watch: false,
  },
});
