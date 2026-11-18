import { actionFactsFor, deterministicAnswerProblem, teamConfigProblems, teamResultKeys, teamRoles } from "@eo/core";
import type { PipelineStep, RegistryFacts } from "@eo/core";

/** One problem with a step's team, on that step. */
export interface TeamProblem {
  stepId: string;
  severity: "error" | "warning";
  message: string;
}

/**
 * What is wrong with the teams these steps carry (EO-843, ARCHITECTURE.md,
 * "A team on an agent step"), as sentences naming the step.
 *
 * Data in, data out (invariant 2). On top of the team's own checks
 * (`teamConfigProblems`, which parsing a team already applies):
 *
 * - only an `agent` step may have a team;
 * - every role it would dispatch must be staffed on the pipeline's
 *   project, by the same rule the scheduler uses (`staffedRoles`) — an
 *   error rather than the warning an unstaffed owner role gets, because a
 *   team that cannot be staffed whole cannot reach a result at all;
 * - the step's action is the contract the team answers: an independent
 *   team's results must be keys it declares, and its answer must be one
 *   EO can build from a result and a summary (`deterministicAnswerProblem`);
 *   a leader-led team's leader answers it, so the action must be defined
 *   for its answer to be held to anything;
 * - a team's own time limit can only be tighter than the run timeout.
 *
 * Every team also gets a warning saying it runs as one agent for now:
 * the contract ships ahead of the orchestration, and a team nobody runs
 * must not look like one that ran.
 */
export function teamProblems(
  steps: readonly Pick<PipelineStep, "id" | "name" | "type" | "ownerRole" | "entryAction" | "team">[],
  context: { registry: RegistryFacts; staffedRoles: readonly string[]; runTimeoutMs: number },
): TeamProblem[] {
  const staffed = new Set(context.staffedRoles);
  const problems: TeamProblem[] = [];
  for (const step of steps) {
    // Absent as well as null: a step built before teams has none.
    const team = step.team;
    if (team === null || team === undefined) continue;
    const error = (message: string) => problems.push({ stepId: step.id, severity: "error", message });
    if (step.type !== "agent") {
      error(`"${step.name}" has a team, but only a step an agent does can run as one.`);
      continue;
    }
    for (const message of teamConfigProblems(team)) error(`The team on "${step.name}": ${message}`);
    for (const role of new Set(teamRoles(team))) {
      if (!staffed.has(role)) error(`The team on "${step.name}" needs a "${role}" agent, and this project has none enabled.`);
    }
    if (team.limits.timeoutMs !== undefined && team.limits.timeoutMs > context.runTimeoutMs) {
      error(`The team on "${step.name}" allows ${team.limits.timeoutMs} ms, longer than the ${context.runTimeoutMs} ms any run may take: a team's limit can only be tighter.`);
    }
    if (step.ownerRole !== null && step.entryAction !== null && step.entryAction !== "") {
      const facts = actionFactsFor(context.registry, step.ownerRole, step.entryAction);
      if (team.coordination === "independent") {
        const answer = deterministicAnswerProblem(step.name, step.entryAction, facts);
        if (answer !== null) error(answer);
        if (facts !== undefined) {
          const declared = new Set(facts.results.map((result) => result.key));
          for (const key of teamResultKeys(team)) {
            if (!declared.has(key)) error(`The team on "${step.name}" can decide "${key}", which "${step.entryAction}" cannot return.`);
          }
        }
      } else if (facts === undefined) {
        error(`The team on "${step.name}" is led, and its leader's answer is held to "${step.entryAction}", which nothing defines.`);
      }
    } else if (step.entryAction === null || step.entryAction === "") {
      error(`The team on "${step.name}" has no action to answer: give the step an entry action.`);
    }
    problems.push({
      stepId: step.id,
      severity: "warning",
      message: `"${step.name}" has a team, which this version of EO does not run yet: it runs as one agent until team execution is available.`,
    });
  }
  return problems;
}
