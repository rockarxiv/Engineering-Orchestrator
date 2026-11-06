import { defineConfig } from "vitest/config";
import { coverage } from "../../vitest.coverage.js";

export default defineConfig({
  test: {
    coverage,
    include: ["src/**/*.test.ts"],
    // On a hosted Windows runner the first ICU call a worker makes — a
    // named-zone `Intl.DateTimeFormat`, a `toLocaleString` — can stall
    // for seconds while the whole machine is slow, and whichever test
    // makes it pays (EO-656). Measured there: 20–40ms on a usual run, and
    // 0.4s, 1.2–1.6s and 4.2–5.1s on the three of some 35 runs where it
    // stalled, the last past vitest's 5s default. Every call after the
    // first takes 0.2ms, so the time says nothing about the code. Only
    // Windows, so the default still catches a slow test elsewhere.
    testTimeout: process.platform === "win32" ? 20_000 : 5_000,
  },
});
