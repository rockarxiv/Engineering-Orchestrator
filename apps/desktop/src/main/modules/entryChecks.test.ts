import { randomUUID } from "node:crypto";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ipcContract, type DiscussionOutput, type EntryRule, type IpcPayload, type Item, type ModuleManifest, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  createPipeline,
  createRoute,
  createRun,
  createStep,
  getItem,
  insertItemType,
  listAgents,
  listCommentsForItem,
  listOccurrences,
  listPipelineVersions,
  getPipeline,
  getModuleBySlug,
  listRunsForItem,
  projectForWorkspace,
  saveModule,
  updateRun,
} from "../db/repos/index.js";
import { approveModule } from "../db/repos/modulesRepo.js";
import { getGitWorkspace } from "../db/repos/workspacesRepo.js";
import { attachments, items, keyCounters, pipelines } from "../db/schema.js";
import { attachWorkspace, createTestItem, messagesAboutJob, openMigratedTestDb } from "../db/testHelpers.js";
import { decideItemChecked, moveItemChecked } from "../ipc/domainCommands.js";
import { submitItemCommand } from "../ipc/itemCommands.js";
import { submitPlanCommand } from "../ipc/planCommands.js";
import { savePipeline } from "../ipc/configCommands.js";
import { pipelineVersionsCommand } from "../ipc/pipelineCommands.js";
import { exportPipeline, importPipeline, parseExport } from "./pipelineTransfer.js";
import { listPipelineStepViews } from "../ipc/domainQueries.js";
import { approveWorkProposalThroughRecord } from "../ipc/conversationTurns.js";
import { createJobCommand, runJobNowChecked } from "../ipc/jobCommands.js";
import { approveModuleCommand } from "../ipc/moduleCommands.js";
import { fireJob, fireJobChecked, jobEntryVerdicts } from "../jobs/fire.js";
import { createJob } from "../jobs/jobs.js";
import { createLocalRecord, recordFor } from "../record/localRecord.js";
import { serveApply } from "../record/serveRecord.js";
import { openAssistConversation, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { configureEntryChecks, launchable, moduleEntryRefusal } from "./entryChecks.js";
import { moduleItemReader } from "./moduleItemRead.js";
import type { ModuleHostLauncher } from "./runModule.js";
import { runModuleTests } from "./runModuleTests.js";

/**
 * A pipeline's `module` entry rules (EO-736, ARCHITECTURE.md, "Entry
 * rules"), run through the real module host at every door. The rules'
 * shape and ordering are held in `packages/engine/src/entryRules.test.ts`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const nothingStored = { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(""), decryptString: () => "" };

/**
 * The fixture the story asks for: refuses an item whose yes/no field
 * `no_reviewers` is true and whose pull request would target the forge's
 * default branch, read here from a binary it runs; and refuses when
 * either branch is unknown. The team's real module is theirs to write.
 *
 * The binary is Node under the forge's name, handed the script that
 * prints the branch: `ctx.exec` spawns with no shell, and Windows runs
 * no `#!` script without one.
 */
const noReviewers = (script: string) => `
export default async function check(ctx) {
  const { item } = ctx.item();
  if (item.spec.no_reviewers !== true) return { ok: true, result: "pass" };
  const target = item.git.targetBranch;
  const asked = await ctx.exec("forge-default-branch", [${JSON.stringify(script)}]);
  const defaultBranch = asked.code === 0 ? asked.stdout.trim() : "";
  if (!target || !defaultBranch) {
    return { ok: true, result: "refuse", reason: "the pull request's target or the forge's default branch could not be established" };
  }
  if (target === defaultBranch) {
    return { ok: true, result: "refuse", reason: "work with no reviewers may not target " + defaultBranch + ", the default branch." };
  }
  return { ok: true, result: "pass" };
}`;
let NO_REVIEWERS: string;

const CHECK_MANIFEST: ModuleManifest = {
  name: "No reviewers",
  description: "Keeps unreviewed work off the default branch.",
  inputs: {},
  needs: { bin: ["forge-default-branch"], env: [], network: true, item: true, comment: false, attach: false, create: false },
  results: ["pass", "refuse"],
  entryCheck: true,
};

let handle: DbHandle;
let bin: string;

/**
 * The branch a pull request would target, as the composition root hands
 * it in (`pullRequestTargetBranch`, the developer pack's, which a test
 * outside the pack may not import — invariant 13): the item's own base
 * branch, or its repository's.
 */
const targetBranch = async (item: Item): Promise<string | null> => {
  if (item.workspaceId === null) return null;
  const git = item.extensions["git"] as { baseBranch?: string | null } | undefined;
  return git?.baseBranch ?? getGitWorkspace(handle.db, item.workspaceId)?.config.baseBranch ?? null;
};
let savedPath: string | undefined;
let repo: string;

/** A copy of Node, made once, linked into each test's PATH under the forge binary's name. */
let node: string;
const forgeBinary = () => join(bin, process.platform === "win32" ? "forge-default-branch.exe" : "forge-default-branch");
const forgeScript = () => join(bin, "default-branch.cjs");

function defaultBranchIs(branch: string | null): void {
  writeFileSync(forgeScript(), branch === null ? "process.exit(1);\n" : `process.stdout.write(${JSON.stringify(`${branch}\n`)});\n`);
}

beforeAll(() => {
  node = join(mkdtempSync(join(tmpdir(), "eo-entry-node-")), "node");
  copyFileSync(process.execPath, node);
});

afterAll(() => rmSync(dirname(node), { recursive: true, force: true }));

function launcher(): ModuleHostLauncher {
  return {
    execPath: process.execPath,
    hostPath: join(here, "moduleHost.mjs"),
    hostEnv: { ELECTRON_RUN_AS_NODE: "1" },
    items: moduleItemReader(handle.db, { targetBranch }),
  };
}

function configure(): void {
  configureEntryChecks({
    launcher: launcher(),
    secrets: { directory: mkdtempSync(join(tmpdir(), "eo-entry-secrets-")), store: nothingStored },
    targetBranch,
  });
}

/** An approved module, saved as a person would and approved without running its tests — they are run on their own below. */
function module(code: string, manifest: Partial<ModuleManifest> = {}, slug = "no-reviewers"): string {
  const saved = saveModule(handle.db, { slug, name: manifest.name ?? CHECK_MANIFEST.name, description: "An entry check.", code, manifest: { ...CHECK_MANIFEST, ...manifest } });
  if (!saved.ok) throw new Error(saved.reason);
  approveModule(handle.db, saved.module.id);
  return saved.module.id;
}

function setRules(pipelineId: string, rules: EntryRule[]): void {
  handle.db.update(pipelines).set({ entryRules: rules }).where(eq(pipelines.id, pipelineId)).run();
}

/** A second pipeline with a step to arrive on. */
function intake(rules: EntryRule[], name = "Intake"): { pipelineId: string; stepId: string } {
  const pipeline = createPipeline(handle.db, { name, position: 9 });
  const step = createStep(handle.db, { pipelineId: pipeline.id as Uuid, position: 0, name: "Triage", type: "user" });
  createStep(handle.db, { pipelineId: pipeline.id as Uuid, position: 1, name: "Done", type: "user", isTerminal: true });
  setRules(pipeline.id, rules);
  handle.db.update(pipelines).set({ entryStepId: step.id }).where(eq(pipelines.id, pipeline.id)).run();
  return { pipelineId: pipeline.id, stepId: step.id };
}

const counters = () => handle.db.select().from(keyCounters).all();
const rows = () => handle.db.select().from(items).all();

let workspaceId: Uuid;

beforeEach(() => {
  handle = openMigratedTestDb();
  bin = mkdtempSync(join(tmpdir(), "eo-entry-bin-"));
  repo = mkdtempSync(join(tmpdir(), "eo-entry-repo-"));
  savedPath = process.env["PATH"];
  process.env["PATH"] = `${bin}${delimiter}${savedPath ?? ""}`;
  linkSync(node, forgeBinary());
  defaultBranchIs("main");
  NO_REVIEWERS = noReviewers(forgeScript());
  insertItemType(handle.db, null, {
    packSlug: "local",
    slug: "change",
    label: "Change",
    plural: "Changes",
    container: false,
    specShape: { type: "object", properties: { no_reviewers: { type: "boolean" } }, required: [] },
    actionOverrides: {},
  });
  workspaceId = attachWorkspace(handle.db, { name: "acme", keyPrefix: "ACME", repoPath: repo, baseBranch: "main" }).id as Uuid;
  configure();
});

afterEach(() => {
  configureEntryChecks(null);
  process.env["PATH"] = savedPath;
  handle.close();
  rmSync(bin, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

const REFUSED = '"Delivery" needs these before work can enter it: a pass from "No reviewers", which refused it: work with no reviewers may not target main, the default branch.';

/** `work_submit_item`'s payload for a change. */
function submission(noReviewers: boolean, extra: Partial<IpcPayload<"work:submitItem">> = {}): IpcPayload<"work:submitItem"> {
  return ipcContract["work:submitItem"].request.parse({ type: "change", title: "Hotfix", body: "Fix it.", spec: { no_reviewers: noReviewers }, pipeline: "Delivery", repository: "acme", ...extra });
}

describe("the fixture module", () => {
  it("passes its own cases against a scripted exec and ctx.entry", async () => {
    const theCase = (description: string, body: string) => ({
      id: description,
      description,
      source: `import assert from "node:assert/strict";\nexport default async function (harness) {\n${body}\n}`,
    });
    const run = await runModuleTests(launcher(), {
      module: { code: NO_REVIEWERS, manifest: CHECK_MANIFEST },
      tests: [
        theCase(
          "refuses unreviewed work aimed at the default branch",
          `const run = await harness.run({
             entry: { door: "creation", pipeline: { id: "p", name: "Delivery" }, fromStep: null },
             item: { id: null, key: null, spec: { no_reviewers: true }, git: { targetBranch: "main" } },
             exec: [{ bin: "forge-default-branch", stdout: "main\\n" }],
           });
           assert.equal(run.outcome.result, "refuse");
           assert.match(run.outcome.reason, /may not target main/);`,
        ),
        theCase(
          "refuses when the default branch cannot be read",
          `const run = await harness.run({ item: { spec: { no_reviewers: true }, git: { targetBranch: "main" } }, exec: [{ bin: "forge-default-branch", code: 1 }] });
           assert.equal(run.outcome.result, "refuse");
           assert.match(run.outcome.reason, /could not be established/);`,
        ),
        theCase(
          "refuses when the target is unknown",
          `const run = await harness.run({ item: { spec: { no_reviewers: true } }, exec: [{ bin: "forge-default-branch", stdout: "main" }] });
           assert.equal(run.outcome.result, "refuse");`,
        ),
        theCase(
          "passes another branch, and reviewed work",
          `assert.deepEqual((await harness.run({ item: { spec: { no_reviewers: true }, git: { targetBranch: "release" } }, exec: [{ bin: "forge-default-branch", stdout: "main" }] })).outcome, { ok: true, result: "pass", detail: "" });
           assert.deepEqual((await harness.run({ item: { spec: { no_reviewers: false } } })).outcome, { ok: true, result: "pass", detail: "" });`,
        ),
        theCase(
          "is told the door",
          `const run = await harness.run({ entry: { door: "move", pipeline: { id: "p", name: "Delivery" }, fromStep: { id: "s", name: "Build" } } });
           assert.equal(run.outcome.result, "pass");`,
        ),
      ],
    });
    expect(run.cases.map((each) => [each.description, each.passed, each.failure])).toEqual(run.cases.map((each) => [each.description, true, null]));
  });
});

describe("at creation", () => {
  beforeEach(() => setRules("default", [{ kind: "module", module: module(NO_REVIEWERS) }]));

  it("refuses work_submit_item with the module's reason, and writes nothing: no key, no row, no attachment", async () => {
    const before = counters();
    const answer = await submitItemCommand(handle.db, undefined, submission(true));
    expect(answer).toEqual({ created: false, key: null, problem: REFUSED });
    expect(rows()).toEqual([]);
    expect(handle.db.select().from(attachments).all()).toEqual([]);
    expect(counters()).toEqual(before);
  });

  it("lets in what the module passes", async () => {
    const answer = await submitItemCommand(handle.db, undefined, submission(false));
    expect(answer.created).toBe(true);
    expect(rows().map((row) => row.key)).toEqual([answer.key]);
  });

  it("refuses a plan whole, naming the story", async () => {
    const before = counters();
    const plan: IpcPayload<"work:submitPlan"> = {
      title: "A plan",
      understanding: "What we agreed, written down at length for whoever reads it next.",
      decisions: [{ topic: "Scope", decision: "All of it." }],
      pipeline: "Delivery",
      stories: [
        { title: "Reviewed", body: "Body", acceptance_criteria: ["It works"], depends_on: [], touches: [] },
        { title: "Unreviewed", body: "Body", acceptance_criteria: ["It works"], depends_on: [], touches: [] },
      ],
    } as unknown as IpcPayload<"work:submitPlan">;
    // Stories are the developer pack's: the module reads their spec, which
    // carries no flag, so both pass — until the module itself refuses.
    setRules("default", [{ kind: "module", module: module(`export default async function (ctx) { const { item } = ctx.item(); return item.title === "Unreviewed" ? { ok: true, result: "refuse", reason: "not this one" } : { ok: true, result: "pass" }; }`, {}, "picky") }]);

    const answer = await submitPlanCommand(handle.db, undefined, plan);

    expect(answer.created).toBe(false);
    expect(answer.problem).toContain('"Unreviewed" cannot enter');
    expect(answer.problem).toContain('a pass from "No reviewers", which refused it: not this one');
    expect(rows()).toEqual([]);
    expect(counters()).toEqual(before);
  });

  it("refuses an accepted assistant card, and files nothing", async () => {
    const conversation = openAssistConversation(handle.db, null);
    const agent = listAgents(handle.db).find((entry) => entry.role === "system")!;
    const output = { message: "Here it is.", questions: [], proposals: [{ action: "new_story", title: "Hotfix", body: "Fix.", acceptance_criteria: ["It works."], depends_on: [] }] } as unknown as DiscussionOutput;
    const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION });
    updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(output), parsed: output } });
    postAssistReply(handle.db, conversation, agent.id, run.id, output);
    const card = listCommentsForItem(handle.db, conversation.id).find((comment) => comment.kind === PROPOSAL_KIND)!;
    setRules("default", [{ kind: "module", module: module(`export default async function () { return { ok: true, result: "refuse", reason: "not today" }; }`, {}, "never") }]);

    const answer = await approveWorkProposalThroughRecord(handle.db, undefined, recordFor(handle.db), conversation, card.id as Uuid);

    expect(answer.applied).toBe(false);
    expect(answer.problem).toContain("which refused it: not today");
    expect(rows().map((row) => row.id)).toEqual([conversation.id]);
  });

  it("refuses a module's ctx.createItem, and the module is told why", async () => {
    const origin = createTestItem(handle.db, { type: "story", title: "Origin", stepId: null, pipelineId: null, workspaceId, projectId: projectForWorkspace(handle.db, workspaceId)!.id as Uuid });
    const creator = saveModule(handle.db, {
      slug: "filer",
      name: "Filer",
      description: "Files a change.",
      code: "export default async function () { return { ok: true, result: 'ok' }; }",
      manifest: { ...CHECK_MANIFEST, name: "Filer", needs: { ...CHECK_MANIFEST.needs, create: true }, results: ["ok"], entryCheck: false },
    });
    if (!creator.ok) throw new Error(creator.reason);
    const before = counters();

    const answer = await recordFor(handle.db).createItemFromModule({
      module: creator.module,
      item: origin,
      runId: null,
      creation: { idempotencyKey: "one", type: "change", title: "Hotfix", body: "Fix.", spec: { no_reviewers: true }, pipeline: "Delivery", repository: "acme" },
      atCap: false,
    });

    expect(answer).toEqual({ created: false, reason: REFUSED });
    expect(rows().map((row) => row.id)).toEqual([origin.id]);
    expect(counters()).toEqual(before);
  });
});

