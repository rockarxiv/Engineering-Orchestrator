import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepTeamSchema, TEAM_PARTICIPANT_ACTION, uuidv7, type Agent, type AgentEvent, type AgentProvider, type AgentProviderStartOptions, type Item, type StepTeam } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { saveActionDefinition } from "../db/repos/actionDefinitionsRepo.js";
import { createAgent } from "../db/repos/agentsRepo.js";
import { listCommentsForItem } from "../db/repos/commentsRepo.js";
import { createRoute } from "../db/repos/index.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { createStep } from "../db/repos/pipelineStepsRepo.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import { listTeamSessionsForItem } from "../db/repos/teamSessionsRepo.js";
import { createTestItem, openMigratedTestDb, agentOfKind, setStepTeam } from "../db/testHelpers.js";
import { DEFAULT_GUARD_CONFIG } from "../ipc/configCommands.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";
import type { ReportOnlyProviderAnswer } from "./teamSupervisor.js";

/**
 * A team session is one run against EO's caps (EO-871): its own run holds
 * the slot a single run of its step would, and the turns inside it count
 * against none of them — only the team's `maxParallel` holds them back.
 * Each turn is still held to the wall clock and the inactivity guard; the
 * session is not held to the single run's wall clock.
 */

/** A leader and four members, every one of them the same agent, four at a time. */
function teamOfOne(overrides: Record<string, unknown> = {}): StepTeam {
  return StepTeamSchema.parse({
    coordination: "leader",
    leader: { role: "checker", instructions: "Split the review into passes." },
    roles: ["checker"],
    limits: { maxParticipants: 4, maxParallel: 4, maxRounds: 1 },
    ...overrides,
  });
}

const PASSES = ["criteria", "impact", "tests", "rules"] as const;

type Turn = (call: { opts: AgentProviderStartOptions; leader: boolean }) => AsyncIterable<AgentEvent>;

let handle: DbHandle;
let scratch: string;
let reviewer: Agent;
let team: Item;
/** The leader's turns and the members', as they started. */
let turns: { leader: boolean; opts: AgentProviderStartOptions }[];
/** What a member's turn does. */
let member: Turn;
/** What the step's own provider was asked to do: a single run of the agent, on another item. */
let ordinary: string[];
const supervisors: RunSupervisor[] = [];
/** Members running now, and the most that ever ran at once. */
let running = 0;
let peak = 0;

function reportIds(context: string): string[] {
  return [...context.matchAll(/Report \(comment ([^)]+)\)/g)].map((match) => match[1]!);
}

/** The leader's turn: the four passes first, then an answer resting on every report. */
function leaderTurn(opts: AgentProviderStartOptions): AsyncIterable<AgentEvent> {
  const first = !opts.context.includes("Report (comment");
  const data = first
    ? { outcome: { decision: "assign", assignments: PASSES.map((key) => ({ key, member: "Rhea", instructions: `Look at ${key}.`, required: true })), note: "Four passes." } }
    : { outcome: { decision: "final", answer: { result: "aligned", summary: "Every pass is clean." }, contributions: reportIds(opts.context), disagreements: "None.", limitations: "None." } };
  return (async function* () {
    yield { type: "thread_started", threadId: `thread-${uuidv7()}` } as AgentEvent;
    yield { type: "result", data } as AgentEvent;
  })();
}

function reportOnlyProvider(agent: Agent, attemptId: string): ReportOnlyProviderAnswer {
  return {
    ok: true,
    cwd: join(scratch, attemptId),
    provider: {
      start: (opts) => {
        const leader = opts.context.includes("## What you lead");
        turns.push({ leader, opts });
        if (leader) return leaderTurn(opts)[Symbol.asyncIterator]() as unknown as ReturnType<AgentProvider["start"]>;
        const inner = member({ opts, leader });
        return (async function* () {
          running += 1;
          peak = Math.max(peak, running);
          try {
            yield* inner;
          } finally {
            running -= 1;
          }
        })() as unknown as ReturnType<AgentProvider["start"]>;
      },
    },
  };
}

/** The agent's ordinary provider, for a single run of it on the other item's step. */
const ownProvider: AgentProvider = {
  start: (opts) => {
    ordinary.push(opts.context);
    return (async function* () {
      yield { type: "thread_started", threadId: `thread-${uuidv7()}` } as AgentEvent;
      yield { type: "result", data: { result: "aligned", summary: "Checked on its own." } } as AgentEvent;
    })() as unknown as ReturnType<AgentProvider["start"]>;
  },
  resume: () => {
    throw new Error("Nothing here resumes.");
  },
};

