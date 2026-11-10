import {
  EMPTY_CURSOR,
  EMPTY_EVENT_CURSOR,
  RecordCursorsSchema,
  SOMEONE_ELSE,
  claimDroppedLine,
  stepRefusalLine,
  supersededLine,
  type Comment,
  type RecordChanges,
  type RecordCommand,
  type RecordCommandResult,
  type RecordCommentCommand,
  type RecordCursors,
  type RecordAgent,
  type RecordItem,
  type RecordMemory,
  type RecordTransitionView,
  type RecordRunCommand,
  type RecordWatch,
  type StepAct,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { signedInPersonId } from "../identity/viewer.js";
import { getComment, setCommentPinned, settleMention } from "../db/repos/commentsRepo.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { getSetting, setSetting } from "../db/repos/settingsRepo.js";
import { hasTransition } from "../db/repos/transitionsRepo.js";
import { setReplicaAssignee, upsertReplicaItem } from "../db/repos/replicaRepo.js";
import { getProject, upsertReplicaProject } from "../db/repos/projectsRepo.js";
import { getItemType, upsertReplicaItemType } from "../db/repos/itemTypesRepo.js";
import { upsertReplicaPipeline, upsertReplicaProjectAgent } from "../db/repos/projectMoveRepo.js";
import { heldByTheRecord, retireObsoleteHold } from "../gallery/templateUpdates.js";
import { listPipelines } from "../db/repos/pipelineStepsRepo.js";
import { publishSection } from "../db/repos/publishedSectionsRepo.js";
import { applySectionDocument } from "../managed/configuration.js";
import { appendSyncedRunEvents, hasOwnRunEventsAfter, listRunEventsFrom, highestRunEventSeq } from "../db/repos/runEventsRepo.js";
import { attributeMirroredRun, createRun, getRun, markRunSynced, runsNeedingSync, runSyncBookmark, updateRun } from "../db/repos/runsRepo.js";
import {
  attachmentWasRemoved,
  forgetAttachmentRemoval,
  getAttachment,
  insertAttachments,
  noteAttachmentRemoved,
  removeItemAttachment,
} from "../db/repos/attachmentsRepo.js";
import { pending, pendingWithKeyPrefix, remember, rememberLatest, settled, triedAgain, type PendingKind } from "../db/repos/recordPendingRepo.js";
import { backfillDone, backfillsOutstanding, rememberBackfill, wantBackfill } from "../db/repos/recordBackfillsRepo.js";
import { getAgent, recordStampOf } from "../db/repos/agentsRepo.js";
import { attachArrivedTools, getAgentAttachments, type UnarrivedTools } from "../db/repos/agentAttachmentsRepo.js";
import { mirrorItemWatch } from "../db/repos/itemWatchesRepo.js";
import {
  forgetCommands,
  hasQueuedWatch,
  itemOfCommand,
  pendingCommands,
  recordSendFailure,
  unreadableCommandIds,
  type QueuedCommand,
} from "../db/repos/recordCommandsRepo.js";
import type { LocalItemRecord } from "./localRecord.js";
import type { ItemRecord } from "./record.js";
import type { RemoteRecord } from "./remoteRecord.js";
import { asRunCommand, runCommandId, runPatchFrom } from "./runCommand.js";
import type { RecordAttachmentStore } from "./serveRecord.js";
import { answerCopiedSkillProposal } from "../memory/skillProposals.js";
import { writeArrivedMemory } from "../db/repos/memoriesRepo.js";
import { getSkill, upsertReplicaSkill } from "../db/repos/skillsRepo.js";
import { memoryWaitingFor } from "./memoryReplica.js";
import { isDecision } from "./stepAuthority.js";

/**
 * Handing this device's work to the record, and taking the record's
 * back (EO-324, `ARCHITECTURE.md`, "The record").
 *
 * Everything the design promises happens here, in one pass, in this order:
 *
 *  1. **Replay the queue, oldest first.** What this device did while it
 *     could not be heard. In order, because the order is the history.
 *  2. **Answer each result.** Applied, and the row goes. Superseded,
 *     and the record's truth is mirrored over this device's guess *and*
 *     the person is told whose move won — never a silent revert, which
 *     is the design's own phrase for the thing not to do. Refused
 *     outright, and the reason is said on the item (invariant #8).
 *  3. **Ship the runs.** The row and then its events, by `(runId, seq)`,
 *     from wherever this device last got acknowledged to. This is what
 *     makes "a desktop that goes offline mid-run finishes the run and
 *     its result reaches the server on reconnect with every run event
 *     in order" true rather than aspirational.
 *  4. **Pull what the record has.** Items, the moves applied to them,
 *     and what was said — into the replica, so that the other desktop's
 *     board and this one are the same board.
 *
 * Push order before pull order, deliberately. A device that pulled
 * first would read the record's state, apply it over its own
 * provisional moves, and *then* send those moves — which is a board
 * that flickers backwards on every reconnect.
 *
 * The whole pass gives up quietly the moment the record stops
 * answering. Nothing is dropped for being undeliverable: an offline
 * desktop is the normal case this exists for, and a queue that expired
 * its own contents would lose exactly the work the design undertakes to keep.
 * The one queue in this app that *does* give up is `outbox/drain.ts`,
 * and it says why the trade is different there.
 */

/**
 * Where the replica has read up to, in each of the record's lists.
 *
 * A `RecordCursors` in `app_settings`: three pairs of a timestamp and
 * an id. Durable because it has to survive a restart — a desktop that
 * re-read the record from the beginning on every launch would be
 * correct and unusable.
 *
 * A value this process wrote and a *different version* of this process
 * may have written, so it is parsed rather than cast. An unreadable one
 * reads as the beginning, which costs a full re-read and loses nothing:
 * every apply is idempotent.
 */
const CURSOR_KEY = "record.changesCursors";

const START: RecordCursors = {
  items: EMPTY_CURSOR,
  transitions: EMPTY_CURSOR,
  comments: EMPTY_CURSOR,
  runs: EMPTY_CURSOR,
  runEvents: EMPTY_EVENT_CURSOR,
  attachments: EMPTY_CURSOR,
  attachmentRemovals: EMPTY_CURSOR,
  projects: EMPTY_CURSOR,
  itemTypes: EMPTY_CURSOR,
  pipelines: EMPTY_CURSOR,
  agents: EMPTY_CURSOR,
  publishedSections: EMPTY_CURSOR,
  pins: EMPTY_CURSOR,
  mentions: EMPTY_CURSOR,
  watches: EMPTY_CURSOR,
  memories: EMPTY_CURSOR,
  skills: EMPTY_CURSOR,
};

function readCursors(db: Db): RecordCursors {
  const parsed = RecordCursorsSchema.safeParse(getSetting<unknown>(db, CURSOR_KEY, START));
  return parsed.success ? parsed.data : START;
}

/**
 * How many pages one pass will read before leaving the rest to the next.
 *
 * Twenty pages of five hundred is ten thousand rows, which is a great
 * deal more than a week away costs and a great deal less than a tick
 * can afford to spend. Nothing is lost by stopping: the cursor moved,
 * so the next pass carries on from it.
 */
const MAX_PULL_PAGES = 20;

/**
 * How many newly-arrived projects one pass reads the history of.
 *
 * Signing a desktop in to an organisation that already has fifty
 * projects makes fifty debts at once, and reading all of them before
 * the first board is drawn would be a long stare at an empty window.
 * A few per tick fills the switcher in the order they arrived.
 */
const MAX_BACKFILL_PROJECTS = 3;

/**
 * How many files one pass fetches before leaving the rest to the next.
 *
 * One attachment can be twenty megabytes, so this is the difference
 * between a tick and a stall. Nothing is lost by stopping: what is
 * wanted is derived from the record's own metadata and is still wanted
 * on the next pass.
 */
const MAX_FILES_PER_PASS = 5;

/**
 * How many held rows one pass retries.
 *
 * A device joining an organisation with a long history can be holding a
 * great many at once, and a tick that tried every one would be a tick
 * that never ended. What it does not finish, the next pass continues —
 * which costs nothing, because the rows are durable.
 */
const MAX_RETRIES_PER_PASS = 200;

export interface DrainOptions {
  db: Db;
  /** The record, over the wire. Its `ask` is what marks the link online or offline. */
  record: RemoteRecord;
  /**
   * The replica's writer.
   *
   * Deliberately the *local* record and never the remote one. Mirroring
   * what the record decided must not enqueue a command saying this
   * device decided it — that is a loop, and it is a loop that would
   * grow by one transition per reconnect.
   */
  local: LocalItemRecord;
  deviceId: string;
  /** This device's clock, so a test can stamp what it holds. */
  now?: () => number;
  /** How many commands to send in one request. The contract's own maximum is 200. */
  batchSize?: number;
  /**
   * How many rows a pull asks for at a time. The contract's own maximum
   * is 1000.
   *
   * Configurable for one reason and it is a test's: paging is only
   * exercised by a backlog, and a test that had to write five hundred
   * items to reach the second page would be a slow test of something
   * else.
   */
  pullPageSize?: number;
  /**
   * This machine's attachment store (EO-324, ARCHITECTURE.md, "The record").
   *
   * Read from when sending a file up, written to when fetching one
   * down. Absent — a test that is not about files — and an attachment
   * command is dropped rather than replayed against a store that does
   * not exist, and nothing is fetched.
   */
  attachments?: RecordAttachmentStore;
  /** Called when anything changed, so open screens are told to ask again. */
  onChange?: () => void;
  /** Called when a pull brought lines for a run, so a transcript open on it reads them. `onChange` says nothing a transcript hears. */
  onRunEvents?: (runId: Uuid) => void;
  /**
   * Replay the queue and stop there (EO-456): no runs, no pull, no files.
   * What `DeviceRecord.flush` asks for when a watch has just changed and
   * its lease is about to be given back.
   */
  queueOnly?: boolean;
}

export interface DrainResult {
  /** Commands the record applied. */
  sent: number;
  /** Moves the record refused because the item had already moved, and claims it dropped because somebody else held the item. */
  superseded: number;
  /** Commands the record could not carry out at all, each said on its item. */
  refused: number;
  /** Run events handed over. */
  runEvents: number;
  /** Items, moves and comments taken from the record into the replica. */
  pulled: number;
  /** Files fetched from the record into this machine's store. */
  files: number;
  /** True when the pass stopped because the record was not answering. */
  offline: boolean;
}

const NOTHING: DrainResult = { sent: 0, superseded: 0, refused: 0, runEvents: 0, pulled: 0, files: 0, offline: false };

export async function drainToRecord(options: DrainOptions): Promise<DrainResult> {
  const { db, record, local } = options;
  const batchSize = options.batchSize ?? 200;
  const pullPageSize = options.pullPageSize ?? 500;
  if (!record.linked()) return NOTHING;

  const result: DrainResult = { ...NOTHING };
  let changed = false;

  // A command written by a version of EO this one can no longer read.
  // A desktop that queued work offline and was then updated is the way
  // to meet it. It cannot be sent and it cannot be kept — a queue
  // stalled behind one unreadable row loses every later command too —
  // so it is dropped, and said (invariant #8).
  for (const id of unreadableCommandIds(db)) {
    const itemId = itemOfCommand(db, id);
    if (itemId !== null) {
      local.postComment({
        itemId,
        author: { type: "engine" },
        body:
          "EO had a change for this waiting to reach your organisation's record, and can no longer read it — " +
          "it was written by a different version of EO. It has been dropped rather than sent as something it might not be. " +
          "If this item is not where you expect it, move it again.",
        // About this machine's own queue, so it stays on it.
        staysHere: true,
      });
    }
    forgetCommands(db, [id]);
    result.refused += 1;
    changed = true;
  }

  // ── 1 & 2: the queue, and what the record said about it ───────────
  for (;;) {
    // One page of the queue, cut short at the first file.
    //
    // A file fills a request by itself — the contract's limit is a
    // little over an attachment's own maximum — so an attachment goes
    // alone, and everything queued before it goes first. Cutting rather
    // than reordering, because the queue's order *is* the history: a
    // file must not overtake the comment that announced it.
    const batch = nextBatch(db, batchSize);
    if (batch.length === 0) break;
    // The bytes are read here and not when the command was queued, so
    // that a desktop offline for a week holds one copy of each file
    // rather than two — see `RecordAttachmentCommandSchema`.
    const loaded = await withFileBytes(options, batch);
    if (loaded.dropped.length > 0) {
      forgetCommands(db, loaded.dropped);
      result.refused += loaded.dropped.length;
      changed = true;
    }
    if (loaded.commands.length === 0) continue;
    const answer = await record.ask("record:apply", {
      deviceId: options.deviceId,
      commands: loaded.commands,
    });
    if (!answer.ok) {
      recordSendFailure(db, batch.map((entry) => entry.id), answer.problem);
      result.offline = answer.unreachable;
      if (changed) options.onChange?.();
      return result;
    }
    const byId = new Map(answer.data.results.map((one) => [one.id, one]));
    const settled: string[] = [];
    for (const entry of loaded.sent) {
      const said = byId.get(entry.command.id);
      // A command the record did not mention is left where it is. It
      // was not answered, so it has not happened, and the next pass
      // sends it again — the record's side is idempotent by id.
      if (said === undefined) continue;
      await settle(options, entry, said, result);
      settled.push(entry.id);
      changed = true;
    }
    forgetCommands(db, settled);
    // A batch in which the record answered nothing at all would loop
    // forever on the same rows. It cannot happen against EO's own
    // record and is cheap to refuse anyway.
    //
    // Nothing else ends this loop: every settled command is deleted, so
    // the queue shrinks on each pass and the empty check at the top is
    // what stops it. The short-circuit that used to sit here — a page
    // shorter than the limit means the queue is empty — stopped being
    // true when a file began cutting a page short.
    if (settled.length === 0) break;
  }

  if (options.queueOnly === true) {
    if (changed) options.onChange?.();
    return result;
  }

  // ── 3: the runs, and their transcripts ────────────────────────────
  for (const backlog of runsNeedingSync(db)) {
    const { run } = backlog;
    const highest = highestRunEventSeq(db, run.id);
    const events = listRunEventsFrom(db, run.id, backlog.syncedSeq + 1, 500);
    const commands: RecordCommand[] = [asRunCommand(run, runCommandId(run.id, run.status), 0)];
    if (events.length > 0) {
      commands.push({
        kind: "runEvents",
        id: `${run.id}:events:${String(backlog.syncedSeq + 1)}`,
        runId: run.id,
        itemId: run.itemId,
        events: events.map((event) => ({ seq: event.seq, ts: event.ts, type: event.type, payload: event.payload })),
      });
    }
    const answer = await record.ask("record:apply", { deviceId: options.deviceId, commands });
    if (!answer.ok) {
      result.offline = answer.unreachable;
      if (changed) options.onChange?.();
      return result;
    }
    // Both halves, or neither. A run row the record took while its
    // events were refused would be a run that claims to have finished
    // with a transcript that stops early, and the bookmark would have
    // moved past the gap.
    if (answer.data.results.some((one) => !one.applied)) continue;
    const reached = events.length === 0 ? backlog.syncedSeq : (events[events.length - 1]?.seq ?? backlog.syncedSeq);
    markRunSynced(db, run.id, reached, run.status);
    result.runEvents += events.length;
    changed = true;
    // More than one page of transcript: the next pass carries on from
    // the bookmark this one just moved.
    if (reached < highest) break;
  }

  // ── 4: what the record has that this device has not ───────────────
  //
  // Paged, and the loop is for the desktop that has been shut for a
  // week: one page of five hundred would leave it a page closer per
  // tick, which is minutes of a board that is visibly wrong. Bounded
  // all the same, because a pass that could run forever is a tick that
  // never ends — what it does not finish, the next tick continues from,
  // because the cursor has already moved.
  for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
    const pull = await record.ask("record:changes", { cursors: readCursors(db), limit: pullPageSize, within: null });
    if (!pull.ok) {
      result.offline = pull.unreachable;
      if (changed) options.onChange?.();
      return result;
    }
    result.pulled += await applyChanges(options, pull.data);
    // And then what could not be placed before, because this page may
    // be exactly what it was waiting for: a run whose transcript came
    // down one page ahead of it, an item whose comments did. After the
    // page rather than before it, so a parent that has just arrived
    // settles its children in the same pass rather than the next one.
    result.pulled += retryPending(options);
    // Written after the page is applied and not before. Every apply is
    // idempotent, so a crash between the two costs one page read twice;
    // the other order would cost a page nobody ever reads.
    setSetting(db, CURSOR_KEY, pull.data.cursors);
    if (!pull.data.more) break;
  }

  // ── 4b: the history of a project this device has only just heard of ─
  //
  // The loop above pages strictly forwards on when each row was
  // written, which is right for a record that only grows forwards and
  // wrong for a project *moved* onto it: that arrives carrying the
  // dates its work actually happened on, and a desktop that has been
  // syncing this record for a month is already past them. It took the
  // project row and asked for nothing behind it.
  //
  // So each newly-arrived project is a debt (`record_backfills`), paid
  // off here with the same channel scoped to it, on cursors of its own
  // that start at the beginning. After the general pull rather than
  // before it, because the ordinary feed is what a person is watching
  // and a decade of somebody else's history should not hold it up.
  if (!(await payOffBackfills(options, result))) {
    if (changed) options.onChange?.();
    return result;
  }

  // ── 5: the files those comments said they had ─────────────────────
  //
  // After the pull rather than inside it, because a file is only worth
  // asking for once the thread that names it is here — and because the
  // pull is a few hundred small rows where this is a few very large
  // ones, and the two do not belong in one loop.
  if (!(await fetchFiles(options, result))) {
    if (changed) options.onChange?.();
    return result;
  }
  if (result.pulled > 0 || result.files > 0 || changed) options.onChange?.();
  return result;
}

