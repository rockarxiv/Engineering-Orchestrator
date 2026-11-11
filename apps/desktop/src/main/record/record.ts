import type { Dispatch, DispatchRefusal, TickInput } from "@eo/engine";
import type {
  CustomModule,
  Item,
  JobRunsOn,
  MemoryConsolidationView,
  MemoryRestoreConsolidationResult,
  MemoryScope,
  MemoryWriteResult,
  ModuleCreation,
  ModuleCreationAnswer,
  Uuid,
} from "@eo/core";
import type { DispatchLease } from "../db/repos/leasesRepo.js";
import type { PostCommentInput } from "../db/repos/commentsRepo.js";
import type { Comment, IpcResponse, PipelineTemplateStatus } from "@eo/core";
import type { ProjectThreadAnswer } from "../projects/projectThread.js";
import type { UpdateConflictChatAnswer, UpdateConflictChatRequest } from "../roles/updateConflictChat.js";
import type { ResolveUpdateConflictAnswer, ResolveUpdateConflictRequest } from "../gallery/updateConflictDetail.js";
import type { TemplateHistory } from "../gallery/history.js";
import type { DependencyChangeSummary } from "../roles/itemDependencies.js";
import type { MessageHandling, MessageHandlingAnswer, MessageSendAnswer } from "../messages/messages.js";
import type { MessageSend } from "@eo/core";

/**
 * The record: what owns item state and runs the only scheduler
 * (EO-322, EO-324, `ARCHITECTURE.md`, "The record").
 *
 * Invariant #1 has one writer today because there is one process.
 * `transitionsRepo.ts` is the only thing that may write `items.stepId`,
 * and `architecturalInvariants.test.ts` has enforced that since the
 * beginning. Two desktops and a server each running a scheduler and a
 * transition writer would be three, and the fix is not a lock around
 * the writer — it is a role. **The record** owns item state and runs
 * the only scheduler. **A device** claims a dispatch under a lease with
 * a time limit, runs the machine-local preflight, and reports a result
 * or a refusal as a comment. A move a person makes is a command the
 * record applies.
 *
 * This is deliberately not a managed-only topology. In solo mode the
 * desktop is both roles in one process and the lease is local, so there
 * is one code path and managed mode is a matter of where the record
 * lives rather than a second engine.
 *
 * ## The shape of it, and why some of it is async
 *
 * EO-324 put a network between the two roles, and the interface now
 * says where that network is. Two members are `Promise`-returning and
 * the rest are not, and the split is not about convenience:
 *
 *  - **Asking** — what may I run, are my claims still good — is a
 *    question whose answer is only the record's to give. A device
 *    cannot decide it locally and cannot queue it: an answer that
 *    arrives after the fact is not an answer. So `offerWork` and
 *    `renewClaims` are round trips, and a device that cannot make them
 *    is offered nothing, which is exactly the original design's "offline means finish
 *    the run you hold, never keep scheduling locally".
 *  - **Telling** — this moved, this was said, this ran — is something
 *    that has already happened on the device. It is written to the
 *    device's replica at once and queued for the record, because a
 *    person pressing Approve must not be made to wait on a network and
 *    must not lose the press if there is none. So `applyTransition`,
 *    `postComment` and `appendRunEvent` answer immediately, and what
 *    they answer with is provisional until the record has confirmed it
 *    (`record_commands`, and the dashed *queued* card that reads from
 *    it).
 *
 * A provisional move that the record then refuses is dropped and the
 * person told, never silently reverted — see `drain.ts`, which is where
 * that sentence is actually kept.
 *
 * ## Why `ItemRecord` and not `Record`
 *
 * `Record` is TypeScript's own built-in utility type, used in dozens of
 * files here, several of which have to import this. A local interface
 * with that name shadows it and turns `Record<string, unknown>` into a
 * type error at a distance, which is a poor trade for one word. The
 * prose still calls it the record; only the identifier is qualified.
 */