describe("what the module is given", () => {
  /** A module that answers with what it was handed, as its refusal. */
  const PROBE = `export default async function (ctx) {
    const { item } = ctx.item();
    return { ok: true, result: "refuse", reason: JSON.stringify({ entry: ctx.entry, id: item.id, key: item.key, title: item.title, pipeline: item.pipeline && item.pipeline.name, step: item.step && item.step.name, git: item.git, project: ctx.project && ctx.project.keyPrefix }) };
  }`;
  const shape = (problem: string | null): Record<string, unknown> => JSON.parse((problem ?? "").replace(/^.*refused it: /s, "").replace(/\.$/, "")) as Record<string, unknown>;

  it("on creation: no id or key, the destination, and the target branch", async () => {
    setRules("default", [{ kind: "module", module: module(PROBE, {}, "probe") }]);
    const answer = await submitItemCommand(handle.db, undefined, submission(true));
    const given = shape(answer.problem);
    expect(given).toMatchObject({
      entry: { door: "creation", pipeline: { id: "default", name: "Delivery" }, fromStep: null },
      id: null,
      key: null,
      title: "Hotfix",
      pipeline: "Delivery",
      git: { targetBranch: "main", baseBranch: null },
      project: "ACME",
    });
  });

  it("on a move: the item as it is, entering, and the step it came from", async () => {
    const to = intake([{ kind: "module", module: module(PROBE, {}, "probe") }]);
    const item = createTestItem(handle.db, { type: "change", title: "Moving", stepId: "todo", workspaceId });
    const answer = await moveItemChecked(handle.db, undefined, { itemId: item.id, toStepId: to.stepId, toPipelineId: to.pipelineId as Uuid, cancelActiveRun: false, comment: "" });
    expect(shape(answer.problem)).toMatchObject({
      entry: { door: "move", pipeline: { id: to.pipelineId, name: "Intake" }, fromStep: { id: "todo" } },
      id: item.id,
      key: item.key,
      pipeline: "Intake",
      step: "Triage",
    });
  });

  it("on a route, and from a job", async () => {
    const probe = module(PROBE, {}, "probe");
    const to = intake([{ kind: "module", module: probe }]);
    const item = createTestItem(handle.db, { type: "change", title: "Routed", stepId: "todo" });
    const routed = await moduleEntryRefusal(handle.db, { door: "route", item: { ...item, pipelineId: to.pipelineId as Uuid, stepId: to.stepId, pipelineVersionId: null }, creating: false, fromStepId: "todo" });
    expect(shape(routed)).toMatchObject({ entry: { door: "route", fromStep: { id: "todo" } }, id: item.id });

    setRules("default", [{ kind: "module", module: probe }]);
    const job = createJob(handle.db, { projectId: null, name: "Daily", trigger: { kind: "manual" }, pipelineId: "default", template: { type: "local:change", title: "Daily", body: "Do it." } });
    if (!job.ok) throw new Error(job.problem);
    const fired = await fireJobChecked(handle.db, job.job);
    expect(shape(fired.problem)).toMatchObject({ entry: { door: "job", fromStep: null }, id: null, key: null, title: "Daily" });
  });
});

