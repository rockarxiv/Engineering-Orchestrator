import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MEMORY_NOTE_TOOL_NAME,
  MODULE_CHANGE_EDIT_TOOL_NAME,
  MODULE_CHANGE_FREEZE_TOOL_NAME,
  MODULE_CHANGE_PREPARE_TOOL_NAME,
  MODULE_CHANGE_TOOLS,
  ModuleManifestSchema,
  SKILL_WRITE_TOOLS,
  pageDescriptorFor,
  type AgentEvent,
  type AgentProvider,
  type AgentProviderStartOptions,
  type CustomModule,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getModule, listModuleTests, listModuleVersions, listRunsForItem, saveModule, saveModuleTest } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { sendToAssist } from "../ipc/assistCommands.js";
// @ts-expect-error — the service is plain JavaScript, deliberately: it ships
// unbundled because Codex spawns it by path.
import * as eoServer from "../mcp/eoServer.mjs";
import { eoMcpStdioConfig } from "../mcp/serviceConfig.js";
import { sendAgentWrite } from "../mcp/writeBridge.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createModuleChangeStaging, resolveModuleChangeProposal } from "../roles/moduleChangeProposals.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * The module-change tools on a real turn (EO-813): the `eo` server built
 * from the turn's own options, as both backends build it, handing each
 * call over the agent write bridge to the supervisor, which answers for
 * the run it is reading on that conversation.
 */

interface EoService {
  tools: { name: string }[];
  handle(request: unknown): Promise<{ result: { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> } }>;
  close(): void;
}
const service = eoServer as { createEoMcpService(options: Record<string, unknown>): EoService };

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "eoServer.mjs");
const ANSWER = { outcome: { message: "Proposed the change.", questions: [], proposals: [] } };
const CODE = 'export default async function (ctx) {\n  return { ok: false, reason: "deploy failed" };\n}\n';

let handle: DbHandle;
let root: string;
let writes: TestWriteBridge;

beforeEach(async () => {
  writes = await startTestWriteBridge();
  handle = openMigratedTestDb();
  root = mkdtempSync(join(tmpdir(), "eo-module-tools-"));
});

afterEach(async () => {
  await writes.close();
  handle.close();
  rmSync(root, { recursive: true, force: true });
});

function saveDeploy(): CustomModule {
  const manifest = ModuleManifestSchema.parse({ name: "Deploy", description: "Deploys.", inputs: {}, needs: { bin: [], env: [] }, results: ["deployed"] });
  const saved = saveModule(handle.db, { slug: "deploy", name: "Deploy", description: "Deploys.", code: CODE, manifest, source: "user" });
  if (!saved.ok) throw new Error(saved.reason);
  const test = saveModuleTest(handle.db, { moduleId: saved.module.id, description: "fails", source: "export default async function () {}" });
  if (!test.ok) throw new Error(test.reason);
  return getModule(handle.db, saved.module.id)!;
}

/** A turn that calls each tool in order on the `eo` server its options start, and remembers what it was told. */
function callingAgent(calls: (answers: Record<string, unknown>[]) => { name: string; args: unknown } | null, result: unknown = ANSWER) {
  const seen = { starts: [] as AgentProviderStartOptions[], listed: [] as string[], answers: [] as Record<string, unknown>[], errors: [] as string[] };
  const provider: AgentProvider = {
    async *start(opts): AsyncIterable<AgentEvent> {
      seen.starts.push(opts);
      const env = eoMcpStdioConfig({ serverPath, ...(opts.writeBridge ? { writeBridge: opts.writeBridge } : {}) }).env;
      const eo = service.createEoMcpService({ dbPath: undefined, writeBridge: env["EO_MCP_WRITE_BRIDGE"] === undefined ? null : JSON.parse(env["EO_MCP_WRITE_BRIDGE"]) });
      try {
        seen.listed = eo.tools.map((tool) => tool.name);
        yield { type: "thread_started", threadId: "thread-1" };
        for (let next = calls(seen.answers), id = 1; next !== null; next = calls(seen.answers), id += 1) {
          const { result: answer } = await eo.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name: next.name, arguments: next.args } });
          if (answer.isError) {
            seen.errors.push(answer.content[0]?.text ?? "");
            break;
          }
          seen.answers.push(answer.structuredContent ?? {});
        }
        yield { type: "result", data: result };
      } finally {
        eo.close();
      }
    },
    // eslint-disable-next-line require-yield
    async *resume(): AsyncIterable<AgentEvent> {
      throw new Error("these runs are not resumed");
    },
  };
  return { provider, seen };
}

