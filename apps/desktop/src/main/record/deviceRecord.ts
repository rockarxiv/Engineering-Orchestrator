import type { Comment, Item, Uuid } from "@eo/core";
import type { DispatchRefusal } from "@eo/engine";
import type { Db } from "../db/client.js";
import type { DispatchLease } from "../db/repos/leasesRepo.js";
import type { PostCommentInput } from "../db/repos/commentsRepo.js";
import { drainToRecord, type DrainResult } from "./drain.js";
import { recordFor, type LocalItemRecord } from "./localRecord.js";
import type { ItemRecord, MemoryWriteRequest, OfferWorkInput, TransitionCommand, WorkOffer } from "./record.js";
import { getConsolidation, getItemType, getMessage, getUpdateConflict, memoryEntryProjectId, memoryScopeProjectId } from "../db/repos/index.js";
import { sendMessageToAdmins } from "../messages/messages.js";
import { heldByTheRecord } from "../gallery/templateUpdates.js";
import { createRemoteRecord, type RemoteRecord } from "./remoteRecord.js";
import { markReplica } from "../db/recordRole.js";
import { itemsOnMovedProjects, locallyScheduledItemIds, movedToTheRecord, onTheRecord, projectMovedToTheRecord } from "../db/repos/projectsRepo.js";
import { queueOutbound } from "./outbound.js";
import { skillHeldByTheRecord } from "../skills/onTheRecord.js";
import type { RecordAttachmentStore } from "./serveRecord.js";
import { forgetSyncState, type RecordTransport } from "./syncStatus.js";
import type { PolicySyncReason } from "../policy/sync.js";

/**
 * The record this desktop is talking to, whichever one that is
 * (EO-324, `ARCHITECTURE.md`, "The record").
 *
 * The original design's promise in one object: *"this is not a managed-only topology.
 * In solo mode the desktop runs both roles in one process, so there is
 * one code path and managed mode is a matter of where the record lives,
 * not a second engine."* Everything above this — the supervisor, the
 * IPC commands behind a drag — holds an `ItemRecord` and never asks
 * which kind it has.
 *
 * The choice is made per call and not once at startup, and that is not
 * a detail. A person signs in without relaunching EO, and signs out the
 * same way; a record chosen at construction would leave a signed-in
 * desktop scheduling locally until somebody restarted it, which is the
 * one thing invariant #1 cannot survive. So `linked()` is asked each
 * time, and the answer is simply whether this machine has a record
 * elsewhere to ask.
 *
 * ## …and per item, since EO-325
 *
 * Because "does this machine have a record" stopped being the whole
 * question the moment a person could sign in and keep a project.
 * The design:
 * "a kept project stays under the local record and device roles exactly
 * as in solo mode, beside the managed projects". Two records are in
 * force on one desktop at once, and which one applies is a fact about
 * the item.
 *
 * So the switch below is `recordOwning(itemId)`, and every member that has
 * an item routes through it. The three that do not — the lease calls —
 * are about *claims*, and a claim is held wherever the item's record
 * is, so those are split by the same question and answered by both.
 *
 * `offerWork` is the one that adds rather than routes. A signed-in
 * desktop asks the record what to run, as EO-324 arranged, *and* runs
 * its own scheduler over whatever it kept — which is the first
 * acceptance criterion of this story: "keeping both shows them under
 * Local, unchanged, and the local scheduler keeps running them". A
 * desktop that stopped scheduling its kept projects the moment somebody
 * signed in would have quietly taken their work away from them.
 */
