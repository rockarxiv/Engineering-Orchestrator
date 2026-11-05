import type { Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getItem, listCommentsForItem, listRunsForItem } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { postHumanComment, type EngineHandle } from "../ipc/domainCommands.js";
import { createItemLock } from "./itemLock.js";
import { createScriptedProvider } from "../providers/scripted.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * Asking as a result rather than an action (KAN-29).
 *
 * The failure this replaces, in full: an agent asked three questions in
 * one blocking comment, the human answered one, and `postHumanComment`
 * saw "a run is parked and somebody commented" and sent the agent back —
 * holding one answer and two open questions, with no way to say so.
 *
 * The fix has two halves and both are load-bearing. Questions arrive as
 * a *result*, so the engine posts them and knows how many there are; and
 * an answer is a reply *to a question*, so answering one is no longer
 * indistinguishable from answering all of them.
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

const THREE_QUESTIONS = {
  status: "clarification_required",
  questions: [
    { id: "q1", question: "Which tier does an expired key fall back to?", why: "It decides whether the 429 path is reachable at all.", options: ["anonymous", "reject outright"] },
    { id: "q2", question: "Is the window per key or per account?", why: "Two keys on one account share a budget or they do not." },
    { id: "q3", question: "Should Retry-After be seconds or a date?", why: "Both are legal HTTP and the client has to pick one." },
  ],
};

let handle: DbHandle;
let item: Item;

/** An engine handle that records resumes instead of running one. */
function fakeEngine(): EngineHandle & { resumes: number } {
  const engine = {
    resumes: 0,
    resumeItem: vi.fn(async () => {
      engine.resumes += 1;
    }),
    cancelRun: vi.fn(),
    steerRun: vi.fn(async () => "no-live-run" as const),
    pause: vi.fn(),
    resume: vi.fn(),
    isPaused: () => false,
    // Nothing is standing in this item's way: these tests are about
    // something else, and a fake that answered otherwise would be
    // inventing a refusal.
    dispatchBlockerFor: () => null,
    activeRunCount: () => 0,
    finishingRunCount: () => 0,
    notifyStateChange: vi.fn(),
    itemLock: createItemLock(),
    // Nothing in these tests is a record answering another device.
    offerWork: async () => [],
  };
  return engine as EngineHandle & { resumes: number };
}

function supervisorReturning(result: unknown) {
  return createRunSupervisor({
    db: handle.db,
    limits: LIMITS,
    provider: createScriptedProvider([{ when: () => true, script: { result } }]),
  });
}

/** Answer one question by replying to it, exactly as the item view does. */
async function answer(engine: EngineHandle, questionId: string, body: string) {
  return postHumanComment(handle.db, engine, { itemId: item.id, body, mentions: [], pinned: false, parentId: questionId });
}

function questionIds(): string[] {
  return listCommentsForItem(handle.db, item.id)
    .filter((comment) => comment.kind === "question" && comment.authorType === "agent")
    .map((comment) => comment.id);
}

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });
});

afterEach(() => {
  handle.close();
});

