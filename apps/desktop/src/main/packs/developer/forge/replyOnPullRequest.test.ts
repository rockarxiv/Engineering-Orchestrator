import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_RESULTS, developerRegistry, PLAN_COMMENT_RESPONSE_ACTION, type Agent, type Item, type PlanCommentResponseOutput, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../../db/client.js";
import { createRoute, createRun, createStep, getItem, listAgents, listCommentsForItem, transitionItem, updateRun } from "../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import { decideItem } from "../../../ipc/domainCommands.js";
import type { BuiltinContext, BuiltinOutcome } from "../../../supervisor/builtins.js";
import { createBuiltinRunners } from "../builtins.js";
import type { CliResult, CliRunner } from "./cli.js";
import { repliesOwed } from "./replyOnPullRequest.js";
import { fakeGh, gitHubState, SHA, VIEWER, type GitHubState } from "./testForges.js";

/**
 * `reply_on_pull_request` (EO-761) against real rows — the watch's answers,
 * the implementer's, the plan and a person's decision on it — and a `gh` or
 * `glab` scripted call by call.
 */

let handle: DbHandle;
let drive: string;
let implementer: Agent;

const PIPELINE = "default" as Uuid;
const GITHUB_URL = "https://github.com/acme/api/pull/7";
const GITLAB_URL = "https://gitlab.example.com/group/api/-/merge_requests/12";

const PLAN: PlanCommentResponseOutput = {
  summary: "Rename the helper; no changelog for an internal change.",
  comments: [
    { comment_id: "review-comment:11", change: "Rename `a` to `total`.", reply: "Will rename it." },
    { comment_id: "issue-comment:12", change: null, reply: "No changelog for internal changes." },
  ],
};

beforeEach(() => {
  handle = openMigratedTestDb();
  drive = mkdtempSync(join(tmpdir(), "eo replies "));
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  createStep(handle.db, {
    id: "approve_plan",
    pipelineId: PIPELINE,
    position: 20,
    name: "Approve plan",
    type: "user",
    results: [
      { key: "approve", label: "Approve", tone: "success", requiresComment: false },
      { key: "revise", label: "Revise", tone: "warning", requiresComment: true },
      { key: "reject", label: "Reject", tone: "danger", requiresComment: true },
    ],
  });
  createRoute(handle.db, { pipelineId: PIPELINE, fromStepId: "approve_plan", resultKey: "approve", label: "Approve", target: "todo", position: 0 });
  createRoute(handle.db, { pipelineId: PIPELINE, fromStepId: "approve_plan", resultKey: "revise", label: "Revise", target: "todo", position: 1 });
  createRoute(handle.db, { pipelineId: PIPELINE, fromStepId: "approve_plan", resultKey: "reject", label: "Reject", target: "todo", position: 2 });
});

afterEach(() => {
  handle.close();
  rmSync(drive, { recursive: true, force: true });
});

function ticket(pullRequest: string | null = GITHUB_URL): Item {
  const repository = attachWorkspace(handle.db, { name: "acme-api", keyPrefix: "API", repoPath: drive, baseBranch: "main" });
  return createTestItem(handle.db, { type: "story", title: "Total the basket", stepId: "todo", workspaceId: repository.id, git: { branch: "eo/API-1", ...(pullRequest === null ? {} : { pullRequest }) } });
}

function watchAnswered(item: Item, result: string, handled: string[]): void {
  const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "watch_pull_request", status: "succeeded", provider: "builtin" });
  updateRun(handle.db, run.id, { result: { raw: { ok: true, result, detail: "", handled }, parsed: { result } } });
}

function implemented(item: Item, replies?: { comment_id: string; reply: string }[]): void {
  const output = { branch: "eo/API-1", summary: "Renamed the helper.", files_changed: ["src/a.ts"], tests_run: true, handoff: "Nothing left.", ...(replies ? { replies } : {}) };
  const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" });
  updateRun(handle.db, run.id, { result: { raw: output, parsed: output } });
}

function planned(item: Item, plan: PlanCommentResponseOutput = PLAN): void {
  const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: PLAN_COMMENT_RESPONSE_ACTION, status: "succeeded" });
  updateRun(handle.db, run.id, { result: { raw: plan, parsed: plan } });
  transitionItem(handle.db, { itemId: item.id, toStepId: "approve_plan", actor: "engine", reason: "run succeeded" });
}

