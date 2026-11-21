import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ADMIN_MCP_SERVER_NAME,
  AssistOutputSchema,
  FOLDER_KIND,
  GIT_WORKTREE_KIND,
  developerRegistry,
  outputSchemaFor,
  pageDescriptorFor,
  TEAM_PARTICIPANT_ACTION,
  uuidv7,
  type Agent,
  type AgentEvent,
  type AgentProvider,
  type AgentProviderStartOptions,
  type AgentWriteBridgeAddress,
  type AgentWriteTool,
  type IpcChannel,
  type Item,
  type LeaderTeam,
  type StepTeam,
  type Uuid,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeProvider } from "../../providers/claude.js";
import { createCodexProvider } from "../../providers/codex.js";
import { CodexClient, dropWarmCodexThread } from "../../providers/codexClient.js";
import { fakeAppServer, note, type FakeAppServer } from "../../testing/fakeCodexAppServer.js";
import type { DbHandle } from "../../db/client.js";
import { createAgent, listAgents, updateAgent } from "../../db/repos/agentsRepo.js";
import { adoptPipeline, appendRunEvent, getPipelineOrigin, openUpdateConflict } from "../../db/repos/index.js";
import { listCommentsForItem, postComment } from "../../db/repos/commentsRepo.js";
import { listReviewVerdicts } from "../../db/repos/index.js";
import { getItem } from "../../db/repos/itemsRepo.js";
import { getItemType } from "../../db/repos/itemTypesRepo.js";
import { getPipeline, listRoutesForPipeline, listStepsForPipeline } from "../../db/repos/pipelineStepsRepo.js";
import { addWorkspaceToProject, createProject } from "../../db/repos/projectsRepo.js";
import { createWorkspace } from "../../db/repos/workspacesRepo.js";
import { createRun, listRunsForItem, updateRun } from "../../db/repos/runsRepo.js";
import { listTeamSessionsForItem } from "../../db/repos/teamSessionsRepo.js";
import { listTransitionsForItem } from "../../db/repos/transitionsRepo.js";
import { createTestItem, openMigratedTestDb } from "../../db/testHelpers.js";
import { loadTemplateHistory, type TemplateHistory } from "../../gallery/history.js";
import { templateHistoryUpTo } from "../../gallery/historyTestHelpers.js";
import { backfillPipelineOrigins } from "../../gallery/origins.js";
import { applyTemplateUpdates } from "../../gallery/templateUpdates.js";
import { readAssistDraftForPublish, sendToAssist } from "../../ipc/assistCommands.js";
import { DEFAULT_GUARD_CONFIG, savePipeline, storedGraphProblems } from "../../ipc/configCommands.js";
import { handleIpcRequest } from "../../ipc/handleRequest.js";
import { clearHandlerRegistry } from "../../ipc/registry.js";
import { sectionLockFor } from "../../managed/locks.js";
import { assistAgent, postAssistReply } from "../../roles/assist.js";
import { ASSIST_ACTION } from "../../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../../roles/proposal.js";
import { BUILTIN_RUNNERS } from "./builtins.js";
import { developerSectionRenderers } from "./sections.js";
import { createRoleWiring } from "./wiring.js";
import { syncRolePrompts } from "../../roles/prompts.js";
import type { AgentWriteBridge } from "../../mcp/writeBridge.js";
import { registryForItem } from "../../registry.js";
import { createRunSupervisor, type RunSupervisor } from "../../supervisor/runSupervisor.js";
import { MEMBER_NO_BRIDGE } from "../../supervisor/teamParticipants.js";
import type { WorkspaceKind } from "../../supervisor/workspaceKind.js";
import { useWorkspaceKinds } from "../../workspaceKinds.js";

/**
 * The bundled software template's Review step as a team (EO-868): a
 * leader-led team of focused reviewers, in isolated mode, run end to end
 * through the supervisor on the Delivery pipeline a fresh installation
 * has once its first launch brought it to the template's newest version.
 *
 * Mocked: what each backend answers, scripted per turn. Real: the two
 * adapters a Claude or Codex agent is dispatched through — the Claude
 * provider over a stubbed SDK `query`, and the Codex provider and client
 * over a stubbed `codex app-server` child process — so a turn's
 * instructions, context and answer schema cross each backend's own
 * delivery, and its answer comes back through each backend's own
 * parsing (invariant 12). Real too: the template, the seeded agents and
 * their prompts, the developer pack's review schema, verdict and routing,
 * the team supervisor and the member copies (on no disk, the kind an
 * item without a repository works in).
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "resources", "gallery");
const CRITERIA = ["A key over its limit gets a 429", "The 429 carries a Retry-After header", "The limit is configurable per key"];
const CODEX_EXECUTABLE = "/opt/eo/runtimes/codex/bin/codex";
const DIFF = "diff --git a/src/limit.ts b/src/limit.ts\n+export function limit(key: string) { return counts[key]++ > 100 ? 429 : 200; }";

type Backend = "claude" | "codex";
interface Roster {
  name: string;
  /** The backends of the project's reviewer agents, in staffing order: the leader is the first. */
  reviewers: Backend[];
}
const ROSTERS: Roster[] = [
  { name: "every member on Claude", reviewers: ["claude"] },
  { name: "every member on Codex", reviewers: ["codex"] },
  { name: "members on both backends", reviewers: ["claude", "codex"] },
];

interface Started {
  agent: Agent;
  opts: AgentProviderStartOptions;
}

