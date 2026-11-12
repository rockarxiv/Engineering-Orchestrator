import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { git } from "./git.js";

/**
 * Keeping EO's own generated directories out of a checkout's `git
 * status` (EO-207).
 *
 * EO writes two things inside a worktree it does not own: the generated
 * repository index, and the skills a Codex-backed agent reads
 * (`.agent/`). Both are EO's, neither is the person's work, and until
 * this file existed neither was excluded from anything. The index stayed
 * out of commits only because implementers kept remembering — the EO-201
 * handover ends with "left untracked and never staged", which is a guard
 * held up by agent discipline and exactly what invariant 8 is against. It
 * already cost something real: deleting EO-206 was refused with "There is
 * uncommitted work in EO-206 (1 uncommitted change)", and the change was
 * the index directory.
 *
 * A third directory goes the same way and for the same reason (EO-413):
 * the one an agent puts files in that are for the ticket and not for the
 * branch (`ticketFiles.ts`). EO does not generate what is in it, but the
 * promise is identical — git never sees it — and so is the failure
 * without it: a screenshot one `git add -A` from the diff under review.
 *
 * This file names none of them. All arrive as arguments, from the
 * modules that own them — an index directory is whichever provider is
 * configured, and no file outside `repositoryIntelligence/` may know
 * which, which an invariant test in that directory enforces by scanning
 * the tree for the name.
 *
 * **Never a `.gitignore`.** That is a tracked file in somebody's
 * repository: editing one writes into their project to suit EO's
 * plumbing, and it lands in the diff under review. `info/exclude` is
 * untracked, is invisible to the repository's history, and is what git
 * documents for exactly this — "patterns which are specific to a
 * particular repository but which do not need to be shared".
 *
 * **It is per-repository, not per-worktree, and that correction is
 * load-bearing.** EO-207 was written expecting a linked worktree to have
 * an `info/exclude` of its own; it does not. Git's own list of
 * per-worktree paths (`common_list` in `path.c`) holds `info/` as
 * *common* with a single exception, `info/sparse-checkout`, so
 * `$GIT_DIR/info/exclude` for a linked worktree resolves through
 * `commondir` to the main repository's copy. Writing there is therefore
 * visible in every worktree of that repository including the person's
 * own checkout — which is why the resolution goes through `git rev-parse
 * --git-path` rather than joining `.git/info/exclude` onto the worktree
 * path (in a linked worktree `.git` is a *file*, so that join does not
 * even name a directory), and why the banner below says who wrote the
 * lines and that they can be removed.
 *
 * What survives the correction is the reason the route was chosen: the
 * file is untracked, is never part of a commit, and appears in nobody's
 * diff. What does not survive is the idea that this is scoped to one
 * item's checkout. Three earlier notes in this codebase
 * (`agentAttachments/pluginDirectory.ts`, `repositoryIntelligence/indexPaths.ts`,
 * and the hooks note beside it) rejected `info/exclude` on that ground,
 * and they were right about the mechanism. EO-207 overrides the conclusion rather
 * than the fact: two lines naming directories EO generates are worth the
 * scope, and a directory nothing excludes is a wart every future
 * implementer has to remember.
 *
 * The exclusion is additive and never rewrites what is there. An
 * `info/exclude` a person has written into keeps every line of it, in
 * order, and a second call adds nothing — which matters because this
 * runs on every dispatch's worktree preparation rather than once.
 */

/** What EO writes above its own lines, so a reader knows where they came from. */
export const EO_EXCLUDE_BANNER = "# Added by EO for the directories it generates inside a checkout. Safe to delete.";

/** What went into the file, or why nothing could. */
export type ExcludeOutcome = { ok: true; added: string[]; file: string } | { ok: false; reason: string };

/**
 * The pattern one directory name becomes.
 *
 * A trailing slash, so it matches a directory and not a file of the same
 * name. **Anchored with a leading slash**, so it matches only at the top
 * of the working tree — which is the one place EO writes either of
 * these.
 *
 * The anchor is not tidiness. `worktrees.test.ts` holds EO to leaving a
 * `vendor/<same-name>/` somebody else put there exactly where it is:
 * `removeWorktree` refuses over it, because a checkout holding something
 * EO did not generate is not a checkout EO may clear by hand. An
 * unanchored pattern hides that directory from `git status`, git then
 * raises no objection to removing the worktree, and the person's files
 * go with it — a silent deletion introduced by an exclusion meant to be
 * invisible. Anchoring keeps the exclusion to EO's own directory and
 * leaves every namesake below it visible.
 */
function patternFor(directory: string): string {
  const trailing = directory.endsWith("/") ? directory : `${directory}/`;
  return trailing.startsWith("/") ? trailing : `/${trailing}`;
}

/**
 * Where git actually reads this repository's exclude file from.
 *
 * Asked rather than constructed, because the answer differs by checkout
 * kind and the wrong one is silent: `<worktree>/.git/info/exclude` is a
 * path through a *file* in a linked worktree, so writing it fails with
 * ENOTDIR, and reading it finds nothing. `--git-path` resolves through
 * `commondir` the way every other git command does, and returns a path
 * relative to the invocation's own directory when the git dir is
 * relative — which is the ordinary case in a non-linked checkout.
 */
async function excludeFilePath(worktreePath: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const found = await git(["rev-parse", "--git-path", "info/exclude"], worktreePath);
  if (!found.ok) return { ok: false, reason: found.error };
  const raw = found.stdout.trim();
  if (raw === "") return { ok: false, reason: "git did not say where info/exclude is." };
  return { ok: true, path: isAbsolute(raw) ? raw : join(worktreePath, raw) };
}

/**
 * Adds a pattern per directory to the checkout's exclude file, for the
 * ones that are not already in it.
 *
 * Refuses rather than throws, and the caller decides what a refusal is
 * worth: worktree preparation reports it and carries on, because a
 * checkout without the exclusion still works — `verify.ts` already steps
 * over a repository index by path, and a Codex agent still reads its
 * skills off disk. What is lost is only that the directories show up in
 * `git status`, which is a thing to say rather than a thing to fail a
 * dispatch over.
 */
export async function excludeGeneratedDirectories(worktreePath: string, directories: readonly string[]): Promise<ExcludeOutcome> {
  const file = await excludeFilePath(worktreePath);
  if (!file.ok) return file;

  let current: string;
  try {
    current = readFileSync(file.path, "utf8");
  } catch {
    // No file yet is the ordinary case for a repository nobody has
    // excluded anything in — `git init` writes one, but a clone need not
    // have kept it.
    current = "";
  }

  const present = new Set(current.split("\n").map((line) => line.trim()));
  const missing = directories.map(patternFor).filter((pattern) => !present.has(pattern));
  if (missing.length === 0) return { ok: true, added: [], file: file.path };

  const head = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  const banner = current.includes(EO_EXCLUDE_BANNER) ? "" : `${EO_EXCLUDE_BANNER}\n`;
  try {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, `${head}${banner}${missing.join("\n")}\n`, "utf8");
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, added: missing, file: file.path };
}
