import { z } from "zod";
import { SYSTEM_ROLE } from "./domain.js";
import type { ActionFacts } from "./registry/index.js";
import { ACTION_KEY_PATTERN, RESERVED_ANSWER_FIELDS } from "./schemas/actionDefinition.js";

/**
 * A team on an agent step (EO-843, ARCHITECTURE.md, "A team on an agent
 * step"): several focused, report-only agents contributing to the one
 * result the step returns.
 *
 * Not a fifth kind of step and not a catalogue of teams: an optional
 * setting of an `agent` step, versioned, exported and validated with the
 * graph like every other step field (invariant 7). A step without one is
 * a single agent, which is every step written before this existed.
 *
 * Portable by construction. A participant is staffed by **role**, under
 * the project's ordinary staffing rule (`staffingAgents`), and never by an
 * agent id, so a pipeline exported from one installation means the same
 * thing on another. Nothing here names a tool, a server or a grant: a
 * participant is dispatched with what its role's agent already has —
 * reduced to report-only, or as it is in a copy of its own where the team's
 * members are `isolated` (EO-867) — and the objects are strict so a key that tried to say otherwise —
 * `allowedTools`, `mcpServers`, an `agentId` — is refused rather than
 * dropped (invariant 11).
 *
 * Two ways to coordinate:
 *
 * - `independent`: a fixed list of participants, each with a stable
 *   assignment key, a role and focused instructions, each reporting one of
 *   the team's declared outcomes. EO decides the step's result from those
 *   outcomes with a small ordered table of all/any rules and a fallback
 *   (`decideIndependentTeam`), and answers the step's action with that
 *   result and the assembled reports — so only an action whose answer is
 *   `result` and `summary` alone can be answered that way
 *   (`deterministicAnswerProblem`).
 * - `leader`: one leader, in a named role, assigns bounded work to agents
 *   of the permitted roles and answers the step's action itself; its answer
 *   is held to that action's schema like any agent's.
 *
 * Contracts only. This file declares the shape and decides what a set of
 * contributions comes to; what a team's turns answer with is
 * `teamTurns.ts`, and running them is the supervisor's.
 */

/** A key, an outcome or a result: what a route key is typed as. */
export const TeamKeySchema = z.string().regex(ACTION_KEY_PATTERN, "Use lowercase letters, digits and underscores.");

/** What a role slug may be: any non-empty name, since roles are configuration. */
const RoleSchema = z.string().trim().min(1);

/** Focused instructions: what this participant is asked to look at. Bounded, because it is sent on every one of its runs. */
export const TeamInstructionsSchema = z.string().trim().min(1).max(4000);

/**
 * The hard ceilings no team may exceed, whatever it declares. Small on
 * purpose: participants run in parallel as a bounded exception to the
 * concurrency invariant (CLAUDE.md, invariant 10), and every one of them
 * is a real subprocess and a real bill.
 */
export const TEAM_CEILINGS = { participants: 8, parallel: 4, rounds: 5, retries: 3 } as const;

/**
 * What a team gets for a limit it leaves out: conservative, so a team
 * nobody tuned is two agents at a time, one retry each.
 */
export const DEFAULT_TEAM_LIMITS = { maxParticipants: 4, maxParallel: 2, maxRounds: 2, maxRetries: 1 } as const;

/**
 * The limits both kinds of team share.
 *
 * `timeoutMs` and `budgetCents` only ever tighten what is already there:
 * a team inherits the run timeout and the per-item and daily budgets
 * (ARCHITECTURE.md, "Guardrails"), and these, when set, are a lower
 * ceiling for the whole team — `validatePipeline` refuses a timeout above
 * the run timeout. Left out, nothing is added.
 */
const sharedLimits = {
  /** How many participants the team may run in all, a leader's assignments included. */
  maxParticipants: z.number().int().min(1).max(TEAM_CEILINGS.participants).default(DEFAULT_TEAM_LIMITS.maxParticipants),
  /** How many may run at once. */
  maxParallel: z.number().int().min(1).max(TEAM_CEILINGS.parallel).default(DEFAULT_TEAM_LIMITS.maxParallel),
  /** How many times one participant's failed run is tried again. */
  maxRetries: z.number().int().min(0).max(TEAM_CEILINGS.retries).default(DEFAULT_TEAM_LIMITS.maxRetries),
  /** A wall-clock ceiling for the whole team, in milliseconds, no higher than the run timeout. */
  timeoutMs: z.number().int().positive().optional(),
  /** A spending ceiling for the whole team, in cents, inside the item's and the day's budgets. */
  budgetCents: z.number().int().positive().optional(),
};