/** One scripted forge: every call recorded, every post answered with a fresh id, and the nth post refused when asked. */
interface Script {
  calls: string[][];
  posts: { path: string; body: string }[];
  run: CliRunner;
}

const answer = (value: unknown): CliResult => ({ ok: true, stdout: JSON.stringify(value), error: "", notFound: false });

function script(cli: "gh" | "glab", options: { refusePost?: number; discussions?: unknown[]; noHead?: boolean; onPost?: (path: string, body: string, id: number) => void; reads?: CliRunner } = {}): Script {
  const calls: string[][] = [];
  const posts: { path: string; body: string }[] = [];
  return {
    calls,
    posts,
    run: async (asked, args, cwd, rest) => {
      if (asked !== cli) throw new Error(`expected ${cli}, got ${asked}`);
      calls.push(args);
      const method = args.indexOf("--method");
      if (method >= 0) {
        const path = args[method + 2]!;
        const body = args.at(-1)!.replace(/^body=/, "");
        if (posts.length + 1 === options.refusePost) return { ok: false, stdout: "", error: "HTTP 403: Resource not accessible by integration", notFound: false };
        posts.push({ path, body });
        const id = 900 + posts.length;
        options.onPost?.(path, body, id);
        return answer({ id, body });
      }
      if (options.reads) return options.reads(asked, args, cwd, rest);
      if (cli === "gh" && args[0] === "pr" && args[1] === "view") return answer({ state: "OPEN", headRefOid: options.noHead ? "" : SHA });
      const path = args.at(-1)!.split("?")[0]!;
      if (cli === "glab" && path.endsWith("/merge_requests/12")) return answer({ iid: 12, state: "opened", sha: SHA });
      if (cli === "glab" && path.endsWith("/merge_requests/12/discussions")) return answer(options.discussions ?? []);
      throw new Error(`unexpected ${cli} call: ${args.join(" ")}`);
    },
  };
}

function context(item: Item, action = "reply_on_pull_request"): BuiltinContext {
  return {
    db: handle.db,
    item: getItem(handle.db, item.id)!,
    prepareWorkspace: () => {
      throw new Error("replying needs nowhere to work");
    },
    report: () => {},
    runId: createRun(handle.db, { itemId: item.id, agentId: null, action, status: "running", provider: "builtin" }).id,
    inputs: {},
    ensureRun: () => {},
  };
}

/** Runs the step, and keeps its outcome on its run as the supervisor does. */
async function reply(item: Item, run: CliRunner): Promise<BuiltinOutcome> {
  const ctx = context(item);
  const outcome = await createBuiltinRunners(undefined, undefined, undefined, run).reply_on_pull_request(ctx);
  updateRun(handle.db, ctx.runId, { status: "succeeded", result: { raw: outcome, parsed: { result: outcome.ok ? outcome.result : "failed" } } });
  return outcome;
}

describe("reply_on_pull_request is declared", () => {
  it("by the developer pack, with its results, as a step that posts outside EO", () => {
    const registry = developerRegistry();
    expect(registry.builtins.get("reply_on_pull_request")).toMatchObject({ label: "Reply on the pull request", results: ["replied", "nothing_to_reply", "failed"], sideEffects: true });
    expect(BUILTIN_RESULTS.reply_on_pull_request).toEqual(["replied", "nothing_to_reply", "failed"]);
  });
});

