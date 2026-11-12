import { fetchBranch, refExists, remoteUrl, type NetworkGitOptions } from "./git.js";

/**
 * What a branch name resolves to when the remote — not the local
 * checkout — is the authority on where it points.
 *
 * `no-remote` is a legitimate answer, not a failure: a repository with no
 * configured remote has nothing but its local branches, and EO is usable
 * against one.
 */
export type RemoteRefResolution =
  /**
   * `origin/main` — what a start point or a rebase target should name.
   *
   * `unconfirmed` is set when this call's own fetch failed and the ref is
   * a remote-tracking ref left by an earlier one (EO-364). It is still the
   * best account of the remote there is, which is why the repository's
   * base accepts it — but it is also exactly what a branch deleted
   * upstream leaves behind, so a caller that needs to know the branch is
   * *there now* reads this and refuses. Carries what the fetch said.
   *
   * Without `unconfirmed`, `ref` is what this call's own fetch wrote: the
   * fetch names the tracking ref as its destination, so neither a remote
   * whose fetch refspec leaves the branch out (EO-364) nor another fetch
   * running in the same repository (EO-755) can leave it anywhere else.
   */
  | { kind: "remote"; ref: string; unconfirmed?: string }
  /** No such remote in this repository. The local branch is all there is. */
  | { kind: "no-remote" }
  /** A remote exists, but this branch could not be resolved on it. */
  | { kind: "unresolved"; problem: string };

/** Injectable so a test does not need a real remote to resolve a ref. */
export type RemoteRefResolver = (repoPath: string, remote: string, branch: string, options?: NetworkGitOptions) => Promise<RemoteRefResolution>;

/**
 * Resolves `branch` against `remote`, fetching it first so the answer is
 * current.
 *
 * This exists because every ref EO cuts from, rebases onto, or measures
 * against used to be the *local* branch of that name, and a local branch
 * is whatever the human last left it as: behind the remote, ahead of it
 * with unpushed commits, or absent entirely because they never checked it
 * out. A worktree cut from a stale local `main` starts from work that
 * merged weeks ago, and every rebase and every conflict after it is
 * against the wrong thing.
 *
 * Deliberately resolves to the *remote-tracking* ref rather than updating
 * the local branch. Fast-forwarding a local `main` is a change to the
 * human's checkout, which EO has no business making — and it fails
 * outright when that branch is the one they have checked out, or when
 * they have their own commits on it. `refs/remotes/<remote>/<branch>` is
 * EO's to read and nobody's working copy.
 *
 * A fetch that fails while a tracking ref already exists still resolves
 * to that ref: an unreachable remote makes the tracking ref old, but it
 * is still the best account of the remote there is, and the local branch
 * is not a better one.
 */
export async function resolveRemoteRef(repoPath: string, remote: string, branch: string, options: NetworkGitOptions = {}): Promise<RemoteRefResolution> {
  if (!(await remoteUrl(repoPath, remote)).ok) return { kind: "no-remote" };

  // The one call here that reaches the network, and so the only one that
  // needs a timeout and a way to be cancelled. It writes the tracking ref
  // itself rather than leaving its answer at `FETCH_HEAD`, which any other
  // fetch in this repository — another item's step, running now —
  // replaces (EO-755).
  const fetched = await fetchBranch(repoPath, remote, branch, options);

  const ref = `${remote}/${branch}`;
  if (fetched.ok) return { kind: "remote", ref };
  if (await refExists(repoPath, ref)) return { kind: "remote", ref, unconfirmed: fetched.error };
  return { kind: "unresolved", problem: `\`git fetch ${remote} ${branch}\` failed: ${fetched.error}` };
}
