import { jiraStateOf, ipcContract, type DiscussionOutput, type IpcPayload, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db, DbHandle } from "../db/client.js";
import {
  addWorkspaceToProject,
  createProject,
  createRun,
  getItem,
  getItemByKey,
  listAgents,
  listCommentsForItem,
  listDependencies,
  updateRun,
} from "../db/repos/index.js";
import { listPipelines } from "../db/repos/pipelineStepsRepo.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { createPerson, findPersonByEmail } from "../db/repos/peopleRepo.js";
import { attachWorkspace, openMigratedTestDb } from "../db/testHelpers.js";
import { applyDiscussionProposal } from "../roles/discussion.js";
import { openAssistConversation, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { updateItemText } from "./domainCommands.js";
import { submitPlan } from "./planCommands.js";
import { submitItem } from "./itemCommands.js";

/**
 * A bug carries acceptance criteria too, and no path drops a field in
 * silence (EO-205).
 *
 * Both creation paths are here in one file deliberately. `new_bug`
 * through a conversation and `work_submit_ticket` through MCP end up in
 * the same `applyNewItem`, and the defect this comes from lived in
 * exactly the gap between them: the storage had no type gate at all, so
 * a bug that already existed could be given criteria by hand, and only
 * the two creation doors dropped them. A fix tested at one door and not
 * the other is the same defect with a smaller blast radius.
 *
 * What it cost, once: EO-204 was filed as a bug with seven criteria,
 * stored none, and took thirteen implement runs and eleven rejections —
 * every one of them opening "this item declares no acceptance
 * criteria" — against two runs for a story filed forty minutes earlier
 * through the same tool.
 */

let handle: DbHandle;

const CRITERIA = ["Clicking logout ends the session.", "The header shows the sign-in link afterwards."];

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

function bug(overrides: Partial<IpcPayload<"work:submitItem">> = {}): IpcPayload<"work:submitItem"> {
  return {
    type: "bug",
    title: "Logout button does nothing",
    body: "Clicking logout leaves the session active.",
    acceptanceCriteria: [],
    touches: [],
    dependsOn: [],
    stepsToReproduce: "Sign in, click Logout in the header.",
    expected: "The session ends.",
    actual: "Nothing happens.",
    environment: "Chrome 128 on macOS 14.",
    ...overrides,
  };
}

function criteriaOf(item: Item): unknown {
  return item.spec?.["acceptance_criteria"];
}

function engineNotes(db: Db, item: Item): string[] {
  return listCommentsForItem(db, item.id)
    .filter((comment) => comment.authorType === "engine")
    .map((comment) => comment.body);
}

// ── The field itself, at both doors ────────────────────────────

describe("a bug filed through work_submit_item", () => {
  it("holds exactly the acceptance criteria it was sent", () => {
    // Asserted against the created row rather than the tool's answer:
    // answering `created: true` while storing nothing is the whole of
    // what this item is about.
    const result = submitItem(handle.db, undefined, bug({ acceptanceCriteria: CRITERIA }));

    expect(result.created).toBe(true);
    expect(criteriaOf(getItemByKey(handle.db, result.key!)!)).toEqual(CRITERIA);
  });

  it("is still created when it carries none, with an empty list", () => {
    // Accepted, not demanded. The four repro fields are what make a bug
    // report usable; a bug nobody wrote a criterion for is still a
    // legitimate bug, and refusing it would lose reports people should
    // be able to file.
    const result = submitItem(handle.db, undefined, bug());

    expect(result.created).toBe(true);
    expect(criteriaOf(getItemByKey(handle.db, result.key!)!)).toEqual([]);
  });

  it("still demands the four repro fields, and only those", () => {
    // The bar for a bug is unchanged: this one is missing a repro field
    // and carries criteria, and it is the repro field it is refused for.
    const result = submitItem(handle.db, undefined, bug({ environment: "  ", acceptanceCriteria: CRITERIA }));

    expect(result.created).toBe(false);
    expect(result.problem).toContain("environment");
    expect(result.problem).not.toContain("acceptance");
  });
});

describe("a bug filed through the conversation path", () => {
  /** One assistant turn proposing a bug, approved — the same two steps the supervisor and `wiring.ts` take. */
  function proposeAndApply(proposal: Record<string, unknown>): { key: string; card: string } {
    const conversation = openAssistConversation(handle.db, null);
    const agent = listAgents(handle.db).find((entry) => entry.role === "system")!;
    const output = { message: "Here it is.", questions: [], proposals: [proposal] } as unknown as DiscussionOutput;

    const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION });
    updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(output), parsed: output } });
    postAssistReply(handle.db, conversation, agent.id, run.id, output);

    const card = listCommentsForItem(handle.db, conversation.id).find((comment) => comment.kind === PROPOSAL_KIND)!;
    const applied = applyDiscussionProposal(handle.db, conversation, card.id as Uuid);
    if (!applied.ok) throw new Error(applied.reason);

    return { key: applied.created[0]!.key, card: card.body };
  }

  const proposal = (extra: Record<string, unknown> = {}) => ({
    action: "new_bug",
    title: "Logout button does nothing",
    body: "Clicking logout leaves the session active.",
    steps_to_reproduce: "Sign in, click Logout in the header.",
    expected: "The session ends.",
    actual: "Nothing happens.",
    environment: "Chrome 128 on macOS 14.",
    ...extra,
  });

  it("holds exactly the acceptance criteria the proposal carried", () => {
    const { key } = proposeAndApply(proposal({ acceptance_criteria: CRITERIA }));

    expect(criteriaOf(getItemByKey(handle.db, key)!)).toEqual(CRITERIA);
  });

  it("is created with an empty list when the proposal carried none", () => {
    const { key } = proposeAndApply(proposal());

    expect(criteriaOf(getItemByKey(handle.db, key)!)).toEqual([]);
  });

  it("lists the criteria on the card the person approves", () => {
    // A person approving a bug has to see everything the approval
    // creates. Criteria that were rendered nowhere would be agreed to
    // by somebody who never read them.
    const { card } = proposeAndApply(proposal({ acceptance_criteria: CRITERIA }));

    expect(card).toContain("**Acceptance criteria:**");
    for (const criterion of CRITERIA) expect(card).toContain(`- ${criterion}`);
  });

  it("leaves the card exactly as it was when there are none", () => {
    // Not a heading over an empty list: a bug is never asked for
    // criteria, and an empty section would read as something missing.
    const { card } = proposeAndApply(proposal());

    expect(card).not.toContain("Acceptance criteria");
    expect(card.trimEnd().endsWith("**Environment:** Chrome 128 on macOS 14.")).toBe(true);
  });
});

