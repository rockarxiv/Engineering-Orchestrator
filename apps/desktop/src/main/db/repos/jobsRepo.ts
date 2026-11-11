import { and, desc, eq, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import {
  DEFAULT_JOB_RUNS_ON,
  JobPauseReasonSchema,
  JobRunsOnSchema,
  JobTemplateSchema,
  JobTriggerSchema,
  uuidv7,
  type Job,
  type JobOccurrence,
  type JobOccurrenceStatus,
  type JobPauseReason,
  type JobRunsOn,
  type JobTemplate,
  type JobTrigger,
  type Uuid,
} from "@eo/core";
import type { Db } from "../client.js";
import { jobOccurrences, jobs } from "../schema.js";
import { dropWebhookWaiversWithoutEntry } from "./webhookWaiverRepo.js";

/**
 * The `jobs` and `job_occurrences` tables (EO-304,
 * `ARCHITECTURE.md`, "What a job records").
 *
 * Table access only. What a job *means* — that creating one creates the
 * off-board item it posts guards on, that firing one stamps an item out
 * of its template — lives in `main/jobs/`, because none of it is a
 * question about these two tables and all of it is a question about
 * items, people and pipelines.
 *
 * **`job_occurrences` is append-only.** There is deliberately no update
 * and no delete here, the way `runEventsRepo` has none: the value of an
 * occurrence is that it says what happened at a moment that has passed,
 * and a `skipped` row that can be tidied away is a job that quietly
 * never ran. `db/architecturalInvariants.test.ts` holds the whole tree
 * to that, beside `run_events` and `transitions`.
 */

function toJob(row: typeof jobs.$inferSelect): Job {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    // Parsed rather than cast. The column is JSON and the union is what
    // says which kinds EO can actually fire (ARCHITECTURE.md, "Trigger kinds") — a row holding
    // something else is a database somebody else wrote to, and reading
    // it as a trigger would mean a scheduler switching on a kind that
    // does not exist.
    trigger: JobTriggerSchema.parse(row.trigger),
    pipelineId: row.pipelineId,
    template: row.template === null ? null : JobTemplateSchema.parse(row.template),
    ownerId: row.ownerId,
    pausedAt: row.pausedAt,
    // Parsed rather than cast, for `trigger`'s reason: a row holding
    // something else is a database somebody else wrote to, and the chip
    // would then be drawn from a word EO does not have. An unreadable
    // value reads as "by hand", which is what a null reads as too.
    pausedReason: JobPauseReasonSchema.safeParse(row.pausedReason).data ?? null,
    budgetPerOccurrenceCents: row.budgetPerOccurrenceCents,
    maxItemsPerHour: row.maxItemsPerHour,
    // Parsed rather than cast, for `trigger`'s reason, and falling back
    // to `device` rather than refusing: a row holding a third word is a
    // database a newer version wrote, and reading it as "wherever this
    // process happens to be" would run somebody's work in a place they
    // never picked. `device` is the one answer that is true of every
    // installation.
    runsOn: JobRunsOnSchema.safeParse(row.runsOn).data ?? DEFAULT_JOB_RUNS_ON,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toOccurrence(row: typeof jobOccurrences.$inferSelect): JobOccurrence {
  return {
    id: row.id,
    jobId: row.jobId,
    dueAt: row.dueAt,
    firedAt: row.firedAt,
    status: row.status as JobOccurrenceStatus,
    reason: row.reason,
    itemId: row.itemId,
    offerCommentId: row.offerCommentId,
  };
}

export interface InsertJobInput {
  projectId: Uuid | null;
  name: string;
  trigger: JobTrigger;
  pipelineId: string | null;
  template: JobTemplate | null;
  ownerId: Uuid;
  budgetPerOccurrenceCents?: number | null;
  maxItemsPerHour?: number | null;
  /** Omitted is `device` — see the column, and `DEFAULT_JOB_RUNS_ON`. */
  runsOn?: JobRunsOn;
}

/** Writes the row. What is checked before it is written is `main/jobs/jobs.ts`'s. */
export function insertJob(db: Db, input: InsertJobInput): Job {
  const now = Date.now();
  const row = db
    .insert(jobs)
    .values({
      id: uuidv7(),
      projectId: input.projectId,
      name: input.name,
      trigger: input.trigger,
      pipelineId: input.pipelineId,
      template: input.template,
      ownerId: input.ownerId,
      pausedAt: null,
      pausedReason: null,
      budgetPerOccurrenceCents: input.budgetPerOccurrenceCents ?? null,
      maxItemsPerHour: input.maxItemsPerHour ?? null,
      runsOn: input.runsOn ?? DEFAULT_JOB_RUNS_ON,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toJob(row);
}

export function getJob(db: Db, id: Uuid): Job | undefined {
  const row = db.select().from(jobs).where(eq(jobs.id, id)).get();
  return row ? toJob(row) : undefined;
}

/**
 * Pauses the job, or starts it again (EO-307, ARCHITECTURE.md, "Controls").
 *
 * The one pair of columns on `jobs` anything but a person's edit
 * writes: a budget trip pauses the job it tripped, and every other
 * update here is something a person asked for on the Job page.
 * `main/jobs/budget.ts` is what decides when — this is the write.
 *
 * `reason` is which act it was (EO-308, ARCHITECTURE.md, "The inbox, the archive and jobs"), and it
 * is a parameter
 * rather than something read back off the spend because the spend
 * cannot tell a guard's pause from a person's: the numbers are
 * identical, and only the caller knows which of them it is.
 *
 * `updatedAt` moves with it, because a paused job *is* a job that
 * changed: the Jobs list orders and the sixth story's page reads it.
 */
export function setJobPaused(db: Db, id: Uuid, pausedAt: number | null, reason: JobPauseReason | null = null): Job | undefined {
  const row = db
    .update(jobs)
    // The reason moves with the moment, always — including to null on a
    // resume. A column that kept the last reason across a resume would
    // say "budget" about the *next* pause, whoever made it.
    .set({ pausedAt, pausedReason: pausedAt === null ? null : reason, updatedAt: Date.now() })
    .where(eq(jobs.id, id))
    .returning()
    .get();
  return row ? toJob(row) : undefined;
}

/**
 * Every job on a project, newest first.
 *
 * `null` is a real scope and not "all of them", for `items.projectId`'s
 * reason: a job written before anything was configured belongs to no
 * project, and folding it into every project's list would show it on
 * screens it has nothing to do with.
 */
export function listJobs(db: Db, projectId: Uuid | null): Job[] {
  return db
    .select()
    .from(jobs)
    .where(and(projectId === null ? isNull(jobs.projectId) : eq(jobs.projectId, projectId), isNull(jobs.deletedAt)))
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .all()
    .map(toJob);
}

/** Every job, whatever project it is on — what the scheduler ticks over. */
export function listAllJobs(db: Db): Job[] {
  return db.select().from(jobs).where(isNull(jobs.deletedAt)).orderBy(jobs.createdAt, jobs.id).all().map(toJob);
}

/**
 * Whether an event from outside could arrive on this pipeline
 * (EO-334, ARCHITECTURE.md, "Results and routes").
 *
 * What `validatePipeline` is told before it decides whether a
 * side-effecting step needs a person in front of it. A *webhook* job
 * rather than any job: a schedule and a Create are EO's own people
 * asking for work, and the payload nobody in the installation wrote is
 * the one this is about.
 *
 * Deleted jobs are passed over, for `listAllJobs`' reason — nothing can
 * tick one, so nothing can arrive through it — and a paused one is not,
 * because a pause is a switch somebody flips back.
 */
export function pipelineHasWebhookEntry(db: Db, pipelineId: string): boolean {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.pipelineId, pipelineId), isNull(jobs.deletedAt)))
    .all()
    .map(toJob)
    .some((job) => job.trigger.kind === "webhook");
}

/**
 * The from-discussion job a conversation made, if there is one (ARCHITECTURE.md, "What a job records").
 *
 * How the second Create in a conversation reuses the job the first one
 * made rather than filing a second definition of the same thing: the
 * job's trigger names the conversation.
 */
export function jobForConversation(db: Db, conversationId: Uuid): Job | undefined {
  const row = db
    .select()
    .from(jobs)
    .where(and(fromDiscussionOf([conversationId]), isNull(jobs.deletedAt)))
    .get();
  return row ? toJob(row) : undefined;
}

/** The from-discussion jobs any of these conversations made — what `deleteItem` takes with them. */
export function fromDiscussionOf(conversationIds: readonly string[]): SQL {
  return sql`json_extract(${jobs.trigger}, '$.kind') = 'from-discussion' and json_extract(${jobs.trigger}, '$.conversationId') in ${conversationIds}`;
}

/**
 * What a person may change about a job (EO-308, ARCHITECTURE.md, "The inbox, the archive and
 * jobs").
 *
 * Absence is "leave it", and `null` where the column is nullable is a
 * real value — clearing a budget is said by passing null, and a patch
 * that could not tell the two apart would make a budget unclearable.
 *
 * Nothing here decides *whether* the edit is allowed: a schedule that
 * does not parse and a pipeline that has been deleted are refused in
 * `main/jobs/jobs.ts`, beside the identical checks `createJob` makes,
 * so there is one answer to "can this job fire" rather than one per
 * door.
 */
export interface UpdateJobInput {
  name?: string;
  trigger?: JobTrigger;
  pipelineId?: string | null;
  template?: JobTemplate | null;
  budgetPerOccurrenceCents?: number | null;
  maxItemsPerHour?: number | null;
  /** Never null: a job runs somewhere, so "clear it" is not a thing to say. */
  runsOn?: JobRunsOn;
}

export function updateJobRow(db: Db, id: Uuid, input: UpdateJobInput): Job | undefined {
  const row = db
    .update(jobs)
    .set({
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
      ...(input.pipelineId === undefined ? {} : { pipelineId: input.pipelineId }),
      ...(input.template === undefined ? {} : { template: input.template }),
      ...(input.budgetPerOccurrenceCents === undefined ? {} : { budgetPerOccurrenceCents: input.budgetPerOccurrenceCents }),
      ...(input.maxItemsPerHour === undefined ? {} : { maxItemsPerHour: input.maxItemsPerHour }),
      ...(input.runsOn === undefined ? {} : { runsOn: input.runsOn }),
      updatedAt: Date.now(),
    })
    .where(eq(jobs.id, id))
    .returning()
    .get();
  // An edit can take a webhook job off a pipeline two ways — to another
  // pipeline, or to another kind of trigger — and either may have been
  // the pipeline's last (EO-405). Asked of the table rather than of this
  // row's before and after; see `dropWebhookWaiversWithoutEntry`.
  if (row && (input.trigger !== undefined || input.pipelineId !== undefined)) dropWebhookWaiversWithoutEntry(db);
  return row ? toJob(row) : undefined;
}

/**
 * Records that a person is done with this job (EO-308, ARCHITECTURE.md, "The inbox, the archive and
 * jobs").
 *
 * The row stays. 0078 removed it and let the cascade take its
 * occurrences; the Job page's delete offers "keep them", and an item
 * kept on the board reads its provenance back through those
 * occurrences — so erasing them would take the answer to "what filed
 * this?" away from work a person deliberately kept.
 *
 * What "deleted" then means is everything a person asking for it means:
 * gone from `listJobs`, passed over by `listAllJobs` so no tick can
 * reach it, unfindable by `jobForConversation` so a conversation starts a
 * new job rather than reviving this one, and refused by Run now. A
 * from-discussion job's conversation is archived with it rather than
 * deleted, which is `deleteJob` in `main/jobs/jobs.ts` — what was said
 * outlives the definition that owned it.
 */
export function markJobDeleted(db: Db, id: Uuid, at: number = Date.now()): Job | undefined {
  const row = db.update(jobs).set({ deletedAt: at, updatedAt: at }).where(eq(jobs.id, id)).returning().get();
  // If that was the last webhook job on its pipeline, the waiver given
  // for it goes with it (EO-405): the next one is accepted afresh.
  if (row) dropWebhookWaiversWithoutEntry(db, at);
  return row ? toJob(row) : undefined;
}

export interface RecordOccurrenceInput {
  jobId: Uuid;
  /** The moment it was for. For a manual run and a Create, the moment somebody pressed. */
  dueAt: number;
  status: JobOccurrenceStatus;
  /** Null on a `skipped` row — that is the difference between skipped and fired. */
  firedAt?: number | null;
  reason?: string | null;
  itemId?: Uuid | null;
  /**
   * The comment offering to run this one (EO-306).
   *
   * Passed in rather than filled afterwards, because there is no
   * afterwards: the table has no update path, so the comment is posted
   * first and named here, both inside one transaction.
   */
  offerCommentId?: Uuid | null;
}

/** Appends one occurrence. The only write this table has. */
export function recordOccurrence(db: Db, input: RecordOccurrenceInput): JobOccurrence {
  const row = db
    .insert(jobOccurrences)
    .values({
      id: uuidv7(),
      jobId: input.jobId,
      dueAt: input.dueAt,
      firedAt: input.firedAt ?? null,
      status: input.status,
      reason: input.reason ?? null,
      itemId: input.itemId ?? null,
      offerCommentId: input.offerCommentId ?? null,
    })
    .returning()
    .get();
  return toOccurrence(row);
}

/** One job's history, newest first — including the skipped rows (ARCHITECTURE.md, "The inbox, the archive and jobs"). */
export function listOccurrences(db: Db, jobId: Uuid): JobOccurrence[] {
  return db
    .select()
    .from(jobOccurrences)
    .where(eq(jobOccurrences.jobId, jobId))
    .orderBy(desc(jobOccurrences.dueAt), desc(jobOccurrences.id))
    .all()
    .map(toOccurrence);
}

/**
 * The newest occurrence of any kind — where a catch-up starts from
 * (EO-306, `ARCHITECTURE.md`, "Schedules, and a machine that was off").
 *
 * `pullSchedule.ts` kept its last-run time in memory, which is why a
 * desktop that closed forgot what it had done. This is that fact made
 * durable, and it is deliberately the newest *row* rather than the
 * newest firing: a skipped occurrence is still an occurrence EO has
 * decided about, and starting the next sweep before it would offer the
 * same skip again every minute.
 */
export function latestOccurrence(db: Db, jobId: Uuid): JobOccurrence | undefined {
  const row = db
    .select()
    .from(jobOccurrences)
    .where(eq(jobOccurrences.jobId, jobId))
    .orderBy(desc(jobOccurrences.dueAt), desc(jobOccurrences.id))
    .get();
  return row ? toOccurrence(row) : undefined;
}

/**
 * The newest occurrence with a given status — the previous *firing*, or
 * the skip a person is being offered.
 *
 * Both callers want "the last time this happened", and neither wants to
 * read a year of history to find it.
 */
export function latestOccurrenceWithStatus(db: Db, jobId: Uuid, status: JobOccurrenceStatus): JobOccurrence | undefined {
  const row = db
    .select()
    .from(jobOccurrences)
    .where(and(eq(jobOccurrences.jobId, jobId), eq(jobOccurrences.status, status)))
    .orderBy(desc(jobOccurrences.dueAt), desc(jobOccurrences.id))
    .get();
  return row ? toOccurrence(row) : undefined;
}

/**
 * How many items this job has filed since a moment (EO-332, ARCHITECTURE.md, "Jobs",
 * "Controls").
 *
 * What `jobs.max_items_per_hour` is counted against, and it is counted
 * off the *occurrences* rather than off `job_events` for two reasons.
 * The cap is stated in items per hour and an occurrence is what one
 * item is; and a released webhook event's own row keeps the moment it
 * arrived, not the moment it was let through, so counting those would
 * let a burst held for an hour all through at once.
 *
 * It therefore counts every firing, not only the webhook's. A person
 * who presses Run now five times on a job capped at ten an hour has
 * used five of them, which is what a cap on how much work a job may
 * file in an hour has to mean if it means anything.
 */
export function firedSince(db: Db, jobId: Uuid, since: number): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(jobOccurrences)
    .where(and(eq(jobOccurrences.jobId, jobId), eq(jobOccurrences.status, "fired"), gte(jobOccurrences.firedAt, since)))
    .get();
  return row?.n ?? 0;
}

