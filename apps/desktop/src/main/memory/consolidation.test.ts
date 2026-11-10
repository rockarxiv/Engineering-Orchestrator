import { MAX_MEMORY_NOTE_CHARS, MemoryConsolidationAnswerSchema, type MemoryConsolidationOperations, type MemoryEntryView } from "@eo/core";
import { describe, expect, it } from "vitest";
import type { ScopeConsolidationState, ScopeTally } from "../db/repos/memoryConsolidationsRepo.js";
import {
  CONSOLIDATION_BACKOFF_MS,
  CONSOLIDATION_BUDGET_RETRY_MS,
  CONSOLIDATION_CHANGED_RETRY_MS,
  CONSOLIDATION_DEFERRED_REASON,
  CONSOLIDATION_PAUSED_REASON,
  consolidationAnswerSchema,
  consolidationChange,
  consolidationDue,
  consolidationInput,
  consolidationTargets,
  crossBatchMergeInput,
  growsScope,
  MEMORY_CONSOLIDATE_SYSTEM,
  MEMORY_CROSS_BATCH_MERGE_SYSTEM,
  MEMORY_PROPOSE_SKILLS_SYSTEM,
  retryAt,
  skillProposalsAnswerSchema,
  skillProposalsInput,
  stuckNoticeBody,
  stuckNoticeOwed,
  type MemoryCaps,
} from "./consolidation.js";

/** When a scope is due a consolidation, and what it is held to (EO-480). Pure, with a fake clock. */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;
const CAPS: MemoryCaps = { maxEntries: 200, maxChars: 40_000 };

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
  return { lastConsolidatedAt: null, settled: null, changedSinceSettled: true, failuresSince: [], running: false, ...overrides };
}

/** One failed consolidation, as `failuresSince` lists it. */
function failure(finishedAt: number, reason: string | null, overrides: Partial<ScopeConsolidationState["failuresSince"][number]> = {}): ScopeConsolidationState["failuresSince"][number] {
  return { id: `failure-${finishedAt}`, finishedAt, reason, note: null, stuckNoticed: false, ...overrides };
}

/** Consolidated at `at` under the default caps; `changed` says whether anything was written since. */
function settled(at: number, changed: boolean, caps: MemoryCaps = CAPS): ScopeConsolidationState {
  return state({ lastConsolidatedAt: at, settled: { at, caps }, changedSinceSettled: changed });
}

function due(input: { tally?: ScopeTally; state?: ScopeConsolidationState; now?: number; runs?: number; caps?: MemoryCaps }) {
  const asked: number[] = [];
  const decision = consolidationDue({
    tally: input.tally ?? tally(),
    state: input.state ?? state(),
    caps: input.caps ?? CAPS,
    now: input.now ?? NOW,
    runsDeliveredSince: (since) => {
      asked.push(since);
      return input.runs ?? 0;
    },
  });
  return { decision, asked };
}

