import { describe, expect, it } from "vitest";
import { DEFAULT_TEAM_MEMBER_CAP, TEAM_NAME_MAX, TeamDefinitionSchema, generatedTeamName, stepTeamOf, teamAgentIds } from "./declaredTeam.js";

/** A declared team's shape (EO-881): what parsing refuses, and how it runs as a role-staffed team until EO-882. */
describe("a declared team's definition (EO-881)", () => {
  const leader = {
    name: "Review leads",
    coordination: "leader",
    leader: { agentId: "lead", instructions: "Split the review by risk." },
    members: [{ agentId: "sec" }, { agentId: "tests" }],
  };

  it("fills in member mode, pool, range, cap and limits a team leaves out", () => {
    const team = TeamDefinitionSchema.parse(leader);
    expect(team.memberMode).toBe("report_only");
    expect(team.toolPool).toEqual({ cliTools: [], mcpServers: [], skills: [] });
    expect(team.modelRange).toEqual({ runtimes: [], models: [], reasoning: [] });
    expect(team.memberCap).toBe(DEFAULT_TEAM_MEMBER_CAP);
    expect(teamAgentIds(team)).toEqual(["lead", "sec", "tests"]);
  });

  it("refuses eo_admin in the pool, more members than the cap, a member twice, and a role or a tool grant smuggled in", () => {
    const problems = (value: unknown) => TeamDefinitionSchema.safeParse(value).error?.issues.map((issue) => issue.message) ?? [];
    expect(problems({ ...leader, toolPool: { mcpServers: ["eo_admin"] } })).toContain('"eo_admin" administers EO, and can never be in a team\'s tool pool.');
    expect(problems({ ...leader, memberCap: 1 })).toContain("The team has 2 members, over its cap of 1.");
    expect(problems({ ...leader, members: [{ agentId: "sec" }, { agentId: "sec" }] })).toContain('The agent "sec" is a member twice.');
    expect(TeamDefinitionSchema.safeParse({ ...leader, members: [{ agentId: "sec", allowedTools: ["Bash"] }] }).success).toBe(false);
    expect(TeamDefinitionSchema.safeParse({ ...leader, leader: { role: "reviewer", instructions: "Lead." } }).success).toBe(false);
  });

  it("runs as the role-staffed team a step always ran: each member as its agent's kind", () => {
    const kinds = new Map([
      ["lead", "reviewer"],
      ["sec", "reviewer"],
      ["tests", "tester"],
    ]);
    expect(stepTeamOf(TeamDefinitionSchema.parse({ ...leader, memberMode: "isolated" }), (id) => kinds.get(id))).toMatchObject({
      coordination: "leader",
      members: "isolated",
      leader: { role: "reviewer", instructions: "Split the review by risk." },
      roles: ["reviewer", "tester"],
    });
    const independent = TeamDefinitionSchema.parse({
      name: "Change review",
      coordination: "independent",
      members: [{ key: "security", agentId: "sec", instructions: "Look for auth gaps.", required: false }, { key: "tests", agentId: "tests", instructions: "Check the tests." }],
      outcomes: [{ key: "clear", label: "Clear" }],
      completion: { rules: [], fallback: "approved" },
    });
    expect(stepTeamOf(independent, (id) => kinds.get(id))?.coordination === "independent" && stepTeamOf(independent, (id) => kinds.get(id))).toMatchObject({
      participants: [
        { key: "security", role: "reviewer", required: false },
        { key: "tests", role: "tester", required: true },
      ],
    });
    // An agent EO does not know reads as no team at all, never a partial one.
    expect(stepTeamOf(independent, (id) => (id === "sec" ? "reviewer" : undefined))).toBeNull();
  });
});

describe("a name EO gives a team it declares (EO-881)", () => {
  it("keeps a short name whole and numbers it", () => {
    expect(generatedTeamName("Delivery · Review")).toBe("Delivery · Review");
    expect(generatedTeamName("Delivery · Review", 3)).toBe("Delivery · Review (3)");
  });

  it("cuts a long one so that, numbered, it is still a name the schema takes", () => {
    for (const base of ["x".repeat(400), "😀".repeat(400), `${"é".repeat(60)} · ${"Review".repeat(10)}`]) {
      for (const n of [1, 2, 1_000_000]) {
        const name = generatedTeamName(base, n);
        expect(name.length).toBeLessThanOrEqual(TEAM_NAME_MAX);
        // Never half a surrogate pair.
        expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      }
    }
    expect(generatedTeamName("x".repeat(400))).toBe(`${"x".repeat(54)}…`);
  });
});
