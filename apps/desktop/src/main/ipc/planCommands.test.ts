import { gitStateOf, jiraStateOf, ipcContract, specFields, type IpcPayload, type SpecFieldDraft, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  getItemByKey,
  isJiraPullPending,
  listCommentsForItem,
  listItemsForProject,
  pendingPushesForItem,
  postComment,
  projectForWorkspace,
} from "../db/repos/index.js";
import { attachWorkspace, openMigratedTestDb } from "../db/testHelpers.js";
import { handleIpcRequest } from "./handleRequest.js";
import { submitPlan } from "./planCommands.js";
import { listItemTypes } from "../db/repos/itemTypesRepo.js";
import { updateItemTypeCommand } from "./itemTypeCommands.js";

/**
 * A plan agreed outside EO, handed over whole.
 *
 * What matters here is not that items appear — it is that they appear
 * through the same door `discussions:approve` uses. A second creation
 * path that skipped the cycle check or the acceptance-criteria rule
 * would be the lenient one, and everything would drift towards it.
 */
let handle: DbHandle;

function story(title: string, overrides: Partial<IpcPayload<"work:submitPlan">["stories"][number]> = {}) {
  return {
    title,
    body: `Body for ${title}`,
    acceptance_criteria: [`${title} is demonstrably done`],
    depends_on: [],
    touches: [],
    ...overrides,
  };
}

function plan(overrides: Partial<IpcPayload<"work:submitPlan">> = {}): IpcPayload<"work:submitPlan"> {
  return {
    title: "Rate limit the importer",
    understanding: "The importer hammers the API and gets throttled. We agreed to cap it and make the cap settable.",
    decisions: [{ topic: "Default", decision: "Ten requests a second, settable per repository." }],
    stories: [story("Cap the importer's request rate")],
    ...overrides,
  };
}

/** Adds optional fields of the project's own to the pack's type of this word, in the installation's scope (EO-735). */
function addFieldsTo(slug: string, added: SpecFieldDraft[]): void {
  const type = listItemTypes(handle.db, null).find((row) => row.packSlug === "developer" && row.slug === slug)!;
  const own = specFields(type.specShape).map(({ name, kind, required }) => ({ name, kind, required }));
  const saved = updateItemTypeCommand(handle.db, { id: type.id, fields: [...own, ...added] });
  if (saved.problem !== null) throw new Error(saved.problem);
}

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

describe("submitting an agreed plan", () => {
  it("creates the feature and its stories, and says what it made", () => {
    const result = submitPlan(handle.db, undefined, plan({ stories: [story("First"), story("Second")] }));

    expect(result.created).toBe(true);
    expect(result.problem).toBeNull();
    expect(result.featureKey).not.toBeNull();
    expect(result.storyKeys).toHaveLength(2);
  });

  it("pins the understanding on the feature, because that is what agents read instead of your conversation", () => {
    const result = submitPlan(handle.db, undefined, plan());

    const feature = getItemByKey(handle.db, result.featureKey!);
    expect(feature?.type).toBe("feature");
    // A feature is a container: no pipeline, no step, nothing dispatches
    // against it. Its stories carry the work.
    expect(feature?.pipelineId).toBeNull();
    expect(feature?.stepId).toBeNull();
  });

  it("puts the stories on a pipeline, where the scheduler can see them", () => {
    const result = submitPlan(handle.db, undefined, plan());

    const created = getItemByKey(handle.db, result.storyKeys[0]!);
    expect(created?.type).toBe("story");
    expect(created?.pipelineId).not.toBeNull();
    expect(created?.stepId).not.toBeNull();
  });

  it("refuses a plan whose dependencies form a cycle, and creates nothing", () => {
    // The check that matters most: EO schedules in dependency order, and
    // a cycle is work that can never start. Going through the product
    // owner's own applier is what gets this for free.
    const before = listItemsForProject(handle.db, null).length;

    const result = submitPlan(
      handle.db,
      undefined,
      plan({ stories: [story("A", { depends_on: [1] }), story("B", { depends_on: [0] })] }),
    );

    expect(result.created).toBe(false);
    expect(result.problem).not.toBeNull();
    // Nothing half-applied: the feature must not survive the refusal
    // that rejected its stories.
    expect(listItemsForProject(handle.db, null).length).toBe(before);
  });

  it("refuses a story with no acceptance criteria at the boundary", () => {
    // Not pedantry: verification checks the implementer's claim against
    // these, and a story with none is one nothing can check.
    //
    // Asserted against the contract rather than the function, because
    // that is where it is enforced — `handleIpcRequest` parses before a
    // handler ever runs, so calling `submitPlan` directly skips it. A
    // test that called the function and expected a refusal would be
    // testing a guard that lives one layer up.
    const rejected = ipcContract["work:submitPlan"].request.safeParse(
      plan({ stories: [story("Vague", { acceptance_criteria: [] })] }),
    );

    expect(rejected.success).toBe(false);
  });

  it("refuses a pipeline name the project does not have, and says what it does have", () => {
    // This used to fall through to "there is only one, so it must be
    // that", which put work somewhere other than where it was sent and
    // reported success. Handing an item to `deploy` and silently
    // getting `default` is the failure worth being loud about.
    const result = submitPlan(handle.db, undefined, plan({ pipeline: "not-a-pipeline" }));

    expect(result.created).toBe(false);
    expect(result.problem).toContain("no pipeline called");
    // And it lists the real ones, so the next attempt can be right.
    expect(result.problem).toContain("It has:");
  });

  it("still places work when no pipeline is named at all", () => {
    // The other half: refusing a *wrong* name must not turn "no
    // preference" into an error on a project with one pipeline.
    expect(submitPlan(handle.db, undefined, plan()).created).toBe(true);
  });

  it("records the dependency between stories, so they are worked in order", () => {
    const result = submitPlan(
      handle.db,
      undefined,
      plan({ stories: [story("Groundwork"), story("Builds on it", { depends_on: [0] })] }),
    );

    expect(result.created).toBe(true);
    const dependent = getItemByKey(handle.db, result.storyKeys[1]!);
    expect(dependent).not.toBeUndefined();
  });
});

