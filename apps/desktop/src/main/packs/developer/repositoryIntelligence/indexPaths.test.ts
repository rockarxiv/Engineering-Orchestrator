import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPOSITORY_INDEX_DIRECTORIES } from "./composition.js";
import { discardRepositoryIndexes, isRepositoryIndexPath, withoutRepositoryIndex } from "./indexPaths.js";

/**
 * The line-level half of EO-147. The behaviour a person cares about is
 * pinned against real git in `workspace/verify.test.ts` and
 * `workspace/borrowed.test.ts`;
 * this covers the porcelain shapes those tests cannot conveniently
 * produce — a rename, a lookalike filename, a quoted path — where
 * getting it wrong means either a run that never passes or a check that
 * has quietly stopped checking.
 *
 * Every case is written against whatever the catalogue says an index
 * directory is, rather than against a name typed in here (EO-163). That
 * is not decoration: a test that spelled one implementation's directory
 * would be the same mistake this file's subject used to make, in the
 * place it is least likely to be noticed, and it would go green for a
 * second provider while the checks it stands for had stopped covering
 * one.
 */

/**
 * That there is anything to check at all.
 *
 * Every assertion below is inside a loop over the catalogue, and a loop
 * over nothing passes. This is the one thing that cannot be asserted
 * inside it.
 */
describe("the directories these checks step over", () => {
  it("is not an empty list", () => {
    expect(REPOSITORY_INDEX_DIRECTORIES.length).toBeGreaterThan(0);
  });
});

describe.each(REPOSITORY_INDEX_DIRECTORIES)("isRepositoryIndexPath, for an index at %s", (dir) => {
  it("matches the index directory however git happens to print it", () => {
    expect(isRepositoryIndexPath(dir)).toBe(true);
    expect(isRepositoryIndexPath(`${dir}/`)).toBe(true); // a collapsed untracked directory
    expect(isRepositoryIndexPath(`${dir}/graph/symbols.db`)).toBe(true);
    expect(isRepositoryIndexPath(`"${dir}/wéird name"`)).toBe(true); // C-quoted
  });

  it("leaves alone a file that merely resembles the index", () => {
    expect(isRepositoryIndexPath(`${dir}-notes.md`)).toBe(false);
    expect(isRepositoryIndexPath(`src/${dir}x.ts`)).toBe(false);
    expect(isRepositoryIndexPath(`docs/about${dir}/readme.md`)).toBe(false);
    expect(isRepositoryIndexPath("")).toBe(false);
  });
});

describe.each(REPOSITORY_INDEX_DIRECTORIES)("withoutRepositoryIndex, for an index at %s", (dir) => {
  it("empties a status whose only entry is the index", () => {
    expect(withoutRepositoryIndex(`?? ${dir}/`)).toBe("");
  });

  it("is a no-op on an already clean status", () => {
    expect(withoutRepositoryIndex("")).toBe("");
  });

  it("keeps real work and drops only the index", () => {
    const status = [`?? ${dir}/`, " M src/verify.ts", "?? src/forgotten.ts", "A  src/added.ts"].join("\n");

    expect(withoutRepositoryIndex(status)).toBe([" M src/verify.ts", "?? src/forgotten.ts", "A  src/added.ts"].join("\n"));
  });

  it("keeps a modified tracked file that only looks like the index", () => {
    // Blunting this is how the check stops checking: a path is only
    // stepped over when a whole segment is the index directory.
    expect(withoutRepositoryIndex(` M ${dir}-notes.md`)).toBe(` M ${dir}-notes.md`);
  });

  it("keeps a rename unless both of its paths are inside the index", () => {
    expect(withoutRepositoryIndex("R  src/old.ts -> src/new.ts")).toBe("R  src/old.ts -> src/new.ts");
    expect(withoutRepositoryIndex(`R  src/old.ts -> ${dir}/new.ts`)).toBe(`R  src/old.ts -> ${dir}/new.ts`);
    expect(withoutRepositoryIndex(`R  ${dir}/old.db -> ${dir}/new.db`)).toBe("");
  });
});

/**
 * Disposal (EO-170), against a real directory rather than a mocked
 * filesystem: what is being asserted is which paths survive a delete,
 * and a fake `rm` would only replay whichever answer this file already
 * believes.
 *
 * The behaviour a person meets is pinned in `workspace/worktrees.test.ts`,
 * where a real `git worktree remove` is the thing that either accepts
 * the tree or does not. What is here is the half that is about the
 * disk: exactly one directory goes, and everything a person could have
 * put beside it stays.
 */
describe("discardRepositoryIndexes", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "eo index disposal "));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** An index of the shape a provider writes, one per configured implementation. */
  function plant(root: string): void {
    for (const directory of REPOSITORY_INDEX_DIRECTORIES) {
      mkdirSync(join(root, directory, "graph"), { recursive: true });
      writeFileSync(join(root, directory, "graph", "symbols.db"), "not really sqlite\n");
    }
  }

  it("deletes every configured implementation's index at the root", async () => {
    expect(REPOSITORY_INDEX_DIRECTORIES.length).toBeGreaterThan(0); // never vacuously true
    plant(scratch);

    expect(await discardRepositoryIndexes(scratch)).toEqual([]);

    for (const directory of REPOSITORY_INDEX_DIRECTORIES) expect(existsSync(join(scratch, directory))).toBe(false);
  });

  it("leaves everything that is not an index exactly where it was", async () => {
    plant(scratch);
    mkdirSync(join(scratch, "src"), { recursive: true });
    writeFileSync(join(scratch, "src", "work.ts"), "half-finished\n");
    for (const directory of REPOSITORY_INDEX_DIRECTORIES) writeFileSync(join(scratch, `${directory}-notes.md`), "mine\n");

    await discardRepositoryIndexes(scratch);

    expect(readFileSync(join(scratch, "src", "work.ts"), "utf8")).toBe("half-finished\n");
    for (const directory of REPOSITORY_INDEX_DIRECTORIES) expect(existsSync(join(scratch, `${directory}-notes.md`))).toBe(true);
  });

  it("does not walk into the checkout after directories that merely share the name", async () => {
    // The one place disposal is deliberately narrower than
    // `isRepositoryIndexPath`, which matches the segment at any depth.
    // Being generous about what EO declines to call somebody's work
    // costs nothing; being generous about what it deletes would cost
    // somebody the contents of a directory EO never created.
    for (const directory of REPOSITORY_INDEX_DIRECTORIES) {
      mkdirSync(join(scratch, "vendor", directory), { recursive: true });
      writeFileSync(join(scratch, "vendor", directory, "theirs.txt"), "not EO's\n");
    }

    await discardRepositoryIndexes(scratch);

    for (const directory of REPOSITORY_INDEX_DIRECTORIES) {
      expect(readFileSync(join(scratch, "vendor", directory, "theirs.txt"), "utf8")).toBe("not EO's\n");
    }
  });

  it("is a no-op on a checkout that was never indexed", async () => {
    // The ordinary case with indexing switched off, and the case of a
    // provider other than the configured one: there is nothing at that
    // path and that is not a failure.
    writeFileSync(join(scratch, "README.md"), "# fixture\n");

    expect(await discardRepositoryIndexes(scratch)).toEqual([]);

    expect(existsSync(join(scratch, "README.md"))).toBe(true);
  });

  it("is a no-op on a directory that is not there at all", async () => {
    expect(await discardRepositoryIndexes(join(scratch, "released already"))).toEqual([]);
  });
});
