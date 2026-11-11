import { NO_TEMPLATE_STATUS, type Comment, type IpcChannel, type IpcPayload, type IpcResponse, type Item, type Uuid } from "@eo/core";
import type { Dispatch, DispatchRefusal } from "@eo/engine";
import type { Db } from "../db/client.js";
import { getAgent } from "../db/repos/agentsRepo.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { getItemType, upsertReplicaItemType } from "../db/repos/itemTypesRepo.js";
import { itemTypeViewOf } from "../ipc/itemTypeCommands.js";
import { askAgentAbout, getComment } from "../db/repos/commentsRepo.js";
import { mirrorRecordComment } from "./drain.js";
import { recordAssistBoard } from "../roles/assist.js";
import { upsertReplicaItem } from "../db/repos/replicaRepo.js";
import { forgetMessage, upsertReplicaMessage } from "../db/repos/messagesRepo.js";
import { openMessageOf } from "../messages/messages.js";
import { emitPush } from "../ipc/push.js";
import { getRun, markRunSynced, runSyncBookmark } from "../db/repos/runsRepo.js";
import { listRunEventsFrom } from "../db/repos/runEventsRepo.js";
import { asRunCommand, runCommandId } from "./runCommand.js";
import type { DispatchLease } from "../db/repos/leasesRepo.js";
import type { PostCommentInput } from "../db/repos/commentsRepo.js";
import type { ItemRecord, OfferWorkInput, TransitionCommand, WorkOffer } from "./record.js";
import type { LocalItemRecord } from "./localRecord.js";
import { markOffline, markOnline, type RecordTransport } from "./syncStatus.js";
import { listConsolidations, memoryScopeProjectId, supersedeProblem } from "../db/repos/index.js";
import type { MemoryConsolidationCursor, MemoryConsolidationView, RecordCommand, RecordMemoryWrite, SkillVersion } from "@eo/core";
import type { MemoryWriteRequest } from "./record.js";
import { copyRecordMemories } from "./memoryReplica.js";
import { getSkill, holdSkillCopy, skillVersionOf, upsertReplicaSkill, type SkillVersionContent } from "../db/repos/skillsRepo.js";

/**
 * The record, when it lives on somebody else's machine (EO-324,
 * `ARCHITECTURE.md`, "The record").
 *
 * The same interface the supervisor and the IPC commands already talk
 * to, with a network in the middle and a replica underneath. What it
 * adds is the two halves of the design, and they pull in opposite directions,
 * which is why they are written out here rather than left to a reader
 * to infer.
 *
 * **Asking goes over the wire and does not queue.** `offerWork` and
 * `renewClaims` are questions only the record can answer, and an answer
 * that arrives an hour late is not an answer — a lease granted during
 * an outage would be a claim on work somebody else finished. So a
 * device that cannot reach its record is offered nothing. That is not a
 * degradation to apologise for: it is "offline means finish the run you
 * hold, queue the result, never keep scheduling locally", which is the
 * sentence the design leads with.
 *
 * **Telling is local first and queued always.** A move, a comment, a
 * run: each is written to this device's replica at once — a person
 * pressing Approve is not made to wait on a network, and does not lose
 * the press if there is none — and written to `record_commands` in the
 * same breath. The drain replays the queue in order; the record applies
 * or refuses; only then is the row gone. So a card is **provisional**
 * for exactly as long as it has a command outstanding, which online is
 * a tick and offline is however long the outage lasts. One mechanism,
 * two durations, no special case.
 *
 * ### Why the local write is not a second writer (invariant #1)
 *
 * It is the same writer. `applyTransition` below is the local record's
 * `applyTransition`, which is `transitionItem`, which is still the only
 * function in this codebase that writes `items.stepId` — the
 * architectural test proves it by reading the source. What the record
 * owns is the *decision*, and the decision is what this file does not
 * make: it sends the command, it takes the answer, and where the answer
 * is "the item had already moved" the drain mirrors the record's truth
 * back over this device's guess and tells the person whose move was
 * dropped. Never a silent revert — that is the design's own word for the
 * failure mode, and `drain.ts` is where it is avoided.
 */