/**
 * A plan whose feature and stories are already issues in Jira (EO-124).
 *
 * The other door in: a plan agreed outside EO usually mirrors an epic
 * that is already written, with its stories under it, and there was
 * nowhere in `work_submit_plan` to say which is which. Attaching stays
 * local — format and uniqueness, no call to Jira, nothing imported —
 * which is the pinned decision on EO-121.
 *
 * What every refusal here asserts is that *nothing* was created. A plan
 * is many items, and a key checked as each one is made would leave a
 * feature and three stories behind the sentence saying nothing was.
 */
describe("handing over a plan that already exists in Jira", () => {
  function engineNotes(key: string): string[] {
    const item = getItemByKey(handle.db, key)!;
    return listCommentsForItem(handle.db, item.id)
      .filter((comment) => comment.authorType === "engine")
      .map((comment) => comment.body);
  }

  /** A project with a repository on it — what a push needs before it can be queued at all. */
  function projectWithRepository(): Uuid {
    const repository = attachWorkspace(handle.db, { name: "svc", keyPrefix: "SVC", repoPath: "/tmp/svc" });
    return projectForWorkspace(handle.db, repository.id)!.id;
  }

  it("creates the feature and every story mirroring the keys it was given", () => {
    const result = submitPlan(
      handle.db,
      undefined,
      plan({
        jiraKey: "KAN-10",
        stories: [story("Groundwork", { jira_key: "kan-11" }), story("Builds on it", { jira_key: "KAN-12" })],
      }),
    );

    expect(result.created).toBe(true);
    expect(jiraStateOf(getItemByKey(handle.db, result.featureKey!)!).key).toBe("KAN-10");
    // Canonical spelling, not what a paste carried: `jira/pull.ts` maps
    // a key back to an item by matching it exactly.
    expect(jiraStateOf(getItemByKey(handle.db, result.storyKeys[0]!)!).key).toBe("KAN-11");
    expect(jiraStateOf(getItemByKey(handle.db, result.storyKeys[1]!)!).key).toBe("KAN-12");
  });

  it("leaves a story the plan gave no key to unlinked", () => {
    // The keys are positional, so this is the assertion that keeps them
    // lined up with the stories they were sent beside.
    const result = submitPlan(
      handle.db,
      undefined,
      plan({ stories: [story("Unlinked"), story("Linked", { jira_key: "KAN-12" })] }),
    );

    expect(jiraStateOf(getItemByKey(handle.db, result.storyKeys[0]!)!).key).toBeNull();
    expect(jiraStateOf(getItemByKey(handle.db, result.storyKeys[1]!)!).key).toBe("KAN-12");
  });

  it("records the links in a note on the feature, saying the issues are being read in", () => {
    // Invariant 8, and once rather than per item: the pinned decision
    // on EO-121 is that a feature-wide change is noted on the feature
    // with a count. The feature is also where somebody looks to see what
    // the plan became.
    const result = submitPlan(
      handle.db,
      undefined,
      plan({ jiraKey: "KAN-10", stories: [story("Groundwork", { jira_key: "KAN-11" }), story("Builds on it")] }),
    );

    const note = engineNotes(result.featureKey!).find((body) => body.includes("KAN-10"))!;
    expect(note).toBeDefined();
    expect(note).toContain(result.featureKey!);
    expect(note).toContain(`${result.storyKeys[0]!} — KAN-11`);
    // The story that gave no key is not in the list, and the count says
    // two of three rather than all of them.
    expect(note).not.toContain(result.storyKeys[1]!);
    expect(note).toContain("2 of the 3");
    // And what is about to happen to them (EO-127): the plan's wording
    // is replaced by Jira's on the pull that follows, which reads as EO
    // losing the submission unless the thread said it was coming.
    expect(note).toMatch(/being read in from Jira/i);
  });

  it("marks every linked item for the pull that brings its issue in (EO-127)", () => {
    // The whole plan at once. `submitPlan` is a synchronous write path
    // and calls nothing, so what it leaves behind is a marker per
    // attached item for the schedule to drain.
    const result = submitPlan(
      handle.db,
      undefined,
      plan({ jiraKey: "KAN-10", stories: [story("Groundwork", { jira_key: "KAN-11" }), story("Builds on it")] }),
    );

    expect(isJiraPullPending(handle.db, getItemByKey(handle.db, result.featureKey!)!.id)).toBe(true);
    expect(isJiraPullPending(handle.db, getItemByKey(handle.db, result.storyKeys[0]!)!.id)).toBe(true);
    // The story that named no issue has nothing to read.
    expect(isJiraPullPending(handle.db, getItemByKey(handle.db, result.storyKeys[1]!)!.id)).toBe(false);
  });

  it("marks nothing on a plan submitted with sync off, and promises nothing either", () => {
    const result = submitPlan(
      handle.db,
      undefined,
      plan({ jiraKey: "KAN-10", jiraSync: false, stories: [story("Groundwork", { jira_key: "KAN-11" })] }),
    );

    expect(isJiraPullPending(handle.db, getItemByKey(handle.db, result.featureKey!)!.id)).toBe(false);
    expect(isJiraPullPending(handle.db, getItemByKey(handle.db, result.storyKeys[0]!)!.id)).toBe(false);
    // And the link note says nothing about a backfill, because the note
    // below it — "Jira sync is off for 2 of the 2" — is that story.
    expect(engineNotes(result.featureKey!).some((body) => /being read in from Jira/i.test(body))).toBe(false);
  });

  it("refuses a malformed key, saying what one looks like, and creates nothing", () => {
    const before = listItemsForProject(handle.db, null).length;

    const result = submitPlan(handle.db, undefined, plan({ stories: [story("A", { jira_key: "not-a-key" })] }));

    expect(result.created).toBe(false);
    expect(result.featureKey).toBeNull();
    expect(result.problem).toContain("KAN-123");
    expect(listItemsForProject(handle.db, null).length).toBe(before);
  });

  it("refuses a key an existing item already holds, naming that item, and creates nothing", () => {
    // One issue, one item (the pinned decision on EO-121): `jira/pull.ts`
    // maps a key back to an item, and two claimants make that ambiguous.
    const first = submitPlan(handle.db, undefined, plan({ jiraKey: "KAN-7" }));
    const before = listItemsForProject(handle.db, null).length;

    const second = submitPlan(handle.db, undefined, plan({ stories: [story("A", { jira_key: "kan-7" })] }));

    expect(second.created).toBe(false);
    expect(second.problem).toContain(first.featureKey!);
    expect(second.problem).toContain("KAN-7");
    expect(listItemsForProject(handle.db, null).length).toBe(before);
  });

  it("refuses the same key twice inside one plan, naming both claimants, and creates nothing", () => {
    // Nothing else catches this: `items.jira_key` is not unique in the
    // schema, so both stories would be created and one issue would have
    // two items claiming it. Copying keys down a list is exactly how a
    // submitter mirroring an epic gets it wrong.
    const before = listItemsForProject(handle.db, null).length;

    const result = submitPlan(
      handle.db,
      undefined,
      plan({ stories: [story("First", { jira_key: "KAN-8" }), story("Second", { jira_key: "kan-8" })] }),
    );

    expect(result.created).toBe(false);
    expect(result.problem).toContain("KAN-8");
    expect(result.problem).toContain("Second");
    expect(listItemsForProject(handle.db, null).length).toBe(before);
  });

  it("refuses a key the plan gives to both the feature and one of its stories", () => {
    const before = listItemsForProject(handle.db, null).length;

    const result = submitPlan(handle.db, undefined, plan({ jiraKey: "KAN-9", stories: [story("A", { jira_key: "KAN-9" })] }));

    expect(result.created).toBe(false);
    expect(result.problem).toContain("the feature");
    expect(listItemsForProject(handle.db, null).length).toBe(before);
  });

  it("creates the feature and every story with sync off when the plan says so, and says so once", () => {
    const result = submitPlan(
      handle.db,
      undefined,
      plan({ jiraKey: "KAN-10", jiraSync: false, stories: [story("Groundwork"), story("Builds on it")] }),
    );

    expect(jiraStateOf(getItemByKey(handle.db, result.featureKey!)!).sync).toBe(false);
    for (const key of result.storyKeys) expect(jiraStateOf(getItemByKey(handle.db, key)!).sync).toBe(false);
    // The key stays: off is reversible, and switching it on resumes
    // against the same issue rather than asking for it again.
    expect(jiraStateOf(getItemByKey(handle.db, result.featureKey!)!).key).toBe("KAN-10");
    const silence = engineNotes(result.featureKey!).filter((body) => /sync is off/i.test(body));
    expect(silence).toHaveLength(1);
    expect(silence[0]).toContain("3 of the 3");
  });

  it("keeps a silenced story silent afterwards, rather than only saying it is", () => {
    // The switch is what gates the push, so this is the assertion that
    // the cascade reached the row rather than only the note.
    const projectId = projectWithRepository();

    const result = submitPlan(handle.db, undefined, plan({ projectId, jiraSync: false, stories: [story("Groundwork", { jira_key: "KAN-11" })] }));

    const created = getItemByKey(handle.db, result.storyKeys[0]!)!;
    postComment(handle.db, { itemId: created.id, author: { type: "human" }, body: "Any progress?" });
    expect(pendingPushesForItem(handle.db, created.id, "jira")).toHaveLength(0);
  });

  it("lets a story's own switch override the plan's", () => {
    // Precedence: the story's own `jira_sync`, then the plan's, then on.
    const result = submitPlan(
      handle.db,
      undefined,
      plan({ jiraSync: false, stories: [story("Inherits"), story("Says otherwise", { jira_sync: true })] }),
    );

    expect(jiraStateOf(getItemByKey(handle.db, result.storyKeys[0]!)!).sync).toBe(false);
    expect(jiraStateOf(getItemByKey(handle.db, result.storyKeys[1]!)!).sync).toBe(true);
  });

  it("silences one story without silencing the plan", () => {
    const result = submitPlan(handle.db, undefined, plan({ stories: [story("Talks"), story("Stays quiet", { jira_sync: false })] }));

    expect(jiraStateOf(getItemByKey(handle.db, result.featureKey!)!).sync).toBe(true);
    expect(jiraStateOf(getItemByKey(handle.db, result.storyKeys[0]!)!).sync).toBe(true);
    expect(jiraStateOf(getItemByKey(handle.db, result.storyKeys[1]!)!).sync).toBe(false);
    expect(engineNotes(result.featureKey!).some((body) => /sync is off for 1 of the 3/i.test(body))).toBe(true);
  });

  it("answers every bad key with the problem the tool documents, through the real request path", async () => {
    // The three refusals have to arrive the same way, and only this
    // test proves it: the ones above call `submitPlan` directly and so
    // skip `handleIpcRequest`, which parses the payload first. A format
    // check on the request schema would turn the malformed case — and
    // only that case — into an `Invalid request payload` envelope, so
    // `work_submit_plan`'s refusal ("Nothing was created … fix the plan
    // and send it again") would never render and the submitter would be
    // told its transport was wrong rather than which key was.
    submitPlan(handle.db, undefined, plan({ jiraKey: "KAN-7" }));
    const before = listItemsForProject(handle.db, null).length;

    const bad = [
      { label: "malformed", payload: plan({ stories: [story("A", { jira_key: "not-a-key" })] }) },
      { label: "already held", payload: plan({ jiraKey: "KAN-7" }) },
      { label: "twice in one plan", payload: plan({ stories: [story("A", { jira_key: "KAN-8" }), story("B", { jira_key: "KAN-8" })] }) },
    ];

    for (const { label, payload } of bad) {
      const result = await handleIpcRequest("work:submitPlan", payload, (parsed) => submitPlan(handle.db, undefined, parsed), {
        exposeErrorDetails: true,
      });

      // `ok: true` is the point: a refused plan is an answer, not a
      // failed request.
      expect(result.ok, label).toBe(true);
      expect(result.ok && result.data.created, label).toBe(false);
      expect(result.ok && result.data.featureKey, label).toBeNull();
      expect(result.ok && result.data.problem, label).toBeTruthy();
      expect(listItemsForProject(handle.db, null).length, label).toBe(before);
    }
  });

  it("tells a submitter what a Jira key looks like when its plan carried something else", async () => {
    // The sentence has to survive the round trip, not just exist: this
    // is the only thing the submitter has to fix the plan with.
    const result = await handleIpcRequest(
      "work:submitPlan",
      plan({ stories: [story("A", { jira_key: "https://acme.atlassian.net/browse/KAN-1" })] }),
      (parsed) => submitPlan(handle.db, undefined, parsed),
      { exposeErrorDetails: true },
    );

    expect(result.ok && result.data.problem).toContain("KAN-123");
  });

  it("leaves a plan that mentions neither field exactly as it was", () => {
    const result = submitPlan(handle.db, undefined, plan());

    const feature = getItemByKey(handle.db, result.featureKey!)!;
    expect(jiraStateOf(feature).key).toBeNull();
    expect(jiraStateOf(feature).sync).toBe(true);
    expect(jiraStateOf(getItemByKey(handle.db, result.storyKeys[0]!)!).key).toBeNull();
    // The understanding and the decisions are engine notes too, so the
    // assertion is that none of them mention Jira — not that there are
    // none.
    expect(engineNotes(result.featureKey!).some((body) => /jira/i.test(body))).toBe(false);
  });
});

