import { ImplementOutputSchema, type Item, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { postComment } from "../db/repos/index.js";

/**
 * The implementer's account of its own work, put into the thread
 * (KAN-31).
 *
 * Every other role already leaves one: refine posts its proposal,
 * review posts its feedback, clarify posts what it understood. The
 * implementer posted nothing at all, so a story went from "someone
 * wrote code" to "someone reviewed it" with no word from the person who
 * wrote it.
 *
 * That is worst on the path a rejection takes. The story comes back with
 * the reviewer's complaint in the thread and no record of what the
 * previous attempt was thinking, so the next attempt re-derives it — or
 * repeats it.
 *
 * A `note` and nobody mentioned: this is something to read, not
 * something to answer, and interrupting a person to tell them work
 * happened is how an inbox stops being worth opening.
 */
export function postImplementHandoff(db: Db, item: Item, agentId: Uuid, runId: Uuid, parsedResult: unknown): void {
  const parsed = ImplementOutputSchema.safeParse(parsedResult);
  if (!parsed.success) return; // A-02 already validated this; nothing to post if it somehow didn't

  postComment(db, {
    itemId: item.id,
    runId,
    author: { type: "agent", agentId },
    kind: "note",
    body: parsed.data.handoff,
  });
}
