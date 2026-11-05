import type { MemoryEntryView } from "@eo/core";
import { describe, expect, it } from "vitest";
import { consolidationAnswerSchema, consolidationInput, crossBatchMergeInput, MEMORY_CROSS_BATCH_MERGE_SYSTEM } from "./consolidation.js";
import {
  batchTargets,
  CONSOLIDATION_BATCH_MAX_CHARS,
  CONSOLIDATION_BATCH_MAX_ENTRIES,
  firstLine,
  mergeCandidatesInput,
  mergeCandidatesSchema,
  pickCandidateGroups,
  planBatches,
  type BatchableEntry,
} from "./consolidationBatches.js";

/** Consolidating a scope in batches (EO-574), the pure half. */
const NOW = 1_800_000_000_000;

/** `count` entries of `charsEach` characters, oldest first. */
function entries(count: number, charsEach: number | ((index: number) => number)): BatchableEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const length = typeof charsEach === "number" ? charsEach : charsEach(index);
    const head = `Entry ${index}. `;
    return { id: `e${String(index).padStart(3, "0")}`, body: head + "x".repeat(Math.max(0, length - head.length)), createdAt: NOW - 1_000_000 + index };
  });
}

const charsOf = (batch: readonly { body: string }[]) => batch.reduce((sum, entry) => sum + entry.body.length, 0);

describe("cutting a scope into batches", () => {
  it("cuts 111 entries and 56,000 characters into batches of at most 30 entries or 15,000 characters, every entry in exactly one", () => {
    const scope = entries(111, (index) => (index < 56 ? 505 : 504));
    expect(charsOf(scope)).toBe(56_000);

    const batches = planBatches(scope, null);

    expect(batches.length).toBeGreaterThanOrEqual(4);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(CONSOLIDATION_BATCH_MAX_ENTRIES);
      expect(charsOf(batch)).toBeLessThanOrEqual(CONSOLIDATION_BATCH_MAX_CHARS);
    }
    expect(batches.flat().map((entry) => entry.id).sort()).toEqual(scope.map((entry) => entry.id).sort());
  });

  it("closes a batch at 30 entries when the characters allow more, and at 15,000 characters when the entries do", () => {
    expect(planBatches(entries(70, 100), null).map((batch) => batch.length)).toEqual([30, 30, 10]);
    expect(planBatches(entries(20, 1_000), null).map((batch) => batch.length)).toEqual([15, 5]);
  });

  it("is one batch for a scope that fits one, and puts an entry longer than a batch on its own", () => {
    expect(planBatches(entries(30, 500), null)).toHaveLength(1);
    const long = entries(3, (index) => (index === 1 ? 16_000 : 100));
    expect(planBatches(long, null).map((batch) => batch.map((entry) => entry.id))).toEqual([["e000"], ["e001"], ["e002"]]);
  });

  it("goes by age without the index, oldest first", () => {
    const scope = entries(65, 100);
    const batches = planBatches([...scope].reverse(), null);
    expect(batches.map((batch) => batch.map((entry) => entry.id))).toEqual([
      scope.slice(0, 30).map((entry) => entry.id),
      scope.slice(30, 60).map((entry) => entry.id),
      scope.slice(60).map((entry) => entry.id),
    ]);
  });

  it("puts entries the index says are alike in one batch, though their ages interleave with others'", () => {
    // Two topics, alternating by age: even entries are about one, odd about the other.
    const scope = entries(60, 100);
    const topic = (entry: BatchableEntry) => Number(entry.id.slice(1)) % 2;
    const neighbours = new Map(scope.map((entry) => [entry.id, scope.filter((other) => other.id !== entry.id && topic(other) === topic(entry)).map((other) => other.id)]));

    const batches = planBatches(scope, neighbours);

    expect(batches).toHaveLength(2);
    for (const batch of batches) expect(new Set(batch.map(topic)).size).toBe(1);
  });

  it("fills a batch by age once the neighbours run out, and ignores neighbours it was not given", () => {
    const scope = entries(40, 100);
    const neighbours = new Map([["e000", ["e039", "elsewhere"]]]);
    const [first] = planBatches(scope, neighbours);
    expect(first!.map((entry) => entry.id)).toEqual(["e000", ...scope.slice(1, 29).map((entry) => entry.id), "e039"]);
  });

  it("puts likely duplicates in one batch however far apart their ages, closing a batch with no room for the whole set (EO-576)", () => {
    const scope = entries(70, 100);
    const id = (index: number) => scope[index]!.id;
    const pair = [scope[0]!, scope[65]!];
    const trio = [scope[28]!, scope[40]!, scope[69]!];
    const batches = planBatches(scope, null, undefined, [pair, trio]);
    const batchOf = (index: number) => batches.findIndex((batch) => batch.some((entry) => entry.id === id(index)));

    expect(batchOf(65)).toBe(batchOf(0));
    expect(batchOf(40)).toBe(batchOf(28));
    expect(batchOf(69)).toBe(batchOf(28));
    // The first batch, from the oldest, takes the pair at once; at 28 entries there is no room for the trio, which starts the second.
    expect(batches[0]!.map((entry) => entry.id)).toEqual([...scope.slice(0, 28), scope[65]!].map((entry) => entry.id));
    expect(batches[1]!.slice(0, 1).map((entry) => entry.id)).toEqual([id(28)]);
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(CONSOLIDATION_BATCH_MAX_ENTRIES);
    expect(batches.flat().map((entry) => entry.id).sort()).toEqual(scope.map((entry) => entry.id));
  });
});

