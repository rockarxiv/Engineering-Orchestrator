import { describe, expect, it } from "vitest";
import {
  decideIndependentTeam,
  deterministicAnswerProblem,
  participantAnswerJsonSchema,
  StepTeamSchema,
  storedTeam,
  TeamContributionSchema,
  TeamExecutionFailureSchema,
  TeamParticipantAnswerSchema,
  TeamReportSchema,
  teamFactLines,
  teamFacts,
  teamMemberMode,
  teamWords,
  TEAM_ISOLATED,
  TEAM_REPORT_ONLY,
  type IndependentTeam,
  type TeamContribution,
} from "./team.js";

/**
 * The team contract (EO-843, ARCHITECTURE.md, "A team on an agent step"):
 * what a team may say, and what its contributions come to.
 */

const base = {
  coordination: "independent",
  participants: [
    { key: "security", role: "reviewer", instructions: "Look for auth gaps." },
    { key: "performance", role: "reviewer", instructions: "Look for slow queries." },
    { key: "docs", role: "writer", instructions: "Check the docs.", required: false },
  ],
  outcomes: [
    { key: "clear", label: "Clear" },
    { key: "concerns", label: "Concerns" },
    { key: "blocker", label: "Blocker" },
  ],
  completion: {
    rules: [
      { when: "any", outcomes: ["blocker"], result: "rejected" },
      { when: "all", outcomes: ["clear"], result: "approved" },
    ],
    fallback: "changes_requested",
  },
};

const team = StepTeamSchema.parse(base) as IndependentTeam;
const issues = (value: unknown) => StepTeamSchema.safeParse(value).error?.issues.map((issue) => issue.message) ?? [];

