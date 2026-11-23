import { z } from "zod";
import type { JsonSchema } from "./agent-provider.js";
import { asClarification, parseIfFenced, unwrapOutcome, type ClarificationRequired } from "./schemas/clarification.js";
import { placeSubschema, providerSchemaFor } from "./schemas/index.js";
import { dialectOf, type JsonSchemaDocument } from "./schemas/outputSchema.js";
import { ACTION_KEY_PATTERN } from "./schemas/actionDefinition.js";
import { participantAnswerJsonSchema, TEAM_CEILINGS, type TeamOutcome } from "./team.js";

/**
 * What a team's turns answer with (EO-846, EO-847, ARCHITECTURE.md, "A team
 * on an agent step"): a participant's report or its questions, and a
 * leader's request for work, its final answer or its questions.
 *
 * Every turn ends. A leader that wants work done says so in its answer and
 * its turn is over: EO keeps what it asked for, runs the assignments, and
 * starts the leader's next turn with the reports once they are in. Nothing
 * waits inside a provider process for anybody — not for a participant, and
 * not for a person (invariant 9). Asking a person is an answer too, in
 * either mode, and the shape is the one every agent already asks with
 * (`ClarificationRequiredSchema`), offered beside the turn's own answer
 * under `outcome` as `providerSchemaFor` offers it.
 *
 * Nothing here grants anything. A leader's request names members of its
 * team, by name, and instructions (EO-882); it cannot name an agent
 * outside the team or a grant. A member it adds (EO-883) is given only
 * tools from the team's pool, on a runtime, model and reasoning from its
 * range, which EO checks before it creates anything. A contributor's
 * answer cannot assign work at all — an answer that tries is refused,
 * with the reason recorded, not followed.
 */

/** The assignment key a leader's own turns are recorded under. Reserved: no assignment may use it. */
export const LEADER_ASSIGNMENT_KEY = "leader";

const KeySchema = z.string().regex(ACTION_KEY_PATTERN, "Use lowercase letters, digits and underscores.");

/** One piece of work a leader asks for: a key of its choosing, a member of its team by name, and what to look at. */
export const LeaderAssignmentSchema = z.strictObject({
  /** Stable for the assignment: a later round naming the same key is a follow-up that supersedes what it said. */
  key: KeySchema,
  /** The name of the team member who does it (EO-882). EO refuses a name that is not a member's. */
  member: z.string().trim().min(1),
  instructions: z.string().trim().min(1).max(4000),
  /** Whether the leader may not answer without it. EO holds the final answer to every required assignment's report. */
  required: z.boolean(),
});
export type LeaderAssignment = z.infer<typeof LeaderAssignmentSchema>;

/** The longest name a leader may give a member it adds. */
export const NEW_MEMBER_NAME_MAX = 80;

/**
 * A member a leader adds to its team (EO-883), when none of its members
 * fits: EO creates it as a real agent of the team's member kind and adds
 * it to the team for good. Its tools are picked from the team's tool pool
 * and its runtime, model and reasoning from the team's model range; EO
 * refuses anything else, so a leader only ever picks from what a person
 * declared (invariant 11).
 */
export const NewTeamMemberSchema = z.strictObject({
  /** The agent's name, which no other agent may have; an assignment in the same answer may name it. */
  name: z.string().trim().min(1).max(NEW_MEMBER_NAME_MAX),
  /** The kind it is: one of the team's members' kinds. Left out, the one kind they share. */
  kind: z.string().trim().min(1).optional(),
  instructions: z.string().trim().min(1).max(20_000),
  tools: z
    .strictObject({
      cliTools: z.array(z.string().trim().min(1)).default([]),
      mcpServers: z.array(z.string().trim().min(1)).default([]),
      skills: z.array(z.string().trim().min(1)).default([]),
    })
    .prefault({}),
  runtime: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoning: z.string().trim().min(1),
});
export type NewTeamMember = z.infer<typeof NewTeamMemberSchema>;

