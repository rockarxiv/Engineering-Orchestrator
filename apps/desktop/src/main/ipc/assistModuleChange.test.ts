import {
  AssistOutputSchema,
  ModuleManifestSchema,
  SECTION_LOCKED_CHANNELS,
  developerRegistry,
  pageDescriptorFor,
  validateActionResult,
  type AssistReply,
  type CustomModule,
  type IpcChannel,
  type Item,
  type ModuleChange,
  type ModuleManifest,
  type Uuid,
} from "@eo/core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { markReplica } from "../db/recordRole.js";
import {
  approveModule,
  archiveModule,
  createRun,
  deleteModuleTest,
  getItem,
  getModule,
  getModuleTest,
  getModuleVersion,
  listCommentsForItem,
  listModuleTests,
  listModuleVersions,
  publishSection,
  saveModule,
  saveModuleTest,
  updateRun,
} from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { sectionLockFor } from "../managed/locks.js";
import { createModuleTestRunner, type ModuleTestRunner } from "../modules/moduleTestRunner.js";
import type { ModuleHostLauncher } from "../modules/runModule.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { applyModuleChange, changeBaseOf, drawModuleChange } from "../roles/moduleChange.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { applyAssistModuleChangeCommand, approveAssistProposal, openAssist, sendToAssist } from "./assistCommands.js";
import { clearPublishedView } from "./currentView.js";
import { approveModuleCommand } from "./moduleCommands.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "./registry.js";
import { applyScenarioChangeCommand, openScenario } from "./scenarioCommands.js";

/**
 * Changing a module that exists, from the help chat (EO-418).
 *
 * The case this exists for: somebody in the help chat said "just change
 * it instead of making a new one" about an approved module, and the only
 * answer the assistant had was a walk to Settings → Modules. Now the
 * reply carries the change, the chat shows it as a diff of the code and
 * of the manifest, and nothing is written until Apply is pressed.
 *
 * Asserted against the rows, because "nothing is saved until Apply" is a
 * claim about the catalog and not about what a card says.
 */

const here = dirname(fileURLToPath(import.meta.url));
const launcher: ModuleHostLauncher = { execPath: process.execPath, hostPath: join(here, "..", "modules", "moduleHost.mjs"), hostEnv: { ELECTRON_RUN_AS_NODE: "1" } };

/** A deploy module that asks for two environment variables it does not need — the case that prompted this. */
const MANIFEST: ModuleManifest = ModuleManifestSchema.parse({
  name: "Deploy",
  description: "Deploys the release.",
  inputs: { stage: { type: "string", default: "prod" } },
  needs: { bin: ["aws"], env: ["AWS_PROFILE", "AWS_REGION", "DEPLOY_TOKEN"], network: true },
  results: ["deployed"],
});

/** The same manifest without the two names. */
const TRIMMED: ModuleManifest = { ...MANIFEST, needs: { ...MANIFEST.needs, env: ["DEPLOY_TOKEN"] } };

const DEPLOY = `export default async function (ctx) {
  const stage = ctx.inputs.stage;
  const done = await ctx.exec("aws", ["deploy", stage]);
  if (done.code !== 0) return { ok: false, reason: "deploy failed" };
  return { ok: true, result: "deployed" };
}`;

/** The fix: the reason says what the deploy printed. */
const FIXED = DEPLOY.replace('reason: "deploy failed"', 'reason: "deploy failed: " + done.tail');

const DEPLOYS = `import assert from "node:assert/strict";
export default async function (harness) {
  const run = await harness.run({ exec: [{ bin: "aws", args: ["deploy", "prod"], code: 0 }] });
  assert.deepEqual(run.outcome, { ok: true, result: "deployed", detail: "" });
}`;

/** A case that holds the module to something it does not do. */
const EXPECTS_A_RETRY = `import assert from "node:assert/strict";
export default async function (harness) {
  const run = await harness.run({ exec: [{ bin: "aws", args: ["deploy", "prod"], code: 1 }] });
  assert.equal(run.outcome.ok, true, "expected a failed deploy to be retried");
}`;

let handle: DbHandle;
/** What Apply asked to be re-run. */
const runner = { schedule: vi.fn() };

beforeEach(() => {
  handle = openMigratedTestDb();
  runner.schedule.mockClear();
});

afterEach(() => {
  clearHandlerRegistry();
  clearPublishedView();
  handle.close();
});

function saveDeploy(options: { approved?: boolean; source?: CustomModule["source"] } = {}): CustomModule {
  const saved = saveModule(handle.db, {
    slug: "deploy",
    name: "Deploy",
    description: "Deploys the release.",
    code: DEPLOY,
    manifest: MANIFEST,
    source: options.source ?? "user",
  });
  if (!saved.ok) throw new Error(saved.reason);
  const test = saveModuleTest(handle.db, { moduleId: saved.module.id, description: "deploys to prod", source: DEPLOYS });
  if (!test.ok) throw new Error(test.reason);
  // Approved after its case, since adding one withdraws an approval (EO-498).
  if (options.approved ?? true) approveModule(handle.db, saved.module.id);
  return getModule(handle.db, saved.module.id)!;
}

/** The help chat, after somebody has said something in it from Settings. */
async function chat(body = "Just change it instead of making a new one."): Promise<Item> {
  const view = await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/settings"), conversationId: null, body, attachmentIds: [], interrupt: false });
  return getItem(handle.db, view.conversation.id as Uuid)!;
}

/** A succeeded `assist` run carrying `output`, and what it posted. */
function turn(conversation: Item, output: AssistReply): { cardIds: Uuid[]; rejections: string[] } {
  const parsed = AssistOutputSchema.parse(output);
  const agent = assistAgent(handle.db)!;
  const initiationId = listCommentsForItem(handle.db, conversation.id)
    .filter((comment) => comment.authorType === "human" && comment.parentId === null)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .at(-1)!.id;
  const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION, initiationId });
  // Stored as the agent wrote it, which is how a card posted by an older build reads back.
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(output), parsed: output } });
  postAssistReply(handle.db, conversation, agent.id, run.id, parsed);
  const posted = listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.runId === run.id);
  return {
    cardIds: posted.filter((comment) => comment.kind === PROPOSAL_KIND).map((comment) => comment.id),
    rejections: posted.filter((comment) => comment.kind === "rejection").map((comment) => comment.body),
  };
}

function change(moduleId: string, overrides: Partial<NonNullable<AssistReply["change"]>> = {}): AssistReply {
  return { message: "Here is the change.", change: { moduleId, summary: "Says what the deploy printed.", code: FIXED, ...overrides } };
}