/**
 * How a team's members work (EO-867), chosen per team:
 *
 * - `report_only`, the default and every team written before this: each
 *   member reads a captured copy of the evidence through four tools and
 *   changes nothing (EO-845). For content EO should not let an agent act
 *   on.
 * - `isolated`: each member is dispatched exactly as its role's agent is
 *   on an ordinary dispatch of the step — its backend, executable, model,
 *   setup, servers, skills, CLI tools, grants, permissions, the
 *   repository index and the ordinary context — standing in a copy of the
 *   item's workspace made for its attempt alone and removed when the
 *   attempt ends. Nothing it does there reaches the item's work or
 *   another member's, and it sees none of its team's other reports.
 */
export const TEAM_MEMBER_MODES = ["report_only", "isolated"] as const;
export type TeamMemberMode = (typeof TEAM_MEMBER_MODES)[number];
export const DEFAULT_TEAM_MEMBER_MODE: TeamMemberMode = "report_only";

/** A team's member mode, read from a stored team: report-only for one written before modes existed. */
export function teamMemberMode(team: { members?: TeamMemberMode } | null | undefined): TeamMemberMode {
  return team?.members ?? DEFAULT_TEAM_MEMBER_MODE;
}

const TeamMemberModeSchema = z.enum(TEAM_MEMBER_MODES).default(DEFAULT_TEAM_MEMBER_MODE);

/** An independent team's limits. No rounds: every participant contributes once. */
export const IndependentTeamLimitsSchema = z.strictObject(sharedLimits);

/** A leader-led team's limits: the shared ones and how many rounds of assignments the leader may make. */
export const LeaderTeamLimitsSchema = z.strictObject({
  ...sharedLimits,
  maxRounds: z.number().int().min(1).max(TEAM_CEILINGS.rounds).default(DEFAULT_TEAM_LIMITS.maxRounds),
});

/** One conclusion a participant may report, declared by the team. */
export const TeamOutcomeSchema = z.strictObject({
  key: TeamKeySchema,
  /** What a person reads where the key would be shown. */
  label: z.string().trim().min(1),
  /** When a participant reports it — the sentence it is given beside the key. */
  meaning: z.string().default(""),
  /**
   * The results of the step's action an accepted report with this outcome
   * rules out (EO-873). A leader-led team's final answer naming one of
   * them is refused unless its `disagreements` overrules that report on a
   * line of its own, `Overruled <assignment key or comment id>: <why>`.
   * Data, so the team says what contradicts what
   * and EO knows no outcome or result by name. Left out, it rules out
   * nothing.
   */
  rulesOut: z
    .array(TeamKeySchema)
    .optional()
    .describe(
      "Leader-led teams only: result keys of the step's action that an accepted report with this outcome rules out. The leader's final answer may name one only by overruling that report on a line of its disagreements: \"Overruled <assignment key or comment id>: <why>\".",
    ),
});
export type TeamOutcome = z.infer<typeof TeamOutcomeSchema>;

/** One participant of an independent team. */
export const TeamParticipantSchema = z.strictObject({
  /** Stable within the step: what its reports, retries and the summary are attributed to. */
  key: TeamKeySchema,
  /** Who is dispatched: an agent of this role, by the project's staffing rule. */
  role: RoleSchema,
  instructions: TeamInstructionsSchema,
  /**
   * Whether the team cannot decide without it. A required participant that
   * fails to contribute fails the team; an optional one is left out of the
   * decision and named in the summary.
   */
  required: z.boolean().default(true),
});
export type TeamParticipant = z.infer<typeof TeamParticipantSchema>;

/**
 * One row of an independent team's completion table: when all, or any, of
 * the completed contributions reported one of `outcomes`, the step's
 * result is `result`.
 */