/**
 * Reads the history of every project this device owes one (EO-325).
 *
 * The same channel, scoped — `record:changes`.`within` argues why that
 * is the shape rather than a second one. Bounded twice over: a handful
 * of projects per pass and a handful of pages per project, because a
 * pass that could run forever is a tick that never ends. What it does
 * not finish it leaves written down, and the next tick carries on from
 * the cursor this one stored.
 *
 * Answers false when the record went out of reach, which is the same
 * answer the pull above gives and means the same thing: stop here, keep
 * what landed, try again on the next tick.
 */
async function payOffBackfills(options: DrainOptions, result: DrainResult): Promise<boolean> {
  const { db, record } = options;
  const pullPageSize = options.pullPageSize ?? 500;
  for (const owed of backfillsOutstanding(db, MAX_BACKFILL_PROJECTS)) {
    let cursors = owed.cursors;
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const pull = await record.ask("record:changes", { cursors, limit: pullPageSize, within: owed.projectId });
      if (!pull.ok) {
        result.offline = pull.unreachable;
        return false;
      }
      result.pulled += await applyChanges(options, pull.data);
      result.pulled += retryPending(options);
      cursors = pull.data.cursors;
      rememberBackfill(db, owed.projectId, cursors);
      if (!pull.data.more) {
        // Read to the end of what the record has for this project,
        // which is the only thing that closes the debt. A pass that ran
        // out of pages leaves it open and resumes from here.
        backfillDone(db, owed.projectId, options.now?.() ?? Date.now());
        break;
      }
    }
  }
  return true;
}

