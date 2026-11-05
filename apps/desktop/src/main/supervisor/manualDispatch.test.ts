import type { Agent, Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  createRun,
  listAgents,
  listCommentsForItem,
  listMentionsForComment,
  listRunsForItem,
  listItems,
  needsAttention,
  postComment,
  updateRun,
} from "../db/repos/index.js";
import { createAgent, getAgent, updateAgent } from "../db/repos/agentsRepo.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { crashMidStreamFixture, validImplementResult } from "../providers/fixtures.js";
import { findPendingResponses, RESPOND_ACTION } from "./manualDispatch.js";
import { createRunSupervisor, type RunSupervisor, type RunSupervisorOptions } from "./runSupervisor.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";

let handle: DbHandle;
let item: Item;
let implementer: Agent;
let reviewer: Agent;

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let writes: TestWriteBridge;

beforeEach(async () => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
  const agents = listAgents(handle.db);
  implementer = agents.find((agent) => agent.role === "implementer")!;
  reviewer = agents.find((agent) => agent.role === "reviewer")!;
  writes = await startTestWriteBridge();
});

afterEach(async () => {
  await writes.close();
  handle.close();
});

/**
 * A supervisor whose agents' comments reach it over the agent write
 * bridge, as a real `eo` server's do (EO-543). Without one a scripted
 * `comment` call is only said, never made — so an agent's reply, or its
 * mention of the next agent, would never be posted.
 */
function writingSupervisor(options: Omit<RunSupervisorOptions, "agentWriteBridge">): RunSupervisor {
  const supervisor = createRunSupervisor({ ...options, agentWriteBridge: writes.agentWriteBridge });
  writes.serve(supervisor);
  return supervisor;
}

const allItemIds = () => listItems(handle.db).map((entry) => entry.id);

describe("findPendingResponses", () => {
  it("finds an agent a human mentioned", () => {
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "@implementer can you look at this?",
      mentions: [{ type: "agent", agentId: implementer.id }],
    });

    const pending = findPendingResponses(handle.db, allItemIds());

    expect(pending).toHaveLength(1);
    expect(pending[0]?.agentId).toBe(implementer.id);
  });

  it("ignores a mention aimed at the human — only they can answer that (§6)", () => {
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: implementer.id },
      body: "@user which limit?",
      mentions: [{ type: "human" }],
    });

    expect(findPendingResponses(handle.db, allItemIds())).toEqual([]);
  });

  it("ignores a mention that has already been addressed", () => {
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "@implementer thoughts?",
      mentions: [{ type: "agent", agentId: implementer.id }],
    });
    // The agent replying resolves its own open mention (D-03).
    postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: implementer.id }, body: "Here's what I think." });

    expect(findPendingResponses(handle.db, allItemIds())).toEqual([]);
  });

  it("never dispatches an agent to answer its own comment", () => {
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: implementer.id },
      body: "note to self @implementer",
      mentions: [{ type: "agent", agentId: implementer.id }],
    });

    expect(findPendingResponses(handle.db, allItemIds())).toEqual([]);
  });

  it("collapses several mentions of the same agent into one run — it reads the whole thread anyway", () => {
    const comments = [];
    for (const body of ["@implementer first question", "@implementer second question"]) {
      comments.push(postComment(handle.db, {
        itemId: item.id,
        author: { type: "human" },
        body,
        mentions: [{ type: "agent", agentId: implementer.id }],
      }));
    }

    const pending = findPendingResponses(handle.db, allItemIds());
    expect(pending).toHaveLength(1);
    expect(pending[0]?.commentId).toBe(comments[1]?.id); // a new request supersedes an exhausted older initiation
  });

  it("dispatches two different agents mentioned on the same item", () => {
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "@implementer @reviewer both of you",
      mentions: [
        { type: "agent", agentId: implementer.id },
        { type: "agent", agentId: reviewer.id },
      ],
    });

    const pending = findPendingResponses(handle.db, allItemIds());
    expect(pending.map((entry) => entry.agentId).sort()).toEqual([implementer.id, reviewer.id].sort());
  });

  it("waits while the item already has a run in flight, rather than piling a second one on", () => {
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "@implementer look",
      mentions: [{ type: "agent", agentId: implementer.id }],
    });
    expect(findPendingResponses(handle.db, allItemIds())).toHaveLength(1);

    const inFlight = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "running" });

    // The mention is still open — it just waits for the current run to
    // finish, and will be found again on a later tick.
    expect(findPendingResponses(handle.db, allItemIds())).toEqual([]);

    updateRun(handle.db, inFlight.id, { status: "succeeded", endedAt: Date.now() });
    expect(findPendingResponses(handle.db, allItemIds())).toHaveLength(1);
  });
});

