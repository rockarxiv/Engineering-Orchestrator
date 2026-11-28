import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Agent, AgentProvider, AgentSandbox, Item, SandboxAvailability } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../../db/client.js";
import { listAgents, listCommentsForItem, listRunsForItem, updateAgent, updateItem, updateWorkspace } from "../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../../../db/testHelpers.js";
import { createClaudeProvider } from "../../../providers/claude.js";
import { codexClientOptions, createCodexProvider } from "../../../providers/codex.js";
import { CodexClient } from "../../../providers/codexClient.js";
import { validImplementResult } from "../../../providers/fixtures.js";
import { createRunSupervisor } from "../../../supervisor/runSupervisor.js";
import { fakeWorkspaceKind, installedKinds, preparedIn } from "../../../supervisor/testWorkspaceKinds.js";
import { fakeAppServer, note, type FakeAppServer } from "../../../testing/fakeCodexAppServer.js";
import { makeRepo, run } from "../../../testing/git.js";
import { developerSectionRenderers } from "../sections.js";
import { createRoleWiring } from "../wiring.js";
import { gitWorkspaceKind } from "./gitKind.js";

/**
 * A sandboxed implementer dispatched for real (EO-934): the supervisor,
 * the git kind's own `attach` on a real linked worktree, and the real
 * Claude and Codex adapters over stubs of their backends.
 *
 * What it shows is the dispatch's half, which no adapter test can: that
 * the sandbox is computed from the item's checkout and the repository's
 * settings — never from the agent — that it reaches each backend in the
 * form EO-933 measured, that the prompt says the turn is sandboxed, and
 * that an agent whose setting is off is launched exactly as before.
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const EXECUTABLE = "/opt/eo/runtimes/codex/bin/codex";

type BackendName = "claude" | "codex";

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

function directory(prefix: string): string {
  // Native, as EO resolves paths: on Windows the temporary directory is
  // reached through an 8.3 short name (`RUNNER~1`) only it expands.
  const made = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  directories.push(made);
  return made;
}

interface Backend {
  provider: AgentProvider;
  /** What Claude's SDK was handed, per turn. */
  claudeOptions: Record<string, unknown>[];
  /** Codex's app-server, as launched and as asked. */
  codex: FakeAppServer | null;
}

function backend(name: BackendName): Backend {
  if (name === "codex") {
    const fake = fakeAppServer({ model: "gpt-6.1-sol", after: { "turn/start": [note.turnStarted(), note.agentMessage(JSON.stringify(validImplementResult)), note.tokenUsage({ input: 10, output: 10 }), note.turnCompleted()] } });
    const options = { executablePath: EXECUTABLE, searchHookCommandPath: "/opt/eo/hook.mjs", searchHookTrust: async () => ({ key: "/<session-flags>/config.toml:pre_tool_use:0:0", hash: "sha256:abc" }) };
    const provider = createCodexProvider({
      ...options,
      createCodex: (...args) => new CodexClient({ ...codexClientOptions(options, ...args), spawn: fake.spawn, shutdownGraceMs: 200 }),
    });
    return { provider, claudeOptions: [], codex: fake };
  }
  const claudeOptions: Record<string, unknown>[] = [];
  const runQuery = ((params: { options?: Record<string, unknown> }) => {
    claudeOptions.push(params.options ?? {});
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess_1" } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        result: JSON.stringify(validImplementResult),
        structured_output: validImplementResult,
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 10 },
        session_id: "sess_1",
      } as unknown as SDKMessage;
    })();
  }) as never;
  return { provider: createClaudeProvider({ runQuery, enableCommentTool: false }), claudeOptions, codex: null };
}

/** Every turn's sandbox and prompt, as the supervisor handed them to the adapter. */
function recording(provider: AgentProvider, turns: { sandbox: AgentSandbox | undefined; context: string }[]): AgentProvider {
  return {
    ...provider,
    start: (opts) => {
      turns.push({ sandbox: opts.sandbox, context: opts.context });
      return provider.start(opts);
    },
    resume: (threadId, message, opts) => {
      turns.push({ sandbox: opts?.sandbox, context: message });
      return provider.resume(threadId, message, opts);
    },
  };
}

