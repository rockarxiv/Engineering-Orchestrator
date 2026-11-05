import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ipcContract, WEBHOOK_UNATTENDED_AGENT_REFUSAL, WEBHOOK_UNATTENDED_NO_ENTRY, type IpcChannel, type IpcPayload, type IpcResponse, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { markReplica } from "../db/recordRole.js";
import {
  createPipeline,
  createStep,
  getPipeline,
  listAllJobs,
  listPipelines,
  listStepsForPipeline,
  markDiverged,
  publishSection,
  setEntryStep,
} from "../db/repos/index.js";
import { listPipelinesUpdatedSince, upsertReplicaPipeline } from "../db/repos/projectMoveRepo.js";
import { createJob, deleteJob, updateJob } from "../jobs/jobs.js";
import { mintWebhookSecret } from "../jobs/webhookSignature.js";
import { sectionLockFor } from "../managed/locks.js";
import { TOOLS, type Dispatch } from "../mcpHost/catalog.js";
import { renderPipeline } from "../mcpHost/render.js";
import { savePipeline, validatePipelineCommand } from "./configCommands.js";
import { listPipelineStepViews } from "./domainQueries.js";
import { setWebhookUnattendedCommand } from "./pipelineCommands.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "./registry.js";

/**
 * Letting one pipeline send what a webhook delivers without a person in
 * between (EO-405).
 *
 * The engine's own tests hold the rule — off refuses, on warns, on with
 * no webhook says nothing. What is held here is everything the engine
 * cannot see: that the setting is a column a person's command writes and
 * nothing else does, that the validator is actually told it, and that
 * each door somebody other than that person could come through is shut.
 *
 * The shipped Delivery pipeline is the case, as it is for EO-334's own
 * tests: `open_pull_request` is a builtin the developer pack marks as a
 * side effect, and nobody is asked before it. A webhook job filed onto
 * it is a stranger's text reaching a step that sends.
 */

let handle: DbHandle;
let stopBeingAReplica: (() => void) | null = null;

const REFUSAL = "Cases arriving by webhook go straight to Merge Request. Add an approve step before Merge Request.";
const WARNING = "Items arriving by webhook reach Merge Request without a person reading them first.";

const opts = () => ({
  exposeErrorDetails: true,
  sectionLock: (channel: IpcChannel, payload?: unknown) => sectionLockFor(handle.db, channel, payload),
});
const dispatch: Dispatch = (channel: IpcChannel, payload: unknown) => dispatchIpc(channel, payload);

function tool(name: string) {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
}

/** The graph as it stands, ready to go back through `pipeline:save`. */
function currentGraph(pipelineId = "default"): IpcPayload<"pipeline:save"> {
  const graph = listPipelineStepViews(handle.db, { pipelineId });
  return { pipelineId, steps: graph.steps, routes: graph.routes, entryStepId: graph.entryStepId };
}

function webhookJobOnto(pipelineId = "default", path = "support"): void {
  const created = createJob(handle.db, {
    projectId: null,
    name: "Support",
    trigger: { kind: "webhook", path, secret: mintWebhookSecret(), mapping: { title: null, body: null, eventKey: null, spec: {} } },
    pipelineId,
    template: { type: "developer:story", title: "A case", body: "" },
  });
  if (!created.ok) throw new Error(created.problem);
}

const unattended = (pipelineId = "default") => getPipeline(handle.db, pipelineId)?.webhookUnattended;
const webhookFindings = (problems: { severity: string; message: string }[]) =>
  problems.filter((problem) => problem.message.includes("webhook")).map(({ severity, message }) => ({ severity, message }));

beforeEach(() => {
  handle = openMigratedTestDb();
  registerHandler("pipeline:save", (payload) => savePipeline(handle.db, undefined, payload), opts());
  registerHandler("pipelines:setWebhookUnattended", (payload) => setWebhookUnattendedCommand(handle.db, payload), opts());
});

