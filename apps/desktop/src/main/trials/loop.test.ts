import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistOutputSchema, SCRATCH_KIND, TRIAL_STOP_CHOICES, pageDescriptorFor, trialStopChoiceOf, type AssistOutput, type Comment, type GuardConfigView, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import {
  createProject,
  createRun,
  createWorkspace,
  getItem,
  getTrialPipeline,
  listCommentsForItem,
  listMentionsForComment,
  listStepsForPipeline,
  listTrialOutcomes,
  openTrialStop,
  postComment,
  saveModule,
  transitionItem,
  updateRun,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { readGuards, writeGuards } from "../ipc/configCommands.js";
import { assistDeltaView, sendToAssist } from "../ipc/assistCommands.js";
import { postHumanComment } from "../ipc/domainCommands.js";
import { clearPublishedView } from "../ipc/currentView.js";
import { clearHandlerRegistry } from "../ipc/registry.js";
import { renderGuards } from "../mcpHost/render.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { writeAgentComment } from "../supervisor/agentComments.js";
import { attemptLimitStop } from "../supervisor/attemptLimit.js";
import { findPendingResponses } from "../supervisor/manualDispatch.js";
import { installTrialLoop, startTrialRound } from "./loop.js";
import { saveTrialPlan } from "./stepModes.js";
import { createTrialFromDraft, fileTrialItem } from "./trials.js";

/**
 * A draft's test-fix loop (EO-586): what a trial item does wakes the
 * assistant in the conversation the trial came from, and the guardrails
 * stop the loop with a comment asking the person.
 *
 * In-memory databases throughout. The four events are made by the writes
 * every path makes — `transitionItem` for a move, `postComment` for a
 * park — because that is where the loop listens.
 */
let handle: DbHandle;
let scratch: string;
let projectId: Uuid;
let stopLoop: () => void;
let attachments: AttachmentStorage;

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-trial-loop-"));
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
  entryAction: null,
  instructionsSummary: null,
  isTerminal: false,
  planMode: false,
  ...extra,
});

/** Fix (an agent step), a person's Check, then Done — or Dropped, if the person rejects it. */
const fixDraft = {
  rationale: "Fix it, then a person checks it.",
  entryStepId: "fix",
  target: { newPipeline: "Hotfix" },
  steps: [
    step("fix", 0, "Fix", { type: "agent", ownerRole: "implementer", entryAction: "implement" }),
    step("check", 1, "Check"),
    step("done", 2, "Done", { isTerminal: true }),
    step("dropped", 3, "Dropped", { isTerminal: true }),
  ],
  routes: [
    { fromStepId: "fix", resultKey: "done", label: "Done", tone: "success", target: "check", position: 0 },
    { fromStepId: "check", resultKey: "approve", label: "Approve", tone: "success", target: "done", position: 0 },
    { fromStepId: "check", resultKey: "reject", label: "Reject", tone: "danger", target: "dropped", position: 1 },
  ],
};

async function conversation(): Promise<Item> {
  const sent = await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/settings"), conversationId: null, body: "test this with real runs", attachmentIds: [], interrupt: false });
  return getItem(handle.db, sent.conversation.id as Uuid)!;
}

/** A succeeded assist turn carrying `draft`; the draft card it posted. */
function draftCard(chat: Item, draft: unknown): Uuid {
  const parsed: AssistOutput = AssistOutputSchema.parse({ message: "Here.", draft });
  const agent = assistAgent(handle.db)!;
  const question = listCommentsForItem(handle.db, chat.id).filter((comment) => comment.authorType === "human").at(-1)!.id;
  const run = createRun(handle.db, { itemId: chat.id, agentId: agent.id, action: ASSIST_ACTION, initiationId: question });
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(parsed), parsed } });
  postAssistReply(handle.db, chat, agent.id, run.id, parsed);
  return listCommentsForItem(handle.db, chat.id).find((comment) => comment.runId === run.id && comment.kind === PROPOSAL_KIND)!.id;
}