describe("on a move by hand and a route", () => {
  it("refuses a move with the module's reason, before the active-run guard", async () => {
    const to = intake([{ kind: "module", module: module(NO_REVIEWERS) }]);
    const item = createTestItem(handle.db, { type: "change", title: "Moving", stepId: "todo", workspaceId, spec: { no_reviewers: true } });
    // Something is running on it: a refusal must come first, so it is not cancelled.
    createRun(handle.db, { itemId: item.id, agentId: listAgents(handle.db)[0]!.id, action: "implement" });

    const answer = await moveItemChecked(handle.db, undefined, { itemId: item.id, toStepId: to.stepId, toPipelineId: to.pipelineId as Uuid, cancelActiveRun: true, comment: "Going" });

    expect(answer).toMatchObject({ moved: false, blockedByActiveRun: false, cancelledRunId: null, problem: REFUSED.replace('"Delivery"', '"Intake"') });
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    expect(listRunsForItem(handle.db, item.id).map((run) => run.status)).toEqual(["queued"]);
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
  });

  it("lets a passing item move", async () => {
    const to = intake([{ kind: "module", module: module(NO_REVIEWERS) }]);
    const item = createTestItem(handle.db, { type: "change", title: "Moving", stepId: "todo", workspaceId, spec: { no_reviewers: false } });
    expect((await moveItemChecked(handle.db, undefined, { itemId: item.id, toStepId: to.stepId, toPipelineId: to.pipelineId as Uuid, cancelActiveRun: false, comment: "" })).moved).toBe(true);
  });

  it("refuses a person's decision on the button", async () => {
    const to = intake([{ kind: "module", module: module(NO_REVIEWERS) }]);
    const approve = createStep(handle.db, { pipelineId: "default" as Uuid, position: 40, name: "Approve", type: "user", results: [{ key: "ok", label: "OK", tone: "success", requiresComment: false }] });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: approve.id, resultKey: "ok", label: "OK", target: to.stepId });
    const item = createTestItem(handle.db, { type: "change", title: "Hotfix", stepId: approve.id, workspaceId, spec: { no_reviewers: true } });

    const answer = await decideItemChecked(handle.db, undefined, { itemId: item.id, resultKey: "ok", comment: "" });

    expect(answer).toMatchObject({ decided: false });
    expect(getItem(handle.db, item.id)?.stepId).toBe(approve.id);
  });

  it("parks a route out of a module step awaiting_input, and asks", async () => {
    const to = intake([{ kind: "module", module: module(NO_REVIEWERS) }]);
    const step = createStep(handle.db, { pipelineId: "default" as Uuid, position: 40, name: "Ship", type: "module", entryAction: "mod-1" });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: step.id, resultKey: "shipped", label: "Shipped", target: to.stepId });
    const item = createTestItem(handle.db, { type: "change", title: "Hotfix", stepId: step.id, workspaceId, spec: { no_reviewers: true } });
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: { start: () => { throw new Error("a module must not reach a provider"); } } as never,
      limits: { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 },
      builtins: {},
      moduleRunner: () => async () => ({ ok: true, result: "shipped", detail: "done" }),
    });

    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe(step.id);
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs.map((run) => run.status)).toEqual(["awaiting_input"]);
    expect(runs[0]?.error).toContain('"Intake" needs these before work can enter it: a pass from "No reviewers", which refused it');
    const asked = listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "escalation");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.body).toContain("may not target main");
  });
});

