import type { CliResult, CliRunner } from "./cli.js";

/**
 * Scripted `gh` and `glab` for the pull-request watch's tests (EO-460).
 *
 * Each answers the questions `watchPullRequest.ts` asks in the shapes the
 * real forges answer them — GitHub's REST reviews, line comments, check
 * runs and combined status; GitLab's merge request, jobs, notes,
 * approvals and reviewers — and pages a list exactly as the API does, by
 * the `per_page` and `page` the request names. The state is a plain object
 * a test edits between checks, as a forge's changes between two of them.
 */

const ok = (value: unknown): CliResult => ({ ok: true, stdout: JSON.stringify(value), error: "", notFound: false });

function paging(endpoint: string): { path: string; page: number; perPage: number } {
  const [path = "", query = ""] = endpoint.split("?");
  const params = new URLSearchParams(query);
  return { path, page: Number(params.get("page") ?? "1"), perPage: Number(params.get("per_page") ?? "30") };
}

function pageOf<T>(all: readonly T[], page: number, perPage: number): T[] {
  return all.slice((page - 1) * perPage, page * perPage);
}

export interface GitHubState {
  /** What `gh pr view --json state,mergeable,mergeStateStatus,reviewDecision,headRefOid` prints. */
  pr: { state: string; mergeable: string; mergeStateStatus: string; reviewDecision: string; headRefOid: string };
  /** `GET /pulls/{n}/reviews`, oldest first. */
  reviews: Record<string, unknown>[];
  /** `GET /pulls/{n}/comments`, oldest first. */
  lineComments: Record<string, unknown>[];
  /** `GET /commits/{sha}/check-runs`'s `check_runs`, for the head commit. */
  checkRuns: Record<string, unknown>[];
  /** `GET /commits/{sha}/status`'s `statuses`, for the head commit. */
  statuses: Record<string, unknown>[];
}

export const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

export function gitHubState(overrides: Partial<Omit<GitHubState, "pr">> & { pr?: Partial<GitHubState["pr"]> } = {}): GitHubState {
  return {
    reviews: [],
    lineComments: [],
    checkRuns: [],
    statuses: [],
    ...overrides,
    pr: { state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", headRefOid: SHA, ...overrides.pr },
  };
}

/** A check run as the REST API lists it. */
export function checkRun(id: number, name: string, status: "queued" | "in_progress" | "completed", conclusion: string | null = null): Record<string, unknown> {
  return {
    id,
    name,
    head_sha: SHA,
    status,
    conclusion,
    html_url: `https://github.com/acme/api/actions/runs/1/job/${id}`,
    details_url: `https://github.com/acme/api/actions/runs/1/job/${id}`,
    app: { slug: "github-actions" },
  };
}

/** A review as the REST API lists it. */
export function review(id: number, login: string, state: string, body = ""): Record<string, unknown> {
  return { id, node_id: `PRR_${id}`, user: { login }, body, state, commit_id: SHA, html_url: `https://github.com/acme/api/pull/7#pullrequestreview-${id}` };
}

/** A `gh` answering from `state()` at the moment it is asked, and recording every argv. */
export function fakeGh(state: () => GitHubState): { run: CliRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (cli, args) => {
      if (cli !== "gh") throw new Error(`expected gh, got ${cli}`);
      calls.push(args);
      const now = state();
      if (args[0] === "pr" && args[1] === "view") return ok(now.pr);
      if (args[0] !== "api") throw new Error(`unexpected gh call: ${args.join(" ")}`);
      const { path, page, perPage } = paging(args.at(-1)!);
      if (/\/pulls\/\d+\/reviews$/.test(path)) return ok(pageOf(now.reviews, page, perPage));
      if (/\/pulls\/\d+\/comments$/.test(path)) return ok(pageOf(now.lineComments, page, perPage));
      if (/\/commits\/[^/]+\/check-runs$/.test(path)) return ok({ total_count: now.checkRuns.length, check_runs: pageOf(now.checkRuns, page, perPage) });
      if (/\/commits\/[^/]+\/status$/.test(path)) {
        return ok({ state: "pending", sha: now.pr.headRefOid, total_count: now.statuses.length, statuses: pageOf(now.statuses, page, perPage) });
      }
      throw new Error(`unexpected gh api call: ${path}`);
    },
  };
}

export interface GitLabState {
  mr: Record<string, unknown>;
  jobs: Record<string, unknown>[];
  notes: Record<string, unknown>[];
  approvals: Record<string, unknown>;
  reviewers: Record<string, unknown>[];
}

export function gitLabState(overrides: Partial<GitLabState> = {}): GitLabState {
  return {
    jobs: [],
    notes: [],
    approvals: { approved: false, approvals_left: 1, approved_by: [] },
    reviewers: [],
    ...overrides,
    mr: { iid: 12, state: "opened", sha: SHA, has_conflicts: false, detailed_merge_status: "not_approved", head_pipeline: { id: 55, status: "success" }, ...overrides.mr },
  };
}

/** A `glab` answering from `state()` at the moment it is asked, and recording every argv. */
export function fakeGlab(state: () => GitLabState): { run: CliRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (cli, args) => {
      if (cli !== "glab" || args[0] !== "api") throw new Error(`unexpected call: ${cli} ${args.join(" ")}`);
      calls.push(args);
      const now = state();
      const { path, page, perPage } = paging(args.at(-1)!);
      if (/\/pipelines\/\d+\/jobs$/.test(path)) return ok(pageOf(now.jobs, page, perPage));
      if (/\/merge_requests\/\d+\/notes$/.test(path)) return ok(pageOf(now.notes, page, perPage));
      if (/\/merge_requests\/\d+\/reviewers$/.test(path)) return ok(pageOf(now.reviewers, page, perPage));
      if (/\/merge_requests\/\d+\/approvals$/.test(path)) return ok(now.approvals);
      if (/\/merge_requests\/\d+$/.test(path)) return ok(now.mr);
      throw new Error(`unexpected glab api call: ${path}`);
    },
  };
}