afterEach(() => {
  stopBeingAReplica?.();
  stopBeingAReplica = null;
  clearHandlerRegistry();
  handle.close();
});

describe("the setting, off", () => {
  it("is off on every pipeline that was here before it existed, and on one made since", () => {
    // What the migration leaves behind: the seeded pipelines are the ones
    // that "existed before this change", and the column's default is all
    // that decides them.
    const before = listPipelines(handle.db, undefined, true);
    expect(before.length).toBeGreaterThan(0);
    expect(before.map((pipeline) => pipeline.webhookUnattended)).toEqual(before.map(() => false));

    expect(createPipeline(handle.db, { projectId: null, name: "Acknowledgements" }).webhookUnattended).toBe(false);
  });

  it("refuses the publish exactly as it did, in the same words", () => {
    webhookJobOnto();

    expect(webhookFindings(validatePipelineCommand(handle.db, currentGraph()).problems)).toEqual([{ severity: "error", message: REFUSAL }]);
    const saved = savePipeline(handle.db, undefined, currentGraph());
    expect(saved.saved).toBe(false);
    expect(webhookFindings(saved.problems)).toEqual([{ severity: "error", message: REFUSAL }]);
  });
});

describe("the setting, on", () => {
  it("reports the same step as a warning, and publishes", () => {
    webhookJobOnto();
    const refused = validatePipelineCommand(handle.db, currentGraph()).problems.filter((problem) => problem.message.includes("webhook"));

    expect(setWebhookUnattendedCommand(handle.db, { pipelineId: "default", unattended: true })).toEqual({ unattended: true, refused: null });

    const allowed = validatePipelineCommand(handle.db, currentGraph()).problems.filter((problem) => problem.message.includes("webhook"));
    // The same finding for the same step, and no error left from the check.
    expect(allowed.map((problem) => problem.stateId)).toEqual(refused.map((problem) => problem.stateId));
    expect(webhookFindings(allowed)).toEqual([{ severity: "warning", message: WARNING }]);

    const saved = savePipeline(handle.db, undefined, currentGraph());
    expect(saved.saved).toBe(true);
    // Still said on the publish that went through: accepting a risk is
    // not the same as no longer being told about it.
    expect(webhookFindings(saved.problems)).toEqual([{ severity: "warning", message: WARNING }]);
  });

  it("is one pipeline's: turning it on here turns it on nowhere else", () => {
    webhookJobOnto();
    setWebhookUnattendedCommand(handle.db, { pipelineId: "default", unattended: true });

    const others = listPipelines(handle.db, undefined, true).filter((pipeline) => pipeline.id !== "default");
    expect(others.length).toBeGreaterThan(0);
    expect(others.map((pipeline) => pipeline.webhookUnattended)).toEqual(others.map(() => false));
  });

  it("goes back to refusing when it is turned off again", () => {
    webhookJobOnto();
    setWebhookUnattendedCommand(handle.db, { pipelineId: "default", unattended: true });
    expect(setWebhookUnattendedCommand(handle.db, { pipelineId: "default", unattended: false })).toEqual({ unattended: false, refused: null });

    expect(savePipeline(handle.db, undefined, currentGraph()).saved).toBe(false);
  });

  it("cannot be turned on where no webhook job files onto the pipeline", () => {
    // Nothing to accept yet. A waiver given ahead of the webhook would be
    // waiting for whichever job arrived later.
    expect(setWebhookUnattendedCommand(handle.db, { pipelineId: "default", unattended: true })).toEqual({
      unattended: false,
      refused: WEBHOOK_UNATTENDED_NO_ENTRY,
    });
    expect(unattended()).toBe(false);
  });

  it("tells the screens whether a webhook files here and whether it is on", () => {
    expect(listPipelineStepViews(handle.db, { pipelineId: "default" }).webhook).toEqual({ entry: false, unattended: false });

    webhookJobOnto();
    expect(listPipelineStepViews(handle.db, { pipelineId: "default" }).webhook).toEqual({ entry: true, unattended: false });

    setWebhookUnattendedCommand(handle.db, { pipelineId: "default", unattended: true });
    expect(listPipelineStepViews(handle.db, { pipelineId: "default" }).webhook).toEqual({ entry: true, unattended: true });
  });
});