function messageOf(id: string) {
  return openAssist(handle.db).conversation.messages.find((message) => message.id === id)!;
}

function apply(conversation: Item, messageId: string) {
  return applyAssistModuleChangeCommand(handle.db, undefined, runner, { conversationId: conversation.id, messageId });
}

/** Everything about a module a change may write, as the rows hold it. */
function rows(moduleId: string) {
  const module = getModule(handle.db, moduleId)!;
  return {
    code: module.code,
    manifest: module.manifest,
    approvedAt: module.approvedAt,
    slug: module.slug,
    source: module.source,
    tests: listModuleTests(handle.db, moduleId).map((test) => [test.description, test.source]),
    versions: listModuleVersions(handle.db, moduleId).length,
  };
}

describe("a reply carrying a change to an existing module", () => {
  it("posts a card with a diff of the code and of the manifest against what is saved, and writes nothing", async () => {
    const deploy = saveDeploy();
    const before = rows(deploy.id);
    const conversation = await chat();

    const { cardIds, rejections } = turn(
      conversation,
      change(deploy.id, { manifest: TRIMMED, tests: [{ description: "retries a failed deploy", source: EXPECTS_A_RETRY }] }),
    );

    expect(rejections).toEqual([]);
    expect(cardIds).toHaveLength(1);
    const card = messageOf(cardIds[0]!);
    expect(card.body).toContain("**Proposed change to Deploy** (`deploy`)");
    expect(card.body).toContain("Says what the deploy printed.");
    // The code, as a diff.
    expect(card.body).toContain('-  if (done.code !== 0) return { ok: false, reason: "deploy failed" };');
    expect(card.body).toContain('+  if (done.code !== 0) return { ok: false, reason: "deploy failed: " + done.tail };');
    // The manifest, as a diff: the two names are the two removed lines.
    expect(card.body).toContain('-      "AWS_PROFILE",');
    expect(card.body).toContain('-      "AWS_REGION",');
    expect(card.body).toContain('"DEPLOY_TOKEN"');
    // The cases it adds, and what Apply will do — losing the approval included.
    expect(card.body).toContain("- Adds “retries a failed deploy”");
    expect(card.body).toContain("Nothing is saved until you apply it.");
    expect(card.body).toContain("withdraws the module's approval, so steps that run Deploy stop until it is approved again");

    expect(card).toMatchObject({ canApprove: true, approves: "moduleChange", moduleSlug: null, moduleChange: { moduleId: deploy.id, applied: false, describesSaved: false } });
    // And nothing was written: code, manifest, approval, cases and history are as they were.
    expect(rows(deploy.id)).toEqual(before);
    expect(before.approvedAt).not.toBeNull();
  });

  it("is not a work proposal: assist:approve refuses it and says which button applies it", async () => {
    const deploy = saveDeploy();
    const conversation = await chat();
    const { cardIds } = turn(conversation, change(deploy.id));

    const answer = approveAssistProposal(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });

    expect(answer.applied).toBe(false);
    expect(answer.problem).toContain("change to a module");
    expect(rows(deploy.id).code).toBe(DEPLOY);
    // Refusing it there did not spend the card.
    expect(messageOf(cardIds[0]!).canApprove).toBe(true);
  });

  it("keeps a work proposal from the same turn a work proposal", async () => {
    const deploy = saveDeploy();
    const conversation = await chat();

    const { cardIds } = turn(conversation, {
      ...change(deploy.id),
      proposals: [
        {
          action: "new_feature",
          title: "Rate limiting",
          understanding: "Cap what one key can do per minute.",
          decisions: [],
          stories: [{ title: "Count requests", body: "Per key, per minute.", acceptance_criteria: ["counts are per key"], depends_on: [], touches: [] }],
        },
      ],
    });

    expect(cardIds).toHaveLength(2);
    expect(messageOf(cardIds[0]!)).toMatchObject({ approves: "items", moduleChange: null });
    expect(messageOf(cardIds[1]!)).toMatchObject({ approves: "moduleChange", proposal: null });
  });
});

