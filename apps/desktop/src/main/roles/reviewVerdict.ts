import { acceptanceCriteriaOf, REVIEW_VERDICT_EVENT, type ReviewOutput, type ReviewVerdictEvent, type Item, type Uuid } from "@eo/core";
import { PRE_CHANGE_BASELINE, reviewCensus, summariseCriteriaCoverage, type CoverageEntry, type CoverageSummary } from "@eo/engine";
import type { Db } from "../db/client.js";
import { appendRunEvent, getItemType, listReviewVerdictsByItem, postComment } from "../db/repos/index.js";

/** How each state reads in the thread. The word a person scans for, not the enum. */
const STATE_LABELS: Record<CoverageEntry["state"], string> = {
  met: "met",
  not_met: "**NOT MET**",
  not_assessed: "**not assessed**",
  not_reported: "**not reported** — the review said nothing about this criterion",
};

/**
 * The coverage table, as it appears in the rejection comment (EO-200).
 *
 * A table rather than a count, because the count is the thing that would
 * get skimmed. "3 of 4 criteria assessed" tells the next implementer
 * nothing it can act on; a list with one line reading **not assessed**
 * tells it exactly which criterion still has to be argued, and tells the
 * person reading the item exactly where this review stopped.
 *
 * The header sentence is the honest summary of what the reviewer did,
 * and it is deliberately blunt when the answer is "not much": a review
 * that examined one of six criteria and found one fault has not
 * established that there is only one fault, and the next round should
 * not read it as though it had.
 */
function renderCoverage(summary: CoverageSummary): string {
  if (summary.declared === 0 && summary.extra.length === 0) return "";

  const line = (entry: CoverageEntry): string => `- ${entry.criterion} — ${STATE_LABELS[entry.state]}${entry.note ? `\n  ${entry.note}` : ""}`;

  const settled = summary.declared - summary.unexamined;
  const headline =
    summary.declared === 0
      ? "This ticket declares no acceptance criteria; the reviewer reported on the following anyway."
      : summary.complete
        ? `**Acceptance-criteria coverage: all ${summary.declared} examined.**`
        : `**Acceptance-criteria coverage: ${settled} of ${summary.declared} examined — ${summary.unexamined} left unexamined, so this review does not establish that the blocking issues it lists are all of them.**`;

  // Each block contributes its own leading blank line, so an item with
  // no declared criteria and only extras does not render two of them.
  const sections = [headline, ...(summary.entries.length > 0 ? ["", ...summary.entries.map(line)] : [])];
  if (summary.extra.length > 0) {
    sections.push("", "Reported, but matching no criterion this ticket declares:", ...summary.extra.map(line));
  }
  return `\n\n${sections.join("\n")}`;
}

/**
 * Posts the reviewer's feedback into the thread.
 *
 * On a rejection this is the *only* thing the next implementer attempt
 * receives from the reviewer — E-06 assembles it into that run's
 * context. Posting it as a comment rather than stashing it on the run
 * row is what makes that work, and is why the design says comments are the one
 * channel. The criteria coverage rides in the same comment for exactly
 * that reason: a coverage table kept anywhere else would be visible to
 * nobody and reach nothing.
 */
export function postReviewFeedback(db: Db, item: Item, agentId: Uuid, runId: Uuid, review: ReviewOutput): void {
  // Narrowed rather than defaulted: `blocking_issues` exists only on a
  // rejection now, because it only ever meant anything there.
  const issues =
    review.verdict === "reject" ? `\n\n**Blocking issues:**\n${review.blocking_issues.map((issue) => `- ${issue}`).join("\n")}` : "";
  const approved = review.verdict === "approve";

  // Only a rejection carries coverage, and only a rejection is asked
  // for it (EO-200). An approval already asserts every criterion is met
  // — that is what approving *is* — so demanding a table saying so
  // would put a page of obligation on the review that costs the least
  // and is most often right.
  // By the name this item's type declares (KAN-147), so the list the
  // coverage table is measured against is the list the gate and the
  // refusal both read — three parts of EO that share no infrastructure
  // and must not disagree about what "declared" means.
  const declared = acceptanceCriteriaOf(item, getItemType(db, item.typeId)?.specShape);
  const coverage = review.verdict === "reject" ? summariseCriteriaCoverage(declared, review.criteria_coverage) : null;

  postComment(db, {
    itemId: item.id,
    runId,
    author: { type: "agent", agentId },
    kind: approved ? "approval" : "rejection",
    body: `${approved ? "Approved." : "Changes requested."}\n\n${review.feedback}${issues}${coverage ? renderCoverage(coverage) : ""}`,
  });

  recordVerdict(db, runId, review, declared.length, coverage);

  // After the row is written, so this item's own last round is in the
  // count it reports.
  if (approved) reportCensus(db, item);
}

const percent = (share: number | null): string => (share === null ? "n/a" : `${Math.round(share * 100)}%`);

