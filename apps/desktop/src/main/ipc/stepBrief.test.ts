import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PipelineStep, type PipelineStepView, type StepBrief, type StepRouteView, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { createPipeline, createProject, createRoute, createStep, listStepsForPipeline, setEntryStep, versionSnapshot, currentVersion } from "../db/repos/index.js";
import { exportPipeline, importPipeline } from "../modules/pipelineTransfer.js";
import { savePipeline } from "./configCommands.js";
import { pipelineVersionsCommand } from "./pipelineCommands.js";

/**
 * A person step's declared brief (EO-827) as part of the graph: stored on
 * the step, frozen in the version a save files, reported by the version
 * diff, carried by export and import, and judged by `validatePipeline` at
 * the save's door.
 */
let handle: DbHandle;
let pipelineId: Uuid;
let draft: PipelineStep;
let approve: PipelineStep;
let done: PipelineStep;

beforeEach(() => {
  handle = openMigratedTestDb();
  const project = createProject(handle.db, { name: "Workbench", keyPrefix: "WRK" });
  pipelineId = createPipeline(handle.db, { projectId: project.id, name: "Approvals" }).id as Uuid;
  draft = createStep(handle.db, { pipelineId, position: 0, name: "Draft", type: "user", results: [{ key: "done", label: "Drafted", tone: "success", requiresComment: false }] });
  approve = createStep(handle.db, { pipelineId, position: 1, name: "Approve", type: "user", results: [{ key: "approved", label: "Approve", tone: "success", requiresComment: false }] });
  done = createStep(handle.db, { pipelineId, position: 2, name: "Done", type: "user", isTerminal: true });
  createRoute(handle.db, { pipelineId, fromStepId: draft.id, resultKey: "done", label: "Drafted", tone: "success", target: approve.id, position: 0 });
  createRoute(handle.db, { pipelineId, fromStepId: approve.id, resultKey: "approved", label: "Approve", tone: "success", target: done.id, position: 0 });
  setEntryStep(handle.db, pipelineId, draft.id);
});

afterEach(() => handle.close());

const routes = (): StepRouteView[] => [
  { id: "r1", pipelineId, fromStepId: draft.id, resultKey: "done", label: "Drafted", tone: "success", target: approve.id, position: 0 },
  { id: "r2", pipelineId, fromStepId: approve.id, resultKey: "approved", label: "Approve", tone: "success", target: done.id, position: 0 },
];

/** The graph as a save sends it, with Approve's brief as given; `undefined` leaves the key out. */
function graph(brief: StepBrief | null | undefined): Omit<PipelineStepView, "brief" | "team">[] {
  return [draft, approve, done].map((step) => {
    const view = {
      id: step.id,
      pipelineId,
      position: step.position,
      name: step.name,
      type: step.type,
      ownerRole: step.ownerRole,
      entryAction: step.entryAction,
      instructionsSummary: step.instructionsSummary,
      isTerminal: step.isTerminal,
      planMode: step.planMode,
      workspaceMode: step.workspaceMode,
      workspaceId: step.workspaceId,
      inputs: step.inputs,
      timeoutMs: step.timeoutMs,
      watch: step.watch,
      results: step.results,
      moduleVersion: null,
    };
    return step.id === approve.id && brief !== undefined ? { ...view, brief } : view;
  });
}

const save = (brief: StepBrief | null | undefined) => savePipeline(handle.db, { notifyStateChange: () => {} }, { pipelineId, steps: graph(brief), routes: routes(), entryStepId: draft.id });
const approveStep = () => listStepsForPipeline(handle.db, pipelineId).find((step) => step.id === approve.id)!;

const DECLARED: StepBrief = [
  { show: "output", step: "PLACEHOLDER" },
  { show: "comment", kind: "approval", role: "reviewer" },
  { show: "field", field: "acceptance_criteria" },
];
const declared = (): StepBrief => DECLARED.map((part) => (part.show === "output" ? { ...part, step: draft.id } : part));

