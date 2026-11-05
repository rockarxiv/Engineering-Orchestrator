import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_PERSON_ID, uuidv7, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { saveGroup } from "../db/repos/groupsRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { setItemAssignee } from "../db/repos/itemsRepo.js";
import { adoptPipeline, setStepOwner } from "../db/repos/pipelineStepsRepo.js";
import { listPipelines, listStepsForPipeline } from "../db/repos/index.js";
import { actingCaller, actingPersonId, humanAuthor, scopedProjectId, visibleProjectIds, visibleProjects } from "./acting.js";

/**
 * Who a request is acting as, and what they may be shown (EO-326,
 * `ARCHITECTURE.md`, "Identity").
 *
 * The three readings of `actingDeviceId` are the subject: absent is a
 * desktop, null is the operator's key, and an id is a signed-in device.
 * Each of them is a different person — one, nobody, and somebody — and
 * the failures they guard against are all "EO answered as the wrong
 * one": a server's own local-person row given an inbox, a colleague
 * shown the whole organisation, an admin narrowed out of the projects
 * they are there to look at.
 */
describe("who a request is acting as", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  function person(name: string, isAdmin = false) {
    return createPerson(handle.db, { name, email: `${name.toLowerCase()}@example.com`, isAdmin });
  }

  function deviceOf(personId: Uuid, name: string) {
    return issueDevice(handle.db, { personId, name, tokenHash: `hash-${name}`, secretsKeyHash: null });
  }

  it("is the local person where nothing authenticated", () => {
    // A desktop, or the MCP host on one. The person at the keyboard owns
    // the machine and its database, so there is nobody to narrow to and
    // nothing to be careful with.
    const caller = actingCaller(handle.db, undefined);

    expect(caller.person?.id).toBe(LOCAL_PERSON_ID);
    expect(caller).toMatchObject({ admin: true, served: false, deviceId: null });
    expect(visibleProjectIds(handle.db, caller)).toBeNull();
  });

  it("is nobody, and an admin, for the operator's key", () => {
    // The credential the container was started with. It administers an
    // organisation without being a member of one, which is why the two
    // fields are not one field.
    const caller = actingCaller(handle.db, null);

    expect(caller).toEqual({ person: null, deviceId: null, admin: true, served: true });
  });

  it("is the person the device belongs to", () => {
    const dana = person("Dana", true);
    const device = deviceOf(dana.id, "Dana's browser");

    const caller = actingCaller(handle.db, device.id);

    expect(caller.person?.id).toBe(dana.id);
    expect(caller).toMatchObject({ admin: true, served: true, deviceId: device.id });
  });

  it("is nobody, and no admin, for a device this record does not have", () => {
    // Revoked between the door and here, or a row deleted underneath it.
    // The one case that fails narrower than any of the three above, which
    // is the right direction.
    expect(actingCaller(handle.db, uuidv7())).toEqual({ person: null, deviceId: null, admin: false, served: true });
  });

  it("files a write under the local person where nobody authenticated", () => {
    expect(actingPersonId(handle.db, undefined)).toBe(LOCAL_PERSON_ID);
  });

  it("puts no person on a comment written where there is only one", () => {
    // Null in `author_id` is what every comment a desktop has ever
    // written carries, and it reads as "the local person" rather than as
    // "unknown". A fixture that started stamping it would change what
    // every existing row means.
    expect(humanAuthor(actingCaller(handle.db, undefined))).toEqual({ type: "human" });
  });

  it("puts the person on a comment written by a signed-in device", () => {
    const anna = person("Anna");
    const device = deviceOf(anna.id, "anna-macbook");

    expect(humanAuthor(actingCaller(handle.db, device.id))).toEqual({ type: "human", personId: anna.id });
  });
});