export const TeamCompletionRuleSchema = z.strictObject({
  when: z.enum(["all", "any"]),
  outcomes: z.array(TeamKeySchema).min(1),
  /** A result key of the step's action. */
  result: TeamKeySchema,
});
export type TeamCompletionRule = z.infer<typeof TeamCompletionRuleSchema>;

export const IndependentTeamSchema = z.strictObject({
  coordination: z.literal("independent"),
  /** How its members work (`TEAM_MEMBER_MODES`). */
  members: TeamMemberModeSchema,
  participants: z.array(TeamParticipantSchema).min(1).max(TEAM_CEILINGS.participants),
  outcomes: z.array(TeamOutcomeSchema).min(1),
  completion: z.strictObject({
    /** Read in order; the first that holds decides. */
    rules: z.array(TeamCompletionRuleSchema).max(16),
    /** The result when no rule holds — never reached by a team missing a required contribution. */
    fallback: TeamKeySchema,
  }),
  limits: IndependentTeamLimitsSchema.prefault({}),
});
export type IndependentTeam = z.infer<typeof IndependentTeamSchema>;

export const LeaderTeamSchema = z.strictObject({
  coordination: z.literal("leader"),
  /** How its members work, the leader included (`TEAM_MEMBER_MODES`). */
  members: TeamMemberModeSchema,
  /** Who leads: an agent of this role, assigning work and answering the step's action. */
  leader: z.strictObject({ role: RoleSchema, instructions: TeamInstructionsSchema }),
  /** The roles the leader may assign work to. */
  roles: z.array(RoleSchema).min(1).max(TEAM_CEILINGS.participants),
  /** Outcomes a participant may report, if the team declares any. */
  outcomes: z.array(TeamOutcomeSchema).default([]),
  limits: LeaderTeamLimitsSchema.prefault({}),
});
export type LeaderTeam = z.infer<typeof LeaderTeamSchema>;

/** The shape alone, before the checks that read one field against another. */
const StepTeamShapeSchema = z.discriminatedUnion("coordination", [IndependentTeamSchema, LeaderTeamSchema]);

/** A step's team. Every check that needs no installation is part of parsing it (`teamConfigProblems`). */
export const StepTeamSchema = StepTeamShapeSchema.superRefine((team, context) => {
  for (const message of teamConfigProblems(team)) context.addIssue({ code: "custom", message });
});
export type StepTeam = z.infer<typeof StepTeamSchema>;

/** A stored team as the step carries it: null for none, and for one that no longer parses. */
export function storedTeam(value: unknown): StepTeam | null {
  return StepTeamSchema.safeParse(value).data ?? null;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const value of values) (seen.has(value) ? twice : seen).add(value);
  return [...twice];
}

/** Every role a team would dispatch, the leader's first. */
export function teamRoles(team: StepTeam): string[] {
  return team.coordination === "leader" ? [team.leader.role, ...team.roles] : team.participants.map((participant) => participant.role);
}

/**
 * What is wrong with a team on its own terms, as sentences: the checks that
 * read one of its fields against another and need nothing from the
 * installation. `validatePipeline` adds the ones that do — the step's kind,
 * staffing and the action's contract (`teamProblems` in the engine).
 */