describe("StepTeamSchema", () => {
  it("fills in conservative limits a team leaves out", () => {
    expect(team.limits).toEqual({ maxParticipants: 4, maxParallel: 2, maxRetries: 1 });
    const led = StepTeamSchema.parse({ coordination: "leader", leader: { role: "lead", instructions: "Lead." }, roles: ["reviewer"] });
    expect(led.limits).toEqual({ maxParticipants: 4, maxParallel: 2, maxRetries: 1, maxRounds: 2 });
    expect(led.outcomes).toEqual([]);
  });

  it("refuses two participants with one assignment key, and an outcome declared twice", () => {
    expect(issues({ ...base, participants: [base.participants[0], base.participants[0]] })).toContain('Two participants share the assignment key "security".');
    expect(issues({ ...base, outcomes: [...base.outcomes, { key: "clear", label: "Again" }] })).toContain('The outcome "clear" is declared twice.');
  });

  it("lets an outcome of a leader-led team rule out results, and refuses it twice over or on an independent team (EO-873)", () => {
    const led = { coordination: "leader", leader: { role: "lead", instructions: "Lead." }, roles: ["reviewer"] };
    const ruling = StepTeamSchema.parse({ ...led, outcomes: [{ key: "blocking", label: "Blocking", rulesOut: ["approved"] }] });
    expect(ruling.outcomes[0]).toEqual({ key: "blocking", label: "Blocking", meaning: "", rulesOut: ["approved"] });
    // Left out, it is absent rather than filled in, so a team written before it reads exactly as it did.
    expect(StepTeamSchema.parse({ ...led, outcomes: [{ key: "clear", label: "Clear" }] }).outcomes[0]).not.toHaveProperty("rulesOut");
    expect(issues({ ...led, outcomes: [{ key: "blocking", label: "Blocking", rulesOut: ["approved", "approved"] }] })).toEqual(['The outcome "blocking" rules out "approved" twice.']);
    expect(issues({ ...led, outcomes: [{ key: "blocking", label: "Blocking", rulesOut: ["Approved!"] }] })).not.toEqual([]);
    expect(issues({ ...base, outcomes: [...base.outcomes.slice(0, 2), { key: "blocker", label: "Blocker", rulesOut: ["approved"] }] })).toEqual([
      'The outcome "blocker" rules out results, which only a leader-led team\'s answer is held to: an independent team\'s completion table decides its result.',
    ]);
    // In the diff's words and the reader's.
    expect(teamWords(ruling)).toContain('blocking "Blocking" rules out approved');
    expect(teamFacts(ruling).outcomes).toEqual(["Blocking (blocking) (rules out approved)"]);
    expect(teamFacts(ruling).completion).toContainEqual(expect.stringContaining("EO also refuses a result an accepted report's outcome rules out"));
  });

  it("refuses a completion rule naming an outcome the team does not declare", () => {
    const rules = [{ when: "any", outcomes: ["meh"], result: "approved" }];
    expect(issues({ ...base, completion: { rules, fallback: "approved" } })).toEqual(['Completion rule 1 names the outcome "meh", which the team does not declare.']);
  });

  it("refuses limits outside the ceilings, ones that contradict each other, and rounds on an independent team", () => {
    expect(issues({ ...base, limits: { maxParallel: 5 } })).not.toEqual([]);
    expect(issues({ ...base, limits: { maxParticipants: 0 } })).not.toEqual([]);
    expect(issues({ ...base, limits: { maxRetries: -1 } })).not.toEqual([]);
    expect(issues({ ...base, limits: { maxRetries: 1.5 } })).not.toEqual([]);
    expect(issues({ ...base, limits: { timeoutMs: 0 } })).not.toEqual([]);
    expect(issues({ ...base, limits: { budgetCents: -5 } })).not.toEqual([]);
    expect(issues({ ...base, limits: { maxRounds: 2 } })).not.toEqual([]);
    expect(issues({ ...base, limits: { maxParticipants: 2 } })).toContain("The team has 3 participants but allows 2.");
    expect(issues({ ...base, limits: { maxParticipants: 3, maxParallel: 4 } })).toContain("The team may run 4 participants at once but only 3 in all.");
    const led = { coordination: "leader", leader: { role: "lead", instructions: "Lead." }, roles: ["reviewer"] };
    expect(issues({ ...led, limits: { maxRounds: 6 } })).not.toEqual([]);
    expect(issues({ ...led, limits: { maxParticipants: 1, maxParallel: 2 } })).toContain("The team may run 2 participants at once but only 1 in all.");
  });

  it("refuses a team with no required participant, and a key that is not a key", () => {
    const optional = base.participants.map((participant) => ({ ...participant, required: false }));
    expect(issues({ ...base, participants: optional })).toContain("At least one participant must be required, or the team could decide on nothing.");
    expect(issues({ ...base, participants: [{ ...base.participants[0], key: "Security Review" }] })).not.toEqual([]);
  });

  it("never lets the administrative role take part, as participant, leader or permitted role", () => {
    const administers = 'The "system" role administers EO and cannot be a team participant.';
    expect(issues({ ...base, participants: [{ ...base.participants[0], role: "system" }] })).toContain(administers);
    expect(issues({ coordination: "leader", leader: { role: "system", instructions: "Lead." }, roles: ["reviewer"] })).toContain(administers);
    expect(issues({ coordination: "leader", leader: { role: "lead", instructions: "Lead." }, roles: ["system"] })).toContain(administers);
  });

  it("refuses any key that would name an agent or widen what a participant is dispatched with", () => {
    for (const key of ["agentId", "allowedTools", "mcpServers", "skills", "grants"]) {
      expect(StepTeamSchema.safeParse({ ...base, participants: [{ ...base.participants[0], [key]: ["x"] }] }).success, key).toBe(false);
      expect(StepTeamSchema.safeParse({ coordination: "leader", leader: { role: "lead", instructions: "Lead.", [key]: ["x"] }, roles: ["reviewer"] }).success, key).toBe(false);
      expect(StepTeamSchema.safeParse({ ...base, [key]: ["x"] }).success, key).toBe(false);
    }
  });

  it("refuses a duplicated permitted role and a kind of coordination it does not know", () => {
    expect(issues({ coordination: "leader", leader: { role: "lead", instructions: "Lead." }, roles: ["reviewer", "reviewer"] })).toContain('The role "reviewer" is permitted twice.');
    expect(StepTeamSchema.safeParse({ ...base, coordination: "swarm" }).success).toBe(false);
  });

  it("reads a stored team that no longer parses as one agent", () => {
    expect(storedTeam(null)).toBeNull();
    expect(storedTeam({ coordination: "swarm" })).toBeNull();
    expect(storedTeam(base)).toEqual(team);
  });
});

const done = (key: string, outcome: string): TeamContribution => ({ key, status: "completed", outcome, report: `${key} says ${outcome}.` });
const failed = (key: string): TeamContribution => ({ key, status: "failed", error: "The run timed out." });

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) => permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [value, ...rest]));
}