/** What a turn answers, given who it is and what it was told. */
type Script = (turn: { agent: Agent; opts: AgentProviderStartOptions; leader: boolean; assignment: string | null }) => unknown;

/** What reached a backend on one turn: the backend that was reached, the turn's text as it crossed, and the answer schema it was handed. */
interface Crossed {
  backend: Backend;
  agent: Agent;
  said: () => Promise<string>;
  schema: () => unknown;
}

let handle: DbHandle;
let scratch: string;
let started: Started[];
let crossed: Crossed[];
let script: Script;
const supervisors: RunSupervisor[] = [];

async function* says(data: unknown, afterMs = 0): AsyncGenerator<AgentEvent> {
  yield { type: "thread_started", threadId: `thread-${uuidv7()}` };
  // A member's turn takes a moment, so the passes overlap as they do on a real backend.
  if (afterMs > 0) await new Promise((resolve) => setTimeout(resolve, afterMs));
  yield { type: "result", data };
}

/** One Claude turn through the real adapter, over an SDK `query` that answers `data` as structured output. */
function claudeTurn(agent: Agent, opts: AgentProviderStartOptions, data: unknown, afterMs: number): ReturnType<AgentProvider["start"]> {
  const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
  const session = `sess-${uuidv7()}`;
  const runQuery = ((params: { prompt: unknown; options?: Record<string, unknown> }) => {
    calls.push({ prompt: params.prompt, options: params.options ?? {} });
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: session } as unknown as SDKMessage;
      if (afterMs > 0) await new Promise((resolve) => setTimeout(resolve, afterMs));
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
  return createClaudeProvider({ runQuery, enableCommentTool: false }).start(opts);
}

/** One Codex turn through the real adapter and client, over an app-server child process that answers `data` as the turn's final message. */
function codexTurn(agent: Agent, opts: AgentProviderStartOptions, data: unknown, afterMs: number): ReturnType<AgentProvider["start"]> {
  const fake: FakeAppServer = fakeAppServer({
    after: {
      "turn/start": [
        note.turnStarted(),
        ...(afterMs > 0 ? [{ wait: afterMs }] : []),
        note.agentMessage(JSON.stringify(data)),
        note.tokenUsage({ input: 10, output: 10 }),
        note.turnCompleted(),
      ],
    },
  });
  crossed.push({
    backend: "codex",
    agent,
    said: () => Promise.resolve(((fake.paramsOf("turn/start")?.["input"] as { text: string }[] | undefined) ?? []).map((part) => part.text).join("")),
    schema: () => fake.paramsOf("turn/start")?.["outputSchema"],
  });
  return createCodexProvider({ executablePath: CODEX_EXECUTABLE, createCodex: () => new CodexClient({ executablePath: CODEX_EXECUTABLE, spawn: fake.spawn, shutdownGraceMs: 200 }) }).start(opts);
}

/**
 * The provider each agent is dispatched through: a Claude or Codex agent
 * through its own backend's real adapter, answering what the script says
 * for this turn. The seeded `fake` agent, which no real backend serves,
 * answers in memory.
 */
function providerFor(agent: Agent): AgentProvider {
  return {
    start: (opts) => {
      started.push({ agent, opts });
      const assignment = /## Your assignment: (\w+)/.exec(opts.context)?.[1] ?? null;
      const leader = opts.context.includes("## What you lead");
      const data = script({ agent, opts, leader, assignment });
      // A member's turn takes a moment, so the passes overlap as they do on a real backend.
      const afterMs = assignment === null ? 0 : 30;
      if (agent.provider === "claude") return claudeTurn(agent, opts, data, afterMs);
      if (agent.provider === "codex") return codexTurn(agent, opts, data, afterMs);
      return says(data, afterMs)[Symbol.asyncIterator]() as unknown as ReturnType<AgentProvider["start"]>;
    },
    resume: () => {
      throw new Error("Nothing here resumes.");
    },
  };
}

/** A bridge that signs nothing: a member's credential, and the team boundary on it, can be read back from what its turn is handed. */
const bridge: Pick<AgentWriteBridge, "tokenFor" | "close"> = {
  tokenFor: (itemId: string, writes?: readonly AgentWriteTool[], scope?: string): AgentWriteBridgeAddress =>
    writes === undefined ? { url: "http://127.0.0.1:1/agent-write", token: `${itemId}.mac` } : { url: "http://127.0.0.1:1/agent-write", token: `${itemId}~${writes.join(",")}${scope === undefined ? "" : `~${scope}`}.mac`, writes: [...writes] },
  close: async () => undefined,
};

function supervisor(extra: Partial<Parameters<typeof createRunSupervisor>[0]> = {}): RunSupervisor {
  const made = createRunSupervisor({
    db: handle.db,
    // EO's default guardrails, every cap at one (EO-871): the session is
    // one run against them, and its turns are held back by nothing but
    // the team's own limit.
    limits: DEFAULT_GUARD_CONFIG,
    provider: providerFor,
    reportOnlyProvider: () => {
      throw new Error("A member of the Review team was built as a report-only participant.");
    },
    teamPollMs: 5,
    noDiskRoot: join(scratch, "no-disk"),
    builtins: BUILTIN_RUNNERS,
    sectionRenderers: developerSectionRenderers,
    agentWriteBridge: () => bridge as AgentWriteBridge,
    ...createRoleWiring(handle.db),
    ...extra,
  });
  supervisors.push(made);
  return made;
}

/**
 * Delivery on the template's newest version — or the newest in `history`
 * — as a fresh installation has it after its first launch, with the
 * reviewers on `roster`.
 */
function freshInstallation(roster?: Roster, history: TemplateHistory = loadTemplateHistory(GALLERY_DIRECTORY)): void {
  syncRolePrompts(handle.db);
  backfillPipelineOrigins(handle.db, history);
  applyTemplateUpdates(handle.db, history, { isTheRecord: false });
  if (roster === undefined) return;
  const seeded = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
  roster.reviewers.forEach((backend, index) => {
    const config = backend === "codex" ? { provider: "codex", model: "gpt-reviewer" } : { provider: "claude" };
    if (index === 0) updateAgent(handle.db, seeded.id, config);
    else createAgent(handle.db, { name: `Reviewer ${index + 1}`, role: "reviewer", instructions: seeded.instructions, ...config });
  });
}

function story(): Item {
  const item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "review", spec: { acceptance_criteria: CRITERIA } });
  postComment(handle.db, { itemId: item.id, author: { type: "engine" }, kind: "output", body: DIFF });
  return item;
}

