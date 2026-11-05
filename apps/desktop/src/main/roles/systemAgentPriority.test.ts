import { describe, expect, it } from "vitest";
import { loadRolePrompt } from "./prompts.js";

/**
 * What the system agent is taught about `priority` on its proposals
 * (EO-568).
 *
 * The schema says the field exists and its description says which way it
 * sorts; only the prompt can say when to set it, and that a feature's is
 * not handed to its stories — which a model left to guess would assume.
 */

const prompt = loadRolePrompt("system")!;
const flat = prompt.replace(/\s+/g, " ");

describe("what the system agent's prompt says about priority on a proposal", () => {
  it("names every proposal that takes one", () => {
    expect(flat).toContain(
      "**`priority` says how soon work is picked up**, on `new_feature`, on each story inside it, on `new_story`, on `new_bug` and on `amend`.",
    );
  });

  it("says what the numbers mean and what leaving it out does", () => {
    expect(flat).toContain("It is an integer, 0 or more, and the scheduler picks the highest first: 0 is Normal, 1 High, 2 Urgent.");
    expect(flat).toContain("Left out, a new ticket is 0.");
  });

  it("says a story does not inherit its feature's", () => {
    expect(flat).toContain("so a story you send without one is 0 however urgent its feature is");
  });

  it("is a newer version than the one before proposals carried a priority", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(31);
  });
});