describe("manual dispatch through the supervisor", () => {
  it("`@`-mentioning an agent dispatches a `respond` run", async () => {
    // The item is in ready_to_merge, which nobody owns — so this run
    // can only come from the mention, not from the state.
    const done = createTestItem(handle.db, { type: "story", title: "Finished", stepId: "ready_to_merge" });
    postComment(handle.db, {
      itemId: done.id,
      author: { type: "human" },
      body: "@implementer why did you choose a token bucket?",
      mentions: [{ type: "agent", agentId: implementer.id }],
    });

    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ result: { message: "because it smooths bursts" } }),
      limits: LIMITS,
    });
    await supervisor.runOnce();

    const runs = listRunsForItem(handle.db, done.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.action).toBe(RESPOND_ACTION);
    expect(runs[0]?.agentId).toBe(implementer.id);
    expect(runs[0]?.status).toBe("succeeded");
  });

  it("answering a question does not move the item", async () => {
    // Parked at the approval gate, which nobody owns — so the only run
    // here is the manual one, and any movement would be its doing.
    const parked = createTestItem(handle.db, { type: "story", title: "Waiting", stepId: "todo" });
    postComment(handle.db, {
      itemId: parked.id,
      author: { type: "human" },
      body: "@reviewer quick question before I approve",
      mentions: [{ type: "agent", agentId: reviewer.id }],
    });

    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ result: { message: "sure" } }),
      limits: LIMITS,
    });
    await supervisor.runOnce();

    const respondRun = listRunsForItem(handle.db, parked.id).find((run) => run.action === RESPOND_ACTION);
    expect(respondRun?.status).toBe("succeeded");
    expect(getItem(handle.db, parked.id)?.stepId).toBe("todo"); // answering is not progress
  });

  it("a direct request starts a fresh initiation instead of inheriting old attempts", async () => {
    const stuck = createTestItem(handle.db, { type: "story", title: "Stuck", stepId: "ready_to_merge" });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const historical = createRun(handle.db, {
        itemId: stuck.id,
        agentId: implementer.id,
        action: RESPOND_ACTION,
        status: "failed",
        initiationId: "old-request",
        attempt,
      });
      updateRun(handle.db, historical.id, { startedAt: attempt, endedAt: attempt });
    }
    const request = postComment(handle.db, {
      itemId: stuck.id,
      author: { type: "human" },
      body: "@implementer explain",
      mentions: [{ type: "agent", agentId: implementer.id }],
    });

    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ result: { message: "ok" } }),
      limits: LIMITS,
      guards: { perItemAttemptLimit: 1 },
    });
    await supervisor.runOnce();

    const runs = listRunsForItem(handle.db, stuck.id);
    const fresh = runs.find((run) => run.initiationId === request.id)!;
    expect(fresh.status).toBe("succeeded");
    expect(fresh.attempt).toBe(1);
    expect(fresh.threadId).toBeTruthy();
  });

  it("retries one direct request only within that request's own allowance", async () => {
    const parked = createTestItem(handle.db, { type: "story", title: "Question", stepId: "ready_to_merge" });
    const request = postComment(handle.db, {
      itemId: parked.id,
      author: { type: "human" },
      body: "@reviewer inspect this",
      mentions: [{ type: "agent", agentId: reviewer.id }],
    });
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider(crashMidStreamFixture),
      limits: LIMITS,
      guards: { perItemAttemptLimit: 2 },
    });

    for (let tick = 0; tick < 4; tick += 1) await supervisor.runOnce();

    const runs = listRunsForItem(handle.db, parked.id);
    const real = runs.filter((run) => run.threadId !== null);
    expect(real.map((run) => run.attempt)).toEqual([1, 2]);
    expect(runs.every((run) => run.initiationId === request.id)).toBe(true);
    expect(runs.filter((run) => run.status === "awaiting_input" && run.threadId === null)).toHaveLength(1);
  });

  it("the global pause stops manual dispatch too, not just state-driven work", async () => {
    const done = createTestItem(handle.db, { type: "story", title: "Paused", stepId: "ready_to_merge" });
    postComment(handle.db, {
      itemId: done.id,
      author: { type: "human" },
      body: "@implementer hello",
      mentions: [{ type: "agent", agentId: implementer.id }],
    });

    const supervisor = createRunSupervisor({ db: handle.db, provider: createFakeProvider({ result: {} }), limits: LIMITS });
    supervisor.pause();
    await supervisor.runOnce();

    expect(listRunsForItem(handle.db, done.id)).toHaveLength(0);

    supervisor.resume();
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, done.id)).toHaveLength(1);
  });

  it("stops dispatching once the agent's reply resolves the mention", async () => {
    const done = createTestItem(handle.db, { type: "story", title: "Answered", stepId: "ready_to_merge" });
    postComment(handle.db, {
      itemId: done.id,
      author: { type: "human" },
      body: "@implementer why?",
      mentions: [{ type: "agent", agentId: implementer.id }],
    });

    const supervisor = writingSupervisor({
      db: handle.db,
      provider: createFakeProvider({
        steps: [{ toolCall: { name: "comment", args: { body: "Because of X.", blocking: false } } }],
        result: { message: "Because of X." },
      }),
      limits: LIMITS,
    });

    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, done.id)).toHaveLength(1);
    expect(needsAttention(handle.db, done.id)).toBe(false); // no human mention outstanding

    await supervisor.runOnce(); // the mention is addressed, so nothing re-dispatches
    expect(listRunsForItem(handle.db, done.id)).toHaveLength(1);
  });
});

