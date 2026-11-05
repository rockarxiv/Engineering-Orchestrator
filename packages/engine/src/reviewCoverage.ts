import type { CriterionResult, ReviewVerdictEvent } from "@eo/core";

/**
 * A review's acceptance-criteria coverage, and the census over many of
 * them (EO-200).
 *
 * Pure, and here rather than beside the reviewer, for the reason
 * everything in this package is: the same arithmetic has to run in three
 * places that share no infrastructure — the app, where it renders the
 * rejection comment; a unit test, where it is the thing under test; and
 * `scripts/review-census.mts`, which opens a database file with no
 * Electron and no Drizzle anywhere near it. A copy in each of those
 * would be three measurements, and three measurements that disagree
 * about what "covered" means answer nothing.
 */

/**
 * What became of one declared acceptance criterion.
 *
 * Four states rather than the schema's three. `not_reported` is not
 * something a reviewer can say — it is what the engine says about a
 * criterion the reviewer never mentioned, which is the quietest way to
 * skip one and so the one most worth naming.
 */
export type CoverageState = "met" | "not_met" | "not_assessed" | "not_reported";

export interface CoverageEntry {
  /** The item's wording, not the reviewer's echo of it — this is the list a person compares against. */
  criterion: string;
  state: CoverageState;
  note: string | null;
}

export interface CoverageSummary {
  /** One per declared criterion, in the item's own order. */
  entries: CoverageEntry[];
  /**
   * What the reviewer reported that matches no declared criterion.
   *
   * Usually a paraphrase, occasionally a criterion the item lost to an
   * edit mid-review. Kept rather than dropped: the reviewer did the work
   * and saying so costs a line, where discarding it would make a
   * thorough review read as a lazy one.
   */
  extra: CoverageEntry[];
  declared: number;
  met: number;
  notMet: number;
  notAssessed: number;
  notReported: number;
  /** `notAssessed + notReported`: criteria this review settled neither way. */
  unexamined: number;
  /**
   * Every declared criterion got a met/not-met answer.
   *
   * Vacuously true for an item that declares no criteria — there was
   * nothing to cover, and calling that incomplete would fail a reviewer
   * for the item's omission. `declared` is beside it so a census can
   * tell the two apart.
   */
  complete: boolean;
}

/**
 * Compared loosely on purpose.
 *
 * The reviewer is echoing a criterion it read in its context, and an
 * echo that differs by a trailing full stop, a wrapped line or a capital
 * is the same criterion. Comparing strictly would report those as
 * unexamined, and a check that cries wolf on formatting is a check
 * people learn to ignore.
 */
function normalise(text: string): string {
  // Trimmed before the trailing punctuation is stripped, not after: on
  // "429 over budget.  " the strip would otherwise find a space at the
  // end and match nothing, which is a silent miss rather than an error.
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:]+$/, "")
    .trim();
}

/**
 * What a review covered, against what the item actually asked for.
 *
 * Invariant #5 in one function: the reviewer's claim about its own
 * thoroughness is checked against something the engine holds rather than
 * taken at face value. A rejection listing one blocking issue and one
 * `met` for a four-criterion story is not the same artefact as one
 * listing one blocking issue and four results, and this is what makes
 * them different in the record instead of only in the prose.
 *
 * First match wins, and a matched entry is consumed: two coverage rows
 * echoing the same criterion cover it once, and the second is `extra`
 * rather than silently overwriting the first.
 */
export function summariseCriteriaCoverage(criteria: string[], coverage: CriterionResult[]): CoverageSummary {
  const declared = criteria.filter((criterion) => criterion.trim() !== "");
  const unclaimed = coverage.map((entry) => ({ entry, taken: false }));

  const entries = declared.map((criterion): CoverageEntry => {
    const key = normalise(criterion);
    const match = unclaimed.find((candidate) => !candidate.taken && normalise(candidate.entry.criterion) === key);
    if (!match) return { criterion, state: "not_reported", note: null };
    match.taken = true;
    return { criterion, state: match.entry.result, note: match.entry.note ?? null };
  });

  const extra = unclaimed
    .filter((candidate) => !candidate.taken)
    .map(({ entry }): CoverageEntry => ({ criterion: entry.criterion, state: entry.result, note: entry.note ?? null }));

  const count = (state: CoverageState): number => entries.filter((entry) => entry.state === state).length;
  const notAssessed = count("not_assessed");
  const notReported = count("not_reported");

  return {
    entries,
    extra,
    declared: declared.length,
    met: count("met"),
    notMet: count("not_met"),
    notAssessed,
    notReported,
    unexamined: notAssessed + notReported,
    complete: notAssessed + notReported === 0,
  };
}

