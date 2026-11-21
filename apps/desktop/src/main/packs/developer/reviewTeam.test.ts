import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEAM_PARTICIPANT_ACTION, uuidv7, type Agent, type AgentEvent, type AgentProvider, type AgentProviderStartOptions, type Item, type LeaderTeam, type StepTeam } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../db/client.js";
import { createAgent, listAgents, updateAgent } from "../../db/repos/agentsRepo.js";
import { listCommentsForItem, postComment } from "../../db/repos/commentsRepo.js";
import { listReviewVerdicts } from "../../db/repos/index.js";
import { getItem } from "../../db/repos/itemsRepo.js";
import { getPipeline, listRoutesForPipeline, listStepsForPipeline } from "../../db/repos/pipelineStepsRepo.js";
import { listRunsForItem } from "../../db/repos/runsRepo.js";
import { listTeamSessionsForItem } from "../../db/repos/teamSessionsRepo.js";
import { listTransitionsForItem } from "../../db/repos/transitionsRepo.js";
import { createTestItem, openMigratedTestDb } from "../../db/testHelpers.js";
import { loadTemplateHistory } from "../../gallery/history.js";
import { backfillPipelineOrigins } from "../../gallery/origins.js";
import { applyTemplateUpdates } from "../../gallery/templateUpdates.js";
import { savePipeline, storedGraphProblems } from "../../ipc/configCommands.js";
import { BUILTIN_RUNNERS } from "./builtins.js";
import { developerSectionRenderers } from "./sections.js";
import { createRoleWiring } from "./wiring.js";
import { syncRolePrompts } from "../../roles/prompts.js";
import { createRunSupervisor, type RunSupervisor } from "../../supervisor/runSupervisor.js";

