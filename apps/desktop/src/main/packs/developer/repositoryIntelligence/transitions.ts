import type { RepositoryIndexStatus } from "@eo/core";

/**
 * Which moves between index statuses are legal, and why (EO-145).
 *
 * A table rather than a CHECK constraint, for the reason invariant #1
 * gives about `items.stepId`: the rule is a graph with reasons
 * attached, and SQLite can only express the value set — which is the
 * half that never goes wrong. Keeping it here also keeps it testable
 * without a database, and readable by somebody trying to work out why
 * their status change was refused.
 *
 * The shape of the machine, in words:
 *
 * - A row starts at `not_indexed` and the only useful thing to do with
 *   it is start building (`indexing`). It can also go straight to
 *   `failed`, which is the attempt that never began — an unsupported
 *   platform, a binary that could not be resolved. Recording that as a
 *   failure with a message is what puts the reason in front of a person
 *   instead of leaving a row that looks like nobody tried.
 *
 * - `indexing` and `updating` are the two in-flight statuses and they
 *   are genuinely different. `indexing` builds from nothing, so there
 *   is no index to query while it runs; `updating` refreshes one that
 *   is already usable. They also fail differently, and that difference
 *   is the whole of EO-153's answer to a handover sync that fell over:
 *   `indexing` ends at `ready` or `failed`, `updating` ends at `ready`
 *   or `stale`.
 *
 * - `updating` cannot reach `failed`, and the omission is deliberate.
 *   An update that did not work does not un-build the index that was
 *   already on disk — that directory is still there and still describes
 *   the checkout as it was some moments ago. `failed` says "there is no
 *   index here and the reason is in `error_message`", which would send
 *   a reader looking for something that is in front of them; `stale`
 *   says "there is one and it can no longer be trusted", which is
 *   exactly true and carries the same reason. Both route to the same
 *   fix, so nothing is lost by being accurate about which one happened.
 *
 * - `ready` is the only status in which the index may be queried. It
 *   can go to `updating` (a handover sync), to `indexing` (somebody
 *   asked for a rebuild), or to `stale`.
 *
 * - `stale` means the note no longer describes something usable —
 *   because the resolved binary has moved on from `provider_version`,
 *   because the directory is gone, or because a handover sync could not
 *   bring it up to date and the code has moved on without it. Its only
 *   exit is `indexing`. Not `updating`: an index that is already known
 *   not to describe the checkout is not something to update, and
 *   syncing it would be asking a new binary to reason about an old
 *   graph, which is the migration this design exists to avoid. Trying
 *   the failed sync again is the same bet on the same directory, and
 *   losing it twice is how a reviewer ends up believing an index that
 *   is wrong — which EO-153 opens by saying is worse than having none.
 *
 * - `failed`'s only exit is `indexing` too. There is nothing to sync
 *   after a failure, and going straight to `ready` would be EO
 *   asserting something about a directory it never successfully built.
 *
 * What is deliberately absent is a self-transition anywhere. A sync
 * that finds nothing to do still passes through `updating`, and
 * `ready` -> `ready` would be a write that means nothing — refusing it
 * is how a caller finds out it lost track of what was in flight.
 * Refusing `indexing` -> `indexing` is also the only thing standing
 * between EO and two builds writing to one directory, while
 * concurrency stays at 1 (invariant #10) and nothing else is watching.
 */
export const LEGAL_INDEX_TRANSITIONS: Readonly<Record<RepositoryIndexStatus, readonly RepositoryIndexStatus[]>> = {
  not_indexed: ["indexing", "failed"],
  indexing: ["ready", "failed"],
  ready: ["updating", "indexing", "stale"],
  updating: ["ready", "stale"],
  stale: ["indexing"],
  failed: ["indexing"],
};

export function canTransitionIndex(from: RepositoryIndexStatus, to: RepositoryIndexStatus): boolean {
  return LEGAL_INDEX_TRANSITIONS[from].includes(to);
}

/**
 * Why a move was refused, in words a person could be shown.
 *
 * Returned rather than thrown, and returned as a sentence rather than a
 * code, because it ends up in `error_message` and in a comment. The
 * legal alternatives are named because the interesting refusals are the
 * near-misses — `stale` -> `updating` is a reasonable-looking mistake,
 * and being told `indexing` is the way out is the whole explanation.
 */
export function refuseIndexTransition(from: RepositoryIndexStatus, to: RepositoryIndexStatus): string {
  return `An index cannot move from ${from} to ${to}. From ${from} the legal moves are: ${LEGAL_INDEX_TRANSITIONS[from].join(", ")}.`;
}
