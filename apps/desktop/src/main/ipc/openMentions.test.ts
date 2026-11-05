import { LOCAL_PERSON_ID, waitingOnLabel, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createPerson, createStep, postComment, setItemAssignee } from "../db/repos/index.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { setSetting } from "../db/repos/settingsRepo.js";
import { MANAGED_PERSON_ID_KEY } from "../identity/viewer.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listInbox, listOpenMentions } from "./domainQueries.js";

/**
 * Every unaddressed mention on the record, and who each waits on
 * (EO-326, `ARCHITECTURE.md`, "Identity").
 *
 * The second acceptance criterion, and the distinction it turns on. An
 * **inbox** answers "what is waiting on me", narrows to one project, and
 * is read by somebody who is going to answer every row in it. This
 * answers "what is waiting on anybody", spans every project the caller
 * may see, and is read by somebody who will answer none of it — so each
 * row has to carry the two facts an inbox row never needs: which project
 * it is on, and whose hands the work is in.
 *
 * The failure worth guarding against is the two drifting into one. A
 * cross-project view that quietly became the reader's own inbox would
 * tell an administrator the organisation had nothing outstanding; one
 * that leaked into the inbox would put other people's work on somebody's
 * queue and count it on their badge.
 */
let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

/** A human step of the shipped pipeline, waiting on somebody in particular. */
function humanStep(id: string, ownerPersonId: Uuid): string {
  createStep(handle.db, { id, pipelineId: "default" as Uuid, position: 90, name: id, type: "user", ownerPersonId });
  return id;
}

/** An item with an open question on it — an agent asking and nobody having answered. */
function asked(title: string, stepId: string | null, projectId: Uuid | null) {
  const item = createTestItem(handle.db, { title, type: "story", stepId, projectId });
  postComment(handle.db, {
    itemId: item.id,
    author: { type: "agent", agentId: "an-agent" as Uuid },
    kind: "question",
    body: `@user which is it? (${title})`,
  });
  return item;
}

describe("all open mentions", () => {
  it("names the person a mention is waiting on", () => {
    // The acceptance criterion, in one line. Anna holds the step, the
    // question on it is unanswered, and the row says so by her name —
    // which is the whole use of this screen: not a queue to work
    // through, but a list of who to go and ask.
    const anna = createPerson(handle.db, { name: "Anna Ruiz" });
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    asked("A customer is stuck", humanStep("approve", anna.id), project.id);

    const { mentions } = listOpenMentions(handle.db, null);

    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.waitingOn).toEqual({ who: "person", personId: anna.id, name: "Anna Ruiz" });
    expect(waitingOnLabel(mentions[0]!.waitingOn)).toBe("Waiting on Anna");
  });

  it("says which project each row is on", () => {
    // An inbox row never needs this and this one always does: the reader
    // is on none of these boards.
    const anna = createPerson(handle.db, { name: "Anna Ruiz" });
    const support = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    asked("A customer is stuck", humanStep("approve", anna.id), support.id);

    const { mentions } = listOpenMentions(handle.db, null);

    expect(mentions[0]).toMatchObject({ projectId: support.id, projectName: "Support" });
  });

  it("spans projects, where the inbox narrows to one", () => {
    const anna = createPerson(handle.db, { name: "Anna Ruiz" });
    const support = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const marketing = createProject(handle.db, { name: "Marketing", keyPrefix: "MKT" });
    const step = humanStep("approve", anna.id);
    asked("A customer is stuck", step, support.id);
    asked("The Q3 number is wrong", step, marketing.id);

    expect(listOpenMentions(handle.db, null).mentions.map((row) => row.projectName).sort()).toEqual(["Marketing", "Support"]);
    expect(listInbox(handle.db, support.id).items).toHaveLength(1);
  });

  it("shows only the projects a narrowed caller may see", () => {
    // The same rule `projects:list` applies, on the same set of rows.
    // A wider view of what somebody may look at, never a way around it.
    const anna = createPerson(handle.db, { name: "Anna Ruiz" });
    const support = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const marketing = createProject(handle.db, { name: "Marketing", keyPrefix: "MKT" });
    const step = humanStep("approve", anna.id);
    asked("A customer is stuck", step, support.id);
    asked("The Q3 number is wrong", step, marketing.id);

    const { mentions } = listOpenMentions(handle.db, new Set([support.id]));

    expect(mentions.map((row) => row.projectName)).toEqual(["Support"]);
  });

  it("leaves an item on no project out of a narrowed answer, and in a whole one", () => {
    // It belongs to nobody's list. Putting it in everybody's would be
    // the one row on the screen with no team behind it.
    const anna = createPerson(handle.db, { name: "Anna Ruiz" });
    asked("Filed before there were projects", humanStep("approve", anna.id), null);

    expect(listOpenMentions(handle.db, new Set(["whatever"])).mentions).toEqual([]);
    expect(listOpenMentions(handle.db, null).mentions).toHaveLength(1);
  });

  it("says “you” about the reader's own work and names everybody else", () => {
    // `waitingOn` is resolved against whoever is asking. An admin
    // reading every project must be told "waiting on Anna" about Anna's
    // and "waiting on you" about their own — a row that named the reader
    // back to themselves would be the one sentence in the list that says
    // nothing.
    const anna = createPerson(handle.db, { name: "Anna Ruiz" });
    const dana = createPerson(handle.db, { name: "Dana Okoro", isAdmin: true });
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const hers = asked("A customer is stuck", humanStep("approve-anna", anna.id), project.id);
    const theirs = asked("A second customer", humanStep("approve-dana", dana.id), project.id);
    setItemAssignee(handle.db, hers.id, anna.id);
    setItemAssignee(handle.db, theirs.id, dana.id);

    const byItem = new Map(listOpenMentions(handle.db, null, dana.id).mentions.map((row) => [row.itemId, row.waitingOn]));

    expect(byItem.get(hers.id)).toMatchObject({ who: "person", name: "Anna Ruiz" });
    expect(byItem.get(theirs.id)).toEqual({ who: "you" });
  });

  it("is empty once somebody has answered", () => {
    // "Unaddressed" is the whole of what this lists, and the predicate is
    // the inbox's own — a reply on the thread closes the mention, and
    // this screen has to agree with the one the person answering was
    // looking at.
    const anna = createPerson(handle.db, { name: "Anna Ruiz" });
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const item = asked("A customer is stuck", humanStep("approve", anna.id), project.id);

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "The second one." });

    expect(listOpenMentions(handle.db, null).mentions).toEqual([]);
  });

  it("keeps one person's reply from closing another person's question", () => {
    // `author_id` on a human comment is who wrote it (EO-326), and this
    // is what it buys: on a desktop it is null and everything behaves as
    // it always did, and on a server Anna answering her own question
    // leaves Dana's standing.
    const anna = createPerson(handle.db, { name: "Anna Ruiz" });
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const item = asked("A customer is stuck", humanStep("approve", anna.id), project.id);

    // Anna replies. The open row targets the local person — which is who
    // `@user` resolves to — so her words are not the answer to it.
    postComment(handle.db, { itemId: item.id, author: { type: "human", personId: anna.id }, body: "Not mine to answer." });

    expect(listOpenMentions(handle.db, null).mentions).toHaveLength(1);

    // And the local person's reply still closes it, exactly as before.
    postComment(handle.db, { itemId: item.id, author: { type: "human", personId: LOCAL_PERSON_ID as Uuid }, body: "The second one." });

    expect(listOpenMentions(handle.db, null).mentions).toEqual([]);
  });
});

