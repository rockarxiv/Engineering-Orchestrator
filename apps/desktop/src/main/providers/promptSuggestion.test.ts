import { describe, expect, it } from "vitest";
import { cleanSuggestion, PROMPT_SUGGESTION_PROMPT } from "./promptSuggestion.js";

describe("a suggested next message's clean-up and filters (EO-808)", () => {
  it.each([
    ["run the tests", "run the tests"],
    ["yes", "yes"],
    ["file it on Delivery", "file it on Delivery"],
    ["Yes.", "Yes."],
    ["go ahead", "go ahead"],
    ["publish the draft", "publish the draft"],
    ["/compact", "/compact"],
    ["ok", "ok"],
    ["no", "no"],
    ["  approve the proposal  ", "approve the proposal"],
  ])("keeps %j", (answer, kept) => {
    expect(cleanSuggestion(answer)).toBe(kept);
  });

  it.each([
    ["<suggestion>run the tests</suggestion>", "run the tests"],
    ["<reply>file it on Delivery</reply>", "file it on Delivery"],
    ["Suggestion: publish the draft", "publish the draft"],
    ["suggestion:yes", "yes"],
    ["<suggestion>Suggestion: approve it</suggestion>", "approve it"],
  ])("cleans %j up to %j", (answer, kept) => {
    expect(cleanSuggestion(answer)).toBe(kept);
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["an empty tag", "<suggestion></suggestion>"],
    ["done", "done"],
    ["done, capitalised", "Done."],
    ["a meta-reply", "nothing to suggest"],
    ["a meta-reply, worded otherwise", "No suggestion this time"],
    ["silence", "silence"],
    ["silence, said so", "Stay silent"],
    ["wrapped in brackets", "[no suggestion]"],
    ["wrapped in parentheses", "(silence)"],
    ["wrapped in parentheses, words inside", "(waiting for the person to decide)"],
    ["API error text", "API Error: 529 overloaded"],
    ["an error", "Error: request failed"],
    ["a 'word: ' label", "User: run the tests"],
    ["one word", "tests"],
    ["one word, not a known answer", "maybe"],
    ["more than twelve words", "please go ahead and file this on the delivery board for the team right now"],
    ["100 characters or more", `publish ${"a".repeat(95)}`],
    ["more than one sentence", "Run the tests. Then publish it"],
    ["a newline", "run the\ntests"],
    ["a '*'", "run the *tests*"],
    ["thanks", "thanks, publish it"],
    ["looks good", "looks good to me"],
    ["perfect", "perfect, ship it"],
    ["great", "great work there"],
    ["the agent's voice: let me", "Let me run the tests"],
    ["the agent's voice: I'll", "I'll file it now"],
    ["the agent's voice: I've", "I've filed it on Delivery"],
    ["the agent's voice: here's", "here's the plan for it"],
    ["the agent's voice: you should", "you should publish it"],
    ["the agent's voice: sure,", "sure, I can do that"],
  ])("drops %s", (_case, answer) => {
    expect(cleanSuggestion(answer)).toBeNull();
  });
});

describe("the suggestion prompt (EO-808)", () => {
  it("is EO's own wording, with the rules the feature's decisions set", () => {
    // Predict the person, not the agent; pick the likely option; answer a
    // go-on question; stay silent after an error or when unsure; the
    // length; never praise, question or speak as the agent; EO's examples.
    for (const rule of [
      "predict the very next message the person would type",
      "Not what you think they ought to do next",
      "offered choices",
      '"yes" or "go ahead"',
      "reported an error",
      "misunderstood",
      "credentials",
      "2 to 12 words",
      "one sentence",
      "Never thank or praise",
      "never ask a question",
      '"Let me…", "I\'ll…"',
      "never bring up anything the person has not raised",
      "file it on Delivery",
      "publish the draft",
      "approve the proposal",
      "Do not call any tool",
    ]) {
      expect(PROMPT_SUGGESTION_PROMPT).toContain(rule);
    }
    // Not Claude Code's: none of its prompt's sentences.
    expect(PROMPT_SUGGESTION_PROMPT).not.toMatch(/\[SUGGESTION MODE/);
    expect(PROMPT_SUGGESTION_PROMPT).not.toMatch(/Claude/);
  });
});
