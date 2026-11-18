import { SUGGESTION_FILTER_RULES, type SuggestionFilterRule } from "@eo/core";
import { describe, expect, it } from "vitest";
import { cleanSuggestion, judgeSuggestion, lastRequestMostlyUncached, PROMPT_SUGGESTION_PROMPT } from "./promptSuggestion.js";

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

describe("which filter dropped an answer (EO-810)", () => {
  const dropped: [SuggestionFilterRule, string][] = [
    ["empty", "   "],
    ["empty", "<suggestion></suggestion>"],
    ["done", "Done."],
    ["meta_reply", "nothing to suggest"],
    ["meta_reply", "silence"],
    ["bracketed", "(file it on Delivery)"],
    ["bracketed", '{"outcome":{"message":"yes"}}'],
    ["api_error", "API error: overloaded"],
    ["label", "Plan: file it"],
    ["formatting", "file it\non Delivery"],
    ["formatting", "file it on **Delivery**"],
    ["too_long", "file it " + "x".repeat(100)],
    ["too_few_words", "Delivery"],
    ["too_many_words", "please file it on the Delivery board today and then publish the draft too"],
    ["multiple_sentences", "File it. Then publish."],
    ["praise", "perfect, file it"],
    ["agent_voice", "let me file it"],
    ["agent_voice", "sure, file it"],
  ];

  it.each(dropped)("names %s for %j", (rule, answer) => {
    expect(judgeSuggestion(answer)).toEqual({ kept: false, rule });
    expect(cleanSuggestion(answer)).toBeNull();
  });

  it("has a case for every rule it can name", () => {
    expect(new Set(dropped.map(([rule]) => rule))).toEqual(new Set(SUGGESTION_FILTER_RULES));
  });

  it("keeps an answer the filters pass, cleaned up", () => {
    expect(judgeSuggestion("<suggestion>Suggestion: publish the draft</suggestion>")).toEqual({ kept: true, text: "publish the draft" });
  });
});

describe("a last request mostly uncached (EO-810)", () => {
  it("is one past 10,000 tokens uncached that read less from the cache than it did not", () => {
    expect(lastRequestMostlyUncached({ uncachedTokens: 11_100, cachedTokens: 1_000 })).toBe(true);
  });

  it("is not ASK-78's: 10,786 tokens of new tool output beside 103,040 read from the cache", () => {
    expect(lastRequestMostlyUncached({ uncachedTokens: 113_511 - 103_040 + 315, cachedTokens: 103_040 })).toBe(false);
  });

  it("is not one at or under 10,000 tokens uncached, however little was cached", () => {
    expect(lastRequestMostlyUncached({ uncachedTokens: 10_000, cachedTokens: 0 })).toBe(false);
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
      // A turn with an answer schema: the suggestion in its message, the rest empty (EO-839).
      "When your answer has a structure, put the suggested message in the answer's message field",
      "leave every other field empty or null",
    ]) {
      expect(PROMPT_SUGGESTION_PROMPT).toContain(rule);
    }
    // Not Claude Code's: none of its prompt's sentences.
    expect(PROMPT_SUGGESTION_PROMPT).not.toMatch(/\[SUGGESTION MODE/);
    expect(PROMPT_SUGGESTION_PROMPT).not.toMatch(/Claude/);
  });
});
