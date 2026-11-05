import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModuleManifest, ModuleTestRun } from "@eo/core";
import type { DbHandle } from "../client.js";
import { openMigratedTestDb } from "../testHelpers.js";
import { approveModule, getModule, saveModule } from "./modulesRepo.js";
import {
  addModuleTests,
  batchWithdrewApproval,
  deleteModuleTest,
  getModuleTestResult,
  listModuleTests,
  moduleTestFingerprint,
  moduleTestsWouldChange,
  putModuleTests,
  replaceReplicaModuleTests,
  saveModuleTest,
  storeModuleTestResult,
} from "./moduleTestsRepo.js";
import { listModuleVersions } from "./moduleVersionsRepo.js";

const manifest: ModuleManifest = {
  name: "Deploy",
  description: "Deploys.",
  inputs: {},
  needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
  results: ["deployed"],
};

const RUN: ModuleTestRun = {
  ranAt: 1,
  cases: [],
  coverage: { lines: { covered: 0, total: 1, percent: 0 }, branches: { covered: 0, total: 0, percent: 0 } },
};

describe("moduleTestsRepo", () => {
  let handle: DbHandle;
  let moduleId: string;

  beforeEach(() => {
    handle = openMigratedTestDb();
    const saved = saveModule(handle.db, { slug: "deploy", name: "Deploy", description: "Deploys.", code: "export default async () => ({ ok: true, result: 'deployed' });", manifest });
    if (!saved.ok) throw new Error(saved.reason);
    moduleId = saved.module.id;
  });

  afterEach(() => handle.close());

  it("lists a module's cases in the order they were written", () => {
    saveModuleTest(handle.db, { moduleId, description: "first", source: "a" }, 1);
    saveModuleTest(handle.db, { moduleId, description: "second", source: "b" }, 2);
    expect(listModuleTests(handle.db, moduleId).map((test) => test.description)).toEqual(["first", "second"]);
  });

  it("edits a case in place, keeping when it was written", () => {
    const first = saveModuleTest(handle.db, { moduleId, description: "first", source: "a" }, 1);
    if (!first.ok) throw new Error(first.reason);
    const edited = saveModuleTest(handle.db, { id: first.test.id, moduleId, description: "renamed", source: "b" }, 5);
    expect(edited).toMatchObject({ ok: true, test: { id: first.test.id, description: "renamed", source: "b", createdAt: 1, updatedAt: 5 } });
  });

  it("deletes a case and answers the module it belonged to", () => {
    const first = saveModuleTest(handle.db, { moduleId, description: "first", source: "a" });
    if (!first.ok) throw new Error(first.reason);
    expect(deleteModuleTest(handle.db, first.test.id)).toEqual({ moduleId, approvalWithdrawn: false });
    expect(deleteModuleTest(handle.db, first.test.id)).toBeNull();
    expect(listModuleTests(handle.db, moduleId)).toEqual([]);
  });

  it("keeps one result per module, replaced on every run", () => {
    storeModuleTestResult(handle.db, moduleId, "one", RUN);
    storeModuleTestResult(handle.db, moduleId, "two", { ...RUN, ranAt: 2 });
    expect(getModuleTestResult(handle.db, moduleId)).toEqual({ fingerprint: "two", run: { ...RUN, ranAt: 2 } });
  });

  it("fingerprints the code, the manifest and every case — descriptions included — and nothing else", () => {
    const module = { code: "a", manifest };
    const tests = [{ id: "1", description: "d", source: "s" }];
    const base = moduleTestFingerprint(module, tests);

    expect(moduleTestFingerprint({ code: "a", manifest }, [{ id: "1", description: "d", source: "s" }])).toBe(base);
    expect(moduleTestFingerprint({ code: "b", manifest }, tests)).not.toBe(base);
    expect(moduleTestFingerprint({ code: "a", manifest: { ...manifest, results: ["other"] } }, tests)).not.toBe(base);
    expect(moduleTestFingerprint(module, [{ id: "1", description: "d", source: "t" }])).not.toBe(base);
    expect(moduleTestFingerprint(module, [{ id: "1", description: "e", source: "s" }])).not.toBe(base);
    expect(moduleTestFingerprint(module, [])).not.toBe(base);
  });

  // EO-401: the cases a corrected module arrives with, written onto a module that has some.
  describe("putModuleTests", () => {
    const sources = () => listModuleTests(handle.db, moduleId).map((test) => [test.description, test.source]);

    it("replaces a case of the same description in place, adds a new one, and keeps one it was not given", () => {
      const deploys = saveModuleTest(handle.db, { moduleId, description: "deploys", source: "old" }, 1_000);
      saveModuleTest(handle.db, { moduleId, description: "rolls back", source: "kept" }, 1_001);
      if (!deploys.ok) throw new Error(deploys.reason);

      const results = putModuleTests(
        handle.db,
        moduleId,
        [
          { description: "deploys", source: "new" },
          { description: "refuses a dirty tree", source: "added" },
        ],
        2_000,
      );

      expect(results.every((result) => result.ok)).toBe(true);
      expect(sources()).toEqual([
        ["deploys", "new"],
        ["rolls back", "kept"],
        ["refuses a dirty tree", "added"],
      ]);
      const after = listModuleTests(handle.db, moduleId);
      expect(after[0]).toMatchObject({ id: deploys.test.id, createdAt: 1_000, updatedAt: 2_000 });
      // Untouched, stamp included.
      expect(after[1]).toMatchObject({ updatedAt: 1_001 });
    });

    it("writes nothing over a case that already says the same thing", () => {
      saveModuleTest(handle.db, { moduleId, description: "deploys", source: "same" }, 1_000);

      putModuleTests(handle.db, moduleId, [{ description: "deploys", source: "same" }], 2_000);

      expect(listModuleTests(handle.db, moduleId)).toHaveLength(1);
      expect(listModuleTests(handle.db, moduleId)[0]).toMatchObject({ updatedAt: 1_000 });
    });

    it("says beforehand whether it would write, by the same pairing", () => {
      saveModuleTest(handle.db, { moduleId, description: "deploys", source: "old" }, 1_000);
      saveModuleTest(handle.db, { moduleId, description: "deploys", source: "fixed" }, 1_001);

      // Nothing to write: each given case is the one it would be written over.
      expect(
        moduleTestsWouldChange(handle.db, moduleId, [
          { description: "deploys", source: "old" },
          { description: "deploys", source: "fixed" },
        ]),
      ).toBe(false);
      expect(moduleTestsWouldChange(handle.db, moduleId, [])).toBe(false);
      // The source is on the module, but on the newer case: the older one is what this would rewrite.
      expect(moduleTestsWouldChange(handle.db, moduleId, [{ description: "deploys", source: "fixed" }])).toBe(true);
      // A third of that description, and one of a description it has not got.
      expect(moduleTestsWouldChange(handle.db, moduleId, [{ description: "deploys", source: "old" }, { description: "deploys", source: "fixed" }, { description: "deploys", source: "fixed" }])).toBe(true);
      expect(moduleTestsWouldChange(handle.db, moduleId, [{ description: "rolls back", source: "old" }])).toBe(true);

      putModuleTests(handle.db, moduleId, [{ description: "deploys", source: "fixed" }], 2_000);
      expect(sources()).toEqual([
        ["deploys", "fixed"],
        ["deploys", "fixed"],
      ]);
      expect(moduleTestsWouldChange(handle.db, moduleId, [{ description: "deploys", source: "fixed" }])).toBe(false);
    });

    it("never collapses two given cases of one description into one", () => {
      saveModuleTest(handle.db, { moduleId, description: "deploys", source: "old" }, 1_000);

      putModuleTests(
        handle.db,
        moduleId,
        [
          { description: "deploys", source: "first" },
          { description: "deploys", source: "second" },
        ],
        2_000,
      );

      expect(sources()).toEqual([
        ["deploys", "first"],
        ["deploys", "second"],
      ]);
    });
  });

  // EO-498: any change to an approved module's cases withdraws its approval, through every writer here.
  describe("approval", () => {
    const approvedAt = () => getModule(handle.db, moduleId)!.approvedAt;
    /** An approved module with one case, "deploys". Answers that case's id. */
    function approvedWithACase(): string {
      const seeded = saveModuleTest(handle.db, { moduleId, description: "deploys", source: "a" }, 1_000);
      if (!seeded.ok) throw new Error(seeded.reason);
      approveModule(handle.db, moduleId, 2_000);
      expect(approvedAt()).toBe(2_000);
      return seeded.test.id;
    }

    it("is withdrawn by adding a case, in the same write, and the current version stops recording it", () => {
      approvedWithACase();

      const added = saveModuleTest(handle.db, { moduleId, description: "rolls back", source: "b" }, 3_000);

      expect(added).toMatchObject({ ok: true, approvalWithdrawn: true });
      expect(approvedAt()).toBeNull();
      expect(listModuleVersions(handle.db, moduleId)[0]).toMatchObject({ current: true, approved: false, approvedAt: null });
    });

    it("is withdrawn by editing a case's description or its source, and not by saving it as it is", () => {
      const id = approvedWithACase();

      const same = saveModuleTest(handle.db, { id, moduleId, description: "deploys", source: "a" }, 3_000);
      expect(same).toMatchObject({ ok: true, approvalWithdrawn: false, test: { updatedAt: 1_000 } });
      expect(approvedAt()).toBe(2_000);
      expect(listModuleVersions(handle.db, moduleId)[0]).toMatchObject({ approved: true });

      expect(saveModuleTest(handle.db, { id, moduleId, description: "deploys", source: "changed" }, 3_000)).toMatchObject({ ok: true, approvalWithdrawn: true });
      expect(approvedAt()).toBeNull();

      approveModule(handle.db, moduleId, 4_000);
      expect(saveModuleTest(handle.db, { id, moduleId, description: "renamed", source: "changed" }, 5_000)).toMatchObject({ ok: true, approvalWithdrawn: true });
      expect(approvedAt()).toBeNull();
    });

    it("is withdrawn by deleting a case", () => {
      const id = approvedWithACase();

      expect(deleteModuleTest(handle.db, id, 3_000)).toEqual({ moduleId, approvalWithdrawn: true });
      expect(approvedAt()).toBeNull();
      expect(listModuleVersions(handle.db, moduleId)[0]).toMatchObject({ approved: false });
    });

    it("is not touched, and nothing is said withdrawn, on a module that is not approved", () => {
      const first = saveModuleTest(handle.db, { moduleId, description: "deploys", source: "a" }, 1_000);
      if (!first.ok) throw new Error(first.reason);
      expect(first.approvalWithdrawn).toBe(false);
      expect(saveModuleTest(handle.db, { id: first.test.id, moduleId, description: "deploys", source: "b" })).toMatchObject({ approvalWithdrawn: false });
      expect(batchWithdrewApproval(addModuleTests(handle.db, moduleId, [{ description: "new", source: "c" }]))).toBe(false);
      expect(batchWithdrewApproval(putModuleTests(handle.db, moduleId, [{ description: "deploys", source: "d" }]))).toBe(false);
      expect(deleteModuleTest(handle.db, first.test.id)).toEqual({ moduleId, approvalWithdrawn: false });
      expect(approvedAt()).toBeNull();
    });

    it("is withdrawn by addModuleTests when it adds a case, and left standing when it skips every one as already there", () => {
      approvedWithACase();

      expect(batchWithdrewApproval(addModuleTests(handle.db, moduleId, [{ description: "deploys", source: "a" }]))).toBe(false);
      expect(approvedAt()).toBe(2_000);

      const added = addModuleTests(handle.db, moduleId, [
        { description: "deploys", source: "a" },
        { description: "rolls back", source: "b" },
        { description: "refuses", source: "c" },
      ]);
      // The first write that changed a case is the one that withdrew it.
      expect(added.map((result) => result.ok && result.approvalWithdrawn)).toEqual([true, false]);
      expect(batchWithdrewApproval(added)).toBe(true);
      expect(approvedAt()).toBeNull();
    });

    it("is withdrawn by putModuleTests when it replaces or adds a case, and left standing when each is already as given", () => {
      approvedWithACase();

      expect(batchWithdrewApproval(putModuleTests(handle.db, moduleId, [{ description: "deploys", source: "a" }], 3_000))).toBe(false);
      expect(approvedAt()).toBe(2_000);

      expect(batchWithdrewApproval(putModuleTests(handle.db, moduleId, [{ description: "deploys", source: "fixed" }], 3_000))).toBe(true);
      expect(approvedAt()).toBeNull();
    });

    it("is left as the organisation published it when a replica's cases are replaced", () => {
      const id = approvedWithACase();

      replaceReplicaModuleTests(handle.db, moduleId, [{ id: "published-1", description: "published", source: "p", createdAt: 1, updatedAt: 1 }]);

      expect(listModuleTests(handle.db, moduleId).map((test) => test.id)).toEqual(["published-1"]);
      expect(listModuleTests(handle.db, moduleId).some((test) => test.id === id)).toBe(false);
      expect(approvedAt()).toBe(2_000);
      expect(listModuleVersions(handle.db, moduleId)[0]).toMatchObject({ approved: true });
    });
  });
});