export function teamConfigProblems(team: StepTeam): string[] {
  const problems: string[] = [];
  for (const key of duplicates(team.outcomes.map((outcome) => outcome.key))) problems.push(`The outcome "${key}" is declared twice.`);
  // The administrative role is never a participant: it is the only holder
  // of `eo_admin` (invariant 11), and a team member is report-only.
  if (teamRoles(team).includes(SYSTEM_ROLE)) problems.push(`The "${SYSTEM_ROLE}" role administers EO and cannot be a team participant.`);
  for (const outcome of team.outcomes) {
    if (outcome.rulesOut === undefined) continue;
    for (const key of duplicates(outcome.rulesOut)) problems.push(`The outcome "${outcome.key}" rules out "${key}" twice.`);
    // An independent team's result is EO's own, from its table: there is
    // no answer of anybody's to hold to what its reports rule out.
    if (team.coordination === "independent" && outcome.rulesOut.length > 0) {
      problems.push(`The outcome "${outcome.key}" rules out results, which only a leader-led team's answer is held to: an independent team's completion table decides its result.`);
    }
  }

  if (team.coordination === "leader") {
    for (const role of duplicates(team.roles)) problems.push(`The role "${role}" is permitted twice.`);
    if (team.limits.maxParallel > team.limits.maxParticipants) {
      problems.push(`The team may run ${team.limits.maxParallel} participants at once but only ${team.limits.maxParticipants} in all.`);
    }
    return problems;
  }

  for (const key of duplicates(team.participants.map((participant) => participant.key))) problems.push(`Two participants share the assignment key "${key}".`);
  if (!team.participants.some((participant) => participant.required)) problems.push("At least one participant must be required, or the team could decide on nothing.");
  if (team.participants.length > team.limits.maxParticipants) {
    problems.push(`The team has ${team.participants.length} participants but allows ${team.limits.maxParticipants}.`);
  }
  if (team.limits.maxParallel > team.limits.maxParticipants) {
    problems.push(`The team may run ${team.limits.maxParallel} participants at once but only ${team.limits.maxParticipants} in all.`);
  }
  const declared = new Set(team.outcomes.map((outcome) => outcome.key));
  team.completion.rules.forEach((rule, index) => {
    for (const outcome of rule.outcomes) {
      if (!declared.has(outcome)) problems.push(`Completion rule ${index + 1} names the outcome "${outcome}", which the team does not declare.`);
    }
  });
  return problems;
}

/** Every result key an independent team's table can produce, in the order it names them. */
export function teamResultKeys(team: IndependentTeam): string[] {
  return [...new Set([...team.completion.rules.map((rule) => rule.result), team.completion.fallback])];
}

/**
 * Why an independent team cannot answer this action, or null where it can.
 *
 * An independent team's answer is built, not written: `result` from the
 * completion table and `summary` from the reports. So the action's answer
 * must need nothing else. A role-defined action says so in its `fields`; a
 * pack's action keeps its schema in the pack, and EO will not guess at it —
 * answering one with a shape it did not ask for would redefine it. Refused,
 * not bypassed: a leader-led team, whose leader writes the answer, is how
 * such an action gets a team.
 */
export function deterministicAnswerProblem(stepName: string, action: string, facts: ActionFacts | undefined): string | null {
  const lead = `"${stepName}" decides its team's result without a leader, so its action "${action}" must take only a result and a summary`;
  if (facts === undefined) return `${lead}, and nothing defines that action.`;
  if (facts.packShipped) return `${lead}; "${action}" is a pack's action, whose answer the pack shapes. Use a leader-led team, whose leader answers it.`;
  const required = Array.isArray(facts.fields?.["required"]) ? (facts.fields["required"] as unknown[]) : [];
  const extra = required.filter((name): name is string => typeof name === "string" && !RESERVED_ANSWER_FIELDS.includes(name));
  if (extra.length > 0) return `${lead}, and it also requires ${extra.map((name) => `"${name}"`).join(", ")}. Use a leader-led team, whose leader answers it.`;
  return null;
}

/**
 * One participant's contribution as the decision reads it: what it
 * concluded, or that it could not contribute. Kept apart on purpose — a
 * run that crashed, timed out or never answered is not a participant who
 * found a problem, and nothing reads one as the other.
 */
export const TeamReportSchema = z.strictObject({
  /** The participant's assignment key. */
  key: TeamKeySchema,
  status: z.literal("completed"),
  /** One of the team's declared outcomes — what the participant concluded. */
  outcome: TeamKeySchema,
  /** The participant's attributed report, as it goes to the item's thread. */
  report: z.string().trim().min(1),
});
export type TeamReport = z.infer<typeof TeamReportSchema>;

/**
 * A participant that could not contribute: its run crashed, timed out, ran
 * out of budget or never answered. It carries no outcome — strictness
 * refuses one — so a failure can never be read as a conclusion.
 */
export const TeamExecutionFailureSchema = z.strictObject({
  key: TeamKeySchema,
  status: z.literal("failed"),
  /** What went wrong with the run, for the summary. Not a finding about the work. */
  error: z.string().trim().min(1),
});
export type TeamExecutionFailure = z.infer<typeof TeamExecutionFailureSchema>;

/** One settled contribution, as it crosses a boundary: a report or a failure, never both. */
export const TeamContributionSchema = z.discriminatedUnion("status", [TeamReportSchema, TeamExecutionFailureSchema]);
export type TeamContribution = z.infer<typeof TeamContributionSchema>;

