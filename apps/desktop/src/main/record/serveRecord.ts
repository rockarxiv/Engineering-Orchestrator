import {
  DEFAULT_MEMORY_SCOPE_MAX_CHARS,
  DEFAULT_MEMORY_SCOPE_MAX_ENTRIES,
  MAX_RECORD_CONSOLIDATIONS_PAGE,
  MEMORY_NOTE_PROJECT_SCOPE,
  SOMEONE_ELSE,
  checkMemoryNote,
  stepRefusalLine,
  type Comment,
  type IpcPayload,
  type MemorySource,
  type IpcResponse,
  type RecordAdoptCounts,
  type RecordAdoptedAttachment,
  type RecordCommand,
  type RecordAttachmentCommand,
  type RecordCommandResult,
  type RecordCommentCommand,
  type RecordRunCommand,
  type RecordItem,
  type Person,
  type StepRefusal,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { getAgent } from "../db/repos/agentsRepo.js";
import {
  getComment,
  listCommentsForItem,
  listCommentsSince,
  listMentionsForComment,
  settleMention,
  listPinsSince,
  listSettledMentionsSince,
  postComment,
  setCommentPinned,
} from "../db/repos/commentsRepo.js";
import { itemEntryRefusal } from "../db/repos/entryRulesRepo.js";
import { getItem, listItemsUpdatedSince } from "../db/repos/itemsRepo.js";
import { hasTransition, lastMover, listTransitionsSince } from "../db/repos/transitionsRepo.js";
import { appendSyncedRunEvents, listRunEventsSince, runEventDevices } from "../db/repos/runEventsRepo.js";
import { createRun, getRun, listRunsForItem, listRunsUpdatedSince, updateRun } from "../db/repos/runsRepo.js";
import { mirrorReportedSideCall } from "../db/repos/sideCallsRepo.js";
import { getStep } from "../db/repos/pipelineStepsRepo.js";
import { asRecordWatch, listItemWatchesUpdatedSince, mirrorItemWatch } from "../db/repos/itemWatchesRepo.js";
import { getDevice } from "../db/repos/devicesRepo.js";
import { getModule } from "../db/repos/modulesRepo.js";
import { originForWire } from "../db/repos/itemOriginsRepo.js";
import { listAllDependencies, waitsForWire } from "../db/repos/itemDepsRepo.js";
import { postModuleCreation } from "../modules/moduleCreations.js";
import { changeDependenciesOf, summariseDependencyChange } from "../roles/itemDependencies.js";
import { findProjectThread, openProjectThread } from "../projects/projectThread.js";
import { openUpdateConflictChat } from "../roles/updateConflictChat.js";
import { describeUpdateConflict, resolveUpdateConflictHere } from "../gallery/updateConflictDetail.js";
import { describeTemplateStatus } from "../gallery/templateStatus.js";
import type { TemplateHistory } from "../gallery/history.js";
import { getPerson } from "../db/repos/peopleRepo.js";
import { getUpdateConflict } from "../db/repos/pipelineUpdateConflictsRepo.js";
import { itemsMidAdoption, listProjectsUpdatedSince, projectsMidAdoption } from "../db/repos/projectsRepo.js";
import { listItemTypesSince } from "../db/repos/itemTypesRepo.js";
import { listPublishedSectionsSince } from "../db/repos/publishedSectionsRepo.js";
import {
  abandonAdoptedProject,
  carryKeyCounter,
  listPipelinesUpdatedSince,
  listProjectAgentsUpdatedSince,
  sayUncarriedTools,
  writeAdoptedPage,
  writeAdoptedProject,
  type UncarriedTools,
} from "../db/repos/projectMoveRepo.js";
import { listProjectSkillsUpdatedSince } from "../db/repos/skillsRepo.js";
import {
  getAttachment,
  insertAttachments,
  listAttachmentsForComment,
  listAttachmentsSince,
  listAttachmentRemovalsSince,
  noteAttachmentRemoved,
  removeItemAttachment,
  attachmentWasRemoved,
  type AttachmentRecord,
  type CreateAttachmentRecord,
} from "../db/repos/attachmentsRepo.js";
import type { LocalItemRecord } from "./localRecord.js";
import type { DispatchLease } from "../db/repos/leasesRepo.js";
import type { WorkOffer } from "./record.js";
import { asRunCommand, runPatchFrom } from "./runCommand.js";
import { emitPush } from "../ipc/push.js";
import { answerCopiedSkillProposal } from "../memory/skillProposals.js";
import { arbitrateClaim, writeAssignment, writeTakeover } from "./assignment.js";
import { groupStepOf, holderView, isDecision, isStepClearance, judgeOnGroupStep } from "./stepAuthority.js";
import { planVersionMove, writeVersionMove } from "./versionMove.js";
import { leaseFor } from "../db/repos/leasesRepo.js";
import {
  getConsolidation,
  getMemory,
  getProject,
  listConsolidations,
  listMemoriesUpdatedSince,
  memoryEntryProjectId,
  memoryScopeProjectId,
  recordMemories,
  restoreConsolidation,
} from "../db/repos/index.js";
import { applyMemoryWrite } from "../memory/memoryWrites.js";
import { containerScopeOf } from "../memory/containerScope.js";
import type { MemoryCaps, MemoryWriteRequest } from "./record.js";

/**
 * The record answering a device (EO-324,
 * `ARCHITECTURE.md`, "The record",
 * "Identity").
 *
 * The other side of `remoteRecord.ts`. Everything here runs **on the
 * record** — on the organisation's server in managed mode, and on a
 * solo desktop never, because a solo desktop is its own record and
 * calls `ItemRecord` directly instead of sending itself a request.
 *
 * Which makes this the one place where invariant #1 is tested by
 * something other than an architectural scanner: this is the process
 * that decides. It runs the scheduler (`work` below), it decides
 * whether a move applies (`apply`), and it writes. A device does none
 * of those three, and the shape of these functions is what makes that
 * true rather than a convention — there is no argument a device could
 * pass that would make it the decider.
 *
 * Nothing here knows about HTTP. `handlers.ts` registers these against
 * the contract's `record:*` channels, `server/http.ts` opens the door
 * onto them, and this file's whole dependency surface is the database,
 * the record, and the push bus — which is transport-agnostic by design
 * (`ipc/push.ts`) and is here because announcing a change is something
 * the record does rather than something a door does for it.
 */

export interface ServeRecordContext {
  db: Db;
  /**
   * The record itself — the local one, because on the machine that
   * *is* the record there is nothing remote about it.
   *
   * It is what grants leases and applies moves, so that the code path a
   * command takes on the server is the code path a solo desktop's own
   * dispatch takes. One writer, one scheduler, one implementation.
   */
  record: LocalItemRecord;
  /**
   * How the record picks, with everything a pick depends on.
   *
   * The engine's own, and that is the point rather than a convenience:
   * the record's scheduler must be *the* scheduler, with the same
   * guards, the same concurrency caps and the same pack contributions
   * the process would apply to a dispatch of its own. Building a second
   * tick input here would be a second scheduler with a different
   * opinion, which is precisely what invariant #1 is about.
   *
   * `runSupervisor.offerWork` is what the composition root passes.
   */
  offerWork: (deviceId: string, capacity: number) => Promise<WorkOffer[]>;
  /**
   * Where a file a device sends is kept, and read back from (EO-324,
   * `ARCHITECTURE.md`, "The record").
   *
   * The same `AttachmentStorage` the rest of this process uses, so an
   * attachment that arrived from a desktop is a file on the record like
   * any other — the admin's read-only board opens it, and the next
   * desktop asks for it on `record:attachment`.
   *
   * Absent where this process has no store to write into, which is a
   * test that is not about files. The attachment command is then
   * refused with a reason rather than accepted and dropped, because
   * "EO took your file and has no idea where it is" is the one answer
   * that must not be possible (invariant #8).
   */
  attachments?: RecordAttachmentStore;
  /**
   * The memory caps this record settles a scope under when a device asks
   * it to undo a consolidation (EO-482). Read per request, so a settings
   * change applies to the next one; the defaults where absent.
   */
  memoryCaps?: () => MemoryCaps;
  /**
   * The template history this build ships (EO-536), which a pipeline's
   * template status reads titles and release notes from. Absent where a
   * test is not about templates: then no version has notes to read.
   */
  templateHistory?: () => TemplateHistory;
}

/**
 * The slice of `AttachmentStorage` the record needs.
 *
 * Two methods out of a dozen, named here rather than imported whole,
 * for this file's own stated reason: its dependency surface is the
 * database and the record, and a class that knows about staging
 * directories, MIME sniffing and Electron's save dialog is not that.
 */
export interface RecordAttachmentStore {
  /** Writes bytes that arrived from somewhere else, answering the row to insert. */
  storeImported(input: { name: string; mimeType?: string; data: Uint8Array }): Promise<Omit<CreateAttachmentRecord, "itemId" | "commentId">>;
  /** Reads a file back out, or null when the record holds the row and not the bytes. */
  read(path: string): Promise<Buffer | null>;
  /** Deletes a removed item file's bytes (EO-702). */
  removeManaged?(attachment: Pick<AttachmentRecord, "managed" | "path">): Promise<void>;
}

/**
 * What the record offers this device, with the claims to go with it.
 *
 * `capacity` is what the device says it could start. The record honours
 * it as a ceiling and applies its own on top — concurrency is the
 * record's to enforce, because it is the only thing that can see every
 * device at once (invariant #10, and ARCHITECTURE.md, "Capacity and concurrency": the
 * global cap stays at 1 per server through this phase). The one exception
 * is work no cap holds back (`TickInput.uncappedRoles`, EO-616), offered
 * past it, so a device with no capacity left still asks.
 */
export async function serveWork(
  context: ServeRecordContext,
  payload: IpcPayload<"record:work">,
): Promise<IpcResponse<"record:work">> {
  const offers = await context.offerWork(payload.deviceId, payload.capacity);
  return {
    offers: offers.map((offer) => ({
      itemId: offer.dispatch.item.id,
      stepId: offer.dispatch.stepId,
      action: offer.dispatch.action,
      agentId: offer.dispatch.agent?.id ?? null,
      lease: asWire(offer.lease),
    })),
  };
}

/** A device saying its claims still stand — and, at boot, which ones are no longer its. */
export async function serveRenew(
  context: ServeRecordContext,
  payload: IpcPayload<"record:renew">,
): Promise<IpcResponse<"record:renew">> {
  const itemIds = payload.itemIds as Uuid[];
  const released = payload.releaseOthers ? await context.record.releaseLeasesOf(payload.deviceId, itemIds) : [];
  const held = await context.record.renewClaims(payload.deviceId, itemIds);
  return { held: held.map(asWire), released: released.map(asWire) };
}

/**
 * What one person has spent today, as the record counts it (EO-328,
 * ARCHITECTURE.md, "Policy", review).
 *
 * The record's own sum over every device's runs, which is the only
 * honest answer to a *per-person* ceiling: a device asking its own
 * replica gave each of a person's machines the whole budget to itself.
 *
 * Answered to any signed-in device rather than only to that person's,
 * and that is the same reading `ADMIN_ONLY_CHANNELS` already takes of
 * the difference between being refused and what "yours" means: a total
 * in cents is not somebody's work, and a device asks this about the item
 * it was just leased — which the record leased it. Narrowing it to the
 * asking device's own person would mean a device could not check a
 * ceiling before running work the record had already handed it.
 */
export async function serveSpend(
  context: ServeRecordContext,
  payload: IpcPayload<"record:spend">,
): Promise<IpcResponse<"record:spend">> {
  return { spentCents: await context.record.personSpendToday(payload.personId, payload.since) };
}

/** A device giving a claim back. */
export async function serveRelease(
  context: ServeRecordContext,
  payload: IpcPayload<"record:release">,
): Promise<IpcResponse<"record:release">> {
  const standing = context.record.leaseFor(payload.itemId as Uuid);
  if (standing === null || standing.deviceId !== payload.deviceId) return { released: false };
  await context.record.releaseLease(standing);
  return { released: true };
}

/**
 * A module's run on a device asking for a work item (EO-433).
 *
 * The record's half of `ctx.createItem` on a project the organisation
 * holds. The device ran the module, checked the call's shape and
 * redacted it; none of that is believed here for anything that decides
 * whether an item exists (invariant #5). What this checks for itself:
 *
 * - **The item is this record's**, and still here.
 * - **The asking device holds it.** A creation is something a run does,
 *   and a run happens under a lease this record granted. A signed-in
 *   device that held no claim on the item could otherwise file work
 *   from any item whose id it had pulled.
 * - **The module is one this record holds**, approved, not retired, and
 *   declaring `needs.create`. The manifest read is the record's copy —
 *   the one an administrator published — not the device's word for it.
 * - **The run is a run on that item.** It is written first, the way the
 *   drain sends a run ahead of what it produced, because the note left
 *   on the new item names it.
 *
 * And then `postModuleCreation`, the function a solo desktop calls on
 * its own database: the repeat lookup, the cap, the generation, the
 * type, the spec, the pipeline, the item, its origin and both notes, in
 * one transaction against this record's tables.
 *
 * Answers a refusal rather than failing the request for anything it
 * will not do. The module is waiting, and a sentence it can put in its
 * transcript is worth more than an error envelope.
 */
export async function serveCreateItem(
  context: ServeRecordContext,
  payload: IpcPayload<"record:createItem">,
): Promise<IpcResponse<"record:createItem">> {
  const { db, record } = context;
  const refuse = (reason: string): IpcResponse<"record:createItem"> => ({ created: false, reason });

  const origin = getItem(db, payload.originItemId as Uuid);
  if (origin === undefined) return refuse("this record no longer has the item that run is on, so nothing can be created from it.");

  const lease = record.leaseFor(origin.id as Uuid);
  if (lease === null || lease.deviceId !== payload.deviceId) {
    return refuse(`this machine does not hold ${origin.key} on the record, so a run on it may not create work.`);
  }

  const module = getModule(db, payload.moduleId);
  if (module === undefined || module.archivedAt !== null || module.approvedAt === null) {
    return refuse("this record holds no approved module with that id, so it cannot say that one may create work.");
  }
  if (module.manifest.needs.create !== true) {
    return refuse(`"${module.name}" does not declare needs.create in its manifest, so it may not create items.`);
  }

  if (payload.run.itemId !== origin.id) return refuse(`that run is not a run on ${origin.key}.`);
  const held = getRun(db, payload.run.runId as Uuid);
  if (held !== undefined && held.itemId !== origin.id) return refuse(`that run is not a run on ${origin.key}.`);

  let answer: IpcResponse<"record:createItem">;
  try {
    upsertReportedRun(db, payload.run);
    answer = postModuleCreation(db, { module, item: origin, runId: payload.run.runId as Uuid }, payload.creation, { atCap: payload.atCap });
  } catch (error) {
    return refuse(`the item could not be written: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The record changed, so every device and every open browser is told
  // to ask again — which is how the new item reaches the desktop whose
  // module asked for it.
  if (answer.created && !answer.existing) emitPush("items:changed", {});
  return answer;
}

/**
 * A change to what an item waits for, asked by a device that holds the
 * item as a replica (EO-600, ARCHITECTURE.md, "One work entity").
 *
 * The same `changeDependenciesOf` a solo desktop runs on its own tables,
 * against this record's: judged against the whole graph — which only
 * this record has — and written whole or not at all, with the one
 * comment that says what changed, filed under the person the asking
 * device belongs to. A device this record has no row for is nobody, and
 * is refused, as a claim by nobody is. So is an item whose project is
 * still arriving: its graph is not all here yet.
 *
 * Answered with the item, its edges included, and the comment, as the
 * pull would carry them, so the device copies both into its replica at
 * once — and every other device is told to ask again.
 */
export async function serveChangeDependencies(
  context: ServeRecordContext,
  payload: IpcPayload<"record:changeDependencies">,
): Promise<IpcResponse<"record:changeDependencies">> {
  const { db } = context;
  const refuse = (problem: string): IpcResponse<"record:changeDependencies"> => ({ changed: false, problem, item: null, comment: null, dependencies: null });

  const person = personOfDevice(db, payload.deviceId);
  if (person === undefined) return refuse("this record does not know the device that asked, so it changed nothing.");
  const current = getItem(db, payload.itemId as Uuid);
  if (current === undefined) return refuse("this record no longer has that item, so nothing was changed.");
  if (itemsMidAdoption(db).has(current.id)) return refuse("the project this item is on is still arriving on the record, so what it waits for cannot be changed yet.");

  // On a step that waits on a group only the holder may change the item
  // (EO-368) — judged here, on this record's item as it stands and the
  // person the device belongs to, never on the replica's copy: a takeover
  // the asking desktop has not pulled yet has already moved the item to
  // somebody else, and a request that never went through a desktop's
  // check at all is held to it just the same. Told on the item, as every
  // refusal on a group step is (invariant 8), and in the answer.
  const notPermitted = judgeOnGroupStep(db, current, person.id, "change");
  if (notPermitted !== null) {
    const line = stepRefusalLine(current.key, "edit", notPermitted, person.id);
    postComment(db, {
      itemId: current.id,
      author: { type: "engine" },
      kind: "escalation",
      body: line,
      mentions: [{ type: "human", personId: person.id as Uuid }],
      parseBodyMentions: false,
    });
    emitPush("items:changed", { itemId: current.id });
    return refuse(line);
  }

  const outcome = changeDependenciesOf(db, current.id, { add: payload.add, remove: payload.remove }, person.name, payload.why);
  if (!outcome.ok) return refuse(outcome.reason);
  if (outcome.applied === null) return { changed: false, problem: null, item: null, comment: null, dependencies: null };

  const { item, comment } = outcome.applied;
  // Every device and every open browser is told to ask again, which is
  // how the change reaches the desktops that did not ask for it.
  emitPush("items:changed", { itemId: item.id });
  return {
    changed: true,
    problem: null,
    item: {
      ...asRecordItem(item, item.assigneeId === null ? null : (getPerson(db, item.assigneeId as Uuid)?.name ?? null)),
      origin: originForWire(db, item.id),
      waits: waitsForWire(listAllDependencies(db), item.id),
    },
    comment: asRecordComment(db, comment),
    dependencies: summariseDependencyChange(outcome.applied),
  };
}

/**
 * A project's thread, for a device that holds the project as a replica
 * (EO-471, ARCHITECTURE.md, "One channel").
 *
 * The same `openProjectThread` a solo desktop calls on its own tables,
 * against this record's: the one this project has, or a new one. Two
 * desktops asking at once are two requests this process answers one
 * after the other, and the second finds the first's thread.
 *
 * Carried as the pull would carry it, so the device can copy it into its
 * replica through the door it already copies items through.
 */
export async function serveProjectThread(
  context: ServeRecordContext,
  payload: IpcPayload<"record:projectThread">,
): Promise<IpcResponse<"record:projectThread">> {
  const { db } = context;
  const had = findProjectThread(db, payload.projectId as Uuid) !== undefined;
  const answer = openProjectThread(db, payload.projectId as Uuid);
  if (!answer.ok) return { item: null, problem: answer.problem };
  // A new item on the record, so every device and open browser is told
  // to ask again — which is how the others learn of it.
  if (!had) emitPush("items:changed", { itemId: answer.item.id });
  return { item: { ...asRecordItem(answer.item, null), origin: null, waits: null }, problem: null };
}

/**
 * The chat about an update conflict this record holds, for a desktop
 * whose admin pressed Fix with assistant on its notice (EO-533,
 * ARCHITECTURE.md, "Template versions and origins").
 *
 * The same `openUpdateConflictChat` a desktop calls for a conflict of its
 * own, against this record's tables: the chat an earlier press made, or
 * a new one whose brief asks nobody here. Its first turn is handed to
 * one device, the first to ask, which asks its own assistant on its
 * copy — every desktop pulls the brief, and one asking an assistant on
 * the record would be answered by each of them. Two desktops pressing at
 * once are two requests this process answers one after the other: the
 * second is handed the first's chat, and not the turn.
 *
 * Carried as the pull would carry it — the chat and its brief — so the
 * desktop copies both into its replica through the doors it already
 * copies items and comments through, and its next tick dispatches the
 * brief.
 */
export async function serveUpdateConflictChat(
  context: ServeRecordContext,
  payload: IpcPayload<"record:updateConflictChat">,
): Promise<IpcResponse<"record:updateConflictChat">> {
  const { db } = context;
  const answer = openUpdateConflictChat(db, {
    conflictId: payload.conflictId,
    answeredBy: payload.answeringDeviceId === null ? null : { kind: "device", deviceId: payload.answeringDeviceId },
    commentId: payload.commentId,
    fallbackProjectId: null,
  });
  if (!answer.ok) return { item: null, brief: null, started: false, firstTurn: false, pipelineId: null, problem: answer.problem };
  const first = listCommentsForItem(db, answer.chat.id).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))[0];
  // A new item on the record, so every device and open browser is told
  // to ask again — which is how the other admins' desktops learn of it.
  if (answer.started) emitPush("items:changed", { itemId: answer.chat.id });
  return {
    item: { ...asRecordItem(answer.chat, null), origin: null, waits: null },
    brief: first === undefined ? null : asRecordComment(db, first),
    started: answer.started,
    firstTurn: answer.firstTurn,
    pipelineId: getUpdateConflict(db, payload.conflictId)?.pipelineId ?? null,
    problem: null,
  };
}

/**
 * A held template update on a pipeline this record holds, read whole for
 * the assistant on an admin's desktop (EO-534) — the record's half of
 * `ItemRecord.updateConflict`. The same answer a desktop gives for one
 * of its own. Writes nothing.
 */
export async function serveUpdateConflict(context: ServeRecordContext, payload: IpcPayload<"record:updateConflict">): Promise<IpcResponse<"record:updateConflict">> {
  return describeUpdateConflict(context.db, payload.pipelineId, { onTheRecord: true });
}

/**
 * A pipeline's template origin and update state, on a pipeline this
 * record holds (EO-536) — the record's half of
 * `ItemRecord.templateStatus`, and the answer a desktop gives for one of
 * its own. Writes nothing.
 */
export async function serveTemplateStatus(context: ServeRecordContext, payload: IpcPayload<"record:templateStatus">): Promise<IpcResponse<"record:templateStatus">> {
  return describeTemplateStatus(context.db, payload.pipelineId, context.templateHistory?.() ?? new Map(), { onTheRecord: true });
}

/** What a device that is not an admin's is told when it asks to resolve a template update. */
export const RESOLVE_UPDATE_NOT_AN_ADMIN = "Only an administrator of your organisation can resolve a template update to a pipeline it holds. Nothing was changed.";

/**
 * A device asking to resolve a template update this record holds
 * (EO-534) — the record's half of `ItemRecord.resolveUpdateConflict`.
 *
 * What it checks for itself (invariant 5): the device belongs to one of
 * this record's admins — the update was announced to them, and keeping
 * or replacing the organisation's pipeline is theirs to decide; then, in
 * `resolveUpdateConflictHere`, that the update is open, a published
 * draft came from the chat about it, and its template step ids are
 * believable. A published draft is saved here, judged by this record,
 * and filed under the admin's name. The notice's mentions close on this
 * record's threads, and every device is told to ask again.
 */
export async function serveResolveUpdateConflict(
  context: ServeRecordContext,
  payload: IpcPayload<"record:resolveUpdateConflict">,
): Promise<IpcResponse<"record:resolveUpdateConflict">> {
  const { db } = context;
  const person = personOfDevice(db, payload.deviceId);
  if (person === undefined || !person.isAdmin) return { resolved: false, toVersion: null, version: null, problem: RESOLVE_UPDATE_NOT_AN_ADMIN };
  const request = { pipelineId: payload.pipelineId, resolution: payload.resolution, chatId: payload.chatId, graph: payload.graph, templateStepIds: payload.templateStepIds };
  const answer = resolveUpdateConflictHere(db, request, person.id, { onTheRecord: true });
  if (answer.resolved || answer.version !== null) emitPush("items:changed", {});
  return answer;
}

/**
 * A device asking to write to the memory of a project this record holds
 * (EO-482, ARCHITECTURE.md, "What an agent is given", "The record").
 *
 * The record's half of `ItemRecord.writeMemory`. None of what the device
 * checked is believed here for anything that decides whether an entry
 * is written (invariant 5). What this checks for itself:
 *
 * - **The project is this record's**, and finished arriving — a project
 *   still being handed over is not yet anybody's to write to.
 * - **A note is a run's on that project.** The item is here and on the
 *   project, the run is a run on that item, and the note keeps
 *   `memory_note`'s rules: something to say, at most 1,000 characters, and
 *   a scope of the item's own project — its project, or a workspace the
 *   device says it is of. A workspace is a path on the desktop and never
 *   reaches a record, so which workspace a run works in is the one fact
 *   here that is the device's word. The run is written first, as
 *   `serveCreateItem` writes one, because the entry names it. Each entry
 *   the note replaces (EO-594) is an active one an agent wrote, of the
 *   item's project.
 * - **A person's write names an entry this record holds**, of a project
 *   it holds, and is sourced to the person the asking device belongs to.
 *
 * Then the same `applyMemoryWrite` a solo desktop's own record makes.
 * Answers with every row it changed, so the device copies them into its
 * replica at once, and tells everybody else to ask again.
 */
export async function serveMemory(context: ServeRecordContext, payload: IpcPayload<"record:memory">): Promise<IpcResponse<"record:memory">> {
  const { db } = context;
  const refuse = (problem: string): IpcResponse<"record:memory"> => ({ result: { ok: false, problem }, changed: [] });
  const write = payload.write;
  const person: MemorySource = { type: "person", personId: personOfDevice(db, payload.deviceId)?.id ?? null };

  let request: MemoryWriteRequest;
  let projectId: string | null | undefined;
  switch (write.op) {
    case "note": {
      const item = getItem(db, write.itemId as Uuid);
      if (item === undefined) return refuse("this record no longer has the item that run is on, so the note was not saved.");
      if (item.projectId === null) return refuse(`${item.key} is on no project, so there is no memory to write to.`);
      const run = payload.run;
      if (run === null || run.itemId !== item.id) return refuse(`that run is not a run on ${item.key}, so the note was not saved.`);
      const held = getRun(db, run.runId as Uuid);
      if (held !== undefined && held.itemId !== item.id) return refuse(`that run is not a run on ${item.key}, so the note was not saved.`);
      // The asking device ran it. Either the record already has the run's
      // transcript from that device — a run with no lease, a reply or a
      // recovery, whose lines it sent — or the device holds the item's
      // lease and no other machine's lines are on the run: a dispatch,
      // and the extraction that ends one before the lease goes. Anything
      // else is a device writing in another machine's run's name.
      const lease = context.record.leaseFor(item.id as Uuid);
      const holdsLease = lease !== null && lease.deviceId === payload.deviceId;
      const writers = held === undefined ? new Set<string>() : runEventDevices(db, held.id as Uuid);
      const ranIt = writers.has(payload.deviceId) || (holdsLease && writers.size === 0);
      if (!ranIt) return refuse(`this machine did not run that run on ${item.key}, so the note was not saved.`);
      // The rules `memory_note` holds a note to, against the item's own
      // project. A note naming another project is one this item's run
      // does not work in — and a container one its item is not filed
      // under (EO-596), which the record knows as well as the device.
      const container = containerScopeOf(db, item);
      const scopes = [
        { kind: "project" as const, id: item.projectId, name: "this project" },
        ...(write.scope.kind === "workspace" ? [{ kind: "workspace" as const, id: write.scope.id, name: write.scope.id }] : []),
        ...(container === null ? [] : [{ ...container.scope, name: container.name }]),
      ];
      const asked = write.scope.kind === "project" ? (write.scope.id === item.projectId ? MEMORY_NOTE_PROJECT_SCOPE : write.scope.id) : write.scope.id;
      const checked = checkMemoryNote({ scope: asked, text: write.body }, scopes);
      if (!checked.ok) return refuse(checked.problem);
      projectId = item.projectId;
      if (!heldHere(db, projectId)) return refuse("this record does not hold that project's memory, so the note was not saved.");
      // Written only when the record has never heard of it, and only for
      // the device holding the lease: a note is not a run report, and an
      // existing run is the drain's to update, never this request's.
      if (held === undefined) {
        try {
          upsertReportedRun(db, run);
        } catch (error) {
          return refuse(`the run that wrote it could not be recorded, so the note was not saved: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // The entries it replaces (EO-594) may be of the item's project
      // alone: its own scope, or a workspace this record holds the
      // project's memory for. Which of those workspaces the run works in
      // is the device's word, and the device held the note to it.
      const replaceable = write.replaces.flatMap((id) => {
        const entry = getMemory(db, id);
        return entry !== undefined && memoryEntryProjectId(db, id) === item.projectId ? [entry.scope] : [];
      });
      request = {
        op: "note",
        item,
        runId: run.runId as Uuid,
        scope: checked.scope,
        body: checked.body,
        extracted: write.extracted,
        ...(write.replaces.length === 0 ? {} : { replaces: write.replaces, scopes: replaceable }),
      };
      break;
    }
    case "add": {
      projectId = write.projectId;
      if (write.scope.kind === "project" && write.scope.id !== projectId) return refuse("that entry names one project and is filed under another, so nothing was saved.");
      if (write.scope.kind === "container" && memoryScopeProjectId(db, write.scope) !== projectId) return refuse("that entry names a container of another project, or no container at all, so nothing was saved.");
      if (!heldHere(db, projectId)) return refuse("this record does not hold that project's memory, so nothing was saved.");
      request = { op: "add", scope: write.scope, body: write.body };
      break;
    }
    default: {
      projectId = memoryEntryProjectId(db, write.id);
      if (projectId === undefined) return refuse(`no memory entry has the id "${write.id}".`);
      if (projectId === null || !heldHere(db, projectId)) return refuse("this record does not hold that entry's project, so nothing was changed.");
      request = write;
    }
  }

  let result;
  try {
    result = applyMemoryWrite(db, request, person, projectId);
  } catch (error) {
    return refuse(`the entry could not be written: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!result.ok) return { result, changed: [] };
  // An edit retires one row and writes another, and a note retires what
  // it replaces (EO-594); the device needs every one.
  const ids = request.op === "edit" ? [request.id, result.entry.id] : request.op === "note" ? [...(request.replaces ?? []), result.entry.id] : [result.entry.id];
  // The record changed, so every device and every open browser is told
  // to ask again — which is how the entry reaches the other desktops,
  // and an open memory panel.
  emitPush("items:changed", {});
  return { result, changed: recordMemories(db, ids) };
}

/**
 * A scope's consolidations, as this record ran them (EO-482), one page at
 * a time newest first (EO-545): the device follows `next` to the last.
 */
export async function serveMemoryConsolidations(
  context: ServeRecordContext,
  payload: IpcPayload<"record:memoryConsolidations">,
): Promise<IpcResponse<"record:memoryConsolidations">> {
  const limit = payload.limit ?? MAX_RECORD_CONSOLIDATIONS_PAGE;
  // One more than the page, to know whether there is another.
  const read = listConsolidations(context.db, payload.scope, { ...(payload.before === undefined ? {} : { before: payload.before }), limit: limit + 1 });
  const consolidations = read.slice(0, limit);
  const last = consolidations[consolidations.length - 1];
  return { consolidations, next: read.length > limit && last !== undefined ? { startedAt: last.startedAt, id: last.id } : null };
}

/**
 * A device undoing a consolidation this record made (EO-482), under this
 * record's caps — consolidation of its projects runs here, so the scope
 * is settled here.
 */
export async function serveRestoreMemoryConsolidation(
  context: ServeRecordContext,
  payload: IpcPayload<"record:restoreMemoryConsolidation">,
): Promise<IpcResponse<"record:restoreMemoryConsolidation">> {
  const { db } = context;
  const refuse = (problem: string): IpcResponse<"record:restoreMemoryConsolidation"> => ({ result: { ok: false, problem }, changed: [] });
  const consolidation = getConsolidation(db, payload.consolidationId);
  if (consolidation === undefined) return refuse(`no consolidation on this record has the id "${payload.consolidationId}".`);
  const touched = [...consolidation.retiredIds, ...consolidation.writtenIds];
  const projectId = touched.length === 0 ? null : (memoryEntryProjectId(db, touched[0]!) ?? null);
  if (projectId !== null && !heldHere(db, projectId)) return refuse("this record does not hold that consolidation's project, so nothing was restored.");
  const caps = context.memoryCaps?.() ?? { maxEntries: DEFAULT_MEMORY_SCOPE_MAX_ENTRIES, maxChars: DEFAULT_MEMORY_SCOPE_MAX_CHARS };
  const result = restoreConsolidation(db, payload.consolidationId, { caps });
  if (!result.ok) return { result, changed: [] };
  // The record changed, so every device and every open browser is told
  // to ask again — which is how the entry reaches the other desktops,
  // and an open memory panel.
  emitPush("items:changed", {});
  // What it changed, which includes evidence a proposed skill took and
  // neither of the consolidation's lists names (EO-546), so the device
  // holds every row the restore made active again at once.
  return { result, changed: recordMemories(db, [...new Set([...touched, ...result.changedIds])]) };
}

/**
 * Whether this record holds a project's memory: the project is here and
 * has finished arriving. A project still being handed over is the
 * sending desktop's until the transfer commits (EO-325), so its memory is
 * written there and travels with it.
 */
function heldHere(db: Db, projectId: string): boolean {
  const project = getProject(db, projectId as Uuid);
  return project !== undefined && project.adoptingAt === null;
}

/**
 * The commands a device made, applied in the order it made them.
 *
 * One result per command, and a refusal stops nothing: the batch is a
 * history, not a transaction. A move the record will not apply is one
 * command of it, and the comment that was written beside that move is
 * still something somebody said.
 */
export async function serveApply(
  context: ServeRecordContext,
  payload: IpcPayload<"record:apply">,
): Promise<IpcResponse<"record:apply">> {
  const results: RecordCommandResult[] = [];
  for (const command of payload.commands) {
    results.push(await applyOne(context, payload.deviceId, command));
  }
  // A device's work landing on the record is a change every other
  // device and every open browser has to hear about — that is the whole
  // of "two desktops see the same board" (EO-324). Announced here
  // rather than by whichever door the request came through, because it
  // is the *record* that changed: a second door would be a second place
  // to remember, and forgetting there is a board that stops refreshing
  // on one kind of client.
  //
  // A push carries no data by contract; this is the "ask again", and
  // `record:changes` is the asking.
  if (results.some((one) => one.applied)) emitPush("items:changed", {});
  return { results };
}

async function applyOne(context: ServeRecordContext, deviceId: string, command: RecordCommand): Promise<RecordCommandResult> {
  const ok: RecordCommandResult = { id: command.id, applied: true, superseded: null, problem: null, heldBy: null, holder: null, notPermitted: null };
  const refused = (problem: string): RecordCommandResult => ({
    id: command.id,
    applied: false,
    superseded: null,
    problem,
    heldBy: null,
    holder: null,
    notPermitted: null,
  });

  const { db, record } = context;
  const item = getItem(db, command.itemId as Uuid);
  if (item === undefined) {
    // Not an error and not retried. The item is gone from the record —
    // deleted by somebody (KAN-30) — so there is nothing for the
    // command to be about, and the device is told so it can stop
    // asking.
    return refused("This record no longer has that item.");
  }

  // A command that names a run the record does not have (EO-324).
  //
  // `comments.run_id` and `transitions.run_id` are foreign keys and
  // this process enforces them, so applying one would not be a wrong
  // answer — it would be an exception out of the middle of a batch,
  // taking every command behind it with it.
  //
  // It should not happen: the drain carries a prerequisite run in the
  // same request, immediately before the command that needs it. This is
  // what that guarantee looks like when it is not kept, and it is a
  // sentence rather than a crash because the person whose comment this
  // is deserves to know it did not arrive (invariant #8).
  const runBehind = command.kind === "comment" || command.kind === "transition" || command.kind === "sideCall" ? command.runId : null;
  if (runBehind !== null && getRun(db, runBehind as Uuid) === undefined) {
    return refused("This record has no such run — send the run before what it produced.");
  }

  // A claim or an assignment refused outright, with who the record has
  // holding the item (EO-367, review). The device showed the change the
  // moment it was made, and a refusal writes nothing here — so no newer
  // row will reach it on a pull, and it has to be told what to put back.
  const refusedHolding = (problem: string): RecordCommandResult => ({ ...refused(problem), holder: holderOf(db, item.assigneeId) });

  // Something a person may not do on a group-owned human step (EO-368):
  // not in the step's group, or not the person holding the item. Not a
  // `problem` — nothing is wrong with the command — and not `superseded`
  // either: the device says why in the person's own inbox, naming the
  // group or the holder, and puts back what it had shown. The holder
  // travels too, for the claim's reason: a refusal writes nothing here,
  // so no newer row would reach the device to correct its card.
  const notPermitted = (refusal: StepRefusal): RecordCommandResult => ({
    ...ok,
    applied: false,
    holder: holderOf(db, item.assigneeId),
    notPermitted: refusal,
  });

  switch (command.kind) {
    case "transition": {
      // **Already applied, and the device never heard so.**
      //
      // The case is ordinary and the consequence of missing it is not:
      // the record applies a move, the acknowledgement is lost — the
      // socket drops, the laptop lid closes — and the device replays
      // the command it still holds. By then the item *has* moved, so
      // the conflict rule below would find `fromStepId` stale and
      // answer `superseded`, and the device would drop its own move and
      // raise an inbox row naming itself as the person who overtook it.
      // A false accusation about a move that in fact succeeded.
      //
      // So identity is asked before conflict. `transitionId` is the
      // move's own id on both sides (see the command's own note), which
      // is exactly what makes "have I already done this" answerable —
      // and answering it `applied` is the truth: it was.
      if (hasTransition(db, command.transitionId)) return ok;
      if (getStep(db, command.toStepId) === undefined) {
        return refused(`This record has no step "${command.toStepId}".`);
      }
      // **The conflict rule** (ARCHITECTURE.md, "The record"). The device said where
      // it believed the item was; the record applies the move only if
      // that is still true. Refusing is not a failure — the command was
      // good and the world moved — so it comes back as `superseded`
      // with the record's own answer, and the device turns that into
      // the inbox row.
      //
      // A command that claims nothing about the previous step applies
      // unconditionally. That is what a first arrival and a replayed
      // old-format command look like, and the alternative — refusing
      // everything that cannot prove where it came from — would drop
      // work to protect a check.
      if (command.fromStepId !== null && item.stepId !== command.fromStepId) {
        return {
          id: command.id,
          applied: false,
          superseded: { stepId: item.stepId ?? "", by: whoMovedIt(db, command.itemId as Uuid) },
          problem: null,
          heldBy: null,
          holder: null,
          notPermitted: null,
        };
      }
      // **A person moving an item off a group-owned human step** (EO-368).
      // Only the holder may, and the person is the one the sending device
      // belongs to — never anything the command says. Asked after the
      // identity check and the conflict rule above: a replayed move that
      // already landed is "already done", and one overtaken by somebody
      // else's is told so in those words rather than judged against a
      // step it never meant to leave.
      //
      // Only a person's move. An agent finishing its run, a module and
      // the engine move items as they always have: they are not somebody
      // deciding on a human step, and refusing them would strand work.
      //
      // …and a decision the system agent pressed (EO-585), which is a
      // person's act made by their assistant and is held to the same
      // rule as theirs: it acts with the authority of the person whose
      // device sent it, never more. The one exception is a trial item,
      // where standing in for whoever the step would ask is the whole of
      // the assistant's job.
      if (command.actor === "human" || (isDecision(command.reason) && item.trialAt === null)) {
        const refusal = judgeOnGroupStep(db, item, personOfDevice(db, deviceId)?.id ?? null, "change");
        if (refusal !== null) return notPermitted(refusal);
      }
      // **The pipeline it is entering** (EO-610, ARCHITECTURE.md, "Entry
      // rules"). The device asked its own copy before it showed the move,
      // but that copy can be behind this one. After the checks above, for
      // their reason: a move that is overtaken or not this person's to
      // make is told so, rather than judged against where it was going.
      //
      // Clearing a step that is being removed is exempt here as it is at
      // the door: that work is not entering anywhere by choice.
      if (!isStepClearance(command.reason)) {
        const sentence = itemEntryRefusal(db, item, command.toPipelineId, command.toStepId);
        if (sentence !== null) return notPermitted({ why: "entryRules", groupName: "", holder: holderView(db, item.assigneeId), stepId: item.stepId, pipelineId: item.pipelineId, sentence });
      }
      record.applyTransition({
        // The device's id for this move, so the two audit rows are one
        // row rather than two accounts of the same thing.
        id: command.transitionId as Uuid,
        itemId: command.itemId as Uuid,
        toStepId: command.toStepId,
        toPipelineId: command.toPipelineId as Uuid | null,
        actor: command.actor,
        deviceId,
        runId: command.runId as Uuid | null,
        reason: command.reason,
      });
      return ok;
    }

    case "comment": {
      // By the comment's own id, so a replay appends nothing. A thread
      // that grew a duplicate per reconnect would be invariant #4's one
      // channel quietly corrupting itself.
      if (getComment(db, command.commentId as Uuid) !== undefined) return ok;
      const said = postComment(db, {
        id: command.commentId as Uuid,
        itemId: command.itemId as Uuid,
        author: authorOf(command.authorType, command.authorId),
        body: command.body,
        kind: command.kindOfComment as never,
        options: command.options,
        runId: command.runId as Uuid | null,
        parentId: command.parentId as Uuid | null,
        createdAt: command.createdAt,
        // What the device resolved, stored as it resolved it — and
        // nothing re-parsed from the body. `@reviewer` means whichever
        // agent the person was looking at, an explicit target never
        // appeared in the body at all, and a record that made up its
        // own mind about either would dispatch somebody else's work or
        // nobody's.
        mentions: command.mentions.map((mention) =>
          mention.type === "agent"
            ? { type: "agent" as const, agentId: mention.agentId as Uuid }
            : // The person the sender named, where they named one
              // (EO-325). Null still means "whoever is in front of
              // you", which is what a solo desktop and an old queued
              // command both mean by a human mention.
              { type: "human" as const, ...(mention.personId === null ? {} : { personId: mention.personId as Uuid }) },
        ),
        parseBodyMentions: false,
        // A person's pin travels with what they pinned: it is what
        // survives context truncation (ARCHITECTURE.md, "What an agent is given"), so a pin that
        // reached one
        // machine and not the record is an agent elsewhere reading a
        // thread with the important part cut out.
        pinned: command.pinned,
        // Deliberately *not* `staysHere`. The record owns the push to
        // anybody's tracker (EO-324, `recordRole.ts`): the desktop that
        // wrote this suppressed its own, precisely so that this one
        // happens once here rather than once per machine holding a
        // copy. Nothing is queued onward either way — a record has no
        // record to send to.
      });
      // …and whether each mention is still waiting (EO-325, review).
      // Open for everything a device queues, because a comment is
      // queued the moment it is said — carried and applied anyway, so
      // that the one path and the other cannot come to disagree about
      // what a mention means.
      for (const mention of command.mentions) {
        if (mention.status === "open") continue;
        const answeredBy =
          mention.addressedBy !== null && getComment(db, mention.addressedBy as Uuid) !== undefined ? mention.addressedBy : null;
        settleMention(db, {
          commentId: command.commentId as Uuid,
          targetType: mention.type,
          targetId: mention.type === "agent" ? mention.agentId : (mention.personId ?? null),
          status: mention.status,
          addressedBy: answeredBy,
        });
      }
      // The files are not inserted here. Their metadata arrived with
      // the comment so that a reader knows what to expect, and the rows
      // are written when the bytes land — an attachment row pointing at
      // a file the record does not hold is a broken link on the admin's
      // board and an error on anybody who opens it.
      //
      // Save or Discard from a device, on a skill proposal the record's
      // own consolidation posted (EO-483): carried out here, where the
      // proposal is. Anywhere else this answers null.
      if (said.authorType === "human" && said.parentId !== null) answerCopiedSkillProposal(db, said);
      return ok;
    }

    case "mention": {
      // A mention somebody answered or dismissed after its comment had
      // already gone up (EO-325). Refused rather than invented when the
      // comment is absent: a settlement for a thread this record has
      // never seen is a queue replayed against the wrong record, and
      // writing it would leave a row nothing can ever join to.
      if (getComment(db, command.commentId as Uuid) === undefined) {
        return refused("This record has no such comment.");
      }
      // The reply and the settlement are two commands and nothing
      // orders them, so the comment named here may not have landed.
      // Drop the reference, keep the settlement — which of two comments
      // answered it matters less than the person's inbox being right.
      const answeredBy =
        command.addressedBy !== null && getComment(db, command.addressedBy as Uuid) !== undefined ? command.addressedBy : null;
      settleMention(db, {
        commentId: command.commentId as Uuid,
        targetType: command.targetType,
        targetId: command.targetId,
        status: command.status,
        addressedBy: answeredBy,
      });
      return ok;
    }

    case "pin": {
      // Idempotent by construction: setting a pin to what it already is
      // writes the same row. A replayed queue costs one statement.
      if (getComment(db, command.commentId as Uuid) === undefined) {
        return refused("This record has no such comment.");
      }
      setCommentPinned(db, command.commentId as Uuid, command.pinned);
      return ok;
    }

    case "attachment": {
      if (context.attachments === undefined) {
        return refused("This EO server was started without anywhere to keep attachments.");
      }
      // One of the item's own files (EO-702) needs only its item, which
      // the record has by now — that much is asked of every command above.
      if (command.commentId !== null && getComment(db, command.commentId as Uuid) === undefined) {
        return refused("This record has no such comment — send the comment before its files.");
      }
      // Already here, which is what a replayed queue looks like. By the
      // attachment's own id, exactly as a comment is by its own.
      if (getAttachment(db, command.attachmentId as Uuid) !== undefined) return ok;
      // …or removed already: a removal queued behind a file a slow
      // replay is still sending. Taking it in now would bring it back.
      if (attachmentWasRemoved(db, command.attachmentId as Uuid)) return ok;
      return storeAttachment(context, command);
    }

    case "attachmentRemoval": {
      // One of the item's own files, taken off it on a desktop (EO-702).
      // A comment's file is refused by `removeItemAttachment` itself: it
      // goes only with its comment. Noted even when the record never had
      // the file, so a removal is never the thing that is lost.
      const removed = removeItemAttachment(db, command.attachmentId as Uuid, { announce: false });
      if (removed === undefined) {
        const held = getAttachment(db, command.attachmentId as Uuid);
        if (held !== undefined) return refused(`${held.name} is on a comment, and goes only with that comment.`);
        noteAttachmentRemoved(db, command.attachmentId as Uuid, command.itemId as Uuid, Date.now());
        return ok;
      }
      await context.attachments?.removeManaged?.(removed);
      return ok;
    }

    case "claim": {
      // Already applied, and the device never heard so — the claim's
      // `hasTransition`. Asked before arbitration for the same reason:
      // by now the item *is* held, by this very claim, and arbitrating
      // again would tell the claimant they had lost to themselves.
      if (getComment(db, command.commentId as Uuid) !== undefined) return ok;
      // Who is claiming is the person this machine belongs to, and
      // nothing in the payload can say otherwise.
      const claimant = personOfDevice(db, deviceId);
      if (claimant === undefined) {
        return refusedHolding("This record cannot say whose machine that claim came from, so it cannot say who is claiming.");
      }
      // Only a member of the step's group may claim an item on it
      // (EO-368). Who already holds it is the arbitration below, which
      // says so in its own words.
      const outsider = judgeOnGroupStep(db, item, claimant.id, "claim");
      if (outsider !== null) return notPermitted(outsider);
      const verdict = arbitrateClaim(item, claimant.id);
      if (verdict.kind === "already") return ok;
      if (verdict.kind === "held") {
        // **The record arbitrates** (EO-367). Somebody's claim reached
        // it first; this one is dropped, and the device is told whose
        // the item is so it can say so to the person who lost — the
        // claim's `superseded`, and the same promise: never a silent
        // revert.
        return {
          id: command.id,
          applied: false,
          superseded: null,
          problem: null,
          heldBy: { personId: verdict.holderId, name: getPerson(db, verdict.holderId as Uuid)?.name || SOMEONE_ELSE },
          holder: null,
          notPermitted: null,
        };
      }
      writeAssignment(db, { itemId: item.id, person: claimant, how: "claim", commentId: command.commentId as Uuid });
      return ok;
    }

    case "assign": {
      if (getComment(db, command.commentId as Uuid) !== undefined) return ok;
      const person = getPerson(db, command.personId as Uuid);
      if (person === undefined) return refusedHolding("This record has no such person to give that item to.");
      // Who chose, from the machine that asked — "Assigned to Dana by
      // Anna." — because the thread is where a person re-reading the
      // item finds out somebody decided for them.
      const by = personOfDevice(db, deviceId)?.name;
      writeAssignment(db, {
        itemId: item.id,
        person,
        how: "assign",
        commentId: command.commentId as Uuid,
        ...(by === undefined ? {} : { by }),
      });
      return ok;
    }

    case "takeover": {
      // Already applied — the claim's replay rule, by the comment's id.
      if (getComment(db, command.commentId as Uuid) !== undefined) return ok;
      const taker = personOfDevice(db, deviceId);
      if (taker === undefined) {
        return refusedHolding("This record cannot say whose machine that takeover came from, so it cannot say who is taking the item.");
      }
      // **A member taking the item from the holder they were warned
      // about, and from nobody else** (EO-368). The record applies it only
      // if that is still who holds it; if the item changed hands since
      // the warning, nothing is taken and the device is told who holds it
      // now.
      const refusal = judgeOnGroupStep(db, item, taker.id, "takeover", command.fromPersonId);
      if (refusal !== null) return notPermitted(refusal);
      const previous = holderOf(db, item.assigneeId).person;
      // A step that is not group-owned has no warning and no takeover —
      // nothing there limits who decides, so there is nothing to take
      // over. Refused rather than applied: an item handed over on a step
      // nothing gates is an assignment, and `assign` is that command.
      if (groupStepOf(db, item) === null || previous === null || previous.id !== command.fromPersonId) {
        return refusedHolding("Only an item on a step that waits on a group can be taken over, and only from the person holding it.");
      }
      writeTakeover(db, { itemId: item.id, person: taker, previous, commentId: command.commentId as Uuid });
      return ok;
    }

    case "rebind": {
      // A move to another version of the item's pipeline (EO-567).
      // Already applied — the claim's replay rule, by the comment's id.
      if (getComment(db, command.commentId as Uuid) !== undefined) return ok;
      // Judged again here, against this record's own versions and where
      // the item is on it: the device asked about its replica, and the
      // item may have moved since. A refusal writes nothing, and the
      // device says the sentence on the item.
      const plan = planVersionMove(db, item, command.version);
      if (!plan.ok) return refused(plan.problem);
      // Something is working on it — a device holds the lease, or a run
      // is still live. `items:move`'s guard, as the record knows it.
      const lease = leaseFor(db, item.id);
      const live = listRunsForItem(db, item.id).some((run) => run.status === "running" || run.status === "queued");
      if ((lease !== null && lease.expiresAt > Date.now()) || live) {
        return refused(`An agent is working on ${item.key}, so it was not moved to version ${command.version}. Try again once the run has finished.`);
      }
      // Not refused for a published, locked pipelines section: the lock
      // is on the graph, and this changes which version of it one item
      // finishes on, not the graph itself.
      writeVersionMove(db, {
        item,
        move: plan,
        by: personOfDevice(db, deviceId)?.name || SOMEONE_ELSE,
        note: command.note,
        commentId: command.commentId as Uuid,
      });
      return ok;
    }

    case "run": {
      upsertReportedRun(db, command);
      return ok;
    }

    case "watch": {
      // Where a watch on a step that keeps checking now stands (EO-456).
      // The device that checked it held the lease, so its row is the
      // truth; stamped with this record's clock, which is the one every
      // other device pages the watch feed on — unless it is behind what
      // the record already knows: a report about a stay this record's
      // own transitions say is over, or one showing fewer checks than
      // the current watch has (`isStaleWatchReport`). Left out and still
      // acknowledged, because a stale report is answered by the device's
      // next pull, not by sending it again.
      mirrorItemWatch(db, command, Date.now());
      return ok;
    }

    case "sideCall": {
      // What a side call a device made about this item cost (EO-514),
      // so that this record's per-person budget — which sums its own
      // `side_calls` rows by the owner of each one's project — counts
      // it. Filed under the project this record has the item on, not one
      // the device names: that is the project the budget reads.
      mirrorReportedSideCall(db, {
        id: command.sideCallId as Uuid,
        purpose: command.purpose,
        projectId: (item.projectId as Uuid | null) ?? null,
        itemId: item.id,
        runId: (command.runId as Uuid | null) ?? null,
        backend: command.backend,
        model: command.model,
        tokensIn: command.tokensIn,
        tokensOut: command.tokensOut,
        costMicrocents: command.costMicrocents,
        startedAt: command.startedAt,
        durationMs: command.durationMs,
        outcome: command.outcome,
        reason: command.reason,
      });
      return ok;
    }

    case "runEvents": {
      if (getRun(db, command.runId as Uuid) === undefined) {
        // Deliberately a refusal rather than a run invented here. A run
        // row carries which agent, which step and how it ended, and
        // none of that is in an event batch — a row conjured to hold
        // the events would be a run the record could not describe. The
        // device sends the row first; if it did not, saying so is how
        // it finds out.
        return refused("This record has no such run — send the run before its events.");
      }
      appendSyncedRunEvents(
        db,
        command.runId as Uuid,
        deviceId,
        command.events.map((event) => ({ seq: event.seq, ts: event.ts, type: event.type, payload: event.payload })),
      );
      return ok;
    }

    default:
      return refused("This record does not understand that command.");
  }
}


/**
 * A project handed over, one page at a time (EO-325,
 * `ARCHITECTURE.md`, "What a person sees first", "Identity").
 *
 * The record's side of a move. What arrives is somebody's existing
 * work, ids and all, and what this does is write it and say how much of
 * it it wrote. It decides nothing about *whether* the project should
 * move — that is the person's, on the machine the project is on — and
 * it asks the scheduler nothing, because a page of history is not a
 * dispatch.
 *
 * The project row is written on every page rather than only the first.
 * Cheap, and it removes the one ordering assumption this would
 * otherwise carry: there is no "first request" to be lost, retried out
 * of order, or sent by a device that reconnected half way through.
 *
 * The key counter comes with it, and it is the least obvious thing here
 * and the most damaging to omit. The record mints the next item key on
 * this prefix, and a counter left at 1 beside two hundred moved items
 * means the next thing anybody files collides on `items.key` — as a
 * unique-index error, not as anything a person could read.
 *
 * One push at the end, for `serveApply`'s reason: what changed is the
 * *record*, and every other device and every open browser has to hear
 * about it.
 *
 * ## Whose the project becomes is not the client's to say
 *
 * The device sent `ownerId` at first, and that was a way for any
 * signed-in machine to name any other person on the organisation's list
 * and make somebody else the owner of a project they had never seen.
 * The door authenticates a device token and stamps the device id on the
 * payload (`server/http.ts`, `DEVICE_SCOPED_CHANNELS`), and a device
 * belongs to a person (EO-323) — so the person is *derived* from the
 * one field in this request a client cannot choose, and the field that
 * could be chosen no longer exists. `project.ownerId` arrives with the
 * row and is ignored for exactly the same reason.
 *
 * ## The project is not live until the last page says so
 *
 * The review's second finding. This wrote the project live on the first
 * page, so an organisation's board could draw half a project and its
 * scheduler could dispatch an item whose thread and runs were still on
 * somebody's laptop — while that laptop's scheduler still held the same
 * item. Two writers for one item.
 *
 * So a project arrives *adopting*: the row exists, because every other
 * table in a page references it and foreign keys have to resolve, and
 * `adopting_at` keeps it out of `record:changes` and out of the
 * scheduler's input until `final` arrives. A transfer that never
 * finishes leaves something hidden and harmless that its owner can
 * resume or abandon, and nobody else can touch.
 *
 * ## Files arrive here, not behind this
 *
 * One per request, because one fills a request. They were queued behind
 * the move at first and that let a move report success with its
 * attachments still unsent — see `RecordAdoptCountsSchema`. A file
 * whose bytes this record has nowhere to put is *refused*, not counted:
 * "EO took your file and has no idea where it is" is the one answer
 * that must not be possible.
 */
export async function serveAdopt(
  context: ServeRecordContext,
  payload: IpcPayload<"record:adopt">,
): Promise<IpcResponse<"record:adopt">> {
  const { db } = context;
  const empty: RecordAdoptCounts = {
    itemTypes: 0,
    pipelines: 0,
    steps: 0,
    routes: 0,
    agents: 0,
    jobs: 0,
    occurrences: 0,
    items: 0,
    runs: 0,
    runEvents: 0,
    transitions: 0,
    comments: 0,
    mentions: 0,
    deps: 0,
    extensions: 0,
    attachments: 0,
    memories: 0,
    skills: 0,
    skipped: [],
  };

  // Whose it becomes, from the token the door already checked.
  const device = getDevice(db, payload.deviceId);
  if (device === undefined) {
    return {
      accepted: empty,
      problem: "This record does not know the machine asking to move that project, so it has nobody to give it to.",
    };
  }
  const ownerId = device.personId as Uuid;
  if (getPerson(db, ownerId) === undefined) {
    return {
      accepted: empty,
      problem: "This record has no row for the person that machine belongs to, so it has nobody to own that project.",
    };
  }

  // Giving up on one that did not finish, which is a request in its own
  // right rather than a page with nothing on it.
  if (payload.abandon) {
    const gone = abandonAdoptedProject(db, payload.project.id as Uuid, ownerId);
    if ("problem" in gone) return { accepted: empty, problem: gone.problem };
    emitPush("items:changed", {});
    emitPush("config:changed", {});
    return { accepted: empty, problem: null };
  }

  const written = writeAdoptedProject(db, payload.project, ownerId, Date.now(), payload.final);
  if (!written.ok) return { accepted: empty, problem: written.problem };

  carryKeyCounter(db, payload.project.keyPrefix, payload.keyNextValue);
  const accepted = writeAdoptedPage(db, payload.project, payload.page, payload.deviceId);
  catchUpSteps(context, payload);
  for (const file of payload.page.attachments) {
    const kept = await keepAdoptedFile(context, file);
    if (kept === null) accepted.attachments += 1;
    else accepted.skipped.push(kept);
  }
  tellThreadOfUncarriedTools(context, payload.project.id as Uuid);
  emitPush("items:changed", {});
  emitPush("config:changed", {});
  return { accepted, problem: null };
}

/**
 * Tells the moved project's thread which of its agents' tools did not
 * come with them (EO-513, invariant 8).
 *
 * A move carries the project's own skills and its workspaces'. What an
 * agent is attached to beyond those — a global skill, which is the
 * installation's and reaches an organisation only by its own publishing,
 * another project's skill, an MCP server this record has no row for — is
 * not on the record, so the agent works here without it, and so does
 * every replica that takes the agent from here. That is said rather than
 * left to be discovered, once the project is live and its thread is
 * here: every agent, and every tool by the name the sender gave it.
 *
 * Nothing to say before the page that makes the project live, and
 * nothing twice: what is said is forgotten, and a re-sent page finds
 * nothing kept. A thread that cannot be opened keeps it for the next page.
 */
function tellThreadOfUncarriedTools(context: ServeRecordContext, projectId: Uuid): void {
  const { db } = context;
  // The comment and the forgetting commit together, or neither does — see
  // `sayUncarriedTools`. A comment that cannot be written fails this
  // request, which the device sends again, and the warning is still kept.
  sayUncarriedTools(db, projectId, (uncarried) => {
    const thread = openProjectThread(db, projectId);
    if (!thread.ok) return false;
    postComment(db, { itemId: thread.item.id, author: { type: "engine" }, body: uncarriedToolsSentence(uncarried) });
    return true;
  });
}

/** The comment `sayUncarriedTools` posts: one line per agent, naming each tool. */
export function uncarriedToolsSentence(uncarried: readonly UncarriedTools[]): string {
  const lines = uncarried.map((agent) => {
    const tools = [
      ...agent.skills.map((skill) => `the skill "${skill.name}"`),
      ...agent.mcpServers.map((server) => `the MCP server "${server.name}"`),
    ];
    return `- ${agent.agentName}: ${tools.join(", ")}`;
  });
  return [
    "Some of this project's agents are attached to tools that did not move to the organisation's record with it, so they run without them here and on every desktop:",
    "",
    ...lines,
    "",
    "A move carries the project's own skills and its workspaces'. A global skill or an MCP server reaches the record when the organisation publishes it; then attach it to the agent again.",
  ].join("\n");
}

/**
 * An item that moved while its page was in flight, moved here too
 * (EO-325).
 *
 * `writeAdoptedPage` updates everything about an item *except* where it
 * sits, because where an item sits is invariant #1's subject and
 * `transitionItem` is its only writer — the architectural test reads
 * that `.set({...})` as source text and would fail on any other
 * arrangement. So a step that changed during the transfer arrives here
 * as what it is: a move, applied through the record's own door.
 *
 * Only ever a handful, and usually none: the sending machine's
 * scheduler is frozen for the length of the transfer, so the only thing
 * that can move a card is a person deciding on a human step or dragging
 * it while they watch the move run.
 *
 * The audit row for their own move went up with the page and is already
 * written; this is the position catching up with it, and it says so.
 */
function catchUpSteps(context: ServeRecordContext, payload: IpcPayload<"record:adopt">): void {
  for (const sent of payload.page.items) {
    if (sent.stepId === null) continue;
    const held = getItem(context.db, sent.id as Uuid);
    if (held === undefined || held.stepId === sent.stepId) continue;
    if (getStep(context.db, sent.stepId) === undefined) continue;
    context.record.applyTransition({
      itemId: sent.id as Uuid,
      toStepId: sent.stepId,
      toPipelineId: sent.pipelineId as Uuid | null,
      actor: "human",
      deviceId: payload.deviceId,
      reason: "Caught up with a move made while this project was being handed over.",
    });
  }
}

/**
 * One moved file's bytes, onto the record's disk and into its tables.
 *
 * Answers null for kept and a sentence for not, rather than throwing:
 * the page it came on has already landed, and an exception here would
 * take the account of what *did* land with it.
 *
 * Idempotent by the file's own id, which is what makes a retried move
 * free. The row is written only once the bytes are on disk — a row
 * pointing at a file the record does not hold is a broken link on the
 * admin's board and an error on anybody who opens it.
 */
async function keepAdoptedFile(context: ServeRecordContext, file: RecordAdoptedAttachment): Promise<string | null> {
  const { db } = context;
  if (context.attachments === undefined) {
    return `${file.name}: this EO server was started without anywhere to keep attachments`;
  }
  if (file.commentId !== null && getComment(db, file.commentId as Uuid) === undefined) {
    return `${file.name}: this record has no comment for it to hang off`;
  }
  // One of the item's own files (EO-702) hangs off the item instead.
  if (file.commentId === null && getItem(db, file.itemId as Uuid) === undefined) {
    return `${file.name}: this record has no item for it to belong to`;
  }
  if (getAttachment(db, file.id as Uuid) !== undefined) return null;
  let stored;
  try {
    stored = await context.attachments.storeImported({
      name: file.name,
      mimeType: file.mimeType,
      data: Buffer.from(file.dataBase64, "base64"),
    });
  } catch (error) {
    return `${file.name}: this record could not keep it (${String(error)})`;
  }
  insertAttachments(db, [{ ...stored, id: file.id as Uuid, itemId: file.itemId as Uuid, commentId: file.commentId as Uuid | null }]);
  return null;
}

/**
 * What the record has that the asking device may not (the original design: "the admin
 * sees every project's board and inbox, because the record syncs up").
 *
 * Three lists, each with a cursor of its own, and each read strictly
 * after it. The pair — a timestamp and an id — is what makes a page
 * exact; `RecordCursorSchema` argues that at length, and it is the
 * difference between a cursor and a guess about a millisecond.
 *
 * Each answers with where *it* now stands, which is its own last row
 * and never "now": a list cut short at its page must not hand back a
 * cursor past what it actually sent, or the rows in between are never
 * asked for again. A list that sent nothing hands back the cursor it
 * was given, which is the honest answer to "nothing has happened here".
 *
 * Three cursors rather than one for the same reason they are pairs
 * rather than numbers: the lists fill at wildly different rates, and a
 * shared cursor would make each one's progress a function of the
 * others' — a backlog of ten thousand comments would hold up the board.
 */
export function serveChanges(
  context: ServeRecordContext,
  payload: IpcPayload<"record:changes">,
): IpcResponse<"record:changes"> {
  const { db } = context;
  const { cursors, limit } = payload;
  // One project's history, for a desktop whose cursors ran past it
  // before it was moved here — see `record:changes`.`within`.
  const within = payload.within ?? undefined;
  /**
   * …minus anything whose project is still arriving (EO-325).
   *
   * Filtered here rather than in the query, and the cursor is taken
   * from what is left, so the rows are simply read again on the next
   * pull rather than stepped over: an adopting project's items carry no
   * new `updated_at` when the transfer commits, so a cursor that had
   * advanced past them would have skipped them for good.
   */
  const arriving = itemsMidAdoption(db);
  const adoptingProjects = projectsMidAdoption(db);
  const items = listItemsUpdatedSince(db, cursors.items, limit, within).filter((item) => !arriving.has(item.id));
  const transitions = listTransitionsSince(db, cursors.transitions, limit, within);
  const comments = listCommentsSince(db, cursors.comments, limit, within);
  const pins = listPinsSince(db, cursors.pins, limit, within);
  // Mentions somebody answered or dismissed since this device last
  // looked (EO-325). Its own list for the reason the pins are: the
  // comment feed pages on when a comment was said and never revisits
  // it, so a reply written a week after the escalation went up closed
  // the mention on one machine and nowhere else.
  const settled = listSettledMentionsSince(db, cursors.mentions, limit, within);
  const runs = listRunsUpdatedSince(db, cursors.runs, limit, within);
  // Where every watch on a step that keeps checking stands (EO-456): the
  // next device leased one of these items carries its watch on from here.
  const watches = listItemWatchesUpdatedSince(db, cursors.watches, limit, within);
  const files = listAttachmentsSince(db, cursors.attachments, limit, within);
  // Item files somebody took off (EO-702): a removed row is gone, so the
  // list above cannot say so.
  const removals = listAttachmentRemovalsSince(db, cursors.attachmentRemovals, limit, within);
  const events = listRunEventsSince(db, cursors.runEvents, limit, within);
  // The projects the record holds and the graphs their items stand on
  // (EO-325). Without the first, a moved project's items arrive on
  // another desktop belonging to nothing and are drawn on no board;
  // without the second, `upsertReplicaItem` skips every one of them for
  // want of a step it can resolve.
  const movedProjects = listProjectsUpdatedSince(db, cursors.projects, limit, within);
  // …and the types their work is filed under. Without these a moved
  // project's own item type never reaches the other desktop, and its
  // items are either dropped for want of a type or quietly filed under
  // a local one that shares the word.
  // …minus any whose project is still arriving, filtered after the
  // query and with the cursor taken from what is left, exactly as the
  // items are: a type carries no new stamp when the transfer commits,
  // so a cursor that had advanced past it would have skipped it for
  // good.
  const types = listItemTypesSince(db, cursors.itemTypes, limit, within).filter(
    (type) => type.projectId === null || !adoptingProjects.has(type.projectId),
  );
  // …and not the graphs of a project that is still arriving (EO-325,
  // review). A replica that pulled one before its project existed wrote
  // it with `project_id = null` — it has no project to attach it to —
  // and its cursor moved past it, so finalising the transfer left the
  // graph installation-scoped on that desktop for ever. Filtered after
  // the query with the cursor taken from what is left, as the items and
  // the types are, so the rows are simply read again next time.
  //
  // The other half of that repair is on the record: finalising touches
  // the project's pipelines so they page once more, which covers a
  // replica that lacked the project for any other reason.
  const graphs = listPipelinesUpdatedSince(db, cursors.pipelines, limit, within).filter(
    (pipeline) => pipeline.projectId === null || !adoptingProjects.has(pipeline.projectId),
  );
  // …and those projects' own agents (EO-476), which travel with the
  // project as its graphs do — minus a project still arriving, for the
  // graphs' reason, with the cursor taken from what is left. Finalising
  // touches them so they page once more.
  const projectAgents = listProjectAgentsUpdatedSince(db, cursors.agents, limit, within).filter((agent) => !adoptingProjects.has(agent.projectId));
  // …and what the organisation has published, which is what makes a
  // desktop's copy of those graphs read-only (EO-329, ARCHITECTURE.md, "Publish, lock and
  // versions").
  //
  // Not scoped by `within`, unlike everything above it: a publish is
  // about a *section* of the installation rather than about one
  // project's history, and a device catching up on a moved project
  // still has to be told what it may not edit.
  const publications = listPublishedSectionsSince(db, cursors.publishedSections, limit);
  // …and the memory of the projects it holds and their workspaces
  // (EO-482), minus a project still arriving, for the graphs' reason —
  // filtered after the query with the cursor taken from what is left.
  // Finalising touches them so they page once more.
  const memoryRows = listMemoriesUpdatedSince(db, cursors.memories, limit, within).filter(
    (entry) => entry.projectId === null || !adoptingProjects.has(entry.projectId),
  );
  // …and their own skills and their workspaces' (EO-513), which their
  // agents are attached to — minus a project still arriving, for the
  // graphs' reason, but left out in the query rather than after it, so
  // its rows cannot fill a page and hold the cursor where it is.
  // Finalising stamps them again so they page once the project is live.
  const projectSkills = listProjectSkillsUpdatedSince(db, cursors.skills, limit, within);
  // Every edge, read once for the page rather than twice per item.
  const edges = items.length === 0 ? [] : listAllDependencies(db);

  return {
    // With the holder's name, which a replica needs before it can point
    // at them at all (EO-367 — see `RecordItemSchema.assigneeName`).
    // …and with what made it, where a module did (EO-433).
    // …and with what it waits for and what waits for it (EO-434), which
    // is what a desktop's board and item page read.
    items: items.map((item) => ({
      ...asRecordItem(item, item.assigneeId === null ? null : (getPerson(db, item.assigneeId as Uuid)?.name ?? null)),
      origin: originForWire(db, item.id as Uuid),
      waits: waitsForWire(edges, item.id),
    })),
    transitions: transitions.map((move) => ({
      id: move.id,
      itemId: move.itemId,
      fromStepId: move.fromStepId,
      toStepId: move.toStepId,
      actor: move.actor,
      reason: move.reason,
      ts: move.ts,
    })),
    comments: comments.map((comment) => asRecordComment(db, comment)),
    pins,
    // Without the row key, which is this record's paging business and
    // means nothing on the other end.
    mentions: settled.map(({ key: _key, ...one }) => one),
    // The files the record has taken, whether or not the comment each
    // hangs off is in this page. A device that pulled a comment in the
    // moment between it and its file would otherwise never learn the
    // file exists — a comment is immutable and is never paged twice.
    attachments: files.map((file) => ({
      id: file.id,
      itemId: file.itemId,
      commentId: file.commentId,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      createdAt: file.createdAt,
    })),
    attachmentRemovals: removals,
    runs: runs.map((run) =>
      // The record's copy is the one everybody else is catching up to,
      // so the command's id names the run and the pull it came from
      // rather than a fresh one each time.
      asRunCommand(run, `${run.id}:pull`, run.updatedAt),
    ),
    // Grouped by run, because `run_events` is keyed on `(runId, seq)`
    // and a flat list would make every reader regroup it. Ordered
    // within a run by the sequence the device wrote, which is the whole
    // promise of invariant #3.
    runEvents: groupEvents(events),
    watches: watches.map(asRecordWatch),
    projects: movedProjects.map((project) => ({
      id: project.id,
      name: project.name,
      keyPrefix: project.keyPrefix,
      ownerId: project.ownerId,
      // The record's own projects are the record's by definition. A
      // replica that took a null here would decide the organisation's
      // project was its own and stop sending anything about it.
      managedAt: project.managedAt ?? project.createdAt,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    })),
    itemTypes: types.map((type) => ({
      id: type.id,
      projectId: type.projectId,
      packSlug: type.packSlug,
      slug: type.slug,
      label: type.label,
      plural: type.plural,
      container: type.container,
      specShape: type.specShape,
      actionOverrides: type.actionOverrides,
      createdAt: type.createdAt,
    })),
    pipelines: graphs,
    agents: projectAgents,
    // Without the row key, which is this record's paging business —
    // the same treatment the settled mentions get one field up.
    publishedSections: publications.map(({ key: _key, ...row }) => row),
    memories: memoryRows,
    skills: projectSkills.map((row) => row.skill),
    cursors: {
      items: endOf(items, cursors.items, (item) => ({ ts: item.updatedAt, id: item.id })),
      transitions: endOf(transitions, cursors.transitions, (move) => ({ ts: move.ts, id: move.id })),
      comments: endOf(comments, cursors.comments, (comment) => ({ ts: comment.createdAt, id: comment.id })),
      pins: endOf(pins, cursors.pins, (pin) => ({ ts: pin.ts, id: pin.commentId })),
      mentions: endOf(settled, cursors.mentions, (one) => ({ ts: one.ts, id: one.key })),
      runs: endOf(runs, cursors.runs, (run) => ({ ts: run.updatedAt, id: run.id })),
      watches: endOf(watches, cursors.watches, (watch) => ({ ts: watch.updatedAt, id: watch.id })),
      runEvents: endOf(events, cursors.runEvents, (event) => ({ ts: event.position, runId: event.runId, seq: event.seq })),
      attachments: endOf(files, cursors.attachments, (file) => ({ ts: file.createdAt, id: file.id })),
      attachmentRemovals: endOf(removals, cursors.attachmentRemovals, (removal) => ({ ts: removal.ts, id: removal.attachmentId })),
      projects: endOf(movedProjects, cursors.projects, (project) => ({ ts: project.updatedAt, id: project.id })),
      itemTypes: endOf(types, cursors.itemTypes, (type) => ({ ts: type.createdAt, id: type.id })),
      pipelines: endOf(graphs, cursors.pipelines, (pipeline) => ({ ts: pipeline.updatedAt, id: pipeline.id })),
      agents: endOf(projectAgents, cursors.agents, (agent) => ({ ts: agent.updatedAt, id: agent.id })),
      publishedSections: endOf(publications, cursors.publishedSections, (row) => ({ ts: row.publishedAt, id: row.key })),
      memories: endOf(memoryRows, cursors.memories, (entry) => ({ ts: entry.updatedAt, id: entry.id })),
      skills: endOf(projectSkills, cursors.skills, (row) => ({ ts: row.changedAt, id: row.skill.id })),
    },
    // A page that came back full is a page that may have been cut. The
    // device loops on this rather than assuming one page is the world,
    // which is the case a desktop that has been shut for a week is in.
    more:
      items.length === limit ||
      transitions.length === limit ||
      comments.length === limit ||
      pins.length === limit ||
      settled.length === limit ||
      runs.length === limit ||
      watches.length === limit ||
      events.length === limit ||
      files.length === limit ||
      removals.length === limit ||
      movedProjects.length === limit ||
      types.length === limit ||
      graphs.length === limit ||
      projectAgents.length === limit ||
      publications.length === limit ||
      memoryRows.length === limit ||
      projectSkills.length === limit,
  };
}

/**
 * The events, gathered under the runs they belong to.
 *
 * The wire carries them grouped because `run_events` is keyed on
 * `(runId, seq)` and every reader would otherwise regroup them. Order
 * is preserved within a group, which is the whole promise of invariant
 * #3 — the page arrives ordered by time and the grouping is stable, so
 * a run's lines stay in the sequence the device wrote them.
 */
function groupEvents(
  rows: readonly { runId: Uuid; deviceId: string | null; seq: number; ts: number; type: string; payload: unknown }[],
): { runId: string; deviceId: string | null; events: { seq: number; ts: number; type: string; payload: unknown }[] }[] {
  const byRun = new Map<string, { runId: string; deviceId: string | null; events: { seq: number; ts: number; type: string; payload: unknown }[] }>();
  for (const row of rows) {
    const key = `${row.runId}:${row.deviceId ?? ""}`;
    const group = byRun.get(key) ?? { runId: row.runId, deviceId: row.deviceId, events: [] };
    group.events.push({ seq: row.seq, ts: row.ts, type: row.type, payload: row.payload });
    byRun.set(key, group);
  }
  return [...byRun.values()];
}

/**
 * Where a list now stands: its own last row, or the cursor it was given.
 *
 * Never "now". A list that filled its page has more behind it, and a
 * cursor past what was actually sent is rows nobody will ask for again
 * — which is the whole failure mode a keyset cursor exists to avoid.
 */
function endOf<T, C>(rows: readonly T[], given: C, at: (row: T) => C): C {
  const last = rows[rows.length - 1];
  return last === undefined ? given : at(last);
}

/**
 * A run a device reported, written down.
 *
 * `startedAt` and `endedAt` are the device's rather than this machine's
 * clock: a run that took forty minutes on a laptop and reached the
 * record on reconnect would otherwise look instantaneous, and every
 * figure computed from those two columns would be a figure about the
 * sync rather than about the work. `updatedAt` is this machine's,
 * because it is the record's clock every *other* device pages on.
 *
 * Also what makes a run-bound comment or transition possible to apply
 * at all: `comments.run_id` and `transitions.run_id` are foreign keys,
 * and the record has them enforced. See `ensureRun`.
 */
function upsertReportedRun(db: Db, command: RecordRunCommand): void {
  if (getRun(db, command.runId as Uuid) === undefined) {
    createRun(db, {
      id: command.runId as Uuid,
      itemId: command.itemId as Uuid,
      agentId: command.agentId as Uuid | null,
      action: command.action,
      stepId: command.stepId,
      status: command.status as never,
      attempt: command.attempt,
      initiationId: command.initiationId,
      dryRun: command.dryRun,
    });
  }
  updateRun(db, command.runId as Uuid, { ...runPatchFrom(command), updatedAt: Date.now() });
}

/**
 * A file that arrived from a device, written and recorded.
 *
 * The bytes first, the row second, and never the other way round: a row
 * naming a file that is not there is a broken link on every screen that
 * draws the thread, where bytes with no row are a few kilobytes nobody
 * reads. `storeImported` is the same door a tracker's attachment comes
 * in through, so a file from a desktop lands beside every other file
 * this installation holds rather than in a second place with its own
 * lifetime.
 */
async function storeAttachment(
  context: ServeRecordContext,
  command: RecordAttachmentCommand,
): Promise<RecordCommandResult> {
  const ok: RecordCommandResult = { id: command.id, applied: true, superseded: null, problem: null, heldBy: null, holder: null, notPermitted: null };
  const store = context.attachments;
  if (store === undefined) return { id: command.id, applied: false, superseded: null, problem: "No attachment store.", heldBy: null, holder: null, notPermitted: null };
  let stored;
  try {
    stored = await store.storeImported({
      name: command.name,
      mimeType: command.mimeType,
      data: Buffer.from(command.dataBase64, "base64"),
    });
  } catch (error) {
    // Said rather than thrown. A disk that is full or a name this
    // filesystem will not take is a fact about the record's machine,
    // and the device's answer to it is to stop asking and tell the
    // person — not to replay the file for ever.
    return {
      id: command.id,
      applied: false,
      superseded: null,
      problem: `This record could not keep that file: ${String(error)}`,
      heldBy: null,
      holder: null,
      notPermitted: null,
    };
  }
  insertAttachments(context.db, [
    {
      ...stored,
      // The device's id for the file, kept, so that the two sides are
      // talking about one attachment — and so that a replay finds it
      // already here.
      id: command.attachmentId as Uuid,
      itemId: command.itemId as Uuid,
      commentId: command.commentId as Uuid | null,
    },
  ]);
  return ok;
}

/**
 * One file's bytes, to a device that knows it exists and does not hold
 * it (EO-324, ARCHITECTURE.md, "The record").
 *
 * The pull half. A replica learns of a file when the comment carrying
 * its metadata arrives; this is how it gets the file itself, one at a
 * time, because one file can fill a whole request.
 *
 * `found: false` is not an error. The record may hold a row whose bytes
 * never arrived — a device that queued the comment and was updated
 * before it sent the file — and the honest answer to a device asking
 * for it is "there is nothing here", so that it stops asking.
 */
export async function serveAttachment(
  context: ServeRecordContext,
  payload: IpcPayload<"record:attachment">,
): Promise<IpcResponse<"record:attachment">> {
  const missing = { found: false, name: "", mimeType: "", dataBase64: "" };
  const record = getAttachment(context.db, payload.attachmentId as Uuid);
  if (record === undefined || context.attachments === undefined) return missing;
  const bytes = await context.attachments.read(record.path);
  if (bytes === null) return missing;
  return { found: true, name: record.name, mimeType: record.mimeType, dataBase64: bytes.toString("base64") };
}

/**
 * A comment's mention rows, as targets on the wire.
 *
 * The record's copy of `outbound.ts`'s reader, and the same reasoning:
 * a human target needs no id because every installation resolves it to
 * its own one person, and an agent target carries one so that the far
 * side dispatches the agent the person meant.
 */
function mentionsOf(db: Db, commentId: Uuid): RecordCommentCommand["mentions"] {
  const targets: RecordCommentCommand["mentions"] = [];
  for (const mention of listMentionsForComment(db, commentId)) {
    // The person, where the record has one (EO-325). "Whoever is in
    // front of you" was the right answer while every installation had
    // exactly one person; on a record with a list of them it would put
    // Anna's question in Dana's inbox, and on Anna's second desktop it
    // would put it in nobody's.
    // …with the status and the reply that answered it (EO-325,
    // review). Without those a replica rebuilt every mention as open,
    // so an escalation answered a fortnight ago came back waiting in
    // the person's inbox on their second desktop.
    const state = { status: mention.status, addressedBy: mention.addressedBy };
    if (mention.targetType === "human") targets.push({ type: "human", personId: mention.targetId, ...state });
    else if (mention.targetId !== null) targets.push({ type: "agent", agentId: mention.targetId, ...state });
  }
  return targets;
}

/**
 * Who moved it last, as a person's name where the record can give one.
 *
 * "Your move of SUP-31 was superseded by Dana's" needs a name, and
 * `transitions.actor` does not hold one: it says `human`, or which
 * agent. The device that sent the command does hold one — a device
 * belongs to a person (EO-323) — which is why `transitions.device_id`
 * exists at all.
 *
 * Three fallbacks, each honest about what it knows. The agent's own
 * name where an agent moved it, because that is the truest answer
 * available. The device's name where the person behind it cannot be
 * resolved, because "anna-macbook's" is still a fact. And
 * `SOMEONE_ELSE` where the record knows nothing, which is better than a
 * confident wrong name in a sentence whose whole job is to tell a
 * person who to go and talk to.
 */
function whoMovedIt(db: Db, itemId: Uuid): string {
  const latest = lastMover(db, itemId);
  if (latest === null) return SOMEONE_ELSE;
  if (latest.actor !== "human") {
    const agent = getAgent(db, latest.actor as Uuid);
    if (agent !== undefined) return agent.name;
  }
  if (latest.deviceId === null) return SOMEONE_ELSE;
  const device = getDevice(db, latest.deviceId);
  if (device === undefined) return SOMEONE_ELSE;
  return device.personName || device.name || SOMEONE_ELSE;
}

/**
 * The person a device belongs to, as the record knows them (EO-367).
 *
 * `identity/acting.ts`'s rule, applied to a command rather than a
 * request: the door authenticated the device and stamped its id, a
 * device belongs to a person (EO-323), and that is who is acting.
 * Undefined for a device or a person this record has no row for — which
 * is nobody, and a claim by nobody is refused rather than filed under
 * the record's own "you".
 */
function personOfDevice(db: Db, deviceId: string): Person | undefined {
  const device = getDevice(db, deviceId);
  if (device === undefined) return undefined;
  return getPerson(db, device.personId as Uuid);
}

/** Who holds an item, by id and name, as `RecordCommandResult.holder` carries it. */
function holderOf(db: Db, assigneeId: string | null): { person: { id: string; name: string } | null } {
  if (assigneeId === null) return { person: null };
  return { person: { id: assigneeId, name: getPerson(db, assigneeId as Uuid)?.name || SOMEONE_ELSE } };
}

/** One comment as the pull carries it: who it asks and whether each still waits, its pin, and what hangs off it. */
function asRecordComment(db: Db, comment: Comment): RecordCommentCommand {
  return {
    kind: "comment" as const,
    id: comment.id,
    itemId: comment.itemId,
    commentId: comment.id,
    authorType: comment.authorType,
    authorId: comment.authorId,
    runId: comment.runId,
    parentId: comment.parentId,
    body: comment.body,
    kindOfComment: comment.kind,
    options: comment.options,
    // Who it asks and whether it is pinned, so a replica's thread is
    // the record's thread rather than a paraphrase of it: a mention
    // is what puts a row in somebody's inbox, and a pin is what an
    // agent's context keeps when the rest is truncated.
    mentions: mentionsOf(db, comment.id),
    pinned: comment.pinned,
    // What hangs off it, so a replica knows a file exists before it
    // holds one — and knows to ask for the bytes.
    attachments: listAttachmentsForComment(db, comment.id).map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
    })),
    createdAt: comment.createdAt,
  };
}

export function asRecordItem(item: {
  id: string;
  key: string;
  typeId: string;
  type: string;
  parentId: string | null;
  projectId: string | null;
  workspaceId: string | null;
  title: string;
  body: string | null;
  pipelineId: string | null;
  stepId: string | null;
  priority: number;
  archivedAt: number | null;
  heldAt: number | null;
  previewAt: number | null;
  trialAt: number | null;
  assigneeId: string | null;
  /** Which graph it is being routed by (EO-327, carried by EO-329). */
  pipelineVersionId: string | null;
  createdAt: number;
  updatedAt: number;
}, assigneeName: string | null): RecordItem {
  return {
    id: item.id,
    key: item.key,
    typeId: item.typeId,
    typeSlug: item.type,
    parentId: item.parentId,
    projectId: item.projectId,
    workspaceId: item.workspaceId,
    title: item.title,
    body: item.body,
    pipelineId: item.pipelineId,
    stepId: item.stepId,
    priority: item.priority,
    archivedAt: item.archivedAt,
    heldAt: item.heldAt,
    previewAt: item.previewAt,
    // The trial mark (EO-582), so a replica keeps a trial item hidden.
    trialAt: item.trialAt,
    assigneeId: item.assigneeId,
    assigneeName,
    pipelineVersionId: item.pipelineVersionId,
    // Filled by the caller that has a database to read it from.
    origin: null,
    waits: null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function asWire(lease: DispatchLease): { itemId: string; deviceId: string; grantedAt: number; expiresAt: number } {
  return { itemId: lease.itemId, deviceId: lease.deviceId, grantedAt: lease.grantedAt, expiresAt: lease.expiresAt };
}

function authorOf(
  type: string,
  id: string | null,
): { type: "human" } | { type: "agent"; agentId: Uuid } | { type: "engine" } | { type: "module" } {
  if (type === "agent" && id !== null) return { type: "agent", agentId: id as Uuid };
  if (type === "human" || type === "engine" || type === "module") return { type };
  return { type: "engine" };
}
