import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODULE_CHANGE_EDIT_TOOL_NAME,
  MODULE_CHANGE_FREEZE_TOOL_NAME,
  MODULE_CHANGE_PREPARE_TOOL_NAME,
  ModuleManifestSchema,
  jsonSchemaOutputSchema,
  pageDescriptorFor,
  type AgentEvent,
  type AgentProvider,
  type AgentProviderStartOptions,
  type CustomModule,
  type Item,
  type JsonSchema,
  type Uuid,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  approveModule,
  getItem,
  getModule,
  listCommentsForItem,
  listModuleTests,
  listModuleVersions,
  listRunsForItem,
  saveModule,
  saveModuleTest,
} from "../db/repos/index.js";
import { openMigratedTestDb, openMigratedTestDbAt } from "../db/testHelpers.js";
import { applyAssistModuleChangeCommand, openAssist, sendToAssist } from "../ipc/assistCommands.js";
import { clearPublishedView } from "../ipc/currentView.js";
import { clearHandlerRegistry } from "../ipc/registry.js";
import { applyScenarioChangeCommand, openScenario, sendToScenario } from "../ipc/scenarioCommands.js";
// @ts-expect-error — the service is plain JavaScript, deliberately: it ships
// unbundled because Codex spawns it by path.
import * as eoServer from "../mcp/eoServer.mjs";
import { eoMcpStdioConfig } from "../mcp/serviceConfig.js";
import type { ModuleTestRunner } from "../modules/moduleTestRunner.js";
import { fromStrictCodexAnswer, strictCodexOutputSchema } from "../providers/codex.js";
import { assistModuleChangeFor, postAssistReply } from "../roles/assist.js";
import { drawModuleChange } from "../roles/moduleChange.js";
import { createModuleChangeStaging, type ModuleChangeStaging } from "../roles/moduleChangeProposals.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { postScenarioReply, scenarioChangeFor } from "../roles/scenario.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * Module-change cards from compact proposal references (EO-814), end to
 * end: a real supervisor run whose turn stages a module with
 * `module_change_prepare`, edits only what it changes, freezes it, and
 * answers with `changeProposalId` — in the assistant's chat and in a
 * scenario chat, written the way Claude writes an answer (absent keys) and
 * the way Codex does (every key, null for none, read back through the
 * adapter's own `fromStrictCodexAnswer`).
 *
 * Asserted against the rows and the posted comments, because "only Apply
 * writes" is a claim about the catalog, and "the card shows the whole
 * diff" is a claim about what was posted.
 */

interface EoService {
  handle(request: unknown): Promise<{ result: { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> } }>;
  close(): void;
}
const service = eoServer as { createEoMcpService(options: Record<string, unknown>): EoService };

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "eoServer.mjs");

const CODE = 'export default async function (ctx) {\n  const done = await ctx.exec("aws", ["deploy"]);\n  if (done.code !== 0) return { ok: false, reason: "deploy failed" };\n  return { ok: true, result: "deployed" };\n}\n';
const FIXED = CODE.replace('reason: "deploy failed"', 'reason: "deploy failed: " + done.tail');
const DEPLOYS = 'import assert from "node:assert/strict";\nexport default async function (harness) {\n  const run = await harness.run({ exec: [{ bin: "aws", args: ["deploy"], code: 0 }] });\n  assert.equal(run.outcome.ok, true);\n}\n';
const NAMES_THE_TAIL = 'import assert from "node:assert/strict";\nexport default async function (harness) {\n  const run = await harness.run({ exec: [{ bin: "aws", args: ["deploy"], code: 1, stdout: "denied" }] });\n  assert.match(run.outcome.reason, /denied/);\n}\n';
const MANIFEST = ModuleManifestSchema.parse({ name: "Deploy", description: "Deploys.", inputs: {}, needs: { bin: ["aws"], env: ["AWS_REGION", "DEPLOY_TOKEN"] }, results: ["deployed"] });
const TRIMMED = { ...MANIFEST, needs: { ...MANIFEST.needs, env: ["DEPLOY_TOKEN"] } };

