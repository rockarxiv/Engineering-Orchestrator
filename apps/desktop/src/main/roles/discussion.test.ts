import { sql } from "drizzle-orm";
import { gitStateOf, EMPTY_SPEC_SHAPE, LOCAL_PERSON_ID, LOCAL_PERSON_NAME, type Agent, type DiscussionOutput, type DiscussionProposal, type DiscussionQuestion, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  addDependency,
  addWorkspaceToProject,
  createProject,
  createRun,
  projectForWorkspace,
  getItem,
  getItemType,
  getPerson,
  listAgents,
  listCommentsForItem,
  listDependencies,
  listMentionsForComment,
  listItems,
  postComment,
  syncItemTypes,
  transitionItem,
  updateRun,
} from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { archivePipeline, createPipeline, createStep, getPipeline, setEntryStep } from "../db/repos/pipelineStepsRepo.js";
import { featureIsDone, featureProgress } from "./featureLifecycle.js";
import { openAssistConversation, postAssistReply } from "./assist.js";
import { ASSIST_ACTION } from "./conversationSteps.js";
import { applyDiscussionProposal, describeProposal, proposedPipelineProblem, resolvePlacement, summariseProposal } from "./discussion.js";
import { PROPOSAL_KIND } from "./proposal.js";

let handle: DbHandle;
let po: Agent;
let conversation: Item;

beforeEach(() => {
  handle = openMigratedTestDb();
  po = listAgents(handle.db).find((agent) => agent.role === "system")!;
  conversation = openAssistConversation(handle.db, null);
});

afterEach(() => {
  handle.close();
});

/**
 * Runs one turn of the conversation: records a succeeded `assist` run
 * carrying `output`, then posts what it came back with — the same two
 * steps the supervisor and `wiring.ts` take between them.
 */
function turn(output: DiscussionOutput): { proposalIds: Uuid[] } {
  const run = createRun(handle.db, { itemId: conversation.id, agentId: po.id, action: ASSIST_ACTION });
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(output), parsed: output } });
  postAssistReply(handle.db, conversation, po.id, run.id, output);

  return {
    proposalIds: listCommentsForItem(handle.db, conversation.id)
      .filter((comment) => comment.runId === run.id && comment.kind === PROPOSAL_KIND)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .map((comment) => comment.id),
  };
}

function says(message: string, ...proposals: DiscussionProposal[]): DiscussionOutput {
  return { message, questions: [], proposals };
}

function asks(message: string, ...questions: DiscussionQuestion[]): DiscussionOutput {
  return { message, questions, proposals: [] };
}

const question = (id: string, extra: Partial<DiscussionQuestion> = {}): DiscussionQuestion => ({
  id,
  question: `Is ${id} per key or per account?`,
  why: `The storage differs, and ${id} decides it.`,
  options: ["per key", "per account"],
  ...extra,
});

function apply(proposalId: Uuid) {
  return applyDiscussionProposal(handle.db, conversation, proposalId);
}

const story = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  body: `${title} body`,
  acceptance_criteria: [`${title} works`],
  depends_on: [],
  touches: [],
  ...extra,
});

/**
 * What `discussion.ts` keeps after EO-526 is the work half: posting a
 * turn's questions, rendering and applying the work it proposes. Its own
 * room is gone, so every turn here is the assistant's — the room these
 * functions serve now, through `postAssistReply`.
 */
describe("the conversation itself", () => {
  it("is off the project and carries no branch or worktree of its own", () => {
    expect(conversation.stepId).toBe("assist");
    expect(conversation.key.startsWith("ASK-")).toBe(true);
    // Feature-typed deliberately: that is what earns it `cwd = repoPath`
    // with no worktree, no branch and no pull request.
    expect(conversation.type).toBe("feature");
    expect(gitStateOf(conversation).branch).toBeNull();
  });

  it("does not burn work key numbers", () => {
    const work = createTestItem(handle.db, { type: "story", title: "Real work", stepId: "todo" });
    expect(work.key).toBe("EO-1"); // not EO-2, despite the conversation existing first
  });
});

describe("what the product owner said", () => {
  it("posts the message and mentions nobody", () => {
    turn(says("The limiter is keyed on the API key today."));

    const [comment] = listCommentsForItem(handle.db, conversation.id);
    expect(comment?.body).toBe("The limiter is keyed on the API key today.");
    expect(comment?.kind).toBe("note");
    // Load-bearing: a human mention would put every chat message in the
    // Inbox and light `!` on an item nobody can see.
    expect(listCommentsForItem(handle.db, conversation.id).every((entry) => entry.kind !== "escalation")).toBe(true);
  });

  it("summons nobody even when the agent writes @user into its own prose", () => {
    // Observed, not hypothetical: a product owner opened with "@user I'm
    // ready—what feature are you considering?". The body parser turned
    // that into an open human mention, which is an Inbox entry and an `!`
    // on an item nobody can open — the exact thing this path mentions
    // nobody in order to avoid.
    turn(says("@user I'm ready — what feature are you considering?"));

    const [comment] = listCommentsForItem(handle.db, conversation.id);
    expect(listMentionsForComment(handle.db, comment!.id)).toEqual([]);
    // The text is left exactly as it was said. The record is not ours to
    // rewrite; it simply does not summon anyone.
    expect(comment?.body).toContain("@user");
  });

  it("posts each proposal as its own approvable comment", () => {
    const { proposalIds } = turn(
      says(
        "Two things follow.",
        { action: "new_bug", title: "Retry storm", body: "b", steps_to_reproduce: "s", expected: "e", actual: "a", environment: "env", acceptance_criteria: [] },
        { action: "new_story", title: "Back off", body: "b", acceptance_criteria: ["it backs off"], depends_on: [], touches: [] },
      ),
    );

    expect(proposalIds).toHaveLength(2);
  });
});

