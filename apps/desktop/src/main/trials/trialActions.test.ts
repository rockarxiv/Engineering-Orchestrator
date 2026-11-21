import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_MCP_SERVER_NAME, AssistOutputSchema, RecordPipelineSchema, SCRATCH_KIND, pageDescriptorFor, type AgentEvent, type AgentProviderStartOptions, type Item, type Registry, type Uuid } from "@eo/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import { listActionDefinitions } from "../db/repos/actionDefinitionsRepo.js";
import {
  appendRunEvent,
  createAgent,
  createPipeline,
  createProject,
  createRun,
  createWorkspace,
  getItem,
  getTrialPipeline,
  listCommentsForItem,
  listPipelines,
  listRunsForItem,
  listTrialItemIds,
  readTrialActions,
  readTrialDesign,
  saveActionDefinition,
  transitionItem,
  updateRun,
  writeTrialActions,
} from "../db/repos/index.js";
import { listPipelinesUpdatedSince, upsertReplicaPipeline } from "../db/repos/projectMoveRepo.js";
import { itemTypes, projects } from "../db/schema.js";
import { agentOfKind, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { publishTrialCommand, sendToAssist } from "../ipc/assistCommands.js";
import { savePipeline } from "../ipc/configCommands.js";
import { clearPublishedView } from "../ipc/currentView.js";
import { clearHandlerRegistry } from "../ipc/registry.js";
import type { ModuleTestRunAnswer } from "../modules/moduleTestRunner.js";
import { registryForItem, registryForProject } from "../registry.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { fakeWorkspaceKind, installedKinds } from "../supervisor/testWorkspaceKinds.js";
import { approveTrialDesign, continueTrialLoop } from "./design.js";
import { discardTrial } from "./discard.js";
import { installTrialLoop } from "./loop.js";

/**
 * A trial carries its draft's action definitions without writing them
 * (EO-832, ARCHITECTURE.md, "Trial pipelines").
 *
 * A draft that brings an action definition — a role no live pipeline
 * names, or a new version of one that live work uses — is tested like
 * any other: the definitions are kept on the trial's own row, laid over
 * the installed registry for the trial's items alone, never written to
 * `action_definitions` while the trial lives, gone with it when it is
 * discarded, and written with the graph when its publish card is pressed.
 *
 * In-memory databases throughout. Assistant turns are posted the way the
 * supervisor posts them and handed to the loop as the pack's wiring
 * hands them.
 */
let handle: DbHandle;
let scratch: string;
let attachments: AttachmentStorage;
let stopLoop: () => void;
let projectId: Uuid;

const PIPELINE_READ = `mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_get`;
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-trial-actions-"));
  projectId = createProject(handle.db, { name: "Home", keyPrefix: "HOM" }).id as Uuid;
  createWorkspace(handle.db, { kind: SCRATCH_KIND, projectId });
  attachments = new AttachmentStorage(join(scratch, "attachments"));
  stopLoop = installTrialLoop(handle.db, { attachmentStorage: attachments, worktreeRoot: join(scratch, "worktrees") });
});

