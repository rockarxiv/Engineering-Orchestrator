import type { Agent, Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listAgents } from "../db/repos/agentsRepo.js";
import { listCommentsForItem, listMentionsForComment } from "../db/repos/commentsRepo.js";
import { createRun, updateRun } from "../db/repos/runsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createItemLock } from "../supervisor/itemLock.js";
import type { SteerResult } from "../supervisor/runSupervisor.js";
import { postHumanComment, STEER_REPLY_WITHIN_MS, type EngineHandle } from "./domainCommands.js";
import { onPush } from "./push.js";

/**
 * Saying something to a live agent, from the screen a person is on
 * (EO-176).
 *
 * The order is the invariant: the comment is written first and always,
 * and the push into the turn is a delivery of something already
 * recorded. Everything else here follows from that — a refused delivery
 * loses nothing, and a successful one must not then wake a second run to
 * answer a message the agent has already been given.
 */
let handle: DbHandle;
let item: Item;
let implementer: Agent;

function engineThatAnswers(result: SteerResult): EngineHandle & { steerRun: ReturnType<typeof vi.fn> } {
  return {
    resumeItem: vi.fn(async () => {}),
    cancelRun: vi.fn(),
    steerRun: vi.fn(async () => result),
    pause: vi.fn(),
    resume: vi.fn(),
    isPaused: () => false,
    // Nothing is standing in this item's way: these tests are about
    // something else, and a fake that answered otherwise would be
    // inventing a refusal.
    dispatchBlockerFor: () => null,
    activeRunCount: () => 1,
    finishingRunCount: () => 0,
    notifyStateChange: vi.fn(),
    itemLock: createItemLock(),
    // Nothing in these tests is a record answering another device.
    offerWork: async () => [],
  };
}

/** A run of this agent, in flight, which is the only state any of this applies to. */
function liveRun(): void {
  const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement" });
  updateRun(handle.db, run.id, { status: "running" });
}

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
});

afterEach(() => {
  vi.useRealTimers();
  handle.close();
});