describe("a job", () => {
  const template = { type: "local:change", title: "Daily", body: "Do it." };

  it("is saved without running the module, and the save says so", async () => {
    setRules("default", [{ kind: "module", module: module(`export default async function () { throw new Error("must not run at save"); }`, {}, "loud") }]);
    const answer = await createJobCommand(handle.db, {} as never, { name: "Daily", trigger: { kind: "manual" }, pipelineId: "default", template });
    expect(answer.problem).toBeNull();
    expect(answer.notice).toContain("not run now because a job's template is not an item yet");
  });

  it("fails an occurrence it refuses, tells the owner, and fires again later", async () => {
    setRules("default", [{ kind: "module", module: module(`export default async function () { return { ok: true, result: "refuse", reason: "not on a Monday" }; }`, {}, "monday") }]);
    const job = createJob(handle.db, { projectId: null, name: "Daily", trigger: { kind: "manual" }, pipelineId: "default", template });
    if (!job.ok) throw new Error(job.problem);

    const first = await runJobNowChecked(handle.db, undefined, { jobId: job.job.id });
    const second = await runJobNowChecked(handle.db, undefined, { jobId: job.job.id });

    expect(first).toMatchObject({ fired: false });
    expect(first.problem).toContain("which refused it: not on a Monday");
    expect(listOccurrences(handle.db, job.job.id as Uuid).map((row) => row.status)).toEqual(["failed", "failed"]);
    expect(messagesAboutJob(handle.db, job.job.id).map((message) => message.body)).toEqual([
      expect.stringContaining("not on a Monday"),
      expect.stringContaining("not on a Monday"),
    ]);
    expect(second.problem).toContain("not on a Monday");
    expect(rows().filter((row) => row.title === "Daily")).toEqual([]);
  });

  it("files what the module passes", async () => {
    setRules("default", [{ kind: "module", module: module(NO_REVIEWERS) }]);
    const job = createJob(handle.db, { projectId: null, name: "Daily", trigger: { kind: "manual" }, pipelineId: "default", template });
    if (!job.ok) throw new Error(job.problem);
    expect((await runJobNowChecked(handle.db, undefined, { jobId: job.job.id })).fired).toBe(true);
  });

  it("refuses a firing nothing ran the module for, saying it cannot run there", () => {
    setRules("default", [{ kind: "module", module: module(NO_REVIEWERS) }]);
    const job = createJob(handle.db, { projectId: null, name: "Daily", trigger: { kind: "manual" }, pipelineId: "default", template });
    if (!job.ok) throw new Error(job.problem);
    expect(fireJob(handle.db, job.job).problem).toContain("cannot run where this item is arriving from");
  });
});

describe("fail closed", () => {
  let made = 0;
  const refusalFor = async (code: string, manifest: Partial<ModuleManifest> = {}, rule: Partial<EntryRule> = {}) => {
    made += 1;
    setRules("default", [{ kind: "module", module: module(code, manifest, `failing-${made}`), ...rule }]);
    const before = counters();
    const answer = await submitItemCommand(handle.db, undefined, submission(false));
    expect(answer.created).toBe(false);
    expect(rows()).toEqual([]);
    expect(counters()).toEqual(before);
    return answer.problem ?? "";
  };

  it("on a timeout", async () => {
    expect(await refusalFor(`export default async function () { await new Promise(() => setInterval(() => {}, 1000)); }`, {}, { timeoutMs: 500 })).toContain(
      'a pass from "No reviewers", which did not answer within 500ms',
    );
  }, 15_000);

  it("on a crash", async () => {
    expect(await refusalFor(`export default async function () { throw new Error("boom"); }`)).toMatch(/a pass from "No reviewers", which failed: Error: boom/);
  });

  it("on an answer that is neither pass nor refuse", async () => {
    expect(await refusalFor(`export default async function () { return { ok: true, result: "maybe" }; }`)).toContain('which answered "maybe", which is neither pass nor refuse');
    expect(await refusalFor(`export default async function () { return { ok: false, reason: "I give up" }; }`)).toContain("which failed: I give up");
  });

  it("on a module whose approval was withdrawn after the rule was published", async () => {
    const id = module(NO_REVIEWERS);
    setRules("default", [{ kind: "module", module: id }]);
    // An edit to the code takes the approval away.
    saveModule(handle.db, { id, slug: "no-reviewers", name: "No reviewers", description: "An entry check.", code: `${NO_REVIEWERS}\n// edited`, manifest: CHECK_MANIFEST });
    const answer = await submitItemCommand(handle.db, undefined, submission(false));
    expect(answer.problem).toBe('"Delivery" needs these before work can enter it: a pass from "No reviewers", which cannot run: it has not been approved.');
  });

  it("on a module that is missing, or not an entry check", async () => {
    setRules("default", [{ kind: "module", module: "gone" }]);
    expect((await submitItemCommand(handle.db, undefined, submission(false))).problem).toBe(
      '"Delivery" needs these before work can enter it: a pass from "gone", which cannot run: it is not a module this installation has.',
    );
    setRules("default", [{ kind: "module", module: module(NO_REVIEWERS, { entryCheck: false }, "plain") }]);
    expect((await submitItemCommand(handle.db, undefined, submission(false))).problem).toContain("which cannot run: it is not declared an entry check");
  });

  it("on a module that cannot run at that door", async () => {
    setRules("default", [{ kind: "module", module: module(NO_REVIEWERS) }]);
    configureEntryChecks(null);
    expect((await submitItemCommand(handle.db, undefined, submission(false))).problem).toBe(
      '"Delivery" needs these before work can enter it: a pass from "No reviewers", which cannot run here: EO here has no module host to run it on.',
    );
    configure();
    rmSync(forgeBinary());
    expect((await submitItemCommand(handle.db, undefined, submission(false))).problem).toContain("which cannot run here: forge-default-branch is not installed where this door is");
  });

  it("on a door that never asks", () => {
    setRules("default", [{ kind: "module", module: module(NO_REVIEWERS) }]);
    expect(() => createTestItem(handle.db, { type: "change", title: "Direct", stepId: "todo" })).toThrow(
      '"Delivery" needs these before work can enter it: a pass from "No reviewers", which cannot run where this item is arriving from: nothing here waits for a module.',
    );
  });
});

