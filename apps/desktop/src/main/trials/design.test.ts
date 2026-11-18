import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_MCP_SERVER_NAME, AssistOutputSchema, MOCKED_TEAM_NOTE, SCRATCH_KIND, pageDescriptorFor, type Agent, type AgentEvent, type Item, type Uuid } from "@eo/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import { onCommentPosted } from "../db/commentEvents.js";
import {
  appendRunEvent,
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
  listAgents,
  listTrialRounds,
  moduleForkedFrom,
  replacePipelineGraph,
  readTrialDesign,
  readTrialPlan,
  saveModule,
  transitionItem,
  updateAgent,
  updateRun,
} from "../db/repos/index.js";
import { setSetting } from "../db/repos/settingsRepo.js";
import { items, modules, moduleTrialGrants, pipelines, trialRounds, workspaces } from "../db/schema.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { onTransitionApplied } from "../db/transitionEvents.js";
import { CHANGE_PUSH_WINDOW_MS } from "../changeAnnouncers.js";
import { createEngine } from "../engine.js";
import { readAssistDraftForPublish, sendToAssist } from "../ipc/assistCommands.js";
import { GUARDS_KEY } from "../ipc/configCommands.js";
import { clearPublishedView } from "../ipc/currentView.js";
import { clearHandlerRegistry } from "../ipc/registry.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { approveTrialDesign, continueTrialLoop, proposedTrialProblem } from "./design.js";
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
function turn(chat: Item, output: unknown, readPipeline?: string): Uuid | undefined {
  const parsed = AssistOutputSchema.parse(output);
  const agent = assistAgent(handle.db)!;
  const question = listCommentsForItem(handle.db, chat.id).filter((comment) => comment.authorType === "human").at(-1)!.id;
  const run = createRun(handle.db, { itemId: chat.id, agentId: agent.id, action: ASSIST_ACTION, initiationId: question });
  // The pipeline the draft changes, read in the turn as a draft of one has to be.
  if (readPipeline !== undefined) {
    appendRunEvent(handle.db, run.id, "tool_call", { name: PIPELINE_READ, args: { pipelineId: readPipeline }, callId: "call-0" });
    appendRunEvent(handle.db, run.id, "tool_result", { name: PIPELINE_READ, callId: "call-0", ok: true, output: "", truncated: false });
  }
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(parsed), parsed } });
  const posted = postAssistReply(handle.db, chat, agent.id, run.id, parsed);
  continueTrialLoop(handle.db, chat, posted.draftCardIds ?? []);
  return posted.draftCardIds?.[0];
}

