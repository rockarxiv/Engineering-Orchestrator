import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { onProject } from "./projectScope.js";
import {
  DEBUG_SENT_EVENT,
  INTERPRET_ACTION,
  uuidv7,
  type RecordCursor,
  type Run,
  type RunCheck,
  type RunRuntimeSource,
  type RunStatus,
  type Uuid,
} from "@eo/core";
import type { Db } from "../client.js";
import { runs, runEvents, items, projects } from "../schema.js";
import {
  personSideCallCentsSince,
  sideCallCentsBetween,
  sideCallCentsByOwnerSince,
  sideCallCentsByProject,
  sideCallCentsForItem,
  sideCallCentsForItems,
  sideCallCentsSince,
} from "./sideCallsRepo.js";

function toDomain(row: typeof runs.$inferSelect): Run {
  return {
    id: row.id as Uuid,
    itemId: row.itemId as Uuid,
    agentId: row.agentId as Uuid | null,
    action: row.action,
    stepId: row.stepId,
    status: row.status as RunStatus,
    threadId: row.threadId,
    provider: row.provider,
    runtimeSource: row.runtimeSource as RunRuntimeSource | null,
    instructionsHash: row.instructionsHash,
    agentAttachmentsHash: row.agentAttachmentsHash,
    threadLost: row.threadLost,
    interruption: row.interruption as Run["interruption"],
    cwd: row.cwd,
    pid: row.pid,
    initiationId: row.initiationId,
    attempt: row.attempt,
    result: row.result as Record<string, unknown> | null,
    verification: row.verification as Record<string, unknown> | null,
    checks: row.checks as RunCheck[] | null,
    error: row.error,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    turns: row.turns,
    turnsScope: row.turnsScope as Run["turnsScope"],
    costCents: row.costCents,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    dryRun: row.dryRun,
    updatedAt: row.updatedAt,
  };
}

export interface CreateRunInput {
  /**
   * The id this run already has, where it has one (EO-324).
   *
   * A record taking a run that happened on a device writes the
   * device's id, because `run_events` are keyed on `(run_id, seq)` and
   * a record that renumbered the run would have a transcript belonging
   * to nothing. Absent everywhere else, which is every run that starts
   * here.
   */
  id?: Uuid;
  itemId: Uuid;
  /** Null on a `builtin` step: EO is the one acting, so there is no agent. */
  agentId: Uuid | null;
  action: string;
  /**
   * The step this run was dispatched from.
   *
   * Optional only for the callers that genuinely have no step — a dry
   * run of a module, borrowing somebody's worktree to watch it work
   * (KAN-106) — and for tests. Everything the scheduler dispatches has
   * one, and a run without it cannot place the comments written during
   * it.
   */
  stepId?: string | null;
  status?: RunStatus;
  threadId?: string | null;
  /** The backend that will own this run's session (A-07). */
  provider?: string | null;
  /** The executable selection captured at the provider boundary (EO-41). */
  runtimeSource?: RunRuntimeSource | null;
  /**
   * Hash of the instructions handed to this run (EO-87).
   *
   * Omitted where there are none to hash — a builtin or module run has no
   * agent — and stored as null rather than the hash of an empty string,
   * which would be a real-looking value standing for nothing.
   */
  instructionsHash?: string | null;
  /**
   * Hash of the servers and skills the agent had attached at dispatch
   * (EO-106) — the tool surface this run's thread was born with.
   *
   * Omitted where there is no agent to have any, and carried over rather
   * than recomputed on the resume path, exactly like `instructionsHash`
   * above: a resume sends no configuration, so hashing what the agent
   * has *now* would record something this conversation was never given.
   *
   * Null is read as the empty surface and not as an unknown one — see
   * the column's own note, and `findReusableThread`, which is the reader
   * the distinction is for.
   */
  agentAttachmentsHash?: string | null;
  cwd?: string | null;
  pid?: number | null;
  initiationId?: string | null;
  attempt?: number;
  /** Somebody ran this to watch it work, rather than because an item reached a step (KAN-106). */
  dryRun?: boolean;
  /**
   * When this row changed, where that is not now (EO-324).
   *
   * A replica mirroring the record's run keeps the record's stamp, or
   * every machine that pulled it would re-send it to every other as
   * though it had just happened.
   */
  updatedAt?: number;
}

