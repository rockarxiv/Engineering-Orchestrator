import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOLDER_KIND, GIT_WORKTREE_KIND, NONE_KIND, SCRATCH_KIND, uuidv7, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { asGitWorkspace, createProject, createStep, getProject, getStep, getWorkspace, listProjects, listWorkspaces, projectWorkspaceList } from "../db/repos/index.js";
import { beginAdoption } from "../db/repos/projectsRepo.js";
import { workspaces } from "../db/schema.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { activeProjectId, listRepositoriesCommand } from "./repositoryCommands.js";
import { createWorkspaceCommand, listWorkspacesCommand, removeWorkspaceCommand, updateWorkspaceCommand } from "./workspaceCommands.js";

/**
 * Settings → Workspaces, from the main process's side (EO-301,
 * ARCHITECTURE.md, "A workspace is a kind, attached to the project").
 *
 * The screen this backs used to be Settings → Repositories and knew one
 * kind. What is under test here is the two claims that made widening it
 * more than a rename: **the kind decides what a workspace is** — what
 * configuration it takes, what can be wrong with it, what it is called
 * on a row — and **nothing a repository had is lost by the widening**,
 * because the git kind goes through the door it always went through
 * rather than through a second opinion about what a checkout is.
 */
let handle: DbHandle;
/** Somewhere on disk to be the shared drive, and somewhere to be a checkout. */
let scratch: string;

/** The credentials argument the git path forwards. Nothing here reads it; a Jira binding is the project's. */
const credentials = { directory: "/nowhere", store: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(""), decryptString: () => "" } };

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-workspaces-"));
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** A directory that exists, which is the whole of what a folder workspace's path has to be. */
function directory(name: string): string {
  const path = join(scratch, name);
  mkdirSync(path, { recursive: true });
  return path;
}

/** A real checkout, because `repositories:create` asks git rather than taking the path on trust. */
function repository(name: string): string {
  const path = directory(name);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: path, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "eo@example.com");
  git("config", "user.name", "EO Test");
  writeFileSync(join(path, "README.md"), `# ${name}\n`);
  return path;
}

describe("what the list says about a workspace of each kind", () => {
  it("names every kind by what it is, with the summary that kind has and no other", async () => {
    const drive = directory("the drive");
    const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: directory("the repo"), baseBranch: "trunk" });
    const projectId = git.projectId!;

    for (const kind of [FOLDER_KIND, SCRATCH_KIND, NONE_KIND]) {
      const created = await attach({ kind, projectId, config: kind === FOLDER_KIND ? { path: drive } : {} });
      expect(created.ok, created.problem ?? "").toBe(true);
    }

    const listed = listWorkspacesCommand(handle.db, { projectId });
    expect(listed.workspaces.map((workspace) => [workspace.kind, workspace.label, workspace.summary])).toEqual([
      // The repository is named by what somebody typed; the folder by
      // its path, which is what a person calls it anyway.
      [GIT_WORKTREE_KIND, "the repo", `${join(scratch, "the repo")} · trunk`],
      [FOLDER_KIND, drive, drive],
      // The two with nothing to configure say so rather than padding a
      // sentence out to match the ones that have something to say.
      [SCRATCH_KIND, SCRATCH_KIND, "scratch — a fresh directory per run, kept only until its output is posted"],
      [NONE_KIND, NONE_KIND, "none — no disk. The agent works through MCP servers and connectors."],
    ]);
  });

  it("reports what is wrong with a workspace now, not what was true when it was attached", async () => {
    const drive = directory("the drive");
    // A real checkout, because the question being asked is whether it
    // is *still* one — a fixture that was never a checkout would report
    // the right sentence for the wrong reason.
    const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: repository("the repo") });
    const projectId = git.projectId!;
    expect((await attach({ kind: FOLDER_KIND, projectId, config: { path: drive } })).ok).toBe(true);

    // Clean when it was attached, and every line says so.
    expect(listWorkspacesCommand(handle.db, { projectId }).workspaces.map((workspace) => workspace.problem)).toEqual([null, null]);

    // The drive is unmounted and the checkout is deleted — the two
    // failures that actually happen to a workspace after it is attached.
    rmSync(drive, { recursive: true, force: true });
    rmSync(join(scratch, "the repo"), { recursive: true, force: true });

    const problems = listWorkspacesCommand(handle.db, { projectId }).workspaces.map((workspace) => workspace.problem);
    expect(problems[0]).toMatch(/is not there any more/);
    expect(problems[1]).toMatch(/does not exist/);
  });

  it("shows the workspaces a deleted project left behind only when nothing scopes the question", async () => {
    const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: directory("the repo") });
    const stranded = await attach({ kind: SCRATCH_KIND, projectId: git.projectId });
    expect(stranded.ok).toBe(true);

    // Taken off its project, which is the state a deleted project
    // leaves a workspace in — the membership cascaded and the disk did
    // not.
    handle.db.update(workspaces).set({ projectId: null }).where(eq(workspaces.id, stranded.workspace!.id)).run();

    expect(listWorkspacesCommand(handle.db, { projectId: git.projectId }).workspaces.map((w) => w.kind)).toEqual([GIT_WORKTREE_KIND]);
    expect(listWorkspacesCommand(handle.db, {}).workspaces.map((w) => w.kind)).toEqual([GIT_WORKTREE_KIND, SCRATCH_KIND]);
  });
});

