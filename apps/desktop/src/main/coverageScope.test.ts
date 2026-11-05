import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { coverageExclude, coverageInclude } from "../../../../vitest.coverage.js";
import { filesUnder, relativeKey } from "./testing/tree.js";

/**
 * What `pnpm test:coverage` counts, held against what is on disk.
 *
 * The denominator is a list of globs in one file at the repository root,
 * and a list is only worth trusting if something notices when the tree
 * grows a case it does not name. Add `packages/engine/src/__fixtures__/`
 * tomorrow and it is covered; add `packages/engine/src/testing/` and it
 * is not — the exclusion names `src/main/testing/` and nothing else —
 * and the difference between those two is invisible in a diff. So this
 * derives the answer twice: once by matching the shipped globs, once
 * from the file names themselves, and insists the two agree over every
 * code file in every package that runs a suite.
 *
 * Deliberately repository-wide rather than desktop-only. The globs are
 * shared by all four packages, so a check that only looked at
 * `apps/desktop` would pass while `packages/ui` quietly counted a
 * fixture. It lives here because this is the package whose suite runs
 * against a real filesystem, and because every one of the awkward cases
 * — the module hosts, `testing/`, the two `__fixtures__` directories,
 * the one `.d.ts` — is under `apps/desktop/src`.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Files the coverage globs are written against: everything a package could execute. */
const CODE = /\.(?:ts|tsx|mjs)$/;

/**
 * The same judgement as `coverageExclude`, reached from the file name
 * rather than from the glob list — which is the whole point. Written as
 * the categories the story names, so that a case the globs miss shows up
 * here as a disagreement instead of being absorbed.
 */
