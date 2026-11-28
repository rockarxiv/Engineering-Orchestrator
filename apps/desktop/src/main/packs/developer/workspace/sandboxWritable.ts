import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { whereItLands } from "../../../providers/callFence.js";
import { git } from "./git.js";

/**
 * What a sandboxed agent may write in an item's checkout (EO-934,
 * ARCHITECTURE.md §12.7), worked out by EO for each turn from where the
 * dispatch put the checkout and what the repository's settings say —
 * never from anything the agent says or writes.
 *
 * Exactly: the worktree; the worktree's own git directory
 * (`<common>/worktrees/<name>`, where its index and HEAD live, which a
 * commit writes); the common git directory's `objects`, `refs` and
 * `logs`, which a commit and a fetch write; and the repository's extra
 * writable paths. **Never the common git directory itself**, and so
 * never its `hooks` or its `config`: EO-932's probe found that listing
 * the whole common directory on Codex left `hooks` writable, and a hook
 * planted there is one EO's own push (EO-910) would run outside any
 * sandbox.
 *
 * **Nothing here is read from the worktree as authority** (EO-934
 * review). The worktree and its git directory are the agent's to write,
 * so its `.git` file and its `commondir` could name any repository; git
 * asked from inside it would answer with whatever they say. So the
 * common directory is asked of the repository's own checkout, which no
 * sandboxed agent can write; the worktree's own directory is the one
 * entry under `<common>/worktrees` that names this worktree; and the
 * worktree's `.git` file and that entry's `commondir` must agree with
 * both, or only the worktree is lent and the thread is told why.
 *
 * **Every path is judged where it really lands**, links followed
 * (`whereItLands`), and lent as that: an extra path that is a link to the
 * common directory, or to anything above or inside it, is dropped, and
 * so is one inside another writable path, which a command could replace
 * with such a link before the next one runs.
 *
 * A checkout that is not a linked worktree has no git directory of its
 * own — its git directory *is* the common one — so none is listed, and a
 * commit there fails inside the sandbox rather than the common directory
 * being opened up. EO's own checkouts are always linked worktrees (G-01).
 */
export async function sandboxWritablePaths(worktree: string, repoPath: string | null, extraWritablePaths: readonly string[]): Promise<{ paths: string[]; problem: string | null }> {
  const checkout = await landing(worktree);
  if (checkout === null) return { paths: [worktree], problem: narrowed(`EO could not tell where the checkout ${worktree} is`) };
  const directories = await gitDirectories(checkout, repoPath);
  if (!directories.ok) return { paths: [checkout], problem: narrowed(directories.problem) };
  const { common, own } = directories;

  const git = await Promise.all(["objects", "refs", "logs"].map((name) => landing(join(common, name))));
  const writable = [checkout, ...(own === null ? [] : [own])];
  for (const path of git) {
    // `objects`, `refs` and `logs` are the common directory's own, which
    // no sandboxed agent can change; one that is a link elsewhere is a
    // person's setup, and is lent only where it does not reopen the rest.
    if (path !== null && !reopensGit(path, common)) writable.push(path);
  }

  const dropped: string[] = [];
  for (const extra of extraWritablePaths) {
    const real = isAbsolute(extra) ? await landing(extra) : null;
    if (real === null || isWithin(real, common) || isWithin(common, real) || writable.some((root) => isWithin(real, root))) {
      dropped.push(extra);
      continue;
    }
    writable.push(real);
  }
  return {
    paths: unique(writable),
    problem:
      dropped.length === 0
        ? null
        : `EO did not let this sandboxed agent write ${dropped.map((path) => `\`${path}\``).join(", ")}, from the repository's extra writable paths: ` +
          "each is, or leads by a link to, the repository's git directory or something above it, or is inside a path the agent can already write, or could not be followed.",
  };
}

type GitDirectories = { ok: true; common: string; own: string | null } | { ok: false; problem: string };

/**
 * The common git directory, from the repository's own checkout, and the
 * worktree's own directory under it — cross-checked against what the
 * worktree's `.git` file and that directory's `commondir` say.
 */
async function gitDirectories(checkout: string, repoPath: string | null): Promise<GitDirectories> {
  if (repoPath === null) return { ok: false, problem: "this item's repository is not one EO knows" };
  const asked = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoPath);
  const common = asked.ok && asked.stdout !== "" ? await landing(asked.stdout) : null;
  if (common === null) return { ok: false, problem: `git could not say where ${repoPath}'s git directory is${asked.ok ? "" : ` (${asked.error})`}` };

  // The repository's own checkout: its git directory is the common one.
  if (checkout === (await landing(repoPath))) return { ok: true, common, own: null };

  const dotGit = join(checkout, ".git");
  const entries = await readdir(join(common, "worktrees")).catch(() => [] as string[]);
  const naming: string[] = [];
  for (const entry of entries) {
    const directory = join(common, "worktrees", entry);
    const named = await readFile(join(directory, "gitdir"), "utf8").catch(() => null);
    if (named !== null && (await landing(named.trim(), directory)) === dotGit) naming.push(directory);
  }
  if (naming.length !== 1) {
    return { ok: false, problem: naming.length === 0 ? `no worktree of ${repoPath} is recorded at ${checkout}` : `more than one worktree of ${repoPath} claims ${checkout}` };
  }
  const own = await landing(naming[0] ?? "");
  if (own === null || own === join(common, "worktrees") || !isWithin(own, join(common, "worktrees"))) return { ok: false, problem: `the worktree's git directory under ${common} could not be followed` };

  // What the agent could have rewritten, which must say the same.
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec((await readFile(dotGit, "utf8").catch(() => "")) || "")?.[1];
  if (pointer === undefined || (await landing(pointer, checkout)) !== own) return { ok: false, problem: `the checkout's .git file no longer points at its own git directory under ${common}` };
  const commondir = (await readFile(join(own, "commondir"), "utf8").catch(() => null))?.trim();
  if (commondir === undefined || (await landing(commondir, own)) !== common) return { ok: false, problem: `the checkout's git directory no longer names ${common} as its repository` };
  return { ok: true, common, own };
}

/** Where `path` really lands, relative ones from `base`, or null where that cannot be told. */
async function landing(path: string, base?: string): Promise<string | null> {
  if (path === "") return null;
  const absolute = isAbsolute(path) ? path : base === undefined ? null : `${base}/${path}`;
  if (absolute === null) return null;
  return whereItLands(absolute).catch(() => null);
}

/** Whether lending `path`, where one of `objects`, `refs` or `logs` led, would reopen what the rule closes: the common directory or anything above it, or its hooks or config. */
function reopensGit(path: string, common: string): boolean {
  return isWithin(common, path) || isWithin(path, join(common, "hooks")) || isWithin(path, join(common, "config"));
}

/** Whether `child` is `parent` or below it, comparing whole path components. */
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rest = relative(parent, child);
  return rest !== "" && !rest.startsWith("..") && !isAbsolute(rest);
}

function narrowed(why: string): string {
  return `${why.charAt(0).toUpperCase()}${why.slice(1)}, so this sandboxed agent may write only its checkout, and its commits will fail.`;
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}