/**
 * What a pulled comment says it has files, recorded as *wanted*.
 *
 * Metadata now, bytes later. A replica learns that "Anna attached
 * report.pdf" the moment the comment arrives — which is the right
 * order, because the thread should say so before the twenty megabytes
 * have crossed — and `fetchFiles` asks for the file afterwards.
 *
 * Nothing is written to the attachments table here. A row pointing at a
 * file this machine does not hold is a broken link on every screen that
 * draws the thread, so the row is written when the bytes land; until
 * then the want is derived by comparing what the record said the
 * comment has against what this database holds.
 */
function noteFiles(options: DrainOptions, comment: RecordCommentCommand, now: number): void {
  for (const file of comment.attachments) {
    wantFile(options, file.id, { itemId: comment.itemId, commentId: comment.commentId, name: file.name, mimeType: file.mimeType }, now);
  }
}

/**
 * Remembers that this device knows about a file and does not hold it.
 *
 * Durably, which is the whole change. It was a map in memory, and the
 * hole in that was quiet and permanent: the metadata arrives, its
 * cursor advances past it, the download fails or the app is closed —
 * and on restart nothing knows the file was ever mentioned. The record
 * will not mention it again, because a comment is immutable and an
 * attachment's own cursor has moved. One file, invisible on one
 * machine, for ever.
 *
 * Nothing is written to the attachments table here. A row pointing at a
 * file this machine does not hold is a broken link on every screen that
 * draws the thread, so the row is written when the bytes land.
 */
function wantFile(
  options: DrainOptions,
  attachmentId: string,
  about: { itemId: string; commentId: string | null; name: string; mimeType: string },
  now: number,
): void {
  if (getAttachment(options.db, attachmentId as Uuid) !== undefined) return;
  if (attachmentWasRemoved(options.db, attachmentId as Uuid)) return;
  remember(options.db, "attachment", attachmentId, { id: attachmentId, ...about }, `the bytes of ${about.name}`, now);
}

/**
 * The files this device knows about and does not hold, a few at a time.
 *
 * Bounded per pass, and that is the whole policy: one file can be
 * twenty megabytes, so a desktop catching up on a week of attachments
 * fetches a handful per tick rather than stalling one tick for minutes.
 * What it does not finish, the next pass continues — and now survives a
 * restart in between, which is what `record_pending` is for.
 *
 * A file the record says it does not have is forgotten rather than
 * asked for again: `found: false` means the bytes never reached the
 * record either, and asking a second time gets the same answer.
 */
async function fetchFiles(options: DrainOptions, result: DrainResult): Promise<boolean> {
  const store = options.attachments;
  if (store === undefined) return true;
  const { db } = options;
  let fetched = 0;

  for (const row of pending<WantedFile>(db, "attachment", MAX_FILES_PER_PASS)) {
    if (fetched >= MAX_FILES_PER_PASS) break;
    const want = row.payload;
    // Here already, or taken off its item since it was mentioned (EO-702).
    if (getAttachment(db, want.id as Uuid) !== undefined || attachmentWasRemoved(db, want.id as Uuid)) {
      settled(db, [row.id]);
      continue;
    }
    const answer = await options.record.ask("record:attachment", { attachmentId: want.id });
    if (!answer.ok) {
      result.offline = answer.unreachable;
      // Left where it is, deliberately. The want is durable now, so a
      // failed fetch — or an app closed a moment later — costs one pass
      // rather than the file.
      triedAgain(db, [row.id]);
      return false;
    }
    fetched += 1;
    if (!answer.data.found) {
      settled(db, [row.id]);
      continue;
    }
    // The comment has to be here before a row can point at it. It may
    // not be: the metadata stream is paged separately from the comments.
    // One of the item's own files (EO-702) needs its item instead.
    const owner = want.commentId === null ? getItem(db, want.itemId as Uuid) : getComment(db, want.commentId as Uuid);
    if (owner === undefined) {
      triedAgain(db, [row.id]);
      continue;
    }
    const stored = await store.storeImported({
      name: answer.data.name,
      mimeType: answer.data.mimeType,
      data: Buffer.from(answer.data.dataBase64, "base64"),
    });
    insertAttachments(db, [{ ...stored, id: want.id as Uuid, itemId: want.itemId as Uuid, commentId: want.commentId as Uuid | null }]);
    settled(db, [row.id]);
    result.files += 1;
  }

  return true;
}

/**
 * A run the record knows about, onto this replica.
 *
 * Inserted with the record's own id and stamp, so the two sides are
 * talking about one run and neither re-sends it to the other as though
 * it had just changed. A run this device already has is updated rather
 * than doubled, which is what a pull re-reading its own cursor boundary
 * produces on every pass.
 *
 * `settleMirroredRun` afterwards is the half that stops a loop:
 * `runsNeedingSync` looks for runs whose status the record has not been
 * told, and a mirrored run would match every one of those tests for
 * ever — this device would spend each tick offering the record a run it
 * had received *from* the record.
 */
function mirrorRun(options: DrainOptions, run: RecordRunCommand): boolean {
  const { db } = options;
  const existing = getRun(db, run.runId as Uuid);
  if (existing === undefined) {
    createRun(db, {
      id: run.runId as Uuid,
      itemId: run.itemId as Uuid,
      agentId: knownAgent(db, run.agentId),
      action: run.action,
      stepId: run.stepId,
      status: run.status as never,
      attempt: run.attempt,
      initiationId: run.initiationId,
      dryRun: run.dryRun,
      updatedAt: run.updatedAt,
    });
  } else if (existing.updatedAt >= run.updatedAt) {
    // Nothing newer than what is already here, which is most of what a
    // cursor boundary re-sends — and the comparison that keeps a pull
    // arriving out of order from writing an older copy over a newer one.
    return false;
  }
  updateRun(db, run.runId as Uuid, runPatchFrom(run));
  settleMirroredRun(options, run.runId as Uuid);
  return true;
}

/**
 * Says this device owes the record nothing for this run.
 *
 * True, and the reason it has to be said: the run came *from* the
 * record. Without it `runsNeedingSync` would offer it back — the row
 * first and then the whole transcript — once per tick, for ever.
 *
 * Unless this device wrote part of the run too, which a watch's quiet run
 * can have from two devices (EO-618). Its unsent lines keep the bookmark
 * where it is, or moving past them would lose them: sending from there
 * repeats what came from the record, and a repeat is ignored.
 */
function settleMirroredRun(options: DrainOptions, runId: Uuid): void {
  const { db } = options;
  const run = getRun(db, runId);
  const bookmark = runSyncBookmark(db, runId);
  if (run === undefined || bookmark === undefined) return;
  markRunSynced(db, runId, hasOwnRunEventsAfter(db, runId, bookmark.syncedSeq) ? bookmark.syncedSeq : highestRunEventSeq(db, runId), run.status);
}

