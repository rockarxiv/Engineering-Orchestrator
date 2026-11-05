import { describe, expect, it } from "vitest";
import { reviewCensus, summariseCriteriaCoverage, type ReviewObservation } from "./reviewCoverage.js";

const CRITERIA = ["429 over budget", "Retry-After names when to retry", "The counter is per key"];

/**
 * EO-200. The distinction the whole item rests on: a rejection listing
 * one blocking issue because it looked at everything, against one
 * listing the same issue because it stopped at the first thing it found.
 * Before this they produced identical artefacts.
 */
describe("what a review covered, against what the item asked for", () => {
  it("reports every declared criterion in the item's own order", () => {
    const summary = summariseCriteriaCoverage(CRITERIA, [
      // Deliberately out of order: the reviewer's ordering is its own
      // business, and the list a person compares against is the item's.
      { criterion: "The counter is per key", result: "met" },
      { criterion: "429 over budget", result: "not_met", note: "no test drives the 101st request" },
      { criterion: "Retry-After names when to retry", result: "met" },
    ]);

    expect(summary.entries.map((entry) => entry.criterion)).toEqual(CRITERIA);
    expect(summary.entries.map((entry) => entry.state)).toEqual(["not_met", "met", "met"]);
    expect(summary.entries[0]?.note).toBe("no test drives the 101st request");
    expect(summary).toMatchObject({ declared: 3, met: 2, notMet: 1, unexamined: 0, complete: true });
  });

  it("counts a criterion the reviewer declined to assess as unexamined", () => {
    const summary = summariseCriteriaCoverage(CRITERIA, [
      { criterion: "429 over budget", result: "not_met" },
      { criterion: "Retry-After names when to retry", result: "not_assessed" },
      { criterion: "The counter is per key", result: "not_assessed" },
    ]);

    expect(summary).toMatchObject({ notAssessed: 2, notReported: 0, unexamined: 2, complete: false });
  });

  it("counts a criterion the reviewer never mentioned as unexamined too, and says which", () => {
    // The quietest way to skip a criterion is to say nothing about it,
    // so this is the case that has to be caught by the engine rather
    // than reported by the agent (invariant #5).
    const summary = summariseCriteriaCoverage(CRITERIA, [{ criterion: "429 over budget", result: "not_met" }]);

    expect(summary.entries.filter((entry) => entry.state === "not_reported").map((entry) => entry.criterion)).toEqual([
      "Retry-After names when to retry",
      "The counter is per key",
    ]);
    expect(summary).toMatchObject({ notReported: 2, unexamined: 2, complete: false });
  });

  it("distinguishes a one-issue rejection that examined everything from one that stopped at the first blocker", () => {
    // The acceptance criterion this file exists for, stated as a test:
    // same verdict, same single blocking issue, different artefact.
    const thorough = summariseCriteriaCoverage(CRITERIA, [
      { criterion: "429 over budget", result: "not_met" },
      { criterion: "Retry-After names when to retry", result: "met" },
      { criterion: "The counter is per key", result: "met" },
    ]);
    const stoppedEarly = summariseCriteriaCoverage(CRITERIA, [{ criterion: "429 over budget", result: "not_met" }]);

    expect(thorough.complete).toBe(true);
    expect(stoppedEarly.complete).toBe(false);
    expect(thorough.unexamined).toBe(0);
    expect(stoppedEarly.unexamined).toBe(2);
  });

  it("matches an echo that differs only in case, spacing or a trailing stop", () => {
    // A check that cried wolf on formatting is a check people learn to
    // ignore. The reviewer is echoing text it read wrapped in a prompt.
    const summary = summariseCriteriaCoverage(["429 over budget"], [{ criterion: "  429   OVER   budget.  ", result: "met" }]);

    expect(summary).toMatchObject({ met: 1, notReported: 0, complete: true });
    expect(summary.entries[0]?.criterion).toBe("429 over budget"); // the item's wording, not the echo
    expect(summary.extra).toEqual([]);
  });

  it("keeps a reported result that matches no declared criterion rather than dropping it", () => {
    const summary = summariseCriteriaCoverage(["429 over budget"], [
      { criterion: "429 over budget", result: "met" },
      { criterion: "The limiter is documented", result: "not_met" },
    ]);

    expect(summary.extra).toEqual([{ criterion: "The limiter is documented", state: "not_met", note: null }]);
    expect(summary.declared).toBe(1);
  });

  it("covers a criterion once when the reviewer echoes it twice", () => {
    const summary = summariseCriteriaCoverage(["429 over budget"], [
      { criterion: "429 over budget", result: "met" },
      { criterion: "429 over budget", result: "not_assessed" },
    ]);

    expect(summary.entries[0]?.state).toBe("met"); // first match wins, and is consumed
    expect(summary.extra).toHaveLength(1);
    expect(summary.unexamined).toBe(0);
  });

  it("calls an item with no criteria complete rather than failing its reviewer for the item's omission", () => {
    const summary = summariseCriteriaCoverage([], []);

    expect(summary).toMatchObject({ declared: 0, unexamined: 0, complete: true });
    // `declared` is what a census filters on to tell this apart from a
    // review that really did settle everything.
    expect(summary.entries).toEqual([]);
  });

  it("ignores a blank criterion, which is the item's noise rather than the review's gap", () => {
    const summary = summariseCriteriaCoverage(["429 over budget", "   ", ""], [{ criterion: "429 over budget", result: "met" }]);

    expect(summary).toMatchObject({ declared: 1, met: 1, complete: true });
  });
});

