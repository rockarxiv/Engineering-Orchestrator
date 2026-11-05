import { describe, expect, it } from "vitest";
import { matchesFilePattern } from "./fileMatch.js";

/**
 * The patterns agents actually type, on both sides of the line (EO-173).
 *
 * The risk here is not that the idea is wrong — it is that a pattern
 * somebody really typed is answered wrongly, and a wrong answer here is
 * either an interception that should not have fired or a real one that
 * did not. So the cases are drawn from EO's own runs and from the
 * classifier's own tests, not invented.
 */
describe("a filename pattern with no directory in it", () => {
  it.each([
    ["*.test.ts", "apps/desktop/src/main/providers/claude.test.ts"],
    ["*.test.ts", "claude.test.ts"],
    ["claude.ts", "apps/desktop/src/main/providers/claude.ts"],
    ["*.d.ts", "node_modules/@anthropic-ai/index.d.ts"],
    ["claudeSdk", "apps/desktop/src/main/providers/claudeSdk"],
    ["*", "packages/engine/src/routing.ts"],
    ["routing.?s", "packages/engine/src/routing.ts"],
  ])("%s matches %s, because that is what find -name matches", (pattern, path) => {
    expect(matchesFilePattern(path, pattern)).toBe(true);
  });

  it.each([
    ["*.test.ts", "apps/desktop/src/main/providers/claude.ts"],
    ["claude.ts", "apps/desktop/src/main/providers/claudeSdk.ts"],
    // The dot is a dot and not "any character": `claude.ts` must not
    // answer for `claudeXts`, which is what an unescaped pattern does.
    ["claude.ts", "apps/desktop/src/main/providers/claudeXts"],
    ["*.ts", "packages/engine/src"],
    // A filename pattern is about the filename, so a directory called
    // `providers` does not answer a search for a file called that.
    ["providers", "apps/desktop/src/main/providers/claude.ts"],
  ])("%s does not match %s", (pattern, path) => {
    expect(matchesFilePattern(path, pattern)).toBe(false);
  });
});

describe("a pattern with a directory in it", () => {
  it("matches the whole path, because that is what a glob is", () => {
    expect(matchesFilePattern("packages/engine/src/routing.ts", "packages/**/*.ts")).toBe(true);
    expect(matchesFilePattern("apps/desktop/src/main/providers/claude.ts", "packages/**/*.ts")).toBe(false);
  });

  it("lets ** cross separators and * refuse to", () => {
    expect(matchesFilePattern("apps/desktop/src/main/providers/claude.ts", "**/*.ts")).toBe(true);
    expect(matchesFilePattern("apps/desktop/src/main/providers/claude.ts", "apps/*/claude.ts")).toBe(false);
    expect(matchesFilePattern("apps/desktop/claude.ts", "apps/*/claude.ts")).toBe(true);
  });

  it("reads **/ as 'here or anywhere below', not 'somewhere below'", () => {
    // `**/*.ts` is every TypeScript file in the tree. Read as "at least
    // one directory deep", it silently misses the ones at the top — and
    // an index that holds only those would be reported as holding
    // nothing.
    expect(matchesFilePattern("routing.ts", "**/*.ts")).toBe(true);
    expect(matchesFilePattern("packages/engine/src/routing.ts", "packages/**/routing.ts")).toBe(true);
    expect(matchesFilePattern("packages/routing.ts", "packages/**/routing.ts")).toBe(true);
  });

  it("ignores a leading ./ on either side", () => {
    expect(matchesFilePattern("./packages/engine/src/routing.ts", "packages/**/*.ts")).toBe(true);
    expect(matchesFilePattern("packages/engine/src/routing.ts", "./packages/**/*.ts")).toBe(true);
  });
});

describe("a pattern this cannot read", () => {
  /**
   * Every one of these ends in no match, and no match ends in no
   * suggestion. That is the direction this has to fail in: the caller is
   * deciding whether to interrupt an agent, and "EO did not understand
   * the question" is not grounds for answering it.
   */
  it("matches nothing rather than guessing", () => {
    expect(matchesFilePattern("packages/engine/src/routing.ts", "")).toBe(false);
    expect(matchesFilePattern("packages/engine/src/routing.ts", "x".repeat(500))).toBe(false);
  });

  it("treats regular-expression syntax as the literal text it is in a glob", () => {
    // `(a|b)` is a group to a regular expression and four ordinary
    // characters to a glob. Compiling it as the former would match
    // filenames nobody asked about — and `[` alone would not compile at
    // all, which is why this returns rather than throws.
    expect(matchesFilePattern("packages/engine/src/(a|b).ts", "(a|b).ts")).toBe(true);
    expect(matchesFilePattern("packages/engine/src/a.ts", "(a|b).ts")).toBe(false);
    expect(matchesFilePattern("packages/engine/src/routing.ts", "[unclosed")).toBe(false);
  });

  it("keeps a space in a filename a space", () => {
    // EO's own gate fixtures put spaces in directory names on purpose.
    // A rewrite that parked `**` in a space would turn this into "match
    // anything" and quietly agree with every path in the index.
    expect(matchesFilePattern("some notes.md", "some notes.md")).toBe(true);
    expect(matchesFilePattern("someXnotes.md", "some notes.md")).toBe(false);
  });
});

describe("the separator a path was printed with", () => {
  it("matches a Windows path against a pattern typed with forward slashes", () => {
    expect(matchesFilePattern("packages\\engine\\src\\routing.ts", "packages/**/*.ts")).toBe(true);
    expect(matchesFilePattern("packages\\engine\\src\\routing.ts", "*.ts")).toBe(true);
  });
});
