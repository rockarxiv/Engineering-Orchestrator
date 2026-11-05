import { INTERPRET_ACTION, THREAD_PER_CONVERSATION_ACTIONS, reusesThreadPerItem } from "@eo/core";
import { describe, expect, it } from "vitest";
import { registry } from "../registry.js";
import { conversationActionFor, RESPOND_ACTION } from "../supervisor/manualDispatch.js";
import {
  ASSIST_ACTION,
  ASSIST_SETTINGS_KEY,
  ASSIST_STEP,
  CONVERSATION_SETTINGS_KEY,
  SCENARIO_ACTION,
  SCENARIO_SETTINGS_KEY,
  SCENARIO_STEP,
  conversationTurnOptions,
} from "./conversationSteps.js";

/**
 * The supervisor used to read one room's settings from behind a
 * hardcoded step comparison, so only one room could ever have its model
 * and effort reach a run. Nothing tested it in either direction — not the
 * behaviour that was right, not the one that was missing — which is how a
 * mapping came to be silently half-applied.
 */
describe("the model and effort a conversation turn runs with", () => {
  it("applies the assistant's own settings", () => {
    expect(
      conversationTurnOptions({ stepId: ASSIST_STEP, spec: { assist: { model: "claude-opus-5", reasoningEffort: "high" } } }),
    ).toEqual({ model: "claude-opus-5", reasoningEffort: "high", showReasoning: true, streamDeltas: true, streamAnswer: true });
  });

  it("does not read one room's settings for the other", () => {
    // The key is the room's, not "whichever one is present".
    expect(conversationTurnOptions({ stepId: SCENARIO_STEP, spec: { assist: { model: "claude-opus-5" } } })).toEqual({ showReasoning: true, streamDeltas: true, streamAnswer: true });
    expect(conversationTurnOptions({ stepId: ASSIST_STEP, spec: { scenario: { model: "claude-opus-5" } } })).toEqual({ showReasoning: true, streamDeltas: true, streamAnswer: true });
  });

  it("is no conversation at all on the steps Discussions and the Architecture panel used (EO-526)", () => {
    // Their conversations are deleted at startup, and a turn on either
    // step would take the agent's own model like any other item.
    expect(conversationTurnOptions({ stepId: "discussion", spec: { discussion: { model: "claude-opus-5" } } })).toEqual({});
    expect(conversationTurnOptions({ stepId: "architecture", spec: { architect: { model: "claude-opus-5" } } })).toEqual({});
  });

  it("takes the agent's own model on an item that is not in a conversation at all", () => {
    expect(conversationTurnOptions({ stepId: "todo", spec: { assist: { model: "claude-opus-5" } } })).toEqual({});
    expect(conversationTurnOptions({ stepId: null, spec: { assist: { model: "claude-opus-5" } } })).toEqual({});
  });

  it("ignores a spec that is not the shape it expects rather than failing a dispatch", () => {
    // `typeof null === "object"` and an array is one too, so both reach
    // the property reads and would hand the provider `undefined`.
    for (const settings of [null, "opus", 7, [], undefined]) {
      expect(conversationTurnOptions({ stepId: ASSIST_STEP, spec: { assist: settings } })).toEqual({ showReasoning: true, streamDeltas: true, streamAnswer: true });
    }
    expect(conversationTurnOptions({ stepId: ASSIST_STEP, spec: null })).toEqual({ showReasoning: true, streamDeltas: true, streamAnswer: true });
    expect(conversationTurnOptions({ stepId: ASSIST_STEP })).toEqual({ showReasoning: true, streamDeltas: true, streamAnswer: true });
  });

  it("treats an empty model name as no choice, not as a model called \"\"", () => {
    expect(conversationTurnOptions({ stepId: ASSIST_STEP, spec: { assist: { model: "", reasoningEffort: "" } } })).toEqual({ showReasoning: true, streamDeltas: true, streamAnswer: true });
  });

  it("keeps one field when only one was chosen", () => {
    expect(conversationTurnOptions({ stepId: ASSIST_STEP, spec: { assist: { reasoningEffort: "low" } } })).toEqual({ reasoningEffort: "low", showReasoning: true, streamDeltas: true, streamAnswer: true });
  });

  it("streams every conversation's turns and shows their reasoning unless it was turned off, and says nothing off a conversation", () => {
    expect(conversationTurnOptions({ stepId: ASSIST_STEP, spec: { assist: { showReasoning: false } } })).toEqual({ showReasoning: false, streamDeltas: true, streamAnswer: true });
    expect(conversationTurnOptions({ stepId: ASSIST_STEP, spec: { assist: { showReasoning: true } } })).toEqual({ showReasoning: true, streamDeltas: true, streamAnswer: true });
    // Every room is drawn the same way, so every room streams and shows it too.
    expect(conversationTurnOptions({ stepId: SCENARIO_STEP, spec: { scenario: {} } })).toEqual({ showReasoning: true, streamDeltas: true, streamAnswer: true });
    expect(conversationTurnOptions({ stepId: SCENARIO_STEP, spec: { scenario: { showReasoning: false } } })).toEqual({ showReasoning: false, streamDeltas: true, streamAnswer: true });
    expect(conversationTurnOptions({ stepId: ASSIST_STEP, spec: { assist: { showReasoning: "no" } } })).toEqual({ showReasoning: true, streamDeltas: true, streamAnswer: true });
    expect(conversationTurnOptions({ stepId: "todo", spec: { assist: { showReasoning: false } } })).toEqual({});
  });

  it("applies the assist room's, which shares one spec object with its page key", () => {
    // `roles/assist.ts` keeps the page key under the same key, so a room
    // whose settings were read from a second object would lose one of
    // the two on every write.
    expect(
      conversationTurnOptions({ stepId: ASSIST_STEP, spec: { assist: { pageKey: "settings", reasoningEffort: "low" } } }),
    ).toEqual({ reasoningEffort: "low", showReasoning: true, streamDeltas: true, streamAnswer: true });
  });

  it("is the same key the conversation panels write", () => {
    // The rooms' commands import these constants for their
    // `ConversationKind.settingsKey`. Spelled as literals in several
    // places instead, the chat could read one key while every run read
    // another, with nothing to catch it.
    expect(CONVERSATION_SETTINGS_KEY[ASSIST_STEP]).toBe(ASSIST_SETTINGS_KEY);
    expect(CONVERSATION_SETTINGS_KEY[SCENARIO_STEP]).toBe(SCENARIO_SETTINGS_KEY);
  });

  it("applies a scenario chat's own settings, kept beside the module it is about", () => {
    expect(
      conversationTurnOptions({ stepId: SCENARIO_STEP, spec: { scenario: { moduleId: "m-1", model: "gpt-5.2-codex" } } }),
    ).toEqual({ model: "gpt-5.2-codex", showReasoning: true, streamDeltas: true, streamAnswer: true });
  });

  it("keeps the rooms distinct", () => {
    // The step and the action are separate constants even where they
    // read alike: the step is a row in `pipeline_steps` and the action
    // selects an output schema, and a room that conflated them would be
    // one rename away from dispatching against a step that does not
    // exist.
    expect(new Set([ASSIST_STEP, SCENARIO_STEP]).size).toBe(2);
    expect(new Set(Object.values(CONVERSATION_SETTINGS_KEY)).size).toBe(2);
    expect(ASSIST_ACTION).toBe("assist");
    expect(SCENARIO_ACTION).toBe("scenario");
  });
});

