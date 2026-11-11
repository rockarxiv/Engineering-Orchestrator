import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PIPELINE_EXPORT_VERSION, developerRegistry, ipcContract, type DiscussionOutput, type EntryRule, type IpcPayload, type Item, type Uuid } from "@eo/core";
import type { DbHandle } from "./db/client.js";
import {
  createPipeline,
  createRoute,
  createRun,
  createStep,
  getItem,
  getPipeline,
  insertItemType,
  listCommentsForItem,
  listAgents,
  listJobs,
  listMentionsForComment,
  listOccurrences,
  listPipelineVersions,
  listRunsForItem,
  listStepsForPipeline,
  replacePipelineGraph,
  transitionItem,
  updateRun,
} from "./db/repos/index.js";
import { items, keyCounters, pipelines } from "./db/schema.js";
import { createTestItem, messagesAboutJob, openMigratedTestDb } from "./db/testHelpers.js";
import { openAssistConversation, postAssistReply } from "./roles/assist.js";
import { ASSIST_ACTION } from "./roles/conversationSteps.js";
import { applyDiscussionProposal, applyNewItem } from "./roles/discussion.js";
import { PROPOSAL_KIND } from "./roles/proposal.js";
import { decideItem, moveItem, moveItemToVersion } from "./ipc/domainCommands.js";
import { moveStepItemsCommand, pipelineVersionsCommand } from "./ipc/pipelineCommands.js";
import { listPipelineStepViews } from "./ipc/domainQueries.js";
import { savePipeline, validatePipelineCommand } from "./ipc/configCommands.js";
import { submitPlan } from "./ipc/planCommands.js";
import { restoreVersion } from "./ipc/sectionCommands.js";
import { fireJob } from "./jobs/fire.js";
import { createJob, updateJob } from "./jobs/jobs.js";
import { renderPipeline, renderPipelineVersions } from "./mcpHost/render.js";
import { exportPipeline, importPipeline, parseExport } from "./modules/pipelineTransfer.js";
import { createScriptedProvider } from "./providers/scripted.js";
import { createRunSupervisor } from "./supervisor/runSupervisor.js";

/**
 * What a pipeline asks of work coming in (EO-610, ARCHITECTURE.md, "Entry
 * rules"), at each way in. The rules themselves are held in
 * `packages/engine/src/entryRules.test.ts`.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const WANTS_A_BODY = '"Delivery" needs these before work can enter it: a description.';

let handle: DbHandle;

/** A second pipeline with a step to arrive on. */
function intake(rules: EntryRule[], name = "Intake"): { pipelineId: string; stepId: string } {
  const pipeline = createPipeline(handle.db, { name, position: 9 });
  const step = createStep(handle.db, { pipelineId: pipeline.id as Uuid, position: 0, name: "Triage", type: "user" });
  createStep(handle.db, { pipelineId: pipeline.id as Uuid, position: 1, name: "Done", type: "user", isTerminal: true });
  setRules(pipeline.id, rules);
  handle.db.update(pipelines).set({ entryStepId: step.id }).where(eq(pipelines.id, pipeline.id)).run();
  return { pipelineId: pipeline.id, stepId: step.id };
}

function setRules(pipelineId: string, rules: EntryRule[]): void {
  handle.db.update(pipelines).set({ entryRules: rules }).where(eq(pipelines.id, pipelineId)).run();
}

/** `pipeline:save` as the board stands, with only the rules changed. */
function graph(pipelineId: string, overrides: Partial<IpcPayload<"pipeline:save">> = {}): IpcPayload<"pipeline:save"> {
  const view = listPipelineStepViews(handle.db, { pipelineId });
  return { pipelineId, steps: view.steps, routes: view.routes, entryStepId: view.entryStepId, ...overrides };
}

const counters = () => handle.db.select().from(keyCounters).all();

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

describe("a pipeline with no rules", () => {
  it("has none after the migration, and takes what it always took", () => {
    expect(getPipeline(handle.db, "default")?.entryRules).toEqual([]);
    expect(createTestItem(handle.db, { type: "story", title: "No body at all", stepId: "todo" }).body).toBeNull();
  });
});