describe("pressing Apply", () => {
  it("saves the code and manifest onto that module, files a version, withdraws approval, re-runs its tests and says so under the card", async () => {
    const deploy = saveDeploy();
    const before = rows(deploy.id);
    const conversation = await chat();
    const { cardIds } = turn(conversation, change(deploy.id, { manifest: TRIMMED }));

    const applied = apply(conversation, cardIds[0]!);

    expect(applied).toMatchObject({ applied: true, problem: null });
    const after = rows(deploy.id);
    expect(after.code).toBe(FIXED);
    expect(after.manifest).toEqual(TRIMMED);
    expect(after.approvedAt).toBeNull();
    // Its slug and who wrote it are as they were.
    expect(after).toMatchObject({ slug: "deploy", source: "user" });
    // A version was filed, and the code it had is in its history.
    expect(after.versions).toBe(before.versions + 1);
    const history = listModuleVersions(handle.db, deploy.id);
    const earlier = history.find((version) => !version.current)!;
    expect(getModuleVersion(handle.db, deploy.id, earlier.number)?.code).toBe(DEPLOY);
    // Its tests are re-run against what was saved.
    expect(runner.schedule).toHaveBeenCalledWith(deploy.id);

    // Said under the card: what was saved, and that approval was withdrawn.
    const under = applied.conversation.messages.find((message) => message.parentId === cardIds[0]);
    expect(under).toMatchObject({ kind: "approval" });
    expect(under!.body).toContain("Deploy's code and manifest are saved");
    expect(under!.body).toContain("Its approval is withdrawn");
    // The card is spent as a thing to apply, and is now a thing to approve from.
    expect(messageOf(cardIds[0]!)).toMatchObject({ canApprove: false, approves: null, moduleChange: { moduleId: deploy.id, applied: true, describesSaved: true } });
  });

  for (const source of ["architect", "user", "import"] as const) {
    for (const approved of [true, false]) {
      it(`works on a module that is ${approved ? "approved" : "not approved"} and whose source is ${source}`, async () => {
        const deploy = saveDeploy({ approved, source });
        const conversation = await chat();
        const { cardIds, rejections } = turn(conversation, change(deploy.id));
        expect(rejections).toEqual([]);

        const applied = apply(conversation, cardIds[0]!);

        expect(applied.applied).toBe(true);
        expect(rows(deploy.id)).toMatchObject({ code: FIXED, manifest: MANIFEST, approvedAt: null, slug: "deploy", source });
        const under = applied.conversation.messages.find((message) => message.parentId === cardIds[0])!;
        expect(under.body).toContain("Deploy's code is saved");
        expect(under.body).toContain(approved ? "Its approval is withdrawn" : "It was not approved before, and is not now.");
      });
    }
  }

  it("applies a change to the manifest alone, shown as a diff, and withdraws approval", async () => {
    const deploy = saveDeploy();
    const conversation = await chat("Drop AWS_PROFILE and AWS_REGION from what it needs.");

    const { cardIds, rejections } = turn(conversation, change(deploy.id, { summary: "Stops asking for two variables it never reads.", code: DEPLOY, manifest: TRIMMED }));

    expect(rejections).toEqual([]);
    const card = messageOf(cardIds[0]!);
    expect(card.body).toContain("_The code is left as it is._");
    expect(card.body).toContain("```diff");
    expect(card.body).toContain('-      "AWS_PROFILE",');
    expect(card.body).toContain('-      "AWS_REGION",');
    expect(rows(deploy.id).manifest).toEqual(MANIFEST);

    const applied = apply(conversation, cardIds[0]!);

    expect(applied.applied).toBe(true);
    const after = rows(deploy.id);
    // The saved manifest is the card's, and it is what a run will enforce.
    expect(after.manifest).toEqual(TRIMMED);
    expect((after.manifest as ModuleManifest).needs.env).toEqual(["DEPLOY_TOKEN"]);
    expect(after.code).toBe(DEPLOY);
    expect(after.approvedAt).toBeNull();
    const under = applied.conversation.messages.find((message) => message.parentId === cardIds[0])!;
    expect(under.body).toContain("Deploy's manifest is saved");
    expect(under.body).toContain("Its approval is withdrawn");
  });

  it("leaves the manifest as it is when the change carries none", async () => {
    const deploy = saveDeploy();
    const conversation = await chat();
    const { cardIds } = turn(conversation, change(deploy.id, { manifest: null }));

    expect(messageOf(cardIds[0]!).body).toContain("_The manifest is left as it is._");
    expect(apply(conversation, cardIds[0]!).applied).toBe(true);
    expect(rows(deploy.id)).toMatchObject({ code: FIXED, manifest: MANIFEST });
  });

  it("does not read a manifest restated in another key order as a change to it", async () => {
    const deploy = saveDeploy();
    const conversation = await chat();
    const reordered = { results: MANIFEST.results, needs: MANIFEST.needs, inputs: MANIFEST.inputs, description: MANIFEST.description, name: MANIFEST.name };

    const { cardIds } = turn(conversation, change(deploy.id, { manifest: reordered }));

    expect(messageOf(cardIds[0]!).body).toContain("_The manifest is left as it is._");
  });

  it("writes the listed test cases in the same save: a description it has is replaced, a new one added, the rest kept", async () => {
    const deploy = saveDeploy({ approved: false });
    saveModuleTest(handle.db, { moduleId: deploy.id, description: "leaves staging alone", source: "export default async function () {}" });
    const corrected = DEPLOYS.replace('"prod"], code: 0', '"prod"], code: 0, stdout: "ok"');
    const conversation = await chat();

    const { cardIds } = turn(
      conversation,
      change(deploy.id, {
        tests: [
          { description: "deploys to prod", source: corrected },
          { description: "retries a failed deploy", source: EXPECTS_A_RETRY },
        ],
      }),
    );

    const card = messageOf(cardIds[0]!);
    expect(card.body).toContain("- Replaces “deploys to prod”");
    expect(card.body).toContain("- Adds “retries a failed deploy”");
    // None is written before Apply.
    expect(rows(deploy.id).tests).toEqual([
      ["deploys to prod", DEPLOYS],
      ["leaves staging alone", "export default async function () {}"],
    ]);

    const applied = apply(conversation, cardIds[0]!);

    expect(applied.applied).toBe(true);
    const after = rows(deploy.id);
    expect(after.code).toBe(FIXED);
    expect(after.tests).toHaveLength(3);
    expect(after.tests).toContainEqual(["deploys to prod", corrected]);
    expect(after.tests).toContainEqual(["retries a failed deploy", EXPECTS_A_RETRY]);
    expect(after.tests).toContainEqual(["leaves staging alone", "export default async function () {}"]);
    expect(applied.conversation.messages.find((message) => message.parentId === cardIds[0])!.body).toContain("2 test cases");
  });

  // EO-498: a change to an approved module's cases alone withdraws its approval, and the card says so on both sides of Apply.
  const corrected = DEPLOYS.replace('"prod"], code: 0', '"prod"], code: 0, stdout: "ok"');
  for (const [what, test, line] of [
    ["adding", { description: "retries a failed deploy", source: EXPECTS_A_RETRY }, "- Adds “retries a failed deploy”"],
    ["replacing", { description: "deploys to prod", source: corrected }, "- Replaces “deploys to prod”"],
  ] as const) {
    it(`withdraws an approved module's approval for a change that is only ${what} a case, says so before Apply, and offers Approve after`, async () => {
      const deploy = saveDeploy();
      expect(deploy.approvedAt).not.toBeNull();
      const conversation = await chat();

      const { cardIds, rejections } = turn(conversation, change(deploy.id, { code: DEPLOY, manifest: null, tests: [test] }));

      expect(rejections).toEqual([]);
      const card = messageOf(cardIds[0]!);
      expect(card.body).toContain("_The code is left as it is._");
      expect(card.body).toContain(line);
      expect(card.body).toContain("Applying saves the test cases above");
      expect(card.body).toContain("withdraws the module's approval, so steps that run Deploy stop until it is approved again");
      expect(rows(deploy.id).approvedAt).not.toBeNull();

      const applied = apply(conversation, cardIds[0]!);

      expect(applied).toMatchObject({ applied: true, problem: null });
      expect(rows(deploy.id)).toMatchObject({ code: DEPLOY, approvedAt: null });
      const under = applied.conversation.messages.find((message) => message.parentId === cardIds[0])!;
      expect(under.body).toContain("1 test case is saved");
      expect(under.body).toContain("Its approval is withdrawn");
      expect(under.body).not.toContain("Its approval stands");
      // What the card draws Approve from: applied, still describing the catalog's module, which is now unapproved.
      expect(messageOf(cardIds[0]!)).toMatchObject({ canApprove: false, moduleChange: { moduleId: deploy.id, applied: true, describesSaved: true } });
      // And the current version no longer reads as approved.
      expect(listModuleVersions(handle.db, deploy.id)[0]).toMatchObject({ current: true, approved: false });
    });
  }

  it("reports approvalWithdrawn from the module as it stands after its cases are written", () => {
    const deploy = saveDeploy();
    const applied = applyModuleChange(handle.db, deploy, { summary: "Adds a case.", code: DEPLOY, manifest: null }, changeBaseOf(deploy), {
      tests: [{ description: "retries a failed deploy", source: EXPECTS_A_RETRY }],
    });
    expect(applied).toMatchObject({ ok: true, wasApproved: true, approvalWithdrawn: true, module: { approvedAt: null }, saved: { code: false, manifest: false, tests: 1 } });
  });

  it("says nothing of withdrawing before Apply over a module that is not approved, for a change only to its cases", async () => {
    const deploy = saveDeploy({ approved: false });
    const conversation = await chat();
    const { cardIds } = turn(conversation, change(deploy.id, { code: DEPLOY, manifest: null, tests: [{ description: "retries a failed deploy", source: EXPECTS_A_RETRY }] }));
    const card = messageOf(cardIds[0]!);
    expect(card.body).not.toContain("withdraws the module's approval");
    expect(card.body).toContain("It is not approved now, and stays that way until you approve it.");
  });
});

