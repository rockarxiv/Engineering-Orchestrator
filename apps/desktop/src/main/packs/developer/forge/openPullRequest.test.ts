import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliResult, CliRunner } from "./cli.js";
import { openPullRequest, type OpenPullRequestInput } from "./openPullRequest.js";
import type { PullRequestFacts } from "./body.js";

/**
 * The sequence that opens a pull request (F-06).
 *
 * Real git against real repositories — including a bare one as the
 * remote, so `git push` is a genuine push — and a recorded CLI in place
 * of `gh`/`glab`. What the CLI is asked for is the interesting part, and
 * it is asserted argument by argument.
 */
let scratch: string;
let repoPath: string;
let remotePath: string;

interface Call {
  cli: string;
  args: string[];
}

/** Records every invocation and replies with whatever the test scripted. */
function recorder(replies: CliResult[] = []): { run: CliRunner; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...replies];
  const run: CliRunner = async (cli, args) => {
    calls.push({ cli, args });
    return queue.shift() ?? { ok: true, stdout: "", error: "", notFound: false };
  };
  return { run, calls };
}

const json = (value: unknown): CliResult => ({ ok: true, stdout: JSON.stringify(value), error: "", notFound: false });
const empty: CliResult = { ok: true, stdout: "[]", error: "", notFound: false };
/** What `create` prints when it works: a line with the url on it. */
const created = (url: string): CliResult => ({ ok: true, stdout: `Creating pull request for eo/API-4 into main\n${url}`, error: "", notFound: false });

function facts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    itemKey: "API-4",
    itemTitle: "Outbox table and enqueue",
    branch: "eo/API-4",
    baseBranch: "main",
    acceptanceCriteria: ["Survives a restart"],
    checks: [{ name: "test", passed: true }],
    jiraKey: null,
    jiraUrl: null,
    reference: null,
    ...overrides,
  };
}

function input(overrides: Partial<OpenPullRequestInput> = {}): OpenPullRequestInput {
  return {
    repoPath,
    branch: "eo/API-4",
    baseBranch: "main",
    remote: "origin",
    forgeKind: "github",
    draft: false,
    templatePath: null,
    agentBody: "## What\nAn outbox.",
    implementSummary: null,
    itemBody: null,
    facts: facts(),
    run: recorder().run,
    ...overrides,
  };
}

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo forge "));
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

  // The branch a finished item leaves behind.
  git(["checkout", "-b", "eo/API-4"], repoPath);
  writeFileSync(join(repoPath, "outbox.ts"), "export const queued = true;\n");
  git(["add", "-A"], repoPath);
  git(["commit", "-m", "add the outbox"], repoPath);
  git(["checkout", "main"], repoPath);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("opening one", () => {
  it("pushes the branch to the remote for real", async () => {
    const { run } = recorder([empty, created("https://github.com/acme/api/pull/7"), json([{ url: "https://github.com/acme/api/pull/7", state: "OPEN" }])]);

    const result = await openPullRequest(input({ run }));

    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://github.com/acme/api/pull/7");
    // The branch is really on the other end, not just claimed to be.
    expect(execFileSync("git", ["branch", "--list", "eo/API-4"], { cwd: remotePath, encoding: "utf8" })).toContain("eo/API-4");
  });

  it("asks gh for exactly the right thing", async () => {
    const { run, calls } = recorder([empty, created("https://github.com/acme/api/pull/7"), json([{ url: "https://github.com/acme/api/pull/7" }])]);

    await openPullRequest(input({ run, draft: true }));

    expect(calls[0]).toEqual({ cli: "gh", args: ["pr", "list", "--head", "eo/API-4", "--state", "all", "--json", "url,state", "--limit", "1"] });
    const create = calls[1]!.args;
    expect(create.slice(0, 2)).toEqual(["pr", "create"]);
    expect(create).toContain("--draft");
    // --head is what makes gh skip its interactive push-or-fork path.
    expect(create[create.indexOf("--head") + 1]).toBe("eo/API-4");
    expect(create[create.indexOf("--title") + 1]).toBe("API-4: Outbox table and enqueue");
  });

  it("hands gh a file, never the body as an argument", async () => {
    // An agent-authored markdown body is exactly the thing not to put on
    // a command line.
    let written = "";
    const run: CliRunner = async (_cli, args) => {
      const index = args.indexOf("--body-file");
      if (index >= 0) written = readFileSync(args[index + 1]!, "utf8");
      return args.includes("list") ? empty : { ok: true, stdout: "", error: "", notFound: false };
    };

    await openPullRequest(input({ run }));

    expect(written).toContain("An outbox.");
    expect(written).toContain("<!-- eo:facts -->");
  });

  it("passes GitLab the description inline, since glab has no --description-file", async () => {
    const { run, calls } = recorder([
      empty,
      created("https://gitlab.com/acme/api/-/merge_requests/3"),
      json([{ web_url: "https://gitlab.com/acme/api/-/merge_requests/3" }]),
    ]);

    const result = await openPullRequest(input({ run, forgeKind: "gitlab" }));

    expect(calls[0]!.cli).toBe("glab");
    expect(calls[0]!.args).toEqual(["mr", "list", "--source-branch", "eo/API-4", "--all", "--output", "json"]);
    const create = calls[1]!.args;
    expect(create).toContain("--yes");
    expect(create[create.indexOf("--description") + 1]).toContain("<!-- eo:facts -->");
    // GitLab calls the link web_url.
    expect(result.url).toBe("https://gitlab.com/acme/api/-/merge_requests/3");
  });

  it("reads the url back rather than scraping what create printed", async () => {
    // create's stdout also carries warnings and update notices.
    const { run } = recorder([
      empty,
      { ok: true, stdout: "Warning: 3 uncommitted changes\nhttps://github.com/acme/api/pull/OLD", error: "", notFound: false },
      json([{ url: "https://github.com/acme/api/pull/7" }]),
    ]);

    const result = await openPullRequest(input({ run }));

    expect(result.url).toBe("https://github.com/acme/api/pull/7");
  });

  it("falls back to create's stdout when the read-back comes up empty", async () => {
    const { run } = recorder([
      empty,
      { ok: true, stdout: "https://github.com/acme/api/pull/7", error: "", notFound: false },
      { ok: false, stdout: "", error: "timeout", notFound: false },
    ]);

    expect((await openPullRequest(input({ run }))).url).toBe("https://github.com/acme/api/pull/7");
  });
});