export function createRun(db: Db, input: CreateRunInput): Run {
  // Resolved here rather than at each call site, and defaulted from the
  // item rather than required. There are six places that create a run
  // and only the scheduler's knows the step as an object; the other five
  // would each need their own source, and one of them forgetting is a
  // null nobody notices until a seed is quietly missing a step. The
  // item's own step is the same value the scheduler resolved the step
  // *from*, so the default is not an approximation.
  // `in` rather than `??`, so an explicit null means "this run belongs to
  // no step" and not "work it out for me". A module dry run borrows some
  // item's worktree to be watched (KAN-106); reading that item's step
  // would file the dry run's comments as something that step said.
  const stepId = "stepId" in input ? (input.stepId ?? null) : (db.select({ stepId: items.stepId }).from(items).where(eq(items.id, input.itemId)).get()?.stepId ?? null);

  const row = db
    .insert(runs)
    .values({
      id: input.id ?? uuidv7(),
      itemId: input.itemId,
      agentId: input.agentId,
      action: input.action,
      stepId,
      status: input.status ?? "queued",
      threadId: input.threadId ?? null,
      provider: input.provider ?? null,
      runtimeSource: input.runtimeSource ?? null,
      instructionsHash: input.instructionsHash ?? null,
      agentAttachmentsHash: input.agentAttachmentsHash ?? null,
      cwd: input.cwd ?? null,
      pid: input.pid ?? null,
      initiationId: input.initiationId ?? null,
      attempt: input.attempt ?? 1,
      dryRun: input.dryRun ?? false,
      // What a replica pages on — see the column. Stamped by the two
      // functions that write this table, which is all of them.
      updatedAt: input.updatedAt ?? Date.now(),
    })
    .returning()
    .get();
  return toDomain(row);
}

export function getRun(db: Db, id: Uuid): Run | undefined {
  const row = db.select().from(runs).where(eq(runs.id, id)).get();
  return row ? toDomain(row) : undefined;
}

/**
 * Every run on an item, oldest first.
 *
 * Ordered, because several callers sort this and take the first or last
 * of the result. `Array.prototype.sort` is stable, so a tie in whatever
 * they sort by falls through to the order they were handed — and with no
 * ORDER BY that is whatever SQLite happened to return. Ids are UUIDv7 and
 * minted monotonically, so they are creation order and never null, which
 * `started_at` is on a run that has not been dispatched yet.
 */
export function listRunsForItem(db: Db, itemId: Uuid, newest?: number): Run[] {
  if (newest === undefined) return db.select().from(runs).where(eq(runs.itemId, itemId)).orderBy(asc(runs.id)).all().map(toDomain);
  // Only the newest few, in the statement itself (EO-540): newest first
  // so the LIMIT keeps the right end, then back to oldest first.
  return db.select().from(runs).where(eq(runs.itemId, itemId)).orderBy(desc(runs.id)).limit(newest).all().reverse().map(toDomain);
}

/**
 * The run an item's card names its status and assignee by: the latest to
 * start, a run not started yet counting as the oldest, ties broken by the
 * larger id (EO-540).
 *
 * The same order the board sorts `listRunsForItem` into before taking the
 * first, asked of the database as one row — so reading one item's summary
 * does not hydrate its whole run history to keep the head of it.
 */
export function latestRunForItem(db: Db, itemId: Uuid): Run | undefined {
  const row = db
    .select()
    .from(runs)
    .where(eq(runs.itemId, itemId))
    .orderBy(desc(sql`coalesce(${runs.startedAt}, 0)`), desc(runs.id))
    .limit(1)
    .get();
  return row === undefined ? undefined : toDomain(row);
}

/** A project's runs, as a WHERE clause over `runs` joined to `items`. */
function onItemsOfProject(projectId: Uuid | null) {
  return projectId === null ? isNull(items.projectId) : eq(items.projectId, projectId);
}

