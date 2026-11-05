import { describe, expect, it } from "vitest";
import { stripFieldTagBleed, validateActionResult } from "./index.js";
import { developerRegistry } from "../registry/developer.js";

// The registry as EO ships it (KAN-124): every lookup here is asked about
// the developer pack, which is the one whose schemas these tests are about.
const registry = developerRegistry();

/**
 * Scaffolding a model leaves inside its own answer (KAN-23).
 *
 * The real sighting, from a live run: a `refine` result whose
 * `understanding` ended with `</understanding>\n</invoke>` inside the
 * JSON string. It validated — a string is a string — and went on to a
 * human's thread and the next agent's context.
 *
 * The whole safety of removing it rests on the tag name matching the
 * field's own key, so these cases are mostly about what must *survive*.
 */
describe("stripping a field's own closing tag", () => {
  it("removes the exact thing that was seen in the wild", () => {
    const seen = "...so no question was posted to @user.</understanding>\n</invoke>\n";

    expect(stripFieldTagBleed("understanding", seen)).toBe("...so no question was posted to @user.");
  });

  it("removes the tag on its own, without the outer one", () => {
    expect(stripFieldTagBleed("summary", "Did the work.</summary>")).toBe("Did the work.");
  });

  it("leaves a tag that is not the field's own name", () => {
    // The load-bearing case. A reviewer quoting markup ends in `</div>`
    // for good reasons, and no schema field is called `div`.
    expect(stripFieldTagBleed("feedback", "Wrap the row in </div>")).toBe("Wrap the row in </div>");
  });

  it("leaves a matching tag that is not at the end", () => {
    // Mid-string it is content, not scaffolding.
    const body = "The `</summary>` element closes a disclosure, and that matters here.";

    expect(stripFieldTagBleed("summary", body)).toBe(body);
  });

  it("leaves prose that merely mentions the field name", () => {
    expect(stripFieldTagBleed("understanding", "My understanding is complete.")).toBe("My understanding is complete.");
  });

  it("does not touch an empty or tagless value", () => {
    expect(stripFieldTagBleed("summary", "")).toBe("");
    expect(stripFieldTagBleed("summary", "Plain text.")).toBe("Plain text.");
  });
});

describe("validated results", () => {
  it("hands the engine the cleaned value", () => {
    const result = validateActionResult(registry, "refine", { ready: true, understanding: "It is clear.</understanding>" }, registry.itemTypes.get("developer:story"));

    expect(result.ok).toBe(true);
    expect(result.ok && (result.value as { understanding: string }).understanding).toBe("It is clear.");
  });

  it("cleans an action that has no schema at all", () => {
    // Invariant 7: a pipeline may define an action this map never heard
    // of. It still gets a result read by humans and agents.
    const result = validateActionResult(registry, "some_custom_action", { note: "done</note>" });

    expect(result.ok && (result.value as { note: string }).note).toBe("done");
  });

  it("leaves a well-formed result identical", () => {
    const clean = { branch: "eo/EO-1", summary: "Did the work.", files_changed: ["src/a.ts"], tests_run: true, handoff: "Nothing surprising." };

    const result = validateActionResult(registry, "implement", clean);

    expect(result.ok && result.value).toEqual(clean);
  });
});
