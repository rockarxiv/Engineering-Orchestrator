import type { MergeState } from "../workspace/stackDecision.js";
import { fetchBranch, isAncestor, remoteUrl, type NetworkGitOptions } from "../workspace/git.js";
import { resolveRemoteRef } from "../workspace/remoteRef.js";
import { CLI_FOR, FORGE_COMMANDS, type CliRunner } from "./cli.js";
import { guessForge, parseRemoteUrl, type ForgeKind } from "./remote.js";

/**
 * Resolving one same-feature dependency's merge state (EO-10 / KAN-42).
 *
 * Forge state first, reusing the exact `find`/`parseFind` mechanism
 * `openPullRequest.ts` already uses to look up an existing pull
 * request — same CLI, same JSON shape, so there is nothing new for
 * `gh`/`glab` to get right. Falls back to a local git check only when
 * that lookup can't be completed: no forge configured (and none
 * guessable from the remote), the CLI isn't installed, it exited
 * non-zero, or it answered with a state EO doesn't recognise.
 *
 * The fallback can only ever report `'merged'` or `'open'` — see
 * `isAncestor` in `workspace/git.ts`. Never `'closed'`: a local git
 * check has no way to tell a still-open MR apart from one closed
 * without merging, and guessing "closed" would send the resolver
 * straight to an escalation for a dependency that may simply still be
 * in flight.
 */
export interface ResolveMergeStateInput {
  repoPath: string;
  /** The dependency item's branch. */
  branch: string;
  /** What "merged" means: is `branch`'s tip an ancestor of this? */
  baseBranch: string;
  remote: string;
  /** null asks EO to work it out from the remote's host, as `openPullRequest` does. */
  forgeKind: ForgeKind | null;
  run: CliRunner;
  /**
   * Cancelled with the run this is resolving for.
   *
   * Both halves of this reach the network — a forge lookup and a `git
   * fetch` — so both take it. Resolving a merge state is the slowest
   * thing `create_worktree` does, and until it was threaded a cancel
   * left it running against a forge nobody was waiting on.
   */
  signal?: AbortSignal;
}

export async function resolveMergeState(input: ResolveMergeStateInput): Promise<MergeState> {
  const { repoPath, branch, baseBranch, remote } = input;
  const options: NetworkGitOptions = input.signal ? { signal: input.signal } : {};

  const forgeState = await forgePullRequestState(input);
  if (forgeState) return forgeState.state;

  return gitFallback(repoPath, remote, branch, baseBranch, options);
}

export type ForgePullRequestStateInput = Omit<ResolveMergeStateInput, "baseBranch">;

/**
 * What the forge says about `branch`'s newest pull request, and nothing
 * else: no git fallback, because a caller asking "is the pull request I
 * recorded still open?" (EO-445) learns nothing from whether a tip is an
 * ancestor of the base — a branch with a new commit on top of a merged
 * one reads as `open` there.
 *
 * Null when the forge could not be asked or did not answer with a pull
 * request in a state EO recognises.
 */
export async function forgePullRequestState(input: ForgePullRequestStateInput): Promise<{ url: string; state: MergeState } | null> {
  const { repoPath, branch, remote, run } = input;
  const forge = input.forgeKind ?? (await guessForgeFromRemote(repoPath, remote));
  if (!forge) return null;
  return lookUpForgeState(forge, branch, repoPath, run, input.signal);
}

async function guessForgeFromRemote(repoPath: string, remote: string): Promise<ForgeKind | null> {
  const url = await remoteUrl(repoPath, remote);
  if (!url.ok) return null;
  return guessForge(parseRemoteUrl(url.stdout)?.host ?? "");
}

/** Null means the lookup couldn't be completed — the caller falls back to git. */
async function lookUpForgeState(
  forge: ForgeKind,
  branch: string,
  repoPath: string,
  run: CliRunner,
  signal?: AbortSignal,
): Promise<{ url: string; state: MergeState } | null> {
  const commands = FORGE_COMMANDS[forge];
  const result = await run(CLI_FOR[forge], commands.find(branch), repoPath, signal ? { signal } : {});
  if (!result.ok) return null; // CLI missing, or it exited non-zero

  const found = commands.parseFind(result.stdout);
  if (!found) return null; // nothing to normalise

  const state = normaliseForgeState(found.state);
  return state ? { url: found.url, state } : null;
}

/**
 * GitHub's `gh pr list --json state` answers OPEN / MERGED / CLOSED.
 * GitLab's `glab mr list --output json` answers opened / merged /
 * closed. Normalised case-insensitively so either vocabulary lands on
 * the same three values.
 */
export function normaliseForgeState(raw: string): MergeState | null {
  switch (raw.toLowerCase()) {
    case "merged":
      return "merged";
    case "open":
    case "opened":
      return "open";
    case "closed":
      return "closed";
    default:
      return null;
  }
}

/**
 * Fetches the dependency's branch and checks whether it has already
 * landed on the base branch. Never reports `'closed'` — see the module
 * doc — and a fetch that fails (branch gone, remote unreachable) is
 * treated the same as "not yet merged" rather than escalated here; the
 * resolver that consumes this is where "we genuinely don't know" gets a
 * human's attention, not this adapter.
 *
 * "Landed" means landed on the *remote's* base branch. Against a local
 * `main` that is a week behind, every dependency that has merged since
 * still reads as `'open'`, and the dependent story goes on being stacked
 * on a branch whose commits are already in the base — which is precisely
 * the case this check exists to catch. Falls back to the local branch only
 * when the remote cannot answer, for the same reason the rest of this
 * function does: a merge state EO is unsure of is not this adapter's to
 * escalate.
 *
 * The base ref is resolved *before* the dependency's branch is fetched,
 * because both fetches write `FETCH_HEAD` and the dependency's tip is the
 * one that has to survive to the comparison below.
 */
async function gitFallback(repoPath: string, remote: string, branch: string, baseBranch: string, options: NetworkGitOptions): Promise<MergeState> {
  const base = await resolveRemoteRef(repoPath, remote, baseBranch, options);
  const baseRef = base.kind === "remote" ? base.ref : baseBranch;

  const fetched = await fetchBranch(repoPath, remote, branch, options);
  if (!fetched.ok) return "open";
  return (await isAncestor(repoPath, "FETCH_HEAD", baseRef)) ? "merged" : "open";
}
