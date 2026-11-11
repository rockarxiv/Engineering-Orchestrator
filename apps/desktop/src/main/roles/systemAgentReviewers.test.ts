import { describe, expect, it } from "vitest";
import { loadRolePrompt } from "./prompts.js";

/**
 * What the system agent is taught about `reviewers` on its proposals,
 * and what modules read of them (EO-743).
 *
 * The schema says the field exists; only the prompt can say when to set
 * it, that it replaces the repository's default, and that a feature's is
 * what its stories read.
 */

const prompt = loadRolePrompt("system")!;
const flat = prompt.replace(/\s+/g, " ");

/** The bullets under `assist` → "Proposing something", up to the next heading, flattened. */
const proposing = (() => {
  const assist = prompt.split(/^# /m).find((part) => part.startsWith("What to build"))!;
  const heading = "### Proposing something";
  const rest = assist.slice(assist.indexOf(heading) + heading.length);
  const end = rest.search(/^#{2,3} /m);
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, " ");
})();

describe("what the system agent's prompt says about reviewers on a proposal", () => {
  it("says to set them only when the person names who should review, and never to invent them", () => {
    expect(proposing).toContain("**`reviewers` is for when the person names who should review the work**");
    expect(proposing).toContain("Never invent them.");
  });

  it("says they replace the repository's default, that stories inherit the feature's, and that [] is nobody", () => {
    expect(proposing).toContain("They replace the repository's default reviewers rather than adding to them.");
    expect(proposing).toContain("On a `new_feature` they go on the feature, top-level, and every story under it inherits them");
    expect(proposing).toContain("`[]` means nobody is asked");
  });

  it("points at item_update once the work exists", () => {
    expect(proposing).toContain(
      "Once a ticket exists, `reviewers` on `item_update`, on `eo_admin`, sets them, empties them with `[]`, or clears them with `null`",
    );
  });

  it("is a newer version than the one before proposals carried reviewers", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(50);
  });
});

describe("what the system agent's module docs say about reviewers", () => {
  it("lists both among the git fields ctx.item() answers with", () => {
    expect(flat).toContain("attachedAt, pullRequest, reference, targetBranch, reviewers, pullRequestReviewers }");
  });

  it("says the first is as stored and the second is what the pull request step will request", () => {
    expect(flat).toContain("`reviewers` is the ticket's own list as stored — null when it inherits, `[]` when it is set to nobody");
    expect(flat).toContain(
      "`pullRequestReviewers` is the list the pull request step will request: the ticket's own, else its feature's, else the repository's default.",
    );
  });
});
