import { gitStateOf } from "@eo/core";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Item, Uuid } from "@eo/core";
import type { DbHandle } from "../../../db/client.js";
import {
  addDependency,
  createRun,
  getItem,
  listAgents,
  listCommentsForItem,
  pendingPushesForItem,
  setJiraSync,
  transitionItem,
  updateItem,
  updateRun,
  updateWorkspace,
  type Workspace,
} from "../../../db/repos/index.js";
import { createBuiltinRunners } from "../builtins.js";
import { workspaces } from "../../../db/schema.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import { REPOSITORY_INDEX_DIRECTORIES } from "../repositoryIntelligence/index.js";
import { currentBranch, statusPorcelain } from "../workspace/git.js";
import type { CliResult, CliRunner } from "./cli.js";
import { updateItemText } from "../../../ipc/domainCommands.js";
import { openPullRequestForItem } from "./openForItem.js";
import { preparingAt } from "../../../supervisor/testWorkspaceKinds.js";

/**
 * Opening the pull request, end to end inside the step's own run (F-06,
 * EO-77).
 *
 * A real repository with a real bare remote, and a recorded CLI. The
 * subjects are the two things that only show up here: that exactly one
 * pull request is ever opened, and that the result the step reports is
 * the one that actually happened — which is what changed when the send
 * came out of the outbox and into the run.
 */
let handle: DbHandle;
let scratch: string;
let repoPath: string;
let remotePath: string;
let repository: Workspace;

const json = (value: unknown): CliResult => ({ ok: true, stdout: JSON.stringify(value), error: "", notFound: false });
const noneYet: CliResult = { ok: true, stdout: "[]", error: "", notFound: false };
const created: CliResult = { ok: true, stdout: "https://github.com/acme/api/pull/7", error: "", notFound: false };
const found = json([{ url: "https://github.com/acme/api/pull/7", state: "OPEN" }]);

function recorder(replies: CliResult[]): { run: CliRunner; calls: string[][] } {
  const calls: string[][] = [];
  const queue = [...replies];
  return {
    calls,
    run: async (_cli, args) => {
      calls.push(args);
      return queue.shift() ?? noneYet;
    },
  };
}

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

function story(overrides: Partial<Parameters<typeof createTestItem>[1]> = {}): Item {
  return createTestItem(handle.db, {
    type: "story",
    workspaceId: repository.id,
    title: "Outbox table and enqueue",
    stepId: "review",
    git: { branch: "eo/API-4" },
    ...overrides,
  });
}

/**
 * Runs the `merge_request` step, which is what opens a pull request.
 *
 * It used to be a flag on arriving at a terminal state, then a step that
 * queued the work; it is a step that does the work now, so calling it is
 * the whole path. `sleep` is stubbed out — the retry loop's waits are
 * real seconds, and none of these tests is about how long they are.
 *
 * The worktree root is this scratch directory rather than the real
 * `~/.eo`, threaded exactly as the engine threads its own: the send asks
 * which checkout of the branch is EO's before it rebases (EO-156), and a
 * test whose worktrees live here while the answer came from `~/.eo`
 * would prove nothing about either.
 */
async function mergeRequestStep(item: Item, run: CliRunner, report: (text: string) => void = () => {}) {
  const runners = createBuiltinRunners(
    (db, subject, options) => openPullRequestForItem(db, subject, { ...options, run, sleep: async () => {} }),
    join(scratch, "worktrees"),
  );
  return runners.open_pull_request({
    db: handle.db,
    item: getItem(handle.db, item.id)!,
    prepareWorkspace: preparingAt(scratch),
    // What the step would narrate into its transcript. Dropped here:
    // these tests are about what reaches the forge, and the transcript
    // has its own tests beside the supervisor that writes it.
    report,
    // The worktree builtin does not read this; the pull request one and a
    // custom module do (KAN-105).
    runId: "019fb8c6-0000-7000-8000-00000000dead" as Uuid,
  });
}

/**
 * A CLI that answers the forge's lookup with `reply` and nothing else:
 * the pass through the step with a pull request recorded asks whether it
 * is still open (EO-445), and must not go on to create anything.
 */
const onlyFinds =
  (reply: CliResult): CliRunner =>
  async (_cli, args) => {
    if (args.includes("list")) return reply;
    throw new Error(`only the lookup should have reached the forge: ${args.join(" ")}`);
  };

/** A CLI nobody expects to be called: every one of these cases stops before it. */
const unreachable: CliRunner = async (_cli, args) => {
  throw new Error(`the forge should not have been reached: ${args.join(" ")}`);
};

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo forge sender "));
  repoPath = join(scratch, "repo");
  remotePath = join(scratch, "remote.git");
  mkdirSync(repoPath, { recursive: true });

  execFileSync("git", ["init", "--bare", remotePath], { encoding: "utf8" });
  git(["init", "-b", "main"], repoPath);
  git(["config", "user.email", "eo@example.com"], repoPath);
  git(["config", "user.name", "EO"], repoPath);
  git(["config", "commit.gpgsign", "false"], repoPath);
  git(["config", "tag.gpgsign", "false"], repoPath);
  writeFileSync(join(repoPath, "README.md"), "# repo\n");
  git(["add", "-A"], repoPath);
  git(["commit", "-m", "initial"], repoPath);
  git(["remote", "add", "origin", remotePath], repoPath);
  git(["push", "-u", "origin", "main"], repoPath);
  git(["checkout", "-b", "eo/API-4"], repoPath);
  writeFileSync(join(repoPath, "outbox.ts"), "export const queued = true;\n");
  git(["add", "-A"], repoPath);
  git(["commit", "-m", "the work"], repoPath);
  git(["checkout", "main"], repoPath);

  repository = attachWorkspace(handle.db, { name: "acme-api", keyPrefix: "API", repoPath, baseBranch: "main" });
  updateWorkspace(handle.db, repository.id, { config: { forgeOpenPr: true, forgeKind: "github" } });
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("what it does not open", () => {
  it("opens nothing when the repository does not open pull requests", async () => {
    // The promise the default keeps: an upgrade must not start pushing
    // to a repository other people share.
    updateWorkspace(handle.db, repository.id, { config: { forgeOpenPr: false } });
    const item = story();

    // `skipped`, not a failure: the step declares the outcome and the
    // route sends it onward, where before the item simply never got a
    // pull request and nothing said why.
    expect(await mergeRequestStep(item, unreachable)).toMatchObject({ ok: true, result: "skipped" });
  });

  it("opens nothing for an item with no branch", async () => {
    const item = story({ git: { branch: null } });

    expect(await mergeRequestStep(item, unreachable)).toMatchObject({ ok: true, result: "skipped" });
  });

  it("opens nothing for a feature, which has no changes of its own", async () => {
    const item = story({ type: "feature" });

    expect(await mergeRequestStep(item, unreachable)).toMatchObject({ ok: true, result: "skipped" });
  });
});

