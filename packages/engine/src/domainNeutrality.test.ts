import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The first of the two tests that make the new invariant executable
 * (KAN-177, `ARCHITECTURE.md`, "The invariants"): *a pack contributes to the
 * registry, and the core builds without any pack installed*.
 *
 * The design's original test was "delete the pack directory and
 * typecheck". Review found it would pass today while proving nothing
 * (`ARCHITECTURE.md`, "The core is domain-neutral"): the engine's git vocabulary
 * imports no pack, so an import-graph check cannot see it. `stackTarget.ts`
 * was 296 lines of branch stacking, the scheduler capped concurrency on
 * `workspaceId`, and `context.ts` branched on the string `"feature"` —
 * none of it reachable from a pack import, all of it the developer
 * domain sitting inside the domain-neutral half.
 *
 * KAN-161 took that vocabulary out and replaced it with functions the
 * tick input supplies: `capacityKeyOf`, `dispatchGate`, the section
 * renderers, and a container flag on the item view. This scan is what
 * keeps it out. It is the acceptance criterion of that story turned
 * into something that runs:
 *
 * ```
 * grep -nE 'repositoryId|workspaceId|\.branch|worktree|"feature"|"story"' \
 *   packages/engine/src --include=*.ts --exclude=*.test.ts
 * ```
 *
 * **Why a grep and not a type.** There is no type that says "this
 * package does not know what a repository is". The vocabulary is the
 * evidence: a file that needs to write `item.branch` is a file that
 * has assumed the workspace is a git worktree, and no amount of
 * interface will stop the assumption arriving as a string comparison.
 * A word list is crude, and crude is what survives five phases of
 * other people's edits.
 *
 * **Why the comments count too.** The scan reads the source as text,
 * prose included. An engine comment explaining what a worktree is, is
 * an engine that still thinks in worktrees; `replies.ts` says "the pack
 * that reads branch names" instead, which is the same fact told from
 * the right side of the boundary. The terms are chosen so that the
 * ordinary English senses survive: `branch` alone is control flow and
 * graph vocabulary and appears nine times in comments, so the term is
 * `.branch` — the property access — and `feature` and `story` are only
 * offences as quoted literals, because `parentFeatureSection` and
 * `StoryTouches` are the engine's own shapes and stay.
 *
 * Non-test sources only: a test may name whatever it is standing in
 * for, and `scheduler.test.ts` supplies a fake `capacityKeyOf` that has
 * to be about *something*.
 */
const srcDir = dirname(fileURLToPath(import.meta.url));

interface Term {
  /** How the term reads in the acceptance criterion and in the failure message. */
  readonly term: string;
  readonly pattern: RegExp;
  /** What the engine takes instead, so a failure says what to do rather than only what not to. */
  readonly instead: string;
}

