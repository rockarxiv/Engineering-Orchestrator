import { postModuleCreation } from "../modules/moduleCreations.js";
import { tick as schedule, type Dispatch, type DispatchRefusal, type TickInput } from "@eo/engine";
import { DEFAULT_JOB_RUNS_ON, skillAuthorFromActingAgent, type Comment, type Item, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { postComment, type PostCommentInput } from "../db/repos/commentsRepo.js";
import { appendRunEvent } from "../db/repos/runEventsRepo.js";
import { transitionItem } from "../db/repos/transitionsRepo.js";
import {
  grantLease,
  leaseFor,
  listExpiredLeases,
  releaseDeviceLeases,
  releaseLease,
  renewLease,
  type DispatchLease,
} from "../db/repos/leasesRepo.js";
import { personCostCentsSince } from "../db/repos/runsRepo.js";
import { serverPlacedItemIds } from "../db/repos/jobsRepo.js";
import { overPersonBudgetForItem, readPolicy } from "../policy/policy.js";
import { parkForPersonBudget } from "../policy/personBudget.js";
import { openProjectThread } from "../projects/projectThread.js";
import { handleMessageHere, sendMessage } from "../messages/messages.js";
import { changeDependenciesOf, summariseDependencyChange } from "../roles/itemDependencies.js";
import { updateItemTypeCommand } from "../ipc/itemTypeCommands.js";
import { openUpdateConflictChat } from "../roles/updateConflictChat.js";
import { describeUpdateConflict, resolveUpdateConflictHere } from "../gallery/updateConflictDetail.js";
import { describeTemplateStatus } from "../gallery/templateStatus.js";
import { listConsolidations, restoreConsolidation, restoreSkillVersion } from "../db/repos/index.js";
import { A_PERSON, applyMemoryWrite } from "../memory/memoryWrites.js";
import type { ItemRecord, OfferWorkInput, TransitionCommand, WorkOffer } from "./record.js";

/**
 * How long a claim stands without being renewed.
 *
 * Long against the tick interval (five seconds) and short against a
 * run, which is the shape the two failure modes ask for: a device
 * renews every tick, so an expiry means sixty consecutive ticks did not
 * happen — a process that is gone, not one that is busy — and an item
 * whose machine really did disappear waits five minutes rather than
 * forever.
 */
export const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

export interface LocalRecordOptions {
  /** The record's clock. Injectable so a test can hold it still and step it. */
  now?: () => number;
  leaseTtlMs?: number;
}

/**
 * The record's own housekeeping, where the record is in this process.
 *
 * Everything on `ItemRecord` is something a device may ask of a record
 * wherever it lives. These four are what a record does *to itself*: it
 * sweeps the claims nobody renewed, it decides whose turn it is, it
 * grants and it renews. A device never calls them — on a server they
 * happen on the other side of a socket, and the interface is the whole
 * of what crosses it.
 *
 * They are on the local record's own type rather than on `ItemRecord`
 * because a remote record cannot honestly implement them. `pick`
 * returning an empty array from a desktop that is not the scheduler
 * would be a lie with the same shape as the truth, and a lie shaped
 * like "there is nothing to do" is the one this phase most has to
 * avoid.
 */
export interface LocalItemRecord extends ItemRecord {
  /**
   * One housekeeping pass, before anything is picked.
   *
   * What it does today is release the leases whose devices stopped
   * saying they were still working, each with a comment naming the
   * device that held it (invariant #8: every guard ends in a comment).
   * A dispatch that vanished with its machine is work dropped on the
   * floor, and an item that silently stopped being offered is the one
   * failure a lease with no sweep would introduce.
   *
   * Returns what it released, so a caller can say so; nothing needs to.
   */
  tick: (at?: number) => DispatchLease[];
  /**
   * What may be dispatched: an item, the step it sits on, and the role
   * that staffs it.
   *
   * The engine's scheduler answers the first question — whose turn is
   * it — and the record answers the second, which is new here: an item
   * a device has already claimed is not offered to anybody. In one
   * process that is what the item lock already made true; across two it
   * is the only thing that does.
   */
  pick: <R extends DispatchRefusal>(input: TickInput<R>, at?: number) => Dispatch[];
  /**
   * Claim an item for a device, for as long as the lease says.
   *
   * `null` is a refusal and not an event: the claiming device has
   * written nothing and moved nothing, and the next tick offers the
   * same item again.
   */
  grantLease: (input: { itemId: Uuid; deviceId: string; ttlMs?: number }) => DispatchLease | null;
  /** Push a claim a device already holds out again, while it is still working. */
  renewLease: (lease: DispatchLease) => DispatchLease | null;
  /** The claim standing on this item, expired or not. */
  leaseFor: (itemId: Uuid) => DispatchLease | null;
}

/**
 * The record, wrapping this installation's own database (EO-322).
 *
 * "Local" is where the record *lives*, not what it does: it is the same
 * record a server keeps in managed mode, and the same interface the
 * device talks to either way. Everything it holds is in SQLite — there
 * is no state in this closure — which is what makes it safe for the
 * composition root to hand the same one to the supervisor and the IPC
 * commands.
 *
 * On a desktop signed in to an organisation this is not the record but
 * the **replica**: the same statements against the same tables, holding
 * what the record has confirmed plus what this device has done and not
 * had confirmed yet. `remoteRecord.ts` is what wraps it there, and the
 * reason the wrapping is possible at all is that the record's writes
 * are these writes — one code path, as the design asks for.
 */
export function createLocalRecord(db: Db, options: LocalRecordOptions = {}): LocalItemRecord {
  const clock = options.now ?? ((): number => Date.now());
  const ttlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

  /**
   * The claims whose devices stopped saying they were still working.
   *
   * Released and *said*, which is the half that matters: the device
   * that held this item is gone, so whatever it was doing did not
   * finish and nobody was ever told. The comment names the device,
   * because on a managed record that is the only thing that identifies
   * which machine went quiet.
   */
  function releaseExpired(at: number): DispatchLease[] {
    const expired = listExpiredLeases(db, at);
    for (const lease of expired) {
      // The delete first, so a comment that somehow throws cannot leave
      // the item claimed by a device that no longer exists.
      releaseLease(db, lease.itemId, lease.deviceId);
      postComment(db, {
        itemId: lease.itemId,
        author: { type: "engine" },
        // Written without the word for the entity, deliberately: what a
        // person calls one of these is the installed pack's to say
        // (ARCHITECTURE.md, "What a pack labels"), and the core has no business spelling it.
        body:
          `Device "${lease.deviceId}" claimed this work and then stopped saying it was still on it, ` +
          `so the claim has expired. EO has released it, and this work can be picked up again.`,
      });
    }
    return expired;
  }

  function pick<R extends DispatchRefusal>(input: TickInput<R>, at?: number): Dispatch[] {
    const now = at ?? clock();
    // The engine's scheduler decides whose turn it is, and this
    // decides nothing: an item under a live claim is one a device is
    // already working on, and offering it again is how two agents end
    // up in one checkout. The claim is read per dispatch rather than
    // listed up front because `tick()` returns one dispatch per
    // capacity slot, which is one at the default concurrency.
    return schedule(input).filter((dispatch) => {
      const lease = leaseFor(db, dispatch.item.id);
      // Expired *at* the deadline, which is the boundary every other
      // reading of `expires_at` uses: this runs a line after the
      // sweep, off the same clock, and the two disagreeing by a
      // millisecond is an item the sweep called dead and the pick
      // called claimed.
      return lease === null || lease.expiresAt <= now;
    });
  }

  function claim(itemId: Uuid, deviceId: string, ttl?: number): DispatchLease | null {
    return grantLease(db, { itemId, deviceId, now: clock(), ttlMs: ttl ?? ttlMs });
  }

  /**
   * **The record places work as well as scheduling it** (EO-330, ARCHITECTURE.md, "Where a job
   * runs").
   *
   * A job a person put on the organisation server is offered to the
   * server and to nothing else; everything else — every item somebody
   * filed by hand, and every job that stayed on a desktop — is offered
   * only to desktops.
   *
   * ### Why this is before the scheduler and not after it
   *
   * `tick()` returns one dispatch per capacity slot, which is one at
   * the concurrency EO ships (invariant #10). Placing *its answer*
   * would mean the board's first eligible item spends the only slot
   * there is and is then thrown away for being somebody else's — so a
   * server with one desktop item standing unclaimed would be offered
   * nothing, on every tick, for as long as it stood there. Which is
   * exactly the situation the story's third acceptance criterion is
   * about: no desktop online, and their work waiting.
   *
   * ### Why `heldItemIds` and not `items`
   *
   * Dropping the rows would resolve dependencies against a board with
   * holes in it. `tick()` reads a dependency's own step to decide
   * whether it is finished, and an item it cannot find reads as
   * unfinished — so a desktop's item waiting on a server's would go on
   * being blocked after the server had finished it. `heldItemIds` says
   * the narrower and truer thing: still there, still on its step, not a
   * candidate for *this* machine.
   *
   * Silent, and this is the one guard in this pass that is allowed to
   * be. Invariant #8 is about work dropped where nobody is looking;
   * this is the opposite — the item is being *kept* for the machine
   * that can do it, and that machine is offered it on its next tick. A
   * comment here would post once a second, on every item, for as long
   * as two machines were asking.
   */
  function placed<R extends DispatchRefusal>(input: OfferWorkInput<R>): TickInput<R> {
    const onTheServer = serverPlacedItemIds(db);
    const asking = input.runsOn ?? DEFAULT_JOB_RUNS_ON;
    // Nothing anywhere is placed on a server, and a desktop is asking:
    // the input is already the answer. Every solo installation is here,
    // on every tick, and this is what keeps placement from costing them
    // a set copy and a pass over the board to change nothing.
    if (asking === "device" && onTheServer.size === 0) return input.tickInput;
    const elsewhere = (itemId: string) => (asking === "server" ? !onTheServer.has(itemId) : onTheServer.has(itemId));
    const held = new Set(input.tickInput.heldItemIds);
    for (const item of input.tickInput.items) if (elsewhere(item.id)) held.add(item.id);
    return { ...input.tickInput, heldItemIds: held };
  }

  return {
    tick: (at) => releaseExpired(at ?? clock()),

    pick,

    grantLease: (input) => claim(input.itemId, input.deviceId, input.ttlMs),

    renewLease: (lease) => renewLease(db, { itemId: lease.itemId, deviceId: lease.deviceId, now: clock(), ttlMs }),

    leaseFor: (itemId) => leaseFor(db, itemId),

    /**
     * The record's three steps, in the one order that is safe, behind
     * one door (EO-324).
     *
     * Sweep, pick, claim — which is exactly what the supervisor's tick
     * used to do across three statements of its own. Moving it here is
     * the whole of what makes a server possible: the sequence is now
     * something a record performs rather than something a device
     * performs *on* a record, so a device that is not the record simply
     * has no version of it to run.
     *
     * The sweep comes first so an item whose machine went quiet is
     * offered again on the same tick rather than the next one. The
     * claim comes with the offer, not after it, because a pick that is
     * not also a claim is a window two devices can both be offered in.
     *
     * An item the record offered and could not then claim is silently
     * dropped from the answer, which is what losing a race has always
     * been: nothing has been written, nothing has moved, and the next
     * tick offers the same item again.
     */
    async offerWork<R extends DispatchRefusal>(input: OfferWorkInput<R>): Promise<WorkOffer[]> {
      const at = input.at ?? clock();
      releaseExpired(at);
      // The sweep happens either way; the pick does not. A caller that
      // can run nothing — a server, which is the record and not a device —
      // is asking for the housekeeping and nothing else, and running
      // the scheduler over a board to discard its answer would be work
      // done to be thrown away. A device with no capacity left still
      // picks: work no cap holds back is offered past it (EO-616).
      if (input.capacity === null) return [];
      const offers: WorkOffer[] = [];
      // Read once for the pass rather than per candidate: a policy that
      // publishes no ceiling never reaches a sum at all, and one that
      // does would otherwise re-read the same row for every item on the
      // board.
      const policy = readPolicy(db);
      const uncapped = input.tickInput.uncappedRoles;
      for (const dispatch of pick(placed(input), at)) {
        // Past the capacity it has already been counted in, so what is
        // offered this way leaves that much less for everything else.
        if (offers.length >= input.capacity && !(dispatch.agent !== null && uncapped?.has(dispatch.agent.role))) continue;
        // **The record does not lease out work it knows must not run**
        // (EO-328, ARCHITECTURE.md, "Policy", review). This is the boundary that makes the
        // per-person budget a *person's* rather than a machine's: the
        // record sees every device's runs, so a second desktop asking
        // for work after the first has spent the day is refused here
        // even though its own replica has no idea.
        //
        // And it speaks, because a guard that silently withheld would
        // be work dropped on the floor (invariant #8). The device's own
        // pre-dispatch guard says the same thing when it gets there
        // first, which is why the sentence has one owner —
        // `parkForPersonBudget` writes it once per unanswered mention.
        const overspent = overPersonBudgetForItem(db, policy, dispatch.item.id, at);
        if (overspent !== null) {
          parkForPersonBudget(db, dispatch.item.id, overspent);
          continue;
        }
        const lease = claim(dispatch.item.id, input.deviceId);
        if (lease !== null) offers.push({ dispatch, lease });
      }
      return offers;
    },

    async personSpendToday(personId, since) {
      return personCostCentsSince(db, personId as Uuid, since);
    },

    async renewClaims(deviceId, itemIds) {
      const held: DispatchLease[] = [];
      for (const itemId of itemIds) {
        const standing = leaseFor(db, itemId);
        if (standing === null || standing.deviceId !== deviceId) continue;
        const renewed = renewLease(db, { itemId, deviceId, now: clock(), ttlMs });
        if (renewed !== null) held.push(renewed);
      }
      return held;
    },

    async releaseLease(lease) {
      releaseLease(db, lease.itemId, lease.deviceId);
    },

    async releaseLeasesOf(deviceId, stillHeld) {
      return releaseDeviceLeases(db, deviceId, stillHeld);
    },

    // Here, because this database is the record for these rows
    // (EO-433). The same function a server runs when a device asks it,
    // which is what makes the guards one set.
    async createItemFromModule(request) {
      return postModuleCreation(db, { module: request.module, item: request.item, runId: request.runId }, request.creation, {
        atCap: request.atCap,
        ...(request.onCreated === undefined ? {} : { onCreated: request.onCreated }),
      });
    },

    // Here, because this database is the record for these rows
    // (EO-600) — and the same function a server runs when a device asks.
    async changeDependencies(request) {
      const changed = changeDependenciesOf(db, request.itemId, { add: request.add, remove: request.remove }, request.by, request.why ?? null);
      if (!changed.ok) return { ok: false, problem: changed.reason };
      return { ok: true, dependencies: changed.applied === null ? null : summariseDependencyChange(changed.applied) };
    },

    // Here, because this database holds the type (EO-735) — and the
    // same command a server runs when a device asks.
    async updateItemType(request) {
      return updateItemTypeCommand(db, request);
    },

    // Here, because this database is the record for these rows
    // (EO-471) — and the same function a server runs when a device asks.
    async projectThread(projectId) {
      return openProjectThread(db, projectId);
    },

    // Here, because this database holds the message (EO-726): a solo
    // desktop's, a kept project's, or the record's own. `DeviceRecord`
    // addresses a record-held project's to its admins before it gets here.
    async sendMessage(input) {
      return { ok: true, messages: [sendMessage(db, input)] };
    },

    async handleMessage(request) {
      return handleMessageHere(db, request);
    },

    // Here, because this database holds the conflict (EO-533) — a
    // desktop's own pipeline, or the record's — and the same function a
    // server runs when a device asks.
    async updateConflictChat(request) {
      return openUpdateConflictChat(db, request);
    },

    // Here, for the same reason (EO-534): this database holds the
    // conflict, and these are the functions a server runs when a device
    // asks.
    async updateConflict(request) {
      return describeUpdateConflict(db, request.pipelineId, { onTheRecord: request.onTheRecord });
    },
    async templateStatus(request) {
      return describeTemplateStatus(db, request.pipelineId, request.history, { onTheRecord: request.onTheRecord });
    },
    async resolveUpdateConflict({ onTheRecord, createdBy, ...request }) {
      return resolveUpdateConflictHere(db, request, createdBy, { onTheRecord });
    },

    // Here, because this database holds the project's memory (EO-482) —
    // a solo desktop's, a project kept on one, or the organisation's own
    // on its server. Sync, so a write lands before the promise is handed
    // back, and never rejects: a refusal is an answer.
    async writeMemory(request) {
      try {
        return applyMemoryWrite(db, request, A_PERSON);
      } catch (error) {
        return { ok: false, problem: `EO could not write that memory entry: ${error instanceof Error ? error.message : String(error)}` };
      }
    },

    async memoryConsolidations(scope) {
      return listConsolidations(db, scope);
    },

    async restoreMemoryConsolidation(consolidationId, caps) {
      return restoreConsolidation(db, consolidationId, { caps });
    },

    // Here, because this database holds the skill (EO-728): a solo
    // desktop's, a kept project's, this desktop's own, or the record's own.
    async restoreSkillVersion(request) {
      const result = restoreSkillVersion(db, request.id, request.versionId, Date.now(), skillAuthorFromActingAgent(request.actingAgentId));
      return result.ok ? { skill: result.skill, problem: null } : { skill: null, problem: result.problem };
    },

    applyTransition: (command: TransitionCommand): Item => transitionItem(db, command),

    appendRunEvent: (runId: Uuid, type: string, payload: unknown): void => {
      appendRunEvent(db, runId, type, payload);
    },

    postComment: (input: PostCommentInput): Comment => postComment(db, input),
  };
}

/**
 * One record per database.
 *
 * The record *is* the database's item state, so two of them over one
 * file would be two names for one thing rather than two things. Memoised
 * rather than constructed at each call site for that reason and not for
 * cost: `createLocalRecord` holds nothing, and the point is that the IPC
 * command behind a drag and the supervisor that ran the agent are
 * talking to the same record.
 *
 * The composition root (`engine.ts`) asks for it once and hands it to
 * the supervisor; the IPC commands ask for it here because they are
 * handed a `Db` and no engine — a person can move a card on a desktop
 * whose engine is paused, and that move is still a command the record
 * applies.
 *
 * **In managed mode this is the replica and not the record**, and the
 * difference is one wrapper: `recordFor` still answers the thing that
 * writes these tables, and `managedRecordFor` in `remoteRecord.ts` is
 * what turns a write into a write *plus a command*. Nothing that holds
 * a `Db` and no session has any business deciding which of the two it
 * is in, so nothing here does.
 */
const records = new WeakMap<object, LocalItemRecord>();

export function recordFor(db: Db): LocalItemRecord {
  const existing = records.get(db);
  if (existing) return existing;
  const created = createLocalRecord(db);
  records.set(db, created);
  return created;
}