/**
 * The measurement, said out loud on the item that just finished
 * (EO-200).
 *
 * EO-200's last acceptance criterion asks for the re-measured
 * single-issue share to be *reported on the item*, and the first
 * attempt at it shipped a script and a note saying to run it later. That
 * is the same mistake the item exists to correct, one level up: the
 * 83% in `reviewer.md` was also a number somebody meant to keep
 * checking. A figure that depends on a person remembering is a figure
 * that stops being true quietly, so this is EO doing the remembering.
 *
 * On approval, and only there. An approval is the last review an item
 * gets, so its round count is final and this posts exactly once per
 * item rather than once per round — and a rejection comment has to
 * stay a list of things to fix, not a place statistics are kept.
 *
 * It costs the reviewer nothing: this runs in the engine after the
 * verdict has been posted and acted on, so a clean review gains no
 * obligation and is not slowed by it. The agent is never asked for any
 * of this.
 *
 * The population is every review EO has recorded a verdict row for,
 * which is exactly the reviews that happened after this shipped. Reviews
 * before it left no such row and are not invented — they are the
 * baseline being compared against, and `scripts/review-census.mts`
 * replays them for anyone who wants the workings.
 */
function reportCensus(db: Db, item: Item): void {
  const byItem = listReviewVerdictsByItem(db);
  const census = reviewCensus(byItem);
  const here = byItem.find((entry) => entry.item === item.key)?.reviews.length ?? 0;

  // Nothing to compare yet. Said rather than skipped: "no rejections
  // since this shipped" is a real state and reads differently from a
  // report that never ran.
  const comparison =
    census.rejections === 0
      ? `No rejection has been recorded since acceptance-criteria coverage shipped, so there is nothing yet to set against the ${percent(PRE_CHANGE_BASELINE.singleIssueShare)} baseline.`
      : [
          `**${percent(census.singleIssueShare)}** of rejections since acceptance-criteria coverage shipped carried exactly one blocking issue ` +
            `(${census.singleIssue} of ${census.rejections}), against a **${percent(PRE_CHANGE_BASELINE.singleIssueShare)}** baseline ` +
            `before it (${PRE_CHANGE_BASELINE.singleIssue} of ${PRE_CHANGE_BASELINE.rejections}).`,
          `Issues per rejection: ${census.issuesPerRejection?.toFixed(2) ?? "n/a"}, against ${PRE_CHANGE_BASELINE.issuesPerRejection.toFixed(2)}.`,
          `Rounds per ticket: ${census.roundsPerItem?.toFixed(2) ?? "n/a"} over ${census.items}, worst ${census.maxRounds}, against a worst of ${PRE_CHANGE_BASELINE.maxRounds}.`,
          census.rejectionsWithCriteria === 0
            ? "No rejection yet has been against a ticket declaring acceptance criteria, so coverage has nothing to report."
            : `${percent(census.fullCoverageShare)} of rejections examined every criterion (${census.fullCoverage} of ${census.rejectionsWithCriteria}).`,
        ].join("\n\n");

  postComment(db, {
    itemId: item.id,
    author: { type: "engine" },
    kind: "note",
    body:
      `**Review census.** This ticket took ${here} review round${here === 1 ? "" : "s"}.\n\n${comparison}\n\n` +
      `Recompute any of this with \`pnpm dlx tsx scripts/review-census.mts\`, which reads the same \`run_events\` rows ` +
      `and can replay the pre-change reviews the baseline is taken over. The ${percent(PRE_CHANGE_BASELINE.previouslyQuoted)} ` +
      `that \`reviewer.md\` used to quote came from a census nothing could repeat, and did not survive being recomputed.`,
  });
}

/**
 * The measurement, in the log EO already keeps (EO-200).
 *
 * `reviewer.md` argued its case with "83% of rejections carried a single
 * issue" — a figure from a census nobody could repeat, so nothing could
 * tell whether it was still true. One row per verdict makes
 * issues-per-rejection and rounds-per-item a query, and
 * `scripts/review-census.mts` is that query written down.
 *
 * `declaredCriteria` is recorded on every verdict because it is a fact
 * about the item rather than about the review, and a census that could
 * not see it would have no denominator for an approval. The four
 * coverage counts are zero on anything but a rejection — coverage is a
 * rejection's obligation, and zeros there mean "not asked for", not
 * "asked for and skipped".
 *
 * Written with `appendRunEvent` rather than through the run's buffer,
 * which is safe here and nowhere near it: `postReviewFeedback` runs from
 * `onRunSucceeded`, and the supervisor disposes this run's buffer and
 * drops it from `activeEventBuffers` before that point — so nothing is
 * allocating sequence numbers for this run when this row is written.
 * Called after the comment, so a failure to record the measurement can
 * never cost the feedback the next attempt actually needs.
 */
function recordVerdict(db: Db, runId: Uuid, review: ReviewOutput, declaredCriteria: number, coverage: CoverageSummary | null): void {
  const payload: ReviewVerdictEvent = {
    verdict: review.verdict,
    blockingIssues: review.verdict === "reject" ? review.blocking_issues.length : 0,
    declaredCriteria,
    met: coverage?.met ?? 0,
    notMet: coverage?.notMet ?? 0,
    notAssessed: coverage?.notAssessed ?? 0,
    notReported: coverage?.notReported ?? 0,
    unexamined: coverage?.unexamined ?? 0,
  };
  appendRunEvent(db, runId, REVIEW_VERDICT_EVENT, payload);
}
