import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * One invocation boundary for CodeWiki (EO-143), enforced the way
 * `db/architecturalInvariants.test.ts` enforces who may write
 * `items.stepId`.
 *
 * Tests are in scope here, and that is the difference from the
 * precedent. `architecturalInvariants.test.ts` scans production sources
 * only because a test that writes to a fake `items` table harms
 * nothing. Spawning is not like that: a test that reaches for the
 * binary itself is a second invocation site with all the same
 * argument-quoting to get wrong, and the first version of this feature
 * shipped exactly that — `binary/version.test.ts` ran the binary with
 * `execFileSync` while `run.ts` claimed to be the only place that
 * could. A scan that skipped tests was what let it through.
 *
 * This file is exempt from its own scan, necessarily: it contains the
 * patterns it looks for, so it matches every one of them. Nothing else
 * is exempt.
 */

const mainSrcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SELF = relative(mainSrcRoot, fileURLToPath(import.meta.url));

/** The one file allowed to turn a resolved path into a process. */
const RUNNER = join("repositoryIntelligence", "codewiki", "run.ts");
/** Where the path is worked out. Holding it is fine; running it is not. */
const RESOLVER = join("repositoryIntelligence", "binary", "resolve.ts");

/**
 * Knowing where the binary is, and being able to start one.
 *
 * Two patterns rather than one because either alone is innocent:
 * `binary/zip.ts` spawns PowerShell and has no idea what CodeWiki is,
 * and `binary/resolve.test.ts` knows exactly where the binary would be
 * and never runs anything. It is the pair that makes a file a second
 * invocation site.
 */
const KNOWS_THE_PATH = /\bresolveCodeWiki\b/;
const CAN_SPAWN = /node:child_process/;

function walkTsFiles(dir: string, includeTests: boolean): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkTsFiles(full, includeTests));
    else if (entry.isFile() && entry.name.endsWith(".ts") && (includeTests || !entry.name.endsWith(".test.ts"))) files.push(full);
  }
  return files;
}

/** Every file under `root` matching all of `patterns`, relative and sorted. */
function filesMatchingAll(root: string, patterns: RegExp[], options: { includeTests: boolean; exempt?: string[] } = { includeTests: true }): string[] {
  const exempt = new Set(options.exempt ?? []);
  return walkTsFiles(root, options.includeTests)
    .map((file) => relative(root, file))
    .filter((file) => !exempt.has(file))
    .filter((file) => {
      const source = readFileSync(join(root, file), "utf8");
      return patterns.every((pattern) => pattern.test(source));
    })
    .sort();
}

describe("architectural invariant: CodeWiki is invoked from exactly one place", () => {
  it("run.ts is the only file in the tree — tests included — that can both find the binary and spawn one", () => {
    // Asserted as an exact set rather than as an empty one. An empty
    // expectation passes just as happily when a pattern has stopped
    // matching anything at all, which is the failure mode an invariant
    // test must not have; requiring `run.ts` to be in the answer means
    // both patterns are proven live on every run.
    expect(filesMatchingAll(mainSrcRoot, [KNOWS_THE_PATH, CAN_SPAWN], { includeTests: true, exempt: [SELF] })).toEqual([RUNNER]);
  });

  it("only the resolver and the runner hold the binary's path in production sources", () => {
    expect(filesMatchingAll(mainSrcRoot, [KNOWS_THE_PATH], { includeTests: false, exempt: [SELF] })).toEqual([RESOLVER, RUNNER]);
  });

  it("nothing outside repositoryIntelligence/ names CodeWiki at all, tests included", () => {
    // The rule the pinned architecture note states: agents, steps and
    // the MCP host consume repository intelligence through a port, so
    // none of them has any business knowing what provides it. It also
    // catches a second spawn site in the place a scan of this
    // directory would miss.
    const everywhere = filesMatchingAll(mainSrcRoot, [/codewiki/i], { includeTests: true, exempt: [SELF] });
    expect(everywhere.filter((file) => !file.startsWith(`repositoryIntelligence${sep}`))).toEqual([]);
    // Non-vacuous for the same reason as above: the pattern does match
    // things, they are all in the one directory allowed to know.
    expect(everywhere.length).toBeGreaterThan(0);
  });

  it("catches a second invocation site, and leaves an innocent file alone (proves it is not a tautology)", () => {
    const temporary = mkdtempSync(join(tmpdir(), "eo-codewiki-invariant-"));
    try {
      const sneaky = 'import { spawn } from "node:child_process";\nimport { resolveCodeWiki } from "./resolve.js";\nspawn(resolveCodeWiki({ root }).path, ["index"]);';
      writeFileSync(join(temporary, "sneaky.ts"), sneaky);
      // Exactly the shape this review caught: a test, spawning it.
      writeFileSync(join(temporary, "sneaky.test.ts"), sneaky);
      // Spawns, but has no idea what CodeWiki is — `binary/zip.ts`.
      writeFileSync(join(temporary, "powershell.ts"), 'import { execFile } from "node:child_process";\nexecFile("powershell.exe", args);');
      // Knows where it is, and runs nothing — `binary/resolve.test.ts`.
      writeFileSync(join(temporary, "reader.ts"), 'import { resolveCodeWiki } from "./resolve.js";\nexpect(resolveCodeWiki({ root }).source).toBe("absent");');

      expect(filesMatchingAll(temporary, [KNOWS_THE_PATH, CAN_SPAWN], { includeTests: true })).toEqual(["sneaky.test.ts", "sneaky.ts"]);
      // And the test file is only in scope because this scan puts it
      // there: with tests skipped, the one that shipped goes unseen.
      expect(filesMatchingAll(temporary, [KNOWS_THE_PATH, CAN_SPAWN], { includeTests: false })).toEqual(["sneaky.ts"]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
