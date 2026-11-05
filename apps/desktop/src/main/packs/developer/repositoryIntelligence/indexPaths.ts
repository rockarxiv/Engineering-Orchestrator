import { rm } from "node:fs/promises";
import { join } from "node:path";
import { REPOSITORY_INDEX_DIRECTORIES } from "./composition.js";

/**
 * The generated repository index, and why EO's own checks step over it.
 *
 * An index lands inside the checkout it describes, in a directory at the
 * root of it. *Which* directory is the implementation's answer and not
 * this file's — a provider is free to call it whatever it likes, and the
 * one place those answers are collected is the composition root
 * (EO-163). Everything here works from
 * `REPOSITORY_INDEX_DIRECTORIES` and would keep working, unchanged, for
 * a provider that had never been written when this was.
 *
 * Why any of it is needed: `workspace/verify.ts` fails the `clean` step
 * on any non-empty `git status --porcelain` and untracked entries count,
 * so without this every run with indexing enabled would fail
 * verification.
 *
 * The predicates live here rather than beside the checks that call them
 * because `workspace/` is EO's own git plumbing and has no business
 * knowing that repository intelligence exists at all, which is what the
 * invariants beside this file say and what `importSites.test.ts`
 * enforces. The checks import the two predicates and stay ignorant of
 * the answer — and so, now, does this file.
 *
 * `.git/info/exclude` was rejected here twice before EO-207 took it, and
 * the fact those refusals rested on is still true: in a linked worktree
 * `info/` resolves through `commondir` to the main repository's copy, so
 * it is per-repository rather than per-worktree. What EO-207 changed is
 * the conclusion drawn from it — two anchored lines naming directories
 * EO generates are worth that scope, against an index nothing excluded
 * at all and that stayed out of commits only because implementers kept
 * remembering. `workspace/excludes.ts` is where it is done and why. A `.gitignore` is still refused outright: that is a
 * tracked file in somebody's repository and would land in the diff under
 * review.
 *
 * This file stays regardless, and not only as belt and braces. The
 * exclusion is a write that can fail, a checkout EO adopted rather than
 * cut may never have had it, and a person is entitled to delete the
 * lines; none of those should turn every indexed run's `clean` step
 * red. It is also the narrower rule of the two — the exclusion is
 * anchored at the checkout root, and this matches an index directory
 * wherever a provider decides to put one.
 *
 * This narrows rather than blunts. Only paths inside a directory an
 * implementation actually writes an index into are stepped over: a
 * worktree holding both an index and a genuinely uncommitted source file
 * still fails `clean`, and the failure names the source file without
 * mentioning the index.
 *
 * Stepping over one is not always enough, which is what `discardRepositoryIndexes`
 * below is for (EO-170). EO's own checks are not the only thing that
 * refuses on an untracked directory — git does too, and `git worktree
 * remove` declines to remove a tree with one sitting in it. A check
 * taught to ignore the index therefore hands a worktree git will still
 * not let go of to the next step, so the disposal lives here beside the
 * predicates, against the same list, rather than as a literal spelled
 * out at the call site.
 */

/**
 * Is this a path inside a generated index?
 *
 * By path *segment*, the way `workspace/borrowed.ts` already skips
 * `node_modules` and `dist` — the two checks then agree on what an index
 * is regardless of where a provider decides to root it. A file merely
 * *named* like an index directory — `src/.index-notes.ts` beside an
 * index rooted at `.index` — is somebody's work and is not matched.
 *
 * Git prints porcelain and diff paths with forward slashes on every
 * platform, and C-quotes a path that needs escaping. An index directory
 * is a name an implementation chose for itself and needs no escaping, so
 * a quoted path only ever has an opening quote in front of it to step
 * past — the closing one lands on the final segment, which is a file
 * inside the index rather than the directory being matched.
 */
