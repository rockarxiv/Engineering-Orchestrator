import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verificationLine, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { createStep, getStep, listStepsForPipeline } from "../db/repos/pipelineStepsRepo.js";
import type { ServerClient } from "../managed/serverClient.js";
import { listPipelineStepViews } from "./domainQueries.js";
import { deleteGroupCommand, listPeopleCommand, saveGroupCommand, setStepOwnerCommand } from "./identityCommands.js";

/**
 * Groups, and the head that names one (EO-323,
 * `ARCHITECTURE.md`, "Identity", the story's second acceptance criterion).
 *
 * "A human step assigned to a group shows 'Support team · anyone claims'
 * on the column head." The sentence itself is `verificationLine`'s and
 * is tested in core; what is tested here is everything that has to be
 * true for the board to be handed it — the group exists, the step names
 * it, and `pipelineSteps:list` answers with the name and the kind.
 */
describe("a human step that waits on a group", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  /** A human step of the shipped pipeline, at the end of it. */
  function humanStep(id = "approve"): string {
    createStep(handle.db, {
      id,
      pipelineId: "default" as Uuid,
      position: 99,
      name: "Approve",
      type: "user",
      results: [{ key: "approved", label: "Approve", tone: "success", requiresComment: false }],
    });
    return id;
  }

  async function group(name = "Support team", memberIds: string[] = []): Promise<string> {
    const saved = await saveGroupCommand(handle.db, { name, memberIds });
    if (saved.group === null) throw new Error(saved.problem ?? "no group");
    return saved.group.id;
  }

  /** The head of one column, as the board would draw it. */
  function head(stepId: string): string {
    const view = listPipelineStepViews(handle.db, { pipelineId: "default" });
    const step = view.steps.find((candidate) => candidate.id === stepId);
    if (step === undefined) throw new Error(`no step ${stepId} on the board`);
    return verificationLine(step, view.verification);
  }

  it("says 'Support team · anyone claims' on the column head", async () => {
    const step = humanStep();

    expect(await setStepOwnerCommand(handle.db, { stepId: step, personId: null, groupId: await group() })).toEqual({ problem: null });

    expect(head(step)).toBe("Support team · anyone claims");
  });

  it("says so in solo mode too, because a team is not a person being told their own name", async () => {
    // Solo mode is silent about *people* (EO-305): one person told about
    // themselves fifty times is noise. A group is not that — it is who is
    // expected to act, and an installation that has pointed a step at one
    // has said something the head has nowhere else to put.
    const step = humanStep();
    await setStepOwnerCommand(handle.db, { stepId: step, personId: null, groupId: await group() });

    expect(head(step)).toBe("Support team · anyone claims");
  });

  it("names a person instead, and neither when the step is handed back to nobody", async () => {
    const step = humanStep();
    const anna = createPerson(handle.db, { name: "Anna Ruiz" });

    await setStepOwnerCommand(handle.db, { stepId: step, personId: anna.id, groupId: null });
    expect(head(step)).toBe("Anna Ruiz · approves here");

    expect(await setStepOwnerCommand(handle.db, { stepId: step, personId: null, groupId: null })).toEqual({ problem: null });
    expect(head(step)).toBe("You approve here");
  });

  it("clears the person when a group is named, and the group when a person is", async () => {
    const step = humanStep();
    const anna = createPerson(handle.db, { name: "Anna Ruiz" });
    const team = await group();

    await setStepOwnerCommand(handle.db, { stepId: step, personId: anna.id, groupId: null });
    await setStepOwnerCommand(handle.db, { stepId: step, personId: null, groupId: team });

    // Both columns are always written, because the two are one answer: a
    // step naming both would have to have one of them chosen for it by
    // whichever reader got there first.
    expect(getStep(handle.db, step)).toMatchObject({ ownerPersonId: null, ownerGroupId: team });

    await setStepOwnerCommand(handle.db, { stepId: step, personId: anna.id, groupId: null });
    expect(getStep(handle.db, step)).toMatchObject({ ownerPersonId: anna.id, ownerGroupId: null });
  });

  it("refuses a step that names both, a step nothing waits at, and a name nobody has", async () => {
    const step = humanStep();
    const team = await group();
    const anna = createPerson(handle.db, { name: "Anna Ruiz" });
    const agentStep = listStepsForPipeline(handle.db, "default" as Uuid).find((candidate) => candidate.type === "agent");

    expect((await setStepOwnerCommand(handle.db, { stepId: step, personId: anna.id, groupId: team })).problem).toContain("not on both");
    expect((await setStepOwnerCommand(handle.db, { stepId: agentStep?.id ?? "", personId: anna.id, groupId: null })).problem).toContain(
      "not a step a person waits at",
    );
    expect((await setStepOwnerCommand(handle.db, { stepId: step, personId: "01a0-nobody" as Uuid, groupId: null })).problem).toContain("not on this list");
    expect((await setStepOwnerCommand(handle.db, { stepId: step, personId: null, groupId: "no-such-group" })).problem).toContain("not on this list");
    expect((await setStepOwnerCommand(handle.db, { stepId: "no-such-step", personId: null, groupId: team })).problem).toContain("not in this pipeline");
    // Nothing was written by any of them.
    expect(getStep(handle.db, step)).toMatchObject({ ownerPersonId: null, ownerGroupId: null });
  });

  it("hands a step back to nobody when its group is deleted, rather than naming a team that is gone", async () => {
    const step = humanStep();
    const team = await group();
    await setStepOwnerCommand(handle.db, { stepId: step, personId: null, groupId: team });

    expect(await deleteGroupCommand(handle.db, { groupId: team })).toEqual({ deleted: true, problem: null });

    // `owner_group_id` carries no foreign key — see schema.ts — so
    // nothing in SQLite would have cleared it, and a head naming a
    // deleted team reads as "Nobody assigned" only to somebody who knows
    // to look it up.
    expect(getStep(handle.db, step)).toMatchObject({ ownerGroupId: null });
    expect(head(step)).toBe("You approve here");
  });
});

