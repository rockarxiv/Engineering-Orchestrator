import { pageDescriptorFor, type AgentEvent, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listActionDefinitions, listCommentsForItem, listRunsForItem } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { sendToAssist } from "../ipc/assistCommands.js";
import { clearPublishedView } from "../ipc/currentView.js";
import { proposedActionsProblem, registryForProject } from "../registry.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * A reply whose proposed action definition this installation's save
 * would refuse is sent back to the agent (EO-426).
 *
 * The rule lives in `proposedActionsProblem`; this is the proof that
 * the supervisor applies it where every result is validated. A pack's
 * own role redefining its own shipped action passes the reply's schema
 * — `packages/core` holds no registry to ask — so without this the run
 * succeeded and the reason was only ever posted into the thread, where
 * the agent does not read it until a person types again. Here the agent
 * is re-prompted with the save's own sentence in the same run, and the
 * corrected reply is the one that lands.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/** Each start or resume answers with the next scripted result; what the supervisor sent back is recorded. */
function providerYielding(results: unknown[]) {
  let index = 0;
  const promptsSeen: string[] = [];
  async function* emit(): AsyncIterable<AgentEvent> {
    const data = results[Math.min(index, results.length - 1)];
    index += 1;
    yield { type: "result", data };
  }
  return {
    promptsSeen,
    provider: {
      async *start(): AsyncIterable<AgentEvent> {
        yield { type: "thread_started", threadId: "t1" };
        yield* emit();
      },
      async *resume(_threadId: string, message: string): AsyncIterable<AgentEvent> {
        promptsSeen.push(message);
        yield* emit();
      },
    },
  };
}

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  clearPublishedView();
  handle.close();
});

/** A two-step pipeline whose one working step is `qa` on `alignment`. */
function qaDraft(target?: Record<string, string>) {
  return {
    rationale: "A pipeline that checks work against what was asked for.",
    entryStepId: "qa_gate_check",
    ...(target === undefined ? {} : { target }),
    steps: [
      { id: "qa_gate_check", position: 0, name: "Check", type: "agent", ownerRole: "qa", entryAction: "alignment", instructionsSummary: null, isTerminal: false, planMode: false },
      { id: "qa_gate_done", position: 1, name: "Checked", type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true, planMode: false },
    ],
    routes: [
      { fromStepId: "qa_gate_check", resultKey: "aligned", label: "Aligned", tone: "success", target: "qa_gate_done", position: 0 },
      { fromStepId: "qa_gate_check", resultKey: "gaps_found", label: "Gaps found", tone: "danger", target: "user_attention", position: 1 },
    ],
  };
}

const ALIGNMENT = { role: "qa", action: "alignment", results: [{ key: "aligned" }, { key: "gaps_found" }] };
/** The reviewer's own `review`, which the developer pack ships and no definition may replace. */
const REVIEW_REDEFINED = { role: "reviewer", action: "review", results: [{ key: "passed" }] };
/** And the implementer's own `implement`. */
const IMPLEMENT_REDEFINED = { role: "implementer", action: "implement", results: [{ key: "done" }] };

const REFUSED_REVIEW = `reviewer's "review": The reviewer role's "review" action cannot be redefined`;
const REFUSED_IMPLEMENT = `implementer's "implement": The implementer role's "implement" action cannot be redefined`;

function cards(conversationId: string): number {
  return listCommentsForItem(handle.db, conversationId as Uuid).filter((comment) => comment.kind === PROPOSAL_KIND).length;
}

describe("an assist turn proposing a definition the save refuses", () => {
  async function ask() {
    return (await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/settings"), conversationId: null, body: "Build me a QA gate.", attachmentIds: [], interrupt: false }))
      .conversation;
  }

  it("is sent back with the reason, and the corrected reply is the one accepted — with no person in between", async () => {
    const conversation = await ask();
    const draft = qaDraft({ newPipeline: "QA gate" });
    const { provider, promptsSeen } = providerYielding([
      { message: "Here.", draft, actions: [ALIGNMENT, IMPLEMENT_REDEFINED] },
      { message: "Here.", draft, actions: [ALIGNMENT] },
    ]);

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    expect(promptsSeen).toHaveLength(1);
    expect(promptsSeen[0]).toContain(REFUSED_IMPLEMENT);

    const runs = listRunsForItem(handle.db, conversation.id as Uuid);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("succeeded");
    expect(JSON.stringify(runs[0]?.result)).not.toContain('"implementer"');
    expect(listActionDefinitions(handle.db)).toEqual([]);
  });

  it("is never accepted, and so never becomes a card, when the agent does not correct it", async () => {
    const conversation = await ask();
    const { provider, promptsSeen } = providerYielding([{ message: "Here.", draft: qaDraft({ newPipeline: "QA gate" }), actions: [IMPLEMENT_REDEFINED] }]);

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    expect(promptsSeen.length).toBeGreaterThan(0);
    const [run] = listRunsForItem(handle.db, conversation.id as Uuid);
    expect(run?.status).not.toBe("succeeded");
    expect(run?.error).toContain(REFUSED_IMPLEMENT);
    expect(cards(conversation.id)).toBe(0);
    expect(listActionDefinitions(handle.db)).toEqual([]);
  });

  it("is not sent back when every definition is one the save would write", async () => {
    const conversation = await ask();
    const { provider, promptsSeen } = providerYielding([{ message: "Here.", draft: qaDraft({ newPipeline: "QA gate" }), actions: [ALIGNMENT] }]);

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    expect(promptsSeen).toEqual([]);
    expect(listRunsForItem(handle.db, conversation.id as Uuid)[0]?.status).toBe("succeeded");
  });
});

describe("proposedActionsProblem", () => {
  const registry = () => registryForProject(handle.db, null);

  it("asks nothing of a reply that proposes no definitions", () => {
    expect(proposedActionsProblem(registry(), { message: "Which role owns QA?" })).toBeNull();
    expect(proposedActionsProblem(registry(), { message: "Here.", draft: qaDraft(), actions: [] })).toBeNull();
    expect(proposedActionsProblem(registry(), "not a reply at all")).toBeNull();
  });

  it("accepts a custom role's own action, including one that takes a pack action's name", () => {
    expect(proposedActionsProblem(registry(), { actions: [ALIGNMENT, { role: "qa", action: "review", results: [{ key: "passed" }] }] })).toBeNull();
  });

  it("names every definition a pack's own role may not redefine", () => {
    const problem = proposedActionsProblem(registry(), { actions: [ALIGNMENT, REVIEW_REDEFINED, IMPLEMENT_REDEFINED] });

    expect(problem).toContain(REFUSED_REVIEW);
    expect(problem).toContain(REFUSED_IMPLEMENT);
    expect(problem).not.toContain(`qa's "alignment"`);
  });
});
