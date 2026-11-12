import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { gitStateOf, GIT_WORKTREE_KIND, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../../../db/client.js";
import { comments, workspaces } from "../../../db/schema.js";
import {
  addDependency,
  addWorkspaceToProject,
  projectForWorkspace,
  createProject,
  getItem,
  listRepositoryIndexes,
  listRunsForItem,
  needsAttention,
  pendingPushesForItem,
  postComment,
  recordRepositoryIndex,
  setJiraSync,
  transitionItem,
  updateStep,
  updateWorkspace,
  updateItem,
  type Workspace,
} from "../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../../../db/testHelpers.js";
import type { CliRunner } from "../forge/cli.js";
import { createFakeProvider } from "../../../providers/fake.js";
import { createScriptedProvider } from "../../../providers/scripted.js";
import { BUILTIN_RUNNERS } from "../builtins.js";
import { createRoleWiring } from "../wiring.js";
import { validImplementResult } from "../../../providers/fixtures.js";
import { createRunSupervisor } from "../../../supervisor/runSupervisor.js";
import { setBranchPrefix } from "./branchPrefix.js";
import { branchExists, git } from "./git.js";
import {
  createWorktreeWorkspace,
  forgetIndexesForReleasedWorktrees,
  releaseStaleWorktrees,
  releaseWorktree,
  releaseWorktreeFor,
} from "./dispatchWorkspace.js";
import { createWorktree, worktreePathFor } from "./worktrees.js";
import { run } from "../../../testing/git.js";
import { fakeWorkspaceKind, installedKinds } from "../../../supervisor/testWorkspaceKinds.js";
import { removeScratch } from "../../../testing/scratch.js";

/**
 * What `prepare` answers with since EO-295: a directory, the kind that
 * prepared it and the workspace row it came from — so that a hook
 * downstream is handed a workspace rather than a string it has to guess
 * the meaning of.
 */
const preparedFor = (forItem: Item, cwd: string) => ({ ok: true, workspace: { cwd, kind: GIT_WORKTREE_KIND, workspaceId: forItem.workspaceId } });

/**
 * A recorded `gh` runner for the stacking resolver (EO-10 / KAN-42):
 * answers `pr list --head <branch>` with the state named for that
 * branch, and "no pull request" for anything else — same JSON shape
 * `mergeState.test.ts` and `sender.test.ts` use.
 */
function forgeRunnerFor(states: Record<string, "OPEN" | "MERGED" | "CLOSED">): CliRunner {
  return async (_cli, args) => {
    const branch = args[args.indexOf("--head") + 1];
    const state = branch ? states[branch] : undefined;
    if (!state) return { ok: true, stdout: "[]", error: "", notFound: false };
    return { ok: true, stdout: JSON.stringify([{ url: "https://github.com/acme/api/pull/1", state }]), error: "", notFound: false };
  };
}

let scratch: string;
let repoPath: string;
let worktreeRoot: string;
let handle: DbHandle;
let item: Item;
let repository: Workspace;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo ws test "));
  repoPath = join(scratch, "the repo");
  worktreeRoot = join(scratch, "work trees");
  mkdirSync(repoPath, { recursive: true });
  await run(["init", "-b", "main"], repoPath);
  await run(["config", "user.email", "eo@example.com"], repoPath);
  await run(["config", "user.name", "EO Test"], repoPath);
  // Hermetic: a developer machine may sign commits globally (1Password,
  // gpg), and a signing agent that rate-limits under parallel test load
  // turns into "failed to write commit object". Test repos must not
  // depend on whose machine they run on.
  await run(["config", "commit.gpgsign", "false"], repoPath);
  await run(["config", "tag.gpgsign", "false"], repoPath);
  writeFileSync(join(repoPath, "README.md"), "# fixture\n");
  await run(["add", "."], repoPath);
  await run(["commit", "-m", "initial"], repoPath);

  handle = openMigratedTestDb();
  // Hermetic like the git config above: without this, the branch prefix
  // seeds itself from whatever `git config --global user.email` happens
  // to be on the machine running the tests, not from the fixed "eo" every
  // assertion below expects.
  setBranchPrefix(handle.db, "eo");
  repository = attachWorkspace(handle.db, { name: "the repo", keyPrefix: "EO", repoPath, baseBranch: "main" });
  item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id, spec: REVIEWABLE_SPEC });
});

afterEach(() => {
  vi.restoreAllMocks();
  handle.close();
  removeScratch(scratch);
});

/**
 * A step that names a *different* repository than the ticket is on
 * (EO-301, caught in review).
 *
 * The supervisor decides which kind to dispatch from
 * `resolveItemWorkspace`, which has honoured the step's pick since this
 * story landed. Preparation did not: isolated mode read
 * `item.workspaceId` and cut the worktree there, so an item on
 * repository A whose step picked repository B was dispatched as B and
 * then worked in A — and the run was stamped with A's id, which is what
 * `artifacts` later diffs and what `borrowedCheck` reads a base branch
 * from. Two readings of one question, which is the failure the design spends
 * a paragraph on.
 *
 * Both modes are driven, because they arrive at the checkout by
 * different routes: read mode resolves through `workspaceFor` and
 * isolated mode through `stepPickedWorkspace`.
 */
describe("a step that picks another of the project's repositories", () => {
  /**
   * A second real checkout. `joinsTheProject` is the difference between
   * a pick a step may legitimately name and one from another project,
   * which is the whole of the third case below — `attachWorkspace` puts
   * it on a project made for it, so leaving it there is what "another
   * project's" means.
   */
  async function secondRepository(joinsTheProject = true): Promise<{ workspace: Workspace; path: string }> {
    const path = join(scratch, "the other repo");
    mkdirSync(path, { recursive: true });
    await run(["init", "-b", "main"], path);
    await run(["config", "user.email", "eo@example.com"], path);
    await run(["config", "user.name", "EO Test"], path);
    await run(["config", "commit.gpgsign", "false"], path);
    await run(["config", "tag.gpgsign", "false"], path);
    writeFileSync(join(path, "README.md"), "# the other fixture\n");
    await run(["add", "."], path);
    await run(["commit", "-m", "initial"], path);

    const workspace = attachWorkspace(handle.db, { name: "the other repo", keyPrefix: "OTH", repoPath: path, baseBranch: "main" });
    // The fixture makes it a project; a step may only pick among the
    // project's own workspaces, so it joins the item's.
    if (joinsTheProject) addWorkspaceToProject(handle.db, projectForWorkspace(handle.db, repository.id)!.id, workspace.id);
    return { workspace, path };
  }

  it("cuts the worktree in the repository the step picked, not the one the ticket is on", async () => {
    const other = await secondRepository();
    updateStep(handle.db, "todo", { workspaceId: other.workspace.id });

    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(item, "implement");

    expect(result.ok).toBe(true);
    // The branch is in the picked repository and nowhere near the one
    // the ticket names — which is the whole of the claim.
    expect(await branchExists(other.path, `eo/${item.key}`)).toBe(true);
    expect(await branchExists(repoPath, `eo/${item.key}`)).toBe(false);
    // And the run is stamped with the repository it actually used:
    // `artifacts` diffs this row and `borrowedCheck` reads its base
    // branch, so a stamp naming the other repository is a diff taken
    // from the wrong checkout.
    expect(result.ok && result.workspace.workspaceId).toBe(other.workspace.id);
  });

  it("reads the repository the step picked, when the step reads rather than branches", async () => {
    const other = await secondRepository();
    updateStep(handle.db, "todo", { workspaceId: other.workspace.id, workspaceMode: "read" });

    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(item, "implement");

    expect(result).toEqual({ ok: true, workspace: { cwd: other.path, kind: GIT_WORKTREE_KIND, workspaceId: other.workspace.id } });
    // Nothing was cut: reading is the whole of what this mode does.
    expect(await branchExists(other.path, `eo/${item.key}`)).toBe(false);
  });

  it("ignores a pick belonging to another project, and works in the ticket's own repository", async () => {
    // The shared-pipeline hole, from the dispatch end: `default` belongs
    // to every project, so a pick stored while one project was active
    // must not reach an item from another. Here the second repository is
    // deliberately *not* added to the item's project.
    const other = await secondRepository(false);
    // Left on the project attaching it created, which is a project the
    // ticket has nothing to do with.
    expect(projectForWorkspace(handle.db, other.workspace.id)!.id).not.toBe(projectForWorkspace(handle.db, repository.id)!.id);
    updateStep(handle.db, "todo", { workspaceId: other.workspace.id });

    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(item, "implement");

    expect(result.ok).toBe(true);
    expect(result.ok && result.workspace.workspaceId).toBe(repository.id);
    expect(await branchExists(repoPath, `eo/${item.key}`)).toBe(true);
    expect(await branchExists(other.path, `eo/${item.key}`)).toBe(false);
  });
});