/**
 * A waiver is given for a webhook that exists. When the pipeline's last
 * webhook job goes, the control goes with it — so a waiver left on would
 * be invisible in the editor and waiting for whichever job came next.
 */
describe("when the pipeline's last webhook job goes", () => {
  /** The live webhook jobs filing onto the default pipeline. */
  const webhookJobs = () => listAllJobs(handle.db).filter((job) => job.pipelineId === "default" && job.trigger.kind === "webhook");

  function waived(): void {
    webhookJobOnto();
    setWebhookUnattendedCommand(handle.db, { pipelineId: "default", unattended: true });
    expect(unattended()).toBe(true);
  }

  it("turns the waiver off when that job is deleted, and a webhook job added later is refused again", () => {
    waived();

    expect(deleteJob(handle.db, webhookJobs()[0]!.id as Uuid).deleted).toBe(true);

    expect(unattended()).toBe(false);
    expect(listPipelineStepViews(handle.db, { pipelineId: "default" }).webhook).toEqual({ entry: false, unattended: false });

    // The regression this is here for: the next job does not inherit
    // what somebody accepted for the last one.
    webhookJobOnto("default", "support-again");
    expect(listPipelineStepViews(handle.db, { pipelineId: "default" }).webhook).toEqual({ entry: true, unattended: false });
    expect(webhookFindings(validatePipelineCommand(handle.db, currentGraph()).problems)).toEqual([{ severity: "error", message: REFUSAL }]);
    expect(savePipeline(handle.db, undefined, currentGraph()).saved).toBe(false);
  });

  it("turns it off when that job is moved to another pipeline", () => {
    waived();
    const elsewhere = createPipeline(handle.db, { projectId: null, name: "Acknowledgements" });
    const lands = createStep(handle.db, { pipelineId: elsewhere.id, position: 0, name: "Inbox", type: "user" });
    setEntryStep(handle.db, elsewhere.id, lands.id);

    const moved = updateJob(handle.db, { jobId: webhookJobs()[0]!.id as Uuid, pipelineId: elsewhere.id });
    if (!moved.ok) throw new Error(moved.problem);

    expect(unattended()).toBe(false);
    // And the pipeline it moved to gets nothing it was not given.
    expect(unattended(elsewhere.id)).toBe(false);
  });

  it("turns it off when that job stops being a webhook", () => {
    waived();

    const changed = updateJob(handle.db, { jobId: webhookJobs()[0]!.id as Uuid, trigger: { kind: "manual" } });
    if (!changed.ok) throw new Error(changed.problem);

    expect(unattended()).toBe(false);
  });

  it("leaves it on while another webhook job still files onto the pipeline", () => {
    waived();
    webhookJobOnto("default", "billing");
    const [first] = webhookJobs();

    deleteJob(handle.db, first!.id as Uuid);

    expect(webhookJobs()).toHaveLength(1);
    expect(unattended()).toBe(true);
  });

  it("leaves it on through an edit that keeps the job a webhook on this pipeline", () => {
    waived();

    const renamed = updateJob(handle.db, { jobId: webhookJobs()[0]!.id as Uuid, name: "Support inbox" });
    if (!renamed.ok) throw new Error(renamed.problem);

    expect(unattended()).toBe(true);
  });

  it("is carried to replicas as a change to the pipeline", () => {
    waived();
    const before = listPipelinesUpdatedSince(handle.db, { ts: 0, id: "" }, 100).find((pipeline) => pipeline.id === "default")!.updatedAt;

    deleteJob(handle.db, webhookJobs()[0]!.id as Uuid, {});

    const after = listPipelinesUpdatedSince(handle.db, { ts: 0, id: "" }, 100).find((pipeline) => pipeline.id === "default")!;
    expect(after.webhookUnattended).toBe(false);
    expect(after.updatedAt).toBeGreaterThanOrEqual(before);
  });
});

