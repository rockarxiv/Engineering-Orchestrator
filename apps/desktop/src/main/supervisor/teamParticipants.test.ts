import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLDER_KIND, StepTeamSchema, TEAM_EVIDENCE_TOOLS, uuidv7, type AgentWriteBridgeAddress, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createAgent } from "../db/repos/agentsRepo.js";
import { insertAttachments } from "../db/repos/attachmentsRepo.js";
import { listCommentsForItem, postComment } from "../db/repos/commentsRepo.js";
import { createRun, updateRun } from "../db/repos/runsRepo.js";
import { openTeamSession, startTeamAttempt } from "../db/repos/teamSessionsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
// @ts-expect-error — the service is plain JavaScript, deliberately: it ships
// unbundled because Codex spawns it by path.
import * as eoServer from "../mcp/eoServer.mjs";
import { startAgentWriteBridge, type AgentWriteBridge } from "../mcp/writeBridge.js";
import { folderEvidenceCapability } from "./folderEvidence.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { captureTeamEvidence, type TeamEvidence } from "./teamEvidence.js";
import {
  answerTeamCall,
  createTeamParticipantScopes,
  firstPassBoundary,
  participantResumeProblem,
  participantThread,
  participantThreadToResume,
  reportOnlyCredential,
  type TeamParticipantScopes,
} from "./teamParticipants.js";
import type { PreparedWorkspace, WorkspaceKind } from "./workspaceKind.js";

/**
 * Report-only participants, answered by EO (EO-845): through the `eo`
 * server a participant's turn starts and the bridge it hands calls to,
 * each from its own attempt's evidence and its own view of the thread.
 */

interface EoService {
  tools: { name: string }[];
  handle(request: unknown): Promise<{ result: { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> } }>;
  close(): void;
}
const service = eoServer as unknown as { createEoMcpService(options: Record<string, unknown>): EoService };

let handle: DbHandle;
let item: Item;
let bridge: AgentWriteBridge;
let scopes: TeamParticipantScopes;
const scratch: string[] = [];
function directory(): string {
  const made = mkdtempSync(join(tmpdir(), "eo-team-participants-"));
  scratch.push(made);
  return made;
}

const TEAM = StepTeamSchema.parse({
  coordination: "independent",
  participants: [
    { key: "security", role: "reviewer", instructions: "Look for ways in." },
    { key: "clarity", role: "reviewer", instructions: "Read it as a newcomer." },
  ],
  outcomes: [{ key: "clear", label: "Nothing found" }],
  completion: { rules: [], fallback: "approved" },
});

beforeEach(async () => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "Review the quarterly report", stepId: "todo" });
  scopes = createTeamParticipantScopes();
  bridge = await startAgentWriteBridge((itemId, request, writes, scope) =>
    scope !== null && scope !== undefined && writes !== null && writes !== undefined
      ? answerTeamCall(handle.db, scopes, itemId, request, writes, scope)
      : Promise.resolve({ ok: false, code: "NOT_A_PARTICIPANT", problem: "Not a participant's credential." }),
  );
});

afterEach(async () => {
  await bridge.close();
  handle.close();
  for (const made of scratch.splice(0)) rmSync(made, { recursive: true, force: true });
});

/** The `eo` server a participant's turn starts, from the address it is handed. */
function participantServer(address: AgentWriteBridgeAddress): EoService {
  return service.createEoMcpService({ dbPath: undefined, enableCommentTool: true, enableFullThread: true, writeBridge: JSON.parse(JSON.stringify(address)) });
}

async function call(eo: EoService, name: string, args: Record<string, unknown> = {}) {
  const { result } = await eo.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return { ok: result.isError !== true, text: result.content.map((part) => part.text ?? "").join("") };
}