describe("createWorktreeWorkspace", () => {
  it("runs the agent inside the item's own worktree, and records it on the run", async () => {

    let agentCwd: string | undefined;
    const inner = createFakeProvider({ result: validImplementResult });
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: {
        start: (opts) => {
          agentCwd = opts.cwd;
          return inner.start(opts);
        },
        resume: inner.resume.bind(inner),
      },
      kinds: installedKinds(fakeWorkspaceKind({ prepare: createWorktreeWorkspace(handle.db, worktreeRoot) })),
    });

    await supervisor.runOnce();

    expect(agentCwd).toBe(worktreePathFor(item.key, worktreeRoot));
    expect(existsSync(join(agentCwd!, "README.md"))).toBe(true); // a real checkout, not just a path

    const [runRow] = listRunsForItem(handle.db, item.id);
    expect(runRow?.status).toBe("succeeded");
    expect(runRow?.cwd).toBe(agentCwd); // persisted, so cleanup can find it later
  });

  it("dispatches through a dirty base repo instead of escalating on it", async () => {
    // The old behaviour: refuse, and escalate. A human with unrelated work
    // in progress in their own checkout stopped every item in the
    // project, for a state that has no bearing on what the worktree
    // contains.
    writeFileSync(join(repoPath, "uncommitted.txt"), "work in progress\n");

    let started = false;
    const inner = createFakeProvider({ result: validImplementResult });
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: {
        start: (opts) => {
          started = true;
          return inner.start(opts);
        },
        resume: inner.resume.bind(inner),
      },
      kinds: installedKinds(fakeWorkspaceKind({ prepare: createWorktreeWorkspace(handle.db, worktreeRoot) })),
    });

    await supervisor.runOnce();

    expect(started).toBe(true);
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
    expect(needsAttention(handle.db, item.id)).toBe(false);
    expect(handle.db.select().from(comments).all().some((comment) => comment.kind === "escalation")).toBe(false);
    // The agent's checkout never saw the human's in-progress file.
    expect(existsSync(join(worktreePathFor(item.key, worktreeRoot), "uncommitted.txt"))).toBe(false);
  });

  describe("cutting from the remote base branch", () => {
    /** A bare remote, pushed from `repoPath` and then moved on without it. */
    async function remoteAhead(): Promise<void> {
      const remotePath = join(scratch, "the remote.git");
      await run(["init", "--bare", "-b", "main", remotePath], scratch);
      await run(["remote", "add", "origin", remotePath], repoPath);
      await run(["push", "-u", "origin", "main"], repoPath);

      // A commit that exists only on the remote — somebody else's merge,
      // which is the normal state of `main` on any repository with more
      // than one person on it. The local branch is left behind on purpose.
      const clone = join(scratch, "some other clone");
      await run(["clone", remotePath, clone], scratch);
      await run(["config", "user.email", "other@example.com"], clone);
      await run(["config", "user.name", "Someone Else"], clone);
      await run(["config", "commit.gpgsign", "false"], clone);
      await run(["config", "tag.gpgsign", "false"], clone);
      writeFileSync(join(clone, "landed-upstream.txt"), "merged while EO was not looking\n");
      await run(["add", "-A"], clone);
      await run(["commit", "-m", "somebody else's merge"], clone);
      await run(["push", "origin", "main"], clone);
    }

    it("cuts the branch from the remote's base branch, not the local one", async () => {
      await remoteAhead();

      const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(item, "implement");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The whole point: the local `main` does not have this file.
      expect(existsSync(join(result.workspace.cwd, "landed-upstream.txt"))).toBe(true);
      expect(existsSync(join(repoPath, "landed-upstream.txt"))).toBe(false);
    });

    it("leaves the human's own checkout alone while doing it", async () => {
      await remoteAhead();
      await run(["checkout", "-b", "my-own-branch"], repoPath);
      writeFileSync(join(repoPath, "mine.txt"), "in progress\n");

      expect((await createWorktreeWorkspace(handle.db, worktreeRoot)(item, "implement")).ok).toBe(true);

      // Not fast-forwarded, not checked out, not stashed: EO reads
      // `origin/main` and touches nothing of theirs.
      const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
      expect(branch.ok && branch.stdout).toBe("my-own-branch");
      expect(existsSync(join(repoPath, "mine.txt"))).toBe(true);
      expect(existsSync(join(repoPath, "landed-upstream.txt"))).toBe(false);
    });

    it("escalates rather than falling back to the local branch when the remote has no base branch", async () => {
      const remotePath = join(scratch, "an empty remote.git");
      await run(["init", "--bare", "-b", "main", remotePath], scratch);
      await run(["remote", "add", "origin", remotePath], repoPath);

      const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(item, "implement");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("main");
      expect(result.reason).toContain("origin");
      expect(existsSync(worktreePathFor(item.key, worktreeRoot))).toBe(false); // nothing cut from a stale local base
    });

    it("uses the local base branch when the repository has no remote at all", async () => {
      // EO is usable against a repository nobody has pushed anywhere, and
      // refusing there would be inventing a requirement.
      const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(item, "implement");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(existsSync(join(result.workspace.cwd, "README.md"))).toBe(true);
    });
  });

  it("reuses the item's worktree across a second dispatch instead of tripping the branch guard", async () => {
    const prepare = createWorktreeWorkspace(handle.db, worktreeRoot);

    const first = await prepare(item, "implement");
    const second = await prepare(item, "review");

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
  });

  it("re-attaches an occupied worktree for a reviewer dispatch after a restart, instead of failing on \"already exists\" (issue #143)", async () => {
    // The previous process left the checkout on disk, on the item's
    // own branch, with the work in it — which is the normal state of a
    // item sitting at Review when EO is restarted.
    const implemented = await createWorktreeWorkspace(handle.db, worktreeRoot)(item, "implement");
    expect(implemented.ok).toBe(true);

    // The new process reads the item back out of the database and
    // schedules the reviewer. The reuse fast path is missed — this
    // process's listing does not report the path — and everything left
    // used to end in `git worktree add`, which refuses a path that
    // already exists. The run was recorded `awaiting_input` before the
    // agent started, with no events and no token usage, and a perfectly
    // runnable reviewer step became an escalation.
    const reloaded = getItem(handle.db, item.id)!;
    const gitModule = await import("./git.js");
    const realGit = gitModule.git;
    const calls: string[][] = [];
    vi.spyOn(gitModule, "listWorktrees").mockResolvedValue({ ok: false, error: "fatal: could not read the worktree list" });
    vi.spyOn(gitModule, "git").mockImplementation(async (args, cwd, options) => {
      calls.push(args);
      return realGit(args, cwd, options);
    });

    const review = await createWorktreeWorkspace(handle.db, worktreeRoot)(reloaded, "review");

    vi.restoreAllMocks();
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.workspace.cwd).toBe(worktreePathFor(item.key, worktreeRoot));
    expect(existsSync(join(review.workspace.cwd, "README.md"))).toBe(true); // the checkout that was already there
    expect(calls.some((args) => args[0] === "worktree" && args[1] === "add")).toBe(false);
  });

  it("refuses a reviewer dispatch whose worktree path holds something else, in the shape that escalates", async () => {
    // The refusal side of the same door: preparation returns a reason,
    // which is what `runSupervisor` turns into a blocking comment
    // (invariant #8) — no new escalation mechanism, and nothing that
    // fails silently.
    expect((await createWorktreeWorkspace(handle.db, worktreeRoot)(item, "implement")).ok).toBe(true);
    const path = worktreePathFor(item.key, worktreeRoot);
    expect((await releaseWorktreeFor(handle.db, item, worktreeRoot)).released).toBe(true);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "half a download.zip"), "not a checkout\n");

    const review = await createWorktreeWorkspace(handle.db, worktreeRoot)(getItem(handle.db, item.id)!, "review");

    expect(review.ok).toBe(false);
    if (review.ok) return;
    expect(review.reason).toContain("half a download.zip");
    expect(review.reason).not.toContain("already exists");
  });

  describe("Branch naming: configurable prefix + jiraKey preference (EO-16)", () => {
    it("names a first-ever dispatch's branch from the configured prefix and the item's own key", async () => {
      setBranchPrefix(handle.db, "lyudvig");
      const prepare = createWorktreeWorkspace(handle.db, worktreeRoot);

      const result = await prepare(item, "implement");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.workspace.cwd).toBe(worktreePathFor(item.key, worktreeRoot)); // worktree dir stays keyed by the EO key
      expect(gitStateOf(getItem(handle.db, item.id)!).branch).toBe(`lyudvig/${item.key}`);
      expect(await branchExists(repoPath, `lyudvig/${item.key}`)).toBe(true);
    });

    it("prefers a jiraKey already set before the first dispatch, but keeps the worktree keyed by the EO key", async () => {
      setBranchPrefix(handle.db, "lyudvig");
      updateItem(handle.db, item.id, { jiraKey: "KAN-46" });
      const prepare = createWorktreeWorkspace(handle.db, worktreeRoot);

      const result = await prepare(getItem(handle.db, item.id)!, "implement");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.workspace.cwd).toBe(worktreePathFor(item.key, worktreeRoot));
      expect(gitStateOf(getItem(handle.db, item.id)!).branch).toBe("lyudvig/KAN-46");
      expect(await branchExists(repoPath, "lyudvig/KAN-46")).toBe(true);
    });

    /**
     * And says nothing to Jira while the switch is off (EO-122).
     *
     * The branch is still written to the item: `dispatchWorkspace`
     * records where the work is happening either way, and the switch
     * only decides whether Jira is told. Pinned as two separate
     * assertions because collapsing them is exactly how a gate placed
     * one line too early would stop the column being written at all.
     */
    it("names the branch and records it, but queues no branch push, while Jira sync is off", async () => {
      setBranchPrefix(handle.db, "lyudvig");
      updateItem(handle.db, item.id, { jiraKey: "KAN-47" });
      setJiraSync(handle.db, item.id, false);
      const prepare = createWorktreeWorkspace(handle.db, worktreeRoot);

      const result = await prepare(getItem(handle.db, item.id)!, "implement");

      expect(result.ok).toBe(true);
      expect(gitStateOf(getItem(handle.db, item.id)!).branch).toBe("lyudvig/KAN-47");
      expect(pendingPushesForItem(handle.db, item.id, "jira")).toEqual([]);
    });

    it("keeps an already-dispatched item's branch unchanged after it is later linked to Jira", async () => {
      setBranchPrefix(handle.db, "eo");
      const prepare = createWorktreeWorkspace(handle.db, worktreeRoot);
      const first = await prepare(item, "implement");
      expect(first.ok).toBe(true);
      const originalBranch = gitStateOf(getItem(handle.db, item.id)!).branch;
      expect(originalBranch).toBe(`eo/${item.key}`);

      // Linked to Jira, and the prefix changed, after the branch already exists.
      updateItem(handle.db, item.id, { jiraKey: "KAN-46" });
      setBranchPrefix(handle.db, "lyudvig");

      const second = await prepare(getItem(handle.db, item.id)!, "review");

      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.workspace.cwd).toBe(worktreePathFor(item.key, worktreeRoot));
      // No rename: still the branch created before the Jira link and prefix change.
      expect(gitStateOf(getItem(handle.db, item.id)!).branch).toBe(originalBranch);
      expect(await branchExists(repoPath, "lyudvig/KAN-46")).toBe(false);
    });
  });

  describe("Branch naming under a Reference (EO-638)", () => {
    const feature = (reference: string | null) =>
      createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id, git: { reference } });
    const storyUnder = (parentId: Item["id"], overrides: Partial<Parameters<typeof createTestItem>[1]> = {}) =>
      createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id, spec: REVIEWABLE_SPEC, parentId, ...overrides });
    const branchOf = (of: Item) => gitStateOf(getItem(handle.db, of.id)!).branch;

    it("cuts <prefix>/<Reference>-<KEY> for two stories sharing their feature's Reference, and creates both worktrees", async () => {
      const parent = feature("PROJ-123");
      const first = storyUnder(parent.id);
      const second = storyUnder(parent.id);
      const prepare = createWorktreeWorkspace(handle.db, worktreeRoot);

      expect((await prepare(first, "implement")).ok).toBe(true);
      expect((await prepare(second, "implement")).ok).toBe(true);

      expect(branchOf(first)).toBe(`eo/PROJ-123-${first.key}`);
      expect(branchOf(second)).toBe(`eo/PROJ-123-${second.key}`);
      expect(await branchExists(repoPath, `eo/PROJ-123-${first.key}`)).toBe(true);
      expect(await branchExists(repoPath, `eo/PROJ-123-${second.key}`)).toBe(true);
      expect(existsSync(worktreePathFor(first.key, worktreeRoot))).toBe(true);
      expect(existsSync(worktreePathFor(second.key, worktreeRoot))).toBe(true);
    });

    it("applies the configured prefix", async () => {
      setBranchPrefix(handle.db, "feat");
      const own = storyUnder(feature(null).id, { git: { reference: "PROJ-123" } });

      expect((await createWorktreeWorkspace(handle.db, worktreeRoot)(own, "implement")).ok).toBe(true);

      expect(branchOf(own)).toBe(`feat/PROJ-123-${own.key}`);
    });

    it("cuts <prefix>/<Jira key> for a story with its own Jira key, whatever its feature's Reference", async () => {
      const mirrored = storyUnder(feature("PROJ-123").id, { jiraKey: "KAN-9" });

      expect((await createWorktreeWorkspace(handle.db, worktreeRoot)(mirrored, "implement")).ok).toBe(true);

      expect(branchOf(mirrored)).toBe("eo/KAN-9");
    });

    it("cuts <prefix>/<KEY> when nothing names the work", async () => {
      const plain = storyUnder(feature(null).id);

      expect((await createWorktreeWorkspace(handle.db, worktreeRoot)(plain, "implement")).ok).toBe(true);

      expect(branchOf(plain)).toBe(`eo/${plain.key}`);
    });

    it("keeps a branch already cut when a Reference is set or changed afterwards", async () => {
      const parent = feature(null);
      const story = storyUnder(parent.id);
      const prepare = createWorktreeWorkspace(handle.db, worktreeRoot);
      expect((await prepare(story, "implement")).ok).toBe(true);

      updateItem(handle.db, story.id, { git: { reference: "PROJ-123" } });
      updateItem(handle.db, parent.id, { git: { reference: "PROJ-9" } });
      expect((await prepare(getItem(handle.db, story.id)!, "review")).ok).toBe(true);

      expect(branchOf(story)).toBe(`eo/${story.key}`);
      expect(await branchExists(repoPath, `eo/PROJ-123-${story.key}`)).toBe(false);
    });
  });

  it("refuses to dispatch code-bearing work with no repository", async () => {
    // A story without a repository cannot receive an isolated worktree.
    // Falling back to the app cwd lets an agent edit an unrelated checkout.
    const unattached = createTestItem(handle.db, { type: "story", title: "Written during onboarding", stepId: "todo" });
    const prepare = createWorktreeWorkspace(handle.db, worktreeRoot);

    const result = await prepare(unattached, "implement");

    expect(result).toEqual({
      ok: false,
      reason: `${unattached.key} is a story with no repository assigned. Assign it to a repository before running implement.`,
    });
    expect(existsSync(worktreePathFor(unattached.key, worktreeRoot))).toBe(false);
  });

  it("refuses code-bearing work whose repository row is gone, rather than falling back to the process cwd", async () => {
    // The item names a repository that has vanished while its project
    // still has one attached — so neither of the two states that may
    // legitimately reach `process.cwd()` holds, and the old fallback
    // handed an agent EO's own launch directory with nothing said.
    // Substituting the project's surviving repository would be no better:
    // a story's branch belongs to the one repository it names.
    //
    // Reached with the foreign key off, because that is the only way to
    // reach it: `items.workspace_id` references `workspaces` with no
    // cascade, so the database itself refuses to leave an item pointing
    // at nothing (openForItem.test.ts reaches the same state the same
    // way). A defence, then — but a defence that quietly dispatches
    // somewhere else is worse than none.
    const project = projectForWorkspace(handle.db, repository.id)!;
    const survivor = attachWorkspace(handle.db, { name: "still attached", keyPrefix: "SUR", repoPath: join(scratch, "still attached"), baseBranch: "main" });
    addWorkspaceToProject(handle.db, project.id, survivor.id);
    const orphan = createTestItem(handle.db, {
      type: "story",
      title: "Points at a repository that is gone",
      stepId: "todo",
      projectId: project.id,
      workspaceId: repository.id,
    });

    handle.db.run(sql`PRAGMA foreign_keys = OFF`);
    handle.db.delete(workspaces).where(eq(workspaces.id, repository.id)).run();
    handle.db.run(sql`PRAGMA foreign_keys = ON`);

    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(orphan, "implement");

    expect(result).toEqual({
      ok: false,
      reason: `${orphan.key} is a story whose repository no longer exists in EO. Assign it to a repository before running implement.`,
    });
    expect(existsSync(worktreePathFor(orphan.key, worktreeRoot))).toBe(false);
  });

  describe("Feature items (EO-8)", () => {
    // Features never carry their own code changes — all implementation
    // happens in child stories — so no worktree/branch should ever be
    // created for one, at any state or action. The stray eo/EO-7 branch
    // this fixes came from a Feature reaching Done, but the bug is really
    // "ensureWorktree ran at all" — so this must hold everywhere, not just
    // at the Done/MR step.
    for (const action of ["refine", "implement", "review"]) {
      it(`skips ensureWorktree entirely for a "${action}" dispatch and returns the repo path`, async () => {
        const feature = createTestItem(handle.db, {
          type: "feature",
          title: "A feature",
          stepId: "todo",
          workspaceId: repository.id,
          jiraKey: "EO-7",
        });
        const prepare = createWorktreeWorkspace(handle.db, worktreeRoot);

        const result = await prepare(feature, action);

        expect(result).toEqual(preparedFor(feature, repoPath));
        // No directory created under the worktree root — ensureWorktree
        // was never called.
        expect(existsSync(worktreePathFor(feature.key, worktreeRoot))).toBe(false);

        // Nothing written to the item, and nothing queued for Jira.
        expect(gitStateOf(getItem(handle.db, feature.id)!).branch).toBeNull();
        expect(pendingPushesForItem(handle.db, feature.id, "jira")).toEqual([]);
      });
    }

    // Issue #148. A feature's null `workspaceId` means "belongs to a
    // project", not "has nowhere to run" — and every dispatch against one
    // used to be handed EO's own process cwd, which for a packaged app is
    // wherever it was launched from: not the project's checkout, often
    // not a git repository, and not on any trust list a provider
    // consults. A Codex-backed role refused it outright and the run died
    // about 200ms in, before the agent started.
    describe("a feature with no repository of its own (issue #148)", () => {
      it("reads its project's repository rather than the process cwd", async () => {
        const project = projectForWorkspace(handle.db, repository.id)!;
        const feature = createTestItem(handle.db, { type: "feature", title: "Spans the project", stepId: "todo", projectId: project.id });

        const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(feature, "implement");

        expect(result).toEqual(preparedFor(feature, repoPath));
        expect(existsSync(worktreePathFor(feature.key, worktreeRoot))).toBe(false);
      });

      it("starts the agent there, and says nothing about a fallback", async () => {
        // The regression, end to end: what the provider is actually
        // handed. Against the old code this is `process.cwd()` — the
        // directory the run then died in.
        const project = projectForWorkspace(handle.db, repository.id)!;
        const feature = createTestItem(handle.db, { type: "feature", title: "Repository-less feature", stepId: "todo", projectId: project.id });

        const starts: { cwd: string; context: string }[] = [];
        const inner = createFakeProvider({ result: validImplementResult });
        const supervisor = createRunSupervisor({
          db: handle.db,
          provider: {
            start: (opts) => {
              starts.push({ cwd: opts.cwd, context: opts.context });
              return inner.start(opts);
            },
            resume: inner.resume.bind(inner),
          },
          kinds: installedKinds(fakeWorkspaceKind({ prepare: createWorktreeWorkspace(handle.db, worktreeRoot) })),
          builtins: BUILTIN_RUNNERS,
          ...createRoleWiring(handle.db),
        });

        // The story from the fixture is dispatchable too, and concurrency
        // is 1 (invariant #10), so this ticks until the feature has had
        // its turn rather than assuming it goes first.
        for (let tick = 0; tick < 4 && !starts.some((entry) => entry.context.includes(feature.key)); tick++) await supervisor.runOnce();

        const dispatched = starts.find((entry) => entry.context.includes(feature.key));
        expect(dispatched, "the feature was dispatched at all").toBeDefined();
        expect(dispatched?.cwd).toBe(repoPath);
        expect(dispatched?.cwd).not.toBe(process.cwd());
        // Nothing to explain: it got real code to read. Its own thread
        // only — the fixture story runs alongside it — and the engine's
        // half of it, since the agent's own handoff note is not this
        // story's business.
        const engineSaid = handle.db
          .select()
          .from(comments)
          .all()
          .filter((comment) => comment.itemId === feature.id && comment.authorType === "engine");
        expect(engineSaid).toEqual([]);
      });

      it("prefers its own repository when it has one, over the project's first", async () => {
        const project = projectForWorkspace(handle.db, repository.id)!;
        const other = attachWorkspace(handle.db, { name: "the other repo", keyPrefix: "OTH", repoPath: join(scratch, "the other repo"), baseBranch: "main" });
        addWorkspaceToProject(handle.db, project.id, other.id);
        const feature = createTestItem(handle.db, {
          type: "feature",
          title: "Pinned to one repo",
          stepId: "todo",
          projectId: project.id,
          workspaceId: other.id,
        });

        expect(await createWorktreeWorkspace(handle.db, worktreeRoot)(feature, "implement")).toEqual(preparedFor(feature, join(scratch, "the other repo")));
      });

      // The last resort was the process cwd, and it is gone (EO-296).
      // EO is still usable before a repository is attached — a feature
      // is where the first plan gets written — but the item that has
      // nowhere to read is on the `none` kind now, which gives it an
      // empty directory of its own and a "no disk" badge. It never
      // reaches this kind at all; the supervisor resolves `none` before
      // the git kind is asked. What is left here is the defence for the
      // state that *can* still arrive: an item naming a git workspace
      // that has gone while its project has none either.
      it("refuses rather than substituting a directory when there is no checkout to read", async () => {
        const feature = createTestItem(handle.db, { type: "feature", title: "Unattached feature", stepId: "todo" });
        const prepare = createWorktreeWorkspace(handle.db, worktreeRoot);

        expect(await prepare(feature, "implement")).toEqual({
          ok: false,
          reason: `${feature.key} has no repository to read. Attach one to its project before running implement.`,
        });

        // And nothing said in the thread, because nothing happened that
        // needs explaining: a refusal is already an answer a person can
        // act on, and the note this replaces existed only to account for
        // a directory EO had picked on its own.
        expect(handle.db.select().from(comments).all().filter((comment) => comment.authorType === "engine")).toEqual([]);
      });

      it("refuses the same way when the project has no repository attached at all", async () => {
        const empty = createProject(handle.db, { name: "Nothing attached yet", keyPrefix: "NEW" });
        const feature = createTestItem(handle.db, { type: "feature", title: "Written during onboarding", stepId: "todo", projectId: empty.id });

        expect(await createWorktreeWorkspace(handle.db, worktreeRoot)(feature, "implement")).toEqual({
          ok: false,
          reason: `${feature.key} has no repository to read. Attach one to its project before running implement.`,
        });
      });
    });

    it("leaves non-Feature item types on the existing worktree/branch/outbox path", async () => {
      // A jiraKey already set, before this item's first dispatch: the
      // branch prefers it over EO's own key (EO-16), but the worktree
      // directory stays keyed by the EO key regardless (EO-14's pinned
      // decision — it's an internal-only path).
      const story = createTestItem(handle.db, {
        type: "story",
        title: "A story",
        stepId: "todo",
        workspaceId: repository.id,
        jiraKey: "KAN-9",
      });
      const prepare = createWorktreeWorkspace(handle.db, worktreeRoot);

      const result = await prepare(story, "implement");

      expect(result).toEqual(preparedFor(story, worktreePathFor(story.key, worktreeRoot)));
      expect(existsSync(worktreePathFor(story.key, worktreeRoot))).toBe(true);
      expect(gitStateOf(getItem(handle.db, story.id)!).branch).toBe("eo/KAN-9");
      const pushes = pendingPushesForItem(handle.db, story.id, "jira");
      expect(pushes.some((entry) => entry.kind === "branch")).toBe(true);
    });
  });

  describe("Branch stacking (EO-10 / KAN-42)", () => {
    function storyUnder(featureId: Item["id"], title: string) {
      return createTestItem(handle.db, { type: "story", title, stepId: "todo", workspaceId: repository.id, parentId: featureId });
    }

    it("cuts the worktree from a still-open same-feature dependency's branch instead of the base branch", async () => {
      updateWorkspace(handle.db, repository.id, { config: { forgeKind: "github" } });
      const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
      const dependency = storyUnder(feature.id, "Dependency");
      const dependent = storyUnder(feature.id, "Dependent");
      addDependency(handle.db, dependent.id, dependency.id);

      // The dependency's own worktree/branch, with a commit only it carries.
      const dep = await createWorktreeWorkspace(handle.db, worktreeRoot)(dependency, "implement");
      expect(dep.ok).toBe(true);
      if (!dep.ok) return;
      writeFileSync(join(dep.workspace.cwd, "dep-only.txt"), "only on the dependency\n");
      await run(["add", "-A"], dep.workspace.cwd);
      await run(["commit", "-m", "dependency work"], dep.workspace.cwd);

      const prepare = createWorktreeWorkspace(handle.db, worktreeRoot, forgeRunnerFor({ [`eo/${dependency.key}`]: "OPEN" }));
      const result = await prepare(dependent, "implement");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Cut from the dependency's branch, not main — proven by the file
      // that exists only on that branch.
      expect(existsSync(join(result.workspace.cwd, "dep-only.txt"))).toBe(true);
      expect(gitStateOf(getItem(handle.db, dependent.id)!).branch).toBe(`eo/${dependent.key}`);
    });

    it("cuts from the base branch, unaffected, once the same-feature dependency has merged", async () => {
      updateWorkspace(handle.db, repository.id, { config: { forgeKind: "github" } });
      const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
      const dependency = storyUnder(feature.id, "Dependency");
      const dependent = storyUnder(feature.id, "Dependent");
      addDependency(handle.db, dependent.id, dependency.id);

      const prepare = createWorktreeWorkspace(handle.db, worktreeRoot, forgeRunnerFor({ [`eo/${dependency.key}`]: "MERGED" }));
      const result = await prepare(dependent, "implement");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(existsSync(join(result.workspace.cwd, "README.md"))).toBe(true);
      // Cut straight from main's tip — same as if there were no
      // dependency at all.
      const log = await git(["log", "--oneline"], result.workspace.cwd);
      expect(log.ok && log.stdout.split("\n")).toHaveLength(1);
    });

    it("escalates without creating a worktree or branch when the dependency's MR closed without merging", async () => {
      updateWorkspace(handle.db, repository.id, { config: { forgeKind: "github" } });
      const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
      const dependency = storyUnder(feature.id, "Dependency");
      const dependent = storyUnder(feature.id, "Dependent");
      addDependency(handle.db, dependent.id, dependency.id);

      const prepare = createWorktreeWorkspace(handle.db, worktreeRoot, forgeRunnerFor({ [`eo/${dependency.key}`]: "CLOSED" }));
      const result = await prepare(dependent, "implement");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain(dependency.key);
      expect(result.reason).toContain("closed");
      expect(existsSync(worktreePathFor(dependent.key, worktreeRoot))).toBe(false);
      expect(await branchExists(repoPath, `eo/${dependent.key}`)).toBe(false);
    });

    it("escalates when two same-feature dependencies are equidistant and both still open", async () => {
      updateWorkspace(handle.db, repository.id, { config: { forgeKind: "github" } });
      const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
      const depA = storyUnder(feature.id, "Dep A");
      const depB = storyUnder(feature.id, "Dep B");
      const dependent = storyUnder(feature.id, "Dependent");
      addDependency(handle.db, dependent.id, depA.id);
      addDependency(handle.db, dependent.id, depB.id);

      const prepare = createWorktreeWorkspace(
        handle.db,
        worktreeRoot,
        forgeRunnerFor({ [`eo/${depA.key}`]: "OPEN", [`eo/${depB.key}`]: "OPEN" }),
      );
      const result = await prepare(dependent, "implement");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain(depA.key);
      expect(result.reason).toContain(depB.key);
      // The escalation is a question, so it names the answers it takes —
      // and the reason invites a branch name as the third one.
      expect(result.options).toEqual([depA.key, depB.key]);
      expect(result.reason).toContain("branch");
      expect(existsSync(worktreePathFor(dependent.key, worktreeRoot))).toBe(false);
    });

    it("does not ask at all when one unmerged dependency already builds on the other", async () => {
      // C depends on A and B, and B depends on A: B's branch was cut
      // from A's, so it carries both and there is nothing to choose.
      updateWorkspace(handle.db, repository.id, { config: { forgeKind: "github" } });
      const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
      const depA = storyUnder(feature.id, "Dep A");
      const depB = storyUnder(feature.id, "Dep B");
      const dependent = storyUnder(feature.id, "Dependent");
      addDependency(handle.db, dependent.id, depA.id);
      addDependency(handle.db, dependent.id, depB.id);
      addDependency(handle.db, depB.id, depA.id);

      const states = { [`eo/${depA.key}`]: "OPEN" as const, [`eo/${depB.key}`]: "OPEN" as const };
      // B's own worktree, cut from A's branch and carrying a commit of
      // its own — the stack this is meant to continue.
      const a = await createWorktreeWorkspace(handle.db, worktreeRoot, forgeRunnerFor(states))(depA, "implement");
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      writeFileSync(join(a.workspace.cwd, "a-only.txt"), "only on A\n");
      await run(["add", "-A"], a.workspace.cwd);
      await run(["commit", "-m", "A's work"], a.workspace.cwd);

      const b = await createWorktreeWorkspace(handle.db, worktreeRoot, forgeRunnerFor(states))(depB, "implement");
      expect(b.ok).toBe(true);
      if (!b.ok) return;

      const result = await createWorktreeWorkspace(handle.db, worktreeRoot, forgeRunnerFor(states))(dependent, "implement");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Cut from B, which carries A: A's file is there without anyone
      // having been asked anything.
      expect(existsSync(join(result.workspace.cwd, "a-only.txt"))).toBe(true);
    });

    it("cuts from the dependency a person picked when EO asked which one", async () => {
      // The loop this closes: before, answering the escalation produced
      // the same escalation again, because nothing read the reply.
      updateWorkspace(handle.db, repository.id, { config: { forgeKind: "github" } });
      const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
      const depA = storyUnder(feature.id, "Dep A");
      const depB = storyUnder(feature.id, "Dep B");
      const dependent = storyUnder(feature.id, "Dependent");
      addDependency(handle.db, dependent.id, depA.id);
      addDependency(handle.db, dependent.id, depB.id);

      const states = { [`eo/${depA.key}`]: "OPEN" as const, [`eo/${depB.key}`]: "OPEN" as const };
      const b = await createWorktreeWorkspace(handle.db, worktreeRoot, forgeRunnerFor(states))(depB, "implement");
      expect(b.ok).toBe(true);
      if (!b.ok) return;
      writeFileSync(join(b.workspace.cwd, "b-only.txt"), "only on B\n");
      await run(["add", "-A"], b.workspace.cwd);
      await run(["commit", "-m", "B's work"], b.workspace.cwd);

      const asked = await createWorktreeWorkspace(handle.db, worktreeRoot, forgeRunnerFor(states))(dependent, "implement");
      expect(asked.ok).toBe(false);
      if (asked.ok) return;
      postComment(handle.db, {
        itemId: dependent.id,
        author: { type: "engine" },
        kind: "escalation",
        body: asked.reason,
        ...(asked.options ? { options: asked.options } : {}),
        mentions: [{ type: "human" }],
      });
      postComment(handle.db, { itemId: dependent.id, author: { type: "human" }, body: depB.key });

      const result = await createWorktreeWorkspace(handle.db, worktreeRoot, forgeRunnerFor(states))(dependent, "implement");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(existsSync(join(result.workspace.cwd, "b-only.txt"))).toBe(true);
    });

    it("cuts from a branch a person named instead of either dependency", async () => {
      updateWorkspace(handle.db, repository.id, { config: { forgeKind: "github" } });
      const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
      const depA = storyUnder(feature.id, "Dep A");
      const depB = storyUnder(feature.id, "Dep B");
      const dependent = storyUnder(feature.id, "Dependent");
      addDependency(handle.db, dependent.id, depA.id);
      addDependency(handle.db, dependent.id, depB.id);

      // A branch that is neither dependency, carrying something only it has.
      await run(["branch", "release/24.3"], repoPath);
      const release = join(scratch, "release");
      await run(["worktree", "add", release, "release/24.3"], repoPath);
      writeFileSync(join(release, "release-only.txt"), "only on the release branch\n");
      await run(["add", "-A"], release);
      await run(["commit", "-m", "release work"], release);
      await run(["worktree", "remove", release], repoPath);

      postComment(handle.db, {
        itemId: dependent.id,
        author: { type: "engine" },
        kind: "escalation",
        body: "which one?",
        options: [depA.key, depB.key],
        mentions: [{ type: "human" }],
      });
      postComment(handle.db, { itemId: dependent.id, author: { type: "human" }, body: "release/24.3" });

      const states = { [`eo/${depA.key}`]: "OPEN" as const, [`eo/${depB.key}`]: "OPEN" as const };
      const result = await createWorktreeWorkspace(handle.db, worktreeRoot, forgeRunnerFor(states))(dependent, "implement");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(existsSync(join(result.workspace.cwd, "release-only.txt"))).toBe(true);
      // Its own branch, cut *from* the named one — not a checkout of it.
      expect(gitStateOf(getItem(handle.db, dependent.id)!).branch).toBe(`eo/${dependent.key}`);
    });

    it("asks again, quoting the reply, when the branch a person named does not exist", async () => {
      updateWorkspace(handle.db, repository.id, { config: { forgeKind: "github" } });
      const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
      const depA = storyUnder(feature.id, "Dep A");
      const depB = storyUnder(feature.id, "Dep B");
      const dependent = storyUnder(feature.id, "Dependent");
      addDependency(handle.db, dependent.id, depA.id);
      addDependency(handle.db, dependent.id, depB.id);

      postComment(handle.db, {
        itemId: dependent.id,
        author: { type: "engine" },
        kind: "escalation",
        body: "which one?",
        options: [depA.key, depB.key],
        mentions: [{ type: "human" }],
      });
      postComment(handle.db, { itemId: dependent.id, author: { type: "human" }, body: "release/typo" });

      const states = { [`eo/${depA.key}`]: "OPEN" as const, [`eo/${depB.key}`]: "OPEN" as const };
      const result = await createWorktreeWorkspace(handle.db, worktreeRoot, forgeRunnerFor(states))(dependent, "implement");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      // The second escalation is not the first one repeated: it says what
      // was tried and why it did not work (invariant #8).
      expect(result.reason).toContain("release/typo");
      expect(existsSync(worktreePathFor(dependent.key, worktreeRoot))).toBe(false);
    });

    it("never stacks on a dependency that belongs to a different parent feature", async () => {
      const featureOne = createTestItem(handle.db, { type: "feature", title: "Feature One", stepId: "todo", workspaceId: repository.id });
      const featureTwo = createTestItem(handle.db, { type: "feature", title: "Feature Two", stepId: "todo", workspaceId: repository.id });
      const dependency = storyUnder(featureOne.id, "Dependency");
      const dependent = storyUnder(featureTwo.id, "Dependent");
      addDependency(handle.db, dependent.id, dependency.id);

      // No forge configured, and a runner that throws if ever invoked —
      // proving an out-of-scope dependency costs no lookup at all, not
      // merely that it resolves to "base".
      const runner: CliRunner = async () => {
        throw new Error("must not be called for an out-of-scope dependency");
      };
      const prepare = createWorktreeWorkspace(handle.db, worktreeRoot, runner);

      const result = await prepare(dependent, "implement");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(existsSync(join(result.workspace.cwd, "README.md"))).toBe(true);
    });

    it("never stacks on a same-feature dependency that lives in a different repository (KAN-17)", async () => {
      // A feature can span repositories; a branch never can. Cutting
      // web's worktree with `eo/<api-story>` as the start point would be
      // a `git worktree add` for a ref that only exists in another
      // repository entirely.
      const otherRepoPath = join(scratch, "the other repo");
      mkdirSync(otherRepoPath, { recursive: true });
      await run(["init", "-b", "main"], otherRepoPath);
      await run(["config", "user.email", "eo@example.com"], otherRepoPath);
      await run(["config", "user.name", "EO Test"], otherRepoPath);
      await run(["config", "commit.gpgsign", "false"], otherRepoPath);
      await run(["config", "tag.gpgsign", "false"], otherRepoPath);
      writeFileSync(join(otherRepoPath, "README.md"), "# other\n");
      await run(["add", "-A"], otherRepoPath);
      await run(["commit", "-m", "initial"], otherRepoPath);
      const otherRepository = attachWorkspace(handle.db, { name: "other repo", keyPrefix: "OTH", repoPath: otherRepoPath, baseBranch: "main" });

      const feature = createTestItem(handle.db, { type: "feature", title: "Spans two repos", stepId: "todo" });
      const dependency = createTestItem(handle.db, { type: "story", title: "Dependency", stepId: "todo", workspaceId: otherRepository.id, parentId: feature.id });
      const dependent = storyUnder(feature.id, "Dependent");
      addDependency(handle.db, dependent.id, dependency.id);

      const runner: CliRunner = async () => {
        throw new Error("must not be called for a dependency in a different repository");
      };
      const prepare = createWorktreeWorkspace(handle.db, worktreeRoot, runner);

      const result = await prepare(dependent, "implement");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(existsSync(join(result.workspace.cwd, "README.md"))).toBe(true);
    });

    it("a story with no dependency at all is unaffected", async () => {
      const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
      const dependent = storyUnder(feature.id, "Dependent");

      const runner: CliRunner = async () => {
        throw new Error("must not be called when there is no dependency");
      };
      const prepare = createWorktreeWorkspace(handle.db, worktreeRoot, runner);

      const result = await prepare(dependent, "implement");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(existsSync(join(result.workspace.cwd, "README.md"))).toBe(true);
    });
  });
});

