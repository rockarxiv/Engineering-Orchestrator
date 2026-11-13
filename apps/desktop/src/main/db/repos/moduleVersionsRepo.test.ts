import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModuleManifest } from "@eo/core";
import type { DbHandle } from "../client.js";
import { eq } from "drizzle-orm";
import { openMigratedTestDb } from "../testHelpers.js";
import { pipelines, pipelineSteps } from "../schema.js";
import { createPipeline, createStep } from "./pipelineStepsRepo.js";
import { createPipelineVersion } from "./pipelineVersionsRepo.js";
import { approveModule, getModule, saveModule, upsertReplicaModule } from "./modulesRepo.js";
import { deleteModuleTest, listModuleTests, saveModuleTest } from "./moduleTestsRepo.js";
import {
  getModuleVersion,
  listModuleVersions,
  moduleVersionsToKeep,
  pinnedModuleVersions,
  pruneModuleVersions,
  restoreModuleVersion,
  setModuleVersionsToKeep,
} from "./moduleVersionsRepo.js";

/** A module's history (EO-360). */

const manifest: ModuleManifest = {
  name: "Deploy",
  description: "Deploys.",
  inputs: {},
  needs: { bin: ["flyctl"], env: [], network: true, item: false, comment: false, attach: false, create: false },
  results: ["deployed", "failed"],
};

const code = (n: number) => `export default async function run() { return { ok: true, result: 'deployed', detail: '${n}' }; }`;

let handle: DbHandle;
let clock: number;

beforeEach(() => {
  handle = openMigratedTestDb();
  clock = 1_000;
});

afterEach(() => {
  handle.close();
});

function tick(): number {
  clock += 1_000;
  return clock;
}

function create(): string {
  const saved = saveModule(handle.db, { slug: "deploy", name: "Deploy", description: "Deploys.", code: code(1), manifest }, tick());
  if (!saved.ok) throw new Error(saved.reason);
  return saved.module.id;
}

function save(id: string, changes: Partial<{ name: string; description: string; slug: string; code: string; manifest: ModuleManifest }>): void {
  const module = getModule(handle.db, id)!;
  const saved = saveModule(
    handle.db,
    {
      id,
      slug: changes.slug ?? module.slug,
      name: changes.name ?? module.name,
      description: changes.description ?? module.description,
      code: changes.code ?? module.code,
      manifest: changes.manifest ?? module.manifest,
    },
    tick(),
  );
  if (!saved.ok) throw new Error(saved.reason);
}

function addCase(moduleId: string, description: string): string {
  const saved = saveModuleTest(handle.db, { moduleId, description, source: `// ${description}` }, tick());
  if (!saved.ok) throw new Error(saved.reason);
  return saved.test.id;
}

const numbers = (moduleId: string) => listModuleVersions(handle.db, moduleId).map((version) => version.number);