describe("approving where the change was applied", () => {
  it("runs the module's tests through the approval path Settings uses, naming each failing case when it refuses", async () => {
    const real = createModuleTestRunner({ db: handle.db, launcher });
    try {
      const deploy = saveDeploy();
      const conversation = await chat();
      const { cardIds } = turn(conversation, change(deploy.id, { tests: [{ description: "retries a failed deploy", source: EXPECTS_A_RETRY }] }));
      expect(apply(conversation, cardIds[0]!).applied).toBe(true);
      // The card now offers Approve: applied, unapproved, and still what the catalog holds.
      expect(messageOf(cardIds[0]!).moduleChange).toEqual({ moduleId: deploy.id, applied: true, describesSaved: true });
      expect(getModule(handle.db, deploy.id)?.approvedAt).toBeNull();

      // What the card's Approve calls: `modules:approve`, the catalog's own.
      const refused = await approveModuleCommand(handle.db, real, { id: deploy.id, acknowledgeLowCoverage: true });

      expect(refused.approved).toBe(false);
      expect(refused.problem).toContain("1 of 2 test cases failed");
      expect(refused.problem).toContain("- retries a failed deploy");
      expect(getModule(handle.db, deploy.id)?.approvedAt).toBeNull();
    } finally {
      real.dispose();
    }
  });

  it("approves it when every case passes, and the card reads as approved from the catalog", async () => {
    const real = createModuleTestRunner({ db: handle.db, launcher });
    try {
      const deploy = saveDeploy();
      const conversation = await chat();
      const { cardIds } = turn(conversation, change(deploy.id));
      expect(apply(conversation, cardIds[0]!).applied).toBe(true);

      const approved = await approveModuleCommand(handle.db, real, { id: deploy.id, acknowledgeLowCoverage: true });

      expect(approved).toMatchObject({ approved: true, problem: null });
      expect(getModule(handle.db, deploy.id)).toMatchObject({ code: FIXED });
      expect(getModule(handle.db, deploy.id)?.approvedAt).not.toBeNull();
      expect(messageOf(cardIds[0]!).moduleChange).toEqual({ moduleId: deploy.id, applied: true, describesSaved: true });
    } finally {
      real.dispose();
    }
  });

  it("stops describing the module once it has been changed again", async () => {
    const deploy = saveDeploy();
    const conversation = await chat();
    const { cardIds } = turn(conversation, change(deploy.id));
    expect(apply(conversation, cardIds[0]!).applied).toBe(true);

    saveModule(handle.db, { id: deploy.id, slug: "deploy", name: "Deploy", description: "Deploys the release.", code: `${FIXED}\n// edited`, manifest: MANIFEST });

    // Approve here would approve code this card never showed.
    expect(messageOf(cardIds[0]!).moduleChange).toEqual({ moduleId: deploy.id, applied: true, describesSaved: false });
  });
});

describe("Apply is refused, with the reason and nothing written", () => {
  it("when the card has been superseded by a newer one", async () => {
    const deploy = saveDeploy();
    const before = rows(deploy.id);
    const conversation = await chat();
    const first = turn(conversation, change(deploy.id));
    await chat("Make the reason shorter.");
    const second = turn(getItem(handle.db, conversation.id)!, change(deploy.id, { code: FIXED.replace("deploy failed: ", "failed: ") }));

    const applied = apply(conversation, first.cardIds[0]!);

    expect(applied.applied).toBe(false);
    expect(applied.problem).toContain("superseded or already applied");
    expect(rows(deploy.id)).toEqual(before);
    expect(runner.schedule).not.toHaveBeenCalled();
    // The newer card is the one that applies.
    expect(messageOf(first.cardIds[0]!).canApprove).toBe(false);
    expect(apply(conversation, second.cardIds[0]!).applied).toBe(true);
  });

  it("when it has already been applied", async () => {
    const deploy = saveDeploy();
    const conversation = await chat();
    const { cardIds } = turn(conversation, change(deploy.id));
    expect(apply(conversation, cardIds[0]!).applied).toBe(true);
    const once = rows(deploy.id);
    runner.schedule.mockClear();

    const again = apply(conversation, cardIds[0]!);

    expect(again.applied).toBe(false);
    expect(again.problem).toContain("superseded or already applied");
    expect(rows(deploy.id)).toEqual(once);
    expect(runner.schedule).not.toHaveBeenCalled();
  });

  it("when the module has been deleted", async () => {
    const deploy = saveDeploy();
    const conversation = await chat();
    const { cardIds } = turn(conversation, change(deploy.id));
    archiveModule(handle.db, deploy.id);
    const before = rows(deploy.id);

    const applied = apply(conversation, cardIds[0]!);

    expect(applied.applied).toBe(false);
    expect(applied.problem).toContain("has been deleted");
    expect(rows(deploy.id)).toEqual(before);
    // Under the card, as a rejection (invariant 8).
    const under = applied.conversation.messages.find((message) => message.parentId === cardIds[0])!;
    expect(under).toMatchObject({ kind: "rejection" });
    expect(under.body).toContain("Not applied. Deploy has been deleted");
    expect(runner.schedule).not.toHaveBeenCalled();
  });

  it("when the module's code has changed since the card was drawn", async () => {
    const deploy = saveDeploy();
    const conversation = await chat();
    const { cardIds } = turn(conversation, change(deploy.id));
    const edited = `${DEPLOY}\n// edited in Settings`;
    saveModule(handle.db, { id: deploy.id, slug: "deploy", name: "Deploy", description: "Deploys the release.", code: edited, manifest: MANIFEST });
    const before = rows(deploy.id);

    const applied = apply(conversation, cardIds[0]!);

    expect(applied.applied).toBe(false);
    expect(applied.problem).toContain("Deploy's code has changed since this was proposed");
    expect(rows(deploy.id)).toEqual(before);
    expect(applied.conversation.messages.find((message) => message.parentId === cardIds[0])).toMatchObject({ kind: "rejection" });
  });

  it("when the module's manifest has changed since the card was drawn", async () => {
    const deploy = saveDeploy();
    const conversation = await chat();
    // A change to the code alone: the manifest still must not have moved under it.
    const { cardIds } = turn(conversation, change(deploy.id));
    saveModule(handle.db, { id: deploy.id, slug: "deploy", name: "Deploy", description: "Deploys the release.", code: DEPLOY, manifest: { ...MANIFEST, results: ["deployed", "skipped"] } });
    const before = rows(deploy.id);

    const applied = apply(conversation, cardIds[0]!);

    expect(applied.applied).toBe(false);
    expect(applied.problem).toContain("Deploy's manifest has changed since this was proposed");
    expect(rows(deploy.id)).toEqual(before);
  });
});