describe("attaching one", () => {
  it("refuses a folder whose path is not a directory, rather than creating one to match", async () => {
    const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: directory("the repo") });
    const missing = join(scratch, "reprots");

    const created = await attach({ kind: FOLDER_KIND, projectId: git.projectId, config: { path: missing } });

    expect(created.ok).toBe(false);
    // Named, because the whole point is that it is probably a typo — and
    // a person cannot see a typo they are not shown.
    expect(created.problem).toContain(missing);
    expect(listWorkspaces(handle.db)).toHaveLength(1);
  });

  it("asks nothing of scratch and none, because neither has anything to decide", async () => {
    const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: directory("the repo") });

    for (const kind of [SCRATCH_KIND, NONE_KIND]) {
      const created = await attach({ kind, projectId: git.projectId });
      expect(created.ok, created.problem ?? "").toBe(true);
      expect(created.workspace?.kind).toBe(kind);
    }
  });

  it("refuses a kind that is not a repository when there is no project to attach it to", async () => {
    // A project is named after its first workspace, and a scratch
    // directory has no name to give one — so this is a description of
    // what a project is rather than a limitation.
    const created = await attach({ kind: SCRATCH_KIND, projectId: null });

    expect(created.ok).toBe(false);
    expect(created.problem).toContain("attach a repository or a folder first");
  });

  it("appends to the project rather than displacing the workspace an item with no pick falls back to", async () => {
    const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: directory("the repo") });
    expect((await attach({ kind: FOLDER_KIND, projectId: git.projectId, config: { path: directory("the drive") } })).ok).toBe(true);

    // The repository is still first, which is the workspace a ticket
    // naming none resolves to. Attaching a folder must not quietly move
    // every such ticket onto it.
    expect(projectWorkspaceList(handle.db, git.projectId!)[0]!.id).toBe(git.id);
  });
});

