import type { MemoryEntryView } from "@eo/core";
import { describe, expect, it } from "vitest";
import { consolidationAnswerSchema, consolidationInput, crossBatchMergeInput, MEMORY_CROSS_BATCH_MERGE_SYSTEM } from "./consolidation.js";
import {
  CONSOLIDATION_BATCH_MAX_CHARS,
  CONSOLIDATION_BATCH_MAX_ENTRIES,
  firstLine,
  mergeCandidatesInput,
  mergeCandidatesSchema,
  NEW_ENTRY_NEIGHBOURS,
  pickCandidateGroups,
  planBatches,
  planNewEntryBatches,
  planNewEntryBatchGroups,
  refreshBatch,
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

describe("a scheduled consolidation's batches (EO-913)", () => {
  const ids = (batch: readonly { id: string }[]) => batch.map((entry) => entry.id);

  it("sends each new entry with up to 8 of its nearest neighbours, best first, and nothing else of the scope", () => {
    const scope = entries(200, 300);
    const fresh = [scope[150]!];
    // Twelve neighbours ranked for it; only the best eight go with it.
    const ranked = [3, 9, 27, 81, 4, 16, 64, 5, 25, 125, 6, 36].map((index) => scope[index]!.id);
    const batches = planNewEntryBatches(fresh, scope, new Map([[scope[150]!.id, ranked]]));
    expect(NEW_ENTRY_NEIGHBOURS).toBe(8);
    expect(batches).toHaveLength(1);
    expect(ids(batches[0]!).sort()).toEqual([scope[150]!.id, ...ranked.slice(0, 8)].sort());
  });

  it("is nothing for a scope with no new entry, however large", () => {
    const scope = entries(500, 400);
    expect(planNewEntryBatches([], scope, new Map())).toEqual([]);
  });

  it("sends each new entry with its own neighbours however the lists overlap, a shared one once in its batch", () => {
    const scope = entries(20, 100);
    const [a, b, c] = [scope[10]!, scope[11]!, scope[12]!];
    const neighbours = new Map([
      [a.id, [scope[1]!.id, b.id]],
      [b.id, [scope[1]!.id, scope[2]!.id]],
      [c.id, [scope[1]!.id, scope[3]!.id]],
    ]);
    const batches = planNewEntryBatches([a, b, c], scope, neighbours);
    const all = batches.flat();
    expect(new Set(ids(all)).size).toBe(all.length);
    // b came with a, and its own neighbour scope[2] comes too: one batch, since they share scope[1].
    expect(batches).toHaveLength(1);
    expect(ids(all).sort()).toEqual([scope[1]!, scope[2]!, scope[3]!, a, b, c].map((entry) => entry.id).sort());
  });

  it("keeps a chain whole: a new entry found as another's neighbour brings its own, older ones (EO-913)", () => {
    const scope = entries(20, 100);
    // A is newest and finds B; B, also new, finds C, which is older and not new.
    const [c, b, a] = [scope[2]!, scope[8]!, scope[15]!];
    const batches = planNewEntryBatches([b, a], scope, new Map([
      [a.id, [b.id]],
      [b.id, [c.id]],
    ]));
    expect(batches.map(ids)).toEqual([[c.id, b.id, a.id]]);
    // And the other way round, with A the older of the two.
    const flipped = planNewEntryBatches([b, a], scope, new Map([
      [b.id, [a.id]],
      [a.id, [c.id]],
    ]));
    expect(flipped.map(ids)).toEqual([[c.id, b.id, a.id]]);
  });

  it("keeps an overlapping group in one batch rather than split one new entry from its neighbours across two", () => {
    const scope = entries(60, 1_000);
    // A first unit of six fills a third of a batch; a second, sharing nothing, takes it to twelve thousand characters; a third shares an entry with the first and has to join it.
    const [x, y, z] = [scope[40]!, scope[41]!, scope[42]!];
    const neighbours = new Map([
      [x.id, scope.slice(0, 5).map((entry) => entry.id)],
      [y.id, scope.slice(10, 15).map((entry) => entry.id)],
      [z.id, [scope[0]!.id, ...scope.slice(20, 24).map((entry) => entry.id)]],
    ]);
    const batches = planNewEntryBatches([x, y, z], scope, neighbours);
    const batchOf = (id: string) => batches.findIndex((batch) => ids(batch).includes(id));
    for (const id of [scope[0]!.id, scope[20]!.id, z.id]) expect(batchOf(id)).toBe(batchOf(x.id));
    for (const id of scope.slice(10, 15).map((entry) => entry.id)) expect(batchOf(id)).toBe(batchOf(y.id));
    for (const batch of batches) expect(charsOf(batch)).toBeLessThanOrEqual(CONSOLIDATION_BATCH_MAX_CHARS);
    expect(new Set(ids(batches.flat())).size).toBe(batches.flat().length);
  });

  it("sends every new entry with its whole list in one batch, though an overlapping group closed the batch it was first given in (EO-913)", () => {
    const scope = entries(60, 1_000);
    // a is oldest, then c, then b: b is one of a's neighbours, and its only neighbour is d.
    const [a, c, b, d] = [scope[40]!, scope[41]!, scope[42]!, scope[30]!];
    const lists = new Map([
      [a.id, [...scope.slice(0, 7).map((entry) => entry.id), b.id]],
      // c shares scope[0] with a, and the two lists do not fit one batch.
      [c.id, [scope[0]!.id, ...scope.slice(10, 17).map((entry) => entry.id)]],
      [b.id, [d.id]],
    ]);
    const batches = planNewEntryBatches([a, c, b], scope, lists);
    const together = (id: string) => batches.some((batch) => [id, ...lists.get(id)!].every((one) => ids(batch).includes(one)));
    for (const id of [a.id, c.id, b.id]) expect(together(id), id).toBe(true);
    for (const batch of batches) {
      expect(charsOf(batch)).toBeLessThanOrEqual(CONSOLIDATION_BATCH_MAX_CHARS);
      expect(new Set(ids(batch)).size).toBe(batch.length);
    }
  });

  it("says which new entries each batch is for: the one whose own list it holds, not one it has only as another's neighbour (EO-913)", () => {
    const scope = entries(60, 1_000);
    const [a, c, b, d] = [scope[40]!, scope[41]!, scope[42]!, scope[30]!];
    const lists = new Map([
      [a.id, [...scope.slice(0, 7).map((entry) => entry.id), b.id]],
      [c.id, [scope[0]!.id, ...scope.slice(10, 17).map((entry) => entry.id)]],
      [b.id, [d.id]],
    ]);
    const planned = planNewEntryBatchGroups([a, c, b], scope, lists);
    expect(planned.map((one) => one.entries)).toEqual(planNewEntryBatches([a, c, b], scope, lists));
    // Each new entry is owned by exactly one batch, and that batch holds its whole list.
    for (const id of [a.id, c.id, b.id]) {
      const owners = planned.filter((one) => one.owns.includes(id));
      expect(owners, id).toHaveLength(1);
      expect(ids(owners[0]!.entries), id).toEqual(expect.arrayContaining([id, ...lists.get(id)!]));
    }
    // b is in a's batch as its neighbour, but that batch is not for it: d is not there.
    const first = planned.find((one) => one.owns.includes(a.id))!;
    expect(ids(first.entries)).toContain(b.id);
    if (!ids(first.entries).includes(d.id)) expect(first.owns).not.toContain(b.id);
  });

  it("gives a neighbour many new entries rank to every batch they fill, not only the first (EO-913)", () => {
    const shared = { id: "shared", body: "Shared context.", createdAt: NOW - 2_000_000 };
    const fresh = entries(31, 100);
    const lists = new Map(fresh.map((entry) => [entry.id, [shared.id]]));
    const batches = planNewEntryBatches(fresh, [shared, ...fresh], lists);
    expect(batches.map((batch) => batch.length)).toEqual([30, 3]);
    for (const batch of batches) expect(ids(batch)).toContain(shared.id);
    // Each new entry in exactly one batch.
    expect(batches.flat().filter((entry) => entry.id !== shared.id)).toHaveLength(31);
  });

  it("starts another batch where the next new entry and its neighbours would take one over its limits", () => {
    const scope = entries(60, 1_000);
    const fresh = [scope[40]!, scope[50]!];
    const neighbours = new Map([
      [scope[40]!.id, scope.slice(0, 8).map((entry) => entry.id)],
      [scope[50]!.id, scope.slice(10, 18).map((entry) => entry.id)],
    ]);
    // Nine entries of 1,000 characters each: two units do not fit one batch of 15,000.
    const batches = planNewEntryBatches(fresh, scope, neighbours);
    expect(batches).toHaveLength(2);
    expect(ids(batches[0]!)).toContain(scope[40]!.id);
    expect(ids(batches[1]!)).toContain(scope[50]!.id);
    for (const batch of batches) expect(charsOf(batch)).toBeLessThanOrEqual(CONSOLIDATION_BATCH_MAX_CHARS);
  });

  it("cuts a new entry's list of long legacy neighbours at the batch's limits, keeping the new entry and its best-ranked ones", () => {
    // Eight legacy topic digests of 2,000 characters, from before EO-591 held a note to 1,000.
    const legacy = entries(8, 2_000);
    const fresh = { id: "fresh", body: "N".repeat(1_000), createdAt: NOW };
    const scope = [...legacy, fresh];
    const ranked = [...legacy].reverse().map((entry) => entry.id);
    const batches = planNewEntryBatches([fresh], scope, new Map([[fresh.id, ranked]]));
    for (const batch of batches) expect(charsOf(batch)).toBeLessThanOrEqual(CONSOLIDATION_BATCH_MAX_CHARS);
    expect(batches).toHaveLength(1);
    // 1,000 + 7 × 2,000 = 15,000: the worst-ranked neighbour is the one left out.
    expect(new Set(ids(batches[0]!))).toEqual(new Set([fresh.id, ...ranked.slice(0, 7)]));
  });

  it("sends the new entries alone, by age, where the index could not be asked", () => {
    const scope = entries(50, 200);
    const fresh = [scope[30]!, scope[20]!];
    expect(planNewEntryBatches(fresh, scope, null).map(ids)).toEqual([[scope[20]!.id, scope[30]!.id]]);
  });
});

describe("a planned batch, once the batches before it were applied (EO-913)", () => {
  const ids = (batch: readonly { id: string }[]) => batch.map((entry) => entry.id);
  it("leaves out what they retired, gives what they folded or rewrote it into once, and follows a replacement replaced again", () => {
    const [a, b, c, d] = entries(4, 100);
    const m = { id: "m", body: "Folded.", createdAt: NOW };
    const r = { id: "r", body: "Rewritten again.", createdAt: NOW + 1 };
    const now = new Map([m, r].map((entry) => [entry.id, entry]));
    // a and b were folded into m; c was retired outright; m was then rewritten as r.
    const replaced = new Map([
      [a!.id, ["m"]],
      [b!.id, ["m"]],
      [c!.id, []],
      ["m", ["r"]],
    ]);
    expect(ids(refreshBatch([a!, b!, c!, d!], replaced, (id) => now.get(id)))).toEqual([d!.id, "r"]);
    // Untouched, it is as planned.
    expect(refreshBatch([d!], replaced, (id) => now.get(id))).toEqual([d!]);
    // What it was folded into is gone too: nothing in its place.
    expect(ids(refreshBatch([a!, d!], new Map([[a!.id, ["gone"]]]), () => undefined))).toEqual([d!.id]);
  });

  it("puts a replacement in only as far as the batch's limits allow", () => {
    const [a, d] = entries(2, 100);
    const long = { id: "long", body: "L".repeat(CONSOLIDATION_BATCH_MAX_CHARS), createdAt: NOW };
    expect(ids(refreshBatch([a!, d!], new Map([[a!.id, ["long"]]]), () => long))).toEqual([d!.id]);
  });
});

describe("what a batch is asked for", () => {
  it("is told which batch it is, what the whole scope holds, and to change only its own entries", () => {
    const view = (id: string, body: string): MemoryEntryView =>
      ({ id, body, createdAt: NOW, contradictsRepositoryFile: false, source: { type: "run", runId: null, itemId: null } }) as unknown as MemoryEntryView;
    const input = consolidationInput({
      scopeLabel: 'the project "EO"',
      entries: [view("a", "One."), view("b", "Two.")],
      batch: { index: 2, count: 4, scopeEntries: 111, scopeChars: 56_000 },
      repositoryFiles: [],
      now: NOW,
    });
    expect(input).toContain("batch 2 of 4");
    expect(input).toContain("The scope's agents hold 111 entries in 56000 characters");
    expect(input).toContain("change only these");
    expect(input).not.toMatch(/target/i);
  });

  it("is told, on the schedule, that it is given what is new with the entries most like it, each new one marked (EO-913)", () => {
    const view = (id: string, body: string): MemoryEntryView =>
      ({ id, body, createdAt: NOW, contradictsRepositoryFile: false, source: { type: "run", runId: null, itemId: null } }) as unknown as MemoryEntryView;
    const input = consolidationInput({
      scopeLabel: 'the project "EO"',
      entries: [view("a", "One."), view("b", "Two.")],
      batch: { index: 1, count: 1, scopeEntries: 135, scopeChars: 58_956, fresh: new Set(["b"]) },
      repositoryFiles: [],
      now: NOW,
    });
    expect(input).toContain("each is given with the existing entries most like it");
    expect(input).toContain("The scope's agents hold 135 entries in 58956 characters; the rest were tidied before and are not part of this");
    expect(input).toMatch(/^### b \(written [^)]*; new since the last consolidation\)$/m);
    expect(input).toMatch(/^### a \(written [^)]*\d\)$/m);
    expect(input).not.toContain("batch 1 of 1");
    expect(input).not.toMatch(/target/i);
  });

  it("marks likely duplicates on their entries, naming only others in the same call (EO-576)", () => {
    const view = (id: string, body: string): MemoryEntryView =>
      ({ id, body, createdAt: NOW, contradictsRepositoryFile: false, source: { type: "run", runId: null, itemId: null } }) as unknown as MemoryEntryView;
    const told = (likelyDuplicates?: ReadonlyMap<string, readonly string[]>) =>
      consolidationInput({
        scopeLabel: 'the project "EO"',
        entries: [view("a", "One."), view("b", "One!"), view("c", "Two."), view("d", "Three.")],
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

    const schema = consolidationAnswerSchema(
      [
        { id: "a", body: "The ledger is in UTC.\nAlways.", createdAt: NOW, contradictsRepositoryFile: false },
        { id: "b", body: "The ledger is in UTC.", createdAt: NOW, contradictsRepositoryFile: false },
      ],
      { repositoryFiles: [] },
    );
    expect(schema.safeParse({ retire: [], merge: [{ from: ["a", "b"], body: "The ledger is in UTC.", contradictsRepositoryFile: false }], rewrite: [] }).success).toBe(true);
    expect(schema.safeParse({ retire: [{ id: "c", reason: "Stale." }], merge: [], rewrite: [] }).success).toBe(false);
  });
});
