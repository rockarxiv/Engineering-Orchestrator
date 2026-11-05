import type { PipelineStep, StepResult } from "@eo/core";

/**
 * A person deciding on a human step, judged before anything is written
 * (EO-310, ARCHITECTURE.md, "Results and routes").
 *
 * Pure, and here rather than beside the command, for `resolveRoute`'s
 * reason (invariant #2): given the step and what was asked, this answers
 * whether the decision may be taken at all, with no database and no
 * knowledge of what any particular pack means by "approve".
 *
 * Three refusals, and each names which of the three it is — the step,
 * the key, or the reason nobody wrote. That is the whole point of
 * separating them: "cannot decide" is a sentence a person can do nothing
 * with, and each of these has a different next move.
 */
export interface DecisionRefusalInput {
  /** The step the item is on. Undefined when it is on none — an item in no pipeline. */
  step: PipelineStep | undefined;
  /** The key the caller named. */
  resultKey: string;
  /** What they wrote, already trimmed by the caller or not — this trims. */
  comment: string;
}

/**
 * Why this decision cannot be taken, in the reader's words, or null when
 * it can.
 *
 * Names the step and the results it does declare, because the two things
 * a caller needs are what went wrong and what would have worked. A
 * connected client is the reason that matters most: it cannot see the
 * screen, so a refusal that does not list the keys is a refusal it can
 * only answer by guessing.
 */
export function decisionRefusal(input: DecisionRefusalInput): string | null {
  const { step, resultKey, comment } = input;

  if (step === undefined) {
    return "This item is not on a pipeline step, so there is nothing to decide. Nothing has changed.";
  }

  // An agent step reports its own result, and a builtin or a module
  // declares what it can return. A person pressing a button on one of
  // those would be answering a question that was asked of something
  // else — and, worse, taking a route while the run that was going to
  // take it is still in flight.
  if (step.type !== "user") {
    return (
      `"${step.name}" is not a step a person decides on — it is ${describeActor(step)}, which reports its own result. ` +
      "Nothing has changed."
    );
  }

  const declared = step.results;
  const match = declared.find((result) => result.key === resultKey);
  if (!match) {
    return declared.length === 0
      ? `"${step.name}" declares no results, so there is nothing to decide there yet. Ask the assistant to give the step its results first. Nothing has changed.`
      : `"${resultKey}" is not one of the results "${step.name}" declares (${declared.map(describeResult).join(", ")}). Nothing has changed.`;
  }

  if (match.requiresComment && comment.trim() === "") {
    return (
      `"${match.label}" needs a comment saying why — it is how the reason reaches the next step. ` +
      "Say what is wrong and decide again. Nothing has changed."
    );
  }

  return null;
}

/** `approved (Approve)` — the key a caller has to send, and the words a person reads. */
function describeResult(result: StepResult): string {
  return result.label === result.key ? result.key : `${result.key} (${result.label})`;
}

/**
 * What acts on this step, named the way the person configuring it named
 * it. Deliberately says "an agent" rather than the role: the sentence is
 * about why a person cannot answer here, and which role it is does not
 * change that.
 */
function describeActor(step: PipelineStep): string {
  if (step.type === "agent") return "dispatched to an agent";
  if (step.type === "module") return "run by a module";
  return "run by EO itself";
}
