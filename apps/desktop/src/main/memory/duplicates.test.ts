import { describe, expect, it } from "vitest";
import {
  closestEntries,
  duplicateSimilarity,
  exactDuplicateOperations,
  exactDuplicates,
  likelyDuplicatesOf,
  NEAR_DUPLICATE_SIMILARITY,
  nearDuplicateGroups,
  normalisedBody,
  type DuplicateCandidate,
} from "./duplicates.js";

/** Duplicate memory entries found without a model (EO-576), the pure half. */
const NOW = 1_800_000_000_000;

/** The word those notes are about, spelled so that this file does not join the snapshot they describe. */
const WORD = ["tic", "ket"].join("");

/** Two notes EO's own project memory held about one test, written by different runs. */
const VOCABULARY_NOTES = [
  `apps/desktop/src/main/itemVocabulary.test.ts snapshots every source line, tests included, that contains the word "${WORD}" (KAN-145). Adding such a line, even a test regex like /on this ${WORD}/, fails \`pnpm test\`. Reword the line so it avoids the word, or update the snapshot on purpose.`,
  `apps/desktop/src/main/itemVocabulary.test.ts snapshots every distinct source line (tests included) that contains the bare word "${WORD}", into itemVocabulary.txt. Adding a new line with that word, even in a test (for example a second getByLabelText("Per-${WORD} …")), fails \`pnpm test\`. To avoid it, reuse an existing line verbatim or select the element some other way, such as getByDisplayValue; otherwise update the snapshot deliberately. The full \`pnpm test\` takes about 4 minutes, so run it in the foreground with a 600 s timeout rather than in the background.`,
] as const;

/** Two notes it held about a fresh worktree needing `pnpm install`. */
const WORKTREE_NOTES = [
  "A fresh EO worktree has no node_modules and the workspace packages are unbuilt. Before vitest can run in apps/desktop: `pnpm install --frozen-lockfile`, then `pnpm turbo run build --filter='./packages/*'`. Without the build, every desktop test fails with \"Failed to resolve entry for package @eo/core\".",
  'In a fresh worktree, `npx vitest run <file>` in apps/desktop fails with "Failed to resolve entry for package "@eo/core"" until the workspace packages are built: run `npx turbo run build --filter=@eo/core --filter=@eo/engine` from the root once (or `pnpm typecheck`, which builds them first), after `pnpm install --frozen-lockfile`.',
] as const;

/** Two notes on one subject that say different things. */
const WATCH_NOTES = [
  "The builtin watch_pull_request's `ready` result fires only when the step's `reportReady` input is true. Setting `readyWhen: \"mergeable\"` alone does not make it fire.",
  "watch_pull_request sends an item back to To Do at most once per forge review: it records the review id (GitHub: the id of the 'Request changes' review; GitLab: the discussion id).",
] as const;

let next = 0;
function entry(body: string, options: { at?: number; person?: boolean; flagged?: boolean; id?: string } = {}): DuplicateCandidate {
  next += 1;
  return {
    id: options.id ?? `e${String(next).padStart(3, "0")}`,
    body,
    createdAt: options.at ?? NOW + next,
    source: options.person ? { type: "person", personId: null } : { type: "run", runId: null, itemId: null },
    contradictsRepositoryFile: options.flagged ?? false,
  };
}

/** Every entry's index neighbours: every other entry, as the full-text index would name them in a small scope. */
const everyOther = (entries: readonly DuplicateCandidate[]) => new Map(entries.map((one) => [one.id, entries.filter((other) => other.id !== one.id).map((other) => other.id)]));