describe("filing a version", () => {
  it("files v1 when a module is created, holding its name, description, code, manifest and cases", () => {
    const id = create();
    const v1 = getModuleVersion(handle.db, id, 1)!;
    expect(v1).toMatchObject({ number: 1, name: "Deploy", description: "Deploys.", code: code(1), manifest, current: true, approved: false, tests: [] });
  });

  it("files a new version when the code or the manifest changes, and none for a name, description or slug", () => {
    const id = create();
    save(id, { name: "Deploy to staging", description: "Deploys to staging.", slug: "deploy-staging" });
    expect(numbers(id)).toEqual([1]);

    save(id, { code: code(2) });
    expect(numbers(id)).toEqual([2, 1]);
    save(id, { manifest: { ...manifest, results: ["deployed"] } });
    expect(numbers(id)).toEqual([3, 2, 1]);

    const v2 = getModuleVersion(handle.db, id, 2)!;
    expect(v2).toMatchObject({ name: "Deploy to staging", description: "Deploys to staging.", code: code(2), manifest, current: false });
    expect(getModuleVersion(handle.db, id, 3)?.manifest.results).toEqual(["deployed"]);
  });

  it("leaves each version holding the cases as they were just before the save that replaced it", () => {
    const id = create();
    const kept = addCase(id, "deploys");
    const dropped = addCase(id, "reports a failure");
    save(id, { code: code(2) });

    // v2 is current; editing, adding and deleting its cases…
    saveModuleTest(handle.db, { id: kept, moduleId: id, description: "deploys once", source: "// deploys once" }, tick());
    deleteModuleTest(handle.db, dropped);
    addCase(id, "retries");
    // …is what v2 is seen holding while it is current…
    expect(getModuleVersion(handle.db, id, 2)?.tests.map((test) => test.description)).toEqual(["deploys once", "retries"]);
    const before = listModuleTests(handle.db, id).map((test) => ({ id: test.id, description: test.description, source: test.source }));

    save(id, { code: code(3) });
    addCase(id, "added after v3");

    // …and exactly what v2 holds once v3 replaced it, whatever v3 does next.
    expect(getModuleVersion(handle.db, id, 2)?.tests.map((test) => ({ id: test.id, description: test.description, source: test.source }))).toEqual(before);
    // v1 still has what went with v1's code.
    expect(getModuleVersion(handle.db, id, 1)?.tests.map((test) => test.description)).toEqual(["deploys", "reports a failure"]);
    expect(listModuleVersions(handle.db, id).map((version) => version.testCount)).toEqual([3, 2, 2]);
  });

  it("files a version when the organisation's publication changes a replica's code", () => {
    const published = { id: "m-org", slug: "org", name: "Org", description: "From the org.", code: code(1), manifest, originalScript: null, source: "user", approvedAt: 5, createdAt: 1, updatedAt: 2, archivedAt: null };
    upsertReplicaModule(handle.db, published);
    upsertReplicaModule(handle.db, published);
    expect(listModuleVersions(handle.db, "m-org")).toMatchObject([{ number: 1, approved: true, current: true }]);

    upsertReplicaModule(handle.db, { ...published, code: code(2), approvedAt: null, updatedAt: 3 });
    expect(listModuleVersions(handle.db, "m-org")).toMatchObject([
      { number: 2, approved: false, current: true },
      { number: 1, approved: true, current: false },
    ]);
  });
});

describe("approving", () => {
  it("marks the version current at that moment as approved, and an edit leaves it so while the module is not", () => {
    const id = create();
    save(id, { code: code(2) });
    approveModule(handle.db, id, tick());

    expect(listModuleVersions(handle.db, id).map((version) => [version.number, version.approved])).toEqual([
      [2, true],
      [1, false],
    ]);

    save(id, { code: code(3) });
    expect(getModule(handle.db, id)?.approvedAt).toBeNull();
    expect(listModuleVersions(handle.db, id).map((version) => [version.number, version.approved])).toEqual([
      [3, false],
      [2, true],
      [1, false],
    ]);
  });

  it("stops recording the current version as approved once a change to the test cases withdraws it, until it is approved again (EO-498)", () => {
    const id = create();
    const first = addCase(id, "deploys");
    approveModule(handle.db, id, tick());
    expect(listModuleVersions(handle.db, id)[0]).toMatchObject({ number: 1, current: true, approved: true });

    addCase(id, "rolls back");
    expect(getModule(handle.db, id)?.approvedAt).toBeNull();
    expect(listModuleVersions(handle.db, id)).toEqual([expect.objectContaining({ number: 1, current: true, approved: false, approvedAt: null })]);

    approveModule(handle.db, id, tick());
    expect(listModuleVersions(handle.db, id)[0]).toMatchObject({ number: 1, approved: true });

    deleteModuleTest(handle.db, first, tick());
    expect(listModuleVersions(handle.db, id)[0]).toMatchObject({ number: 1, approved: false });

    // Filed once the code moves, it keeps the cases it ended with and says it was not approved with them.
    save(id, { code: code(2) });
    expect(getModuleVersion(handle.db, id, 1)).toMatchObject({ approved: false, tests: [expect.objectContaining({ description: "rolls back" })] });
  });
});