afterEach(() => {
  stopLoop();
  clearHandlerRegistry();
  clearPublishedView();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

const step = (id: string, position: number, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  position,
  name,
  type: "user",
  ownerRole: null,
  entryAction: null as string | null,
  instructionsSummary: null as string | null,
  isTerminal: false,
  planMode: false,
  ...extra,
});

/** The definition the Evidence draft brings, for a role no live pipeline names. */
function analyseEvidence(extra: Record<string, unknown> = {}) {
  return {
    role: "eo_adviser",
    action: "analyse_evidence",
    description: "Weigh the evidence the item cites.",
    results: [
      { key: "supported", label: "Supported", meaning: "The evidence holds up." },
      { key: "unsupported", label: "Unsupported", meaning: "The evidence does not hold up." },
    ],
    fields: [],
    ...extra,
  };
}

/** Analyse (an agent step on the new role's own action), a person's Check, then Done — or Dropped where the evidence does not hold. */
function evidenceDraft(analyseSays = "Weigh what the item cites.") {
  return {
    rationale: "An adviser weighs the evidence, then a person checks.",
    entryStepId: "ev_analyse",
    target: { newPipeline: "Evidence" },
    steps: [
      step("ev_analyse", 0, "Analyse", { type: "agent", ownerRole: "eo_adviser", entryAction: "analyse_evidence", instructionsSummary: analyseSays }),
      step("ev_check", 1, "Check"),
      step("ev_done", 2, "Done", { isTerminal: true }),
      step("ev_dropped", 3, "Dropped", { isTerminal: true }),
    ],
    routes: [
      { fromStepId: "ev_analyse", resultKey: "supported", label: "Supported", tone: "success", target: "ev_check", position: 0 },
      { fromStepId: "ev_analyse", resultKey: "unsupported", label: "Unsupported", tone: "danger", target: "ev_dropped", position: 1 },
      { fromStepId: "ev_check", resultKey: "approve", label: "Approve", tone: "success", target: "ev_done", position: 0 },
    ],
  };
}

const EVIDENCE_PLAN = {
  items: [{ key: "claim", title: "Weigh the claim", expected: { stepId: "ev_done" } }],
  steps: [{ stepId: "ev_analyse", mode: "real", reason: "It only reads the item." }],
};

async function conversationOn(path: string): Promise<Item> {
  const sent = await sendToAssist(handle.db, undefined, { page: pageDescriptorFor(path), conversationId: null, body: "test it with real runs", attachmentIds: [], interrupt: false });
  return getItem(handle.db, sent.conversation.id as Uuid)!;
}

/** One assistant turn, posted as the supervisor posts it and handed to the loop; the last thing it posted. */
function turn(chat: Item, output: unknown, readPipeline?: string): Uuid {
  const parsed = AssistOutputSchema.parse(output);
  const agent = assistAgent(handle.db)!;
  const question = listCommentsForItem(handle.db, chat.id).filter((comment) => comment.authorType === "human").at(-1)!.id;
  const run = createRun(handle.db, { itemId: chat.id, agentId: agent.id, action: ASSIST_ACTION, initiationId: question });
  if (readPipeline !== undefined) {
    appendRunEvent(handle.db, run.id, "tool_call", { name: PIPELINE_READ, args: { pipelineId: readPipeline }, callId: "call-0" });
    appendRunEvent(handle.db, run.id, "tool_result", { name: PIPELINE_READ, callId: "call-0", ok: true, output: "", truncated: false });
  }
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(parsed), parsed } });
  const posted = postAssistReply(handle.db, chat, agent.id, run.id, parsed);
  continueTrialLoop(handle.db, chat, posted.draftCardIds ?? []);
  return listCommentsForItem(handle.db, chat.id).filter((comment) => comment.runId === run.id && comment.authorType === "agent").at(-1)!.id;
}

const approve = (chat: Item, card: Uuid) => approveTrialDesign(handle.db, { attachmentStorage: attachments, worktreeRoot: join(scratch, "worktrees") }, { conversationId: chat.id, messageId: card });

/** The Evidence design approved, its first round filed. */
async function evidenceOnTrial(actions: unknown[] = [analyseEvidence()]) {
  // The agent the draft's Analyse step is bound to (EO-875): a step names
  // an agent of its kind, so one has to be there before the draft is.
  createAgent(handle.db, { name: "Adviser", role: "eo_adviser", provider: "claude", instructions: "You weigh evidence." });
  const chat = await conversationOn("/settings");
  const card = turn(chat, { message: "Here is the design.", draft: evidenceDraft(), trial: EVIDENCE_PLAN, actions });
  const answer = await approve(chat, card);
  if (!answer.approved) throw new Error(answer.problem ?? "not approved");
  const trialId = answer.trialPipelineId!;
  const [claim] = listTrialItemIds(handle.db, trialId).map((id) => getItem(handle.db, id)!) as [Item];
  return { chat, card, answer, trialId, claim };
}

/** The keys a role's definition of an action declares in this registry, or undefined where it defines none. */
function declared(registry: Registry, role: string, action: string): string[] | undefined {
  return registry.actionDefinitions?.get(role)?.get(action)?.definition.results.map((result) => result.key);
}

/** Every definition row, as what it says. */
function definitionRows() {
  return listActionDefinitions(handle.db).map(({ role, action, description, results, fields }) => ({ role, action, description, results, fields }));
}

/** Answers each dispatch with one scripted result, and keeps what it was sent and every correction. */
function recordingProvider(result: unknown) {
  const started: AgentProviderStartOptions[] = [];
  const corrections: string[] = [];
  return {
    started,
    corrections,
    provider: {
      async *start(opts: AgentProviderStartOptions): AsyncIterable<AgentEvent> {
        started.push(opts);
        yield { type: "thread_started", threadId: `t${started.length}` };
        yield { type: "result", data: result };
      },
      async *resume(_threadId: string, message: string): AsyncIterable<AgentEvent> {
        corrections.push(message);
        yield { type: "result", data: result };
      },
    },
  };
}