describe("editing a bug's criteria afterwards", () => {
  it("still works, and this story added no type gate to it", () => {
    // `items:update` never had one — which is what made the drop a
    // creation-only defect, and is exactly the behaviour that must
    // survive the fix.
    const created = submitItem(handle.db, undefined, bug());
    const itemId = getItemByKey(handle.db, created.key!)!.id;

    const result = updateItemText(handle.db, { itemId, acceptanceCriteria: CRITERIA });

    expect(result.updated).toBe(true);
    expect(criteriaOf(getItem(handle.db, itemId)!)).toEqual(CRITERIA);
  });
});

// ── Invariant 8: nothing accepted is dropped in silence ────────

/**
 * One field of `work:submitItem`, driven with a value and then looked
 * for on the item it created.
 *
 * `carried` answers the only question that matters — is what I sent on
 * this item? A field that answers `false` has to be answered for in
 * the thread instead, and the test below accepts nothing else.
 */
interface FieldProbe {
  /** A distinctive value for this field, and anything that had to exist first. */
  send: (world: World) => Partial<IpcPayload<"work:submitItem">>;
  carried: (world: World, item: Item) => boolean;
}

interface World {
  projectId: Uuid;
  otherProjectId: Uuid;
  pipelineId: string;
  pipelineName: string;
  repositoryId: Uuid;
  otherRepositoryId: Uuid;
  featureKey: string;
  featureId: Uuid;
  dependencyKey: string;
  dependencyId: Uuid;
}