describe("a repository attached through this screen is a repository attached through the old one", () => {
  const FORM = { description: null, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null, forgeOpenPr: false, forgeKind: null, forgeRemote: "origin", forgeDraft: false, forgeTemplatePath: null };

  it("refuses a project mid-move to the organisation's record, and writes nothing (EO-605)", async () => {
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    beginAdoption(handle.db, shop.id);

    const created = await createWorkspaceCommand(handle.db, credentials, {
      kind: GIT_WORKTREE_KIND,
      projectId: shop.id,
      config: { ...FORM, name: "payments", repoPath: repository("payments") },
    });

    expect(created).toEqual({ ok: false, problem: `"Shop" is being moved to your organisation's record. Wait for the move to finish, then change its repositories.` });
    expect(listWorkspaces(handle.db)).toEqual([]);
  });

  it("keeps the path check, the settings on the form, and makes a project when there is none", async () => {
    const repoPath = repository("payments");

    const created = await createWorkspaceCommand(handle.db, credentials, {
      kind: GIT_WORKTREE_KIND,
      projectId: null,
      config: {
        name: "payments",
        description: "the Go payments service",
        repoPath,
        baseBranch: "trunk",
        testCommand: "pnpm test",
        lintCommand: null,
        buildCommand: null,
        // The five that used to be their own settings section and are
        // fields of this form now (EO-301).
        forgeOpenPr: true,
        forgeKind: "github",
        forgeRemote: "upstream",
        forgeDraft: true,
        forgeTemplatePath: ".github/pr.md",
      },
    });

    expect(created.ok, created.problem ?? "").toBe(true);
    const stored = getWorkspace(handle.db, created.workspace!.id as Uuid)!;
    expect(stored.config).toMatchObject({
      name: "payments",
      description: "the Go payments service",
      repoPath,
      baseBranch: "trunk",
      testCommand: "pnpm test",
      forgeOpenPr: true,
      forgeKind: "github",
      forgeRemote: "upstream",
      forgeDraft: true,
      forgeTemplatePath: ".github/pr.md",
    });

    // Nothing to join, so a project named after it, and the window on it.
    expect(listProjects(handle.db).map((project) => project.name)).toEqual(["payments"]);
    expect(activeProjectId(handle.db)).toBe(stored.projectId);
  });

  it("joins the project named, after what it holds, with no new project and the window where it was", async () => {
    const onScreen = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the api", repoPath: repository("the api") });
    const other = createProject(handle.db, { name: "Reports", keyPrefix: "REP" });
    const drive = await attach({ kind: FOLDER_KIND, projectId: other.id, config: { path: directory("the drive") } });
    expect(activeProjectId(handle.db)).toBe(onScreen.projectId);

    const created = await attach({ kind: GIT_WORKTREE_KIND, projectId: other.id, config: { ...FORM, name: "the web", repoPath: repository("the web"), forgeOpenPr: true } });

    expect(created.ok, created.problem ?? "").toBe(true);
    expect(projectWorkspaceList(handle.db, other.id).map((w) => w.id)).toEqual([drive.workspace!.id, created.workspace!.id]);
    expect(created.workspace?.config).toMatchObject({ forgeOpenPr: true });
    expect(listProjects(handle.db)).toHaveLength(2);
    expect(activeProjectId(handle.db)).toBe(onScreen.projectId);
  });

  it("joins the project on screen when none is named", async () => {
    const first = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the api", repoPath: repository("the api") });

    const created = await attach({ kind: GIT_WORKTREE_KIND, projectId: null, config: { name: "the web", repoPath: repository("the web") } });

    expect(projectWorkspaceList(handle.db, first.projectId!).map((w) => w.id)).toEqual([first.id, created.workspace!.id]);
    expect(listProjects(handle.db)).toHaveLength(1);
    expect(activeProjectId(handle.db)).toBe(first.projectId);
  });

  it("refuses a key prefix on a repository joining a project, naming that project's, and writes nothing", async () => {
    attachWorkspace(handle.db, { keyPrefix: "EO", name: "the api", repoPath: repository("the api") });

    const refused = await createWorkspaceCommand(handle.db, credentials, {
      kind: GIT_WORKTREE_KIND,
      projectId: null,
      keyPrefix: "WEB",
      config: { name: "the web", repoPath: repository("the web") },
    });

    expect(refused.ok).toBe(false);
    expect(refused.problem).toContain("EO");
    expect(listWorkspaces(handle.db)).toHaveLength(1);
  });

  it("refuses a projectId that names no project, and writes no workspace", async () => {
    attachWorkspace(handle.db, { keyPrefix: "EO", name: "the api", repoPath: repository("the api") });

    const refused = await attach({ kind: GIT_WORKTREE_KIND, projectId: uuidv7(), config: { name: "the web", repoPath: repository("the web") } });

    expect(refused).toMatchObject({ ok: false, problem: "That project no longer exists." });
    expect(listWorkspaces(handle.db)).toHaveLength(1);
  });

  it("refuses a path that is not a checkout, by name, exactly as the repository form always did", async () => {
    const notARepo = directory("just a folder");

    const created = await createWorkspaceCommand(handle.db, credentials, {
      kind: GIT_WORKTREE_KIND,
      projectId: null,
      config: { name: "nope", description: null, repoPath: notARepo, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null, forgeOpenPr: false, forgeKind: null, forgeRemote: "origin", forgeDraft: false, forgeTemplatePath: null },
    });

    expect(created.ok).toBe(false);
    expect(created.problem).toContain(notARepo);
    expect(created.problem).toContain("is not a git repository");
  });
});