describe("what the product owner asked", () => {
  it("posts every question of a turn, one comment each, carrying its options", () => {
    turn(
      asks(
        "Two things decide the shape of this.",
        question("scope"),
        question("window", { options: ["one minute", "one hour"] }),
      ),
    );

    const questions = listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.kind === "question");
    expect(questions).toHaveLength(2);
    // The question and its `why`, so someone not holding the agent's
    // context can judge whether they can answer it.
    expect(questions[0]?.body).toBe("Is scope per key or per account?\n\n_The storage differs, and scope decides it._");
    // The options are the reason this is a card at all — a question with
    // nothing to click is something the product owner says in `message`.
    expect(questions[0]?.options).toEqual(["per key", "per account"]);
    expect(questions[1]?.options).toEqual(["one minute", "one hour"]);
  });

  it("asks without mentioning anyone, so the chat stays out of the Inbox", () => {
    turn(asks("One thing first.", question("scope")));

    for (const comment of listCommentsForItem(handle.db, conversation.id)) {
      expect(listMentionsForComment(handle.db, comment.id)).toEqual([]);
    }
  });

  it("keeps questions top-level, so an answer can hang off one", () => {
    turn(asks("One thing first.", question("scope")));

    // Threading is one level deep (D-05): a question filed under the
    // turn's message would leave nowhere for its answer to go.
    const asked = listCommentsForItem(handle.db, conversation.id).find((comment) => comment.kind === "question");
    expect(asked?.parentId).toBeNull();
  });
});

describe("creating work", () => {
  it("creates a feature with its stories, dependencies and pinned understanding", () => {
    const { proposalIds } = turn(
      says("Here is the breakdown.", {
        action: "new_feature",
        title: "Rate limiting",
        understanding: "Cap anonymous callers at 100 a minute.",
        decisions: [{ topic: "Scope", decision: "Per API key." }],
        stories: [story("Add the limiter"), story("Add Retry-After", { depends_on: [0] })],
      }),
    );

    const result = apply(proposalIds[0]!);
    expect(result.ok).toBe(true);

    const feature = listItems(handle.db).find((item) => item.title === "Rate limiting")!;
    // Where a refined feature already sits while its stories run.
    // A feature joins no pipeline (ARCHITECTURE.md, "One work entity") — its stories carry the
    // work.
    expect(feature.stepId).toBeNull();
    expect(feature.pipelineId).toBeNull();

    const stories = listItems(handle.db).filter((item) => item.parentId === feature.id);
    expect(stories.map((entry) => entry.stepId)).toEqual(["worktree", "worktree"]);

    const second = stories.find((entry) => entry.title === "Add Retry-After")!;
    const first = stories.find((entry) => entry.title === "Add the limiter")!;
    expect(listDependencies(handle.db, second.id).map((edge) => edge.dependsOnId)).toEqual([first.id]);

    const pinned = listCommentsForItem(handle.db, feature.id).filter((comment) => comment.pinned);
    expect(pinned.map((comment) => comment.body)).toEqual(["Cap anonymous callers at 100 a minute.", "**Scope** — Per API key."]);
  });

  /**
   * EO-302: the item knows who filed it.
   *
   * Approving in the chat *is* the gate (ARCHITECTURE.md, "A column is a responsibility, not a
   * status"), so the person who
   * pressed Approve is the person who created everything the plan
   * stamps out — the container and the work under it alike. In solo
   * mode that is the one person there is, and the conversation itself
   * counts too: somebody opened it.
   *
   * An agent proposed all of this, and an agent never appears here. It
   * ran because somebody asked it to, on their machine, and what it
   * produced became work only when they said so.
   */
  it("files everything approved in a conversation under the local person", () => {
    const { proposalIds } = turn(
      says("Here is the breakdown.", {
        action: "new_feature",
        title: "Rate limiting",
        understanding: "Cap anonymous callers at 100 a minute.",
        decisions: [],
        stories: [story("Add the limiter")],
      }),
    );
    expect(apply(proposalIds[0]!).ok).toBe(true);

    const feature = listItems(handle.db).find((item) => item.title === "Rate limiting")!;
    const created = listItems(handle.db).find((item) => item.parentId === feature.id)!;
    expect(feature.createdBy).toBe(LOCAL_PERSON_ID);
    expect(created.createdBy).toBe(LOCAL_PERSON_ID);
    expect(getItem(handle.db, conversation.id)!.createdBy).toBe(LOCAL_PERSON_ID);

    // And the row it names is a real one — a foreign key EO can follow
    // to a person, not an id nothing holds.
    expect(getPerson(handle.db, feature.createdBy!)).toMatchObject({ name: LOCAL_PERSON_NAME });

    // Nobody is waiting on it yet: claiming is the seventh story of
    // this phase, and until then an assignee would be EO asserting
    // something nobody asked for.
    expect(created.assigneeId).toBeNull();
  });

  it("assigns stories from a project-level feature to the project's sole repository", () => {
    const repository = attachWorkspace(handle.db, { name: "EO", keyPrefix: "EO", repoPath: "/tmp/eo" });
    const project = projectForWorkspace(handle.db, repository.id)!;
    conversation = openAssistConversation(handle.db, project.id);

    const { proposalIds } = turn(
      says("Here is the work.", {
        action: "new_feature",
        title: "Composer fixes",
        understanding: "Fix the shared composer.",
        decisions: [],
        stories: [story("Change the keybinding")],
      }),
    );

    expect(apply(proposalIds[0]!).ok).toBe(true);
    const feature = listItems(handle.db).find((item) => item.title === "Composer fixes")!;
    const created = listItems(handle.db).find((item) => item.parentId === feature.id)!;
    expect(feature.workspaceId).toBeNull();
    expect(created.workspaceId).toBe(repository.id);
  });

  it("refuses a plan whose touches close a loop, and offers nothing to approve", () => {
    const { proposalIds } = turn(
      says("Here is the breakdown.", {
        action: "new_feature",
        title: "Rate limiting",
        understanding: "u",
        decisions: [],
        // Both touch the same file, so the derived edges run both ways.
        stories: [story("A", { touches: ["src/limiter.ts"], depends_on: [1] }), story("B", { touches: ["src/limiter.ts"], depends_on: [0] })],
      }),
    );

    expect(proposalIds).toHaveLength(0); // posted as a rejection, not a proposal
    const bodies = listCommentsForItem(handle.db, conversation.id).map((comment) => comment.body);
    expect(bodies.some((body) => body.includes("cycle"))).toBe(true);
  });

  it("puts a new story under an existing feature and after an existing sibling", () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null });
    const sibling = createTestItem(handle.db, { type: "story", parentId: feature.id, title: "Add the limiter", stepId: "todo" });

    const { proposalIds } = turn(
      says("Adding that.", {
        action: "new_story",
        parent: feature.key,
        title: "Add Retry-After",
        body: "b",
        acceptance_criteria: ["a 429 carries Retry-After"],
        depends_on: [sibling.key],
        touches: [],
      }),
    );

    const result = apply(proposalIds[0]!);
    expect(result.ok).toBe(true);

    const created = listItems(handle.db).find((item) => item.title === "Add Retry-After")!;
    expect(created.parentId).toBe(feature.id);
    // Where the pipeline says work enters, not a literal (ARCHITECTURE.md, "Vocabulary").
    expect(created.stepId).toBe("worktree");
    expect(listDependencies(handle.db, created.id).map((edge) => edge.dependsOnId)).toEqual([sibling.id]);
  });

  it("reopens a feature that had closed when new work lands under it", () => {
    // Nothing has to be told: a feature's state is derived from its
    // stories (ARCHITECTURE.md, "One work entity"), so adding an unfinished one reopens it by
    // definition. This used to need `syncFeatureState` called explicitly
    // from the apply path, because creating a story is not a transition
    // and the derived answer was being *stored*.
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null });
    const done = createTestItem(handle.db, { type: "story", parentId: feature.id, title: "Done", stepId: "todo" });
    transitionItem(handle.db, { itemId: done.id, toStepId: "ready_to_merge", actor: "human", reason: "done" });

    const { proposalIds } = turn(
      says("One more.", {
        action: "new_story",
        parent: feature.key,
        title: "One more thing",
        body: "b",
        acceptance_criteria: ["it works"],
        depends_on: [],
        touches: [],
      }),
    );
    expect(apply(proposalIds[0]!).ok).toBe(true);

    expect(featureIsDone(featureProgress(handle.db, feature.id))).toBe(false);
    expect(featureProgress(handle.db, feature.id)).toEqual({ done: 1, total: 2 });
  });

  it("opens a conversation and files work even when a second pack ships the same words (KAN-129)", () => {
    // Two packs may ship a `story` and a `feature` (ARCHITECTURE.md, "An item type is data"), and
    // the bare
    // word is then a question with two answers. Every path in here knows
    // which it means — this pack's — and says so, so a support pack
    // being installed does not stop a conversation opening or a story
    // being filed from one.
    syncItemTypes(handle.db, [
      { packSlug: "support", slug: "story", label: "Request", plural: "Requests", container: false, specShape: EMPTY_SPEC_SHAPE, actionOverrides: {} },
      { packSlug: "support", slug: "feature", label: "Epic", plural: "Epics", container: true, specShape: EMPTY_SPEC_SHAPE, actionOverrides: {} },
    ]);

    const second = openAssistConversation(handle.db, null);
    expect(getItemType(handle.db, second.typeId)?.packSlug).toBe("developer");

    const { proposalIds } = turn(
      says("Adding that.", {
        action: "new_story",
        title: "Add Retry-After",
        body: "b",
        acceptance_criteria: ["a 429 carries Retry-After"],
        depends_on: [],
        touches: [],
      }),
    );

    const result = apply(proposalIds[0]!);
    expect(result.ok).toBe(true);
    const created = listItems(handle.db).find((item) => item.title === "Add Retry-After")!;
    expect(getItemType(handle.db, created.typeId)?.packSlug).toBe("developer");
  });

  it("refuses a story whose type this project has no row for, naming the slug (KAN-129)", () => {
    // An item type is a row scoped to a project now, so a project can be
    // without one: a pack that was never installed, or a type the
    // configure screen deleted. The refusal is a sentence into the
    // thread, not an exception out of the create path — the person who
    // clicked Approve is the one who has to read it.
    handle.db.run(sql`DELETE FROM item_types WHERE slug = 'story' AND project_id IS NULL`);

    const { proposalIds } = turn(
      says("Adding that.", {
        action: "new_story",
        title: "Add Retry-After",
        body: "b",
        acceptance_criteria: ["a 429 carries Retry-After"],
        depends_on: [],
        touches: [],
      }),
    );

    const result = apply(proposalIds[0]!);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("story");
    expect(listItems(handle.db).some((item) => item.title === "Add Retry-After")).toBe(false);
  });

  it("refuses to file work under something that is not a feature", () => {
    const notAFeature = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });

    const { proposalIds } = turn(
      says("Adding that.", {
        action: "new_story",
        parent: notAFeature.key,
        title: "Child",
        body: "b",
        acceptance_criteria: ["x"],
        depends_on: [],
        touches: [],
      }),
    );

    // Caught at render time, so it is never offered with a button on it.
    expect(proposalIds).toHaveLength(0);
  });
});