describe("creating an item", () => {
  beforeEach(() => setRules("default", [{ kind: "description" }]));

  it("refuses, naming what is missing, leaves nothing behind and does not move the counter", () => {
    const before = counters();
    expect(() => createTestItem(handle.db, { type: "story", title: "Thin", stepId: "todo" })).toThrow(WANTS_A_BODY);
    expect(handle.db.select().from(items).all()).toEqual([]);
    expect(counters()).toEqual(before);
  });

  it("lets through an item that meets them", () => {
    expect(createTestItem(handle.db, { type: "story", title: "Thick", body: "Written down.", stepId: "todo" }).stepId).toBe("todo");
  });

  it("answers work_submit_item and an accepted card in the refusal `applyNewItem` has always given", () => {
    const refused = applyNewItem(handle.db, null, { type: "story", title: "Thin", body: " ", spec: { acceptance_criteria: ["It works."] }, depends_on: [] }, "default");
    expect(refused).toEqual({ ok: false, reason: WANTS_A_BODY });
  });

  it("answers an accepted assistant card by refusing it, and files nothing", () => {
    const conversation = openAssistConversation(handle.db, null);
    const agent = listAgents(handle.db).find((entry) => entry.role === "system")!;
    const output = { message: "Here it is.", questions: [], proposals: [{ action: "new_bug", title: "Logout", body: " ", steps_to_reproduce: "Press it.", expected: "It ends.", actual: "Nothing.", environment: "Chrome." }] } as unknown as DiscussionOutput;
    const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION });
    updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(output), parsed: output } });
    postAssistReply(handle.db, conversation, agent.id, run.id, output);
    const card = listCommentsForItem(handle.db, conversation.id).find((comment) => comment.kind === PROPOSAL_KIND)!;

    expect(applyDiscussionProposal(handle.db, conversation, card.id as Uuid)).toEqual({ ok: false, reason: WANTS_A_BODY });
    expect(handle.db.select().from(items).all().map((row) => row.id)).toEqual([conversation.id]);
  });

  it("leaves the steps a conversation lives on alone", () => {
    expect(openAssistConversation(handle.db, null).title).toBe("Assistance");
  });

  it.each([[{ trialAt: 1 }], [{ previewAt: 1 }]])("exempts a rehearsal: %j", (rehearsal) => {
    expect(createTestItem(handle.db, { type: "story", title: "Thin", stepId: "todo", ...rehearsal }).title).toBe("Thin");
  });

  it("does not ask an item on no pipeline", () => {
    expect(createTestItem(handle.db, { type: "feature", title: "A container", pipelineId: null, stepId: null }).title).toBe("A container");
  });

  it("reads a Jira key, and a rule's types, off what is being created", () => {
    setRules("default", [{ kind: "jira_key", types: ["developer:story"] }]);
    expect(() => createTestItem(handle.db, { type: "story", title: "Unlinked", stepId: "todo" })).toThrow("a Jira key");
    expect(createTestItem(handle.db, { type: "story", title: "Linked", stepId: "todo", jiraKey: "PROJ-1" }).title).toBe("Linked");
    expect(createTestItem(handle.db, { type: "bug", title: "Another type", stepId: "todo" }).title).toBe("Another type");
  });

  it("checks a field against the type being created, and against the spec it arrives with", () => {
    insertItemType(handle.db, null, { packSlug: "local", slug: "case", label: "Case", plural: "Cases", container: false, specShape: { type: "object", properties: { customer: { type: "string" } }, required: [] }, actionOverrides: {} });
    setRules("default", [{ kind: "field", field: "customer", types: ["local:case"] }]);
    expect(() => createTestItem(handle.db, { type: "case", title: "Nobody", stepId: "todo", spec: { customer: "  " } })).toThrow("a Customer");
    expect(createTestItem(handle.db, { type: "case", title: "Acme", stepId: "todo", spec: { customer: "Acme" } }).title).toBe("Acme");
    expect(createTestItem(handle.db, { type: "story", title: "Not a case", stepId: "todo" }).title).toBe("Not a case");
  });
});

