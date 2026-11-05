import type { IpcPushPayload, Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listRunEvents, listRunsForItem } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { liveDrafts } from "./liveDrafts.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { runLiveTurn } from "../ipc/conversationView.js";
import { validImplementResult } from "../providers/fixtures.js";

/**
 * Words reaching a window as they are written, and never the log
 * (`OutputDeltaEvent`, invariant 3's table kept to what happened rather
 * than every token of it).
 */
const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

let handle: DbHandle;
let item: Item;
let pushes: IpcPushPayload<"runs:delta">[];

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });
  pushes = [];
  liveDrafts.onDelta((push) => pushes.push(push));
});

afterEach(() => {
  liveDrafts.onDelta(null);
  handle.close();
});

describe("a run that streams its words", () => {
  it("pushes them as they come, stores only the finished block, and forgets the draft when the run ends", async () => {
    let seenMidRun: { text: string }[] = [];
    const supervisor = createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      provider: createFakeProvider({
        steps: [
          { delta: { stream: "reasoning", text: "The window is per key." } },
          { reasoning: "The window is per key." },
          { delta: { stream: "text", text: "Rate " } },
          { delta: { stream: "text", text: "limited." }, sleepMs: 30 },
          { output: "Rate limited." },
        ],
        result: { branch: "eo/EO-1", summary: "Did it.", handoff: "Nothing to flag." },
      }),
      onPushEvents: (runId) => {
        // Read while the run is going: the view's half of the store.
        seenMidRun = liveDrafts.snapshot(runId, -1);
      },
    });

    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    const types = listRunEvents(handle.db, run!.id).map((event) => event.type);
    expect(types).not.toContain("output_delta");
    expect(types).toContain("reasoning");
    expect(types).toContain("output");

    // Every word arrived, in order, against the run and the item.
    const byDraft = new Map<number, string>();
    for (const push of pushes) {
      expect(push).toMatchObject({ runId: run!.id, itemId: item.id });
      expect(push.offset).toBe((byDraft.get(push.draft.id) ?? "").length);
      byDraft.set(push.draft.id, (byDraft.get(push.draft.id) ?? "") + push.text);
    }
    expect([...byDraft.values()]).toEqual(["The window is per key.", "Rate limited."]);
    expect(pushes.map((push) => push.draft.stream)).toContain("reasoning");

    // Something was drawn mid-run, and nothing is left once it ended.
    expect(seenMidRun.length).toBeGreaterThan(0);
    expect(liveDrafts.snapshot(run!.id, -1)).toEqual([]);
  });
});

/**
 * A pipeline step's words are streamed too (milestone 4): a person
 * watching the step's transcript reads what the agent is writing as it
 * writes it, and `runs:live` is what that transcript asks for them.
 */
describe("a pipeline step's run", () => {
  let handle: DbHandle;
  let item: Item;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
  });

  afterEach(() => {
    handle.close();
  });

  it("asks the backend for its words as they are written — and not for its reasoning, which a conversation decides", async () => {
    const asked: Record<string, unknown>[] = [];
    const fake = createFakeProvider({ result: validImplementResult });
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: {
        ...fake,
        start: (opts) => {
          asked.push(opts as unknown as Record<string, unknown>);
          return fake.start(opts);
        },
      },
      limits: LIMITS,
    });

    await supervisor.runOnce();
    await supervisor.waitForIdle();

    expect(asked[0]?.["streamDeltas"]).toBe(true);
    expect(asked[0]?.["showReasoning"]).toBeUndefined();
  });

  it("is given what is left of its budgets as the turn's own cap", async () => {
    const asked: Record<string, unknown>[] = [];
    const fake = createFakeProvider({ result: validImplementResult });
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: {
        ...fake,
        start: (opts) => {
          asked.push(opts as unknown as Record<string, unknown>);
          return fake.start(opts);
        },
      },
      limits: LIMITS,
      guards: { dailyBudgetCents: 1_000, perItemBudgetCents: 400 },
    });

    await supervisor.runOnce();
    await supervisor.waitForIdle();

    // The least of the two, with nothing spent yet.
    expect(asked[0]?.["budgetCents"]).toBe(400);
  });

  it("is drawn live while it runs, and not once it has ended", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: {
        ...createFakeProvider({ result: validImplementResult }),
        start: async function* () {
          yield { type: "thread_started", threadId: "th" };
          yield { type: "output_delta", stream: "text", text: "Reading the module" };
          await held;
          yield { type: "result", data: validImplementResult as unknown as Record<string, unknown> };
        },
      },
      limits: LIMITS,
    });
    const ticking = supervisor.runOnce();
    await vi.waitFor(() => expect(runLiveTurn(handle.db, listRunsForItem(handle.db, item.id)[0]?.id ?? "")?.drafts[0]?.text).toBe("Reading the module"));

    release();
    await ticking;
    await supervisor.waitForIdle();
    expect(runLiveTurn(handle.db, listRunsForItem(handle.db, item.id)[0]!.id)).toBeNull();
  });
});