describe("a check whose rules or module change while it runs", () => {
  /**
   * Configures the host so that, the first time a check is under way,
   * `change` runs — a person publishing a rule or editing the module while
   * the subprocess is out.
   */
  function whileChecking(change: () => void): void {
    let done = false;
    configureEntryChecks({
      launcher: launcher(),
      secrets: { directory: mkdtempSync(join(tmpdir(), "eo-entry-secrets-")), store: nothingStored },
      targetBranch: async (item) => {
        if (!done) {
          done = true;
          change();
        }
        return targetBranch(item);
      },
    });
  }
  const refusing = () => module(`export default async function () { return { ok: true, result: "refuse", reason: "closed today" }; }`, { name: "Closed" }, "closed");
  const withdraw = (id: string) => saveModule(handle.db, { id, slug: "no-reviewers", name: "No reviewers", description: "An entry check.", code: `${NO_REVIEWERS}\n// edited`, manifest: CHECK_MANIFEST });
  const WITHDRAWN = '"Delivery" needs these before work can enter it: a pass from "No reviewers", which cannot run: it has not been approved.';

  it("creates nothing when a refusing rule is published while a passing check runs", async () => {
    const passing = module(NO_REVIEWERS);
    setRules("default", [{ kind: "module", module: passing }]);
    whileChecking(() => setRules("default", [{ kind: "module", module: passing }, { kind: "module", module: refusing() }]));
    const before = counters();
    const answer = await submitItemCommand(handle.db, undefined, submission(false));
    expect(answer).toEqual({ created: false, key: null, problem: '"Delivery" needs these before work can enter it: a pass from "Closed", which refused it: closed today.' });
    expect(rows()).toEqual([]);
    expect(counters()).toEqual(before);
  });

  it("creates nothing when the module's approval is withdrawn while it runs", async () => {
    const id = module(NO_REVIEWERS);
    setRules("default", [{ kind: "module", module: id }]);
    whileChecking(() => withdraw(id));
    const answer = await submitItemCommand(handle.db, undefined, submission(false));
    expect(answer.problem).toBe(WITHDRAWN);
    expect(rows()).toEqual([]);
  });

  it("moves nothing when the module's approval is withdrawn while it runs", async () => {
    const id = module(NO_REVIEWERS);
    const to = intake([{ kind: "module", module: id }]);
    const item = createTestItem(handle.db, { type: "change", title: "Moving", stepId: "todo", workspaceId, spec: { no_reviewers: false } });
    whileChecking(() => withdraw(id));
    const answer = await moveItemChecked(handle.db, undefined, { itemId: item.id, toStepId: to.stepId, toPipelineId: to.pipelineId as Uuid, cancelActiveRun: false, comment: "" });
    expect(answer).toMatchObject({ moved: false, problem: WITHDRAWN.replace('"Delivery"', '"Intake"') });
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("parks a route whose destination publishes a refusing rule while its check runs", async () => {
    const passing = module(NO_REVIEWERS);
    const to = intake([{ kind: "module", module: passing }]);
    const step = createStep(handle.db, { pipelineId: "default" as Uuid, position: 40, name: "Ship", type: "module", entryAction: "mod-1" });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: step.id, resultKey: "shipped", label: "Shipped", target: to.stepId });
    const item = createTestItem(handle.db, { type: "change", title: "Hotfix", stepId: step.id, workspaceId, spec: { no_reviewers: false } });
    whileChecking(() => setRules(to.pipelineId, [{ kind: "module", module: passing }, { kind: "module", module: refusing() }]));
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: { start: () => { throw new Error("a module must not reach a provider"); } } as never,
      limits: { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 },
      builtins: {},
      moduleRunner: () => async () => ({ ok: true, result: "shipped", detail: "done" }),
    });

    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe(step.id);
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs.map((run) => run.status)).toEqual(["awaiting_input"]);
    expect(runs[0]?.error).toContain('a pass from "Closed", which refused it: closed today');
  });

  const reviewersOff = (itemId: string) => () => handle.db.update(items).set({ spec: { no_reviewers: true } }).where(eq(items.id, itemId)).run();

  it("parks a route whose item is edited to fail the check while it runs", async () => {
    const to = intake([{ kind: "module", module: module(NO_REVIEWERS) }]);
    const step = createStep(handle.db, { pipelineId: "default" as Uuid, position: 40, name: "Ship", type: "module", entryAction: "mod-1" });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: step.id, resultKey: "shipped", label: "Shipped", target: to.stepId });
    const item = createTestItem(handle.db, { type: "change", title: "Hotfix", stepId: step.id, workspaceId, spec: { no_reviewers: false } });
    whileChecking(reviewersOff(item.id));
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: { start: () => { throw new Error("a module must not reach a provider"); } } as never,
      limits: { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 },
      builtins: {},
      moduleRunner: () => async () => ({ ok: true, result: "shipped", detail: "done" }),
    });

    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(getItem(handle.db, item.id)).toMatchObject({ stepId: step.id, pipelineId: "default" });
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs.map((run) => run.status)).toEqual(["awaiting_input"]);
    expect(runs[0]?.error).toContain("may not target main, the default branch");
  });

  describe("on the record", () => {
    /** A device's move into `to`, as the record is sent it, and what the record answers. */
    async function sendMove(item: Item, to: { pipelineId: string; stepId: string }) {
      const payload = ipcContract["record:apply"].request.parse({
        deviceId: "anna-laptop",
        commands: [{ kind: "transition", id: randomUUID(), transitionId: randomUUID(), itemId: item.id, fromStepId: "todo", toStepId: to.stepId, toPipelineId: to.pipelineId, actor: "human" }],
      });
      const record = createLocalRecord(handle.db);
      const answer = await serveApply({ db: handle.db, record, offerWork: async () => [] }, payload);
      return answer.results[0]!;
    }

    it("refuses a move whose item is edited to fail the check while it runs, and leaves it outside", async () => {
      const to = intake([{ kind: "module", module: module(NO_REVIEWERS) }]);
      const item = createTestItem(handle.db, { type: "change", title: "Moving", stepId: "todo", workspaceId, spec: { no_reviewers: false } });
      whileChecking(reviewersOff(item.id));

      const result = await sendMove(item, to);

      expect(result).toMatchObject({ applied: false, notPermitted: { why: "entryRules", sentence: REFUSED.replace('"Delivery"', '"Intake"') } });
      expect(getItem(handle.db, item.id)).toMatchObject({ stepId: "todo", pipelineId: "default" });
    });

    it("answers superseded to a move overtaken by another while its check runs, rather than writing over it", async () => {
      const to = intake([{ kind: "module", module: module(NO_REVIEWERS) }]);
      const item = createTestItem(handle.db, { type: "change", title: "Moving", stepId: "todo", workspaceId, spec: { no_reviewers: false } });
      whileChecking(() => recordFor(handle.db).applyTransition({ itemId: item.id, toStepId: "review", actor: "human" }));

      const result = await sendMove(item, to);

      expect(result).toMatchObject({ applied: false, superseded: { stepId: "review" } });
      expect(getItem(handle.db, item.id)).toMatchObject({ stepId: "review", pipelineId: "default" });
    });
  });

  it("fails a job's firing when a refusing rule is published while its check runs, and files nothing", async () => {
    const passing = module(NO_REVIEWERS);
    setRules("default", [{ kind: "module", module: passing }]);
    const job = createJob(handle.db, { projectId: null, name: "Daily", trigger: { kind: "manual" }, pipelineId: "default", template: { type: "local:change", title: "Daily", body: "Do it." } });
    if (!job.ok) throw new Error(job.problem);
    whileChecking(() => setRules("default", [{ kind: "module", module: passing }, { kind: "module", module: refusing() }]));
    const answer = await runJobNowChecked(handle.db, undefined, { jobId: job.job.id });
    expect(answer).toMatchObject({ fired: false });
    expect(answer.problem).toContain('a pass from "Closed", which refused it: closed today');
    expect(rows().filter((row) => row.title === "Daily")).toEqual([]);
  });

  it("refuses a firing whose verdicts were worked out under rules that have since changed", async () => {
    const passing = module(NO_REVIEWERS);
    setRules("default", [{ kind: "module", module: passing }]);
    const job = createJob(handle.db, { projectId: null, name: "Daily", trigger: { kind: "manual" }, pipelineId: "default", template: { type: "local:change", title: "Daily", body: "Do it." } });
    if (!job.ok) throw new Error(job.problem);
    const dueAt = Date.now();
    const entryVerdicts = await jobEntryVerdicts(handle.db, job.job, { dueAt });
    setRules("default", [{ kind: "module", module: passing, timeoutMs: 5_000 }]);
    const answer = fireJob(handle.db, job.job, { dueAt, entryVerdicts });
    expect(answer.problem).toBe('"Delivery" needs these before work can enter it: a pass from "No reviewers", which was asked under entry rules or a module that changed while it ran, so its answer no longer stands.');
    expect(rows().filter((row) => row.title === "Daily")).toEqual([]);
  });
});