function isProductionSource(key: string): boolean {
  if (!/\.tsx?$/.test(key)) return false; // a `.mjs` module host runs in another process
  if (key.endsWith(".d.ts")) return false; // declarations execute nothing
  if (/\.test\.tsx?$/.test(key)) return false;
  if (/(?:^|\/)__fixtures__\//.test(key)) return false;
  if (/(?:^|\/)testing\//.test(key)) return false;
  return true;
}

/**
 * Vitest matches these globs with picomatch against absolute paths;
 * `posix.matchesGlob` against the package-relative key is the same
 * question asked without a filesystem, and gives the same answer on
 * Windows as it does here.
 */
const matches = (key: string, globs: readonly string[]): boolean => globs.some((glob) => posix.matchesGlob(key, glob));

/** Every workspace package that runs a vitest suite, as `name -> absolute directory`. */
function packagesWithSuites(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(join(repoRoot, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(repoRoot, group, entry.name);
      if (existsSync(join(directory, "vitest.config.ts"))) found[`${group}/${entry.name}`] = directory;
    }
  }
  return found;
}

/** Every code file under a package's `src/`, keyed the way the globs are written. */
function codeFiles(packageDir: string): string[] {
  return filesUnder(join(packageDir, "src"), { skip: ["node_modules"] })
    .map((file) => relativeKey(packageDir, file))
    .filter((key) => CODE.test(key));
}

/**
 * Every non-empty directory under a package's `src/`, same keying.
 *
 * Derived from the file walk rather than walked again, so the two
 * cannot disagree. Directories matter on their own here because the two
 * `__fixtures__` directories hold only `.md` and `.json` today: the
 * exclusion that covers them is protecting a place, not a file, and a
 * check that only looked at files would call the rule dead.
 */
function srcDirectories(packageDir: string): string[] {
  const keys = new Set<string>();
  for (const file of filesUnder(join(packageDir, "src"), { skip: ["node_modules"] })) {
    const parts = relativeKey(packageDir, file).split("/");
    parts.pop();
    for (let depth = 1; depth <= parts.length; depth += 1) keys.add(parts.slice(0, depth).join("/"));
  }
  return [...keys].sort();
}

describe("the coverage denominator is the production source and nothing else", () => {
  const suites = packagesWithSuites();

  it("finds the packages it is supposed to be checking", () => {
    // Non-vacuous: an empty map would satisfy every loop below.
    expect(Object.keys(suites).sort()).toEqual(["apps/desktop", "packages/core", "packages/engine", "packages/ui"]);
  });

  it.each(Object.entries(suites))("%s counts every production file and only those", (_name, packageDir) => {
    const files = codeFiles(packageDir);
    expect(files.length).toBeGreaterThan(0);

    const counted = files.filter((key) => matches(key, coverageInclude) && !matches(key, coverageExclude));
    const shouldCount = files.filter(isProductionSource);

    // Named rather than compared as sets, so a failure says which file
    // and in which direction.
    expect(counted.filter((key) => !shouldCount.includes(key))).toEqual([]);
    expect(shouldCount.filter((key) => !counted.includes(key))).toEqual([]);
  });

  it("has a real instance of every file category it excludes, so no rule is theoretical", () => {
    const excluded = Object.values(suites)
      .flatMap(codeFiles)
      .filter((key) => !isProductionSource(key));

    // If one of these ever goes to zero the corresponding glob has
    // outlived its subject, and the list should lose it rather than keep
    // a rule that protects nothing.
    expect(excluded.filter((key) => /\.test\.tsx?$/.test(key)).length).toBeGreaterThan(100);
    expect(excluded.filter((key) => /(?:^|\/)testing\//.test(key)).length).toBeGreaterThan(0);
    expect(excluded.filter((key) => key.endsWith(".d.ts")).length).toBeGreaterThan(0);
    expect(excluded.filter((key) => key.endsWith(".mjs")).length).toBeGreaterThan(0);
  });

  it("names a real directory for each place it excludes, and knows of no second one", () => {
    const fixtures: string[] = [];
    const testing: string[] = [];
    for (const [name, packageDir] of Object.entries(suites)) {
      for (const key of srcDirectories(packageDir)) {
        const leaf = key.slice(key.lastIndexOf("/") + 1);
        if (leaf === "__fixtures__") {
          fixtures.push(`${name}/${key}`);
          // Only `.md` and `.json` live in these today. This is the
          // assertion that a fixture *module* added tomorrow — in this
          // directory or one created beside it — stays out of the
          // denominator without anybody remembering to say so.
          expect(matches(`${key}/fixture.ts`, coverageExclude), `${name}/${key}`).toBe(true);
        }
        if (leaf === "testing") testing.push(`${name}/${key}`);
      }
    }
    expect(fixtures.length).toBeGreaterThan(0);
    // `src/main/testing/**` names one directory by its path, so there
    // had better be exactly one. A second, in any package, would not be
    // covered — and widening the list is a decision to take by hand
    // rather than one a wildcard on the name makes silently for a
    // directory nobody meant as fixtures.
    expect(testing).toEqual(["apps/desktop/src/main/testing"]);
  });

  it("excludes every module host by name, and they are still where the exclusion says", () => {
    // The four are spawned as separate processes, so the instrumenter
    // in this one never sees them run. Named individually because the
    // count has already drifted once: the comment in testing.test.ts
    // still says two.
    const hosts = codeFiles(join(repoRoot, "apps", "desktop")).filter((key) => key.endsWith(".mjs"));
    expect(hosts).toEqual(["src/main/mcp/eoServer.mjs", "src/main/mcp/superviseStdioServer.mjs", "src/main/modules/moduleHost.mjs", "src/main/providers/codexSearchHookCommand.mjs"]);
    for (const host of hosts) expect(matches(host, coverageExclude)).toBe(true);
  });

  it("is not a tautology — the two judgements disagree when they should", () => {
    // Both halves of the check, exercised against paths that are not in
    // the tree. Without this, deleting a glob and its matching rule
    // together would leave the suite green.
    expect(matches("src/main/testing/git.ts", coverageExclude)).toBe(true);
    expect(matches("src/main/testingGrounds/real.ts", coverageExclude)).toBe(false);
    expect(isProductionSource("src/main/testingGrounds/real.ts")).toBe(true);
    // A `testing/` directory in another package: the name-based rule
    // calls it a fixture, the glob list does not know about it, and the
    // per-package check above is what turns that into a failure.
    expect(isProductionSource("src/testing/helper.ts")).toBe(false);
    expect(matches("src/testing/helper.ts", coverageExclude)).toBe(false);
    // A fixture directory anywhere, on the other hand, is already named.
    expect(matches("src/anything/__fixtures__/role.md", coverageExclude)).toBe(true);
    expect(isProductionSource("src/main/engine.ts")).toBe(true);
    expect(matches("src/main/engine.ts", coverageExclude)).toBe(false);
  });
});

describe("every package measures the same thing", () => {
  it("each vitest config spreads the shared coverage block rather than its own", () => {
    // Four copies of the list would be four numbers that are not
    // comparable with each other, and three of them would go stale.
    for (const packageDir of Object.values(packagesWithSuites())) {
      const config = readFileSync(join(packageDir, "vitest.config.ts"), "utf8");
      expect(config, `${packageDir}/vitest.config.ts`).toContain('from "../../vitest.coverage.js"');
      expect(config, `${packageDir}/vitest.config.ts`).toMatch(/^\s*coverage,$/m);
    }
  });

  it("adds no threshold, anywhere", () => {
    // The story is explicit: a figure chosen before the first
    // measurement is a figure chosen to pass. A run fails on a failing
    // test and on nothing else.
    const shared = readFileSync(join(repoRoot, "vitest.coverage.ts"), "utf8");
    expect(shared).not.toMatch(/^\s*thresholds\s*:/m);
    for (const packageDir of Object.values(packagesWithSuites())) {
      expect(readFileSync(join(packageDir, "vitest.config.ts"), "utf8"), packageDir).not.toMatch(/thresholds/);
    }
  });
});
