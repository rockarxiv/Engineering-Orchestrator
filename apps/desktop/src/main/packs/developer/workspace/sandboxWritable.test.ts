import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRepo, run } from "../../../testing/git.js";
import { sandboxWritablePaths } from "./sandboxWritable.js";

/**
 * What a sandboxed agent may write in an item's checkout (EO-934,
 * ARCHITECTURE.md §12.7): exactly the worktree, its own git directory,
 * the common git directory's `objects`, `refs` and `logs`, and the
 * repository's extra writable paths — and never the common directory,
 * its `hooks` or its `config`, through which a hook EO's own push runs
 * would be planted. Worked out from where EO put the checkout and the
 * repository's own checkout, not from anything in the worktree the agent
 * can rewrite, and every path judged where its links lead.
 */
const scratches: string[] = [];

afterEach(() => {
  for (const scratch of scratches.splice(0)) rmSync(scratch, { recursive: true, force: true });
});

function scratch(): string {
  // Native, as EO resolves paths: on Windows the temporary directory is
  // reached through an 8.3 short name (`RUNNER~1`) only it expands.
  const made = realpathSync.native(mkdtempSync(join(tmpdir(), "eo-934-writable-")));
  scratches.push(made);
  return made;
}

/** A repository with a linked worktree on `eo/EO-1`, the way EO lays one out for an item. */
async function linked(): Promise<{ root: string; repo: string; common: string; worktree: string; own: string }> {
  const root = scratch();
  const repo = await makeRepo(root, "repo");
  const worktree = join(root, "worktrees", "EO-1");
  await run(["worktree", "add", "-b", "eo/EO-1", worktree], repo);
  const common = join(repo, ".git");
  return { root, repo, common, worktree, own: join(common, "worktrees", "EO-1") };
}

/** The three things the writable set must never hold, for a common git directory. */
function closed(common: string): string[] {
  return [common, join(common, "hooks"), join(common, "config")];
}

describe("the writable set of a linked worktree", () => {
  it("is exactly the worktree, its own git directory, the common directory's objects, refs and logs, and the extra paths", async () => {
    const { root, repo, common, worktree, own } = await linked();
    const store = join(root, "pnpm-store");
    mkdirSync(store);

    const { paths, problem } = await sandboxWritablePaths(worktree, repo, [store, join(root, "not-made-yet")]);

    expect(problem).toBeNull();
    expect(paths).toEqual([worktree, own, join(common, "objects"), join(common, "refs"), join(common, "logs"), store, join(root, "not-made-yet")]);
    for (const path of closed(common)) expect(paths).not.toContain(path);
  });

  it("lists no git directory of its own for the repository's own checkout, rather than the common one", async () => {
    const repo = await makeRepo(scratch(), "repo");
    const common = join(repo, ".git");

    const { paths } = await sandboxWritablePaths(repo, repo, []);

    expect(paths).toEqual([repo, join(common, "objects"), join(common, "refs"), join(common, "logs")]);
    for (const path of closed(common)) expect(paths).not.toContain(path);
  });

  it("lends only the checkout, with a sentence, where the repository is not one EO knows or git cannot say where its directories are", async () => {
    const { worktree } = await linked();
    const notARepository = scratch();

    for (const repoPath of [null, notARepository]) {
      const { paths, problem } = await sandboxWritablePaths(worktree, repoPath, ["/opt/cache"]);
      expect(paths).toEqual([worktree]);
      expect(problem).toContain("its commits will fail");
    }
  });
});

