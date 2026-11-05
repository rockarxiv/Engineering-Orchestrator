import type { Agent, AgentEvent, AgentProvider, Item, RunStatus, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listAgents, listCommentsForItem, listRunsForItem, listTransitionsForItem, postComment } from "../db/repos/index.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { openAssist } from "../ipc/assistCommands.js";
import { openAssistConversation, postAssistReply } from "../roles/assist.js";
import { postMentionReply } from "../roles/mentionReply.js";
import { ASSIST_ACTION, ASSIST_STEP } from "../roles/conversationSteps.js";
import { RESPOND_ACTION } from "./manualDispatch.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { kindsPreparing } from "./testWorkspaceKinds.js";

/**
 * A manually dispatched run says that it finished (EO-339).
 *
 * `transitionOnSuccess: false` used to `return` from the success branch
 * of `runToCompletion` *in front of* `announceRun`, on the reading that
 * a manual dispatch is not pipeline progress. It is not — but the
 * announcement is a notification rather than a transition, and skipping
 * it meant a mention-driven turn emitted neither `runs:changed` nor
 * `items:changed`. The last push any client saw was the progress flush
 * from inside the stream loop, taken before the run was marked succeeded
 * and before a word of the reply existed, so the view fetched on it held
 * a turn still in flight and `staleTime` then held that as fresh.
 *
 * What the person saw: an assistant that had answered, asked two
 * questions, and displayed none of it until they typed again — at which
 * point the questions rendered "Not answered", because their own reply
 * is what `answerableQuestionIds` reads as having moved on.
 *
 * So these assert the push *and what a client reading on it finds*: a
 * snapshot taken inside the sink, because a notification that arrives
 * before the turn is written is the defect wearing the fix's clothes.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const CWD = "/tmp/eo/manual-dispatch";

/** One push, and the conversation as a client would have read it at that instant. */
interface Announcement {
  runId: Uuid;
  itemId: Uuid;
  status: RunStatus;
}

let handle: DbHandle;
let systemAgent: Agent;
let implementer: Agent;
/** What the next dispatch's provider hands back, whatever action it was asked for. */
let answer: unknown;

beforeEach(() => {
  handle = openMigratedTestDb();
  const agents = listAgents(handle.db);
  systemAgent = agents.find((agent) => agent.role === "system")!;
  implementer = agents.find((agent) => agent.role === "implementer")!;
  answer = { message: "Noted." };
});

afterEach(() => {
  handle.close();
});

/** `{ message }` satisfies `assist` and the schema-less `respond` alike. */
function provider(): AgentProvider {
  let counter = 0;
  async function* turn(): AsyncIterable<AgentEvent> {
    counter += 1;
    yield { type: "thread_started", threadId: `thread-${counter}` };
    yield { type: "result", data: answer };
  }
  return {
    start: () => turn(),
    resume: () => turn(),
  };
}

/** What sending a message does: a human comment mentioning the agent. */
function say(item: Item, agent: Agent, body: string) {
  return postComment(handle.db, {
    itemId: item.id,
    author: { type: "human" },
    body,
    mentions: [{ type: "agent", agentId: agent.id }],
  });
}

/**
 * The half of the pack's wiring these tests need, written out.
 *
 * The posters from `roles/`, keyed by the action that produced them —
 * which is what the developer pack's `onRunSucceeded` does for these
 * actions, minus every branch about implementing and reviewing.
 * Taking the wiring itself would put this file on the allowlist in
 * `packs/importAllowlist.test.ts` for no gain: nothing here is about a
 * pack, and these tests are about what the supervisor announces once a
 * turn has been written into the thread.
 */
const POSTERS: Record<string, (db: DbHandle["db"], item: Item, agentId: Uuid, runId: Uuid, result: unknown) => void> = {
  [ASSIST_ACTION]: postAssistReply,
  [RESPOND_ACTION]: postMentionReply,
};

function supervisorOptions(overrides: Record<string, unknown>) {
  return {
    db: handle.db,
    provider: provider(),
    kinds: kindsPreparing(CWD),
    limits: LIMITS,
    onRunSucceeded: (item: Item, agent: Agent, action: string, parsedResult: unknown, runId: Uuid): void => {
      POSTERS[action]?.(handle.db, item, agent.id, runId, parsedResult);
    },
    ...overrides,
  };
}

function supervisorRecording(announcements: Announcement[], atEachPush: () => void = () => {}) {
  return createRunSupervisor(
    supervisorOptions({
      onRunChanged: (runId: Uuid, itemId: Uuid, status: RunStatus) => {
        announcements.push({ runId, itemId, status });
        atEachPush();
      },
    }),
  );
}

/** The dispatches that carry `transitionOnSuccess: false`. */
const MANUAL: { name: string; action: string; open: () => Item; agent: () => Agent }[] = [
  { name: "the assist widget", action: ASSIST_ACTION, open: () => openAssistConversation(handle.db, null), agent: () => systemAgent },
  {
    name: "a plain @-mention",
    action: RESPOND_ACTION,
    open: () => createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" }),
    agent: () => implementer,
  },
];

