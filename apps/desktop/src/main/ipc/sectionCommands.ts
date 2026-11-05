import {
  publishConfirmation,
  SECTION_LOCK_TEXT,
  type IpcPayload,
  type IpcResponse,
  type PublishedSection,
  type PublishedSectionView,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { actingCaller } from "../identity/acting.js";
import { lockedSections } from "../managed/locks.js";
import { sectionDocument } from "../managed/configuration.js";
import { isReplica } from "../db/recordRole.js";
import { listDevices } from "../db/repos/devicesRepo.js";
import { touchProjectAgents } from "../db/repos/agentsRepo.js";
import {
  currentVersion,
  ensureCurrentVersion,
  itemsOnOlderVersions,
  itemsOnVersion,
  listPipelines,
  listPublishedSections,
  pipelineVersionByNumber,
  publishSection,
  replacePipelineGraph,
  versionSnapshot,
  type PipelineVersionRow,
} from "../db/repos/index.js";

/**
 * Publishing a section, rolling one back, and saying what either would
 * cost (EO-329, `ARCHITECTURE.md`, "Publish, lock and versions").
 *
 * The admin's half of the lock. The device's half is `managed/locks.ts`
 * and is a refusal rather than a screen; nothing in this file is ever
 * reached on a desktop, because both writes are `ADMIN_ONLY_CHANNELS`
 * and a desktop's own `sections:list` answers out of rows the sync
 * delivered.
 *
 * ## What a publish is
 *
 * One row per `(section, subject)`: the pipelines section writes one per
 * pipeline, naming the version each is on, and the other four write one
 * apiece because they have no versions of their own yet. The *lock* is
 * per section regardless (ARCHITECTURE.md, "Publish, lock and versions") — no reader of it looks at
 * a subject.
 *
 * ## What a rollback is
 *
 * "Rollback is publishing an older version again." So it is the same
 * call with a version number on it: the pipeline's live graph is
 * written back from that version's own frozen document, the pipeline is
 * pointed at it, and the section is published again. The version named
 * is never rewritten (EO-327), and items already mid-flight keep the
 * version they entered on and finish there — a rollback moves nothing.
 */

/** Live pipelines on this record, which is what "the pipelines section" means. */
function publishablePipelines(db: Db): { id: string; name: string }[] {
  return listPipelines(db).map((pipeline) => ({ id: pipeline.id as string, name: pipeline.name }));
}

/**
 * How much work would keep finishing on an older graph, and across how
 * many machines.
 *
 * The items are the record's rows — everything alive on this pipeline
 * that is bound to a version other than the one it is about to be on.
 * The desktops are the record's device list, because that is the honest
 * answer to "across how many": a lease is transient and an item between
 * runs has none, so counting leases would report "3 items across 0
 * desktops" for work that is very much in flight. What the sentence is
 * telling an admin is that this publish reaches N machines and does not
 * take back the work already running on them.
 */
function inFlight(db: Db, pipelineIds: readonly string[]): { items: number; devices: number; finishOn: number | null } {
  let items = 0;
  let finishOn: number | null = null;
  for (const pipelineId of pipelineIds) {
    for (const older of itemsOnOlderVersions(db, pipelineId)) {
      items += older.items;
      finishOn = finishOn === null ? older.number : Math.max(finishOn, older.number);
    }
    // The version everything standing on the pipeline right now will
    // keep: a publish makes the current version the old one, and
    // `itemsOnOlderVersions` cannot see that yet because it has not
    // happened.
    const current = currentVersion(db, pipelineId);
    if (current !== undefined) {
      // The version everything standing here keeps, counted before the
      // publish that makes it an older one — which is why it is asked
      // of `itemsOnVersion` rather than of `itemsOnOlderVersions`.
      const onCurrent = itemsOnVersion(db, pipelineId, current.id as string);
      if (onCurrent > 0) {
        items += onCurrent;
        finishOn = finishOn === null ? current.number : Math.max(finishOn, current.number);
      }
    }
  }
  return { items, devices: listDevices(db).filter((device) => device.revokedAt === null).length, finishOn };
}

/**
 * A desktop is not the record, and publishing from one would be a
 * machine locking itself.
 *
 * Refused rather than allowed-and-ignored. `ADMIN_ONLY_CHANNELS` is
 * enforced at a server's door and nowhere else — the person at a
 * desktop owns that machine — so without this the two writes are
 * reachable locally on a signed-in laptop, where they would write rows
 * nobody downstream has, lock the person out of their own editor, and
 * be overwritten by the record's own on the next pull.
 */
/** Where policy is published from, said where somebody asked for it here (EO-328, ARCHITECTURE.md, "Policy"). */
export const POLICY_IS_PUBLISHED_ELSEWHERE =
  "Policy is published from Settings \u2192 Policy, which is where the allowed backends, the per-person budget, the MCP servers your organisation publishes and its secrets are set together.";

const NOT_THE_RECORD =
  "This machine is a desktop, not your organisation's record. Publishing and rolling back are done on the server, by an administrator.";

/** What this installation has published, and what that locks *here*. */
export function listSectionsCommand(db: Db): IpcResponse<"sections:list"> {
  return { published: listPublishedSections(db), locked: lockedSections(db), lockText: SECTION_LOCK_TEXT };
}

/** The confirmation, with nothing written — "3 items in flight across 2 desktops finish on v6". */
export function publishPreflightCommand(db: Db, payload: IpcPayload<"sections:publishPreflight">): IpcResponse<"sections:publishPreflight"> {
  if (isReplica(db)) return { confirmation: "", items: 0, devices: 0, finishOn: null, problem: NOT_THE_RECORD };
  if (payload.section === "policy") {
    return { confirmation: "", items: 0, devices: 0, finishOn: null, problem: POLICY_IS_PUBLISHED_ELSEWHERE };
  }
  const target = resolveTarget(db, payload.section, payload.pipelineId, payload.versionNumber);
  if (target.problem !== null) {
    return { confirmation: "", items: 0, devices: 0, finishOn: null, problem: target.problem };
  }
  const counted = inFlight(db, target.pipelineIds);
  return { ...counted, confirmation: publishConfirmation(counted), problem: null };
}

/**
 * Publishes the section — and rolls it back, where a version is named.
 *
 * The write order is the one that survives a crash between its halves:
 * the graph first, then the row that says it is published. A row
 * pointing at a version the graph was never restored to would lock a
 * desktop out of a pipeline that is not the one it was told about; the
 * other way round costs one more press of Publish.
 */
export function publishSectionCommand(db: Db, payload: IpcPayload<"sections:publish">): IpcResponse<"sections:publish"> {
  if (isReplica(db)) return { published: [], confirmation: "", problem: NOT_THE_RECORD };
  const caller = actingCaller(db, payload.actingDeviceId);
  const target = resolveTarget(db, payload.section, payload.pipelineId, payload.versionNumber);
  if (target.problem !== null) return { published: [], confirmation: "", problem: target.problem };

  // Before anything is written, so a refusal leaves the record exactly
  // as it was — and so the sentence an admin is shown afterwards is the
  // one they were shown before they pressed.
  const counted = inFlight(db, target.pipelineIds);
  const at = Date.now();
  const by = { publishedBy: caller.person?.id ?? null, publishedByName: caller.person?.name ?? null };

  // Policy is published from the Policy screen (EO-328), which does the
  // whole of the design with its own refusals — see
  // `SECTION_LOCKED_CHANNELS.policy`. Refused here rather than writing
  // a row: a publication that locked nothing and carried nothing would
  // be a second Publish button for a section that already has one, and
  // the two would disagree about what had been published.
  if (payload.section === "policy") {
    return { published: [], confirmation: "", problem: POLICY_IS_PUBLISHED_ELSEWHERE };
  }

  if (payload.section !== "pipelines") {
    // Four sections with no versions of their own, so what they publish
    // is the section as it stands, frozen into the row (EO-329, review).
    // The lock alone would have been a lock over each machine's own
    // stale copy — the design says Publish *pushes a version*, and this is it.
    const row = db.transaction(() => {
      const written = publishSection(db, { section: payload.section, publishedAt: at, document: sectionDocument(db, payload.section), ...by });
      // The projects' own agents are not in the document — they travel
      // with their project (EO-476) — so publishing agents re-offers them
      // on the sync instead: a replica that kept its own copy while the
      // section was unpublished has to take the record's now.
      if (payload.section === "agents") touchProjectAgents(db, at);
      return written;
    });
    return { published: [row], confirmation: publishConfirmation(counted), problem: null };
  }

  // The graph and its versions travel with the pipeline; the modules its
  // `module` steps run travel here, because nothing else carries them.
  const modules = sectionDocument(db, "pipelines");

  const published: PublishedSectionView[] = [];
  for (const pipelineId of target.pipelineIds) {
    const rolledBack = target.versionByPipeline.get(pipelineId);
    if (rolledBack !== undefined) {
      const restored = restoreVersion(db, pipelineId, rolledBack);
      if (restored !== null) return { published: [], confirmation: "", problem: restored };
    }
    // `ensureCurrentVersion` rather than `currentVersion`: a pipeline a
    // pack wrote step by step has a graph and no document of it, and
    // publishing "whatever this is" without one would leave the row
    // naming no version at all.
    const version = ensureCurrentVersion(db, pipelineId);
    published.push(
      publishSection(db, {
        section: "pipelines",
        subjectId: pipelineId,
        versionId: version?.id ?? null,
        versionNumber: version?.number ?? null,
        publishedAt: at,
        document: modules,
        ...by,
      }),
    );
  }

  return { published, confirmation: publishConfirmation(counted), problem: null };
}

/**
 * Writes one pipeline's graph back to an older version of itself.
 *
 * Answers with the refusal where there is one, and null where it
 * worked. Exported since EO-331, because discarding a diverged copy is
 * the same act on the same graph: "Discard my edits" takes the
 * published version back, which is what a rollback does to a version
 * that is merely older. The refusal that matters is the strand: a version that has no
 * step for work standing on one it drops is refused with the count, by
 * the same guard a save meets, and nothing is written.
 */
export function restoreVersion(db: Db, pipelineId: string, version: PipelineVersionRow): string | null {
  const snapshot = versionSnapshot(db, version.id as string);
  if (snapshot === undefined) return `EO cannot read the document v${String(version.number)} froze, so there is nothing to roll back to.`;

  const written = replacePipelineGraph(
    db,
    pipelineId,
    snapshot.steps.map((step) => ({
      id: step.id,
      pipelineId: pipelineId as Uuid,
      position: step.position,
      name: step.name,
      type: step.type,
      ownerRole: step.ownerRole,
      entryAction: step.entryAction,
      instructionsSummary: step.instructionsSummary,
      isTerminal: step.isTerminal,
      planMode: step.planMode,
      offBoard: step.offBoard,
      workspaceMode: step.workspaceMode,
      inputs: step.inputs,
      timeoutMs: step.timeoutMs,
      results: step.results,
      // Not `workspaceId`, and not who waits at a human step. Both are
      // facts about a machine and a team rather than about the graph —
      // `replacePipelineGraph` leaves a field alone when nobody speaks
      // for it, and a rollback has nothing to say about either.
    })),
    snapshot.routes.map((route) => ({
      pipelineId: pipelineId as Uuid,
      fromStepId: route.fromStepId,
      resultKey: route.resultKey,
      label: route.label,
      tone: route.tone,
      target: route.target,
      position: route.position,
    })),
    { entryStepId: snapshot.entryStepId, entryRules: snapshot.entryRules, republishVersionId: version.id as string },
  );

  if (written.replaced) return null;
  const holding = written.holding.map((step) => `${step.stepName} (${String(step.count)})`).join(", ");
  return (
    `Rolling back to v${String(version.number)} would remove a step work is standing on: ${holding}. ` +
    `Move that work first — it goes through the ordinary transition path and each item is told why.`
  );
}

interface PublishTarget {
  pipelineIds: string[];
  /** The version each named pipeline goes back to. Empty for a publish that is not a rollback. */
  versionByPipeline: Map<string, PipelineVersionRow>;
  problem: string | null;
}

/**
 * Which pipelines this publish covers, and which version each goes to.
 *
 * A publish of the pipelines section covers every live pipeline; a
 * rollback names one and a version of it. A version number for a
 * section that has none is refused rather than ignored, because a
 * person who typed one meant something by it.
 */
function resolveTarget(db: Db, section: PublishedSection, pipelineId: string | null, versionNumber: number | null): PublishTarget {
  const none = (problem: string): PublishTarget => ({ pipelineIds: [], versionByPipeline: new Map(), problem });

  if (section !== "pipelines") {
    if (pipelineId !== null || versionNumber !== null) {
      return none(`The ${section} section has no versions to roll back to. Publish it without naming one.`);
    }
    return { pipelineIds: [], versionByPipeline: new Map(), problem: null };
  }

  const live = publishablePipelines(db);
  if (pipelineId === null) {
    if (versionNumber !== null) return none("Rolling back to a version means naming the pipeline it belongs to.");
    return { pipelineIds: live.map((pipeline) => pipeline.id), versionByPipeline: new Map(), problem: null };
  }

  if (!live.some((pipeline) => pipeline.id === pipelineId)) return none("EO has no live pipeline with that id.");
  if (versionNumber === null) return { pipelineIds: [pipelineId], versionByPipeline: new Map(), problem: null };

  const version = pipelineVersionByNumber(db, pipelineId, versionNumber);
  if (version === undefined) return none(`That pipeline has no v${String(versionNumber)}.`);
  return { pipelineIds: [pipelineId], versionByPipeline: new Map([[pipelineId, version]]), problem: null };
}
