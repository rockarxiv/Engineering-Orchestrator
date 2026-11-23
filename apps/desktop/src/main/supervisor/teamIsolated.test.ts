import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMENT_TOOL_NAME,
  participantTurnSchema,
  REPOSITORY_CHECKOUT_TOOL_NAME,
  SKILL_LOADED_EVENT,
  SKILL_READ_TOOL_NAME,
  SkillDraftSchema,
  SKILLS_DELIVERED_EVENT,
  SKILLS_SETTLED_EVENT,
  StepTeamSchema,
  TEAM_PARTICIPANT_ACTION,
  uuidv7,
  type Agent,
  type AgentEvent,
  type AgentProvider,
  type AgentProviderStartOptions,
  type AgentWriteBridgeAddress,
  type AgentWriteTool,
  type Item,
  type RepositoryMcpServer,
  type StepTeam,
} from "@eo/core";
import type { SectionRenderer } from "@eo/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { saveActionDefinition } from "../db/repos/actionDefinitionsRepo.js";
import { setAgentAttachment } from "../db/repos/agentAttachmentsRepo.js";
import { createAgent } from "../db/repos/agentsRepo.js";
import { listCommentsForItem, postComment } from "../db/repos/commentsRepo.js";
import { createRoute, listRunEvents } from "../db/repos/index.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { createStep } from "../db/repos/pipelineStepsRepo.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import { saveSkill } from "../db/repos/skillsRepo.js";
import { listTeamSessionsForItem } from "../db/repos/teamSessionsRepo.js";
import { transitionItem } from "../db/repos/transitionsRepo.js";
import { createTestItem, openMigratedTestDbAt, agentOfKind, setStepTeam } from "../db/testHelpers.js";
// @ts-expect-error — the service is plain JavaScript, deliberately: it ships unbundled because Codex spawns it by path.
import * as service from "../mcp/eoServer.mjs";
import type { AgentWriteBridge } from "../mcp/writeBridge.js";
import { noneWorkspaceKind } from "./noneKind.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";
import type { MemberCopy } from "./teamEvidence.js";
import type { WorkspaceKind } from "./workspaceKind.js";

/**
 * Isolated team members (EO-867), end to end through the supervisor: each
 * member dispatched as its role's agent is on an ordinary dispatch of the
 * step — its own provider, instructions, context, index, tool directory
 * and options — standing in a copy of its own, seeing none of its team's
 * other reports, posting nothing itself.
 */

const ROOMY = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const REPO_SERVER: RepositoryMcpServer = { name: "repo", command: "/bin/codewiki", args: ["serve"], env: {} };

type Script = (call: { agent: Agent; opts: AgentProviderStartOptions; nth: number }) => AsyncIterable<AgentEvent>;

interface Started {
  agent: Agent;
  provider: AgentProvider;
  opts: AgentProviderStartOptions;
}

let handle: DbHandle;
let scratch: string;
let item: Item;
let quinn: Agent;
let started: Started[];
let script: Script;
let copies: { cwd: string; removed: boolean }[];
let copyChanges: string[];
const supervisors: RunSupervisor[] = [];
const providers = new Map<string, AgentProvider>();
const factoryAsked: string[] = [];

/** The ordinary provider, one per agent, recording what each turn is started with. */
function providerFor(agent: Agent): AgentProvider {
  factoryAsked.push(agent.name);
  const known = providers.get(agent.id);
  if (known) return known;
  const made: AgentProvider = {
    start: (opts) => {
      started.push({ agent, provider: made, opts });
      return script({ agent, opts, nth: started.length })[Symbol.asyncIterator]() as unknown as ReturnType<AgentProvider["start"]>;
    },
    resume: () => {
      throw new Error("Nothing here resumes.");
    },
  };
  providers.set(agent.id, made);
  return made;
}

/** A bridge that signs nothing, so what a turn is handed can be read back. */
const bridge: Pick<AgentWriteBridge, "tokenFor" | "close"> = {
  tokenFor: (itemId: string, writes?: readonly AgentWriteTool[], scope?: string): AgentWriteBridgeAddress =>
    writes === undefined ? { url: "http://127.0.0.1:1/agent-write", token: `${itemId}.mac` } : { url: "http://127.0.0.1:1/agent-write", token: `${itemId}~${writes.join(",")}${scope === undefined ? "" : `~${scope}`}.mac`, writes: [...writes] },
  close: async () => undefined,
};