function supervisor(extra: Partial<Parameters<typeof createRunSupervisor>[0]> = {}): RunSupervisor {
  const made = createRunSupervisor({ db: handle.db, provider: ownProvider, limits: DEFAULT_GUARD_CONFIG, reportOnlyProvider, teamPollMs: 5, ...extra });
  supervisors.push(made);
  return made;
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

function answers(after: Promise<unknown> | number = 0): Turn {
  return () =>
    (async function* () {
      yield { type: "thread_started", threadId: `thread-${uuidv7()}` } as AgentEvent;
      if (typeof after === "number") {
        if (after > 0) await new Promise((resolve) => setTimeout(resolve, after));
      } else await after;
      yield { type: "result", data: { outcome: { report: "Nothing blocks." } } } as AgentEvent;
    })();
}

function setTeam(value: StepTeam): void {
  setStepTeam(handle.db, "team_review", value);
}

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-team-capacity-"));
  turns = [];
  ordinary = [];
  running = 0;
  peak = 0;
  member = answers();
  reviewer = createAgent(handle.db, { name: "Rhea", role: "checker", provider: "claude", instructions: "You review." });
  // The team's step and a step of no team, each the same agent's: a single run of it is one run of Rhea.
  createStep(handle.db, { id: "team_review", pipelineId: "default" as never, position: -4, name: "Review", type: "agent", agentId: agentOfKind(handle.db, "checker"), entryAction: "alignment", team: teamOfOne() });
  createStep(handle.db, { id: "solo_check", pipelineId: "default" as never, position: -3, name: "Solo check", type: "agent", agentId: agentOfKind(handle.db, "checker"), entryAction: "alignment" });
  createStep(handle.db, { id: "team_accepted", pipelineId: "default" as never, position: -1, name: "Accepted", type: "user", agentId: null, entryAction: null });
  for (const from of ["team_review", "solo_check"]) createRoute(handle.db, { pipelineId: "default" as never, fromStepId: from, resultKey: "aligned", label: "Aligned", target: "team_accepted", position: 0 });
  const saved = saveActionDefinition(handle.db, {
    role: "checker",
    action: "alignment",
    description: "Check the work against what was asked for.",
    results: [{ key: "aligned", label: "Aligned", meaning: "Everything asked for is there." }],
  });
  if (!saved.ok) throw new Error("action");
  team = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "team_review", priority: 2 });
});

afterEach(async () => {
  for (const made of supervisors.splice(0)) await made.shutdown();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

const memberRuns = (item: Item) => listRunsForItem(handle.db, item.id).filter((run) => run.action === TEAM_PARTICIPANT_ACTION);
const stepOf = (item: Item) => getItem(handle.db, item.id)?.stepId;

describe("a team session against EO's caps (EO-871)", () => {
  it("on default guardrails runs four members of one agent at once, and holds another item's run of that agent until it settles", async () => {
    expect([DEFAULT_GUARD_CONFIG.globalConcurrency, DEFAULT_GUARD_CONFIG.perAgentConcurrency, DEFAULT_GUARD_CONFIG.perRepositoryConcurrency]).toEqual([1, 1, 1]);
    const release = gate();
    member = answers(release.wait);
    const other = createTestItem(handle.db, { type: "story", title: "Check the docs", stepId: "solo_check", priority: 1 });
    const engine = supervisor();

    const done = engine.runOnce();
    await vi.waitFor(() => expect(running).toBe(4));
    // Four members of the one agent at once, inside the session's one slot.
    expect(memberRuns(team).filter((run) => run.status === "running").map((run) => run.agentId)).toEqual(Array(4).fill(reviewer.id));
    // The session holds the slot a single run of the step would: another tick starts nothing on the other item.
    const again = engine.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listRunsForItem(handle.db, other.id)).toEqual([]);
    expect(ordinary).toEqual([]);

    release.open();
    await done;
    await again;
    await engine.runOnce();

    expect(peak).toBe(4);
    expect(stepOf(team)).toBe("team_accepted");
    expect(listTeamSessionsForItem(handle.db, team.id).map((record) => record.session.status)).toEqual(["finalized"]);
    // Released when the session settled: the other item's single run of the agent went next.
    expect(stepOf(other)).toBe("team_accepted");
    expect(ordinary).toHaveLength(1);
    const own = listRunsForItem(handle.db, team.id).find((run) => run.action === "alignment")!;
    expect(listRunsForItem(handle.db, other.id)[0]!.startedAt!).toBeGreaterThanOrEqual(own.endedAt!);
    // Every turn is still its own run: the leader's two and the four members'.
    expect(memberRuns(team)).toHaveLength(6);
  });

  it("holds its agent's slot as a single run would, where only the per-agent cap stands between the other item and a run", async () => {
    const release = gate();
    member = answers(release.wait);
    const other = createTestItem(handle.db, { type: "story", title: "Check the docs", stepId: "solo_check", priority: 1 });
    const engine = supervisor({ limits: { globalConcurrency: 2, perAgentConcurrency: 1, perRepositoryConcurrency: 2 } });

    const done = engine.runOnce();
    await vi.waitFor(() => expect(running).toBe(4));
    const again = engine.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listRunsForItem(handle.db, other.id)).toEqual([]);

    release.open();
    await done;
    await again;
    await engine.runOnce();
    expect(stepOf(other)).toBe("team_accepted");
  });

  it("runs two admitted sessions' turns side by side, each to its own maxParallel, with no machine-wide limit between them", async () => {
    const release = gate();
    member = answers(release.wait);
    const second = createTestItem(handle.db, { type: "story", title: "Rate limit the webhooks", stepId: "team_review", priority: 1 });
    // Room for both sessions under every cap: each is one run of the agent.
    const engine = supervisor({ limits: { globalConcurrency: 2, perAgentConcurrency: 2, perRepositoryConcurrency: 2 } });

    const done = engine.runOnce();
    // Four members on each item at once: eight turns, past any one team's limit, and held back by nothing else.
    await vi.waitFor(() => expect(running).toBe(8));
    for (const one of [team, second]) expect(memberRuns(one).filter((run) => run.status === "running" && run.agentId === reviewer.id)).toHaveLength(4);
    expect(listCommentsForItem(handle.db, team.id).concat(listCommentsForItem(handle.db, second.id)).filter((comment) => comment.body.includes("is waiting for room to start"))).toEqual([]);

    release.open();
    await done;
    expect(peak).toBe(8);
    for (const one of [team, second]) expect(stepOf(one)).toBe("team_accepted");
  });

  it("releases its slot when the session parks on a question", async () => {
    member = ({ opts }) =>
      (async function* () {
        yield { type: "thread_started", threadId: `thread-${uuidv7()}` } as AgentEvent;
        const asking = opts.context.includes("## Your assignment: criteria");
        yield { type: "result", data: asking ? { outcome: { status: "clarification_required", questions: [{ id: "q1", question: "Per key or per account?", why: "It decides the check." }] } } : { outcome: { report: "Nothing blocks." } } } as AgentEvent;
      })();
    const other = createTestItem(handle.db, { type: "story", title: "Check the docs", stepId: "solo_check", priority: 1 });
    const engine = supervisor();
    await engine.runOnce();
    expect(listRunsForItem(handle.db, team.id).find((run) => run.action === "alignment")?.status).toBe("awaiting_input");
    await engine.runOnce();
    expect(stepOf(other)).toBe("team_accepted");
  });
});

