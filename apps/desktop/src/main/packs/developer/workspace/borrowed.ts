import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { git } from "./git.js";
import { isRepositoryIndexPath, REPOSITORY_INDEX_DIRECTORIES } from "../repositoryIntelligence/index.js";
import { defaultWorktreeRoot } from "./worktrees.js";

/**
 * Files a story added that are byte-identical to another item's
 * in-flight work (KAN-27).
 *
 * The worktree is where an implementer is *pointed*, not a boundary it
 * is held inside: it has the whole filesystem, including every other
 * item's checkout. A real run found this the honest way — a story in
 * one repository vendored a file verbatim out of a sibling story's
 * unmerged branch, cited its commit, and passed review. Good code, but
 * it depended on work nobody had approved yet, and if that review had
 * gone the other way the copy would have outlived the original.
 *
 * Bounding reads was considered and rejected. `additionalDirectories`
 * only widens *within* the working directory; a `canUseTool` deny is
 * evadable through Bash; and confining the process outright breaks git
 * and npm, which legitimately read `~/.gitconfig` and `~/.npm`. So this
 * checks the result instead of policing the act — the same bargain G-02
 * already makes, and the only one that does not overstate what it
 * enforces.
 */

/**
 * Never worth walking, and the reason a naive version of this would take
 * minutes.
 *
 * The generated repository index belongs here for a second reason as
 * well as the first: every worktree is indexed fresh from the same
 * repository, so identical index files across two checkouts are the
 * normal case rather than a signal, and reporting them would bury the
 * one that matters.
 */
const SKIP = new Set([".git", "node_modules", "dist", "build", "out", "target", "vendor-cache", ".next", ".turbo", ...REPOSITORY_INDEX_DIRECTORIES]);
/** A cap so a large sibling checkout cannot turn a cheap check into a slow one. */
const MAX_FILES_SCANNED = 4000;

export interface BorrowedFile {
  /** Path within this story's worktree, as git reports it. */
  path: string;
  /** The item whose worktree holds the identical file. */
  fromItemKey: string;
}

function digest(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * When this path first appeared, as a unix timestamp.
 *
 * Identical files alone cannot say who copied whom — both sides added
 * the same bytes, so a naive check accuses the author as loudly as the
 * copier. Running it against the real KAN-27 artifact showed exactly
 * that: the story that *wrote* the file was reported for borrowing it
 * from the story that copied it.
 *
 * Whoever committed it first wrote it. Null when git cannot say, which
 * is treated as "do not accuse".
 */
async function firstSeenAt(worktreePath: string, path: string): Promise<number | null> {
  const log = await git(["log", "--diff-filter=A", "--format=%ct", "-1", "--", path], worktreePath);
  if (!log.ok) return null;
  const stamp = Number.parseInt(log.stdout.trim().split("\n")[0] ?? "", 10);
  return Number.isFinite(stamp) ? stamp : null;
}

/**
 * Files added on this branch, which is the only place a copy can appear.
 *
 * The index is dropped from this side too, not only from the sibling
 * walk. Skipping it there stops an index matching *another* index, but
 * an index file that happened to match some ordinary file in a sibling
 * would still be reported under its own path inside the index — and
 * nothing under the index is ever somebody's work to have borrowed. It
 * also spares this from reading a multi-megabyte graph in order to hash
 * it.
 */
async function addedFiles(worktreePath: string, baseBranch: string): Promise<string[]> {
  const diff = await git(["diff", "--diff-filter=A", "--name-only", `${baseBranch}...HEAD`], worktreePath);
  if (!diff.ok) return [];
  return diff.stdout.split("\n").filter((line) => line.trim() !== "" && !isRepositoryIndexPath(line));
}

/**
 * Walks a sibling worktree, hashing only files whose size matches
 * something we are actually looking for.
 *
 * The size pre-filter is what keeps this cheap: a repository has
 * thousands of files and a story adds a handful, so almost everything is
 * skipped before it is ever read.
 */
async function matchingHashes(root: string, wantedSizes: Set<number>, budget: { left: number }): Promise<Map<string, string>> {
  /** hash → path within the sibling, kept so we can ask git who had it first. */
  const found = new Map<string, string>();

  async function walk(directory: string): Promise<void> {
    if (budget.left <= 0) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return; // a worktree released mid-check is not an error worth reporting
    }

    for (const entry of entries) {
      if (budget.left <= 0) return;
      if (SKIP.has(entry.name)) continue;
      const full = join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks lead outside, and following them is how a check becomes a hang

      budget.left -= 1;
      try {
        const info = await stat(full);
        if (!wantedSizes.has(info.size)) continue;
        found.set(digest(await readFile(full)), relative(root, full));
      } catch {
        // Unreadable is not suspicious; move on.
      }
    }
  }

  await walk(root);
  return found;
}

export interface BorrowedCheck {
  worktreePath: string;
  itemKey: string;
  baseBranch: string;
  /** Overridable so tests don't touch the real ~/.eo. */
  worktreeRoot?: string;
}

export async function borrowedFromSiblings(options: BorrowedCheck): Promise<BorrowedFile[]> {
  const root = options.worktreeRoot ?? defaultWorktreeRoot();

  const added = await addedFiles(options.worktreePath, options.baseBranch);
  if (added.length === 0) return [];

  // Hash what this story added, indexed by size so the sibling walk can
  // skip almost everything without reading it.
  const bySize = new Map<number, { path: string; hash: string }[]>();
  for (const path of added) {
    try {
      const contents = await readFile(join(options.worktreePath, path));
      const list = bySize.get(contents.length) ?? [];
      list.push({ path, hash: digest(contents) });
      bySize.set(contents.length, list);
    } catch {
      // Added then removed, or unreadable — nothing to compare.
    }
  }
  if (bySize.size === 0) return [];

  let siblings: string[];
  try {
    siblings = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== options.itemKey)
      .map((entry) => entry.name);
  } catch {
    return []; // no worktree root yet, so nothing to have borrowed from
  }

  const wantedSizes = new Set(bySize.keys());
  const borrowed: BorrowedFile[] = [];
  const budget = { left: MAX_FILES_SCANNED };

  for (const sibling of siblings) {
    const siblingRoot = join(root, sibling);
    const hashes = await matchingHashes(siblingRoot, wantedSizes, budget);
    if (hashes.size === 0) continue;

    for (const candidates of bySize.values()) {
      for (const candidate of candidates) {
        const theirPath = hashes.get(candidate.hash);
        if (theirPath === undefined) continue;
        if (borrowed.some((entry) => entry.path === candidate.path)) continue;

        // Only the side that committed it *second* copied. Without this
        // the author is accused as loudly as the copier, which the real
        // case proved is not hypothetical.
        const [mine, theirs] = await Promise.all([
          firstSeenAt(options.worktreePath, candidate.path),
          firstSeenAt(siblingRoot, theirPath),
        ]);
        if (mine === null || theirs === null || theirs >= mine) continue;

        borrowed.push({ path: candidate.path, fromItemKey: sibling });
      }
    }
  }

  return borrowed;
}
