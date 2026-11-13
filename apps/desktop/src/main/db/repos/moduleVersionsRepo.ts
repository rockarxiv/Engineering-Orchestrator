import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { DEFAULT_MODULE_VERSIONS_TO_KEEP, MODULE_ENTRY_RULE_KIND, ModuleVersionsToKeepSchema, uuidv7 } from "@eo/core";
import type { CustomModule, EntryRule, ModuleManifest, ModuleVersion, ModuleVersionSummary, ModuleVersionTest } from "@eo/core";
import type { ModuleVersionFacts } from "@eo/engine";
import type { Db } from "../client.js";
import { moduleTests, moduleVersions, modules } from "../schema.js";
import { withdrawTrialGrantsBeyond } from "./moduleTrialGrantsRepo.js";
import { getSetting, setSetting } from "./settingsRepo.js";

/**
 * A module's history (EO-360).
 *
 * A version is filed on every save that changes a module's code or
 * manifest, and on every restore. The current version is always the
 * newest by number; its test cases are the live `module_tests` rows, and
 * the snapshot it carries is refreshed from them just before the next
 * version is filed — so every older version holds the cases as they
 * stood when it stopped being current, which are the cases that went
 * with its code.
 *
 * History is never edited. Restoring files a new version and leaves the
 * one it restored exactly as it was; pruning deletes whole rows and
 * rewrites none.
 */

type VersionRow = typeof moduleVersions.$inferSelect;