describe("TeamContributionSchema", () => {
  it("reads a report and a failure, and decides on what it parsed", () => {
    const report = TeamContributionSchema.parse({ key: "security", status: "completed", outcome: "clear", report: "No gaps." });
    const failure = TeamContributionSchema.parse({ key: "docs", status: "failed", error: "The run timed out." });
    expect(TeamReportSchema.parse(report)).toEqual(report);
    expect(TeamExecutionFailureSchema.parse(failure)).toEqual(failure);
    expect(decideIndependentTeam(team, [report, done("performance", "clear"), failure])).toMatchObject({ status: "decided", result: "approved" });
  });

  it("refuses a malformed report", () => {
    const report = { key: "security", status: "completed", outcome: "clear", report: "No gaps." };
    for (const malformed of [
      { ...report, report: "  " },
      { ...report, report: undefined },
      { ...report, outcome: undefined },
      { ...report, outcome: "Not A Key" },
      { ...report, key: "" },
      { ...report, status: "done" },
      { ...report, agentId: "a1" },
    ]) {
      expect(TeamContributionSchema.safeParse(malformed).success).toBe(false);
    }
  });

  it("keeps a failure to contribute apart from a conclusion: neither carries the other's field", () => {
    expect(TeamContributionSchema.safeParse({ key: "security", status: "failed", error: "Crashed.", outcome: "blocker" }).success).toBe(false);
    expect(TeamContributionSchema.safeParse({ key: "security", status: "completed", outcome: "clear", report: "Fine.", error: "Crashed." }).success).toBe(false);
    expect(TeamContributionSchema.safeParse({ key: "security", status: "failed" }).success).toBe(false);
    expect(TeamExecutionFailureSchema.safeParse({ key: "security", status: "completed", outcome: "clear", report: "Fine." }).success).toBe(false);
  });
});

describe("decideIndependentTeam", () => {
  it("decides by the first rule that holds, and the same way whatever order the contributions arrived in", () => {
    const cases: [TeamContribution[], string, number | null][] = [
      [[done("security", "clear"), done("performance", "clear"), done("docs", "clear")], "approved", 1],
      [[done("security", "clear"), done("performance", "blocker"), done("docs", "clear")], "rejected", 0],
      [[done("security", "concerns"), done("performance", "clear"), done("docs", "clear")], "changes_requested", null],
      // An optional participant that failed is left out of the decision.
      [[done("security", "clear"), done("performance", "clear"), failed("docs")], "approved", 1],
    ];
    for (const [contributions, result, rule] of cases) {
      const decisions = permutations(contributions).map((order) => decideIndependentTeam(team, order));
      expect(decisions[0]).toMatchObject({ status: "decided", result, rule });
      for (const decision of decisions) expect(decision).toEqual(decisions[0]);
    }
  });

  it("decides nothing while a participant has not settled", () => {
    expect(decideIndependentTeam(team, [done("security", "clear"), done("performance", "clear")])).toEqual({ status: "pending", waitingOn: ["docs"] });
    expect(decideIndependentTeam(team, [])).toEqual({ status: "pending", waitingOn: ["security", "performance", "docs"] });
  });

  it("never reaches the fallback when a required participant failed, however the others concluded", () => {
    for (const order of permutations([failed("security"), done("performance", "concerns"), done("docs", "concerns")])) {
      const decision = decideIndependentTeam(team, order);
      expect(decision.status).toBe("failed");
      expect(decision).toMatchObject({ failed: ["security"] });
      expect(decision).not.toHaveProperty("result");
    }
  });

  it("keeps a failure to contribute apart from what a participant concluded", () => {
    const decision = decideIndependentTeam(team, [failed("security"), done("performance", "blocker"), done("docs", "clear")]);
    if (decision.status !== "failed") throw new Error(decision.status);
    expect(decision.summary).toContain("**security** (reviewer): could not contribute — The run timed out.");
    expect(decision.summary).toContain("**performance** (reviewer): Blocker — performance says blocker.");
  });

  it("assembles the reports in the team's order, under what they came to", () => {
    const decision = decideIndependentTeam(team, [done("docs", "clear"), done("performance", "clear"), done("security", "clear")]);
    if (decision.status !== "decided") throw new Error(decision.status);
    expect(decision.summary).toBe(
      [
        'The team\'s result is "approved", by completion rule 2.',
        "",
        "- **security** (reviewer): Clear — security says clear.",
        "- **performance** (reviewer): Clear — performance says clear.",
        "- **docs** (writer, optional): Clear — docs says clear.",
      ].join("\n"),
    );
  });

  it("throws on a contribution the team cannot have produced", () => {
    expect(() => decideIndependentTeam(team, [done("stranger", "clear")])).toThrow(/No participant/);
    expect(() => decideIndependentTeam(team, [done("security", "clear"), done("security", "concerns")])).toThrow(/Two contributions/);
    expect(() => decideIndependentTeam(team, [done("security", "meh")])).toThrow(/not an outcome/);
  });
});