function supervisorWith(provider: ReturnType<typeof recordingProvider>["provider"]) {
  return createRunSupervisor({ db: handle.db, provider, limits: LIMITS, kinds: installedKinds(fakeWorkspaceKind({ slug: SCRATCH_KIND, cwd: scratch })) });
}

/** The action's own branch of the provider wrapper, beside the clarification. */
function answerBranch(schema: Record<string, unknown> | undefined): { properties: Record<string, { enum?: string[] }>; required: string[] } {
  return (schema?.["properties"] as { outcome: { anyOf: never[] } }).outcome.anyOf[1]!;
}

describe("a draft that brings an action definition, approved as a design", () => {
  it("makes a trial instead of refusing, and keeps the definition on the trial's own row", async () => {
    const { answer, trialId } = await evidenceOnTrial();

    expect(answer).toMatchObject({ approved: true, problem: null });
    expect(getTrialPipeline(handle.db, trialId)).toBeDefined();
    expect(readTrialActions(handle.db, trialId)).toEqual([
      {
        role: "eo_adviser",
        action: "analyse_evidence",
        description: "Weigh the evidence the item cites.",
        results: [
          { key: "supported", label: "Supported", meaning: "The evidence holds up." },
          { key: "unsupported", label: "Unsupported", meaning: "The evidence does not hold up." },
        ],
        fields: {},
      },
    ]);
  });

  it("writes no definition row while the trial exists, and a live item's registry has none for it", async () => {
    const before = definitionRows();
    const { claim } = await evidenceOnTrial();
    const live = createTestItem(handle.db, { type: "story", title: "Live", projectId, stepId: "todo" });

    expect(definitionRows()).toEqual(before);
    expect(listActionDefinitions(handle.db).filter((row) => row.role === "eo_adviser")).toEqual([]);
    expect(declared(registryForItem(handle.db, live), "eo_adviser", "analyse_evidence")).toBeUndefined();
    expect(declared(registryForProject(handle.db, projectId), "eo_adviser", "analyse_evidence")).toBeUndefined();
    // Only the trial's own item sees it.
    expect(declared(registryForItem(handle.db, claim), "eo_adviser", "analyse_evidence")).toEqual(["supported", "unsupported"]);
  });
});

describe("a trial item on the step using the trial's definition", () => {
  it("is dispatched with the overlay's output schema, and moves on one of its results", async () => {
    const { trialId, claim } = await evidenceOnTrial();
    const { provider, started, corrections } = recordingProvider({ result: "supported", summary: "The sources agree." });

    await supervisorWith(provider).runOnce();

    const dispatched = started.find((options) => JSON.stringify(options.outputSchema).includes("unsupported"));
    expect(dispatched).toBeDefined();
    const branch = answerBranch(dispatched?.outputSchema);
    expect(branch.properties["result"]?.enum).toEqual(["supported", "unsupported"]);
    // The definition's own description is what the prompt tells it.
    expect(dispatched?.context).toContain("Weigh the evidence the item cites.");
    expect(corrections).toEqual([]);
    const design = readTrialDesign(handle.db, trialId)!;
    expect(getItem(handle.db, claim.id)?.stepId).toBe(design.stepIds.ev_check);
  });

  it("is refused a result the overlay does not declare, as a published definition's would be", async () => {
    const { trialId, claim } = await evidenceOnTrial();
    const { provider, corrections } = recordingProvider({ result: "inconclusive", summary: "Hard to say." });

    await supervisorWith(provider).runOnce();

    // Sent back against the schema, and never routed.
    const refusedFor = (messages: readonly string[]) => messages.find((message) => message.startsWith('The result did not match the required schema for "analyse_evidence"'));
    expect(refusedFor(corrections)).toContain("result: must be equal to one of the allowed values");
    const design = readTrialDesign(handle.db, trialId)!;
    expect(getItem(handle.db, claim.id)?.stepId).toBe(design.stepIds.ev_analyse);
    expect(listRunsForItem(handle.db, claim.id).map((run) => run.status)).not.toContain("succeeded");

    // The same answer to the same definition, published, is refused alike.
    expect(saveActionDefinition(handle.db, { ...analyseEvidence(), fields: {} }).ok).toBe(true);
    const published = createPipeline(handle.db, { projectId, name: "Evidence (live)" });
    // Analyse straight to its ends: what is compared is the answer, not what follows it.
    const graph = evidenceDraft();
    graph.steps = graph.steps.filter((entry) => entry.id !== "ev_check");
    graph.routes = graph.routes.filter((route) => route.fromStepId === "ev_analyse").map((route) => (route.target === "ev_check" ? { ...route, target: "ev_done" } : route));
    const saved = savePipeline(handle.db, undefined, {
      pipelineId: published.id,
      // Each agent step names the Adviser (EO-875), as a publish binds the draft's kind.
      steps: graph.steps.map(({ ownerRole, ...entry }) => ({
        ...entry,
        agentId: ownerRole === null ? null : agentOfKind(handle.db, ownerRole),
        id: `live_${entry.id}`,
        pipelineId: published.id,
        results: [],
        timeoutMs: null,
        workspaceId: null,
      })) as never,
      routes: graph.routes.map((route, index) => ({ ...route, id: `r${index}`, pipelineId: published.id, fromStepId: `live_${route.fromStepId}`, target: `live_${route.target}` })) as never,
      entryStepId: "live_ev_analyse",
    });
    expect(saved.problems.filter((problem) => problem.severity === "error")).toEqual([]);
    const live = createTestItem(handle.db, { type: "story", title: "Live claim", projectId, pipelineId: published.id, stepId: "live_ev_analyse" });
    const liveProvider = recordingProvider({ result: "inconclusive", summary: "Hard to say." });
    await supervisorWith(liveProvider.provider).runOnce();
    expect(refusedFor(liveProvider.corrections)).toEqual(refusedFor(corrections));
    expect(getItem(handle.db, live.id)?.stepId).toBe("live_ev_analyse");
  });
});

