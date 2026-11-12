import type { WatchNews, WatchPullRequestReadyWhen } from "@eo/core";
import { describeSearchedDirectories } from "../../../process/searchPath.js";
import { CLI_FOR, type CliResult, type CliRunner } from "./cli.js";
import type { ForgeKind } from "./remote.js";

/**
 * Watching one pull request (EO-460): what the forge says about it, and
 * what that means for the step watching it.
 *
 * Two halves, kept apart so each can be tested without the other.
 * `readPullRequest` asks the forge — through the same `gh` and `glab` the
 * pull request was opened with, and through `CliRunner`, so nothing here
 * spawns anything itself — and turns either forge's answer into one
 * `PullRequestSnapshot`. `judgePullRequest` is pure: a snapshot in, the
 * check's answer out.
 *
 * Only reads. Nothing here writes to the forge, which is why the step
 * declares no side effects.
 */

/** One check run or commit status on the pull request's head commit, or on GitLab one job, or the pipeline as a whole. */
export interface PullRequestCheck {
  /** The forge's own id for this run of the check — GitHub's check run or status, GitLab's job or pipeline — so two checks of one name stay two. */
  id: string;
  name: string;
  url: string | null;
  state: "pending" | "passed" | "failed";
}

/** One standing request for changes. */
export interface ChangeRequest {
  /** The forge's id for the event that made the request, stable for as long as it stands. */
  id: string;
  /** Who asked, when the forge says. */
  by: string | null;
}

/**
 * The id the watch knows a comment on the forge by: the forge's own id,
 * prefixed by what kind of thing it is, because GitHub numbers reviews,
 * line comments and conversation comments separately.
 *
 * Exported for whatever records the comments EO posts itself (EO-759), so
 * that it records them in the spelling the watch reads them in, and the
 * watch does not read EO's own reply back as somebody's comment.
 */
export const forgeCommentId = {
  /** A GitHub review's own text. */
  review: (id: string | number): string => `review:${id}`,
  /** A GitHub comment on a line. */
  lineComment: (id: string | number): string => `review-comment:${id}`,
  /** A GitHub comment in the pull request's conversation, which GitHub keeps as an issue comment. */
  conversationComment: (id: string | number): string => `issue-comment:${id}`,
  /** A GitLab note, on a line or not. */
  note: (id: string | number): string => `note:${id}`,
};

/**
 * One thing somebody wrote on the pull request: a review's own text, a
 * comment on a line, or on GitHub a comment in the conversation (EO-759).
 */
export interface PullRequestReviewComment {
  /** The forge's own id, prefixed by what kind of thing it is, so two kinds cannot collide (`forgeCommentId`). */
  id: string;
  author: string;
  body: string;
  /** `src/a.ts line 12`, for a comment on a line. */
  where: string | null;
  url: string | null;
}

export interface PullRequestSnapshot {
  url: string;
  state: "open" | "merged" | "closed";
  /** The head commit every check below ran on. Empty when the forge did not say. */
  headSha: string;
  /** The forge says it cannot merge this because it conflicts with its base. */
  conflicted: boolean;
  approved: boolean;
  /**
   * The forge's own word for whether the pull request can be merged, as it
   * gave it — GitHub's `mergeStateStatus`, GitLab's `detailed_merge_status`
   * — so a step waiting on it can say what it is waiting through. Empty
   * when the forge did not say.
   */
  mergeStatus: string;
  /** Whether `mergeStatus` is one the forge gives a pull request it can merge (EO-515): `GITHUB_MERGEABLE` or `GITLAB_MERGEABLE`. */
  mergeable: boolean;
  /**
   * Every request for changes still standing, one entry per request; empty
   * when nobody's is.
   *
   * Each is the request *event* — the review, or the note, that made it —
   * rather than the pull request's decision or the set of people asking. A
   * forge goes on saying "changes requested" after the author pushes a fix,
   * until the reviewer looks again, so a step that answered on the decision
   * would send a fix nobody has reviewed straight back. And a set is the
   * wrong unit too: when two reviewers asked and one has since approved,
   * what is left is a request already answered, not a new one.
   */
  changeRequests: readonly ChangeRequest[];
  checks: readonly PullRequestCheck[];
  comments: readonly PullRequestReviewComment[];
  /**
   * The login the forge CLI is signed in as (EO-759) — the person EO works
   * for — whose comments are acted on, where everybody else's are planned
   * for. Null when the forge would not say, and then every comment is
   * treated as somebody else's.
   */
  viewer: string | null;
}

/** Where a pull request lives, read from its URL. */
export type PullRequestAddress =
  | { forge: "github"; host: string; owner: string; repo: string; number: number }
  | { forge: "gitlab"; host: string; project: string; iid: number };

/**
 * The pull request a URL names.
 *
 * `https://github.com/acme/api/pull/7` and
 * `https://gitlab.example.com/group/sub/api/-/merge_requests/7`. The
 * shape says which forge it is; `forge`, when the repository has said,
 * overrides it, since a GitHub Enterprise host can serve any path.
 */
export function parsePullRequestUrl(url: string, forge: ForgeKind | null = null): PullRequestAddress | null {
  const trimmed = url.trim();
  const gitlab = /^https?:\/\/([^/\s]+)\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/i.exec(trimmed);
  const github = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(trimmed);
  if (gitlab && forge !== "github") return { forge: "gitlab", host: gitlab[1]!.toLowerCase(), project: gitlab[2]!, iid: Number(gitlab[3]) };
  if (github && forge !== "gitlab") {
    return { forge: "github", host: github[1]!.toLowerCase(), owner: github[2]!, repo: github[3]!, number: Number(github[4]) };
  }
  return null;
}

