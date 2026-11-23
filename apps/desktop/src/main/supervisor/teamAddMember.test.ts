import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ADMIN_MCP_SERVER_NAME,
  McpServerDraftSchema,
  SkillDraftSchema,
  StepTeamSchema,
  uuidv7,
  type Agent,
  type AgentEvent,
  type AgentProvider,
  type AgentProviderStartOptions,
  type AgentWriteBridgeAddress,
  type AgentWriteTool,
  type Item,
  type TeamDefinition,
} from "@eo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { saveActionDefinition } from "../db/repos/actionDefinitionsRepo.js";
import { createAgent, getAgent, listAgents } from "../db/repos/agentsRepo.js";
import { saveCliTool } from "../db/repos/cliToolsRepo.js";
import { listCommentsForItem } from "../db/repos/commentsRepo.js";
import { createRoute } from "../db/repos/index.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { saveMcpServer } from "../db/repos/mcpServersRepo.js";
import { createStep, getPipeline, listRoutesForPipeline, listStepsForPipeline } from "../db/repos/pipelineStepsRepo.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import { saveSkill } from "../db/repos/skillsRepo.js";
import { listTeamSessionsForItem } from "../db/repos/teamSessionsRepo.js";
import { agentToolSurfaces, changeTeam, getTeam, listTeamVersions, restoreTeamVersion, sessionTeamFor, setTeamLocked } from "../db/repos/teamsRepo.js";
import { createTestItem, openMigratedTestDb, agentOfKind } from "../db/testHelpers.js";
import { savePipeline } from "../ipc/configCommands.js";
import type { AgentWriteBridge } from "../mcp/writeBridge.js";
import { createClaudeProvider } from "../providers/claude.js";
import { createCodexProvider } from "../providers/codex.js";
import { CodexClient, dropWarmCodexThread } from "../providers/codexClient.js";
import { fakeAppServer, note } from "../testing/fakeCodexAppServer.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";
import type { ReportOnlyProviderAnswer } from "./teamSupervisor.js";

/**
 * A leader adding a member to its declared team (EO-883), end to end
 * through the supervisor: the member is created as a real agent of the
 * team's member kind, only with what the team's pool and range allow, the
 * team gets a version recorded as the leader's on the item, the item is
 * told, and the leader may assign to it in the same answer. Every refusal
 * creates nothing, is said on the item and is told to the leader's next
 * turn. The last part runs the leader and the member it adds on
 * different backends, through each backend's real adapter.
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
let realAdapters: boolean;
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

async function* says(data: unknown): AsyncGenerator<AgentEvent> {
  yield { type: "thread_started", threadId: `thread-${uuidv7()}` };
  yield { type: "result", data };
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
        if (realAdapters && agent.provider === "claude") return claudeTurn(agent, opts, data);
        if (realAdapters && agent.provider === "codex") return codexTurn(agent, opts, data);
        return says(data)[Symbol.asyncIterator]() as unknown as ReturnType<AgentProvider["start"]>;
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
 * Alignment, run as a leader-led team whose leader, Lee, may assign work
 * to Sasha, and add a member from a pool of `gh`, the `docs` server and
 * the `triage` skill, on Claude or Codex, on the two models and two
 * reasoning levels its range declares, up to three members.
 */
