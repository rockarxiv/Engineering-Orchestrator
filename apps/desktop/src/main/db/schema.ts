import { type AnySQLiteColumn, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ── Configuration ─────────────────────────────────────────────

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(), // uuidv7
  name: text("name").notNull(),
  role: text("role").notNull(),
  provider: text("provider").notNull(),
  model: text("model"),
  instructions: text("instructions").notNull(),
  /**
   * The hash of the instructions EO itself last wrote (migration 0033).
   *
   * Provenance, not a checksum: it is what lets `syncRolePrompts` tell a
   * default nobody has touched — safe to improve — from an edit somebody
   * made, which must never be reverted (U-06). Null means unknown, which
   * covers both a human's own text and every row older than the column.
   */
  promptHash: text("prompt_hash"),
  config: text("config", { mode: "json" }).notNull().default({}),
  /**
   * Whether this agent is dispatched at all. Distinct from archived:
   * disabled is a switch somebody flips while they work out whether an
   * agent is helping, archived is being done with it.
   */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Archived rather than deleted — see `modules.archived_at` and invariant #3 (EO-186). */
  archivedAt: integer("archived_at"),
  /** A tombstone: name and role kept for history, the rest cleared (EO-350, migration 0104). */
  deletedAt: integer("deleted_at"),
  /**
   * The project this agent works for, or NULL for a global agent
   * (EO-474, migration 0120). See `Agent.projectId` for the rule.
   *
   * No ON DELETE rule, for `items.project_id`'s reason: an agent has
   * runs and comments pointing at it, so it is never cascaded away.
   * `deleteProject` archives a project's own agents and detaches them
   * before the project row goes (EO-476).
   */
  projectId: text("project_id").references((): AnySQLiteColumn => projects.id),
  /**
   * When the row last changed (EO-476, migration 0121).
   *
   * What a replica pages a record-held project's own agents on, as it
   * pages the project's pipelines — see `listProjectAgentsUpdatedSince`.
   * Written by every writer in `agentsRepo.ts`, and by an attachment
   * change, since the tool surface travels with the agent. Zero on a row
   * from before the column, which reads as older than any cursor.
   */
  updatedAt: integer("updated_at").notNull().default(0),
  /**
   * How many times the row has changed (EO-476, migration 0122): every
   * edit, scope change, archive, delete and change of its tool surface
   * adds one. It travels with every copy of the agent, through the
   * publication and the sync alike, and is what orders them — two changes
   * in one millisecond are two revisions. Not bumped by re-offering an
   * agent on the sync, which changes nothing about it.
   */
  revision: integer("revision").notNull().default(0),
  /**
   * The record's revision of the copy a replica last took (EO-476,
   * migration 0122). What lets a replica pass over an older copy
   * arriving late through either door; null where the record never
   * wrote the row. Never read on the record itself.
   */
  recordStamp: integer("record_stamp"),
});

/**
 * A pipeline: one configurable route from "new work" to "done" (KAN-52).
 *
 * Workflow was always DATA rather than code (ARCHITECTURE.md, "Pipelines and routes"), but there
 * used to be
 * exactly one of it — a single global `workflow_states` table. That is why
 * `planMode` had to be bolted onto the group with the note "a per-project
 * gate cannot be a state without making workflows per-project". Workflows
 * are per-pipeline now, so that stops being true.
 *
 * `projectId` is nullable for the same reason `items.workspaceId` is:
 * EO is usable before anything is configured, and the pipeline seeded on
 * first run has no project to belong to yet. The first project adopts it.
 */
