import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistOutputSchema, SCRATCH_KIND, pageDescriptorFor, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import {
  approveModule,
  createPipeline,
  createProject,
  createRun,
  createWorkspace,
  getItem,
  getModule,
  getTrialPipeline,
  latestTrialGrant,
  listCommentsForItem,
  listMentionsForComment,
  listStepsForPipeline,
  listTrialItemIds,
  listTrialOutcomes,
  getPipeline,
  listTrialRounds,
  moduleForkedFrom,
  replacePipelineGraph,
  readTrialDesign,
  readTrialPlan,
  saveModule,
  transitionItem,
  updateRun,
} from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { readAssistDraftForPublish, sendToAssist } from "../ipc/assistCommands.js";
import { clearPublishedView } from "../ipc/currentView.js";
import { clearHandlerRegistry } from "../ipc/registry.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { approveTrialDesign, continueTrialLoop } from "./design.js";
import { installTrialLoop } from "./loop.js";

/**
 * The design card (EO-587): a draft the assistant planned a test for is
 * offered with Approve design and no Publish; approving it makes the
 * trial, grants its modules, files its test items and starts the first
 * round; and every later draft in the conversation is classified by EO
 * against what was approved.
 *
 * In-memory databases throughout. Each assistant turn is posted the way
 * the supervisor posts one — the run's answer stored, then the reply —
 * and handed on to the loop the way the developer pack's wiring hands it.
 */
let handle: DbHandle;
let scratch: string;
let attachments: AttachmentStorage;
let stopLoop: () => void;
let deployModuleId: Uuid;
let projectId: Uuid;

const MANIFEST = {
  name: "Deploy",
  description: "Deploys the build.",
  inputs: {},
  needs: { bin: [], env: ["DEPLOY_TOKEN"], network: false, item: false, comment: false, attach: false, create: false },
  results: ["deployed"],
  sideEffects: true,
};

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-trial-design-"));
  const project = createProject(handle.db, { name: "Home", keyPrefix: "HOM" });
  projectId = project.id as Uuid;
  createWorkspace(handle.db, { kind: SCRATCH_KIND, projectId: project.id as Uuid });
  attachments = new AttachmentStorage(join(scratch, "attachments"));
  stopLoop = installTrialLoop(handle.db, { attachmentStorage: attachments, worktreeRoot: join(scratch, "worktrees") });
  // A module nobody has approved: what a design grants trial-only permission to.
  const saved = saveModule(handle.db, {
    slug: "deploy",
    name: "Deploy",
    description: "Deploys the build.",
    code: 'export default async function run() { return { ok: true, result: "deployed" }; }',
    manifest: MANIFEST,
    source: "architect",
  });
  if (!saved.ok) throw new Error(saved.reason);
  deployModuleId = saved.module.id as Uuid;
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

/** Fix (an agent step), Deploy (a module nobody has approved), a person's Check, then Done — or Dropped if the person rejects it. */
function hotfixDraft() {
  return {
    rationale: "Fix it, deploy it, then a person checks it.",
    entryStepId: "fix",
    target: { newPipeline: "Hotfix" },
    steps: [
      step("fix", 0, "Fix", { type: "agent", ownerRole: "implementer", entryAction: "implement", instructionsSummary: "Fix what the item says." }),
      step("deploy", 1, "Deploy", { type: "module", entryAction: deployModuleId }),
      step("check", 2, "Check"),
      step("done", 3, "Done", { isTerminal: true }),
      step("dropped", 4, "Dropped", { isTerminal: true }),
    ],
    routes: [
      { fromStepId: "fix", resultKey: "done", label: "Done", tone: "success", target: "deploy", position: 0 },
      { fromStepId: "deploy", resultKey: "deployed", label: "Deployed", tone: "success", target: "check", position: 0 },
      { fromStepId: "check", resultKey: "approve", label: "Approve", tone: "success", target: "done", position: 0 },
      { fromStepId: "check", resultKey: "reject", label: "Reject", tone: "danger", target: "dropped", position: 1 },
    ],
  };
}