describe("a message posted while an agent is working", () => {
  it("is a comment on the item before anything is delivered", async () => {
    liveRun();
    const engine = engineThatAnswers("steered");

    const result = await postHumanComment(handle.db, engine, {
      itemId: item.id,
      body: "Stop rewriting the schema.",
      mentions: [],
      pinned: false,
      parentId: null,
      delivery: "now",
    });

    const [comment] = listCommentsForItem(handle.db, item.id);
    expect(comment).toMatchObject({ authorType: "human", body: "Stop rewriting the schema." });
    expect(engine.steerRun).toHaveBeenCalledWith(expect.any(String), {
      commentId: comment!.id,
      body: "Stop rewriting the schema.",
      delivery: "now",
    });
    expect(result.delivery).toEqual({ requested: "now", outcome: "now", note: null });
  });

  it("is still a comment when the backend would not take it", async () => {
    // The whole reason delivery answers with a word rather than throwing.
    // A refused push must lose nothing: the message is on the item and
    // the next turn reads it.
    liveRun();

    const result = await postHumanComment(handle.db, engineThatAnswers("unsupported"), {
      itemId: item.id,
      body: "Check the retry maths.",
      mentions: [],
      pinned: false,
      parentId: null,
      delivery: "now",
    });

    expect(listCommentsForItem(handle.db, item.id)[0]?.body).toBe("Check the retry maths.");
    expect(result.delivery?.outcome).toBe("next");
    expect(result.delivery?.note).toMatch(/cannot be spoken to mid-turn/);
  });

  it("tells the person, in a sentence, when the turn had already ended", async () => {
    liveRun();

    const result = await postHumanComment(handle.db, engineThatAnswers("turn-over"), {
      itemId: item.id,
      body: "Stop there.",
      mentions: [],
      pinned: false,
      parentId: null,
      delivery: "now",
    });

    expect(result.delivery).toMatchObject({ requested: "now", outcome: "next" });
    expect(result.delivery?.note).toMatch(/already finished the turn/);
  });

  it("closes the mention it answered, so a delivered message does not wake a second run", async () => {
    liveRun();

    const result = await postHumanComment(handle.db, engineThatAnswers("steered"), {
      itemId: item.id,
      body: "@implementer use the middleware, and @user I've told it so",
      mentions: ["implementer", "user"],
      pinned: false,
      parentId: null,
      delivery: "now",
    });

    const mentions = listMentionsForComment(handle.db, result.commentId as Parameters<typeof listMentionsForComment>[1]);
    const forAgent = mentions.find((mention) => mention.targetType === "agent");
    const forHuman = mentions.find((mention) => mention.targetType === "human");
    expect(forAgent?.status, "the agent has been told; dispatching it to answer the same message is the loop this closes").toBe("dismissed");
    // And not one mention more. `!` on an item is derived from a
    // mention aimed at a person (invariant #6), and this feature has no
    // business touching one. It reads `addressed` here rather than
    // `open` for a reason that predates any of this: a human posting a
    // comment answers the human mentions on the item, which is the
    // ordinary reply path doing its job. What matters is that it was not
    // *dismissed* — that would be steering closing somebody else's
    // question.
    expect(forHuman?.status).not.toBe("dismissed");
  });

  it("leaves a queued message's mention open, because that mention is what starts the next turn", async () => {
    liveRun();

    const result = await postHumanComment(handle.db, engineThatAnswers("queued"), {
      itemId: item.id,
      body: "@implementer check the retry maths",
      mentions: ["implementer"],
      pinned: false,
      parentId: null,
      delivery: "next",
    });

    const mentions = listMentionsForComment(handle.db, result.commentId as Parameters<typeof listMentionsForComment>[1]);
    expect(mentions[0]?.status).toBe("open");
    expect(result.delivery).toEqual({ requested: "next", outcome: "next", note: null });
  });

  it("does not ask the engine anything about an item with nothing running", async () => {
    const engine = engineThatAnswers("steered");

    const result = await postHumanComment(handle.db, engine, {
      itemId: item.id,
      body: "Something for whoever picks this up.",
      mentions: [],
      pinned: false,
      parentId: null,
      delivery: "now",
    });

    expect(engine.steerRun).not.toHaveBeenCalled();
    expect(result.delivery?.note).toMatch(/Nothing is running on this ticket/);
  });

  it("does not steer into a module dry run, which is live on the item but speaks for nothing", async () => {
    // A dry run borrows the item's worktree so a person can watch a
    // module work (KAN-106); a comment on the item is not for it. It is
    // also the one live run the supervisor holds no buffer for, so a
    // message recorded against it would collide with the numbers the dry
    // run's own buffer was still handing out.
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "module-1", provider: "module", dryRun: true });
    updateRun(handle.db, run.id, { status: "running" });
    const engine = engineThatAnswers("no-live-run");

    const result = await postHumanComment(handle.db, engine, {
      itemId: item.id,
      body: "Use main, not develop.",
      mentions: [],
      pinned: false,
      parentId: null,
      delivery: "now",
    });

    expect(engine.steerRun).not.toHaveBeenCalled();
    expect(result.delivery?.note).toMatch(/Nothing is running on this ticket/);
  });

  it("changes nothing for an ordinary comment, which is every comment that asks for no delivery", async () => {
    liveRun();
    const engine = engineThatAnswers("steered");

    const result = await postHumanComment(handle.db, engine, {
      itemId: item.id,
      body: "Noting this for later.",
      mentions: [],
      pinned: false,
      parentId: null,
    });

    expect(engine.steerRun).not.toHaveBeenCalled();
    expect(result.delivery).toBeNull();
  });
});

/**
 * A backend that takes its time (EO-558).
 *
 * A Codex steer waits for the turn to have started, with no limit of its
 * own, and the person's Post used to wait with it. The comment is the
 * record before any of that, so the reply no longer waits past
 * `STEER_REPLY_WITHIN_MS`: it says the delivery is pending and the
 * delivery finishes without anybody holding the request open.
 */
