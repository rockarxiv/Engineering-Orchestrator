import { describe, expect, it } from "vitest";
import { outcomeProse } from "./outcome-shape.js";

describe("the words inside an outcome envelope", () => {
  it("reads an implementer's progress update as what it says, not as a branch", () => {
    // #144, verbatim. Rendered as written this is a finished handoff
    // claiming a branch of `in_progress`, in the middle of a run that is
    // still going — which is how a healthy run came to read as stuck.
    const raw = JSON.stringify({
      outcome: {
        branch: "in_progress",
        summary: "...starting...",
        files_changed: [],
        tests_run: false,
        handoff: "Work in progress.",
      },
    });

    const shown = outcomeProse(raw);
    expect(shown).toBe("...starting...\n\nWork in progress.");
    expect(shown).not.toContain("in_progress");
    expect(shown).not.toContain("branch");
  });

  it("reads a reviewer's verdict out of its own field", () => {
    // The field a result puts its words in differs by action, and no
    // action is privileged: whichever of them carries prose is shown.
    expect(outcomeProse('{"outcome":{"verdict":"approve","feedback":"Reads well."}}')).toBe("Reads well.");
  });

  it("reads through a fence, which is how a model asked for JSON writes it", () => {
    expect(outcomeProse('```json\n{"outcome":{"summary":"Fenced."}}\n```')).toBe("Fenced.");
  });

  it("says the same sentence once, however many fields it was put in", () => {
    expect(outcomeProse('{"outcome":{"summary":"Same words.","handoff":"Same words."}}')).toBe("Same words.");
  });

  it("leaves ordinary prose alone", () => {
    expect(outcomeProse("Reading the story and the surrounding code.")).toBeNull();
    expect(outcomeProse("")).toBeNull();
  });

  it("leaves a JSON snippet an agent merely quoted alone", () => {
    // The envelope is required, not just an object with familiar fields.
    // An agent pasting a config into its narration is quoting something,
    // and a transcript that quietly rewrote it would be worse than the
    // one this fixes.
    expect(outcomeProse('{"summary":"not an outcome","enabled":true}')).toBeNull();
    // `outcome` alongside other keys is a result with a field of that
    // name, not a wrapper — the same line `unwrapOutcome` draws.
    expect(outcomeProse('{"outcome":{"summary":"x"},"else":1}')).toBeNull();
  });

  it("shows an envelope with no words in it as it arrived", () => {
    // Null, so the caller falls back to the raw text. Nothing is hidden
    // just because this function did not recognise it — an action whose
    // schema this file has never heard of (invariant 7) still gets shown.
    expect(outcomeProse('{"outcome":{"branch":"eo/EO-1","tests_run":true}}')).toBeNull();
    expect(outcomeProse('{"outcome":"a bare string"}')).toBeNull();
  });
});