describe("implementer default behaviour (R-02)", () => {
  it("only unblocked stories are picked up; a blocked one waits", async () => {
    const first = createTestItem(handle.db, { type: "story", title: "First", stepId: "todo" });
    const second = createTestItem(handle.db, { type: "story", title: "Second", stepId: "todo" });
    const { addDependency } = await import("../db/repos/index.js");
    addDependency(handle.db, second.id, first.id);

    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ result: validImplementResult }),
      limits: LIMITS,
    });
    await supervisor.runOnce();

    expect(listRunsForItem(handle.db, first.id)).toHaveLength(1);
    expect(listRunsForItem(handle.db, second.id)).toHaveLength(0); // waits for its dependency
  });

  it("concurrency stays at 1 unless opted into (§7)", async () => {
    createTestItem(handle.db, { type: "story", title: "B", stepId: "todo" });
    const supervisor = createRunSupervisor({ db: handle.db, provider: createFakeProvider({ result: validImplementResult }) });

    await supervisor.runOnce();

    const dispatched = listItems(handle.db).reduce((total, entry) => total + listRunsForItem(handle.db, entry.id).length, 0);
    expect(dispatched).toBe(1);
  });
});

/**
 * The design's first guard on agent-to-agent mentions: the depth cap (EO-212).
 *
 * The second guard — "agents may not resolve a mention aimed at you" —
 * is structural and tested in commentsRepo; this is the one that bounds
 * A→B→A, and it is tested here because here is the door it stands at.
 * `agentMentionChain` counts; these tests are about what the supervisor
 * does with the count.
 */