/** A case that should pass, a case a person must reject, Fix real and Deploy mocked. */
function hotfixPlan() {
  return {
    items: [
      { key: "login", title: "Fix the login", expected: { stepId: "done", criteria: "the login works again" } },
      { key: "drop", title: "Drop the users table", body: "The person must reject this.", expected: { stepId: "dropped" } },
    ],
    steps: [
      { stepId: "fix", mode: "real", reason: "It works on a branch of its own, so nothing leaves EO." },
      {
        stepId: "deploy",
        mode: "mocked",
        reason: "It deploys to production, which EO classes as sending outside it.",
        mocks: [
          { item: "login", resultKey: "deployed", output: "Deployed to staging." },
          { item: "drop", resultKey: "deployed", output: "Deployed to staging." },
        ],
      },
    ],
  };
}

async function conversation(): Promise<Item> {
  const sent = await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/settings"), conversationId: null, body: "a hotfix pipeline, tested with real runs", attachmentIds: [], interrupt: false });
  return getItem(handle.db, sent.conversation.id as Uuid)!;
}

/** One assistant turn, posted as the supervisor posts it and handed to the loop as the pack's wiring hands it. Its draft card, if it posted one. */
function turn(chat: Item, output: unknown): Uuid | undefined {
  const parsed = AssistOutputSchema.parse(output);
  const agent = assistAgent(handle.db)!;
  const question = listCommentsForItem(handle.db, chat.id).filter((comment) => comment.authorType === "human").at(-1)!.id;
  const run = createRun(handle.db, { itemId: chat.id, agentId: agent.id, action: ASSIST_ACTION, initiationId: question });
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(parsed), parsed } });
  const posted = postAssistReply(handle.db, chat, agent.id, run.id, parsed);
  continueTrialLoop(handle.db, chat, posted.draftCardIds ?? []);
  return posted.draftCardIds?.[0];
}

const read = (chat: Item, messageId: Uuid) => readAssistDraftForPublish(handle.db, { conversationId: chat.id, messageId });
const approve = (chat: Item, messageId: Uuid) => approveTrialDesign(handle.db, { attachmentStorage: attachments, worktreeRoot: join(scratch, "worktrees") }, { conversationId: chat.id, messageId });

/** A design approved: the conversation, its card, and what approving it answered. */
async function approved() {
  const chat = await conversation();
  const card = turn(chat, { message: "Here is the design.", draft: hotfixDraft(), trial: hotfixPlan() })!;
  const answer = await approve(chat, card);
  if (!answer.approved) throw new Error(answer.problem ?? "not approved");
  return { chat, card, answer, trialId: answer.trialPipelineId! };
}

describe("the design card", () => {
  it("shows the graph, the module rows, the test items with their expected outcomes and every step's mode", async () => {
    const chat = await conversation();
    const card = turn(chat, { message: "Here is the design.", draft: hotfixDraft(), trial: hotfixPlan() })!;

    const shown = read(chat, card);
    expect(shown.problem).toBeNull();
    expect(shown.steps.map((entry) => entry.id)).toEqual(["fix", "deploy", "check", "done", "dropped"]);
    expect(shown.trial).not.toBeNull();
    expect(shown.trial!.items).toEqual([
      { key: "login", title: "Fix the login", body: null, expectedStepId: "done", expectedStepName: "Done", criteria: "the login works again" },
      { key: "drop", title: "Drop the users table", body: "The person must reject this.", expectedStepId: "dropped", expectedStepName: "Dropped", criteria: null },
    ]);
    // Every step, in order; one the plan does not name runs real and gives no reason.
    expect(shown.trial!.steps.map((entry) => [entry.name, entry.mode, entry.reason !== null])).toEqual([
      ["Fix", "real", true],
      ["Deploy", "mocked", true],
      ["Check", "real", false],
      ["Done", "real", false],
      ["Dropped", "real", false],
    ]);
    // What a mode is chosen from: the module says it has outside effects.
    expect(shown.trial!.steps.find((entry) => entry.stepId === "deploy")).toMatchObject({
      reaches: "sends",
      mocks: [
        { item: "Fix the login", resultKey: "deployed", output: "Deployed to staging." },
        { item: "Drop the users table", resultKey: "deployed", output: "Deployed to staging." },
      ],
    });
    expect(shown.trial!.modules).toEqual([{ slug: "deploy", name: "Deploy" }]);
    expect(shown.trial!).toMatchObject({ changes: [], problem: null, approved: null });
  });

  it("is a publish card, with no trial, when the turn planned no test", async () => {
    const chat = await conversation();
    const card = turn(chat, { message: "Here is the draft.", draft: hotfixDraft() })!;
    expect(read(chat, card).trial).toBeNull();
    const refused = await approve(chat, card);
    expect(refused).toMatchObject({ approved: false, trialPipelineId: null });
    expect(refused.problem).toContain("no trial plan");
  });
});