describe("a conversation reads the repository rather than a worktree", () => {
  // The Discussions's conversation is an item in an off-project state.
  // It carries no code changes, so a worktree for it would be a stray
  // branch with nothing on it — but the product owner is asked "how
  // does this work today?" and has to be able to look.
  it("resolves to the project's repository when the conversation belongs to no repository", async () => {
    const project = projectForWorkspace(handle.db, repository.id)!;
    // Null by design on a project that may span several repositories,
    // which is exactly the case that used to fall through to EO's own
    // process cwd.
    const chat = createTestItem(handle.db, { type: "feature", title: "Conversation", stepId: "discussion", projectId: project.id });

    const workspace = await createWorktreeWorkspace(handle.db, worktreeRoot)(chat, "discussion");

    expect(workspace).toEqual(preparedFor(chat, repoPath));
    expect(existsSync(worktreePathFor(chat.key, worktreeRoot))).toBe(false);
    expect(gitStateOf(getItem(handle.db, chat.id)!).branch).toBeNull();
  });

  it("prefers the conversation's own repository when it has one", async () => {
    const chat = createTestItem(handle.db, { type: "feature", title: "Conversation", stepId: "discussion", workspaceId: repository.id });

    expect(await createWorktreeWorkspace(handle.db, worktreeRoot)(chat, "discussion")).toEqual(preparedFor(chat, repoPath));
  });
});

