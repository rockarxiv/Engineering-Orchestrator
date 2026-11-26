import { MAX_MEMORY_NOTE_CHARS, MemoryConsolidationAnswerSchema, type MemoryConsolidationAnswer, type MemoryEntryView } from "@eo/core";
import { describe, expect, it } from "vitest";
import type { ScopeConsolidationState, ScopeTally } from "../db/repos/memoryConsolidationsRepo.js";
import {
  CONSOLIDATION_BACKOFF_MS,
  CONSOLIDATION_BUDGET_RETRY_MS,
  CONSOLIDATION_CHANGED_RETRY_MS,
  CONSOLIDATION_DEFERRED_REASON,
  CONSOLIDATION_PAUSED_REASON,
  checkRewriteReasons,
  consolidationAnswerSchema,
  droppedRewritesNote,
  namesNewerEntry,
  quotesRepositoryFile,
  replacesRelativeDate,
  rewriteReasonProblem,
  consolidationDue,
  consolidationInput,
  crossBatchMergeInput,
  MEMORY_CONSOLIDATE_SYSTEM,
  MEMORY_CROSS_BATCH_MERGE_SYSTEM,
  MEMORY_PROPOSE_SKILLS_SYSTEM,
  retryAt,
  skillProposalsAnswerSchema,
  skillProposalsInput,
  stuckNoticeBody,
  stuckNoticeOwed,
} from "./consolidation.js";

/** When a scope is due a consolidation, and what it is held to (EO-480). Pure, with a fake clock. */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

function tally(overrides: Partial<ScopeTally> = {}): ScopeTally {
  return {
    scope: { kind: "workspace", id: "w" },
    agentEntries: 10,
    agentChars: 1_000,
    personEntries: 0,
    personChars: 0,
    oldestAgentAt: NOW - 10 * DAY,
    ...overrides,
  };
}

function state(overrides: Partial<ScopeConsolidationState> = {}): ScopeConsolidationState {
  return { lastConsolidatedAt: null, settled: null, failuresSince: [], running: false, ...overrides };
}

/** One failed consolidation, as `failuresSince` lists it: on the schedule unless said otherwise. */
function failure(finishedAt: number, reason: string | null, overrides: Partial<ScopeConsolidationState["failuresSince"][number]> = {}): ScopeConsolidationState["failuresSince"][number] {
  return { id: `failure-${finishedAt}`, trigger: "schedule", finishedAt, reason, note: null, stuckNoticed: false, ...overrides };
}

/** Consolidated at `at`. */
function settled(at: number): ScopeConsolidationState {
  return state({ lastConsolidatedAt: at, settled: { at } });
}

/** Whether it is due, and what it asked to know: when runs were counted from, and how many times it counted new entries. */
function due(input: { tally?: ScopeTally; state?: ScopeConsolidationState; now?: number; runs?: number; fresh?: number }) {
  const asked: number[] = [];
  let freshAsked = 0;
  const decision = consolidationDue({
    tally: input.tally ?? tally(),
    state: input.state ?? state(),
    now: input.now ?? NOW,
    runsDeliveredSince: (since) => {
      asked.push(since);
      return input.runs ?? 0;
    },
    newEntries: () => {
      freshAsked += 1;
      return input.fresh ?? 1;
    },
  });
  return { decision, asked, freshAsked };
}