export interface ItemRecord {
  /**
   * What this device may run, with the claim that comes with it.
   *
   * **The pivot of EO-324.** The supervisor's tick used to decide: it
   * built the scheduler's input, called `pick`, and then claimed what
   * came back. Now it asks, and what comes back is already leased to
   * it. In one process that is the same three statements in a different
   * file; across two it is the only arrangement in which the record is
   * the only scheduler, because a device that never picks cannot pick
   * differently.
   *
   * The pick and the claim are one call rather than two on purpose: a
   * dispatch that is offered and not yet claimed is a window in which
   * a second device can be offered the same item.
   *
   * An empty answer is the ordinary answer, and it is also what a
   * device with no record to ask gets. Those two are deliberately
   * indistinguishable here: there is nothing to run either way, and the
   * *reason* belongs on the sync line where a person can see it.
   */
  offerWork: <R extends DispatchRefusal>(input: OfferWorkInput<R>) => Promise<WorkOffer[]>;
  /**
   * This device saying the claims it is working under still stand.
   *
   * Answers what it *still holds*. Anything the caller named and does
   * not get back was swept while this device was away — a laptop that
   * slept through the whole term — and the caller forgets it rather
   * than renewing its way out of its own expiry. The record says so on
   * the item when it sweeps (invariant #8).
   */
  renewClaims: (deviceId: string, itemIds: readonly Uuid[]) => Promise<DispatchLease[]>;
  /** Give the item back. Idempotent, and it can only release the claim it was handed. */
  releaseLease: (lease: DispatchLease) => Promise<void>;
  /**
   * What one person has spent since `since`, in cents (EO-328, ARCHITECTURE.md, "Policy").
   *
   * On the record rather than on the device because the design's budget is
   * *per person* and a person has more than one machine: a device that
   * summed its own replica gave each of Anna's desktops the whole
   * ceiling to itself, and one that had not synced yet answered with a
   * fraction of the real figure and let work through on it.
   *
   * `since` is an instant, so the day stays the *device's* local
   * calendar day — the record has no business choosing between two
   * people's time zones.
   *
   * A record that cannot be reached answers what the replica holds,
   * which is a lower figure and so the permissive direction. That is
   * the design applied to a ceiling: managed mode never stops a person from
   * working, and a ceiling nobody can verify is not a reason to stop
   * everything.
   */
  personSpendToday: (personId: string, since: number) => Promise<number>;
  /**
   * What a device holds that it is no longer working under — the claims
   * an earlier run of that process left behind.
   *
   * `stillHeld` names the claims that are covering work right now, and
   * the caller is the only thing that can know them: a device asking
   * this is a live process, and it may be asking while one of its own
   * dispatches is mid-flight. Releasing every row with its name on it
   * would drop the claim over work it is still doing and let another
   * machine start the same item underneath it. At boot the set is
   * empty, which is the case this exists for.
   */
  releaseLeasesOf: (deviceId: string, stillHeld?: Iterable<Uuid>) => Promise<DispatchLease[]>;
  /**
   * Move an item, because a device reported a result or a person asked.
   *
   * **The only caller of the transition writer** (invariant #1), which
   * `architecturalInvariants.test.ts` proves rather than trusts. Every
   * other caller — the supervisor that ran the agent, the IPC command
   * behind a drag — sends the command here and the record applies it.
   *
   * Answers with the item as this installation now has it. On a desktop
   * signed in to an organisation that is a *provisional* answer: the
   * move is on the replica and queued for the record, and the record
   * may yet say the item had already moved. It is never silently
   * reverted — see `drain.ts`.
   */
  applyTransition: (command: TransitionCommand) => Item;
  /** Append to the durability substrate (invariant #3). Never updates, never deletes. */
  appendRunEvent: (runId: Uuid, type: string, payload: unknown) => void;
  /** Say something on an item's thread — the only communication channel there is (invariant #4). */
  postComment: (input: PostCommentInput) => Comment;
  /**
   * Create the work item a module's run asked for (EO-433).
   *
   * **Asking, like `offerWork`, and for its reason.** A comment is told
   * — written here, queued, confirmed later — because it has already
   * happened. A creation has not: the module is waiting for a key, the
   * key is minted from the project's counter, and whether this is a
   * repeat of an earlier creation is in a table only the record's copy
   * of is the truth. A device that created the item on its replica
   * would hand a module the key of something the organisation's board
   * never receives. So this is a round trip to whichever record owns
   * the originating item, and a record that cannot be reached answers
   * that nothing was created — which is true.
   *
   * Never rejects: the answer goes back to a module that is usually
   * still running, and a refusal is an ordinary one.
   */
  createItemFromModule: (request: ModuleCreationRequest) => Promise<ModuleCreationAnswer>;
  /**
   * Change what an item waits for (EO-600, ARCHITECTURE.md, "One work
   * entity").
   *
   * **Asking, like `createItemFromModule`, and for its reason.** The
   * edges of a project the organisation holds are the record's: whether
   * a change closes a cycle is a question about the whole graph, and an
   * edge written on a replica is one the scheduler that decides what is
   * dispatched would never see. So on a desktop holding such a project
   * this is a round trip, the record judges and writes the change — all
   * of it or none — with its one comment, and the answer is copied into
   * the replica before it is returned.
   *
   * Never rejects. A record that cannot be reached answers that nothing
   * changed, which is true, and nothing is written here or queued.
   */
  changeDependencies: (request: DependencyChangeAsk) => Promise<DependencyChangeAnswer>;
  /**
   * The project's thread, made the first time anything asks (EO-471,
   * ARCHITECTURE.md, "One channel").
   *
   * **The accessor** — the one function core and pack code call to get
   * somewhere to post about a project rather than about an item. The
   * same item on every call; the first call makes it.
   *
   * Asking, like `createItemFromModule`, and for its reason. The thread
   * belongs to the record like the project's other items, so on a
   * desktop holding a project the organisation owns it is the record
   * that makes it — its key is the record's to mint, and a thread made
   * on the replica would be an item the record never receives, with
   * every comment on it refused there. The answer is copied into the
   * replica before it is returned, so the caller can post at once.
   *
   * Never rejects. A record that cannot be reached answers a refusal
   * with the sentence saying so.
   */
  projectThread: (projectId: Uuid) => Promise<ProjectThreadAnswer>;
  /**
   * Sends a message — EO asking a person something that belongs to no
   * item (EO-725, EO-726, ARCHITECTURE.md §7.1).
   *
   * **The accessor** for senders, as `projectThread` was for the thread
   * a message replaces. A message about a project the organisation's
   * record holds is written on the record, one to each of its admins
   * whoever `recipientId` named, and never only in a desktop's own
   * table: asking, like `projectThread`, because who the admins are is
   * the record's fact and a row written on a replica reaches nobody
   * else. The record's copies addressed to this desktop's person are
   * kept here at once; every other recipient's desktops pull theirs.
   * Anything else — a solo desktop, a project kept here — is written in
   * this database to `recipientId`, and on the record itself a project's
   * message goes to the admins without a round trip.
   *
   * Never rejects. A record that cannot be reached answers a refusal
   * with the sentence saying so, and nothing is written anywhere.
   */
  sendMessage: (input: MessageSend) => Promise<MessageSendAnswer>;
  /**
   * A person answering or dismissing a message (EO-726): on whichever
   * installation holds it. One about a project the organisation's record
   * holds is marked handled there — the record is where it lives, and
   * where its recipient's other desktops hear of it — and the record's
   * answer is copied here. Any other is handled in this database.
   *
   * Never rejects: a refusal carries the sentence the person is shown.
   */
  handleMessage: (request: MessageHandling) => Promise<MessageHandlingAnswer>;
  /**
   * The assistant chat about one held template update (EO-533), made the
   * first time anybody presses Fix with assistant and the same chat on
   * every press after.
   *
   * Asking, like `projectThread`, and for its reason. A pipeline the
   * organisation's record holds is compared there, so the conflict is
   * there — a desktop holds only the notice it was told — and the chat
   * belongs with it: made on the record, so every admin's press finds
   * the same one, and copied into the replica that asked, with its
   * brief, before it is returned. A conflict this database holds itself
   * is answered from it.
   *
   * Never rejects. A record that cannot be reached answers a refusal
   * with the sentence saying so.
   */
  updateConflictChat: (request: UpdateConflictChatRequest) => Promise<UpdateConflictChatAnswer>;
  /**
   * A held template update, read whole (EO-534) — what
   * `pipeline_update_conflict` answers.
   *
   * Asking, like `updateConflictChat`, and for its reason: a pipeline the
   * organisation's record holds is compared there, so its conflict and
   * the three graphs are there, and a desktop holds none of it. One this
   * database holds is answered from it. `onTheRecord` says whether this
   * installation is the record, where a pipeline the record holds is
   * its own.
   *
   * Never rejects. A record that cannot be reached answers a refusal
   * with the sentence saying so.
   */
  updateConflict: (request: { pipelineId: string; onTheRecord: boolean }) => Promise<IpcResponse<"pipeline:updateConflict">>;
  /**
   * A pipeline's template origin and update state (EO-536) — what the
   * head of its board and Graph view says — asked where its updates are
   * held, by `updateConflict`'s rule: the organisation's record for a
   * pipeline it holds, whose origin a replica only has as it was before
   * the pipeline moved; this database for every other.
   *
   * `history` is the template history this build ships, which an answer
   * given here reads release notes and titles from; a record asked over
   * the wire reads its own. Never rejects: a record that cannot be
   * reached answers nothing, with the sentence saying why.
   */
  templateStatus: (request: { pipelineId: string; onTheRecord: boolean; history: TemplateHistory }) => Promise<PipelineTemplateStatus>;
  /**
   * Resolves a held template update (EO-534): kept, or a draft published
   * from the chat about it — on whichever installation holds it.
   *
   * On the record, `published` saves the draft's graph there, filed
   * under `createdBy`; a desktop asking the record sends the graph and
   * is told what the record made of it. A conflict this database holds
   * is resolved here. The record checks for itself that the asking
   * device is an admin's.
   *
   * Never rejects. A record that cannot be reached answers that nothing
   * was resolved, which is true.
   */
  resolveUpdateConflict: (request: ResolveUpdateConflictRequest & { onTheRecord: boolean; createdBy: string | null }) => Promise<ResolveUpdateConflictAnswer>;
  /**
   * Write to a project's memory, or a workspace's (EO-482,
   * ARCHITECTURE.md, "What an agent is given", "The record").
   *
   * **Asking, like `createItemFromModule`, and for its reason.** The
   * memory of a project the organisation holds is the organisation's:
   * every desktop working on it is given the same entries, so an entry
   * written to one replica is one nobody else would ever be given — and
   * one the record would never consolidate. So a run's note, extraction's
   * notes and a person's edits are each a round trip to the record that
   * holds the project, the rows it changed are copied into the replica
   * from its answer, and every other desktop takes them on its next pull.
   *
   * A record that cannot be reached answers that nothing was written,
   * which is true, and nothing is written here. Not queued: a note is
   * the agent's to know the fate of, and it has already been told.
   *
   * Never rejects.
   */
  writeMemory: (request: MemoryWriteRequest) => Promise<MemoryWriteResult>;
  /**
   * A scope's consolidations, newest first and every one of them, from
   * whichever record runs them (EO-482, EO-545). Consolidation for a
   * project the organisation holds runs on its record, so its history is
   * there. A record that cannot be reached answers what this database
   * holds.
   */
  memoryConsolidations: (scope: MemoryScope) => Promise<MemoryConsolidationView[]>;
  /**
   * Undo one consolidation, on the record that made it (EO-482). `caps`
   * are the ones this installation has, used where this database is that
   * record; a record elsewhere settles the scope under its own.
   */
  restoreMemoryConsolidation: (consolidationId: string, caps: MemoryCaps) => Promise<MemoryRestoreConsolidationResult>;
  /**
   * Restore an earlier version of a skill (EO-714) — on whichever
   * installation holds the skill (EO-728).
   *
   * **Asking, like `restoreMemoryConsolidation`, and for its reason.** A
   * skill of a project the organisation's record holds, or one its
   * published packs section carries, is the record's: its next copy
   * would undo a restore made on a replica, and no other desktop would
   * ever see it. So on a desktop holding such a skill this is a round
   * trip; the record restores it, judging for itself that it holds the
   * skill and, while the packs section is published, that the asking
   * device is an admin's, and the skill as the record now has it is
   * copied into the replica before it is answered. Any other skill is
   * restored in this database.
   *
   * Never rejects. A record that cannot be reached answers that nothing
   * was restored, which is true, and nothing is written here.
   */
  restoreSkillVersion: (request: SkillRestoreRequest) => Promise<IpcResponse<"skills:restoreVersion">>;
  /**
   * Settle up with the record, where the record is somewhere else
   * (EO-324, ARCHITECTURE.md, "The record").
   *
   * Hand over what this device did and take what the record has. Absent
   * on a record that is in this process, because there is nothing on
   * either side of that sentence — which is why it is optional rather
   * than a no-op every implementation has to remember to write.
   *
   * Called at the top of the supervisor's tick rather than on a timer
   * of its own, and that ordering is the point: a device about to ask
   * for work should first have said what it did with the last of it,
   * and should be looking at the board the record actually has.
   */
  sync?: () => Promise<unknown>;
  /**
   * Hands over what this device has queued, and nothing else (EO-456).
   *
   * The first half of `sync`, for the one moment that cannot wait for
   * the next tick: a check of a step that keeps checking has just
   * written where its watch stands, and the lease is about to go. A
   * record that offered the item to another device before hearing about
   * the check would have it checked again at once, with the old watch's
   * clock. Absent where `sync` is, for its reason.
   */
  flush?: () => Promise<unknown>;
}