const reviewTeam = (): LeaderTeam => {
  const team = listStepsForPipeline(handle.db, "default").find((step) => step.id === "review")?.team as StepTeam | null;
  if (team?.coordination !== "leader") throw new Error("Review has no leader-led team.");
  return team;
};

/** The six passes a change touching input handling and an error message calls for, each finding one fault. */
const PASSES = {
  criteria: "src/limit.ts: a key at exactly its limit gets a 429; correct is a 429 only past it.",
  impact: "src/server.ts: the old `limit()` caller still expects a boolean; correct is to read the status it now returns.",
  tests: "src/limit.test.ts: nothing drives a request past the limit; correct is a test that sends the 101st.",
  rules: "src/limit.ts: CONTRIBUTING says configuration is read from config/, and the limit is a literal; correct is to read it from config/limits.json.",
  security: "src/limit.ts: the key is taken from the request unvalidated; correct is to reject a key that is not one the server issued.",
  user_facing: "src/limit.ts: the 429 body is empty; correct is a message saying when to retry.",
} as const;
type Pass = keyof typeof PASSES;

/**
 * The passes the leader's instructions list, read from what the leader was
 * told on its turn (EO-873) — never from a list of this file's: the
 * numbered passes every review gets, and the bulleted ones it gets "when
 * the change calls for them". So a pass dropped from the template's
 * instructions is a pass the scripted leader does not assign, and the
 * scenarios below, which expect it, fail.
 */
function passesIn(context: string): { every: string[]; calledFor: string[] } {
  const start = context.indexOf("## What you lead");
  const end = context.indexOf("## This turn", start);
  const told = context.slice(start, end === -1 ? undefined : end);
  return {
    every: [...told.matchAll(/^\d+\. `(\w+)`:/gm)].map((match) => match[1]!),
    calledFor: [...told.matchAll(/^- `(\w+)`, when /gm)].map((match) => match[1]!),
  };
}

/**
 * A leader's first round, as the instructions it was given say: every pass
 * they list for every review, and those of the passes they list for when
 * the change calls for them that this change does (`calledFor`), each
 * required, with the note the instructions ask for.
 */
function assignAsTold(context: string, calledFor: readonly Pass[]): unknown {
  const listed = passesIn(context);
  const passes = [...listed.every, ...listed.calledFor.filter((key) => calledFor.includes(key as Pass))];
  return {
    outcome: {
      decision: "assign",
      assignments: passes.map((key) => ({ key, role: "reviewer", instructions: `Your focus is ${key}, and only ${key}.`, required: true })),
      note: listed.calledFor.map((key) => `${key} ${calledFor.includes(key as Pass) ? "assigned" : "not assigned"}: ${calledFor.includes(key as Pass) ? "the change calls for it" : "nothing in the change calls for it"}.`).join(" "),
    },
  };
}

/** The report comment ids and their bodies, as the leader's context shows them. */
function reportsIn(context: string): { id: string; body: string }[] {
  const found: { id: string; body: string }[] = [];
  const pattern = /Report \(comment ([^)]+)\)[^\n]*:\n\n([\s\S]*?)(?=\n### |\n## |$)/g;
  for (let match = pattern.exec(context); match !== null; match = pattern.exec(context)) found.push({ id: match[1]!, body: match[2]! });
  return found;
}

/** What the leader's final answer says beside its verdict. */
interface Settled {
  answer: Record<string, unknown>;
  disagreements?: string;
}

/**
 * A leader that assigns what its instructions list (`assignAsTold`), with
 * the optional passes this change calls for, and once the reports are in
 * builds its answer from them; `answer` is told which final turn this is,
 * from 1.
 */
function leading(calledFor: readonly Pass[], answer: (reports: { id: string; body: string }[], final: number) => Settled): (turn: Parameters<Script>[0]) => unknown {
  let turns = 0;
  return ({ opts }) => {
    turns += 1;
    if (turns === 1) return assignAsTold(opts.context, calledFor);
    const reports = reportsIn(opts.context);
    const settled = answer(reports, turns - 1);
    return { outcome: { decision: "final", answer: settled.answer, contributions: reports.map((one) => one.id), disagreements: settled.disagreements ?? "None.", limitations: "None." } };
  };
}