/**
 * Whether this job has already fired the occurrence that was due at this
 * moment.
 *
 * What stops "Run it now" being pressed twice, on two screens or on a
 * comment somebody scrolled back to: the offer is answered by firing the
 * occurrence, and an occurrence that has fired is not on offer any more.
 */
export function hasFiredAt(db: Db, jobId: Uuid, dueAt: number): boolean {
  return (
    db
      .select()
      .from(jobOccurrences)
      .where(and(eq(jobOccurrences.jobId, jobId), eq(jobOccurrences.dueAt, dueAt), eq(jobOccurrences.status, "fired")))
      .get() !== undefined
  );
}

/**
 * The occurrence this message offered to run, if it offered one
 * (EO-306, `ARCHITECTURE.md`, "Schedules, and a machine that was off").
 *
 * The whole of how "Run it now" knows *which* occurrence: the offer
 * names its occurrence, so answering an offer from three weeks ago runs
 * the occurrence from three weeks ago.
 */
export function occurrenceForOffer(db: Db, offerCommentId: Uuid): JobOccurrence | undefined {
  const row = db.select().from(jobOccurrences).where(eq(jobOccurrences.offerCommentId, offerCommentId)).get();
  return row ? toOccurrence(row) : undefined;
}

/**
 * The firing behind each of these items, for the board (EO-308).
 *
 * One query rather than an `occurrenceForItem` per card: a board of
 * fifty cards would otherwise be fifty indexed lookups to answer a
 * question that is null for most of them. Oldest first, so a caller
 * building a map keeps the first firing for an item named by more than
 * one — which is `occurrenceForItem`'s own rule, and the two have to
 * agree or the rail and the card would name different occurrences of
 * the same item.
 */
