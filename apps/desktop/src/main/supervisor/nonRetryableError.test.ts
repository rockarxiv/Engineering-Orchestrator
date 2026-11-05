import type { AgentEvent, AgentProvider, Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { needsAttention } from "../db/repos/commentsRepo.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import { comments } from "../db/schema.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { hourlyClock } from "../testing/clock.js";

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

const FILTERED = "The response was blocked by the content filter.";

/** A backend whose every turn opens a thread and then ends on one fatal error, counting how often it was asked. */
function providerFailingWith(error: Extract<AgentEvent, { type: "error" }>) {
  const fake = createFakeProvider({ result: validImplementResult });
  let starts = 0;
  const stream = () => {
    starts++;
    return (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: "thread_started", threadId: `thr_${starts}` };
      yield error;
    })();
  };
  const provider: AgentProvider = { ...fake, start: stream, resume: stream };
  return { provider, starts: () => starts };
}

/**
 * What the backend says about trying again is believed (EO-437).
 *
 * Both adapters put `retryable` on every error they map and nothing read
 * it: the supervisor failed the run, and the scheduler retried a failed
 * run like any other. So a content filter's refusal — which Codex
 * reports as not retryable — was put to the same model three times
 * before the attempt limit finally asked for a person.
 */
describe("a run that ends on a provider error", () => {
  let handle: DbHandle;
  let item: Item;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
  });

  afterEach(() => {
    handle.close();
  });

  it("parks for a person after one attempt when the error is not retryable", async () => {
    const { provider, starts } = providerFailingWith({ type: "error", message: FILTERED, retryable: false });
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS, guards: { perItemAttemptLimit: 3 } });

    for (let i = 0; i < 4; i++) await supervisor.runOnce();

    expect(starts()).toBe(1); // the remaining attempts were never spent
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "awaiting_input", error: FILTERED, attempt: 1 });

    expect(needsAttention(handle.db, item.id)).toBe(true);
    const escalations = handle.db.select().from(comments).all().filter((comment) => comment.kind === "escalation");
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({ authorType: "engine", runId: runs[0]!.id });
    expect(escalations[0]!.body).toContain(FILTERED);
  });

  it("still retries a retryable error up to the attempt limit", async () => {
    const { provider, starts } = providerFailingWith({ type: "error", message: "the provider fell over", retryable: true });
    // Past every retry backoff by the next tick.
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS, guards: { perItemAttemptLimit: 3 }, now: hourlyClock() });

    for (let i = 0; i < 5; i++) await supervisor.runOnce();

    expect(starts()).toBe(3);
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs.filter((run) => run.status === "failed")).toHaveLength(3);
    // …and only then the attempt limit asks for a person, as it always has.
    const parked = runs.filter((run) => run.status === "awaiting_input");
    expect(parked).toHaveLength(1);
    expect(parked[0]!.error).toContain("Stopped after 3 attempt(s)");
  });
});