export type PullRequestReading =
  | { ok: true; snapshot: PullRequestSnapshot }
  /**
   * The forge could not be asked or did not answer. `problem` says which
   * of the three a person has to know apart: the CLI is not installed,
   * it is not signed in, or something else went wrong.
   */
  | { ok: false; problem: "missing_cli" | "signed_out" | "error"; cli: string; reason: string };

export interface ReadPullRequestInput {
  address: PullRequestAddress;
  url: string;
  run: CliRunner;
  cwd: string;
  signal?: AbortSignal;
}

/**
 * What a CLI prints when nobody is signed in to the host it was asked
 * about. Matched lower-cased. Kept apart from `classifyForgeError`'s
 * credential patterns because the advice differs: those are a forge
 * refusing the credentials it was given, these are no credentials at all
 * — and both are worth saying as "sign in".
 */
const SIGNED_OUT =
  /auth login|not logged in|not logged into|no token|authentication required|requires authentication|bad credentials|http 401|401 unauthorized|could not authenticate|token (?:is )?(?:invalid|expired)|authentication failed/;

function failure(cli: string, result: CliResult): PullRequestReading {
  if (result.notFound) {
    return {
      ok: false,
      problem: "missing_cli",
      cli,
      reason: `\`${cli}\` is not installed, or is not on EO's PATH, so EO cannot ask the forge about this pull request. Install it and sign in with \`${cli} auth login\`. ${describeSearchedDirectories()}`,
    };
  }
  const said = result.error.trim() || result.stdout.trim() || "it gave no reason";
  if (SIGNED_OUT.test(said.toLowerCase())) {
    return {
      ok: false,
      problem: "signed_out",
      cli,
      reason: `\`${cli}\` is not signed in to this forge, so EO cannot ask it about this pull request. Run \`${cli} auth login\`, then the check will go on. It said: ${said}`,
    };
  }
  return { ok: false, problem: "error", cli, reason: `\`${cli}\` could not read this pull request: ${said}` };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const objects = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);
const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const loginOf = (value: unknown, field: "login" | "username"): string => (isObject(value) ? text(value[field]) : "") || "someone";

async function ask(input: ReadPullRequestInput, cli: string, args: string[]): Promise<{ ok: true; value: unknown } | { ok: false; reading: PullRequestReading }> {
  const result = await input.run(cli, args, input.cwd, input.signal ? { signal: input.signal } : {});
  if (!result.ok) return { ok: false, reading: failure(cli, result) };
  const value = parseJson(result.stdout);
  if (value === undefined) return { ok: false, reading: { ok: false, problem: "error", cli, reason: `\`${cli}\` answered with something that is not JSON, so EO could not read this pull request.` } };
  return { ok: true, value };
}

/**
 * The login the CLI is signed in as, or null when it would not say.
 *
 * Never a reason the check fails: a pull request read without knowing
 * whose comments are whose is still worth judging, with every comment
 * taken for somebody else's — the side that asks a person before anything
 * is done about it.
 */
async function askViewer(input: ReadPullRequestInput, cli: string, args: string[], field: "login" | "username"): Promise<string | null> {
  const result = await input.run(cli, args, input.cwd, input.signal ? { signal: input.signal } : {});
  if (!result.ok) return null;
  const value = parseJson(result.stdout);
  const login = isObject(value) ? text(value[field]).trim() : "";
  return login === "" ? null : login;
}

/** Asks the forge about the pull request, and reads what it says into one shape. */
export async function readPullRequest(input: ReadPullRequestInput): Promise<PullRequestReading> {
  return input.address.forge === "github" ? readGitHub(input, input.address) : readGitLab(input, input.address);
}

// ── Pages ───────────────────────────────────────────────────────

/** The most either forge hands back in one page. */
export const PAGE_SIZE = 100;

/**
 * How many pages of one list a check will read before it says the list is
 * too long to watch. Every page is asked for, because a list read only in
 * part is worse than none: the newest comments are on the last page, and a
 * job missing from the first is a job that could still be running.
 */
export const MAX_PAGES = 30;

/** `path?query` with the page asked for added to whatever it already asks. */
export function pageOf(path: string, page: number): string {
  return `${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`;
}

/**
 * Every entry of a paged list, read a page at a time until a short page
 * or the forge's own count says there are no more.
 *
 * `entriesOf` reads one page's answer: the entries on it, and the total
 * when the forge states one (GitHub's check runs and statuses do). Null is
 * an answer that is not the list it should be.
 */
async function askAll(
  input: ReadPullRequestInput,
  cli: string,
  argsFor: (page: number) => string[],
  entriesOf: (value: unknown) => { entries: Json[]; total?: number } | null,
): Promise<{ ok: true; entries: Json[] } | { ok: false; reading: PullRequestReading }> {
  const entries: Json[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const asked = await ask(input, cli, argsFor(page));
    if (!asked.ok) return asked;
    const read = entriesOf(asked.value);
    if (read === null) return { ok: false, reading: { ok: false, problem: "error", cli, reason: `\`${cli}\` answered with something that is not the list EO asked for, so EO could not read this pull request.` } };
    entries.push(...read.entries);
    const done = read.entries.length < PAGE_SIZE || (read.total !== undefined && entries.length >= read.total);
    if (done) return { ok: true, entries };
  }
  return {
    ok: false,
    reading: {
      ok: false,
      problem: "error",
      cli,
      reason: `This pull request has more than ${MAX_PAGES * PAGE_SIZE} of something EO reads on every check, so EO stopped rather than judge it on part of the list.`,
    },
  };
}

const anArray = (value: unknown): { entries: Json[] } | null => (Array.isArray(value) ? { entries: objects(value) } : null);

