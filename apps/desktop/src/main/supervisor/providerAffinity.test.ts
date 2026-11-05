import type { Agent, AgentProvider, Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAgents, updateAgent } from "../db/repos/agentsRepo.js";
import { postComment } from "../db/repos/commentsRepo.js";
import { createRun, getRun, listRunsForItem, updateRun } from "../db/repos/runsRepo.js";
import { comments } from "../db/schema.js";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/**
 * A-07: a session id means nothing outside the backend that issued it.
 * These drive the two paths that can hand one to the wrong provider —
 * a human replying to an escalation, and crash recovery.
 */
describe("resuming after the agent's backend changed", () => {
  let handle: DbHandle;
  let item: Item;
  let implementer: Agent;
  let resumed: { threadId: string }[];
  let provider: AgentProvider;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;

    resumed = [];
    const inner = createFakeProvider({ result: validImplementResult });
    provider = {
      start: inner.start.bind(inner),
      resume: (threadId, message, opts) => {
        resumed.push({ threadId });
        return inner.resume(threadId, message, opts);
      },
    };
  });

  afterEach(() => {
    handle.close();
  });

  /** A run parked on `provider`, waiting for a human reply. */
  function parkedRun(runProvider: string | null) {
    const run = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId: "thr_parked",
      ...(runProvider === null ? {} : { provider: runProvider }),
    });
    updateRun(handle.db, run.id, { status: "awaiting_input", startedAt: Date.now(), endedAt: Date.now() });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "use the other endpoint" });
    return run;
  }

  it("records which backend owns the session when a run is dispatched", async () => {
    updateAgent(handle.db, implementer.id, { provider: "codex" });

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.provider).toBe("codex");
  });

  it("starts a fresh run instead of handing a codex session to claude", async () => {
    updateAgent(handle.db, implementer.id, { provider: "codex" });
    const parked = parkedRun("codex");
    updateAgent(handle.db, implementer.id, { provider: "claude" }); // the user switches backends

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).resumeItem(item.id);

    expect(resumed, "the claude backend was never handed a codex session id").toEqual([]);
    const fresh = listRunsForItem(handle.db, item.id).find((run) => run.id !== parked.id);
    expect(fresh?.threadId).not.toBe("thr_parked");
    expect(fresh?.provider).toBe("claude");
    expect(fresh?.status).toBe("succeeded"); // the reply still got acted on
  });

  it("says on the item that the conversation could not be carried over", async () => {
    updateAgent(handle.db, implementer.id, { provider: "codex" });
    parkedRun("codex");
    updateAgent(handle.db, implementer.id, { provider: "claude" });

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).resumeItem(item.id);

    const note = handle.db
      .select()
      .from(comments)
      .all()
      .find((comment) => comment.authorType === "engine");
    expect(note?.body).toContain("codex");
    expect(note?.body).toContain("claude");
    // Not a stack trace, and not a dead end: it says what happens next.
    expect(note?.body).toContain("fresh run");
  });

  it("still resumes the same thread when the backend has not changed", async () => {
    // The whole risk of this change: turning every ordinary resume into
    // a restart would throw away the agent's context on every reply.
    updateAgent(handle.db, implementer.id, { provider: "codex" });
    parkedRun("codex");

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).resumeItem(item.id);

    expect(resumed).toEqual([{ threadId: "thr_parked" }]);
  });

  it("resumes a run that predates this column rather than restarting it", async () => {
    // Rows written before A-07 have no provider. Restarting those would
    // punish every user with a parked run at upgrade time, for a switch
    // that probably never happened.
    parkedRun(null);

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).resumeItem(item.id);

    expect(resumed).toEqual([{ threadId: "thr_parked" }]);
  });

  it("does not resume onto the wrong backend after a crash either", async () => {
    // The provider can just as easily be changed while the app is closed.
    updateAgent(handle.db, implementer.id, { provider: "codex" });
    const interrupted = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId: "thr_crashed",
      provider: "codex",
    });
    updateRun(handle.db, interrupted.id, { status: "running", startedAt: Date.now() });
    updateAgent(handle.db, implementer.id, { provider: "claude" });

    const summary = await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).reconcile();

    expect(summary).toEqual({ reattached: 0, resumed: 0, orphaned: 1 });
    expect(resumed).toEqual([]);
    expect(getRun(handle.db, interrupted.id)?.status).toBe("orphaned");

    const note = handle.db
      .select()
      .from(comments)
      .all()
      .find((comment) => comment.authorType === "engine");
    expect(note?.body).toContain("couldn't be carried over");
    // The scheduler picks the item up on its own, so there is nothing
    // to ask the human for — an inbox item here would be noise.
    expect(handle.db.select().from(comments).all()).toHaveLength(1);
  });
});