describe("changing work that already exists", () => {
  function amendable(state = "todo") {
    return createTestItem(handle.db, {
      type: "story",
      title: "Add the limiter",
      body: "Old body.",
      stepId: state,
      spec: { acceptance_criteria: ["old criterion"] },
    });
  }

  it("applies an amendment and records it on the amended item, not only in the chat", () => {
    const target = amendable();
    const { proposalIds } = turn(
      says("Updating it.", {
        action: "amend",
        item: target.key,
        why: "the API changed",
        acceptance_criteria: ["also logs the caller"],
      }),
    );

    expect(apply(proposalIds[0]!).ok).toBe(true);
    expect(getItem(handle.db, target.id)?.spec?.["acceptance_criteria"]).toEqual(["also logs the caller"]);

    // Whoever implements this reads its thread and nothing else.
    const note = listCommentsForItem(handle.db, target.id).find((comment) => comment.body.includes("the API changed"));
    expect(note).toBeDefined();
    expect(note?.body).toContain("old criterion");
  });

  it("refuses to change an item an agent is holding", () => {
    const target = amendable();
    createRun(handle.db, { itemId: target.id, agentId: po.id, action: "implement", status: "running" });

    const { proposalIds } = turn(says("Updating it.", { action: "amend", item: target.key, why: "w", title: "New title" }));

    expect(proposalIds).toHaveLength(0);
    expect(getItem(handle.db, target.id)?.title).toBe("Add the limiter");
  });

  it("refuses to change an item in review, and leaves it exactly as it was", () => {
    const target = amendable("review");

    const { proposalIds } = turn(says("Updating it.", { action: "amend", item: target.key, why: "w", title: "New title" }));

    expect(proposalIds).toHaveLength(0);
    expect(getItem(handle.db, target.id)?.title).toBe("Add the limiter");
    const rejection = listCommentsForItem(handle.db, conversation.id).find((comment) => comment.kind === "rejection");
    expect(rejection?.body).toContain("follow-up");
  });

  it("refuses to change an item in review on a pipeline that does not use the shipped slugs", () => {
    // The guard used to key on `stepId === "review"`, which is the
    // default pipeline's slug and nothing else's. A second pipeline names
    // its steps whatever the architect drafted, so the guard stopped
    // applying and an amendment could rewrite acceptance criteria out
    // from under a live review.
    const pipeline = createPipeline(handle.db, { name: "Hardening", projectId: null });
    const step = createStep(handle.db, {
      id: "second-look",
      pipelineId: pipeline.id,
      position: 0,
      name: "Second look",
      ownerRole: "reviewer",
      entryAction: "review",
    });
    const target = createTestItem(handle.db, {
      type: "story",
      title: "Add the limiter",
      body: "Old body.",
      stepId: step.id,
      spec: { acceptance_criteria: ["old criterion"] },
    });

    const { proposalIds } = turn(says("Updating it.", { action: "amend", item: target.key, why: "w", title: "New title" }));

    expect(proposalIds).toHaveLength(0);
    expect(getItem(handle.db, target.id)?.title).toBe("Add the limiter");
  });

  it("refuses on a qa step that reviews but is owned by nobody called a reviewer", () => {
    // The invariant's own worked example: a `qa` step inserted between
    // Implementer and Reviewer, owned by a `qa` agent. Keying the guard
    // on `ownerRole === "reviewer"` missed exactly this — a step that is
    // judging the item against its criteria while a discussion is free
    // to rewrite them. `owner_role` is free text, so it was a second
    // hardcoded slug wearing the first one's clothes.
    const pipeline = createPipeline(handle.db, { name: "With QA", projectId: null });
    const step = createStep(handle.db, { id: "qa", pipelineId: pipeline.id, position: 0, name: "QA", ownerRole: "qa", entryAction: "review" });
    const target = createTestItem(handle.db, {
      type: "story",
      title: "Add the limiter",
      stepId: step.id,
      spec: { acceptance_criteria: ["old criterion"] },
    });

    const { proposalIds } = turn(says("Updating it.", { action: "amend", item: target.key, why: "w", acceptance_criteria: ["rewritten"] }));

    expect(proposalIds).toHaveLength(0);
    expect(getItem(handle.db, target.id)?.spec).toMatchObject({ acceptance_criteria: ["old criterion"] });
  });

  it("refuses an amendment at review even when the item declares no criteria", () => {
    // EO-213 lets a criteria-less item at Review receive the one edit
    // its refused review is waiting for. That exception is a field, not
    // a state: a conversation must not be able to rewrite the title and
    // body of work an implementer has already finished, and then supply
    // a criterion that sends the altered item to a review which never
    // saw any of it.
    const target = createTestItem(handle.db, { type: "story", title: "Add the limiter", body: "Old body.", stepId: "review" });

    const { proposalIds } = turn(says("Updating it.", { action: "amend", item: target.key, why: "w", title: "New title" }));

    expect(proposalIds).toHaveLength(0);
    expect(getItem(handle.db, target.id)?.title).toBe("Add the limiter");
    expect(getItem(handle.db, target.id)?.body).toBe("Old body.");
  });

  it("refuses a reorder at review even when the item declares no criteria", () => {
    // The other caller of the same guard. A dependency edge is not the
    // criterion EO asked for either, and the graph is what decides what
    // may be dispatched at all.
    const blocker = createTestItem(handle.db, { type: "story", title: "Comes first", stepId: "todo" });
    const target = createTestItem(handle.db, { type: "story", title: "Add the limiter", stepId: "review" });

    const { proposalIds } = turn(
      says("Reordering.", { action: "reorder", item: target.key, why: "w", add_depends_on: [blocker.key], remove_depends_on: [] }),
    );

    expect(proposalIds).toHaveLength(0);
    expect(listDependencies(handle.db, target.id)).toHaveLength(0);
  });

  it("still allows an amendment on a reviewer-owned step that is not reviewing", () => {
    // The converse over-application. A pipeline may put a reviewer on a
    // triage step ahead of implementation; nothing is being judged there
    // yet, and refusing to refine an item at precisely the point that is
    // what the step is for would be the guard doing harm.
    const pipeline = createPipeline(handle.db, { name: "Triage first", projectId: null });
    const step = createStep(handle.db, { id: "triage", pipelineId: pipeline.id, position: 0, name: "Triage", ownerRole: "reviewer", entryAction: "refine" });
    const target = createTestItem(handle.db, { type: "story", title: "Add the limiter", stepId: step.id, spec: { acceptance_criteria: ["old criterion"] } });

    const { proposalIds } = turn(says("Sharpening it.", { action: "amend", item: target.key, why: "w", title: "Add the rate limiter" }));

    expect(proposalIds).toHaveLength(1);
  });

  it("refuses to change finished work", () => {
    const target = amendable("ready_to_merge");

    const { proposalIds } = turn(says("Updating it.", { action: "amend", item: target.key, why: "w", title: "New title" }));

    expect(proposalIds).toHaveLength(0);
  });

  it("allows a priority change even while a run is in progress", () => {
    // Priority only affects the order work is picked up in, so it
    // cannot corrupt anything in flight — and refusing it would mean
    // you could not deprioritise an item exactly when you want to.
    const target = amendable();
    createRun(handle.db, { itemId: target.id, agentId: po.id, action: "implement", status: "running" });

    const { proposalIds } = turn(says("Bumping it.", { action: "amend", item: target.key, why: "urgent", priority: 5 }));

    expect(apply(proposalIds[0]!).ok).toBe(true);
    expect(getItem(handle.db, target.id)?.priority).toBe(5);
  });

  it("adds a dependency edge, and refuses one that would close a loop against the live graph", () => {
    const first = createTestItem(handle.db, { type: "story", title: "First", stepId: "todo" });
    const second = createTestItem(handle.db, { type: "story", title: "Second", stepId: "todo" });
    addDependency(handle.db, second.id, first.id);

    const { proposalIds } = turn(
      says("Reordering.", { action: "reorder", item: first.key, why: "actually the other way round", add_depends_on: [second.key], remove_depends_on: [] }),
    );

    const result = apply(proposalIds[0]!);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("circular");
    // Rolled back by the transaction — the edge must not survive the refusal.
    expect(listDependencies(handle.db, first.id)).toHaveLength(0);
  });

  it("removes a dependency edge", () => {
    const first = createTestItem(handle.db, { type: "story", title: "First", stepId: "todo" });
    const second = createTestItem(handle.db, { type: "story", title: "Second", stepId: "todo" });
    addDependency(handle.db, second.id, first.id);

    const { proposalIds } = turn(
      says("Unblocking.", { action: "reorder", item: second.key, why: "not actually needed", add_depends_on: [], remove_depends_on: [first.key] }),
    );

    expect(apply(proposalIds[0]!).ok).toBe(true);
    expect(listDependencies(handle.db, second.id)).toHaveLength(0);
  });

  it("leaves an earlier removal unapplied when an addition in the same reorder is refused", () => {
    // EO-600. The card used to write its removals before it looked at
    // its additions; the shared rule judges the whole change first.
    const first = createTestItem(handle.db, { type: "story", title: "First", stepId: "todo" });
    const second = createTestItem(handle.db, { type: "story", title: "Second", stepId: "todo" });
    const third = createTestItem(handle.db, { type: "story", title: "Third", stepId: "todo" });
    addDependency(handle.db, first.id, third.id);
    addDependency(handle.db, second.id, first.id);

    const { proposalIds } = turn(
      says("Reordering.", { action: "reorder", item: first.key, why: "swap them", add_depends_on: [second.key], remove_depends_on: [third.key] }),
    );

    const result = apply(proposalIds[0]!);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("circular");
    expect(listDependencies(handle.db, first.id).map((edge) => edge.dependsOnId)).toEqual([third.id]);
  });

  it("says on the item what the reorder changed", () => {
    const first = createTestItem(handle.db, { type: "story", title: "First", stepId: "todo" });
    const second = createTestItem(handle.db, { type: "story", title: "Second", stepId: "todo" });

    const { proposalIds } = turn(says("Reordering.", { action: "reorder", item: second.key, why: "first goes first", add_depends_on: [first.key], remove_depends_on: [] }));

    expect(apply(proposalIds[0]!).ok).toBe(true);
    const said = listCommentsForItem(handle.db, second.id).filter((comment) => comment.authorType === "engine");
    expect(said).toHaveLength(1);
    expect(said[0]?.body).toContain("Reordered from a conversation: first goes first");
    expect(said[0]?.body).toContain(`Now waits for: ${first.key} (First)`);
  });

  it("has no way to move an item, because only transitionItem may", () => {
    const target = amendable();
    const { proposalIds } = turn(says("Updating it.", { action: "amend", item: target.key, why: "w", title: "New title" }));

    expect(apply(proposalIds[0]!).ok).toBe(true);
    expect(getItem(handle.db, target.id)?.stepId).toBe("todo"); // unchanged
  });
});