describe("what is owed", () => {
  it("is nothing on a ticket's first pass, and nothing is asked of the forge", async () => {
    const item = ticket();
    implemented(item);
    const forge = script("gh");
    expect(await reply(item, forge.run)).toMatchObject({ ok: true, result: "nothing_to_reply" });
    expect(forge.calls).toEqual([]);
  });

  it("is nothing while a round handed to planning has no decided plan, or one asked to be revised", () => {
    const item = ticket();
    watchAnswered(item, "others_commented", ["review-comment:11", "issue-comment:12"]);
    expect(repliesOwed(handle.db, item.id)).toEqual([]);
    planned(item);
    expect(repliesOwed(handle.db, item.id)).toEqual([]);
    decideItem(handle.db, undefined, { itemId: item.id, resultKey: "revise", comment: "Add the changelog after all." });
    planned(item);
    expect(repliesOwed(handle.db, item.id)).toEqual([]);
  });

  it("is nothing for an answer that handed nothing on", () => {
    const item = ticket();
    watchAnswered(item, "author_commented", ["issue-comment:5"]);
    implemented(item);
    watchAnswered(item, "checks_failed", []);
    implemented(item);
    expect(repliesOwed(handle.db, item.id)).toEqual([]);
  });

  it("answers a GitHub request for changes and its review's body with one reply", () => {
    const item = ticket();
    watchAnswered(item, "author_commented", ["review:7", "changes-requested:7"]);
    implemented(item, [{ comment_id: "changes-requested:7", reply: "Done as asked." }]);
    expect(repliesOwed(handle.db, item.id)).toEqual([{ commentId: "review:7", answers: ["review:7", "changes-requested:7"], text: { kind: "changed", reply: "Done as asked.", summary: "Renamed the helper." } }]);
  });
});

