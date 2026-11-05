import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The second of the two tests that make the new invariant executable
 * (KAN-177, `ARCHITECTURE.md`, "The invariants"): *a pack contributes to the
 * registry, and the core builds without any pack installed*.
 *
 * The first is a grep over `packages/engine/src`
 * (`packages/engine/src/domainNeutrality.test.ts`), which catches the
 * domain arriving as vocabulary. This one catches it arriving as an
 * import.
 *
 * **Why it is a list and not a rule.** The design's test was "delete
 * `packs/developer/` and typecheck". Review found it would fail all the
 * way through phase 6 (`ARCHITECTURE.md`, "The core is domain-neutral"), because the
 * files below still reach inside the pack for a function apiece and the
 * IPC contract still names `jira:*`, `forge:*`, `worktrees:*`,
 * `repositories:*` and `repositoryIntelligence:*` channels. Removing
 * them is later phases' work — this story's scope says so in as many
 * words. So "delete and typecheck" is the phase-7 exit criterion, and
 * what stands in for it until then is this: the set of files that may
 * reach inside the pack is written down, it may not grow by accident,
 * and every entry names the phase it is scheduled to leave in.
 *
 * `boundary.test.ts` is the other half and holds the stricter rule the
 * pack already satisfies: the pack *as a value* — `packs/developer/index.ts`,
 * the `CodePack` — has exactly two importers, because composing an
 * installation is the composition root's job. This file is about the
 * pack's insides.
 *
 * **How to shrink it.** Delete the import, then delete the entry. Both,
 * in the same change: an entry that no longer names an importer fails
 * the test below, so the list cannot linger behind the code. That is
 * the same bargain `liftedFromPack.test.ts` strikes with its `ALLOWED`
 * record, and it is what makes the list a plan rather than a ledger of
 * debt nobody reads.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..", "..");

/** Repository-relative, because that is how the allowlist is written and how a failure reads. */
const PACK = "apps/desktop/src/main/packs/developer";

/** When an entry is scheduled to leave. `"root"` is the one that never does. */
type Phase = "root" | 3 | 4 | 5 | 6;

interface Group {
  readonly phase: Phase;
  /** What has to happen for this group's imports to go, and which stories do it. */
  readonly why: string;
  readonly files: readonly string[];
}

/**
 * Every file outside `packs/developer/` that may reach inside it, and
 * when it stops.
 *
 * Grouped by departure rather than listed flat, so that the list reads
 * as a plan: each group says what has to be built before its imports
 * can go, and names the stories that build it.
 *
 * A file that reaches into two parts of the pack is listed under the
 * later of the two phases, because an entry leaves when its *last*
 * import does. `deleteItemCommand.ts` deletes a worktree and a Jira
 * issue; it is under phase 6 with the Jira work, not phase 4 with the
 * worktree work.
 *
 * The phases end at 6, which is the invariant's own claim: the
 * allowlist shrinks to empty by phase 6, leaving the composition root,
 * and phase 7 deletes the directory — and, with it, the two lines in
 * the composition root that fold the pack in — and typechecks.
 */