describe("Approve design", () => {
  it("creates the trial pipeline, records the trial grants, files every test item as a trial item and starts the first round", async () => {
    const { chat, card, answer, trialId } = await approved();

    expect(answer).toMatchObject({ approved: true, round: 1, problem: null });
    expect(answer.items.map((item) => [item.key, item.title])).toEqual([
      ["login", "Fix the login"],
      ["drop", "Drop the users table"],
    ]);
    // A hidden trial of this conversation, for a pipeline that does not exist yet.
    expect(getTrialPipeline(handle.db, trialId)).toMatchObject({ conversationId: chat.id, targetPipelineId: null });

    // The module nobody approved may run here, on the person's word, within what it declares.
    const grant = latestTrialGrant(handle.db, deployModuleId, trialId);
    expect(grant).toMatchObject({ grantedBy: "human", withdrawnAt: null, needs: { env: ["DEPLOY_TOKEN"], sideEffects: true, network: false } });
    expect(getModule(handle.db, deployModuleId)?.approvedAt).toBeNull();

    // Every test item, as a trial item, on the trial's first step.
    const design = readTrialDesign(handle.db, trialId)!;
    const filed = listTrialItemIds(handle.db, trialId).map((id) => getItem(handle.db, id)!);
    expect(filed.map((item) => [item.title, item.trialAt !== null, item.stepId])).toEqual([
      ["Fix the login", true, design.stepIds.fix],
      ["Drop the users table", true, design.stepIds.fix],
    ]);
    expect(listTrialRounds(handle.db, trialId).map((round) => [round.number, round.startedBy])).toEqual([[1, "human"]]);

    // The plan, in the trial's own ids: where each item must end, and what the mocked step reports for each.
    const [login, drop] = filed as [Item, Item];
    const plan = readTrialPlan(handle.db, trialId)!;
    expect(plan.expected).toEqual([
      { itemId: login.id, stepId: design.stepIds.done, criteria: "the login works again" },
      { itemId: drop.id, stepId: design.stepIds.dropped, criteria: null },
    ]);
    expect(plan.steps).toEqual([
      { stepId: design.stepIds.fix, mode: "real", mocks: [] },
      {
        stepId: design.stepIds.deploy,
        mode: "mocked",
        mocks: [
          { itemId: login.id, resultKey: "deployed", output: "Deployed to staging." },
          { itemId: drop.id, resultKey: "deployed", output: "Deployed to staging." },
        ],
      },
    ]);
    expect(design).toMatchObject({ commentId: card, filed: { [login.id]: "login", [drop.id]: "drop" } });

    // Nothing was published: the only pipeline called Hotfix is the trial, which no list shows.
    const note = listCommentsForItem(handle.db, chat.id).at(-1)!;
    expect(note).toMatchObject({ authorType: "engine", kind: "note" });
    expect(note.body).toContain("**Design approved**");
    expect(note.body).toContain(`- ${login.key} "Fix the login"`);

    // The card now says so, and offers nothing more.
    expect(read(chat, card).trial?.approved).toEqual({ trialPipelineId: trialId, round: 1 });
    const again = await approve(chat, card);
    expect(again).toMatchObject({ approved: false });
    expect(again.problem).toContain("already approved");
    expect(listTrialRounds(handle.db, trialId)).toHaveLength(1);
  });

  it("refuses a design card that has been superseded, and makes nothing", async () => {
    const chat = await conversation();
    const first = turn(chat, { message: "Here is the design.", draft: hotfixDraft(), trial: hotfixPlan() })!;
    turn(chat, { message: "A better one.", draft: { ...hotfixDraft(), rationale: "Better." }, trial: hotfixPlan() });
    const refused = await approve(chat, first);
    expect(refused.approved).toBe(false);
    expect(refused.problem).toContain("superseded");
    expect(readTrialDesign(handle.db, "nothing")).toBeUndefined();
  });
});