describe("an agent that answers with questions", () => {
  it("puts each one in the thread as its own comment", async () => {
    // One comment per question. Three in one comment can only be
    // answered all at once or not at all, which is the shape that
    // caused this.
    await supervisorReturning(THREE_QUESTIONS).runOnce();

    expect(questionIds()).toHaveLength(3);
    const bodies = listCommentsForItem(handle.db, item.id).map((comment) => comment.body);
    expect(bodies.join("\n")).toContain("Which tier does an expired key fall back to?");
    expect(bodies.join("\n")).toContain("Two keys on one account share a budget or they do not.");
  });

  it("carries the suggested answers through to the comment", async () => {
    await supervisorReturning(THREE_QUESTIONS).runOnce();

    const first = listCommentsForItem(handle.db, item.id).find((comment) => comment.body.includes("expired key"))!;
    expect(first.options).toEqual(["anonymous", "reject outright"]);
  });

  it("parks the run and leaves the item where it was", async () => {
    // Nothing was claimed, so there is nothing to verify and nowhere to
    // move on to.
    await supervisorReturning(THREE_QUESTIONS).runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("does not treat being blocked as a malformed answer", async () => {
    // A clarification looks nothing like an `implement` result. Checked
    // against the action schema it would fail validation, be re-prompted
    // twice, and escalate as a guard trip — which is a bad way to hear a
    // question.
    await supervisorReturning(THREE_QUESTIONS).runOnce();

    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(run.status).toBe("awaiting_input");
    expect(run.error).toBeNull();
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1); // no re-prompt attempts
  });
});

describe("answering them", () => {
  it("does not resume the agent until every question has an answer", async () => {
    // The bug, exactly. Two of three answered is still blocked.
    await supervisorReturning(THREE_QUESTIONS).runOnce();
    const engine = fakeEngine();
    const [q1, q2, q3] = questionIds();

    const first = await answer(engine, q1!, "anonymous");
    const second = await answer(engine, q2!, "per key");

    expect(first.resumedRun).toBe(false);
    expect(second.resumedRun).toBe(false);
    expect(engine.resumes).toBe(0);
    void q3;
  });

  it("resumes once the last one is answered", async () => {
    await supervisorReturning(THREE_QUESTIONS).runOnce();
    const engine = fakeEngine();
    const [q1, q2, q3] = questionIds();

    await answer(engine, q1!, "anonymous");
    await answer(engine, q2!, "per key");
    const last = await answer(engine, q3!, "seconds");

    expect(last.resumedRun).toBe(true);
    expect(engine.resumes).toBe(1);
  });

  it("is not fooled by a comment that answers nothing in particular", async () => {
    // A top-level remark is not an answer. Before this, any comment at
    // all on an item with a parked run resumed it.
    await supervisorReturning(THREE_QUESTIONS).runOnce();
    const engine = fakeEngine();

    const aside = await postHumanComment(handle.db, engine, {
      itemId: item.id,
      body: "Looping in the API team about this.",
      mentions: [],
      pinned: false,
      parentId: null,
    });

    expect(aside.resumedRun).toBe(false);
    expect(engine.resumes).toBe(0);
  });
});

describe("the outcome wrapper", () => {
  // The API refuses a union at the top level of a tool input schema, so
  // the union lives one level down under `outcome`. That wrapper is a
  // transport detail of one provider and must not reach anything else.
  it("is unwrapped for a clarification", async () => {
    await supervisorReturning({ outcome: THREE_QUESTIONS }).runOnce();

    expect(questionIds()).toHaveLength(3);
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");
  });

  it("is unwrapped for a normal answer", async () => {
    await supervisorReturning({ outcome: { branch: "eo/EO-1", summary: "Did the work.", handoff: "Straightforward; nothing to flag." } }).runOnce();

    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(run.status).toBe("succeeded");
    // What the engine acts on is the action's own shape, wrapper gone.
    expect((run.result as { parsed: { branch: string } }).parsed.branch).toBe("eo/EO-1");
  });

  it("leaves a result that never had one alone", async () => {
    // A provider with no native structured output returns the bare
    // shape, and is still right.
    await supervisorReturning({ branch: "eo/EO-1", summary: "Did the work.", handoff: "Straightforward; nothing to flag." }).runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
  });
});

describe("a clarification that arrives as text", () => {
  /**
   * `intake` has no schema, so there is no constrained generation and
   * the provider hands back the model's own words. Asked for JSON, a
   * model returns a ```json fence.
   *
   * Taken from a real run: the product owner returned five well-formed
   * questions about a five-word feature, EO saw a string, called the run
   * a success, and moved the item on — past the agent that was asking.
   */
  const FENCED = ["```json", JSON.stringify({ outcome: THREE_QUESTIONS }, null, 2), "```"].join("\n");

  it("is recognised, not swallowed", async () => {
    await supervisorReturning(FENCED).runOnce();

    expect(questionIds()).toHaveLength(3);
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");
  });

  it("does not let the item move on past an agent that asked", async () => {
    // The damaging half. A run that "succeeds" walks the item into the
    // next state, where a different agent picks up work nobody agreed.
    await supervisorReturning(FENCED).runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("leaves ordinary text alone", async () => {
    // Prose is still prose. Nothing here reads meaning out of English —
    // it is a strict JSON parse or nothing.
    await supervisorReturning("I had a look and it all seems fine to me.").runOnce();

    expect(questionIds()).toEqual([]);
  });

  it("leaves text that only looks like JSON alone", async () => {
    await supervisorReturning("```json\n{ not valid json at all\n```").runOnce();

    expect(questionIds()).toEqual([]);
  });
});

describe("an agent with nothing to ask", () => {
  it("is completely unaffected", async () => {
    // The overwhelming case: a normal result still validates, still
    // transitions, and never touches any of this.
    await supervisorReturning({ branch: "eo/EO-1", summary: "Did the work.", handoff: "Straightforward; nothing to flag." }).runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
    expect(getItem(handle.db, item.id)?.stepId).not.toBe("todo");
    expect(questionIds()).toEqual([]);
  });

  it("still resumes a parked run on a plain reply, when no question is outstanding", async () => {
    // Escalation through the comment tool (A-03) is still live in this
    // slice, and its reply path must keep working: nothing asked means
    // nothing owed.
    await supervisorReturning({ branch: "eo/EO-1", summary: "Did the work.", handoff: "Straightforward; nothing to flag." }).runOnce();
    const engine = fakeEngine();
    // Force the parked state the tool path produces.
    const run = listRunsForItem(handle.db, item.id)[0]!;
    handle.db.run(`update runs set status = 'awaiting_input' where id = '${run.id}'` as never);

    const reply = await postHumanComment(handle.db, engine, {
      itemId: item.id,
      body: "Yes, go ahead.",
      mentions: [],
      pinned: false,
      parentId: null,
    });

    expect(reply.resumedRun).toBe(true);
  });
});