export function firedOccurrencesForItems(db: Db, itemIds: Uuid[]): JobOccurrence[] {
  if (itemIds.length === 0) return [];
  return db
    .select()
    .from(jobOccurrences)
    .where(and(inArray(jobOccurrences.itemId, itemIds), eq(jobOccurrences.status, "fired")))
    .orderBy(jobOccurrences.dueAt, jobOccurrences.id)
    .all()
    .map(toOccurrence);
}

/**
 * Every item this job has ever filed, oldest first (EO-308).
 *
 * What "archive its items" archives, and deduplicated by the caller for
 * `jobCostCents`' reason: one item can be named by more than one
 * occurrence.
 */
export function itemIdsFiredBy(db: Db, jobId: Uuid): string[] {
  return db
    .select({ itemId: jobOccurrences.itemId })
    .from(jobOccurrences)
    .where(and(eq(jobOccurrences.jobId, jobId), eq(jobOccurrences.status, "fired")))
    .orderBy(jobOccurrences.dueAt, jobOccurrences.id)
    .all()
    .flatMap((row) => (row.itemId === null ? [] : [row.itemId]));
}

/**
 * The occurrence that created this item, if a job did.
 *
 * The item's provenance is read back through here rather than from a
 * column on `items`: the occurrence already records the firing, and a
 * second copy on the item would be the same fact written twice with
 * nothing keeping the two honest.
 */