describe("not opening a second one", () => {
  it("adopts a pull request that already exists and never calls create", async () => {
    // The one window the database cannot see: a crash between create
    // succeeding on the server and the key being written.
    const { run, calls } = recorder([json([{ url: "https://github.com/acme/api/pull/7", state: "MERGED" }])]);

    const result = await openPullRequest(input({ run }));

    expect(result).toMatchObject({ ok: true, adopted: true, url: "https://github.com/acme/api/pull/7" });
    expect(calls).toHaveLength(1);
  });

  it("creates rather than adopting a merged one when asked to adopt only an open one (EO-445)", async () => {
    const { run, calls } = recorder([
      json([{ url: "https://github.com/acme/api/pull/7", state: "MERGED" }]),
      created("https://github.com/acme/api/pull/8"),
      json([{ url: "https://github.com/acme/api/pull/8", state: "OPEN" }]),
    ]);

    const result = await openPullRequest(input({ run, onlyAdoptOpen: true }));

    expect(result).toMatchObject({ ok: true, adopted: false, url: "https://github.com/acme/api/pull/8" });
    expect(calls.filter((call) => call.args.includes("create"))).toHaveLength(1);
  });
});

describe("refusing, once, with a reason", () => {
  it("when the branch is gone", async () => {
    git(["branch", "-D", "eo/API-4"], repoPath);

    const result = await openPullRequest(input());

    expect(result).toMatchObject({ ok: false, final: true });
    expect(result.error).toContain("no longer exists");
  });

  it("when the branch has nothing on it", async () => {
    git(["branch", "-D", "eo/API-4"], repoPath);
    git(["branch", "eo/API-4", "main"], repoPath);

    const result = await openPullRequest(input());

    expect(result.final).toBe(true);
    expect(result.error).toContain("no commits");
  });

  it("says git could not read the base ref, rather than calling the branch empty", async () => {
    // The two used to be the same sentence. `commitsAhead` folded a
    // failed `rev-list` into a count of zero, so a base ref that does not
    // resolve — a `main` this checkout has never had, a fetch that has
    // not happened — was reported as "your branch has no commits the base
    // does not already have" and marked final, so it never tried again.
    const result = await openPullRequest(input({ baseRef: "origin/no-such-base" }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not count");
    expect(result.error).not.toContain("no commits that");
    // Retryable: an unresolvable ref is usually a fetch that has not
    // happened yet, and the next attempt fixes it.
    expect(result.final).toBe(false);
  });

  it("when there is no such remote", async () => {
    const result = await openPullRequest(input({ remote: "upstream" }));

    expect(result).toMatchObject({ ok: false, final: true });
    expect(result.error).toContain("No remote named `upstream`");
    expect(result.error).toContain("committed locally");
  });

  it("when the host is not one it recognises and nobody said which", async () => {
    git(["remote", "set-url", "origin", "https://git.acme-internal.com/acme/api.git"], repoPath);

    const result = await openPullRequest(input({ forgeKind: null }));

    expect(result.final).toBe(true);
    expect(result.error).toContain("git.acme-internal.com");
    expect(result.error).toContain("Settings");
  });

  it("when the CLI is not installed", async () => {
    const run: CliRunner = async () => ({ ok: false, stdout: "", error: "spawn glab ENOENT", notFound: true });

    const result = await openPullRequest(input({ run, forgeKind: "gitlab" }));

    expect(result.final).toBe(true);
    expect(result.error).toContain("`glab` is not on PATH");
  });

  it("but keeps trying when the forge is merely having a bad day", async () => {
    const { run } = recorder([{ ok: false, stdout: "", error: "HTTP 502: Bad Gateway", notFound: false }]);

    const result = await openPullRequest(input({ run }));

    expect(result).toMatchObject({ ok: false, final: false });
  });
});

describe("the body", () => {
  it("uses the repository's template when the reviewer filled nothing in", async () => {
    mkdirSync(join(repoPath, ".github"), { recursive: true });
    writeFileSync(join(repoPath, ".github/pull_request_template.md"), "## Why is this change needed?\n");
    git(["add", "-A"], repoPath);
    git(["commit", "-m", "add a template"], repoPath);

    let written = "";
    const run: CliRunner = async (_cli, args) => {
      const index = args.indexOf("--body-file");
      if (index >= 0) written = readFileSync(args[index + 1]!, "utf8");
      return args.includes("list") ? empty : { ok: true, stdout: "", error: "", notFound: false };
    };

    const result = await openPullRequest(input({ run, agentBody: null }));

    expect(written).toContain("## Why is this change needed?");
    expect(result.fallbackBody).toBe(true);
  });

  it("reads the template from the base branch, not from whatever is checked out", async () => {
    // The checkout is wherever the user left it; the template belongs to
    // the branch the pull request targets.
    mkdirSync(join(repoPath, ".github"), { recursive: true });
    writeFileSync(join(repoPath, ".github/pull_request_template.md"), "## From main\n");
    git(["add", "-A"], repoPath);
    git(["commit", "-m", "template on main"], repoPath);
    git(["checkout", "eo/API-4"], repoPath);

    let written = "";
    const run: CliRunner = async (_cli, args) => {
      const index = args.indexOf("--body-file");
      if (index >= 0) written = readFileSync(args[index + 1]!, "utf8");
      return args.includes("list") ? empty : { ok: true, stdout: "", error: "", notFound: false };
    };

    await openPullRequest(input({ run, agentBody: null }));

    expect(written).toContain("## From main");
  });

  it("says when a template directory offered several and it picked none", async () => {
    mkdirSync(join(repoPath, ".github/PULL_REQUEST_TEMPLATE"), { recursive: true });
    writeFileSync(join(repoPath, ".github/PULL_REQUEST_TEMPLATE/bug.md"), "bug");
    writeFileSync(join(repoPath, ".github/PULL_REQUEST_TEMPLATE/security.md"), "security");
    git(["add", "-A"], repoPath);
    git(["commit", "-m", "templates"], repoPath);

    const { run } = recorder([empty, created("https://github.com/acme/api/pull/7"), json([{ url: "https://github.com/acme/api/pull/7" }])]);
    const result = await openPullRequest(input({ run, agentBody: null }));

    expect(result.ambiguousTemplates).toHaveLength(2);
  });
});

describe("asking for reviewers (EO-741)", () => {
  const ghUrl = "https://github.com/acme/api/pull/7";
  const glUrl = "https://gitlab.com/acme/api/-/merge_requests/3";
  const refused = (error: string): CliResult => ({ ok: false, stdout: "", error, notFound: false });

  it("asks gh for them after creating the pull request, in one command of its own", async () => {
    const { run, calls } = recorder([empty, created(ghUrl), json([{ url: ghUrl, state: "OPEN", author: { login: "eo-bot" } }])]);

    const result = await openPullRequest(input({ run, reviewers: ["alice", "bob"] }));

    expect(result).toMatchObject({ ok: true, url: ghUrl, reviewers: { requested: ["alice", "bob"], refused: [], author: null } });
    expect(calls.map((call) => call.args)).toEqual([
      ["pr", "list", "--head", "eo/API-4", "--state", "all", "--json", "url,state", "--limit", "1"],
      calls[1]!.args,
      // The read-back asks who opened it, since that is the one reviewer gh refuses.
      ["pr", "list", "--head", "eo/API-4", "--state", "all", "--json", "url,state,author", "--limit", "1"],
      ["pr", "edit", ghUrl, "--add-reviewer", "alice,bob"],
    ]);
    expect(calls[1]!.args.slice(0, 2)).toEqual(["pr", "create"]);
  });

  it("asks glab for them by the merge request's iid, adding rather than replacing", async () => {
    const { run, calls } = recorder([empty, created(glUrl), json([{ web_url: glUrl, iid: 3, state: "opened", author: { username: "eo-bot" } }])]);

    const result = await openPullRequest(input({ run, forgeKind: "gitlab", reviewers: ["alice", "bob"] }));

    expect(result.reviewers).toEqual({ requested: ["alice", "bob"], refused: [], author: null });
    expect(calls[2]).toEqual({ cli: "glab", args: ["mr", "list", "--source-branch", "eo/API-4", "--all", "--output", "json"] });
    expect(calls[3]).toEqual({ cli: "glab", args: ["mr", "update", "3", "--reviewer", "+alice,+bob"] });
    expect(calls).toHaveLength(4);
  });

  it("still opens when the forge refuses one, and says which and what the forge said", async () => {
    const { run, calls } = recorder([
      empty,
      created(ghUrl),
      json([{ url: ghUrl, state: "OPEN", author: { login: "eo-bot" } }]),
      refused("GraphQL: Could not resolve to a User with the login of 'nobody'."),
      { ok: true, stdout: ghUrl, error: "", notFound: false },
      refused("GraphQL: Could not resolve to a User with the login of 'nobody'."),
    ]);

    const result = await openPullRequest(input({ run, reviewers: ["alice", "nobody"] }));

    expect(result).toMatchObject({ ok: true, url: ghUrl });
    expect(result.reviewers).toEqual({
      requested: ["alice"],
      refused: [{ reviewer: "nobody", reason: "GraphQL: Could not resolve to a User with the login of 'nobody'." }],
      author: null,
    });
    expect(calls.slice(3).map((call) => call.args)).toEqual([
      ["pr", "edit", ghUrl, "--add-reviewer", "alice,nobody"],
      ["pr", "edit", ghUrl, "--add-reviewer", "alice"],
      ["pr", "edit", ghUrl, "--add-reviewer", "nobody"],
    ]);
  });

  it("leaves the pull request's author out, whatever the case of their login", async () => {
    const { run, calls } = recorder([empty, created(ghUrl), json([{ url: ghUrl, state: "OPEN", author: { login: "Alice" } }])]);

    const result = await openPullRequest(input({ run, reviewers: ["alice", "bob"] }));

    expect(result.reviewers).toEqual({ requested: ["bob"], refused: [], author: "alice" });
    expect(calls.at(-1)!.args).toEqual(["pr", "edit", ghUrl, "--add-reviewer", "bob"]);
  });

  it("asks nobody when the author is the only reviewer", async () => {
    const { run, calls } = recorder([empty, created(ghUrl), json([{ url: ghUrl, state: "OPEN", author: { login: "alice" } }])]);

    const result = await openPullRequest(input({ run, reviewers: ["alice"] }));

    expect(result.reviewers).toEqual({ requested: [], refused: [], author: "alice" });
    expect(calls).toHaveLength(3);
  });

  it("asks nobody on a pull request it found already open", async () => {
    const { run, calls } = recorder([json([{ url: ghUrl, state: "OPEN" }])]);

    const result = await openPullRequest(input({ run, reviewers: ["alice", "bob"] }));

    expect(result).toMatchObject({ ok: true, adopted: true, reviewers: null });
    expect(calls).toHaveLength(1);
  });

  it("runs exactly the commands it always did when there is nobody to ask", async () => {
    for (const reviewers of [undefined, []]) {
      const { run, calls } = recorder([empty, created(ghUrl), json([{ url: ghUrl, state: "OPEN" }])]);

      const result = await openPullRequest(input({ run, ...(reviewers ? { reviewers } : {}) }));

      expect(result.reviewers).toBeNull();
      expect(calls.map((call) => call.args[0] + " " + call.args[1])).toEqual(["pr list", "pr create", "pr list"]);
      expect(calls[2]!.args).toEqual(calls[0]!.args);
    }
  });
});
