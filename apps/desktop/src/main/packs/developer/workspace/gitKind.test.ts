import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { verificationLine, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../../db/client.js";
import { AttachmentStorage } from "../../../attachments/storage.js";
import { createRun, getItem, listAgents, listCommentsForItem, updateWorkspace, type Workspace } from "../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import { describesChecks, verifyRun, type PreparedWorkspace, type VerifiableRun, type WorkspaceKind } from "../../../supervisor/workspaceKind.js";
// @ts-expect-error — the service is plain JavaScript, deliberately: it ships
// unbundled because Codex spawns it by path.
import * as eoServer from "../../../mcp/eoServer.mjs";
import { attachRunFiles, checkRunFile, type RunFileCheck } from "../../../supervisor/runAttachments.js";
import { run, status } from "../../../testing/git.js";
import { setBranchPrefix } from "./branchPrefix.js";
import { releaseWorktreeFor } from "./dispatchWorkspace.js";
import { gitWorkspaceKind } from "./gitKind.js";
import { TICKET_FILES_DIRECTORY } from "./ticketFiles.js";

/**
 * The git kind, asked the two questions the interface added (EO-295,
 * ARCHITECTURE.md, "The interface").
 *
 * `prepare`, `attach` and `release` are the same three functions this
 * directory has always had, and the tests that cover them are the ones
 * that always did — `dispatchWorkspace.test.ts`, `agentDelivery.test.ts`,
 * `planMode.test.ts`. What is genuinely new is the *shape* of the other
 * two: verification is a list of checks rather than a verdict, and a run
 * has artifacts. So this file asks those two of a real worktree.
 */
let scratch: string;
let repoPath: string;
let worktreeRoot: string;
let handle: DbHandle;
let workspace: Workspace;
let item: Item;

function kind(): WorkspaceKind {
  return gitWorkspaceKind({ db: handle.db, worktreeRoot, intelligenceFor: () => null, verifyOptions: { timeoutMs: 15_000 } });
}

/** The run as the supervisor describes it at the moment a check is asked for. */
function succeededImplement(prepared: PreparedWorkspace): VerifiableRun {
  return { id: "01a0" as never, action: "implement", workspace: prepared, result: { summary: "Did it." }, ended: "succeeded" };
}

/** The worktree this item would be dispatched into, cut for real. */
async function preparedWorktree(): Promise<PreparedWorkspace> {
  const outcome = await kind().prepare(item, "implement");
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.workspace;
}

async function commitInTheWorktree(prepared: PreparedWorkspace, contents = "the work\n"): Promise<void> {
  writeFileSync(join(prepared.cwd, "feature.txt"), contents);
  await run(["add", "-A"], prepared.cwd);
  await run(["commit", "-m", "agent work"], prepared.cwd);
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo git kind test "));
  repoPath = join(scratch, "the repo");
  worktreeRoot = join(scratch, "work trees");
  mkdirSync(repoPath, { recursive: true });
  await run(["init", "-b", "main"], repoPath);
  await run(["config", "user.email", "eo@example.com"], repoPath);
  await run(["config", "user.name", "EO Test"], repoPath);
  // Hermetic, for `implementationVerifier.test.ts`'s reason: a machine
  // that signs commits globally must not decide whether this passes.
  await run(["config", "commit.gpgsign", "false"], repoPath);
  await run(["config", "tag.gpgsign", "false"], repoPath);
  writeFileSync(join(repoPath, "README.md"), "# fixture\n");
  await run(["add", "-A"], repoPath);
  await run(["commit", "-m", "initial"], repoPath);

  handle = openMigratedTestDb();
  setBranchPrefix(handle.db, "eo");
  workspace = attachWorkspace(handle.db, { name: "the repo", keyPrefix: "EO", repoPath, baseBranch: "main" });
  item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: workspace.id });
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("verify, after an implement run", () => {
  it("answers with three checks, each naming what it checked", async () => {
    updateWorkspace(handle.db, workspace.id, { config: { testCommand: `node -e ""` } });
    const prepared = await preparedWorktree();
    await commitInTheWorktree(prepared);

    const checks = await verifyRun(kind(), getItem(handle.db, item.id)!, succeededImplement(prepared));

    expect(checks.map((check) => check.key)).toEqual(["implementation", "clean-tree", "borrowed-files"]);
    expect(checks.every((check) => check.passed)).toBe(true);
    // Each sentence names its own subject, so that a column head
    // assembled out of them reads as three statements rather than three
    // ticks (ARCHITECTURE.md, "What 'EO checks' means on a step").
    const [implementation, clean, borrowed] = checks;
    expect(implementation?.describes).toContain("branch");
    expect(implementation?.describes).toContain("test"); // the commands it actually ran are named
    expect(clean?.describes).toContain("uncommitted");
    expect(clean?.describes).toContain(item.key);
    expect(borrowed?.describes).toContain("byte-identical");
    // Only the mechanical verification can stop a run; the other two
    // report on work that stands.
    expect(checks.map((check) => check.blocks === true)).toEqual([true, false, false]);
  });

  it("keeps the account of every step it ran as the check's evidence", async () => {
    updateWorkspace(handle.db, workspace.id, { config: { testCommand: `node -e ""` } });
    const prepared = await preparedWorktree();
    await commitInTheWorktree(prepared);

    const [implementation] = await verifyRun(kind(), getItem(handle.db, item.id)!, succeededImplement(prepared));

    // The same object `runs.verification` has always held: the steps,
    // their details, and what each one printed.
    expect((implementation?.evidence as { ok?: boolean } | undefined)?.ok).toBe(true);
    expect((implementation?.evidence as { steps?: { name: string }[] } | undefined)?.steps?.map((step) => step.name)).toContain("clean");
  });

  it("stops at the failing one, because the rest describe a tree that is not worth describing", async () => {
    // Nothing committed: the run claimed success and the branch is empty.
    const prepared = await preparedWorktree();
    writeFileSync(join(prepared.cwd, "feature.txt"), "written but never committed\n");

    const checks = await verifyRun(kind(), getItem(handle.db, item.id)!, succeededImplement(prepared));

    expect(checks).toHaveLength(1);
    expect(checks[0]?.key).toBe("implementation");
    expect(checks[0]?.passed).toBe(false);
    expect(checks[0]?.blocks).toBe(true);
    expect(checks[0]?.describes).toContain("nothing was committed");
    // The long form is what the next attempt reads (E-06); the sentence
    // is what the run row carries.
    expect(checks[0]?.comment).toContain(item.key);
  });

  it("adds a blocking check of the commit messages when a Reference names the work (EO-768)", async () => {
    const named = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: workspace.id, git: { reference: "PROJ-1" } });
    const outcome = await kind().prepare(named, "implement");
    if (!outcome.ok) throw new Error(outcome.reason);
    writeFileSync(join(outcome.workspace.cwd, "feature.txt"), "the work\n");
    await run(["add", "-A"], outcome.workspace.cwd);
    await run(["commit", "-m", `${named.key}: the work`], outcome.workspace.cwd);

    const checks = await verifyRun(kind(), getItem(handle.db, named.id)!, succeededImplement(outcome.workspace));

    expect(checks.map((check) => check.key)).toEqual(["implementation", "clean-tree", "borrowed-files", "commit-naming"]);
    const naming = checks[3];
    expect(naming).toMatchObject({ passed: false, blocks: true });
    expect(naming?.comment).toContain(`${named.key}: the work — names ${named.key}`);
  });

  /**
   * What the column head says this kind checks (EO-312, ARCHITECTURE.md, "What 'EO checks' means on
   * a step").
   *
   * The acceptance criterion as a snapshot: the sentences on the head
   * are exactly the `describes` of the verifier registered for the
   * step's action, joined. A check added to `implement` without a word
   * said about it is what this notices — invariant 5 is "verify where
   * you can, and *say what you checked*", and a head that had gone stale
   * would be the second half quietly untrue.
   */
  it("says what it checks, in the words a column head shows", () => {
    // A branch is checked by the same three things wherever the step is
    // put, so this kind ignores the step it is asked about — unlike the
    // folder kind, which reads the files the step declares.
    const step = (entryAction: string) => ({ id: "todo", entryAction, inputs: {} });

    expect(verificationLine({ id: "todo", type: "agent" }, [
      { stepId: "todo", checks: [...describesChecks(kind(), step("implement"))], verifiesAction: true, kindVerifies: true, waitsOn: null },
    ])).toMatchInlineSnapshot(`"EO checks: commits, tests ran, the tree is clean, nothing borrowed from another ticket, commit messages name only the Reference"`);

    // And nothing to say about an action it does not check, which reads
    // as a head that promises nothing rather than one that implies the
    // branch was looked at.
    expect(describesChecks(kind(), step("review"))).toEqual([]);
  });

  it("has nothing to say about an action it cannot check", async () => {
    const prepared = await preparedWorktree();

    // No checks rather than passing ones, and the reason is on the kind
    // rather than inside the verifier: `implement` and the plan for pull
    // request comments (EO-760) are the keys this kind registers, so a
    // reviewer's run finds nothing to run (EO-297).
    expect(Object.keys(kind().verifiers)).toEqual(["implement", "plan_comment_response"]);
    expect(await verifyRun(kind(), item, { ...succeededImplement(prepared), action: "review" })).toEqual([]);
  });
});

