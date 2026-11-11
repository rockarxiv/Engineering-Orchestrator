import { and, asc, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import {
  GIT_EXTENSION,
  isDefaultGitState,
  isDefaultJiraState,
  JIRA_EXTENSION,
  JiraIssueKeySchema,
  jiraStateOf,
  LOCAL_PERSON_ID,
  NO_GIT_STATE,
  NO_ITEM_EXTENSIONS,
  readGitState,
  readJiraState,
  uuidv7,
  type GitItemState,
  type Item,
  type ItemExtensions,
  type JiraItemState,
  type PipelineStepType,
  type RecordCursor,
  type Uuid,
} from "@eo/core";
import type { Db } from "../client.js";
import { newItemEntryRefusal } from "./entryRulesRepo.js";
import { projectForWorkspace } from "./projectsRepo.js";
import { dropWebhookWaiversWithoutEntry } from "./webhookWaiverRepo.js";
import { fromDiscussionOf } from "./jobsRepo.js";
import { extensionsForItem, extensionsForItems, setItemExtension } from "./itemExtensionsRepo.js";
import { getItemType, resolveItemType, type ItemType, type ItemTypeName } from "./itemTypesRepo.js";
import { assigneeOnArrival, type StepOwnership } from "./peopleRepo.js";
import { boundStepFieldSql, ensureCurrentVersion, versionForArrival } from "./pipelineVersionsRepo.js";
import { FOLD_CASE_SQL_FUNCTION, foldCase } from "../textFold.js";
import {
  attachmentRemovals,
  attachments,
  sideCalls,
  projects,
  commentMentions,
  comments,
  itemExtensions,
  itemTypes,
  jobs,
  keyCounters,
  outbox,
  pipelineSteps,
  runEvents,
  runs,
  itemDeps,
  items,
  transitions,
} from "../schema.js";

/** Used only for an item with no workspace — EO before a repo is attached. */
const DEFAULT_KEY_PREFIX = "EO";

/**
 * Every item column, with the type's slug and its container flag where
 * the type column was (KAN-129, KAN-146).
 *
 * `items.type` is a foreign key now, and `Item.type` is still the word —
 * what a person is shown and what a filter matches on. `container` joins
 * it because that is what the branches read (KAN-146): carrying it here
 * means the fourteen sites, the renderer and the engine's item view all
 * get the type's own answer without a second lookup, and none of them
 * has to hold a slug and guess which pack's type it names.
 *
 * One projection rather than a join spelled out per query, so no read
 * path can quietly go back to the raw row and find either field gone.
 */
const itemColumns = { ...getTableColumns(items), type: itemTypes.slug, typeLabel: itemTypes.label, container: itemTypes.container };

type ItemRow = typeof items.$inferSelect & { type: string; typeLabel: string; container: boolean };

/** The item read, joined to its type. Every list and lookup below starts here. */
function selectItems(db: Db) {
  return db.select(itemColumns).from(items).innerJoin(itemTypes, eq(items.typeId, itemTypes.id));
}

/**
 * The rows, with each item's pack state hung on it (KAN-148).
 *
 * A second statement rather than a join, because extensions are many
 * rows per item and a join would multiply the item read by however many
 * packs have spoken. One `in (...)` for the whole page is what keeps a
 * list read two statements instead of one per row.
 *
 * Every read path below goes through `hydrate`, which is the same
 * arrangement `selectItems` has for the type join: a caller cannot
 * quietly go back to the raw row and find `extensions` missing.
 */
function hydrate(db: Db, rows: ItemRow[]): Item[] {
  if (rows.length === 0) return [];
  const extensions = extensionsForItems(db, rows.map((row) => row.id));
  return rows.map((row) => toDomain(row, extensions.get(row.id) ?? NO_ITEM_EXTENSIONS));
}

/** One row, for the lookups that read exactly one. */
function hydrateOne(db: Db, row: ItemRow | undefined): Item | undefined {
  return row ? toDomain(row, extensionsForItem(db, row.id)) : undefined;
}

function toDomain(row: ItemRow, extensions: ItemExtensions): Item {
  return {
    id: row.id as Uuid,
    key: row.key,
    typeId: row.typeId as Uuid,
    type: row.type,
    typeLabel: row.typeLabel,
    container: row.container,
    parentId: row.parentId as Uuid | null,
    workspaceId: row.workspaceId as Uuid | null,
    projectId: row.projectId as Uuid | null,
    title: row.title,
    body: row.body,
    spec: row.spec as Record<string, unknown> | null,
    pipelineId: row.pipelineId as Uuid,
    stepId: row.stepId,
    // The version it entered on (EO-327). Straight off the row: what
    // could validate it is the `pipeline_versions` table, and an id
    // whose row has gone is `graphForItem`'s to answer for — which it
    // does by falling back to the live graph, exactly as a null does.
    pipelineVersionId: row.pipelineVersionId,
    priority: row.priority,
    extensions,
    archivedAt: row.archivedAt,
    heldAt: row.heldAt,
    previewAt: row.previewAt,
    trialAt: row.trialAt,
    createdBy: row.createdBy as Uuid | null,
    assigneeId: row.assigneeId as Uuid | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * "This item is waiting on a backfill" as a WHERE term (KAN-148, EO-127).
 *
 * `json_extract` gives JSON's `true` back as SQLite's 1, which is why
 * this compares against the integer rather than against a boolean.
 * Written once because three readers ask it and a fourth would
 * otherwise spell it a fourth way.
 */
const pullPendingIsSet = sql`json_extract(${itemExtensions.data}, '$.pullPending') = 1`;

/**
 * One item's Jira state, for the paths that hold an id rather than an
 * `Item` (KAN-148).
 *
 * The outbox gates in `commentsRepo`, `attachmentsRepo` and
 * `transitionsRepo` are the callers: each already has the item's row in
 * hand for its repository id, and needs the key and the switch beside
 * it. One row read rather than a whole hydrated item.
 *
 * An item with no `jira` row answers with the defaults, which is what
 * every one of those gates wants: no key, so nothing is queued.
 */
export function jiraStateFor(db: Db, itemId: Uuid | string): JiraItemState {
  const row = db
    .select({ data: itemExtensions.data })
    .from(itemExtensions)
    .where(and(eq(itemExtensions.itemId, itemId), eq(itemExtensions.extension, JIRA_EXTENSION)))
    .get();
  return readJiraState(row?.data);
}

/**
 * Writes it back, or removes the row when there is nothing left to say.
 *
 * The one write path for the `jira` extension: `createItem`,
 * `updateItem`, `linkJiraKey`, `setJiraSync` and `clearJiraPullPending`
 * all end here, so "an all-defaults state leaves no row" is decided
 * once rather than at five call sites.
 */
function setJiraState(db: Db, itemId: Uuid | string, next: JiraItemState): void {
  setItemExtension(db, itemId, JIRA_EXTENSION, isDefaultJiraState(next) ? null : next);
}

/**
 * One item's git state, for the paths that hold an id rather than an
 * `Item` (KAN-169).
 *
 * The read half of the same arrangement `jiraStateFor` has, and it
 * exists for `updateItem`'s sake: a patch that names only the pull
 * request must leave the branch where it was, which means reading the
 * row before writing it. Private, where `jiraStateFor` is exported,
 * because nothing outside this file holds an item id and wants only the
 * git state — the outbox gates that do that for Jira have no
 * counterpart here.
 */
function gitStateFor(db: Db, itemId: Uuid | string): GitItemState {
  const row = db
    .select({ data: itemExtensions.data })
    .from(itemExtensions)
    .where(and(eq(itemExtensions.itemId, itemId), eq(itemExtensions.extension, GIT_EXTENSION)))
    .get();
  return readGitState(row?.data);
}

/**
 * Writes it back, or removes the row when there is nothing left to say.
 *
 * The one write path for the `git` extension, for `setJiraState`'s
 * reason: an item whose branch and pull request are both gone leaves no
 * row, decided here rather than at each caller.
 */
function setGitState(db: Db, itemId: Uuid | string, next: GitItemState): void {
  setItemExtension(db, itemId, GIT_EXTENSION, isDefaultGitState(next) ? null : next);
}

/**
 * Atomically allocates the next sequential value for a key prefix — one
 * INSERT .. ON CONFLICT .. RETURNING statement, safe under back-to-back
 * synchronous calls since better-sqlite3 serializes all access from this
 * process and there is only ever one writer (ARCHITECTURE.md, "Capacity and concurrency":
 * concurrency stays at 1).
 */
function nextKeyValue(db: Db, prefix: string): number {
  const row = db
    .insert(keyCounters)
    .values({ prefix, nextValue: 1 })
    .onConflictDoUpdate({
      target: keyCounters.prefix,
      set: { nextValue: sql`${keyCounters.nextValue} + 1` },
    })
    .returning({ nextValue: keyCounters.nextValue })
    .get();
  return row.nextValue;
}

/** The next key in a prefix's sequence — `EO-52` after `EO-51`. */
function mintKey(db: Db, prefix: string): string {
  return `${prefix}-${nextKeyValue(db, prefix)}`;
}

export interface CreateItemInput {
  /**
   * Which type, by the word or by the pack and the word (KAN-129).
   *
   * A bare slug is what every caller in EO passes — one pack ships
   * `story` and the word is unambiguous. `{ packSlug, slug }` is for the
   * case the design settles: two packs both shipping a `case`, where the word
   * alone names two rows and `resolveItemType` refuses rather than
   * picking one.
   */
  type: ItemTypeName;
  parentId?: Uuid | null;
  /**
   * Where the work happens. Omitted only before a workspace is attached,
   * or for a feature on a project spanning several of them (KAN-17).
   */
  workspaceId?: Uuid | null;
  /** Which project it appears on. Not derivable from the workspace — an item may have none, and a workspace outlives its project. */
  projectId?: Uuid | null;
  title: string;
  body?: string | null;
  spec?: Record<string, unknown> | null;
  /**
   * The step it starts on, or null for a feature (ARCHITECTURE.md, "One work entity") — a container
   * is
   * not on a pipeline at all.
   */
  stepId: string | null;
  /**
   * Which pipeline it flows through.
   *
   * Optional because a step id already determines it — a step belongs to
   * exactly one pipeline — so callers that know the step need not repeat
   * themselves, and cannot contradict themselves either.
   */
  pipelineId?: Uuid | null;
  priority?: number;
  /**
   * When this item was made as a preview (EO-313, ARCHITECTURE.md, "Preview").
   *
   * Omitted is real work, which is every caller in EO today: the
   * template button that mints a preview is the sixth story of this
   * phase. Passed as the timestamp rather than as a boolean so the
   * caller decides what "now" means, exactly as `archivedAt` is set.
   */
  previewAt?: number | null;
  /**
   * When this item was filed on a trial pipeline (EO-582,
   * ARCHITECTURE.md, "Trial pipelines"). Omitted is live work; only
   * `fileTrialItem` passes it.
   */
  trialAt?: number | null;
  /**
   * What the git workspace already knows about it (KAN-169).
   *
   * The extension as a nested object rather than a `branch` field on
   * this input: a kind's state arrives under the kind that owns it, so
   * the next kind with something to say about a new item adds a key
   * here instead of another top-level field. Omitted is the ordinary
   * case — an item is created before anything cuts a branch for it.
   */
  git?: Partial<GitItemState>;
  /** Set when the item came from, or was mirrored to, a Jira issue (J-02, J-03). */
  jiraKey?: string | null;
  jiraId?: string | null;
  /**
   * Whether this item talks to Jira at all (EO-122). Omitted means
   * "inherit", which is `resolveJiraSync`'s job.
   */
  jiraSync?: boolean;
  /**
   * Overrides the project-derived key prefix.
   *
   * Used by the conversation rooms, whose items exist for
   * the sake of runs and durability but are not work. Numbering them
   * `EO-51`, `EO-52` would interleave chats with stories in a sequence
   * people read and quote, so they get their own counter — `key_counters`
   * is already keyed by prefix, so this is a different row rather than a
   * different mechanism.
   */
  keyPrefix?: string;
  /**
   * Who filed it (EO-302, ARCHITECTURE.md, "Identity").
   *
   * Defaults to the local person, because in solo mode every item EO
   * creates is created by the one person there is: they typed it, or
   * pressed Create in a conversation, or approved a plan an agent
   * proposed. The agent is not a candidate — it ran because somebody
   * asked it to, on their machine.
   *
   * A caller that knows better says so, and one does: importing a Jira
   * issue passes `null`, because somebody filed that issue somewhere EO
   * has no person row for, and naming the importer would be recording
   * a fact that is not true.
   */
  createdBy?: Uuid | null;
}

/**
 * The kind and owner of the step an item is being created on, for
 * `assigneeOnArrival` (EO-305, EO-323).
 *
 * Three columns rather than the step, because this asks the row a
 * question rather than reading it: `getStep` lives in
 * `pipelineStepsRepo`, which reads items back, and a new item does not
 * need a whole step to find out who is waiting on it.
 *
 * `owner_group_id` is the third, and was missing for a round: a step
 * offered to a team was read as a step offered to nobody, so on a
 * machine that knows one person every item arriving there was assigned
 * to them under a column head saying anybody could claim it.
 */
function stepFor(db: Db, stepId: string | null): StepOwnership | undefined {
  if (stepId === null) return undefined;
  const row = db
    .select({ type: pipelineSteps.type, ownerPersonId: pipelineSteps.ownerPersonId, ownerGroupId: pipelineSteps.ownerGroupId })
    .from(pipelineSteps)
    .where(eq(pipelineSteps.id, stepId))
    .get();
  return row === undefined
    ? undefined
    : { type: row.type as PipelineStepType, ownerPersonId: row.ownerPersonId as Uuid | null, ownerGroupId: row.ownerGroupId };
}

/**
 * The pipeline a new item belongs to.
 *
 * Derived from the step unless the caller said otherwise: a step belongs
 * to exactly one pipeline, so asking for both invites the two to disagree.
 */
function resolvePipelineId(db: Db, input: CreateItemInput): string | null {
  if (input.pipelineId !== undefined) return input.pipelineId;
  // No step means no pipeline: a feature belongs to neither.
  if (input.stepId === null) return null;
  const step = db.select({ pipelineId: pipelineSteps.pipelineId }).from(pipelineSteps).where(eq(pipelineSteps.id, input.stepId)).get();
  if (!step) throw new Error(`no pipeline step "${input.stepId}" — a ticket cannot start on a step that does not exist`);
  return step.pipelineId;
}

/**
 * The version of that pipeline the item binds to (EO-327, ARCHITECTURE.md, "Publish, lock and
 * versions").
 *
 * `ensureCurrentVersion` rather than `currentVersion`, deliberately: a
 * pipeline that has never been saved since versions existed — the one
 * every installation is seeded with, and every one a pack install wrote
 * step by step — has a graph and no document of it, and the item
 * entering *is* the moment that document starts to matter. Filing it
 * here means the first save after this can be an ordinary save rather
 * than the one that strands whatever is already standing there.
 */
function versionOnEntry(db: Db, pipelineId: string | null, stepId: string | null): string | null {
  if (pipelineId === null) return null;
  // `versionForArrival` rather than flatly the current version, for the
  // reason a hand-off uses it: an item filed straight onto a step — a
  // job stamping one onto "Approve", an import putting work back where
  // it was — is standing there, and if that step has since been retired
  // the current version has no definition for it and no route out. The
  // answer is the current version for every step that is part of the
  // graph, which is every one an editor or a job can name today.
  if (stepId !== null) return versionForArrival(db, pipelineId, stepId)?.id ?? null;
  return ensureCurrentVersion(db, pipelineId)?.id ?? null;
}

/**
 * Whether a new item talks to Jira (EO-122).
 *
 * What the caller said, when it said anything. Otherwise the parent's
 * value — a story created under a feature whose sync is off is created
 * off, so decomposing a silenced feature does not produce five stories
 * that immediately start pushing to Jira on the feature's behalf.
 *
 * Copied once, here, rather than read through the parent on every gate.
 * The parent may be archived, deleted or re-parented later, and a gate
 * that walked up the tree would give a different answer on different
 * days for an item nobody touched.
 *
 * On by default, with no parent: that is what every item did before
 * this column existed, and what the migration gives every row that
 * predates it.
 */
function resolveJiraSync(db: Db, input: CreateItemInput): boolean {
  if (input.jiraSync !== undefined) return input.jiraSync;
  const parentId = input.parentId ?? null;
  if (parentId === null) return true;
  // A parent id naming no row is somebody else's problem — the foreign
  // key will say so — and guessing `false` here would silence an item
  // over a reference that was never valid. A parent with no `jira` row
  // has never said anything about Jira, and the accessor's default is
  // the same `true` the column had.
  return jiraStateFor(db, parentId).sync;
}

/**
 * An item, or the reason there is no item (KAN-129).
 *
 * A type is a row scoped to a project now, so "create a story here" is a
 * request that can be refused: this project may never have had that
 * type, or the configure screen (ARCHITECTURE.md, "An item type is data") may have removed it. That
 * is
 * something a person or an agent asked for and got wrong, which the
 * working agreement answers with a typed result rather than an
 * exception — and `slug` is a field rather than only a word in the
 * sentence, so a caller can say something else about it without reading
 * prose back.
 *
 * The same shape `linkJiraKey` and `setJiraSync` already answer in, for
 * the same reason.
 */
export type CreateItemResult = { ok: true; item: Item } | { ok: false; slug: string; problem: string; refusedAtEntry?: true };

/**
 * Why a pipeline's entry rules refuse what this input would create, or
 * null (EO-610, ARCHITECTURE.md, "Entry rules").
 *
 * Exported for a plan, which has to refuse whole before its first row: by
 * the time `createItem` meets a story that fails, others have been written.
 * A rehearsal is exempt, and an item on no pipeline has nothing to enter.
 */
export function creationRefusal(db: Db, input: CreateItemInput, type: ItemType): string | null {
  const pipelineId = resolvePipelineId(db, input);
  if (pipelineId === null || input.trialAt != null || input.previewAt != null) return null;
  const extensions = { [JIRA_EXTENSION]: { key: input.jiraKey ?? null }, [GIT_EXTENSION]: input.git ?? {} };
  return newItemEntryRefusal(
    db,
    {
      pipelineId,
      stepId: input.stepId,
      type,
      body: input.body ?? null,
      spec: input.spec ?? null,
      hasWorkspace: (input.workspaceId ?? null) !== null,
      extensions,
    },
    itemAsItWouldEnter(db, input, type, pipelineId),
  );
}

/**
 * The item this input would create, as an entry check reads it (EO-736):
 * every field the row would carry, with an id that names no row and no
 * key, because neither exists until it is let in. Never written.
 */
function itemAsItWouldEnter(db: Db, input: CreateItemInput, type: ItemType, pipelineId: string): Item {
  const git: GitItemState = { ...NO_GIT_STATE, ...input.git };
  const jira: JiraItemState = { key: input.jiraKey ?? null, id: input.jiraId ?? null, sync: resolveJiraSync(db, input), pullPending: false };
  return {
    id: uuidv7() as Uuid,
    key: "",
    typeId: type.id as Uuid,
    type: type.slug,
    typeLabel: type.label,
    container: type.container,
    parentId: input.parentId ?? null,
    workspaceId: input.workspaceId ?? null,
    projectId: input.projectId ?? null,
    title: input.title,
    body: input.body ?? null,
    spec: input.spec ?? null,
    pipelineId: pipelineId as Uuid,
    stepId: input.stepId,
    pipelineVersionId: null,
    priority: input.priority ?? 0,
    extensions: {
      ...(isDefaultJiraState(jira) ? {} : { [JIRA_EXTENSION]: jira }),
      ...(isDefaultGitState(git) ? {} : { [GIT_EXTENSION]: git }),
    },
    archivedAt: null,
    heldAt: null,
    previewAt: null,
    trialAt: null,
    createdBy: input.createdBy === undefined ? LOCAL_PERSON_ID : input.createdBy,
    assigneeId: null,
    createdAt: 0,
    updatedAt: 0,
  } as Item;
}

export function createItem(db: Db, input: CreateItemInput): CreateItemResult {
  const workspaceId = input.workspaceId ?? null;
  const projectId = input.projectId ?? null;
  // Before the key is minted, for the reason the Jira key is checked
  // before the insert: a refusal has to leave nothing behind, and
  // `nextKeyValue` moves the project's counter on whether or not the
  // row that asked for it ever appears.
  const type = resolveItemType(db, projectId, input.type);
  if (!type.ok) return { ok: false, slug: type.slug, problem: type.problem };
  // There for the same reason, and the one place every door passes
  // through, so no door needs a guard of its own (EO-610).
  const refused = creationRefusal(db, input, type.type);
  if (refused !== null) return { ok: false, slug: type.type.slug, problem: refused, refusedAtEntry: true };

  const key = mintKey(db, input.keyPrefix ?? keyPrefixFor(db, workspaceId, projectId));
  const now = Date.now();
  const jiraSync = resolveJiraSync(db, input);
  const jiraKey = input.jiraKey ?? null;
  // Resolved once: the row names it, and so does the version the item
  // binds to (EO-327), and asking twice invites the two to differ.
  const pipelineId = resolvePipelineId(db, input);

  // The row and its pack state land together (KAN-148). Two statements
  // where there was one, and an item that exists with its `jira` row
  // missing would be an item whose key nothing can find and whose
  // backfill nothing will ask for.
  const row = db.transaction((tx) => {
    const inserted = tx
      .insert(items)
      .values({
        id: uuidv7(),
        key,
        typeId: type.type.id,
        parentId: input.parentId ?? null,
        workspaceId,
        projectId,
        title: input.title,
        body: input.body ?? null,
        spec: input.spec ?? null,
        pipelineId,
        stepId: input.stepId,
        // The version it entered on, and the one it finishes on
        // (EO-327, ARCHITECTURE.md, "Publish, lock and versions"). Read here rather than left for
        // the first
        // transition: an item that is saved onto a step has already
        // entered, and a save made before it first moves would
        // otherwise re-route it by a graph it never saw.
        pipelineVersionId: versionOnEntry(db, pipelineId, input.stepId),
        priority: input.priority ?? 0,
        previewAt: input.previewAt ?? null,
        trialAt: input.trialAt ?? null,
        createdBy: input.createdBy === undefined ? LOCAL_PERSON_ID : input.createdBy,
        // An item created straight onto a human step has arrived on one
        // (EO-305, ARCHITECTURE.md, "The board"), so it is assigned by the same rule
        // `transitionItem` applies to one that walked there: the step's
        // person, the local person in solo mode, or nobody. A job
        // stamping its item onto "Approve" is the case — nothing moved
        // it there, and a card nobody holds because of how it was born
        // is the same unclaimed card either way.
        assigneeId: assigneeOnArrival(db, stepFor(db, input.stepId)) ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    // Written only when there is something to write — `setJiraState`
    // drops an all-defaults state, so an item Jira has never heard of
    // leaves no extension row at all.
    const jira: JiraItemState = {
      key: jiraKey,
      id: input.jiraId ?? null,
      sync: jiraSync,
      // An item that arrives already attached is attached, and the
      // backfill is the same one `linkJiraKey` asks for (EO-127) — a
      // key handed to `work_submit_ticket` or `work_submit_plan` must
      // not read its issue any less than the same key sent to
      // `ticket_update` a second later would.
      //
      // Not for an item EO is creating the Jira issue *for*
      // (`jira/push.ts` writes the key through `updateItem`, which
      // leaves this alone): there is nothing on the far side to read
      // back that EO did not just send.
      pullPending: jiraKey !== null && jiraSync,
    };
    setJiraState(tx as unknown as Db, inserted.id as Uuid, jira);

    // The same for the git kind, and the same "only when there is
    // something to write". Skipped outright when there is nothing,
    // which is nearly every call: an item is created before anything
    // cuts a branch for it, and a fresh row has no extension row to
    // delete.
    const git: GitItemState = { ...NO_GIT_STATE, ...input.git };
    if (!isDefaultGitState(git)) setGitState(tx as unknown as Db, inserted.id as Uuid, git);

    return { ...inserted, jira, git };
  });

  const { jira, git, ...created } = row;
  return {
    ok: true,
    item: toDomain({ ...created, type: type.type.slug, typeLabel: type.type.label, container: type.type.container }, {
      ...(isDefaultJiraState(jira) ? {} : { [JIRA_EXTENSION]: jira }),
      ...(isDefaultGitState(git) ? {} : { [GIT_EXTENSION]: git }),
    }),
  };
}

/**
 * Which counter a new item's key comes from.
 *
 * The project's prefix, whichever repository the item is routed to
 * (KAN-128). A project spanning a UI repository and a backend one numbers
 * the stories in both from one sequence, because they are one project's
 * work — and its features, which name no repository at all, come from the
 * same one rather than a second counter that happened to agree.
 *
 * An item naming only a workspace takes that workspace's project. Every
 * attached workspace has one, and for the ordinary single-repo
 * installation it is the project carrying the prefix the person chose —
 * so nothing about the keys that installation mints changes. A workspace whose project was deleted has
 * none, and its items fall to the last resort below.
 *
 * `EO` remains the last resort, for items written before any workspace
 * was attached.
 *
 * `~/.eo/worktrees/<KEY>` stays collision-free throughout, for the reason
 * it always did: it is named after a key, and a key is unique because the
 * counter behind its prefix hands each number out once.
 */
function keyPrefixFor(db: Db, workspaceId: Uuid | null, projectId: Uuid | null): string {
  if (projectId !== null) {
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (project) return project.keyPrefix;
  }
  if (workspaceId !== null) {
    const project = projectForWorkspace(db, workspaceId);
    if (project) return project.keyPrefix;
  }
  return DEFAULT_KEY_PREFIX;
}

/**
 * Items the record has touched since a point, oldest first (EO-324).
 *
 * The item half of `record:changes`. `updatedAt` is the cursor because
 * it is the column every write to an item moves, the transition writer
 * included — so "what has changed" is one comparison rather than a
 * union of four. Paired with the id, for the reason `RecordCursor`
 * gives: several items move in one millisecond routinely.
 *
 * Archived items are in it deliberately. A replica that stopped hearing
 * about an item the moment it was archived would keep drawing it on the
 * board forever; the archive is a mark on the row (KAN-33), and the
 * mark is exactly what has to arrive.
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
export function listItemsUpdatedSince(db: Db, cursor: RecordCursor, limit: number, within?: string): Item[] {
  const rows = selectItems(db)
    // Strictly after the pair, which is what makes the page exact: an
    // item sharing a millisecond with the last one sent is *after* it by
    // id and arrives on the next page, where a plain `>` on the
    // timestamp would drop it and a `>=` would re-send the whole
    // instant for ever.
    .where(
      and(
        sql`(${items.updatedAt} > ${cursor.ts} or (${items.updatedAt} = ${cursor.ts} and ${items.id} > ${cursor.id}))`,
        within === undefined ? undefined : eq(items.projectId, within),
      ),
    )
    .orderBy(asc(items.updatedAt), asc(items.id))
    .limit(limit)
    .all();
  return hydrate(db, rows);
}

export function getItem(db: Db, id: Uuid): Item | undefined {
  return hydrateOne(db, selectItems(db).where(eq(items.id, id)).get());
}

/**
 * One item by its human key — "EO-42".
 *
 * Keys are what a person types and what an agent is shown, so anything
 * taking a reference from outside the database takes one of these: the
 * Discussions's `ticket_detail` tool, and the proposals that name a
 * parent or a dependency.
 *
 * Deliberately finds archived items too. This is a lookup, not a
 * policy — "EO-42 is archived" is a far better answer than "EO-42 does
 * not exist", and the callers that care decide what to do about it.
 */
export function getItemByKey(db: Db, key: string): Item | undefined {
  return hydrateOne(db, selectItems(db).where(eq(items.key, key)).get());
}

/**
 * The item mirroring one Jira issue, if any.
 *
 * One issue is one item (the pinned decision on EO-121), and this is
 * the query that keeps it true: `linkJiraKey` refuses a key this already
 * finds, and `importIssue` treats a re-import of a known key as opening
 * what exists rather than making a second copy.
 *
 * Archived items count (KAN-33). An archived item is still a claim
 * on that issue — skipping it would let the key be handed to a second
 * item, and `jira/pull.ts`, which maps a Jira key back to an item,
 * would then have two answers.
 */
export function getItemByJiraKey(db: Db, jiraKey: string): Item | undefined {
  const row = selectItems(db)
    .innerJoin(itemExtensions, and(eq(itemExtensions.itemId, items.id), eq(itemExtensions.extension, JIRA_EXTENSION)))
    .where(eq(sql`json_extract(${itemExtensions.data}, '$.key')`, jiraKey))
    .get();
  return hydrateOne(db, row);
}

/**
 * "This item is real work rather than a preview" as a WHERE term
 * (EO-313, ARCHITECTURE.md, "Preview").
 *
 * The archive is the only reader in this file. The `!` marker in
 * `commentsRepo` and the cross-item cost sums in `runsRepo` ask the
 * same question of their own statements, in the raw SQL each of them is
 * already written in.
 */
const NOT_A_PREVIEW = isNull(items.previewAt);

/**
 * Every *live* item, or only one workspace's.
 *
 * `undefined` means all of them, which is what the engine wants — it
 * advances every workspace, not whichever one the window happens to be
 * showing. Passing `null` means the items that belong to no workspace.
 *
 * **Archived items are excluded** (KAN-33), and this is the seam that
 * makes that true everywhere at once: the project, the inbox, the
 * scheduler's tick input, the ready set and mention-driven dispatch all
 * read through here or through `listItemsForProject`. Filtering in each
 * of them instead would be five chances to forget, and the one that
 * matters — an item invisible on the project but still handed to an
 * agent — is the one nobody would notice.
 *
 * The few callers that genuinely need everything say so, by name:
 * `listItemsIncludingArchived`.
 */
export function listItems(db: Db, workspaceId?: Uuid | null): Item[] {
  const live = isNull(items.archivedAt);
  if (workspaceId === undefined) return hydrate(db, selectItems(db).where(live).all());
  const owner = workspaceId === null ? isNull(items.workspaceId) : eq(items.workspaceId, workspaceId);
  return hydrate(db, selectItems(db).where(and(live, owner)).all());
}

/**
 * Archived ones too (KAN-33).
 *
 * For the handful of questions that are about an item's *existence*
 * rather than about the working project: has this Jira issue already been
 * imported, does any item still sit in the workflow state someone is
 * deleting, whose worktree is this on disk. Answering those from the
 * live set would let an archived item be imported twice, or a state
 * be deleted out from under one.
 */
export function listItemsIncludingArchived(db: Db, workspaceId?: Uuid | null): Item[] {
  if (workspaceId === undefined) return hydrate(db, selectItems(db).all());
  const where = workspaceId === null ? isNull(items.workspaceId) : eq(items.workspaceId, workspaceId);
  return hydrate(db, selectItems(db).where(where).all());
}

/**
 * The items filed under one container, archived ones too (EO-596).
 *
 * For whether the container's work has finished: an archived item is one
 * that finished, and leaving it out would make a container whose
 * children were all swept to the Archive look as though it held none.
 */
export function listChildItemsIncludingArchived(db: Db, parentId: string): Item[] {
  return hydrate(db, selectItems(db).where(eq(items.parentId, parentId)).all());
}

/**
 * Every item on one step, archived ones too (EO-552).
 *
 * For a room that is a step — the assistant's chats are the items on
 * `assist` — and asks about its own items, which used to read every
 * item in the database to keep the few on that step.
 */
export function listItemsOnStepIncludingArchived(db: Db, stepId: string): Item[] {
  return hydrate(db, selectItems(db).where(eq(items.stepId, stepId)).all());
}

/**
 * The live items on one project (KAN-17).
 *
 * Deliberately not "the items of this project's workspaces": a workspace
 * outlives the project it was attached to, so membership alone would
 * show work on a project that no longer holds it. The item says which
 * project it is on, and this trusts it.
 *
 * `null` means the items on no project, which is what onboarding looks
 * like before a repo is attached.
 */
export function listItemsForProject(db: Db, projectId: Uuid | null, filters: ItemRowFilters = {}): Item[] {
  const owner = projectId === null ? isNull(items.projectId) : eq(items.projectId, projectId);
  return hydrate(db, selectItems(db).where(and(isNull(items.archivedAt), owner, ...itemRowTerms(filters))).all());
}

/**
 * What an item list may be narrowed by in its own WHERE clause (EO-539).
 *
 * Every filter `items:list` and `items:listArchived` take, plus
 * `parentIds`, for reading only the stories under the containers a
 * narrowed list kept. Every one absent means what it always did — no
 * term at all — and every one given is a term of the one statement that
 * reads the rows, so nothing is hydrated only to be thrown away.
 */
export interface ItemRowFilters {
  stepId?: string | undefined;
  /** The step's name as the item's own version gives it, without regard to case. */
  stepName?: string | undefined;
  pipelineId?: string | undefined;
  /** The type's slug, as `Item.type` carries it. */
  type?: string | undefined;
  /** The key of the container the items are filed under. */
  parentKey?: string | undefined;
  parentIds?: readonly string[] | undefined;
  keys?: readonly string[] | undefined;
  /** A substring of the title, without regard to case in any script. */
  text?: string | undefined;
  createdSince?: number | undefined;
  updatedSince?: number | undefined;
  /**
   * Standing on a terminal step of its own version, or not. A container
   * stands on no step, so it is never finished this way and `false`
   * keeps it — as the board's own `atTerminalStep` reports it.
   */
  atTerminalStep?: boolean | undefined;
}

/** The filters as WHERE terms, for the item reads joined to their type by `selectItems`. */
function itemRowTerms(filters: ItemRowFilters): SQL[] {
  const terms: SQL[] = [];
  if (filters.stepId !== undefined) terms.push(eq(items.stepId, filters.stepId));
  // By the step as the item's own version names it (EO-327), which is
  // what the board calls it: a step renamed since the item entered is
  // still called what it was, for that item. A container stands on none.
  if (filters.stepName !== undefined) {
    terms.push(sql`(${items.stepId} is not null and ${foldCaseSql(boundStepFieldSql("name"))} = ${foldCase(filters.stepName)})`);
  }
  if (filters.atTerminalStep === true) terms.push(sql`(${items.stepId} is not null and ${boundStepFieldSql("isTerminal")} = 1)`);
  if (filters.atTerminalStep === false) terms.push(sql`(${items.stepId} is null or ${boundStepFieldSql("isTerminal")} <> 1)`);
  if (filters.pipelineId !== undefined) terms.push(eq(items.pipelineId, filters.pipelineId));
  if (filters.type !== undefined) terms.push(eq(itemTypes.slug, filters.type));
  // A subquery rather than a lookup first, so a key naming nothing is an
  // empty answer from the same statement rather than a second read.
  if (filters.parentKey !== undefined) terms.push(sql`${items.parentId} in (select "parent"."id" from "items" as "parent" where "parent"."key" = ${filters.parentKey})`);
  if (filters.parentIds !== undefined) terms.push(filters.parentIds.length === 0 ? sql`0` : inArray(items.parentId, [...filters.parentIds]));
  if (filters.keys !== undefined) terms.push(filters.keys.length === 0 ? sql`0` : inArray(items.key, [...filters.keys]));
  // `instr` rather than `like`, so a `%` or `_` in what was typed is the
  // character it looks like rather than a wildcard; folded by EO's own
  // function rather than `lower()`, which knows only ASCII (textFold.ts).
  if (filters.text !== undefined) terms.push(sql`instr(${foldCaseSql(items.title)}, ${foldCase(filters.text)}) > 0`);
  if (filters.createdSince !== undefined) terms.push(gte(items.createdAt, filters.createdSince));
  if (filters.updatedSince !== undefined) terms.push(gte(items.updatedAt, filters.updatedSince));
  return terms;
}

/** `foldCase` applied in the query, by the function `openDb` registers on the connection. */
function foldCaseSql(value: SQL | typeof items.title): SQL {
  return sql`${sql.raw(FOLD_CASE_SQL_FUNCTION)}(${value})`;
}

/**
 * These items, archived or not, by id (EO-539).
 *
 * For the reads that need a handful of particular items — the
 * dependencies of one page of a list — rather than every item there is.
 */
export function listItemsByIds(db: Db, ids: readonly string[]): Item[] {
  if (ids.length === 0) return [];
  return hydrate(db, selectItems(db).where(inArray(items.id, [...ids])).all());
}

/**
 * The projects whose live work stands on this pipeline, each once —
 * `null` for work on no project (EO-514).
 *
 * What an unadopted pipeline is staffed by is asked of these
 * (`staffedRolesForPipeline`): it belongs to whichever project is
 * asking, so the scheduler staffs each of its items by that item's own
 * project. A preview is left out, for the reason a preview's agent is
 * (EO-316): a rehearsal is not work anybody is waiting on.
 */
export function projectsWithWorkOnPipeline(db: Db, pipelineId: string): (Uuid | null)[] {
  return db
    .selectDistinct({ projectId: items.projectId })
    .from(items)
    .where(and(eq(items.pipelineId, pipelineId), isNull(items.archivedAt), isNull(items.previewAt)))
    .all()
    .map((row) => row.projectId as Uuid | null);
}

/**
 * What the archive view shows: everything put away, most recently
 * archived first.
 *
 * **Never a preview** (EO-313, ARCHITECTURE.md, "Preview"). The archive is the record of work
 * this project did, and a preview is the one thing on the board that
 * never happened — an item whose whole purpose was to be watched once
 * and thrown away. Excluded here rather than in the view, on the seam
 * `listItems` uses for archived items, so the count, the rows and
 * anything else that ever reads the archive cannot come to different
 * answers.
 */
export function listArchivedItems(db: Db, projectId?: Uuid | null, filters: ItemRowFilters = {}): Item[] {
  // Nor a trial item (EO-582, ARCHITECTURE.md, "Trial pipelines"): it
  // was filed to test a draft, and is deleted with its trial.
  const archived = and(isNotNull(items.archivedAt), NOT_A_PREVIEW, isNull(items.trialAt));
  const owner = projectId === undefined ? undefined : projectId === null ? isNull(items.projectId) : eq(items.projectId, projectId);
  return hydrate(db, selectItems(db).where(and(archived, owner, ...itemRowTerms(filters))).orderBy(desc(items.archivedAt)).all());
}

/**
 * Puts an item away, or brings it back (KAN-33).
 *
 * `updatedAt` is deliberately left alone. Archiving is not an edit to
 * the work, and bumping it would reorder every "recently touched" view
 * on the day the sweep happens to run.
 */
export function setItemArchived(db: Db, id: Uuid, archivedAt: number | null): void {
  db.update(items).set({ archivedAt }).where(eq(items.id, id)).run();
}

/**
 * Parks one item without editing or transitioning it (EO-45).
 *
 * Like archiving, holding is scheduling metadata rather than an edit to
 * the work, so it deliberately leaves `updatedAt`, `pipelineId` and
 * `stepId` untouched.
 */
export function setItemHeld(db: Db, id: Uuid, heldAt: number | null): void {
  db.update(items).set({ heldAt }).where(eq(items.id, id)).run();
}

/**
 * Says who has an item, without moving it (EO-305, ARCHITECTURE.md, "The board").
 *
 * A claim is an assignee change plus a comment, not a transition
 * (ARCHITECTURE.md, "Identity") — so this writes one column and leaves
 * `stepId`, `pipelineId` and `heldAt` exactly as they were. Invariant #1
 * is untouched: nothing here can change which step an item is on.
 *
 * `updatedAt` moves, unlike archiving and holding. Who is holding a
 * piece of work *is* a fact about the work — it is what the card's
 * assignee slot reads and what an inbox row says — so a board ordered
 * by recency should show the item somebody just took.
 */
export function setItemAssignee(db: Db, id: Uuid, assigneeId: Uuid | null): void {
  db.update(items).set({ assigneeId, updatedAt: Date.now() }).where(eq(items.id, id)).run();
}

/** The pure scheduler receives held ids as data rather than reading the DB. */
export function listHeldItemIds(db: Db): Set<string> {
  const rows = db
    .select({ id: items.id })
    .from(items)
    .where(and(isNull(items.archivedAt), isNotNull(items.heldAt)))
    .all();
  return new Set(rows.map((row) => row.id));
}

/**
 * Hands items that predate every workspace to the first one.
 *
 * EO is usable before a repo is attached and those items are real
 * work; without this they would vanish from the project the moment the
 * user finished onboarding (D-04).
 */
export function adoptProjectlessItems(db: Db, workspaceId: Uuid, projectId: Uuid): number {
  const orphans = listItems(db, null);
  for (const item of orphans) {
    // Project as well as workspace: an item with no project would not appear
    // on any of them, which for onboarding means the work someone just
    // described vanishes at the moment a repo is attached (KAN-17).
    //
    // And the type it points at moves with it (KAN-129). These items
    // were resolving against the installation scope, and leaving them
    // there would give one project's board a mix of rows the configure
    // screen cannot edit together — rename "Story" here and the adopted
    // ones would go on reading the installation's label.
    //
    // **Asked by the row it holds, not by the word on it.** The word is
    // ambiguous the moment two packs ship it: an installation-scope
    // `support:case` item arriving at a project that also has
    // `legal:case` would have been a lookup with two answers, refused —
    // leaving the item project-scoped and still pointing at the
    // installation's row, which is the one outcome this is for. Its own
    // row says whose type it is, and the same pack's row in the
    // destination is where it belongs.
    //
    // If the destination genuinely lacks that pack's type — a row
    // somebody deleted, since `syncItemTypes` gives every project every
    // installed pack's — the item keeps the row it has: still a valid
    // type, still the right word, merely in the wider scope. Wrong in a
    // smaller way than an onboarding that throws.
    //
    // Assembled field by field rather than spread, for the reason
    // `updateItem` is: a spread payload could carry `stepId` invisibly,
    // and the architectural invariant test refuses one on sight.
    const held = getItemType(db, item.typeId);
    const adopted = held === undefined ? null : resolveItemType(db, projectId, { packSlug: held.packSlug, slug: held.slug });
    const values: Partial<typeof items.$inferInsert> = { workspaceId, projectId, updatedAt: Date.now() };
    if (adopted?.ok) values.typeId = adopted.type.id;
    db.update(items).set(values).where(eq(items.id, item.id)).run();
  }
  return orphans.length;
}

export interface UpdateItemInput {
  title?: string;
  /**
   * What the git workspace now knows about it — its branch, its pull
   * request, or both (KAN-169).
   *
   * Nested under the kind that owns it rather than two fields on this
   * patch, and partial for the reason the three Jira fields are
   * separately optional: `open_pull_request` knows the URL and nothing
   * about the branch, the dispatch knows the branch and nothing about
   * the URL, and whatever a patch leaves out keeps the value it had.
   */
  git?: Partial<GitItemState>;
  jiraKey?: string | null;
  jiraId?: string | null;
  /**
   * Whether this item talks to Jira at all (EO-122).
   *
   * `setJiraSync` is the front door — it exists so a caller cannot flip
   * the switch and forget the checks around it — but the field lives
   * here too, because `updateItem` is the one patch path and leaving a
   * column out of it would make the two disagree about what an edit is.
   */
  jiraSync?: boolean;
  body?: string | null;
  priority?: number;
  spec?: Record<string, unknown> | null;
  /**
   * Reclassifying an item (KAN-37/EO-5) — the PO's `intake` guess at
   * feature/story/bug, overridable by a human at `pending_approval`
   * before it is approved. Not gated on state here; the IPC layer and
   * `resolveNextState` are what make that window mean anything.
   *
   * The row rather than the word, since KAN-129. A slug is a request
   * that a project can refuse, and the refusal belongs where whoever
   * asked will read it — `resolveItemType` is the door, and both
   * callers (the `items:update` handler and `intake`) go through it and
   * answer in their own voice. What arrives here is already resolved,
   * which is why this patch can no longer fail.
   */
  typeId?: Uuid;
}

/**
 * Edits an item's own fields. Deliberately cannot touch `state` — that
 * is transitionItem's alone (invariant #1), and an update path that
 * could quietly change it would route around the audit trail.
 *
 * The payload is assembled field by field rather than spread, so the
 * absence of `state` is visible at the call site. A spread would satisfy
 * the type today and silently start writing state the moment someone
 * widened UpdateItemInput — which is exactly what the architectural
 * invariant test now refuses to allow.
 */
export function updateItem(db: Db, id: Uuid, patch: UpdateItemInput): Item {
  const values: Partial<typeof items.$inferInsert> = { updatedAt: Date.now() };
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.body !== undefined) values.body = patch.body;
  if (patch.priority !== undefined) values.priority = patch.priority;
  if (patch.spec !== undefined) values.spec = patch.spec;
  if (patch.typeId !== undefined) values.typeId = patch.typeId;

  // The three Jira fields (KAN-148) and the two git ones (KAN-169) are
  // extension rows now, so they are a read-modify-write rather than five
  // more columns in `values` — in the same transaction as the row,
  // because half an edit landing is not something any caller here is
  // prepared for. Whatever the patch leaves out keeps the value it had,
  // which is what a patch of the columns did.
  db.transaction((tx) => {
    const scoped = tx as unknown as Db;
    tx.update(items).set(values).where(eq(items.id, id)).run();

    if (patch.git !== undefined) setGitState(scoped, id, { ...gitStateFor(scoped, id), ...patch.git });

    if (patch.jiraKey === undefined && patch.jiraId === undefined && patch.jiraSync === undefined) return;

    const held = jiraStateFor(scoped, id);
    setJiraState(scoped, id, {
      // `!== undefined` rather than `??`, because `null` is a value
      // here: clearing the key is what `jira/push.ts` and the item
      // update handler both do, and `??` would read it as "unchanged".
      key: patch.jiraKey !== undefined ? patch.jiraKey : held.key,
      id: patch.jiraId !== undefined ? patch.jiraId : held.id,
      sync: patch.jiraSync !== undefined ? patch.jiraSync : held.sync,
      pullPending: held.pullPending,
    });
  });

  const updated = getItem(db, id);
  if (!updated) throw new Error(`no item ${id} to update`);
  return updated;
}

/**
 * A refusal is a sentence, never an exception.
 *
 * Everything these two can refuse is something a person did — a key with
 * a typo in it, a key another item already holds, an item deleted in
 * another window — and throwing is for programmer error (the working
 * agreement, and the shape `saveMcpServer` already uses).
 */
export type JiraLinkResult = { ok: true; item: Item } | { ok: false; problem: string };

/** Said in one voice, by the four paths that can find the row gone. */
const ITEM_IS_GONE = "That ticket no longer exists.";

/**
 * Attaches this item to a Jira issue, or detaches it (EO-122).
 *
 * **Nothing here touches the network.** Format and uniqueness are checked
 * locally and the row is written, which is what lets the submit and
 * update paths stay synchronous: a Jira that is down or unreachable
 * never costs somebody the item they just submitted. If the key names
 * no issue, the first push or pull says so through the failure comments
 * that already exist.
 *
 * It does, however, *ask* for a pull (EO-127). The pull-pending marker
 * is written in the same row as the key, and `startJiraPull`'s tick is
 * what turns that into a `pullItem` — comments, attachments and the
 * issue's own summary, description and acceptance criteria, on the
 * ordinary `reconcileFields` terms. The marker rather than the call is
 * what keeps this function synchronous and offline-safe, and what makes
 * the backfill survive a Jira that is down at the moment of attaching.
 *
 * Nothing is marked when this item's sync is off. There is nothing to
 * pull for an item that does not talk to Jira, and `setJiraSync` is
 * where switching it back on asks for the backlog instead.
 *
 * `jiraId` — Jira's internal id for the issue — is cleared on every
 * link, including a relink. It is a property of whichever issue
 * `jiraKey` names, and it cannot be derived from a key without asking
 * Jira, so carrying the old one forward would leave the row asserting
 * that KAN-9 has issue 10001's id. Null is the honest answer; the next
 * push records the real one.
 *
 * Clearing deletes the item's pending `jira` rows in `outbox` (the
 * pinned decision on EO-121). That table is a queue, not a ledger —
 * invariant 3 is about `run_events` — and leaving four queued pushes to
 * fail one by one at drain time would produce a run of "no longer
 * mirrored" notes for something the person just asked for deliberately.
 *
 * Note that switching *sync* off does not do this. An entry queued
 * before the switch was thrown stays queued and is refused at drain time
 * instead, so turning sync back on before the next drain sends it — the
 * switch is meant to be reversible in a way unlinking is not.
 */
export function linkJiraKey(db: Db, itemId: Uuid, key: string | null): JiraLinkResult {
  return db.transaction((tx) => {
    const scoped = tx as unknown as Db;
    const item = getItem(scoped, itemId);
    if (!item) return { ok: false, problem: ITEM_IS_GONE };

    if (key === null) {
      // Ordered so the queue cannot outlive the key even if the second
      // statement is what fails: both are in the transaction, so neither
      // lands without the other.
      tx.delete(outbox).where(and(eq(outbox.itemId, itemId), eq(outbox.channel, "jira"))).run();
      // The backfill goes with the key it was for (EO-127). A pull
      // pending against an issue this item no longer mirrors would
      // either fetch the issue somebody just detached it from, or sit
      // in the drain being refused for a key that is null.
      //
      // The switch is all that is left of this item's Jira state, and
      // it survives the detach: somebody who silenced an item and then
      // unlinked it has not asked for it to start talking again. When
      // the switch is on as well, the state is the default and
      // `setJiraState` takes the row away entirely (KAN-148).
      setJiraState(scoped, itemId, { key: null, id: null, sync: jiraStateOf(item).sync, pullPending: false });
      tx.update(items).set({ updatedAt: Date.now() }).where(eq(items.id, itemId)).run();
      const detached = getItem(scoped, itemId);
      if (!detached) return { ok: false, problem: ITEM_IS_GONE };
      return { ok: true, item: detached };
    }

    const read = JiraIssueKeySchema.safeParse(key);
    if (!read.success) return { ok: false, problem: `"${key.trim()}" is not a Jira issue key. They look like KAN-123.` };
    const jiraKey = read.data;

    const holder = getItemByJiraKey(scoped, jiraKey);
    // Naming the holder rather than just refusing: "already linked" with
    // no subject leaves somebody hunting through the board for an item
    // they may not even be able to see, since an archived one counts.
    if (holder && holder.id !== itemId) return { ok: false, problem: `${holder.key} is already linked to ${jiraKey}.` };
    // Already this item's. Not an error and not a write — relinking a
    // item to the key it holds is what a form resubmitted unchanged
    // looks like.
    if (holder) return { ok: true, item: holder };

    const sync = jiraStateOf(item).sync;
    setJiraState(scoped, itemId, {
      key: jiraKey,
      id: null,
      sync,
      // In the same row as the key, so the intent cannot land without
      // the link or the link without the intent (EO-127). Only when
      // this item talks to Jira at all: attaching with sync off sets no
      // marker and pulls nothing, which is the point of the switch.
      pullPending: sync,
    });
    tx.update(items).set({ updatedAt: Date.now() }).where(eq(items.id, itemId)).run();
    // Re-read rather than `returning()`: the row carries a type id and
    // the domain item carries the word, and the join is where the two
    // meet (KAN-129).
    const linked = getItem(scoped, itemId);
    if (!linked) return { ok: false, problem: ITEM_IS_GONE };
    return { ok: true, item: linked };
  });
}

/**
 * Throws the per-item Jira switch (EO-122).
 *
 * Deliberately leaves `jiraKey` alone in both directions. That is the
 * whole reason the switch exists: off keeps the key, so on resumes
 * against the same issue instead of asking for it to be typed again.
 *
 * An item with no key at all may still be switched — there is nothing
 * to check it against, and refusing would mean an item has to be linked
 * before it can be told not to sync, which is backwards for the case of
 * saying so at submission time.
 *
 * Switching *on* an item that holds a key asks for a pull (EO-127).
 * The switch gates pulls as well as pushes, so an item that sat off
 * for a week has a week of comments and edits it never saw, and no
 * ordinary sweep will find them — `pullProject` asks what moved
 * recently, not what this item missed. Turning it on is the moment to
 * ask. Switching off drops the marker for the same reason detaching
 * does: an item that is not talking to Jira has no pull outstanding.
 */
export function setJiraSync(db: Db, itemId: Uuid, enabled: boolean): JiraLinkResult {
  const item = getItem(db, itemId);
  if (!item) return { ok: false, problem: ITEM_IS_GONE };
  const held = jiraStateOf(item);
  db.transaction((tx) => {
    setJiraState(tx as unknown as Db, itemId, { ...held, sync: enabled, pullPending: enabled && held.key !== null });
    tx.update(items).set({ updatedAt: Date.now() }).where(eq(items.id, itemId)).run();
  });
  const switched = getItem(db, itemId);
  if (!switched) return { ok: false, problem: ITEM_IS_GONE };
  return { ok: true, item: switched };
}

/**
 * The items attached to an issue they have not read yet (EO-127).
 *
 * What the pull schedule drains. Archived items included, by the same
 * reasoning `pullProject` uses: an archived item still holds its key
 * and is still pulled, so one attached and then archived would
 * otherwise keep a marker nothing ever clears.
 *
 * Deliberately not filtered on the key or the switch. Nothing sets
 * the marker without both, and both clear it, so a filter here would
 * only hide a row that should not exist — and hide it by stranding it,
 * since the drain is also what clears the flag. `pullItem` states
 * what it will not pull, and this reads the marker and nothing else.
 */
export function listJiraPullPending(db: Db): Item[] {
  return hydrate(
    db,
    selectItems(db)
      .innerJoin(itemExtensions, and(eq(itemExtensions.itemId, items.id), eq(itemExtensions.extension, JIRA_EXTENSION)))
      .where(pullPendingIsSet)
      .orderBy(items.createdAt)
      .all(),
  );
}

/** Whether anything is waiting on a backfill — the cheap question the tick and the handlers ask. */
export function hasJiraPullPending(db: Db): boolean {
  return (
    db
      .select({ itemId: itemExtensions.itemId })
      .from(itemExtensions)
      .where(and(eq(itemExtensions.extension, JIRA_EXTENSION), pullPendingIsSet))
      .limit(1)
      .get() !== undefined
  );
}

/** Whether this one item is (EO-127). Reads the marker; says nothing about whether a pull would succeed. */
export function isJiraPullPending(db: Db, itemId: Uuid): boolean {
  return jiraStateFor(db, itemId).pullPending;
}

/**
 * Whether a snapshot taken before a slow read still describes the link
 * (EO-127).
 *
 * A pull is many network round trips, and EO's write handlers run in the
 * gaps between them. Somebody relinking an item from KAN-1 to KAN-2
 * mid-pull leaves the in-flight read holding a `Item` that says KAN-1
 * while the row says KAN-2 — so everything the read is about to write is
 * the wrong issue's, and everything it is about to clear was set for a
 * different one. This is the question to ask before each of those.
 *
 * Sync counts as part of the link. An item silenced while its issue was
 * being read is an item that must not take that issue's comments and
 * text, for the same reason it would not have been read at all had the
 * switch been off a moment earlier.
 *
 * It cannot tell a link that never moved from one that went away and
 * came back to the same key — unlink then relink to KAN-1, or sync off
 * then on — because the row it compares is identical either way. That
 * residue is harmless: the item does still mirror the issue that was
 * read, so nothing wrong is written, and the read that just finished is
 * the backfill the relink was asking for. Anything written to the issue
 * in between makes it a recently-moved issue, which is exactly what the
 * ordinary sweep is for.
 */
export function stillMirrors(db: Db, item: Item): boolean {
  const current = jiraStateFor(db, item.id);
  const read = jiraStateOf(item);
  return current.key !== null && current.key === read.key && current.sync;
}

/**
 * The backfill happened (EO-127).
 *
 * Called only after a pull that came back clean, which is the whole
 * behaviour of the marker: an attempt that failed because Jira was
 * unreachable leaves it set, and the next tick tries again. Not a
 * transition and not part of the pull's own transaction — the pull is
 * many statements over a network, and holding a write open across it
 * would be a worse trade than re-pulling an issue whose comments and
 * fields both converge anyway.
 *
 * `mirroring` is the key the pull was *for*, and the clear does nothing
 * unless the row still holds it. An item relinked while its old issue
 * was being read has a new marker, set for the new issue and never yet
 * acted on, and an unconditional clear here would drop it — after which
 * nothing would ever fetch the new issue, because the ordinary sweep
 * only ever sees issues that moved. In the WHERE clause rather than in
 * the caller so it cannot be the caller that forgets.
 */
export function clearJiraPullPending(db: Db, itemId: Uuid, mirroring: string): void {
  db.transaction((tx) => {
    const scoped = tx as unknown as Db;
    const held = jiraStateFor(scoped, itemId);
    // The condition that used to be in the WHERE clause, for the same
    // reason it was there and not in the caller: an item relinked while
    // its old issue was being read holds a marker set for the *new*
    // issue, and clearing that would leave nothing to ever fetch it.
    if (held.key !== mirroring) return;
    setJiraState(scoped, itemId, { ...held, pullPending: false });
  });
}

/** An item and every story under it — what one delete actually removes. */
export function itemWithDescendants(db: Db, id: Uuid): Uuid[] {
  const children = db.select({ id: items.id }).from(items).where(eq(items.parentId, id)).all();
  return [id, ...children.flatMap((child) => itemWithDescendants(db, child.id as Uuid))];
}

/**
 * Removes an item, its stories, and everything written about them
 * (KAN-30).
 *
 * This used to be a one-line `delete from items`, which could never
 * have run: foreign keys are ON, and nothing pointing at `items.id`
 * has an `on delete` clause, so the first comment or run on the item
 * would have made it fail. It was dead code, and the cascade below is
 * what it should always have been.
 *
 * **This deletes `run_events`, which invariant 3 calls append-only.**
 * The invariant is about an item's history being immutable while the
 * item exists — no rewriting what an agent did, no tidying a failure
 * out of the record. Removing the item entirely is a different act,
 * asked for explicitly by a person who wants it gone. Archiving instead
 * is a real thing and a separate one (KAN-33): it is automatic, it is
 * for finished work, and it deletes nothing.
 *
 * The cost of saying yes here: `sumCostCentsSince` totals `runs` by
 * time, so deleting an item lowers the spend recorded for the days it
 * ran on. Deliberate — a deleted item is meant to leave no trace —
 * but it means the budget guard's history is not a ledger.
 *
 * Order is dictated by the foreign keys, not by taste: mentions before
 * comments, everything that carries a `run_id` before `runs`.
 */
export function deleteItem(db: Db, id: Uuid): { deletedItemIds: Uuid[] } {
  return db.transaction((tx) => {
    const ids = itemWithDescendants(db, id);

    const runIds = tx
      .select({ id: runs.id })
      .from(runs)
      .where(inArray(runs.itemId, ids))
      .all()
      .map((row) => row.id);
    const commentIds = tx
      .select({ id: comments.id })
      .from(comments)
      .where(inArray(comments.itemId, ids))
      .all()
      .map((row) => row.id);

    // Every file on these items — their comments' and their own
    // (EO-702) — before the comments a file may name. And the note of
    // any of the item's own files removed earlier, which is only there
    // for the record to page and means nothing once the item is gone.
    tx.delete(attachments).where(inArray(attachments.itemId, ids)).run();
    tx.delete(attachmentRemovals).where(inArray(attachmentRemovals.itemId, ids)).run();

    if (commentIds.length > 0) {
      tx.delete(commentMentions).where(inArray(commentMentions.commentId, commentIds)).run();
      tx.delete(comments).where(inArray(comments.itemId, ids)).run();
    }

    if (runIds.length > 0) {
      tx.delete(runEvents).where(inArray(runEvents.runId, runIds)).run();
      // A comment one of these runs left on an item that is staying
      // (EO-433). A module's run on this item can have written on
      // another — `ctx.commentOn`, and the note EO leaves on an item a
      // module created — and `comments.run_id` is a real foreign key, so
      // the runs below could not be deleted while such a comment named
      // one. The comment is that item's and stays; what goes is its
      // pointer to a transcript that is about to stop existing.
      tx.update(comments)
        .set({ runId: null })
        .where(and(inArray(comments.runId, runIds), notInArray(comments.itemId, ids)))
        .run();
    }
    tx.delete(transitions).where(inArray(transitions.itemId, ids)).run();
    // The side calls made about these items, or inside their runs
    // (EO-477), before the runs they may name. What they cost goes with
    // the item, as its runs' cost does.
    tx.delete(sideCalls).where(inArray(sideCalls.itemId, ids)).run();
    if (runIds.length > 0) tx.delete(sideCalls).where(inArray(sideCalls.runId, runIds)).run();
    tx.delete(runs).where(inArray(runs.itemId, ids)).run();

    // Pending sends outlive nothing: they would retry forever against a
    // item that is gone.
    tx.delete(outbox).where(inArray(outbox.itemId, ids)).run();

    // Both directions. An edge from a surviving item into a deleted
    // one is just as much a dangling reference as the other way round.
    tx.delete(itemDeps).where(inArray(itemDeps.itemId, ids)).run();
    tx.delete(itemDeps).where(inArray(itemDeps.dependsOnId, ids)).run();

    // A `from-discussion` job one of these conversations made (EO-304):
    // it exists to record items as coming from the conversation, which
    // is going. The occurrences go with the job, by the cascade the
    // schema declares.
    tx.delete(jobs).where(fromDiscussionOf(ids)).run();
    // And a waiver given for a webhook job that just went (EO-405). No
    // job a conversation made is a webhook job today; this is here so
    // that the day one is, the waiver does not outlive it.
    dropWebhookWaiversWithoutEntry(tx as unknown as Db);

    tx.delete(items).where(inArray(items.id, ids)).run();

    return { deletedItemIds: ids };
  });
}