const PROBES: Record<keyof IpcPayload<"work:submitItem">, FieldProbe> = {
  /**
   * Who asked for it (EO-326, ARCHITECTURE.md, "Identity").
   *
   * Not a field a caller fills in — a server's door stamps it from the
   * credential the request arrived on, and the MCP host strips it. It is
   * driven here anyway, and by the same rule as every other field: it
   * reaches the item or the thread says why. What it lands in is
   * `created_by`, which on a desktop is the local person and on a server
   * is whoever signed in.
   */
  actingDeviceId: {
    send: () => {
      const anna = createPerson(handle.db, { name: "Anna", email: "anna@example.com" });
      const device = issueDevice(handle.db, { personId: anna.id, name: "annas-browser", tokenHash: "a-hash", secretsKeyHash: null });
      return { actingDeviceId: device.id };
    },
    carried: (_world, item) => item.createdBy === findPersonByEmail(handle.db, "anna@example.com")?.id,
  },
  projectId: {
    send: (world) => ({ projectId: world.otherProjectId, parent: undefined, repository: undefined }),
    carried: (world, item) => item.projectId === world.otherProjectId,
  },
  pipeline: {
    send: (world) => ({ pipeline: world.pipelineName }),
    carried: (world, item) => item.pipelineId === world.pipelineId,
  },
  type: {
    // Driven by the loop itself: each probe runs once as a story and
    // once as a bug, and the type asked for is the type created.
    send: () => ({}),
    carried: (_world, item) => item.type === "story" || item.type === "bug",
  },
  title: {
    send: () => ({ title: "A title nothing else here uses" }),
    carried: (_world, item) => item.title === "A title nothing else here uses",
  },
  body: {
    send: () => ({ body: "A body nothing else here uses" }),
    carried: (_world, item) => item.body === "A body nothing else here uses",
  },
  parent: {
    send: (world) => ({ parent: world.featureKey }),
    carried: (world, item) => item.parentId === world.featureId,
  },
  repository: {
    send: () => ({ repository: "two" }),
    carried: (world, item) => item.workspaceId === world.otherRepositoryId,
  },
  acceptanceCriteria: {
    send: () => ({ acceptanceCriteria: ["A criterion someone who did not write this could check."] }),
    carried: (_world, item) => JSON.stringify(criteriaOf(item)) === JSON.stringify(["A criterion someone who did not write this could check."]),
  },
  spec: {
    // The generic half of the payload (KAN-147): a field named under the
    // type's own shape rather than through one of the five flat ones. Sent
    // as a criteria list because that is a field both types this is driven
    // with declare — what a type does *not* declare is kept too, which is
    // the channel's documented bargain, but proving that needs a type
    // neither of them is.
    send: () => ({ spec: { acceptance_criteria: ["Named through spec, not through the flat field."] } }),
    carried: (_world, item) => JSON.stringify(criteriaOf(item)) === JSON.stringify(["Named through spec, not through the flat field."]),
  },
  priority: {
    // EO-568: 0 is also what an item gets when nothing is said, so the
    // probe sends a value no default could produce.
    send: () => ({ priority: 2 }),
    carried: (_world, item) => item.priority === 2,
  },
  touches: {
    send: () => ({ touches: ["src/probe.ts"] }),
    carried: (_world, item) => JSON.stringify(item.spec?.["touches"]) === JSON.stringify(["src/probe.ts"]),
  },
  dependsOn: {
    send: (world) => ({ dependsOn: [world.dependencyKey] }),
    carried: (world, item) => listDependencies(handle.db, item.id).some((edge) => edge.dependsOnId === world.dependencyId),
  },
  jiraKey: {
    send: () => ({ jiraKey: "KAN-321" }),
    carried: (_world, item) => jiraStateOf(item).key === "KAN-321",
  },
  jiraSync: {
    send: () => ({ jiraSync: false }),
    carried: (_world, item) => jiraStateOf(item).sync === false,
  },
  stepsToReproduce: {
    send: () => ({ stepsToReproduce: "A repro nothing else here uses" }),
    carried: (_world, item) => item.spec?.["steps_to_reproduce"] === "A repro nothing else here uses",
  },
  expected: {
    send: () => ({ expected: "An expectation nothing else here uses" }),
    carried: (_world, item) => item.spec?.["expected"] === "An expectation nothing else here uses",
  },
  actual: {
    send: () => ({ actual: "An outcome nothing else here uses" }),
    carried: (_world, item) => item.spec?.["actual"] === "An outcome nothing else here uses",
  },
  environment: {
    send: () => ({ environment: "An environment nothing else here uses" }),
    carried: (_world, item) => item.spec?.["environment"] === "An environment nothing else here uses",
  },
};

