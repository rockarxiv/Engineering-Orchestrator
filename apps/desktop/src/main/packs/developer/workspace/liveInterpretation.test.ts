import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INTERPRET_ACTION, parsedResultOf, type Agent, type Item } from "@eo/core";
import type { DbHandle } from "../../../db/client.js";
import {
  addDependency,
  getItem,
  listAgents,
  listCommentsForItem,
  listRunsForItem,
  postComment,
  updateAgent,
  updateItem,
  type GitWorkspace,
} from "../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDbAt } from "../../../db/testHelpers.js";
import { providerForAgent } from "../../../engine.js";
import { syncRolePrompts } from "../../../roles/prompts.js";
import { createRoleWiring } from "../wiring.js";
import { BUILTIN_RUNNERS } from "../builtins.js";
import { createRunSupervisor } from "../../../supervisor/runSupervisor.js";
import { setBranchPrefix } from "./branchPrefix.js";
import { createWorktreeWorkspace } from "./dispatchWorkspace.js";
import { worktreePathFor } from "./worktrees.js";
import { run } from "../../../testing/git.js";
import { fakeWorkspaceKind, installedKinds } from "../../../supervisor/testWorkspaceKinds.js";

/**
 * The same two flows, against a real model (EO-184).
 *
 * `interpretedWorktree.test.ts` proves the machinery with the model
 * scripted, which is what belongs in a suite that has to run everywhere
 * and cost nothing. This is the other half of EO-184's last acceptance
 * criterion: the loop exercised end to end with a backend that is
 * actually thinking, on the installation's own managed runtime and the
 * shipped `system-agent.md` prompt.
 *
 * **Opt-in, and it stays that way.** Skipped unless `EO_LIVE_MODEL=1`,
 * because it spends somebody's quota, needs a signed-in backend, and
 * fails for reasons that are not EO's code — a rate limit, an offline
 * machine, a model that reads a sentence differently this morning. A
 * suite that a network can fail is a suite people stop believing.
 *
 *     EO_LIVE_MODEL=1 pnpm vitest run src/main/packs/developer/workspace/liveInterpretation.test.ts
 *
 * Point `EO_RUNTIME_ROOT` at the runtimes directory of an EO install
 * that has downloaded the Claude backend *and* the Claude Agent SDK;
 * without it this looks in the default userData location for the
 * platform.
 *
 * **What a failure here means.** Everything about the plumbing —
 * dispatch, lock, comment placement, routing, the branch actually cut —
 * is asserted by the scripted test beside this one. What only this can
 * tell you is whether a real model, given EO's real prompt and the real
 * task appendix, answers in the shape the step can use, and whether the
 * provider accepts the JSON Schema `outputSchemaFor("interpret")`
 * generates. That last one is the reason this was worth writing: a
 * schema the API refuses is an HTTP 400 on every dispatch with every
 * unit test still green, which this codebase has been bitten by once
 * already (see `outputSchemaFor`).
 */

const live = process.env["EO_LIVE_MODEL"] === "1";

/** Where an EO install keeps its downloaded backends. */
function runtimeRoot(): string {
  const configured = process.env["EO_RUNTIME_ROOT"];
  if (configured) return configured;
  const userData =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "EO")
      : process.platform === "win32"
        ? join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "EO")
        : join(homedir(), ".config", "EO");
  return join(userData, "runtimes");
}

const here = dirname(fileURLToPath(import.meta.url));
const eoMcpServerPath = join(here, "..", "mcp", "eoServer.mjs");
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let scratch: string;
let dbPath: string;
let worktreeRoot: string;
let handle: DbHandle;
let repository: GitWorkspace;

async function commitOn(branch: string, file: string): Promise<string> {
  await run(["checkout", "-B", branch], repository.config.repoPath);
  writeFileSync(join(repository.config.repoPath, file), `${file}\n`);
  await run(["add", "-A"], repository.config.repoPath);
  await run(["commit", "-m", `feat: ${file}`], repository.config.repoPath);
  const head = await run(["rev-parse", "HEAD"], repository.config.repoPath);
  await run(["checkout", "main"], repository.config.repoPath);
  return head;
}