function setup(leaderOn: Backend = "claude"): void {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-team-add-"));
  started = [];
  crossed = [];
  leaderTurns = [];
  members = {};
  realAdapters = false;
  createAgent(handle.db, { name: "Quinn", role: "qa", provider: "claude", instructions: "You check work." });
  lee = createAgent(handle.db, { name: "Lee", role: "lead", provider: leaderOn, model: leaderOn === "codex" ? "gpt-5" : null, instructions: "You lead reviews." });
  createAgent(handle.db, { name: "Sasha", role: "sec", provider: "claude", instructions: "You find ways in." });
  const leaderTeam = StepTeamSchema.parse({ coordination: "leader", leader: { role: "lead", instructions: "Find out whether the export does what was asked." }, roles: ["sec"], limits: { maxRounds: 3 } });
  createStep(handle.db, { id: "check", pipelineId: "default" as never, position: -3, name: "Alignment", type: "agent", agentId: agentOfKind(handle.db, "qa"), entryAction: "alignment", team: leaderTeam });
  createStep(handle.db, { id: "rework", pipelineId: "default" as never, position: -2, name: "Rework", type: "user", agentId: null, entryAction: null });
  createStep(handle.db, { id: "accepted", pipelineId: "default" as never, position: -1, name: "Accepted", type: "user", agentId: null, entryAction: null });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "check", resultKey: "aligned", label: "Aligned", target: "accepted", position: 0 });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "check", resultKey: "gaps_found", label: "Gaps found", target: "rework", position: 1 });
  const saved = saveActionDefinition(handle.db, {
    role: "qa",
    action: "alignment",
    description: "Check the work against what was asked for.",
    results: [
      { key: "aligned", label: "Aligned", meaning: "Everything asked for is there." },
      { key: "gaps_found", label: "Gaps found", meaning: "Something asked for is missing." },
    ],
  });
  if (!saved.ok) throw new Error("action");
  // The leader's kind answers the step too, as Publish requires of a team's leader.
  if (!saveActionDefinition(handle.db, { role: "lead", action: "alignment", results: [{ key: "aligned", meaning: "Aligned." }, { key: "gaps_found", meaning: "Gaps." }] }).ok) throw new Error("lead action");

  // The catalogue the pool names, and one tool it does not.
  for (const command of ["gh", "kubectl"]) if (!saveCliTool(handle.db, { name: `${command} CLI`, command, description: "" }).ok) throw new Error(command);
  for (const name of ["docs", "billing"]) if (!saveMcpServer(handle.db, McpServerDraftSchema.parse({ name, transport: "stdio", command: `${name}-mcp` })).ok) throw new Error(name);
  for (const name of ["Triage", "Deploy"]) if (!saveSkill(handle.db, SkillDraftSchema.parse({ name, description: `How to ${name}.`, body: "Read it." })).ok) throw new Error(name);

  teamId = listStepsForPipeline(handle.db, "default").find((step) => step.id === "check")!.teamId!;
  const declared = team();
  const changed = changeTeam(handle.db, teamId, {
    definition: {
      ...declared,
      toolPool: { cliTools: ["gh"], mcpServers: ["docs"], skills: ["triage"] },
      modelRange: { runtimes: ["claude", "codex"], models: ["claude-sonnet-4-5", "gpt-5"], reasoning: ["high", "medium"] },
      memberCap: 3,
    },
    author: { kind: "person", personId: null },
  });
  if (!changed.ok) throw new Error(changed.reason);
  item = createTestItem(handle.db, { type: "story", title: "Check the export", stepId: "check" });
}

