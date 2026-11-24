import { actionFactsFor, deterministicAnswerProblem, stepAgentOf, teamConfigProblems, teamMemberMode, teamResultKeys, teamRoles } from "@eo/core";
import type { PipelineStep, RegistryFacts, StepAgentFacts } from "@eo/core";

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
 * - on a team that names no agents yet — one still carried inline, as an
 *   imported document carries it, which is declared by binding each role
 *   to an agent — every role must be staffed on the pipeline's project
 *   (`staffedRoles`), an error rather than the warning an unstaffed owner
 *   role gets, because a team that cannot be staffed whole cannot reach a
 *   result at all. A step naming a declared team runs each of its agents
 *   as itself (EO-882), and `declaredTeamProblems` judges those agents;
 * - the step's action is the contract the team answers: an independent
 *   team's results must be keys it declares, and its answer must be one
 *   EO can build from a result and a summary (`deterministicAnswerProblem`);
 *   a leader-led team's leader answers it, so the action must be defined
 *   for its answer to be held to anything;
 * - what an outcome rules out (EO-873) must be results the action declares;
 * - a team's own time limit can only be tighter than the run timeout;
 * - on such a team too, every agent one of its roles could be bound to
 *   must be one EO can hold to report-only (EO-848,
 *   `reportOnlyRoleProblems`), so a team
 *   that would be refused at its first participant is refused at publish —
 *   for a report-only team only: an isolated team's member runs as its
 *   role's agent does on an ordinary dispatch (EO-867), so any agent that
 *   can run the step alone can be one;
 * - an isolated team's step must work where each member can be given a
 *   copy of its own (`isolatedCopyProblems`, by step: the sentence naming
 *   the workspace kinds that cannot make one). An error only where no
 *   workspace the step could work in makes copies; where some do, a
 *   warning (EO-871), since an item in one that cannot is refused at start
 *   with a comment, and the team runs everywhere else.
 *
 * Both kinds run (EO-846, EO-847), so neither carries a warning that it
 * would run as one agent.
 */
/**
 * Why an isolated team's step could not give each member a copy of its own
 * (EO-867): `why` is the clause naming the workspace kinds that make none.
 * An `error` where no workspace the step could work in makes copies, so the
 * team could never run; a `warning` where only some cannot (EO-871).
 */
export interface IsolatedCopyProblem {
  severity: "error" | "warning";
  why: string;
}

export function teamProblems(
  steps: readonly (Pick<PipelineStep, "id" | "name" | "type" | "agentId" | "entryAction" | "team"> & { teamId?: string | null })[],
  context: {
    registry: RegistryFacts;
    /** The agents a step may name (EO-875): a step's action is its agent's kind's, so the team answers that kind's action. */
    agents: readonly StepAgentFacts[];
    staffedRoles: readonly string[];
    runTimeoutMs: number;
    reportOnlyRoleProblems?: Readonly<Record<string, string>>;
    /** Why an isolated team on this step could not give its members copies of their own, by step id (EO-867), and whether that is everywhere it could work or only somewhere (EO-871). */
    isolatedCopyProblems?: Readonly<Record<string, IsolatedCopyProblem>>;
  },
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
    const isolated = teamMemberMode(team) === "isolated";
    // A declared team's agents are its own, judged by name (EO-882): no role is staffed.
    const declared = step.teamId !== null && step.teamId !== undefined;
    for (const role of declared ? [] : new Set(teamRoles(team))) {
      if (!staffed.has(role)) error(`The team on "${step.name}" needs a "${role}" agent, and this project has none enabled.`);
      else if (!isolated) {
        const why = context.reportOnlyRoleProblems?.[role];
        if (why !== undefined) error(`The team on "${step.name}" could be staffed by a "${role}" agent EO cannot hold to report-only: ${why}`);
      }
    }
    if (isolated) {
      const copy = context.isolatedCopyProblems?.[step.id];
      if (copy !== undefined) problems.push({ stepId: step.id, severity: copy.severity, message: `The team on "${step.name}" has isolated members, ${copy.why}` });
    }
    if (team.limits.timeoutMs !== undefined && team.limits.timeoutMs > context.runTimeoutMs) {
      error(`The team on "${step.name}" allows ${team.limits.timeoutMs} ms, longer than the ${context.runTimeoutMs} ms any run may take: a team's limit can only be tighter.`);
    }
    // The kind of the agent the step names (EO-875): the action the team
    // answers is that kind's.
    const kind = stepAgentOf(context.agents, step)?.role ?? null;
    if (kind !== null && step.entryAction !== null && step.entryAction !== "") {
      const facts = actionFactsFor(context.registry, kind, step.entryAction);
      if (facts !== undefined) {
        // What an outcome rules out is a result of this action (EO-873):
        // a key it cannot return would rule out nothing, silently.
        const results = new Set(facts.results.map((result) => result.key));
        for (const outcome of team.outcomes) {
          for (const key of outcome.rulesOut ?? []) {
            if (!results.has(key)) error(`The team on "${step.name}": the outcome "${outcome.key}" rules out "${key}", which "${step.entryAction}" cannot return.`);
          }
        }
      }
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
  }
  return problems;
}