const VOCABULARY: readonly Term[] = [
  // Both spellings of the same offence. The column was `repository_id`
  // until KAN-130 and is `workspace_id` now, and reading either one here
  // is the scheduler deciding for itself what two runs would collide in.
  // The old word stays banned although nothing is called that any more:
  // it costs one array entry, and a reintroduction would arrive under
  // the name the history it came from used.
  { term: "repositoryId", pattern: /repositoryId/i, instead: "`capacityKeyOf(ticket)` on the tick input — the pack decides what a shared filesystem is (KAN-161)" },
  { term: "workspaceId", pattern: /workspaceId/i, instead: "`capacityKeyOf(ticket)` on the tick input — the pack decides what a shared filesystem is (KAN-161)" },
  { term: ".branch", pattern: /\.branch\b/i, instead: "nothing here: branch stacking is the git workspace kind's, in `packs/developer/workspace/stackTarget.ts`" },
  { term: "worktree", pattern: /worktree/i, instead: "`workspace`, and the check belongs in the pack's verifier rather than in the prompt the engine builds" },
  { term: '"feature"', pattern: /["'`]feature["'`]/i, instead: "the container flag on the ticket view — item types are registry data, not string literals (KAN-161, and KAN-129 makes them rows)" },
  { term: '"story"', pattern: /["'`]story["'`]/i, instead: "the container flag on the ticket view — item types are registry data, not string literals (KAN-161, and KAN-129 makes them rows)" },
];

/** Every non-test TypeScript source under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) files.push(full);
  }
  return files;
}

/**
 * Every mention of the developer domain under a root, as
 * `file:line: term — take <instead> instead`.
 *
 * The file and the line are in the string itself rather than in a
 * separate assertion per file, so that `toEqual([])` prints the whole
 * list at once: the failure a later phase hits is usually several
 * lines of one reintroduced idea, and seeing one of them is seeing a
 * quarter of the problem.
 */
function domainMentions(root: string): string[] {
  return sourceFiles(root).flatMap((file) => {
    const where = relative(root, file);
    return readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, index) => VOCABULARY.filter(({ pattern }) => pattern.test(line)).map(({ term, instead }) => `${where}:${index + 1}: ${term} — take ${instead}`));
  });
}

describe("architectural invariant: packages/engine speaks no domain", () => {
  it("scans the engine's real sources, and there are some", () => {
    const scanned = sourceFiles(srcDir).map((file) => relative(srcDir, file));
    // Named rather than counted: these three are where the vocabulary
    // was, so a scan that stopped reaching them would be the exact
    // failure this file exists to prevent.
    expect(scanned).toContain("scheduler.ts");
    expect(scanned).toContain("context.ts");
    expect(scanned).toContain("routing.ts");
    expect(scanned).not.toContain("scheduler.test.ts");
  });

  it("no non-test source mentions repositoryId, workspaceId, .branch, worktree, \"feature\" or \"story\"", () => {
    expect(domainMentions(srcDir)).toEqual([]);
  });

  it("catches a one-line reintroduction, and leaves the ordinary English alone (proves it is not a tautology)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "eo-engine-domain-"));
    try {
      // The one the acceptance criterion names.
      writeFileSync(join(tempDir, "reintroduced.ts"), "export const target = (ticket: Ticket) => ticket.branch;\n");
      writeFileSync(join(tempDir, "capped.ts"), "const key = ticket.workspaceId ?? PROJECTLESS;\n");
      writeFileSync(join(tempDir, "checked.ts"), "  // The worktree is checked before the agent is told anything.\n");
      writeFileSync(join(tempDir, "branched.ts"), 'if (ticket.type === "feature") return decompose();\nif (ticket.type === "story") return clarify();\n');
      // Not offences: the graph and control-flow senses of "branch",
      // the engine's own shapes, and a test, which may say anything.
      writeFileSync(join(tempDir, "innocent.ts"), "// B's branch was cut from A's, so B alone is the dependent.\nconst { parentFeatureSection } = render(stories);\nexport interface StoryTouches {}\n");
      writeFileSync(join(tempDir, "innocent.test.ts"), 'const capacityKeyOf = (t: Ticket) => t.workspaceId ?? null;\nexpect(t.type).toBe("feature");\n');

      expect(domainMentions(tempDir).sort()).toEqual([
        "branched.ts:1: \"feature\" — take the container flag on the ticket view — item types are registry data, not string literals (KAN-161, and KAN-129 makes them rows)",
        "branched.ts:2: \"story\" — take the container flag on the ticket view — item types are registry data, not string literals (KAN-161, and KAN-129 makes them rows)",
        "capped.ts:1: workspaceId — take `capacityKeyOf(ticket)` on the tick input — the pack decides what a shared filesystem is (KAN-161)",
        "checked.ts:1: worktree — take `workspace`, and the check belongs in the pack's verifier rather than in the prompt the engine builds",
        "reintroduced.ts:1: .branch — take nothing here: branch stacking is the git workspace kind's, in `packs/developer/workspace/stackTarget.ts`",
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Keep checking is the core's and the engine's, and software delivery
  // is only its first user (EO-456): the developer pack's pull-request
  // watch is one check among many. So the engine's half of it may not
  // learn what any particular thing being watched is — and the words
  // that would say it has are a narrower list than the one above,
  // because the rest of the engine legitimately says "repository" where
  // it describes what a pack hands it.
  it("the keep-checking sources speak of no forge, pull request, merge or repository (EO-456)", () => {
    const offences = /forge|pull.?request|merge|repositor|\bci\b|github/i;
    const watchSources = ["watch.ts"];
    for (const file of watchSources) {
      const lines = readFileSync(join(srcDir, file), "utf8").split("\n");
      expect(lines.map((line, index) => (offences.test(line) ? `${file}:${index + 1}: ${line.trim()}` : null)).filter((line) => line !== null)).toEqual([]);
    }
  });
});
