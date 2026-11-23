import { describe, expect, it } from "vitest";
import { developerRegistry, NewTeamMemberSchema, TeamDefinitionSchema, type ActionFacts, type RegistryFacts, type TeamDefinition } from "@eo/core";
import { checkMemberAdditions, declaredTeamProblems, validateTeam, type TeamAgentFacts } from "./declaredTeam.js";

const agents: TeamAgentFacts[] = [
  { id: "lead", name: "Lead reviewer", role: "reviewer" },
  { id: "sec", name: "Security reviewer", role: "reviewer" },
  { id: "tests", name: "Test reviewer", role: "tester" },
  { id: "sys", name: "Assistant", role: "system" },
];

function leader(overrides: Partial<Record<string, unknown>> = {}): TeamDefinition {
  return TeamDefinitionSchema.parse({
    name: "Review leads",
    coordination: "leader",
    leader: { agentId: "lead", instructions: "Split the review by risk." },
    members: [{ agentId: "sec" }, { agentId: "tests" }],
    toolPool: { cliTools: ["gh"], mcpServers: ["github"], skills: ["triage"] },
    ...overrides,
  });
}

function independent(): TeamDefinition {
  return TeamDefinitionSchema.parse({
    name: "Change review",
    coordination: "independent",
    members: [
      { key: "security", agentId: "sec", instructions: "Look for ways around authentication." },
      { key: "tests", agentId: "tests", instructions: "Check the tests.", required: false },
    ],
    outcomes: [
      { key: "clear", label: "Clear" },
      { key: "concerns", label: "Concerns" },
    ],
    completion: { rules: [{ when: "any", outcomes: ["concerns"], result: "changes_requested" }], fallback: "approved" },
  });
}

describe("validateTeam (EO-881)", () => {
  it("passes a team whose members' tools are all in its pool", () => {
    expect(validateTeam(leader(), { agents, surfaces: { sec: { cliTools: ["gh"], mcpServers: ["github"], skills: [] }, tests: { cliTools: [], mcpServers: [], skills: ["triage"] } } })).toEqual([]);
  });

  it("refuses the system agent as a leader or a member, in a sentence naming it", () => {
    expect(validateTeam(leader({ leader: { agentId: "sys", instructions: "Lead." } }), { agents })).toEqual([
      'Its leader "Assistant" is EO\'s system agent, which administers EO and can never lead a team.',
    ]);
    expect(validateTeam(leader({ members: [{ agentId: "sys" }] }), { agents })).toEqual(['"Assistant" is EO\'s system agent, which administers EO and can never be a team member.']);
  });

  it("refuses a member whose own tools go beyond the pool, naming each tool", () => {
    const problems = validateTeam(leader(), { agents, surfaces: { sec: { cliTools: ["kubectl"], mcpServers: ["github", "slack"], skills: ["deploy"] } } });
    expect(problems).toEqual(['The member "Security reviewer" may use the MCP server "slack", the skill "deploy", the CLI tool "kubectl", beyond the team\'s tool pool.']);
  });

  it("refuses eo_admin in the pool and a member count over the cap", () => {
    // Parsing already refuses both; validateTeam says the same of a definition built by hand.
    const raw = { ...leader(), toolPool: { cliTools: [], mcpServers: ["eo_admin"], skills: [] }, memberCap: 1 } as TeamDefinition;
    expect(validateTeam(raw, { agents })).toEqual(["The team has 2 members, over its cap of 1.", '"eo_admin" administers EO, and can never be in a team\'s tool pool.']);
    expect(TeamDefinitionSchema.safeParse(raw).success).toBe(false);
  });

  it("refuses an agent EO does not have", () => {
    expect(validateTeam(leader({ members: [{ agentId: "ghost" }] }), { agents })).toEqual(["A member is an agent EO does not have (ghost)."]);
  });
});

