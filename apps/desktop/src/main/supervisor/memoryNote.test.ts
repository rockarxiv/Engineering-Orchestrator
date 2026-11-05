import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FOLDER_KIND, MEMORY_NOTE_TOOL_NAME, type AgentEvent, type AgentProvider, type Item, type MemoryScope } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { addMemory, createProject, createRun, createWorkspace, getMemory, listCommentsForItem, listMemories, listRunsForItem, retireMemory } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
// @ts-expect-error — the service is plain JavaScript, deliberately: it ships
// unbundled because Codex spawns it by path.
import * as eoServer from "../mcp/eoServer.mjs";
import { eoMcpStdioConfig } from "../mcp/serviceConfig.js";
import { validImplementResult } from "../providers/fixtures.js";
import { toolResultEvent } from "../providers/toolResult.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * An agent writing to memory while it works (EO-479).
 *
 * As in `runAttachments.test.ts`, the `eo` server is the real service,
 * started in process with the environment `eoMcpStdioConfig` builds for
 * the turn; it hands the note over the agent write bridge to the
 * supervisor, which applies the rules, writes, and answers — and the
 * tool's answer is that answer (EO-543).
 */

interface EoService {
  tools: { name: string }[];
  handle(request: unknown): Promise<{ result: { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> } }>;
  close(): void;
}
const service = eoServer as {
  createEoMcpService(options: Record<string, unknown>): EoService;
  parseMemoryScopes(raw: unknown): unknown[];
};

interface NoteAnswer {
  ok: boolean;
  text: string;
  structured?: Record<string, unknown>;
}

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "eoServer.mjs");