/**
 * The same thing a person can now choose (EO-296,
 * ARCHITECTURE.md, "The four kinds").
 *
 * Read mode was three behaviours EO decided for itself — an interpret
 * run, an off-board conversation, a container item — and it is a mode of
 * the git kind now, so a step that only reads the code to answer a
 * question can say so. Nothing about *what it gets* is new: the
 * repository as it stands, no branch, no worktree. What is new is that
 * it is a setting rather than a special case.
 */
describe("a step set to read only", () => {
  /** The step this fixture's items sit on, switched to "Reads only". */
  function readsOnly(stepId: string): void {
    updateStep(handle.db, stepId, { workspaceMode: "read" });
  }

  it("gets the repository as it stands, and no branch is cut", async () => {
    const story = createTestItem(handle.db, { type: "story", title: "Answer a question about the code", stepId: "todo", workspaceId: repository.id });
    readsOnly("todo");

    expect(await createWorktreeWorkspace(handle.db, worktreeRoot)(story, "implement")).toEqual(preparedFor(story, repoPath));
    expect(existsSync(worktreePathFor(story.key, worktreeRoot))).toBe(false);
    expect(gitStateOf(getItem(handle.db, story.id)!).branch).toBeNull();
    // Nor told Jira about one, which is the other half of what cutting a
    // branch does to an item.
    expect(pendingPushesForItem(handle.db, story.id, "jira")).toEqual([]);
  });

  it("cuts a branch again the moment the step is set back", async () => {
    // The setting is read on every preparation rather than remembered
    // from the first, so a step somebody switches is a step that changes
    // behaviour for the work already sitting on it.
    const story = createTestItem(handle.db, { type: "story", title: "Now it writes", stepId: "todo", workspaceId: repository.id });
    readsOnly("todo");
    await createWorktreeWorkspace(handle.db, worktreeRoot)(story, "implement");

    updateStep(handle.db, "todo", { workspaceMode: "isolated" });
    const prepared = await createWorktreeWorkspace(handle.db, worktreeRoot)(getItem(handle.db, story.id)!, "implement");

    expect(prepared).toEqual(preparedFor(story, worktreePathFor(story.key, worktreeRoot)));
    expect(gitStateOf(getItem(handle.db, story.id)!).branch).toBe(`eo/${story.key}`);
  });

  it("reads the repository for a reply to a parked run whatever the step says", async () => {
    // `interpret` is not work on the branch (EO-184), and the thing it is
    // most often dispatched over is a worktree that could not be cut —
    // so preparing one here would refuse the interpretation with the very
    // refusal it was sent to read.
    const story = createTestItem(handle.db, { type: "story", title: "Answer the escalation", stepId: "todo", workspaceId: repository.id });

    expect(await createWorktreeWorkspace(handle.db, worktreeRoot)(story, "interpret")).toEqual(preparedFor(story, repoPath));
    expect(existsSync(worktreePathFor(story.key, worktreeRoot))).toBe(false);
  });
});

