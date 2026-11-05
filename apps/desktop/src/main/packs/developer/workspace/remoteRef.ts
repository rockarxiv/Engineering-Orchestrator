import { fetchBranch, git, refExists, remoteUrl, type NetworkGitOptions } from "./git.js";

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
   * `fetched` is the commit this call's own fetch brought back, set
   * whenever `ref` is not certain to be it (EO-364): a remote whose fetch
   * refspec does not cover this branch writes `FETCH_HEAD` and leaves an
   * existing `origin/<branch>` wherever an earlier, wider fetch put it, so
   * the tracking ref can be stale *after a successful fetch*. And
   * `FETCH_HEAD` itself is overwritten by the next fetch anyone runs. A
   * caller that must start from what the remote holds now — a base a
   * person named — uses this commit; the repository's base keeps reading
   * `ref`, exactly as it always has.
   */
  | { kind: "remote"; ref: string; unconfirmed?: string; fetched?: string }
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
  // needs a timeout and a way to be cancelled. The two `refExists` reads
  // below are local and return in milliseconds.
  const fetched = await fetchBranch(repoPath, remote, branch, options);

  const ref = `${remote}/${branch}`;
  // What this fetch brought back, as a commit rather than as the name
  // `FETCH_HEAD`, which the next fetch anywhere in this repository
  // overwrites. Only read after a fetch that succeeded — otherwise
  // `FETCH_HEAD` holds whatever some earlier, unrelated fetch left there.
  const tip = fetched.ok ? await commitOf(repoPath, "FETCH_HEAD") : null;

  if (await refExists(repoPath, ref)) {
    if (!fetched.ok) return { kind: "remote", ref, unconfirmed: fetched.error };
    // The fetch succeeded, but that does not prove it moved the tracking
    // ref: a refspec that covers only `main` updates `FETCH_HEAD` and
    // leaves `origin/<branch>` at whatever a wider fetch once wrote.
    // When the two disagree, the fetched commit is the remote's tip.
    if (tip !== null && tip !== (await commitOf(repoPath, ref))) return { kind: "remote", ref, fetched: tip };
    return { kind: "remote", ref };
  }

  // A remote whose fetch refspec writes no remote-tracking ref (a mirror,
  // or a hand-configured remote) still leaves the fetched tip at
  // FETCH_HEAD, which is a perfectly good start point.
  if (tip !== null) return { kind: "remote", ref: "FETCH_HEAD", fetched: tip };

  return {
    kind: "unresolved",
    problem: fetched.ok ? `\`${remote}\` has no branch \`${branch}\`.` : `\`git fetch ${remote} ${branch}\` failed: ${fetched.error}`,
  };
}

/** The commit a ref names, or null when it names none. */
async function commitOf(repoPath: string, ref: string): Promise<string | null> {
  const resolved = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoPath);
  return resolved.ok && resolved.stdout !== "" ? resolved.stdout : null;
}
