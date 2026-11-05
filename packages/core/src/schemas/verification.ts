import { z } from "zod";

/**
 * What a column head says is checked here (EO-312, ARCHITECTURE.md,
 * "What 'EO checks' means on a step", "The board", "The interface").
 *
 * Invariant 5 is "verify, don't trust", and outside software the engine
 * often cannot check a claim at all. The product must neither weaken
 * that quietly nor overstate it: "EO verifies" over a Draft column would
 * be read as "the numbers were checked". So a step *says* what is
 * checked, derived from whether the workspace kind it runs on has a
 * verifier for its action.
 *
 * One row per step, on the same channel as the steps themselves, for
 * `holds`' and `workspaceKind`'s reason: the head is drawn in the same
 * render as the step it names, and a second round-trip would let the two
 * disagree — a column claiming "EO checks: commits" for a frame after
 * somebody moved it onto a workspace that checks nothing.
 *
 * Derived, never stored (invariant 6): it is a fact about the kind the
 * step's workspace names and the action the step runs, and both are
 * answered fresh on every read.
 */
export const StepVerificationSchema = z.object({
  stepId: z.string(),
  /**
   * What the kind would check on this step, in the kind's own words.
   *
   * Empty means nothing here is checked — a real answer and not a gap,
   * and it arrives two ways. The action may be one no verifier answers
   * for: `refine` produces work the engine cannot invent or judge and
   * `review` is the reviewer's own opinion, so claiming to verify either
   * would be theatre. Or the step's own configuration may leave its
   * verifier nothing to look at: a folder step is held to the files it
   * declares it produces, and one that declares none is held to nothing.
   */
  checks: z.array(z.string()),
  /**
   * Whether a check could fail here.
   *
   * What decides whether `verification_failed` is a result this step
   * could ever report, and so whether the route editor offers it: a
   * route out of a step where no check will ever run is wiring for a
   * branch that can never be taken, and offering it is worse than
   * leaving it out — it reads as a branch somebody can rely on.
   *
   * The same answer as "`checks` is not empty", said as its own field
   * because the two questions are asked by different screens and a
   * reader of either should not have to infer the other. They agree by
   * construction: a verifier that would produce no checks on this step
   * can fail none.
   */
  verifiesAction: z.boolean(),
  /**
   * Whether the kind this step runs on checks anything at all.
   *
   * Asked of the *kind* rather than of the action, and the difference is
   * what keeps a developer's board unchanged: a git pipeline's `review`
   * step is not checked, but the workspace it runs on is one EO can
   * speak for, so the board has nothing new to explain. A step on a
   * workspace that can vouch for nothing — `none`, `scratch` — is what
   * makes the line appear, on every column at once, because that is the
   * pipeline where "what is checked" has stopped being obvious.
   */
  kindVerifies: z.boolean(),
  /**
   * The person or group a human step waits on, when it is somebody
   * other than you (EO-305, EO-323, ARCHITECTURE.md, "The board").
   *
   * Null in solo mode and on a step naming nobody, which is what turns
   * the head into "You approve here" rather than a name. Solo mode is
   * silent about people by design — one person told about themselves
   * fifty times is noise — and that silence is what the developer
   * board's snapshot holds to.
   */
  waitsOn: z.string().nullable(),
  /**
   * Whether `waitsOn` names a person or a group (EO-323, ARCHITECTURE.md, "Identity").
   *
   * The head reads "Anna Ruiz · approves here" for a person and "Support
   * team · anyone claims" for a group, and the difference is not
   * cosmetic: the first says who is expected to act, the second says
   * anybody in that team may take it. A name with no kind beside it
   * could only be rendered as one of the two, which would be a sentence
   * about a team that is false.
   *
   * Optional, and absent reads exactly as `"person"` does: every
   * `waitsOn` that existed before this field was a person's name, and a
   * client that has not been told otherwise is right to render one. Only
   * `"group"` changes a sentence, which is what keeps this additive —
   * the boards, fixtures and snapshots written against EO-305's shape
   * say precisely what they said before.
   */
  waitsOnKind: z.enum(["person", "group"]).nullable().optional(),
  /**
   * The id behind `waitsOn`, for the control that changes it (EO-323).
   *
   * A name is what a head shows and an id is what a picker sends, and
   * putting the id here rather than on `PipelineStepView` is deliberate:
   * that type is also the *request* the editor publishes a graph with, so
   * a field added to it is a field a publish would have to say something
   * about — exactly the trap `forWriting` exists for. This row is only
   * ever read.
   */
  waitsOnId: z.string().nullable().optional(),
});

