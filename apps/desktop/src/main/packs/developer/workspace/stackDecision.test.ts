import { gitExtension, jiraExtension, type Item, type Uuid } from "@eo/core";
import { describe, expect, it } from "vitest";
import { readStackAnswer, resolveStackTarget, stacksOn, type StackDependency } from "./stackDecision.js";


/** Any `item_types` row: these fixtures never read the type's row, only the word on it. */
const STORY_TYPE_ID = "0199aa00-0000-7000-8000-000000000001" as Uuid;
function makeItem(id: string, overrides: Partial<Item> = {}): Item {
  return {
    id: id as Uuid,
    key: `EO-${id}`,
    typeId: STORY_TYPE_ID,
    type: "story",
    typeLabel: "Story",
    container: false,
    parentId: null,
    workspaceId: null,
    projectId: null,
    title: id,
    body: null,
    spec: null,
    pipelineId: "p1" as Uuid,
    stepId: "todo",
    pipelineVersionId: null,
    priority: 0,
    extensions: {},
    archivedAt: null,
    heldAt: null,
    previewAt: null,
    trialAt: null,
    createdBy: null,
    assigneeId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function dep(item: Item, mergeState: StackDependency["mergeState"]): StackDependency {
  return { item, branch: `eo/${item.key}`, mergeState };
}

describe("resolveStackTarget", () => {
  const feature = "feature-1" as Uuid;
  const story = makeItem("3", { parentId: feature });

  it("targets the base branch when there are no same-feature dependencies", () => {
    expect(resolveStackTarget(story, [])).toEqual({ kind: "base" });
  });

  it("targets the base branch when the one same-feature dependency is merged", () => {
    const depItem = makeItem("2", { parentId: feature });
    expect(resolveStackTarget(story, [dep(depItem, "merged")])).toEqual({ kind: "base" });
  });

  it("cuts from the base a person set on the item, over a dependency it would otherwise stack on (EO-364)", () => {
    const named = makeItem("3", { parentId: feature, extensions: gitExtension({ baseBranch: "release/2.4" }) });
    const depItem = makeItem("2", { parentId: feature });
    expect(resolveStackTarget(named, [dep(depItem, "open")])).toEqual({ kind: "named-base", branch: "release/2.4" });
  });

  it("does not escalate over a closed dependency when a person has already said where to cut from (EO-364)", () => {
    // The escalation is EO refusing to guess. With a base set there is
    // nothing to guess, and no answer to a tie would outrank it either.
    const named = makeItem("3", { parentId: feature, extensions: gitExtension({ baseBranch: "release/2.4" }) });
    const closed = makeItem("2", { parentId: feature });
    expect(resolveStackTarget(named, [dep(closed, "closed")], { kind: "branch", branch: "other" })).toEqual({ kind: "named-base", branch: "release/2.4" });
  });

  it("stacks on the one same-feature dependency that is still open", () => {
    const depItem = makeItem("2", { parentId: feature });
    const decision = resolveStackTarget(story, [dep(depItem, "open")]);
    expect(decision).toEqual({ kind: "stack", dependency: depItem, branch: `eo/${depItem.key}` });
  });

  it("escalates when the one same-feature dependency was closed without merging", () => {
    const depItem = makeItem("2", { parentId: feature });
    const decision = resolveStackTarget(story, [dep(depItem, "closed")]);
    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toContain("EO-2");
    expect(decision.reason).toContain("closed without merging");
  });

  it("escalates naming only the closed dependency when others are open or merged", () => {
    const closed = makeItem("2", { parentId: feature });
    const open = makeItem("4", { parentId: feature });
    const merged = makeItem("5", { parentId: feature });
    const decision = resolveStackTarget(story, [dep(closed, "closed"), dep(open, "open"), dep(merged, "merged")]);
    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toContain("EO-2");
    expect(decision.reason).not.toContain("EO-4");
    expect(decision.reason).not.toContain("EO-5");
  });

  it("escalates naming all of them when two or more same-feature dependencies are open at once", () => {
    const first = makeItem("2", { parentId: feature });
    const second = makeItem("4", { parentId: feature });
    const decision = resolveStackTarget(story, [dep(first, "open"), dep(second, "open")]);
    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toContain("EO-2");
    expect(decision.reason).toContain("EO-4");
  });

  it("ignores a dependency edge whose item does not share the dependent's non-null parentId", () => {
    const otherFeature = "feature-2" as Uuid;
    const outOfScope = makeItem("9", { parentId: otherFeature });
    // Not treated as merged (which would also yield "base") — the point
    // is it is excluded from consideration, provable by pairing it with
    // an in-scope open dependency and checking that dependency wins.
    const inScope = makeItem("2", { parentId: feature });
    const decision = resolveStackTarget(story, [dep(outOfScope, "closed"), dep(inScope, "open")]);
    expect(decision).toEqual({ kind: "stack", dependency: inScope, branch: `eo/${inScope.key}` });
  });

  it("ignores a same-repository dependency whose parentId is null (no parent feature at all)", () => {
    const noParent = makeItem("9", { parentId: null });
    const decision = resolveStackTarget(story, [dep(noParent, "closed")]);
    expect(decision).toEqual({ kind: "base" });
  });
});

/**
 * Two unmerged dependencies are only a tie when neither one already
 * contains the other. C depending on A and B, where B depends on A, is a
 * chain wearing a tie's clothes: B's branch was cut from A's, so
 * stacking on B stacks on both, and there is nothing for a person to
 * decide.
 */
describe("resolveStackTarget — a dependency that already builds on the others", () => {
  const feature = "feature-1" as Uuid;
  const story = makeItem("3", { parentId: feature });

  it("stacks on the dependency that transitively depends on the other one", () => {
    const first = makeItem("1", { parentId: feature });
    const second = makeItem("2", { parentId: feature });

    const decision = resolveStackTarget(story, [
      { ...dep(first, "open"), dependsOn: [] },
      { ...dep(second, "open"), dependsOn: [first.id] },
    ]);

    expect(decision).toEqual({ kind: "stack", dependency: second, branch: `eo/${second.key}` });
  });

  it("follows the chain through an item that is not itself a dependency of the dependent", () => {
    // C depends on A and D; D depends on B, which depends on A. Nothing
    // between A and D is a direct dependency of C, but D's branch still
    // contains A's work.
    const a = makeItem("1", { parentId: feature });
    const b = makeItem("2", { parentId: feature });
    const d = makeItem("4", { parentId: feature });

    const decision = resolveStackTarget(story, [
      { ...dep(a, "open"), dependsOn: [] },
      { ...dep(d, "open"), dependsOn: [b.id, a.id] },
    ]);

    expect(decision).toEqual({ kind: "stack", dependency: d, branch: `eo/${d.key}` });
  });

  it("still escalates when the unmerged dependencies are genuine siblings", () => {
    const first = makeItem("1", { parentId: feature });
    const second = makeItem("2", { parentId: feature });

    const decision = resolveStackTarget(story, [
      { ...dep(first, "open"), dependsOn: [] },
      { ...dep(second, "open"), dependsOn: [] },
    ]);

    expect(decision.kind).toBe("escalate");
  });

  it("escalates when one dependency covers only some of the others", () => {
    const a = makeItem("1", { parentId: feature });
    const b = makeItem("2", { parentId: feature });
    const c = makeItem("5", { parentId: feature });

    const decision = resolveStackTarget(story, [
      { ...dep(a, "open"), dependsOn: [] },
      { ...dep(b, "open"), dependsOn: [a.id] },
      { ...dep(c, "open"), dependsOn: [] },
    ]);

    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    // All three remain on offer: B covers A, but nothing covers C, so
    // the person is choosing between all of them, not a shortlist.
    expect(decision.choices.map((choice) => choice.key)).toEqual(["EO-1", "EO-2", "EO-5"]);
  });

  it("stacks on the one dependency covering all others when there are three", () => {
    const a = makeItem("1", { parentId: feature });
    const b = makeItem("2", { parentId: feature });
    const c = makeItem("5", { parentId: feature });

    const decision = resolveStackTarget(story, [
      { ...dep(a, "open"), dependsOn: [] },
      { ...dep(b, "open"), dependsOn: [a.id] },
      { ...dep(c, "open"), dependsOn: [b.id, a.id] },
    ]);

    expect(decision).toEqual({ kind: "stack", dependency: c, branch: `eo/${c.key}` });
  });
});

/**
 * The tie is the one decision EO asks a person to make, so the
 * escalation has to be answerable: it names what it will accept, and an
 * answer already given resolves it instead of producing the same
 * question again. Replying "EO-32" and getting the original escalation
 * back verbatim is the behaviour this covers.
 */
describe("resolveStackTarget — answering a tie", () => {
  const feature = "feature-1" as Uuid;
  const story = makeItem("3", { parentId: feature });
  const first = makeItem("1", { parentId: feature });
  const second = makeItem("2", { parentId: feature });
  const tie = [dep(first, "open"), dep(second, "open")];

  it("offers the tied dependencies as the answers, and says a branch will do too", () => {
    const decision = resolveStackTarget(story, tie);
    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;

    expect(decision.choices).toEqual([first, second]);
    expect(decision.reason).toContain("EO-1 or EO-2");
    expect(decision.reason).toContain("branch");
  });

  it("stacks on the dependency a person named", () => {
    const decision = resolveStackTarget(story, tie, { kind: "dependency", key: "EO-2" });
    expect(decision).toEqual({ kind: "stack", dependency: second, branch: `eo/${second.key}` });
  });

  it("targets the branch a person named instead", () => {
    const decision = resolveStackTarget(story, tie, { kind: "branch", branch: "release/24.3" });
    expect(decision).toEqual({ kind: "branch", branch: "release/24.3" });
  });

  it("quotes back a reply it could not use, rather than repeating the question", () => {
    const decision = resolveStackTarget(story, tie, { kind: "unusable", answer: "whichever", problem: "it names neither." });
    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toContain(`EO could not use "whichever"`);
    expect(decision.reason).toContain("it names neither.");
  });

  it("says so when the named dependency is not one of the tied ones", () => {
    const decision = resolveStackTarget(story, tie, { kind: "dependency", key: "EO-9" });
    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toContain(`EO could not use "EO-9"`);
  });

  it("never lets an answer override a decision EO can make on its own", () => {
    // One dependency merged, one still open: not a tie, so the answer is
    // beside the point — a merged dependency's branch is not a target
    // whoever asked for it.
    const decision = resolveStackTarget(story, [dep(first, "merged"), dep(second, "open")], { kind: "dependency", key: "EO-1" });
    expect(decision).toEqual({ kind: "stack", dependency: second, branch: `eo/${second.key}` });
  });

  it("does not accept an answer to the tie as an answer about a closed dependency", () => {
    const decision = resolveStackTarget(story, [dep(first, "closed"), dep(second, "open")], { kind: "branch", branch: "main" });
    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toContain("closed without merging");
    // No buttons on a question EO is not asking.
    expect(decision.choices).toEqual([]);
  });
});

describe("readStackAnswer", () => {
  const feature = "feature-1" as Uuid;
  const first = makeItem("31", { parentId: feature, extensions: gitExtension({ branch: "eo/EO-31" }) });
  const second = makeItem("32", { parentId: feature, extensions: gitExtension({ branch: "eo/EO-32" }) });
  const choices = [first, second];

  it("reads a bare key", () => {
    expect(readStackAnswer("EO-32", choices)).toEqual({ kind: "dependency", key: "EO-32" });
  });

  it("reads a key out of a sentence", () => {
    expect(readStackAnswer("let's go with EO-32 please", choices)).toEqual({ kind: "dependency", key: "EO-32" });
  });

  it("does not match a shorter key inside a longer one", () => {
    const short = makeItem("3", { parentId: feature });
    expect(readStackAnswer("EO-32", [short, second])).toEqual({ kind: "dependency", key: "EO-32" });
  });

  it("reads a dependency named by its branch", () => {
    expect(readStackAnswer("eo/EO-31", choices)).toEqual({ kind: "dependency", key: "EO-31" });
  });

  it("reads a dependency named by its linked Jira key", () => {
    const linked = makeItem("31", { parentId: feature, extensions: jiraExtension({ key: "KAN-99" }) });
    expect(readStackAnswer("KAN-99", [linked])).toEqual({ kind: "dependency", key: "EO-31" });
  });

  it("reads a branch name, backticks and all", () => {
    expect(readStackAnswer("`release/24.3`", choices)).toEqual({ kind: "branch", branch: "release/24.3" });
  });

  it("refuses to choose when a reply names two of them", () => {
    const answer = readStackAnswer("EO-31 and then EO-32", choices);
    expect(answer?.kind).toBe("unusable");
    if (answer?.kind !== "unusable") return;
    expect(answer.problem).toContain("exactly one");
  });

  it("treats an item-shaped answer that is not on offer as a mistyped choice, not a branch", () => {
    expect(readStackAnswer("EO-99", choices)).toEqual({ kind: "dependency", key: "EO-99" });
  });

  it("cannot use a sentence that names nothing", () => {
    const answer = readStackAnswer("do whatever you think is best", choices);
    expect(answer?.kind).toBe("unusable");
  });

  it("cannot use something git would never accept as a ref", () => {
    expect(readStackAnswer("feat/..oops", choices)?.kind).toBe("unusable");
    expect(readStackAnswer("feat/x.lock", choices)?.kind).toBe("unusable");
  });

  it("says nothing at all about an empty reply", () => {
    expect(readStackAnswer("   ", choices)).toBeNull();
  });
});

describe("which edges stack (EO-780)", () => {
  const repository = "workspace-1" as Uuid;
  const featureA = "feature-a" as Uuid;
  const featureB = "feature-b" as Uuid;
  const child = makeItem("20", { parentId: featureB, workspaceId: repository });

  it("stacks a reached edge on an unmerged dependency in the same repository, in another feature", () => {
    const dependency = makeItem("12", { parentId: featureA, workspaceId: repository });
    expect(stacksOn(child, dependency, "reached")).toBe(true);
    expect(resolveStackTarget(child, [{ ...dep(dependency, "open"), wait: "reached" }])).toEqual({ kind: "stack", dependency, branch: "eo/EO-12" });
  });

  it("stacks a reached edge with no feature on either side, and never across repositories", () => {
    const orphan = makeItem("21", { workspaceId: repository });
    expect(stacksOn(orphan, makeItem("12", { workspaceId: repository }), "reached")).toBe(true);
    expect(stacksOn(child, makeItem("12", { parentId: featureB, workspaceId: "workspace-2" as Uuid }), "reached")).toBe(false);
  });

  it("never stacks a none edge, even on an unmerged dependency in the same feature", () => {
    const dependency = makeItem("12", { parentId: featureB, workspaceId: repository });
    expect(stacksOn(child, dependency, "none")).toBe(false);
    expect(resolveStackTarget(child, [{ ...dep(dependency, "open"), wait: "none" }])).toEqual({ kind: "base" });
  });

  it("keeps the same-feature rule for finished, which is also what an absent rule means", () => {
    expect(stacksOn(child, makeItem("12", { parentId: featureB, workspaceId: repository }), "finished")).toBe(true);
    expect(stacksOn(child, makeItem("12", { parentId: featureA, workspaceId: repository }), "finished")).toBe(false);
    expect(resolveStackTarget(child, [dep(makeItem("12", { parentId: featureA, workspaceId: repository }), "open")])).toEqual({ kind: "base" });
  });
});