/** A story on a real repository, and the item's linked worktree cut from it. */
async function gitStory(): Promise<{ item: Item; worktree: string; common: string; store: string }> {
  const root = directory("eo-934-");
  const repo = await makeRepo(root, "repo");
  const worktree = join(root, "worktrees", "EO-1");
  await run(["worktree", "add", "-b", "eo/EO-1", worktree], repo);
  const workspace = attachWorkspace(handle.db, { keyPrefix: "EO", name: "eo", repoPath: repo });
  // A real directory, judged where it really is: a made-up `/home/me/…`
  // is `/System/Volumes/Data/home/me/…` on macOS and `C:\\home\\me\\…` on Windows.
  const store = join(root, "pnpm-store");
  mkdirSync(store);
  updateWorkspace(handle.db, workspace.id, { config: { extraWritablePaths: [store] } });
  const item = createTestItem(handle.db, { type: "story", title: "Rate limiting", stepId: "todo", spec: REVIEWABLE_SPEC, workspaceId: workspace.id, projectId: workspace.projectId });
  return { item, worktree, common: join(repo, ".git"), store };
}

async function dispatchImplementer(name: BackendName, sandboxed: boolean, sandboxAvailability?: (agent: Agent) => Promise<SandboxAvailability | null>) {
  const implementer = listAgents(handle.db).find((candidate) => candidate.role === "implementer")!;
  updateAgent(handle.db, implementer.id, { provider: name, config: sandboxed ? { ...implementer.config, sandboxed: true } : implementer.config });
  const story = await gitStory();
  const over = backend(name);
  const turns: { sandbox: AgentSandbox | undefined; context: string }[] = [];
  const git = gitWorkspaceKind({ db: handle.db, intelligenceFor: () => null });
  const supervisor = createRunSupervisor({
    db: handle.db,
    provider: recording(over.provider, turns),
    ...createRoleWiring(handle.db),
    // The pack's own sections, as the composition root hands them over.
    sectionRenderers: developerSectionRenderers,
    limits: LIMITS,
    ...(sandboxAvailability ? { sandboxAvailability } : {}),
    kinds: installedKinds(
      fakeWorkspaceKind({
        prepare: async (prepared) => {
          updateItem(handle.db, prepared.id, { git: { branch: "eo/EO-1" } });
          return preparedIn(prepared, story.worktree);
        },
        attach: git.attach,
      }),
    ),
  });
  await supervisor.runOnce();
  return { ...story, over, turns };
}