/**
 * A proposal that creates work carries the priority the work is created
 * with (EO-568), and its card names the level whenever it is not Normal.
 */
describe("the priority a proposal creates work with", () => {
  const bug = (extra: Record<string, unknown> = {}): DiscussionProposal => ({
    action: "new_bug",
    title: "Login loops",
    body: "It loops.",
    steps_to_reproduce: "Sign in.",
    expected: "Signed in.",
    actual: "Back at sign-in.",
    environment: "Chrome.",
    acceptance_criteria: [],
    ...extra,
  });
  const newStory = (extra: Record<string, unknown> = {}): DiscussionProposal => ({ action: "new_story", ...story("Add the limiter"), depends_on: [], ...extra });
  const feature = (extra: Record<string, unknown> = {}): DiscussionProposal => ({
    action: "new_feature",
    title: "Rate limiting",
    understanding: "Cap callers.",
    decisions: [],
    stories: [story("Urgent story", { priority: 2 }), story("Silent story"), story("Far-off story", { priority: 5 })],
    ...extra,
  });
  const created = (title: string) => listItems(handle.db).find((item) => item.title === title)!;
  const cardOf = (proposalId: Uuid) => listCommentsForItem(handle.db, conversation.id).find((comment) => comment.id === proposalId)!.body;

  it.each([
    ["new_story", newStory({ priority: 2 }), "Add the limiter"],
    ["new_bug", bug({ priority: 1 }), "Login loops"],
  ])("creates a %s with the priority it carries", (_action, proposal, title) => {
    const { proposalIds } = turn(says("Here.", proposal));

    expect(apply(proposalIds[0]!).ok).toBe(true);
    expect(created(title).priority).toBe((proposal as { priority: number }).priority);
  });

  it.each([
    ["new_story", newStory(), "Add the limiter"],
    ["new_bug", bug(), "Login loops"],
  ])("creates a %s without one at 0", (_action, proposal, title) => {
    const { proposalIds } = turn(says("Here.", proposal));

    expect(apply(proposalIds[0]!).ok).toBe(true);
    expect(created(title).priority).toBe(0);
  });

  it("gives a feature its own priority and each story only the one it carries", () => {
    const { proposalIds } = turn(says("Here.", feature({ priority: 1 })));

    expect(apply(proposalIds[0]!).ok).toBe(true);
    expect(created("Rate limiting").priority).toBe(1);
    expect(created("Urgent story").priority).toBe(2);
    // Not the feature's 1: a story does not inherit.
    expect(created("Silent story").priority).toBe(0);
    expect(created("Far-off story").priority).toBe(5);
  });

  it("creates a feature without one at 0", () => {
    const { proposalIds } = turn(says("Here.", feature()));

    expect(apply(proposalIds[0]!).ok).toBe(true);
    expect(created("Rate limiting").priority).toBe(0);
  });

  it("names the level on the card's rows, and nothing at Normal", () => {
    const summary = summariseProposal(handle.db, conversation, feature({ priority: 1 }));

    expect(summary.container?.priority).toBe(1);
    expect(summary.rows.map((row) => (row.kind === "new" ? row.priority : null))).toEqual([2, undefined, 5]);
    expect(summariseProposal(handle.db, conversation, newStory({ priority: 2 })).rows[0]).toMatchObject({ priority: 2 });
    expect(summariseProposal(handle.db, conversation, bug()).rows[0]).not.toHaveProperty("priority");
  });

  it.each([
    [newStory({ priority: 1 }), "_Priority: High_"],
    [bug({ priority: 2 }), "_Priority: Urgent_"],
    [feature({ priority: 4 }), "_Priority: Priority 4_"],
  ])("names the level in the card's body: %#", (proposal, line) => {
    const { proposalIds } = turn(says("Here.", proposal));

    expect(cardOf(proposalIds[0]!)).toContain(line);
  });

  it.each([newStory(), bug({ priority: 0 })])("says nothing about priority in the body at Normal: %#", (proposal) => {
    const { proposalIds } = turn(says("Here.", proposal));

    expect(cardOf(proposalIds[0]!)).not.toContain("Priority");
  });
});

