import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uuidv7, type EntryRule, type ModuleManifest, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createTestItem, messagesFrom, openMigratedTestDb } from "../db/testHelpers.js";
import {
  approveModule,
  archivePipeline,
  createPipeline,
  currentVersion,
  getItem,
  getPipeline,
  listPipelineVersions,
  listStepsForPipeline,
  publishSection,
  replacePipelineGraph,
  restoreModuleVersion,
  saveModule,
  saveModuleTest,
  stepForItem,
  versionAuthorName,
  versionSnapshot,
  getModuleBySlug,
  recordPipelineOrigin,
  getModule,
  listModuleTests,
  moduleTestFingerprint,
} from "../db/repos/index.js";
import { markTrialPipeline } from "../db/repos/trialsRepo.js";
import { loadTemplateHistory, type TemplateVersion } from "../gallery/history.js";
import { compareWithTemplate } from "../gallery/templateUpdates.js";
import { approveModuleCommand } from "../ipc/moduleCommands.js";
import { followApprovedModule, MODULE_UPDATE_HELD_SOURCE } from "./followApproved.js";

/**
 * Approving a module version moves every pipeline that pins an older one
 * to a new pipeline version (EO-771).
 */

const manifest: ModuleManifest = {
  name: "Notify",
  description: "Tells the channel.",
  inputs: {},
  needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
  results: ["sent", "failed"],
};

const gateManifest: ModuleManifest = {
  name: "Gate",
  description: "Lets work in.",
  inputs: {},
  needs: { bin: [], env: [], network: false, item: true, comment: false, attach: false, create: false },
  results: ["pass", "refuse"],
  entryCheck: true,
};

const code = (word: string) => `export default async function run() { return { ok: true, result: "sent", detail: "${word}" }; }`;

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

/** A module at v3, every version approved, and its slug's id. */
function module(slug = "notify", name = "Notify", shape: ModuleManifest = manifest): string {
  let id: string | undefined;
  for (const word of ["v1", "v2", "v3"]) {
    const saved = saveModule(handle.db, { ...(id === undefined ? {} : { id }), slug, name, description: shape.description, code: code(word), manifest: shape, approve: true });
    if (!saved.ok) throw new Error(saved.reason);
    id = saved.module.id;
  }
  return id!;
}

/** Saves an edit (filing the next version, unapproved), optionally with another manifest. */
function edit(id: string, word: string, shape: ModuleManifest = manifest): void {
  const saved = saveModule(handle.db, { id, slug: getSlug(id), name: getModule(handle.db, id)?.name ?? "", description: shape.description, code: code(word), manifest: shape });
  if (!saved.ok) throw new Error(saved.reason);
}

function getSlug(id: string): string {
  return getModule(handle.db, id)?.slug ?? "";
}

/** A pipeline whose first step runs the module at `pin`, routing each result to a terminal step. */
function board(name: string, prefix: string, moduleId: string, pin: number, rules: EntryRule[] = []): string {
  const pipeline = createPipeline(handle.db, { projectId: null, name });
  const id = pipeline.id as Uuid;
  const written = replacePipelineGraph(
    handle.db,
    id,
    [
      { id: `${prefix}_notify`, pipelineId: id, position: 0, name: "Notify", type: "module", entryAction: moduleId, moduleVersion: pin },
      { id: `${prefix}_done`, pipelineId: id, position: 1, name: "Done", type: "user", isTerminal: true },
    ],
    [
      { pipelineId: id, fromStepId: `${prefix}_notify`, resultKey: "sent", label: "Sent", target: `${prefix}_done` },
      { pipelineId: id, fromStepId: `${prefix}_notify`, resultKey: "failed", label: "Failed", target: `${prefix}_done` },
    ],
    { entryStepId: `${prefix}_notify`, entryRules: rules },
  );
  if (!written.replaced) throw new Error("not written");
  return pipeline.id;
}

const pinOf = (pipelineId: string, stepId: string) => listStepsForPipeline(handle.db, pipelineId).find((step) => step.id === stepId)?.moduleVersion;
const versionCount = (pipelineId: string) => listPipelineVersions(handle.db, pipelineId).length;
const newest = (pipelineId: string) => listPipelineVersions(handle.db, pipelineId).at(-1)!;