/** A trial of `fixDraft`, its conversation, and one test item expected to end on Done. */
async function trial(draft: unknown = fixDraft) {
  const chat = await conversation();
  const made = createTrialFromDraft(handle.db, undefined, { conversationId: chat.id, messageId: draftCard(chat, draft) });
  if (!made.ok) throw new Error(made.problem);
  const filed = fileTrialItem(handle.db, undefined, { trialPipelineId: made.trial.id, type: "story", title: "Fix the login" });
  if (!filed.ok) throw new Error(filed.problem);
  const saved = saveTrialPlan(handle.db, made.trial.id, { expected: [{ itemId: filed.item.id, stepId: made.stepIds.done!, criteria: "the login works" }] });
  if (!saved.ok) throw new Error(saved.problem);
  const ids = made.stepIds as Record<"fix" | "check" | "done" | "dropped", string>;
  return { chat, trialId: made.trial.id, item: filed.item, steps: ids };
}

/** A trial of Deploy (a module answering "deployed" or "failed", both sent to Check), then Done. */
async function shipTrial() {
  const saved = saveModule(handle.db, {
    slug: "deploy",
    name: "Deploy",
    description: "Deploys the build.",
    code: "export default async function run() { return { ok: true, result: \"deployed\" }; }",
    manifest: { name: "Deploy", description: "Deploys the build.", inputs: {}, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false }, results: ["deployed", "failed"] },
    source: "architect",
    approve: true,
  });
  if (!saved.ok) throw new Error(saved.reason);
  const shipDraft = {
    rationale: "Deploy, then a person checks it either way.",
    entryStepId: "deploy",
    target: { newPipeline: "Ship" },
    steps: [step("deploy", 0, "Deploy", { type: "module", entryAction: saved.module.id }), step("check", 1, "Check"), step("done", 2, "Done", { isTerminal: true })],
    routes: [
      { fromStepId: "deploy", resultKey: "deployed", label: "Deployed", tone: "success", target: "check", position: 0 },
      { fromStepId: "deploy", resultKey: "failed", label: "Failed", tone: "danger", target: "check", position: 1 },
      { fromStepId: "check", resultKey: "approve", label: "Approve", tone: "success", target: "done", position: 0 },
    ],
  };
  const chat = await conversation();
  const made = createTrialFromDraft(handle.db, undefined, { conversationId: chat.id, messageId: draftCard(chat, shipDraft) });
  if (!made.ok) throw new Error(made.problem);
  return { chat, made };
}

/** What EO posted on the conversation after `since` comments. */
const engineSince = (chat: Item, since: number): Comment[] => listCommentsForItem(handle.db, chat.id).slice(since).filter((comment) => comment.authorType === "engine");
const threadLength = (chat: Item): number => listCommentsForItem(handle.db, chat.id).length;

function move(item: Item, toStepId: string, trialId: string, reason: string | null = "run succeeded", runId: Uuid | null = null): void {
  transitionItem(handle.db, { itemId: item.id, toStepId, toPipelineId: trialId as Uuid, actor: "engine", reason, runId });
}

/** A run of Fix on `item` that answered `result`, stored as the supervisor stores one: `{ raw, parsed }`. */
function finishedRun(item: Item, result: string): Uuid {
  const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "succeeded" });
  updateRun(handle.db, run.id, { result: { raw: JSON.stringify({ result }), parsed: { result, summary: "Fixed it." } } });
  return run.id;
}

/** Expects exactly one wake: an engine note on the conversation mentioning the system agent, answered by a turn there and not on the trial item. */
function expectOneWake(chat: Item, item: Item, since: number): Comment {
  const posted = engineSince(chat, since);
  expect(posted).toHaveLength(1);
  const wake = posted[0]!;
  expect(wake.kind).toBe("note");
  const agent = assistAgent(handle.db)!;
  expect(listMentionsForComment(handle.db, wake.id).map((mention) => [mention.targetType, mention.targetId])).toEqual([["agent", agent.id]]);
  const pending = findPendingResponses(handle.db, [chat.id as Uuid, item.id]).filter((response) => response.commentId === wake.id);
  expect(pending).toEqual([expect.objectContaining({ itemId: chat.id, agentId: agent.id, action: ASSIST_ACTION })]);
  expect(findPendingResponses(handle.db, [item.id])).toEqual([]);
  return wake;
}

