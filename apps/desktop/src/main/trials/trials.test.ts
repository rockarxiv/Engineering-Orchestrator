import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN_MCP_SERVER_NAME,
  AssistOutputSchema,
  NONE_KIND,
  RecordItemSchema,
  RecordPipelineSchema,
  RecordProjectSchema,
  SCRATCH_KIND,
  ipcContract,
  jiraStateOf,
  pageDescriptorFor,
  type AssistOutput,
  type CustomModule,
  type Item,
  type ModuleManifest,
  type Uuid,
} from "@eo/core";
import { tick } from "@eo/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import {
  activeTrialGrants,
  approveModule,
  getModule,
  grantTrial,
  listModuleVersions,
  listTrialGrantsForModule,
  moduleForkedFrom,
  moduleInLiveUse,
  restoreModuleVersion,
  appendRunEvent,
  createPerson,
  createPipeline,
  createAgent,
  createRunEventBuffer,
  getProject,
  markTrialPipeline,
  saveModule,
  createProject,
  createRun,
  createWorkspace,
  currentVersion,
  getItem,
  getPipeline,
  getTrialPipeline,
  listAgents,
  listCommentsForItem,
  listItemsIncludingArchived,
  listPipelines,
  listPipelineVersions,
  listRoutesForPipeline,
  listStepsForPipeline,
  needsAttention,
  postComment,
  replacePipelineGraph,
  setItemArchived,
  sumCostCentsForItem,
  sumCostCentsSince,
  updateRun,
} from "../db/repos/index.js";
import { listPipelinesUpdatedSince, readProjectItems, readProjectItemTypes, readProjectPipelines, writeAdoptedPage, writeAdoptedProject } from "../db/repos/projectMoveRepo.js";
import { markProjectOnTheRecord } from "../db/repos/projectsRepo.js";
import { upsertReplicaItem } from "../db/repos/replicaRepo.js";
import { upsertReplicaPipeline } from "../db/repos/projectMoveRepo.js";
import { itemTypes, pipelines, pipelineSteps, projects, stepRoutes, workspaces } from "../db/schema.js";
import { trialCreationRefusal } from "../modules/moduleCreations.js";
import { createModuleRunnerLookup } from "../modules/registry.js";
import { asRecordItem } from "../record/serveRecord.js";
import { preparingAt } from "../supervisor/testWorkspaceKinds.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { readAssistDraftForPublish, sendToAssist } from "../ipc/assistCommands.js";
import { DEFAULT_GUARD_CONFIG } from "../ipc/configCommands.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { getDailyCost } from "../ipc/costHandlers.js";
import { clearPublishedView } from "../ipc/currentView.js";
import { deleteConversationItem } from "../ipc/deleteConversationItem.js";
import { listArchivedSummaries, listInbox, listItemSummaries, listPipelineViews } from "../ipc/domainQueries.js";
import { clearHandlerRegistry } from "../ipc/registry.js";
import { renderSpend } from "../mcpHost/render.js";
import { exportPipeline } from "../modules/pipelineTransfer.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { formatDateKey } from "../dateUtils.js";
import { buildTickInput } from "../supervisor/buildTickInput.js";
import { discardTrial } from "./discard.js";
import { createTrialFromDraft, fileTrialItem } from "./trials.js";
import { eq } from "drizzle-orm";

/**
 * Trial pipelines (EO-582): a draft materialised as a hidden pipeline,
 * trial items filed on it, kept out of everything a person browses,
 * counted in the budgets, ordered first while their loop runs, and
 * discarded through the item-delete path — leaving the pipeline the
 * draft would replace exactly as it was.
 *
 * Every test is on an in-memory database. The draft cards are posted the
 * way a turn posts them (`postAssistReply`), as `assistDraftTuning.test.ts`
 * does.
 */
let handle: DbHandle;
let scratch: string;
let attachments: AttachmentStorage;
let projectId: Uuid;
let workspaceId: Uuid;

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-trials-"));
  attachments = new AttachmentStorage(join(scratch, "attachments"));
  projectId = createProject(handle.db, { name: "Home", keyPrefix: "HOM" }).id as Uuid;
  workspaceId = createWorkspace(handle.db, { kind: SCRATCH_KIND, projectId }).id as Uuid;
});

afterEach(() => {
  clearHandlerRegistry();
  clearPublishedView();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

const PIPELINE_READ = `mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_get`;

function rowOf(id: string): Item {
  return getItem(handle.db, id as Uuid)!;
}

async function conversationOn(path: string): Promise<Item> {
  const sent = await sendToAssist(handle.db, undefined, { page: pageDescriptorFor(path), conversationId: null, body: "test this with real runs", attachmentIds: [], interrupt: false });
  return rowOf(sent.conversation.id);
}

function newestQuestion(conversation: Item): Uuid {
  return listCommentsForItem(handle.db, conversation.id)
    .filter((comment) => comment.authorType === "human")
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .at(-1)!.id;
}

/** A succeeded assist turn carrying `output`, having read `readPipeline` if given; the draft cards it posted. */
function turn(conversation: Item, output: unknown, readPipeline?: string): Uuid[] {
  const parsed: AssistOutput = AssistOutputSchema.parse(output);
  const agent = assistAgent(handle.db)!;
  const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION, initiationId: newestQuestion(conversation) });
  if (readPipeline !== undefined) {
    appendRunEvent(handle.db, run.id, "tool_call", { name: PIPELINE_READ, args: { pipelineId: readPipeline }, callId: "call-0" });
    appendRunEvent(handle.db, run.id, "tool_result", { name: PIPELINE_READ, callId: "call-0", ok: true, output: "", truncated: false });
  }
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(parsed), parsed } });
  postAssistReply(handle.db, conversation, agent.id, run.id, parsed);
  const posted = listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.runId === run.id);
  const rejections = posted.filter((comment) => comment.kind === "rejection").map((comment) => comment.body);
  expect(rejections).toEqual([]);
  return posted.filter((comment) => comment.kind === PROPOSAL_KIND).map((comment) => comment.id);
}

const step = (id: string, position: number, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  position,
  name,
  type: "user",
  ownerRole: null,
  entryAction: null,
  instructionsSummary: null,
  isTerminal: false,
  planMode: false,
  ...extra,
});

/** Hotfix as it is published: Fix, then Done. */
function hotfix(): string {
  const pipeline = createPipeline(handle.db, { projectId, name: "Hotfix" });
  replacePipelineGraph(
    handle.db,
    pipeline.id,
    [
      { id: "hotfix_fix", pipelineId: pipeline.id as Uuid, position: 0, name: "Fix", type: "agent", ownerRole: "implementer", entryAction: "implement", isTerminal: false },
      { id: "hotfix_done", pipelineId: pipeline.id as Uuid, position: 1, name: "Done", type: "user", isTerminal: true },
    ],
    [{ pipelineId: pipeline.id as Uuid, fromStepId: "hotfix_fix", resultKey: "done", label: "Done", tone: "success", target: "hotfix_done", position: 0 }],
    { entryStepId: "hotfix_fix" },
  );
  return pipeline.id;
}

