import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CALL_REFUSED_EVENT, type AgentProvider, type CallFence, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../../db/client.js";
import { listAgents, listRunEvents, listRunsForItem, updateAgent, updateItem } from "../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../../../db/testHelpers.js";
import { createClaudeProvider } from "../../../providers/claude.js";
import { codexClientOptions, createCodexProvider } from "../../../providers/codex.js";
import { CodexClient } from "../../../providers/codexClient.js";
import { validImplementResult } from "../../../providers/fixtures.js";
import { createRunSupervisor } from "../../../supervisor/runSupervisor.js";
import { fakeWorkspaceKind, installedKinds, preparedIn } from "../../../supervisor/testWorkspaceKinds.js";
import { fakeAppServer, note } from "../../../testing/fakeCodexAppServer.js";
import { createRoleWiring } from "../wiring.js";
import { gitWorkspaceKind } from "./gitKind.js";

/**
 * The fence around an implementer's and a reviewer's turns (EO-926),
 * dispatched for real: the supervisor, the git kind's own `attach`, and
 * the real Claude and Codex adapters over stubs of their backends.
 *
 * What it shows is the dispatch's half of the fence, which no adapter
 * test can: that the branch and the worktree come from the item and the
 * workspace — never from the agent — that the implementer may push its
 * own branch and the reviewer nothing, and that a call the hook refused
 * lands on the run as a `call_refused` event, where the item's runs show it.
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const EXECUTABLE = "/opt/eo/runtimes/codex/bin/codex";
const BRANCH = "eo/EO-1";
const FORCED_PUSH = `git push --force origin ${BRANCH}`;
const REVIEW_APPROVAL = { verdict: "approve", feedback: "Reads well." };

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
  const made = mkdtempSync(join(tmpdir(), prefix));
  directories.push(made);
  return made;
}

/**
 * A backend whose every turn tries a forced push before answering, the
 * answers given in turn: Claude's CLI asks EO's hook in EO's process,
 * Codex's runs the hook command, which the stub plays by posting to the
 * listener EO opened.
 */
function backend(name: BackendName, answers: unknown[]): { provider: AgentProvider; hookAnswers: () => { status: number; body: string }[] } {
  if (name === "codex") {
    const answersFile = join(directory("eo-926-hook-"), "answers.jsonl");
    const turn = (answer: unknown) => [
      note.turnStarted(),
      { fireHook: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: FORCED_PUSH }, tool_use_id: "call-push" } },
      note.agentMessage(JSON.stringify(answer)),
      note.tokenUsage({ input: 10, output: 10 }),
      note.turnCompleted(),
    ];
    const fakes = answers.map((answer) => fakeAppServer({ model: "gpt-6.1-sol", hookAnswers: answersFile, after: { "turn/start": turn(answer) } }));
    const options = { executablePath: EXECUTABLE, searchHookCommandPath: "/opt/eo/hook.mjs", searchHookTrust: async () => ({ key: "/<session-flags>/config.toml:pre_tool_use:0:0", hash: "sha256:abc" }) };
    let launched = 0;
    const provider = createCodexProvider({
      ...options,
      createCodex: (repository, searchHook, attachFrom, memoryScopes, environmentVariables, writeBridge, withheld, adminDirectory, skillSlugs, itemId) =>
        new CodexClient({
          ...codexClientOptions(options, repository, searchHook, attachFrom, memoryScopes, environmentVariables, writeBridge, withheld, adminDirectory, skillSlugs, itemId),
          spawn: fakes[Math.min(launched++, fakes.length - 1)]!.spawn,
          shutdownGraceMs: 200,
        }),
    });
    const hookAnswers = () => (existsSync(answersFile) ? readFileSync(answersFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { status: number; body: string }) : []);
    return { provider, hookAnswers };
  }
  const said: { status: number; body: string }[] = [];
  let turns = 0;
  const runQuery = ((params: { options?: Record<string, unknown> }) => {
    const answer = answers[Math.min(turns++, answers.length - 1)];
    const entry = ((params.options?.["hooks"] as { PreToolUse?: { matcher?: string; hooks: ((input: unknown) => Promise<unknown>)[] }[] } | undefined)?.PreToolUse ?? []).find((candidate) => candidate.matcher === undefined);
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess_1" } as unknown as SDKMessage;
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "call-push", name: "Bash", input: { command: FORCED_PUSH } }] }, session_id: "sess_1" } as unknown as SDKMessage;
      const decided = await entry?.hooks[0]?.({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: FORCED_PUSH }, tool_use_id: "call-push", session_id: "sess_1", transcript_path: "/tmp/t.jsonl", cwd: "/tmp/wt" });
      said.push(decided === undefined ? { status: 204, body: "" } : { status: 200, body: JSON.stringify(decided) });
      yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-push", is_error: true, content: "refused" }] }, parent_tool_use_id: null, session_id: "sess_1" } as unknown as SDKMessage;
      yield { type: "result", subtype: "success", result: JSON.stringify(answer), structured_output: answer, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 10 }, session_id: "sess_1" } as unknown as SDKMessage;
    })();
  }) as never;
  return { provider: createClaudeProvider({ runQuery, enableCommentTool: false }), hookAnswers: () => said };
}

