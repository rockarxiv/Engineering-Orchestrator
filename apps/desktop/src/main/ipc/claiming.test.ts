import { LOCAL_PERSON_ID, matchesInboxFilter, waitingOnLabel, type Person, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  createPerson,
  createStep,
  getItem,
  listAgents,
  listCommentsForItem,
  listTransitionsForItem,
  postComment,
  saveGroup,
  setStepOwner,
  transitionItem,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { assignItem, claimItem } from "./domainCommands.js";
import { listInbox, listItemSummaries } from "./domainQueries.js";

/**
 * Claiming an item, and an inbox that names people (EO-305,
 * ARCHITECTURE.md, "The board" and "The inbox, the archive and jobs", "Identity").
 *
 * The whole story turns on one distinction, so these tests are written
 * around it rather than around the files that implement it: EO now has
 * two kinds of installation, and only one of them has anything to say
 * about people. A team triaging cases needs an unassigned state, a way
 * to claim, and a row that says who has it. The person sitting alone in
 * front of their own desktop needs none of that — there is one pair of
 * hands, every human step is theirs, and a Claim button would be asking
 * them to volunteer for themselves.
 *
 * So each behaviour below is asked twice where the two differ: once
 * with one person in the table, which is what a migration leaves, and
 * once with a colleague in it, which is what 7b's people list brings.
 */
let handle: DbHandle;
/** A colleague — created only by the tests that are about there being one. */
function colleague(name = "Anna Ruiz"): Person {
  return createPerson(handle.db, { name });
}

/** A human step of the shipped pipeline, optionally waiting on somebody. */
function humanStep(id: string, ownerPersonId?: Uuid): string {
  createStep(handle.db, {
    id,
    pipelineId: "default" as Uuid,
    position: 90,
    name: id,
    type: "user",
    ...(ownerPersonId === undefined ? {} : { ownerPersonId }),
  });
  return id;
}

/** A human step a *team* waits at — "Support team · anyone claims" (EO-323). */
function teamStep(id: string, name = "Support team"): string {
  const group = saveGroup(handle.db, { name, memberIds: [] });
  createStep(handle.db, { id, pipelineId: "default" as Uuid, position: 91, name: id, type: "user" });
  setStepOwner(handle.db, id, { personId: null, groupId: group.id });
  return id;
}

function move(itemId: Uuid, toStepId: string): void {
  transitionItem(handle.db, { itemId, toStepId, actor: "human" });
}

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

describe("an item arriving on a human step", () => {
  it("is assigned to the person the step names", () => {
    const anna = colleague();
    const step = humanStep("approve", anna.id);
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });

    move(item.id, step);

    expect(getItem(handle.db, item.id)?.assigneeId).toBe(anna.id);
  });

  it("is the local person's when nobody is named and nobody else exists", () => {
    // Solo mode. "Every human step auto-assigns to the local person",
    // which is what leaves no Claim affordance anywhere to press.
    const step = humanStep("approve");
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });

    move(item.id, step);

    expect(getItem(handle.db, item.id)?.assigneeId).toBe(LOCAL_PERSON_ID);
  });

  it("arrives unclaimed when nobody is named and there are colleagues", () => {
    // The state EO could not previously represent, and the one a
    // triaging team works from: on a person's desk, on nobody's in
    // particular.
    colleague();
    const step = humanStep("triage");
    const item = createTestItem(handle.db, { type: "story", title: "Card declined", stepId: "todo" });

    move(item.id, step);

    expect(getItem(handle.db, item.id)?.assigneeId).toBeNull();
  });

  it("arrives unclaimed at a step a team waits at, even with nobody else on this machine", () => {
    // The acceptance criterion's other half, and the bug EO-323's review
    // found: the head says "Support team · anyone claims" and the item
    // was being handed to whoever was sitting there. A machine that
    // knows one person is still a machine whose step says a team takes
    // this — and on a desktop signed in to an organisation that is the
    // ordinary case, because the only local row is itself.
    const step = teamStep("triage");
    const item = createTestItem(handle.db, { type: "story", title: "Card declined", stepId: "todo" });

    move(item.id, step);

    expect(getItem(handle.db, item.id)?.assigneeId).toBeNull();
  });

  it("does the same for an item created straight onto one, which is an arrival too", () => {
    const step = teamStep("triage");

    const item = createTestItem(handle.db, { type: "story", title: "Card declined", stepId: step });

    expect(getItem(handle.db, item.id)?.assigneeId).toBeNull();
  });

  it("still prefers the person where a step names one, whatever else it says", () => {
    // Both columns cannot be set — `setStepOwnerCommand` refuses the
    // pair — but the order the two are asked in is what makes that
    // refusal the only way to get here, so it is worth pinning.
    const anna = colleague();
    const step = teamStep("approve");
    setStepOwner(handle.db, step, { personId: anna.id, groupId: null });
    const item = createTestItem(handle.db, { type: "story", title: "Approve the copy", stepId: "todo" });

    move(item.id, step);

    expect(getItem(handle.db, item.id)?.assigneeId).toBe(anna.id);
  });

  it("says nothing about the assignee when it arrives on an agent step", () => {
    // An agent step's assignee is whichever agent ran, derived from the
    // newest run — so overwriting the person who had it last with null
    // would replace one answer with a worse one. The card reads the
    // agent while an agent has it, and the column is simply not what it
    // is reading.
    const anna = colleague();
    const step = humanStep("approve", anna.id);
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });
    move(item.id, step);

    move(item.id, "review");

    expect(getItem(handle.db, item.id)?.assigneeId).toBe(anna.id);
  });

  it("assigns an item created straight onto a human step, which is an arrival too", () => {
    const anna = colleague();
    const step = humanStep("approve", anna.id);

    const item = createTestItem(handle.db, { type: "story", title: "Approve the copy", stepId: step });

    expect(getItem(handle.db, item.id)?.assigneeId).toBe(anna.id);
  });
});