describe("a refused proposal leaves nothing behind", () => {
  it("rolls back the feature and its pinned notes when a story cannot be routed", () => {
    // Reachable because `applyApprovedProposal` refuses a plan whose
    // stories do not each name a repository on a multi-repo project — by
    // which point the feature row and its pinned comments already
    // exist. Returning a refusal from inside the transaction would
    // *commit* those, leaving an orphan feature with no stories under
    // it and no way to notice.
    const project = createProject(handle.db, { name: "two repos", keyPrefix: "EO", workspaceIds: [] });
    for (const [name, prefix] of [["api", "API"], ["web", "WEB"]]) {
      const repository = attachWorkspace(handle.db, { name: name!, keyPrefix: prefix!, repoPath: `/tmp/${name}`, baseBranch: "main" });
      addWorkspaceToProject(handle.db, project.id, repository.id);
    }
    const onProject = openAssistConversation(handle.db, project.id);

    const run = createRun(handle.db, { itemId: onProject.id, agentId: po.id, action: ASSIST_ACTION });
    const output = says("Here it is.", {
      action: "new_feature",
      title: "Rate limiting",
      understanding: "u",
      decisions: [],
      stories: [story("Nameless")], // no `repository`, and the project spans two
    });
    updateRun(handle.db, run.id, { status: "succeeded", result: { raw: "{}", parsed: output } });
    postAssistReply(handle.db, onProject, po.id, run.id, output);

    const proposalId = listCommentsForItem(handle.db, onProject.id).find((comment) => comment.kind === PROPOSAL_KIND)!.id;
    const result = applyDiscussionProposal(handle.db, onProject, proposalId);

    expect(result.ok).toBe(false);
    expect(listItems(handle.db).some((item) => item.title === "Rate limiting")).toBe(false);
  });
});

