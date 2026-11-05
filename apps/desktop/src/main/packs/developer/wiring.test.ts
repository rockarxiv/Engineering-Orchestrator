import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistOutputSchema, INTERPRET_ACTION } from "@eo/core";
import type { DbHandle } from "../../db/client.js";
import { createPipeline, createRun, createStep, getItem, listModules, listPipelineSteps, listCommentsForItem } from "../../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../../db/testHelpers.js";
import { createRoleWiring } from "./wiring.js";
import { bridgePushChannels } from "../../ipc/push.js";
import { ASSIST_ACTION, assistAgent, openAssistRoom } from "../../roles/assist.js";
import { ASSIST_STEP, SCENARIO_ACTION, SCENARIO_STEP } from "../../roles/conversationSteps.js";
import { scenarioAgent } from "../../roles/scenario.js";
import { PROPOSAL_KIND } from "../../roles/proposal.js";
import { continueTrialLoop } from "../../trials/design.js";

// The test-fix loop's next step, watched and still run (EO-587).
vi.mock("../../trials/design.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../trials/design.js")>();
  return { ...actual, continueTrialLoop: vi.fn(actual.continueTrialLoop) };
});

/**
 * A conversation is not a pipeline stage.
 *
 * `resolveNextState` short-circuits on the conversational actions before
 * it derives a result key, because a conversation ends when a human
 * closes it and a draft moves no item anywhere — what it talks *about* is
 * a graph or somebody else's work, while the item it talks *on* is the
 * chat.
 *
 * Nothing tested that. Mutation testing could turn the `||` joining the
 * actions into `&&` — making the guard unreachable — with the whole
 * desktop suite still green.
 */
describe("routing a conversation", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  function conversationOn(stepId: string) {
    const steps = listPipelineSteps(handle.db);
    const step = steps.find((candidate) => candidate.id === stepId)!;
    const item = createTestItem(handle.db, { type: "story", title: "A conversation", stepId });
    return { step, steps, item };
  }

  // The conversational actions are pinned by what the guard *prevents*
  // rather than by where the item lands: a conversation step may carry
  // routes of its own, so "returns null" need not be true of every room.
  // What holds for each is that no result key is derived, and therefore
  // nothing is reported as unroutable.
  it.each([
    ["an assistant chat", ASSIST_STEP, ASSIST_ACTION, { message: "Sure." }],
    ["a module's scenario chat", SCENARIO_STEP, SCENARIO_ACTION, { message: "It passed." }],
  ])("does not ask a human about %s, because it is not stuck", (_label, stepId, action, result) => {
    // Reached by the no-route branch instead, a conversation would post
    // "returned the result 'done', which has no route configured" on every
    // single turn — invariant #8's comment firing where there is nothing
    // wrong to report, on the one surface a person is actually reading.
    const { step, steps, item } = conversationOn(stepId);

    createRoleWiring(handle.db).resolveNextState(step, steps, result, action, item);

    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
  });

  // A scenario turn's reply reaches its thread through the same branch
  // every room's does (EO-356): the message, posted by the agent.
  it("posts a scenario turn's reply into its conversation", () => {
    const { item } = conversationOn(SCENARIO_STEP);
    const agent = scenarioAgent(handle.db)!;

    const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: SCENARIO_ACTION });
    createRoleWiring(handle.db).onRunSucceeded(item, agent, SCENARIO_ACTION, { message: "It passed." }, run.id);

    expect(listCommentsForItem(handle.db, item.id).map((comment) => [comment.authorType, comment.body])).toEqual([["agent", "It passed."]]);
  });

  /**
   * An interpretation is not a stage either (EO-184), and it is the one
   * that could do damage: unlike a conversation it runs on an item
   * sitting on a real pipeline step, so anything derived from its result
   * would be read as *that step's* result and routed on.
   */
  it("routes nothing for an interpretation, and moves the item nowhere", () => {
    const steps = listPipelineSteps(handle.db);
    // The seeded pipeline's entry step: a builtin, which is exactly
    // where a parked item sits while its reply is being read.
    const step = steps.find((candidate) => candidate.id === "worktree")!;
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: step.id });

    // Shaped like the builtin's own result on purpose — `{ result: ... }`
    // is what the branch above this one reads, and an interpretation
    // must not fall into it.
    const next = createRoleWiring(handle.db).resolveNextState(step, steps, { status: "answered", answer: "ready" }, INTERPRET_ACTION, item);

    expect(next).toBeNull();
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("worktree");
  });

  it("still routes an ordinary action on a pipeline of its own steps", () => {
    // The converse: the short-circuit must not swallow everything. A step
    // with no route for what came back is the case that *should* reach a
    // human.
    const pipeline = createPipeline(handle.db, { name: "Bespoke", projectId: null });
    const step = createStep(handle.db, { id: "bespoke-build", pipelineId: pipeline.id, position: 0, name: "Build", ownerRole: "implementer", entryAction: "implement" });
    const item = createTestItem(handle.db, { type: "story", title: "Work", stepId: step.id });

    createRoleWiring(handle.db).resolveNextState(step, [step], { result: "done" }, "implement", item);

    // Not asserting where it went — only that this path is alive and says
    // something, which is what distinguishes it from the conversation one.
    expect(listCommentsForItem(handle.db, item.id).length).toBeGreaterThan(0);
  });
});