describe("when a scope is due a consolidation (EO-480)", () => {
  describe("on the schedule", () => {
    it("is due more than 24 hours after the last one, with at least five runs given its memory since and an entry new since it", () => {
      const last = NOW - DAY - 1;
      const { decision, asked } = due({ state: settled(last), runs: 5 });
      expect(decision).toEqual({ kind: "consolidate", trigger: "schedule" });
      expect(asked).toEqual([last]);
    });

    it("is not due with fewer than five runs since", () => {
      expect(due({ state: settled(NOW - 3 * DAY), runs: 4 }).decision).toEqual({ kind: "none" });
    });

    it("is not due when the last one was 24 hours ago or less, however many runs there were — and does not read run events to know it", () => {
      const { decision, asked } = due({ state: settled(NOW - DAY), runs: 50 });
      expect(decision).toEqual({ kind: "none" });
      expect(asked).toEqual([]);
      expect(due({ state: settled(NOW - HOUR), runs: 50 }).decision).toEqual({ kind: "none" });
    });

    it("is not due for a scope with no entry written or changed since its last consolidation, and asks that last (EO-913)", () => {
      expect(due({ state: settled(NOW - 3 * DAY), runs: 50, fresh: 0 }).decision).toEqual({ kind: "none" });
      // Not asked while the day or the runs already say no.
      expect(due({ state: settled(NOW - HOUR), runs: 50 }).freshAsked).toBe(0);
      expect(due({ state: settled(NOW - 3 * DAY), runs: 4 }).freshAsked).toBe(0);
    });

    it("counts from the oldest agent-written entry in a scope never consolidated", () => {
      expect(due({ runs: 5 }).asked).toEqual([NOW - 10 * DAY]);
      expect(due({ tally: tally({ oldestAgentAt: NOW - 12 * HOUR }), runs: 5 }).decision).toEqual({ kind: "none" });
    });

    it("is never due for a scope holding only people's entries", () => {
      const people = tally({ agentEntries: 0, agentChars: 0, oldestAgentAt: null, personEntries: 5, personChars: 300 });
      expect(due({ tally: people, runs: 50 }).decision).toEqual({ kind: "none" });
    });
  });

  describe("never for its size (EO-913)", () => {
    it("is not due for a scope far over the old caps of 200 entries or 40,000 characters, whoever wrote them", () => {
      for (const big of [
        tally({ agentEntries: 400, agentChars: 20_000 }),
        tally({ agentEntries: 135, agentChars: 58_956 }),
        tally({ agentEntries: 150, agentChars: 30_000, personEntries: 100, personChars: 15_000 }),
        tally({ agentEntries: 1, agentChars: 100, personEntries: 500, personChars: 90_000 }),
      ]) {
        // Never consolidated, consolidated an hour ago, with new entries or none: size is no reason.
        expect(due({ tally: big, state: settled(NOW - HOUR) }).decision).toEqual({ kind: "none" });
        expect(due({ tally: big, state: settled(NOW - HOUR), fresh: 50 }).decision).toEqual({ kind: "none" });
        expect(due({ tally: big, state: settled(NOW - 3 * DAY), runs: 50, fresh: 0 }).decision).toEqual({ kind: "none" });
        expect(due({ tally: { ...big, oldestAgentAt: NOW - HOUR } }).decision).toEqual({ kind: "none" });
      }
    });

    it("is, for the same large scope, due on the schedule as any other once its day, its runs and a new entry have come", () => {
      expect(due({ tally: tally({ agentEntries: 400, agentChars: 80_000 }), state: settled(NOW - 3 * DAY), runs: 5 }).decision).toEqual({ kind: "consolidate", trigger: "schedule" });
    });
  });

  describe("a run that stopped part-way (EO-574)", () => {
    it("is due on the schedule, once its backoff is over, without another day or five more runs — while an entry it was to be given is still new", () => {
      // The first batch succeeded at NOW - HOUR, which made it the last consolidation; the second failed a minute later.
      const partway = state({ ...settled(NOW - HOUR), failuresSince: [failure(NOW - HOUR + 60_000, "error")] });
      const retry = NOW - HOUR + 60_000 + HOUR;
      expect(due({ state: partway, now: retry - 1 }).decision).toEqual({ kind: "none" });
      const after = due({ state: partway, now: retry, runs: 0 });
      expect(after.decision).toEqual({ kind: "consolidate", trigger: "schedule" });
      expect(after.asked).toEqual([]);
      // Nothing left new: nothing to take up.
      expect(due({ state: partway, now: retry, fresh: 0 }).decision).toEqual({ kind: "none" });
      // Finished, the same scope waits for the day and the runs as before.
      expect(due({ state: settled(NOW - HOUR), now: retry, runs: 0 }).decision).toEqual({ kind: "none" });
    });

    it("goes on as a person's consolidation where a person's one stopped part-way, new entries or none", () => {
      const partway = state({ ...settled(NOW - HOUR), failuresSince: [failure(NOW - HOUR + 60_000, "error", { trigger: "manual" })] });
      expect(due({ state: partway, now: NOW + HOUR, fresh: 0 }).decision).toEqual({ kind: "consolidate", trigger: "manual" });
    });

    it("is never one for a cap consolidation from before EO-913 that stopped part-way: that scope waits for its day and five runs (EO-913)", () => {
      const partway = state({ ...settled(NOW - HOUR), failuresSince: [failure(NOW - HOUR + 60_000, "error", { trigger: "cap" })] });
      expect(due({ state: partway, now: NOW + HOUR, runs: 0 }).decision).toEqual({ kind: "none" });
      expect(due({ state: partway, now: NOW - HOUR + DAY + 1, runs: 5 }).decision).toEqual({ kind: "consolidate", trigger: "schedule" });
    });

    it("is not one for a failure from before the scope was settled — a restore since, say", () => {
      const restoredSince = state({ ...settled(NOW - HOUR), failuresSince: [failure(NOW - 2 * HOUR, "error")] });
      expect(due({ state: restoredSince }).decision).toEqual({ kind: "none" });
    });
  });

  describe("after a failure", () => {
    it("backs off an hour after the first failure in a row, four hours after the second, and a day after the third and every one after it (fake clock, EO-577)", () => {
      // Each failure finished at NOW; the ones before it a day apart.
      const failed = (count: number, reason = "schema") => state({ failuresSince: Array.from({ length: count }, (_, at) => failure(NOW - at * DAY, reason)) });
      expect(CONSOLIDATION_BACKOFF_MS).toEqual([HOUR, 4 * HOUR, DAY]);
      for (const [count, wait] of [[1, HOUR], [2, 4 * HOUR], [3, DAY], [4, DAY], [30, DAY]] as const) {
        expect(retryAt(failed(count)), `after ${count}`).toBe(NOW + wait);
        expect(due({ state: failed(count), now: NOW + wait - 1, runs: 5 }).decision, `after ${count}`).toEqual({ kind: "none" });
        expect(due({ state: failed(count), now: NOW + wait, runs: 5 }).decision, `after ${count}`).toEqual({ kind: "consolidate", trigger: "schedule" });
      }
      // A timeout — a call cut off at its time limit or its output-token cap — backs off like any other.
      expect(retryAt(failed(2, "timeout"))).toBe(NOW + 4 * HOUR);
      // Not once per look: every minute in between, it is not due.
      for (let at = NOW; at < NOW + HOUR; at += 60_000) expect(due({ state: failed(1), now: at, runs: 5 }).decision).toEqual({ kind: "none" });
    });

    it("waits out a budget refusal at a steady interval rather than backing off", () => {
      const refused = state({ failuresSince: Array.from({ length: 6 }, (_, at) => failure(NOW - at * HOUR, "budget")) });
      expect(due({ state: refused, now: NOW + CONSOLIDATION_BUDGET_RETRY_MS - 1, runs: 5 }).decision).toEqual({ kind: "none" });
      expect(due({ state: refused, now: NOW + CONSOLIDATION_BUDGET_RETRY_MS, runs: 5 }).decision).toEqual({ kind: "consolidate", trigger: "schedule" });
    });

    it("asks again a minute after one stopped by pausing EO, without counting it as the backend failing (EO-514)", () => {
      const paused = state({
        failuresSince: [
          failure(NOW, CONSOLIDATION_PAUSED_REASON),
          failure(NOW - HOUR, CONSOLIDATION_PAUSED_REASON),
          failure(NOW - 2 * HOUR, CONSOLIDATION_PAUSED_REASON),
        ],
      });
      expect(due({ state: paused, now: NOW + CONSOLIDATION_CHANGED_RETRY_MS - 1, runs: 5 }).decision).toEqual({ kind: "none" });
      expect(due({ state: paused, now: NOW + CONSOLIDATION_CHANGED_RETRY_MS, runs: 5 }).decision).toEqual({ kind: "consolidate", trigger: "schedule" });
      // …and a real failure after pauses backs off from the first step, not the fourth.
      const thenFailed = state({ failuresSince: [failure(NOW, "schema"), ...paused.failuresSince] });
      expect(due({ state: thenFailed, now: NOW + HOUR, runs: 5 }).decision).toEqual({ kind: "consolidate", trigger: "schedule" });
    });

    it("asks again a minute after a batch that gave way to pipeline work, without counting it as a failure (EO-577)", () => {
      const deferred = state({ failuresSince: [failure(NOW, CONSOLIDATION_DEFERRED_REASON), failure(NOW - HOUR, "schema")] });
      expect(due({ state: deferred, now: NOW + CONSOLIDATION_CHANGED_RETRY_MS - 1, runs: 5 }).decision).toEqual({ kind: "none" });
      expect(due({ state: deferred, now: NOW + CONSOLIDATION_CHANGED_RETRY_MS, runs: 5 }).decision).toEqual({ kind: "consolidate", trigger: "schedule" });
      // The failure before it is still the first of its run: the next one backs off four hours, not a day.
      const thenFailed = state({ failuresSince: [failure(NOW + HOUR, "timeout"), ...deferred.failuresSince] });
      expect(retryAt(thenFailed)).toBe(NOW + HOUR + 4 * HOUR);
    });

    it("owes the note saying it is stuck at the third failure in a row, once, and again only after a success has ended the run (EO-577)", () => {
      const run = (count: number, overrides: Partial<ScopeConsolidationState["failuresSince"][number]> = {}) =>
        Array.from({ length: count }, (_, at) => failure(NOW - at * DAY, "schema", at === 0 ? overrides : {}));
      expect(stuckNoticeOwed(state({ failuresSince: run(2) }))).toBeNull();
      expect(stuckNoticeOwed(state({ failuresSince: run(3) }))).toMatchObject({ id: `failure-${NOW}` });
      // Said at the third: not at the fourth, nor the tenth.
      const said = [failure(NOW, "schema"), ...run(3).map((entry, at) => (at === 0 ? { ...entry, finishedAt: NOW - DAY / 2, id: "third", stuckNoticed: true } : entry))];
      expect(stuckNoticeOwed(state({ failuresSince: said }))).toBeNull();
      // Waits for something else are not failures: three of them, or two failures and a pause, are not stuck.
      expect(stuckNoticeOwed(state({ failuresSince: [failure(NOW, "budget"), failure(NOW - 1, CONSOLIDATION_PAUSED_REASON), failure(NOW - 2, CONSOLIDATION_DEFERRED_REASON)] }))).toBeNull();
      expect(stuckNoticeOwed(state({ failuresSince: [failure(NOW, CONSOLIDATION_PAUSED_REASON), ...run(2)] }))).toBeNull();
      // A success ends the run — `failuresSince` starts again from it — so three more are owed the note again.
      expect(stuckNoticeOwed(state({ failuresSince: run(3) }))).not.toBeNull();
    });

    it("names the scope, what it holds and the last failure's reason in the note, and no cap", () => {
      const body = stuckNoticeBody({
        scopeLabel: 'the project "EO"',
        tally: tally({ agentEntries: 105, agentChars: 54_000, personEntries: 6, personChars: 2_000 }),
        failures: 3,
        last: { reason: "schema", note: "The answer did not match the shape asked for." },
        retryAt: Date.parse("2026-10-27T09:30:00Z"),
      });
      expect(body).toContain('Memory consolidation of the project "EO" is stuck: it has failed 3 times in a row.');
      expect(body).toContain("111 entries, 56,000 characters");
      expect(body).not.toMatch(/cap/);
      expect(body).toContain("`schema` — The answer did not match the shape asked for.");
      expect(body).toContain("2026-10-27 09:30 UTC");
      expect(body).toContain("no delivery waits on this");
    });

    it("is never due while one is running", () => {
      expect(due({ state: state({ running: true }), runs: 50 }).decision).toEqual({ kind: "none" });
    });
  });
});

