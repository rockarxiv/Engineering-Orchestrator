import { defineConfig } from "vitest/config";
import { coverage } from "../../vitest.coverage.js";

export default defineConfig({
  test: {
    coverage,
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
  },
});
