import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_PERSON_ID, type Uuid } from "@eo/core";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import {
  createPipeline,
  createProject,
  createRun,
  deleteProject,
  getItem,
  linkJiraKey,
  getJiraBinding,
  getProject,
  getSetting,
  getWorkspace,
  listAgents,
  listCommentsForItem,
  listItemTypes,
  listJobs,
  listPipelines,
  listRunsForItem,
  listWorkspaces,
  postComment,
  saveJiraBinding,
  setItemArchived,
  setSetting,
  type Workspace,
} from "../db/repos/index.js";
import { insertJob } from "../db/repos/jobsRepo.js";
import { markProjectOnTheRecord } from "../db/repos/projectsRepo.js";
import { pipelines } from "../db/schema.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { setBranchPrefix } from "../packs/developer/workspace/branchPrefix.js";
import { git } from "../packs/developer/workspace/git.js";
import { branchNameFor, createWorktree, worktreePathFor } from "../packs/developer/workspace/worktrees.js";
import { featureIsDone, featureProgress } from "../roles/featureLifecycle.js";
import { createItemLock } from "../supervisor/itemLock.js";
import { run } from "../testing/git.js";
import { deleteProjectCommand, managedProjectRefusal } from "./deleteProjectCommand.js";
import type { EngineHandle } from "./domainCommands.js";
import { listProjectsCommand } from "./projectCommands.js";
import { ACTIVE_PROJECT_KEY, listRepositoriesCommand } from "./repositoryCommands.js";
import type { SecretStore } from "../secrets/store.js";
import { removeScratch } from "../testing/scratch.js";

/**
 * Deleting a project and every item on it (EO-346).
 *
 * Real git, for `deleteItemCommand.test.ts`'s reason: whether a worktree
 * is there, dirty, and gone afterwards with its branch still standing is
 * a question about what is on disk.
 */
let scratch: string;
let repoPath: string;
let worktreeRoot: string;
let handle: DbHandle;
let attachmentStorage: AttachmentStorage;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo delete project "));
  repoPath = join(scratch, "the repo");
  worktreeRoot = join(scratch, "work trees");
  attachmentStorage = new AttachmentStorage(join(scratch, "attachments"));
  mkdirSync(repoPath, { recursive: true });
  await run(["init", "-b", "main"], repoPath);
  await run(["config", "user.email", "eo@example.com"], repoPath);
  await run(["config", "user.name", "EO Test"], repoPath);
  await run(["config", "commit.gpgsign", "false"], repoPath);
  await run(["config", "tag.gpgsign", "false"], repoPath);
  writeFileSync(join(repoPath, "README.md"), "# fixture\n");
  await run(["add", "-A"], repoPath);
  await run(["commit", "-m", "initial"], repoPath);

  handle = openMigratedTestDb();
  setBranchPrefix(handle.db, "eo");
});

afterEach(() => {
  handle.close();
  removeScratch(scratch);
});

function repository(): Workspace & { projectId: Uuid } {
  const workspace = attachWorkspace(handle.db, { name: "the repo", keyPrefix: "EO", repoPath, baseBranch: "main" });
  return workspace as Workspace & { projectId: Uuid };
}

/** Enough of a keychain for the repositories list to be drawn; nothing here stores a token. */
function credentials() {
  const store: SecretStore = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(plain),
    decryptString: (encrypted) => encrypted.toString(),
  };
  return { directory: join(scratch, "credentials"), store };
}

function worktreeConfig() {
  return { repoPath, baseBranch: "main", worktreeRoot };
}

function fakeEngine(): EngineHandle & { cancelled: { runId: string; reason: string | undefined }[] } {
  const cancelled: { runId: string; reason: string | undefined }[] = [];
  return {
    cancelled,
    resumeItem: async () => {},
    cancelRun: (runId, reason) => void cancelled.push({ runId, reason }),
    steerRun: () => Promise.resolve("no-live-run" as const),
    pause: () => {},
    resume: () => {},
    isPaused: () => false,
    dispatchBlockerFor: () => null,
    activeRunCount: () => 0,
    finishingRunCount: () => 0,
    notifyStateChange: () => {},
    itemLock: createItemLock(),
    offerWork: async () => [],
  };
}

function runningOn(itemId: Uuid) {
  const agent = listAgents(handle.db).find((entry) => entry.role === "implementer")!;
  return createRun(handle.db, { itemId, agentId: agent.id, action: "implement", status: "running" });
}