/** A leader asking for a round of work: new assignments, follow-ups on earlier ones, or both. */
export const LeaderAssignRequestSchema = z.strictObject({
  decision: z.literal("assign"),
  /** Members to add to the team before the assignments are read (EO-883): an assignment may name one. */
  newMembers: z.array(NewTeamMemberSchema).max(TEAM_CEILINGS.participants).default([]),
  assignments: z.array(LeaderAssignmentSchema).min(1).max(TEAM_CEILINGS.participants),
  /** Why, and any feedback on what came back: recorded on the item's thread with the assignments. */
  note: z.string().max(4000),
});
export type LeaderAssignRequest = z.infer<typeof LeaderAssignRequestSchema>;

/** A leader's final answer: the step's action answered, and what it rests on. */
export const LeaderFinalSchema = z.strictObject({
  decision: z.literal("final"),
  /** The step's action's own answer, held to that action's schema by EO, not by this. */
  answer: z.unknown(),
  /** The report comments it relied on, by id. Each must be an accepted report that nothing superseded. */
  contributions: z.array(z.string().trim().min(1)).max(64),
  /** Where the contributions disagreed and how the answer settled it; "none" when they did not. */
  disagreements: z.string().trim().min(1).max(4000),
  /** What the answer could not establish, or rests on weakly. */
  limitations: z.string().trim().min(1).max(4000),
});
export type LeaderFinal = z.infer<typeof LeaderFinalSchema>;

export const LeaderAnswerSchema = z.discriminatedUnion("decision", [LeaderAssignRequestSchema, LeaderFinalSchema]);
export type LeaderAnswer = z.infer<typeof LeaderAnswerSchema>;

/** Keys a contributor's answer would carry only if it were trying to hand work on. */
const DELEGATING_KEYS = ["assignments", "assign", "decision", "delegate", "delegation", "subagents"];

function objectOf(raw: unknown): Record<string, unknown> | null {
  const value = unwrapOutcome(parseIfFenced(raw));
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A participant's answer, read: a report, a question for the person, or why it is neither. */
export type ParticipantTurnAnswer =
  | { kind: "report"; outcome: string | null; report: string }
  | { kind: "asked"; asked: ClarificationRequired }
  | { kind: "invalid"; error: string; delegation: boolean };

/**
 * Reads a participant's answer against the outcomes its team declares
 * (none, for a leader's team that declares none). A contributor that tries
 * to assign work on is refused as such: it may only report or ask.
 */
export function readParticipantAnswer(outcomes: readonly TeamOutcome[], raw: unknown): ParticipantTurnAnswer {
  const asked = asClarification(raw);
  if (asked !== null) return { kind: "asked", asked };
  const value = objectOf(raw);
  if (value === null) return { kind: "invalid", error: "Its answer was not a report EO could take: not an object.", delegation: false };
  const delegating = DELEGATING_KEYS.filter((key) => key in value);
  if (delegating.length > 0) {
    return {
      kind: "invalid",
      error: `A contributor cannot hand work on: its answer carried ${delegating.map((key) => `"${key}"`).join(", ")}, and only the team's leader assigns work, so EO did not act on it.`,
      delegation: true,
    };
  }
  const shape =
    outcomes.length === 0
      ? z.strictObject({ report: z.string().trim().min(1).max(20_000) })
      : z.strictObject({ outcome: z.enum(outcomes.map((outcome) => outcome.key) as [string, ...string[]]), report: z.string().trim().min(1).max(20_000) });
  const parsed = shape.safeParse(value);
  if (!parsed.success) return { kind: "invalid", error: `Its answer was not a report EO could take: ${parsed.error.issues[0]?.message ?? "wrong shape"}.`, delegation: false };
  const data = parsed.data as { outcome?: string; report: string };
  return { kind: "report", outcome: data.outcome ?? null, report: data.report };
}

/** A leader's answer, read: work it asks for, its final answer, a question for the person, or why it is none of them. */
export type LeaderTurnAnswer =
  | { kind: "assign"; request: LeaderAssignRequest }
  | { kind: "final"; final: LeaderFinal }
  | { kind: "asked"; asked: ClarificationRequired }
  | { kind: "invalid"; error: string };

export function readLeaderAnswer(raw: unknown): LeaderTurnAnswer {
  const asked = asClarification(raw);
  if (asked !== null) return { kind: "asked", asked };
  const value = objectOf(raw);
  if (value === null) return { kind: "invalid", error: "The leader's answer was not an object." };
  const parsed = LeaderAnswerSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { kind: "invalid", error: `The leader's answer was not one EO could take: ${issue?.path.join(".") || "answer"}: ${issue?.message ?? "wrong shape"}.` };
  }
  return parsed.data.decision === "assign" ? { kind: "assign", request: parsed.data } : { kind: "final", final: parsed.data };
}

