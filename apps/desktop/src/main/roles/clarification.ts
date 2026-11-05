import { ClarifyOutputSchema, type Item, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { postComment } from "../db/repos/index.js";

/**
 * What a clarify run leaves behind (KAN-19).
 *
 * The counterpart to `postRefineProposal`, and deliberately much less:
 * refining a feature produces a plan for a human to argue with, while
 * clarifying something already written produces only the fact that there
 * was nothing to argue about. So this is a `note` and mentions nobody —
 * the item walks on to be implemented, and interrupting someone to
 * tell them their own story was clear is not news.
 *
 * A product owner that *did* have something to ask never reaches here:
 * it asked with the `comment` tool and a blocking mention, which ends
 * the run through A-03 and parks the item without any result at all.
 */
export function postClarificationNote(db: Db, item: Item, agentId: Uuid, runId: Uuid, parsedResult: unknown): void {
  const parsed = ClarifyOutputSchema.safeParse(parsedResult);
  if (!parsed.success) return; // A-02 already validated this; nothing to post if it somehow didn't

  postComment(db, {
    itemId: item.id,
    runId,
    author: { type: "agent", agentId },
    kind: "note",
    // The understanding, not a verdict: the implementer reads this
    // thread, and one paragraph of what the work is read to be is worth
    // more to it than the word "ready".
    body: `Ready to implement, as written.\n\n${parsed.data.understanding}`,
  });
}