describe("opening it", () => {
  it("records the url and says so on the item", async () => {
    const item = story();
    const { run } = recorder([noneYet, created, found]);

    const result = await mergeRequestStep(item, run);

    // The result the step reports is the one that happened: the pull
    // request is open by the time anything reads `opened` (EO-77).
    expect(result).toMatchObject({ ok: true, result: "opened" });
    expect(gitStateOf(getItem(handle.db, item.id)!).pullRequest).toBe("https://github.com/acme/api/pull/7");
    expect(listCommentsForItem(handle.db, item.id).at(-1)?.body).toContain("https://github.com/acme/api/pull/7");
  });

  it("opens against a base branch this checkout has never had locally", async () => {
    // Branches are cut from the remote's base branch, so nothing requires
    // a local branch of that name to exist. The commit count and the
    // template are read from `origin/<base>`; only the forge is told the
    // branch name.
    const clone = join(scratch, "someone else's clone");
    git(["clone", remotePath, clone], scratch);
    git(["config", "user.email", "other@example.com"], clone);
    git(["config", "user.name", "Someone Else"], clone);
    git(["config", "commit.gpgsign", "false"], clone);
    git(["config", "tag.gpgsign", "false"], clone);
    git(["checkout", "-b", "release/next", "origin/main"], clone);
    git(["push", "-u", "origin", "release/next"], clone);
    updateWorkspace(handle.db, repository.id, { config: { baseBranch: "release/next" } });
    expect(() => git(["rev-parse", "--verify", "release/next"], repoPath)).toThrow(); // not here, only on the remote

    const item = story();
    const { run, calls } = recorder([noneYet, created, found]);

    const result = await mergeRequestStep(item, run);

    expect(result).toMatchObject({ ok: true, result: "opened" });
    const create = calls.find((args) => args.includes("create"))!;
    expect(create[create.indexOf("--base") + 1]).toBe("release/next"); // the branch name, not origin/release/next
  });

  it("uses the reviewer's prose when the review wrote any", async () => {
    const item = story();
    const reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
    const run = createRun(handle.db, { itemId: item.id, agentId: reviewer.id, action: "review", status: "queued" });
    updateRun(handle.db, run.id, {
      status: "succeeded",
      result: { raw: "", parsed: { verdict: "approve", feedback: "Looks right.", blocking_issues: [], pull_request_body: "## What\nAn outbox." } },
    });

    let body = "";
    const cli: CliRunner = async (_cli, args) => {
      const index = args.indexOf("--body-file");
      if (index >= 0) body = readFileSync(args[index + 1]!, "utf8");
      return args.includes("list") ? noneYet : created;
    };

    await mergeRequestStep(item, cli);

    expect(body).toContain("An outbox.");
  });

  it("takes its checks from what the verifier ran, not from what the implementer claimed", async () => {
    // Invariant #5. The implementer says the tests passed; G-02 is what
    // actually ran them, and a pull request repeating the claim as a
    // check is how the claim comes to be worth nothing.
    const item = story();
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "queued" });
    updateRun(handle.db, run.id, {
      status: "succeeded",
      result: { raw: "", parsed: { branch: "eo/API-4", summary: "Added it.", handoff: "Straightforward; nothing to flag.", files_changed: ["outbox.ts"], tests_run: true } },
      verification: { ok: false, steps: [{ name: "test", ok: true, detail: "" }, { name: "lint", ok: false, detail: "2 problems" }] },
    });

    let body = "";
    const cli: CliRunner = async (_cli, args) => {
      const index = args.indexOf("--body-file");
      if (index >= 0) body = readFileSync(args[index + 1]!, "utf8");
      return args.includes("list") ? noneYet : created;
    };

    await mergeRequestStep(item, cli);

    expect(body).toContain("test ✓ · lint ✗");
  });

  it("opens exactly one across review ping-pong", async () => {
    // review → todo → review → merge_request, twice over, is one pull
    // request. The second pass reads the `prUrl` the first recorded and
    // says so rather than opening another.
    const item = story();
    const { run, calls } = recorder([noneYet, created, found, found]);

    expect(await mergeRequestStep(item, run)).toMatchObject({ ok: true, result: "opened" });
    transitionItem(handle.db, { itemId: item.id, toStepId: "todo", actor: "human" });
    expect(await mergeRequestStep(item, run)).toMatchObject({ ok: true, result: "opened" });

    expect(calls.filter((args) => args.includes("create"))).toHaveLength(1);
  });

  it("passes the link on to the mirrored Jira issue", async () => {
    const item = story({ jiraKey: "KAN-8", jiraId: "10002" });
    const { run } = recorder([noneYet, created, found]);

    await mergeRequestStep(item, run);

    const queued = pendingPushesForItem(handle.db, item.id, "jira");
    expect(queued.some((entry) => String(entry.payload["body"]).includes("https://github.com/acme/api/pull/7"))).toBe(true);
  });

  it("keeps the link out of Jira while the item's sync is off, without keeping it out of the thread", async () => {
    // The switch governs what EO says to Jira, not what it records
    // (EO-122). The engine note naming the pull request is EO's own
    // thread and goes in either way — losing that would make a silenced
    // item an item nobody can see the pull request for.
    const item = story({ jiraKey: "KAN-9", jiraId: "10003" });
    setJiraSync(handle.db, item.id, false);
    const { run } = recorder([noneYet, created, found]);

    await mergeRequestStep(getItem(handle.db, item.id)!, run);

    expect(pendingPushesForItem(handle.db, item.id, "jira")).toEqual([]);
    expect(listCommentsForItem(handle.db, item.id).some((entry) => entry.body.includes("https://github.com/acme/api/pull/7"))).toBe(true);
  });
});

describe("asking a repository's default reviewers (EO-741)", () => {
  const ghUrl = "https://github.com/acme/api/pull/7";
  const readBack = (login: string) => json([{ url: ghUrl, state: "OPEN", author: { login } }]);
  const refusedCli = (error: string): CliResult => ({ ok: false, stdout: "", error, notFound: false });

  beforeEach(() => {
    updateWorkspace(handle.db, repository.id, { config: { forgeReviewers: ["alice", "bob"] } });
  });

  it("creates the pull request on GitHub and then requests review from them, answering opened", async () => {
    const item = story();
    const { run, calls } = recorder([noneYet, created, readBack("eo-bot"), { ok: true, stdout: ghUrl, error: "", notFound: false }]);

    const result = await mergeRequestStep(item, run);

    expect(result).toMatchObject({ ok: true, result: "opened" });
    expect(calls[1]!.slice(0, 2)).toEqual(["pr", "create"]);
    expect(calls.slice(3)).toEqual([["pr", "edit", ghUrl, "--add-reviewer", "alice,bob"]]);
  });

  it("requests them as merge request reviewers on GitLab", async () => {
    updateWorkspace(handle.db, repository.id, { config: { forgeKind: "gitlab" } });
    const glUrl = "https://gitlab.com/acme/api/-/merge_requests/12";
    const item = story();
    const { run, calls } = recorder([
      noneYet,
      { ok: true, stdout: glUrl, error: "", notFound: false },
      json([{ web_url: glUrl, iid: 12, state: "opened", author: { username: "eo-bot" } }]),
      { ok: true, stdout: "", error: "", notFound: false },
    ]);

    expect(await mergeRequestStep(item, run)).toMatchObject({ ok: true, result: "opened" });
    expect(calls[1]!.slice(0, 2)).toEqual(["mr", "create"]);
    expect(calls.slice(3)).toEqual([["mr", "update", "12", "--reviewer", "+alice,+bob"]]);
  });

  it("still answers opened when the forge refuses one, records the link, and names the refusal in one comment", async () => {
    const item = story();
    const message = "GraphQL: Could not resolve to a User with the login of 'bob'. (requestReviews)";
    const ok: CliResult = { ok: true, stdout: ghUrl, error: "", notFound: false };
    const { run } = recorder([noneYet, created, readBack("eo-bot"), refusedCli(message), ok, refusedCli(message)]);

    expect(await mergeRequestStep(item, run)).toMatchObject({ ok: true, result: "opened" });

    expect(gitStateOf(getItem(handle.db, item.id)!).pullRequest).toBe(ghUrl);
    const comments = listCommentsForItem(handle.db, item.id);
    const refusals = comments.filter((comment) => comment.body.includes("could not ask"));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.body).toContain(`\`bob\`: ${message}`);
    expect(refusals[0]!.body).not.toContain("`alice`");
    expect(comments.some((comment) => comment.body.includes(`Opened ${ghUrl}`))).toBe(true);
  });

  it("leaves the author out without a comment, saying so in the transcript", async () => {
    const item = story();
    const transcript: string[] = [];
    const { run, calls } = recorder([noneYet, created, readBack("alice"), { ok: true, stdout: ghUrl, error: "", notFound: false }]);

    expect(await mergeRequestStep(item, run, (text) => transcript.push(text))).toMatchObject({ ok: true, result: "opened" });

    expect(calls.slice(3)).toEqual([["pr", "edit", ghUrl, "--add-reviewer", "bob"]]);
    expect(transcript.some((line) => line.includes("Left alice out of the reviewers"))).toBe(true);
    const comments = listCommentsForItem(handle.db, item.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).not.toContain("alice");
  });

  it("asks nobody on a pull request the forge already had open for the branch", async () => {
    const item = story();
    const { run, calls } = recorder([found]);

    expect(await mergeRequestStep(item, run)).toMatchObject({ ok: true, result: "opened" });
    expect(calls).toHaveLength(1);
    expect(calls.some((args) => args.includes("edit"))).toBe(false);
  });

  it("asks nobody on the pass through with a pull request already recorded", async () => {
    const item = story({ git: { branch: "eo/API-4", pullRequest: ghUrl } });
    const { run, calls } = recorder([found]);

    expect(await mergeRequestStep(item, run)).toMatchObject({ ok: true, result: "opened" });
    expect(calls.some((args) => args.includes("edit") || args.includes("create"))).toBe(false);
  });

  it("runs exactly the commands it did before reviewers existed when the repository has none", async () => {
    updateWorkspace(handle.db, repository.id, { config: { forgeReviewers: [] } });
    const item = story();
    const { run, calls } = recorder([noneYet, created, found]);

    expect(await mergeRequestStep(item, run)).toMatchObject({ ok: true, result: "opened" });
    const lookup = ["pr", "list", "--head", "eo/API-4", "--state", "all", "--json", "url,state", "--limit", "1"];
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(lookup);
    expect(calls[1]!.slice(0, 2)).toEqual(["pr", "create"]);
    expect(calls[2]).toEqual(lookup);
  });
});