/**
 * A base branch per story (EO-364): written onto the story's `git`
 * extension as it is created, so it is there before the first dispatch,
 * and refused — with nothing created — wherever it could not be honoured.
 */
describe("a plan naming a base branch for a story", () => {
  function projectWithRepository(): Uuid {
    const repository = attachWorkspace(handle.db, { name: "svc", keyPrefix: "SVC", repoPath: "/tmp/svc" });
    return projectForWorkspace(handle.db, repository.id)!.id;
  }

  it("writes it onto that story, and only that story, as it is created", () => {
    const projectId = projectWithRepository();

    const result = submitPlan(handle.db, undefined, plan({ projectId, stories: [story("On the release", { base_branch: " release/2.4 " }), story("On main")] }));

    expect(result.created).toBe(true);
    expect(gitStateOf(getItemByKey(handle.db, result.storyKeys[0]!)!)).toEqual({ branch: null, pullRequest: null, baseBranch: "release/2.4", namedBranch: false, attachedAt: null, reference: null, reviewers: null });
    expect(gitStateOf(getItemByKey(handle.db, result.storyKeys[1]!)!).baseBranch).toBeNull();
    // The feature carries no code and no base.
    expect(gitStateOf(getItemByKey(handle.db, result.featureKey!)!).baseBranch).toBeNull();
  });

  it("refuses a name git would not take, naming the story, and creates nothing", () => {
    const projectId = projectWithRepository();
    const before = listItemsForProject(handle.db, projectId).length;

    const result = submitPlan(handle.db, undefined, plan({ projectId, stories: [story("On the release", { base_branch: "the release branch" })] }));

    expect(result.created).toBe(false);
    expect(result.problem).toContain('"On the release"');
    expect(result.problem).toContain("space");
    expect(listItemsForProject(handle.db, projectId)).toHaveLength(before);
  });

  it("refuses a story that would land where no branch is cut, and creates nothing", () => {
    // No repository at all: the story's work happens on no disk.
    const before = listItemsForProject(handle.db, null).length;

    const result = submitPlan(handle.db, undefined, plan({ stories: [story("On the release", { base_branch: "release/2.4" })] }));

    expect(result.created).toBe(false);
    expect(result.problem).toContain("release/2.4");
    expect(result.problem).toContain("does not work on a branch");
    expect(listItemsForProject(handle.db, null)).toHaveLength(before);
  });
});