describe("restoring a version", () => {
  it("puts back the code, manifest and cases as a new version above every number, leaving the restored one unchanged", () => {
    const id = create();
    const original = addCase(id, "deploys");
    save(id, { code: code(2), manifest: { ...manifest, results: ["deployed"] }, name: "Renamed" });
    deleteModuleTest(handle.db, original);
    addCase(id, "v2's case");
    const v1Before = getModuleVersion(handle.db, id, 1);

    const restored = restoreModuleVersion(handle.db, id, 1, tick());
    expect(restored).toEqual({ ok: true, number: 3 });

    const module = getModule(handle.db, id)!;
    expect(module.code).toBe(code(1));
    expect(module.manifest).toEqual(manifest);
    // The name is the module's own, not v1's.
    expect(module.name).toBe("Renamed");
    expect(listModuleTests(handle.db, id).map((test) => [test.id, test.description])).toEqual([[original, "deploys"]]);

    expect(getModuleVersion(handle.db, id, 1)).toEqual({ ...v1Before, current: false });
    expect(getModuleVersion(handle.db, id, 2)?.tests.map((test) => test.description)).toEqual(["v2's case"]);
    expect(getModuleVersion(handle.db, id, 3)).toMatchObject({ current: true, code: code(1), manifest, name: "Renamed", tests: [{ id: original, description: "deploys" }] });
  });

  it("comes back approved when a kept approved version has exactly that code and manifest", () => {
    const id = create();
    approveModule(handle.db, id, tick());
    save(id, { code: code(2) });
    expect(getModule(handle.db, id)?.approvedAt).toBeNull();

    restoreModuleVersion(handle.db, id, 1, tick());
    expect(getModule(handle.db, id)?.approvedAt).not.toBeNull();
    expect(listModuleVersions(handle.db, id)[0]).toMatchObject({ number: 3, approved: true, current: true });
  });

  it("comes back unapproved when no kept version with that code and manifest was approved", () => {
    const id = create();
    save(id, { code: code(2) });
    approveModule(handle.db, id, tick());

    restoreModuleVersion(handle.db, id, 1, tick());
    expect(getModule(handle.db, id)?.approvedAt).toBeNull();
    expect(listModuleVersions(handle.db, id)[0]).toMatchObject({ number: 3, approved: false });
  });

  it("does not count an approval on the same code and manifest with different test cases (EO-498)", () => {
    const id = create();
    addCase(id, "deploys");
    approveModule(handle.db, id, tick());
    // v2 adds a case, then v3 is v1's code and manifest again — with v2's two cases, which no approval ran.
    save(id, { code: code(2) });
    addCase(id, "rolls back");
    save(id, { code: code(1) });
    save(id, { code: code(2) });
    expect(getModuleVersion(handle.db, id, 3)?.tests.map((test) => test.description)).toEqual(["deploys", "rolls back"]);

    restoreModuleVersion(handle.db, id, 3, tick());
    expect(getModule(handle.db, id)?.approvedAt).toBeNull();
    expect(listModuleVersions(handle.db, id)[0]).toMatchObject({ number: 5, approved: false });

    // v1 itself, with the one case it was approved with, still comes back approved.
    restoreModuleVersion(handle.db, id, 1, tick());
    expect(getModule(handle.db, id)?.approvedAt).not.toBeNull();
    expect(listModuleVersions(handle.db, id)[0]).toMatchObject({ number: 6, approved: true });
  });

  it("does not count an approval on the same code under a different manifest", () => {
    const id = create();
    save(id, { manifest: { ...manifest, results: ["deployed"] } });
    approveModule(handle.db, id, tick());
    save(id, { code: code(2) });

    restoreModuleVersion(handle.db, id, 1, tick());
    expect(getModule(handle.db, id)?.approvedAt).toBeNull();
  });

  it("no longer counts an approved version once it has been pruned", () => {
    const id = create();
    approveModule(handle.db, id, tick());
    save(id, { code: code(2) });
    save(id, { code: code(3) });
    // An unapproved copy of v1's code, kept after v1 itself is gone.
    save(id, { code: code(1) });
    expect(getModule(handle.db, id)?.approvedAt).toBeNull();
    pruneModuleVersions(handle.db, id, 3);
    expect(numbers(id)).toEqual([4, 3, 2]);

    restoreModuleVersion(handle.db, id, 2, tick());
    restoreModuleVersion(handle.db, id, 4, tick());
    expect(getModule(handle.db, id)?.approvedAt).toBeNull();
  });

  it("refuses the current version, a version the module does not have, and a deleted module", () => {
    const id = create();
    save(id, { code: code(2) });
    expect(restoreModuleVersion(handle.db, id, 2)).toMatchObject({ ok: false, reason: expect.stringContaining("already") });
    expect(restoreModuleVersion(handle.db, id, 9)).toMatchObject({ ok: false, reason: expect.stringContaining("no v9") });
    expect(restoreModuleVersion(handle.db, "nope", 1)).toEqual({ ok: false, reason: "That module no longer exists." });
    expect(numbers(id)).toEqual([2, 1]);
  });
});

