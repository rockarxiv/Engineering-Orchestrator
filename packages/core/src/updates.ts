import { z } from "zod";

/**
 * What EO can say about updating itself (EO-201).
 *
 * Every answer the Updates section has to draw, as one discriminated
 * union rather than a bag of optional fields. "Available and also
 * downloading and also errored" is not a state EO can be in, so it
 * should not be a value this type can hold — a `version?` beside a
 * `percent?` beside an `error?` makes all three representable and
 * pushes the job of ruling them out onto every reader.
 *
 * One of the states is a dead end rather than a moment in a check:
 * `unsupported`, for a build that was never installed. It offers no
 * button, because a button that cannot work is worse than none.
 */

/**
 * Epoch milliseconds of the last completed check, or null if EO has
 * never got as far as an answer.
 *
 * Carried by every state that follows a check rather than by `idle`
 * alone, because "when did EO last look" is the section's other line
 * and it stays true across the whole flow. It is not a second
 * discriminator: it says *when*, never *what*, and the `state` field
 * remains the only thing anything branches on.
 */
const lastCheckedAt = z.number().int().nonnegative().nullable();

export const UpdateStatusSchema = z.discriminatedUnion("state", [
  /** Running from source. There is no installed build for an update to replace. */
  z.object({ state: z.literal("unsupported") }),
  /** Nothing in flight. `lastCheckedAt` is null before the first check of this process. */
  z.object({ state: z.literal("idle"), lastCheckedAt }),
  z.object({ state: z.literal("checking"), lastCheckedAt }),
  /** Looked, and this is the newest there is. */
  z.object({ state: z.literal("up-to-date"), lastCheckedAt }),
  /** There is a newer release, and nothing has been fetched. Downloading is the person's decision. */
  z.object({ state: z.literal("available"), version: z.string().min(1), lastCheckedAt }),
  /**
   * Fetching, somewhere between 0 and 100. Deliberately carries no
   * version: the percentage is the only thing that changes here, and
   * the name of what is being fetched was already said by `available`.
   */
  z.object({ state: z.literal("downloading"), percent: z.number().min(0).max(100), lastCheckedAt }),
  /** Staged on disk, waiting for a restart that has to be asked for. */
  z.object({ state: z.literal("downloaded"), version: z.string().min(1), lastCheckedAt }),
  /**
   * A check or a download failed, in words. This is where an unreachable
   * feed and an architecture with no matching artifact finally surface —
   * the section offers a retry, and never a restart.
   */
  z.object({ state: z.literal("error"), message: z.string(), lastCheckedAt }),
]);

export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;
export type UpdateState = UpdateStatus["state"];