describe("discarding a trial that brought a definition", () => {
  it("leaves action_definitions exactly as it was before the trial", async () => {
    expect(saveActionDefinition(handle.db, { role: "qa", action: "alignment", results: [{ key: "aligned" }] }).ok).toBe(true);
    const before = listActionDefinitions(handle.db);
    const { trialId } = await evidenceOnTrial();

    expect(await discardTrial(handle.db, undefined, attachments, { trialPipelineId: trialId })).toMatchObject({ ok: true });

    expect(listActionDefinitions(handle.db)).toEqual(before);
    expect(getTrialPipeline(handle.db, trialId)).toBeUndefined();
    expect(readTrialActions(handle.db, trialId)).toEqual([]);
  });
});

/** A module test runner with nothing to run: the Evidence pipeline runs no module. */
const noModuleTests = {
  run: async (): Promise<ModuleTestRunAnswer> => {
    throw new Error("the Evidence pipeline runs no module");
  },
};

/** Moves the round's item to where it was expected to end, as a run's result and the assistant's press in the person's place would. */
function passRound(trialId: string, claim: Item): void {
  const design = readTrialDesign(handle.db, trialId)!;
  const agent = assistAgent(handle.db)!;
  transitionItem(handle.db, { itemId: claim.id, toStepId: design.stepIds.ev_check!, toPipelineId: trialId as Uuid, actor: "engine", reason: "run succeeded", runId: null });
  transitionItem(handle.db, { itemId: claim.id, toStepId: design.stepIds.ev_done!, toPipelineId: trialId as Uuid, actor: agent.id, reason: `decided "Approve" on the person's behalf`, runId: null });
}

const publish = (chat: Item, messageId: Uuid) =>
  publishTrialCommand(handle.db, undefined, noModuleTests, { attachmentStorage: attachments, worktreeRoot: join(scratch, "worktrees") }, { conversationId: chat.id, messageId, index: 0, acknowledgeLowCoverage: [] });