/**
 * An existing branch per story (EO-365): written as the story's branch,
 * marked as the person's, in the same insert.
 */
describe("a plan naming an existing branch for a story", () => {
  it("writes it onto that story as its named branch", () => {
    const repository = attachWorkspace(handle.db, { name: "svc", keyPrefix: "SVC", repoPath: "/tmp/svc" });
    const projectId = projectForWorkspace(handle.db, repository.id)!.id;

    const result = submitPlan(handle.db, undefined, plan({ projectId, stories: [story("On my branch", { existing_branch: "feature/limits" }), story("Fresh")] }));

    expect(result.created).toBe(true);
    expect(gitStateOf(getItemByKey(handle.db, result.storyKeys[0]!)!)).toEqual({ branch: "feature/limits", pullRequest: null, baseBranch: null, namedBranch: true, attachedAt: null, reference: null, reviewers: null });
    expect(gitStateOf(getItemByKey(handle.db, result.storyKeys[1]!)!).branch).toBeNull();
  });

  it("refuses a name git would not take, naming the story, and creates nothing", () => {
    const before = listItemsForProject(handle.db, null).length;

    const result = submitPlan(handle.db, undefined, plan({ stories: [story("On my branch", { existing_branch: "my branch" })] }));

    expect(result.created).toBe(false);
    expect(result.problem).toContain('"On my branch"');
    expect(listItemsForProject(handle.db, null)).toHaveLength(before);
  });

  it("refuses a story that would land where no branch is cut, and creates nothing", () => {
    const before = listItemsForProject(handle.db, null).length;

    const result = submitPlan(handle.db, undefined, plan({ stories: [story("On my branch", { existing_branch: "feature/limits" })] }));

    expect(result.created).toBe(false);
    expect(result.problem).toContain("does not work on a branch");
    expect(listItemsForProject(handle.db, null)).toHaveLength(before);
  });
});