/**
 * The system agent, on a real backend.
 *
 * The seeded row is a placeholder on the `fake` provider, which is what
 * a fresh install ships: `syncRolePrompts` gives it the prompt this
 * build ships — the one thing this test exists to exercise — and the
 * backend is named here rather than assumed.
 */
function realSystemAgent(extraTools: string[] = []): Agent {
  syncRolePrompts(handle.db);
  const seeded = listAgents(handle.db).find((agent) => agent.role === "system" && agent.enabled);
  if (!seeded) throw new Error("no system agent in the seeded install");
  const allowed = (seeded.config as { allowedTools?: string[] }).allowedTools ?? [];
  return updateAgent(handle.db, seeded.id, {
    provider: "claude",
    config: { ...seeded.config, allowedTools: [...allowed, ...extraTools] },
  });
}

function supervisor() {
  return createRunSupervisor({
    db: handle.db,
    // The real thing: the installation's managed backend, its downloaded
    // SDK, and the agent's own tool surface.
    provider: (agent: Agent) => providerForAgent(agent, eoMcpServerPath, dbPath, runtimeRoot(), handle.db),
    ...createRoleWiring(handle.db),
    limits: LIMITS,
    builtins: { create_worktree: BUILTIN_RUNNERS.create_worktree! },
    kinds: installedKinds(fakeWorkspaceKind({ prepare: createWorktreeWorkspace(handle.db, worktreeRoot) })),
  });
}

function reply(item: Item, body: string): void {
  const asked = listCommentsForItem(handle.db, item.id).at(-1);
  postComment(handle.db, { itemId: item.id, author: { type: "human" }, parentId: asked?.id ?? null, body });
}

function interpretation(item: Item) {
  return listRunsForItem(handle.db, item.id).find((entry) => entry.action === INTERPRET_ACTION);
}