describe("declaredTeamProblems (EO-881)", () => {
  // The reviewer kind defines `check`; the tester kind has no such action.
  const check: ActionFacts = { description: "Checks the work.", results: [{ key: "approved", label: "Approved" }, { key: "changes_requested", label: "Changes requested" }], packShipped: false, fields: {} };
  const registry: RegistryFacts = { ...developerRegistry(), roleActions: new Map([["reviewer", new Map([["check", check]])]]) };
  const step = { id: "s1", name: "Review", type: "agent" as const, entryAction: "check", teamId: "t1" };
  const facts = (definition: TeamDefinition | null, projectId: string | null = "p1") => [{ id: "t1", name: "Review leads", projectId, definition }];

  it("names the step and the team for a team that does not exist, belongs to another project, or cannot be read", () => {
    expect(declaredTeamProblems([step], { projectId: "p1", registry, teams: [], agents })).toEqual([{ stepId: "s1", message: '"Review" runs as a team that does not exist (t1).' }]);
    expect(declaredTeamProblems([step], { projectId: "p1", registry, teams: facts(leader(), "p2"), agents })[0]?.message).toBe(
      '"Review" runs as the team "Review leads", which belongs to another project: a step may run only as a team of its own pipeline\'s project.',
    );
    expect(declaredTeamProblems([step], { projectId: "p1", registry, teams: facts(null), agents })[0]?.message).toBe('"Review" runs as the team "Review leads", which EO cannot read.');
  });

  it("refuses a leader whose kind lacks the step's action, naming the step, the team and the leader", () => {
    const tester = leader({ leader: { agentId: "tests", instructions: "Lead." }, members: [{ agentId: "sec" }] });
    expect(declaredTeamProblems([step], { projectId: "p1", registry, teams: facts(tester), agents })).toEqual([
      { stepId: "s1", message: '"Review" runs as the team "Review leads", whose leader "Test reviewer" is a tester agent, and that kind has no "check" action to answer.' },
    ]);
  });

  it("passes a leader whose kind has the action, and an independent team, and says validateTeam's problems on the step", () => {
    expect(declaredTeamProblems([step], { projectId: "p1", registry, teams: facts(leader()), agents })).toEqual([]);
    expect(declaredTeamProblems([step], { projectId: "p1", registry, teams: facts(independent()), agents })).toEqual([]);
    expect(declaredTeamProblems([step], { projectId: "p1", registry, teams: facts(leader({ members: [{ agentId: "sys" }] })), agents })).toEqual([
      { stepId: "s1", message: '"Review" runs as the team "Review leads": "Assistant" is EO\'s system agent, which administers EO and can never be a team member.' },
    ]);
  });

  it("refuses a team on a step no agent does", () => {
    expect(declaredTeamProblems([{ ...step, type: "user" as const }], { projectId: "p1", registry, teams: facts(leader()), agents })[0]?.message).toBe(
      '"Review" runs as the team "Review leads", but only a step an agent does can run as a team.',
    );
  });

  it("judges each agent it names as itself: one retired or disabled, and on a report-only team one EO cannot hold to report-only, never stood in for by another of its kind (EO-882)", () => {
    const retired = agents.map((agent) => (agent.id === "sec" ? { ...agent, archivedAt: 1 } : agent.id === "lead" ? { ...agent, enabled: false } : agent));
    expect(declaredTeamProblems([step], { projectId: "p1", registry, teams: facts(leader()), agents: retired }).map((problem) => problem.message)).toEqual([
      '"Review" runs as the team "Review leads": Its leader "Lead reviewer" is disabled, so it cannot run.',
      '"Review" runs as the team "Review leads": Its member "Security reviewer" has been retired, so it cannot run.',
    ]);
    // "Lead reviewer" is a reviewer as "Security reviewer" is: the one that cannot be held is named, and only it.
    const reportOnly = { tests: "its backend cannot be locked down." };
    expect(declaredTeamProblems([step], { projectId: "p1", registry, teams: facts(leader()), agents, reportOnly }).map((problem) => problem.message)).toEqual([
      '"Review" runs as the team "Review leads": Its member "Test reviewer" cannot be held to report-only: its backend cannot be locked down.',
    ]);
    // An isolated team's members run as themselves on an ordinary dispatch: report-only is not asked of them.
    expect(declaredTeamProblems([step], { projectId: "p1", registry, teams: facts(leader({ memberMode: "isolated" })), agents, reportOnly })).toEqual([]);
    // A team judged on its own, as a draft's team is, is not held to whether its agents run now.
    expect(validateTeam(leader(), { agents: retired })).toEqual([]);
  });
});

