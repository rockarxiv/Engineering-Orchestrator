import type { Agent, RefineOutput, Item, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { comments } from "../db/schema.js";
import { createRun, listAgents, listItems, updateRun } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { latestProposal, postRefineProposal } from "./proposal.js";

let handle: DbHandle;
let feature: Item;
let po: Agent;

const PLAN: RefineOutput = {
  stories: [
    { title: "Count requests", body: "Track calls per key.", acceptance_criteria: ["counts per key"], touches: ["src/count.ts"], depends_on: [] },
    { title: "Return 429", body: "Reject when over.", acceptance_criteria: ["429 with Retry-After"], touches: ["src/respond.ts"], depends_on: [0] },
  ],
};

beforeEach(() => {
  handle = openMigratedTestDb();
  feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null });
  po = listAgents(handle.db).find((agent) => agent.role === "system")!;
});

afterEach(() => {
  handle.close();
});

/** A finished refine run, as the supervisor persists one. */
function refineRun(plan: unknown = PLAN): Uuid {
  const run = createRun(handle.db, { itemId: feature.id, agentId: po.id, action: "refine", status: "queued" });
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: "", parsed: plan } });
  return run.id;
}

function engineComments() {
  return handle.db.select().from(comments).all();
}

describe("posting a proposal", () => {
  it("posts the plan and creates no items", () => {
    // The shortcut this story removes: stories used to exist before
    // anyone had seen the plan, let alone agreed to it.
    postRefineProposal(handle.db, feature, po.id, refineRun(), PLAN);

    expect(listItems(handle.db).filter((item) => item.parentId === feature.id)).toEqual([]);
    const proposal = latestProposal(handle.db, feature.id);
    expect(proposal?.body).toContain("Count requests");
    expect(proposal?.body).toContain("Return 429");
  });

  it("asks the human to look at it", () => {
    postRefineProposal(handle.db, feature, po.id, refineRun(), PLAN);

    // A plan nobody is told about is a plan nobody approves.
    expect(latestProposal(handle.db, feature.id)).toBeDefined();
    expect(engineComments()[0]?.kind).toBe("decision");
  });

  it("says so when a child of the plan could not be read, rather than posting a shorter plan", () => {
    // `refineChildren` skips an entry it cannot read. A plan quietly one
    // child shorter is work the agent did and nobody approved, and a
    // plan with nothing left is a run that reported success with no
    // comment at all — the container would sit at the refine step
    // looking finished. Both end in a rejection naming what happened
    // (invariant 8).
    const partly = { children: [{ type: "story", title: "Readable", body: "", acceptance_criteria: ["it works"], depends_on: [] }, { type: "story", body: "no title" }] };

    postRefineProposal(handle.db, feature, po.id, refineRun(partly), partly);

    expect(latestProposal(handle.db, feature.id)).toBeUndefined();
    expect(engineComments()[0]?.kind).toBe("rejection");
    expect(engineComments()[0]?.body).toContain("could not read");
    expect(engineComments()[0]?.body).toContain("1 of the 2");
  });

  it("says so when the whole plan could not be read", () => {
    const unreadable = { children: [{ type: "story", body: "no title" }] };

    postRefineProposal(handle.db, feature, po.id, refineRun(unreadable), unreadable);

    expect(latestProposal(handle.db, feature.id)).toBeUndefined();
    expect(engineComments()[0]?.kind).toBe("rejection");
    expect(engineComments()[0]?.body).toContain("could not read");
  });

  it("never offers an unbuildable plan for approval", () => {
    // Both stories touch the same file and one already depends on the
    // other, so the derived edge closes a loop. There is nothing to
    // approve — only something to redo.
    const cyclic: RefineOutput = {
      stories: [
        { title: "A", body: "", acceptance_criteria: ["it works"], touches: ["src/same.ts"], depends_on: [1] },
        { title: "B", body: "", acceptance_criteria: ["it works"], touches: ["src/same.ts"], depends_on: [] },
      ],
    };

    postRefineProposal(handle.db, feature, po.id, refineRun(cyclic), cyclic);

    expect(latestProposal(handle.db, feature.id)).toBeUndefined();
    expect(engineComments()[0]?.body).toContain("cycle");
    expect(engineComments()[0]?.kind).toBe("rejection");
  });
});

/*
 * Approving a plan, asking for a revision, and the bug/story
 * classification short-circuit used to be tested here. All three were the
 * *pipeline-side* gate: a feature parked on `pending_approval` with its
 * plan in the thread, approved or sent back from the item screen.
 *
 * That gate moved rather than went (ARCHITECTURE.md, "A column is a responsibility, not a status")
 * — it is Discussions' Create item
 * button now, and `discussion.test.ts` covers it there. What is left in this
 * file is the half that is still true wherever a `refine` step runs: the
 * plan is posted as a comment, no items are created, and an unbuildable
 * plan is never offered as one.
 */