/** Everything the run left behind, for a failure that has to be read rather than guessed at. */
function transcript(item: Item): string {
  const runs = listRunsForItem(handle.db, item.id).map((entry) => `${entry.action} ${entry.status} ${entry.error ?? ""}`);
  const comments = listCommentsForItem(handle.db, item.id).map((entry) => `[${entry.authorType} ${entry.kind}] ${entry.body}`);
  return [...runs, ...comments].join("\n");
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo live interpretation "));
  worktreeRoot = join(scratch, "work trees");
  dbPath = join(scratch, "eo.db");
  handle = openMigratedTestDbAt(dbPath);
  setBranchPrefix(handle.db, "eo");

  const repoPath = join(scratch, "the repo");
  mkdirSync(repoPath, { recursive: true });
  await run(["init", "-b", "main"], repoPath);
  await run(["config", "user.email", "eo@example.com"], repoPath);
  await run(["config", "user.name", "EO Test"], repoPath);
  await run(["config", "commit.gpgsign", "false"], repoPath);
  await run(["config", "tag.gpgsign", "false"], repoPath);
  writeFileSync(join(repoPath, "README.md"), "# the repo\n");
  await run(["add", "-A"], repoPath);
  await run(["commit", "-m", "initial"], repoPath);

  repository = attachWorkspace(handle.db, { name: "the repo", keyPrefix: "EO", repoPath, baseBranch: "main" });
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(!live)("a real model reading a real reply", () => {
  it("answers a tied stack target from a sentence, and the branch is cut from what it named", async () => {
    realSystemAgent();

    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: repository.id });
    const common = { type: "story" as const, workspaceId: repository.id, parentId: feature.id };
    const limiter = createTestItem(handle.db, {
      ...common,
      title: "Add the token bucket limiter",
      body: "Implements the rate limiter itself in src/limiter.ts.",
      stepId: "ready_to_merge",
    });
    const store = createTestItem(handle.db, {
      ...common,
      title: "Add the Redis counter store",
      body: "Implements the shared counter store in src/store.ts.",
      stepId: "ready_to_merge",
    });
    const dependent = createTestItem(handle.db, {
      ...common,
      title: "Wire the limiter to the store",
      body: "Uses the counter store from the limiter.",
      stepId: "worktree",
    });

    await commitOn(`eo/${limiter.key}`, "limiter.ts");
    const storeTip = await commitOn(`eo/${store.key}`, "store.ts");
    updateItem(handle.db, limiter.id, { git: { branch: `eo/${limiter.key}` } });
    updateItem(handle.db, store.id, { git: { branch: `eo/${store.key}` } });
    addDependency(handle.db, dependent.id, limiter.id);
    addDependency(handle.db, dependent.id, store.id);

    const engine = supervisor();

    // 1. The step stops and offers both keys.
    await engine.runOnce();
    const asked = listCommentsForItem(handle.db, dependent.id).at(-1);
    expect(asked?.options, transcript(dependent)).toEqual([limiter.key, store.key]);

    // 2. A sentence naming neither key — the person describes the story
    //    instead, which is what people actually do.
    reply(dependent, "start it from the counter store one, that's the piece this builds on");

    // 3. A real dispatch, a real prompt, a real answer.
    await engine.runOnce();
    const read = interpretation(dependent);
    expect(read?.status, transcript(dependent)).toBe("succeeded");
    // The schema survived constrained generation — the thing no offline
    // test can tell you.
    expect(parsedResultOf(read?.result ?? null)).toMatchObject({ status: "answered", answer: store.key });

    const decision = listCommentsForItem(handle.db, dependent.id).find((comment) => comment.kind === "decision");
    expect(decision?.body).toBe(store.key);
    expect(decision?.parentId).toBe(listCommentsForItem(handle.db, dependent.id).find((comment) => comment.authorType === "human")?.id);

    // 4. And the branch is cut from the story it named.
    await engine.runOnce();
    const worktree = worktreePathFor(dependent.key, worktreeRoot);
    expect(existsSync(worktree), transcript(dependent)).toBe(true);
    expect(await run(["rev-parse", "HEAD"], worktree)).toBe(storeTip);
    expect(getItem(handle.db, dependent.id)?.stepId).toBe("repository_index");
  }, 240_000);

  it("does what an instruction asked for and says to retry", async () => {
    // Bash, which the seeded allowlist does not carry: `acted` is
    // defined by the agent having *done* something, and an installation
    // that wants that has to grant the tools for it (EO-182's decision
    // about the system agent's surface is exactly this — the person's
    // authority, delegated). Scoped to a scratch repository under the
    // test's own temp directory.
    realSystemAgent(["Bash"]);

    const item = createTestItem(handle.db, {
      type: "story",
      title: "Rate limit the API",
      body: "Add a token bucket limiter.",
      stepId: "worktree",
      workspaceId: repository.id,
    });
    const branch = `eo/${item.key}`;
    const stray = join(scratch, "somebody elses checkout");
    await run(["worktree", "add", "-b", branch, stray], repository.config.repoPath);

    const engine = supervisor();

    // 1. Refused: the branch is checked out somewhere EO does not expect.
    await engine.runOnce();
    expect(listCommentsForItem(handle.db, item.id).at(-1)?.body, transcript(item)).toContain("already checked out");

    // 2. An instruction rather than an answer.
    reply(item, `that checkout at ${stray} is mine and I am done with it — remove it and try again`);

    // 3. The model acts, and says to retry.
    await engine.runOnce();
    const read = interpretation(item);
    expect(read?.status, transcript(item)).toBe("succeeded");
    expect(parsedResultOf(read?.result ?? null)).toMatchObject({ status: "acted", retry: true });
    // It said it would clear the checkout, so the checkout is gone.
    expect(existsSync(stray), transcript(item)).toBe(false);

    // 4. `retry: true` hands the item back, and this time it works.
    await engine.runOnce();
    expect(existsSync(worktreePathFor(item.key, worktreeRoot)), transcript(item)).toBe(true);
  }, 240_000);
});
