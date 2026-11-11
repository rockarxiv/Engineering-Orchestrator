import { describe, expect, it } from "vitest";
import { loadRolePrompt } from "./prompts.js";

/**
 * What the system agent is taught about `reference` on its proposals
 * (EO-739).
 *
 * The schema says the field exists; only the prompt can say when to set
 * it, that a feature's is what its stories read, and that it is neither a
 * link nor the Jira key — which a model left to guess would mix up.
 */

const prompt = loadRolePrompt("system")!;

/** The bullets under `assist` → "Proposing something", up to the next heading, flattened. */
const proposing = (() => {
  const assist = prompt.split(/^# /m).find((part) => part.startsWith("What to build"))!;
  const heading = "### Proposing something";
  const rest = assist.slice(assist.indexOf(heading) + heading.length);
  const end = rest.search(/^#{2,3} /m);
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, " ");
})();

describe("what the system agent's prompt says about reference on a proposal", () => {
  it("says when to set it, and never to invent one", () => {
    expect(proposing).toContain("**`reference` is for when the person names an outside ticket the work belongs to**");
    expect(proposing).toContain("Never invent one.");
  });

  it("puts a plan's on the feature, which its stories inherit, and lets a single story or bug carry its own", () => {
    expect(proposing).toContain("On a `new_feature` it goes on the feature, top-level, and every story under it inherits it");
    expect(proposing).toContain("On a `new_story` or `new_bug` it goes on that ticket, when it has one of its own");
  });

  it("says it is a label, not a link, nor the Jira key", () => {
    expect(proposing).toContain("EO never sends it to Jira or any other tracker, any number of tickets may share it, and it has to fit in a git branch name");
    expect(proposing).toContain("It is not the Jira key, which only one item may hold.");
  });

  it("points at item_update once the work exists", () => {
    expect(proposing).toContain("Once a ticket exists, `reference` on `item_update`, on `eo_admin`, sets it, or clears it with `null`.");
  });

  it("is a newer version than the one before proposals carried a reference", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(49);
  });
});