afterEach(async () => {
  for (const made of supervisors.splice(0)) await made.shutdown();
  dropWarmCodexThread();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

const NELL = { name: "Nell", kind: "sec", instructions: "You read the export's CSV escaping.\nNothing else.", tools: { cliTools: ["gh"], mcpServers: ["docs"], skills: ["triage"] }, runtime: "codex", model: "gpt-5", reasoning: "high" };

const assignWith = (newMembers: unknown[], assignments: { key: string; member: string }[]) => ({
  outcome: { decision: "assign", newMembers, assignments: assignments.map((one) => ({ scope: `The ${one.key} code.`, instructions: `Look at ${one.key}.`, required: true, ...one })), note: "Nobody here reads CSV." },
});
const final = (contributions: string[]) => ({ outcome: { decision: "final", answer: { result: "aligned", summary: "The export does what was asked." }, contributions, disagreements: "None.", limitations: "Only read." } });
const report = (text: string) => ({ outcome: { report: text } });

/** The current accepted reports of this item's session, by comment id. */
const reportIds = (): string[] =>
  (listTeamSessionsForItem(handle.db, item.id).at(-1)?.attempts ?? []).flatMap((attempt) => (attempt.assignmentKey !== "leader" && attempt.status === "completed" && attempt.supersededBy === null && attempt.reportCommentId !== null ? [attempt.reportCommentId] : []));
const bodies = () => listCommentsForItem(handle.db, item.id).map((comment) => comment.body);
const agentNamed = (name: string) => listAgents(handle.db).find((agent) => agent.name === name);
const leaderTurnsStarted = () => started.filter((one) => one.agent.id === lee.id);

describe("a leader adds a member to its team (EO-883)", () => {
  it("creates it as a real agent of the team's kind with only what it asked for from the pool, adds it as the leader's version on the item, says so, and runs the assignment it gave it in the same answer", async () => {
    setup();
    const leaderBefore = { agent: getAgent(handle.db, lee.id), tools: agentToolSurfaces(handle.db, [lee.id]) };
    const versionsBefore = listTeamVersions(handle.db, teamId).length;
    leaderTurns = [() => assignWith([NELL], [{ key: "csv", member: "Nell" }]), () => final(reportIds())];
    members = { Nell: () => report("The CSV escaping holds.") };
    await supervisor().runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    const nell = agentNamed("Nell")!;
    expect(nell).toMatchObject({ role: "sec", provider: "codex", model: "gpt-5", instructions: "You read the export's CSV escaping.\nNothing else.", enabled: true, projectId: null });
    expect(nell.config).toEqual({ reasoningEffort: "high" });
    expect(agentToolSurfaces(handle.db, [nell.id])[nell.id]).toEqual({ cliTools: ["gh"], mcpServers: ["docs"], skills: ["triage"] });
    // The assignment ran as Nell, in the same session.
    expect(started.filter((one) => one.agent.id !== lee.id).map((one) => one.agent.id)).toEqual([nell.id]);
    expect(started.find((one) => one.agent.id === nell.id)?.opts.context).toContain("Look at csv.");

    // The team: Nell for good, in one new version recorded as Lee's on this item.
    expect(team().members.map((member) => member.agentId)).toEqual([agentOfKind(handle.db, "sec"), nell.id]);
    const versions = listTeamVersions(handle.db, teamId);
    expect(versions).toHaveLength(versionsBefore + 1);
    expect(versions.at(-1)?.author).toEqual({ kind: "leader", agentId: lee.id, itemId: item.id });

    // The item is told who, with what.
    const said = bodies().find((body) => body.includes("added a member to the team"))!;
    expect(said).toContain("Lee added a member to the team");
    expect(said).toContain("**Nell**, a sec agent on codex, model gpt-5, reasoning high");
    expect(said).toContain("CLI tools `gh`; MCP servers `docs`; skills `triage`");
    expect(said).toContain("> You read the export's CSV escaping.\n> Nothing else.");

    // The leader's own surface is unchanged (invariant 11).
    expect({ agent: getAgent(handle.db, lee.id), tools: agentToolSurfaces(handle.db, [lee.id]) }).toEqual(leaderBefore);
    // It was offered the pool and the range, and the names were not held to the members it had.
    const schema = JSON.stringify(leaderTurnsStarted()[0]!.opts.outputSchema);
    expect(schema).toContain('"newMembers"');
    expect(schema).toContain('"enum":["gh"]');
    expect(schema).toContain('"enum":["claude","codex"]');
    expect(schema).not.toContain('"enum":["Sasha"]');
    expect(leaderTurnsStarted()[0]!.opts.context).toContain("you may add one in `newMembers`");
    // Its second turn is offered Nell as a member.
    expect(leaderTurnsStarted()[1]!.opts.context).toContain("- Nell — a sec agent on codex, model gpt-5, reasoning high: You read the export's CSV escaping.");
  });

  it("is a member like any other: a later session assigns to it, a restore from before it was added takes it off, and so does the assistant's draft", async () => {
    setup();
    leaderTurns = [() => assignWith([NELL], [{ key: "csv", member: "Nell" }]), () => final(reportIds())];
    members = { Nell: () => report("Fine.") };
    await supervisor().runOnce();
    const nell = agentNamed("Nell")!;
    expect(sessionTeamFor(handle.db, teamId)).toMatchObject({ memberAgentIds: [agentOfKind(handle.db, "sec"), nell.id] });

    // A later session, on another item, offers it and runs an assignment to it.
    item = createTestItem(handle.db, { type: "story", title: "Check the import", stepId: "check" });
    started = [];
    leaderTurns = [
      ({ opts }) => {
        expect(opts.context).toContain("- Nell — a sec agent on codex");
        return assignWith([], [{ key: "again", member: "Nell" }]);
      },
      () => final(reportIds()),
    ];
    await supervisor().runOnce();
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    expect(started.filter((one) => one.agent.id === nell.id)).toHaveLength(1);

    // A person restores the version from before it: Nell is no member, and still an agent.
    const before = listTeamVersions(handle.db, teamId).at(-2)!;
    expect(restoreTeamVersion(handle.db, teamId, before.number, { personId: null }).ok).toBe(true);
    expect(team().members.map((member) => member.agentId)).not.toContain(nell.id);
    expect(getAgent(handle.db, nell.id)?.deletedAt).toBeNull();

    // Back again, then taken off by an assistant's draft a person publishes.
    const latest = listTeamVersions(handle.db, teamId).at(-2)!;
    expect(restoreTeamVersion(handle.db, teamId, latest.number, { personId: null }).ok).toBe(true);
    expect(team().members.map((member) => member.agentId)).toContain(nell.id);
    const steps = listStepsForPipeline(handle.db, "default");
    const published = savePipeline(handle.db, undefined, {
      pipelineId: "default",
      steps: steps.map((step) => ({ ...step })),
      routes: listRoutesForPipeline(handle.db, "default"),
      entryStepId: getPipeline(handle.db, "default")?.entryStepId ?? null,
      teams: [{ id: teamId, definition: { ...team(), members: team().members.filter((member) => member.agentId !== nell.id) } }],
    } as never);
    expect(published.saved, JSON.stringify(published)).toBe(true);
    expect(team().members.map((member) => member.agentId)).not.toContain(nell.id);
    expect(listTeamVersions(handle.db, teamId).at(-1)?.author).toEqual({ kind: "assistant" });
  });

  const REFUSALS: { name: string; addition: Record<string, unknown>; arrange?: () => void; why: string }[] = [
    { name: "a CLI tool outside the pool", addition: { tools: { cliTools: ["kubectl"], mcpServers: [], skills: [] } }, why: 'the CLI tool "kubectl"' },
    { name: "an MCP server outside the pool", addition: { tools: { cliTools: [], mcpServers: ["billing"], skills: [] } }, why: 'the MCP server "billing"' },
    { name: "a skill outside the pool", addition: { tools: { cliTools: [], mcpServers: [], skills: ["deploy"] } }, why: 'the skill "deploy"' },
    { name: "eo_admin", addition: { tools: { cliTools: [], mcpServers: [ADMIN_MCP_SERVER_NAME], skills: [] } }, why: `the MCP server "${ADMIN_MCP_SERVER_NAME}"` },
    { name: "a runtime outside the range", addition: { runtime: "gemini" }, why: 'its runtime "gemini" is not in the team\'s model range' },
    { name: "a model outside the range", addition: { model: "gpt-4o" }, why: 'its model "gpt-4o" is not in the team\'s model range' },
    { name: "a reasoning level outside the range", addition: { reasoning: "xhigh" }, why: 'its reasoning "xhigh" is not in the team\'s model range' },
    { name: "a name another agent has", addition: { name: "quinn" }, why: 'another agent is already called "quinn"' },
    { name: "the system kind", addition: { kind: "system" }, why: "EO's system agent can never be a team member" },
    {
      name: "a member over the cap",
      addition: {},
      arrange: () => {
        const filler = createAgent(handle.db, { name: "Filler", role: "sec", provider: "claude", instructions: "Spare." });
        const filler2 = createAgent(handle.db, { name: "Filler 2", role: "sec", provider: "claude", instructions: "Spare." });
        const changed = changeTeam(handle.db, teamId, { definition: { ...team(), members: [...team().members, { agentId: filler.id }, { agentId: filler2.id }] }, author: { kind: "person", personId: null } });
        if (!changed.ok) throw new Error(changed.reason);
      },
      why: "the team has 3 members, and its cap is 3",
    },
    { name: "a locked team", addition: {}, arrange: () => void setTeamLocked(handle.db, teamId, true), why: "is locked: a person must unlock it before a member can be added" },
  ];

  for (const refusal of REFUSALS) {
    it(`refuses ${refusal.name}: nothing is created, the item is told why, and so is the leader's next turn`, async () => {
      setup();
      refusal.arrange?.();
      const agentsBefore = listAgents(handle.db).map((agent) => agent.id);
      const versionsBefore = listTeamVersions(handle.db, teamId).length;
      const asked = { ...NELL, ...refusal.addition };
      leaderTurns = [
        () => assignWith([asked], [{ key: "csv", member: String(asked.name) }]),
        ({ opts }) => {
          expect(opts.context).toContain("What EO refused of your last request:");
          expect(opts.context).toContain(refusal.why);
          return assignWith([], [{ key: "auth", member: "Sasha" }]);
        },
        () => final(reportIds()),
      ];
      members = { Sasha: () => report("Login fine.") };
      await supervisor().runOnce();

      expect(leaderTurnsStarted()).toHaveLength(3);
      expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
      expect(listAgents(handle.db).map((agent) => agent.id)).toEqual(agentsBefore);
      expect(listTeamVersions(handle.db, teamId)).toHaveLength(versionsBefore);
      const refused = bodies().find((body) => body.startsWith("EO refused"))!;
      expect(refused).toContain(`**new member "${String(asked.name)}"**: EO did not add it, and created nothing`);
      expect(refused).toContain(refusal.why);
      // The assignment to it was refused too: it is no member.
      expect(refused).toContain(`**csv**: "${String(asked.name)}" is not a member of this team`);
      expect(bodies().some((body) => body.includes("added a member to the team"))).toBe(false);
    });
  }
});

describe("a leader and the member it adds on different backends (EO-883, invariant 12)", () => {
  for (const [leaderOn, memberOn] of [
    ["codex", "claude"],
    ["claude", "codex"],
  ] as const) {
    it(`a leader on ${leaderOn} adds a member on ${memberOn} and assigns to it, each through its own backend's adapter`, async () => {
      setup(leaderOn);
      realAdapters = true;
      const asked = { ...NELL, runtime: memberOn, model: memberOn === "codex" ? "gpt-5" : "claude-sonnet-4-5", reasoning: "medium" };
      leaderTurns = [() => assignWith([asked], [{ key: "csv", member: "Nell" }]), () => final(reportIds())];
      members = { Nell: () => report("The CSV escaping holds.") };
      await supervisor().runOnce();

      await vi.waitFor(() => expect(getItem(handle.db, item.id)?.stepId).toBe("accepted"), WAIT);
      const nell = agentNamed("Nell")!;
      expect(nell).toMatchObject({ provider: memberOn, model: asked.model });
      expect(nell.config).toEqual(memberOn === "codex" ? { reasoningEffort: "medium" } : { effort: "medium" });
      expect(started.map((one) => one.agent.id)).toEqual([lee.id, nell.id, lee.id]);
      // Each turn reached its own agent's backend, carrying its own context and an answer schema.
      expect(crossed.map((one) => [one.agent.id, one.backend])).toEqual([
        [lee.id, leaderOn],
        [nell.id, memberOn],
        [lee.id, leaderOn],
      ]);
      for (const [index, one] of crossed.entries()) {
        const heading = /## Your assignment: \w+|## What you lead/.exec(started[index]!.opts.context)![0];
        expect(await one.said(), `${one.backend} turn ${index}`).toContain(heading);
        expect(one.schema(), `${one.backend} turn ${index}`).toBeTypeOf("object");
      }
      // The leader was offered newMembers by its own backend's schema.
      expect(JSON.stringify(crossed[0]!.schema())).toContain('"newMembers"');
      expect(listRunsForItem(handle.db, item.id).filter((run) => run.status === "failed")).toEqual([]);
      expect(team().members.map((member) => member.agentId)).toContain(nell.id);
      expect(bodies().some((body) => body.includes(`**Nell**, a sec agent on ${memberOn}`))).toBe(true);
    });
  }
});