/** The passes the template lists for every review, as this file expects them: a pass the template drops fails every scenario below. */
const EVERY_REVIEW: Pass[] = ["criteria", "impact", "tests", "rules"];
/** The key each member turn was assigned. */
const assigned = () => memberTurns().map((one) => /## Your assignment: (\w+)/.exec(one.opts.context)![1]!);

/** Each member reports its own pass's fault, and the impact pass sees the criteria fault as well — a duplicate the leader must merge. */
function memberFinding(assignment: string): unknown {
  const fault = PASSES[assignment as Pass];
  const also = assignment === "impact" ? `\nBLOCKING: ${PASSES.criteria}` : "";
  return { outcome: { outcome: "blocking", report: `Checked my focus.\nBLOCKING: ${fault}${also}` } };
}

const blockingIn = (reports: readonly { body: string }[]) => [...new Set(reports.flatMap((one) => [...one.body.matchAll(/BLOCKING: (.+)/g)].map((match) => match[1]!.trim())))];
const coverage = () => CRITERIA.map((criterion, index) => ({ criterion, result: index === 0 ? "not_met" : "met" }));

const routeOf = (resultKey: string) => listRoutesForPipeline(handle.db, "default").find((route) => route.fromStepId === "review" && route.resultKey === resultKey)!.target;
/** What the step's own run posted: the verdict, as a single reviewer's run posts it. */
const ownVerdicts = (item: Item) => {
  const own = listRunsForItem(handle.db, item.id).find((run) => run.action === "review")!;
  return listCommentsForItem(handle.db, item.id).filter((comment) => comment.runId === own.id && comment.authorType === "agent");
};
const memberTurns = () => started.filter((one) => one.opts.context.includes("## Your assignment:"));
const leaderTurns = () => started.filter((one) => one.opts.context.includes("## What you lead"));

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-review-team-"));
  started = [];
  crossed = [];
});

