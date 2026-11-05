import type { Comment, Item, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { postComment } from "../db/repos/commentsRepo.js";
import { getPipeline } from "../db/repos/pipelineStepsRepo.js";
import {
  bindItemToVersion,
  ensureCurrentVersion,
  getPipelineVersion,
  listPipelineVersions,
  stepForItem,
  stepsOfVersion,
  type PipelineVersionRow,
} from "../db/repos/pipelineVersionsRepo.js";

/**
 * Moving an item to another version of its own pipeline (EO-567,
 * ARCHITECTURE.md, "Publish, lock and versions").
 *
 * An item finishes on the version it entered on. `items:move` never
 * changes that and refuses a step the item's version lacks, on purpose —
 * a drag is not somebody deciding the work should start again under
 * other rules. This is the request that *is* that decision, made
 * explicitly: `item_move_to_version` names the version.
 *
 * Two halves, and both are here so the desktop and the organisation's
 * record cannot come to judge or describe the same move differently:
 *
 *  - **`planVersionMove`** says whether the move can be made and, if
 *    not, why, in a sentence. It reads and never writes beyond filing a
 *    pipeline's first version the way every version question does.
 *  - **`writeVersionMove`** makes it: the binding and the one comment
 *    saying so, together.
 *
 * Whether an agent is working on the item is the caller's to ask,
 * because the two places know it differently — a desktop by its item
 * lock and its runs, the record by its leases and its runs.
 */

/** A move that can be made, with what its comment needs. */
export interface VersionMove {
  ok: true;
  pipelineName: string;
  stepName: string;
  from: number;
  to: PipelineVersionRow;
}

export type VersionMovePlan = VersionMove | { ok: false; problem: string; from: number | null };

/**
 * Whether this item can be bound to version `number` of its pipeline.
 *
 * In the order a person would want to be told: whether there is a
 * pipeline to have versions at all, whether the number is one it keeps,
 * whether the item is already there, and only then whether the step it
 * stands on exists in that version — the one refusal whose way forward
 * is a different tool.
 */
export function planVersionMove(db: Db, item: Item, number: number): VersionMovePlan {
  if (item.archivedAt !== null) {
    return { ok: false, from: null, problem: `${item.key} is archived, so there is no version for it to move to. Bring it back first.` };
  }
  if (item.pipelineId === null || item.stepId === null) {
    return { ok: false, from: null, problem: `${item.key} is on no pipeline, so there is no version of one to move it to.` };
  }
  const pipelineId = item.pipelineId;
  const pipelineName = getPipeline(db, pipelineId)?.name ?? pipelineId;

  // The version the item is on. Null is "entered before the pipeline had
  // any", which routes by the live graph and so is the current version —
  // filed here if it has never been, as every version question files it.
  const current = ensureCurrentVersion(db, pipelineId);
  const bound = item.pipelineVersionId === null ? undefined : getPipelineVersion(db, item.pipelineVersionId);
  const fromVersion = bound ?? current;
  const from = fromVersion?.number ?? null;

  const kept = listPipelineVersions(db, pipelineId);
  const to = kept.find((version) => version.number === number);
  if (to === undefined) {
    return {
      ok: false,
      from,
      problem:
        kept.length === 0
          ? `"${pipelineName}" keeps no versions, so there is no version ${number} to move ${item.key} to.`
          : `"${pipelineName}" keeps ${kept.length === 1 ? "only version" : "versions"} ${numberList(kept.map((version) => version.number))}, so there is no version ${number} to move ${item.key} to.`,
    };
  }

  if (fromVersion !== undefined && fromVersion.id === to.id) {
    return { ok: false, from, problem: `${item.key} is already on version ${number} of "${pipelineName}".` };
  }

  const stepName = stepForItem(db, item)?.name ?? item.stepId;
  if (!stepsOfVersion(db, pipelineId, to.id).some((step) => step.id === item.stepId)) {
    return {
      ok: false,
      from,
      problem:
        `Version ${number} of "${pipelineName}" has no step "${stepName}", which is where ${item.key} is, so it could not ` +
        `be routed or dispatched there. Move it with item_move to a step both version ${from ?? number} and version ${number} ` +
        `have, then move it to version ${number}.`,
    };
  }

  return { ok: true, pipelineName, stepName, from: from ?? number, to };
}

export interface WriteVersionMoveInput {
  item: Item;
  move: VersionMove;
  /** Who asked, as the sentence names them — "Anna", or "you" on a desktop. */
  by: string;
  /** The asker's own words, included in the comment. Empty adds nothing. */
  note: string;
  /** The comment's id, minted by the device that asked, so a replay on the record is "already done". */
  commentId?: Uuid;
}

/**
 * The move, made: the binding, and the one comment that says so.
 *
 * Together, so that a binding never changes without the thread saying
 * it did (invariant #8) and a comment never says something that did not
 * happen. Nothing else is written — no transition, because the item has
 * not moved, and no existing row of any kind is touched.
 */
export function writeVersionMove(db: Db, input: WriteVersionMoveInput): Comment {
  const { item, move } = input;
  return db.transaction((tx) => {
    const writer = tx as unknown as Db;
    bindItemToVersion(writer, item.id, move.to.id);
    return postComment(writer, {
      ...(input.commentId === undefined ? {} : { id: input.commentId }),
      itemId: item.id,
      author: { type: "engine" },
      body: versionMoveLine(move, input.by, input.note),
      parseBodyMentions: false,
    });
  });
}

/** "Moved from version 2 to version 3 of "Delivery" by Anna." and what follows it. */
export function versionMoveLine(move: VersionMove, by: string, note: string): string {
  const said =
    `Moved from version ${move.from} to version ${move.to.number} of "${move.pipelineName}" by ${by}. ` +
    `It stays on "${move.stepName}"; from here it is routed and dispatched by version ${move.to.number}.`;
  const words = note.trim();
  return words === "" ? said : `${said}\n\n${words}`;
}

/** "1", "1 and 2", "1, 2 and 3". */
function numberList(numbers: readonly number[]): string {
  if (numbers.length <= 1) return numbers.join("");
  return `${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
}