export interface DeviceRecord extends ItemRecord {
  /**
   * Hand over what this device has done, and take what the record has.
   *
   * A no-op on a solo desktop, where there is nothing on either side of
   * the sentence. Called on the engine's own tick rather than on a
   * timer of its own, because the two things it does are exactly what a
   * tick is for: a device that is about to ask for work should first
   * have said what it did with the last of it.
   */
  sync: (reason?: SyncReason) => Promise<DrainResult>;
  /** Whether this machine has a record somewhere else — a signed-in desktop, as opposed to a solo one. */
  linked: () => boolean;
  /**
   * Stops listening for what this device does.
   *
   * The composition root calls it on shutdown, and a test at its end.
   * The subscriptions are keyed on the database, so forgetting leaks a
   * listener rather than corrupting anything — but a database re-opened
   * in one process would then have two, and every move would be queued
   * twice.
   */
  stop: () => void;
}

/**
 * Why a sync is happening (EO-328, review).
 *
 * The drain does the same work either way — it is cursored, so an empty
 * pass is nearly free — but the policy sync beside it is rate-limited,
 * and a *push* is not a poll: it arrives once, because the record said
 * something changed. Dropping one inside the rate-limit window left an
 * admin's freshly published allowed-backends list unenforced for up to a
 * minute, which is the difference between "cannot dispatch" and "stops
 * within the minute".
 *
 * Re-exported from `policy/sync.ts` rather than redeclared, so the tick
 * and the thing it is about cannot come to mean different words.
 */
export type SyncReason = PolicySyncReason;

export interface DeviceRecordOptions {
  db: Db;
  /**
   * How to reach the organisation's record, asked afresh each time.
   *
   * `createManagedDirectory().client` in production, which answers null
   * for a solo desktop and for a server — a server *is* the record and
   * has nobody to ask, so it takes this path and never leaves it.
   */
  transport: () => RecordTransport | null;
  /** This machine's row in the record's Devices list, read per use for the reason `linked` is. */
  deviceId: () => string;
  now?: () => number;
  /** Called when the link or the queue changed, so open screens are told to ask again. */
  onSyncChange?: () => void;
  /** Called when a pull brought lines for a run. See `DrainOptions.onRunEvents`. */
  onRunEvents?: (runId: Uuid) => void;
  /** How many rows one pull asks for. Left alone outside a test — see `DrainOptions.pullPageSize`. */
  pullPageSize?: number;
  /**
   * Whether this process *is* the record (EO-325).
   *
   * True on an organisation's server, false on every desktop. The
   * distinction could not be read off the transport, and that is what
   * makes it an option rather than an inference: a server's transport
   * is null because it has nobody to ask, and a signed-out desktop's is
   * null because it has lost its key — two opposite situations with one
   * observable.
   *
   * What it decides is who the *other* side is. `movedToTheRecord`
   * answers "somebody handed this project over", which is true on both
   * ends of a move; only this says which end this is. Without it the
   * record would treat its own projects as somebody else's replica —
   * suppressing the tracker pushes it is the only one able to make, and
   * declining to fire the jobs it is the only one able to fire.
   */
  isTheRecord?: boolean;
  /**
   * How this device takes the organisation's policy (EO-328, ARCHITECTURE.md, "Policy").
   *
   * A thunk rather than the options it needs, because policy is nothing
   * to do with a record's job: this file is about items, leases and
   * commands, and what it lends the sync is its *timing* — a device that
   * is about to ask the record for work should already be on the policy
   * the record published. `createPolicySync` is what production passes,
   * and it is rate-limited on its own terms.
   *
   * Absent on a server and in every test that does not care. Called only
   * on a linked device, for the reason the drain is: there is nobody to
   * ask otherwise.
   *
   * Answers whether anything changed, so that an admin publishing
   * reaches a window somebody has open rather than waiting for them to
   * click something. Null is a pass that was skipped by its own rate
   * limit, which is most of them.
   */
  policySync?: (reason?: SyncReason) => Promise<{ changed: boolean } | null>;
  /**
   * This machine's attachment store (EO-324).
   *
   * What a file posted here is read from on its way to the record, and
   * what a file from another desktop is written into. Absent, files do
   * not travel and everything else does — which is the honest
   * degradation for a process that has nowhere to keep one.
   */
  attachments?: RecordAttachmentStore;
}

