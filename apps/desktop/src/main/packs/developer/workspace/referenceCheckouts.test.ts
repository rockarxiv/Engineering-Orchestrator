import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPOSITORY_CHECKOUT_TOOL_NAME, type AgentEvent, type AgentProvider, type Item } from "@eo/core";
import type { DbHandle } from "../../../db/client.js";
import { addWorkspaceToProject, getItem, listCommentsForItem, type GitWorkspace } from "../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../../../db/testHelpers.js";
// @ts-expect-error — the service is plain JavaScript, deliberately: it ships
// unbundled because Codex spawns it by path.
import * as eoServer from "../../../mcp/eoServer.mjs";
import { eoMcpStdioConfig } from "../../../mcp/serviceConfig.js";
import { createScriptedProvider } from "../../../providers/scripted.js";
import { toolResultEvent } from "../../../providers/toolResult.js";
import { startTestWriteBridge } from "../../../testing/agentWrites.js";
import { validImplementResult } from "../../../providers/fixtures.js";
import { createRunSupervisor } from "../../../supervisor/runSupervisor.js";
import { fakeWorkspaceKind, installedKinds } from "../../../supervisor/testWorkspaceKinds.js";
import type { ReferenceCheckout, WorkspaceKind } from "../../../supervisor/workspaceKind.js";
import { run, makeRepo } from "../../../testing/git.js";
import { BUILTIN_RUNNERS } from "../builtins.js";
import { createRoleWiring } from "../wiring.js";
import { borrowedFromSiblings } from "./borrowed.js";
import { setBranchPrefix } from "./branchPrefix.js";
import { gitWorkspaceKind } from "./gitKind.js";
import { listReferenceCheckouts } from "./referenceCheckouts.js";

/**
 * Reference checkouts (EO-632), against real repositories.
 *
 * Two repositories on one project, `api` and `web`. `web` is a clone of
 * a repository standing in for its remote, so "the remote's
 * `release/2.4`" and "web's own `release/2.4`" can point at different
 * commits — which is the case the whole fetch-first rule is about.
 */
let scratch: string;
let worktreeRoot: string;
let handle: DbHandle;
let kind: WorkspaceKind;
let api: GitWorkspace;
let web: GitWorkspace;
/** What `web`'s `origin` points at. */
let upstream: string;
/** A ticket in `api`. */
let item: Item;

/** A commit on `branch` in `repo`, which must have it checked out or be told to. */
async function commitOn(repo: string, branch: string, file: string): Promise<string> {
  await run(["checkout", "-q", branch], repo);
  writeFileSync(join(repo, file), `${file}\n`);
  await run(["add", "-A"], repo);
  await run(["commit", "-q", "-m", file], repo);
  const head = await run(["rev-parse", "HEAD"], repo);
  await run(["checkout", "-q", "main"], repo);
  return head;
}

async function localBranches(repo: string): Promise<string> {
  return run(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], repo);
}

async function checkout(repository: string, branch: string): Promise<ReferenceCheckout> {
  const outcome = await kind.referenceCheckout!(item, { repository, branch });
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.checkout;
}

