import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StepTeamSchema, TEAM_REPORT_ONLY, TeamDefinitionSchema, uuidv7, type IpcChannel, type IpcPayload, type IpcResponse, type PipelineStep, type StepTeam, type TeamDefinition, type TeamSave, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb, agentOfKind } from "../db/testHelpers.js";
import { saveActionDefinition } from "../db/repos/actionDefinitionsRepo.js";
import { copyPipeline } from "../db/repos/pipelineCopyRepo.js";
import { createPipeline, createProject, createRoute, createStep, currentVersion, listAgents, listStepsForPipeline, setEntryStep, updateAgent, versionSnapshot } from "../db/repos/index.js";
import { TOOLS, type Dispatch } from "../mcpHost/catalog.js";
import { exportPipeline, importPipeline } from "../modules/pipelineTransfer.js";
import { getTeam, listTeams } from "../db/repos/teamsRepo.js";
import { savePipeline, validatePipelineCommand } from "./configCommands.js";
import { listPipelineStepViews } from "./domainQueries.js";
import { pipelineVersionsCommand } from "./pipelineCommands.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "./registry.js";

/**
 * A team on an agent step (EO-843) as part of the graph, the step naming a
 * declared team (EO-881): named on the step and read back as it runs, kept
 * by a save that leaves it out, frozen in versions and restored with one,
 * carried by a copy and by an export and import that re-mint every id,
 * and never offered to an agent through `pipeline_save`.
 */
let handle: DbHandle;
let pipelineId: Uuid;
let projectId: Uuid;
let check: PipelineStep;
let done: PipelineStep;

const TEAM: StepTeam = StepTeamSchema.parse({
  coordination: "independent",
  participants: [
    { key: "security", role: "reviewer", instructions: "Look for auth gaps." },
    { key: "tests", role: "implementer", instructions: "Check the tests cover the criteria.", required: false },
  ],
  outcomes: [
    { key: "clear", label: "Clear" },
    { key: "concerns", label: "Concerns" },
  ],
  completion: { rules: [{ when: "any", outcomes: ["concerns"], result: "changes_requested" }], fallback: "approved" },
  limits: { maxParallel: 1 },
});

/** The same team, declared (EO-881): each member the agent its role was staffed by. */
let TEAM_ID: string;
let DEFINITION: TeamDefinition;

