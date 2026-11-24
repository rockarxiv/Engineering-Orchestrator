import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { StepTeamSchema, type IndependentTeam } from "@eo/core";
import { planIndependentTeam, type TeamAttemptState } from "./teamSupervision.js";

/**
 * The publication review example (`docs/examples/teams/`, EO-850), decided
 * by the pure engine alone: a team with no repository, no developer-pack
 * role and nothing but opaque evidence keys, planned turn by turn until it
 * settles. What the engine sees of a source is a key to compare, so a
 * draft attached to an item is the same to it as a commit.
 */

const document = JSON.parse(readFileSync(new URL("../../../docs/examples/teams/publication-review.json", import.meta.url), "utf8")) as { steps: { team?: unknown }[] };
const parsed = StepTeamSchema.parse(document.steps.find((step) => step.team !== undefined)!.team);
if (parsed.coordination !== "independent") throw new Error("independent");
const TEAM: IndependentTeam = parsed;


type Answer = { outcome: string } | "crash";

/**
 * Runs the plan to its end: every turn it starts answers what `answers`
 * says for its assignment, one answer per turn in order, on `baseline`.
 */
function settle(answers: Record<string, Answer[]>, baseline = "draft-v1"): { decision: ReturnType<typeof planIndependentTeam>["decision"]; turns: number } {
  const attempts: TeamAttemptState[] = [];
  let turns = 0;
  for (let step = 0; step < 50; step += 1) {
    const plan = planIndependentTeam({ team: TEAM, attempts, baseline });
    if (plan.decision.status !== "pending" || plan.start.length === 0) return { decision: plan.decision, turns };
    for (const start of plan.start) {
      turns += 1;
      const answer = answers[start.key]!.shift() ?? "crash";
      const id = `attempt-${turns}`;
      if (start.supersedes !== null) {
        const replaced = attempts.find((attempt) => attempt.id === start.supersedes);
        if (replaced) replaced.supersededBy = id;
      }
      attempts.push(
        answer === "crash"
          ? { id, key: start.key, status: "failed", supersededBy: null, outcome: null, report: null, error: "The backend exited.", baseline, live: false }
          : { id, key: start.key, status: "completed", supersededBy: null, outcome: answer.outcome, report: `${start.key}: ${answer.outcome}.`, error: null, baseline, live: false },
      );
    }
  }
  throw new Error("The plan never settled.");
}

describe("the publication review example in the pure engine (EO-850)", () => {
  it("decides ready to publish when every specialist is satisfied", () => {
    const { decision } = settle({ accuracy: [{ outcome: "ready" }], legal: [{ outcome: "ready" }], style: [{ outcome: "ready" }] });
    expect(decision).toMatchObject({ status: "decided", result: "ready_to_publish", rule: null });
  });

  it("must send it back when any one specialist finds something that must change", () => {
    for (const key of ["accuracy", "legal", "style"]) {
      const answers: Record<string, Answer[]> = { accuracy: [{ outcome: "ready" }], legal: [{ outcome: "ready" }], style: [{ outcome: "ready" }] };
      answers[key] = [{ outcome: "blocking" }];
      expect(settle(answers).decision, key).toMatchObject({ status: "decided", result: "needs_revision", rule: 0 });
    }
  });

  it("never reads a required specialist who could not contribute as a finding or a pass", () => {
    const { decision, turns } = settle({ accuracy: [{ outcome: "ready" }], legal: ["crash", "crash"], style: [{ outcome: "ready" }] });
    expect(decision.status).toBe("failed");
    // Its first turn and one retry, as the example's limits allow, and no more.
    expect(turns).toBe(4);
  });

  it("leaves out an optional specialist who could not contribute, and says so", () => {
    const { decision } = settle({ accuracy: [{ outcome: "ready" }], legal: [{ outcome: "ready" }], style: ["crash", "crash"] });
    expect(decision).toMatchObject({ status: "decided", result: "ready_to_publish" });
    expect(decision.status === "decided" && decision.summary).toContain("**style** (copy_editor, optional): could not contribute");
  });

  it("decides nothing on a report made against a draft that has since been replaced", () => {
    const attempts: TeamAttemptState[] = TEAM.participants.map((participant, index) => ({
      id: `old-${index}`,
      key: participant.key,
      status: "completed",
      supersededBy: null,
      outcome: "ready",
      report: "Read the first draft.",
      error: null,
      baseline: "draft-v1",
      live: false,
    }));
    const plan = planIndependentTeam({ team: TEAM, attempts, baseline: "draft-v2" });
    expect(plan.decision.status).toBe("pending");
    // Each is done again on the new draft, replacing the stale report, as fast as the team's limits allow.
    expect(plan.start.map((one) => [one.key, one.supersedes])).toEqual([
      ["accuracy", "old-0"],
      ["legal", "old-1"],
    ]);
    expect(plan.waiting.map((one) => one.key)).toEqual(["style"]);
  });
});