/**
 * "This run has a recorded send": a `debug_sent` row in its log (EO-394).
 *
 * The type is written into the SQL as a literal rather than bound as a
 * parameter, and that is the point of it: `idx_run_events_debug_sent` is
 * a partial index over exactly these rows (`0110`), and SQLite will only
 * use a partial index when it can see, in the statement itself, that the
 * query's condition implies the index's. Bound, this is a scan of every
 * unrecorded run's whole transcript — on each `runs:progress` push. The
 * literal is a constant of `@eo/core`, never anything a caller supplied.
 *
 * Exported for the test that holds it to the index, and for nothing else.
 */
export const hasRecordedSend = sql`exists (select 1 from ${runEvents} where ${runEvents.runId} = ${runs.id} and ${runEvents.type} = ${sql.raw(`'${DEBUG_SENT_EVENT}'`)})`;

/**
 * Every agent with a *recorded* run on one project: how many such runs
 * it has there, the newest of them, and whether one is in flight
 * (EO-392, narrowed to recorded runs by EO-394).
 *
 * For the debug window's tabs, and the reason it is a question of its
 * own rather than something read off a list of recent runs: a tab is
 * owed to *every* agent with a recorded run on the project, and a list
 * bounded across agents drops the one whose last run was three hundred
 * runs ago. So the agents are counted here, unbounded — there are a
 * handful — and the runs are bounded per agent, by
 * `listRecentRecordedRunsOfAgentOnProject`.
 *
 * A run dispatched while debug mode was off has nothing the window could
 * show under "what was sent", so it is not counted, is not the newest,
 * and does not make its agent live: an agent with no recorded run has no
 * row here at all. Such a run is still on its item's own runs screen.
 *
 * Archived items are included: the question is what an agent was sent,
 * and an item being put away afterwards does not make that any less
 * worth reading. Builtin runs are not — EO acted, and no provider was
 * handed anything.
 */
export function listAgentsWithRecordedRunsOnProject(db: Db, projectId: Uuid | null): { agentId: Uuid; runs: number; newestRunId: string; live: boolean }[] {
  return db
    .select({
      agentId: runs.agentId,
      runs: sql<number>`count(*)`,
      // Ids are UUIDv7, so the greatest is the newest.
      newestRunId: sql<string>`max(${runs.id})`,
      live: sql<number>`max(case when ${runs.status} in ('queued', 'running') then 1 else 0 end)`,
    })
    .from(runs)
    .innerJoin(items, eq(items.id, runs.itemId))
    .where(and(onItemsOfProject(projectId), isNotNull(runs.agentId), hasRecordedSend))
    .groupBy(runs.agentId)
    .all()
    .map((row) => ({ agentId: row.agentId as Uuid, runs: Number(row.runs), newestRunId: row.newestRunId, live: Number(row.live) === 1 }));
}

/**
 * One agent's newest *recorded* runs on one project, with the item each
 * worked on (EO-392, EO-394).
 *
 * Newest first by id, which is creation order (UUIDv7), and bounded: an
 * agent that has worked a project for a year has more runs than a window
 * should be handed. The bound is per agent, so it can shorten a tab and
 * never remove one — and it is applied *after* the filter, in the one
 * statement, so fifty unrecorded runs on top of an older recorded one
 * cannot empty a tab.
 */
export function listRecentRecordedRunsOfAgentOnProject(
  db: Db,
  projectId: Uuid | null,
  agentId: Uuid,
  limit: number,
): { run: Run; itemKey: string; itemTitle: string }[] {
  return db
    .select({ run: runs, itemKey: items.key, itemTitle: items.title })
    .from(runs)
    .innerJoin(items, eq(items.id, runs.itemId))
    .where(and(onItemsOfProject(projectId), eq(runs.agentId, agentId), hasRecordedSend))
    .orderBy(desc(runs.id))
    .limit(limit)
    .all()
    .map((row) => ({ run: toDomain(row.run), itemKey: row.itemKey, itemTitle: row.itemTitle }));
}

/** Runs that ended `failed` at or after `since` (epoch ms), newest first — what a retry may still be waiting out. */
export function listRunsFailedSince(db: Db, since: number): Run[] {
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.status, "failed"), sql`${runs.endedAt} >= ${since}`))
    .orderBy(desc(runs.endedAt))
    .all()
    .map(toDomain);
}