describe("on GitHub", () => {
  it("replies to the author's line comment in its thread, and to a conversation comment and a review with a link, naming the commit", async () => {
    const item = ticket();
    watchAnswered(item, "author_commented", ["review-comment:11", "issue-comment:12", "review:13"]);
    implemented(item, [{ comment_id: "review-comment:11", reply: "Renamed it to `total`." }]);
    const forge = script("gh");

    const outcome = await reply(item, forge.run);

    expect(outcome).toMatchObject({ ok: true, result: "replied", postedCommentIds: ["review-comment:901", "issue-comment:902", "issue-comment:903"], repliedTo: ["review-comment:11", "issue-comment:12", "review:13"] });
    expect(forge.calls[0]).toEqual(["pr", "view", GITHUB_URL, "--json", "state,mergeable,mergeStateStatus,reviewDecision,headRefOid"]);
    expect(forge.calls[1]).toEqual(["api", "--hostname", "github.com", "--method", "POST", "repos/acme/api/pulls/7/comments/11/replies", "-f", `body=Renamed it to \`total\`.\n\nPushed in ${SHA}.`]);
    expect(forge.posts[1]).toEqual({ path: "repos/acme/api/issues/7/comments", body: `In reply to ${GITHUB_URL}#issuecomment-12:\n\nAddressed in ${SHA}: Renamed the helper.` });
    expect(forge.posts[2]?.body).toBe(`In reply to ${GITHUB_URL}#pullrequestreview-13:\n\nAddressed in ${SHA}: Renamed the helper.`);
  });

  it("posts each reply once, however often it runs", async () => {
    const item = ticket();
    watchAnswered(item, "author_commented", ["review-comment:11"]);
    implemented(item);
    const forge = script("gh");
    expect(await reply(item, forge.run)).toMatchObject({ result: "replied" });
    expect(await reply(item, forge.run)).toMatchObject({ result: "nothing_to_reply" });
    expect(forge.posts).toHaveLength(1);
  });

  it("carries out an approved plan's replies once it is implemented", async () => {
    const item = ticket();
    watchAnswered(item, "others_commented", ["review-comment:11", "issue-comment:12"]);
    planned(item);
    decideItem(handle.db, undefined, { itemId: item.id, resultKey: "approve", comment: "" });
    expect(repliesOwed(handle.db, item.id)).toEqual([]); // not carried out yet
    implemented(item, [
      { comment_id: "review-comment:11", reply: "Renamed `a` to `total`." },
      { comment_id: "issue-comment:12", reply: "Nothing changed: no changelog for internal changes." },
    ]);
    const forge = script("gh");
    expect(await reply(item, forge.run)).toMatchObject({ result: "replied", repliedTo: ["review-comment:11", "issue-comment:12"] });
    expect(forge.posts.map((post) => post.body)).toEqual([
      `Renamed \`a\` to \`total\`.\n\nPushed in ${SHA}.`,
      `In reply to ${GITHUB_URL}#issuecomment-12:\n\nNothing changed: no changelog for internal changes.\n\nPushed in ${SHA}.`,
    ]);
  });

  it("posts a person's reason for rejecting a plan, exactly as written, to every comment the plan covered, and asks nothing of the head commit", async () => {
    const item = ticket();
    watchAnswered(item, "changes_requested", ["changes-requested:7", "review-comment:11", "issue-comment:12"]);
    planned(item, { summary: "No change.", comments: [{ comment_id: "changes-requested:7", change: null, reply: "x" }, ...PLAN.comments] });
    const reason = "We are keeping the name `a` — it matches the paper.\n\nThanks for looking.";
    decideItem(handle.db, undefined, { itemId: item.id, resultKey: "reject", comment: reason });
    const forge = script("gh");

    expect(await reply(item, forge.run)).toMatchObject({ result: "replied", repliedTo: ["changes-requested:7", "review-comment:11", "issue-comment:12"] });
    expect(forge.calls.some((args) => args[0] === "pr")).toBe(false);
    expect(forge.posts).toEqual([
      { path: "repos/acme/api/issues/7/comments", body: `In reply to ${GITHUB_URL}#pullrequestreview-7:\n\n${reason}` },
      { path: "repos/acme/api/pulls/7/comments/11/replies", body: reason },
      { path: "repos/acme/api/issues/7/comments", body: `In reply to ${GITHUB_URL}#issuecomment-12:\n\n${reason}` },
    ]);
  });

  it("answers failed with a note naming what was refused, keeps what it posted before, and posts only the rest next time", async () => {
    const item = ticket();
    watchAnswered(item, "author_commented", ["review-comment:11", "issue-comment:12"]);
    implemented(item);

    const refusing = script("gh", { refusePost: 2 });
    const outcome = await reply(item, refusing.run);
    expect(outcome).toMatchObject({ ok: true, result: "failed", postedCommentIds: ["review-comment:901"], repliedTo: ["review-comment:11"] });
    const note = listCommentsForItem(handle.db, item.id).at(-1)!;
    expect(note.authorType).toBe("engine");
    expect(note.body).toContain("The forge refused the reply to issue-comment:12");
    expect(note.body).toContain("HTTP 403: Resource not accessible by integration");

    const forge = script("gh");
    expect(await reply(item, forge.run)).toMatchObject({ result: "replied", repliedTo: ["issue-comment:12"] });
    expect(forge.posts).toHaveLength(1);
  });

  it("answers failed with a note when the forge will not say the head commit", async () => {
    const item = ticket();
    watchAnswered(item, "author_commented", ["review-comment:11"]);
    implemented(item);
    const forge = script("gh", { noHead: true });
    expect(await reply(item, forge.run)).toMatchObject({ result: "failed" });
    expect(forge.posts).toEqual([]);
    expect(listCommentsForItem(handle.db, item.id).at(-1)?.body).toContain("did not say what the head commit");
  });

  it("answers failed with a note when the ticket has no pull request", async () => {
    const item = ticket(null);
    watchAnswered(item, "author_commented", ["review-comment:11"]);
    implemented(item);
    expect(await reply(item, script("gh").run)).toMatchObject({ result: "failed" });
    expect(listCommentsForItem(handle.db, item.id).at(-1)?.body).toContain("has no pull request recorded");
  });

  it("records its replies so the watch does not count them as the person's comments", async () => {
    const item = ticket();
    watchAnswered(item, "author_commented", ["review-comment:11"]);
    implemented(item);
    // The forge as the watch reads it: the person's line comment, and
    // whatever EO posts, under the very account the watch takes for theirs.
    const state: GitHubState = gitHubState({ lineComments: [{ id: 11, user: { login: VIEWER }, body: "Rename this.", path: "src/a.ts", line: 3 }] });
    const reads = fakeGh(() => state).run;
    const forge = script("gh", { reads, onPost: (path, body, id) => state.lineComments.push({ id, user: { login: VIEWER }, body, path: "src/a.ts", line: 3 }) });

    expect(await reply(item, forge.run)).toMatchObject({ result: "replied", postedCommentIds: ["review-comment:901"] });

    const watch = createBuiltinRunners(undefined, undefined, undefined, reads).watch_pull_request;
    const checked = await watch(context(item, "watch_pull_request"));
    expect(checked).toMatchObject({ ok: true, result: "waiting", handled: [] });
    expect(checked.ok ? (checked.news ?? []).map((entry) => entry.id) : null).not.toContain("review-comment:901");
  });
});

