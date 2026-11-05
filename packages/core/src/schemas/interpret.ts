import { z } from "zod";

/**
 * What the system agent is dispatched as when somebody answers a parked
 * non-agent step in their own words (EO-184).
 *
 * Outside any pipeline's `entry_action`, like `respond` and `discuss`:
 * no step is owned by it and `tick()` never produces one. It is reached
 * from `findPendingInterpretations` alone, on an item that is parked and
 * stays parked for the whole of the run.
 *
 * The string lives here rather than beside `RESPOND_ACTION` because the
 * schema and the action name are one fact — `SCHEMAS_BY_ACTION` is keyed
 * on it — and because the desktop app reaches for it from four places
 * that have no business importing the dispatcher.
 */
export const INTERPRET_ACTION = "interpret";

/**
 * What the system agent hands back after reading a free-text reply to a
 * step that stopped and asked (EO-184).
 *
 * A builtin or a module hears an answer by finding a matching comment in
 * the thread. Click one of the offered buttons and it works; type a
 * sentence and the step re-runs, hand-parses the thread, finds nothing,
 * and asks the identical question again. This is the third answer: a
 * reply nobody could match is read by the one agent that can, and what
 * it returns says which of three things it did.
 *
 * - **`answered`** — the sentence meant one of the answers the step
 *   could use, and `answer` is that answer in the step's own words. It
 *   is posted verbatim as a comment threaded under the person's reply,
 *   so the matcher the step already has finds the string it was looking
 *   for. Nothing here is a paraphrase of the person's sentence: a step
 *   that offered "Merge anyway" and "Send it back" can act on those two
 *   strings and on nothing else.
 * - **`acted`** — the reply asked for something to be *done* rather than
 *   answered ("the branch is stale, delete it and try again"), and the
 *   agent did it with its own tools. `retry` is whether the step should
 *   be run again now: true where the obstacle is gone, false where the
 *   agent has already moved the work itself or where running again would
 *   simply fail the same way.
 * - **`unusable`** — the reply cannot be read as either, and `problem`
 *   says why. It is quoted back to the person as an escalation rather
 *   than dropped, and the item stays parked (invariant #8).
 *
 * There is no fourth branch for "ask a question", because
 * `outputSchemaFor` already unions every action's schema with
 * `ClarificationRequiredSchema` — handing the question back to the person
 * costs nothing and needs nothing here.
 */
export const InterpretOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("answered"),
    /** The answer in the step's own words — one of the options it offered, where it offered any. */
    answer: z.string().min(1),
    /** Why this is what the reply meant, for the person. Optional: an obvious reading needs no defence. */
    note: z.string().optional(),
  }),
  z.object({
    status: z.literal("acted"),
    /** What was actually done, in a sentence. Posted to the thread as the only record of it. */
    summary: z.string().min(1),
    /** Whether the parked step should be run again now. */
    retry: z.boolean(),
  }),
  z.object({
    status: z.literal("unusable"),
    /** What could not be read out of the reply, said so the person can answer again. */
    problem: z.string().min(1),
  }),
]);

export type InterpretOutput = z.infer<typeof InterpretOutputSchema>;