/**
 * The rooms' actions, and the list in `packages/core` that decides their
 * thread reuse (EO-210).
 *
 * `reusesThreadPerItem` has to answer the same way in the main
 * process, the editor and the `eo` MCP service, so the list of actions
 * whose item is a conversation lives over there — as string literals,
 * because `conversationSteps.ts` is a leaf module that imports nothing.
 * Two spellings of one fact is exactly the drift this repository keeps
 * writing tests against, so here is the test: rename an action here and
 * the reuse decision stops matching, which fails loudly rather than
 * turning a chat back into one-shot dispatches with nothing to notice.
 */
describe("the actions a conversation runs, against core's thread-reuse list", () => {
  it("names every room, and no room's action is missing from it", () => {
    expect([ASSIST_ACTION, SCENARIO_ACTION].sort()).toEqual([...THREAD_PER_CONVERSATION_ACTIONS].sort());
  });

  it("gives the system agent one thread per conversation in each room", () => {
    for (const action of [ASSIST_ACTION, SCENARIO_ACTION]) {
      expect(reusesThreadPerItem(registry, { role: "system", config: {} }, action), action).toBe(true);
    }
  });

  it("does not give it one on the two actions that run against real work", () => {
    // `respond` answers an @-mention on somebody's item and
    // `interpret` reads one reply to a step that parked. Both are
    // episodes on a work item, so a thread keyed on that item would
    // pool unrelated dispatches into one conversation.
    expect(reusesThreadPerItem(registry, { role: "system", config: {} }, RESPOND_ACTION)).toBe(false);
    expect(reusesThreadPerItem(registry, { role: "system", config: {} }, INTERPRET_ACTION)).toBe(false);
  });

  it("no longer knows `discuss` or `configure`, the actions of the two retired rooms (EO-526)", () => {
    expect(THREAD_PER_CONVERSATION_ACTIONS).not.toContain("discuss");
    expect(THREAD_PER_CONVERSATION_ACTIONS).not.toContain("configure");
    expect(conversationActionFor("discussion")).toBeUndefined();
    expect(conversationActionFor("architecture")).toBeUndefined();
    expect(conversationActionFor(ASSIST_STEP)).toBe(ASSIST_ACTION);
    expect(conversationActionFor(SCENARIO_STEP)).toBe(SCENARIO_ACTION);
  });
});