describe("approving the wrong thing", () => {
  it("refuses a comment that is not a proposal", () => {
    turn(says("Just talking."));
    const [note] = listCommentsForItem(handle.db, conversation.id);

    expect(apply(note!.id).ok).toBe(false);
  });

  it("refuses a proposal whose run no longer has a readable result", () => {
    const run = createRun(handle.db, { itemId: conversation.id, agentId: po.id, action: ASSIST_ACTION });
    const comment = postComment(handle.db, {
      itemId: conversation.id,
      runId: run.id,
      author: { type: "agent", agentId: po.id },
      kind: PROPOSAL_KIND,
      body: "A proposal with nothing behind it.",
    });

    const result = apply(comment.id);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("readable");
  });
});

/**
 * A base branch named in a proposal (EO-364): the card a person approves
 * says so, approving writes it onto the item before anything dispatches
 * it, and a proposal whose item would land where no branch is cut is
 * refused with nothing created.
 */
describe("a base branch named in a proposal", () => {
  function onARepository(): void {
    const repository = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" });
    conversation = openAssistConversation(handle.db, projectForWorkspace(handle.db, repository.id)!.id);
  }

  function cardFor(proposalId: Uuid): string {
    return listCommentsForItem(handle.db, conversation.id).find((comment) => comment.id === proposalId)!.body;
  }

  it("shows it on a single story's card, and writes it onto the story it creates", () => {
    onARepository();
    const { proposalIds } = turn(
      says("That goes on the release branch.", {
        action: "new_story",
        title: "Backport the limiter",
        body: "Release 2.4 needs it too.",
        acceptance_criteria: ["2.4 returns 429 after 100 requests"],
        depends_on: [],
        touches: [],
        base_branch: "release/2.4",
      }),
    );

    expect(cardFor(proposalIds[0]!)).toContain("Branches from `release/2.4`");
    expect(apply(proposalIds[0]!).ok).toBe(true);

    const created = listItems(handle.db).find((item) => item.title === "Backport the limiter")!;
    expect(gitStateOf(created)).toEqual({ branch: null, pullRequest: null, baseBranch: "release/2.4", namedBranch: false, attachedAt: null, reference: null });
  });

  it("shows it under the story it belongs to in a plan, and writes it onto that story alone", () => {
    onARepository();
    const { proposalIds } = turn(
      says("Here is the breakdown.", {
        action: "new_feature",
        title: "Rate limiting",
        understanding: "Cap anonymous callers.",
        decisions: [],
        stories: [story("On main"), story("On the release", { base_branch: "release/2.4" })],
      }),
    );

    expect(cardFor(proposalIds[0]!)).toContain("Branches from `release/2.4`");
    expect(apply(proposalIds[0]!).ok).toBe(true);

    const onRelease = listItems(handle.db).find((item) => item.title === "On the release")!;
    const onMain = listItems(handle.db).find((item) => item.title === "On main")!;
    expect(gitStateOf(onRelease).baseBranch).toBe("release/2.4");
    expect(gitStateOf(onMain).baseBranch).toBeNull();
  });

  it("does not offer a card for a name git would not take", () => {
    onARepository();
    const { proposalIds } = turn(
      says("Release branch.", {
        action: "new_story",
        title: "Backport",
        body: "",
        acceptance_criteria: ["it works"],
        depends_on: [],
        touches: [],
        base_branch: "the release branch",
      }),
    );

    // Unbuildable proposals are said in prose rather than offered as approvable.
    expect(proposalIds).toEqual([]);
  });

  it("refuses a story that would land where no branch is cut, and creates nothing and stores no git row", () => {
    // No repository on the conversation's project: the work would happen
    // on no disk at all.
    const { proposalIds } = turn(
      says("That goes on the release branch.", {
        action: "new_story",
        title: "Backport the limiter",
        body: "",
        acceptance_criteria: ["it works"],
        depends_on: [],
        touches: [],
        base_branch: "release/2.4",
      }),
    );
    const before = listItems(handle.db).length;

    const result = apply(proposalIds[0]!);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("does not work on a branch");
    expect(listItems(handle.db)).toHaveLength(before);
    expect(handle.db.all(sql`SELECT * FROM item_extensions WHERE extension = 'git'`)).toEqual([]);
  });
});