afterEach(async () => {
  for (const made of supervisors.splice(0)) await made.shutdown();
  dropWarmCodexThread();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("the template's Review team, on either backend (EO-868)", () => {
  describe.each(ROSTERS)("$name", (roster) => {
    beforeEach(() => freshInstallation(roster));

    /**
     * What every scenario leaves true: one team session, settled; every
     * turn reached its own agent's backend, through that backend's
     * adapter, carrying the turn's context and an answer schema.
     */
    async function settledOnce(item: Item): Promise<void> {
      expect(listTeamSessionsForItem(handle.db, item.id).map((record) => record.session.status)).toEqual(["finalized"]);
      expect(new Set(started.map((one) => one.agent.provider))).toEqual(new Set(roster.reviewers));
      expect(started.every((one) => one.agent.role === "reviewer")).toBe(true);
      expect(crossed.map((one) => [one.agent.id, one.backend])).toEqual(started.map((one) => [one.agent.id, one.agent.provider]));
      expect(new Set(crossed.map((one) => one.backend))).toEqual(new Set(roster.reviewers));
      for (const [index, one] of crossed.entries()) {
        const context = started[index]!.opts.context;
        const said = await one.said();
        const heading = /## Your assignment: \w+|## What you lead/.exec(context)![0];
        expect(said, `${one.backend} turn ${index}`).toContain(heading);
        expect(said, `${one.backend} turn ${index}`).toContain(CRITERIA[0]);
        expect(one.schema(), `${one.backend} turn ${index}`).toBeTypeOf("object");
      }
      // Every report and the leader's answer came back through the adapters' parsing, and nothing failed on the way.
      expect(listRunsForItem(handle.db, item.id).filter((run) => run.status === "failed")).toEqual([]);
    }

    /** The item moved once, to where the verdict's route sends it. */
    async function movedOnceTo(item: Item, resultKey: string): Promise<void> {
      await settledOnce(item);
      const moves = listTransitionsForItem(handle.db, item.id);
      expect(moves).toHaveLength(1);
      expect(moves[0]!.toStepId).toBe(routeOf(resultKey));
      expect(getItem(handle.db, item.id)?.stepId).toBe(routeOf(resultKey));
    }

    it("approves on clean reports, with the pull request body, from a leader who assigned the four passes every review gets", async () => {
      const item = story();
      const lead = leading([], () => ({ answer: { verdict: "approve", feedback: "Every pass came back clean.", pull_request_body: "Rate limits the API per key." } }));
      script = (turn) => (turn.leader ? lead(turn) : { outcome: { outcome: "clear", report: `Checked ${turn.assignment}: nothing blocks.` } });

      await supervisor().runOnce();

      await movedOnceTo(item, "approved");
      // What the leader read in the template's instructions is what it assigned, and that is the four.
      expect(assigned().sort()).toEqual([...EVERY_REVIEW].sort());
      expect(leaderTurns()).toHaveLength(2);
      // The leader is told what to assign, in the template's own words.
      expect(leaderTurns()[0]!.opts.context).toContain(reviewTeam().leader.instructions);
    });

    it("rejects once, carrying every blocking issue from every pass, merged and de-duplicated, with coverage for every criterion", async () => {
      const item = story();
      const lead = leading(["security", "user_facing"], (reports) => ({
        answer: { verdict: "reject", feedback: "Six passes, six faults.", blocking_issues: blockingIn(reports), criteria_coverage: coverage() },
      }));
      script = (turn) => (turn.leader ? lead(turn) : memberFinding(turn.assignment!));

      await supervisor().runOnce();

      await movedOnceTo(item, "changes_requested");
      // The four every review gets and the two this change calls for, each as the template's instructions list it.
      expect(assigned().sort()).toEqual((Object.keys(PASSES) as Pass[]).sort());
      // One rejection, carrying all six faults — the duplicate the impact pass also reported counted once.
      const verdicts = listReviewVerdicts(handle.db, item.id);
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]).toMatchObject({ verdict: "reject", blockingIssues: 6, declaredCriteria: CRITERIA.length, met: 2, notMet: 1, unexamined: 0 });
      // The step's own rejection, on the review's run as a single reviewer's is, beside the leader's answer on the team's thread.
      const rejection = ownVerdicts(item).filter((comment) => Object.values(PASSES).every((fault) => comment.body.includes(fault)));
      expect(rejection).toHaveLength(1);
      expect(rejection[0]!.body.split(PASSES.criteria)).toHaveLength(2);
    });

    it("asks the person when a pass finds something only they can decide", async () => {
      const item = story();
      const lead = leading([], () => ({ answer: { verdict: "needs_user_input", feedback: "Decide whether a limit applies per key or per account: the story says key, the thread says account." } }));
      script = (turn) =>
        turn.leader ? lead(turn) : { outcome: turn.assignment === "criteria" ? { outcome: "needs_decision", report: "Per key or per account is not mine to decide." } : { outcome: "clear", report: "Nothing blocks." } };

      await supervisor().runOnce();

      // Its route is to the person: the item is flagged where it stands, and the step's run waits on them.
      await settledOnce(item);
      expect(assigned().sort()).toEqual([...EVERY_REVIEW].sort());
      expect(routeOf("needs_user_input")).toBe("user_attention");
      expect(listTransitionsForItem(handle.db, item.id)).toEqual([]);
      expect(getItem(handle.db, item.id)?.stepId).toBe("review");
      expect(listRunsForItem(handle.db, item.id).find((run) => run.action === "review")?.status).toBe("awaiting_input");
      expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.body.includes("the pipeline routes this result to you"))).toBe(true);
      expect(ownVerdicts(item).some((comment) => comment.body.includes("per key or per account"))).toBe(true);
    });

    /**
     * A member's team boundary reaches its `eo` server only on the
     * credential the write bridge signs (EO-870). With no bridge — not
     * listening yet, or never — no member starts on either backend, each
     * attempt fails and is retried as any execution failure is, and the
     * item says why; nothing is ever served the whole thread.
     */
    it("starts no member without a write bridge, saying so on the item, and moves nothing", async () => {
      const item = story();
      script = () => {
        throw new Error("No member's turn may start without its team boundary.");
      };

      await supervisor({ agentWriteBridge: () => null }).runOnce();

      // No backend was reached: neither adapter was handed a turn.
      expect(started).toEqual([]);
      expect(crossed).toEqual([]);
      expect(getItem(handle.db, item.id)?.stepId).toBe("review");
      expect(listTransitionsForItem(handle.db, item.id)).toEqual([]);
      // The leader's attempt, then its retry: each a failed run, each said on the item.
      const members = listRunsForItem(handle.db, item.id).filter((run) => run.action === TEAM_PARTICIPANT_ACTION);
      expect(members).toHaveLength(1 + reviewTeam().limits.maxRetries);
      expect(members.every((run) => run.status === "failed" && run.error === MEMBER_NO_BRIDGE)).toBe(true);
      const said = listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine" && comment.body.includes(MEMBER_NO_BRIDGE));
      expect(said.map((comment) => comment.runId).sort()).toEqual(members.map((run) => run.id).sort());
      expect(said[0]!.body).toContain("did not start");
      const attempts = listTeamSessionsForItem(handle.db, item.id).at(-1)!.attempts;
      expect(attempts.every((attempt) => attempt.status === "failed" && attempt.error === MEMBER_NO_BRIDGE)).toBe(true);
    });

    /**
     * The template's team declares that a blocking pass rules out an
     * approval (EO-873), so a leader that approves over one, saying
     * nothing of it, is refused, and answers again.
     */
    it("refuses an approval over a blocking report the leader does not say it overruled, and takes the rejection it answers with next", async () => {
      const item = story();
      const lead = leading([], (reports, final) =>
        final === 1
          ? { answer: { verdict: "approve", feedback: "Looks fine to me.", pull_request_body: "Rate limits the API per key." } }
          : { answer: { verdict: "reject", feedback: "The criteria pass found a fault.", blocking_issues: blockingIn(reports), criteria_coverage: coverage() } },
      );
      script = (turn) =>
        turn.leader ? lead(turn) : turn.assignment === "criteria" ? memberFinding("criteria") : { outcome: { outcome: "clear", report: `Checked ${turn.assignment}: nothing blocks.` } };

      await supervisor().runOnce();

      const refusals = listCommentsForItem(handle.db, item.id).filter((comment) => comment.body.startsWith("EO did not accept the leader's final answer"));
      expect(refusals).toHaveLength(1);
      expect(refusals[0]!.body).toMatch(/Its result "approved" is one \*\*criteria\*\*'s report \(comment [^)]+\) rules out: it concluded "Blocking issues" \(blocking\)\./);
      // The leader was told what rules out what before it answered, and why it was refused after.
      expect(leaderTurns()[0]!.opts.context).toContain("- `blocking` rules out `approved`");
      expect(leaderTurns()[2]!.opts.context).toContain("Why EO refused your final answer:");
      await movedOnceTo(item, "changes_requested");
      expect(listReviewVerdicts(handle.db, item.id)).toEqual([expect.objectContaining({ verdict: "reject", blockingIssues: 1 })]);
    });
  });
});

