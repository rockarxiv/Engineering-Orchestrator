import { describe, expect, it } from "vitest";
import type { CliRunner } from "./cli.js";
import { checkRun, fakeGh, fakeGlab, gitHubState, gitLabState, review, SHA, type GitHubState, type GitLabState } from "./testForges.js";
import {
  GITHUB_WATCH_COMMANDS,
  GITLAB_WATCH_COMMANDS,
  judgePullRequest,
  MAX_PAGES,
  PAGE_SIZE,
  parsePullRequestUrl,
  readPullRequest,
  readyNewsId,
  repeatedFailureNewsId,
  type PullRequestAddress,
  type PullRequestJudgement,
} from "./watchPullRequest.js";

/**
 * Reading a pull request and judging what it means (EO-460), against a
 * scripted `gh` and `glab` that answer in the shapes the real forges do and
 * page their lists as the APIs do (`testForges.ts`). The subjects are which
 * result comes out and in which order the cases win, which ids the news
 * carries, and that every page of a list is read.
 */

const URL = "https://github.com/acme/api/pull/7";
const address = parsePullRequestUrl(URL) as Extract<PullRequestAddress, { forge: "github" }>;
const NEW_SHA = "f".repeat(40);
const STAY = "019f0000-0000-7000-8000-000000000001";

/** Reads the pull request through `run`, and judges it against what earlier checks reported. */
async function judgeWith(run: CliRunner, url: string, options: { reportReady?: boolean; reported?: Iterable<string>; reportedThisStay?: Iterable<string>; checkedThisStay?: boolean; stay?: string } = {}): Promise<PullRequestJudgement> {
  const parsed = parsePullRequestUrl(url)!;
  const reading = await readPullRequest({ address: parsed, url, run, cwd: "/tmp" });
  if (!reading.ok) throw new Error(reading.reason);
  return judgePullRequest(reading.snapshot, { reportReady: options.reportReady ?? false, stay: options.stay ?? STAY, checkedThisStay: options.checkedThisStay ?? false, reported: new Set(options.reported ?? []), reportedThisStay: new Set(options.reportedThisStay ?? []) });
}

const answer = (state: GitHubState, options: { reportReady?: boolean; reported?: Iterable<string>; reportedThisStay?: Iterable<string>; checkedThisStay?: boolean; stay?: string } = {}) => judgeWith(fakeGh(() => state).run, URL, options);

/** What a run of the check would record, for the next check to read back. */
const idsOf = (judged: PullRequestJudgement): string[] => judged.news.map((entry) => entry.id);

const green = checkRun(11, "test", "completed", "success");
const red = checkRun(12, "lint", "completed", "failure");
const running = checkRun(13, "e2e", "in_progress");

describe("parsePullRequestUrl", () => {
  it("reads a GitHub pull request and a GitLab merge request, subgroups included", () => {
    expect(parsePullRequestUrl(URL)).toEqual({ forge: "github", host: "github.com", owner: "acme", repo: "api", number: 7 });
    expect(parsePullRequestUrl("https://gitlab.example.com/group/sub/api/-/merge_requests/12")).toEqual({
      forge: "gitlab",
      host: "gitlab.example.com",
      project: "group/sub/api",
      iid: 12,
    });
    expect(parsePullRequestUrl("not a url")).toBeNull();
  });

  it("takes the repository's word for which forge it is over the address's shape", () => {
    expect(parsePullRequestUrl(URL, "gitlab")).toBeNull();
  });
});

describe("watch_pull_request, asking gh", () => {
  it("asks gh pr view for the pull request, and the REST API for its lists, a page at a time", async () => {
    const forge = fakeGh(() => gitHubState({ checkRuns: [green] }));
    await readPullRequest({ address, url: URL, run: forge.run, cwd: "/tmp" });
    expect(forge.calls).toEqual([
      GITHUB_WATCH_COMMANDS.view(URL),
      GITHUB_WATCH_COMMANDS.reviews(address, 1),
      GITHUB_WATCH_COMMANDS.lineComments(address, 1),
      GITHUB_WATCH_COMMANDS.checkRuns(address, SHA, 1),
      GITHUB_WATCH_COMMANDS.statuses(address, SHA, 1),
    ]);
    expect(forge.calls[0]).toEqual(["pr", "view", URL, "--json", "state,mergeable,mergeStateStatus,reviewDecision,headRefOid"]);
    expect(forge.calls[3]).toEqual(["api", "--hostname", "github.com", `repos/acme/api/commits/${SHA}/check-runs?per_page=100&page=1`]);
  });

  it("reads every page of the line comments, so a comment after the hundredth is still news", async () => {
    const lineComments = Array.from({ length: PAGE_SIZE + 1 }, (_, index) => ({
      id: 1000 + index,
      user: { login: "rev" },
      body: `Comment ${index}`,
      path: "src/a.ts",
      line: index + 1,
      html_url: `https://github.com/acme/api/pull/7#discussion_r${1000 + index}`,
    }));
    const forge = fakeGh(() => gitHubState({ checkRuns: [running], lineComments }));
    const judged = await judgeWith(forge.run, URL);
    expect(forge.calls.filter((args) => args.at(-1)!.includes("/comments"))).toHaveLength(2);
    expect(idsOf(judged)).toContain(`review-comment:${1000 + PAGE_SIZE}`);
    expect(judged.news.find((entry) => entry.id === `review-comment:${1000 + PAGE_SIZE}`)?.text).toContain(`Comment ${PAGE_SIZE}`);
  });

  it("reads every page of the check runs, so a run past the first page still holds the checks open", async () => {
    const passed = Array.from({ length: PAGE_SIZE }, (_, index) => checkRun(100 + index, `shard ${index}`, "completed", "success"));
    const approved = gitHubState({ pr: { reviewDecision: "APPROVED" }, checkRuns: [...passed, running] });
    expect((await answer(approved, { reportReady: true })).result).toBe("waiting");

    const failedLate = gitHubState({ checkRuns: [...passed, red] });
    expect((await answer(failedLate)).result).toBe("checks_failed");
  });

  it("refuses to judge a list longer than it will read, rather than judge part of it", async () => {
    const huge = Array.from({ length: MAX_PAGES * PAGE_SIZE + 1 }, (_, index) => checkRun(index + 1, `shard ${index}`, "completed", "success"));
    const reading = await readPullRequest({ address, url: URL, run: fakeGh(() => gitHubState({ checkRuns: huge })).run, cwd: "/tmp" });
    expect(reading).toMatchObject({ ok: false, problem: "error" });
  });
});