/** A page of an object holding its list under `field`, beside a `total_count`. */
const listIn =
  (field: string) =>
  (value: unknown): { entries: Json[]; total?: number } | null => {
    if (!isObject(value) || !Array.isArray(value[field])) return null;
    const total = typeof value["total_count"] === "number" ? value["total_count"] : undefined;
    return { entries: objects(value[field]), ...(total === undefined ? {} : { total }) };
  };

const whereOf = (path: string, line: string): string | null => (path === "" ? null : line === "" ? path : `${path} line ${line}`);

// ── GitHub ──────────────────────────────────────────────────────

/**
 * What `gh pr view` is asked for: the pull request itself, and nothing
 * that is a list. The lists — reviews, comments on lines, check runs and
 * statuses — come from the REST API, a page at a time, because that is
 * where each entry carries the forge's own id: `gh pr view`'s
 * `latestReviews` has none, and its check rollup names a check without
 * saying which run it was.
 */
export const GITHUB_VIEW_FIELDS = "state,mergeable,mergeStateStatus,reviewDecision,headRefOid";

type GitHubAddress = Extract<PullRequestAddress, { forge: "github" }>;

/** The argv for each question asked of `gh`. */
export const GITHUB_WATCH_COMMANDS = {
  view: (url: string): string[] => ["pr", "view", url, "--json", GITHUB_VIEW_FIELDS],
  reviews: (address: GitHubAddress, page: number): string[] => githubApi(address, `pulls/${address.number}/reviews`, page),
  lineComments: (address: GitHubAddress, page: number): string[] => githubApi(address, `pulls/${address.number}/comments`, page),
  /** The pull request's conversation, which GitHub keeps as the comments on the issue it is. */
  conversationComments: (address: GitHubAddress, page: number): string[] => githubApi(address, `issues/${address.number}/comments`, page),
  /** The account `gh` is signed in as on this host (EO-759). */
  viewer: (address: GitHubAddress): string[] => ["api", "--hostname", address.host, "user"],
  /** The latest run of each check on the commit, which is what the forge's own default filter returns. */
  checkRuns: (address: GitHubAddress, sha: string, page: number): string[] => githubApi(address, `commits/${sha}/check-runs`, page),
  /** The latest status of each context on the commit. */
  statuses: (address: GitHubAddress, sha: string, page: number): string[] => githubApi(address, `commits/${sha}/status`, page),
};

function githubApi(address: GitHubAddress, path: string, page: number): string[] {
  return ["api", "--hostname", address.host, pageOf(`repos/${address.owner}/${address.repo}/${path}`, page)];
}

/**
 * The `mergeStateStatus` values that mean GitHub can merge the pull request
 * (EO-515). `HAS_HOOKS` is clean with hooks to run on the merge. `BEHIND` is
 * a branch only out of date with its base: it does not conflict, the watch
 * cannot update it, and waiting on it would never end — bringing it up to
 * date is the merging step's job. Everything else — `BLOCKED`, `DRAFT`,
 * `UNSTABLE`, `UNKNOWN` while GitHub works it out — is not.
 */
export const GITHUB_MERGEABLE: ReadonlySet<string> = new Set(["CLEAN", "HAS_HOOKS", "BEHIND"]);

/** A check run's conclusions that mean it did not pass. `cancelled` too: a cancelled required check blocks a merge. */
const GITHUB_FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);

/** A check run, under the id of the run: two checks of one name are two checks, and a re-run is a new one. */
function githubCheckRun(run: Json): PullRequestCheck | null {
  const id = text(run["id"]);
  const name = text(run["name"]);
  if (id === "" || name === "") return null;
  const status = text(run["status"]).toLowerCase();
  const conclusion = text(run["conclusion"]).toLowerCase();
  return {
    id: `run-${id}`,
    name,
    url: text(run["html_url"]) || text(run["details_url"]) || null,
    state: status !== "completed" ? "pending" : GITHUB_FAILED_CONCLUSIONS.has(conclusion) ? "failed" : "passed",
  };
}

/** A commit status, under the id of that status: a context that fails again posts a new one. */
function githubStatus(status: Json): PullRequestCheck | null {
  const id = text(status["id"]);
  const name = text(status["context"]);
  if (id === "" || name === "") return null;
  const state = text(status["state"]).toLowerCase();
  return { id: `status-${id}`, name, url: text(status["target_url"]) || null, state: state === "success" ? "passed" : state === "failure" || state === "error" ? "failed" : "pending" };
}

/**
 * Where each reviewer stands: their latest review that took a position.
 * A review that only commented changes nobody's standing, and one that was
 * dismissed reads as dismissed, which takes the position back.
 */
function standingReviews(reviews: readonly Json[]): Json[] {
  const standing = new Map<string, Json>();
  for (const review of reviews) {
    const state = text(review["state"]).toUpperCase();
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED" && state !== "DISMISSED") continue;
    standing.set(loginOf(review["user"], "login"), review);
  }
  return [...standing.values()];
}