/**
 * What a participant answers with (EO-846): the declared outcome it
 * concluded and its report. EO posts the report, attributed to the
 * participant, once it has checked the outcome against the team's; the
 * participant writes nothing itself.
 */
export const TeamParticipantAnswerSchema = z.strictObject({
  outcome: TeamKeySchema,
  report: z.string().trim().min(1).max(20_000),
});
export type TeamParticipantAnswer = z.infer<typeof TeamParticipantAnswerSchema>;

/**
 * The output schema a participant's turn is constrained to, both backends
 * alike: every property required and nothing else allowed, and the
 * outcome one of the keys the team declares.
 */
export function participantAnswerJsonSchema(team: { outcomes: readonly TeamOutcome[] }): Record<string, unknown> {
  // A leader's team may declare no outcomes (EO-847): then a report is all there is.
  if (team.outcomes.length === 0) {
    return {
      type: "object",
      properties: { report: { type: "string", description: "Your report: what you looked at, what you found and why." } },
      required: ["report"],
      additionalProperties: false,
    };
  }
  return {
    type: "object",
    properties: {
      outcome: { type: "string", enum: team.outcomes.map((outcome) => outcome.key), description: "The one declared outcome your report concludes." },
      report: { type: "string", description: "Your report: what you looked at, what you found and why it supports the outcome." },
    },
    required: ["outcome", "report"],
    additionalProperties: false,
  };
}

/** What an independent team's contributions come to. */
export type TeamDecision =
  /** A participant has not settled yet. */
  | { status: "pending"; waitingOn: string[] }
  /** A required participant could not contribute: no result, and never the fallback. */
  | { status: "failed"; failed: string[]; summary: string }
  /** The step's result, the rule that decided it (its index, or null for the fallback) and the assembled reports. */
  | { status: "decided"; result: string; rule: number | null; summary: string };

/**
 * Decide an independent team's result from its contributions (EO-843).
 *
 * Deterministic: the same settled contributions give the same decision in
 * whatever order they arrived, because nothing here reads their order —
 * the rules are read in the table's order and the summary in the
 * participants' order. Nothing is decided while any participant is still
 * unsettled. A required participant that failed fails the team, so a
 * missing or failed contribution can never reach the fallback.
 *
 * Throws on a contribution the team does not have, two for one key, or an
 * outcome the team does not declare: the participant's answer schema rules
 * those out, so meeting one is a programmer's error.
 */
export function decideIndependentTeam(team: IndependentTeam, contributions: readonly TeamContribution[]): TeamDecision {
  const byKey = new Map<string, TeamContribution>();
  const keys = new Set(team.participants.map((participant) => participant.key));
  const outcomes = new Set(team.outcomes.map((outcome) => outcome.key));
  for (const contribution of contributions) {
    if (!keys.has(contribution.key)) throw new Error(`No participant of this team has the key "${contribution.key}".`);
    if (byKey.has(contribution.key)) throw new Error(`Two contributions for "${contribution.key}".`);
    if (contribution.status === "completed" && !outcomes.has(contribution.outcome)) throw new Error(`"${contribution.outcome}" is not an outcome this team declares.`);
    byKey.set(contribution.key, contribution);
  }

  const waitingOn = team.participants.filter((participant) => !byKey.has(participant.key)).map((participant) => participant.key);
  if (waitingOn.length > 0) return { status: "pending", waitingOn };

  const failed = team.participants.filter((participant) => participant.required && byKey.get(participant.key)?.status === "failed").map((participant) => participant.key);
  if (failed.length > 0) return { status: "failed", failed, summary: teamSummary(team, byKey, null) };

  const concluded = [...byKey.values()].flatMap((contribution) => (contribution.status === "completed" ? [contribution.outcome] : []));
  const index = team.completion.rules.findIndex((rule) =>
    rule.when === "all" ? concluded.length > 0 && concluded.every((outcome) => rule.outcomes.includes(outcome)) : concluded.some((outcome) => rule.outcomes.includes(outcome)),
  );
  const result = index === -1 ? team.completion.fallback : team.completion.rules[index]!.result;
  return { status: "decided", result, rule: index === -1 ? null : index, summary: teamSummary(team, byKey, { result, rule: index === -1 ? null : index }) };
}