function supervisorOver(provider: AgentProvider) {
  const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS, agentWriteBridge: writes.agentWriteBridge, moduleStaging: createModuleChangeStaging({ db: handle.db, root }) });
  writes.serve(supervisor);
  return supervisor;
}

describe("the module-change tools on a run", () => {
  it("are listed on an assistant turn, which prepares, edits and freezes a change; its staging goes with the run and the module is untouched", async () => {
    const deploy = saveDeploy();
    const before = { code: deploy.code, tests: listModuleTests(handle.db, deploy.id), versions: listModuleVersions(handle.db, deploy.id).length };
    const conversation = (await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/chat"), conversationId: null, body: "Fix Deploy's reason.", attachmentIds: [], interrupt: false })).conversation;
    const steps = [
      { name: MODULE_CHANGE_PREPARE_TOOL_NAME, args: { moduleId: deploy.id } },
      (answers: Record<string, unknown>[]) => ({ name: MODULE_CHANGE_EDIT_TOOL_NAME, args: { stagingId: answers[0]!["stagingId"], file: "module.js", edits: [{ old_text: '"deploy failed"', new_text: '"deploy failed: " + ctx.inputs.stage' }] } }),
      (answers: Record<string, unknown>[]) => ({ name: MODULE_CHANGE_FREEZE_TOOL_NAME, args: { stagingId: answers[0]!["stagingId"], summary: "Names the stage." } }),
    ];
    const { provider, seen } = callingAgent((answers) => {
      const step = steps[answers.length];
      return step === undefined ? null : typeof step === "function" ? step(answers) : step;
    });

    const supervisor = supervisorOver(provider);
    await supervisor.runOnce();
    await supervisor.waitForIdle();

    expect(seen.starts[0]!.writeBridge?.moduleChanges).toBe(true);
    for (const tool of MODULE_CHANGE_TOOLS) expect(seen.listed, tool).toContain(tool);
    expect(seen.errors).toEqual([]);
    const run = listRunsForItem(handle.db, conversation.id as never)[0]!;
    const proposalId = seen.answers[2]!["proposalId"] as string;
    const resolved = resolveModuleChangeProposal(handle.db, proposalId, { itemId: conversation.id, runId: run.id, moduleId: deploy.id });
    expect(resolved.ok && resolved.proposal.change.code).toBe(CODE.replace('"deploy failed"', '"deploy failed: " + ctx.inputs.stage'));

    // The run is over: its staging area is gone, its proposal is not, and the module is as it was.
    expect(existsSync(seen.answers[0]!["directory"] as string)).toBe(false);
    const after = getModule(handle.db, deploy.id)!;
    expect({ code: after.code, tests: listModuleTests(handle.db, deploy.id), versions: listModuleVersions(handle.db, deploy.id).length }).toEqual(before);
  });

  it("are neither listed nor served on a pipeline step's run, even when called over the bridge directly", async () => {
    const deploy = saveDeploy();
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    let direct: unknown = null;
    const { provider, seen } = callingAgent(() => null, validImplementResult);
    const wrapped: AgentProvider = {
      ...provider,
      async *start(opts) {
        direct = await sendAgentWrite(opts.writeBridge!, { tool: MODULE_CHANGE_PREPARE_TOOL_NAME, args: { moduleId: deploy.id } });
        yield* provider.start(opts);
      },
    };

    const supervisor = supervisorOver(wrapped);
    await supervisor.runOnce();
    await supervisor.waitForIdle();

    expect(listRunsForItem(handle.db, item.id).length).toBeGreaterThan(0);
    expect(seen.starts[0]!.writeBridge?.moduleChanges).toBeUndefined();
    for (const tool of MODULE_CHANGE_TOOLS) expect(seen.listed, tool).not.toContain(tool);
    expect(direct).toMatchObject({ ok: false, code: "TOOL_NOT_SERVED" });
  });

  it("are refused on a learning review's credential, without reaching the staging service", async () => {
    const deploy = saveDeploy();
    const conversation = (await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/chat"), conversationId: null, body: "Fix Deploy.", attachmentIds: [], interrupt: false })).conversation;
    const supervisor = supervisorOver(callingAgent(() => null).provider);
    for (const tool of MODULE_CHANGE_TOOLS) {
      const answer = await supervisor.handleAgentWrite(conversation.id, { tool, args: { moduleId: deploy.id } }, [MEMORY_NOTE_TOOL_NAME, ...SKILL_WRITE_TOOLS]);
      expect(answer, tool).toMatchObject({ ok: false, code: "TOOL_NOT_SERVED" });
    }
  });
});
