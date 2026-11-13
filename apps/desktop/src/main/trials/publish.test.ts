import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_MCP_SERVER_NAME, AssistOutputSchema, SCRATCH_KIND, pageDescriptorFor, type Item, type ModuleManifest, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import {
  addModuleTests,
  approveModule,
  appendRunEvent,
  boundGraphForItem,
  createPipeline,
  createProject,
  createRun,
  createWorkspace,
  currentVersion,
  getItem,
  getModule,
  getTrialPipeline,
  listCommentsForItem,
  listModuleTests,
  getPipeline,
  listPipelines,
  listStepsForPipeline,
  listTrialItemIds,
  moduleTestFingerprint,
  openTrialStop,
  postComment,
  readTrialDesign,
  saveModule,
  transitionItem,
  updateRun,
  listModuleVersions,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { publishTrialCommand, readAssistCardCommand, sendToAssist } from "../ipc/assistCommands.js";
import { readGuards, savePipeline, writeGuards } from "../ipc/configCommands.js";
import { clearPublishedView } from "../ipc/currentView.js";
import { clearHandlerRegistry } from "../ipc/registry.js";
import type { ModuleTestRunAnswer } from "../modules/moduleTestRunner.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { approveTrialDesign, continueTrialLoop } from "./design.js";
import { answerTrialStop, installTrialLoop } from "./loop.js";
import { withOnYourBehalfNote } from "./onBehalf.js";
import { pipelines } from "../db/schema.js";
import { readTrialPublish } from "./publishCard.js";

/**
 * The publish card after trials (EO-588): what the trials proved, read by
 * EO from the trial, and one press that approves every module and
 * publishes the pipeline in one transaction, then discards the trial.
 *
 * In-memory databases throughout. Assistant turns are posted the way the
 * supervisor posts them, and handed to the loop as the developer pack's
 * wiring hands them; test items are moved with `transitionItem`, as a
 * run's result or a press would move them, and the loop's listeners
 * record where each ended.
 */
let handle: DbHandle;
let scratch: string;
let attachments: AttachmentStorage;
let stopLoop: () => void;
let deployModuleId: Uuid;
let projectId: Uuid;

const PIPELINE_READ = `mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_get`;

const DEPLOY_MANIFEST: ModuleManifest = {
  name: "Deploy",
  description: "Deploys the build.",
  inputs: {},
  needs: { bin: [], env: ["DEPLOY_TOKEN"], network: false, item: false, comment: false, attach: false, create: false },
  results: ["deployed"],
  sideEffects: true,
};

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-trial-publish-"));
  const project = createProject(handle.db, { name: "Home", keyPrefix: "HOM" });
  projectId = project.id as Uuid;
  createWorkspace(handle.db, { kind: SCRATCH_KIND, projectId });
  attachments = new AttachmentStorage(join(scratch, "attachments"));
  stopLoop = installTrialLoop(handle.db, { attachmentStorage: attachments, worktreeRoot: join(scratch, "worktrees") });
  deployModuleId = module("deploy", "Deploy", DEPLOY_MANIFEST, false);
});

