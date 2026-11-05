import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainSrcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Production `.ts` files under `src/main`, which is every file that is
 * not a test and not a declaration. `.mjs` is left out: the two module
 * hosts under `src/main` are spawned as separate processes and import
 * nothing from here by construction.
 */
function productionFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...productionFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) files.push(full);
  }
  return files;
}

/** Every `.test.ts` under `src/main`. */
function testFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...testFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(full);
  }
  return files;
}

/**
 * Any import whose specifier reaches into `testing/`, however it is
 * spelled: `from "…"`, a dynamic `import("…")`, or a bare side-effect
 * `import "…"` with nothing bound.
 */
function importsTesting(source: string): boolean {
  return /(?:from\s+|import\s*\(?\s*)["'][^"']*\/testing\/[^"']*["']/.test(source);
}

/**
 * The fixtures under `testing/` are for tests. They ship nowhere, and
 * the way that stays true is that nothing shipped imports them — not a
 * bundler exclusion, which would be a second place to keep a list.
 */
describe("architectural invariant: nothing shipped imports from testing/", () => {
  it("no production file under src/main imports a testing/ module, in the real source tree", () => {
    const offenders = productionFiles(mainSrcRoot)
      .filter((file) => !file.startsWith(join(mainSrcRoot, "testing")))
      .filter((file) => importsTesting(readFileSync(file, "utf8")))
      .map((file) => relative(mainSrcRoot, file));
    expect(offenders).toEqual([]);
  });

  it("the check catches every import form and ignores a mention (proves it's not a tautology)", () => {
    expect(importsTesting('import { makeRepo } from "../testing/git.js";')).toBe(true);
    expect(importsTesting('const fixture = await import("./testing/tree.js");')).toBe(true);
    expect(importsTesting('import "../testing/git.js";')).toBe(true);
    expect(importsTesting("// the fixtures live under testing/, see testing/git.ts")).toBe(false);
    expect(importsTesting('import { git } from "../packs/developer/workspace/git.js";')).toBe(false);
  });

  it("every fixture module is reached by at least one test, so none is dead", () => {
    // The mirror of the invariant above. A fixture nobody imports is a
    // helper that will drift from the tests it was written for, and this
    // is the check that notices when the last caller of one is migrated
    // away.
    const testingDir = join(mainSrcRoot, "testing");
    const modules = readdirSync(testingDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    expect(modules.length).toBeGreaterThan(0);
    const tests = testFiles(mainSrcRoot).map((file) => readFileSync(file, "utf8"));
    for (const module of modules) {
      const stem = module.replace(/\.ts$/, "");
      const importers = tests.filter((source) => new RegExp(`/testing/${stem}\\.js["']`).test(source));
      expect(importers.length, `${module} has no test importing it`).toBeGreaterThan(0);
    }
  });
});