/**
 * The measurement `reviewer.md` quoted and nothing recomputed (EO-200).
 */
describe("the review census", () => {
  const review = (over: Partial<ReviewObservation>): ReviewObservation => ({
    verdict: "reject",
    blockingIssues: 1,
    declaredCriteria: 3,
    met: 0,
    notMet: 1,
    notAssessed: 0,
    notReported: 2,
    unexamined: 2,
    ...over,
  });

  it("derives issues per rejection and rounds per item", () => {
    const census = reviewCensus([
      { item: "EO-194", reviews: [review({}), review({}), review({}), review({}), review({ verdict: "approve", blockingIssues: 0 })] },
      { item: "EO-1", reviews: [review({ verdict: "approve", blockingIssues: 0 })] },
    ]);

    expect(census).toMatchObject({
      items: 2,
      reviews: 6,
      approvals: 2,
      rejections: 4,
      roundsPerItem: 3,
      maxRounds: 5,
      issuesPerRejection: 1,
      singleIssue: 4,
      singleIssueShare: 1,
    });
  });

  it("reports the share of rejections carrying exactly one issue, which is the figure in the prompt", () => {
    const census = reviewCensus([
      {
        item: "EO-1",
        reviews: [review({ blockingIssues: 1 }), review({ blockingIssues: 1 }), review({ blockingIssues: 1 }), review({ blockingIssues: 4 })],
      },
    ]);

    expect(census.singleIssue).toBe(3);
    expect(census.singleIssueShare).toBe(0.75);
    expect(census.issuesPerRejection).toBe(1.75);
    expect(census.issueHistogram).toEqual([
      { issues: 1, rejections: 3 },
      { issues: 4, rejections: 1 },
    ]);
  });

  it("reports coverage only over rejections against items that declared criteria", () => {
    // An item with no criteria cannot have its coverage judged, and
    // counting it either way would move the number this change is
    // measured by.
    const census = reviewCensus([
      {
        item: "EO-1",
        reviews: [review({ unexamined: 0, notReported: 0, met: 2 }), review({ unexamined: 2 }), review({ declaredCriteria: 0, unexamined: 0, notReported: 0 })],
      },
    ]);

    expect(census.rejectionsWithCriteria).toBe(2);
    expect(census.fullCoverage).toBe(1);
    expect(census.fullCoverageShare).toBe(0.5);
  });

  it("answers null rather than zero when there is nothing to divide by", () => {
    // A zero here reads like a finding — "no rejection carried one
    // issue" — where the truth is that no rejection was measured at all.
    const census = reviewCensus([]);

    expect(census).toMatchObject({
      reviews: 0,
      rejections: 0,
      singleIssueShare: null,
      issuesPerRejection: null,
      roundsPerItem: null,
      fullCoverageShare: null,
      maxRounds: 0,
    });
  });
});