export const pipelines = sqliteTable("pipelines", {
  id: text("id").primaryKey(), // uuidv7
  projectId: text("project_id").references((): AnySQLiteColumn => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Icon name for the sidebar. Null falls back to a generic one. */
  icon: text("icon"),
  /**
   * Where an item assigned to this pipeline lands (ARCHITECTURE.md, "Vocabulary").
   *
   * Explicit rather than "the lowest position": position orders the
   * display and nothing else (ARCHITECTURE.md, "A step"), and deriving the entry point from it
   * would make reordering the columns silently re-route new work.
   *
   * Nullable only so a pipeline can exist before its first step does —
   * the sidebar creates an empty one and the configuration screen fills
   * it in. The validator refuses to publish a pipeline without one.
   */
  entryStepId: text("entry_step_id").references((): AnySQLiteColumn => pipelineSteps.id),
  position: integer("position").notNull().default(0),
  /**
   * The template item a pack ships for Preview (EO-314, ARCHITECTURE.md, "Preview", "One
   * document").
   *
   * `PreviewItemSchema` — a title, a qualified type, a body and a spec.
   * On the pipeline because it is an example *of* this graph, and null
   * on almost every one: a pipeline somebody drew here has no pack and
   * no example, and NULL says that exactly.
   *
   * Nothing is filed from it. Preview is what turns it into a marked
   * item excluded from inbox, archive and cost; an import writes this
   * column and no row in `items`.
   *
   * Not `items.preview_at` (EO-313), which marks an item somebody is
   * previewing. This is the example a pack ships for them to preview —
   * a fact about the document rather than about a run.
   */
  previewItem: text("preview_item", { mode: "json" }),
  /**
   * When this pipeline was made as a trial of a draft (EO-582,
   * ARCHITECTURE.md, "Trial pipelines"). Null on every pipeline a person
   * can see.
   *
   * A trial is a draft under test, materialised so that items can stand
   * on it: its own steps, routes and version, written the ordinary way.
   * `listPipelines` never answers with one, so it is in no switcher, no
   * board, no export and no gallery; the trial's own reads find it by id.
   */
  trialAt: integer("trial_at"),
  /** The assistant conversation the trial was made from. Set exactly when `trial_at` is. */
  trialConversationId: text("trial_conversation_id"),
  /**
   * The pipeline the draft would replace, or null for a draft that
   * creates one. Read, never written through: nothing a trial does may
   * change that pipeline.
   */
  trialTargetPipelineId: text("trial_target_pipeline_id"),
  /**
   * How each of the trial's steps runs on its test items (EO-584,
   * `TrialPlanSchema`): real, redirected or mocked, and what a mocked
   * step reports for each item. Null — every step real — until somebody
   * saves a plan, and on every pipeline that is not a trial.
   */
  trialPlan: text("trial_plan", { mode: "json" }),
  /**
   * Which live step each of the trial's steps was copied from, by the
   * trial step's id (EO-584). Its own values are that step's, read and
   * never written. Null on a trial of a new pipeline and on every pipeline
   * that is not a trial.
   */
  trialStepSources: text("trial_step_sources", { mode: "json" }),
  /**
   * The design the person approved for this trial (EO-587,
   * `TrialDesignSchema`): the draft and its trial plan as the design card
   * showed them, and which trial step, module and test item each of the
   * draft's became. What every later draft in the conversation is compared
   * against, and what each round files its test items from. Null on a
   * trial made without a design card, and on every pipeline that is not a
   * trial.
   */
  trialDesign: text("trial_design", { mode: "json" }),
  /**
   * Deleting a pipeline archives it (KAN-59) rather than dropping the row,
   * so the work that flowed through it keeps something to point at — the
   * same reason an archived item keeps its runs.
   */
  archivedAt: integer("archived_at"),
  /**
   * The version this pipeline is on now (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
   *
   * A `pipeline_versions.id`, or NULL for a pipeline nobody has saved
   * since versions existed — which a lazy snapshot fills in the moment
   * an item binds to it, so the column is null only while it has never
   * mattered.
   *
   * No `references()`: the two tables reference each other, and a
   * circular foreign key would make the rebuild that adds either of
   * them unorderable. `pipeline_versions.pipeline_id` is the edge with
   * the constraint on it, and this is the pointer.
   */
  currentVersionId: text("current_version_id"),
  /**
   * The published version this machine's copy was made from, where
   * somebody has edited a pipeline their organisation manages (EO-331,
   * ARCHITECTURE.md, "Divergence and suggestions").
   *
   * A `pipeline_versions.id`, and null on every pipeline that is not
   * diverged — which is all of them on a solo desktop and on a server.
   * What it is *for* is the line the original design asks for: "Edited locally · based
   * on v6 · v7 available". `current_version_id` cannot answer the
   * middle clause once the graph has been edited, because it points at
   * the organisation's account of a graph this machine no longer has.
   *
   * It is also what `upsertReplicaPipeline` reads to leave this row
   * alone: "updates stop applying silently" is the promise, and a
   * publish that overwrote a person's own edits would be exactly the
   * silence it is a promise against.
   *
   * No `references()`, for `current_version_id`'s reason one row over:
   * the pointer is to a table that points back here.
   */
  divergedFromVersionId: text("diverged_from_version_id"),
  /** When the copy was made. Null exactly when the column above is. */
  divergedAt: integer("diverged_at"),
  /**
   * Whether this pipeline may send what a webhook delivers without a
   * person reading it first (EO-405).
   *
   * Off on every pipeline until a person turns it on in that pipeline's
   * editor — `pipelines:setWebhookUnattended`, the only thing that writes
   * a true here on a machine that owns its pipelines. A replica takes it
   * from its record with the rest of a published pipeline. Nothing an
   * agent is served can set it, an export does not carry it, and an
   * import never writes it, so a true in this column always traces back
   * to somebody with authority over the pipeline choosing it.
   *
   * What it changes is the severity of one finding: `validationInput`
   * hands it to `validatePipeline`, which reports the steps a webhook
   * reaches unread as warnings instead of refusing to publish.
   */
  webhookUnattended: integer("webhook_unattended", { mode: "boolean" }).notNull().default(false),
  /**
   * What an item must have to enter (EO-610, ARCHITECTURE.md, "Entry
   * rules"): the live half, as `pipeline_steps` is of the graph. Read
   * through `EntryRulesSchema`, so a row nobody can read asks for nothing
   * rather than stopping every door.
   */
  entryRules: text("entry_rules", { mode: "json" }).notNull().default([]),
  /**
   * The template this pipeline was made from, by slug (EO-531).
   *
   * Null on a pipeline somebody drew, and on one that predates origins
   * and matched no shipped template version — such a pipeline is never
   * compared with a template. Set with the three columns below, always
   * together, by `recordPipelineOrigin`.
   */
  templateSlug: text("template_slug"),
  /** The template version it was made from, or last moved its base to. */
  templateVersion: text("template_version"),
  /**
   * The stored snapshot of that version — its *base* — as a
   * `template_versions.id`.
   *
   * No `references()`: a snapshot outlives any one pipeline, and a
   * rebuild of this table to add a constraint is not worth what it
   * would protect.
   */
  templateBaseId: text("template_base_id"),
  /**
   * The template's step ids, each mapped to this pipeline's own (EO-531).
   *
   * An import re-mints every step id, so `review` in the template is a
   * uuid here, and comparing the two by step id needs this map. A
   * template step with no entry is one this pipeline does not have.
   */
  templateStepIds: text("template_step_ids", { mode: "json" }),
  /**
   * When the base last moved (EO-534): the moment the edits since it are
   * counted from. Null where it was never kept — an origin recorded before
   * the column, or one backfilled for a pipeline made long before origins,
   * whose versions are all the person's.
   */
  templateBaseMovedAt: integer("template_base_moved_at"),
  /**
   * The template update EO last applied to this pipeline (EO-536):
   * `{ version, pipelineVersion, at }` — the template version it took,
   * the pipeline version it was filed as, and when. What the head's
   * "Updated to" reads, kept here because the version it filed may be
   * pruned by the next save. Null where no update was ever applied.
   */
  templateApplied: text("template_applied", { mode: "json" }),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * A stored snapshot of one template version (EO-531).
 *
 * What a pipeline's origin points at as its base. Stored here rather
 * than read from the file the app ships, so the base survives a release
 * that drops an old file — and so a template installed from the fetched
 * gallery, which ships no history at all, still has one.
 *
 * Shared by every pipeline made from the same document, and never
 * updated: a row is the document as it was, and two documents claiming
 * the same slug and version but differing (a fetched pack republished
 * without a new version) are two rows, told apart by `digest`.
 */
export const templateVersions = sqliteTable(
  "template_versions",
  {
    id: text("id").primaryKey(), // uuidv7
    slug: text("slug").notNull(),
    version: text("version").notNull(),
    /** sha256 of the document as stored, so the same document is stored once. */
    digest: text("digest").notNull(),
    /** The whole pack, as `PipelineExportSchema` parsed it. */
    document: text("document", { mode: "json" }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("idx_template_versions_digest").on(table.slug, table.version, table.digest)],
);

/**
 * A template update a pipeline could not take (EO-532, ARCHITECTURE.md,
 * "Template versions and origins").
 *
 * Written when the three-way comparison of a pipeline — its base, the
 * pipeline as it is, the new template version — finds a key both sides
 * changed differently, or when the merge it would have applied does not
 * validate. Nothing from that version was applied; the pipeline works as
 * it did. Open while `resolvedAt` is null, and at most one is open for a
 * pipeline at a time.
 */
export const pipelineUpdateConflicts = sqliteTable(
  "pipeline_update_conflicts",
  {
    id: text("id").primaryKey(), // uuidv7
    pipelineId: text("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    templateSlug: text("template_slug").notNull(),
    /** The version the pipeline's base is at. */
    fromVersion: text("from_version").notNull(),
    /** The version that could not be applied. */
    toVersion: text("to_version").notNull(),
    /** The base compared with, a `template_versions.id`. */
    baseId: text("base_id").notNull(),
    /** The new version compared with, a `template_versions.id`, so the three graphs outlive the shipped file. */
    templateId: text("template_id").notNull(),
    /** The release notes of every version after the base, up to `toVersion`. */
    notes: text("notes").notNull(),
    /** Each conflicting key with its base, current and template values (`KeyChange[]`, in the pipeline's own step ids). */
    conflicts: text("conflicts", { mode: "json" }).notNull(),
    /** Why the merge would not validate, where that is why it was held; empty otherwise. */
    problems: text("problems", { mode: "json" }).notNull(),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
    /** How it was closed: `superseded` by a newer version, or what a later story records. */
    resolution: text("resolution"),
    /** The comments the conflict notice was posted as, one per project thread (EO-533, migration 0136). */
    noticeCommentIds: text("notice_comment_ids", { mode: "json" }).notNull().default([]),
    /** The assistant chat Fix with assistant opened for it, so a second press shows the same chat. No foreign key: a removed chat is simply started again. */
    chatId: text("chat_id"),
    /** On the record, the device the chat's first turn was handed to (EO-533, migration 0136). */
    chatTurnDeviceId: text("chat_turn_device_id"),
  },
  (table) => [index("idx_pipeline_update_conflicts_pipeline").on(table.pipelineId, table.resolvedAt)],
);

/**
 * One saved shape of a pipeline — its steps, its routes and where work
 * enters, frozen (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * The document rather than a set of rows, and that is the decision worth
 * writing down. The alternative — a `version_id` on every
 * `pipeline_steps` row — would have made the current graph a query with
 * a predicate on it, and every one of the ~40 readers of
 * `listStepsForPipeline` wrong by omission until it learned the
 * predicate. Here the live tables stay exactly what they were, *the
 * current version*, and an older one is read back out of this column.
 *
 * Immutable: nothing updates a row here after it is inserted. A
 * rollback (the next story) publishes an older version again, which
 * means pointing `pipelines.current_version_id` at it and taking a new
 * snapshot — never rewriting the one it names.
 */
export const pipelineVersions = sqliteTable(
  "pipeline_versions",
  {
    id: text("id").primaryKey(), // uuidv7
    pipelineId: text("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    /** 1, 2, 3… within one pipeline. What "v6" on a card's chip means. */
    number: integer("number").notNull(),
    /**
     * The steps and the routes as they stood, as JSON.
     *
     * JSON for `pipeline_steps.results`' reason, at a larger size: an
     * ordered document belonging to one row, written once, never
     * queried across rows, and read whole or not at all.
     */
    steps: text("steps", { mode: "json" }).notNull(),
    routes: text("routes", { mode: "json" }).notNull(),
    /** Where work entered on this version. Part of the document (ARCHITECTURE.md, "Pipelines and routes"). */
    entryStepId: text("entry_step_id"),
    /** What an item had to have to enter on this version (EO-610). Part of the document, so a rollback restores it. */
    entryRules: text("entry_rules", { mode: "json" }).notNull().default([]),
    createdAt: integer("created_at").notNull(),
    /** The person who saved it, for "by Dana". Null for one EO took itself. */
    createdBy: text("created_by"),
  },
  // Two rows claiming to be v6 of one pipeline would make "finishes on
  // v6" a sentence with two meanings.
  (table) => [uniqueIndex("idx_pipeline_versions_number").on(table.pipelineId, table.number)],
);

/**
 * One step of a pipeline — what `workflow_states` was, scoped to an owner.
 *
 * Ids are uuidv7 for anything a person creates. The steps seeded on first
 * run keep the slugs the states had (`todo`, `review`, …): renumbering them
 * would have rewritten every existing item's column for no gain, and
 * nothing branches on the value any more — routing reads `step_routes`,
 * never a literal.
 */
export const pipelineSteps = sqliteTable(
  "pipeline_steps",
  {
    id: text("id").primaryKey(),
    pipelineId: text("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** What it is called in front of a person: "Reviewer", "Merge Request". */
    name: text("name").notNull(),
    /**
     * Who acts here: `agent` dispatches a role, `user` waits for a person,
     * `builtin` runs a function EO ships (`PipelineStepType`).
     *
     * This decides which executor runs, which is the difference from the
     * kinds it replaced — `source`/`merge_request`/`gate` named what a step
     * was for while dispatch branched on `owner_role` and a boolean, so
     * choosing one changed an icon and nothing else.
     */
    type: text("type").notNull().default("agent"), // agent | user | builtin
    /** The role dispatched on an `agent` step. NULL on every other kind. */
    ownerRole: text("owner_role"),
    /** The agent action, or the builtin function. NULL on a `user` step. */
    entryAction: text("entry_action"),
    /** The prose shown under the step in the configuration screen. */
    instructionsSummary: text("instructions_summary"),
    isTerminal: integer("is_terminal", { mode: "boolean" }).notNull().default(false),
    /**
     * Ask this step to plan before it writes anything (KAN-18, ARCHITECTURE.md, "A step").
     *
     * On the step rather than on the project group, where it used to live
     * with a note about why it had to: `workflow_states` was global, so a
     * per-group gate could not be a state. Workflows are per-pipeline now.
     * It was never about a project anyway — it asks one step to work
     * differently, which is a property of that step.
     */
    planMode: integer("plan_mode", { mode: "boolean" }).notNull().default(false),
    /**
     * How this step uses a git workspace: `isolated`, a branch and a
     * worktree of its own, or `read`, the repository as it stands
     * (EO-296, ARCHITECTURE.md, "The four kinds").
     *
     * A mode of one kind rather than a kind of its own, because that is
     * how a person holds it: one repository, used two ways. Never read
     * on a workspace that is not a git kind.
     *
     * Text rather than a boolean for `workspaces.kind`'s reason: the
     * column names what was chosen, and a `read_only` flag would have to
     * be renamed the day a third way of using a checkout exists.
     */
    workspaceMode: text("workspace_mode").notNull().default("isolated"),
    /**
     * Which of the project's workspaces this step runs on (EO-301,
     * ARCHITECTURE.md, "A workspace is a kind, attached to the project").
     *
     * A workspace id, the sentinel `none` for a step that says "no disk"
     * out loud, or NULL for "whatever the ticket is on" — which is what
     * every step did before a step could pick, and so what every row
     * written before this column means.
     *
     * No `references()`, and the migration says why at length: the
     * sentinel is not a row, and `deleteWorkspace` clears the picks a
     * removal orphans, which is the part a foreign key could not have
     * done without confusing "the workspace went" with "no disk,
     * deliberately".
     */
    workspaceId: text("workspace_id"),
    /**
     * Holds something other than work, so the dashboard, the archive and
     * the inbox leave it out. The one shipped is the `discussion`
     * conversation, which is an item only so that it can host runs.
     */
    offBoard: integer("off_board", { mode: "boolean" }).notNull().default(false),
    /**
     * What this step sets for the inputs its module declares (EO-78).
     *
     * A JSON object of the names somebody set, keyed by the input's
     * declared name. On the step for the reason a secret is scoped to one
     * (KAN-105) — two steps can run the same module and mean different
     * things by it — and in this table rather than beside the secrets
     * because a value here is ordinary configuration that belongs to the
     * graph document, published by the same click as the module that
     * reads it.
     *
     * Only what was set. Absent is not "the default, written down": an
     * input the step leaves alone follows the manifest when its default
     * changes, and one that was configured does not.
     */
    inputs: text("inputs", { mode: "json" }).notNull().default({}),
    /**
     * How long this step's module may run before EO stops it (EO-162).
     *
     * Milliseconds. NULL means EO's own default rather than the default
     * written down — the same distinction `inputs` draws between an unset
     * name and one that happens to hold the manifest's value, and what
     * makes raising this opt-in for everybody who never touched it.
     *
     * Bounded by the run timeout, and the bound is held by refusing to
     * store a contradicting pair on either side rather than by a check
     * here: see `timeLimitBoundProblem`.
     */
    timeoutMs: integer("timeout_ms"),
    /**
     * Keep checking (EO-456, ARCHITECTURE.md, "A step"): check every this
     * many minutes, and give up this many hours after the watch started.
     *
     * Both null on a step that runs once, which is every step written
     * before this. Real rather than integer so that half a minute reaches
     * the validator as half a minute and is refused there, by name.
     */
    watchEveryMinutes: real("watch_every_minutes"),
    watchGiveUpHours: real("watch_give_up_hours"),
    /**
     * Keep checking with no deadline (EO-571): `watch_give_up_hours` is
     * not read while this is set. Its own column because NULL hours
     * already means the step runs once. Meaningless on a step that runs
     * once, and false there.
     */
    watchNeverGivesUp: integer("watch_never_gives_up", { mode: "boolean" }).notNull().default(false),
    /**
     * Who a human step waits on (EO-302, ARCHITECTURE.md, "Identity").
     *
     * A person, a group, or neither — and neither is what every step is
     * today: it waits for whoever is there, which in solo mode is the
     * one person. Naming one is a column head that reads "Anna Ruiz ·
     * approves here" rather than "Nobody assigned".
     *
     * `ownerGroupId` was written down by 0077 ahead of the `groups`
     * table, because it is the same decision as the column beside it.
     * 0089 brings the table and EO-323 the reader: a step naming a group
     * has a head that says "Support team · anyone claims" (ARCHITECTURE.md, "Identity").
     *
     * It still carries no `references()`, and that is now a choice
     * rather than a gap. Adding one means SQLite's twelve-step table
     * rebuild on `pipeline_steps` — the most referenced table in the
     * schema after `items` — to gain a constraint whose only writer is
     * `setStepOwner`, which checks the group exists before it writes and
     * clears the column when a group is deleted. The cost is a rebuild
     * of a hot table; the gain is a backstop for one caller.
     */
    ownerPersonId: text("owner_person_id").references((): AnySQLiteColumn => people.id),
    ownerGroupId: text("owner_group_id"),
    /**
     * What a person may decide here (EO-310, ARCHITECTURE.md, "Results and routes").
     *
     * A JSON array of `{ key, label, tone, requiresComment }`, in the
     * order the buttons are offered. Only a `user` step declares any: an
     * agent answers whatever its prompt asked for, a builtin declares
     * its results in the registry and a module in its manifest, and a
     * person had nowhere to declare anything at all — which is why the
     * only gesture a human step offered was a drag, and a drag names a
     * destination rather than an answer.
     *
     * `step_routes` is still where a result *goes*, and the two are
     * held to each other by `validatePipeline`: every declared result
     * must be routed, and a route out of a user step must name a key
     * declared here. What lives here and cannot live on a route is the
     * offer itself — the button's words, and whether taking it requires
     * the person to say why.
     *
     * JSON for `inputs`' reason: a short ordered list belonging to one
     * step, published with the graph document in the same click, and
     * never queried across steps. `[]` on every other kind of step, and
     * on a human step that only waits.
     */
    results: text("results", { mode: "json" }).notNull().default([]),
    /**
     * The last version this step was part of, once it is not part of the
     * current one (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
     *
     * A step removed from a pipeline is retired rather than dropped.
     * The row has to stay: `items.step_id` references it with no
     * cascade, and an item finishing on an older version can still be
     * *routed onto* a step that version has and the current one does
     * not — which is precisely the ghost column the design draws. Dropping
     * the row would turn that move into a foreign-key error at the
     * moment an agent returned a result.
     *
     * NULL is a step of the current version, which is every step until
     * somebody removes one. A number is the version it was last in, and
     * what the ghost column's head says: "Review (v6) · 2 finishing".
     * Re-adding a step with the same id clears it back to null.
     *
     * The row is frozen as it was at retirement — nothing edits a
     * retired step — so an item that lands there runs the definition
     * its own version had.
     */
    retiredVersion: integer("retired_version"),
  },
  (table) => [index("idx_pipeline_steps_pipeline").on(table.pipelineId, table.position)],
);

/**
 * The branching graph: where each declared result of a step sends an item.
 *
 * This replaced "one position down the pipeline" plus a handful of
 * hard-coded state ids in `roles/wiring.ts`. A step declares its results
 * (`approved`, `changes_requested`, …) and each routes somewhere, so a
 * second pipeline with entirely different steps needs no engine change
 * (invariant #7).
 */
export const stepRoutes = sqliteTable(
  "step_routes",
  {
    id: text("id").primaryKey(),
    pipelineId: text("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    fromStepId: text("from_step_id")
      .notNull()
      .references((): AnySQLiteColumn => pipelineSteps.id, { onDelete: "cascade" }),
    /** What the agent returned: one of the step's declared results. */
    resultKey: text("result_key").notNull(),
    label: text("label").notNull(),
    /** Drives the dot colour in the configuration screen. */
    tone: text("tone").notNull().default("info"), // success | warning | info | danger
    /**
     * A `pipeline_steps.id`, or one of two sentinels: `user_attention`
     * parks the item and asks the human (KAN-55), `terminal` resolves to
     * the pipeline's terminal step.
     */
    target: text("target").notNull(),
    position: integer("position").notNull().default(0),
  },
  // One route per declared result. Two rows for one result would make the
  // next step depend on row order, which is not something anyone chose.
  (table) => [uniqueIndex("idx_step_routes_key").on(table.fromStepId, table.resultKey)],
);

// ── People ────────────────────────────────────────────────────

/**
 * Somebody EO can name (EO-302, ARCHITECTURE.md, "Identity").
 *
 * Identity arrives with jobs, not with the server: a job needs an owner
 * and "have Anna approve it" needs an assignee before any server
 * exists. So the table lands now, holding one row — the implicit local
 * person, `LOCAL_PERSON_ID`, created by migration 0077 — and every
 * place that meant "the human" means that row. 7b brings the server's
 * people list, groups, and the second row.
 *
 * Four columns and no "is this me" flag. Which row is the local person
 * is its id — a reserved UUIDv7 frozen in `LOCAL_PERSON_ID`, the way
 * the seeded agents carry fixed literals — because the migration that
 * creates the row and rewrites every human mention onto it needs the
 * same value the TypeScript writes, and the design's first-sign-in rewrite
 * needs to find that row again among however many the server sends.
 *
 * Nothing archives a person yet. When a colleague leaves, the rows that
 * name them — items they created, mentions aimed at them — are as real
 * as they were, which is the argument `agents.archived_at` already
 * made; 7b is where it is answered.
 */
export const people = sqliteTable("people", {
  id: text("id").primaryKey(),
  /** What they are called. `"you"` for the implicit local row. */
  name: text("name").notNull(),
  /**
   * Null until a server knows one — solo mode never asks.
   *
   * UNIQUE since 0089, on `lower(email)`, because sign-in is by email
   * and two rows carrying one address is a question with two answers.
   * The index is in SQL rather than here: drizzle's `uniqueIndex` has no
   * way to say `lower(...)`, and a case-sensitive one would let
   * `Anna@` and `anna@` both exist. `peopleRepo` lower-cases on the way
   * in, which is what keeps the two in step.
   */
  email: text("email"),
  createdAt: integer("created_at").notNull(),
  /**
   * "One admin flag. Everyone with it may edit on the server."
   * (EO-323, the design.)
   *
   * Per-project owner roles are explicitly not here: "with the first
   * customer who asks, not before".
   */
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  /** When an admin invited them. Null on a row that was never an invitation. */
  invitedAt: integer("invited_at"),
  /** When they accepted and set a credential. Null while the invitation is outstanding. */
  acceptedAt: integer("accepted_at"),
  /**
   * How this person gets in — the choice the design asks to be recorded, as
   * what was actually stored. `password`, or null until they accept.
   *
   * `passkey` is not a value this may hold: nothing registers or
   * verifies one, and a row claiming it beside a password hash would be
   * this column answering its own question wrongly. `CredentialKindSchema`
   * carries the argument and is where the value returns.
   */
  credentialKind: text("credential_kind"),
  /** scrypt over a per-row salt. See `identity/passwords.ts`; never the password. */
  passwordHash: text("password_hash"),
  /** The invitation code, hashed. Cleared on acceptance, which is what makes it one-time. */
  inviteCodeHash: text("invite_code_hash"),
  /** When the invitation stops working. A link that never expires is a credential in an inbox for ever. */
  inviteExpiresAt: integer("invite_expires_at"),
});

/**
 * A group, so a human step can say "Support team · anyone claims"
 * (EO-323, `ARCHITECTURE.md`, "Identity").
 *
 * Who work is offered to, and nothing about permission: there is one
 * admin flag and no per-project role, so a group carries no rights and
 * granting one none is deliberate rather than unfinished.
 */
export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
});

/** Who is in a group. The row is the pair, which is why the pair is the key. */
export const groupMembers = sqliteTable(
  "group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references((): AnySQLiteColumn => groups.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references((): AnySQLiteColumn => people.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.personId] })],
);

/**
 * A machine somebody signed in from (EO-323,
 * the original design).
 *
 * "Each device holds its own token, revocable by the admin." The token
 * itself is said once, in the sign-in response, and never again: what is
 * stored is a SHA-256 of it, so a copied database is a list of which
 * machines may talk rather than a set of keys to talk with.
 *
 * Revoked rather than deleted, because the admin's list is a record of
 * what has held a key: a deleted row cannot answer "which machine was
 * that, and when did we stop trusting it".
 */
export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references((): AnySQLiteColumn => people.id, { onDelete: "cascade" }),
    /** What the machine calls itself — a hostname. What an admin recognises when deciding what to revoke. */
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    /**
     * The second credential, for the organisation's secret *values*
     * (EO-328, ARCHITECTURE.md, "Secrets").
     *
     * Not a stronger token: a differently-*kept* one. A desktop holds
     * its device token in the OS keychain, and the renderer a server
     * hands a browser holds one in `sessionStorage` because it needs one
     * to POST `/ipc/…` — so a route guarded by the device token is a
     * route the served renderer can call, and "no query the renderer can
     * make returns an organisation secret" would be false however
     * careful every channel is. This is what opens
     * `ORGANISATION_SECRETS_PATH`, it is minted only for a client that
     * says it runs work, and the browser is issued none.
     *
     * Null on every row that predates the column and on every browser
     * session. A device without one receives no organisation secrets,
     * which is the safe direction.
     */
    secretsKeyHash: text("secrets_key_hash"),
    createdAt: integer("created_at").notNull(),
    /** When it last presented its token. Null until it has made a request past the sign-in. */
    lastSeenAt: integer("last_seen_at"),
    /** When an admin revoked it. Null while it still works. */
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    uniqueIndex("idx_devices_token_hash").on(table.tokenHash),
    index("idx_devices_secrets_key_hash").on(table.secretsKeyHash),
    index("idx_devices_person").on(table.personId),
  ],
);

// ── Work ──────────────────────────────────────────────────────

/**
 * What kind of thing an item is, as data (KAN-129, ARCHITECTURE.md, "An item type is data").
 *
 * It was a free string on `items` holding `feature`, `story` or `bug`,
 * which is three words a support pack cannot add a fourth to without
 * editing core. A type is a row now: labels, a container flag, a spec
 * shape and per-action overrides, scoped to a project and namespaced by
 * the pack that shipped it.
 *
 * **`projectId` NULL is the installation scope** — the set a pack seeds
 * at startup, and the set a new project's own rows are stamped from
 * (`copyItemTypesToProject`). It is a real scope rather than a
 * placeholder: `items.projectId` is nullable too, and an item written
 * before any repository was attached resolves its type here.
 *
 * The unique index is on `(projectId, packSlug, slug)`, written with
 * `ifnull(project_id, '')` in the migration so that the installation
 * scope is one scope rather than a row per insert — SQLite counts two
 * NULLs as distinct in a unique index, which would have let the
 * startup seed write its three rows again on every launch.
 */
export const itemTypes = sqliteTable(
  "item_types",
  {
    id: text("id").primaryKey(), // uuidv7
    /** The project this type belongs to, or NULL for the installation scope. */
    projectId: text("project_id").references((): AnySQLiteColumn => projects.id, { onDelete: "cascade" }),
    /** Which pack shipped it — `developer` for the three EO has always had. */
    packSlug: text("pack_slug").notNull(),
    /** What `items.typeId` used to spell out: `feature`, `story`, `bug`. */
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    plural: text("plural").notNull(),
    /**
     * Whether this type holds others rather than work (ARCHITECTURE.md, "An item type is data").
     *
     * Written from KAN-129 and read from KAN-146: it is what the fourteen
     * branches that used to compare a type against the word `feature`
     * ask, carried up to them on the item view.
     */
    container: integer("container", { mode: "boolean" }).notNull().default(false),
    /**
     * A JSON Schema for the item's `spec`: what fields an item of this
     * type carries, and which of them creation demands (KAN-147).
     *
     * The DDL default is still 0069's empty *array*, which is the shape
     * this column held before 0070 rewrote its contents. Altering a
     * default in SQLite means rebuilding the table, and there is nothing
     * to gain by it: every writer supplies the document, and a value that
     * does not parse as one is read as a type that demands nothing —
     * which is exactly what an empty array meant.
     */
    specShape: text("spec_shape", { mode: "json" }).notNull().default("[]"),
    /**
     * Per-(type, action) overrides: schema, result key and comment
     * poster, by action (ARCHITECTURE.md, "An item type is data"). Read from KAN-163.
     *
     * `{}` rather than NULL for a type with nothing to override, so that
     * "no overrides" has one spelling and a reader never has to ask
     * which of two it is looking at.
     */
    actionOverrides: text("action_overrides", { mode: "json" }).notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("idx_item_types_slug").on(table.projectId, table.packSlug, table.slug)],
);

export const items = sqliteTable("items", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(), // "EO-42"
  /**
   * Which `item_types` row says what this is (KAN-129).
   *
   * A foreign key where the word itself used to sit. The slug is still
   * what everything upstream reads — `Item.type` is joined back out in
   * `itemsRepo` — but the row behind it is what a pack, or a person,
   * can now add to.
   */
  typeId: text("type_id")
    .notNull()
    .references((): AnySQLiteColumn => itemTypes.id),
  parentId: text("parent_id").references((): AnySQLiteColumn => items.id), // story -> its feature
  // Where the work happens (KAN-130). `repository_id` until phase 4: the
  // id is the same one, and what it points at is now a `workspaces` row
  // whose kind says what sort of disk it is.
  //
  // Nullable: EO is usable before any workspace is attached, and the
  // items written then are real work. The first one created adopts them.
  //
  // For a story this is where the work happens, and it is never null in
  // practice. For a *feature* on a project spanning several workspaces
  // it is null by design — the feature belongs to the project, and its
  // stories carry the workspaces (KAN-17).
  workspaceId: text("workspace_id").references((): AnySQLiteColumn => workspaces.id),
  // Which project the item appears on. Deliberately not derived from
  // workspaceId: nothing stops a project being deleted out from under a
  // workspace its items still name, so the item says which one it is on.
  projectId: text("project_id").references((): AnySQLiteColumn => projects.id),
  title: text("title").notNull(),
  body: text("body"),
  spec: text("spec", { mode: "json" }),
  /**
   * Which pipeline this work flows through, and where it sits on it.
   *
   * Both NULL for a feature (ARCHITECTURE.md, "One work entity"): a feature is a container, not
   * work —
   * it carries no changes of its own and nothing dispatches against it,
   * so "which column is it in" was always a question about its stories
   * wearing a step id as a disguise. Null says so.
   *
   * Only `transitionItem()` writes `stepId` (invariant #1).
   */
  pipelineId: text("pipeline_id").references((): AnySQLiteColumn => pipelines.id),
  stepId: text("step_id").references((): AnySQLiteColumn => pipelineSteps.id),
  /**
   * The version of that pipeline this item entered on, and finishes on
   * (EO-327, the original design).
   *
   * "An item binds to the version it entered on and finishes there."
   * Routing reads this rather than the live graph, so a save made while
   * an item is halfway down a pipeline cannot re-route it into a shape
   * nobody agreed to when it started.
   *
   * No `references()`, for `pipeline_steps.workspace_id`'s reason
   * doubled: adding one means SQLite's twelve-step rebuild of `items`,
   * the most referenced table in the schema, to gain a constraint whose
   * writers are `createItem` and `transitionItem` and whose target row
   * is never deleted — a version is immutable, and archiving a pipeline
   * keeps it. Null is an item that entered before versions existed, or
   * before its pipeline had one, and it routes by the live graph
   * exactly as every item did until now.
   */
  pipelineVersionId: text("pipeline_version_id"),
  priority: integer("priority").notNull().default(0),
  /**
   * When the project stopped showing it (KAN-33). Null means live.
   *
   * Not a deletion: everything the item has stays. It is excluded from
   * the project, the inbox and — the one that matters — the scheduler.
   */
  archivedAt: integer("archived_at"),
  /**
   * A manual scheduler hold (EO-45). Not state: it must never move the
   * item away from the pipeline step it resumes on.
   */
  heldAt: integer("held_at"),
  /**
   * When this item was created as a preview (EO-313,
   * ARCHITECTURE.md, "Preview"). Null means it
   * is real work.
   *
   * A mark rather than a mode: `runs.dry_run` says one run was a
   * rehearsal, and nothing said the *item* was. So a preview walked a
   * pipeline looking exactly like work — it landed on the human step,
   * counted in the inbox, added to the day's spend, and showed a green
   * tick beside "post to Slack" that read as posted.
   *
   * A timestamp rather than a flag, following `archived_at` and
   * `held_at`: the same three-way column every mark on this table is,
   * and "when did this stop being nothing" is a question a flag cannot
   * answer.
   *
   * What it excludes is the inbox count, the archive, the day's cost
   * and the `!` marker — not the scheduler. A preview that did not run
   * would show nobody anything.
   */
  previewAt: integer("preview_at"),
  /**
   * When this item was filed on a trial pipeline (EO-582,
   * ARCHITECTURE.md, "Trial pipelines"). Null means it is live work.
   *
   * Not `preview_at`: a preview is swapped onto the fake backend, given
   * no disk and has its side effects described rather than done. A trial
   * item runs on real backends, real workspaces and real modules — that
   * is the point of it. What it shares with a preview is what a person
   * browses: it is left out of the board, the inbox, the `!` marker and
   * the archive. What it does not share is cost, which counts against the
   * budgets and is reported apart.
   */
  trialAt: integer("trial_at"),
  /**
   * Who filed it (EO-302, ARCHITECTURE.md, "Identity").
   *
   * The person whose desktop created it, which in solo mode is the one
   * person there is — whether they typed the item, pressed Create in a
   * conversation, or approved a plan an agent proposed. An agent acts
   * at somebody's request and on their machine; it is not a person and
   * never appears here.
   *
   * Null where EO genuinely does not know: every item written before
   * this column, and an issue imported from a tracker, which somebody
   * filed somewhere EO has no person row for.
   */
  createdBy: text("created_by").references((): AnySQLiteColumn => people.id),
  /**
   * Who it is waiting on (ARCHITECTURE.md, "Identity"). Written by claiming, the seventh story
   * of this phase; nothing reads it yet, and the assignee a card shows
   * is still derived from the latest run's agent until it does.
   */
  assigneeId: text("assignee_id").references((): AnySQLiteColumn => people.id),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  // A project's items and an item's children (EO-555, migration 0140).
  index("idx_items_project").on(table.projectId),
  index("idx_items_parent").on(table.parentId),
]);

/**
 * What a pack knows about an item (KAN-148, ARCHITECTURE.md, "One work entity").
 *
 * One row per (item, extension), holding that extension's whole state as
 * JSON. The four Jira columns that used to sit on `items` — key, id,
 * sync and pull-pending — are the `jira` row here, and the branch and
 * the pull request are the `git` row (KAN-169, ARCHITECTURE.md, "One work entity"): facts about the
 * one workspace kind that cuts branches, which every item on `none`,
 * `folder` or `scratch` would otherwise have carried null forever. The
 * next pack to bind an item to something outside EO, and the next kind
 * with state of its own, add a row rather than more columns to the
 * table every item shares.
 *
 * **A row exists only when there is something to say.** An item nobody
 * has bound to anything has no row at all, and the accessor's defaults
 * (`NO_JIRA_STATE`, and `sync: true` with it) are what an absent row
 * means — so the write path deletes a row that has gone back to saying
 * nothing rather than storing a payload asserting silence.
 *
 * **What deliberately does not live here**: a per-entity external id
 * that needs a unique index. JSON cannot carry one, so a comment's Jira
 * id and an attachment's are indexed columns in the two side tables
 * below.
 */
export const itemExtensions = sqliteTable(
  "item_extensions",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    /** Whose state this is: `jira` for the tracker binding, `git` for the workspace kind that cuts branches. */
    extension: text("extension").notNull(),
    data: text("data", { mode: "json" }).notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.itemId, table.extension] })],
);

