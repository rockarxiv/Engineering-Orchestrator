import { describe, expect, it } from "vitest";
import { asClarification } from "./schemas/clarification.js";
import { jsonSchemaOutputSchema } from "./schemas/outputSchema.js";
import { instructionsSummary, leaderTurnSchema, participantTurnSchema, readLeaderAnswer, readParticipantAnswer, type TeamMemberFacts } from "./teamTurns.js";

/** What a team's turns answer with (EO-847). */

const OUTCOMES = [
  { key: "clear", label: "Clear", meaning: "" },
  { key: "blocking", label: "Blocking", meaning: "" },
];

describe("readParticipantAnswer (EO-847)", () => {
  it("takes a report under the wrapper or bare, with a declared outcome or, where none are declared, none", () => {
    expect(readParticipantAnswer(OUTCOMES, { outcome: { outcome: "clear", report: "Fine." } })).toEqual({ kind: "report", outcome: "clear", report: "Fine." });
    expect(readParticipantAnswer(OUTCOMES, { outcome: "blocking", report: "Leaks." })).toEqual({ kind: "report", outcome: "blocking", report: "Leaks." });
    expect(readParticipantAnswer([], { outcome: { report: "Read it." } })).toEqual({ kind: "report", outcome: null, report: "Read it." });
    expect(readParticipantAnswer(OUTCOMES, { outcome: "approved", report: "Fine." })).toMatchObject({ kind: "invalid", delegation: false });
    expect(readParticipantAnswer([], { outcome: "clear", report: "Fine." })).toMatchObject({ kind: "invalid" });
  });

  it("reads a question as a question, never as a report", () => {
    const asked = readParticipantAnswer(OUTCOMES, { outcome: { status: "clarification_required", questions: [{ id: "q", question: "Which one?", why: "It decides." }] } });
    expect(asked).toMatchObject({ kind: "asked", asked: { questions: [{ question: "Which one?" }] } });
  });

  it("refuses a contributor's attempt to hand work on, as delegation", () => {
    expect(readParticipantAnswer([], { outcome: { assignments: [{ key: "x" }], report: "Do it for me." } })).toMatchObject({ kind: "invalid", delegation: true, error: expect.stringContaining("only the team's leader assigns work") });
    expect(readParticipantAnswer(OUTCOMES, { decision: "assign", assignments: [] })).toMatchObject({ delegation: true });
  });
});

describe("readLeaderAnswer (EO-847)", () => {
  it("reads a request for work, a final answer and a question", () => {
    expect(readLeaderAnswer({ outcome: { decision: "assign", assignments: [{ key: "auth", member: "Sasha", instructions: "Look.", required: true }], note: "" } })).toMatchObject({ kind: "assign" });
    expect(readLeaderAnswer({ outcome: { decision: "final", answer: { result: "ok" }, contributions: [], disagreements: "None.", limitations: "None." } })).toMatchObject({ kind: "final", final: { answer: { result: "ok" } } });
    expect(readLeaderAnswer({ outcome: { status: "clarification_required", questions: [{ id: "q", question: "May I?", why: "Blocks." }] } })).toMatchObject({ kind: "asked" });
  });

  it("refuses what is neither, saying where", () => {
    expect(readLeaderAnswer({ outcome: { decision: "assign", assignments: [], note: "" } })).toMatchObject({ kind: "invalid", error: expect.stringContaining("assignments") });
    expect(readLeaderAnswer({ outcome: { decision: "final", answer: {}, contributions: [], disagreements: "", limitations: "x" } })).toMatchObject({ kind: "invalid" });
    expect(readLeaderAnswer({ outcome: { decision: "assign", assignments: [{ key: "auth", member: "Sasha", instructions: "Look.", required: true, agentId: "x" }], note: "" } })).toMatchObject({ kind: "invalid" });
  });
});