describe("asking an item's own reviewers over the repository's (EO-742)", () => {
  const ghUrl = "https://github.com/acme/api/pull/7";
  const readBack = json([{ url: ghUrl, state: "OPEN", author: { login: "eo-bot" } }]);
  const asked: CliResult = { ok: true, stdout: ghUrl, error: "", notFound: false };

  beforeEach(() => {
    updateWorkspace(handle.db, repository.id, { config: { forgeReviewers: ["alice", "bob"] } });
  });

  it("requests the story's own list and not the repository's", async () => {
    const item = story();
    expect(updateItemText(handle.db, { itemId: item.id, reviewers: ["carol"] })).toEqual({ updated: true, problem: null });
    expect(gitStateOf(getItem(handle.db, item.id)!).reviewers).toEqual(["carol"]);
    const { run, calls } = recorder([noneYet, created, readBack, asked]);

    expect(await mergeRequestStep(getItem(handle.db, item.id)!, run)).toMatchObject({ ok: true, result: "opened" });
    expect(calls.slice(3)).toEqual([["pr", "edit", ghUrl, "--add-reviewer", "carol"]]);
  });

  it("requests nobody when the story's list is empty, running exactly the commands of a repository with none", async () => {
    const item = story();
    updateItemText(handle.db, { itemId: item.id, reviewers: [] });
    const { run, calls } = recorder([noneYet, created, found]);

    expect(await mergeRequestStep(getItem(handle.db, item.id)!, run)).toMatchObject({ ok: true, result: "opened" });
    expect(calls).toHaveLength(3);
    expect(calls.some((args) => args.includes("edit"))).toBe(false);
  });

  it("requests the feature's list for a story without its own", async () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "Outbox", stepId: null, workspaceId: repository.id });
    const item = story({ parentId: feature.id });
    updateItemText(handle.db, { itemId: feature.id, reviewers: ["dave"] });
    const { run, calls } = recorder([noneYet, created, readBack, asked]);

    expect(await mergeRequestStep(getItem(handle.db, item.id)!, run)).toMatchObject({ ok: true, result: "opened" });
    expect(calls.slice(3)).toEqual([["pr", "edit", ghUrl, "--add-reviewer", "dave"]]);
  });

  it("names the list a refused reviewer came from in the comment", async () => {
    const item = story();
    updateItemText(handle.db, { itemId: item.id, reviewers: ["carol"] });
    const refused: CliResult = { ok: false, stdout: "", error: "no such user", notFound: false };
    const { run } = recorder([noneYet, created, readBack, refused]);

    await mergeRequestStep(getItem(handle.db, item.id)!, run);
    const refusal = listCommentsForItem(handle.db, item.id).find((comment) => comment.body.includes("could not ask"));
    expect(refusal?.body).toContain(`correct the reviewers set on ${item.key}`);
  });
});

describe("named after a Reference (EO-638)", () => {
  /** The title and the body the `create` call was given. */
  function capture(): { cli: CliRunner; sent: { title: string; body: string; creates: number; edits: number } } {
    const sent = { title: "", body: "", creates: 0, edits: 0 };
    const cli: CliRunner = async (_cli, args) => {
      if (args.includes("create")) {
        sent.creates += 1;
        sent.title = args[args.indexOf("--title") + 1] ?? "";
        sent.body = readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8");
      }
      if (args.includes("edit")) sent.edits += 1;
      return args.includes("list") ? (sent.creates > 0 ? found : noneYet) : created;
    };
    return { cli, sent };
  }

  const feature = (reference: string | null) =>
    createTestItem(handle.db, { type: "feature", workspaceId: repository.id, title: "A feature", stepId: "todo", git: { reference } });

  it("titles it after the item's own Reference, and keeps EO and Jira keys out of the facts", async () => {
    const parent = feature(null);
    const item = story({ parentId: parent.id, jiraKey: "KAN-9", jiraId: "10003", git: { branch: "eo/API-4", reference: "PROJ-123" } });
    const { cli, sent } = capture();

    await mergeRequestStep(item, cli);

    expect(sent.title).toBe("PROJ-123: Outbox table and enqueue");
    const facts = sent.body.slice(sent.body.indexOf("<!-- eo:facts -->"));
    expect(facts).toContain("**PROJ-123**");
    for (const key of [item.key, parent.key, "KAN-9"]) expect(facts).not.toContain(key);
  });

  it("titles a story after its feature's Reference when it has none of its own", async () => {
    const parent = feature("PROJ-123");
    const item = story({ parentId: parent.id });
    const { cli, sent } = capture();

    await mergeRequestStep(item, cli);

    expect(sent.title).toBe("PROJ-123: Outbox table and enqueue");
    expect(sent.body.slice(sent.body.indexOf("<!-- eo:facts -->"))).not.toContain(item.key);
  });

  it("titles it after the item's own Jira key ahead of its feature's Reference, with the facts as before", async () => {
    const parent = feature("PROJ-123");
    const item = story({ parentId: parent.id, jiraKey: "KAN-9", jiraId: "10003" });
    const { cli, sent } = capture();

    await mergeRequestStep(item, cli);

    expect(sent.title).toBe("KAN-9: Outbox table and enqueue");
    expect(sent.body).toContain(`**${item.key}** · \`eo/API-4\` → \`main\``);
    expect(sent.body).not.toContain("PROJ-123");
  });

  it("titles it after the EO key when nothing else names it", async () => {
    const item = story();
    const { cli, sent } = capture();

    await mergeRequestStep(item, cli);

    expect(sent.title).toBe(`${item.key}: Outbox table and enqueue`);
  });

  it("leaves a pull request already open as it was opened when a Reference is set afterwards", async () => {
    const item = story();
    const { cli, sent } = capture();
    await mergeRequestStep(item, cli);
    expect(sent.creates).toBe(1);

    updateItem(handle.db, item.id, { git: { reference: "PROJ-123" } });
    const second = await mergeRequestStep(getItem(handle.db, item.id)!, cli);

    expect(second).toMatchObject({ ok: true, result: "opened" });
    expect(sent.creates).toBe(1);
    expect(sent.edits).toBe(0);
    expect(sent.title).toBe(`${item.key}: Outbox table and enqueue`);
  });
});

describe("when it cannot", () => {
  it("refuses, saying what the forge said, rather than reporting a pull request it did not open", async () => {
    // The whole reason the send came out of the outbox: the user
    // believes the change is up for review, and until EO-77 the step
    // said `opened` regardless and the truth arrived half an hour later
    // in a comment attached to no run.
    const item = story();
    const run: CliRunner = async () => ({ ok: false, stdout: "", error: "spawn gh ENOENT", notFound: true });

    const outcome = await mergeRequestStep(item, run);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.reason).toContain("not on PATH");
  });

  it("tries again on a failure nobody could have prevented, and gives up saying so", async () => {
    // A 502 is worth a second look; `gh` not being installed is not.
    // Three attempts seconds apart, not the outbox's six across half an
    // hour — this holds the dispatch slot while it runs.
    const item = story();
    let attempts = 0;
    const run: CliRunner = async (_cli, args) => {
      if (args.includes("list")) attempts += 1;
      return { ok: false, stdout: "", error: "HTTP 502: Bad Gateway", notFound: false };
    };

    const outcome = await mergeRequestStep(item, run);

    expect(attempts).toBe(3);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.reason).toContain("502");
    expect(outcome.ok ? "" : outcome.reason).toContain("3 times");
  });

  it("stops retrying when it has spent longer than it may, and says that rather than counting attempts", async () => {
    // The cost of doing this in the run: concurrency is 1, so a forge
    // that never answers would otherwise hold the board while three
    // attempts each waited out their own two-minute timeouts.
    const item = story();
    let attempts = 0;
    const run: CliRunner = async (_cli, args) => {
      if (args.includes("list")) attempts += 1;
      return { ok: false, stdout: "", error: "HTTP 502: Bad Gateway", notFound: false };
    };

    let clock = 0;
    const outcome = await openPullRequestForItem(handle.db, getItem(handle.db, item.id)!, {
      run,
      sleep: async () => {},
      // Every attempt takes a minute of this clock, so the second one
      // ends past the deadline and the third never starts.
      clock: () => (clock += 60_000),
      deadlineMs: 90_000,
    });

    expect(attempts).toBe(2);
    expect(outcome.kind === "failed" ? outcome.reason : "").toContain("stopped retrying after 90s");
  });

  it("succeeds on a retry, without opening two", async () => {
    const item = story();
    const calls: string[][] = [];
    let first = true;
    const run: CliRunner = async (_cli, args) => {
      calls.push(args);
      if (args.includes("list") && first) {
        first = false;
        return { ok: false, stdout: "", error: "HTTP 502: Bad Gateway", notFound: false };
      }
      return args.includes("list") ? noneYet : created;
    };

    expect(await mergeRequestStep(item, run)).toMatchObject({ ok: true, result: "opened" });
    expect(calls.filter((args) => args.includes("create"))).toHaveLength(1);
  });

  it("stops when the run is cancelled, without waiting out its own backoff", async () => {
    // A backoff is not a reason to ignore a person. The wait is
    // abort-aware and the loop is asked again afterwards, so a cancel
    // during the pause ends the step rather than costing five seconds.
    const item = story();
    const controller = new AbortController();
    let attempts = 0;
    const run: CliRunner = async (_cli, args) => {
      if (args.includes("list")) {
        attempts += 1;
        controller.abort();
      }
      return { ok: false, stdout: "", error: "HTTP 502: Bad Gateway", notFound: false };
    };

    const outcome = await openPullRequestForItem(handle.db, getItem(handle.db, item.id)!, { run, signal: controller.signal });

    expect(attempts).toBe(1);
    expect(outcome.kind === "failed" ? outcome.reason : "").toContain("cancelled");
  });

  it("cuts a single slow attempt off at the deadline, not merely the decision to start another", async () => {
    // The cost of doing this in the run is that it holds the one
    // dispatch slot there is. One attempt is `O(dependencies)` network
    // calls at 120s each, so a deadline that only gated the *next*
    // attempt bounded nothing — a single one could outlast it many times
    // over. The signal is what makes the number true.
    const item = story();
    let sawAbort = false;
    const run: CliRunner = (_cli, _args, _cwd, options) =>
      new Promise((resolve) => {
        const cut = (): void => {
          sawAbort = true;
          resolve({ ok: false, stdout: "", error: "The operation was aborted", notFound: false });
        };
        // Both halves of "was this attempt cut off". A listener added after
        // the event has already fired never runs, so a signal that arrives
        // aborted has to be counted here too — otherwise the promise never
        // settles and what the test reports is a timeout, not a verdict.
        if (options?.signal?.aborted) cut();
        else options?.signal?.addEventListener("abort", cut);
      });

    // Wide enough that the work before the first CLI call cannot lose the
    // race to it. At 300ms it could: on a loaded Windows runner the deadline
    // expired during setup, and a deadline that fires before the attempt
    // starts proves nothing about cutting an attempt short.
    //
    // And wider again on Windows, where that work is a status, a rebase in
    // a worktree of its own and a real push, each a git start: on an idle
    // Windows VM the first CLI call came 1.55s in, so 2s was lost whenever
    // the rest of the suite was running — the deadline then cut the push
    // instead, the CLI was never asked, and what the killed push left
    // running still held remote.git when afterEach came to remove it
    // (EBUSY).
    const deadlineMs = process.platform === "win32" ? 15_000 : 2_000;
    const outcome = await openPullRequestForItem(handle.db, getItem(handle.db, item.id)!, { run, deadlineMs });

    expect(sawAbort).toBe(true);
    expect(outcome.kind === "failed" ? outcome.reason : "").toContain("did not finish answering");
  });

  it("refuses, rather than skipping onward, when the item points at a repository that is gone", async () => {
    // `skipped` routes forward to the terminal step in the shipped
    // pipeline, exactly as a real skip does — so reporting it that way
    // would finish the work quietly, with no pull request and nothing
    // saying why. The workspace row behind it having vanished is
    // broken state.
    //
    // Reached with the foreign key off, because that is the only way to
    // reach it: `items.workspace_id` references `workspaces` with no
    // cascade, so the database itself refuses to leave an item pointing
    // at nothing. That makes this branch a defence rather than a
    // situation — and a defence that quietly finishes the work is worse
    // than no defence at all.
    const item = story();
    handle.db.run(sql`PRAGMA foreign_keys = OFF`);
    handle.db.delete(workspaces).where(eq(workspaces.id, repository.id)).run();
    handle.db.run(sql`PRAGMA foreign_keys = ON`);

    const outcome = await mergeRequestStep(item, unreachable);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.reason).toContain("no longer exists");
  });

  it("leaves the item alone — the work is finished either way", async () => {
    const item = story();
    const run: CliRunner = async () => ({ ok: false, stdout: "", error: "spawn gh ENOENT", notFound: true });

    await mergeRequestStep(item, run);

    // The merge step runs where the item already is; a forge that cannot
    // be reached must not move it or lose its branch. Where the refusal
    // sends it is the pipeline's business, not this function's.
    const saved = getItem(handle.db, item.id)!;
    expect(saved.stepId).toBe("review");
    expect(gitStateOf(saved)).toEqual({ branch: "eo/API-4", pullRequest: null, baseBranch: null, namedBranch: false, attachedAt: null, reference: null, reviewers: null, stackedOn: null, restacked: false });
  });
});