/**
 * Where an item a module created came from (EO-433).
 *
 * One row per item `ctx.createItem` made, and none for any other item —
 * which is what generation 0 is. It is what makes a creation repeatable
 * (the pair of originating item and idempotency key is unique, so a
 * second run answers with the first run's item) and what bounds a chain
 * of modules creating work for each other (`generation`).
 *
 * `item_id` cascades and `origin_item_id` is set to null: a deleted
 * item stops answering a repeat, and deleting the item a module ran on
 * leaves what it created in place. `run_id` and `module_id` are plain
 * text for the reason the migration gives — the record of which run and
 * which module is kept after either is gone.
 */
export const itemOrigins = sqliteTable(
  "item_origins",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => items.id, { onDelete: "cascade" }),
    originItemId: text("origin_item_id").references(() => items.id, { onDelete: "set null" }),
    runId: text("run_id"),
    moduleId: text("module_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    /** The originating item's generation plus one. An item with no row here is generation 0. */
    generation: integer("generation").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("item_origins_origin_key_unique").on(table.originItemId, table.idempotencyKey)],
);

/**
 * An item's watch on a step that keeps checking (EO-456, ARCHITECTURE.md,
 * "A step").
 *
 * One row per item and step, and the whole of the wait: when it started,
 * when it last checked and when it checks next, how many checks it has
 * run, how many have failed in a row and with what, and which news it has
 * already posted. A check that comes back waiting with nothing new writes
 * here and one line on the stay's quiet run (EO-618) — no run of its own —
 * which is what keeps a week of five-minute checks from being two thousand
 * runs nobody reads.
 *
 * `initiationId` is the move that brought the item onto the step. An item
 * that leaves and comes back is a new watch, and the row is reset when
 * the two disagree rather than deleted when the item leaves, because
 * nothing on the way out is guaranteed to pass through here.
 */
export const itemWatches = sqliteTable(
  "item_watches",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    initiationId: text("initiation_id"),
    startedAt: integer("started_at").notNull(),
    lastCheckedAt: integer("last_checked_at"),
    nextCheckAt: integer("next_check_at").notNull(),
    checks: integer("checks").notNull().default(0),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastError: text("last_error"),
    /** Ids of the news already posted for this watch, as a JSON array. */
    postedNewsIds: text("posted_news_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
    /**
     * When this database last changed the row. What an organisation's
     * record pages its watch feed on; a replica keeps the record's stamp
     * rather than taking its own, so a mirrored row is not sent back.
     */
    updatedAt: integer("updated_at").notNull().default(0),
  },
  (table) => [uniqueIndex("item_watches_item_step_unique").on(table.itemId, table.stepId), index("item_watches_updated").on(table.updatedAt, table.id)],
);

/**
 * Which Jira comment a local comment is (KAN-148).
 *
 * `comments.jira_comment_id` until this story. It is a dedupe key — it
 * is what stops EO pushing Jira its own words back and then re-importing
 * them — so it needs a unique index, which a JSON column cannot carry:
 * hence a side table rather than a slot in `item_extensions`.
 *
 * Unique across the installation rather than per item, which is stricter
 * than the plain index the column had. A Jira comment id is Jira's own
 * identifier for one comment on one issue, and one issue is one item
 * (the pinned decision on EO-121), so two items claiming the same one
 * was always a bug — one that used to end in a duplicated comment and
 * now ends in a refused insert.
 */
export const jiraCommentLinks = sqliteTable(
  "jira_comment_links",
  {
    commentId: text("comment_id")
      .primaryKey()
      .references(() => comments.id, { onDelete: "cascade" }),
    jiraCommentId: text("jira_comment_id").notNull(),
  },
  (table) => [uniqueIndex("idx_jira_comment_links_remote").on(table.jiraCommentId)],
);

/**
 * Which Jira attachment a local file mirrors (KAN-148).
 *
 * `attachments.jira_attachment_id` until this story, with its unique
 * index on (item, jira id). Same reasoning as the comment links, and the
 * uniqueness is the remote id alone for the same reason: a Jira
 * attachment belongs to one issue, and one issue is one item.
 */
export const jiraAttachmentLinks = sqliteTable(
  "jira_attachment_links",
  {
    attachmentId: text("attachment_id")
      .primaryKey()
      .references(() => attachments.id, { onDelete: "cascade" }),
    jiraAttachmentId: text("jira_attachment_id").notNull(),
  },
  (table) => [uniqueIndex("idx_jira_attachment_links_remote").on(table.jiraAttachmentId)],
);

// The DAG. Acyclicity is enforced in application code on insert (E-01).
export const itemDeps = sqliteTable(
  "item_deps",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
    dependsOnId: text("depends_on_id")
      .notNull()
      .references(() => items.id),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.dependsOnId] }),
    // What waits on an item (EO-555, migration 0140): the key above
    // answers what an item waits on, and only that direction.
    index("idx_item_deps_depends_on").on(table.dependsOnId),
  ],
);