/** A draft of Hotfix with a person checking the fix before Done. */
function hotfixWithCheck(target: Record<string, string>, routes: Record<string, unknown>[] = []) {
  return {
    rationale: "A person checks the fix before it is done.",
    entryStepId: "hotfix_fix",
    target,
    steps: [
      step("hotfix_fix", 0, "Fix", { type: "agent", ownerRole: "implementer", entryAction: "implement" }),
      step("hotfix_check", 1, "Check"),
      step("hotfix_done", 2, "Done", { isTerminal: true }),
    ],
    routes: [
      { fromStepId: "hotfix_fix", resultKey: "done", label: "Done", tone: "success", target: "hotfix_check", position: 0 },
      { fromStepId: "hotfix_check", resultKey: "approve", label: "Approve", tone: "success", target: "hotfix_done", position: 0 },
      { fromStepId: "hotfix_check", resultKey: "send_back", label: "Send back", tone: "warning", target: "hotfix_fix", position: 1 },
      ...routes,
    ],
  };
}

/** The draft card for a change to Hotfix, and the conversation it is in. */
async function draftOfHotfix(pipelineId: string): Promise<{ conversation: Item; messageId: Uuid }> {
  const conversation = await conversationOn(`/pipelines/${pipelineId}`);
  const [messageId] = turn(conversation, { message: "Here.", draft: hotfixWithCheck({ pipelineId }) }, pipelineId);
  return { conversation, messageId: messageId! };
}

/** A graph with ids, pipeline ids and route ids taken out, steps by position — what "the same graph" means. */
function shapeOf(steps: readonly { id: string; position: number }[], routes: readonly { fromStepId: string; target: string; resultKey: string }[], nameOf: (id: string) => string) {
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  return {
    steps: ordered.map(({ id: _id, pipelineId: _pipelineId, ...rest }: { id: string; pipelineId?: string; position: number }) => rest),
    routes: routes
      .map(({ id: _id, pipelineId: _pipelineId, fromStepId, target, ...rest }: { id?: string; pipelineId?: string; fromStepId: string; target: string; resultKey: string }) => ({
        ...rest,
        from: nameOf(fromStepId),
        to: nameOf(target),
      }))
      .sort((a, b) => `${a.from}/${a.resultKey}`.localeCompare(`${b.from}/${b.resultKey}`)),
  };
}

/** Everything about a pipeline that a trial must never change. */
function snapshotOf(pipelineId: string) {
  return {
    pipeline: getPipeline(handle.db, pipelineId),
    steps: handle.db.select().from(pipelineSteps).where(eq(pipelineSteps.pipelineId, pipelineId)).all(),
    routes: handle.db.select().from(stepRoutes).where(eq(stepRoutes.pipelineId, pipelineId)).all(),
    versions: listPipelineVersions(handle.db, pipelineId),
    items: listItemsIncludingArchived(handle.db).filter((item) => item.pipelineId === pipelineId),
  };
}

function trialFrom(conversation: Item, messageId: Uuid) {
  const made = createTrialFromDraft(handle.db, undefined, { conversationId: conversation.id, messageId });
  if (!made.ok) throw new Error(made.problem);
  return made;
}

function fileOn(trialPipelineId: string, title = "A test item"): Item {
  const filed = fileTrialItem(handle.db, undefined, { trialPipelineId, type: "story", title });
  if (!filed.ok) throw new Error(filed.problem);
  return filed.item;
}

describe("creating a trial from a draft", () => {
  it("writes a hidden pipeline whose graph is the draft's, linked to the conversation and to the pipeline it would replace", async () => {
    const target = hotfix();
    const { conversation, messageId } = await draftOfHotfix(target);
    const draft = readAssistDraftForPublish(handle.db, { conversationId: conversation.id, messageId });

    const made = trialFrom(conversation, messageId);

    expect(made.trial).toMatchObject({ conversationId: conversation.id, targetPipelineId: target });
    const trialId = made.trial.id;
    expect(trialId).not.toBe(target);
    expect(getPipeline(handle.db, trialId)).toMatchObject({ projectId, name: "Hotfix (trial)", entryStepId: made.stepIds.hotfix_fix });

    // Every step under a fresh id: a row cannot stand on two pipelines.
    const trialSteps = listStepsForPipeline(handle.db, trialId);
    expect(trialSteps.map((entry) => entry.id).sort()).toEqual(Object.values(made.stepIds).sort());
    expect(trialSteps.some((entry) => entry.id.startsWith("hotfix_"))).toBe(false);

    const draftName = new Map(draft.steps.map((entry) => [entry.id, entry.name]));
    const trialName = new Map(trialSteps.map((entry) => [entry.id, entry.name]));
    const named = (names: Map<string, string>) => (id: string) => names.get(id) ?? id;
    const trialShape = shapeOf(trialSteps, listRoutesForPipeline(handle.db, trialId), named(trialName));
    const draftShape = shapeOf(
      draft.steps.map((entry) => ({ ...entry, inputs: entry.inputs ?? {}, results: entry.results ?? [] })),
      draft.routes,
      named(draftName),
    );
    expect(trialShape.routes).toEqual(draftShape.routes);
    for (const [index, trialStep] of trialShape.steps.entries()) expect(trialStep).toMatchObject(draftShape.steps[index]!);

    // A version written the ordinary way, freezing that graph.
    expect(currentVersion(handle.db, trialId)).toBeDefined();
  });

  it("holds a draft's entry rules on the trial, leaves the target's alone, and files test items without asking them (EO-610)", async () => {
    const target = hotfix();
    const rules = [{ kind: "workspace" }];
    handle.db.update(pipelines).set({ entryRules: rules }).where(eq(pipelines.id, target)).run();
    const { conversation, messageId } = await draftOfHotfix(target);

    const made = trialFrom(conversation, messageId);

    // A draft that said nothing about them has nothing to hold.
    expect(getPipeline(handle.db, made.trial.id)?.entryRules).toEqual([]);
    expect(getPipeline(handle.db, target)?.entryRules).toEqual(rules);

    handle.db.update(pipelines).set({ entryRules: [{ kind: "description" }] }).where(eq(pipelines.id, made.trial.id)).run();
    expect(fileOn(made.trial.id, "Nothing written down").body).toBeNull();
  });

  it("makes a trial of a draft that creates a pipeline, with no pipeline to replace", async () => {
    const conversation = await conversationOn("/settings");
    const [messageId] = turn(conversation, { message: "Here.", draft: hotfixWithCheck({ newPipeline: "Triage" }) });

    const made = trialFrom(conversation, messageId!);

    expect(made.trial.targetPipelineId).toBeNull();
    expect(getPipeline(handle.db, made.trial.id)?.name).toBe("Triage (trial)");
    expect(listStepsForPipeline(handle.db, made.trial.id).map((entry) => entry.name).sort()).toEqual(["Check", "Done", "Fix"]);
    // And nothing named Triage exists to be seen: Publish has not been pressed.
    expect(listPipelines(handle.db).some((pipeline) => pipeline.name.startsWith("Triage"))).toBe(false);
  });

  it("refuses a draft whose route hands work to another pipeline, writing nothing", async () => {
    const target = hotfix();
    const elsewhere = createPipeline(handle.db, { projectId, name: "Ops" });
    replacePipelineGraph(handle.db, elsewhere.id, [{ id: "ops_take", pipelineId: elsewhere.id as Uuid, position: 0, name: "Take", type: "user", isTerminal: true }], [], { entryStepId: "ops_take" });
    const conversation = await conversationOn(`/pipelines/${target}`);
    const [messageId] = turn(
      conversation,
      { message: "Here.", draft: hotfixWithCheck({ pipelineId: target }, [{ fromStepId: "hotfix_check", resultKey: "escalate", label: "Escalate", tone: "danger", target: "ops_take", position: 2 }]) },
      target,
    );
    const pipelinesBefore = handle.db.select().from(pipelineSteps).all().length;

    const made = createTrialFromDraft(handle.db, undefined, { conversationId: conversation.id, messageId: messageId! });

    expect(made).toMatchObject({ ok: false });
    expect(!made.ok && made.problem).toContain('"Check" hands work to a step of another pipeline');
    expect(handle.db.select().from(pipelineSteps).all()).toHaveLength(pipelinesBefore);
  });
});