async function readGitHub(input: ReadPullRequestInput, address: GitHubAddress): Promise<PullRequestReading> {
  const cli = CLI_FOR.github;
  const viewed = await ask(input, cli, GITHUB_WATCH_COMMANDS.view(input.url));
  if (!viewed.ok) return viewed.reading;
  if (!isObject(viewed.value)) return { ok: false, problem: "error", cli, reason: `\`${cli}\` did not describe the pull request, so EO could not read it.` };
  const pr = viewed.value;
  const headSha = text(pr["headRefOid"]);

  const viewer = await askViewer(input, cli, GITHUB_WATCH_COMMANDS.viewer(address), "login");
  const reviews = await askAll(input, cli, (page) => GITHUB_WATCH_COMMANDS.reviews(address, page), anArray);
  if (!reviews.ok) return reviews.reading;
  const lines = await askAll(input, cli, (page) => GITHUB_WATCH_COMMANDS.lineComments(address, page), anArray);
  if (!lines.ok) return lines.reading;
  const conversation = await askAll(input, cli, (page) => GITHUB_WATCH_COMMANDS.conversationComments(address, page), anArray);
  if (!conversation.ok) return conversation.reading;

  const checks: PullRequestCheck[] = [];
  // No head commit, no checks to ask about. The forge always names one;
  // this is only so a missing field cannot become a request for `commits//`.
  if (headSha !== "") {
    const runs = await askAll(input, cli, (page) => GITHUB_WATCH_COMMANDS.checkRuns(address, headSha, page), listIn("check_runs"));
    if (!runs.ok) return runs.reading;
    const statuses = await askAll(input, cli, (page) => GITHUB_WATCH_COMMANDS.statuses(address, headSha, page), listIn("statuses"));
    if (!statuses.ok) return statuses.reading;
    for (const run of runs.entries) {
      const check = githubCheckRun(run);
      if (check) checks.push(check);
    }
    for (const status of statuses.entries) {
      const check = githubStatus(status);
      if (check) checks.push(check);
    }
  }

  const rawState = text(pr["state"]).toUpperCase();
  const state = rawState === "MERGED" ? "merged" : rawState === "CLOSED" ? "closed" : "open";
  const mergeStatus = text(pr["mergeStateStatus"]).toUpperCase();

  // The decision when branch protection makes one; where each reviewer
  // stands when it does not, which is what a person reading the page goes by.
  const decision = text(pr["reviewDecision"]).toUpperCase();
  const standing = standingReviews(reviews.entries);
  const requesting = standing.filter((review) => text(review["state"]).toUpperCase() === "CHANGES_REQUESTED");
  const approving = standing.filter((review) => text(review["state"]).toUpperCase() === "APPROVED");
  // A standing request counts whatever the decision says, as it does on
  // GitLab: a reviewer whose objection the rules do not count still objects.
  const requested = decision === "CHANGES_REQUESTED" || requesting.length > 0;
  const approved = decision === "APPROVED" || (decision === "" && requesting.length === 0 && approving.length > 0);
  // The reviews that stand as requests for changes. A fix pushed on top
  // leaves each standing — the same request — and a new review asking
  // again is a new id. Only a decision no review explains is dated by the
  // commit it was seen on.
  const fromReviews: ChangeRequest[] = requesting
    .filter((review) => text(review["id"]) !== "")
    .map((review) => ({ id: text(review["id"]), by: loginOf(review["user"], "login") }));
  const changeRequests = !requested ? [] : fromReviews.length > 0 ? fromReviews : [{ id: `decision:${headSha}`, by: null }];

  const comments: PullRequestReviewComment[] = [];
  for (const review of reviews.entries) {
    const body = text(review["body"]).trim();
    const id = text(review["id"]);
    if (body === "" || id === "") continue;
    comments.push({ id: forgeCommentId.review(id), author: loginOf(review["user"], "login"), body, where: null, url: text(review["html_url"]) || null });
  }
  for (const comment of lines.entries) {
    const body = text(comment["body"]).trim();
    const id = text(comment["id"]);
    if (body === "" || id === "") continue;
    comments.push({
      id: forgeCommentId.lineComment(id),
      author: loginOf(comment["user"], "login"),
      body,
      where: whereOf(text(comment["path"]), text(comment["line"]) || text(comment["original_line"])),
      url: text(comment["html_url"]) || null,
    });
  }
  for (const comment of conversation.entries) {
    const body = text(comment["body"]).trim();
    const id = text(comment["id"]);
    if (body === "" || id === "") continue;
    comments.push({ id: forgeCommentId.conversationComment(id), author: loginOf(comment["user"], "login"), body, where: null, url: text(comment["html_url"]) || null });
  }

  return {
    ok: true,
    snapshot: {
      url: input.url,
      state,
      headSha,
      conflicted: text(pr["mergeable"]).toUpperCase() === "CONFLICTING" || mergeStatus === "DIRTY",
      approved,
      mergeStatus,
      mergeable: GITHUB_MERGEABLE.has(mergeStatus),
      changeRequests,
      checks,
      comments,
      viewer,
    },
  };
}

// ── GitLab ──────────────────────────────────────────────────────

type GitLabAddress = Extract<PullRequestAddress, { forge: "gitlab" }>;

/** The argv for each question asked of `glab`, all through its API so the project comes from the URL rather than the directory. */
export const GITLAB_WATCH_COMMANDS = {
  mergeRequest: (address: GitLabAddress): string[] => gitlabApi(address, `merge_requests/${address.iid}`),
  jobs: (address: GitLabAddress, pipelineId: string, page: number): string[] => gitlabApi(address, pageOf(`pipelines/${pipelineId}/jobs`, page)),
  notes: (address: GitLabAddress, page: number): string[] => gitlabApi(address, pageOf(`merge_requests/${address.iid}/notes?sort=asc&order_by=created_at`, page)),
  approvals: (address: GitLabAddress): string[] => gitlabApi(address, `merge_requests/${address.iid}/approvals`),
  reviewers: (address: GitLabAddress, page: number): string[] => gitlabApi(address, pageOf(`merge_requests/${address.iid}/reviewers`, page)),
  /** The account `glab` is signed in as on this host (EO-759). Not the project's: the user is the host's. */
  viewer: (address: GitLabAddress): string[] => ["api", "--hostname", address.host, "user"],
};

function gitlabApi(address: GitLabAddress, path: string): string[] {
  return ["api", "--hostname", address.host, `projects/${encodeURIComponent(address.project)}/${path}`];
}