describe("a team session against the guards on a run (EO-871)", () => {
  it("settles with its answer when its turns together run past the wall clock, each inside it", async () => {
    setTeam(teamOfOne({ limits: { maxParticipants: 4, maxParallel: 1, maxRounds: 1 } }));
    member = answers(120);
    await supervisor({ guards: { wallClockTimeoutMs: 300 } }).runOnce();

    const own = listRunsForItem(handle.db, team.id).find((run) => run.action === "alignment")!;
    expect(own.endedAt! - own.startedAt!).toBeGreaterThan(300);
    expect(own.status).toBe("succeeded");
    expect(stepOf(team)).toBe("team_accepted");
    expect(memberRuns(team).every((run) => run.status === "succeeded")).toBe(true);
  });

  it("holds each turn to the wall clock: a member past it fails, as an ordinary run would, and is retried", async () => {
    setTeam(teamOfOne({ limits: { maxParticipants: 4, maxParallel: 4, maxRounds: 1, maxRetries: 1 } }));
    let slow = 0;
    member = ({ opts }) => {
      if (opts.context.includes("## Your assignment: tests") && slow++ === 0) {
        return (async function* () {
          yield { type: "thread_started", threadId: `thread-${uuidv7()}` } as AgentEvent;
          await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
          throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
        })();
      }
      return answers()({ opts, leader: false });
    };
    await supervisor({ guards: { wallClockTimeoutMs: 200 } }).runOnce();

    const failed = memberRuns(team).filter((run) => run.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toContain("Wall-clock timeout of 200ms exceeded.");
    expect(stepOf(team)).toBe("team_accepted");
  });

  it("holds each turn to the inactivity guard: a member that goes silent fails with why", async () => {
    setTeam(teamOfOne({ limits: { maxParticipants: 4, maxParallel: 4, maxRounds: 1, maxRetries: 0 } }));
    const LIMIT = 10 * 60_000;
    let clock = Date.now();
    member = ({ opts }) => {
      if (!opts.context.includes("## Your assignment: tests")) return answers()({ opts, leader: false });
      return (async function* () {
        yield { type: "thread_started", threadId: `thread-${uuidv7()}` } as AgentEvent;
        await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
      })();
    };
    const engine = supervisor({ guards: { inactivityTimeoutMs: LIMIT }, now: () => clock });
    const done = engine.runOnce();
    await vi.waitFor(() => expect(memberRuns(team).filter((run) => run.status === "succeeded")).toHaveLength(4));
    engine.watchLiveRuns();
    for (let gone = 0; gone < LIMIT + 60_000; gone += 30_000) {
      clock += 30_000;
      engine.watchLiveRuns();
    }
    await done;

    const silent = memberRuns(team).find((run) => run.status === "failed");
    expect(silent?.error).toContain("No word from Rhea's backend");
    // Its retries spent, the session parks on what failed rather than settle: nothing moves.
    expect(stepOf(team)).toBe("team_review");
  });
});
