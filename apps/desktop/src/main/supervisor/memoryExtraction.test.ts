import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FOLDER_KIND,
  MEMORY_EXTRACT_TIMEOUT_MS,
  LEARNING_REVIEW_EVENT,
  MEMORY_EXTRACTED_EVENT,
  MEMORY_NOTE_TOOL_NAME,
  type AgentEvent,
  type AgentProvider,
  type AgentSideCallOptions,
  type Item,
  type MemoryScope,
  type Uuid,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DbHandle } from "../db/client.js";
import {
  addMemory,
  createProject,
  createRun,
  createWorkspace,
  deleteItem,
  getItem,
  getMemory,
  getMemorySearchEntry,
  getRun,
  listMemories,
  listRunEvents,
  listRunsForItem,
  listSideCalls,
  postComment,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
import { createRunSupervisor } from "./runSupervisor.js";

/** Where a succeeded implement run sends an item from To Do on the default pipeline. */
const AFTER_IMPLEMENT = "review";

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

/** Sixty words of prose: enough for a run to be worth asking about. */
const LONG_SUMMARY =
  "Added the CSV export behind the reports menu. The integration tests need the fixtures database seeded first, which " +
  "the test script does not do on its own, so I ran the seed command before the suite. The export writes dates in UTC " +
  "because the settlement service compares them that way, and the team asked for that convention in review last week.";
const LONG_RESULT = { branch: "eo/PAY-1", summary: LONG_SUMMARY, handoff: "Nothing else to flag." };
/** Fewer than fifty words. */
const SHORT_RESULT = { branch: "eo/PAY-1", summary: "Did the work.", handoff: "Straightforward; nothing to flag." };

/**
 * Extraction after a run (EO-479), driven through a real dispatch: the
 * agent's run on the fake backend, and one `memory_extract` side call on
 * a scripted side-call provider.
 */
describe("memory extraction after a run", () => {
  let handle: DbHandle;
  let folder: string;
  let item: Item;
  let project: MemoryScope;
  let workspace: MemoryScope;
  let writes: TestWriteBridge;

  beforeEach(async () => {
    // Where an agent's comments and notes reach EO (EO-543): nothing is
    // written off the event stream, so a run's comment is on the item —
    // and in what extraction is given — only once it was posted over this.
    writes = await startTestWriteBridge();
    handle = openMigratedTestDb();
    folder = mkdtempSync(join(tmpdir(), "eo-memory-extract-"));
    const w = createWorkspace(handle.db, { kind: FOLDER_KIND, config: { path: folder } });
    const p = createProject(handle.db, { name: "Payments", keyPrefix: "PAY", workspaceIds: [w.id] });
    project = { kind: "project", id: p.id };
    workspace = { kind: "workspace", id: w.id };
    item = createTestItem(handle.db, { type: "story", title: "Add CSV export", stepId: "todo", projectId: p.id, workspaceId: w.id });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await writes.close();
    handle.close();
    rmSync(folder, { recursive: true, force: true });
  });

  /** A side-call provider that answers every call with `answer`, recording what it was asked. */
  function extractor(answer: unknown) {
    const asked: AgentSideCallOptions[] = [];
    const provider: AgentProvider = {
      ...createFakeProvider({}),
      async *sideCall(options) {
        asked.push(options);
        yield { type: "result", data: answer } satisfies AgentEvent;
      },
    };
    return { provider, asked };
  }

  /**
   * Since EO-717 extraction is the fallback for a thread that cannot be
   * forked, so the agent's backend here is one that cannot fork: every
   * run below is reviewed by `memory_extract`, as every run was before.
   */
  function supervisorOver(agent: AgentProvider, sideCallProvider: AgentProvider | null) {
    const forkless: AgentProvider = { ...agent };
    delete forkless.fork;
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: forkless,
      limits: LIMITS,
      agentWriteBridge: writes.agentWriteBridge,
      ...(sideCallProvider ? { sideCalls: { provider: () => sideCallProvider, smallModel: async () => null } } : {}),
    });
    writes.serve(supervisor);
    return supervisor;
  }

  const extractCalls = () => listSideCalls(handle.db).filter((call) => call.purpose === "memory_extract");
  const onlyRun = () => listRunsForItem(handle.db, item.id)[0]!;

  /** The `memory_extracted` events on the run's log: how its extraction ended (EO-511). */
  const extractedEvents = () => listRunEvents(handle.db, onlyRun().id).filter((event) => event.type === MEMORY_EXTRACTED_EVENT).map((event) => event.payload);

  /** The `learning_review` events on the run's log (EO-717). */
  const reviewEvents = () => listRunEvents(handle.db, onlyRun().id).filter((event) => event.type === LEARNING_REVIEW_EVENT).map((event) => event.payload);

  /** Where the item stands once its implement run succeeds, extraction or none. */
  const moved = () => getItem(handle.db, item.id)?.stepId;

  it("after a succeeded run, makes one memory_extract call inside it and writes its notes as active entries marked as extracted", async () => {
    addMemory(handle.db, { scope: project, body: "Settlements are compared in UTC.", source: { type: "person", personId: null } });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Please keep dates in UTC, as the settlement service expects." });
    const { provider: side, asked } = extractor({
      notes: [
        { scope: "project", text: "Seed the fixtures database before running the integration tests; the test script does not." },
        { scope: workspace.id, text: "The CSV export lives behind the reports menu." },
      ],
    });
    const agent = createFakeProvider({
      steps: [{ toolCall: { name: "comment", args: { body: "Seeding the fixtures first, the suite fails without them." } } }, { toolCall: { name: "Bash", args: { command: "pnpm test" } } }],
      result: LONG_RESULT,
    });

    await supervisorOver(agent, side).runOnce();

    const run = onlyRun();
    expect(run.status).toBe("succeeded");
    expect(asked).toHaveLength(1);
    expect(extractCalls()).toEqual([expect.objectContaining({ purpose: "memory_extract", runId: run.id, itemId: item.id, outcome: "succeeded" })]);
    // What it was given: the run's answer, its comment, its tools, what
    // people said, and what memory already holds.
    const input = asked[0]!.input;
    expect(input).toContain("The integration tests need the fixtures database seeded first");
    expect(input).toContain("Seeding the fixtures first, the suite fails without them.");
    expect(input).toContain("comment, Bash");
    expect(input).toContain("Please keep dates in UTC, as the settlement service expects.");
    expect(input).toContain("Settlements are compared in UTC.");
    expect(input).toContain(`"${workspace.id}": the workspace`);
    expect(asked[0]!.system).toContain("would get something wrong or lose time without it");

    const extracted = { type: "run", runId: run.id, itemId: item.id, extracted: true };
    expect(listMemories(handle.db, project)).toEqual([
      expect.objectContaining({ body: "Seed the fixtures database before running the integration tests; the test script does not.", source: extracted, retiredAt: null }),
      expect.objectContaining({ body: "Settlements are compared in UTC." }),
    ]);
    expect(listMemories(handle.db, workspace)).toEqual([expect.objectContaining({ body: "The CSV export lives behind the reports menu.", source: extracted })]);
    const entryIds = [...listMemories(handle.db, project), ...listMemories(handle.db, workspace)].filter((entry) => entry.source.type === "run").map((entry) => entry.id);
    expect(extractedEvents()).toEqual([{ type: MEMORY_EXTRACTED_EVENT, outcome: "written", entryIds: expect.arrayContaining(entryIds), dropped: [], reason: null }]);
    // The review fell back to this, and says why (EO-717).
    expect(reviewEvents()).toEqual([{ type: LEARNING_REVIEW_EVENT, outcome: "fell_back", entryIds: [], skillIds: [], reason: "The fake backend cannot fork a thread.", forkThreadId: null }]);
    expect(moved()).toBe(AFTER_IMPLEMENT);
  });

  it("records an answer with no notes on the run's log as nothing_to_save, not as notes written (EO-511)", async () => {
    const { provider: side, asked } = extractor({ notes: [] });

    await supervisorOver(createFakeProvider({ result: LONG_RESULT }), side).runOnce();

    expect(asked).toHaveLength(1);
    expect(extractCalls()).toEqual([expect.objectContaining({ runId: onlyRun().id, outcome: "succeeded" })]);
    expect(extractedEvents()).toEqual([{ type: MEMORY_EXTRACTED_EVENT, outcome: "nothing_to_save", entryIds: [], dropped: [], reason: null }]);
    expect(listMemories(handle.db, project)).toEqual([]);
    expect(listMemories(handle.db, workspace)).toEqual([]);
  });

  it("writes none when the answer has none, and drops a note for a scope the run could not write to while keeping the rest", async () => {
    const { provider: side } = extractor({ notes: [{ scope: "some-other-workspace", text: "Elsewhere." }, { scope: "project", text: "Kept." }, { scope: "project", text: "x".repeat(1_001) }] });

    await supervisorOver(createFakeProvider({ result: LONG_RESULT }), side).runOnce();

    expect(listMemories(handle.db, project).map((entry) => entry.body)).toEqual(["Kept."]);
    expect(listMemories(handle.db, workspace)).toEqual([]);
  });

  it("retires the agent-written entry a note replaces, and drops a note naming a person's, retiring nothing of it (EO-594)", async () => {
    const earlier = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "succeeded" });
    const wrong = addMemory(handle.db, { scope: project, body: "The fixtures database seeds itself.", source: { type: "run", runId: earlier.id, itemId: item.id }, now: 1_000 });
    const persons = addMemory(handle.db, { scope: project, body: "Dates are local time.", source: { type: "person", personId: null }, now: 1_000 });
    if (!wrong.ok || !persons.ok) throw new Error("not written");
    const { provider: side, asked } = extractor({
      notes: [
        { scope: "project", text: "Seed the fixtures database before the integration tests; the test script does not.", replaces: [wrong.entry.id] },
        { scope: "project", text: "Settlement dates are UTC.", replaces: [persons.entry.id] },
      ],
    });

    await supervisorOver(createFakeProvider({ result: LONG_RESULT }), side).runOnce();

    // Shown each entry's id and who wrote it, so it can name one.
    expect(asked[0]!.input).toContain(`<entry id="${wrong.entry.id}" scope="project" by="an agent">`);
    expect(asked[0]!.input).toContain(`<entry id="${persons.entry.id}" scope="project" by="a person">`);
    expect(getMemory(handle.db, wrong.entry.id)).toMatchObject({ retiredReason: "superseded" });
    expect(getMemory(handle.db, persons.entry.id)?.retiredAt).toBeNull();
    expect(listMemories(handle.db, project).map((entry) => entry.body)).toEqual([
      "Seed the fixtures database before the integration tests; the test script does not.",
      "Dates are local time.",
    ]);
    // The run on the fake backend, not the earlier one the entry names.
    const ran = listRunsForItem(handle.db, item.id).find((run) => run.id !== earlier.id)!;
    expect(listRunEvents(handle.db, ran.id).filter((event) => event.type === MEMORY_EXTRACTED_EVENT).map((event) => event.payload)).toEqual([
      expect.objectContaining({ outcome: "written", dropped: [expect.stringContaining("a note never replaces a person's entry")] }),
    ]);
  });

  it("writes a replacement whose text is word for word what it replaces, retiring every entry it names (EO-594 review)", async () => {
    const earlier = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "succeeded" });
    const from = { type: "run" as const, runId: earlier.id, itemId: item.id };
    // The same fact noted twice by earlier runs, once in each scope.
    const first = addMemory(handle.db, { scope: project, body: "Run pnpm install first.", source: from, now: 1_000 });
    const second = addMemory(handle.db, { scope: workspace, body: "Run pnpm install first.", source: from, now: 1_100 });
    if (!first.ok || !second.ok) throw new Error("not written");
    const { provider: side } = extractor({ notes: [{ scope: "project", text: "Run pnpm install first.", replaces: [first.entry.id, second.entry.id] }] });

    await supervisorOver(createFakeProvider({ result: LONG_RESULT }), side).runOnce();

    const [note] = listMemories(handle.db, project);
    expect(note).toMatchObject({ body: "Run pnpm install first.", retiredAt: null, source: expect.objectContaining({ extracted: true }) });
    expect(note?.id).not.toBe(first.entry.id);
    expect(getMemorySearchEntry(handle.db, note!.id)?.supersededIds).toEqual([first.entry.id, second.entry.id]);
    for (const id of [first.entry.id, second.entry.id]) expect(getMemory(handle.db, id)).toMatchObject({ retiredReason: "superseded" });
    expect(listMemories(handle.db, workspace)).toEqual([]);
  });

  it("keeps what memory holds in step as a note retires what it replaces: a later note saying what was retired is written, one saying what was just written is not (EO-594 review)", async () => {
    const earlier = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "succeeded" });
    const wrong = addMemory(handle.db, { scope: project, body: "Dates are local time.", source: { type: "run", runId: earlier.id, itemId: item.id }, now: 1_000 });
    if (!wrong.ok) throw new Error(wrong.problem);
    const { provider: side } = extractor({
      notes: [
        { scope: "project", text: "Settlement dates are UTC.", replaces: [wrong.entry.id] },
        // In the same scope as the entry the first note retired.
        { scope: "project", text: "Dates are local time." },
        { scope: "project", text: "Settlement dates are UTC." },
      ],
    });

    await supervisorOver(createFakeProvider({ result: LONG_RESULT }), side).runOnce();

    expect(listMemories(handle.db, project).map((entry) => entry.body).sort()).toEqual(["Dates are local time.", "Settlement dates are UTC."]);
    expect(listMemories(handle.db, project).map((entry) => entry.id)).not.toContain(wrong.entry.id);
    expect(getMemory(handle.db, wrong.entry.id)).toMatchObject({ retiredReason: "superseded" });
  });

  it("writes nothing when the answer holds more than five notes", async () => {
    const { provider: side } = extractor({ notes: Array.from({ length: 6 }, (_, index) => ({ scope: "project", text: `Note ${index}.` })) });

    await supervisorOver(createFakeProvider({ result: LONG_RESULT }), side).runOnce();

    expect(extractCalls()).toEqual([expect.objectContaining({ outcome: "failed", reason: "schema" })]);
    expect(listMemories(handle.db, project)).toEqual([]);
  });

  it("extracts after a failed run, from the last thing the agent said", async () => {
    const { provider: side, asked } = extractor({ notes: [{ scope: "project", text: "The migration needs the old schema loaded first." }] });
    const agent = createFakeProvider({ steps: [{ output: LONG_SUMMARY }], throwMessage: "the backend fell over" });

    await supervisorOver(agent, side).runOnce();

    expect(onlyRun().status).toBe("failed");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.input).toContain("It ended: failed.");
    expect(asked[0]!.input).toContain("so I ran the seed command before the suite");
    expect(listMemories(handle.db, project).map((entry) => entry.body)).toEqual(["The migration needs the old schema loaded first."]);
  });

  it("extracts after a run that ended awaiting input", async () => {
    const { provider: side, asked } = extractor({ notes: [] });
    const questions = {
      status: "clarification_required",
      questions: [
        {
          id: "q1",
          question: "Should the export write dates in UTC, the way the settlement service compares them, or in the person's own zone?",
          why: "The integration tests seed fixtures in UTC and the report screen shows local time, so the two disagree for anyone east of Greenwich and one of them has to change before this ships.",
          options: ["UTC", "local time"],
        },
      ],
    };

    await supervisorOver(createFakeProvider({ result: questions }), side).runOnce();

    expect(onlyRun().status).toBe("awaiting_input");
    expect(asked).toHaveLength(1);
    expect(extractCalls()).toEqual([expect.objectContaining({ runId: onlyRun().id, outcome: "succeeded" })]);
    expect(listMemories(handle.db, project)).toEqual([]);
  });

  describe("is not asked for", () => {
    it("a run that called memory_note itself", async () => {
      const { provider: side, asked } = extractor({ notes: [{ scope: "project", text: "Should never be written." }] });
      // The note is made the way a real one is, over the bridge (EO-543);
      // what skips extraction is that the run called the tool, which its
      // log says by name, and a long enough answer that it otherwise would
      // have been asked.
      const agent = createFakeProvider({
        steps: [{ toolCall: { name: MEMORY_NOTE_TOOL_NAME, args: { scope: "project", text: "Settlements are in UTC." } } }],
        result: LONG_RESULT,
      });

      await supervisorOver(agent, side).runOnce();

      expect(onlyRun().status).toBe("succeeded");
      expect(asked).toEqual([]);
      expect(extractCalls()).toEqual([]);
      expect(listMemories(handle.db, project).map((entry) => entry.body)).toEqual(["Settlements are in UTC."]);
    });

    it("a run that produced fewer than fifty words of prose", async () => {
      const { provider: side, asked } = extractor({ notes: [{ scope: "project", text: "Should never be written." }] });

      await supervisorOver(createFakeProvider({ result: SHORT_RESULT }), side).runOnce();

      expect(onlyRun().status).toBe("succeeded");
      expect(asked).toEqual([]);
      expect(extractCalls()).toEqual([]);
      // Nothing was asked, so the run's log says nothing about it.
      expect(extractedEvents()).toEqual([]);
    });

    it("a run on a preview item", async () => {
      const preview = createTestItem(handle.db, { type: "story", title: "Weekly report", stepId: "todo", projectId: project.id as Uuid, previewAt: Date.now() });
      // Only the preview is on the board.
      deleteItem(handle.db, item.id);
      const { provider: side, asked } = extractor({ notes: [{ scope: "project", text: "Should never be written." }] });

      await supervisorOver(createFakeProvider({ result: LONG_RESULT }), side).runOnce();

      expect(listRunsForItem(handle.db, preview.id)).toHaveLength(1);
      expect(asked).toEqual([]);
      expect(extractCalls()).toEqual([]);
    });

    it("a run that was cancelled", async () => {
      const { provider: side, asked } = extractor({ notes: [{ scope: "project", text: "Should never be written." }] });
      const supervisor = supervisorOver(createFakeProvider({ steps: [{ output: LONG_SUMMARY }, { sleepMs: 5_000 }], result: LONG_RESULT }), side);

      const tick = supervisor.runOnce();
      await vi.waitFor(() => expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("running"));
      supervisor.cancelRun(onlyRun().id);
      await tick;

      expect(onlyRun().status).toBe("cancelled");
      expect(asked).toEqual([]);
      expect(extractCalls()).toEqual([]);
    });

    it("a run that was interrupted", async () => {
      const { provider: side, asked } = extractor({ notes: [{ scope: "project", text: "Should never be written." }] });
      const supervisor = supervisorOver(createFakeProvider({ steps: [{ output: LONG_SUMMARY }, { sleepMs: 5_000 }], result: LONG_RESULT }), side);

      const tick = supervisor.runOnce();
      await vi.waitFor(() => expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("running"));
      await supervisor.shutdown();
      await tick;

      expect(onlyRun().interruption).not.toBeNull();
      expect(asked).toEqual([]);
      expect(extractCalls()).toEqual([]);
    });
  });

  /**
   * A reply to a parked run holds no dispatch lease, and its row is
   * terminal before extraction starts, so neither the leases nor the
   * scheduler's active runs count it then (EO-479 review). Its slot must
   * still be held until extraction returns.
   */
  it("holds the global slot through extraction after a reply to a parked run: no run and no standalone side call starts until it ends", async () => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const extracting = vi.fn();
    const standalone = vi.fn();
    const side: AgentProvider = {
      ...createFakeProvider({}),
      async *sideCall(options) {
        if (options.system === "standalone") {
          standalone();
          yield { type: "result", data: {} } satisfies AgentEvent;
          return;
        }
        extracting();
        await released;
        yield { type: "result", data: { notes: [] } } satisfies AgentEvent;
      },
    };
    const agent = createFakeProvider({
      steps: [{ toolCall: { name: "comment", args: { body: "@user need input", mentions: ["user"], blocking: true } } }, { output: "continuing" }],
      result: LONG_RESULT,
    });
    const supervisor = supervisorOver(agent, side);
    await supervisor.runOnce();
    expect(onlyRun().status).toBe("awaiting_input");
    expect(extracting).not.toHaveBeenCalled();

    // Work waiting for the one global slot, in a workspace of its own and
    // ahead of the review the reply sends the first item to, so that
    // nothing but the global limit stands between it and a dispatch.
    const elsewhere = createWorkspace(handle.db, { kind: FOLDER_KIND, config: { path: mkdtempSync(join(folder, "other-")) } });
    const other = createProject(handle.db, { name: "Reports", keyPrefix: "REP", workspaceIds: [elsewhere.id] });
    const waiting = createTestItem(handle.db, { type: "story", title: "Add PDF export", stepId: "todo", projectId: other.id, workspaceId: elsewhere.id, priority: 10 });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "go ahead" });
    const replying = supervisor.resumeItem(item.id);
    await vi.waitFor(() => expect(extracting).toHaveBeenCalled());
    // The reply's run is over and its item has moved; extraction is still out.
    expect(listRunsForItem(handle.db, item.id).at(-1)?.status).toBe("succeeded");
    expect(moved()).toBe(AFTER_IMPLEMENT);

    const allRuns = () => [...listRunsForItem(handle.db, item.id), ...listRunsForItem(handle.db, waiting.id)];
    const runsBefore = allRuns().length;
    // A tick decides what to dispatch at once; `runOnce` then waits for
    // everything in flight, the reply included.
    const ticking = supervisor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(allRuns()).toHaveLength(runsBefore);
    expect(listRunsForItem(handle.db, waiting.id)).toEqual([]);

    const asked = supervisor.sideCall({
      purpose: "memory_consolidate",
      model: { model: null, reasoningEffort: null },
      backend: "claude",
      schema: z.object({}),
      system: "standalone",
      input: "anything",
      projectId: project.id as Uuid,
      timeoutMs: 60_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(standalone).not.toHaveBeenCalled();

    release();
    await replying;
    await ticking;
    // The slot goes to the side call that asked first, then to the run.
    expect(await asked).toEqual(expect.objectContaining({ ok: true }));
    expect(standalone).toHaveBeenCalledTimes(1);
    await supervisor.runOnce();
    expect(allRuns().length).toBeGreaterThan(runsBefore);
  });

  describe("a side call that fails", () => {
    it("writes nothing, is not asked again, and leaves the item where the run sent it", async () => {
      const failing: AgentProvider = {
        ...createFakeProvider({}),
        // eslint-disable-next-line require-yield
        async *sideCall() {
          throw new Error("the small model is down");
        },
      };

      await supervisorOver(createFakeProvider({ result: LONG_RESULT }), failing).runOnce();

      expect(onlyRun().status).toBe("succeeded");
      expect(extractCalls()).toEqual([expect.objectContaining({ outcome: "failed", reason: "error" })]);
      expect(extractedEvents()).toEqual([{ type: MEMORY_EXTRACTED_EVENT, outcome: "failed", entryIds: [], dropped: [], reason: "error: the small model is down" }]);
      expect(listMemories(handle.db, project)).toEqual([]);
      expect(listMemories(handle.db, workspace)).toEqual([]);
      expect(moved()).toBe(AFTER_IMPLEMENT);
    });

    it("that runs past sixty seconds is stopped, writes nothing, is not asked again, and the item has already moved", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const entered = vi.fn();
      const hanging: AgentProvider = {
        ...createFakeProvider({}),
        async *sideCall(options) {
          entered();
          await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
          yield { type: "result", data: { notes: [{ scope: "project", text: "Too late." }] } } satisfies AgentEvent;
        },
      };

      const tick = supervisorOver(createFakeProvider({ result: LONG_RESULT }), hanging).runOnce();
      await vi.waitFor(() => expect(entered).toHaveBeenCalled());
      // The run is over and the item has moved while extraction is still out.
      expect(getRun(handle.db, onlyRun().id)?.status).toBe("succeeded");
      expect(moved()).toBe(AFTER_IMPLEMENT);

      await vi.advanceTimersByTimeAsync(MEMORY_EXTRACT_TIMEOUT_MS);
      await tick;

      expect(entered).toHaveBeenCalledTimes(1);
      expect(extractCalls()).toEqual([expect.objectContaining({ outcome: "failed", reason: "timeout" })]);
      expect(listMemories(handle.db, project)).toEqual([]);
      expect(moved()).toBe(AFTER_IMPLEMENT);
    });
  });
});