/**
 * The template's case (EO-870): one reviewer agent staffs the leader and
 * every pass, so each member's turn comes after runs of its own agent in
 * its own session — the leader's first turn, and siblings that have
 * finished. None of them is the agent having looked.
 */
describe.each(ROSTERS.filter((roster) => roster.reviewers.length === 1))("a Review team staffed by one agent, $name", (roster) => {
  beforeEach(() => freshInstallation(roster));

  const PERSON = "PERSON-SAID: the 429 must say when to retry, in seconds.";
  /** The "What the person said" section of a turn's context. */
  const personSection = (context: string) => /## What the person said\n([\s\S]*?)(?=\n## |$)/.exec(context)?.[1] ?? "";

  it("shows every member and the leader a person's comment from before the session under what the person said, not only in the count", async () => {
    const item = story();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, kind: "note", body: PERSON });
    const passes = EVERY_REVIEW;
    const lead = leading([], () => ({ answer: { verdict: "approve", feedback: "Clean.", pull_request_body: "Body." } }));
    script = (turn) => (turn.leader ? lead(turn) : { outcome: { outcome: "clear", report: `Checked ${turn.assignment}.` } });

    await supervisor().runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe(routeOf("approved"));
    const reviewers = listAgents(handle.db).filter((agent) => agent.role === "reviewer");
    expect(reviewers).toHaveLength(1);
    expect(started.every((one) => one.agent.id === reviewers[0]!.id)).toBe(true);
    expect(memberTurns()).toHaveLength(passes.length);

    // Some members started only after a run of the same agent in the same session had ended: the leader's first turn, and siblings.
    const runs = listRunsForItem(handle.db, item.id).filter((run) => run.action === TEAM_PARTICIPANT_ACTION);
    const ended = (run: (typeof runs)[number]) => run.endedAt ?? Infinity;
    const later = runs.filter((run) => runs.some((other) => other.id !== run.id && ended(other) <= (run.startedAt ?? 0)));
    expect(later.length).toBeGreaterThanOrEqual(passes.length);

    for (const [index, one] of started.entries()) {
      const heading = /## Your assignment: \w+|## What you lead/.exec(one.opts.context)![0];
      expect(personSection(one.opts.context), heading).toContain(PERSON);
      expect(personSection(one.opts.context), heading).not.toContain("Nothing since you last worked on this ticket");
      // And it crossed the backend so.
      expect(await crossed[index]!.said(), heading).toContain(PERSON);
    }
  });
});

/**
 * The scripted leader above assigns what the template's instructions
 * list, not what this file lists (EO-873): change the instructions, and
 * what it assigns changes with them — so dropping a pass from the
 * template fails the scenarios that expect it.
 */
describe("the scripted leader", () => {
  beforeEach(() => freshInstallation(ROSTERS[0]));

  it("assigns no pass the template's instructions no longer list", async () => {
    const team = reviewTeam();
    const without = team.leader.instructions.replace(/^3\. `tests`:.*$/m, "");
    expect(without).not.toBe(team.leader.instructions);
    (handle.db as unknown as { $client: { prepare(source: string): { run(...args: unknown[]): unknown } } }).$client
      .prepare("update pipeline_steps set team = ? where id = 'review'")
      .run(JSON.stringify({ ...team, leader: { ...team.leader, instructions: without } }));
    story();
    const lead = leading([], () => ({ answer: { verdict: "approve", feedback: "Clean.", pull_request_body: "Body." } }));
    script = (turn) => (turn.leader ? lead(turn) : { outcome: { outcome: "clear", report: "Nothing blocks." } });

    await supervisor().runOnce();

    expect(assigned().sort()).toEqual(["criteria", "impact", "rules"]);
    expect(assigned().sort()).not.toEqual([...EVERY_REVIEW].sort());
  });
});

describe("a member of the template's Review team", () => {
  beforeEach(() => freshInstallation(ROSTERS[0]));

  it("works as the template's reviewer does, in a copy of its own: its prompt, the diff, the criteria and its assignment", async () => {
    const item = story();
    const lead = leading([], () => ({ answer: { verdict: "approve", feedback: "Clean.", pull_request_body: "Body." } }));
    script = (turn) => (turn.leader ? lead(turn) : { outcome: { outcome: "clear", report: "Nothing blocks." } });

    await supervisor().runOnce();

    const reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
    for (const one of started) {
      expect(one.opts.instructions.startsWith(`${reviewer.instructions}\n\n## Your part in a team`)).toBe(true);
      expect(one.opts.context).toContain(DIFF.split("\n")[1]);
      for (const criterion of CRITERIA) expect(one.opts.context).toContain(criterion);
    }
    expect(new Set(memberTurns().map((one) => one.opts.cwd)).size).toBe(4);
    expect(listRunsForItem(handle.db, item.id).filter((run) => run.action === TEAM_PARTICIPANT_ACTION)).toHaveLength(6);
  });
});

/**
 * An installation whose reviewer could review before can run the team
 * (EO-868): the seeded reviewer is on a backend EO could never hold
 * report-only, and the team is isolated, so nothing refuses it.
 */
