import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLDER_KIND, MEMORY_DELIVERED_EVENT, MEMORY_USED_EVENT, MEMORY_NOTE_DEFINITION, MEMORY_NOTE_TOOL_NAME, memoryNoteEnabled, type Agent, type AgentEvent, type AgentProvider, type AgentProviderStartOptions, type Item, type MemoryScope, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { addMemory, appendRunEvent, memoryDeliveredToRun, createProject, createRun, createStep, createWorkspace, deleteItem, getRun, listAgents, listCommentsForItem, listMemories, postComment, listRunEvents, listRunsForItem, listSideCalls, retireMemory, updateAgent, updateItem, updateRun } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listAgentDetails, saveAgent } from "../ipc/configCommands.js";
import { listMemoryCommand, searchMemoryCommand } from "../ipc/memoryCommands.js";
import { listRuns } from "../ipc/runAnalysis.js";
// @ts-expect-error — the service is plain JavaScript, deliberately: it ships
// unbundled because Codex spawns it by path.
import * as eoServer from "../mcp/eoServer.mjs";
import { eoMcpStdioConfig } from "../mcp/serviceConfig.js";
import { MEMORY_SECTION_HEADING } from "../memory/selection.js";
import { MEMORY_WRITING_SECTION_HEADING, renderMemoryWritingSection } from "../memory/writing.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
import { createRunSupervisor, type RunSupervisorOptions } from "./runSupervisor.js";

const service = eoServer as {
  createEoMcpService(options: Record<string, unknown>): { tools: { name: string }[]; close(): void };
  parseMemoryScopes(raw: unknown): unknown[];
};

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

/**
 * Memory, delivered by a real dispatch (EO-478): the section in what the
 * backend is sent, the scopes `memory_read` is told, the selection made
 * inside the run, and the run's record of what it was given.
 */