describe("EO judges where a trial item ended", () => {
  it("records a test item ending on a step other than its expected one as failed, whatever the assistant says after", async () => {
    const { chat, trialId } = await approved();
    const design = readTrialDesign(handle.db, trialId)!;
    const [login, drop] = listTrialItemIds(handle.db, trialId).map((id) => getItem(handle.db, id)!) as [Item, Item];
    const to = (item: Item, stepId: string) => transitionItem(handle.db, { itemId: item.id, toStepId: design.stepIds[stepId]!, toPipelineId: trialId as Uuid, actor: "engine", reason: "run succeeded", runId: null });

    // "Fix the login" is expected on Done and is rejected to Dropped; "Drop the users table" is expected on Dropped and ends there.
    to(login, "check");
    to(login, "dropped");
    to(drop, "check");
    to(drop, "dropped");

    // The assistant's next turn reads the wake and claims both passed.
    turn(chat, { message: "Both test items passed — the pipeline works." });

    const ends = listTrialOutcomes(handle.db, trialId).filter((outcome) => outcome.event === "terminal");
    expect(ends.map((outcome) => [outcome.itemId, outcome.stepId, outcome.failed])).toEqual([
      [login.id, design.stepIds.dropped, true],
      [drop.id, design.stepIds.dropped, false],
    ]);
    const wake = listCommentsForItem(handle.db, chat.id).find((comment) => comment.authorType === "engine" && comment.body.includes(`${login.key} "Fix the login"`) && comment.body.includes("reached the end"))!;
    expect(wake.body).toContain("it is not where it was expected to end, so this test item has failed.");
  });
});