describe("a fresh installation from the template", () => {
  beforeEach(() => freshInstallation());

  it("publishes Delivery as it stands and runs Review as a team, refusing nothing", async () => {
    const pipeline = getPipeline(handle.db, "default")!;
    const steps = listStepsForPipeline(handle.db, "default");
    const routes = listRoutesForPipeline(handle.db, "default");
    expect(listAgents(handle.db).find((agent) => agent.role === "reviewer")?.provider).toBe("fake");
    expect(storedGraphProblems(handle.db, "default", steps, routes, pipeline.entryStepId).filter((problem) => problem.severity === "error")).toEqual([]);
    const published = savePipeline(handle.db, { notifyStateChange: () => {} }, { pipelineId: "default", steps: steps.map((step) => ({ ...step })), routes, entryStepId: pipeline.entryStepId });
    expect(published.saved).toBe(true);
    expect(reviewTeam().members).toBe("isolated");

    const item = story();
    const lead = leading([], () => ({ answer: { verdict: "approve", feedback: "Clean.", pull_request_body: "Body." } }));
    script = (turn) => (turn.leader ? lead(turn) : { outcome: { outcome: "clear", report: "Nothing blocks." } });

    await supervisor().runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe(routeOf("approved"));
    expect(memberTurns()).toHaveLength(4);
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => /report-only|refus/i.test(comment.body))).toEqual([]);
  });
});

/**
 * Removing the team as a person does (EO-873): no tool writes a team, so
 * the assistant drafts Review with `team: "none"` and the person presses
 * Publish on its card. The next review is the single reviewer's, and a
 * later template version that changes Review's team is held for the
 * person, as it is for any step they edited, rather than putting the
 * team back.
 */
describe("the template's Review team, removed through the assistant's draft and its card", () => {
  // On 1.5, so the version after it — 1.6, which changes Review's team — is a real later update.
  beforeEach(() => freshInstallation(ROSTERS[0], templateHistoryUpTo(GALLERY_DIRECTORY, "software-feature-to-merge", "1.5")));
  afterEach(() => clearHandlerRegistry());

  const PIPELINE_READ = `mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_get`;

  /** The assistant's draft of Delivery as it stands, but for Review, which is one agent again. */
  function draftWithoutTeam() {
    return {
      rationale: "Review goes back to a single reviewer.",
      entryStepId: getPipeline(handle.db, "default")!.entryStepId,
      target: { pipelineId: "default" },
      removes: [],
      steps: listStepsForPipeline(handle.db, "default").map((step) => ({
        id: step.id,
        position: step.position,
        name: step.name,
        type: step.type,
        ownerRole: step.ownerRole,
        entryAction: step.entryAction,
        instructionsSummary: step.instructionsSummary,
        isTerminal: step.isTerminal,
        planMode: step.planMode,
        ...(step.id === "review" ? { team: "none" } : {}),
      })),
      routes: listRoutesForPipeline(handle.db, "default").map(({ fromStepId, resultKey, label, tone, target, position }) => ({ fromStepId, resultKey, label, tone, target, position })),
    };
  }

  /** The assistant's turn: it read Delivery and replied with `draft`, and the card it posted. */
  async function draftCard(): Promise<{ on: Item; cardId: Uuid; body: string }> {
    const sent = await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/pipelines/default"), conversationId: null, body: "Make Review a single reviewer again.", attachmentIds: [], interrupt: false });
    const on = getItem(handle.db, sent.conversation.id as Uuid)!;
    const parsed = AssistOutputSchema.parse({ message: "Review is one reviewer again.", draft: draftWithoutTeam() });
    const agent = assistAgent(handle.db)!;
    const asked = listCommentsForItem(handle.db, on.id).filter((comment) => comment.authorType === "human").at(-1)!;
    const run = createRun(handle.db, { itemId: on.id, agentId: agent.id, action: ASSIST_ACTION, initiationId: asked.id });
    appendRunEvent(handle.db, run.id, "tool_call", { name: PIPELINE_READ, args: { pipelineId: "default" }, callId: "call-1" });
    appendRunEvent(handle.db, run.id, "tool_result", { name: PIPELINE_READ, callId: "call-1", ok: true, output: "", truncated: false });
    updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(parsed), parsed } });
    postAssistReply(handle.db, on, agent.id, run.id, parsed);
    const posted = listCommentsForItem(handle.db, on.id).filter((comment) => comment.runId === run.id);
    expect(posted.filter((comment) => comment.kind === "rejection").map((comment) => comment.body)).toEqual([]);
    const card = posted.find((comment) => comment.kind === PROPOSAL_KIND)!;
    return { on, cardId: card.id as Uuid, body: card.body };
  }

  /** Publish, as the card's button sends it: the draft read for publishing, then `pipeline:save` with the section lock every channel is asked. */
  async function publish(on: Item, cardId: Uuid) {
    const read = readAssistDraftForPublish(handle.db, { conversationId: on.id, messageId: cardId });
    expect(read.problem).toBeNull();
    return handleIpcRequest(
      "pipeline:save",
      { pipelineId: read.pipelineId, steps: read.steps, routes: read.routes, entryStepId: read.entryStepId, ...((read.actions ?? []).length > 0 ? { actions: read.actions } : {}) },
      (payload) => savePipeline(handle.db, undefined, payload),
      { exposeErrorDetails: true, sectionLock: (channel: IpcChannel, payload: unknown) => sectionLockFor(handle.db, channel, payload) },
    );
  }

  const review = () => listStepsForPipeline(handle.db, "default").find((step) => step.id === "review")!;
  const routesOf = () => listRoutesForPipeline(handle.db, "default").map(({ fromStepId, resultKey, label, tone, target }) => ({ fromStepId, resultKey, label, tone, target }));

  it("gives back the single reviewer's review — one run, the ordinary review schema, the same routes — and a later template update is held rather than putting the team back", async () => {
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.5");
    const team = reviewTeam();
    const routesBefore = routesOf();

    const { on, cardId, body } = await draftCard();
    expect(body).toContain("Team: a leader-led team → one agent");
    // Nothing is written until the person presses Publish.
    expect(review().team).toEqual(team);
    expect(await publish(on, cardId)).toMatchObject({ ok: true, data: { saved: true } });
    expect(review().team).toBeNull();
    expect(review()).toMatchObject({ type: "agent", ownerRole: "reviewer", entryAction: "review" });
    expect(routesOf()).toEqual(routesBefore);

    const item = story();
    script = () => ({ verdict: "reject", feedback: "One fault.", blocking_issues: [PASSES.criteria], criteria_coverage: coverage() });

    await supervisor().runOnce();

    expect(started).toHaveLength(1);
    expect(started[0]!.opts.instructions).not.toContain("## Your part in a team");
    expect(started[0]!.opts.context).not.toContain("## What you lead");
    // The review action's own answer schema, as dispatch resolves it for this item and its reviewer: no leader's wrapper around it.
    expect(started[0]!.opts.outputSchema).toEqual(outputSchemaFor(registryForItem(handle.db, item), "review", getItemType(handle.db, item.typeId), "reviewer"));
    expect(started[0]!.opts.outputSchema).toEqual(outputSchemaFor(developerRegistry(), "review", getItemType(handle.db, item.typeId), "reviewer"));
    expect(listTeamSessionsForItem(handle.db, item.id)).toEqual([]);
    expect(listRunsForItem(handle.db, item.id).map((run) => run.action)).toEqual(["review"]);
    expect(getItem(handle.db, item.id)?.stepId).toBe(routeOf("changes_requested"));

    // 1.6 changes Review's team; the person removed it, so the update is held for them.
    const shipped = loadTemplateHistory(GALLERY_DIRECTORY);
    const next = shipped.get("software-feature-to-merge")!.find((version) => version.version === "1.6")!;
    expect(applyTemplateUpdates(handle.db, shipped, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "conflict", from: "1.5", to: "1.6" }));
    expect(review().team).toBeNull();
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.5");
    expect(openUpdateConflict(handle.db, "default")?.conflicts).toEqual([
      expect.objectContaining({ key: { kind: "setting", stepId: "review", field: "team" }, base: team, current: null, template: next.document.steps.find((step) => step.id === "review")!.team }),
    ]);
  });
});