describe("a change there is nothing to apply from", () => {
  it("is posted as a rejection when it is the module as it is already saved", async () => {
    const deploy = saveDeploy();
    const before = rows(deploy.id);
    const conversation = await chat();

    const { cardIds, rejections } = turn(
      conversation,
      change(deploy.id, { code: DEPLOY, manifest: MANIFEST, tests: [{ description: "deploys to prod", source: DEPLOYS }] }),
    );

    expect(cardIds).toEqual([]);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toContain("is the module as it is already saved");
    expect(rows(deploy.id)).toEqual(before);
  });

  it("is posted as a rejection when it names a module the catalog does not hold", async () => {
    saveDeploy();
    const conversation = await chat();

    const { cardIds, rejections } = turn(conversation, change("no-such-module"));

    expect(cardIds).toEqual([]);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toContain("the catalog holds no module with that id");
  });

  it("is posted as a rejection when the module it names has been deleted", async () => {
    const deploy = saveDeploy();
    archiveModule(handle.db, deploy.id);
    const conversation = await chat();

    const { cardIds, rejections } = turn(conversation, change(deploy.id));

    expect(cardIds).toEqual([]);
    expect(rejections[0]).toContain("the catalog holds no module with that id");
  });

  // Decided on EO-418: a manifest that fails validation fails the reply
  // at EO's own boundary — `validateActionResult`, where the supervisor
  // checks every result — so the turn is sent back to the agent with the
  // reason, and nothing is posted and nothing offers Apply.
  const NAMELESS = Object.fromEntries(Object.entries(MANIFEST).filter(([key]) => key !== "name"));
  const BROKEN: [string, unknown, string][] = [
    ["declares no result", { ...MANIFEST, results: [] }, "change.manifest.results"],
    ["has no name", NAMELESS, "change.manifest.name"],
    ["gives its results as a sentence", { ...MANIFEST, results: "deployed" }, "change.manifest.results"],
    ["gives its needs as a word", { ...MANIFEST, needs: "aws" }, "change.manifest.needs"],
    // Nested values, which a schema that only named the fields would let through.
    ["names an environment variable that is not a name", { ...MANIFEST, needs: { ...MANIFEST.needs, env: ["DEPLOY-TOKEN"] } }, "change.manifest.needs.env.0"],
    ["declares an input of a type no input has", { ...MANIFEST, inputs: { stage: { type: "date" } } }, "change.manifest.inputs.stage.type"],
    ["declares an input that is a bare string", { ...MANIFEST, inputs: { stage: "prod" } }, "change.manifest.inputs.stage"],
    ["is not an object", "the same as before, without the two variables", "change.manifest"],
  ];
  for (const [what, broken, where] of BROKEN) {
    it(`is refused at EO's validation of the reply, naming the field, when its manifest ${what}`, async () => {
      const deploy = saveDeploy();
      const before = rows(deploy.id);
      const conversation = await chat();
      const said = listCommentsForItem(handle.db, conversation.id).length;
      const reply = change(deploy.id, { manifest: broken as never });

      const validated = validateActionResult(developerRegistry(), "assist", reply);

      expect(validated.ok).toBe(false);
      expect(!validated.ok && validated.error).toContain(where);
      // And a result that failed is not one a reply is posted from: no card, no rejection, nothing written.
      const agent = assistAgent(handle.db)!;
      const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION, initiationId: null });
      expect(postAssistReply(handle.db, conversation, agent.id, run.id, reply)).toEqual({ modulesSaved: false });
      expect(listCommentsForItem(handle.db, conversation.id)).toHaveLength(said);
      expect(openAssist(handle.db).conversation.messages.some((message) => message.canApprove || message.moduleChange)).toBe(false);
      expect(rows(deploy.id)).toEqual(before);
    });
  }

  it("passes that validation with a valid manifest, and with none", () => {
    const registry = developerRegistry();
    expect(validateActionResult(registry, "assist", change("some-module", { manifest: TRIMMED })).ok).toBe(true);
    expect(validateActionResult(registry, "assist", change("some-module", { manifest: null })).ok).toBe(true);
    expect(validateActionResult(registry, "assist", change("some-module")).ok).toBe(true);
  });

  // The second line, for a result that reached these by some other road:
  // the card is not drawn from an invalid manifest, and Apply does not save one.
  it("is not drawn as a card and is never saved, even past the reply's schema", () => {
    const deploy = saveDeploy();
    const before = rows(deploy.id);
    const module = getModule(handle.db, deploy.id)!;
    const invalid = { summary: "Gives its results as a sentence.", code: FIXED, manifest: { ...MANIFEST, results: "deployed" } } as unknown as ModuleChange;

    const drawn = drawModuleChange(handle.db, module, invalid);
    expect(drawn.ok).toBe(false);
    expect(!drawn.ok && drawn.reason).toContain("the manifest it carries is not a valid manifest");
    expect(!drawn.ok && drawn.reason).toContain("`results`");
    const applied = applyModuleChange(handle.db, module, invalid, changeBaseOf(module));

    expect(applied.ok).toBe(false);
    expect(!applied.ok && applied.reason).toContain("not a valid manifest");
    expect(rows(deploy.id)).toEqual(before);
  });
});

