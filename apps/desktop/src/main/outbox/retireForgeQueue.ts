import { gitStateOf, NO_GIT_STATE } from "@eo/core";
import type { Db } from "../db/client.js";
import { completePush, duePushes, getItem, postComment } from "../db/repos/index.js";

/**
 * Closing out pull requests the old outbox was still holding (EO-77).
 *
 * The forge channel is gone: opening a pull request happens inside the
 * step's own run, which is the only place that can report what happened.
 * That leaves one state nothing else covers — EO was closed between the
 * merge step queueing a send and the drain getting to it, or partway
 * through its backoff. Those rows will never be picked up again, because
 * nothing drains that channel any more.
 *
 * Deleting them in the migration was the first attempt and was wrong in
 * the way invariant #8 is about. The step had already reported `opened`,
 * so the item routed on and its thread says a pull request exists; the
 * queue row was the only remaining trace that one does not. Dropping it
 * silently leaves a person believing their change is up for review with
 * nothing anywhere to correct them — which is the exact failure that
 * moved this work into the run in the first place.
 *
 * So the row is retired *and said out loud*, once, on the item it
 * belongs to. Run before the drain starts, for the same reason the
 * supervisor reconciles before its first tick: no queue should be half
 * in one world and half in the other while something is reading it.
 */
export function retireForgeQueue(db: Db, now = Date.now()): number {
  // Everything, not just what is due: a row sitting out a backoff is the
  // likeliest one to be here, and it is exactly as stranded as the rest.
  // `duePushes` is asked for a far-future `now` rather than given a new
  // query, so this reads the queue through the same door the drain does.
  const stranded = duePushes(db, "forge", now + ONE_YEAR_MS, Number.MAX_SAFE_INTEGER);

  for (const entry of stranded) {
    completePush(db, entry.id);

    const item = getItem(db, entry.itemId);
    // The branch is the git kind's state on the item now (KAN-169);
    // this sentence names it, so it is read out here rather than
    // reached for twice in the middle of one.
    const { branch } = item === undefined ? NO_GIT_STATE : gitStateOf(item);
    postComment(db, {
      itemId: entry.itemId,
      author: { type: "engine" },
      kind: "escalation",
      body:
        `EO had a pull request queued for ${item?.key ?? "this item"} when it last shut down, and the queue it was waiting in no longer exists — ` +
        `pull requests are opened by the merge step itself now, which is what lets it tell you when one fails.\n\n` +
        `Nothing was lost: the branch and its commits are untouched. ${branch === null ? "The branch " : `\`${branch}\` `}` +
        `simply has no pull request open. Move this ticket through the merge step again to open one.`,
      mentions: [{ type: "human" }],
    });
  }

  return stranded.length;
}

/** Far enough ahead that no backoff outlasts it — this is "every row", said through `duePushes`. */
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
