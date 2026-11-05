import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { coverage } from "../../vitest.coverage.js";

export default defineConfig({
  test: {
    // Above `projects` rather than inside one: coverage is a root-only
    // option, and keeping it here is what makes the desktop report a
    // single merged figure over `main` and `renderer` rather than two
    // that neither add up nor compare.
    coverage,
    projects: [
      {
        plugins: [react()],
        test: {
          name: "renderer",
          environment: "jsdom",
          // Vitest's 5s default assumes a developer's machine. The release
          // runs this suite on a hosted Windows runner, where a test that
          // takes 400ms here can take ten times that — and a timeout there
          // says nothing about the code, only about the hardware.
          testTimeout: 20_000,
          // .ts as well as .tsx: a pure-logic test beside a component
          // (grouping.test.ts) matched neither project and ran nowhere,
          // silently.
          include: ["src/renderer/src/**/*.test.{ts,tsx}"],
          setupFiles: ["./src/renderer/src/setupTests.ts"],
        },
      },
      {
        test: {
          name: "main",
          environment: "node",
          // Same reason as the renderer project above, and more of it on
          // Windows: ending a real agent process there reads the process
          // table through a PowerShell start (`processTree.ts`), which
          // takes seconds on a hosted runner while the other slices'
          // workers are busy, and a test can end several turns.
          testTimeout: process.platform === "win32" ? 60_000 : 20_000,
          hookTimeout: process.platform === "win32" ? 30_000 : 10_000,
          include: ["src/main/**/*.test.ts"],
        },
      },
    ],
  },
});
