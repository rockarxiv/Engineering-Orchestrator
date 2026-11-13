import { describe, expect, it } from "vitest";
import { loadRolePrompt } from "./prompts.js";

/**
 * What the system agent is told about a dependency's wait rule (EO-777).
 * Leaving the rule out is today's behaviour, so the agent is told to set
 * one only when the person asked for it, and shown how.
 */

const prompt = loadRolePrompt("system")!;
const flat = prompt.replace(/\s+/g, " ");

describe("what the system agent's prompt says about a dependency's wait rule", () => {
  it("is a newer version than the prompt that had no rule", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(54);
  });

  it("says to leave wait out unless the person asked for something else", () => {
    expect(flat).toContain("Leave `wait` out of a dependency unless the person asked for something else.");
  });

  it("shows the object form for a plan's stories and for item_update, and updateDependsOn", () => {
    expect(flat).toContain('`{ "story": 0, "wait": "reached", "step": "Review" }`');
    expect(flat).toContain('{ "item": "EO-14", "wait": "reached", "step": "Watch merge request" }');
    expect(flat).toContain('`updateDependsOn: [{ "item": "EO-14", "wait": "none" }]`');
  });

  it("never has the agent set none on its own for work in different repositories", () => {
    expect(flat).toContain("Tickets in different repositories are a reason to *suggest* `none` to the person, never to set it yourself.");
  });
});