/**
 * The `detailed_merge_status` values that mean GitLab can merge the merge
 * request (EO-515): `mergeable`, and `need_rebase` for `GITHUB_MERGEABLE`'s
 * reason that `BEHIND` is one. Everything else — `not_approved`,
 * `draft_status`, `discussions_not_resolved`, `checking` — is not.
 */
export const GITLAB_MERGEABLE: ReadonlySet<string> = new Set(["mergeable", "need_rebase"]);

/**
 * A job's status, as a check's.
 *
 * `allow_failure` is the pipeline saying a job may fail, and it is also
 * what tells GitLab's two kinds of manual job apart: an optional one
 * (`allow_failure: true`, the default for `when: manual`) holds nothing
 * up, while a blocking one (`allow_failure: false`) has not run and the
 * pipeline waits for it — so it is still pending, and nothing is ready or
 * finished-and-failed while it is.
 */
function gitlabCheck(job: Json): PullRequestCheck | null {
  const id = text(job["id"]);
  const name = text(job["name"]);
  if (id === "" || name === "") return null;
  const status = text(job["status"]).toLowerCase();
  const optional = job["allow_failure"] === true;
  const failed = (status === "failed" && !optional) || status === "canceled";
  const passed = status === "success" || status === "skipped" || (status === "manual" && optional) || (status === "failed" && optional);
  return { id: `job-${id}`, name, url: text(job["web_url"]) || null, state: failed ? "failed" : passed ? "passed" : "pending" };
}

/**
 * The pipeline as a whole, as a check (EO-620).
 *
 * Its jobs are not all of it: `/pipelines/:id/jobs` leaves out trigger jobs,
 * which GitLab lists at `/pipelines/:id/trigger_jobs`, so a pipeline can be
 * running or have failed with nothing in that list to say so. Its own status
 * says so whatever it is made of. Only `success` and `skipped` are finished
 * and fine. `manual` is a pipeline held by a blocking job, since one with only
 * optional manual jobs left reports `success`, so like everything else
 * unfinished it is pending.
 */
function gitlabPipelineCheck(pipeline: Json): PullRequestCheck {
  const id = text(pipeline["id"]);
  const status = text(pipeline["status"]).toLowerCase();
  const state = status === "success" || status === "skipped" ? "passed" : status === "failed" || status === "canceled" ? "failed" : "pending";
  return { id: `pipeline-${id}`, name: `pipeline ${id}`, url: text(pipeline["web_url"]) || null, state };
}

/** The system note GitLab writes when a reviewer requests changes. */
const REQUESTED_CHANGES_NOTE = /^requested changes\b/i;

async function readGitLab(input: ReadPullRequestInput, address: GitLabAddress): Promise<PullRequestReading> {
  const cli = CLI_FOR.gitlab;
  const viewed = await ask(input, cli, GITLAB_WATCH_COMMANDS.mergeRequest(address));
  if (!viewed.ok) return viewed.reading;
  if (!isObject(viewed.value)) return { ok: false, problem: "error", cli, reason: `\`${cli}\` did not describe the merge request, so EO could not read it.` };
  const mr = viewed.value;
  const viewer = await askViewer(input, cli, GITLAB_WATCH_COMMANDS.viewer(address), "username");

  const headPipeline = isObject(mr["head_pipeline"]) ? mr["head_pipeline"] : null;
  const pipeline = headPipeline === null ? "" : text(headPipeline["id"]);
  const checks: PullRequestCheck[] = [];
  if (headPipeline !== null && pipeline !== "") {
    const jobs = await askAll(input, cli, (page) => GITLAB_WATCH_COMMANDS.jobs(address, pipeline, page), anArray);
    if (!jobs.ok) return jobs.reading;
    for (const job of jobs.entries) {
      const check = gitlabCheck(job);
      if (check) checks.push(check);
    }
    // Counted only when a job does not already say the same, so a failed job
    // is not reported over again as a failed pipeline.
    const whole = gitlabPipelineCheck(headPipeline);
    if (!checks.some((check) => check.state === whole.state)) checks.push(whole);
  }

  const notes = await askAll(input, cli, (page) => GITLAB_WATCH_COMMANDS.notes(address, page), anArray);
  if (!notes.ok) return notes.reading;
  const approvals = await ask(input, cli, GITLAB_WATCH_COMMANDS.approvals(address));
  if (!approvals.ok) return approvals.reading;
  const reviewers = await askAll(input, cli, (page) => GITLAB_WATCH_COMMANDS.reviewers(address, page), anArray);
  if (!reviewers.ok) return reviewers.reading;

  const rawState = text(mr["state"]).toLowerCase();
  const state = rawState === "merged" ? "merged" : rawState === "closed" ? "closed" : "open";
  const detailed = text(mr["detailed_merge_status"]).toLowerCase();
  const headSha = text(mr["sha"]);
  const approvedBy = isObject(approvals.value) ? objects(approvals.value["approved_by"]) : [];
  const approvalsLeft = isObject(approvals.value) ? Number(approvals.value["approvals_left"] ?? 0) : 0;
  const requesting = reviewers.entries.filter((reviewer) => text(reviewer["state"]).toLowerCase() === "requested_changes").map((reviewer) => loginOf(reviewer["user"], "username"));
  const requested = requesting.length > 0 || detailed === "requested_changes";

  // Each request for changes is an event GitLab records as a system note of
  // its own, with an id: the newest such note by a reviewer still asking is
  // the request that stands. A fix pushed on top leaves it the newest — the
  // same request — while asking again after approving writes a new one.
  const latestRequest = new Map<string, string>();
  const comments: PullRequestReviewComment[] = [];
  for (const note of notes.entries) {
    const body = text(note["body"]).trim();
    const id = text(note["id"]);
    if (body === "" || id === "") continue;
    const author = loginOf(note["author"], "username");
    if (note["system"] === true) {
      // GitLab narrating — "added 1 commit", "approved this merge request" —
      // which is nobody's comment, but is where a request for changes is dated.
      if (REQUESTED_CHANGES_NOTE.test(body)) latestRequest.set(author, id);
      continue;
    }
    const position = isObject(note["position"]) ? note["position"] : null;
    const where = position ? whereOf(text(position["new_path"]) || text(position["old_path"]), text(position["new_line"]) || text(position["old_line"])) : null;
    comments.push({ id: forgeCommentId.note(id), author, body, where, url: null });
  }
  // A reviewer asking with no note to say when — a GitLab that writes none —
  // is dated by the commit it was seen on, which is the best left to go on.
  const fromReviewers: ChangeRequest[] = requesting.map((who) => {
    const note = latestRequest.get(who);
    return { id: note === undefined ? `${who}@${headSha}` : `note-${note}`, by: who };
  });
  const changeRequests = !requested ? [] : fromReviewers.length > 0 ? fromReviewers : [{ id: `decision:${headSha}`, by: null }];

  return {
    ok: true,
    snapshot: {
      url: input.url,
      state,
      headSha,
      conflicted: mr["has_conflicts"] === true || detailed === "conflict",
      approved: approvedBy.length > 0 && approvalsLeft <= 0,
      mergeStatus: detailed,
      mergeable: GITLAB_MERGEABLE.has(detailed),
      changeRequests,
      checks,
      comments,
      viewer,
    },
  };
}