const SCHEDULE: readonly Group[] = [
  {
    phase: "root",
    why: "The composition root. It is where an installation is composed, so naming a pack is its whole job rather than a leak — `engine.ts` folds the `CodePack` into the supervisor's options and hands the Claude and Codex adapters the pack's search nudge; `startMain.ts` starts the Jira pull, the workspace root and the repository index for the installation it just composed — it was index.ts until EO-318 lifted the composition out from under Electron. These two do not leave the list: phase 7's \"delete the directory and typecheck\" deletes their two lines along with it.",
    files: ["apps/desktop/src/main/engine.ts", "apps/desktop/src/main/startMain.ts"],
  },
  {
    phase: 4,
    why: "Workspace kinds (KAN-150, KAN-165, KAN-169, KAN-179). Every one of these reaches for a worktree, a git command, a forge call or the repository index — the five methods of the `WorkspaceKind` interface, which EO-295 introduced and the git kind implements. What is left here reaches past the kind for a worktree, a git command, a forge call or the repository index directly; they become calls on the kind the step's workspace names.",
    files: [
      "apps/desktop/src/main/engine.test.ts",
      "apps/desktop/src/main/engineActivity.test.ts",
      "apps/desktop/src/main/gate/multiRepositoryGate.test.ts",
      "apps/desktop/src/main/gate/v1Gate.test.ts",
      "apps/desktop/src/main/ipc/config.test.ts",
      "apps/desktop/src/main/ipc/deleteProjectCommand.test.ts",
      "apps/desktop/src/main/ipc/forgeCommands.ts",
      "apps/desktop/src/main/ipc/repositoryIntelligenceCommands.test.ts",
      "apps/desktop/src/main/ipc/repositoryIntelligenceCommands.ts",
      "apps/desktop/src/main/ipc/worktreeCommands.test.ts",
      "apps/desktop/src/main/ipc/worktreeCommands.ts",
      "apps/desktop/src/main/providers/codexHooks.live.test.ts",
      "apps/desktop/src/main/roles/refine.test.ts",
      "apps/desktop/src/main/supervisor/buildDispatchContext.ts",
      "apps/desktop/src/main/testing/git.ts",
      "apps/desktop/src/main/testing/testing.test.ts",
      "scripts/claude-live-gate.mts",
      "scripts/index-adoption-trial.mjs",
      "scripts/index-benefit.mts",
      "scripts/interception-audit.mts",
    ],
  },
  {
    phase: 6,
    why: "Jira becomes a connector with a setup flow (KAN-139), and its IPC handlers become pack-contributed through the `registerIpc` hook the `CodePack` already carries (KAN-144). Until then the `jira:*` channels are declared in the core contract and answered by core handlers, which is why these files import a connection, a credential or a pull. This phase's scope says the handlers stay where they are until this allowlist forces them out; this is the list, and phase 6 is when it forces.",
    files: [
      "apps/desktop/src/main/archive/sweep.test.ts",
      "apps/desktop/src/main/ipc/deleteCommentCommand.test.ts",
      "apps/desktop/src/main/ipc/deleteCommentCommand.ts",
      "apps/desktop/src/main/ipc/deleteItemCommand.test.ts",
      "apps/desktop/src/main/ipc/deleteItemCommand.ts",
      "apps/desktop/src/main/ipc/domain.test.ts",
      "apps/desktop/src/main/ipc/domainCommands.ts",
      "apps/desktop/src/main/ipc/handlers.ts",
      "apps/desktop/src/main/ipc/itemCommands.ts",
      "apps/desktop/src/main/ipc/jira.test.ts",
      "apps/desktop/src/main/ipc/jiraCommands.ts",
      "apps/desktop/src/main/ipc/jiraImportCommands.ts",
      "apps/desktop/src/main/ipc/planCommands.ts",
      "apps/desktop/src/main/ipc/repositoryCommands.ts",
      "apps/desktop/src/main/mcpHost/dispatch.test.ts",
      "apps/desktop/src/main/mcpHost/http.test.ts",
      "apps/desktop/src/main/runtimes/apiKey.test.ts",
    ],
  },
  {
    phase: 6,
    why: "Core tests that compose the shipped pack (KAN-138, KAN-152). These test the supervisor, the roles and the guards — core behaviour — and they take the developer pack's wiring, builtins, sections or scheduling because it is the only pack there is, so \"dispatch something\" can only mean \"dispatch an implementer\". Phase 6 is where a second pack exists: the gallery bundles templates and the import gate admits data packs, and a core test that needs *a* pack stops having to mean *the* pack. `pack.test.ts` is here rather than with the composition root because it composes an engine to prove the fold works, which a stub pack proves just as well.",
    files: [
      "apps/desktop/src/main/gate/wave3Gate.test.ts",
      // EO-534: a resolved template update's watch step is run, as shipped, with the inputs it was published with.
      "apps/desktop/src/main/ipc/updateConflictResolution.test.ts",
      "apps/desktop/src/main/packs/pack.test.ts",
      "apps/desktop/src/main/providers/demo.test.ts",
      "apps/desktop/src/main/roles/assist.test.ts",
      "apps/desktop/src/main/roles/clarify.test.ts",
      "apps/desktop/src/main/roles/handoff.test.ts",
      "apps/desktop/src/main/roles/intake.test.ts",
      "apps/desktop/src/main/roles/mentionReply.test.ts",
      "apps/desktop/src/main/roles/multiPipeline.test.ts",
      "apps/desktop/src/main/roles/reviewVerdict.test.ts",
      "apps/desktop/src/main/supervisor/builtinSteps.test.ts",
      "apps/desktop/src/main/supervisor/conversationThread.test.ts",
      "apps/desktop/src/main/supervisor/debugCapture.test.ts",
      "apps/desktop/src/main/supervisor/guardrails.test.ts",
      "apps/desktop/src/main/supervisor/interceptionEvents.test.ts",
      "apps/desktop/src/main/supervisor/interpretReply.test.ts",
      "apps/desktop/src/main/supervisor/livePush.test.ts",
      "apps/desktop/src/main/supervisor/moduleQuestion.test.ts",
      "apps/desktop/src/main/supervisor/moduleSteps.test.ts",
      "apps/desktop/src/main/supervisor/moduleTimeLimit.test.ts",
      "apps/desktop/src/main/supervisor/pausedSystemAgent.test.ts",
      "apps/desktop/src/main/supervisor/progressOutcome.test.ts",
      "apps/desktop/src/main/supervisor/rerunMention.test.ts",
      "apps/desktop/src/main/supervisor/reviewWithoutCriteria.test.ts",
      "apps/desktop/src/main/supervisor/streamFinalisation.test.ts",
    ],
  },
];

