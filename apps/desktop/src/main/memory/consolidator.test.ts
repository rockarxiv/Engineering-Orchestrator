import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_PERSON_ID,
  MAX_MEMORY_NOTE_CHARS,
  MEMORY_CONSOLIDATE_MAX_OUTPUT_TOKENS,
  MEMORY_CONSOLIDATE_TIMEOUT_MS,
  MEMORY_DELIVERED_EVENT,
  type AgentEvent,
  type AgentProvider,
  type AgentSideCallOptions,
  type MemoryConsolidationAnswer,
  type MemoryEntryView,
  type MemoryScope,
  type MessageSend,
  type SideCallResult,
  type Uuid,
} from "@eo/core";
import { hasDispatchableItem } from "@eo/engine";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  addMemory,
  appendRunEvent,
  consolidationSlotTime,
  consolidationState,
  createRun,
  decideSkillProposal,
  failConsolidation,
  getConsolidation,
  listActiveRuns,
  listAgents,
  listConsolidations,
  markConsolidationRunFinished,
  listMemories,
  listSideCalls,
  recordSkillProposal,
  restoreConsolidation,
  restoreMemory,
  retireMemory,
  saveSkill,
  recordSkippedConsolidation,
  setItemHeld,
  similarMemoryNeighbours,
  skipConsolidation,
  startConsolidation,
  updateAgent,
} from "../db/repos/index.js";
import { buildEligibilityInput } from "../supervisor/buildTickInput.js";
import { applyConsolidation, entriesNewSinceConsolidated, lastFinishedRunAt, runsDeliveredFromScopeQuery } from "../db/repos/memoryConsolidationsRepo.js";
import { attachWorkspace, createTestItem, messagesFrom, openMigratedTestDb } from "../db/testHelpers.js";
import { listConsolidationsCommand, restoreConsolidationCommand } from "../ipc/memoryCommands.js";
import { recordFor } from "../record/localRecord.js";
import { createSideCaller, type SideCallRequest } from "../sideCalls/sideCall.js";
import { createSideCallSlots } from "../sideCalls/slots.js";
import {
  CONSOLIDATION_BACKOFF_MS,
  CONSOLIDATION_CHANGED_RETRY_MS,
  CONSOLIDATION_DEFERRED_REASON,
  CONSOLIDATION_PAUSED_REASON,
  MEMORY_CONSOLIDATE_SYSTEM,
  MEMORY_CROSS_BATCH_MERGE_SYSTEM,
  MEMORY_PROPOSE_SKILLS_SYSTEM,
  resolvedDate,
} from "./consolidation.js";
import { CONSOLIDATION_BATCH_MAX_CHARS, CONSOLIDATION_BATCH_MAX_ENTRIES, firstLine, MEMORY_MERGE_CANDIDATES_SYSTEM } from "./consolidationBatches.js";
import { createMemoryConsolidator, readRepositoryFiles, systemAgentSetup, type MemoryConsolidator, type MemoryConsolidatorOptions } from "./consolidator.js";

/**
 * Automatic memory consolidation (EO-480): what queues one, what it is
 * given, what it changes, what a failure leaves, and undoing one.
 */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CLAUDE_MD = "# api\n\nRun the tests with `pnpm test:api`.\n";

type Answer = SideCallResult<MemoryConsolidationAnswer>;
type ConsolidateRequest = SideCallRequest<MemoryConsolidationAnswer>;

/** An answer that changes nothing (EO-573). */
const NOTHING: MemoryConsolidationAnswer = { retire: [], merge: [], rewrite: [] };
/** An answer that folds every one of `entries` into one entry saying `body`. */
const mergeAll = (entries: readonly MemoryEntryView[], body: string): MemoryConsolidationAnswer => ({
  ...NOTHING,
  merge: [{ body, from: entries.map((entry) => entry.id), contradictsRepositoryFile: false }],
});