describe("trial events wake the assistant in its conversation", () => {
  it("arriving on a person's step: names the item, the step, the result and the expected outcome", async () => {
    const { chat, trialId, item, steps } = await trial();
    const since = threadLength(chat);

    move(item, steps.check, trialId, "run succeeded", finishedRun(item, "done"));

    const wake = expectOneWake(chat, item, since);
    expect(wake.body).toContain("A test item is on a person's step");
    // On the way, not at the end: Check is not where it is expected to end.
    expect(wake.body).toContain("- EO's reading: not an end yet — it waits here for a press, and has not reached its expected outcome.");
    expect(wake.body).not.toContain("this is the step it was expected to end on");
    expect(wake.body).toContain(`- Item: ${item.key} "Fix the login"`);
    expect(wake.body).toContain('- Step: "Check"');
    expect(wake.body).toContain("- Result: done");
    expect(wake.body).toContain('- Expected outcome: end on "Done", and: the login works');
    expect(listTrialOutcomes(handle.db, trialId)).toEqual([expect.objectContaining({ event: "person_step", stepId: steps.check, result: "done", failed: false })]);
  });

  it("reaching a terminal step: where it was expected, and where it was not", async () => {
    const { chat, trialId, item, steps } = await trial();
    move(item, steps.check, trialId);

    let since = threadLength(chat);
    move(item, steps.done, trialId, 'decided "Approve" on the person\'s behalf');
    let wake = expectOneWake(chat, item, since);
    expect(wake.body).toContain("A test item reached the end of the trial");
    expect(wake.body).toContain('- Step: "Done"');
    expect(wake.body).toContain("- Result: approve");
    expect(wake.body).toContain("it is where it was expected to end.");

    // A second item, rejected onto the other terminal step, has failed.
    const other = fileTrialItem(handle.db, undefined, { trialPipelineId: trialId, type: "story", title: "Fix the logout" });
    if (!other.ok) throw new Error(other.problem);
    saveTrialPlan(handle.db, trialId, { expected: [{ itemId: item.id, stepId: steps.done }, { itemId: other.item.id, stepId: steps.done }] });
    move(other.item, steps.check, trialId);
    since = threadLength(chat);
    move(other.item, steps.dropped, trialId, 'decided "Reject"');
    wake = expectOneWake(chat, other.item, since);
    expect(wake.body).toContain('- Step: "Dropped"');
    expect(wake.body).toContain("- Result: reject");
    expect(wake.body).toContain('- Expected outcome: end on "Done"');
    expect(wake.body).toContain("this test item has failed");
    expect(listTrialOutcomes(handle.db, trialId).at(-1)).toEqual(expect.objectContaining({ event: "terminal", failed: true }));
  });

  it("parking for attention: once per park, however many questions it asked, quoting what it said", async () => {
    const { chat, trialId, item } = await trial();
    const since = threadLength(chat);
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "awaiting_input" });

    for (const body of ["Which database should it use?", "May I add a dependency?"]) {
      postComment(handle.db, { itemId: item.id, runId: run.id, author: { type: "engine" }, kind: "question", body, mentions: [{ type: "human" }], parseBodyMentions: false });
    }

    const wake = expectOneWake(chat, item, since);
    expect(wake.body).toContain("A test item is waiting for attention");
    expect(wake.body).toContain('- Step: "Fix"');
    expect(wake.body).toContain("- Result: parked: asked a question");
    expect(wake.body).toContain("> Which database should it use?");
    expect(wake.body).toContain('- Expected outcome: end on "Done"');
    expect(listTrialOutcomes(handle.db, trialId)).toEqual([expect.objectContaining({ event: "parked", failed: true, runId: run.id })]);
  });

  it("failing past its attempts: told apart from an ordinary park by the attempt limit's own words", async () => {
    const { chat, trialId, item } = await trial();
    const since = threadLength(chat);
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "awaiting_input" });

    postComment(handle.db, { itemId: item.id, runId: run.id, author: { type: "engine" }, kind: "escalation", body: attemptLimitStop(3, "implement", 3), mentions: [{ type: "human" }], parseBodyMentions: false });

    const wake = expectOneWake(chat, item, since);
    expect(wake.body).toContain("A test item failed past its attempts");
    expect(wake.body).toContain('- Step: "Fix"');
    expect(wake.body).toContain("- Result: failed past its attempts");
    expect(wake.body).toContain('- Expected outcome: end on "Done"');
    expect(listTrialOutcomes(handle.db, trialId)).toEqual([expect.objectContaining({ event: "attempts", failed: true })]);
  });

  it("names the result a run reported where two routes lead to the same step", async () => {
    const { chat, made } = await shipTrial();
    const filed = fileTrialItem(handle.db, undefined, { trialPipelineId: made.trial.id, type: "story", title: "Ship it" });
    if (!filed.ok) throw new Error(filed.problem);
    const since = threadLength(chat);

    move(filed.item, made.stepIds.check!, made.trial.id, "run succeeded", finishedRun(filed.item, "failed"));

    const wake = expectOneWake(chat, filed.item, since);
    expect(wake.body).toContain("- Result: failed");
    expect(listTrialOutcomes(handle.db, made.trial.id)).toEqual([expect.objectContaining({ result: "failed" })]);

    // The answer's own `result` is the result, whatever else it spells: a
    // summary that happens to read "deployed" is prose.
    const spelled = fileTrialItem(handle.db, undefined, { trialPipelineId: made.trial.id, type: "story", title: "Ship it, said the summary" });
    if (!spelled.ok) throw new Error(spelled.problem);
    const conflicting = createRun(handle.db, { itemId: spelled.item.id, agentId: null, action: "deploy", status: "succeeded" });
    updateRun(handle.db, conflicting.id, { result: { raw: "", parsed: { summary: "deployed", detail: "deployed", result: "failed" } } });
    move(spelled.item, made.stepIds.check!, made.trial.id, "run succeeded", conflicting.id);
    expect(listTrialOutcomes(handle.db, made.trial.id).at(-1)).toEqual(expect.objectContaining({ itemId: spelled.item.id, result: "failed" }));

    // A run whose answer names neither says which it could have been, not the move's own reason.
    const other = fileTrialItem(handle.db, undefined, { trialPipelineId: made.trial.id, type: "story", title: "Ship it again" });
    if (!other.ok) throw new Error(other.problem);
    const quietRun = createRun(handle.db, { itemId: other.item.id, agentId: null, action: "deploy", status: "succeeded" });
    move(other.item, made.stepIds.check!, made.trial.id, "run succeeded", quietRun.id);
    expect(listTrialOutcomes(handle.db, made.trial.id).at(-1)).toEqual(expect.objectContaining({ result: "one of deployed, failed" }));
  });

  it("takes the result the move says it was sent on, where a pack read the answer its own way", async () => {
    // An answer whose own words settle nothing — shaped like a review's,
    // which a pack maps to a key the answer never spells — and whose prose
    // spells the other route's key. Only the key the move carries, as the
    // supervisor's moves carry it, can say which of the two it was.
    const { chat, made } = await shipTrial();
    const filed = fileTrialItem(handle.db, undefined, { trialPipelineId: made.trial.id, type: "story", title: "Ship it" });
    if (!filed.ok) throw new Error(filed.problem);
    const item = filed.item;
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "deploy", status: "succeeded" });
    updateRun(handle.db, run.id, { result: { raw: "", parsed: { verdict: "reject", feedback: "deployed nowhere", blocking_issues: ["deployed"] } } });
    const since = threadLength(chat);

    transitionItem(handle.db, { itemId: item.id, toStepId: made.stepIds.check!, toPipelineId: made.trial.id as Uuid, actor: "engine", reason: "run succeeded", runId: run.id, resultKey: "failed" });

    const wake = expectOneWake(chat, item, since);
    expect(wake.body).toContain("- Result: failed");
  });

  it("parking with a blocking output wakes once, through the comment tool; an output that does not block wakes nothing", async () => {
    const { chat, trialId, item } = await trial();
    const agent = assistAgent(handle.db)!;
    const since = threadLength(chat);

    const quiet = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement", status: "running" });
    expect(writeAgentComment(handle.db, { itemId: item.id, runId: quiet.id, agentId: agent.id }, { kind: "output", body: "Here is the fix, @user.", mentions: ["user"] }).ends).toBe(false);
    expect(threadLength(chat)).toBe(since);

    const blocking = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement", status: "running" });
    expect(writeAgentComment(handle.db, { itemId: item.id, runId: blocking.id, agentId: agent.id }, { kind: "output", body: "The fix — please look before I go on.", mentions: ["user"], blocking: true }).ends).toBe(true);

    const wake = expectOneWake(chat, item, since);
    expect(wake.body).toContain("A test item is waiting for attention");
    expect(wake.body).toContain("- Result: parked: its output waits for you");
    expect(wake.body).toContain("> The fix — please look before I go on.");
    expect(listTrialOutcomes(handle.db, trialId)).toEqual([expect.objectContaining({ event: "parked", runId: blocking.id })]);
  });

  it("filed straight onto a person's step, the item wakes the assistant once", async () => {
    const checkFirst = { ...fixDraft, entryStepId: "check" };
    const chat = await conversation();
    const made = createTrialFromDraft(handle.db, undefined, { conversationId: chat.id, messageId: draftCard(chat, checkFirst) });
    if (!made.ok) throw new Error(made.problem);
    const since = threadLength(chat);

    const filed = fileTrialItem(handle.db, undefined, { trialPipelineId: made.trial.id, type: "story", title: "Check the login" });
    if (!filed.ok) throw new Error(filed.problem);

    const wake = expectOneWake(chat, filed.item, since);
    expect(wake.body).toContain("A test item is on a person's step");
    expect(wake.body).toContain('- Step: "Check"');
    expect(wake.body).toContain("- Result: filed on it as the trial's first step");
    expect(wake.body).toContain("- Expected outcome: none was set for this test item");
  });

  it("posts nothing on any conversation for the same events on an item that is not a trial item", async () => {
    const { chat, trialId } = await trial();
    const since = threadLength(chat);
    const live = createTestItem(handle.db, { type: "story", title: "Live work", projectId, stepId: "todo" });
    const terminal = listStepsForPipeline(handle.db, live.pipelineId!).find((candidate) => candidate.isTerminal)!;

    postComment(handle.db, { itemId: live.id, author: { type: "engine" }, kind: "escalation", body: attemptLimitStop(3, "implement", 3), mentions: [{ type: "human" }], parseBodyMentions: false });
    postComment(handle.db, { itemId: live.id, author: { type: "engine" }, kind: "escalation", body: "This step routes this result to you.", mentions: [{ type: "human" }], parseBodyMentions: false });
    transitionItem(handle.db, { itemId: live.id, toStepId: terminal.id, actor: "human", reason: null });

    expect(threadLength(chat)).toBe(since);
    expect(listTrialOutcomes(handle.db, trialId)).toEqual([]);
  });

  it("does not wake on a trial item's ordinary moves and comments", async () => {
    const { chat, item } = await trial();
    const since = threadLength(chat);

    postComment(handle.db, { itemId: item.id, author: { type: "engine" }, kind: "note", body: "Worktree ready." });
    postComment(handle.db, { itemId: item.id, author: { type: "engine" }, kind: "escalation", body: "Nobody is asked.", mentions: [], parseBodyMentions: false });

    expect(threadLength(chat)).toBe(since);
  });
});