/**
 * An existing branch named in a proposal (EO-365): shown on the card and
 * written onto the story as its branch, marked as the person's, before
 * its first dispatch.
 */
describe("an existing branch named in a proposal", () => {
  function onARepository(): void {
    const repository = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" });
    conversation = openAssistConversation(handle.db, projectForWorkspace(handle.db, repository.id)!.id);
  }

  function cardFor(proposalId: Uuid): string {
    return listCommentsForItem(handle.db, conversation.id).find((comment) => comment.id === proposalId)!.body;
  }

  it("shows it on a single story's card, and writes it onto the story as its named branch", () => {
    onARepository();
    const { proposalIds } = turn(
      says("Carry on from my branch.", {
        action: "new_story",
        title: "Finish the limiter",
        body: "I started it on feature/limits.",
        acceptance_criteria: ["returns 429 after 100 requests"],
        depends_on: [],
        touches: [],
        existing_branch: " feature/limits ",
      }),
    );

    expect(cardFor(proposalIds[0]!)).toContain("Works on the existing branch `feature/limits`");
    expect(apply(proposalIds[0]!).ok).toBe(true);

    const created = listItems(handle.db).find((item) => item.title === "Finish the limiter")!;
    expect(gitStateOf(created)).toEqual({ branch: "feature/limits", pullRequest: null, baseBranch: null, namedBranch: true, attachedAt: null, reference: null });
  });

  it("writes it onto the one story of a plan that names it", () => {
    onARepository();
    const { proposalIds } = turn(
      says("Here is the breakdown.", {
        action: "new_feature",
        title: "Rate limiting",
        understanding: "Cap anonymous callers.",
        decisions: [],
        stories: [story("Fresh"), story("On my branch", { existing_branch: "feature/limits" })],
      }),
    );

    expect(cardFor(proposalIds[0]!)).toContain("Works on the existing branch `feature/limits`");
    expect(apply(proposalIds[0]!).ok).toBe(true);

    expect(gitStateOf(listItems(handle.db).find((item) => item.title === "On my branch")!)).toMatchObject({ branch: "feature/limits", namedBranch: true });
    expect(gitStateOf(listItems(handle.db).find((item) => item.title === "Fresh")!).branch).toBeNull();
  });

  it("refuses a story that would land where no branch is cut, and creates nothing", () => {
    const { proposalIds } = turn(
      says("Carry on from my branch.", {
        action: "new_story",
        title: "Finish the limiter",
        body: "",
        acceptance_criteria: ["it works"],
        depends_on: [],
        touches: [],
        existing_branch: "feature/limits",
      }),
    );
    const before = listItems(handle.db).length;

    const result = apply(proposalIds[0]!);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("does not work on a branch");
    expect(listItems(handle.db)).toHaveLength(before);
    expect(handle.db.all(sql`SELECT * FROM item_extensions WHERE extension = 'git'`)).toEqual([]);
  });
});

/**
 * A proposal names its pipeline by name or by id (EO-440).
 *
 * Agents send the id as often as the name — `default` for Delivery — and
 * a proposal right in every other respect used to read "Not decided" on
 * its card and be refused at Create. The name is still asked first, so a
 * value that is one pipeline's name and another's id means the one with
 * that name.
 */