describe("claiming and assigning", () => {
  it("sets the assignee and says so in the thread", () => {
    colleague();
    const step = humanStep("triage");
    const item = createTestItem(handle.db, { type: "story", title: "Card declined", stepId: "todo" });
    move(item.id, step);

    const result = claimItem(handle.db, { itemId: item.id });

    expect(result.assigneeId).toBe(LOCAL_PERSON_ID);
    expect(getItem(handle.db, item.id)?.assigneeId).toBe(LOCAL_PERSON_ID);
    // Invariant #4: the thread is the only channel, and who picked a
    // piece of work up is not something that may happen silently.
    const comment = listCommentsForItem(handle.db, item.id).find((posted) => posted.id === result.commentId);
    expect(comment?.body).toBe("Claimed by you.");
    expect(comment?.authorType).toBe("engine");
  });

  it("is not a transition — the item does not move", () => {
    // "A claim is an assignee change plus a comment, not a transition."
    // Invariant #1 is about `items.stepId`, and nothing here goes near it.
    colleague();
    const step = humanStep("triage");
    const item = createTestItem(handle.db, { type: "story", title: "Card declined", stepId: "todo" });
    move(item.id, step);
    const before = listTransitionsForItem(handle.db, item.id).length;

    claimItem(handle.db, { itemId: item.id });

    expect(getItem(handle.db, item.id)?.stepId).toBe(step);
    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(before);
  });

  it("hands an item to somebody else, and says that instead", () => {
    // The same write, a different sentence, because they are different
    // events: Anna deciding, and somebody deciding for Anna.
    const anna = colleague();
    const step = humanStep("triage");
    const item = createTestItem(handle.db, { type: "story", title: "Card declined", stepId: "todo" });
    move(item.id, step);

    const result = assignItem(handle.db, { itemId: item.id, personId: anna.id });

    expect(result).toMatchObject({ assigneeId: anna.id, assigneeName: "Anna Ruiz" });
    expect(getItem(handle.db, item.id)?.assigneeId).toBe(anna.id);
    expect(listCommentsForItem(handle.db, item.id).find((posted) => posted.id === result.commentId)?.body).toBe("Assigned to Anna Ruiz.");
  });

  it("refuses to assign an item to somebody EO has no row for", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Card declined", stepId: "todo" });

    expect(() => assignItem(handle.db, { itemId: item.id, personId: "0199aa00-0000-7000-8000-00000000dead" })).toThrow(/no person/);
  });
});