/** The guardrails as stored, with `patch` over them. */
const guards = (patch: Partial<GuardConfigView> = {}): GuardConfigView => ({ ...readGuards(handle.db), ...patch });

function startRound(trialId: string, patch: Partial<GuardConfigView> = {}) {
  return startTrialRound(handle.db, { trialPipelineId: trialId }, guards(patch));
}

/** A reply under `parentId`, through `comments:post` as the person files one — or as an agent, with `actingAgentId`. */
function reply(chat: Item, parentId: string, body: string, actingAgentId?: string) {
  return postHumanComment(
    handle.db,
    undefined,
    { itemId: chat.id, parentId, body, mentions: [], pinned: false, ...(actingAgentId === undefined ? {} : { actingAgentId }) },
    attachments,
  );
}

/** Expects the newest comment on the conversation to be a stop asking the person, and answers with it. */
function expectStop(chat: Item, since: number, says: string): Comment {
  const posted = engineSince(chat, since);
  expect(posted).toHaveLength(1);
  const stop = posted[0]!;
  expect(stop.kind).toBe("escalation");
  expect(stop.body).toContain(says);
  expect(stop.options).toEqual(["Keep going", "Publish anyway", "Discard"]);
  expect(listMentionsForComment(handle.db, stop.id).map((mention) => mention.targetType)).toEqual(["human"]);
  return stop;
}