function approveV4(id: string, word = "v4", shape: ModuleManifest = manifest, isTheRecord = false) {
  edit(id, word, shape);
  approveModule(handle.db, id);
  return followApprovedModule(handle.db, id, { isTheRecord });
}

describe("approving a module version", () => {
  it("files one version on each pipeline pinning an older one, pinning the new one, its notes and author the update's", () => {
    const id = module();
    const a = board("Alpha", "fa", id, 3);
    const b = board("Beta", "fb", id, 3);
    const before = [versionCount(a), versionCount(b)];

    const results = approveV4(id);

    expect(results.map((result) => result.outcome)).toEqual(["moved", "moved"]);
    for (const [index, pipelineId] of [a, b].entries()) {
      expect(versionCount(pipelineId)).toBe(before[index]! + 1);
      const filed = newest(pipelineId);
      expect(currentVersion(handle.db, pipelineId)?.id).toBe(filed.id);
      expect(filed.releaseNotes).toBe("Notify v3 → v4");
      expect(filed.createdBy).toBe("module:notify@4");
      expect(versionAuthorName(filed.createdBy, () => null, (slug) => getModuleBySlug(handle.db, slug)?.name ?? null)).toBe("the Notify v4 update");
      expect(versionSnapshot(handle.db, filed.id)?.steps.find((step) => step.type === "module")?.moduleVersion).toBe(4);
    }
    expect(pinOf(a, "fa_notify")).toBe(4);
    expect(pinOf(b, "fb_notify")).toBe(4);
  });

  it("leaves alone pipelines on the approved version or newer, trials, archived ones and those that do not use the module", () => {
    const id = module();
    const other = module("other", "Other");
    const current = board("Current", "fc", id, 3);
    const trial = board("Trial", "ft", id, 3);
    markTrialPipeline(handle.db, trial, { conversationId: "c", targetPipelineId: null });
    const archived = board("Archived", "fr", id, 3);
    archivePipeline(handle.db, archived);
    const unrelated = board("Unrelated", "fu", other, 3);
    edit(id, "v4");
    approveModule(handle.db, id);
    // `current` already pins v4.
    replacePipelineGraph(
      handle.db,
      current,
      listStepsForPipeline(handle.db, current).map((step) => (step.type === "module" ? { ...step, moduleVersion: 4 } : step)),
      [
        { pipelineId: current as Uuid, fromStepId: "fc_notify", resultKey: "sent", label: "Sent", target: "fc_done" },
        { pipelineId: current as Uuid, fromStepId: "fc_notify", resultKey: "failed", label: "Failed", target: "fc_done" },
      ],
    );
    const counts = [current, trial, archived, unrelated].map(versionCount);

    expect(followApprovedModule(handle.db, id, { isTheRecord: false })).toEqual([]);
    expect([current, trial, archived, unrelated].map(versionCount)).toEqual(counts);
    expect(pinOf(trial, "ft_notify")).toBe(3);
    expect(pinOf(unrelated, "fu_notify")).toBe(3);
  });

  it("moves a pipeline that pins the module only through a module entry rule", () => {
    const gate = module("gate", "Gate", gateManifest);
    // Its one step runs another module; the gate is only at its door.
    const pipelineId = board("Door", "fd", module("other", "Other"), 3, [{ kind: "module", module: gate, moduleVersion: 3 }]);
    const before = versionCount(pipelineId);

    edit(gate, "v4", gateManifest);
    approveModule(handle.db, gate);
    const results = followApprovedModule(handle.db, gate, { isTheRecord: false });

    expect(results).toEqual([expect.objectContaining({ pipelineId, outcome: "moved", from: [3], to: 4 })]);
    expect(versionCount(pipelineId)).toBe(before + 1);
    expect(getPipeline(handle.db, pipelineId)?.entryRules).toEqual([expect.objectContaining({ kind: "module", module: gate, moduleVersion: 4 })]);
    expect(versionSnapshot(handle.db, newest(pipelineId).id)?.entryRules).toEqual([expect.objectContaining({ moduleVersion: 4 })]);
    expect(newest(pipelineId).releaseNotes).toBe("Gate v3 → v4");
  });

  it("keeps items in flight bound to the version they entered on, which pins the old module version", () => {
    const id = module();
    const pipelineId = board("Alpha", "fi", id, 3);
    const item = createTestItem(handle.db, { type: "story", title: "In flight", pipelineId: pipelineId as Uuid, stepId: "fi_notify" });
    const entered = getItem(handle.db, item.id)!.pipelineVersionId;
    expect(entered).not.toBeNull();

    approveV4(id);

    const after = getItem(handle.db, item.id)!;
    expect(after.pipelineVersionId).toBe(entered);
    expect(currentVersion(handle.db, pipelineId)?.id).not.toBe(entered);
    expect(stepForItem(handle.db, after)?.moduleVersion).toBe(3);
  });

  it("moves pipelines to the version a restore files once it is approved", () => {
    const id = module();
    const pipelineId = board("Alpha", "fs", id, 3);
    edit(id, "v4");
    // v1's code comes back as v5.
    const restored = restoreModuleVersion(handle.db, id, 1);
    expect(restored).toEqual({ ok: true, number: 5 });
    approveModule(handle.db, id);
    followApprovedModule(handle.db, id, { isTheRecord: false });

    expect(pinOf(pipelineId, "fs_notify")).toBe(5);
    expect(newest(pipelineId).releaseNotes).toBe("Notify v3 → v5");
    expect(newest(pipelineId).createdBy).toBe("module:notify@5");
  });

  it("holds a pipeline the new version does not fit, says why in a message, and still moves the others", () => {
    const id = module();
    const fits = board("Fits", "fo", id, 3);
    const routed = createPipeline(handle.db, { projectId: null, name: "Routes failed" });
    const rid = routed.id as Uuid;
    replacePipelineGraph(
      handle.db,
      rid,
      [
        { id: "fx_notify", pipelineId: rid, position: 0, name: "Notify", type: "module", entryAction: id, moduleVersion: 3 },
        { id: "fx_done", pipelineId: rid, position: 1, name: "Done", type: "user", isTerminal: true },
      ],
      [
        { pipelineId: rid, fromStepId: "fx_notify", resultKey: "sent", label: "Sent", target: "fx_done" },
        { pipelineId: rid, fromStepId: "fx_notify", resultKey: "failed", label: "Failed", target: "fx_done" },
      ],
      { entryStepId: "fx_notify" },
    );
    // `fits` stops routing `failed`, so v4 dropping it fits there and not on `routed`.
    replacePipelineGraph(
      handle.db,
      fits,
      listStepsForPipeline(handle.db, fits),
      [{ pipelineId: fits as Uuid, fromStepId: "fo_notify", resultKey: "sent", label: "Sent", target: "fo_done" }],
    );
    const before = versionCount(rid);

    const results = approveV4(id, "v4", { ...manifest, results: ["sent"] });

    expect(results).toEqual([
      expect.objectContaining({ pipelineId: fits, outcome: "moved" }),
      expect.objectContaining({ pipelineId: rid, outcome: "held", from: [3], to: 4 }),
    ]);
    expect(pinOf(rid, "fx_notify")).toBe(3);
    expect(versionCount(rid)).toBe(before);
    expect(pinOf(fits, "fo_notify")).toBe(4);
    const [message] = messagesFrom(handle.db, MODULE_UPDATE_HELD_SOURCE);
    expect(message?.handledAt).toBeNull();
    expect(message?.body).toContain("**Routes failed** stays on Notify v3");
    expect(message?.body).toContain("Notify v4");
    const held = results.find((result) => result.outcome === "held");
    expect(held?.outcome === "held" && held.problems.length).toBeGreaterThan(0);
    for (const problem of held?.outcome === "held" ? held.problems : []) expect(message?.body).toContain(problem);
  });

  it("on a desktop files nothing for a pipeline the organisation's record publishes; the record files it", () => {
    const id = module();
    const pipelineId = board("Alpha", "fp", id, 3);
    publishSection(handle.db, { section: "pipelines", subjectId: "default", publishedAt: Date.now() });
    const before = versionCount(pipelineId);

    expect(approveV4(id, "v4", manifest, false)).toEqual([]);
    expect(versionCount(pipelineId)).toBe(before);
    expect(pinOf(pipelineId, "fp_notify")).toBe(3);

    // The same database as the record sees it.
    expect(followApprovedModule(handle.db, id, { isTheRecord: true })).toEqual([expect.objectContaining({ pipelineId, outcome: "moved" })]);
    expect(pinOf(pipelineId, "fp_notify")).toBe(4);
  });

  it("moves pipelines through module_approve's command, in the approval's transaction", async () => {
    const id = module();
    const pipelineId = board("Alpha", "fm", id, 3);
    const test = saveModuleTest(handle.db, { moduleId: id, description: "sends", source: "export default async function () {}" });
    if (!test.ok) throw new Error(test.reason);
    edit(id, "v4");
    const runner = {
      run: async (moduleId: string) => {
        const now = getModule(handle.db, moduleId)!;
        return {
          fingerprint: moduleTestFingerprint(now, listModuleTests(handle.db, moduleId)),
          problem: null,
          run: {
            ranAt: Date.now(),
            cases: [{ testId: "t", description: "sends", passed: true, failure: null, durationMs: 1, output: "" }],
            coverage: { lines: { covered: 100, total: 100, percent: 100 }, branches: { covered: 1, total: 1, percent: 100 } },
          },
        } as const;
      },
    };

    const answer = await approveModuleCommand(handle.db, runner, { id, acknowledgeLowCoverage: false });

    expect(answer.approved).toBe(true);
    expect(pinOf(pipelineId, "fm_notify")).toBe(4);
    expect(newest(pipelineId).releaseNotes).toBe("Notify v3 → v4");
  });
});