type Backend = "claude" | "codex";
type Room = "assist" | "scenario";

let handle: DbHandle;
let root: string;
let writes: TestWriteBridge;
let staging: ModuleChangeStaging;
const runner = { schedule: vi.fn() } as unknown as ModuleTestRunner;

beforeEach(async () => {
  writes = await startTestWriteBridge();
  handle = openMigratedTestDb();
  root = mkdtempSync(join(tmpdir(), "eo-module-refs-"));
  staging = createModuleChangeStaging({ db: handle.db, root });
});

afterEach(async () => {
  clearHandlerRegistry();
  clearPublishedView();
  await writes.close();
  handle.close();
  rmSync(root, { recursive: true, force: true });
});

function saveDeploy(options: { approved?: boolean; code?: string } = {}): CustomModule {
  const saved = saveModule(handle.db, { slug: "deploy", name: "Deploy", description: "Deploys.", code: options.code ?? CODE, manifest: MANIFEST, source: "user" });
  if (!saved.ok) throw new Error(saved.reason);
  const test = saveModuleTest(handle.db, { moduleId: saved.module.id, description: "deploys", source: DEPLOYS });
  if (!test.ok) throw new Error(test.reason);
  if (options.approved ?? true) approveModule(handle.db, saved.module.id);
  return getModule(handle.db, saved.module.id)!;
}

async function openChat(room: Room, module: CustomModule): Promise<Item> {
  const view =
    room === "assist"
      ? await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/chat"), conversationId: null, body: "Make Deploy say why it failed.", attachmentIds: [], interrupt: false })
      : await sendToScenario(handle.db, undefined, { moduleId: module.id, conversationId: null, body: "The module is wrong — fix it.", interrupt: false });
  return getItem(handle.db, view.conversation.id as Uuid)!;
}

/**
 * How each backend hands EO a turn's answer. Claude's is the answer as
 * written, keys it has nothing for left out. Codex is held to the strict
 * schema, where every key is required — so it writes every one, null for
 * none — and its adapter reads it back through `fromStrictCodexAnswer`.
 */
function asBackend(backend: Backend, outcome: Record<string, unknown>, schema: JsonSchema | undefined): unknown {
  if (backend === "claude") return { outcome };
  if (!schema) throw new Error("a Codex turn is always handed its output schema");
  type Node = { properties: Record<string, unknown>; required: string[] };
  const outcomeNode = (strictCodexOutputSchema(schema)["properties"] as Record<string, { anyOf?: Node[] } & Partial<Node>>)["outcome"]!;
  // The answer's branch, beside the clarification EO takes on any action.
  const strictOutcome = (outcomeNode.anyOf ?? [outcomeNode as Node]).find((branch) => "message" in (branch.properties ?? {}))!;
  // Codex can write the reference at all only if the strict schema asks for it.
  expect(strictOutcome.required).toContain("changeProposalId");
  const everyKey = { outcome: Object.fromEntries(Object.keys(strictOutcome.properties).map((key) => [key, key in outcome ? outcome[key] : null])) };
  // An answer the API itself would accept under the strict schema.
  const strict = jsonSchemaOutputSchema(strictCodexOutputSchema(schema)).parse(everyKey);
  expect(strict.ok ? [] : strict.issues).toEqual([]);
  return fromStrictCodexAnswer(everyKey, schema);
}

type Step = (answers: Record<string, unknown>[]) => { name: string; args: unknown } | null;
interface Seen {
  answers: Record<string, unknown>[];
  errors: string[];
  /** The bytes of every tool call's arguments: what preparing the change cost the turn to write. */
  preparationBytes: number;
  /** The bytes of the turn's final structured answer. */
  answerBytes: number;
  answers_: unknown[];
  reprompts: string[];
}

/**
 * A turn that calls the module-change tools in order on the `eo` server
 * its options start, then answers with what `answer` makes of their
 * answers. `again`, when given, is the answer to a re-prompt.
 */
