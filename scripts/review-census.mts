#!/usr/bin/env -S pnpm dlx tsx
// What EO's reviews actually cost, out of `run_events` (EO-200).
//
// `reviewer.md` argued for reporting every blocking issue in one verdict
// by quoting EO's own data: "rejections here have carried a single issue
// 83% of the time, and stories have gone round this loop eleven times".
// The instruction did not hold — EO-194 took four rejections for three
// faults in two files — and the figure could not be checked, because
// nothing recomputed it. A number nothing recomputes is a number that
// stays in a prompt long after it stops being true.
//
// This is that recomputation.
//
//   pnpm dlx tsx scripts/review-census.mts                  # every item
//   pnpm dlx tsx scripts/review-census.mts EO-194 EO-37     # named items, with their rounds listed
//   pnpm dlx tsx scripts/review-census.mts --since 2026-09-01
//   pnpm dlx tsx scripts/review-census.mts --db path/to/eo.db
//
// This is the on-demand spelling. It is not the only one, and
// deliberately not the primary one: EO posts a review census onto every
// item it approves, so the post-change share arrives without anyone
// remembering to ask for it. A measurement that depends on a person
// remembering is the failure this whole item is about, one level up.
// Reach for this when you want the workings — the per-item round list,
// the issue histogram, the pre-change baseline replayed — or a database
// other than the running app's.
//
// `--since` narrows to reviews after a date, which is how the two eras
// are compared directly: run it with the date acceptance-criteria
// coverage shipped, and set what it prints against the baseline the
// unfiltered run prints.
//
// Two sources, and it says which it used per review:
//
//   `review_verdict` — one row per verdict, written by
//     `postReviewFeedback` since EO-200. Typed, counted at the moment
//     the verdict was posted, and the only source that carries criteria
//     coverage.
//
//   `result` — the raw provider payload, which every review has had
//     since the beginning. This is how the baseline is recoverable at
//     all, and it is a fallback rather than the primary for a reason:
//     its shape is the backend's, not EO's — `data` is sometimes an
//     object, sometimes a JSON string, and the verdict sits under
//     `outcome` or directly under `data` depending on how the result was
//     wrapped. Every one of those is a way for a census to quietly read
//     zero.
//
// The arithmetic is imported from `packages/engine`, never copied: the
// app renders its coverage from the same function, and two spellings of
// "covered" would be two measurements.
//
// Read-only, and through `node:sqlite` rather than `better-sqlite3` —
// the native module has exactly one import site (ARCHITECTURE.md, "SQLite, and nothing more") and a
// reporting script is not it.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { reviewCensus, type ReviewObservation, type ItemReviews } from "../packages/engine/src/reviewCoverage.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

const items = argv.filter((argument) => /^[A-Z]+-\d+$/.test(argument));
const dbPath = flag("--db") ?? join(homedir(), ".config", "EO", "eo.db");
const sinceRaw = flag("--since");
const since = sinceRaw === undefined ? 0 : Date.parse(sinceRaw);

if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Pass one with --db.`);
  process.exit(1);
}
if (Number.isNaN(since)) {
  console.error(`Could not read --since ${sinceRaw} as a date.`);
  process.exit(1);
}

/**
 * Every review event, both kinds, in the order they happened.
 *
 * One query rather than two so the ordering is the database's: a
 * `review_verdict` row and the `result` row it was derived from belong
 * to the same run, and the pairing below depends on seeing them
 * together.
 *
 *     SELECT ... FROM run_events e
 *       JOIN runs r ON r.id = e.run_id
 *       JOIN items t ON t.id = r.item_id
 *      WHERE r.action = 'review' AND e.type IN ('review_verdict','result')
 */
const REVIEW_EVENTS = `
  SELECT t.key AS item, e.run_id AS run, e.ts AS ts, e.type AS type, e.payload AS payload
    FROM run_events e
    JOIN runs r ON r.id = e.run_id
    JOIN items t ON t.id = r.item_id
   WHERE r.action = 'review'
     AND e.type IN ('review_verdict', 'result')
     AND e.ts >= ?
   ORDER BY t.key, e.ts, e.seq