/** The reports, one per participant in the team's order, under what they came to. */
function teamSummary(team: IndependentTeam, byKey: ReadonlyMap<string, TeamContribution>, decided: { result: string; rule: number | null } | null): string {
  const labels = new Map(team.outcomes.map((outcome) => [outcome.key, outcome.label]));
  const head =
    decided === null
      ? "The team could not decide: a required participant did not contribute."
      : decided.rule === null
        ? `The team's result is "${decided.result}": no completion rule held, so the fallback applies.`
        : `The team's result is "${decided.result}", by completion rule ${decided.rule + 1}.`;
  const lines = team.participants.map((participant) => {
    const contribution = byKey.get(participant.key);
    const who = `**${participant.key}** (${participant.role}${participant.required ? "" : ", optional"})`;
    if (contribution === undefined) return `- ${who}: no contribution.`;
    if (contribution.status === "failed") return `- ${who}: could not contribute — ${contribution.error}`;
    return `- ${who}: ${labels.get(contribution.outcome) ?? contribution.outcome} — ${contribution.report}`;
  });
  return [head, "", ...lines].join("\n");
}

/** What an outcome rules out (EO-873), as a clause after it: empty where it rules out nothing. */
function rulesOutWords(outcome: TeamOutcome): string {
  return outcome.rulesOut === undefined || outcome.rulesOut.length === 0 ? "" : ` rules out ${outcome.rulesOut.join("/")}`;
}

/**
 * A team in words, for the version diff and anywhere a step's settings
 * are listed. Whole, instructions included, because the diff compares
 * what this says: two teams that read the same here are the same team.
 */
export function teamWords(team: StepTeam | null | undefined): string {
  if (team === null || team === undefined) return "one agent";
  const limits = [
    `${team.limits.maxParallel} at a time`,
    `${team.limits.maxParticipants} in all`,
    ...(team.coordination === "leader" ? [`${team.limits.maxRounds} rounds`] : []),
    `${team.limits.maxRetries} ${team.limits.maxRetries === 1 ? "retry" : "retries"}`,
    ...(team.limits.timeoutMs === undefined ? [] : [`within ${team.limits.timeoutMs} ms`]),
    ...(team.limits.budgetCents === undefined ? [] : [`within ${team.limits.budgetCents}¢`]),
  ].join(", ");
  // Labels and meanings too: a meaning is what a participant is told an
  // outcome is for, so changing one changes what the team does.
  const outcomes =
    team.outcomes.length === 0
      ? ""
      : `; outcomes ${team.outcomes.map((outcome) => `${outcome.key} "${outcome.label}"${outcome.meaning === "" ? "" : ` (${JSON.stringify(outcome.meaning)})`}${rulesOutWords(outcome)}`).join(", ")}`;
  // The member mode leads (EO-867), so a diff of a team whose members
  // went from report-only to isolated says so in its first words.
  const mode = `${memberModeWords(teamMemberMode(team))} members`;
  if (team.coordination === "leader") {
    return `${mode}; led by ${team.leader.role} ("${team.leader.instructions}"), assigning to ${team.roles.join(", ")}${outcomes}; ${limits}`;
  }
  const who = team.participants.map((participant) => `${participant.key} (${participant.role}${participant.required ? "" : ", optional"}): "${participant.instructions}"`).join("; ");
  const rules = team.completion.rules.map((rule) => `${rule.when} ${rule.outcomes.join("/")} → ${rule.result}`);
  return `${mode}; independent: ${who}${outcomes}; ${[...rules, `otherwise ${team.completion.fallback}`].join(", ")}; ${limits}`;
}

/**
 * What a draft says for a step's team when it means "one agent again"
 * (EO-848) — `team: null` on a saved step.
 *
 * A word rather than `null`, for the reason `RUNS_ONCE` and
 * `DEFAULT_TIME_LIMIT` are (invariant 12): Codex's strict output writes
 * every optional field, as `null` where it has nothing to say, so a null
 * meaning "remove the team" would remove it from every step a Codex draft
 * did not mention.
 */
export const NO_TEAM = "none";