describe("a draft revised while its design is under test", () => {
  it("applies a change to a step's instructions to the trial without a card, and starts the next round", async () => {
    const { chat, card, trialId } = await approved();
    const draft = hotfixDraft();
    draft.steps[0]!.instructionsSummary = "Fix what the item says, and run the tests before you finish.";

    // The plan left out: a revision mid-loop is a draft of the design under test.
    const revision = turn(chat, { message: "The fix step skipped the tests; told it not to.", draft })!;

    const design = readTrialDesign(handle.db, trialId)!;
    expect(listStepsForPipeline(handle.db, trialId).find((entry) => entry.id === design.stepIds.fix)?.instructionsSummary).toBe("Fix what the item says, and run the tests before you finish.");
    expect(listTrialRounds(handle.db, trialId).map((round) => round.number)).toEqual([1, 2]);
    expect(listTrialItemIds(handle.db, trialId)).toHaveLength(4);
    expect(readTrialPlan(handle.db, trialId)!.expected).toHaveLength(4);

    // Answered with what was done, so it is no card to approve or publish.
    const answer = listCommentsForItem(handle.db, chat.id).find((comment) => comment.parentId === revision)!;
    expect(answer).toMatchObject({ authorType: "engine", kind: "note" });
    expect(answer.body).toContain("**Applied to the trial without a new design card**");
    expect(answer.body).toContain('the instructions of "Fix"');
    expect(answer.body).toContain("Round 2 has started with 2 test items");
    expect(read(chat, revision).problem).toContain("superseded");
    // The approved design is still the card on show.
    expect(read(chat, card).trial?.approved).toEqual({ trialPipelineId: trialId, round: 2 });
  });

  it("applies module code changed within the grant without a card", async () => {
    const { chat, trialId } = await approved();
    const changed = saveModule(handle.db, {
      id: deployModuleId,
      slug: "deploy",
      name: "Deploy",
      description: "Deploys the build.",
      code: 'export default async function run() { console.log("deploying"); return { ok: true, result: "deployed" }; }',
      manifest: MANIFEST,
    });
    if (!changed.ok) throw new Error(changed.reason);
    expect(latestTrialGrant(handle.db, deployModuleId, trialId)?.withdrawnAt).toBeNull();

    turn(chat, { message: "Fixed the deploy module; same design again.", draft: hotfixDraft() });
    expect(listTrialRounds(handle.db, trialId).map((round) => round.number)).toEqual([1, 2]);
  });

  it("posts a step added as a new design card, and starts no round until it is approved", async () => {
    const { chat, trialId } = await approved();
    const draft = hotfixDraft();
    draft.steps.splice(1, 0, step("hotfix_review", 1, "Review", { type: "agent", ownerRole: "implementer", entryAction: "implement" }));
    draft.steps.forEach((entry, index) => (entry.position = index));
    draft.routes[0]!.target = "hotfix_review";
    draft.routes.push({ fromStepId: "hotfix_review", resultKey: "done", label: "Done", tone: "success", target: "deploy", position: 0 });
    const plan = hotfixPlan();
    plan.steps.push({ stepId: "hotfix_review", mode: "real", reason: "It only reads the branch." });

    const redesign = turn(chat, { message: "A review step would catch this.", draft, trial: plan })!;

    // No round, and the person is asked.
    expect(listTrialRounds(handle.db, trialId)).toHaveLength(1);
    expect(listTrialItemIds(handle.db, trialId)).toHaveLength(2);
    const asked = listCommentsForItem(handle.db, chat.id).at(-1)!;
    expect(asked.body).toContain("**This draft changes the design you approved**");
    expect(asked.body).toContain('- it adds the step "Review"');
    expect(listMentionsForComment(handle.db, asked.id).map((mention) => mention.targetType)).toEqual(["human"]);
    // A design card, saying why, with nothing applied to the trial.
    const shown = read(chat, redesign);
    expect(shown.problem).toBeNull();
    expect(shown.trial).toMatchObject({ approved: null });
    expect(shown.trial!.changes).toContain('it adds the step "Review"');
    expect(listStepsForPipeline(handle.db, trialId).map((entry) => entry.name)).not.toContain("Review");

    // Approved, it replaces the design under test: a new trial, its first round, and the old one gone.
    const answer = await approve(chat, redesign);
    expect(answer).toMatchObject({ approved: true, round: 1, problem: null });
    expect(getTrialPipeline(handle.db, trialId)).toBeUndefined();
    expect(listStepsForPipeline(handle.db, answer.trialPipelineId!).map((entry) => entry.name)).toContain("Review");
    expect(read(chat, redesign).trial?.approved).toEqual({ trialPipelineId: answer.trialPipelineId, round: 1 });
  });

  it("posts a change to the entry rules as a new design card, and applies none of it (EO-610)", async () => {
    const { chat, trialId } = await approved();
    const before = getPipeline(handle.db, trialId)?.entryRules;

    const redesign = turn(chat, { message: "It should need a write-up.", draft: { ...hotfixDraft(), entryRules: [{ kind: "description" }] }, trial: hotfixPlan() })!;

    expect(listTrialRounds(handle.db, trialId)).toHaveLength(1);
    expect(read(chat, redesign).trial?.changes).toEqual(["what work must have to enter becomes a description instead of whatever the pipeline already asks for"]);
    expect(getPipeline(handle.db, trialId)?.entryRules).toEqual(before);
  });

  it("posts an edited expected outcome as a new design card", async () => {
    const { chat, trialId } = await approved();
    const plan = hotfixPlan();
    // Moving where a case must end to where it ended is the person's call, never the loop's.
    plan.items[0]!.expected = { stepId: "dropped", criteria: "the login works again" };

    const redesign = turn(chat, { message: "Expecting it on Dropped instead.", draft: hotfixDraft(), trial: plan })!;

    expect(listTrialRounds(handle.db, trialId)).toHaveLength(1);
    expect(read(chat, redesign).trial?.changes).toEqual(['it changes the expected outcome of "Fix the login"']);
  });

  it("posts a module whose needs were widened past its grant as a new design card", async () => {
    const { chat, trialId } = await approved();
    const widened = saveModule(handle.db, {
      id: deployModuleId,
      slug: "deploy",
      name: "Deploy",
      description: "Deploys the build.",
      code: 'export default async function run() { return { ok: true, result: "deployed" }; }',
      manifest: { ...MANIFEST, needs: { ...MANIFEST.needs, network: true } },
    });
    if (!widened.ok) throw new Error(widened.reason);
    expect(latestTrialGrant(handle.db, deployModuleId, trialId)?.withdrawnAt).not.toBeNull();

    turn(chat, { message: "The deploy module needs the network; same design.", draft: hotfixDraft() });

    expect(listTrialRounds(handle.db, trialId)).toHaveLength(1);
    expect(listCommentsForItem(handle.db, chat.id).at(-1)!.body).toContain('- "Deploy" now needs more than its trial grant covers');
  });

  it("leaves a conversation testing nothing alone", async () => {
    const chat = await conversation();
    const card = turn(chat, { message: "Here is the draft.", draft: hotfixDraft() })!;
    expect(listCommentsForItem(handle.db, chat.id).some((comment) => comment.parentId === card)).toBe(false);
    expect(read(chat, card)).toMatchObject({ problem: null, trial: null });
  });
});

