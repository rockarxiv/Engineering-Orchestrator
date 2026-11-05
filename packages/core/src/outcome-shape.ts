import { parseIfFenced, unwrapOutcome } from "./schemas/clarification.js";

/**
 * The fields an outcome puts words in, in the order a reader wants them.
 *
 * Deliberately a list of names rather than a per-action lookup. Invariant
 * 7 says a pipeline can declare an action this codebase never heard of,
 * so there is no closed set of outcome schemas to switch on — but every
 * one EO ships addresses its human in one of these, and an action whose
 * schema uses none of them falls through to being shown exactly as it
 * arrived, which is the honest answer for a shape nothing here knows.
 */
const PROSE_FIELDS = ["summary", "message", "feedback", "handoff"] as const;

/**
 * The words inside an `outcome` envelope, or null if this is not one.
 *
 * An agent under constrained generation does not write prose — it writes
 * the JSON its schema asks for, wrapped in `outcome` because that is the
 * only way one provider's API will accept a union at all. When it uses
 * that shape to report *progress* rather than to answer (#144), the
 * result on screen is a terminal-looking handoff, `branch` and all, sat
 * in the middle of a run that is still going. The reported case said
 * `branch: "in_progress"`, and the run read as having an invalid branch
 * and being stuck.
 *
 * So the words are lifted out and the machinery around them is not
 * shown. Nothing is being hidden: this changes how a message is drawn,
 * never what is stored. The `run_events` row keeps every byte the agent
 * sent (invariant #3), and the `run_events` tool still reports it
 * verbatim to anything reading the log itself.
 *
 * The envelope is required, not merely an object with familiar fields.
 * An agent that pastes a JSON snippet into its narration is quoting
 * something, not answering, and a transcript that silently rewrote it
 * would be worse than the one this fixes.
 */
export function outcomeProse(text: string): string | null {
  const parsed = parseIfFenced(text);
  const inside = unwrapOutcome(parsed);
  // `unwrapOutcome` returns its input untouched when there was no
  // envelope to remove, which is the whole of the test: same value back,
  // same value in, so this was never an outcome.
  if (inside === parsed) return null;
  if (typeof inside !== "object" || inside === null || Array.isArray(inside)) return null;

  const record = inside as Record<string, unknown>;
  const said: string[] = [];
  for (const key of PROSE_FIELDS) {
    const value = record[key];
    // Deduplicated because an agent reporting progress routinely says the
    // same sentence in `summary` and in `handoff`, and reading it twice
    // is how a reader starts to wonder which one is the real one.
    if (typeof value === "string" && value.trim() !== "" && !said.includes(value)) said.push(value);
  }

  return said.length > 0 ? said.join("\n\n") : null;
}
