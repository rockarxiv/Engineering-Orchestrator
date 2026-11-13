import { EMPTY_SPEC_SHAPE, jiraStateOf, type IpcPayload, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  getItemByKey,
  listDependencies,
  isJiraPullPending,
  listCommentsForItem,
  listItemsForProject,
  pendingPushesForItem,
  postComment,
  projectForWorkspace,
  setJiraSync,
  syncItemTypes,
} from "../db/repos/index.js";
import { attachWorkspace, openMigratedTestDb } from "../db/testHelpers.js";
import { submitPlan } from "./planCommands.js";
import { submitItem } from "./itemCommands.js";

let handle: DbHandle;

function bug(overrides: Partial<IpcPayload<"work:submitItem">> = {}): IpcPayload<"work:submitItem"> {
  return {
    type: "bug",
    title: "Importer stops after the first page",
    body: "Only the first 50 issues arrive.",
    acceptanceCriteria: [],
    touches: [],
    dependsOn: [],
    stepsToReproduce: "Import a Jira epic with 120 children.",
    expected: "All 120 arrive.",
    actual: "50 arrive and it stops silently.",
    environment: "EO 0.0.0, Linux, Jira Cloud.",
    ...overrides,
  };
}

function story(overrides: Partial<IpcPayload<"work:submitItem">> = {}): IpcPayload<"work:submitItem"> {
  return {
    ...bug(),
    type: "story",
    title: "Page the importer",
    acceptanceCriteria: ["Every child of the epic is imported."],
    stepsToReproduce: "",
    expected: "",
    actual: "",
    environment: "",
    ...overrides,
  };
}

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