describe("a story's own fields in a submitted plan (EO-735)", () => {
  const AUTOMERGE: SpecFieldDraft = { name: "automerge", kind: "boolean", required: false };

  it("stores an added field a story sends in spec, and a story without it is valid", async () => {
    addFieldsTo("story", [AUTOMERGE]);

    // Through the channel, so the schema is shown to keep `spec` rather than strip it.
    const result = await handleIpcRequest(
      "work:submitPlan",
      plan({ stories: [story("Merges itself", { spec: { automerge: true } }), story("Says nothing")] }),
      (parsed) => submitPlan(handle.db, undefined, parsed),
      { exposeErrorDetails: true },
    );

    expect(result).toMatchObject({ ok: true, data: { created: true } });
    const keys = result.ok ? result.data.storyKeys : [];
    expect(getItemByKey(handle.db, keys[0]!)?.spec).toMatchObject({ automerge: true, acceptance_criteria: ["Merges itself is demonstrably done"] });
    expect(getItemByKey(handle.db, keys[1]!)?.spec ?? {}).not.toHaveProperty("automerge");
  });

  it("refuses the whole plan for a value of the wrong kind, naming the field", () => {
    addFieldsTo("story", [AUTOMERGE]);
    const before = listItemsForProject(handle.db, null).length;

    const result = submitPlan(handle.db, undefined, plan({ stories: [story("Merges itself", { spec: { automerge: "yes" } })] }));

    expect(result.created).toBe(false);
    expect(result.problem).toContain("automerge");
    expect(listItemsForProject(handle.db, null)).toHaveLength(before);
  });
});