/**
 * Invariant #11, and this story's own decision that the system agent is
 * not the exception here: the setting is a person's.
 */
describe("an agent asking for it", () => {
  it("has pipeline_save through the MCP host refuse a graph that would turn it on, with the reason, and leaves it off", async () => {
    webhookJobOnto();
    const steps = listStepsForPipeline(handle.db, "default").map((step) => step.name);

    const outcome = await tool("pipeline_save").run(dispatch, { ...currentGraph(), webhookUnattended: true });

    // The tool failing, not an answer to work around.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe(WEBHOOK_UNATTENDED_AGENT_REFUSAL);
    expect(outcome.message).toContain("Nothing was published");
    expect(outcome.message).toContain("only a person may accept");
    // Where it is — the assistant's card, since the editor is going
    // (EO-522) — so the assistant can offer it rather than send the
    // person to a screen that is not there.
    expect(outcome.message).toContain("EO's assistant");
    expect(outcome.message).toContain("`pipelineWebhookUnattended`");
    expect(outcome.message).not.toContain("configuration screen");
    expect(unattended()).toBe(false);
    // And the graph was not published on the side.
    expect(listStepsForPipeline(handle.db, "default").map((step) => step.name)).toEqual(steps);
  });

  it("refuses anything that is not a plain false, rather than guessing which way it was meant", async () => {
    webhookJobOnto();

    for (const asked of ["true", 1, "yes", null, {}]) {
      const outcome = await tool("pipeline_save").run(dispatch, { ...currentGraph(), webhookUnattended: asked });
      expect(outcome.ok).toBe(false);
    }
    expect(unattended()).toBe(false);
  });

  it("still refuses the publish itself, for the approve step, when the graph is sent without it", async () => {
    webhookJobOnto();

    // `false` is asking for what already happens: let through, and the
    // ordinary refusal answers.
    const outcome = await tool("pipeline_save").run(dispatch, { ...currentGraph(), webhookUnattended: false });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect((outcome.data as IpcResponse<"pipeline:save">).saved).toBe(false);
    expect(outcome.text).toContain(REFUSAL);
    expect(unattended()).toBe(false);
  });

  it("publishes an agent's graph once a person has turned it on, and cannot turn it off through the graph either", async () => {
    webhookJobOnto();
    setWebhookUnattendedCommand(handle.db, { pipelineId: "default", unattended: true });

    const outcome = await tool("pipeline_save").run(dispatch, { ...currentGraph(), webhookUnattended: false });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect((outcome.data as IpcResponse<"pipeline:save">).saved).toBe(true);
    // The key is taken off rather than written: a graph is not where the
    // setting lives, in either direction.
    expect(unattended()).toBe(true);
  });

  it("is reached by no tool in the catalog, and by no field of pipeline:save or pipeline:validate", () => {
    for (const candidate of TOOLS) {
      expect(candidate.channels, candidate.name).not.toContain("pipelines:setWebhookUnattended");
    }
    for (const channel of ["pipeline:save", "pipeline:validate"] as const) {
      const parsed = ipcContract[channel].request.parse({ ...currentGraph(), webhookUnattended: true });
      expect(parsed).not.toHaveProperty("webhookUnattended");
    }
  });

  // What every client is shown before it calls anything (EO-522): the
  // advertised description sends it to the assistant's card, not to a
  // configuration screen that is going, and still says no tool can.
  it("advertises pipeline_save as sending the person to the assistant's card for it", () => {
    const description = tool("pipeline_save").description.replace(/\s+/g, " ");

    expect(description).toContain("by pressing the button on the assistant's card for it (`card` with the kind `pipelineWebhookUnattended`), and this tool cannot");
    expect(description).not.toContain("configuration screen");
  });

  it("tells the assistant what the setting is and that it cannot change it", () => {
    expect(renderPipeline(listPipelineStepViews(handle.db, { pipelineId: "default" }))).not.toContain("## Webhook");

    webhookJobOnto();
    const off = renderPipeline(listPipelineStepViews(handle.db, { pipelineId: "default" }));
    expect(off).toContain("## Webhook");
    expect(off).toContain("no tool can");
    // The card is how it changes (EO-522), not a screen.
    expect(off).toContain("`pipelineWebhookUnattended`");
    expect(off).not.toContain("configuration screen");

    setWebhookUnattendedCommand(handle.db, { pipelineId: "default", unattended: true });
    const on = renderPipeline(listPipelineStepViews(handle.db, { pipelineId: "default" }));
    expect(on).toContain("without anybody reading it first");
    expect(on).toContain("the assistant's card");
    expect(on).not.toContain("configuration screen");
  });
});