describe("the pipeline a proposal names", () => {
  /** A placeable pipeline beside Delivery: one step on the board, and that step is where work enters. */
  function secondPipeline(name: string) {
    const pipeline = createPipeline(handle.db, { name, projectId: null });
    const step = createStep(handle.db, { id: `${name.toLowerCase().replace(/\W+/g, "_")}_build`, pipelineId: pipeline.id, position: 0, name: "Build", ownerRole: "implementer", entryAction: "implement" });
    setEntryStep(handle.db, pipeline.id, step.id);
    return { pipeline, step };
  }

  const delivery = () => getPipeline(handle.db, "default")!;

  const proposed = (pipeline?: string, title = "Fix the limiter"): DiscussionProposal => ({
    action: "new_story",
    title,
    body: "It counts twice.",
    acceptance_criteria: ["It counts once."],
    depends_on: [],
    touches: [],
    ...(pipeline === undefined ? {} : { pipeline }),
  });

  it("resolves a pipeline's name, trimmed and case-insensitively, as it always has", () => {
    secondPipeline("Hotfix");

    expect(resolvePlacement(handle.db, null, null, "Delivery")).toEqual({ pipelineId: "default", entryStepId: delivery().entryStepId });
    expect(resolvePlacement(handle.db, null, null, "  delivery ")).toEqual({ pipelineId: "default", entryStepId: delivery().entryStepId });
  });

  it("resolves a pipeline's id", () => {
    const { pipeline, step } = secondPipeline("Hotfix");

    expect(resolvePlacement(handle.db, null, null, "default")).toEqual({ pipelineId: "default", entryStepId: delivery().entryStepId });
    expect(resolvePlacement(handle.db, null, null, pipeline.id)).toEqual({ pipelineId: pipeline.id, entryStepId: step.id });
  });

  it("prefers the pipeline with that name over a different pipeline with that id", () => {
    // "default" is Delivery's id and this pipeline's name.
    const { pipeline, step } = secondPipeline("default");

    expect(resolvePlacement(handle.db, null, null, "default")).toEqual({ pipelineId: pipeline.id, entryStepId: step.id });
  });

  it("refuses a value that is neither, listing every pipeline by name and id", () => {
    const { pipeline } = secondPipeline("Hotfix");

    const placement = resolvePlacement(handle.db, null, null, "Shipping");

    expect(placement).toMatchObject({ unknownPipeline: true });
    expect("problem" in placement && placement.problem).toContain('no pipeline called "Shipping"');
    expect("problem" in placement && placement.problem).toContain(`Hotfix (id: ${pipeline.id})`);
  });

  it("shows the pipeline an id names on the card, and creates the work on its entry step", () => {
    secondPipeline("Hotfix");
    const { proposalIds } = turn(says("Here.", proposed("default")));

    expect(describeProposal(handle.db, conversation, proposed("default")).landsOn?.pipelineName).toBe("Delivery");
    expect(apply(proposalIds[0]!).ok).toBe(true);

    const created = listItems(handle.db).find((item) => item.title === "Fix the limiter")!;
    expect(created.pipelineId).toBe("default");
    expect(created.stepId).toBe(delivery().entryStepId);
  });

  it("still asks which pipeline at approval when a card naming none got through and there is more than one", () => {
    // The turn's check sends such a reply back (EO-441); this is the
    // fallback for a second pipeline appearing after the card was posted.
    const { proposalIds } = turn(says("Here.", proposed()));
    expect(proposedPipelineProblem(handle.db, null, says("Here.", proposed()))).toBeNull();
    secondPipeline("Hotfix");

    expect(describeProposal(handle.db, conversation, proposed()).landsOn).toBeNull();
    expect(resolvePlacement(handle.db, null, null, undefined)).toMatchObject({ needsPipeline: true });

    const before = listItems(handle.db).length;
    const result = apply(proposalIds[0]!);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("Which pipeline should this work flow through?");
    expect(listItems(handle.db)).toHaveLength(before);
  });

  describe("proposedPipelineProblem", () => {
    it("asks nothing of a reply whose work names a pipeline by name or id", () => {
      secondPipeline("Hotfix");

      expect(proposedPipelineProblem(handle.db, null, says("Here.", proposed("Delivery"), proposed("default"), proposed("hotfix")))).toBeNull();
      expect(proposedPipelineProblem(handle.db, null, { message: "Which one?" })).toBeNull();
    });

    it("sends back work naming no pipeline when there is more than one, by title, listing them by name and id", () => {
      const { pipeline } = secondPipeline("Hotfix");

      const problem = proposedPipelineProblem(
        handle.db,
        null,
        says("Here.", proposed(undefined, "Undecided"), proposed("Delivery", "Fine one"), { ...proposed(undefined, "Also undecided"), action: "new_bug", steps_to_reproduce: "s", expected: "e", actual: "a", environment: "env" } as DiscussionProposal),
      );

      expect(problem).toContain('The proposal "Undecided" names no pipeline, and this project has more than one.');
      expect(problem).toContain('"Also undecided" names no pipeline');
      expect(problem).not.toContain("Fine one");
      expect(problem).toContain("Work can be placed on: ");
      expect(problem).toContain("Delivery (id: default)");
      expect(problem).toContain(`Hotfix (id: ${pipeline.id})`);
      expect(problem).not.toContain("leave it out");
    });

    it("sends back a new feature naming no pipeline when there is more than one", () => {
      secondPipeline("Hotfix");
      const feature = {
        action: "new_feature",
        title: "Rate limits",
        understanding: "u",
        decisions: [],
        stories: [{ title: "s", body: "b", acceptance_criteria: ["a"], depends_on: [], touches: [] }],
      } as unknown as DiscussionProposal;

      expect(proposedPipelineProblem(handle.db, null, says("Here.", feature))).toContain('"Rate limits" names no pipeline');
    });

    it("asks nothing of work naming no pipeline when there is exactly one, which the card shows and Create places it on", () => {
      expect(proposedPipelineProblem(handle.db, null, says("Here.", proposed()))).toBeNull();

      const { proposalIds } = turn(says("Here.", proposed()));
      expect(describeProposal(handle.db, conversation, proposed()).landsOn?.pipelineName).toBe("Delivery");
      expect(apply(proposalIds[0]!).ok).toBe(true);

      const created = listItems(handle.db).find((item) => item.title === "Fix the limiter")!;
      expect(created.pipelineId).toBe("default");
      expect(created.stepId).toBe(delivery().entryStepId);
    });

    it("asks nothing of an amendment or a reorder, which name no pipeline, even when there is more than one", () => {
      secondPipeline("Hotfix");
      const target = createTestItem(handle.db, { type: "story", title: "Target", stepId: "todo" });

      expect(
        proposedPipelineProblem(
          handle.db,
          null,
          says("Here.", { action: "amend", item: target.key, why: "w", title: "New" }, { action: "reorder", item: target.key, why: "w", add_depends_on: [], remove_depends_on: [] }),
        ),
      ).toBeNull();
    });

    it("names each proposal by title, quotes what it gave, and lists the pipelines by name and id", () => {
      const { pipeline } = secondPipeline("Hotfix");

      const problem = proposedPipelineProblem(handle.db, null, says("Here.", proposed("Shipping", "Fix the limiter"), proposed("Delivery", "Fine one"), proposed("qa", "Another")));

      expect(problem).toContain('"Fix the limiter" names the pipeline "Shipping"');
      expect(problem).toContain('"Another" names the pipeline "qa"');
      expect(problem).not.toContain("Fine one");
      expect(problem).toContain("Delivery (id: default)");
      expect(problem).toContain(`Hotfix (id: ${pipeline.id})`);
    });

    it("leaves a project with no usable pipeline to approval's refusal, which the agent cannot fix", () => {
      archivePipeline(handle.db, "default");

      expect(resolvePlacement(handle.db, null, null, "Shipping")).toEqual({ problem: "This project has no pipeline for work to flow through yet." });
      expect(proposedPipelineProblem(handle.db, null, says("Here.", proposed("Shipping")))).toBeNull();
      expect(proposedPipelineProblem(handle.db, null, says("Here.", proposed()))).toBeNull();

      const { proposalIds } = turn(says("Here.", proposed()));
      const result = apply(proposalIds[0]!);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe("This project has no pipeline for work to flow through yet.");
    });
  });
});