describe("trial items", () => {
  it("carry the trial mark, stand on the trial's entry step and version, have a workspace, and never sync to Jira", async () => {
    const { conversation, messageId } = await draftOfHotfix(hotfix());
    const made = trialFrom(conversation, messageId);

    const item = fileOn(made.trial.id);

    expect(item.trialAt).not.toBeNull();
    expect(item.previewAt).toBeNull();
    expect(item).toMatchObject({ pipelineId: made.trial.id, stepId: made.stepIds.hotfix_fix, projectId, workspaceId });
    expect(item.pipelineVersionId).toBe(currentVersion(handle.db, made.trial.id)!.id);
    expect(jiraStateOf(item).sync).toBe(false);
  });

  it("are dispatched to their agent's real backend, unlike a preview", async () => {
    // The project's own implementer, on Claude: what the step is staffed by.
    const claude = createAgent(handle.db, { name: "Claude implementer", role: "implementer", provider: "claude", instructions: "x", projectId });
    const { conversation, messageId } = await draftOfHotfix(hotfix());
    const item = fileOn(trialFrom(conversation, messageId).trial.id);

    const dispatches = tick(buildTickInput(handle.db, { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 }, false));

    expect(dispatches.map((dispatch) => dispatch.item.id)).toEqual([item.id]);
    // The agent as it is configured — a preview would have been swapped
    // onto the fake backend and given no disk; a trial item is not.
    expect(dispatches[0]!.agent).toMatchObject({ id: claude.id, provider: "claude" });
    expect(item.workspaceId).toBe(workspaceId);
  });

  it("refuse to be filed on a pipeline that is not a trial", () => {
    expect(fileTrialItem(handle.db, undefined, { trialPipelineId: hotfix(), type: "story", title: "Nope" })).toMatchObject({ ok: false });
  });
});

describe("what a person browses", () => {
  it("never shows a trial pipeline: not in pipelines_list, not exportable", async () => {
    const target = hotfix();
    const { conversation, messageId } = await draftOfHotfix(target);
    const trialId = trialFrom(conversation, messageId).trial.id;

    expect(listPipelines(handle.db).map((pipeline) => pipeline.id)).not.toContain(trialId);
    expect(listPipelines(handle.db, projectId, true).map((pipeline) => pipeline.id)).not.toContain(trialId);
    const listed = listPipelineViews(handle.db, { projectId }).pipelines.map((pipeline) => pipeline.id);
    expect(listed).toContain(target);
    expect(listed).not.toContain(trialId);
    expect(exportPipeline(handle.db, target).ok).toBe(true);
    expect(exportPipeline(handle.db, trialId)).toEqual({ ok: false, reason: "That pipeline no longer exists." });
  });

  it("leaves trial items off the board, out of the inbox and its counts, without a needs-attention marker, and out of the archive", async () => {
    const target = hotfix();
    const { conversation, messageId } = await draftOfHotfix(target);
    const trialItem = fileOn(trialFrom(conversation, messageId).trial.id, "Trial");
    const liveItem = createTestItem(handle.db, { type: "story", title: "Live", projectId, workspaceId, stepId: "hotfix_fix" });
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    for (const item of [trialItem, liveItem]) {
      postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: implementer.id }, body: "@user which way?" });
    }

    expect(listItemSummaries(handle.db, projectId).items.map((summary) => summary.id)).toEqual([liveItem.id]);
    expect(listItemSummaries(handle.db, projectId, { text: "Trial" }).items).toEqual([]);

    const inbox = listInbox(handle.db, projectId);
    expect(inbox.items.map((row) => row.itemId)).toEqual([liveItem.id]);
    expect(inbox.summary.openCount).toBe(1);
    expect(listInbox(handle.db).items.map((row) => row.itemId)).toEqual([liveItem.id]);

    expect(needsAttention(handle.db, liveItem.id)).toBe(true);
    expect(needsAttention(handle.db, trialItem.id)).toBe(false);

    setItemArchived(handle.db, trialItem.id, Date.now());
    setItemArchived(handle.db, liveItem.id, Date.now());
    expect(listArchivedSummaries(handle.db, projectId).items.map((summary) => summary.id)).toEqual([liveItem.id]);
  });
});

describe("what a trial costs", () => {
  it("counts against the per-item and daily budgets, and is reported apart in spend_read", async () => {
    const { conversation, messageId } = await draftOfHotfix(hotfix());
    const trialItem = fileOn(trialFrom(conversation, messageId).trial.id);
    const liveItem = createTestItem(handle.db, { type: "story", title: "Live", projectId, workspaceId, stepId: "hotfix_fix" });
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const spend = (item: Item, costCents: number) => {
      const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement" });
      updateRun(handle.db, run.id, { status: "succeeded", startedAt: Date.now(), costCents });
    };
    const startOfToday = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
    spend(trialItem, 40);
    spend(liveItem, 100);

    // The two figures the budget guards read.
    expect(sumCostCentsForItem(handle.db, trialItem.id)).toBe(40);
    expect(sumCostCentsSince(handle.db, startOfToday)).toBe(140);

    const day = getDailyCost(handle.db, { date: formatDateKey(Date.now()) });
    expect(day).toMatchObject({ costCents: 140, trialCostCents: 40 });
    const text = renderSpend({ date: day.date, dailyCostCents: day.costCents, dailySideCalls: day.sideCalls, dailyTrialCostCents: day.trialCostCents, item: null });
    expect(text).toContain("$1.40");
    expect(text).toContain("testing pipeline drafts with real runs (trial tickets): $0.40");
  });
});