// Backs the human-readable item key generator ("EO-1", "EO-2", ...) —
// not part of the original DDL, added per this story's scope.
//
// Keyed by prefix, and a prefix is a project's (KAN-128) — so this is one
// row per project, plus a row for each of the rooms that number
// themselves apart (Discussions, assist, architect). A prefix that stops
// minting keeps its row: the count is what says how many keys have
// existed, and resetting it would mint one an item already has.
export const keyCounters = sqliteTable("key_counters", {
  prefix: text("prefix").primaryKey(),
  nextValue: integer("next_value").notNull().default(1),
});

/**
 * A Jira site EO can talk to (KAN-22).
 *
 * Global, and referenced by repositories rather than owned by one. Several
 * repositories on the same site share a connection, which is what makes a
 * token something you enter once and rotate once — the thing that was
 * wrong when this lived on the repository.
 *
 * The token is not here and never will be: the design puts secrets
 * in the OS keychain, and `jira/credentials.ts` keys the ciphertext by
 * this row's id.
 */
export const jiraConnections = sqliteTable("jira_connections", {
  id: text("id").primaryKey(), // uuidv7
  /** What to call it in front of a person. Defaults to the host. */
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  flavour: text("flavour").notNull(), // cloud | datacenter
  /** Cloud only: Basic auth is email:token. Null on datacenter. */
  email: text("email"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * A project (KAN-17).
 *
 * One application is often several repositories, and a feature lands
 * across more than one of them. A project is what those repositories
 * share — its `workspaces` below, one per place work happens. A
 * repository joins the project it is added to; one is made for it only
 * when there is no real project to join.
 */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(), // uuidv7
  name: text("name").notNull(),
  /**
   * Every item on this project draws its key from here — `<prefix>-<n>`.
   *
   * The only prefix there is (KAN-128). It named the repository until
   * phase 2, and keys were per repository in nothing but that column:
   * every item already carried a `project_id`, and both columns indexed
   * the one `keyCounters` table. On the project it is also what lets a
   * support pack's items read "SUP-31" rather than "KAN-31"
   * (ARCHITECTURE.md, "What a pack labels").
   *
   * Unique because the counter is: two projects claiming one prefix would
   * interleave their numbering. Worktree directories stay collision-free
   * for the reason they always did — `~/.eo/worktrees/<KEY>` is named
   * after a key, and keys are unique.
   */
  keyPrefix: text("key_prefix").notNull().unique(),
  /**
   * When the record took this project (EO-325, ARCHITECTURE.md, "The record", "What a person sees
   * first").
   *
   * Null is local: a solo installation's projects, and a signed-in
   * desktop's projects that the person kept. Set is the record's — the
   * rows were handed over, this copy is the replica, and there is no
   * way back in this version.
   *
   * Read on every comment and every move, through `onTheRecord`, which
   * is what decides whether the work goes to the organisation or stays
   * on this machine.
   */
  managedAt: integer("managed_at"),
  /**
   * When the person said to keep it here.
   *
   * The difference between "kept" and "not asked yet", which matters
   * only on a signed-in desktop: a project with neither column set is
   * one the keep-or-move sheet has still to put in front of somebody,
   * and it behaves as a kept one until it does. Silence means keep,
   * because the other reading puts a person's work on their employer's
   * server because they were slow to read a dialog.
   */
  keptLocalAt: integer("kept_local_at"),
  /**
   * A transfer into or out of this database, while it is still in
   * flight (EO-325).
   *
   * The middle of a move, which had no word for it until the review.
   * On the record it means "the rows are arriving; this project is not
   * live yet" — hidden from `record:changes` and out of the scheduler's
   * input. On the machine sending it, it means "this is going
   * somewhere; do not start anything new on it", which is what takes
   * its items out of `locallyScheduledItemIds`.
   *
   * Cleared by the commit that ends the transfer, or by the failure
   * that abandons it. Null is every project that is not moving.
   */
  adoptingAt: integer("adopting_at"),
  /**
   * When somebody put this project away, while it is put away (EO-347).
   *
   * Reversible: restoring clears it and nothing else. While it is set
   * the project is out of the switcher, its items are out of the board,
   * the Inbox and the attention counts, and none of them is dispatched —
   * all of it derived from this column where it is read, never written
   * onto the items. That is what keeps an item somebody held themselves
   * held after the project comes back.
   */
  archivedAt: integer("archived_at"),
  /**
   * Whose it is, on the record.
   *
   * Null in solo mode, where there is one person and naming them would
   * be bookkeeping. Set by the move to whoever signed in — "the server
   * assigning nothing new except the record's ownership".
   */
  ownerId: text("owner_id").references((): AnySQLiteColumn => people.id),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Where work happens, attached to the project (KAN-130,
 * ARCHITECTURE.md, "A workspace is a kind, attached to the project").
 *
 * This *is* `project_repositories` — a project, a member, a position —
 * with the member's own row folded in and the one hard-coded kind spelled
 * out. `repositories` was four things, and only one of them was a fact
 * about the disk: the item key prefix went to the project in KAN-128, the
 * eight Jira columns are a `connector_bindings` row below, and what is
 * left — where the checkout is, what it branches from, how work in it is
 * verified, how a pull request is opened — is this row's `config`.
 *
 * **`kind` says how to read `config`.** One kind exists today,
 * `git-worktree`, and it behaves exactly as `repositories` did.
 * `folder`, `scratch` and `none` arrive with the kind interface in the
 * stories after this one; `config` is JSON precisely so that a second
 * kind costs a registry entry rather than a migration, and so that two
 * kinds never share a column one of them has no answer for.
 *
 * **`project_id` is nullable**, for the reason `items.project_id` and
 * `pipelines.project_id` are: deleting a project must not take the disk
 * its items were worked on with it. A repository outlived its project
 * before this story (the membership cascaded, the repository did not),
 * and an item's `workspace_id` is what a run resolves — so the row is
 * detached rather than deleted, which is the same state as a repository
 * whose last project was removed.
 *
 * `position` orders the picker, exactly as the membership's did.
 */
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(), // uuidv7
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  /** The slug of the kind that prepares this workspace — `git-worktree` is the developer pack's. Open, because which kinds exist is which packs are installed (EO-295). */
  kind: text("kind").notNull(),
  /** The kind's own configuration — `GitWorkspaceConfigSchema` for `git-worktree`. */
  config: text("config", { mode: "json" }).notNull(),
  position: integer("position").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * What a project is bound to outside EO (KAN-130, ARCHITECTURE.md, "A workspace is a kind, attached
 * to the project").
 *
 * The eight `jira*` columns `repositories` carried, as one row on the
 * project they always described. `jira/push.ts` reading an EO type's
 * Jira issue type off *a repository* is what named this wrong: which
 * issue type a feature becomes in Jira is a property of the binding, not
 * of a checkout, and two repositories on one project each kept a copy of
 * it that nothing kept in step.
 *
 * Keyed by connector rather than by pack: a support pack mirroring to a
 * helpdesk adds a row here. One binding per (project, connector), which
 * the unique index is what enforces.
 *
 * The token is not here and never will be — the design puts secrets in
 * the OS keychain, keyed by `jira_connections.id`.
 */
export const connectorBindings = sqliteTable(
  "connector_bindings",
  {
    id: text("id").primaryKey(), // uuidv7
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** `jira` today. `ConnectorSchema` in `@eo/core` is the closed set. */
    connector: text("connector").notNull(),
    /** The connector's own configuration — `JiraBindingConfigSchema` for `jira`. */
    config: text("config", { mode: "json" }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("idx_connector_bindings_project").on(table.projectId, table.connector)],
);

// Small key-value store for app preferences (U-04's Do Not Disturb, and
// whatever U-06 needs). Not in the original DDL — added here
// because a preference has to survive a relaunch and does not deserve a
// table of its own per setting.
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * A custom module: deterministic work a step runs, that EO did not ship
 * (KAN-103).
 *
 * `builtin` is a closed set because each one is code EO ships and audited
 * — "adding one is a feature". That is the right rule for EO's own
 * functions and the wrong answer for a person who wants their deploy to
 * be a step: before agents existed that was a script, and handing it to a
 * model buys a token bill and a nondeterministic transcript in exchange
 * for nothing.
 *
 * `code` lives here rather than on disk. It makes exporting a pipeline a
 * query rather than a file walk (KAN-108), and it means an archived
 * module keeps the source a historical run's transcript refers to.
 *
 * Archived rather than deleted, for the reason `pipelines.archived_at`
 * gives: a run that used this module still points at it, and someone
 * asking for a module to be gone is not asking for what it did to be
 * rewritten (invariant #3).
 */
export const modules = sqliteTable("modules", {
  id: text("id").primaryKey(), // uuidv7
  /** Stable across machines. What an exported pipeline names. */
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  /**
   * NOT NULL on purpose. A module with no description looks usable in the
   * catalog and cannot be found again — and the architect reads exactly
   * this field to decide whether the module it is about to write already
   * exists (KAN-107), so an empty one costs a duplicate every time.
   */
  description: text("description").notNull(),
  code: text("code").notNull(),
  /** `ModuleManifest`: inputs, needs and the results this module can return. */
  manifest: text("manifest", { mode: "json" }).notNull(),
  /**
   * The script a module was translated from, kept as provenance.
   *
   * Invariant #5 prefers what the engine can establish over what an agent
   * asserts, and nothing can establish that a translation is faithful.
   * Keeping the original is what leaves it diffable instead of being a
   * one-time guess nobody can reconstruct.
   */
  originalScript: text("original_script"),
  source: text("source").notNull().default("user"), // user | architect | import
  /**
   * When a person last approved this exact code (KAN-104 refuses to
   * publish a pipeline naming a module without one).
   *
   * Cleared whenever the code or manifest changes, because approval is
   * about a body of code and not about a name. This is what lets an
   * imported module be accepted safely: it arrives null and inert.
   */
  approvedAt: integer("approved_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  archivedAt: integer("archived_at"),
  /**
   * The module this one is a draft copy of, or null (EO-583,
   * ARCHITECTURE.md, "Modules: a step that is a script").
   *
   * Set on the copy a trial is given of a module a published pipeline
   * uses, so the trial can change it without changing what live work
   * runs. No foreign key: modules are archived, never deleted, so the
   * original is always there to point at.
   */
  forkedFromModuleId: text("forked_from_module_id"),
});

/**
 * Permission for a module nobody has approved to run on one trial's
 * items, within the needs it declared when it was granted (EO-583,
 * ARCHITECTURE.md, "Modules: a step that is a script").
 *
 * One row per grant. Withdrawn rather than deleted: a save that widens
 * the module's needs past `needs` sets `withdrawn_at`, and the row stays
 * so a refusal can say the grant was there and why it no longer
 * holds. A new grant for the same module and trial is a new row.
 *
 * Gone with the trial: discarding one deletes its grants with its
 * pipeline, which is what the cascade is for.
 */
export const moduleTrialGrants = sqliteTable(
  "module_trial_grants",
  {
    id: text("id").primaryKey(), // uuidv7
    moduleId: text("module_id")
      .notNull()
      .references(() => modules.id, { onDelete: "cascade" }),
    trialPipelineId: text("trial_pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    /** Who granted it, as `transitions.actor` says who moved an item: `"human"`, or an agent's id. */
    grantedBy: text("granted_by").notNull(),
    grantedAt: integer("granted_at").notNull(),
    /** `TrialGrantNeeds`: what the module may need and still run on the trial. */
    needs: text("needs", { mode: "json" }).notNull(),
    withdrawnAt: integer("withdrawn_at"),
  },
  (table) => [index("idx_module_trial_grants_module").on(table.moduleId, table.trialPipelineId)],
);

/**
 * The rounds of a draft's test-fix loop (EO-586, ARCHITECTURE.md, "Trial
 * pipelines"): one row each time a round of the trial's test items is
 * started (`startTrialRound`), numbered from 1 on each trial. What the
 * rounds guardrail counts, and what a trial item's ends are filed under.
 *
 * Local to the installation that runs the loop, like the trial grants,
 * and gone with the trial: discarding one deletes its pipeline, which is
 * what the cascade is for.
 */
export const trialRounds = sqliteTable(
  "trial_rounds",
  {
    id: text("id").primaryKey(), // uuidv7
    trialPipelineId: text("trial_pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    startedAt: integer("started_at").notNull(),
    /** Who started it, as `transitions.actor` says who moved an item: `"human"`, or an agent's id. */
    startedBy: text("started_by").notNull(),
  },
  (table) => [index("idx_trial_rounds_trial").on(table.trialPipelineId, table.number)],
);

/**
 * Where a trial item got to, each time EO woke the assistant about it
 * (EO-586): reaching a terminal step, parking for attention, failing past
 * its attempts, or arriving on a person's step. EO's own reading, not the
 * assistant's: `failed` is decided here against the item's expected
 * outcome (invariant #5), and it is what the repeated-failure guardrail
 * compares between rounds.
 *
 * Gone with the trial, by the cascade on its pipeline.
 */
export const trialOutcomes = sqliteTable(
  "trial_outcomes",
  {
    id: text("id").primaryKey(), // uuidv7
    trialPipelineId: text("trial_pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    /** The round it happened in; null for one before any round was started. */
    roundId: text("round_id"),
    itemId: text("item_id").notNull(),
    /** `TrialEvent`: `terminal`, `parked`, `attempts` or `person_step`. */
    event: text("event").notNull(),
    stepId: text("step_id").notNull(),
    /** The result it ended with, in EO's words: a route's key, or what parked it. */
    result: text("result").notNull(),
    failed: integer("failed", { mode: "boolean" }).notNull(),
    /** The run that parked it, where one did: one park is one wake, however many comments it posted. */
    runId: text("run_id"),
    /** The comment on the conversation that woke the assistant about it. */
    commentId: text("comment_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_trial_outcomes_trial").on(table.trialPipelineId, table.itemId)],
);

/**
 * A guardrail stopping a draft's test-fix loop (EO-586), and what the
 * person answered: one row per stop, with the comment on the conversation
 * that asked. `choice` is `TrialStopChoice` once answered. Keep going
 * starts every guardrail's count again from `answered_at`.
 *
 * Gone with the trial, by the cascade on its pipeline.
 */
export const trialStops = sqliteTable(
  "trial_stops",
  {
    id: text("id").primaryKey(), // uuidv7
    trialPipelineId: text("trial_pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    /** `TrialGuard`: `rounds`, `budget` or `repeated_failure`. */
    guard: text("guard").notNull(),
    commentId: text("comment_id").notNull(),
    createdAt: integer("created_at").notNull(),
    choice: text("choice"),
    answeredAt: integer("answered_at"),
    /**
     * The trial's newest round when the answer was given — what keep
     * going counts rounds from: every round numbered past it, however
     * close in time it was started.
     */
    answeredAfterRound: integer("answered_after_round"),
  },
  (table) => [index("idx_trial_stops_trial").on(table.trialPipelineId), index("idx_trial_stops_comment").on(table.commentId)],
);

/**
 * A module's test cases (EO-352).
 *
 * One row per case rather than a column of JSON on the module, so a case
 * is written, edited and deleted on its own — which is how the system
 * agent works through a scenario — and so the description a list shows
 * is a column rather than something parsed back out of the source.
 *
 * Deleted outright, unlike the module itself: a case is a draft its
 * author is still shaping, nothing else points at it, and the run that
 * last included it keeps its own copy of the description.
 */
export const moduleTests = sqliteTable(
  "module_tests",
  {
    id: text("id").primaryKey(), // uuidv7
    moduleId: text("module_id")
      .notNull()
      .references(() => modules.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    /** An ES module whose default export is an async function taking the harness. */
    source: text("source").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_module_tests_module").on(table.moduleId, table.createdAt)],
);

/**
 * The latest run of a module's tests, one row per module (EO-352).
 *
 * Replaced on every run: this is "what the tests say now", not a
 * history, and nothing about a test run is a record of work done on an
 * item. `fingerprint` is what the run was taken against — the module's
 * code and manifest and every case — so whether the result is stale is
 * a comparison on read rather than a flag somebody has to remember to
 * set (invariant #6's argument, applied here).
 */
export const moduleTestResults = sqliteTable("module_test_results", {
  moduleId: text("module_id")
    .primaryKey()
    .references(() => modules.id, { onDelete: "cascade" }),
  fingerprint: text("fingerprint").notNull(),
  ranAt: integer("ran_at").notNull(),
  /** `ModuleTestRun`. */
  result: text("result", { mode: "json" }).notNull(),
});

/**
 * A module's history (EO-360): one row per save that changed its code or
 * manifest, and one per restore.
 *
 * The current version is always the newest by number — every save that
 * changes the code files one, and so does every restore — and pruning
 * never deletes it, which is also what keeps a number from being handed
 * out twice.
 *
 * `tests` is the module's cases as they stood when this version stopped
 * being current, refreshed from `module_tests` just before the next one
 * is filed, so it holds the cases that went with this code. While a
 * version is current its cases are the live rows.
 *
 * `approvedAt` records that a person approved this code while it was
 * current, and stays when the module's own approval is cleared by the
 * next edit: it is what lets a restore of exactly this code and manifest
 * come back approved.
 */
export const moduleVersions = sqliteTable(
  "module_versions",
  {
    id: text("id").primaryKey(), // uuidv7
    moduleId: text("module_id")
      .notNull()
      .references(() => modules.id, { onDelete: "cascade" }),
    /** 1, 2, 3… within one module. */
    number: integer("number").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    code: text("code").notNull(),
    /** `ModuleManifest`. */
    manifest: text("manifest", { mode: "json" }).notNull(),
    /** `ModuleVersionTest[]`, oldest first. */
    tests: text("tests", { mode: "json" }).notNull(),
    approvedAt: integer("approved_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("idx_module_versions_number").on(table.moduleId, table.number)],
);

/**
 * The MCP servers a person added, so an agent can be given one (EO-104).
 *
 * The catalogue only: nothing here reaches an agent until attachment
 * (EO-106) and delivery (EO-107, EO-108).
 *
 * No value of any kind is stored. `envNames` holds the *names* of the
 * environment variables a server needs; their values are encrypted by
 * the OS keychain and written under `userData`, the arrangement the Jira
 * token and a module's secrets already have, and never here
 * (ARCHITECTURE.md, "Secrets").
 *
 * The two transports occupy different halves of the row —
 * `command`/`args` for stdio, `url`/`headers` for http and sse — and
 * what stops them being mixed is `readMcpServerDraft` in `packages/core`
 * rather than a constraint here, so a person gets a sentence rather than
 * a SQLite error.
 */
export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(), // uuidv7
  /**
   * Lowercase, and an identifier rather than a label: it is the key
   * under `mcpServers` in a generated configuration and the middle of
   * every tool id the model sees. `eo` is refused at save time — see
   * `RESERVED_MCP_SERVER_NAME`.
   */
  name: text("name").notNull().unique(),
  /**
   * What this server does, in the words a person reads — "reads your
   * Slack channels" (EO-314).
   *
   * A label rather than an identifier, and the only field here that is.
   * It exists because a pack's tool surface is shown at the import gate
   * as capabilities rather than as tool names (ARCHITECTURE.md, "A connector is an MCP server with
   * a setup flow"),
   * and the sentence has to come from whoever knows what the server
   * reaches. Empty where nobody has said.
   */
  description: text("description").notNull().default(""),
  transport: text("transport").notNull(), // stdio | http | sse
  /** stdio only. */
  command: text("command"),
  /** `string[]`, stdio only. */
  args: text("args", { mode: "json" }).notNull().default([]),
  /** http and sse only. */
  url: text("url"),
  /** `Record<string, string>`, http and sse only. A header wanting a secret carries `${NAME}`, never the value. */
  headers: text("headers", { mode: "json" }).notNull().default({}),
  /**
   * How a remote server authenticates: `none`, `bearer` or `header`
   * (EO-117).
   *
   * Read for a remote row only. A stdio row carries the default and
   * nothing looks at it — the union in `packages/core` has no `auth` on
   * a stdio server, because one is spawned into a fixed environment
   * allowlist and delivered without its declared values whatever it
   * claims (EO-108).
   *
   * `header` is the default because it is what every row written before
   * this column is: authentication carried in `headers`, which is all
   * the catalogue could express. No migration reads those strings to
   * guess at anything.
   */
  authKind: text("auth_kind").notNull().default("header"),
  /**
   * The name of the environment variable holding the bearer token, when
   * `auth_kind` is `bearer`. Null otherwise.
   *
   * A name, never a token: the value is in the OS keychain under the
   * server's id, like every other value this table refuses to hold.
   */
  bearerTokenEnvName: text("bearer_token_env_name"),
  /** `string[]` — names, never values. */
  envNames: text("env_names", { mode: "json" }).notNull().default([]),
  /**
   * Whether the server is offered at all. Distinct from archived:
   * disabled is a switch somebody flips while working out whether a
   * server behaves, archived is being done with it.
   */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  /** Archived rather than deleted — see `modules.archived_at` and invariant #3. */
  archivedAt: integer("archived_at"),
  /**
   * What makes this server a *connector* — a display name, a capability
   * line, the secrets it needs and how a person gives them to it
   * (EO-315, `ConnectorSetupSchema`). NULL on a server nobody has
   * written words for, which is every server somebody typed in by hand.
   *
   * No value here either. The names it declares are folded into
   * `env_names` at save time, so nothing on the delivery path reads this
   * column at all.
   */
  connector: text("connector", { mode: "json" }),
});

/**
 * The skills a person wrote, so an agent can be given one (EO-105).
 *
 * The catalogue only: nothing here reaches an agent until attachment
 * (EO-106) and delivery (EO-107).
 *
 * Two names, one of them an identifier. `slug` is what a model invokes
 * and the directory the skill is written to; `name` is what a person
 * calls it. Multica shipped those the other way round (MUL-5529) and the
 * model was offered a name it could not call.
 *
 * The frontmatter is not stored. It is generated from these columns by
 * `skillFrontmatter` in `packages/core` at the moment a skill is written
 * to disk, so escaping a display name with a quote or a newline in it is
 * one function's job rather than everyone's.
 */
export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(), // uuidv7
  /** The identifier, and the directory name. Held to `SKILL_SLUG_PATTERN`. */
  slug: text("slug").notNull().unique(),
  /** The display name. Carried to disk under `metadata`, never offered as something to call. */
  name: text("name").notNull(),
  /**
   * NOT NULL on purpose. This is what the model reads to decide whether
   * the skill is the one, so an empty one is a skill that is listed and
   * never chosen — which reads exactly like a skill that is broken.
   */
  description: text("description").notNull(),
  /** The markdown below the frontmatter. */
  body: text("body").notNull(),
  /** `Array<{ path, content }>` — what sits beside SKILL.md in the skill's own directory. */
  files: text("files", { mode: "json" }).notNull().default([]),
  /**
   * Present on disk, absent from what the model is choosing between.
   * Distinct from `enabled`, which is whether it is delivered at all.
   */
  disableModelInvocation: integer("disable_model_invocation", { mode: "boolean" }).notNull().default(false),
  /**
   * Whether the skill is offered at all. Distinct from archived:
   * disabled is a switch somebody flips while working out whether a
   * skill is helping, archived is being done with it.
   */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /**
   * Which runs it reaches (EO-470, ARCHITECTURE.md §13.3): `global`,
   * `project` or `workspace`. Every skill written before the column is
   * global, which is what the migration's default makes it.
   */
  scope: text("scope").notNull().default("global"),
  /**
   * The project's or the workspace's id for a scoped skill; NULL for a
   * global one. No `references()`: it points into one of two tables,
   * chosen by `scope`, and a skill whose project or workspace has gone is
   * simply delivered to no run — the row stays for the reason an archived
   * one does.
   */
  scopeId: text("scope_id"),
  /**
   * The project a scoped skill belongs to (EO-513): the scope itself for
   * a project's skill, the workspace's project for a workspace's. A
   * workspace never travels to a record, so this is what says whose a
   * workspace's skills are there — `memories.project_id`'s reason. Null
   * for a global skill and for a workspace with no project.
   */
  projectId: text("project_id"),
  createdAt: integer("created_at").notNull(),
  /** The version the skill's author gave it: what decides which of two copies is newer. */
  updatedAt: integer("updated_at").notNull(),
  /**
   * When this database last wrote the row, by its own clock (EO-513) —
   * what the record's feed pages a project's skills on. Apart from
   * `updated_at` so a record can offer a moved project's skills again
   * when the move finishes without making its copy look newer than an
   * edit the sender's last sweep is still carrying.
   */
  localChangedAt: integer("local_changed_at").notNull().default(0),
  /** Archived rather than deleted — see `modules.archived_at` and invariant #3. */
  archivedAt: integer("archived_at"),
}, (table) => [
  index("idx_skills_project").on(table.projectId),
  index("idx_skills_local_changed").on(table.localChangedAt, table.id),
]);

/**
 * Which MCP servers an agent has been given (EO-106).
 *
 * The join the two catalogues were landed for. Keyed on the agent and
 * never on the role name, because roles are configuration (ARCHITECTURE.md, "An agent is a row"):
 * "the
 * reviewer" is a row somebody can rename or add a second of.
 *
 * A server a person is done with is archived rather than deleted, so the
 * cascade below is a backstop rather than the ordinary path — the point
 * of archiving is that this row keeps resolving to something.
 */
export const agentMcpServers = sqliteTable(
  "agent_mcp_servers",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.serverId] })],
);

/** Which skills an agent has been given (EO-106). The sibling of `agentMcpServers`, same reasoning. */
export const agentSkills = sqliteTable(
  "agent_skills",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.skillId] })],
);

// ── Execution ─────────────────────────────────────────────────

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  itemId: text("item_id")
    .notNull()
    .references(() => items.id),
  /**
   * The agent that ran, or NULL for a `builtin` step — EO running one of
   * its own functions is still a run (it takes time, it can fail, it
   * leaves a transcript), but there is no agent to point at.
   */
  agentId: text("agent_id").references(() => agents.id),
  action: text("action").notNull(), // refine | implement | review | create_worktree | …
  // The step this run was dispatched from (0046). Not derivable from
  // `action`: two steps in one pipeline may name the same entry action,
  // and `respond`/`discuss`/`configure` name no step. It is what places a
  // comment written during this run at the step it was written at.
  // Null on rows written before the column, never on one written after.
  stepId: text("step_id"), // a pipeline_steps.id, not an action name
  status: text("status").notNull(), // queued|running|awaiting_input|succeeded|failed|cancelled|orphaned
  threadId: text("thread_id"), // provider session id -> resume
  // Which backend issued that session id (A-07). Nullable: rows written
  // before this column existed, and runs that never got a thread.
  provider: text("provider"),
  // The executable selection used when this provider subprocess started.
  // Immutable after insert; nullable for builtins, guard placeholders and
  // rows written before EO-41.
  runtimeSource: text("runtime_source"), // managed|configured
  // Hash of the instructions this run's thread was started with, so a
  // later edit to the agent's instructions can be seen rather than
  // silently kept out of a resumed thread (EO-87). Nullable: builtin and
  // module runs have no agent, and rows written before EO-87 have no
  // answer. Null is never a match.
  instructionsHash: text("instructions_hash"),
  // Hash of the servers and skills this run's agent had attached, taken
  // at the same moment and for the same reason (EO-106): no backend
  // re-sends configuration on resume, so a resumed thread keeps the tool
  // surface it was born with. A hash of the resolved content, never of
  // the ids — a renamed command changes what the agent can do — and
  // never of a secret, which lives in the keychain and not in these rows.
  //
  // Nullable for builtin and module runs, which have no agent, and for
  // rows written before the column. That last null reads as the *empty*
  // surface rather than as an unknown one: nothing could be attached
  // before this column existed. `findReusableThread` is the one reader.
  agentAttachmentsHash: text("agent_attachments_hash"),
  // The backend had no such session when this run tried to resume it
  // (EO-93). Marks the *thread*, not the run: `thread_id` is left exactly
  // as it was — the run really was handed that session — and this is what
  // stops `findReusableThread` offering the same dead conversation to
  // every dispatch after it.
  threadLost: integer("thread_lost", { mode: "boolean" }).notNull().default(false),
  // What cut the run short without it failing — `quit` or `restart`
  // (`RunInterruption`). Null on every run that ended on its own
  // account, which is what keeps it out of the attempts counted against
  // an initiation.
  interruption: text("interruption"),
  // Where the run worked — the cwd `prepare` handed back (EO-295).
  //
  // `worktree_path` until then, which named one kind's answer: the git
  // kind cuts a worktree, a folder kind hands back a directory and a
  // `none` workspace hands back nothing. Read on both resume paths,
  // which is why the rename is a migration rather than a fresh column.
  cwd: text("cwd"),
  pid: integer("pid"),
  // One workflow-state entry, direct mention, or explicit human
  // re-authorization. Retries share it; a new initiation gets a new id.
  initiationId: text("initiation_id"),
  attempt: integer("attempt").notNull().default(1),
  result: text("result", { mode: "json" }), // JSON: the structured output
  // G-02's mechanical check of what the implementer claimed, kept for
  // later inspection: which step failed and what it printed.
  verification: text("verification", { mode: "json" }),
  // What the workspace kind checked when this run ended, and how each
  // check came out (EO-312). The list, where `verification` above is the
  // evidence one of them carried — the sidebar's step block reads this
  // one, because "say what you checked" needs the checks and not their
  // output.
  checks: text("checks", { mode: "json" }),
  error: text("error"),
  // Total input, cache included — what was actually sent, summed over
  // every turn the run took. Rows written before 0044 hold the Claude
  // SDK's `usage.input_tokens`, which excluded both cache figures and
  // every subagent, and are not comparable with anything after it.
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  // What was served from the prompt cache — a part of `tokens_in` on both
  // backends, so the share of one over the other is how a prompt that is
  // re-read cheaply is told apart from one that is re-sent in full, which
  // is the whole question behind reusing a thread rather than assembling
  // a fresh context.
  cacheReadTokens: integer("cache_read_tokens"),
  // What was written *into* the cache, as the backend reports it. Not
  // known to sit inside `tokens_in` on both — Codex documents no
  // containment either way — so read it as a figure beside the total
  // rather than a slice of it.
  cacheWriteTokens: integer("cache_write_tokens"),
  // Model turns behind those tokens. The multiplier on everything EO
  // puts in a dispatch prompt: a prompt is re-sent on every one.
  turns: integer("turns"),
  // Which rule `turns` follows: `turn` counts this run's own and adds up
  // with its neighbours', `session` is the backend's claim for the whole
  // conversation and may already include every earlier run on the same
  // thread. Invisible in the number, and the two aggregate differently —
  // a run group is a set of rows sharing a thread, which is exactly the
  // boundary a session claim may span.
  turnsScope: text("turns_scope"),
  costCents: integer("cost_cents"),
  // The session's running total as this run last read it (EO-504) — the
  // CLI's figure for the whole conversation, not the run's share above.
  // What the next run on the same thread starts from, so its share does
  // not depend on every earlier row's share being right. Null where the
  // run never read a session total: rows written before 0130, and every
  // run on a backend that reports turn by turn.
  sessionTokensIn: integer("session_tokens_in"),
  sessionTokensOut: integer("session_tokens_out"),
  sessionCacheReadTokens: integer("session_cache_read_tokens"),
  sessionCacheWriteTokens: integer("session_cache_write_tokens"),
  sessionCostCents: integer("session_cost_cents"),
  startedAt: integer("started_at"),
  endedAt: integer("ended_at"),
  /**
   * Somebody ran this module to watch it work, rather than because an
   * item reached a step (KAN-106).
   *
   * A real run, because it takes time, can fail and leaves a transcript
   * — but not work: it moves no item and consults no route, so a
   * transcript that read it as progress would be lying about what
   * happened to the item it borrowed.
   */
  dryRun: integer("dry_run", { mode: "boolean" }).notNull().default(false),
  /**
   * How far this run's log has reached the record (EO-324, ARCHITECTURE.md, "The record").
   *
   * The device's own bookmark into `run_events`, and the reason a
   * desktop that went offline mid-run can come back and deliver the
   * whole transcript in order: it does not have to remember anything
   * across a restart, it reads this and sends everything after it.
   *
   * `-1` means nothing has been sent, which is what every run starts
   * at and what every run on a solo desktop stays at — there is nobody
   * to send it to, and a column that quietly counted up on an
   * installation with no record would be bookkeeping about nothing.
   *
   * Not on `run_events` itself, which is append-only and may not be
   * updated (invariant #3). A bookmark is not part of the record; it is
   * this device's note about how much of the record it has managed to
   * hand over.
   */
  syncedSeq: integer("synced_seq").notNull().default(-1),
  /**
   * The status the record was last told this run had.
   *
   * What makes "the result reaches the server" a fact rather than a
   * hope. Events alone would leave a run that ended while offline
   * looking `running` on the record forever: the transcript would
   * arrive and the outcome would not. Null means the record has never
   * been told about this run at all.
   */
  syncedStatus: text("synced_status"),
  /**
   * When this row last changed (EO-324, ARCHITECTURE.md, "Identity").
   *
   * A run is mutated for as long as it lasts — queued, running, parked,
   * finished, with tokens and a cost arriving at the end — and nothing
   * else on it says *when*. `started_at` is fixed at the beginning and
   * `ended_at` is null until it is over, so a replica pulling "runs
   * that changed since" had nothing to page on and could not show a
   * second desktop's run at all: the design's admin, looking at every
   * project's board, would see no agent working anywhere.
   *
   * Written by the two functions that write a run, which is the whole
   * of what touches this table.
   */
  updatedAt: integer("updated_at").notNull().default(0),
}, (table) => [
  // One item's runs, and the runs still in flight (EO-555, migration 0140).
  index("idx_runs_item").on(table.itemId),
  index("idx_runs_status").on(table.status),
]);

// Append-only. The durability substrate. Never UPDATE, never DELETE (ARCHITECTURE.md, "`run_events`
// is the durability substrate").
export const runEvents = sqliteTable(
  "run_events",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    seq: integer("seq").notNull(),
    ts: integer("ts").notNull(),
    type: text("type").notNull(), // stdout|tool_call|file_edit|error|result
    payload: text("payload", { mode: "json" }).notNull(),
    /**
     * Which machine wrote it (EO-324, the original design:
     * "run_events sync append-only by run and sequence with the device
     * as author").
     *
     * The author of a line of the substrate, which until managed mode
     * was a question with one possible answer and so was not worth
     * asking. It is worth asking the moment two devices can both be
     * running work for one record: the run says which item and which
     * agent, and this says which laptop the transcript came off.
     *
     * Null for every row written before this column, and for a record
     * that is also the device — `local` is written explicitly rather
     * than left null, so that null means "we did not record it" rather
     * than "it was this machine", which are different facts.
     */
    deviceId: text("device_id"),
    /**
     * Where this line stands in the order lines reached this database from
     * other machines (EO-618), for the record's transcript feed.
     *
     * `ts` is when the line was written, on the writer's clock, so it
     * cannot say whether a reader has seen it: a line can arrive long after
     * lines written later. Set once, by the insert, and past every position
     * already taken (`appendSyncedRunEvents`). Null on a line written here,
     * which the feed places by its `ts`.
     */
    arrival: integer("arrival"),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.seq] }),
    // `idx_run_events_feed` (EO-618, migration 0156) is over an expression,
    // which is the feed's position, and lives in the migration with the
    // partial indexes below.
    // `idx_run_events_debug_sent` — which runs debug mode recorded
    // (EO-394) — is in migration 0110 rather than here, for the reason
    // `idx_job_events_created` is: it is a *partial* index, over the
    // `debug_sent` rows only, and one declared here without its `where`
    // would be a different index from the one the database has.
    // `idx_run_events_memory_delivered` (EO-480, migration 0127) is
    // partial for the same reason: `memory_delivered` rows by time, which
    // the scheduled consolidation counts, and `idx_run_events_memory_used`
    // (EO-597, migration 0151) beside it, the `memory_used` rows an
    // entry's uses are counted from. `idx_run_events_model` (EO-541,
    // migration 0133) is partial too: the `thread_started` and `usage`
    // rows a run's model is read from.
  ],
);

