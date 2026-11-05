import { describe, expect, it } from "vitest";
import { loadRolePrompt } from "./prompts.js";

/**
 * The rooms the system agent's prompt describes, after Discussions and
 * the Architecture panel went (EO-526).
 *
 * The prompt is the only place the agent learns which room it is in and
 * what each asks of it. A prompt still describing two rooms nobody can
 * open would teach it `discuss` and `configure` turns that never come,
 * while the asking and proposing rules the assistant relies on lived
 * under `## discuss` — so those had to move with the room, not go with
 * the heading.
 */

const prompt = loadRolePrompt("system")!;

/** From a top-level `##` heading to the next heading of the same or higher level. */
function section(heading: string): string {
  const start = prompt.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const next = /\n#{1,2} /.exec(prompt.slice(start + 1));
  return next ? prompt.slice(start, start + 1 + next.index) : prompt.slice(start);
}

/** From a `###` heading to the next heading of any level. */
function subsection(heading: string): string {
  const start = prompt.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const next = /\n#{1,3} /.exec(prompt.slice(start + 1));
  return next ? prompt.slice(start, start + 1 + next.index) : prompt.slice(start);
}

describe("the system agent's prompt, without Discussions or the Architecture panel", () => {
  it("names neither room anywhere", () => {
    expect(prompt).not.toMatch(/Discussions/);
    expect(prompt).not.toMatch(/Architecture panel/i);
    expect(prompt).not.toMatch(/architect panel/i);
  });

  it("lists no `discuss` or `configure` action among the ones it is dispatched on, and lists `assist`", () => {
    const table = prompt.slice(0, prompt.indexOf("\n## "));
    expect(table).toContain("| `assist` |");
    expect(table).not.toContain("| `discuss` |");
    expect(table).not.toContain("| `configure` |");
    expect(prompt).not.toMatch(/^## (discuss|configure)$/m);
  });

  it("keeps the asking and proposing rules, under the assistant", () => {
    const assist = section("## assist");
    // How to ask: open questions in the message, a choice on a card.
    expect(assist).toContain("### Asking, here");
    expect(subsection("### Asking, here")).toContain("**An open question goes in `message`.**");
    expect(subsection("### Asking, here")).toContain("**`questions` is for a choice you can enumerate.**");
    // How to propose: the actions a card can carry, and the rules on them.
    expect(assist).toContain("### Proposing something");
    const proposing = subsection("### Proposing something");
    for (const action of ["new_feature", "new_story", "new_bug", "amend", "reorder"]) expect(proposing, action).toContain(`\`${action}\``);
    expect(proposing).toContain("**`pipeline` says where new work flows**");
  });

  it("keeps the rules a pipeline draft is held to, under a heading that names no retired action", () => {
    const drafts = section("## Pipeline drafts");
    expect(drafts).toContain("### The rules a graph must satisfy");
    expect(drafts).toContain("### Drafts from the assistant's chat");
    expect(drafts).toContain("You propose; they publish.");
  });

  it("is a newer version than the prompt that described the two rooms", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(28);
  });
});
