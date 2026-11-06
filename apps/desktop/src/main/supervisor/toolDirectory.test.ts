import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMENT_TOOL_NAME,
  McpServerDraftSchema,
  SkillDraftSchema,
  type Agent,
  type AgentEvent,
  type AgentProvider,
  type AgentWriteBridgeAddress,
  type Item,
  type SkillRunScope,
  type SkillScope,
  UNSCOPED_RUN,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { releaseItemToolDirectories, toolDirectoryPath, writeAgentToolDirectory } from "../agentAttachments/pluginDirectory.js";
import type { DbHandle } from "../db/client.js";
import { setAgentAttachment } from "../db/repos/agentAttachmentsRepo.js";
import { listAgents, updateAgent } from "../db/repos/agentsRepo.js";
import { saveMcpServer } from "../db/repos/mcpServersRepo.js";
import { saveSkill } from "../db/repos/skillsRepo.js";
import { listCommentsForItem, postComment } from "../db/repos/commentsRepo.js";
import { createRun, getRun, listRunsForItem, updateRun } from "../db/repos/runsRepo.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { listPipelineSteps } from "../db/repos/pipelineStepsRepo.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { validImplementResult } from "../providers/fixtures.js";
import { codexClientOptions, createCodexProvider } from "../providers/codex.js";
import { CodexClient, type CodexClientOptions } from "../providers/codexClient.js";
import { fakeAppServer, note } from "../testing/fakeCodexAppServer.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
import { sendAgentWrite } from "../mcp/writeBridge.js";
import { promptHash } from "../roles/prompts.js";
import { agentAttachmentsHash } from "../agentAttachments/fingerprint.js";
import { createRunSupervisor, type RunSupervisorOptions } from "./runSupervisor.js";
import { kindsPreparing } from "./testWorkspaceKinds.js";
import { skillRunScope } from "./workspaceResolution.js";

/**
 * Every path that reaches a backend gets the directory, and keeps it for
 * as long as the conversation it belongs to (EO-107).
 *
 * Three paths create runs and all three need it — a fresh dispatch, a
 * crash reconciliation, and a person's reply unparking a run — because a
 * resumed turn spawns the CLI again and a process nobody pointed at the
 * directory does not have what is in it.
 *
 * These run the real generator against a temporary root rather than a
 * spy, so what they assert is a directory that exists on disk with the
 * right things in it, not that a seam was called.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const CWD = "/tmp/eo/worktrees/EO-107";
const PRIOR_THREAD = "session-1";

/** What a provider was handed, per call. */
interface Turn {
  kind: "start" | "resume";
  toolDirectory: string | undefined;
}

let handle: DbHandle;
let root: string;
let item: Item;
let implementer: Agent;
let turns: Turn[];
let writes: TestWriteBridge;

beforeEach(async () => {
  // Where a turn's `comment` call reaches EO (EO-543): a run only parks
  // on a blocking comment that was posted over it.
  writes = await startTestWriteBridge();
  handle = openMigratedTestDb();
  root = mkdtempSync(join(tmpdir(), "eo agent tools "));
  item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  turns = [];
});

afterEach(async () => {
  await writes.close();
  handle.close();
  rmSync(root, { recursive: true, force: true });
});

function attachServer(name = "github") {
  const saved = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name, transport: "stdio", command: "gh-mcp" }));
  if (!saved.ok) throw new Error(saved.problems.join("\n"));
  setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: saved.server.id, attached: true });
  return saved.server;
}

function attachSkill(name = "House style", scope?: SkillScope) {
  const saved = saveSkill(handle.db, SkillDraftSchema.parse({ name, description: "A house playbook.", body: "Read the diff.", ...(scope ? { scope } : {}) }));
  if (!saved.ok) throw new Error(saved.problems.join("\n"));
  setAgentAttachment(handle.db, { agentId: implementer.id, kind: "skill", id: saved.skill.id, attached: true });
  return saved.skill;
}

/**
 * Replays one turn's events the way a backend running the `eo` server
 * would: a `comment` call is handed to EO over the turn's write bridge,
 * which posts it (EO-543). EO writes nothing off the event alone, so a
 * replay that only said the call would leave the comment unposted.
 */