describe("scheduling", () => {
  const ONE_AT_A_TIME = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

  async function liveAndTrialWaiting() {
    const target = hotfix();
    // Older and more urgent than anything the trial files.
    const liveItem = createTestItem(handle.db, { type: "story", title: "Live", projectId, workspaceId, stepId: "hotfix_fix", priority: 5 });
    const { conversation, messageId } = await draftOfHotfix(target);
    const trialItem = fileOn(trialFrom(conversation, messageId).trial.id);
    return { conversation, liveItem, trialItem };
  }

  const firstDispatched = (trialsFirst: boolean) => tick(buildTickInput(handle.db, ONE_AT_A_TIME, false, {}, Date.now(), Number.POSITIVE_INFINITY, null, trialsFirst)).map((dispatch) => dispatch.item.id);

  it("is on by default", () => {
    expect(DEFAULT_GUARD_CONFIG.trialsFirst).toBe(true);
  });

  it("dispatches the trial item ahead of live work while its conversation's loop runs", async () => {
    const { trialItem } = await liveAndTrialWaiting();
    expect(firstDispatched(true)).toEqual([trialItem.id]);
  });

  it("dispatches by priority and age as before with the setting off", async () => {
    const { liveItem } = await liveAndTrialWaiting();
    expect(firstDispatched(false)).toEqual([liveItem.id]);
  });

  it("puts a trial back in the queue once its conversation is closed", async () => {
    const { conversation, liveItem } = await liveAndTrialWaiting();
    setItemArchived(handle.db, conversation.id, Date.now());
    expect(firstDispatched(true)).toEqual([liveItem.id]);
  });
});

describe("discarding a trial", () => {
  it("removes its pipeline and items through the item-delete path and leaves the target exactly as it was", async () => {
    const target = hotfix();
    const live = createTestItem(handle.db, { type: "story", title: "Live", projectId, workspaceId, stepId: "hotfix_fix" });
    const before = snapshotOf(target);
    const boardBefore = listItemSummaries(handle.db, projectId).items.map((summary) => summary.id);

    const { conversation, messageId } = await draftOfHotfix(target);
    const made = trialFrom(conversation, messageId);
    const items = [fileOn(made.trial.id, "One"), fileOn(made.trial.id, "Two")];
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const run = createRun(handle.db, { itemId: items[0]!.id, agentId: implementer.id, action: "implement" });
    appendRunEvent(handle.db, run.id, "text", { text: "working" });
    updateRun(handle.db, run.id, { status: "succeeded", costCents: 12 });
    postComment(handle.db, { itemId: items[1]!.id, author: { type: "agent", agentId: implementer.id }, body: "@user stuck" });
    // Created, filed and run: the target has not moved.
    expect(snapshotOf(target)).toEqual(before);

    const discarded = await discardTrial(handle.db, undefined, attachments, { trialPipelineId: made.trial.id });

    expect(discarded).toMatchObject({ ok: true });
    expect(discarded.ok && [...discarded.deletedItemIds].sort()).toEqual(items.map((item) => item.id).sort());
    for (const item of items) expect(getItem(handle.db, item.id)).toBeUndefined();
    expect(getPipeline(handle.db, made.trial.id)).toBeUndefined();
    expect(getTrialPipeline(handle.db, made.trial.id)).toBeUndefined();
    expect(listStepsForPipeline(handle.db, made.trial.id)).toEqual([]);
    expect(listPipelineVersions(handle.db, made.trial.id)).toEqual([]);
    expect(sumCostCentsForItem(handle.db, items[0]!.id)).toBe(0);

    // Nothing behind on the board, and the pipeline it would have replaced is untouched.
    expect(listItemSummaries(handle.db, projectId).items.map((summary) => summary.id)).toEqual(boardBefore);
    expect(boardBefore).toEqual([live.id]);
    expect(snapshotOf(target)).toEqual(before);
  });

  it("refuses a pipeline that is not a trial, and deletes nothing", async () => {
    const target = hotfix();
    const before = snapshotOf(target);
    expect(await discardTrial(handle.db, undefined, attachments, { trialPipelineId: target })).toMatchObject({ ok: false });
    expect(snapshotOf(target)).toEqual(before);
  });

  it("happens to every trial of a conversation that is deleted", async () => {
    const { conversation, messageId } = await draftOfHotfix(hotfix());
    const made = trialFrom(conversation, messageId);
    const item = fileOn(made.trial.id);

    await deleteConversationItem(handle.db, undefined, rowOf(conversation.id), attachments);

    expect(getItem(handle.db, item.id)).toBeUndefined();
    expect(getPipeline(handle.db, made.trial.id)).toBeUndefined();
  });
});

describe("a module on a trial item (review of EO-582)", () => {
  const store = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ""),
  };
  const launcher = { execPath: process.execPath, hostPath: join(dirname(fileURLToPath(import.meta.url)), "../modules/moduleHost.mjs"), hostEnv: { ELECTRON_RUN_AS_NODE: "1" } };
  const NEEDS = { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: true };
  let saves = 0;

  /** Runs an approved module that creates an item, through a real host, on `on`; what `ctx.createItem` answered. */
  async function createFrom(on: Item, pipeline?: string): Promise<unknown> {
    const work = join(scratch, `work-${(saves += 1)}`);
    mkdirSync(work, { recursive: true });
    const named = pipeline === undefined ? "" : `, pipeline: ${JSON.stringify(pipeline)}`;
    const saved = saveModule(handle.db, {
      slug: `follow-up-${saves}`,
      name: "Follow-up",
      description: "Files the follow-up.",
      code: `export default async function run(ctx) {
        const answer = await ctx.createItem({ idempotencyKey: "a", type: "story", title: "Follow up", body: "Later.", spec: { acceptance_criteria: ["It is followed up."] }${named} });
        return { ok: true, result: "ok", detail: JSON.stringify(answer) };
      }`,
      manifest: { name: "Follow-up", description: "Files the follow-up.", inputs: {}, needs: NEEDS, results: ["ok"] },
      approve: true,
    });
    if (!saved.ok) throw new Error(saved.reason);
    const row = createRun(handle.db, { itemId: on.id, agentId: null, action: saved.module.id, status: "running", provider: "module" });
    const buffer = createRunEventBuffer(handle.db);
    const lookup = createModuleRunnerLookup({ db: handle.db, launcher, secrets: { directory: join(scratch, "secrets"), store } });
    const outcome = await lookup(saved.module.id)!({
      db: handle.db,
      item: on,
      prepareWorkspace: preparingAt(work),
      report: (text: string) => {
        buffer.append(row.id, "output", { type: "output", text });
        buffer.flush();
      },
      runId: row.id,
    });
    if (!outcome.ok) throw new Error(outcome.reason);
    return JSON.parse(outcome.detail) as unknown;
  }

  it("creates nothing from a trial item — not on the pipeline the draft would replace, not anywhere — and discarding leaves the board as it was", async () => {
    const target = hotfix();
    const live = createTestItem(handle.db, { type: "story", title: "Live", projectId, workspaceId, stepId: "hotfix_fix" });
    // The same module on live work does create, so the refusal below is the trial's.
    expect(await createFrom(live, "Hotfix")).toMatchObject({ created: true });
    const before = snapshotOf(target);
    const everyItemBefore = listItemsIncludingArchived(handle.db).map((item) => item.id).sort();
    const boardBefore = listItemSummaries(handle.db, projectId).items.map((summary) => summary.id).sort();

    const { conversation, messageId } = await draftOfHotfix(target);
    const made = trialFrom(conversation, messageId);
    const trialItem = fileOn(made.trial.id);

    for (const pipeline of ["Hotfix", undefined]) {
      expect(await createFrom(trialItem, pipeline)).toEqual({ created: false, reason: trialCreationRefusal(trialItem.key) });
    }
    expect(listItemsIncludingArchived(handle.db).map((item) => item.id).sort()).toEqual([...everyItemBefore, conversation.id, trialItem.id].sort());
    expect(snapshotOf(target)).toEqual(before);

    expect(await discardTrial(handle.db, undefined, attachments, { trialPipelineId: made.trial.id })).toMatchObject({ ok: true });
    expect(listItemSummaries(handle.db, projectId).items.map((summary) => summary.id).sort()).toEqual(boardBefore);
    expect(snapshotOf(target)).toEqual(before);
  });
});