describe("a plan", () => {
  const story = (title: string, body: string) => ({ title, body, acceptance_criteria: [`${title} works`], depends_on: [], touches: [] });
  const plan = (stories: ReturnType<typeof story>[]): IpcPayload<"work:submitPlan"> => ({
    title: "A plan",
    understanding: "What we agreed, written down at length for whoever reads it next.",
    decisions: [{ topic: "Scope", decision: "All of it." }],
    stories,
  });

  it("is refused whole for one story that fails, naming that story, and creates nothing", () => {
    setRules("default", [{ kind: "field", field: "customer" }]);
    const before = counters();
    const answer = submitPlan(handle.db, undefined, plan([story("Fine", "Body"), story("Also this one", "Body")]));

    expect(answer.created).toBe(false);
    expect(answer.problem).toContain('"Fine" cannot enter');
    expect(answer.problem).toContain("a Customer");
    expect(handle.db.select().from(items).all()).toEqual([]);
    expect(counters()).toEqual(before);
  });

  it("goes through when every story meets them", () => {
    setRules("default", [{ kind: "description" }]);
    expect(submitPlan(handle.db, undefined, plan([story("One", "Body")])).created).toBe(true);
  });
});

describe("moving an item in by hand", () => {
  const arriving = () => createTestItem(handle.db, { type: "story", title: "Moving", stepId: "todo" });
  const move = (item: Item, to: { pipelineId: string; stepId: string }, cancelActiveRun = false) =>
    moveItem(handle.db, undefined, { itemId: item.id, toStepId: to.stepId, toPipelineId: to.pipelineId, cancelActiveRun, comment: "Over you go." });

  it("is refused with the sentence, and writes nothing, not even the comment", () => {
    const to = intake([{ kind: "description" }]);
    const item = arriving();

    expect(move(item, to)).toEqual({ moved: false, cancelledRunId: null, blockedByActiveRun: false, commentId: null, problem: '"Intake" needs these before work can enter it: a description.' });
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
  });

  it("is decided before the active-run guard, so a running agent is not cancelled", () => {
    const to = intake([{ kind: "description" }]);
    const item = arriving();
    createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "running" });

    const answer = move(item, to, true);

    expect(answer).toMatchObject({ moved: false, blockedByActiveRun: false, cancelledRunId: null });
    expect(answer.problem).toContain("a description");
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("running");
  });

  it("goes through for an item that meets them, as it always has", () => {
    const to = intake([{ kind: "description" }]);
    const item = createTestItem(handle.db, { type: "story", title: "Moving", body: "Written.", stepId: "todo" });
    expect(move(item, to)).toMatchObject({ moved: true, problem: null });
    expect(getItem(handle.db, item.id)).toMatchObject({ stepId: to.stepId, pipelineId: to.pipelineId });
  });

  it("is never asked of a move within one pipeline", () => {
    const item = arriving();
    setRules("default", [{ kind: "description" }]);
    expect(moveItem(handle.db, undefined, { itemId: item.id, toStepId: "review", toPipelineId: "default" as Uuid, cancelActiveRun: false, comment: "" }).moved).toBe(true);
    expect(moveItem(handle.db, undefined, { itemId: item.id, toStepId: "todo", cancelActiveRun: false, comment: "" }).moved).toBe(true);
  });

  it("exempts a rehearsal", () => {
    const to = intake([{ kind: "description" }]);
    const item = createTestItem(handle.db, { type: "story", title: "A rehearsal", stepId: "todo", trialAt: 1 });
    expect(move(item, to).moved).toBe(true);
  });

  it("is not asked of work being cleared off a step that is going", () => {
    const item = arriving();
    const to = intake([{ kind: "description" }]);
    const answer = moveStepItemsCommand(handle.db, { fromStepId: "todo", toStepId: to.stepId });
    expect(answer.moved).toBe(1);
    expect(getItem(handle.db, item.id)?.pipelineId).toBe(to.pipelineId);
  });

  it("is not asked of a move to another version of the pipeline it is on", () => {
    const item = arriving();
    const first = savePipeline(handle.db, undefined, graph("default"));
    expect(first.saved).toBe(true);
    savePipeline(handle.db, undefined, graph("default", { entryRules: [{ kind: "description" }] }));

    expect(moveItemToVersion(handle.db, undefined, { itemId: item.id, version: first.version!, comment: "" }).problem).toBeNull();
  });

  it("is checked against the version the arrival would bind to, for a step the pipeline has retired", () => {
    const to = intake([]);
    const steps = listStepsForPipeline(handle.db, to.pipelineId);
    // A version with the rule, then one that drops the step and the rule.
    // An item bound for that step still enters on the version that has it.
    replacePipelineGraph(handle.db, to.pipelineId, steps, [], { entryRules: [{ kind: "description" }] });
    const kept = steps.filter((step) => step.id !== to.stepId);
    replacePipelineGraph(handle.db, to.pipelineId, kept, [], { entryStepId: kept[0]!.id, entryRules: [] });
    expect(getPipeline(handle.db, to.pipelineId)?.entryRules).toEqual([]);

    const item = arriving();
    expect(moveItem(handle.db, undefined, { itemId: item.id, toStepId: to.stepId, toPipelineId: to.pipelineId as Uuid, cancelActiveRun: false, comment: "" }).problem).toContain("a description");
  });
});

