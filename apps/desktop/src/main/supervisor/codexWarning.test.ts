import type { ThreadEvent } from "../providers/codexClient.js";
import { parsedResultOf, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listRunEvents } from "../db/repos/runEventsRepo.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createCodexProvider } from "../providers/codex.js";
import { validImplementResult, validImplementResultParsed } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/** The kind of thing the CLI raised on the reporting machine: a config warning, carried on an `ErrorItem`. */
const WARNING = "Codex could not apply some settings because this machine's requirements are managed by your organization.";

const USAGE: ThreadEvent = {
  type: "turn.completed",
  usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 },
};

/**
 * The real Codex adapter over a scripted stream — the SDK's events, not
 * EO's — so what is under test is the adapter and the supervisor
 * together, which is where the two disagreed.
 */
function codexPlaying(events: ThreadEvent[]) {
  const thread = {
    runStreamed: async () => ({
      events: (async function* () {
        yield* events;
      })(),
    }),
    run: async () => undefined,
  };
  return createCodexProvider({ createCodex: () => ({ startThread: () => thread, resumeThread: () => thread }) as never });
}

/**
 * A Codex warning does not fail the run (EO-369).
 *
 * The SDK documents `ErrorItem` as "a non-fatal error surfaced as an
 * item", and the CLI uses it for warnings. The supervisor ended the turn
 * on the first `error` event it saw, so a warning about enterprise-managed
 * config became the run's failure — on every attempt.
 */
describe("a Codex turn that raises a warning on the way", () => {
  let handle: DbHandle;
  let item: Item;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
  });

  afterEach(() => {
    handle.close();
  });

  async function runWith(events: ThreadEvent[]) {
    await createRunSupervisor({ db: handle.db, provider: codexPlaying(events), limits: LIMITS }).runOnce();
    const [run] = listRunsForItem(handle.db, item.id);
    return run!;
  }

  it("ends on the turn's final message rather than on the warning", async () => {
    const run = await runWith([
      { type: "thread.started", thread_id: "thr_1" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "i0", type: "error", message: WARNING } },
      { type: "item.completed", item: { id: "i1", type: "agent_message", text: JSON.stringify(validImplementResult) } },
      USAGE,
    ]);

    expect(run.status).toBe("succeeded");
    expect(run.error).toBeNull();
    expect(parsedResultOf(run.result)).toEqual(validImplementResultParsed);
  });

  it("keeps the warning's words in the run's events, where a person reading the run can see them", async () => {
    const run = await runWith([
      { type: "thread.started", thread_id: "thr_1" },
      { type: "item.completed", item: { id: "i0", type: "error", message: WARNING } },
      { type: "item.completed", item: { id: "i1", type: "agent_message", text: JSON.stringify(validImplementResult) } },
      USAGE,
    ]);

    const errors = listRunEvents(handle.db, run.id).filter((event) => event.type === "error");
    expect(errors.map((event) => event.payload)).toEqual([{ type: "error", message: WARNING, retryable: true, fatal: false }]);
  });

  it("still fails on a turn.failed, as it always has", async () => {
    const run = await runWith([
      { type: "thread.started", thread_id: "thr_1" },
      { type: "item.completed", item: { id: "i0", type: "error", message: WARNING } },
      { type: "turn.failed", error: { message: "stream disconnected before completion" } },
    ]);

    expect(run.status).toBe("failed");
    expect(run.error).toBe("stream disconnected before completion");
  });

  // Ended, and not retried: Codex's top-level `error` is the one the
  // adapter maps as not retryable, so the run is parked for a person
  // rather than left failed for the scheduler to offer again (EO-437).
  it("still ends the run on a top-level error event, as it always has", async () => {
    const run = await runWith([
      { type: "thread.started", thread_id: "thr_1" },
      { type: "error", message: "unexpected status 500" },
      { type: "item.completed", item: { id: "i1", type: "agent_message", text: JSON.stringify(validImplementResult) } },
    ]);

    expect(run.status).toBe("awaiting_input");
    expect(run.error).toBe("unexpected status 500");
  });
});
