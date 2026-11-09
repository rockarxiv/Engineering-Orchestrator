import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Uuid } from "@eo/core";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import { attachmentRemovals } from "../db/schema.js";
import {
  addItemAttachments,
  createRun,
  getItem,
  listAttachmentsForItem,
  listItemAttachments,
  removeItemAttachment,
  listAgents,
  postComment,
  projectForWorkspace,
  saveJiraBinding,
  setJiraSync,
  updateItem,
  type Workspace,
} from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { featureIsDone, featureProgress } from "../roles/featureLifecycle.js";
import type { FetchLike } from "../packs/developer/jira/client.js";
import type { JiraContext } from "../packs/developer/jira/connection.js";
import { storeToken } from "../packs/developer/jira/credentials.js";
import type { SecretStore } from "../secrets/store.js";
import { createJiraConnection } from "../db/repos/index.js";
import { setBranchPrefix } from "../packs/developer/workspace/branchPrefix.js";
import { git, samePath } from "../packs/developer/workspace/git.js";
import { TICKET_FILES_DIRECTORY } from "../packs/developer/workspace/ticketFiles.js";
import { branchNameFor, createWorktree, worktreePathFor } from "../packs/developer/workspace/worktrees.js";
import { referenceCheckoutFor } from "../packs/developer/workspace/referenceCheckouts.js";
import { deleteItemCommand } from "./deleteItemCommand.js";
import type { EngineHandle } from "./domainCommands.js";
import { createItemLock } from "../supervisor/itemLock.js";
import { run } from "../testing/git.js";

// Passed through untouched, and watched: a comment posted on an item
// that is then deleted goes with it, so the call is the only place the
// report on a written-to reference checkout can be seen (EO-632).
vi.mock("../db/repos/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/repos/index.js")>();
  return { ...actual, postComment: vi.fn(actual.postComment) };
});

/**
 * Deleting an item for real (KAN-30).
 *
 * Real git, because every worktree question here — is it there, is it
 * dirty, did it survive — is a question about what is on disk, and a
 * fake would only prove the shape of the code that reads it.
 */
let scratch: string;
let repoPath: string;
let worktreeRoot: string;
let credentialsDir: string;
let handle: DbHandle;
let attachmentStorage: AttachmentStorage;

const store: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`v1:${Buffer.from(plain).toString("base64")}`),
  decryptString: (encrypted) => Buffer.from(encrypted.toString().slice(3), "base64").toString(),
};

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo delete ticket "));
  repoPath = join(scratch, "the repo");
  worktreeRoot = join(scratch, "work trees");
  credentialsDir = join(scratch, "credentials");
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
  // Hermetic: without this, the branch prefix seeds itself from whatever
  // `git config --global user.email` happens to be on the machine
  // running the tests, not from the fixed "eo" every assertion expects.
  setBranchPrefix(handle.db, "eo");
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

function repository(): Workspace {
  return attachWorkspace(handle.db, { name: "the repo", keyPrefix: "EO", repoPath, baseBranch: "main" });
}

function worktreeConfig() {
  return { repoPath, baseBranch: "main", worktreeRoot };
}

/** No Jira anywhere near it — the default for every test that isn't about Jira. */
function offline(): JiraContext {
  return { credentials: { directory: credentialsDir, store }, fetchImpl: async () => new Response("{}", { status: 200 }) };
}

function fakeEngine(): EngineHandle & { cancelled: string[] } {
  const cancelled: string[] = [];
  return {
    cancelled,
    resumeItem: async () => {},
    cancelRun: (runId) => void cancelled.push(runId),
    steerRun: () => Promise.resolve("no-live-run" as const),
    pause: () => {},
    resume: () => {},
    isPaused: () => false,
    // Nothing is standing in this item's way: these tests are about
    // something else, and a fake that answered otherwise would be
    // inventing a refusal.
    dispatchBlockerFor: () => null,
    activeRunCount: () => 0,
    finishingRunCount: () => 0,
    notifyStateChange: () => {},
    itemLock: createItemLock(),
    // Nothing in these tests is a record answering another device.
    offerWork: async () => [],
  };
}

