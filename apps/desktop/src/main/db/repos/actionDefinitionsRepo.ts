import { and, asc, eq } from "drizzle-orm";
import { ActionResultSchema, readActionDefinitionDraft, uuidv7, type ActionDefinition, type ActionDefinitionDraft, type ActionResult } from "@eo/core";
import { z } from "zod";
import type { Db } from "../client.js";
import { actionDefinitions } from "../schema.js";
import { installedRoleShips } from "../../registry.js";

/**
 * The actions roles define for themselves (EO-421).
 *
 * The record and the one function that writes it. What a definition
 * *means* — the schema generated from it, the rule that the dispatched
 * role's own comes first — is `packages/core`'s, and where it meets a
 * dispatch is `registryForProject`.
 */

/**
 * A row's results, narrowed to what they are.
 *
 * Trusted to the extent the row was written through
 * `saveActionDefinition` and no further, for `toFiles`' reason in the
 * skills repository: a JSON column holding something else could only
 * come from a hand-edited database, and it is answered with no results
 * rather than a crash. A definition with none generates a schema no
 * answer satisfies, which is where the registry drops it.
 */
function toResults(value: unknown): ActionResult[] {
  const parsed = z.array(ActionResultSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

function toFields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toDefinition(row: typeof actionDefinitions.$inferSelect): ActionDefinition {
  return {
    id: row.id,
    role: row.role,
    action: row.action,
    description: row.description,
    results: toResults(row.results),
    fields: toFields(row.fields),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Every definition, by role and then action, so two reads of one installation list them alike. */
export function listActionDefinitions(db: Db): ActionDefinition[] {
  return db.select().from(actionDefinitions).orderBy(asc(actionDefinitions.role), asc(actionDefinitions.action)).all().map(toDefinition);
}

/** One role's definitions. */
export function listActionDefinitionsForRole(db: Db, role: string): ActionDefinition[] {
  return db.select().from(actionDefinitions).where(eq(actionDefinitions.role, role)).orderBy(asc(actionDefinitions.action)).all().map(toDefinition);
}

export function getActionDefinition(db: Db, role: string, action: string): ActionDefinition | undefined {
  const row = db
    .select()
    .from(actionDefinitions)
    .where(and(eq(actionDefinitions.role, role), eq(actionDefinitions.action, action)))
    .get();
  return row ? toDefinition(row) : undefined;
}

export type SaveActionDefinitionResult = { ok: true; definition: ActionDefinition } | { ok: false; problems: string[] };

/**
 * Creates a role's definition of an action, or replaces the one it has.
 *
 * **The one write.** Everything that puts a row in this table comes
 * through here — a person's edit, an import, the adoption of a carried
 * schema — so everything in it has passed `readActionDefinitionDraft`:
 * keys a route can name, at least one result, no field shadowing
 * `result` or `summary`, fields ajv compiled, an action some step can
 * dispatch, and not a pack's own role redefining its own shipped action
 * (EO-422).
 *
 * A refusal is the list of sentences and writes nothing; throwing is for
 * programmer error, and a duplicate key is something a person typed.
 *
 * Addressed by role and action rather than by id, because that pair is
 * what the definition *is*: a save of one that exists keeps its id and
 * its creation time and replaces the rest.
 */
export function saveActionDefinition(db: Db, draft: ActionDefinitionDraft, now: number = Date.now()): SaveActionDefinitionResult {
  // Told what the installed packs ship, which is the one rule that is
  // about the installation rather than the draft (EO-422): a pack's own
  // role may not redefine the action that pack ships for it. Asked here
  // because this is the one write, so no caller can leave it out.
  const read = readActionDefinitionDraft(draft, { shipsAction: installedRoleShips });
  if (!read.ok) return { ok: false, problems: read.problems };

  const values = { description: read.description, results: read.results, fields: read.fields, updatedAt: now };
  const existing = getActionDefinition(db, read.role, read.action);

  if (existing) {
    db.update(actionDefinitions).set(values).where(eq(actionDefinitions.id, existing.id)).run();
    return { ok: true, definition: { ...existing, ...values } };
  }

  const row = db
    .insert(actionDefinitions)
    .values({ id: uuidv7(), role: read.role, action: read.action, createdAt: now, ...values })
    .returning()
    .get();
  return { ok: true, definition: toDefinition(row) };
}

/**
 * Removes a role's definition of an action, and says whether there was
 * one (EO-425).
 *
 * The row and nothing else: whether a step still dispatches it is the
 * caller's question, asked where the pipelines are in hand
 * (`deleteRoleActionCommand`).
 */
export function deleteActionDefinition(db: Db, role: string, action: string): boolean {
  const existing = getActionDefinition(db, role, action);
  if (existing === undefined) return false;
  db.delete(actionDefinitions).where(eq(actionDefinitions.id, existing.id)).run();
  return true;
}
