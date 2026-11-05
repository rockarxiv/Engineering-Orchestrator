import { WAITING_RESULT, WAIT_UNTIL_ACTION, waitUntilMoment, type CoreBuiltinAction, type CoreBuiltinResult } from "@eo/core";
import { postComment } from "../db/repos/index.js";
import type { BuiltinRunner } from "./builtins.js";

/**
 * The functions the core runs itself (EO-459, ARCHITECTURE.md, "Where the
 * seams are").
 *
 * Beside the contract in `builtins.ts` rather than in a pack, because
 * that is the point of them: a core with nothing installed folds these
 * in (`foldPacks`), so a pipeline that only needs to wait for a date
 * runs without the developer pack. What each declares — its results,
 * that it can wait, that it reaches nothing outside EO — is
 * `packages/core`'s `coreBuiltins()`.
 */

/** Each core function, typed by the results `CORE_BUILTIN_RESULTS` declares — and `waiting`, for the ones that can be checked. */
export type CoreBuiltinRunners = { [A in CoreBuiltinAction]: BuiltinRunner<CoreBuiltinResult<A> | typeof WAITING_RESULT> };

/**
 * Waits until a moment in time (EO-459).
 *
 * The moment is the step's `at` input, or the item's spec field its
 * `field` input names — `waitUntilMoment` reads either. Before it the
 * answer is `waiting`; at it or after, `reached`.
 *
 * A moment that cannot be read is `failed`, with a comment saying what
 * was wrong and naming the field. A result rather than a failed check:
 * a field nobody filled in is not going to fill itself in over the next
 * six retries, and the pipeline can route `failed` to whoever should.
 *
 * `now` is injectable so a test can stand either side of the moment.
 */
export function createWaitUntil(now: () => number = Date.now): CoreBuiltinRunners["wait_until"] {
  return async ({ db, item, runId, inputs, ensureRun }) => {
    const moment = waitUntilMoment(inputs ?? {}, item.spec);
    if (!moment.ok) {
      // The run's row first: a check has none until it has something
      // to record, and this comment names it.
      ensureRun?.();
      postComment(db, {
        itemId: item.id,
        runId,
        author: { type: "engine" },
        kind: "note",
        body: `"${WAIT_UNTIL_ACTION}" could not tell when to stop waiting. ${moment.reason}`,
        // The body quotes whatever the input or the field held, which
        // anybody filling in an item could have written: an at-name in
        // it must stay text, not summon whoever it names.
        parseBodyMentions: false,
      });
      return { ok: true, result: "failed", detail: moment.reason };
    }

    const when = new Date(moment.at).toISOString();
    if (now() < moment.at) return { ok: true, result: WAITING_RESULT, detail: `Waiting until ${when}, from ${moment.source}.` };
    return { ok: true, result: "reached", detail: `${when}, from ${moment.source}, has come.` };
  };
}

export function createCoreBuiltinRunners(now: () => number = Date.now): CoreBuiltinRunners {
  return { wait_until: createWaitUntil(now) };
}
