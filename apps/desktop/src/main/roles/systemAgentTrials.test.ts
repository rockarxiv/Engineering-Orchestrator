import { describe, expect, it } from "vitest";
import { loadRolePrompt } from "./prompts.js";

/**
 * What the system agent is taught about standing in for the person on
 * trial items (EO-585).
 *
 * The prompt is the only place the agent learns these rules: EO records
 * what it presses as its own and refuses a result that needs a reason
 * without one, but whether it presses every result, where its answers
 * come from, and what it does with a request for more are its judgement,
 * and this is what that judgement is given.
 */

const prompt = loadRolePrompt("system")!;

function section(heading: string): string {
  const start = prompt.indexOf(heading);
  expect(start).toBeGreaterThan(-1);
  const next = /\n#{1,3} /.exec(prompt.slice(start + 1));
  return (next ? prompt.slice(start, start + 1 + next.index) : prompt.slice(start)).replace(/\s+/g, " ");
}

describe("what the system agent's prompt says about standing in for the person on trial items", () => {
  const trials = () => section("### Standing in for the person on trial items");

  it("says how it presses and answers, and that EO records it as itself, never as the person", () => {
    expect(trials()).toContain("`item_decide`");
    expect(trials()).toContain("`comment_post`");
    expect(trials()).toContain("`parentId`");
    expect(trials()).toContain("on the person's behalf, on a trial");
    expect(trials()).toContain("Never as the person");
  });

  it("presses every declared result at least once, writing a comment where the result requires one", () => {
    expect(trials()).toContain("**Press every declared result.**");
    expect(trials()).toContain("press each result a person step declares at least once");
    expect(trials()).toContain("Where a result requires a comment, write one");
  });

  it("answers only from what the person said, the test items and the repository, and asks the person otherwise", () => {
    expect(trials()).toContain("only from what the person told you in the conversation, the test items themselves and the repository");
    expect(trials()).toContain("ask the person");
  });

  it("never supplies a credential", () => {
    expect(trials()).toContain("**Never supply a credential.**");
  });

  it("takes a request for tools, a wider grant or a secret to the person and never grants it itself", () => {
    expect(trials()).toContain("asks for more tools, a wider grant, a secret");
    expect(trials()).toContain("Take it to the person");
    expect(trials()).toContain("never grant it yourself");
  });

  it("is a new version of the prompt", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(33);
  });
});