export interface UpdateRunInput {
  /** See `CreateRunInput.updatedAt`. Left alone outside the replica, which keeps the record's stamp. */
  updatedAt?: number;
  status?: RunStatus;
  threadId?: string | null;
  /**
   * The backend had no such session when this run tried to resume
   * (EO-93). Only ever set to true, and never alongside a `threadId` of
   * null: the marker exists precisely so that the dead id can be kept.
   */
  threadLost?: boolean;
  /** What cut the run short without it failing (`RunInterruption`). Written with the status that ends it. */
  interruption?: Run["interruption"];
  cwd?: string | null;
  pid?: number | null;
  result?: Record<string, unknown> | null;
  verification?: Record<string, unknown> | null;
  /**
   * What the kind checked, written in the same update as the verdict
   * (EO-312) — never on its own, so a row can never say "checked" with
   * nothing to show or show checks for a run that has not ended.
   */
  checks?: RunCheck[] | null;
  error?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  turns?: number | null;
  turnsScope?: string | null;
  costCents?: number | null;
  /**
   * The session's running total as the run last read it (EO-504) — the
   * backend's figure for the whole conversation, not the run's share
   * above. Written beside the share, by the tally that read both.
   */
  sessionTokensIn?: number | null;
  sessionTokensOut?: number | null;
  sessionCacheReadTokens?: number | null;
  sessionCacheWriteTokens?: number | null;
  sessionCostCents?: number | null;
  startedAt?: number | null;
  endedAt?: number | null;
}

/**
 * Names the agent a mirrored run was dispatched to, once this replica
 * has that agent (EO-476).
 *
 * A run pulled before its agent is written as nobody's, because
 * `runs.agent_id` is a foreign key; the drain keeps the record's id and
 * calls this when the agent lands. Only over a null — a run that already
 * names somebody is not re-attributed by a late arrival. Answers whether
 * it wrote.
 */
export function attributeMirroredRun(db: Db, runId: Uuid, agentId: Uuid): boolean {
  return db.update(runs).set({ agentId }).where(and(eq(runs.id, runId), isNull(runs.agentId))).run().changes > 0;
}

export function updateRun(db: Db, id: Uuid, patch: UpdateRunInput): Run {
  // `updated_at` is stamped here rather than left to the caller for the
  // reason it exists at all: a replica pages on it, and a writer that
  // forgot would be a run that changed and never travelled.
  const row = db
    .update(runs)
    .set({ ...patch, updatedAt: patch.updatedAt ?? Date.now() })
    .where(eq(runs.id, id))
    .returning()
    .get();
  return toDomain(row);
}

/** Runs still in flight, across every item — what the scheduler (E-02) needs to respect concurrency caps. */
export function listActiveRuns(db: Db): Run[] {
  return db.select().from(runs).where(inArray(runs.status, ["queued", "running"])).all().map(toDomain);
}

/**
 * Every directory a run could still be resumed into (EO-299).
 *
 * `listActiveRuns` is queued and running, which is what the scheduler
 * means by "in flight" — and it is the wrong list for deciding whether
 * a directory may be deleted. A run parked on a question is not in
 * flight and is emphatically not finished: the person replies, the run
 * resumes into the cwd its row records, and a session resumed from a
 * directory that has been swept is not the same session. EO-177 is the
 * story about what treating "no active run" as "finished" cost.
 *
 * So `awaiting_input` is in this list and the terminal statuses are
 * not. The scratch kind's sweep is the caller: it removes the
 * directories it made once nothing can return to them.
 */
export function resumableRunCwds(db: Db): string[] {
  return db
    .select({ cwd: runs.cwd })
    .from(runs)
    .where(inArray(runs.status, ["queued", "running", "awaiting_input"]))
    .all()
    .flatMap((row) => (row.cwd ? [row.cwd] : []));
}

/** A run's spend, as one row of a thread's history holds it. */
interface ThreadUsageFigures {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costCents: number;
}