describe("a message whose delivery the backend has not answered yet", () => {
  /** A steer the test settles by hand, or never. */
  function engineThatWaits() {
    let settle!: (result: SteerResult) => void;
    let fail!: (error: unknown) => void;
    const answer = new Promise<SteerResult>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const engine = { ...engineThatAnswers("steered"), steerRun: vi.fn(() => answer) };
    return { engine, settle, fail };
  }

  async function postWhileWaiting(engine: EngineHandle) {
    vi.useFakeTimers();
    let answered: Awaited<ReturnType<typeof postHumanComment>> | undefined;
    void postHumanComment(handle.db, engine, {
      itemId: item.id,
      body: "@implementer use the middleware",
      mentions: ["implementer"],
      pinned: false,
      parentId: null,
      delivery: "now",
    }).then((result) => {
      answered = result;
    });
    await vi.advanceTimersByTimeAsync(2_000);
    return answered;
  }

  const agentMention = (commentId: string) =>
    listMentionsForComment(handle.db, commentId as Parameters<typeof listMentionsForComment>[1]).find((mention) => mention.targetType === "agent");

  it("answers within two seconds, saying the delivery is pending, when the steer never resolves", async () => {
    expect(STEER_REPLY_WITHIN_MS).toBeLessThan(2_000);
    liveRun();
    const { engine } = engineThatWaits();

    const result = await postWhileWaiting(engine);

    expect(result, "the Post is answered while the steer is still outstanding").toBeDefined();
    expect(engine.steerRun).toHaveBeenCalledOnce();
    expect(result!.delivery).toMatchObject({ requested: "now", outcome: "pending" });
    expect(result!.delivery?.note).toMatch(/Still being passed to the turn that is running\..*the next run on this/);
    // The record is there whatever the backend does, and its mention is
    // what keeps the message owed to an agent meanwhile.
    expect(listCommentsForItem(handle.db, item.id)[0]?.body).toBe("@implementer use the middleware");
    expect(agentMention(result!.commentId)?.status).toBe("open");
  });

  it("closes the mention, and says the item changed, when the steer lands after the reply", async () => {
    liveRun();
    const { engine, settle } = engineThatWaits();
    const changed: string[] = [];
    const stop = onPush("items:changed", (payload) => void changed.push(String(payload.itemId)));

    try {
      const result = await postWhileWaiting(engine);
      expect(result!.delivery?.outcome).toBe("pending");
      changed.length = 0;

      settle("steered");
      await vi.advanceTimersByTimeAsync(0);

      expect(agentMention(result!.commentId)?.status, "delivered late is still delivered: no second run for it").toBe("dismissed");
      expect(changed).toContain(item.id);
    } finally {
      stop();
    }
  });

  it.each([
    ["the turn was over by then", (waiting: ReturnType<typeof engineThatWaits>) => waiting.settle("turn-over")],
    ["the backend gave no live turn", (waiting: ReturnType<typeof engineThatWaits>) => waiting.settle("no-live-run")],
    ["the steer threw", (waiting: ReturnType<typeof engineThatWaits>) => waiting.fail(new Error("socket closed"))],
  ])("leaves the mention open for the next turn when %s", async (_why, finish) => {
    liveRun();
    const waiting = engineThatWaits();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const result = await postWhileWaiting(waiting.engine);
      finish(waiting);
      await vi.advanceTimersByTimeAsync(0);

      expect(agentMention(result!.commentId)?.status).toBe("open");
    } finally {
      logged.mockRestore();
    }
  });

  it("answers as before when the steer is quicker than the bound", async () => {
    liveRun();
    vi.useFakeTimers();
    const engine = { ...engineThatAnswers("steered"), steerRun: vi.fn(() => new Promise<SteerResult>((resolve) => setTimeout(() => resolve("steered"), STEER_REPLY_WITHIN_MS / 2))) };

    const posting = postHumanComment(handle.db, engine, {
      itemId: item.id,
      body: "@implementer use the middleware",
      mentions: ["implementer"],
      pinned: false,
      parentId: null,
      delivery: "now",
    });
    await vi.advanceTimersByTimeAsync(STEER_REPLY_WITHIN_MS);
    const result = await posting;

    expect(result.delivery).toEqual({ requested: "now", outcome: "now", note: null });
    expect(agentMention(result.commentId)?.status).toBe("dismissed");
  });
});