export interface RemoteRecordOptions {
  db: Db;
  /**
   * The replica, as the thing that writes it.
   *
   * The local record of this installation. Handed in rather than built
   * here so that the desktop has exactly one of them: the IPC commands
   * reach it through `recordFor(db)` and the supervisor through this,
   * and two would be two answers to "what does this database say".
   */
  local: LocalItemRecord;
  /**
   * How to reach the record, asked afresh every time.
   *
   * A function and not a value because the token behind it can change
   * underneath — a sign-in, a sign-out, a revocation met by some other
   * request — and a transport that closed over a stale one would carry
   * it until the app restarted. `null` means there is nothing to reach,
   * which is a signed-out desktop and is *not* the same as an outage:
   * nothing is marked offline and no line is drawn.
   */
  transport: () => RecordTransport | null;
  /** Which device this is, as the record's Devices list knows it. */
  deviceId: string;
  now?: () => number;
  /** Called when the link changes state, so a screen can be told to ask again. */
  onSyncChange?: () => void;
}

/**
 * What the record answered, or why this device could not hear it.
 *
 * A named type rather than `T | null`, because the two failures are not
 * the same and the caller has to tell them apart: "there is no record
 * to ask" is a solo desktop and says nothing to anybody, while "the
 * record did not answer" is an outage and draws a line.
 */
export type RecordAnswer<T> = { ok: true; data: T } | { ok: false; unreachable: boolean; problem: string };

export interface RemoteRecord extends ItemRecord {
  /** Send one request to the record, marking the link as it goes. For the drain and for tests. */
  ask<K extends IpcChannel>(channel: K, payload: IpcPayload<K>): Promise<RecordAnswer<IpcResponse<K>>>;
  /** Whether there is a record to reach at all — a signed-in desktop, as opposed to a solo one. */
  linked(): boolean;
}

/** How many transcript lines one request carries when a run is sent ahead of its note. */
const RUN_PAGE = 500;