describe("stacking (EO-10 / KAN-42)", () => {
  /** A parent feature item, so a `depends_on` edge is in scope for stacking. */
  function feature(): Item {
    return createTestItem(handle.db, { type: "feature", workspaceId: repository.id, title: "Stacked feature", stepId: "todo" });
  }

  it("opens against the dependency's branch while it is still unmerged, resolved fresh at send time — not reused from dispatch", async () => {
    const parent = feature();
    const dependency = createTestItem(handle.db, {
      type: "story",
      workspaceId: repository.id,
      parentId: parent.id,
      title: "Dependency",
      stepId: "review",
      git: { branch: "eo/API-3" },
    });
    const item = story({ parentId: parent.id });
    addDependency(handle.db, item.id, dependency.id);

    // The dependency's own branch, cut from main, still unpublished.
    git(["branch", "eo/API-3", "main"], repoPath);

    const { run, calls } = recorder([
      json([{ url: "https://github.com/acme/api/pull/2", state: "OPEN" }]), // resolveMergeState's forge lookup for eo/API-3
      noneYet, // openPullRequest's own existing-PR lookup for eo/API-4
      created,
      json([{ url: "https://github.com/acme/api/pull/7", state: "OPEN" }]),
    ]);

    const result = await mergeRequestStep(item, run);

    expect(result).toMatchObject({ ok: true, result: "opened" });
    expect(calls[0]).toEqual(["pr", "list", "--head", "eo/API-3", "--state", "all", "--json", "url,state", "--limit", "1"]);
    const create = calls.find((args) => args.includes("create"))!;
    expect(create[create.indexOf("--base") + 1]).toBe("eo/API-3");
    // The item's own branch really was pushed, not just claimed to be.
    expect(execFileSync("git", ["branch", "--list", "eo/API-4"], { cwd: remotePath, encoding: "utf8" })).toContain("eo/API-4");
  });

  it("escalates — never opening anything — when the dependency's MR closed without merging", async () => {
    const parent = feature();
    const dependency = createTestItem(handle.db, {
      type: "story",
      workspaceId: repository.id,
      parentId: parent.id,
      title: "Dependency",
      stepId: "todo",
      git: { branch: "eo/API-3" },
    });
    const item = story({ parentId: parent.id });
    addDependency(handle.db, item.id, dependency.id);

    const { run, calls } = recorder([json([{ url: "https://github.com/acme/api/pull/2", state: "CLOSED" }])]);

    const outcome = await mergeRequestStep(item, run);

    // A refusal, which the step reports as `failed` and the pipeline
    // routes — by default to a person, since nothing else can decide
    // what a closed dependency means.
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.reason).toContain(dependency.key);
    expect(calls.some((args) => args.includes("create"))).toBe(false);
    expect(gitStateOf(getItem(handle.db, item.id)!).pullRequest).toBeNull();
    // Nothing was pushed either — the branch never left the local repo.
    expect(execFileSync("git", ["branch", "--list", "eo/API-4"], { cwd: remotePath, encoding: "utf8" })).toBe("");
  });

  it("escalates when two same-feature dependencies are equidistant and both still open", async () => {
    const parent = feature();
    const depA = createTestItem(handle.db, { type: "story", workspaceId: repository.id, parentId: parent.id, title: "A", stepId: "review", git: { branch: "eo/API-2" } });
    const depB = createTestItem(handle.db, { type: "story", workspaceId: repository.id, parentId: parent.id, title: "B", stepId: "review", git: { branch: "eo/API-3" } });
    const item = story({ parentId: parent.id });
    addDependency(handle.db, item.id, depA.id);
    addDependency(handle.db, item.id, depB.id);

    const open = json([{ url: "https://github.com/acme/api/pull/1", state: "OPEN" }]);
    const { run, calls } = recorder([open, open]);

    const outcome = await mergeRequestStep(item, run);

    expect(outcome.ok).toBe(false);
    expect(calls.some((args) => args.includes("create"))).toBe(false);
    const reason = outcome.ok ? "" : outcome.reason;
    expect(reason).toContain(depA.key);
    expect(reason).toContain(depB.key);
    // A tie is a question, so EO names the answers it would take — the
    // supervisor turns these into the buttons on its comment.
    expect(outcome.ok ? [] : (outcome.options ?? [])).toHaveLength(2);
  });

  it("rebases onto the current base branch when the dependency has since merged, dropping its pre-squash history", async () => {
    const parent = feature();
    const dependency = createTestItem(handle.db, {
      type: "story",
      workspaceId: repository.id,
      parentId: parent.id,
      title: "Dependency",
      stepId: "ready_to_merge",
      git: { branch: "eo/API-3" },
    });
    const item = story({ parentId: parent.id });
    addDependency(handle.db, item.id, dependency.id);

    // Recreate eo/API-4 as if its worktree had been cut from the
    // dependency's branch, before the dependency merged.
    git(["branch", "-D", "eo/API-4"], repoPath);
    git(["checkout", "-b", "eo/API-3"], repoPath);
    writeFileSync(join(repoPath, "dep.ts"), "export const dep = true;\n");
    git(["add", "-A"], repoPath);
    git(["commit", "-m", "dependency work"], repoPath);
    git(["checkout", "-b", "eo/API-4"], repoPath);
    writeFileSync(join(repoPath, "outbox.ts"), "export const queued = true;\n");
    git(["add", "-A"], repoPath);
    git(["commit", "-m", "the work"], repoPath);

    // The dependency merges into main via squash — same content, a
    // different, rewritten commit — while eo/API-4 still points at the
    // original, pre-squash commit.
    //
    // On the *remote* only, and the local `main` is put back where it was
    // afterwards: that is what a squash-merge on the forge actually looks
    // like from here until somebody pulls. A rebase that read the local
    // `main` would find none of this and leave "dependency work" in place,
    // which is exactly the assertion below.
    git(["checkout", "main"], repoPath);
    git(["merge", "--squash", "eo/API-3"], repoPath);
    git(["commit", "-m", "squash-merge eo/API-3"], repoPath);
    git(["push", "origin", "main"], repoPath);
    git(["reset", "--hard", "HEAD~1"], repoPath);
    git(["checkout", "main"], repoPath);

    const branchBefore = await currentBranch(repoPath);
    const statusBefore = await statusPorcelain(repoPath);

    const { run, calls } = recorder([
      json([{ url: "https://github.com/acme/api/pull/2", state: "MERGED" }]), // resolveMergeState for eo/API-3
      noneYet,
      created,
      json([{ url: "https://github.com/acme/api/pull/7", state: "OPEN" }]),
    ]);

    const result = await mergeRequestStep(item, run);

    expect(result).toMatchObject({ ok: true, result: "opened" });
    const create = calls.find((args) => args.includes("create"))!;
    // No longer stacked: back to the repository's own base branch.
    expect(create[create.indexOf("--base") + 1]).toBe("main");

    // The pushed branch carries the dependency's squash-merged commit
    // via main, and the item's own work reapplied on top of it — but
    // not the dependency's original, pre-squash commit.
    const pushedLog = execFileSync("git", ["log", "--oneline", "eo/API-4"], { cwd: remotePath, encoding: "utf8" });
    expect(pushedLog).toContain("squash-merge eo/API-3");
    expect(pushedLog).toContain("the work");
    expect(pushedLog).not.toContain("dependency work");

    // repoPath itself was never left checked out on the item's branch,
    // mid-rebase, or dirty — it's the shared checkout other items' sends
    // may still be using.
    expect(await currentBranch(repoPath)).toEqual(branchBefore);
    expect(await statusPorcelain(repoPath)).toEqual(statusBefore);
  });

  it("rebases while the item's own worktree still holds the branch, and hands it back", async () => {
    // EO-148 in miniature (EO-156): a dependency merged mid-flight, so
    // the send rebases — and the item's own `~/.eo/worktrees/<KEY>`
    // still has the branch checked out, as it does at every real send.
    const parent = feature();
    const dependency = createTestItem(handle.db, {
      type: "story",
      workspaceId: repository.id,
      parentId: parent.id,
      title: "Dependency",
      stepId: "ready_to_merge",
      git: { branch: "eo/API-3" },
    });
    const item = story({ parentId: parent.id });
    addDependency(handle.db, item.id, dependency.id);

    // eo/API-4 cut from the dependency's branch, before it merged.
    git(["branch", "-D", "eo/API-4"], repoPath);
    git(["checkout", "-b", "eo/API-3"], repoPath);
    writeFileSync(join(repoPath, "dep.ts"), "export const dep = true;\n");
    git(["add", "-A"], repoPath);
    git(["commit", "-m", "dependency work"], repoPath);
    git(["checkout", "-b", "eo/API-4"], repoPath);
    writeFileSync(join(repoPath, "outbox.ts"), "export const queued = true;\n");
    git(["add", "-A"], repoPath);
    git(["commit", "-m", "the work"], repoPath);

    // The dependency squash-merges on the remote while eo/API-4 still
    // points at its pre-squash commit.
    git(["checkout", "main"], repoPath);
    git(["merge", "--squash", "eo/API-3"], repoPath);
    git(["commit", "-m", "squash-merge eo/API-3"], repoPath);
    git(["push", "origin", "main"], repoPath);
    git(["reset", "--hard", "HEAD~1"], repoPath);
    git(["checkout", "main"], repoPath);

    // The worktree the implementer worked in, still there and still on
    // the branch: git will not let it be checked out anywhere else.
    //
    // Keyed by the item's own key, not by the branch — EO-14 pinned
    // that, and here the two genuinely differ (the branch is eo/API-4,
    // the item is whatever key the fixture drew), which is the same
    // way round as an item whose branch is named after its Jira key.
    const worktreePath = join(scratch, "worktrees", getItem(handle.db, item.id)!.key);
    git(["worktree", "add", worktreePath, "eo/API-4"], repoPath);

    const { run, calls } = recorder([
      json([{ url: "https://github.com/acme/api/pull/2", state: "MERGED" }]), // resolveMergeState for eo/API-3
      noneYet,
      created,
      json([{ url: "https://github.com/acme/api/pull/7", state: "OPEN" }]),
    ]);

    const result = await mergeRequestStep(item, run);

    // Before EO-156 this never got past the rebase: the throwaway
    // worktree could not be created while this one held the branch, and
    // the step escalated instead of opening anything.
    expect(result).toMatchObject({ ok: true, result: "opened" });
    expect(calls.some((args) => args.includes("create"))).toBe(true);
    const pushedLog = execFileSync("git", ["log", "--oneline", "eo/API-4"], { cwd: remotePath, encoding: "utf8" });
    expect(pushedLog).toContain("squash-merge eo/API-3");
    expect(pushedLog).toContain("the work");
    expect(pushedLog).not.toContain("dependency work");

    // The worktree is left as it was found — on its branch and clean —
    // because the reviewer may well send this item straight back.
    expect(await currentBranch(worktreePath)).toEqual({ ok: true, stdout: "eo/API-4" });
    expect(await statusPorcelain(worktreePath)).toEqual({ ok: true, stdout: "" });
  });
});