function remove(projectId: Uuid, confirm: boolean, engine = fakeEngine()) {
  return deleteProjectCommand(handle.db, engine, { projectId, confirm }, attachmentStorage, worktreeRoot);
}

describe("projects:delete", () => {
  describe("without confirmation", () => {
    it("deletes nothing, and says how many tickets it would take and how many are unfinished", async () => {
      const eo = repository();
      const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: eo.id, projectId: eo.projectId });
      createTestItem(handle.db, { type: "story", title: "Throttle", stepId: "todo", workspaceId: eo.id, projectId: eo.projectId, parentId: feature.id });
      const done = createTestItem(handle.db, { type: "story", title: "Measured", stepId: "ready_to_merge", workspaceId: eo.id, projectId: eo.projectId });
      const archived = createTestItem(handle.db, { type: "story", title: "Old", stepId: "todo", workspaceId: eo.id, projectId: eo.projectId });
      setItemArchived(handle.db, archived.id, Date.now());

      const answer = await remove(eo.projectId, false);

      // The feature (its story is not done), and the story under it. Not
      // the finished story, and not the archived one — both are tickets
      // that go, and neither is work anybody is losing.
      expect(answer).toMatchObject({ deleted: false, problem: null, itemCount: 4, unfinishedCount: 2, deletedCount: 0 });
      expect(getProject(handle.db, eo.projectId)).toBeDefined();
      expect(getItem(handle.db, done.id)).toBeDefined();
    });

    it("counts a feature whose stories are all done as finished", async () => {
      const eo = repository();
      const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: eo.id, projectId: eo.projectId });
      createTestItem(handle.db, { type: "story", title: "Throttle", stepId: "ready_to_merge", workspaceId: eo.id, projectId: eo.projectId, parentId: feature.id });

      const answer = await remove(eo.projectId, false);

      expect(answer).toMatchObject({ itemCount: 2, unfinishedCount: 0 });
    });

    it("counts a feature as finished when its only unfinished story has been archived", async () => {
      // EO calls this feature done, because what `featureProgress` reads
      // is the live stories. The confirmation has to say the same, and
      // not keep the feature unfinished on the strength of a story that
      // was put away.
      const eo = repository();
      const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: eo.id, projectId: eo.projectId });
      createTestItem(handle.db, { type: "story", title: "Throttle", stepId: "ready_to_merge", workspaceId: eo.id, projectId: eo.projectId, parentId: feature.id });
      const shelved = createTestItem(handle.db, { type: "story", title: "Shelved", stepId: "todo", workspaceId: eo.id, projectId: eo.projectId, parentId: feature.id });
      setItemArchived(handle.db, shelved.id, Date.now());

      const answer = await remove(eo.projectId, false);

      expect(featureIsDone(featureProgress(handle.db, feature.id))).toBe(true);
      expect(answer).toMatchObject({ itemCount: 3, unfinishedCount: 0 });
    });

    it("names the item an agent is running on, and leaves the run alone", async () => {
      const eo = repository();
      const busy = createTestItem(handle.db, { type: "story", title: "Busy", stepId: "todo", workspaceId: eo.id, projectId: eo.projectId });
      const live = runningOn(busy.id);
      const engine = fakeEngine();

      const answer = await remove(eo.projectId, false, engine);

      expect(answer.deleted).toBe(false);
      expect(answer.running).toEqual([{ itemKey: busy.key, title: "Busy" }]);
      expect(engine.cancelled).toEqual([]);
      expect(listRunsForItem(handle.db, busy.id).map((entry) => entry.id)).toEqual([live.id]);
    });

    it("names the item whose worktree holds uncommitted changes, and leaves the worktree alone", async () => {
      const eo = repository();
      const half = createTestItem(handle.db, { type: "story", title: "Half done", stepId: "todo", workspaceId: eo.id, projectId: eo.projectId });
      await createWorktree(worktreeConfig(), half.key);
      writeFileSync(join(worktreePathFor(half.key, worktreeRoot), "limiter.ts"), "export const limit = 100;\n");

      const answer = await remove(eo.projectId, false);

      expect(answer.deleted).toBe(false);
      expect(answer.uncommitted).toEqual([{ itemKey: half.key, title: "Half done", changes: 1 }]);
      expect(existsSync(worktreePathFor(half.key, worktreeRoot))).toBe(true);
    });
  });

  describe("confirmed", () => {
    it("deletes a project with unfinished tickets, with their comments, runs and attachments, and no foreign-key error", async () => {
      const eo = repository();
      const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: eo.id, projectId: eo.projectId });
      const story = createTestItem(handle.db, { type: "story", title: "Throttle", stepId: "todo", workspaceId: eo.id, projectId: eo.projectId, parentId: feature.id });
      const archived = createTestItem(handle.db, { type: "story", title: "Old", stepId: "ready_to_merge", workspaceId: eo.id, projectId: eo.projectId });
      setItemArchived(handle.db, archived.id, Date.now());
      postComment(handle.db, { itemId: story.id, author: { type: "human" }, body: "Start here." });
      const agent = listAgents(handle.db).find((entry) => entry.role === "implementer")!;
      createRun(handle.db, { itemId: story.id, agentId: agent.id, action: "implement", status: "succeeded" });
      const draft = await attachmentStorage.stageData({ name: "spec.txt", dataBase64: Buffer.from("spec").toString("base64") });
      const records = await attachmentStorage.prepare([draft.id]);
      postComment(handle.db, { itemId: feature.id, author: { type: "human" }, body: "", attachmentRecords: records });
      await attachmentStorage.finish(records);
      const file = records[0]!.storagePath;
      expect(existsSync(file)).toBe(true);

      const answer = await remove(eo.projectId, true);

      expect(answer).toMatchObject({ deleted: true, problem: null, deletedCount: 3, leftoverWorktrees: [] });
      expect(getProject(handle.db, eo.projectId)).toBeUndefined();
      for (const item of [feature, story, archived]) expect(getItem(handle.db, item.id)).toBeUndefined();
      expect(listCommentsForItem(handle.db, story.id)).toEqual([]);
      expect(listRunsForItem(handle.db, story.id)).toEqual([]);
      expect(existsSync(file)).toBe(false);
    });

    it("takes its pipelines, item types, jobs and connector bindings with it", async () => {
      const eo = repository();
      createTestItem(handle.db, { type: "story", title: "The weekly report", stepId: "todo", workspaceId: eo.id, projectId: eo.projectId });
      const pipeline = createPipeline(handle.db, { name: "Support", projectId: eo.projectId });
      insertJob(handle.db, {
        projectId: eo.projectId,
        name: "The weekly report",
        trigger: { kind: "manual" },
        pipelineId: pipeline.id,
        template: null,
        ownerId: LOCAL_PERSON_ID,
      });
      saveJiraBinding(handle.db, eo.projectId, { projectKey: "EO" });
      expect(listItemTypes(handle.db, eo.projectId).length).toBeGreaterThan(0);

      const answer = await remove(eo.projectId, true);

      expect(answer.deleted).toBe(true);
      expect(handle.db.select().from(pipelines).where(eq(pipelines.projectId, eo.projectId)).all()).toEqual([]);
      expect(listPipelines(handle.db).map((entry) => entry.id)).not.toContain(pipeline.id);
      expect(listItemTypes(handle.db, eo.projectId)).toEqual([]);
      expect(listJobs(handle.db, eo.projectId)).toEqual([]);
      expect(getJiraBinding(handle.db, eo.projectId)).toBeUndefined();
    });

    it("keeps its repositories in EO, attached to no project", async () => {
      const eo = repository();
      createTestItem(handle.db, { type: "story", title: "Throttle", stepId: "todo", workspaceId: eo.id, projectId: eo.projectId });

      await remove(eo.projectId, true);

      expect(listWorkspaces(handle.db).map((workspace) => workspace.id)).toEqual([eo.id]);
      expect(getWorkspace(handle.db, eo.id)?.projectId).toBeNull();
      // And Settings → Repositories still lists it.
      expect(listRepositoriesCommand(handle.db, credentials()).repositories.map((repository) => repository.id)).toContain(eo.id);
    });

    it("stops a running agent, as superseded, and deletes the item it was on", async () => {
      const eo = repository();
      const busy = createTestItem(handle.db, { type: "story", title: "Busy", stepId: "todo", workspaceId: eo.id, projectId: eo.projectId });
      const live = runningOn(busy.id);
      const engine = fakeEngine();

      const answer = await remove(eo.projectId, true, engine);

      expect(answer.deleted).toBe(true);
      expect(answer.running).toEqual([{ itemKey: busy.key, title: "Busy" }]);
      expect(engine.cancelled).toEqual([{ runId: live.id, reason: "superseded" }]);
      expect(getItem(handle.db, busy.id)).toBeUndefined();
    });

    it("removes a worktree with uncommitted changes, and keeps its branch", async () => {
      const eo = repository();
      const half = createTestItem(handle.db, { type: "story", title: "Half done", stepId: "todo", workspaceId: eo.id, projectId: eo.projectId });
      await createWorktree(worktreeConfig(), half.key);
      writeFileSync(join(worktreePathFor(half.key, worktreeRoot), "limiter.ts"), "export const limit = 100;\n");

      const answer = await remove(eo.projectId, true);

      expect(answer.deleted).toBe(true);
      expect(answer.uncommitted.map((entry) => entry.itemKey)).toEqual([half.key]);
      expect(existsSync(worktreePathFor(half.key, worktreeRoot))).toBe(false);
      const branches = await git(["branch", "--list", branchNameFor(half.key)], repoPath);
      expect(branches.ok && branches.stdout.trim()).not.toBe("");
    });

    it("switches the window to another project when it was the one showing", async () => {
      const eo = repository();
      const other = createProject(handle.db, { name: "Other", keyPrefix: "OTH" });
      setSetting(handle.db, ACTIVE_PROJECT_KEY, eo.projectId);

      const answer = await remove(eo.projectId, true);

      expect(answer.activeProjectId).toBe(other.id);
      expect(getSetting(handle.db, ACTIVE_PROJECT_KEY, null)).toBe(other.id);
      expect(listProjectsCommand(handle.db).activeProjectId).toBe(other.id);
    });

    it("leaves the window on no project when none is left", async () => {
      const eo = repository();
      setSetting(handle.db, ACTIVE_PROJECT_KEY, eo.projectId);

      const answer = await remove(eo.projectId, true);

      expect(answer.activeProjectId).toBeNull();
      expect(listProjectsCommand(handle.db)).toEqual({ projects: [], activeProjectId: null });
    });

    it("leaves the window alone when another project was showing", async () => {
      const eo = repository();
      const other = createProject(handle.db, { name: "Other", keyPrefix: "OTH" });
      setSetting(handle.db, ACTIVE_PROJECT_KEY, other.id);

      await remove(eo.projectId, true);

      expect(getSetting(handle.db, ACTIVE_PROJECT_KEY, null)).toBe(other.id);
    });

    it("reaches nothing in Jira for a project mirrored there", async () => {
      // The command is handed no Jira context, so there is no path from
      // here to an issue; this holds it to that by failing any request
      // that leaves the process at all.
      const requests: string[] = [];
      vi.stubGlobal("fetch", (url: string) => {
        requests.push(String(url));
        return Promise.reject(new Error("no network in this test"));
      });
      try {
        const eo = repository();
        saveJiraBinding(handle.db, eo.projectId, { projectKey: "EO" });
        const mirrored = createTestItem(handle.db, { type: "story", title: "Mirrored", stepId: "todo", workspaceId: eo.id, projectId: eo.projectId });
        expect(linkJiraKey(handle.db, mirrored.id, "EO-77")).toMatchObject({ ok: true });

        const answer = await remove(eo.projectId, true);

        expect(answer.deleted).toBe(true);
        expect(requests).toEqual([]);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("has to delete the tickets first: the project row alone is refused by the foreign key", () => {
      // Why the order in the command is what it is. Should this ever
      // stop throwing, `items.project_id` has gained an ON DELETE rule
      // and the comment in `deleteProjectCommand` needs rewriting.
      const eo = repository();
      createTestItem(handle.db, { type: "story", title: "Throttle", stepId: "todo", workspaceId: eo.id, projectId: eo.projectId });

      expect(() => deleteProject(handle.db, eo.projectId)).toThrow(/FOREIGN KEY/);
    });
  });

  describe("refusals", () => {
    it("refuses a project on the organisation's record, confirmed or not, and says the record owns it", async () => {
      const eo = repository();
      const item = createTestItem(handle.db, { type: "story", title: "Theirs", stepId: "todo", workspaceId: eo.id, projectId: eo.projectId });
      markProjectOnTheRecord(handle.db, eo.projectId, LOCAL_PERSON_ID);

      for (const confirm of [false, true]) {
        const answer = await remove(eo.projectId, confirm);
        expect(answer).toMatchObject({ deleted: false, problem: managedProjectRefusal("the repo") });
        expect(answer.problem).toMatch(/record owns it/);
      }
      expect(getProject(handle.db, eo.projectId)).toBeDefined();
      expect(getItem(handle.db, item.id)).toBeDefined();
    });

    it("says so when the project is already gone", async () => {
      const answer = await remove("019fb8c6-0000-7000-8000-000000000000" as Uuid, true);

      expect(answer).toMatchObject({ deleted: false, problem: "That project no longer exists." });
    });
  });
});