async function* replay(events: readonly AgentEvent[], writeBridge: AgentWriteBridgeAddress | undefined): AsyncIterable<AgentEvent> {
  for (const event of events) {
    yield event;
    if (event.type === "tool_call" && event.name === COMMENT_TOOL_NAME && writeBridge !== undefined) {
      await sendAgentWrite(writeBridge, { tool: COMMENT_TOOL_NAME, args: event.args });
    }
  }
}

/**
 * A provider that records what it was handed and replays the events it
 * was given.
 *
 * Written here rather than taken from `createFakeProvider` because these
 * tests need two things that fixture does not do: the options each turn
 * carried, and a `server_status` event with statuses of their choosing.
 */
function recording(events: AgentEvent[] = [{ type: "result", data: validImplementResult }]): AgentProvider {
  return {
    start: (opts) => {
      turns.push({ kind: "start", toolDirectory: opts.toolDirectory });
      return replay(events, opts.writeBridge);
    },
    resume: (_threadId, _message, opts) => {
      turns.push({ kind: "resume", toolDirectory: opts?.toolDirectory });
      return replay(events, opts?.writeBridge);
    },
  };
}

/**
 * The same recorder, but with a different script per turn.
 *
 * A corrective turn is the second call on one run, and it has to answer
 * differently from the first or the run never ends.
 */
function scripted(...perTurn: AgentEvent[][]): AgentProvider {
  let turn = 0;
  const next = (): AgentEvent[] => perTurn[Math.min(turn++, perTurn.length - 1)] ?? [];
  return {
    start: (opts) => {
      turns.push({ kind: "start", toolDirectory: opts.toolDirectory });
      return replay(next(), opts.writeBridge);
    },
    resume: (_threadId, _message, opts) => {
      turns.push({ kind: "resume", toolDirectory: opts?.toolDirectory });
      return replay(next(), opts?.writeBridge);
    },
  };
}

function supervisorFor(provider: AgentProvider, overrides: Partial<RunSupervisorOptions> = {}) {
  const supervisor = createRunSupervisor({
    db: handle.db,
    provider,
    agentWriteBridge: writes.agentWriteBridge,
    kinds: kindsPreparing(CWD),
    // The same wiring `createEngine` uses in production, pointed at a
    // temporary root instead of `userData`.
    prepareToolDirectory: (forItem, agent) => writeAgentToolDirectory(handle.db, { root, itemId: forItem.id, agentId: agent.id, scope: skillRunScope(handle.db, forItem) }),
    releaseToolDirectories: (settled) => releaseItemToolDirectories(root, settled.id),
    limits: LIMITS,
    ...overrides,
  });
  // The newest supervisor is the one driving turns, so it is the one
  // their writes are handed to.
  writes.serve(supervisor);
  return supervisor;
}

/** A finished run of this agent's on this item, the way a real dispatch leaves one. */
function priorRun(overrides: Record<string, unknown> = {}) {
  const run = createRun(handle.db, {
    itemId: item.id,
    agentId: implementer.id,
    action: "implement",
    status: "queued",
    threadId: PRIOR_THREAD,
    provider: implementer.provider,
    instructionsHash: promptHash(implementer.instructions),
    agentAttachmentsHash: agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN),
    cwd: CWD,
    ...overrides,
  });
  updateRun(handle.db, run.id, { status: "succeeded", startedAt: 1_000, endedAt: 1_000 });
  return run;
}

const expectedPath = () => toolDirectoryPath(root, item.id, implementer.id);

const engineNotes = (): string[] =>
  listCommentsForItem(handle.db, item.id)
    .filter((comment) => comment.authorType === "engine")
    .map((comment) => comment.body);