describe("a person's decision that hands an item to another pipeline", () => {
  it("is refused on the button, with the sentence, and the item stays", () => {
    const to = intake([{ kind: "description" }]);
    const approve = createStep(handle.db, { pipelineId: "default" as Uuid, position: 40, name: "Approve", type: "user", results: [{ key: "ok", label: "OK", tone: "success", requiresComment: false }] });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: approve.id, resultKey: "ok", label: "OK", target: to.stepId });
    const item = createTestItem(handle.db, { type: "story", title: "Thin", stepId: approve.id });

    const answer = decideItem(handle.db, undefined, { itemId: item.id, resultKey: "ok", comment: "" });

    expect(answer).toMatchObject({ decided: false, problem: '"Intake" needs these before work can enter it: a description.' });
    expect(getItem(handle.db, item.id)?.stepId).toBe(approve.id);
  });
});

describe("a route into another pipeline", () => {
  function moduleStep(target: string, key = "shipped") {
    const step = createStep(handle.db, { pipelineId: "default" as Uuid, position: 40, name: "Ship", type: "module", entryAction: "mod-1" });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: step.id, resultKey: key, label: "Shipped", target });
    return step;
  }
  const supervisorRunningAModule = () =>
    createRunSupervisor({
      db: handle.db,
      provider: { start: () => { throw new Error("a module must not reach a provider"); } } as never,
      limits: LIMITS,
      builtins: {},
      moduleRunner: () => async () => ({ ok: true, result: "shipped", detail: "done" }),
    });
  const escalations = (item: Item) => listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "escalation");

  it("out of a module step parks the item with EO's question, and the next tick leaves it", async () => {
    const to = intake([{ kind: "description" }]);
    const step = moduleStep(to.stepId);
    const item = createTestItem(handle.db, { type: "story", title: "Thin", stepId: step.id });
    const supervisor = supervisorRunningAModule();

    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe(step.id);
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs.map((run) => run.status)).toEqual(["awaiting_input"]);
    expect(runs[0]?.error).toContain('"Intake" needs these before work can enter it: a description.');
    const [asked] = escalations(item);
    expect(asked?.authorType).toBe("engine");
    expect(asked?.body).toContain('"Intake" needs these before work can enter it: a description.');
    expect(listMentionsForComment(handle.db, asked!.id).map((mention) => mention.targetType)).toEqual(["human"]);
  });

  it("lets a person move it in once it is fixed", async () => {
    const to = intake([{ kind: "description" }]);
    const step = moduleStep(to.stepId);
    const item = createTestItem(handle.db, { type: "story", title: "Thin", stepId: step.id });
    await supervisorRunningAModule().runOnce();

    handle.db.update(items).set({ body: "Now it says something." }).where(eq(items.id, item.id)).run();

    expect(moveItem(handle.db, undefined, { itemId: item.id, toStepId: to.stepId, toPipelineId: to.pipelineId as Uuid, cancelActiveRun: false, comment: "" }).moved).toBe(true);
    expect(getItem(handle.db, item.id)?.pipelineId).toBe(to.pipelineId);
  });

  it("goes straight through for an item that meets them", async () => {
    const to = intake([{ kind: "description" }]);
    const step = moduleStep(to.stepId);
    const item = createTestItem(handle.db, { type: "story", title: "Thick", body: "Written.", stepId: step.id });

    await supervisorRunningAModule().runOnce();

    expect(getItem(handle.db, item.id)).toMatchObject({ stepId: to.stepId, pipelineId: to.pipelineId });
  });

  it("out of an agent step parks too, and the agent is not dispatched again", async () => {
    const to = intake([{ kind: "description" }]);
    const step = createStep(handle.db, { pipelineId: "default" as Uuid, position: 40, name: "Check", type: "agent", ownerRole: "implementer", entryAction: "check" });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: step.id, resultKey: "done", label: "Done", target: to.stepId });
    const item = createTestItem(handle.db, { type: "story", title: "Thin", stepId: step.id });
    const supervisor = createRunSupervisor({ db: handle.db, limits: LIMITS, provider: createScriptedProvider([{ when: () => true, script: { result: { result: "done" } } }]) });

    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe(step.id);
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs.map((run) => run.status)).toEqual(["awaiting_input"]);
    expect(escalations(item).at(-1)?.body).toContain("a description");
  });

  it("parks a failure route, not only a success", async () => {
    const to = intake([{ kind: "description" }]);
    handle.db.run(sql`UPDATE step_routes SET target = ${to.stepId} WHERE from_step_id = 'worktree' AND result_key = 'failed'`);
    const item = createTestItem(handle.db, { type: "story", title: "Thin", stepId: "worktree" });

    await createRunSupervisor({
      db: handle.db,
      provider: { start: () => { throw new Error("a builtin must not reach a provider"); } } as never,
      limits: LIMITS,
      builtins: { create_worktree: async () => ({ ok: false, reason: "It would not cut." }) },
    }).runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("worktree");
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");
    expect(escalations(item).at(-1)?.body).toContain("a description");
  });

  it("is not asked of a route within the pipeline", async () => {
    setRules("default", [{ kind: "description" }]);
    const step = moduleStep("review");
    const item = createTestItem(handle.db, { type: "story", title: "Already in", stepId: step.id, trialAt: 1 });
    transitionItem(handle.db, { itemId: item.id, toStepId: step.id, actor: "human" });
    handle.db.update(items).set({ trialAt: null }).where(eq(items.id, item.id)).run();

    await supervisorRunningAModule().runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
  });
});

