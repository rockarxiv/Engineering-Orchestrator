import { readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fallbackRepositoryIntelligenceRoot } from "./install.js";

/**
 * Where the fetched index binary is cached, and how many places get to
 * decide that (EO-157).
 *
 * There were three: `install.ts`'s `repositoryIntelligenceRoot`, which
 * is the one production resolves, and two hand-written copies of a
 * `~/.eo/repositoryIntelligence` fallback — one in `engine.ts`, one in
 * `supervisor/builtins.ts`. They agreed only by luck: production passes
 * a root explicitly and the builtins' default is never reached, so
 * nothing shipped could tell them apart. That is the shape of defect
 * that stays invisible until somebody edits one of the three, and the
 * comment in `engine.ts` explains exactly why it must not happen — a
 * second copy pointed at a different root would have the step that
 * builds an index and the dispatch that hands one to an agent disagree
 * about which index exists.
 *
 * Enforced by scanning the sources rather than by asserting on
 * behaviour, for the reason `codewiki/importSites.test.ts` gives about
 * spawn sites: what is wrong with a fourth copy is that it exists, and
 * no amount of driving the engine can observe a default nothing reaches.
 */

const mainSrcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** This file, exempt from its own scan: the liveness checks below are the patterns. */
const SELF = relative(mainSrcRoot, fileURLToPath(import.meta.url));

/** The one production file allowed to say where the cache lives. */
const DEFINITION = join("repositoryIntelligence", "binary", "install.ts");

/**
 * A cache path built out of a literal naming this subsystem's
 * directory.
 *
 * A literal rather than any mention, because joining something onto a
 * root somebody handed you — `join(root, "codewiki@0.2.1")` — is
 * ordinary work. Writing the directory's own name into a path is how a
 * second definition of the root comes into existence.
 */
const SPELLS_A_ROOT = /join\([^;\n]*["'][^"'\n]*epositoryIntelligence[^"'\n]*["']/;

/** ...and specifically one hung off the person's home directory. */
const UNDER_HOME = /homedir\(\)[^;\n]*epositoryIntelligence/;

function walkTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

/**
 * Every source under `main/`, read once.
 *
 * Once rather than once per rule. The tree is a few hundred files and
 * every read is synchronous, and this suite has neighbours that spawn
 * real processes and hold them to a deadline —
 * `mcp/superviseStdioServer.test.ts` is one — so a scan that costs what
 * it needs to and nothing more is worth the small amount of structure
 * it takes.
 */
const SOURCES: { file: string; source: string }[] = walkTsFiles(mainSrcRoot)
  .map((file) => ({ file: relative(mainSrcRoot, file), source: readFileSync(file, "utf8") }))
  .filter(({ file }) => file !== SELF)
  .sort((a, b) => (a.file < b.file ? -1 : 1));

/** Every file matching `pattern`, relative and sorted. */
function filesMatching(pattern: RegExp, options: { includeTests: boolean }): string[] {
  return SOURCES.filter(({ file }) => options.includeTests || !file.endsWith(".test.ts"))
    .filter(({ source }) => pattern.test(source))
    .map(({ file }) => file);
}

describe("the repository intelligence cache root", () => {
  it("falls back to a scratch directory rather than the developer's home", () => {
    // The one way the old spelling could bite today: a test or the v1
    // gate that builds an engine with no root, turns the feature on and
    // reaches `ensureInstalled` downloads 46 MB into `~/.eo` and leaves
    // it there. "Outside every worktree" is the requirement, and a temp
    // root meets it without touching anything a person owns.
    const fallback = fallbackRepositoryIntelligenceRoot();

    expect(fallback.startsWith(tmpdir())).toBe(true);
    expect(fallback.startsWith(join(homedir(), ".eo"))).toBe(false);
  });

  it("is the same directory every time it is asked", () => {
    // A fresh directory per call — `mkdtemp` — would be unguessable, and
    // would also make a suite that reaches the fallback re-download on
    // every process. Stable is the trade this makes, and it is the same
    // trade the `~/.eo` spelling made.
    expect(fallbackRepositoryIntelligenceRoot()).toBe(fallbackRepositoryIntelligenceRoot());
  });

  it("is decided in exactly one production source", () => {
    // An exact set rather than an empty one, which is what proves the
    // pattern still matches anything at all: `install.ts` has to be in
    // the answer, so a regex that has quietly stopped matching fails
    // here rather than passing everywhere.
    expect(filesMatching(SPELLS_A_ROOT, { includeTests: false })).toEqual([DEFINITION]);
  });

  it("is nowhere hung off the home directory, tests included", () => {
    // Expected to match nothing, so it is proven live against the line
    // it exists to keep out before the scan is believed. Tests are in
    // scope here where they are not above: a test may legitimately
    // spell its own scratch root, and may never spell this one.
    expect(UNDER_HOME.test('join(homedir(), ".eo", "repositoryIntelligence")')).toBe(true);

    expect(filesMatching(UNDER_HOME, { includeTests: true })).toEqual([]);
  });
});
