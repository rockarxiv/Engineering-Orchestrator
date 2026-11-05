/**
 * What a coverage run counts, written once for every package.
 *
 * Before this existed, "what is untested?" was answered by listing the
 * source files with no sibling `*.test.ts` — which named `mcpHost/render.ts`
 * and `ipc/handlers.ts` and could not say whether either is exercised
 * through somebody else's suite. Most such files are. How well was the
 * question nobody could answer, because the only signal was a filename.
 * `pnpm test:coverage` answers it with a number instead (EO-214).
 *
 * **There is no threshold here, and none in CI.** That is deliberate and
 * not an oversight. A figure chosen before the first measurement is a
 * figure chosen to pass, and a gate that fails a pull request for
 * touching an already-untested file is the kind of guard that gets
 * deleted within a week. Measure first; decide what to hold later, with
 * the report in hand. A coverage run therefore exits non-zero only when a
 * test fails — never on a percentage.
 *
 * Every package spreads the same block, so the four reports are
 * comparable with each other and there is one list to keep rather than
 * four that drift. `apps/desktop/src/main/coverageScope.test.ts` holds
 * that list against the files that actually exist, so a fixture
 * directory added tomorrow cannot quietly land in the denominator.
 */

/**
 * The denominator: TypeScript under a package's `src/`.
 *
 * Naming it at all is what makes the number honest. Without
 * `coverage.include`, V8 reports only the files a test happened to load,
 * so a module nobody imports scores 100% by being absent — which is the
 * precise failure this story exists to stop measuring around.
 */
export const coverageInclude: string[] = ["src/**/*.{ts,tsx}"];

/**
 * What is inside `src/` but is not the code EO ships.
 *
 * Each entry is a category rather than a path where it can be, because
 * the list has to survive a file moving. The one that cannot is
 * `src/main/testing/**`: those fixtures are a desktop-only arrangement,
 * and a wildcard on the directory name alone would silently adopt any
 * future one — the coverage-scope test insists the list is widened by
 * hand if a second such directory ever appears.
 */
export const coverageExclude: string[] = [
  // A test that measured itself would report the suite's coverage, not
  // the code's.
  "**/*.test.{ts,tsx}",
  // Fixtures. `testing/git.ts` and `testing/tree.ts` exist for tests and
  // nothing shipped imports them — held by testing/testing.test.ts.
  "src/main/testing/**",
  // Data that tests read: role manifests, attachment samples.
  "**/__fixtures__/**",
  // Build output. Unreachable through `coverageInclude` today; named so
  // that widening the include does not quietly start counting compiled
  // copies of files already counted as source.
  "**/dist/**",
  // Declarations describe types and execute nothing, so they can only
  // ever be 0% and drag the figure down for no defect.
  "**/*.d.ts",
  // The module hosts under `src/main` — `mcp/eoServer.mjs`,
  // `mcp/superviseStdioServer.mjs`, `modules/moduleHost.mjs`,
  // `providers/codexSearchHookCommand.mjs`. Each is spawned as a separate
  // process, so the instrumenter in this process never sees them run and
  // would report all four as dead code.
  "src/**/*.mjs",
];

/**
 * The `test.coverage` block, spread by every package's vitest config.
 *
 * `text` prints the summary the terminal shows; `lcovonly` writes
 * `coverage/lcov.info` for anything that reads one, and nothing else —
 * `lcov` would additionally regenerate a 1.8 MB HTML site per package on
 * every run, which nobody asked for. `coverage/` is already gitignored.
 */
export const coverage = {
  provider: "v8" as const,
  reporter: ["text" as const, "lcovonly" as const],
  reportsDirectory: "./coverage",
  include: coverageInclude,
  exclude: coverageExclude,
  // No `thresholds`. See the note at the top of this file.
};