describe("a job", () => {
  const template = { type: "developer:story", title: "Report for {{date}}", body: null };
  const schedule = { kind: "manual" as const };
  const webhook = (mapping: { body?: string; spec?: Record<string, string> } = {}) => ({ kind: "webhook" as const, path: "incoming", secret: "s".repeat(40), mapping: { title: null, body: null, eventKey: null, spec: {}, ...mapping } });
  const job = (overrides: Partial<Parameters<typeof createJob>[1]> = {}) => createJob(handle.db, { projectId: null, name: "Reports", trigger: schedule, pipelineId: "default", template, ...overrides });

  it("is refused when its template fails, and saves nothing", () => {
    setRules("default", [{ kind: "description" }]);
    expect(job()).toEqual({ ok: false, problem: WANTS_A_BODY });
    expect(listJobs(handle.db, null)).toEqual([]);
  });

  it("counts a template value holding a blank as present", () => {
    setRules("default", [{ kind: "description" }]);
    expect(job({ template: { ...template, body: "{{date}}" } }).ok).toBe(true);
  });

  it("counts what a webhook mapping fills as present, and a job with no mapping as not", () => {
    insertItemType(handle.db, null, { packSlug: "local", slug: "case", label: "Case", plural: "Cases", container: false, specShape: { type: "object", properties: { customer: { type: "string" } }, required: [] }, actionOverrides: {} });
    setRules("default", [{ kind: "description" }, { kind: "field", field: "customer", types: ["local:case"] }]);
    const cases = { ...template, type: "local:case" };

    expect(job({ trigger: webhook(), template: cases })).toEqual({ ok: false, problem: '"Delivery" needs these before work can enter it: a description, a Customer.' });
    expect(job({ trigger: webhook({ body: "/text", spec: { customer: "/who" } }), template: cases }).ok).toBe(true);
  });

  it("refuses an update that would fail, saves nothing, and leaves a rename alone", () => {
    const made = job({ template: { ...template, body: "Written." } });
    if (!made.ok) throw new Error(made.problem);
    setRules("default", [{ kind: "description" }]);

    expect(updateJob(handle.db, { jobId: made.job.id as Uuid, template })).toEqual({ ok: false, problem: WANTS_A_BODY });
    expect(listJobs(handle.db, null)[0]?.template?.body).toBe("Written.");

    setRules("default", [{ kind: "workspace" }]);
    expect(updateJob(handle.db, { jobId: made.job.id as Uuid, name: "Renamed" }).ok).toBe(true);
  });

  it("fails an occurrence with the sentence when a firing is refused, tells the owner, and fires again later", () => {
    const made = job({ template: { ...template, body: "Written." } });
    if (!made.ok) throw new Error(made.problem);
    setRules("default", [{ kind: "workspace" }]);

    const fired = fireJob(handle.db, made.job, { dueAt: 1 });

    const sentence = '"Delivery" needs these before work can enter it: a workspace.';
    expect(fired).toMatchObject({ item: null, problem: sentence });
    expect(fired.occurrence).toMatchObject({ status: "failed", reason: sentence });
    expect(messagesAboutJob(handle.db, made.job.id).map((message) => message.body).join()).toContain(sentence);
    expect(listCommentsForItem(handle.db, made.job.threadItemId as Uuid)).toEqual([]);

    setRules("default", []);
    expect(fireJob(handle.db, made.job, { dueAt: 2 }).occurrence?.status).toBe("fired");
    expect(listOccurrences(handle.db, made.job.id as Uuid).map((row) => row.status).sort()).toEqual(["failed", "fired"]);
  });
});