/**
 * The index record and the checkout it describes go together (EO-174).
 *
 * An index lives inside the item's own worktree and is deleted with
 * it. Nothing removed the row that described it, so every finished
 * item left behind a note saying `ready` — with a revision and a
 * timestamp — about a directory that no longer existed, and the
 * settings panel offered a Refresh and a Rebuild on each one.
 */
describe("an index record dies with the worktree it describes", () => {
  /**
   * The note a finished build leaves behind: ready, at a revision, at a
   * path inside the checkout.
   *
   * The directory name is a stand-in on purpose. Where an
   * implementation puts an index inside a worktree is its own business,
   * and nothing in this file — or in the code it tests — reads that
   * path: the checkout is what is checked, and it is derived from the
   * item's key.
   */
  function noteFor(subject: Item) {
    return recordRepositoryIndex(handle.db, {
      workspaceId: subject.workspaceId!,
      itemId: subject.id,
      provider: "example",
      indexPath: join(worktreePathFor(subject.key, worktreeRoot), ".an-index"),
      status: "ready",
      providerVersion: "1.0.0",
    });
  }

  function notes(): string[] {
    return listRepositoryIndexes(handle.db).map((row) => row.itemId ?? "baseline");
  }

  it("forgets the note when a finished item lets go of its checkout", async () => {
    expect((await createWorktreeWorkspace(handle.db, worktreeRoot)(item, "implement")).ok).toBe(true);
    noteFor(item);

    expect((await releaseWorktreeFor(handle.db, item, worktreeRoot)).released).toBe(true);

    expect(existsSync(worktreePathFor(item.key, worktreeRoot))).toBe(false);
    expect(notes()).toEqual([]);
  });

  it("keeps the note when the release was refused, because the index is still there", async () => {
    const prepared = await createWorktreeWorkspace(handle.db, worktreeRoot)(item, "implement");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    noteFor(item);
    // Uncommitted work is the one thing a release never destroys, so
    // the checkout stays — and with it the index inside it. Forgetting
    // the note here would leave a real index nobody had a record of.
    writeFileSync(join(prepared.workspace.cwd, "half-done.txt"), "please do not delete me\n");

    expect((await releaseWorktreeFor(handle.db, item, worktreeRoot)).released).toBe(false);

    expect(notes()).toEqual([item.id]);
  });

  it("forgets the notes for the stale checkouts boot cleanup takes, and only those", async () => {
    // Finished, not merely quiet: since EO-177 the cleanup judges the
    // item's own position rather than the runs beside it, and a story
    // sitting on a non-terminal step keeps its checkout whatever its
    // runs are doing.
    const stale = createTestItem(handle.db, { type: "story", title: "Finished days ago", stepId: "ready_to_merge", workspaceId: repository.id });
    const working = createTestItem(handle.db, { type: "story", title: "Still going", stepId: "todo", workspaceId: repository.id });
    const config = { repoPath, baseBranch: "main", worktreeRoot };
    await createWorktree(config, stale.key);
    await createWorktree(config, working.key);
    noteFor(stale);
    noteFor(working);

    const summary = await releaseStaleWorktrees(handle.db, (key) => key === working.key, worktreeRoot);

    expect(summary.removed).toEqual([stale.key]);
    expect(notes()).toEqual([working.id]);
  });

  it("forgets the note when a person releases the checkout by hand", async () => {
    // The same rule through the Settings screen's own Release button.
    // `worktreeCommands.test.ts` drives that command; here it is the
    // shared release path both go through.
    expect((await createWorktreeWorkspace(handle.db, worktreeRoot)(item, "implement")).ok).toBe(true);
    noteFor(item);

    const removed = await releaseWorktree(handle.db, { repoPath, baseBranch: "main", worktreeRoot }, item.key, { deleteBranch: false });

    expect(removed.ok).toBe(true);
    expect(notes()).toEqual([]);
  });

  /**
   * The records already on disk when this rule arrived.
   *
   * Fifteen of them on one machine, three worktrees to go round. No
   * release that happens from now on removes one of those on its own,
   * so boot reconciliation has to.
   */
  describe("forgetIndexesForReleasedWorktrees", () => {
    it("forgets a note whose checkout is no longer on disk", async () => {
      // Exactly the shape the panel was full of: the build really
      // happened, in a worktree that has since been released.
      noteFor(item);
      expect(existsSync(worktreePathFor(item.key, worktreeRoot))).toBe(false);

      expect(forgetIndexesForReleasedWorktrees(handle.db, worktreeRoot)).toEqual([item.key]);
      expect(notes()).toEqual([]);
    });

    it("leaves a note whose checkout is still there, index or no index", async () => {
      // The conservative half. A checkout that is present with its
      // index missing is a rebuild away, and `resolveStatus` already
      // marks it stale — that row describes something real and this
      // sweep has no business deleting it.
      expect((await createWorktreeWorkspace(handle.db, worktreeRoot)(item, "implement")).ok).toBe(true);
      noteFor(item);

      expect(forgetIndexesForReleasedWorktrees(handle.db, worktreeRoot)).toEqual([]);
      expect(notes()).toEqual([item.id]);
    });

    it("leaves a repository's baseline note alone", () => {
      // `itemId` null describes the repository rather than a
      // worktree, so no missing checkout says anything about it.
      recordRepositoryIndex(handle.db, {
        workspaceId: repository.id,
        itemId: null,
        provider: "example",
        indexPath: join(repoPath, ".an-index"),
        status: "ready",
      });

      expect(forgetIndexesForReleasedWorktrees(handle.db, worktreeRoot)).toEqual([]);
      expect(notes()).toEqual(["baseline"]);
    });

    it("does nothing on a second pass, and nothing at all with no notes to read", () => {
      noteFor(item);

      expect(forgetIndexesForReleasedWorktrees(handle.db, worktreeRoot)).toEqual([item.key]);
      expect(forgetIndexesForReleasedWorktrees(handle.db, worktreeRoot)).toEqual([]);
    });
  });
});

