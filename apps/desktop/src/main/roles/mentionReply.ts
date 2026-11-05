import { RespondOutputSchema, type Item, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { postComment } from "../db/repos/index.js";

/**
 * What an agent says back when a comment `@`-mentioned it.
 *
 * The mention path had no half like this, and the gap was not only a
 * silent thread. A mention is marked `addressed` by the mentioned
 * identity posting a comment — that is the whole mechanism, in
 * `resolveMentionsForComment` — so a run that answered in `runs.result`
 * and posted nothing left the mention open. `findPendingResponses` then
 * saw the same open mention on the next tick and dispatched it again,
 * inside the same initiation because the asking comment id is the
 * initiation id, until the attempt limit parked the item. Observed on a
 * real item: the implementer rebased the branch, force-pushed, said so
 * in its result, and was asked to do it twice more.
 *
 * Posted top-level and as the agent, both load-bearing. As the agent,
 * because only a comment from the mentioned identity closes the mention.
 * Top-level, because a reply at the bottom of the thread clears every
 * open mention aimed at that agent — and one run answers all of them,
 * since `dedupeByItemAndAgent` dispatches once per (item, agent)
 * however many comments called for it.
 *
 * `parseBodyMentions: false` for the reason `postAssistReply` uses
 * it: an agent writing "@reviewer" in prose would summon one, and
 * agent-to-agent asking goes through the comment tool, where the mention
 * is resolved, validated and depth-capped.
 */
export function postMentionReply(db: Db, item: Item, agentId: Uuid, runId: Uuid, parsedResult: unknown): void {
  const parsed = RespondOutputSchema.safeParse(parsedResult);

  postComment(db, {
    itemId: item.id,
    runId,
    author: { type: "agent", agentId },
    kind: "note",
    // A-02 already validated this, so the fallback is for the shape that
    // somehow got past it. It still posts: a comment nobody drafted is
    // better than the silence that reopens the loop this function exists
    // to close (invariant #8).
    body: parsed.success
      ? parsed.data.message
      : "This agent finished without a readable reply. Its full result is on the run.",
    parseBodyMentions: false,
  });
}