describe("no field this channel accepts is dropped in silence", () => {
  function build(): World {
    const project = createProject(handle.db, { name: "Svc", keyPrefix: "SVC" });
    const other = createProject(handle.db, { name: "Other", keyPrefix: "OTH" });
    // Two, so `repository` is a choice rather than the only answer —
    // on a single-repository project the name is never consulted and
    // the probe would pass without proving anything.
    const one = attachWorkspace(handle.db, { name: "one", keyPrefix: "ONE", repoPath: "/tmp/one" });
    const two = attachWorkspace(handle.db, { name: "two", keyPrefix: "TWO", repoPath: "/tmp/two" });
    addWorkspaceToProject(handle.db, project.id, one.id);
    addWorkspaceToProject(handle.db, project.id, two.id);

    const pipeline = listPipelines(handle.db, project.id)[0]!;

    const plan = submitPlan(handle.db, undefined, {
      projectId: project.id,
      title: "Importing",
      understanding: "We agreed to make the importer complete.",
      decisions: [],
      stories: [{ title: "Groundwork", body: "b", acceptance_criteria: ["done"], depends_on: [], touches: [], repository: "one" }],
    });

    return {
      projectId: project.id,
      otherProjectId: other.id,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      repositoryId: one.id,
      otherRepositoryId: two.id,
      featureKey: plan.featureKey!,
      featureId: getItemByKey(handle.db, plan.featureKey!)!.id,
      dependencyKey: plan.storyKeys[0]!,
      dependencyId: getItemByKey(handle.db, plan.storyKeys[0]!)!.id,
    };
  }

  function base(world: World, type: "story" | "bug"): IpcPayload<"work:submitItem"> {
    return {
      ...bug({ projectId: world.projectId, repository: "one" }),
      ...(type === "story"
        ? { type, acceptanceCriteria: ["It works, checkably."], stepsToReproduce: "", expected: "", actual: "", environment: "" }
        : { type }),
    };
  }

  it("drives every field the schema declares, and no more", () => {
    // Read off the channel rather than restated, so a field added to
    // `work:submitItem` and to neither branch of the handler fails
    // here rather than being discovered by whoever loses one.
    expect(Object.keys(PROBES).sort()).toEqual(Object.keys(ipcContract["work:submitItem"].request.shape).sort());
  });

  for (const type of ["story", "bug"] as const) {
    for (const [field, probe] of Object.entries(PROBES)) {
      it(`stores or answers for \`${field}\` on a ${type}`, () => {
        const world = build();

        const result = submitItem(handle.db, undefined, { ...base(world, type), ...probe.send(world) });

        expect(result.created).toBe(true);
        const item = getItemByKey(handle.db, result.key!)!;
        if (probe.carried(world, item)) return;

        // Not carried, so the thread has to say so — by name, because a
        // note that does not name the field is not something whoever
        // reads it can act on. This is the invariant-8 half: nothing
        // silently drops work on the floor.
        expect(engineNotes(handle.db, item).join("\n\n")).toContain(field);
      });
    }
  }
});
