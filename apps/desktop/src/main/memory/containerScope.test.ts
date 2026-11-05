import {
  MAX_MEMORY_NOTE_CHARS,
  MemoryScopeKindSchema,
  type Item,
  type MemoryContainerDoneAnswer,
  type MemoryEntryView,
  type MemoryScope,
  type SideCallResult,
  type Uuid,
} from "@eo/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  addMemory,
  setItemArchived,
  createRun,
  getRun,
  listAgents,
  listConsolidations,
  listMemories,
  listMemoriesUpdatedSince,
  readProjectMemories,
  restoreConsolidation,
  transitionItem,
  updateRun,
} from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { recordFor } from "../record/localRecord.js";
import type { SideCaller, SideCallRequest } from "../sideCalls/sideCall.js";
import { containerDoneAnswerSchema, MEMORY_CONSOLIDATE_SYSTEM, MEMORY_CONTAINER_DONE_SYSTEM, MEMORY_PROPOSE_SKILLS_SYSTEM } from "./consolidation.js";
import { CONSOLIDATION_BATCH_MAX_ENTRIES, MEMORY_MERGE_CANDIDATES_SYSTEM } from "./consolidationBatches.js";
import { createMemoryConsolidator, type MemoryConsolidator } from "./consolidator.js";
import { containerScopeOf, containerWorkFinishedAt } from "./containerScope.js";
import { memoryScopesFor } from "./dispatchMemory.js";
import { extractionInput, extractionItem, extractMemory } from "./extraction.js";
import { writeMemoryNote } from "./memoryNote.js";
import { renderMemorySection } from "./selection.js";
import { renderMemoryWritingSection } from "./writing.js";

/**
 * A container's memory (EO-596, ARCHITECTURE.md §7.5): the scope the
 * items filed under a container share while its work is in progress, who
 * is given it and may write to it, and how it ends once every item under
 * it has finished — one `container_done` consolidation that moves what
 * still holds to the project, retires the rest, and can be restored.
 */
const HOUR = 60 * 60 * 1000;

