import { z } from "zod";
import { EntryRulesSchema } from "./entryRules.js";
import { PipelineStepViewSchema, PipelineViewSchema, StepRouteViewSchema } from "./ipc-schemas.js";
import { PublishedAgentSchema, PublishedSectionSchema } from "./sections.js";
import { RecordMemorySchema } from "./memory.js";
import { MessageSendSchema } from "./messages.js";
import { SkillSchema } from "./schemas/skills.js";
import { CommentOptionSchema, parseStoredCommentOptions } from "./schemas/commentOptions.js";
import { SideCallFailureReasonSchema, SideCallPurposeSchema } from "./side-calls.js";
import { TrialPlanSchema, TrialStepSourcesSchema } from "./trialPlan.js";

/**
 * The longest `dataBase64` a file may arrive as.
 *
 * The same bound `ipc.ts` names — twenty mebibytes in base64, rounded
 * up — spelled here rather than imported because `ipc.ts` imports *this*
 * file and the dependency cannot go both ways. Two literals of one
 * number is worse than one, which is why the pair is named on both
 * sides and checked by `record.limits.test.ts`.
 */
const MAX_ATTACHMENT_BASE64_CHARS = 28_000_000;

/**
 * The record contract, as it crosses a wire (EO-324,
 * `ARCHITECTURE.md`, "The record").
 *
 * EO-322 split one process into two roles: the **record** owns item
 * state and runs the only scheduler, and a **device** claims a dispatch
 * under a lease, runs the machine-local preflight, and reports. In solo
 * mode both roles are one process and the interfaces are called
 * directly. This file is what those calls look like when the record is
 * on somebody else's machine.
 *
 * Three shapes, and the difference between them is the whole of the design.
 *
 * **A command** is something the device *did* and the record must
 * apply: a move, a comment, a run, the events that run produced. It is
 * durable on the device the moment it is made, it is replayed in the
 * order it was made, and the record's answer to it may be "no". That is
 * what makes an offline move provisional rather than lost.
 *
 * **A question** — what work is there, is my claim still good — cannot
 * be queued, because an answer that arrives after the fact is not an
 * answer. A device that cannot ask has no work, which is exactly what
 * "offline means finish the run you hold, never keep scheduling
 * locally" says.
 *
 * **A change** is what the record has that this device has not seen. It
 * is a pull rather than a push because push here is an invalidation and
 * nothing more (`ipcPushContract`): "something changed, ask again".
 *
 * Nothing in this file names a transport. The desktop sends these over
 * HTTP to its organisation's server; a test sends them straight into a
 * second database. Both are the same contract.
 */

// ── Leases and work ─────────────────────────────────────────────────

/**
 * A claim on dispatching one item, as it travels.
 *
 * The same four columns `dispatch_leases` holds. It is the record that
 * grants one — that is the point of this story's second bullet — so a
 * device never mints a lease and never extends one by writing a row of
 * its own.
 */
export const RecordLeaseSchema = z.object({
  itemId: z.string(),
  deviceId: z.string(),
  grantedAt: z.number(),
  expiresAt: z.number(),
});
export type RecordLease = z.infer<typeof RecordLeaseSchema>;

/**
 * One offer of work, with the claim that comes with it.
 *
 * Ids rather than rows. The device has a replica and can resolve an
 * item, an agent and a step out of it; sending them would be sending
 * the same three rows on every tick for the life of the process, and it
 * would let the two ends disagree about which of the copies is true.
 *
 * `agentId` is null on a `builtin` step — EO runs one of its own
 * functions there, so there is no role to staff (`engine`'s `Dispatch`
 * says the same thing with the same null).
 */
export const RecordOfferSchema = z.object({
  itemId: z.string(),
  stepId: z.string(),
  action: z.string(),
  agentId: z.string().nullable(),
  lease: RecordLeaseSchema,
});
export type RecordOffer = z.infer<typeof RecordOfferSchema>;

// ── Commands ────────────────────────────────────────────────────────

/**
 * A move, as something asked for rather than something done.
 *
 * `fromStepId` is what makes a conflict detectable, and it is the only
 * field here that is not simply the transition. The record applies the
 * move if the item is still where the device thought it was, and
 * refuses it otherwise — which is not an error but the answer the original design
 * asks for: "the record wins a conflict with an inbox row saying so".
 * Without it, two desktops moving one card would both succeed and the
 * later one would silently win.
 *
 * Null means the device is not claiming to know — a first arrival, a
 * command replayed from a queue written before this field existed — and
 * the record applies it unconditionally.
 */
export const RecordTransitionCommandSchema = z.object({
  kind: z.literal("transition"),
  id: z.string(),
  /**
   * The id this move will have on both sides.
   *
   * Minted by the device when it applies the move to its own replica,
   * sent with the command, and written by the record as the audit row's
   * primary key. One move, one identity, in both databases.
   *
   * It is what makes mirroring answerable. A pull re-sends its own
   * cursor boundary and a reconnect re-sends more than that, so a
   * replica has to be able to ask "have I already applied this one" —
   * and the only honest way to ask is by the move's own id. Without it
   * the two sides would hold the same move under two ids, and the
   * question would have to be answered by comparing steps, which is a
   * guess that is wrong exactly when an item moves away and back.
   */
  transitionId: z.string(),
  itemId: z.string(),
  fromStepId: z.string().nullable().default(null),
  toStepId: z.string(),
  toPipelineId: z.string().nullable().default(null),
  actor: z.string(),
  runId: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
});

/**
 * Something said on a thread (invariant #4).
 *
 * Carried with the id it was written under, so that replaying a queue
 * twice — a reconnect that raced a reply — appends nothing the second
 * time. Outputs and attachments are not separate kinds here for the
 * reason `ARCHITECTURE.md`, "The record" gives: they *are* comments, and a
 * second sync path for them would be a second answer to "what was
 * said".
 */
/**
 * A file on a comment, as the record knows it exists (EO-324,
 * the original design: "outputs and attachments sync because they
 * are comments").
 *
 * Metadata only. The bytes travel on their own — see
 * `RecordAttachmentCommandSchema` going up and `record:attachment`
 * coming down — because a single attachment may be twenty megabytes and
 * a page of comments may carry dozens. Putting the file inside the
 * comment would make the ordinary case, a page of text, unsendable.
 *
 * So a replica learns that a file exists before it holds it, which is
 * the honest order: the thread says "Anna attached report.pdf" as soon
 * as the comment arrives, and the file follows.
 */
export const RecordAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
});
export type RecordAttachment = z.infer<typeof RecordAttachmentSchema>;

export const RecordCommentCommandSchema = z.object({
  kind: z.literal("comment"),
  id: z.string(),
  itemId: z.string(),
  /** The comment's own id, which is what makes the append idempotent. */
  commentId: z.string(),
  authorType: z.enum(["human", "agent", "engine", "module"]),
  authorId: z.string().nullable().default(null),
  runId: z.string().nullable().default(null),
  parentId: z.string().nullable().default(null),
  body: z.string(),
  kindOfComment: z.string().default("note"),
  // Read as a column is: a target this build does not know is dropped, so one
  // old option cannot cost the whole page a sender is trying to deliver.
  options: z.preprocess(parseStoredCommentOptions, z.array(CommentOptionSchema).nullable()),
  /**
   * Who this comment is asking, as the device resolved them (EO-324).
   *
   * Carried rather than re-derived, and that is the whole point of it
   * being here. A mention is not decoration: `@reviewer` is what
   * dispatches the reviewer, and an open `@user` is what puts a row in
   * somebody's inbox and `!` on the item. A record that re-parsed the
   * body would be resolving names against *its* agents rather than the
   * ones the person was looking at — and a mention added explicitly,
   * with no token in the body at all, would simply vanish.
   *
   * So the record stores what the device decided and parses nothing.
   *
   * A `human` mention carried no id at all until EO-325, because every
   * installation resolved it to the one person in front of it
   * (`LOCAL_PERSON_ID`) and that was what made an inbox row arrive on
   * the machine somebody was sitting at. It is exactly wrong once there
   * is a list of people: a question Anna asked would land in Dana's
   * inbox on Dana's desktop and in the record's own implicit person's
   * on the server, and Anna's second desktop — the one this story's
   * third acceptance criterion is about — would show her nothing.
   *
   * So the person travels where the sender knows one. Null is still the
   * honest answer on a solo desktop and for anything queued before this
   * field existed, and it still means "whoever is in front of you".
   */
  mentions: z
    .array(
      z.intersection(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("human"), personId: z.string().nullable().default(null) }),
          z.object({ type: z.literal("agent"), agentId: z.string() }),
        ]),
        /**
         * …and whether it is still waiting (EO-325, review).
         *
         * A mention travelled as a *target*, and the far side rebuilt
         * the row as open with nothing addressing it. On a comment
         * being posted for the first time that is simply true, which is
         * why it went unnoticed; on a *replica pulling a thread* it is
         * not, and an escalation somebody answered a fortnight ago came
         * back open in their inbox on their second desktop.
         *
         * Defaulted, so every caller that is posting something new goes
         * on saying nothing about it. `addressedBy` is dropped rather
         * than refused where the far side has not got that comment yet:
         * `comment_mentions.addressed_by` is a foreign key, and the
         * status is the half that decides the inbox.
         */
        z.object({
          status: z.string().default("open"),
          addressedBy: z.string().nullable().default(null),
        }),
      ),
    )
    .default([]),
  /** Whether it survives context truncation (ARCHITECTURE.md, "What an agent is given"). A person's pin travels with what they pinned. */
  pinned: z.boolean().default(false),
  /**
   * The files hanging off it, as metadata (ARCHITECTURE.md, "The record": attachments sync
   * because they are comments).
   *
   * Sent with the comment so the far side knows what to expect, and
   * filled in by the bytes that follow. Empty for the overwhelming
   * majority of comments, which is why this is a list on the comment
   * rather than the comment being a member of something larger.
   */
  attachments: z.array(RecordAttachmentSchema).default([]),
  createdAt: z.number(),
});

/**
 * A run, as the machine that ran it reports it.
 *
 * The record needs it for two reasons and neither is bookkeeping.
 * `run_events.run_id` is a foreign key, so events with no run cannot
 * land at all; and the record is the only scheduler, so "one dispatch
 * at a time" is a question it answers by looking at the runs it knows
 * about. A run nobody told it about is a slot it would hand out twice.
 *
 * Upserted rather than inserted: a run is reported when it starts and
 * again when it ends, and the second report is the one that carries
 * what happened.
 *
 * What is deliberately left behind is everything true only of the
 * machine it ran on — the provider session id, the working directory,
 * the process id, the hashes of the instructions and tool surface it
 * was born with. None of those mean anything on another machine, and a
 * record holding a `cwd` from somebody's laptop would be storing a path
 * that resolves nowhere.
 */
