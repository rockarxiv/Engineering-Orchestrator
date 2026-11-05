import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../../db/client.js";
import { getItem, listRunsForItem, updateWorkspace, type GitWorkspace } from "../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../../../db/testHelpers.js";
import { BUILTIN_RUNNERS } from "../builtins.js";
import { createRoleWiring } from "../wiring.js";
import { createScriptedProvider } from "../../../providers/scripted.js";
import { validImplementResult } from "../../../providers/fixtures.js";
import { setBranchPrefix } from "./branchPrefix.js";
import { createRunSupervisor } from "../../../supervisor/runSupervisor.js";
import { branchExists } from "./git.js";
import { worktreePathFor } from "./worktrees.js";
import { run, makeRepo as sharedMakeRepo } from "../../../testing/git.js";
import { installedKinds } from "../../../supervisor/testWorkspaceKinds.js";
import { gitWorkspaceKind } from "./gitKind.js";

/**
 * Two real repositories, driven by one engine (D-04).
 *
 * The whole point of the story: before this, EO kept a single global
 * workspace row, so a second repo replaced the first and every item
 * was cut from whichever one happened to be there.
 */
let scratch: string;
let worktreeRoot: string;
let handle: DbHandle;
let api: GitWorkspace;
let web: GitWorkspace;

async function makeRepo(name: string): Promise<string> {
  return sharedMakeRepo(scratch, name);
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo many repositories "));
  worktreeRoot = join(scratch, "work trees");

  handle = openMigratedTestDb();
  // Hermetic: without this, the branch prefix seeds itself from whatever
  // `git config --global user.email` happens to be on the machine
  // running the tests, not from the fixed "eo" every assertion expects.
  setBranchPrefix(handle.db, "eo");
  api = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: await makeRepo("the api"), baseBranch: "main" });
  web = attachWorkspace(handle.db, { name: "web", keyPrefix: "WEB", repoPath: await makeRepo("the web"), baseBranch: "main" });
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** An implementer that really writes and commits, so the G-02 verifier has something to check. */
function workingProvider() {
  const scripted = createScriptedProvider([
    { when: (context) => context.includes(`"review" action`), script: { result: { verdict: "approve", feedback: "LGTM", blocking_issues: [] } } },
    { when: () => true, script: { result: validImplementResult } },
  ]);

  return {
    async *start(opts: Parameters<typeof scripted.start>[0]) {
      if (opts.context.includes(`"implement" action`)) {
        const key = /\b([A-Z]+-\d+)\b/.exec(opts.context)?.[1] ?? "unknown";
        writeFileSync(join(opts.cwd, `${key}.txt`), `work for ${key}\n`);
        await run(["add", "-A"], opts.cwd);
        await run(["commit", "-m", `feat: ${key}`], opts.cwd);
      }
      yield* scripted.start(opts);
    },
    resume: scripted.resume.bind(scripted),
  };
}

function supervisor() {
  return createRunSupervisor({
    db: handle.db,
    provider: workingProvider(),
    // The whole kind, as `engine.ts` wires it: it prepares each item's
    // worktree in its own repository, verifies against it, and — G-03 —
    // lets go of it when the item settles.
    kinds: installedKinds(gitWorkspaceKind({ db: handle.db, worktreeRoot, intelligenceFor: () => null })),
    builtins: BUILTIN_RUNNERS,
    ...createRoleWiring(handle.db),
    limits: { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 5 },
  });
}

async function settle(maxTicks = 12): Promise<void> {
  const engine = supervisor();
  for (let i = 0; i < maxTicks; i++) await engine.runOnce();
}

describe("two repositories on one engine", () => {
  it("works each item in its own repository, on its own branch", async () => {
    const apiItem = createTestItem(handle.db, { type: "story", title: "Rate limit", stepId: "todo", workspaceId: api.id, spec: REVIEWABLE_SPEC });
    const webItem = createTestItem(handle.db, { type: "story", title: "Dark mode", stepId: "todo", workspaceId: web.id, spec: REVIEWABLE_SPEC });

    await settle();

    // Each commit landed in its own repo, and neither branch exists in
    // the other — the thing that was impossible before D-04.
    expect(await branchExists(api.config.repoPath, `eo/${apiItem.key}`)).toBe(true);
    expect(await branchExists(web.config.repoPath, `eo/${webItem.key}`)).toBe(true);
    expect(await branchExists(api.config.repoPath, `eo/${webItem.key}`)).toBe(false);
    expect(await branchExists(web.config.repoPath, `eo/${apiItem.key}`)).toBe(false);
  });

  it("gives each repository's items keys and worktrees that cannot collide", async () => {
    const apiItem = createTestItem(handle.db, { type: "story", title: "First", stepId: "todo", workspaceId: api.id });
    const webItem = createTestItem(handle.db, { type: "story", title: "Also first", stepId: "todo", workspaceId: web.id });

    // Both are their repository's first item, and they still differ.
    expect(apiItem.key).toBe("API-1");
    expect(webItem.key).toBe("WEB-1");
    expect(worktreePathFor(apiItem.key, worktreeRoot)).not.toBe(worktreePathFor(webItem.key, worktreeRoot));
  });

  it("carries both to done without either seeing the other's repo", async () => {
    const apiItem = createTestItem(handle.db, { type: "story", title: "A", stepId: "todo", workspaceId: api.id, spec: REVIEWABLE_SPEC });
    const webItem = createTestItem(handle.db, { type: "story", title: "B", stepId: "todo", workspaceId: web.id, spec: REVIEWABLE_SPEC });

    await settle();

    expect(getItem(handle.db, apiItem.id)?.stepId).toBe("ready_to_merge");
    expect(getItem(handle.db, webItem.id)?.stepId).toBe("ready_to_merge");
    // G-03 released both, in their own repos.
    expect(existsSync(worktreePathFor(apiItem.key, worktreeRoot))).toBe(false);
    expect(existsSync(worktreePathFor(webItem.key, worktreeRoot))).toBe(false);
  });

  it("verifies an item with its own repository's check commands", async () => {
    // The api suite fails and the web suite passes. If verification read
    // "the" configured commands, both items would share one verdict.
    updateWorkspace(handle.db, api.id, { config: { testCommand: `node -e "process.exit(1)"` } });
    updateWorkspace(handle.db, web.id, { config: { testCommand: `node -e ""` } });

    const apiItem = createTestItem(handle.db, { type: "story", title: "Fails its own suite", stepId: "todo", workspaceId: api.id, spec: REVIEWABLE_SPEC });
    const webItem = createTestItem(handle.db, { type: "story", title: "Passes its own suite", stepId: "todo", workspaceId: web.id, spec: REVIEWABLE_SPEC });

    await settle();

    expect(getItem(handle.db, apiItem.id)?.stepId).toBe("todo"); // held back by its repo's failing tests
    // Some attempt failed verification. Not the *last* run: after three
    // tries the attempt-limit guard parks the item, and that guard
    // placeholder is what ends up last.
    expect(listRunsForItem(handle.db, apiItem.id).some((entry) => entry.status === "failed")).toBe(true);
    expect(getItem(handle.db, webItem.id)?.stepId).toBe("ready_to_merge");
  });
});