/**
 * What every run on a provider thread recorded, but one, oldest first
 * (EO-490, EO-504): what a resumed session's running total may already
 * contain when `exceptRunId` resumes it. Empty for a thread this run is
 * the first to use.
 *
 * Each row in two figures, because they are different facts. `recorded`
 * is the run's spend as its row holds it — its own share since EO-490,
 * the whole conversation's total before it — and null where the run
 * recorded nothing. `sessionEndedOn` is the session's running total as
 * the run last read it, and null for every run written before EO-504
 * and every run on a backend that reports turn by turn. Which one to
 * believe, and how to read a row that has only the first, is
 * `sessionTotalBefore`'s to decide; this only reads them.
 */
export function usageHistoryOnThread(
  db: Db,
  threadId: string,
  exceptRunId: Uuid,
): { recorded: ThreadUsageFigures | null; sessionEndedOn: ThreadUsageFigures | null }[] {
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.threadId, threadId), sql`${runs.id} <> ${exceptRunId}`))
    // UUIDv7, so the order the runs were made in.
    .orderBy(asc(runs.id))
    .all()
    .map((row) => ({
      recorded:
        row.tokensIn === null && row.tokensOut === null && row.costCents === null
          ? null
          : {
              tokensIn: row.tokensIn ?? 0,
              tokensOut: row.tokensOut ?? 0,
              cacheReadTokens: row.cacheReadTokens,
              cacheWriteTokens: row.cacheWriteTokens,
              costCents: row.costCents ?? 0,
            },
      sessionEndedOn:
        row.sessionTokensIn === null && row.sessionTokensOut === null && row.sessionCostCents === null
          ? null
          : {
              tokensIn: row.sessionTokensIn ?? 0,
              tokensOut: row.sessionTokensOut ?? 0,
              cacheReadTokens: row.sessionCacheReadTokens,
              cacheWriteTokens: row.sessionCacheWriteTokens,
              costCents: row.sessionCostCents ?? 0,
            },
    }));
}

/**
 * Sum of cost_cents across every run ever created for an item (ARCHITECTURE.md, "Guardrails":
 * per-item budget guard).
 *
 * **Nought for a preview** (EO-313, ARCHITECTURE.md, "Preview"), which is the same join the
 * three sums below carry and is load-bearing in two different ways.
 *
 * What a person *reads*: `costs:getForItem` answers from here, and so
 * does every place a job names what an occurrence cost — the Job page's
 * history table, the card hover, the rail. A preview showing a figure
 * on any of them contradicts the banner two inches away from it.
 *
 * What the engine *does*: this is also the per-item budget guard's
 * input, and a preview that could trip a money guard would park itself
 * mid-walk with "reply to authorize more" — asking somebody to
 * authorize spending on the one item they were promised costs nothing.
 * The same holds for the per-occurrence job guard, which reads this
 * too. Nought is not a convenient blank here; it is the correct
 * answer to both questions.
 */
export function sumCostCentsForItem(db: Db, itemId: Uuid): number {
  const row = db.get<{ total: number | null }>(
    sql`select sum(${runs.costCents}) as total from ${runs} join ${items} on ${items.id} = ${runs.itemId} where ${runs.itemId} = ${itemId} and ${items.previewAt} is null`,
  );
  // And the side calls made about it (EO-477): spend reading counts
  // them wherever it counts runs, so the per-item budget sees them.
  return (row?.total ?? 0) + sideCallCentsForItem(db, itemId);
}

/**
 * Sum of cost_cents across every run of every one of these items
 * (EO-307: what a job's occurrences have cost).
 *
 * One query rather than a `sumCostCentsForItem` per id: a job that has
 * fired hourly for a year has thousands of them, and the Job page asks
 * this every time it opens. An empty list is nought without asking —
 * `in ()` is not valid SQL, and a job that has fired nothing has spent
 * nothing.
 */