/** The `none` kind, lending an index as a repository's would, with copies EO can watch made and removed. */
function kind(withCopies = true): WorkspaceKind {
  const none = noneWorkspaceKind(join(scratch, "no-disk"));
  const evidence = none.evidence!;
  return {
    ...none,
    attach: async () => ({ mcpServers: [REPO_SERVER], skills: [], notices: [] }),
    evidence: withCopies
      ? {
          ...evidence,
          async copy(copyItem, workspace, source, request) {
            const made = await evidence.copy!(copyItem, workspace, source, request);
            if (!made.ok) return made;
            const seen = { cwd: made.copy.cwd, removed: false };
            copies.push(seen);
            const copy: MemberCopy = {
              cwd: made.copy.cwd,
              changes: async () => (seen.removed ? [] : [...copyChanges]),
              remove: async () => {
                seen.removed = true;
                await made.copy.remove();
              },
            };
            return { ok: true, copy };
          },
        }
      : { capture: evidence.capture, open: evidence.open },
  };
}

/** Renders the current output, as the developer pack's section does. */
const OUTPUT_SECTION: SectionRenderer = { id: "output", after: "item", render: (input) => (input.currentOutput === null ? null : `## The current output\n\n${input.currentOutput.body}`) };

function supervisor(extra: Partial<Parameters<typeof createRunSupervisor>[0]> = {}): RunSupervisor {
  const made = createRunSupervisor({
    db: handle.db,
    provider: providerFor,
    limits: ROOMY,
    reportOnlyProvider: () => {
      throw new Error("An isolated member was built as a report-only participant.");
    },
    teamPollMs: 5,
    noDiskRoot: join(scratch, "no-disk"),
    kinds: new Map([["none", kind()]]),
    prepareToolDirectory: () => ({ path: join(scratch, "tools"), serverNames: [] }),
    agentWriteBridge: () => bridge as AgentWriteBridge,
    sectionRenderers: [OUTPUT_SECTION],
    ...extra,
  });
  supervisors.push(made);
  return made;
}

function isolated(participants: { key: string; role: string }[], limits: Record<string, unknown> = {}): StepTeam {
  return StepTeamSchema.parse({
    coordination: "independent",
    members: "isolated",
    participants: participants.map((one) => ({ ...one, instructions: `Look at it as ${one.key}.` })),
    outcomes: [
      { key: "clear", label: "Nothing found" },
      { key: "blocking", label: "Blocking issue" },
    ],
    completion: { rules: [{ when: "any", outcomes: ["blocking"], result: "gaps_found" }], fallback: "aligned" },
    limits: { maxParticipants: participants.length, maxParallel: Math.min(2, participants.length), ...limits },
  });
}

function client(): { prepare(source: string): { run(...args: unknown[]): unknown } } {
  return (handle.db as unknown as { $client: ReturnType<typeof client> }).$client;
}

function setTeam(value: StepTeam | null): void {
  setStepTeam(handle.db, "check", value);
}

async function* answer(data: unknown): AsyncGenerator<AgentEvent> {
  yield { type: "thread_started", threadId: `thread-${uuidv7()}` };
  yield { type: "result", data };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo-team-isolated-"));
  // On disk, so the `eo` server can open it as a turn's does.
  handle = openMigratedTestDbAt(join(scratch, "eo.db"));
  started = [];
  copies = [];
  copyChanges = [];
  providers.clear();
  factoryAsked.length = 0;
  quinn = createAgent(handle.db, { name: "Quinn", role: "qa", provider: "claude", instructions: "You check work against what was asked." });
  createStep(handle.db, { id: "check", pipelineId: "default" as never, position: -3, name: "Alignment", type: "agent", agentId: agentOfKind(handle.db, "qa"), entryAction: "alignment" });
  createStep(handle.db, { id: "rework", pipelineId: "default" as never, position: -2, name: "Rework", type: "user", agentId: null, entryAction: null });
  createStep(handle.db, { id: "accepted", pipelineId: "default" as never, position: -1, name: "Accepted", type: "user", agentId: null, entryAction: null });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "check", resultKey: "aligned", label: "Aligned", target: "accepted", position: 0 });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "check", resultKey: "gaps_found", label: "Gaps found", target: "rework", position: 1 });
  const saved = saveActionDefinition(handle.db, {
    role: "qa",
    action: "alignment",
    description: "Check the work against what was asked for.",
    results: [
      { key: "aligned", label: "Aligned", meaning: "Everything asked for is there." },
      { key: "gaps_found", label: "Gaps found", meaning: "Something asked for is missing." },
    ],
  });
  if (!saved.ok) throw new Error("action");
  item = createTestItem(handle.db, { type: "story", title: "Check the export", stepId: "check" });
  postComment(handle.db, { itemId: item.id, author: { type: "engine" }, kind: "output", body: "diff --git a/export.ts b/export.ts\n+export const csv = true;" });
  postComment(handle.db, { itemId: item.id, author: { type: "human" }, kind: "note", body: "Pinned: exports must stay under a second.", pinned: true });
  postComment(handle.db, { itemId: item.id, author: { type: "human" }, kind: "note", body: "Please check the header row too." });
});