describe("word-for-word duplicates", () => {
  it("compares bodies with whitespace, case, sentence marks and inline-code backticks normalised away", () => {
    expect(normalisedBody("  Run `pnpm install`\n\tfirst. ")).toBe("run pnpm install first");
    expect(normalisedBody("RUN pnpm install, first;")).toBe(normalisedBody("run pnpm install first"));
    expect(normalisedBody("Then `pnpm lint`: done…")).toBe(normalisedBody("then pnpm lint done"));
    expect(normalisedBody("itemVocabulary.txt")).not.toBe(normalisedBody("itemvocabularytxt"));
    expect(normalisedBody("a < b")).not.toBe(normalisedBody("a > b"));
    expect(normalisedBody("Port 3000")).not.toBe(normalisedBody("Port 4000"));
  });

  it("keeps the punctuation that can carry meaning: operators, signs and marks inside a word", () => {
    const apart = [
      ["Retry when a != b.", "Retry when a = b."],
      ["Retry when a!=b.", "Retry when a=b."],
      ["Use port -1.", "Use port 1."],
      ["Pass --force.", "Pass force."],
      ["Skip it when !ready.", "Skip it when ready."],
      ["Pin v1.2 here.", "Pin v12 here."],
      ["Write itemVocabulary.txt.", "Write itemVocabulary txt."],
      ["Use a - b.", "Use a b."],
      ["Call f() first.", "Call f first."],
      ["Evaluate (a + b) * c.", "Evaluate a + b * c."],
      ["Set x = 'a' here.", "Set x = a here."],
      ['Match "a b" exactly.', "Match a b exactly."],
      ["Use `println!` here.", "Use `println` here."],
      ["Call foo()? there.", "Call foo() there."],
      ["Run cd .. first.", "Run cd first."],
    ];
    for (const [one, other] of apart) expect(normalisedBody(one!), `${one} / ${other}`).not.toBe(normalisedBody(other!));
  });

  it("never retires one of two notes that differ only in an operator, a sign or a bracket", () => {
    const pairs = [
      [entry("Retry when a != b.", { at: NOW }), entry("Retry when a = b.", { at: NOW + 1 })],
      [entry("Use port -1.", { at: NOW + 2 }), entry("Use port 1.", { at: NOW + 3 })],
      [entry("Evaluate (a + b) * c.", { at: NOW + 4 }), entry("Evaluate a + b * c.", { at: NOW + 5 })],
    ];
    for (const pair of pairs) expect(exactDuplicates(pair)).toEqual([]);
    // Ordinary sentence marks and inline-code backticks still fold.
    const prose = [entry("Run `pnpm lint` before pushing.", { at: NOW + 6 }), entry("run pnpm lint, before pushing", { at: NOW + 7 })];
    expect(exactDuplicates(prose)).toEqual([{ kept: prose[1], retired: [prose[0]] }]);
  });

  it("keeps the newest of each set and retires the rest, leaving entries that are only alike", () => {
    const oldest = entry("A fresh EO worktree needs `pnpm install` first.", { at: NOW });
    const newest = entry("a fresh EO worktree needs pnpm install first", { at: NOW + 20 });
    const middle = entry("A fresh  EO worktree needs\npnpm install first;", { at: NOW + 10 });
    const other = [entry("Lint before you push.", { at: NOW + 1 }), entry("lint before you push", { at: NOW + 2 })];
    const alike = entry("A fresh EO worktree needs `pnpm install` first, then a build.", { at: NOW + 30 });

    const sets = exactDuplicates([oldest, newest, middle, ...other, alike]);
    expect(sets).toEqual([
      { kept: newest, retired: [middle, oldest] },
      { kept: other[1], retired: [other[0]] },
    ]);
    expect(exactDuplicateOperations(sets)).toEqual({
      retire: [
        { id: middle.id, reason: `repeats ${newest.id} word for word` },
        { id: oldest.id, reason: `repeats ${newest.id} word for word` },
        { id: other[0]!.id, reason: `repeats ${other[1]!.id} word for word` },
      ],
      merge: [],
      rewrite: [],
    });
  });

  it("never counts a person's entry, even one written later than the agents'", () => {
    const agents = [entry("Run the tests with pnpm test.", { at: NOW }), entry("Run the tests with pnpm test.", { at: NOW + 1 })];
    const person = entry("Run the tests with pnpm test.", { at: NOW + 2, person: true });
    expect(exactDuplicates([...agents, person])).toEqual([{ kept: agents[1], retired: [agents[0]] }]);
    expect(exactDuplicates([agents[0]!, person])).toEqual([]);
  });

  it("leaves two that differ in their repository-file flag to the model", () => {
    const flagged = entry("The API runs on port 8080, not 3000.", { flagged: true });
    const plain = entry("The API runs on port 8080, not 3000.");
    expect(exactDuplicates([flagged, plain])).toEqual([]);
    expect(nearDuplicateGroups([flagged, plain], everyOther([flagged, plain]))).toEqual([[flagged, plain]]);
  });
});