/**
 * Whose item this is, where a job filed it (EO-330, ARCHITECTURE.md, "Where a job runs").
 *
 * The same join `jobRunsOnForItem` makes, answering the other column,
 * and it exists for the sentence in the story: "a server job's items
 * are created by the server with the job's owner as `createdBy`; its
 * mentions reach that person."
 *
 * `createdBy` is already the job's owner (`jobs/fire.ts`), so this is
 * not a second source for that fact — it is how a process with no
 * signed-in person of its own finds it. An organisation server's "you"
 * is nobody in particular, and an escalation it raises has to reach
 * somebody rather than everybody.
 */
export function jobOwnerForItem(db: Db, itemId: Uuid): Uuid | undefined {
  const row = db
    .select({ ownerId: jobs.ownerId })
    .from(jobOccurrences)
    .innerJoin(jobs, eq(jobs.id, jobOccurrences.jobId))
    .where(and(eq(jobOccurrences.itemId, itemId), eq(jobOccurrences.status, "fired")))
    .get();
  return row === undefined ? undefined : (row.ownerId as Uuid);
}

/**
 * Every item a job put on the organisation server (EO-330, ARCHITECTURE.md, "Where a job runs").
 *
 * The whole board's placement in one query, rather than a question
 * asked per item: the record asks this on every tick, and a join
 * repeated once per candidate would be the shape of "the same row read
 * for every item on the board" that `readPolicy` is hoisted out of the
 * same loop to avoid. The set is the small half by construction — a
 * job on the server is the deliberate case and most installations have
 * none — so the answer is usually empty and always short.
 *
 * **Defined by what is in it, and `device` is everything else.** An
 * item no job filed, and an item filed by a job that stayed on
 * somebody's machine, are both a desktop's — which is what keeps every
 * board EO has ever had behaving exactly as it did: work a person filed
 * themselves runs on a person's machine, because that is where it has
 * always run. A row holding a word this version does not know is
 * therefore not on the server either, which is the direction that never
 * moves somebody's work somewhere they did not put it.
 *
 * Placement is a property of the *job*, so an item inherits it through
 * the occurrence that created it rather than carrying a copy of it
 * (invariant #6) — a job moved to the server moves the work it has
 * already filed with it.
 */
export function serverPlacedItemIds(db: Db): Set<string> {
  const rows = db
    .select({ itemId: jobOccurrences.itemId, runsOn: jobs.runsOn })
    .from(jobOccurrences)
    .innerJoin(jobs, eq(jobs.id, jobOccurrences.jobId))
    .where(eq(jobOccurrences.status, "fired"))
    .all();
  const placed = new Set<string>();
  for (const row of rows) {
    if (row.itemId === null) continue;
    if ((JobRunsOnSchema.safeParse(row.runsOn).data ?? DEFAULT_JOB_RUNS_ON) === "server") placed.add(row.itemId);
  }
  return placed;
}

export function occurrenceForItem(db: Db, itemId: Uuid): JobOccurrence | undefined {
  const row = db
    .select()
    .from(jobOccurrences)
    .where(and(eq(jobOccurrences.itemId, itemId), eq(jobOccurrences.status, "fired")))
    .orderBy(jobOccurrences.dueAt, jobOccurrences.id)
    .get();
  return row ? toOccurrence(row) : undefined;
}