describe("the card's assignee slot", () => {
  const cardFor = (itemId: Uuid) => listItemSummaries(handle.db, null).items.find((summary) => summary.id === itemId);

  it("offers Claim on a human step nobody holds, and the person once somebody does", () => {
    colleague();
    const step = humanStep("triage");
    const item = createTestItem(handle.db, { type: "story", title: "Card declined", stepId: "todo" });
    move(item.id, step);

    expect(cardFor(item.id)).toMatchObject({ claimable: true, assigneePerson: null });

    claimItem(handle.db, { itemId: item.id });

    expect(cardFor(item.id)).toMatchObject({ claimable: false, assigneePerson: { id: LOCAL_PERSON_ID, name: "you" } });
  });

  /**
   * The column outlives the step, and the card must not.
   *
   * `transitionItem` leaves `assignee_id` alone when an item moves to a
   * step that is not a human one — an arrival on an agent step says
   * nothing about who the item belongs to — so Anna is still written
   * down while an agent works. The original design says a card reads "an agent's name
   * on an agent step, a person's avatar on a human step", and reading
   * the column without asking where the item is would put Anna's face
   * on work an agent is doing.
   */
  it("stops naming the person once the item moves on to an agent step", () => {
    const anna = colleague();
    const step = humanStep("approve", anna.id);
    const item = createTestItem(handle.db, { type: "story", title: "Card declined", stepId: "todo" });
    move(item.id, step);
    assignItem(handle.db, { itemId: item.id, personId: anna.id });
    expect(cardFor(item.id)).toMatchObject({ assigneePerson: { id: anna.id, name: "Anna Ruiz" } });

    move(item.id, "review");

    // The column still names her — an arrival on an agent step says
    // nothing about the assignee, so nothing overwrote it — and the
    // card says nobody, because an agent has it.
    expect(getItem(handle.db, item.id)?.assigneeId).toBe(anna.id);
    expect(cardFor(item.id)).toMatchObject({ assigneePerson: null, claimable: false });

    // And she is on it again the moment it is back on her step, which
    // is the difference between reading the step and forgetting the
    // column.
    move(item.id, step);

    expect(cardFor(item.id)).toMatchObject({ assigneePerson: { id: anna.id, name: "Anna Ruiz" }, claimable: false });
  });

  it("offers a Claim on a team's step in solo mode, because the head invites one", () => {
    // Solo mode is a fact about *people* — how many this installation
    // can name. A step offered to a team is not about a person: somebody
    // said the Support team takes this, and a card with no way to claim
    // would be the column head describing a gesture the board does not
    // offer. It is also the state a managed desktop is permanently in,
    // holding one local row while working against a list of colleagues.
    const step = teamStep("triage");
    const item = createTestItem(handle.db, { type: "story", title: "Card declined", stepId: "todo" });
    move(item.id, step);

    expect(cardFor(item.id)).toMatchObject({ claimable: true, assigneePerson: null });

    // And claiming it works, which is the whole point of offering it.
    claimItem(handle.db, { itemId: item.id });
    expect(cardFor(item.id)).toMatchObject({ claimable: false, assigneePerson: { id: LOCAL_PERSON_ID, name: "you" } });
  });

  it("offers no Claim on an agent step, where the assignee is whichever agent ran", () => {
    colleague();
    const item = createTestItem(handle.db, { type: "story", title: "Card declined", stepId: "todo" });

    expect(cardFor(item.id)).toMatchObject({ claimable: false, assigneePerson: null });
  });

  /**
   * The acceptance criterion, asked of the query the board draws from:
   * in solo mode no Claim affordance appears anywhere. Not "is hidden by
   * the renderer" — there is nothing claimable on the board at all, on
   * either kind of step, whether or not the item has ever been through a
   * human one.
   */
  it("says nothing about people at all in solo mode", () => {
    const step = humanStep("approve");
    const onHuman = createTestItem(handle.db, { type: "story", title: "Approve the copy", stepId: "todo" });
    const onAgent = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });
    move(onHuman.id, step);

    // Assigned — the arrival above did it — and still shown as nobody,
    // because the one person needs no avatar to know who they are.
    expect(getItem(handle.db, onHuman.id)?.assigneeId).toBe(LOCAL_PERSON_ID);
    expect(listItemSummaries(handle.db, null).items.every((summary) => !summary.claimable && summary.assigneePerson === null)).toBe(true);
    expect(cardFor(onAgent.id)).toMatchObject({ claimable: false, assigneePerson: null });
  });
});