function sameManifest(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The module's live cases, in the shape a version holds them. */
function liveTests(db: Db, moduleId: string): ModuleVersionTest[] {
  return db
    .select()
    .from(moduleTests)
    .where(eq(moduleTests.moduleId, moduleId))
    .orderBy(asc(moduleTests.createdAt), asc(moduleTests.id))
    .all()
    .map((row) => ({ id: row.id, description: row.description, source: row.source, createdAt: row.createdAt, updatedAt: row.updatedAt }));
}

/** Every kept version of one module, oldest first. */
function versionRows(db: Db, moduleId: string): VersionRow[] {
  return db.select().from(moduleVersions).where(eq(moduleVersions.moduleId, moduleId)).orderBy(asc(moduleVersions.number)).all();
}

function currentRow(db: Db, moduleId: string): VersionRow | undefined {
  return versionRows(db, moduleId).at(-1);
}

function moduleRow(db: Db, moduleId: string): typeof modules.$inferSelect | undefined {
  return db.select().from(modules).where(eq(modules.id, moduleId)).get();
}

/** What a version holds as its cases: the live rows while it is current, its snapshot after. */
function testsOf(db: Db, row: VersionRow, current: boolean): ModuleVersionTest[] {
  return current ? liveTests(db, row.moduleId) : (row.tests as ModuleVersionTest[]);
}

function toSummary(row: VersionRow, current: boolean, testCount: number, pinnedBy: readonly string[] = []): ModuleVersionSummary {
  return { number: row.number, createdAt: row.createdAt, approvedAt: row.approvedAt, approved: row.approvedAt !== null, current, testCount, pinnedBy: [...pinnedBy] };
}

/** Every kept version of a module, newest first. */
export function listModuleVersions(db: Db, moduleId: string): ModuleVersionSummary[] {
  const rows = versionRows(db, moduleId);
  const newest = rows.at(-1);
  const pins = livePins(db, moduleId);
  return rows
    .map((row) => {
      const current = row.id === newest?.id;
      return toSummary(row, current, current ? liveTests(db, moduleId).length : (row.tests as ModuleVersionTest[]).length, pins.get(row.number));
    })
    .reverse();
}

/**
 * Which pipelines' current graph pins each version of this module
 * (EO-770), by name: a step on it, or an entry rule naming it. Pipelines
 * a person can see only — not archived ones, and not trials.
 */
function livePins(db: Db, moduleId: string): Map<number, string[]> {
  const rows = db.all<{ version: unknown; name: string }>(sql`
    select s.module_version as version, p.name as name from pipeline_steps s join pipelines p on p.id = s.pipeline_id
      where s.type = 'module' and s.entry_action = ${moduleId} and s.module_version is not null and s.retired_version is null
        and p.archived_at is null and p.trial_at is null
    union
    select json_extract(r.value, '$.moduleVersion'), p.name from pipelines p, json_each(p.entry_rules) r
      where json_valid(p.entry_rules) and json_type(p.entry_rules) = 'array'
        and json_extract(r.value, '$.kind') = ${MODULE_ENTRY_RULE_KIND} and json_extract(r.value, '$.module') = ${moduleId}
        and p.archived_at is null and p.trial_at is null
  `);
  const pins = new Map<number, string[]>();
  for (const row of rows) {
    if (typeof row.version !== "number") continue;
    pins.set(row.version, [...new Set([...(pins.get(row.version) ?? []), row.name])].sort((a, b) => a.localeCompare(b)));
  }
  return pins;
}

/** One kept version, whole. Undefined when this module has no such version, or no longer keeps it. */
export function getModuleVersion(db: Db, moduleId: string, number: number): ModuleVersion | undefined {
  const rows = versionRows(db, moduleId);
  const row = rows.find((each) => each.number === number);
  if (!row) return undefined;
  const current = row.id === rows.at(-1)?.id;
  const tests = testsOf(db, row, current);
  return {
    ...toSummary(row, current, tests.length, livePins(db, moduleId).get(row.number)),
    name: row.name,
    description: row.description,
    code: row.code,
    manifest: row.manifest as ModuleManifest,
    tests,
  };
}

/**
 * Writes the current version's snapshot from the live cases — the
 * moment it stops being current, so it keeps the cases that went with
 * its code.
 */
function refreshCurrentSnapshot(db: Db, moduleId: string): void {
  const current = currentRow(db, moduleId);
  if (current) db.update(moduleVersions).set({ tests: liveTests(db, moduleId) }).where(eq(moduleVersions.id, current.id)).run();
}

/**
 * Files the module as it now stands as a new version, numbered above
 * every one it has had, and applies "Module versions to keep".
 *
 * The caller has already refreshed the outgoing version's snapshot.
 * Numbering reads the newest kept row, which is safe because the newest
 * is the current version and pruning never deletes it.
 */
function insertVersion(db: Db, module: typeof modules.$inferSelect, tests: ModuleVersionTest[], approvedAt: number | null, now: number): number {
  const number = (currentRow(db, module.id)?.number ?? 0) + 1;
  db.insert(moduleVersions)
    .values({
      id: uuidv7(),
      moduleId: module.id,
      number,
      name: module.name,
      description: module.description,
      code: module.code,
      manifest: module.manifest,
      tests,
      approvedAt,
      createdAt: now,
    })
    .run();
  pruneModuleVersions(db, module.id, moduleVersionsToKeep(db));
  return number;
}

/**
 * Brings the module's history up to what is saved now, after a write to
 * the module row (EO-360).
 *
 * - When the code or the manifest differs from the current version's —
 *   or there is no version yet, which is a module being created — files
 *   a new one. A save that changed only the name, description or slug
 *   files none.
 * - When the module is approved, the current version is recorded as
 *   approved: approving marks the version current at that moment.
 *
 * Every write that can change a module's code calls this — `saveModule`,
 * `approveModule` and a replica's upsert — so "every code change files a
 * version" holds whichever door the change came through.
 */
export function recordModuleVersion(db: Db, moduleId: string, now: number = Date.now()): void {
  const module = moduleRow(db, moduleId);
  if (!module) return;
  const current = currentRow(db, moduleId);
  if (!current || current.code !== module.code || !sameManifest(current.manifest, module.manifest)) {
    refreshCurrentSnapshot(db, moduleId);
    insertVersion(db, module, liveTests(db, moduleId), module.approvedAt, now);
    return;
  }
  if (module.approvedAt !== null && current.approvedAt !== module.approvedAt) {
    db.update(moduleVersions).set({ approvedAt: module.approvedAt }).where(eq(moduleVersions.id, current.id)).run();
  }
}

/**
 * The current version stops recording itself as approved, because the
 * module's approval has just been withdrawn by a change to its test
 * cases (EO-498). The code and manifest are unchanged, so no version is
 * filed — but a version is approved with the cases it holds, and the
 * current one holds the live cases, which are no longer the ones a
 * person approved. Approving again records it as approved again,
 * through `recordModuleVersion`.
 *
 * Only ever clears the stamp; history is otherwise untouched.
 */
export function withdrawCurrentVersionApproval(db: Db, moduleId: string): void {
  const current = currentRow(db, moduleId);
  if (current && current.approvedAt !== null) db.update(moduleVersions).set({ approvedAt: null }).where(eq(moduleVersions.id, current.id)).run();
}

/** The cases as an approval sees them — what each says and does, in the order they run. Ids and stamps are not part of it. */
function sameTests(a: readonly ModuleVersionTest[], b: readonly ModuleVersionTest[]): boolean {
  return a.length === b.length && a.every((test, index) => test.description === b[index]!.description && test.source === b[index]!.source);
}

/** `number` is the version the restore filed. */
export type RestoreModuleVersionResult = { ok: true; number: number } | { ok: false; reason: string };

/**
 * Puts version `number`'s code, manifest and test cases back on the
 * module, as a new version numbered above every one before it (EO-360).
 *
 * The name and description stay as they are: they are not what a
 * version is restored for, and a rename since is not something a
 * restore should quietly undo.
 *
 * Approved when a kept version that a person approved has exactly this
 * code, manifest and set of test cases — the approval was about that
 * body of code tested by those cases, and it is that again. The same
 * code with different cases is not (EO-498): approving runs the cases,
 * and these ones were not the ones run. Otherwise unapproved, like any
 * edit. A version since pruned no longer counts: there is nothing left
 * to say it was approved.
 *
 * The restored version is left exactly as it was. The version that was
 * current gets its snapshot refreshed first, as before any new version,
 * because it stops being current here.
 */
export function restoreModuleVersion(
  db: Db,
  moduleId: string,
  number: number,
  now: number = Date.now(),
): RestoreModuleVersionResult {
  const module = moduleRow(db, moduleId);
  if (!module) return { ok: false, reason: "That module no longer exists." };
  if (module.archivedAt !== null) return { ok: false, reason: "That module has been deleted." };

  const rows = versionRows(db, moduleId);
  const target = rows.find((row) => row.number === number);
  if (!target) return { ok: false, reason: `"${module.name}" has no v${number} — it was never filed, or has since been deleted.` };
  if (target.id === rows.at(-1)?.id) return { ok: false, reason: `v${number} is already the version "${module.name}" is on.` };

  const tests = target.tests as ModuleVersionTest[];
  const newestId = rows.at(-1)?.id;
  const approvals = rows
    .filter(
      (row) =>
        row.approvedAt !== null &&
        row.code === target.code &&
        sameManifest(row.manifest, target.manifest) &&
        sameTests(testsOf(db, row, row.id === newestId), tests),
    )
    .map((row) => row.approvedAt as number);
  const approvedAt = approvals.length === 0 ? null : Math.max(...approvals);

  const restored = db.transaction(() => {
    refreshCurrentSnapshot(db, moduleId);

    db.update(modules).set({ code: target.code, manifest: target.manifest, approvedAt, updatedAt: now }).where(eq(modules.id, moduleId)).run();
    // A restore is a save of older code, and held to the same rule
    // (EO-583): a version that needs more than a trial grant covers
    // takes the grant away.
    withdrawTrialGrantsBeyond(db, moduleId, target.manifest as ModuleManifest, now);

    // The cases come back under their own ids, so a case restored is the
    // case it was. One whose id has since gone to another module — which
    // nothing does today — comes back under a new one rather than being
    // taken from it.
    const kept: ModuleVersionTest[] = [];
    for (const test of tests) {
      const owner = db.select({ moduleId: moduleTests.moduleId }).from(moduleTests).where(eq(moduleTests.id, test.id)).get();
      kept.push(owner === undefined || owner.moduleId === moduleId ? test : { ...test, id: uuidv7() });
    }
    const keepIds = kept.map((test) => test.id);
    db.delete(moduleTests)
      .where(keepIds.length === 0 ? eq(moduleTests.moduleId, moduleId) : and(eq(moduleTests.moduleId, moduleId), notInArray(moduleTests.id, keepIds)))
      .run();
    for (const test of kept) {
      db.insert(moduleTests)
        .values({ id: test.id, moduleId, description: test.description, source: test.source, createdAt: test.createdAt, updatedAt: test.updatedAt })
        .onConflictDoUpdate({
          target: moduleTests.id,
          set: { description: test.description, source: test.source, createdAt: test.createdAt, updatedAt: test.updatedAt },
        })
        .run();
    }

    return insertVersion(db, moduleRow(db, moduleId)!, kept, approvedAt, now);
  });

  return { ok: true, number: restored };
}

// ── Retention (EO-360) ────────────────────────────────────────

/** Where "Module versions to keep" is stored, beside `pipelines.versionsToKeep`. */
export const MODULE_VERSIONS_TO_KEEP_KEY = "modules.versionsToKeep";

/**
 * How many versions of each module this installation keeps.
 *
 * Parsed rather than cast, for `pipelineVersionsToKeep`'s reason: a
 * stored value that is not a whole number of one or more is not a limit
 * EO can honour, and the default is a better answer to it.
 */
export function moduleVersionsToKeep(db: Db): number {
  const stored = getSetting<{ count?: unknown }>(db, MODULE_VERSIONS_TO_KEEP_KEY, { count: DEFAULT_MODULE_VERSIONS_TO_KEEP });
  return ModuleVersionsToKeepSchema.safeParse(stored.count).data ?? DEFAULT_MODULE_VERSIONS_TO_KEEP;
}

export function setModuleVersionsToKeep(db: Db, count: number): void {
  setSetting(db, MODULE_VERSIONS_TO_KEEP_KEY, { count: ModuleVersionsToKeepSchema.parse(count) });
}

/**
 * Deletes this module's oldest versions beyond `keep`, and answers with
 * the numbers it deleted.
 *
 * Run after every version is filed, so a lowered limit takes effect at
 * each module's next save. The newest `keep` stay, and the newest of
 * all — the current version, and the highest number the module has
 * used — stays whatever `keep` says, which is what keeps a number from
 * being handed out twice. A deleted version no longer counts towards
 * re-approving a restore.
 */
export function pruneModuleVersions(db: Db, moduleId: string, keep: number): number[] {
  const limit = Math.max(1, Math.floor(keep));
  const rows = versionRows(db, moduleId);
  if (rows.length <= limit) return [];
  // Never one a pipeline pins (EO-770), however old: a live step, a live
  // entry rule or a kept pipeline version runs it, and a pin on a version
  // that is gone is a step nothing can run. Kept beyond `keep`, and
  // counted against nothing.
  const pinned = pinnedModuleVersions(db, moduleId);
  const doomed = rows.slice(0, rows.length - limit).filter((row) => row.id !== rows.at(-1)?.id && !pinned.has(row.number));
  if (doomed.length === 0) return [];
  db.delete(moduleVersions)
    .where(inArray(
      moduleVersions.id,
      doomed.map((row) => row.id),
    ))
    .run();
  return doomed.map((row) => row.number);
}

// ── Pins (EO-770) ─────────────────────────────────────────────

/**
 * The version a module step or a module entry rule that names no version
 * is pinned to (EO-770): the module's newest approved version, or its
 * newest where none is approved — which leaves the step refused at
 * publish, or blocked at run, exactly as an unapproved module is. Null
 * for a module with no version at all.
 */
export function defaultModuleVersion(db: Db, moduleId: string): number | null {
  const rows = versionRows(db, moduleId);
  return (rows.filter((row) => row.approvedAt !== null).at(-1) ?? rows.at(-1))?.number ?? null;
}

/**
 * The version a step being saved runs (EO-770): the one it pins, or — on
 * a module step that names none — `defaultModuleVersion`. Null on every
 * step that is not a module step.
 */
export function stepModuleVersion(db: Db, step: { type?: string | undefined; entryAction?: string | null | undefined; moduleVersion?: number | null | undefined }): number | null {
  if (step.type !== "module" || step.entryAction === null || step.entryAction === undefined) return null;
  return step.moduleVersion ?? defaultModuleVersion(db, step.entryAction);
}

/** The module's newest version, approved or not, or null for one with none. */
export function newestModuleVersion(db: Db, moduleId: string): number | null {
  return currentRow(db, moduleId)?.number ?? null;
}

/** The rules, each module rule that names no version pinned to `defaultModuleVersion`. Every other rule as it was. */
export function pinEntryRules(db: Db, rules: readonly EntryRule[]): EntryRule[] {
  return rules.map((rule) => {
    if (rule.kind !== MODULE_ENTRY_RULE_KIND || rule.module === undefined || rule.moduleVersion !== undefined) return rule;
    const version = defaultModuleVersion(db, rule.module);
    return version === null ? rule : { ...rule, moduleVersion: version };
  });
}

/**
 * Every kept version of every module, as `validatePipeline` judges a pin
 * against it: its number, its manifest and its own approval.
 */
export function listModuleVersionFacts(db: Db): ModuleVersionFacts[] {
  return db
    .select({ moduleId: moduleVersions.moduleId, number: moduleVersions.number, manifest: moduleVersions.manifest, approvedAt: moduleVersions.approvedAt })
    .from(moduleVersions)
    .all()
    .map((row) => ({ moduleId: row.moduleId, number: row.number, manifest: row.manifest as ModuleManifest, approvedAt: row.approvedAt }));
}

/**
 * A module as a pin makes it (EO-770): the catalog row with the code, the
 * manifest and the approval of the version pinned — what the runner
 * runs, and what it gates on. The name stays the module's own.
 *
 * No pin is the module as it stands, which is what a step written before
 * pins runs. A pin on a version this module does not keep answers why.
 */
export function moduleAtVersion(
  db: Db,
  module: CustomModule,
  version: number | null | undefined,
): { ok: true; module: CustomModule; version: number | null } | { ok: false; reason: string } {
  if (version === null || version === undefined) return { ok: true, module, version: null };
  const row = db
    .select()
    .from(moduleVersions)
    .where(and(eq(moduleVersions.moduleId, module.id), eq(moduleVersions.number, version)))
    .get();
  if (row === undefined) {
    return { ok: false, reason: `"${module.name}" v${version} is not kept any more, so this step has no code to run. Pin a version of "${module.name}" that Settings → Modules lists.` };
  }
  return { ok: true, module: { ...module, code: row.code, manifest: row.manifest as ModuleManifest, approvedAt: row.approvedAt }, version };
}

/**
 * The version numbers of this module that something pins (EO-770): a
 * step of any pipeline, retired ones included, an entry rule a pipeline
 * holds, and a step or entry rule of any kept pipeline version — the
 * versions `pruneModuleVersions` must never delete.
 */
export function pinnedModuleVersions(db: Db, moduleId: string): Set<number> {
  const rows = db.all<{ version: unknown }>(sql`
    select module_version as version from pipeline_steps
      where type = 'module' and entry_action = ${moduleId} and module_version is not null
    union
    select json_extract(r.value, '$.moduleVersion') from pipelines, json_each(pipelines.entry_rules) r
      where json_valid(pipelines.entry_rules) and json_type(pipelines.entry_rules) = 'array'
        and json_extract(r.value, '$.kind') = ${MODULE_ENTRY_RULE_KIND} and json_extract(r.value, '$.module') = ${moduleId}
    union
    select json_extract(r.value, '$.moduleVersion') from pipeline_versions, json_each(pipeline_versions.entry_rules) r
      where json_valid(pipeline_versions.entry_rules) and json_type(pipeline_versions.entry_rules) = 'array'
        and json_extract(r.value, '$.kind') = ${MODULE_ENTRY_RULE_KIND} and json_extract(r.value, '$.module') = ${moduleId}
    union
    select json_extract(s.value, '$.moduleVersion') from pipeline_versions, json_each(pipeline_versions.steps) s
      where json_valid(pipeline_versions.steps) and json_type(pipeline_versions.steps) = 'array'
        and json_extract(s.value, '$.type') = 'module' and json_extract(s.value, '$.entryAction') = ${moduleId}
  `);
  return new Set(rows.flatMap((row) => (typeof row.version === "number" ? [row.version] : [])));
}
