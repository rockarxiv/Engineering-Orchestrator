import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StepTeamSchema, TEAM_REPORT_ONLY, type IpcChannel, type IpcPayload, type IpcResponse, type PipelineStep, type StepTeam, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { saveActionDefinition } from "../db/repos/actionDefinitionsRepo.js";
import { copyPipeline } from "../db/repos/pipelineCopyRepo.js";
import { createPipeline, createProject, createRoute, createStep, currentVersion, listAgents, listStepsForPipeline, setEntryStep, updateAgent, versionSnapshot } from "../db/repos/index.js";
import { TOOLS, type Dispatch } from "../mcpHost/catalog.js";
import { exportPipeline, importPipeline } from "../modules/pipelineTransfer.js";
import { savePipeline, validatePipelineCommand } from "./configCommands.js";
import { listPipelineStepViews } from "./domainQueries.js";
import { pipelineVersionsCommand } from "./pipelineCommands.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "./registry.js";

/**
 * A report-only team on an agent step (EO-843) as part of the graph:
 * stored on the step and read back, kept by a save that leaves it out,
 * frozen in versions and restored with one, carried by a copy and by an
 * export and import that re-mint every id, and never offered to an agent
 * through `pipeline_save`.
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
  check = createStep(handle.db, { pipelineId, position: 0, name: "Check", type: "agent", ownerRole: "reviewer", entryAction: "check" });
  done = createStep(handle.db, { pipelineId, position: 1, name: "Done", type: "user", isTerminal: true });
  createRoute(handle.db, { pipelineId, fromStepId: check.id, resultKey: "approved", label: "Approved", tone: "success", target: done.id, position: 0 });
  createRoute(handle.db, { pipelineId, fromStepId: check.id, resultKey: "changes_requested", label: "Changes", tone: "warning", target: done.id, position: 1 });
  setEntryStep(handle.db, pipelineId, check.id);
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

/** The graph as the editor sends it, with Check's team as given; `undefined` leaves the key out. */
function graph(team: StepTeam | null | undefined): IpcPayload<"pipeline:save"> {
  const read = listPipelineStepViews(handle.db, { pipelineId });
  const steps = read.steps.map((step): IpcPayload<"pipeline:save">["steps"][number] => {
    const view: IpcPayload<"pipeline:save">["steps"][number] = { ...step };
    // Left out unless given, so a save can be told nothing about it.
    delete view.team;
    return step.id === check.id && team !== undefined ? { ...view, team } : view;
  });
  return { pipelineId, steps, routes: read.routes, entryStepId: read.entryStepId };
}

