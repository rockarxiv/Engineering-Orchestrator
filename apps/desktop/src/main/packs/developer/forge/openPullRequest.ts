import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchExists, commitsAhead, listTree, pushBranch, remoteUrl, showFile } from "../workspace/git.js";
import { buildPullRequestBody, buildPullRequestTitle, type PullRequestFacts } from "./body.js";
import { CLI_FOR, FORGE_COMMANDS, type CliRunner } from "./cli.js";
import { classifyForgeError, missingCli } from "./errors.js";
import { normaliseForgeState } from "./mergeState.js";
import { guessForge, parseRemoteUrl, type ForgeKind } from "./remote.js";
import { findTemplate, type TreeReader } from "./template.js";

/**
 * Opening one pull request (F-06).
 *
 * Everything runs with `cwd = repoPath`, **never the worktree**: the
 * checkout is removed the moment an item goes terminal, and a retry an
 * hour later has to work anyway. A worktree shares the repository's
 * objects and refs, so the branch is fully present in the repository
 * itself.
 *
 * The order is push, look, create, look again. Looking before creating
 * is what stops a second pull request after a crash between `create`
 * succeeding on the server and the key reaching the database; looking
 * after is invariant #5 applied to EO's own action — the URL is read
 * back as a fact rather than scraped out of the command's chatter.
 */

export interface OpenPullRequestInput {
  repoPath: string;
  branch: string;
  baseBranch: string;
  /**
   * What `baseBranch` resolves to as a *local* ref — `origin/main` when
   * the caller resolved it on the remote (`workspace/remoteRef.ts`),
   * `baseBranch` itself by default.
   *
   * Only for the two things this reads out of git: how many commits the
   * branch is ahead, and where the pull request template lives. The forge
   * is still told to open against `baseBranch`, because a remote-tracking
   * ref is not a branch name any forge would accept.
   *
   * Since a branch is now cut from the remote's base branch, a local
   * branch of that name may not exist at all — `rev-list main..branch`
   * against a repository that has never checked `main` out fails, and
   * that read as "no commits to open a pull request for".
   */
  baseRef?: string;
  remote: string;
  /** null asks EO to work it out from the remote's host. */
  forgeKind: ForgeKind | null;
  draft: boolean;
  templatePath: string | null;
  /** The reviewer's prose, when it wrote any. */
  agentBody: string | null;
  implementSummary: string | null;
  itemBody: string | null;
  facts: PullRequestFacts;
  run: CliRunner;
  /** Cancelled with the run opening this, so the push and the CLI stop with it. */
  signal?: AbortSignal;
  /**
   * Adopt only a pull request the forge says is still open (EO-445).
   *
   * Set when the item's recorded pull request has merged or closed and
   * the branch has carried on: the forge's lookup lists every state, so
   * without this the merged one would be found again and "adopted", and
   * the new commits would never get a pull request of their own.
   */
  onlyAdoptOpen?: boolean;
  /**
   * Asked to review a pull request this creates, after it is created
   * (EO-741). Left out or empty, nothing is asked and the commands run
   * are exactly those run before reviewers existed. A pull request that
   * is adopted rather than created is left as it is.
   */
  reviewers?: readonly string[];
}

/** What came of asking for reviewers, on a pull request this created. */
export interface ReviewerRequest {
  /** Asked, and the forge took it. */
  requested: string[];
  /** Asked, and the forge said no — with what it said. */
  refused: { reviewer: string; reason: string }[];
  /** Left out because they opened the pull request, which a forge will not have review their own. */
  author: string | null;
}

export interface OpenPullRequestResult {
  ok: boolean;
  url: string | null;
  /** True when the pull request already existed and was adopted rather than created. */
  adopted: boolean;
  /** True when nobody wrote the prose, so the item can say so. */
  fallbackBody: boolean;
  /** Set when a template directory offered several and none was the default. */
  ambiguousTemplates: string[] | null;
  final: boolean;
  /**
   * True when the push was rejected because the remote branch holds
   * commits the local one does not. The caller decides what that means —
   * for a branch EO cut it is a result of its own rather than a failure
   * (EO-429) — so it is reported apart from `final`, which it also is.
   */
  diverged: boolean;
  error: string;
  /** Null when nobody was to be asked, or the pull request was adopted rather than created. */
  reviewers: ReviewerRequest | null;
}

const OK: Pick<OpenPullRequestResult, "adopted" | "fallbackBody" | "ambiguousTemplates" | "final" | "diverged" | "error" | "reviewers"> = {
  adopted: false,
  fallbackBody: false,
  ambiguousTemplates: null,
  final: false,
  diverged: false,
  error: "",
  reviewers: null,
};