export const RecordRunCommandSchema = z.object({
  kind: z.literal("run"),
  id: z.string(),
  runId: z.string(),
  itemId: z.string(),
  agentId: z.string().nullable().default(null),
  stepId: z.string().nullable().default(null),
  action: z.string(),
  status: z.string(),
  startedAt: z.number().nullable().default(null),
  endedAt: z.number().nullable().default(null),
  error: z.string().nullable().default(null),
  /**
   * What the run actually produced (EO-324, the story's second
   * acceptance criterion: *"its result reaches the server"*).
   *
   * The structured output an agent answered with, and the whole point
   * of a run having happened. A status says a run ended; this says what
   * it ended *with* — the plan, the verdict, the summary the next step
   * reads — and a record that kept the first and dropped the second
   * would hold a history of things having occurred and no account of
   * any of them.
   *
   * `unknown`, because the shape is the pack's and the registry
   * validates it at the step that declared it. The record stores what
   * it was given; it is not the place that decides what a result may
   * be.
   */
  result: z.unknown().nullable().default(null),
  /** What the workspace kind checked when the run ended, and how each came out (EO-312). */
  checks: z.unknown().nullable().default(null),
  /** The evidence one of those checks carried — which step failed, and what it printed (G-02). */
  verification: z.unknown().nullable().default(null),
  /**
   * What the run spent.
   *
   * Carried because the record is the only scheduler, and a budget is
   * something it enforces: `sumCostCentsSince` is what stands between
   * an installation and a surprise (EO-211), and a record that saw
   * every dispatch and none of their costs would be enforcing a ceiling
   * against a number that was always zero.
   */
  tokensIn: z.number().nullable().default(null),
  tokensOut: z.number().nullable().default(null),
  cacheReadTokens: z.number().nullable().default(null),
  cacheWriteTokens: z.number().nullable().default(null),
  turns: z.number().nullable().default(null),
  turnsScope: z.string().nullable().default(null),
  costCents: z.number().nullable().default(null),
  /**
   * Which attempt at which initiation this run is.
   *
   * The record's scheduler counts attempts before it will dispatch
   * again, so a device that reported a failed run without saying which
   * attempt it was would have the record offer the same work for ever.
   */
  attempt: z.number().int().positive().default(1),
  initiationId: z.string().nullable().default(null),
  /**
   * What cut the run short without it failing (`RunInterruption`).
   *
   * Carried for `attempt`'s reason: the record's own count of attempts
   * leaves interrupted runs out, and one that never heard why a run
   * stopped would count it.
   */
  interruption: z.enum(["quit", "restart", "sleep"]).nullable().default(null),
  /** Somebody ran this to watch it work rather than because an item reached a step (KAN-106). */
  dryRun: z.boolean().default(false),
  /**
   * When the row last changed, on the machine that changed it.
   *
   * Carried so a replica keeps the record's stamp rather than taking
   * its own on arrival — which would have every machine re-send every
   * run to every other as though it had just happened, for ever.
   *
   * Zero from a device sending a run *up*: the record stamps what it
   * writes, because on the way up it is the record's clock that the
   * other devices will page on.
   */
  updatedAt: z.number().default(0),
});

/** One line of the durability substrate, with the sequence it was written at. */
export const RecordRunEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.number(),
  type: z.string(),
  payload: z.unknown(),
});
export type RecordRunEvent = z.infer<typeof RecordRunEventSchema>;

/**
 * Run events, appended by `(runId, seq)` with the device as author
 * (invariant #3).
 *
 * The pair is the primary key on both sides, which is what makes this
 * safe to send twice and what makes "every run event in order" a fact
 * rather than a hope: the device allocates `seq` as it writes, the
 * record stores what it is given, and a replay of a batch that half
 * landed appends only the half that did not.
 *
 * Batched because a chatty agent produces thousands of these and a
 * request per line would be a request per line.
 */
export const RecordRunEventsCommandSchema = z.object({
  kind: z.literal("runEvents"),
  id: z.string(),
  runId: z.string(),
  itemId: z.string(),
  events: z.array(RecordRunEventSchema).max(1000),
});

/**
 * One file, with its bytes (EO-324, ARCHITECTURE.md, "The record").
 *
 * Its own command rather than a field on the comment, for one reason
 * that decides it: size. The contract's request limit is a little over
 * an attachment's own maximum, so a file fills a request by itself —
 * and a batch of two hundred commands, which is the ordinary shape of a
 * replayed queue, could not carry even one. The drain sends these
 * alone.
 *
 * `dataBase64` is empty in the queue and filled at the moment of
 * sending. The bytes are already on this machine, in the attachment
 * store; copying them into a queue row would double every file a
 * desktop holds while it is offline, which is precisely when disk is
 * the thing not to waste. A file deleted before the queue drains is
 * simply dropped, which is the right answer to "send this thing that no
 * longer exists".
 */
export const RecordAttachmentCommandSchema = z.object({
  kind: z.literal("attachment"),
  id: z.string(),
  itemId: z.string(),
  /**
   * The comment it hangs off, or null for one of the item's own files
   * (EO-702) — part of what the item is, as its description is, rather
   * than something said on its thread.
   */
  commentId: z.string().nullable().default(null),
  attachmentId: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  /** Empty while queued; the drain fills it from this machine's store as it sends. */
  dataBase64: z.string().default(""),
});

/**
 * One of an item's own files, taken off it (EO-702).
 *
 * Its own command because an attachment is otherwise never removed on
 * one machine and told to another: a comment's files go with the
 * comment. An item file is part of the item's definition and a person
 * may take one away, so the record has to hear it and say so to every
 * replica — see `RecordChangesSchema.attachmentRemovals`. Idempotent: a
 * removal of a file the record no longer holds is applied as nothing.
 */
export const RecordAttachmentRemovalCommandSchema = z.object({
  kind: z.literal("attachmentRemoval"),
  id: z.string(),
  itemId: z.string(),
  attachmentId: z.string(),
  /**
   * What the file was, so a device whose removal the record refuses can
   * fetch it back by name — its own row and bytes are already gone.
   */
  name: z.string().default(""),
  mimeType: z.string().default(""),
});
export type RecordAttachmentRemovalCommand = z.infer<typeof RecordAttachmentRemovalCommandSchema>;

/**
 * Somebody pinned a comment, or took the pin off (EO-324).
 *
 * Its own command because it happens *after* the comment — a person
 * reads a thread and decides this is the bit that matters — and a
 * comment command replayed to carry it would be the same comment
 * arriving twice.
 *
 * Small, and load-bearing out of proportion to its size: a pin is what
 * survives context truncation (ARCHITECTURE.md, "What an agent is given"), so a pin that reached
 * one desktop
 * and not the record is an agent on another machine reading a thread
 * with the important part cut out of it.
 */
export const RecordPinCommandSchema = z.object({
  kind: z.literal("pin"),
  id: z.string(),
  itemId: z.string(),
  commentId: z.string(),
  pinned: z.boolean(),
});

/**
 * A mention stopped being open (EO-325).
 *
 * `RecordPinCommandSchema`'s twin, and separate for the same reason: a
 * comment is serialised when it is posted, and a mention is answered
 * or dismissed long after. Without this an escalation that went up to
 * the record before somebody replied to it stayed open there, and on
 * every other desktop that person signs in on, while the machine they
 * answered it on showed it closed.
 *
 * `addressedBy` names the comment that answered it, and may be a
 * comment the record has not been sent yet — the reply and this travel
 * as two commands, and nothing orders them. The record drops the
 * reference rather than the settlement when that happens: which
 * comment answered it is worth less than the fact that it is over.
 */
export const RecordMentionCommandSchema = z.object({
  kind: z.literal("mention"),
  id: z.string(),
  itemId: z.string(),
  commentId: z.string(),
  targetType: z.enum(["human", "agent"]),
  targetId: z.string().nullable(),
  status: z.string(),
  addressedBy: z.string().nullable(),
});

/**
 * Somebody taking an item (EO-367, the original design).
 *
 * "A claim is an assignee change plus a comment, not a transition" — so
 * this carries no step and the record writes none (invariant #1).
 *
 * **It names nobody**, and that is the whole of its shape. Who is
 * claiming is the person the device belongs to, resolved on the record
 * from the device the command arrived on (`identity/acting.ts`), never an
 * id in the payload: a claim whose payload could name somebody else is
 * an assignment, and `RecordAssignCommandSchema` is that.
 *
 * **The record arbitrates.** The first claim to reach it on an item
 * nobody holds wins. A claim on an item somebody else already holds is
 * dropped, and the answer names the holder (`RecordCommandResult.heldBy`)
 * so the device can tell the person who lost, and whom to talk to.
 *
 * `commentId` is the id of the sentence the record writes when it
 * applies the claim ("Claimed by Anna."). Minted by the device, for the
 * reason a transition's id is: a replay after a lost acknowledgement has
 * to be answerable as "already done", and the comment is the one row a
 * claim writes that has an identity of its own.
 */
export const RecordClaimCommandSchema = z.object({
  kind: z.literal("claim"),
  id: z.string(),
  itemId: z.string(),
  commentId: z.string(),
});

/**
 * Somebody handing an item to somebody (EO-367, ARCHITECTURE.md, "The board").
 *
 * The claim's twin, and different in the one way that matters: here the
 * payload *does* name a person, because choosing who is the whole act.
 * Who did the choosing is still the record's to resolve from the device,
 * and it is said in the thread ("Assigned to Dana by Anna.").
 *
 * Not arbitrated. Handing work to a colleague is a decision about the
 * item, like a move with no claim about where it was, and the record
 * applies it as it arrives.
 */
export const RecordAssignCommandSchema = z.object({
  kind: z.literal("assign"),
  id: z.string(),
  itemId: z.string(),
  personId: z.string(),
  commentId: z.string(),
});

/**
 * A group member taking an item from the person who holds it (EO-368).
 *
 * On a human step owned by a group only the holder may decide, so a
 * member who needs to act on somebody else's item is shown a warning
 * naming the holder and, once they confirm it, sends this. It is a claim
 * with one more fact in it: **who they were warned about**.
 *
 * `fromPersonId` is that fact, and it is a condition rather than an
 * instruction. The record applies the takeover only if that person still
 * holds the item; if it has changed hands since the warning, the takeover
 * is dropped and the sender is told who holds it now — so nobody ever
 * takes an item from somebody they were not warned about.
 *
 * Who is taking it is not in the payload, for the claim's reason: it is
 * the person the sending device belongs to, resolved on the record.
 */