describe("releaseStaleWorktrees", () => {
  it("removes worktrees with no active run and leaves the working ones alone", async () => {
    const config = { repoPath, baseBranch: "main", worktreeRoot };
    await createWorktree(config, "EO-100");
    await createWorktree(config, "EO-101");

    const summary = await releaseStaleWorktrees(handle.db, (key) => key === "EO-101", worktreeRoot);

    expect(summary.removed).toEqual(["EO-100"]);
    expect(existsSync(worktreePathFor("EO-100", worktreeRoot))).toBe(false);
    expect(existsSync(worktreePathFor("EO-101", worktreeRoot))).toBe(true); // still working
  });

  it("never destroys uncommitted work during boot cleanup — reports it instead", async () => {
    const config = { repoPath, baseBranch: "main", worktreeRoot };
    const created = await createWorktree(config, "EO-102");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // What a crashed run leaves behind: an agent's half-finished edit.
    writeFileSync(join(created.value.path, "half-done.txt"), "please do not delete me\n");

    const summary = await releaseStaleWorktrees(handle.db, () => false, worktreeRoot);

    expect(summary.removed).toEqual([]);
    expect(summary.keptWithChanges).toEqual(["EO-102"]);
    expect(summary.removalFailed).toEqual([]);
    expect(existsSync(join(created.value.path, "half-done.txt"))).toBe(true);
  });

  // Issue #131: on Windows a `git worktree remove` that hits the path
  // limit used to be filed as "kept because it holds uncommitted work",
  // which is a different situation with a different remedy and sends
  // the reader looking for changes that were never there.
  it("files a removal it could not carry out as a failure, not as unsaved work", async () => {
    const config = { repoPath, baseBranch: "main", worktreeRoot };
    const created = await createWorktree(config, "EO-103");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // A worktree git refuses to remove and whose status it cannot read
    // either — the same reproducible stand-in worktrees.test.ts uses for
    // the Windows failure, which is not reproducible anywhere else.
    rmSync(join(created.value.path, ".git"));

    const summary = await releaseStaleWorktrees(handle.db, () => false, worktreeRoot);

    expect(summary.removed).toEqual([]);
    expect(summary.keptWithChanges).toEqual([]);
    expect(summary.removalFailed.map((entry) => entry.itemKey)).toEqual(["EO-103"]);
    // Carrying why, so whoever reads the log has something to act on.
    expect(summary.removalFailed[0]?.reason).toContain("Could not remove the worktree for EO-103");
    expect(existsSync(created.value.path)).toBe(true);
  });

  it("does nothing when no workspace is configured", async () => {
    const summary = await releaseStaleWorktrees(handle.db, () => false, worktreeRoot);
    expect(summary).toEqual({ removed: [], keptWithChanges: [], removalFailed: [] });
  });

  /**
   * What "stale" has to mean now that this runs somewhere other than
   * boot (EO-177).
   *
   * `reconcile()` fires on engine resume as well as on app start, and an
   * item parked between the implementer and the reviewer has no active
   * run — so pressing Pause and then Resume mid-item destroyed that
   * item's checkout and, with it, the index record that goes when a
   * checkout genuinely goes. E-04 wrote this for crash debris at boot,
   * where "no active run" and "abandoned" were the same set. They are
   * not the same set here.
   */
  describe("an item that is still moving through the pipeline", () => {
    it("keeps its checkout when the engine is resumed mid-item", async () => {
      const live = createTestItem(handle.db, { type: "story", title: "Between two steps", stepId: "review", workspaceId: repository.id });
      await createWorktree({ repoPath, baseBranch: "main", worktreeRoot }, live.key);

      // Nothing is running: exactly what a paused engine looks like, and
      // what a crashed one used to be indistinguishable from.
      const summary = await releaseStaleWorktrees(handle.db, () => false, worktreeRoot);

      expect(summary).toEqual({ removed: [], keptWithChanges: [], removalFailed: [] });
      expect(existsSync(worktreePathFor(live.key, worktreeRoot))).toBe(true);
    });

    it("keeps the index record that would have gone with it", async () => {
      // The consequence the story is actually about. The record is
      // correctly forgotten when a checkout is released — that is EO-174
      // and it still holds — so the fix is to stop releasing a live
      // item's checkout, not to stop forgetting.
      const live = createTestItem(handle.db, { type: "story", title: "Indexed and waiting", stepId: "review", workspaceId: repository.id });
      await createWorktree({ repoPath, baseBranch: "main", worktreeRoot }, live.key);
      recordRepositoryIndex(handle.db, {
        workspaceId: live.workspaceId!,
        itemId: live.id,
        provider: "example",
        indexPath: join(worktreePathFor(live.key, worktreeRoot), ".an-index"),
        status: "ready",
        providerVersion: "1.0.0",
      });

      await releaseStaleWorktrees(handle.db, () => false, worktreeRoot);

      expect(listRepositoryIndexes(handle.db).map((row) => row.itemId)).toEqual([live.id]);
    });

    it("still takes the checkout once the item has finished", async () => {
      const done = createTestItem(handle.db, { type: "story", title: "Merged", stepId: "ready_to_merge", workspaceId: repository.id });
      await createWorktree({ repoPath, baseBranch: "main", worktreeRoot }, done.key);

      const summary = await releaseStaleWorktrees(handle.db, () => false, worktreeRoot);

      expect(summary.removed).toEqual([done.key]);
      expect(existsSync(worktreePathFor(done.key, worktreeRoot))).toBe(false);
    });

    it("still takes a checkout with no item behind it at all", async () => {
      // A deleted item, or a directory from a database that has since
      // been replaced. Nothing will ever be dispatched into it.
      await createWorktree({ repoPath, baseBranch: "main", worktreeRoot }, "EO-999");

      const summary = await releaseStaleWorktrees(handle.db, () => false, worktreeRoot);

      expect(summary.removed).toEqual(["EO-999"]);
    });
  });
});