function fail(error: string, final: boolean): OpenPullRequestResult {
  return { ...OK, ok: false, url: null, final, error };
}

export async function openPullRequest(input: OpenPullRequestInput): Promise<OpenPullRequestResult> {
  const { repoPath, branch, baseBranch, remote, run } = input;
  const baseRef = input.baseRef ?? baseBranch;

  // 1. The branch is the deliverable. Without it there is nothing to open.
  if (!(await branchExists(repoPath, branch))) {
    return fail(`The branch \`${branch}\` no longer exists in ${repoPath}, so there is nothing to open a pull request for.`, true);
  }

  // 2. An empty branch would open an empty pull request, which is worse
  //    than none: it looks like work.
  //
  //    "How many commits" and "git could not tell me" are answered
  //    separately, because they were not: `commitsAhead` folded a failed
  //    `rev-list` into a count of zero, so a base ref that does not
  //    resolve — the commonest way for this to go wrong — was reported to
  //    the person as `branch has no commits that base does not already
  //    have`, marked final. That is a sentence about their work, and it
  //    was a sentence about git.
  const ahead = await commitsAhead(repoPath, baseRef, branch);
  if (!ahead.ok) {
    return fail(
      `EO could not count what \`${branch}\` has beyond \`${baseRef}\`, so it did not open a pull request it cannot vouch for: ${ahead.error}`,
      // Not final: an unresolvable ref is usually a fetch that has not
      // happened yet or a remote that was briefly unreachable, and both
      // fix themselves on the next attempt.
      false,
    );
  }
  if (ahead.count === 0) {
    return fail(`\`${branch}\` has no commits that \`${baseRef}\` does not already have.`, true);
  }

  // 3. Where it goes, and which forge that is.
  const url = await remoteUrl(repoPath, remote);
  if (!url.ok) {
    return fail(`No remote named \`${remote}\` in ${repoPath}. The work is committed locally — add a remote, or turn this off in Settings.`, true);
  }

  // The remote url is only needed to *guess* the forge. A repository that
  // has said which it is does not need EO to understand its url — which
  // includes every remote that is not a url at all, like a path to
  // another checkout.
  const forge = input.forgeKind ?? guessForge(parseRemoteUrl(url.stdout)?.host ?? "");
  if (!forge) {
    const host = parseRemoteUrl(url.stdout)?.host;
    return fail(
      host
        ? `EO does not know whether \`${host}\` is GitHub or GitLab. Self-hosted hostnames are arbitrary, and guessing from one is how a merge request ends up on the wrong kind of server — say which it is in Settings → Forge.`
        : `EO could not tell which forge \`${url.stdout}\` is — say which it is in Settings → Forge.`,
      true,
    );
  }

  const cli = CLI_FOR[forge];
  const commands = FORGE_COMMANDS[forge];

  // 4. Publish. Never forced: a diverged remote branch is a human's call.
  const pushed = await pushBranch(repoPath, remote, branch, input.signal ? { signal: input.signal } : {});
  if (!pushed.ok) {
    const classified = classifyForgeError(pushed.error);
    return { ...fail(classified.message, classified.final), diverged: classified.diverged };
  }

  // 5. Is one already open? Covers the crash the database cannot see.
  const existing = await run(cli, commands.find(branch), repoPath, input.signal ? { signal: input.signal } : {});
  if (!existing.ok) {
    const classified = existing.notFound ? missingCli(cli) : classifyForgeError(existing.error);
    return fail(classified.message, classified.final);
  }

  const already = commands.parseFind(existing.stdout);
  if (already && !(input.onlyAdoptOpen && normaliseForgeState(already.state) !== "open")) {
    return { ...OK, ok: true, url: already.url, adopted: true };
  }

  // 6. What it will say.
  const template = await findTemplate({
    reader: treeReader(repoPath),
    ref: baseRef,
    forge,
    override: input.templatePath,
  });

  const body = buildPullRequestBody({
    agentBody: input.agentBody,
    template: template.body,
    implementSummary: input.implementSummary,
    itemBody: input.itemBody,
    facts: input.facts,
  });

  // 7. Create it.
  const directory = await mkdtemp(join(tmpdir(), "eo-pr-"));
  const bodyFile = join(directory, "body.md");
  try {
    await writeFile(bodyFile, body.text, "utf8");

    const created = await run(
      cli,
      commands.create({ branch, base: baseBranch, title: buildPullRequestTitle(input.facts), bodyFile, body: body.text, draft: input.draft }),
      repoPath,
      input.signal ? { signal: input.signal } : {},
    );

    if (!created.ok) {
      const classified = created.notFound ? missingCli(cli) : classifyForgeError(created.error);
      return { ...fail(classified.message, classified.final), ambiguousTemplates: template.ambiguous };
    }

    // 8. Read the URL back rather than trusting what create printed —
    //    stdout also carries warnings and notifier noise. Asking for the
    //    author too when there are reviewers to ask, since it is the one
    //    of them a forge will refuse.
    const reviewers = input.reviewers ?? [];
    const readBack = await run(cli, commands.find(branch, reviewers.length > 0), repoPath, input.signal ? { signal: input.signal } : {});
    const found = readBack.ok ? commands.parseFind(readBack.stdout) : null;
    const url = found?.url ?? lastUrlIn(created.stdout);

    // 9. Who reviews it. After the create, and in a command of its own,
    //    so a reviewer the forge refuses cannot read as a create that
    //    failed: the pull request is open either way (EO-741).
    const requested = reviewers.length > 0 ? await requestReviewers(input, cli, commands, url, found?.author ?? null, reviewers) : null;

    return {
      ...OK,
      ok: true,
      url,
      fallbackBody: body.fallback,
      ambiguousTemplates: template.ambiguous,
      reviewers: requested,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Asks the forge for `reviewers` on the pull request at `url`.
 *
 * All of them in one command first, which is the whole of it when the
 * forge takes them. A forge refuses the command entire for one handle it
 * will not take, and its answer does not always say which, so a refusal
 * is followed by one command per reviewer — asking again for one already
 * asked is harmless, since both CLIs add — and each refusal is then
 * attributed to the reviewer it was about.
 */
async function requestReviewers(
  input: OpenPullRequestInput,
  cli: string,
  commands: (typeof FORGE_COMMANDS)[ForgeKind],
  url: string | null,
  author: string | null,
  reviewers: readonly string[],
): Promise<ReviewerRequest> {
  // Compared without case: a GitHub login is case-insensitive.
  const isAuthor = (reviewer: string) => author !== null && reviewer.toLowerCase() === author.toLowerCase();
  const asking = reviewers.filter((reviewer) => !isAuthor(reviewer));
  const left = reviewers.find(isAuthor) ?? null;
  const outcome: ReviewerRequest = { requested: [], refused: [], author: left };
  if (asking.length === 0) return outcome;

  if (url === null) {
    const reason = "EO could not read the pull request back after creating it, so it had nothing to ask the forge about.";
    return { ...outcome, refused: asking.map((reviewer) => ({ reviewer, reason })) };
  }

  const ask = async (group: readonly string[]): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const args = commands.requestReviewers(url, group);
    if (args === null) return { ok: false, reason: `EO could not tell which pull request ${url} is, so it could not name it to \`${cli}\`.` };
    const answered = await input.run(cli, args, input.repoPath, input.signal ? { signal: input.signal } : {});
    if (answered.ok) return { ok: true };
    return { ok: false, reason: answered.error.trim() || `\`${cli}\` refused without saying why.` };
  };

  const together = await ask(asking);
  if (together.ok) return { ...outcome, requested: [...asking] };
  if (asking.length === 1) return { ...outcome, refused: [{ reviewer: asking[0]!, reason: together.reason }] };

  for (const reviewer of asking) {
    const alone = await ask([reviewer]);
    if (alone.ok) outcome.requested.push(reviewer);
    else outcome.refused.push({ reviewer, reason: alone.reason });
  }
  return outcome;
}

/** The one seam through which template discovery reaches git. */
function treeReader(repoPath: string): TreeReader {
  return {
    showFile: async (ref, path) => {
      const result = await showFile(repoPath, ref, path);
      return result.ok ? result.stdout : null;
    },
    listTree: async (ref, path) => {
      const result = await listTree(repoPath, ref, path);
      return result.ok && result.stdout !== "" ? result.stdout.split("\n").filter((line) => line !== "") : [];
    },
  };
}

/**
 * Last resort when the read-back fails: the URL the CLI printed.
 *
 * Trailing punctuation is stripped because this may be scraping JSON —
 * a url followed by `","state":"OPEN"}]` is not a url, and handing one
 * to a person as a link is worse than admitting we did not get it.
 */
function lastUrlIn(stdout: string): string | null {
  const matches = stdout.match(/https?:\/\/[^\s"'`,)\]}<>]+/g);
  return matches?.at(-1) ?? null;
}
