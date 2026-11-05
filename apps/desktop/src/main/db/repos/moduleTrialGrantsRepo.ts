import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { uuidv7, type ModuleManifest, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { modules, moduleTrialGrants, pipelines, pipelineSteps, pipelineVersions } from "../schema.js";

/**
 * Trial grants (EO-583, ARCHITECTURE.md, "Modules: a step that is a script").
 *
 * A module nobody has approved runs nowhere. Approving a design for a
 * trial grants each of the draft's modules permission to run on that
 * trial's items — and on nothing else — within the needs it declared at
 * that moment. Its code may then change as often as the test-fix loop
 * needs, and the grant holds for as long as the manifest's needs stay
 * inside it; the first save that widens them withdraws it, which is how
 * the person is brought back for anything they did not agree to.
 *
 * What a grant covers is the five things a person is shown about a
 * module because they are what they are granting (EO-581's module row):
 * the binaries it may execute, the environment variables and secrets it
 * is given, network access, outside effects, and creating items.
 */

/** What a trial grant lets a module need and still run. */
export interface TrialGrantNeeds {
  bin: string[];
  env: string[];
  network: boolean;
  sideEffects: boolean;
  create: boolean;
}

/** One grant, as it is recorded. */
export interface ModuleTrialGrant {
  id: Uuid;
  moduleId: Uuid;
  trialPipelineId: Uuid;
  /** `"human"`, or the id of the agent that granted it — `transitions.actor`'s vocabulary. */
  grantedBy: string;
  grantedAt: number;
  needs: TrialGrantNeeds;
  /** When a save widened the module past it, or null while it holds. */
  withdrawnAt: number | null;
}

type GrantRow = typeof moduleTrialGrants.$inferSelect;

function toGrant(row: GrantRow): ModuleTrialGrant {
  return {
    id: row.id as Uuid,
    moduleId: row.moduleId as Uuid,
    trialPipelineId: row.trialPipelineId as Uuid,
    grantedBy: row.grantedBy,
    grantedAt: row.grantedAt,
    needs: row.needs as TrialGrantNeeds,
    withdrawnAt: row.withdrawnAt,
  };
}

/** The part of a manifest a grant is about. `sideEffects` absent reads as false, as it does everywhere. */
export function trialGrantNeedsOf(manifest: ModuleManifest): TrialGrantNeeds {
  return {
    bin: [...manifest.needs.bin],
    env: [...manifest.needs.env],
    network: manifest.needs.network,
    sideEffects: manifest.sideEffects === true,
    create: manifest.needs.create,
  };
}

/**
 * What this manifest needs that the grant does not cover, in words, or
 * an empty list where it is within it. A need given up is never a
 * widening: a module that stops asking for the network still fits.
 */
export function needsBeyondGrant(manifest: ModuleManifest, granted: TrialGrantNeeds): string[] {
  const needs = trialGrantNeedsOf(manifest);
  const beyond: string[] = [];
  for (const bin of needs.bin) if (!granted.bin.includes(bin)) beyond.push(`the binary ${bin}`);
  for (const name of needs.env) if (!granted.env.includes(name)) beyond.push(`the variable or secret ${name}`);
  if (needs.network && !granted.network) beyond.push("network access");
  if (needs.sideEffects && !granted.sideEffects) beyond.push("outside effects");
  if (needs.create && !granted.create) beyond.push("creating items");
  return beyond;
}

/**
 * Grants a module trial-only permission on one trial pipeline, covering
 * the needs its manifest declares now. A grant already holding for the
 * same module and trial is withdrawn in the same write, so there is
 * never more than one to read.
 */
export function grantTrial(db: Db, input: { moduleId: string; trialPipelineId: string; grantedBy: string; at?: number }): ModuleTrialGrant {
  const at = input.at ?? Date.now();
  const module = db.select({ manifest: modules.manifest }).from(modules).where(eq(modules.id, input.moduleId)).get();
  if (module === undefined) throw new Error(`No module ${input.moduleId} to grant.`);
  return db.transaction(() => {
    db.update(moduleTrialGrants)
      .set({ withdrawnAt: at })
      .where(and(eq(moduleTrialGrants.moduleId, input.moduleId), eq(moduleTrialGrants.trialPipelineId, input.trialPipelineId), isNull(moduleTrialGrants.withdrawnAt)))
      .run();
    const row = db
      .insert(moduleTrialGrants)
      .values({
        id: uuidv7(),
        moduleId: input.moduleId,
        trialPipelineId: input.trialPipelineId,
        grantedBy: input.grantedBy,
        grantedAt: at,
        needs: trialGrantNeedsOf(module.manifest as ModuleManifest),
        withdrawnAt: null,
      })
      .returning()
      .get();
    return toGrant(row);
  });
}

/** Every grant on one module, held or withdrawn, oldest first. */
export function listTrialGrantsForModule(db: Db, moduleId: string): ModuleTrialGrant[] {
  return db.select().from(moduleTrialGrants).where(eq(moduleTrialGrants.moduleId, moduleId)).orderBy(asc(moduleTrialGrants.grantedAt), asc(moduleTrialGrants.id)).all().map(toGrant);
}

/** The grants still holding on one module. */
export function activeTrialGrants(db: Db, moduleId: string): ModuleTrialGrant[] {
  return listTrialGrantsForModule(db, moduleId).filter((grant) => grant.withdrawnAt === null);
}

/** The newest grant of this module for this trial, held or withdrawn, or undefined where there never was one. */
export function latestTrialGrant(db: Db, moduleId: string, trialPipelineId: string): ModuleTrialGrant | undefined {
  const row = db
    .select()
    .from(moduleTrialGrants)
    .where(and(eq(moduleTrialGrants.moduleId, moduleId), eq(moduleTrialGrants.trialPipelineId, trialPipelineId)))
    .orderBy(desc(moduleTrialGrants.grantedAt), desc(moduleTrialGrants.id))
    .get();
  return row === undefined ? undefined : toGrant(row);
}

/** The modules holding a grant on this trial pipeline — what its graph may run without an approval. */
export function trialGrantedModuleIds(db: Db, trialPipelineId: string): string[] {
  return db
    .select({ moduleId: moduleTrialGrants.moduleId })
    .from(moduleTrialGrants)
    .where(and(eq(moduleTrialGrants.trialPipelineId, trialPipelineId), isNull(moduleTrialGrants.withdrawnAt)))
    .all()
    .map((row) => row.moduleId);
}

/**
 * Withdraws every grant on this module that the manifest now needs more
 * than, and answers with the ones it withdrew (EO-583).
 *
 * Called by every write that can change a module's manifest — `saveModule`
 * and `restoreModuleVersion` — inside the write's own transaction, so a
 * module is never saved wider than a grant it still holds.
 */
export function withdrawTrialGrantsBeyond(db: Db, moduleId: string, manifest: ModuleManifest, at: number): ModuleTrialGrant[] {
  const widened = activeTrialGrants(db, moduleId).filter((grant) => needsBeyondGrant(manifest, grant.needs).length > 0);
  for (const grant of widened) db.update(moduleTrialGrants).set({ withdrawnAt: at }).where(eq(moduleTrialGrants.id, grant.id)).run();
  return widened.map((grant) => ({ ...grant, withdrawnAt: at }));
}

/**
 * Whether any pipeline that is not a trial runs this module — on one of
 * its current steps, or in any version an item may still be bound to
 * (EO-583).
 *
 * The whole of what "a published pipeline uses it" means: an item runs
 * the step its own version defines (EO-327), so a module that has left a
 * pipeline's current graph can still be what an item in flight runs next.
 */
export function moduleInLiveUse(db: Db, moduleId: string): boolean {
  const onAStep = db
    .select({ id: pipelineSteps.id })
    .from(pipelineSteps)
    .innerJoin(pipelines, eq(pipelines.id, pipelineSteps.pipelineId))
    .where(and(eq(pipelineSteps.type, "module"), eq(pipelineSteps.entryAction, moduleId), isNull(pipelines.trialAt)))
    .get();
  if (onAStep !== undefined) return true;
  const versions = db
    .select({ steps: pipelineVersions.steps })
    .from(pipelineVersions)
    .innerJoin(pipelines, eq(pipelines.id, pipelineVersions.pipelineId))
    .where(isNull(pipelines.trialAt))
    .all();
  return versions.some(({ steps }) => (steps as { type?: string; entryAction?: string | null }[]).some((step) => step.type === "module" && step.entryAction === moduleId));
}

/**
 * Archives the draft copies made for one trial that no other trial still
 * holds a grant on and no live work uses, and deletes the trial's grants
 * (EO-583). Part of
 * discarding a trial (`deleteTrialPipelineRows`): a copy existed to be
 * tested there, and left behind it would be a module nobody can run.
 * Archived, never deleted, for the reason every module is.
 */
export function releaseTrialModules(db: Db, trialPipelineId: string, at: number = Date.now()): void {
  const granted = db.select({ moduleId: moduleTrialGrants.moduleId }).from(moduleTrialGrants).where(eq(moduleTrialGrants.trialPipelineId, trialPipelineId)).all();
  db.delete(moduleTrialGrants).where(eq(moduleTrialGrants.trialPipelineId, trialPipelineId)).run();
  for (const moduleId of new Set(granted.map((row) => row.moduleId))) {
    const row = db.select({ forkedFrom: modules.forkedFromModuleId }).from(modules).where(eq(modules.id, moduleId)).get();
    if (row === undefined || row.forkedFrom === null) continue;
    if (db.select({ id: moduleTrialGrants.id }).from(moduleTrialGrants).where(eq(moduleTrialGrants.moduleId, moduleId)).get() !== undefined) continue;
    // A copy is in the ordinary catalogue, so a person can approve it and
    // publish a pipeline that runs it. Once live work uses it, it is no
    // longer the trial's to throw away.
    if (moduleInLiveUse(db, moduleId)) continue;
    db.update(modules).set({ archivedAt: at, updatedAt: at }).where(and(eq(modules.id, moduleId), isNull(modules.archivedAt))).run();
  }
}