const SASHA: TeamMemberFacts = { name: "Sasha", kind: "sec", runtime: "claude", model: "claude-opus-4-5", reasoning: "high", summary: "You find ways in." };
const TESS: TeamMemberFacts = { name: "Tess", kind: "tester", runtime: "codex", model: "gpt-5", reasoning: null, summary: "You read tests." };

describe("instructionsSummary (EO-882)", () => {
  it("is the first line with words in it, heading marks taken off, bounded", () => {
    expect(instructionsSummary("\n\n# Security reviewer\n\nYou find ways in.")).toBe("Security reviewer");
    expect(instructionsSummary("   ")).toBe("");
    const long = instructionsSummary("x".repeat(400));
    expect(long).toHaveLength(160);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("the turns' output schemas (EO-847)", () => {
  it("offers a participant its report or questions, both backends alike, under `outcome`", () => {
    const schema = participantTurnSchema(OUTCOMES) as { properties: { outcome: { anyOf: { required?: string[] }[] } }; required: string[] };
    expect(schema.required).toEqual(["outcome"]);
    expect(schema.properties.outcome.anyOf.map((branch) => branch.required)).toEqual([["status", "questions"], ["outcome", "report"]]);
    expect((participantTurnSchema([]) as { properties: { outcome: { anyOf: { required?: string[] }[] } } }).properties.outcome.anyOf[1]?.required).toEqual(["report"]);
  });

  it("offers a leader assignments to its team's members alone, by name, each described, or the step's own answer, placed so its references still resolve (EO-882)", () => {
    const answer = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { result: { enum: ["ok"] }, summary: { type: "string" } }, required: ["result", "summary"] };
    const schema = leaderTurnSchema([SASHA, TESS], answer) as { properties: { outcome: { anyOf: Record<string, unknown>[] } } };
    const branches = schema.properties.outcome.anyOf[1] as { anyOf: { properties: Record<string, { items?: { properties: { member: { enum: string[] } } } } | Record<string, unknown>> }[] };
    const [assignBranch, finalBranch] = branches.anyOf;
    const member = (assignBranch!.properties["assignments"] as { items: { properties: { member: { enum: string[]; description: string } }; required: string[] } }).items;
    expect(member.properties.member.enum).toEqual(["Sasha", "Tess"]);
    expect(member.required).toEqual(["key", "member", "instructions", "required"]);
    expect(member.properties.member.description).toBe(
      "Which member of your team does it, by name:\n- Sasha — a sec agent on claude, model claude-opus-4-5, reasoning high: You find ways in.\n- Tess — a tester agent on codex, model gpt-5: You read tests.",
    );
    expect(finalBranch!.properties["answer"]).toEqual({ type: "object", properties: answer.properties, required: answer.required });

    const referring = { $schema: "https://json-schema.org/draft/2020-12/schema", $defs: { r: { enum: ["ok"] } }, type: "object", properties: { result: { $ref: "#/$defs/r" } } };
    const embedded = leaderTurnSchema([SASHA], referring) as { $defs?: Record<string, { $defs?: Record<string, { $id?: string }> }> };
    // The leader's document carries the answer as a resource of its own, so `#/$defs/r` still means the answer's own definition.
    const leaderDoc = Object.values(embedded.$defs ?? {})[0];
    expect(leaderDoc?.$defs?.["answer"]?.$id).toBe("urn:eo:output-schema:answer");
  });

  it("offers a leader with no member left nothing to assign, rather than an empty list of names", () => {
    const answer = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { result: { enum: ["ok"] } }, required: ["result"] };
    expect(JSON.stringify(leaderTurnSchema([], answer))).not.toContain('"enum":[]');
    const schema = jsonSchemaOutputSchema(leaderTurnSchema([], answer));
    expect(schema.parse({ outcome: { decision: "final", answer: { result: "ok" }, contributions: [], disagreements: "None.", limitations: "None." } }).ok).toBe(true);
    expect(schema.parse({ outcome: { decision: "assign", assignments: [{ key: "a", member: "Sasha", instructions: "Look.", required: true }], note: "" } }).ok).toBe(false);
  });

  it("compiles, and accepts each kind of answer a leader may give and nothing else", () => {
    const answer = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { result: { enum: ["ok"] }, summary: { type: "string" } }, required: ["result", "summary"], additionalProperties: false };
    const referring = { $schema: "https://json-schema.org/draft/2020-12/schema", $defs: { r: { enum: ["ok"] } }, type: "object", properties: { result: { $ref: "#/$defs/r" } }, required: ["result"] };
    for (const document of [answer, referring]) {
      const schema = jsonSchemaOutputSchema(leaderTurnSchema([SASHA], document));
      const final = (inner: unknown) => ({ outcome: { decision: "final", answer: inner, contributions: [], disagreements: "None.", limitations: "None." } });
      expect(schema.parse(final({ result: "ok", summary: "Fine." })).ok).toBe(true);
      expect(schema.parse(final({ result: "nope", summary: "Fine." })).ok).toBe(false);
      expect(schema.parse({ outcome: { decision: "assign", assignments: [{ key: "a", member: "Sasha", instructions: "Look.", required: true }], note: "" } }).ok).toBe(true);
      expect(schema.parse({ outcome: { decision: "assign", assignments: [{ key: "a", member: "Ada", instructions: "Look.", required: true }], note: "" } }).ok).toBe(false);
      expect(schema.parse({ outcome: { status: "clarification_required", questions: [{ id: "q", question: "Which?", why: "Blocks." }] } }).ok).toBe(true);
    }
  });

  it("offers a leader whose team takes additions new members from its pool and range alone, and lets an assignment name one (EO-883)", () => {
    const answer = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { result: { enum: ["ok"] } }, required: ["result"] };
    const offer = { kinds: ["sec"], pool: { cliTools: ["gh"], mcpServers: [], skills: ["triage"] }, range: { runtimes: ["claude", "codex"], models: ["gpt-5"], reasoning: ["high"] }, room: 2 };
    const schema = jsonSchemaOutputSchema(leaderTurnSchema([SASHA], answer, offer));
    const nell = { name: "Nell", kind: "sec", instructions: "Read CSV.", tools: { cliTools: ["gh"], mcpServers: [], skills: [] }, runtime: "codex", model: "gpt-5", reasoning: "high" };
    const assign = (newMembers: unknown[], member = "Nell") => ({ outcome: { decision: "assign", newMembers, assignments: [{ key: "a", member, instructions: "Look.", required: true }], note: "" } });
    expect(schema.parse(assign([nell])).ok).toBe(true);
    expect(schema.parse(assign([], "Sasha")).ok).toBe(true);
    expect(schema.parse(assign([{ ...nell, tools: { ...nell.tools, cliTools: ["kubectl"] } }])).ok).toBe(false);
    expect(schema.parse(assign([{ ...nell, tools: { ...nell.tools, mcpServers: ["eo_admin"] } }])).ok).toBe(false);
    expect(schema.parse(assign([{ ...nell, model: "gpt-4o" }])).ok).toBe(false);
    expect(schema.parse(assign([nell, { ...nell, name: "Oz" }, { ...nell, name: "Pip" }])).ok).toBe(false);
    // An empty pool list is no empty `enum`.
    expect(JSON.stringify(leaderTurnSchema([SASHA], answer, offer))).not.toContain('"enum":[]');
    // Read back, an answer that adds nobody adds nobody, whatever the schema offered.
    const read = readLeaderAnswer({ outcome: { decision: "assign", assignments: [{ key: "a", member: "Sasha", instructions: "Look.", required: true }], note: "" } });
    expect(read.kind === "assign" && read.request.newMembers).toEqual([]);
    const added = readLeaderAnswer(assign([nell]));
    expect(added.kind === "assign" && added.request.newMembers[0]?.name).toBe("Nell");
  });

  it("is something the ordinary clarification reader still recognises", () => {
    expect(asClarification({ outcome: { status: "clarification_required", questions: [{ id: "q", question: "Which?", why: "Blocks." }] } })).not.toBeNull();
  });
});