describe("the list a picker offers", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("is this machine's own people and groups when nothing is signed in", async () => {
    createPerson(handle.db, { name: "Anna Ruiz" });
    await saveGroupCommand(handle.db, { name: "Support team", memberIds: [] });

    const listed = await listPeopleCommand(handle.db);

    expect(listed.fromServer).toBe(false);
    expect(listed.people.map((person) => person.name)).toEqual(["you", "Anna Ruiz"]);
    expect(listed.groups.map((group) => group.name)).toEqual(["Support team"]);
  });

  it("is the organisation's when this desktop is signed in to one", async () => {
    const listed = await listPeopleCommand(handle.db, {
      managed: {
        client: () => ({
          address: "https://eo.example.com",
          request: (() =>
            Promise.resolve({
              ok: true,
              data: {
                people: [{ id: "p1", name: "Dana", email: "dana@example.com", isAdmin: true, invitedAt: 1, acceptedAt: 2, credentialKind: "password" }],
                groups: [{ id: "g1", name: "Support team", memberIds: ["p1"] }],
                fromServer: false,
              },
            })) as ServerClient["request"],
        }),
      },
    });

    expect(listed.fromServer).toBe(true);
    expect(listed.people.map((person) => person.name)).toEqual(["Dana"]);
  });

  it("falls back to what this machine knows when the server cannot be reached", async () => {
    // The original design: "managed mode never stops a person from working." An error
    // dialog in the middle of choosing who approves a step is exactly the
    // stopping that rule is about.
    const listed = await listPeopleCommand(handle.db, {
      managed: {
        client: () => ({
          address: "https://eo.example.com",
          request: (() => Promise.resolve({ ok: false, error: { message: "EO could not reach https://eo.example.com" } })) as ServerClient["request"],
        }),
      },
    });

    expect(listed.fromServer).toBe(false);
    expect(listed.people.map((person) => person.name)).toEqual(["you"]);
  });
});

describe("a group", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("keeps its membership as the whole set it was saved with", async () => {
    const anna = createPerson(handle.db, { name: "Anna Ruiz" });
    const bo = createPerson(handle.db, { name: "Bo Chen" });
    const created = await saveGroupCommand(handle.db, { name: "Support team", memberIds: [anna.id, bo.id] });

    expect(created.group?.memberIds).toHaveLength(2);

    const narrowed = await saveGroupCommand(handle.db, { id: created.group?.id ?? "", name: "Support team", memberIds: [bo.id] });

    expect(narrowed.group?.memberIds).toEqual([bo.id]);
  });

  it("refuses a second group of the same name, however it is capitalised", async () => {
    await saveGroupCommand(handle.db, { name: "Support team", memberIds: [] });

    expect((await saveGroupCommand(handle.db, { name: "  support TEAM ", memberIds: [] })).problem).toContain("already a group");
  });

  it("refuses a member nobody has ever heard of, rather than writing a dangling row", async () => {
    expect((await saveGroupCommand(handle.db, { name: "Support team", memberIds: ["01a0-nobody"] })).problem).toContain("not on this list");
  });

  it("refuses a group with no name — it is what a column head shows", async () => {
    expect((await saveGroupCommand(handle.db, { name: "   ", memberIds: [] })).problem).toContain("needs a name");
  });
});
