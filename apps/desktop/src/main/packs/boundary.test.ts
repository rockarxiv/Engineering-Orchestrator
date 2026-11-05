import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Who is allowed to know the developer pack exists (KAN-144).
 *
 * Two different questions, and only the first is settled by this story.
 *
 * **The pack as a pack.** `packs/developer/index.ts` is the `CodePack`
 * value — the workspace kinds, the scheduling hooks, the functions, the
 * wiring and the registry contribution, assembled. Importing *that* is composing an
 * installation, which is the composition root's job and nobody else's.
 * This file holds it to exactly two importers.
 *
 * **The pack's insides.** Sixty-two files still reach into `forge/`,
 * `jira/`, `workspace/` and `repositoryIntelligence/` for a function
 * apiece — twenty of them shipped code (the IPC handlers for the forge,
 * Jira, repository and worktree commands; the dispatch context's review
 * appendix) and the rest tests of the very things that moved. The story
 * says in as many words that they keep working through the same paths
 * for now; the scan that records them and shrinks the list phase by
 * phase is KAN-177's, and what this file does is write down what that
 * list starts from, so that the seventh story inherits a number rather
 * than a survey and a new importer added between now and then is
 * visible.
 */
const here = dirname(fileURLToPath(import.meta.url));
const mainSrcRoot = join(here, "..");
const repoRoot = join(mainSrcRoot, "..", "..", "..", "..");
const packRoot = join(mainSrcRoot, "packs", "developer");

const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

function codeFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...codeFiles(full));
    else if (entry.isFile() && CODE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) && !entry.name.endsWith(".d.ts")) files.push(full);
  }
  return files;
}

/** Every specifier a file imports from, static and dynamic. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  return found;
}

/** Everything outside the pack that could hold an import: source, tests and scripts alike. */
const outsideThePack = [...codeFiles(join(repoRoot, "apps", "desktop", "src")), ...codeFiles(join(repoRoot, "scripts"))]
  .filter((file) => !file.startsWith(packRoot + sep))
  // Not this file, nor `pack.test.ts`: one scans for these specifiers
  // and the other composes an engine out of the pack to prove the fold
  // works. A check that catches itself is a check nobody can pass.
  .filter((file) => file !== fileURLToPath(import.meta.url) && file !== join(here, "pack.test.ts"))
  .map((file) => relative(repoRoot, file).split(sep).join("/"));

function importsFromPack(file: string, predicate: (specifier: string) => boolean): boolean {
  return specifiers(readFileSync(join(repoRoot, file), "utf8")).some(predicate);
}

/** `packs/developer/index.js` itself, however the importer spells the path to it. */
const isThePackValue = (specifier: string): boolean => /(?:^|\/)packs\/developer\/index\.js$/.test(specifier);

/** Anything under `packs/developer/`, the value included. */
const reachesInsideThePack = (specifier: string): boolean => /(?:^|\/)packs\/developer\//.test(specifier);

describe("the developer pack as a pack", () => {
  it("is imported by the composition root and nothing else", () => {
    const importers = outsideThePack.filter((file) => importsFromPack(file, isThePackValue));
    // `startMain.ts` names it because that is where an installation is
    // composed — index.ts was that file until EO-318 moved the
    // composition out from under Electron; `engine.ts` because
    // `createEngine` folds it in by default, so that a caller with no
    // opinion — the v1 gate, a test — still gets the engine EO ships.
    // Anything else on this list is a file that should be taking what it
    // needs from the fold instead.
    expect(importers.sort()).toEqual(["apps/desktop/src/main/engine.ts", "apps/desktop/src/main/startMain.ts"]);
  });

  it("scans the tree it claims to", () => {
    expect(outsideThePack).toContain("apps/desktop/src/main/supervisor/runSupervisor.ts");
    expect(outsideThePack).toContain("apps/desktop/src/main/ipc/handlers.ts");
    expect(outsideThePack).toContain("scripts/index-adoption-trial.mjs");
    expect(outsideThePack).not.toContain("apps/desktop/src/main/packs/developer/wiring.ts");
  });

  it("is not imported by the run supervisor, which is the half of the boundary that matters most", () => {
    // `packages/engine` cannot reach a pack at all (invariant #2), and
    // the run supervisor is the main-process half of the same rule: it
    // takes the workspace kinds, the runners and the wiring as data, so
    // a single import here would put git back inside it. Its two neighbours are
    // named with it because they are the pieces the pack's own wiring
    // and runners are *built on* — the routing table and the builtin
    // contract — and an import either way round would make the
    // dependency a cycle rather than a boundary.
    // `workspaceKind.ts` is named with them since EO-295: it declares
    // the five methods a kind answers to, and an import of the git one
    // would make the interface a description of its only implementation.
    for (const file of ["runSupervisor.ts", "routeResult.ts", "builtins.ts", "workspaceKind.ts"]) {
      const source = readFileSync(join(mainSrcRoot, "supervisor", file), "utf8");
      expect(specifiers(source).filter(reachesInsideThePack), file).toEqual([]);
    }
  });
});

describe("the files that still reach inside the pack", () => {
  /**
   * The count this file kept at KAN-144, now a list.
   *
   * It was a count with a direction — sixty-two files, allowed to fall
   * and not to rise — because KAN-144 added no rule about who may
   * import a pack's internals and inventing one there would have been
   * inventing scope. KAN-177 is where the rule belongs, and it is in
   * `importAllowlist.test.ts`: every one of those files written down by
   * name, with the phase it is scheduled to leave in, so that a new
   * importer fails the build and a removed one has to be struck off the
   * list in the same change. A count and a list asserting the same
   * thing would only mean the list gets edited and the count gets
   * argued with, so this keeps the half the list does not cover — who
   * may import the pack *as a value* — and hands over the rest.
   */
  /**
   * The two scans whose pack specifiers are fixtures rather than
   * dependencies — each writes import statements out as strings to
   * prove it is not a tautology, and a scan that reads text cannot tell
   * the difference. `importAllowlist.test.ts` names both in its own
   * exemption list for the same reason.
   */
  const FIXTURES_NOT_IMPORTS = ["apps/desktop/src/main/packs/importAllowlist.test.ts", "apps/desktop/src/main/liftedFromPack.test.ts"];

  it("are enumerated by the allowlist, which is the thing that shrinks", () => {
    const allowlist = readFileSync(join(here, "importAllowlist.test.ts"), "utf8");
    for (const file of outsideThePack.filter((file) => !FIXTURES_NOT_IMPORTS.includes(file)).filter((file) => importsFromPack(file, reachesInsideThePack))) {
      expect(allowlist, `${file} reaches inside the pack and is not named in importAllowlist.test.ts`).toContain(file);
    }
  });
});