/**
 * A base branch set on the ticket (EO-364): the pull request opens
 * against it, whatever the ticket's dependencies say, and the branch is
 * pushed as it stands — never rebased first, because EO does not move a
 * branch off the base a person said it belongs on.
 */
describe("a base branch set on the ticket", () => {
  it("opens against it without rebasing, even where a merged dependency would otherwise have rebased the branch", async () => {
    // The named base exists only on the remote, and `main` has moved on
    // there since the branch was cut: a rebase onto it would rewrite
    // every commit on the branch.
    git(["push", "origin", "main:release/next"], repoPath);
    const clone = join(scratch, "someone else's clone");
    git(["clone", remotePath, clone], scratch);
    git(["config", "user.email", "other@example.com"], clone);
    git(["config", "user.name", "Someone Else"], clone);
    git(["config", "commit.gpgsign", "false"], clone);
    git(["config", "tag.gpgsign", "false"], clone);
    git(["checkout", "-B", "main", "origin/main"], clone);
    writeFileSync(join(clone, "landed.txt"), "merged on main\n");
    git(["add", "-A"], clone);
    git(["commit", "-m", "somebody else's merge"], clone);
    git(["push", "origin", "main"], clone);

    const parent = createTestItem(handle.db, { type: "feature", workspaceId: repository.id, title: "A feature", stepId: "todo" });
    const dependency = createTestItem(handle.db, {
      type: "story",
      workspaceId: repository.id,
      parentId: parent.id,
      title: "Dependency",
      stepId: "ready_to_merge",
      git: { branch: "eo/API-3" },
    });
    const item = story({ parentId: parent.id, git: { branch: "eo/API-4", baseBranch: "release/next" } });
    addDependency(handle.db, item.id, dependency.id);
    const before = git(["rev-parse", "eo/API-4"], repoPath).trim();

    // No reply for the dependency: a set base means the forge is never
    // asked about it, so the first call is the pull request's own lookup.
    const { run, calls } = recorder([noneYet, created, found]);

    const result = await mergeRequestStep(item, run);

    expect(result).toMatchObject({ ok: true, result: "opened" });
    expect(calls.some((args) => args.includes("eo/API-3"))).toBe(false);
    const create = calls.find((args) => args.includes("create"))!;
    expect(create[create.indexOf("--base") + 1]).toBe("release/next");
    // Pushed exactly as it was: the same commit, not a rebased copy.
    expect(execFileSync("git", ["rev-parse", "eo/API-4"], { cwd: remotePath, encoding: "utf8" }).trim()).toBe(before);
  });

  it("opens against the repository's base exactly as before when none is set", async () => {
    const item = story();
    const { run, calls } = recorder([noneYet, created, found]);

    expect(await mergeRequestStep(item, run)).toMatchObject({ ok: true, result: "opened" });
    const create = calls.find((args) => args.includes("create"))!;
    expect(create[create.indexOf("--base") + 1]).toBe("main");
  });
});

/**
 * An existing branch named on the ticket (EO-365): the pull request
 * opens from that branch, and it is pushed as it stands — never rebased,
 * whatever its dependencies say, because it is the person's.
 */
describe("an existing branch named on the ticket", () => {
  it("opens from it against the repository's base, without rebasing it, even where a merged dependency would have", async () => {
    git(["branch", "feature/limits", "eo/API-4"], repoPath);
    // `main` moves on upstream, so a rebase would rewrite the branch.
    const clone = join(scratch, "someone else's clone");
    git(["clone", remotePath, clone], scratch);
    git(["config", "user.email", "other@example.com"], clone);
    git(["config", "user.name", "Someone Else"], clone);
    git(["config", "commit.gpgsign", "false"], clone);
    git(["config", "tag.gpgsign", "false"], clone);
    git(["checkout", "-B", "main", "origin/main"], clone);
    writeFileSync(join(clone, "landed.txt"), "merged on main\n");
    git(["add", "-A"], clone);
    git(["commit", "-m", "somebody else's merge"], clone);
    git(["push", "origin", "main"], clone);

    const parent = createTestItem(handle.db, { type: "feature", workspaceId: repository.id, title: "A feature", stepId: "todo" });
    const dependency = createTestItem(handle.db, {
      type: "story",
      workspaceId: repository.id,
      parentId: parent.id,
      title: "Dependency",
      stepId: "ready_to_merge",
      git: { branch: "eo/API-3" },
    });
    const item = story({ parentId: parent.id, git: { branch: "feature/limits", namedBranch: true, attachedAt: "0000000" } });
    addDependency(handle.db, item.id, dependency.id);
    const before = git(["rev-parse", "feature/limits"], repoPath).trim();

    // The dependency is never asked about: the first call is the pull
    // request's own lookup.
    const { run, calls } = recorder([noneYet, created, found]);

    const result = await mergeRequestStep(item, run);

    expect(result).toMatchObject({ ok: true, result: "opened" });
    expect(calls.some((args) => args.includes("eo/API-3"))).toBe(false);
    const create = calls.find((args) => args.includes("create"))!;
    expect(create[create.indexOf("--head") + 1]).toBe("feature/limits");
    expect(create[create.indexOf("--base") + 1]).toBe("main");
    expect(git(["rev-parse", "feature/limits"], repoPath).trim()).toBe(before);
    expect(execFileSync("git", ["rev-parse", "feature/limits"], { cwd: remotePath, encoding: "utf8" }).trim()).toBe(before);
  });
});