describe("a participant's answer (EO-846)", () => {
  it("is an outcome and a report and nothing else", () => {
    expect(TeamParticipantAnswerSchema.safeParse({ outcome: "clear", report: "Read it all." }).success).toBe(true);
    expect(TeamParticipantAnswerSchema.safeParse({ outcome: "clear", report: "  " }).success).toBe(false);
    expect(TeamParticipantAnswerSchema.safeParse({ outcome: "clear", report: "Fine.", result: "approved" }).success).toBe(false);
  });

  it("is constrained to the team's declared outcomes, every property required and no other allowed", () => {
    const schema = participantAnswerJsonSchema({ outcomes: [{ key: "clear", label: "Clear", meaning: "" }, { key: "blocking", label: "Blocking", meaning: "" }] });
    expect(schema).toMatchObject({ required: ["outcome", "report"], additionalProperties: false, properties: { outcome: { enum: ["clear", "blocking"] } } });
  });
});

describe("deterministicAnswerProblem", () => {
  const results = [{ key: "approved", label: "Approved" }];
  it("accepts an action answering with a result and a summary alone", () => {
    expect(deterministicAnswerProblem("Review", "check", { description: "", results, packShipped: false, fields: {} })).toBeNull();
    expect(deterministicAnswerProblem("Review", "check", { description: "", results, packShipped: false, fields: { properties: { notes: { type: "string" } } } })).toBeNull();
  });

  it("refuses one it would have to invent fields for, a pack's action and an undefined one, saying why", () => {
    expect(deterministicAnswerProblem("Review", "audit", { description: "", results, packShipped: false, fields: { required: ["findings", "summary"] } })).toMatch(/also requires "findings"\./);
    expect(deterministicAnswerProblem("Review", "review", { description: "", results, packShipped: true })).toMatch(/is a pack's action/);
    expect(deterministicAnswerProblem("Review", "nothing", undefined)).toMatch(/nothing defines that action/);
  });
});

describe("teamWords", () => {
  it("says one agent for no team, and tells two teams apart by anything that changes what they do", () => {
    expect(teamWords(null)).toBe("one agent");
    const other = StepTeamSchema.parse({ ...base, participants: [{ ...base.participants[0], instructions: "Look harder." }, ...base.participants.slice(1)] });
    expect(teamWords(other)).not.toBe(teamWords(team));
    expect(teamWords(team)).toContain("any blocker → rejected, all clear → approved, otherwise changes_requested");
  });

  it("tells two teams apart by an outcome's label or meaning alone", () => {
    const withOutcome = (outcome: object) => StepTeamSchema.parse({ ...base, outcomes: [outcome, ...base.outcomes.slice(1)] });
    const meant = withOutcome({ key: "clear", label: "Clear", meaning: "Nothing needs changing." });
    expect(teamWords(withOutcome({ key: "clear", label: "All clear" }))).not.toBe(teamWords(team));
    expect(teamWords(meant)).not.toBe(teamWords(team));
    expect(teamWords(withOutcome({ key: "clear", label: "Clear", meaning: "Nothing at all needs changing." }))).not.toBe(teamWords(meant));
  });
});

describe("a team's member mode (EO-867)", () => {
  it("is report-only unless a team says isolated, and a stored team from before modes reads as report-only", () => {
    expect(team.members).toBe("report_only");
    expect(teamMemberMode(StepTeamSchema.parse({ ...base, members: "isolated" }))).toBe("isolated");
    expect(teamMemberMode({})).toBe("report_only");
    expect(issues({ ...base, members: "writing" })).not.toEqual([]);
  });

  it("is named in the version diff's words, so a mode change reads as one, and said by the facts every surface shows", () => {
    const isolated = StepTeamSchema.parse({ ...base, members: "isolated" });
    expect(teamWords(team).startsWith("report-only members; independent:")).toBe(true);
    expect(teamWords(isolated).startsWith("isolated members; independent:")).toBe(true);
    expect(teamWords(isolated).slice("isolated".length)).toBe(teamWords(team).slice("report-only".length));
    expect(teamFacts(team)).toMatchObject({ mode: "report_only", reportOnly: TEAM_REPORT_ONLY });
    expect(teamFacts(isolated)).toMatchObject({ mode: "isolated", reportOnly: TEAM_ISOLATED });
    expect(teamFactLines(isolated)[0]).toBe("Members: isolated");
    expect(teamFactLines(isolated)).toContain(TEAM_ISOLATED);
  });
});
