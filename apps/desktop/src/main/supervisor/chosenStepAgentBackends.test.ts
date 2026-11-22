import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRATCH_KIND, type Agent, type AgentProvider } from "@eo/core";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createAgent, createWorkspace, listRunsForItem, listStepsForPipeline } from "../db/repos/index.js";
import { createDefaultProject } from "../db/repos/projectsRepo.js";
import { createTestItem, giveSeededDelivery, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { savePipeline } from "../ipc/configCommands.js";
import { listPipelineStepViews } from "../ipc/domainQueries.js";
import { createClaudeProvider } from "../providers/claude.js";
import { createCodexProvider } from "../providers/codex.js";
import { CodexClient, dropWarmCodexThread } from "../providers/codexClient.js";
import { validImplementResult } from "../providers/fixtures.js";
import { fakeAppServer, note, type FakeAppServer } from "../testing/fakeCodexAppServer.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * A step's agent can be chosen on either backend and is dispatched there
 * (EO-876, invariant 12).
 *
 * Two agents of one kind, an Implementer on Claude and one on Codex. A
 * person chooses one for the Implement step through `pipeline:save` —
 * the channel the assistant's Publish and `pipeline_save` both go
 * through — and the step's work runs on that agent and that backend,
 * through **the real adapters**: the Claude provider over a stubbed
 * `query`, the Codex provider and client over a stubbed app-server. A
 * provider that only recorded which agent it was handed would prove the
 * scheduler's choice and nothing about either backend.
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const EXECUTABLE = "/opt/eo/runtimes/codex/bin/codex";

type BackendName = "claude" | "codex";

let handle: DbHandle;
let directories: string[];

beforeEach(() => {
  handle = openMigratedTestDb();
  directories = [];
});

afterEach(() => {
  dropWarmCodexThread();
  handle.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function directory(prefix: string): string {
  const made = mkdtempSync(join(tmpdir(), prefix));
  directories.push(made);
  return made;
}

/** Both backends, each answering one implement turn, recording what crossed. */
function backends() {
  const claudeCalls: { prompt: AsyncIterable<SDKUserMessage>; options: { outputFormat?: { schema?: unknown } } }[] = [];
  const messages = [
    { type: "system", subtype: "init", session_id: "sess_1" },
    {
      type: "result",
      subtype: "success",
      result: JSON.stringify(validImplementResult),
      structured_output: validImplementResult,
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 10 },
      session_id: "sess_1",
    },
  ] as unknown as SDKMessage[];
  const runQuery = ((call: (typeof claudeCalls)[number]) => {
    claudeCalls.push(call);
    return (async function* () {
      for (const message of messages) yield message;
    })();
  }) as never;
  const claude = createClaudeProvider({ runQuery, enableCommentTool: false });

  const fakes: FakeAppServer[] = [];
  // A fresh fake app-server per turn: its scenario is fixed per process.
  const codex = createCodexProvider({ executablePath: EXECUTABLE, createCodex: () => new CodexClient({ executablePath: EXECUTABLE, spawn: next().spawn, shutdownGraceMs: 200 }) });
  function next(): FakeAppServer {
    const fake = fakeAppServer({
      model: "gpt-6.1-sol",
      after: { "turn/start": [note.turnStarted(), note.agentMessage(JSON.stringify(validImplementResult)), note.tokenUsage({ input: 10, output: 10 }), note.turnCompleted()] },
    });
    fakes.push(fake);
    return fake;
  }

  const reached: BackendName[] = [];
  const provider = (agent: Agent): AgentProvider => {
    const real = agent.provider === "codex" ? codex : claude;
    return {
      ...real,
      start: (opts) => {
        reached.push(agent.provider as BackendName);
        return real.start(opts);
      },
    };
  };
  return { provider, reached, claudeCalls, fakes };
}

/** The Implement step names this agent, chosen through `pipeline:save` as a person's Publish chooses it. */
function chooseFor(stepId: string, agent: Agent): void {
  const graph = listPipelineStepViews(handle.db, { pipelineId: "default" });
  const saved = savePipeline(handle.db, undefined, {
    pipelineId: "default",
    steps: graph.steps.map((step) => (step.id === stepId ? { ...step, agentId: agent.id } : step)),
    routes: graph.routes,
    entryStepId: graph.entryStepId,
  });
  expect(saved.problems.filter((problem) => problem.severity === "error")).toEqual([]);
  expect(saved.saved).toBe(true);
}

describe.each<BackendName>(["claude", "codex"])("an implement step whose chosen agent is on %s", (name) => {
  it("runs on that agent, through that backend's adapter, and never on the other agent of its kind", async () => {
    const workspace = createWorkspace(handle.db, { kind: SCRATCH_KIND } as Parameters<typeof createWorkspace>[1]);
    const project = createDefaultProject(handle.db, workspace, "EO");
    giveSeededDelivery(handle.db, project.id);
    const onClaude = createAgent(handle.db, { name: "Implementer on Claude", role: "implementer", provider: "claude", model: null, instructions: "Build it." });
    const onCodex = createAgent(handle.db, { name: "Implementer on Codex", role: "implementer", provider: "codex", model: null, instructions: "Build it." });
    const chosen = name === "claude" ? onClaude : onCodex;
    const other = name === "claude" ? onCodex : onClaude;
    const implement = listStepsForPipeline(handle.db, "default").find((step) => step.type === "agent" && step.entryAction === "implement")!;
    chooseFor(implement.id, chosen);
    const item = createTestItem(handle.db, { type: "story", title: "Rate limiting", stepId: implement.id, spec: REVIEWABLE_SPEC, workspaceId: workspace.id, projectId: project.id });
    const over = backends();

    await createRunSupervisor({ db: handle.db, provider: over.provider, limits: LIMITS, noDiskRoot: directory("eo-876-none-"), scratchRoot: directory("eo-876-scratch-") }).runOnce();

    const runs = listRunsForItem(handle.db, item.id);
    expect(runs.map((run) => run.agentId)).toEqual([chosen.id]);
    expect(runs.some((run) => run.agentId === other.id)).toBe(false);
    expect(runs[0]?.provider).toBe(name);
    expect(runs[0]?.status).toBe("succeeded");
    // It reached its own backend, and only that one, with the answer schema.
    expect(over.reached).toEqual([name]);
    if (name === "claude") {
      expect(over.claudeCalls).toHaveLength(1);
      expect(over.fakes.flatMap((fake) => fake.launches)).toHaveLength(0);
      expect(over.claudeCalls[0]!.options.outputFormat?.schema).toBeDefined();
    } else {
      expect(over.claudeCalls).toHaveLength(0);
      expect(over.fakes.flatMap((fake) => fake.launches)).toHaveLength(1);
      expect(over.fakes[0]!.paramsOf("turn/start")?.["outputSchema"]).toBeDefined();
    }
  });
});
