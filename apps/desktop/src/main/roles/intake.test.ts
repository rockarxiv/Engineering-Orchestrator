import { sql } from "drizzle-orm";
import { EMPTY_SPEC_SHAPE, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createRoute, createRun, createStep, getItem, getItemType, listAgents, listCommentsForItem, listRunsForItem, syncItemTypes, transitionItem, updateItem } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createScriptedProvider } from "../providers/scripted.js";
import { buildDispatchContext } from "../supervisor/buildDispatchContext.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { postIntakeSummary } from "./intake.js";

/**
 * What intake leaves behind, and where the item goes (KAN-32).
 *
 * Two long-standing gaps meet here. `system-agent.md` (then `product-owner.md`) told intake to
 * record settled decisions as pinned comments — and no agent has ever
 * been able to pin anything, because the comment tool has no `pinned`
 * field. And the same prompt said the human moves the item on, while
 * the code advanced it on every success.
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

const UNDERSTANDING = "Cap anonymous callers at 100 requests a minute, measured per API key over a sliding window.";

let handle: DbHandle;
let item: Item;

function supervisorReturning(result: unknown) {
  return createRunSupervisor({
    db: handle.db,
    limits: LIMITS,
    provider: createScriptedProvider([{ when: (context) => context.includes(`"intake" action`), script: { result } }]),
    ...createRoleWiring(handle.db),
  });
}

function finishing() {
  return supervisorReturning({
    // Named, because intake's shape is composed from the project's item
    // types now and a result with no classification is refused (KAN-147).
    type: "feature",
    ready: true,
    understanding: UNDERSTANDING,
    decisions: [
      { topic: "Scope", decision: "Per API key, not per account." },
      { topic: "Over-limit response", decision: "429 with a Retry-After header." },
    ],
  });
}

beforeEach(() => {
  handle = openMigratedTestDb();
  // `intake` is an action, not a column (ARCHITECTURE.md, "A column is a responsibility, not a
  // status"). The shipped pipeline
  // stopped having a step for it — a conversation drives it now — so this
  // configures one, which is exactly what a person could do and is the
  // only thing these tests need from it.
  createStep(handle.db, { id: "ask", pipelineId: "default" as never, position: -1, name: "Intake", type: "agent", ownerRole: "system", entryAction: "intake" });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "ask", resultKey: "done", label: "Understood", target: "todo", position: 0 });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "ask", resultKey: "classified_non_feature", label: "Already written", target: "todo", position: 1 });
  item = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: "ask" });
});

afterEach(() => {
  handle.close();
});

describe("what intake leaves behind", () => {
  it("pins its understanding, so truncation cannot drop it", async () => {
    await finishing().runOnce();

    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.body === UNDERSTANDING);
    expect(note).toBeDefined();
    expect(note!.pinned, "an unpinned understanding is the first thing a long thread loses").toBe(true);
  });

  it("pins each settled decision separately", async () => {
    // One comment each, not one list: a decision is a thing a human can
    // reply to, disagree with, or unpin on its own.
    await finishing().runOnce();

    const decisions = listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "decision");
    expect(decisions).toHaveLength(2);
    expect(decisions.every((comment) => comment.pinned)).toBe(true);
    expect(decisions[0]!.body).toContain("Per API key, not per account.");
    expect(decisions[1]!.body).toContain("429");
  });

  it("records nothing when nothing was settled", async () => {
    // A feature described clearly the first time genuinely settles
    // nothing, and an invented decision is worse than none.
    await supervisorReturning({ type: "feature", ready: true, understanding: UNDERSTANDING }).runOnce();

    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "decision")).toEqual([]);
  });

  it("interrupts nobody — intake finishing means there is nothing left to ask", async () => {
    await finishing().runOnce();

    for (const comment of listCommentsForItem(handle.db, item.id)) {
      expect(comment.kind).not.toBe("question");
      expect(comment.body).not.toContain("@user");
    }
  });

  it("reaches refine, which is the point of pinning it", async () => {
    // Asserted against the assembled context rather than inferred from a
    // comment existing: the whole failure mode being fixed is a record
    // that exists somewhere the next agent never reads.
    await finishing().runOnce();

    const context = await buildDispatchContext(handle.db, { ...item, stepId: "todo" }, "refine");

    expect(context).toContain(UNDERSTANDING);
    expect(context).toContain("Per API key, not per account.");
  });
});

describe("where intake leaves the item", () => {
  it("advances it, because an answer means there is nothing left to ask", async () => {
    // KAN-32's decision, and the end of a contradiction: the prompt used
    // to say the human moves it on while the code moved it every time.
    await finishing().runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("parks it instead when the agent asks something", async () => {
    // Registering a schema must not shut the asking door — the union is
    // what keeps both answers reachable on the same action.
    await supervisorReturning({
      outcome: {
        status: "clarification_required",
        questions: [{ id: "scope", question: "Per API key or per account?", why: "The storage differs.", options: ["per key", "per account"] }],
      },
    }).runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("ask");
    const asked = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "question");
    expect(asked?.body).toContain("Per API key or per account?");
  });

  it("does not advance on a result that says nothing about what it understood", async () => {
    await supervisorReturning({ ready: true }).runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.status).not.toBe("succeeded");
    expect(getItem(handle.db, item.id)?.stepId).toBe("ask");
  });
});

/**
 * A story or bug classification short-circuits the whole
 * backlog/refine detour (KAN-4, routed by KAN-37/EO-5): no
 * decomposition, straight to the same human review gate a feature's
 * plan stops at.
 */