afterEach(async () => {
  for (const made of supervisors.splice(0)) await made.shutdown();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * A turn's options without these keys — and with each per-run callback the
 * provider boundary adds (what a suggestion spent, how it ended) named
 * rather than compared, since each run has its own.
 */
const without = (opts: AgentProviderStartOptions, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(opts).filter(([key]) => !keys.includes(key)).map(([key, value]) => [key, typeof value === "function" ? "a callback of its run's" : value]));

describe("an isolated member has its role's agent's rights (EO-867)", () => {
  it("is started on the agent's ordinary provider with an ordinary dispatch's options, differing only in where it stands, its attempt, its framing and posting nothing", async () => {
    // One agent alone on the step, as it is dispatched today.
    script = () => answer({ result: "aligned", summary: "It is all there." });
    await supervisor().runOnce();
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    const ordinary = started[0]!;

    // The same agent on the same step, now as the one member of an isolated team.
    transitionItem(handle.db, { itemId: item.id, toStepId: "check", actor: "human" });
    setTeam(isolated([{ key: "own", role: "qa" }]));
    script = () => answer({ outcome: "clear", report: "I checked it as I would alone." });
    await supervisor().runOnce();
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    expect(started).toHaveLength(2);
    const member = started[1]!;

    // The agent's own ordinary provider — the one `providerForAgent` builds — never a report-only one.
    expect(member.agent.id).toBe(quinn.id);
    expect(member.provider).toBe(ordinary.provider);
    expect(factoryAsked.every((name) => name === "Quinn")).toBe(true);

    // Everything else an ordinary dispatch is started with is the member's too.
    const exempt = ["cwd", "instructions", "context", "outputSchema", "writeBridge", "signal", "processScope"];
    expect(without(member.opts, exempt)).toEqual(without(ordinary.opts, exempt));
    // Its process is filed under its own run, the attempt's, at the same limit.
    const scopeOf = (opts: AgentProviderStartOptions) => (opts as { processScope?: { runId: string; memoryMaxMb?: number } }).processScope;
    expect({ ...scopeOf(member.opts), runId: "run" }).toEqual({ ...scopeOf(ordinary.opts), runId: "run" });
    expect(scopeOf(member.opts)?.runId).toBe(listRunsForItem(handle.db, item.id).find((run) => run.action === TEAM_PARTICIPANT_ACTION)?.id);
    expect(member.opts.repositoryMcp).toEqual(REPO_SERVER);
    expect(member.opts.toolDirectory).toBe(join(scratch, "tools"));
    expect("reportOnly" in member.opts).toBe(false);

    // Where it stands: a copy made for its attempt, never the item's own directory.
    expect(member.opts.cwd).not.toBe(ordinary.opts.cwd);
    expect(member.opts.cwd).toBe(copies[0]!.cwd);
    // Its framing: the agent's instructions, then the team's; no report-only text.
    expect(member.opts.instructions.startsWith(`${ordinary.opts.instructions}\n\n## Your part in a team`)).toBe(true);
    expect(member.opts.instructions).not.toMatch(/report-only|evidence_list|item_context/);
    expect(member.opts.outputSchema).toEqual(participantTurnSchema(isolated([{ key: "own", role: "qa" }]).outcomes));
    // Its `eo` server is the ordinary one, on a credential of its attempt's that posts nothing.
    expect(ordinary.opts.writeBridge?.writes).toBeUndefined();
    expect(member.opts.writeBridge?.writes).toEqual([REPOSITORY_CHECKOUT_TOOL_NAME, SKILL_READ_TOOL_NAME]);
    expect(member.opts.writeBridge?.writes).not.toContain(COMMENT_TOOL_NAME);
    expect(member.opts.writeBridge?.reportOnly).toBeUndefined();
    expect(member.opts.writeBridge?.token).toMatch(/~member_[0-9a-f-]+\.mac$/);
    expect(member.opts.writeBridge?.teamMember?.itemId).toBe(item.id);
  });

  it("is given its step's ordinary context — the current output, pinned and human comments — and the team framing after it", async () => {
    setTeam(isolated([{ key: "own", role: "qa" }]));
    script = () => answer({ outcome: "clear", report: "Fine." });
    await supervisor().runOnce();
    const context = started[0]!.opts.context;
    expect(context).toContain("## The current output");
    expect(context).toContain("+export const csv = true;");
    expect(context).toContain("Pinned: exports must stay under a second.");
    expect(context).toContain("Please check the header row too.");
    expect(context).toContain("## Your assignment: own");
    expect(context.indexOf("Check the export")).toBeLessThan(context.indexOf("## Your assignment: own"));
    expect(context).not.toContain("item_context");
  });

  it("runs an agent EO could never hold report-only, since none of the report-only refusals apply", async () => {
    // A backend with no lock at all, its own executable and the person's own setup: an ordinary dispatch runs it.
    createAgent(handle.db, { name: "Ada", role: "own", provider: "fake", instructions: "You look closely.", config: { inheritAmbientConfig: true, executablePath: "/opt/my/claude" } as never });
    setTeam(isolated([{ key: "own", role: "own" }]));
    script = () => answer({ outcome: "clear", report: "Looked." });
    await supervisor().runOnce();
    expect(started.map((one) => one.agent.name)).toEqual(["Ada"]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
  });
});

describe("an isolated member's MCP servers (EO-886)", () => {
  it("says on the item which of the servers it was given did not come up, as an ordinary run does, and carries on", async () => {
    setTeam(isolated([{ key: "own", role: "qa" }]));
    script = () =>
      (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: "thread_started", threadId: `thread-${uuidv7()}` };
        yield { type: "server_status", servers: [{ name: "eo", status: "connected" }, { name: "plugin:eo-attachments:github", status: "failed" }] };
        yield { type: "result", data: { outcome: "clear", report: "Read it without GitHub." } };
      })();
    await supervisor({ prepareToolDirectory: () => ({ path: join(scratch, "tools"), serverNames: ["github"] }) }).runOnce();
    const memberRun = listRunsForItem(handle.db, item.id).find((run) => run.action === TEAM_PARTICIPANT_ACTION)!;
    const said = listCommentsForItem(handle.db, item.id).filter((comment) => comment.body.includes("MCP server that did not start"));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ authorType: "engine", runId: memberRun.id });
    expect(said[0]!.body).toContain(`${quinn.name} was given an MCP server that did not start, and is running without it:\n\n- **github**`);
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
  });
});

