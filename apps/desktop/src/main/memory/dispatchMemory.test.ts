import {
  MEMORY_SELECT_TIMEOUT_MS,
  type Agent,
  type AgentEvent,
  type AgentProvider,
  type AgentSideCallOptions,
  type Item,
  type MemoryScope,
  type MemorySelection,
  type SideCallResult,
  type Uuid,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { addMemory, createRun, listAgents, listSideCalls, postComment, retireMemory, updateRun } from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createSideCaller, type SideCallRequest } from "../sideCalls/sideCall.js";
import { createSideCallSlots } from "../sideCalls/slots.js";
import { deliverMemory, memoryReadScopes, memoryScopesFor, memoryTaskFor, type DeliveredMemory } from "./dispatchMemory.js";

/**
 * What a dispatch is given from memory (EO-478): which scopes it draws
 * from, when a selection is asked for, and what is delivered when the
 * selection fails.
 */
describe("a dispatch's memory", () => {
  let handle: DbHandle;
  let item: Item;
  let agent: Agent;
  let runId: Uuid;
  let project: MemoryScope;
  let workspace: MemoryScope;
  let otherWorkspace: MemoryScope;
  let otherProject: MemoryScope;

  beforeEach(() => {
    handle = openMigratedTestDb();
    const w = attachWorkspace(handle.db, { keyPrefix: "P", name: "api", repoPath: "/tmp/api" });
    const other = attachWorkspace(handle.db, { keyPrefix: "Q", name: "web", repoPath: "/tmp/web" });
    project = { kind: "project", id: w.projectId! };
    workspace = { kind: "workspace", id: w.id };
    otherWorkspace = { kind: "workspace", id: other.id };
    otherProject = { kind: "project", id: other.projectId! };
    item = createTestItem(handle.db, { type: "story", title: "Add CSV export", body: "Export the ledger.", stepId: "todo", projectId: w.projectId!, workspaceId: w.id });
    agent = listAgents(handle.db).find((candidate) => candidate.role === "implementer")!;
    runId = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement", status: "queued" }).id;
  });

  afterEach(() => {
    vi.useRealTimers();
    handle.close();
  });

  function remember(scope: MemoryScope, body: string, now = Date.now()): string {
    const written = addMemory(handle.db, { scope, body, source: { type: "person", personId: null }, now });
    if (!written.ok) throw new Error(written.problem);
    return written.entry.id;
  }

  function deliver(
    sideCall: (request: SideCallRequest<MemorySelection>) => Promise<SideCallResult<MemorySelection>>,
    options: { worksInWorkspace?: boolean; thresholdChars?: number } = {},
  ): DeliveredMemory | Promise<DeliveredMemory> {
    return deliverMemory({
      db: handle.db,
      item,
      agent,
      action: "implement",
      runId,
      backend: "claude",
      scopes: memoryScopesFor(handle.db, item, { worksInWorkspace: options.worksInWorkspace ?? true }),
      conversation: false,
      thresholdChars: options.thresholdChars ?? 4_000,
      sideCall: sideCall as never,
      now: Date.now(),
    });
  }

  const never = vi.fn(async (): Promise<SideCallResult<MemorySelection>> => ({ ok: true, value: { ids: [] } }));

  it("draws from the item's project and the workspace its step works in, and from no other", () => {
    expect(memoryScopesFor(handle.db, item, { worksInWorkspace: true })).toEqual([
      { scope: project, name: "api" },
      { scope: workspace, name: "api" },
    ]);
    expect(memoryReadScopes(memoryScopesFor(handle.db, item, { worksInWorkspace: true }))).toEqual([
      { ...project, name: "api" },
      { ...workspace, name: "api" },
    ]);
  });

  it("considers only the active entries of P and W, never a retired one or another scope's", async () => {
    const p = remember(project, "In P.");
    const w = remember(workspace, "In W.");
    remember(otherWorkspace, "In another workspace.");
    remember(otherProject, "In another project.");
    retireMemory(handle.db, remember(workspace, "Retired in W."));

    const delivered = (await deliver(never)) as DeliveredMemory;

    expect(delivered.event).toMatchObject({ mode: "all", selectionRan: false, candidateCount: 2 });
    expect(new Set(delivered.event.entryIds)).toEqual(new Set([p, w]));
    expect(delivered.section).toContain("In P.");
    expect(delivered.section).toContain("In W.");
    expect(delivered.section).not.toContain("another");
    expect(delivered.section).not.toContain("Retired");
  });

  describe("an item's own notes (EO-611)", () => {
    /** A note a run wrote: on `on`, by `memory_note` or, with `extracted`, by extraction. */
    function noted(on: Item, body: string, options: { extracted?: boolean; scope?: MemoryScope } = {}): string {
      const run = createRun(handle.db, { itemId: on.id, agentId: agent.id, action: "implement", status: "succeeded" });
      const written = addMemory(handle.db, {
        scope: options.scope ?? project,
        body,
        source: { type: "run", runId: run.id, itemId: on.id, ...(options.extracted ? { extracted: true as const } : {}) },
      });
      if (!written.ok) throw new Error(written.problem);
      return written.entry.id;
    }

    it("are not candidates, by either way of writing them, in the list or the count", async () => {
      noted(item, "Own note.");
      noted(item, "Own extracted note.", { extracted: true });
      const persons = remember(project, "A person's entry.");

      const delivered = (await deliver(never)) as DeliveredMemory;

      expect(delivered.event).toMatchObject({ entryIds: [persons], candidateCount: 1, mode: "all" });
      expect(delivered.section).not.toContain("Own");
      expect(delivered.section).toContain("A person's entry.");
    });

    it("do not push the rest over the threshold, nor reach a selection", async () => {
      noted(item, "x".repeat(5_000));
      const persons = remember(project, "A person's entry.");
      const select = vi.fn(async (): Promise<SideCallResult<MemorySelection>> => ({ ok: true, value: { ids: [] } }));

      const delivered = (await deliver(select, { thresholdChars: 100 })) as DeliveredMemory;

      expect(select).not.toHaveBeenCalled();
      expect(delivered.event).toMatchObject({ entryIds: [persons], candidateCount: 1, mode: "all" });
    });

    it("stay out of what a selection is shown, and of what is read again after it", async () => {
      const own = noted(item, "Own note.");
      const persons = remember(project, "A person's entry.");
      let written = "";
      let inputShown = "";
      const delivered = await deliver(
        async (request) => {
          inputShown = request.input;
          // A note of this item's, written while the selection ran.
          written = noted(item, "Written meanwhile.");
          return { ok: true, value: { ids: [own, persons, written] } };
        },
        { thresholdChars: 1 },
      );

      expect(inputShown).not.toContain("Own note.");
      expect(delivered.event).toMatchObject({ entryIds: [persons], candidateCount: 1, mode: "selected" });
    });

    it("stay out of a fallback's newest entries", async () => {
      // The newest of all three, and small enough to fit the fallback.
      noted(item, "Own.");
      remember(project, "An older entry.", 1_000);
      const newer = remember(project, "A newer entry.", 2_000);

      const delivered = await deliver(async () => ({ ok: false, reason: "timeout", message: "too slow" }), { thresholdChars: 20 });

      expect(delivered.event).toMatchObject({ entryIds: [newer], candidateCount: 2, mode: "fallback" });
      expect(delivered.section).not.toContain("Own.");
    });

    it("are still delivered to a different item, a sibling under the same container included", async () => {
      const container = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, projectId: item.projectId!, workspaceId: item.workspaceId! });
      const first = createTestItem(handle.db, { type: "story", title: "Limit the API", stepId: "todo", projectId: item.projectId!, workspaceId: item.workspaceId!, parentId: container.id });
      const sibling = createTestItem(handle.db, { type: "story", title: "Limit the hooks", stepId: "todo", projectId: item.projectId!, workspaceId: item.workspaceId!, parentId: container.id });
      const containerScope: MemoryScope = { kind: "container", id: container.id };
      const inProject = noted(first, "From the sibling, in the project.");
      const inContainer = noted(first, "From the sibling, in the container.", { scope: containerScope });

      item = sibling;
      const delivered = (await deliver(never)) as DeliveredMemory;

      expect(new Set(delivered.event.entryIds)).toEqual(new Set([inProject, inContainer]));
      item = first;
      expect(((await deliver(never)) as DeliveredMemory).event).toMatchObject({ entryIds: [], candidateCount: 0, mode: "none" });
    });

    it("leaving nothing takes the path of an item with no candidates", () => {
      noted(item, "Own note.");
      noted(item, "Own extracted note.", { extracted: true });

      expect(deliver(never)).toMatchObject({ section: null, event: { entryIds: [], candidateCount: 0, mode: "none", selectionRan: false, reason: null } });
      expect(never).not.toHaveBeenCalled();
    });
  });

  it("with no workspace, considers the project's entries only", async () => {
    const p = remember(project, "In P.");
    remember(workspace, "In W.");

    const delivered = (await deliver(never, { worksInWorkspace: false })) as DeliveredMemory;

    expect(delivered.event.entryIds).toEqual([p]);
    expect(delivered.section).not.toContain("In W.");
    expect(delivered.section).not.toContain("Workspace:");
  });

  it("delivers everything and makes no side call at or under the threshold", () => {
    remember(project, "a".repeat(2_000));
    remember(workspace, "b".repeat(2_000));
    const sideCall = vi.fn(never);

    const delivered = deliver(sideCall);

    expect(delivered).not.toBeInstanceOf(Promise);
    expect(sideCall).toHaveBeenCalledTimes(0);
    expect((delivered as DeliveredMemory).event).toMatchObject({ mode: "all", selectionRan: false });
  });

  it("above it makes one memory_select side call inside the run, with every candidate and the task, and delivers only what it returns", async () => {
    updateRun(handle.db, runId, { status: "succeeded", endedAt: 1, threadId: "t-1" });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Use the existing CSV writer." });
    const ids = Array.from({ length: 10 }, (_, index) => remember(index % 2 === 0 ? project : workspace, `Entry ${index}: ${"x".repeat(600)}`, 1_000 + index));
    const sideCall = vi.fn(async (_request: SideCallRequest<MemorySelection>): Promise<SideCallResult<MemorySelection>> => ({ ok: true, value: { ids: [ids[2]!, ids[5]!] } }));

    const delivered = await deliver(sideCall);

    expect(sideCall).toHaveBeenCalledTimes(1);
    const request = sideCall.mock.calls[0]![0];
    expect(request).toMatchObject({ purpose: "memory_select", backend: "claude", itemId: item.id, projectId: project.id, insideRunId: runId, timeoutMs: MEMORY_SELECT_TIMEOUT_MS });
    expect(MEMORY_SELECT_TIMEOUT_MS).toBe(20_000);
    for (const id of ids) expect(request.input).toContain(`id="${id}"`);
    expect(request.input).toContain("Add CSV export");
    expect(request.input).toContain("Export the ledger.");
    expect(request.input).toContain("Action: implement");
    expect(request.input).toContain("Use the existing CSV writer.");
    expect(request.system).toMatch(/conservative/i);
    expect(request.system).toMatch(/not on words/i);
    expect(request.schema.safeParse({ ids: Array.from({ length: 9 }, () => "x") }).success).toBe(false);

    expect(delivered.event).toMatchObject({ mode: "selected", selectionRan: true, candidateCount: 10 });
    expect(new Set(delivered.event.entryIds)).toEqual(new Set([ids[2], ids[5]]));
    expect(delivered.section).toContain("Entry 2:");
    expect(delivered.section).toContain("Entry 5:");
    expect(delivered.section).not.toContain("Entry 3:");
  });

  it("tells a conversation's selection the latest message as the task", () => {
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "First." });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "How do refunds settle?" });
    expect(memoryTaskFor(handle.db, item, agent, "discuss", true)).toEqual({ kind: "conversation", latestMessage: "How do refunds settle?" });
  });

  it("on a 20-second timeout delivers the newest entries up to the threshold, says selection did not run, and the dispatch goes on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const ids = Array.from({ length: 6 }, (_, index) => remember(project, `Entry ${index}: ${"y".repeat(1_400)}`, 1_000 + index));
    // A backend that never answers: the side call's own limit is the only thing that ends it.
    const silent: AgentProvider = {
      start: () => {
        throw new Error("not a run");
      },
      resume: () => {
        throw new Error("not a run");
      },
      async *sideCall(options: AgentSideCallOptions): AsyncIterable<AgentEvent> {
        await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        yield { type: "result", data: { ids: [] } } satisfies AgentEvent;
      },
    } as unknown as AgentProvider;
    const caller = createSideCaller({
      db: handle.db,
      provider: () => silent,
      smallModel: async () => "the-small-one",
      guards: () => ({ perItemBudgetCents: null, dailyBudgetCents: null }),
      slots: createSideCallSlots({ limit: () => 1, busy: () => 1 }),
      workDirectory: () => ({ path: "/tmp", remove: () => {} }),
    });

    let settled: DeliveredMemory | null = null;
    void Promise.resolve(deliver(caller.sideCall)).then((delivered) => {
      settled = delivered;
    });
    await vi.advanceTimersByTimeAsync(MEMORY_SELECT_TIMEOUT_MS - 1);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(settled).not.toBeNull());

    const delivered = settled as unknown as DeliveredMemory;
    expect(delivered.event).toMatchObject({ mode: "fallback", selectionRan: false });
    expect(delivered.event.reason).toMatch(/^timeout:/);
    // The newest two fit in 4,000 characters; a third would not.
    expect(delivered.event.entryIds).toEqual([ids[5], ids[4]]);
    expect(delivered.section).toContain("Selection did not run");
    // One row, against this run — the slot was the run's, not a second one.
    expect(listSideCalls(handle.db)).toEqual([expect.objectContaining({ purpose: "memory_select", runId, outcome: "failed", reason: "timeout" })]);
  });
});