// ── What it means ───────────────────────────────────────────────

export type WatchPullRequestAnswer =
  | "merged"
  | "closed"
  | "conflict"
  | "checks_failed"
  | "author_commented"
  | "changes_requested"
  | "others_commented"
  | "ready"
  | "waiting";

export interface PullRequestJudgement {
  result: WatchPullRequestAnswer;
  detail: string;
  news: WatchNews[];
  /**
   * The comments and requests for changes this answer hands on (EO-759):
   * the comments' ids, and each request as `changesRequestedNewsId`. Only
   * `author_commented`, `changes_requested` and `others_commented` hand
   * anything on; every other answer's is empty, so a comment reported as
   * news beside a failed check is still waiting for one of them.
   */
  handled: string[];
}

/**
 * The id of the news a request for changes is reported with: the request
 * itself, so each is answered once. It is also the id the request is
 * recorded as handled under (`PullRequestJudgement.handled`).
 */
export const changesRequestedNewsId = (requestId: string): string => `changes-requested:${requestId}`;
/**
 * The id of the news `ready` is reported with: the head commit and the stay
 * on the step, so it is answered at most once per head commit per stay. A
 * ticket that comes back to the step on the same commit has a new id, and
 * is answered again; one parked and replied to has the same id, and is not.
 *
 * In the id rather than worked out afterwards, so the run that stored the
 * answer says by itself which stay it was. No watch row has to agree, which
 * a step that runs once does not have, and no clocks have to be compared.
 */
export const readyNewsId = (headSha: string, stay: string): string => `ready:${headSha}@${stay}`;
/**
 * The head commit a `ready` id stored before ids named the stay answered, or
 * null for any other id. Runs from then hold `ready:<sha>`, so which stay
 * they belong to has to be worked out where they are read (`reportedNewsIds`).
 */
export const legacyReadyCommit = (id: string): string | null => (id.startsWith("ready:") && !id.includes("@") ? id.slice("ready:".length) : null);
/** The id of a failed check's news: the check on this commit. */
export const failedCheckNewsId = (check: PullRequestCheck, headSha: string): string => `check:${check.id}@${headSha}`;
/**
 * The id of the news that a send-back is over a failure reported before the
 * ticket arrived (EO-622): the head commit and the stay, so every stay that
 * ends this way says so once. Without the stay, news being de-duplicated
 * would leave the second repeat with nothing in the thread.
 */
export const repeatedFailureNewsId = (headSha: string, stay: string): string => `checks-repeated:${headSha}@${stay}`;
/** The id of a conflict's news: the conflict on this commit. */
export const conflictNewsId = (headSha: string): string => `conflict:${headSha}`;

export interface JudgeOptions {
  /** The step's `reportReady` input: whether approved-and-green is a result, or only something to go on waiting through. */
  reportReady: boolean;
  /**
   * The step's `readyWhen` input (EO-515): what `ready` takes besides every
   * check green and no request for changes. `approved`, the default, is an
   * approval on the forge; `mergeable` is the forge saying it can merge it.
   */
  readyWhen?: WatchPullRequestReadyWhen;
  /**
   * The stay on the step this check is part of (`watchStayOf`), which
   * `readyNewsId` is made from.
   */
  stay: string;
  /**
   * Whether an earlier check on this stay had an answer from the forge
   * (EO-620). Seeing no checks means something different on the two sides
   * of it: on the first look CI may simply not have started, so only a
   * later look can take none for a repository with no CI.
   */
  checkedThisStay: boolean;
  /**
   * The news ids this item's earlier checks already reported, on this
   * stay and every earlier one. How a request for changes is answered once
   * and how coming back to the step does not post every review comment
   * again. `ready` is answered at most once per head commit per stay: an
   * earlier stay's `readyNewsId` is in here too, but is not this stay's id.
   */
  reported: ReadonlySet<string>;
  /**
   * The news ids reported on this stay alone (EO-622), which is what tells a
   * failure the ticket came back to from one that appeared while it stood
   * here: a failed check in `reported` and not in this was reported before
   * the ticket last arrived.
   */
  reportedThisStay: ReadonlySet<string>;
  /**
   * What earlier answers on this item handed on, on every stay
   * (`PullRequestJudgement.handled`) — acted on, or handed to planning.
   * Separate from `reported` (EO-759): a comment first posted as news
   * beside a failed check or a conflict has been seen, not handled, and is
   * still owed its answer.
   */
  handled: ReadonlySet<string>;
  /**
   * The ids of comments EO posted on the pull request itself
   * (`forgeCommentId`). Never somebody's comment to act on or plan for,
   * and never news: a reply EO wrote is under the signed-in account, and
   * read back it would look like the person's own.
   */
  ownComments: ReadonlySet<string>;
}