export function sumCostCentsForItems(db: Db, itemIds: Uuid[]): number {
  if (itemIds.length === 0) return 0;
  const row = db
    .select({ total: sql<number | null>`sum(${runs.costCents})` })
    .from(runs)
    // Previews left out, exactly as the per-item sum above leaves them
    // out (EO-313, ARCHITECTURE.md, "Preview"). This is the Job page's "Spent", and a job
    // whose occurrences include a preview must not report the preview's
    // runs as money it spent.
    .innerJoin(items, eq(items.id, runs.itemId))
    .where(and(inArray(runs.itemId, itemIds), isNull(items.previewAt)))
    .get();
  return (row?.total ?? 0) + sideCallCentsForItems(db, itemIds);
}

/**
 * What every project has cost, by project id (EO-326, ARCHITECTURE.md, "Policy").
 *
 * One query for the whole list rather than a sum per project, because
 * the one caller is `projects:list` — the switcher, which draws every
 * project at once and is opened often enough that a query per row would
 * be felt on an installation with a dozen of them.
 *
 * Previews excluded, on the same join and for the same reason as every
 * other sum in this file (EO-313, ARCHITECTURE.md, "Preview").
 *
 * Items on no project are summed under `null`, rather than dropped.
 * They are real spending — an installation before its first project has
 * nothing else — and a total that quietly omitted them would be the
 * kind of missing money nobody can account for later. No caller draws
 * that row today; the sum is honest anyway.
 */
export function costCentsByProject(db: Db): Map<string | null, number> {
  const rows = db
    .select({ projectId: items.projectId, total: sql<number | null>`sum(${runs.costCents})` })
    .from(runs)
    .innerJoin(items, eq(items.id, runs.itemId))
    .where(isNull(items.previewAt))
    .groupBy(items.projectId)
    .all();
  const byProject = new Map<string | null, number>();
  for (const row of rows) byProject.set(row.projectId, row.total ?? 0);
  // Side calls by the project they were made for (EO-477).
  for (const [projectId, cents] of sideCallCentsByProject(db)) byProject.set(projectId, (byProject.get(projectId) ?? 0) + cents);
  return byProject;
}

/**
 * What each person's work has cost since `sinceMs`, by person id
 * (EO-328, ARCHITECTURE.md, "Policy").
 *
 * **"A person's items" is read through the project**, which is the same
 * chain EO-326 reasons about for a project total: a run belongs to an
 * item, an item to a project, and a project to the person the record
 * assigned it to on the move. There is no owner column on `items` and
 * inventing one here would be a second answer to a question the record
 * has already answered — and one that would immediately disagree with
 * the project total the admin is shown, which the design defines as the sum of
 * its people.
 *
 * Items on a project nobody owns — every item on a solo desktop, and
 * every item on a project kept local — are summed under `null` rather
 * than dropped. No caller draws that row: a per-person budget is a
 * managed-mode ceiling and there is nobody for it to be about here. The
 * sum is honest anyway, for `costCentsByProject`'s reason.
 *
 * Previews excluded, on the same join and for the same reason as every
 * other sum in this file (EO-313, ARCHITECTURE.md, "Preview"). A rehearsal must never be the
 * thing that spends somebody's day.
 */
export function costCentsByOwnerSince(db: Db, sinceMs: number): Map<string | null, number> {
  const rows = db
    .select({ ownerId: projects.ownerId, total: sql<number | null>`sum(${runs.costCents})` })
    .from(runs)
    .innerJoin(items, eq(items.id, runs.itemId))
    .leftJoin(projects, eq(projects.id, items.projectId))
    .where(and(isNull(items.previewAt), sql`${runs.startedAt} >= ${sinceMs}`))
    .groupBy(projects.ownerId)
    .all();
  const byOwner = new Map<string | null, number>();
  for (const row of rows) byOwner.set(row.ownerId, row.total ?? 0);
  for (const [ownerId, cents] of sideCallCentsByOwnerSince(db, sinceMs)) byOwner.set(ownerId, (byOwner.get(ownerId) ?? 0) + cents);
  return byOwner;
}

/**
 * One person's share of the above.
 *
 * Its own function rather than `costCentsByOwnerSince(...).get(id) ?? 0`
 * written out at each call site, because one of those call sites is a
 * dispatch: the guard asks this of one person immediately before
 * starting a run, and summing every person on the record to answer about
 * one of them is work a dispatch should not be paying for.
 */