/**
 * The bundled software template's Review step as a team (EO-868): a
 * leader-led team of focused reviewers, in isolated mode, run end to end
 * through the supervisor on the Delivery pipeline a fresh installation
 * has once its first launch brought it to the template's newest version.
 *
 * Mocked: the backends, scripted per turn. Real: the template, the
 * seeded agents and their prompts, the developer pack's review schema,
 * verdict and routing, the team supervisor and the member copies (on no
 * disk, the kind an item without a repository works in).
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "resources", "gallery");
const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 2, perRepositoryConcurrency: 1 };
const CRITERIA = ["A key over its limit gets a 429", "The 429 carries a Retry-After header", "The limit is configurable per key"];
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

let handle: DbHandle;
let scratch: string;
let started: Started[];
let script: Script;
const supervisors: RunSupervisor[] = [];

async function* says(data: unknown, afterMs = 0): AsyncGenerator<AgentEvent> {
  yield { type: "thread_started", threadId: `thread-${uuidv7()}` };
  // A member's turn takes a moment, so the passes overlap as they do on a real backend.
  if (afterMs > 0) await new Promise((resolve) => setTimeout(resolve, afterMs));
  yield { type: "result", data };
}

function providerFor(agent: Agent): AgentProvider {
  return {
    start: (opts) => {
      started.push({ agent, opts });
      const assignment = /## Your assignment: (\w+)/.exec(opts.context)?.[1] ?? null;
      const leader = opts.context.includes("## What you lead");
      return says(script({ agent, opts, leader, assignment }), assignment === null ? 0 : 30)[Symbol.asyncIterator]() as unknown as ReturnType<AgentProvider["start"]>;
    },
    resume: () => {
      throw new Error("Nothing here resumes.");
    },
  };
}

function supervisor(): RunSupervisor {
  const made = createRunSupervisor({
    db: handle.db,
    limits: LIMITS,
    provider: providerFor,
    reportOnlyProvider: () => {
      throw new Error("A member of the Review team was built as a report-only participant.");
    },
    teamPollMs: 5,
    noDiskRoot: join(scratch, "no-disk"),
    builtins: BUILTIN_RUNNERS,
    sectionRenderers: developerSectionRenderers,
    ...createRoleWiring(handle.db),
  });
  supervisors.push(made);
  return made;
}

/** Delivery on the template's newest version, as a fresh installation has it after its first launch, with the reviewers on `roster`. */
function freshInstallation(roster?: Roster): void {
  syncRolePrompts(handle.db);
  const history = loadTemplateHistory(GALLERY_DIRECTORY);
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

/** A leader's first round: every pass, each required, with the note the instructions ask for. */
function assignEvery(passes: readonly Pass[]): unknown {
  return {
    outcome: {
      decision: "assign",
      assignments: passes.map((key) => ({ key, role: "reviewer", instructions: `Your focus is ${key}, and only ${key}.`, required: true })),
      note: "Security assigned: the change reads a key from the request. User-facing assigned: the change adds an error response.",
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

/** A leader that, once the reports are in, builds its answer from them as the instructions say. */
function leading(passes: readonly Pass[], answer: (reports: { id: string; body: string }[]) => Record<string, unknown>): (turn: Parameters<Script>[0]) => unknown {
  let turns = 0;
  return ({ opts }) => {
    turns += 1;
    if (turns === 1) return assignEvery(passes);
    const reports = reportsIn(opts.context);
    return { outcome: { decision: "final", answer: answer(reports), contributions: reports.map((one) => one.id), disagreements: "None.", limitations: "None." } };
  };
}

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
});

afterEach(async () => {
  for (const made of supervisors.splice(0)) await made.shutdown();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("the template's Review team, on either backend (EO-868)", () => {
  describe.each(ROSTERS)("$name", (roster) => {
    beforeEach(() => freshInstallation(roster));

    /** What every scenario leaves true: one team session, settled; every member on its agent's backend. */
    function settledOnce(item: Item): void {
      expect(listTeamSessionsForItem(handle.db, item.id).map((record) => record.session.status)).toEqual(["finalized"]);
      expect(new Set(started.map((one) => one.agent.provider))).toEqual(new Set(roster.reviewers));
      expect(started.every((one) => one.agent.role === "reviewer")).toBe(true);
    }

    /** The item moved once, to where the verdict's route sends it. */
    function movedOnceTo(item: Item, resultKey: string): void {
      settledOnce(item);
      const moves = listTransitionsForItem(handle.db, item.id);
      expect(moves).toHaveLength(1);
      expect(moves[0]!.toStepId).toBe(routeOf(resultKey));
      expect(getItem(handle.db, item.id)?.stepId).toBe(routeOf(resultKey));
    }

    it("approves on clean reports, with the pull request body, from a leader who assigned the four passes every review gets", async () => {
      const item = story();
      const passes: Pass[] = ["criteria", "impact", "tests", "rules"];
      const lead = leading(passes, () => ({ verdict: "approve", feedback: "Every pass came back clean.", pull_request_body: "Rate limits the API per key." }));
      script = (turn) => (turn.leader ? lead(turn) : { outcome: { outcome: "clear", report: `Checked ${turn.assignment}: nothing blocks.` } });

      await supervisor().runOnce();

      movedOnceTo(item, "approved");
      expect(memberTurns().map((one) => /## Your assignment: (\w+)/.exec(one.opts.context)![1]).sort()).toEqual([...passes].sort());
      expect(leaderTurns()).toHaveLength(2);
      // The leader is told what to assign, in the template's own words.
      expect(leaderTurns()[0]!.opts.context).toContain(reviewTeam().leader.instructions);
    });

    it("rejects once, carrying every blocking issue from every pass, merged and de-duplicated, with coverage for every criterion", async () => {
      const item = story();
      const passes = Object.keys(PASSES) as Pass[];
      const lead = leading(passes, (reports) => ({ verdict: "reject", feedback: "Six passes, six faults.", blocking_issues: blockingIn(reports), criteria_coverage: coverage() }));
      script = (turn) => (turn.leader ? lead(turn) : memberFinding(turn.assignment!));

      await supervisor().runOnce();

      movedOnceTo(item, "changes_requested");
      expect(memberTurns()).toHaveLength(6);
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
      const passes: Pass[] = ["criteria", "impact", "tests", "rules"];
      const lead = leading(passes, () => ({ verdict: "needs_user_input", feedback: "Decide whether a limit applies per key or per account: the story says key, the thread says account." }));
      script = (turn) =>
        turn.leader ? lead(turn) : { outcome: turn.assignment === "criteria" ? { outcome: "needs_decision", report: "Per key or per account is not mine to decide." } : { outcome: "clear", report: "Nothing blocks." } };

      await supervisor().runOnce();

      // Its route is to the person: the item is flagged where it stands, and the step's run waits on them.
      settledOnce(item);
      expect(routeOf("needs_user_input")).toBe("user_attention");
      expect(listTransitionsForItem(handle.db, item.id)).toEqual([]);
      expect(getItem(handle.db, item.id)?.stepId).toBe("review");
      expect(listRunsForItem(handle.db, item.id).find((run) => run.action === "review")?.status).toBe("awaiting_input");
      expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.body.includes("the pipeline routes this result to you"))).toBe(true);
      expect(ownVerdicts(item).some((comment) => comment.body.includes("per key or per account"))).toBe(true);
    });
  });
});

describe("a member of the template's Review team", () => {
  beforeEach(() => freshInstallation(ROSTERS[0]));

  it("works as the template's reviewer does, in a copy of its own: its prompt, the diff, the criteria and its assignment", async () => {
    const item = story();
    const lead = leading(["criteria", "impact", "tests", "rules"], () => ({ verdict: "approve", feedback: "Clean.", pull_request_body: "Body." }));
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
    const lead = leading(["criteria", "impact", "tests", "rules"], () => ({ verdict: "approve", feedback: "Clean.", pull_request_body: "Body." }));
    script = (turn) => (turn.leader ? lead(turn) : { outcome: { outcome: "clear", report: "Nothing blocks." } });

    await supervisor().runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe(routeOf("approved"));
    expect(memberTurns()).toHaveLength(4);
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => /report-only|refus/i.test(comment.body))).toEqual([]);
  });
});

/**
 * Removing the team gives back the single reviewer (EO-868): the step is
 * 1.4's Review again, and one reviewer answers it as it did before.
 */
describe("the template's Review step with its team removed", () => {
  beforeEach(() => freshInstallation(ROSTERS[0]));

  it("is the single-reviewer Review the template had before, dispatched as one review", async () => {
    const pipeline = getPipeline(handle.db, "default")!;
    const steps = listStepsForPipeline(handle.db, "default");
    const saved = savePipeline(handle.db, { notifyStateChange: () => {} }, {
      pipelineId: "default",
      steps: steps.map((step) => (step.id === "review" ? { ...step, team: null } : { ...step })),
      routes: listRoutesForPipeline(handle.db, "default"),
      entryStepId: pipeline.entryStepId,
    });
    expect(saved.saved).toBe(true);

    const before = loadTemplateHistory(GALLERY_DIRECTORY)
      .get("software-feature-to-merge")!
      .find((version) => version.version === "1.4")!
      .document.steps.find((step) => step.id === "review")!;
    const review = listStepsForPipeline(handle.db, "default").find((step) => step.id === "review")!;
    expect(review.team).toBeNull();
    expect({ name: review.name, type: review.type, ownerRole: review.ownerRole, entryAction: review.entryAction, instructionsSummary: review.instructionsSummary, planMode: review.planMode, isTerminal: review.isTerminal }).toEqual({
      name: before.name,
      type: before.type,
      ownerRole: before.ownerRole,
      entryAction: before.entryAction,
      instructionsSummary: before.instructionsSummary,
      planMode: before.planMode,
      isTerminal: before.isTerminal,
    });

    const item = story();
    script = () => ({ verdict: "reject", feedback: "One fault.", blocking_issues: [PASSES.criteria], criteria_coverage: coverage() });

    await supervisor().runOnce();

    expect(started).toHaveLength(1);
    expect(started[0]!.opts.instructions).not.toContain("## Your part in a team");
    expect(started[0]!.opts.context).not.toContain("## What you lead");
    expect(listTeamSessionsForItem(handle.db, item.id)).toEqual([]);
    expect(listRunsForItem(handle.db, item.id).map((run) => run.action)).toEqual(["review"]);
    expect(getItem(handle.db, item.id)?.stepId).toBe(routeOf("changes_requested"));
  });
});