describe("an isolated member's own copy (EO-867)", () => {
  it("is removed when its attempt ends, its report saying first what it changed there", async () => {
    copyChanges = ["1 file changed: `export.ts`", "HEAD moved from aaaaaaaaaaaa to bbbbbbbbbbbb"];
    setTeam(isolated([{ key: "own", role: "qa" }]));
    script = () => answer({ outcome: "clear", report: "Ran the tests after a fix." });
    await supervisor().runOnce();
    expect(copies).toHaveLength(1);
    expect(copies[0]!.removed).toBe(true);
    const report = listCommentsForItem(handle.db, item.id).find((comment) => comment.body.includes("Ran the tests after a fix."));
    expect(report?.body).toContain("**In its own copy of the workspace**, which EO has removed and from which nothing was merged into the item's work: 1 file changed: `export.ts`; HEAD moved");
  });

  it("is one per attempt: two members working at once never share one", async () => {
    createAgent(handle.db, { name: "Sasha", role: "sec", provider: "claude", instructions: "You find ways in." });
    setTeam(isolated([{ key: "own", role: "qa" }, { key: "security", role: "sec" }]));
    let release = (): void => undefined;
    const both = new Promise<void>((resolve) => (release = resolve));
    script = ({ agent }) =>
      (async function* () {
        yield { type: "thread_started", threadId: `t-${agent.name}` } as AgentEvent;
        await both;
        yield { type: "result", data: { outcome: "clear", report: `${agent.name} found nothing.` } } as AgentEvent;
      })();
    const done = supervisor().runOnce();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(new Set(started.map((one) => one.opts.cwd)).size).toBe(2);
    expect(started.every((one) => one.opts.cwd !== getItem(handle.db, item.id)!.id)).toBe(true);
    release();
    await done;
    expect(copies.every((copy) => copy.removed)).toBe(true);
  });

  it("refuses an isolated team at start, naming the kind, where the step's workspace makes no copy — and never runs a member in the item's own", async () => {
    setTeam(isolated([{ key: "own", role: "qa" }]));
    script = () => answer({ outcome: "clear", report: "Should not run." });
    await supervisor({ kinds: new Map([["none", kind(false)]]) }).runOnce();
    expect(started).toEqual([]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("check");
    const said = listCommentsForItem(handle.db, item.id).map((comment) => comment.body).join("\n");
    expect(said).toContain(`its step works in a "none" workspace, which cannot give each member a copy of its own`);
  });
});

describe("an isolated member's independence (EO-867)", () => {
  it("in a team of four running two at a time, the two starting after the first reports see neither, in their context or by asking", async () => {
    for (const [name, role] of [
      ["Sasha", "sec"],
      ["Tess", "tester"],
      ["Una", "perf"],
    ] as const) {
      createAgent(handle.db, { name, role, provider: "claude", instructions: `You are ${name}.` });
    }
    setTeam(
      isolated([
        { key: "own", role: "qa" },
        { key: "security", role: "sec" },
        { key: "tests", role: "tester" },
        { key: "speed", role: "perf" },
      ]),
    );
    script = ({ agent }) => answer({ outcome: "clear", report: `REPORT-OF-${agent.name.toUpperCase()}: looked at it closely.` });
    await supervisor().runOnce();
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    expect(started).toHaveLength(4);

    const memberRuns = new Set(listRunsForItem(handle.db, item.id).filter((run) => run.action === TEAM_PARTICIPANT_ACTION).map((run) => run.id as string));
    const reports = listCommentsForItem(handle.db, item.id).filter((comment) => comment.runId !== null && memberRuns.has(comment.runId) && comment.body.includes("REPORT-OF-"));
    expect(reports).toHaveLength(4);
    const [first, second] = started.slice(0, 2).map((one) => reports.find((report) => report.body.includes(`REPORT-OF-${one.agent.name.toUpperCase()}`))!);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const dbPath = join(scratch, "eo.db");

    for (const later of started.slice(2)) {
      // Started after both had landed.
      const begun = listRunsForItem(handle.db, item.id).find((run) => run.action === TEAM_PARTICIPANT_ACTION && run.agentId === later.agent.id)!;
      expect(begun.startedAt!).toBeGreaterThanOrEqual(Math.max(first!.createdAt, second!.createdAt));
      // Not in its context…
      expect(later.opts.context).not.toContain("REPORT-OF-");
      // …nor through EO's own tools, on its own credential.
      const server = (service as { createEoMcpService: (options: Record<string, unknown>) => { handle(request: unknown): Promise<{ result: { content: { text: string }[]; isError?: boolean } }>; close(): void } }).createEoMcpService({
        dbPath,
        enableCommentTool: true,
        enableFullThread: true,
        writeBridge: later.opts.writeBridge,
      });
      const call = async (name: string, args: Record<string, unknown>) => (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).result;
      try {
        for (const report of [first!, second!]) {
          const read = await call("comment_read", { commentId: report.id });
          expect(read.isError).toBe(true);
          expect(read.content[0]!.text).toContain("COMMENT_NOT_FOUND");
        }
        expect((await call("comment_search", { key: item.key, pattern: "REPORT-OF-" })).content[0]!.text).toContain("No comment");
        const thread = (await call("thread_read", { key: item.key })).content[0]!.text;
        expect(thread).toContain("Please check the header row too.");
        expect(thread).not.toContain("REPORT-OF-");
        expect((await call("item_detail", { key: item.key })).content[0]!.text).not.toContain("REPORT-OF-");
        // And it posts nothing on the item itself.
        const posted = await call("comment", { body: "My own finding." });
        expect(posted.isError).toBe(true);
        expect(posted.content[0]!.text).toContain("not served comment");
      } finally {
        server.close();
      }
    }
    // Every report reached the thread as the member's, posted by EO.
    expect(reports.every((report) => report.authorType === "agent")).toBe(true);
    expect(listTeamSessionsForItem(handle.db, item.id).map((record) => record.session.status)).toEqual(["finalized"]);
  });

  it("fails closed on a boundary the `eo` server cannot read: no thread rather than all of it", async () => {
    const server = (service as { createEoMcpService: (options: Record<string, unknown>) => { handle(request: unknown): Promise<{ result: { content: { text: string }[]; isError?: boolean } }>; close(): void } }).createEoMcpService({
      dbPath: join(scratch, "eo.db"),
      enableFullThread: true,
      writeBridge: { url: "http://127.0.0.1:1/agent-write", token: "t", teamMember: { itemId: item.id, visibleThrough: "later" } },
    });
    try {
      const read = (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "thread_read", arguments: { key: item.key } } })).result;
      expect(read.isError).toBe(true);
      expect(read.content[0]!.text).toContain("THREAD_UNREADABLE");
    } finally {
      server.close();
    }
  });
});

