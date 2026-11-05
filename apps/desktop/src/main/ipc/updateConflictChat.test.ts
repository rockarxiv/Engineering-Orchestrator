import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentProvider, AgentProviderStartOptions, Item, Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  createPipeline,
  createStep,
  deleteItem,
  getItem,
  getUpdateConflict,
  listCommentsForItem,
  listMentionsForComment,
  listRunsForItem,
  openUpdateConflict,
  resolveUpdateConflict,
  setItemArchived,
  setSetting,
} from "../db/repos/index.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { loadTemplateHistory } from "../gallery/history.js";
import { backfillPipelineOrigins } from "../gallery/origins.js";
import { applyTemplateUpdates } from "../gallery/templateUpdates.js";
import { findProjectThread } from "../projects/projectThread.js";
import { createFakeProvider } from "../providers/fake.js";
import { SHOWN_ASSIST_KEY, assistAgent, assistBoards, listAssistThreads, postAssistReply, shownAssistConversation } from "../roles/assist.js";
import { ASSIST_ACTION, ASSIST_STEP } from "../roles/conversationSteps.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { openUpdateConflictAssist } from "./assistCommands.js";
import { clearPublishedView } from "./currentView.js";
import type { EngineHandle } from "./domainCommands.js";

/**
 * Fix with assistant (EO-533): pressing the conflict notice's button
 * opens a new assistant chat whose first message is EO's brief, with the
 * pipeline as its subject, and the assistant's first turn starts without
 * the person typing. Pressing it again shows the same chat.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  clearPublishedView();
  handle.close();
});

/**
 * EO's own Delivery, customised before EO-461: the 1.1 update is held,
 * and the notice posted — on the thread of the project that adopted it,
 * or, unadopted, on each of two projects with work on it.
 */
function heldUpdate(adopted = true): { conflictId: string; noticeId: string; projectId: Uuid; noticeIds: string[]; projectIds: Uuid[] } {
  const merge = createPipeline(handle.db, { projectId: null, name: "Merge" });
  createStep(handle.db, { id: "merge_pr", pipelineId: merge.id as Uuid, position: 0, name: "Merge PR", type: "user" });
  createStep(handle.db, { pipelineId: merge.id as Uuid, position: 1, name: "Merged", type: "user", isTerminal: true });
  handle.db.run(sql`DELETE FROM step_routes WHERE from_step_id = 'pull_request_watch'`);
  handle.db.run(sql`UPDATE pipeline_steps SET retired_version = 1 WHERE id = 'pull_request_watch'`);
  handle.db.run(sql`UPDATE step_routes SET target = 'merge_pr' WHERE from_step_id = 'merge_request' AND result_key = 'opened'`);
  const history = loadTemplateHistory(GALLERY_DIRECTORY);
  backfillPipelineOrigins(handle.db, history);
  const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
  const projectIds = [shop.id as Uuid];
  if (adopted) {
    handle.db.run(sql`UPDATE pipelines SET project_id = ${shop.id} WHERE id = 'default'`);
  } else {
    const blog = createProject(handle.db, { name: "Blog", keyPrefix: "BLOG" });
    projectIds.push(blog.id as Uuid);
    for (const projectId of projectIds) createTestItem(handle.db, { type: "story", title: "Work", stepId: "todo", projectId });
  }
  applyTemplateUpdates(handle.db, history, { isTheRecord: false });
  const conflict = openUpdateConflict(handle.db, "default")!;
  return { conflictId: conflict.id, noticeId: conflict.noticeCommentIds[0]!, projectId: shop.id as Uuid, noticeIds: conflict.noticeCommentIds, projectIds };
}

function engineStub(): EngineHandle & { notifyStateChange: ReturnType<typeof vi.fn> } {
  return { notifyStateChange: vi.fn() } as unknown as EngineHandle & { notifyStateChange: ReturnType<typeof vi.fn> };
}

function press(conflictId: string, commentId: string | null, engine: EngineHandle | undefined = engineStub()) {
  return openUpdateConflictAssist(handle.db, engine, { conflictId, commentId });
}

/** The fake provider, answering an assist turn, with what each turn it started was given. */
function recordingProvider(): { provider: AgentProvider; started: AgentProviderStartOptions[] } {
  const fake = createFakeProvider({ steps: [{ output: "Reading the conflict." }], result: { message: "I read the three versions; here are my drafts." } });
  const started: AgentProviderStartOptions[] = [];
  return {
    started,
    provider: {
      ...fake,
      start(options) {
        started.push(options);
        return fake.start(options);
      },
    },
  };
}

