import { describe, expect, it } from "vitest";
import { AssistDraftStepSchema } from "@eo/core";
import { loadRolePrompt } from "./prompts.js";

/**
 * What the system agent is told about who runs a step (EO-876): a step
 * names an agent, by its name, and the agent is of a kind whose actions
 * the step's action must be one of. Before this the prompt said an agent
 * step "carries an `ownerRole`", and a draft named a role.
 */

const prompt = loadRolePrompt("system")!;
const flat = prompt.replace(/\s+/g, " ");

describe("what the system agent's prompt says about a step's agent", () => {
  it("is a newer version than the prompt whose steps named roles", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(64);
  });

  it("says an agent step names its agent by name, and that the agent is of a kind", () => {
    expect(flat).toContain("**`agent`** carries an `agent` and an `entryAction` and carries no others.");
    expect(flat).toContain("`agent` is the name of the agent that runs the step, exactly as `agents_list` and the Agents screen show it");
    expect(flat).toContain("Every agent is of a **kind**");
    expect(flat).toContain("the step's `entryAction` must be one of that kind's actions");
  });

  it("says which agents a step may name, and what is refused", () => {
    expect(flat).toContain("A name nobody has, another project's agent, or an agent whose kind has no such action is refused, in the words Publish would use.");
  });

  it("no longer says a step carries a role or is owned by one", () => {
    expect(flat).not.toContain("carries an `ownerRole`");
    expect(flat).not.toMatch(/step owned by/);
    expect(flat).not.toContain("which role owns");
  });

  it("matches the draft it describes: a step names `agent`, not `ownerRole`", () => {
    expect(Object.keys(AssistDraftStepSchema.shape)).toContain("agent");
    expect(Object.keys(AssistDraftStepSchema.shape)).not.toContain("ownerRole");
  });
});
