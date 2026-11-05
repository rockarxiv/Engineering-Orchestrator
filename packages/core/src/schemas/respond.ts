import { z } from "zod";

/**
 * What an agent returns when a comment `@`-mentioned it (`respond`).
 *
 * The action had no schema, and its absence cost the same thing
 * `intake`'s did (KAN-32) and then one thing more. With no schema there
 * is no constrained generation, so the provider handed back whatever the
 * role's own instructions shaped — an implementer answering "there is a
 * conflict on the PR, can you fix it?" returned the `implement` envelope
 * — and nothing in `onRunSucceeded` knew what to do with it.
 *
 * That is not merely a lost message. A mention is closed by the mentioned
 * identity *posting a comment*, so a run that answers only in
 * `runs.result` leaves the mention open, and the next tick dispatches the
 * same request again under the same initiation until the attempt limit
 * stops it. One field is what it takes for the answer to exist as a
 * comment, which is what ends the loop.
 *
 * Deliberately one field. A mention is a question in a thread, and the
 * answer to it is prose; anything richer belongs to an action a pipeline
 * declares, not to "somebody asked you something".
 */
export const RespondOutputSchema = z.object({
  /** The reply, in markdown. Posted to the thread verbatim as the agent's own comment. */
  message: z.string().min(1),
});

export type RespondOutput = z.infer<typeof RespondOutputSchema>;
