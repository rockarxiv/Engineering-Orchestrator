import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN_MCP_SERVER_NAME,
  AssistOutputSchema,
  McpServerDraftSchema,
  RecordPipelineSchema,
  SCRATCH_KIND,
  ipcContract,
  isMockedOutput,
  pageDescriptorFor,
  type AgentProvider,
  type AgentProviderStartOptions,
  type AssistOutput,
  type CustomModule,
  type Item,
  type ModuleManifest,
  type Uuid,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  appendRunEvent,
  createPipeline,
  createProject,
  createRun,
  createWorkspace,
  getItem,
  getTrialPipeline,
  listAgents,
  listAwaitingInputItemIds,
  listCommentsForItem,
  listRunsForItem,
  postComment,
  listTransitionsForItem,
  readTrialPlan,
  replacePipelineGraph,
  saveMcpServer,
  saveModule,
  setAgentAttachment,
  updateRun,
} from "../db/repos/index.js";
import { listPipelinesUpdatedSince, readProjectPipelines, upsertReplicaPipeline } from "../db/repos/projectMoveRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { itemTypes, projects } from "../db/schema.js";
import { usePackConnectors } from "../connectors/declared.js";
import { sendToAssist } from "../ipc/assistCommands.js";
import { validatePipelineCommand } from "../ipc/configCommands.js";
import { clearPublishedView } from "../ipc/currentView.js";
import { listPipelineStepViews } from "../ipc/domainQueries.js";
import { clearHandlerRegistry } from "../ipc/registry.js";
import { renderPipeline, renderPipelineProblems } from "../mcpHost/render.js";
import { createModuleRunnerLookup } from "../modules/registry.js";
import { agentRunVariables, readSecret, redirectWithheldVariables, storeSecret, storeVariable, trialScopeOf, type ModuleSecretsOptions } from "../modules/secrets.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { MOCKED_STEP_REASON, createRunSupervisor } from "../supervisor/runSupervisor.js";
import { preparingAt } from "../supervisor/testWorkspaceKinds.js";
import { eq } from "drizzle-orm";
import { saveTrialPlan, stepScopeFor, trialStepMode } from "./stepModes.js";
import { createTrialFromDraft, fileTrialItem } from "./trials.js";

/**
 * Step modes on a trial (EO-584): a trial plan gives every step one of
 * three modes — real, redirected or mocked — and the data the assistant
 * reads says, per step, whether it sends or creates outside EO.
 *
 * Every test is on an in-memory database; the trials are made from draft
 * cards posted the way a turn posts them, as `trials.test.ts` makes them.
 */