describe("what the agent could have rewritten (EO-934 review)", () => {
  it("does not follow a checkout's .git file pointed at another repository, and says why", async () => {
    const { root, worktree, repo } = await linked();
    const other = await makeRepo(root, "other");
    // What a command in the sandbox could do to its own checkout.
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(other, ".git")}\n`);

    const { paths, problem } = await sandboxWritablePaths(worktree, repo, []);

    expect(paths).toEqual([worktree]);
    for (const path of closed(join(other, ".git"))) expect(paths).not.toContain(path);
    expect(paths.some((path) => path.startsWith(other))).toBe(false);
    expect(problem).toContain(".git file no longer points at its own git directory");
  });

  it("does not follow a commondir rewritten to name another repository", async () => {
    const { root, worktree, repo, own } = await linked();
    const other = await makeRepo(root, "other");
    writeFileSync(join(own, "commondir"), `${join(other, ".git")}\n`);

    const { paths, problem } = await sandboxWritablePaths(worktree, repo, []);

    expect(paths).toEqual([worktree]);
    expect(problem).toContain("no longer names");
  });

  it("lends no git directory when two worktrees of the repository claim the checkout", async () => {
    const { root, worktree, repo, common } = await linked();
    await run(["worktree", "add", "-b", "eo/EO-2", join(root, "worktrees", "EO-2")], repo);
    // The second worktree's agent rewrote its own record to name the first's checkout.
    writeFileSync(join(common, "worktrees", "EO-2", "gitdir"), `${join(worktree, ".git")}\n`);

    const { paths, problem } = await sandboxWritablePaths(worktree, repo, []);

    expect(paths).toEqual([worktree]);
    expect(problem).toMatch(/more than one worktree/i);
  });

  it("is not moved by a .git file that names the right directory through a relative path", async () => {
    const { worktree, repo, own } = await linked();
    // git itself may write a relative one; it still lands on the same directory.
    writeFileSync(join(worktree, ".git"), `gitdir: ${join("..", "..", "repo", ".git", "worktrees", "EO-1")}\n`);

    expect((await sandboxWritablePaths(worktree, repo, [])).paths).toContain(own);
    expect(readFileSync(join(worktree, ".git"), "utf8")).toContain("..");
  });
});

describe("extra writable paths, judged where their links lead (EO-934 review)", () => {
  // A path below the link is dropped too where it lands inside the common
  // directory; below a link to the repository it lands in the working
  // files, which are not the common directory and not above it.
  it.each([
    ["the common directory itself", (common: string) => common, true],
    ["the repository that holds it", (common: string) => join(common, ".."), false],
    ["its hooks", (common: string) => join(common, "hooks"), true],
    ["its config", (common: string) => join(common, "config"), true],
    ["another worktree's git directory", (common: string) => join(common, "worktrees"), true],
  ])("drops a link to %s, and says so", async (_what, target, below) => {
    const { root, repo, common, worktree, own } = await linked();
    const alias = join(root, "cache");
    symlinkSync(target(common), alias);

    const { paths, problem } = await sandboxWritablePaths(worktree, repo, [alias, ...(below ? [join(alias, "not-made-yet", "deeper")] : [])]);

    expect(paths).toEqual([worktree, own, join(common, "objects"), join(common, "refs"), join(common, "logs")]);
    for (const path of closed(common)) expect(paths).not.toContain(path);
    expect(problem).toContain(`\`${alias}\``);
  });

  it("drops a path through a link whose .. lands in the common directory", async () => {
    const { root, repo, common, worktree } = await linked();
    // `pivot/..` is wherever `pivot` leads, then up: into the repository.
    symlinkSync(join(common, "objects"), join(root, "pivot"));

    const { paths } = await sandboxWritablePaths(worktree, repo, [`${join(root, "pivot")}/../hooks`]);

    expect(paths).not.toContain(join(common, "hooks"));
    expect(paths.filter((path) => path.startsWith(common))).toEqual([join(common, "worktrees", "EO-1"), join(common, "objects"), join(common, "refs"), join(common, "logs")]);
  });

  it("drops a path inside one the agent can already write, which a command could swap for a link", async () => {
    const { root, repo, worktree } = await linked();
    const store = join(root, "store");
    mkdirSync(store);

    const { paths, problem } = await sandboxWritablePaths(worktree, repo, [store, join(store, "inner"), join(worktree, "node_modules")]);

    expect(paths).toContain(store);
    expect(paths).not.toContain(join(store, "inner"));
    expect(paths).not.toContain(join(worktree, "node_modules"));
    expect(problem).toContain("inside a path the agent can already write");
  });

  it.each([
    ["the child listed before its parent", (store: string) => [join(store, "inner"), store]],
    ["the parent listed before its child", (store: string) => [store, join(store, "inner")]],
  ])("drops a path inside another extra path whichever comes first: %s (EO-934 review)", async (_order, listed) => {
    const { root, repo, common, worktree } = await linked();
    const store = join(root, "cache");
    mkdirSync(join(store, "inner"), { recursive: true });

    const before = await sandboxWritablePaths(worktree, repo, listed(store));

    expect(before.paths).toContain(store);
    expect(before.paths).not.toContain(join(store, "inner"));
    expect(before.problem).toContain(`\`${join(store, "inner")}\``);

    // What a command could do through the writable parent: swap the child
    // for a link to the common directory. It was never a root of its own,
    // and the next turn's answer drops it as a link into the common directory.
    rmSync(join(store, "inner"), { recursive: true });
    symlinkSync(common, join(store, "inner"));
    const after = await sandboxWritablePaths(worktree, repo, listed(store));

    expect(after.paths).toContain(store);
    for (const path of closed(common)) expect(after.paths).not.toContain(path);
    expect(after.paths.filter((path) => path.startsWith(common))).toEqual([join(common, "worktrees", "EO-1"), join(common, "objects"), join(common, "refs"), join(common, "logs")]);
  });

  it("lends a path listed twice once", async () => {
    const { root, repo, worktree } = await linked();
    const store = join(root, "store");
    mkdirSync(store);

    const { paths, problem } = await sandboxWritablePaths(worktree, repo, [store, store]);

    expect(paths.filter((path) => path === store)).toHaveLength(1);
    expect(problem).toBeNull();
  });

  it("lends a link to an ordinary directory as the directory it leads to", async () => {
    const { root, repo, worktree } = await linked();
    const real = join(root, "real-cache");
    mkdirSync(real);
    symlinkSync(real, join(root, "cache"));

    const { paths, problem } = await sandboxWritablePaths(worktree, repo, [join(root, "cache")]);

    expect(paths).toContain(real);
    expect(paths).not.toContain(join(root, "cache"));
    expect(problem).toBeNull();
  });
});