describe("automatic memory consolidation", () => {
  let handle: DbHandle;
  let folder: string;
  let workspace: MemoryScope;
  let project: MemoryScope;
  let projectId: string;
  let runId: Uuid;
  let itemId: Uuid;
  let consolidator: MemoryConsolidator | null;
  let systemBackend: string;

  beforeEach(() => {
    handle = openMigratedTestDb();
    folder = mkdtempSync(join(tmpdir(), "eo-consolidation-"));
    writeFileSync(join(folder, "CLAUDE.md"), CLAUDE_MD);
    const w = attachWorkspace(handle.db, { keyPrefix: "P", name: "api", repoPath: folder });
    projectId = w.projectId!;
    workspace = { kind: "workspace", id: w.id };
    project = { kind: "project", id: w.projectId! };
    const item = createTestItem(handle.db, { type: "story", title: "Add CSV export", stepId: "todo", projectId: w.projectId!, workspaceId: w.id });
    itemId = item.id;
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    runId = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" }).id;
    systemBackend = listAgents(handle.db).find((agent) => agent.role === "system")!.provider;
    consolidator = null;
  });

  afterEach(() => {
    consolidator?.stop();
    vi.useRealTimers();
    handle.close();
    rmSync(folder, { recursive: true, force: true });
  });

  function byAgent(scope: MemoryScope, body: string, at: number): MemoryEntryView {
    const written = addMemory(handle.db, { scope, body, source: { type: "run", runId, itemId }, now: at });
    if (!written.ok) throw new Error(written.problem);
    return written.entry;
  }

  function byPerson(scope: MemoryScope, body: string, at: number): MemoryEntryView {
    const written = addMemory(handle.db, { scope, body, source: { type: "person", personId: null }, now: at });
    if (!written.ok) throw new Error(written.problem);
    return written.entry;
  }

  /** The real side caller, over a backend that answers `data`: the answer is held to the request's own schema. */
  function answeringWith(data: unknown) {
    const provider = {
      async *sideCall(): AsyncIterable<AgentEvent> {
        yield { type: "result", data } satisfies AgentEvent;
      },
    } as unknown as AgentProvider;
    return createSideCaller({
      db: handle.db,
      provider: () => provider,
      smallModel: async () => "small",
      guards: () => ({ perItemBudgetCents: null, dailyBudgetCents: null }),
      slots: createSideCallSlots({ limit: () => 1, busy: () => 0 }),
      workDirectory: () => ({ path: "/tmp", remove: () => {} }),
    });
  }

  /**
   * A consolidator whose consolidation calls `sideCall` answers. The skill
   * proposal call made after a consolidation succeeds (EO-575) is
   * `proposeSkills`'s, which proposes nothing unless a case says so: most
   * cases here are about the consolidation alone.
   */
  function consolidatorWith(
    sideCall: (request: ConsolidateRequest) => Promise<Answer>,
    options: {
      now?: () => number;
      canStart?: () => boolean;
      pipelineBusy?: () => boolean;
      neighbours?: MemoryConsolidatorOptions["neighbours"];
      heldElsewhere?: MemoryConsolidatorOptions["heldElsewhere"];
      onPendingChanged?: MemoryConsolidatorOptions["onPendingChanged"];
      proposeSkills?: (request: SideCallRequest<unknown>) => Promise<SideCallResult<unknown>>;
      sendMessage?: MemoryConsolidatorOptions["sendMessage"];
    } = {},
  ): MemoryConsolidator {
    const proposeSkills = options.proposeSkills ?? (async () => ({ ok: true as const, value: { skills: [] } }));
    consolidator = createMemoryConsolidator({
      db: handle.db,
      sideCall: ((request: SideCallRequest<unknown>) =>
        request.system === MEMORY_PROPOSE_SKILLS_SYSTEM ? proposeSkills(request) : sideCall(request as ConsolidateRequest)) as never,
      ...(options.now ? { now: options.now } : {}),
      ...(options.canStart ? { canStart: options.canStart } : {}),
      ...(options.pipelineBusy ? { pipelineBusy: options.pipelineBusy } : {}),
      ...(options.neighbours ? { neighbours: options.neighbours } : {}),
      ...(options.heldElsewhere ? { heldElsewhere: options.heldElsewhere } : {}),
      ...(options.onPendingChanged ? { onPendingChanged: options.onPendingChanged } : {}),
      ...(options.sendMessage ? { sendMessage: options.sendMessage } : {}),
    });
    return consolidator;
  }

  /**
   * Starts a consolidator and asks for every scope holding an agent's
   * entry to be consolidated now (`manual`, EO-589): size never starts
   * one (EO-913), and a person's asking gives it the whole scope, as the
   * cap once did. A scope with nothing an agent wrote is refused, and
   * nothing more.
   */
  function askNow(runner: MemoryConsolidator): MemoryConsolidator {
    runner.start();
    for (const scope of [workspace, project]) runner.requestNow(scope);
    return runner;
  }

  /**
   * Makes `entries`' scope due on the schedule (EO-480): five runs given
   * them, the entries already more than a day old.
   */
  function givenToFiveRuns(entries: readonly MemoryEntryView[]): void {
    for (let index = 0; index < 5; index += 1) {
      const run = createRun(handle.db, { itemId, agentId: listAgents(handle.db)[0]!.id, action: "implement", status: "succeeded" });
      appendRunEvent(handle.db, run.id, MEMORY_DELIVERED_EVENT, { type: MEMORY_DELIVERED_EVENT, entryIds: entries.map((entry) => entry.id), candidateCount: entries.length, mode: "all", selectionRan: false, reason: null });
    }
  }

  /** Every row of a scope, active and retired, as a comparable snapshot. */
  function everything(scope: MemoryScope) {
    return listMemories(handle.db, scope, { includeRetired: true });
  }

  describe("what queues one", () => {
    it("is never a scope reaching the old caps of 200 entries or 40,000 characters, with no entry new since its last consolidation (EO-913)", () => {
      const at = Date.now() - 10 * DAY;
      // 250 entries of 300 characters: over both of the caps that once queued one.
      const notes = Array.from({ length: 250 }, (_, index) => byAgent(project, `Distinct fact ${index}: ${"q".repeat(280)}`, at + index));
      for (let index = 0; index < 20; index += 1) byPerson(project, `Person ${index}`, at + index);
      const done = startConsolidation(handle.db, { scope: project, trigger: "schedule", now: Date.now() - 3 * DAY });
      applyConsolidation(handle.db, { id: done.id, sent: [], answer: NOTHING, note: null, now: Date.now() - 3 * DAY });
      markConsolidationRunFinished(handle.db, done.id);
      // Many runs given it since, and days past: due on everything but something new.
      for (let index = 0; index < 8; index += 1) {
        const run = createRun(handle.db, { itemId, agentId: listAgents(handle.db)[0]!.id, action: "implement", status: "succeeded" });
        appendRunEvent(handle.db, run.id, MEMORY_DELIVERED_EVENT, { type: MEMORY_DELIVERED_EVENT, entryIds: [notes[0]!.id], candidateCount: 1, mode: "all", selectionRan: false, reason: null });
      }
      const sideCall = vi.fn();
      const runner = consolidatorWith(sideCall);

      expect(runner.check()).toEqual([]);
      runner.start();
      expect(runner.pending(project)).toBeNull();
      expect(sideCall).not.toHaveBeenCalled();
      expect(listConsolidations(handle.db, project)).toHaveLength(1);
      runner.stop();

      // One new note is all it lacked: then it is due on the schedule, and on nothing else.
      byAgent(project, "One more fact.", Date.now());
      expect(consolidatorWith(sideCall).check()).toEqual([{ scope: project, trigger: "schedule" }]);
    });

    it("is never a scope whose project or workspace is gone", () => {
      for (let index = 0; index < 12; index += 1) byAgent(workspace, `Note ${index}`, Date.now() - HOUR + index);
      handle.db.run(sql`update memories set scope_id = 'gone' where scope_kind = 'workspace'`);
      const runner = consolidatorWith(vi.fn());
      expect(runner.check()).toEqual([]);
    });

    it("is a day and five runs given the scope's memory since it was last consolidated — not four, and not within the day (fake clock)", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const start = Date.parse("2026-10-01T09:00:00Z");
      vi.setSystemTime(start);
      const note = byAgent(workspace, "The ledger is in UTC.", start);
      const elsewhere = byAgent(project, "Payments settle at noon.", start);
      const deliveredRuns = (count: number, ids: string[]) => {
        for (let index = 0; index < count; index += 1) {
          vi.setSystemTime(Date.now() + HOUR);
          const run = createRun(handle.db, { itemId, agentId: listAgents(handle.db)[0]!.id, action: "implement", status: "succeeded" });
          appendRunEvent(handle.db, run.id, MEMORY_DELIVERED_EVENT, { type: MEMORY_DELIVERED_EVENT, entryIds: ids, candidateCount: ids.length, mode: "all", selectionRan: false, reason: null });
        }
      };
      let clock = start;
      const runner = consolidatorWith(vi.fn(), { now: () => clock });

      // Four runs given the workspace's memory, and more given only the project's.
      deliveredRuns(4, [note.id]);
      deliveredRuns(3, [elsewhere.id]);
      clock = start + DAY + HOUR * 8;
      expect(runner.check()).toEqual([]);

      // A fifth: the workspace is due, the project (three runs) is not.
      deliveredRuns(1, [note.id, elsewhere.id]);
      clock = start + DAY + HOUR * 9;
      expect(runner.check()).toEqual([{ scope: workspace, trigger: "schedule" }]);
    });

    it("counts runs by when they were given the scope's memory, not when they were made (fake clock)", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      // Ahead of any id already minted: UUIDv7 never goes backwards, and these runs must be older than the consolidation.
      const start = Date.now() + 365 * DAY;
      vi.setSystemTime(start);
      const note = byAgent(workspace, "The ledger is in UTC.", start - 10 * DAY);
      // Five runs made before the last consolidation...
      const early = Array.from({ length: 5 }, () => createRun(handle.db, { itemId, agentId: listAgents(handle.db)[0]!.id, action: "implement", status: "awaiting_input" }));
      vi.setSystemTime(start + HOUR);
      const done = startConsolidation(handle.db, { scope: workspace, trigger: "schedule", now: start + HOUR });
      applyConsolidation(handle.db, { id: done.id, sent: [], answer: NOTHING, note: null, now: start + HOUR });
      markConsolidationRunFinished(handle.db, done.id);
      // Something new since it, which is what a scheduled one is given (EO-913).
      byAgent(workspace, "Payments settle at noon.", start + 2 * HOUR);
      // ...each given the scope's memory after it (a reply to a parked run, say).
      for (const run of early) {
        vi.setSystemTime(Date.now() + HOUR);
        appendRunEvent(handle.db, run.id, MEMORY_DELIVERED_EVENT, { type: MEMORY_DELIVERED_EVENT, entryIds: [note.id], candidateCount: 1, mode: "all", selectionRan: false, reason: null });
      }
      const runner = consolidatorWith(vi.fn(), { now: () => start + HOUR + DAY + 1 });
      expect(runner.check()).toEqual([{ scope: workspace, trigger: "schedule" }]);
    });

    it("counts deliveries through the partial index over memory_delivered rows, not by reading every transcript", () => {
      const plan = handle.db
        .all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${runsDeliveredFromScopeQuery(workspace, 0)}`)
        .map((row) => row.detail)
        .join("\n");
      expect(plan).toContain("idx_run_events_memory_delivered");
    });

    it("is not the schedule for a scope consolidated within the day, however many runs it was given since", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const start = Date.parse("2026-10-01T09:00:00Z");
      vi.setSystemTime(start);
      const note = byAgent(workspace, "The ledger is in UTC.", start - 10 * DAY);
      const done = startConsolidation(handle.db, { scope: workspace, trigger: "schedule", now: start - 2 * HOUR });
      applyConsolidation(handle.db, { id: done.id, sent: [], answer: NOTHING, note: null, now: start - HOUR });
      markConsolidationRunFinished(handle.db, done.id);
      for (let index = 0; index < 8; index += 1) {
        const run = createRun(handle.db, { itemId, agentId: listAgents(handle.db)[0]!.id, action: "implement", status: "succeeded" });
        appendRunEvent(handle.db, run.id, MEMORY_DELIVERED_EVENT, { type: MEMORY_DELIVERED_EVENT, entryIds: [note.id], candidateCount: 1, mode: "all", selectionRan: false, reason: null });
      }
      const runner = consolidatorWith(vi.fn(), { now: () => start + 20 * HOUR });
      expect(runner.check()).toEqual([]);
    });
  });

  describe("a consolidation that succeeds", () => {
    it("is one memory_consolidate side call on the system agent's backend, made on its own, given only the agents' entries and the workspace's CLAUDE.md", async () => {
      const at = Date.now() - 3 * DAY;
      const agents = Array.from({ length: 8 }, (_, index) => byAgent(workspace, `Agent note ${index}`, at + index));
      byPerson(workspace, "A person wrote this.", at);
      byPerson(workspace, "And this.", at);
      const sideCall = vi.fn(async (_request: ConsolidateRequest): Promise<Answer> => ({ ok: true, value: mergeAll(agents, "Merged.") }));

      askNow(consolidatorWith(sideCall));
      await consolidator!.idle();

      expect(sideCall).toHaveBeenCalledTimes(1);
      const request = sideCall.mock.calls[0]![0];
      expect(request).toMatchObject({ purpose: "memory_consolidate", backend: systemBackend, projectId });
      expect(request.insideRunId).toBeUndefined();
      expect(request.itemId).toBeUndefined();
      for (const entry of agents) expect(request.input).toContain(entry.id);
      expect(request.input).not.toContain("A person wrote this.");
      expect(request.input).not.toContain("And this.");
      expect(request.input).toContain("## The workspace's CLAUDE.md");
      expect(request.input).toContain("Run the tests with `pnpm test:api`.");
      // No size to reach (EO-913).
      expect(request.input).not.toMatch(/target/i);
    });

    it("retires, merges and rewrites under one consolidation id, leaves what it does not name, keeps the newest replaced entry's age, and restore puts the earlier set back", async () => {
      const at = Date.now() - 3 * DAY;
      const agents = Array.from({ length: 18 }, (_, index) =>
        byAgent(workspace, index === 3 ? `Run the tests with \`make test\`. Agent note 3: ${"z".repeat(600)}` : `Agent note ${index}: ${"z".repeat(600)}`, at + index * HOUR),
      );
      const people = [byPerson(workspace, "A person wrote this.", at), byPerson(workspace, "And this.", at)];
      const before = listMemories(handle.db, workspace).map((entry) => [entry.id, entry.body, entry.createdAt]);
      // Held to the real schema: the rewrite puts the CLAUDE.md's sentence in place of the one it corrects.
      const rewritten = `Run the tests with \`pnpm test:api\`. Agent note 3: ${"z".repeat(600)}`;
      const sideCall = answeringWith({
        // agents[0] is in no operation: it stays as it was.
        retire: agents.slice(4).map((entry) => ({ id: entry.id, reason: "Stale: the flow it describes is gone." })),
        merge: [{ body: "Tests need Postgres 16 (since 2026-10-15).", from: [agents[2]!.id, agents[1]!.id], contradictsRepositoryFile: false }],
        rewrite: [{ id: agents[3]!.id, body: rewritten, contradictsRepositoryFile: false, reason: "repository_file" }],
      }).sideCall;

      askNow(consolidatorWith(sideCall));
      await consolidator!.idle();

      const [consolidation] = listConsolidations(handle.db, workspace);
      expect(consolidation).toMatchObject({ status: "succeeded", trigger: "manual" });
      const all = everything(workspace);
      const active = all.filter((entry) => entry.retiredAt === null);
      const retired = all.filter((entry) => entry.retiredAt !== null);

      expect(retired.map((entry) => entry.id).sort()).toEqual(agents.slice(1).map((entry) => entry.id).sort());
      for (const entry of retired) expect(entry).toMatchObject({ retiredReason: "consolidated", consolidationId: consolidation!.id });
      expect(consolidation!.retiredIds.sort()).toEqual(retired.map((entry) => entry.id).sort());

      const written = active.filter((entry) => entry.consolidationId === consolidation!.id);
      expect(written.map((entry) => entry.body).sort()).toEqual([rewritten, "Tests need Postgres 16 (since 2026-10-15)."].sort());
      expect(consolidation!.writtenIds.sort()).toEqual(written.map((entry) => entry.id).sort());
      // A merged entry keeps the age and source of the newest it replaced, whatever order `from` names them in…
      expect(written.find((entry) => entry.body.startsWith("Tests need"))).toMatchObject({ createdAt: agents[2]!.createdAt, source: { type: "run", runId, itemId } });
      // …and a rewritten one its own entry's.
      expect(written.find((entry) => entry.body === rewritten)).toMatchObject({ createdAt: agents[3]!.createdAt, contradictsRepositoryFile: false });

      expect(active.find((entry) => entry.id === agents[0]!.id)).toMatchObject({ consolidationId: null, retiredAt: null, body: agents[0]!.body });
      for (const person of people) expect(active.find((entry) => entry.id === person.id)).toMatchObject({ retiredAt: null, body: person.body });

      // Restore puts back the set from before it, and retires what it wrote.
      const restored = restoreConsolidation(handle.db, consolidation!.id);
      expect(restored).toMatchObject({ ok: true, restored: 17, retired: 2 });
      expect(listMemories(handle.db, workspace).map((entry) => [entry.id, entry.body, entry.createdAt])).toEqual(before);
    });

    it("skips, in the repository, a rewrite that is its entry word for word with the same flag, leaving that entry as it is", () => {
      // The answer schema refuses such a rewrite (EO-913); what applying one does is the repository's, so it is tested there.
      const agents = Array.from({ length: 10 }, (_, index) => byAgent(workspace, `Note ${index}`, Date.now() - DAY + index));
      const row = startConsolidation(handle.db, { scope: workspace, trigger: "manual", now: Date.now() });
      const applied = applyConsolidation(handle.db, {
        id: row.id,
        sent: agents,
        answer: { ...NOTHING, retire: [{ id: agents[1]!.id, reason: "Stale." }], rewrite: [{ id: agents[0]!.id, body: agents[0]!.body, contradictsRepositoryFile: false }] },
        note: null,
        now: Date.now(),
      });
      expect(applied.ok).toBe(true);

      const [consolidation] = listConsolidations(handle.db, workspace);
      expect(consolidation).toMatchObject({ status: "succeeded", retiredIds: [agents[1]!.id], writtenIds: [] });
      expect(listMemories(handle.db, workspace).find((entry) => entry.id === agents[0]!.id)).toMatchObject({ consolidationId: null, retiredAt: null });
    });

    it("stores an entry flagged as contradicting the workspace's file with that flag, and never changes the file", async () => {
      const before = { text: readFileSync(join(folder, "CLAUDE.md"), "utf8"), modified: statSync(join(folder, "CLAUDE.md")).mtimeMs };
      const agents = Array.from({ length: 10 }, (_, index) => byAgent(workspace, `Note ${index}`, Date.now() - DAY + index));
      // Held to the real schema: a flag is set by a merge, which carries the entry it is about; a rewrite never sets one.
      const sideCall = answeringWith({
        retire: [],
        merge: [
          { body: "The ledger is in UTC.", from: agents.slice(0, 8).map((entry) => entry.id), contradictsRepositoryFile: false },
          { body: "Run the API tests with `make test`; `pnpm test:api` was removed on 2026-10-12.", from: [agents[8]!.id, agents[9]!.id], contradictsRepositoryFile: true },
        ],
        rewrite: [],
      }).sideCall;

      askNow(consolidatorWith(sideCall));
      await consolidator!.idle();

      const active = listMemories(handle.db, workspace);
      expect(active.find((entry) => entry.body.startsWith("Run the API tests"))).toMatchObject({ contradictsRepositoryFile: true });
      expect(active.find((entry) => entry.body === "The ledger is in UTC.")).toMatchObject({ contradictsRepositoryFile: false });
      expect(readFileSync(join(folder, "CLAUDE.md"), "utf8")).toBe(before.text);
      expect(statSync(join(folder, "CLAUDE.md")).mtimeMs).toBe(before.modified);
    });

    it("gives a workspace its AGENTS.md as well when there is one", () => {
      writeFileSync(join(folder, "AGENTS.md"), "Agents read this.");
      expect(readRepositoryFiles(handle.db, workspace).map((file) => file.name)).toEqual(["CLAUDE.md", "AGENTS.md"]);
    });

    it("gives a project its workspaces' files, each named with its workspace and sharing one workspace's room (EO-514)", () => {
      const second = mkdtempSync(join(tmpdir(), "eo-consolidation-"));
      try {
        writeFileSync(join(second, "AGENTS.md"), "x".repeat(20_000));
        const web = attachWorkspace(handle.db, { keyPrefix: "W", name: "web", repoPath: second });
        handle.db.run(sql`update workspaces set project_id = ${projectId} where id = ${web.id}`);

        const files = readRepositoryFiles(handle.db, project);

        expect(files.map((file) => [file.workspace, file.name])).toEqual([
          ["api", "CLAUDE.md"],
          ["web", "AGENTS.md"],
        ]);
        expect(files[0]!.text).toBe(CLAUDE_MD);
        // Two workspaces share the 30,000 characters one is given.
        expect(files[1]).toMatchObject({ truncated: true });
        expect(files[1]!.text).toHaveLength(15_000);
      } finally {
        rmSync(second, { recursive: true, force: true });
      }
    });

    it("checks a project's entries against its workspace's CLAUDE.md, and keeps the flag on one that corrects it (EO-514)", async () => {
      const at = Date.now() - 3 * DAY;
      const agents = Array.from({ length: 10 }, (_, index) => byAgent(project, `Project note ${index}`, at + index));
      // Held to the real schema: the flag goes on the merge that carries the correcting entry.
      const sideCall = vi.fn(
        answeringWith({
          retire: [],
          merge: [
            { body: "The ledger is in UTC.", from: agents.slice(0, 8).map((entry) => entry.id), contradictsRepositoryFile: false },
            { body: "Run the API tests with `make test`; `pnpm test:api` was removed on 2026-10-12.", from: [agents[8]!.id, agents[9]!.id], contradictsRepositoryFile: true },
          ],
          rewrite: [],
        }).sideCall as (request: ConsolidateRequest) => Promise<Answer>,
      );

      askNow(consolidatorWith(sideCall));
      await consolidator!.idle();

      expect(sideCall).toHaveBeenCalledTimes(1);
      expect(sideCall.mock.calls[0]![0].input).toContain(`## The workspace "api"'s CLAUDE.md`);
      expect(sideCall.mock.calls[0]![0].input).toContain("Run the tests with `pnpm test:api`.");
      expect(listMemories(handle.db, project).find((entry) => entry.body.startsWith("Run the API tests"))).toMatchObject({ contradictsRepositoryFile: true });
    });
  });

  describe("the progress an answer makes (EO-573)", () => {
    function fill(count = 10) {
      return Array.from({ length: count }, (_, index) => byAgent(workspace, `Note ${index}`, Date.now() - DAY + index));
    }

    it("applies an answer however little it changes: one retirement of ten", async () => {
      const notes = fill();
      const caller = answeringWith({ ...NOTHING, retire: [{ id: notes[0]!.id, reason: "Stale." }] });

      askNow(consolidatorWith(caller.sideCall));
      await consolidator!.idle();

      expect(listConsolidations(handle.db, workspace)[0]).toMatchObject({ status: "succeeded", retiredIds: [notes[0]!.id], writtenIds: [] });
      expect(listMemories(handle.db, workspace)).toHaveLength(9);
      expect(listSideCalls(handle.db)).toMatchObject([{ purpose: "memory_consolidate", outcome: "succeeded" }]);
    });

    it("refuses, with reason schema, a rewrite that gives no reason — one that only shortens an entry — and changes nothing (EO-913)", async () => {
      const notes = fill();
      const before = everything(workspace);
      const caller = answeringWith({ ...NOTHING, retire: [{ id: notes[1]!.id, reason: "Stale." }], rewrite: [{ id: notes[0]!.id, body: "Note.", contradictsRepositoryFile: false }] });

      askNow(consolidatorWith(caller.sideCall));
      await consolidator!.idle();

      expect(everything(workspace)).toEqual(before);
      expect(listConsolidations(handle.db, workspace)[0]).toMatchObject({ status: "failed", retiredIds: [], writtenIds: [] });
      expect(listConsolidations(handle.db, workspace)[0]!.note).toContain("rewrite.0.reason");
      expect(listSideCalls(handle.db)).toMatchObject([{ purpose: "memory_consolidate", outcome: "failed", reason: "schema" }]);
    });

    it("applies a rewrite that gives its reason though it makes the entry longer, as an absolute date does (EO-913)", async () => {
      fill();
      const dated = byAgent(workspace, "The ledger moved to UTC yesterday.", Date.parse("2026-11-21T09:00:00Z"));
      const longer = "The ledger moved to UTC on November 20, 2026.";
      const caller = answeringWith({ ...NOTHING, rewrite: [{ id: dated.id, body: longer, contradictsRepositoryFile: false, reason: "relative_date" }] });

      askNow(consolidatorWith(caller.sideCall));
      await consolidator!.idle();

      expect(listConsolidations(handle.db, workspace)[0]).toMatchObject({ status: "succeeded", retiredIds: [dated.id] });
      expect(listMemories(handle.db, workspace).map((entry) => entry.body)).toContain(longer);
    });

    for (const operation of ["merge", "rewrite"] as const) {
      it(`refuses, with reason schema, an answer with a ${operation} longer than ${String(MAX_MEMORY_NOTE_CHARS)} characters, and changes nothing (EO-591)`, async () => {
        const notes = fill();
        const before = everything(workspace);
        const body = "x".repeat(MAX_MEMORY_NOTE_CHARS + 1);
        const retire = [{ id: notes[2]!.id, reason: "Stale." }];
        const caller = answeringWith(
          operation === "merge"
            ? { ...NOTHING, retire, merge: [{ from: [notes[0]!.id, notes[1]!.id], body, contradictsRepositoryFile: false }] }
            : { ...NOTHING, retire, rewrite: [{ id: notes[0]!.id, body, contradictsRepositoryFile: false, reason: "newer_entry" }] },
        );

        askNow(consolidatorWith(caller.sideCall));
        await consolidator!.idle();

        expect(everything(workspace)).toEqual(before);
        expect(listConsolidations(handle.db, workspace)[0]).toMatchObject({ status: "failed", retiredIds: [], writtenIds: [] });
        expect(listConsolidations(handle.db, workspace)[0]!.note).toContain(`${operation}.0.body`);
        expect(listSideCalls(handle.db)).toMatchObject([{ purpose: "memory_consolidate", outcome: "failed", reason: "schema" }]);
      });
    }

    it("takes an empty answer as a no-op: nothing applied, and the consolidation succeeded", async () => {
      fill();
      const before = everything(workspace);
      const caller = answeringWith(NOTHING);
      const runner = consolidatorWith(caller.sideCall);

      askNow(runner);
      await runner.idle();

      expect(everything(workspace)).toEqual(before);
      expect(listConsolidations(handle.db, workspace)).toMatchObject([{ status: "succeeded", retiredIds: [], writtenIds: [] }]);
      // Not asked again: nothing is new since it, and the day has not passed.
      expect(runner.check()).toEqual([]);
    });
  });

  /**
   * What a consolidation runs on (EO-578): the system agent's backend,
   * model and reasoning effort, with its consolidation override laid over
   * the last two — read at each consolidation, so a change to the agent
   * is the next one's.
   */
  describe("the model it runs on (EO-578)", () => {
    const systemAgent = () => listAgents(handle.db).find((agent) => agent.role === "system")!;
    function setSystemAgent(patch: { provider: string; model: string | null; config?: Record<string, unknown> }) {
      const agent = systemAgent();
      updateAgent(handle.db, agent.id, { provider: patch.provider, model: patch.model, config: { ...agent.config, ...patch.config } });
    }
    function fill(scope: MemoryScope, count = 10) {
      return Array.from({ length: count }, (_, index) => byAgent(scope, `Note ${index} of ${scope.kind}`, Date.now() - DAY + index));
    }
    const asked = () => {
      const requests: ConsolidateRequest[] = [];
      const sideCall = vi.fn(async (request: ConsolidateRequest): Promise<Answer> => {
        requests.push(request);
        return { ok: true, value: NOTHING };
      });
      return { requests, sideCall };
    };

    it("is the system agent's backend, model and reasoning effort, and follows a change to any of them", async () => {
      setSystemAgent({ provider: "claude", model: "claude-opus-5-5", config: { effort: "high" } });
      fill(workspace);
      const first = asked();
      askNow(consolidatorWith(first.sideCall));
      await consolidator!.idle();
      consolidator!.stop();

      expect(first.requests).toHaveLength(1);
      expect(first.requests[0]).toMatchObject({ purpose: "memory_consolidate", backend: "claude", model: { model: "claude-opus-5-5", reasoningEffort: "high" } });

      // Moved to Codex, on another model and effort, each under Codex's own key.
      setSystemAgent({ provider: "codex", model: "gpt-6-sol", config: { effort: undefined, reasoningEffort: "xhigh" } });
      fill(project);
      const second = asked();
      askNow(consolidatorWith(second.sideCall));
      await consolidator!.idle();

      expect(second.requests.map((request) => [request.backend, request.model])).toContainEqual(["codex", { model: "gpt-6-sol", reasoningEffort: "xhigh" }]);
    });

    /**
     * The skill proposal call made after a run succeeds (EO-575): its own
     * system prompt, the same purpose, and the same system agent's
     * backend, model and effort as the consolidation before it.
     */
    it("runs the skill proposal call after a consolidation on the system agent's backend, model and effort, and follows a change to any of them or to the override", async () => {
      const proposing = (request: ConsolidateRequest) => request.system === MEMORY_PROPOSE_SKILLS_SYSTEM;
      const answering = () => {
        const requests: ConsolidateRequest[] = [];
        const sideCall = vi.fn(async (request: ConsolidateRequest): Promise<Answer> => {
          requests.push(request);
          if (proposing(request)) return { ok: true, value: { skills: [] } } as unknown as Answer;
          // Retire the first entry it was given: a consolidation that applied something, which a proposal follows.
          const first = /### (\S+) \(written/.exec(request.input)![1]!;
          return { ok: true, value: { ...NOTHING, retire: [{ id: first, reason: "Stale." }] } };
        });
        // The helper routes the proposal call apart from the consolidation's: both are recorded here.
        const proposeSkills = (request: SideCallRequest<unknown>) => sideCall(request as ConsolidateRequest) as Promise<SideCallResult<unknown>>;
        return { requests, sideCall, proposeSkills };
      };

      setSystemAgent({ provider: "claude", model: "claude-opus-5-5", config: { effort: "high" } });
      fill(workspace);
      const first = answering();
      askNow(consolidatorWith(first.sideCall, { proposeSkills: first.proposeSkills }));
      await consolidator!.idle();
      consolidator!.stop();

      const firstProposal = first.requests.filter(proposing);
      expect(firstProposal).toHaveLength(1);
      expect(firstProposal[0]).toMatchObject({ purpose: "memory_consolidate", backend: "claude", model: { model: "claude-opus-5-5", reasoningEffort: "high" } });

      // Moved to Codex, with its effort under Codex's key and an override model.
      setSystemAgent({ provider: "codex", model: "gpt-6-sol", config: { effort: undefined, reasoningEffort: "xhigh", consolidationModel: "gpt-6.1-sol" } });
      fill(project);
      const second = answering();
      askNow(consolidatorWith(second.sideCall, { proposeSkills: second.proposeSkills }));
      await consolidator!.idle();

      const secondProposal = second.requests.filter(proposing);
      expect(secondProposal.length).toBeGreaterThan(0);
      for (const request of secondProposal) expect(request).toMatchObject({ purpose: "memory_consolidate", backend: "codex", model: { model: "gpt-6.1-sol", reasoningEffort: "xhigh" } });
      // And the consolidation calls of the same run on the same.
      for (const request of second.requests) expect(request.model).toEqual({ model: "gpt-6.1-sol", reasoningEffort: "xhigh" });
    });

    it("hands the backend the system agent's model and effort on the skill proposal call, through the real side caller", async () => {
      setSystemAgent({ provider: "claude", model: "claude-opus-5-5", config: { effort: "high" } });
      const notes = fill(workspace);
      const { caller, seen, smallModel } = realCaller((options) =>
        options.system === MEMORY_PROPOSE_SKILLS_SYSTEM
          ? [{ type: "result", data: { skills: [] } }]
          : [{ type: "result", data: { ...NOTHING, retire: [{ id: notes[0]!.id, reason: "Stale." }] } }],
      );

      askNow(consolidatorWith(caller.sideCall, { proposeSkills: (request) => caller.sideCall(request) }));
      await consolidator!.idle();

      const proposal = seen.find((options) => options.system === MEMORY_PROPOSE_SKILLS_SYSTEM);
      expect(proposal).toMatchObject({ model: "claude-opus-5-5", reasoningEffort: "high" });
      expect(smallModel).not.toHaveBeenCalled();
      expect(listSideCalls(handle.db)).toMatchObject([
        { purpose: "memory_consolidate", model: "claude-opus-5-5", outcome: "succeeded" },
        { purpose: "memory_consolidate", model: "claude-opus-5-5", outcome: "succeeded" },
      ]);
    });

    it("is the backend's defaults where the system agent names no model and no effort", () => {
      setSystemAgent({ provider: "claude", model: null, config: { effort: undefined } });
      expect(systemAgentSetup(handle.db)).toEqual({ backend: "claude", model: null, reasoningEffort: null });
    });

    it.each([
      { override: {}, expected: { model: "claude-opus-5-5", reasoningEffort: "medium" } },
      { override: { consolidationModel: "claude-sonnet-5-5" }, expected: { model: "claude-sonnet-5-5", reasoningEffort: "medium" } },
      { override: { consolidationReasoningEffort: "max" }, expected: { model: "claude-opus-5-5", reasoningEffort: "max" } },
      { override: { consolidationModel: "claude-sonnet-5-5", consolidationReasoningEffort: "max" }, expected: { model: "claude-sonnet-5-5", reasoningEffort: "max" } },
      { override: { consolidationModel: "", consolidationReasoningEffort: "" }, expected: { model: "claude-opus-5-5", reasoningEffort: "medium" } },
    ])("takes the override $override from the system agent's own configuration, each field set replacing the agent's and each empty one following it", ({ override, expected }) => {
      setSystemAgent({ provider: "claude", model: "claude-opus-5-5", config: { effort: "medium", ...override } });
      expect(systemAgentSetup(handle.db)).toEqual({ backend: "claude", ...expected });
    });

    it("is null, and the consolidation fails as it always has, with no enabled system agent", async () => {
      updateAgent(handle.db, systemAgent().id, { enabled: false });
      expect(systemAgentSetup(handle.db)).toBeNull();
      fill(workspace);
      const { sideCall } = asked();
      askNow(consolidatorWith(sideCall));
      await consolidator!.idle();

      expect(sideCall).not.toHaveBeenCalled();
      expect(listConsolidations(handle.db, workspace)[0]).toMatchObject({ status: "failed", note: expect.stringContaining("no enabled system agent") });
    });

    /** The real side caller over a backend that records what it was handed and answers, or refuses the model. */
    function realCaller(answer: (options: AgentSideCallOptions) => AgentEvent[]) {
      const seen: AgentSideCallOptions[] = [];
      const provider = {
        async *sideCall(options: AgentSideCallOptions): AsyncIterable<AgentEvent> {
          seen.push(options);
          for (const event of answer(options)) yield event;
        },
      } as unknown as AgentProvider;
      const smallModel = vi.fn(async () => "claude-haiku-5-5");
      const caller = createSideCaller({
        db: handle.db,
        provider: () => provider,
        smallModel,
        guards: () => ({ perItemBudgetCents: null, dailyBudgetCents: null }),
        slots: createSideCallSlots({ limit: () => 1, busy: () => 0 }),
        workDirectory: () => ({ path: "/tmp", remove: () => {} }),
      });
      return { caller, seen, smallModel };
    }

    it("hands the backend the override's model and the agent's effort, never the small model, and records the model used", async () => {
      setSystemAgent({ provider: "claude", model: "claude-opus-5-5", config: { effort: "high", consolidationModel: "claude-sonnet-5-5" } });
      fill(workspace);
      const { caller, seen, smallModel } = realCaller(() => [
        { type: "usage", scope: "session", tokensIn: 30_000, tokensOut: 1_500, costCents: 25 },
        { type: "result", data: NOTHING },
      ]);

      askNow(consolidatorWith(caller.sideCall));
      await consolidator!.idle();

      expect(seen[0]).toMatchObject({ model: "claude-sonnet-5-5", reasoningEffort: "high" });
      expect(smallModel).not.toHaveBeenCalled();
      expect(listSideCalls(handle.db)).toMatchObject([{ purpose: "memory_consolidate", backend: "claude", model: "claude-sonnet-5-5", costMicrocents: 25_000_000, outcome: "succeeded" }]);
    });

    it("fails on a model the backend cannot run with a sentence naming it, and backs off as any failure does", async () => {
      setSystemAgent({ provider: "claude", model: "claude-opus-5-5", config: { consolidationModel: "claude-opus-9" } });
      givenToFiveRuns(fill(workspace));
      const before = everything(workspace);
      let clock = Date.now() + DAY;
      const { caller } = realCaller(() => [
        { type: "error", message: "There's an issue with the selected model (claude-opus-9). It may not exist or you may not have access to it.", retryable: false },
      ]);
      const runner = consolidatorWith(caller.sideCall, { now: () => clock });

      runner.start();
      await runner.idle();

      expect(everything(workspace)).toEqual(before);
      expect(listConsolidations(handle.db, workspace)[0]).toMatchObject({ status: "failed", note: expect.stringMatching(/^The claude backend cannot run the model "claude-opus-9": /) });
      expect(listSideCalls(handle.db)).toMatchObject([{ purpose: "memory_consolidate", model: "claude-opus-9", outcome: "failed", reason: "error" }]);
      expect(runner.check()).toEqual([]);
      clock += CONSOLIDATION_BACKOFF_MS[0];
      expect(runner.check()).toEqual([{ scope: workspace, trigger: "schedule" }]);
    });
  });

  describe("a consolidation that fails", () => {
    function fill(count = 10) {
      return Array.from({ length: count }, (_, index) => byAgent(workspace, `Note ${index}`, Date.now() - DAY + index));
    }

    it("changes no entry when the side call fails, and is asked again only after its backoff (scripted side call)", async () => {
      givenToFiveRuns(fill());
      const before = everything(workspace);
      let clock = Date.now() + DAY;
      const sideCall = vi.fn(async (): Promise<Answer> => ({ ok: false, reason: "error", message: "The backend fell over." }));
      const runner = consolidatorWith(sideCall, { now: () => clock });

      runner.start();
      await runner.idle();

      expect(sideCall).toHaveBeenCalledTimes(1);
      expect(everything(workspace)).toEqual(before);
      expect(listConsolidations(handle.db, workspace)[0]).toMatchObject({ status: "failed", note: "The backend fell over.", retiredIds: [], writtenIds: [] });

      expect(runner.check()).toEqual([]);
      clock += CONSOLIDATION_BACKOFF_MS[0];
      expect(runner.check()).toEqual([{ scope: workspace, trigger: "schedule" }]);
    });

    it("changes no entry when the answer fails its schema, through the real side caller", async () => {
      const notes = fill();
      const before = everything(workspace);
      const answering = (data: unknown): AgentProvider =>
        ({
          async *sideCall(): AsyncIterable<AgentEvent> {
            yield { type: "result", data } satisfies AgentEvent;
          },
        }) as unknown as AgentProvider;
      // A retirement of an entry it was given, and a rewrite of one it was never given: neither is applied.
      const tooMany = { ...NOTHING, retire: [{ id: notes[0]!.id, reason: "Stale." }], rewrite: [{ id: "not-an-entry", body: "Invented.", contradictsRepositoryFile: false, reason: "newer_entry" }] };
      const caller = createSideCaller({
        db: handle.db,
        provider: () => answering(tooMany),
        smallModel: async () => "small",
        guards: () => ({ perItemBudgetCents: null, dailyBudgetCents: null }),
        slots: createSideCallSlots({ limit: () => 1, busy: () => 0 }),
        workDirectory: () => ({ path: "/tmp", remove: () => {} }),
      });

      askNow(consolidatorWith(caller.sideCall));
      await consolidator!.idle();

      expect(everything(workspace)).toEqual(before);
      expect(listConsolidations(handle.db, workspace)[0]).toMatchObject({ status: "failed" });
      expect(listSideCalls(handle.db)).toMatchObject([{ purpose: "memory_consolidate", outcome: "failed", reason: "schema", itemId: null, runId: null, projectId }]);
    });

    it("changes nothing when an entry it was given is edited while it runs", async () => {
      const notes = fill();
      let release: (answer: Answer) => void = () => {};
      const sideCall = vi.fn(() => new Promise<Answer>((resolve) => (release = resolve)));
      askNow(consolidatorWith(sideCall));
      await vi.waitFor(() => expect(sideCall).toHaveBeenCalledTimes(1));

      retireMemory(handle.db, notes[0]!.id);
      const before = everything(workspace);
      release({ ok: true, value: mergeAll(notes, "All of it.") });
      await consolidator!.idle();

      expect(everything(workspace)).toEqual(before);
      expect(listConsolidations(handle.db, workspace)[0]).toMatchObject({ status: "failed" });
    });

    it("closes a consolidation a stopped process left running, so the scope is not stuck behind it", () => {
      fill();
      const left = startConsolidation(handle.db, { scope: workspace, trigger: "schedule", now: Date.now() - HOUR });
      askNow(consolidatorWith(vi.fn(async (): Promise<Answer> => ({ ok: false, reason: "timeout", message: "slow" }))));
      expect(getConsolidation(handle.db, left.id)).toMatchObject({ status: "failed" });
    });
  });

  describe("entries written while it waits or runs", () => {
    const keepFive = (request: ConsolidateRequest): Answer => {
      const ids = [...request.input.matchAll(/^### (\S+) /gm)].map((match) => match[1]!);
      return { ok: true, value: { ...NOTHING, merge: [{ body: `Folded ${ids.length}.`, from: ids, contradictsRepositoryFile: false }] } };
    };

    it("leaves notes added while the model answers as they are, and new to the next scheduled one (EO-913)", async () => {
      const originals = Array.from({ length: 10 }, (_, index) => byAgent(workspace, `Original ${index}`, Date.now() - DAY + index));
      const requests: ConsolidateRequest[] = [];
      let release: () => void = () => {};
      const sideCall = vi.fn(async (request: ConsolidateRequest): Promise<Answer> => {
        requests.push(request);
        if (requests.length === 1) await new Promise<void>((resolve) => (release = resolve));
        return keepFive(request);
      });
      askNow(consolidatorWith(sideCall));
      await vi.waitFor(() => expect(requests).toHaveLength(1));

      const added = Array.from({ length: 10 }, (_, index) => byAgent(workspace, `Added ${index}`, Date.now()));
      release();
      await consolidator!.idle();

      // It folded only what it was given; the additions were left as they
      // are, and are what the next scheduled one is given — not what it folded.
      expect(sideCall).toHaveBeenCalledTimes(1);
      for (const entry of originals) expect(requests[0]!.input).toContain(entry.id);
      for (const entry of added) expect(requests[0]!.input).not.toContain(entry.id);
      expect(listMemories(handle.db, workspace).map((entry) => entry.body).sort()).toEqual(["Folded 10.", ...added.map((entry) => entry.body)].sort());
      expect(entriesNewSinceConsolidated(handle.db, workspace).sort()).toEqual(added.map((entry) => entry.id).sort());
    });

    it("does the same for notes added while it waits for its slot", async () => {
      Array.from({ length: 10 }, (_, index) => byAgent(workspace, `Original ${index}`, Date.now() - DAY + index));
      let busy = 1;
      const slots = createSideCallSlots({ limit: () => 1, busy: () => busy, pollMs: 5 });
      const inputs: string[] = [];
      const provider = {
        async *sideCall(options: AgentSideCallOptions): AsyncIterable<AgentEvent> {
          inputs.push(options.input);
          const answer = keepFive({ input: options.input } as ConsolidateRequest);
          yield { type: "result", data: answer.ok ? answer.value : null } satisfies AgentEvent;
        },
      } as unknown as AgentProvider;
      const caller = createSideCaller({
        db: handle.db,
        provider: () => provider,
        smallModel: async () => "small",
        guards: () => ({ perItemBudgetCents: null, dailyBudgetCents: null }),
        slots,
        workDirectory: () => ({ path: "/tmp", remove: () => {} }),
      });
      askNow(consolidatorWith(caller.sideCall));
      await vi.waitFor(() => expect(slots.waiting()).toBe(1));

      const added = Array.from({ length: 10 }, (_, index) => byAgent(workspace, `Added ${index}`, Date.now()));
      busy = 0;
      await consolidator!.idle();

      expect(inputs).toHaveLength(1);
      for (const entry of added) expect(inputs[0]).not.toContain(entry.id);
      expect(entriesNewSinceConsolidated(handle.db, workspace).sort()).toEqual(added.map((entry) => entry.id).sort());
    });
  });

  describe("what a scheduled one is given (EO-913)", () => {
    type AnyRequest = SideCallRequest<unknown>;
    type AnyAnswer = SideCallResult<unknown>;
    const idsIn = (input: string) => [...input.matchAll(/^### (\S+) /gm)].map((match) => match[1]!);
    const ids = (entries: readonly MemoryEntryView[]) => entries.map((entry) => entry.id);
    const TOPICS = [
      "The payments ledger settles invoices in UTC at noon",
      "Playwright suites need a display server under xvfb",
      "Drizzle migrations are numbered and never edited after release",
      "Codex sessions keep their sign-in inside the keyring",
      "Renderer timestamps cross the IPC contract as epoch milliseconds",
      "The Windows runner is a virtual machine on a Linux host",
    ];

    /** 60 old entries, ten on each topic, settled by a consolidation three days ago. */
    function settledScope(): MemoryEntryView[] {
      const at = Date.now() - 10 * DAY;
      const old = Array.from({ length: 60 }, (_, index) => byAgent(project, `${TOPICS[index % TOPICS.length]!} (old note ${index}, detail ${"abcdefghij"[index % 10]!.repeat(3)}).`, at + index * HOUR));
      const done = startConsolidation(handle.db, { scope: project, trigger: "schedule", now: Date.now() - 3 * DAY });
      applyConsolidation(handle.db, { id: done.id, sent: [], answer: NOTHING, note: null, now: Date.now() - 3 * DAY });
      markConsolidationRunFinished(handle.db, done.id);
      return old;
    }

    it("is only the entries new since the last consolidation, each with up to 8 of its nearest neighbours by the full-text index, then skill proposals as ever", async () => {
      const old = settledScope();
      const fresh = [
        byAgent(project, "The payments ledger settles invoices in UTC at noon, and refunds at midnight.", Date.now()),
        byAgent(project, "Codex sessions keep their sign-in inside the keyring, unlocked at login.", Date.now() + 1),
      ];
      byPerson(project, "The payments ledger is a person's concern too.", Date.now());
      givenToFiveRuns(fresh);
      const requests: AnyRequest[] = [];
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        requests.push(request);
        return { ok: true, value: NOTHING };
      });
      const proposeSkills = vi.fn(async (): Promise<SideCallResult<unknown>> => ({ ok: true, value: { skills: [] } }));
      const runner = consolidatorWith(sideCall as never, { proposeSkills });
      expect(runner.check()).toEqual([{ scope: project, trigger: "schedule" }]);

      runner.start();
      await runner.idle();

      // One batch, of the two new entries and their neighbours: no cross-batch pass, and nothing else of the scope.
      expect(requests.map((request) => request.system)).toEqual([MEMORY_CONSOLIDATE_SYSTEM]);
      const given = idsIn(requests[0]!.input);
      const expected = new Set(ids(fresh));
      const all = listMemories(handle.db, project).filter((entry) => entry.source.type !== "person");
      for (const entry of fresh) {
        const nearest = similarMemoryNeighbours(handle.db, [entry], 8, all).get(entry.id) ?? [];
        expect(nearest.length).toBeGreaterThan(0);
        expect(nearest.length).toBeLessThanOrEqual(8);
        for (const id of nearest) expected.add(id);
      }
      expect([...given].sort()).toEqual([...expected].sort());
      expect(given.length).toBeLessThan(old.length);
      expect(given.length).toBeLessThanOrEqual(fresh.length * 9);
      // The new ones are marked; the person's entry is never sent.
      for (const entry of fresh) expect(requests[0]!.input).toMatch(new RegExp(`^### ${entry.id} \\(written [^)]*; new since the last consolidation`, "m"));
      expect(requests[0]!.input).not.toContain("a person's concern");
      expect(requests[0]!.input).toContain("The scope's agents hold 62 entries");
      expect(listConsolidations(handle.db, project)[0]).toMatchObject({ trigger: "schedule", status: "succeeded" });
      expect(proposeSkills).toHaveBeenCalledTimes(1);

      // Settled: nothing is new now, so it is not given again.
      expect(entriesNewSinceConsolidated(handle.db, project)).toEqual([]);
    });

    it("is the whole scope, and the cross-batch pass, when a person asks", async () => {
      const old = settledScope();
      const requests: AnyRequest[] = [];
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        requests.push(request);
        return { ok: true, value: request.system === MEMORY_CONSOLIDATE_SYSTEM ? NOTHING : { groups: [] } };
      });
      const runner = consolidatorWith(sideCall as never, { neighbours: () => null });
      runner.start();
      expect(runner.requestNow(project).outcome).toBe("started");
      await runner.idle();

      const batches = requests.filter((request) => request.system === MEMORY_CONSOLIDATE_SYSTEM);
      expect(batches.flatMap((request) => idsIn(request.input)).sort()).toEqual(ids(old).sort());
      expect(requests.at(-1)!.system).toBe(MEMORY_MERGE_CANDIDATES_SYSTEM);
    });

    it("counts new entries from the last consolidation that finished, leaving out what consolidations and restores wrote themselves", () => {
      const at = Date.now() - 10 * DAY;
      const [a, b, c] = ["One.", "Two.", "Three."].map((body, index) => byAgent(workspace, body, at + index));
      byPerson(workspace, "A person's.", at);
      // Never consolidated: every agent-written entry is new, and no person's.
      expect(entriesNewSinceConsolidated(handle.db, workspace)).toEqual(ids([a!, b!, c!]));

      // A run that merged a and b, and finished.
      const first = startConsolidation(handle.db, { scope: workspace, trigger: "schedule", now: at + HOUR });
      const merged = applyConsolidation(handle.db, { id: first.id, sent: [a!, b!], answer: { ...NOTHING, merge: [{ from: [a!.id, b!.id], body: "One and two.", contradictsRepositoryFile: false }] }, note: null, now: at + 2 * HOUR });
      if (!merged.ok) throw new Error(merged.problem);
      markConsolidationRunFinished(handle.db, first.id);
      expect(entriesNewSinceConsolidated(handle.db, workspace)).toEqual([]);

      // Written since: new.
      const d = byAgent(workspace, "Four.", at + 3 * HOUR);
      expect(entriesNewSinceConsolidated(handle.db, workspace)).toEqual([d.id]);

      // A run that stopped part-way — one batch applied, the next failed — is not the point counted from.
      const partway = at + 4 * HOUR;
      const batchOne = startConsolidation(handle.db, { scope: workspace, trigger: "schedule", now: partway });
      applyConsolidation(handle.db, { id: batchOne.id, sent: [c!], answer: NOTHING, note: null, now: partway + 1 });
      const batchTwo = startConsolidation(handle.db, { scope: workspace, trigger: "schedule", now: partway });
      failConsolidation(handle.db, batchTwo.id, { reason: "error", note: "The backend fell over.", now: partway + 2 });
      expect(entriesNewSinceConsolidated(handle.db, workspace)).toEqual([d.id]);

      // Restored: what it put back is the person keeping it, not new — and what was new before stays new.
      expect(restoreConsolidation(handle.db, first.id, { now: at + 5 * HOUR }).ok).toBe(true);
      expect(ids(listMemories(handle.db, workspace))).toEqual(expect.arrayContaining([a!.id, b!.id]));
      expect(entriesNewSinceConsolidated(handle.db, workspace)).toEqual([d.id]);
    });

    /** `count` new notes, each on its own, so a schedule run without neighbours batches them 30 at a time. */
    // Written before the run that reads them, oldest first: a run reads what was written by the moment it starts.
    const newNotes = (count: number) => Array.from({ length: count }, (_, index) => byAgent(project, `New fact ${index}: ${"n".repeat(60)}`, Date.now() - count + index));

    it("gives a neighbour two batches share to the second as the first left it, so neither is applied against a stale entry (EO-913)", async () => {
      const old = settledScope();
      const shared = old[0]!;
      const fresh = newNotes(31);
      givenToFiveRuns(fresh);
      const inputs: string[] = [];
      let merged: string | null = null;
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        inputs.push(request.input);
        // The first batch folds the shared neighbour into its first new entry; the second changes nothing.
        const value = inputs.length === 1 ? { ...NOTHING, merge: [{ from: [shared.id, fresh[0]!.id], body: "The shared fact, and the first new one.", contradictsRepositoryFile: false }] } : NOTHING;
        return { ok: true, value: request.schema.parse(value) };
      });
      // Every new entry ranks the same old one as its only neighbour.
      const runner = consolidatorWith(sideCall as never, { neighbours: (_scope, entries) => new Map(entries.map((entry) => [entry.id, [shared.id]])) });
      runner.start();
      await runner.idle();

      expect(inputs).toHaveLength(2);
      expect(idsIn(inputs[0]!)).toContain(shared.id);
      merged = listMemories(handle.db, project).find((entry) => entry.body === "The shared fact, and the first new one.")?.id ?? null;
      expect(merged).not.toBeNull();
      // The second batch has the room, so it is given the neighbour too — as the first batch left it.
      expect(idsIn(inputs[1]!)).not.toContain(shared.id);
      expect(idsIn(inputs[1]!)).toContain(merged);
      expect(listConsolidations(handle.db, project).filter((row) => row.trigger === "schedule" && row.status !== "succeeded")).toEqual([]);
      expect(entriesNewSinceConsolidated(handle.db, project)).toEqual([]);
    });

    it("keeps the entries a run never reached new when EO quits between two of its batches, so they are given after the restart", async () => {
      settledScope();
      const fresh = newNotes(40);
      givenToFiveRuns(fresh);
      const sent: string[][] = [];
      let runner: MemoryConsolidator | null = null;
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        sent.push(idsIn(request.input));
        // EO quits once the first batch has its answer: no row is written for the second.
        runner!.stop();
        return { ok: true, value: NOTHING };
      });
      runner = consolidatorWith(sideCall as never, { neighbours: () => null });
      runner.start();
      await runner.idle();

      expect(sent).toHaveLength(1);
      expect(listConsolidations(handle.db, project).filter((row) => row.trigger === "schedule")).toHaveLength(2);
      const unsent = ids(fresh).filter((id) => !sent[0]!.includes(id));
      expect(unsent.length).toBeGreaterThan(0);
      // Not the point counted from: what the second batch was to be given is still new.
      expect(entriesNewSinceConsolidated(handle.db, project)).toEqual(expect.arrayContaining(unsent));

      // After a restart, the next scheduled run is given them.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 2 * DAY);
      givenToFiveRuns(fresh);
      const later: string[][] = [];
      const restarted = consolidatorWith((async (request: AnyRequest): Promise<AnyAnswer> => {
        later.push(idsIn(request.input));
        return { ok: true, value: NOTHING };
      }) as never, { neighbours: () => null });
      expect(restarted.check()).toEqual([{ scope: project, trigger: "schedule" }]);
      restarted.start();
      await restarted.idle();
      expect(later.flat()).toEqual(expect.arrayContaining(unsent));
      expect(entriesNewSinceConsolidated(handle.db, project)).toEqual([]);
    });

    it("asks nothing and writes nothing where the only new entry is gone by the time a queued scheduled run starts", async () => {
      const old = settledScope();
      // Two old entries that repeat one another word for word, which a run that went ahead would fold.
      byAgent(project, old[0]!.body, Date.now() - 5 * DAY);
      const fresh = byAgent(project, "One new fact.", Date.now());
      givenToFiveRuns([fresh]);
      let busy = true;
      const sideCall = vi.fn(async (): Promise<Answer> => ({ ok: true, value: NOTHING }));
      const proposeSkills = vi.fn(async (): Promise<SideCallResult<unknown>> => ({ ok: true, value: { skills: [] } }));
      const runner = consolidatorWith(sideCall, { pipelineBusy: () => busy, proposeSkills });
      runner.start();
      expect(runner.pending(project)).toBe("queued");
      const rows = listConsolidations(handle.db, project).length;

      // Retired while it waited behind pipeline work.
      expect(retireMemory(handle.db, fresh.id).ok).toBe(true);
      busy = false;
      runner.poke();
      // The look a poke asks for is on a timer of its own: wait for it, then for what it drains.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await runner.idle();
      expect(runner.pending(project)).toBeNull();

      expect(sideCall).not.toHaveBeenCalled();
      expect(proposeSkills).not.toHaveBeenCalled();
      expect(listConsolidations(handle.db, project)).toHaveLength(rows);
      expect(listMemories(handle.db, project).filter((entry) => entry.body === old[0]!.body)).toHaveLength(2);
    });

    it("starts a person's request over the whole scope, not where a scheduled run that stopped part-way left off", async () => {
      const old = settledScope();
      const fresh = newNotes(40);
      givenToFiveRuns(fresh);
      const sent: string[][] = [];
      let calls = 0;
      // One consolidator throughout, so the scheduled run's progress is still held when the person asks.
      const runner = consolidatorWith((async (request: AnyRequest): Promise<AnyAnswer> => {
        calls += 1;
        sent.push(idsIn(request.input));
        if (calls === 2) return { ok: false, reason: "error", message: "The backend fell over." };
        return { ok: true, value: request.system === MEMORY_CONSOLIDATE_SYSTEM ? NOTHING : { groups: [] } };
      }) as never, { neighbours: () => null });
      runner.start();
      await runner.idle();
      expect(listConsolidations(handle.db, project).slice(0, 2).map((row) => row.status)).toEqual(["failed", "succeeded"]);
      expect(sent).toHaveLength(2);

      expect(runner.requestNow(project).outcome).toBe("started");
      await runner.idle();
      const manual = sent.slice(2).flat();
      // Every agent's entry, the scheduled run's first batch's included.
      expect([...new Set(manual)].sort()).toEqual([...ids(old), ...ids(fresh)].sort());
      expect(manual).toEqual(expect.arrayContaining(sent[0]!));
      expect(listConsolidations(handle.db, project)[0]).toMatchObject({ trigger: "manual", status: "succeeded" });
    });

    it("still retries a person's run that applied a batch, however many of its rows came after it (EO-913)", async () => {
      settledScope();
      newNotes(40);
      vi.useFakeTimers({ toFake: ["Date"] });
      let calls = 0;
      const runner = consolidatorWith((async (request: AnyRequest): Promise<AnyAnswer> => {
        calls += 1;
        if (calls === 2) return { ok: false, reason: "error", message: "The backend fell over." };
        return { ok: true, value: request.system === MEMORY_CONSOLIDATE_SYSTEM ? NOTHING : { groups: [] } };
      }) as never, { neighbours: () => null });
      runner.start();
      expect(runner.requestNow(project).outcome).toBe("started");
      await runner.idle();
      const firstRun = listConsolidations(handle.db, project)[0]!.startedAt;
      // The run gave way to pipeline work 200 times since: its applied batch is older than the newest 200 rows.
      for (let index = 1; index <= 200; index += 1) {
        const row = startConsolidation(handle.db, { scope: project, trigger: "manual", now: Date.now() + index, continuesRun: firstRun });
        failConsolidation(handle.db, row.id, { reason: CONSOLIDATION_DEFERRED_REASON, note: "Gave way.", now: Date.now() + index });
      }
      const state = consolidationState(handle.db, project);
      expect(state.failuresSince[0]).toMatchObject({ afterApplied: true, run: firstRun });
      expect(state.settled).not.toBeNull();
      vi.setSystemTime(Date.now() + DAY);
      expect(runner.check()).toEqual([{ scope: project, trigger: "manual" }]);
    });

    it("keeps retrying a person's run that stopped part-way when the retry's own first batch fails too (EO-913)", async () => {
      settledScope();
      newNotes(40);
      vi.useFakeTimers({ toFake: ["Date"] });
      const sent: string[][] = [];
      let calls = 0;
      const runner = consolidatorWith((async (request: AnyRequest): Promise<AnyAnswer> => {
        calls += 1;
        sent.push(idsIn(request.input));
        if (calls === 2 || calls === 3) return { ok: false, reason: "error", message: "The backend fell over." };
        return { ok: true, value: request.system === MEMORY_CONSOLIDATE_SYSTEM ? NOTHING : { groups: [] } };
      }) as never, { neighbours: () => null });
      runner.start();
      expect(runner.requestNow(project).outcome).toBe("started");
      await runner.idle();
      // Batch one applied, batch two failed.
      expect(sent).toHaveLength(2);
      const firstRun = listConsolidations(handle.db, project)[0]!.startedAt;

      // Retried after its backoff: the retry's first batch, the run's second, fails again.
      vi.setSystemTime(Date.now() + CONSOLIDATION_BACKOFF_MS[0] + 1);
      expect(runner.check()).toEqual([{ scope: project, trigger: "manual" }]);
      runner.poke();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await runner.idle();
      expect(sent).toHaveLength(3);
      const [retried] = handle.db.all<{ started_at: number; continues_run: number | null; status: string }>(
        sql`select started_at, continues_run, status from memory_consolidations where scope_id = ${project.id} order by started_at desc, id desc limit 1`,
      );
      expect(retried).toMatchObject({ status: "failed", continues_run: firstRun });
      expect(retried!.started_at).toBeGreaterThan(firstRun);

      // Still the run that stopped part-way: it is queued again after the next backoff, and goes on where it left off.
      vi.setSystemTime(Date.now() + CONSOLIDATION_BACKOFF_MS[1] + 1);
      expect(runner.check()).toEqual([{ scope: project, trigger: "manual" }]);
      runner.poke();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await runner.idle();
      expect(sent.length).toBeGreaterThan(3);
      for (const id of sent[0]!) expect(sent[3]).not.toContain(id);
      expect(sent[3]).toEqual(expect.arrayContaining(sent[1]!));
      expect(listConsolidations(handle.db, project)[0]).toMatchObject({ trigger: "manual", status: "succeeded" });
      // Finished: nothing is queued.
      expect(runner.check()).toEqual([]);
    });

    it("finishes a scheduled run that stopped part-way, without resending its earlier batch, when what its failed batch was to have is gone (EO-913)", async () => {
      settledScope();
      const fresh = newNotes(40);
      givenToFiveRuns(fresh);
      vi.useFakeTimers({ toFake: ["Date"] });
      const sent: string[][] = [];
      let calls = 0;
      const proposeSkills = vi.fn(async (): Promise<SideCallResult<unknown>> => ({ ok: true, value: { skills: [] } }));
      const runner = consolidatorWith((async (request: AnyRequest): Promise<AnyAnswer> => {
        calls += 1;
        sent.push(idsIn(request.input));
        return calls === 2 ? { ok: false, reason: "error", message: "The backend fell over." } : { ok: true, value: NOTHING };
      }) as never, { neighbours: () => null, proposeSkills });
      runner.start();
      await runner.idle();
      expect(sent).toHaveLength(2);

      // Every entry the failed batch was given is retired by hand.
      for (const id of sent[1]!) expect(retireMemory(handle.db, id, { now: Date.now() + 1 }).ok).toBe(true);

      vi.setSystemTime(Date.now() + CONSOLIDATION_BACKOFF_MS[0] + 1);
      expect(runner.check()).toEqual([{ scope: project, trigger: "schedule" }]);
      runner.poke();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await runner.idle();

      // Nothing was asked, the first batch's entries were not sent again, and the run is finished.
      expect(sent).toHaveLength(2);
      expect(listConsolidations(handle.db, project)[0]).toMatchObject({ trigger: "schedule", status: "succeeded", retiredIds: [], writtenIds: [] });
      expect(listConsolidations(handle.db, project)[0]!.note).toMatch(/found nothing left to give it/);
      expect(proposeSkills).toHaveBeenCalledTimes(1);
      expect(entriesNewSinceConsolidated(handle.db, project)).toEqual([]);
      expect(runner.check()).toEqual([]);
    });

    it("finishes a scheduled run whose failed batch's entries are gone without a consolidation call, and leaves a note written since to the schedule (EO-913)", async () => {
      settledScope();
      const fresh = newNotes(40);
      givenToFiveRuns(fresh);
      vi.useFakeTimers({ toFake: ["Date"] });
      const sent: string[][] = [];
      let calls = 0;
      const runner = consolidatorWith((async (request: AnyRequest): Promise<AnyAnswer> => {
        calls += 1;
        sent.push(idsIn(request.input));
        return calls === 2 ? { ok: false, reason: "error", message: "The backend fell over." } : { ok: true, value: NOTHING };
      }) as never, { neighbours: () => null });
      runner.start();
      await runner.idle();
      expect(sent).toHaveLength(2);
      const firstRun = listConsolidations(handle.db, project)[0]!.startedAt;

      // Everything the failed batch was to have is retired while it backs off, and two hours later an agent writes
      // something new, which no run has been given to since.
      for (const id of sent[1]!) expect(retireMemory(handle.db, id, { now: Date.now() + 1 }).ok).toBe(true);
      vi.setSystemTime(Date.now() + 2 * HOUR);
      const unrelated = byAgent(project, "Release notes are drafted in docs/releases, one file per version.", Date.now());

      // Its backoff long over: taken up, and finished with no call; the new note is not given to it.
      vi.setSystemTime(Date.now() + CONSOLIDATION_BACKOFF_MS[0] + 1);
      expect(runner.check()).toEqual([{ scope: project, trigger: "schedule" }]);
      runner.poke();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await runner.idle();
      expect(sent).toHaveLength(2);
      const closed = listConsolidations(handle.db, project)[0]!;
      expect(closed).toMatchObject({ trigger: "schedule", status: "succeeded", retiredIds: [], writtenIds: [] });
      expect(closed.note).toMatch(/found nothing left to give it/);
      const [row] = handle.db.all<{ continues_run: number | null; ends_run: number | null }>(sql`select continues_run, ends_run from memory_consolidations where id = ${closed.id}`);
      expect(row).toEqual({ continues_run: firstRun, ends_run: 1 });

      // The new note is new, and waits for the schedule: its day and five runs.
      expect(entriesNewSinceConsolidated(handle.db, project)).toEqual([unrelated.id]);
      expect(runner.check()).toEqual([]);
      vi.setSystemTime(Date.now() + 2 * DAY);
      expect(runner.check()).toEqual([]);
      givenToFiveRuns([unrelated]);
      expect(runner.check()).toEqual([{ scope: project, trigger: "schedule" }]);
    });

    it("gives a scheduled retry only what its run was to give, after a restart too, and leaves a note written since new (EO-913)", async () => {
      settledScope();
      const fresh = newNotes(40);
      givenToFiveRuns(fresh);
      vi.useFakeTimers({ toFake: ["Date"] });
      const sent: string[][] = [];
      let calls = 0;
      const sideCall = (async (request: AnyRequest): Promise<AnyAnswer> => {
        calls += 1;
        sent.push(idsIn(request.input));
        return calls === 2 ? { ok: false, reason: "error", message: "The backend fell over." } : { ok: true, value: NOTHING };
      }) as never;
      const first = consolidatorWith(sideCall, { neighbours: () => null });
      first.start();
      await first.idle();
      first.stop();
      expect(sent).toHaveLength(2);

      vi.setSystemTime(Date.now() + HOUR);
      const unrelated = byAgent(project, "Release notes are drafted in docs/releases, one file per version.", Date.now());
      vi.setSystemTime(Date.now() + CONSOLIDATION_BACKOFF_MS[0] + 1);

      // A restart: the progress the first consolidator held is gone, so the retry gives what was new when the run
      // started — the first batch's entries again among them — and not the note written since.
      const second = consolidatorWith(sideCall, { neighbours: () => null });
      expect(second.check()).toEqual([{ scope: project, trigger: "schedule" }]);
      second.start();
      await second.idle();
      const retried = sent.slice(2).flat();
      expect(retried).not.toContain(unrelated.id);
      expect([...new Set(retried)].sort()).toEqual(ids(fresh).sort());
      expect(listConsolidations(handle.db, project)[0]).toMatchObject({ trigger: "schedule", status: "succeeded" });
      expect(entriesNewSinceConsolidated(handle.db, project)).toEqual([unrelated.id]);
      expect(second.check()).toEqual([]);
      second.stop();
    });

    it("never gives a scheduled retry a note written since its run started, as a neighbour by the full-text index or as a duplicate to fold (EO-913)", async () => {
      const old = settledScope();
      const fresh = newNotes(40);
      givenToFiveRuns(fresh);
      vi.useFakeTimers({ toFake: ["Date"] });
      const sent: string[][] = [];
      let calls = 0;
      // The real full-text index: no neighbours option.
      const runner = consolidatorWith((async (request: AnyRequest): Promise<AnyAnswer> => {
        calls += 1;
        sent.push(idsIn(request.input));
        return calls === 2 ? { ok: false, reason: "error", message: "The backend fell over." } : { ok: true, value: NOTHING };
      }) as never);
      runner.start();
      await runner.idle();
      expect(sent).toHaveLength(2);

      // Written during the backoff: one like a pending note, which the index ranks first among its
      // neighbours, and one that repeats an old note word for word.
      vi.setSystemTime(Date.now() + HOUR);
      const pending = fresh.findIndex((entry) => sent[1]!.includes(entry.id) && !sent[0]!.includes(entry.id));
      expect(pending).toBeGreaterThanOrEqual(0);
      const alike = byAgent(project, `${fresh[pending]!.body} Fact ${pending}, again: ${pending}.`, Date.now());
      const repeat = byAgent(project, old[0]!.body, Date.now());
      vi.setSystemTime(Date.now() + CONSOLIDATION_BACKOFF_MS[0] + 1);
      expect(runner.check()).toEqual([{ scope: project, trigger: "schedule" }]);
      runner.poke();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await runner.idle();

      expect(sent.length).toBeGreaterThan(2);
      const retried = sent.slice(2).flat();
      expect(retried).not.toContain(alike.id);
      expect(retried).not.toContain(repeat.id);
      // Neither was changed: the repeat is not folded into the note it repeats.
      expect(listMemories(handle.db, project).filter((entry) => entry.body === old[0]!.body)).toHaveLength(2);
      expect(listMemories(handle.db, project).map((entry) => entry.id)).toContain(alike.id);
      // Both are still new, for the schedule.
      expect(entriesNewSinceConsolidated(handle.db, project)).toEqual(expect.arrayContaining([alike.id, repeat.id]));
      runner.stop();
    });

    it("goes on where a scheduled run that stopped part-way left off when that run is retried", async () => {
      settledScope();
      const fresh = newNotes(40);
      givenToFiveRuns(fresh);
      vi.useFakeTimers({ toFake: ["Date"] });
      const sent: string[][] = [];
      let calls = 0;
      const runner = consolidatorWith((async (request: AnyRequest): Promise<AnyAnswer> => {
        calls += 1;
        sent.push(idsIn(request.input));
        return calls === 2 ? { ok: false, reason: "error", message: "The backend fell over." } : { ok: true, value: NOTHING };
      }) as never, { neighbours: () => null });
      runner.start();
      await runner.idle();
      expect(sent).toHaveLength(2);

      // Its backoff over, it is retried as the run it was, given only what no batch of it had.
      vi.setSystemTime(Date.now() + CONSOLIDATION_BACKOFF_MS[0] + 1);
      expect(runner.check()).toEqual([{ scope: project, trigger: "schedule" }]);
      runner.poke();
      // The look a poke asks for is on a timer of its own; only the clock is faked.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await runner.idle();
      expect(sent).toHaveLength(3);
      for (const id of sent[0]!) expect(sent[2]).not.toContain(id);
      expect(sent[2]).toEqual(expect.arrayContaining(sent[1]!));
      expect(entriesNewSinceConsolidated(handle.db, project)).toEqual([]);
    });

    it("goes on where a run that stopped part-way left off, but gives again an entry its earlier batch had that was retired and restored since", async () => {
      settledScope();
      const fresh = newNotes(40);
      givenToFiveRuns(fresh);
      vi.useFakeTimers({ toFake: ["Date"] });
      const sent: string[][] = [];
      let calls = 0;
      const runner = consolidatorWith((async (request: AnyRequest): Promise<AnyAnswer> => {
        calls += 1;
        sent.push(idsIn(request.input));
        return calls === 2 ? { ok: false, reason: "error", message: "The backend fell over." } : { ok: true, value: NOTHING };
      }) as never, { neighbours: () => null });
      runner.start();
      await runner.idle();
      expect(sent).toHaveLength(2);

      // An entry the first batch had, and left active, is retired and restored by hand: the same id, changed.
      const touched = sent[0]![0]!;
      expect(retireMemory(handle.db, touched, { now: Date.now() + 1 }).ok).toBe(true);
      expect(restoreMemory(handle.db, touched, Date.now() + 2).ok).toBe(true);

      vi.setSystemTime(Date.now() + CONSOLIDATION_BACKOFF_MS[0] + 1);
      expect(runner.check()).toEqual([{ scope: project, trigger: "schedule" }]);
      runner.poke();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await runner.idle();

      // The retry has the failed batch's entries and the restored one, and not the rest of the first batch.
      expect(sent).toHaveLength(3);
      expect(sent[2]).toEqual(expect.arrayContaining([...sent[1]!, touched]));
      for (const id of sent[0]!.slice(1)) expect(sent[2]).not.toContain(id);
      // Changed after the run started, it is never hidden behind the retry's finish: the run is counted from when it
      // started, so the restored entry stays new to the next scheduled one, and nothing else is.
      expect(entriesNewSinceConsolidated(handle.db, project)).toEqual([touched]);
    });

    it("never counts from a skip: what it left, or the batches it stopped, stays new (EO-913)", () => {
      const at = Date.now() - 10 * DAY;
      const [a] = ["One."].map((body) => byAgent(workspace, body, at));
      const finished = startConsolidation(handle.db, { scope: workspace, trigger: "schedule", now: at + HOUR });
      applyConsolidation(handle.db, { id: finished.id, sent: [], answer: NOTHING, note: null, now: at + HOUR });
      markConsolidationRunFinished(handle.db, finished.id);
      const b = byAgent(workspace, "Two.", at + 2 * HOUR);
      expect(entriesNewSinceConsolidated(handle.db, workspace)).toEqual([b.id]);

      // A skip of today's code, recorded on its own.
      recordSkippedConsolidation(handle.db, { scope: workspace, trigger: "container_done", note: "Reopened.", now: at + 3 * HOUR });
      expect(entriesNewSinceConsolidated(handle.db, workspace)).toEqual([b.id]);

      // A container_done whose first batch applied and whose second was skipped as the work reopened.
      const ran = at + 4 * HOUR;
      const batchOne = startConsolidation(handle.db, { scope: workspace, trigger: "container_done", now: ran });
      applyConsolidation(handle.db, { id: batchOne.id, sent: [], answer: NOTHING, note: null, now: ran + 1 });
      const batchTwo = startConsolidation(handle.db, { scope: workspace, trigger: "container_done", now: ran });
      skipConsolidation(handle.db, batchTwo.id, { note: "Reopened.", now: ran + 2 });
      expect(entriesNewSinceConsolidated(handle.db, workspace)).toEqual([b.id]);

      // From before EO-913: a cap consolidation skipped because people's entries alone were over the cap, leaving agents' as they were.
      const legacy = startConsolidation(handle.db, { scope: workspace, trigger: "cap", now: at + 5 * HOUR });
      skipConsolidation(handle.db, legacy.id, { note: "People's entries alone exceed the cap.", now: at + 5 * HOUR });
      handle.db.run(sql`update memory_consolidations set ends_run = null where id = ${legacy.id}`);
      expect(entriesNewSinceConsolidated(handle.db, workspace)).toEqual([b.id]);
      expect(lastFinishedRunAt(handle.db, workspace)).toBe(at + HOUR);

      // A legacy run that applied and had no failure or skip still counts.
      const old = startConsolidation(handle.db, { scope: workspace, trigger: "cap", now: at + 6 * HOUR });
      applyConsolidation(handle.db, { id: old.id, sent: [], answer: NOTHING, note: null, now: at + 6 * HOUR });
      handle.db.run(sql`update memory_consolidations set ends_run = null where id = ${old.id}`);
      expect(lastFinishedRunAt(handle.db, workspace)).toBe(at + 6 * HOUR);
      expect(entriesNewSinceConsolidated(handle.db, workspace)).toEqual([]);
      void a;
    });

    it("finds the last finished run behind any number of newer failed rows, so a scheduled run is never made a full-scope pass (EO-913)", async () => {
      const old = settledScope();
      const finishedAt = lastFinishedRunAt(handle.db, project);
      expect(finishedAt).not.toBeNull();
      // 210 failed rows since, more than the history the backoff reads, the newest two days ago.
      for (let index = 0; index < 210; index += 1) {
        const at = Date.now() - 3 * DAY + HOUR + index * 60_000;
        const row = startConsolidation(handle.db, { scope: project, trigger: "schedule", now: at });
        failConsolidation(handle.db, row.id, { reason: "error", note: "The backend fell over.", now: at + 1 });
      }
      const fresh = byAgent(project, "The payments ledger settles invoices in UTC at noon, and refunds at midnight.", Date.now());
      expect(lastFinishedRunAt(handle.db, project)).toBe(finishedAt);
      expect(entriesNewSinceConsolidated(handle.db, project)).toEqual([fresh.id]);

      givenToFiveRuns([fresh]);
      const requests: AnyRequest[] = [];
      const runner = consolidatorWith((async (request: AnyRequest): Promise<AnyAnswer> => {
        requests.push(request);
        return { ok: true, value: NOTHING };
      }) as never, { proposeSkills: async () => ({ ok: true, value: { skills: [] } }) });
      expect(runner.check()).toEqual([{ scope: project, trigger: "schedule" }]);
      runner.start();
      await runner.idle();
      expect(requests).toHaveLength(1);
      const given = idsIn(requests[0]!.input);
      expect(given).toContain(fresh.id);
      expect(given.length).toBeLessThanOrEqual(9);
      expect(given.length).toBeLessThan(old.length);
    });

    it("is not queued for an old cap run that stopped part-way, until its day and five runs come", () => {
      const at = Date.now() - 2 * HOUR;
      settledScope();
      byAgent(project, "A new fact.", at - HOUR);
      // From before EO-913: a cap batch applied, and the next failed.
      const batchOne = startConsolidation(handle.db, { scope: project, trigger: "cap", now: at });
      applyConsolidation(handle.db, { id: batchOne.id, sent: [], answer: NOTHING, note: null, now: at + 1 });
      handle.db.run(sql`update memory_consolidations set ends_run = null where id = ${batchOne.id}`);
      const batchTwo = startConsolidation(handle.db, { scope: project, trigger: "cap", now: at });
      failConsolidation(handle.db, batchTwo.id, { reason: "error", note: "The backend fell over.", now: at + 2 });
      handle.db.run(sql`update memory_consolidations set ends_run = null where id = ${batchTwo.id}`);
      givenToFiveRuns(listMemories(handle.db, project));

      // Its backoff of an hour is over, and something is new: still not due, for it is not a day since.
      expect(consolidatorWith(vi.fn()).check()).toEqual([]);
    });

    it("does not count what undoing a consolidation put back from a skill as new, but does a later edit of it", () => {
      const at = Date.now() - 10 * DAY;
      const [a, b] = ["The release checklist: tag, build, upload.", "Rebuild the index after a schema change."].map((body, index) => byAgent(workspace, body, at + index));
      const run = startConsolidation(handle.db, { scope: workspace, trigger: "schedule", now: at + HOUR });
      expect(applyConsolidation(handle.db, { id: run.id, sent: [a!], answer: NOTHING, note: null, now: at + HOUR }).ok).toBe(true);
      markConsolidationRunFinished(handle.db, run.id);
      // A skill proposed after it took a: retired as moved_to_skill under its id, on neither of its lists.
      expect(retireMemory(handle.db, a!.id, { reason: "moved_to_skill", consolidationId: run.id, now: at + 2 * HOUR }).ok).toBe(true);
      expect(getConsolidation(handle.db, run.id)).toMatchObject({ retiredIds: [], writtenIds: [] });
      expect(entriesNewSinceConsolidated(handle.db, workspace)).toEqual([]);

      expect(restoreConsolidation(handle.db, run.id, { now: at + 3 * HOUR }).ok).toBe(true);
      expect(ids(listMemories(handle.db, workspace))).toContain(a!.id);
      expect(entriesNewSinceConsolidated(handle.db, workspace)).toEqual([]);

      // A person retiring and restoring it by hand afterwards is a change.
      expect(retireMemory(handle.db, a!.id, { now: at + 4 * HOUR }).ok).toBe(true);
      expect(restoreMemory(handle.db, a!.id, at + 5 * HOUR).ok).toBe(true);
      expect(entriesNewSinceConsolidated(handle.db, workspace)).toEqual([a!.id]);
      void b;
    });
  });

  describe("in batches (EO-574)", () => {
    /** Any of a batched consolidation's calls, and what it answers: a batch's, the cross-batch pass's candidates or its merge. */
    type AnyRequest = SideCallRequest<unknown>;
    type AnyAnswer = SideCallResult<unknown>;
    /** The ids of the entries a call was given in full. */
    const idsIn = (input: string) => [...input.matchAll(/^### (\S+) /gm)].map((match) => match[1]!);
    const isBatch = (request: AnyRequest) => request.system === MEMORY_CONSOLIDATE_SYSTEM;
    const retireSome = (request: AnyRequest, count: number): AnyAnswer => ({
      ok: true,
      value: { ...NOTHING, retire: idsIn(request.input).slice(0, count).map((id) => ({ id, reason: "Stale." })) },
    });
    const ids = (entries: readonly MemoryEntryView[]) => entries.map((entry) => entry.id);
    /** `count` short notes, a second apart, oldest first: batched by age they fall 30, 30, then the rest. */
    const notes = (scope: MemoryScope, count: number) =>
      Array.from({ length: count }, (_, index) => byAgent(scope, `Note ${index}: ${"y".repeat(80)}`, Date.now() - DAY + index * 1_000));
    const byAge = () => null;

    it("consolidates a scope of 111 entries and 56,000 characters in batches of at most 30 entries or 15,000 characters, alike entries together, then the cross-batch pass (scripted side call)", async () => {
      const topics = [
        "The payments ledger settles invoices in UTC at noon",
        "Playwright suites need a display server under xvfb",
        "Drizzle migrations are numbered and never edited after release",
        "Codex sessions keep their sign-in inside the keyring",
      ];
      const at = Date.now() - 10 * DAY;
      const entries = Array.from({ length: 111 }, (_, index) => {
        const topic = topics[index % topics.length]!;
        const length = index < 56 ? 505 : 504;
        const body = `${topic} (note ${index}). ${`${topic}. `.repeat(20)}`.slice(0, length - 1) + ".";
        return byAgent(project, body, at + index * HOUR);
      });
      expect(entries.reduce((sum, entry) => sum + entry.body.length, 0)).toBe(56_000);
      const requests: AnyRequest[] = [];
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        requests.push(request);
        return { ok: true, value: isBatch(request) ? NOTHING : { groups: [] } };
      });

      askNow(consolidatorWith(sideCall as never));
      await consolidator!.idle();

      const batches = requests.filter(isBatch).map((request) => idsIn(request.input));
      const bodyOf = new Map(entries.map((entry) => [entry.id, entry.body]));
      expect(batches.length).toBeGreaterThanOrEqual(4);
      for (const batch of batches) {
        expect(batch.length).toBeLessThanOrEqual(CONSOLIDATION_BATCH_MAX_ENTRIES);
        expect(batch.reduce((sum, id) => sum + bodyOf.get(id)!.length, 0)).toBeLessThanOrEqual(CONSOLIDATION_BATCH_MAX_CHARS);
      }
      // Every entry in exactly one batch.
      expect(batches.flat().sort()).toEqual(ids(entries).sort());
      requests.filter(isBatch).forEach((request, at) => expect(request.input).toContain(`batch ${at + 1} of ${batches.length}`));
      // Grouped by the full-text index: the oldest entry's topic, interleaved by age with the others, is all in the first batch.
      const firstTopic = entries.filter((_, index) => index % topics.length === 0);
      expect(batches[0]).toEqual(expect.arrayContaining(ids(firstTopic)));
      // One at a time, each its own consolidation, and the cross-batch pass after the last.
      expect(requests.at(-1)!.system).toBe(MEMORY_MERGE_CANDIDATES_SYSTEM);
      expect(requests).toHaveLength(batches.length + 1);
      expect(listConsolidations(handle.db, project).map((row) => row.status)).toEqual(Array.from({ length: batches.length + 1 }, () => "succeeded"));
    });

    it("applies each batch on its own: a failed batch leaves the earlier batches' changes, and that batch is what is retried after its backoff", async () => {
      const entries = notes(workspace, 70);
      let clock = Date.now();
      const requests: AnyRequest[] = [];
      const answers: ((request: AnyRequest) => AnyAnswer)[] = [
        (request) => retireSome(request, 2),
        () => ({ ok: false, reason: "error", message: "The backend fell over." }),
      ];
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        requests.push(request);
        const next = answers.shift();
        return next ? next(request) : { ok: true, value: isBatch(request) ? NOTHING : { groups: [] } };
      });
      const runner = consolidatorWith(sideCall as never, { now: () => clock, neighbours: byAge });

      askNow(runner);
      await runner.idle();

      // The first batch was applied; the second failed and the third was never asked.
      expect(requests.map((request) => idsIn(request.input))).toEqual([ids(entries.slice(0, 30)), ids(entries.slice(30, 60))]);
      const [failed, succeeded] = listConsolidations(handle.db, workspace);
      expect(failed).toMatchObject({ status: "failed", note: "The backend fell over.", retiredIds: [], writtenIds: [] });
      expect(succeeded).toMatchObject({ status: "succeeded", retiredIds: ids(entries.slice(0, 2)) });
      expect(listMemories(handle.db, workspace)).toHaveLength(68);

      // Retried once its backoff is over, though nobody has written to the scope since — as the person's consolidation it was…
      expect(runner.check()).toEqual([]);
      clock += CONSOLIDATION_BACKOFF_MS[0];
      expect(runner.check()).toEqual([{ scope: workspace, trigger: "manual" }]);
      answers.push((request) => retireSome(request, 10));
      runner.poke();
      await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(3));
      await runner.idle();

      // …with the batch that failed, not the one already done, then the one never reached and the cross-batch pass.
      expect(idsIn(requests[2]!.input)).toEqual(ids(entries.slice(30, 60)));
      expect(idsIn(requests[3]!.input)).toEqual(ids(entries.slice(60)));
      expect(requests[4]!.system).toBe(MEMORY_MERGE_CANDIDATES_SYSTEM);
      expect(requests).toHaveLength(5);
      expect(listMemories(handle.db, workspace)).toHaveLength(58);
      expect(listConsolidations(handle.db, workspace).map((row) => row.status)).toEqual(["succeeded", "succeeded", "succeeded", "failed", "succeeded"]);
      expect(succeeded!.retiredIds.every((id) => everything(workspace).find((entry) => entry.id === id)!.retiredAt !== null)).toBe(true);
    });

    it("starts again from every entry when a run that stopped part-way is taken up long after", async () => {
      const entries = notes(workspace, 70);
      let clock = Date.now();
      const requests: AnyRequest[] = [];
      const answers: ((request: AnyRequest) => AnyAnswer)[] = [() => ({ ok: true, value: NOTHING }), () => ({ ok: false, reason: "error", message: "The backend fell over." })];
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        requests.push(request);
        return (answers.shift() ?? ((next: AnyRequest) => retireSome(next, 15)))(request);
      });
      const runner = consolidatorWith(sideCall as never, { now: () => clock, neighbours: byAge });
      askNow(runner);
      await runner.idle();
      expect(requests).toHaveLength(2);

      clock += 3 * DAY;
      runner.poke();
      await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(3));
      await runner.idle();
      expect(idsIn(requests[2]!.input)).toEqual(ids(entries.slice(0, 30)));
    });

    it("settles the scope once a run in batches finishes, so what its own batches wrote is not taken for a change", async () => {
      notes(workspace, 70);
      const requests: AnyRequest[] = [];
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        requests.push(request);
        return isBatch(request) ? retireSome(request, 1) : { ok: true, value: { groups: [] } };
      });
      const runner = consolidatorWith(sideCall as never, { neighbours: byAge });

      askNow(runner);
      await runner.idle();

      // Three batches and the pass; nobody else wrote anything, so nothing is new to the schedule.
      expect(requests).toHaveLength(4);
      expect(listMemories(handle.db, workspace)).toHaveLength(67);
      expect(runner.check()).toEqual([]);
      expect(entriesNewSinceConsolidated(handle.db, workspace)).toEqual([]);
      // Every row of the run starts when it read its entries.
      expect(new Set(listConsolidations(handle.db, workspace).map((row) => row.startedAt)).size).toBe(1);
    });

    it("leaves a note written during one batch new to the next scheduled one, though the later batches and the pass succeeded (EO-913)", async () => {
      notes(workspace, 70);
      const requests: AnyRequest[] = [];
      let added: MemoryEntryView | null = null;
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        requests.push(request);
        // A note written while the first batch is answered: not in the run's plan.
        if (requests.length === 1) added = byAgent(workspace, "Added while batch one ran.", Date.now());
        return isBatch(request) ? retireSome(request, 1) : { ok: true, value: { groups: [] } };
      });
      const runner = consolidatorWith(sideCall as never, { neighbours: byAge });

      askNow(runner);
      await runner.idle();

      const id = added!.id;
      const [, , , pass, ...followUp] = requests;
      for (const request of requests.slice(0, 3)) expect(idsIn(request.input)).not.toContain(id);
      // The pass read the entries again and saw its first line…
      expect(pass!.system).toBe(MEMORY_MERGE_CANDIDATES_SYSTEM);
      expect(pass!.input).toContain(id);
      expect(followUp).toEqual([]);
      // …and it is still new: what the next scheduled consolidation is given, and nothing else.
      expect(entriesNewSinceConsolidated(handle.db, workspace)).toEqual([id]);
    });

    it("takes a run on the schedule that failed part-way up again after its backoff, with no new deliveries, keeping what its earlier batch did", async () => {
      const entries = notes(workspace, 70);
      for (let index = 0; index < 5; index += 1) {
        const run = createRun(handle.db, { itemId, agentId: listAgents(handle.db)[0]!.id, action: "implement", status: "succeeded" });
        appendRunEvent(handle.db, run.id, MEMORY_DELIVERED_EVENT, { type: MEMORY_DELIVERED_EVENT, entryIds: [entries[0]!.id], candidateCount: 1, mode: "all", selectionRan: false, reason: null });
      }
      let clock = Date.now() + HOUR;
      const requests: AnyRequest[] = [];
      const answers: ((request: AnyRequest) => AnyAnswer)[] = [(request) => retireSome(request, 2), () => ({ ok: false, reason: "error", message: "The backend fell over." })];
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        requests.push(request);
        const next = answers.shift();
        if (next) return next(request);
        return { ok: true, value: isBatch(request) ? NOTHING : { groups: [] } };
      });
      // Queued by the schedule.
      const runner = consolidatorWith(sideCall as never, { now: () => clock, neighbours: byAge });
      expect(runner.check()).toEqual([{ scope: workspace, trigger: "schedule" }]);

      runner.start();
      await runner.idle();
      expect(requests).toHaveLength(2);
      expect(listConsolidations(handle.db, workspace).map((row) => row.status)).toEqual(["failed", "succeeded"]);
      expect(listMemories(handle.db, workspace)).toHaveLength(68);

      // Within the day of its first batch, and not one delivery since: due once its backoff is over all the same.
      expect(runner.check()).toEqual([]);
      clock += CONSOLIDATION_BACKOFF_MS[0];
      expect(runner.check()).toEqual([{ scope: workspace, trigger: "schedule" }]);
      runner.poke();
      await vi.waitFor(() => expect(requests.length).toBeGreaterThan(2));
      await runner.idle();

      // The failed batch, then the one never reached, and no cross-batch pass on the schedule; the earlier batch's retirements stand.
      expect(requests.slice(2).map((request) => (isBatch(request) ? idsIn(request.input) : request.system))).toEqual([ids(entries.slice(30, 60)), ids(entries.slice(60))]);
      expect(listMemories(handle.db, workspace)).toHaveLength(68);
      for (const entry of entries.slice(0, 2)) expect(everything(workspace).find((row) => row.id === entry.id)).toMatchObject({ retiredReason: "consolidated" });
      expect(listConsolidations(handle.db, workspace).map((row) => row.status)).toEqual(["succeeded", "succeeded", "failed", "succeeded"]);
      expect(runner.check()).toEqual([]);
    });

    it("finds duplicates that fell into different batches from ids and first lines alone, and merges them given their full bodies", async () => {
      const at = Date.now() - DAY;
      const entries = Array.from({ length: 40 }, (_, index) =>
        index === 3
          ? byAgent(workspace, "The ledger is in UTC.\nSo are the invoices it settles.", at + index * 1_000)
          : index === 35
            ? byAgent(workspace, "The ledger is in UTC.\nInvoices too, since 2026-10-01.", at + index * 1_000)
            : byAgent(workspace, `Note ${index} says something of its own.\nIts detail ${index} is on this second line.`, at + index * 1_000),
      );
      const [first, second] = [entries[3]!, entries[35]!];
      const requests: AnyRequest[] = [];
      const merged = "The ledger and the invoices it settles are in UTC (since 2026-10-01).";
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        requests.push(request);
        if (isBatch(request)) return { ok: true, value: NOTHING };
        if (request.system === MEMORY_MERGE_CANDIDATES_SYSTEM) return { ok: true, value: { groups: [{ ids: [second.id, first.id] }] } };
        return { ok: true, value: { ...NOTHING, merge: [{ from: [first.id, second.id], body: merged, contradictsRepositoryFile: false }] } };
      });

      askNow(consolidatorWith(sideCall as never, { neighbours: byAge }));
      await consolidator!.idle();

      const [one, two, candidates, merge] = requests;
      expect(requests).toHaveLength(4);
      // Split across the batches, so neither batch saw both.
      expect(idsIn(one!.input)).toContain(first.id);
      expect(idsIn(one!.input)).not.toContain(second.id);
      expect(idsIn(two!.input)).toContain(second.id);
      expect(idsIn(two!.input)).not.toContain(first.id);

      // The pass's first call is given each entry's id and first line, and nothing else of it.
      expect(candidates!.system).toBe(MEMORY_MERGE_CANDIDATES_SYSTEM);
      for (const entry of entries) expect(candidates!.input).toContain(`- ${entry.id}: ${firstLine(entry.body)}`);
      expect(candidates!.input).not.toMatch(/second line|So are the invoices|Invoices too/);
      // Its last is given the candidates in full, and only them.
      expect(merge!.system).toBe(MEMORY_CROSS_BATCH_MERGE_SYSTEM);
      expect(idsIn(merge!.input).sort()).toEqual([first.id, second.id].sort());
      expect(merge!.input).toContain(first.body);
      expect(merge!.input).toContain(second.body);

      const [pass] = listConsolidations(handle.db, workspace);
      expect(pass).toMatchObject({ status: "succeeded", retiredIds: [first.id, second.id] });
      const active = listMemories(handle.db, workspace);
      expect(active).toHaveLength(39);
      expect(active.filter((entry) => entry.body === merged)).toMatchObject([{ consolidationId: pass!.id, createdAt: second.createdAt }]);
      for (const duplicate of [first, second]) expect(everything(workspace).find((entry) => entry.id === duplicate.id)).toMatchObject({ retiredReason: "consolidated", consolidationId: pass!.id });
    });

    it(`refuses the cross-batch pass's merge, with reason schema, when it is longer than ${String(MAX_MEMORY_NOTE_CHARS)} characters, and applies none of it (EO-591)`, async () => {
      const at = Date.now() - DAY;
      const entries = Array.from({ length: 40 }, (_, index) =>
        index === 3 || index === 35
          ? byAgent(workspace, `The ledger is in UTC (note ${index}). ${"z".repeat(900)}`, at + index * 1_000)
          : byAgent(workspace, `Note ${index} says something of its own.`, at + index * 1_000),
      );
      const [first, second] = [entries[3]!, entries[35]!];
      let mergeRequest: AnyRequest | undefined;
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        if (isBatch(request)) return { ok: true, value: NOTHING };
        if (request.system === MEMORY_MERGE_CANDIDATES_SYSTEM) return { ok: true, value: { groups: [{ ids: [first.id, second.id] }] } };
        mergeRequest = request;
        // Held to the request's own schema, as the side caller holds a backend's answer.
        const answer = { ...NOTHING, merge: [{ from: [first.id, second.id], body: "y".repeat(MAX_MEMORY_NOTE_CHARS + 1), contradictsRepositoryFile: false }] };
        const checked = request.schema.safeParse(answer);
        return checked.success ? { ok: true, value: checked.data } : { ok: false, reason: "schema", message: checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
      });

      askNow(consolidatorWith(sideCall as never, { neighbours: byAge }));
      await consolidator!.idle();

      expect(mergeRequest!.system).toBe(MEMORY_CROSS_BATCH_MERGE_SYSTEM);
      // The same merge at the limit is one the pass would take.
      expect(mergeRequest!.schema.safeParse({ ...NOTHING, merge: [{ from: [first.id, second.id], body: "y".repeat(MAX_MEMORY_NOTE_CHARS), contradictsRepositoryFile: false }] }).success).toBe(true);
      const [pass] = listConsolidations(handle.db, workspace);
      expect(pass).toMatchObject({ status: "failed", retiredIds: [], writtenIds: [] });
      expect(pass!.note).toContain("merge.0.body");
      expect(handle.db.get<{ reason: string }>(sql`select failure_reason as reason from memory_consolidations where id = ${pass!.id}`)).toEqual({ reason: "schema" });
      expect(listMemories(handle.db, workspace)).toHaveLength(40);
    });

    it("waits out a pause between two batches, recorded as paused, and goes on with the next batch once EO is resumed", async () => {
      const entries = notes(workspace, 70);
      let clock = Date.now();
      let running = true;
      const requests: AnyRequest[] = [];
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        requests.push(request);
        // EO is paused while the first batch is answered.
        running = false;
        return { ok: true, value: NOTHING };
      });
      const runner = consolidatorWith(sideCall as never, { now: () => clock, canStart: () => running, neighbours: byAge });

      askNow(runner);
      await runner.idle();

      expect(requests).toHaveLength(1);
      expect(listConsolidations(handle.db, workspace)).toMatchObject([{ status: "failed" }, { status: "succeeded" }]);
      expect(handle.db.get<{ reason: string }>(sql`select failure_reason as reason from memory_consolidations order by started_at desc, id desc limit 1`)).toEqual({
        reason: CONSOLIDATION_PAUSED_REASON,
      });

      running = true;
      clock += CONSOLIDATION_CHANGED_RETRY_MS;
      sideCall.mockImplementation(async (request: AnyRequest): Promise<AnyAnswer> => {
        requests.push(request);
        return isBatch(request) ? retireSome(request, 15) : { ok: true, value: { groups: [] } };
      });
      runner.poke();
      await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(2));
      await runner.idle();
      // The batches it had not reached, and then the cross-batch pass.
      expect(idsIn(requests[1]!.input)).toEqual(ids(entries.slice(30, 60)));
      expect(idsIn(requests[2]!.input)).toEqual(ids(entries.slice(60)));
      expect(requests[3]!.system).toBe(MEMORY_MERGE_CANDIDATES_SYSTEM);
      expect(listMemories(handle.db, workspace)).toHaveLength(45);
    });
  });

  describe("never stalling the pipeline (EO-577)", () => {
    type AnyRequest = SideCallRequest<unknown>;
    type AnyAnswer = SideCallResult<unknown>;
    const idsIn = (input: string) => [...input.matchAll(/^### (\S+) /gm)].map((match) => match[1]!);
    const ids = (entries: readonly MemoryEntryView[]) => entries.map((entry) => entry.id);
    const retireSome = (request: AnyRequest, count: number): AnyAnswer => ({
      ok: true,
      value: { ...NOTHING, retire: idsIn(request.input).slice(0, count).map((id) => ({ id, reason: "Stale." })) },
    });
    const notes = (scope: MemoryScope, count: number) =>
      Array.from({ length: count }, (_, index) => byAgent(scope, `Note ${index}: ${"y".repeat(80)}`, Date.now() - DAY + index * 1_000));
    /** What the supervisor asks (`runSupervisor.ts`): an item the tick could dispatch, or a run in flight. */
    const pipelineBusy = () => hasDispatchableItem(buildEligibilityInput(handle.db, false)) || listActiveRuns(handle.db).length > 0;
    const failureReasons = (scope: MemoryScope) =>
      handle.db
        .all<{ reason: string | null }>(sql`select failure_reason as reason from memory_consolidations where scope_id = ${scope.id} order by started_at desc, id desc`)
        .map((row) => row.reason);
    /** A side caller over a provider, with one slot and nothing else running. */
    function realCaller(provider: AgentProvider, extra: { signedIn?: () => Promise<boolean>; now?: () => number } = {}) {
      const slots = createSideCallSlots({ limit: () => 1, busy: () => 0 });
      const caller = createSideCaller({
        db: handle.db,
        provider: () => provider,
        smallModel: async () => "small",
        ...(extra.signedIn ? { signedIn: extra.signedIn } : {}),
        guards: () => ({ perItemBudgetCents: null, dailyBudgetCents: null }),
        slots,
        workDirectory: () => ({ path: "/tmp", remove: () => {} }),
        ...(extra.now ? { now: extra.now } : {}),
      });
      return { caller, slots };
    }

    it("does not start while an item is queued to be dispatched, nor while a run is going, and starts once the pipeline is idle", async () => {
      const entries = notes(workspace, 10);
      const sideCall = vi.fn(async (): Promise<Answer> => ({ ok: true, value: mergeAll(entries, "One.") }));
      // The story `beforeEach` made is on `todo` with an implementer to run it: queued.
      expect(pipelineBusy()).toBe(true);
      const runner = consolidatorWith(sideCall, { pipelineBusy });

      askNow(runner);
      await runner.idle();
      expect(sideCall).not.toHaveBeenCalled();
      expect(listConsolidations(handle.db, workspace)).toEqual([]);
      // Still queued, and nothing recorded against it.
      expect(runner.check()).toEqual([{ scope: workspace, trigger: "manual" }]);

      // Picked up: no longer waiting, but its run is going.
      const going = createRun(handle.db, { itemId, agentId: listAgents(handle.db).find((agent) => agent.role === "implementer")!.id, action: "implement", status: "running" });
      setItemHeld(handle.db, itemId, Date.now());
      runner.poke();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await runner.idle();
      expect(sideCall).not.toHaveBeenCalled();

      // The run ends, and nothing else is waiting: the pipeline is idle.
      handle.db.run(sql`update runs set status = 'succeeded' where id = ${going.id}`);
      expect(pipelineBusy()).toBe(false);
      runner.poke();
      await vi.waitFor(() => expect(sideCall).toHaveBeenCalledTimes(1));
      await runner.idle();
      expect(listMemories(handle.db, workspace).map((entry) => entry.body)).toEqual(["One."]);
      expect(listConsolidations(handle.db, workspace)).toMatchObject([{ status: "succeeded" }]);
    });

    it("does not start the next batch while pipeline work waits: recorded as deferred, not backed off, and taken up once the pipeline is idle", async () => {
      setItemHeld(handle.db, itemId, Date.now());
      const entries = notes(workspace, 70);
      let clock = Date.now();
      const requests: AnyRequest[] = [];
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        requests.push(request);
        // An item is put on the board while the first batch is answered.
        setItemHeld(handle.db, itemId, null);
        return { ok: true, value: NOTHING };
      });
      const runner = consolidatorWith(sideCall as never, { now: () => clock, pipelineBusy, neighbours: () => null });

      askNow(runner);
      await runner.idle();
      expect(requests).toHaveLength(1);
      expect(listConsolidations(handle.db, workspace).map((row) => row.status)).toEqual(["failed", "succeeded"]);
      expect(failureReasons(workspace)[0]).toBe(CONSOLIDATION_DEFERRED_REASON);
      expect(listConsolidations(handle.db, workspace)[0]!.note).toMatch(/Pipeline work was waiting/);

      // Due again a minute later — not an hour, it is no failure — but not started while the item waits.
      clock += CONSOLIDATION_CHANGED_RETRY_MS;
      expect(runner.check()).toEqual([{ scope: workspace, trigger: "manual" }]);
      runner.poke();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await runner.idle();
      expect(requests).toHaveLength(1);

      setItemHeld(handle.db, itemId, Date.now());
      sideCall.mockImplementation(async (request: AnyRequest): Promise<AnyAnswer> => {
        requests.push(request);
        return request.system === MEMORY_CONSOLIDATE_SYSTEM ? retireSome(request, 15) : { ok: true, value: { groups: [] } };
      });
      runner.poke();
      await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(2));
      await runner.idle();
      // The batch that gave way, not the one already done; then the last and the cross-batch pass.
      expect(idsIn(requests[1]!.input)).toEqual(ids(entries.slice(30, 60)));
      expect(idsIn(requests[2]!.input)).toEqual(ids(entries.slice(60)));
      expect(listMemories(handle.db, workspace)).toHaveLength(45);
    });

    it("gives way at the slot to an item that became dispatchable while the call got ready: no call made, no slot taken, recorded as deferred", async () => {
      setItemHeld(handle.db, itemId, Date.now());
      notes(workspace, 10);
      const asked = vi.fn();
      const provider = {
        async *sideCall(): AsyncIterable<AgentEvent> {
          asked();
          yield { type: "result", data: NOTHING } satisfies AgentEvent;
        },
      } as unknown as AgentProvider;
      // The sign-in is asked about before the slot is taken; an item arrives meanwhile.
      const { caller, slots } = realCaller(provider, {
        signedIn: async () => {
          setItemHeld(handle.db, itemId, null);
          return true;
        },
      });
      const acquire = vi.spyOn(slots, "acquire");

      askNow(consolidatorWith(caller.sideCall, { pipelineBusy }));
      await consolidator!.idle();

      expect(asked).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(failureReasons(workspace)).toEqual([CONSOLIDATION_DEFERRED_REASON]);
      expect(listSideCalls(handle.db)).toMatchObject([{ purpose: "memory_consolidate", outcome: "failed", reason: "error" }]);
      expect(listMemories(handle.db, workspace)).toHaveLength(10);
    });

    it("asks each call with a 180-second limit and an output-token cap", async () => {
      const entries = notes(workspace, 10);
      const requests: AnyRequest[] = [];
      const runner = consolidatorWith(
        async (request) => {
          requests.push(request as AnyRequest);
          return { ok: true, value: mergeAll(entries, "One.") };
        },
        {
          proposeSkills: async (request) => {
            requests.push(request);
            return { ok: true, value: { skills: [] } };
          },
        },
      );
      askNow(runner);
      await runner.idle();
      expect(MEMORY_CONSOLIDATE_TIMEOUT_MS).toBe(180_000);
      expect(requests.map((request) => request.system)).toEqual([MEMORY_CONSOLIDATE_SYSTEM, MEMORY_PROPOSE_SKILLS_SYSTEM]);
      for (const request of requests) expect(request).toMatchObject({ timeoutMs: 180_000, maxOutputTokens: MEMORY_CONSOLIDATE_MAX_OUTPUT_TOKENS });
    });

    it("cuts off an answer that runs past its output-token cap, records it as a timeout with what it spent, and changes nothing", async () => {
      notes(workspace, 10);
      const before = everything(workspace);
      let pieces = 0;
      const provider = {
        async *sideCall(options: AgentSideCallOptions): AsyncIterable<AgentEvent> {
          // An answer that never closes, a thousand bytes at a time, until it is wound down…
          while (!options.signal.aborted && !options.windDown?.aborted) {
            pieces += 1;
            yield { type: "output_delta", stream: "text", text: '{"retire":[' + "x".repeat(989) } satisfies AgentEvent;
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          // …when its turn ends saying what it spent.
          yield { type: "usage", scope: "session", tokensIn: 9_000, tokensOut: 7_100, costCents: 0, costMicrocents: 3_400_000 } satisfies AgentEvent;
        },
      } as unknown as AgentProvider;
      const { caller, slots } = realCaller(provider);

      askNow(consolidatorWith(caller.sideCall));
      await consolidator!.idle();

      // Cut at the cap, counting a byte a token: the first piece past it is the last.
      expect(pieces).toBe(MEMORY_CONSOLIDATE_MAX_OUTPUT_TOKENS / 1_000 + 1);
      expect(slots.held()).toBe(0);
      expect(everything(workspace)).toEqual(before);
      expect(listConsolidations(handle.db, workspace)[0]).toMatchObject({
        status: "failed",
        note: `The answer ran past its cap of ${MEMORY_CONSOLIDATE_MAX_OUTPUT_TOKENS} output tokens and was cut off.`,
      });
      expect(failureReasons(workspace)).toEqual(["timeout"]);
      expect(listSideCalls(handle.db)).toMatchObject([{ purpose: "memory_consolidate", outcome: "failed", reason: "timeout", tokensIn: 9_000, tokensOut: 7_100, costMicrocents: 3_400_000 }]);
    });

    it("cuts off a call still unanswered at 180 seconds, not at 90, and records it as a timeout (fake clock)", async () => {
      notes(workspace, 10);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const provider = {
        async *sideCall(options: AgentSideCallOptions): AsyncIterable<AgentEvent> {
          await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
          yield* [] as AgentEvent[];
        },
      } as unknown as AgentProvider;
      const { caller, slots } = realCaller(provider);
      askNow(consolidatorWith(caller.sideCall));
      // Not `vi.waitFor`, which moves the faked clock on as it polls.
      for (let turn = 0; turn < 50 && slots.held() === 0; turn += 1) await vi.advanceTimersByTimeAsync(0);
      expect(slots.held()).toBe(1);

      // Still running past the old limit of 90 seconds…
      await vi.advanceTimersByTimeAsync(90_000);
      expect(listConsolidations(handle.db, workspace)[0]).toMatchObject({ status: "running" });
      await vi.advanceTimersByTimeAsync(180_000 - 90_000 - 1);
      expect(listConsolidations(handle.db, workspace)[0]).toMatchObject({ status: "running" });
      await vi.advanceTimersByTimeAsync(1);
      await consolidator!.idle();

      expect(listConsolidations(handle.db, workspace)[0]).toMatchObject({ status: "failed", note: "The call took longer than its 180000 ms and was stopped." });
      expect(failureReasons(workspace)).toEqual(["timeout"]);
      expect(slots.held()).toBe(0);
    });

    it("backs a failing scope off an hour, four hours, then a day; says it is stuck at the third failure, once; and again only after a success (fake clock)", async () => {
      givenToFiveRuns(notes(workspace, 10));
      let clock = Date.now() + DAY;
      let answer: AnyAnswer = { ok: false, reason: "schema", message: "The answer did not match the shape asked for: retire: Required" };
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => (answer.ok ? { ok: true, value: { ...NOTHING, merge: [{ from: idsIn(request.input), body: "One.", contradictsRepositoryFile: false }] } } : answer));
      const runner = consolidatorWith(sideCall as never, { now: () => clock });
      const notices = () => messagesFrom(handle.db, "consolidation_stuck");
      /** Waits out `wait`: not due a millisecond before, due at it, and asked. */
      const failAgainAfter = async (wait: number, trigger: "schedule" | "manual" = "schedule") => {
        clock += wait - 1;
        expect(runner.check()).toEqual([]);
        clock += 1;
        expect(runner.check()).toEqual([{ scope: workspace, trigger }]);
        const calls = sideCall.mock.calls.length;
        runner.poke();
        await vi.waitFor(() => expect(sideCall.mock.calls.length).toBe(calls + 1));
        await runner.idle();
      };

      // Due on the schedule.
      runner.start();
      await runner.idle();
      expect(sideCall).toHaveBeenCalledTimes(1);
      expect(notices()).toEqual([]);

      await failAgainAfter(60 * 60 * 1000);
      expect(notices()).toEqual([]);
      await failAgainAfter(4 * 60 * 60 * 1000);

      // The third in a row: one message to the person about the project, naming the scope, what it holds and the last reason.
      expect(notices()).toHaveLength(1);
      const [notice] = notices();
      expect(notice).toMatchObject({ recipientId: LOCAL_PERSON_ID, projectId, options: null, handledAt: null });
      expect(notice!.body).toContain('Memory consolidation of the workspace "api" is stuck: it has failed 3 times in a row.');
      expect(notice!.body).toContain("**Holds:** 10 entries, 880 characters.");
      expect(notice!.body).not.toMatch(/cap/);
      expect(notice!.body).toContain("`schema` — The answer did not match the shape asked for: retire: Required");

      // The fourth waits a day, and is not said again.
      await failAgainAfter(24 * 60 * 60 * 1000);
      await failAgainAfter(24 * 60 * 60 * 1000);
      expect(notices()).toHaveLength(1);

      // A success ends the run, and resolves the message…
      answer = { ok: true, value: NOTHING };
      await failAgainAfter(24 * 60 * 60 * 1000);
      expect(listConsolidations(handle.db, workspace)[0]).toMatchObject({ status: "succeeded" });
      expect(listMemories(handle.db, workspace)).toHaveLength(1);
      expect(notices()).toEqual([expect.objectContaining({ id: notice!.id, handledHow: "resolved", handledAt: clock })]);

      // …so three more in a row are said again: a person's this time, each asked for — a request that
      // fails before it applied anything is not repeated unasked (EO-913).
      answer = { ok: false, reason: "timeout", message: "The call took longer than its 90000 ms and was stopped." };
      for (let index = 0; index < 9; index += 1) byAgent(workspace, `Later note ${index}`, clock + index);
      expect(runner.check()).toEqual([]);
      const askAgain = async () => {
        const calls = sideCall.mock.calls.length;
        runner.requestNow(workspace);
        await vi.waitFor(() => expect(sideCall.mock.calls.length).toBe(calls + 1));
        await runner.idle();
        expect(failureReasons(workspace)[0]).toBe("timeout");
        clock += 60 * 60 * 1000;
        expect(runner.check()).toEqual([]);
      };
      await askAgain();
      await askAgain();
      expect(notices()).toHaveLength(1);
      await askAgain();
      expect(notices()).toHaveLength(2);
      expect(notices()[1]!.body).toContain("`timeout` — The call took longer than its 90000 ms and was stopped.");
      expect(notices()[1]!.handledAt).toBeNull();
    });

    it("sends the stuck message through the sender it is given, and says it the next failure when that sender refuses", async () => {
      givenToFiveRuns(notes(workspace, 10));
      let clock = Date.now() + DAY;
      const sideCall = vi.fn(async (): Promise<AnyAnswer> => ({ ok: false, reason: "schema", message: "The answer did not match the shape asked for." }));
      let refuse = true;
      const sent: MessageSend[] = [];
      const runner = consolidatorWith(sideCall as never, {
        now: () => clock,
        sendMessage: async (input) => {
          if (refuse) return { ok: false, problem: "Your organisation's record could not be reached." };
          sent.push(input);
          return { ok: true, messages: [] };
        },
      });
      const failAgainAfter = async (wait: number) => {
        clock += wait;
        expect(runner.check()).toEqual([{ scope: workspace, trigger: "schedule" }]);
        const calls = sideCall.mock.calls.length;
        runner.poke();
        await vi.waitFor(() => expect(sideCall.mock.calls.length).toBe(calls + 1));
        await runner.idle();
      };

      runner.start();
      await runner.idle();
      await failAgainAfter(60 * 60 * 1000);
      await failAgainAfter(4 * 60 * 60 * 1000);
      // Refused at the third: not marked, and said why on the failure.
      expect(sent).toEqual([]);
      expect(listConsolidations(handle.db, workspace)[0]?.note).toContain("the message saying so could not be sent: Your organisation's record could not be reached.");

      refuse = false;
      await failAgainAfter(24 * 60 * 60 * 1000);
      expect(sent).toEqual([expect.objectContaining({ projectId, source: "consolidation_stuck", subject: `workspace:${workspace.id}` })]);
      expect(messagesFrom(handle.db, "consolidation_stuck")).toEqual([]);
    });

    it("records on each consolidation how long its calls held the global slot, the skill proposal call's included, and none for duplicates folded without a model", async () => {
      byAgent(workspace, "Run `pnpm install` in a fresh worktree.", Date.now() - DAY);
      byAgent(workspace, "Run `pnpm install` in a fresh worktree.", Date.now() - DAY + 1);
      const entries = notes(workspace, 9);
      const runner = consolidatorWith(
        async (request) => {
          request.onSlotHeld?.(1_234);
          return { ok: true, value: mergeAll(entries, "One.") };
        },
        {
          proposeSkills: async (request) => {
            request.onSlotHeld?.(66);
            return { ok: true, value: { skills: [] } };
          },
        },
      );
      askNow(runner);
      await runner.idle();

      const [batch, folded] = listConsolidations(handle.db, workspace);
      expect(folded!.note).toMatch(/word for word/);
      expect(consolidationSlotTime(handle.db, folded!.id)).toBe(0);
      expect(consolidationSlotTime(handle.db, batch!.id)).toBe(1_300);
    });

    it("measures the slot time through the real side caller, from taking the slot to giving it back", async () => {
      const entries = notes(workspace, 10);
      let clock = Date.now();
      const provider = {
        async *sideCall(): AsyncIterable<AgentEvent> {
          clock += 4_200;
          yield { type: "result", data: mergeAll(entries, "One.") } satisfies AgentEvent;
        },
      } as unknown as AgentProvider;
      const { caller } = realCaller(provider, {
        now: () => clock,
        signedIn: async () => {
          // Before the slot: not counted.
          clock += 10_000;
          return true;
        },
      });
      askNow(consolidatorWith(caller.sideCall, { now: () => clock }));
      await consolidator!.idle();
      const [row] = listConsolidations(handle.db, workspace);
      expect(row).toMatchObject({ status: "succeeded" });
      expect(consolidationSlotTime(handle.db, row!.id)).toBe(4_200);
    });
  });

  describe("its concurrency slot", () => {
    it("waits for a free global slot and holds it while the model answers", async () => {
      const notes = Array.from({ length: 10 }, (_, index) => byAgent(workspace, `Note ${index}`, Date.now() - DAY + index));
      let busy = 1;
      const slots = createSideCallSlots({ limit: () => 1, busy: () => busy, pollMs: 5 });
      const heldDuringCall: number[] = [];
      const provider = {
        async *sideCall(_options: AgentSideCallOptions): AsyncIterable<AgentEvent> {
          heldDuringCall.push(slots.held());
          yield { type: "result", data: mergeAll(notes, "One.") } satisfies AgentEvent;
        },
      } as unknown as AgentProvider;
      const caller = createSideCaller({
        db: handle.db,
        provider: () => provider,
        smallModel: async () => "small",
        guards: () => ({ perItemBudgetCents: null, dailyBudgetCents: null }),
        slots,
        workDirectory: () => ({ path: "/tmp", remove: () => {} }),
      });

      askNow(consolidatorWith(caller.sideCall));
      await vi.waitFor(() => expect(slots.waiting()).toBe(1));
      expect(heldDuringCall).toEqual([]);

      busy = 0;
      await consolidator!.idle();
      expect(heldDuringCall).toEqual([1]);
      expect(slots.held()).toBe(0);
      expect(listMemories(handle.db, workspace).map((entry) => entry.body)).toEqual(["One."]);
    });
  });

  describe("restoring", () => {
    it("puts back what a consolidation retired and retires what it wrote, in one IPC command, and is not undone by the next look", async () => {
      const notes = Array.from({ length: 10 }, (_, index) => byAgent(workspace, `Note ${index}`, Date.now() - DAY + index));
      const person = byPerson(workspace, "Mine.", Date.now() - DAY);
      const sideCall = vi.fn(async (): Promise<Answer> => ({ ok: true, value: mergeAll(notes, "All ten.") }));
      const runner = consolidatorWith(sideCall);
      askNow(runner);
      await runner.idle();
      const [consolidation] = (await listConsolidationsCommand(recordFor(handle.db), { scope: workspace })).consolidations;
      const written = consolidation!.writtenIds;
      expect(listMemories(handle.db, workspace).map((entry) => entry.body).sort()).toEqual(["All ten.", "Mine."]);

      const restored = await restoreConsolidationCommand(handle.db, recordFor(handle.db), { consolidationId: consolidation!.id });

      expect(restored).toMatchObject({ ok: true, restored: 10, retired: 1, consolidation: { status: "restored" } });
      const active = listMemories(handle.db, workspace);
      expect(active.map((entry) => entry.id).sort()).toEqual([...notes.map((entry) => entry.id), person.id].sort());
      expect(everything(workspace).find((entry) => entry.id === written[0])).toMatchObject({ retiredReason: "retired" });
      expect(await restoreConsolidationCommand(handle.db, recordFor(handle.db), { consolidationId: consolidation!.id })).toMatchObject({ ok: false });
      expect(await restoreConsolidationCommand(handle.db, recordFor(handle.db), { consolidationId: "nope" })).toMatchObject({ ok: false });

      // What the person put back is not new to the next scheduled one, so it is not folded straight back.
      expect(runner.check()).toEqual([]);
      expect(entriesNewSinceConsolidated(handle.db, workspace)).toEqual([]);
    });

    it("leaves entries a person puts back one at a time new to the next scheduled one, and queues nothing for them now", async () => {
      const notes = Array.from({ length: 10 }, (_, index) => byAgent(workspace, `Note ${index}`, Date.now() - DAY + index));
      const sideCall = vi.fn(async (): Promise<Answer> => ({ ok: true, value: mergeAll(notes, "All ten.") }));
      const runner = consolidatorWith(sideCall);
      askNow(runner);
      await runner.idle();
      expect(listMemories(handle.db, workspace)).toHaveLength(1);

      // A person puts nine of them back one at a time, later.
      const later = Date.now() + 1_000;
      for (const entry of notes.slice(0, 9)) expect(restoreMemory(handle.db, entry.id, later).ok).toBe(true);
      expect(listMemories(handle.db, workspace)).toHaveLength(10);

      expect(runner.check()).toEqual([]);
      expect(entriesNewSinceConsolidated(handle.db, workspace).sort()).toEqual(notes.slice(0, 9).map((entry) => entry.id).sort());
    });
  });

  describe("duplicates, without a model (EO-576)", () => {
    type AnyRequest = SideCallRequest<unknown>;
    type AnyAnswer = SideCallResult<unknown>;
    const idsIn = (input: string) => [...input.matchAll(/^### (\S+) /gm)].map((match) => match[1]!);
    const isBatch = (request: AnyRequest) => request.system === MEMORY_CONSOLIDATE_SYSTEM;
    const ids = (entries: readonly MemoryEntryView[]) => entries.map((entry) => entry.id);
    /** The heading a call's input gives one entry. */
    const headingOf = (input: string, id: string) => input.split("\n").find((line) => line.startsWith(`### ${id} `))!;

    /** Two notes EO's own project memory held about a fresh worktree, written by different runs. */
    const WORKTREE = [
      "A fresh EO worktree has no node_modules and the workspace packages are unbuilt. Before vitest can run in apps/desktop: `pnpm install --frozen-lockfile`, then `pnpm turbo run build --filter='./packages/*'`. Without the build, every desktop test fails with \"Failed to resolve entry for package @eo/core\".",
      'In a fresh worktree, `npx vitest run <file>` in apps/desktop fails with "Failed to resolve entry for package "@eo/core"" until the workspace packages are built: run `npx turbo run build --filter=@eo/core --filter=@eo/engine` from the root once (or `pnpm typecheck`, which builds them first), after `pnpm install --frozen-lockfile`.',
    ];
    const RELEASE = [
      "Release pipeline: the Release step tags whatever is at the tip of origin/main at the moment it runs, not the commit the item was filed against.",
      "The Release step of the release pipeline tags the tip of origin/main as it is when the step runs, not the commit the item was filed against, so merge first.",
    ];
    const UNRELATED = [
      "Renderer timestamps on the IPC contract are epoch milliseconds, never ISO strings.",
      "The self-hosted Windows runner is a virtual machine on a Linux host.",
      "Drizzle's migrator applies only migrations whose journal entry is newer than the last one run.",
      "CI's lint step fails on an unused import and stops the run before any test step.",
      "A step's watch give-up time is stored in hours and must be above zero.",
      "Codex sends tool names with a slash where Claude uses the mcp__ prefix.",
      "BoardCard and CommentThread are memoised, and render-count tests guard them.",
      "The MCP host caps one tool answer at forty thousand characters.",
      "Long lists in the renderer draw through VirtualRows, never a plain map.",
    ];

    it("retires word-for-word duplicates before any side call, keeping the newest of each, under one consolidation that restore undoes", async () => {
      const at = Date.now() - DAY;
      const install = [
        byAgent(workspace, "A fresh EO worktree needs `pnpm install` first.", at),
        byAgent(workspace, "a fresh EO worktree needs pnpm install first", at + 1),
        byAgent(workspace, "A fresh  EO worktree needs\npnpm install first,", at + 2),
      ];
      const lint = [byAgent(workspace, "Run pnpm lint before pushing.", at + 3), byAgent(workspace, "Run pnpm lint before pushing.", at + 4)];
      const distinct = UNRELATED.map((body, index) => byAgent(workspace, body, at + 10 + index));
      // Pairs that differ only in an operator or in brackets say different things: all four go to the model.
      const operators = [
        byAgent(workspace, "Retry the push when a != b.", at + 20),
        byAgent(workspace, "Retry the push when a = b.", at + 21),
        byAgent(workspace, "Evaluate (a + b) * c before pushing.", at + 22),
        byAgent(workspace, "Evaluate a + b * c before pushing.", at + 23),
      ];
      // A person's entries are never folded, not even into each other's, nor one repeating an agent's.
      const mine = [byPerson(workspace, "A fresh EO worktree needs pnpm install first.", at + 30), byPerson(workspace, "A fresh EO worktree needs pnpm install first.", at + 31)];
      const requests: { request: AnyRequest; active: string[] }[] = [];
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        requests.push({ request, active: ids(listMemories(handle.db, workspace)) });
        return { ok: true, value: NOTHING };
      });

      askNow(consolidatorWith(sideCall as never));
      await consolidator!.idle();

      const retired = [install[0]!, install[1]!, lint[0]!];
      const kept = [install[2]!, lint[1]!];
      // Already retired when the one side call was made, and not given to it.
      expect(requests).toHaveLength(1);
      expect(requests[0]!.active.sort()).toEqual(ids([...kept, ...distinct, ...operators, ...mine]).sort());
      expect(idsIn(requests[0]!.request.input).sort()).toEqual(ids([...kept, ...distinct, ...operators]).sort());

      const rows = listConsolidations(handle.db, workspace);
      expect(rows).toHaveLength(2);
      const folded = rows.find((row) => row.retiredIds.length > 0)!;
      expect(folded).toMatchObject({ status: "succeeded", writtenIds: [], trigger: "manual" });
      expect([...folded.retiredIds].sort()).toEqual(ids(retired).sort());
      expect(folded.note).toContain("3 entries that repeated another word for word were retired without asking a model");
      for (const entry of retired) expect(everything(workspace).find((row) => row.id === entry.id)).toMatchObject({ retiredReason: "consolidated", consolidationId: folded.id });
      for (const entry of [...kept, ...mine]) expect(everything(workspace).find((row) => row.id === entry.id)).toMatchObject({ retiredAt: null });
      expect(rows.flatMap((row) => row.retiredIds)).not.toEqual(expect.arrayContaining([mine[0]!.id]));
      expect(rows.flatMap((row) => row.retiredIds)).not.toEqual(expect.arrayContaining([mine[1]!.id]));

      const restored = restoreConsolidation(handle.db, folded.id);
      expect(restored).toMatchObject({ ok: true, restored: 3, retired: 0 });
      expect(ids(listMemories(handle.db, workspace)).sort()).toEqual(ids([...install, ...lint, ...distinct, ...operators, ...mine]).sort());
    });

    it("marks near duplicates the full-text index finds in the input of the batch they share, and nothing else", async () => {
      const at = Date.now() - DAY;
      const worktree = WORKTREE.map((body, index) => byAgent(workspace, body, at + index));
      const release = RELEASE.map((body, index) => byAgent(workspace, body, at + 10 + index));
      const distinct = UNRELATED.slice(0, 6).map((body, index) => byAgent(workspace, body, at + 20 + index));
      byPerson(workspace, RELEASE[0]!, at + 30);
      const requests: AnyRequest[] = [];
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        requests.push(request);
        return { ok: true, value: NOTHING };
      });

      askNow(consolidatorWith(sideCall as never));
      await consolidator!.idle();

      expect(requests).toHaveLength(1);
      const { input } = requests[0]!;
      expect(headingOf(input, worktree[0]!.id)).toContain(`; likely a duplicate of ${worktree[1]!.id})`);
      expect(headingOf(input, worktree[1]!.id)).toContain(`; likely a duplicate of ${worktree[0]!.id})`);
      expect(headingOf(input, release[0]!.id)).toContain(`; likely a duplicate of ${release[1]!.id})`);
      expect(headingOf(input, release[1]!.id)).toContain(`; likely a duplicate of ${release[0]!.id})`);
      for (const entry of distinct) expect(headingOf(input, entry.id)).not.toContain("likely a duplicate");
      expect(input).toContain('Entries marked "likely a duplicate of"');
    });

    it("puts near duplicates whose ages fall in different batches into the same batch, marked there", async () => {
      const first = byAgent(workspace, WORKTREE[0]!, Date.now() - 2 * DAY);
      const fillers = Array.from({ length: 40 }, (_, index) => byAgent(workspace, `Note ${index}: ${"y".repeat(80)}`, Date.now() - DAY + index * 1_000));
      const last = byAgent(workspace, WORKTREE[1]!, Date.now() - HOUR);
      // The index ranks the later note last among the first one's neighbours: grown by likeness alone, the first batch fills before it is reached.
      const neighbours = () =>
        new Map([
          [first.id, [...ids(fillers.slice(0, 29)), last.id]],
          [last.id, [first.id]],
        ]);
      const requests: AnyRequest[] = [];
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        requests.push(request);
        return { ok: true, value: isBatch(request) ? NOTHING : { groups: [] } };
      });

      askNow(consolidatorWith(sideCall as never, { neighbours }));
      await consolidator!.idle();

      const batches = requests.filter(isBatch);
      expect(batches).toHaveLength(2);
      const withFirst = batches.find((request) => idsIn(request.input).includes(first.id))!;
      expect(idsIn(withFirst.input)).toContain(last.id);
      expect(idsIn(withFirst.input)).toHaveLength(CONSOLIDATION_BATCH_MAX_ENTRIES);
      expect(headingOf(withFirst.input, first.id)).toContain(`; likely a duplicate of ${last.id})`);
      expect(headingOf(withFirst.input, last.id)).toContain(`; likely a duplicate of ${first.id})`);
      const other = batches.find((request) => request !== withFirst)!;
      expect(other.input).not.toContain("likely a duplicate");
    });
  });

  describe("skill proposals after it (EO-575)", () => {
    type AnyRequest = SideCallRequest<unknown>;
    type AnyAnswer = SideCallResult<unknown>;
    const BODY = "## Trigger\nWhen the e2e suite runs.\n\n## Steps\n1. `pnpm e2e`.\n\n## Verification\nEvery spec passes.";
    const proposal = (scope: MemoryScope, entryIds: string[], slug = "run-e2e") => ({
      kind: "new",
      slug,
      name: "Run e2e",
      description: "Run this repository's e2e suite.",
      scope,
      evidence: { entryIds, itemIds: [itemId] },
      body: BODY,
    });
    const noSkills = async (): Promise<AnyAnswer> => ({ ok: true, value: { skills: [] } });
    /** Every comment written anywhere: a proposal posts none (EO-728). */
    const posted = () => handle.db.all(sql`select id from comments`);

    it("are asked for in a call of their own after the consolidation succeeds, given the entries it left, the existing skills and every discarded proposal, and answer at most three", async () => {
      const at = Date.now() - 3 * DAY;
      const agents = Array.from({ length: 10 }, (_, index) => byAgent(workspace, `Agent note ${index}`, at + index));
      byPerson(workspace, "A person wrote this.", at);
      const skill = saveSkill(handle.db, { slug: "run-tests", name: "Run the tests", description: "Run this repository's tests.", body: "## Steps\nRun them.", files: [] });
      if (!skill.ok) throw new Error(skill.problems.join(" "));
      const discarded = recordSkillProposal(handle.db, {
        consolidationId: "earlier",
        scope: workspace,
        kind: "new",
        targetSlug: null,
        targetSkillId: null,
        slug: "cut-release",
        name: "Cut a release",
        description: "Cut a release of the API.",
        body: BODY,
        evidenceEntryIds: [],
        evidenceItemIds: [],
        coveringEntryIds: [],
        fingerprint: "cut-release",
        unsaveable: null,
        commentId: null,
        createdAt: at,
      });
      decideSkillProposal(handle.db, discarded.id, { status: "discarded", now: at });
      const order: string[] = [];
      const sideCall = vi.fn(async (_request: ConsolidateRequest): Promise<Answer> => {
        order.push("consolidate");
        return { ok: true, value: mergeAll(agents.slice(0, 6), "Merged.") };
      });
      const proposeSkills = vi.fn(async (_request: AnyRequest): Promise<AnyAnswer> => {
        order.push("propose");
        return noSkills();
      });

      askNow(consolidatorWith(sideCall, { proposeSkills }));
      await consolidator!.idle();

      expect(order).toEqual(["consolidate", "propose"]);
      // The consolidation is asked for operations only, and told nothing of skills.
      const consolidating = sideCall.mock.calls[0]![0];
      expect(consolidating.system).toBe(MEMORY_CONSOLIDATE_SYSTEM);
      expect(consolidating.input).not.toContain("## Existing skills");
      expect(consolidating.input).not.toContain("cut-release");
      const withSkills = consolidating.schema.parse({ ...NOTHING, skills: [proposal(workspace, [agents[0]!.id])] });
      expect(withSkills).not.toHaveProperty("skills");

      const request = proposeSkills.mock.calls[0]![0];
      expect(request).toMatchObject({ purpose: "memory_consolidate", backend: systemBackend, projectId, system: MEMORY_PROPOSE_SKILLS_SYSTEM });
      expect(request.insideRunId).toBeUndefined();
      // The scope as the consolidation left it: what it wrote and what it left, not what it retired, nor a person's.
      const left = listMemories(handle.db, workspace).filter((entry) => entry.source.type !== "person");
      expect(left.map((entry) => entry.body).sort()).toEqual(["Merged.", ...agents.slice(6).map((entry) => entry.body)].sort());
      for (const entry of left) {
        expect(request.input).toContain(`### ${entry.id} (written`);
        expect(request.input).toContain(entry.body);
      }
      for (const entry of agents.slice(0, 6)) expect(request.input).not.toContain(entry.id);
      expect(request.input).not.toContain("A person wrote this.");
      expect(request.input).toContain("### run-tests (global)");
      expect(request.input).toContain("- `cut-release`: Cut a release of the API.");

      const ids = left.map((entry) => entry.id);
      const three = ["one", "two", "three"].map((slug) => proposal(workspace, ids.slice(0, 1), slug));
      expect(request.schema.safeParse({ skills: three }).success).toBe(true);
      expect(request.schema.safeParse({ skills: [...three, proposal(workspace, ids.slice(0, 1), "four")] }).success).toBe(false);
      // Evidence is one of the entries it was given: not one the consolidation retired.
      expect(request.schema.safeParse({ skills: [proposal(workspace, [agents[0]!.id])] }).success).toBe(false);
    });

    it("are not asked for after a consolidation that fails", async () => {
      Array.from({ length: 10 }, (_, index) => byAgent(workspace, `Agent note ${index}`, Date.now() - DAY + index));
      const proposeSkills = vi.fn(noSkills);
      askNow(consolidatorWith(async () => ({ ok: false, reason: "schema", message: "Not the shape asked for." }), { proposeSkills }));
      await consolidator!.idle();

      expect(listConsolidations(handle.db, workspace)).toMatchObject([{ status: "failed" }]);
      expect(proposeSkills).not.toHaveBeenCalled();
    });

    it("leave the consolidation applied, and post nothing, when the call fails or throws", async () => {
      const agents = Array.from({ length: 10 }, (_, index) => byAgent(workspace, `Agent note ${index}`, Date.now() - DAY + index));
      const sideCall = vi.fn(async (): Promise<Answer> => ({ ok: true, value: mergeAll(agents, "All ten.") }));
      askNow(consolidatorWith(sideCall, { proposeSkills: async () => ({ ok: false, reason: "timeout", message: "It ran past its time." }) }));
      await consolidator!.idle();

      const [consolidation] = listConsolidations(handle.db, workspace);
      expect(consolidation).toMatchObject({ status: "succeeded", retiredIds: expect.arrayContaining(agents.map((entry) => entry.id)) });
      expect(consolidation!.note).toContain("Skills were not proposed: It ran past its time.");
      expect(listMemories(handle.db, workspace).map((entry) => entry.body)).toEqual(["All ten."]);
      expect(posted()).toEqual([]);
      // Settled as any success is: not asked again for the failed proposals.
      expect(consolidator!.check()).toEqual([]);

      consolidator!.stop();
      const more = Array.from({ length: 10 }, (_, index) => byAgent(workspace, `Later note ${index}`, Date.now() + 1_000 + index));
      askNow(
        consolidatorWith(async () => ({ ok: true, value: mergeAll(more, "Ten more.") }), {
          proposeSkills: async () => {
            throw new Error("The backend went away.");
          },
        }),
      );
      await consolidator!.idle();
      expect(listConsolidations(handle.db, workspace)[0]).toMatchObject({ status: "succeeded" });
      expect(listMemories(handle.db, workspace).map((entry) => entry.body).sort()).toEqual(["All ten.", "Ten more."]);
      expect(posted()).toEqual([]);
    });

    it("are asked for once after a run in batches, after its cross-batch pass, and not after a run whose batch fails", async () => {
      const at = Date.now() - DAY;
      Array.from({ length: 70 }, (_, index) => byAgent(workspace, `Note ${index}: ${"y".repeat(80)}`, at + index * 1_000));
      const order: string[] = [];
      let failSecond = true;
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        if (request.system === MEMORY_CONSOLIDATE_SYSTEM) {
          order.push("batch");
          return order.filter((call) => call === "batch").length === 2 && failSecond ? { ok: false, reason: "schema", message: "Not the shape asked for." } : { ok: true, value: NOTHING };
        }
        order.push(request.system === MEMORY_MERGE_CANDIDATES_SYSTEM ? "candidates" : "merge");
        return { ok: true, value: { groups: [] } };
      });
      const proposeSkills = vi.fn(async (): Promise<AnyAnswer> => {
        order.push("propose");
        return noSkills();
      });

      askNow(consolidatorWith(sideCall as never, { neighbours: () => null, proposeSkills }));
      await consolidator!.idle();
      expect(order).toEqual(["batch", "batch"]);
      expect(proposeSkills).not.toHaveBeenCalled();

      consolidator!.stop();
      failSecond = false;
      order.length = 0;
      askNow(consolidatorWith(sideCall as never, { neighbours: () => null, proposeSkills, now: () => Date.now() + 2 * HOUR }));
      await consolidator!.idle();
      expect(order.at(-1)).toBe("propose");
      expect(order.filter((call) => call === "propose")).toHaveLength(1);
      expect(order.at(-2)).toBe("candidates");
    });

    it("leave in memory, when applied, what the run's batches and cross-batch pass folded from several, and a rewrite of it, and move what they did not fold", async () => {
      const at = Date.now() - DAY;
      const entries = Array.from({ length: 40 }, (_, index) => byAgent(workspace, `Note ${index}: ${"y".repeat(80)}`, at + index * 1_000));
      const [a, b, untouched] = [entries[0]!, entries[1]!, entries[5]!];
      // The fold keeps the age of the newer of the two, b, and the pass dates its "yesterday" from that (EO-913).
      const shorter = `Notes 0 and 1, checked ${resolvedDate("yesterday", b.createdAt)!}.`;
      const sideCall = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        if (request.system === MEMORY_CONSOLIDATE_SYSTEM) {
          // The first batch folds two entries into one; the second changes nothing.
          return { ok: true, value: request.input.includes(a.id) ? { ...NOTHING, merge: [{ from: [a.id, b.id], body: "Notes 0 and 1, checked yesterday.", contradictsRepositoryFile: false }] } : NOTHING };
        }
        const folded = listMemories(handle.db, workspace).find((entry) => entry.body === "Notes 0 and 1, checked yesterday.")!;
        if (request.system === MEMORY_MERGE_CANDIDATES_SYSTEM) return { ok: true, value: { groups: [{ ids: [folded.id, entries[35]!.id] }] } };
        // The pass's last call only dates the folded one: a rewrite of an entry folded from several.
        const value = { ...NOTHING, rewrite: [{ id: folded.id, body: shorter, contradictsRepositoryFile: false, reason: "relative_date" as const }] };
        return { ok: true, value: request.schema.parse(value) };
      });
      const proposeSkills = vi.fn(async (request: AnyRequest): Promise<AnyAnswer> => {
        const reworded = listMemories(handle.db, workspace).find((entry) => entry.body === shorter)!;
        return { ok: true, value: request.schema.parse({ skills: [proposal(workspace, [reworded.id, untouched.id])] }) };
      });

      askNow(consolidatorWith(sideCall as never, { neighbours: () => null, proposeSkills }));
      await consolidator!.idle();

      expect(proposeSkills).toHaveBeenCalledTimes(1);
      // Nothing is posted (EO-728); the untouched entry moved, the reworded fold stayed.
      expect(posted()).toEqual([]);
      const active = listMemories(handle.db, workspace).map((entry) => entry.body);
      expect(active).toContain(shorter);
      expect(active).not.toContain(untouched.body);
    });
  });

  describe("asked for by a person (EO-589)", () => {
    const notes = (scope: MemoryScope, count: number) => Array.from({ length: count }, (_, index) => byAgent(scope, `Note ${index}`, Date.now() - DAY + index));
    const triggers = (scope: MemoryScope) => listConsolidations(handle.db, scope).map((row) => `${row.trigger}:${row.status}`);
    /** A side call that answers only when told to. */
    function heldCall() {
      let release: (answer: Answer) => void = () => {};
      const sideCall = vi.fn(() => new Promise<Answer>((resolve) => (release = resolve)));
      return { sideCall, release: (answer: Answer) => release(answer) };
    }

    it("runs on a scope not due on the schedule, at once, recorded with the trigger manual", async () => {
      const entries = notes(workspace, 3);
      const sideCall = vi.fn(async (_request: ConsolidateRequest): Promise<Answer> => ({ ok: true, value: mergeAll(entries, "All three, as one.") }));
      const changed = vi.fn();
      const runner = consolidatorWith(sideCall, { onPendingChanged: changed });
      runner.start();
      await runner.idle();
      // Not due by itself: never a day old with five runs.
      expect(runner.check()).toEqual([]);
      expect(sideCall).not.toHaveBeenCalled();

      const answer = runner.requestNow(workspace);
      expect(answer).toEqual({ outcome: "started", message: 'Consolidation of the workspace "api" has started.' });
      expect(runner.pending(workspace)).toBe("running");
      await runner.idle();

      expect(sideCall).toHaveBeenCalledTimes(1);
      expect(sideCall.mock.calls[0]![0].system).toBe(MEMORY_CONSOLIDATE_SYSTEM);
      expect(triggers(workspace)).toEqual(["manual:succeeded"]);
      expect(listMemories(handle.db, workspace).map((entry) => entry.body)).toEqual(["All three, as one."]);
      expect(runner.pending(workspace)).toBeNull();
      // Said when it was queued and started, and when it ended.
      expect(changed).toHaveBeenCalledWith(workspace);
      expect(changed.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("runs on a scope backing off a day after three failures in a row, without waiting for the backoff to end", async () => {
      notes(workspace, 10);
      const clock = Date.now();
      for (let index = 0; index < 3; index += 1) {
        const row = startConsolidation(handle.db, { scope: workspace, trigger: "schedule", now: clock - 3 * HOUR + index });
        failConsolidation(handle.db, row.id, { reason: "error", note: "The backend fell over.", now: clock - 3 * HOUR + index + 1 });
      }
      const sideCall = vi.fn(async (): Promise<Answer> => ({ ok: true, value: NOTHING }));
      const runner = consolidatorWith(sideCall, { now: () => clock });
      runner.start();
      await runner.idle();
      // Backing off: the automatic loop leaves it until tomorrow.
      expect(runner.check()).toEqual([]);
      expect(sideCall).not.toHaveBeenCalled();

      expect(runner.requestNow(workspace).outcome).toBe("started");
      await runner.idle();
      expect(sideCall).toHaveBeenCalledTimes(1);
      expect(triggers(workspace)[0]).toBe("manual:succeeded");
    });

    it("is queued behind pipeline work and starts only once the pipeline is idle", async () => {
      notes(workspace, 3);
      let busy = true;
      const sideCall = vi.fn(async (): Promise<Answer> => ({ ok: true, value: NOTHING }));
      const runner = consolidatorWith(sideCall, { pipelineBusy: () => busy });
      runner.start();
      await runner.idle();

      const answer = runner.requestNow(workspace);
      expect(answer).toMatchObject({ outcome: "queued", behind: "pipeline" });
      expect(answer.message).toContain("starts once nothing is waiting to be dispatched and no run is going");
      await runner.idle();
      expect(sideCall).not.toHaveBeenCalled();
      expect(listConsolidations(handle.db, workspace)).toEqual([]);
      expect(runner.pending(workspace)).toBe("queued");
      // Still queued after a look: the automatic loop does not drop it.
      expect(runner.check()).toEqual([{ scope: workspace, trigger: "manual" }]);

      busy = false;
      runner.poke();
      await vi.waitFor(() => expect(sideCall).toHaveBeenCalledTimes(1));
      await runner.idle();
      expect(triggers(workspace)).toEqual(["manual:succeeded"]);
      expect(runner.pending(workspace)).toBeNull();
    });

    it("is queued behind another scope's consolidation, since they run one at a time", async () => {
      notes(workspace, 10);
      notes(project, 2);
      const held = heldCall();
      const runner = consolidatorWith(held.sideCall);
      runner.start();
      // The workspace, asked for first, is consolidating.
      expect(runner.requestNow(workspace).outcome).toBe("started");
      await vi.waitFor(() => expect(held.sideCall).toHaveBeenCalledTimes(1));
      expect(runner.requestNow(project)).toMatchObject({ outcome: "queued", behind: "consolidation" });
      expect(runner.pending(project)).toBe("queued");
      held.release({ ok: true, value: NOTHING });
      await vi.waitFor(() => expect(held.sideCall).toHaveBeenCalledTimes(2));
      held.release({ ok: true, value: NOTHING });
      await runner.idle();
      expect(triggers(project)).toEqual(["manual:succeeded"]);
    });

    it("adds nothing when one of the scope is already queued or running, and says so", async () => {
      notes(workspace, 3);
      let busy = true;
      const held = heldCall();
      const runner = consolidatorWith(held.sideCall, { pipelineBusy: () => busy });
      runner.start();
      await runner.idle();

      expect(runner.requestNow(workspace).outcome).toBe("queued");
      expect(runner.requestNow(workspace)).toEqual({ outcome: "already", state: "queued", message: 'A consolidation of the workspace "api" is already queued, so nothing was added.' });

      busy = false;
      runner.poke();
      await vi.waitFor(() => expect(held.sideCall).toHaveBeenCalledTimes(1));
      expect(runner.requestNow(workspace)).toEqual({ outcome: "already", state: "running", message: 'A consolidation of the workspace "api" is already running, so nothing was added.' });
      held.release({ ok: true, value: NOTHING });
      await runner.idle();
      expect(held.sideCall).toHaveBeenCalledTimes(1);
      expect(triggers(workspace)).toEqual(["manual:succeeded"]);
    });

    it("is refused, with a sentence and nothing queued, while the engine is paused", async () => {
      notes(workspace, 3);
      let paused = true;
      const sideCall = vi.fn(async (): Promise<Answer> => ({ ok: true, value: NOTHING }));
      const runner = consolidatorWith(sideCall, { canStart: () => !paused });
      runner.start();
      const answer = runner.requestNow(workspace);
      expect(answer).toMatchObject({ outcome: "refused", reason: "paused" });
      expect(answer.message).toContain("EO is paused");
      expect(runner.pending(workspace)).toBeNull();
      // Nothing waits to start on resume.
      paused = false;
      runner.poke();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await runner.idle();
      expect(sideCall).not.toHaveBeenCalled();
      expect(listConsolidations(handle.db, workspace)).toEqual([]);
    });

    it("is refused for a scope with no agent-written entries, for an unknown scope id, and for a scope whose project an organisation's record holds", async () => {
      byPerson(workspace, "A person's note.", Date.now() - HOUR);
      notes(project, 3);
      const sideCall = vi.fn(async (): Promise<Answer> => ({ ok: true, value: NOTHING }));
      const held = new Set<string>();
      const runner = consolidatorWith(sideCall, { heldElsewhere: (id) => held.has(id) });
      runner.start();
      await runner.idle();

      const noAgents = runner.requestNow(workspace);
      expect(noAgents).toMatchObject({ outcome: "refused", reason: "no_agent_entries" });
      expect(noAgents.message).toBe('The workspace "api" holds no active entry an agent wrote, so there is nothing to consolidate: a person\'s entries are never consolidated.');

      const unknown = runner.requestNow({ kind: "project", id: "no-such-project" });
      expect(unknown).toEqual({ outcome: "refused", reason: "unknown_scope", message: 'No project has the id "no-such-project", so there is nothing to consolidate.' });

      held.add(projectId);
      const elsewhere = runner.requestNow(project);
      expect(elsewhere).toMatchObject({ outcome: "refused", reason: "held_by_record" });
      expect(elsewhere.message).toContain("organisation's record");

      await runner.idle();
      expect(sideCall).not.toHaveBeenCalled();
      for (const scope of [workspace, project]) {
        expect(runner.pending(scope)).toBeNull();
        expect(listConsolidations(handle.db, scope)).toEqual([]);
      }
    });

    it("is refused once the consolidator is stopped", () => {
      notes(workspace, 3);
      const runner = consolidatorWith(vi.fn());
      expect(runner.requestNow(workspace)).toMatchObject({ outcome: "refused", reason: "unavailable" });
    });

    it("writes a failed row when it fails, as any other does, and the next automatic attempt backs off from it", async () => {
      givenToFiveRuns(notes(workspace, 10));
      let clock = Date.now() + DAY;
      const sideCall = vi.fn(async (): Promise<Answer> => ({ ok: false, reason: "error", message: "The backend fell over." }));
      const runner = consolidatorWith(sideCall, { now: () => clock });
      // The automatic one fails: an hour's backoff.
      runner.start();
      await runner.idle();
      expect(triggers(workspace)).toEqual(["schedule:failed"]);

      // Asked for inside that hour, and failing too: two in a row.
      expect(runner.requestNow(workspace).outcome).toBe("started");
      await runner.idle();
      expect(sideCall).toHaveBeenCalledTimes(2);
      expect(listConsolidations(handle.db, workspace)[0]).toMatchObject({ trigger: "manual", status: "failed", note: "The backend fell over." });

      // So the next automatic attempt waits four hours, not one.
      clock += CONSOLIDATION_BACKOFF_MS[0];
      expect(runner.check()).toEqual([]);
      clock += CONSOLIDATION_BACKOFF_MS[1] - CONSOLIDATION_BACKOFF_MS[0];
      expect(runner.check()).toEqual([{ scope: workspace, trigger: "schedule" }]);
    });
  });
});