describe("checkMemberAdditions (EO-883)", () => {
  const ranged = (overrides: Partial<Record<string, unknown>> = {}) =>
    leader({ modelRange: { runtimes: ["claude", "codex"], models: ["gpt-5"], reasoning: ["high"] }, memberCap: 3, ...overrides });
  const ask = (overrides: Record<string, unknown> = {}) =>
    NewTeamMemberSchema.parse({ name: "Nell", kind: "tester", instructions: "Read CSV.", tools: { cliTools: ["gh"], mcpServers: ["github"], skills: ["triage"] }, runtime: "codex", model: "gpt-5", reasoning: "high", ...overrides });
  const context = { locked: false, memberKinds: ["reviewer", "tester"], nameTaken: (name: string) => name.toLowerCase() === "lead reviewer" };

  it("accepts an addition wholly within the pool, the range and the cap", () => {
    const checked = checkMemberAdditions(ranged(), context, [ask()]);
    expect(checked.refused).toEqual([]);
    expect(checked.accepted).toMatchObject([{ name: "Nell", kind: "tester", runtime: "codex" }]);
  });

  it("takes the one kind the members share where the leader names none, and refuses to guess between several", () => {
    const unkinded = { ...ask(), kind: undefined };
    expect(checkMemberAdditions(ranged(), { ...context, memberKinds: ["reviewer"] }, [unkinded]).accepted[0]?.kind).toBe("reviewer");
    expect(checkMemberAdditions(ranged(), context, [unkinded]).refused[0]?.reason).toContain("its kind is left out");
  });

  const refusals: [string, Parameters<typeof checkMemberAdditions>, string][] = [
    ["a CLI tool outside the pool", [ranged(), context, [ask({ tools: { cliTools: ["kubectl"] } })]], 'the CLI tool "kubectl" is not in the team\'s tool pool'],
    ["an MCP server outside the pool", [ranged(), context, [ask({ tools: { mcpServers: ["billing"] } })]], 'the MCP server "billing" is not in the team\'s tool pool'],
    ["a skill outside the pool", [ranged(), context, [ask({ tools: { skills: ["deploy"] } })]], 'the skill "deploy" is not in the team\'s tool pool'],
    ["eo_admin", [ranged(), context, [ask({ tools: { mcpServers: ["eo_admin"] } })]], 'the MCP server "eo_admin" is not in the team\'s tool pool'],
    ["a runtime outside the range", [ranged(), context, [ask({ runtime: "gemini" })]], 'its runtime "gemini" is not in the team\'s model range ("claude", "codex")'],
    ["a model outside the range", [ranged(), context, [ask({ model: "gpt-4o" })]], 'its model "gpt-4o" is not in the team\'s model range ("gpt-5")'],
    ["a reasoning level outside the range", [ranged(), context, [ask({ reasoning: "low" })]], 'its reasoning "low" is not in the team\'s model range ("high")'],
    ["anything, where the range is empty", [leader(), context, [ask()]], "it allows no runtimes"],
    ["a name another agent has", [ranged(), context, [ask({ name: "Lead Reviewer" })]], 'another agent is already called "Lead Reviewer"'],
    ["one name twice", [ranged(), context, [ask(), ask()]], "the same name is asked for twice"],
    ["a kind none of the members is", [ranged(), context, [ask({ kind: "deployer" })]], 'its kind "deployer" is none of the team\'s members\' kinds'],
    ["the system kind", [ranged(), context, [ask({ kind: "system" })]], "EO's system agent can never be a team member"],
    ["a member over the cap", [ranged({ memberCap: 2 }), context, [ask()]], "the team has 2 members, and its cap is 2"],
    ["a locked team", [ranged(), { ...context, locked: true }, [ask()]], 'the team "Review leads" is locked'],
    ["an independent team", [independent(), context, [ask()]], "is not led by a leader"],
  ];
  for (const [name, args, why] of refusals) {
    it(`refuses ${name}, saying why`, () => {
      const checked = checkMemberAdditions(...args);
      expect(checked.accepted.length).toBeLessThan(args[2].length);
      const reason = checked.refused.map((one) => one.reason).join(" ");
      expect(reason).toContain("EO did not add it, and created nothing");
      expect(reason).toContain(why);
      expect(checked.refused[0]?.key).toBe(`new member "${args[2][0]!.name}"`);
    });
  }

  it("counts what it accepts in one answer against the cap", () => {
    const checked = checkMemberAdditions(ranged(), context, [ask(), ask({ name: "Oz" })]);
    expect(checked.accepted.map((one) => one.name)).toEqual(["Nell"]);
    expect(checked.refused).toEqual([{ key: 'new member "Oz"', reason: "EO did not add it, and created nothing: the team has 3 members, and its cap is 3." }]);
  });
});
