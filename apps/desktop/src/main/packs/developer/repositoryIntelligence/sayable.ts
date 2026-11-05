/**
 * How much of somebody else's sentence EO is willing to repeat, and how
 * much of it (EO-149, EO-151).
 *
 * The rule this subsystem is built on is "paths and counts, never
 * bodies", and the provider is where it is *kept*: `codewiki/provider.ts`
 * classifies what the tool printed instead of quoting it. This is the
 * layer above declining to take that on trust, which is invariant #5
 * applied to a subprocess — and it is worth having because the thing on
 * the other side of the port is a third-party binary EO does not
 * control, and its account of a failure is the one string in this whole
 * path that EO did not write.
 *
 * What it actually defends against, stated honestly, is the realistic
 * shape of the leak rather than the idea of one: a tool that quotes the
 * line it choked on emits a first line naming the error and *then* the
 * offending source, indented, underneath. Keeping the first line keeps
 * the diagnosis and drops the quotation. It is not — and cannot be — a
 * test for whether a string contains somebody's source; nothing can
 * decide that, and a guard claiming to would be worse than none.
 *
 * In production this is a no-op: every sentence the provider composes is
 * already one line. It bites only an implementation that has stopped
 * behaving, which is the only time a guard is worth anything.
 *
 * Shared by the two places a provider's reason reaches a person — the
 * indexing step's refusal and the dispatch notice saying an agent is
 * going without — because one rule written twice is one rule that will
 * be edited once.
 */

/** How much of somebody else's sentence EO is willing to repeat. */
const REASON_LIMIT = 500;

/**
 * One bounded line of a reason, on its way to a transcript or a comment.
 *
 * `fallback` is what a caller says when the reason was not a sentence at
 * all — a leading blank line, an empty string — because "the index could
 * not be built" and "the agent has no index to query" are different
 * things to be told, and a shared default would be wrong for one of
 * them.
 */
export function sayable(reason: string, fallback: string): string {
  const [first] = reason.split("\n");
  const line = (first ?? "").trim();
  // A reason that leads with a blank line is not one EO will guess at.
  if (line === "") return fallback;
  return line.length > REASON_LIMIT ? `${line.slice(0, REASON_LIMIT)}…` : line;
}