const NOTHING_EXTRA = { cancelActiveRun: false, deleteInJira: false, discardUncommitted: false };

async function addAttachment(itemId: Uuid, name: string): Promise<string> {
  const draft = await attachmentStorage.stageData({ name, dataBase64: Buffer.from(name).toString("base64") });
  const records = await attachmentStorage.prepare([draft.id]);
  postComment(handle.db, { itemId, author: { type: "human" }, body: "", attachmentRecords: records });
  await attachmentStorage.finish(records);
  return records[0]!.storagePath;
}

describe("items:delete", () => {
  it("removes the item and says how many went", async () => {
    const eo = repository();
    const item = createTestItem(handle.db, { type: "story", title: "Throttle it", stepId: "todo", workspaceId: eo.id });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Start here." });

    const result = await deleteItemCommand(handle.db, fakeEngine(), offline(), { ...NOTHING_EXTRA, itemId: item.id }, attachmentStorage, worktreeRoot);

    expect(result).toMatchObject({ deleted: true, deletedCount: 1, problem: null, jira: null });
    expect(getItem(handle.db, item.id)).toBeUndefined();
  });

  it("removes the reference checkouts the item was lent, even one that was written to (EO-632)", async () => {
    const eo = repository();
    const item = createTestItem(handle.db, { type: "story", title: "Reads main", stepId: "todo", workspaceId: eo.id, projectId: eo.projectId });
    const lent = await referenceCheckoutFor(handle.db, item, { repository: "the repo", branch: "main" });
    if (!lent.ok) throw new Error(lent.reason);
    writeFileSync(join(lent.checkout.path, "scribble.txt"), "new\n");

    const result = await deleteItemCommand(handle.db, fakeEngine(), offline(), { ...NOTHING_EXTRA, itemId: item.id }, attachmentStorage, worktreeRoot);

    expect(result).toMatchObject({ deleted: true });
    // Said on the item before the checkout went, as every removal says it.
    const reports = vi.mocked(postComment).mock.calls.filter(([, input]) => input.itemId === item.id && input.body.includes("reference checkout"));
    expect(reports).toHaveLength(1);
    expect(reports[0]![1].body).toContain("`scribble.txt`");
    expect(existsSync(lent.checkout.path)).toBe(false);
    expect(await run(["worktree", "list", "--porcelain"], repoPath)).not.toContain("eo-references");
  });

  it("takes the stories under a feature with it", async () => {
    const eo = repository();
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: eo.id });
    const story = createTestItem(handle.db, { type: "story", title: "The limiter", stepId: "todo", workspaceId: eo.id, parentId: feature.id });

    const result = await deleteItemCommand(handle.db, fakeEngine(), offline(), { ...NOTHING_EXTRA, itemId: feature.id }, attachmentStorage, worktreeRoot);

    expect(result.deletedCount).toBe(2);
    expect(getItem(handle.db, story.id)).toBeUndefined();
  });

  it("removes managed attachment files from the item and its descendants", async () => {
    const eo = repository();
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: eo.id });
    const story = createTestItem(handle.db, { type: "story", title: "The limiter", stepId: "todo", workspaceId: eo.id, parentId: feature.id });
    const paths = await Promise.all([addAttachment(feature.id, "brief.txt"), addAttachment(story.id, "implementation.txt")]);
    expect(paths.every(existsSync)).toBe(true);

    const result = await deleteItemCommand(
      handle.db,
      fakeEngine(),
      offline(),
      { ...NOTHING_EXTRA, itemId: feature.id },
      attachmentStorage,
      worktreeRoot,
    );

    expect(result).toMatchObject({ deleted: true, deletedCount: 2 });
    expect(paths.some(existsSync)).toBe(false);
  });

  it("removes the item's own files and their bytes, and those of its stories (EO-702)", async () => {
    const eo = repository();
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: eo.id });
    const story = createTestItem(handle.db, { type: "story", title: "The limiter", stepId: "todo", workspaceId: eo.id, parentId: feature.id });
    const own = async (itemId: Uuid, name: string): Promise<string> => {
      const draft = await attachmentStorage.stageData({ name, dataBase64: Buffer.from(name).toString("base64") });
      const records = await attachmentStorage.prepare([draft.id]);
      addItemAttachments(handle.db, itemId, records);
      await attachmentStorage.finish(records);
      return records[0]!.storagePath;
    };
    const paths = await Promise.all([own(feature.id, "mock.png"), own(story.id, "spec.pdf"), addAttachment(story.id, "said.txt")]);
    // A removal noted earlier goes with the item too.
    await own(story.id, "gone.txt");
    removeItemAttachment(handle.db, listItemAttachments(handle.db, story.id).find((file) => file.name === "gone.txt")!.id);
    expect(paths.every(existsSync)).toBe(true);

    const result = await deleteItemCommand(handle.db, fakeEngine(), offline(), { ...NOTHING_EXTRA, itemId: feature.id }, attachmentStorage, worktreeRoot);

    expect(result).toMatchObject({ deleted: true, deletedCount: 2 });
    expect(paths.some(existsSync)).toBe(false);
    expect(listAttachmentsForItem(handle.db, feature.id)).toEqual([]);
    expect(listAttachmentsForItem(handle.db, story.id)).toEqual([]);
    expect(handle.db.select().from(attachmentRemovals).all()).toEqual([]);
  });

  it("says so rather than failing when the item is already gone", async () => {
    const result = await deleteItemCommand(
      handle.db,
      fakeEngine(),
      offline(),
      { ...NOTHING_EXTRA, itemId: "01890000-0000-7000-8000-000000000000" },
      attachmentStorage,
      worktreeRoot,
    );

    expect(result).toMatchObject({ deleted: false, deletedCount: 0 });
    expect(result.problem).toContain("no longer exists");
  });

  it("closes a feature whose last unfinished story is the one deleted", async () => {
    // A feature's state is derived from its stories (U-12). One done,
    // one in todo, delete the todo — the feature is complete, and
    // nothing but this would notice.
    const eo = repository();
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: eo.id });
    createTestItem(handle.db, { type: "story", title: "Done", stepId: "ready_to_merge", workspaceId: eo.id, parentId: feature.id });
    const unfinished = createTestItem(handle.db, { type: "story", title: "Not done", stepId: "todo", workspaceId: eo.id, parentId: feature.id });

    await deleteItemCommand(handle.db, fakeEngine(), offline(), { ...NOTHING_EXTRA, itemId: unfinished.id }, attachmentStorage, worktreeRoot);

    // Derived, not written (ARCHITECTURE.md, "One work entity"): deleting the last unfinished story
    // makes the feature finished, and nothing had to be told.
    expect(featureIsDone(featureProgress(handle.db, feature.id))).toBe(true);
  });

  it("leaves a feature alone while a story under it is still live", async () => {
    const eo = repository();
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: eo.id });
    createTestItem(handle.db, { type: "story", title: "Still going", stepId: "todo", workspaceId: eo.id, parentId: feature.id });
    const other = createTestItem(handle.db, { type: "story", title: "Dropped", stepId: "todo", workspaceId: eo.id, parentId: feature.id });

    await deleteItemCommand(handle.db, fakeEngine(), offline(), { ...NOTHING_EXTRA, itemId: other.id }, attachmentStorage, worktreeRoot);

    expect(featureProgress(handle.db, feature.id)).toEqual({ done: 0, total: 1 });
  });

  describe("a run in flight", () => {
    function runningOn(itemId: Uuid) {
      const agent = listAgents(handle.db).find((entry) => entry.role === "implementer")!;
      return createRun(handle.db, { itemId, agentId: agent.id, action: "implement", status: "running" });
    }

    it("refuses, rather than discarding an agent's work silently", async () => {
      const eo = repository();
      const item = createTestItem(handle.db, { type: "story", title: "Busy", stepId: "todo", workspaceId: eo.id });
      runningOn(item.id);

      const result = await deleteItemCommand(handle.db, fakeEngine(), offline(), { ...NOTHING_EXTRA, itemId: item.id }, attachmentStorage, worktreeRoot);

      expect(result).toMatchObject({ deleted: false, blockedByActiveRun: true });
      expect(result.problem).toContain(item.key);
      expect(getItem(handle.db, item.id)).toBeDefined();
    });

    it("notices a run on a story when the feature is what was clicked", async () => {
      // The clicked item is idle; the one being deleted along with it
      // is not. Checking only the clicked item would sail straight
      // past this.
      const eo = repository();
      const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: eo.id });
      const story = createTestItem(handle.db, { type: "story", title: "Busy", stepId: "todo", workspaceId: eo.id, parentId: feature.id });
      runningOn(story.id);

      const result = await deleteItemCommand(handle.db, fakeEngine(), offline(), { ...NOTHING_EXTRA, itemId: feature.id }, attachmentStorage, worktreeRoot);

      expect(result.blockedByActiveRun).toBe(true);
      expect(result.problem).toContain(story.key);
    });

    it("cancels the run and deletes once the caller says it meant it", async () => {
      const eo = repository();
      const item = createTestItem(handle.db, { type: "story", title: "Busy", stepId: "todo", workspaceId: eo.id });
      const live = runningOn(item.id);
      const engine = fakeEngine();

      const result = await deleteItemCommand(
        handle.db,
        engine,
        offline(),
        { ...NOTHING_EXTRA, itemId: item.id, cancelActiveRun: true },
        attachmentStorage,
        worktreeRoot,
      );

      expect(result.deleted).toBe(true);
      expect(engine.cancelled).toEqual([live.id]);
      expect(getItem(handle.db, item.id)).toBeUndefined();
    });
  });

  describe("a worktree it is holding", () => {
    it("releases a clean one, keeping the branch", async () => {
      const eo = repository();
      const item = createTestItem(handle.db, { type: "story", title: "Done", stepId: "ready_to_merge", workspaceId: eo.id });
      await createWorktree(worktreeConfig(), item.key);

      const result = await deleteItemCommand(handle.db, fakeEngine(), offline(), { ...NOTHING_EXTRA, itemId: item.id }, attachmentStorage, worktreeRoot);

      expect(result.deleted).toBe(true);
      expect(existsSync(worktreePathFor(item.key, worktreeRoot))).toBe(false);
      // Committed work is never lost here, the same rule worktrees:release follows.
      const branches = await git(["branch", "--list", branchNameFor(item.key)], repoPath);
      expect(branches.ok && branches.stdout.trim()).not.toBe("");
    });

    it("refuses while there is uncommitted work in it", async () => {
      // That work exists nowhere else, and deleting the item is what
      // makes the leftover directory unreadable — nothing would say what
      // EO-1 was.
      const eo = repository();
      const item = createTestItem(handle.db, { type: "story", title: "Half done", stepId: "todo", workspaceId: eo.id });
      await createWorktree(worktreeConfig(), item.key);
      writeFileSync(join(worktreePathFor(item.key, worktreeRoot), "limiter.ts"), "export const limit = 100;\n");

      const result = await deleteItemCommand(handle.db, fakeEngine(), offline(), { ...NOTHING_EXTRA, itemId: item.id }, attachmentStorage, worktreeRoot);

      expect(result).toMatchObject({ deleted: false, blockedByUncommittedWork: true });
      expect(result.problem).toContain(item.key);
      expect(getItem(handle.db, item.id)).toBeDefined();
      expect(existsSync(worktreePathFor(item.key, worktreeRoot))).toBe(true);
    });

    it("does not refuse over files that are only in the directory git was told to ignore (EO-413)", async () => {
      // A screenshot an agent made to attach is not work on the branch:
      // it is already attached, git was told never to look at the
      // directory it sits in, and refusing over it would be the EO-206
      // refusal over the index all over again.
      const eo = repository();
      const item = createTestItem(handle.db, { type: "story", title: "Done, with evidence", stepId: "todo", workspaceId: eo.id });
      await createWorktree(worktreeConfig(), item.key);
      const path = worktreePathFor(item.key, worktreeRoot);
      mkdirSync(join(path, TICKET_FILES_DIRECTORY), { recursive: true });
      writeFileSync(join(path, TICKET_FILES_DIRECTORY, "test.log"), "41 passed\n");

      const result = await deleteItemCommand(handle.db, fakeEngine(), offline(), { ...NOTHING_EXTRA, itemId: item.id }, attachmentStorage, worktreeRoot);

      expect(result.deleted).toBe(true);
      expect(result.blockedByUncommittedWork).toBeFalsy();
      expect(getItem(handle.db, item.id)).toBeUndefined();
      expect(existsSync(path)).toBe(false);
    });

    it("discards it when the caller has looked at it and said so", async () => {
      const eo = repository();
      const item = createTestItem(handle.db, { type: "story", title: "Half done", stepId: "todo", workspaceId: eo.id });
      await createWorktree(worktreeConfig(), item.key);
      writeFileSync(join(worktreePathFor(item.key, worktreeRoot), "limiter.ts"), "export const limit = 100;\n");

      const result = await deleteItemCommand(
        handle.db,
        fakeEngine(),
        offline(),
        { ...NOTHING_EXTRA, itemId: item.id, discardUncommitted: true },
        attachmentStorage,
        worktreeRoot,
      );

      expect(result.deleted).toBe(true);
      expect(existsSync(worktreePathFor(item.key, worktreeRoot))).toBe(false);
    });

    // Issue #131: on Windows the removal fails, the rows go anyway, and
    // the response used to say the delete succeeded with nothing amiss
    // — leaving a directory named after an item that no longer exists
    // to explain it.
    it("still deletes the rows when the checkout will not go, and names what was left on disk", async () => {
      const eo = repository();
      const item = createTestItem(handle.db, { type: "story", title: "Stranded", stepId: "ready_to_merge", workspaceId: eo.id });
      await createWorktree(worktreeConfig(), item.key);
      const path = worktreePathFor(item.key, worktreeRoot);
      // A worktree git refuses to remove and whose status it cannot read
      // either: the reproducible stand-in for the Windows path-length
      // failure, which cannot be conjured on this machine.
      rmSync(join(path, ".git"));

      const result = await deleteItemCommand(handle.db, fakeEngine(), offline(), { ...NOTHING_EXTRA, itemId: item.id }, attachmentStorage, worktreeRoot);

      // What was asked for still happened.
      expect(result.deleted).toBe(true);
      expect(getItem(handle.db, item.id)).toBeUndefined();
      // And what did not is named rather than dropped.
      expect(result.leftoverWorktrees).toHaveLength(1);
      expect(result.leftoverWorktrees[0]?.itemKey).toBe(item.key);
      // `samePath`, not string equality: this path came back from
      // `git worktree list`, and git answers in its own spelling — on
      // Windows, forward slashes and the long form of a directory Node
      // handed us as `C:\Users\RUNNER~1\...`. Same directory, and
      // that is what is being asserted.
      expect(samePath(result.leftoverWorktrees[0]?.path ?? "", path)).toBe(true);
      expect(result.leftoverWorktrees[0]?.problem).toContain("Could not remove the worktree");
      expect(existsSync(path)).toBe(true);
    });

    it("reports nothing left behind when the release went through", async () => {
      const eo = repository();
      const item = createTestItem(handle.db, { type: "story", title: "Done", stepId: "ready_to_merge", workspaceId: eo.id });
      await createWorktree(worktreeConfig(), item.key);

      const result = await deleteItemCommand(handle.db, fakeEngine(), offline(), { ...NOTHING_EXTRA, itemId: item.id }, attachmentStorage, worktreeRoot);

      expect(result.leftoverWorktrees).toEqual([]);
    });

    it("deletes an item that never had one", async () => {
      const eo = repository();
      const item = createTestItem(handle.db, { type: "story", title: "Never started", stepId: "todo", workspaceId: eo.id });

      expect((await deleteItemCommand(handle.db, fakeEngine(), offline(), { ...NOTHING_EXTRA, itemId: item.id }, attachmentStorage, worktreeRoot)).deleted).toBe(
        true,
      );
    });
  });

  describe("the Jira issue behind it", () => {
    /**
     * A repository whose *project* is wired to a Jira that answers
     * whatever `fetchImpl` says.
     *
     * The project is handed back beside the repository because the two
     * are now different rows and an item here needs both (KAN-130): the
     * worktree is cut from the workspace, and the issue is reached
     * through the project's binding. An item given only the workspace
     * carries a Jira key with no Jira behind it, which is not a state
     * anything in EO creates.
     */
    function connected(fetchImpl: FetchLike): { context: JiraContext; repository: Workspace; projectId: Uuid } {
      const eo = repository();
      const connection = createJiraConnection(handle.db, {
        name: "Acme",
        baseUrl: "https://acme.atlassian.net",
        flavour: "cloud",
        email: "dev@acme.com",
      });
      storeToken({ directory: credentialsDir, store }, connection.id, "secret-token");
      const project = projectForWorkspace(handle.db, eo.id)!;
      saveJiraBinding(handle.db, project.id, {
        connectionId: connection.id,
        projectKey: "ACME",
        featureIssueType: "Epic",
        storyIssueType: "Story",
      });

      return { context: { credentials: { directory: credentialsDir, store }, fetchImpl }, repository: eo, projectId: project.id };
    }

    it("touches nothing in Jira when the box is left unticked", async () => {
      const fetchImpl = vi.fn<FetchLike>(async () => new Response("{}", { status: 200 }));
      const { context, repository: eo, projectId } = connected(fetchImpl);
      const item = createTestItem(handle.db, { type: "story", title: "Linked", stepId: "todo", workspaceId: eo.id, projectId });
      updateItem(handle.db, item.id, { jiraKey: "ACME-7" });

      const result = await deleteItemCommand(handle.db, fakeEngine(), context, { ...NOTHING_EXTRA, itemId: item.id }, attachmentStorage, worktreeRoot);

      expect(result.deleted).toBe(true);
      expect(result.jira).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("deletes the issues children first when the box is ticked", async () => {
      // A parent deleted before its stories is an issue Jira refuses to
      // remove, so the order is part of the contract.
      const seen: string[] = [];
      const fetchImpl: FetchLike = async (url, init) => {
        if (init?.method === "DELETE") seen.push(new URL(url).pathname.split("/").pop()!);
        return new Response(null, { status: 204 });
      };
      const { context, repository: eo, projectId } = connected(fetchImpl);
      const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: eo.id, projectId });
      const story = createTestItem(handle.db, { type: "story", title: "The limiter", stepId: "todo", workspaceId: eo.id, projectId, parentId: feature.id });
      updateItem(handle.db, feature.id, { jiraKey: "ACME-1" });
      updateItem(handle.db, story.id, { jiraKey: "ACME-2" });

      const result = await deleteItemCommand(
        handle.db,
        fakeEngine(),
        context,
        { ...NOTHING_EXTRA, itemId: feature.id, deleteInJira: true },
        attachmentStorage,
        worktreeRoot,
      );

      expect(result.jira).toMatchObject({ attempted: 2, deleted: 2, problem: null });
      expect(seen).toEqual(["ACME-2", "ACME-1"]);
    });

    it("reports a refused permission plainly, and still deletes locally", async () => {
      // The two are not one transaction. Rolling the local delete back
      // would leave the user with an item they asked to be rid of and
      // no record of why it is still there.
      const fetchImpl: FetchLike = async () =>
        new Response(JSON.stringify({ errorMessages: ["You do not have permission to delete issues in this repository."] }), { status: 403 });
      const { context, repository: eo, projectId } = connected(fetchImpl);
      const item = createTestItem(handle.db, { type: "story", title: "Linked", stepId: "todo", workspaceId: eo.id, projectId });
      updateItem(handle.db, item.id, { jiraKey: "ACME-7" });

      const result = await deleteItemCommand(
        handle.db,
        fakeEngine(),
        context,
        { ...NOTHING_EXTRA, itemId: item.id, deleteInJira: true },
        attachmentStorage,
        worktreeRoot,
      );

      expect(result.deleted).toBe(true);
      expect(getItem(handle.db, item.id)).toBeUndefined();
      expect(result.jira).toMatchObject({ attempted: 1, deleted: 0 });
      expect(result.jira?.problem).toContain("permission");
      expect(result.jira?.problem).toContain("ACME-7");
    });

    it("leaves the issue standing when the item's Jira sync is off, and names what it spared", async () => {
      // The switch means invisible to Jira in both directions (EO-122).
      // This is the sharpest case for it: the EO item goes away
      // entirely, so the issue is the only thing left that explains the
      // work, and it was deliberately put out of EO's reach.
      const fetchImpl = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
      const { context, repository: eo, projectId } = connected(fetchImpl);
      const item = createTestItem(handle.db, { type: "story", title: "Silenced", stepId: "todo", workspaceId: eo.id, projectId });
      updateItem(handle.db, item.id, { jiraKey: "ACME-7" });
      setJiraSync(handle.db, item.id, false);

      const result = await deleteItemCommand(
        handle.db,
        fakeEngine(),
        context,
        { ...NOTHING_EXTRA, itemId: item.id, deleteInJira: true },
        attachmentStorage,
        worktreeRoot,
      );

      // Not one request to Jira.
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result.jira).toMatchObject({ attempted: 0, deleted: 0 });
      expect(result.jira?.problem).toContain("Jira sync is off");
      // Which issue survived, by name — a silent skip is how somebody
      // finds a stray issue months later with nothing to explain it.
      expect(result.jira?.problem).toContain("ACME-7");
      // The local delete is untouched: the switch is about Jira, not EO.
      expect(result.deleted).toBe(true);
      expect(getItem(handle.db, item.id)).toBeUndefined();
    });

    it("deletes a syncing feature's issue while sparing the one silenced story under it", async () => {
      // Per item, not per set. Deciding this for the whole set either
      // way would be wrong: one silenced story must not save the
      // feature's issue, and the feature syncing must not doom the story's.
      const seen: string[] = [];
      const fetchImpl: FetchLike = async (url, init) => {
        if (init?.method === "DELETE") seen.push(new URL(url).pathname.split("/").pop()!);
        return new Response(null, { status: 204 });
      };
      const { context, repository: eo, projectId } = connected(fetchImpl);
      const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: eo.id, projectId });
      const loud = createTestItem(handle.db, { type: "story", title: "The limiter", stepId: "todo", workspaceId: eo.id, projectId, parentId: feature.id });
      const quiet = createTestItem(handle.db, { type: "story", title: "Silenced", stepId: "todo", workspaceId: eo.id, projectId, parentId: feature.id });
      updateItem(handle.db, feature.id, { jiraKey: "ACME-1" });
      updateItem(handle.db, loud.id, { jiraKey: "ACME-2" });
      updateItem(handle.db, quiet.id, { jiraKey: "ACME-3" });
      setJiraSync(handle.db, quiet.id, false);

      const result = await deleteItemCommand(
        handle.db,
        fakeEngine(),
        context,
        { ...NOTHING_EXTRA, itemId: feature.id, deleteInJira: true },
        attachmentStorage,
        worktreeRoot,
      );

      // The two that sync, still children first. ACME-3 is untouched.
      expect(seen).toEqual(["ACME-2", "ACME-1"]);
      expect(result.jira).toMatchObject({ attempted: 2, deleted: 2 });
      expect(result.jira?.problem).toContain("ACME-3");
      // All three items went locally — only the remote half was filtered.
      expect(result.deletedCount).toBe(3);
      expect(getItem(handle.db, quiet.id)).toBeUndefined();
    });

    it("says there was nothing to delete when no item is linked", async () => {
      const { context, repository: eo, projectId } = connected(async () => new Response("{}", { status: 200 }));
      const item = createTestItem(handle.db, { type: "story", title: "Never pushed", stepId: "todo", workspaceId: eo.id, projectId });

      const result = await deleteItemCommand(
        handle.db,
        fakeEngine(),
        context,
        { ...NOTHING_EXTRA, itemId: item.id, deleteInJira: true },
        attachmentStorage,
        worktreeRoot,
      );

      expect(result.deleted).toBe(true);
      expect(result.jira).toMatchObject({ attempted: 0, deleted: 0 });
      expect(result.jira?.problem).toContain("linked to a Jira issue");
    });
  });
});