describe("an isolated team behaves as a team does (EO-867)", () => {
  it("supersedes and redoes a report made on content that moved before the team settled, each attempt in a copy of its own", async () => {
    setTeam(isolated([{ key: "own", role: "qa" }]));
    script = ({ nth }) =>
      (async function* () {
        yield { type: "thread_started", threadId: `t-${String(nth)}` } as AgentEvent;
        // A person rewrites what the item asks for while the first turn works.
        if (nth === 1) client().prepare("update items set body = ? where id = ?").run("Check the export, and its footer.", item.id);
        yield { type: "result", data: { outcome: "clear", report: `Report ${String(nth)}.` } } as AgentEvent;
      })();
    await supervisor().runOnce();
    expect(started).toHaveLength(2);
    expect(copies).toHaveLength(2);
    expect(copies[0]!.cwd).not.toBe(copies[1]!.cwd);
    expect(copies.every((copy) => copy.removed)).toBe(true);
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    const attempts = listTeamSessionsForItem(handle.db, item.id).at(-1)!.attempts;
    expect(attempts.filter((attempt) => attempt.supersededBy !== null)).toHaveLength(1);
  });

  it("stops every member with the team's run, its copy removed, and moves nothing", async () => {
    setTeam(isolated([{ key: "own", role: "qa" }]));
    script = ({ opts }) =>
      (async function* () {
        yield { type: "thread_started", threadId: "t-1" } as AgentEvent;
        await new Promise<void>((resolve) => (opts.signal.aborted ? resolve() : opts.signal.addEventListener("abort", () => resolve(), { once: true })));
        throw Object.assign(new Error("stopped"), { name: "AbortError" });
      })();
    const engine = supervisor();
    const done = engine.runOnce();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    const teamRun = listRunsForItem(handle.db, item.id).find((run) => run.action === "alignment")!;
    engine.cancelRun(teamRun.id);
    await done;
    await vi.waitFor(() => expect(copies[0]?.removed).toBe(true));
    expect(getItem(handle.db, item.id)?.stepId).toBe("check");
    expect(listRunsForItem(handle.db, item.id).find((run) => run.action === TEAM_PARTICIPANT_ACTION)?.status).toBe("cancelled");
  });

  it("runs a leader-led team's leader and members as their agents' ordinary turns; the leader reads the reports, the members none of the leader's turns", async () => {
    createAgent(handle.db, { name: "Sasha", role: "sec", provider: "claude", instructions: "You find ways in." });
    setTeam(
      StepTeamSchema.parse({
        coordination: "leader",
        members: "isolated",
        leader: { role: "qa", instructions: "Split the check by risk." },
        roles: ["sec"],
      }),
    );
    let quinnTurns = 0;
    script = ({ agent }) => {
      if (agent.name === "Sasha") return answer({ outcome: { report: "SASHA-REPORT: the login holds." } });
      quinnTurns += 1;
      if (quinnTurns === 1) return answer({ outcome: { decision: "assign", assignments: [{ key: "auth", role: "sec", instructions: "Look at the login.", required: true }], note: "One thing to check." } });
      const reportId = listTeamSessionsForItem(handle.db, item.id).at(-1)!.attempts.find((attempt) => attempt.assignmentKey === "auth" && attempt.status === "completed")!.reportCommentId!;
      return answer({ outcome: { decision: "final", answer: { result: "aligned", summary: "The login holds." }, contributions: [reportId], disagreements: "None.", limitations: "None." } });
    };
    await supervisor().runOnce();
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    expect(started.map((one) => one.agent.name)).toEqual(["Quinn", "Sasha", "Quinn"]);
    // Every turn on its agent's ordinary provider, its own instructions first.
    for (const one of started) {
      expect(one.provider).toBe(providers.get(one.agent.id));
      expect(one.opts.instructions.startsWith(`${one.agent.instructions}\n\n## Your part in a team`)).toBe(true);
      expect(one.opts.instructions).not.toContain("You are report-only");
    }
    expect(started[0]!.opts.context).toContain("## What you lead");
    expect(started[2]!.opts.context).toContain("SASHA-REPORT");
    expect(started[1]!.opts.context).not.toContain("One thing to check.");
    expect(copies).toHaveLength(3);
    expect(copies.every((copy) => copy.removed)).toBe(true);
  });
});

