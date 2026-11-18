import { describe, expect, it } from "vitest";
import { asClarification } from "./schemas/clarification.js";
import { jsonSchemaOutputSchema } from "./schemas/outputSchema.js";
import { leaderTurnSchema, participantTurnSchema, readLeaderAnswer, readParticipantAnswer } from "./teamTurns.js";

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
    expect(readLeaderAnswer({ outcome: { decision: "assign", assignments: [{ key: "auth", role: "sec", instructions: "Look.", required: true }], note: "" } })).toMatchObject({ kind: "assign" });
    expect(readLeaderAnswer({ outcome: { decision: "final", answer: { result: "ok" }, contributions: [], disagreements: "None.", limitations: "None." } })).toMatchObject({ kind: "final", final: { answer: { result: "ok" } } });
    expect(readLeaderAnswer({ outcome: { status: "clarification_required", questions: [{ id: "q", question: "May I?", why: "Blocks." }] } })).toMatchObject({ kind: "asked" });
  });

  it("refuses what is neither, saying where", () => {
    expect(readLeaderAnswer({ outcome: { decision: "assign", assignments: [], note: "" } })).toMatchObject({ kind: "invalid", error: expect.stringContaining("assignments") });
    expect(readLeaderAnswer({ outcome: { decision: "final", answer: {}, contributions: [], disagreements: "", limitations: "x" } })).toMatchObject({ kind: "invalid" });
    expect(readLeaderAnswer({ outcome: { decision: "assign", assignments: [{ key: "auth", role: "sec", instructions: "Look.", required: true, agentId: "x" }], note: "" } })).toMatchObject({ kind: "invalid" });
  });
});

describe("the turns' output schemas (EO-847)", () => {
  it("offers a participant its report or questions, both backends alike, under `outcome`", () => {
    const schema = participantTurnSchema(OUTCOMES) as { properties: { outcome: { anyOf: { required?: string[] }[] } }; required: string[] };
    expect(schema.required).toEqual(["outcome"]);
    expect(schema.properties.outcome.anyOf.map((branch) => branch.required)).toEqual([["status", "questions"], ["outcome", "report"]]);
    expect((participantTurnSchema([]) as { properties: { outcome: { anyOf: { required?: string[] }[] } } }).properties.outcome.anyOf[1]?.required).toEqual(["report"]);
  });

  it("offers a leader assignments to the permitted roles alone, or the step's own answer, placed so its references still resolve", () => {
    const answer = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { result: { enum: ["ok"] }, summary: { type: "string" } }, required: ["result", "summary"] };
    const schema = leaderTurnSchema({ roles: ["sec", "tester"] }, answer) as { properties: { outcome: { anyOf: Record<string, unknown>[] } } };
    const branches = schema.properties.outcome.anyOf[1] as { anyOf: { properties: Record<string, { items?: { properties: { role: { enum: string[] } } } } | Record<string, unknown>> }[] };
    const [assignBranch, finalBranch] = branches.anyOf;
    expect((assignBranch!.properties["assignments"] as { items: { properties: { role: { enum: string[] } } } }).items.properties.role.enum).toEqual(["sec", "tester"]);
    expect(finalBranch!.properties["answer"]).toEqual({ type: "object", properties: answer.properties, required: answer.required });

    const referring = { $schema: "https://json-schema.org/draft/2020-12/schema", $defs: { r: { enum: ["ok"] } }, type: "object", properties: { result: { $ref: "#/$defs/r" } } };
    const embedded = leaderTurnSchema({ roles: ["sec"] }, referring) as { $defs?: Record<string, { $defs?: Record<string, { $id?: string }> }> };
    // The leader's document carries the answer as a resource of its own, so `#/$defs/r` still means the answer's own definition.
    const leaderDoc = Object.values(embedded.$defs ?? {})[0];
    expect(leaderDoc?.$defs?.["answer"]?.$id).toBe("urn:eo:output-schema:answer");
  });

  it("compiles, and accepts each kind of answer a leader may give and nothing else", () => {
    const answer = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { result: { enum: ["ok"] }, summary: { type: "string" } }, required: ["result", "summary"], additionalProperties: false };
    const referring = { $schema: "https://json-schema.org/draft/2020-12/schema", $defs: { r: { enum: ["ok"] } }, type: "object", properties: { result: { $ref: "#/$defs/r" } }, required: ["result"] };
    for (const document of [answer, referring]) {
      const schema = jsonSchemaOutputSchema(leaderTurnSchema({ roles: ["sec"] }, document));
      const final = (inner: unknown) => ({ outcome: { decision: "final", answer: inner, contributions: [], disagreements: "None.", limitations: "None." } });
      expect(schema.parse(final({ result: "ok", summary: "Fine." })).ok).toBe(true);
      expect(schema.parse(final({ result: "nope", summary: "Fine." })).ok).toBe(false);
      expect(schema.parse({ outcome: { decision: "assign", assignments: [{ key: "a", role: "sec", instructions: "Look.", required: true }], note: "" } }).ok).toBe(true);
      expect(schema.parse({ outcome: { decision: "assign", assignments: [{ key: "a", role: "admin", instructions: "Look.", required: true }], note: "" } }).ok).toBe(false);
      expect(schema.parse({ outcome: { status: "clarification_required", questions: [{ id: "q", question: "Which?", why: "Blocks." }] } }).ok).toBe(true);
    }
  });

  it("is something the ordinary clarification reader still recognises", () => {
    expect(asClarification({ outcome: { status: "clarification_required", questions: [{ id: "q", question: "Which?", why: "Blocks." }] } })).not.toBeNull();
  });
});
