import { describe, expect, it } from "vitest";
import { BUILTIN_ACTIONS, BUILTIN_RESULTS } from "@eo/core";
import { loadRolePrompt } from "./prompts.js";

/**
 * What the system agent is told about whose pull request comments are
 * acted on (EO-763). Template 1.4 sends the signed-in account's comments
 * to the implementer and everyone else's to the Pull request comments
 * board, and replies on the pull request; an agent drafting or repairing
 * Delivery learns that routing only from its prompt, and a draft that sent
 * other accounts' comments to the implementer would let anyone who can
 * comment instruct it.
 */

const flat = loadRolePrompt("system")!.replace(/\s+/g, " ");

/** From the paragraph about the watch's results to the next section. */
function routing(): string {
  const start = flat.indexOf("Its results are `merged`");
  expect(start).toBeGreaterThan(-1);
  return flat.slice(start, flat.indexOf("What `ready` means", start));
}

describe("what the system agent's prompt says about pull request comments", () => {
  it("lists every built-in function EO ships as the only ones there are", () => {
    const sentence = flat.slice(flat.indexOf("The only built-in functions are"), flat.indexOf("Any other name is a step that can never run"));
    for (const action of BUILTIN_ACTIONS) expect(sentence).toContain(`\`${action}\``);
  });

  it("names every result of the watch, and says whose comment each is", () => {
    const text = routing();
    for (const result of BUILTIN_RESULTS.watch_pull_request) expect(text).toContain(`\`${result}\``);
    expect(text).toContain("`author_commented` is a comment, review or request for changes by the account EO is signed in to the forge with");
    expect(text).toContain("`changes_requested` and `others_commented` are a request for changes and a comment by any other account");
  });

  it("routes the person's comments to the implementer, and other accounts' to the Pull request comments board", () => {
    const text = routing();
    expect(text).toContain("`conflict`, `checks_failed` and `author_commented` to the step the implementer owns");
    expect(text).toContain("`changes_requested` and `others_commented` to the Plan response step of the Pull request comments board");
    expect(text).toContain("never straight to the implementer");
  });

  it("says where the reply step goes and where each of its results routes", () => {
    const text = routing();
    for (const result of BUILTIN_RESULTS.reply_on_pull_request) expect(text).toContain(`\`${result}\``);
    expect(text).toContain("route `open_pull_request`'s `opened` to it, its `replied` and `nothing_to_reply` to the watch, and its `failed`");
  });

  it("describes the Pull request comments board's steps and where each hands the work", () => {
    const text = routing();
    expect(text).toContain("**Plan response**, the implementer's `plan_comment_response`");
    expect(text).toContain("routes `planned` to Review plan");
    expect(text).toContain("**Review plan**, the reviewer's `review_plan`, which routes `approved` to Approve plan, `changes_requested` back to Plan response and `needs_user_input` to a person");
    expect(text).toContain("Its Approve goes to Delivery's To Do");
    expect(text).toContain("Revise, with the person's reason, goes back to Plan response");
    expect(text).toContain("Reject, with the person's reason, goes to Delivery's Reply on pull request");
  });
});