describe("handing over a single item", () => {
  it("creates a bug as a bug, on a pipeline", () => {
    // The case that exposed this gap: asking for a bug used to produce a
    // feature with a story under it, and report success.
    const result = submitItem(handle.db, undefined, bug());

    expect(result.created).toBe(true);
    const created = getItemByKey(handle.db, result.key!);
    expect(created?.type).toBe("bug");
    expect(created?.stepId).not.toBeNull();
  });

  it("takes { item, wait, step } in dependsOn beside a bare key, and refuses a step the item's pipeline lacks (EO-777)", () => {
    const first = getItemByKey(handle.db, submitItem(handle.db, undefined, story({ title: "First" })).key!)!;
    const second = getItemByKey(handle.db, submitItem(handle.db, undefined, story({ title: "Second" })).key!)!;

    const result = submitItem(handle.db, undefined, story({ title: "Third", dependsOn: [first.key, { item: second.key, wait: "reached", step: "review" }] }));

    expect(result.problem).toBeNull();
    const third = getItemByKey(handle.db, result.key!)!;
    expect(listDependencies(handle.db, third.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dependsOnId: first.id, wait: "finished", waitStepId: null }),
        expect.objectContaining({ dependsOnId: second.id, wait: "reached", waitStepId: "review" }),
      ]),
    );

    const refused = submitItem(handle.db, undefined, story({ title: "Fourth", dependsOn: [{ item: second.key, wait: "reached", step: "Deploy" }] }));
    expect(refused.created).toBe(false);
    expect(refused.problem).toContain(`${second.key}'s pipeline has no step "Deploy"`);
  });

  it("creates a story as a story", () => {
    const result = submitItem(handle.db, undefined, story());

    expect(getItemByKey(handle.db, result.key!)?.type).toBe("story");
  });

  it("refuses an underspecified bug, naming what is missing", () => {
    // A bug filed this way never meets intake, and the pinned decision
    // is that an underspecified bug report is not accepted. Arriving
    // through a different door does not make it acceptable.
    const result = submitItem(handle.db, undefined, bug({ expected: "", environment: "  " }));

    expect(result.created).toBe(false);
    expect(result.problem).toContain("expected");
    expect(result.problem).toContain("environment");
    expect(result.problem).not.toContain("actual");
  });

  it("refuses a story with no acceptance criteria", () => {
    const result = submitItem(handle.db, undefined, story({ acceptanceCriteria: [] }));

    expect(result.created).toBe(false);
    expect(result.problem).toContain("acceptance criterion");
  });

  it("files it under a feature that exists", () => {
    const plan = submitPlan(handle.db, undefined, {
      title: "Importing",
      understanding: "We agreed to make the importer complete.",
      decisions: [],
      stories: [{ title: "Groundwork", body: "b", acceptance_criteria: ["done"], depends_on: [], touches: [] }],
    });

    const result = submitItem(handle.db, undefined, bug({ parent: plan.featureKey! }));

    expect(result.created).toBe(true);
    const created = getItemByKey(handle.db, result.key!);
    expect(created?.parentId).toBe(getItemByKey(handle.db, plan.featureKey!)?.id);
  });

  it("refuses a parent whose type is not a container", () => {
    // `parentId` means "story → its feature" everywhere else, and a
    // feature's progress walks exactly one level.
    const first = submitItem(handle.db, undefined, story());

    const result = submitItem(handle.db, undefined, bug({ parent: first.key! }));

    expect(result.created).toBe(false);
    expect(result.problem).toContain("not a container");
  });

  /**
   * The channel takes a type slug now rather than one of two words
   * (KAN-146), so both of the enum's refusals have to be made by the
   * handler — and made as `problem` on a successful call, which is what a
   * tool's caller reads, rather than as a malformed payload.
   */
  it("refuses a slug this project has no type for, naming what it does have", () => {
    const result = submitItem(handle.db, undefined, bug({ type: "incident" }));

    expect(result.created).toBe(false);
    expect(result.problem).toContain('"incident"');
    expect(result.problem).toContain("story");
  });

  it("refuses a container, because a container with nothing under it is not work", () => {
    const result = submitItem(handle.db, undefined, bug({ type: "feature" }));

    expect(result.created).toBe(false);
    expect(result.problem).toContain("work_submit_plan");
    expect(listItemsForProject(handle.db, null)).toEqual([]);
  });

  it("files a leaf type another pack shipped as that type (KAN-146)", () => {
    // The reason the enum had to go: a pack's own leaf type was
    // unfileable through this channel, and the closest word — `bug` —
    // would have created the wrong kind of item and reported success.
    syncItemTypes(handle.db, [{ packSlug: "planning", slug: "task", label: "Task", plural: "Tasks", container: false, specShape: EMPTY_SPEC_SHAPE, actionOverrides: {} }]);

    const result = submitItem(handle.db, undefined, bug({ type: "task" }));

    expect(result.created).toBe(true);
    const created = getItemByKey(handle.db, result.key!)!;
    expect(created.type).toBe("task");
    expect(created.container).toBe(false);
  });

  /**
   * A type nobody wrote code for, held to its own fields (KAN-147).
   *
   * The two checks this replaced were a story's one criterion and a bug's
   * four reproduction fields, written out in this handler. A pack shipping
   * a `Case` with a customer and a channel was held to neither — it could
   * be filed empty, and the first thing to notice would be whoever opened
   * it. Its shape is the check now, and the refusal names what is missing
   * by the name the shape gave it.
   */
  describe("a type this code has never heard of", () => {
    const CASE = {
      packSlug: "support",
      slug: "case",
      label: "Case",
      plural: "Cases",
      container: false,
      specShape: {
        type: "object" as const,
        properties: {
          customer: { type: "string" as const, minLength: 1 },
          channel: { type: "string" as const, enum: ["email", "phone", "chat"] },
        },
        required: ["customer", "channel"],
      },
      actionOverrides: {},
    };

    beforeEach(() => {
      syncItemTypes(handle.db, [CASE]);
    });

    it("refuses one that arrives without the fields its shape demands", () => {
      const result = submitItem(handle.db, undefined, bug({ type: "case", spec: { channel: "email" } }));

      expect(result.created).toBe(false);
      expect(result.problem).toContain("customer");
      expect(result.problem).not.toContain("channel");
      expect(listItemsForProject(handle.db, null)).toEqual([]);
    });

    it("refuses a value its shape does not allow, which no hand-written check ever did", () => {
      // `enum` is the shape's, and the validator's: a channel nobody
      // supports is as much a malformed case as a missing customer, and
      // the four kinds a person picks from in the editor cannot express
      // that any other way.
      const result = submitItem(handle.db, undefined, bug({ type: "case", spec: { customer: "ACME", channel: "carrier pigeon" } }));

      expect(result.created).toBe(false);
      expect(result.problem).toContain("channel");
    });

    it("files one that arrives complete, holding exactly what it was sent", () => {
      const result = submitItem(handle.db, undefined, bug({ type: "case", spec: { customer: "ACME", channel: "email" } }));

      expect(result.problem).toBeNull();
      const created = getItemByKey(handle.db, result.key!)!;
      expect(created.type).toBe("case");
      expect(created.spec).toMatchObject({ customer: "ACME", channel: "email" });
    });

    it("refuses a field the shape closes itself against, which is an issue about no field at all", () => {
      // A type may close its shape, and then the validator's complaint
      // has no property to hang off: ajv reports `additionalProperties`
      // at the root. Reading only the issues that name a declared field
      // would drop it, and the item would be created against a shape
      // that refuses it — the JSON Schema is the authority on what a
      // valid spec is, or it is not the authority at all.
      const closed = {
        ...CASE,
        slug: "sealed",
        specShape: { ...CASE.specShape, additionalProperties: false },
      };
      syncItemTypes(handle.db, [closed]);

      const result = submitItem(handle.db, undefined, bug({ type: "sealed", spec: { customer: "ACME", channel: "email", invented: "no" } }));

      expect(result.created).toBe(false);
      // The validator's own words, at the path it reported them: EO has
      // no better sentence for a rule a pack wrote than the one the
      // shape effectively wrote itself.
      expect(result.problem).toContain("additional properties");
      expect(listItemsForProject(handle.db, null)).toEqual([]);
    });

    it("accepts a closed shape's item that EO put its own `touches` on", () => {
      // `touches` is EO's, not the type's: the paths the overlap check
      // serialises colliding work against, in the one open bag an item
      // has because there is no column for them. A shape that closes
      // itself is saying what fields *it* has — judging the pack by a
      // key EO added would refuse an ordinary hand-over for EO's own
      // doing.
      const closed = { ...CASE, slug: "sealed", specShape: { ...CASE.specShape, additionalProperties: false } };
      syncItemTypes(handle.db, [closed]);

      const result = submitItem(
        handle.db,
        undefined,
        bug({ type: "sealed", spec: { customer: "ACME", channel: "email" }, touches: ["support/acme.md"] }),
      );

      expect(result.problem).toBeNull();
      const created = getItemByKey(handle.db, result.key!)!;
      // Stored where the overlap check reads it, all the same.
      expect(created.spec).toMatchObject({ customer: "ACME", channel: "email", touches: ["support/acme.md"] });
    });

    it("holds a type that declares `touches` itself to its own rules for it", () => {
      // The other half: a pack may put `touches` in its shape, and then
      // it owns the field — the value is demanded, validated and stored
      // like any other of its own.
      const owning = {
        ...CASE,
        slug: "tracked",
        specShape: {
          type: "object" as const,
          properties: { touches: { type: "array" as const, items: { type: "string" as const }, minItems: 1 } },
          required: ["touches"],
        },
      };
      syncItemTypes(handle.db, [owning]);

      expect(submitItem(handle.db, undefined, bug({ type: "tracked", touches: [] })).problem).toContain("touches");
      const result = submitItem(handle.db, undefined, bug({ type: "tracked", touches: ["support/acme.md"] }));
      expect(result.problem).toBeNull();
      expect(getItemByKey(handle.db, result.key!)?.spec).toMatchObject({ touches: ["support/acme.md"] });
    });

    it("still names what is missing when something is, rather than reciting the validator", () => {
      // Both kinds of issue on one submission: the missing field is what
      // a person acts on, so that is the sentence they get.
      const closed = {
        ...CASE,
        slug: "sealed",
        specShape: { ...CASE.specShape, additionalProperties: false },
      };
      syncItemTypes(handle.db, [closed]);

      const result = submitItem(handle.db, undefined, bug({ type: "sealed", spec: { channel: "email", invented: "no" } }));

      expect(result.created).toBe(false);
      expect(result.problem).toContain("customer");
    });

    it("answers for the bug fields it accepted and has nowhere to put", () => {
      // The flat payload declares every type's fields side by side, so a
      // `case` can be sent a bug's. Invariant 8: accepted and not stored
      // is something the thread has to say, by name.
      const result = submitItem(handle.db, undefined, bug({ type: "case", spec: { customer: "ACME", channel: "chat" } }));

      const created = getItemByKey(handle.db, result.key!)!;
      expect(created.spec).not.toHaveProperty("expected");
      expect(listCommentsForItem(handle.db, created.id).map((comment) => comment.body).join("\n")).toContain("expected");
    });
  });

  it("refuses a pipeline the project does not have, and creates nothing", () => {
    const before = listItemsForProject(handle.db, null).length;

    const result = submitItem(handle.db, undefined, bug({ pipeline: "deploy" }));

    expect(result.created).toBe(false);
    expect(result.problem).toContain('no pipeline called "deploy"');
    expect(listItemsForProject(handle.db, null).length).toBe(before);
  });

  it("refuses a dependency that does not exist", () => {
    const result = submitItem(handle.db, undefined, story({ dependsOn: ["EO-9999"] }));

    expect(result.created).toBe(false);
    expect(result.problem).toContain("EO-9999");
  });
});