const PIPELINE_READ = `mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_get`;
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

  it("says whether a team step's team runs for real on the test items, or is mocked and so not tested (EO-848)", async () => {
    // Team members are held to report-only, which EO can do on Claude and not on the seeded fake backend.
    for (const agent of listAgents(handle.db)) updateAgent(handle.db, agent.id, { provider: "claude" });
    const team = { coordination: "leader", leader: { role: "implementer", instructions: "Plan the fix and weigh the reports." }, roles: ["reviewer"] };
    const draft = hotfixDraft();
    draft.steps[0] = { ...draft.steps[0]!, team } as (typeof draft.steps)[number];
    const chat = await conversation();

    const real = read(chat, turn(chat, { message: "The team runs.", draft, trial: hotfixPlan() })!);
    expect(real.problem).toBeNull();
    const fix = real.trial!.steps.find((entry) => entry.stepId === "fix")!;
    expect(fix.team).toEqual({ coordination: "leader", tested: true, note: expect.stringContaining("Runs as a leader-led team for real: its participants run on the test items") });
    // A step with no team says nothing about one.
    expect(real.trial!.steps.find((entry) => entry.stepId === "deploy")!.team).toBeNull();

    const plan = hotfixPlan();
    plan.steps[0] = {
      stepId: "fix",
      mode: "mocked",
      reason: "The team is not what this test is about.",
      mocks: [
        { item: "login", resultKey: "done", output: "Fixed." },
        { item: "drop", resultKey: "done", output: "Fixed." },
      ],
    };
    const mocked = read(chat, turn(chat, { message: "The team is mocked.", draft, trial: plan })!);
    const mockedFix = mocked.trial!.steps.find((entry) => entry.stepId === "fix")!;
    expect(mockedFix.mode).toBe("mocked");
    expect(mockedFix.team).toEqual({ coordination: "leader", tested: false, note: expect.stringContaining(MOCKED_TEAM_NOTE) });
    expect(mockedFix.team!.note).toMatch(/^Mocked — a leader-led team that does not run on this trial\./);
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

  it("saves a revised draft whose brief names another step, under that step's trial id (EO-831)", async () => {
    const { chat, trialId } = await approved();
    const draft = hotfixDraft();
    draft.steps[0]!.instructionsSummary = "Fix what the item says, and run the tests before you finish.";
    draft.steps[2] = step("check", 2, "Check", { brief: [{ show: "output", step: "fix" }, { show: "comment", kind: "approval" }] });

    const revision = turn(chat, { message: "The check now shows what Fix produced.", draft })!;

    const design = readTrialDesign(handle.db, trialId)!;
    const answer = listCommentsForItem(handle.db, chat.id).find((comment) => comment.parentId === revision)!;
    expect(answer.body).toContain("**Applied to the trial without a new design card**");
    const check = listStepsForPipeline(handle.db, trialId).find((entry) => entry.id === design.stepIds.check);
    expect(check?.brief).toEqual([{ show: "output", step: design.stepIds.fix }, { show: "comment", kind: "approval" }]);
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

/**
 * EO-833. Whether Approve design would make its trial is asked before
 * the card is offered — while the assistant's turn is still open, and
 * again whenever the card is read — by doing what Approve design does
 * inside a transaction that is always rolled back.
 */
describe("the check that a design's trial can be made", () => {
  /**
   * A draft of a pipeline the project has — one being made can hand work
   * nowhere — whose Check hands its rejections to a step of another of
   * the project's pipelines; and the pipeline it changes, which the turn
   * has to have read.
   */
  function handingOff() {
    const live = createPipeline(handle.db, { projectId, name: "Live hotfix" });
    replacePipelineGraph(handle.db, live.id, [{ id: "lh_start", pipelineId: live.id as Uuid, position: 0, name: "Start", type: "user", isTerminal: true }], [], { entryStepId: "lh_start" });
    const ops = createPipeline(handle.db, { projectId, name: "Ops" });
    replacePipelineGraph(handle.db, ops.id, [{ id: "ops_take", pipelineId: ops.id as Uuid, position: 0, name: "Take", type: "user", isTerminal: true }], [], { entryStepId: "ops_take" });
    const draft = { ...hotfixDraft(), target: { pipelineId: live.id }, removes: ["lh_start"] };
    draft.routes = draft.routes.map((route) => (route.resultKey === "reject" ? { ...route, target: "ops_take" } : route));
    return { draft, read: live.id };
  }
  const HAND_OFF = 'Nothing was made to test: "Check" hands work to a step of another pipeline, and a trial item following that route would land on live work.';

  /** Every row a made trial writes, counted. */
  function rows() {
    return {
      pipelines: handle.db.select().from(pipelines).all().length,
      grants: handle.db.select().from(moduleTrialGrants).all().length,
      modules: handle.db.select().from(modules).all().length,
      items: handle.db.select().from(items).all().length,
      rounds: handle.db.select().from(trialRounds).all().length,
    };
  }

  /** The assistant's turn, answered by each of `replies` in order, through the supervisor; what it was sent back with. */
  async function assistantTurn(replies: unknown[], readPipeline?: string): Promise<string[]> {
    let index = 0;
    const sentBack: string[] = [];
    async function* answer(): AsyncIterable<AgentEvent> {
      const data = replies[Math.min(index, replies.length - 1)];
      index += 1;
      yield { type: "result", data };
    }
    const provider = {
      async *start(): AsyncIterable<AgentEvent> {
        yield { type: "thread_started", threadId: "t1" };
        if (readPipeline !== undefined) {
          yield { type: "tool_call", name: PIPELINE_READ, args: { pipelineId: readPipeline }, callId: "call-0" };
          yield { type: "tool_result", name: PIPELINE_READ, callId: "call-0", ok: true, output: "", truncated: false };
        }
        yield* answer();
      },
      async *resume(_threadId: string, message: string): AsyncIterable<AgentEvent> {
        sentBack.push(message);
        yield* answer();
      },
    };
    await createRunSupervisor({
      db: handle.db,
      provider,
      limits: { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 },
      onRunSucceeded: (item: Item, agent: Agent, action: string, parsedResult: unknown, runId: Uuid): void => {
        if (action !== ASSIST_ACTION) return;
        const posted = postAssistReply(handle.db, item, agent.id, runId, parsedResult);
        continueTrialLoop(handle.db, item, posted.draftCardIds ?? []);
      },
    }).runOnce();
    return sentBack;
  }

  const draftCards = (chat: Item) => listCommentsForItem(handle.db, chat.id).filter((comment) => comment.authorType === "agent" && comment.kind === PROPOSAL_KIND);

  it("sends a draft trial creation would refuse back to the assistant with Approve design's sentence, posting no card", async () => {
    const chat = await conversation();
    const { draft, read: target } = handingOff();
    const before = rows();

    const sentBack = await assistantTurn(
      [
        { message: "Here is the design.", draft, trial: hotfixPlan() },
        { message: "Here it is, ending in Dropped.", draft: hotfixDraft(), trial: hotfixPlan() },
      ],
      target,
    );

    const correction = sentBack.find((message) => message.includes("This draft's trial could not be made"));
    expect(correction).toContain(HAND_OFF);
    expect(correction).toContain("Nothing was posted from this reply.");
    // The corrected reply is the one posted: a single card, whose trial could be made.
    const cards = draftCards(chat);
    expect(cards).toHaveLength(1);
    expect(listCommentsForItem(handle.db, chat.id).some((comment) => comment.body.includes("Here is the design."))).toBe(false);
    expect(read(chat, cards[0]!.id as Uuid).trial?.problem).toBeNull();
    expect(rows()).toEqual(before);

    // And it is the sentence Approve design answers the same draft with, posted.
    const posted = turn(chat, { message: "Again.", draft, trial: hotfixPlan() }, target)!;
    expect(await approve(chat, posted)).toMatchObject({ approved: false, problem: HAND_OFF });
  });

  it("sends back a design whose first round a guardrail would refuse", async () => {
    setSetting(handle.db, GUARDS_KEY, { trialRoundsPerDraft: 0 });
    const chat = await conversation();
    const before = rows();

    const sentBack = await assistantTurn([{ message: "Here is the design.", draft: hotfixDraft(), trial: hotfixPlan() }, { message: "Testing is switched off here, so I will not plan a trial." }]);

    const correction = sentBack.find((message) => message.includes("This draft's trial could not be made"));
    expect(correction).toContain("No round was started: 0 rounds have run, which is as many as one draft is allowed (0).");
    expect(draftCards(chat)).toEqual([]);
    expect(rows()).toEqual(before);
  });

  it("leaves no row behind and tells no engine, when the trial could be made", async () => {
    // A module live work runs, so the trial forks a copy of it.
    approveModule(handle.db, deployModuleId);
    liveOn(deployModuleId, "live");
    stopLoop();
    let notified = 0;
    stopLoop = installTrialLoop(handle.db, { engine: { notifyStateChange: () => (notified += 1) } as never, attachmentStorage: attachments });
    const chat = await conversation();
    const agent = assistAgent(handle.db)!;
    const run = createRun(handle.db, { itemId: chat.id, agentId: agent.id, action: ASSIST_ACTION });
    const commentsBefore = listCommentsForItem(handle.db, chat.id).length;
    const before = rows();

    expect(proposedTrialProblem(handle.db, chat, run.id as Uuid, { message: "Here is the design.", draft: hotfixDraft(), trial: hotfixPlan() })).toBeNull();

    expect(rows()).toEqual(before);
    expect(listCommentsForItem(handle.db, chat.id)).toHaveLength(commentsBefore);
    expect(notified).toBe(0);
    // It did make them: a press now forks the module and files both test items.
    const card = turn(chat, { message: "Here is the design.", draft: hotfixDraft(), trial: hotfixPlan() })!;
    const answer = await approve(chat, card);
    expect(answer).toMatchObject({ approved: true, round: 1 });
    expect(rows()).toMatchObject({ pipelines: before.pipelines + 1, modules: before.modules + 1, rounds: before.rounds + 1 });
  });

  it("tells nobody of what it took back: not the engine's comment subscription, the trial loop or the record's queue", async () => {
    // The engine as the app wires it: a comment announces its item to the
    // renderer (`items:changed`), which is what `onDomainChange` hears.
    const domainChange = vi.fn();
    createEngine({ db: handle.db, eoMcpServerPath: "/unused", worktreeRoot: "/unused", onDomainChange: domainChange });
    const chat = await conversation();
    // A design whose entry step is a person's: filing each test item on it
    // wakes the assistant with a comment on the conversation.
    const personFirst = {
      ...hotfixDraft(),
      entryStepId: "check",
      steps: hotfixDraft().steps.filter((entry) => ["check", "done", "dropped"].includes(entry.id)),
      routes: hotfixDraft().routes.filter((route) => route.fromStepId === "check"),
    };
    const personPlan = { items: hotfixPlan().items, steps: [] };
    const card = turn(chat, { message: "Here is the design.", draft: personFirst, trial: personPlan })!;
    const agent = assistAgent(handle.db)!;
    const run = createRun(handle.db, { itemId: chat.id, agentId: agent.id, action: ASSIST_ACTION });
    const heard: string[] = [];
    const stopComments = onCommentPosted(handle.db, (comment) => heard.push(`comment: ${comment.body.split("\n")[0]}`));
    const stopMoves = onTransitionApplied(handle.db, (move) => heard.push(`move: ${move.itemId}`));
    // Past the window the engine folds an item's announcements into, so
    // none from posting the card is still to come, and one now would be.
    const windowCloses = () => new Promise((resolve) => setTimeout(resolve, CHANGE_PUSH_WINDOW_MS * 2));
    await windowCloses();
    domainChange.mockClear();

    // A trial that could be made, its items filed on a person's step.
    expect(proposedTrialProblem(handle.db, chat, run.id as Uuid, { message: "Here is the design.", draft: personFirst, trial: personPlan })).toBeNull();
    expect(read(chat, card).trial?.problem).toBeNull();
    // A first round a guardrail stops, which posts its stop on the conversation.
    setSetting(handle.db, GUARDS_KEY, { trialRoundsPerDraft: 0 });
    expect(proposedTrialProblem(handle.db, chat, run.id as Uuid, { message: "Here is the design.", draft: hotfixDraft(), trial: hotfixPlan() })).toContain("No round was started");
    expect(read(chat, card).trial?.problem).toContain("No round was started");

    await windowCloses();
    expect(heard).toEqual([]);
    expect(domainChange).not.toHaveBeenCalled();

    // The listeners were listening: Approve design, pressed, is heard.
    setSetting(handle.db, GUARDS_KEY, {});
    expect(await approve(chat, card)).toMatchObject({ approved: true });
    expect(heard.length).toBeGreaterThan(0);
    expect(domainChange).toHaveBeenCalled();
    stopComments();
    stopMoves();
  });

  it("holds Approve design on a card read after its project lost its last workspace, saying why, as a press would", async () => {
    const chat = await conversation();
    const card = turn(chat, { message: "Here is the design.", draft: hotfixDraft(), trial: hotfixPlan() })!;
    expect(read(chat, card).trial?.problem).toBeNull();

    handle.db.update(workspaces).set({ projectId: null }).where(eq(workspaces.projectId, projectId)).run();
    const before = rows();

    const shown = read(chat, card);
    const NO_WORKSPACE = "Nothing was made to test: a trial's test items work on one of the project's workspaces, and it has none attached. Attach a repository or a folder first.";
    expect(shown.problem).toBeNull();
    expect(shown.trial?.problem).toBe(NO_WORKSPACE);
    expect(rows()).toEqual(before);
    // The press still refuses on its own, in the same words.
    expect(await approve(chat, card)).toMatchObject({ approved: false, problem: NO_WORKSPACE });
  });
});
