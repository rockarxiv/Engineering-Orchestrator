import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  StepTeamSchema,
  uuidv7,
  type Agent,
  type AgentProvider,
  type AgentProviderStartOptions,
  type AgentWriteBridgeAddress,
  type AgentWriteTool,
  type Item,
  type RuntimeStatusView,
  type TeamDefinition,
} from "@eo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { saveActionDefinition } from "../db/repos/actionDefinitionsRepo.js";
import { createAgent, getAgent } from "../db/repos/agentsRepo.js";
import { createRoute } from "../db/repos/index.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { createStep, listStepsForPipeline } from "../db/repos/pipelineStepsRepo.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import { listTeamSessionsForItem } from "../db/repos/teamSessionsRepo.js";
import { changeTeam, getTeam, listTeamVersions } from "../db/repos/teamsRepo.js";
import { createTestItem, openMigratedTestDb, agentOfKind } from "../db/testHelpers.js";
import { setTeamMembersSettingsCommand } from "../ipc/declaredTeamCommands.js";
import { clearHandlerRegistry, registerHandler } from "../ipc/registry.js";
import { answerToolCall } from "../mcpHost/server.js";
import type { AgentWriteBridge } from "../mcp/writeBridge.js";
import { createClaudeProvider } from "../providers/claude.js";
import { createCodexProvider } from "../providers/codex.js";
import { CodexClient, dropWarmCodexThread } from "../providers/codexClient.js";
import { fakeAppServer, note } from "../testing/fakeCodexAppServer.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";
import type { ReportOnlyProviderAnswer } from "./teamSupervisor.js";

/**
 * EO's system agent setting a declared team's leader and member to a
 * runtime, model and reasoning through `team_member_settings_set` on
 * `eo_admin` (EO-900), and the team then running on what it set: each
 * turn through its own backend's real adapter — all Claude, all Codex and
 * mixed (invariant 12).
 */

const ROOMY = { globalConcurrency: 1, perAgentConcurrency: 2, perRepositoryConcurrency: 1 };
const WAIT = { timeout: 15_000 };
const CODEX_EXECUTABLE = "/opt/eo/runtimes/codex/bin/codex";

type Backend = "claude" | "codex";
type Script = (call: { agent: Agent; opts: AgentProviderStartOptions }) => unknown;

let handle: DbHandle;
let item: Item;
let scratch: string;
let lee: Agent;
let teamId: string;
let started: { agent: Agent; opts: AgentProviderStartOptions }[];
/** What crossed to a real backend, per turn, where the turn went through one. */
let crossed: { backend: Backend; agent: Agent; said: () => Promise<string>; schema: () => unknown }[];
/** The leader's answers, one per turn, in order. */
let leaderTurns: Script[];
/** What each member answers, by agent name. */
let members: Record<string, Script>;
const supervisors: RunSupervisor[] = [];

/** The ordinary provider: never started, since the team answers for the step. */
const ownerProvider: AgentProvider = {
  start: () => {
    throw new Error("The owner's own provider was started.");
  },
  resume: () => {
    throw new Error("The owner's own provider was resumed.");
  },
};

function scripted(agent: Agent, opts: AgentProviderStartOptions): unknown {
  const turn = agent.id === lee.id ? leaderTurns.shift() : members[agent.name];
  if (turn === undefined) throw new Error(`Nothing scripted for ${agent.name}'s turn.`);
  return turn({ agent, opts });
}

/** What a report-only member's `eo` server is started with, as `reportOnlyProviderForAgent` starts it. */
const PARTICIPANT_EO_MCP = { serverPath: "/app/eoServer.mjs", enableCommentTool: false, enableConfigTools: false, enableFullThread: false, enableMemoryNote: false };

