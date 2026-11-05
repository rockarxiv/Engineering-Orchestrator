import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allocateSkillSlugsIn, skillSlugsOnDisk } from "./slugsOnDisk.js";

/**
 * The on-disk half of slug allocation (EO-105).
 *
 * The half that reads a directory, against a real one. The deciding half
 * is unit-tested in `packages/core` with nothing on disk at all, which
 * is the whole point of them being two things.
 */
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eo skill slugs "));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("skillSlugsOnDisk", () => {
  it("reads the slugs a directory has already spent", () => {
    mkdirSync(join(directory, "pr-review"));
    mkdirSync(join(directory, "release-notes"));

    expect(skillSlugsOnDisk(directory)).toEqual(new Set(["pr-review", "release-notes"]));
  });

  it("counts directories only", () => {
    mkdirSync(join(directory, "pr-review"));
    writeFileSync(join(directory, "README.md"), "not a skill");

    // A stray file is not a skill and must not reserve a slug one wants.
    expect(skillSlugsOnDisk(directory)).toEqual(new Set(["pr-review"]));
  });

  it("answers a directory that is not there with nothing", () => {
    // Nothing generated yet is the ordinary case on a first dispatch,
    // not an error every caller should have to catch.
    expect(skillSlugsOnDisk(join(directory, "never-generated"))).toEqual(new Set());
  });
});

describe("allocateSkillSlugsIn", () => {
  it("names a batch around what is on disk", () => {
    mkdirSync(join(directory, "pr-review"));

    expect(allocateSkillSlugsIn(directory, [{ name: "PR review" }, { name: "Release notes" }])).toEqual(["pr-review-2", "release-notes"]);
  });

  it("agrees with the deciding half about a batch colliding with itself", () => {
    expect(allocateSkillSlugsIn(directory, [{ name: "PR review" }, { name: "PR review" }])).toEqual(["pr-review", "pr-review-2"]);
  });

  it("takes slugs that are promised but not yet written", () => {
    // A caller building a directory in more than one pass has already
    // spent names `readdirSync` cannot see.
    expect(allocateSkillSlugsIn(directory, [{ name: "PR review" }], ["pr-review"])).toEqual(["pr-review-2"]);
  });
});
