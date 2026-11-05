import { describe, expect, it } from "vitest";
import { developerRegistry } from "../registry/developer.js";
import { resultSchemaFor, validateActionResult } from "./index.js";
import { ScenarioOutputSchema } from "./scenario.js";

/**
 * What a turn of a module's scenario chat may hand back (EO-356).
 */
const registry = developerRegistry();

const question = { id: "q1", question: "Which is wrong?", why: "It decides what gets fixed.", options: ["The test", "The module"] };
const diagnosis = { scripted: ["gh pr checks 12"], made: ["gh pr view 12"], lines: [{ from: 3, to: 5 }] };

describe("ScenarioOutputSchema", () => {
  it("accepts a turn that only talks, and reads every absent field as none", () => {
    const parsed = ScenarioOutputSchema.safeParse({ message: "Which exit code does gh give when CI is pending?" });
    expect(parsed.success && parsed.data).toEqual({ message: "Which exit code does gh give when CI is pending?", questions: [], testId: null, diagnosis: null, change: null });
  });

  it("accepts null for every optional part, which is how a strict backend says none", () => {
    // Codex is held to the strict subset where every property is
    // required; an optional `change` would be a change on every turn.
    const parsed = ScenarioOutputSchema.safeParse({ message: "Passed.", questions: [], testId: "t-1", diagnosis: null, change: null });
    expect(parsed.success).toBe(true);
  });

  it("accepts a failure reported with its evidence and a question", () => {
    expect(ScenarioOutputSchema.safeParse({ message: "It failed.", testId: "t-1", diagnosis, questions: [question] }).success).toBe(true);
  });

  it("refuses a diagnosis that names no test case", () => {
    expect(ScenarioOutputSchema.safeParse({ message: "It failed.", diagnosis }).success).toBe(false);
  });

  it("refuses a change and a question in one turn", () => {
    const parsed = ScenarioOutputSchema.safeParse({ message: "Here.", questions: [question], change: { summary: "Retry.", code: "export default async () => ({ ok: true, result: 'merged' })" } });
    expect(parsed.success).toBe(false);
  });

  it("refuses a change that carries no code", () => {
    expect(ScenarioOutputSchema.safeParse({ message: "Here.", change: { summary: "Retry.", code: "" } }).success).toBe(false);
  });

  it("is the schema the developer pack holds a scenario turn to", () => {
    expect(resultSchemaFor(registry, "scenario")).toBeDefined();
    expect(validateActionResult(registry, "scenario", { message: "Passed.", testId: "t-1" }).ok).toBe(true);
    expect(validateActionResult(registry, "scenario", { message: "" }).ok).toBe(false);
  });
});