/** A restore of one skill's version: the IPC request's, with the system agent that asked, if one did (EO-714). */
export interface SkillRestoreRequest {
  id: string;
  versionId: string;
  actingAgentId?: string | undefined;
}

/**
 * What a device asks for when it asks for work.
 *
 * `tickInput` is the scheduler's own input, built by the device from
 * its replica. A record in the same process schedules from it directly.
 * A record on a server **ignores it** and schedules from its own
 * tables, which is the point: the device's copy is a replica and a
 * replica is not an authority. It is still built and still passed,
 * because the device needs it anyway — the standing asks EO raises
 * before a dispatch (EO-213) are computed from the same input — and
 * because a device that could not build one could not be its own record
 * in solo mode.
 */
export interface OfferWorkInput<R extends DispatchRefusal> {
  deviceId: string;
  /**
   * How many dispatches this device could start now. The record may offer
   * fewer, and more only of work no cap holds back (`TickInput.uncappedRoles`,
   * EO-616), which is why nought is still an ask. Null is a process that
   * can run nothing at all: it is offered nothing, and the ask is for the
   * record's sweep alone.
   */
  capacity: number | null;
  tickInput: TickInput<R>;
  /**
   * Which kind of machine is asking (EO-330, ARCHITECTURE.md, "Where a job runs").
   *
   * The record places work as well as scheduling it: an item a job put
   * on the organisation server is offered to the server and to nothing
   * else, and everything else is offered to desktops. Omitted is
   * `device`, which is every caller that predates placement and every
   * desktop that ever asks — a machine with somebody's logins and
   * somebody's disk on it.
   *
   * It is the *asking device's* placement and never this process's. A
   * server answering `record:work` for a laptop is answering about the
   * laptop.
   */
  runsOn?: JobRunsOn;
  /** The record's clock, where a test holds it still. */
  at?: number;
}