describe("artifacts", () => {
  it("are the diff of the branch against what it was cut from", async () => {
    const prepared = await preparedWorktree();
    await commitInTheWorktree(prepared, "the work the reviewer reads\n");

    const artifacts = await kind().artifacts(getItem(handle.db, item.id)!, succeededImplement(prepared));

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.kind).toBe("diff");
    expect(artifacts[0]?.name).toBe(`${item.key}.diff`);
    expect(artifacts[0]?.mediaType).toBe("text/x-diff");
    expect(artifacts[0]?.body).toContain("+++ b/feature.txt");
    expect(artifacts[0]?.body).toContain("the work the reviewer reads");
    // The base branch's own commits are not this run's work, so they are
    // not in it.
    expect(artifacts[0]?.body).not.toContain("README.md");
  });

  it("are nothing at all when the branch changed nothing", async () => {
    const prepared = await preparedWorktree();

    expect(await kind().artifacts(getItem(handle.db, item.id)!, succeededImplement(prepared))).toEqual([]);
  });

  it("are nothing for an action that did not do the work in this branch (EO-298)", async () => {
    const prepared = await preparedWorktree();
    await commitInTheWorktree(prepared);

    // A review runs in the same worktree on the same branch, so asking
    // git what that branch did would answer with the implementer's diff
    // a second time — and posting it would supersede the implementer's
    // output with a copy of itself.
    for (const action of ["review", "refine", "discuss"]) {
      expect(await kind().artifacts(getItem(handle.db, item.id)!, { ...succeededImplement(prepared), action }), action).toEqual([]);
    }
  });
});