describe("the operations a consolidation answers with (EO-573)", () => {
  const sent = [
    { id: "a", body: "Tests need Postgres 15." },
    { id: "b", body: "Tests need Postgres 16 since yesterday." },
    { id: "c", body: "The ledger is in UTC." },
    { id: "d", body: "Run `pnpm test` before pushing." },
  ];
  const schema = consolidationAnswerSchema(sent);
  const answer = (overrides: Record<string, unknown> = {}) => ({ retire: [], merge: [], rewrite: [], ...overrides });
  const accepts = (value: unknown) => schema.safeParse(value).success;

  it("has retire, merge and rewrite, a merge folding at least two entries, and an entry not named stays as it is", () => {
    const value = answer({
      retire: [{ id: "a", reason: "Contradicted by b, which is newer." }],
      merge: [{ from: ["b", "c"], body: "Tests need Postgres 16 (since 2026-10-25). The ledger is in UTC.", contradictsRepositoryFile: false }],
    });
    expect(accepts(value)).toBe(true);

    expect(accepts(answer({ rewrite: [{ id: "b", body: "Tests need Postgres 16 (2026-10-25).", contradictsRepositoryFile: false, reason: "relative_date" }] }))).toBe(true);
    expect(accepts(answer({ merge: [{ from: ["b"], body: "Postgres 16.", contradictsRepositoryFile: false }] }))).toBe(false);
    expect(accepts(answer({ merge: [{ from: [], body: "Postgres 16.", contradictsRepositoryFile: false }] }))).toBe(false);
    expect(accepts(answer({ retire: [{ id: "a", reason: "" }] }))).toBe(false);
    expect(accepts(answer({ rewrite: [{ id: "a", body: "   ", contradictsRepositoryFile: false, reason: "relative_date" }] }))).toBe(false);
    // The whole set, the old shape, is not an answer.
    expect(accepts({ entries: [{ body: "One.", from: ["a"], contradictsRepositoryFile: false }] })).toBe(false);
  });

  it("refuses an id it was not sent — a person's entry among them — in any of the three operations", () => {
    // A person's entry is never sent, so its id is one the call does not know.
    const personsEntry = "person-entry";
    for (const id of ["made-up", personsEntry]) {
      expect(accepts(answer({ retire: [{ id, reason: "Stale." }] }))).toBe(false);
      expect(accepts(answer({ merge: [{ from: ["a", id], body: "Merged.", contradictsRepositoryFile: false }] }))).toBe(false);
      expect(accepts(answer({ rewrite: [{ id, body: "Rewritten.", contradictsRepositoryFile: false, reason: "relative_date" }] }))).toBe(false);
    }
  });

  it("refuses an entry named twice, within one operation or across two", () => {
    expect(accepts(answer({ merge: [{ from: ["a", "a"], body: "Merged.", contradictsRepositoryFile: false }] }))).toBe(false);
    expect(accepts(answer({ retire: [{ id: "a", reason: "Stale." }], rewrite: [{ id: "a", body: "A.", contradictsRepositoryFile: false, reason: "relative_date" }] }))).toBe(false);
    expect(
      accepts(
        answer({
          merge: [
            { from: ["a", "b"], body: "One.", contradictsRepositoryFile: false },
            { from: ["b", "c"], body: "Two.", contradictsRepositoryFile: false },
          ],
        }),
      ),
    ).toBe(false);
    expect(accepts(answer({ retire: [{ id: "a", reason: "Stale." }, { id: "a", reason: "Stale." }] }))).toBe(false);
  });

  it("takes an answer whatever it does to the size of the scope, and an empty one as a no-op (EO-913)", () => {
    // One retirement of four entries.
    expect(accepts(answer({ retire: [{ id: "c", reason: "Derivable from the code." }] }))).toBe(true);
    // A rewrite that makes an entry longer, as an absolute date does, is no reason to refuse it.
    expect(accepts(answer({ rewrite: [{ id: "b", body: "Tests need Postgres 16 since 2026-10-24, when it replaced 15.", contradictsRepositoryFile: false, reason: "relative_date" }] }))).toBe(true);
    // Only flagging an entry that corrects the repository file.
    expect(accepts(answer({ rewrite: [{ id: "c", body: "The ledger is in UTC.", contradictsRepositoryFile: true, reason: "repository_file" }] }))).toBe(true);
    // Nothing to change.
    expect(schema.safeParse(answer())).toMatchObject({ success: true, data: { retire: [], merge: [], rewrite: [] } });
  });

  it("refuses a rewrite without a reason from its list, so one that only shortens an entry cannot be applied (EO-913)", () => {
    const shorter = { id: "d", body: "Run `pnpm test` first.", contradictsRepositoryFile: false };
    for (const reason of ["relative_date", "repository_file", "newer_entry"]) expect(accepts(answer({ rewrite: [{ ...shorter, reason }] })), reason).toBe(true);
    const without = schema.safeParse(answer({ rewrite: [shorter] }));
    expect(without.success).toBe(false);
    expect(without.error?.issues.map((issue) => issue.path.join("."))).toContain("rewrite.0.reason");
    for (const reason of ["shorter", "tidied", "", null]) expect(accepts(answer({ rewrite: [{ ...shorter, reason }] })), String(reason)).toBe(false);
    // Each passes the schema with a reason, and is then dropped when the reason's own test fails (checkRewriteReasons).
    const given = [{ id: "d", body: "Run `pnpm test` before pushing, and wait for it.", createdAt: 1, contradictsRepositoryFile: false }];
    for (const reason of ["relative_date", "repository_file", "newer_entry"] as const) {
      const checked = checkRewriteReasons(answer({ rewrite: [{ ...shorter, reason }] }) as MemoryConsolidationAnswer, { given, repositoryFiles: [{ name: "CLAUDE.md", text: "Run `pnpm test` before pushing.\n" }] });
      expect(checked.answer.rewrite, reason).toEqual([]);
      expect(checked.dropped.map((drop) => drop.id), reason).toEqual(["d"]);
    }
    // One rewrite without a reason refuses the whole answer, whatever else it holds.
    expect(accepts(answer({ retire: [{ id: "a", reason: "Stale." }], rewrite: [shorter] }))).toBe(false);
    // The shape the backend is held to says so too.
    expect(MemoryConsolidationAnswerSchema.safeParse(answer({ rewrite: [{ ...shorter, id: "anything" }] })).success).toBe(false);
  });
});