describe("which projects a caller may be shown", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  function person(name: string, isAdmin = false) {
    return createPerson(handle.db, { name, email: `${name.toLowerCase()}@example.com`, isAdmin });
  }

  function deviceOf(personId: Uuid, name: string) {
    return issueDevice(handle.db, { personId, name, tokenHash: `hash-${name}`, secretsKeyHash: null });
  }

  it("narrows nobody while there is only one person", () => {
    // A solo installation has nothing to narrow to, and the rule must
    // not start describing one. Asked before the queries so the common
    // case does not pay for an answer that cannot change.
    const alone = person("Alone");
    const caller = actingCaller(handle.db, deviceOf(alone.id, "a-browser").id);

    // Two people exist by now — the migration's local row and this one —
    // so this is deliberately about a database with exactly one.
    expect(visibleProjectIds(handle.db, { ...caller, person: null, admin: true })).toBeNull();
  });

  it("shows an admin every project, including ones they have no work on", () => {
    const dana = person("Dana", true);
    const theirs = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const somebodyElses = createProject(handle.db, { name: "Marketing", keyPrefix: "MKT" });

    const caller = actingCaller(handle.db, deviceOf(dana.id, "danas-browser").id);

    expect(visibleProjectIds(handle.db, caller)).toBeNull();
    expect(visibleProjects(handle.db, caller)).toEqual([theirs.id, somebodyElses.id]);
  });

  it("shows a colleague only the projects they have work on", () => {
    const anna = person("Anna");
    person("Dana", true);
    const hers = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const theirs = createProject(handle.db, { name: "Marketing", keyPrefix: "MKT" });
    createTestItem(handle.db, { projectId: hers.id, title: "A case", type: "story", stepId: null, createdBy: anna.id });
    createTestItem(handle.db, { projectId: theirs.id, title: "A campaign", type: "story", stepId: null });

    const caller = actingCaller(handle.db, deviceOf(anna.id, "annas-browser").id);

    expect(visibleProjects(handle.db, caller)).toEqual([hers.id]);
  });

  it("counts an item assigned to them as work on that project", () => {
    const anna = person("Anna");
    person("Dana", true);
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const item = createTestItem(handle.db, { projectId: project.id, title: "Somebody else filed it", type: "story", stepId: null });
    setItemAssignee(handle.db, item.id, anna.id);

    const caller = actingCaller(handle.db, deviceOf(anna.id, "annas-browser").id);

    expect(visibleProjects(handle.db, caller)).toEqual([project.id]);
  });

  it("counts a step that waits on a group they are in", () => {
    // "Support team · anyone claims" (ARCHITECTURE.md, "Identity"). A person on the rota has
    // not necessarily touched an item on the project yet, and a switcher
    // that hid it from them would hide the queue they were hired for.
    const anna = person("Anna");
    person("Dana", true);
    const support = saveGroup(handle.db, { name: "Support team", memberIds: [anna.id] });
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    // The seeded pipeline belongs to no project until one adopts it,
    // which is what attaching a repository does on a real installation.
    const pipeline = listPipelines(handle.db)[0]!;
    adoptPipeline(handle.db, pipeline.id, project.id);
    const userStep = listStepsForPipeline(handle.db, pipeline.id).find((step) => step.type === "user")!;
    setStepOwner(handle.db, userStep.id, { personId: null, groupId: support.id });

    const caller = actingCaller(handle.db, deviceOf(anna.id, "annas-browser").id);

    expect(visibleProjects(handle.db, caller)).toEqual([project.id]);
  });

  it("shows a device it does not recognise nothing at all", () => {
    createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    person("Dana", true);

    expect(visibleProjects(handle.db, actingCaller(handle.db, uuidv7()))).toEqual([]);
  });
});

describe("which project a board read answers for", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("leaves a desktop's own choice alone", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });

    expect(scopedProjectId(handle.db, actingCaller(handle.db, undefined), project.id)).toBe(project.id);
    // Including "no project at all", which is what an installation
    // before its first project is looking at.
    expect(scopedProjectId(handle.db, actingCaller(handle.db, undefined), null)).toBeNull();
  });

  it("puts a colleague on a project they can see rather than the installation's", () => {
    // The hole this closes: `projects:list` narrowed and the board did
    // not, so a person whose switcher listed one project was handed the
    // cards of another with nothing on screen explaining it.
    const anna = createPerson(handle.db, { name: "Anna", email: "anna@example.com" });
    createPerson(handle.db, { name: "Dana", email: "dana@example.com", isAdmin: true });
    const hers = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const theirs = createProject(handle.db, { name: "Marketing", keyPrefix: "MKT" });
    createTestItem(handle.db, { projectId: hers.id, title: "A case", type: "story", stepId: null, createdBy: anna.id });

    const caller = actingCaller(handle.db, issueDevice(handle.db, { personId: anna.id, name: "annas-browser", tokenHash: "h", secretsKeyHash: null }).id);

    expect(scopedProjectId(handle.db, caller, theirs.id)).toBe(hers.id);
    expect(scopedProjectId(handle.db, caller, hers.id)).toBe(hers.id);
  });
});