describe("on GitLab", () => {
  const discussions = [
    { id: "d-abc", individual_note: false, notes: [{ id: 41, body: "Rename this." }, { id: 42, body: "Agreed." }] },
    { id: "d-def", individual_note: true, notes: [{ id: 50, body: "Add a changelog." }] },
  ];

  it("replies to each note in its own discussion, naming the commit", async () => {
    const item = ticket(GITLAB_URL);
    watchAnswered(item, "author_commented", ["note:42", "note:50"]);
    implemented(item, [{ comment_id: "note:42", reply: "Renamed it." }]);
    const forge = script("glab", { discussions });

    expect(await reply(item, forge.run)).toMatchObject({ result: "replied", postedCommentIds: ["note:901", "note:902"], repliedTo: ["note:42", "note:50"] });
    expect(forge.calls[0]).toEqual(["api", "--hostname", "gitlab.example.com", "projects/group%2Fapi/merge_requests/12"]);
    expect(forge.calls[1]).toEqual(["api", "--hostname", "gitlab.example.com", "projects/group%2Fapi/merge_requests/12/discussions?per_page=100&page=1"]);
    expect(forge.calls[2]).toEqual(["api", "--hostname", "gitlab.example.com", "--method", "POST", "projects/group%2Fapi/merge_requests/12/discussions/d-abc/notes", "-f", `body=Renamed it.\n\nPushed in ${SHA}.`]);
    expect(forge.posts[1]).toEqual({ path: "projects/group%2Fapi/merge_requests/12/discussions/d-def/notes", body: `Addressed in ${SHA}: Renamed the helper.` });
  });

  it("posts a rejected plan's reason in each note's discussion, and to a request for changes with a link to it", async () => {
    const item = ticket(GITLAB_URL);
    watchAnswered(item, "changes_requested", ["changes-requested:note-60", "note:41"]);
    planned(item, { summary: "No change.", comments: [{ comment_id: "changes-requested:note-60", change: null, reply: "x" }, { comment_id: "note:41", change: null, reply: "y" }] });
    decideItem(handle.db, undefined, { itemId: item.id, resultKey: "reject", comment: "Out of scope for this one." });
    const forge = script("glab", { discussions });

    expect(await reply(item, forge.run)).toMatchObject({ result: "replied" });
    expect(forge.posts).toEqual([
      { path: "projects/group%2Fapi/merge_requests/12/notes", body: `In reply to ${GITLAB_URL}#note_60:\n\nOut of scope for this one.` },
      { path: "projects/group%2Fapi/merge_requests/12/discussions/d-abc/notes", body: "Out of scope for this one." },
    ]);
  });

  it("answers nothing_to_reply with nothing handled, and posts each reply once", async () => {
    const item = ticket(GITLAB_URL);
    const forge = script("glab", { discussions });
    expect(await reply(item, forge.run)).toMatchObject({ result: "nothing_to_reply" });
    watchAnswered(item, "author_commented", ["note:50"]);
    implemented(item);
    expect(await reply(item, forge.run)).toMatchObject({ result: "replied" });
    expect(await reply(item, forge.run)).toMatchObject({ result: "nothing_to_reply" });
    expect(forge.posts).toHaveLength(1);
  });

  it("answers failed with a note naming what was refused", async () => {
    const item = ticket(GITLAB_URL);
    watchAnswered(item, "author_commented", ["note:50"]);
    implemented(item);
    const forge = script("glab", { discussions, refusePost: 1 });
    expect(await reply(item, forge.run)).toMatchObject({ ok: true, result: "failed", postedCommentIds: [], repliedTo: [] });
    const note = listCommentsForItem(handle.db, item.id).at(-1)!;
    expect(note.body).toContain("The forge refused the reply to note:50");
    expect(note.body).toContain("`glab` said: HTTP 403");
  });

  it("answers failed with a note when the discussions cannot be listed", async () => {
    const item = ticket(GITLAB_URL);
    watchAnswered(item, "author_commented", ["note:50"]);
    implemented(item);
    const base = script("glab", { discussions });
    const run: CliRunner = async (cli, args, cwd, rest) => (args.at(-1)!.includes("/discussions?") ? { ok: false, stdout: "", error: "HTTP 404: Not Found", notFound: false } : base.run(cli, args, cwd, rest));
    expect(await reply(item, run)).toMatchObject({ result: "failed" });
    expect(listCommentsForItem(handle.db, item.id).at(-1)?.body).toContain("could not list the discussions");
  });
});