describe("the inbox's rows", () => {
  /** An agent asking the person something — one inbox row per call. */
  function ask(itemId: Uuid, body = "@user 429 or 503?"): void {
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    postComment(handle.db, { itemId, author: { type: "agent", agentId: implementer.id }, body, mentions: [{ type: "human" }], kind: "escalation" });
  }

  const labels = () => listInbox(handle.db, null).items.map((row) => waitingOnLabel(row.waitingOn));

  it("reads \"Waiting on you\" for work that is yours", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });
    ask(item.id);

    // Solo mode, an agent step, nobody assigned: the row is what is
    // being asked of you, and the answer is not "Unclaimed".
    expect(labels()).toEqual(["Waiting on you"]);
  });

  it("reads \"Waiting on Anna\" for work in somebody else's hands", () => {
    const anna = colleague();
    const step = humanStep("triage");
    const item = createTestItem(handle.db, { type: "story", title: "Card declined", stepId: "todo" });
    move(item.id, step);
    assignItem(handle.db, { itemId: item.id, personId: anna.id });
    ask(item.id, "@user did the customer reply?");

    // The first name, not the full one: the row is read as a sentence.
    expect(labels()).toEqual(["Waiting on Anna"]);
  });

  it("reads \"Unclaimed\" for work at a team's step, even on a machine that knows one person", () => {
    // The pair of the board's rule (EO-323): a card the board offers a
    // Claim on must not be a row saying "Waiting on you", or the two
    // screens are describing the same item differently. This is the
    // shape a managed desktop is permanently in — one local person, and
    // a step its organisation's team waits at.
    const step = teamStep("triage");
    const item = createTestItem(handle.db, { type: "story", title: "Card declined", stepId: "todo" });
    move(item.id, step);
    ask(item.id, "@user did the customer reply?");

    expect(labels()).toEqual(["Unclaimed"]);
    // And the board agrees, which is the point of pinning the pair.
    expect(listItemSummaries(handle.db, null).items.find((summary) => summary.id === item.id)).toMatchObject({ claimable: true });
  });

  it("reads \"Unclaimed\" for work on a human step nobody has taken", () => {
    colleague();
    const step = humanStep("triage");
    const item = createTestItem(handle.db, { type: "story", title: "Card declined", stepId: "todo" });
    move(item.id, step);
    ask(item.id, "@user this one needs somebody");

    expect(labels()).toEqual(["Unclaimed"]);
  });

  it("never reads \"Unclaimed\" in solo mode", () => {
    // There is no Claim button on that board, so a row telling somebody
    // the work is unclaimed would be pointing at an affordance that is
    // not there.
    const step = humanStep("approve");
    const item = createTestItem(handle.db, { type: "story", title: "Approve the copy", stepId: "todo" });
    move(item.id, step);
    ask(item.id, "@user ready for you");

    expect(labels()).toEqual(["Waiting on you"]);
  });

  it("stops naming the person once the item moves on to an agent step", () => {
    // The card's rule, asked of the inbox: nobody is waiting on Anna
    // while an agent is working, whatever the column still says.
    const anna = colleague();
    const step = humanStep("approve", anna.id);
    const item = createTestItem(handle.db, { type: "story", title: "Card declined", stepId: "todo" });
    move(item.id, step);
    move(item.id, "review");
    ask(item.id, "@user the refund API is returning 500");

    expect(getItem(handle.db, item.id)?.assigneeId).toBe(anna.id);

    expect(labels()).toEqual(["Waiting on you"]);
  });

  it("lists what nobody has taken under the Unassigned filter", () => {
    const anna = colleague();
    const mine = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });
    const hers = createTestItem(handle.db, { type: "story", title: "Refund the order", stepId: "todo" });
    const nobody = createTestItem(handle.db, { type: "story", title: "Card declined", stepId: "todo" });
    const step = humanStep("triage");
    move(hers.id, step);
    assignItem(handle.db, { itemId: hers.id, personId: anna.id });
    move(nobody.id, step);
    ask(mine.id);
    ask(hers.id, "@user did the customer reply?");
    ask(nobody.id, "@user this one needs somebody");

    const unassigned = listInbox(handle.db, null).items.filter((row) => matchesInboxFilter(row, { text: "", facets: { category: "unassigned" } }));

    expect(unassigned.map((row) => row.itemTitle)).toEqual(["Card declined"]);
    // And the default tab still shows all three.
    expect(listInbox(handle.db, null).items).toHaveLength(3);
  });
});
