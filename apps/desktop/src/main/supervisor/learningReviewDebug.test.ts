import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEBUG_SENT_EVENT,
  DebugSentSchema,
  FOLDER_KIND,
  LEARNING_REVIEW_ACTIVITY_EVENTS,
  LEARNING_REVIEW_EVENT,
  MEMORY_USED_FIELD,
  type AgentEvent,
  type AgentForkResult,
  type AgentProvider,
  type AgentProviderResumeOptions,
  type Item,
  type MemoryScope,
  type Uuid,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { addMemory, createProject, createWorkspace, getRun, listRunEvents, listRunsForItem, listSideCalls, memoryUsageByEntry, skillsLoadedByRun, skillUsageById } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { writeDebugMode } from "../debug/debugMode.js";
import { createFakeProvider } from "../providers/fake.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * Debug mode's record of the learning review (EO-734), driven through a
 * real dispatch on the fake backend and a scripted fork: what the fork
 * was sent and what it did, on the reviewed run's log under types of its
 * own — and with debug mode off, nothing beyond what was always written.
 */

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

/** The run's own types, which nothing the review did may be written as. */
const RUN_TYPES = ["tool_call", "tool_result", "output", "skill_loaded", "skills_delivered", "memory_used", "usage"];

/** What the scripted fork does: a memory_read call and its answer, a skill load, its spend and its answer. */
const FORK_EVENTS = (forkId: string): AgentEvent[] => [
  { type: "thread_started", threadId: forkId, model: "the-agents-model" },
  { type: "skills_delivered", slugs: ["house-style"] },
  { type: "tool_call", name: "memory_read", args: { scope: "project" }, callId: "rc1" },
  { type: "tool_result", name: "memory_read", callId: "rc1", ok: true, output: "1 entry: seed the fixtures", truncated: false },
  { type: "skill_loaded", slug: "house-style" },
  { type: "usage", scope: "turn", tokensIn: 1_000, tokensOut: 50, costCents: 2 },
  { type: "output", text: "Nothing new worth saving." },
];

interface World {
  handle: DbHandle;
  folder: string;
  item: Item;
  project: MemoryScope;
  entryId: string;
}

let writes: TestWriteBridge;
const worlds: World[] = [];

beforeEach(async () => {
  writes = await startTestWriteBridge();
});

afterEach(async () => {
  await writes.close();
  for (const world of worlds.splice(0)) {
    world.handle.close();
    rmSync(world.folder, { recursive: true, force: true });
  }
});

/** A project with one memory entry and an item on it, in a database of its own. */
function world(): World {
  const handle = openMigratedTestDb();
  const folder = mkdtempSync(join(tmpdir(), "eo-learning-review-debug-"));
  const w = createWorkspace(handle.db, { kind: FOLDER_KIND, config: { path: folder } });
  const p = createProject(handle.db, { name: "Payments", keyPrefix: "PAY", workspaceIds: [w.id] });
  const project: MemoryScope = { kind: "project", id: p.id };
  const entry = addMemory(handle.db, { scope: project, body: "Seed the fixtures database first.", source: { type: "person", personId: null } });
  if (!entry.ok) throw new Error("the memory entry was not written");
  const item = createTestItem(handle.db, { type: "story", title: "Add CSV export", stepId: "todo", projectId: p.id, workspaceId: w.id });
  const made = { handle, folder, item, project, entryId: entry.entry.id };
  worlds.push(made);
  return made;
}

/** The fake backend for the run, which answers using the entry it was given, and a fork that plays `FORK_EVENTS`. */
function reviewing(entryId: string) {
  const fake = createFakeProvider({
    steps: [{ toolCall: { name: "Read", args: { path: "src/export.ts" }, answer: "export {}" } }, { output: "Added the export." }],
    usage: { tokensIn: 400, tokensOut: 40, costCents: 3 },
    result: { branch: "eo/PAY-1", summary: "Did the work.", handoff: "Nothing to flag.", [MEMORY_USED_FIELD]: [entryId] },
  });
  const forks: { threadId: string; message: string; opts: AgentProviderResumeOptions }[] = [];
  const provider: AgentProvider = {
    ...fake,
    async fork(threadId, message, opts): Promise<AgentForkResult> {
      forks.push({ threadId, message, opts: opts ?? {} });
      const forkId = `fork-of-${threadId}`;
      async function* events(): AsyncIterable<AgentEvent> {
        yield* FORK_EVENTS(forkId);
      }
      return { ok: true, threadId: forkId, events: events() };
    },
  };
  return { provider, forks };
}

async function runReviewed(at: World, debug: boolean) {
  writeDebugMode(at.handle.db, debug);
  const { provider, forks } = reviewing(at.entryId);
  const supervisor = createRunSupervisor({
    db: at.handle.db,
    provider,
    limits: LIMITS,
    agentWriteBridge: writes.agentWriteBridge,
    sideCalls: { provider: () => createFakeProvider({}), smallModel: async () => null },
  });
  writes.serve(supervisor);
  await supervisor.runOnce();
  const run = listRunsForItem(at.handle.db, at.item.id)[0]!;
  return { run, forks, events: listRunEvents(at.handle.db, run.id as Uuid) };
}