/**
 * Delivery updated from 1.4 on a project with a Git and a folder workspace
 * (EO-871): the update applies, and an item in the folder — which cannot
 * give each member a copy of its own — is refused at start with a comment
 * naming the kind. Never a member in the item's own folder, and never the
 * single reviewer in the team's place.
 */
describe.each([
  { name: "beside a Git repository", git: true },
  { name: "the project's only workspace", git: false },
])("an item in a folder workspace, $name, on Delivery updated to 1.5", ({ git }) => {
  let folder: string;
  let item: Item;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "eo-review-folder-"));
    syncRolePrompts(handle.db);
    const onFourteen = templateHistoryUpTo(GALLERY_DIRECTORY, "software-feature-to-merge", "1.4");
    backfillPipelineOrigins(handle.db, onFourteen);
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" }).id;
    adoptPipeline(handle.db, "default", shop);
    applyTemplateUpdates(handle.db, onFourteen, { isTheRecord: false });
    // The git kind installed, as the developer pack installs it.
    useWorkspaceKinds(new Map([[GIT_WORKTREE_KIND, { slug: GIT_WORKTREE_KIND, evidence: { copy: {} } } as unknown as WorkspaceKind]]));
    if (git) addWorkspaceToProject(handle.db, shop, createWorkspace(handle.db, { config: { name: "shop", repoPath: join(folder, "shop.git") } }).id);
    const docs = createWorkspace(handle.db, { kind: FOLDER_KIND, config: { path: folder } });
    addWorkspaceToProject(handle.db, shop, docs.id);
    // The update applies either way (EO-871): what cannot run is said on each item, at start.
    expect(applyTemplateUpdates(handle.db, templateHistoryUpTo(GALLERY_DIRECTORY, "software-feature-to-merge", "1.5"), { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied", from: "1.4", to: "1.5" }));
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.5");
    expect(reviewTeam().members).toBe("isolated");
    item = createTestItem(handle.db, { type: "story", title: "Rewrite the setup guide", stepId: "review", projectId: shop, workspaceId: docs.id, spec: { acceptance_criteria: CRITERIA } });
  });

  afterEach(() => {
    useWorkspaceKinds(new Map());
    rmSync(folder, { recursive: true, force: true });
  });

  it("refuses the team at start with a comment naming the kind, and starts nobody — no member, and no single reviewer", async () => {
    script = () => {
      throw new Error("Nobody should have been started.");
    };

    await supervisor().runOnce();

    expect(started).toEqual([]);
    expect(listRunsForItem(handle.db, item.id).filter((run) => run.action === TEAM_PARTICIPANT_ACTION)).toEqual([]);
    expect(listRunsForItem(handle.db, item.id).map((run) => run.action)).toEqual(["review"]);
    expect(listTransitionsForItem(handle.db, item.id)).toEqual([]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
    const said = listCommentsForItem(handle.db, item.id).map((comment) => comment.body).join("\n");
    expect(said).toContain('its step works in a "folder" workspace, which cannot give each member a copy of its own, so EO started nobody');
  });
});