let handle: DbHandle;
let scratch: string;
let projectId: Uuid;
let secrets: ModuleSecretsOptions;

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const PIPELINE_READ = `mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_get`;
const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${text}`),
  decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ""),
};
const launcher = { execPath: process.execPath, hostPath: join(dirname(fileURLToPath(import.meta.url)), "../modules/moduleHost.mjs"), hostEnv: { ELECTRON_RUN_AS_NODE: "1" } };

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-step-modes-"));
  projectId = createProject(handle.db, { name: "Home", keyPrefix: "HOM" }).id as Uuid;
  createWorkspace(handle.db, { kind: SCRATCH_KIND, projectId });
  secrets = { directory: join(scratch, "secrets"), store };
  usePackConnectors(new Map());
});

afterEach(() => {
  clearHandlerRegistry();
  clearPublishedView();
  usePackConnectors(new Map());
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

async function conversation(): Promise<Item> {
  const sent = await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/settings"), conversationId: null, body: "test this with real runs", attachmentIds: [], interrupt: false });
  return getItem(handle.db, sent.conversation.id as Uuid)!;
}

/** A succeeded assist turn carrying `draft`; the draft card it posted. */
function draftCard(chat: Item, draft: unknown, readPipeline?: string): Uuid {
  const parsed: AssistOutput = AssistOutputSchema.parse({ message: "Here.", draft });
  const agent = assistAgent(handle.db)!;
  const question = listCommentsForItem(handle.db, chat.id).filter((comment) => comment.authorType === "human").at(-1)!.id;
  const run = createRun(handle.db, { itemId: chat.id, agentId: agent.id, action: ASSIST_ACTION, initiationId: question });
  if (readPipeline !== undefined) {
    appendRunEvent(handle.db, run.id, "tool_call", { name: PIPELINE_READ, args: { pipelineId: readPipeline }, callId: "call-0" });
    appendRunEvent(handle.db, run.id, "tool_result", { name: PIPELINE_READ, callId: "call-0", ok: true, output: "", truncated: false });
  }
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(parsed), parsed } });
  postAssistReply(handle.db, chat, agent.id, run.id, parsed);
  const card = listCommentsForItem(handle.db, chat.id).find((comment) => comment.runId === run.id && comment.kind === PROPOSAL_KIND);
  if (card === undefined) throw new Error(`no draft card: ${listCommentsForItem(handle.db, chat.id).map((comment) => comment.body).join(" | ")}`);
  return card.id;
}

/** A trial of a new pipeline drafted as `draft`. */
async function trialOf(draft: unknown) {
  const chat = await conversation();
  const made = createTrialFromDraft(handle.db, undefined, { conversationId: chat.id, messageId: draftCard(chat, draft) });
  if (!made.ok) throw new Error(made.problem);
  return made;
}

function fileOn(trialPipelineId: string, title = "A test item"): Item {
  const filed = fileTrialItem(handle.db, undefined, { trialPipelineId, type: "story", title });
  if (!filed.ok) throw new Error(filed.problem);
  return filed.item;
}

/** Fix (an agent step), a person's Check, then Done. */
const fixDraft = {
  rationale: "Fix it, then a person checks it.",
  entryStepId: "fix",
  target: { newPipeline: "Hotfix" },
  steps: [step("fix", 0, "Fix", { type: "agent", ownerRole: "implementer", entryAction: "implement" }), step("check", 1, "Check"), step("done", 2, "Done", { isTerminal: true })],
  routes: [
    { fromStepId: "fix", resultKey: "done", label: "Done", tone: "success", target: "check", position: 0 },
    { fromStepId: "check", resultKey: "approve", label: "Approve", tone: "success", target: "done", position: 0 },
  ],
};

/**
 * A deploy module that reports the TOKEN it was given, reversed — a
 * secret's value is redacted from what a module says, and the reversal is
 * what lets a test tell whose value it read.
 */
function deployModule(options: { env?: string[]; approve?: boolean; sideEffects?: boolean } = {}): CustomModule {
  const manifest: ModuleManifest = {
    name: "Deploy",
    description: "Deploys the build.",
    inputs: {},
    needs: { bin: [], env: options.env ?? [], network: false, item: false, comment: false, attach: false, create: false },
    results: ["deployed", "failed"],
    ...(options.sideEffects === undefined ? {} : { sideEffects: options.sideEffects }),
  };
  const saved = saveModule(handle.db, {
    slug: "deploy",
    name: "Deploy",
    description: "Deploys the build.",
    code: `export default async function run(ctx) { return { ok: true, result: "deployed", detail: String(process.env.TOKEN ?? "none").split("").reverse().join("") }; }`,
    manifest,
    source: "architect",
    approve: options.approve ?? true,
  });
  if (!saved.ok) throw new Error(saved.reason);
  return saved.module;
}

/** Deploy (running `moduleId`), then Done, with a failure route back to a person. */
const shipDraft = (moduleId: string) => ({
  rationale: "Deploy, then done.",
  entryStepId: "deploy",
  target: { newPipeline: "Ship" },
  steps: [step("deploy", 0, "Deploy", { type: "module", entryAction: moduleId }), step("check", 1, "Check"), step("done", 2, "Done", { isTerminal: true })],
  routes: [
    { fromStepId: "deploy", resultKey: "deployed", label: "Deployed", tone: "success", target: "done", position: 0 },
    { fromStepId: "deploy", resultKey: "failed", label: "Failed", tone: "danger", target: "check", position: 1 },
    { fromStepId: "check", resultKey: "approve", label: "Approve", tone: "success", target: "done", position: 0 },
  ],
});

function savePlan(trialPipelineId: string, plan: unknown) {
  const saved = saveTrialPlan(handle.db, trialPipelineId, plan);
  if (!saved.ok) throw new Error(saved.problem);
  return saved.plan;
}

const reversed = (text: string): string => text.split("").reverse().join("");

const lookup = () => createModuleRunnerLookup({ db: handle.db, launcher, secrets });

/** What a module step's run comes to on `item`, run directly through the runner a supervisor is given. */
async function runModuleOn(moduleId: string, item: Item) {
  const runner = lookup()(moduleId);
  if (runner === undefined) throw new Error("no runner");
  const work = join(scratch, `work-${item.id}`);
  mkdirSync(work, { recursive: true });
  const row = createRun(handle.db, { itemId: item.id, agentId: null, action: moduleId, status: "running", provider: "module" });
  return runner({ db: handle.db, item, prepareWorkspace: preparingAt(work), report: () => undefined, runId: row.id });
}

/** A provider that refuses to be started — a mocked step must never reach one. */
const noBackend = { start: () => { throw new Error("a mocked step must not start a backend run"); } } as unknown as AgentProvider;

describe("saving a trial plan", () => {
  it("holds a mode per step and, for a mocked step, a result key and output per trial item", async () => {
    const made = await trialOf(fixDraft);
    const item = fileOn(made.trial.id);
    const fix = made.stepIds.fix!;

    savePlan(made.trial.id, { steps: [{ stepId: fix, mode: "mocked", mocks: [{ itemId: item.id, resultKey: "done", output: "Fixed." }] }] });

    expect(readTrialPlan(handle.db, made.trial.id)).toEqual({ steps: [{ stepId: fix, mode: "mocked", mocks: [{ itemId: item.id, resultKey: "done", output: "Fixed." }] }], expected: [] });
    expect(trialStepMode(handle.db, item, fix)).toEqual({ mode: "mocked", stepId: fix, mock: { itemId: item.id, resultKey: "done", output: "Fixed." } });
  });

  it("refuses a result key the step does not declare, writing nothing", async () => {
    const made = await trialOf(fixDraft);
    const item = fileOn(made.trial.id);

    const saved = saveTrialPlan(handle.db, made.trial.id, { steps: [{ stepId: made.stepIds.fix!, mode: "mocked", mocks: [{ itemId: item.id, resultKey: "shipped", output: "" }] }] });

    expect(saved).toEqual({ ok: false, problem: 'The trial plan was not saved: "Fix" does not declare the result "shipped" — it declares "done".' });
    expect(readTrialPlan(handle.db, made.trial.id)).toEqual({ steps: [], expected: [] });
  });

  it("refuses what the trial cannot do: another pipeline's step, a person's step mocked, a result on a step that is not mocked, an item that is not a test item", async () => {
    const made = await trialOf(fixDraft);
    const item = fileOn(made.trial.id);
    const live = createTestItem(handle.db, { type: "story", title: "Live", projectId, stepId: "todo" });
    const problem = (plan: unknown) => {
      const saved = saveTrialPlan(handle.db, made.trial.id, plan);
      return saved.ok ? null : saved.problem;
    };

    expect(problem({ steps: [{ stepId: "todo", mode: "real" }] })).toContain('"todo" is not a step of this trial');
    expect(problem({ steps: [{ stepId: made.stepIds.check!, mode: "mocked" }] })).toContain('"Check" is a person\'s step and runs nothing');
    expect(problem({ steps: [{ stepId: made.stepIds.fix!, mode: "redirected", mocks: [{ itemId: item.id, resultKey: "done", output: "" }] }] })).toContain("only a mocked step names a result");
    expect(problem({ steps: [{ stepId: made.stepIds.fix!, mode: "mocked", mocks: [{ itemId: live.id, resultKey: "done", output: "" }] }] })).toContain("not one of this trial's test items");
    expect(problem({ steps: [{ stepId: made.stepIds.fix!, mode: "sideways" }] })).toContain("The trial plan was not saved");
    expect(saveTrialPlan(handle.db, "default", { steps: [] })).toEqual({ ok: false, problem: "The trial plan was not saved: that pipeline is not a trial." });
  });

  it("holds where each test item must end, and refuses an expected outcome the trial cannot have (EO-586)", async () => {
    const made = await trialOf(fixDraft);
    const item = fileOn(made.trial.id);
    const live = createTestItem(handle.db, { type: "story", title: "Live", projectId, stepId: "todo" });
    const problem = (plan: unknown) => {
      const saved = saveTrialPlan(handle.db, made.trial.id, plan);
      return saved.ok ? null : saved.problem;
    };

    expect(problem({ expected: [{ itemId: live.id, stepId: made.stepIds.done! }] })).toContain("not one of this trial's test items");
    expect(problem({ expected: [{ itemId: item.id, stepId: "todo" }] })).toContain('ends on "todo", which is not a step of this trial');
    expect(problem({ expected: [{ itemId: item.id, stepId: made.stepIds.done! }, { itemId: item.id, stepId: made.stepIds.check! }] })).toContain("two expected outcomes");

    savePlan(made.trial.id, { expected: [{ itemId: item.id, stepId: made.stepIds.done!, criteria: "the fix is merged" }] });
    expect(readTrialPlan(handle.db, made.trial.id)?.expected).toEqual([{ itemId: item.id, stepId: made.stepIds.done!, criteria: "the fix is merged" }]);
  });

  it("travels with its trial to a replica", async () => {
    const made = await trialOf(fixDraft);
    const item = fileOn(made.trial.id);
    const plan = savePlan(made.trial.id, { steps: [{ stepId: made.stepIds.fix!, mode: "mocked", mocks: [{ itemId: item.id, resultKey: "done", output: "Fixed." }] }] });
    expect(readProjectPipelines(handle.db, projectId).find((pipeline) => pipeline.id === made.trial.id)?.trial?.plan).toEqual(plan);

    const replica = openMigratedTestDb();
    try {
      replica.db.insert(projects).values(handle.db.select().from(projects).where(eq(projects.id, projectId)).get()!).run();
      for (const type of handle.db.select().from(itemTypes).where(eq(itemTypes.projectId, projectId)).all()) replica.db.insert(itemTypes).values(type).run();
      const wire = () => listPipelinesUpdatedSince(handle.db, { ts: 0, id: "" }, 100).map((pipeline) => RecordPipelineSchema.parse(JSON.parse(JSON.stringify(pipeline))));
      for (const pipeline of wire()) upsertReplicaPipeline(replica.db, pipeline);
      expect(readTrialPlan(replica.db, made.trial.id)).toEqual(plan);

      // A plan saved between rounds reaches it on the next pull.
      const next = savePlan(made.trial.id, { steps: [{ stepId: made.stepIds.fix!, mode: "real" }] });
      for (const pipeline of wire()) upsertReplicaPipeline(replica.db, pipeline);
      expect(readTrialPlan(replica.db, made.trial.id)).toEqual(next);
      expect(getTrialPipeline(replica.db, made.trial.id)).toEqual(made.trial);
    } finally {
      replica.close();
    }
  });
});

describe("a mocked step on a trial item", () => {
  it("starts no backend run for an agent step, posts its output marked as mocked, and moves the item on the named result", async () => {
    const made = await trialOf(fixDraft);
    const item = fileOn(made.trial.id);
    savePlan(made.trial.id, { steps: [{ stepId: made.stepIds.fix!, mode: "mocked", mocks: [{ itemId: item.id, resultKey: "done", output: "Fixed the null check." }] }] });

    await createRunSupervisor({ db: handle.db, provider: noBackend, limits: LIMITS }).runOnce();

    expect(listRunsForItem(handle.db, item.id)).toEqual([]);
    const output = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "output");
    expect(output && isMockedOutput(output)).toBe(true);
    expect(output?.body).toContain("Fixed the null check.");
    // Through the ordinary route: `done` from Fix goes to Check.
    expect(getItem(handle.db, item.id)?.stepId).toBe(made.stepIds.check);
    expect(listTransitionsForItem(handle.db, item.id).at(-1)).toMatchObject({ toStepId: made.stepIds.check, actor: "engine", reason: MOCKED_STEP_REASON });
  });

  it("runs no module for a module step, and moves the item on the named result — failure included", async () => {
    const module = deployModule();
    const made = await trialOf(shipDraft(module.id));
    const item = fileOn(made.trial.id);
    savePlan(made.trial.id, { steps: [{ stepId: made.stepIds.deploy!, mode: "mocked", mocks: [{ itemId: item.id, resultKey: "failed", output: "The deploy timed out." }] }] });
    let modulesAsked = 0;

    await createRunSupervisor({
      db: handle.db,
      provider: noBackend,
      limits: LIMITS,
      moduleRunner: (action) => {
        modulesAsked += 1;
        return lookup()(action);
      },
    }).runOnce();

    expect(modulesAsked).toBe(0);
    expect(listRunsForItem(handle.db, item.id)).toEqual([]);
    expect(listCommentsForItem(handle.db, item.id).filter(isMockedOutput).map((comment) => comment.body)).toEqual([
      expect.stringContaining('"Deploy" report `failed`'),
    ]);
    expect(getItem(handle.db, item.id)?.stepId).toBe(made.stepIds.check);
  });

  it("is held where it is, with a comment, where the plan names no result for the item", async () => {
    const made = await trialOf(fixDraft);
    const item = fileOn(made.trial.id);
    savePlan(made.trial.id, { steps: [{ stepId: made.stepIds.fix!, mode: "mocked" }] });

    const supervisor = createRunSupervisor({ db: handle.db, provider: noBackend, limits: LIMITS });
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe(made.stepIds.fix);
    // One placeholder that names no thread — the shape every refusal parks
    // on, never a backend run — and one comment, not one per tick.
    expect(listRunsForItem(handle.db, item.id).map((run) => ({ status: run.status, threadId: run.threadId }))).toEqual([{ status: "awaiting_input", threadId: null }]);
    const said = listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "escalation");
    expect(said).toHaveLength(1);
    expect(said[0]!.body).toContain('"Fix" is mocked on this trial, and the trial plan names no result for this test item');
  });

  /** A real agent run on the trial's Fix step that stopped to ask, with a thread to resume, and the person's reply to it. */
  function parkedRealRun(item: Item, fix: string) {
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const parked = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", stepId: fix, status: "awaiting_input", threadId: "thr-parked", provider: implementer.provider });
    updateRun(handle.db, parked.id, { startedAt: Date.now() - 2_000, endedAt: Date.now() - 1_000 });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Use the staging bucket." });
    return parked;
  }

  /** A provider that refuses both a fresh turn and a resumed one. */
  const noBackendAtAll = {
    start: () => { throw new Error("a mocked step must not start a backend run"); },
    resume: () => { throw new Error("a mocked step must not resume a backend run"); },
  } as unknown as AgentProvider;

  it("is mocked when a reply answers a real run that parked before the plan mocked it: no run resumed, the park closed, the item moved", async () => {
    const made = await trialOf(fixDraft);
    const item = fileOn(made.trial.id);
    const fix = made.stepIds.fix!;
    const parked = parkedRealRun(item, fix);
    savePlan(made.trial.id, { steps: [{ stepId: fix, mode: "mocked", mocks: [{ itemId: item.id, resultKey: "done", output: "Fixed against staging." }] }] });

    await createRunSupervisor({ db: handle.db, provider: noBackendAtAll, limits: LIMITS }).resumeItem(item.id);

    // The parked run and nothing after it: no backend run was resumed or started.
    expect(listRunsForItem(handle.db, item.id).map((run) => ({ id: run.id, status: run.status }))).toEqual([{ id: parked.id, status: "cancelled" }]);
    expect(listCommentsForItem(handle.db, item.id).filter(isMockedOutput).map((comment) => comment.body)).toEqual([expect.stringContaining("Fixed against staging.")]);
    expect(getItem(handle.db, item.id)?.stepId).toBe(made.stepIds.check);
    // Not parked any more, so nothing holds it on the step it moved to.
    expect(listAwaitingInputItemIds(handle.db).has(item.id)).toBe(false);
  });

  it("parks again, newer than the reply, when a reply finds the plan still naming nothing for the item", async () => {
    const made = await trialOf(fixDraft);
    const item = fileOn(made.trial.id);
    const fix = made.stepIds.fix!;
    const parked = parkedRealRun(item, fix);
    savePlan(made.trial.id, { steps: [{ stepId: fix, mode: "mocked" }] });

    await createRunSupervisor({ db: handle.db, provider: noBackendAtAll, limits: LIMITS }).resumeItem(item.id);

    const runs = listRunsForItem(handle.db, item.id);
    expect(runs).toHaveLength(2);
    const placeholder = runs.find((run) => run.id !== parked.id)!;
    expect(placeholder).toMatchObject({ status: "awaiting_input", threadId: null });
    expect(getItem(handle.db, item.id)?.stepId).toBe(fix);
    expect(listCommentsForItem(handle.db, item.id).at(-1)?.body).toContain("the trial plan names no result for this test item");
  });
});

describe("a redirected step", () => {
  it("gives a module its trial-only secrets in place of the step's own on a trial item, and its own on any other item", async () => {
    const module = deployModule({ env: ["TOKEN"] });
    const made = await trialOf(shipDraft(module.id));
    const deploy = made.stepIds.deploy!;
    storeSecret(secrets, "TOKEN", "shared");
    storeSecret(secrets, "TOKEN", "the step's own", deploy);
    storeSecret(secrets, "TOKEN", "a scratch target", trialScopeOf(deploy));
    const trialItem = fileOn(made.trial.id);
    savePlan(made.trial.id, { steps: [{ stepId: deploy, mode: "redirected" }] });
    // The same step, holding an item that is not a test item.
    const plain = createTestItem(handle.db, { type: "story", title: "Not a test item", projectId, stepId: deploy, pipelineId: made.trial.id });

    expect(await runModuleOn(module.id, trialItem)).toEqual({ ok: true, result: "deployed", detail: reversed("a scratch target") });
    expect(await runModuleOn(module.id, plain)).toEqual({ ok: true, result: "deployed", detail: reversed("the step's own") });
  });

  it("gives neither the step's own value nor the shared one for a name the trial does not redirect", async () => {
    const module = deployModule({ env: ["TOKEN"] });
    const made = await trialOf(shipDraft(module.id));
    const deploy = made.stepIds.deploy!;
    storeSecret(secrets, "TOKEN", "shared");
    storeVariable(secrets, "TOKEN", "the live channel", deploy);
    const item = fileOn(made.trial.id);
    savePlan(made.trial.id, { steps: [{ stepId: deploy, mode: "redirected" }] });

    const ran = await runModuleOn(module.id, item);
    expect(ran.ok).toBe(false);
    expect(!ran.ok && ran.reason).toContain("this step is redirected on this trial, and TOKEN is set on the step but not for its trial");
  });

  it("gives an agent run its trial-only variables in place of the step's own on a trial item", async () => {
    const made = await trialOf(fixDraft);
    const fix = made.stepIds.fix!;
    storeVariable(secrets, "CHANNEL", "#general");
    storeVariable(secrets, "REGION", "eu");
    storeVariable(secrets, "CHANNEL", "#releases", fix);
    storeVariable(secrets, "TIER", "prod", fix);
    storeVariable(secrets, "CHANNEL", "#scratch", trialScopeOf(fix));
    fileOn(made.trial.id);
    savePlan(made.trial.id, { steps: [{ stepId: fix, mode: "redirected" }] });

    const turns: AgentProviderStartOptions[] = [];
    const fake = createFakeProvider({ result: validImplementResult });
    const provider: AgentProvider = { ...fake, start: (opts) => (turns.push(opts), fake.start(opts)) };
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider,
      limits: LIMITS,
      runEnvironment: (stepId, trialScope) => agentRunVariables(secrets, stepId, trialScope),
      runEnvironmentWithheld: (stepId, trialScope) => redirectWithheldVariables(secrets, stepId, trialScope),
    });
    for (let tick = 0; tick < 5 && turns.length === 0; tick += 1) await supervisor.runOnce();

    expect(turns[0]?.environmentVariables).toEqual({ CHANNEL: "#scratch", REGION: "eu" });
    // TIER is the step's own and not redirected: absent from the map is not
    // enough, so the turn names it for the backend to take out of what the
    // CLI inherits too — which both adapters do (providerParity.test.ts,
    // "environment variables").
    expect(turns[0]?.withheldEnvironmentVariables).toEqual(["TIER"]);
    // The same step, off a trial item: its own.
    expect(agentRunVariables(secrets, fix)).toEqual({ CHANNEL: "#releases", REGION: "eu", TIER: "prod" });
  });
});

describe("a real step", () => {
  it("runs exactly as on a published pipeline: the module runs, on the step's own values, and the item moves on what it reported", async () => {
    const module = deployModule({ env: ["TOKEN"] });
    const made = await trialOf(shipDraft(module.id));
    const deploy = made.stepIds.deploy!;
    storeSecret(secrets, "TOKEN", "the step's own", deploy);
    storeSecret(secrets, "TOKEN", "a scratch target", trialScopeOf(deploy));
    const planned = fileOn(made.trial.id, "Planned real");
    const unplanned = fileOn(made.trial.id, "Not in the plan");
    savePlan(made.trial.id, { steps: [{ stepId: deploy, mode: "real" }] });
    expect(trialStepMode(handle.db, planned, deploy)).toEqual({ mode: "real" });

    const supervisor = createRunSupervisor({ db: handle.db, provider: noBackend, limits: LIMITS, moduleRunner: lookup() });
    for (let tick = 0; tick < 4; tick += 1) await supervisor.runOnce();
    await supervisor.waitForIdle();

    for (const item of [planned, unplanned]) {
      const runs = listRunsForItem(handle.db, item.id);
      expect(runs.map((run) => ({ provider: run.provider, status: run.status }))).toEqual([{ provider: "module", status: "succeeded" }]);
      expect(getItem(handle.db, item.id)?.stepId).toBe(made.stepIds.done);
      expect(listCommentsForItem(handle.db, item.id).some(isMockedOutput)).toBe(false);
    }
    // Ran on the step's own value, never the trial-only one.
    expect(await runModuleOn(module.id, fileOn(made.trial.id))).toEqual({ ok: true, result: "deployed", detail: reversed("the step's own") });
  });
});

describe("a real step copied from a live pipeline", () => {
  /** Ship as it is published, its Deploy step running `moduleId`. */
  function liveShip(moduleId: string): string {
    const pipeline = createPipeline(handle.db, { projectId, name: "Ship" });
    replacePipelineGraph(
      handle.db,
      pipeline.id,
      [
        { id: "live_deploy", pipelineId: pipeline.id as Uuid, position: 0, name: "Deploy", type: "module", entryAction: moduleId, isTerminal: false },
        { id: "live_done", pipelineId: pipeline.id as Uuid, position: 1, name: "Done", type: "user", isTerminal: true },
      ],
      [{ pipelineId: pipeline.id as Uuid, fromStepId: "live_deploy", resultKey: "deployed", label: "Deployed", tone: "success", target: "live_done", position: 0 }],
      { entryStepId: "live_deploy" },
    );
    return pipeline.id;
  }

  /** A draft of Ship that keeps both its steps and adds a person's check after Deploy. */
  const changeOfShip = (pipelineId: string, moduleId: string) => ({
    rationale: "A person checks the deploy.",
    entryStepId: "live_deploy",
    target: { pipelineId },
    steps: [step("live_deploy", 0, "Deploy", { type: "module", entryAction: moduleId }), step("ship_check", 1, "Check"), step("live_done", 2, "Done", { isTerminal: true })],
    routes: [
      { fromStepId: "live_deploy", resultKey: "deployed", label: "Deployed", tone: "success", target: "ship_check", position: 0 },
      { fromStepId: "ship_check", resultKey: "approve", label: "Approve", tone: "success", target: "live_done", position: 0 },
    ],
  });

  it("runs on the live step's own values, which the trial reads and never writes", async () => {
    const module = deployModule({ env: ["TOKEN"] });
    const live = liveShip(module.id);
    storeSecret(secrets, "TOKEN", "shared");
    storeSecret(secrets, "TOKEN", "the live step's own", "live_deploy");
    storeVariable(secrets, "REGION", "eu-north", "live_deploy");
    const chat = await conversation();
    const made = createTrialFromDraft(handle.db, undefined, { conversationId: chat.id, messageId: draftCard(chat, changeOfShip(live, module.id), live) });
    if (!made.ok) throw new Error(made.problem);
    const deploy = made.stepIds.live_deploy!;
    expect(deploy).not.toBe("live_deploy");
    const item = fileOn(made.trial.id);

    // A module run, through the runner — on the trial's copy of the module.
    expect(await runModuleOn(made.moduleIds[module.id]!, item)).toEqual({ ok: true, result: "deployed", detail: reversed("the live step's own") });
    // And an agent run's variables, through the same scope.
    expect(agentRunVariables(secrets, stepScopeFor(handle.db, item, deploy).stepId)).toEqual({ REGION: "eu-north" });
    // A step the draft invented has no live source: its own values are its own.
    expect(stepScopeFor(handle.db, item, made.stepIds.ship_check)).toEqual({ stepId: made.stepIds.ship_check });
    // Nothing was written into the live step's scope, or copied out of it.
    expect(readSecret(secrets, "TOKEN", "live_deploy")).toBe("the live step's own");
    expect(readSecret(secrets, "TOKEN", deploy)).toBeNull();
  });

  it("redirects in place of the live step's own values, keyed by the trial's step", async () => {
    const module = deployModule({ env: ["TOKEN"] });
    const live = liveShip(module.id);
    storeSecret(secrets, "TOKEN", "the live step's own", "live_deploy");
    const chat = await conversation();
    const made = createTrialFromDraft(handle.db, undefined, { conversationId: chat.id, messageId: draftCard(chat, changeOfShip(live, module.id), live) });
    if (!made.ok) throw new Error(made.problem);
    const deploy = made.stepIds.live_deploy!;
    const item = fileOn(made.trial.id);
    storeSecret(secrets, "TOKEN", "a scratch target", trialScopeOf(deploy));
    savePlan(made.trial.id, { steps: [{ stepId: deploy, mode: "redirected" }] });

    expect(stepScopeFor(handle.db, item, deploy)).toEqual({ stepId: "live_deploy", trialScope: trialScopeOf(deploy) });
    expect(await runModuleOn(made.moduleIds[module.id]!, item)).toEqual({ ok: true, result: "deployed", detail: reversed("a scratch target") });
  });
});

describe("what the assistant reads about a step's reach outside EO", () => {
  /** A helpdesk connector that sends, attached to the implementer — so every implementer step sends. */
  function helpdeskOnTheImplementer() {
    const saved = saveMcpServer(
      handle.db,
      McpServerDraftSchema.parse({ name: "helpdesk", transport: "stdio", command: "helpdesk-mcp", connector: { label: "Helpdesk", kind: "token", secretNames: ["HELPDESK_TOKEN"], oauth: null, sideEffects: true } }),
    );
    if (!saved.ok) throw new Error(saved.problems.join("\n"));
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: saved.server.id, attached: true });
  }

  const graph = (pipelineId: string, sending: string, quiet: string) => ({
    steps: [
      { id: "rx_pr", pipelineId: pipelineId as Uuid, position: 0, name: "Open PR", type: "builtin" as const, ownerRole: null, entryAction: "open_pull_request", isTerminal: false },
      { id: "rx_worktree", pipelineId: pipelineId as Uuid, position: 1, name: "Worktree", type: "builtin" as const, ownerRole: null, entryAction: "create_worktree", isTerminal: false },
      { id: "rx_send", pipelineId: pipelineId as Uuid, position: 2, name: "Send", type: "module" as const, ownerRole: null, entryAction: sending, isTerminal: false },
      { id: "rx_build", pipelineId: pipelineId as Uuid, position: 3, name: "Build", type: "module" as const, ownerRole: null, entryAction: quiet, isTerminal: false },
      { id: "rx_reply", pipelineId: pipelineId as Uuid, position: 4, name: "Reply", type: "agent" as const, ownerRole: "implementer", entryAction: "implement", isTerminal: false },
      { id: "rx_done", pipelineId: pipelineId as Uuid, position: 5, name: "Done", type: "user" as const, isTerminal: true },
    ],
  });

  function modules() {
    const sending = deployModule({ sideEffects: true });
    const quiet = saveModule(handle.db, { slug: "build", name: "Build", description: "Builds.", code: "export default async function run() { return { ok: true, result: \"deployed\" }; }", manifest: { ...sending.manifest, name: "Build", sideEffects: false }, source: "architect", approve: true });
    if (!quiet.ok) throw new Error(quiet.reason);
    return { sending, quiet: quiet.module };
  }

  it("says on pipeline_get, per step, whether a builtin, a module and a connector-backed agent step sends outside EO", () => {
    helpdeskOnTheImplementer();
    const { sending, quiet } = modules();
    const pipeline = createPipeline(handle.db, { projectId, name: "Support" });
    replacePipelineGraph(handle.db, pipeline.id, graph(pipeline.id, sending.id, quiet.id).steps, [], { entryStepId: "rx_pr" });

    const read = listPipelineStepViews(handle.db, { pipelineId: pipeline.id });

    expect(read.outsideReach).toEqual({ rx_pr: "sends", rx_send: "sends", rx_reply: "sends" });
    const text = renderPipeline(read);
    expect(text).toMatch(/- Open PR \(id: rx_pr\)[^\n]*\n {2}sends outside EO/);
    expect(text).toMatch(/- Reply \(id: rx_reply\)[^\n]*\n {2}sends outside EO/);
    expect(text).not.toMatch(/- Worktree \(id: rx_worktree\)[^\n]*\n {2}sends outside EO/);
  });

  it("says it of a draft's graph on pipeline_validate, a module that creates work included", () => {
    helpdeskOnTheImplementer();
    const { sending, quiet } = modules();
    const creating = saveModule(handle.db, {
      slug: "file",
      name: "File",
      description: "Files follow-ups.",
      code: "export default async function run() { return { ok: true, result: \"deployed\" }; }",
      manifest: { ...quiet.manifest, name: "File", needs: { ...quiet.manifest.needs, create: true } },
      source: "architect",
      approve: true,
    });
    if (!creating.ok) throw new Error(creating.reason);
    const pipeline = createPipeline(handle.db, { projectId, name: "Support" });
    const steps = graph(pipeline.id, sending.id, creating.module.id).steps.map((one) => ({ instructionsSummary: null, planMode: false, ownerRole: null, entryAction: null, ...one }));

    const judged = validatePipelineCommand(handle.db, ipcContract["pipeline:validate"].request.parse({ pipelineId: pipeline.id, steps, routes: [], entryStepId: "rx_pr" }));

    expect(judged.outsideReach).toEqual({ rx_pr: "sends", rx_send: "sends", rx_build: "creates", rx_reply: "sends" });
    expect(renderPipelineProblems(judged)).toContain("- rx_build: creates work items");
  });
});