describe("how long a merged or rewritten entry may be (EO-591)", () => {
  const sent = ["a", "b", "c"].map((id) => ({ id, body: `${id} `.repeat(900) }));
  const schema = consolidationAnswerSchema(sent);
  const answer = (overrides: Record<string, unknown>) => ({ retire: [], merge: [], rewrite: [], ...overrides });
  const atLimit = "x".repeat(MAX_MEMORY_NOTE_CHARS);
  const overLimit = "x".repeat(MAX_MEMORY_NOTE_CHARS + 1);

  it(`refuses a merge or a rewrite whose body is longer than ${String(MAX_MEMORY_NOTE_CHARS)} characters, and takes one of exactly that`, () => {
    expect(MAX_MEMORY_NOTE_CHARS).toBe(1_000);
    expect(schema.safeParse(answer({ merge: [{ from: ["a", "b"], body: atLimit, contradictsRepositoryFile: false }] })).success).toBe(true);
    expect(schema.safeParse(answer({ rewrite: [{ id: "c", body: atLimit, contradictsRepositoryFile: false, reason: "relative_date" }] })).success).toBe(true);

    const merge = schema.safeParse(answer({ merge: [{ from: ["a", "b"], body: overLimit, contradictsRepositoryFile: false }] }));
    expect(merge.success).toBe(false);
    expect(merge.error?.issues.map((issue) => issue.path.join("."))).toContain("merge.0.body");
    const rewrite = schema.safeParse(answer({ rewrite: [{ id: "c", body: overLimit, contradictsRepositoryFile: false, reason: "relative_date" }] }));
    expect(rewrite.success).toBe(false);
    expect(rewrite.error?.issues.map((issue) => issue.path.join("."))).toContain("rewrite.0.body");
    // Whitespace around the body is not counted.
    expect(schema.safeParse(answer({ rewrite: [{ id: "c", body: `  ${atLimit}\n`, contradictsRepositoryFile: false, reason: "relative_date" }] })).success).toBe(true);
    // One long body refuses the whole answer, whatever else it holds.
    expect(
      schema.safeParse(
        answer({ retire: [{ id: "c", reason: "Stale." }], merge: [{ from: ["a", "b"], body: overLimit, contradictsRepositoryFile: false }] }),
      ).success,
    ).toBe(false);
    // The shape the backend is held to says so too.
    expect(MemoryConsolidationAnswerSchema.safeParse(answer({ rewrite: [{ id: "c", body: overLimit, contradictsRepositoryFile: false, reason: "relative_date" }] })).success).toBe(false);
  });

  it("tells a batch and the cross-batch pass the limit, and to merge only entries that state the same fact", () => {
    for (const prompt of [MEMORY_CONSOLIDATE_SYSTEM, MEMORY_CROSS_BATCH_MERGE_SYSTEM]) {
      expect(prompt).toContain(`Keep each entry you merge or rewrite to one fact, at most ${String(MAX_MEMORY_NOTE_CHARS)} characters`);
      expect(prompt).toMatch(/Entries about one topic that state different facts are not duplicates/);
    }
  });
});