const ALLOWLIST = new Map(SCHEDULE.flatMap((group) => group.files.map((file) => [file, group] as const)));

const SELF = relative(repoRoot, fileURLToPath(import.meta.url)).split(sep).join("/");

/**
 * Files whose pack specifiers are fixtures rather than dependencies.
 *
 * Both of these write import statements out as strings, to prove their
 * own scanners are not tautologies, and a scanner that reads text
 * cannot tell the difference. Neither depends on anything in the pack:
 * deleting the directory in phase 7 leaves both compiling. They are
 * named here rather than allowlisted because the allowlist is a debt
 * ledger and a quoted string is not a debt.
 */
const FIXTURES_NOT_IMPORTS: Record<string, string> = {
  [SELF]: "the fixtures below are import statements written out as strings, to prove this scan is not a tautology",
  "apps/desktop/src/main/liftedFromPack.test.ts": "the same, for the scan that keeps the lifted utilities out of the pack directories (KAN-126)",
};

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

/**
 * Does this specifier, written in this file, name something inside the
 * pack?
 *
 * Resolved rather than matched. A regex over the text misses
 * `./developer/index.js`, which is how `packs/pack.test.ts` reaches the
 * pack from one directory up — and the sibling that can reach it most
 * cheaply is the one most likely to.
 */
function reachesInsideThePack(file: string, specifier: string): boolean {
  const resolved = specifier.startsWith(".") ? posix.join(posix.dirname(file), specifier) : specifier;
  return resolved === PACK || resolved.startsWith(PACK + "/") || /(?:^|\/)packs\/developer\//.test(resolved);
}

interface SourceFile {
  /** Repository-relative. */
  readonly path: string;
  readonly source: string;
}

/** The files, in the given set, that reach inside the pack — sorted, repository-relative. */
function importersOfThePack(files: readonly SourceFile[]): string[] {
  return files
    .filter(({ path }) => !(path in FIXTURES_NOT_IMPORTS))
    .filter(({ path, source }) => specifiers(source).some((specifier) => reachesInsideThePack(path, specifier)))
    .map(({ path }) => path)
    .sort();
}

/**
 * The two ways the list and the tree can disagree.
 *
 * `unlisted` is a file that started reaching into the pack without
 * anybody deciding it should. `stale` is an entry whose import has gone
 * — the good direction, and still a failure, because the phase that
 * removed the import owes the list the same edit.
 */
function disagreements(importers: readonly string[], allowlist: ReadonlySet<string>): { unlisted: string[]; stale: string[] } {
  return {
    unlisted: importers.filter((file) => !allowlist.has(file)),
    stale: [...allowlist].filter((file) => !importers.includes(file)).sort(),
  };
}

/** Everything outside the pack that could hold an import: source, tests, scripts and the pure packages. */
const outsideThePack: SourceFile[] = [codeFiles(join(repoRoot, "apps", "desktop", "src")), codeFiles(join(repoRoot, "scripts")), codeFiles(join(repoRoot, "packages"))]
  .flat()
  .map((file) => relative(repoRoot, file).split(sep).join("/"))
  .filter((file) => !file.startsWith(PACK + "/"))
  .map((path) => ({ path, source: readFileSync(join(repoRoot, path), "utf8") }));

describe("the import allowlist scans the tree it claims to", () => {
  it("reaches the main process, the renderer, the scripts and the pure packages", () => {
    const paths = outsideThePack.map(({ path }) => path);
    expect(paths).toContain("apps/desktop/src/main/supervisor/runSupervisor.ts");
    expect(paths).toContain("apps/desktop/src/main/ipc/handlers.ts");
    expect(paths).toContain("scripts/index-adoption-trial.mjs");
    // `packages/engine` may not import a pack at all (invariant 2), and
    // the only way to know it has not is to look.
    expect(paths).toContain("packages/engine/src/scheduler.ts");
    expect(paths).not.toContain("apps/desktop/src/main/packs/developer/wiring.ts");
  });

  it("resolves a specifier rather than matching its text", () => {
    expect(reachesInsideThePack("apps/desktop/src/main/packs/pack.test.ts", "./developer/index.js")).toBe(true);
    expect(reachesInsideThePack("apps/desktop/src/main/ipc/handlers.ts", "../packs/developer/jira/pull.js")).toBe(true);
    expect(reachesInsideThePack("scripts/index-benefit.mts", "../apps/desktop/src/main/packs/developer/repositoryIntelligence/measurement.js")).toBe(true);
    expect(reachesInsideThePack("apps/desktop/src/main/ipc/handlers.ts", "../packs/registry.js")).toBe(false);
    expect(reachesInsideThePack("apps/desktop/src/main/ipc/handlers.ts", "@eo/core")).toBe(false);
  });
});