/**
 * Whose inbox a signed-in desktop is showing (EO-325 + EO-326).
 *
 * The seam between the two stories, and the one place they could quietly
 * disagree. EO-325 made "you" a question about the *item*: a desktop
 * that kept one project and moved another answers to two people who are
 * both this person, and asking only the organisation's emptied the kept
 * project's inbox in silence. EO-326 then gave the query a person to ask
 * about, because a server has no "you" of its own and the caller must
 * say.
 *
 * Put together carelessly, the second undoes the first: an `inbox:list`
 * that always named a person would override the per-item answer, and a
 * managed project's inbox would go empty on every signed-in desktop with
 * nothing looking broken. So the absence of a caller is load-bearing,
 * and these two cases are what hold it that way.
 */
describe("an inbox on a desktop that has signed in", () => {
  it("answers both of this machine's identities, one per project", () => {
    const anna = createPerson(handle.db, { name: "Anna Ruiz" });
    setSetting(handle.db, MANAGED_PERSON_ID_KEY, anna.id);
    const kept = createProject(handle.db, { name: "Kept", keyPrefix: "KEP" });
    const moved = createProject(handle.db, { name: "Moved", keyPrefix: "MOV", managed: true });

    // A mention on the kept project still targets the local person,
    // because nothing rewrote it and nothing was supposed to.
    const onKept = asked("Still mine", humanStep("approve", anna.id), kept.id);
    // …and one on the moved project targets the organisation's person.
    const onMoved = createTestItem(handle.db, { title: "Theirs now", type: "story", stepId: null, projectId: moved.id });
    postComment(handle.db, {
      itemId: onMoved.id,
      author: { type: "agent", agentId: "an-agent" as Uuid },
      kind: "question",
      body: "@user which is it?",
      mentions: [{ type: "human", personId: anna.id }],
      parseBodyMentions: false,
    });

    // No caller, which is every read on a desktop.
    const kins = listInbox(handle.db, kept.id).items.map((row) => row.itemId);
    const movedIn = listInbox(handle.db, moved.id).items.map((row) => row.itemId);

    expect(kins).toEqual([onKept.id]);
    expect(movedIn).toEqual([onMoved.id]);
  });

  it("answers one person's when a door says who is asking", () => {
    // A browser served by a server. The machine *is* the record and has
    // no "you" to fall back to, so the caller names itself — and gets
    // its own rows rather than the record's implicit local person's.
    const anna = createPerson(handle.db, { name: "Anna Ruiz" });
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const hers = createTestItem(handle.db, { title: "Hers", type: "story", stepId: null, projectId: project.id });
    postComment(handle.db, {
      itemId: hers.id,
      author: { type: "agent", agentId: "an-agent" as Uuid },
      kind: "question",
      body: "@user which is it?",
      mentions: [{ type: "human", personId: anna.id }],
      parseBodyMentions: false,
    });
    asked("Somebody else's", humanStep("approve", anna.id), project.id);

    expect(listInbox(handle.db, project.id, anna.id).items.map((row) => row.itemId)).toEqual([hers.id]);
  });
});