/** What an agent's unarrived tools wait with — see `holdArrivingTools`. */
interface HeldTools {
  agentId: string;
  /** Only the ones that have not arrived. What did arrive is attached, and is the person's from then on. */
  mcpServerIds: string[];
  skillIds: string[];
  /** The record's revision of the copy these belong to. */
  stamp: number;
  /**
   * The agent's tool surface as this hold left it. A surface that is no
   * longer this when the retry comes was changed by somebody here — an
   * unpublished section is theirs to edit — and the hold gives way to it.
   */
  surface: { mcpServerIds: string[]; skillIds: string[] };
}

function sameSurface(a: { mcpServerIds: readonly string[]; skillIds: readonly string[] }, b: { mcpServerIds: readonly string[]; skillIds: readonly string[] }): boolean {
  const key = (one: { mcpServerIds: readonly string[]; skillIds: readonly string[] }): string =>
    JSON.stringify([[...one.mcpServerIds].sort(), [...one.skillIds].sort()]);
  return key(a) === key(b);
}

/** Keeps what has still not arrived, against the surface as it now stands — or lets the hold go when nothing is left. */
function heldOrSettled(db: Db, agentId: string, stamp: number, unarrived: UnarrivedTools, now: number): boolean {
  if (unarrived.missing === 0) {
    settled(db, [`agentTools:${agentId}`]);
    return true;
  }
  const attached = getAgentAttachments(db, agentId);
  const held: HeldTools = {
    agentId,
    mcpServerIds: unarrived.missingMcpServerIds,
    skillIds: unarrived.missingSkillIds,
    stamp,
    surface: { mcpServerIds: attached.mcpServerIds, skillIds: attached.skillIds },
  };
  rememberLatest(db, "agentTools", agentId, held, "the servers and skills it is attached to", now);
  return false;
}

/**
 * Holds an agent's tool surface where part of it has not arrived
 * (EO-476).
 *
 * The catalogues an agent is attached to come by other doors than the
 * agent: a skill in the packs section's publication, a server in
 * policy, each paged on its own. `replaceReplicaAttachments` attaches
 * what this replica holds and has to skip the rest, for the foreign key;
 * this keeps the rest — only the rest — keyed by the agent and stamped
 * with the copy, and the retry attaches each one as it lands. Settled at
 * once where nothing is missing, so a copy that is whole leaves nothing
 * behind.
 *
 * What did arrive is not held. Once it is attached it is the agent's
 * surface like any other, and where the agents section is unpublished a
 * person here may take it off; a repair that re-attached it would be
 * undoing their edit for them.
 */
function holdArrivingTools(options: DrainOptions, agentId: string, mcpServerIds: readonly string[], skillIds: readonly string[], stamp: number, now: number): void {
  heldOrSettled(options.db, agentId, stamp, attachArrivedTools(options.db, agentId, mcpServerIds, skillIds), now);
}

/**
 * Names the agent on every run that was pulled before it (EO-476).
 *
 * Called whenever an agent lands — a record-held project's own, from
 * the sync's list, and a global one, from a publication — and reading
 * only the rows waiting on that agent, which is what the key is for.
 */
function attributeWaitingRuns(db: Db, agentId: string): void {
  const waiting = pendingWithKeyPrefix<{ runId: string; agentId: string }>(db, "runAgent", `${agentId}:`);
  for (const row of waiting) attributeMirroredRun(db, row.payload.runId as Uuid, agentId as Uuid);
  settled(
    db,
    waiting.map((row) => row.id),
  );
}

/**
 * An agent id this replica can resolve, or none.
 *
 * `runs.agent_id` is a foreign key, so a run staffed by an agent
 * somebody made on another machine cannot carry it here. Null is what a
 * `builtin` step's run already means, and a run whose agent this
 * machine cannot name reads the same way: EO ran something, and the
 * name of who is not available here. The alternative is not inserting
 * the run at all, which is a board that silently omits work.
 */
function knownAgent(db: Db, agentId: string | null): Uuid | null {
  if (agentId === null) return null;
  return getAgent(db, agentId as Uuid) === undefined ? null : (agentId as Uuid);
}

/** A file this device has been told about and has not downloaded. */
interface WantedFile {
  id: string;
  itemId: string;
  /** Null for one of the item's own files (EO-702). Absent on a want written before there were any. */
  commentId: string | null;
  name: string;
  mimeType: string;
}

/**
 * The next page of the queue, cut at the first file.
 *
 * An attachment command carries up to twenty megabytes, which is the
 * whole of a request; a page of two hundred could not carry one. So a
 * file is sent alone — and everything queued before it is sent first,
 * in order, because the queue's order is the history and a file must
 * not overtake the comment that announced it.
 */
function nextBatch(db: Db, batchSize: number): QueuedCommand[] {
  const page = pendingCommands(db, batchSize);
  const firstFile = page.findIndex((entry) => entry.command.kind === "attachment");
  if (firstFile === -1) return page;
  return firstFile === 0 ? [page[0]!] : page.slice(0, firstFile);
}

/**
 * The run a command points at, in front of the command that points at
 * it (EO-324).
 *
 * `comments.run_id` and `transitions.run_id` are foreign keys and the
 * record enforces them. A run that happened offline produces both — the
 * output comment it wrote, the move its result routed — and those are
 * queued the moment they are made, which is long before the run-sync
 * phase gets a chance to hand the run over. Replayed on their own they
 * hit a constraint on a run the record has never heard of, and the
 * whole queue stops behind them.
 *
 * Fixed here rather than by reordering the phases, because ordering
 * between phases is a promise a future edit can quietly break, while a
 * prerequisite carried *inside the same request* cannot come apart. The
 * run goes immediately before the first command that needs it, in one
 * batch, in one transaction's worth of order.
 *
 * Idempotent on the far side: a run command is an upsert, so a run the
 * record already has costs one statement and changes nothing. That is
 * the ordinary case — most comments are written while their run is
 * already on the record — and it is why this does not first ask.
 *
 * `carried` is the batch's own memory, so a run behind twenty comments
 * is sent once rather than twenty times.
 */
function carryPrerequisiteRun(db: Db, command: RecordCommand, carried: Set<string>, into: RecordCommand[]): void {
  const runId = runBehind(command);
  if (runId === null || carried.has(runId)) return;
  carried.add(runId);
  const run = getRun(db, runId as Uuid);
  // A run this device itself no longer has — its item deleted under it
  // — is not sent, and the command naming it is refused by the record
  // with a sentence rather than dropped in silence. That is the honest
  // order: the record is the one that knows whether it can hold the row.
  if (run !== undefined) into.push(asRunCommand(run, runCommandId(run.id, run.status), 0));
}

/** The run a command's foreign key points at, or null when it names none. */
function runBehind(command: RecordCommand): string | null {
  // A side call made inside a run (EO-514): `side_calls.run_id` is a
  // foreign key too, and the call is queued while its run is still going.
  if (command.kind === "comment" || command.kind === "transition" || command.kind === "sideCall") return command.runId;
  return null;
}

/**
 * The batch with its files read in, and the commands that no longer
 * have one.
 *
 * The bytes live in this machine's attachment store and are read at the
 * moment of sending, so a desktop that is offline for a week holds one
 * copy of each file rather than two. A file that has gone in the
 * meantime — deleted with its comment, or a store this process was
 * built without — leaves a command that can never be carried out, and
 * the honest thing is to drop it rather than replay it for ever.
 */
async function withFileBytes(
  options: DrainOptions,
  batch: readonly QueuedCommand[],
): Promise<{ commands: RecordCommand[]; sent: QueuedCommand[]; dropped: string[] }> {
  const commands: RecordCommand[] = [];
  const sent: QueuedCommand[] = [];
  const dropped: string[] = [];
  /** The runs already carried in this batch, so one is sent once however many commands need it. */
  const carried = new Set<string>();

  for (const entry of batch) {
    if (entry.command.kind !== "attachment") {
      carryPrerequisiteRun(options.db, entry.command, carried, commands);
      commands.push(entry.command);
      sent.push(entry);
      continue;
    }
    const bytes = await readAttachment(options, entry.command.attachmentId);
    if (bytes === null) {
      dropped.push(entry.id);
      continue;
    }
    commands.push({ ...entry.command, dataBase64: bytes.toString("base64") });
    sent.push(entry);
  }

  return { commands, sent, dropped };
}

/** This machine's copy of a file, or null when it no longer has one. */
async function readAttachment(options: DrainOptions, attachmentId: string): Promise<Buffer | null> {
  if (options.attachments === undefined) return null;
  const record = getAttachment(options.db, attachmentId as Uuid);
  if (record === undefined) return null;
  return options.attachments.read(record.path);
}

/**
 * What one answered command means for this device.
 *
 * The three outcomes of `RecordCommandResult`, each with the treatment
 * the design ask for. The row is forgotten either way by the
 * caller: a move the record refused is as *answered* as one it applied,
 * and leaving it to be sent again would be asking the same question
 * until somebody moved the item back.
 */