describe("watch_pull_request, judged from what gh says", () => {
  it("answers merged for a merged pull request, whatever else is true of it", async () => {
    const judged = await answer(
      gitHubState({ pr: { state: "MERGED", mergeable: "CONFLICTING", reviewDecision: "CHANGES_REQUESTED" }, checkRuns: [red], reviews: [review(1, "rev", "CHANGES_REQUESTED")] }),
    );
    expect(judged.result).toBe("merged");
  });

  it("answers closed for one closed without merging, ahead of a conflict or a failed check", async () => {
    expect((await answer(gitHubState({ pr: { state: "CLOSED", mergeable: "CONFLICTING" }, checkRuns: [red] }))).result).toBe("closed");
  });

  it("answers conflict when the forge says it cannot merge because of conflicts, ahead of failed checks", async () => {
    const judged = await answer(
      gitHubState({ pr: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", reviewDecision: "CHANGES_REQUESTED" }, checkRuns: [red], reviews: [review(1, "rev", "CHANGES_REQUESTED")] }),
    );
    expect(judged.result).toBe("conflict");
    expect(idsOf(judged)).toContain(`conflict:${SHA}`);
  });

  it("answers checks_failed once every check has finished and one failed, ahead of a request for changes", async () => {
    const judged = await answer(gitHubState({ pr: { reviewDecision: "CHANGES_REQUESTED" }, checkRuns: [green, red], reviews: [review(1, "rev", "CHANGES_REQUESTED")] }));
    expect(judged.result).toBe("checks_failed");
    expect(judged.detail).toContain('"lint"');
  });

  it("goes on waiting while a check is still running, reporting the one that already failed as news under its run id", async () => {
    const judged = await answer(gitHubState({ checkRuns: [red, running] }));
    expect(judged.result).toBe("waiting");
    expect(judged.news).toEqual([{ id: `check:run-12@${SHA}`, text: 'The check "lint" failed: https://github.com/acme/api/actions/runs/1/job/12' }]);
  });

  it("keeps two failed checks that share a name apart, each with its own link", async () => {
    const judged = await answer(gitHubState({ checkRuns: [checkRun(21, "build", "completed", "failure"), checkRun(22, "build", "completed", "failure"), running] }));
    expect(judged.news).toEqual([
      { id: `check:run-21@${SHA}`, text: 'The check "build" failed: https://github.com/acme/api/actions/runs/1/job/21' },
      { id: `check:run-22@${SHA}`, text: 'The check "build" failed: https://github.com/acme/api/actions/runs/1/job/22' },
    ]);
  });

  it("reports a re-run that failed again on the same commit as news, since it is another run", async () => {
    const first = await answer(gitHubState({ checkRuns: [red, running] }));
    const rerun = await answer(gitHubState({ checkRuns: [checkRun(31, "lint", "completed", "failure"), running] }), { reported: idsOf(first) });
    expect(idsOf(rerun)).toEqual([`check:run-31@${SHA}`]);
    const same = await answer(gitHubState({ checkRuns: [red, running] }), { reported: idsOf(first) });
    expect(same.news).toEqual([]);
  });

  it("counts a failed commit status as a failed check", async () => {
    const judged = await answer(gitHubState({ checkRuns: [green], statuses: [{ id: 501, context: "ci/jenkins", state: "error", target_url: "https://ci.example.com/9" }] }));
    expect(judged.result).toBe("checks_failed");
    expect(idsOf(judged)).toContain(`check:status-501@${SHA}`);
  });

  it("answers changes_requested when a reviewer asked for changes and every check passed", async () => {
    const judged = await answer(gitHubState({ pr: { reviewDecision: "CHANGES_REQUESTED" }, checkRuns: [green], reviews: [review(1, "rev", "CHANGES_REQUESTED")] }));
    expect(judged.result).toBe("changes_requested");
    expect(judged.detail).toContain("@rev");
    expect(idsOf(judged)).toContain("changes-requested:1");
  });

  it("reads a request for changes from where each reviewer stands when the repository makes no review decision", async () => {
    const reviews = [review(1, "rev", "APPROVED"), review(2, "rev", "CHANGES_REQUESTED"), review(3, "rev", "COMMENTED", "One more thing.")];
    expect((await answer(gitHubState({ pr: { reviewDecision: "" }, reviews }))).result).toBe("changes_requested");
    // Approving again takes the request back.
    expect((await answer(gitHubState({ pr: { reviewDecision: "" }, checkRuns: [green], reviews: [...reviews, review(4, "rev", "APPROVED")] }), { reportReady: true })).result).toBe("ready");
  });

  it("does not send a fix back for a request it already answered, once the fix is pushed and nobody has reviewed it", async () => {
    const requested = gitHubState({ pr: { reviewDecision: "CHANGES_REQUESTED" }, checkRuns: [green], reviews: [review(1, "rev", "CHANGES_REQUESTED", "Please rename.")] });
    const first = await answer(requested);
    expect(first.result).toBe("changes_requested");

    const pushed = gitHubState({ ...requested, pr: { ...requested.pr, headRefOid: NEW_SHA } });
    expect((await answer(pushed, { reported: idsOf(first) })).result).toBe("waiting");
  });

  it("answers a new request for changes on the same commit, since it is a new review", async () => {
    const requested = gitHubState({ pr: { reviewDecision: "CHANGES_REQUESTED" }, checkRuns: [green], reviews: [review(1, "rev", "CHANGES_REQUESTED")] });
    const first = await answer(requested);
    const again = await answer({ ...requested, reviews: [...requested.reviews, review(2, "rev", "CHANGES_REQUESTED", "Still not right.")] }, { reported: idsOf(first) });
    expect(again.result).toBe("changes_requested");
    expect(idsOf(again)).toContain("changes-requested:2");
  });

  it("does not send the fix back when one of two reviewers who asked together approves, and does for a new request", async () => {
    const together = gitHubState({
      pr: { reviewDecision: "CHANGES_REQUESTED" },
      checkRuns: [green],
      reviews: [review(1, "alice", "CHANGES_REQUESTED"), review(2, "bob", "CHANGES_REQUESTED")],
    });
    const first = await answer(together);
    expect(first.result).toBe("changes_requested");
    expect(idsOf(first)).toEqual(expect.arrayContaining(["changes-requested:1", "changes-requested:2"]));

    // Reworked; Bob approves, Alice's original request still stands.
    const bobApproves = { ...together, pr: { ...together.pr, headRefOid: NEW_SHA }, reviews: [...together.reviews, review(3, "bob", "APPROVED")] };
    expect((await answer(bobApproves, { reported: idsOf(first) })).result).toBe("waiting");

    // Bob asks again: a new request, answered.
    const bobAsksAgain = { ...bobApproves, reviews: [...bobApproves.reviews, review(4, "bob", "CHANGES_REQUESTED", "One more.")] };
    const again = await answer(bobAsksAgain, { reported: idsOf(first) });
    expect(again.result).toBe("changes_requested");
    expect(idsOf(again)).toContain("changes-requested:4");
    expect(idsOf(again)).not.toContain("changes-requested:1");
  });

  it("is never ready while a request for changes stands, even one already answered", async () => {
    const state = gitHubState({ pr: { reviewDecision: "APPROVED" }, checkRuns: [green], reviews: [review(1, "alice", "CHANGES_REQUESTED"), review(2, "bob", "APPROVED")] });
    const first = await answer(state, { reportReady: true });
    expect(first.result).toBe("changes_requested");
    expect((await answer(state, { reportReady: true, reported: idsOf(first) })).result).toBe("waiting");
    // Alice approves: now it is ready.
    expect((await answer({ ...state, reviews: [...state.reviews, review(3, "alice", "APPROVED")] }, { reportReady: true, reported: idsOf(first) })).result).toBe("ready");
  });

  it("answers ready for an approved pull request with every check green only when the step asks for it", async () => {
    const approved = gitHubState({ pr: { reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }, checkRuns: [green] });
    expect((await answer(approved)).result).toBe("waiting");
    const judged = await answer(approved, { reportReady: true });
    expect(judged.result).toBe("ready");
    expect(idsOf(judged)).toContain(readyNewsId(SHA, STAY));
  });

  it("answers ready at most once per head commit per stay", async () => {
    const approved = gitHubState({ pr: { reviewDecision: "APPROVED" }, checkRuns: [green] });
    const first = await answer(approved, { reportReady: true });
    expect((await answer(approved, { reportReady: true, reported: idsOf(first) })).result).toBe("waiting");
    expect((await answer(approved, { reportReady: true, reported: idsOf(first), stay: "a later stay" })).result).toBe("ready");
    const pushed = gitHubState({ ...approved, pr: { ...approved.pr, headRefOid: NEW_SHA } });
    expect((await answer(pushed, { reportReady: true, reported: idsOf(first) })).result).toBe("ready");
  });

  it("does not answer ready while a check is still running, or for one that is not approved", async () => {
    expect((await answer(gitHubState({ pr: { reviewDecision: "APPROVED" }, checkRuns: [green, running] }), { reportReady: true })).result).toBe("waiting");
    expect((await answer(gitHubState({ checkRuns: [green] }), { reportReady: true })).result).toBe("waiting");
  });

  it("waits for an open pull request with nothing wrong with it", async () => {
    expect(await answer(gitHubState({ checkRuns: [green] }))).toEqual({ result: "waiting", detail: expect.stringContaining("waiting for a review"), news: [] });
  });

  it("reports each review comment with its author and text, under the forge's own id", async () => {
    const judged = await answer(
      gitHubState({
        checkRuns: [running],
        reviews: [review(5, "rev", "COMMENTED", "Looks close."), review(6, "rev", "APPROVED")],
        lineComments: [{ id: 901, user: { login: "rev" }, body: "Rename this.", path: "src/a.ts", line: 12, html_url: "https://github.com/acme/api/pull/7#discussion_r901" }],
      }),
    );
    expect(judged.news).toEqual([
      { id: "review:5", text: "@rev commented (https://github.com/acme/api/pull/7#pullrequestreview-5):\n\nLooks close." },
      { id: "review-comment:901", text: "@rev commented on src/a.ts line 12 (https://github.com/acme/api/pull/7#discussion_r901):\n\nRename this." },
    ]);
  });

  it("leaves out news an earlier check already reported, so a second check over the same failure posts nothing new", async () => {
    const state = gitHubState({ checkRuns: [red, running], reviews: [review(5, "rev", "COMMENTED", "Looks close.")] });
    const first = await answer(state);
    expect(first.news).toHaveLength(2);
    expect((await answer(state, { reported: idsOf(first) })).news).toEqual([]);
  });
});

describe("watch_pull_request over a failure already reported (EO-622)", () => {
  const redId = `check:run-12@${SHA}`;
  const finished = gitHubState({ checkRuns: [green, red] });
  const repeatId = repeatedFailureNewsId(SHA, STAY);

  it("waits on the first check of a stay when every failed check was reported, saying so and naming the commit", async () => {
    const judged = await answer(finished, { reported: [redId] });
    expect(judged.result).toBe("waiting");
    expect(judged.detail).toContain("already reported");
    expect(judged.detail).toContain(SHA.slice(0, 12));
    expect(judged.detail).toContain('"lint"');
    expect(judged.news).toEqual([]);
  });

  it("answers checks_failed on the next check, saying the same failure stands and CI was not restarted", async () => {
    const judged = await answer(finished, { reported: [redId], checkedThisStay: true });
    expect(judged.result).toBe("checks_failed");
    expect(judged.news).toEqual([{ id: repeatId, text: `CI was not restarted: "lint" on ${SHA.slice(0, 12)} still shows the failure reported before this ticket last came back.` }]);
  });

  it("names every repeated check, and says so once on a stay", async () => {
    const other = checkRun(15, "build", "completed", "failure");
    const reported = [redId, `check:run-15@${SHA}`];
    const judged = await answer(gitHubState({ checkRuns: [red, other] }), { reported, checkedThisStay: true });
    expect(judged.news[0]?.text).toContain('"lint", "build"');
    const again = await answer(gitHubState({ checkRuns: [red, other] }), { reported: [...reported, ...idsOf(judged)], checkedThisStay: true });
    expect(again.result).toBe("checks_failed");
    expect(again.news).toEqual([]);
  });

  it("gives each stay its own id, so a later repeat is said again rather than de-duplicated", async () => {
    const later = await answer(finished, { reported: [redId, repeatId], checkedThisStay: true, stay: "019f0000-0000-7000-8000-000000000002" });
    expect(idsOf(later)).toEqual([repeatedFailureNewsId(SHA, "019f0000-0000-7000-8000-000000000002")]);
  });

  it("answers checks_failed at once for a failure not reported before, on the first check of a stay", async () => {
    const judged = await answer(finished);
    expect(judged.result).toBe("checks_failed");
    expect(idsOf(judged)).toEqual([redId]);
  });

  it("answers checks_failed at once when only some of the failures were reported, and names only those as repeated", async () => {
    const fresh = checkRun(15, "build", "completed", "failure");
    const judged = await answer(gitHubState({ checkRuns: [red, fresh] }), { reported: [redId] });
    expect(judged.result).toBe("checks_failed");
    expect(idsOf(judged)).toEqual([`check:run-15@${SHA}`, repeatId]);
    expect(judged.news[1]?.text).toContain('CI was not restarted: "lint" on');
    expect(judged.news[1]?.text).not.toContain("build");
  });

  it("takes a re-run that failed for a new failure, since it is another run", async () => {
    const rerun = await answer(gitHubState({ checkRuns: [green, checkRun(31, "lint", "completed", "failure")] }), { reported: [redId] });
    expect(rerun.result).toBe("checks_failed");
    expect(idsOf(rerun)).toEqual([`check:run-31@${SHA}`]);
  });

  it("does not take a failure reported on another commit for this one", async () => {
    const judged = await answer(finished, { reported: [`check:run-12@${NEW_SHA}`] });
    expect(judged.result).toBe("checks_failed");
    expect(idsOf(judged)).toEqual([redId]);
  });

  it("answers checks_failed with no such news for a failure first reported on this stay", async () => {
    const judged = await answer(finished, { reported: [redId], reportedThisStay: [redId], checkedThisStay: true });
    expect(judged.result).toBe("checks_failed");
    expect(judged.news).toEqual([]);
  });

  it("waits for checks still running as ever, whatever was reported", async () => {
    const judged = await answer(gitHubState({ checkRuns: [red, running] }), { reported: [redId] });
    expect(judged.result).toBe("waiting");
    expect(judged.detail).toContain("1 check still running");
  });

  it("does not hold back a conflict", async () => {
    const judged = await answer(gitHubState({ pr: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, checkRuns: [red] }), { reported: [redId] });
    expect(judged.result).toBe("conflict");
  });
});

describe("watch_pull_request, when gh cannot answer", () => {
  it("says the CLI is missing when it is not installed", async () => {
    const reading = await readPullRequest({ address, url: URL, run: async () => ({ ok: false, stdout: "", error: "spawn gh ENOENT", notFound: true }), cwd: "/tmp" });
    expect(reading).toMatchObject({ ok: false, problem: "missing_cli", cli: "gh" });
    if (!reading.ok) expect(reading.reason).toContain("`gh` is not installed");
  });

  it("says the CLI is not signed in when it asks for a login", async () => {
    const reading = await readPullRequest({
      address,
      url: URL,
      run: async () => ({ ok: false, stdout: "", error: "To get started with GitHub CLI, please run:  gh auth login", notFound: false }),
      cwd: "/tmp",
    });
    expect(reading).toMatchObject({ ok: false, problem: "signed_out", cli: "gh" });
    if (!reading.ok) expect(reading.reason).toContain("not signed in");
  });

  it("calls anything else an error, for the backoff to try again", async () => {
    const reading = await readPullRequest({ address, url: URL, run: async () => ({ ok: false, stdout: "", error: "HTTP 502: Bad Gateway", notFound: false }), cwd: "/tmp" });
    expect(reading).toMatchObject({ ok: false, problem: "error" });
  });

  it("refuses an answer that is not JSON", async () => {
    const reading = await readPullRequest({ address, url: URL, run: async () => ({ ok: true, stdout: "a new release of gh is available", error: "", notFound: false }), cwd: "/tmp" });
    expect(reading).toMatchObject({ ok: false, problem: "error" });
  });
});

describe("watch_pull_request, judged from what glab says", () => {
  const MR = "https://gitlab.com/group/api/-/merge_requests/12";
  const mrAddress = parsePullRequestUrl(MR) as Extract<PullRequestAddress, { forge: "gitlab" }>;
  const glabAnswer = (state: GitLabState, options: { reportReady?: boolean; reported?: Iterable<string> } = {}) => judgeWith(fakeGlab(() => state).run, MR, options);

  const job = (id: number, name: string, status: string, allowFailure = false) => ({ id, name, status, allow_failure: allowFailure, web_url: `https://gitlab.com/group/api/-/jobs/${id}` });
  const approved = { approved: true, approvals_left: 0, approved_by: [{ user: { username: "rev" } }] };
  const requestNote = (id: number, who: string) => ({ id, system: true, body: "requested changes", author: { username: who } });
  const approveNote = (id: number, who: string) => ({ id, system: true, body: "approved this merge request", author: { username: who } });
  const requesting = (who: string) => ({ user: { username: who }, state: "requested_changes" });

  it("asks the project the address names, through glab's API, a page at a time", async () => {
    const forge = fakeGlab(() => gitLabState());
    await readPullRequest({ address: mrAddress, url: MR, run: forge.run, cwd: "/tmp" });
    expect(forge.calls[0]).toEqual(["api", "--hostname", "gitlab.com", "projects/group%2Fapi/merge_requests/12"]);
    expect(forge.calls[1]).toEqual(GITLAB_WATCH_COMMANDS.jobs(mrAddress, "55", 1));
    expect(forge.calls[1]).toEqual(["api", "--hostname", "gitlab.com", "projects/group%2Fapi/pipelines/55/jobs?per_page=100&page=1"]);
    expect(forge.calls[2]).toEqual(["api", "--hostname", "gitlab.com", "projects/group%2Fapi/merge_requests/12/notes?sort=asc&order_by=created_at&per_page=100&page=1"]);
  });

  it("answers merged, closed and conflict from the merge request", async () => {
    expect((await glabAnswer(gitLabState({ mr: { state: "merged" } }))).result).toBe("merged");
    expect((await glabAnswer(gitLabState({ mr: { state: "closed" } }))).result).toBe("closed");
    expect((await glabAnswer(gitLabState({ mr: { has_conflicts: true } }))).result).toBe("conflict");
  });

  it("answers checks_failed from the head pipeline's jobs once they have all finished, minding jobs allowed to fail", async () => {
    const failing = job(1, "lint", "failed");
    expect((await glabAnswer(gitLabState({ jobs: [failing, job(2, "test", "success")] }))).result).toBe("checks_failed");
    expect((await glabAnswer(gitLabState({ jobs: [failing, job(2, "test", "running")] }))).result).toBe("waiting");
    expect((await glabAnswer(gitLabState({ jobs: [job(1, "lint", "failed", true)] }))).result).toBe("waiting");
  });

  it("holds the checks open for a blocking manual job, and not for an optional one", async () => {
    const blocking = job(3, "deploy", "manual", false);
    const optional = job(4, "deploy", "manual", true);
    const passed = job(2, "test", "success");
    // Approved, every other job green: ready only when the manual job is optional.
    expect((await glabAnswer(gitLabState({ approvals: approved, jobs: [passed, blocking] }), { reportReady: true })).result).toBe("waiting");
    expect((await glabAnswer(gitLabState({ approvals: approved, jobs: [passed, optional] }), { reportReady: true })).result).toBe("ready");
    // Another job failed: not finished-and-failed while a blocking manual job has not run.
    expect((await glabAnswer(gitLabState({ jobs: [job(1, "lint", "failed"), blocking] }))).result).toBe("waiting");
    expect((await glabAnswer(gitLabState({ jobs: [job(1, "lint", "failed"), optional] }))).result).toBe("checks_failed");
  });

  it("reads every page of the jobs, so a job past the first page still counts", async () => {
    const passed = Array.from({ length: PAGE_SIZE }, (_, index) => job(100 + index, `shard ${index}`, "success"));
    expect((await glabAnswer(gitLabState({ approvals: approved, jobs: [...passed, job(999, "e2e", "running")] }), { reportReady: true })).result).toBe("waiting");
    expect((await glabAnswer(gitLabState({ jobs: [...passed, job(998, "lint", "failed")] }))).result).toBe("checks_failed");
  });

  it("reads every page of the notes, so a note after the hundredth is still news", async () => {
    const notes = Array.from({ length: PAGE_SIZE + 1 }, (_, index) => ({ id: 2000 + index, system: false, body: `Note ${index}`, author: { username: "rev" } }));
    const judged = await glabAnswer(gitLabState({ notes }));
    expect(judged.news.map((entry) => entry.id)).toContain(`note:${2000 + PAGE_SIZE}`);
  });

  it("answers changes_requested from the reviewers, and ready from the approvals when asked", async () => {
    expect((await glabAnswer(gitLabState({ reviewers: [requesting("rev")], notes: [requestNote(10, "rev")] }))).result).toBe("changes_requested");
    const ready = gitLabState({ approvals: approved, jobs: [job(2, "test", "success")] });
    expect((await glabAnswer(ready)).result).toBe("waiting");
    expect((await glabAnswer(ready, { reportReady: true })).result).toBe("ready");
  });

  it("answers each round of a reviewer's requests once: not again after a fix, but again when they ask anew", async () => {
    const reported = new Set<string>();
    const check = async (state: GitLabState) => {
      const judged = await glabAnswer(state, { reported });
      for (const id of idsOf(judged)) reported.add(id);
      return judged.result;
    };

    // Round one: Alice asks.
    const asked = gitLabState({ reviewers: [requesting("alice")], notes: [requestNote(10, "alice")] });
    expect(await check(asked)).toBe("changes_requested");
    // The fix is pushed; her request still stands, and is the same request.
    expect(await check({ ...asked, mr: { ...asked.mr, sha: NEW_SHA } })).toBe("waiting");
    // She approves, then asks again on a later revision: a new request.
    expect(await check(gitLabState({ mr: { sha: NEW_SHA }, reviewers: [{ user: { username: "alice" }, state: "approved" }], notes: [requestNote(10, "alice"), approveNote(11, "alice")] }))).toBe("waiting");
    const again = gitLabState({ mr: { sha: "e".repeat(40) }, reviewers: [requesting("alice")], notes: [requestNote(10, "alice"), approveNote(11, "alice"), requestNote(12, "alice")] });
    expect(await check(again)).toBe("changes_requested");
    // And that one, too, is answered once.
    expect(await check({ ...again, mr: { ...again.mr, sha: "d".repeat(40) } })).toBe("waiting");
  });

  it("answers two reviewers' requests one by one: one of them approving is not a new request, a new note is", async () => {
    const reported = new Set<string>();
    const check = async (state: GitLabState, reportReady = false) => {
      const judged = await glabAnswer(state, { reported, reportReady });
      for (const id of idsOf(judged)) reported.add(id);
      return judged.result;
    };

    const together = gitLabState({ reviewers: [requesting("alice"), requesting("bob")], notes: [requestNote(10, "alice"), requestNote(11, "bob")] });
    expect(await check(together)).toBe("changes_requested");
    // Reworked; Bob approves while Alice's request stands.
    const bobApproves = gitLabState({
      mr: { sha: NEW_SHA },
      reviewers: [requesting("alice"), { user: { username: "bob" }, state: "approved" }],
      notes: [requestNote(10, "alice"), requestNote(11, "bob"), approveNote(12, "bob")],
    });
    expect(await check(bobApproves)).toBe("waiting");
    // Bob asks again.
    const bobAsksAgain = gitLabState({
      mr: { sha: NEW_SHA },
      reviewers: [requesting("alice"), requesting("bob")],
      notes: [requestNote(10, "alice"), requestNote(11, "bob"), approveNote(12, "bob"), requestNote(13, "bob")],
    });
    expect(await check(bobAsksAgain)).toBe("changes_requested");
  });

  it("waits, rather than reporting ready, while a reviewer's answered request stands beside enough approvals", async () => {
    const reported = new Set<string>();
    const objecting = gitLabState({
      approvals: { approved: true, approvals_left: 0, approved_by: [{ user: { username: "bob" } }] },
      reviewers: [requesting("alice"), { user: { username: "bob" }, state: "approved" }],
      notes: [requestNote(10, "alice"), approveNote(11, "bob")],
      jobs: [job(2, "test", "success")],
    });
    const first = await glabAnswer(objecting, { reported, reportReady: true });
    expect(first.result).toBe("changes_requested");
    for (const id of idsOf(first)) reported.add(id);

    expect((await glabAnswer(objecting, { reported, reportReady: true })).result).toBe("waiting");
    // Alice approves: ready.
    const withdrawn = gitLabState({ ...objecting, reviewers: [{ user: { username: "alice" }, state: "approved" }, { user: { username: "bob" }, state: "approved" }] });
    expect((await glabAnswer(withdrawn, { reported, reportReady: true })).result).toBe("ready");
  });

  it("reports people's notes as news and leaves GitLab's own system notes out", async () => {
    const judged = await glabAnswer(
      gitLabState({
        notes: [
          { id: 70, system: true, body: "added 1 commit", author: { username: "dev" } },
          { id: 71, system: false, body: "Please split this.", author: { username: "rev" }, position: { new_path: "src/b.ts", new_line: 4 } },
        ],
      }),
    );
    expect(judged.news).toEqual([{ id: "note:71", text: "@rev commented on src/b.ts line 4:\n\nPlease split this." }]);
  });
});

describe("watch_pull_request with readyWhen: mergeable (EO-515)", () => {
  const MR = "https://gitlab.com/group/api/-/merge_requests/12";
  type Options = { reportReady?: boolean; reported?: Iterable<string>; readyWhen?: "approved" | "mergeable" };

  /** Like `judgeWith`, with the step's `readyWhen` — `mergeable` unless a test says otherwise. */
  async function judgeMergeable(run: CliRunner, url: string, options: Options = {}): Promise<PullRequestJudgement> {
    const reading = await readPullRequest({ address: parsePullRequestUrl(url)!, url, run, cwd: "/tmp" });
    if (!reading.ok) throw new Error(reading.reason);
    return judgePullRequest(reading.snapshot, { reportReady: options.reportReady ?? true, readyWhen: options.readyWhen ?? "mergeable", stay: STAY, checkedThisStay: false, reported: new Set(options.reported ?? []), reportedThisStay: new Set() });
  }

  /** A GitHub pull request nobody has approved, every check green, that the forge describes as `status`. */
  const github = (status: string, pr: Partial<GitHubState["pr"]> = {}, checkRuns = [green]) => gitHubState({ pr: { reviewDecision: "", mergeStateStatus: status, ...pr }, checkRuns });
  const gh = (state: GitHubState, options: Options = {}) => judgeMergeable(fakeGh(() => state).run, URL, options);

  const passed = { id: 2, name: "test", status: "success", allow_failure: false, web_url: "https://gitlab.com/group/api/-/jobs/2" };
  /** A GitLab merge request nobody has approved, every job green, that the forge describes as `status`. */
  const gitlab = (status: string) => gitLabState({ mr: { detailed_merge_status: status }, jobs: [passed] });
  const glab = (state: GitLabState, options: Options = {}) => judgeMergeable(fakeGlab(() => state).run, MR, options);

  it.each(["CLEAN", "HAS_HOOKS", "BEHIND"])("answers ready for an unapproved GitHub pull request with green checks that the forge reports %s", async (status) => {
    const judged = await gh(github(status));
    expect(judged.result).toBe("ready");
    expect(judged.detail).toContain(status);
    expect(judged.news.map((entry) => entry.id)).toContain(readyNewsId(SHA, STAY));
  });

  it.each(["BLOCKED", "DRAFT", "UNSTABLE", "UNKNOWN"])("waits on a GitHub pull request the forge reports %s, and says so", async (status) => {
    const judged = await gh(github(status));
    expect(judged.result).toBe("waiting");
    expect(judged.detail).toContain(`merge status as ${status}`);
  });

  it.each(["mergeable", "need_rebase"])("answers ready for an unapproved GitLab merge request with green jobs that the forge reports %s", async (status) => {
    const judged = await glab(gitlab(status));
    expect(judged.result).toBe("ready");
    expect(judged.detail).toContain(status);
  });

  it.each(["not_approved", "draft_status", "discussions_not_resolved", "checking"])("waits on a GitLab merge request the forge reports %s, and says so", async (status) => {
    const judged = await glab(gitlab(status));
    expect(judged.result).toBe("waiting");
    expect(judged.detail).toContain(`merge status as ${status}`);
  });

  it("goes by the forge's verdict, not the approval: approved but blocked still waits", async () => {
    expect((await gh(github("BLOCKED", { reviewDecision: "APPROVED" }))).result).toBe("waiting");
    // And without readyWhen, today's rule: approved is ready whatever the merge status, unapproved is not.
    expect((await gh(github("BLOCKED", { reviewDecision: "APPROVED" }), { readyWhen: "approved" })).result).toBe("ready");
    expect((await gh(github("CLEAN"), { readyWhen: "approved" })).result).toBe("waiting");
  });

  it("is still ready only when the step asks for it", async () => {
    expect((await gh(github("CLEAN"), { reportReady: false })).result).toBe("waiting");
  });

  it("waits for every check to finish, even on a pull request the forge would merge", async () => {
    const judged = await gh(github("CLEAN", {}, [green, running]));
    expect(judged.result).toBe("waiting");
    expect(judged.detail).toContain("1 check still running");
    expect(judged.detail).toContain("merge status as CLEAN");
  });

  it("answers what wins before ready exactly as it does today: closed, conflict, a failed check, a request for changes", async () => {
    expect((await gh(github("CLEAN", { state: "CLOSED" }))).result).toBe("closed");
    expect((await gh(github("DIRTY", { mergeable: "CONFLICTING" }))).result).toBe("conflict");
    expect((await gh(github("CLEAN", {}, [green, red]))).result).toBe("checks_failed");
    const asked = gitHubState({ pr: { reviewDecision: "", mergeStateStatus: "CLEAN" }, checkRuns: [green], reviews: [review(3, "rev", "CHANGES_REQUESTED")] });
    const first = await gh(asked);
    expect(first.result).toBe("changes_requested");
    // Answered once, the request still stands, so it is not ready.
    expect((await gh(asked, { reported: idsOf(first) })).result).toBe("waiting");
  });

  it("answers ready once per commit, then waits for somebody to merge it", async () => {
    const first = await gh(github("CLEAN"));
    const again = await gh(github("CLEAN"), { reported: idsOf(first) });
    expect(again.result).toBe("waiting");
    expect(again.detail).toContain("waiting for somebody to merge it");
    expect((await gh(github("CLEAN", { headRefOid: NEW_SHA }), { reported: idsOf(first) })).result).toBe("ready");
  });

  it("says so when the forge gave no merge status", async () => {
    const judged = await gh(github(""));
    expect(judged.result).toBe("waiting");
    expect(judged.detail).toContain("The forge gave no merge status.");
  });
});

describe("watch_pull_request seeing no checks (EO-620)", () => {
  const MR = "https://gitlab.com/group/api/-/merge_requests/12";
  const approved = { approved: true, approvals_left: 0, approved_by: [{ user: { username: "rev" } }] };
  type Options = { readyWhen?: "approved" | "mergeable"; checkedThisStay?: boolean; reported?: Iterable<string>; reportReady?: boolean };

  async function judged(run: CliRunner, url: string, options: Options = {}): Promise<PullRequestJudgement> {
    const reading = await readPullRequest({ address: parsePullRequestUrl(url)!, url, run, cwd: "/tmp" });
    if (!reading.ok) throw new Error(reading.reason);
    return judgePullRequest(reading.snapshot, {
      reportReady: options.reportReady ?? true,
      readyWhen: options.readyWhen ?? "mergeable",
      stay: STAY,
      checkedThisStay: options.checkedThisStay ?? false,
      reported: new Set(options.reported ?? []),
      reportedThisStay: new Set(),
    });
  }
  const gh = (state: GitHubState, options: Options = {}) => judged(fakeGh(() => state).run, URL, options);
  const glab = (state: GitLabState, options: Options = {}) => judged(fakeGlab(() => state).run, MR, options);

  /** EO-586 on PR #504: created, CLEAN, and not one check run started yet. */
  const cleanWithNoRuns = gitHubState({ pr: { reviewDecision: "", mergeStateStatus: "CLEAN" } });
  const noPipeline = { head_pipeline: null };

  /** A pull request the forge says qualifies, with nothing to show for its checks, asked through either forge. */
  const qualifying: [string, (options?: Options) => Promise<PullRequestJudgement>][] = [
    ["GitHub, mergeable", (options) => gh(cleanWithNoRuns, options)],
    ["GitHub, approved", (options) => gh(gitHubState({ pr: { reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" } }), { ...options, readyWhen: "approved" })],
    ["GitLab, mergeable", (options) => glab(gitLabState({ mr: { ...noPipeline, detailed_merge_status: "mergeable" } }), options)],
    ["GitLab, approved", (options) => glab(gitLabState({ mr: noPipeline, approvals: approved }), { ...options, readyWhen: "approved" })],
  ];

  it.each(qualifying)("answers waiting on the first check, and says it sees no checks yet: %s", async (_name, check) => {
    const verdict = await check();
    expect(verdict.result).toBe("waiting");
    expect(verdict.detail).toContain(`it sees no checks on ${SHA.slice(0, 12)} yet`);
    expect(verdict.detail).not.toContain("passed");
    expect(verdict.news).toEqual([]);
  });

  it.each(qualifying)("may answer ready on a later check that still sees none, saying none were reported: %s", async (_name, check) => {
    const verdict = await check({ checkedThisStay: true });
    expect(verdict.result).toBe("ready");
    expect(verdict.detail).toContain(`no checks were reported on ${SHA.slice(0, 12)}`);
    expect(verdict.detail).not.toContain("every check");
    const news = verdict.news.find((entry) => entry.id === readyNewsId(SHA, STAY));
    expect(news?.text).toContain(`no checks were reported on ${SHA.slice(0, 12)}`);
    expect(news?.text).not.toContain("every check");
  });

  it("says it sees no checks yet whatever else it is waiting on, and whether or not the step asked for ready", async () => {
    expect((await gh(gitHubState({ pr: { mergeStateStatus: "BLOCKED" } }))).detail).toContain("it sees no checks on");
    expect((await gh(cleanWithNoRuns, { reportReady: false })).detail).toContain("it sees no checks on");
    expect((await gh(gitHubState({ pr: { reviewDecision: "CHANGES_REQUESTED" }, reviews: [review(1, "rev", "CHANGES_REQUESTED")] }), { reported: ["changes-requested:1"] })).detail).toContain("it sees no checks on");
  });

  it("answers ready at most once per commit on a repository with no checks too", async () => {
    const first = await gh(cleanWithNoRuns, { checkedThisStay: true });
    expect((await gh(cleanWithNoRuns, { checkedThisStay: true, reported: idsOf(first) })).result).toBe("waiting");
  });

  it("still answers ready at once from a first check that sees every check finished and passed", async () => {
    const verdict = await gh(gitHubState({ pr: { reviewDecision: "", mergeStateStatus: "CLEAN" }, checkRuns: [green] }));
    expect(verdict.result).toBe("ready");
    expect(verdict.detail).toContain(`every check on ${SHA.slice(0, 12)} passed`);
    expect(verdict.news.find((entry) => entry.id === readyNewsId(SHA, STAY))?.text).toContain(`every check on ${SHA.slice(0, 12)} passed`);

    const status = await gh(gitHubState({ pr: { reviewDecision: "", mergeStateStatus: "CLEAN" }, statuses: [{ id: 501, context: "ci/jenkins", state: "success", target_url: null }] }));
    expect(status.result).toBe("ready");
  });

  it("is not held back on a first check by anything but seeing no checks: what wins before ready still wins", async () => {
    expect((await gh(gitHubState({ pr: { state: "MERGED" } }))).result).toBe("merged");
    expect((await gh(gitHubState({ pr: { mergeable: "CONFLICTING" } }))).result).toBe("conflict");
    expect((await gh(gitHubState({ pr: { reviewDecision: "CHANGES_REQUESTED" }, reviews: [review(1, "rev", "CHANGES_REQUESTED")] }))).result).toBe("changes_requested");
  });

  describe("on GitLab, the head pipeline counts alongside its jobs", () => {
    const passedJob = { id: 2, name: "test", status: "success", allow_failure: false, web_url: "https://gitlab.com/group/api/-/jobs/2" };
    const failedJob = { id: 3, name: "lint", status: "failed", allow_failure: false, web_url: "https://gitlab.com/group/api/-/jobs/3" };
    const pipelineOf = (status: string) => ({ id: 55, status, web_url: "https://gitlab.com/group/api/-/pipelines/55" });
    const mergeRequest = (status: string, jobs: Record<string, unknown>[] = []) => gitLabState({ mr: { detailed_merge_status: "mergeable", head_pipeline: pipelineOf(status) }, jobs });

    it.each(["created", "waiting_for_resource", "preparing", "pending", "running", "manual", "scheduled", "canceling"])("is never ready while the pipeline is %s, even with no listed job pending", async (status) => {
      for (const jobs of [[], [passedJob]]) {
        for (const checkedThisStay of [false, true]) {
          const verdict = await glab(mergeRequest(status, jobs), { checkedThisStay });
          expect(verdict.result).toBe("waiting");
          expect(verdict.detail).toContain("1 check still running");
        }
      }
    });

    it.each(["failed", "canceled"])("answers checks_failed for a %s pipeline with no listed job failed, and the news names the pipeline", async (status) => {
      for (const jobs of [[], [passedJob]]) {
        const verdict = await glab(mergeRequest(status, jobs));
        expect(verdict.result).toBe("checks_failed");
        expect(verdict.detail).toContain('"pipeline 55"');
        expect(verdict.news).toEqual([{ id: `check:pipeline-55@${SHA}`, text: 'The check "pipeline 55" failed: https://gitlab.com/group/api/-/pipelines/55' }]);
      }
    });

    it("reports a listed failed job, not the pipeline it failed over again", async () => {
      const verdict = await glab(mergeRequest("failed", [failedJob, passedJob]));
      expect(verdict.result).toBe("checks_failed");
      expect(verdict.detail).toContain('one failed: "lint"');
      expect(idsOf(verdict)).toEqual([`check:job-3@${SHA}`]);
    });

    it("counts one running thing once, however many jobs are running in it", async () => {
      const running = { ...passedJob, status: "running" };
      expect((await glab(mergeRequest("running", [running]))).detail).toContain("1 check still running");
    });

    it("holds a job that failed until the pipeline has finished", async () => {
      expect((await glab(mergeRequest("running", [failedJob]))).result).toBe("waiting");
      expect((await glab(mergeRequest("failed", [failedJob]))).result).toBe("checks_failed");
    });

    it("answers ready at once for a finished pipeline with every job passed", async () => {
      const verdict = await glab(mergeRequest("success", [passedJob]));
      expect(verdict.result).toBe("ready");
      expect(verdict.detail).toContain("every check on");
    });

    // GitLab's `/pipelines/:id/jobs` leaves trigger jobs out: confirmed on
    // gitlab-org/gitlab-runner pipeline 3012714867 and gitlab-org/gitlab
    // pipeline 3013366847, where every trigger job `/trigger_jobs` listed
    // was missing from `/jobs`. So this pipeline's jobs list is empty, and
    // its status is the only account of it.
    describe("a pipeline made only of trigger jobs", () => {
      it("is waited on while it runs", async () => {
        for (const checkedThisStay of [false, true]) {
          const verdict = await glab(mergeRequest("running"), { checkedThisStay });
          expect(verdict.result).toBe("waiting");
          expect(verdict.detail).toContain("1 check still running");
        }
      });

      it("answers checks_failed when it fails", async () => {
        expect((await glab(mergeRequest("failed"))).result).toBe("checks_failed");
      });

      it("has been seen once it passes, so a first check can answer ready", async () => {
        const verdict = await glab(mergeRequest("success"));
        expect(verdict.result).toBe("ready");
        expect(verdict.detail).toContain("every check on");
      });
    });
  });
});