describe("proposing in `modules` over a module that is not the assistant's to replace", () => {
  const PROPOSED = {
    name: "Deploy",
    slug: "deploy",
    description: "Deploys the release.",
    code: FIXED,
    manifest: MANIFEST,
    why: "A deploy is a script.",
    tests: [{ description: "deploys to prod", source: DEPLOYS }],
  };

  for (const held of [
    { approved: true, source: "architect" },
    { approved: false, source: "user" },
    { approved: false, source: "import" },
  ] as const) {
    it(`is still refused with nothing written, naming the change route (${held.approved ? "approved" : "not approved"}, ${held.source})`, async () => {
      const deploy = saveDeploy(held);
      const before = rows(deploy.id);
      const conversation = await chat();

      const { cardIds, rejections } = turn(conversation, { message: "Here.", modules: [PROPOSED] });

      expect(cardIds).toEqual([]);
      expect(rejections).toHaveLength(1);
      expect(rejections[0]).toContain("already holds with different code or a different manifest");
      // Where to go instead: the change route, by this module's id.
      expect(rejections[0]).toContain("return `change` with `moduleId`");
      expect(rejections[0]).toContain(deploy.id);
      expect(rejections[0]).not.toContain("Settings → Modules");
      expect(rows(deploy.id)).toEqual(before);
    });
  }
});

describe("with the pipelines section managed by an organisation", () => {
  let stopBeingAReplica: (() => void) | null = null;
  const opts = { exposeErrorDetails: true, sectionLock: (channel: IpcChannel) => sectionLockFor(handle.db, channel) };

  afterEach(() => {
    stopBeingAReplica?.();
    stopBeingAReplica = null;
  });

  function managed(): void {
    publishSection(handle.db, {
      section: "pipelines",
      subjectId: "default",
      versionId: "a-version",
      versionNumber: 6,
      publishedAt: Date.now(),
      publishedBy: "dana-id",
      publishedByName: "Dana",
    });
    stopBeingAReplica = markReplica(handle.db, () => true);
  }

  it("lists both apply channels among the ones the pipelines lock refuses", () => {
    expect(SECTION_LOCKED_CHANNELS.pipelines).toContain("assist:applyChange");
    expect(SECTION_LOCKED_CHANNELS.pipelines).toContain("scenario:apply");
  });

  it("refuses Apply in the help chat naming the section, and writes nothing", async () => {
    const deploy = saveDeploy();
    const conversation = await chat();
    const { cardIds } = turn(conversation, change(deploy.id, { manifest: TRIMMED }));
    const before = rows(deploy.id);
    registerHandler("assist:applyChange", (payload) => applyAssistModuleChangeCommand(handle.db, undefined, runner, payload), opts);
    managed();

    const answer = await dispatchIpc("assist:applyChange", { conversationId: conversation.id, messageId: cardIds[0]! });

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.error.code).toBe("section-locked");
    expect(answer.error.lock).toEqual({ locked: true, section: "pipelines", publishedBy: "Dana" });
    expect(rows(deploy.id)).toEqual(before);
    expect(runner.schedule).not.toHaveBeenCalled();
    // Refused before the handler, so nothing was filed under the card and it is not spent.
    expect(listCommentsForItem(handle.db, conversation.id).some((comment) => comment.parentId === cardIds[0])).toBe(false);
  });

  it("refuses Apply in the scenario chat naming the section, and writes nothing", async () => {
    const deploy = saveDeploy();
    const before = rows(deploy.id);
    const opened = openScenario(handle.db, { moduleId: deploy.id }).conversation;
    registerHandler("scenario:apply", (payload) => applyScenarioChangeCommand(handle.db, undefined, runner as unknown as ModuleTestRunner, payload), opts);
    managed();

    const answer = await dispatchIpc("scenario:apply", { conversationId: opened.id, messageId: "any-card" });

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.error.code).toBe("section-locked");
    expect(answer.error.lock).toEqual({ locked: true, section: "pipelines", publishedBy: "Dana" });
    expect(rows(deploy.id)).toEqual(before);
  });
});

/**
 * Removing test cases through the card (EO-499): by the id
 * `module_tests_list` gives, drawn as "Removes …", deleted in Apply's own
 * transaction, and refused when the case has moved on since the card.
 */