/** What a pass over nothing answers: a solo desktop has no record to settle with. */
const NOTHING_TO_SYNC: DrainResult = { sent: 0, superseded: 0, refused: 0, runEvents: 0, pulled: 0, files: 0, offline: false };

export function createDeviceRecord(options: DeviceRecordOptions): DeviceRecord {
  const { db } = options;
  /**
   * The replica, and in solo mode simply the record.
   *
   * `recordFor` rather than a fresh one, because the IPC commands reach
   * the same memoised instance and two records over one database would
   * be two names for one thing.
   */
  const local: LocalItemRecord = recordFor(db);
  const remote: RemoteRecord = createRemoteRecord({
    db,
    local,
    transport: options.transport,
    deviceId: options.deviceId(),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onSyncChange === undefined ? {} : { onSyncChange: options.onSyncChange }),
  });

  /**
   * Which record is in force, and the one piece of tidying the switch
   * owes.
   *
   * Signing out leaves "offline since 09:12" behind it otherwise: the
   * outage was real, and then the relationship it was about ended. A
   * line about being out of touch with a record this machine no longer
   * has is the kind of stale sentence a person cannot act on or
   * dismiss.
   */
  function current(): ItemRecord {
    if (remote.linked()) return remote;
    forgetSyncState(db);
    return local;
  }

  /**
   * Whether the record owns this item's rows — and it is not a question
   * about the network.
   *
   * `movedToTheRecord` first, and *unconditionally*, which is the
   * review's finding. The rest of this file asked "has this machine a
   * transport" before it asked anything else, so a desktop that signed
   * out — or one an admin revoked — answered "local" for every item it
   * held, including the projects it had handed over. Those projects
   * then ran here again: offered to the local scheduler, moved by the
   * local writer, pushed to somebody's tracker. A one-way move undone
   * by forgetting a password, and two writers for one item, which is
   * the one thing invariant #1 cannot survive.
   *
   * So a project somebody moved stays the record's for ever. What a
   * missing transport costs is *reach*, not ownership: this machine
   * cannot ask for work, cannot send what it has, and says so on the
   * sync line — and nothing about that makes it the writer again.
   *
   * The second half is EO-324's and is still a question about the
   * network: an item on no project at all belongs to the record while
   * this machine *has* one, and is an ordinary local item on a desktop
   * that never signed in to anything.
   *
   * And none of it on the record itself, which is `isTheRecord`: a
   * server holds moved projects too, and answering "somebody else owns
   * these" there would have it suppress the tracker pushes it is the
   * only one able to make.
   */
  function theRecordOwns(itemId: Uuid): boolean {
    // Never, where this process is the record: it cannot be somebody
    // else's replica of its own rows.
    if (options.isTheRecord === true) return false;
    return movedToTheRecord(db, itemId) || (remote.linked() && onTheRecord(db, itemId));
  }

  /** …and which record that is, as something to call. */
  function recordOwning(itemId: Uuid): ItemRecord {
    // The one piece of tidying the switch owes: a line about being out
    // of touch with a record this machine no longer has is a stale
    // sentence nobody can act on. The *ownership* below is untouched by
    // it — see `theRecordOwns`.
    if (!remote.linked()) forgetSyncState(db);
    // The remote record with no transport answers nothing and writes
    // through to the replica, which is what a moved project's rows
    // need: applied here, queued there, and the record's to confirm
    // whenever this machine can reach it again.
    return theRecordOwns(itemId) ? remote : local;
  }

  /**
   * Which record holds a project's memory (EO-482): the organisation's
   * for a project somebody moved — `theRecordOwns`' rule, asked of a
   * project — and this database's for anything else, including on the
   * record itself.
   */
  function recordHoldingMemoryOf(projectId: string | null | undefined): ItemRecord {
    if (options.isTheRecord === true || projectId === null || projectId === undefined) return local;
    return projectMovedToTheRecord(db, projectId as Uuid) ? remote : local;
  }

  /**
   * Which record holds a pipeline's template update (EO-534), by where
   * the pipeline is held now: the organisation's for one its record
   * holds, while this desktop can ask it; this database for anything
   * else, and on the record itself.
   *
   * Never by which conflicts this database happens to hold. One recorded
   * here before the record took the pipeline over is an obsolete hold —
   * the record compares the pipeline now, and its conflict is the update
   * — so it must not shadow the record's (`retireObsoleteHolds` closes
   * it). Signed out, a pipeline the record holds is answered here, which
   * says nobody who could answer was asked.
   */
  function recordHoldingUpdateOf(pipelineId: string): ItemRecord {
    if (options.isTheRecord === true || !heldByTheRecord(db, pipelineId)) return local;
    return remote.linked() ? remote : local;
  }

  /** The project a write is about: the run's item's, the scope's, or the entry's. */
  function projectOfWrite(request: MemoryWriteRequest): string | null | undefined {
    switch (request.op) {
      case "note":
        return request.item.projectId;
      case "add":
        return memoryScopeProjectId(db, request.scope);
      default:
        return memoryEntryProjectId(db, request.id);
    }
  }

  /** The claims this device holds, split by whose record is meant to be holding them. */
  function split(itemIds: readonly Uuid[]): { managed: Uuid[]; kept: Uuid[] } {
    const managed: Uuid[] = [];
    const kept: Uuid[] = [];
    for (const itemId of itemIds) (theRecordOwns(itemId) ? managed : kept).push(itemId);
    return { managed, kept };
  }

  /**
   * …and that these tables are a copy of the record rather than the
   * record (EO-324, `recordRole.ts`).
   *
   * One consequence, and it is the one the design needs: nothing here pushes
   * to anybody's tracker. A move on this machine is provisional until
   * the record accepts it, and Jira has no word for provisional — so
   * the record does it, once, rather than this machine doing it early
   * and every other machine doing it again on the pull.
   */
  const stopBeingAReplica = markReplica(db, (itemId) => (itemId === undefined ? remote.linked() : theRecordOwns(itemId)));

  /**
   * Everything written against this database, on its way to the record.
   *
   * Installed here because here is where both halves of the question
   * are known: whether this machine has a record (`remote.linked()`)
   * and which database is its replica. `outbound.ts` is where the
   * argument for a subscription rather than a threaded object lives —
   * the short version is that a hundred and twenty-eight places write a
   * comment, and a device that missed one would be silently not what
   * the organisation's board says.
   *
   * A solo desktop installs it too and queues nothing, because
   * `linked()` is false. That is one code path rather than two, which
   * is what the design asks of every part of this.
   */
  const stopQueueing = queueOutbound({
    db,
    // Whose the item is, not whether this machine can reach anybody
    // (EO-325). A desktop that signed out still holds projects it
    // handed over, and a comment written on one of them is the
    // record's to apply — so it is queued now and replayed when a
    // credential comes back, rather than landing here as though the
    // move had been undone.
    linked: (itemId) => theRecordOwns(itemId),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onSyncChange === undefined ? {} : { onQueued: options.onSyncChange }),
  });

  /** The last drain handed out; the next waits for it (EO-456). */
  let draining: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = draining.then(work, work);
    draining = next.catch(() => undefined);
    return next;
  }

  async function syncNow(reason: SyncReason): Promise<DrainResult> {
    if (!remote.linked()) return NOTHING_TO_SYNC;
    const drained = await drainToRecord({
      db,
      record: remote,
      local,
      deviceId: options.deviceId(),
      ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
      ...(options.pullPageSize === undefined ? {} : { pullPageSize: options.pullPageSize }),
      ...(options.onSyncChange === undefined ? {} : { onChange: options.onSyncChange }),
      ...(options.onRunEvents === undefined ? {} : { onRunEvents: options.onRunEvents }),
    });
    // After the drain and never instead of it, and inside a boundary
    // of its own. A policy that could not be fetched — or a publish
    // this database refused to apply — must not be able to stop this
    // device shipping what it did, which is the promise the design makes and
    // one a guard fed by a slightly stale policy keeps perfectly well.
    try {
      const policy = await options.policySync?.(reason);
      // Only on a real change: a push a minute, every minute, on every
      // desktop, for a policy nobody touched would be EO reporting its
      // own timer. `config:changed` is what the budget line, the
      // runtime picker and the secret rows all listen to.
      if (policy?.changed === true) options.onSyncChange?.();
    } catch (error) {
      console.warn(`[eo] the organisation's policy could not be applied: ${String(error)}`);
    }
    return drained;
  }

  return {
    linked: () => remote.linked(),

    stop: () => {
      stopQueueing();
      stopBeingAReplica();
    },

    // One drain at a time (EO-456): a watch's flush can arrive while
    // the tick's own sync is replaying the same queue, and two passes
    // over one queue would send its rows twice and race on the cursors.
    flush: () =>
      exclusive(async () => {
        if (!remote.linked()) return NOTHING_TO_SYNC;
        return drainToRecord({ db, record: remote, local, deviceId: options.deviceId(), queueOnly: true });
      }),

    sync: (reason: SyncReason = "polling") => exclusive(() => syncNow(reason)),

    /**
     * What this machine may run: what the record leased it, and what it
     * still schedules for itself.
     *
     * Both, in that order, and the order matters because capacity is
     * finite. The organisation's work is asked for first and whatever
     * is left over goes to the projects the person kept — which is the
     * right way round: a desktop that filled its one slot with its own
     * work before asking would be a device that is signed in and
     * quietly unavailable.
     *
     * A solo desktop, and one whose record is unreachable, takes the
     * first branch of `current()` and this reads exactly as it did
     * before EO-325.
     */
    /**
     * What one person has spent today, from whichever record owns the
     * answer (EO-328, ARCHITECTURE.md, "Policy", review).
     *
     * `remote` while this machine is linked, because the organisation's
     * record is the only thing that sees every device's runs — which is
     * the whole point of asking it rather than this replica. `local`
     * otherwise, where this process *is* the record and its own sum is
     * the person-wide total.
     *
     * Not routed per item like the calls below it: a person's day spans
     * their projects, and a machine that kept one project and moved
     * another has one budget rather than two. The organisation's record
     * is the one that has a ceiling at all.
     */
    personSpendToday: (personId, since) => (remote.linked() ? remote : local).personSpendToday(personId, since),

    async offerWork<R extends DispatchRefusal>(input: OfferWorkInput<R>): Promise<WorkOffer[]> {
      if (!remote.linked()) {
        /**
         * Everything except what was handed over.
         *
         * A desktop with no record to ask runs its own work, which is
         * solo mode and is every installation that never signed in to
         * anything. What it must not run is a project somebody moved:
         * the record schedules that, this machine is a replica of it,
         * and dispatching an agent into it here would be the second
         * writer a move exists to remove. Signing out is a long
         * outage, not a way back.
         */
        const moved = itemsOnMovedProjects(db);
        const mine =
          moved.size === 0 ? input.tickInput : { ...input.tickInput, items: input.tickInput.items.filter((item) => !moved.has(item.id)) };
        return current().offerWork({ ...input, tickInput: mine });
      }

      const fromTheRecord = await remote.offerWork(input);
      // Nought is still asked for: work no cap holds back is offered past
      // it (EO-616). Null is a process that runs nothing.
      if (input.capacity === null) return fromTheRecord;
      const spare = Math.max(0, input.capacity - fromTheRecord.length);

      // Only the items on projects this machine kept. The rest of the
      // tick input is left whole on purpose: the concurrency caps and
      // the active runs are the *machine's*, and a local scheduler that
      // could not see the organisation's running dispatch would start a
      // second one beside it.
      const mine = locallyScheduledItemIds(db);
      if (mine.size === 0) return fromTheRecord;
      const locally = await local.offerWork({
        ...input,
        capacity: spare,
        tickInput: { ...input.tickInput, items: input.tickInput.items.filter((item) => mine.has(item.id)) },
      });
      return [...fromTheRecord, ...locally];
    },

    /**
     * The claims this device is still working under, renewed with
     * whichever record granted each one.
     *
     * Split rather than sent wholesale, because a record asked to renew
     * a claim on an item it has never heard of answers that the device
     * does not hold it — and the device would then forget a lease that
     * is perfectly good, leaving the item claimed in its own database
     * until the claim expired and a comment said its machine had gone
     * quiet. Which is a machine talking about itself in the third
     * person.
     */
    async renewClaims(deviceId: string, itemIds: readonly Uuid[]): Promise<DispatchLease[]> {
      if (!remote.linked()) return current().renewClaims(deviceId, itemIds);
      const { managed, kept } = split(itemIds);
      const [there, here] = await Promise.all([remote.renewClaims(deviceId, managed), local.renewClaims(deviceId, kept)]);
      return [...there, ...here];
    },

    releaseLease: (lease: DispatchLease): Promise<void> => recordOwning(lease.itemId).releaseLease(lease),

    /**
     * Everything this device left behind it, on both sides.
     *
     * Asked of both, because a process that died mid-run may have been
     * holding one claim of each kind and a sweep that covered one would
     * leave the other standing for the length of its term.
     */
    async releaseLeasesOf(deviceId: string, stillHeld?: Iterable<Uuid>): Promise<DispatchLease[]> {
      if (!remote.linked()) return current().releaseLeasesOf(deviceId, stillHeld);
      const held = [...(stillHeld ?? [])];
      const { managed, kept } = split(held);
      const [there, here] = await Promise.all([remote.releaseLeasesOf(deviceId, managed), local.releaseLeasesOf(deviceId, kept)]);
      return [...there, ...here];
    },

    // Whichever record owns the item the run is on (EO-433): this
    // database for a project kept here, the organisation's for one it
    // holds — where "cannot be reached" is a refusal, not a local write.
    createItemFromModule: (request) => recordOwning(request.item.id as Uuid).createItemFromModule(request),

    // Whichever record owns the item (EO-600): this database for one
    // kept here, the organisation's for one it holds — where "cannot be
    // reached" is a refusal, not a local write.
    changeDependencies: (request) => recordOwning(request.itemId).changeDependencies(request),

    // The record that holds the type's project (EO-735): the
    // organisation's for a project moved to it, where "cannot be reached"
    // is a refusal rather than a local write; this database for one kept
    // here, for the installation's own types and on the record itself.
    updateItemType: (request) => {
      const projectId = getItemType(db, request.id as Uuid)?.projectId ?? null;
      const onTheRecord = options.isTheRecord !== true && projectId !== null && projectMovedToTheRecord(db, projectId);
      return (onTheRecord ? remote : local).updateItemType(request);
    },

    // The record that owns the project (EO-471). A project somebody
    // moved is the record's for ever, for `theRecordOwns`' reason, so a
    // desktop that has signed out is refused here rather than making a
    // thread the organisation would never see.
    projectThread: (projectId: Uuid) =>
      (options.isTheRecord !== true && projectMovedToTheRecord(db, projectId) ? remote : local).projectThread(projectId),

    // A message about a project (EO-726) is the organisation's record's
    // when the record holds the project, for `projectThread`'s reason:
    // addressed there to each admin, and refused rather than written
    // here when it cannot be reached — a desktop that has signed out
    // included. On the record itself it goes to the admins at once.
    // Anything else is this database's, to the recipient named.
    sendMessage: async (input) => {
      const projectId = input.projectId ?? null;
      if (projectId === null) return local.sendMessage(input);
      if (options.isTheRecord === true) return { ok: true, messages: sendMessageToAdmins(db, input) };
      return (projectMovedToTheRecord(db, projectId as Uuid) ? remote : local).sendMessage(input);
    },
    // …and answered or dismissed where it lives: a message this replica
    // copied from the record, about a project the record holds, on the
    // record; any other here.
    handleMessage: (request) => {
      const projectId = getMessage(db, request.messageId)?.projectId ?? null;
      const onTheRecord = options.isTheRecord !== true && projectId !== null && projectMovedToTheRecord(db, projectId as Uuid);
      return (onTheRecord ? remote : local).handleMessage(request);
    },

    // The record that holds the conflict (EO-533). One this database
    // holds is its own — a desktop's pipeline, or the server's — and is
    // answered here; any other is the organisation's, whose notice this
    // desktop was told, and is asked of it while there is one to ask.
    // Signed out, it is answered here too, which says it is not held.
    updateConflictChat: (request) =>
      (options.isTheRecord === true || getUpdateConflict(db, request.conflictId) !== undefined || !remote.linked() ? local : remote).updateConflictChat(request),

    // The record that holds a pipeline's update (EO-534), by the same
    // rule: an update this database holds is its own; one on a pipeline
    // the organisation's record holds is asked of it while there is one
    // to ask. Signed out, it is answered here, which says so.
    updateConflict: (request) => recordHoldingUpdateOf(request.pipelineId).updateConflict({ ...request, onTheRecord: options.isTheRecord === true }),
    resolveUpdateConflict: (request) => recordHoldingUpdateOf(request.pipelineId).resolveUpdateConflict({ ...request, onTheRecord: options.isTheRecord === true }),
    // And a pipeline's template origin and update state (EO-536), for the same reason.
    templateStatus: (request) => recordHoldingUpdateOf(request.pipelineId).templateStatus({ ...request, onTheRecord: options.isTheRecord === true }),

    // The record that holds the project the memory is of (EO-482). A
    // project somebody moved is the record's for ever, for
    // `theRecordOwns`' reason, so a desktop that has signed out is
    // refused rather than writing memory the organisation would never
    // see — and every desktop is given.
    writeMemory: (request: MemoryWriteRequest) => recordHoldingMemoryOf(projectOfWrite(request)).writeMemory(request),
    memoryConsolidations: (scope) => recordHoldingMemoryOf(memoryScopeProjectId(db, scope)).memoryConsolidations(scope),
    restoreMemoryConsolidation: (consolidationId, caps) => {
      // A consolidation this replica holds is one it made itself, of a
      // scope it can place. Any other is the record's, if this desktop
      // has one: consolidation of a moved project runs there.
      const held = getConsolidation(db, consolidationId);
      if (held !== undefined) return recordHoldingMemoryOf(memoryScopeProjectId(db, held.scope)).restoreMemoryConsolidation(consolidationId, caps);
      return (options.isTheRecord !== true && remote.linked() ? remote : local).restoreMemoryConsolidation(consolidationId, caps);
    },

    // The record that holds the skill (EO-728): one of a moved project's,
    // or one its published packs section carries, is restored there — and
    // refused rather than restored here when it cannot be reached, since
    // the record's next copy would undo it. Any other is this database's.
    restoreSkillVersion: (request) =>
      (options.isTheRecord !== true && skillHeldByTheRecord(db, request.id) ? remote : local).restoreSkillVersion(request),

    applyTransition: (command: TransitionCommand): Item => recordOwning(command.itemId).applyTransition(command),
    appendRunEvent: (runId: Uuid, type: string, payload: unknown): void => current().appendRunEvent(runId, type, payload),
    postComment: (input: PostCommentInput): Comment => recordOwning(input.itemId).postComment(input),
  };
}