beforeEach(() => {
  handle = openMigratedTestDb();
  // A team's members are held to report-only (EO-845), which EO can do on
  // Claude and Codex and not on the seeded fake backend — and a team
  // nobody could be staffed for is refused at publish (EO-848).
  for (const agent of listAgents(handle.db)) updateAgent(handle.db, agent.id, { provider: "claude" });
  // An action of result and summary alone, which an independent team can answer.
  const defined = saveActionDefinition(handle.db, {
    role: "reviewer",
    action: "check",
    results: [
      { key: "approved", meaning: "Nothing to change." },
      { key: "changes_requested", meaning: "Something to change." },
    ],
  });
  if (!defined.ok) throw new Error(JSON.stringify(defined));
  projectId = createProject(handle.db, { name: "Workbench", keyPrefix: "WRK" }).id as Uuid;
  pipelineId = createPipeline(handle.db, { projectId, name: "Checks" }).id as Uuid;
  check = createStep(handle.db, { pipelineId, position: 0, name: "Check", type: "agent", agentId: agentOfKind(handle.db, "reviewer"), entryAction: "check" });
  done = createStep(handle.db, { pipelineId, position: 1, name: "Done", type: "user", isTerminal: true });
  createRoute(handle.db, { pipelineId, fromStepId: check.id, resultKey: "approved", label: "Approved", tone: "success", target: done.id, position: 0 });
  createRoute(handle.db, { pipelineId, fromStepId: check.id, resultKey: "changes_requested", label: "Changes", tone: "warning", target: done.id, position: 1 });
  setEntryStep(handle.db, pipelineId, check.id);
  TEAM_ID = uuidv7();
  DEFINITION = TeamDefinitionSchema.parse({
    name: "Security pass",
    coordination: "independent",
    members: [
      { key: "security", agentId: agentOfKind(handle.db, "reviewer"), instructions: "Look for auth gaps." },
      { key: "tests", agentId: agentOfKind(handle.db, "implementer"), instructions: "Check the tests cover the criteria.", required: false },
    ],
    outcomes: TEAM.outcomes,
    completion: TEAM.coordination === "independent" ? TEAM.completion : undefined,
    limits: { maxParallel: 1 },
  });
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

/** Check's team as a save names it: the declared team, `null` for none, `undefined` to say nothing. */
type Naming = "team" | null | undefined;

/** The graph as a published draft sends it, Check naming the team as given and the team declared beside it; `undefined` leaves the key out. */
function graph(team: Naming, declared: TeamSave[] = team === "team" ? [{ id: TEAM_ID, definition: DEFINITION }] : []): IpcPayload<"pipeline:save"> {
  const read = listPipelineStepViews(handle.db, { pipelineId });
  const steps = read.steps.map((step): IpcPayload<"pipeline:save">["steps"][number] => {
    // Left out unless given, so a save can be told nothing about it.
    const withoutTeam = (({ team: _team, teamId: _teamId, ...rest }: typeof step) => rest)(step);
    return step.id === check.id && team !== undefined ? { ...withoutTeam, teamId: team === null ? null : TEAM_ID } : withoutTeam;
  });
  return { pipelineId, steps, routes: read.routes, entryStepId: read.entryStepId, ...(declared.length === 0 ? {} : { teams: declared }) };
}

const save = (team: Naming, declared?: TeamSave[]) => savePipeline(handle.db, { notifyStateChange: () => {} }, graph(team, declared));
const teamOf = (id: string = check.id, pipeline: string = pipelineId) => listStepsForPipeline(handle.db, pipeline as Uuid).find((step) => step.id === id)?.team;

describe("a step's team, as part of the graph (EO-843)", () => {
  it("leaves every step of a pipeline without one as one agent, read and exported as before", () => {
    expect(listStepsForPipeline(handle.db, "default").every((step) => step.team === null)).toBe(true);
    const exported = exportPipeline(handle.db, "default");
    if (!exported.ok) throw new Error(exported.reason);
    expect(exported.document.steps.some((step) => "team" in step)).toBe(false);
  });

  it("is stored on the step and read back, kept by a save that leaves it out, and removed by null", () => {
    expect(teamOf()).toBeNull();
    const saved = save("team");
    expect(saved.saved).toBe(true);
    // An independent team runs (EO-846), so nothing is said about it running as one agent.
    expect(saved.problems).not.toContainEqual(expect.objectContaining({ stateId: check.id, message: expect.stringContaining("runs as one agent") }));
    expect(teamOf()).toEqual(TEAM);
    expect(listPipelineStepViews(handle.db, { pipelineId }).steps.find((step) => step.id === check.id)).toMatchObject({ team: TEAM, teamId: TEAM_ID });
    // Declared by the same save, as the assistant's (EO-881), on the pipeline's project.
    expect(getTeam(handle.db, TEAM_ID)).toMatchObject({ projectId, name: "Security pass", version: 1, definition: DEFINITION });

    expect(save(undefined).saved).toBe(true);
    expect(teamOf()).toEqual(TEAM);

    expect(save(null).saved).toBe(true);
    expect(teamOf()).toBeNull();
  });

  it("refuses a team this project cannot staff, or on a step no agent does, and writes nothing", () => {
    // A member that cannot run as itself (EO-882): never stood in for by another agent of its kind.
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    updateAgent(handle.db, implementer.id, { enabled: false });
    const refused = save("team");
    expect(refused.saved).toBe(false);
    expect(refused.problems).toContainEqual(expect.objectContaining({ severity: "error", stateId: check.id, message: `"Check" runs as the team "Security pass": Its member "${implementer.name}" is disabled, so it cannot run.` }));
    expect(teamOf()).toBeNull();
    // Nothing written: neither the step's team nor the team.
    expect(getTeam(handle.db, TEAM_ID)).toBeUndefined();
    updateAgent(handle.db, implementer.id, { enabled: true });

    const onPerson = graph(undefined, [{ id: TEAM_ID, definition: DEFINITION }]);
    onPerson.steps = onPerson.steps.map((step) => (step.id === done.id ? { ...step, teamId: TEAM_ID } : step));
    const refusedOnPerson = savePipeline(handle.db, { notifyStateChange: () => {} }, onPerson);
    expect(refusedOnPerson.saved).toBe(false);
    expect(refusedOnPerson.problems).toContainEqual(expect.objectContaining({ severity: "error", message: '"Done" runs as the team "Security pass", but only a step an agent does can run as a team.' }));
  });

  it("refuses a step naming a team that does not exist, another project's, or one whose leader's kind lacks the step's action, each naming the step and the team (EO-881)", () => {
    const missing = save("team", []);
    expect(missing.saved).toBe(false);
    expect(missing.problems).toContainEqual(expect.objectContaining({ severity: "error", stateId: check.id, message: `"Check" runs as a team that does not exist (${TEAM_ID}).` }));

    // Another project's team, declared there first.
    const other = createProject(handle.db, { name: "Elsewhere", keyPrefix: "ELS" }).id as Uuid;
    const elsewhere = createPipeline(handle.db, { projectId: other, name: "Theirs" }).id as Uuid;
    const theirStep = createStep(handle.db, { pipelineId: elsewhere, position: 0, name: "Theirs", type: "agent", agentId: agentOfKind(handle.db, "reviewer"), entryAction: "check", team: TEAM });
    const theirTeam = theirStep.teamId!;
    expect(getTeam(handle.db, theirTeam)?.projectId).toBe(other);
    const foreign = graph(undefined);
    foreign.steps = foreign.steps.map((step) => (step.id === check.id ? { ...step, teamId: theirTeam } : step));
    const refusedForeign = savePipeline(handle.db, { notifyStateChange: () => {} }, foreign);
    expect(refusedForeign.saved).toBe(false);
    expect(refusedForeign.problems).toContainEqual(
      expect.objectContaining({ severity: "error", stateId: check.id, message: `"Check" runs as the team "Theirs · Theirs", which belongs to another project: a step may run only as a team of its own pipeline's project.` }),
    );

    // A leader whose kind has no `check`: the implementer's.
    const led = TeamDefinitionSchema.parse({
      name: "Led by the implementer",
      coordination: "leader",
      leader: { agentId: agentOfKind(handle.db, "implementer"), instructions: "Lead the check." },
      members: [{ agentId: agentOfKind(handle.db, "reviewer") }],
    });
    const refusedLeader = save("team", [{ id: TEAM_ID, definition: led }]);
    expect(refusedLeader.saved).toBe(false);
    expect(refusedLeader.problems).toContainEqual(
      expect.objectContaining({ severity: "error", stateId: check.id, message: '"Check" runs as the team "Led by the implementer", whose leader "Implementer" is a implementer agent, and that kind has no "check" action to answer.' }),
    );
    expect(teamOf()).toBeNull();
  });

  it("refuses a team the save declares that no step names, held to validateTeam all the same, and writes nothing (EO-881)", () => {
    const unused = TeamDefinitionSchema.parse({
      name: "With the system agent",
      coordination: "leader",
      leader: { agentId: agentOfKind(handle.db, "reviewer"), instructions: "Lead." },
      members: [{ agentId: agentOfKind(handle.db, "system") }],
    });
    const id = uuidv7();
    const refused = save(undefined, [{ id, definition: unused }]);
    expect(refused.saved).toBe(false);
    expect(refused.problems).toContainEqual(
      expect.objectContaining({ severity: "error", stateId: null, message: expect.stringMatching(/^The team "With the system agent": ".+" is EO's system agent, which administers EO and can never be a team member\.$/) }),
    );
    expect(getTeam(handle.db, id)).toBeUndefined();
    // The editor's own check says it too, before Publish is pressed.
    expect(validatePipelineCommand(handle.db, graph(undefined, [{ id, definition: unused }])).problems).toContainEqual(expect.objectContaining({ message: expect.stringContaining('The team "With the system agent": ') }));
  });

  it("refuses a change to a team another pipeline's step names where it would leave that step refused, naming that pipeline (EO-881)", () => {
    // Check names the team, and a second pipeline of the project is changing it.
    expect(save("team").saved).toBe(true);
    const gates = createPipeline(handle.db, { projectId, name: "Gates" }).id as Uuid;
    const gate = createStep(handle.db, { pipelineId: gates, position: 0, name: "Gate", type: "agent", agentId: agentOfKind(handle.db, "reviewer"), entryAction: "check" });
    const shut = createStep(handle.db, { pipelineId: gates, position: 1, name: "Shut", type: "user", isTerminal: true });
    createRoute(handle.db, { pipelineId: gates, fromStepId: gate.id, resultKey: "approved", label: "Approved", tone: "success", target: shut.id, position: 0 });
    createRoute(handle.db, { pipelineId: gates, fromStepId: gate.id, resultKey: "changes_requested", label: "Changes", tone: "warning", target: shut.id, position: 1 });
    setEntryStep(handle.db, gates, gate.id);
    const read = listPipelineStepViews(handle.db, { pipelineId: gates });
    const gatesGraph = (declared: TeamSave[]): IpcPayload<"pipeline:save"> => ({ pipelineId: gates, steps: read.steps, routes: read.routes, entryStepId: read.entryStepId, teams: declared });

    // Led by the implementer, whose kind has no `check`: Check could no longer run.
    const led = TeamDefinitionSchema.parse({
      name: "Security pass",
      coordination: "leader",
      leader: { agentId: agentOfKind(handle.db, "implementer"), instructions: "Lead the check." },
      members: [{ agentId: agentOfKind(handle.db, "reviewer") }],
    });
    const refused = savePipeline(handle.db, { notifyStateChange: () => {} }, gatesGraph([{ id: TEAM_ID, definition: led }]));
    expect(refused.saved).toBe(false);
    expect(refused.problems).toContainEqual(
      expect.objectContaining({
        severity: "error",
        stateId: null,
        message: 'In the pipeline "Checks", which names the same team: "Check" runs as the team "Security pass", whose leader "Implementer" is a implementer agent, and that kind has no "check" action to answer.',
      }),
    );
    expect(getTeam(handle.db, TEAM_ID)).toMatchObject({ version: 1, definition: DEFINITION });
    expect(teamOf()).toEqual(TEAM);

    // A change Check can still run is published, as the team's next version.
    const kept = TeamDefinitionSchema.parse({ ...DEFINITION, limits: { ...DEFINITION.limits, maxParallel: 2 } });
    expect(savePipeline(handle.db, { notifyStateChange: () => {} }, gatesGraph([{ id: TEAM_ID, definition: kept }])).saved).toBe(true);
    expect(getTeam(handle.db, TEAM_ID)).toMatchObject({ version: 2, definition: kept });
  });

  it("is frozen in the version a save files, reported by the diff, and comes back with a restore", () => {
    expect(save("team").saved).toBe(true);
    const withTeam = currentVersion(handle.db, pipelineId)!;
    expect(versionSnapshot(handle.db, withTeam.id)?.steps.find((step) => step.id === check.id)).toMatchObject({ team: TEAM, teamId: TEAM_ID });

    expect(save(null).saved).toBe(true);
    const without = currentVersion(handle.db, pipelineId)!;
    const diff = pipelineVersionsCommand(handle.db, { pipelineId, from: withTeam.number, to: without.number }).diff;
    expect(diff?.steps).toEqual([
      expect.objectContaining({
        stepId: check.id,
        change: "changed",
        fields: [expect.objectContaining({ field: "team", after: "one agent" }), { field: "declared team", before: "Security pass", after: null }],
      }),
    ]);

    const draft = pipelineVersionsCommand(handle.db, { pipelineId, graph: withTeam.number }).graph!;
    expect(draft.steps.find((step) => step.id === check.id)).toMatchObject({ team: TEAM, teamId: TEAM_ID });
    expect(savePipeline(handle.db, { notifyStateChange: () => {} }, { pipelineId, steps: draft.steps, routes: draft.routes, entryStepId: draft.entryStepId }).saved).toBe(true);
    expect(teamOf()).toEqual(TEAM);
  });

  it("goes with a copy of the pipeline, on the copy's own step and in its versions", () => {
    expect(save("team").saved).toBe(true);
    const copy = copyPipeline(handle.db, pipelineId, projectId);
    const copied = copy.stepIds.get(check.id)!;
    expect(copied).not.toBe(check.id);
    expect(teamOf(copied, copy.pipelineId)).toEqual(TEAM);
    const version = currentVersion(handle.db, copy.pipelineId)!;
    expect(versionSnapshot(handle.db, version.id)?.steps.find((step) => step.id === copied)?.team).toEqual(TEAM);
    // On the same project the copy shares the team (EO-881)…
    expect(listStepsForPipeline(handle.db, copy.pipelineId).find((step) => step.id === copied)?.teamId).toBe(TEAM_ID);

    // …and on another it names a copy of the team there, since a step names only its own project's.
    const other = createProject(handle.db, { name: "Elsewhere", keyPrefix: "ELS" }).id as Uuid;
    const moved = copyPipeline(handle.db, pipelineId, other);
    const movedStep = listStepsForPipeline(handle.db, moved.pipelineId).find((step) => step.id === moved.stepIds.get(check.id));
    expect(movedStep?.team).toEqual(TEAM);
    expect(movedStep?.teamId).not.toBe(TEAM_ID);
    expect(getTeam(handle.db, movedStep!.teamId!)).toMatchObject({ projectId: other, name: "Security pass", definition: DEFINITION });
  });

  it("travels in an export, written only where configured, and comes back on import on the step's new id", () => {
    expect(save("team").saved).toBe(true);
    const exported = exportPipeline(handle.db, pipelineId);
    if (!exported.ok) throw new Error(exported.reason);
    expect(exported.document.steps.find((step) => step.id === check.id)?.team).toEqual(TEAM);
    expect(exported.document.steps.find((step) => step.id === done.id)).not.toHaveProperty("team");
    // Roles and its own keys only: nothing in it names this installation.
    expect(JSON.stringify(exported.document.steps.find((step) => step.id === check.id)?.team)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);

    const imported = importPipeline(handle.db, { document: JSON.parse(JSON.stringify(exported.document)) as typeof exported.document, projectId });
    if (!imported.ok) throw new Error(JSON.stringify(imported));
    const newCheck = imported.stepIds[check.id]!;
    expect(newCheck).not.toBe(check.id);
    expect(teamOf(newCheck, imported.pipelineId)).toEqual(TEAM);
    // Declared on import (EO-881), its roles bound to this project's agents, under a name of its own.
    const importedTeam = getTeam(handle.db, listStepsForPipeline(handle.db, imported.pipelineId as Uuid).find((step) => step.id === newCheck)!.teamId!);
    expect(importedTeam).toMatchObject({ projectId, definition: expect.objectContaining({ members: DEFINITION.members }) });
    expect(listTeams(handle.db, projectId)).toHaveLength(2);
    expect(teamOf(imported.stepIds[done.id]!, imported.pipelineId)).toBeNull();
  });
});

describe("a step's team through pipeline_save (EO-843)", () => {
  const dispatch: Dispatch = (channel: IpcChannel, payload: unknown) => dispatchIpc(channel, payload);
  const tool = (name: string) => {
    const found = TOOLS.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  };

  beforeEach(() => {
    registerHandler("pipeline:save", (payload) => savePipeline(handle.db, undefined, payload), { exposeErrorDetails: true });
  });

  it("is not offered to pipeline_save, which can neither set nor clear one, and keeps the team a step has (EO-848: a team is published from a draft's card)", async () => {
    const advertised = JSON.stringify(tool("pipeline_save").inputSchema);
    // A step's other settings are offered; its team is not.
    expect(advertised).toContain('"watch"');
    expect(advertised).not.toContain('"teamId"');
    expect(advertised).not.toContain('"teams"');

    expect(save("team").saved).toBe(true);
    const cleared = await tool("pipeline_save").run(dispatch, graph(null));
    expect(cleared.ok).toBe(true);
    expect(teamOf()).toEqual(TEAM);

    expect(save(null).saved).toBe(true);
    const set = await tool("pipeline_save").run(dispatch, graph("team", []));
    expect(set.ok).toBe(true);
    expect(teamOf()).toBeNull();
  });

  it("is checked by pipeline_validate, whose answer reads each team as dispatch would: staffing, report-only, the action and its results (EO-848)", async () => {
    registerHandler("pipeline:validate", (payload) => validatePipelineCommand(handle.db, payload), { exposeErrorDetails: true });
    expect(JSON.stringify(tool("pipeline_validate").inputSchema)).toContain('"teamId"');

    const valid = await tool("pipeline_validate").run(dispatch, graph("team"));
    if (!valid.ok) throw new Error(valid.message);
    const answer = valid.data as IpcResponse<"pipeline:validate">;
    expect(answer.problems).toEqual([]);
    expect(answer.teams).toHaveLength(1);
    const [reading] = answer.teams;
    expect(reading).toMatchObject({
      stepId: check.id,
      coordination: "independent",
      reportOnly: TEAM_REPORT_ONLY,
      finalAction: { role: "reviewer", action: "check", answeredBy: "eo", problem: null },
      results: ["changes_requested", "approved"],
      problems: [],
      declared: expect.objectContaining({ id: TEAM_ID, name: "Security pass", locked: false }),
    });
    expect(reading!.staffing).toEqual([
      { role: "reviewer", serves: "security", agents: ["Reviewer"], problem: null },
      { role: "implementer", serves: "tests", agents: ["Implementer"], problem: null },
    ]);
    expect(valid.text).toContain("## Teams");
    expect(valid.text).toContain("- Staffing: reviewer (security) — Reviewer");
    expect(valid.text).toContain("- Final answer: `reviewer / check`; EO builds the answer (result and summary) from the completion table — compatible");
    expect(valid.text).toContain("- Completion: If any report concludes Concerns → changes_requested");

    // An action that needs a field the team cannot fill, and an agent EO cannot hold to report-only: both said, as Publish would refuse them.
    const audit = saveActionDefinition(handle.db, {
      role: "reviewer",
      action: "audit",
      results: [{ key: "approved" }, { key: "changes_requested" }],
      fields: { type: "object", properties: { findings: { type: "array", items: { type: "string" } } }, required: ["findings"] },
    });
    if (!audit.ok) throw new Error(JSON.stringify(audit));
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    updateAgent(handle.db, implementer.id, { config: { inheritAmbientConfig: true } });
    const auditing = graph("team");
    auditing.steps = auditing.steps.map((step) => (step.id === check.id ? { ...step, entryAction: "audit" } : step));
    const refused = await tool("pipeline_validate").run(dispatch, auditing);
    if (!refused.ok) throw new Error(refused.message);
    const read = (refused.data as IpcResponse<"pipeline:validate">).teams[0]!;
    expect(read.finalAction.problem).toMatch(/also requires "findings"\. Use a leader-led team/);
    expect(read.staffing.find((staff) => staff.role === "implementer")?.problem).toContain("uses the person's own setup");
    expect(read.problems).toEqual([
      expect.stringMatching(/also requires "findings"/),
      expect.stringContaining(`Its member "${implementer.name}" cannot be held to report-only`),
    ]);
    // The same sentences the validator refuses a publish with.
    const problems = (refused.data as IpcResponse<"pipeline:validate">).problems.map((problem) => problem.message);
    for (const problem of read.problems) expect(problems).toContain(problem);
    expect(refused.text).toContain("**not compatible**");
    // And Publish refuses it in the same words, the team as it was left in place.
    const publishing = savePipeline(handle.db, { notifyStateChange: () => {} }, auditing);
    expect(publishing.saved).toBe(false);
    expect(publishing.problems.map((problem) => problem.message)).toEqual(expect.arrayContaining(read.problems));
    expect(teamOf()).toBeNull();
  });

  it("is listed by pipeline_get, named, in a person's words and as a draft's `teams` entry takes it (EO-848, EO-881)", async () => {
    registerHandler("pipelineSteps:list", (payload) => listPipelineStepViews(handle.db, payload), { exposeErrorDetails: true });
    expect(save("team").saved).toBe(true);
    const read = await tool("pipeline_get").run(dispatch, { pipelineId });
    if (!read.ok) throw new Error(read.message);
    expect((read.data as IpcResponse<"pipelineSteps:list">).teams.map((team) => team.stepId)).toEqual([check.id]);
    expect(read.text).toContain(`### Check (id: ${check.id}) as the team "Security pass" (teamId: ${TEAM_ID}; version 1) — independent`);
    expect(read.text).toContain('runs as the team "Security pass"');
    expect(read.text).toContain("- Member: security: a reviewer agent, required — Look for auth gaps.");
    expect(read.text).toContain('- As a draft\'s `teams` entry: {"coordination":"independent","name":"Security pass"');
    expect(read.text).toContain('"agent":"Reviewer"');
    expect(read.text).toContain("pipeline_save can do neither");
  });
});