/** A member mode as a person reads it: "report-only" or "isolated". */
export function memberModeWords(mode: TeamMemberMode): string {
  return mode === "isolated" ? "isolated" : "report-only";
}

/**
 * What a team may and may not do, in the words every surface showing a
 * team uses (EO-848): the step details, a draft's card and the pipeline
 * read and validation answers say it the same way.
 */
export const TEAM_REPORT_ONLY =
  "Report-only: every member, a leader included, reads the evidence and posts an attributed report on the thread. " +
  "None of them can edit the work, run commands, change anything outside EO or widen what it may use; EO alone decides where the item goes.";

/** The same for a team whose members are isolated (EO-867). */
export const TEAM_ISOLATED =
  "Isolated: every member, a leader included, works as its role's agent does on an ordinary dispatch of this step — the same tools, servers, skills, repository index and context — in a copy of the item's workspace made for it alone and removed when its turn ends. " +
  "Nothing it does there reaches the item's work, its branch or another member's copy, it sees none of its team's other reports, and it posts nothing itself: EO posts its report, and alone decides where the item goes.";

/** What a team's members may do, in the words for its mode. */
export function teamRightsWords(team: { members?: TeamMemberMode }): string {
  return teamMemberMode(team) === "isolated" ? TEAM_ISOLATED : TEAM_REPORT_ONLY;
}

/**
 * A team in a person's words (EO-848), section by section: how it is
 * coordinated, who is on it, what its members may conclude, how it
 * finishes, its limits, and that it only reports.
 *
 * Where `teamWords` is one line for a version diff to compare, this is
 * for reading: the step details, a draft card and the answers of the
 * pipeline read and validation tools. Labels beside keys wherever the
 * team declares one.
 */
export const TeamFactsSchema = z.object({
  /** How its members work (EO-867). */
  mode: z.enum(TEAM_MEMBER_MODES),
  coordination: z.string(),
  members: z.array(z.string()),
  outcomes: z.array(z.string()),
  completion: z.array(z.string()),
  limits: z.array(z.string()),
  /** What its members may and may not do, in its mode's words (`teamRightsWords`); named for the one mode there first was. */
  reportOnly: z.string(),
});
export type TeamFacts = z.infer<typeof TeamFactsSchema>;

function moneyWords(cents: number): string {
  if (cents < 100) return `${cents}¢`;
  const dollars = cents / 100;
  return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`;
}

function durationWords(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`;
  if (ms % 1000 === 0) return `${ms / 1000} second${ms === 1000 ? "" : "s"}`;
  return `${ms}ms`;
}

export function teamFacts(team: StepTeam): TeamFacts {
  const labels = new Map(team.outcomes.map((outcome) => [outcome.key, outcome.label]));
  const label = (key: string) => labels.get(key) ?? key;
  const outcomes = team.outcomes.map(
    (outcome) =>
      `${outcome.label} (${outcome.key})${outcome.meaning === "" ? "" : ` — ${outcome.meaning}`}${outcome.rulesOut === undefined || outcome.rulesOut.length === 0 ? "" : ` (rules out ${outcome.rulesOut.join(", ")})`}`,
  );
  const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const limits = [
    `${counted(team.limits.maxParallel, "participant", "participants")} at a time`,
    `${counted(team.limits.maxParticipants, "participant", "participants")} in all`,
    ...(team.coordination === "leader" ? [`${counted(team.limits.maxRounds, "round", "rounds")} of assignments`] : []),
    `${counted(team.limits.maxRetries, "retry", "retries")} for a participant whose run fails`,
    team.limits.timeoutMs === undefined ? "time: the run timeout" : `time: ${durationWords(team.limits.timeoutMs)} for the whole team`,
    team.limits.budgetCents === undefined
      ? "spending: the item's and the day's budgets"
      : `spending: ${moneyWords(team.limits.budgetCents)} for the whole team, within the item's and the day's budgets`,
  ];

  if (team.coordination === "leader") {
    return {
      coordination: `Leader-led — a ${team.leader.role} agent assigns focused work to ${team.roles.join(", ")}, reads their reports and answers the step; EO checks its answer before it is used.`,
      members: [`Leader: a ${team.leader.role} agent — ${team.leader.instructions}`, `May assign work to: ${team.roles.join(", ")}`],
      outcomes,
      completion: [
        "The leader answers the step's action itself, citing the reports it used.",
        "EO refuses an answer that misses a required assignment, cites a superseded report, does not fit the action or names a result the action does not declare.",
        ...(team.outcomes.some((outcome) => (outcome.rulesOut ?? []).length > 0)
          ? ["EO also refuses a result an accepted report's outcome rules out, unless the leader's disagreements overrule that report by name and say why."]
          : []),
      ],
      limits,
      mode: teamMemberMode(team),
      reportOnly: teamRightsWords(team),
    };
  }

  const either = (keys: readonly string[]) => keys.map(label).join(" or ");
  return {
    coordination: `Independent — ${counted(team.participants.length, "participant reports", "participants each report")} on their own, and EO decides the step's result from what they conclude. No agent coordinates them.`,
    members: team.participants.map((participant) => `${participant.key}: a ${participant.role} agent, ${participant.required ? "required" : "optional"} — ${participant.instructions}`),
    outcomes,
    completion: [
      ...team.completion.rules.map((rule) =>
        rule.when === "all" ? `If every report concludes ${either(rule.outcomes)} → ${rule.result}` : `If any report concludes ${either(rule.outcomes)} → ${rule.result}`,
      ),
      `Otherwise → ${team.completion.fallback}`,
      "A required participant that cannot contribute fails the team rather than reaching the fallback.",
    ],
    limits,
    mode: teamMemberMode(team),
    reportOnly: teamRightsWords(team),
  };
}