function preparingAgent(
  backend: Backend,
  steps: Step[],
  answer: (answers: Record<string, unknown>[]) => Record<string, unknown>,
  options: { beforeAnswer?: () => void; again?: (answers: Record<string, unknown>[], message: string) => Record<string, unknown> } = {},
) {
  const seen: Seen = { answers: [], errors: [], preparationBytes: 0, answerBytes: 0, answers_: [], reprompts: [] };
  let schema: JsonSchema | undefined;
  const provider: AgentProvider = {
    async *start(opts: AgentProviderStartOptions): AsyncIterable<AgentEvent> {
      schema = opts.outputSchema;
      const env = eoMcpStdioConfig({ serverPath, ...(opts.writeBridge ? { writeBridge: opts.writeBridge } : {}) }).env;
      const eo = service.createEoMcpService({ dbPath: undefined, writeBridge: env["EO_MCP_WRITE_BRIDGE"] === undefined ? null : JSON.parse(env["EO_MCP_WRITE_BRIDGE"]) });
      try {
        yield { type: "thread_started", threadId: "thread-1" };
        for (let id = 1; ; id += 1) {
          const step = steps[seen.answers.length];
          const next = step?.(seen.answers) ?? null;
          if (next === null) break;
          seen.preparationBytes += Buffer.byteLength(JSON.stringify(next.args), "utf8");
          const { result } = await eo.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name: next.name, arguments: next.args } });
          if (result.isError) {
            seen.errors.push(result.content[0]?.text ?? "");
            break;
          }
          seen.answers.push(result.structuredContent ?? {});
        }
        options.beforeAnswer?.();
        const data = asBackend(backend, answer(seen.answers), schema);
        seen.answerBytes = Buffer.byteLength(JSON.stringify(data), "utf8");
        seen.answers_.push(data);
        yield { type: "result", data };
      } finally {
        eo.close();
      }
    },
    async *resume(_threadId: string, message: string): AsyncIterable<AgentEvent> {
      seen.reprompts.push(message);
      if (!options.again) throw new Error("this turn is not re-prompted");
      yield { type: "result", data: asBackend(backend, options.again(seen.answers, message), schema) };
    },
  } as AgentProvider;
  return { provider, seen };
}

async function runTurn(provider: AgentProvider): Promise<void> {
  const supervisor = createRunSupervisor({ db: handle.db, provider, ...createRoleWiring(handle.db), limits: LIMITS, agentWriteBridge: writes.agentWriteBridge, moduleStaging: staging });
  writes.serve(supervisor);
  await supervisor.runOnce();
  await supervisor.waitForIdle();
}

/** Prepare, change the code (and in the assistant's chat a test case and the manifest), and freeze. */
function preparing(room: Room, module: CustomModule): Step[] {
  const stagingId = (answers: Record<string, unknown>[]) => answers[0]!["stagingId"] as string;
  const steps: Step[] = [
    () => ({ name: MODULE_CHANGE_PREPARE_TOOL_NAME, args: room === "assist" ? { moduleId: module.id } : {} }),
    (answers) => ({ name: MODULE_CHANGE_EDIT_TOOL_NAME, args: { stagingId: stagingId(answers), file: "module.js", edits: [{ old_text: 'reason: "deploy failed"', new_text: 'reason: "deploy failed: " + done.tail' }] } }),
    (answers) => ({ name: MODULE_CHANGE_EDIT_TOOL_NAME, args: { stagingId: stagingId(answers), file: "manifest.json", edits: [{ old_text: '"AWS_REGION",', new_text: "" }] } }),
  ];
  if (room === "assist") {
    steps.push((answers) => ({ name: MODULE_CHANGE_EDIT_TOOL_NAME, args: { stagingId: stagingId(answers), file: "tests/new.js", content: NAMES_THE_TAIL } }));
  }
  steps.push((answers) => ({
    name: MODULE_CHANGE_FREEZE_TOOL_NAME,
    args: { stagingId: stagingId(answers), summary: "Says what the deploy printed.", ...(room === "assist" ? { tests: [{ description: "names the tail", file: "tests/new.js" }] } : {}) },
  }));
  return steps;
}

