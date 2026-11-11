import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import {
  ActionOverridesSchema,
  addedFieldCollisions,
  EMPTY_SPEC_SHAPE,
  qualifiedItemType,
  SpecShapeSchema,
  uuidv7,
  type ActionOverride,
  type ItemTypeEntry,
  type ItemTypeRef,
  type RecordItemType,
  type SpecShape,
  type Uuid,
} from "@eo/core";
import type { Db } from "../client.js";
import { items, itemTypes, projects } from "../schema.js";

/**
 * One `item_types` row (KAN-129, ARCHITECTURE.md, "An item type is data").
 *
 * `container` is read by the fourteen branches that used to compare a
 * type against a word (KAN-146). `specShape` is a JSON Schema for the
 * item's `spec`, read by creation and by the composed intake schema
 * (KAN-147). `actionOverrides` is refine's two shapes as data (KAN-163):
 * what an action on this kind of item is held to, routes as and is
 * recorded by. It was written from the start so that the row had its
 * final columns before anything depended on them, rather than a migration
 * filling one in later.
 */
export interface ItemType {
  id: Uuid;
  /** The project it belongs to, or null for the installation scope. */
  projectId: Uuid | null;
  packSlug: string;
  slug: string;
  label: string;
  plural: string;
  container: boolean;
  specShape: SpecShape;
  /** By action. Empty when this type has nothing to say about any of them. */
  actionOverrides: Readonly<Record<string, ActionOverride>>;
  createdAt: number;
  /** When it last changed after it was made (EO-735), or null for a type nobody has edited. */
  updatedAt: number | null;
}

/**
 * A spec shape that a person, or a pack, may have written badly.
 *
 * Unparseable is treated as empty rather than thrown: a type row with a
 * malformed shape is that row's problem, and an installation that will
 * not open is not a better answer than a type that asks for no fields.
 *
 * "Empty" is a shape that demands nothing, which is the *permissive*
 * answer — worth saying out loud now that the shape is what creation
 * validates against (KAN-147). A malformed row lets an item through
 * rather than refusing every one of them, on the same reasoning: the row
 * is what is wrong, and an installation that cannot file anything is not
 * a better report of that than an item filed without a field.
 */
function specShapeOf(value: unknown): SpecShape {
  const parsed = SpecShapeSchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY_SPEC_SHAPE;
}