describe("what a batch is asked for", () => {
  it("is the scope's targets in the batch's share, never more than the batch holds", () => {
    const batch = entries(30, 500);
    expect(batchTargets(batch, { entries: 111, chars: 56_000 }, { entries: 100, chars: 20_000 })).toEqual({ entries: 28, chars: Math.ceil((15_000 * 20_000) / 56_000) });
    expect(batchTargets(batch, { entries: 40, chars: 20_000 }, { entries: 100, chars: 30_000 })).toEqual({ entries: 30, chars: 15_000 });
  });

  it("is told which batch it is, what the whole scope holds, and to change only its own entries", () => {
    const view = (id: string, body: string): MemoryEntryView =>
      ({ id, body, createdAt: NOW, contradictsRepositoryFile: false, source: { type: "run", runId: null, itemId: null } }) as unknown as MemoryEntryView;
    const input = consolidationInput({
      scopeLabel: 'the project "EO"',
      entries: [view("a", "One."), view("b", "Two.")],
      targets: { entries: 1, chars: 4 },
      batch: { index: 2, count: 4, scopeEntries: 111, scopeChars: 56_000 },
      repositoryFiles: [],
      now: NOW,
    });
    expect(input).toContain("batch 2 of 4");
    expect(input).toContain("The scope's agents hold 111 entries in 56000 characters");
    expect(input).toContain("change only these");
    expect(input).toContain("Target for this batch: about 1 entries and about 4 characters");
  });

  it("marks likely duplicates on their entries, naming only others in the same call (EO-576)", () => {
    const view = (id: string, body: string): MemoryEntryView =>
      ({ id, body, createdAt: NOW, contradictsRepositoryFile: false, source: { type: "run", runId: null, itemId: null } }) as unknown as MemoryEntryView;
    const told = (likelyDuplicates?: ReadonlyMap<string, readonly string[]>) =>
      consolidationInput({
        scopeLabel: 'the project "EO"',
        entries: [view("a", "One."), view("b", "One!"), view("c", "Two."), view("d", "Three.")],
        targets: { entries: 1, chars: 4 },
        repositoryFiles: [],
        ...(likelyDuplicates ? { likelyDuplicates } : {}),
        now: NOW,
      });
    const input = told(
      new Map([
        ["a", ["b"]],
        ["b", ["a"]],
        ["c", ["elsewhere"]],
      ]),
    );
    expect(input).toMatch(/^### a \(written [^)]*; likely a duplicate of b\)$/m);
    expect(input).toMatch(/^### b \(written [^)]*; likely a duplicate of a\)$/m);
    expect(input).toMatch(/^### c \(written [^)]*\d\)$/m);
    expect(input).toMatch(/^### d \(written [^)]*\d\)$/m);
    expect(input).toContain('Entries marked "likely a duplicate of"');
    expect(told()).not.toContain("likely a duplicate");
    expect(told(new Map([["c", ["elsewhere"]]]))).not.toContain("likely a duplicate");
  });
});

describe("the cross-batch pass", () => {
  it("shows the first call only each entry's id and its first line", () => {
    const scope = [
      { id: "a", body: "Tests need Postgres 16.\nStart it with `docker compose up db`.", createdAt: NOW },
      { id: "b", body: `${"Long ".repeat(60)}\nmore`, createdAt: NOW + 1 },
    ];
    const input = mergeCandidatesInput({ scopeLabel: 'the project "EO"', entries: scope });
    expect(input).toContain("- a: Tests need Postgres 16.");
    expect(input).not.toContain("docker compose");
    expect(input).not.toContain("more");
    expect(firstLine(scope[1]!.body)).toHaveLength(200);
  });

  it("holds its candidates to ids it was given, each in one group of at least two", () => {
    const schema = mergeCandidatesSchema([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(schema.safeParse({ groups: [] }).success).toBe(true);
    expect(schema.safeParse({ groups: [{ ids: ["a", "b"] }] }).success).toBe(true);
    expect(schema.safeParse({ groups: [{ ids: ["a"] }] }).success).toBe(false);
    expect(schema.safeParse({ groups: [{ ids: ["a", "nope"] }] }).success).toBe(false);
    expect(schema.safeParse({ groups: [{ ids: ["a", "b"] }, { ids: ["b", "c"] }] }).success).toBe(false);
  });

  it("reads in full only as many candidates as fit one batch, whole groups at a time, and none that are gone", () => {
    const scope = entries(40, 100);
    const ids = (from: number, to: number) => scope.slice(from, to).map((entry) => entry.id);
    const picked = pickCandidateGroups([{ ids: ids(0, 20) }, { ids: ids(20, 32) }, { ids: ids(32, 34) }, { ids: ["e035", "gone"] }], scope);
    expect(picked.map((group) => group.map((entry) => entry.id))).toEqual([ids(0, 20), ids(32, 34)]);
  });

  it("asks its last call for the operations alone, over the candidates' full bodies, with no skill proposals", () => {
    const view = (id: string, body: string): MemoryEntryView =>
      ({ id, body, createdAt: NOW, contradictsRepositoryFile: false, source: { type: "run", runId: null, itemId: null } }) as unknown as MemoryEntryView;
    const input = crossBatchMergeInput({ scopeLabel: 'the project "EO"', groups: [[view("a", "The ledger is in UTC.\nAlways."), view("b", "The ledger is in UTC.")]], now: NOW });
    expect(input).toContain("## Possible duplicates 1");
    expect(input).toContain("The ledger is in UTC.\nAlways.");

    expect(MEMORY_CROSS_BATCH_MERGE_SYSTEM).toMatch(/possible duplicates/);
    expect(MEMORY_CROSS_BATCH_MERGE_SYSTEM).toContain("`merge`: `{ from, body, contradictsRepositoryFile }`");
    expect(MEMORY_CROSS_BATCH_MERGE_SYSTEM).not.toMatch(/skill/i);

    const schema = consolidationAnswerSchema([
      { id: "a", body: "The ledger is in UTC.\nAlways." },
      { id: "b", body: "The ledger is in UTC." },
    ]);
    expect(schema.safeParse({ retire: [], merge: [{ from: ["a", "b"], body: "The ledger is in UTC.", contradictsRepositoryFile: false }], rewrite: [] }).success).toBe(true);
    expect(schema.safeParse({ retire: [{ id: "c", reason: "Stale." }], merge: [], rewrite: [] }).success).toBe(false);
  });
});