describe("publishing a trial that brought a definition", () => {
  it("writes the definition and the graph in one press, then discards the trial", async () => {
    const { chat, trialId, claim } = await evidenceOnTrial();
    passRound(trialId, claim);
    const card = turn(chat, { message: "Every test item ended where it was expected to.", cards: [{ kind: "trialPublish" }] });

    const answer = await publish(chat, card);

    expect(answer).toMatchObject({ saved: true, created: true, problem: null });
    expect(listPipelines(handle.db, projectId).some((pipeline) => pipeline.name === "Evidence")).toBe(true);
    expect(definitionRows().filter((row) => row.role === "eo_adviser")).toEqual([
      {
        role: "eo_adviser",
        action: "analyse_evidence",
        description: "Weigh the evidence the item cites.",
        results: [
          { key: "supported", label: "Supported", meaning: "The evidence holds up." },
          { key: "unsupported", label: "Unsupported", meaning: "The evidence does not hold up." },
        ],
        fields: {},
      },
    ]);
    expect(getTrialPipeline(handle.db, trialId)).toBeUndefined();
  });

  it("publishes nothing — no definition and no pipeline — where the save refuses a definition", async () => {
    const { chat, trialId, claim } = await evidenceOnTrial();
    passRound(trialId, claim);
    // What the trial carries no longer saves: a definition with no results.
    writeTrialActions(handle.db, trialId, [{ ...analyseEvidence(), fields: {}, results: [] }]);
    const card = turn(chat, { message: "Every test item ended where it was expected to.", cards: [{ kind: "trialPublish" }] });
    const before = definitionRows();

    const answer = await publish(chat, card);

    expect(answer.saved).toBe(false);
    expect(answer.problem).toContain("Nothing was approved and nothing was published");
    expect(answer.problem).toContain("eo_adviser's \"analyse_evidence\"");
    expect(definitionRows()).toEqual(before);
    expect(listPipelines(handle.db, projectId).some((pipeline) => pipeline.name === "Evidence")).toBe(false);
    expect(getTrialPipeline(handle.db, trialId)).toBeDefined();
  });
});

describe("a draft replacing a definition live work uses", () => {
  it("still makes a trial, and live items keep resolving the installed definition while it runs", async () => {
    expect(
      saveActionDefinition(handle.db, {
        role: "qa",
        action: "alignment",
        description: "Check the work against what was asked for.",
        results: [
          { key: "aligned", label: "Aligned" },
          { key: "gaps_found", label: "Gaps found" },
        ],
      }).ok,
    ).toBe(true);
    const installed = definitionRows();
    const checks = createPipeline(handle.db, { projectId, name: "Checks" });
    // The live step names a QA agent (EO-875); the draft below names its kind.
    const qa = createAgent(handle.db, { name: "QA", role: "qa", provider: "claude", instructions: "Check the work." });
    const align = (({ ownerRole: _kind, ...rest }: ReturnType<typeof step>) => rest)(step("chk_align", 0, "Align", { type: "agent", entryAction: "alignment" }));
    const liveSteps = [
      { ...align, agentId: qa.id, pipelineId: checks.id, results: [], timeoutMs: null, workspaceId: null },
      { ...step("chk_rework", 1, "Rework", { isTerminal: true }), pipelineId: checks.id, results: [], timeoutMs: null, workspaceId: null },
      { ...step("chk_done", 2, "Done", { isTerminal: true }), pipelineId: checks.id, results: [], timeoutMs: null, workspaceId: null },
    ];
    const liveRoutes = [
      { id: "c1", pipelineId: checks.id, fromStepId: "chk_align", resultKey: "aligned", label: "Aligned", tone: "success", target: "chk_done", position: 0 },
      { id: "c2", pipelineId: checks.id, fromStepId: "chk_align", resultKey: "gaps_found", label: "Gaps found", tone: "danger", target: "chk_rework", position: 1 },
    ];
    const first = savePipeline(handle.db, undefined, { pipelineId: checks.id, steps: liveSteps as never, routes: liveRoutes as never, entryStepId: "chk_align" });
    expect(first.problems.filter((problem) => problem.severity === "error")).toEqual([]);
    const live = createTestItem(handle.db, { type: "story", title: "Live check", projectId, pipelineId: checks.id, stepId: "chk_align" });

    // The draft gives `alignment` a third result, and routes it.
    const chat = await conversationOn(`/pipelines/${checks.id}`);
    const draft = {
      rationale: "Blocked work goes back for rework too.",
      entryStepId: "chk_align",
      target: { pipelineId: checks.id },
      steps: [step("chk_align", 0, "Align", { type: "agent", ownerRole: "qa", entryAction: "alignment" }), step("chk_rework", 1, "Rework", { isTerminal: true }), step("chk_done", 2, "Done", { isTerminal: true })],
      routes: [
        { fromStepId: "chk_align", resultKey: "aligned", label: "Aligned", tone: "success", target: "chk_done", position: 0 },
        { fromStepId: "chk_align", resultKey: "gaps_found", label: "Gaps found", tone: "danger", target: "chk_rework", position: 1 },
        { fromStepId: "chk_align", resultKey: "blocked", label: "Blocked", tone: "warning", target: "chk_rework", position: 2 },
      ],
    };
    const actions = [
      {
        role: "qa",
        action: "alignment",
        description: "Check the work against what was asked for.",
        results: [
          { key: "aligned", label: "Aligned" },
          { key: "gaps_found", label: "Gaps found" },
          { key: "blocked", label: "Blocked", meaning: "It cannot be checked yet." },
        ],
      },
    ];
    const plan = { items: [{ key: "one", title: "Check one", expected: { stepId: "chk_done" } }], steps: [{ stepId: "chk_align", mode: "real", reason: "It only reads." }] };
    const answer = await approve(chat, turn(chat, { message: "Here is the design.", draft, trial: plan, actions }, checks.id));
    expect(answer).toMatchObject({ approved: true });
    const [trialItem] = listTrialItemIds(handle.db, answer.trialPipelineId!).map((id) => getItem(handle.db, id)!) as [Item];

    expect(definitionRows()).toEqual(installed);
    expect(declared(registryForItem(handle.db, getItem(handle.db, live.id)!), "qa", "alignment")).toEqual(["aligned", "gaps_found"]);
    expect(declared(registryForItem(handle.db, trialItem), "qa", "alignment")).toEqual(["aligned", "gaps_found", "blocked"]);
  });
});