/** The same for the overrides, and for the same reason. */
function actionOverridesOf(value: unknown): Readonly<Record<string, ActionOverride>> {
  const parsed = ActionOverridesSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

function toDomain(row: typeof itemTypes.$inferSelect): ItemType {
  return {
    id: row.id as Uuid,
    projectId: row.projectId as Uuid | null,
    packSlug: row.packSlug,
    slug: row.slug,
    label: row.label,
    plural: row.plural,
    container: row.container,
    specShape: specShapeOf(row.specShape),
    actionOverrides: actionOverridesOf(row.actionOverrides),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? null,
  };
}

/** Which scope a lookup is in: one project's rows, or the installation's. */
function inScope(projectId: Uuid | null) {
  return projectId === null ? isNull(itemTypes.projectId) : eq(itemTypes.projectId, projectId);
}

/**
 * The types one project has, oldest first.
 *
 * `null` is the installation scope — what a pack seeded and what an item
 * written before any repository was attached resolves against.
 */
export function listItemTypes(db: Db, projectId: Uuid | null): ItemType[] {
  return db.select().from(itemTypes).where(inScope(projectId)).orderBy(asc(itemTypes.createdAt), asc(itemTypes.slug)).all().map(toDomain);
}

/** One row as the registry holds it — the same shape a pack declares. */
function toEntry(type: ItemType): ItemTypeEntry {
  return {
    packSlug: type.packSlug,
    slug: type.slug,
    label: type.label,
    plural: type.plural,
    container: type.container,
    specShape: type.specShape,
    actionOverrides: type.actionOverrides,
  };
}

/**
 * This project's types as the registry holds them (KAN-129).
 *
 * The registry's `itemTypes` is populated from here rather than from
 * `DEVELOPER_ITEM_TYPES`: the constants are what the pack *ships*, the
 * rows are what this project *has*, and from the design onwards the two are
 * allowed to differ because a person may add a type of their own.
 *
 * Keyed by `packSlug:slug`, exactly as the registry is and as the
 * table's unique index is: two packs may both ship a `case`, and a map
 * keyed by the word would silently drop one of them.
 */
export function itemTypesFor(db: Db, projectId: Uuid | null): ReadonlyMap<string, ItemTypeEntry> {
  return new Map(listItemTypes(db, projectId).map((type) => [qualifiedItemType(type), toEntry(type)]));
}

/**
 * The types the record holds, paged for a replica catching up (EO-325).
 *
 * `(created_at, id)`, the pair every other list in `record:changes` is
 * read by — see `RecordCursorSchema` for why a timestamp alone is not a
 * cursor.
 *
 * Created rather than updated, because the row carries no `updated_at`:
 * what this list is for is a type *arriving*, which is what a moved
 * project brings with it. A type somebody renames afterwards does not
 * page again, and that is the honest limit of it — publishing
 * configuration to an organisation is 7c's (KAN-122), with a lock and
 * somebody's consent attached.
 */
/**
 * `within` scopes the page to one project (EO-325, review).
 *
 * The move does not restamp what it transfers — a comment written in
 * March is a comment written in March — so a desktop whose cursors had
 * already run past March saw the project row arrive and none of its
 * history behind it. It asks for that history here, on cursors of its
 * own, and the keyset is the same one: the scope narrows, nothing else
 * about the paging changes.
 */
export function listItemTypesSince(db: Db, cursor: { ts: number; id: string }, limit: number, within?: string): ItemType[] {
  return db
    .select()
    .from(itemTypes)
    .where(
      and(
        // By when the row last changed (EO-735): an edited type pages
        // again, so a replica that already holds it takes the edit.
        sql`(coalesce(${itemTypes.updatedAt}, ${itemTypes.createdAt}), ${itemTypes.id}) > (${cursor.ts}, ${cursor.id})`,
        // The project's own types *and* whatever its items are filed
        // under — an item on a moved project may still stand on an
        // installation-wide type, and a desktop that skipped it files
        // the work under a local type sharing the word, or drops it.
        within === undefined
          ? undefined
          : sql`(${itemTypes.projectId} = ${within}
                 or ${itemTypes.id} in (select ${items.typeId} from ${items} where ${items.projectId} = ${within}))`,
      ),
    )
    .orderBy(asc(sql`coalesce(${itemTypes.updatedAt}, ${itemTypes.createdAt})`), asc(itemTypes.id))
    .limit(limit)
    .all()
    .map(toDomain);
}

/** One row as the record carries it to a replica (EO-325) — the pull's shape, and `record:updateItemType`'s answer (EO-735). */
export function recordItemTypeOf(type: ItemType): RecordItemType {
  return {
    id: type.id,
    projectId: type.projectId,
    packSlug: type.packSlug,
    slug: type.slug,
    label: type.label,
    plural: type.plural,
    container: type.container,
    specShape: type.specShape,
    actionOverrides: type.actionOverrides,
    createdAt: type.createdAt,
    updatedAt: type.updatedAt,
  };
}

/**
 * One type from the record, into this replica (EO-325).
 *
 * By the record's own id, which is the whole point: `items.type_id`
 * travels with the item, so a replica that minted a fresh id would hold
 * every moved item's type under a number the item does not name — and
 * `upsertReplicaItem` would fall back to the slug and find the *local*
 * copy, filing somebody's work under a type with the same word and a
 * different shape.
 *
 * Idempotent. A row of another id that already holds the word here is
 * left alone: it is this installation's own, and a pull is not the place
 * to rewrite a type somebody edited in the design's editor. The record's
 * own row, by its id, is the record's: when the record has changed it
 * since this replica's copy (EO-735, `updatedAt`), the copy takes the
 * record's labels, flag, shape and overrides — which is how a field an
 * admin added on the record reaches every desktop holding the type.
 */
export function upsertReplicaItemType(db: Db, type: RecordItemType): "written" | "skipped" {
  // A type scoped to a project this replica has not got. `project_id`
  // is a foreign key, so writing it would throw and take the rest of
  // the page with it — and nulling it would be worse, filing the type
  // in the installation scope where it would shadow one that shares its
  // word. The record does not send these (a project mid-transfer is
  // hidden and so are its types); this is the guard for the case it
  // cannot foresee, such as a project a replica skipped for a key
  // prefix it already had.
  if (type.projectId !== null && db.select({ id: projects.id }).from(projects).where(eq(projects.id, type.projectId)).get() === undefined) {
    return "skipped";
  }
  db.insert(itemTypes)
    .values({
      id: type.id,
      projectId: type.projectId,
      packSlug: type.packSlug,
      slug: type.slug,
      label: type.label,
      plural: type.plural,
      container: type.container,
      specShape: type.specShape as ItemType["specShape"],
      actionOverrides: type.actionOverrides as ItemType["actionOverrides"],
      createdAt: type.createdAt,
      updatedAt: type.updatedAt ?? null,
    })
    .onConflictDoNothing()
    .run();
  if (type.updatedAt !== null && type.updatedAt !== undefined) {
    db.update(itemTypes)
      .set({
        label: type.label,
        plural: type.plural,
        container: type.container,
        specShape: type.specShape as ItemType["specShape"],
        actionOverrides: type.actionOverrides as ItemType["actionOverrides"],
        updatedAt: type.updatedAt,
      })
      .where(and(eq(itemTypes.id, type.id), sql`coalesce(${itemTypes.updatedAt}, 0) < ${type.updatedAt}`))
      .run();
  }
  return "written";
}

/** The row with this id, whatever project it is scoped to. What a reader holding an item asks. */
export function getItemType(db: Db, id: Uuid): ItemType | undefined {
  const row = db.select().from(itemTypes).where(eq(itemTypes.id, id)).get();
  return row ? toDomain(row) : undefined;
}

/**
 * A refusal is a sentence, never an exception.
 *
 * Asking for a type this project does not have is something a person or
 * an agent did — a pack that was never installed, a slug with a typo in
 * it, a type deleted in another window — so it is answered rather than
 * thrown. `slug` is on the result and not only in the sentence, so a
 * caller can say something else about it without parsing prose.
 */
export type ItemTypeResolution = { ok: true; type: ItemType } | { ok: false; slug: string; problem: string };

/** A type named the way a caller happens to know it: a bare word, or the pack's and the word. */
export type ItemTypeName = string | ItemTypeRef;

function refOf(name: ItemTypeName): ItemTypeRef | null {
  return typeof name === "string" ? null : name;
}

function slugOf(name: ItemTypeName): string {
  return typeof name === "string" ? name : name.slug;
}

/**
 * The row behind a name, in this project's scope.
 *
 * A bare word is what almost every caller has — a `story` written in
 * `refine.ts`, a slug an agent answered with — and it is enough while
 * one pack shipped it. Two packs shipping a `case` is the settled case
 * (ARCHITECTURE.md, "An item type is data"), and then the word is a question with two answers: this
 * refuses rather than picking, naming both qualified spellings, and the
 * caller that knows which it meant passes `{ packSlug, slug }`
 * instead. Refusing beats guessing for the reason `PackCollisionError`
 * exists — whichever is dropped is somebody's type, silently.
 */
export function resolveItemType(db: Db, projectId: Uuid | null, name: ItemTypeName): ItemTypeResolution {
  const slug = slugOf(name);
  const ref = refOf(name);
  const matches = db
    .select()
    .from(itemTypes)
    .where(
      ref === null
        ? and(inScope(projectId), eq(itemTypes.slug, slug))
        : and(inScope(projectId), eq(itemTypes.packSlug, ref.packSlug), eq(itemTypes.slug, slug)),
    )
    .orderBy(asc(itemTypes.packSlug))
    .all()
    .map(toDomain);

  const [only, second] = matches;
  if (only !== undefined && second === undefined) return { ok: true, type: only };

  if (second !== undefined) {
    const spellings = matches.map((type) => `"${qualifiedItemType(type)}"`).join(" and ");
    return { ok: false, slug, problem: `More than one pack ships a "${slug}" item type here — ${spellings}. Say which one you mean.` };
  }

  const asked = ref === null ? `"${slug}"` : `"${qualifiedItemType(ref)}"`;
  const known = listItemTypes(db, projectId).map((type) => type.slug);
  const alternatives = known.length === 0 ? "this project has no item types at all." : `this project has ${known.join(", ")}.`;
  return { ok: false, slug, problem: `There is no ${asked} item type here — ${alternatives}` };
}

export interface ItemTypeSeedReport {
  /** `"developer:story"` per row written, so a startup log says what appeared. */
  created: string[];
  /**
   * A pack field named like a field the row's project added (EO-735),
   * one per row and field. The row is left as it is — the seed never
   * merges — and the caller tells the person (`announceAddedFieldCollisions`).
   */
  collisions: AddedFieldCollision[];
}

/** One pack field a type here already has a field of its own under the name of. */
export interface AddedFieldCollision {
  type: ItemType;
  field: string;
}

/**
 * Writes one type exactly as a pack declares it — overrides included.
 *
 * Exported since EO-314, because a data pack's types arrive the same way
 * a code pack's do: `syncItemTypes` seeds what the installed packs ship,
 * and a pack imported as a document seeds what *it* ships. The
 * difference between this and `createItemType` is the overrides, and it
 * is the whole reason both exist — a hand-made type has none by design
 * (ARCHITECTURE.md, "An item type is data", KAN-163), and a pack's type would refine as a leaf on a
 * container without them.
 */
export function insertItemType(db: Db, projectId: Uuid | null, entry: ItemTypeEntry): void {
  db.insert(itemTypes)
    .values({
      id: uuidv7(),
      projectId,
      packSlug: entry.packSlug,
      slug: entry.slug,
      label: entry.label,
      plural: entry.plural,
      container: entry.container,
      specShape: entry.specShape,
      actionOverrides: { ...entry.actionOverrides },
      createdAt: Date.now(),
    })
    .run();
}

/** Whether this scope already has the pack's word — what a seed and an import both ask before writing. */
export function hasItemType(db: Db, projectId: Uuid | null, packSlug: string, slug: string): boolean {
  return (
    db
      .select({ id: itemTypes.id })
      .from(itemTypes)
      .where(and(inScope(projectId), eq(itemTypes.packSlug, packSlug), eq(itemTypes.slug, slug)))
      .get() !== undefined
  );
}

/**
 * Gives a new project its own copy of the installation's types.
 *
 * A project created after this story's migration would otherwise have
 * none, and the first item filed on it would be refused for a type EO
 * ships. Stamped rather than shared so that the design's editor can rename a
 * type on one project without renaming it on every other.
 *
 * Copies what is *there* rather than what a pack declares, on purpose:
 * this runs inside `createProject`, below the layer that knows what a
 * pack is, and the installation scope is exactly the seed `syncItemTypes`
 * keeps current.
 */
export function copyItemTypesToProject(db: Db, projectId: Uuid): number {
  let copied = 0;
  for (const type of listItemTypes(db, null)) {
    if (hasItemType(db, projectId, type.packSlug, type.slug)) continue;
    db.insert(itemTypes)
      .values({
        id: uuidv7(),
        projectId,
        packSlug: type.packSlug,
        slug: type.slug,
        label: type.label,
        plural: type.plural,
        container: type.container,
        specShape: type.specShape,
        actionOverrides: type.actionOverrides,
        createdAt: Date.now(),
      })
      .run();
    copied += 1;
  }
  return copied;
}

/**
 * Seeds every installed pack's item types, on first run and on upgrade.
 *
 * The shape `syncRolePrompts` established (roles/prompts.ts): it runs at
 * every startup, writes only what is missing, and takes effect on the
 * next dispatch rather than underneath a run already in flight. An
 * installation upgraded into KAN-129 got its rows from the migration; an
 * installation that gains a pack — or a pack that gains a type — gets
 * them here, with no first-run flow to go through.
 *
 * **It only ever inserts.** A row that exists is left exactly as it is,
 * because from the design a person may rename a type or change its shape, and
 * a seed that reconciled would quietly undo that on the next launch —
 * the mistake `syncRolePrompts` had to grow provenance to stop making.
 * Bringing an edited type up to a pack's new version is the type
 * editor's business (KAN-164), not this function's. A pack whose type
 * now declares a field under the name of one a project added to it
 * (EO-735) is reported in `collisions` rather than merged: the added
 * field and its items' values stay.
 *
 * Both scopes, because both are real: the installation scope answers for
 * items that belong to no project, and each project carries its own
 * copy.
 *
 * Keyed on `(scope, packSlug, slug)`, which is why two packs that both
 * ship a `case` seed two rows rather than one shadowing the other
 * (ARCHITECTURE.md, "An item type is data").
 */
export function syncItemTypes(db: Db, contributed: readonly ItemTypeEntry[]): ItemTypeSeedReport {
  const created: string[] = [];
  const collisions: AddedFieldCollision[] = [];
  const scopes: (Uuid | null)[] = [null, ...db.select({ id: projects.id }).from(projects).all().map((row) => row.id as Uuid)];

  for (const entry of contributed) {
    for (const scope of scopes) {
      const here = listItemTypes(db, scope).find((type) => type.packSlug === entry.packSlug && type.slug === entry.slug);
      if (here !== undefined) {
        // Kept as it is, as ever; the one thing worth saying is a pack
        // field that would take the name of one this project added.
        for (const field of addedFieldCollisions(here.specShape, entry.specShape)) collisions.push({ type: here, field });
        continue;
      }
      insertItemType(db, scope, entry);
      created.push(qualifiedItemType(entry));
    }
  }

  return { created, collisions };
}

/**
 * How many items are of this type, the Archive included (KAN-164).
 *
 * What the refusal to delete a type names. Archived items count: an
 * archived item still has a type, and dropping the row it points at
 * would leave a foreign key pointing at nothing — the same reason
 * `stepHoldingItems` counts them and then offers the Archive as a second
 * door.
 */
export function countItemsOfType(db: Db, typeId: Uuid): number {
  const row = db.select({ total: count() }).from(items).where(eq(items.typeId, typeId)).get();
  return row?.total ?? 0;
}

/**
 * How many items of this type hold a value for one field (EO-735), the
 * Archive included for the reason `countItemsOfType` gives.
 *
 * What the refusal to remove, rename or re-kind a field names. A value
 * is anything but nothing: a key that is absent, JSON null, an empty
 * text or an empty list holds none, so a field somebody cleared does
 * not keep its definition pinned.
 */
export function countItemsHoldingField(db: Db, typeId: Uuid, field: string): number {
  // Field names are normalised to `[a-z0-9_]` before they reach a shape,
  // but the path is quoted anyway: a pack may name a field anything.
  const path = `$."${field.replace(/["\\]/g, "")}"`;
  const row = db
    .select({ total: count() })
    .from(items)
    .where(
      and(
        eq(items.typeId, typeId),
        sql`coalesce(json_type(${items.spec}, ${path}), 'null') != 'null'`,
        sql`not (json_type(${items.spec}, ${path}) = 'text' and json_extract(${items.spec}, ${path}) = '')`,
        sql`not (json_type(${items.spec}, ${path}) = 'array' and json_array_length(${items.spec}, ${path}) = 0)`,
      ),
    )
    .get();
  return row?.total ?? 0;
}

/** A type as it is created: what the form has, plus the scope and the pack it is filed under. */
export interface NewItemType {
  projectId: Uuid | null;
  packSlug: string;
  slug: string;
  label: string;
  plural: string;
  container: boolean;
  specShape: SpecShape;
}

/**
 * Writes one type (ARCHITECTURE.md, "An item type is data").
 *
 * No action overrides, and that is the whole of "a hand-made leaf type
 * inherits the leaf action defaults": `actionOverrideFor` falls through
 * an empty record to whatever the role that ships the action declared
 * for a leaf, so refine on a hand-made type clarifies without anybody
 * having said so. Writing `CLARIFIES` in here would be this function
 * deciding what an action means, which is the coupling KAN-163 removed.
 */
export function createItemType(db: Db, input: NewItemType): ItemType {
  const id = uuidv7();
  db.insert(itemTypes)
    .values({
      id,
      projectId: input.projectId,
      packSlug: input.packSlug,
      slug: input.slug,
      label: input.label,
      plural: input.plural,
      container: input.container,
      specShape: input.specShape,
      actionOverrides: {},
      createdAt: Date.now(),
    })
    .run();
  return getItemType(db, id)!;
}

/** What an edit may move. Everything optional: a rename sends a label and nothing else. */
export interface ItemTypePatch {
  label?: string;
  plural?: string;
  container?: boolean;
  specShape?: SpecShape;
}

/** Applies an edit and answers with the row as it now stands, or undefined if it is gone. */
export function updateItemType(db: Db, id: Uuid, patch: ItemTypePatch): ItemType | undefined {
  const changes: Record<string, unknown> = {};
  if (patch.label !== undefined) changes.label = patch.label;
  if (patch.plural !== undefined) changes.plural = patch.plural;
  if (patch.container !== undefined) changes.container = patch.container;
  if (patch.specShape !== undefined) changes.specShape = patch.specShape;
  if (Object.keys(changes).length > 0) db.update(itemTypes).set({ ...changes, updatedAt: Date.now() }).where(eq(itemTypes.id, id)).run();
  return getItemType(db, id);
}

/**
 * Removes one type.
 *
 * No archiving, unlike a pipeline: `items.type_id` is a foreign key, so
 * a type with anything filed under it cannot be dropped at all — which
 * is why the caller counts first and refuses. What is left is a type
 * nothing points at, and there is no history in it to keep.
 */
export function deleteItemType(db: Db, id: Uuid): void {
  db.delete(itemTypes).where(eq(itemTypes.id, id)).run();
}