describe("the loop's guardrails", () => {
  it("are settings guardrails_get reads and guardrails_set writes, defaulting to eight rounds, no budget and the repeated-failure stop on", () => {
    expect(readGuards(handle.db)).toEqual(expect.objectContaining({ trialRoundsPerDraft: 8, trialBudgetCentsPerDraft: null, trialStopOnRepeatedFailure: true }));
    expect(renderGuards(readGuards(handle.db))).toContain("- rounds of a draft's test items before testing stops and asks the person: 8");

    const written = writeGuards(handle.db, guards({ trialRoundsPerDraft: 3, trialBudgetCentsPerDraft: 2_500, trialStopOnRepeatedFailure: false }));

    expect(written.saved).toBe(true);
    expect(readGuards(handle.db)).toEqual(expect.objectContaining({ trialRoundsPerDraft: 3, trialBudgetCentsPerDraft: 2_500, trialStopOnRepeatedFailure: false }));
    const rendered = renderGuards(readGuards(handle.db));
    expect(rendered).toContain("- budget for testing one draft: 2500¢");
    expect(rendered).toContain("- the same step failing with the same result in two rounds in a row: does not stop testing");
  });

  it("refuses the ninth round with the default setting, asking the person, and keep going counts again", async () => {
    const { chat, trialId } = await trial();
    for (let round = 1; round <= 8; round += 1) expect(startRound(trialId)).toEqual({ ok: true, round: expect.objectContaining({ number: round }) });

    const since = threadLength(chat);
    const ninth = startRound(trialId);
    expect(ninth).toEqual({ ok: false, problem: expect.stringContaining("8 rounds have run"), stop: expect.objectContaining({ guard: "rounds" }) });
    const stop = expectStop(chat, since, "8 rounds have run, which is as many as one draft is allowed (8)");

    // Asked again while it waits: refused, saying why, without asking twice.
    const waiting = threadLength(chat);
    expect(startRound(trialId)).toEqual({ ok: false, problem: expect.stringContaining("stopped until the person answers"), stop: expect.objectContaining({ commentId: stop.id }) });
    expect(threadLength(chat)).toBe(waiting);

    // The chat draws its three answers as buttons until one is given.
    const offered = () => assistDeltaView(handle.db, chat.id)!.messages.find((message) => message.id === stop.id)!;
    expect(offered()).toEqual(expect.objectContaining({ canAnswer: true, options: ["Keep going", "Publish anyway", "Discard"] }));

    const beforeAnswer = threadLength(chat);
    await reply(chat, stop.id, "keep going");
    expect(offered().canAnswer).toBe(false);
    const told = engineSince(chat, beforeAnswer);
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain("The person chose to keep going");
    expect(listMentionsForComment(handle.db, told[0]!.id).map((mention) => mention.targetId)).toEqual([assistAgent(handle.db)!.id]);
    expect(openTrialStop(handle.db, trialId)).toBeUndefined();

    // The count starts again: rounds started before the answer no longer count.
    for (let round = 9; round <= 16; round += 1) expect(startRound(trialId)).toEqual({ ok: true, round: expect.objectContaining({ number: round }) });
  });

  it("after keep going, counts every round started after the answer, even in the answer's own millisecond", async () => {
    const { chat, trialId } = await trial();
    for (let round = 1; round <= 8; round += 1) expect(startRound(trialId).ok).toBe(true);
    const stopped = startRound(trialId);
    if (stopped.ok || stopped.stop === null) throw new Error("expected a stop");

    // One frozen instant: the answer and every round after it share it.
    const frozen = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
    try {
      await reply(chat, stopped.stop.commentId, "Keep going");
      for (let round = 9; round <= 16; round += 1) expect(startRound(trialId)).toEqual({ ok: true, round: expect.objectContaining({ number: round }) });

      const since = threadLength(chat);
      expect(startRound(trialId)).toEqual({ ok: false, problem: expect.stringContaining("8 rounds have run"), stop: expect.objectContaining({ guard: "rounds" }) });
      expectStop(chat, since, "8 rounds have run, which is as many as one draft is allowed (8)");
    } finally {
      frozen.mockRestore();
    }
  });

  it("refuses a round past the draft's budget", async () => {
    const { chat, trialId, item } = await trial();
    expect(startRound(trialId, { trialBudgetCentsPerDraft: 100 }).ok).toBe(true);
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "succeeded" });
    updateRun(handle.db, run.id, { costCents: 150, startedAt: Date.now() });

    const since = threadLength(chat);
    const refused = startRound(trialId, { trialBudgetCentsPerDraft: 100 });

    expect(refused).toEqual({ ok: false, problem: expect.stringContaining("its budget is $1.00"), stop: expect.objectContaining({ guard: "budget" }) });
    expectStop(chat, since, "testing this draft has cost $1.50, and its budget is $1.00");
    // Until the person answers, no round starts, whatever the budget now says.
    expect(startRound(trialId, { trialBudgetCentsPerDraft: null })).toEqual(expect.objectContaining({ ok: false, problem: expect.stringContaining("stopped until the person answers") }));
  });

  it("refuses a round after the same step failed with the same result in two rounds in a row, and says what still fails", async () => {
    const { chat, trialId, item } = await trial();
    const park = () => {
      const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "awaiting_input" });
      postComment(handle.db, { itemId: item.id, runId: run.id, author: { type: "engine" }, kind: "escalation", body: attemptLimitStop(3, "implement", 3), mentions: [{ type: "human" }], parseBodyMentions: false });
    };
    expect(startRound(trialId).ok).toBe(true);
    park();
    expect(startRound(trialId).ok).toBe(true);
    park();

    // Off, it does not stop.
    expect(startRound(trialId, { trialStopOnRepeatedFailure: false }).ok).toBe(true);
    park();

    const since = threadLength(chat);
    const refused = startRound(trialId);

    expect(refused).toEqual({ ok: false, problem: expect.stringContaining('"Fix" failed with the same result'), stop: expect.objectContaining({ guard: "repeated_failure" }) });
    const stop = expectStop(chat, since, '"Fix" failed with the same result (failed past its attempts) in rounds 2 and 3');
    expect(stop.body).toContain(`What still fails, as of round 3:\n- ${item.key} "Fix the login": "Fix", failed past its attempts — expected to end on "Done"`);
  });

  it("does not stop for a failure that changed between rounds", async () => {
    const { trialId, item, steps } = await trial();
    expect(startRound(trialId).ok).toBe(true);
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "awaiting_input" });
    postComment(handle.db, { itemId: item.id, runId: run.id, author: { type: "engine" }, kind: "escalation", body: attemptLimitStop(3, "implement", 3), mentions: [{ type: "human" }], parseBodyMentions: false });
    expect(startRound(trialId).ok).toBe(true);
    move(item, steps.check, trialId);
    move(item, steps.dropped, trialId, 'decided "Reject"');

    expect(startRound(trialId).ok).toBe(true);
  });

  it("publish anyway wakes the assistant to bring the publish card", async () => {
    const { chat, trialId } = await trial();
    expect(startRound(trialId, { trialRoundsPerDraft: 1 }).ok).toBe(true);
    const stopped = startRound(trialId, { trialRoundsPerDraft: 1 });
    if (stopped.ok || stopped.stop === null) throw new Error("expected a stop");

    const since = threadLength(chat);
    await reply(chat, stopped.stop.commentId, "Publish anyway");

    const told = engineSince(chat, since);
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain("The person chose to publish");
    expect(told[0]!.body).toContain("Bring the publish card");
    expect(listMentionsForComment(handle.db, told[0]!.id).map((mention) => mention.targetType)).toEqual(["agent"]);
    expect(openTrialStop(handle.db, trialId)).toBeUndefined();
  });

  it("discard deletes the trial and its test items, and says so", async () => {
    const { chat, trialId, item } = await trial();
    startRound(trialId, { trialRoundsPerDraft: 1 });
    const stopped = startRound(trialId, { trialRoundsPerDraft: 1 });
    if (stopped.ok || stopped.stop === null) throw new Error("expected a stop");

    await reply(chat, stopped.stop.commentId, "Discard");

    await vi.waitFor(() => expect(getTrialPipeline(handle.db, trialId)).toBeUndefined());
    expect(getItem(handle.db, item.id)).toBeUndefined();
    await vi.waitFor(() => expect(listCommentsForItem(handle.db, chat.id).at(-1)?.body).toContain('The person chose to discard "Hotfix (trial)"'));
  });

  it("an answer that is not one of the three leaves the loop stopped, and says so under the stop", async () => {
    const { chat, trialId } = await trial();
    startRound(trialId, { trialRoundsPerDraft: 1 });
    const stopped = startRound(trialId, { trialRoundsPerDraft: 1 });
    if (stopped.ok || stopped.stop === null) throw new Error("expected a stop");

    const since = threadLength(chat);
    await reply(chat, stopped.stop.commentId, "hmm, not sure");

    const told = engineSince(chat, since);
    expect(told).toHaveLength(1);
    expect(told[0]!.parentId).toBe(stopped.stop.commentId);
    expect(told[0]!.body).toContain("That is not one of the answers");
    expect(openTrialStop(handle.db, trialId)).toEqual(expect.objectContaining({ id: stopped.stop.id }));
    // Still stopped, so the chat still offers the three answers.
    const offered = () => assistDeltaView(handle.db, chat.id)!.messages.find((message) => message.id === stopped.stop!.commentId)!;
    expect(offered().canAnswer).toBe(true);

    await reply(chat, stopped.stop.commentId, "Publish anyway");
    expect(offered().canAnswer).toBe(false);
  });

  it("refuses the assistant answering its own stop through comments:post, posting nothing and leaving it stopped", async () => {
    const { chat, trialId } = await trial();
    startRound(trialId, { trialRoundsPerDraft: 1 });
    const stopped = startRound(trialId, { trialRoundsPerDraft: 1 });
    if (stopped.ok || stopped.stop === null) throw new Error("expected a stop");
    const since = threadLength(chat);

    await expect(reply(chat, stopped.stop.commentId, "Keep going", assistAgent(handle.db)!.id)).rejects.toThrow("Only the person can answer a stop on testing a draft");
    await expect(reply(chat, stopped.stop.commentId, "Discard", assistAgent(handle.db)!.id)).rejects.toThrow("Only the person can answer");

    expect(threadLength(chat)).toBe(since);
    expect(openTrialStop(handle.db, trialId)).toEqual(expect.objectContaining({ id: stopped.stop.id }));
    expect(getTrialPipeline(handle.db, trialId)).toBeDefined();
    // Anywhere else, the assistant's comment goes in as it always did.
    const topLevel = await postHumanComment(handle.db, undefined, { itemId: chat.id, parentId: null, body: "Noted.", mentions: [], pinned: false, actingAgentId: assistAgent(handle.db)!.id });
    expect(topLevel.commentId).toEqual(expect.any(String));
    expect(openTrialStop(handle.db, trialId)).toEqual(expect.objectContaining({ id: stopped.stop.id }));
  });
});

describe("reading an answer to a stop", () => {
  it("takes each choice however it is typed, and nothing else", () => {
    for (const choice of TRIAL_STOP_CHOICES) {
      expect(trialStopChoiceOf(choice)).toBe(choice);
      expect(trialStopChoiceOf(`  ${choice.toUpperCase()}. `)).toBe(choice);
    }
    expect(trialStopChoiceOf("keep going, but slower")).toBeNull();
  });
});