export function isRepositoryIndexPath(path: string): boolean {
  const bare = path.startsWith('"') ? path.slice(1) : path;
  // A collapsed untracked directory is printed with a trailing slash, so
  // the final segment is empty rather than absent — hence the segment
  // comparison rather than a prefix test.
  return bare.split("/").some((segment) => REPOSITORY_INDEX_DIRECTORIES.includes(segment));
}

/**
 * The paths one `git status --porcelain` line names — two for a rename
 * or a copy, one otherwise.
 *
 * A line is only ever dropped when *every* path it names is in the
 * index, so mis-splitting a filename that itself contains " -> " (git
 * does not quote that) produces two strings that are not index paths and
 * the line is kept. The failure direction is "report it anyway", which
 * is the safe one for a cleanliness check.
 */
function pathsIn(line: string): string[] {
  const rest = line.slice(3); // two status columns and the space after them
  const arrow = rest.indexOf(" -> ");
  return arrow === -1 ? [rest] : [rest.slice(0, arrow), rest.slice(arrow + 4)];
}

/**
 * `git status --porcelain` output with the generated index removed.
 *
 * Empty means clean as far as EO is concerned. What comes back is the
 * original text minus those lines, so the caller can attach it to a
 * failure and have it name only real work.
 */
export function withoutRepositoryIndex(porcelain: string): string {
  return porcelain
    .split("\n")
    .filter((line) => line !== "" && !pathsIn(line).every(isRepositoryIndexPath))
    .join("\n");
}

/** One generated index that would not go, and what stopped it. */
export interface StubbornRepositoryIndex {
  path: string;
  error: string;
}

/**
 * Deletes any generated index at the root of a checkout, answering with
 * the ones still there.
 *
 * Why deleting is safe, where deleting almost anything else in a
 * worktree is not: an index is EO's own output and holds nothing that
 * is not already in the source it was built from, so the worst a
 * mistaken call costs is the time to build another one. That is the
 * whole argument, and it is why this is allowed to run before a removal
 * that may yet be refused — a refusal leaves the checkout and its work
 * exactly as they were, minus a derived file EO will regenerate the
 * next time it wants one.
 *
 * Only the root of the checkout, because that is where an index is
 * written. `isRepositoryIndexPath` matches the same name at any depth
 * on purpose — it decides what EO declines to *call* somebody's work,
 * and being generous there costs nothing. Deleting is the other
 * direction entirely: a nested directory that happens to share the name
 * is somebody's, EO did not put it there, and this walks nowhere near
 * it. Git will refuse the removal over one and say so, which is the
 * right end for a directory nobody can account for.
 *
 * That last sentence is load-bearing rather than reassuring, and it is
 * only true because of `mayClearByHand` in `workspace/worktrees.ts`. A
 * caller whose checks overlook an index-shaped path *anywhere* — which
 * `isRepositoryIndexPath` above is — and which then reads its own
 * verdict as licence to delete would turn git's refusal into a
 * recursive delete of the very directory this was careful not to touch.
 * Being narrow here buys nothing on its own; it buys something because
 * what happens after a refusal is gated on the tree git actually sees.
 *
 * Nothing here is verified by re-reading the disk, and that is not a
 * lapse in invariant #5. The caller's next act is `git worktree
 * remove`, which fails loudly on any untracked directory still in the
 * tree — an independent check by the one party whose opinion decides
 * whether the removal happens. What comes back is only so that a
 * removal git then refuses can name why EO expected it to succeed.
 */
export async function discardRepositoryIndexes(root: string): Promise<StubbornRepositoryIndex[]> {
  const stubborn: StubbornRepositoryIndex[] = [];
  for (const directory of REPOSITORY_INDEX_DIRECTORIES) {
    const path = join(root, directory);
    try {
      // `force` so a checkout that was never indexed — the common case
      // for a provider other than the configured one — is not an error.
      await rm(path, { recursive: true, force: true });
    } catch (failure) {
      stubborn.push({ path, error: failure instanceof Error ? failure.message : String(failure) });
    }
  }
  return stubborn;
}