/** Every turn's fence, as the supervisor handed it to the adapter. */
function recordingFences(provider: AgentProvider, fences: (CallFence | undefined)[]): AgentProvider {
  return {
    ...provider,
    start: (opts) => {
      fences.push(opts.fence);
      return provider.start(opts);
    },
    resume: (threadId, message, opts) => {
      fences.push(opts?.fence);
      return provider.resume(threadId, message, opts);
    },
  };
}

function gitStory(): Item {
  const workspace = attachWorkspace(handle.db, { keyPrefix: "EO", name: "eo", repoPath: directory("eo-926-repo-") });
  return createTestItem(handle.db, { type: "story", title: "Rate limiting", stepId: "todo", spec: REVIEWABLE_SPEC, workspaceId: workspace.id, projectId: workspace.projectId });
}

describe.each(["claude", "codex"] as const)("the work fence on %s (EO-926)", (name) => {
  it("fences the implementer to its own branch and worktree and the reviewer to no push, and records each refused call on its run", async () => {
    for (const role of ["implementer", "reviewer"]) {
      const agent = listAgents(handle.db).find((candidate) => candidate.role === role)!;
      updateAgent(handle.db, agent.id, { provider: name });
    }
    const item = gitStory();
    const worktree = directory("eo-926-worktree-");
    const over = backend(name, [validImplementResult, REVIEW_APPROVAL]);
    const fences: (CallFence | undefined)[] = [];
    const git = gitWorkspaceKind({ db: handle.db, intelligenceFor: () => null });
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: recordingFences(over.provider, fences),
      ...createRoleWiring(handle.db),
      limits: LIMITS,
      kinds: installedKinds(
        fakeWorkspaceKind({
          // The branch is recorded on the item by `prepare`, as the real
          // one does on a first dispatch — so the fence can only have it
          // from the item row, read after preparation.
          prepare: async (prepared) => {
            updateItem(handle.db, prepared.id, { git: { branch: BRANCH } });
            return preparedIn(prepared, worktree);
          },
          attach: git.attach,
        }),
      ),
    });

    await supervisor.runOnce();
    await supervisor.runOnce();

    const runs = listRunsForItem(handle.db, item.id);
    expect(runs.map((run) => run.action)).toEqual(["implement", "review"]);
    expect(fences.length).toBeGreaterThanOrEqual(2);
    expect(fences[0]).toEqual({ root: worktree, pushBranch: BRANCH });
    expect(fences.at(-1)).toEqual({ root: worktree, pushBranch: null });

    // Both turns' forced pushes were denied by the hook…
    const decisions = over.hookAnswers().map((answer) => (answer.status === 200 ? (JSON.parse(answer.body) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision : null));
    expect(decisions.slice(0, 2)).toEqual(["deny", "deny"]);
    // …and each is on its own run's log, naming the rule and the call.
    const refusals = runs.map((run) => listRunEvents(handle.db, run.id).filter((event) => event.type === CALL_REFUSED_EVENT).map((event) => event.payload));
    expect(refusals[0]).toEqual([expect.objectContaining({ tool: "Bash", rule: "push_forced", call: FORCED_PUSH, callId: "call-push" })]);
    expect(refusals[1]).toEqual([expect.objectContaining({ tool: "Bash", rule: "push_on_review", call: FORCED_PUSH })]);
  });
});

describe("which turns are fenced", () => {
  it("lends no fence to a role other than the implementer and the reviewer", async () => {
    const item = gitStory();
    const git = gitWorkspaceKind({ db: handle.db, intelligenceFor: () => null });
    const agent = listAgents(handle.db).find((candidate) => candidate.role === "system")!;
    const implementer = listAgents(handle.db).find((candidate) => candidate.role === "implementer")!;
    const workspace = { cwd: "/tmp/wt", kind: preparedIn(item, "/tmp/wt").workspace.kind, workspaceId: item.workspaceId };
    expect((await git.attach(item, agent, workspace)).fence).toBeUndefined();
    // An implementer on an item with no branch recorded may push nothing.
    expect((await git.attach(item, implementer, workspace)).fence).toEqual({ root: "/tmp/wt", pushBranch: null });
  });
});