describe("order and count", () => {
  /** A module that writes a line to a file each time it runs, and answers `result`. */
  const counting = (log: string, name: string, result: string) =>
    `import { appendFileSync } from "node:fs";\nexport default async function () { appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name + "\n")}); return { ok: true, result: ${JSON.stringify(result)}, reason: ${JSON.stringify(name + " said no")} }; }`;

  it("runs no module when the data rules already refuse", async () => {
    const log = join(bin, "runs.log");
    writeFileSync(log, "");
    setRules("default", [{ kind: "description" }, { kind: "module", module: module(counting(log, "a", "pass"), {}, "a") }]);
    const answer = await submitItemCommand(handle.db, undefined, submission(false, { body: " " }));
    expect(answer.problem).toBe('"Delivery" needs these before work can enter it: a description.');
    expect((await import("node:fs")).readFileSync(log, "utf8")).toBe("");
  });

  it("runs a module named twice once, and different ones in order, stopping at the first refusal", async () => {
    const log = join(bin, "runs.log");
    writeFileSync(log, "");
    const a = module(counting(log, "a", "pass"), { name: "A" }, "a");
    const b = module(counting(log, "b", "refuse"), { name: "B" }, "b");
    const c = module(counting(log, "c", "pass"), { name: "C" }, "c");
    setRules("default", [
      { kind: "module", module: a },
      { kind: "module", module: a, message: "A again" },
      { kind: "module", module: b },
      { kind: "module", module: c },
    ]);
    const answer = await submitItemCommand(handle.db, undefined, submission(false));
    expect(answer.problem).toBe('"Delivery" needs these before work can enter it: a pass from "B", which refused it: b said no.');
    expect((await import("node:fs")).readFileSync(log, "utf8")).toBe("a\nb\n");
  });

  it("runs once per story of a plan that passes, and files the whole plan", async () => {
    const log = join(bin, "runs.log");
    writeFileSync(log, "");
    setRules("default", [{ kind: "module", module: module(counting(log, "story", "pass"), {}, "story-check") }]);
    const answer = await submitPlanCommand(handle.db, undefined, {
      title: "A plan",
      understanding: "What we agreed, written down at length for whoever reads it next.",
      decisions: [{ topic: "Scope", decision: "All of it." }],
      pipeline: "Delivery",
      stories: [
        { title: "One", body: "Body", acceptance_criteria: ["It works"], depends_on: [], touches: [] },
        { title: "Two", body: "Body", acceptance_criteria: ["It works"], depends_on: [], touches: [] },
      ],
    } as unknown as IpcPayload<"work:submitPlan">);
    expect(answer.problem).toBeNull();
    expect(answer.storyKeys).toHaveLength(2);
    expect((await import("node:fs")).readFileSync(log, "utf8")).toBe("story\nstory\n");
  });

  it("skips a rehearsal", () => {
    setRules("default", [{ kind: "module", module: "gone" }]);
    expect(createTestItem(handle.db, { type: "change", title: "Trial", stepId: "todo", trialAt: 1 }).title).toBe("Trial");
    expect(createTestItem(handle.db, { type: "change", title: "Preview", stepId: "todo", previewAt: 1 }).title).toBe("Preview");
  });
});