const save = (team: StepTeam | null | undefined) => savePipeline(handle.db, { notifyStateChange: () => {} }, graph(team));
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
    const saved = save(TEAM);
    expect(saved.saved).toBe(true);
    // An independent team runs (EO-846), so nothing is said about it running as one agent.
    expect(saved.problems).not.toContainEqual(expect.objectContaining({ stateId: check.id, message: expect.stringContaining("runs as one agent") }));
    expect(teamOf()).toEqual(TEAM);
    expect(listPipelineStepViews(handle.db, { pipelineId }).steps.find((step) => step.id === check.id)?.team).toEqual(TEAM);

    expect(save(undefined).saved).toBe(true);
    expect(teamOf()).toEqual(TEAM);

    expect(save(null).saved).toBe(true);
    expect(teamOf()).toBeNull();
  });

  it("refuses a team this project cannot staff, or on a step no agent does, and writes nothing", () => {
    const unstaffed = StepTeamSchema.parse({ ...TEAM, participants: [{ key: "legal", role: "lawyer", instructions: "Read the licence." }] });
    const refused = save(unstaffed);
    expect(refused.saved).toBe(false);
    expect(refused.problems).toContainEqual(expect.objectContaining({ severity: "error", stateId: check.id, message: 'The team on "Check" needs a "lawyer" agent, and this project has none enabled.' }));
    expect(teamOf()).toBeNull();

    const onPerson = graph(undefined);
    onPerson.steps = onPerson.steps.map((step) => (step.id === done.id ? { ...step, team: TEAM } : step));
    const refusedOnPerson = savePipeline(handle.db, { notifyStateChange: () => {} }, onPerson);
    expect(refusedOnPerson.saved).toBe(false);
    expect(refusedOnPerson.problems).toContainEqual(expect.objectContaining({ severity: "error", message: '"Done" has a team, but only a step an agent does can run as one.' }));
  });

  it("is frozen in the version a save files, reported by the diff, and comes back with a restore", () => {
    expect(save(TEAM).saved).toBe(true);
    const withTeam = currentVersion(handle.db, pipelineId)!;
    expect(versionSnapshot(handle.db, withTeam.id)?.steps.find((step) => step.id === check.id)?.team).toEqual(TEAM);

    expect(save(null).saved).toBe(true);
    const without = currentVersion(handle.db, pipelineId)!;
    const diff = pipelineVersionsCommand(handle.db, { pipelineId, from: withTeam.number, to: without.number }).diff;
    expect(diff?.steps).toEqual([expect.objectContaining({ stepId: check.id, change: "changed", fields: [expect.objectContaining({ field: "team", after: "one agent" })] })]);

    const draft = pipelineVersionsCommand(handle.db, { pipelineId, graph: withTeam.number }).graph!;
    expect(draft.steps.find((step) => step.id === check.id)?.team).toEqual(TEAM);
    expect(savePipeline(handle.db, { notifyStateChange: () => {} }, { pipelineId, steps: draft.steps, routes: draft.routes, entryStepId: draft.entryStepId }).saved).toBe(true);
    expect(teamOf()).toEqual(TEAM);
  });

  it("goes with a copy of the pipeline, on the copy's own step and in its versions", () => {
    expect(save(TEAM).saved).toBe(true);
    const copy = copyPipeline(handle.db, pipelineId, projectId);
    const copied = copy.stepIds.get(check.id)!;
    expect(copied).not.toBe(check.id);
    expect(teamOf(copied, copy.pipelineId)).toEqual(TEAM);
    const version = currentVersion(handle.db, copy.pipelineId)!;
    expect(versionSnapshot(handle.db, version.id)?.steps.find((step) => step.id === copied)?.team).toEqual(TEAM);
  });

  it("travels in an export, written only where configured, and comes back on import on the step's new id", () => {
    expect(save(TEAM).saved).toBe(true);
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
    expect(advertised).not.toContain('"team"');

    expect(save(TEAM).saved).toBe(true);
    const cleared = await tool("pipeline_save").run(dispatch, graph(null));
    expect(cleared.ok).toBe(true);
    expect(teamOf()).toEqual(TEAM);

    expect(save(null).saved).toBe(true);
    const set = await tool("pipeline_save").run(dispatch, graph(TEAM));
    expect(set.ok).toBe(true);
    expect(teamOf()).toBeNull();
  });

  it("is checked by pipeline_validate, whose answer reads each team as dispatch would: staffing, report-only, the action and its results (EO-848)", async () => {
    registerHandler("pipeline:validate", (payload) => validatePipelineCommand(handle.db, payload), { exposeErrorDetails: true });
    expect(JSON.stringify(tool("pipeline_validate").inputSchema)).toContain('"team"');

    const valid = await tool("pipeline_validate").run(dispatch, graph(TEAM));
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
    const auditing = graph(TEAM);
    auditing.steps = auditing.steps.map((step) => (step.id === check.id ? { ...step, entryAction: "audit" } : step));
    const refused = await tool("pipeline_validate").run(dispatch, auditing);
    if (!refused.ok) throw new Error(refused.message);
    const read = (refused.data as IpcResponse<"pipeline:validate">).teams[0]!;
    expect(read.finalAction.problem).toMatch(/also requires "findings"\. Use a leader-led team/);
    expect(read.staffing.find((staff) => staff.role === "implementer")?.problem).toContain("uses the person's own setup");
    expect(read.problems).toEqual([
      expect.stringContaining('could be staffed by a "implementer" agent EO cannot hold to report-only'),
      expect.stringMatching(/also requires "findings"/),
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

  it("is listed by pipeline_get, in a person's words and as a draft's `team` takes it (EO-848)", async () => {
    registerHandler("pipelineSteps:list", (payload) => listPipelineStepViews(handle.db, payload), { exposeErrorDetails: true });
    expect(save(TEAM).saved).toBe(true);
    const read = await tool("pipeline_get").run(dispatch, { pipelineId });
    if (!read.ok) throw new Error(read.message);
    expect((read.data as IpcResponse<"pipelineSteps:list">).teams.map((team) => team.stepId)).toEqual([check.id]);
    expect(read.text).toContain(`### Check (id: ${check.id}) — independent`);
    expect(read.text).toContain("- Member: security: a reviewer agent, required — Look for auth gaps.");
    expect(read.text).toContain(`- \`team\`: ${JSON.stringify(TEAM)}`);
    expect(read.text).toContain("pipeline_save cannot set one");
  });
});