describe("where a trial item works (review of EO-582)", () => {
  /** A trial pipeline written by hand on `onProject`, for the filing refusals. */
  function bareTrial(onProject: Uuid | null): string {
    const pipeline = createPipeline(handle.db, { projectId: onProject, name: "Bare (trial)" });
    replacePipelineGraph(handle.db, pipeline.id, [{ id: `bare_${pipeline.id}`, pipelineId: pipeline.id as Uuid, position: 0, name: "Done", type: "user", isTerminal: true }], [], {
      entryStepId: `bare_${pipeline.id}`,
    });
    markTrialPipeline(handle.db, pipeline.id, { conversationId: uuidLike(), targetPipelineId: null });
    return pipeline.id;
  }
  const uuidLike = () => "01a00000-0000-7000-8000-000000000001";

  it("is refused on a trial on no project, writing nothing", () => {
    const before = listItemsIncludingArchived(handle.db).length;
    const filed = fileTrialItem(handle.db, undefined, { trialPipelineId: bareTrial(null), type: "story", title: "Nowhere" });
    expect(filed).toMatchObject({ ok: false });
    expect(!filed.ok && filed.problem).toContain("on no project");
    expect(listItemsIncludingArchived(handle.db)).toHaveLength(before);
  });

  it("is refused on a project with no workspace, writing nothing", () => {
    const bare = createProject(handle.db, { name: "Bare", keyPrefix: "BAR" }).id as Uuid;
    const before = listItemsIncludingArchived(handle.db).length;
    const filed = fileTrialItem(handle.db, undefined, { trialPipelineId: bareTrial(bare), type: "story", title: "No disk" });
    expect(filed).toMatchObject({ ok: false });
    expect(!filed.ok && filed.problem).toContain("has none attached");
    expect(listItemsIncludingArchived(handle.db)).toHaveLength(before);
  });

  it("is settled before a trial is made: a draft on a project with no workspace makes no trial", async () => {
    const target = hotfix();
    const { conversation, messageId } = await draftOfHotfix(target);
    handle.db.update(workspaces).set({ projectId: null }).where(eq(workspaces.id, workspaceId)).run();
    const stepsBefore = handle.db.select().from(pipelineSteps).all().length;

    const made = createTrialFromDraft(handle.db, undefined, { conversationId: conversation.id, messageId });

    expect(made).toMatchObject({ ok: false });
    expect(!made.ok && made.problem).toContain("has none attached");
    expect(handle.db.select().from(pipelineSteps).all()).toHaveLength(stepsBefore);
  });
});

describe("a disk, and a project this machine schedules (second review of EO-582)", () => {
  /** A `none` workspace on `onProject`: a row with no disk behind it. */
  const noDisk = (onProject: Uuid) => createWorkspace(handle.db, { kind: NONE_KIND, projectId: onProject }).id as Uuid;

  it("refuses a project whose only workspace has no disk, when the trial is made and when an item is filed", async () => {
    const { conversation, messageId } = await draftOfHotfix(hotfix());
    // The scratch workspace taken away, a no-disk one left in its place.
    handle.db.update(workspaces).set({ projectId: null }).where(eq(workspaces.id, workspaceId)).run();
    noDisk(projectId);
    const stepsBefore = handle.db.select().from(pipelineSteps).all().length;

    const made = createTrialFromDraft(handle.db, undefined, { conversationId: conversation.id, messageId });
    expect(made).toMatchObject({ ok: false });
    expect(!made.ok && made.problem).toContain("one with no disk");
    expect(handle.db.select().from(pipelineSteps).all()).toHaveLength(stepsBefore);

    // And a trial that already stands there takes no item, choosing for itself.
    const bare = createPipeline(handle.db, { projectId, name: "Bare (trial)" });
    replacePipelineGraph(handle.db, bare.id, [{ id: "bare_done", pipelineId: bare.id as Uuid, position: 0, name: "Done", type: "user", isTerminal: true }], [], { entryStepId: "bare_done" });
    markTrialPipeline(handle.db, bare.id, { conversationId: conversation.id, targetPipelineId: null });
    const before = listItemsIncludingArchived(handle.db).length;
    const filed = fileTrialItem(handle.db, undefined, { trialPipelineId: bare.id, type: "story", title: "No disk" });
    expect(filed).toMatchObject({ ok: false });
    expect(!filed.ok && filed.problem).toContain("one with no disk");
    expect(listItemsIncludingArchived(handle.db)).toHaveLength(before);
  });

  it("refuses a no-disk workspace named outright, and passes over one when choosing", async () => {
    const { conversation, messageId } = await draftOfHotfix(hotfix());
    const trialId = trialFrom(conversation, messageId).trial.id;
    const none = noDisk(projectId);
    const before = listItemsIncludingArchived(handle.db).length;

    const named = fileTrialItem(handle.db, undefined, { trialPipelineId: trialId, type: "story", title: "Named", workspaceId: none });
    expect(named).toMatchObject({ ok: false });
    expect(!named.ok && named.problem).toContain("no disk behind it");
    expect(listItemsIncludingArchived(handle.db)).toHaveLength(before);

    // Two workspaces, one with a disk: that is the one, without being told.
    expect(fileOn(trialId).workspaceId).toBe(workspaceId);
  });

  it("refuses on a desktop a project moved to the record, writing nothing, and makes and files it on the record", async () => {
    const { conversation, messageId } = await draftOfHotfix(hotfix());
    const owner = createPerson(handle.db, { name: "Anna", email: "anna@example.com" });
    markProjectOnTheRecord(handle.db, projectId, owner.id as Uuid);
    const stepsBefore = handle.db.select().from(pipelineSteps).all().length;
    const itemsBefore = listItemsIncludingArchived(handle.db).length;

    const onTheDesktop = createTrialFromDraft(handle.db, undefined, { conversationId: conversation.id, messageId });
    expect(onTheDesktop).toMatchObject({ ok: false });
    expect(!onTheDesktop.ok && onTheDesktop.problem).toContain("held by your organisation's record");
    expect(handle.db.select().from(pipelineSteps).all()).toHaveLength(stepsBefore);

    // The record owns the project, and there it is the ordinary case.
    const onTheRecord = createTrialFromDraft(handle.db, undefined, { conversationId: conversation.id, messageId }, { onTheRecord: true });
    if (!onTheRecord.ok) throw new Error(onTheRecord.problem);
    const trialId = onTheRecord.trial.id;

    const filedHere = fileTrialItem(handle.db, undefined, { trialPipelineId: trialId, type: "story", title: "Here" });
    expect(filedHere).toMatchObject({ ok: false });
    expect(!filedHere.ok && filedHere.problem).toContain("held by your organisation's record");
    expect(listItemsIncludingArchived(handle.db)).toHaveLength(itemsBefore);

    const filedThere = fileTrialItem(handle.db, undefined, { trialPipelineId: trialId, type: "story", title: "There" }, { onTheRecord: true });
    expect(filedThere).toMatchObject({ ok: true });
    expect(filedThere.ok && filedThere.item.trialAt).not.toBeNull();
  });
});