describe("a draft revised mid-loop", () => {
  it("applies a definition's new words without a card, and updates what the trial's items are held to", async () => {
    const { chat, trialId, claim } = await evidenceOnTrial();
    const reworded = analyseEvidence({ description: "Weigh every source the item cites." });

    const card = turn(chat, { message: "Reworded.", draft: evidenceDraft(), trial: EVIDENCE_PLAN, actions: [reworded] });

    const reply = listCommentsForItem(handle.db, chat.id).find((comment) => comment.parentId === card)!;
    expect(reply.body).toContain("Applied to the trial without a new design card");
    expect(reply.body).toContain(`the action definition eo_adviser's "analyse_evidence"`);
    expect(readTrialDesign(handle.db, trialId)?.pending).toBeNull();
    expect(readTrialActions(handle.db, trialId)[0]?.description).toBe("Weigh every source the item cites.");
    expect(registryForItem(handle.db, claim).actionDefinitions?.get("eo_adviser")?.get("analyse_evidence")?.definition.description).toBe("Weigh every source the item cites.");
    expect(listActionDefinitions(handle.db).filter((row) => row.role === "eo_adviser")).toEqual([]);
  });

  it("asks the person again for a definition that declares another result, and changes nothing the trial runs", async () => {
    const { chat, trialId } = await evidenceOnTrial();
    const widened = analyseEvidence({
      results: [...analyseEvidence().results, { key: "inconclusive", label: "Inconclusive", meaning: "It cannot be told." }],
    });

    const draft = evidenceDraft();
    draft.routes.push({ fromStepId: "ev_analyse", resultKey: "inconclusive", label: "Inconclusive", tone: "warning", target: "ev_dropped", position: 2 });
    turn(chat, { message: "Another outcome.", draft, trial: EVIDENCE_PLAN, actions: [widened] });

    expect(readTrialDesign(handle.db, trialId)?.pending?.reasons).toContain(`eo_adviser's "analyse_evidence" declares the result "inconclusive"`);
    expect(readTrialActions(handle.db, trialId)[0]?.results.map((result) => result.key)).toEqual(["supported", "unsupported"]);
  });
});

describe("the trial's definitions travelling", () => {
  it("reach a replica with the trial, so its items are held to them there", async () => {
    const { trialId, claim } = await evidenceOnTrial();
    const replica = openMigratedTestDb();
    try {
      replica.db.insert(projects).values(handle.db.select().from(projects).where(eq(projects.id, projectId)).get()!).run();
      for (const type of handle.db.select().from(itemTypes).where(eq(itemTypes.projectId, projectId)).all()) replica.db.insert(itemTypes).values(type).run();
      const wire = () => listPipelinesUpdatedSince(handle.db, { ts: 0, id: "" }, 100).map((pipeline) => RecordPipelineSchema.parse(JSON.parse(JSON.stringify(pipeline))));
      for (const pipeline of wire()) upsertReplicaPipeline(replica.db, pipeline);
      expect(readTrialActions(replica.db, trialId)).toEqual(readTrialActions(handle.db, trialId));
      expect(declared(registryForItem(replica.db, claim), "eo_adviser", "analyse_evidence")).toEqual(["supported", "unsupported"]);
      expect(listActionDefinitions(replica.db).filter((row) => row.role === "eo_adviser")).toEqual([]);
    } finally {
      replica.close();
    }
  });
});
