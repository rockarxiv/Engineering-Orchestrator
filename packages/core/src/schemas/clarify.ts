import { z } from "zod";

/**
 * The name this shape answers to (KAN-163).
 *
 * Not an action any step dispatches — it is reached by dispatching
 * `refine` against a leaf — but a *name*, which is what an action
 * override needs to say "this type answers in that shape". The one
 * spelling, so the registry's key, the leaf types' override and the
 * prompt section that goes with it cannot drift into three.
 */
export const CLARIFY_ACTION = "clarify";

/**
 * What the product owner returns for work that arrived already written
 * (KAN-19).
 *
 * `refine` means two different things depending on what it is pointed
 * at. A feature gets decomposed — that is `RefineOutputSchema`. An issue
 * imported as it stands has nothing to decompose: someone already did
 * that, in Jira, and the only open question is whether what they wrote
 * can be implemented as it stands.
 *
 * `ready` is a literal `true` on purpose. There is no way to return
 * "no": a product owner with questions has to ask them, by returning
 * `ClarificationRequired` (KAN-29 — this used to say "through the
 * `comment` tool and a blocking `@user` mention", which is how it worked
 * before asking became a result). One parking mechanism instead of two,
 * and an unanswered question ends the run rather than becoming a field
 * nobody reads.
 *
 * `IntakeOutputSchema` is the same shape for the same reason (KAN-32).
 */
export const ClarifyOutputSchema = z.object({
  ready: z.literal(true),
  /**
   * What the work is, in the agent's own words. Not decoration: it is
   * the only evidence in the record that the thing was read rather than
   * waved through, and it is what the implementer sees at the top of its
   * thread.
   */
  understanding: z.string().min(1),
});

export type ClarifyOutput = z.infer<typeof ClarifyOutputSchema>;