describe("a manual dispatch announces that it finished", () => {
  it.each(MANUAL)("emits runs:changed and items:changed for $name", async ({ open, action, agent }) => {
    const item = open();
    const announcements: Announcement[] = [];
    const items: Uuid[] = [];
    const engine = createRunSupervisor(
      supervisorOptions({
        onRunChanged: (runId: Uuid, itemId: Uuid, status: RunStatus) => announcements.push({ runId, itemId, status }),
        onItemChanged: (itemId: Uuid) => items.push(itemId),
      }),
    );

    say(item, agent(), "Can you take a look at this?");
    await engine.runOnce();

    const run = listRunsForItem(handle.db, item.id).find((entry) => entry.action === action)!;
    expect(run.status).toBe("succeeded");
    expect(announcements).toContainEqual({ runId: run.id, itemId: item.id, status: "succeeded" });
    expect(items).toContain(item.id);
  });

  it("announces after the whole turn is written, not part of it", async () => {
    // The ordering the panel depends on. A push taken before
    // `postAssistReply` had written the note and the questions would
    // send every client to refetch a turn that does not exist yet — the
    // exact shape of the old `runs:progress` flush, which is why this
    // asserts on the view *at the moment of the push* rather than on the
    // view afterwards.
    const conversation = openAssistConversation(handle.db, null);
    answer = {
      message: "Two things I need before I can draft it.",
      questions: [
        { id: "scope", question: "Per API key or per account?", why: "It decides where the counter lives.", options: ["per key", "per account"] },
        { id: "burst", question: "Should bursts be allowed?", why: "It changes the algorithm.", options: ["yes", "no"] },
      ],
      proposals: [],
    };

    const announcements: Announcement[] = [];
    const seenOnPush: { body: string; canAnswer: boolean; kind: string }[][] = [];
    const engine = supervisorRecording(announcements, () => {
      seenOnPush.push(
        openAssist(handle.db).conversation.messages.map((message) => ({
          body: message.body,
          canAnswer: message.canAnswer,
          kind: message.kind,
        })),
      );
    });

    say(conversation, systemAgent, "How should we rate limit this?");
    await engine.runOnce();

    const run = listRunsForItem(handle.db, conversation.id).find((entry) => entry.action === ASSIST_ACTION)!;
    const index = announcements.findIndex((entry) => entry.runId === run.id && entry.status === "succeeded");
    expect(index).toBeGreaterThanOrEqual(0);

    const view = seenOnPush[index]!;
    // The note, and both questions, answerable — the first fetch a
    // client makes on this push holds the complete turn.
    expect(view.map((message) => message.body)).toContain("Two things I need before I can draft it.");
    const questions = view.filter((message) => message.kind === "question");
    // The rendered card: the question, and underneath it what the
    // answer decides — `postDiscussionQuestions`' own format.
    expect(questions).toHaveLength(2);
    expect(questions[0]?.body).toContain("Per API key or per account?");
    expect(questions[1]?.body).toContain("Should bursts be allowed?");
    expect(questions.every((question) => question.canAnswer)).toBe(true);
  });

  it("does not move the item it answered on (invariant #1)", async () => {
    // Announcing is a notification. Nothing here may write `items.stepId`
    // or reach `transitionItem` — a conversation sits on an off-board
    // step for the whole of its life, and a work item mentioned mid-step
    // stays where the person left it.
    const conversation = openAssistConversation(handle.db, null);
    const story = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });
    const announcements: Announcement[] = [];
    const engine = supervisorRecording(announcements);

    say(conversation, systemAgent, "What is this step for?");
    say(story, implementer, "@implementer quick question before I approve");
    await engine.runOnce();
    await engine.runOnce(); // concurrency is per-agent; the second mention may wait a tick

    expect(announcements.filter((entry) => entry.status === "succeeded")).toHaveLength(2);
    expect(getItem(handle.db, conversation.id)?.stepId).toBe(ASSIST_STEP);
    expect(getItem(handle.db, story.id)?.stepId).toBe("todo");
    expect(listTransitionsForItem(handle.db, conversation.id)).toEqual([]);
    expect(listTransitionsForItem(handle.db, story.id)).toEqual([]);
  });

  it("puts the answer in the thread the push points at", async () => {
    // The push carries ids only (F-05), so what makes it useful is that
    // the refetch it triggers finds something new. Asserted for the
    // plainest of the four: an @-mention on a work item.
    const story = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });
    answer = { message: "Because it smooths bursts." };
    const announcements: Announcement[] = [];
    const bodiesOnPush: string[][] = [];
    const engine = supervisorRecording(announcements, () => {
      bodiesOnPush.push(listCommentsForItem(handle.db, story.id).map((comment) => comment.body));
    });

    say(story, implementer, "@implementer why a token bucket?");
    await engine.runOnce();

    const run = listRunsForItem(handle.db, story.id)[0]!;
    const index = announcements.findIndex((entry) => entry.runId === run.id && entry.status === "succeeded");
    expect(bodiesOnPush[index]).toContain("Because it smooths bursts.");
  });
});