/**
 * What the step does before it opens or reuses a pull request (EO-429):
 * looks in the ticket's worktree for files nobody committed, then pushes
 * — on every pass, not only the first — and sends back what it will not
 * resolve itself.
 */
describe("before it opens or reuses one (EO-429)", () => {
  const PULL_REQUEST = "https://github.com/acme/api/pull/7";

  /** The ticket's own worktree, where the engine keeps it: `<root>/<KEY>`, on the ticket's branch. */
  function worktreeFor(item: Item, branch = "eo/API-4"): string {
    const path = join(scratch, "worktrees", getItem(handle.db, item.id)!.key);
    git(["worktree", "add", path, branch], repoPath);
    return path;
  }

  const remoteTip = (branch = "eo/API-4"): string | null => {
    try {
      return execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: remotePath, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  const localTip = (branch = "eo/API-4"): string => git(["rev-parse", branch], repoPath).trim();
  const notes = (item: Item): string[] => listCommentsForItem(handle.db, item.id).map((entry) => entry.body);

  /** Another commit on the branch, made in the worktree as an implementer would. */
  function commitIn(worktree: string, file: string, message: string): void {
    writeFileSync(join(worktree, file), `// ${message}\n`);
    git(["add", file], worktree);
    git(["commit", "-m", message], worktree);
  }

  /**
   * The remote holds one version of the branch and the local branch
   * another: what verification's rebase leaves behind once a pull
   * request is open and the base has moved.
   */
  function diverge(branch = "eo/API-4"): { remote: string } {
    git(["push", "origin", branch], repoPath);
    const remote = remoteTip(branch)!;
    git(["checkout", branch], repoPath);
    git(["commit", "--amend", "-m", "the work, rebased"], repoPath);
    git(["checkout", "main"], repoPath);
    expect(localTip(branch)).not.toBe(remote);
    return { remote };
  }

  describe("uncommitted files", () => {
    it("returns uncommitted_changes for a modified tracked file, pushing nothing and asking the forge nothing", async () => {
      const item = story();
      const worktree = worktreeFor(item);
      writeFileSync(join(worktree, "outbox.ts"), "export const queued = false;\n");

      const result = await mergeRequestStep(item, unreachable);

      expect(result).toMatchObject({ ok: true, result: "uncommitted_changes" });
      expect(remoteTip()).toBeNull();
      expect(gitStateOf(getItem(handle.db, item.id)!).pullRequest).toBeNull();
    });

    it("returns it for an untracked file too, when the pull request is already recorded", async () => {
      const item = story({ git: { branch: "eo/API-4", pullRequest: PULL_REQUEST } });
      const worktree = worktreeFor(item);
      // A commit the remote lacks, so "nothing was pushed" is a claim
      // about the check rather than about there being nothing to push.
      commitIn(worktree, "more.ts", "review feedback");
      writeFileSync(join(worktree, "scratch notes.md"), "left behind\n");

      const result = await mergeRequestStep(item, unreachable);

      expect(result).toMatchObject({ ok: true, result: "uncommitted_changes" });
      expect(remoteTip()).toBeNull();
    });

    it("says which paths on the ticket, and that they must be committed or removed", async () => {
      const item = story();
      const worktree = worktreeFor(item);
      writeFileSync(join(worktree, "outbox.ts"), "export const queued = false;\n");
      writeFileSync(join(worktree, "leftover.log"), "noise\n");

      await mergeRequestStep(item, unreachable);

      const note = listCommentsForItem(handle.db, item.id).at(-1)!;
      expect(note).toMatchObject({ authorType: "engine", kind: "note" });
      expect(note.body).toContain("`outbox.ts`");
      expect(note.body).toContain("`leftover.log`");
      expect(note.body).toContain("must be committed or removed");
    });

    it("does not count what git ignores, or EO's own generated index", async () => {
      const item = story();
      const worktree = worktreeFor(item);
      // Ignored by a committed `.gitignore`…
      writeFileSync(join(worktree, ".gitignore"), "dist/\n");
      git(["add", ".gitignore"], worktree);
      git(["commit", "-m", "ignore the build"], worktree);
      mkdirSync(join(worktree, "dist"));
      writeFileSync(join(worktree, "dist", "bundle.js"), "built\n");
      // …by `info/exclude`, which a worktree shares with its repository…
      writeFileSync(join(repoPath, ".git", "info", "exclude"), "*.local\n");
      writeFileSync(join(worktree, "settings.local"), "mine\n");
      // …and the index EO itself wrote there, which nothing ignores.
      const index = REPOSITORY_INDEX_DIRECTORIES[0]!;
      mkdirSync(join(worktree, index));
      writeFileSync(join(worktree, index, "index.db"), "generated\n");
      // Really there, and really something git reports: without this the
      // case would pass for an index that was never written.
      expect(git(["status", "--porcelain"], worktree)).toContain(index);

      const { run } = recorder([noneYet, created, found]);

      expect(await mergeRequestStep(item, run)).toMatchObject({ ok: true, result: "opened" });
      expect(remoteTip()).toBe(localTip());
    });

    it("skips the check, saying so, when the worktree is not there — and opens as normal", async () => {
      const item = story();
      const { run, calls } = recorder([noneYet, created, found]);
      const said: string[] = [];

      const outcome = await openPullRequestForItem(handle.db, getItem(handle.db, item.id)!, {
        run,
        sleep: async () => {},
        worktreeRoot: join(scratch, "worktrees"),
        onProgress: (text) => said.push(text),
      });

      expect(outcome.kind).toBe("opened");
      expect(said.some((line) => line.includes("no worktree") && line.includes("nothing to check"))).toBe(true);
      expect(calls.some((args) => args.includes("create"))).toBe(true);
      expect(remoteTip()).toBe(localTip());
    });
  });

  /**
   * A worktree that is there and will not say what is in it.
   *
   * Not the missing-worktree case above, and not allowed to be read as
   * one: "could not look" is not "nothing there", and a push made on
   * the strength of it publishes a branch nobody checked.
   */
  describe("a worktree git cannot read", () => {
    /**
     * Point the worktree's `.git` file at a directory that is not there.
     *
     * Removed and written fresh rather than overwritten: git for Windows
     * marks that file hidden, and opening a hidden file to replace it
     * fails with EPERM there.
     */
    function breakGitPointer(worktree: string): void {
      const pointer = join(worktree, ".git");
      rmSync(pointer);
      writeFileSync(pointer, `gitdir: ${join(scratch, "nowhere")}\n`);
    }

    /** The ticket's real worktree, with the pointer back to its repository broken. */
    function unreadableWorktreeFor(item: Item): string {
      const worktree = worktreeFor(item);
      writeFileSync(join(worktree, "leftover.log"), "the kind of file the check exists to find\n");
      breakGitPointer(worktree);
      expect(() => git(["status", "--porcelain"], worktree)).toThrow();
      return worktree;
    }

    it("fails, saying what to do, and neither pushes nor asks the forge anything", async () => {
      const item = story();
      const worktree = unreadableWorktreeFor(item);

      const outcome = await mergeRequestStep(item, unreachable);

      expect(outcome.ok).toBe(false);
      const reason = outcome.ok ? "" : outcome.reason;
      expect(reason).toContain("could not read the status");
      expect(reason).toContain(worktree);
      expect(reason).toContain("Nothing was pushed");
      expect(reason).toContain("Run `git status` in that directory");
      expect(remoteTip()).toBeNull();
      expect(gitStateOf(getItem(handle.db, item.id)!).pullRequest).toBeNull();
    });

    it("fails the same way with the pull request already recorded, leaving the remote where it was", async () => {
      const item = story({ git: { branch: "eo/API-4", pullRequest: PULL_REQUEST } });
      git(["push", "origin", "eo/API-4"], repoPath);
      const before = remoteTip();
      // A commit the remote lacks, made before the worktree broke: the
      // push this must not make has something to publish.
      const worktree = worktreeFor(item);
      commitIn(worktree, "more.ts", "review feedback");
      breakGitPointer(worktree);
      expect(localTip()).not.toBe(before);

      const outcome = await mergeRequestStep(item, unreachable);

      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? "" : outcome.reason).toContain("could not read the status");
      expect(remoteTip()).toBe(before);
    });

    it("does not try again: waiting does not repair a checkout", async () => {
      const item = story();
      unreadableWorktreeFor(item);
      const said: string[] = [];

      const outcome = await openPullRequestForItem(handle.db, getItem(handle.db, item.id)!, {
        run: unreachable,
        sleep: async () => {
          throw new Error("the step waited to retry");
        },
        worktreeRoot: join(scratch, "worktrees"),
        onProgress: (text) => said.push(text),
      });

      expect(outcome.kind).toBe("failed");
      expect(said.filter((line) => line.includes("Could not read the status"))).toHaveLength(1);
    });
  });

  describe("pushing with the pull request already open", () => {
    it("pushes the commits the remote lacks, without force, and says opened", async () => {
      const item = story({ git: { branch: "eo/API-4", pullRequest: PULL_REQUEST } });
      git(["push", "origin", "eo/API-4"], repoPath);
      const before = remoteTip();
      const worktree = worktreeFor(item);
      commitIn(worktree, "more.ts", "review feedback");
      expect(localTip()).not.toBe(before);

      const result = await mergeRequestStep(item, onlyFinds(found));

      expect(result).toMatchObject({ ok: true, result: "opened" });
      expect(remoteTip()).toBe(localTip());
      // Fast-forwarded, which is all a push without force can do.
      expect(git(["merge-base", "--is-ancestor", before!, localTip()], repoPath)).toBe("");
    });

    it("says opened and posts nothing when there is nothing to push", async () => {
      const item = story({ git: { branch: "eo/API-4", pullRequest: PULL_REQUEST } });
      git(["push", "origin", "eo/API-4"], repoPath);
      worktreeFor(item);
      const before = notes(item);

      const result = await mergeRequestStep(item, onlyFinds(found));

      expect(result).toMatchObject({ ok: true, result: "opened", detail: `Already open: ${PULL_REQUEST}` });
      expect(notes(item)).toEqual(before);
      expect(remoteTip()).toBe(localTip());
    });
  });

  describe("a remote branch that has diverged", () => {
    it("returns remote_diverged on the first open, forcing nothing and creating nothing, and names the remote, branch and base", async () => {
      const item = story();
      const { remote } = diverge();
      const { run, calls } = recorder([]);

      const result = await mergeRequestStep(item, run);

      expect(result).toMatchObject({ ok: true, result: "remote_diverged" });
      expect(remoteTip()).toBe(remote);
      expect(calls).toEqual([]);
      expect(gitStateOf(getItem(handle.db, item.id)!).pullRequest).toBeNull();

      const note = listCommentsForItem(handle.db, item.id).at(-1)!;
      expect(note).toMatchObject({ authorType: "engine", kind: "note" });
      expect(note.body).toContain("has diverged");
      expect(note.body).toContain("did not force-push");
      expect(note.body).toContain("Remote: `origin`");
      expect(note.body).toContain("Branch: `eo/API-4`");
      expect(note.body).toContain("`origin/main`");
    });

    it("returns it with the pull request already open, too", async () => {
      const item = story({ git: { branch: "eo/API-4", pullRequest: PULL_REQUEST } });
      const { remote } = diverge();
      worktreeFor(item);
      const { run, calls } = recorder([found]);

      const result = await mergeRequestStep(item, run);

      expect(result).toMatchObject({ ok: true, result: "remote_diverged" });
      expect(remoteTip()).toBe(remote);
      // Asked whether the recorded one is still open (EO-445), and nothing else.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("list");
      const note = notes(item).at(-1)!;
      expect(note).toContain("did not force-push");
      expect(note).toContain("Remote: `origin`");
      expect(note).toContain("Branch: `eo/API-4`");
      expect(note).toContain("`origin/main`");
    });

    it("pushes with --force-with-lease when a restack rewrote the branch since its last push (EO-780), and forgets that it did", async () => {
      // What a restack leaves: the remote holds the branch as it was before
      // it was carried onto its dependency's new tip.
      const item = story({ git: { branch: "eo/API-4", pullRequest: PULL_REQUEST, restacked: true } });
      const { remote } = diverge();
      worktreeFor(item);
      const progress: string[] = [];

      const result = await mergeRequestStep(item, onlyFinds(found), (text) => progress.push(text));

      expect(result).toMatchObject({ ok: true, result: "opened" });
      expect(remoteTip()).toBe(localTip());
      expect(remoteTip()).not.toBe(remote);
      expect(progress.some((line) => line.includes("--force-with-lease"))).toBe(true);
      expect(gitStateOf(getItem(handle.db, item.id)!).restacked).toBe(false);
    });

    it("says it once, not once per attempt", async () => {
      // Divergence is final on the first try: waiting does not move a
      // remote branch back, and three notes would be three instructions.
      const item = story();
      diverge();

      await mergeRequestStep(item, unreachable);

      expect(notes(item).filter((body) => body.includes("has diverged"))).toHaveLength(1);
    });

    it("stays failed, with the message it always had, for a branch a person named", async () => {
      git(["branch", "feature/limits", "eo/API-4"], repoPath);
      const { remote } = diverge("feature/limits");

      for (const pullRequest of [null, PULL_REQUEST]) {
        const item = story({ git: { branch: "feature/limits", namedBranch: true, attachedAt: "0000000", pullRequest } });
        const before = notes(item);

        const outcome = await mergeRequestStep(item, onlyFinds(found));

        expect(outcome.ok).toBe(false);
        expect(outcome.ok ? "" : outcome.reason).toContain("EO will not force-push over work it did not write");
        expect(remoteTip("feature/limits")).toBe(remote);
        // The refusal is the supervisor's to comment on, as it was.
        expect(notes(item)).toEqual(before);
      }
    });
  });

  /**
   * A named branch rewritten on the remote after Worktree checked it out —
   * what Dependabot does to its pull request whenever the base moves
   * (EO-756). Nothing of EO's is on the local branch, so the remote's
   * tip is taken rather than reported as divergence.
   */
  describe("a named branch the remote moved while EO had nothing on it (EO-756)", () => {
    function rebasedUpstream(pullRequest: string | null = null): { item: Item; worktree: string; attached: string; rebased: string } {
      git(["branch", "feature/limits", "eo/API-4"], repoPath);
      git(["push", "--force", "origin", "feature/limits"], repoPath);
      const attached = localTip("feature/limits");
      const item = story({ git: { branch: "feature/limits", namedBranch: true, attachedAt: attached, pullRequest } });
      const worktree = worktreeFor(item, "feature/limits");
      // The same change on a new commit, as a rebase leaves it, written
      // straight to the remote without the local branch knowing.
      const rebased = git(["commit-tree", "eo/API-4^{tree}", "-p", "main", "-m", "the work, rebased by Dependabot"], repoPath).trim();
      git(["push", "--force", "origin", `${rebased}:refs/heads/feature/limits`], repoPath);
      expect(rebased).not.toBe(attached);
      return { item, worktree, attached, rebased };
    }

    /** A forge whose only answer is that the pull request is open; it is never asked to create one. */
    const findsOpen: CliRunner = async (_cli, args) => {
      if (args.includes("create")) throw new Error(`nothing should have been created: ${args.join(" ")}`);
      return args.includes("list") ? found : noneYet;
    };

    it("moves the local branch to the remote's tip, records it as attachedAt, says so, and opens as if nothing had moved", async () => {
      const { item, worktree, attached, rebased } = rebasedUpstream();

      const result = await mergeRequestStep(item, findsOpen);

      expect(result).toMatchObject({ ok: true, result: "opened", detail: `Adopted the pull request already open: ${PULL_REQUEST}` });
      expect(localTip("feature/limits")).toBe(rebased);
      expect(git(["rev-parse", "HEAD"], worktree).trim()).toBe(rebased);
      expect(remoteTip("feature/limits")).toBe(rebased);
      const state = gitStateOf(getItem(handle.db, item.id)!);
      expect(state.attachedAt).toBe(rebased);
      expect(state.pullRequest).toBe(PULL_REQUEST);
      const note = notes(item).find((body) => body.includes("moved on"))!;
      expect(note).toContain(attached);
      expect(note).toContain(rebased);
      expect(notes(item).some((body) => body.includes("has diverged"))).toBe(false);
    });

    it("answers opened with the pull request already recorded on the item", async () => {
      const { item, attached, rebased } = rebasedUpstream(PULL_REQUEST);

      const result = await mergeRequestStep(item, onlyFinds(found));

      expect(result).toMatchObject({ ok: true, result: "opened", detail: `Already open: ${PULL_REQUEST}` });
      expect(localTip("feature/limits")).toBe(rebased);
      expect(remoteTip("feature/limits")).toBe(rebased);
      expect(gitStateOf(getItem(handle.db, item.id)!).attachedAt).toBe(rebased);
      const note = notes(item).find((body) => body.includes("moved on"))!;
      expect(note).toContain(attached);
      expect(note).toContain(rebased);
    });

    it("answers as it always did, moving and pushing nothing, once the branch has a commit beyond attachedAt", async () => {
      for (const pullRequest of [null, PULL_REQUEST]) {
        const { item, worktree, attached, rebased } = rebasedUpstream(pullRequest);
        commitIn(worktree, "more.ts", "EO's own work");
        const mine = localTip("feature/limits");
        const before = notes(item);

        const outcome = await mergeRequestStep(item, onlyFinds(found));

        expect(outcome.ok).toBe(false);
        expect(outcome.ok ? "" : outcome.reason).toContain("EO will not force-push over work it did not write");
        expect(localTip("feature/limits")).toBe(mine);
        expect(remoteTip("feature/limits")).toBe(rebased);
        expect(gitStateOf(getItem(handle.db, item.id)!).attachedAt).toBe(attached);
        expect(notes(item)).toEqual(before);

        // Cleared for the next pass round the loop.
        git(["worktree", "remove", "--force", worktree], repoPath);
        git(["branch", "-D", "feature/limits"], repoPath);
      }
    });

    it("leaves a branch EO cut answering remote_diverged, however little is on it", async () => {
      const item = story();
      git(["push", "origin", "eo/API-4"], repoPath);
      worktreeFor(item);
      const mine = localTip();
      const rebased = git(["commit-tree", "eo/API-4^{tree}", "-p", "main", "-m", "the work, rewritten upstream"], repoPath).trim();
      git(["push", "--force", "origin", `${rebased}:refs/heads/eo/API-4`], repoPath);

      const result = await mergeRequestStep(item, unreachable);

      expect(result).toMatchObject({ ok: true, result: "remote_diverged" });
      expect(localTip()).toBe(mine);
      expect(remoteTip()).toBe(rebased);
      expect(gitStateOf(getItem(handle.db, item.id)!).attachedAt).toBeNull();
      expect(notes(item).some((body) => body.includes("moved on"))).toBe(false);
    });
  });

  describe("where it never looked or pushed, and still does not", () => {
    it("neither checks nor pushes for a repository that does not open pull requests", async () => {
      updateWorkspace(handle.db, repository.id, { config: { forgeOpenPr: false } });

      const fresh = story();
      writeFileSync(join(worktreeFor(fresh), "leftover.log"), "noise\n");
      expect(await mergeRequestStep(fresh, unreachable)).toMatchObject({ ok: true, result: "skipped" });

      // And one whose pull request was opened before the switch went
      // off: still "already open", and still not pushed to.
      git(["branch", "eo/API-5", "eo/API-4"], repoPath);
      const recorded = story({ git: { branch: "eo/API-5", pullRequest: PULL_REQUEST } });
      writeFileSync(join(worktreeFor(recorded, "eo/API-5"), "leftover.log"), "noise\n");
      expect(await mergeRequestStep(recorded, unreachable)).toMatchObject({ ok: true, result: "opened", detail: `Already open: ${PULL_REQUEST}` });

      expect(remoteTip()).toBeNull();
      expect(remoteTip("eo/API-5")).toBeNull();
      expect(notes(fresh)).toEqual([]);
      expect(notes(recorded)).toEqual([]);
    });

    it("neither checks nor pushes for a container, or a ticket with no branch", async () => {
      const container = story({ type: "feature" });
      writeFileSync(join(worktreeFor(container), "leftover.log"), "noise\n");
      expect(await mergeRequestStep(container, unreachable)).toMatchObject({ ok: true, result: "skipped" });

      git(["branch", "eo/API-5", "eo/API-4"], repoPath);
      const branchless = story({ git: { branch: null } });
      writeFileSync(join(worktreeFor(branchless, "eo/API-5"), "leftover.log"), "noise\n");
      expect(await mergeRequestStep(branchless, unreachable)).toMatchObject({ ok: true, result: "skipped" });

      expect(remoteTip()).toBeNull();
    });
  });
});

describe("a recorded pull request that has merged or closed (EO-445)", () => {
  // Release's fix round comes back through this step after its first pull
  // request merged. "Recorded" stopped meaning "open" there, and a step
  // that answered "already open" for a merged one left the fix on a branch
  // nothing would ever merge.
  const FIRST = "https://github.com/acme/api/pull/7";
  const SECOND = "https://github.com/acme/api/pull/8";
  const stateOf = (state: string) => json([{ url: FIRST, state }]);
  const createdSecond: CliResult = { ok: true, stdout: SECOND, error: "", notFound: false };
  const foundSecond = json([{ url: SECOND, state: "OPEN" }]);

  function worktreeFor(item: Item): string {
    const path = join(scratch, "worktrees", getItem(handle.db, item.id)!.key);
    git(["worktree", "add", path, "eo/API-4"], repoPath);
    return path;
  }

  /** The first pull request, merged with a merge commit as GitHub would. */
  function mergeFirst(): void {
    git(["push", "origin", "eo/API-4"], repoPath);
    git(["merge", "--no-ff", "eo/API-4", "-m", "Merge pull request #7"], repoPath);
    git(["push", "origin", "main"], repoPath);
  }

  function fixIn(worktree: string): void {
    writeFileSync(join(worktree, "fix.ts"), "export const fixed = true;\n");
    git(["add", "fix.ts"], worktree);
    git(["commit", "-m", "the release fix"], worktree);
  }

  const notes = (item: Item): string[] => listCommentsForItem(handle.db, item.id).map((entry) => entry.body);

  it("opens a new one when the recorded one merged and the branch has carried on past it", async () => {
    const item = story({ git: { branch: "eo/API-4", pullRequest: FIRST } });
    mergeFirst();
    fixIn(worktreeFor(item));
    // The step's own lookup, then `openPullRequest`'s, which still finds
    // the merged one and must not adopt it; then create, then read-back.
    const { run, calls } = recorder([stateOf("MERGED"), stateOf("MERGED"), createdSecond, foundSecond]);

    const result = await mergeRequestStep(item, run);

    expect(result).toMatchObject({ ok: true, result: "opened", detail: `Opened ${SECOND}` });
    expect(calls.filter((args) => args.includes("create"))).toHaveLength(1);
    expect(calls.find((args) => args.includes("create"))).toEqual(expect.arrayContaining(["--head", "eo/API-4", "--base", "main"]));
    expect(gitStateOf(getItem(handle.db, item.id)!).pullRequest).toBe(SECOND);
    expect(notes(item).at(-1)).toContain(`Opened ${SECOND}`);
    expect(git(["rev-parse", "origin/eo/API-4"], repoPath).trim()).toBe(git(["rev-parse", "eo/API-4"], repoPath).trim());
  });

  it("opens a new one when the recorded one was closed without merging and the branch has commits its base lacks", async () => {
    const item = story({ git: { branch: "eo/API-4", pullRequest: FIRST } });
    git(["push", "origin", "eo/API-4"], repoPath);
    fixIn(worktreeFor(item));
    const { run, calls } = recorder([stateOf("CLOSED"), stateOf("CLOSED"), createdSecond, foundSecond]);

    const result = await mergeRequestStep(item, run);

    expect(result).toMatchObject({ ok: true, result: "opened", detail: `Opened ${SECOND}` });
    expect(calls.filter((args) => args.includes("create"))).toHaveLength(1);
    expect(gitStateOf(getItem(handle.db, item.id)!).pullRequest).toBe(SECOND);
    expect(notes(item).at(-1)).toContain(`Opened ${SECOND}`);
  });

  it("opens nothing, and answers as it always did, when the recorded one merged and nothing has been added since", async () => {
    const item = story({ git: { branch: "eo/API-4", pullRequest: FIRST } });
    mergeFirst();
    worktreeFor(item);
    const before = notes(item);

    const result = await mergeRequestStep(item, onlyFinds(stateOf("MERGED")));

    expect(result).toMatchObject({ ok: true, result: "opened", detail: `Already open: ${FIRST}` });
    expect(gitStateOf(getItem(handle.db, item.id)!).pullRequest).toBe(FIRST);
    expect(notes(item)).toEqual(before);
  });

  it("adopts and records the open one the forge has in its place, opening no third, when the recorded one merged", async () => {
    // EO created #8 and stopped before recording it, or a person opened
    // it: either way the lookup answers with #8 open, and #7 must not stay
    // on the ticket for the merge step to read as already merged.
    const item = story({ git: { branch: "eo/API-4", pullRequest: FIRST }, jiraKey: "KAN-8", jiraId: "10002" });
    mergeFirst();
    fixIn(worktreeFor(item));

    const result = await mergeRequestStep(item, onlyFinds(foundSecond));

    expect(result).toMatchObject({ ok: true, result: "opened", detail: `Adopted the pull request already open: ${SECOND}` });
    expect(gitStateOf(getItem(handle.db, item.id)!).pullRequest).toBe(SECOND);
    expect(notes(item).at(-1)).toContain(SECOND);
    expect(pendingPushesForItem(handle.db, item.id, "jira").some((entry) => String(entry.payload["body"]).includes(SECOND))).toBe(true);
    expect(git(["rev-parse", "origin/eo/API-4"], repoPath).trim()).toBe(git(["rev-parse", "eo/API-4"], repoPath).trim());

    // And the next pass reads #8 as the one it recorded: no second note.
    const before = notes(item);
    expect(await mergeRequestStep(item, onlyFinds(foundSecond))).toMatchObject({ ok: true, result: "opened", detail: `Already open: ${SECOND}` });
    expect(notes(item)).toEqual(before);
  });

  it("treats it as open, pushing and opening nothing new, when the forge cannot say", async () => {
    // Not knowing is not a reason to open a second one.
    const item = story({ git: { branch: "eo/API-4", pullRequest: FIRST } });
    mergeFirst();
    fixIn(worktreeFor(item));

    const result = await mergeRequestStep(item, onlyFinds({ ok: false, stdout: "", error: "HTTP 502", notFound: false }));

    expect(result).toMatchObject({ ok: true, result: "opened", detail: `Already open: ${FIRST}` });
    expect(gitStateOf(getItem(handle.db, item.id)!).pullRequest).toBe(FIRST);
    expect(git(["rev-parse", "origin/eo/API-4"], repoPath).trim()).toBe(git(["rev-parse", "eo/API-4"], repoPath).trim());
  });
});
