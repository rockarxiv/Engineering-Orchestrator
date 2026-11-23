import { and, asc, eq } from "drizzle-orm";
import { SUGGESTED_REPLY_EVENT, uuidv7, type SuggestedReplyAction, type SuggestedReplyDismissal, type SuggestionOutcome, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { runEvents, suggestedReplyUses } from "../schema.js";
import { listRunSideCalls, type SideCallRow } from "./sideCallsRepo.js";

/**
 * What the person did with a suggested reply shown in an assistant chat's
 * composer (EO-895, migration 0182), by the run the suggestion follows.
 *
 * **Append-only.** There is deliberately no update and no delete here;
 * `db/architecturalInvariants.test.ts` holds the tree to it. A row goes
 * only with its run, by the schema's cascade.
 */
export interface SuggestedReplyUseRow {
  id: Uuid;
  runId: Uuid;
  action: SuggestedReplyAction;
  /** On `sent`: whether the accepted text was changed before it was sent. */
  edited: boolean | null;
  /** On `dismissed`: what dismissed it. */
  dismissedBy: SuggestedReplyDismissal | null;
  createdAt: number;
}

export type SuggestedReplyUseInput =
  | { runId: Uuid; action: "shown" | "accepted" }
  | { runId: Uuid; action: "sent"; edited: boolean }
  | { runId: Uuid; action: "dismissed"; by: SuggestedReplyDismissal };

/**
 * What must already be recorded of a suggestion for an action to be,
 * and what must not. Accepting and dismissing exclude each other: a
 * suggestion taken into the box was not dismissed, and one dismissed can
 * no longer be taken.
 */
const ORDER: Readonly<Record<SuggestedReplyAction, { after: SuggestedReplyAction | null; never: readonly SuggestedReplyAction[] }>> = {
  shown: { after: null, never: [] },
  accepted: { after: "shown", never: ["dismissed"] },
  sent: { after: "accepted", never: [] },
  dismissed: { after: "shown", never: ["accepted"] },
};

/**
 * Records one action, once per suggestion and in order. Answers whether
 * it was recorded: false for an action already recorded, one before what
 * it follows (`accepted` before `shown`, `sent` before `accepted`), or
 * one the suggestion's other actions rule out.
 */
export function recordSuggestedReplyUse(db: Db, input: SuggestedReplyUseInput, at: number = Date.now()): boolean {
  return db.transaction((tx) => {
    const done = new Set(
      tx
        .select({ action: suggestedReplyUses.action })
        .from(suggestedReplyUses)
        .where(eq(suggestedReplyUses.runId, input.runId))
        .all()
        .map((row) => row.action),
    );
    const rule = ORDER[input.action];
    if (done.has(input.action) || (rule.after !== null && !done.has(rule.after)) || rule.never.some((action) => done.has(action))) return false;
    const result = tx
      .insert(suggestedReplyUses)
      .values({
        id: uuidv7(),
        runId: input.runId,
        action: input.action,
        edited: input.action === "sent" ? input.edited : null,
        dismissedBy: input.action === "dismissed" ? input.by : null,
        createdAt: at,
      })
      .onConflictDoNothing({ target: [suggestedReplyUses.runId, suggestedReplyUses.action] })
      .run();
    return result.changes > 0;
  });
}

/** What was recorded of one suggestion, in the order it happened. */
export function listSuggestedReplyUses(db: Db, runId: Uuid): SuggestedReplyUseRow[] {
  return db
    .select()
    .from(suggestedReplyUses)
    .where(eq(suggestedReplyUses.runId, runId))
    .orderBy(asc(suggestedReplyUses.createdAt), asc(suggestedReplyUses.id))
    .all()
    .map((row) => ({
      id: row.id as Uuid,
      runId: row.runId as Uuid,
      action: row.action as SuggestedReplyAction,
      edited: row.edited,
      dismissedBy: row.dismissedBy as SuggestedReplyDismissal | null,
      createdAt: row.createdAt,
    }));
}

/**
 * Everything EO recorded of the suggested reply after one run, read
 * together: what making it spent (EO-808's `prompt_suggestion` side
 * calls), what became of it (EO-810's `suggested_reply` run events) and
 * what the person did with it once shown (EO-895). Claude's backend makes
 * its suggestion inside its own CLI and reports neither of the first two,
 * so for a Claude chat they are empty and the uses stand alone.
 */
export interface SuggestedReplyRecord {
  runId: Uuid;
  spend: SideCallRow[];
  outcomes: SuggestionOutcome[];
  uses: SuggestedReplyUseRow[];
}

export function readSuggestedReplyRecord(db: Db, runId: Uuid): SuggestedReplyRecord {
  return {
    runId,
    spend: listRunSideCalls(db, runId, "prompt_suggestion"),
    outcomes: db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, SUGGESTED_REPLY_EVENT)))
      .orderBy(asc(runEvents.seq))
      .all()
      .map((row) => row.payload as SuggestionOutcome),
    uses: listSuggestedReplyUses(db, runId),
  };
}