/**
 * A pipeline made from a template (§15.5): the version an approval files
 * is the person's change in the next three-way comparison, and a pin it
 * moved is no conflict where the template did not change that step's
 * module.
 */
describe("a moved pin on a pipeline made from a template", () => {
  const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");

  it("compares cleanly against a template version that changed something else about the step", () => {
    const id = module();
    const v10 = loadTemplateHistory(GALLERY_DIRECTORY).get("software-feature-to-merge")!.find((each) => each.version === "1.0")!;
    const first = v10.document.steps[0]!;
    // The template with a Notify step, by slug, routing `sent` and `failed` to Done; `label` is what the next version changes.
    const withNotify = (label: string): TemplateVersion["document"] => ({
      ...v10.document,
      steps: [...v10.document.steps, { ...first, id: "tpl_notify", name: "Notify", type: "module", entryAction: "notify", ownerRole: null, isTerminal: false, position: v10.document.steps.length }],
      routes: [
        ...v10.document.routes,
        { ...v10.document.routes[0]!, fromStepId: "tpl_notify", resultKey: "sent", label, target: "ready_to_merge" },
        { ...v10.document.routes[0]!, fromStepId: "tpl_notify", resultKey: "failed", label: "Failed", target: "ready_to_merge" },
      ],
    });
    const base = withNotify("Sent");

    // Installed under ids of its own, the Notify step pinning v3.
    const copy = createPipeline(handle.db, { projectId: null, name: "From the template" });
    const ids = new Map(base.steps.map((step) => [step.id, uuidv7() as string]));
    const local = (stepId: string): string => ids.get(stepId) ?? stepId;
    const installed = replacePipelineGraph(
      handle.db,
      copy.id,
      base.steps.map((step) => ({
        ...step,
        id: local(step.id),
        pipelineId: copy.id as Uuid,
        ...(step.type === "module" ? { entryAction: id, moduleVersion: 3 } : {}),
      })),
      base.routes.map((route) => ({ ...route, pipelineId: copy.id as Uuid, fromStepId: local(route.fromStepId), target: local(route.target) })),
      { entryStepId: local(v10.document.pipeline.entryStepId ?? "worktree") },
    );
    expect(installed.replaced).toBe(true);
    recordPipelineOrigin(handle.db, { pipelineId: copy.id, document: base, stepIds: Object.fromEntries(ids) });

    expect(approveV4(id)).toEqual([expect.objectContaining({ pipelineId: copy.id, outcome: "moved" })]);
    expect(pinOf(copy.id, local("tpl_notify"))).toBe(4);

    const compared = compareWithTemplate(handle.db, copy.id, { slug: "software-feature-to-merge", version: "1.0.1", notes: "", document: withNotify("Notified") });

    expect(compared?.merge.ok).toBe(true);
    expect(compared?.merge.comparison.conflicts).toEqual([]);
    // The template's change is taken, and the pin stays the person's.
    const merged = compared?.merge.ok === true ? compared.merge.merged : undefined;
    expect(merged?.steps.find((step) => step.id === local("tpl_notify"))?.moduleVersion).toBe(4);
    expect(merged?.routes.find((route) => route.fromStepId === local("tpl_notify") && route.resultKey === "sent")?.label).toBe("Notified");
  });
});