describe("releasing a worktree when its item finishes (G-03)", () => {
  /** The engine's own wiring: onItemSettled -> releaseWorktreeFor. */
  function supervisorWithRelease() {
    return createRunSupervisor({
      db: handle.db,
      // Each action answered with something its own schema accepts, and
      // the real role wiring, because review -> ready_to_merge is the
      // reviewer's verdict rather than the next pipeline position.
      provider: createScriptedProvider([
        { when: (context) => context.includes(`"review" action`), script: { result: { verdict: "approve", feedback: "LGTM", blocking_issues: [] } } },
        { when: () => true, script: { result: validImplementResult } },
      ]),
      builtins: BUILTIN_RUNNERS,
      ...createRoleWiring(handle.db),
      kinds: installedKinds(
        fakeWorkspaceKind({
          prepare: createWorktreeWorkspace(handle.db, worktreeRoot),
          release: async (request) => {
            if (request.what !== "settled") return {};
            const outcome = await releaseWorktreeFor(handle.db, request.item, worktreeRoot);
            return "reason" in outcome ? { keptReason: outcome.reason } : {};
          },
        }),
      ),
      limits: { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 },
    });
  }

  it("releases the worktree without waiting for a relaunch, keeping the branch", async () => {
    const done = createTestItem(handle.db, { type: "story", title: "Nearly done", stepId: "review", workspaceId: repository.id, spec: REVIEWABLE_SPEC });

    // review -> merge request -> ready_to_merge, which the seeded pipeline
    // marks terminal. Two ticks now: opening the pull request is a step of
    // its own rather than something arriving used to trigger.
    const supervisor = supervisorWithRelease();
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(getItem(handle.db, done.id)?.stepId).toBe("ready_to_merge");
    expect(existsSync(worktreePathFor(done.key, worktreeRoot))).toBe(false);
    // The branch is the deliverable and outlives the checkout.
    expect(await branchExists(repoPath, `eo/${done.key}`)).toBe(true);
  });

  it("leaves a mid-pipeline item's worktree alone", async () => {

    // `item` is in todo: it moves to review, which is not terminal, and
    // its next run needs the same checkout.
    await supervisorWithRelease().runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
    expect(existsSync(worktreePathFor(item.key, worktreeRoot))).toBe(true);
  });

  it("keeps a tree holding uncommitted work and says why on the item", async () => {
    const done = createTestItem(handle.db, { type: "story", title: "Messy", stepId: "review", workspaceId: repository.id, spec: REVIEWABLE_SPEC });
    const created = await createWorktree({ repoPath, baseBranch: "main", worktreeRoot }, done.key);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "uncommitted.txt"), "never committed\n");

    const supervisor = supervisorWithRelease();
    await supervisor.runOnce(); // review -> merge request
    await supervisor.runOnce(); // merge request -> terminal, which releases

    expect(existsSync(join(created.value.path, "uncommitted.txt"))).toBe(true); // the only copy
    const posted = handle.db.select().from(comments).all();
    const note = posted.find((comment) => comment.authorType === "engine" && comment.body.includes("uncommitted"));
    expect(note, "the ticket says why the workspace was kept").toBeDefined();
  });

  it("a released item can still be dispatched again", async () => {
    // The failure mode that made releasing dangerous: cleanup keeps the
    // branch, and ensureWorktree used to refuse anything whose branch
    // already existed, so a released item could never move again.
    const done = createTestItem(handle.db, { type: "story", title: "Reopened", stepId: "review", workspaceId: repository.id, spec: REVIEWABLE_SPEC });

    const releasing = supervisorWithRelease();
    await releasing.runOnce(); // review -> merge request
    await releasing.runOnce(); // merge request -> terminal
    expect(existsSync(worktreePathFor(done.key, worktreeRoot))).toBe(false);

    // A human sends it back — exactly what the project's drag-and-drop does.
    transitionItem(handle.db, { itemId: done.id, toStepId: "todo", actor: "human", reason: "moved on the project" });

    // Ticked until nothing changes rather than a fixed count: one tick
    // sometimes chains a second dispatch and sometimes doesn't, and this
    // test is about the item being able to finish, not about how many
    // ticks that takes.
    const supervisor = supervisorWithRelease();
    for (let i = 0; i < 8 && getItem(handle.db, done.id)?.stepId !== "ready_to_merge"; i++) {
      await supervisor.runOnce();
    }

    // It picked the branch back up and worked in it: before the
    // re-attach existed this dispatch was refused outright with "the
    // branch eo/<KEY> already exists", and the item was stuck for good.
    //
    // Asserted before the state, and quoting the reason: a refused
    // dispatch parks the run in `awaiting_input`, so checking the run
    // status first would report "expected awaiting_input to be
    // succeeded" and say nothing about why. Every guard ends in a
    // comment (invariant #8), which makes the reason available here.
    //
    // Still every engine comment rather than a list of guard kinds, so a
    // refusal nobody has thought of yet still fails this — minus the
    // review census (EO-200), which EO posts on every approval and which
    // is by construction not a refusal.
    const engineSays = handle.db
      .select()
      .from(comments)
      .all()
      .filter((comment) => comment.authorType === "engine" && !comment.body.startsWith("**Review census.**"))
      .map((comment) => comment.body);
    expect(engineSays, "no dispatch should have been refused").toEqual([]);

    expect(getItem(handle.db, done.id)?.stepId).toBe("ready_to_merge");
    expect(listRunsForItem(handle.db, done.id).at(-1)?.status).toBe("succeeded");
  });
});

/**
 * A base branch set on the ticket (EO-364): the branch is cut from the
 * remote's copy of it, the progress line says so, it beats stacking on
 * an unmerged dependency, and a base the remote does not have is refused
 * before anything is created.
 */
describe("a base branch set on the ticket", () => {
  /** A remote holding `main` and a `release/2.4` the local checkout has never fetched. */
  async function remoteWithRelease(): Promise<void> {
    const remotePath = join(scratch, "the remote.git");
    await run(["init", "--bare", "-b", "main", remotePath], scratch);
    await run(["remote", "add", "origin", remotePath], repoPath);
    await run(["push", "-u", "origin", "main"], repoPath);

    const clone = join(scratch, "some other clone");
    await run(["clone", remotePath, clone], scratch);
    await run(["config", "user.email", "other@example.com"], clone);
    await run(["config", "user.name", "Someone Else"], clone);
    await run(["config", "commit.gpgsign", "false"], clone);
    await run(["config", "tag.gpgsign", "false"], clone);
    await run(["checkout", "-b", "release/2.4"], clone);
    writeFileSync(join(clone, "release-only.txt"), "only on the release branch\n");
    await run(["add", "-A"], clone);
    await run(["commit", "-m", "release work"], clone);
    await run(["push", "origin", "release/2.4"], clone);
  }

  it("cuts the ticket's branch from the remote's copy of that base, and says so", async () => {
    await remoteWithRelease();
    const named = createTestItem(handle.db, { type: "story", title: "On the release", stepId: "todo", workspaceId: repository.id, git: { baseBranch: "release/2.4" } });
    const progress: string[] = [];

    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(named, "create_worktree", { onProgress: (line) => progress.push(line) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(result.workspace.cwd, "release-only.txt"))).toBe(true);
    // Never fetched into a local branch of that name: EO read the remote.
    expect(await branchExists(repoPath, "release/2.4")).toBe(false);
    expect(progress.some((line) => line.includes("release/2.4") && line.includes("base branch set on this ticket"))).toBe(true);
    // The base stays on the ticket beside the branch it started.
    expect(gitStateOf(getItem(handle.db, named.id)!)).toEqual({ branch: `eo/${named.key}`, pullRequest: null, baseBranch: "release/2.4", namedBranch: false, attachedAt: null, reference: null, reviewers: null });
  });

  it("wins over an unmerged same-feature dependency it would otherwise stack on", async () => {
    await remoteWithRelease();
    updateWorkspace(handle.db, repository.id, { config: { forgeKind: "github" } });
    const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
    const common = { type: "story" as const, stepId: "todo", workspaceId: repository.id, parentId: feature.id };
    const dependency = createTestItem(handle.db, { ...common, title: "Dependency", git: { branch: "eo/EO-dep" } });
    const named = createTestItem(handle.db, { ...common, title: "Dependent", git: { baseBranch: "release/2.4" } });
    addDependency(handle.db, named.id, dependency.id);
    const progress: string[] = [];

    const prepare = createWorktreeWorkspace(handle.db, worktreeRoot, forgeRunnerFor({ "eo/EO-dep": "OPEN" }));
    const result = await prepare(named, "create_worktree", { onProgress: (line) => progress.push(line) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(result.workspace.cwd, "release-only.txt"))).toBe(true);
    expect(progress.some((line) => line.includes("release/2.4"))).toBe(true);
    expect(progress.some((line) => line.includes("Stacking on"))).toBe(false);
  });

  it("refuses, naming the branch and the remote, and creates no branch or worktree when the remote does not have it", async () => {
    await remoteWithRelease();
    const named = createTestItem(handle.db, { type: "story", title: "Typo", stepId: "todo", workspaceId: repository.id, git: { baseBranch: "release/9.9" } });

    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(named, "create_worktree");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("release/9.9");
    expect(result.reason).toContain("origin");
    expect(existsSync(worktreePathFor(named.key, worktreeRoot))).toBe(false);
    expect(await branchExists(repoPath, `eo/${named.key}`)).toBe(false);
    expect(gitStateOf(getItem(handle.db, named.id)!).branch).toBeNull();
  });

  it("refuses a base deleted upstream after it was fetched, rather than cutting from the stale copy", async () => {
    await remoteWithRelease();
    // Fetched once, so `origin/release/2.4` is a tracking ref here…
    await run(["fetch", "origin", "release/2.4:refs/remotes/origin/release/2.4"], repoPath);
    // …and then deleted on the remote itself, as somebody else's cleanup
    // would. (A push --delete from here would take the tracking ref with
    // it, which is the case that never went wrong.)
    await run(["branch", "-D", "release/2.4"], join(scratch, "the remote.git"));
    expect((await git(["rev-parse", "--verify", "origin/release/2.4"], repoPath)).ok).toBe(true);
    const named = createTestItem(handle.db, { type: "story", title: "Deleted base", stepId: "todo", workspaceId: repository.id, git: { baseBranch: "release/2.4" } });

    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(named, "create_worktree");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("release/2.4");
    expect(result.reason).toContain("origin");
    expect(existsSync(worktreePathFor(named.key, worktreeRoot))).toBe(false);
    expect(await branchExists(repoPath, `eo/${named.key}`)).toBe(false);
    expect(gitStateOf(getItem(handle.db, named.id)!).branch).toBeNull();
  });

  it("cuts from the remote's current tip when a restricted fetch refspec left the tracking ref stale", async () => {
    await remoteWithRelease();
    // Fetched once into a tracking ref, then the remote is configured to
    // fetch only `main`.
    await run(["fetch", "origin", "release/2.4:refs/remotes/origin/release/2.4"], repoPath);
    await run(["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"], repoPath);
    // The release branch moves on upstream after that.
    const clone = join(scratch, "some other clone");
    await run(["checkout", "release/2.4"], clone);
    writeFileSync(join(clone, "release-fix.txt"), "landed on the release after EO last looked\n");
    await run(["add", "-A"], clone);
    await run(["commit", "-m", "release fix"], clone);
    await run(["push", "origin", "release/2.4"], clone);
    const named = createTestItem(handle.db, { type: "story", title: "On the release", stepId: "todo", workspaceId: repository.id, git: { baseBranch: "release/2.4" } });

    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(named, "create_worktree");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The stale tracking ref has the release's first commit but not the fix.
    expect(existsSync(join(result.workspace.cwd, "release-only.txt"))).toBe(true);
    expect(existsSync(join(result.workspace.cwd, "release-fix.txt"))).toBe(true);
  });

  it("refuses when the repository has no such remote, even with a local branch of that name, and creates nothing", async () => {
    // No remote at all, and a local `release/2.4` sitting right there —
    // the branch EO must not quietly cut from.
    await run(["branch", "release/2.4", "main"], repoPath);
    const named = createTestItem(handle.db, { type: "story", title: "No remote", stepId: "todo", workspaceId: repository.id, git: { baseBranch: "release/2.4" } });

    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(named, "create_worktree");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("`release/2.4`");
    expect(result.reason).toContain("`origin`");
    expect(existsSync(worktreePathFor(named.key, worktreeRoot))).toBe(false);
    expect(await branchExists(repoPath, `eo/${named.key}`)).toBe(false);
    expect(gitStateOf(getItem(handle.db, named.id)!).branch).toBeNull();
  });

  it("refuses when the configured remote is named something this repository does not have", async () => {
    await remoteWithRelease();
    await run(["branch", "release/2.4", "origin/main"], repoPath);
    updateWorkspace(handle.db, repository.id, { config: { forgeRemote: "upstream" } });
    const named = createTestItem(handle.db, { type: "story", title: "Wrong remote", stepId: "todo", workspaceId: repository.id, git: { baseBranch: "release/2.4" } });

    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(named, "create_worktree");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("`release/2.4`");
    expect(result.reason).toContain("`upstream`");
    expect(existsSync(worktreePathFor(named.key, worktreeRoot))).toBe(false);
    expect(await branchExists(repoPath, `eo/${named.key}`)).toBe(false);
  });

  it("still uses the local base branch with no remote when no base is set on the ticket", async () => {
    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(item, "create_worktree");

    expect(result.ok).toBe(true);
  });

  it("still comes off the repository's base when no base is set", async () => {
    await remoteWithRelease();
    const progress: string[] = [];

    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(item, "create_worktree", { onProgress: (line) => progress.push(line) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(result.workspace.cwd, "release-only.txt"))).toBe(false);
    expect(progress).toContain("Nothing to stack on, so this comes off main.");
  });
});

