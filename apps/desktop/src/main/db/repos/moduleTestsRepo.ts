import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { uuidv7 } from "@eo/core";
import type { CustomModule, ModuleTestCase, ModuleTestRun } from "@eo/core";
import type { Db } from "../client.js";
import { moduleTestResults, moduleTests, modules } from "../schema.js";
import { withdrawCurrentVersionApproval } from "./moduleVersionsRepo.js";

/**
 * A module's test cases and the latest result of running them (EO-352).
 */

function toCase(row: typeof moduleTests.$inferSelect): ModuleTestCase {
  return {
    id: row.id,
    moduleId: row.moduleId,
    description: row.description,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A module's cases, oldest first — the order they were written in, and the order they run in. */
export function listModuleTests(db: Db, moduleId: string): ModuleTestCase[] {
  return db.select().from(moduleTests).where(eq(moduleTests.moduleId, moduleId)).orderBy(asc(moduleTests.createdAt), asc(moduleTests.id)).all().map(toCase);
}

export function getModuleTest(db: Db, id: string): ModuleTestCase | undefined {
  const row = db.select().from(moduleTests).where(eq(moduleTests.id, id)).get();
  return row ? toCase(row) : undefined;
}

export interface SaveModuleTestInput {
  /** Absent creates; present edits that case in place. */
  id?: string;
  moduleId: string;
  description: string;
  source: string;
}

/**
 * `approvalWithdrawn` is whether this write took the module's approval
 * away (EO-498): true only when the module was approved and the write
 * changed a case.
 */
export type SaveModuleTestResult = { ok: true; test: ModuleTestCase; approvalWithdrawn: boolean } | { ok: false; reason: string };

/**
 * Withdraws an approved module's approval because its test cases have
 * just changed (EO-498), and says whether there was one to withdraw.
 *
 * An approval is of a body of code *and the cases it was approved
 * with*: approving is what runs them, so a case added, edited or removed
 * since is one nobody has seen pass. The current version stops recording
 * itself as approved too, so the module's history does not go on saying
 * otherwise.
 *
 * Called by every write here that changes a case, in the same
 * transaction as that write. Not by `replaceReplicaModuleTests`: a
 * replica's approval is the organisation's publication, not this
 * machine's to take back.
 */
function withdrawApprovalForTestChange(db: Db, moduleId: string, now: number): boolean {
  const module = db.select({ approvedAt: modules.approvedAt }).from(modules).where(eq(modules.id, moduleId)).get();
  if (!module || module.approvedAt === null) return false;
  db.update(modules).set({ approvedAt: null, updatedAt: now }).where(eq(modules.id, moduleId)).run();
  withdrawCurrentVersionApproval(db, moduleId);
  return true;
}

/**
 * Creates or edits one case.
 *
 * A case belongs to one module for its whole life: editing one through
 * another module's id is refused rather than moved, because a case is
 * written against a particular module's `ctx` and results.
 *
 * Any change to an approved module's cases withdraws its approval, in
 * the same write (EO-498). Editing a case to the description and source
 * it already has changes nothing, writes nothing, and leaves the
 * approval standing.
 */
export function saveModuleTest(db: Db, input: SaveModuleTestInput, now: number = Date.now()): SaveModuleTestResult {
  const module = db.select({ id: modules.id, archivedAt: modules.archivedAt }).from(modules).where(eq(modules.id, input.moduleId)).get();
  if (!module) return { ok: false, reason: "That module no longer exists." };
  if (module.archivedAt !== null) return { ok: false, reason: "That module has been deleted." };

  if (input.id !== undefined) {
    const existing = getModuleTest(db, input.id);
    if (!existing) return { ok: false, reason: `No test case ${input.id}.` };
    if (existing.moduleId !== input.moduleId) return { ok: false, reason: "That test case belongs to a different module." };
    if (existing.description === input.description && existing.source === input.source) return { ok: true, test: existing, approvalWithdrawn: false };
    const id = input.id;
    return db.transaction(() => {
      db.update(moduleTests).set({ description: input.description, source: input.source, updatedAt: now }).where(eq(moduleTests.id, id)).run();
      const approvalWithdrawn = withdrawApprovalForTestChange(db, input.moduleId, now);
      return { ok: true as const, test: getModuleTest(db, id)!, approvalWithdrawn };
    });
  }

  return db.transaction(() => {
    const row = db
      .insert(moduleTests)
      .values({ id: uuidv7(), moduleId: input.moduleId, description: input.description, source: input.source, createdAt: now, updatedAt: now })
      .returning()
      .get();
    const approvalWithdrawn = withdrawApprovalForTestChange(db, input.moduleId, now);
    return { ok: true as const, test: toCase(row), approvalWithdrawn };
  });
}

/** Whether any write of a batch withdrew the module's approval — at most one of them can, the first that changed a case. */
export function batchWithdrewApproval(results: readonly SaveModuleTestResult[]): boolean {
  return results.some((result) => result.ok && result.approvalWithdrawn);
}

/**
 * Adds cases to a module, in order, as one batch (EO-355): the cases a
 * module arrives with, from a proposal, a `module_save` or an import.
 * Answers the cases it added.
 *
 * Every case in the batch is its own case, including two with identical
 * descriptions and source. A batch is what somebody wrote, and two
 * entries that happen to read the same are still two entries, so
 * nothing in the batch is collapsed into another.
 *
 * With `skipExisting` (the default), a case the module *already had*
 * before this batch, with the same description and source, is not added
 * again. So saving a module with its cases twice leaves them as they
 * were and does not double them. An import passes false: it writes into
 * a module it has just created, and what it writes has to be exactly
 * what the document carries.
 *
 * Never removes or replaces anything: a case that is not in this batch
 * stays. Removing one is `deleteModuleTest`, on its own.
 *
 * A case it adds to an approved module withdraws the approval, as
 * `saveModuleTest` does; a batch whose every case is skipped as already
 * there leaves it standing (EO-498).
 *
 * Each added case gets its own `createdAt`, one millisecond apart, so
 * they list and run in the order they were given (the order the author
 * wrote them in) rather than by the tie-breaking id alone.
 */
export function addModuleTests(
  db: Db,
  moduleId: string,
  cases: readonly { description: string; source: string }[],
  options: { skipExisting?: boolean; now?: number } = {},
): SaveModuleTestResult[] {
  const keyOf = (test: { description: string; source: string }) => JSON.stringify([test.description, test.source]);
  const had = options.skipExisting === false ? new Set<string>() : new Set(listModuleTests(db, moduleId).map(keyOf));
  const results: SaveModuleTestResult[] = [];
  let at = options.now ?? Date.now();
  for (const each of cases) {
    // Against what the module had before this batch only, never against
    // the batch itself.
    if (had.has(keyOf(each))) continue;
    results.push(saveModuleTest(db, { moduleId, description: each.description, source: each.source }, at));
    at += 1;
  }
  return results;
}

/**
 * Writes the cases a corrected module arrives with onto a module that
 * already has some (EO-401). Answers one result per case given.
 *
 * A case whose description the module already had is that case, written
 * again: its source is replaced in place, so the corrected case does not
 * sit beside the one it corrects, which would go on failing. A case the
 * module did not have is added. A case the batch does not list stays, as
 * with `addModuleTests`.
 *
 * Two cases in the batch with one description take two of the module's
 * cases of that description, oldest first, and are added once those run
 * out — so a batch is never collapsed into fewer cases than it lists.
 *
 * A case added or replaced on an approved module withdraws the approval,
 * through `saveModuleTest`; one written again exactly as it was does not
 * (EO-498).
 */
export function putModuleTests(db: Db, moduleId: string, cases: readonly { description: string; source: string }[], now: number = Date.now()): SaveModuleTestResult[] {
  const results: SaveModuleTestResult[] = [];
  let at = now;
  for (const { given, replaces } of pairedWithExisting(listModuleTests(db, moduleId), cases)) {
    if (replaces === undefined) {
      results.push(saveModuleTest(db, { moduleId, description: given.description, source: given.source }, at));
      at += 1;
    } else if (replaces.source === given.source) {
      results.push({ ok: true, test: replaces, approvalWithdrawn: false });
    } else {
      results.push(saveModuleTest(db, { id: replaces.id, moduleId, description: given.description, source: given.source }, at));
    }
  }
  return results;
}

/**
 * Would `putModuleTests` write anything for these cases (EO-401)?
 *
 * The same pairing, asked without writing, so that "is there anything to
 * correct" and "what gets corrected" cannot come to disagree. They did
 * once: asked as "does the module hold a case that says this", a module
 * with an old and a fixed case under one description answered that the
 * fixed one was already there, and the old one went on failing.
 */
export function moduleTestsWouldChange(db: Db, moduleId: string, cases: readonly { description: string; source: string }[]): boolean {
  return pairedWithExisting(listModuleTests(db, moduleId), cases).some(({ given, replaces }) => replaces === undefined || replaces.source !== given.source);
}

/**
 * Each given case beside the case of the module it is written over: the
 * oldest not yet taken with its description, or none.
 *
 * Exported for the help chat's change card (EO-499), which draws what
 * `putModuleTests` will write against the cases left once its removals
 * are deleted — the same pairing, so the card and the write agree.
 */
export function pairedWithExisting<Given extends { description: string; source: string }>(
  existing: readonly ModuleTestCase[],
  cases: readonly Given[],
): { given: Given; replaces: ModuleTestCase | undefined }[] {
  const had = new Map<string, ModuleTestCase[]>();
  for (const each of existing) had.set(each.description, [...(had.get(each.description) ?? []), each]);
  return cases.map((given) => ({ given, replaces: had.get(given.description)?.shift() }));
}

/**
 * Makes a replica module's cases exactly the ones an organisation
 * published (EO-355), with the record's ids.
 *
 * Upserted by id so applying the same publication twice writes the same
 * rows, and every case of this module the publication does not name is
 * removed: a publication is the whole of what the section is.
 *
 * Leaves the module's approval exactly as it is (EO-498): a replica's
 * approval is the organisation's publication, which carries it.
 */
export function replaceReplicaModuleTests(
  db: Db,
  moduleId: string,
  cases: readonly { id: string; description: string; source: string; createdAt: number; updatedAt: number }[],
): void {
  const keep = new Set(cases.map((each) => each.id));
  for (const existing of listModuleTests(db, moduleId)) {
    if (!keep.has(existing.id)) db.delete(moduleTests).where(eq(moduleTests.id, existing.id)).run();
  }
  for (const each of cases) {
    db.insert(moduleTests)
      .values({ id: each.id, moduleId, description: each.description, source: each.source, createdAt: each.createdAt, updatedAt: each.updatedAt })
      .onConflictDoUpdate({
        target: moduleTests.id,
        set: { moduleId, description: each.description, source: each.source, createdAt: each.createdAt, updatedAt: each.updatedAt },
      })
      .run();
  }
}

/**
 * Removes one case. Answers the module it belonged to and whether
 * removing it withdrew that module's approval (EO-498), or null when
 * there was no such case.
 */
export function deleteModuleTest(db: Db, id: string, now: number = Date.now()): { moduleId: string; approvalWithdrawn: boolean } | null {
  const existing = getModuleTest(db, id);
  if (!existing) return null;
  return db.transaction(() => {
    db.delete(moduleTests).where(eq(moduleTests.id, id)).run();
    return { moduleId: existing.moduleId, approvalWithdrawn: withdrawApprovalForTestChange(db, existing.moduleId, now) };
  });
}

/**
 * What a test run is taken against: the module's code and manifest and
 * every case, descriptions included.
 *
 * A hash rather than the pieces, because all it is ever asked is "is this
 * still the same". The manifest is in it because a case runs against what
 * the manifest declares — the binaries `ctx.exec` may call, the inputs
 * and their defaults — so changing it changes what the case tests even
 * where the code does not move.
 */
export function moduleTestFingerprint(module: Pick<CustomModule, "code" | "manifest">, tests: Pick<ModuleTestCase, "id" | "description" | "source">[]): string {
  const subject = JSON.stringify({
    code: module.code,
    manifest: module.manifest,
    tests: tests.map((test) => [test.id, test.description, test.source]),
  });
  return createHash("sha256").update(subject).digest("hex");
}

export interface StoredModuleTestRun {
  fingerprint: string;
  run: ModuleTestRun;
}

export function getModuleTestResult(db: Db, moduleId: string): StoredModuleTestRun | undefined {
  const row = db.select().from(moduleTestResults).where(eq(moduleTestResults.moduleId, moduleId)).get();
  return row ? { fingerprint: row.fingerprint, run: row.result as ModuleTestRun } : undefined;
}

/** Every stored result, keyed by module — for a list that reads them all at once. */
export function listModuleTestResults(db: Db): Map<string, StoredModuleTestRun> {
  const results = new Map<string, StoredModuleTestRun>();
  for (const row of db.select().from(moduleTestResults).all()) results.set(row.moduleId, { fingerprint: row.fingerprint, run: row.result as ModuleTestRun });
  return results;
}

/** Replaces the module's stored result with this one, taken against `fingerprint`. */
export function storeModuleTestResult(db: Db, moduleId: string, fingerprint: string, run: ModuleTestRun): void {
  db.insert(moduleTestResults)
    .values({ moduleId, fingerprint, ranAt: run.ranAt, result: run })
    .onConflictDoUpdate({ target: moduleTestResults.moduleId, set: { fingerprint, ranAt: run.ranAt, result: run } })
    .run();
}