export function createRemoteRecord(options: RemoteRecordOptions): RemoteRecord {
  const { db, local } = options;
  const clock = options.now ?? ((): number => Date.now());

  /**
   * One request, and the bookkeeping that goes with every one.
   *
   * The marking is here rather than at the call sites for the reason
   * `authenticate` calls `seen` inside `server/http.ts`: "when did this
   * device last hear from its record" is a fact about the last request,
   * not about the last time somebody opened a screen, and a caller that
   * forgot to say so would leave the line stale in exactly the case it
   * matters.
   *
   * A refusal the record *did* answer — a 401, a channel it will not
   * serve — counts as reached. The socket worked; what came back was a
   * no. Calling that an outage would put "offline since 09:12" above a
   * board whose real problem is that this device was revoked, and the
   * person would wait for a network that is already working.
   */
  async function ask<K extends IpcChannel>(channel: K, payload: IpcPayload<K>): Promise<RecordAnswer<IpcResponse<K>>> {
    const transport = options.transport();
    if (transport === null) return { ok: false, unreachable: false, problem: "This desktop is not signed in to a record." };
    let answer;
    try {
      answer = await transport.request(channel, payload);
    } catch (error) {
      // A transport that throws rather than answering is the same event
      // as one that answers "could not reach": a client is allowed to
      // be written either way, and a record that is down must not be
      // able to take the tick with it.
      const problem = error instanceof Error ? error.message : String(error);
      if (markOffline(db, clock(), problem)) options.onSyncChange?.();
      return { ok: false, unreachable: true, problem };
    }
    if (answer.ok) {
      if (markOnline(db)) options.onSyncChange?.();
      return { ok: true, data: answer.data };
    }
    // `ServerClient` puts the transport's own failure in the same
    // envelope a handler's refusal arrives in, so the two are told
    // apart by their words rather than by their shape. "EO could not
    // reach" is the sentence it writes for a socket that never opened
    // or a request that timed out, and it is the one that means the
    // link is down.
    const unreachable = answer.error.message.startsWith("EO could not reach");
    if (unreachable && markOffline(db, clock(), answer.error.message)) options.onSyncChange?.();
    return { ok: false, unreachable, problem: answer.error.message };
  }

  /**
   * An offer, resolved against this device's replica.
   *
   * The record sends ids; the rows come from here. That is not a
   * bandwidth argument — it is what keeps the two ends from holding two
   * copies of an item and disagreeing about which is true. An offer
   * naming something this replica has not caught up with yet is
   * dropped: the pull that is about to run will bring it, and the next
   * tick will be offered it again. Dropping it releases nothing, which
   * is correct — the record leased the item to this device, and letting
   * that lease run out is a better failure than dispatching an agent
   * against a row this machine does not have.
   */
  function resolveOffer(offer: { itemId: string; stepId: string; action: string; agentId: string | null }): Dispatch | null {
    const item = getItem(db, offer.itemId as Uuid);
    if (item === undefined) return null;
    const agent = offer.agentId === null ? null : (getAgent(db, offer.agentId as Uuid) ?? null);
    // An agent the record named and this replica does not have is not
    // the same as a builtin step, and must not be flattened into one:
    // `agent === null` means "EO runs one of its own functions here",
    // and running a builtin because a role failed to resolve would be
    // the wrong work rather than no work.
    if (offer.agentId !== null && agent === null) return null;
    return { item, agent, action: offer.action, stepId: offer.stepId };
  }

  /**
   * One run's row and its unsent transcript, to the record now rather
   * than on the next tick (EO-482) — the drain's third step for a single
   * run, through the same `record:apply`, so it is idempotent against
   * the drain sending the same lines: `run_events` is keyed on
   * `(runId, seq)` on both sides. The bookmark moves only on the
   * record's acknowledgement, as the drain's does.
   */
  async function sendRun(runId: Uuid): Promise<{ ok: true } | { ok: false; unreachable: boolean; problem: string }> {
    for (;;) {
      const run = getRun(db, runId);
      const bookmark = runSyncBookmark(db, runId);
      if (run === undefined || bookmark === undefined) return { ok: false, unreachable: false, problem: "this desktop no longer has that run." };
      const events = listRunEventsFrom(db, runId, bookmark.syncedSeq + 1, RUN_PAGE);
      if (events.length === 0 && bookmark.syncedStatus === run.status) return { ok: true };
      const commands: RecordCommand[] = [asRunCommand(run, runCommandId(run.id, run.status), 0)];
      if (events.length > 0) {
        commands.push({
          kind: "runEvents",
          id: `${run.id}:events:${String(bookmark.syncedSeq + 1)}`,
          runId: run.id,
          itemId: run.itemId,
          events: events.map((event) => ({ seq: event.seq, ts: event.ts, type: event.type, payload: event.payload })),
        });
      }
      const answer = await ask("record:apply", { deviceId: options.deviceId, commands });
      if (!answer.ok) return { ok: false, unreachable: answer.unreachable, problem: answer.problem };
      const refused = answer.data.results.find((one) => !one.applied);
      if (refused !== undefined) return { ok: false, unreachable: false, problem: refused.problem ?? "the record did not take it." };
      const reached = events.length === 0 ? bookmark.syncedSeq : (events[events.length - 1]?.seq ?? bookmark.syncedSeq);
      markRunSynced(db, run.id, reached, run.status);
      if (events.length < RUN_PAGE) return { ok: true };
    }
  }

  return {
    ask,

    linked: () => options.transport() !== null,

    async offerWork<R extends DispatchRefusal>(input: OfferWorkInput<R>): Promise<WorkOffer[]> {
      // The device's own scheduler is not consulted, and `tickInput` is
      // not sent. That is the story's last scope bullet — "the
      // desktop's local scheduler is disabled while signed in; the
      // device runs only what the server leases to it" — and it is
      // enforced by there being no code here that could do otherwise.
      // A process that can run nothing has nothing to ask for. The sweep
      // this call would also have triggered is the record's own
      // housekeeping, happening on the record's machine on its own
      // tick, so there is nothing here to stand in for. A device with no
      // capacity left does ask: the record may hold work no cap holds
      // back (EO-616).
      if (input.capacity === null) return [];
      const answer = await ask("record:work", { deviceId: input.deviceId, capacity: input.capacity });
      if (!answer.ok) return [];
      const offers: WorkOffer[] = [];
      for (const offer of answer.data.offers) {
        const dispatch = resolveOffer(offer);
        if (dispatch === null) continue;
        offers.push({
          dispatch,
          lease: {
            itemId: offer.lease.itemId as Uuid,
            deviceId: offer.lease.deviceId,
            grantedAt: offer.lease.grantedAt,
            expiresAt: offer.lease.expiresAt,
          },
        });
      }
      return offers;
    },

    async personSpendToday(personId, since) {
      // Nought when the record cannot be asked, which the caller reads
      // as "the record said nothing" and answers from its own replica.
      // Not an exception and not a refusal: a ceiling nobody can verify
      // must not stop a person working (ARCHITECTURE.md, "The record").
      const answer = await ask("record:spend", { personId, since });
      return answer.ok ? answer.data.spentCents : 0;
    },

    async renewClaims(who, itemIds) {
      const answer = await ask("record:renew", { deviceId: who, itemIds: [...itemIds], releaseOthers: false });
      // Nothing, rather than everything, when the record cannot be
      // reached. The caller forgets what it is not told it still holds,
      // and forgetting a claim is the safe direction: the run in flight
      // carries on — the original design's "finish the run you hold" — and the record
      // sweeps the row on its own side with a comment naming this
      // device, which is the honest account of a machine that went
      // quiet.
      if (!answer.ok) return [];
      return answer.data.held.map(asLease);
    },

    async releaseLease(lease) {
      await ask("record:release", { deviceId: lease.deviceId, itemId: lease.itemId });
      // Not retried and not queued. A release that did not arrive costs
      // the item one lease term on the record, after which the sweep
      // takes it and says so; a release replayed an hour later could
      // take the item away from whichever device holds it by then.
    },

    async releaseLeasesOf(who, stillHeld) {
      const answer = await ask("record:renew", { deviceId: who, itemIds: [...(stillHeld ?? [])].map(String), releaseOthers: true });
      if (!answer.ok) return [];
      return answer.data.released.map(asLease);
    },

    /**
     * A module's creation, asked of the record and never done here
     * (EO-433).
     *
     * The one write a device makes that is not local first. A move is
     * provisional on the replica until the record confirms it; an item
     * cannot be, because its key is the record's to mint and the answer
     * the module is waiting for is whether the record already made one.
     * So nothing is written to this replica at all — the new item, and
     * the two notes EO leaves, arrive on the next pull like any other
     * change the record made.
     *
     * A record that cannot be reached means nothing was created, said
     * as that. Not queued: a creation replayed an hour later would be
     * answered to a module that stopped running an hour ago.
     *
     * The run goes with the request, as the drain sends a run ahead of
     * the comment that names it: the note on the new item carries this
     * run's id, and the record enforces that reference.
     */
    async createItemFromModule(request) {
      const run = request.runId === null ? undefined : getRun(db, request.runId);
      if (run === undefined) return { created: false, reason: "this run is not one the organisation's record can be told about, so nothing was created." };
      const answer = await ask("record:createItem", {
        deviceId: options.deviceId,
        originItemId: request.item.id,
        moduleId: request.module.id,
        run: asRunCommand(run, runCommandId(run.id, run.status), 0),
        creation: request.creation,
        atCap: request.atCap,
      });
      if (answer.ok) return answer.data;
      return {
        created: false,
        reason: answer.unreachable
          ? `${request.item.key} belongs to your organisation's record, which could not be reached, so nothing was created: ${answer.problem}`
          : `your organisation's record did not create it: ${answer.problem}`,
      };
    },

    /**
     * A change to what an item waits for, asked of the record and never
     * made here (EO-600).
     *
     * The record judges it against the whole graph and writes it, or
     * refuses it whole. Its answer — the item with its edges, and the
     * comment saying what changed — is written into the replica at once,
     * through the doors the pull uses, so the board shows the change
     * when the call returns; the next pull finds both and writes nothing.
     *
     * A record that cannot be reached means nothing changed, said as
     * that. Not queued: the caller has already been told nothing changed,
     * and a change replayed an hour later would be judged against a graph
     * nobody was looking at when they asked.
     */
    async changeDependencies(request) {
      const answer = await ask("record:changeDependencies", {
        deviceId: options.deviceId,
        itemId: request.itemId,
        add: [...request.add],
        remove: [...request.remove],
        why: request.why ?? null,
      });
      if (!answer.ok) {
        const key = getItem(db, request.itemId)?.key ?? "This ticket";
        return {
          ok: false,
          problem: answer.unreachable
            ? `${key} belongs to your organisation's record, which could not be reached, so what it waits for was not changed: ${answer.problem}`
            : `Your organisation's record did not change what ${key} waits for: ${answer.problem}`,
        };
      }
      if (!answer.data.changed) {
        return answer.data.problem === null ? { ok: true, dependencies: null } : { ok: false, problem: answer.data.problem };
      }
      const { item, comment } = answer.data;
      db.transaction(() => {
        if (item !== null) upsertReplicaItem(db, item);
        if (comment !== null && getComment(db, comment.commentId as Uuid) === undefined) mirrorRecordComment(db, local, comment);
      });
      return { ok: true, dependencies: answer.data.dependencies };
    },

    /**
     * A change to an item type, asked of the record and never made here
     * (EO-735). The record judges and writes it; its answer is written
     * into the replica at once, through the door the pull uses, so the
     * settings and the forms show the change when the call returns.
     *
     * A record that cannot be reached means nothing changed, said as
     * that, and nothing is queued — for `changeDependencies`' reason.
     */
    async updateItemType(request) {
      const label = getItemType(db, request.id as Uuid)?.label ?? "That item type";
      const answer = await ask("record:updateItemType", { deviceId: options.deviceId, ...request });
      if (!answer.ok) {
        return {
          type: null,
          problem: answer.unreachable
            ? `“${label}” belongs to a project your organisation's record holds, which could not be reached, so it was not changed: ${answer.problem}`
            : `Your organisation's record did not change “${label}”: ${answer.problem}`,
        };
      }
      if (answer.data.type === null) return { type: null, problem: `Your organisation's record did not change “${label}”: ${answer.data.problem ?? "it was refused."}` };
      upsertReplicaItemType(db, answer.data.type);
      return { type: itemTypeViewOf(db, answer.data.type.id as Uuid), problem: null };
    },

    /**
     * A message about a project the record holds, written there, one to
     * each admin (EO-726). The copies addressed to this desktop's person
     * are kept at once, so its inbox does not wait for the next pull;
     * the other admins' desktops pull theirs.
     */
    async sendMessage(input) {
      const answer = await ask("record:sendMessage", { deviceId: options.deviceId, message: input });
      if (!answer.ok) {
        return {
          ok: false,
          problem: answer.unreachable
            ? `This project is on your organisation's record, which could not be reached, so its message was not sent: ${answer.problem}`
            : `Your organisation's record did not send this project's message: ${answer.problem}`,
        };
      }
      if (answer.data.problem !== null) return { ok: false, problem: answer.data.problem };
      const kept = answer.data.mine.filter((message) => upsertReplicaMessage(db, message) === "written");
      if (kept.length > 0) emitPush("messages:changed", {});
      return { ok: true, messages: kept };
    },

    /**
     * A press on a message the record holds (EO-726), sent to it. Held to
     * being this desktop's person's and still open here first, so a
     * press nobody may make is not a round trip; the record judges it
     * again on its own copy, and whatever it answers — handled by this
     * press, or by something that beat it there — is what this replica
     * keeps.
     */
    async handleMessage(request) {
      try {
        openMessageOf(db, request.messageId, request.actingDeviceId);
      } catch (error) {
        return { ok: false, problem: error instanceof Error ? error.message : String(error) };
      }
      const answer = await ask("record:handleMessage", {
        deviceId: options.deviceId,
        messageId: request.messageId,
        how: request.how,
        answer: request.answer,
      });
      if (!answer.ok) {
        return {
          ok: false,
          problem: answer.unreachable
            ? `This message is on your organisation's record, which could not be reached, so it is still open: ${answer.problem}`
            : `Your organisation's record did not take that: ${answer.problem}`,
        };
      }
      const { message, problem } = answer.data;
      if (message !== null) {
        upsertReplicaMessage(db, message);
        emitPush("messages:changed", {});
      } else if (forgetMessage(db, request.messageId)) {
        // The record has no such message of this person's: handled and
        // swept there while this desktop was away. Its copy here is all
        // that kept it open, and pressing again would only be refused again.
        emitPush("messages:changed", {});
      }
      if (problem !== null || message === null) return { ok: false, problem: problem ?? "Your organisation's record no longer has that message." };
      return { ok: true, message };
    },

    /**
     * The chat about an update conflict the record holds, asked of the
     * record and kept here (EO-533).
     *
     * The record makes it, or hands back the one an earlier press made
     * — on this desktop or another — and the answer is written into the
     * replica at once, with its brief, through the doors the pull uses:
     * the person is about to be shown the chat, and the brief's mention
     * of this desktop's assistant is what its next tick dispatches. The
     * next pull finds both rows here and writes nothing.
     */
    /**
     * A held template update on a pipeline the record holds, read there
     * (EO-534): the record compared it, and holds its three graphs.
     */
    async updateConflict(request) {
      const answer = await ask("record:updateConflict", { pipelineId: request.pipelineId });
      if (answer.ok) return answer.data;
      // Nobody who could say was asked: never read as "nothing is held".
      return {
        conflict: null,
        authoritative: false,
        problem: answer.unreachable
          ? `This pipeline's template update is held on your organisation's record, which could not be reached: ${answer.problem}`
          : `Your organisation's record did not answer about this pipeline's template update: ${answer.problem}`,
      };
    },

    /**
     * A pipeline's template origin and update state, on a pipeline the
     * record holds (EO-536): its origin and conflicts are the record's.
     * A record that cannot be asked answers nothing, saying why — never
     * the out-of-date origin this replica kept from before the move.
     */
    async templateStatus(request) {
      const answer = await ask("record:templateStatus", { pipelineId: request.pipelineId });
      if (answer.ok) return answer.data;
      return {
        ...NO_TEMPLATE_STATUS,
        problem: answer.unreachable
          ? `This pipeline's template updates are held on your organisation's record, which could not be reached: ${answer.problem}`
          : `Your organisation's record did not answer about this pipeline's template: ${answer.problem}`,
      };
    },

    /**
     * Resolves a template update the record holds (EO-534). The record
     * checks that this device is an admin's, saves a published draft's
     * graph itself and closes its notice; nothing is written here.
     */
    async resolveUpdateConflict({ onTheRecord: _onTheRecord, createdBy: _createdBy, ...request }) {
      const answer = await ask("record:resolveUpdateConflict", { ...request, deviceId: options.deviceId });
      if (answer.ok) return answer.data;
      return {
        resolved: false,
        toVersion: null,
        version: null,
        problem: answer.unreachable
          ? `This pipeline's template update is held on your organisation's record, which could not be reached, so nothing was resolved: ${answer.problem}`
          : `Your organisation's record did not resolve this pipeline's template update: ${answer.problem}`,
      };
    },

    async updateConflictChat(request) {
      // This device answers with its own assistant, where it has one; the
      // record decides whether the first turn is this device's to take.
      const assistant = request.answeredBy?.kind === "here" ? request.answeredBy.agentId : null;
      const answer = await ask("record:updateConflictChat", {
        conflictId: request.conflictId,
        answeringDeviceId: assistant === null ? null : options.deviceId,
        commentId: request.commentId,
      });
      if (!answer.ok) {
        return {
          ok: false,
          problem: answer.unreachable
            ? `This template update is held on your organisation's record, which could not be reached: ${answer.problem}`
            : `Your organisation's record did not open a chat for this template update: ${answer.problem}`,
        };
      }
      if (answer.data.item === null) return { ok: false, problem: answer.data.problem ?? "Your organisation's record did not open a chat for this template update." };
      upsertReplicaItem(db, answer.data.item);
      const copied = getItem(db, answer.data.item.id as Uuid);
      if (copied === undefined) {
        return { ok: false, problem: "Your organisation's record opened a chat for this template update, but this desktop could not keep a copy yet. It arrives with the next sync." };
      }
      const brief = answer.data.brief;
      const { pipelineId, started } = answer.data;
      const firstTurn = db.transaction(() => {
        // The pipeline first: it is the chat's own state, which the pull
        // does not carry, and the turn about to be asked for raises its
        // drafts against it.
        if (brief !== null && pipelineId !== null) recordAssistBoard(db, copied, brief.commentId, pipelineId);
        // The brief as the pull would have written it — asking nobody,
        // as the record holds it — unless the pull already did.
        if (brief !== null && getComment(db, brief.commentId as Uuid) === undefined) mirrorRecordComment(db, local, brief);
        // Then, only on the device the record handed the first turn to,
        // and only once, this desktop's assistant is asked. Every other
        // desktop holds the same brief and asks nobody, so the turn is
        // answered once however many admins have the chat.
        return brief !== null && answer.data.firstTurn && assistant !== null && askAgentAbout(db, brief.commentId as Uuid, assistant as Uuid);
      });
      return { ok: true, chat: getItem(db, copied.id) ?? copied, started, firstTurn };
    },

    /**
     * A write to a moved project's memory, asked of the record and
     * never made here (EO-482).
     *
     * The rows the record changed come back with its answer and are
     * copied into this replica at once, through the door the pull uses,
     * so the panel a person is looking at — and the next dispatch here —
     * has the entry before the next sync. Every other desktop takes them
     * on its pull.
     *
     * A record that cannot be reached means nothing was written, said as
     * that, and nothing is written here: an entry on this replica alone
     * would be one the organisation never sees and this desktop delivers
     * anyway. Not queued, for `createItemFromModule`'s reason — the note
     * is answered now, to a run that is still going.
     *
     * A note sends its run ahead of it, as a module's creation does: the
     * entry names it as its source, and the record enforces that.
     */
    async writeMemory(request) {
      const write = asMemoryWrite(db, request);
      if (write === null) {
        return { ok: false, problem: "That workspace belongs to no project your organisation's record holds, so nothing was saved." };
      }
      let run = null;
      if (request.op === "note") {
        // Which workspaces the run works in is this device's to say, so
        // the entries a note replaces are held to them here (EO-594),
        // against the replica, before the record is asked; the record
        // holds them to the rest again.
        const problem = supersedeProblem(db, request.replaces ?? [], request.scopes ?? []);
        if (problem !== null) return { ok: false, problem };
        const held = getRun(db, request.runId);
        if (held === undefined) return { ok: false, problem: "This run is not one your organisation's record can be told about, so the note was not saved." };
        // The run, and every line of it this device has not yet sent,
        // before the note. The record will take a note only from the
        // device that ran its run, and for a run with no lease — a reply,
        // a recovery — the lines this device sent are how it knows; a
        // note written before the tick's sync reached them would
        // otherwise be refused for a run this device is running now.
        const sent = await sendRun(held.id);
        if (!sent.ok) {
          return {
            ok: false,
            problem: sent.unreachable
              ? `This project's memory is kept by your organisation's record, which could not be reached, so nothing was saved: ${sent.problem}`
              : `Your organisation's record did not take the run that wrote it, so nothing was saved: ${sent.problem}`,
          };
        }
        run = asRunCommand(held, runCommandId(held.id, held.status), 0);
      }
      const answer = await ask("record:memory", { deviceId: options.deviceId, write, run });
      if (!answer.ok) {
        return {
          ok: false,
          problem: answer.unreachable
            ? `This project's memory is kept by your organisation's record, which could not be reached, so nothing was saved: ${answer.problem}`
            : `Your organisation's record did not save it: ${answer.problem}`,
        };
      }
      copyRecordMemories(db, answer.data.changed);
      return answer.data.result;
    },

    /**
     * The record's own history of the scope, every page of it (EO-545), or
     * this replica's where the record cannot be asked. A page that fails
     * part of the way through answers this replica's too, rather than a
     * list that stops short and looks whole.
     */
    async memoryConsolidations(scope) {
      const all: MemoryConsolidationView[] = [];
      let before: MemoryConsolidationCursor | undefined;
      for (;;) {
        const answer = await ask("record:memoryConsolidations", { scope, ...(before === undefined ? {} : { before }) });
        if (!answer.ok) return listConsolidations(db, scope);
        all.push(...answer.data.consolidations);
        const next = answer.data.next;
        // A record that does not move forward has nothing more to give.
        if (next === null || answer.data.consolidations.length === 0 || (before !== undefined && next.startedAt === before.startedAt && next.id === before.id)) return all;
        before = next;
      }
    },

    /**
     * Restored on the record that holds the skill (EO-728), and the skill
     * as it now stands there copied here at once — through the replica's
     * own rule (`upsertReplicaSkill`), so a person's lock here holds the
     * copy rather than being written over, and says so.
     */
    async restoreSkillVersion(request) {
      const answer = await ask("record:restoreSkillVersion", {
        deviceId: options.deviceId,
        skillId: request.id,
        versionId: request.versionId,
        agentId: request.actingAgentId ?? null,
        content: contentOf(skillVersionOf(db, request.id, request.versionId)),
      });
      if (!answer.ok) {
        return {
          skill: null,
          problem: answer.unreachable
            ? `This skill is on your organisation's record, which could not be reached, so nothing was restored: ${answer.problem}`
            : `Your organisation's record did not restore it: ${answer.problem}`,
        };
      }
      const { skill, problem } = answer.data;
      if (skill === null) return { skill: null, problem: problem ?? "Your organisation's record did not restore it." };
      const { projectId, ...copy } = skill;
      const taken = upsertReplicaSkill(db, copy, projectId);
      if (!taken.ok) holdSkillCopy(db, copy, projectId ?? undefined, taken.problem);
      emitPush("config:changed", {});
      if (!taken.ok) return { skill: null, problem: `Your organisation's record restored it, but it is not on this machine yet: ${taken.problem}` };
      return { skill: getSkill(db, copy.id) ?? null, problem: null };
    },

    /** Undone on the record that made it, under its caps; what it changed is copied here at once. */
    async restoreMemoryConsolidation(consolidationId) {
      const answer = await ask("record:restoreMemoryConsolidation", { deviceId: options.deviceId, consolidationId });
      if (!answer.ok) {
        return {
          ok: false,
          problem: answer.unreachable
            ? `This consolidation is on your organisation's record, which could not be reached, so nothing was restored: ${answer.problem}`
            : `Your organisation's record did not restore it: ${answer.problem}`,
        };
      }
      copyRecordMemories(db, answer.data.changed);
      return answer.data.result;
    },

    /**
     * The three writes, which are the local record's writes.
     *
     * Not a passthrough by oversight: it is the shape the queueing
     * turned out to want. Every move and every comment written against
     * this database becomes a command, whichever object was called to
     * write it — `outbound.ts` subscribes at the writers themselves,
     * because there are a hundred and twenty-eight places that post a
     * comment and a device that missed one would silently not be what
     * the organisation's board says.
     *
     * So the queue is a property of *this database being a replica*
     * rather than of which record object a caller happened to hold, and
     * these three can say plainly that a write is a write. What is
     * remote about a remote record is the asking — `offerWork`,
     * `renewClaims`, the leases — and that is all of it.
     */
    applyTransition: (command: TransitionCommand): Item => local.applyTransition(command),

    appendRunEvent: (runId, type, payload) => {
      // Not queued as a command at all. Run events sync by `(runId,
      // seq)` out of the table itself — see `drain.ts` — because that
      // is the only way "every run event in order" survives a process
      // that died mid-run: a queue would hold the events the writer
      // happened to hand it, and the table holds all of them.
      local.appendRunEvent(runId, type, payload);
    },

    postComment: (input: PostCommentInput): Comment => local.postComment(input),
  };
}

/**
 * A write as it travels. A person's new entry carries the project it
 * belongs to, because the record holds a workspace's memory without the
 * workspace; null where this desktop cannot say which project that is.
 */
function asMemoryWrite(db: Db, request: MemoryWriteRequest): RecordMemoryWrite | null {
  switch (request.op) {
    case "note":
      return { op: "note", itemId: request.item.id, scope: request.scope, body: request.body, extracted: request.extracted === true, replaces: [...(request.replaces ?? [])] };
    case "add": {
      const projectId = memoryScopeProjectId(db, request.scope);
      return projectId === null ? null : { op: "add", scope: request.scope, projectId, body: request.body };
    }
    default:
      return request;
  }
}

function asLease(lease: { itemId: string; deviceId: string; grantedAt: number; expiresAt: number }): DispatchLease {
  return { itemId: lease.itemId as Uuid, deviceId: lease.deviceId, grantedAt: lease.grantedAt, expiresAt: lease.expiresAt };
}

/** What a restore of this version puts back, as this desktop's history holds it — for the record to find among its own (EO-728). */
function contentOf(version: SkillVersion | undefined): SkillVersionContent | null {
  return version === undefined ? null : { description: version.description, body: version.body, files: version.files };
}