describe("a change that removes test cases", () => {
  /** A second case beside "deploys to prod", which a change can remove without leaving the module with none. */
  const RETURNS_THE_RESULT = DEPLOYS.replace("deploys", "returns the result");

  /** Deploy with "deploys to prod" and the cases given, approved after them unless asked otherwise. */
  function saveDeployWith(cases: { description: string; source: string }[], approved = true): { module: CustomModule; ids: Record<string, string> } {
    const deploy = saveDeploy({ approved: false });
    for (const each of cases) {
      const saved = saveModuleTest(handle.db, { moduleId: deploy.id, ...each });
      if (!saved.ok) throw new Error(saved.reason);
    }
    if (approved) approveModule(handle.db, deploy.id);
    const ids = Object.fromEntries(listModuleTests(handle.db, deploy.id).map((test) => [test.description, test.id]));
    return { module: getModule(handle.db, deploy.id)!, ids };
  }

  /** A change of removals alone: the code exactly as saved, no manifest, no cases to write. */
  function removals(moduleId: string, removeTests: string[]): AssistReply {
    return change(moduleId, { summary: "Drops a case that no longer applies.", code: DEPLOY, manifest: null, tests: [], removeTests });
  }

  it("is offered as a card listing each removed case, warning on an approved module that applying withdraws its approval, and writes nothing", async () => {
    const { module: deploy, ids } = saveDeployWith([{ description: "returns the result", source: RETURNS_THE_RESULT }]);
    const before = rows(deploy.id);
    const conversation = await chat("Drop the 'returns the result' case.");

    const { cardIds, rejections } = turn(conversation, removals(deploy.id, [ids["returns the result"]!]));

    expect(rejections).toEqual([]);
    expect(cardIds).toHaveLength(1);
    const card = messageOf(cardIds[0]!);
    expect(card.body).toContain("_The code is left as it is._");
    expect(card.body).toContain("_The manifest is left as it is._");
    expect(card.body).toContain("**Test cases**");
    expect(card.body).toContain("- Removes “returns the result”");
    expect(card.body).not.toContain("“deploys to prod”");
    expect(card.body).toContain("withdraws the module's approval, so steps that run Deploy stop until it is approved again");
    expect(card.moduleChange).toEqual({ moduleId: deploy.id, applied: false, describesSaved: true });
    expect(rows(deploy.id)).toEqual(before);
  });

  it("says nothing of withdrawing over a module that is not approved", async () => {
    const { module: deploy, ids } = saveDeployWith([{ description: "returns the result", source: RETURNS_THE_RESULT }], false);
    const conversation = await chat();
    const { cardIds } = turn(conversation, removals(deploy.id, [ids["returns the result"]!]));
    const card = messageOf(cardIds[0]!);
    expect(card.body).toContain("- Removes “returns the result”");
    expect(card.body).not.toContain("withdraws the module's approval");
    expect(card.body).toContain("It is not approved now, and stays that way until you approve it.");
  });

  it("is posted as a rejection, with nothing saved, when it names a case id the module does not hold", async () => {
    const { module: deploy } = saveDeployWith([{ description: "returns the result", source: RETURNS_THE_RESULT }]);
    // A case of another module is not one of this module's.
    const other = saveModule(handle.db, { slug: "tag", name: "Tag", description: "Tags.", code: DEPLOY, manifest: MANIFEST, source: "user" });
    if (!other.ok) throw new Error(other.reason);
    const theirs = saveModuleTest(handle.db, { moduleId: other.module.id, description: "tags", source: DEPLOYS });
    if (!theirs.ok) throw new Error(theirs.reason);
    const before = rows(deploy.id);
    const conversation = await chat();

    for (const id of ["no-such-case", theirs.test.id]) {
      const { cardIds, rejections } = turn(conversation, removals(deploy.id, [id]));
      expect(cardIds).toEqual([]);
      expect(rejections).toHaveLength(1);
      expect(rejections[0]).toContain("it removes a test case Deploy does not hold");
      expect(rejections[0]).toContain(`\`${id}\``);
      expect(rejections[0]).toContain("Nothing was saved.");
    }
    expect(rows(deploy.id)).toEqual(before);
    expect(listModuleTests(handle.db, other.module.id)).toHaveLength(1);
  });

  it("is posted as a rejection when it would leave the module with no test cases, saying it could not be approved again", async () => {
    const { module: deploy, ids } = saveDeployWith([{ description: "returns the result", source: RETURNS_THE_RESULT }]);
    const before = rows(deploy.id);
    const conversation = await chat();

    const { cardIds, rejections } = turn(conversation, removals(deploy.id, [ids["deploys to prod"]!, ids["returns the result"]!]));

    expect(cardIds).toEqual([]);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toContain("removes every test case the module has and adds none");
    expect(rejections[0]).toContain("could not be approved again");
    expect(rows(deploy.id)).toEqual(before);

    // Removing every case is a card when the change adds the one that takes their place.
    const replaced = turn(
      conversation,
      change(deploy.id, { code: DEPLOY, manifest: null, tests: [{ description: "deploys to staging", source: DEPLOYS }], removeTests: [ids["deploys to prod"]!, ids["returns the result"]!] }),
    );
    expect(replaced.rejections).toEqual([]);
    expect(replaced.cardIds).toHaveLength(1);
  });

  it("is posted as a rejection when it changes only the code or the manifest of a module that already has no test cases", async () => {
    const deploy = saveDeploy({ approved: false });
    for (const test of listModuleTests(handle.db, deploy.id)) deleteModuleTest(handle.db, test.id);
    const before = rows(deploy.id);
    expect(before.tests).toEqual([]);
    const conversation = await chat();

    for (const overrides of [{ manifest: null }, { code: DEPLOY, manifest: TRIMMED }]) {
      const { cardIds, rejections } = turn(conversation, change(deploy.id, overrides));
      expect(cardIds).toEqual([]);
      expect(rejections).toHaveLength(1);
      expect(rejections[0]).toContain("Deploy has no test cases and it adds none");
      expect(rejections[0]).toContain("could not be approved again");
      expect(rejections[0]).toContain("Nothing was saved.");
    }
    expect(rows(deploy.id)).toEqual(before);

    // The same change with a case for it is a card.
    const withCase = turn(conversation, change(deploy.id, { tests: [{ description: "deploys to prod", source: DEPLOYS }] }));
    expect(withCase.rejections).toEqual([]);
    expect(withCase.cardIds).toHaveLength(1);
  });

  it("refuses Apply, writing nothing, when the module's last case was deleted after the card was drawn, though the card removes none", async () => {
    const deploy = saveDeploy();
    const conversation = await chat();
    const { cardIds } = turn(conversation, change(deploy.id));
    for (const test of listModuleTests(handle.db, deploy.id)) deleteModuleTest(handle.db, test.id);
    const before = rows(deploy.id);

    const applied = apply(conversation, cardIds[0]!);

    expect(applied.applied).toBe(false);
    expect(applied.problem).toContain("Applying this would leave Deploy with no test cases");
    expect(applied.problem).toContain("could not be approved again");
    expect(rows(deploy.id)).toEqual(before);
  });

  it("leaves the scenario chat's change, which does not ask it, to a module with no cases", () => {
    const deploy = saveDeploy({ approved: false });
    for (const test of listModuleTests(handle.db, deploy.id)) deleteModuleTest(handle.db, test.id);
    expect(drawModuleChange(handle.db, getModule(handle.db, deploy.id), { summary: "Fixes it.", code: FIXED, manifest: null })).toMatchObject({ ok: true });
  });

  it("deletes the listed cases on Apply in the same write as the code, the manifest and the cases it adds or replaces", async () => {
    const { module: deploy, ids } = saveDeployWith([
      { description: "returns the result", source: RETURNS_THE_RESULT },
      { description: "retries a failed deploy", source: EXPECTS_A_RETRY },
    ]);
    const before = rows(deploy.id);
    const conversation = await chat();
    const { cardIds, rejections } = turn(
      conversation,
      change(deploy.id, {
        manifest: TRIMMED,
        tests: [
          { description: "deploys to prod", source: `${DEPLOYS}\n// tightened` },
          { description: "deploys to staging", source: DEPLOYS },
        ],
        removeTests: [ids["retries a failed deploy"]!],
      }),
    );
    expect(rejections).toEqual([]);
    const card = messageOf(cardIds[0]!);
    expect(card.body).toContain("- Replaces “deploys to prod”");
    expect(card.body).toContain("- Adds “deploys to staging”");
    expect(card.body).toContain("- Removes “retries a failed deploy”");

    const applied = apply(conversation, cardIds[0]!);

    expect(applied).toMatchObject({ applied: true, problem: null });
    const after = rows(deploy.id);
    expect(after).toMatchObject({ code: FIXED, manifest: TRIMMED, approvedAt: null, versions: before.versions + 1 });
    expect(after.tests).toEqual([
      ["deploys to prod", `${DEPLOYS}\n// tightened`],
      ["returns the result", RETURNS_THE_RESULT],
      ["deploys to staging", DEPLOYS],
    ]);
    const under = applied.conversation.messages.find((message) => message.parentId === cardIds[0])!;
    expect(under.body).toContain("Deploy's code, manifest and 2 test cases are saved, 1 test case is removed");
    expect(under.body).toContain("Its approval is withdrawn");
  });

  it("applies removals alone: the case is gone, approval withdrawn, and the card offers Approve", async () => {
    const { module: deploy, ids } = saveDeployWith([{ description: "returns the result", source: RETURNS_THE_RESULT }]);
    const conversation = await chat();
    const { cardIds } = turn(conversation, removals(deploy.id, [ids["returns the result"]!]));

    const applied = apply(conversation, cardIds[0]!);

    expect(applied).toMatchObject({ applied: true, problem: null });
    expect(rows(deploy.id)).toMatchObject({ code: DEPLOY, manifest: MANIFEST, approvedAt: null, tests: [["deploys to prod", DEPLOYS]] });
    const under = applied.conversation.messages.find((message) => message.parentId === cardIds[0])!;
    expect(under.body).toContain("Applied. 1 test case is removed from Deploy, and its tests are re-running.");
    expect(under.body).toContain("Its approval is withdrawn");
    expect(runner.schedule).toHaveBeenCalledWith(deploy.id);
    // "Applied · not approved" with Approve: applied, still what the catalog holds, and unapproved.
    expect(messageOf(cardIds[0]!).moduleChange).toEqual({ moduleId: deploy.id, applied: true, describesSaved: true });
    expect(listModuleVersions(handle.db, deploy.id)[0]).toMatchObject({ current: true, approved: false });
  });

  it("Approve after removals runs the tests that are left and names a failing case", async () => {
    const real = createModuleTestRunner({ db: handle.db, launcher });
    try {
      const { module: deploy, ids } = saveDeployWith([
        { description: "returns the result", source: RETURNS_THE_RESULT },
        { description: "retries a failed deploy", source: EXPECTS_A_RETRY },
      ]);
      const conversation = await chat();
      const { cardIds } = turn(conversation, removals(deploy.id, [ids["returns the result"]!]));
      expect(apply(conversation, cardIds[0]!).applied).toBe(true);

      const refused = await approveModuleCommand(handle.db, real, { id: deploy.id, acknowledgeLowCoverage: true });

      expect(refused.approved).toBe(false);
      expect(refused.problem).toContain("1 of 2 test cases failed");
      expect(refused.problem).toContain("- retries a failed deploy");
      expect(getModule(handle.db, deploy.id)?.approvedAt).toBeNull();
    } finally {
      real.dispose();
    }
  });

  describe("Apply is refused, with the reason and nothing written, when a listed case moved after the card was drawn", () => {
    const moves = [
      { what: "deleted", move: (id: string) => void deleteModuleTest(handle.db, id) },
      { what: "edited", move: (id: string) => void saveModuleTest(handle.db, { id, moduleId: getModuleTest(handle.db, id)!.moduleId, description: "returns the outcome", source: RETURNS_THE_RESULT }) },
      { what: "edited", move: (id: string) => void saveModuleTest(handle.db, { id, moduleId: getModuleTest(handle.db, id)!.moduleId, description: "returns the result", source: `${RETURNS_THE_RESULT}\n// edited` }) },
    ];
    for (const [index, { what, move }] of moves.entries()) {
      it(`when it was ${what} (${index === 1 ? "its description" : index === 2 ? "its source" : "gone"})`, async () => {
        const { module: deploy, ids } = saveDeployWith([
          { description: "returns the result", source: RETURNS_THE_RESULT },
          { description: "retries a failed deploy", source: EXPECTS_A_RETRY },
        ]);
        const conversation = await chat();
        const { cardIds } = turn(conversation, change(deploy.id, { tests: [{ description: "deploys to staging", source: DEPLOYS }], removeTests: [ids["returns the result"]!] }));
        move(ids["returns the result"]!);
        const before = rows(deploy.id);

        const applied = apply(conversation, cardIds[0]!);

        expect(applied.applied).toBe(false);
        expect(applied.problem).toContain("Deploy's test cases have changed since this was proposed");
        expect(applied.problem).toContain(`“returns the result” has been ${what}`);
        expect(applied.problem).toContain("Nothing was saved.");
        expect(rows(deploy.id)).toEqual(before);
        expect(applied.conversation.messages.find((message) => message.parentId === cardIds[0])).toMatchObject({ kind: "rejection" });
      });
    }
  });

  it("applies a card drawn before removals existed, which recorded none", () => {
    const deploy = saveDeploy();
    const applied = applyModuleChange(handle.db, deploy, { summary: "Fixes it.", code: FIXED, manifest: null }, { code: changeBaseOf(deploy).code });
    expect(applied).toMatchObject({ ok: true, saved: { code: true, manifest: false, tests: 0, removed: 0 } });
  });

  it("refuses a removal its recorded base never drew, rather than deleting a case nobody was shown", () => {
    const { module: deploy, ids } = saveDeployWith([{ description: "returns the result", source: RETURNS_THE_RESULT }]);
    const before = rows(deploy.id);
    const applied = applyModuleChange(handle.db, deploy, { summary: "x", code: DEPLOY, manifest: null }, changeBaseOf(deploy), { removeTests: [ids["returns the result"]!] });
    expect(applied).toMatchObject({ ok: false });
    if (applied.ok) return;
    expect(applied.reason).toContain("“returns the result” was not on the card as it was drawn");
    expect(rows(deploy.id)).toEqual(before);
  });

  it("is drawn without removals by the scenario chat, whose change carries none", () => {
    const { module: deploy } = saveDeployWith([{ description: "returns the result", source: RETURNS_THE_RESULT }]);
    const drawn = drawModuleChange(handle.db, deploy, { summary: "Fixes it.", code: FIXED, manifest: null });
    expect(drawn).toMatchObject({ ok: true });
    if (!drawn.ok) return;
    expect(drawn.body).not.toContain("Removes");
    expect(drawn.base.removes).toBeUndefined();
  });
});
