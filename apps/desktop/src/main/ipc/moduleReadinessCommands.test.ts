import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AssistOutputSchema,
  machineContract,
  ModuleManifestSchema,
  pageDescriptorFor,
  type AssistReply,
  type CustomModule,
  type Item,
  type ModuleManifest,
  type Uuid,
} from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  approveModule,
  createPipeline,
  createRun,
  createStep,
  getItem,
  getModule,
  listCommentsForItem,
  saveModule,
  saveModuleTest,
  updateRun,
} from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { storeSecret, storeVariable, type ModuleSecretsOptions } from "../modules/secrets.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { applyAssistModuleChangeCommand, sendToAssist } from "./assistCommands.js";
import { clearPublishedView } from "./currentView.js";
import { moduleReadinessCommand, type ModuleReadinessDeps } from "./moduleReadinessCommands.js";

/**
 * Whether a module could run on this device, as the cards it is proposed
 * and changed on ask it (EO-817): every declared CLI and environment name
 * at once, on the named device and in the named scope, the proposed
 * version before Apply and the saved one after — independent of approval,
 * and never a value.
 */

const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${text}`),
  decryptString: (buffer: Buffer) => buffer.toString().slice(4),
};

const SECRET = "5c0a-only-in-the-keychain";

const MANIFEST: ModuleManifest = ModuleManifestSchema.parse({
  name: "Deploy",
  description: "Deploys the release.",
  needs: { bin: ["aws-817", "gh-817"], env: ["DEPLOY_TOKEN", "AWS_REGION"], network: true },
  results: ["deployed"],
});

const CODE = `export default async function (ctx) {
  await ctx.exec("aws-817", ["deploy"]);
  return { ok: true, result: "deployed" };
}`;

const CASE = `import assert from "node:assert/strict";
export default async function (harness) {
  const run = await harness.run({ exec: [{ bin: "aws-817", args: ["deploy"], code: 0 }] });
  assert.equal(run.outcome.ok, true);
}`;

let handle: DbHandle;
let scratch: string;
let bin: string;
let secrets: ModuleSecretsOptions;
let deps: ModuleReadinessDeps;

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-readiness-card-"));
  bin = join(scratch, "bin");
  mkdirSync(bin);
  secrets = { directory: join(scratch, "secrets"), store, environment: {} };
  deps = { secrets, device: () => "anna-laptop", binaries: { directories: [bin] } };
});

afterEach(() => {
  clearPublishedView();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** A file `ctx.exec` would start, in the searched directory. */
function install(name: string): void {
  const file = join(bin, process.platform === "win32" ? `${name}.exe` : name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
}

function saveDeploy(manifest: ModuleManifest = MANIFEST, approved = false): CustomModule {
  const saved = saveModule(handle.db, { slug: "deploy", name: "Deploy", description: "Deploys the release.", code: CODE, manifest, source: "user" });
  if (!saved.ok) throw new Error(saved.reason);
  const test = saveModuleTest(handle.db, { moduleId: saved.module.id, description: "deploys", source: CASE });
  if (!test.ok) throw new Error(test.reason);
  if (approved) approveModule(handle.db, saved.module.id);
  return getModule(handle.db, saved.module.id)!;
}

function check(moduleId: string, extra: { stepId?: string | null; change?: { conversationId: string; messageId: string } | null } = {}) {
  return moduleReadinessCommand(handle.db, deps, { moduleId, ...extra });
}

describe("a module's readiness on this device", () => {
  it("lists every missing CLI and environment name together, on the named device in the shared scope", () => {
    const deploy = saveDeploy();
    install("gh-817");
    storeSecret(secrets, "DEPLOY_TOKEN", SECRET);

    const answer = check(deploy.id);

    expect(answer.problem).toBeNull();
    expect(answer.check).toMatchObject({
      device: "anna-laptop",
      scope: { kind: "shared" },
      readiness: {
        ready: false,
        bin: [
          { name: "aws-817", status: "missing" },
          { name: "gh-817", status: "found" },
        ],
        env: [
          { name: "DEPLOY_TOKEN", status: "set" },
          { name: "AWS_REGION", status: "unset" },
        ],
      },
      unknownBins: [],
      introduced: { bin: [], env: [] },
      searched: [bin],
      steps: [],
    });
    // Names and statuses only.
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  it("is independent of approval: an approved module can be not ready, and checking leaves the approval and code as they were", () => {
    const deploy = saveDeploy(MANIFEST, true);
    expect(deploy.approvedAt).not.toBeNull();

    expect(check(deploy.id).check?.readiness.ready).toBe(false);

    const after = getModule(handle.db, deploy.id)!;
    expect(after.approvedAt).toBe(deploy.approvedAt);
    expect(after.code).toBe(deploy.code);
  });

  it("reflects a value set and a CLI installed since, on the next check, with nothing approved again", () => {
    const deploy = saveDeploy(MANIFEST, true);
    expect(check(deploy.id).check?.readiness.ready).toBe(false);

    install("aws-817");
    install("gh-817");
    storeSecret(secrets, "DEPLOY_TOKEN", SECRET);
    storeVariable(secrets, "AWS_REGION", "eu-west-1");

    const again = check(deploy.id).check!;
    expect(again.readiness.ready).toBe(true);
    expect(again.readiness.env.every((entry) => entry.status === "set")).toBe(true);
    expect(getModule(handle.db, deploy.id)!.approvedAt).toBe(deploy.approvedAt);
  });

  it("checks one published step's own values when asked, and lists the steps that run the module", () => {
    const deploy = saveDeploy();
    install("aws-817");
    install("gh-817");
    storeSecret(secrets, "AWS_REGION", "shared-region");
    const pipeline = createPipeline(handle.db, { name: "Ship" });
    const staging = createStep(handle.db, { pipelineId: pipeline.id, position: 0, name: "Staging", type: "module", entryAction: deploy.id });
    createStep(handle.db, { pipelineId: pipeline.id, position: 1, name: "Review", type: "agent" });
    storeSecret(secrets, "DEPLOY_TOKEN", SECRET, staging.id);

    const shared = check(deploy.id).check!;
    expect(shared.steps).toEqual([{ stepId: staging.id, name: "Staging", pipelineName: "Ship" }]);
    expect(shared.readiness.env).toContainEqual({ name: "DEPLOY_TOKEN", status: "unset" });

    const step = check(deploy.id, { stepId: staging.id }).check!;
    expect(step.scope).toEqual({ kind: "step", step: { stepId: staging.id, name: "Staging", pipelineName: "Ship" } });
    expect(step.readiness.ready).toBe(true);
  });

  it("refuses a step that does not run the module rather than answering for another scope", () => {
    const deploy = saveDeploy();
    const pipeline = createPipeline(handle.db, { name: "Ship" });
    const other = createStep(handle.db, { pipelineId: pipeline.id, position: 0, name: "Review", type: "agent" });

    expect(check(deploy.id, { stepId: other.id })).toEqual({ check: null, problem: "That step does not run this module, or is no longer published." });
  });

  it("says a CLI named by a relative path is unknown, since it is found from a run's directory, and is not ready because of it", () => {
    const relative = process.platform === "win32" ? "tools\\deploy" : "./tools/deploy";
    const deploy = saveDeploy({ ...MANIFEST, needs: { ...MANIFEST.needs, bin: [relative], env: [] } });

    const answer = check(deploy.id).check!;

    expect(answer.unknownBins).toEqual([relative]);
    expect(answer.readiness.bin).toEqual([]);
    expect(answer.readiness.ready).toBe(false);
  });

  it("answers for a module that is gone with a sentence", () => {
    expect(check("nope")).toEqual({ check: null, problem: "That module no longer exists." });
  });

  it("is on the machine half: a browser served by a server is told it cannot ask", () => {
    expect(Object.hasOwn(machineContract, "modules:readiness")).toBe(true);
  });
});

describe("a proposed change that adds requirements", () => {
  async function chat(): Promise<Item> {
    const view = await sendToAssist(handle.db, undefined, {
      page: pageDescriptorFor("/settings"),
      conversationId: null,
      body: "It should post to Slack too.",
      attachmentIds: [],
      interrupt: false,
    });
    return getItem(handle.db, view.conversation.id as Uuid)!;
  }

  function propose(conversation: Item, output: AssistReply): Uuid {
    const parsed = AssistOutputSchema.parse(output);
    const agent = assistAgent(handle.db)!;
    const initiationId = listCommentsForItem(handle.db, conversation.id)
      .filter((comment) => comment.authorType === "human" && comment.parentId === null)
      .at(-1)!.id;
    const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION, initiationId });
    updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(output), parsed: output } });
    postAssistReply(handle.db, conversation, agent.id, run.id, parsed);
    return listCommentsForItem(handle.db, conversation.id).find((comment) => comment.runId === run.id && comment.kind === PROPOSAL_KIND)!.id;
  }

  const ADDS: ModuleManifest = { ...MANIFEST, needs: { ...MANIFEST.needs, bin: [...MANIFEST.needs.bin, "jq-817"], env: [...MANIFEST.needs.env, "SLACK_WEBHOOK"] } };

  it("shows what the update adds before Apply, and follows the applied version afterwards", async () => {
    const deploy = saveDeploy(MANIFEST, true);
    const conversation = await chat();
    const messageId = propose(conversation, {
      message: "Here is the change.",
      change: { moduleId: deploy.id, summary: "Posts to Slack after a deploy.", code: CODE.replace("return", "await ctx.exec('jq-817', []);\n  return"), manifest: ADDS },
    });
    const at = { conversationId: conversation.id, messageId };

    const before = check(deploy.id, { change: at }).check!;
    expect(before.introduced).toEqual({ bin: ["jq-817"], env: ["SLACK_WEBHOOK"] });
    expect(before.readiness.bin.map((entry) => entry.name)).toEqual(["aws-817", "gh-817", "jq-817"]);
    expect(before.readiness.env).toContainEqual({ name: "SLACK_WEBHOOK", status: "unset" });
    // The saved module is untouched by asking.
    expect(getModule(handle.db, deploy.id)!.manifest).toEqual(MANIFEST);
    // Asked without the change, it is the saved version.
    expect(check(deploy.id).check!.readiness.bin.map((entry) => entry.name)).toEqual(["aws-817", "gh-817"]);

    const applied = applyAssistModuleChangeCommand(handle.db, undefined, { schedule: vi.fn() }, at);
    expect(applied.applied).toBe(true);

    const after = check(deploy.id).check!;
    expect(after.introduced).toEqual({ bin: [], env: [] });
    expect(after.readiness.bin.map((entry) => entry.name)).toEqual(["aws-817", "gh-817", "jq-817"]);
    expect(after.readiness.env).toContainEqual({ name: "SLACK_WEBHOOK", status: "unset" });
  });

  it("refuses a message that is not a change to this module", async () => {
    const deploy = saveDeploy();
    const conversation = await chat();
    const human = listCommentsForItem(handle.db, conversation.id)[0]!;

    expect(check(deploy.id, { change: { conversationId: conversation.id, messageId: human.id } })).toEqual({
      check: null,
      problem: "That message does not propose a change to this module.",
    });
  });
});