describe("the agent-to-agent mention depth cap", () => {
  let chained: Item;

  beforeEach(() => {
    // Nobody owns ready_to_merge, so every run below can only have come
    // from a mention rather than from the scheduler.
    chained = createTestItem(handle.db, { type: "story", title: "Chatting", stepId: "ready_to_merge" });
  });

  /** One hop: an agent naming another one, exactly as the comment tool would leave it. */
  const hop = (from: Agent, to: Agent) =>
    postComment(handle.db, {
      itemId: chained.id,
      author: { type: "agent", agentId: from.id },
      body: "over to you",
      mentions: [{ type: "agent", agentId: to.id }],
    });

  const supervisorWithCap = (cap: number) =>
    createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ result: { message: "ok" } }),
      limits: LIMITS,
      guards: { agentMentionDepth: cap },
    });

  const respondRuns = (itemId: Item["id"]) =>
    listRunsForItem(handle.db, itemId).filter((run) => run.action === RESPOND_ACTION);

  const engineComments = (itemId: Item["id"]) =>
    listCommentsForItem(handle.db, itemId).filter((comment) => comment.authorType === "engine");

  it("answers the last mention that is still inside the cap", async () => {
    hop(implementer, reviewer);
    hop(reviewer, implementer);
    hop(implementer, reviewer); // the third hop — the cap, not past it

    await supervisorWithCap(3).runOnce();

    expect(respondRuns(chained.id)).toHaveLength(1);
    expect(engineComments(chained.id)).toEqual([]);
  });

  it("refuses the hop past the cap: no run, the mention closed, and an escalation naming the chain", async () => {
    hop(implementer, reviewer);
    hop(reviewer, implementer);
    hop(implementer, reviewer);
    const overrun = hop(reviewer, implementer);

    await supervisorWithCap(3).runOnce();

    expect(respondRuns(chained.id)).toEqual([]);
    // Closed, not skipped: an open mention is re-read on every tick, and
    // a refusal that left it open would post this paragraph every five
    // seconds (the lesson `findPendingResponses` already records).
    expect(listMentionsForComment(handle.db, overrun.id).every((mention) => mention.status !== "open")).toBe(true);

    const said = engineComments(chained.id);
    expect(said).toHaveLength(1);
    expect(said[0]?.kind).toBe("escalation");
    expect(said[0]?.body).toContain(implementer.name);
    expect(said[0]?.body).toContain(reviewer.name);
    expect(said[0]?.body).toContain("4 time(s)");
    expect(said[0]?.body).toContain("the limit is 3");
    expect(said[0]?.body).toContain("Say something on this ticket");
    // A person is being asked, so the item says so (invariant 8).
    expect(needsAttention(handle.db, chained.id)).toBe(true);
  });

  it("says it once and then leaves the item alone", async () => {
    hop(implementer, reviewer);
    hop(reviewer, implementer);
    hop(implementer, reviewer);
    hop(reviewer, implementer);

    const supervisor = supervisorWithCap(3);
    await supervisor.runOnce();
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(engineComments(chained.id)).toHaveLength(1);
    expect(respondRuns(chained.id)).toEqual([]);
  });

  it("a human comment restarts the count, and the next hop dispatches again", async () => {
    hop(implementer, reviewer);
    hop(reviewer, implementer);
    hop(implementer, reviewer);
    hop(reviewer, implementer); // past the cap, and refused below

    const supervisor = supervisorWithCap(3);
    await supervisor.runOnce();
    expect(respondRuns(chained.id)).toEqual([]);

    postComment(handle.db, { itemId: chained.id, author: { type: "human" }, body: "carry on, I'm watching" });
    hop(implementer, reviewer);
    await supervisor.runOnce();

    expect(respondRuns(chained.id)).toHaveLength(1);
  });

  it("never counts or refuses a human's own mention, however long the agents have been at it", async () => {
    // Five hops, ending on one aimed at the reviewer — well past a cap
    // of three, so anything the guard was going to refuse it would have
    // refused by now.
    for (let i = 0; i < 5; i += 1) hop(i % 2 === 0 ? implementer : reviewer, i % 2 === 0 ? reviewer : implementer);

    const asked = postComment(handle.db, {
      itemId: chained.id,
      author: { type: "human" },
      body: "@reviewer what came of that?",
      mentions: [{ type: "agent", agentId: reviewer.id }],
    });
    await supervisorWithCap(3).runOnce();

    const runs = respondRuns(chained.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.agentId).toBe(reviewer.id);
    // Their request, not the chain's: the person's comment is the newest
    // one naming the reviewer, and it starts the count again at zero.
    expect(runs[0]?.initiationId).toBe(asked.id);
    expect(engineComments(chained.id)).toEqual([]);
  });

  it("does not count an agent asking the human — that is the outcome, not the loop", async () => {
    for (let i = 0; i < 6; i += 1) {
      postComment(handle.db, {
        itemId: chained.id,
        author: { type: "agent", agentId: implementer.id },
        body: "@user which limit?",
        mentions: [{ type: "human" }],
        kind: "escalation",
      });
    }
    const asked = hop(implementer, reviewer);

    await supervisorWithCap(3).runOnce();

    expect(respondRuns(chained.id)).toHaveLength(1);
    expect(listMentionsForComment(handle.db, asked.id).some((mention) => mention.targetType === "agent")).toBe(true);
  });

  it("ends a scripted pair that would otherwise ping-pong for ever", async () => {
    const pair = createTestItem(handle.db, { type: "story", title: "Ping pong", stepId: "ready_to_merge" });
    // A pair of their own rather than the seeded implementer and
    // reviewer: a shipped role decides thread reuse for itself, and the
    // implementer reusing one thread per item would have the fake
    // replay a script it had already finished. These two are exactly
    // what the story asks for — two agents whose whole behaviour is to
    // hand the item back to each other, for ever, until something
    // stops them.
    const alpha = createAgent(handle.db, { name: "Alpha", role: "alpha", provider: "claude", instructions: "Ask Beta." });
    const beta = createAgent(handle.db, { name: "Beta", role: "beta", provider: "claude", instructions: "Ask Alpha." });
    const script = (mention: string) =>
      createFakeProvider({
        steps: [{ toolCall: { name: "comment", args: { body: `@${mention} your turn`, mentions: [mention], blocking: false } } }],
        result: { message: "handed it over" },
      });
    const providers = new Map([
      [alpha.id, script("Beta")],
      [beta.id, script("Alpha")],
    ]);

    postComment(handle.db, {
      itemId: pair.id,
      author: { type: "human" },
      body: "@Alpha start us off",
      mentions: [{ type: "agent", agentId: alpha.id }],
    });

    const supervisor = writingSupervisor({
      db: handle.db,
      provider: (agent: Agent) => providers.get(agent.id) ?? createFakeProvider({ result: { message: "not my turn" } }),
      limits: LIMITS,
      guards: { agentMentionDepth: 3 },
    });
    for (let tick = 0; tick < 10; tick += 1) await supervisor.runOnce();

    // The person's own request, then three hops answered, then nothing —
    // however many ticks it is given afterwards.
    expect(respondRuns(pair.id)).toHaveLength(4);
    const said = engineComments(pair.id);
    expect(said).toHaveLength(1);
    expect(said[0]?.body).toContain("Alpha and Beta");
    expect(said[0]?.body).toContain("4 time(s)");
    expect(needsAttention(handle.db, pair.id)).toBe(true);
  });
});