/** `teamFacts` as lines, each led by the section it is from, for a card or a tool's answer. */
export function teamFactLines(team: StepTeam): string[] {
  const facts = teamFacts(team);
  return [
    `Members: ${memberModeWords(facts.mode)}`,
    `Coordination: ${facts.coordination}`,
    ...facts.members.map((line) => `Member: ${line}`),
    ...(facts.outcomes.length === 0 ? [] : [`Outcomes a member may report: ${facts.outcomes.join("; ")}`]),
    ...facts.completion.map((line) => `Completion: ${line}`),
    `Limits: ${facts.limits.join(", ")}`,
    facts.reportOnly,
  ];
}

/**
 * One team step as the pipeline read and validation answers describe it
 * (EO-848), read as dispatch would act on it: who would be staffed for
 * each role, what the team is restricted to, which action its one answer
 * is held to and whether it can answer it, the results it can end on, and
 * every problem the validator has with it.
 */
export const TeamReadingSchema = z.object({
  stepId: z.string(),
  stepName: z.string(),
  coordination: z.enum(["independent", "leader"]),
  /** How its members work (EO-867). */
  members: z.enum(TEAM_MEMBER_MODES),
  /** Each role the team dispatches, with the agents dispatch would choose among, and why it cannot be staffed, or null. */
  staffing: z.array(
    z.object({
      role: z.string(),
      /** What the role is for on this team: `leader`, `assignments`, or the participant keys it staffs. */
      serves: z.string(),
      agents: z.array(z.string()),
      problem: z.string().nullable(),
    }),
  ),
  /** What its members may and may not do, in its mode's words (`teamRightsWords`). */
  reportOnly: z.string(),
  /** The action the team's single answer is held to, who writes that answer, and why the team cannot answer it, or null. */
  finalAction: z.object({
    role: z.string().nullable(),
    action: z.string().nullable(),
    answeredBy: z.enum(["eo", "leader"]),
    problem: z.string().nullable(),
  }),
  /** The result keys the team can end on: an independent team's table, or the action's declared results for a leader. */
  results: z.array(z.string()),
  facts: TeamFactsSchema,
  /** What `validatePipeline` says about this team, word for word. */
  problems: z.array(z.string()),
  /**
   * The declared team the step names (EO-881): its id, name, whether a
   * person locked it, its current version, and its definition as a draft's
   * `teams` entry writes it — agents by name — so a draft can restate or
   * change it. Null on a reading from before declared teams.
   */
  declared: z
    .object({ id: z.string(), name: z.string(), locked: z.boolean(), version: z.number().int(), draft: z.unknown() })
    .nullable()
    .default(null),
});
export type TeamReading = z.infer<typeof TeamReadingSchema>;
