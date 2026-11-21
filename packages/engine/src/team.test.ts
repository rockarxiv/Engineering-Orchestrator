import type { ActionFacts, PipelineStep, RegistryFacts, StepRoute, StepTeam, Uuid } from "@eo/core";
import { developerRegistry, StepTeamSchema } from "@eo/core";
import { describe, expect, it } from "vitest";
import { validatePipeline, type ValidatePipelineInput } from "./pipelineValidation.js";

/**
 * A team on an agent step, judged with the graph (EO-843, ARCHITECTURE.md,
 * "A team on an agent step"): its kind of step, its staffing, the action
 * it answers and its limits.
 */

function step(id: string, position: number, overrides: Partial<PipelineStep> = {}): PipelineStep {
  return {
    id,
    pipelineId: "p1" as Uuid,
    position,
    name: id,
    type: "agent",
    ownerRole: "reviewer",
    entryAction: "check",
    instructionsSummary: null,
    isTerminal: false,
    planMode: false,
    workspaceMode: "isolated",
    workspaceId: null,
    offBoard: false,
    inputs: {},
    timeoutMs: null,
    watch: null,
    ownerPersonId: null,
    ownerGroupId: null,
    moduleVersion: null,
    brief: null,
    team: null,
    results: [],
    ...overrides,
  };
}

function route(fromStepId: string, resultKey: string, target: string, position = 0): StepRoute {
  return { id: `${fromStepId}:${resultKey}` as Uuid, pipelineId: "p1" as Uuid, fromStepId, resultKey, label: resultKey, tone: "info", target, position };
}

const check: ActionFacts = {
  description: "Checks the work.",
  results: [
    { key: "approved", label: "Approved" },
    { key: "changes_requested", label: "Changes requested" },
  ],
  packShipped: false,
  fields: {},
};
const detailed: ActionFacts = { ...check, fields: { properties: { findings: { type: "array" } }, required: ["findings"] } };

/** The shipped registry, with the reviewer defining `check` (result and summary alone) and `audit` (which also requires findings). */
const registry: RegistryFacts = {
  ...developerRegistry(),
  roleActions: new Map([
    [
      "reviewer",
      new Map([
        ["check", check],
        ["audit", detailed],
      ]),
    ],
  ]),
};

const independent = (overrides: Record<string, unknown> = {}): StepTeam =>
  StepTeamSchema.parse({
    coordination: "independent",
    participants: [
      { key: "security", role: "reviewer", instructions: "Look for auth gaps." },
      { key: "tests", role: "tester", instructions: "Check the tests.", required: false },
    ],
    outcomes: [
      { key: "clear", label: "Clear" },
      { key: "concerns", label: "Concerns" },
    ],
    completion: { rules: [{ when: "any", outcomes: ["concerns"], result: "changes_requested" }], fallback: "approved" },
    ...overrides,
  });

const leader = (overrides: Record<string, unknown> = {}): StepTeam =>
  StepTeamSchema.parse({ coordination: "leader", leader: { role: "reviewer", instructions: "Split the review." }, roles: ["tester"], ...overrides });

function pipeline(team: StepTeam | null, overrides: Partial<PipelineStep> = {}, input: Partial<ValidatePipelineInput> = {}): ValidatePipelineInput {
  return {
    steps: [step("review", 0, { team, ...overrides }), step("done", 1, { type: "user", ownerRole: null, entryAction: null, isTerminal: true })],
    routes: [route("review", "approved", "done"), route("review", "changes_requested", "done", 1)],
    entryStepId: "review",
    staffedRoles: ["reviewer", "tester"],
    itemCountByStep: {},
    existingSteps: [],
    registry,
    ...input,
  };
}

const teamErrors = (input: ValidatePipelineInput) =>
  validatePipeline(input)
    .filter((problem) => problem.severity === "error")
    .map((problem) => problem.message);

