import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");

/**
 * Where an item type is still named by its word, after KAN-146 replaced
 * the container branches with the type row's flag.
 *
 * This is the story's own acceptance criterion made executable, in the
 * shape `itemVocabulary.test.ts` established beside it for KAN-145's. The
 * criterion is a shell command —
 *
 * ```
 * grep -rn '"feature"\|"story"\|"bug"' --include=*.ts --include=*.tsx \
 *   packages apps/desktop/src | grep -v test | grep -v packs/developer
 * ```
 *
 * — and what it returns is the developer pack's seed and the calls that
 * hand one of its slugs to the registry, which is what the criterion
 * allows: *"returns nothing outside the developer pack's seed"*. Nothing
 * in it is a *comparison*; the third test below is what says so, and it is
 * the half of the criterion that belongs to this story.
 *
 * The list is checked in beside this file all the same, for the reason
 * `importAllowlist.test.ts` keeps its own: a criterion that is a shell
 * command is a criterion each of us re-derives, and the set of files that
 * may name a type by word is a thing that should not grow by accident.
 * Every entry names what removes it.
 *
 * ## What the two exclusions are
 *
 * Both are the criterion's own. `packs/developer` is excluded because the
 * pack that ships a type may say its words; the whole point of the design is
 * that *core* stops. `test` is excluded because a test naming a word is
 * testing that word — `containerType.test.ts` asks whether an `epic`
 * behaves like a `feature`, and it cannot ask that without writing both.
 *
 * The second is spelled `grep -v test` and is applied here exactly as the
 * shell applies it: to the whole `path: line`, after the match. That is
 * coarser than "test files" — it also drops `db/testHelpers.ts`, and
 * would drop a source line that merely mentioned a test — and it is
 * reproduced rather than tightened so that this list and the command's
 * output are the same list. Tightening it is a fair thing to want; what
 * it would add today is one prose comment in a test helper, and the third
 * test below is the part of the criterion that a coarse filter could
 * otherwise hide, so it does not go through this one.
 *
 * Build output (`dist`, `out`) is skipped for the same reason
 * `itemVocabulary.test.ts` skips it: a `.d.ts` under `dist` is generated
 * from a source line that is already here, so listing it twice would be
 * one fact with two owners.
 */
const ROOTS = ["packages", join("apps", "desktop", "src")];
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "out", ".turbo", "coverage", "__snapshots__"]);

/** `grep -v packs/developer` — the pack that ships these types may name them. */
const EXCLUDED_PATHS = [join("packs", "developer")];

/** `grep -v test`, on the whole reported line, which is where the shell applies it. */
const EXCLUDED_LINES = ["test"];

/** The criterion's pattern: the word as a written-down string, not as prose or an identifier. */
const TYPE_WORD = /"feature"|"story"|"bug"/;

/** When an entry leaves, and what takes it. `"seed"` is the one the criterion allows to stay. */
type Owner = "seed" | "pack-names-its-own";

interface Group {
  readonly owner: Owner;
  /** What has to happen for these to go, and which story does it. */
  readonly why: string;
  readonly files: readonly string[];
}

/**
 * Every file outside the pack that still writes a type's word, and what
 * removes it.
 *
 * Grouped by departure rather than listed flat, so the list reads as a
 * plan and not as a tally: each group says why its words are there and
 * who takes them away. A file in none of them fails the first test by
 * name, which is what "may not grow by accident" means; a file in one of
 * them that no longer matches fails the second, which is what stops the
 * list outliving the code.
 */
const SCHEDULE: readonly Group[] = [
  {
    owner: "seed",
    why: "The developer pack's seed — the three `ItemTypeEntry` rows `syncItemTypes` writes, which is where the words `feature`, `story` and `bug` are *defined* rather than compared. The criterion allows exactly this: \"returns nothing outside the developer pack's seed\". It stays until the pack's registry contribution moves into `packs/developer/` with the rest of it, which is phase 7's \"delete the directory and typecheck\" — and then it is excluded by path rather than deleted, because a pack naming its own types is the end state, not a leak.",
    files: ["packages/core/src/registry/developer.ts"],
  },
  {
    owner: "pack-names-its-own",
    why: "A caller that knows which pack's type it means says so (KAN-129). These pass a slug *to the registry* — `developerType(\"story\")`, resolved by `resolveItemType` against the project's rows — which is what this story's scope asked of the creation sites, so that a project whose developer types were renamed still works. The word is the resolver's argument, never a comparison: there is no `=== \"story\"` among them. They are developer-pack code that phase 1 left resident in core (`roles/`, and the placeholder backend's canned answers), and the path exclusion collects them when phase 7 moves it. `jobs/thread.ts` joins them for the reason `roles/assist.ts` is there: an off-board thread item wants the read-only shape a container type has — the repository itself rather than a worktree, no branch, no pull request — and `feature` is the container the only installed pack ships. It leaves when a container type can be asked for without naming one, which is the same phase 7 move. `projects/projectThread.ts` (EO-471) is the job thread's arrangement given to a project, and joins for the same reason.",
    files: [
      "apps/desktop/src/main/jobs/thread.ts",
      "apps/desktop/src/main/projects/projectThread.ts",
      "apps/desktop/src/main/providers/demo.ts",
      "apps/desktop/src/main/roles/assist.ts",
      "apps/desktop/src/main/roles/discussion.ts",
      "apps/desktop/src/main/roles/refine.ts",
      // A module's scenario chat (EO-356): an off-board conversation
      // like `roles/assist.ts`, for the same reason and leaving with it.
      "apps/desktop/src/main/roles/scenario.ts",
    ],
  },
];