describe("an isolated member's skill usage (EO-867)", () => {
  function attachSkill(agent: Agent, name: string): string {
    const saved = saveSkill(handle.db, SkillDraftSchema.parse({ name, description: "A house playbook.", body: "Read the diff." }));
    if (!saved.ok) throw new Error(saved.problems.join("\n"));
    setAgentAttachment(handle.db, { agentId: agent.id, kind: "skill", id: saved.skill.id, attached: true });
    return saved.skill.id;
  }

  /** A turn that is given its agent's skill and loads it, then answers. */
  async function* withSkill(slug: string, data: unknown): AsyncGenerator<AgentEvent> {
    yield { type: "thread_started", threadId: `thread-${uuidv7()}` };
    yield { type: "skills_delivered", slugs: [slug] };
    yield { type: "skill_loaded", slug };
    yield { type: "result", data };
  }

  it("ends a leader's and a member's turn by agents with skills normally, settling each run's skills through its own buffer after its result", async () => {
    const sasha = createAgent(handle.db, { name: "Sasha", role: "sec", provider: "claude", instructions: "You find ways in." });
    const leaderSkill = attachSkill(quinn, "Leading");
    const memberSkill = attachSkill(sasha, "Probing");
    setTeam(
      StepTeamSchema.parse({
        coordination: "leader",
        members: "isolated",
        leader: { role: "qa", instructions: "Split the check by risk." },
        roles: ["sec"],
      }),
    );
    let quinnTurns = 0;
    script = ({ agent }) => {
      if (agent.name === "Sasha") return withSkill("probing", { outcome: { report: "SASHA-REPORT: the login holds." } });
      quinnTurns += 1;
      if (quinnTurns === 1) return withSkill("leading", { outcome: { decision: "assign", assignments: [{ key: "auth", role: "sec", instructions: "Look at the login.", required: true }], note: "One thing to check." } });
      const reportId = listTeamSessionsForItem(handle.db, item.id).at(-1)!.attempts.find((attempt) => attempt.assignmentKey === "auth" && attempt.status === "completed")!.reportCommentId!;
      return withSkill("leading", { outcome: { decision: "final", answer: { result: "aligned", summary: "The login holds." }, contributions: [reportId], disagreements: "None.", limitations: "None." } });
    };
    await supervisor().runOnce();

    // Every turn's answer was taken, at its first try.
    expect(started.map((one) => one.agent.name)).toEqual(["Quinn", "Sasha", "Quinn"]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    const attempts = listTeamSessionsForItem(handle.db, item.id).at(-1)!.attempts;
    expect(attempts.map((attempt) => attempt.error ?? null)).toEqual(attempts.map(() => null));

    const turns = listRunsForItem(handle.db, item.id).filter((run) => run.action === TEAM_PARTICIPANT_ACTION);
    expect(turns).toHaveLength(3);
    for (const run of turns) {
      const skillId = run.agentId === sasha.id ? memberSkill : leaderSkill;
      const events = listRunEvents(handle.db, run.id);
      const seqs = events.map((event) => event.seq);
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(events.filter((event) => event.type === "result")).toHaveLength(1);
      expect(events.filter((event) => event.type === SKILLS_SETTLED_EVENT)).toHaveLength(1);
      expect(events.at(-1)?.type).toBe(SKILLS_SETTLED_EVENT);
      expect(events.find((event) => event.type === SKILLS_DELIVERED_EVENT)?.payload).toMatchObject({ skillIds: [skillId] });
      expect(events.find((event) => event.type === SKILL_LOADED_EVENT)?.payload).toMatchObject({ skillId });
    }
  });
});
