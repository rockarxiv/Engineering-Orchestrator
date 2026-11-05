import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLDER_KIND, GIT_WORKTREE_KIND, SCRATCH_KIND, type Agent, type AgentProvider, type Item, UNSCOPED_RUN } from "@eo/core";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentAttachmentsHash } from "../../../agentAttachments/fingerprint.js";
import type { DbHandle } from "../../../db/client.js";
import { createRun, createWorkspace, getItem, listAgents, listCommentsForItem, listRunsForItem, postComment, updateAgent, updateRun, type Workspace } from "../../../db/repos/index.js";
import { needsAttention } from "../../../db/repos/commentsRepo.js";
import { createDefaultProject } from "../../../db/repos/projectsRepo.js";
import { attachWorkspace, createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../../../db/testHelpers.js";
import { createClaudeProvider } from "../../../providers/claude.js";
import { createCodexProvider } from "../../../providers/codex.js";
import { CodexClient } from "../../../providers/codexClient.js";
import { validImplementResult } from "../../../providers/fixtures.js";
import { openAssistConversation } from "../../../roles/assist.js";
import { promptHash } from "../../../roles/prompts.js";
import { createRunSupervisor, type RunSupervisorOptions } from "../../../supervisor/runSupervisor.js";
import { installedKinds } from "../../../supervisor/testWorkspaceKinds.js";
import { fakeAppServer, note } from "../../../testing/fakeCodexAppServer.js";
import { createRoleWiring } from "../wiring.js";
import { gitWorkspaceKind, isInsideGitRepository } from "./gitKind.js";

/**
 * Whether a turn must be inside a Git repository is the workspace's
 * question, asked once for both backends (EO-386, invariant 12).
 *
 * It was Codex's alone. `codex exec` refused to run outside a
 * repository, EO's app-server client re-made the refusal, and the only
 * switch was the agent's role — so a Codex implementer on a scratch
 * directory failed before its turn started where a Claude one ran, and a
 * Claude implementer handed the wrong directory for a checkout simply
 * worked there.
 *
 * Every case below runs against **the real adapters**: the Codex
 * provider and client over a stubbed app-server, and the Claude provider
 * over a stubbed `query`. What is asserted is whether the backend was
 * reached at all, which is the only honest reading of "refused before
 * anything is spawned" — a recording provider would show that the
 * supervisor declined to call *it*, and nothing about the two adapters
 * this story is about.
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const EXECUTABLE = "/opt/eo/runtimes/codex/bin/codex";
const PRIOR_THREAD = "thr-parked";

type BackendName = "codex" | "claude";
const BACKENDS: BackendName[] = ["codex", "claude"];

interface Backend {
  provider: AgentProvider;
  /** How many times the backend itself was reached: app-server launches on Codex, `query` calls on Claude. */
  started: () => number;
}

let handle: DbHandle;
let directories: string[];

beforeEach(() => {
  handle = openMigratedTestDb();
  directories = [];
});