describe("memory_note on a run", () => {
  let handle: DbHandle;
  let folder: string;
  let item: Item;
  let project: MemoryScope;
  let workspace: MemoryScope;
  let elsewhere: MemoryScope;
  let writes: TestWriteBridge;

  beforeEach(async () => {
    writes = await startTestWriteBridge();
    handle = openMigratedTestDb();
    folder = mkdtempSync(join(tmpdir(), "eo-memory-note-"));
    const w = createWorkspace(handle.db, { kind: FOLDER_KIND, config: { path: folder } });
    const p = createProject(handle.db, { name: "Payments", keyPrefix: "PAY", workspaceIds: [w.id] });
    const other = createWorkspace(handle.db, { kind: FOLDER_KIND, config: { path: folder } });
    createProject(handle.db, { name: "Other", keyPrefix: "OTH", workspaceIds: [other.id] });
    project = { kind: "project", id: p.id };
    workspace = { kind: "workspace", id: w.id };
    elsewhere = { kind: "workspace", id: other.id };
    item = createTestItem(handle.db, { type: "story", title: "Add CSV export", stepId: "todo", projectId: p.id, workspaceId: w.id });
  });

  afterEach(async () => {
    await writes.close();
    handle.close();
    rmSync(folder, { recursive: true, force: true });
  });

  /**
   * An agent granted `memory_note` that makes these calls, each answered
   * by the real service — or, with `forged`, by a backend that reports an
   * acceptance the service never gave: the shape EO once wrote from.
   */
  function notingAgent(calls: unknown[], options: { forged?: boolean; then?: (first: NoteAnswer) => Promise<unknown> } = {}) {
    const seen = { listed: false, answers: [] as NoteAnswer[] };
    const provider: AgentProvider = {
      async *start(opts): AsyncIterable<AgentEvent> {
        const env = eoMcpStdioConfig({
          serverPath,
          ...(opts.memoryScopes ? { memoryScopes: opts.memoryScopes } : {}),
          enableMemoryNote: true,
          ...(opts.writeBridge ? { writeBridge: opts.writeBridge } : {}),
        }).env;
        const eo = service.createEoMcpService({
          dbPath: undefined,
          memoryScopes: service.parseMemoryScopes(env["EO_MCP_MEMORY_SCOPES"]),
          enableMemoryNote: env["EO_MCP_MEMORY_NOTE_ENABLED"] === "1",
          writeBridge: env["EO_MCP_WRITE_BRIDGE"] === undefined ? null : JSON.parse(env["EO_MCP_WRITE_BRIDGE"]),
        });
        try {
          seen.listed = eo.tools.some((tool) => tool.name === MEMORY_NOTE_TOOL_NAME);
          yield { type: "thread_started", threadId: "thread-1" };
          for (const [index, args] of calls.entries()) {
            const callId = `call-${index}`;
            yield { type: "tool_call", name: MEMORY_NOTE_TOOL_NAME, args, callId };
            if (options.forged) {
              yield toolResultEvent({ name: MEMORY_NOTE_TOOL_NAME, callId, ok: true, output: "EO noted this." });
              continue;
            }
            const { result } = await eo.handle({ jsonrpc: "2.0", id: index, method: "tools/call", params: { name: MEMORY_NOTE_TOOL_NAME, arguments: args } });
            const text = result.content[0]?.text ?? "";
            seen.answers.push({ ok: result.isError !== true, text, ...(result.structuredContent ? { structured: result.structuredContent } : {}) });
            yield toolResultEvent({ name: MEMORY_NOTE_TOOL_NAME, callId, ok: result.isError !== true, output: text });
          }
          if (options.then) {
            const args = await options.then(seen.answers[0]!);
            await eo.handle({ jsonrpc: "2.0", id: calls.length, method: "tools/call", params: { name: MEMORY_NOTE_TOOL_NAME, arguments: args } });
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

  /** An agent that writes a note, reads the answer, and writes the next from it. */
  const notingAgentThen = (next: (first: NoteAnswer) => Promise<unknown>) => notingAgent([{ scope: "project", text: "Run pnpm install in a fresh worktree before running the tests." }], { then: next }).provider;

  const supervisorOver = (provider: AgentProvider) => {
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS, agentWriteBridge: writes.agentWriteBridge });
    writes.serve(supervisor);
    return supervisor;
  };
  const engineNotes = () => listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine");

  it("is offered on a run with memory, and a note to the project becomes an active entry sourced to the run and its item", async () => {
    const { provider, seen } = notingAgent([{ scope: "project", text: "Run pnpm install before the tests; the lockfile is checked." }]);

    await supervisorOver(provider).runOnce();

    expect(seen.listed).toBe(true);
    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(run.status).toBe("succeeded");
    const [entry] = listMemories(handle.db, project);
    // The answer is the write's: written before the tool answered, and
    // named in both of the answer's parts — Claude shows an agent only
    // the structured one (EO-543).
    const answer = `EO noted this in the memory of Project: Payments (scope ${project.id}). Later runs on other items are given it from now on. No active entry in that scope is close to it.`;
    expect(seen.answers).toEqual([{ ok: true, text: answer, structured: { entryId: entry?.id, scope: project, text: answer } }]);
    expect(listMemories(handle.db, project)).toEqual([
      expect.objectContaining({
        scope: project,
        body: "Run pnpm install before the tests; the lockfile is checked.",
        source: { type: "run", runId: run.id, itemId: item.id },
        retiredAt: null,
      }),
    ]);
    expect(engineNotes()).toEqual([]);
  });

  it("writes a note to the workspace the run works in, trimmed", async () => {
    const { provider } = notingAgent([{ scope: workspace.id, text: "  The fixtures live in ./fixtures.  " }]);

    await supervisorOver(provider).runOnce();

    expect(listMemories(handle.db, workspace).map((entry) => entry.body)).toEqual(["The fixtures live in ./fixtures."]);
    expect(listMemories(handle.db, project)).toEqual([]);
  });

  it("takes the project's own scope id for the project, as an agent shown it in its memory section writes it", async () => {
    const { provider, seen } = notingAgent([{ scope: project.id, text: "Settlements are reconciled at 02:00 UTC." }]);

    await supervisorOver(provider).runOnce();

    expect(seen.answers[0]?.ok).toBe(true);
    expect(listMemories(handle.db, project).map((entry) => entry.body)).toEqual(["Settlements are reconciled at 02:00 UTC."]);
  });

  it("refuses a workspace the run does not work in, with a sentence, and writes nothing", async () => {
    const { provider, seen } = notingAgent([{ scope: elsewhere.id, text: "Another project's workspace." }]);

    await supervisorOver(provider).runOnce();

    expect(seen.answers).toMatchObject([{ ok: false, text: expect.stringContaining(`"${elsewhere.id}" is not a scope this run works in, so nothing was written.`) }]);
    for (const scope of [project, workspace, elsewhere]) expect(listMemories(handle.db, scope, { includeRetired: true })).toEqual([]);
    // The tool said no and the agent heard it: nothing for EO to add.
    expect(engineNotes()).toEqual([]);
  });

  it("refuses a note longer than 1,000 characters, stating the limit, and writes nothing", async () => {
    const { provider, seen } = notingAgent([{ scope: "project", text: "x".repeat(1_001) }]);

    await supervisorOver(provider).runOnce();

    expect(seen.answers[0]).toMatchObject({ ok: false, text: expect.stringContaining("a note may be at most 1,000") });
    expect(listMemories(handle.db, project)).toEqual([]);
  });

  it("writes nothing for an acceptance the stream reports that never reached EO", async () => {
    // EO never infers a write from the event stream (EO-543): a backend
    // reporting "EO noted this" for a note it never handed over has
    // written nothing, and there is nothing for EO to say about it.
    const { provider } = notingAgent([{ scope: "project", text: "Reported, never sent." }], { forged: true });

    await supervisorOver(provider).runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
    for (const scope of [project, workspace, elsewhere]) expect(listMemories(handle.db, scope, { includeRetired: true })).toEqual([]);
    expect(engineNotes()).toEqual([]);
  });

  it("refuses a note made after its turn is over, and writes nothing", async () => {
    // A credential outlives the turn it was handed to only as far as the
    // process that minted it: no turn is being read, so nothing is made.
    const supervisor = supervisorOver(notingAgent([]).provider);
    await supervisor.runOnce();

    const answer = await supervisor.handleAgentWrite(item.id, { tool: MEMORY_NOTE_TOOL_NAME, args: { scope: "project", text: "Too late." } });

    expect(answer).toMatchObject({ ok: false, code: "NO_RUN" });
    expect(listMemories(handle.db, project)).toEqual([]);
  });

  /** An entry already in memory: an earlier run's on this item, or a person's. */
  function earlier(scope: MemoryScope, body: string, by: "agent" | "person") {
    const run = by === "agent" ? createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "succeeded" }) : null;
    const written = addMemory(handle.db, {
      scope,
      body,
      source: run === null ? { type: "person", personId: null } : { type: "run", runId: run.id, itemId: item.id },
      now: 1_000,
    });
    if (!written.ok) throw new Error(written.problem);
    return written.entry;
  }

  it("retires the agent-written entries a note replaces as superseded, and writes the note naming them (EO-594)", async () => {
    const gap = earlier(project, "Known gap: exports skip refunds.", "agent");
    const twice = earlier(workspace, "Exports skip refunds.", "agent");
    const { provider, seen } = notingAgent([{ scope: "project", text: "Exports include refunds since the export was reworked.", replaces: [gap.id, twice.id] }]);

    await supervisorOver(provider).runOnce();

    expect(seen.answers[0]?.ok).toBe(true);
    const [note] = listMemories(handle.db, project);
    expect(note?.body).toBe("Exports include refunds since the export was reworked.");
    for (const id of [gap.id, twice.id]) expect(getMemory(handle.db, id)).toMatchObject({ retiredReason: "superseded", retiredAt: note?.createdAt });
    expect(listMemories(handle.db, workspace)).toEqual([]);
  });

  describe("the entries closest to a note (EO-611)", () => {
    const BODY = "Run pnpm install in a fresh worktree before running the tests.";

    it("names each active one in the note's scope, with its id and body, closest first, and writes the note", async () => {
      const near = earlier(project, "A fresh worktree needs pnpm install before running anything.", "agent");
      const person = earlier(project, "Run pnpm install in a fresh worktree before the tests.", "person");
      earlier(project, "Settlements are compared in UTC.", "agent");
      earlier(workspace, BODY, "agent");
      const retired = earlier(project, BODY, "agent");
      retireMemory(handle.db, retired.id);
      const { provider, seen } = notingAgent([{ scope: "project", text: BODY }]);

      await supervisorOver(provider).runOnce();

      const note = listMemories(handle.db, project).find((entry) => entry.body === BODY)!;
      const text = seen.answers[0]!.text;
      expect(seen.answers[0]).toMatchObject({ ok: true, structured: { entryId: note.id, text } });
      expect(text).toContain(`- \`${person.id}\` (by a person): ${person.body}\n- \`${near.id}\`: ${near.body}\n`);
      expect(text).toContain(`\`replaces\` naming that id and \`${note.id}\``);
      expect(text).not.toContain(retired.id);
      expect(text).not.toContain("Settlements");
      expect(text).not.toContain("- `" + note.id);
    });

    it("shows a near entry and writes the note even where the two say the same thing", async () => {
      const same = earlier(project, BODY, "agent");
      const { provider, seen } = notingAgent([{ scope: "project", text: BODY }]);

      await supervisorOver(provider).runOnce();

      expect(seen.answers[0]?.text).toContain(`- \`${same.id}\`: ${BODY}`);
      expect(listMemories(handle.db, project).map((entry) => entry.body)).toEqual([BODY, BODY]);
    });

    it("leaves one note, and retires what it repeats as superseded, when the agent writes again as the answer says", async () => {
      const same = earlier(project, "Run pnpm install in a fresh worktree before the tests.", "agent");
      const supervisor = supervisorOver(
        notingAgentThen(async (first) => {
          const noteId = first.structured!["entryId"] as string;
          return { scope: "project", text: BODY, replaces: [same.id, noteId] };
        }),
      );

      await supervisor.runOnce();

      expect(listMemories(handle.db, project).map((entry) => entry.body)).toEqual([BODY]);
      expect(getMemory(handle.db, same.id)).toMatchObject({ retiredReason: "superseded" });
    });

    it("shows a person's entry, and refuses a note that then names it, retiring nothing", async () => {
      const person = earlier(project, BODY, "person");
      const { provider, seen } = notingAgent([
        { scope: "project", text: BODY },
        { scope: "project", text: BODY, replaces: [person.id] },
      ]);

      await supervisorOver(provider).runOnce();

      expect(seen.answers[0]?.text).toContain(`- \`${person.id}\` (by a person): ${BODY}`);
      expect(seen.answers[1]).toMatchObject({ ok: false, text: expect.stringContaining("a note never replaces a person's entry") });
      expect(getMemory(handle.db, person.id)?.retiredAt).toBeNull();
    });
  });

  it("refuses a note naming a person's entry, or one in a scope the run does not work in, and writes and retires nothing (EO-594)", async () => {
    const agents = earlier(project, "An agent's fact.", "agent");
    const persons = earlier(project, "A person's fact.", "person");
    const outside = earlier(elsewhere, "Another project's fact.", "agent");
    const { provider, seen } = notingAgent([
      { scope: "project", text: "A correction.", replaces: [agents.id, persons.id] },
      { scope: "project", text: "A correction.", replaces: [agents.id, outside.id] },
    ]);

    await supervisorOver(provider).runOnce();

    expect(seen.answers).toMatchObject([
      { ok: false, text: expect.stringContaining("a note never replaces a person's entry") },
      { ok: false, text: expect.stringContaining("not in a scope this run works in") },
    ]);
    expect(listMemories(handle.db, project).map((entry) => entry.id).sort()).toEqual([agents.id, persons.id].sort());
    expect(getMemory(handle.db, outside.id)?.retiredAt).toBeNull();
  });
});
