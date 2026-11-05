import { assembleContext, type AssembleContextInput } from "@eo/engine";
import { describe, expect, it } from "vitest";
import { ASSIST_ACTION, SCENARIO_ACTION } from "../roles/conversationSteps.js";
import { RESPOND_ACTION } from "./manualDispatch.js";

/**
 * The engine's action strings, pinned to what the dispatcher sends.
 *
 * `packages/engine` is pure and cannot import the main process's
 * constants, so every action it branches on is a string literal written
 * out by hand. That is fine right up until one of them is wrong, and one
 * of them was: the project listing guarded on `"discussion"` — the
 * *step* a conversation sat on — while the dispatcher sent `"discuss"`.
 * The product owner never received the listing that function existed to
 * give it, and nothing failed. It typechecked, because both are `string`.
 * (That listing went with Discussions in EO-526.)
 *
 * These tests are the seam that would have caught it: they call
 * `assembleContext` with the real constants and assert the section the
 * action is supposed to produce. A literal that drifts from a constant
 * now breaks a test rather than a feature.
 */

function input(action: string, overrides: Partial<AssembleContextInput> = {}): AssembleContextInput {
  return {
    action,
    item: { key: "EO-1", title: "A ticket", body: null, acceptanceCriteria: [], actionOverrides: new Map(), workspaceKind: "none" },
    // None: what the developer pack contributes is asserted where it
    // lives (`packs/developer/sections.test.ts`), and these tests are
    // about the sections the engine gates on an action itself.
    sectionRenderers: [],
    commentThread: [],
    dependencies: [],
    maxTokens: 24_000,
    ...overrides,
  };
}

/**
 * The screen pointer (EO-192), pinned the same way.
 *
 * Worth pinning even though `ASSIST_ACTION` and `ASSIST_STEP` happen to
 * be the same word today: that coincidence is what would *hide* a
 * step-for-action mistake if either were ever renamed, since the
 * engine's literal would go on matching the one that had not moved.
 */
describe("the screen pointer reaches an assist turn", () => {
  it("renders for the action the dispatcher actually sends", () => {
    const assembled = assembleContext(input(ASSIST_ACTION));

    expect(assembled.screenSection).not.toBeNull();
    expect(assembled.fullText).toContain("## The screen");
  });

  it("names the tool in a form the agent can actually find", () => {
    // Two failures, one sentence. EO-149: an unqualified name on its own
    // is a name nothing advertises, and at least one model refuses rather
    // than going to look. EO-198/EO-203: a name qualified in *one
    // backend's* punctuation is worse, because it is a name that does not
    // exist on the other one — this used to render
    // `mcp__eo_admin__view_current`, and Codex sends
    // `eo_admin/view_current`. What both backends agree on is the server,
    // so the prose names the tool, names the server, and says the
    // punctuation is not the thing to match on.
    const section = assembleContext(input(ASSIST_ACTION)).screenSection;

    expect(section).toContain("`view_current`");
    expect(section).toContain("`eo_admin`");
    expect(section).not.toContain("mcp__eo_admin__");
  });

  it("carries no description of the screen itself — that is the tool's to answer", () => {
    // The whole of EO-192: what used to be here was the page, resolved at
    // dispatch and stale by the second question.
    expect(assembleContext(input(ASSIST_ACTION)).fullText).not.toContain("## The page");
  });

  it("renders nothing on the actions that have an item in front of them", () => {
    for (const action of [SCENARIO_ACTION, RESPOND_ACTION, "implement", "review"]) {
      expect(assembleContext(input(action)).screenSection, action).toBeNull();
    }
  });
});

describe("the other action-gated sections", () => {
  it("asks the implementer to plan only on implement", () => {
    expect(assembleContext(input("implement", { planMode: true })).planModeSection).not.toBeNull();
    expect(assembleContext(input(ASSIST_ACTION, { planMode: true })).planModeSection).toBeNull();
    expect(assembleContext(input("review", { planMode: true })).planModeSection).toBeNull();
  });
});

/**
 * The two listings only `discuss` and `configure` were given are gone
 * with their rooms (EO-526). An assembly for either word, should one ever
 * be asked for, carries neither — and nor does the assistant's, which
 * reads the board and the configuration with its tools.
 */
describe("the listings the retired rooms were given", () => {
  it("are rendered for no action", () => {
    for (const action of ["discuss", "configure", ASSIST_ACTION]) {
      const { fullText } = assembleContext(input(action));
      expect(fullText, action).not.toContain("## The project");
      expect(fullText, action).not.toContain("## The configuration");
    }
  });
});