describe("the entries closest to a note", () => {
  const BODY = "Run pnpm install in a fresh worktree before running the tests.";

  it("are those above the threshold, closest first, and a person's is among them", () => {
    const same = { id: "same", body: "run pnpm install in a fresh worktree before running the tests" };
    const near = { id: "near", body: "A fresh worktree needs pnpm install before running anything." };
    const person = { id: "person", body: "Run pnpm install in a fresh worktree before the tests.", source: { type: "person" } };
    const far = { id: "far", body: "Settlements are compared in UTC." };

    const closest = closestEntries(BODY, [far, near, same, person]);

    expect(closest.map((entry) => entry.id)).toEqual(["same", "person", "near"]);
    for (const entry of closest) expect(duplicateSimilarity(BODY, entry.body)).toBeGreaterThan(NEAR_DUPLICATE_SIMILARITY);
    expect(duplicateSimilarity(BODY, far.body)).toBeLessThanOrEqual(NEAR_DUPLICATE_SIMILARITY);
  });

  it("are none where nothing is above it", () => {
    expect(closestEntries(BODY, [{ body: "Settlements are compared in UTC." }])).toEqual([]);
    expect(closestEntries(BODY, [])).toEqual([]);
  });
});

describe("near duplicates", () => {
  it("measures the notes EO's own memory repeated above the threshold, and notes that only share a subject below it", () => {
    expect(duplicateSimilarity(...VOCABULARY_NOTES)).toBeGreaterThan(NEAR_DUPLICATE_SIMILARITY);
    expect(duplicateSimilarity(...WORKTREE_NOTES)).toBeGreaterThan(NEAR_DUPLICATE_SIMILARITY);
    expect(duplicateSimilarity(...WATCH_NOTES)).toBeLessThan(NEAR_DUPLICATE_SIMILARITY);
    expect(duplicateSimilarity(VOCABULARY_NOTES[0], WORKTREE_NOTES[0])).toBeLessThan(NEAR_DUPLICATE_SIMILARITY);
    expect(duplicateSimilarity("Same TEXT  here", "same text here")).toBe(1);
    expect(duplicateSimilarity("ab", "ab")).toBe(0);
  });

  it("groups the pairs above the threshold among the index's candidates, and only those", () => {
    const vocabulary = VOCABULARY_NOTES.map((body) => entry(body));
    const worktree = WORKTREE_NOTES.map((body) => entry(body));
    const watch = WATCH_NOTES.map((body) => entry(body));
    const all = [...vocabulary, ...worktree, ...watch];

    expect(nearDuplicateGroups(all, everyOther(all))).toEqual([worktree, vocabulary]);
    // A pair the index never names as candidates is not compared.
    expect(nearDuplicateGroups(all, new Map([[vocabulary[0]!.id, [vocabulary[1]!.id]]]))).toEqual([vocabulary]);
    // Without the index there is nothing to go on.
    expect(nearDuplicateGroups(all, null)).toEqual([]);
  });

  it("never marks a person's entry", () => {
    const agent = entry(VOCABULARY_NOTES[0]);
    const person = entry(VOCABULARY_NOTES[1], { person: true });
    expect(nearDuplicateGroups([agent, person], everyOther([agent, person]))).toEqual([]);
  });

  it("joins pairs into one group, but never past what one batch holds", () => {
    const three = ["first", "second", "third", "fourth"].map((word) => entry(`The release workflow tags the tip of origin/main when it runs (${word} note).`));
    expect(nearDuplicateGroups(three, everyOther(three))).toEqual([three]);
    const groups = nearDuplicateGroups(three, everyOther(three), { maxEntries: 2, maxChars: 15_000 });
    expect(groups).toHaveLength(2);
    expect(groups.flat().map((one) => one.id).sort()).toEqual(three.map((one) => one.id).sort());
  });

  it("marks each member with the others in its group", () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => ({ id }));
    expect(likelyDuplicatesOf([[a!, b!, c!]])).toEqual(
      new Map([
        ["a", ["b", "c"]],
        ["b", ["a", "c"]],
        ["c", ["a", "b"]],
      ]),
    );
    expect(likelyDuplicatesOf([[a!, b!], [c!, d!]]).get("d")).toEqual(["c"]);
  });
});