describe("authoring", () => {
  const rules: EntryRule[] = [{ kind: "description", message: "a summary" }, { kind: "workspace" }];

  it("stores what pipeline:save is sent, files a version, and pipeline_get says so", () => {
    const before = listPipelineVersions(handle.db, "default").length;
    const saved = savePipeline(handle.db, undefined, graph("default", { entryRules: rules }));

    expect(saved.saved).toBe(true);
    expect(getPipeline(handle.db, "default")?.entryRules).toEqual(rules);
    expect(listPipelineVersions(handle.db, "default").length).toBeGreaterThan(before);
    const view = listPipelineStepViews(handle.db, { pipelineId: "default" });
    expect(view.entryRules).toEqual(rules);
    expect(view.entrySentence).toBe('"Delivery" needs these before work can enter it: a summary, a workspace.');
    expect(renderPipeline(view)).toContain("## Entry rules");
    expect(renderPipeline(view)).toContain(JSON.stringify(rules));
  });

  it("says nothing of them for a pipeline with none", () => {
    const view = listPipelineStepViews(handle.db, { pipelineId: "default" });
    expect(view.entrySentence).toBeNull();
    expect(renderPipeline(view)).not.toContain("Entry rules");
  });

  it("is offered to pipeline_save, whose schema takes what the channel does", () => {
    expect(ipcContract["pipeline:save"].request.safeParse(graph("default", { entryRules: rules })).success).toBe(true);
    expect(ipcContract["pipeline:save"].request.safeParse(graph("default", { entryRules: [{ message: "No kind" }] as never })).success).toBe(false);
  });

  it("keeps the rules when a save leaves them out, and clears them on []", () => {
    savePipeline(handle.db, undefined, graph("default", { entryRules: rules }));
    savePipeline(handle.db, undefined, graph("default"));
    expect(getPipeline(handle.db, "default")?.entryRules).toEqual(rules);
    savePipeline(handle.db, undefined, graph("default", { entryRules: [] }));
    expect(getPipeline(handle.db, "default")?.entryRules).toEqual([]);
  });

  it.each([
    [[{ kind: "field", field: "nobody_declares_this" }], "nobody_declares_this"],
    [[{ kind: "description", types: ["support:case"] }], "support:case"],
    [[{ kind: "telepathy" }], "telepathy"],
  ] as [EntryRule[], string][])("refuses %j, at save and at validate, and saves nothing", (bad, named) => {
    const saved = savePipeline(handle.db, undefined, graph("default", { entryRules: bad }));
    expect(saved.saved).toBe(false);
    expect(saved.problems.map((problem) => problem.message).join()).toContain(named);
    expect(getPipeline(handle.db, "default")?.entryRules).toEqual([]);
    expect(validatePipelineCommand(handle.db, graph("default", { entryRules: bad })).problems.map((problem) => problem.message).join()).toContain(named);
  });

  it("does not let a stale rule stop somebody editing a step", () => {
    setRules("default", [{ kind: "telepathy" }]);
    expect(savePipeline(handle.db, undefined, graph("default")).saved).toBe(true);
  });

  it("lists the change on the version diff, rollback restores them, and `pipeline_versions` hands them back", () => {
    savePipeline(handle.db, undefined, graph("default", { entryRules: rules }));
    const withRules = listPipelineVersions(handle.db, "default").at(-1)!;
    savePipeline(handle.db, undefined, graph("default", { entryRules: [] }));

    const versions = pipelineVersionsCommand(handle.db, { pipelineId: "default", graph: withRules.number });
    expect(versions.diff?.entryRules).toEqual({ before: "a summary, a workspace", after: "none" });
    expect(versions.graph?.entryRules).toEqual(rules);
    expect(renderPipelineVersions(versions)).toContain("Entry rules: a summary, a workspace → none");

    expect(restoreVersion(handle.db, "default", withRules)).toBeNull();
    expect(getPipeline(handle.db, "default")?.entryRules).toEqual(rules);
  });

  it("restores them from the version a draft says it restores", () => {
    savePipeline(handle.db, undefined, graph("default", { entryRules: rules }));
    const withRules = listPipelineVersions(handle.db, "default").at(-1)!;
    savePipeline(handle.db, undefined, graph("default", { entryRules: [] }));

    expect(savePipeline(handle.db, undefined, graph("default", { restoredFrom: withRules.number })).saved).toBe(true);
    expect(getPipeline(handle.db, "default")?.entryRules).toEqual(rules);
  });
});