async function settle(options: DrainOptions, entry: QueuedCommand, said: RecordCommandResult, result: DrainResult): Promise<void> {
  const { db, local } = options;
  if (said.applied) {
    result.sent += 1;
    return;
  }

  if (said.superseded !== null) {
    result.superseded += 1;
    const item = getItem(db, entry.itemId);
    // Said on the item, as an escalation with a human mention — which
    // *is* the inbox row (invariant #4: there is no inbox table, the
    // inbox is the query over open human mentions). So "an inbox row
    // says your move of SUP-31 was superseded by Dana's" needs no
    // second channel and no second table; it is a comment, and it
    // lights `!` on the item the way every other thing a person has to
    // read does.
    //
    // Posted through the *local* record, so it stays on this device.
    // The other desktops did not make this move and are not waiting to
    // hear that it was dropped; sending it to the record would put a
    // question in everybody's inbox about somebody else's mistake.
    local.postComment({
      itemId: entry.itemId,
      author: { type: "engine" },
      kind: "escalation",
      mentions: [{ type: "human" }],
      body: supersededLine(item?.key ?? entry.itemId, said.superseded.by || SOMEONE_ELSE, said.superseded.stepId),
      // This machine's, and nobody else's. The other desktops did not
      // make this move and are not waiting to hear that it was dropped;
      // on the shared thread the mention would put a question about
      // somebody else's mistake into everybody's inbox.
      staysHere: true,
    });
    // The record's truth is *not* written here. The pull at the end of
    // this same pass carries the transition the record actually applied,
    // with the record's own id, and mirroring it there is what keeps one
    // path for "a move the record made" rather than two that could
    // disagree. What this device shows in between is its own provisional
    // move — for the rest of one pass — which is exactly what the dashed
    // card has been saying all along.
    return;
  }

  if (said.notPermitted !== null) {
    // **Something this person may not do on a group-owned human step**
    // (EO-368): not in the step's group, not the person holding the item,
    // or a takeover from somebody who no longer holds it. Told the way a
    // superseded move is — an escalation mentioning the person at this
    // machine, kept on this machine — and saying why, with the group or
    // the holder named, because that is who to go and talk to.
    result.refused += 1;
    const refusal = said.notPermitted;
    const item = getItem(db, entry.itemId);
    local.postComment({
      itemId: entry.itemId,
      author: { type: "engine" },
      kind: "escalation",
      mentions: [{ type: "human" }],
      body: stepRefusalLine(item?.key ?? entry.itemId, actOf(entry.command), refusal, signedInPersonId(db)),
      staysHere: true,
    });
    // …and what this machine showed at once, put back. Nothing is
    // reverted quietly — the sentence above is said first — but nothing
    // is left showing either: the record wrote nothing, so no pull would
    // ever bring the truth home on its own.
    //
    // The step first. A refused move or decision was applied here as a
    // transition, so the record's position comes back as one too —
    // mirrored, so it is not queued back to a record that never left
    // that step, and through the one writer of `stepId` (invariant #1).
    if (entry.command.kind === "transition" && item !== undefined && refusal.stepId !== null && item.stepId !== refusal.stepId) {
      local.applyTransition({
        itemId: entry.itemId,
        toStepId: refusal.stepId,
        ...(refusal.pipelineId !== null && refusal.pipelineId !== item.pipelineId ? { toPipelineId: refusal.pipelineId as Uuid } : {}),
        actor: "engine",
        reason: "your organisation's record did not apply this move",
        mirrored: true,
      });
    }
    // Then who holds it, after the step: arriving back on a step that
    // waits on a group leaves an item unclaimed, and the record's holder
    // is the one it should show.
    if (said.holder !== null) setReplicaAssignee(db, entry.itemId, said.holder.person);
    // An item file (EO-702) put on or taken off by somebody the record
    // says may not change the item: put on, it comes off this copy again,
    // bytes and all; taken off, it is fetched back from the record, which
    // still has it — this copy's row and bytes went when it was removed.
    if (entry.command.kind === "attachment" && entry.command.commentId === null) {
      const taken = removeItemAttachment(db, entry.command.attachmentId as Uuid, { announce: false, tellJira: false });
      if (taken !== undefined) await options.attachments?.removeManaged?.(taken);
    }
    if (entry.command.kind === "attachmentRemoval") {
      const { attachmentId, itemId, name, mimeType } = entry.command;
      forgetAttachmentRemoval(db, attachmentId as Uuid);
      wantFile(options, attachmentId, { itemId, commentId: null, name: name || "the file", mimeType }, options.now?.() ?? Date.now());
    }
    return;
  }

  if (said.heldBy !== null) {
    // **A claim that lost** (EO-367). Somebody else's reached the record
    // first. Told the way a superseded move is — an escalation that
    // mentions the person at this machine, kept on this machine — and
    // naming who has it, because that is who to go and talk to.
    result.superseded += 1;
    const item = getItem(db, entry.itemId);
    local.postComment({
      itemId: entry.itemId,
      author: { type: "engine" },
      kind: "escalation",
      mentions: [{ type: "human" }],
      body: claimDroppedLine(item?.key ?? entry.itemId, said.heldBy.name || SOMEONE_ELSE),
      staysHere: true,
    });
    // …and the holder put back on this copy, which is the one place this
    // differs from a move. A move's truth comes home on the pull as a
    // transition with its own id; an assignee comes home only as the
    // item row, and the pull declines a row no newer than the one here.
    // A desktop that had already pulled the winning claim and pressed
    // Claim anyway would get nothing back, and would show itself holding
    // an item the record gave to somebody else.
    setReplicaAssignee(db, entry.itemId, { id: said.heldBy.personId, name: said.heldBy.name || SOMEONE_ELSE });
    return;
  }

  result.refused += 1;
  // A claim or an assignment the record refused outright (EO-367,
  // review): an unknown machine, a person it has no row for. This
  // device has been showing it since it was made, and the record wrote
  // nothing — so no newer item row will come down to correct it. Put
  // back who the record says holds the item, beside the sentence below.
  if ((entry.command.kind === "claim" || entry.command.kind === "assign" || entry.command.kind === "takeover") && said.holder !== null) {
    setReplicaAssignee(db, entry.itemId, said.holder.person);
  }
  local.postComment({
    itemId: entry.itemId,
    author: { type: "engine" },
    body:
      `Your organisation's record would not accept a change EO had waiting for it: ${said.problem ?? "no reason given"} ` +
      "EO has dropped it rather than retrying something the record has refused.",
    // An account of this machine's queue, for the person at it.
    staysHere: true,
  });
}

/**
 * What a queued command was, in the words a refusal names it with
 * (EO-368). A decision travels as a transition like a drag does, and the
 * reason it carries is what tells the two apart — `decideItem` writes
 * `decided "Approve"`.
 */
function actOf(command: RecordCommand): StepAct {
  switch (command.kind) {
    case "claim":
      return "claim";
    case "takeover":
      return "takeover";
    case "transition":
      return isDecision(command.reason) ? "decision" : "move";
    default:
      return "edit";
  }
}

/**
 * The record's changes, into the replica.
 *
 * Items first, then the moves, then what was said, and the order is the
 * foreign keys: a transition needs its item and a comment needs its
 * item, and a pull that interleaved them would drop rows for no better
 * reason than the order they came off the wire in.
 *
 * Before all of it, since EO-325, the projects and the graphs. Both are
 * what an item *stands on*: `upsertReplicaItem` skips an item whose
 * step this machine cannot resolve, and an item whose project is
 * missing arrives belonging to nothing and is drawn on no board — which
 * is what a project moved to the record would look like on the person's
 * second desktop. Neither goes through `place`, because neither has a
 * prerequisite to wait for: a project depends on nothing, and a graph
 * carries its own steps and routes with it.
 */