describe("memory on a dispatch", () => {
  let handle: DbHandle;
  let folder: string;
  let item: Item;
  let project: MemoryScope;
  let workspace: MemoryScope;
  let elsewhere: MemoryScope;
  let writes: TestWriteBridge;

  beforeEach(async () => {
    // Where an agent's comment reaches EO (EO-543): a run parks only on a
    // blocking comment posted over it, and a reply needs a parked run.
    writes = await startTestWriteBridge();
    handle = openMigratedTestDb();
    folder = mkdtempSync(join(tmpdir(), "eo-memory-dispatch-"));
    // A folder workspace: a core kind, so the step really works in it
    // without the developer pack installed.
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

  function remember(scope: MemoryScope, body: string, now = Date.now()): string {
    const written = addMemory(handle.db, { scope, body, source: { type: "person", personId: null }, now });
    if (!written.ok) throw new Error(written.problem);
    return written.entry.id;
  }

  /** The fake backend, recording what each turn was started with. */
  function capturing() {
    const fake = createFakeProvider({ result: validImplementResult });
    const starts: AgentProviderStartOptions[] = [];
    const provider: AgentProvider = {
      ...fake,
      start(opts) {
        starts.push(opts);
        return fake.start(opts);
      },
    };
    return { provider, starts };
  }

  function supervisorWith(provider: AgentProvider, sideCalls?: RunSupervisorOptions["sideCalls"]) {
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS, agentWriteBridge: writes.agentWriteBridge, ...(sideCalls ? { sideCalls } : {}) });
    writes.serve(supervisor);
    return supervisor;
  }

  function memoryEvents() {
    const runId = listRunsForItem(handle.db, item.id)[0]!.id;
    return listRunEvents(handle.db, runId).filter((event) => event.type === MEMORY_DELIVERED_EVENT).map((event) => event.payload);
  }

  it("sends the section with P's and W's active entries, tells memory_read those scopes, and records what was delivered", async () => {
    const p = remember(project, "Settlements are in UTC.");
    const w = remember(workspace, "The fixtures live in ./fixtures.");
    remember(elsewhere, "Another project's workspace.");
    retireMemory(handle.db, remember(project, "A retired entry."));
    const { provider, starts } = capturing();

    await supervisorWith(provider).runOnce();

    expect(starts).toHaveLength(1);
    const context = starts[0]!.context;
    expect(context).toContain("## Memory");
    expect(context).toContain("Settlements are in UTC.");
    expect(context).toContain("The fixtures live in ./fixtures.");
    expect(context).not.toContain("Another project's workspace.");
    expect(context).not.toContain("A retired entry.");
    expect(starts[0]!.memoryScopes).toEqual([
      { ...project, name: "Payments" },
      { ...workspace, name: folder },
    ]);
    expect(memoryEvents()).toEqual([{ type: MEMORY_DELIVERED_EVENT, entryIds: [w, p], candidateCount: 2, mode: "all", selectionRan: false, reason: null }]);
    // Small enough to give whole: nothing was asked.
    expect(listSideCalls(handle.db)).toEqual([]);
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
  });

  it("over the threshold, selects inside the run being dispatched and sends only what was picked", async () => {
    const ids = Array.from({ length: 10 }, (_, index) => remember(index % 2 ? workspace : project, `Entry ${index}. ${"z".repeat(600)}`, 1_000 + index));
    const selected = vi.fn();
    const sideCallProvider: AgentProvider = {
      ...createFakeProvider({}),
      async *sideCall(options) {
        selected(options.input);
        yield { type: "result", data: { ids: [ids[4], ids[7]] } } satisfies AgentEvent;
      },
    };
    const { provider, starts } = capturing();

    await supervisorWith(provider, { provider: () => sideCallProvider, smallModel: async () => null }).runOnce();

    expect(selected).toHaveBeenCalledTimes(1);
    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(listSideCalls(handle.db)).toEqual([expect.objectContaining({ purpose: "memory_select", runId: run.id, itemId: item.id, outcome: "succeeded" })]);
    const context = starts[0]!.context;
    expect(context).toContain("Entry 4.");
    expect(context).toContain("Entry 7.");
    expect(context).not.toContain("Entry 5.");
    expect(memoryEvents()).toEqual([expect.objectContaining({ entryIds: [ids[7], ids[4]], mode: "selected", selectionRan: true, candidateCount: 10 })]);
    expect(run.status).toBe("succeeded");
  });

  it("when the selection fails, sends the newest entries with a line saying selection did not run, and the run proceeds", async () => {
    Array.from({ length: 10 }, (_, index) => remember(project, `Entry ${index}. ${"z".repeat(1_500)}`, 1_000 + index));
    const { provider, starts } = capturing();

    // No side-call provider at all: the call fails, saying the backend makes none.
    await supervisorWith(provider).runOnce();

    const context = starts[0]!.context;
    expect(context).toContain("Selection did not run for this dispatch");
    expect(context).toContain("Entry 9.");
    expect(context).toContain("Entry 8.");
    expect(context).not.toContain("Entry 7.");
    expect(memoryEvents()).toEqual([expect.objectContaining({ mode: "fallback", selectionRan: false, reason: expect.stringMatching(/^error:/) })]);
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
  });

  it("closes the run unstarted, and says so, when EO is paused while the selection runs", async () => {
    Array.from({ length: 10 }, (_, index) => remember(project, `Entry ${index}. ${"z".repeat(1_500)}`, 1_000 + index));
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const entered = vi.fn();
    const sideCallProvider: AgentProvider = {
      ...createFakeProvider({}),
      async *sideCall() {
        entered();
        await answered;
        yield { type: "result", data: { ids: [] } } satisfies AgentEvent;
      },
    };
    const { provider, starts } = capturing();
    const supervisor = supervisorWith(provider, { provider: () => sideCallProvider, smallModel: async () => null });

    const tick = supervisor.runOnce();
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    supervisor.pause();
    answer();
    await tick;

    expect(starts).toEqual([]);
    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(run.status).toBe("cancelled");
    expect(run.error).toContain("EO was paused while the memory");
    expect(listCommentsForItem(handle.db, item.id).at(-1)?.body).toContain("so the run was not started");
  });

  it("starts no backend, and closes the run as EO's quitting, when EO shuts down while the selection runs", async () => {
    Array.from({ length: 10 }, (_, index) => remember(project, `Entry ${index}. ${"z".repeat(1_500)}`, 1_000 + index));
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const entered = vi.fn();
    const sideCallProvider: AgentProvider = {
      ...createFakeProvider({}),
      async *sideCall() {
        entered();
        await answered;
        yield { type: "result", data: { ids: [] } } satisfies AgentEvent;
      },
    };
    const { provider, starts } = capturing();
    const supervisor = supervisorWith(provider, { provider: () => sideCallProvider, smallModel: async () => null });

    const tick = supervisor.runOnce();
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    const quitting = supervisor.shutdown();
    answer();
    await Promise.all([tick, quitting]);

    expect(starts).toEqual([]);
    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(run.status).toBe("cancelled");
    expect(run.interruption).toBe("quit");
    expect(run.error).toContain("stopped when EO was closed");
  });

  it("does not deliver an entry retired while the selection ran, whether it was picked or would have been the newest", async () => {
    const picked = remember(project, `picked-and-retired ${"x".repeat(3_000)}`, 3_000);
    const kept = remember(project, `picked-and-kept ${"y".repeat(3_000)}`, 2_000);
    const sideCallProvider: AgentProvider = {
      ...createFakeProvider({}),
      async *sideCall() {
        retireMemory(handle.db, picked);
        yield { type: "result", data: { ids: [picked, kept] } } satisfies AgentEvent;
      },
    };
    const selecting = capturing();
    await supervisorWith(selecting.provider, { provider: () => sideCallProvider, smallModel: async () => null }).runOnce();

    expect(selecting.starts[0]!.context).not.toContain("picked-and-retired");
    expect(selecting.starts[0]!.context).toContain("picked-and-kept");
    expect(memoryEvents()).toEqual([expect.objectContaining({ entryIds: [kept], mode: "selected" })]);
  });

  it("does not deliver an entry retired while a selection that then failed ran", async () => {
    const newest = remember(project, `newest-but-retired ${"x".repeat(3_000)}`, 3_000);
    remember(project, `next-newest ${"y".repeat(3_000)}`, 2_000);
    const sideCallProvider: AgentProvider = {
      ...createFakeProvider({}),
      async *sideCall() {
        retireMemory(handle.db, newest);
        yield { type: "error", message: "it failed", retryable: false } satisfies AgentEvent;
      },
    };
    const { provider, starts } = capturing();
    await supervisorWith(provider, { provider: () => sideCallProvider, smallModel: async () => null }).runOnce();

    expect(starts[0]!.context).toContain("Selection did not run");
    expect(starts[0]!.context).not.toContain("newest-but-retired");
    expect(starts[0]!.context).toContain("next-newest");
  });

  /**
   * A run that parks on a question, and a backend that records what each
   * reply turn was sent (EO-478 review): a person's reply to a parked run
   * is a new run, and is given memory as it stands then.
   */
  function parking() {
    const fake = createFakeProvider({ steps: [{ toolCall: { name: "comment", args: { body: "@user need input", mentions: ["user"], blocking: true } } }, { output: "continuing" }], result: validImplementResult });
    const replies: { message: string; memoryScopes: unknown }[] = [];
    const provider: AgentProvider = {
      ...fake,
      resume(threadId, message, opts) {
        replies.push({ message, memoryScopes: opts?.memoryScopes });
        return fake.resume(threadId, message, opts);
      },
    };
    return { provider, replies };
  }

  function replyRun() {
    return listRunsForItem(handle.db, item.id).at(-1)!;
  }

  it("gives a reply to a parked run the memory as it stands now, and records it on the reply's run", async () => {
    const { provider, replies } = parking();
    const supervisor = supervisorWith(provider);
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");

    const added = remember(project, "WRITTEN-WHILE-PARKED");
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "go ahead" });
    await supervisor.resumeItem(item.id);

    expect(replies).toHaveLength(1);
    expect(replies[0]!.message).toContain("## Memory");
    expect(replies[0]!.message).toContain("WRITTEN-WHILE-PARKED");
    expect(replies[0]!.memoryScopes).toEqual([
      { ...project, name: "Payments" },
      { ...workspace, name: folder },
    ]);
    const run = replyRun();
    const events = listRunEvents(handle.db, run.id).filter((event) => event.type === MEMORY_DELIVERED_EVENT).map((event) => event.payload);
    expect(events).toEqual([{ type: MEMORY_DELIVERED_EVENT, entryIds: [added], candidateCount: 1, mode: "all", selectionRan: false, reason: null }]);
    expect(listSideCalls(handle.db)).toEqual([]);
  });

  it("selects a reply's memory inside the reply's run when there is more than the threshold, and sends only what was picked", async () => {
    const { provider, replies } = parking();
    const selected = vi.fn();
    let ids: string[] = [];
    const sideCallProvider: AgentProvider = {
      ...createFakeProvider({}),
      async *sideCall(options) {
        selected(options.input);
        yield { type: "result", data: { ids: [ids[3]] } } satisfies AgentEvent;
      },
    };
    const supervisor = supervisorWith(provider, { provider: () => sideCallProvider, smallModel: async () => null });
    await supervisor.runOnce();
    expect(selected).not.toHaveBeenCalled();

    ids = Array.from({ length: 6 }, (_, index) => remember(project, `Reply entry ${index}. ${"z".repeat(1_500)}`, 1_000 + index));
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "use the ledger writer" });
    await supervisor.resumeItem(item.id);

    expect(selected).toHaveBeenCalledTimes(1);
    expect(selected.mock.calls[0]![0]).toContain("use the ledger writer");
    const run = replyRun();
    expect(listSideCalls(handle.db)).toEqual([expect.objectContaining({ purpose: "memory_select", runId: run.id, outcome: "succeeded" })]);
    expect(replies[0]!.message).toContain("Reply entry 3.");
    expect(replies[0]!.message).not.toContain("Reply entry 4.");
    const events = listRunEvents(handle.db, run.id).filter((event) => event.type === MEMORY_DELIVERED_EVENT).map((event) => event.payload);
    expect(events).toEqual([expect.objectContaining({ entryIds: [ids[3]], mode: "selected", selectionRan: true })]);
  });

  it("does not resume a parked run's backend, and closes the reply's run, when EO is paused while its selection runs", async () => {
    const { provider, replies } = parking();
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const entered = vi.fn();
    const sideCallProvider: AgentProvider = {
      ...createFakeProvider({}),
      async *sideCall() {
        entered();
        await answered;
        yield { type: "result", data: { ids: [] } } satisfies AgentEvent;
      },
    };
    const supervisor = supervisorWith(provider, { provider: () => sideCallProvider, smallModel: async () => null });
    await supervisor.runOnce();

    Array.from({ length: 6 }, (_, index) => remember(project, `Entry ${index}. ${"z".repeat(1_500)}`, 1_000 + index));
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "go ahead" });
    const replying = supervisor.resumeItem(item.id);
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    supervisor.pause();
    answer();
    await replying;

    expect(replies).toEqual([]);
    expect(replyRun().status).toBe("cancelled");
    expect(replyRun().error).toContain("EO was paused while the memory");
  });

  /**
   * Whether what a run was given was used (EO-597): the answer's
   * `memoryUsed`, held to the run's own `memory_delivered` ids, recorded
   * as `memory_used`, and counted per run and per entry.
   */
  it("keeps the memoryUsed ids the run was given, records the others as dropped, and counts both per run and per entry", async () => {
    const used = remember(project, "Settlements are in UTC.");
    const unused = remember(workspace, "The fixtures live in ./fixtures.");
    const notGiven = remember(elsewhere, "Another project's workspace.");
    const fake = createFakeProvider({ result: { ...validImplementResult, memoryUsed: [used, notGiven, "no-such-entry"] } });

    await supervisorWith(fake).runOnce();

    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(run.status).toBe("succeeded");
    const events = listRunEvents(handle.db, run.id).filter((event) => event.type === MEMORY_USED_EVENT).map((event) => event.payload);
    expect(events).toEqual([{ type: MEMORY_USED_EVENT, entryIds: [used], droppedIds: [notGiven, "no-such-entry"] }]);
    // The engine acts on what was kept; what the agent said stays in `raw`.
    const result = getRun(handle.db, run.id)?.result as { raw: { memoryUsed: string[] }; parsed: { memoryUsed: string[] } };
    expect(result.parsed.memoryUsed).toEqual([used]);
    expect(result.raw.memoryUsed).toEqual([used, notGiven, "no-such-entry"]);

    const listed = listRuns(handle.db, { itemId: item.id }).runs.find((record) => record.id === run.id)!;
    expect({ delivered: listed.memoryDelivered, used: listed.memoryUsed }).toEqual({ delivered: 2, used: 1 });

    const usage = (scope: MemoryScope) => Object.fromEntries(listMemoryCommand(handle.db, { scope }).entries.map((entry) => [entry.id, { deliveries: entry.deliveries, uses: entry.uses }]));
    expect(usage(project)).toEqual({ [used]: { deliveries: 1, uses: 1 } });
    expect(usage(workspace)).toEqual({ [unused]: { deliveries: 1, uses: 0 } });
    expect(usage(elsewhere)).toEqual({ [notGiven]: { deliveries: 0, uses: 0 } });
    const searched = Object.fromEntries(searchMemoryCommand(handle.db, {}).entries.map((entry) => [entry.id, { deliveries: entry.deliveries, uses: entry.uses }]));
    expect(searched).toEqual({ [used]: { deliveries: 1, uses: 1 }, [unused]: { deliveries: 1, uses: 0 }, [notGiven]: { deliveries: 0, uses: 0 } });
  });

  it("holds a continuation's memoryUsed to what the run it carries on was given on the same thread", () => {
    const given = remember(project, "Settlements are in UTC.");
    const earlier = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "succeeded", threadId: "thread-1" });
    appendRunEvent(handle.db, earlier.id, MEMORY_DELIVERED_EVENT, { type: MEMORY_DELIVERED_EVENT, entryIds: [given], candidateCount: 1, mode: "all", selectionRan: false, reason: null });
    const continuation = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "running" });

    expect([...memoryDeliveredToRun(handle.db, continuation.id, item.id, "thread-1")]).toEqual([given]);
    expect([...memoryDeliveredToRun(handle.db, continuation.id, item.id, null)]).toEqual([]);
    expect([...memoryDeliveredToRun(handle.db, continuation.id, item.id, "another-thread")]).toEqual([]);
  });

  it("records nothing about use for an answer that leaves memoryUsed out", async () => {
    remember(project, "Settlements are in UTC.");
    await supervisorWith(createFakeProvider({ result: validImplementResult })).runOnce();
    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(listRunEvents(handle.db, run.id).filter((event) => event.type === MEMORY_USED_EVENT)).toEqual([]);
    const listed = listRuns(handle.db, { itemId: item.id }).runs.find((record) => record.id === run.id)!;
    expect({ delivered: listed.memoryDelivered, used: listed.memoryUsed }).toEqual({ delivered: 1, used: 0 });
  });

  describe("a note written on the item (EO-611)", () => {
    const NOTE = "OWN-NOTE: seed the fixtures database before the integration tests.";
    /** Sixty words of prose, what extraction asks of a run. */
    const LONG_RESULT = { ...validImplementResult, summary: "word ".repeat(60).trim() };
    const noteCall = { toolCall: { name: MEMORY_NOTE_TOOL_NAME, args: { scope: "project", text: NOTE } } };
    const extracting: AgentProvider = {
      ...createFakeProvider({}),
      async *sideCall() {
        yield { type: "result", data: { notes: [{ scope: "project", text: NOTE }] } } satisfies AgentEvent;
      },
    };

    /** The ways a run writes a note: the steps it takes, and the side calls that write it. */
    const WAYS = {
      memory_note: { steps: [noteCall], sideCalls: undefined },
      extraction: { steps: [], sideCalls: { provider: () => extracting, smallModel: async () => null } },
    };

    const deliveredOn = (run: { id: Uuid }) => listRunEvents(handle.db, run.id).filter((event) => event.type === MEMORY_DELIVERED_EVENT).map((event) => event.payload);
    const bodies = () => listMemories(handle.db, project).map((entry) => entry.body);

    function startsRecorded(fake: AgentProvider) {
      const starts: AgentProviderStartOptions[] = [];
      const provider: AgentProvider = {
        ...fake,
        start(opts) {
          starts.push(opts);
          return fake.start(opts);
        },
      };
      return { provider, starts };
    }

    beforeEach(() => {
      // A review is only started on an item with criteria to judge it by.
      item = updateItem(handle.db, item.id, { spec: { acceptance_criteria: ["It exports."] } });
    });

    for (const [way, { steps, sideCalls }] of Object.entries(WAYS)) {
      it(`does not come back to a later run on a new thread, written by ${way}`, async () => {
        const persons = remember(project, "A PERSON'S ENTRY.");
        const { provider, starts } = startsRecorded(createFakeProvider({ steps, result: LONG_RESULT }));
        const supervisor = supervisorWith(provider, sideCalls);

        await supervisor.runOnce();
        expect(bodies()).toContain(NOTE);
        await supervisor.runOnce();

        const [, later] = listRunsForItem(handle.db, item.id);
        expect(starts).toHaveLength(2);
        expect(starts[1]!.context).not.toContain("OWN-NOTE");
        expect(starts[1]!.context).toContain("A PERSON'S ENTRY.");
        expect(deliveredOn(later!)).toEqual([expect.objectContaining({ entryIds: [persons], candidateCount: 1, mode: "all" })]);
      });

      it(`does not come back on the same thread, written by ${way}`, async () => {
        const persons = remember(project, "A PERSON'S ENTRY.");
        const parks = { toolCall: { name: "comment", args: { body: "@user need input", mentions: ["user"], blocking: true } } };
        // Fifty words of prose for extraction to be asked; a run that
        // called `memory_note` is not asked about at all.
        const fake = createFakeProvider({ steps: [...steps, { output: "word ".repeat(60).trim() }, parks], result: LONG_RESULT });
        const resumed: { threadId: string; message: string }[] = [];
        const provider: AgentProvider = {
          ...fake,
          resume(threadId, message, opts) {
            resumed.push({ threadId, message });
            return fake.resume(threadId, message, opts);
          },
        };
        const supervisor = supervisorWith(provider, sideCalls);

        await supervisor.runOnce();
        const first = listRunsForItem(handle.db, item.id)[0]!;
        expect(first.status).toBe("awaiting_input");
        expect(bodies()).toContain(NOTE);
        postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "go ahead" });
        await supervisor.resumeItem(item.id);

        expect(resumed.map((turn) => turn.threadId)).toEqual([first.threadId]);
        expect(resumed[0]!.message).not.toContain("OWN-NOTE");
        expect(resumed[0]!.message).toContain("A PERSON'S ENTRY.");
        expect(deliveredOn(replyRun())).toEqual([expect.objectContaining({ entryIds: [persons], candidateCount: 1, mode: "all" })]);
      });
    }

    it("gives a later run on an item with nothing left no section and no record of a delivery, and the run goes ahead", async () => {
      const { provider, starts } = startsRecorded(createFakeProvider({ steps: [noteCall], result: LONG_RESULT }));
      const supervisor = supervisorWith(provider);

      await supervisor.runOnce();
      await supervisor.runOnce();

      const [, later] = listRunsForItem(handle.db, item.id);
      expect(starts).toHaveLength(2);
      expect(starts[1]!.context).not.toContain("OWN-NOTE");
      expect(starts[1]!.context).not.toContain(MEMORY_SECTION_HEADING);
      expect(deliveredOn(later!)).toEqual([]);
    });

    it("still reaches a run on a different item", async () => {
      const { provider, starts } = startsRecorded(createFakeProvider({ steps: [noteCall], result: LONG_RESULT }));
      const supervisor = supervisorWith(provider);
      await supervisor.runOnce();
      const note = listMemories(handle.db, project).find((entry) => entry.body === NOTE)!;
      const other = createTestItem(handle.db, { type: "story", title: "Add PDF export", stepId: "todo", projectId: project.id as Uuid, workspaceId: workspace.id as Uuid });

      // The first item's review may come first; the other's run follows it.
      for (let tick = 0; tick < 3 && listRunsForItem(handle.db, other.id).length === 0; tick++) await supervisor.runOnce();

      expect(deliveredOn(listRunsForItem(handle.db, other.id)[0]!)).toEqual([expect.objectContaining({ entryIds: expect.arrayContaining([note.id]) })]);
      expect(starts.at(-1)!.context).toContain("OWN-NOTE");
    });
  });

  it("delivers nothing, and lists no memory_read, for an item with no project", async () => {
    remember(project, "The project's entry.");
    // The project's item would be dispatched first otherwise.
    deleteItem(handle.db, item.id);
    item = createTestItem(handle.db, { type: "story", title: "No project", stepId: "todo", projectId: null, workspaceId: null });
    const { provider, starts } = capturing();

    await supervisorWith(provider).runOnce();

    expect(starts[0]?.context).not.toContain("## Memory");
    expect(starts[0]?.memoryScopes).toBeUndefined();
  });

  /**
   * How to write memory (EO-593): EO's block, on every turn served
   * `memory_note`, whoever the agent is and whatever its instructions
   * say — and on none that is not.
   */
  describe("the memory-writing block", () => {
    const scopes = () => [
      { scope: project, name: "Payments" },
      { scope: workspace, name: folder },
    ];
    /** From the block's heading to the end of what the turn was sent: the block, and what follows it. */
    const blockIn = (context: string) => (context.includes(MEMORY_WRITING_SECTION_HEADING) ? context.slice(context.indexOf(MEMORY_WRITING_SECTION_HEADING)) : null);
    const agentNamed = (name: string) => listAgents(handle.db).find((agent) => agent.name === name && agent.deletedAt === null)!;
    const implementer = () => listAgents(handle.db).find((agent) => agent.role === "implementer" && agent.deletedAt === null)!;
    /** Whether the `eo` server a backend is started with for this agent lists `memory_note` — the real service, told what `buildProvider` tells it. */
    function serves(agent: Agent, memoryScopes: unknown): boolean {
      const env = eoMcpStdioConfig({ serverPath: "/app/eoServer.mjs", ...(memoryScopes ? { memoryScopes: memoryScopes as never } : {}), enableMemoryNote: memoryNoteEnabled(agent) }).env;
      const eo = service.createEoMcpService({
        dbPath: undefined,
        memoryScopes: service.parseMemoryScopes(env["EO_MCP_MEMORY_SCOPES"]),
        enableMemoryNote: env["EO_MCP_MEMORY_NOTE_ENABLED"] === "1",
      });
      try {
        return eo.tools.some((tool) => tool.name === MEMORY_NOTE_TOOL_NAME);
      } finally {
        eo.close();
      }
    }
    /** A step owned by a role EO ships no prompt for, and a person's own agent in it, made on the Agents screen. */
    function writerAgent(): Agent {
      createStep(handle.db, { id: "draft", pipelineId: "default" as never, position: -4, name: "Draft", type: "agent", ownerRole: "writer", entryAction: "implement" });
      saveAgent(handle.db, { name: "Writer", role: "writer", provider: "claude", model: null, instructions: "You write release notes in the house style, and nothing else.", enabled: true });
      return agentNamed("Writer");
    }
    /** Dispatches the one item ready, then deletes it, so the next dispatch is of the next item and not of this one's next step. */
    async function dispatch(on: Item) {
      const { provider, starts } = capturing();
      await supervisorWith(provider).runOnce();
      deleteItem(handle.db, on.id);
      expect(starts).toHaveLength(1);
      return starts[0]!;
    }

    it("is sent to a turn served memory_note though no scope holds an entry, and carries the definition of a note", async () => {
      expect(memoryNoteEnabled(implementer())).toBe(true);

      const started = await dispatch(item);

      expect(started.context).not.toContain("## Memory");
      expect(started.context).toContain(renderMemoryWritingSection(scopes())!);
      expect(started.context).toContain(MEMORY_NOTE_DEFINITION);
      expect(serves(implementer(), started.memoryScopes)).toBe(true);
    });

    it("follows the memory section, when there is one", async () => {
      remember(project, "Settlements are in UTC.");

      const { context } = await dispatch(item);

      expect(context.indexOf("## Memory")).toBeGreaterThan(-1);
      expect(context.indexOf(MEMORY_WRITING_SECTION_HEADING)).toBeGreaterThan(context.indexOf("Settlements are in UTC."));
    });

    it("is sent, word for word, with the tool, to a person's own agent in a role EO ships no prompt for", async () => {
      const shipped = await dispatch(item);
      const writer = writerAgent();
      expect(writer.instructions).not.toContain(MEMORY_NOTE_TOOL_NAME);
      const theirs = await dispatch(createTestItem(handle.db, { type: "story", title: "Release notes", stepId: "draft", projectId: project.id as Uuid, workspaceId: workspace.id as Uuid }));

      expect(theirs.instructions).toContain("You write release notes in the house style");
      expect(blockIn(theirs.context)).not.toBeNull();
      expect(blockIn(theirs.context)).toBe(blockIn(shipped.context));
      expect(serves(writer, theirs.memoryScopes)).toBe(true);
    });

    it("stops, with the tool, for the one agent a person took memory_note away from, and only that one", async () => {
      const writer = writerAgent();
      const detail = listAgentDetails(handle.db).agents.find((agent) => agent.id === writer.id)!;
      saveAgent(handle.db, { ...detail, config: {} });
      const taken = agentNamed("Writer");
      expect(memoryNoteEnabled(taken)).toBe(false);

      // The implementer's item first is `item`; make the writer's the only one ready.
      deleteItem(handle.db, item.id);
      const theirs = await dispatch(createTestItem(handle.db, { type: "story", title: "Release notes", stepId: "draft", projectId: project.id as Uuid, workspaceId: workspace.id as Uuid }));
      // Still given memory to read; not told how to write it, nor able to.
      expect(theirs.memoryScopes).toBeDefined();
      expect(blockIn(theirs.context)).toBeNull();
      expect(serves(taken, theirs.memoryScopes)).toBe(false);

      const shipped = await dispatch(createTestItem(handle.db, { type: "story", title: "Add PDF export", stepId: "todo", projectId: project.id as Uuid, workspaceId: workspace.id as Uuid }));
      expect(shipped.context).toContain(renderMemoryWritingSection(scopes())!);
      expect(serves(implementer(), shipped.memoryScopes)).toBe(true);
    });

    /**
     * The turns that carry a thread on rather than choosing memory: a
     * corrective turn, a continuation after EO was closed, and a recovery
     * after a restart. Each is served `memory_note`, and each may carry on
     * a thread opened before the block existed — by an agent 0148 has
     * since granted the tool — so each is sent the block itself.
     */
    function resuming(opts: { firstAnswer?: Record<string, unknown> } = {}) {
      const resumes: { threadId: string; message: string }[] = [];
      const provider: AgentProvider = {
        ...createFakeProvider({ result: validImplementResult }),
        async *start() {
          yield { type: "thread_started", threadId: "the-thread" };
          yield { type: "result", data: opts.firstAnswer ?? (validImplementResult as unknown as Record<string, unknown>) };
        },
        async *resume(threadId, message) {
          resumes.push({ threadId, message });
          yield { type: "result", data: validImplementResult as unknown as Record<string, unknown> };
        },
      };
      return { provider, resumes };
    }

    it("is sent with a corrective turn, and not to an agent without the grant", async () => {
      const granted = resuming({ firstAnswer: {} });
      await supervisorWith(granted.provider).runOnce();
      expect(granted.resumes).toHaveLength(1);
      expect(granted.resumes[0]!.message).toContain("Please return a corrected result that matches the schema.");
      expect(granted.resumes[0]!.message).toContain(renderMemoryWritingSection(scopes())!);

      deleteItem(handle.db, item.id);
      updateAgent(handle.db, implementer().id, { config: {} });
      createTestItem(handle.db, { type: "story", title: "Add PDF export", stepId: "todo", projectId: project.id as Uuid, workspaceId: workspace.id as Uuid });
      const taken = resuming({ firstAnswer: {} });
      await supervisorWith(taken.provider).runOnce();
      expect(taken.resumes).toHaveLength(1);
      expect(taken.resumes[0]!.message).toContain("Please return a corrected result that matches the schema.");
      expect(taken.resumes[0]!.message).not.toContain(MEMORY_WRITING_SECTION_HEADING);
    });

    it("is sent with the continuation of a run EO was closed in the middle of", async () => {
      const working: AgentProvider = {
        ...createFakeProvider({ result: validImplementResult }),
        async *start(input) {
          yield { type: "thread_started", threadId: "the-stopped-thread" };
          await new Promise<void>((resolve) => {
            if (input.signal.aborted) resolve();
            else input.signal.addEventListener("abort", resolve, { once: true });
          });
        },
      };
      const closing = supervisorWith(working);
      const ticking = closing.runOnce();
      await vi.waitFor(() => expect(listRunsForItem(handle.db, item.id)[0]?.threadId).toBe("the-stopped-thread"));
      closing.pause({ cancelRunning: true });
      await ticking;
      await closing.waitForIdle();
      expect(listRunsForItem(handle.db, item.id).some((run) => run.interruption === "quit")).toBe(true);

      const { provider, resumes } = resuming();
      const reopened = supervisorWith(provider);
      reopened.start();
      await vi.waitFor(() => expect(resumes).toHaveLength(1));
      await reopened.waitForIdle();
      reopened.stop();

      expect(resumes[0]!.threadId).toBe("the-stopped-thread");
      expect(resumes[0]!.message).toContain(renderMemoryWritingSection(scopes())!);
    });

    it("is sent with the recovery of a run found running after a restart", async () => {
      const interrupted = createRun(handle.db, { itemId: item.id, agentId: implementer().id, action: "implement", status: "queued", threadId: "the-interrupted-thread" });
      updateRun(handle.db, interrupted.id, { status: "running", startedAt: Date.now(), cwd: folder });
      const { provider, resumes } = resuming();
      const supervisor = supervisorWith(provider);

      expect(await supervisor.reconcile()).toMatchObject({ resumed: 1 });
      await vi.waitFor(() => expect(resumes).toHaveLength(1));
      const recovery = listRunsForItem(handle.db, item.id).find((run) => run.id !== interrupted.id)!;
      await vi.waitFor(() => expect(getRun(handle.db, recovery.id)?.status).not.toBe("running"));

      expect(resumes[0]!.threadId).toBe("the-interrupted-thread");
      expect(resumes[0]!.message).toContain(renderMemoryWritingSection(scopes())!);
    });

    it("is not sent where the turn has no scope to write to", async () => {
      deleteItem(handle.db, item.id);
      const started = await dispatch(createTestItem(handle.db, { type: "story", title: "No project", stepId: "todo", projectId: null, workspaceId: null }));

      expect(blockIn(started.context)).toBeNull();
      expect(serves(implementer(), started.memoryScopes)).toBe(false);
    });
  });
});