describe("architectural invariant: who may reach inside the developer pack", () => {
  it("nothing outside the allowlist imports from packs/developer/", () => {
    const { unlisted } = disagreements(importersOfThePack(outsideThePack), new Set(ALLOWLIST.keys()));
    expect(unlisted, `these files reach into ${PACK}/ and are not on the allowlist in ${SELF}`).toEqual([]);
  });

  it("every entry is still an importer, so the list shrinks with the code rather than behind it", () => {
    const { stale } = disagreements(importersOfThePack(outsideThePack), new Set(ALLOWLIST.keys()));
    expect(stale, "these entries no longer import from the pack — delete them from the allowlist in the change that removed the import").toEqual([]);
  });

  it("reads as a plan: every entry names the phase it leaves in, and nothing is scheduled after phase 6", () => {
    for (const [file, group] of ALLOWLIST) {
      expect(group.why.length, `${file} is scheduled without a reason`).toBeGreaterThan(40);
      if (group.phase === "root") continue;
      expect(group.phase, `${file} is scheduled after the phase the allowlist must be empty by`).toBeLessThanOrEqual(6);
    }
    // The composition root is the whole of what survives the shrink, so
    // it is named rather than counted.
    expect([...ALLOWLIST].filter(([, group]) => group.phase === "root").map(([file]) => file)).toEqual(["apps/desktop/src/main/engine.ts", "apps/desktop/src/main/startMain.ts"]);
  });

  it("does not both exempt a file and allow it", () => {
    for (const [file, why] of Object.entries(FIXTURES_NOT_IMPORTS)) {
      expect(ALLOWLIST.has(file), `${file} is exempt (${why}) and also on the allowlist — one of the two is wrong`).toBe(false);
      expect(outsideThePack.map(({ path }) => path), `${file} is exempt but no longer in the tree`).toContain(file);
    }
  });

  it("lists each file once, in an order a person can scan", () => {
    const listed = SCHEDULE.flatMap((group) => group.files);
    expect(listed.length, `duplicated: ${listed.filter((file, index) => listed.indexOf(file) !== index).join(", ")}`).toBe(new Set(listed).size);
    // Sorted within each group, so that striking an entry off is
    // finding a line rather than reading the list.
    for (const group of SCHEDULE) expect(group.files, `phase ${group.phase} is out of order`).toEqual([...group.files].sort());
  });
});

describe("the scan catches what it claims to (proves it is not a tautology)", () => {
  const listed = "apps/desktop/src/main/ipc/jiraCommands.ts";
  const unlistedFile = "apps/desktop/src/main/ipc/newCommands.ts";
  const reachesIn = 'import { jiraFor } from "../packs/developer/jira/connection.js";';
  const allowlist = new Set([listed]);

  it("fails when a file that is not on the allowlist starts importing the pack", () => {
    const tree: SourceFile[] = [
      { path: listed, source: reachesIn },
      { path: unlistedFile, source: reachesIn },
    ];
    expect(disagreements(importersOfThePack(tree), allowlist)).toEqual({ unlisted: [unlistedFile], stale: [] });
  });

  it("passes when an allowlisted entry is removed — the import goes, and the entry goes with it", () => {
    const tree: SourceFile[] = [{ path: listed, source: 'import { nothing } from "../packs/registry.js";' }];
    expect(disagreements(importersOfThePack(tree), new Set())).toEqual({ unlisted: [], stale: [] });
  });

  it("reports an entry left behind by the import it was written for", () => {
    const tree: SourceFile[] = [{ path: listed, source: 'import { nothing } from "../packs/registry.js";' }];
    expect(disagreements(importersOfThePack(tree), allowlist)).toEqual({ unlisted: [], stale: [listed] });
  });

  it("sees a dynamic import and a require, and ignores a path that only looks like one", () => {
    const dynamic: SourceFile = { path: unlistedFile, source: 'const { jiraFor } = await import("../packs/developer/jira/connection.js");' };
    const required: SourceFile = { path: unlistedFile, source: 'const { git } = require("../packs/developer/workspace/git.js");' };
    const mention: SourceFile = { path: unlistedFile, source: '// moved to packs/developer/jira/connection.js\nconst path = "apps/desktop/src/main/packs/developer/prompts/implementer.md";' };
    expect(importersOfThePack([dynamic])).toEqual([unlistedFile]);
    expect(importersOfThePack([required])).toEqual([unlistedFile]);
    expect(importersOfThePack([mention])).toEqual([]);
  });
});