describe("a trial that travels (review of EO-582)", () => {
  /** What crosses a wire is JSON, parsed by the receiving side's schema. */
  const overTheWire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value)) as unknown;

  async function trialWithAnItem() {
    const target = hotfix();
    const { conversation, messageId } = await draftOfHotfix(target);
    const made = trialFrom(conversation, messageId);
    return { target, conversation, trial: made.trial, item: fileOn(made.trial.id) };
  }

  it("is still a trial, with a trial item on it, once its project is moved to the record", async () => {
    const { trial, item, conversation } = await trialWithAnItem();
    const record = openMigratedTestDb();
    try {
      const owner = createPerson(record.db, { name: "Anna", email: "anna@example.com" });
      const project = getProject(handle.db, projectId)!;
      const wire = RecordProjectSchema.parse({ id: project.id, name: project.name, keyPrefix: project.keyPrefix, createdAt: project.createdAt, updatedAt: project.updatedAt });
      expect(writeAdoptedProject(record.db, wire, owner.id as Uuid, 1).ok).toBe(true);
      const page = ipcContract["record:adopt"].request.parse({
        deviceId: "d",
        project: wire,
        keyNextValue: 0,
        page: overTheWire({ itemTypes: readProjectItemTypes(handle.db, projectId), pipelines: readProjectPipelines(handle.db, projectId), items: readProjectItems(handle.db, projectId) }),
      }).page;
      writeAdoptedPage(record.db, wire, page, "d");

      expect(getTrialPipeline(record.db, trial.id)).toEqual(trial);
      expect(getItem(record.db, item.id)?.trialAt).toBe(item.trialAt);
      expect(getItem(record.db, conversation.id)).toBeDefined();
      // Hidden there as it was here.
      expect(listPipelines(record.db).map((pipeline) => pipeline.id)).not.toContain(trial.id);
      expect(listItemSummaries(record.db, projectId).items.map((summary) => summary.id)).not.toContain(item.id);
      // And the record can discard it as one.
      expect(await discardTrial(record.db, undefined, attachments, { trialPipelineId: trial.id })).toMatchObject({ ok: true });
      expect(getItem(record.db, item.id)).toBeUndefined();
    } finally {
      record.close();
    }
  });

  it("reaches a replica as a trial, with its item still marked", async () => {
    const { trial, item } = await trialWithAnItem();
    const replica = openMigratedTestDb();
    try {
      // The project and its item types, as the replica's sync brings them first.
      replica.db.insert(projects).values(handle.db.select().from(projects).where(eq(projects.id, projectId)).get()!).run();
      for (const type of handle.db.select().from(itemTypes).where(eq(itemTypes.projectId, projectId)).all()) replica.db.insert(itemTypes).values(type).run();
      for (const pipeline of listPipelinesUpdatedSince(handle.db, { ts: 0, id: "" }, 100)) {
        upsertReplicaPipeline(replica.db, RecordPipelineSchema.parse(overTheWire(pipeline)));
      }
      const written = upsertReplicaItem(replica.db, RecordItemSchema.parse(overTheWire({ ...asRecordItem(getItem(handle.db, item.id)!, null), origin: null, waits: null })));
      expect(written).toBe("inserted");

      expect(getTrialPipeline(replica.db, trial.id)).toEqual(trial);
      expect(getItem(replica.db, item.id)?.trialAt).toBe(item.trialAt);
      expect(listPipelines(replica.db).map((pipeline) => pipeline.id)).not.toContain(trial.id);
      expect(listItemSummaries(replica.db, projectId).items.map((summary) => summary.id)).not.toContain(item.id);
    } finally {
      replica.close();
    }
  });

  it("reads as live work from a build that sent no trial fields", () => {
    expect(RecordPipelineSchema.shape.trial.parse(undefined)).toBeNull();
    expect(RecordItemSchema.shape.trialAt.parse(undefined)).toBeNull();
  });
});