// Audit: every state change, human or agent. Only transitionItem() may
// write this table (and items.stepId) — see repos/transitionsRepo.ts.
export const transitions = sqliteTable("transitions", {
  id: text("id").primaryKey(),
  /**
   * The machine the move was applied from (EO-324, ARCHITECTURE.md, "The record").
   *
   * `actor` says *what kind of thing* moved it — a person, or which
   * agent — and that was the whole answer while there was one machine.
   * With two desktops on one record it stops being enough: "your move
   * was superseded by Dana's" needs a name, and `human` is not one. The
   * record knows which device sent the command, the device belongs to a
   * person, and this is the column that joins the two.
   *
   * Null for every move made before managed mode and for every move on
   * a solo desktop, where there is exactly one machine and naming it
   * would tell nobody anything.
   */
  deviceId: text("device_id"),
  itemId: text("item_id")
    .notNull()
    .references(() => items.id),
  fromStepId: text("from_step_id"),
  toStepId: text("to_step_id").notNull(),
  actor: text("actor").notNull(), // "human" | agent_id
  runId: text("run_id").references(() => runs.id),
  reason: text("reason"),
  ts: integer("ts").notNull(),
}, (table) => [
  // What one item has been through (EO-555, migration 0140).
  index("idx_transitions_item").on(table.itemId),
]);