describe("a pipeline as a file", () => {
  const rules: EntryRule[] = [{ kind: "description" }, { kind: "field", field: "acceptance_criteria", types: ["developer:story"], message: "criteria" }];

  function exported() {
    const built = exportPipeline(handle.db, "default");
    if (!built.ok) throw new Error(built.reason);
    return built.document;
  }

  it("carries them out and restores them on the way in", () => {
    setRules("default", rules);
    const document = exported();
    expect(document.eoPipelineExport).toBe(PIPELINE_EXPORT_VERSION);
    expect(document.pipeline.entryRules).toEqual(rules);

    const imported = importPipeline(handle.db, { document });
    expect(imported.ok).toBe(true);
    if (imported.ok) expect(getPipeline(handle.db, imported.pipelineId)?.entryRules).toEqual(rules);
  });

  it("refuses an import the same validation refuses, and writes nothing", () => {
    const document = exported();
    const before = listStepsForPipeline(handle.db, "default").length;
    const refused = importPipeline(handle.db, { document: { ...document, pipeline: { ...document.pipeline, entryRules: [{ kind: "telepathy" }] } } });

    expect(refused).toMatchObject({ ok: false, reason: expect.stringContaining("telepathy") });
    expect(listStepsForPipeline(handle.db, "default")).toHaveLength(before);
  });

  it("accepts a type the document brings with it", () => {
    const document = exported();
    const type = { packSlug: "local", slug: "case", label: "Case", plural: "Cases", container: false, specShape: { type: "object", properties: { customer: { type: "string" } }, required: [] }, actionOverrides: {} };
    const imported = importPipeline(handle.db, { document: { ...document, itemTypes: [...document.itemTypes, type] as never, pipeline: { ...document.pipeline, entryRules: [{ kind: "field", field: "customer", types: ["local:case"] }] } } });
    expect(imported.ok).toBe(true);
  });

  it("reads a document with no rules as one that asks for nothing", () => {
    const pipeline: Partial<ReturnType<typeof exported>["pipeline"]> = { ...exported().pipeline };
    delete pipeline.entryRules;
    const parsed = parseExport(JSON.stringify({ ...exported(), eoPipelineExport: 10, pipeline }));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.document.pipeline.entryRules).toEqual([]);
    const imported = importPipeline(handle.db, { document: parsed.document });
    expect(imported.ok).toBe(true);
    if (imported.ok) expect(getPipeline(handle.db, imported.pipelineId)?.entryRules).toEqual([]);
  });
});

describe("the registry", () => {
  it("has the developer pack answering for a Jira key", () => {
    expect(developerRegistry().entryRuleKinds?.get("jira_key")).toEqual({ noun: "a Jira key", extension: "jira", property: "key" });
  });
});