describe("trial grants (EO-583)", () => {
  const store = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ""),
  };
  const launcher = { execPath: process.execPath, hostPath: join(dirname(fileURLToPath(import.meta.url)), "../modules/moduleHost.mjs"), hostEnv: { ELECTRON_RUN_AS_NODE: "1" } };
  const NEEDS = { bin: ["git"], env: [] as string[], network: false, item: false, comment: false, attach: false, create: false };
  const lookup = () => createModuleRunnerLookup({ db: handle.db, launcher, secrets: { directory: join(scratch, "secrets"), store } });

  /** A deploy module whose run says `mark`, so a test can tell which code ran. */
  const deployCode = (mark: string) => `export default async function run(ctx) { return { ok: true, result: "deployed", detail: ${JSON.stringify(mark)} }; }`;
  const deployManifest = (needs: Partial<typeof NEEDS> = {}, sideEffects?: boolean): ModuleManifest => ({
    name: "Deploy",
    description: "Deploys the build.",
    inputs: {},
    needs: { ...NEEDS, ...needs },
    results: ["deployed"],
    ...(sideEffects === undefined ? {} : { sideEffects }),
  });

  function deployModule(approve: boolean): CustomModule {
    const saved = saveModule(handle.db, { slug: "deploy", name: "Deploy", description: "Deploys the build.", code: deployCode("original"), manifest: deployManifest(), source: "architect", approve });
    if (!saved.ok) throw new Error(saved.reason);
    return saved.module;
  }

  /** Saves new code and manifest onto a module, keeping everything else. */
  function edit(module: CustomModule, code: string, manifest: ModuleManifest = module.manifest) {
    const saved = saveModule(handle.db, { id: module.id, slug: module.slug, name: module.name, description: module.description, code, manifest });
    if (!saved.ok) throw new Error(saved.reason);
    return saved;
  }

  /** What a module step's run comes to on `item`. */
  async function runOn(moduleId: string, item: Item) {
    const runner = lookup()(moduleId);
    if (runner === undefined) return { ok: false as const, reason: "no runner" };
    const work = join(scratch, `work-${item.id}`);
    mkdirSync(work, { recursive: true });
    const row = createRun(handle.db, { itemId: item.id, agentId: null, action: moduleId, status: "running", provider: "module" });
    return runner({ db: handle.db, item, prepareWorkspace: preparingAt(work), report: () => undefined, runId: row.id });
  }

  /** A draft whose work starts on a step running `moduleId`, then Done. */
  function deployDraft(target: Record<string, string>, moduleId: string, withCheck = false) {
    const after = withCheck ? "ship_check" : "ship_done";
    return {
      rationale: "Deploy, then done.",
      entryStepId: "ship_deploy",
      target,
      steps: [
        step("ship_deploy", 0, "Deploy", { type: "module", entryAction: moduleId }),
        ...(withCheck ? [step("ship_check", 1, "Check")] : []),
        step("ship_done", 2, "Done", { isTerminal: true }),
      ],
      routes: [
        { fromStepId: "ship_deploy", resultKey: "deployed", label: "Deployed", tone: "success", target: after, position: 0 },
        ...(withCheck ? [{ fromStepId: "ship_check", resultKey: "approve", label: "Approve", tone: "success", target: "ship_done", position: 0 }] : []),
      ],
    };
  }

  /** Ship as it is published: Deploy running `moduleId`, then Done. */
  function ship(moduleId: string): string {
    const pipeline = createPipeline(handle.db, { projectId, name: "Ship" });
    replacePipelineGraph(
      handle.db,
      pipeline.id,
      [
        { id: "ship_deploy", pipelineId: pipeline.id as Uuid, position: 0, name: "Deploy", type: "module", entryAction: moduleId, isTerminal: false },
        { id: "ship_done", pipelineId: pipeline.id as Uuid, position: 1, name: "Done", type: "user", isTerminal: true },
      ],
      [{ pipelineId: pipeline.id as Uuid, fromStepId: "ship_deploy", resultKey: "deployed", label: "Deployed", tone: "success", target: "ship_done", position: 0 }],
      { entryStepId: "ship_deploy" },
    );
    return pipeline.id;
  }

  /** A trial of a new pipeline running `moduleId`, granted by `grantedBy`. */
  async function newTrialRunning(moduleId: string, grantedBy?: string) {
    const conversation = await conversationOn("/settings");
    const [messageId] = turn(conversation, { message: "Here.", draft: deployDraft({ newPipeline: "Ship" }, moduleId) });
    const made = createTrialFromDraft(handle.db, undefined, { conversationId: conversation.id, messageId: messageId! }, grantedBy === undefined ? {} : { grantedBy });
    if (!made.ok) throw new Error(made.problem);
    return made;
  }

  describe("granted", () => {
    it("lets an unapproved module run on an item of its trial, and records who granted it, when, and the needs it covers", async () => {
      const module = deployModule(false);
      const before = Date.now();
      const made = await newTrialRunning(module.id, "human");

      // Not used by anything published, so the trial runs the module itself.
      expect(made.moduleIds).toEqual({ [module.id]: module.id });
      const [grant, ...others] = listTrialGrantsForModule(handle.db, module.id);
      expect(others).toEqual([]);
      expect(grant).toMatchObject({
        moduleId: module.id,
        trialPipelineId: made.trial.id,
        grantedBy: "human",
        withdrawnAt: null,
        needs: { bin: ["git"], env: [], network: false, sideEffects: false, create: false },
      });
      expect(grant!.grantedAt).toBeGreaterThanOrEqual(before);

      // Still unapproved: a grant is not an approval.
      expect(getModule(handle.db, module.id)?.approvedAt).toBeNull();
      expect(await runOn(module.id, fileOn(made.trial.id))).toEqual({ ok: true, result: "deployed", detail: "original" });
    });

    it("records the agent that granted it, where an agent did", async () => {
      const module = deployModule(false);
      const agent = assistAgent(handle.db)!;
      await newTrialRunning(module.id, agent.id);
      expect(listTrialGrantsForModule(handle.db, module.id).map((grant) => grant.grantedBy)).toEqual([agent.id]);
    });
  });

  describe("refused elsewhere", () => {
    it("refuses a live item and another trial's item, saying why", async () => {
      const module = deployModule(false);
      const made = await newTrialRunning(module.id);
      const live = createTestItem(handle.db, { type: "story", title: "Live", projectId, workspaceId, stepId: "todo" });
      const other = createPipeline(handle.db, { projectId, name: "Other (trial)" });
      replacePipelineGraph(handle.db, other.id, [{ id: "other_done", pipelineId: other.id as Uuid, position: 0, name: "Done", type: "user", isTerminal: true }], [], { entryStepId: "other_done" });
      markTrialPipeline(handle.db, other.id, { conversationId: made.trial.conversationId, targetPipelineId: null });

      const onLive = await runOn(module.id, live);
      expect(onLive).toMatchObject({ ok: false });
      expect(!onLive.ok && onLive.reason).toContain('"Deploy" has not been approved, so it runs only on the test items of a trial it was granted for');

      const onOther = await runOn(module.id, fileOn(other.id));
      expect(onOther).toMatchObject({ ok: false });
      expect(!onOther.ok && onOther.reason).toContain("its trial grant is for another trial, not this one");
    });

    it("parks a live item that reaches it with a comment saying why", async () => {
      const module = deployModule(false);
      grantTrial(handle.db, { moduleId: module.id, trialPipelineId: (await newTrialRunning(module.id)).trial.id, grantedBy: "human" });
      // A live step naming it, written past the validator — the gate has to hold when it runs.
      handle.db.insert(pipelineSteps).values({ id: "live_deploy", pipelineId: "default", position: 50, name: "Deploy", type: "module", entryAction: module.id, isTerminal: false }).run();
      const live = createTestItem(handle.db, { type: "story", title: "Live", projectId, workspaceId, stepId: "live_deploy" });

      await createRunSupervisor({
        db: handle.db,
        provider: { start: () => { throw new Error("a module step must not reach a provider"); } } as never,
        limits: { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 },
        moduleRunner: lookup(),
      }).runOnce();

      expect(getItem(handle.db, live.id)?.stepId).toBe("live_deploy");
      const said = listCommentsForItem(handle.db, live.id).at(-1);
      expect(said?.kind).toBe("escalation");
      expect(said?.body).toContain("runs only on the test items of a trial it was granted for, and this is not a test item");
    });
  });

  describe("widened", () => {
    it("keeps the grant through new code within it, and runs the new code", async () => {
      const module = deployModule(false);
      const made = await newTrialRunning(module.id);
      const item = fileOn(made.trial.id);

      for (const round of [1, 2, 3]) {
        const saved = edit(module, deployCode(`round ${round}`));
        expect(saved.ok && saved.withdrawnTrialGrants).toBeUndefined();
        expect(await runOn(module.id, item)).toEqual({ ok: true, result: "deployed", detail: `round ${round}` });
      }
      // Asking for less is never a widening.
      edit(module, deployCode("narrower"), deployManifest({ bin: [] }));
      expect(activeTrialGrants(handle.db, module.id)).toHaveLength(1);
    });

    it.each([
      ["a binary", deployManifest({ bin: ["git", "curl"] }), "the binary curl"],
      ["an env var or secret", deployManifest({ env: ["DEPLOY_TOKEN"] }), "the variable or secret DEPLOY_TOKEN"],
      ["network", deployManifest({ network: true }), "network access"],
      ["side effects", deployManifest({}, true), "outside effects"],
      ["item creation", deployManifest({ create: true }), "creating items"],
    ])("withdraws it when a save adds %s, and refuses the trial's item saying so", async (_what, wider, words) => {
      const module = deployModule(false);
      const made = await newTrialRunning(module.id);
      const item = fileOn(made.trial.id);

      const saved = edit(module, deployCode("wider"), wider);

      expect(saved.ok && saved.withdrawnTrialGrants?.map((grant) => grant.trialPipelineId)).toEqual([made.trial.id]);
      expect(activeTrialGrants(handle.db, module.id)).toEqual([]);
      expect(listTrialGrantsForModule(handle.db, module.id)[0]?.withdrawnAt).not.toBeNull();
      const outcome = await runOn(module.id, item);
      expect(outcome).toMatchObject({ ok: false });
      expect(!outcome.ok && outcome.reason).toContain(`its trial grant on this trial was withdrawn when its declared needs grew past what was granted (it now needs ${words})`);
    });

    it("withdraws it when an older, wider version is restored", async () => {
      const module = deployModule(false);
      edit(module, deployCode("wide"), deployManifest({ network: true }));
      edit(module, deployCode("narrow"), deployManifest());
      await newTrialRunning(module.id);
      expect(activeTrialGrants(handle.db, module.id)).toHaveLength(1);

      expect(restoreModuleVersion(handle.db, module.id, 2)).toMatchObject({ ok: true });
      expect(activeTrialGrants(handle.db, module.id)).toEqual([]);
    });
  });

  describe("fork isolation", () => {
    it("gives the trial a copy of a module a published pipeline uses, and no edit to the copy reaches the original or its live work", async () => {
      const original = deployModule(true);
      const target = ship(original.id);
      const live = createTestItem(handle.db, { type: "story", title: "Live", projectId, workspaceId, stepId: "ship_deploy" });
      const originalBefore = getModule(handle.db, original.id)!;
      const versionsBefore = listModuleVersions(handle.db, original.id);
      const pipelineBefore = snapshotOf(target);

      const conversation = await conversationOn(`/pipelines/${target}`);
      const [messageId] = turn(conversation, { message: "Here.", draft: deployDraft({ pipelineId: target }, original.id, true) }, target);
      const made = createTrialFromDraft(handle.db, undefined, { conversationId: conversation.id, messageId: messageId! });
      if (!made.ok) throw new Error(made.problem);

      // A copy, linked to the original, unapproved, granted, and what the trial's step runs.
      const copyId = made.moduleIds[original.id]!;
      expect(copyId).not.toBe(original.id);
      const copy = getModule(handle.db, copyId)!;
      expect(moduleForkedFrom(handle.db, copyId)).toBe(original.id);
      expect(copy).toMatchObject({ code: original.code, manifest: original.manifest, approvedAt: null });
      expect(activeTrialGrants(handle.db, copyId).map((grant) => grant.trialPipelineId)).toEqual([made.trial.id]);
      expect(activeTrialGrants(handle.db, original.id)).toEqual([]);
      expect(listStepsForPipeline(handle.db, made.trial.id).find((entry) => entry.type === "module")?.entryAction).toBe(copyId);
      const trialItem = fileOn(made.trial.id);

      // Any number of edits to the copy, one of them widening it.
      for (const round of [1, 2, 3]) {
        edit(getModule(handle.db, copyId)!, deployCode(`copy ${round}`));
        expect(await runOn(copyId, trialItem)).toEqual({ ok: true, result: "deployed", detail: `copy ${round}` });
        expect(await runOn(original.id, live)).toEqual({ ok: true, result: "deployed", detail: "original" });
      }
      edit(getModule(handle.db, copyId)!, deployCode("copy wide"), deployManifest({ network: true }));
      expect(await runOn(original.id, live)).toEqual({ ok: true, result: "deployed", detail: "original" });

      expect(getModule(handle.db, original.id)).toEqual(originalBefore);
      expect(listModuleVersions(handle.db, original.id)).toEqual(versionsBefore);
      expect(snapshotOf(target)).toEqual({ ...pipelineBefore, items: [live] });

      // Discarding the trial archives the copy and takes its grants, and leaves the original alone.
      expect(await discardTrial(handle.db, undefined, attachments, { trialPipelineId: made.trial.id })).toMatchObject({ ok: true });
      expect(getModule(handle.db, copyId)?.archivedAt).not.toBeNull();
      expect(listTrialGrantsForModule(handle.db, copyId)).toEqual([]);
      expect(getModule(handle.db, original.id)).toEqual(originalBefore);
      expect(await runOn(original.id, live)).toEqual({ ok: true, result: "deployed", detail: "original" });
    });

    it("keeps a copy that live work came to use when its trial is discarded", async () => {
      const original = deployModule(true);
      const target = ship(original.id);
      const conversation = await conversationOn(`/pipelines/${target}`);
      const [messageId] = turn(conversation, { message: "Here.", draft: deployDraft({ pipelineId: target }, original.id, true) }, target);
      const made = createTrialFromDraft(handle.db, undefined, { conversationId: conversation.id, messageId: messageId! });
      if (!made.ok) throw new Error(made.problem);
      const copyId = made.moduleIds[original.id]!;

      // The copy is in the catalogue: a person approves it and a published pipeline runs it.
      approveModule(handle.db, copyId);
      const elsewhere = createPipeline(handle.db, { projectId, name: "Ship again" });
      replacePipelineGraph(
        handle.db,
        elsewhere.id,
        [
          { id: "again_deploy", pipelineId: elsewhere.id as Uuid, position: 0, name: "Deploy", type: "module", entryAction: copyId, isTerminal: false },
          { id: "again_done", pipelineId: elsewhere.id as Uuid, position: 1, name: "Done", type: "user", isTerminal: true },
        ],
        [{ pipelineId: elsewhere.id as Uuid, fromStepId: "again_deploy", resultKey: "deployed", label: "Deployed", tone: "success", target: "again_done", position: 0 }],
        { entryStepId: "again_deploy" },
      );
      const live = createTestItem(handle.db, { type: "story", title: "Live on the copy", projectId, workspaceId, stepId: "again_deploy" });
      expect(moduleInLiveUse(handle.db, copyId)).toBe(true);

      expect(await discardTrial(handle.db, undefined, attachments, { trialPipelineId: made.trial.id })).toMatchObject({ ok: true });

      expect(getModule(handle.db, copyId)?.archivedAt).toBeNull();
      expect(listTrialGrantsForModule(handle.db, copyId)).toEqual([]);
      expect(await runOn(copyId, live)).toEqual({ ok: true, result: "deployed", detail: "original" });
    });

    it("copies a module still named by a version a live item may be bound to", async () => {
      const original = deployModule(true);
      const target = ship(original.id);
      expect(moduleInLiveUse(handle.db, original.id)).toBe(true);
      // Gone from the current graph, still in the published versions.
      handle.db.update(pipelineSteps).set({ entryAction: null }).where(eq(pipelineSteps.pipelineId, target)).run();
      handle.db.update(pipelineSteps).set({ type: "user" }).where(eq(pipelineSteps.pipelineId, target)).run();
      expect(listPipelineVersions(handle.db, target).length).toBeGreaterThan(0);
      expect(moduleInLiveUse(handle.db, original.id)).toBe(true);
    });
  });
});