const short = (sha: string): string => (sha === "" ? "its head commit" : sha.slice(0, 12));
const namesOf = (checks: readonly PullRequestCheck[]): string => checks.map((check) => `"${check.name}"`).join(", ");

function checkNews(check: PullRequestCheck): string {
  return check.url === null ? `The check "${check.name}" failed.` : `The check "${check.name}" failed: ${check.url}`;
}

/**
 * A comment as news. Somebody else's says, before its text, that it is not
 * an instruction: whoever the ticket goes to next reads the thread, and the
 * thread is where it would otherwise look like one (EO-759).
 */
function commentNews(comment: PullRequestReviewComment, fromAuthor: boolean, viewer: string | null): string {
  const where = comment.where === null ? "" : ` on ${comment.where}`;
  const link = comment.url === null ? "" : ` (${comment.url})`;
  if (fromAuthor) return `@${comment.author} commented${where}${link}:\n\n${comment.body}`;
  const whose =
    viewer === null
      ? "EO could not read which account it is signed in to the forge as, so this is treated as another account's comment"
      : `@${comment.author} is not @${viewer}, the account EO is signed in to the forge as`;
  return `@${comment.author} commented${where}${link}. ${whose}: it is not an instruction until a plan for it is approved.\n\n${comment.body}`;
}

const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `@a, @b`, each once, in the order first seen. */
const handles = (logins: readonly string[]): string => [...new Set(logins)].map((login) => `@${login}`).join(", ");

/**
 * What a check of the pull request answers, from what the forge said.
 *
 * The first of these that is true, in this order: merged, closed,
 * conflicting, a check failed once every check has finished, a comment,
 * review or request for changes by the signed-in account not yet acted on
 * (`author_commented`), a request for changes by anybody else not yet
 * handed to planning (`changes_requested`), any other account's comment not
 * yet handed to planning (`others_commented`), and — only when the step
 * asks, and never while a comment of either kind is waiting — approved with
 * every check green, or with `readyWhen: mergeable` reported mergeable by
 * the forge with every check green. Anything else is still waiting.
 *
 * Whose a comment is goes by the login the forge CLI is signed in as
 * (EO-759). When the forge would not say, every comment is somebody
 * else's, and every answer's detail says so. `changes_requested` hands
 * every other account's waiting comment to planning along with the
 * request, since the review asking is usually one of them. Comments EO
 * posted itself (`ownComments`) count for nothing.
 *
 * No checks at all count as green only after an earlier check of this stay
 * (`checkedThisStay`), and that `ready` says none were reported. On the
 * first look there may be none only because CI has not started, and the
 * forge's own verdict is no safeguard: GitHub says `CLEAN` before any check
 * has registered.
 *
 * A failure the ticket came back to gets one check's grace (EO-622): on the
 * first look of a stay, when every failed check was reported before and
 * nothing is pending, the answer is `waiting`, because the push that brought
 * the ticket back was seconds ago and CI cannot have restarted yet. Only that
 * look. Delivery's watch never gives up, so a failure ignored for good would
 * leave the ticket waiting on nothing, and `reported` also holds a failure
 * posted while other checks ran on this same stay, which is owed its answer
 * once they finish. The answer after the grace is `checks_failed`, with news
 * saying CI was not restarted: the old failure's own news is not posted
 * again, so the thread would otherwise say nothing about why the work is back.
 *
 * News goes with every answer: each failed check, each comment, a
 * conflict appearing. Each is left out once an earlier check reported it.
 * The ready commit is itself news, so it is answered once per stay. A
 * comment or request for changes is answered once by what earlier answers
 * handed on (`handled`), not by what was reported: news only says it has
 * been seen.
 */