/**
 * An item that is already an issue in Jira (EO-123).
 *
 * The case this was missing: an agent outside EO hands over a bug that
 * is already filed, and until now there was no field to say so — the
 * item arrived unlinked and somebody had to notice and attach the key
 * by hand. Attaching here is still a local write — format and
 * uniqueness are checked and nothing calls Jira, which is the pinned
 * decision on EO-121 — but it now marks the item for the pull the
 * schedule does next (EO-127), so the issue's words arrive without
 * anybody asking for them.
 */
describe("handing over an item that already exists in Jira", () => {
  /** A project with a repository on it — what a push needs before it can be queued at all. */
  function projectWithRepository(): Uuid {
    const repository = attachWorkspace(handle.db, { name: "svc", keyPrefix: "SVC", repoPath: "/tmp/svc" });
    return projectForWorkspace(handle.db, repository.id)!.id;
  }

  function engineNotes(key: string): string[] {
    const item = getItemByKey(handle.db, key)!;
    return listCommentsForItem(handle.db, item.id)
      .filter((comment) => comment.authorType === "engine")
      .map((comment) => comment.body);
  }

  it("creates the item mirroring that issue", () => {
    const result = submitItem(handle.db, undefined, bug({ jiraKey: "KAN-123" }));

    expect(result.created).toBe(true);
    expect(jiraStateOf(getItemByKey(handle.db, result.key!)!).key).toBe("KAN-123");
  });

  it("says on the item which issue it now mirrors, and that the issue is being read in", () => {
    // Invariant 8, and the sentence people actually need since EO-127:
    // the title and body just submitted may be replaced by Jira's within
    // the minute, which reads as EO losing the submission unless the
    // thread said it was coming.
    const result = submitItem(handle.db, undefined, bug({ jiraKey: "KAN-123" }));

    const notes = engineNotes(result.key!);
    expect(notes.some((body) => body.includes("KAN-123"))).toBe(true);
    expect(notes.some((body) => /being brought in/i.test(body))).toBe(true);
  });

  it("marks the item for the pull that brings the issue in (EO-127)", () => {
    // The marker, not the request: `submitItem` is a synchronous write
    // path and must not call Jira, so what it leaves behind is the
    // intent, and the pull schedule is what acts on it.
    const result = submitItem(handle.db, undefined, bug({ jiraKey: "KAN-123" }));

    const created = getItemByKey(handle.db, result.key!)!;
    expect(isJiraPullPending(handle.db, created.id)).toBe(true);
  });

  it("marks nothing when the item arrives with sync switched off", () => {
    // The point of the switch: an item that does not talk to Jira does
    // not read from it either, so there is nothing to drain and the note
    // promises nothing.
    const result = submitItem(handle.db, undefined, bug({ jiraKey: "KAN-123", jiraSync: false }));

    const created = getItemByKey(handle.db, result.key!)!;
    expect(isJiraPullPending(handle.db, created.id)).toBe(false);
    expect(engineNotes(result.key!).some((body) => /being brought in/i.test(body))).toBe(false);
  });

  it("leaves an item that named no issue unmarked", () => {
    // The ordinary submission, which must not have grown a Jira read.
    const result = submitItem(handle.db, undefined, bug({}));

    expect(isJiraPullPending(handle.db, getItemByKey(handle.db, result.key!)!.id)).toBe(false);
  });

  it("stores the canonical spelling of a key that was pasted", () => {
    // `findByJiraKey` and `jira/pull.ts` match exactly, so what is stored
    // has to be what Jira calls the issue — not what a paste carried.
    const result = submitItem(handle.db, undefined, bug({ jiraKey: "  kan-9 " }));

    expect(jiraStateOf(getItemByKey(handle.db, result.key!)!).key).toBe("KAN-9");
  });

  it("refuses a malformed key, saying what one looks like, and creates nothing", () => {
    const before = listItemsForProject(handle.db, null).length;

    const result = submitItem(handle.db, undefined, bug({ jiraKey: "not-a-key" }));

    expect(result.created).toBe(false);
    expect(result.key).toBeNull();
    expect(result.problem).toContain("KAN-123");
    expect(listItemsForProject(handle.db, null).length).toBe(before);
  });

  it("refuses a key another item already holds, naming that item, and creates nothing", () => {
    // One issue, one item (the pinned decision on EO-121): `jira/pull.ts`
    // maps a key back to an item, and two claimants make that ambiguous.
    const first = submitItem(handle.db, undefined, bug({ jiraKey: "KAN-7" }));
    const before = listItemsForProject(handle.db, null).length;

    const second = submitItem(handle.db, undefined, story({ jiraKey: "kan-7" }));

    expect(second.created).toBe(false);
    expect(second.problem).toContain(first.key!);
    expect(second.problem).toContain("KAN-7");
    expect(listItemsForProject(handle.db, null).length).toBe(before);
  });

  it("creates it with sync off when asked, says so, and queues nothing for Jira", () => {
    const projectId = projectWithRepository();

    const result = submitItem(handle.db, undefined, bug({ projectId, jiraKey: "KAN-4", jiraSync: false }));

    const created = getItemByKey(handle.db, result.key!)!;
    expect(jiraStateOf(created).sync).toBe(false);
    // The key stays: off is reversible, and switching it on resumes
    // against the same issue rather than asking for it again.
    expect(jiraStateOf(created).key).toBe("KAN-4");
    expect(engineNotes(result.key!).some((body) => /sync is off/i.test(body))).toBe(true);
    expect(pendingPushesForItem(handle.db, created.id, "jira")).toHaveLength(0);

    // And it stays silent afterwards: a comment on a linked item is
    // the push that would otherwise be queued.
    postComment(handle.db, { itemId: created.id, author: { type: "human" }, body: "Still broken." });
    expect(pendingPushesForItem(handle.db, created.id, "jira")).toHaveLength(0);
  });

  it("leaves an item submitted without the switch talking to Jira", () => {
    // The other half of the test above — without it, "nothing was
    // queued" would pass just as well on a path that can never queue.
    const projectId = projectWithRepository();

    const result = submitItem(handle.db, undefined, bug({ projectId, jiraKey: "KAN-5" }));

    const created = getItemByKey(handle.db, result.key!)!;
    expect(jiraStateOf(created).sync).toBe(true);
    postComment(handle.db, { itemId: created.id, author: { type: "human" }, body: "Still broken." });
    expect(pendingPushesForItem(handle.db, created.id, "jira")).toHaveLength(1);
  });

  it("gives a story under a silenced feature the feature's switch when the submission says nothing", () => {
    // Inherited at creation and copied onto the row, so what an item
    // does is readable off that item (the pinned decision on EO-121).
    const plan = submitPlan(handle.db, undefined, {
      title: "Importing",
      understanding: "We agreed to make the importer complete.",
      decisions: [],
      stories: [{ title: "Groundwork", body: "b", acceptance_criteria: ["done"], depends_on: [], touches: [] }],
    });
    setJiraSync(handle.db, getItemByKey(handle.db, plan.featureKey!)!.id, false);

    const result = submitItem(handle.db, undefined, story({ parent: plan.featureKey! }));

    expect(jiraStateOf(getItemByKey(handle.db, result.key!)!).sync).toBe(false);
    // And it is said on the story, not left to be discovered: nobody
    // asked for silence on this item, so the first sign would
    // otherwise be Jira going quiet.
    expect(engineNotes(result.key!).some((body) => /sync is off/i.test(body))).toBe(true);
  });

  it("leaves a submission that mentions neither field exactly as it was", () => {
    const result = submitItem(handle.db, undefined, bug());

    const created = getItemByKey(handle.db, result.key!)!;
    expect(jiraStateOf(created).key).toBeNull();
    expect(jiraStateOf(created).sync).toBe(true);
    expect(engineNotes(result.key!)).toEqual([]);
  });
});