describe("validatePipeline: a team on an agent step (EO-843)", () => {
  it("leaves a step without a team exactly as it judged it before", () => {
    expect(validatePipeline(pipeline(null))).toEqual([]);
  });

  it("accepts an independent team answering an action of result and summary alone, with nothing to warn about now that it runs (EO-846)", () => {
    expect(validatePipeline(pipeline(independent()))).toEqual([]);
  });

  it("accepts a leader-led team on any defined action, a pack's included, with nothing to warn about now that it runs (EO-847)", () => {
    expect(validatePipeline(pipeline(leader()))).toEqual([]);
    expect(teamErrors(pipeline(leader()))).toEqual([]);
    expect(teamErrors(pipeline(leader(), { entryAction: "audit" }))).toEqual([]);
  });

  it("refuses a team on a step that is not an agent's", () => {
    const input = pipeline(null);
    input.steps = [input.steps[0]!, step("done", 1, { type: "user", ownerRole: null, entryAction: null, isTerminal: true, team: independent() })];
    expect(teamErrors(input)).toEqual([expect.stringContaining('"done" has a team, but only a step an agent does')]);
    const builtin = pipeline(independent(), { type: "builtin", ownerRole: null, entryAction: "open_pr" });
    expect(teamErrors(builtin)).toContainEqual(expect.stringContaining('"review" has a team, but only a step an agent does'));
  });

  it("refuses a role this project does not staff, for a participant, a leader or a permitted role", () => {
    expect(teamErrors(pipeline(independent(), {}, { staffedRoles: ["reviewer"] }))).toEqual([expect.stringContaining('needs a "tester" agent')]);
    expect(teamErrors(pipeline(leader(), {}, { staffedRoles: ["tester"] }))).toContainEqual(expect.stringContaining('needs a "reviewer" agent'));
    expect(teamErrors(pipeline(leader({ roles: ["security"] })))).toEqual([expect.stringContaining('needs a "security" agent')]);
  });

  it("refuses a result the action cannot return", () => {
    const team = independent({ completion: { rules: [{ when: "all", outcomes: ["clear"], result: "merged" }], fallback: "rejected" } });
    expect(teamErrors(pipeline(team))).toEqual([expect.stringContaining('can decide "merged"'), expect.stringContaining('can decide "rejected"')]);
  });

  it("refuses an independent team on an action whose answer it would have to invent fields for, and says why", () => {
    expect(teamErrors(pipeline(independent(), { entryAction: "audit" }))).toEqual([expect.stringMatching(/also requires "findings"\. Use a leader-led team/)]);
    // A pack's action is shaped by the pack: never answered with a shape it did not ask for.
    const packAction = pipeline(independent(), { ownerRole: "reviewer", entryAction: "review" });
    expect(teamErrors(packAction)).toContainEqual(expect.stringContaining(`"review" is a pack's action, whose answer the pack shapes`));
    expect(teamErrors(pipeline(independent(), { entryAction: "unheard_of" }))).toContainEqual(expect.stringContaining("nothing defines that action"));
    expect(teamErrors(pipeline(leader(), { entryAction: "unheard_of" }))).toContainEqual(expect.stringContaining("which nothing defines"));
  });

  it("refuses a team's time limit longer than any run may take, and accepts a tighter one", () => {
    const team = (timeoutMs: number) => independent({ limits: { timeoutMs } });
    expect(teamErrors(pipeline(team(3_600_000), {}, { runTimeoutMs: 1_800_000 }))).toEqual([expect.stringContaining("a team's limit can only be tighter")]);
    expect(teamErrors(pipeline(team(600_000), {}, { runTimeoutMs: 1_800_000 }))).toEqual([]);
  });

  it("refuses a team that dispatch could staff with an agent EO cannot hold to report-only, for every kind of member (EO-848)", () => {
    const reportOnlyRoleProblems = { tester: "Tess runs on the person's own setup." };
    expect(teamErrors(pipeline(independent(), {}, { reportOnlyRoleProblems }))).toEqual([
      'The team on "review" could be staffed by a "tester" agent EO cannot hold to report-only: Tess runs on the person\'s own setup.',
    ]);
    expect(teamErrors(pipeline(leader(), {}, { reportOnlyRoleProblems: { reviewer: "Rex has no model." } }))).toEqual([expect.stringContaining('a "reviewer" agent EO cannot hold to report-only: Rex has no model.')]);
    // An unstaffed role is said once, as unstaffed; a step without a team is not asked.
    expect(teamErrors(pipeline(independent(), {}, { staffedRoles: ["reviewer"], reportOnlyRoleProblems }))).toEqual([expect.stringContaining('needs a "tester" agent')]);
    expect(teamErrors(pipeline(null, {}, { reportOnlyRoleProblems }))).toEqual([]);
  });

  it("holds an isolated team to none of the report-only refusals, and to giving each member a copy of its own (EO-867)", () => {
    const reportOnlyRoleProblems = { tester: "Tess runs on the person's own setup.", reviewer: "Rex has no model." };
    // Any agent that can run the step alone can be an isolated member.
    expect(teamErrors(pipeline(independent({ members: "isolated" }), {}, { reportOnlyRoleProblems }))).toEqual([]);
    expect(teamErrors(pipeline(leader({ members: "isolated" }), {}, { reportOnlyRoleProblems }))).toEqual([]);
    // Still staffed by role, as every team is.
    expect(teamErrors(pipeline(independent({ members: "isolated" }), {}, { staffedRoles: ["reviewer"] }))).toEqual([expect.stringContaining('needs a "tester" agent')]);
    // A workspace that makes no copy refuses it, naming the kind; a report-only team there is not asked.
    const isolatedCopyProblems = { review: { severity: "error" as const, why: 'but it works in a "folder" workspace, which cannot give each member a copy of its own.' } };
    expect(teamErrors(pipeline(independent({ members: "isolated" }), {}, { isolatedCopyProblems }))).toEqual([
      'The team on "review" has isolated members, but it works in a "folder" workspace, which cannot give each member a copy of its own.',
    ]);
    expect(teamErrors(pipeline(independent(), {}, { isolatedCopyProblems }))).toEqual([]);
    // Where only some of its workspaces cannot, it is a warning, and nothing refuses the pipeline (EO-871).
    const somewhere = { review: { severity: "warning" as const, why: 'and some of the workspaces it may work in — "folder" — cannot give each member a copy of its own.' } };
    const warned = validatePipeline(pipeline(independent({ members: "isolated" }), {}, { isolatedCopyProblems: somewhere }));
    expect(warned.filter((problem) => problem.severity === "error")).toEqual([]);
    expect(warned.filter((problem) => problem.severity === "warning").map((problem) => problem.message)).toContainEqual(expect.stringContaining('has isolated members, and some of the workspaces it may work in — "folder"'));
  });

  it("refuses a team built without parsing that breaks its own rules", () => {
    const valid = independent();
    if (valid.coordination !== "independent") throw new Error("independent");
    const twice: StepTeam = { ...valid, participants: [valid.participants[0]!, valid.participants[0]!] };
    expect(teamErrors(pipeline(twice))).toContainEqual(expect.stringContaining('Two participants share the assignment key "security"'));
    const administrator: StepTeam = { ...valid, participants: [{ ...valid.participants[0]!, role: "system" }] };
    expect(teamErrors(pipeline(administrator, {}, { staffedRoles: ["reviewer", "tester", "system"] }))).toContainEqual(expect.stringContaining('"system" role administers EO'));
  });
});