/**
 * The output schema a participant's turn is constrained to, both backends
 * alike: its report, or questions for the person, under `outcome`.
 */
export function participantTurnSchema(outcomes: readonly TeamOutcome[]): JsonSchema {
  return providerSchemaFor({ toJsonSchema: () => participantAnswerJsonSchema({ outcomes }) as JsonSchema });
}

/**
 * One member of a leader's team as the leader is told of it (EO-882):
 * the agent's name, which an assignment names it by; its kind; the
 * runtime, model and reasoning it runs on; and a short line from its own
 * instructions.
 */
export interface TeamMemberFacts {
  name: string;
  kind: string;
  runtime: string;
  model: string | null;
  reasoning: string | null;
  /** A short line from its instructions; empty where it has none. */
  summary: string;
}

/** The longest a member's line from its instructions runs to. */
const MEMBER_SUMMARY_MAX = 160;

/** A short line from an agent's instructions: its first line with words in it, markdown heading marks taken off, bounded. */
export function instructionsSummary(instructions: string): string {
  const line = instructions
    .split(/\r?\n/)
    .map((one) => one.replace(/^\s*#+\s*/, "").trim())
    .find((one) => one !== "");
  if (line === undefined) return "";
  return line.length <= MEMBER_SUMMARY_MAX ? line : `${line.slice(0, MEMBER_SUMMARY_MAX - 1).trimEnd()}…`;
}

/** One member in a line: "Name — a kind agent on runtime, model m, reasoning r: what it does". */
export function teamMemberLine(member: TeamMemberFacts): string {
  const on = [member.runtime, ...(member.model === null ? [] : [`model ${member.model}`]), ...(member.reasoning === null ? [] : [`reasoning ${member.reasoning}`])].join(", ");
  return `${member.name} — a ${member.kind} agent on ${on}${member.summary === "" ? "" : `: ${member.summary}`}`;
}

/**
 * What a leader may add a member from (EO-883), as its turn is offered
 * it: the kinds a new member may be, the team's tool pool, its model
 * range, and how many more members its cap leaves room for. Offered only
 * where an addition could be accepted at all.
 */
export interface MemberAdditionOffer {
  kinds: readonly string[];
  pool: { cliTools: readonly string[]; mcpServers: readonly string[]; skills: readonly string[] };
  range: { runtimes: readonly string[]; models: readonly string[]; reasoning: readonly string[] };
  room: number;
}

/** A list of names to pick from, or none at all where there are none (an empty `enum` some backends refuse). */
function pickFrom(names: readonly string[], description: string): Record<string, unknown> {
  return names.length === 0
    ? { type: "array", maxItems: 0, items: { type: "string" }, description: `${description} The team's pool has none.` }
    : { type: "array", items: { type: "string", enum: [...names] }, description };
}

function newMembersProperty(offer: MemberAdditionOffer): Record<string, unknown> {
  const one = (names: readonly string[], description: string) => ({ type: "string", enum: [...names], description });
  return {
    type: "array",
    maxItems: offer.room,
    description: `Members to add to your team for good, only when none of your members fits the work: EO creates each as a real agent and announces it on the item. Leave this empty otherwise. At most ${offer.room} more.`,
    items: {
      type: "object",
      properties: {
        name: { type: "string", description: "Its name, which no other agent may have. Assignments in this answer may name it." },
        kind: one(offer.kinds, "The kind of agent it is."),
        instructions: { type: "string", description: "Its standing instructions: what it is for and how it works." },
        tools: {
          type: "object",
          properties: {
            cliTools: pickFrom(offer.pool.cliTools, "The command-line tools it is given, from the team's pool."),
            mcpServers: pickFrom(offer.pool.mcpServers, "The MCP servers it is given, from the team's pool."),
            skills: pickFrom(offer.pool.skills, "The skills it is given, from the team's pool."),
          },
          required: ["cliTools", "mcpServers", "skills"],
          additionalProperties: false,
        },
        runtime: one(offer.range.runtimes, "The runtime it runs on."),
        model: one(offer.range.models, "The model it runs."),
        reasoning: one(offer.range.reasoning, "Its reasoning effort."),
      },
      required: ["name", "kind", "instructions", "tools", "runtime", "model", "reasoning"],
      additionalProperties: false,
    },
  };
}

/**
 * The output schema a leader's turn is constrained to: a round of work
 * for its team's members, by name (EO-882), a final answer carrying the
 * step's action's own answer (`answerDocument`, placed so its references
 * keep their meaning), or questions for the person. Where the team lets
 * its leader add a member (`addition`, EO-883), a round may add members
 * too, and an assignment may name one of them — so the names are then
 * described rather than listed as the only ones.
 */
export function leaderTurnSchema(members: readonly TeamMemberFacts[], answerDocument: JsonSchemaDocument, addition: MemberAdditionOffer | null = null): JsonSchema {
  const defs: Record<string, unknown> = {};
  const answer = placeSubschema(answerDocument, "answer", defs);
  const text = (description: string) => ({ type: "string", description });
  // With nobody left to assign to there is no round to ask for, and an
  // empty `enum` is a schema some backends refuse outright.
  const assign = {
    type: "object",
    description: "Ask for a round of work. Your turn ends here; EO runs the assignments and starts your next turn with their reports.",
    properties: {
      decision: { type: "string", const: "assign" },
      ...(addition === null ? {} : { newMembers: newMembersProperty(addition) }),
      assignments: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            key: text("A short key for this assignment (lowercase letters, digits, underscores). Use an earlier key again to ask that assignment to follow up."),
            member: {
              type: "string",
              ...(addition === null ? { enum: members.map((member) => member.name) } : {}),
              description: [
                addition === null ? "Which member of your team does it, by name:" : "Which member of your team does it, by name — one below, or one this answer adds:",
                ...members.map((member) => `- ${teamMemberLine(member)}`),
              ].join("\n"),
            },
            instructions: text("What to look at and report on."),
            required: { type: "boolean", description: "Whether you cannot answer without its report." },
          },
          required: ["key", "member", "instructions", "required"],
          additionalProperties: false,
        },
      },
      note: text("Why you ask for this, and any feedback on what came back."),
    },
    required: ["decision", ...(addition === null ? [] : ["newMembers"]), "assignments", "note"],
    additionalProperties: false,
  };
  const document: JsonSchema = {
    $schema: dialectOf(answerDocument),
    anyOf: [
      ...(members.length === 0 && addition === null ? [] : [assign]),
      {
        type: "object",
        description: "Answer the step. EO checks every required report is in and that this answer is valid before it is used.",
        properties: {
          decision: { type: "string", const: "final" },
          answer,
          contributions: { type: "array", items: { type: "string" }, description: "The ids of the report comments this answer relies on." },
          disagreements: text("Where the reports disagreed and how you settled it, or that they did not."),
          limitations: text("What this answer could not establish."),
        },
        required: ["decision", "answer", "contributions", "disagreements", "limitations"],
        additionalProperties: false,
      },
    ],
    ...(Object.keys(defs).length > 0 ? { $defs: defs } : {}),
  };
  return providerSchemaFor({ toJsonSchema: () => document });
}