// ── Communication: comments are the ONLY channel ──────────────

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
    authorType: text("author_type").notNull(), // human | agent | engine | module
    authorId: text("author_id"), // agents.id when author_type='agent'; null otherwise, module comments included
    runId: text("run_id").references(() => runs.id), // set if written during a run
    // One level of threading (D-05): an answer belongs to the question
    // it answers. A reply to a reply is still a reply to the question,
    // so this never nests deeper.
    parentId: text("parent_id").references((): AnySQLiteColumn => comments.id),
    body: text("body").notNull(), // markdown
    kind: text("kind").notNull().default("note"), // note|question|decision|approval|rejection|escalation
    options: text("options", { mode: "json" }), // JSON: choices, rendered as buttons
    attachments: text("attachments", { mode: "json" }).notNull().default([]),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false), // survives context truncation
    /**
     * When the pin last changed (EO-324, ARCHITECTURE.md, "The record").
     *
     * A comment is otherwise immutable — nobody edits what was said —
     * so `created_at` is enough to page a thread with, and was until
     * two desktops had to agree about one. The pin is the single
     * mutable thing on the row, and changing it moves no timestamp the
     * record's pull is keyed on: somebody pins a comment on their
     * machine, the record takes it, and every other desktop goes on
     * showing it unpinned for ever.
     *
     * So the pin gets a clock of its own, and the pull pages on it.
     * Null for a comment nobody has pinned or unpinned since this
     * column existed, which is almost all of them and reads correctly
     * as "no pin change to catch up on".
     */
    pinnedAt: integer("pinned_at"),
    /**
     * Which Jira comment this is, when it is one, moved to
     * `jira_comment_links` (KAN-148). The comment row says what was said
     * here; which comment in Jira it is, is the developer pack's.
     */
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_comments_item").on(table.itemId, table.createdAt)],
);

/** Durable files owned by one item comment. Paths never cross IPC. */
export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(), // uuidv7
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
    // Null for one of the item's own files rather than a comment's
    // (EO-702, migration 0158): part of what the item is, as its
    // description is, and not anything anybody said.
    commentId: text("comment_id").references(() => comments.id),
    storagePath: text("storage_path").notNull(),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    /** False only for migrated path-only rows, whose origin EO cannot prove. */
    managed: integer("managed", { mode: "boolean" }).notNull().default(true),
    /** The Jira attachment this file mirrors moved to `jira_attachment_links` (KAN-148). */
    /** Most recent outbound failure, retained even if the generic outbox eventually gives up. */
    jiraSyncError: text("jira_sync_error"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_attachments_item").on(table.itemId),
    index("idx_attachments_comment").on(table.commentId),
  ],
);

/**
 * Item files somebody removed (EO-702), so the organisation record can
 * tell every replica: a removed `attachments` row is gone and cannot say
 * so itself. Paged on `(removed_at, attachment_id)`. No foreign key to
 * `items` — `deleteItem` takes these with the item.
 */
export const attachmentRemovals = sqliteTable(
  "attachment_removals",
  {
    attachmentId: text("attachment_id").primaryKey(),
    itemId: text("item_id").notNull(),
    removedAt: integer("removed_at").notNull(),
  },
  (table) => [index("idx_attachment_removals_paging").on(table.removedAt, table.attachmentId)],
);

// Mentions drive the inbox. A mention is a request for attention.
export const commentMentions = sqliteTable(
  "comment_mentions",
  {
    commentId: text("comment_id")
      .notNull()
      .references(() => comments.id),
    targetType: text("target_type").notNull(), // human | agent
    /**
     * `agents.id`, or `people.id` on a `human` row (EO-302, ARCHITECTURE.md, "Identity").
     *
     * NULL until 0077, which is what made "who is being waited on" a
     * question EO could not answer: the inbox and the `!` marker were
     * queries for an absence, and an absence has no name. Every human
     * row now carries the person it always meant.
     *
     * Still nullable in the column, because tightening it is a
     * twelve-step table rebuild of a table two indexes and a composite
     * key hang off, bought for a constraint 0077 already establishes
     * and `postComment` — the one writer — cannot break: it fills this
     * in on every row it inserts.
     *
     * No `references()`, because the column holds an id from one of two
     * tables depending on the row beside it; `target_type` says which.
     */
    targetId: text("target_id"),
    status: text("status").notNull().default("open"), // open | addressed | dismissed
    /** The reply that resolved it. */
    addressedBy: text("addressed_by").references((): AnySQLiteColumn => comments.id),
    /**
     * When it stopped waiting (EO-325).
     *
     * `comments.pinned_at`'s twin, and for its reason: a status is the
     * one thing about a mention that changes after it is written, and a
     * row paged only by its parent's cursor cannot report a change made
     * days later. This is what `record:changes` offers it on.
     *
     * Null while it is open, and on every row written before the
     * column existed.
     */
    settledAt: integer("settled_at"),
  },
  (table) => [
    primaryKey({ columns: [table.commentId, table.targetType, table.targetId] }),
    index("idx_mentions_open").on(table.status, table.targetType, table.targetId),
  ],
);

/**
 * What still has to reach somewhere else (J-04, generalised in F-06).
 *
 * Written in the same transaction as the thing that caused it, so a
 * transition that survives a crash has a push that survives it too.
 * Deleted once it lands — a queue, not a ledger.
 */