async function applyChanges(options: DrainOptions, changes: RecordChanges): Promise<number> {
  const now = options.now?.() ?? Date.now();
  let applied = 0;

  for (const project of changes.projects) {
    // Whether this desktop is meeting it for the first time. Asked
    // before the write, because afterwards every project looks like one
    // it already had (EO-325).
    const newHere = getProject(options.db, project.id as Uuid) === undefined;
    const outcome = upsertReplicaProject(options.db, {
      id: project.id as Uuid,
      name: project.name,
      keyPrefix: project.keyPrefix,
      managedAt: project.managedAt,
      // Never on a replica. What "kept here" means is that *this*
      // machine holds the original, and a project arriving from the
      // record is by definition not that. Nor is one arriving through
      // this door ever mid-transfer: the record does not send a
      // project it has not finished taking.
      keptLocalAt: null,
      adoptingAt: null,
      // Nor archived: archiving is refused for a project on the record
      // (EO-347), so there is no such state for the record to send.
      archivedAt: null,
      ownerId: project.ownerId as Uuid | null,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
    applied += outcome === "skipped" ? 0 : 1;
    // …and if it is new here, its history is owed. A project moved to
    // the record brings dates this device's cursors are already past,
    // so the ordinary feed will never offer them — see
    // `record_backfills`. Harmless on a desktop signing in for the
    // first time, where the scoped read finds what the general pull is
    // fetching anyway and every apply is idempotent; the cost is a
    // second read of one project's rows, once.
    //
    // Only where the row actually landed. `upsertReplicaProject`
    // declines an out-of-order page rather than writing an older name
    // over a newer one, and a debt against a project that is not here
    // is a foreign key with nothing on the other end of it.
    if (newHere && outcome !== "skipped") {
      wantBackfill(options.db, project.id as Uuid, START, options.now?.() ?? Date.now());
    }
  }
  /**
   * The types before anything filed under one (EO-325).
   *
   * Between the projects and the graphs, which is where they belong:
   * a type is scoped to a project and an item names a type. A replica
   * used to *invent* these — `upsertReplicaProject` copied whatever the
   * installation happened to have — so a moved project's own type
   * arrived as a local row with a local id, and an item naming the
   * record's id either resolved to the wrong row by slug or resolved to
   * nothing and was dropped.
   */
  for (const type of changes.itemTypes) {
    upsertReplicaItemType(options.db, type);
    applied += 1;
  }
  /**
   * What the organisation has published, which is what makes the graphs
   * below read-only here (EO-329, ARCHITECTURE.md, "Publish, lock and versions").
   *
   * **Before** the graphs, and that order is load-bearing rather than
   * tidy. `upsertReplicaPipeline` asks whether the pipelines section is
   * published to decide whether the record's graph overwrites this
   * machine's copy or only fills in what is missing — because the design says
   * both, one for a published section and one for an unpublished one.
   * The page that first brings a publish brings the graph it published
   * with it, and a device that applied that graph before the row saying
   * it was managed would write it under the wrong rule and never see
   * that page again: the cursor has moved, and a pipeline pages only
   * when it is touched.
   *
   * Written straight rather than through `place`: a publication waits
   * for nothing. It names a section, and a section is not a row this
   * device might not have yet.
   */
  for (const published of changes.publishedSections) {
    publishSection(options.db, published);
    // …and what it published. A row on its own would be a lock over
    // whatever this machine happened to have; the document is the
    // configuration the organisation is actually running (EO-329,
    // review).
    applied += 1 + applySectionDocument(options.db, published.document);
    // …and a published agent is one a run pulled earlier may name, and
    // one whose skills may be on a later page than this one. Only an
    // agent this publication actually wrote — `applySectionDocument`
    // passes over one this replica holds a newer copy of.
    for (const agent of published.document?.agents ?? []) {
      attributeWaitingRuns(options.db, agent.id);
      if (agent.deletedAt === null && recordStampOf(options.db, agent.id) === agent.revision) {
        holdArrivingTools(options, agent.id, agent.mcpServerIds, agent.skillIds, agent.revision, now);
      }
    }
  }
  for (const pipeline of changes.pipelines) {
    upsertReplicaPipeline(options.db, pipeline);
    applied += 1;
  }
  // A pipeline the record holds now has its template updates held there
  // (EO-534): a conflict this desktop recorded before is obsolete, and is
  // closed with its notice the moment the pull says so — not left to
  // shadow the record's until the next launch.
  if (changes.pipelines.length > 0 || changes.publishedSections.length > 0) {
    for (const pipeline of listPipelines(options.db)) if (heldByTheRecord(options.db, pipeline.id)) retireObsoleteHold(options.db, pipeline.id, now);
  }
  /**
   * The record-held projects' own skills and their workspaces' (EO-513),
   * before the agents attached to them, so an agent on this page is
   * attached at once — and one held from an earlier page for want of
   * one of them is attached on the next pass (`agentTools`).
   *
   * Written straight rather than through `place`: a skill waits for
   * nothing — its scope names a project or a workspace, and one that is
   * not here yet is a skill delivered to no run until it is. Under the
   * catalogue's rule (`upsertReplicaSkill`), with its project as the
   * record says, since a moved workspace may not be one this machine
   * has. Newer wins, so a page read out of order cannot take a skill
   * back to an older body.
   */
  for (const skill of changes.skills) {
    const here = getSkill(options.db, skill.id);
    if (here !== undefined && here.updatedAt > skill.updatedAt) continue;
    const { projectId, ...row } = skill;
    // Refused, with nothing written, where a person locked a skill here
    // that holds the slug (EO-714) — said in the log, as a publication's is.
    const taken = upsertReplicaSkill(options.db, row, projectId);
    if (!taken.ok) {
      console.log(`[eo] ${taken.problem}`);
      continue;
    }
    applied += 1;
  }
  /**
   * The record-held projects' own agents (EO-476), after the
   * publications for the graphs' reason — whether the agents section is
   * published decides whether the record's agent is written over this
   * machine's — and after the catalogues a publication brings, which
   * their tool surface is attached to. Before the runs, which name them.
   *
   * Through `place`, unlike the graphs: an agent whose project is a
   * page behind is held rather than written with no project, which
   * would make it a global agent here.
   */
  for (const agent of changes.agents) {
    applied += place(options, "agent", agent.id, agent, now) ? 1 : 0;
  }

  // Items first, then everything that hangs off one. Each list is paged
  // on a cursor of its own, so "first" is only true *within a page*: a
  // comment in this page may belong to an item in the next one. What
  // cannot be placed is kept rather than dropped — see
  // `record_pending`, and `place` below, which is the one door
  // everything goes through.
  for (const item of changes.items) {
    applied += place(options, "item", item.id, item, now) ? 1 : 0;
  }
  for (const run of changes.runs) {
    applied += place(options, "run", run.runId, run, now) ? 1 : 0;
  }
  for (const move of changes.transitions) {
    applied += place(options, "transition", move.id, move, now) ? 1 : 0;
  }
  for (const comment of changes.comments) {
    applied += place(options, "comment", comment.commentId, comment, now) ? 1 : 0;
  }
  // Not through `place`. An attachment's pending row is not a *failure*
  // to write something down — it is the want itself, and its lifetime
  // belongs to `fetchFiles`, which settles it when the bytes land. A
  // retry loop that treated "the want is recorded" as "placed" would
  // delete the want on the very next pass, which is the whole of what
  // it was there to prevent.
  for (const file of changes.attachments) {
    wantFile(options, file.id, { itemId: file.itemId, commentId: file.commentId, name: file.name, mimeType: file.mimeType }, now);
  }
  // Item files somebody took off elsewhere (EO-702): the row and the
  // bytes go here too, and a fetch not yet finished is not finished.
  // Not sent back — the record is where this came from.
  for (const removal of changes.attachmentRemovals) {
    const removed = removeItemAttachment(options.db, removal.attachmentId as Uuid, { announce: false, tellJira: false, now: removal.ts });
    if (removed === undefined) {
      noteAttachmentRemoved(options.db, removal.attachmentId as Uuid, removal.itemId as Uuid, removal.ts);
      continue;
    }
    await options.attachments?.removeManaged?.(removed);
    applied += 1;
  }
  for (const group of changes.runEvents) {
    const first = group.events[0];
    if (first === undefined) continue;
    applied += place(options, "runEvents", `${group.runId}:${String(first.seq)}`, group, now) ? 1 : 0;
  }
  for (const pin of changes.pins) {
    applied += place(options, "pin", pin.commentId, pin, now) ? 1 : 0;
  }
  // Mentions somebody answered or dismissed elsewhere (EO-325). Keyed
  // by the comment *and* the target, because a thread that named four
  // people has four of these and one key would let the first overwrite
  // the rest while they waited for the comment to arrive.
  for (const one of changes.mentions) {
    applied += place(options, "mention", `${one.commentId}:${one.targetType}:${one.targetId ?? ""}`, one, now) ? 1 : 0;
  }
  // Where each watch on a step that keeps checking stands (EO-456), after
  // the items it belongs to. Keyed by item and step, which is a watch's
  // identity on both sides.
  for (const watch of changes.watches) {
    applied += place(options, "watch", `${watch.itemId}:${watch.stepId}`, watch, now) ? 1 : 0;
  }
  // The memory of the projects the record holds (EO-482), after the runs
  // and items an entry names as its source — held until they are here
  // when they are a page behind, rather than written without them.
  for (const entry of changes.memories) {
    applied += place(options, "memory", entry.id, entry, now) ? 1 : 0;
  }

  return applied;
}

/**
 * Everything the record has said, retried.
 *
 * The other half of `place`: what could not be written down last time
 * is tried again now, because the thing it was waiting for may have
 * arrived on this page. A run whose row was one page behind its
 * transcript is the case this exists for, and by the second pass they
 * are both here.
 *
 * Run before the new page rather than after it, so that a prerequisite
 * settled last time is in place before this page's children look for
 * it — and so that a long backlog drains in the order it arrived.
 */
function retryPending(options: DrainOptions): number {
  const { db } = options;
  const now = options.now?.() ?? Date.now();
  let applied = 0;

  // Parents before children, exactly as a fresh page is applied — and
  // `attachment` is deliberately not among them: that kind's row is a
  // want rather than a held write, and `fetchFiles` is what ends it.
  for (const kind of ["agent", "agentTools", "item", "run", "transition", "comment", "runEvents", "pin", "mention", "watch", "memory"] as const) {
    const waiting = pending(db, kind, MAX_RETRIES_PER_PASS);
    const done: string[] = [];
    const again: string[] = [];
    for (const row of waiting) {
      if (apply(options, kind, row.payload, now).placed) {
        done.push(row.id);
        applied += 1;
      } else {
        again.push(row.id);
      }
    }
    settled(db, done);
    triedAgain(db, again);
  }

  return applied;
}

/**
 * The kinds that are *held writes* rather than wants.
 *
 * `attachment` is the odd one and is deliberately absent: its pending
 * row is a want, ended by `fetchFiles` when the bytes land, where every
 * kind here is a row the record sent that this device could not write
 * down yet.
 */
type HeldKind = Exclude<PendingKind, "attachment" | "runAgent">;

/**
 * One row from the record, written down — or kept for later.
 *
 * The single door, so that "what happens to a row whose prerequisite is
 * missing" is answered once rather than seven times. Dropping was the
 * answer before, and it was wrong in a way that only shows up on a
 * desktop joining an organisation with history: the cursors advance
 * whatever happens to a row, so a child dropped because its parent was
 * on the next page is a child nobody will ever mention again.
 *
 * The cursors still advance. Holding them back would trade one silent
 * loss for one loud freeze — a single item this installation cannot
 * resolve, and the whole board stops — and `record_pending` is what
 * makes moving on safe.
 */
function place(options: DrainOptions, kind: HeldKind, key: string, payload: unknown, now: number): boolean {
  const outcome = apply(options, kind, payload, now);
  if (outcome.placed) return true;
  if (outcome.waitingFor === null) return false;
  // An agent held until its section is published changes on the record
  // while it waits, and the copy to write when the wait ends is the
  // newest one (EO-476). Every other held row is the same row each time
  // it arrives.
  if (kind === "agent" || kind === "memory") rememberLatest(options.db, kind, key, payload, outcome.waitingFor, now);
  else remember(options.db, kind, key, payload, outcome.waitingFor, now);
  return false;
}

/**
 * A mirrored comment's mentions, as the record has them (EO-325).
 *
 * Only the ones that are not open, which is almost none of them: a
 * thread being pulled for the first time is mostly things nobody has
 * answered yet, and writing every row twice to say so would be a
 * statement per mention per pull.
 *
 * `addressedBy` is dropped where this replica has not got that comment
 * yet — `comment_mentions.addressed_by` is a foreign key, and the
 * status is the half that decides the inbox and the `!`. The reply
 * itself arrives on the same feed, later; what it cannot do is come
 * back and repair this, because a comment is pulled once. So the
 * marker is right and the provenance is missing, which is the right way
 * round to be wrong.
 */
function settleMirroredMentions(db: Db, comment: RecordCommentCommand): void {
  for (const mention of comment.mentions) {
    if (mention.status === "open") continue;
    const answeredBy = mention.addressedBy !== null && getComment(db, mention.addressedBy as Uuid) !== undefined ? mention.addressedBy : null;
    settleMention(db, {
      commentId: comment.commentId as Uuid,
      targetType: mention.type,
      targetId: mention.type === "agent" ? mention.agentId : mention.personId,
      status: mention.status,
      addressedBy: answeredBy,
    });
  }
}

/**
 * One comment the record holds, written into this replica as the record
 * has it (EO-325): its mentions as the record resolved them, never
 * re-parsed, and each one's status as the record last knew it.
 *
 * The pull's door, and the one a replica also uses when it has asked the
 * record for something and is handed a comment with the answer (EO-533:
 * the brief of an update conflict's chat) — so a comment that arrives
 * that way is the same row the next pull would have written, and the
 * pull, finding it, writes nothing.
 */
export function mirrorRecordComment(db: Db, local: Pick<ItemRecord, "postComment">, comment: RecordCommentCommand): Comment {
  const mirrored = local.postComment({
    id: comment.commentId as Uuid,
    itemId: comment.itemId as Uuid,
    author: authorOf(comment.authorType, comment.authorId),
    body: comment.body,
    kind: comment.kindOfComment as never,
    options: comment.options,
    runId: comment.runId as Uuid | null,
    parentId: comment.parentId as Uuid | null,
    createdAt: comment.createdAt,
    // The record's resolution, kept rather than redone. A mention
    // is what puts a row in this person's inbox and what dispatches
    // an agent; re-parsing the body here would resolve `@reviewer`
    // against this machine's agents, and an explicit mention with
    // no token in the body would be dropped altogether.
    // …including *who* a human mention is asking, which this
    // dropped (EO-325, review). A comment arriving here was written
    // on somebody else's machine and the record resolved its
    // mention to a named person; throwing that away made
    // `postComment` fall back to "whoever is in front of this
    // machine", so Anna's escalation landed in Dana's inbox on
    // Dana's desktop and in nobody's on Anna's second one — which
    // is the opposite of what the third acceptance criterion asks
    // for. Null still means "whoever is in front of you", which is
    // what a solo desktop and an old queued command both mean.
    mentions: comment.mentions.map((mention) =>
      mention.type === "agent"
        ? { type: "agent" as const, agentId: mention.agentId as Uuid }
        : { type: "human" as const, ...(mention.personId === null ? {} : { personId: mention.personId as Uuid }) },
    ),
    parseBodyMentions: false,
    // Nor is the resolution redone here (EO-325). Whichever machine
    // heard the answer closed the mention and said so, and the
    // record's word for it arrives on the `mentions` list; this one
    // deciding for itself would use its own idea of who "a person"
    // is and then send that back up as though it were news.
    resolveMentions: false,
    pinned: comment.pinned,
    // Written on another machine, so neither this one's to push to
    // a tracker nor this one's to send back to the record it just
    // came from — see `PostCommentInput.staysHere`.
    staysHere: true,
  });
  // …and whether each of those is still waiting (EO-325, review).
  //
  // `postComment` writes every mention open, which is the truth for
  // a comment being said for the first time and not for one being
  // *mirrored*: an escalation somebody answered a fortnight ago
  // arrived here open and sat in their inbox on their second
  // desktop. Applied after the insert rather than threaded through
  // `postComment`, because a status is a fact about a mirrored row
  // and not something any of the hundred and twenty-eight local
  // callers has an opinion about.
  settleMirroredMentions(db, comment);
  return mirrored;
}

/**
 * What became of one row.
 *
 * `placed` is written down, or already here, or nothing this device
 * needs to do. `waitingFor` names the prerequisite when there is one to
 * wait for, and is null when there is nothing to wait *for* — a row
 * this installation can never resolve, which is kept out of the pending
 * table on purpose: it would be retried for ever and mean nothing.
 */
function apply(options: DrainOptions, kind: HeldKind, payload: unknown, now: number): { placed: boolean; waitingFor: string | null } {
  const { db, local } = options;
  const placed = { placed: true, waitingFor: null };

  switch (kind) {
    case "agent": {
      // A record-held project's own agent (EO-476), and what can hold
      // one back — see `upsertReplicaProjectAgent`.
      const agent = payload as RecordAgent;
      const outcome = upsertReplicaProjectAgent(db, agent);
      if (outcome === "waiting") return { placed: false, waitingFor: `project ${agent.projectId}` };
      // This machine's own copy stands while the agents section is
      // unpublished — and the record's newest is held, not dropped,
      // because a publication read on a later page than this agent has
      // to find it here to apply. The cursor has already moved past it,
      // and nothing else would offer it again.
      if (outcome === "kept") return { placed: false, waitingFor: "the agents section to be published" };
      if (outcome === "written") {
        // Written whole, so an older copy still held for it is spent —
        // and the runs that were pulled before it can say who did them,
        // and a server or skill it is attached to that is a page behind
        // is attached when it lands.
        settled(db, [`agent:${agent.id}`]);
        attributeWaitingRuns(db, agent.id);
        if (agent.deletedAt === null) holdArrivingTools(options, agent.id, agent.mcpServerIds, agent.skillIds, agent.revision, now);
      }
      // `stale` is a copy older than one already written here, through
      // either door — the publication that later made the agent global,
      // say — and is passed over; `refused` is a system agent.
      return placed;
    }

    case "agentTools": {
      // The servers and skills an agent the record wrote here is attached
      // to, of which some had not arrived (EO-476). Only while the copy
      // they belong to is still the one here: a newer copy, through
      // either door, brought its own surface.
      const tools = payload as HeldTools;
      if (recordStampOf(db, tools.agentId) !== tools.stamp) return placed;
      // …and while nobody here has changed its surface since. Where the
      // section is unpublished the surface is the person's to edit, and
      // their edit stands over what the record was going to add.
      const attached = getAgentAttachments(db, tools.agentId);
      if (!sameSurface(attached, tools.surface)) return placed;
      if (heldOrSettled(db, tools.agentId, tools.stamp, attachArrivedTools(db, tools.agentId, tools.mcpServerIds, tools.skillIds), now)) return placed;
      return { placed: false, waitingFor: "the servers and skills it is attached to" };
    }

    case "item": {
      const item = payload as RecordItem;
      if (upsertReplicaItem(db, item) !== "skipped") return placed;
      // **An item whose type has not arrived yet** (EO-325). The types
      // are their own list with their own cursor, so a small page can
      // put a moved project's `case` behind the items filed under it —
      // and dropping those would lose exactly the work a custom type
      // exists for. Held on the type's id, so the next pass repairs it.
      if (getItemType(db, item.typeId as Uuid) === undefined) return { placed: false, waitingFor: item.typeId };
      // Anything else skipped is an item whose *step* this installation
      // does not have — a pipeline somebody made on another machine,
      // which arrives in 7c and not before. Nothing to wait for that
      // this device can do anything about, so it is not held: it would
      // be retried on every tick for the life of the installation.
      return { placed: false, waitingFor: null };
    }

    case "run": {
      const run = payload as RecordRunCommand;
      if (getItem(db, run.itemId as Uuid) === undefined) return { placed: false, waitingFor: `item ${run.itemId}` };
      mirrorRun(options, run);
      // Written as nobody's when its agent is not here yet (EO-476): a
      // project's agents page on a cursor of their own and may be a page
      // behind. The record's id is kept beside it, keyed by the agent, and
      // `attributeWaitingRuns` names the run when that agent lands.
      // Not retried on every pass, because an agent may never come: a
      // global agent arrives only with a publication, and a run by one
      // nobody published stays as it was, with nothing spent on it.
      if (run.agentId !== null && getAgent(db, run.agentId as Uuid) === undefined) {
        remember(db, "runAgent", `${run.agentId}:${run.runId}`, { runId: run.runId, agentId: run.agentId }, `agent ${run.agentId}`, now);
      }
      return placed;
    }

    case "memory": {
      // A memory entry as the record holds it (EO-482). Newer wins, so a
      // held copy written late cannot take an entry back to an older
      // state; and a held entry is replaced by the newest copy, for the
      // agents' reason, because an entry changes while it waits.
      const entry = payload as RecordMemory;
      const waitingFor = memoryWaitingFor(db, entry);
      if (waitingFor !== null) return { placed: false, waitingFor };
      writeArrivedMemory(db, entry);
      return placed;
    }

    case "watch": {
      // Where a watch stands on the record (EO-456): the next check this
      // device is leased carries it on from here — its clock, its
      // failure streak, the news already posted — rather than starting a
      // watch of its own.
      const watch = payload as RecordWatch;
      if (getItem(db, watch.itemId as Uuid) === undefined) return { placed: false, waitingFor: `item ${watch.itemId}` };
      // Except while this device still owes the record a report about
      // it. Then the record's row is the older of the two, and taking it
      // would undo a check this machine ran; the report goes on the next
      // pass and the row comes back with it. Decided by what is queued
      // rather than by comparing stamps, because the stamps come from
      // two machines' clocks.
      if (hasQueuedWatch(db, watch.itemId as Uuid, watch.stepId)) return placed;
      mirrorItemWatch(db, watch);
      return placed;
    }

    case "transition": {
      const move = payload as RecordTransitionView;
      // Already here — which every pull says about its own boundary, on
      // purpose. The id is the record's, carried through
      // `transitionItem`, which is what makes this answerable at all.
      if (hasTransition(db, move.id)) return placed;
      if (getItem(db, move.itemId as Uuid) === undefined) return { placed: false, waitingFor: `item ${move.itemId}` };
      local.applyTransition({
        id: move.id as Uuid,
        itemId: move.itemId as Uuid,
        toStepId: move.toStepId,
        actor: move.actor,
        reason: move.reason,
        // The record's own move, copied home. Announcing it would queue
        // a command telling the record about it — a loop that grows by
        // one transition per reconnect. See `transitionEvents.ts`.
        mirrored: true,
      });
      return placed;
    }

    case "comment": {
      const comment = payload as RecordCommentCommand;
      if (getItem(db, comment.itemId as Uuid) === undefined) return { placed: false, waitingFor: `item ${comment.itemId}` };
      // A comment written during a run names it, and `comments.run_id`
      // is a foreign key. The run may be a page behind.
      if (comment.runId !== null && getRun(db, comment.runId as Uuid) === undefined) {
        return { placed: false, waitingFor: `run ${comment.runId}` };
      }
      // The files are noted whether or not the comment is new, because
      // the two can arrive out of step.
      noteFiles(options, comment, now);
      // Already said, and a comment is immutable once it is. The one
      // thing about it that changes afterwards is the pin, which
      // arrives on its own list.
      if (getComment(db, comment.commentId as Uuid) !== undefined) return placed;
      const mirrored = mirrorRecordComment(db, local, comment);
      // Save or Discard pressed on another device, on a skill proposal
      // this machine's consolidation posted (EO-483): carried out here,
      // where the proposal and the memory it would change are.
      if (mirrored.authorType === "human" && mirrored.parentId !== null) answerCopiedSkillProposal(db, mirrored);
      return placed;
    }

    case "runEvents": {
      const group = payload as RecordChanges["runEvents"][number];
      if (getRun(db, group.runId as Uuid) === undefined) return { placed: false, waitingFor: `run ${group.runId}` };
      const added = appendSyncedRunEvents(
        db,
        group.runId as Uuid,
        // The author the record recorded — which machine the work
        // actually happened on. Not this one, or every replica would
        // claim every transcript it received.
        group.deviceId ?? "",
        group.events.map((event) => ({ seq: event.seq, ts: event.ts, type: event.type, payload: event.payload })),
      );
      // And the bookmark moves with them, or this device would offer
      // the record back its own transcript on the next tick.
      if (added > 0) {
        settleMirroredRun(options, group.runId as Uuid);
        options.onRunEvents?.(group.runId as Uuid);
      }
      return placed;
    }

    case "mention": {
      const settledMention = payload as RecordChanges["mentions"][number];
      // Waits for the comment, rather than being dropped: the two
      // arrive on different lists with different cursors, and a desktop
      // that pulled the settlement in the same page as the comment it
      // belongs to can see either one first.
      if (getComment(db, settledMention.commentId as Uuid) === undefined) {
        return { placed: false, waitingFor: `comment ${settledMention.commentId}` };
      }
      // Same trade `settleMirroredMentions` makes on the comment path,
      // and it has to be the same: the status is what decides the inbox
      // and the `!`, and `addressed_by` is a foreign key. Keep the
      // settlement, drop the provenance when the reply is not here.
      const answeredBy =
        settledMention.addressedBy !== null && getComment(db, settledMention.addressedBy as Uuid) !== undefined
          ? settledMention.addressedBy
          : null;
      settleMention(db, {
        commentId: settledMention.commentId as Uuid,
        targetType: settledMention.targetType,
        targetId: settledMention.targetId,
        status: settledMention.status,
        addressedBy: answeredBy,
      });
      return placed;
    }

    case "pin": {
      const pin = payload as RecordChanges["pins"][number];
      const comment = getComment(db, pin.commentId as Uuid);
      if (comment === undefined) return { placed: false, waitingFor: `comment ${pin.commentId}` };
      if (comment.pinned === pin.pinned) return placed;
      // `staysHere`, and the record's own clock: this device must not
      // send the pin back to the record that sent it, and must not
      // restamp it either — a pin that took this machine's time on
      // arrival would be re-sent to every *other* machine as though it
      // had just happened.
      setCommentPinned(db, pin.commentId as Uuid, pin.pinned, { staysHere: true, at: pin.ts });
      return placed;
    }
  }
}

function authorOf(type: string, id: string | null): { type: "human" } | { type: "agent"; agentId: Uuid } | { type: "engine" } | { type: "module" } {
  if (type === "agent" && id !== null) return { type: "agent", agentId: id as Uuid };
  if (type === "human" || type === "engine" || type === "module") return { type };
  // An author this version has no word for. `engine` rather than a
  // throw: the comment is still something that was said, and losing it
  // to protect a label would be the wrong trade on the only channel
  // there is (invariant #4).
  return { type: "engine" };
}

