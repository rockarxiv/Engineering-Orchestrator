/**
 * Where a run on a git workspace puts a file that is for the ticket and
 * not for the branch (EO-413).
 *
 * An agent attaches with `attachment_add` (EO-412), which takes only
 * files inside the directory the run works in. On a git workspace that
 * directory is a checkout, so a screenshot or a captured log written
 * only to be attached sat among the work: `git add -A` committed it, or
 * it lingered untracked, failed the `clean` step and had a release
 * refused for uncommitted work. EO-207 was the same problem for the
 * repository index.
 *
 * So one directory at the top of the checkout is the ticket's and not
 * the branch's. `worktrees.ts` hands the name to `excludes.ts` beside
 * EO's own generated directories — through `info/exclude`, anchored, and
 * never a `.gitignore`, for the reasons that file gives — and
 * `sections.ts` tells the agent once.
 *
 * The name lives here, in the developer pack, and nowhere else. The
 * attachment tool neither knows nor cares: it accepts any regular file
 * inside the run's directory, and this is one. Nothing in
 * `packages/engine` or the core supervisor reads this constant.
 */
export const TICKET_FILES_DIRECTORY = ".eo-attachments";