/** A dispatch, and the claim this device now holds over its item. */
export interface WorkOffer {
  dispatch: Dispatch;
  lease: DispatchLease;
}

/**
 * A move, as something asked for rather than something done.
 *
 * The same shape `transitionItem` has always taken, named for what it
 * is on this side of the split: a device that finished a run, or a
 * person who dragged a card, does not write `items.stepId` — it says
 * where the item should go and the record decides and writes.
 */
export interface TransitionCommand {
  /**
   * The id this move already has, where it is one the record applied
   * and a replica is mirroring (EO-324). Absent for a move being made
   * here — see `TransitionItemInput.id`, which is where it is spent.
   */
  id?: Uuid;
  itemId: Uuid;
  toStepId: string;
  /** The pipeline the destination step belongs to, checked against the step rather than believed (EO-57). */
  toPipelineId?: Uuid | null;
  actor: string;
  /** The machine it came from, where the record is not this one (EO-324). */
  deviceId?: string | null;
  /**
   * This move is the record's, being copied onto a replica (EO-324).
   *
   * Carried through to `TransitionItemInput.mirrored`, where it stops
   * the move being announced — and therefore stops it being queued back
   * to the record that made it. Without it the pull that brings a move
   * home queues a command about it, the record applies nothing, and the
   * queue grows by one per reconnect for ever.
   */
  mirrored?: boolean;
  runId?: Uuid | null;
  reason?: string | null;
  /** The declared result the move was made on — see `TransitionItemInput.resultKey`. Not sent to the record. */
  resultKey?: string | null;
}