/** One report-only Claude turn through the real adapter, over an SDK `query` answering `data`. */
function claudeTurn(agent: Agent, opts: AgentProviderStartOptions, data: unknown): ReturnType<AgentProvider["start"]> {
  const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
  const session = `sess-${uuidv7()}`;
  const runQuery = ((params: { prompt: unknown; options?: Record<string, unknown> }) => {
    calls.push({ prompt: params.prompt, options: params.options ?? {} });
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: session } as unknown as SDKMessage;
      yield { type: "result", subtype: "success", result: JSON.stringify(data), structured_output: data, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 10 }, session_id: session } as unknown as SDKMessage;
    })();
  }) as never;
  crossed.push({
    backend: "claude",
    agent,
    said: async () => {
      for await (const message of (calls[0]?.prompt ?? []) as AsyncIterable<SDKUserMessage>) {
        const content = message.message.content;
        return typeof content === "string" ? content : content.map((block) => ("text" in block ? block.text : "")).join("");
      }
      return typeof calls[0]?.prompt === "string" ? calls[0].prompt : "";
    },
    schema: () => (calls[0]?.options["outputFormat"] as { schema?: unknown } | undefined)?.schema,
  });
  return createClaudeProvider({ runQuery, enableCommentTool: false, reportOnly: true, eoMcp: PARTICIPANT_EO_MCP }).start(opts);
}

/** One report-only Codex turn through the real adapter and client, over an app-server child answering `data`. */
function codexTurn(agent: Agent, opts: AgentProviderStartOptions, data: unknown): ReturnType<AgentProvider["start"]> {
  const fake = fakeAppServer({ after: { "turn/start": [note.turnStarted(), note.agentMessage(JSON.stringify(data)), note.tokenUsage({ input: 10, output: 10 }), note.turnCompleted()] } });
  crossed.push({
    backend: "codex",
    agent,
    said: () => Promise.resolve(((fake.paramsOf("turn/start")?.["input"] as { text: string }[] | undefined) ?? []).map((part) => part.text).join("")),
    schema: () => fake.paramsOf("turn/start")?.["outputSchema"],
  });
  return createCodexProvider({
    executablePath: CODEX_EXECUTABLE,
    reportOnly: true,
    eoMcp: PARTICIPANT_EO_MCP,
    searchHookCommandPath: "/opt/eo/hook.mjs",
    searchHookTrust: async () => ({ key: "/<session-flags>/config.toml:pre_tool_use:0:0", hash: "sha256:abc123" }),
    codexHome: () => mkdtempSync(join(scratch, "codex-home-")),
    config: { model: agent.model ?? "gpt-5" },
    createCodex: () => new CodexClient({ executablePath: CODEX_EXECUTABLE, spawn: fake.spawn, shutdownGraceMs: 200 }),
  }).start(opts);
}

function reportOnlyProvider(agent: Agent, attemptId: string): ReportOnlyProviderAnswer {
  return {
    ok: true,
    cwd: join(scratch, attemptId),
    provider: {
      start: (opts) => {
        started.push({ agent, opts });
        const data = scripted(agent, opts);
        if (agent.provider === "claude") return claudeTurn(agent, opts, data);
        if (agent.provider === "codex") return codexTurn(agent, opts, data);
        throw new Error(`${agent.name} is on ${agent.provider}, which no backend here runs.`);
      },
    },
  };
}

/** A bridge that signs nothing: a report-only member's credential, as `reportOnlyProviderForAgent` needs one. */
const bridge: Pick<AgentWriteBridge, "tokenFor" | "close"> = {
  tokenFor: (itemId: string, writes?: readonly AgentWriteTool[], scope?: string): AgentWriteBridgeAddress =>
    writes === undefined ? { url: "http://127.0.0.1:1/agent-write", token: `${itemId}.mac` } : { url: "http://127.0.0.1:1/agent-write", token: `${itemId}~${writes.join(",")}${scope === undefined ? "" : `~${scope}`}.mac`, writes: [...writes] },
  close: async () => undefined,
};

function supervisor(): RunSupervisor {
  const made = createRunSupervisor({ db: handle.db, provider: ownerProvider, limits: ROOMY, reportOnlyProvider, teamPollMs: 5, agentWriteBridge: () => bridge as AgentWriteBridge });
  supervisors.push(made);
  return made;
}