function notes(of: Item = item): string[] {
  return listCommentsForItem(handle.db, of.id).map((comment) => comment.body);
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo reference checkouts "));
  worktreeRoot = join(scratch, "work trees");
  handle = openMigratedTestDb();
  setBranchPrefix(handle.db, "eo");

  upstream = await makeRepo(scratch, "web upstream");
  await run(["branch", "release/2.4"], upstream);
  await commitOn(upstream, "release/2.4", "release.txt");
  await run(["clone", "-q", upstream, join(scratch, "the web")], scratch);
  for (const [key, value] of [["user.email", "eo@example.com"], ["user.name", "EO Test"], ["commit.gpgsign", "false"]] as const) {
    await run(["config", key, value], join(scratch, "the web"));
  }

  api = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: await makeRepo(scratch, "the api"), baseBranch: "main" });
  web = attachWorkspace(handle.db, { name: "web", keyPrefix: "WEB", repoPath: join(scratch, "the web"), baseBranch: "main" });
  item = createTestItem(handle.db, { type: "story", title: "Needs web's release", stepId: "todo", workspaceId: api.id, projectId: api.projectId });
  addWorkspaceToProject(handle.db, api.projectId!, web.id);

  kind = gitWorkspaceKind({ db: handle.db, worktreeRoot, intelligenceFor: () => null });
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("making a reference checkout", () => {
  it("detaches at the remote branch's commit, and creates or moves no branch in the repository", async () => {
    const before = await localBranches(web.config.repoPath);
    const remoteTip = await run(["rev-parse", "release/2.4"], upstream);

    const made = await checkout("web", "release/2.4");

    expect(made).toMatchObject({ commit: remoteTip, source: "remote", repository: "web", branch: "release/2.4" });
    expect(await run(["rev-parse", "HEAD"], made.path)).toBe(remoteTip);
    // Detached: HEAD names no branch.
    await expect(run(["symbolic-ref", "-q", "HEAD"], made.path)).rejects.toThrow();
    expect(existsSync(join(made.path, "release.txt"))).toBe(true);
    expect(await localBranches(web.config.repoPath)).toBe(before);
    // And the person's checkout is untouched by it.
    expect(await run(["status", "--porcelain"], web.config.repoPath)).toBe("");
  });

  it("is not in the folder that holds tickets' worktrees", async () => {
    const made = await checkout("web", "release/2.4");
    expect(made.path.startsWith(worktreeRoot)).toBe(false);
    expect(made.path).toContain("eo-references");
  });

  it("succeeds on a branch the repository's own checkout has out", async () => {
    const made = await checkout("web", "main");
    expect(await run(["rev-parse", "HEAD"], made.path)).toBe(await run(["rev-parse", "main"], upstream));
    expect(await run(["branch", "--show-current"], web.config.repoPath)).toBe("main");
  });

  it("succeeds on the branch another ticket's worktree has out", async () => {
    const theirs = join(worktreeRoot, "WEB-1");
    await run(["worktree", "add", "-q", "-b", "eo/WEB-1", theirs], web.config.repoPath);
    writeFileSync(join(theirs, "theirs.txt"), "theirs\n");
    await run(["add", "-A"], theirs);
    await run(["commit", "-q", "-m", "theirs"], theirs);

    const made = await checkout("web", "eo/WEB-1");

    // Never pushed, so it is the local branch's.
    expect(made.source).toBe("local");
    expect(made.commit).toBe(await run(["rev-parse", "HEAD"], theirs));
    expect(await run(["branch", "--show-current"], theirs)).toBe("eo/WEB-1");
  });

  it("uses the remote's commit when a local branch of the same name points elsewhere", async () => {
    // web's own `release/2.4`, left behind at main while the remote moved on.
    await run(["branch", "release/2.4", "main"], web.config.repoPath);
    const local = await run(["rev-parse", "release/2.4"], web.config.repoPath);
    const remote = await run(["rev-parse", "release/2.4"], upstream);
    expect(local).not.toBe(remote);

    const made = await checkout("web", "release/2.4");

    expect(made).toMatchObject({ commit: remote, source: "remote" });
    expect(await run(["rev-parse", "release/2.4"], web.config.repoPath)).toBe(local);
  });

  it("uses the local branch when the remote does not have one", async () => {
    await run(["branch", "spike"], web.config.repoPath);
    const tip = await commitOn(web.config.repoPath, "spike", "spike.txt");

    const made = await checkout("web", "spike");

    expect(made).toMatchObject({ commit: tip, source: "local" });
  });

  it("refuses a branch that is on neither, naming the repository and the branch, and creates nothing", async () => {
    const outcome = await kind.referenceCheckout!(item, { repository: "web", branch: "nowhere" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("web");
    expect(outcome.reason).toContain("`nowhere`");
    expect(await listReferenceCheckouts(web.config.repoPath)).toEqual([]);
  });

  it("refuses with git's error when the fetch fails, rather than reading an old copy of the remote branch", async () => {
    // The clone left `origin/release/2.4` behind, which is exactly the
    // stale copy this must not fall back on.
    await run(["remote", "set-url", "origin", join(scratch, "gone")], web.config.repoPath);

    const outcome = await kind.referenceCheckout!(item, { repository: "web", branch: "release/2.4" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("Could not fetch `release/2.4` from web's remote `origin`");
    expect(outcome.reason).toMatch(/does not appear to be a git repository|not found|No such file/i);
    expect(await listReferenceCheckouts(web.config.repoPath)).toEqual([]);
  });

  it("refuses a repository that is not on the ticket's project, listing those that are", async () => {
    const elsewhere = attachWorkspace(handle.db, { name: "mobile", keyPrefix: "MOB", repoPath: await makeRepo(scratch, "the mobile app") });

    const outcome = await kind.referenceCheckout!(item, { repository: elsewhere.config.name, branch: "main" });

    expect(outcome).toEqual({ ok: false, reason: `\`mobile\` is not a repository on ${item.key}'s project. Its repositories are: api, web.` });
  });

  it("allows the ticket's own repository, for another branch", async () => {
    await run(["branch", "feature-x"], api.config.repoPath);
    const made = await checkout("api", "feature-x");
    expect(made).toMatchObject({ repository: "api", source: "local", commit: await run(["rev-parse", "feature-x"], api.config.repoPath) });
  });

  it("refuses a name git would not accept as a branch, before it reaches a path", async () => {
    const outcome = await kind.referenceCheckout!(item, { repository: "web", branch: "../../escape" });
    expect(outcome.ok).toBe(false);
  });

  it("returns the same path when asked again, at the branch's newest commit", async () => {
    const first = await checkout("web", "release/2.4");
    const newer = await commitOn(upstream, "release/2.4", "later.txt");

    const second = await checkout("web", "release/2.4");

    expect(second.path).toBe(first.path);
    expect(second.commit).toBe(newer);
    expect(await run(["rev-parse", "HEAD"], second.path)).toBe(newer);
    expect(notes()).toEqual([]);
  });
});

describe("removing reference checkouts", () => {
  it("removes an unchanged one when the ticket settles, and posts nothing — with no worktree of its own", async () => {
    const made = await checkout("web", "release/2.4");
    expect(existsSync(worktreeRoot)).toBe(false);

    await kind.releaseReferenceCheckouts!(item);

    expect(existsSync(made.path)).toBe(false);
    expect(await listReferenceCheckouts(web.config.repoPath)).toEqual([]);
    expect(await run(["worktree", "list", "--porcelain"], web.config.repoPath)).not.toContain("eo-references");
    expect(notes()).toEqual([]);
  });

  it("says what changed — a tracked file, an untracked file, a moved HEAD — and removes it anyway", async () => {
    const made = await checkout("web", "release/2.4");
    writeFileSync(join(made.path, "README.md"), "edited\n");
    writeFileSync(join(made.path, "scribble.txt"), "new\n");
    await run(["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "moved"], made.path);

    await kind.releaseReferenceCheckouts!(item);

    expect(existsSync(made.path)).toBe(false);
    const [note, ...rest] = notes();
    expect(rest).toEqual([]);
    expect(note).toContain("web's `release/2.4`");
    expect(note).toContain("1 tracked file changed: `README.md`");
    expect(note).toContain("1 untracked file added: `scribble.txt`");
    expect(note).toContain(`HEAD moved from ${made.commit.slice(0, 12)}`);
  });

  it.each([
    ["a changed tracked file", (path: string) => writeFileSync(join(path, "README.md"), "edited\n"), "tracked file changed"],
    ["an untracked file", (path: string) => writeFileSync(join(path, "new.txt"), "new\n"), "untracked file added"],
  ])("reports %s on its own", async (_what, write, phrase) => {
    const made = await checkout("web", "release/2.4");
    write(made.path);

    await kind.releaseReferenceCheckouts!(item);

    expect(existsSync(made.path)).toBe(false);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toContain(phrase);
    expect(notes()[0]).not.toContain("HEAD moved");
  });

  it("reports what was written before refreshing one, rather than overwriting it silently", async () => {
    const first = await checkout("web", "release/2.4");
    writeFileSync(join(first.path, "scribble.txt"), "new\n");

    const second = await checkout("web", "release/2.4");

    expect(existsSync(join(second.path, "scribble.txt"))).toBe(false);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toContain("`scribble.txt`");
  });

  it("reports what was written before refreshing one even when making the new one fails, and leaves nothing half-made", async () => {
    const first = await checkout("web", "release/2.4");
    writeFileSync(join(first.path, "scribble.txt"), "new\n");
    // A post-checkout hook that fails makes `git worktree add` fail after
    // the old checkout has already gone.
    const hooks = join(scratch, "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "post-checkout"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await run(["config", "core.hooksPath", hooks], web.config.repoPath);

    const outcome = await kind.referenceCheckout!(item, { repository: "web", branch: "release/2.4" });

    expect(outcome.ok).toBe(false);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toContain("`scribble.txt`");
    expect(existsSync(first.path)).toBe(false);
    expect(await listReferenceCheckouts(web.config.repoPath)).toEqual([]);
  });

  it("removes those of finished and deleted tickets at the startup sweep, and keeps those of tickets still moving", async () => {
    const moving = await checkout("web", "release/2.4");
    const finished = createTestItem(handle.db, { type: "story", title: "Done", stepId: "ready_to_merge", workspaceId: api.id, projectId: api.projectId });
    const finishedCheckout = await kind.referenceCheckout!(finished, { repository: "web", branch: "main" });
    // A ticket deleted while EO was not running: only its folder is left.
    const ghost = { ...item, id: finished.id, key: "API-999" };
    const ghostCheckout = await kind.referenceCheckout!(ghost, { repository: "web", branch: "main" });
    if (!finishedCheckout.ok || !ghostCheckout.ok) throw new Error("fixture");
    writeFileSync(join(finishedCheckout.checkout.path, "scribble.txt"), "new\n");

    await kind.release({ what: "stale", hasActiveRun: () => false });

    expect(existsSync(moving.path)).toBe(true);
    expect(existsSync(finishedCheckout.checkout.path)).toBe(false);
    expect(existsSync(ghostCheckout.checkout.path)).toBe(false);
    expect(notes(finished)).toHaveLength(1);
    expect(notes(finished)[0]).toContain("`scribble.txt`");
  });

  it("never shows one to borrowedFromSiblings as another ticket's worktree", async () => {
    // This ticket's worktree adds a file byte-identical to one already on
    // the branch the reference checkout holds, committed earlier there.
    const made = await checkout("web", "release/2.4");
    const mine = join(worktreeRoot, item.key);
    await run(["worktree", "add", "-q", "-b", `eo/${item.key}`, mine], api.config.repoPath);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // so the copy is committed strictly later
    writeFileSync(join(mine, "release.txt"), "release.txt\n");
    await run(["add", "-A"], mine);
    await run(["commit", "-q", "-m", "copied"], mine);
    expect(existsSync(join(made.path, "release.txt"))).toBe(true);

    const borrowed = await borrowedFromSiblings({ worktreePath: mine, itemKey: item.key, baseBranch: "main", worktreeRoot });

    expect(borrowed).toEqual([]);
    expect(readdirSync(worktreeRoot)).toEqual([item.key]);
  });
});

describe("on the supervisor", () => {
  /** An implementer and a reviewer that both succeed, so the ticket reaches its last step. */
  function finishingProvider() {
    return createScriptedProvider([
      { when: (context) => context.includes(`"review" action`), script: { result: { verdict: "approve", feedback: "LGTM", blocking_issues: [] } } },
      { when: () => true, script: { result: validImplementResult } },
    ]);
  }

  it("removes a ticket's reference checkouts when it reaches its last step, through every installed kind", async () => {
    // The ticket's own workspace is a stand-in that cuts no worktree,
    // and the git kind is installed under another slug, only as the
    // kind that lent the checkout. Settling must still reach it.
    const released: string[] = [];
    const ownKind = fakeWorkspaceKind({ cwd: scratch });
    const lender: WorkspaceKind = { ...kind, slug: "lender", releaseReferenceCheckouts: async (settled) => {
      released.push(settled.key);
      await kind.releaseReferenceCheckouts!(settled);
    } };
    const ticket = createTestItem(handle.db, { type: "story", title: "Settles", stepId: "todo", workspaceId: api.id, projectId: api.projectId, spec: REVIEWABLE_SPEC });
    const ticketCheckout = await kind.referenceCheckout!(ticket, { repository: "web", branch: "main" });
    if (!ticketCheckout.ok) throw new Error(ticketCheckout.reason);

    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: finishingProvider(),
      kinds: installedKinds(ownKind, lender),
      builtins: BUILTIN_RUNNERS,
      ...createRoleWiring(handle.db),
      limits: { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 5 },
    });
    for (let tick = 0; tick < 12 && getItem(handle.db, ticket.id)?.stepId !== "ready_to_merge"; tick++) await supervisor.runOnce();

    expect(getItem(handle.db, ticket.id)?.stepId).toBe("ready_to_merge");
    expect(released).toContain(ticket.key);
    expect(existsSync(ticketCheckout.checkout.path)).toBe(false);
  });
});

/**
 * `repository_checkout` (EO-633): an agent asking for one mid-run. The
 * call goes through the real `eo` service, started with the environment
 * `eoMcpStdioConfig` builds for the turn, over the agent write bridge to
 * the supervisor, which asks the kind — so what the agent is told is what
 * this whole path says, and a refusal is the kind's own sentence.
 */
describe("an agent's repository_checkout", () => {
  interface EoService {
    tools: { name: string }[];
    handle(request: unknown): Promise<{ result: { isError?: boolean; content: { type: string; text?: string }[] } }>;
    close(): void;
  }
  const service = eoServer as { createEoMcpService(options: { dbPath: undefined; writeBridge: unknown }): EoService };

  interface Call {
    args: { repository: string; branch: string };
    /** Runs before the call is made, mid-turn. */
    before?: () => Promise<void>;
  }

  /** An agent that calls the tool once per entry, through the real service, and records what it was told. */
  function checkingAgent(calls: Call[]) {
    const seen: { listed: boolean; answers: { isError: boolean; text: string }[] } = { listed: false, answers: [] };
    const provider: AgentProvider = {
      async *start(opts): AsyncIterable<AgentEvent> {
        const env = eoMcpStdioConfig({ serverPath: "/app/eoServer.mjs", ...(opts.writeBridge ? { writeBridge: opts.writeBridge } : {}) }).env;
        const eo = service.createEoMcpService({ dbPath: undefined, writeBridge: env["EO_MCP_WRITE_BRIDGE"] === undefined ? null : JSON.parse(env["EO_MCP_WRITE_BRIDGE"]) });
        try {
          seen.listed = eo.tools.some((tool) => tool.name === REPOSITORY_CHECKOUT_TOOL_NAME);
          yield { type: "thread_started", threadId: "thread-1" };
          for (const [index, call] of calls.entries()) {
            await call.before?.();
            const callId = `call-${String(index)}`;
            yield { type: "tool_call", name: REPOSITORY_CHECKOUT_TOOL_NAME, args: call.args, callId };
            const { result } = await eo.handle({ jsonrpc: "2.0", id: index, method: "tools/call", params: { name: REPOSITORY_CHECKOUT_TOOL_NAME, arguments: call.args } });
            const text = result.content[0]?.text ?? "";
            seen.answers.push({ isError: result.isError === true, text });
            yield toolResultEvent({ name: REPOSITORY_CHECKOUT_TOOL_NAME, callId, ok: result.isError !== true, output: text });
          }
          yield { type: "result", data: validImplementResult };
        } finally {
          eo.close();
        }
      },
      // eslint-disable-next-line require-yield
      async *resume(): AsyncIterable<AgentEvent> {
        throw new Error("these runs are not resumed");
      },
    };
    return { provider, seen };
  }

  /** One turn of `provider` on `ticket`, with the ticket's own kind `own` and, optionally, a kind that lends checkouts beside it. */
  async function oneTurn(ticket: Item, provider: AgentProvider, own: WorkspaceKind, lender?: WorkspaceKind): Promise<void> {
    const writes = await startTestWriteBridge();
    try {
      const supervisor = createRunSupervisor({
        db: handle.db,
        provider,
        kinds: lender ? installedKinds(own, lender) : installedKinds(own),
        builtins: BUILTIN_RUNNERS,
        ...createRoleWiring(handle.db),
        agentWriteBridge: writes.agentWriteBridge,
        limits: { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 5 },
      });
      writes.serve(supervisor);
      await supervisor.runOnce();
    } finally {
      await writes.close();
    }
  }

  /** The ticket's own kind, cutting no worktree, and lending checkouts the way the git kind does in the app. */
  const lendingOwnKind = (): WorkspaceKind => ({ ...fakeWorkspaceKind({ cwd: scratch }), referenceCheckout: (of, request) => kind.referenceCheckout!(of, request) });

  it("answers with the path, the commit and where it came from, and the checkout is at that path", async () => {
    const ticket = item;
    const { provider, seen } = checkingAgent([{ args: { repository: "web", branch: "release/2.4" } }]);
    // The ticket's own kind lends the checkout here, as the git kind does in the app.
    await oneTurn(ticket, provider, lendingOwnKind());

    const tip = await run(["rev-parse", "release/2.4"], upstream);
    const [made] = await listReferenceCheckouts(web.config.repoPath, ticket.key);
    expect(seen.listed).toBe(true);
    expect(seen.answers).toHaveLength(1);
    expect(seen.answers[0]!.isError).toBe(false);
    expect(made).toBeDefined();
    expect(seen.answers[0]!.text).toContain(made!.path);
    expect(seen.answers[0]!.text).toContain(tip);
    expect(seen.answers[0]!.text).toContain("remote");
    expect(await run(["rev-parse", "HEAD"], made!.path)).toBe(tip);
    expect(existsSync(join(made!.path, "release.txt"))).toBe(true);
  });

  it("says a local branch's commit is the local branch's", async () => {
    await run(["branch", "spike"], web.config.repoPath);
    const tip = await commitOn(web.config.repoPath, "spike", "spike.txt");
    const ticket = item;
    const { provider, seen } = checkingAgent([{ args: { repository: "web", branch: "spike" } }]);
    await oneTurn(ticket, provider, lendingOwnKind());

    expect(seen.answers[0]).toMatchObject({ isError: false });
    expect(seen.answers[0]!.text).toContain(tip);
    expect(seen.answers[0]!.text).toContain("local branch");
  });

  it("is lent one by an installed kind when the ticket's own kind has none to lend", async () => {
    const ticket = item;
    const { provider, seen } = checkingAgent([{ args: { repository: "api", branch: "main" } }]);
    await oneTurn(ticket, provider, fakeWorkspaceKind({ cwd: scratch }), { ...kind, slug: "lender" });

    const [made] = await listReferenceCheckouts(api.config.repoPath, ticket.key);
    expect(seen.answers[0]).toMatchObject({ isError: false });
    expect(made).toBeDefined();
    expect(seen.answers[0]!.text).toContain(made!.path);
  });

  it("hands each refusal to the agent as the tool's error, in the kind's own sentence, and checks nothing out", async () => {
    const elsewhere = attachWorkspace(handle.db, { name: "mobile", keyPrefix: "MOB", repoPath: await makeRepo(scratch, "the mobile app") });
    const ticket = item;
    const asked = [
      { repository: elsewhere.config.name, branch: "main" },
      { repository: "web", branch: "nowhere" },
      { repository: "web", branch: "release/2.4" },
    ];
    const refusal = async (request: { repository: string; branch: string }): Promise<string> => {
      const outcome = await kind.referenceCheckout!(ticket, request);
      if (outcome.ok) throw new Error(`${request.repository} ${request.branch} was checked out`);
      return outcome.reason;
    };
    // A refusal makes nothing, so asking first changes nothing the agent will see.
    const beforeTheTurn = [await refusal(asked[0]!), await refusal(asked[1]!)];
    const { provider, seen } = checkingAgent([
      { args: asked[0]! },
      { args: asked[1]! },
      // The fetch fails: the remote is gone by the time the agent asks.
      { args: asked[2]!, before: async () => void (await run(["remote", "set-url", "origin", join(scratch, "gone")], web.config.repoPath)) },
    ]);
    await oneTurn(ticket, provider, lendingOwnKind());

    // The same sentences, asked of the kind directly — after the turn, so
    // the remote is as gone for the third as it was when the agent asked.
    const reasons = [beforeTheTurn[0]!, beforeTheTurn[1]!, await refusal(asked[2]!)];
    expect(reasons[0]).toContain("is not a repository on");
    expect(reasons[1]).toContain("has no branch `nowhere`");
    expect(reasons[2]).toContain("Could not fetch `release/2.4`");
    expect(seen.answers).toEqual(reasons.map((reason) => ({ isError: true, text: `REPOSITORY_CHECKOUT_REFUSED: ${reason}` })));
    expect(await listReferenceCheckouts(web.config.repoPath)).toEqual([]);
  });
});