/**
 * Saving an assistant card's modules is announced (EO-381).
 *
 * The Modules screen reads a cached catalog that `config:changed` is
 * what refreshes. A turn is posted from here, in the supervisor's path
 * and behind no IPC handler, so nothing announces the write unless this
 * does — and without it a person already on Settings → Modules is asked
 * to approve a module that is not in the list in front of them.
 */
describe("an assistant card that saves a module", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  const MODULE = {
    name: "Release merge",
    slug: "release-merge",
    description: "Merges the release branch once CI is green.",
    code: "export default async () => ({ ok: true, result: 'merged' });",
    manifest: { name: "Release merge", description: "Merges the release branch once CI is green.", results: ["merged"] },
    why: "Before agents existed this was a script.",
    tests: [{ description: "merges", source: "export default async function (harness) { await harness.run({}); }" }],
  };

  /** A new two-step pipeline whose first step runs `MODULE`, under `name`. */
  function draft(name: string) {
    return {
      rationale: "Merge, then hand over.",
      entryStepId: "release_merge",
      target: { newPipeline: name },
      steps: [
        { id: "release_merge", position: 0, name: "Merge", type: "module", ownerRole: null, entryAction: "release-merge", instructionsSummary: null, isTerminal: false, planMode: false },
        { id: "release_done", position: 1, name: "Released", type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true, planMode: false },
      ],
      routes: [{ fromStepId: "release_merge", resultKey: "merged", label: "Merged", tone: "success", target: "release_done", position: 0 }],
    };
  }

  /** One assist turn posted the way the supervisor posts it, and every push that caused. */
  function posted(output: unknown): string[] {
    const parsed = AssistOutputSchema.parse(output);
    const conversation = openAssistRoom(handle.db, null).conversation;
    const agent = assistAgent(handle.db)!;
    const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION });

    const pushes: string[] = [];
    const stop = bridgePushChannels({ send: (channel) => pushes.push(channel) });
    try {
      createRoleWiring(handle.db).onRunSucceeded(conversation, agent, ASSIST_ACTION, parsed, run.id);
    } finally {
      stop();
    }
    return pushes;
  }

  const saved = () => listModules(handle.db).some((module) => module.slug === MODULE.slug);

  it("pushes config:changed, so an open Modules screen lists what it is being asked to approve", () => {
    const pushes = posted({ message: "Here.", draft: draft("Release"), modules: [MODULE] });

    expect(saved()).toBe(true);
    expect(pushes).toContain("push:config:changed");
  });

  it("pushes nothing for a turn that saved no module", () => {
    // Talking, and a card refused before anything is written: the seeded
    // pipeline already holds this name.
    const talking = posted({ message: "That step waits for CI." });
    const refused = posted({ message: "Here.", draft: draft("Delivery"), modules: [MODULE] });

    expect(saved()).toBe(false);
    expect([...talking, ...refused]).not.toContain("push:config:changed");
  });

  it("hands the draft cards a reply posted to the test-fix loop, which classifies them against a design under test (EO-587)", () => {
    vi.mocked(continueTrialLoop).mockClear();
    posted({ message: "Here.", draft: draft("Release"), modules: [MODULE] });

    expect(continueTrialLoop).toHaveBeenCalledTimes(1);
    const [, conversation, cards] = vi.mocked(continueTrialLoop).mock.calls[0]!;
    const card = listCommentsForItem(handle.db, conversation.id).find((comment) => comment.kind === PROPOSAL_KIND);
    expect(cards).toEqual([card!.id]);
  });

  it("pushes nothing when the module on the card is one the catalog already holds", () => {
    posted({ message: "Here.", draft: draft("Release"), modules: [MODULE] });

    // The same module proposed again writes nothing, so there is nothing to announce.
    expect(posted({ message: "Again.", draft: draft("Release"), modules: [MODULE] })).not.toContain("push:config:changed");
  });
});