async function folderEvidence(files: Record<string, string>): Promise<TeamEvidence> {
  const folder = directory();
  for (const [name, content] of Object.entries(files)) writeFileSync(join(folder, name), content);
  const kind = { slug: FOLDER_KIND, evidence: folderEvidenceCapability(directory()) } as unknown as WorkspaceKind;
  const captured = await captureTeamEvidence({ db: handle.db, item, workspace: { kind, prepared: { cwd: folder, kind: FOLDER_KIND, workspaceId: null } as PreparedWorkspace } });
  if (!captured.ok) throw new Error(captured.problem);
  return captured.evidence;
}

describe("a report-only participant's tools", () => {
  it("are the only ones its `eo` server lists, and read its files and attachments without a shell or a repository index", async () => {
    const stored = join(directory(), "brief.md");
    writeFileSync(stored, "# Brief\nCheck the totals add up.\n");
    insertAttachments(handle.db, [{ id: uuidv7() as Uuid, itemId: item.id, commentId: null, storagePath: stored, name: "brief.md", mimeType: "text/markdown", size: 32 }]);
    const evidence = await folderEvidence({ "report.md": "Revenue: 10\nCosts: 4\nProfit: 6\n" });
    const attemptId = uuidv7();
    scopes.register({ attemptId, itemId: item.id, evidence, thread: firstPassBoundary(evidence) });
    const eo = participantServer(reportOnlyCredential(bridge, item.id, attemptId));

    expect(eo.tools.map((tool) => tool.name).sort()).toEqual([...TEAM_EVIDENCE_TOOLS].sort());
    expect((await call(eo, "evidence_list")).text).toContain("report.md");
    expect((await call(eo, "evidence_read", { path: "report.md", startLine: 2, lineCount: 1 })).text).toContain("2\tCosts: 4");
    expect((await call(eo, "evidence_search", { text: "profit", ignoreCase: true })).text).toContain("report.md:3: Profit: 6");
    expect((await call(eo, "evidence_list", { source: "attachments" })).text).toContain("brief.md");
    expect((await call(eo, "evidence_read", { source: "attachments", path: "brief.md" })).text).toContain("Check the totals add up.");
    expect((await call(eo, "item_context")).text).toContain("Review the quarterly report");
  });

  it("refuse a path that steps out of what was captured, or a link out of it", async () => {
    const outside = directory();
    writeFileSync(join(outside, "secret.txt"), "the secret\n");
    const folder = directory();
    writeFileSync(join(folder, "a.txt"), "a\n");
    symlinkSync(join(outside, "secret.txt"), join(folder, "link.txt"));
    const kind = { slug: FOLDER_KIND, evidence: folderEvidenceCapability(directory()) } as unknown as WorkspaceKind;
    const captured = await captureTeamEvidence({ db: handle.db, item, workspace: { kind, prepared: { cwd: folder, kind: FOLDER_KIND, workspaceId: null } as PreparedWorkspace } });
    if (!captured.ok) throw new Error(captured.problem);
    const attemptId = uuidv7();
    scopes.register({ attemptId, itemId: item.id, evidence: captured.evidence, thread: firstPassBoundary(captured.evidence) });
    const eo = participantServer(reportOnlyCredential(bridge, item.id, attemptId));
    for (const path of ["../secret.txt", join(outside, "secret.txt"), "link.txt", "a.txt/../../secret.txt"]) {
      const read = await call(eo, "evidence_read", { path });
      expect(read.ok, path).toBe(false);
      expect(read.text).not.toContain("the secret");
    }
    expect((await call(eo, "evidence_list", { path: ".." })).ok).toBe(false);
  });

  it("refuse every other tool on the participant's server, and the bridge refuses any other write on its credential", async () => {
    const evidence = await folderEvidence({ "a.txt": "a\n" });
    const attemptId = uuidv7();
    scopes.register({ attemptId, itemId: item.id, evidence, thread: firstPassBoundary(evidence) });
    const address = reportOnlyCredential(bridge, item.id, attemptId);
    const eo = participantServer(address);
    for (const name of ["comment", "item_detail", "ticket_detail", "comment_read", "comment_search", "thread_read", "attachment_read", "attachment_add", "memory_note", "memory_read", "skill_patch", "repository_checkout", "pipeline_list", "agent_save"]) {
      const refused = await call(eo, name, { itemId: item.id, commentId: "x", body: "hi", key: item.key });
      expect(refused.ok, name).toBe(false);
      expect(refused.text, name).toContain("report-only team participant");
    }
    // Straight to the bridge, past the server: a comment on this credential is refused.
    const posted = await fetch(address.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${address.token}` }, body: JSON.stringify({ tool: "comment", args: { body: "@user hi" } }) });
    expect(((await posted.json()) as { ok: boolean; code: string }).code).toBe("TOOL_NOT_SERVED");
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
  });

  it("fails closed on a report-only address it cannot read: no ordinary tool comes back", async () => {
    const eo = service.createEoMcpService({ dbPath: undefined, enableCommentTool: true, writeBridge: { reportOnly: true } });
    expect(eo.tools.map((tool) => tool.name).sort()).toEqual([...TEAM_EVIDENCE_TOOLS].sort());
    expect((await call(eo, "comment", { body: "hi" })).ok).toBe(false);
    expect((await call(eo, "evidence_list")).ok).toBe(false);
  });

  it("answer each attempt from its own scope: one participant's credential cannot be presented as a sibling's", async () => {
    const mine = await folderEvidence({ "mine.txt": "mine\n" });
    const theirs = await folderEvidence({ "theirs.txt": "theirs\n" });
    const me = uuidv7();
    const sibling = uuidv7();
    scopes.register({ attemptId: me, itemId: item.id, evidence: mine, thread: firstPassBoundary(mine) });
    scopes.register({ attemptId: sibling, itemId: item.id, evidence: theirs, thread: firstPassBoundary(theirs) });
    const address = reportOnlyCredential(bridge, item.id, me);
    expect((await call(participantServer(address), "evidence_read", { path: "theirs.txt" })).ok).toBe(false);
    // A credential whose scope is rewritten fails its MAC.
    const forged = { ...address, token: address.token.replace(me, sibling) };
    const answered = await call(participantServer(forged), "evidence_read", { path: "theirs.txt" });
    expect(answered.ok).toBe(false);
    expect(answered.text).toContain("UNRECOGNISED_CREDENTIAL");
    // And a scope nobody registered, or one on another item, reads nothing.
    expect((await answerTeamCall(handle.db, scopes, item.id, { tool: "evidence_list", args: {} }, TEAM_EVIDENCE_TOOLS, uuidv7())).ok).toBe(false);
    expect((await answerTeamCall(handle.db, scopes, uuidv7(), { tool: "evidence_list", args: {} }, TEAM_EVIDENCE_TOOLS, me)).ok).toBe(false);
  });
});

describe("a first pass's view of the thread", () => {
  it("is the same for every participant, holds no sibling's later report, and a later round can show one by name", async () => {
    const reviewer = createAgent(handle.db, { name: "Rita", role: "reviewer", provider: "fake", model: null, instructions: "Review." }).id as Uuid;
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Focus on the totals.", createdAt: 1_000 });
    const folder = directory();
    writeFileSync(join(folder, "a.txt"), "a\n");
    const kind = { slug: FOLDER_KIND, evidence: folderEvidenceCapability(directory()) } as unknown as WorkspaceKind;
    const captured = await captureTeamEvidence({ db: handle.db, item, workspace: { kind, prepared: { cwd: folder, kind: FOLDER_KIND, workspaceId: null } as PreparedWorkspace }, now: 2_000 });
    if (!captured.ok) throw new Error(captured.problem);
    const evidence = captured.evidence;
    const first = uuidv7();
    const second = uuidv7();
    scopes.register({ attemptId: first, itemId: item.id, evidence, thread: firstPassBoundary(evidence) });
    scopes.register({ attemptId: second, itemId: item.id, evidence, thread: firstPassBoundary(evidence) });

    // The second participant reports before the first has read the thread.
    const report = postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: reviewer }, body: "SIBLING-CONCLUSION: the totals are wrong.", createdAt: 3_000 });
    // The person sees it at once.
    expect(listCommentsForItem(handle.db, item.id).map((comment) => comment.body)).toContain(report.body);

    const firstView = await call(participantServer(reportOnlyCredential(bridge, item.id, first)), "item_context");
    const secondView = await call(participantServer(reportOnlyCredential(bridge, item.id, second)), "item_context");
    expect(firstView.text).toContain("Focus on the totals.");
    expect(firstView.text).not.toContain("SIBLING-CONCLUSION");
    expect(firstView.text).toBe(secondView.text);
    // No other route reaches it: the thread tools are refused on the participant's server.
    for (const name of ["comment_search", "comment_read", "thread_read", "item_detail"]) {
      const answered = await call(participantServer(reportOnlyCredential(bridge, item.id, first)), name, { key: item.key, pattern: "SIBLING", commentId: report.id });
      expect(answered.text, name).not.toContain("SIBLING-CONCLUSION");
    }

    // A later coordination round shows it, explicitly.
    const later = uuidv7();
    scopes.register({ attemptId: later, itemId: item.id, evidence, thread: { visibleThrough: evidence.ref.capturedAt, exposedCommentIds: [report.id] } });
    expect((await call(participantServer(reportOnlyCredential(bridge, item.id, later)), "item_context")).text).toContain("SIBLING-CONCLUSION");
    expect(participantThread(handle.db, item.id, firstPassBoundary(evidence)).map((comment) => comment.id)).not.toContain(report.id);
  });
});

describe("a participant's provider thread", () => {
  it("is its own attempt's: two attempts of one agent never resume each other's", () => {
    const reviewer = createAgent(handle.db, { name: "Rita", role: "reviewer", provider: "fake", model: null, instructions: "Review." }).id as Uuid;
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM });
    const attempt = (key: string, thread: string) => {
      const run = createRun(handle.db, { itemId: item.id, agentId: reviewer, action: "review", stepId: "todo", status: "running" });
      updateRun(handle.db, run.id, { threadId: thread });
      const started = startTeamAttempt(handle.db, { sessionId: session.id, assignmentKey: key, role: "reviewer", agentId: reviewer, instructions: "Go.", runId: run.id });
      if (!started.ok) throw new Error(started.problem);
      return started.attempt.id;
    };
    const security = attempt("security", "thread-security");
    const clarity = attempt("clarity", "thread-clarity");
    expect(participantThreadToResume(handle.db, security)).toBe("thread-security");
    expect(participantThreadToResume(handle.db, clarity)).toBe("thread-clarity");
    expect(participantResumeProblem(handle.db, security, "thread-security")).toBeNull();
    expect(participantResumeProblem(handle.db, security, "thread-clarity")).toContain("not this participant's attempt's own");
    expect(participantResumeProblem(handle.db, uuidv7(), "thread-clarity")).not.toBeNull();
  });
});

describe("the supervisor's bridge", () => {
  it("answers a participant's credential from its registered scope, and no other credential is served the evidence tools", async () => {
    const evidence = await folderEvidence({ "a.txt": "from the scope\n" });
    const attemptId = uuidv7();
    scopes.register({ attemptId, itemId: item.id, evidence, thread: firstPassBoundary(evidence) });
    const supervisor = createRunSupervisor({ db: handle.db, provider: { start: () => (async function* () {})(), resume: () => (async function* () {})() } as never, limits: { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 }, teamParticipants: scopes });
    const read = await supervisor.handleAgentWrite(item.id, { tool: "evidence_read", args: { path: "a.txt" } }, TEAM_EVIDENCE_TOOLS, attemptId);
    expect(read.ok && read.text).toContain("from the scope");
    const ordinary = await supervisor.handleAgentWrite(item.id, { tool: "evidence_read", args: { path: "a.txt" } });
    expect(!ordinary.ok && ordinary.code).toBe("TOOL_NOT_SERVED");
    const comment = await supervisor.handleAgentWrite(item.id, { tool: "comment", args: { body: "hi" } }, TEAM_EVIDENCE_TOOLS, attemptId);
    expect(!comment.ok && comment.code).toBe("TOOL_NOT_SERVED");
  });
});