describe("classifying a bug or story instead of a feature (KAN-37/EO-5)", () => {
  const BUG = {
    type: "bug",
    ready: true,
    title: "Login times out after 30s",
    body: "Users on slow connections cannot sign in.",
    steps_to_reproduce: "Throttle the network to 2G and log in.",
    expected: "Login completes within the request timeout.",
    actual: "The request times out and the form clears.",
    environment: "Chrome 128, staging",
  };

  const STORY = {
    type: "story",
    ready: true,
    title: "Add CSV export",
    body: "Let a user export their own data.",
    acceptance_criteria: ["Exports as CSV", "Includes every visible column"],
  };

  it("routes a non-feature classification down its own edge", async () => {
    await supervisorReturning(BUG).runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("updates the item's type to match what was proposed", async () => {
    await supervisorReturning(BUG).runOnce();

    expect(getItem(handle.db, item.id)?.type).toBe("bug");
  });

  it("posts the proposed fields as something the human can act on", async () => {
    await supervisorReturning(BUG).runOnce();

    const decision = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "decision");
    expect(decision).toBeDefined();
    expect(decision!.body).toContain("Login times out after 30s");
    expect(decision!.body).toContain("Throttle the network to 2G and log in.");
  });

  it("carries a bug's acceptance criteria onto the card, and asks for none when there are none", async () => {
    // EO-205. `BugIntakeSchema` accepts criteria without demanding them,
    // so a conversation that settled what "fixed" means has somewhere to
    // put the answer instead of leaving it in a thread nothing
    // downstream reads.
    //
    // Onto the card and not into `spec`: the story branch beside this
    // one does not write its criteria there either — a classification is
    // a proposal a person approves, and `items:update` is what writes
    // criteria onto an item. Making intake write them would change the
    // story path too, which this story does not ask for.
    await supervisorReturning({ ...BUG, acceptance_criteria: ["Login completes on a throttled connection."] }).runOnce();

    const decision = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "decision");
    expect(decision!.body).toContain("**Acceptance criteria:**");
    expect(decision!.body).toContain("- Login completes on a throttled connection.");
  });

  it("leaves the bug card exactly as it was when no criteria were settled", async () => {
    // A bug is never asked for criteria, so nothing may appear where
    // they would have been.
    await supervisorReturning(BUG).runOnce();

    const decision = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "decision");
    expect(decision!.body).toContain("**Environment:** Chrome 128, staging\n\nApprove to move this");
  });

  it("posts nothing pinned — that record is the feature branch's alone", async () => {
    await supervisorReturning(BUG).runOnce();

    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.pinned)).toBe(false);
  });

  it("refuses a word two packs both ship rather than picking one (KAN-129, KAN-147)", async () => {
    // While intake's shape was this pack's three words, the word it came
    // back with was this pack's by construction and was resolved as
    // `developer:bug`. KAN-147 composes the shape from every type the
    // project has, so the word may be another pack's — and one two packs
    // both ship is a question with two answers.
    //
    // Refused, by naming both, which is `resolveItemType`'s settled
    // stance (ARCHITECTURE.md, "An item type is data") and the reason `PackCollisionError` exists:
    // whichever
    // of the two EO picked would be somebody's type, dropped silently. The
    // item keeps what it was and the thread says what to do.
    syncItemTypes(handle.db, [{ packSlug: "support", slug: "bug", label: "Fault", plural: "Faults", container: false, specShape: EMPTY_SPEC_SHAPE, actionOverrides: {} }]);

    await supervisorReturning(BUG).runOnce();

    expect(getItem(handle.db, item.id)?.type).toBe("feature");
    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.body.includes("More than one pack"))!;
    expect(note.body).toContain('"developer:bug"');
    expect(note.body).toContain('"support:bug"');
  });

  /**
   * Three ways an answer can name a type EO cannot apply, and what the
   * thread says about each (invariant 8).
   *
   * Driven by calling the poster rather than by running the supervisor,
   * and that is the point: since KAN-147 the *shape* an intake run is held
   * to is composed from the project's item types, so an answer naming a
   * type the project does not have — or shaped for the other side of its
   * container flag — is refused by validation and the agent is re-prompted
   * with what the types actually are. That is the better place for it to
   * fail, and it leaves these three as the layer behind: a type deleted
   * between the validation and the write, a flag flipped in the configure
   * screen mid-run, a pack uninstalled. Each still has to end in a
   * comment and change nothing, because "EO read your answer and silently
   * did nothing with it" is the one outcome nobody can act on.
   */
  describe("a type the answer names but EO cannot apply (KAN-129, KAN-146)", () => {
    function posted(answer: unknown): string[] {
      const agent = listAgents(handle.db)[0]!;
      const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "intake" });
      postIntakeSummary(handle.db, getItem(handle.db, item.id)!, agent.id, run.id, answer);
      return listCommentsForItem(handle.db, item.id).map((comment) => comment.body);
    }

    it("says so when the project has no such type, and leaves the classification alone", () => {
      handle.db.run(sql`DELETE FROM item_types WHERE slug = 'bug' AND project_id IS NULL`);

      const bodies = posted(BUG);

      expect(getItem(handle.db, item.id)?.type).toBe("feature");
      expect(bodies.find((body) => body.includes("There is no"))).toContain('"bug"');
      // And no card, because there is nothing to approve: approving one
      // would apply a classification EO could not write.
      expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.kind === "decision")).toBe(false);
    });

    it("says so when the type it classified into holds work", () => {
      handle.db.run(sql`UPDATE item_types SET container = 1 WHERE slug = 'bug'`);

      const bodies = posted(BUG);

      expect(getItem(handle.db, item.id)?.type).toBe("feature");
      expect(bodies.find((body) => body.includes("is a container"))).toBeDefined();
      expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.kind === "decision")).toBe(false);
    });

    it("pins nothing for a decomposition when the type it named is not a container", () => {
      handle.db.run(sql`UPDATE item_types SET container = 0 WHERE slug = 'feature'`);

      const bodies = posted({
        type: "feature",
        ready: true,
        understanding: UNDERSTANDING,
        decisions: [],
      });

      expect(bodies).not.toContain(UNDERSTANDING);
      expect(bodies.find((body) => body.includes("is not a container"))).toBeDefined();
    });
  });

  /**
   * A container whose type declares fields of its own (KAN-147).
   *
   * EO's own two answers about a container — the understanding it pins
   * and the decisions it records — are not the whole of what a container
   * may carry. A pack's `Initiative` with a quarter demands it at
   * creation like any other type, so a classification that neither asked
   * for it nor stored it would produce an item the same pack's own
   * creation door calls incomplete.
   */
  describe("a container type with fields of its own", () => {
    const INITIATIVE = {
      packSlug: "planning",
      slug: "initiative",
      label: "Initiative",
      plural: "Initiatives",
      container: true,
      specShape: {
        type: "object" as const,
        properties: { quarter: { type: "string" as const, minLength: 1 } },
        required: ["quarter"],
      },
      actionOverrides: {},
    };

    /** The pack's own container, waiting on the intake step — which is what intake understands. */
    let initiative: Item;

    beforeEach(() => {
      syncItemTypes(handle.db, [INITIATIVE]);
      // The feature the outer fixture made is moved out of the
      // scheduler's way, so this one is the item the tick picks up.
      transitionItem(handle.db, { itemId: item.id, toStepId: "todo", actor: "human" });
      initiative = createTestItem(handle.db, { type: "initiative", title: "Rate limiting, this quarter", stepId: "ask" });
    });

    it("asks for the field its shape declares, and keeps what it answered", async () => {
      await supervisorReturning({ type: "initiative", ready: true, understanding: UNDERSTANDING, quarter: "Q3" }).runOnce();

      const understood = getItem(handle.db, initiative.id)!;
      expect(understood.spec).toMatchObject({ quarter: "Q3" });
      // And EO's own two answers about a container are not spec: the
      // understanding is pinned, because that is what `refine` reads
      // instead of replaying the conversation that produced it.
      const pinned = listCommentsForItem(handle.db, initiative.id).find((comment) => comment.pinned);
      expect(pinned?.body).toBe(UNDERSTANDING);
      expect(understood.spec).not.toHaveProperty("understanding");
    });

    it("is refused when it answers without a field that container demands", async () => {
      // Held to the composed document by A-02, exactly as a leaf is: the
      // branch asks for the field, so an answer without it never reaches
      // the poster and nothing is written.
      await supervisorReturning({ type: "initiative", ready: true, understanding: UNDERSTANDING }).runOnce();

      expect(getItem(handle.db, initiative.id)?.spec).toBeNull();
      expect(listRunsForItem(handle.db, initiative.id).at(0)?.status).not.toBe("succeeded");
    });

    it("asks for a narrowing the container put on a field EO also carries", async () => {
      // A container may name one of the fields the branch already
      // carries, and naming it is narrowing: this one wants an
      // understanding of some substance. That has to reach the document
      // or the type demands something the agent is never asked for.
      const exacting = {
        ...INITIATIVE,
        slug: "exacting",
        specShape: {
          type: "object" as const,
          properties: { understanding: { type: "string" as const, minLength: 40 } },
          required: ["understanding"],
        },
      };
      syncItemTypes(handle.db, [exacting]);
      const strict = createTestItem(handle.db, { type: "exacting", title: "Rate limiting", stepId: "ask" });
      transitionItem(handle.db, { itemId: initiative.id, toStepId: "todo", actor: "human" });

      await supervisorReturning({ type: "exacting", ready: true, understanding: "Too short." }).runOnce();

      expect(listRunsForItem(handle.db, strict.id).at(0)?.status).not.toBe("succeeded");
      expect(listCommentsForItem(handle.db, strict.id).some((comment) => comment.pinned)).toBe(false);
    });

    it("writes nothing when the container's shape refuses what EO would store", async () => {
      // The other side of the same collision: what a field *is* stays
      // EO's, because `understanding` is prose to pin whatever a shape
      // calls it. A container declaring it a number therefore composes a
      // document asking for the string EO can use — and a shape that
      // refuses that string. Nothing is written, and the thread says so.
      const confused = {
        ...INITIATIVE,
        slug: "confused",
        specShape: {
          type: "object" as const,
          properties: { understanding: { type: "number" as const } },
          required: [],
        },
      };
      syncItemTypes(handle.db, [confused]);
      const muddled = createTestItem(handle.db, { type: "confused", title: "Rate limiting", stepId: "ask" });
      transitionItem(handle.db, { itemId: initiative.id, toStepId: "todo", actor: "human" });

      await supervisorReturning({ type: "confused", ready: true, understanding: UNDERSTANDING }).runOnce();

      expect(getItem(handle.db, muddled.id)?.spec).toBeNull();
      const note = listCommentsForItem(handle.db, muddled.id).find((comment) => comment.body.includes("does not accept"));
      expect(note?.body).toContain("confused");
      // And nothing pinned either: the understanding is part of what was
      // refused, not a record to keep from a classification EO could not
      // apply.
      expect(listCommentsForItem(handle.db, muddled.id).some((comment) => comment.pinned)).toBe(false);
    });

    it("writes nothing at all for a container that declares no fields", async () => {
      // Every container EO ships declares none, so the row is left
      // exactly as it was: `specFromAnswer` has nothing to merge, and a
      // classification that wrote `{}` would be a spec where there was
      // none. The plain feature, put back in front of the scheduler.
      transitionItem(handle.db, { itemId: initiative.id, toStepId: "todo", actor: "human" });
      transitionItem(handle.db, { itemId: item.id, toStepId: "ask", actor: "human" });

      await supervisorReturning({ type: "feature", ready: true, understanding: UNDERSTANDING }).runOnce();

      expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.pinned)).toBe(true);
      expect(getItem(handle.db, item.id)?.spec).toBeNull();
    });
  });

  /**
   * Classifying into a type this code has never heard of (KAN-147).
   *
   * The whole of what the composed intake schema is for. The union used to
   * be `feature | story | bug` written in `packages/core`, so a pack's own
   * type was not something intake could answer with at all — and the
   * fields it would have needed to answer with were not in the schema
   * either. Now the branch is the type's, its spec shape is what the agent
   * is asked for, and the fields land on the item.
   */
  describe("a type the pack shipped and this code never heard of", () => {
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
          channel: { type: "string" as const, enum: ["email", "phone"] },
        },
        required: ["customer", "channel"],
      },
      actionOverrides: {},
    };

    const ANSWER = {
      type: "case",
      ready: true,
      title: "ACME cannot sign in",
      body: "Raised by their ops lead.",
      customer: "ACME",
      channel: "email",
    };

    beforeEach(() => {
      syncItemTypes(handle.db, [CASE]);
    });

    it("produces an item of that type, carrying the fields its shape asked for", async () => {
      await supervisorReturning(ANSWER).runOnce();

      const classified = getItem(handle.db, item.id)!;
      expect(classified.type).toBe("case");
      expect(getItemType(handle.db, classified.typeId)?.packSlug).toBe("support");
      // On the item, not only on the card. A classification used to leave
      // its fields in the comment it posted, so a story intake reached
      // to-do with no acceptance criteria and the review was the first
      // thing to notice (EO-213).
      expect(classified.spec).toMatchObject({ customer: "ACME", channel: "email" });
    });

    it("puts the type's own fields on the card, labelled, without this code knowing one of them", async () => {
      await supervisorReturning(ANSWER).runOnce();

      const card = listCommentsForItem(handle.db, item.id).find((comment) => comment.body.includes("I'm treating this as"))!;
      expect(card.body).toContain("**Customer:** ACME");
      expect(card.body).toContain("**Channel:** email");
    });

    it("leaves the classification alone when a field the item already holds is one this type refuses", async () => {
      // A-02 held the answer to this type's branch, so what the agent
      // *said* fits. What the item kept may not: a classification merges
      // over whatever was there, and a type may close its shape against
      // exactly that — an item that arrived as a bug still carries the
      // repro fields a sealed Case has no place for. Writing anyway
      // would re-file the item as a type its own shape rejects.
      const sealed = { ...CASE, slug: "sealed", specShape: { ...CASE.specShape, additionalProperties: false } };
      syncItemTypes(handle.db, [sealed]);
      updateItem(handle.db, item.id, { spec: { expected: "It signs in." } });

      await supervisorReturning({ ...ANSWER, type: "sealed" }).runOnce();

      expect(getItem(handle.db, item.id)?.type).toBe("feature");
      const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.body.includes("does not accept"));
      expect(note?.body).toContain("sealed");
      // And no card, because there is nothing to approve: approving one
      // would apply a classification EO could not write.
      expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.kind === "decision")).toBe(false);
    });

    it("is refused when it answers without a field that type demands", async () => {
      // The shape is in the document the run is held to, so this never
      // reaches the poster: the agent is re-prompted with the issue, which
      // is what A-02 does with every malformed result.
      const withoutCustomer: Record<string, unknown> = { ...ANSWER };
      delete withoutCustomer["customer"];

      await supervisorReturning(withoutCustomer).runOnce();

      expect(getItem(handle.db, item.id)?.type).toBe("feature");
      expect(listRunsForItem(handle.db, item.id).at(0)?.status).not.toBe("succeeded");
    });
  });

  it("holds a story classification to the same bar", async () => {
    await supervisorReturning(STORY).runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    expect(getItem(handle.db, item.id)?.type).toBe("story");
    const decision = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "decision");
    expect(decision?.body).toContain("Add CSV export");
    expect(decision?.body).toContain("Exports as CSV");
  });
});