describe("changing one", () => {
  it("lays a patch over what is stored rather than replacing it", async () => {
    const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: directory("the repo") });
    const drive = directory("the drive");
    const folder = await attach({ kind: FOLDER_KIND, projectId: git.projectId, config: { path: drive, perItemSubfolder: true } });

    const moved = directory("the new drive");
    const updated = await updateWorkspaceCommand(handle.db, credentials, { id: folder.workspace!.id, config: { path: moved } });

    expect(updated.ok, updated.problem ?? "").toBe(true);
    // The subfolder layout survives a change of path. A JSON column
    // makes this the trap it is: a caller that meant to move the folder
    // must not have to restate everything else to keep it.
    expect(updated.workspace?.config).toEqual({ path: moved, perItemSubfolder: true });
  });

  /**
   * Changing a repository's path is the same act as attaching it at one
   * (EO-301, caught in review).
   *
   * The first version of this screen delegated *attaching* a repository
   * to `repositories:create` and then updated one itself, with nothing
   * but a schema parse in front of it — so the Repository path field
   * would accept a directory git has never heard of, or a checkout
   * another workspace already holds. Both were refused by the form this
   * screen replaced, and both fail late and confusingly: the first at
   * the next dispatch, the second by minting keys and cutting worktrees
   * over the same branches from two records.
   */
  describe("a repository's path, changed through this screen", () => {
    it("refuses a path git does not recognise, by name", async () => {
      const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: repository("the repo") });
      const notARepo = directory("just a folder");

      const updated = await updateWorkspaceCommand(handle.db, credentials, { id: git.id, config: { repoPath: notARepo } });

      expect(updated.ok).toBe(false);
      expect(updated.problem).toContain(notARepo);
      expect(updated.problem).toContain("is not a git repository");
      // Nothing stored: the refusal is the whole of what happened.
      expect(asGitWorkspace(getWorkspace(handle.db, git.id))?.config.repoPath).toBe(join(scratch, "the repo"));
    });

    it("refuses a checkout another workspace already holds, and names the one that holds it", async () => {
      const first = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the api", repoPath: repository("the api") });
      const second = attachWorkspace(handle.db, { keyPrefix: "WEB", name: "the web", repoPath: repository("the web") });

      const updated = await updateWorkspaceCommand(handle.db, credentials, { id: second.id, config: { repoPath: first.config.repoPath } });

      expect(updated.ok).toBe(false);
      // Named, because the fix is to go and look at the other one —
      // "already attached" without saying to what is the shape of an
      // answer without being one.
      expect(updated.problem).toContain("the api");
      expect(asGitWorkspace(getWorkspace(handle.db, second.id))?.config.repoPath).toBe(join(scratch, "the web"));
    });

    it("allows a repository to keep its own path while something else changes", async () => {
      // Its current path is not a move, and must not be refused as a
      // duplicate of itself — the form sends the whole config back, so
      // this is the ordinary case rather than an edge one.
      const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: repository("the repo") });

      const updated = await updateWorkspaceCommand(handle.db, credentials, {
        id: git.id,
        config: { repoPath: git.config.repoPath, baseBranch: "trunk", testCommand: "pnpm test" },
      });

      expect(updated.ok, updated.problem ?? "").toBe(true);
      expect(asGitWorkspace(getWorkspace(handle.db, git.id))?.config).toMatchObject({ baseBranch: "trunk", testCommand: "pnpm test" });
    });

    it("moves a repository to another real checkout nothing else holds", async () => {
      const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: repository("the repo") });
      const moved = repository("the repo moved");

      const updated = await updateWorkspaceCommand(handle.db, credentials, { id: git.id, config: { repoPath: moved } });

      expect(updated.ok, updated.problem ?? "").toBe(true);
      expect(asGitWorkspace(getWorkspace(handle.db, git.id))?.config.repoPath).toBe(moved);
    });

    it("refuses a blank name or path, which the channel schema used to refuse with min(1)", async () => {
      const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: repository("the repo") });

      expect((await updateWorkspaceCommand(handle.db, credentials, { id: git.id, config: { name: "  " } })).ok).toBe(false);
      expect((await updateWorkspaceCommand(handle.db, credentials, { id: git.id, config: { repoPath: "" } })).ok).toBe(false);
      expect(asGitWorkspace(getWorkspace(handle.db, git.id))?.config.name).toBe("the repo");
    });

    it("saves the default reviewers the form sends, tidied, and that is what repositories_list reports (EO-741)", async () => {
      const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: repository("the repo") });

      const updated = await updateWorkspaceCommand(handle.db, credentials, { id: git.id, config: { ...git.config, forgeReviewers: ["alice", "bob", "alice"] } });

      expect(updated.ok, updated.problem ?? "").toBe(true);
      expect(listRepositoriesCommand(handle.db, credentials).repositories.find((listed) => listed.id === git.id)?.forge.reviewers).toEqual(["alice", "bob"]);
    });

    it("refuses a reviewer with a comma in it, naming it, and stores nothing from the form (EO-741)", async () => {
      const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: repository("the repo") });

      const updated = await updateWorkspaceCommand(handle.db, credentials, { id: git.id, config: { baseBranch: "trunk", forgeReviewers: ["alice,bob"] } });

      expect(updated.ok).toBe(false);
      expect(updated.problem).toContain('"alice,bob"');
      expect(asGitWorkspace(getWorkspace(handle.db, git.id))?.config).toMatchObject({ baseBranch: "main", forgeReviewers: [] });
    });

    it("leaves the forge settings alone when only the path is sent", async () => {
      // The patch stays a patch: `updateRepositoryCommand` reads an
      // absent key as "leave it", so forwarding only what was sent is
      // what keeps a one-field edit from restating the repository.
      const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: repository("the repo") });
      expect((await updateWorkspaceCommand(handle.db, credentials, { id: git.id, config: { forgeOpenPr: true, forgeRemote: "upstream" } })).ok).toBe(true);

      const moved = repository("the repo moved");
      expect((await updateWorkspaceCommand(handle.db, credentials, { id: git.id, config: { repoPath: moved } })).ok).toBe(true);

      expect(asGitWorkspace(getWorkspace(handle.db, git.id))?.config).toMatchObject({ repoPath: moved, forgeOpenPr: true, forgeRemote: "upstream" });
    });
  });

  it("refuses a folder path that is not a directory, rather than storing one a run will meet later", async () => {
    const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: directory("the repo") });
    const folder = await attach({ kind: FOLDER_KIND, projectId: git.projectId, config: { path: directory("the drive") } });

    const updated = await updateWorkspaceCommand(handle.db, credentials, { id: folder.workspace!.id, config: { path: join(scratch, "nowhere") } });

    expect(updated.ok).toBe(false);
    expect(getWorkspace(handle.db, folder.workspace!.id as Uuid)?.config).toMatchObject({ path: join(scratch, "the drive") });
  });
});