describe.each(["claude", "codex"] as const)("a sandboxed implementer on %s (EO-934)", (name) => {
  it("is launched in a sandbox EO worked out from the item's checkout and the repository's settings, and told so", async () => {
    const { item, worktree, common, store, over, turns } = await dispatchImplementer(name, true);

    expect(listRunsForItem(handle.db, item.id).map((run) => run.action)).toEqual(["implement"]);
    const sandbox = turns[0]?.sandbox;
    expect(sandbox?.writable).toEqual([
      worktree,
      join(common, "worktrees", "EO-1"),
      join(common, "objects"),
      join(common, "refs"),
      join(common, "logs"),
      store,
    ]);
    for (const closed of [common, join(common, "hooks"), join(common, "config")]) expect(sandbox?.writable).not.toContain(closed);
    expect(sandbox?.hidden).toEqual(expect.arrayContaining([expect.stringMatching(/gh[\\/]hosts\.yml$/), expect.stringMatching(/\.ssh$/), expect.stringMatching(/\.git-credentials$/)]));
    expect(sandbox?.withheld).toEqual(expect.arrayContaining(["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS"]));
    // The prompt says so, from the dispatch.
    expect(turns[0]?.context).toContain("## Sandbox");
    expect(turns[0]?.context).toContain("You run sandboxed on this turn");

    if (name === "claude") {
      expect(over.claudeOptions[0]).toMatchObject({ permissionMode: "bypassPermissions", sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true, filesystem: { allowWrite: sandbox?.writable, denyRead: sandbox?.hidden } } });
    } else {
      expect(over.codex?.paramsOf("thread/start")).not.toHaveProperty("sandbox");
      expect(over.codex?.paramsOf("thread/start")).toMatchObject({ approvalPolicy: "never" });
      expect(over.codex?.launches[0]?.args).toEqual(expect.arrayContaining(['default_permissions="eo"', 'permissions.eo.extends=":workspace"']));
    }
  });

  it("is launched exactly as before when its setting is off", async () => {
    const { over, turns } = await dispatchImplementer(name, false);

    expect(turns[0]?.sandbox).toBeUndefined();
    expect(turns[0]?.context).not.toContain("## Sandbox");
    if (name === "claude") {
      expect(over.claudeOptions[0]).not.toHaveProperty("sandbox");
      expect(over.claudeOptions[0]).toMatchObject({ permissionMode: "bypassPermissions" });
    } else {
      expect(over.codex?.paramsOf("thread/start")).toMatchObject({ sandbox: "danger-full-access", approvalPolicy: "never" });
      expect((over.codex?.launches[0]?.args ?? []).some((arg) => arg.startsWith("default_permissions"))).toBe(false);
    }
  });
});

/**
 * A sandboxed implementer on a machine that cannot start its sandbox
 * (EO-935): refused before the backend is called, with a comment on the
 * item saying why, and never launched unsandboxed.
 */
describe.each(["claude", "codex"] as const)("a sandboxed implementer on %s whose sandbox cannot start (EO-935)", (name) => {
  const MISSING: SandboxAvailability = {
    available: false,
    reason: "Claude's sandbox on Linux needs bubblewrap and socat, and bubblewrap (bwrap) is not installed on this machine.",
    fix: "Install bubblewrap (bwrap) (for example `sudo apt install bubblewrap`), then check again.",
  };

  it("runs when the machine can start it, having asked about the agent being dispatched", async () => {
    const asked: string[] = [];
    const { item, turns } = await dispatchImplementer(name, true, async (agent) => {
      asked.push(agent.provider);
      return { available: true, how: "bubblewrap and socat" };
    });

    expect(asked).toEqual([name]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.sandbox).toBeDefined();
    expect(listRunsForItem(handle.db, item.id).map((run) => run.status)).not.toContain("awaiting_input");
  });

  it("is refused before launch when the sandbox stopped being able to start after it was turned on, and the item is told why", async () => {
    // Available when the setting was ticked; gone by the time the run is.
    let installed = true;
    const check = async (): Promise<SandboxAvailability> => (installed ? { available: true, how: "bubblewrap and socat" } : MISSING);
    expect(await check()).toMatchObject({ available: true });
    installed = false;

    const { item, over, turns } = await dispatchImplementer(name, true, check);

    // Nothing reached the backend: no turn, no SDK query, no app-server.
    expect(turns).toEqual([]);
    expect(over.claudeOptions).toEqual([]);
    expect(over.codex?.launches ?? []).toEqual([]);
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs.map((run) => run.status)).toEqual(["awaiting_input"]);
    const told = listCommentsForItem(handle.db, item.id).map((comment) => comment.body).join("\n");
    expect(told).toContain(`"${name}" sandbox cannot start on this machine, so EO did not start the run`);
    expect(told).toContain("it never runs a sandboxed agent unsandboxed");
    expect(told).toContain(MISSING.reason);
    expect(told).toContain(MISSING.fix);
  });

  it("asks nothing of an agent whose setting is off, and launches it as before", async () => {
    const asked: string[] = [];
    const { turns } = await dispatchImplementer(name, false, async (agent) => {
      asked.push(agent.provider);
      return MISSING;
    });

    expect(asked).toEqual([]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.sandbox).toBeUndefined();
  });
});