/** The declared team as it is now. */
const team = (): TeamDefinition & { coordination: "leader" } => {
  const definition = getTeam(handle.db, teamId)?.definition;
  if (definition?.coordination !== "leader") throw new Error("The step's team is not leader-led.");
  return definition;
};

/**
 * Alignment, run as a leader-led team whose leader, Lee, assigns work to
 * Sasha. Both start on the built-in runtime; the team's range allows
 * Claude and Codex, a model of each and two reasoning levels.
 */
function setup(): void {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-team-settings-"));
  started = [];
  crossed = [];
  leaderTurns = [];
  members = {};
  createAgent(handle.db, { name: "Quinn", role: "qa", provider: "fake", instructions: "You check work." });
  createAgent(handle.db, { name: "Lee", role: "lead", provider: "fake", instructions: "You lead reviews." });
  createAgent(handle.db, { name: "Sasha", role: "sec", provider: "fake", instructions: "You find ways in." });
  const leaderTeam = StepTeamSchema.parse({ coordination: "leader", leader: { role: "lead", instructions: "Find out whether the export does what was asked." }, roles: ["sec"], limits: { maxRounds: 3 } });
  createStep(handle.db, { id: "check", pipelineId: "default" as never, position: -3, name: "Alignment", type: "agent", agentId: agentOfKind(handle.db, "qa"), entryAction: "alignment", team: leaderTeam });
  createStep(handle.db, { id: "rework", pipelineId: "default" as never, position: -2, name: "Rework", type: "user", agentId: null, entryAction: null });
  createStep(handle.db, { id: "accepted", pipelineId: "default" as never, position: -1, name: "Accepted", type: "user", agentId: null, entryAction: null });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "check", resultKey: "aligned", label: "Aligned", target: "accepted", position: 0 });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "check", resultKey: "gaps_found", label: "Gaps found", target: "rework", position: 1 });
  for (const role of ["qa", "lead"]) {
    const saved = saveActionDefinition(handle.db, {
      role,
      action: "alignment",
      results: [
        { key: "aligned", label: "Aligned", meaning: "Everything asked for is there." },
        { key: "gaps_found", label: "Gaps found", meaning: "Something asked for is missing." },
      ],
    });
    if (!saved.ok) throw new Error(`${role} action`);
  }
  teamId = listStepsForPipeline(handle.db, "default").find((step) => step.id === "check")!.teamId!;
  const changed = changeTeam(handle.db, teamId, {
    definition: { ...team(), modelRange: { runtimes: ["claude", "codex"], models: ["claude-sonnet-4-5", "gpt-5"], reasoning: ["high", "medium"] } },
    author: { kind: "person", personId: null },
  });
  if (!changed.ok) throw new Error(changed.reason);
  // The team's leader and member are its own agents (EO-897).
  lee = getAgent(handle.db, team().leader.agentId as Agent["id"])!;
  sasha = getAgent(handle.db, team().members[0]!.agentId as Agent["id"])!;
  item = createTestItem(handle.db, { type: "story", title: "Check the export", stepId: "check" });

  // The tool's channel, as the app registers it, on a machine with both runtimes installed and signed in.
  registerHandler("teams:setMembersSettings", (payload) => setTeamMembersSettingsCommand(handle.db, payload, async (provider) => signedIn(provider)), { exposeErrorDetails: true });
}

function signedIn(provider: string): RuntimeStatusView {
  return {
    id: provider,
    label: provider,
    publisher: "",
    termsUrl: "",
    source: "cache",
    path: `/opt/eo/runtimes/${provider}/bin/${provider}`,
    version: "1.0.0",
    packageName: null,
    packageVersion: null,
    auth: { state: "signed_in", method: null, kind: "unknown" } as RuntimeStatusView["auth"],
  };
}

let sasha: Agent;