describe("detaching one", () => {
  it("refuses while tickets are on it, because their runs are append-only", async () => {
    const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: directory("the repo") });
    const folder = await attach({ kind: FOLDER_KIND, projectId: git.projectId, config: { path: directory("the drive") } });
    createTestItem(handle.db, { type: "story", title: "Draft the report", stepId: "todo", workspaceId: folder.workspace!.id as Uuid, projectId: git.projectId });

    const removed = removeWorkspaceCommand(handle.db, { id: folder.workspace!.id });

    expect(removed.ok).toBe(false);
    expect(removed.problem).toContain("append-only");
    expect(getWorkspace(handle.db, folder.workspace!.id as Uuid)).toBeDefined();
  });

  it("refuses a repository on a project mid-move to the organisation's record, and writes nothing (EO-607)", () => {
    const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: repository("the repo") });
    beginAdoption(handle.db, git.projectId!);

    const removed = removeWorkspaceCommand(handle.db, { id: git.id });

    expect(removed).toEqual({ ok: false, problem: `"the repo" is being moved to your organisation's record. Wait for the move to finish, then change its repositories.` });
    expect(getWorkspace(handle.db, git.id)).toMatchObject({ projectId: git.projectId });
  });

  it("keeps the project when its last repository goes, shows it empty, and takes a repository again", async () => {
    const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: repository("the repo") });

    expect(removeWorkspaceCommand(handle.db, { id: git.id })).toEqual({ ok: true, problem: null });

    expect(getProject(handle.db, git.projectId!)).toMatchObject({ id: git.projectId });
    expect(activeProjectId(handle.db)).toBe(git.projectId);
    expect(listWorkspacesCommand(handle.db, { projectId: git.projectId }).workspaces).toEqual([]);

    const again = await attach({ kind: GIT_WORKTREE_KIND, projectId: git.projectId, config: { name: "the web", repoPath: repository("the web") } });

    expect(again.ok, again.problem ?? "").toBe(true);
    expect(listProjects(handle.db)).toHaveLength(1);
    expect(listWorkspacesCommand(handle.db, { projectId: git.projectId }).workspaces.map((w) => w.id)).toEqual([again.workspace!.id]);
  });

  it("lets go of every step that named it, so nothing is left pointing at a workspace that is gone", async () => {
    const git = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: directory("the repo") });
    const folder = await attach({ kind: FOLDER_KIND, projectId: git.projectId, config: { path: directory("the drive") } });
    createStep(handle.db, { id: "draft", pipelineId: "default" as Uuid, position: 15, name: "Draft", workspaceId: folder.workspace!.id });

    expect(removeWorkspaceCommand(handle.db, { id: folder.workspace!.id }).ok).toBe(true);

    // Null rather than left dangling: the step falls back to the
    // ticket's own workspace, which is what a step with no pick has
    // always done and the only fallback that leaves work running.
    expect(getStep(handle.db, "draft")?.workspaceId).toBeNull();
  });
});

/** The create command with this test's fixed arguments, so a case reads as the kind and the config it is about. */
function attach(input: { kind: string; projectId: Uuid | null | undefined; config?: unknown }) {
  return createWorkspaceCommand(handle.db, credentials, { kind: input.kind, projectId: input.projectId ?? null, config: input.config ?? {} });
}
