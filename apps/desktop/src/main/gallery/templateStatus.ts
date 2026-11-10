import { TEMPLATE_UPDATE_RECENT_MS, NO_TEMPLATE_STATUS, type PipelineTemplateStatus, type PipelineTemplateUpdated, type PipelineTemplateWaiting, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getAppliedTemplateUpdate, getComment, getItem, getPipelineOrigin, openUpdateConflict, type PipelineOrigin } from "../db/repos/index.js";
import { ASSIST_STEP } from "../roles/conversationSteps.js";
import type { TemplateHistory } from "./history.js";
import { UPDATE_CONFLICT_ON_THE_RECORD, updateHeldElsewhere, type ConflictPlace } from "./updateConflictDetail.js";

/**
 * Where a pipeline came from, and whether its template has news for it
 * (EO-536) — what `pipeline:templateStatus` answers, on whichever
 * installation holds the pipeline's updates.
 *
 * Read, never written: the origin as `getPipelineOrigin` reads it, the
 * pipeline's own record of the update EO last applied, and its open update
 * conflict for one EO held. The applied update is the one fact kept for
 * the head's sake (`pipelines.template_applied`), written when the
 * update is applied, because the version it filed can be pruned.
 */

export interface TemplateStatusPlace extends ConflictPlace {
  now?: number;
}

export function describeTemplateStatus(db: Db, pipelineId: string, history: TemplateHistory, place: TemplateStatusPlace = {}): PipelineTemplateStatus {
  // Not this database's to answer: a replica's origin is the one the
  // pipeline had before it moved, and nobody who could say was asked.
  if (updateHeldElsewhere(db, pipelineId, place)) return { ...NO_TEMPLATE_STATUS, problem: UPDATE_CONFLICT_ON_THE_RECORD };

  const origin = getPipelineOrigin(db, pipelineId);
  // A pipeline made from no template says nothing at all.
  if (origin === null) return NO_TEMPLATE_STATUS;

  const now = place.now ?? Date.now();
  return {
    origin: { slug: origin.slug, title: titleOf(origin, history), version: origin.version },
    updated: recentUpdate(db, origin, history, now),
    waiting: heldUpdate(db, pipelineId),
    problem: null,
  };
}

/** The template's title as the base's version calls it: the shipped history's, else the stored base's, else its slug. */
function titleOf(origin: PipelineOrigin, history: TemplateHistory): string {
  const shipped = history.get(origin.slug)?.find((version) => version.version === origin.version);
  return shipped?.document.template.title ?? origin.base.template?.title ?? origin.slug;
}

/**
 * The update EO applied to this pipeline, while it is recent: the one
 * recorded on the pipeline when it was applied, where it took the
 * version the base is now. A base moved since by anything else — a held
 * update resolved, a newer one applied — is that later news, not this.
 *
 * Read from the pipeline's own record of it, never from the version the
 * update filed: the next save may prune that version, and the head must
 * not stop saying so the moment somebody edits a step.
 */
function recentUpdate(db: Db, origin: PipelineOrigin, history: TemplateHistory, now: number): PipelineTemplateUpdated | null {
  const applied = getAppliedTemplateUpdate(db, origin.pipelineId);
  if (applied === null || applied.version !== origin.version) return null;
  if (now - applied.at > TEMPLATE_UPDATE_RECENT_MS) return null;
  const notes = history.get(origin.slug)?.find((shipped) => shipped.version === applied.version)?.notes ?? "";
  return { version: applied.version, pipelineVersion: applied.pipelineVersion, at: applied.at, notes };
}

/**
 * This pipeline's held update, with where pressing it goes: the chat Fix
 * with assistant opened, while that chat still exists — a person may
 * remove it, and the next press then starts another — or the notice
 * that offers the button, where nobody has pressed it yet and it is a
 * comment on a project thread. A notice sent as a message (EO-727) is on
 * no item, so the head opens the chat its button would.
 */
function heldUpdate(db: Db, pipelineId: string): PipelineTemplateWaiting | null {
  const conflict = openUpdateConflict(db, pipelineId);
  if (conflict === undefined) return null;

  const chat = conflict.chatId === null ? undefined : getItem(db, conflict.chatId as Uuid);
  const noticeId = conflict.noticeIds.find((id) => getComment(db, id as Uuid) !== undefined);
  const notice = noticeId === undefined ? undefined : getComment(db, noticeId as Uuid);
  return {
    conflictId: conflict.id,
    fromVersion: conflict.fromVersion,
    toVersion: conflict.toVersion,
    conflicts: conflict.conflicts.length,
    problems: conflict.problems.length,
    chatId: chat !== undefined && chat.stepId === ASSIST_STEP ? chat.id : null,
    notice: notice === undefined ? null : { itemId: notice.itemId, commentId: notice.id },
  };
}