/** A module's creation, as it is asked of a record. */
export interface ModuleCreationRequest {
  /** The module that asked, as the process that ran it holds it. */
  module: CustomModule;
  /** The item the run is on — the originating item. */
  item: Item;
  /** The run it happened under. */
  runId: Uuid | null;
  /** Checked for shape and redacted by the process that ran the module. */
  creation: ModuleCreation;
  /** That process saying this run has already created its ten. See `ModuleCreationOptions.atCap`. */
  atCap: boolean;
  /** Told the new item's id, where it was created in this database. */
  onCreated?: (itemId: Uuid) => void;
}

/** A scope's caps, as the settings that hold them say (EO-480). */
export interface MemoryCaps {
  maxEntries: number;
  maxChars: number;
}

/**
 * A write to memory, as a caller asks it of a record (EO-482).
 *
 * - `note` — an agent's `memory_note`, or one extraction drew out of the
 *   run, already held to `checkMemoryNote` by the caller and held to it
 *   again wherever the record is. Written with the run and its item as
 *   its source. The entries it `replaces` (EO-594) are retired as
 *   superseded in the same transaction, each held to being an active
 *   entry an agent wrote in one of `scopes` — the scopes the run works in;
 *   none where absent, so a note naming an entry with no scopes given is
 *   refused.
 * - `add`, `edit`, `retire`, `restore` — a person's, as the `memory:*`
 *   channels take them.
 */
export type MemoryWriteRequest =
  | {
      op: "note";
      item: Item;
      runId: Uuid;
      scope: MemoryScope;
      body: string;
      extracted?: boolean;
      replaces?: readonly string[];
      scopes?: readonly MemoryScope[];
      now?: number;
    }
  | { op: "add"; scope: MemoryScope; body: string }
  | { op: "edit"; id: string; body: string }
  | { op: "retire"; id: string }
  | { op: "restore"; id: string };

/** A change to what an item waits for, as a caller asks it of a record (EO-600). */
export interface DependencyChangeAsk {
  itemId: Uuid;
  /** Items to wait for from now on, by key or id. */
  add: readonly string[];
  /** Items to stop waiting for, by key or id. */
  remove: readonly string[];
  /**
   * Who asked, as this installation names them, for the comment. A record
   * elsewhere names the person the asking device belongs to instead.
   */
  by: string;
  /**
   * Why, where the change is a reorder card a person approved in a
   * conversation — which the comment then says. Absent for `items:update`.
   */
  why?: string | null;
}

/** What a record answered: what changed, by key — null for a request that asked for nothing — or why nothing did. */
export type DependencyChangeAnswer = { ok: true; dependencies: DependencyChangeSummary | null } | { ok: false; problem: string };