afterEach(() => {
  handle.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

/** A directory of this test's own under the system's temporary one, which is inside no repository. */
function directory(prefix: string): string {
  const made = mkdtempSync(join(tmpdir(), prefix));
  directories.push(made);
  return made;
}

/** The same, with the `.git` entry that makes it a repository as far as the check reads one. */
function repository(): string {
  const made = directory("eo-386-repo-");
  mkdirSync(join(made, ".git"));
  return made;
}

/** A backend that answers `answer` in one turn, and counts how often it was reached. */
function backend(name: BackendName, answer: unknown): Backend {
  if (name === "codex") {
    const fake = fakeAppServer({
      model: "gpt-6.1-sol",
      after: { "turn/start": [note.turnStarted(), note.agentMessage(JSON.stringify(answer)), note.tokenUsage({ input: 10, output: 10 }), note.turnCompleted()] },
    });
    return {
      provider: createCodexProvider({ executablePath: EXECUTABLE, createCodex: () => new CodexClient({ executablePath: EXECUTABLE, spawn: fake.spawn, shutdownGraceMs: 200 }) }),
      started: () => fake.launches.length,
    };
  }
  let calls = 0;
  const messages = [
    { type: "system", subtype: "init", session_id: "sess_1" },
    { type: "result", subtype: "success", result: JSON.stringify(answer), structured_output: answer, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 10 }, session_id: "sess_1" },
  ] as unknown as SDKMessage[];
  const runQuery = (() => {
    calls += 1;
    return (async function* () {
      for (const message of messages) yield message;
    })();
  }) as never;
  return { provider: createClaudeProvider({ runQuery, enableCommentTool: false }), started: () => calls };
}

/** The agent of a role, moved onto the backend under test — the row, so that everything read off it agrees. */
function agentOn(role: string, name: BackendName): Agent {
  const agent = listAgents(handle.db).find((candidate) => candidate.role === role)!;
  return updateAgent(handle.db, agent.id, { provider: name });
}

function supervisorOver(over: Backend, overrides: Partial<RunSupervisorOptions> = {}) {
  return createRunSupervisor({
    db: handle.db,
    provider: over.provider,
    limits: LIMITS,
    // Never the person's `~/.eo`.
    noDiskRoot: directory("eo-386-none-"),
    scratchRoot: directory("eo-386-scratch-"),
    ...overrides,
  });
}

/** What EO said on the item, in its own voice. */
const said = (item: Item): string[] =>
  listCommentsForItem(handle.db, item.id)
    .filter((comment) => comment.authorType === "engine")
    .map((comment) => comment.body);

function workspaceOf(kind: typeof SCRATCH_KIND | typeof FOLDER_KIND, config: Record<string, unknown> = {}): Workspace {
  const workspace = createWorkspace(handle.db, { kind, ...(kind === FOLDER_KIND ? { config } : {}) } as Parameters<typeof createWorkspace>[1]);
  createDefaultProject(handle.db, workspace, "EO");
  return workspace;
}

function story(workspace?: Workspace): Item {
  return createTestItem(handle.db, {
    type: "story",
    title: "Draft the quarterly report",
    stepId: "todo",
    spec: REVIEWABLE_SPEC,
    ...(workspace ? { workspaceId: workspace.id, projectId: workspace.projectId } : {}),
  });
}

/**
 * The git kind as the app installs it, handed a directory that is not a
 * checkout.
 *
 * `prepare` is the one member replaced, because the real one cannot be
 * made to produce this: it cuts a worktree or refuses. What reaches the
 * supervisor here is what a broken assignment looks like from above —
 * a `git-worktree` workspace and a directory with no repository around
 * it — and everything that judges it is the real kind's.
 */
function gitKindPreparing(cwd: string) {
  const git = gitWorkspaceKind({ db: handle.db, worktreeRoot: directory("eo-386-worktrees-"), intelligenceFor: () => null });
  return installedKinds({
    ...git,
    prepare: async (item) => ({ ok: true, workspace: { cwd, kind: GIT_WORKTREE_KIND, workspaceId: item.workspaceId } }),
  });
}

function gitStory(): Item {
  const workspace = attachWorkspace(handle.db, { keyPrefix: "EO", name: "eo", repoPath: repository() });
  return createTestItem(handle.db, { type: "story", title: "Rate limiting", stepId: "todo", spec: REVIEWABLE_SPEC, workspaceId: workspace.id, projectId: workspace.projectId });
}

/** A run of this agent's on this item that stopped to ask, the way a real dispatch leaves one, with a reply waiting. */
function parkedIn(item: Item, agent: Agent, cwd: string) {
  const run = createRun(handle.db, {
    itemId: item.id,
    agentId: agent.id,
    action: "implement",
    status: "queued",
    threadId: PRIOR_THREAD,
    provider: agent.provider,
    instructionsHash: promptHash(agent.instructions),
    agentAttachmentsHash: agentAttachmentsHash(handle.db, agent.id, UNSCOPED_RUN),
    cwd,
  });
  updateRun(handle.db, run.id, { status: "awaiting_input", startedAt: 1_000, endedAt: 1_000 });
  postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Yes, go ahead." });
  return run;
}

it("the system's temporary directory is inside no repository, which every case below relies on", () => {
  expect(isInsideGitRepository(directory("eo-386-probe-"))).toBe(false);
  expect(isInsideGitRepository(join(repository(), "packages", "core"))).toBe(true);
});

describe.each(BACKENDS)("an implementer on %s, on a workspace that is not a repository", (name) => {
  const WORKSPACES: { kind: string; item: () => Item }[] = [
    { kind: "scratch", item: () => story(workspaceOf(SCRATCH_KIND)) },
    { kind: "none", item: () => story() },
    { kind: "folder outside any repository", item: () => story(workspaceOf(FOLDER_KIND, { path: directory("eo-386-drive-") })) },
  ];

  it.each(WORKSPACES)("starts its turn on a $kind workspace", async ({ item: make }) => {
    const item = make();
    expect(agentOn("implementer", name).role).not.toBe("system");
    const over = backend(name, validImplementResult);

    await supervisorOver(over).runOnce();

    expect(over.started()).toBe(1);
    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.provider).toBe(name);
    expect(run?.error ?? "").not.toContain("Git repository");
    expect(run?.status).toBe("succeeded");
    expect(said(item).join("\n")).not.toContain("Git repository");
  });

  it("carries on a parked run there when a person replies", async () => {
    const item = story(workspaceOf(SCRATCH_KIND));
    const agent = agentOn("implementer", name);
    parkedIn(item, agent, directory("eo-386-scratch-run-"));
    const over = backend(name, validImplementResult);

    const supervisor = supervisorOver(over);
    await supervisor.resumeItem(item.id);
    await supervisor.waitForIdle();

    expect(over.started()).toBe(1);
    expect(said(item).join("\n")).not.toContain("Git repository");
  });
});