/** One review, reduced to the numbers a census is computed from. */
export type ReviewObservation = ReviewVerdictEvent;

/** One item's reviews, in the order they happened. */
export interface ItemReviews {
  item: string;
  reviews: ReviewObservation[];
}

export interface ReviewCensus {
  items: number;
  reviews: number;
  approvals: number;
  rejections: number;
  needsInput: number;
  /**
   * Rejections carrying exactly one blocking issue, and their share of
   * all rejections.
   *
   * The figure `reviewer.md` quotes. `singleIssueShare` is null with no
   * rejections to divide by, rather than a zero that reads like a
   * finding.
   */
  singleIssue: number;
  singleIssueShare: number | null;
  /** Blocking issues per rejection, averaged. Null with no rejections. */
  issuesPerRejection: number | null;
  /** How many blocking issues each rejection carried, as count-by-size. */
  issueHistogram: { issues: number; rejections: number }[];
  /** Review runs per item — the round count this whole exercise is about. */
  roundsPerItem: number | null;
  maxRounds: number;
  /** Of the rejections against an item that declared criteria, how many settled every one. */
  rejectionsWithCriteria: number;
  fullCoverage: number;
  fullCoverageShare: number | null;
}

/**
 * What a rejection looked like before EO-200, recomputed (EO-200).
 *
 * `reviewer.md` quoted 83%, from a census nobody kept and nothing could
 * repeat. Recomputing it over every review in the shipped database gives
 * these numbers instead, so 83% was either never right or drifted while
 * the prompt went on asserting it — which is the entire argument for not
 * hard-coding a number without saying how to get it back.
 *
 * Reproduce with `pnpm dlx tsx scripts/review-census.mts`, whose
 * unfiltered run reads exactly the reviews this was taken over: every
 * one that predates the change, replayed out of its raw `result` row.
 *
 * A snapshot, and the counts drift until this ships: every review EO
 * runs on the old build lands in the same pre-change pile, so the
 * denominator grows by one per review between writing this and
 * installing it. The *share* is the claim and has not moved — it was 73%
 * at 98 of 135 and 73% at 99 of 136 — while the counts are provenance,
 * there so the figure can be traced rather than believed. If the script
 * disagrees with the share, the script is right and this is stale.
 */
export const PRE_CHANGE_BASELINE = {
  rejections: 136,
  singleIssue: 99,
  singleIssueShare: 99 / 136,
  issuesPerRejection: 1.4,
  maxRounds: 13,
  /** What `reviewer.md` used to claim, kept so the correction stays legible rather than silent. */
  previouslyQuoted: 0.83,
} as const;

const share = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

/**
 * The two numbers this item exists to make recomputable, plus the ones
 * that say whether the change worked.
 *
 * Takes reviews already grouped by item because rounds-per-item
 * cannot be recovered from a flat list — and grouping is a join the
 * caller has already done, whether it read the log through Drizzle or
 * through a raw SQL statement.
 */
export function reviewCensus(byItem: ItemReviews[]): ReviewCensus {
  const reviews = byItem.flatMap((entry) => entry.reviews);
  const rejections = reviews.filter((review) => review.verdict === "reject");
  const sizes = new Map<number, number>();
  for (const rejection of rejections) sizes.set(rejection.blockingIssues, (sizes.get(rejection.blockingIssues) ?? 0) + 1);

  const withCriteria = rejections.filter((rejection) => rejection.declaredCriteria > 0);
  const full = withCriteria.filter((rejection) => rejection.unexamined === 0);
  const rounds = byItem.map((entry) => entry.reviews.length);

  return {
    items: byItem.length,
    reviews: reviews.length,
    approvals: reviews.filter((review) => review.verdict === "approve").length,
    rejections: rejections.length,
    needsInput: reviews.filter((review) => review.verdict === "needs_user_input").length,
    singleIssue: sizes.get(1) ?? 0,
    singleIssueShare: share(sizes.get(1) ?? 0, rejections.length),
    issuesPerRejection: share(
      rejections.reduce((total, rejection) => total + rejection.blockingIssues, 0),
      rejections.length,
    ),
    issueHistogram: [...sizes.entries()].sort((a, b) => a[0] - b[0]).map(([issues, count]) => ({ issues, rejections: count })),
    roundsPerItem: share(reviews.length, byItem.length),
    maxRounds: rounds.length === 0 ? 0 : Math.max(...rounds),
    rejectionsWithCriteria: withCriteria.length,
    fullCoverage: full.length,
    fullCoverageShare: share(full.length, withCriteria.length),
  };
}
