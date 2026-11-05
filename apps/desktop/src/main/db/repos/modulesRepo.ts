import { asc, eq } from "drizzle-orm";
import { uuidv7 } from "@eo/core";
import type { CustomModule, ModuleManifest, ModuleSource, Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { modules, moduleTests } from "../schema.js";
import { withdrawTrialGrantsBeyond, type ModuleTrialGrant } from "./moduleTrialGrantsRepo.js";
import { recordModuleVersion } from "./moduleVersionsRepo.js";

function toModule(row: typeof modules.$inferSelect): CustomModule {
  return {
    id: row.id as Uuid,
    slug: row.slug,
    name: row.name,
    description: row.description,
    code: row.code,
    manifest: row.manifest as ModuleManifest,
    originalScript: row.originalScript,
    source: row.source as ModuleSource,
    approvedAt: row.approvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  };
}

/**
 * Every live module, by slug.
 *
 * Archived ones are excluded here rather than by each caller, the way
 * `listPipelines` does it: an archived module is kept so a historical
 * run's transcript still refers to something, not so that it keeps
 * appearing in a picker.
 */
export function listModules(db: Db, includeArchived = false): CustomModule[] {
  const rows = db.select().from(modules).orderBy(asc(modules.slug)).all().map(toModule);
  return includeArchived ? rows : rows.filter((module) => module.archivedAt === null);
}

export function getModule(db: Db, id: string): CustomModule | undefined {
  const row = db.select().from(modules).where(eq(modules.id, id)).get();
  return row ? toModule(row) : undefined;
}

export function getModuleBySlug(db: Db, slug: string): CustomModule | undefined {
  const row = db.select().from(modules).where(eq(modules.slug, slug)).get();
  return row ? toModule(row) : undefined;
}

export interface SaveModuleInput {
  /** Absent creates; present edits that module in place. */
  id?: string;
  slug: string;
  name: string;
  description: string;
  code: string;
  manifest: ModuleManifest;
  originalScript?: string | null;
  source?: ModuleSource | undefined;
  /**
   * Record that a person has read *this* code and accepted it.
   *
   * No command passes this any more (EO-353): approving runs the
   * module's tests first, which is `approveModuleCommand`'s job, and
   * `modules:save` carries no such field. It stays for the fixtures that
   * need an approved module to exist.
   */
  approve?: boolean;
}

export type SaveModuleResult =
  | {
      ok: true;
      module: CustomModule;
      /** The trial grants this save withdrew because the manifest now needs more than they cover (EO-583). Absent where it withdrew none. */
      withdrawnTrialGrants?: ModuleTrialGrant[];
    }
  | { ok: false; reason: string };

/**
 * Creates or edits a module.
 *
 * Two rules live here rather than at the call sites, because both are
 * easy to forget and forgetting either is silent:
 *
 * **Editing the code clears the approval.** A module is approved as a
 * body of code, not as a name — so renaming or re-describing keeps it,
 * and changing a character of `code` or a field of `manifest` does not.
 * Without this an approved module would be an editable one, and the gate
 * would protect only the first version anyone ever wrote.
 *
 * **Widening the needs withdraws a trial grant** (EO-583). A grant
 * lets an unapproved module run on one trial's items within the needs it
 * declared then; the code may change freely, and a manifest that now
 * needs more than a grant covers takes that grant away in this same
 * write.
 *
 * Nothing a person or an agent reaches approves through here (EO-353):
 * approving runs the module's tests first, and that is
 * `approveModuleCommand`, which calls `approveModule`.
 */
export function saveModule(db: Db, input: SaveModuleInput, now: number = Date.now()): SaveModuleResult {
  const bySlug = getModuleBySlug(db, input.slug);
  if (bySlug && bySlug.id !== input.id) {
    return { ok: false, reason: `Another module already uses the slug "${input.slug}".` };
  }

  const existing = input.id === undefined ? undefined : getModule(db, input.id);
  if (input.id !== undefined && !existing) return { ok: false, reason: `No module ${input.id}.` };

  const codeChanged = existing !== undefined && (existing.code !== input.code || JSON.stringify(existing.manifest) !== JSON.stringify(input.manifest));

  const values = {
    slug: input.slug,
    name: input.name,
    description: input.description,
    code: input.code,
    manifest: input.manifest,
    originalScript: input.originalScript ?? existing?.originalScript ?? null,
    // `existing?.source` is reachable now that the input's `source` is
    // optional: a rename must not turn an architect-written or imported
    // module into a hand-written one.
    source: input.source ?? existing?.source ?? "user",
    // Approving is explicit and separate. A save that carried it would
    // make every edit self-approving, which is the opposite of the point.
    approvedAt: input.approve ? now : codeChanged ? null : (existing?.approvedAt ?? null),
    updatedAt: now,
  };

  // Every save that changes the code or the manifest files a version,
  // creating included; a rename files none (EO-360). One transaction, so
  // a module is never saved without the version that records it.
  return db.transaction((): SaveModuleResult => {
    if (existing) {
      db.update(modules).set(values).where(eq(modules.id, existing.id)).run();
      recordModuleVersion(db, existing.id, now);
      const withdrawn = withdrawTrialGrantsBeyond(db, existing.id, input.manifest, now);
      return { ok: true, module: getModule(db, existing.id)!, ...(withdrawn.length > 0 ? { withdrawnTrialGrants: withdrawn } : {}) };
    }

    const row = db
      .insert(modules)
      .values({ id: uuidv7(), createdAt: now, archivedAt: null, ...values })
      .returning()
      .get();
    recordModuleVersion(db, row.id, now);
    return { ok: true, module: toModule(row) };
  });
}

/** Deleting a module archives it — see the column's note and invariant #3. */
/**
 * A module as the organisation published it, into this replica
 * (EO-329, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * Code included, because a `module` step runs it and a step whose code
 * this machine does not have is a step that fails on the machine the
 * work is on. `approvedAt` travels with it, and that is the one
 * decision here worth writing down: approval records that *a person
 * read the code and accepted it*, and on a managed installation that
 * person is the administrator who published it. A replica that dropped
 * the approval would hold a published pipeline that refuses to run on
 * every desktop, with nobody able to approve it — the section is
 * locked.
 */
export function upsertReplicaModule(db: Db, published: ReplicaModule): void {
  // A local module of the same slug stands aside: the slug is unique,
  // and on a published section the organisation's catalogue is the
  // catalogue. Archived rather than deleted, because a step and a run
  // still point at the row (EO-329).
  const taken = db.select({ id: modules.id }).from(modules).where(eq(modules.slug, published.slug)).get();
  if (taken !== undefined && taken.id !== published.id) {
    const at = Date.now();
    db.update(modules)
      .set({ slug: `${published.slug}-local-${taken.id.slice(-6)}`, archivedAt: at, updatedAt: at })
      .where(eq(modules.id, taken.id))
      .run();
  }
  db.insert(modules)
    .values({
      id: published.id,
      slug: published.slug,
      name: published.name,
      description: published.description,
      code: published.code,
      manifest: published.manifest,
      originalScript: published.originalScript,
      source: published.source,
      approvedAt: published.approvedAt,
      createdAt: published.createdAt,
      updatedAt: published.updatedAt,
      archivedAt: published.archivedAt,
    })
    .onConflictDoUpdate({
      target: modules.id,
      set: {
        slug: published.slug,
        name: published.name,
        description: published.description,
        code: published.code,
        manifest: published.manifest,
        originalScript: published.originalScript,
        source: published.source,
        approvedAt: published.approvedAt,
          updatedAt: published.updatedAt,
        archivedAt: published.archivedAt,
      },
    })
    .run();
  // The organisation's code is this module's code now, so it is a
  // version like any other edit (EO-360) — and the current version stays
  // the code that is actually here.
  recordModuleVersion(db, published.id, published.updatedAt);
}

/** What a publication carries about a module — `ModuleView` minus what is derived on every read. */
export interface ReplicaModule {
  id: string;
  slug: string;
  name: string;
  description: string;
  code: string;
  manifest: unknown;
  originalScript: string | null;
  source: string;
  approvedAt: number | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export function archiveModule(db: Db, id: string, at: number = Date.now()): void {
  db.update(modules).set({ archivedAt: at, updatedAt: at }).where(eq(modules.id, id)).run();
}

/**
 * Records that a person read this module and accepted it.
 *
 * Separate from `saveModule` so approving does not mean resending the
 * code: a caller that only wants to approve should not be able to change
 * what it is approving in the same call, by accident or otherwise.
 */
export function approveModule(db: Db, id: string, at: number = Date.now()): void {
  db.transaction(() => {
    db.update(modules).set({ approvedAt: at, updatedAt: at }).where(eq(modules.id, id)).run();
    // The version current at this moment is the one approved (EO-360).
    recordModuleVersion(db, id, at);
  });
}

/**
 * Renames a module and nothing else (EO-588): a draft copy published in
 * place of the module it copied takes that module's name, so the live
 * pipeline does not run something called "(trial)". Its code, manifest,
 * approval and versions are untouched — a rename files no version.
 */
export function renameModule(db: Db, id: string, name: string, at: number = Date.now()): void {
  db.update(modules).set({ name, updatedAt: at }).where(eq(modules.id, id)).run();
}

/**
 * Makes a draft copy of a module for a trial (EO-583): a new row with the
 * original's code, manifest and test cases, unapproved, and linked to
 * the original by `forked_from_module_id`.
 *
 * The original is read and never written — its code, its approval and
 * its versions stay exactly as they were, however often the copy is
 * edited. The copy gets a slug of its own, since a slug names one module.
 *
 * `contentsOf` copies another module's code, manifest and cases instead,
 * still linked to `originalId` (EO-587): a draft copy an earlier trial
 * made, which live work has since come to use, is not the trial's to edit
 * any more, but the fixes in it are — so a new trial is given a copy of
 * it, as a copy of the module the draft names.
 */
export function forkModuleForTrial(db: Db, originalId: string, at: number = Date.now(), options: { contentsOf?: string } = {}): Uuid {
  const named = db.select().from(modules).where(eq(modules.id, originalId)).get();
  if (named === undefined) throw new Error(`No module ${originalId} to copy.`);
  const original = options.contentsOf === undefined ? named : db.select().from(modules).where(eq(modules.id, options.contentsOf)).get();
  if (original === undefined) throw new Error(`No module ${options.contentsOf} to copy.`);
  const id = uuidv7();
  db.transaction(() => {
    db.insert(modules)
      .values({
        id,
        slug: `${named.slug}-trial-${id.slice(-8)}`,
        name: `${named.name} (trial)`,
        description: original.description,
        code: original.code,
        manifest: original.manifest,
        originalScript: original.originalScript,
        source: original.source,
        approvedAt: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        forkedFromModuleId: named.id,
      })
      .run();
    const cases = db.select().from(moduleTests).where(eq(moduleTests.moduleId, original.id)).orderBy(asc(moduleTests.createdAt), asc(moduleTests.id)).all();
    for (const test of cases) {
      db.insert(moduleTests).values({ id: uuidv7(), moduleId: id, description: test.description, source: test.source, createdAt: test.createdAt, updatedAt: test.updatedAt }).run();
    }
    recordModuleVersion(db, id, at);
  });
  return id as Uuid;
}

/** The module this one is a draft copy of, or null for a module that is no copy. */
export function moduleForkedFrom(db: Db, moduleId: string): Uuid | null {
  const row = db.select({ forkedFrom: modules.forkedFromModuleId }).from(modules).where(eq(modules.id, moduleId)).get();
  return (row?.forkedFrom ?? null) as Uuid | null;
}