/**
 * Managed mode: the setting is part of the pipelines section, so on a
 * desktop whose organisation publishes that section it is the
 * administrator's.
 */
describe("a desktop whose pipelines are managed", () => {
  beforeEach(() => {
    webhookJobOnto();
    publishSection(handle.db, {
      section: "pipelines",
      subjectId: "default",
      versionId: "a-version",
      versionNumber: 6,
      publishedAt: Date.now(),
      publishedBy: "dana-id",
      publishedByName: "Dana",
    });
    stopBeingAReplica = markReplica(handle.db, () => true);
  });

  it("refuses the command with the same typed lock refusal pipeline:save gets", async () => {
    const save = await dispatchIpc("pipeline:save", currentGraph());
    const set = await dispatchIpc("pipelines:setWebhookUnattended", { pipelineId: "default", unattended: true });

    expect(set.ok).toBe(false);
    expect(save.ok).toBe(false);
    if (set.ok || save.ok) return;
    expect(set.error.code).toBe("section-locked");
    expect(set.error.lock).toEqual({ locked: true, section: "pipelines", publishedBy: "Dana" });
    // The same refusal, not one like it.
    expect(set.error.code).toBe(save.error.code);
    expect(set.error.lock).toEqual(save.error.lock);
    expect(unattended()).toBe(false);
  });

  it("refuses it on a pipeline this machine has diverged, which pipeline:save does not", async () => {
    // A diverged copy is an edit of a graph, offered as a suggestion. It
    // is not the organisation's risk to accept from a desktop.
    markDiverged(handle.db, "default", "a-version", Date.now());

    expect(await dispatchIpc("pipeline:save", currentGraph())).toMatchObject({ ok: true });
    const set = await dispatchIpc("pipelines:setWebhookUnattended", { pipelineId: "default", unattended: true });

    expect(set.ok).toBe(false);
    if (set.ok) return;
    expect(set.error.code).toBe("section-locked");
    expect(unattended()).toBe(false);
  });

  it("takes the administrator's turning it off on a pipeline this machine has diverged, and leaves the diverged graph alone", () => {
    const record = openMigratedTestDb();
    try {
      const created = createJob(record.db, {
        projectId: null,
        name: "Support",
        trigger: { kind: "webhook", path: "support", secret: mintWebhookSecret(), mapping: { title: null, body: null, eventKey: null, spec: {} } },
        pipelineId: "default",
        template: { type: "developer:story", title: "A case", body: "" },
      });
      if (!created.ok) throw new Error(created.problem);
      const sync = () => listPipelinesUpdatedSince(record.db, { ts: 0, id: "" }, 100).map((pipeline) => [pipeline.id, upsertReplicaPipeline(handle.db, pipeline)] as const);

      // On, and here before anybody diverged.
      setWebhookUnattendedCommand(record.db, { pipelineId: "default", unattended: true });
      sync();
      expect(unattended()).toBe(true);

      // This machine edits its own copy of the graph.
      markDiverged(handle.db, "default", "a-version", Date.now());
      const mine = currentGraph();
      const renamed = { ...mine, steps: mine.steps.map((step) => (step.id === "review" ? { ...step, name: "Second opinion" } : step)) };
      expect(savePipeline(handle.db, undefined, renamed).saved).toBe(true);
      const stepNames = () => listStepsForPipeline(handle.db, "default").map((step) => step.name);
      const diverged = stepNames();
      expect(diverged).toContain("Second opinion");

      // The administrator takes the waiver back.
      setWebhookUnattendedCommand(record.db, { pipelineId: "default", unattended: false });
      const outcome = sync().find(([id]) => id === "default")?.[1];

      // Still skipped as a graph: the person's copy stands…
      expect(outcome).toBe("skipped");
      expect(stepNames()).toEqual(diverged);
      // …and the setting, which was never theirs, is the record's.
      expect(unattended()).toBe(false);
      // So their copy no longer publishes past the refusal.
      expect(savePipeline(handle.db, undefined, { ...renamed, steps: renamed.steps }).saved).toBe(false);

      // And on again, the same way.
      setWebhookUnattendedCommand(record.db, { pipelineId: "default", unattended: true });
      sync();
      expect(unattended()).toBe(true);
      expect(stepNames()).toEqual(diverged);
    } finally {
      record.close();
    }
  });

  it("does not sweep away what the administrator chose because a local job changed", () => {
    // The webhook job a managed pipeline's waiver is about lives on the
    // server, so this machine may hold none — and that is not a reason
    // to turn off a setting it does not own.
    const record = openMigratedTestDb();
    try {
      const created = createJob(record.db, {
        projectId: null,
        name: "Support",
        trigger: { kind: "webhook", path: "support", secret: mintWebhookSecret(), mapping: { title: null, body: null, eventKey: null, spec: {} } },
        pipelineId: "default",
        template: { type: "developer:story", title: "A case", body: "" },
      });
      if (!created.ok) throw new Error(created.problem);
      setWebhookUnattendedCommand(record.db, { pipelineId: "default", unattended: true });
      for (const pipeline of listPipelinesUpdatedSince(record.db, { ts: 0, id: "" }, 100)) upsertReplicaPipeline(handle.db, pipeline);
      expect(unattended()).toBe(true);

      const local = listAllJobs(handle.db).find((job) => job.pipelineId === "default" && job.trigger.kind === "webhook")!;
      deleteJob(handle.db, local.id as Uuid);

      expect(unattended()).toBe(true);
    } finally {
      record.close();
    }
  });

  it("takes the administrator's choice from the record, on and off again", () => {
    // The record is another installation: the one place it may be changed.
    const record = openMigratedTestDb();
    try {
      const created = createJob(record.db, {
        projectId: null,
        name: "Support",
        trigger: { kind: "webhook", path: "support", secret: mintWebhookSecret(), mapping: { title: null, body: null, eventKey: null, spec: {} } },
        pipelineId: "default",
        template: { type: "developer:story", title: "A case", body: "" },
      });
      if (!created.ok) throw new Error(created.problem);
      const sync = () => {
        for (const pipeline of listPipelinesUpdatedSince(record.db, { ts: 0, id: "" }, 100)) upsertReplicaPipeline(handle.db, pipeline);
      };

      expect(setWebhookUnattendedCommand(record.db, { pipelineId: "default", unattended: true }).unattended).toBe(true);
      sync();
      expect(unattended()).toBe(true);

      setWebhookUnattendedCommand(record.db, { pipelineId: "default", unattended: false });
      sync();
      expect(unattended()).toBe(false);
    } finally {
      record.close();
    }
  });
});