/**
 * An existing branch named on the ticket (EO-365): checked out with its
 * commits, never created or renamed, refused clearly when it is missing
 * or held by another working copy, and never deleted on release.
 */
describe("an existing branch named on the ticket", () => {
  /** A local `feature/limits` carrying a commit `main` does not have, with the repository back on `main`. */
  async function localBranchWithWork(): Promise<string> {
    await run(["checkout", "-b", "feature/limits"], repoPath);
    writeFileSync(join(repoPath, "limits.txt"), "started by hand\n");
    await run(["add", "-A"], repoPath);
    await run(["commit", "-m", "the person's own start"], repoPath);
    await run(["checkout", "main"], repoPath);
    const tip = await git(["rev-parse", "feature/limits"], repoPath);
    return tip.ok ? tip.stdout : "";
  }

  const namedItem = (branch: string) =>
    createTestItem(handle.db, { type: "story", title: "On their branch", stepId: "todo", workspaceId: repository.id, git: { branch, namedBranch: true } });

  it("checks out a local branch with its commits, creates no branch of its own, and records where it stood", async () => {
    const tip = await localBranchWithWork();
    const named = namedItem("feature/limits");

    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(named, "create_worktree");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.cwd).toBe(worktreePathFor(named.key, worktreeRoot));
    expect(existsSync(join(result.workspace.cwd, "limits.txt"))).toBe(true);
    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], result.workspace.cwd);
    expect(head.ok && head.stdout).toBe("feature/limits");
    expect(await branchExists(repoPath, `eo/${named.key}`)).toBe(false);
    expect(gitStateOf(getItem(handle.db, named.id)!)).toEqual({ branch: "feature/limits", pullRequest: null, baseBranch: null, namedBranch: true, attachedAt: tip, reference: null, reviewers: null });
  });

  it("keeps the first attachment's commit across a second dispatch", async () => {
    const tip = await localBranchWithWork();
    const named = namedItem("feature/limits");
    const prepare = createWorktreeWorkspace(handle.db, worktreeRoot);
    const first = await prepare(named, "create_worktree");
    if (!first.ok) throw new Error(first.reason);
    writeFileSync(join(first.workspace.cwd, "agent.txt"), "the agent's work\n");
    await run(["add", "-A"], first.workspace.cwd);
    await run(["commit", "-m", "agent"], first.workspace.cwd);

    const second = await prepare(getItem(handle.db, named.id)!, "implement");

    expect(second.ok).toBe(true);
    expect(gitStateOf(getItem(handle.db, named.id)!).attachedAt).toBe(tip);
  });

  it("checks out a branch only the remote has, under the same name and with its commits", async () => {
    const remotePath = join(scratch, "the remote.git");
    await run(["init", "--bare", "-b", "main", remotePath], scratch);
    await run(["remote", "add", "origin", remotePath], repoPath);
    await run(["push", "-u", "origin", "main"], repoPath);
    await localBranchWithWork();
    await run(["push", "origin", "feature/limits"], repoPath);
    await run(["branch", "-D", "feature/limits"], repoPath);
    const named = namedItem("feature/limits");

    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(named, "create_worktree");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(result.workspace.cwd, "limits.txt"))).toBe(true);
    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], result.workspace.cwd);
    expect(head.ok && head.stdout).toBe("feature/limits");
    const upstream = await git(["rev-parse", "--abbrev-ref", "feature/limits@{upstream}"], repoPath);
    expect(upstream.ok && upstream.stdout).toBe("origin/feature/limits");
    expect(await branchExists(repoPath, `eo/${named.key}`)).toBe(false);
  });

  it("checks a remote-only branch out at its tip when the remote's fetch refspec covers only main", async () => {
    const remotePath = join(scratch, "the remote.git");
    await run(["init", "--bare", "-b", "main", remotePath], scratch);
    await run(["remote", "add", "origin", remotePath], repoPath);
    await run(["push", "-u", "origin", "main"], repoPath);
    const tip = await localBranchWithWork();
    await run(["push", "origin", "feature/limits"], repoPath);
    await run(["branch", "-D", "feature/limits"], repoPath);
    await run(["update-ref", "-d", "refs/remotes/origin/feature/limits"], repoPath);
    // git refuses `--track` from a tracking ref no configured refspec maps to.
    await run(["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"], repoPath);
    const named = namedItem("feature/limits");

    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(named, "create_worktree");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const head = await git(["rev-parse", "HEAD"], result.workspace.cwd);
    expect(head.ok && head.stdout).toBe(tip);
    const branchName = await git(["rev-parse", "--abbrev-ref", "HEAD"], result.workspace.cwd);
    expect(branchName.ok && branchName.stdout).toBe("feature/limits");
    expect(gitStateOf(getItem(handle.db, named.id)!).attachedAt).toBe(tip);
  });

  it("checks a remote-only branch out at its own tip when another fetch lands while it is being resolved (EO-755)", async () => {
    const remotePath = join(scratch, "the remote.git");
    await run(["init", "--bare", "-b", "main", remotePath], scratch);
    await run(["remote", "add", "origin", remotePath], repoPath);
    await run(["push", "-u", "origin", "main"], repoPath);
    const tip = await localBranchWithWork();
    await run(["push", "origin", "feature/limits"], repoPath);
    await run(["branch", "-D", "feature/limits"], repoPath);
    // `main` moves on after the branch was cut, as it had on EO-747.
    writeFileSync(join(repoPath, "main-only.txt"), "landed on main later\n");
    await run(["add", "-A"], repoPath);
    await run(["commit", "-m", "later on main"], repoPath);
    await run(["push", "origin", "main"], repoPath);
    const mainTip = await git(["rev-parse", "main"], repoPath);
    const named = namedItem("feature/limits");

    // Another item's builtin step fetches `main` in the same repository
    // the moment this one's fetch of the named branch returns — before
    // `resolveRemoteRef` has answered — and so rewrites `FETCH_HEAD`.
    const gitModule = await import("./git.js");
    const realFetchBranch = gitModule.fetchBranch;
    let interleaved = false;
    vi.spyOn(gitModule, "fetchBranch").mockImplementation(async (path, remote, branch, options) => {
      const fetched = await realFetchBranch(path, remote, branch, options);
      if (branch === "feature/limits") {
        await run(["fetch", "origin", "main"], repoPath);
        interleaved = true;
      }
      return fetched;
    });

    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(named, "create_worktree");

    vi.restoreAllMocks();
    expect(interleaved).toBe(true);
    const fetchHead = await git(["rev-parse", "FETCH_HEAD"], repoPath);
    expect(fetchHead.ok && fetchHead.stdout).toBe(mainTip.ok && mainTip.stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const head = await git(["rev-parse", "HEAD"], result.workspace.cwd);
    expect(head.ok && head.stdout).toBe(tip);
    expect(existsSync(join(result.workspace.cwd, "main-only.txt"))).toBe(false);
    expect(gitStateOf(getItem(handle.db, named.id)!).attachedAt).toBe(tip);
  });

  it("refuses, naming the branch, and creates nothing when it exists neither locally nor on the remote", async () => {
    const remotePath = join(scratch, "the remote.git");
    await run(["init", "--bare", "-b", "main", remotePath], scratch);
    await run(["remote", "add", "origin", remotePath], repoPath);
    await run(["push", "-u", "origin", "main"], repoPath);
    const named = namedItem("feature/nowhere");

    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(named, "create_worktree");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("feature/nowhere");
    expect(result.reason).toContain("origin");
    expect(existsSync(worktreePathFor(named.key, worktreeRoot))).toBe(false);
    expect(await branchExists(repoPath, "feature/nowhere")).toBe(false);
    expect(await branchExists(repoPath, `eo/${named.key}`)).toBe(false);
    expect(gitStateOf(getItem(handle.db, named.id)!).attachedAt).toBeNull();
  });

  it("refuses the same way in a repository with no remote at all", async () => {
    const named = namedItem("feature/nowhere");

    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(named, "create_worktree");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("feature/nowhere");
    expect(await branchExists(repoPath, "feature/nowhere")).toBe(false);
    expect(existsSync(worktreePathFor(named.key, worktreeRoot))).toBe(false);
  });

  it("refuses, naming the path, when the branch is checked out in the repository's own working copy, and leaves that checkout alone", async () => {
    await localBranchWithWork();
    await run(["checkout", "feature/limits"], repoPath);
    writeFileSync(join(repoPath, "half-done.txt"), "the person's uncommitted work\n");
    const named = namedItem("feature/limits");

    const result = await createWorktreeWorkspace(handle.db, worktreeRoot)(named, "create_worktree");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("feature/limits");
    // git names the checkout by its long path; on Windows `tmpdir()` hands
    // back the 8.3 short one (`RUNNER~1`), which only `.native` expands.
    expect(result.reason).toContain(realpathSync.native(repoPath));
    expect(existsSync(worktreePathFor(named.key, worktreeRoot))).toBe(false);
    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
    expect(head.ok && head.stdout).toBe("feature/limits");
    expect(existsSync(join(repoPath, "half-done.txt"))).toBe(true);
    expect(gitStateOf(getItem(handle.db, named.id)!).attachedAt).toBeNull();
  });

  it("never deletes the branch when the worktree is released, even when asked to delete branches", async () => {
    await localBranchWithWork();
    const named = namedItem("feature/limits");
    const prepared = await createWorktreeWorkspace(handle.db, worktreeRoot)(named, "create_worktree");
    expect(prepared.ok).toBe(true);

    const removed = await releaseWorktree(handle.db, { repoPath, baseBranch: "main", worktreeRoot }, named.key, { deleteBranch: true });

    expect(removed.ok).toBe(true);
    expect(existsSync(worktreePathFor(named.key, worktreeRoot))).toBe(false);
    expect(await branchExists(repoPath, "feature/limits")).toBe(true);
  });

  it("is released when its ticket finishes, though its branch carries no EO prefix, and the branch stays", async () => {
    await localBranchWithWork();
    const named = namedItem("feature/limits");
    const prepared = await createWorktreeWorkspace(handle.db, worktreeRoot)(named, "create_worktree");
    expect(prepared.ok).toBe(true);
    transitionItem(handle.db, { itemId: named.id, toStepId: "ready_to_merge", actor: "human", reason: "merged" });

    const summary = await releaseStaleWorktrees(handle.db, () => false, worktreeRoot);

    expect(summary.removed).toContain(named.key);
    expect(await branchExists(repoPath, "feature/limits")).toBe(true);
  });
});