export function judgePullRequest(snapshot: PullRequestSnapshot, options: JudgeOptions): PullRequestJudgement {
  const { headSha, viewer } = snapshot;
  const news: WatchNews[] = [];
  const add = (entry: WatchNews): void => {
    if (!options.reported.has(entry.id) && !news.some((already) => already.id === entry.id)) news.push(entry);
  };
  const byAuthor = (login: string | null): boolean => viewer !== null && login !== null && sameLogin(login, viewer);
  const comments = snapshot.comments.filter((comment) => !options.ownComments.has(comment.id));

  if (snapshot.state === "open" && snapshot.conflicted) {
    add({ id: conflictNewsId(headSha), text: `The pull request conflicts with its base branch at ${short(headSha)}, so the forge cannot merge it.` });
  }
  const failed = snapshot.checks.filter((check) => check.state === "failed");
  for (const check of failed) add({ id: failedCheckNewsId(check, headSha), text: checkNews(check) });
  for (const comment of comments) add({ id: comment.id, text: commentNews(comment, byAuthor(comment.author), viewer) });

  // Said on every answer, since it changes what every one of them means.
  const unknownViewer = viewer === null ? " EO could not read which account the forge CLI is signed in as, so every comment is treated as another account's." : "";
  const answer = (result: WatchPullRequestAnswer, detail: string, handled: string[] = []): PullRequestJudgement => ({ result, detail: `${detail}${unknownViewer}`, news, handled });

  if (snapshot.state === "merged") return answer("merged", `${snapshot.url} has been merged.`);
  if (snapshot.state === "closed") return answer("closed", `${snapshot.url} was closed without being merged.`);
  if (snapshot.conflicted) return answer("conflict", `${snapshot.url} conflicts with its base branch at ${short(headSha)}, so it cannot be merged.`);

  const pending = snapshot.checks.filter((check) => check.state === "pending");
  if (failed.length > 0 && pending.length === 0) {
    const names = namesOf(failed);
    const repeated = failed.filter((check) => {
      const id = failedCheckNewsId(check, headSha);
      return options.reported.has(id) && !options.reportedThisStay.has(id);
    });
    if (!options.checkedThisStay && repeated.length === failed.length) {
      return answer("waiting", `${snapshot.url} is open, waiting one check for CI to restart: the failure of ${names} on ${short(headSha)} was already reported.`);
    }
    if (repeated.length > 0) {
      add({ id: repeatedFailureNewsId(headSha, options.stay), text: `CI was not restarted: ${namesOf(repeated)} on ${short(headSha)} still ${repeated.length === 1 ? "shows the failure" : "show the failures"} reported before this ticket last came back.` });
    }
    return answer("checks_failed", `Every check on ${short(headSha)} has finished, and ${failed.length === 1 ? `one failed: ${names}` : `${failed.length} failed: ${names}`}.`);
  }

  // Each comment and request is handed on once: one already answered still
  // stands until its reviewer looks again, and sending the fix back for it
  // would be sending it back for a review it has had.
  const waitingComments = comments.filter((comment) => !options.handled.has(comment.id));
  const waitingRequests = snapshot.changeRequests.filter((request) => !options.handled.has(changesRequestedNewsId(request.id)));
  const requestNews = (request: ChangeRequest): WatchNews => ({ id: changesRequestedNewsId(request.id), text: `${request.by === null ? "A reviewer" : `@${request.by}`} requested changes.` });

  const authorComments = waitingComments.filter((comment) => byAuthor(comment.author));
  const authorRequests = waitingRequests.filter((request) => byAuthor(request.by));
  if (authorComments.length > 0 || authorRequests.length > 0) {
    for (const request of authorRequests) add(requestNews(request));
    const what = [
      ...(authorComments.length > 0 ? [`${authorComments.length} comment${authorComments.length === 1 ? "" : "s"}`] : []),
      ...(authorRequests.length > 0 ? ["a request for changes"] : []),
    ].join(" and ");
    return answer("author_commented", `@${viewer} left ${what} on ${snapshot.url} to act on.`, [...authorComments.map((comment) => comment.id), ...authorRequests.map((request) => changesRequestedNewsId(request.id))]);
  }

  const otherComments = waitingComments.filter((comment) => !byAuthor(comment.author));
  const commentIds = otherComments.map((comment) => comment.id);
  if (waitingRequests.length > 0) {
    const by = waitingRequests.some((request) => request.by !== null) ? handles(waitingRequests.flatMap((request) => (request.by === null ? [] : [request.by]))) : "A reviewer";
    for (const request of waitingRequests) add(requestNews(request));
    return answer("changes_requested", `${by} requested changes on ${snapshot.url}. Not an instruction until a plan for it is approved.`, [...waitingRequests.map((request) => changesRequestedNewsId(request.id)), ...commentIds]);
  }
  if (otherComments.length > 0) {
    const count = `${otherComments.length} comment${otherComments.length === 1 ? "" : "s"}`;
    return answer("others_commented", `${handles(otherComments.map((comment) => comment.author))} left ${count} on ${snapshot.url}, not to be acted on until a plan for ${otherComments.length === 1 ? "it" : "them"} is approved.`, commentIds);
  }

  // Never ready while anybody's request for changes stands, answered or
  // not: having heard a request once is not the same as its being withdrawn,
  // and a forge can count enough approvals while one reviewer still objects.
  // Nor while a comment waits, which it cannot by here: every comment not
  // yet handed on was answered above.
  const noChecks = snapshot.checks.length === 0;
  const tooSoon = noChecks && !options.checkedThisStay;
  const green = failed.length === 0 && pending.length === 0 && !tooSoon;
  const byMergeability = options.readyWhen === "mergeable";
  const qualifies = byMergeability ? snapshot.mergeable : snapshot.approved;
  if (options.reportReady && qualifies && snapshot.changeRequests.length === 0 && green && headSha !== "") {
    const id = readyNewsId(headSha, options.stay);
    if (!options.reported.has(id)) {
      const verdict = noChecks ? `no checks were reported on ${short(headSha)}` : `every check on ${short(headSha)} passed`;
      if (byMergeability) {
        add({ id, text: `The forge reports it can be merged (${snapshot.mergeStatus}), and ${verdict}.` });
        return answer("ready", `${snapshot.url} can be merged — the forge reports ${snapshot.mergeStatus} — and ${verdict}.`);
      }
      add({ id, text: `Approved, and ${verdict}.` });
      return answer("ready", `${snapshot.url} is approved and ${verdict}.`);
    }
  }

  const waitingFor =
    pending.length > 0
      ? `${pending.length} check${pending.length === 1 ? "" : "s"} still running on ${short(headSha)}`
      : tooSoon
        ? `checks to start: it sees no checks on ${short(headSha)} yet`
        : snapshot.changeRequests.length > 0
          ? "a reviewer to look again at the changes they asked for"
          : qualifies
            ? "somebody to merge it"
            : byMergeability
              ? "the forge to report it mergeable"
              : "a review";
  // Waiting on the forge's verdict, the verdict is what a person needs to
  // see: `BLOCKED` and `DRAFT` are different things to go and fix.
  const status = !byMergeability ? "" : snapshot.mergeStatus === "" ? " The forge gave no merge status." : ` The forge reports its merge status as ${snapshot.mergeStatus}.`;
  return answer("waiting", `${snapshot.url} is open, waiting for ${waitingFor}.${status}`);
}