`;

interface Row {
  item: string;
  run: string;
  ts: number;
  type: string;
  payload: string;
}

const VERDICTS = new Set(["approve", "reject", "needs_user_input"]);

/** A recorded `review_verdict` payload, which is already the shape the census wants. */
function fromVerdictRow(payload: unknown): ReviewObservation | null {
  if (typeof payload !== "object" || payload === null) return null;
  const row = payload as Record<string, unknown>;
  if (typeof row["verdict"] !== "string" || !VERDICTS.has(row["verdict"])) return null;
  const number = (key: string): number => (typeof row[key] === "number" ? row[key] : 0);
  return {
    verdict: row["verdict"] as ReviewObservation["verdict"],
    blockingIssues: number("blockingIssues"),
    declaredCriteria: number("declaredCriteria"),
    met: number("met"),
    notMet: number("notMet"),
    notAssessed: number("notAssessed"),
    notReported: number("notReported"),
    unexamined: number("unexamined"),
  };
}

/**
 * The same numbers dug out of a raw provider result.
 *
 * Every unwrapping here is a shape seen in the shipped database, not a
 * defensive guess: `data` as a JSON string is one backend, the `outcome`
 * wrapper is `unwrapOutcome`'s doing, and a bare verdict under `data` is
 * what the rest produce. Coverage is zero throughout — reviews from
 * before EO-200 were never asked for any, and inventing a number for
 * them would be the exact sin this script exists to stop.
 */
function fromResultRow(payload: unknown): ReviewObservation | null {
  if (typeof payload !== "object" || payload === null) return null;
  let data = (payload as { data?: unknown }).data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof data !== "object" || data === null) return null;
  const outcome = ((data as { outcome?: unknown }).outcome ?? data) as Record<string, unknown>;
  if (typeof outcome["verdict"] !== "string" || !VERDICTS.has(outcome["verdict"])) return null;
  const issues = outcome["blocking_issues"];
  return {
    verdict: outcome["verdict"] as ReviewObservation["verdict"],
    blockingIssues: Array.isArray(issues) ? issues.length : 0,
    declaredCriteria: 0,
    met: 0,
    notMet: 0,
    notAssessed: 0,
    notReported: 0,
    unexamined: 0,
  };
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare(REVIEW_EVENTS).all(since) as unknown as Row[];

/** One observation per *run*, preferring the recorded row over the replayed one. */
const byRun = new Map<string, { item: string; ts: number; recorded: boolean; observation: ReviewObservation }>();
for (const row of rows) {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    continue;
  }
  const recorded = row.type === "review_verdict";
  const observation = recorded ? fromVerdictRow(payload) : fromResultRow(payload);
  if (!observation) continue;
  // A run has both rows since EO-200. The recorded one wins: it is the
  // only one that carries coverage, and it was counted by the code that
  // wrote the verdict rather than reconstructed from a payload shape.
  const existing = byRun.get(row.run);
  if (existing && (existing.recorded || !recorded)) continue;
  byRun.set(row.run, { item: row.item, ts: row.ts, recorded, observation });
}

const grouped = new Map<string, ItemReviews>();
for (const { item, observation } of [...byRun.values()].sort((a, b) => a.ts - b.ts)) {
  const entry = grouped.get(item) ?? { item, reviews: [] };
  entry.reviews.push(observation);
  grouped.set(item, entry);
}

const wanted = items.length === 0 ? [...grouped.values()] : items.map((key) => grouped.get(key) ?? { item: key, reviews: [] });
const census = reviewCensus(wanted);
const percent = (value: number | null): string => (value === null ? "n/a" : `${Math.round(value * 100)}%`);
const mean = (value: number | null): string => (value === null ? "n/a" : value.toFixed(2));
const recordedCount = [...byRun.values()].filter((entry) => entry.recorded).length;

if (items.length > 0) {
  for (const entry of wanted) {
    console.log(`\n${entry.item} — ${entry.reviews.length} review${entry.reviews.length === 1 ? "" : "s"}`);
    entry.reviews.forEach((review, index) => {
      const coverage =
        review.declaredCriteria === 0
          ? "no coverage recorded"
          : `${review.declaredCriteria - review.unexamined}/${review.declaredCriteria} criteria examined`;
      console.log(`  round ${String(index + 1).padStart(2)}: ${review.verdict.padEnd(16)} ${review.blockingIssues} blocking issue(s), ${coverage}`);
    });
  }
}

console.log(`\n${dbPath}${sinceRaw === undefined ? "" : ` — reviews since ${sinceRaw}`}`);
console.log(`  tickets reviewed        ${census.items}`);
console.log(`  reviews                 ${census.reviews}  (${recordedCount} with a recorded review_verdict row, the rest replayed from raw results)`);
console.log(`  approvals / rejections  ${census.approvals} / ${census.rejections}${census.needsInput > 0 ? ` (+${census.needsInput} needs_user_input)` : ""}`);
console.log(`  rounds per ticket       ${mean(census.roundsPerItem)}  (worst ${census.maxRounds})`);
console.log(`  issues per rejection    ${mean(census.issuesPerRejection)}`);
console.log(`  exactly one issue       ${census.singleIssue} of ${census.rejections} — ${percent(census.singleIssueShare)}   <- the figure reviewer.md quotes`);
for (const bucket of census.issueHistogram) {
  console.log(`      ${String(bucket.issues).padStart(2)} issue(s): ${bucket.rejections}`);
}
// Zero until EO-200's reviews start landing; that is the point of
// printing it rather than hiding it behind a "no data" branch. A run
// that shows 0 of 0 is telling you the change has not been exercised
// yet, which is a different thing from telling you it did not work.
console.log(`  full-coverage rejections ${census.fullCoverage} of ${census.rejectionsWithCriteria} — ${percent(census.fullCoverageShare)}`);
console.log("");