describe("a mention of another project's agent (EO-474)", () => {
  const WRITER_INSTRUCTIONS = "You write the support team's replies.";
  /**
   * A provider that counts the turns the writer is started on — the
   * thing that must not happen. Only the writer's: the story every test
   * here begins with sits on the implementer's step and is dispatched
   * on the same tick, which is beside the point.
   */
  function countingProvider(): { provider: ReturnType<typeof createFakeProvider>; starts: () => number } {
    const inner = createFakeProvider({ result: { message: "an answer" } });
    let started = 0;
    return {
      provider: {
        ...inner,
        start: (...args: Parameters<typeof inner.start>) => {
          if (args[0].instructions.includes(WRITER_INSTRUCTIONS)) started += 1;
          return inner.start(...args);
        },
      },
      starts: () => started,
    };
  }

  function setUp() {
    const support = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    const writer = createAgent(handle.db, { name: "Support writer", role: "writer", provider: "fake", instructions: WRITER_INSTRUCTIONS, projectId: support.id });
    const shopItem = createTestItem(handle.db, { type: "story", title: "Shop work", stepId: "ready_to_merge", projectId: shop.id });
    const supportItem = createTestItem(handle.db, { type: "story", title: "Support work", stepId: "ready_to_merge", projectId: support.id });
    return { support, shop, writer, shopItem, supportItem };
  }

  function mention(itemId: Item["id"], agent: Agent, body = "@Support writer thoughts?") {
    return postComment(handle.db, { itemId, author: { type: "human" }, body, mentions: [{ type: "agent", agentId: agent.id }] });
  }

  it("starts no provider turn for an item of another project, says why once, and closes the mention", async () => {
    const { writer, shopItem } = setUp();
    const asked = mention(shopItem.id, writer);
    const { provider, starts } = countingProvider();
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS });

    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(starts()).toBe(0);
    expect(listRunsForItem(handle.db, shopItem.id)).toEqual([]);
    const notes = listCommentsForItem(handle.db, shopItem.id).filter((comment) => comment.authorType === "engine");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toContain('Support writer works for the "Support" project only, and this ticket is on "Shop"');
    expect(listMentionsForComment(handle.db, asked.id).every((entry) => entry.status !== "open")).toBe(true);
  });

  it("refuses a rerun asked of another project's agent the same way, rather than running its step", async () => {
    const { writer, shopItem } = setUp();
    mention(shopItem.id, writer, "@Support writer rerun");
    const { provider, starts } = countingProvider();

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    expect(starts()).toBe(0);
    expect(listCommentsForItem(handle.db, shopItem.id).some((comment) => comment.authorType === "engine" && comment.body.includes('works for the "Support" project only'))).toBe(true);
  });

  it("answers a mention on its own project's item, as any mention is answered", async () => {
    const { writer, supportItem } = setUp();
    mention(supportItem.id, writer);
    const { provider, starts } = countingProvider();

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    expect(starts()).toBe(1);
    expect(listRunsForItem(handle.db, supportItem.id).map((run) => [run.agentId, run.action, run.status])).toEqual([[writer.id, RESPOND_ACTION, "succeeded"]]);
  });

  it("starts nothing when the agent is moved to another project while its run is being prepared", async () => {
    const { shop, writer, supportItem } = setUp();
    mention(supportItem.id, writer);
    const { provider, starts } = countingProvider();

    await createRunSupervisor({
      db: handle.db,
      provider,
      limits: LIMITS,
      // Preflight asks whether the backend is signed in; the scope
      // changes under it, the way a save from the Agents screen would.
      checkAuth: async () => {
        updateAgent(handle.db, writer.id, { projectId: shop.id });
        return { ok: true };
      },
    }).runOnce();

    expect(getAgent(handle.db, writer.id)?.projectId).toBe(shop.id);
    expect(starts()).toBe(0);
    expect(listRunsForItem(handle.db, supportItem.id)).toEqual([]);
  });
});