describe("the mechanical test of each rewrite's reason (EO-913)", () => {
  const entry = (id: string, body: string, createdAt: number, contradictsRepositoryFile = false) => ({ id, body, createdAt, contradictsRepositoryFile });
  const rewrite = (id: string, body: string, reason: "relative_date" | "repository_file" | "newer_entry", contradictsRepositoryFile = false) => ({ id, body, reason, contradictsRepositoryFile });
  const FILE = { name: "CLAUDE.md", text: "# api\r\n\r\n- Run the tests with `pnpm test:api`.\r\n## Commands\r\n" };

  describe("(a) a relative date made absolute", () => {
    it("passes: a whole phrase from the list replaced by a YYYY-MM-DD date, and nothing else changed", () => {
      expect(replacesRelativeDate("The ledger moved to UTC yesterday.", "The ledger moved to UTC 2026-11-19.")).toBe(true);
      expect(replacesRelativeDate("Released 3 days ago, not 2.", "Released 2026-11-23, not 2.")).toBe(true);
      expect(replacesRelativeDate("Due in 10 days.", "Due 2026-12-06.")).toBe(true);
      expect(replacesRelativeDate("Today the API moved; NEXT WEEK the web does.", "2026-11-26 the API moved; 2026-12-03 the web does.")).toBe(true);
      // One of two phrases is enough.
      expect(replacesRelativeDate("Today the API moved; next week the web does.", "2026-11-26 the API moved; next week the web does.")).toBe(true);
      for (const phrase of ["today", "yesterday", "tomorrow", "this week", "last week", "next week", "this month", "last month", "next month", "4 days ago", "1 week ago", "2 weeks ago", "in 1 day"]) {
        expect(replacesRelativeDate(`Changed ${phrase}.`, "Changed 2026-11-01."), phrase).toBe(true);
      }
    });

    it("fails: anything else changed, no phrase from the list, part of a longer number, or no real date", () => {
      // Shortened as well.
      expect(replacesRelativeDate("The ledger moved to UTC yesterday.", "Ledger moved to UTC 2026-11-19.")).toBe(false);
      // Words around the phrase changed.
      expect(replacesRelativeDate("Due in 10 days.", "Due on 2026-12-06.")).toBe(false);
      // Nothing from the list in the original: "recently" and "two days ago" are not on it.
      expect(replacesRelativeDate("Changed recently.", "Changed 2026-11-01.")).toBe(false);
      expect(replacesRelativeDate("Changed two days ago.", "Changed 2026-11-24.")).toBe(false);
      // Part of a word, or of a longer number, is not a whole phrase.
      expect(replacesRelativeDate("Use todays build.", "Use 2026-11-26s build.")).toBe(false);
      expect(replacesRelativeDate("This was added 1,000 days ago.", "This was added 1,2026-11-26.")).toBe(false);
      // Not a YYYY-MM-DD date, or not a real one.
      expect(replacesRelativeDate("Changed yesterday.", "Changed 25 Nov 2026.")).toBe(false);
      expect(replacesRelativeDate("Changed yesterday.", "Changed 2026-02-30.")).toBe(false);
      expect(replacesRelativeDate("Changed yesterday.", "Changed 2026-13-01.")).toBe(false);
      // The phrase left as it was: nothing replaced.
      expect(replacesRelativeDate("Changed yesterday.", "Changed yesterday.")).toBe(false);
    });

    it("holds the flag to what it was", () => {
      const given = [entry("a", "Moved yesterday.", 1)];
      expect(rewriteReasonProblem(rewrite("a", "Moved 2026-11-25.", "relative_date"), { given, repositoryFiles: [] })).toBeNull();
      expect(rewriteReasonProblem(rewrite("a", "Moved 2026-11-25.", "relative_date", true), { given, repositoryFiles: [] })).toMatch(/flag/);
    });
  });

  describe("(b) a disagreement with the repository file", () => {
    it("passes: the rewrite names the file and quotes a line of it as delivered, with or without its list marker, CRLF or not", () => {
      expect(quotesRepositoryFile("CLAUDE.md says to run the tests with `make test`, not \"- Run the tests with `pnpm test:api`.\"", [FILE])).toBe(true);
      expect(quotesRepositoryFile("As CLAUDE.md says: Run the tests with `pnpm test:api`.", [FILE])).toBe(true);
    });

    it("fails: a file not named, a line not quoted word for word, a line too short to be a quote, or a file never delivered", () => {
      // Quotes the line but names no file.
      expect(quotesRepositoryFile("Run the tests with `pnpm test:api`.", [FILE])).toBe(false);
      // Names the file, quotes nothing of it word for word.
      expect(quotesRepositoryFile("CLAUDE.md says to run the API tests with pnpm.", [FILE])).toBe(false);
      // A heading of two words is no quote.
      expect(quotesRepositoryFile("CLAUDE.md, ## Commands: use make.", [FILE])).toBe(false);
      // Names a file the call was not given: the cross-batch pass is given none.
      expect(quotesRepositoryFile("AGENTS.md says: Run the tests with `pnpm test:api`.", [FILE])).toBe(false);
      expect(quotesRepositoryFile("CLAUDE.md says: Run the tests with `pnpm test:api`.", [])).toBe(false);
    });
  });

  describe("(c) a correction by a newer entry", () => {
    const given = [entry("old", "Tests need Postgres 15.", 1_000), entry("older", "Tests need Postgres 14.", 500), entry("new", "Tests need Postgres 16.", 2_000)];
    it("passes: the rewrite names the id of an entry of the same call written after it", () => {
      expect(namesNewerEntry(given[0]!, "Tests need Postgres 16, as new says.", given)).toBe(true);
    });

    it("fails: an older entry, the entry itself, or one the call was not given", () => {
      expect(namesNewerEntry(given[0]!, "Tests need Postgres 14, as older says.", given)).toBe(false);
      expect(namesNewerEntry(given[0]!, "Tests need Postgres 15, as old says.", given)).toBe(false);
      expect(namesNewerEntry(given[0]!, "Tests need Postgres 17, as elsewhere says.", given)).toBe(false);
    });
  });

  it("drops each rewrite that fails its test, keeps the rest of the answer, and says which on the row", () => {
    const given = [entry("a", "Moved yesterday.", 1), entry("b", "Run pnpm test before pushing, always.", 2), entry("c", "Use Postgres 16 for tests.", 3)];
    const checked = checkRewriteReasons(
      {
        retire: [{ id: "c", reason: "Stale." }],
        merge: [],
        rewrite: [rewrite("a", "Moved 2026-11-25.", "relative_date"), rewrite("b", "Run pnpm test first.", "repository_file")],
      },
      { given, repositoryFiles: [FILE] },
    );
    expect(checked.answer).toEqual({ retire: [{ id: "c", reason: "Stale." }], merge: [], rewrite: [rewrite("a", "Moved 2026-11-25.", "relative_date")] });
    expect(checked.dropped).toEqual([{ id: "b", reason: "repository_file", problem: expect.stringMatching(/repository file/) }]);
    expect(droppedRewritesNote(checked.dropped)).toMatch(/^1 rewrite was dropped .* b \(`repository_file`: /);
    expect(droppedRewritesNote([])).toBeNull();
  });
});

describe("what a consolidation is told (EO-573, EO-913)", () => {
  it("asks for the changes only, and says the rules: merge entries stating the same fact; retire the stale, the contradicted and the derivable; absolute dates; the repository files", () => {
    const prompt = MEMORY_CONSOLIDATE_SYSTEM;
    expect(prompt).toMatch(/Name only what changes: an entry you do not mention stays exactly as it is/);
    for (const operation of ["`retire`: `{ id, reason }`", "`merge`: `{ from, body, contradictsRepositoryFile }`", "`rewrite`: `{ id, body, reason, contradictsRepositoryFile }`"]) {
      expect(prompt).toContain(operation);
    }
    expect(prompt).toMatch(/`from` holds at least two ids/);
    expect(prompt).toMatch(/all three lists empty; that is a valid answer/);
    expect(prompt).toMatch(/Merge entries that state the same fact into one/);
    expect(prompt).toMatch(/Retire what is stale, contradicted by a newer entry, or derivable from the code/);
    expect(prompt).toMatch(/Write relative dates .* as absolute dates/);
    expect(prompt).toMatch(/CLAUDE\.md or AGENTS\.md is given .* treat it as current/);
    expect(prompt).toMatch(/set(ting)? contradictsRepositoryFile to true/);
    expect(prompt).toMatch(/Never suggest editing the file/);
    // Nothing of the old whole-set answer is left in it.
    expect(prompt).not.toMatch(/Return a smaller set of entries/);
    expect(prompt).not.toMatch(/return its text unchanged/);
  });

  it("names the reasons a rewrite may give and no other, and asks for nothing because of size", () => {
    for (const prompt of [MEMORY_CONSOLIDATE_SYSTEM, MEMORY_CROSS_BATCH_MERGE_SYSTEM]) {
      for (const reason of ["`relative_date`", "`repository_file`", "`newer_entry`"]) expect(prompt).toContain(reason);
      expect(prompt).toMatch(/never rewrite one only to shorten it, reword it or tidy its style/);
      expect(prompt).toMatch(/How many entries there are, and how long they are, is no reason to change any of them/);
      expect(prompt).not.toMatch(/smaller|target|never larger|reduction/i);
    }
  });

  it("gives no target, whole or batch, and no size to reach", () => {
    const entry = { id: "a", scope: { kind: "workspace", id: "w" }, body: "Entry a.", source: { type: "run", runId: null, itemId: null }, createdAt: 0, updatedAt: 0, retiredAt: null, retiredReason: null, consolidationId: null, contradictsRepositoryFile: false } as MemoryEntryView;
    const inputs = [
      consolidationInput({ scopeLabel: "w", entries: [entry], repositoryFiles: [], now: 0 }),
      consolidationInput({ scopeLabel: "w", entries: [entry], batch: { index: 1, count: 2, scopeEntries: 2, scopeChars: 16 }, repositoryFiles: [], now: 0 }),
      consolidationInput({ scopeLabel: "w", entries: [entry], batch: { index: 1, count: 1, scopeEntries: 2, scopeChars: 16, fresh: new Set(["a"]) }, repositoryFiles: [], now: 0 }),
      crossBatchMergeInput({ scopeLabel: "w", groups: [[entry, { ...entry, id: "b" }]], now: 0 }),
    ];
    for (const input of inputs) expect(input).not.toMatch(/target|reduction|about half/i);
  });
});

describe("a consolidation's answer carries no skills (EO-575)", () => {
  it("has the three operations and nothing else, and its prompt says nothing of skills", () => {
    expect(Object.keys(MemoryConsolidationAnswerSchema.shape).sort()).toEqual(["merge", "retire", "rewrite"]);
    const schema = consolidationAnswerSchema([{ id: "a", body: "Entry a." }]);
    const parsed = schema.parse({ retire: [], merge: [], rewrite: [], skills: [{ slug: "run-e2e" }] });
    expect(parsed).toEqual({ retire: [], merge: [], rewrite: [] });
    expect(MEMORY_CONSOLIDATE_SYSTEM).not.toMatch(/skill/i);
  });
});

describe("what the skill proposal call is told (EO-575)", () => {
  const scope = { kind: "workspace" as const, id: "w" };
  const entry = (id: string, body: string, itemId: string | null) =>
    ({ id, body, createdAt: NOW, contradictsRepositoryFile: false, source: { type: "run", runId: null, itemId } }) as unknown as Parameters<typeof skillProposalsInput>[0]["entries"][number];

  it("is given the scope, its entries' ids, bodies and items, the existing skills and every discarded proposal", () => {
    const input = skillProposalsInput({
      scopeLabel: 'the workspace "api"',
      scope,
      entries: [entry("a", "Run `pnpm e2e` under Xvfb.", "item-1"), entry("b", "The ledger is in UTC.", null)],
      skills: [{ id: "skill-1", slug: "run-tests", description: "Run the tests.", scopeLabel: "global", body: "## Steps\nRun them." }],
      discarded: [{ slug: "release", description: "Cut a release." }],
      now: NOW,
    });
    expect(input).toContain('"kind":"workspace","id":"w"');
    expect(input).toContain("### a (written");
    expect(input).toContain("from item item-1");
    expect(input).toContain("Run `pnpm e2e` under Xvfb.");
    expect(input).toContain("### b (written");
    expect(input).toContain("## Existing skills");
    expect(input).toContain("### run-tests (global)");
    expect(input).toContain("## Skill proposals a person discarded");
    expect(input).toContain("- `release`: Cut a release.");
  });

  it("asks for at most three skills in the existing proposal shape, and none when there is none", () => {
    expect(MEMORY_PROPOSE_SKILLS_SYSTEM).toMatch(/up to 3 skills in `skills`/);
    expect(MEMORY_PROPOSE_SKILLS_SYSTEM).toMatch(/`skills` empty/);
    for (const section of ["## Trigger", "## Steps", "## Verification"]) expect(MEMORY_PROPOSE_SKILLS_SYSTEM).toContain(section);
    expect(MEMORY_PROPOSE_SKILLS_SYSTEM).toMatch(/Never propose again what a person discarded/);
  });
});

describe("the skills the skill proposal call may propose (EO-483, EO-575)", () => {
  const scope = { kind: "workspace" as const, id: "w" };
  const facts = { scope, sourceItems: new Map<string, string | null>([["a", "item-1"], ["b", "item-2"], ["c", null]]) };
  const schema = skillProposalsAnswerSchema(
    ["a", "b", "c"].map((id) => ({ id })),
    facts,
  );
  const BODY = "## Trigger\nWhen the e2e suite runs.\n\n## Steps\n1. `pnpm e2e`.\n\n## Verification\nEvery spec passes.";
  const skill = (overrides: Record<string, unknown> = {}) => ({
    kind: "new",
    slug: "run-e2e",
    name: "Run e2e",
    description: "Run this repository's e2e suite.",
    scope,
    evidence: { entryIds: ["a", "b"], itemIds: ["item-1", "item-2"] },
    body: BODY,
    ...overrides,
  });
  const accepts = (skills: unknown[] | undefined) => schema.safeParse(skills === undefined ? {} : { skills }).success;

  it("is a list, empty when there is nothing to propose, of at most three proposals with every field the story names", () => {
    expect(accepts(undefined)).toBe(false);
    expect(accepts([])).toBe(true);
    expect(accepts([skill()])).toBe(true);
    expect(accepts([skill({ slug: "one" }), skill({ slug: "two" }), skill({ slug: "three" })])).toBe(true);
    expect(accepts([skill({ slug: "one" }), skill({ slug: "two" }), skill({ slug: "three" }), skill({ slug: "four" })])).toBe(false);
    for (const field of ["kind", "slug", "description", "scope", "evidence", "body"]) {
      const without: Record<string, unknown> = skill();
      delete without[field];
      expect(accepts([without])).toBe(false);
    }
  });

  it("refuses an improvement without a target, and holds an improvement's slug to its target's", () => {
    expect(accepts([skill({ kind: "improvement" })])).toBe(false);
    expect(accepts([skill({ kind: "improvement", target: "run-e2e" })])).toBe(true);
    expect(accepts([skill({ kind: "improvement", target: "run-tests" })])).toBe(false);
  });

  it("holds the draft to its Trigger, Steps and Verification sections, and the description to one line", () => {
    for (const section of ["Trigger", "Steps", "Verification"]) {
      expect(accepts([skill({ body: BODY.replace(`## ${section}`, `**${section}**`) })])).toBe(false);
    }
    expect(accepts([skill({ description: "Run the e2e suite.\nAnd more." })])).toBe(false);
    expect(accepts([skill({ slug: "Run E2E" })])).toBe(false);
  });

  it("checks what its schema cannot say: the scope being consolidated, evidence it was given and the items it came from, one slug once", () => {
    expect(accepts([skill({ scope: { kind: "project", id: "p" } })])).toBe(false);
    expect(accepts([skill({ evidence: { entryIds: ["made-up"], itemIds: [] } })])).toBe(false);
    expect(accepts([skill({ evidence: { entryIds: ["a"], itemIds: ["item-2"] } })])).toBe(false);
    expect(accepts([skill({ evidence: { entryIds: ["c"], itemIds: [] } })])).toBe(true);
    expect(accepts([skill(), skill()])).toBe(false);
  });
});