describe("the three paths that reach a backend", () => {
  it("a fresh dispatch writes the directory and hands the backend its path", async () => {
    attachServer();
    attachSkill();

    await supervisorFor(recording()).runOnce();

    expect(turns).toEqual([{ kind: "start", toolDirectory: expectedPath() }]);
    expect(existsSync(join(expectedPath(), ".mcp.json"))).toBe(true);
    expect(existsSync(join(expectedPath(), "skills", "house-style", "SKILL.md"))).toBe(true);
  });

  it("a crash reconciliation writes it again, because the process holding those servers died", async () => {
    attachServer();
    const interrupted = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId: PRIOR_THREAD,
      provider: implementer.provider,
      // What the thread was born with, as `dispatchRun` records it. A row
      // without it reads as the empty surface and is refused — which is
      // the next test.
      agentAttachmentsHash: agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN),
      cwd: CWD,
    });
    updateRun(handle.db, interrupted.id, { status: "running", startedAt: Date.now() });

    const supervisor = supervisorFor(recording());
    expect(await supervisor.reconcile()).toEqual({ reattached: 0, resumed: 1, orphaned: 0 });
    await supervisor.waitForIdle();

    expect(turns).toEqual([{ kind: "resume", toolDirectory: expectedPath() }]);
    expect(existsSync(join(expectedPath(), ".mcp.json"))).toBe(true);
  });

  it("a person's reply unparking a run resumes with the directory the thread was opened with", async () => {
    attachServer();
    const parked = priorRun();
    updateRun(handle.db, parked.id, { status: "awaiting_input", endedAt: 1_000 });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Yes, go ahead." });

    await supervisorFor(recording()).resumeItem(item.id);

    expect(turns).toEqual([{ kind: "resume", toolDirectory: expectedPath() }]);
    expect(existsSync(join(expectedPath(), ".mcp.json"))).toBe(true);
  });

  it("hands nothing to an agent with nothing attached, rather than an empty directory", async () => {
    await supervisorFor(recording()).runOnce();

    expect(turns).toEqual([{ kind: "start", toolDirectory: undefined }]);
    expect(existsSync(expectedPath())).toBe(false);
  });
});

describe("a run that parks awaiting a person", () => {
  it("keeps its directory until the thread is finished with", async () => {
    attachServer();
    // The agent asks a blocking question: the run ends, and the
    // conversation behind it does not.
    await supervisorFor(
      recording([
        { type: "thread_started", threadId: PRIOR_THREAD },
        { type: "tool_call", name: "comment", args: { body: "@user which limit?", mentions: ["user"], blocking: true } },
      ]),
    ).runOnce();

    const parked = listRunsForItem(handle.db, item.id).at(-1)!;
    expect(getRun(handle.db, parked.id)?.status).toBe("awaiting_input");
    // The run is over. The directory is not: taking it away here would
    // resume the person's conversation with its servers gone.
    expect(existsSync(join(expectedPath(), ".mcp.json"))).toBe(true);

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Ten." });
    await supervisorFor(recording()).resumeItem(item.id);

    expect(turns.at(-1)).toEqual({ kind: "resume", toolDirectory: expectedPath() });
    expect(existsSync(join(expectedPath(), ".mcp.json"))).toBe(true);
  });

  it("and lets it go once the item settles, which is when nothing will be resumed again", async () => {
    attachServer();
    const terminal = listPipelineSteps(handle.db).find((step) => step.isTerminal)!;

    await supervisorFor(recording(), {
      // Straight to a terminal step, rather than walking the whole
      // pipeline: what is being asserted is what settling does, and the
      // route it took to get there is somebody else's test.
      resolveNextState: () => ({ stepId: terminal.id, pipelineId: terminal.pipelineId }),
    }).runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe(terminal.id);
    expect(existsSync(join(root, item.id))).toBe(false);
  });
});

describe("a corrective turn inside one run", () => {
  it("keeps the tools the turn it is correcting had", async () => {
    attachServer();
    attachSkill();

    // A result that does not validate: the engine sends a correction on
    // the same run rather than starting another. Before this was
    // carried, that turn respawned the CLI with no plugin and an empty
    // skills allowlist — the agent's server and skills gone between
    // being asked for something and being asked to fix it.
    await supervisorFor(
      scripted(
        [
          { type: "thread_started", threadId: PRIOR_THREAD },
          { type: "result", data: { thisFieldDoesNotExist: true } },
        ],
        [{ type: "result", data: validImplementResult }],
      ),
    ).runOnce();

    expect(turns).toEqual([
      { kind: "start", toolDirectory: expectedPath() },
      { kind: "resume", toolDirectory: expectedPath() },
    ]);
    expect(listRunsForItem(handle.db, item.id).at(-1)?.status).toBe("succeeded");
  });
});