/**
 * An item's watch on a step that keeps checking, as it travels (EO-456,
 * ARCHITECTURE.md, "A step", "The record").
 *
 * The whole row, because the row is the whole of the wait: when it
 * started, when it last checked and checks next, how many checks have
 * failed in a row, and which news it has already posted. On a record
 * every one of those is shared state. The record's scheduler holds the
 * item until `nextCheckAt` and gives up at `startedAt` plus the step's
 * hours; the next device to be leased the item carries on the same
 * watch — its clock, its failure streak and its posted news — rather
 * than starting one of its own.
 *
 * Keyed by the item and the step, which is the row's identity on both
 * sides; the row's own id is each database's and does not travel.
 * `updatedAt` is the record's stamp on the way down and zero on the way
 * up, for `RecordRunCommandSchema.updatedAt`'s reason.
 */
export const RecordWatchSchema = z.object({
  itemId: z.string(),
  stepId: z.string(),
  initiationId: z.string().nullable(),
  startedAt: z.number(),
  lastCheckedAt: z.number().nullable(),
  nextCheckAt: z.number(),
  checks: z.number().int().nonnegative(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  postedNewsIds: z.array(z.string()).max(10_000),
  updatedAt: z.number().default(0),
});
export type RecordWatch = z.infer<typeof RecordWatchSchema>;

/** A device saying where a watch it checked now stands (EO-456). An upsert by item and step. */
export const RecordWatchCommandSchema = RecordWatchSchema.extend({
  kind: z.literal("watch"),
  id: z.string(),
});

/**
 * A side call this device made about an item on the record (EO-514,
 * ARCHITECTURE.md, "Side calls", "Policy").
 *
 * A side call's spend is real spend, and a per-person budget is the
 * record's to compute: it sums its own `side_calls` rows by the person
 * who owns each one's project. A row that stayed on the desktop that
 * made it was spend that budget never saw. So the row travels, whole, as
 * the run it may have been made inside does — keyed by its own id, so a
 * replay after a lost acknowledgement writes nothing twice.
 *
 * No project in it: the record files the row under its own item's
 * project, which is the one its budgets read.
 */
export const RecordSideCallCommandSchema = z.object({
  kind: z.literal("sideCall"),
  id: z.string(),
  itemId: z.string(),
  sideCallId: z.string(),
  purpose: SideCallPurposeSchema,
  /** The run it was made inside, where it was — carried ahead of it in the same request, as a comment's is. */
  runId: z.string().nullable(),
  backend: z.string(),
  model: z.string().nullable(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  /** Millionths of a cent, unrounded (EO-510). */
  costMicrocents: z.number().int().nonnegative(),
  startedAt: z.number(),
  durationMs: z.number().nonnegative(),
  outcome: z.enum(["succeeded", "failed"]),
  reason: SideCallFailureReasonSchema.nullable(),
});
export type RecordSideCallCommand = z.infer<typeof RecordSideCallCommandSchema>;

export const RecordTakeoverCommandSchema = z.object({
  kind: z.literal("takeover"),
  id: z.string(),
  itemId: z.string(),
  commentId: z.string(),
  fromPersonId: z.string(),
});

/**
 * Somebody binding an item to another version of its own pipeline
 * (EO-567, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * Asked rather than done, like an assignment: the binding is item state
 * and the record owns item state, so the device writes nothing of its
 * own and the record decides. It judges the request again against its
 * own tables — the version by the number a person reads, the step the
 * item is on there, whether anything is running — and either writes
 * the binding and the comment, or refuses with the sentence the device
 * says on the item.
 *
 * `commentId` is minted by the device, for a claim's reason: a replay
 * after a lost acknowledgement has to be answerable as "already done",
 * and the comment is the one row this writes that has an identity of
 * its own. Who asked is the record's to resolve from the device.
 */
export const RecordRebindCommandSchema = z.object({
  kind: z.literal("rebind"),
  id: z.string(),
  itemId: z.string(),
  version: z.number().int().positive(),
  commentId: z.string(),
  /** The asker's own words, included in the comment. Empty adds nothing. */
  note: z.string().default(""),
});
export type RecordRebindCommand = z.infer<typeof RecordRebindCommandSchema>;

/**
 * A message EO on this device owes a person, about an item the record
 * holds (EO-729): a job's budget trip, found by the desktop that was about
 * to dispatch the job's item.
 *
 * Queued rather than sent, because the guard has already paused the job
 * and will not fire again: a record that cannot be reached at that moment
 * must not cost the person the message. The record writes it as it
 * writes any message about a project it holds (`sendMessageToAdmins`),
 * under `messageId`, which the device minted — so a replay after a lost
 * acknowledgement finds the message already written and writes nothing.
 */
export const RecordSendMessageCommandSchema = z.object({
  kind: z.literal("sendMessage"),
  id: z.string(),
  /** The item the guard stopped; the command is filed under it like every other. */
  itemId: z.string(),
  messageId: z.string(),
  message: MessageSendSchema,
});
export type RecordSendMessageCommand = z.infer<typeof RecordSendMessageCommandSchema>;

export const RecordCommandSchema = z.discriminatedUnion("kind", [
  RecordPinCommandSchema,
  RecordMentionCommandSchema,
  RecordAttachmentCommandSchema,
  RecordAttachmentRemovalCommandSchema,
  RecordTransitionCommandSchema,
  RecordCommentCommandSchema,
  RecordRunCommandSchema,
  RecordRunEventsCommandSchema,
  RecordClaimCommandSchema,
  RecordAssignCommandSchema,
  RecordTakeoverCommandSchema,
  RecordWatchCommandSchema,
  RecordSideCallCommandSchema,
  RecordRebindCommandSchema,
  RecordSendMessageCommandSchema,
]);
export type RecordCommand = z.infer<typeof RecordCommandSchema>;
export type RecordWatchCommand = z.infer<typeof RecordWatchCommandSchema>;
export type RecordCommandKind = RecordCommand["kind"];
export type RecordTransitionCommand = z.infer<typeof RecordTransitionCommandSchema>;
export type RecordCommentCommand = z.infer<typeof RecordCommentCommandSchema>;
export type RecordRunCommand = z.infer<typeof RecordRunCommandSchema>;
export type RecordRunEventsCommand = z.infer<typeof RecordRunEventsCommandSchema>;
export type RecordAttachmentCommand = z.infer<typeof RecordAttachmentCommandSchema>;
export type RecordPinCommand = z.infer<typeof RecordPinCommandSchema>;
export type RecordMentionCommand = z.infer<typeof RecordMentionCommandSchema>;
export type RecordClaimCommand = z.infer<typeof RecordClaimCommandSchema>;
export type RecordAssignCommand = z.infer<typeof RecordAssignCommandSchema>;
export type RecordTakeoverCommand = z.infer<typeof RecordTakeoverCommandSchema>;

/**
 * Why a person may not do something on a group-owned human step
 * (EO-368).
 *
 * Four answers, each with a different way forward, which is why they are
 * kept apart rather than flattened into a sentence on the record:
 *
 * - `notInGroup` — the step waits on a group and they are not in it.
 *   Somebody in that group has to act.
 * - `heldBy` — a member, but somebody else holds the item. Only the
 *   holder decides; the way forward is a takeover.
 * - `unclaimed` — nobody holds it, and a decision needs a holder. Claim
 *   it first.
 * - `stale` — a takeover warned about one holder, and the item has
 *   changed hands since. Look again.
 * - `notGroupStep` — a takeover of an item that is no longer on a step
 *   that waits on a group: it moved on while the takeover was waiting,
 *   and there is nothing there to take over. `groupName` is empty.
 */
export const StepRefusalReasonSchema = z.enum(["notInGroup", "heldBy", "unclaimed", "stale", "notGroupStep", "entryRules"]);
export type StepRefusalReason = z.infer<typeof StepRefusalReasonSchema>;

export const StepRefusalSchema = z.object({
  why: StepRefusalReasonSchema,
  /** The group the step waits on, by name, for "Project Atlas waits on Design". */
  groupName: z.string(),
  /** Who holds the item now, or null for nobody. */
  holder: z.object({ id: z.string(), name: z.string() }).nullable(),
  /**
   * Where the record has the item, so a desktop that showed a refused
   * move at once can put it back. Null where the item is on no step.
   */
  stepId: z.string().nullable(),
  /** The pipeline that step belongs to, for a refused move that crossed pipelines. */
  pipelineId: z.string().nullable(),
  /** What a pipeline's entry rules said (EO-610). Absent on every refusal about a group. */
  sentence: z.string().optional(),
});
export type StepRefusal = z.infer<typeof StepRefusalSchema>;
/**
 * What became of one command.
 *
 * Three outcomes, not two, and the third is the one this story is
 * about. `applied` is the ordinary answer. `problem` is a command the
 * record could not carry out — an item it has never heard of, a step
 * that is not on the pipeline — and it is dropped with its reason said
 * on the item. `superseded` is neither: the command was perfectly good
 * and the world moved, which is a thing the person who made it has to
 * be told in their own terms ("your move of SUP-31 was superseded by
 * Dana's") rather than as a failure.
 */
export const RecordCommandResultSchema = z.object({
  id: z.string(),
  applied: z.boolean(),
  /** Where the item actually is, when a transition was refused because it had moved. */
  superseded: z
    .object({
      /** The step the record has it on. */
      stepId: z.string(),
      /** Who put it there, in the record's own words — a person's name, an agent's, or "someone else". */
      by: z.string(),
    })
    .nullable()
    .default(null),
  /** Why it could not be carried out at all. Null on both of the above. */
  problem: z.string().nullable().default(null),
  /**
   * Who holds the item, when a claim was dropped because somebody else
   * already did (EO-367).
   *
   * A claim's `superseded`, and kept apart from it because the two are
   * answers about different things: a move is overtaken by *where* the
   * item went, a claim by *who* has it. The device says the name in the
   * thread and puts the holder back on its own copy of the item.
   */
  heldBy: z
    .object({
      personId: z.string(),
      /** Their name as the record has it, or "someone else" where it has none. */
      name: z.string(),
    })
    .nullable()
    .default(null),
  /**
   * Who the record has holding the item, when it refused a claim or an
   * assignment outright (EO-367, review).
   *
   * A device shows a claim or an assignment the moment it is made, and
   * that display has nothing behind it once the record says no. Unlike
   * a dropped claim there may be nothing newer for a pull to bring — the
   * record wrote nothing — so the answer carries the record's holder and
   * the device puts it back. `person: null` is "nobody holds it"; the
   * field itself null is "not said", which is every other refusal and
   * every record that predates it.
   */
  holder: z
    .object({
      person: z.object({ id: z.string(), name: z.string() }).nullable(),
    })
    .nullable()
    .default(null),
  /**
   * Why a person's claim, takeover, move or decision on a group-owned
   * human step was not applied (EO-368).
   *
   * Neither `superseded` nor `heldBy`: the command was not overtaken by
   * anything, it was something this person may not do on this step. The
   * device tells them so in their inbox, with the group or the holder
   * named, and puts back what it had shown — the record's holder from
   * `holder`, and the record's step from here. Null on every other
   * answer and from every record that predates it.
   */
  notPermitted: StepRefusalSchema.nullable().default(null),
});
export type RecordCommandResult = z.infer<typeof RecordCommandResultSchema>;

// ── Changes: the pull that keeps a replica honest ───────────────────

/**
 * An item as the record holds it, for a replica to mirror.
 *
 * The type travels as a *slug and a label* beside its id, because the
 * id is only meaningful in the installation that wrote it: `item_types`
 * rows are seeded per database, and a replica that inserted a foreign
 * id would have an item whose type nothing local can resolve. The
 * applier matches on the id when it has it and falls back to the slug,
 * which is the pair that is actually portable (`portability.ts` makes
 * the same trade for the same reason).
 */
/**
 * Where an item a module created came from, as it travels (EO-433).
 *
 * The `item_origins` row, minus the item's own id — it rides on the
 * item. It has to travel because it is what two guards read: a repeat
 * of an idempotency key answers with the item already made, and a run
 * on a generation 3 item cannot create. An item that changed hands
 * without it would be created again by the next run, and would count
 * as generation 0.
 *
 * `originItemId` is null where the originating item has been deleted;
 * the generation, the module and the run are still said.
 */
export const RecordItemOriginSchema = z.object({
  originItemId: z.string().nullable(),
  runId: z.string().nullable(),
  moduleId: z.string(),
  idempotencyKey: z.string(),
  generation: z.number().int().nonnegative(),
  createdAt: z.number(),
});
export type RecordItemOrigin = z.infer<typeof RecordItemOriginSchema>;

/**
 * What an item waits for and what waits for it, as the record holds
 * both (EO-434).
 *
 * An edge is two ids with no stamp of its own, so it has no cursor to
 * page on and travels with the items at its ends instead. Both
 * directions, because either end can be the one that is sent: a module
 * that makes its own item wait for the one it created changes nothing
 * about its own item's row, and it is the *new* item's arrival that has
 * to bring the edge. And the whole of each set rather than additions,
 * because that is the only way to say an edge has gone.
 *
 * Without this a desktop's board counts no open dependency on a project
 * an organisation holds, and the item page lists nothing it waits for:
 * both read the replica's `item_deps`, which nothing filled.
 */
export const RecordItemWaitsSchema = z.object({
  dependsOn: z.array(z.string()),
  blocks: z.array(z.string()),
});
export type RecordItemWaits = z.infer<typeof RecordItemWaitsSchema>;

export const RecordItemSchema = z.object({
  id: z.string(),
  key: z.string(),
  typeId: z.string(),
  typeSlug: z.string(),
  parentId: z.string().nullable(),
  projectId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  title: z.string(),
  body: z.string().nullable(),
  pipelineId: z.string().nullable(),
  stepId: z.string().nullable(),
  priority: z.number(),
  archivedAt: z.number().nullable(),
  heldAt: z.number().nullable(),
  previewAt: z.number().nullable(),
  /**
   * The trial mark (EO-582, ARCHITECTURE.md, "Trial pipelines"). Carried
   * wherever the item travels, so a trial item never arrives as live
   * work: on the far side it is still off the board, out of the inbox
   * and the archive, and its spend is still reported apart. Defaulted, so
   * a page from a build that predates it reads as live work, which is
   * what every item it could send was.
   */
  trialAt: z.number().nullable().default(null),
  assigneeId: z.string().nullable(),
  /**
   * Who that is, by name (EO-367).
   *
   * Carried because a replica cannot point `items.assignee_id` at a
   * person it has no row for, and nothing else brings the organisation's
   * people down: a desktop whose colleague claimed an item would hold
   * the claim as nobody, and the card would read Unclaimed on every
   * machine but the record. With the name the replica writes the row it
   * needs, under the record's own id, the way picking a colleague as a
   * step's owner already does. Defaulted, so a page from a build that
   * predates it reads as "not told".
   */
  assigneeName: z.string().nullable().default(null),
  /**
   * The version of its pipeline this item entered on, and finishes on
   * (EO-327 ARCHITECTURE.md, "Publish, lock and versions", carried here by EO-329).
   *
   * Not "where it sits" — that is `stepId`, which invariant #1 gives one
   * writer — but *which graph it is being routed by*, which is a fact
   * about the item like its type. Without it on the wire a replica's
   * copy is bound to nothing, `boundGraphForItem` falls through to the
   * live rows, and an item mid-flight finishes under whatever the
   * organisation published this morning. Defaulted, so a page from a
   * build that predates it reads as "not told" rather than as "bound to
   * nothing".
   */
  pipelineVersionId: z.string().nullable().default(null),
  /**
   * What made it, where a module did (EO-433). Null for an item no
   * module created, and defaulted so a page from a build that predates
   * it reads as that.
   */
  origin: RecordItemOriginSchema.nullable().default(null),
  /**
   * Its dependency edges (EO-434). Null is "not told" — a page from a
   * build that predates it, or a sender that is not the record — and a
   * replica leaves its edges alone; two empty lists is "none".
   */
  waits: RecordItemWaitsSchema.nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type RecordItem = z.infer<typeof RecordItemSchema>;

/** A move the record applied, as the audit row it wrote for it. */
export const RecordTransitionSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  fromStepId: z.string().nullable(),
  toStepId: z.string(),
  actor: z.string(),
  reason: z.string().nullable(),
  ts: z.number(),
});
export type RecordTransitionView = z.infer<typeof RecordTransitionSchema>;

/**
 * An item type the project's items are filed under.
 *
 * Carried with its id, because `items.type_id` is a foreign key and the
 * items travel with theirs. `item_types` rows are per project as well as
 * per installation — attaching a workspace copies the installation's
 * types into the new project — so the record would otherwise have two
 * rows slugged `story` and no way to choose between them for an item
 * whose own type id it had never seen.
 */
export const RecordItemTypeSchema = z.object({
  id: z.string(),
  /**
   * Which project's scope it is in, or null for the installation's.
   *
   * On an adopt page this is the project being moved and could have
   * been implied. On the way *down* it cannot be: `record:changes`
   * carries every type the record holds, and a replica writing one into
   * the wrong scope would give a project a second row slugged `story` —
   * which `resolveItemType` refuses to choose between, so every item of
   * that type stops resolving at all.
   */
  projectId: z.string().nullable().default(null),
  slug: z.string(),
  packSlug: z.string(),
  label: z.string(),
  plural: z.string(),
  container: z.boolean().default(false),
  specShape: z.unknown().default([]),
  actionOverrides: z.unknown().default({}),
  createdAt: z.number(),
});
export type RecordItemType = z.infer<typeof RecordItemTypeSchema>;

/**
 * A project as the record holds it (EO-325,
 * `ARCHITECTURE.md`, "The record",
 * "What a person sees first").
 *
 * Five columns and the one the story adds: whose it is. "The server
 * assigning nothing new except the record's ownership" is the whole
 * shape of a move, so the id, the name, the key prefix and both
 * timestamps travel exactly as they stand on the machine that had it.
 *
 * `keyPrefix` is the one field that can refuse to land. It is unique
 * and it numbers the item keys, so a replica that already has that
 * prefix under another id leaves the project out rather than
 * renumbering somebody's counter — see `upsertReplicaProject`.
 *
 * Deliberately not the workspaces. A workspace is a path on somebody's
 * disk, and the design is explicit that the server never needs one: a record
 * holding a checkout directory from a laptop would be storing a path
 * that resolves nowhere. They stay where they are, and the step that
 * names one resolves it on the machine the run happens on.
 */
export const RecordProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  /** Whose it is on the record — the person who moved it. Null on a project the record never owned. */
  ownerId: z.string().nullable().default(null),
  /** When the record took it. Null only on a project that has not been moved. */
  managedAt: z.number().nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type RecordProject = z.infer<typeof RecordProjectSchema>;

/**
 * A pipeline with its steps and its routes, as one thing (EO-325).
 *
 * One thing rather than three lists, because the graph is one thing:
 * `pipeline_steps` and `step_routes` carry no timestamps of their own,
 * so there is nothing to page them by, and a route that arrived without
 * the step it leaves is a branch to nowhere. The whole graph travels
 * with the pipeline's own `updated_at`, and a replica writes it
 * wholesale.
 *
 * The ids are kept. That is the same promise the move makes about
 * everything else — nothing is assigned anew — and here it is
 * load-bearing rather than tidy: `items.step_id`, `pipelines.entry_step_id`
 * and `step_routes.target` all name steps by id, so a graph renumbered
 * in transit would arrive with every item on it pointing at nothing.
 */
export const RecordPipelineSchema = PipelineViewSchema.extend({
  previewItem: z.unknown().nullable().default(null),
  updatedAt: z.number().default(0),
  /**
   * What makes this pipeline a trial, and what of (EO-582, ARCHITECTURE.md,
   * "Trial pipelines"): when it was made, the conversation it came from,
   * and the pipeline its draft would replace or null. Null on every
   * pipeline that is not a trial, and on a page from a build that
   * predates the field. Carried so a trial that travels — with a project
   * moved to the record, or down to a replica — stays hidden there and
   * can still be discarded as one.
   */
  trial: z
    .object({
      at: z.number(),
      conversationId: z.string(),
      targetPipelineId: z.string().nullable(),
      /**
       * The trial's plan (EO-584): how each step runs on its test items.
       * Carried so whichever machine runs a trial item mocks and
       * redirects what the plan says. Null — every step real — on a
       * trial nobody planned and on a page from a build that predates it.
       */
      plan: TrialPlanSchema.nullable().default(null),
      /**
       * Which live step each trial step was copied from (EO-584), so a
       * real step reads the step's own values wherever it runs. Empty on
       * a page from a build that predates it.
       */
      stepSources: TrialStepSourcesSchema.default({}),
    })
    .nullable()
    .default(null),
  /**
   * Whether this pipeline may send what a webhook delivers without a
   * person reading it first (EO-405).
   *
   * Travels between a record and its replicas, and nowhere else. On a
   * managed desktop the setting is the administrator's and the board
   * still has to say what they chose, so the row carries it; a pipeline
   * *export* does not (`PipelineExportSchema` has no such field), because
   * a file from elsewhere must not arrive with the risk already accepted.
   *
   * Defaulted off, so a record or a desktop from before the setting
   * reads as the refusal standing.
   */
  webhookUnattended: z.boolean().default(false),
  /**
   * What an item must have to enter (EO-610). Carried so a device refuses
   * what the record would, before it shows a move the record then takes
   * back. Empty on a page from a build that predates them.
   */
  entryRules: EntryRulesSchema.default([]),
  /**
   * Which version the record has this pipeline on, and the documents
   * behind the versions a replica could need (EO-329, EO-327 ARCHITECTURE.md, "Publish, lock and
   * versions").
   *
   * Without these a device cannot keep the promise EO-327 makes. An
   * item binds to the version it entered on and finishes there, and
   * `boundGraphForItem` resolves that by reading the `pipeline_versions`
   * row the item names — a row a replica did not have. So a desktop
   * holding a v2 item, after the organisation rolled its pipeline back
   * to v1, fell through to the live graph and routed the item by v1:
   * exactly the strand the version model exists to prevent, arrived at
   * from the far end of a sync.
   *
   * Not every version: the current one, and any older one a live item is
   * still standing in. That is the whole set a replica can ask about,
   * and it keeps a pipeline with a hundred saves behind it from sending
   * a hundred documents on every page.
   */
  currentVersionId: z.string().nullable().default(null),
  /**
   * The template this pipeline was made from, with its stored base and
   * step map (EO-531, EO-532, ARCHITECTURE.md, "Template versions and
   * origins").
   *
   * Carried so a pipeline moved to the record keeps its origin there:
   * the record is where a pipeline it holds is compared with a newer
   * template version, and a pipeline whose ids an import re-minted
   * cannot be matched to its template again by step id. `base` is the
   * whole template document, read through `PipelineExportSchema` by the
   * side that writes it. Null on a pipeline with no origin, and on a
   * page from a build that predates the field.
   */
  origin: z
    .object({
      slug: z.string().min(1),
      version: z.string().min(1),
      base: z.unknown(),
      stepIds: z.record(z.string(), z.string()),
      /** When the base last moved (EO-534), which the pipeline's versions — travelling with it — are counted from. */
      baseMovedAt: z.number().nullable().default(null),
      /**
       * The template update EO last applied to it (EO-536): the template
       * version it took, the pipeline version it was filed as, and when.
       * Carried so the record — which answers a moved pipeline's head —
       * still says "Updated to" for the days after, even where the
       * version the update filed has since been pruned and travels with
       * nothing. Null where no update was ever applied, and on a page
       * from a build that predates the field.
       */
      applied: z
        .object({ version: z.string().min(1), pipelineVersion: z.number().int().positive(), at: z.number() })
        .nullable()
        .default(null),
    })
    .nullable()
    .default(null),
  versions: z
    .array(
      z.object({
        id: z.string(),
        number: z.number().int().positive(),
        steps: z.unknown(),
        routes: z.unknown(),
        entryStepId: z.string().nullable().default(null),
        entryRules: EntryRulesSchema.default([]),
        createdAt: z.number(),
        createdBy: z.string().nullable().default(null),
      }),
    )
    .default([]),
  steps: z
    .array(
      PipelineStepViewSchema.extend({
        /** Kept off the board while it runs (ARCHITECTURE.md, "The board"). Not on the view schema, because a screen draws the board. */
        offBoard: z.boolean().default(false),
        /** Who waits here, where a human step names somebody (EO-323, ARCHITECTURE.md, "Identity"). */
        ownerPersonId: z.string().nullable().default(null),
        ownerGroupId: z.string().nullable().default(null),
      }),
    )
    .default([]),
  routes: z.array(StepRouteViewSchema).default([]),
});
export type RecordPipeline = z.infer<typeof RecordPipelineSchema>;

/**
 * One of a project's own agents, as it travels with the project
 * (EO-476, ARCHITECTURE.md, "The record").
 *
 * A project-scoped agent belongs to its project the way the project's
 * pipelines do, so it goes where the project goes: up with the move
 * (`RecordAdoptPageSchema.agents`), and down to every replica on the
 * sync's own list (`RecordChangesSchema.agents`), paged on the row's
 * own `updatedAt` as a pipeline is. A global agent is not this: it is
 * the installation's, and an organisation hands it out by publishing
 * the agents section.
 *
 * The published agent's shape, because it is the same fact — role,
 * prompt and tool surface, with the backend and model only a
 * *recommendation* for a machine meeting the agent for the first time
 * (ARCHITECTURE.md, "Publish, lock and versions"). What it adds is the
 * project it works for, which a replica holds it to, and the stamp it
 * pages on.
 *
 * The ids are the sender's and are kept: `runs.agent_id`, a comment's
 * author and a mention's target all name an agent by id, and the move
 * sends the agents before the runs that name them.
 */
export const RecordAgentSchema = PublishedAgentSchema.extend({
  projectId: z.string(),
  updatedAt: z.number().default(0),
  /**
   * What the sender calls each server and skill the agent is attached
   * to, by id (EO-513). A move carries only the project's own skills, so
   * a record can be handed an agent attached to a global skill, or to
   * another project's, that it has never held — and then the comment it
   * owes the project's thread has to be able to say which one by name.
   * Absent from a sender that predates it, when the comment names the id.
   */
  toolNames: z.record(z.string(), z.string()).optional(),
});
export type RecordAgent = z.infer<typeof RecordAgentSchema>;

/**
 * One of a project's own skills, as it travels with the project
 * (EO-513, ARCHITECTURE.md, "Skills", "The record").
 *
 * A skill scoped to a project, or to one of its workspaces, belongs to
 * the project the way its agents do, so it goes where the project goes:
 * up with the move (`RecordAdoptPageSchema.skills`), and down to every
 * replica on the sync's own list (`RecordChangesSchema.skills`), paged on
 * the row's own `updatedAt`. A global skill is not this: it is the
 * installation's, and an organisation hands it out by publishing the
 * packs section.
 *
 * The catalogue's shape, with the project it belongs to beside it — a
 * workspace never travels, so a record holding a workspace's skill has
 * no workspace row to ask whose it is, and the skill says so itself, as
 * a workspace's memory does (`RecordMemorySchema.projectId`). The id is
 * the sender's and is kept: `agent_skills` names a skill by id.
 */
export const RecordSkillSchema = SkillSchema.extend({ projectId: z.string() });
export type RecordSkill = z.infer<typeof RecordSkillSchema>;

/**
 * How far a device has read one of the record's lists.
 *
 * A timestamp **and** an id, and the id is the whole of why this is a
 * shape rather than a number. Several rows share a millisecond
 * routinely — an import, a burst of comments from one run, a pipeline
 * moving three items on one tick — so a cursor that was only a
 * timestamp could not tell "I have read up to here" from "I have read
 * everything at this instant". Both readings are wrong in their own
 * way: re-reading from the timestamp returns the same page forever, and
 * reading from after it skips whatever shared the millisecond with the
 * last row sent.
 *
 * So each list is ordered by `(ts, id)` and asked for strictly after
 * the pair, which is exact: nothing is sent twice and nothing is
 * skipped, however many rows share an instant. `{ ts: 0, id: "" }` is
 * the beginning, which is where a device that has never read starts.
 */
export const RecordCursorSchema = z.object({
  ts: z.number().nonnegative().default(0),
  /** The last id read at that instant. Empty means "before anything at it". */
  id: z.string().default(""),
});
export type RecordCursor = z.infer<typeof RecordCursorSchema>;

/**
 * Where a device has read up to in the transcripts (EO-324).
 *
 * Three parts rather than two, and the third is not decoration. A run
 * event has no id of its own — it is identified by `(runId, seq)` — and
 * `seq` is a *number*. Folding it into the string id of a
 * `RecordCursor` was a bug with a long fuse: the page is ordered by
 * `seq` numerically and the predicate compared `"…:10" > "…:9"`, which
 * is false. A page ending at sequence 9 inside one millisecond
 * therefore skipped everything from 10 to 19 of that run, permanently,
 * and only ever on a run chatty enough to write ten lines in a
 * millisecond — which is every run that matters.
 *
 * So the cursor carries the sequence as what it is, and the predicate
 * below and the `ORDER BY` above it compare the same three things in
 * the same way. That is the whole requirement of a keyset cursor and
 * the one thing it is easy to get subtly wrong.
 */
export const RecordEventCursorSchema = z.object({
  /** The last event's place in the record's feed, which for a line that came from a device is when it arrived, not when it was written (EO-618). */
  ts: z.number().nonnegative().default(0),
  /** The run the last event read belonged to. Empty means "before anything at this instant". */
  runId: z.string().default(""),
  /** Its sequence within that run. `-1`, because sequences start at zero. */
  seq: z.number().int().default(-1),
});
export type RecordEventCursor = z.infer<typeof RecordEventCursorSchema>;

/** The beginning of the transcripts: a device that has read none of them. */
export const EMPTY_EVENT_CURSOR: RecordEventCursor = { ts: 0, runId: "", seq: -1 };

/** The beginning: a device that has read nothing of a list yet. */
export const EMPTY_CURSOR: RecordCursor = { ts: 0, id: "" };

/**
 * Where a device has read up to, in each of the three lists.
 *
 * Three rather than one, because the lists are paged independently: a
 * backlog of ten thousand comments must not hold up the items, and a
 * shared cursor would make each list's progress depend on the others'.
 * That was the bug the pair above already fixes half of — one cursor
 * over three lists steps past whichever of them was cut short.
 */
export const RecordCursorsSchema = z.object({
  items: RecordCursorSchema.default({ ts: 0, id: "" }),
  transitions: RecordCursorSchema.default({ ts: 0, id: "" }),
  comments: RecordCursorSchema.default({ ts: 0, id: "" }),
  /**
   * Runs, which change for as long as they last — queued, running,
   * parked, finished.
   *
   * Paged on `updated_at` rather than on when the run started, because
   * what a second desktop is waiting to hear is not that a run exists
   * but what it has become.
   */
  runs: RecordCursorSchema.default({ ts: 0, id: "" }),
  /**
   * The transcripts those runs produced, by `(ts, runId, seq)`.
   *
   * Its own shape, because a run event is identified by a run and a
   * *number* — see `RecordEventCursorSchema` for the page this got
   * wrong and how. Its `ts` is the event's own, so a device that has
   * read up to a moment reads on from there across every run at once.
   */
  runEvents: RecordEventCursorSchema.default({ ts: 0, runId: "", seq: -1 }),
  /**
   * Files, which arrive a moment after the comment that announced them.
   *
   * Its own cursor because the gap between the two writes is a real
   * interval, and a device that pulled inside it saw the comment,
   * stepped past it, and would never have looked again — a comment is
   * immutable and is never paged twice.
   */
  attachments: RecordCursorSchema.default({ ts: 0, id: "" }),
  /**
   * Item files somebody removed (EO-702), paged on when the record took
   * the removal. A removed row is gone, so nothing in `attachments` can
   * say so; this is the list that does.
   */
  attachmentRemovals: RecordCursorSchema.default({ ts: 0, id: "" }),
  /**
   * The projects the record holds (EO-325).
   *
   * New here because a project stopped being a purely local idea: one
   * moved to the record has to reach the person's *other* desktop, or
   * its items arrive there belonging to nothing and the board — which
   * is drawn per project — does not show them at all.
   */
  projects: RecordCursorSchema.default({ ts: 0, id: "" }),
  /**
   * The item types those projects file work under (EO-325).
   *
   * For the reason the projects themselves are here, one level down.
   * A moved project brings its own `item_types` rows — a support pack's
   * `case`, a type somebody added in the design's editor — and the second
   * desktop had no way to learn about them: it *invented* its own
   * copies of whatever that installation happened to have, so an item
   * filed under a custom type was skipped for want of one, and an item
   * whose type shared a slug with a local one was quietly filed under
   * the local one's label and spec shape instead.
   *
   * Paged on `created_at` and the id. A type's row carries no
   * `updated_at`, so an edited one does not page again — which is
   * honest about what this is: the arrival of a type, not the
   * publishing of one. Publishing configuration to an organisation is
   * 7c's (KAN-122).
   */
  itemTypes: RecordCursorSchema.default({ ts: 0, id: "" }),
  /**
   * The pipelines those projects' items sit on, with their steps and
   * routes (EO-325).
   *
   * For the reason above, one step further. `upsertReplicaItem`
   * *skips* an item whose step this machine cannot resolve — a card
   * drawn in no column is worse than no card — so a project moved to
   * the record would arrive on the second desktop as nothing at all
   * unless the graph its items stand on arrives first.
   *
   * Paged on the pipeline's `updated_at`, which is the only timestamp
   * in the graph: `pipeline_steps` and `step_routes` carry none, so
   * they travel with the pipeline they belong to rather than on
   * cursors of their own. Publishing a graph *to* an organisation, with
   * the locks and the "managed by your organisation" line that come
   * with it, is 7c's (KAN-122); this is only the record holding what it
   * was given, so that a replica can draw it.
   */
  pipelines: RecordCursorSchema.default({ ts: 0, id: "" }),
  /**
   * Those projects' own agents (EO-476), paged on the agent row's
   * `updated_at` for the pipelines' reason: a project's agents are part
   * of what the project is, and they travel with it.
   */
  agents: RecordCursorSchema.default({ ts: 0, id: "" }),
  /**
   * What the organisation has published, and so what is locked here
   * (EO-329, ARCHITECTURE.md, "Publish, lock and versions").
   *
   * Paged on `published_at`, which is the row's only timestamp and is
   * the right one: a rollback re-publishes, and what a device has to
   * learn is that the section was published *again*, pointing at an
   * older version. The id is `section:subjectId`, which is the row's
   * primary key — a section publishes one row, and the pipelines
   * section one per pipeline.
   */
  publishedSections: RecordCursorSchema.default({ ts: 0, id: "" }),
  /**
   * Pins, which are the one thing about a comment that changes after it
   * is written.
   *
   * A list of its own because the comment feed pages on when a comment
   * was *said* and never revisits a row — right for a body, which
   * nobody edits, and wrong for the pin, which somebody adds days
   * later while reading the thread back.
   */
  pins: RecordCursorSchema.default({ ts: 0, id: "" }),
  /**
   * Mentions that stopped being open (EO-325).
   *
   * The pin's twin, and separate from it because the two move at
   * different rates: a pin is rare and deliberate, an inbox empties all
   * day. Keyed on the *comment* rather than a mention's own id, which
   * it does not have — a mention is a comment and a target, and a
   * comment's mentions all settle in the same statement, so the page
   * boundary can only ever fall between comments.
   */
  mentions: RecordCursorSchema.default({ ts: 0, id: "" }),
  /**
   * Watches on steps that keep checking (EO-456), paged on when the
   * record last changed the row. A watch changes on every check, so it
   * pages again each time — which is the point: the next device to check
   * has to read the latest one.
   */
  watches: RecordCursorSchema.default({ ts: 0, id: "" }),
  /**
   * Memory entries (EO-482), paged on when the record last changed the
   * row. An entry changes after it is written — retired, restored — and
   * a replica has to hear each time, or it goes on delivering what a
   * person took out of use.
   */
  memories: RecordCursorSchema.default({ ts: 0, id: "" }),
  /**
   * Those projects' own skills, and their workspaces' (EO-513), paged on
   * when the record last changed the row, as their agents are.
   */
  skills: RecordCursorSchema.default({ ts: 0, id: "" }),
});
export type RecordCursors = z.infer<typeof RecordCursorsSchema>;

/**
 * Everything the record has that this device has not seen.
 *
 * `cursors` comes back as where each list now stands, which the device
 * keeps and sends next time. `more` says at least one of them filled
 * its page; the caller loops on it rather than assuming one page is the
 * world, because a desktop that has been shut for a week is exactly the
 * case where it is not.
 */
export const RecordChangesSchema = z.object({
  items: z.array(RecordItemSchema),
  transitions: z.array(RecordTransitionSchema),
  comments: z.array(RecordCommentCommandSchema),
  /**
   * Runs the record knows about, as they now stand (ARCHITECTURE.md, "Identity").
   *
   * The same shape a device sends *up*, because it is the same fact
   * travelling the other way — a run row is a run row, and a second
   * schema for the downhill journey would be two accounts of one thing.
   *
   * Without these a second desktop draws an idle board while an agent
   * is working elsewhere: the board reads the latest run's status out
   * of the local `runs` table, and a machine that never receives
   * another device's runs has nothing there to read.
   */
  runs: z.array(RecordRunCommandSchema).default([]),
  /**
   * The lines those runs wrote, in order (invariant #3).
   *
   * Carried with the run they belong to, because `run_events` is keyed
   * on `(runId, seq)` and a batch that did not say which run would be a
   * transcript belonging to nothing. `deviceId` is the author the
   * record recorded — which machine the work actually happened on.
   */
  runEvents: z
    .array(
      z.object({
        runId: z.string(),
        deviceId: z.string().nullable(),
        events: z.array(RecordRunEventSchema),
      }),
    )
    .default([]),
  /**
   * Files the record has taken since the cursor, with the comment each
   * hangs off.
   *
   * Metadata; the bytes are fetched one at a time on
   * `record:attachment`. This is how a device learns a file exists at
   * all when it pulled the comment before the file had landed.
   */
  attachments: z
    .array(RecordAttachmentSchema.extend({ itemId: z.string(), commentId: z.string().nullable(), createdAt: z.number() }))
    .default([]),
  /**
   * Item files removed since the cursor (EO-702): each replica deletes
   * its row and its bytes, and forgets a fetch it had not finished.
   */
  attachmentRemovals: z.array(z.object({ attachmentId: z.string(), itemId: z.string(), ts: z.number() })).default([]),
  /** Pins added or taken off since the cursor — see `RecordCursorsSchema.pins`. */
  pins: z.array(z.object({ commentId: z.string(), itemId: z.string(), pinned: z.boolean(), ts: z.number() })).default([]),
  /**
   * Mentions answered or dismissed since the cursor (EO-325).
   *
   * What makes an inbox the same on both of a person's desktops. The
   * one that answered it queued a `mention` command up; this is how the
   * other one hears about it, and how a machine that was switched off
   * at the time hears about it when it comes back.
   */
  mentions: z
    .array(
      z.object({
        commentId: z.string(),
        itemId: z.string(),
        targetType: z.enum(["human", "agent"]),
        targetId: z.string().nullable(),
        status: z.string(),
        addressedBy: z.string().nullable(),
        ts: z.number(),
      }),
    )
    .default([]),
  /**
   * Watches the record has changed since the cursor (EO-456): where each
   * item standing on a step that keeps checking has got to, so the next
   * device leased it carries on the same watch.
   */
  watches: z.array(RecordWatchSchema).default([]),
  /** The projects the record holds, so a replica can draw a board per project (EO-325). */
  projects: z.array(RecordProjectSchema).default([]),
  /** …and the types their work is filed under, with the ids the record holds them by. */
  itemTypes: z.array(RecordItemTypeSchema).default([]),
  /** …and the graphs their items stand on, with the steps and routes inside them. */
  pipelines: z.array(RecordPipelineSchema).default([]),
  /**
   * …and their own agents (EO-476). Written on a replica under the
   * pipelines' rule: over what is here where the organisation has
   * published the agents section, and only where missing where it has
   * not — see `upsertReplicaProjectAgent`.
   */
  agents: z.array(RecordAgentSchema).default([]),
  /**
   * What the organisation has published, which is what a desktop draws
   * its locks from (EO-329, ARCHITECTURE.md, "Publish, lock and versions").
   *
   * A device stores these as read-only rows marked with the version and
   * writes none of its own: the row is the record's statement that this
   * section is managed, and a replica that could author one would be a
   * desktop locking itself.
   */
  publishedSections: z.array(PublishedSectionSchema).default([]),
  /**
   * The memory of the projects the record holds, and of their
   * workspaces (EO-482): every entry written or changed since the
   * cursor, retired ones included, so a replica delivers what the
   * organisation's record holds and nothing it has retired.
   */
  memories: z.array(RecordMemorySchema).default([]),
  /**
   * The skills of the projects the record holds, and of their
   * workspaces (EO-513): every one written or changed since the cursor,
   * archived ones included, so a project's own agents are attached on a
   * replica to the skills they were attached to on the desktop that
   * moved the project.
   */
  skills: z.array(RecordSkillSchema).default([]),
  /** What to send next time. */
  cursors: RecordCursorsSchema,
  more: z.boolean(),
});
export type RecordChanges = z.infer<typeof RecordChangesSchema>;

// ── What the person sees of all this ────────────────────────────────

/**
 * This machine's link to its record (ARCHITECTURE.md, "The record").
 *
 * A machine fact, which is why it is on the machine half of the
 * contract: a server *is* the record and has no link to one, and the
 * browser an admin opens it in must not be offered a line about being
 * offline from itself.
 *
 * `solo` is a desktop that has never signed in to anything — no line,
 * no queue, nothing to say. `online` and `offline` are the two states a
 * signed-in desktop moves between, and `offlineSince` is what the line
 * reads out: "offline since 09:12" and not "offline", because the
 * length of an outage is the whole of what a person wants to know about
 * one.
 */
export const SyncStatusSchema = z.object({
  state: z.enum(["solo", "online", "offline"]),
  /** When the first request failed, or null while the record is answering. */
  offlineSince: z.number().nullable(),
  /** How many commands are waiting to be replayed, in the order they were made. */
  queued: z.number().int().nonnegative(),
  /** The items among them, so a card can draw itself as provisional without a second query. */
  queuedItemIds: z.array(z.string()),
  /** The last thing the record said that this device could not carry out. Null is the ordinary case. */
  problem: z.string().nullable(),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

/**
 * The sentence a superseded move is reported with (ARCHITECTURE.md, "The record").
 *
 * Written once, here, because it is said on the item as a comment and
 * read back out of the inbox, and a wording that differed between the
 * two would read as two events. It names the item by its key and the
 * other party by whatever the record called them, which is what makes
 * it an account of what happened rather than a failure notice.
 *
 * Nothing is reverted quietly: the record's answer is mirrored onto the
 * replica *and* this is said, which is the pairing the design asks for.
 */
export function supersededLine(itemKey: string, by: string, toStepId: string): string {
  return (
    `Your move of ${itemKey} was superseded by ${by}'s. ` +
    `It had already moved on the record, so EO dropped your move and this ${itemKey} is where the record has it (${toStepId}).`
  );
}

/** How a device with no better name for the other party refers to them. */
export const SOMEONE_ELSE = "someone else";

/**
 * The sentence a dropped claim is reported with (EO-367).
 *
 * `supersededLine`'s twin, said on the item as an escalation that
 * mentions the person whose claim lost. It names the holder, because
 * "your claim was dropped" with no name is a dead end and "Anna has it"
 * is somebody to go and talk to.
 */
export function claimDroppedLine(itemKey: string, holder: string): string {
  return (
    `Your claim on ${itemKey} was dropped: ${holder} already holds it. ` +
    `Their claim reached your organisation's record first, so ${itemKey} stays with ${holder}.`
  );
}

/**
 * What a person tried to do on a group-owned human step (EO-368), as
 * the refusal names it: "Your decision on DES-4 was not applied".
 */
export type StepAct = "claim" | "takeover" | "decision" | "move" | "edit";

/**
 * The sentence a refusal on a group-owned human step is reported with
 * (EO-368).
 *
 * `supersededLine`'s sibling, said as an escalation that mentions the
 * person refused. It always says why and always names somebody: the
 * group they are not in, or the person who holds the item — because
 * "not allowed" with no name is a dead end, and "Anna holds it" is
 * somebody to go and talk to. Written once here, so the desktop that
 * hears the record's answer and the record answering a browser directly
 * say the same thing.
 */
export function stepRefusalLine(
  itemKey: string,
  act: StepAct,
  refusal: Pick<StepRefusal, "why" | "groupName" | "holder" | "sentence">,
  /** Who is being told, where known — so an item that has reached them is said to be theirs, by name. */
  readerId?: string | null,
): string {
  const what = `Your ${act} on ${itemKey} was not applied`;
  const holder = refusal.holder === null ? null : refusal.holder.id === readerId ? `you (${refusal.holder.name})` : refusal.holder.name;
  switch (refusal.why) {
    case "notInGroup":
      return (
        `${what}: ${itemKey} waits on ${refusal.groupName}, and you are not in ${refusal.groupName}. ` +
        `Only somebody in ${refusal.groupName} can claim it or decide on it.`
      );
    case "heldBy":
      return (
        `${what}: ${holder ?? SOMEONE_ELSE} holds it, and on a step that waits on ${refusal.groupName} only the person ` +
        `holding the item decides. Take it over from ${holder ?? "them"} first if you need to act on it.`
      );
    case "unclaimed":
      return `${what}: nobody holds it yet, and on a step that waits on ${refusal.groupName} a decision needs a holder. Claim it first, then decide.`;
    case "stale":
      return (
        `${what}: it has changed hands since you were warned, and ${holder === null ? "nobody holds it now" : `it is held by ${holder} now`}. ` +
        `Nothing was taken from anybody; look again before taking it over.`
      );
    case "notGroupStep":
      return (
        `${what}: ${itemKey} has moved on and no longer waits on a group, so there is nothing to take over. ` +
        `Nothing was taken from anybody${holder === null ? "" : `, and it is still held by ${holder}`}.`
      );
    case "entryRules":
      return `${what}: ${refusal.sentence ?? "the pipeline it was moved to refused it."}`;
  }
}

/**
 * An edit refused on a desktop because the person's own hold on the item
 * has not been confirmed yet (EO-368): their claim or takeover is still
 * waiting for the record, which may refuse it. An edit never travels, so
 * one allowed on a provisional hold could not be undone if the hold were
 * refused — it is asked for again once the record has answered.
 */
export function editAwaitingHoldLine(itemKey: string, groupName: string): string {
  return (
    `Your edit on ${itemKey} was not applied: it is not yours yet. Your claim or takeover is still waiting for your ` +
    `organisation's record, and on a step that waits on ${groupName} only the person holding the item may change it. ` +
    `Edit it again once the record has confirmed it is yours.`
  );
}

/**
 * The thread's account of a takeover (EO-368): "Dana took this over from
 * Anna." EO's own voice, naming both people, beside a mention of the
 * person who lost the item so that it reaches their inbox.
 */
export function takeoverLine(taker: string, previous: string): string {
  return `${taker} took this over from ${previous}.`;
}

// ── Moving a project to the record (EO-325) ─────────────────────────

/**
 * A project's history, on its way up.
 *
 * The design:
 * a solo person with work already on their board signs in, and per
 * project chooses to keep it here or move it to the record. This is
 * what "move it" is on the wire.
 *
 * ### Why it is not a `RecordCommand`
 *
 * Because a command is *something this device did that the record must
 * apply*, and history is not that. Replaying a project's transitions as
 * commands would walk the item through every step it had ever been on,
 * against a record that already has it where it ended up — so every one
 * of them would come back `superseded` and the person would be told,
 * item by item, that their own past had been overtaken by somebody
 * else's move. History is rows, and it arrives as rows.
 *
 * The queue also has nowhere to put the half of this that is not about
 * an item at all. `record_commands.item_id` is `NOT NULL` with a
 * foreign key, which is exactly right for a queue of things done to
 * items and leaves no home for a project, a pipeline or a job.
 *
 * ### What travels and in what order
 *
 * One page is one request and the pages are sent in dependency order,
 * because the record enforces its foreign keys like every other EO
 * database: types and pipelines and jobs, then the items, then the runs,
 * then the transcripts and the moves and the thread, then what hangs off
 * it. Each page is idempotent by primary key, so a request that was
 * served and whose answer was lost costs one repeat and changes nothing.
 *
 * Files travel here too, and one per request, because a single
 * attachment may be twenty megabytes and fills a request by itself.
 * They were queued behind the move at first, through the ordinary
 * attachment command, and that was wrong for the reason the review
 * found: a move that had *not yet sent the files* would report success
 * and mark the project the record's irreversibly, so "a count
 * comparison between the local database and the server proves nothing
 * was lost" could not be made at the moment it mattered. A move is
 * finished when everything it is moving has arrived, files included.
 */


/**
 * A job, as the record takes it over.
 *
 * `ownerId` is rewritten to the signing-in person on the way — the same
 * rewrite the mentions get, and for the same reason: a job owned by the
 * implicit local person is owned by somebody the record has no row for.
 * Where the job *runs* is untouched by any of this; the design is explicit
 * that a job runs on a desktop and the server is mailbox and record.
 */
export const RecordJobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  trigger: z.unknown(),
  pipelineId: z.string().nullable().default(null),
  template: z.unknown().nullable().default(null),
  ownerId: z.string(),
  threadItemId: z.string(),
  pausedAt: z.number().nullable().default(null),
  pausedReason: z.string().nullable().default(null),
  budgetPerOccurrenceCents: z.number().nullable().default(null),
  maxItemsPerHour: z.number().nullable().default(null),
  deletedAt: z.number().nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type RecordJob = z.infer<typeof RecordJobSchema>;

/**
 * One firing of a job, as it happened (EO-325, `ARCHITECTURE.md`, "What a job records").
 *
 * `job_occurrences` is append-only beside `run_events` and
 * `transitions` — `architecturalInvariants.test.ts` holds all three to
 * the same rule — because its whole value is saying what happened at a
 * moment that has passed. A `skipped` row is a job that did not run and
 * the only thing that says so; a `fired` row is what stops the same
 * occurrence firing twice.
 *
 * So it travels with the job, and a project moved without it arrives
 * with its schedule and no account of it: the record would fire an
 * occurrence this machine had already fired, and the skip somebody was
 * told about would be gone from the thread it was told in.
 *
 * `itemId` and `offerCommentId` carry no foreign key on purpose — the
 * firing outlives the item — so they travel as they stand.
 */
export const RecordJobOccurrenceSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  dueAt: z.number(),
  firedAt: z.number().nullable().default(null),
  status: z.string(),
  reason: z.string().nullable().default(null),
  itemId: z.string().nullable().default(null),
  offerCommentId: z.string().nullable().default(null),
});
export type RecordJobOccurrence = z.infer<typeof RecordJobOccurrenceSchema>;

/**
 * An item of a project being moved, with the two columns the ordinary
 * item shape leaves out.
 *
 * `RecordItemSchema` describes an item a replica is *mirroring*, and a
 * mirror does not need to know who filed something. A move does: "as
 * that person's" is the whole of the third bullet, and an item whose
 * `created_by` was dropped on the way up would be work arriving on the
 * organisation's board with nobody's name on it.
 */
export const RecordAdoptedItemSchema = RecordItemSchema.extend({
  createdBy: z.string().nullable().default(null),
  /**
   * The key this item was keyed under, which may already be somebody
   * else's on the record.
   *
   * Not a field — `RecordItemSchema.key` already carries it — but worth
   * saying where the rest of the shape is described: the prefix is
   * unique per project and checked before anything lands, so two
   * projects cannot interleave numbering.
   */
  /**
   * What the item's type asked for and the person filled in (ARCHITECTURE.md, "An item type is
   * data").
   *
   * Not on the mirror shape either, and its absence there is a smaller
   * loss: a replica shows a card. A move is the item itself changing
   * hands, and an item that arrived without its spec would be work the
   * record holds and cannot act on.
   */
  spec: z.unknown().nullable().default(null),
});
export type RecordAdoptedItem = z.infer<typeof RecordAdoptedItemSchema>;

/**
 * A move as it actually happened, rather than a move being asked for.
 *
 * The difference is the whole reason history does not travel as
 * commands: this is an audit row being copied, and it is written
 * straight into `transitions` with the step the item was on at the
 * time. A command would be a *request* to move the item there now.
 */
export const RecordAdoptedTransitionSchema = RecordTransitionSchema.extend({
  runId: z.string().nullable().default(null),
  deviceId: z.string().nullable().default(null),
});
export type RecordAdoptedTransition = z.infer<typeof RecordAdoptedTransitionSchema>;

/**
 * An edge of the project's dependency graph (EO-325).
 *
 * `item_deps` is two ids and nothing else, and it decides what the
 * scheduler may pick: an item whose dependency is not done is one the
 * engine will not dispatch. A project moved without its edges is a
 * project the record *schedules differently* — work starting on the
 * organisation's board that would not have started on the person's —
 * and the loss is silent, because nothing about the board looks wrong.
 *
 * Only edges whose ends are both on this project travel. A dependency
 * reaching out to work that stayed behind cannot be written on the
 * record at all — `item_deps` has foreign keys both ways — and it is
 * counted as skipped rather than dropped, so a move that would sever
 * one stops and says which.
 */
export const RecordItemDepSchema = z.object({
  itemId: z.string(),
  dependsOnId: z.string(),
});
export type RecordItemDep = z.infer<typeof RecordItemDepSchema>;

/**
 * What a pack knows about an item (EO-325, KAN-148).
 *
 * `item_extensions(itemId, extension, data)` — the developer pack's
 * Jira binding, and whatever any other pack keeps. Item-owned rows, so
 * they belong to the item wherever it goes: the issue an item mirrors,
 * the branch its work is on and the pull request it opened are facts
 * about the *work*, not about the machine that happened to do it, and a
 * record holding the item without them holds a card that has forgotten
 * what it is attached to.
 *
 * Carried whole and domain-neutrally, because core cannot enumerate the
 * packs — the same reason `ItemExtensions` is `unknown`. What is
 * deliberately *not* here is the machine-local half of the same story,
 * and it is a column rather than an extension: `items.workspace_id`
 * names a checkout on somebody's disk and is nulled on the way up
 * (ARCHITECTURE.md, "Where a job runs"). So the branch travels and the directory it is checked out
 * in
 * does not, which is the split the design draws.
 *
 * `updatedAt` is the row's own, so a page re-read during a transfer can
 * tell an extension that changed from one that did not.
 */
export const RecordItemExtensionSchema = z.object({
  itemId: z.string(),
  extension: z.string(),
  data: z.unknown(),
  updatedAt: z.number(),
});
export type RecordItemExtension = z.infer<typeof RecordItemExtensionSchema>;

/**
 * One mention, whole (EO-325, review).
 *
 * A row of `comment_mentions` rather than the target it names, and the
 * difference is what a count comparison could not see. The adoption
 * carried the target and rebuilt the row as `open` with nothing
 * addressing it — so an escalation somebody had answered a fortnight
 * ago, and one they had deliberately dismissed, both came back open on
 * the record and landed in the signed-in person's inbox. The same
 * number of rows, and a different history.
 *
 * `status` is the load-bearing half: it is what `openMentionsForHuman`
 * filters on, and therefore what the inbox and the `!` marker are. And
 * `addressedBy` is the other half of the same fact — *which reply*
 * resolved it — which is what a thread reads back to explain the
 * marker going away.
 *
 * Its own list on the page rather than a field on the comment, because
 * of that second column: `addressed_by` points at a comment that came
 * *after* the one being addressed, and a page boundary between the two
 * would leave a foreign key pointing at a row the record had not
 * reached yet. Mentions travel after every comment has, so the
 * reference always resolves.
 */
export const RecordAdoptedMentionSchema = z.object({
  commentId: z.string(),
  targetType: z.enum(["human", "agent"]),
  /** `agents.id` or `people.id`. Null only on a row written before there were people to name. */
  targetId: z.string().nullable().default(null),
  status: z.string(),
  /** The reply that resolved it, where one did. */
  addressedBy: z.string().nullable().default(null),
});
export type RecordAdoptedMention = z.infer<typeof RecordAdoptedMentionSchema>;

/**
 * One file of a moved project, bytes and all.
 *
 * Its own entry on the page rather than a field on the comment, and
 * sent alone, for `RecordAttachmentCommandSchema`'s reason: a file can
 * be twenty megabytes and the contract's request limit is a little over
 * that, so a file fills a request by itself and cannot ride with a page
 * of comments.
 *
 * The comment that carries it has already arrived by the time this
 * does — `RecordCommentCommandSchema.attachments` announces it — so a
 * thread reads correctly in the gap, and the row behind it is written
 * when the bytes land.
 */
export const RecordAdoptedAttachmentSchema = RecordAttachmentSchema.extend({
  itemId: z.string(),
  /** Null for one of the item's own files (EO-702). */
  commentId: z.string().nullable().default(null),
  createdAt: z.number(),
  dataBase64: z.string().max(MAX_ATTACHMENT_BASE64_CHARS),
});
export type RecordAdoptedAttachment = z.infer<typeof RecordAdoptedAttachmentSchema>;

/**
 * One page of a project's history.
 *
 * Every list defaults to empty, so a page carries whatever the device
 * had room for and the shape says nothing about which page this is. The
 * *order* of the requests is what matters, and it is the device's to
 * keep — see `adopt.ts`.
 */
export const RecordAdoptPageSchema = z.object({
  itemTypes: z.array(RecordItemTypeSchema).max(200).default([]),
  pipelines: z.array(RecordPipelineSchema).max(50).default([]),
  /**
   * The project's own skills and its workspaces' (EO-513), archived ones
   * included. Sent before the agents attached to them, because an
   * attachment is a foreign key and the record attaches only a skill it
   * holds. Never a global skill: that is the installation's.
   */
  skills: z.array(RecordSkillSchema).max(200).default([]),
  /**
   * The project's own agents (EO-476), archived and deleted ones
   * included — a run or a comment that names one still has to resolve
   * on the record. Sent with the graphs, before any run.
   */
  agents: z.array(RecordAgentSchema).max(200).default([]),
  jobs: z.array(RecordJobSchema).max(200).default([]),
  /** What those jobs have already done — see `RecordJobOccurrenceSchema`. */
  occurrences: z.array(RecordJobOccurrenceSchema).max(1000).default([]),
  items: z.array(RecordAdoptedItemSchema).max(200).default([]),
  runs: z.array(RecordRunCommandSchema).max(200).default([]),
  runEvents: z.array(z.object({ runId: z.string(), events: z.array(RecordRunEventSchema).max(1000) })).max(50).default([]),
  transitions: z.array(RecordAdoptedTransitionSchema).max(500).default([]),
  comments: z.array(RecordCommentCommandSchema).max(200).default([]),
  /**
   * Who those comments are asking, and whether they have been answered.
   *
   * Sent after every comment, because `addressed_by` names one — see
   * `RecordAdoptedMentionSchema`. An adopted comment therefore carries
   * no mentions of its own: they are here, whole, rather than
   * reconstructed from a target.
   */
  mentions: z.array(RecordAdoptedMentionSchema).max(500).default([]),
  /** The dependency graph, whose edges decide what the scheduler may pick. */
  deps: z.array(RecordItemDepSchema).max(1000).default([]),
  /**
   * Whether `deps` is the project's *whole* graph, to be put in place of
   * whatever the record holds.
   *
   * A flag rather than an inference from the list being non-empty,
   * because the interesting case is the empty one: a dependency taken
   * off while the transfer was running leaves a graph with nothing in
   * it, and a record that read that as "this page says nothing about
   * dependencies" would keep the edge and hold work back that nothing
   * was waiting on. An edge carries no version of its own to compare —
   * `item_deps` is two ids — so replacing the set is the only way to
   * say that one has gone.
   */
  graph: z.boolean().default(false),
  /** What the packs know about those items — the Jira binding, the branch, the pull request. */
  extensions: z.array(RecordItemExtensionSchema).max(500).default([]),
  /** At most one, because one file fills a request. See the schema above. */
  attachments: z.array(RecordAdoptedAttachmentSchema).max(1).default([]),
  /**
   * The project's memory, and its workspaces' (EO-482), retired entries
   * included — memory travels with its project. Sent after the runs and
   * items an entry may name as its source.
   */
  memories: z.array(RecordMemorySchema).max(500).default([]),
});
export type RecordAdoptPage = z.infer<typeof RecordAdoptPageSchema>;

/**
 * What the record wrote, counted by table.
 *
 * Counted rather than acknowledged with a bare "yes", because the
 * story's second acceptance criterion is a *count comparison*: "a count
 * comparison between the local database and the server proves nothing
 * was lost". A page that half landed and said so is the failure this
 * makes visible; a page that half landed silently is the one it exists
 * to prevent.
 */
export const RecordAdoptCountsSchema = z.object({
  itemTypes: z.number().int().nonnegative().default(0),
  pipelines: z.number().int().nonnegative().default(0),
  /**
   * The steps and routes inside those pipelines, counted separately
   * (EO-325).
   *
   * Because counting pipelines proved nothing about them: a graph
   * arrives as one row and a dozen others, and a comparison that
   * counted the one could not tell a whole graph from an empty one.
   * The rows that decide where work goes are these.
   */
  steps: z.number().int().nonnegative().default(0),
  routes: z.number().int().nonnegative().default(0),
  /**
   * The project's own agents (EO-476). Zero from a record that predates
   * them, which the move reads as a shortfall and stops on, rather than
   * finishing with the project's agents left behind.
   */
  agents: z.number().int().nonnegative().default(0),
  jobs: z.number().int().nonnegative().default(0),
  occurrences: z.number().int().nonnegative().default(0),
  items: z.number().int().nonnegative().default(0),
  runs: z.number().int().nonnegative().default(0),
  runEvents: z.number().int().nonnegative().default(0),
  transitions: z.number().int().nonnegative().default(0),
  comments: z.number().int().nonnegative().default(0),
  mentions: z.number().int().nonnegative().default(0),
  deps: z.number().int().nonnegative().default(0),
  extensions: z.number().int().nonnegative().default(0),
  attachments: z.number().int().nonnegative().default(0),
  /**
   * Memory entries (EO-482). Zero from a record that predates them,
   * which the move reads as a shortfall and stops on rather than
   * finishing with the project's memory left behind.
   */
  memories: z.number().int().nonnegative().default(0),
  /**
   * The project's own skills and its workspaces' (EO-513). Zero from a
   * record that predates them, which the move reads as a shortfall and
   * stops on rather than finishing with the project's skills left behind.
   */
  skills: z.number().int().nonnegative().default(0),
  /**
   * The rows this page carried and the record could not write, with the
   * reason.
   *
   * **A move with anything in here has failed**, and that is the
   * correction the review asked for. It began as a list the screen
   * displayed beside a move that had otherwise succeeded, which is the
   * worst of both answers: the project was on the record irreversibly,
   * three of its items were not, and the person was handed a sentence
   * about it and no way to act on one. A row the record could not write
   * now ends the move with the project still local and still
   * retryable — the whole transfer is idempotent by primary key, so
   * trying again is free.
   *
   * The counts above are what the record **now holds** of what this
   * page carried, not what it happened to insert: a page re-sent after
   * a lost answer finds every row already there and must still be able
   * to say that the record has them. So the caller compares each count
   * against what it sent, and a shortfall is a loss whether or not
   * anything was said about it.
   */
  skipped: z.array(z.string()).default([]),
});
export type RecordAdoptCounts = z.infer<typeof RecordAdoptCountsSchema>;

/**
 * The sentence the sheet and the settings screen both say before
 * anybody presses Move (EO-325, fourth bullet).
 *
 * One wording in one place, because it is the only warning in EO about
 * something that cannot be undone, and two phrasings of it would read
 * as two different rules.
 */
export const MOVE_IS_ONE_WAY_LINE =
  "Moving a project to the record cannot be undone in this version. " +
  "Its items, threads and history become your organisation's, and this machine keeps a copy that follows the record.";

/** What the sheet says above the list, so the choice reads as a choice. */
export const KEEP_OR_MOVE_LINE =
  "These projects are on this machine. EO will leave them here unless you say otherwise — " +
  "a kept project keeps running on this machine exactly as it does now.";