describe("when a scope is due a consolidation (EO-480)", () => {
  describe("on the schedule", () => {
    it("is due more than 24 hours after the last one, with at least five runs given its memory since", () => {
      const last = NOW - DAY - 1;
      const { decision, asked } = due({ state: settled(last, false), runs: 5 });
      expect(decision).toEqual({ kind: "consolidate", trigger: "schedule" });
      expect(asked).toEqual([last]);
    });

    it("is not due with fewer than five runs since", () => {
      expect(due({ state: settled(NOW - 3 * DAY, true), runs: 4 }).decision).toEqual({ kind: "none" });
    });

    it("is not due when the last one was 24 hours ago or less, however many runs there were — and does not read run events to know it", () => {
      const { decision, asked } = due({ state: settled(NOW - DAY, true), runs: 50 });
      expect(decision).toEqual({ kind: "none" });
      expect(asked).toEqual([]);
      expect(due({ state: settled(NOW - HOUR, true), runs: 50 }).decision).toEqual({ kind: "none" });
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

  describe("on reaching a cap", () => {
    it("is due when either cap is reached, people's entries counting toward it", () => {
      expect(due({ tally: tally({ agentEntries: 200 }) }).decision).toEqual({ kind: "consolidate", trigger: "cap" });
      expect(due({ tally: tally({ agentEntries: 150, personEntries: 50 }) }).decision).toEqual({ kind: "consolidate", trigger: "cap" });
      expect(due({ tally: tally({ agentChars: 39_000, personChars: 1_000 }) }).decision).toEqual({ kind: "consolidate", trigger: "cap" });
      expect(due({ tally: tally({ agentEntries: 199, agentChars: 39_999 }) }).decision).toEqual({ kind: "none" });
    });

    it("is due when people's entries take a consolidated scope back to the cap, with no agent writing anything since", () => {
      // A consolidation left 100 agent entries; people then added 100.
      const full = tally({ agentEntries: 100, agentChars: 10_000, personEntries: 100, personChars: 5_000 });
      expect(due({ tally: full, state: settled(NOW - HOUR, true) }).decision).toEqual({ kind: "consolidate", trigger: "cap" });
    });

    it("is due when a guardrail is lowered under an unchanged scope", () => {
      const scope = tally({ agentEntries: 120, agentChars: 12_000 });
      expect(due({ tally: scope, state: settled(NOW - HOUR, false) }).decision).toEqual({ kind: "none" });
      const lower = { maxEntries: 100, maxChars: 40_000 };
      expect(due({ tally: scope, state: settled(NOW - HOUR, false), caps: lower }).decision).toEqual({ kind: "consolidate", trigger: "cap" });
      expect(due({ tally: scope, state: settled(NOW - HOUR, false, lower), caps: lower }).decision).toEqual({ kind: "none" });
    });

    it("is not due for a scope left over the cap and unchanged since — a person's restore, say", () => {
      const restored = tally({ agentEntries: 210, agentChars: 20_000 });
      expect(due({ tally: restored, state: settled(NOW - HOUR, false) }).decision).toEqual({ kind: "none" });
      expect(due({ tally: restored, state: settled(NOW - HOUR, true) }).decision).toEqual({ kind: "consolidate", trigger: "cap" });
    });

    it("is due, once its backoff is over, for a scope a batch failed on after the batches before it settled it (EO-574)", () => {
      const over = tally({ agentEntries: 111, agentChars: 56_000 });
      // The first batch succeeded at NOW - HOUR and nothing was written since; the second failed a minute later.
      const partway = state({ ...settled(NOW - HOUR, false), failuresSince: [failure(NOW - HOUR + 60_000, "error")] });
      expect(due({ tally: over, state: partway, now: NOW - HOUR + 60_000 + HOUR - 1 }).decision).toEqual({ kind: "none" });
      expect(due({ tally: over, state: partway, now: NOW - HOUR + 60_000 + HOUR }).decision).toEqual({ kind: "consolidate", trigger: "cap" });
      // A failure from before the scope was settled — a restore since, say — is not a reason to take it up again.
      const restoredSince = state({ ...settled(NOW - HOUR, false), failuresSince: [failure(NOW - 2 * HOUR, "error")] });
      expect(due({ tally: over, state: restoredSince }).decision).toEqual({ kind: "none" });
    });

    it("is due on the schedule, once its backoff is over, for a scope under its caps whose run in batches stopped part-way — without another day or five more runs (EO-574)", () => {
      const under = tally({ agentEntries: 70, agentChars: 7_000 });
      // The first batch succeeded at NOW - HOUR, which made it the last consolidation; the second failed a minute later.
      const partway = state({ ...settled(NOW - HOUR, false), failuresSince: [failure(NOW - HOUR + 60_000, "error")] });
      const retry = NOW - HOUR + 60_000 + HOUR;
      expect(due({ tally: under, state: partway, now: retry - 1 }).decision).toEqual({ kind: "none" });
      const after = due({ tally: under, state: partway, now: retry, runs: 0 });
      expect(after.decision).toEqual({ kind: "consolidate", trigger: "schedule" });
      expect(after.asked).toEqual([]);
      // Finished, the same scope waits for the day and the runs as before.
      expect(due({ tally: under, state: settled(NOW - HOUR, false), now: retry, runs: 0 }).decision).toEqual({ kind: "none" });
    });

    it("records once, and leaves alone, a scope over a cap on people's entries alone with the agents' already within their share", () => {
      const people = tally({ agentEntries: 0, agentChars: 0, oldestAgentAt: null, personEntries: 210, personChars: 9_000 });
      const first = due({ tally: people }).decision;
      expect(first.kind).toBe("skip");
      expect(first.kind === "skip" && first.note).toMatch(/People's entries alone come to 210 entries/);
      // Recorded, which settles it: not again until something changes.
      expect(due({ tally: people, state: state({ settled: { at: NOW - HOUR, caps: CAPS }, changedSinceSettled: false }) }).decision).toEqual({ kind: "none" });
      // The agents' entries past their share are still folded.
      expect(due({ tally: tally({ agentEntries: 30, personEntries: 210, personChars: 9_000 }) }).decision).toEqual({ kind: "consolidate", trigger: "cap" });
      expect(due({ tally: tally({ agentEntries: 15, agentChars: 1_500, personEntries: 210, personChars: 9_000 }) }).decision.kind).toBe("skip");
    });
  });

  describe("after a failure", () => {
    it("backs off an hour after the first failure in a row, four hours after the second, and a day after the third and every one after it (fake clock, EO-577)", () => {
      // Each failure finished at NOW; the ones before it a day apart.
      const failed = (count: number, reason = "schema") => state({ failuresSince: Array.from({ length: count }, (_, at) => failure(NOW - at * DAY, reason)) });
      const full = tally({ agentEntries: 250 });
      expect(CONSOLIDATION_BACKOFF_MS).toEqual([HOUR, 4 * HOUR, DAY]);
      for (const [count, wait] of [[1, HOUR], [2, 4 * HOUR], [3, DAY], [4, DAY], [30, DAY]] as const) {
        expect(retryAt(failed(count)), `after ${count}`).toBe(NOW + wait);
        expect(due({ tally: full, state: failed(count), now: NOW + wait - 1 }).decision, `after ${count}`).toEqual({ kind: "none" });
        expect(due({ tally: full, state: failed(count), now: NOW + wait }).decision, `after ${count}`).toEqual({ kind: "consolidate", trigger: "cap" });
      }
      // A timeout — a call cut off at its time limit or its output-token cap — backs off like any other.
      expect(retryAt(failed(2, "timeout"))).toBe(NOW + 4 * HOUR);
      // Not once per look: every minute in between, it is not due.
      for (let at = NOW; at < NOW + HOUR; at += 60_000) expect(due({ tally: full, state: failed(1), now: at }).decision).toEqual({ kind: "none" });
    });

    it("waits out a budget refusal at a steady interval rather than backing off", () => {
      const refused = state({ failuresSince: Array.from({ length: 6 }, (_, at) => (failure(NOW - at * HOUR, "budget"))) });
      const full = tally({ agentEntries: 250 });
      expect(due({ tally: full, state: refused, now: NOW + CONSOLIDATION_BUDGET_RETRY_MS - 1 }).decision).toEqual({ kind: "none" });
      expect(due({ tally: full, state: refused, now: NOW + CONSOLIDATION_BUDGET_RETRY_MS }).decision).toEqual({ kind: "consolidate", trigger: "cap" });
    });

    it("asks again a minute after one stopped by pausing EO, without counting it as the backend failing (EO-514)", () => {
      const paused = state({
        failuresSince: [
          failure(NOW, CONSOLIDATION_PAUSED_REASON),
          failure(NOW - HOUR, CONSOLIDATION_PAUSED_REASON),
          failure(NOW - 2 * HOUR, CONSOLIDATION_PAUSED_REASON),
        ],
      });
      const full = tally({ agentEntries: 250 });
      expect(due({ tally: full, state: paused, now: NOW + CONSOLIDATION_CHANGED_RETRY_MS - 1 }).decision).toEqual({ kind: "none" });
      expect(due({ tally: full, state: paused, now: NOW + CONSOLIDATION_CHANGED_RETRY_MS }).decision).toEqual({ kind: "consolidate", trigger: "cap" });
      // …and a real failure after pauses backs off from the first step, not the fourth.
      const thenFailed = state({ failuresSince: [failure(NOW, "schema"), ...paused.failuresSince] });
      expect(due({ tally: full, state: thenFailed, now: NOW + HOUR }).decision).toEqual({ kind: "consolidate", trigger: "cap" });
    });

    it("asks again a minute after a batch that gave way to pipeline work, without counting it as a failure (EO-577)", () => {
      const deferred = state({ failuresSince: [failure(NOW, CONSOLIDATION_DEFERRED_REASON), failure(NOW - HOUR, "schema")] });
      const full = tally({ agentEntries: 250 });
      expect(due({ tally: full, state: deferred, now: NOW + CONSOLIDATION_CHANGED_RETRY_MS - 1 }).decision).toEqual({ kind: "none" });
      expect(due({ tally: full, state: deferred, now: NOW + CONSOLIDATION_CHANGED_RETRY_MS }).decision).toEqual({ kind: "consolidate", trigger: "cap" });
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

    it("names the scope, its size against its caps and the last failure's reason in the note", () => {
      const body = stuckNoticeBody({
        scopeLabel: 'the project "EO"',
        tally: tally({ agentEntries: 105, agentChars: 54_000, personEntries: 6, personChars: 2_000 }),
        caps: CAPS,
        failures: 3,
        last: { reason: "schema", note: "The answer did not match the shape asked for." },
        retryAt: Date.parse("2026-10-27T09:30:00Z"),
      });
      expect(body).toContain('Memory consolidation of the project "EO" is stuck: it has failed 3 times in a row.');
      expect(body).toContain("111 entries against a cap of 200, and 56,000 characters against a cap of 40,000");
      expect(body).toContain("`schema` — The answer did not match the shape asked for.");
      expect(body).toContain("2026-10-27 09:30 UTC");
      expect(body).toContain("no delivery waits on this");
    });

    it("is never due while one is running", () => {
      expect(due({ tally: tally({ agentEntries: 250 }), state: state({ running: true }) }).decision).toEqual({ kind: "none" });
    });
  });
});

describe("what a consolidation is held to (EO-480)", () => {
  it("aims for about half of each cap, less what people's entries take", () => {
    expect(consolidationTargets(tally(), CAPS)).toEqual({ entries: 100, chars: 20_000 });
    expect(consolidationTargets(tally({ personEntries: 30, personChars: 5_000 }), CAPS)).toEqual({ entries: 70, chars: 15_000 });
    // People's entries take most of half: the agents keep up to a tenth.
    expect(consolidationTargets(tally({ personEntries: 170, personChars: 30_000 }), CAPS)).toEqual({ entries: 20, chars: 4_000 });
  });

  it("never leaves room for the scope to be at or over a cap that people's entries alone do not reach, on either limit", () => {
    // 190 people's entries: a tenth (20) would take the scope to 210.
    const byEntries = consolidationTargets(tally({ personEntries: 190 }), CAPS);
    expect(byEntries.entries).toBe(9);
    expect(190 + byEntries.entries).toBeLessThan(CAPS.maxEntries);
    // 38,000 characters of people's entries: a tenth (4,000) would pass 40,000.
    const byChars = consolidationTargets(tally({ personChars: 38_000 }), CAPS);
    expect(byChars).toMatchObject({ chars: 1_999 });
    expect(38_000 + byChars.chars).toBeLessThan(CAPS.maxChars);
    // Exactly at the cap less one: no room for any agent entry.
    expect(consolidationTargets(tally({ personEntries: 199 }), CAPS).entries).toBe(0);
  });

  it("holds the agents to a tenth where people's entries alone reach the cap", () => {
    expect(consolidationTargets(tally({ personEntries: 230, personChars: 41_000 }), CAPS)).toEqual({ entries: 20, chars: 4_000 });
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
  const answer = (overrides: Partial<MemoryConsolidationOperations> = {}) => ({ retire: [], merge: [], rewrite: [], ...overrides });
  const accepts = (value: unknown) => schema.safeParse(value).success;

  it("has retire, merge and rewrite, a merge folding at least two entries, and an entry not named stays as it is", () => {
    const value = answer({
      retire: [{ id: "a", reason: "Contradicted by b, which is newer." }],
      merge: [{ from: ["b", "c"], body: "Tests need Postgres 16 (since 2026-10-25). The ledger is in UTC.", contradictsRepositoryFile: false }],
    });
    expect(accepts(value)).toBe(true);
    // `d` is in no operation, so the answer leaves it: one retired, two folded into one.
    expect(consolidationChange(sent, value)).toMatchObject({ entriesBefore: 4, entriesAfter: 2 });

    expect(accepts(answer({ rewrite: [{ id: "b", body: "Tests need Postgres 16 (2026-10-25).", contradictsRepositoryFile: false }] }))).toBe(true);
    expect(accepts(answer({ merge: [{ from: ["b"], body: "Postgres 16.", contradictsRepositoryFile: false }] }))).toBe(false);
    expect(accepts(answer({ merge: [{ from: [], body: "Postgres 16.", contradictsRepositoryFile: false }] }))).toBe(false);
    expect(accepts(answer({ retire: [{ id: "a", reason: "" }] }))).toBe(false);
    expect(accepts(answer({ rewrite: [{ id: "a", body: "   ", contradictsRepositoryFile: false }] }))).toBe(false);
    // The whole set, the old shape, is not an answer.
    expect(accepts({ entries: [{ body: "One.", from: ["a"], contradictsRepositoryFile: false }] })).toBe(false);
  });

  it("refuses an id it was not sent — a person's entry among them — in any of the three operations", () => {
    // A person's entry is never sent, so its id is one the call does not know.
    const personsEntry = "person-entry";
    for (const id of ["made-up", personsEntry]) {
      expect(accepts(answer({ retire: [{ id, reason: "Stale." }] }))).toBe(false);
      expect(accepts(answer({ merge: [{ from: ["a", id], body: "Merged.", contradictsRepositoryFile: false }] }))).toBe(false);
      expect(accepts(answer({ rewrite: [{ id, body: "Rewritten.", contradictsRepositoryFile: false }] }))).toBe(false);
    }
  });

  it("refuses an entry named twice, within one operation or across two", () => {
    expect(accepts(answer({ merge: [{ from: ["a", "a"], body: "Merged.", contradictsRepositoryFile: false }] }))).toBe(false);
    expect(accepts(answer({ retire: [{ id: "a", reason: "Stale." }], rewrite: [{ id: "a", body: "A.", contradictsRepositoryFile: false }] }))).toBe(false);
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

  it("accepts an answer that makes the scope smaller however far short of half it falls, refuses one that grows it, and takes an empty one as a no-op", () => {
    // One retirement of four entries: nowhere near half, and accepted.
    expect(accepts(answer({ retire: [{ id: "c", reason: "Derivable from the code." }] }))).toBe(true);
    // A merge that takes more characters than it folds still removes an entry.
    expect(accepts(answer({ merge: [{ from: ["c", "d"], body: "x".repeat(200), contradictsRepositoryFile: false }] }))).toBe(true);
    // A rewrite no longer than the entry, or only flagging it, does not grow it.
    expect(accepts(answer({ rewrite: [{ id: "b", body: "Tests need Postgres 16.", contradictsRepositoryFile: false }] }))).toBe(true);
    expect(accepts(answer({ rewrite: [{ id: "c", body: "The ledger is in UTC.", contradictsRepositoryFile: true }] }))).toBe(true);
    // Longer, with no entry removed: refused.
    const grows = schema.safeParse(answer({ rewrite: [{ id: "c", body: "The ledger is in UTC, and so is every report.", contradictsRepositoryFile: false }] }));
    expect(grows.success).toBe(false);
    expect(grows.error?.issues.map((issue) => issue.message).join(" ")).toMatch(/would grow the scope/);
    // …and still refused when another rewrite saves less than it adds.
    expect(
      accepts(
        answer({
          rewrite: [
            { id: "b", body: "Tests need Postgres 16.", contradictsRepositoryFile: false },
            { id: "c", body: `The ledger is in UTC. ${"x".repeat(40)}`, contradictsRepositoryFile: false },
          ],
        }),
      ),
    ).toBe(false);
    // Nothing to change.
    expect(schema.safeParse(answer())).toMatchObject({ success: true, data: { retire: [], merge: [], rewrite: [] } });
  });

  it("counts what an answer leaves of the entries it was given", () => {
    const value = answer({
      retire: [{ id: "a", reason: "Stale." }],
      merge: [{ from: ["b", "c"], body: "Merged.", contradictsRepositoryFile: false }],
      rewrite: [{ id: "d", body: "Run pnpm test.", contradictsRepositoryFile: false }],
    });
    const before = sent.reduce((sum, entry) => sum + entry.body.length, 0);
    expect(consolidationChange(sent, value)).toEqual({ entriesBefore: 4, entriesAfter: 2, charsBefore: before, charsAfter: "Merged.".length + "Run pnpm test.".length });
    expect(growsScope(consolidationChange(sent, value))).toBe(false);
    expect(growsScope({ entriesBefore: 4, entriesAfter: 4, charsBefore: 100, charsAfter: 101 })).toBe(true);
    expect(growsScope({ entriesBefore: 4, entriesAfter: 3, charsBefore: 100, charsAfter: 150 })).toBe(false);
    expect(growsScope({ entriesBefore: 4, entriesAfter: 4, charsBefore: 100, charsAfter: 100 })).toBe(false);
  });
});

describe("how long a merged or rewritten entry may be (EO-591)", () => {
  // Long enough that a body at the limit shrinks them: the refusal is the limit's, not growsScope's.
  const sent = ["a", "b", "c"].map((id) => ({ id, body: `${id} `.repeat(900) }));
  const schema = consolidationAnswerSchema(sent);
  const answer = (overrides: Partial<MemoryConsolidationOperations>) => ({ retire: [], merge: [], rewrite: [], ...overrides });
  const atLimit = "x".repeat(MAX_MEMORY_NOTE_CHARS);
  const overLimit = "x".repeat(MAX_MEMORY_NOTE_CHARS + 1);

  it(`refuses a merge or a rewrite whose body is longer than ${String(MAX_MEMORY_NOTE_CHARS)} characters, and takes one of exactly that`, () => {
    expect(MAX_MEMORY_NOTE_CHARS).toBe(1_000);
    expect(schema.safeParse(answer({ merge: [{ from: ["a", "b"], body: atLimit, contradictsRepositoryFile: false }] })).success).toBe(true);
    expect(schema.safeParse(answer({ rewrite: [{ id: "c", body: atLimit, contradictsRepositoryFile: false }] })).success).toBe(true);

    const merge = schema.safeParse(answer({ merge: [{ from: ["a", "b"], body: overLimit, contradictsRepositoryFile: false }] }));
    expect(merge.success).toBe(false);
    expect(merge.error?.issues.map((issue) => issue.path.join("."))).toContain("merge.0.body");
    const rewrite = schema.safeParse(answer({ rewrite: [{ id: "c", body: overLimit, contradictsRepositoryFile: false }] }));
    expect(rewrite.success).toBe(false);
    expect(rewrite.error?.issues.map((issue) => issue.path.join("."))).toContain("rewrite.0.body");
    // Whitespace around the body is not counted.
    expect(schema.safeParse(answer({ rewrite: [{ id: "c", body: `  ${atLimit}\n`, contradictsRepositoryFile: false }] })).success).toBe(true);
    // One long body refuses the whole answer, whatever else it holds.
    expect(
      schema.safeParse(
        answer({ retire: [{ id: "c", reason: "Stale." }], merge: [{ from: ["a", "b"], body: overLimit, contradictsRepositoryFile: false }] }),
      ).success,
    ).toBe(false);
    // The shape the backend is held to says so too.
    expect(MemoryConsolidationAnswerSchema.safeParse(answer({ rewrite: [{ id: "c", body: overLimit, contradictsRepositoryFile: false }] })).success).toBe(false);
  });

  it("tells a batch and the cross-batch pass the limit, and to split a topic into separate facts rather than exceed it", () => {
    for (const prompt of [MEMORY_CONSOLIDATE_SYSTEM, MEMORY_CROSS_BATCH_MERGE_SYSTEM]) {
      expect(prompt).toContain(`Keep each entry you merge or rewrite to one fact, at most ${String(MAX_MEMORY_NOTE_CHARS)} characters`);
      expect(prompt).toMatch(/split it into separate facts rather than exceed the limit/);
    }
    const entry: MemoryEntryView = {
      id: "a",
      scope: { kind: "workspace", id: "w" },
      body: "Entry a.",
      source: { type: "person", personId: null },
      createdAt: 0,
      updatedAt: 0,
      retiredAt: null,
      retiredReason: null,
      consolidationId: null,
      contradictsRepositoryFile: false,
    };
    const inputs = [
      consolidationInput({ scopeLabel: "w", entries: [entry], targets: { entries: 1, chars: 10 }, repositoryFiles: [], now: 0 }),
      consolidationInput({
        scopeLabel: "w",
        entries: [entry],
        targets: { entries: 1, chars: 10 },
        batch: { index: 1, count: 2, scopeEntries: 2, scopeChars: 16 },
        repositoryFiles: [],
        now: 0,
      }),
      crossBatchMergeInput({ scopeLabel: "w", groups: [[entry, { ...entry, id: "b" }]], now: 0 }),
    ];
    for (const input of inputs) {
      expect(input).toMatch(new RegExp(`each entry you merge or rewrite at most ${String(MAX_MEMORY_NOTE_CHARS)} characters`, "i"));
      expect(input).not.toContain("4000");
    }
  });
});

describe("what a consolidation is told (EO-573)", () => {
  it("asks for the changes only, and says the rules: merge duplicates; retire the stale, the contradicted and the derivable; absolute dates; the repository files", () => {
    const prompt = MEMORY_CONSOLIDATE_SYSTEM;
    expect(prompt).toMatch(/Name only what changes: an entry you do not mention stays exactly as it is/);
    for (const operation of ["`retire`: `{ id, reason }`", "`merge`: `{ from, body, contradictsRepositoryFile }`", "`rewrite`: `{ id, body, contradictsRepositoryFile }`"]) {
      expect(prompt).toContain(operation);
    }
    expect(prompt).toMatch(/`from` holds at least two ids/);
    expect(prompt).toMatch(/all three lists empty; that is a valid answer/);
    expect(prompt).toMatch(/Merge entries that say the same thing/);
    expect(prompt).toMatch(/Retire what is stale, contradicted by a newer entry, or derivable from the code/);
    expect(prompt).toMatch(/When you rewrite or merge, write relative dates and times .* as absolute dates/);
    expect(prompt).toMatch(/CLAUDE\.md or AGENTS\.md is given .* treat it as current/);
    expect(prompt).toMatch(/set(ting)? contradictsRepositoryFile to true/);
    expect(prompt).toMatch(/Never suggest editing the file/);
    expect(prompt).toMatch(/never larger/);
    // Nothing of the old whole-set answer is left in it.
    expect(prompt).not.toMatch(/Return a smaller set of entries/);
    expect(prompt).not.toMatch(/return its text unchanged/);
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