describe("retention", () => {
  it("keeps twenty by default and reads back what was set", () => {
    expect(moduleVersionsToKeep(handle.db)).toBe(20);
    setModuleVersionsToKeep(handle.db, 3);
    expect(moduleVersionsToKeep(handle.db)).toBe(3);
    expect(() => setModuleVersionsToKeep(handle.db, 0)).toThrow();
  });

  it("at three, after five code saves keeps the three newest, never the current one deleted and no number reused", () => {
    setModuleVersionsToKeep(handle.db, 3);
    const id = create();
    for (let n = 2; n <= 5; n += 1) save(id, { code: code(n) });
    expect(numbers(id)).toEqual([5, 4, 3]);
    expect(listModuleVersions(handle.db, id)[0]?.current).toBe(true);

    // A limit of one still keeps the current version, and the next save
    // numbers above every number used, deleted ones included.
    setModuleVersionsToKeep(handle.db, 1);
    save(id, { name: "Renamed" });
    expect(numbers(id)).toEqual([5, 4, 3]);
    save(id, { code: code(6) });
    expect(numbers(id)).toEqual([6]);
    restoreModuleVersion(handle.db, id, 6, tick());
    save(id, { code: code(7) });
    expect(numbers(id)).toEqual([7]);
    expect(getModuleVersion(handle.db, id, 7)?.code).toBe(code(7));
  });

  it("applies to a restore like any save", () => {
    setModuleVersionsToKeep(handle.db, 2);
    const id = create();
    save(id, { code: code(2) });
    restoreModuleVersion(handle.db, id, 1, tick());
    expect(numbers(id)).toEqual([3, 2]);
  });
});

/**
 * A version a pipeline pins is never pruned (EO-770): a live step, a live
 * entry rule or a kept pipeline version runs it, and a pin on a version
 * that has gone is code nothing can load.
 */
describe("retention of pinned versions", () => {
  it("keeps every version a live step, a live entry rule or a kept pipeline version pins, past the keep count", () => {
    const id = create();
    for (const n of [2, 3]) save(id, { code: code(n) });

    // v1 pinned by a live step.
    const live = createPipeline(handle.db, { name: "Live", position: 1 });
    createStep(handle.db, { pipelineId: live.id, position: 0, name: "Deploy", type: "module", entryAction: id, moduleVersion: 1 });
    // v2 pinned by a live entry rule.
    handle.db.update(pipelines).set({ entryRules: [{ kind: "module", module: id, moduleVersion: 2 }] }).where(eq(pipelines.id, live.id)).run();
    // v3 pinned only by a kept pipeline version: the live step has moved on since.
    const kept = createPipeline(handle.db, { name: "Kept", position: 2 });
    const step = createStep(handle.db, { pipelineId: kept.id, position: 0, name: "Deploy", type: "module", entryAction: id, moduleVersion: 3 });
    createPipelineVersion(handle.db, kept.id, null);
    handle.db.update(pipelineSteps).set({ moduleVersion: 1 }).where(eq(pipelineSteps.id, step.id)).run();

    expect([...pinnedModuleVersions(handle.db, id)].sort()).toEqual([1, 2, 3]);

    setModuleVersionsToKeep(handle.db, 2);
    for (const n of [4, 5, 6, 7]) save(id, { code: code(n) });

    // The two newest, and the three pinned, whatever the count says.
    expect(numbers(id)).toEqual([7, 6, 3, 2, 1]);
    expect(pruneModuleVersions(handle.db, id, 1)).toEqual([6]);
    expect(numbers(id)).toEqual([7, 3, 2, 1]);
  });
});