describe("a thread whose agent's attachments changed while it waited", () => {
  /** Detaching the only attached server: the surface moves, and so does its fingerprint. */
  function detach(serverId: string) {
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: serverId, attached: false });
  }

  it("is not resumed by reconciliation, and its directory is left alone until something else is", async () => {
    const github = attachServer();
    const interrupted = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId: PRIOR_THREAD,
      provider: implementer.provider,
      agentAttachmentsHash: agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN),
      cwd: CWD,
    });
    updateRun(handle.db, interrupted.id, { status: "running", startedAt: Date.now() });
    // The thread's directory, as the crashed run left it.
    writeAgentToolDirectory(handle.db, { root, itemId: item.id, agentId: implementer.id, scope: UNSCOPED_RUN });

    detach(github.id);
    const summary = await supervisorFor(recording()).reconcile();

    expect(summary).toEqual({ reattached: 0, resumed: 0, orphaned: 1 });
    expect(turns).toEqual([]); // no resume, so nothing was pointed at a surface that had moved
    expect(engineNotes().join("\n")).toContain("MCP servers or skills attached to");
    // And the refusal did not take the directory with it: regenerating
    // for a resume that is not happening would have deleted it, since
    // there is now nothing to deliver.
    expect(existsSync(join(expectedPath(), ".mcp.json"))).toBe(true);
  });

  it("is not resumed by a person's reply either — the reply opens a fresh thread instead", async () => {
    const github = attachServer();
    const parked = priorRun();
    updateRun(handle.db, parked.id, { status: "awaiting_input", endedAt: 1_000 });
    writeAgentToolDirectory(handle.db, { root, itemId: item.id, agentId: implementer.id, scope: UNSCOPED_RUN });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Carry on." });

    detach(github.id);
    await supervisorFor(recording()).resumeItem(item.id);

    // A fresh start, not a resume — and with no directory, because the
    // agent now has nothing attached. The reply is not lost: the new run
    // is seeded from the thread.
    expect(turns).toEqual([{ kind: "start", toolDirectory: undefined }]);
    expect(engineNotes().join("\n")).toContain("MCP servers or skills attached to");
  });
});

describe("an attachment edit that lands while a run is being prepared", () => {
  /**
   * The gap the reviewer named: `findReusableThread` weighs the thread up
   * *before* the context is assembled, and assembling it yields the event
   * loop. Mutating inside the `buildContext` seam is that window,
   * exactly.
   */
  function attachingDuringContext(): NonNullable<RunSupervisorOptions["buildContext"]> {
    return async () => {
      await Promise.resolve();
      attachSkill("Late arrival");
      return "the follow-up prompt";
    };
  }

  it("does not resume a thread that stopped matching while the context was being built", async () => {
    updateAgent(handle.db, implementer.id, { config: { reuseThreadPerItem: true } });
    attachServer();
    priorRun();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Carry on." });

    await supervisorFor(recording(), { buildContext: attachingDuringContext() }).runOnce();

    // A fresh thread, and a directory built from the surface it actually
    // has — not the old thread pointed at a new one.
    expect(turns).toEqual([{ kind: "start", toolDirectory: expectedPath() }]);
    expect(engineNotes().join("\n")).toContain("changed while this run was being prepared");
    expect(existsSync(join(expectedPath(), "skills", "late-arrival", "SKILL.md"))).toBe(true);
  });

  it("records the surface the run was actually given, so the next dispatch weighs up the truth", async () => {
    updateAgent(handle.db, implementer.id, { config: { reuseThreadPerItem: true } });
    attachServer();
    priorRun();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Carry on." });

    await supervisorFor(recording(), { buildContext: attachingDuringContext() }).runOnce();

    // The row must hold the fingerprint the directory was written from.
    // Holding the pre-await one would make the *next* dispatch reuse this
    // thread against a surface it never had — the same bug, one run later.
    expect(listRunsForItem(handle.db, item.id).at(-1)?.agentAttachmentsHash).toBe(agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN));
  });

  it("does not let a person's reply resume one either", async () => {
    attachServer();
    const parked = priorRun();
    updateRun(handle.db, parked.id, { status: "awaiting_input", endedAt: 1_000 });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Carry on." });

    await supervisorFor(recording(), { buildContext: attachingDuringContext() }).resumeItem(item.id);

    expect(turns).toEqual([{ kind: "start", toolDirectory: expectedPath() }]);
    expect(engineNotes().join("\n")).toContain("MCP servers or skills attached to");
  });
});

