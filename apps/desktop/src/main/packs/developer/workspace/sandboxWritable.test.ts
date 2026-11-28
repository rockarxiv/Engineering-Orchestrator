import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRepo, run } from "../../../testing/git.js";
import { sandboxWritablePaths, sandboxWritableSet } from "./sandboxWritable.js";

/**
 * What a sandboxed agent may write in an item's checkout (EO-934,
 * ARCHITECTURE.md §12.7): exactly the worktree, its own git directory,
 * the common git directory's `objects`, `refs` and `logs`, and the
 * repository's extra writable paths — and never the common directory,
 * its `hooks` or its `config`, which a hook EO's own push runs would be
 * planted through.
 */
const scratches: string[] = [];

afterEach(() => {
  for (const scratch of scratches.splice(0)) rmSync(scratch, { recursive: true, force: true });
});

function scratch(): string {
  const made = realpathSync(mkdtempSync(join(tmpdir(), "eo-934-writable-")));
  scratches.push(made);
  return made;
}

/** The three things the writable set must never hold, for a common git directory. */
function closed(common: string): string[] {
  return [common, join(common, "hooks"), join(common, "config")];
}

describe("the writable set of a linked worktree", () => {
  it("is exactly the worktree, its own git directory, the common directory's objects, refs and logs, and the extra paths", async () => {
    const root = scratch();
    const repo = await makeRepo(root, "repo");
    const worktree = join(root, "worktrees", "EO-1");
    await run(["worktree", "add", "-b", "eo/EO-1", worktree], repo);
    const common = join(repo, ".git");

    const { paths, problem } = await sandboxWritablePaths(worktree, ["/home/me/.local/share/pnpm/store"]);

    expect(problem).toBeNull();
    expect(paths).toEqual([
      worktree,
      join(common, "worktrees", "EO-1"),
      join(common, "objects"),
      join(common, "refs"),
      join(common, "logs"),
      "/home/me/.local/share/pnpm/store",
    ]);
    for (const path of closed(common)) expect(paths).not.toContain(path);
  });

  it("lists no git directory of its own for a checkout that is not a linked worktree, rather than the common one", async () => {
    const repo = await makeRepo(scratch(), "repo");
    const common = join(repo, ".git");

    const { paths } = await sandboxWritablePaths(repo, []);

    expect(paths).toEqual([repo, join(common, "objects"), join(common, "refs"), join(common, "logs")]);
    for (const path of closed(common)) expect(paths).not.toContain(path);
  });

  it("lends only the worktree and the extra paths, with a sentence, where git cannot say where its directories are", async () => {
    const notARepository = scratch();

    const { paths, problem } = await sandboxWritablePaths(notARepository, ["/opt/cache"]);

    expect(paths).toEqual([notARepository, "/opt/cache"]);
    expect(problem).toContain("its commits will fail");
  });
});

describe("the writable set's rule", () => {
  const common = "/repo/.git";
  const own = "/repo/.git/worktrees/EO-1";

  it.each([
    ["the common directory itself", "/repo/.git"],
    ["its hooks", "/repo/.git/hooks"],
    ["a hook inside them", "/repo/.git/hooks/pre-push"],
    ["its config", "/repo/.git/config"],
    ["the repository that holds it", "/repo"],
    ["the whole disk", "/"],
  ])("drops an extra writable path that is %s", (_what, extra) => {
    const paths = sandboxWritableSet("/wt/EO-1", own, common, [extra, "/home/me/.npm"]);

    for (const path of closed(common)) expect(paths).not.toContain(path);
    expect(paths.some((path) => path === "/" || path === "/repo")).toBe(false);
    expect(paths).toEqual(["/wt/EO-1", own, "/repo/.git/objects", "/repo/.git/refs", "/repo/.git/logs", "/home/me/.npm"]);
  });

  it("keeps an extra path whose name only starts like the common directory's", () => {
    expect(sandboxWritableSet("/wt/EO-1", own, common, ["/repo/.git-cache"])).toContain("/repo/.git-cache");
  });
});