describe("publishing a module rule", () => {
  const save = (rules: EntryRule[]) => {
    const view = listPipelineStepViews(handle.db, { pipelineId: "default" });
    return savePipeline(handle.db, undefined, { pipelineId: "default", steps: view.steps, routes: view.routes, entryStepId: view.entryStepId, entryRules: rules });
  };
  const messages = (answer: ReturnType<typeof save>) => answer.problems.filter((problem) => problem.severity === "error").map((problem) => problem.message);

  it("is refused for a module missing, unapproved or not an entry check, naming it and why", () => {
    const unapproved = saveModule(handle.db, { slug: "draft", name: "Draft check", description: "x", code: "export default async () => ({ ok: true, result: 'pass' })", manifest: CHECK_MANIFEST });
    if (!unapproved.ok) throw new Error(unapproved.reason);
    const plain = module(NO_REVIEWERS, { name: "Plain", entryCheck: false }, "plain");
    expect(messages(save([{ kind: "module", module: "gone" }]))).toContain('The entry rule runs "gone", which is not a module this installation has.');
    expect(messages(save([{ kind: "module", module: unapproved.module.id }]))).toContain('The entry rule runs "Draft check" v1, which has not been approved.');
    expect(messages(save([{ kind: "module", module: plain }]))).toContain('The entry rule runs "Plain" v1, which is not declared an entry check (entryCheck: true in its manifest).');
  });

  it("is saved and frozen into the version when the module is fit", () => {
    const answer = save([{ kind: "module", module: module(NO_REVIEWERS), message: "a reviewer or another branch", timeoutMs: 5000 }]);
    expect(messages(answer)).toEqual([]);
    expect(answer.saved).toBe(true);
  });

  it("is refused where this installation could not run it", () => {
    const id = module(NO_REVIEWERS);
    configureEntryChecks(null);
    expect(messages(save([{ kind: "module", module: id }]))).toContain('The entry rule runs "No reviewers", which this record cannot run: EO here has no module host to run it on.');
    configure();
    rmSync(forgeBinary());
    expect(messages(save([{ kind: "module", module: id }]))).toContain('The entry rule runs "No reviewers", which this record cannot run: forge-default-branch is not installed here.');
  });

  // A file of the binary's name is not enough: `ctx.exec` spawns with no
  // shell, so the save has to refuse what that spawn could not start,
  // and nothing is published.
  const NOT_RUNNABLE = 'The entry rule runs "No reviewers", which this record cannot run: forge-default-branch is not installed here.';

  it.skipIf(process.platform === "win32")("is refused where the binary is a file without its execute bit, or a directory", () => {
    const id = module(NO_REVIEWERS);
    rmSync(forgeBinary());
    writeFileSync(forgeBinary(), "#!/bin/sh\necho main\n", { mode: 0o644 });
    const answer = save([{ kind: "module", module: id }]);
    expect(messages(answer)).toContain(NOT_RUNNABLE);
    expect(answer.saved).toBe(false);
    rmSync(forgeBinary());
    mkdirSync(forgeBinary());
    expect(messages(save([{ kind: "module", module: id }]))).toContain(NOT_RUNNABLE);
  });

  it.runIf(process.platform === "win32")("is refused where the binary is a .cmd or .bat script", () => {
    const id = module(NO_REVIEWERS);
    rmSync(forgeBinary());
    for (const script of ["forge-default-branch.cmd", "forge-default-branch.bat"]) {
      writeFileSync(join(bin, script), "@echo main\r\n");
      const answer = save([{ kind: "module", module: id }]);
      expect(messages(answer)).toContain(NOT_RUNNABLE);
      expect(answer.saved).toBe(false);
      rmSync(join(bin, script));
    }
  });
});

describe("versions and files", () => {
  const save = (rules: EntryRule[]) => {
    const view = listPipelineStepViews(handle.db, { pipelineId: "default" });
    const answer = savePipeline(handle.db, undefined, { pipelineId: "default", steps: view.steps, routes: view.routes, entryStepId: view.entryStepId, entryRules: rules });
    expect(answer.problems.filter((problem) => problem.severity === "error")).toEqual([]);
  };

  it("freezes a module rule into the version and lists it on the diff, by name and limit", () => {
    const id = module(NO_REVIEWERS);
    save([]);
    const before = listPipelineVersions(handle.db, "default").at(-1)!;
    save([{ kind: "module", module: id, timeoutMs: 5000 }]);

    const versions = pipelineVersionsCommand(handle.db, { pipelineId: "default", graph: before.number });
    // Pinned to the module's newest approved version (EO-770), and the diff names it.
    expect(versions.diff?.entryRules).toEqual({ before: "none", after: 'a pass from "No reviewers" v1, within 5 seconds' });
    expect(versions.graph?.entryRules).toEqual([]);
    const now = pipelineVersionsCommand(handle.db, { pipelineId: "default", graph: before.number + 1 });
    expect(now.graph?.entryRules).toEqual([{ kind: "module", module: id, moduleVersion: 1, timeoutMs: 5000 }]);
  });

  it("lists each rule as a line for the pipeline's details, a module rule by name and limit", () => {
    const id = module(NO_REVIEWERS);
    setRules("default", [{ kind: "description" }, { kind: "jira_key" }, { kind: "module", module: id, timeoutMs: 5000, types: ["local:change"] }]);
    expect(listPipelineStepViews(handle.db, { pipelineId: "default" }).entryRuleLines).toEqual([
      "a description",
      "a Jira key",
      'a pass from "No reviewers", within 5 seconds (local:change)',
    ]);
  });

  it("carries the rule out by slug with its module, at the next format, and back to an id on the way in", () => {
    const id = module(NO_REVIEWERS);
    setRules("default", [{ kind: "module", module: id, message: "a reviewer or another branch" }]);
    const built = exportPipeline(handle.db, "default");
    if (!built.ok) throw new Error(built.reason);
    expect(built.document.eoPipelineExport).toBeGreaterThanOrEqual(12);
    expect(built.document.pipeline.entryRules).toEqual([{ kind: "module", module: "no-reviewers", message: "a reviewer or another branch" }]);
    expect(built.document.modules.map((each) => each.slug)).toContain("no-reviewers");

    // Into an installation that already has it, reusing it.
    const reused = importPipeline(handle.db, { document: built.document, choices: { "no-reviewers": "reuse" } });
    if (!reused.ok) throw new Error(reused.reason);
    // Pinned on the way in (EO-770): the document carries no version.
    expect(getPipeline(handle.db, reused.pipelineId)?.entryRules).toEqual([{ kind: "module", module: id, moduleVersion: 1, message: "a reviewer or another branch" }]);

    // Imported alongside it, the rule follows the copy it brought.
    const copied = importPipeline(handle.db, { document: built.document, choices: { "no-reviewers": "import" } });
    if (!copied.ok) throw new Error(copied.reason);
    const [rule] = getPipeline(handle.db, copied.pipelineId)?.entryRules ?? [];
    expect(rule?.module).not.toBe(id);
    expect(rule?.module).toBe(copied.createdModuleIds[0]);
  });

  it("refuses, by name, an import whose rule names a module neither it nor this installation has", () => {
    const built = exportPipeline(handle.db, "default");
    if (!built.ok) throw new Error(built.reason);
    const refused = importPipeline(handle.db, { document: { ...built.document, pipeline: { ...built.document.pipeline, entryRules: [{ kind: "module", module: "elsewhere" }] } } });
    expect(refused).toEqual({ ok: false, reason: 'An entry rule runs the module "elsewhere", which this document does not carry and this installation does not have.' });
    expect(getModuleBySlug(handle.db, "elsewhere")).toBeUndefined();
  });

  it("still reads a format-11 document", () => {
    const built = exportPipeline(handle.db, "default");
    if (!built.ok) throw new Error(built.reason);
    const parsed = parseExport(JSON.stringify({ ...built.document, eoPipelineExport: 11, pipeline: { ...built.document.pipeline, entryRules: [{ kind: "description" }] } }));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(importPipeline(handle.db, { document: parsed.document }).ok).toBe(true);
  });
});