describe("checking that an attached server actually started", () => {
  /** The init message's own shape: EO's server, and the attached one under the name it was handed over as. */
  function status(servers: { name: string; status: string }[]): AgentEvent[] {
    return [
      { type: "thread_started", threadId: "sess-1" },
      { type: "server_status", servers },
      { type: "result", data: validImplementResult },
    ];
  }

  it("says nothing when the backend reports it connected", async () => {
    attachServer();

    await supervisorFor(recording(status([{ name: "github", status: "connected" }]))).runOnce();

    expect(engineNotes()).toEqual([]);
  });

  it("accepts the plugin-qualified spelling too, rather than being wrong about which arrangement is live", async () => {
    attachServer();

    await supervisorFor(recording(status([{ name: "plugin:eo-attachments:github", status: "connected" }]))).runOnce();

    expect(engineNotes()).toEqual([]);
  });

  it("ends a server that failed to start in a comment on the item, in the backend's own words", async () => {
    attachServer();

    await supervisorFor(recording(status([{ name: "github", status: "needs-auth" }]))).runOnce();

    expect(engineNotes()).toHaveLength(1);
    expect(engineNotes()[0]).toContain("**github**");
    // Verbatim: `needs-auth` and `failed` are different things to do
    // something about, and a status EO has never heard of is exactly the
    // one worth showing as it came.
    expect(engineNotes()[0]).toContain('"needs-auth"');
  });

  it("notices a server that never appeared at all, rather than assuming it did", async () => {
    attachServer();

    await supervisorFor(recording(status([{ name: "eo", status: "connected" }]))).runOnce();

    expect(engineNotes()[0]).toContain("never reported it at all");
  });

  it("judges the report against what the turn was given, not against the catalogue as it is now", async () => {
    const github = attachServer();
    // Detached while the process was starting, before it said anything.
    // The turn was still *given* that server, so a backend that never
    // brings it up is still something the person needs telling about.
    const provider = recording(status([{ name: "eo", status: "connected" }]));
    const detachingOnStart: AgentProvider = {
      start: (opts) => {
        setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: false });
        return provider.start(opts);
      },
      resume: provider.resume,
    };

    await supervisorFor(detachingOnStart).runOnce();

    expect(engineNotes().join("\n")).toContain("**github**");
  });

  it("says nothing about a server attached after the turn had already started", async () => {
    attachServer();
    const provider = recording(status([{ name: "github", status: "connected" }]));
    const attachingOnStart: AgentProvider = {
      start: (opts) => {
        attachServer("linear");
        return provider.start(opts);
      },
      resume: provider.resume,
    };

    await supervisorFor(attachingOnStart).runOnce();

    // `linear` was never written into this turn's directory, so
    // complaining that the backend did not report it would be a comment
    // about a surface no run ever had.
    expect(engineNotes()).toEqual([]);
  });

  it("says nothing about a server nobody attached to this agent", async () => {
    // EO's own server and whatever else the machine has are not this
    // agent's tool surface, and reporting them would put a comment on
    // every item.
    await supervisorFor(recording(status([{ name: "some-connector", status: "failed" }]))).runOnce();

    expect(engineNotes()).toEqual([]);
  });

  it("does not fail the run over it — a degraded run still beats no run", async () => {
    attachServer();

    await supervisorFor(recording(status([{ name: "github", status: "failed" }]))).runOnce();

    expect(listRunsForItem(handle.db, item.id).at(-1)?.status).toBe("succeeded");
  });
});

/**
 * The same check, on a Codex agent (EO-373).
 *
 * Claude's init message lists every server at once; Codex sends
 * `mcpServer/startupStatus/updated` one server at a time, and before the
 * app-server nothing at all — so an attached server that failed to start
 * on Codex went unreported. Now the adapter collects the reports into one
 * `server_status` and the same note lands on the item, from the same
 * code, judged against the same directory snapshot.
 *
 * The real adapter and client over a stubbed app-server that reports
 * the way 0.161.0 does, including the `starting` before each outcome —
 * as 0.163.0 still does, one server at a time (EO-453), and 0.165.0 too:
 * its notification is the same file byte for byte, and a real turn there
 * reported `codex_apps` `starting`, then `ready` (EO-599) — and 0.166.0
 * the same, file and real turn both (EO-644).
 */