describe("pressing Fix with assistant", () => {
  it("creates a new chat whose first message is EO's brief, with the pipeline as its subject, and dispatches the first turn without anybody typing", async () => {
    const { conflictId, noticeId, projectId } = heldUpdate();
    const engine = engineStub();

    const opened = await press(conflictId, noticeId, engine);

    expect(opened.problem).toBeNull();
    const chat = getItem(handle.db, opened.conversation!.id as Uuid)!;
    expect(chat.stepId).toBe(ASSIST_STEP);
    expect(chat.projectId).toBe(projectId);
    // On show, and recorded on the conflict.
    expect(shownAssistConversation(handle.db)?.id).toBe(chat.id);
    expect(getUpdateConflict(handle.db, conflictId)?.chatId).toBe(chat.id);

    // EO's brief, first and only, asking the assistant.
    const comments = listCommentsForItem(handle.db, chat.id);
    expect(comments).toHaveLength(1);
    const brief = comments[0]!;
    expect(brief.authorType).toBe("engine");
    expect(brief.body).toContain("Pipeline: Delivery (id: default)");
    expect(brief.body).toContain("from version 1.0 (the pipeline's base) to version 1.2");
    expect(brief.body).toContain("CI failures, merge conflicts and review comments send the work back to the implementer");
    expect(brief.body).toContain("**Merge Request**'s 'opened' route");
    expect(opened.conversation!.messages.map((message) => message.id)).toEqual([brief.id]);
    const assistant = assistAgent(handle.db)!;
    expect(listMentionsForComment(handle.db, brief.id as Uuid)).toEqual([expect.objectContaining({ targetType: "agent", targetId: assistant.id, status: "open" })]);
    // The pipeline is the board a draft raised in answer is published against.
    expect(assistBoards(chat)).toEqual([{ from: brief.id, pipelineId: "default" }]);
    // Listed by what it is about, before the person has said anything.
    expect(listAssistThreads(handle.db).find((thread) => thread.conversation.id === chat.id)?.title).toBe('Resolve the held template update to the pipeline "Delivery".');
    // The scheduler is woken at once.
    expect(engine.notifyStateChange).toHaveBeenCalledWith({ promptly: true });

    // The turn: dispatched on the brief by the next tick, with the fake provider.
    const { provider, started } = recordingProvider();
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider,
      limits: LIMITS,
      onRunSucceeded: (item: Item, agent: Agent, action: string, parsedResult: unknown, runId: Uuid): void => {
        if (action === ASSIST_ACTION) postAssistReply(handle.db, item, agent.id, runId, parsedResult);
      },
    });
    await supervisor.runOnce();

    const runs = listRunsForItem(handle.db, chat.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ action: ASSIST_ACTION, agentId: assistant.id, initiationId: brief.id, status: "succeeded" });
    expect(started).toHaveLength(1);
    expect(started[0]!.context).toContain("Pipeline: Delivery (id: default)");
    const answered = listCommentsForItem(handle.db, chat.id).filter((comment) => comment.authorType === "agent");
    expect(answered.map((comment) => comment.body).join("\n")).toContain("here are my drafts");
    // Asked once: the brief's mention is not offered again.
    expect(listMentionsForComment(handle.db, brief.id as Uuid).map((mention) => mention.status)).not.toContain("open");
  });

  it("opens the same chat when pressed again while that chat exists, from any copy of the notice", async () => {
    const { conflictId, noticeId } = heldUpdate();
    const first = (await press(conflictId, noticeId)).conversation!;
    // The person moves on to a chat of their own.
    const other = createTestItem(handle.db, { type: "feature", title: "Assistance", stepId: ASSIST_STEP, projectId: null });
    setSetting(handle.db, SHOWN_ASSIST_KEY, other.id);
    expect(shownAssistConversation(handle.db)?.id).toBe(other.id);

    const again = await press(conflictId, null);

    expect(again.problem).toBeNull();
    expect(again.conversation!.id).toBe(first.id);
    expect(shownAssistConversation(handle.db)?.id).toBe(first.id);
    // Still the one brief: nothing posted, nothing dispatched again.
    expect(listCommentsForItem(handle.db, first.id as Uuid)).toHaveLength(1);
  });

  it("brings back a chat that was put away, and starts a new one where the chat was removed", async () => {
    const { conflictId, noticeId } = heldUpdate();
    const first = (await press(conflictId, noticeId)).conversation!;

    setItemArchived(handle.db, first.id as Uuid, Date.now());
    const back = await press(conflictId, noticeId);
    expect(back.conversation!.id).toBe(first.id);
    expect(getItem(handle.db, first.id as Uuid)?.archivedAt).toBeNull();

    deleteItem(handle.db, first.id as Uuid);
    const fresh = await press(conflictId, noticeId);
    expect(fresh.conversation!.id).not.toBe(first.id);
    expect(getUpdateConflict(handle.db, conflictId)?.chatId).toBe(fresh.conversation!.id);
  });

  it("opens the chat of a pipeline no project adopted on the project whose notice was pressed, and the same chat from the other's", async () => {
    const { conflictId, noticeIds, projectIds } = heldUpdate(false);
    expect(noticeIds).toHaveLength(2);
    const blogThread = findProjectThread(handle.db, projectIds[1]!)!;
    const onBlog = noticeIds.find((id) => listCommentsForItem(handle.db, blogThread.id as Uuid).some((comment) => comment.id === id))!;
    const onShop = noticeIds.find((id) => id !== onBlog)!;

    const opened = await press(conflictId, onBlog);

    expect(getItem(handle.db, opened.conversation!.id as Uuid)?.projectId).toBe(projectIds[1]);
    expect((await press(conflictId, onShop)).conversation!.id).toBe(opened.conversation!.id);
  });

  it("is refused, writing nothing, for a conflict this installation does not hold or one resolved before any chat", async () => {
    const { conflictId, noticeId } = heldUpdate();

    expect(await press("no-such-conflict", null)).toEqual({ conversation: null, problem: "That template update is not held here any more." });

    resolveUpdateConflict(handle.db, conflictId, "kept");
    expect(await press(conflictId, noticeId)).toEqual({ conversation: null, problem: "That template update has already been resolved." });
    expect(getUpdateConflict(handle.db, conflictId)?.chatId).toBeNull();
  });
});