const ALLOWED = new Set(SCHEDULE.flatMap((group) => group.files));

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/**
 * Every `path: line` a type word is written on, before `grep -v test`.
 *
 * What the comparison check reads, because that check is the one thing a
 * filter on the word "test" could hide: a branch in `fooTest.ts`, or one
 * on a line that happens to mention a test, would vanish from the
 * criterion's output while still deciding behaviour from a word.
 */
function allTypeWordLines(): string[] {
  const lines = new Set<string>();
  for (const root of ROOTS) {
    for (const file of sourceFiles(join(repoRoot, root))) {
      const key = relative(repoRoot, file).split(sep).join("/");
      if (EXCLUDED_PATHS.some((excluded) => key.includes(excluded.split(sep).join("/")))) continue;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (TYPE_WORD.test(line)) lines.add(`${key}: ${line.trim()}`);
      }
    }
  }
  return [...lines].sort();
}

/** And what the criterion's command reports: the above, through `grep -v test`. */
function typeWordLines(): string[] {
  return allTypeWordLines().filter((line) => !EXCLUDED_LINES.some((excluded) => line.includes(excluded)));
}

/** A test asking whether an `epic` behaves like a `feature` has to write both words. */
function isTestFile(key: string): boolean {
  return /\.test\.tsx?$/.test(key);
}

/**
 * Code deciding behaviour from a word — which is what the container flag
 * replaced, and the half of the criterion that is this story's own.
 *
 * A slug written as data (`slug: "story"`, `developerType("feature")`) is
 * the registry being told which type is meant; `=== "feature"` is a
 * branch. Only the second is a site KAN-146 was about.
 */
const COMPARISON = /[!=]==\s*"(?:feature|story|bug)"|"(?:feature|story|bug)"\s*[!=]==/;

/** The files those lines are in — what the schedule is keyed on. */
function typeWordFiles(): string[] {
  return [...new Set(typeWordLines().map((line) => line.slice(0, line.indexOf(": "))))].sort();
}

describe("the words that are left after a container became a flag (KAN-146)", () => {
  /**
   * The half that cannot be argued with: nothing new may name a type by
   * word. A file that appears here and not in the schedule is either a
   * branch that should have read `container`, or a site that belongs to a
   * later story and has to say which.
   */
  it("names every file the criterion still reports, and admits no others", () => {
    expect(typeWordFiles().filter((file) => !ALLOWED.has(file))).toEqual([]);
  });

  /**
   * And the half that keeps the list honest. An entry whose words have
   * gone is an entry to delete, in the same change that deletes them —
   * otherwise the list becomes a record of work somebody already did,
   * which is the one thing nobody reads.
   */
  it("lists nothing that has already been cleaned up", () => {
    const reported = new Set(typeWordFiles());
    expect([...ALLOWED].filter((file) => !reported.has(file)).sort()).toEqual([]);
  });

  /**
   * No comparison survives outside the pack, at all. This is the story's
   * actual subject: a slug handed to the registry is data going in, while
   * `=== "feature"` is code deciding behaviour from a word, and it is the
   * second that the container flag and the spec shape replaced.
   *
   * Stricter than the criterion in one way on purpose — it does not go
   * through `grep -v test`, because a branch on a line that happens to
   * mention a test is exactly what that filter would hide.
   */
  it("leaves no type-word comparison outside the pack", () => {
    const compares = allTypeWordLines()
      .filter((line) => !isTestFile(line.slice(0, line.indexOf(": "))))
      .filter((line) => COMPARISON.test(line));

    expect(compares).toEqual([]);
  });

  /**
   * What is left, in full, so that reading it is something a reviewer
   * does once instead of running a command and judging twenty lines.
   *
   * No line numbers, for the reason `itemVocabulary.txt` carries none: an
   * edit above a line would churn the file, and the question is *which
   * words* are left, not where. Two identical lines in one file therefore
   * collapse to one entry — `discussion.ts` creates a feature twice — so
   * this is the criterion's output as a set.
   */
  it("is the list checked in beside this file", async () => {
    await expect(typeWordLines().join("\n") + "\n").toMatchFileSnapshot(join(here, "itemTypeWords.txt"));
  });

  /**
   * The check is only worth having if it would notice. The criterion
   * greps for the word *as a written-down string*, which is neither prose
   * about a feature nor a qualified type name, and pinning that is what
   * stops the next reader from widening the pattern and drowning the
   * list in comments.
   */
  it("catches a written-down word and steps over prose and qualified names", () => {
    expect(TYPE_WORD.test('if (item.type === "feature")')).toBe(true);
    expect(TYPE_WORD.test('slug: "story",')).toBe(true);
    expect(TYPE_WORD.test('type: "bug" as const')).toBe(true);
    expect(TYPE_WORD.test("// a feature is a container and stories are work")).toBe(false);
    expect(TYPE_WORD.test('qualifiedItemType({ packSlug: "developer", slug })')).toBe(false);
    expect(TYPE_WORD.test('expect(created).toContain("developer:story")')).toBe(false);
  });
});
