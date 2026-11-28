import { isAbsolute, join, relative, resolve } from "node:path";
import { git } from "./git.js";

/**
 * What a sandboxed agent may write in an item's checkout (EO-934,
 * ARCHITECTURE.md §12.7), worked out by EO for each turn from where the
 * checkout is and what the repository's settings say — never from
 * anything the agent says or writes.
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
 * A checkout that is not a linked worktree has no git directory of its
 * own — its git directory *is* the common one — so none is listed, and
 * a commit there fails inside the sandbox rather than the common
 * directory being opened up. EO's own checkouts are always linked
 * worktrees (G-01).
 *
 * Where git cannot say where the directories are, only the worktree and
 * the extra paths are lent, with a sentence for the thread: a sandboxed
 * agent then cannot commit, and the narrow answer is the safe one.
 */
export async function sandboxWritablePaths(worktree: string, extraWritablePaths: readonly string[]): Promise<{ paths: string[]; problem: string | null }> {
  const extra = extraWritablePaths.filter((path) => isAbsolute(path));
  const found = await git(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], worktree);
  const [gitDir, commonDir] = found.ok ? found.stdout.split("\n").map((line) => line.trim()) : [];
  if (!found.ok || gitDir === undefined || gitDir === "" || commonDir === undefined || commonDir === "") {
    return {
      paths: unique([worktree, ...extra]),
      problem:
        `EO could not find this checkout's git directories (${found.ok ? "git named none" : found.error}), so this sandboxed ` +
        "agent may write only the checkout and the repository's extra writable paths, and its commits will fail.",
    };
  }
  return { paths: sandboxWritableSet(worktree, gitDir, commonDir, extra), problem: null };
}

/**
 * The set itself, from paths already found: pure, so the rule that the
 * common directory, its `hooks` and its `config` are never in it can be
 * held by a test on any input, a hostile extra path included.
 */
export function sandboxWritableSet(worktree: string, gitDir: string, commonDir: string, extraWritablePaths: readonly string[]): string[] {
  const common = resolve(commonDir);
  const own = resolve(gitDir);
  // An extra path a person typed is theirs to choose, but not one that
  // reopens what this rule closes: anything inside the common directory
  // (its hooks, its config, or the parts already listed) or anything
  // that contains it.
  const extra = extraWritablePaths.map((path) => resolve(path)).filter((path) => !isWithin(path, common) && !isWithin(common, path));
  return unique([
    resolve(worktree),
    // A linked worktree's own directory, and nothing when there is none.
    ...(own === common ? [] : [own]),
    join(common, "objects"),
    join(common, "refs"),
    join(common, "logs"),
    ...extra,
  ]);
}

/** Whether `child` is `parent` or below it, comparing whole path components. */
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rest = relative(parent, child);
  return rest !== "" && !rest.startsWith("..") && !isAbsolute(rest);
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}