const proposalOf = (answers: Record<string, unknown>[]) => answers.at(-1)!["proposalId"] as string;
const referring = (answers: Record<string, unknown>[]) => ({ message: "The change is on the card below.", changeProposalId: proposalOf(answers) });

function posted(conversation: Item) {
  const comments = listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.runId !== null);
  return { cards: comments.filter((comment) => comment.kind === PROPOSAL_KIND), rejections: comments.filter((comment) => comment.kind === "rejection").map((comment) => comment.body) };
}

function apply(room: Room, conversation: Item, messageId: string) {
  return room === "assist"
    ? applyAssistModuleChangeCommand(handle.db, undefined, runner, { conversationId: conversation.id, messageId })
    : applyScenarioChangeCommand(handle.db, undefined, runner, { conversationId: conversation.id, messageId });
}

function rows(moduleId: string) {
  const module = getModule(handle.db, moduleId)!;
  return {
    code: module.code,
    manifest: module.manifest,
    approvedAt: module.approvedAt,
    tests: listModuleTests(handle.db, moduleId).map((test) => [test.description, test.source]),
    versions: listModuleVersions(handle.db, moduleId).length,
  };
}

/** The card the same change carried inline would draw, against the module as it is saved. */
function inlineCard(room: Room, module: CustomModule): string {
  const drawn = drawModuleChange(
    handle.db,
    module,
    { summary: "Says what the deploy printed.", code: FIXED, manifest: TRIMMED },
    room === "assist" ? { tests: [{ description: "names the tail", source: NAMES_THE_TAIL }], removeTests: [], requireCases: true } : {},
  );
  if (!drawn.ok) throw new Error(drawn.reason);
  return drawn.body;
}

const BOTH: [Room, Backend][] = [
  ["assist", "claude"],
  ["assist", "codex"],
  ["scenario", "claude"],
  ["scenario", "codex"],
];

describe.each(BOTH)("a %s turn on %s naming a frozen proposal", (room, backend) => {
  it("posts the card an inline change would, writes nothing, and Apply writes exactly the frozen content", async () => {
    const deploy = saveDeploy();
    const before = rows(deploy.id);
    const conversation = await openChat(room, deploy);
    const { provider, seen } = preparingAgent(backend, preparing(room, deploy), referring);

    await runTurn(provider);

    expect(seen.errors).toEqual([]);
    const { cards, rejections } = posted(conversation);
    expect(rejections).toEqual([]);
    expect(cards).toHaveLength(1);
    // The whole diff of the code and of the manifest, and the case it adds: the same card as inline.
    expect(cards[0]!.body).toBe(inlineCard(room, deploy));
    expect(cards[0]!.body).toContain('+  if (done.code !== 0) return { ok: false, reason: "deploy failed: " + done.tail };');
    expect(cards[0]!.body).toContain('-      "AWS_REGION",');
    if (room === "assist") expect(cards[0]!.body).toContain("- Adds “names the tail”");
    expect(cards[0]!.body).toContain("withdraws the module's approval");
    // Preparing, freezing and posting changed nothing.
    expect(rows(deploy.id)).toEqual(before);
    // The answer carried no source.
    expect(JSON.stringify(seen.answers_[0])).not.toContain("done.tail");
    // What the card's readiness check reads (EO-817) is the frozen change too.
    const current = getItem(handle.db, conversation.id)!;
    const read = room === "assist" ? assistModuleChangeFor(handle.db, current, cards[0]!.id) : scenarioChangeFor(handle.db, current, cards[0]!.id);
    expect(read?.code).toBe(FIXED);
    expect(read?.manifest?.needs.env).toEqual(["DEPLOY_TOKEN"]);

    const applied = apply(room, conversation, cards[0]!.id);
    expect(applied.problem).toBeNull();
    expect(applied.applied).toBe(true);
    const after = rows(deploy.id);
    expect(after.code).toBe(FIXED);
    expect(after.manifest.needs.env).toEqual(["DEPLOY_TOKEN"]);
    expect(after.versions).toBe(before.versions + 1);
    expect(after.approvedAt).toBeNull();
    expect(after.tests).toEqual(room === "assist" ? [...before.tests, ["names the tail", NAMES_THE_TAIL]] : before.tests);
    // Applied once: the card is not applicable again.
    expect(apply(room, conversation, cards[0]!.id).applied).toBe(false);
  });

  it("is sent back while the turn is open when it names no proposal of this turn's, and the corrected answer is posted", async () => {
    const deploy = saveDeploy();
    const conversation = await openChat(room, deploy);
    const { provider, seen } = preparingAgent(backend, preparing(room, deploy), () => ({ message: "On the card.", changeProposalId: "not-a-proposal" }), { again: referring });

    await runTurn(provider);

    expect(seen.reprompts).toHaveLength(1);
    expect(seen.reprompts[0]).toContain('`changeProposalId` is "not-a-proposal"');
    expect(seen.reprompts[0]).toContain("module_change_freeze");
    const { cards, rejections } = posted(conversation);
    expect(rejections).toEqual([]);
    expect(cards).toHaveLength(1);
  });

  it("is refused as stale before Apply is offered when the module was saved after the proposal was prepared", async () => {
    const deploy = saveDeploy();
    const conversation = await openChat(room, deploy);
    const edit = () => {
      const saved = saveModule(handle.db, { ...getModule(handle.db, deploy.id)!, code: CODE.replace("aws", "aws2") });
      if (!saved.ok) throw new Error(saved.reason);
    };
    const { provider, seen } = preparingAgent(backend, preparing(room, deploy), referring, { beforeAnswer: edit, again: () => ({ message: "It moved on; I will prepare it again." }) });

    await runTurn(provider);

    expect(seen.reprompts).toHaveLength(1);
    expect(seen.reprompts[0]).toContain("since proposal");
    expect(seen.reprompts[0]).toContain("module_change_prepare again");
    expect(posted(conversation).cards).toHaveLength(0);
    expect(getModule(handle.db, deploy.id)!.code).toBe(CODE.replace("aws", "aws2"));
  });
});