/** A published pipeline running `moduleId`, so live work uses it. */
function liveOn(moduleId: string, prefix: string): void {
  const pipeline = createPipeline(handle.db, { projectId, name: `Live ${prefix}` });
  replacePipelineGraph(
    handle.db,
    pipeline.id,
    [
      { id: `${prefix}_deploy`, pipelineId: pipeline.id as Uuid, position: 0, name: "Deploy", type: "module", entryAction: moduleId, isTerminal: false },
      { id: `${prefix}_done`, pipelineId: pipeline.id as Uuid, position: 1, name: "Done", type: "user", isTerminal: true },
    ],
    [{ pipelineId: pipeline.id as Uuid, fromStepId: `${prefix}_deploy`, resultKey: "deployed", label: "Deployed", tone: "success", target: `${prefix}_done`, position: 0 }],
    { entryStepId: `${prefix}_deploy` },
  );
}

/** The hotfix draft with one more result out of Check, sending the item back to Fix: a change to what the person approved. */
function withRedo() {
  const draft = hotfixDraft();
  draft.routes.push({ fromStepId: "check", resultKey: "redo", label: "Redo", tone: "warning", target: "fix", position: 2 });
  return draft;
}

/** Saves a module again with new code or a new manifest, as the loop's `module_save` would. */
function resave(moduleId: string, change: { code?: string; manifest?: typeof MANIFEST }): void {
  const module = getModule(handle.db, moduleId)!;
  const saved = saveModule(handle.db, {
    id: moduleId,
    slug: module.slug,
    name: module.name,
    description: module.description,
    code: change.code ?? module.code,
    manifest: change.manifest ?? (module.manifest as typeof MANIFEST),
  });
  if (!saved.ok) throw new Error(saved.reason);
}

describe("a redesign approved mid-loop", () => {
  it("still reads as the approved design card when its turn left the plan out", async () => {
    const { chat } = await approved();
    // A route added, and no `trial`: the approved plan is inherited.
    const redesign = turn(chat, { message: "Check can send it back to Fix.", draft: withRedo() })!;
    expect(read(chat, redesign).trial?.changes).toEqual(['"Check" declares the result "redo"']);

    const answer = await approve(chat, redesign);
    expect(answer).toMatchObject({ approved: true, round: 1 });

    // Read again after the new trial was made, which is after the card was posted.
    const shown = read(chat, redesign);
    expect(shown.problem).toBeNull();
    expect(shown.trial).not.toBeNull();
    expect(shown.trial!.approved).toEqual({ trialPipelineId: answer.trialPipelineId, round: 1 });
    expect(shown.trial!.items.map((item) => item.key)).toEqual(["login", "drop"]);
  });
});