export type StepVerification = z.infer<typeof StepVerificationSchema>;

/** What a head needs to know about its own step to say who or what stands behind it. */
export interface VerifiableStep {
  id: string;
  type: "agent" | "user" | "builtin" | "module";
}

/** The step's row, by id. */
function entryFor(verification: readonly StepVerification[], stepId: string): StepVerification | undefined {
  return verification.find((candidate) => candidate.stepId === stepId);
}

/**
 * Does this board say what is checked at all (ARCHITECTURE.md, "What 'EO checks' means on a step")?
 *
 * Only where at least one step that *runs* stands on a workspace that
 * can vouch for nothing. A pipeline EO can speak for end to end has
 * nothing to explain, and a line on every column of it would be chrome
 * rather than information — which is the whole of why a developer's
 * implement-review board does not change a word when this ships.
 *
 * A user step is never the reason: nothing runs there, so "not checked"
 * is not news about it. Its head names the person instead, and it says
 * so only when the board has already started talking.
 *
 * No rows at all answers no, which is the honest reading of a client
 * that has not been told: the absence of an answer is not the answer
 * "nothing is checked".
 */
export function saysWhatIsChecked(steps: readonly VerifiableStep[], verification: readonly StepVerification[]): boolean {
  if (verification.length === 0) return false;
  return steps.some((step) => step.type !== "user" && entryFor(verification, step.id)?.kindVerifies !== true);
}

/**
 * The line itself, for one column head.
 *
 * Four sentences and no fifth. What is checked, in the verifier's own
 * words joined by commas; "Not checked until Approve" where the action
 * has no verifier, which says what will happen instead rather than
 * leaving a person to wonder; and on a human step the person, because
 * there the answer to "what stands behind this" is somebody rather than
 * something — a person who approves, or a team anybody in it may claim
 * from.
 */
/**
 * Whether this column head names somebody, whatever else the board is
 * saying (EO-323, ARCHITECTURE.md, "What 'EO checks' means on a step").
 *
 * `saysWhatIsChecked` decides whether the board explains *verification*,
 * and answers no for a developer's pipeline — every step of which stands
 * on a workspace EO can speak for. That is right for "EO checks:
 * commits, tests ran" and wrong for a human step that names a person or
 * a team: "Support team · anyone claims" is not a claim about checking,
 * it is who is expected to act, and it is the one thing about that
 * column a person cannot work out from anything else on the screen.
 *
 * So a head draws its line when the board has started talking *or* when
 * this step names somebody. Silence is still the default — "You approve
 * here" is what an unowned step says, and it says it to nobody.
 */
export function namesAnOwner(step: VerifiableStep, verification: readonly StepVerification[]): boolean {
  return step.type === "user" && entryFor(verification, step.id)?.waitsOn != null;
}

export function verificationLine(step: VerifiableStep, verification: readonly StepVerification[]): string {
  const entry = entryFor(verification, step.id);
  if (step.type === "user") {
    if (entry?.waitsOn == null) return "You approve here";
    return entry.waitsOnKind === "group" ? `${entry.waitsOn} · anyone claims` : `${entry.waitsOn} · approves here`;
  }
  const checks = entry?.checks ?? [];
  return checks.length === 0 ? "Not checked until Approve" : `EO checks: ${checks.join(", ")}`;
}