afterEach(async () => {
  for (const made of supervisors.splice(0)) await made.shutdown();
  dropWarmCodexThread();
  clearHandlerRegistry();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

const MODEL: Record<Backend, string> = { claude: "claude-sonnet-4-5", codex: "gpt-5" };

/** The system agent's call, on `eo_admin`, as its turn's credential names it. */
async function setThroughTool(names: string[], backend: Backend): Promise<void> {
  const answer = await answerToolCall({ name: "team_member_settings_set", arguments: { teamId, members: names, provider: backend, model: MODEL[backend], reasoning: "medium" } }, "admin", true, undefined, undefined, agentOfKind(handle.db, "system"));
  expect(answer.isError, JSON.stringify(answer.content)).toBe(false);
}

const assign = { outcome: { decision: "assign", newMembers: [], assignments: [{ key: "csv", member: "Sasha", scope: "The csv code.", instructions: "Look at csv.", required: true }], note: "Sasha reads it." } };
const final = (contributions: string[]) => ({ outcome: { decision: "final", answer: { result: "aligned", summary: "The export does what was asked." }, contributions, disagreements: "None.", limitations: "Only read." } });
const reportIds = (): string[] =>
  (listTeamSessionsForItem(handle.db, item.id).at(-1)?.attempts ?? []).flatMap((attempt) => (attempt.assignmentKey !== "leader" && attempt.status === "completed" && attempt.supersededBy === null && attempt.reportCommentId !== null ? [attempt.reportCommentId] : []));

describe("a team set through team_member_settings_set runs on what it set (EO-900, invariant 12)", () => {
  for (const [leaderOn, memberOn] of [
    ["claude", "claude"],
    ["codex", "codex"],
    ["codex", "claude"],
    ["claude", "codex"],
  ] as const) {
    it(`the system agent sets the leader to ${leaderOn} and the member to ${memberOn}, and each turn reaches its own backend's adapter`, async () => {
      setup();
      if (leaderOn === memberOn) await setThroughTool(["Lee", "Sasha"], leaderOn);
      else {
        await setThroughTool(["lee"], leaderOn);
        await setThroughTool(["SASHA"], memberOn);
      }
      // Each call is one version, the system agent's; the team's agents are the same ones, on the new settings.
      const versions = listTeamVersions(handle.db, teamId);
      expect(versions.slice(2).map((version) => version.author.kind)).toEqual(leaderOn === memberOn ? ["system"] : ["system", "system"]);
      expect(team().leader.agentId).toBe(lee.id);
      expect(team().members.map((member) => member.agentId)).toEqual([sasha.id]);
      lee = getAgent(handle.db, lee.id)!;
      sasha = getAgent(handle.db, sasha.id)!;
      expect([lee.provider, lee.model, sasha.provider, sasha.model]).toEqual([leaderOn, MODEL[leaderOn], memberOn, MODEL[memberOn]]);

      leaderTurns = [() => assign, () => final(reportIds())];
      members = { Sasha: () => ({ outcome: { report: "The CSV escaping holds." } }) };
      await supervisor().runOnce();

      await vi.waitFor(() => expect(getItem(handle.db, item.id)?.stepId).toBe("accepted"), WAIT);
      expect(started.map((one) => one.agent.id)).toEqual([lee.id, sasha.id, lee.id]);
      expect(crossed.map((one) => [one.agent.id, one.backend])).toEqual([
        [lee.id, leaderOn],
        [sasha.id, memberOn],
        [lee.id, leaderOn],
      ]);
      expect(new Set(crossed.map((one) => one.backend))).toEqual(new Set([leaderOn, memberOn]));
      for (const [index, one] of crossed.entries()) {
        const heading = /## Your assignment: \w+|## What you lead/.exec(started[index]!.opts.context)![0];
        expect(await one.said(), `${one.backend} turn ${index}`).toContain(heading);
        expect(one.schema(), `${one.backend} turn ${index}`).toBeTypeOf("object");
      }
      expect(listRunsForItem(handle.db, item.id).filter((run) => run.status === "failed")).toEqual([]);
    });
  }
});