describe("a card drawn from a frozen proposal", () => {
  it("keeps the existing stale-base check on Apply: a module saved after the card was posted is not overwritten", async () => {
    for (const room of ["assist", "scenario"] as const) {
      const deploy = saveDeploy();
      const conversation = await openChat(room, deploy);
      const { provider } = preparingAgent("claude", preparing(room, deploy), referring);
      await runTurn(provider);
      const card = posted(conversation).cards[0]!;

      const moved = CODE.replace("aws", "aws2");
      const saved = saveModule(handle.db, { ...getModule(handle.db, deploy.id)!, code: moved });
      if (!saved.ok) throw new Error(saved.reason);
      const applied = apply(room, conversation, card.id);
      expect(applied.applied).toBe(false);
      expect(applied.problem).toContain("changed since this was proposed");
      expect(getModule(handle.db, deploy.id)!.code).toBe(moved);

      // A clean slate for the other chat.
      handle.close();
      handle = openMigratedTestDb();
      staging = createModuleChangeStaging({ db: handle.db, root });
    }
  });

  it("keeps the changed-removal check on Apply: a case it removes, edited since, is not removed", async () => {
    const deploy = saveDeploy({ approved: false });
    const extra = saveModuleTest(handle.db, { moduleId: deploy.id, description: "spare", source: DEPLOYS });
    if (!extra.ok) throw new Error(extra.reason);
    const conversation = await openChat("assist", deploy);
    const steps: Step[] = [
      () => ({ name: MODULE_CHANGE_PREPARE_TOOL_NAME, args: { moduleId: deploy.id } }),
      (answers) => ({ name: MODULE_CHANGE_FREEZE_TOOL_NAME, args: { stagingId: answers[0]!["stagingId"], summary: "Drops the spare case.", removeTests: [extra.test.id] } }),
    ];
    const { provider } = preparingAgent("codex", steps, referring);
    await runTurn(provider);
    const card = posted(conversation).cards[0]!;
    expect(card.body).toContain("- Removes “spare”");

    const edited = saveModuleTest(handle.db, { id: extra.test.id, moduleId: deploy.id, description: "spare", source: NAMES_THE_TAIL });
    if (!edited.ok) throw new Error(edited.reason);
    const applied = apply("assist", conversation, card.id);
    expect(applied.applied).toBe(false);
    expect(applied.problem).toContain("“spare” has been edited");
    expect(listModuleTests(handle.db, deploy.id).map((test) => test.description)).toEqual(["deploys", "spare"]);
  });

  it("is refused as a rejection, not a card, when the proposal has gone stale by the time the reply is posted", async () => {
    for (const room of ["assist", "scenario"] as const) {
      const deploy = saveDeploy();
      const conversation = await openChat(room, deploy);
      const { provider, seen } = preparingAgent("claude", preparing(room, deploy), referring);
      await runTurn(provider);
      const run = listRunsForItem(handle.db, conversation.id)[0]!;
      const posting = posted(conversation).cards.length;
      expect(posting).toBe(1);

      // The same answer posted again after the module moved on: what a reply read back after a restart meets.
      const saved = saveModule(handle.db, { ...getModule(handle.db, deploy.id)!, code: CODE.replace("aws", "aws3") });
      if (!saved.ok) throw new Error(saved.reason);
      const outcome = (seen.answers_[0] as { outcome: unknown }).outcome;
      if (room === "assist") postAssistReply(handle.db, getItem(handle.db, conversation.id)!, run.agentId as Uuid, run.id, outcome);
      else postScenarioReply(handle.db, getItem(handle.db, conversation.id)!, run.agentId as Uuid, run.id, outcome);

      const after = posted(conversation);
      expect(after.cards).toHaveLength(posting);
      expect(after.rejections.at(-1)).toContain("since proposal");

      handle.close();
      handle = openMigratedTestDb();
      staging = createModuleChangeStaging({ db: handle.db, root });
    }
  });

  it("shows and applies the same thing after a restart, a staging sweep and an edited working file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eo-module-refs-restart-"));
    try {
      const dbPath = join(directory, "eo.db");
      handle.close();
      handle = openMigratedTestDbAt(dbPath);
      staging = createModuleChangeStaging({ db: handle.db, root });
      const deploy = saveDeploy();
      const assistChat = await openChat("assist", deploy);
      let stagedDirectory = "";
      const { provider } = preparingAgent("claude", preparing("assist", deploy), (answers) => {
        stagedDirectory = answers[0]!["directory"] as string;
        return referring(answers);
      });
      await runTurn(provider);
      const card = posted(assistChat).cards[0]!;
      const shown = openAssist(handle.db).conversation.messages.find((message) => message.id === card.id)!;

      // The working file is edited after the card is posted (recreated, as a turn could), and the process restarts.
      mkdirSync(stagedDirectory, { recursive: true });
      writeFileSync(join(stagedDirectory, "module.js"), "export default async () => ({ ok: true, result: 'tampered' });");
      handle.close();
      handle = openMigratedTestDbAt(dbPath);
      staging = createModuleChangeStaging({ db: handle.db, root });
      staging.sweep();

      const again = openAssist(handle.db).conversation.messages.find((message) => message.id === card.id)!;
      expect(again.body).toBe(shown.body);
      expect(again.moduleChange).toEqual({ moduleId: deploy.id, applied: false, describesSaved: false });
      const applied = apply("assist", getItem(handle.db, assistChat.id)!, card.id);
      expect(applied.applied).toBe(true);
      expect(getModule(handle.db, deploy.id)!.code).toBe(FIXED);
      // Applied: the card now describes what is saved, and offers Approve.
      const appliedCard = openAssist(handle.db).conversation.messages.find((message) => message.id === card.id)!;
      expect(appliedCard.moduleChange).toEqual({ moduleId: deploy.id, applied: true, describesSaved: true });
    } finally {
      handle.close();
      handle = openMigratedTestDb();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("in a scenario chat, still applies after a restart from the frozen row", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eo-module-refs-restart-"));
    try {
      const dbPath = join(directory, "eo.db");
      handle.close();
      handle = openMigratedTestDbAt(dbPath);
      staging = createModuleChangeStaging({ db: handle.db, root });
      const deploy = saveDeploy();
      const conversation = await openChat("scenario", deploy);
      const { provider } = preparingAgent("codex", preparing("scenario", deploy), referring);
      await runTurn(provider);
      const card = posted(conversation).cards[0]!;

      handle.close();
      handle = openMigratedTestDbAt(dbPath);
      createModuleChangeStaging({ db: handle.db, root }).sweep();
      const shown = openScenario(handle.db, { moduleId: deploy.id }).conversation.messages.find((message) => message.id === card.id)!;
      expect(shown.body).toBe(card.body);
      expect(apply("scenario", getItem(handle.db, conversation.id)!, card.id).applied).toBe(true);
      expect(getModule(handle.db, deploy.id)!.code).toBe(FIXED);
    } finally {
      handle.close();
      handle = openMigratedTestDb();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("cards and answers from before references", () => {
  it("an inline change in either chat still posts and applies as it did, recorded with no proposal id", async () => {
    for (const room of ["assist", "scenario"] as const) {
      const deploy = saveDeploy({ approved: false });
      const conversation = await openChat(room, deploy);
      const inline = room === "assist" ? { moduleId: deploy.id, summary: "Inline.", code: FIXED, manifest: null, tests: [], removeTests: [] } : { summary: "Inline.", code: FIXED };
      const { provider } = preparingAgent(room === "assist" ? "codex" : "claude", [], () => ({ message: "Here.", change: inline }));
      await runTurn(provider);
      const card = posted(conversation).cards[0]!;
      expect(card.body).toContain("**Proposed change to Deploy**");
      expect(JSON.stringify(getItem(handle.db, conversation.id)!.spec)).not.toContain("proposalId");
      expect(apply(room, conversation, card.id).applied).toBe(true);
      expect(getModule(handle.db, deploy.id)!.code).toBe(FIXED);

      handle.close();
      handle = openMigratedTestDb();
      staging = createModuleChangeStaging({ db: handle.db, root });
    }
  });
});

describe("the final answer's size, with the module as large as EO-803's", () => {
  it("carries no module or test source and stays bounded whatever the source's size; preparation and answer measured apart", async () => {
    // EO-803's answer was 85,301 characters: a module about that size.
    const filler = Array.from({ length: 1400 }, (_, index) => `  // step ${index}: ${"x".repeat(48)}`).join("\n");
    const large = CODE.replace("{\n", `{\n${filler}\n`);
    expect(large.length).toBeGreaterThan(85_000);
    const deploy = saveDeploy({ code: large });
    const conversation = await openChat("assist", deploy);
    const { provider, seen } = preparingAgent("claude", preparing("assist", deploy), referring);

    await runTurn(provider);

    const card = posted(conversation).cards[0]!;
    expect(card.body).toContain('+  if (done.code !== 0) return { ok: false, reason: "deploy failed: " + done.tail };');
    const answer = JSON.stringify(seen.answers_[0]);
    expect(answer).not.toContain("step 1399");
    expect(answer).not.toContain("harness.run");
    // The answer is a message and an id, so its size does not follow the module's.
    expect(seen.answerBytes).toBeLessThan(300);
    // What preparing cost the turn to write: the edits and the one new case, not the module.
    expect(seen.preparationBytes).toBeLessThan(2_000);
    expect(seen.preparationBytes).toBeGreaterThan(Buffer.byteLength(NAMES_THE_TAIL, "utf8"));
    // The inline answer it replaces restates the whole module.
    const inline = JSON.stringify({ outcome: { message: "The change is on the card below.", change: { moduleId: deploy.id, summary: "Says what the deploy printed.", code: large.replace('reason: "deploy failed"', 'reason: "deploy failed: " + done.tail'), manifest: TRIMMED, tests: [{ description: "names the tail", source: NAMES_THE_TAIL }] } } });
    expect(inline.length).toBeGreaterThan(85_000);
  });
});
