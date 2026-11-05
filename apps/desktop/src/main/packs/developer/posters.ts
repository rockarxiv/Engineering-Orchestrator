import { CLARIFICATION_NOTE_POSTER, REFINE_PROPOSAL_POSTER } from "@eo/core";
import type { Db } from "../../db/client.js";
import { postClarificationNote } from "../../roles/clarification.js";
import { postRefineProposal } from "../../roles/proposal.js";
import type { CommentPoster } from "../pack.js";

/**
 * What each name an action override may use actually posts (KAN-163,
 * ARCHITECTURE.md, "An item type is data").
 *
 * An override is a row's worth of data — a schema, a result key and a
 * *poster* — and the third of those has to cross into the database,
 * which registry data may not do. So the pack keeps the table from name
 * to function, exactly as it keeps one from a builtin's action to the
 * runner behind it, and the fold refuses at startup an override naming
 * one nothing registers (`foldPacks`).
 *
 * The two entries are the two halves of what `refine` has always meant:
 * a plan of the work under a container, for a person to approve, and a
 * note that work which arrived already written can be implemented as it
 * stands. Which of them an item gets is its type's answer rather than
 * this file's — the branch that asked whether the item was a container
 * is what this table replaced.
 *
 * A function of the database rather than a constant, because posting is
 * a write and the pack closes over its handle the way its builtins do.
 */
export function createPosters(db: Db): Record<string, CommentPoster> {
  return {
    [REFINE_PROPOSAL_POSTER]: (item, agentId, runId, parsedResult) => postRefineProposal(db, item, agentId, runId, parsedResult),
    [CLARIFICATION_NOTE_POSTER]: (item, agentId, runId, parsedResult) => postClarificationNote(db, item, agentId, runId, parsedResult),
  };
}