describe("a container's memory", () => {
  let handle: DbHandle;
  let projectId: Uuid;
  let workspaceId: Uuid;
  let container: Item;
  let first: Item;
  let second: Item;
  let elsewhere: Item;
  let project: MemoryScope;
  let scope: MemoryScope;
  let consolidator: MemoryConsolidator | null;

  beforeEach(() => {
    handle = openMigratedTestDb();
    const w = attachWorkspace(handle.db, { keyPrefix: "P", name: "api", repoPath: "/tmp/eo-container-scope" });
    projectId = w.projectId! as Uuid;
    workspaceId = w.id as Uuid;
    // A pack's container is whatever it calls it; this one is the developer pack's.
    container = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, projectId, workspaceId });
    first = createTestItem(handle.db, { type: "story", title: "Limit the API", stepId: "todo", projectId, workspaceId, parentId: container.id });
    second = createTestItem(handle.db, { type: "story", title: "Limit the webhooks", stepId: "todo", projectId, workspaceId, parentId: container.id });
    elsewhere = createTestItem(handle.db, { type: "story", title: "Add CSV export", stepId: "todo", projectId, workspaceId });
    project = { kind: "project", id: projectId };
    scope = { kind: "container", id: container.id };
    consolidator = null;
  });

  afterEach(() => {
    consolidator?.stop();
    handle.close();
  });

  const implementer = () => listAgents(handle.db).find((agent) => agent.role === "implementer")!;

  function runOn(item: Item): Uuid {
    return createRun(handle.db, { itemId: item.id, agentId: implementer().id, action: "implement", status: "running" }).id;
  }

  function byAgent(where: MemoryScope, body: string, at = Date.now() - HOUR, on: Item = first): MemoryEntryView {
    const written = addMemory(handle.db, { scope: where, body, source: { type: "run", runId: runOn(on), itemId: on.id }, now: at });
    if (!written.ok) throw new Error(written.problem);
    return written.entry;
  }

  function byPerson(where: MemoryScope, body: string): MemoryEntryView {
    const written = addMemory(handle.db, { scope: where, body, source: { type: "person", personId: null }, now: Date.now() - HOUR });
    if (!written.ok) throw new Error(written.problem);
    return written.entry;
  }

  function finish(item: Item): void {
    transitionItem(handle.db, { itemId: item.id, toStepId: "ready_to_merge", actor: "human" });
  }

  type Request = SideCallRequest<unknown>;
  function consolidatorWith(answer: (request: Request) => Promise<SideCallResult<unknown>>): { runner: MemoryConsolidator; calls: Request[] } {
    const calls: Request[] = [];
    consolidator = createMemoryConsolidator({
      db: handle.db,
      sideCall: (async (request: Request) => {
        calls.push(request);
        return answer(request);
      }) as never,
      caps: () => ({ maxEntries: 200, maxChars: 40_000 }),
      repositoryFiles: () => [],
    });
    return { runner: consolidator, calls };
  }

  /** What a container_done call answers, held to its schema as the side call would hold it. */
  function keeping(keep: (sent: string) => MemoryContainerDoneAnswer["keep"]) {
    return async (request: Request): Promise<SideCallResult<unknown>> => {
      if (request.system !== MEMORY_CONTAINER_DONE_SYSTEM) throw new Error(`unexpected call: ${request.system.slice(0, 60)}`);
      const parsed = request.schema.safeParse({ keep: keep(request.input) });
      if (!parsed.success) return { ok: false, reason: "schema", message: parsed.error.message };
      return { ok: true, value: parsed.data };
    };
  }

  describe("is a scope kind of its own, named by the container item's id", () => {
    it("is one of the memory scope kinds, and an entry in it carries the container's project", () => {
      expect(MemoryScopeKindSchema.options).toContain("container");
      const entry = byAgent(scope, "The limiter's buckets are keyed by the account, not the token.");
      expect(entry.scope).toEqual({ kind: "container", id: container.id });
      expect(readProjectMemories(handle.db, projectId).map((row) => row.id)).toContain(entry.id);
    });

    it("names no scope for an item that is not a container", () => {
      const written = addMemory(handle.db, { scope: { kind: "container", id: first.id }, body: "A note.", source: { type: "person", personId: null } });
      expect(written).toEqual({ ok: false, problem: `No container has the id "${first.id}".` });
    });
  });

  describe("who is given it", () => {
    it("is a run on an item filed under the container, beside the project's and the workspace's — and no other run", () => {
      expect(memoryScopesFor(handle.db, first, { worksInWorkspace: true }).map((info) => info.scope)).toEqual([project, { kind: "workspace", id: workspaceId }, scope]);
      // Whatever its step works in: a conversation on a story under it is still about that work.
      expect(memoryScopesFor(handle.db, first, { worksInWorkspace: false }).map((info) => info.scope)).toEqual([project, scope]);
      expect(memoryScopesFor(handle.db, elsewhere, { worksInWorkspace: true }).map((info) => info.scope)).toEqual([project, { kind: "workspace", id: workspaceId }]);
      // Nor the container itself, which is filed under nothing.
      expect(memoryScopesFor(handle.db, container, { worksInWorkspace: false }).map((info) => info.scope)).toEqual([project]);
      // Nor an item filed under an item that is not a container.
      const under = createTestItem(handle.db, { type: "story", title: "Sub-task", stepId: "todo", projectId, workspaceId, parentId: elsewhere.id });
      expect(containerScopeOf(handle.db, under)).toBeNull();
    });

    it("delivers the container's entries among the candidates, under their own heading", () => {
      const entry = byAgent(scope, "The limiter's buckets are keyed by the account, not the token.");
      const scopes = memoryScopesFor(handle.db, second, { worksInWorkspace: true });
      const section = renderMemorySection({ scopes, candidates: [entry], choice: { mode: "all", delivered: [entry], selectionRan: false, reason: null }, now: Date.now() });
      expect(section).toContain(`### Container: ${container.key} Rate limiting (scope \`${container.id}\`)`);
      expect(section).toContain("keyed by the account");
    });

    it("tells an agent under the container when to write to it, and an agent elsewhere nothing about it", () => {
      const under = renderMemoryWritingSection(memoryScopesFor(handle.db, first, { worksInWorkspace: true }))!;
      expect(under).toContain(`- \`${container.id}\` — what is only true while the work filed under ${container.key} Rate limiting is in progress`);
      expect(under).toContain("When every item under it is finished, EO moves what still holds to the project and retires the rest.");
      expect(renderMemoryWritingSection(memoryScopesFor(handle.db, elsewhere, { worksInWorkspace: true }))).not.toContain(container.id);
    });
  });

  describe("who may write to it", () => {
    it("is memory_note on a run under the container, refused for a run on any other item", async () => {
      const record = recordFor(handle.db);
      const note = { scope: container.id, text: "The limiter's buckets are keyed by the account, not the token." };
      const written = await writeMemoryNote({ record, args: note, scopes: memoryScopesFor(handle.db, first, { worksInWorkspace: true }), runId: runOn(first), item: first });
      expect(written).toEqual({ ok: true, entry: expect.objectContaining({ scope, body: note.text }) });

      const refused = await writeMemoryNote({ record, args: note, scopes: memoryScopesFor(handle.db, elsewhere, { worksInWorkspace: true }), runId: runOn(elsewhere), item: elsewhere });
      expect(refused).toEqual({ ok: false, problem: expect.stringContaining(`"${container.id}" is not a scope this run works in`) });
      expect(listMemories(handle.db, scope).map((entry) => entry.body)).toEqual([note.text]);
    });

    it("is extraction after a run under the container, which is told the scope and when it is the one", async () => {
      const scopes = memoryScopesFor(handle.db, first, { worksInWorkspace: true });
      const input = extractionInput({
        agentName: "Implementer",
        action: "implement",
        status: "succeeded",
        resultKey: null,
        item: extractionItem(first),
        produce: { finalAnswer: null, comments: [], toolNames: [], calledMemoryNote: false },
        humanComments: [],
        scopes,
        existing: [],
      });
      expect(input).toContain(`- "${container.id}": the container ${container.key} Rate limiting, while the work filed under it is in progress`);

      const words = Array.from({ length: 80 }, (_, index) => `word${index}`).join(" ");
      const extract = async (item: Item) => {
        const runId = runOn(item);
        updateRun(handle.db, runId, { status: "succeeded", endedAt: Date.now(), result: { raw: {}, parsed: { summary: words } } });
        const answer = { notes: [{ scope: container.id, text: `Learned on ${item.key}: the limiter resets at the minute.`, replaces: [] }] };
        return extractMemory({
          db: handle.db,
          run: getRun(handle.db, runId)!,
          item,
          agent: implementer(),
          backend: "claude",
          scopes: memoryScopesFor(handle.db, item, { worksInWorkspace: true }),
          sideCall: (async () => ({ ok: true, value: answer })) as unknown as SideCaller["sideCall"],
        });
      };
      await extract(first);
      await extract(elsewhere);
      // The run under the container wrote to it; the other's note was refused.
      expect(listMemories(handle.db, scope).map((entry) => entry.body)).toEqual([`Learned on ${first.key}: the limiter resets at the minute.`]);
    });
  });

  describe("how it ends", () => {
    it("is finished when every item under it stands on a terminal step, archived ones included, and not before", () => {
      expect(containerWorkFinishedAt(handle.db, container.id)).toBeNull();
      finish(first);
      expect(containerWorkFinishedAt(handle.db, container.id)).toBeNull();
      finish(second);
      setItemArchived(handle.db, first.id, Date.now());
      expect(containerWorkFinishedAt(handle.db, container.id)).toEqual(expect.any(Number));
      // A container with nothing under it has not started.
      const empty = createTestItem(handle.db, { type: "feature", title: "Nothing yet", stepId: null, projectId, workspaceId });
      expect(containerWorkFinishedAt(handle.db, empty.id)).toBeNull();
    });

    it("queues exactly one container_done once the last item under it finishes, and none before", () => {
      byAgent(scope, "Fact one.");
      const { runner } = consolidatorWith(keeping(() => []));
      expect(runner.check()).toEqual([]);
      finish(first);
      expect(runner.check()).toEqual([]);
      finish(second);
      expect(runner.check()).toEqual([{ scope, trigger: "container_done" }]);
      expect(runner.check()).toEqual([{ scope, trigger: "container_done" }]);
    });

    it("queues none for a container with no entries, nor one holding only a person's", () => {
      finish(first);
      finish(second);
      const { runner } = consolidatorWith(keeping(() => []));
      expect(runner.check()).toEqual([]);
      byPerson(scope, "Ask Dana before changing the limits.");
      expect(runner.check()).toEqual([]);
    });

    it("is looked at as soon as the last item under it moves, and run through the consolidator", async () => {
      const fact = byAgent(scope, "Run the limiter's tests with pnpm test:limits; pnpm test skips them.");
      byAgent(scope, "The webhook story still needs the retry header.");
      const { runner, calls } = consolidatorWith(keeping((input) => [{ from: [input.includes(fact.id) ? fact.id : ""], body: fact.body }]));
      runner.start();
      finish(first);
      finish(second);
      await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 2_000 });
      await runner.idle();
      expect(calls[0]).toEqual(expect.objectContaining({ purpose: "memory_consolidate", system: MEMORY_CONTAINER_DONE_SYSTEM, projectId }));
      expect(listMemories(handle.db, scope)).toEqual([]);
    });

    it("writes kept facts as project entries, retires the rest as consolidated, and Restore puts the container's back", async () => {
      const a = byAgent(scope, "Run the limiter's tests with pnpm test:limits.", Date.now() - 3 * HOUR);
      const b = byAgent(scope, "pnpm test skips the limiter's tests.", Date.now() - 2 * HOUR, second);
      const c = byAgent(scope, "Redis keys for buckets are rl:<account>.", Date.now() - 2 * HOUR);
      const d = byAgent(scope, "The webhook story still needs the retry header.", Date.now() - HOUR);
      const person = byPerson(scope, "Ask Dana before changing the limits.");
      const before = byAgent(project, "An entry the project already held.");
      finish(first);
      finish(second);
      const { runner, calls } = consolidatorWith(
        keeping(() => [
          { from: [a.id, b.id], body: "Run the limiter's tests with pnpm test:limits; pnpm test skips them." },
          { from: [c.id], body: c.body },
        ]),
      );

      expect(runner.check()).toEqual([{ scope, trigger: "container_done" }]);
      runner.start();
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      await runner.idle();

      // Told the work is finished, and given only the agents' entries.
      expect(calls[0]!.input).toContain(`The work filed under the container ${container.key} "Rate limiting" is finished.`);
      for (const entry of [a, b, c, d]) expect(calls[0]!.input).toContain(entry.id);
      expect(calls[0]!.input).not.toContain(person.id);
      // No cross-batch pass and no skill proposal call.
      expect(calls.map((call) => call.system)).toEqual([MEMORY_CONTAINER_DONE_SYSTEM]);

      const [row] = listConsolidations(handle.db, scope);
      expect(row).toEqual(expect.objectContaining({ trigger: "container_done", status: "succeeded" }));
      expect([...row!.retiredIds].sort()).toEqual([a.id, b.id, c.id, d.id].sort());
      expect(row!.writtenIds).toHaveLength(2);
      expect(row!.note).toContain("2 facts were kept as entries of the project");

      // The project holds what still holds, with the source and age of the newest it came from.
      const kept = listMemories(handle.db, project).filter((entry) => entry.id !== before.id);
      expect(kept.map((entry) => entry.id).sort()).toEqual([...row!.writtenIds].sort());
      expect(kept).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ body: "Run the limiter's tests with pnpm test:limits; pnpm test skips them.", source: b.source, createdAt: b.createdAt, consolidationId: row!.id }),
          expect.objectContaining({ body: c.body, source: c.source, createdAt: c.createdAt, consolidationId: row!.id }),
        ]),
      );
      // The container keeps only the person's entry.
      expect(listMemories(handle.db, scope).map((entry) => entry.id)).toEqual([person.id]);
      expect(listMemories(handle.db, scope, { includeRetired: true }).filter((entry) => entry.retiredAt !== null).every((entry) => entry.retiredReason === "consolidated")).toBe(true);
      // Ended: not queued again.
      expect(runner.check()).toEqual([]);

      // Restore: the container's entries are back, what it wrote in the project is retired.
      const restored = restoreConsolidation(handle.db, row!.id, { caps: { maxEntries: 200, maxChars: 40_000 } });
      expect(restored).toEqual(expect.objectContaining({ ok: true, restored: 4, retired: 2 }));
      expect(listMemories(handle.db, scope).map((entry) => entry.id).sort()).toEqual([a.id, b.id, c.id, d.id, person.id].sort());
      expect(listMemories(handle.db, project).map((entry) => entry.id)).toEqual([before.id]);
      // A person keeping the container's memory: it is not ended again for the same finish.
      expect(runner.check()).toEqual([]);
    });

    it("is due again after a restore once the work under it finishes again — an item filed under it later", async () => {
      const fact = byAgent(scope, "Fact one.");
      finish(first);
      finish(second);
      const { runner, calls } = consolidatorWith(keeping(() => []));
      runner.check();
      runner.start();
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      await runner.idle();
      const [row] = listConsolidations(handle.db, scope);
      expect(restoreConsolidation(handle.db, row!.id, { caps: { maxEntries: 200, maxChars: 40_000 } })).toEqual(expect.objectContaining({ ok: true, restored: 1 }));
      expect(runner.check()).toEqual([]);

      // More work filed under it: not finished while it runs, and a new end when it does.
      const third = createTestItem(handle.db, { type: "story", title: "Limit the exports", stepId: "todo", projectId, workspaceId, parentId: container.id });
      expect(runner.check()).toEqual([]);
      finish(third);
      handle.db.run(sql`update transitions set ts = ${Date.now() + 60_000} where item_id = ${third.id}`);
      expect(runner.check()).toEqual([{ scope, trigger: "container_done" }]);
      expect(listMemories(handle.db, scope).map((entry) => entry.id)).toEqual([fact.id]);
    });

    it("changes nothing when an item under it is reopened while the end is queued, and is queued again once it finishes again", async () => {
      const entry = byAgent(scope, "Needed while this work is in progress.");
      finish(first);
      finish(second);
      const { runner, calls } = consolidatorWith(keeping(() => []));
      expect(runner.check()).toEqual([{ scope, trigger: "container_done" }]);
      // A rejection sends it back before the queue is worked.
      transitionItem(handle.db, { itemId: second.id, toStepId: "todo", actor: "human" });
      expect(containerWorkFinishedAt(handle.db, container.id)).toBeNull();

      runner.start();
      await runner.idle();

      expect(calls).toEqual([]);
      expect(listMemories(handle.db, scope).map((row) => row.id)).toEqual([entry.id]);
      expect(listMemories(handle.db, project)).toEqual([]);
      const [row] = listConsolidations(handle.db, scope);
      expect(row).toEqual(expect.objectContaining({ trigger: "container_done", status: "skipped", retiredIds: [], writtenIds: [] }));
      expect(row!.note).toContain("no longer finished");
      expect(runner.check()).toEqual([]);

      // Finished again: a new end, and it runs.
      finish(second);
      handle.db.run(sql`update transitions set ts = ${Date.now() + 60_000} where item_id = ${second.id} and to_step_id = 'ready_to_merge'`);
      expect(runner.check()).toEqual([{ scope, trigger: "container_done" }]);
    });

    it("drops its answer when an item under it is reopened while the call runs", async () => {
      const entry = byAgent(scope, "Needed while this work is in progress.");
      finish(first);
      finish(second);
      const { runner, calls } = consolidatorWith(async (request) => {
        // Work resumes under the container while the model is answering.
        transitionItem(handle.db, { itemId: first.id, toStepId: "todo", actor: "human" });
        return keeping(() => [{ from: [entry.id], body: "Kept for the project." }])(request);
      });
      runner.check();
      runner.start();
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      await runner.idle();

      expect(listMemories(handle.db, scope).map((row) => row.id)).toEqual([entry.id]);
      expect(listMemories(handle.db, project)).toEqual([]);
      expect(listConsolidations(handle.db, scope).map((row) => [row.trigger, row.status, row.retiredIds.length, row.writtenIds.length])).toEqual([["container_done", "skipped", 0, 0]]);
    });

    it("stops between batches when work resumes, leaving the batches before it applied", async () => {
      const entries = Array.from({ length: CONSOLIDATION_BATCH_MAX_ENTRIES + 5 }, (_, index) => byAgent(scope, `Fact number ${index} about the limiter.`, Date.now() - HOUR + index));
      finish(first);
      finish(second);
      const calls: Request[] = [];
      let reopened = false;
      consolidator = createMemoryConsolidator({
        db: handle.db,
        sideCall: (async (request: Request) => {
          calls.push(request);
          return keeping(() => [])(request);
        }) as never,
        caps: () => ({ maxEntries: 200, maxChars: 40_000 }),
        repositoryFiles: () => [],
        // Asked between two batches (and before the first): once the first
        // batch is applied, an item under the container is reopened.
        pipelineBusy: () => {
          if (!reopened && listConsolidations(handle.db, scope).some((row) => row.status === "succeeded")) {
            reopened = true;
            transitionItem(handle.db, { itemId: first.id, toStepId: "todo", actor: "human" });
          }
          return false;
        },
      });
      consolidator.check();
      consolidator.start();
      await vi.waitFor(() => expect(reopened).toBe(true));
      await consolidator.idle();

      expect(calls).toHaveLength(1);
      const rows = listConsolidations(handle.db, scope);
      expect(rows.map((row) => [row.trigger, row.status])).toEqual([
        ["container_done", "skipped"],
        ["container_done", "succeeded"],
      ]);
      expect(rows[0]!.note).toContain("the batches before it stay applied");
      // What the first batch was given is retired; the rest are still the container's.
      expect(listMemories(handle.db, scope)).toHaveLength(entries.length - rows[1]!.retiredIds.length);
      expect(listMemories(handle.db, scope).length).toBeGreaterThan(0);
    });

    it("goes in batches where its entries do not fit one call, each applied on its own, with no cross-batch pass", async () => {
      const entries = Array.from({ length: CONSOLIDATION_BATCH_MAX_ENTRIES + 5 }, (_, index) => byAgent(scope, `Fact number ${index} about the limiter.`, Date.now() - HOUR + index));
      finish(first);
      finish(second);
      const { runner, calls } = consolidatorWith(keeping(() => []));
      runner.check();
      runner.start();
      await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
      await runner.idle();
      expect(calls.map((call) => call.system)).toEqual([MEMORY_CONTAINER_DONE_SYSTEM, MEMORY_CONTAINER_DONE_SYSTEM]);
      expect(calls.some((call) => call.system === MEMORY_MERGE_CANDIDATES_SYSTEM || call.system === MEMORY_PROPOSE_SKILLS_SYSTEM || call.system === MEMORY_CONSOLIDATE_SYSTEM)).toBe(false);
      expect(listConsolidations(handle.db, scope).map((row) => [row.trigger, row.status])).toEqual([
        ["container_done", "succeeded"],
        ["container_done", "succeeded"],
      ]);
      expect(listMemories(handle.db, scope)).toEqual([]);
      expect(listMemories(handle.db, scope, { includeRetired: true })).toHaveLength(entries.length);
    });

    it("changes nothing when its answer names an entry it was not given, or one twice, or says too much", () => {
      const sent = [
        { id: "a", body: "A." },
        { id: "b", body: "B." },
      ];
      const schema = containerDoneAnswerSchema(sent);
      expect(schema.safeParse({ keep: [] }).success).toBe(true);
      expect(schema.safeParse({ keep: [{ from: ["a", "b"], body: "A and B." }] }).success).toBe(true);
      expect(schema.safeParse({ keep: [{ from: ["c"], body: "C." }] }).success).toBe(false);
      expect(schema.safeParse({ keep: [{ from: ["a"], body: "A." }, { from: ["a"], body: "A again." }] }).success).toBe(false);
      expect(schema.safeParse({ keep: [{ from: [], body: "Nothing." }] }).success).toBe(false);
      expect(schema.safeParse({ keep: [{ from: ["a"], body: "x".repeat(MAX_MEMORY_NOTE_CHARS + 1) }] }).success).toBe(false);
    });
  });

  it("travels with the project's memory as a record pages it", () => {
    const entry = byAgent(scope, "The limiter's buckets are keyed by the account, not the token.");
    expect(listMemoriesUpdatedSince(handle.db, { ts: 0, id: "" }, 100, projectId).map((row) => [row.id, row.scope.kind, row.projectId])).toContainEqual([entry.id, "container", projectId]);
  });
});