describe("approving an entry check", () => {
  const unapproved = (needs: Partial<ModuleManifest["needs"]>, extra: Partial<ModuleManifest> = {}) => {
    const saved = saveModule(handle.db, { slug: "check", name: "Check", description: "x", code: NO_REVIEWERS, manifest: { ...CHECK_MANIFEST, ...extra, needs: { ...CHECK_MANIFEST.needs, ...needs } } });
    if (!saved.ok) throw new Error(saved.reason);
    return saved.module.id;
  };
  const neverRun = { run: () => Promise.reject(new Error("its tests must not run")) };

  it("is refused for one that would create, comment, attach or reach outside EO, before its tests run", async () => {
    const answer = await approveModuleCommand(handle.db, neverRun, { id: unapproved({ create: true, comment: true }, { sideEffects: true }), acknowledgeLowCoverage: false });
    expect(answer.approved).toBe(false);
    expect(answer.problem).toBe(
      '"Check" was not approved: An entry check only reads, so it may not declare needs.create. An entry check only reads, so it may not declare needs.comment. ' +
        "An entry check only reads, so it may not declare sideEffects. Remove them from its manifest, or stop declaring it an entry check.",
    );
  });

  it("goes on to its tests for one that only reads — the network, binaries, variables and secrets", async () => {
    const id = unapproved({ env: ["GITLAB_TOKEN"], network: true });
    // Past the entry-check gate, to the rule every module meets: it has no tests yet.
    expect((await approveModuleCommand(handle.db, neverRun, { id, acknowledgeLowCoverage: false })).problem).toContain("has no tests");
  });
});

describe("whether ctx.exec could start a binary", () => {
  const files = (...paths: string[]) => (candidate: string) => paths.includes(candidate);
  const windows = (bin: string, ...paths: string[]) => launchable(bin, { directories: ["C:\\tools", "D:\\bin"], platform: "win32", runnable: files(...paths) });
  const posixLaunchable = (bin: string, ...paths: string[]) => launchable(bin, { directories: ["/usr/bin", "/opt/bin"], platform: "linux", runnable: files(...paths) });

  it("on Windows, finds a program by .exe or .com on any directory searched", () => {
    expect(windows("gh", "D:\\bin\\gh.exe")).toBe(true);
    expect(windows("gh", "C:\\tools\\gh.com")).toBe(true);
    expect(windows("gh.exe", "C:\\tools\\gh.exe")).toBe(true);
  });

  it("on Windows, does not count a .cmd or .bat script, which Node will not spawn without a shell", () => {
    expect(windows("gh", "C:\\tools\\gh.cmd", "D:\\bin\\gh.bat", "C:\\tools\\gh")).toBe(false);
    expect(windows("gh.cmd", "C:\\tools\\gh.cmd")).toBe(false);
    expect(windows("gh.BAT", "C:\\tools\\gh.BAT")).toBe(false);
  });

  it("elsewhere, finds the name itself, and takes a path as written", () => {
    expect(posixLaunchable("gh", "/opt/bin/gh")).toBe(true);
    expect(posixLaunchable("gh", "/opt/bin/gh.exe")).toBe(false);
    expect(posixLaunchable("/usr/local/bin/gh", "/usr/local/bin/gh")).toBe(true);
    expect(posixLaunchable("/usr/local/bin/gh", "/usr/bin/gh")).toBe(false);
  });
});

/**
 * The version a module rule pins (EO-770): the door runs that version's
 * code and is gated on that version's approval, whatever the module has
 * been edited to since.
 */
describe("the version a module rule pins", () => {
  const answers = (result: string, reason = "") => `export default async function () { return { ok: true, result: ${JSON.stringify(result)}, reason: ${JSON.stringify(reason)} }; }`;

  it("runs the pinned version's code at the door", async () => {
    const id = module(answers("pass"), {}, "pinned-check");
    // v2 refuses everything and is approved; v3 is an edit nobody approved.
    const edit = (code: string, approve: boolean) => {
      const saved = saveModule(handle.db, { id, slug: "pinned-check", name: CHECK_MANIFEST.name, description: "An entry check.", code, manifest: CHECK_MANIFEST, approve });
      if (!saved.ok) throw new Error(saved.reason);
    };
    edit(answers("refuse", "v2 says no"), true);
    edit(answers("refuse", "v3 says no"), false);

    setRules("default", [{ kind: "module", module: id, moduleVersion: 1 }]);
    expect(await submitItemCommand(handle.db, undefined, submission(false))).toMatchObject({ created: true });

    setRules("default", [{ kind: "module", module: id, moduleVersion: 2 }]);
    expect((await submitItemCommand(handle.db, undefined, submission(false))).problem).toBe(
      '"Delivery" needs these before work can enter it: a pass from "No reviewers", which refused it: v2 says no.',
    );

    setRules("default", [{ kind: "module", module: id, moduleVersion: 3 }]);
    expect((await submitItemCommand(handle.db, undefined, submission(false))).problem).toBe(
      '"Delivery" needs these before work can enter it: a pass from "No reviewers", which cannot run: its v3 has not been approved.',
    );

    setRules("default", [{ kind: "module", module: id, moduleVersion: 7 }]);
    expect((await submitItemCommand(handle.db, undefined, submission(false))).problem).toBe(
      '"Delivery" needs these before work can enter it: a pass from "No reviewers", which cannot run: the v7 it pins is not kept any more.',
    );
  });
});