export const outbox = sqliteTable(
  "outbox",
  {
    // UUIDv7: order within an item is load-bearing, because two
    // comments must arrive in the order they were written.
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references((): AnySQLiteColumn => workspaces.id),
    /** Who the entry is for: `jira` | `forge`. */
    channel: text("channel").notNull().default("jira"),
    kind: text("kind").notNull(), // jira: status | comment | branch | attachment_upload | attachment_delete — forge: open_pr
    payload: text("payload", { mode: "json" }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
  },
  // Ordering is per (channel, item): a Jira outage must not hold up
  // the pull request for the same item.
  (table) => [
    index("idx_outbox_due").on(table.channel, table.nextAttemptAt, table.id),
    index("idx_outbox_item").on(table.channel, table.itemId, table.id),
  ],
);

// ── Repository intelligence: metadata about a disposable cache ─

/**
 * What EO knows about a repository index (EO-145).
 *
 * The index — a graph of symbols, callers, callees, imports and
 * inheritance — is a directory on disk under the provider's control.
 * None of it is in this database and none of it ever will be: it is
 * derived from the checkout, it rebuilds in seconds, and a copy here
 * would be a second thing to keep in step with the working tree.
 *
 * This is the note saying that directory exists and whether it can be
 * trusted. `0056_repository_indexes.sql` carries the long-form reasons
 * for the three decided shapes — repository rather than project,
 * `itemId` nullable and unused, and `providerVersion` stored but
 * never interpreted.
 */
export const repositoryIndexes = sqliteTable("repository_indexes", {
  id: text("id").primaryKey(), // uuidv7
  workspaceId: text("workspace_id")
    .notNull()
    .references((): AnySQLiteColumn => workspaces.id, { onDelete: "cascade" }),
  /** Null is the repository's own baseline. Nullable and unused in this version, on purpose. */
  itemId: text("item_id").references((): AnySQLiteColumn => items.id, { onDelete: "cascade" }),
  /** An opaque implementation identifier. Never compared to a constant outside that implementation. */
  provider: text("provider").notNull(),
  indexPath: text("index_path").notNull(),
  // not_indexed | indexing | ready | updating | stale | failed. The legal
  // moves between them live in main/repositoryIntelligence/transitions.ts.
  status: text("status").notNull(),
  indexedCommitSha: text("indexed_commit_sha"),
  /** When a build last succeeded, as against when the row last moved. */
  indexedAt: integer("indexed_at"),
  updatedAt: integer("updated_at"),
  /** Stored, never interpreted: skew is answered by rebuilding, so no index is ever migrated. */
  providerVersion: text("provider_version"),
  errorMessage: text("error_message"),
  /**
   * What the last handover sync cost, for the measurement story to read
   * (EO-153). Written by a sync and by nothing else; null until one has
   * succeeded.
   */
  lastSyncDurationMs: integer("last_sync_duration_ms"),
  /** The implementation's own count of what it changed, never one EO computed. */
  lastSyncChangedFiles: integer("last_sync_changed_files"),
  /**
   * What the last build from nothing cost, and how much disk the index
   * takes (EO-155). Written by a build; the size is refreshed by a sync,
   * the duration is not — a handover rebuilds nothing.
   */
  lastIndexDurationMs: integer("last_index_duration_ms"),
  indexSizeBytes: integer("index_size_bytes"),
});

// ── Jobs: the recurring definitions that stamp work out ────────

/**
 * A job: a trigger, a pipeline, a template and an owner (EO-304,
 * `ARCHITECTURE.md`, "One work entity").
 *
 * Not a second kind of work item. "A scheduled run and a webhook are
 * not a different kind of work item. They are a different way of
 * *creating* one" — so everything a job produces is an ordinary `items`
 * row on an ordinary step, and this table holds only the standing
 * definition that produced it.
 *
 * The trigger kinds EO can fire are `manual`, `from-discussion` and —
 * since EO-306 — `schedule`, which carries its own IANA zone and a
 * catch-up grace (`packages/core/src/schemas/jobs.ts`). `webhook` waits
 * for the server that has a public address (phase 7d).
 */
export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(), // uuidv7
  /**
   * Which project the job belongs to.
   *
   * Nullable for `items.project_id`'s reason: EO is usable before
   * anything is configured, and a job written then is a real job.
   * Cascading, like `pipelines`, because a job is configuration of a
   * project rather than history of it.
   */
  projectId: text("project_id").references((): AnySQLiteColumn => projects.id, { onDelete: "cascade" }),
  /** What a person calls it — and what `{{job}}` in the template expands to. */
  name: text("name").notNull(),
  /** `JobTriggerSchema`. What makes an occurrence happen. */
  trigger: text("trigger", { mode: "json" }).notNull(),
  /**
   * Where the items it stamps out flow, and what they look like.
   *
   * Both nullable, and both required of a `manual` job — `createJob`
   * refuses one without them. A `from-discussion` job has neither: the
   * conversation supplies the item and the approval resolves the
   * placement, so a template here would be a second answer to a
   * question that has already been answered, and a pipeline here would
   * be one the approval is free to contradict.
   */
  pipelineId: text("pipeline_id").references((): AnySQLiteColumn => pipelines.id),
  /** `JobTemplateSchema`. */
  template: text("template", { mode: "json" }),
  /** Whose inbox it fills and whose budget it draws on (ARCHITECTURE.md, "Controls"). */
  ownerId: text("owner_id")
    .notNull()
    .references((): AnySQLiteColumn => people.id),
  /**
   * The one off-board item this job owns as its thread (ARCHITECTURE.md, "What a job records").
   *
   * The Discussions precedent reused: a guard that fires when no item
   * exists — a skipped occurrence, a budget trip before dispatch — posts
   * there and mentions the owner, so invariant #8 holds without
   * inventing the second channel invariant #4 forbids.
   *
   * A real foreign key, so the pointer cannot dangle. `deleteItem`
   * removes the jobs whose thread is being deleted, which is what keeps
   * deleting a conversation (its from-discussion job's thread) from
   * failing on this constraint.
   */
  threadItemId: text("thread_item_id")
    .notNull()
    .references((): AnySQLiteColumn => items.id),
  /**
   * When somebody — or a budget trip — stopped this job (EO-307).
   *
   * A paused job fires nothing: `fireJob` refuses one whichever door it
   * is reached through, and a tick writes a `skipped` row carrying
   * `paused` for each occurrence that came round while it was off, so
   * the history says what did not happen rather than showing a gap.
   * `items.held_at` is the pattern (EO-45) — a state a person can see
   * and undo, rather than a row that quietly stops meaning anything.
   */
  pausedAt: integer("paused_at"),
  /**
   * Which act stopped it: `budget` or `by hand` (EO-308, ARCHITECTURE.md, "The inbox, the archive
   * and jobs").
   *
   * Written beside `paused_at` rather than worked out from the spend.
   * The design gives a paused job one of two chips, and which one is a fact
   * about what happened — a person who looks at an expensive occurrence
   * and then pauses the job themselves did not have a budget trip them.
   * Null while the job runs, and null on a row paused before 0081, which
   * reads as "by hand": a pause EO cannot attribute to a guard of its
   * own is one a person chose.
   */
  pausedReason: text("paused_reason"),
  /**
   * What one occurrence may spend, in cents (EO-307, ARCHITECTURE.md, "Controls").
   *
   * Enforced by the supervisor before a dispatch: when the runs on an
   * occurrence's item reach it, the next dispatch is refused, the item
   * is parked, and the job is paused — `main/jobs/budget.ts`. Null is no
   * budget, which is every job until somebody sets one.
   */
  budgetPerOccurrenceCents: integer("budget_per_occurrence_cents"),
  /**
   * The other control the design names — stored now, read by the webhook
   * story (7d).
   *
   * Nothing enforces it here, deliberately: a schedule fires one item
   * per occurrence and an occurrence comes round at most once a minute,
   * so the cap it exists for is one only a public address can reach.
   */
  maxItemsPerHour: integer("max_items_per_hour"),
  /**
   * Which machine runs it — `device` or `server` (EO-330, ARCHITECTURE.md, "Where a job runs").
   *
   * The one setting placement is; everything about whether a person may
   * *choose* the other one is worked out from the pipeline, the agent
   * rows and the secret namespaces rather than written down beside it
   * (invariant #6, and `packages/core/src/placement.ts` argues it at
   * length). `device` on every row that existed before 0101, which is
   * where every job has always run.
   */
  runsOn: text("runs_on").notNull().default("device"),
  /**
   * When a person deleted it — a tombstone, not a gone row (EO-308,
   * ARCHITECTURE.md, "The inbox, the archive and jobs").
   *
   * Deleting a job offers "archive its items" or "keep them", and an
   * item somebody chose to keep still has to name what filed it. Its
   * provenance is the occurrence, and the occurrence would die with the
   * job — so the row stays and says it is gone: out of `listJobs`, out
   * of `listAllJobs`, out of `jobForThreadItem`, out of Run now, its
   * thread archived. `getJob` still answers, which is how `originOfItem`
   * still has a name to give. 0080 says the whole of why.
   */
  deletedAt: integer("deleted_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Every time a job fired, or did not (ARCHITECTURE.md, "What a job records").
 *
 * **Append-only, the way `transitions` is.** Nothing in this tree
 * updates or deletes a row — `db/architecturalInvariants.test.ts`
 * checks that beside `run_events` — because the whole value of an
 * occurrence is that it says what happened at a moment that has passed.
 * A `skipped` row that could be tidied away is a job that quietly never
 * ran.
 *
 * The cascade below is the only removal the schema has, and since
 * EO-308 nothing reaches it: deleting a job stamps `jobs.deleted_at`
 * and leaves the row, because the items a person chose to keep read
 * their provenance back through these rows. What invariant #3's own
 * exception allowed turned out not to be needed — a job being gone from
 * every list is what a person deleting one means, and erasing what it
 * did while it existed was never part of that. The cascade stays
 * declared for the one act that still removes a job row: the project it
 * belongs to being deleted, which takes its items with it too.
 */
export const jobOccurrences = sqliteTable(
  "job_occurrences",
  {
    id: text("id").primaryKey(), // uuidv7
    jobId: text("job_id")
      .notNull()
      .references((): AnySQLiteColumn => jobs.id, { onDelete: "cascade" }),
    /** The moment it was *for*. For a manual run and a Create, the moment somebody pressed. */
    dueAt: integer("due_at").notNull(),
    /** When it actually ran. Null on a `skipped` row: that is the difference. */
    firedAt: integer("fired_at"),
    /** fired | skipped | failed. */
    status: text("status").notNull(),
    /** Why, for anything but `fired`. The same sentence the thread comment carries. */
    reason: text("reason"),
    /**
     * What it created. Null for `skipped` and `failed`.
     *
     * Deliberately not a foreign key, for `comment_mentions.target_id`'s
     * reason turned the other way round: a person may delete the item
     * (KAN-30), and the record of the job having fired outlives it. A
     * cascade would erase the firing and `on delete set null` would
     * rewrite an append-only row, so the column keeps the id and the
     * readers tolerate an item that is no longer there.
     */
    itemId: text("item_id"),
    /**
     * The comment that offered to run this occurrence (EO-306,
     * migration 0079).
     *
     * Set only on a `skipped` row that was skipped beyond the grace: it
     * is the question on the job's thread carrying "Run it now", and it
     * is what a reply answering that question is matched against. A
     * `fired` row was never offered, and a skip for "the previous item
     * is still open" carries no offer because running it is the
     * duplicate the skip existed to prevent.
     *
     * Written with the row and never after it, so the append-only rule
     * holds: the comment is posted first and the occurrence recorded
     * second, inside one transaction.
     *
     * Not a foreign key, for `item_id`'s reason directly above: a person
     * may delete a comment, and the record of the offer having been made
     * outlives it.
     */
    offerCommentId: text("offer_comment_id"),
  },
  (table) => [
    index("idx_job_occurrences_job").on(table.jobId, table.dueAt),
    // Which job made this item — what the detail rail asks, once per item.
    index("idx_job_occurrences_item").on(table.itemId),
    // Which occurrence this comment offered — what the reply path asks,
    // once per comment posted on a job thread.
    index("idx_job_occurrences_offer").on(table.offerCommentId),
  ],
);

/**
 * Every webhook delivery, and what it did (EO-332, ARCHITECTURE.md, "What a job records",
 * "Webhooks").
 *
 * The review's question about the first draft was: where is a
 * *deduplicated*, malformed or over-cap event recorded? There was
 * nowhere, and "nowhere" is exactly the case a person goes looking for
 * — an event they know the other end sent and no item to show for it.
 * This table is the answer, and the rule is the strong one: **one row
 * per request, without exception.** A request that was refused at the
 * signature is a row; a burst that is waiting is thirty rows.
 *
 * **Append-only, the way `job_occurrences` is.** Nothing in this tree
 * updates or deletes a row — `db/architecturalInvariants.test.ts` holds
 * the whole tree to it. Which is why a held event that is later
 * released writes a *second* row, `created`, carrying the same event
 * key: the first row says what happened when it arrived and goes on
 * saying it, and the second says what happened when the tick got to it.
 * Promoting the first in place would be the one thing a record may not
 * do.
 *
 * ### The unique index, and why it has a `where`
 *
 * the original design asks for "an event key that is unique per job so the same event
 * never creates two items", and `idx_job_events_created` is that
 * sentence and nothing wider: unique on `(job_id, event_key)` **among
 * the rows that created an item**. A plain unique index over every row
 * would contradict the rule above within one delivery — the second
 * arrival of an event carries the same key by construction, and its
 * `deduplicated` row could not be written at all.
 *
 * Narrowed to `created` rather than to `created` and `held` together,
 * because two genuinely simultaneous deliveries of one event may both
 * be held before either is decided, and the release is where that is
 * caught: the second one to be released finds the key taken and is
 * recorded as `deduplicated`, which is what it is. The guarantee that
 * matters holds either way, and it is SQLite's rather than a
 * read-then-write two requests can interleave inside.
 */
export const jobEvents = sqliteTable(
  "job_events",
  {
    id: text("id").primaryKey(), // uuidv7
    jobId: text("job_id")
      .notNull()
      .references((): AnySQLiteColumn => jobs.id, { onDelete: "cascade" }),
    /** When the door read it. The order held events are released in. */
    receivedAt: integer("received_at").notNull(),
    /** The sender's own id for it where the mapping declares one, else a hash of the body. */
    eventKey: text("event_key").notNull(),
    /**
     * The body exactly as it arrived, as text.
     *
     * Raw rather than re-serialised, because the signature is over these
     * bytes and a payload EO had reformatted could not be checked
     * again. Empty on a row whose signature or timestamp was refused:
     * an unverified body is not this job's event, and keeping it would
     * let a stranger who holds no secret write into the record as fast
     * as the throttle admits them.
     */
    payload: text("payload").notNull(),
    /** `JobEventOutcomeSchema` — one of the seven. */
    outcome: text("outcome").notNull(),
    /** Why, for anything but `created`. The same sentence the thread comment carries. */
    reason: text("reason"),
    /**
     * What it created. Null for everything but `created`.
     *
     * Deliberately not a foreign key, for `job_occurrences.item_id`'s
     * reason: a person may delete the item (KAN-30), and the record of
     * the event having created it outlives it.
     */
    itemId: text("item_id"),
  },
  (table) => [
    // The Events tab, and the release order in one index: newest-first
    // for the page, oldest-first for the tick, both off `(job, received)`.
    index("idx_job_events_job").on(table.jobId, table.receivedAt),
    // What is still waiting, per job — the "N waiting" of the design, and the
    // queue the tick walks.
    index("idx_job_events_outcome").on(table.jobId, table.outcome, table.receivedAt),
    // The design's own sentence — one event, at most one item — is
    // `idx_job_events_created`, and it is in the migration rather than
    // here for `people.email`'s reason: it is a *partial* index, and
    // drizzle's `uniqueIndex` has no way to say `where outcome =
    // 'created'`. An unconditional one declared here would be a
    // different index from the one the database actually has, which is
    // worse than none.
  ],
);

// ── The record and its devices ────────────────────────────────

/**
 * Who is allowed to be dispatching an item right now, and until when
 * (EO-322, `ARCHITECTURE.md`, "The record").
 *
 * The record owns item state and runs the only scheduler; a device
 * claims a dispatch under a lease with a time limit, runs the
 * machine-local preflight and reports a result or a refusal as a
 * comment. This table is that lease. In solo mode the desktop is both
 * roles in one process and the lease is local, which is the point: one
 * code path, and managed mode is a matter of where the record lives.
 *
 * `item_id` is the primary key rather than a column beside a lease id,
 * because one item admits one lease and SQLite's own uniqueness is the
 * cheapest way to say so: the grant is an insert that either lands or
 * finds the row already there, with no read-then-write for two devices
 * to interleave. Which is also why there is no `run_id` here — a lease
 * covers the preflight, which happens *before* a run row exists, and
 * that gap is exactly what the in-process item lock could not cover
 * across two machines.
 *
 * Not append-only: a lease is a claim on the present, not a record of
 * what happened. What happened is the run, the transition and the
 * comment the device posts, and all three of those outlive it.
 */
export const dispatchLeases = sqliteTable(
  "dispatch_leases",
  {
    itemId: text("item_id")
      .primaryKey()
      .references((): AnySQLiteColumn => items.id, { onDelete: "cascade" }),
    /** The device holding it. `local` for the one this desktop runs in its own process. */
    deviceId: text("device_id").notNull(),
    grantedAt: integer("granted_at").notNull(),
    /**
     * When the claim stops standing.
     *
     * A device renews while it is still working, so this passing means
     * the device stopped saying so — it crashed, lost power, or went
     * offline mid-dispatch. The record's tick releases it and says which
     * device held it (invariant #8).
     */
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("idx_dispatch_leases_expires").on(table.expiresAt)],
);

/**
 * What this device did and the record has not confirmed yet (EO-324,
 * `ARCHITECTURE.md`, "The record").
 *
 * The queue behind "offline since 09:12". A device applies what it did
 * to its own replica at once — a person pressing Approve must not wait
 * on a network — and writes the command here in the same breath. The
 * drain replays it to the record in order; the record applies it or
 * refuses it, and only then is the row gone.
 *
 * So a row here is exactly the set of moves and messages that are
 * **provisional**: the card wears a dashed border and the word
 * *queued* while one of its commands is in this table, and stops when
 * the record has answered. That is the whole of the mechanism, and it
 * is the same mechanism online — where the drain runs on the same tick
 * and the word is on the screen for a moment rather than for an
 * afternoon.
 *
 * **Ordered by id**, which is a UUIDv7 and therefore by the moment the
 * command was made. Replaying a queue out of order would be replaying a
 * different history: a comment written before a move must arrive before
 * it, or an agent reads the thread without the correction in it.
 *
 * `item_id` cascades, because a command about an item somebody deleted
 * is not a command any more (KAN-30 is a person asking for the item to
 * be gone). It is deliberately *not* invariant #3's subject: this is a
 * queue and not a record — what happened is the transition, the comment
 * and the run, all of which are kept elsewhere and none of which this
 * removal touches.
 */
/**
 * What the record has told this device about and it cannot place yet
 * (EO-324, `ARCHITECTURE.md`, "The record").
 *
 * The pull reads six lists, each paged on a cursor of its own, and a
 * page of one is not a page of the others: a device joining an
 * organisation can be handed a run's transcript on the same pass whose
 * run row falls on the *next* runs page, or a comment whose item is on
 * the next items page. Dropping those and advancing the cursor anyway
 * loses them for ever, because a cursor only moves forwards and a
 * comment is never paged twice.
 *
 * So what cannot be placed is kept, and tried again on the next pass.
 * The cursors go on moving — head-of-line blocking would be the other
 * failure, where one item this installation cannot resolve freezes the
 * whole board — and this table is the memory that makes that safe.
 *
 * It is also where a file this device knows about and has not yet
 * downloaded is remembered. That was an in-memory map until the same
 * reasoning caught up with it: the metadata arrives, its cursor
 * advances, the bytes fail or the app is closed, and on restart nothing
 * knows the file was ever mentioned. The record will not say again.
 *
 * `id` is a natural key per kind — `transition:<id>`, `attachment:<id>`,
 * `runEvents:<runId>:<seq>` — so the same row arriving twice, which a
 * cursor boundary guarantees, is one row here rather than two.
 *
 * Deliberately *not* invariant #3's subject: nothing here is a record
 * of what happened. It is a note about what this device has heard and
 * not yet written down, and it is deleted the moment it has.
 */
export const recordPending = sqliteTable(
  "record_pending",
  {
    /** `<kind>:<natural key>` — see the table comment. */
    id: text("id").primaryKey(),
    /** `agent` | `item` | `run` | `transition` | `comment` | `pin` | `mention` | `runEvents` | `attachment` | `watch`. */
    kind: text("kind").notNull(),
    /** The row exactly as it arrived, so a retry needs nothing else. */
    payload: text("payload", { mode: "json" }).notNull(),
    /** What it is waiting for, as a sentence — for a log line and for a person reading the table. */
    waitingFor: text("waiting_for").notNull(),
    createdAt: integer("created_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
  },
  (table) => [index("idx_record_pending_kind").on(table.kind, table.id)],
);

/**
 * A project this desktop has heard of but not yet read the history of
 * (EO-325) — see `0097_project_backfill.sql` for why the ordinary feed
 * cannot deliver it.
 */
export const recordBackfills = sqliteTable("record_backfills", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  /** How far the project-scoped pull has got — a whole `RecordCursors`. */
  cursors: text("cursors", { mode: "json" }).notNull(),
  createdAt: integer("created_at").notNull(),
  /** Null while it is still owed; stamped when a scoped page said there was no more. */
  doneAt: integer("done_at"),
});

export const recordCommands = sqliteTable(
  "record_commands",
  {
    /** UUIDv7. The replay order, and what the record acknowledges. */
    id: text("id").primaryKey(),
    /** `transition` | `comment` | `run` | `runEvents` — `RecordCommand["kind"]` in core. */
    kind: text("kind").notNull(),
    itemId: text("item_id")
      .notNull()
      .references((): AnySQLiteColumn => items.id, { onDelete: "cascade" }),
    /** The command itself, exactly as it will be sent. */
    payload: text("payload", { mode: "json" }).notNull(),
    createdAt: integer("created_at").notNull(),
    /** How many times the drain has tried. Kept so a command that cannot land can say how long it has been failing. */
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (table) => [index("idx_record_commands_item").on(table.itemId)],
);

/**
 * What the organisation has published, and so what is locked here
 * (EO-329, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * The record writes a row when an admin publishes a section; every
 * signed-in desktop receives it through the ordinary sync and holds it
 * read-only. What makes it a lock is not the row — it is the row *plus*
 * being a replica, which is why nothing here says "locked". On the
 * record these same rows lock nothing at all, because the record is
 * where an admin edits.
 *
 * Per section and never per field (ARCHITECTURE.md, "Publish, lock and versions"). `subjectId` is
 * finer than the
 * lock on purpose — it names the pipeline whose version a rollback goes
 * back to — and no reader of the lock looks at it.
 */
export const publishedSections = sqliteTable(
  "published_sections",
  {
    /** One of `PUBLISHED_SECTIONS` in core: pipelines, agents, packs, connectors, policy. */
    section: text("section").notNull(),
    /** The pipeline a version belongs to; `""` for a section with no versions of its own. */
    subjectId: text("subject_id").notNull().default(""),
    /**
     * The `pipeline_versions.id` published.
     *
     * No `references()`, for the reason `pipelines.current_version_id`
     * has none and one more besides: this table exists on a replica,
     * where the version history it names has not necessarily arrived.
     * A constraint would make a device reject the very row that tells
     * it the section is managed.
     */
    versionId: text("version_id"),
    /** The `6` of "v6", carried so a device can draw the row it holds. */
    versionNumber: integer("version_number"),
    publishedAt: integer("published_at").notNull(),
    /** The person who published, and what to call them — see the migration. */
    publishedBy: text("published_by"),
    publishedByName: text("published_by_name"),
    /**
     * What was published — `SectionDocumentSchema` in core.
     *
     * Null for a pipelines row, whose document is the
     * `pipeline_versions` row it names, and for a row written before
     * this column existed.
     */
    document: text("document", { mode: "json" }),
  },
  (table) => [primaryKey({ columns: [table.section, table.subjectId] }), index("idx_published_sections_at").on(table.publishedAt)],
);

/**
 * The actions a role defines for itself (EO-421).
 *
 * Keyed by role and action, and by nothing else: a definition is a thing
 * somebody wrote about one role, and it never applies to another. Keyed
 * on the role's *name* rather than on an agent, unlike the attachment
 * tables, because that is what a step names — `ownerRole` — and what a
 * dispatch is resolved by; two agents staffing one role answer the same
 * action in the same shape.
 *
 * Written only through `saveActionDefinition`, which holds every row to
 * `readActionDefinitionDraft` in `packages/core`.
 */
export const actionDefinitions = sqliteTable(
  "action_definitions",
  {
    id: text("id").primaryKey(), // uuidv7
    role: text("role").notNull(),
    action: text("action").notNull(),
    /** What the action is for, as the agent is told it. */
    description: text("description").notNull().default(""),
    /** `Array<{ key, label, meaning }>` — what a run of it can return, and what a route can name. */
    results: text("results", { mode: "json" }).notNull().default([]),
    /** A JSON Schema object for the answer's extra properties. */
    fields: text("fields", { mode: "json" }).notNull().default({}),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("idx_action_definitions_role_action").on(table.role, table.action)],
);

/**
 * One short model call that was not an agent run (EO-477).
 *
 * Memory selection, extraction and consolidation each ask a small model
 * one question with one schema-shaped answer, and none of them is a run:
 * no tools, no workspace, no thread, nothing on the board — and
 * consolidation belongs to a scope rather than to an item, which
 * `runs.item_id` cannot say. So each call is a row here instead, and the
 * spend readers that sum `runs.cost_cents` add these beside them
 * (`sideCallsRepo.ts`), so the budgets see every cent.
 *
 * **What it does not store**: the prompt or the answer. Neither is
 * evidence of anything a person needs to audit — the memory entry a call
 * produced is, and it records where it came from — and a prompt would be
 * a second copy of an item's whole thread.
 *
 * One row per call, refusals included: a call turned away on the budget
 * is written with no tokens and the reason, so "why did selection not
 * run?" has an answer.
 */
export const sideCalls = sqliteTable(
  "side_calls",
  {
    id: text("id").primaryKey(), // uuidv7
    /** `SideCallPurpose`: why EO asked. */
    purpose: text("purpose").notNull(),
    /** Null once the project is deleted; the spend it recorded still happened. */
    projectId: text("project_id").references((): AnySQLiteColumn => projects.id, { onDelete: "set null" }),
    /** The item it was about, where there is one. Deleted with the item, like its runs. */
    itemId: text("item_id").references((): AnySQLiteColumn => items.id),
    /** The run whose dispatch or settle it happened inside, where it did. */
    runId: text("run_id").references((): AnySQLiteColumn => runs.id),
    backend: text("backend").notNull(),
    /** The model asked for; null where the backend's own default was used. */
    model: text("model"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    /**
     * Millionths of a cent (EO-510): a side call costs a fraction of one,
     * which whole cents record as nothing. Summed first, rounded after.
     */
    costMicrocents: integer("cost_microcents").notNull().default(0),
    startedAt: integer("started_at").notNull(),
    durationMs: integer("duration_ms").notNull(),
    /** `succeeded` or `failed`. */
    outcome: text("outcome").notNull(),
    /** `SideCallFailureReason` on a failed call; null on one that succeeded. */
    reason: text("reason"),
  },
  (table) => [
    index("idx_side_calls_started_at").on(table.startedAt),
    index("idx_side_calls_item").on(table.itemId),
    index("idx_side_calls_project").on(table.projectId),
  ],
);

/**
 * One memory entry (EO-478, ARCHITECTURE.md, "What an agent is given").
 *
 * Something true of a project, or of one of its workspaces, that the
 * next run there should know: written by a person, or by an agent's run
 * on an item. Entries are what a dispatch's memory section is drawn
 * from — the active ones of the item's project and of each workspace its
 * step works in.
 *
 * **Nothing is deleted.** An edit retires the old row as `edited` and
 * inserts a new one, a person retires an entry as `retired`, and a
 * consolidation (EO-480) retires the entries it folded as
 * `consolidated`, and an agent's note that names the entries it
 * corrects retires them as `superseded` (EO-594); a restore clears
 * `retired_at`. So the history of what
 * an agent was told is always there to read.
 *
 * `scope_id` names a project or a workspace according to `scope_kind`,
 * so it has no foreign key. The source's run and item go null if the
 * item is deleted, because the entry belongs to the project, not to the
 * item it was learned on.
 */
export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(), // uuidv7, minted client-side
    /** `MemoryScopeKind`: `project` or `workspace`. */
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    body: text("body").notNull(),
    /** `person` or `run`. */
    sourceKind: text("source_kind").notNull(),
    /** The person, in organisation mode; null on a solo installation and for a run's entry. */
    sourcePersonId: text("source_person_id"),
    sourceRunId: text("source_run_id").references((): AnySQLiteColumn => runs.id, { onDelete: "set null" }),
    sourceItemId: text("source_item_id").references((): AnySQLiteColumn => items.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** Null while the entry is active. */
    retiredAt: integer("retired_at"),
    /** `MemoryRetirementReason` once retired. */
    retiredReason: text("retired_reason"),
    /** The consolidation that retired or wrote this entry (EO-480). */
    consolidationId: text("consolidation_id"),
    /** A run's entry EO drew out of what the run produced, rather than one the agent wrote (EO-479). */
    extracted: integer("extracted", { mode: "boolean" }).notNull().default(false),
    /** Kept by a consolidation although it disagrees with the workspace's CLAUDE.md or AGENTS.md (EO-480). */
    contradictsRepositoryFile: integer("contradicts_repository_file", { mode: "boolean" }).notNull().default(false),
    /**
     * The project the entry belongs to (EO-482): the scope itself for a
     * project's entry, the workspace's project for a workspace's. A
     * workspace never travels to a record, so this is what says whose a
     * workspace's entries are there. Null for a workspace with no project.
     */
    projectId: text("project_id"),
    /**
     * The version an edit replaced (EO-545): set on the row `editMemory`
     * writes, to the row it retired as `edited`, and never changed after.
     * Null on every entry no edit wrote. No foreign key, for `project_id`'s
     * reason: a replica may be sent a version a page before the one it
     * replaced.
     */
    replacesId: text("replaces_id"),
    /**
     * The entries a note superseded (EO-594): set on the row `noteMemory`
     * writes, to the agent-written entries it named and retired as
     * `superseded` in the same transaction, and never changed after. Empty
     * on every other row. No foreign key, for `replaces_id`'s reason.
     */
    supersededIds: text("superseded_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
  },
  (table) => [
    index("idx_memories_scope").on(table.scopeKind, table.scopeId, table.retiredAt),
    index("idx_memories_project").on(table.projectId),
    index("idx_memories_updated").on(table.updatedAt, table.id),
    index("idx_memories_replaces").on(table.replacesId),
  ],
);

/**
 * One consolidation of one memory scope (EO-480, ARCHITECTURE.md, "What
 * an agent is given").
 *
 * Its id is the `consolidation_id` the entries it retired and wrote are
 * tagged with, and `retired_ids` / `written_ids` say exactly which, so a
 * restore puts back this one's set even after a later consolidation
 * retagged some of them. The newest `succeeded` row is when the scope was
 * last consolidated; `failed` rows since then are the backoff.
 */
export const memoryConsolidations = sqliteTable(
  "memory_consolidations",
  {
    id: text("id").primaryKey(), // uuidv7, minted client-side
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    /** `MemoryConsolidationTrigger`. */
    trigger: text("trigger").notNull(),
    /** `MemoryConsolidationStatus`. */
    status: text("status").notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    /** When a person put back the set from before it; null until then. */
    restoredAt: integer("restored_at"),
    retiredIds: text("retired_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
    writtenIds: text("written_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** The side call's `SideCallFailureReason` on a failure: `budget` is waited out, the rest back off. */
    failureReason: text("failure_reason"),
    note: text("note"),
    /** The caps in force when it settled the scope (a success, a skip or a restore); a change to them is a reason to look again. */
    capsEntries: integer("caps_entries"),
    capsChars: integer("caps_chars"),
    /**
     * How long its side calls held a global concurrency slot, in all
     * (EO-577): 0 for one that made none, null for one recorded before
     * it was counted.
     */
    slotHeldMs: integer("slot_held_ms"),
    /**
     * When EO said consolidation of its scope is stuck, at this, the third
     * failure in a row (EO-577): a note on the project thread, or this
     * row's own note for a scope on no project. Null otherwise.
     */
    stuckNoticedAt: integer("stuck_noticed_at"),
  },
  (table) => [index("idx_memory_consolidations_scope").on(table.scopeKind, table.scopeId, table.startedAt)],
);

/**
 * One skill a memory consolidation proposed (EO-483, ARCHITECTURE.md,
 * "What an agent is given").
 *
 * Posted on the project's thread as the comment `comment_id` names,
 * offering Save and Discard; nothing is saved from it until a person
 * presses Save. A discarded row is kept so a later consolidation never
 * posts a proposal with its scope and slug again (EO-512), until a person
 * replies "Propose again" under it, which deletes it.
 */
export const skillProposals = sqliteTable(
  "skill_proposals",
  {
    id: text("id").primaryKey(), // uuidv7, minted client-side
    /** The consolidation that proposed it, whose id the entries Save retires are tagged with. */
    consolidationId: text("consolidation_id").notNull(),
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    /** `new` or `improvement`. */
    kind: text("kind").notNull(),
    /** An improvement's target, by the slug it was proposed against. */
    targetSlug: text("target_slug"),
    /** That skill's id when it was posted, or null when it was gone. */
    targetSkillId: text("target_skill_id"),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    /** The SKILL.md body below its frontmatter. */
    body: text("body").notNull(),
    evidenceEntryIds: text("evidence_entry_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
    evidenceItemIds: text("evidence_item_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** The entries that hold the evidence as the consolidation left them: what Save moves into the skill. */
    coveringEntryIds: text("covering_entry_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** `skillProposalFingerprint`: scope, slug and normalised description. */
    fingerprint: text("fingerprint").notNull(),
    /** `SkillProposalStatus`. */
    status: text("status").notNull(),
    /** Why it was posted without Save — its slug was taken, or its target gone — or null. */
    unsaveable: text("unsaveable"),
    commentId: text("comment_id").references((): AnySQLiteColumn => comments.id, { onDelete: "set null" }),
    /** The skill Save created or improved. */
    skillId: text("skill_id"),
    /** The entries Save retired as `moved_to_skill`. */
    movedEntryIds: text("moved_entry_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
    createdAt: integer("created_at").notNull(),
    decidedAt: integer("decided_at"),
  },
  (table) => [
    index("idx_skill_proposals_fingerprint").on(table.scopeKind, table.scopeId, table.fingerprint),
    uniqueIndex("idx_skill_proposals_comment").on(table.commentId),
  ],
);