afterEach(() => {
  stopLoop();
  clearHandlerRegistry();
  clearPublishedView();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** A module with one test case. */
function module(slug: string, name: string, manifest: ModuleManifest, approve: boolean, code = `export default async function run() { return { ok: true, result: "${manifest.results[0]}" }; }`): Uuid {
  const saved = saveModule(handle.db, { slug, name, description: manifest.description, code, manifest, source: "architect" });
  if (!saved.ok) throw new Error(saved.reason);
  addModuleTests(handle.db, saved.module.id, [{ description: "it works", source: "export default async () => {}" }]);
  // Approved after its case is added: a change to the cases withdraws an approval.
  if (approve) approveModule(handle.db, saved.module.id);
  return saved.module.id as Uuid;
}

/** Saves new code, and optionally a new manifest, onto a module. */
function edit(moduleId: string, code: string, manifest?: ModuleManifest): void {
  const was = getModule(handle.db, moduleId)!;
  const saved = saveModule(handle.db, { id: was.id, slug: was.slug, name: was.name, description: was.description, code, manifest: manifest ?? was.manifest });
  if (!saved.ok) throw new Error(saved.reason);
}

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

/** Fix (an agent), Deploy (a module nobody has approved), a person's Check, then Done — or Dropped on a rejection. */
function hotfixDraft(fixSays = "Fix what the item says.") {
  return {
    rationale: "Fix it, deploy it, then a person checks it.",
    entryStepId: "hf_fix",
    target: { newPipeline: "Hotfix" },
    steps: [
      step("hf_fix", 0, "Fix", { type: "agent", ownerRole: "implementer", entryAction: "implement", instructionsSummary: fixSays }),
      step("hf_deploy", 1, "Deploy", { type: "module", entryAction: deployModuleId }),
      step("hf_check", 2, "Check"),
      step("hf_done", 3, "Done", { isTerminal: true }),
      step("hf_dropped", 4, "Dropped", { isTerminal: true }),
    ],
    routes: [
      { fromStepId: "hf_fix", resultKey: "done", label: "Done", tone: "success", target: "hf_deploy", position: 0 },
      { fromStepId: "hf_deploy", resultKey: "deployed", label: "Deployed", tone: "success", target: "hf_check", position: 0 },
      { fromStepId: "hf_check", resultKey: "approve", label: "Approve", tone: "success", target: "hf_done", position: 0 },
      { fromStepId: "hf_check", resultKey: "reject", label: "Reject", tone: "danger", target: "hf_dropped", position: 1 },
    ],
  };
}

/** A case that should pass, a case the person must reject; Fix real, Deploy mocked. */
const HOTFIX_PLAN = {
  items: [
    { key: "login", title: "Fix the login", expected: { stepId: "hf_done", criteria: "the login works again" } },
    { key: "drop", title: "Drop the users table", expected: { stepId: "hf_dropped" } },
  ],
  steps: [
    { stepId: "hf_fix", mode: "real", reason: "It works on a branch of its own." },
    {
      stepId: "hf_deploy",
      mode: "mocked",
      reason: "It deploys to production, which sends outside EO.",
      mocks: [
        { item: "login", resultKey: "deployed", output: "Deployed." },
        { item: "drop", resultKey: "deployed", output: "Deployed." },
      ],
    },
  ],
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

/** The assistant asking for the publish card. */
const askToPublish = (chat: Item) => turn(chat, { message: "Every test item ended where it was expected to.", card: { kind: "trialPublish" } });

async function approve(chat: Item, card: Uuid): Promise<string> {
  const answer = await approveTrialDesign(handle.db, { attachmentStorage: attachments }, { conversationId: chat.id, messageId: card });
  if (!answer.approved) throw new Error(answer.problem ?? "not approved");
  return answer.trialPipelineId!;
}

/** A module test runner, scripted per module slug. */
function runner(failing: Record<string, string> = {}) {
  const ran: string[] = [];
  return {
    ran,
    run: async (moduleId: string): Promise<ModuleTestRunAnswer> => {
      const found = getModule(handle.db, moduleId)!;
      ran.push(found.slug);
      const fails = Object.entries(failing).find(([slug]) => found.slug.startsWith(slug))?.[1];
      return {
        fingerprint: moduleTestFingerprint(found, listModuleTests(handle.db, moduleId)),
        problem: null,
        run: {
          ranAt: Date.now(),
          cases: [{ testId: "t0", description: "it works", passed: fails === undefined, failure: fails ?? null, durationMs: 1, output: "" }],
          coverage: { lines: { covered: 100, total: 100, percent: 100 }, branches: { covered: 1, total: 1, percent: 100 } },
        },
      };
    },
  };
}

const doors = {
  dispatch: async () => {
    throw new Error("the publish card is read without dispatching anything");
  },
  readAttachment: async () => null,
};

async function cardOf(chat: Item, messageId: Uuid) {
  const read = await readAssistCardCommand(handle.db, doors, { conversationId: chat.id, messageId });
  if (read.card?.kind !== "trialPublish") throw new Error(read.problem ?? "not a publish card");
  return read.card;
}

const publish = (chat: Item, messageId: Uuid, tests: Pick<ReturnType<typeof runner>, "run"> = runner()) =>
  publishTrialCommand(handle.db, undefined, tests, { attachmentStorage: attachments, worktreeRoot: join(scratch, "worktrees") }, { conversationId: chat.id, messageId, acknowledgeLowCoverage: [] });

/** Moves a trial item as a run's result would, or as the assistant pressing a person's step in their place. */
function mover(trialId: string) {
  const design = readTrialDesign(handle.db, trialId)!;
  const agent = assistAgent(handle.db)!;
  return {
    design,
    to: (item: Item, stepId: string) =>
      transitionItem(handle.db, { itemId: item.id, toStepId: design.stepIds[stepId]!, toPipelineId: trialId as Uuid, actor: "engine", reason: "run succeeded", runId: null }),
    press: (item: Item, stepId: string, label: string) =>
      transitionItem(handle.db, { itemId: item.id, toStepId: design.stepIds[stepId]!, toPipelineId: trialId as Uuid, actor: agent.id, reason: `decided "${label}" on the person's behalf`, runId: null }),
  };
}

/** A Hotfix design approved and its first round run: both test items end where expected, one question answered and both presses made in the person's place. */
async function testedHotfix(draftSays: Record<string, unknown> = {}) {
  const chat = await conversationOn("/settings");
  const card = turn(chat, { message: "Here is the design.", draft: { ...hotfixDraft(), ...draftSays }, trial: HOTFIX_PLAN });
  const trialId = await approve(chat, card);
  const { design, to, press } = mover(trialId);
  const [login, drop] = listTrialItemIds(handle.db, trialId).map((id) => getItem(handle.db, id)!) as [Item, Item];

  // Fix asks the person a question on "Fix the login"; the assistant answers it in their place.
  const agent = assistAgent(handle.db)!;
  const fixRun = createRun(handle.db, { itemId: login.id, agentId: agent.id, action: "implement", stepId: design.stepIds.hf_fix! });
  const asked = postComment(handle.db, { itemId: login.id, runId: fixRun.id, author: { type: "agent", agentId: agent.id }, kind: "question", body: "Which database should the fix use?", parseBodyMentions: false });
  postComment(handle.db, { itemId: login.id, parentId: asked.id, author: { type: "agent", agentId: agent.id }, body: withOnYourBehalfNote("The staging database.", "answered"), parseBodyMentions: false });
  // With its answer, Fix did its work.
  updateRun(handle.db, fixRun.id, { status: "succeeded" });

  to(login, "hf_deploy");
  to(login, "hf_check");
  press(login, "hf_done", "Approve");
  to(drop, "hf_deploy");
  to(drop, "hf_check");
  press(drop, "hf_dropped", "Reject");
  return { chat, trialId, login, drop };
}

/**
 * Release as it is published — Notify (an approved module live work runs),
 * then Done — with a live item on it, and a design approved that adds a
 * person's Check, with Notify redirected: the trial runs a copy of Notify.
 */
async function releaseOnTrial() {
  const NOTIFY: ModuleManifest = {
    name: "Notify",
    description: "Posts to Slack.",
    inputs: {},
    needs: { bin: [], env: ["SLACK_TOKEN", "SLACK_CHANNEL"], network: true, item: false, comment: false, attach: false, create: false },
    results: ["sent"],
    sideEffects: true,
  };
  const originalId = module("notify", "Notify", NOTIFY, true);
  const originalBefore = getModule(handle.db, originalId)!;
  const target = createPipeline(handle.db, { projectId, name: "Release" });
  const liveGraph = {
    steps: [
      { ...step("rel_notify", 0, "Notify", { type: "module", entryAction: originalId }), pipelineId: target.id, results: [], timeoutMs: null, workspaceId: null },
      { ...step("rel_done", 1, "Done", { isTerminal: true }), pipelineId: target.id, results: [], timeoutMs: null, workspaceId: null },
    ],
    routes: [{ id: "r1", pipelineId: target.id, fromStepId: "rel_notify", resultKey: "sent", label: "Sent", tone: "success", target: "rel_done", position: 0 }],
  };
  const first = savePipeline(handle.db, undefined, { pipelineId: target.id, steps: liveGraph.steps as never, routes: liveGraph.routes as never, entryStepId: "rel_notify" });
  expect(first.problems.filter((problem) => problem.severity === "error")).toEqual([]);
  const live = createTestItem(handle.db, { type: "story", title: "Live release", projectId, pipelineId: target.id, stepId: "rel_notify" });
  const liveVersion = getItem(handle.db, live.id)!.pipelineVersionId;
  expect(liveVersion).not.toBeNull();

  // The change: a person checks before it is done. Notify is redirected to a scratch channel.
  const chat = await conversationOn(`/pipelines/${target.id}`);
  const draft = {
    rationale: "A person checks the release first.",
    entryStepId: "rel_notify",
    target: { pipelineId: target.id },
    steps: [step("rel_notify", 0, "Notify", { type: "module", entryAction: originalId }), step("rel_check", 1, "Check"), step("rel_done", 2, "Done", { isTerminal: true })],
    routes: [
      { fromStepId: "rel_notify", resultKey: "sent", label: "Sent", tone: "success", target: "rel_check", position: 0 },
      { fromStepId: "rel_check", resultKey: "approve", label: "Approve", tone: "success", target: "rel_done", position: 0 },
    ],
  };
  const plan = {
    items: [{ key: "ship", title: "Ship 1.2", expected: { stepId: "rel_done" } }],
    steps: [{ stepId: "rel_notify", mode: "redirected", reason: "It posts to #releases, so it is pointed at a scratch channel." }],
  };
  const trialId = await approve(chat, turn(chat, { message: "Here is the design.", draft, trial: plan }, target.id));
  const { design, to, press } = mover(trialId);
  const copyId = design.moduleIds[originalId]!;
  expect(copyId).not.toBe(originalId);

  return { NOTIFY, originalId, originalBefore, target, liveGraph, live, liveVersion, chat, draft, trialId, design, to, press, copyId };
}

describe("the publish card", () => {
  it("shows what was tested, mocked and reached, how each test item ended, and what the assistant answered in the person's place", async () => {
    const { chat, login, drop } = await testedHotfix();
    const card = await cardOf(chat, askToPublish(chat));

    expect(card).toMatchObject({ pipelineName: "Hotfix", targetPipelineId: null, round: 1, changes: [], publishAnyway: false, problem: null });
    // A mocked step is never called tested, though both items went through it.
    expect(card.stepOutcomes.map((entry) => [entry.name, entry.outcome])).toEqual([
      ["Fix", "tested"],
      ["Deploy", "mocked"],
      ["Check", "tested"],
      ["Done", "tested"],
      ["Dropped", "tested"],
    ]);
    expect(card.stepOutcomes.find((entry) => entry.name === "Deploy")?.reason).toBe("It deploys to production, which sends outside EO.");
    expect(card.items).toEqual([
      { itemKey: login.key, title: "Fix the login", expectedStepName: "Done", criteria: "the login works again", endedStepName: "Done", result: "approve", verdict: "passed" },
      { itemKey: drop.key, title: "Drop the users table", expectedStepName: "Dropped", criteria: null, endedStepName: "Dropped", result: "reject", verdict: "passed" },
    ]);
    expect(card.onBehalf).toEqual([
      { kind: "answered", itemKey: login.key, stepName: "Fix", asked: "Which database should the fix use?", answer: "The staging database.", choices: [] },
      { kind: "pressed", itemKey: login.key, stepName: "Check", asked: null, answer: "Approve", choices: ["Approve", "Reject"] },
      { kind: "pressed", itemKey: drop.key, stepName: "Check", asked: null, answer: "Reject", choices: ["Approve", "Reject"] },
    ]);
    expect(card.modules).toEqual([{ id: deployModuleId, slug: "deploy", name: "Deploy", codeChanged: false, needsChanged: false, replaces: null }]);
    expect(card.steps.map((entry) => entry.id)).toEqual(["hf_fix", "hf_deploy", "hf_check", "hf_done", "hf_dropped"]);
  });

  it("is not offered while a test item has not ended where it was expected to", async () => {
    const chat = await conversationOn("/settings");
    const trialId = await approve(chat, turn(chat, { message: "Here is the design.", draft: hotfixDraft(), trial: HOTFIX_PLAN }));
    const { to } = mover(trialId);
    const [login] = listTrialItemIds(handle.db, trialId).map((id) => getItem(handle.db, id)!) as [Item, Item];
    to(login, "hf_dropped");

    const refused = askToPublish(chat);
    const comment = listCommentsForItem(handle.db, chat.id).find((entry) => entry.id === refused)!;
    expect(comment.kind).toBe("rejection");
    expect(comment.body).toContain("No card was offered: Not every test item of round 1 has ended where it was expected to");
  });
});

describe("what the publish card says changed since the design was approved", () => {
  /** What the card would say changed, read whether or not it can be pressed yet. */
  const changesOn = (chat: Item): string[] => {
    const read = readTrialPublish(handle.db, chat);
    if (!read.ok) throw new Error(read.problem);
    return read.view.changes;
  };

  it("names a setting a revision inherited from the target after approval, which no draft wrote", async () => {
    const { chat, target, liveGraph, draft, trialId } = await releaseOnTrial();
    expect(changesOn(chat)).toEqual([]);

    // The live pipeline gains a time limit on Notify after the design was approved…
    const edited = liveGraph.steps.map((entry) => (entry.id === "rel_notify" ? { ...entry, timeoutMs: 60_000 } : entry));
    expect(savePipeline(handle.db, undefined, { pipelineId: target.id, steps: edited as never, routes: liveGraph.routes as never, entryStepId: "rel_notify" }).saved).toBe(true);
    // …and the loop applies a revision that only rewords Check, leaving Notify's time limit unsaid.
    turn(chat, { message: "A clearer check.", draft: { ...draft, steps: draft.steps.map((entry) => (entry.id === "rel_check" ? { ...entry, instructionsSummary: "Read the release notes first." } : entry)) } }, target.id);
    expect(readTrialDesign(handle.db, trialId)!.applied).not.toBeNull();

    const changes = changesOn(chat);
    expect(changes).toContain('the instructions of "Check"');
    expect(changes).toContain('the time limit of "Notify": none → 60000');
    // And what is published is what the card says: the graph the trial runs now.
    const read = readTrialPublish(handle.db, chat);
    expect(read.ok && read.graph.steps.find((entry) => entry.id === "rel_notify")?.timeoutMs).toBe(60_000);
  });

  it("names a step that moved, though moving one asks the person nothing", async () => {
    const chat = await conversationOn("/settings");
    await approve(chat, turn(chat, { message: "Here is the design.", draft: hotfixDraft(), trial: HOTFIX_PLAN }));
    const moved = hotfixDraft();
    turn(chat, {
      message: "Dropped before Done.",
      draft: { ...moved, steps: moved.steps.map((entry) => (entry.id === "hf_done" ? { ...entry, position: 4 } : entry.id === "hf_dropped" ? { ...entry, position: 3 } : entry)) },
    });

    expect(changesOn(chat)).toEqual(['"Dropped" moves from position 4 to 3', '"Done" moves from position 3 to 4']);
  });
});

describe("publishing a tested draft", () => {
  it("approves every module and publishes the new pipeline in one press, then discards the trial", async () => {
    const { chat, trialId, login } = await testedHotfix();
    const cardId = askToPublish(chat);
    const tests = runner();

    const answer = await publish(chat, cardId, tests);

    expect(answer).toMatchObject({ saved: true, created: true, problem: null });
    expect(tests.ran).toEqual(["deploy"]);
    const published = listPipelines(handle.db, projectId).find((pipeline) => pipeline.name === "Hotfix")!;
    expect(answer.pipelineId).toBe(published.id);
    expect(listStepsForPipeline(handle.db, published.id).map((entry) => [entry.id, entry.entryAction])).toEqual([
      ["hf_fix", "implement"],
      ["hf_deploy", deployModuleId],
      ["hf_check", null],
      ["hf_done", null],
      ["hf_dropped", null],
    ]);
    expect(currentVersion(handle.db, published.id)).toBeDefined();
    expect(getModule(handle.db, deployModuleId)?.approvedAt).not.toBeNull();

    // The trial and its items are gone, through the item-delete path.
    expect(getTrialPipeline(handle.db, trialId)).toBeUndefined();
    expect(getItem(handle.db, login.id)).toBeUndefined();
    expect(listTrialItemIds(handle.db, trialId)).toEqual([]);

    // What came of it is under the card, which cannot be pressed again.
    const filed = listCommentsForItem(handle.db, chat.id).find((comment) => comment.parentId === cardId)!;
    expect(filed.kind).toBe("approval");
    expect(filed.body).toContain("**Published Hotfix** as a new pipeline");
    expect(filed.body).toContain('Approved for live work: "Deploy".');
    expect(filed.body).toContain("The trial and its 2 test items have been deleted.");
    expect(await publish(chat, cardId)).toMatchObject({ saved: false, problem: "That card has already been pressed." });
  });

  it("publishes the entry rules the approved draft says (EO-610)", async () => {
    const { chat } = await testedHotfix({ entryRules: [{ kind: "description" }] });

    const answer = await publish(chat, askToPublish(chat));

    expect(answer).toMatchObject({ saved: true, problem: null });
    expect(getPipeline(handle.db, answer.pipelineId!)?.entryRules).toEqual([{ kind: "description" }]);
  });

  it("leaves the target's entry rules alone when the draft said nothing of them, those set since the trial was made among them (EO-610)", async () => {
    const { target, chat, trialId, design, to, press, copyId } = await releaseOnTrial();
    const rules = [{ kind: "description" }];
    handle.db.update(pipelines).set({ entryRules: rules }).where(eq(pipelines.id, target.id)).run();

    const [ship] = listTrialItemIds(handle.db, trialId).map((id) => getItem(handle.db, id)!) as [Item];
    createRun(handle.db, { itemId: ship.id, agentId: null, action: copyId, stepId: design.stepIds.rel_notify!, status: "succeeded", provider: "module" });
    to(ship, "rel_check");
    press(ship, "rel_done", "Approve");

    expect(await publish(chat, askToPublish(chat))).toMatchObject({ saved: true, created: false, pipelineId: target.id, problem: null });
    expect(getPipeline(handle.db, target.id)?.entryRules).toEqual(rules);
  });

  it("publishes nothing and approves nothing when a module's test fails, naming the case", async () => {
    const { chat, trialId } = await testedHotfix();
    const cardId = askToPublish(chat);

    const answer = await publish(chat, cardId, runner({ deploy: "expected deployed, got failed" }));

    expect(answer.saved).toBe(false);
    expect(answer.problem).toContain("Nothing was approved and nothing was published.");
    expect(answer.problem).toContain("it works: expected deployed, got failed");
    expect(answer.modules).toEqual([expect.objectContaining({ slug: "deploy", outcome: "refused" })]);
    expect(listPipelines(handle.db, projectId).some((pipeline) => pipeline.name === "Hotfix")).toBe(false);
    expect(getModule(handle.db, deployModuleId)?.approvedAt).toBeNull();
    // The trial is still there, and the card is still to press.
    expect(getTrialPipeline(handle.db, trialId)).toBeDefined();
    expect(listCommentsForItem(handle.db, chat.id).some((comment) => comment.parentId === cardId)).toBe(false);
    expect(await publish(chat, cardId)).toMatchObject({ saved: true, created: true });
  });

  it("puts each draft copy in the place of the live module it forked, as a new version, and live items keep the version they entered on", async () => {
    const { NOTIFY, originalId, originalBefore, target, liveGraph, live, liveVersion, chat, trialId, design, to, press, copyId } = await releaseOnTrial();

    // Somebody edits the live pipeline after the trial was made: a time
    // limit on Notify that no test item ran with.
    const edited = liveGraph.steps.map((entry) => (entry.id === "rel_notify" ? { ...entry, timeoutMs: 60_000 } : entry));
    expect(savePipeline(handle.db, undefined, { pipelineId: target.id, steps: edited as never, routes: liveGraph.routes as never, entryStepId: "rel_notify" }).saved).toBe(true);
    const versionBefore = currentVersion(handle.db, target.id)!.number;

    // The loop fixes the copy's code, within its grant.
    edit(copyId, 'export default async function run() { return { ok: true, result: "sent", detail: "fixed" }; }');
    const [ship] = listTrialItemIds(handle.db, trialId).map((id) => getItem(handle.db, id)!) as [Item];
    createRun(handle.db, { itemId: ship.id, agentId: null, action: copyId, stepId: design.stepIds.rel_notify!, status: "succeeded", provider: "module" });
    to(ship, "rel_check");
    press(ship, "rel_done", "Approve");

    const cardId = askToPublish(chat);
    const shown = await cardOf(chat, cardId);
    expect(shown.modules).toEqual([{ id: copyId, slug: getModule(handle.db, copyId)!.slug, name: "Notify (trial)", codeChanged: true, needsChanged: false, replaces: { id: originalId, name: "Notify" } }]);
    expect(shown.stepOutcomes.map((entry) => [entry.name, entry.outcome])).toEqual([
      ["Notify", "redirected"],
      ["Check", "tested"],
      ["Done", "tested"],
    ]);

    // Asking for less is within the grant, and still a change to what the person granted: marked apart.
    edit(copyId, getModule(handle.db, copyId)!.code, { ...NOTIFY, needs: { ...NOTIFY.needs, env: ["SLACK_TOKEN"] } });
    expect((await cardOf(chat, cardId)).modules[0]).toMatchObject({ codeChanged: true, needsChanged: true });

    const answer = await publish(chat, cardId);
    expect(answer).toMatchObject({ saved: true, created: false, pipelineId: target.id, problem: null });

    // The published pipeline runs the tested copy, under the original's name, approved.
    expect(listStepsForPipeline(handle.db, target.id).map((entry) => [entry.id, entry.entryAction])).toEqual([
      ["rel_notify", copyId],
      ["rel_check", null],
      ["rel_done", null],
    ]);
    expect(currentVersion(handle.db, target.id)?.number).toBe(versionBefore + 1);
    // As it was tested, not as the pipeline was edited since.
    expect(listStepsForPipeline(handle.db, target.id).find((entry) => entry.id === "rel_notify")?.timeoutMs).toBeNull();
    expect(getModule(handle.db, copyId)).toMatchObject({ name: "Notify", archivedAt: null });
    expect(getModule(handle.db, copyId)?.approvedAt).not.toBeNull();
    // Pinned to the version approving the copy just recorded (EO-770) —
    // the code the trial ran, after the loop's edits — not the one the
    // trial's graph was first saved with.
    const [approvedCopy] = listModuleVersions(handle.db, copyId);
    expect(approvedCopy).toMatchObject({ current: true, approved: true });
    expect(approvedCopy!.number).toBeGreaterThan(1);
    expect(listStepsForPipeline(handle.db, target.id).find((entry) => entry.id === "rel_notify")?.moduleVersion).toBe(approvedCopy!.number);
    // The original is untouched, and the live item still runs it, on the version it entered on.
    expect(getModule(handle.db, originalId)).toEqual(originalBefore);
    expect(getItem(handle.db, live.id)!.pipelineVersionId).toBe(liveVersion);
    expect(boundGraphForItem(handle.db, getItem(handle.db, live.id)!)?.steps.find((entry) => entry.id === "rel_notify")?.entryAction).toBe(originalId);
    expect(getTrialPipeline(handle.db, trialId)).toBeUndefined();
    const filed = listCommentsForItem(handle.db, chat.id).find((comment) => comment.parentId === cardId)!;
    expect(filed.body).toContain(`as version ${versionBefore + 1}`);
    expect(filed.body).toContain('The tested copy of "Notify" takes its place on this pipeline; "Notify" itself is unchanged.');
  });

  it("publishes anyway after a guardrail stop, saying first which test items did not end where they were expected to", async () => {
    expect(writeGuards(handle.db, { ...readGuards(handle.db), trialRoundsPerDraft: 1 }).saved).toBe(true);
    const chat = await conversationOn("/settings");
    const trialId = await approve(chat, turn(chat, { message: "Here is the design.", draft: hotfixDraft(), trial: HOTFIX_PLAN }));
    const { to, press } = mover(trialId);
    const [login, drop] = listTrialItemIds(handle.db, trialId).map((id) => getItem(handle.db, id)!) as [Item, Item];
    // Fix parks before its work starts — a credential it lacks — and the item is moved on by hand.
    const parked = createRun(handle.db, { itemId: login.id, agentId: assistAgent(handle.db)!.id, action: "implement", stepId: readTrialDesign(handle.db, trialId)!.stepIds.hf_fix! });
    updateRun(handle.db, parked.id, { status: "awaiting_input" });
    // "Fix the login" is rejected to Dropped, not Done.
    to(login, "hf_check");
    press(login, "hf_dropped", "Reject");
    to(drop, "hf_check");
    press(drop, "hf_dropped", "Reject");

    // A fix within the grant, which the rounds guardrail stops before it is tested.
    turn(chat, { message: "Tightened the fix.", draft: hotfixDraft("Fix what the item says, and only that.") });
    const stop = openTrialStop(handle.db, trialId)!;
    expect(stop).toBeDefined();
    const whileStopped = askToPublish(chat);
    expect(listCommentsForItem(handle.db, chat.id).find((comment) => comment.id === whileStopped)?.body).toContain("Testing has stopped and waits for your answer");

    answerTrialStop(handle.db, {}, { parentId: stop.commentId as Uuid, body: "Publish anyway" });
    const cardId = askToPublish(chat);
    const card = await cardOf(chat, cardId);
    expect(card).toMatchObject({ publishAnyway: true, problem: null, round: 1 });
    // What changed since the approved design: the fix applied to the trial without a card.
    expect(card.changes).toEqual(['the instructions of "Fix"']);
    // Reached by every test item, and never run on one: not called tested.
    expect(card.stepOutcomes.map((entry) => [entry.name, entry.outcome])).toEqual([
      ["Fix", "not_run"],
      ["Deploy", "mocked"],
      ["Check", "tested"],
      ["Done", "not_reached"],
      ["Dropped", "tested"],
    ]);
    expect(card.items.map((item) => [item.itemKey, item.expectedStepName, item.endedStepName, item.verdict])).toEqual([
      [login.key, "Done", "Dropped", "failed"],
      [drop.key, "Dropped", "Dropped", "passed"],
    ]);

    const answer = await publish(chat, cardId);
    expect(answer).toMatchObject({ saved: true, created: true });
    const published = listPipelines(handle.db, projectId).find((pipeline) => pipeline.name === "Hotfix")!;
    expect(listStepsForPipeline(handle.db, published.id).find((entry) => entry.id === "hf_fix")?.instructionsSummary).toBe("Fix what the item says, and only that.");
    const filed = listCommentsForItem(handle.db, chat.id).find((comment) => comment.parentId === cardId)!;
    expect(filed.body).toContain(`Published anyway: ${login.key} "Fix the login" did not end where it was expected to.`);
  });
  it("runs the tests of a module approved before too, and publishes nothing when they fail now", async () => {
    approveModule(handle.db, deployModuleId);
    const { chat, trialId } = await testedHotfix();
    const cardId = askToPublish(chat);
    const tests = runner({ deploy: "the deploy target moved" });

    const answer = await publish(chat, cardId, tests);

    expect(tests.ran).toEqual(["deploy"]);
    expect(answer.saved).toBe(false);
    expect(answer.problem).toContain("it works: the deploy target moved");
    expect(listPipelines(handle.db, projectId).some((pipeline) => pipeline.name === "Hotfix")).toBe(false);
    expect(getTrialPipeline(handle.db, trialId)).toBeDefined();
  });

  it("publishes nothing from a card a newer reply replaced while its tests were running", async () => {
    const { chat, trialId } = await testedHotfix();
    const cardId = askToPublish(chat);
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const passing = runner();
    const slow = {
      run: async (moduleId: string) => {
        started();
        await gate;
        return passing.run(moduleId);
      },
    };

    const pending = publish(chat, cardId, slow);
    await running;
    const newer = askToPublish(chat);
    release();
    const answer = await pending;

    expect(answer.saved).toBe(false);
    expect(answer.problem).toContain("superseded by a newer reply while the tests were running");
    expect(listPipelines(handle.db, projectId).some((pipeline) => pipeline.name === "Hotfix")).toBe(false);
    expect(getModule(handle.db, deployModuleId)?.approvedAt).toBeNull();
    expect(getTrialPipeline(handle.db, trialId)).toBeDefined();
    // The newer card is the one to press.
    expect(await publish(chat, newer)).toMatchObject({ saved: true, created: true });
  });
});
