import { uuidv7, type Comment, type RecordCommand, type RecordCommentCommand, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import {
  onCommentPinned,
  onCommentPosted,
  onMentionSettled,
  type CommentContext,
  type PinnedComment,
  type SettledMention,
} from "../db/commentEvents.js";
import { onTransitionApplied, type AppliedTransition } from "../db/transitionEvents.js";
import { onAssignmentAsked, type AssignmentAsked } from "../db/assignmentEvents.js";
import { onVersionMoveAsked, type VersionMoveAsked } from "../db/versionMoveEvents.js";
import { listAttachmentsForComment } from "../db/repos/attachmentsRepo.js";
import { listMentionsForComment } from "../db/repos/commentsRepo.js";
import { enqueueCommand, enqueueWatchCommand } from "../db/repos/recordCommandsRepo.js";
import { asRecordWatch } from "../db/repos/itemWatchesRepo.js";
import { onWatchWritten } from "../db/watchEvents.js";
import { onSideCallRecorded } from "../db/sideCallEvents.js";
import type { SideCallRow } from "../db/repos/sideCallsRepo.js";

/**
 * Everything this device does, on its way to the record (EO-324,
 * `ARCHITECTURE.md`, "The record").
 *
 * Three subscriptions, and between them they catch every move and every
 * word written on this machine — a drag, a decision on a human step, an
 * agent's result routing at the end of a run, a refusal the supervisor
 * posted, an output, a file. Each becomes a command in
 * `record_commands` the moment it is written, and the drain replays
 * them in order.
 *
 * ### Why a subscription and not an object threaded through
 *
 * Because there are a hundred and twenty-eight places that write a
 * comment, in thirty files, and the failure of missing one is the worst
 * this phase has: a person's action that looks applied on their screen,
 * is never sent, and is silently not what their organisation's board
 * says. `commentEvents.ts` already made this argument for pushes —
 * *"hand-placed announcements are exactly the bug class being fixed
 * here, so this is one subscription covering every writer, present and
 * future"* — and it applies with more force here, because a missed push
 * is a stale screen and a missed command is lost work.
 *
 * Moves have exactly one writer rather than a hundred and twenty-eight,
 * and that is not a reason to thread one through instead: it is the
 * reason the hook is *safe*. Invariant #1 says `transitionItem` is the
 * only function that may move an item, and
 * `architecturalInvariants.test.ts` proves it by reading the source. So
 * subscribing there is subscribing to every move there can ever be.
 *
 * ### What is deliberately not queued
 *
 * A comment that `staysHere` — one mirrored from the record, or one
 * about this machine's own queue. Sending those back would be telling
 * the record about its own comment, for ever, once per reconnect.
 *
 * A mirrored *move*, for the same reason, which is why
 * `transitionItem` does not announce one at all (see
 * `TransitionItemInput.mirrored`).
 *
 * Run events, which sync out of the table itself by `(runId, seq)` —
 * see `drain.ts`. A queue would hold the events a writer happened to
 * hand it; the table holds all of them, which is what makes "every run
 * event in order" survive a process that died mid-run.
 */

export interface OutboundOptions {
  db: Db;
  /**
   * Whether this item's record is elsewhere.
   *
   * Asked at the moment of writing rather than at subscription, because
   * a person signs in and out without relaunching: a desktop that
   * started solo and signed in an hour ago must queue what it does now,
   * and one that signed out must stop.
   *
   * A solo desktop queues nothing at all. There is nobody to send to,
   * and rows accumulating against a record that does not exist would be
   * a queue that could only ever be deleted.
   *
   * Per item since EO-325, and that is the same argument one step
   * finer. A person who signed in and kept a project kept all of it:
   * what happens on it is this machine's, the record has never heard of
   * the item, and a command queued about it would be replayed for ever
   * against a server that can only answer "this record no longer has
   * that item".
   */
  linked: (itemId: Uuid) => boolean;
  now?: () => number;
  /** Called after anything is queued, so the sync line and the board can be told to ask again. */
  onQueued?: () => void;
}

/**
 * Starts listening. Returns a disposer.
 *
 * Disposed by whoever built it, which in production is the composition
 * root on shutdown and in a test is the end of the test. The
 * subscriptions are keyed on the database, so forgetting would leak a
 * listener rather than corrupt anything — but a database re-opened in
 * one process would then have two, and every command would be queued
 * twice.
 */
export function queueOutbound(options: OutboundOptions): () => void {
  const { db } = options;
  const clock = options.now ?? ((): number => Date.now());

  function queue(commands: readonly RecordCommand[], itemId: Uuid): void {
    if (commands.length === 0) return;
    for (const command of commands) enqueueCommand(db, command, itemId, clock());
    options.onQueued?.();
  }

  const stopWatchingMoves = onTransitionApplied(db, (transition: AppliedTransition) => {
    if (!options.linked(transition.itemId)) return;
    queue([transitionCommand(transition)], transition.itemId);
  });

  const stopWatchingComments = onCommentPosted(db, (comment: Comment, context: CommentContext) => {
    if (!options.linked(comment.itemId) || context.staysHere) return;
    queue(commentCommands(db, comment), comment.itemId);
  });

  const stopWatchingPins = onCommentPinned(db, (pin: PinnedComment) => {
    if (!options.linked(pin.itemId)) return;
    queue([{ kind: "pin", id: uuidv7(), itemId: pin.itemId, commentId: pin.commentId, pinned: pin.pinned }], pin.itemId);
  });

  // Answered and dismissed mentions (EO-325). Same gate as a pin, and
  // for the same reason: a kept project's mentions are nobody's but
  // this machine's, so there is nothing to tell.
  const stopWatchingMentions = onMentionSettled(db, (settled: SettledMention) => {
    if (!options.linked(settled.itemId)) return;
    queue(
      [
        {
          kind: "mention",
          id: uuidv7(),
          itemId: settled.itemId,
          commentId: settled.commentId,
          targetType: settled.targetType,
          targetId: settled.targetId,
          status: settled.status,
          addressedBy: settled.addressedBy,
        },
      ],
      settled.itemId,
    );
  });

  // Claims and assignments (EO-367). Asked rather than done: the
  // record decides who holds an item, and resolves who is claiming from
  // the device this arrives on — so the command carries no claimant, and
  // the comment saying so is the record's to write.
  const stopWatchingAssignments = onAssignmentAsked(db, (asked: AssignmentAsked) => {
    if (!options.linked(asked.itemId)) return;
    queue([assignmentCommand(asked)], asked.itemId);
  });

  // A move to another version of the item's pipeline (EO-567). Asked
  // rather than done, an assignment's way: the record judges it against
  // its own versions and writes the binding and the comment.
  const stopWatchingVersionMoves = onVersionMoveAsked(db, (asked: VersionMoveAsked) => {
    if (!options.linked(asked.itemId)) return;
    queue(
      [{ kind: "rebind", id: uuidv7(), itemId: asked.itemId, version: asked.version, commentId: asked.commentId, note: asked.note }],
      asked.itemId,
    );
  });

  // Where a watch on a step that keeps checking now stands (EO-456).
  // The record schedules the item from this row and the next device to
  // be leased it carries the watch on from it — its clock, its failures,
  // the news it has posted — so a check this device ran is shared state,
  // not this machine's own. Stamped zero on the way up: the record stamps
  // what it writes, because its clock is the one the others page on.
  const stopWatchingWatches = onWatchWritten(db, (watch) => {
    if (!options.linked(watch.itemId)) return;
    enqueueWatchCommand(db, { kind: "watch", id: uuidv7(), ...asRecordWatch(watch), updatedAt: 0 }, watch.itemId, clock());
    options.onQueued?.();
  });

  // What a side call about a record-held item cost (EO-514). The record's
  // per-person budget sums its own `side_calls` rows, so spend that stays
  // here is spend that budget never sees. A call about no item is a
  // consolidation, which for a project the record holds runs on the
  // record and is written there.
  const stopWatchingSideCalls = onSideCallRecorded(db, (call: SideCallRow) => {
    if (call.itemId === null || !options.linked(call.itemId)) return;
    queue([sideCallCommand(call, call.itemId)], call.itemId);
  });

  return () => {
    stopWatchingVersionMoves();
    stopWatchingSideCalls();
    stopWatchingWatches();
    stopWatchingAssignments();
    stopWatchingMoves();
    stopWatchingComments();
    stopWatchingPins();
    stopWatchingMentions();
  };
}

/**
 * A move, as a command.
 *
 * `fromStepId` comes off the audit row rather than being read back from
 * the item, and that is what makes the conflict rule sound: it is where
 * the item *was* at the instant this device moved it, which is exactly
 * the claim the record checks. Reading the item afterwards would give
 * the step it is on now, which is always the destination.
 *
 * `transitionId` is the move's own id, written on both sides, which is
 * what makes a replay after a lost acknowledgement answerable as
 * "already done" rather than as a conflict with itself.
 */
function transitionCommand(transition: AppliedTransition): RecordCommand {
  return {
    kind: "transition",
    id: uuidv7(),
    transitionId: transition.id,
    itemId: transition.itemId,
    fromStepId: transition.fromStepId,
    toStepId: transition.toStepId,
    toPipelineId: transition.toPipelineId,
    actor: transition.actor,
    runId: transition.runId,
    reason: transition.reason,
  };
}

/** A side call, as the row the record writes from it. */
function sideCallCommand(call: SideCallRow, itemId: Uuid): RecordCommand {
  return {
    kind: "sideCall",
    id: uuidv7(),
    itemId,
    sideCallId: call.id,
    purpose: call.purpose,
    runId: call.runId,
    backend: call.backend,
    model: call.model,
    tokensIn: call.tokensIn,
    tokensOut: call.tokensOut,
    costMicrocents: call.costMicrocents,
    startedAt: call.startedAt,
    durationMs: call.durationMs,
    outcome: call.outcome,
    reason: call.reason,
  };
}

/** A claim, an assignment or a takeover, as the command the record arbitrates. */
function assignmentCommand(asked: AssignmentAsked): RecordCommand {
  switch (asked.how) {
    case "claim":
      return { kind: "claim", id: uuidv7(), itemId: asked.itemId, commentId: asked.commentId };
    case "assign":
      return { kind: "assign", id: uuidv7(), itemId: asked.itemId, personId: asked.personId, commentId: asked.commentId };
    case "takeover":
      return { kind: "takeover", id: uuidv7(), itemId: asked.itemId, fromPersonId: asked.fromPersonId, commentId: asked.commentId };
  }
}

/**
 * A comment, as a command — and one more per file hanging off it.
 *
 * The comment first and the files after it, in that order, because the
 * record refuses an attachment whose comment it has never heard of.
 * The queue is replayed in the order it was written, so the order here
 * is the order the record sees.
 *
 * The attachments are read back from the table rather than taken off
 * the comment, because `postComment` inserts them in the same
 * transaction and hands back the comment it built before they landed.
 * Reading is also the honest question: what files does this comment
 * actually have.
 */
function commentCommands(db: Db, comment: Comment): RecordCommand[] {
  const files = listAttachmentsForComment(db, comment.id);
  const commands: RecordCommand[] = [
    {
      kind: "comment",
      id: uuidv7(),
      itemId: comment.itemId,
      commentId: comment.id,
      authorType: comment.authorType,
      authorId: comment.authorId,
      runId: comment.runId,
      parentId: comment.parentId,
      body: comment.body,
      kindOfComment: comment.kind,
      options: comment.options,
      // Who it asks, as *this* device resolved them. Carried rather
      // than left to be re-parsed, because a mention is what dispatches
      // an agent and what puts a row in somebody's inbox: a record
      // parsing the body again would resolve `@reviewer` against its
      // own agents, and an explicit mention with no token in the body
      // at all would simply be lost.
      mentions: mentionsOf(db, comment.id),
      // And whether somebody marked it as the part that matters, which
      // is what survives context truncation (ARCHITECTURE.md, "What an agent is given").
      pinned: comment.pinned,
      attachments: files.map((file) => ({ id: file.id, name: file.name, mimeType: file.mimeType, size: file.size })),
      createdAt: comment.createdAt,
    },
  ];

  for (const file of files) {
    commands.push({
      kind: "attachment",
      id: uuidv7(),
      itemId: comment.itemId,
      commentId: comment.id,
      attachmentId: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      // Filled by the drain, from this machine's store, at the moment
      // of sending — see `RecordAttachmentCommandSchema`.
      dataBase64: "",
    });
  }

  return commands;
}

/**
 * The mention rows a comment was written with, as targets.
 *
 * Read from the table rather than taken off the `Comment`, because the
 * domain object does not carry them and because the table is where the
 * *resolution* happened: `@reviewer` became an agent id, `@user` became
 * the person in front of this machine, and an explicit target somebody
 * passed in never appeared in the body at all.
 *
 * A human target travels *with* its person since EO-325. It did not
 * until then, and the reasoning was sound while every installation had
 * exactly one: "every installation resolves it to its own one person,
 * which is what makes an inbox row arrive on the machine somebody is
 * sitting at". On a record with a list of people it is the opposite —
 * a question Anna asked would land in the record's implicit person's
 * inbox and in Dana's, and never in Anna's own on her second desktop,
 * which is precisely what this story's third acceptance criterion is
 * about. Null still means "whoever is in front of you", which is the
 * honest answer on a solo desktop and for anything queued before the
 * field existed.
 *
 * An agent target travels with one, and that id has to mean the same
 * thing on the record — true of what EO seeds, whose agent ids are
 * literals in the seed migration, and the same caveat `replicaRepo.ts`
 * writes down for steps. An id the record cannot resolve is a mention
 * it stores and never dispatches, which is the safe direction.
 */
function mentionsOf(db: Db, commentId: Uuid): RecordCommentCommand["mentions"] {
  const targets: RecordCommentCommand["mentions"] = [];
  for (const mention of listMentionsForComment(db, commentId)) {
    // The person, since EO-325. A human mention on a moved project
    // names the person who signed in, and "whoever is in front of you"
    // would resolve that to the record's own implicit person — which is
    // nobody's inbox.
    // …and whether it is still waiting (EO-325). A comment being
    // queued has just been posted, so its mentions are open — carried
    // rather than assumed, because assuming it is what let a *pulled*
    // thread reopen an escalation somebody had answered.
    const state = { status: mention.status, addressedBy: mention.addressedBy };
    if (mention.targetType === "human") targets.push({ type: "human", personId: mention.targetId, ...state });
    else if (mention.targetId !== null) targets.push({ type: "agent", agentId: mention.targetId, ...state });
  }
  return targets;
}