/**
 * The directory for files that are the ticket's and not the branch's
 * (EO-413).
 *
 * Asked of a worktree this kind prepared, because the claim is about
 * what a *dispatched* run finds: the exclusion is written by
 * preparation and nothing else, so a test that planted the pattern
 * itself would pass on a kind that never wrote it. `excludes.test.ts`
 * holds what the write does to a file; this holds that it happened, and
 * what follows from it for each thing that reads the tree afterwards.
 */
describe("the ticket's own directory in a prepared worktree", () => {
  const PATTERN = `/${TICKET_FILES_DIRECTORY}/`;
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  /** Where git reads this checkout's exclusions from, asked of git as the acceptance criterion asks it. */
  async function excludeFile(cwd: string): Promise<string> {
    const path = (await run(["rev-parse", "--git-path", "info/exclude"], cwd)).trim();
    return isAbsolute(path) ? path : join(cwd, path);
  }

  /** A file an agent made only to attach, where it was told to put one. */
  function plant(cwd: string, name: string, content: string | Buffer): string {
    mkdirSync(join(cwd, TICKET_FILES_DIRECTORY), { recursive: true });
    writeFileSync(join(cwd, TICKET_FILES_DIRECTORY, name), content);
    return `${TICKET_FILES_DIRECTORY}/${name}`;
  }

  it("is excluded once, however many dispatches run, with every line already there kept in order", async () => {
    const theirs = "# their own notes\n*.swp\n/scratch/\n";
    writeFileSync(await excludeFile(repoPath), theirs);

    const prepared = await preparedWorktree();
    await preparedWorktree();
    await kind().prepare(item, "review");

    const lines = readFileSync(await excludeFile(prepared.cwd), "utf8").split("\n");
    expect(lines.filter((line) => line === PATTERN)).toHaveLength(1);
    expect(lines.slice(0, 3)).toEqual(["# their own notes", "*.swp", "/scratch/"]);
    // The repository's file and not one of the worktree's own, which is
    // why once per repository is once for every checkout of it.
    // Compared as the files they name rather than as spellings: asked from
    // a worktree git answers with an absolute path of its own making, which
    // on Windows has forward slashes and the long form of a directory the
    // temp path spells in its 8.3 short form (`RUNNER~1`).
    expect(realpathSync.native(await excludeFile(prepared.cwd))).toBe(realpathSync.native(await excludeFile(repoPath)));
  });

  it("keeps a file written there out of git status, out of `git add -A` and out of the diff posted as the run's output", async () => {
    const prepared = await preparedWorktree();
    plant(prepared.cwd, "screenshot.png", PNG);
    plant(prepared.cwd, "test.log", "1 failed, 41 passed\n");

    expect(await status(prepared.cwd)).toBe("");

    await commitInTheWorktree(prepared, "the change itself\n");

    expect(await run(["ls-files"], prepared.cwd)).not.toContain(TICKET_FILES_DIRECTORY);
    expect(await status(prepared.cwd)).toBe("");
    const [diff] = await kind().artifacts(getItem(handle.db, item.id)!, succeededImplement(prepared));
    expect(diff?.body).toContain("+++ b/feature.txt");
    expect(diff?.body).not.toContain(TICKET_FILES_DIRECTORY);
    expect(diff?.body).not.toContain("41 passed");
    // Still on disk: excluded from git is not removed from the checkout.
    expect(existsSync(join(prepared.cwd, TICKET_FILES_DIRECTORY, "test.log"))).toBe(true);
  });

  it("does not hide a namesake further down the tree", async () => {
    // Anchored, for the reason `excludes.ts` gives: a directory of the
    // same name somebody keeps under `docs/` is their work, and a
    // release must still see it.
    const prepared = await preparedWorktree();
    mkdirSync(join(prepared.cwd, "docs", TICKET_FILES_DIRECTORY), { recursive: true });
    writeFileSync(join(prepared.cwd, "docs", TICKET_FILES_DIRECTORY, "theirs.txt"), "theirs\n");

    expect(await status(prepared.cwd)).toContain("docs/");
  });

  it("is somewhere `attachment_add` accepts a file from, and the file lands on the ticket", async () => {
    const prepared = await preparedWorktree();
    const path = plant(prepared.cwd, "screenshot.png", PNG);

    // Both halves of the tool: the server that answers the agent, and
    // the supervisor's own re-check before it writes (invariant 5).
    const service = eoServer as { checkAttachmentPath(directory: string, path: string): Promise<RunFileCheck> };
    expect(await service.checkAttachmentPath(prepared.cwd, path)).toMatchObject({ ok: true });
    expect(await checkRunFile(prepared.cwd, path)).toMatchObject({ ok: true });

    const agent = listAgents(handle.db).find((entry) => entry.role === "implementer")!;
    const attaching = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement", cwd: prepared.cwd });
    const storage = new AttachmentStorage(join(scratch, "attachments"));
    await attachRunFiles({
      db: handle.db,
      store: storage,
      itemId: item.id,
      runId: attaching.id,
      agent: { id: agent.id, name: agent.name },
      directory: prepared.cwd,
      args: { paths: [path], caption: "The login screen after the fix." },
    });

    const [comment] = listCommentsForItem(handle.db, item.id).filter((entry) => entry.authorType === "agent" && entry.kind === "note");
    expect(comment?.body).toBe("The login screen after the fix.");
    expect((comment?.attachments ?? []).map((file) => file.name)).toEqual(["screenshot.png"]);
    expect((comment?.attachments ?? [])[0]?.size).toBe(PNG.length);
    // And attaching it left nothing for git to find.
    expect(await status(prepared.cwd)).toBe("");
  });

  it("does not keep a settled ticket's worktree back as uncommitted work", async () => {
    const prepared = await preparedWorktree();
    await commitInTheWorktree(prepared);
    plant(prepared.cwd, "test.log", "41 passed\n");

    expect(await releaseWorktreeFor(handle.db, getItem(handle.db, item.id)!, worktreeRoot)).toEqual({ released: true });
    expect(existsSync(prepared.cwd)).toBe(false);
  });

  it("is excluded in the checkout a read-only run works in too, since that run is told about it as well", async () => {
    // A reply being read for a parked step runs in the repository as it
    // stands, with no worktree cut — and on a repository nothing has
    // been dispatched in yet, preparation of a worktree has not run.
    const prepared = await kind().prepare(item, "interpret");
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(prepared.workspace.cwd).toBe(repoPath);

    plant(repoPath, "notes.txt", "for the ticket\n");

    expect(await status(repoPath)).toBe("");
  });
});