describe("the learning review, with debug mode on", () => {
  it("records what the fork was sent as one learning_review send: the prompt as passed to fork, the thread it forked and the session", async () => {
    const at = world();
    const { run, forks, events } = await runReviewed(at, true);

    expect(forks).toHaveLength(1);
    const sends = events.filter((event) => event.type === DEBUG_SENT_EVENT).map((event) => DebugSentSchema.parse(event.payload));
    const reviewSends = sends.filter((send) => send.purpose === "learning_review");
    expect(reviewSends).toHaveLength(1);
    const [send] = reviewSends;
    expect(send!.prompt).toBe(forks[0]!.message);
    expect(send!.thread).toEqual({ mode: "forked", threadId: run.threadId, refusal: null });
    // A fork sends no instructions: the copy keeps the run's.
    expect(send!.instructions.sent).toBe(false);
    expect(send!.session).toEqual(expect.objectContaining({ backend: "fake", outputSchema: null, cwd: forks[0]!.opts.cwd ?? null }));
    // And the run's own dispatch is still its own, and first.
    expect(sends[0]!.purpose).toBe("dispatch");
  });

  it("records the fork's tool calls, results and answer under learning-review types, each with the fork's thread, and nothing under the run's own", async () => {
    const at = world();
    const { run, events } = await runReviewed(at, true);
    const forkThreadId = `fork-of-${run.threadId}`;

    const reviewSendAt = events.findIndex((event) => event.type === DEBUG_SENT_EVENT && (event.payload as { purpose?: string }).purpose === "learning_review");
    expect(reviewSendAt).toBeGreaterThan(0);
    const afterIt = events.slice(reviewSendAt + 1);
    // In the order the fork said them, then how the review ended.
    expect(afterIt.map((event) => event.type)).toEqual([
      LEARNING_REVIEW_ACTIVITY_EVENTS.tool_call,
      LEARNING_REVIEW_ACTIVITY_EVENTS.tool_result,
      LEARNING_REVIEW_ACTIVITY_EVENTS.output,
      LEARNING_REVIEW_EVENT,
    ]);
    expect(afterIt.slice(0, 3).map((event) => event.payload)).toEqual([
      expect.objectContaining({ name: "memory_read", args: { scope: "project" }, callId: "rc1", forkThreadId }),
      expect.objectContaining({ name: "memory_read", callId: "rc1", output: "1 entry: seed the fixtures", forkThreadId }),
      expect.objectContaining({ text: "Nothing new worth saving.", forkThreadId }),
    ]);
    // None of it written as the run's: every row of the run's own types
    // comes before the review was sent.
    expect(afterIt.filter((event) => RUN_TYPES.includes(event.type))).toEqual([]);
  });

  it("leaves a run's skill usage, memory use, turns and cost as they are with debug mode off", async () => {
    const off = world();
    const withoutDebug = await runReviewed(off, false);
    const on = world();
    const withDebug = await runReviewed(on, true);

    const counted = (at: World, runId: string) => {
      const run = getRun(at.handle.db, runId as Uuid)!;
      return {
        skillUsage: [...skillUsageById(at.handle.db).values()],
        skillsLoadedByRun: skillsLoadedByRun(at.handle.db, runId),
        memoryUse: memoryUsageByEntry(at.handle.db).get(at.entryId) ?? null,
        turns: run.turns,
        tokensIn: run.tokensIn,
        tokensOut: run.tokensOut,
        costCents: run.costCents,
        reviewSpend: listSideCalls(at.handle.db)
          .filter((call) => call.purpose === "learning_review")
          .map((call) => ({ tokensIn: call.tokensIn, tokensOut: call.tokensOut, costMicrocents: call.costMicrocents })),
      };
    };
    const baseline = counted(off, withoutDebug.run.id);
    expect(counted(on, withDebug.run.id)).toEqual(baseline);
    // And the comparison is of something: the run did use its memory, and spent.
    expect(baseline.memoryUse).toEqual({ deliveries: 1, uses: 1 });
    expect(baseline.costCents).toBe(3);
    expect(baseline.reviewSpend).toHaveLength(1);
  });

  it("is not recorded for a run whose own dispatch was not, as a correction is not", async () => {
    const at = world();
    writeDebugMode(at.handle.db, false);
    const { provider } = reviewing(at.entryId);
    // Debug mode turned on while the run is under way: its dispatch was
    // sent unrecorded, so its review is not recorded either.
    const wrapped: AgentProvider = {
      ...provider,
      fork: (threadId, message, opts) => {
        writeDebugMode(at.handle.db, true);
        return provider.fork!(threadId, message, opts);
      },
    };
    const supervisor = createRunSupervisor({ db: at.handle.db, provider: wrapped, limits: LIMITS, agentWriteBridge: writes.agentWriteBridge, sideCalls: { provider: () => createFakeProvider({}), smallModel: async () => null } });
    writes.serve(supervisor);
    await supervisor.runOnce();

    const run = listRunsForItem(at.handle.db, at.item.id)[0]!;
    const types = listRunEvents(at.handle.db, run.id as Uuid).map((event) => event.type);
    expect(types).not.toContain(DEBUG_SENT_EVENT);
    expect(types.filter((type) => type.startsWith("learning_review_"))).toEqual([]);
  });
});

describe("the learning review, with debug mode off", () => {
  it("appends the learning_review event and nothing else", async () => {
    const off = world();
    const { events } = await runReviewed(off, false);

    // Everything after the run's own last event is the review's.
    const reviewAt = events.findIndex((event) => event.type === LEARNING_REVIEW_EVENT);
    expect(reviewAt).toBeGreaterThan(0);
    expect(events.slice(reviewAt).map((event) => event.type)).toEqual([LEARNING_REVIEW_EVENT]);
    expect(events.map((event) => event.type)).not.toContain(DEBUG_SENT_EVENT);
    expect(events.filter((event) => event.type.startsWith("learning_review_"))).toEqual([]);

    // And with debug mode on, the run's own events are the same ones.
    const on = world();
    const recorded = await runReviewed(on, true);
    const runOwn = (list: typeof events) => list.filter((event) => event.type !== DEBUG_SENT_EVENT && !event.type.startsWith("learning_review")).map((event) => event.type);
    expect(runOwn(recorded.events)).toEqual(runOwn(events));
  });
});
