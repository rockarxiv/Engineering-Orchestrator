import { describe, expect, it } from "vitest";
import { FALLBACK_SKILL_SLUG, SKILL_SLUG_MAX_LENGTH, SKILL_SLUG_PATTERN, allocateSkillSlugs, slugifySkillName } from "./skillSlugs.js";

/**
 * The pure half of slug allocation (EO-105).
 *
 * In `packages/core`, which imports no `node:*` module and is held to it
 * by its own lint config — so these run with nothing mocked and nothing
 * on disk. What is on disk is the other half's question, and it arrives
 * here as `taken`.
 */
describe("slugifySkillName", () => {
  it("turns a display name into something a model can invoke", () => {
    // The exact bug multica shipped as MUL-5529: "PR review" offered to
    // the model verbatim resolved to nothing it could call.
    expect(slugifySkillName("PR review")).toBe("pr-review");
  });

  it("collapses a run of punctuation into one hyphen and trims the ends", () => {
    expect(slugifySkillName("  PR  --  review!! ")).toBe("pr-review");
    expect(slugifySkillName("(draft) release notes")).toBe("draft-release-notes");
  });

  it("drops accents rather than turning them into hyphens", () => {
    expect(slugifySkillName("Résumé review")).toBe("resume-review");
  });

  it("answers a name with nothing sluggable in it with a real slug", () => {
    // Both are legal display names and both slugify to nothing. A
    // directory has to be called something.
    expect(slugifySkillName("🎉")).toBe(FALLBACK_SKILL_SLUG);
    expect(slugifySkillName("!!!")).toBe(FALLBACK_SKILL_SLUG);
  });

  it("truncates without leaving a trailing hyphen", () => {
    const long = slugifySkillName(`${"a".repeat(SKILL_SLUG_MAX_LENGTH)} review`);

    expect(long).toHaveLength(SKILL_SLUG_MAX_LENGTH);
    expect(long).toMatch(SKILL_SLUG_PATTERN);
  });

  it("always produces something the pattern accepts", () => {
    for (const name of ["PR review", "  ", "🎉", "a".repeat(200), "-leading-and-trailing-", "Ünïcödé_naming 42"]) {
      expect(slugifySkillName(name)).toMatch(SKILL_SLUG_PATTERN);
    }
  });
});

describe("allocateSkillSlugs", () => {
  it("names a batch and gives the same answer every time", () => {
    const batch = [{ name: "PR review" }, { name: "Release notes" }, { name: "PR review" }];

    expect(allocateSkillSlugs(batch)).toEqual(["pr-review", "release-notes", "pr-review-2"]);
    // Deterministic in the strict sense: nothing here reads a clock, a
    // random source or a directory.
    expect(allocateSkillSlugs(batch)).toEqual(allocateSkillSlugs(batch));
  });

  it("avoids what the caller says is already spoken for", () => {
    // The seam. What is on disk is not this function's question — the
    // half that reads the directory answers it and hands it in here.
    expect(allocateSkillSlugs([{ name: "PR review" }], ["pr-review", "pr-review-2"])).toEqual(["pr-review-3"]);
  });

  it("keeps counting past the first free number rather than reusing one", () => {
    expect(allocateSkillSlugs([{ name: "Notes" }, { name: "Notes" }, { name: "Notes" }, { name: "Notes" }])).toEqual([
      "notes",
      "notes-2",
      "notes-3",
      "notes-4",
    ]);
  });

  it("slugifies a slug somebody asked for instead of trusting it", () => {
    expect(allocateSkillSlugs([{ name: "PR review", slug: "Deep Review" }])).toEqual(["deep-review"]);
    // Blank or absent is not a request — the display name decides.
    expect(allocateSkillSlugs([{ name: "PR review", slug: "  " }, { name: "PR review", slug: null }])).toEqual(["pr-review", "pr-review-2"]);
  });

  it("keeps a numbered slug inside the length ceiling", () => {
    // A name already at the ceiling: every collision has to give up
    // characters from the stem to make room for the number.
    const name = "a".repeat(SKILL_SLUG_MAX_LENGTH * 2);

    const allocated = allocateSkillSlugs(Array.from({ length: 12 }, () => ({ name })));

    for (const slug of allocated) {
      expect(slug.length).toBeLessThanOrEqual(SKILL_SLUG_MAX_LENGTH);
      expect(slug).toMatch(SKILL_SLUG_PATTERN);
    }
    expect(new Set(allocated).size).toBe(allocated.length);
  });

  it("gives two unnameable skills two different names", () => {
    expect(allocateSkillSlugs([{ name: "🎉" }, { name: "!!!" }])).toEqual([FALLBACK_SKILL_SLUG, `${FALLBACK_SKILL_SLUG}-2`]);
  });

  it("has nothing to say about an empty batch", () => {
    expect(allocateSkillSlugs([])).toEqual([]);
  });
});