describe("a change to the design waiting for the person", () => {
  it("holds across turns: a later draft back to the approved shape is a design card too, and starts no round until one is approved", async () => {
    const { chat, trialId } = await approved();
    const redesign = turn(chat, { message: "Check can send it back to Fix.", draft: withRedo() })!;
    expect(readTrialDesign(handle.db, trialId)?.pending).toEqual({ commentId: redesign, reasons: ['"Check" declares the result "redo"'] });

    // The assistant goes back to the approved shape, and then fixes a module within its grant and asks again.
    const reverted = turn(chat, { message: "Never mind, the original shape.", draft: hotfixDraft() })!;
    resave(deployModuleId, { code: 'export default async function run() { console.log("again"); return { ok: true, result: "deployed" }; }' });
    const again = turn(chat, { message: "Same design, the module fixed.", draft: hotfixDraft() })!;

    expect(listTrialRounds(handle.db, trialId)).toHaveLength(1);
    expect(listTrialItemIds(handle.db, trialId)).toHaveLength(2);
    expect(readTrialDesign(handle.db, trialId)?.pending?.commentId).toBe(again);
    // Neither was applied without a card, and each says why it is one.
    for (const card of [reverted, again]) expect(listCommentsForItem(handle.db, chat.id).some((comment) => comment.parentId === card)).toBe(false);
    expect(listCommentsForItem(handle.db, chat.id).at(-1)!.body).toContain("**A change to the design is still waiting for you**");
    const shown = read(chat, again).trial!;
    expect(shown.approved).toBeNull();
    expect(shown.changes).toEqual([expect.stringContaining("waiting for you")]);

    // Only the person approving a design ends the wait: a new trial, its first round.
    const answer = await approve(chat, again);
    expect(answer).toMatchObject({ approved: true, round: 1 });
    expect(getTrialPipeline(handle.db, trialId)).toBeUndefined();
    expect(readTrialDesign(handle.db, answer.trialPipelineId!)?.pending).toBeNull();
  });
});

describe("the modules a redesign grants", () => {
  it("shows the draft copy the loop has been fixing, whose needs approving grants, not the module the draft names", async () => {
    approveModule(handle.db, deployModuleId);
    liveOn(deployModuleId, "liveone");
    const { chat, trialId } = await approved();
    const copy = readTrialDesign(handle.db, trialId)!.moduleIds[deployModuleId]!;
    expect(copy).not.toBe(deployModuleId);

    // The copy now needs the network, which withdraws its grant: the next draft is a design card.
    resave(copy, { manifest: { ...MANIFEST, needs: { ...MANIFEST.needs, network: true } } });
    const redesign = turn(chat, { message: "The deploy needs the network now.", draft: hotfixDraft() })!;

    const shown = read(chat, redesign).trial!;
    expect(shown.changes).toEqual(['"Deploy (trial)" now needs more than its trial grant covers']);
    expect(shown.modules).toEqual([{ slug: getModule(handle.db, copy)!.slug, name: "Deploy (trial)" }]);

    const answer = await approve(chat, redesign);
    expect(answer.approved).toBe(true);
    expect(readTrialDesign(handle.db, answer.trialPipelineId!)!.moduleIds[deployModuleId]).toBe(copy);
    expect(latestTrialGrant(handle.db, copy, answer.trialPipelineId!)?.needs.network).toBe(true);
    // The module the draft names, and live work on it, were never touched.
    expect(getModule(handle.db, deployModuleId)?.manifest).toMatchObject({ needs: { network: false } });
  });

  it("copies a carried draft copy that live work has since adopted, keeping its fixes, rather than running it", async () => {
    approveModule(handle.db, deployModuleId);
    liveOn(deployModuleId, "livetwo");
    const { chat, trialId } = await approved();
    const copy = readTrialDesign(handle.db, trialId)!.moduleIds[deployModuleId]!;
    const fixed = 'export default async function run() { console.log("fixed in the loop"); return { ok: true, result: "deployed" }; }';
    resave(copy, { code: fixed });
    // A person approves the copy and a published pipeline comes to run it.
    approveModule(handle.db, copy);
    liveOn(copy, "adopted");

    const redesign = turn(chat, { message: "Check can send it back to Fix.", draft: withRedo() })!;
    expect(read(chat, redesign).trial!.modules.map((module) => module.slug)).toEqual([getModule(handle.db, copy)!.slug]);
    const answer = await approve(chat, redesign);
    expect(answer.approved).toBe(true);

    const runs = readTrialDesign(handle.db, answer.trialPipelineId!)!.moduleIds[deployModuleId]!;
    expect(runs).not.toBe(copy);
    expect(runs).not.toBe(deployModuleId);
    expect(moduleForkedFrom(handle.db, runs)).toBe(deployModuleId);
    expect(getModule(handle.db, runs)?.code).toBe(fixed);
    expect(latestTrialGrant(handle.db, copy, answer.trialPipelineId!)).toBeUndefined();
    // The adopted copy is live work's now: still approved, still in the catalogue, unchanged.
    expect(getModule(handle.db, copy)).toMatchObject({ code: fixed, archivedAt: null });
    expect(getModule(handle.db, copy)?.approvedAt).not.toBeNull();
  });
});