export function personCostCentsSince(db: Db, personId: Uuid, sinceMs: number): number {
  const row = db
    .select({ total: sql<number | null>`sum(${runs.costCents})` })
    .from(runs)
    .innerJoin(items, eq(items.id, runs.itemId))
    .innerJoin(projects, eq(projects.id, items.projectId))
    .where(and(isNull(items.previewAt), eq(projects.ownerId, personId), sql`${runs.startedAt} >= ${sinceMs}`))
    .get();
  return (row?.total ?? 0) + personSideCallCentsSince(db, personId, sinceMs);
}

/**
 * Sum of cost_cents across every run (any item) started at or after
 * `sinceMs` (ARCHITECTURE.md, "Guardrails": daily budget guard — cross-item by design).
 *
 * **A preview's runs are not in it** (EO-313, ARCHITECTURE.md, "Preview"). The banner on a
 * preview says nothing cost money, and the fake provider makes that
 * true — but "the number is nought so it cannot matter" is exactly the
 * reasoning that breaks the day a provider starts reporting a cost for
 * a rehearsal. The join is what makes the sentence on the banner and
 * the sentence in Settings the same claim, and it is what keeps a
 * preview from ever being the thing that trips the daily budget guard
 * and pauses somebody's real work.
 */
export function sumCostCentsSince(db: Db, sinceMs: number): number {
  const row = db.get<{ total: number | null }>(
    sql`select sum(${runs.costCents}) as total from ${runs} join ${items} on ${items.id} = ${runs.itemId} where ${items.previewAt} is null and ${runs.startedAt} >= ${sinceMs}`,
  );
  // And every side call since (EO-477), on an item or on none: the
  // daily budget is everything EO spent today.
  return (row?.total ?? 0) + sideCallCentsSince(db, sinceMs);
}

/**
 * Sum of cost_cents across every run (any item) started in
 * [startMs, endMs) — a bounded day, for querying a specific past date.
 *
 * Previews excluded, for the reason above: this is the number the
 * dashboard prints as today's spend, and a preview is the one item on
 * the board a person has been promised did not spend anything.
 */
export function sumCostCentsBetween(db: Db, startMs: number, endMs: number): number {
  const row = db.get<{ total: number | null }>(
    sql`select sum(${runs.costCents}) as total from ${runs} join ${items} on ${items.id} = ${runs.itemId} where ${items.previewAt} is null and ${runs.startedAt} >= ${startMs} and ${runs.startedAt} < ${endMs}`,
  );
  return (row?.total ?? 0) + sideCallCentsBetween(db, startMs, endMs);
}

/**
 * itemIds whose most recent run ended awaiting a reply (ARCHITECTURE.md, "Escalation ends the run")
 * — the
 * scheduler's third skip condition.
 *
 * "Most recent" excludes an interpretation (EO-184), and it has to.
 * That run is dispatched *because* the item is parked and it leaves it
 * parked: it moves nothing, declares no result, and is over before
 * anything acts on what it said. Counted as the newest run it would
 * report a parked item as free the moment it succeeded — so the
 * scheduler would dispatch the very step the interpretation was sent to
 * answer for, and a reading that said "do not run this again" would be
 * followed by exactly that.
 *
 * Every caller asks the same question — is this item parked? — so the
 * exclusion belongs here rather than in each of them.
 */
export function listAwaitingInputItemIds(db: Db): Set<Uuid> {
  const rows = db.all<{ itemId: string }>(sql`
    select r1.item_id as "itemId"
    from ${runs} r1
    where r1.status = 'awaiting_input'
      and not exists (
        select 1 from ${runs} r2
        where r2.item_id = r1.item_id
          and r2.action <> ${INTERPRET_ACTION}
          and (r2.started_at > r1.started_at or (r2.started_at = r1.started_at and r2.id > r1.id))
      )
  `);
  return new Set(rows.map((row) => row.itemId as Uuid));
}