describe("checking that an attached server actually started, on Codex", () => {
  function codexReporting(...startups: ReturnType<typeof note.mcpStartup>[]) {
    const server = attachServer();
    const fake = fakeAppServer({
      after: {
        "thread/start": [note.mcpStartup("github", "starting"), ...startups],
        "turn/start": [note.turnStarted(), note.agentMessage(JSON.stringify(validImplementResult)), note.tokenUsage({ input: 10, output: 2 }), note.turnCompleted()],
      },
    });
    const options = { executablePath: "/opt/eo/runtimes/codex/bin/codex", attachedServers: [server] };
    const extra: Partial<CodexClientOptions> = { spawn: fake.spawn, shutdownGraceMs: 200 };
    return createCodexProvider({ ...options, createCodex: (repositoryMcp) => new CodexClient({ ...codexClientOptions(options, repositoryMcp), ...extra }) });
  }

  it("ends a server that failed to start in the same note Claude's would", async () => {
    const provider = codexReporting(note.mcpStartup("github", "failed", "MCP client for `github` failed to start: No such file or directory (os error 2)"));

    await supervisorFor(provider).runOnce();

    expect(engineNotes()).toHaveLength(1);
    expect(engineNotes()[0]).toContain("an MCP server that did not start");
    expect(engineNotes()[0]).toContain("**github**");
    expect(engineNotes()[0]).toContain('"failed"');
    // A degraded run still beats no run, on this backend too.
    expect(listRunsForItem(handle.db, item.id).at(-1)?.status).toBe("succeeded");
  });

  it("says nothing when Codex reports it ready", async () => {
    const provider = codexReporting(note.mcpStartup("github", "ready"));

    await supervisorFor(provider).runOnce();

    expect(engineNotes()).toEqual([]);
  });
});

/**
 * A run is given the skills of its own scope and no other's (EO-470).
 *
 * Driven through the supervisor with the production wiring, so the scope
 * is the one `skillRunScope` resolves from the item: what the Claude
 * directory holds, and what the Codex adapter is told to narrow by.
 */
describe("scoped skills reach the run they are scoped to", () => {
  it("writes the global, the project's and the workspace's skills, hands the turn its scope, and leaves out every other", async () => {
    const workspace = attachWorkspace(handle.db, { keyPrefix: "P", name: "app", repoPath: "/tmp/eo/app" });
    const projectId = workspace.projectId!;
    const firstItem = item;
    item = createTestItem(handle.db, { type: "story", title: "A story on P", stepId: "todo", projectId, workspaceId: workspace.id });
    attachSkill("House style");
    attachSkill("E2E for P", { kind: "project", projectId });
    attachSkill("E2E elsewhere", { kind: "project", projectId: "another-project" });
    attachSkill("Build in W", { kind: "workspace", workspaceId: workspace.id });
    attachSkill("Build elsewhere", { kind: "workspace", workspaceId: "another-workspace" });

    const scopes: (SkillRunScope | undefined)[] = [];
    const provider: AgentProvider = {
      start: (opts) => {
        scopes.push(opts.skillScope);
        return (async function* () {
          yield { type: "result", data: validImplementResult } as AgentEvent;
        })();
      },
      resume: () => (async function* () {})(),
    };
    await supervisorFor(provider).runOnce();

    // Two items are on the board — this one and the unscoped one every
    // test here starts with — and each turn is told where its own run works.
    expect(scopes).toHaveLength(2);
    expect(scopes).toContainEqual({ projectId, workspaceId: workspace.id });
    expect(scopes).toContainEqual(skillRunScope(handle.db, firstItem));
    const skills = join(expectedPath(), "skills");
    expect(["house-style", "e2e-for-p", "build-in-w"].map((slug) => existsSync(join(skills, slug, "SKILL.md")))).toEqual([true, true, true]);
    expect(["e2e-elsewhere", "build-elsewhere"].map((slug) => existsSync(join(skills, slug)))).toEqual([false, false]);
    // And the run recorded the hash of what it was given, not of every
    // skill attached — the hash thread reuse compares.
    expect(listRunsForItem(handle.db, item.id)[0]?.agentAttachmentsHash).toBe(agentAttachmentsHash(handle.db, implementer.id, { projectId, workspaceId: workspace.id }));
    expect(listRunsForItem(handle.db, item.id)[0]?.agentAttachmentsHash).not.toBe(agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN));
  });
});