describe("a step's brief, as part of the graph (EO-827)", () => {
  it("is stored on the step, kept by a save that leaves it out, and cleared by null", () => {
    expect(approveStep().brief).toBeNull();
    expect(save(declared()).saved).toBe(true);
    expect(approveStep().brief).toEqual(declared());

    expect(save(undefined).saved).toBe(true);
    expect(approveStep().brief).toEqual(declared());

    expect(save(null).saved).toBe(true);
    expect(approveStep().brief).toBeNull();
  });

  it("is frozen in the version a save files, and the version diff reports it", () => {
    expect(save(declared()).saved).toBe(true);
    const declaredIn = currentVersion(handle.db, pipelineId)!;
    expect(versionSnapshot(handle.db, declaredIn.id)?.steps.find((step) => step.id === approve.id)?.brief).toEqual(declared());

    expect(save(null).saved).toBe(true);
    const clearedIn = currentVersion(handle.db, pipelineId)!;
    expect(versionSnapshot(handle.db, clearedIn.id)?.steps.find((step) => step.id === approve.id)?.brief).toBeNull();

    const diff = pipelineVersionsCommand(handle.db, { pipelineId, from: declaredIn.number, to: clearedIn.number }).diff;
    expect(diff?.steps).toEqual([
      expect.objectContaining({
        stepId: approve.id,
        change: "changed",
        fields: [
          {
            field: "brief",
            before: 'the newest output of Draft, then the newest approval by reviewer, then the field "acceptance_criteria"',
            after: "the default",
          },
        ],
      }),
    ]);
  });

  it("travels in an export and comes back on import, naming the step by its new id", () => {
    expect(save(declared()).saved).toBe(true);
    const exported = exportPipeline(handle.db, pipelineId);
    if (!exported.ok) throw new Error(exported.reason);
    const exportedApprove = exported.document.steps.find((step) => step.id === approve.id)!;
    expect(exportedApprove.brief).toEqual(declared());
    // Written only where a step declares one.
    expect(exported.document.steps.find((step) => step.id === draft.id)).not.toHaveProperty("brief");

    const imported = importPipeline(handle.db, { document: exported.document });
    if (!imported.ok) throw new Error(JSON.stringify(imported));
    const steps = listStepsForPipeline(handle.db, imported.pipelineId);
    const newDraft = imported.stepIds[draft.id]!;
    expect(newDraft).not.toBe(draft.id);
    expect(steps.find((step) => step.id === imported.stepIds[approve.id])?.brief).toEqual([
      { show: "output", step: newDraft },
      { show: "comment", kind: "approval", role: "reviewer" },
      { show: "field", field: "acceptance_criteria" },
    ]);
    expect(steps.find((step) => step.id === newDraft)?.brief).toBeNull();
  });

  it("refuses an import whose brief names a step the board lacks, with the sentence naming it", () => {
    expect(save(declared()).saved).toBe(true);
    const exported = exportPipeline(handle.db, pipelineId);
    if (!exported.ok) throw new Error(exported.reason);
    const document = {
      ...exported.document,
      steps: exported.document.steps.map((step) => (step.id === approve.id ? { ...step, brief: [{ show: "output" as const, step: "qa" }] } : step)),
    };
    expect(importPipeline(handle.db, { document })).toMatchObject({ ok: false, reason: 'The brief on "Approve" shows the output of "qa", a step this pipeline does not have.' });
  });

  it("refuses a save naming a step, a field or a comment kind the pipeline or project lacks, with a sentence naming each", () => {
    const refused = save([
      { show: "output", step: "qa" },
      { show: "field", field: "customer" },
      { show: "comment", kind: "praise" },
    ]);
    expect(refused.saved).toBe(false);
    expect(refused.problems.map((problem) => problem.message)).toEqual(
      expect.arrayContaining([
        'The brief on "Approve" shows the output of "qa", a step this pipeline does not have.',
        'The brief on "Approve" shows the field "customer", which no item type on this project declares.',
        'The brief on "Approve" shows the newest "praise" comment, which is not a kind of comment: use one of note, question, decision, approval, rejection, escalation, output.',
      ]),
    );
    expect(refused.problems.filter((problem) => problem.message.startsWith("The brief")).every((problem) => problem.stateId === approve.id)).toBe(true);
    expect(approveStep().brief).toBeNull();
  });
});
