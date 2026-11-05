import type { BuiltinContext, BuiltinOutcome, BuiltinRunner } from "./supervisor/builtins.js";

/**
 * What a preview says instead of doing something (EO-313,
 * ARCHITECTURE.md, "Preview").
 *
 * A preview item walks a real pipeline so that somebody can watch the
 * machine work before they have signed into anything. Every agent step
 * on it runs on the fake backend, which costs nothing and reaches
 * nowhere — but a `module` or `builtin` step has no backend to swap.
 * Its whole job is the side effect: it posts to Slack, it opens a pull
 * request, it deploys. Running one is the one thing a preview must
 * never do, and a green tick beside "post to Slack" is exactly the
 * sentence the design says reads as posted.
 *
 * So the step is not executed, and the transcript carries this line
 * instead: what would have been run, and with what. The module's name
 * and its declared inputs, because "#marketing" is the part a person is
 * actually checking — the name alone would have them reading a
 * transcript to find out which channel a preview did not post to.
 */

/** The banner every surface draws on a preview (ARCHITECTURE.md, "Preview"). Here so the main process and its tests spell it once. */
export const PREVIEW_BANNER = "Preview. Nothing was sent, nothing cost money.";

/**
 * One input as the transcript prints it.
 *
 * Strings quoted, everything else bare: `channel: "#marketing"` and
 * `wait: 30`. The quotes are what make an empty string visible, which
 * is the value most worth seeing on a step somebody is about to trust.
 */
function printed(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * "Would have sent: Post to Slack — channel: "#marketing"."
 *
 * The inputs in the order the caller resolved them, which for a module
 * is its manifest's order laid under whatever the step overrides, so two
 * steps running one module read the same way.
 */
export function wouldHaveSentLine(name: string, inputs: Record<string, unknown>): string {
  const declared = Object.entries(inputs)
    .map(([key, value]) => `${key}: ${printed(value)}`)
    .join(", ");
  const what = declared === "" ? name : `${name} — ${declared}`;
  return `Would have sent: ${what}.\nNothing ran and nothing was sent: this item is a preview.`;
}

/**
 * A `builtin` step, on a preview, as something the supervisor can run
 * (EO-313).
 *
 * The same shape `builtins[action]` has, so everything downstream of it
 * is untouched: the run row, the transcript, the elapsed time and the
 * routing all happen exactly as they do for a function that really ran.
 * What is different is that nothing ran.
 *
 * `results` is what the registry declares for this action, and its first
 * entry is the function's own success — `BUILTIN_RESULTS` is written in
 * that order and `failed` is last in every one of them. Reporting it is
 * what carries the preview past this column: a preview that parked on
 * "cut a worktree" would have shown a person one column of the machine
 * they came to watch.
 *
 * Null results cannot happen — this runner is only chosen for an action
 * the registry knows — and it is refused rather than guessed at anyway,
 * because a preview inventing a result key is a preview taking a branch
 * the pipeline never declared.
 */
export function previewBuiltinRunner(action: string, results: readonly string[] | null): BuiltinRunner {
  return async (context: BuiltinContext): Promise<BuiltinOutcome> => {
    context.report(wouldHaveSentLine(action, {}));
    const first = results?.[0];
    return first === undefined
      ? { ok: false, reason: `"${action}" declares no result, so a preview of it has nothing to report.` }
      : { ok: true, result: first, detail: "" };
  };
}

/**
 * The line a preview's dispatch context carries, under the task
 * (EO-313, ARCHITECTURE.md, "Preview").
 *
 * Two readers, and it earns its place with either.
 *
 * The fake backend is the one that matters today. `createDemoProvider`
 * routes on the assembled context — that is how it knows which action
 * it is answering — and this is how it knows the item is a rehearsal,
 * so it can produce canned output for a step it would otherwise refuse.
 * Without it a preview stops dead at the first agent step with "no
 * coding agent is configured", which is true and is the wrong thing to
 * say to somebody who asked to watch the machine rather than to use it.
 *
 * The other reader is a person. The context is what the transcript
 * shows, so the run a preview produces opens by saying what it is.
 *
 * A real backend never sees it: a preview is dispatched to `fake`
 * whatever its agent is configured with, which is the point of
 * `runsOn`. The sentence is written as though one might, because a
 * prompt is a durable record and the day that stops being true it
 * should still read correctly.
 */
export const PREVIEW_TASK_NOTE =
  "**This item is a preview.** Nothing here reaches anybody: no message is sent, no file is written outside " +
  "this run's own empty directory, and nothing is charged. Answer as you would for real work — the point is to " +
  "show what the pipeline does — but treat every side effect as something you describe rather than perform.";

/** Whether an assembled dispatch context belongs to a preview. The fake backend's discriminator (EO-313). */
export function contextIsPreview(context: string): boolean {
  return context.includes(PREVIEW_TASK_NOTE);
}