/**
 * Runs the record has touched after a point, oldest first (EO-324,
 * ARCHITECTURE.md, "Identity").
 *
 * The runs half of `record:changes`, so that a second desktop can show
 * that somebody's agent is working: the board reads the latest run's
 * status out of the local `runs` table, and a machine that never
 * received another device's runs draws an idle board while an agent is
 * going elsewhere.
 *
 * Paged on `(updated_at, id)` for `RecordCursor`'s reason — several
 * runs change in one millisecond whenever a tick settles more than one.
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
export function listRunsUpdatedSince(db: Db, cursor: RecordCursor, limit: number, within?: string): Run[] {
  return db
    .select()
    .from(runs)
    .where(
      and(
        sql`(${runs.updatedAt} > ${cursor.ts} or (${runs.updatedAt} = ${cursor.ts} and ${runs.id} > ${cursor.id}))`,
        within === undefined ? undefined : onProject(runs.itemId, within),
      ),
    )
    .orderBy(asc(runs.updatedAt), asc(runs.id))
    .limit(limit)
    .all()
    .map(toDomain);
}

/**
 * A run this device has not finished handing to the record (EO-324,
 * `ARCHITECTURE.md`, "The record").
 *
 * Two facts make one question, which is why it is one query. The run
 * *row* is behind when the record was last told a status this run no
 * longer has — including never, which is `synced_status IS NULL`. The
 * run's *log* is behind when `synced_seq` is short of the highest
 * sequence in `run_events`. A desktop that went offline mid-run comes
 * back with both true, and what the design promises is that both are
 * delivered: the transcript in order, and the outcome that says how it
 * ended.
 *
 * Only runs with a status to report, which excludes nothing today and
 * is written as a join rather than a filter so a run whose item was
 * deleted (KAN-30) stops being asked about — there is nothing on the
 * record for it to belong to.
 *
 * Ordered oldest first: the record is being told a history, and a
 * history told backwards is a different one.
 */
export interface RunSyncBacklog {
  run: Run;
  /** How far the record has been told this run's log goes. `-1` when it has been told nothing. */
  syncedSeq: number;
  /** The status the record was last told, or null when it has never been told at all. */
  syncedStatus: string | null;
}

export function runsNeedingSync(db: Db, limit = 20): RunSyncBacklog[] {
  return db
    .select()
    .from(runs)
    .innerJoin(items, eq(items.id, runs.itemId))
    .where(
      sql`(${runs.syncedStatus} is null or ${runs.syncedStatus} <> ${runs.status}
           or ${runs.syncedSeq} < coalesce((select max(seq) from run_events where run_id = ${runs.id}), -1))
          -- …and only what the record actually owns (EO-325). A project
          -- the person kept at first sign-in is theirs: the record has
          -- never heard of its items, so its runs would be offered for
          -- ever and refused every time. An item on no project at all
          -- is the record's, which is what it has always been.
          and (${items.projectId} is null
               or exists (select 1 from projects p where p.id = ${items.projectId} and p.managed_at is not null))`,
    )
    .orderBy(asc(runs.id))
    .limit(limit)
    .all()
    .map((row) => ({ run: toDomain(row.runs), syncedSeq: row.runs.syncedSeq, syncedStatus: row.runs.syncedStatus }));
}

/**
 * Moves this device's bookmark into a run, after the record has taken it.
 *
 * Written only once the record has acknowledged, never before: a
 * bookmark moved optimistically is a transcript with a hole in it that
 * nothing will ever go back for.
 */
export function markRunSynced(db: Db, runId: Uuid, syncedSeq: number, syncedStatus: string): void {
  db.update(runs).set({ syncedSeq, syncedStatus }).where(eq(runs.id, runId)).run();
}

/**
 * Where this device's bookmark into one run stands (EO-482): the highest
 * transcript line and the status the record has acknowledged. Undefined
 * for a run this database does not hold.
 */
export function runSyncBookmark(db: Db, runId: Uuid): { syncedSeq: number; syncedStatus: string | null } | undefined {
  const row = db.select({ syncedSeq: runs.syncedSeq, syncedStatus: runs.syncedStatus }).from(runs).where(eq(runs.id, runId)).get();
  return row === undefined ? undefined : { syncedSeq: row.syncedSeq, syncedStatus: row.syncedStatus };
}