describe.each(BACKENDS)("a turn on a git-worktree workspace, on %s", (name) => {
  it("is refused before the backend is reached when its directory is inside no repository, and says so on the item", async () => {
    const item = gitStory();
    agentOn("implementer", name);
    const outside = directory("eo-386-not-a-checkout-");
    const over = backend(name, validImplementResult);

    await supervisorOver(over, { kinds: gitKindPreparing(outside) }).runOnce();

    expect(over.started()).toBe(0);
    // The run ended, parked on a person — not failed by an error out of
    // an adapter, which is what the Codex half used to be.
    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("awaiting_input");
    expect(run?.endedAt).not.toBeNull();
    expect(run?.error).toContain(outside);
    const escalations = listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "escalation");
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.body).toContain(outside);
    expect(escalations[0]!.body).toContain("Git repository");
    expect(needsAttention(handle.db, item.id)).toBe(true);
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("is refused on a resume as well, where the directory is the one the run recorded", async () => {
    const item = gitStory();
    const agent = agentOn("implementer", name);
    const outside = directory("eo-386-removed-worktree-");
    parkedIn(item, agent, outside);
    const over = backend(name, validImplementResult);

    const supervisor = supervisorOver(over, { kinds: gitKindPreparing(outside) });
    await supervisor.resumeItem(item.id);
    await supervisor.waitForIdle();

    expect(over.started()).toBe(0);
    const resumed = listRunsForItem(handle.db, item.id).find((run) => run.error?.includes(outside));
    expect(resumed?.status).toBe("awaiting_input");
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "escalation" && comment.body.includes(outside))).toHaveLength(1);
  });

  it("starts when the directory is a checkout", async () => {
    const item = gitStory();
    agentOn("implementer", name);
    const over = backend(name, validImplementResult);

    await supervisorOver(over, { kinds: gitKindPreparing(repository()) }).runOnce();

    expect(over.started()).toBe(1);
    expect(said(item).join("\n")).not.toContain("is not inside one");
  });
});

describe.each(BACKENDS)("the system agent on %s, outside any repository", (name) => {
  const ROOMS: { turn: string; open: () => Item }[] = [
    { turn: "an assistant turn", open: () => openAssistConversation(handle.db, null) },
  ];

  it.each(ROOMS)("starts $turn", async ({ open }) => {
    const conversation = open();
    const systemAgent = agentOn("system", name);
    postComment(handle.db, { itemId: conversation.id, author: { type: "human" }, body: "How is this set up?", mentions: [{ type: "agent", agentId: systemAgent.id }] });
    const over = backend(name, { message: "Noted." });

    await supervisorOver(over, createRoleWiring(handle.db)).runOnce();

    expect(over.started()).toBeGreaterThanOrEqual(1);
    const [run] = listRunsForItem(handle.db, conversation.id);
    expect(run?.provider).toBe(name);
    expect(run?.error ?? "").not.toContain("Git repository");
    expect(said(conversation).join("\n")).not.toContain("Git repository");
  });
});
