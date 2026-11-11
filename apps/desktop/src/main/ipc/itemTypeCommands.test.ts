import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actionOverrideFor, LOCAL_PACK, LOCAL_PERSON_ID, specFields, type SpecFieldDraft, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listProjects } from "../db/repos/index.js";
import { createItemType, getItemType, itemTypesFor, listItemTypes, syncItemTypes } from "../db/repos/itemTypesRepo.js";
import { getItem, listOpenMessages } from "../db/repos/index.js";
import { registryForProject } from "../registry.js";
import { applyNewItem } from "../roles/discussion.js";
import { ADDED_FIELD_COLLISION_SOURCE, announceAddedFieldCollisions, createItemTypeCommand, deleteItemTypeCommand, listItemTypesCommand, updateItemTypeCommand } from "./itemTypeCommands.js";

/**
 * Making an item type in the configure screen (ARCHITECTURE.md, "An item type is data", KAN-164).
 *
 * The four channels behind the Types section. What is being tested is
 * the judgement rather than the SQL: which of a type's three parts a
 * person may change, when a word is already taken, and why a type with
 * work under it stays — plus the two ends of the story's own example,
 * that a "Case" created here can be filed against and that a Case
 * without a customer is refused by the shape the form compiled.
 */
const CASE_FIELDS: SpecFieldDraft[] = [
  { name: "customer", kind: "string", required: true },
  { name: "channel", kind: "string", required: false },
];

describe("creating an item type without writing code", () => {
  let handle: DbHandle;
  let projectId: Uuid;

  beforeEach(() => {
    handle = openMigratedTestDb();
    attachWorkspace(handle.db, { name: "acme-support", keyPrefix: "SUP", repoPath: "/tmp/eo-item-types", baseBranch: "main" });
    projectId = listProjects(handle.db)[0]!.id;
  });

  afterEach(() => {
    handle.close();
  });

  function createCase() {
    return createItemTypeCommand(handle.db, { projectId, label: "Case", plural: "Cases", container: false, fields: CASE_FIELDS });
  }

  it("files it under the word its label makes, in the local pack and on this project alone", () => {
    const created = createCase();

    expect(created.problem).toBeNull();
    expect(created.type).toMatchObject({ packSlug: LOCAL_PACK, slug: "case", label: "Case", plural: "Cases", container: false, itemCount: 0 });
    // This project's, not the installation's: a type added here is not
    // added to every other project on the machine.
    expect(listItemTypes(handle.db, null).map((type) => type.slug)).not.toContain("case");
    expect(listItemTypesCommand(handle.db, { projectId }).types.map((type) => type.slug)).toContain("case");
  });

  it("makes it something an item can be filed as, and refuses a Case with no customer", () => {
    createCase();

    const withCustomer = applyNewItem(
      handle.db,
      projectId,
      { type: "case", title: "Card declined", body: "…", spec: { customer: "Acme", channel: "email" }, depends_on: [] },
      null,
    );
    expect(withCustomer.ok).toBe(true);

    const without = applyNewItem(handle.db, projectId, { type: "case", title: "Card declined", body: "…", spec: { channel: "email" }, depends_on: [] }, null);
    expect(without).toMatchObject({ ok: false });
    // Refused by the shape the form compiled, which is why the sentence
    // names the field rather than the type.
    expect(without.ok === false && without.reason).toContain("customer");
  });

  it("refuses a container at the door, whoever names one", () => {
    // Every path through `applyNewItem` files exactly one thing onto a
    // pipeline step, and a container is neither work nor on a pipeline
    // (ARCHITECTURE.md, "One work entity") — so the guard is at the door rather than at each
    // caller,
    // now that the approval gate (ARCHITECTURE.md, "An item type is data") is a second way to name
    // a type.
    const refused = applyNewItem(handle.db, projectId, { type: "feature", title: "Rate limiting", body: "…", spec: {}, depends_on: [] }, null);

    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok === false && refused.reason).toContain("holds work rather than being work");
  });

  it("inherits the leaf action defaults, having said nothing about any action", () => {
    createCase();
    const registry = registryForProject(handle.db, projectId);

    // The original design: "a hand-made leaf type inherits the leaf action defaults".
    // Nothing wrote `clarify` onto the row — the empty override record
    // falls through to what the role that ships `refine` declares for a
    // leaf, which is the same answer a story gets.
    expect(actionOverrideFor(registry, "refine", registry.itemTypes.get(`${LOCAL_PACK}:case`))).toEqual(
      actionOverrideFor(registry, "refine", registry.itemTypes.get("developer:story")),
    );
  });

  it("refuses a second type that would answer to a word already taken", () => {
    createCase();

    const again = createItemTypeCommand(handle.db, { projectId, label: "case", plural: "Cases", container: false, fields: [] });

    expect(again.type).toBeNull();
    expect(again.problem).toContain("case");
    expect(listItemTypesCommand(handle.db, { projectId }).types.filter((type) => type.slug === "case")).toHaveLength(1);
  });

  it("refuses a draft the form would have refused too", () => {
    const refused = createItemTypeCommand(handle.db, { projectId, label: "   ", plural: "Cases", container: false, fields: [] });

    expect(refused.type).toBeNull();
    expect(refused.problem).toContain("needs a name");
  });

  it("normalises a field name into the key an agent will answer with", () => {
    const created = createItemTypeCommand(handle.db, {
      projectId,
      label: "Case",
      plural: "Cases",
      container: false,
      fields: [{ name: "Customer name", kind: "string", required: true }],
    });

    expect(specFields(created.type!.specShape).map((field) => field.name)).toEqual(["customer_name"]);
  });
});

describe("editing a type that is already there", () => {
  let handle: DbHandle;
  let projectId: Uuid;

  beforeEach(() => {
    handle = openMigratedTestDb();
    attachWorkspace(handle.db, { name: "acme-support", keyPrefix: "SUP", repoPath: "/tmp/eo-item-types-edit", baseBranch: "main" });
    projectId = listProjects(handle.db)[0]!.id;
  });

  afterEach(() => {
    handle.close();
  });

  function story() {
    return listItemTypesCommand(handle.db, { projectId }).types.find((type) => type.slug === "story")!;
  }

  it("renames what a pack ships", () => {
    const renamed = updateItemTypeCommand(handle.db, { id: story().id, label: "Requirement", plural: "Requirements" });

    expect(renamed.problem).toBeNull();
    expect(renamed.type).toMatchObject({ slug: "story", label: "Requirement", plural: "Requirements" });
  });

  it("refuses to reshape one, rather than quietly ignoring the attempt", () => {
    const before = story();

    const reshaped = updateItemTypeCommand(handle.db, { id: before.id, fields: [] });
    const flipped = updateItemTypeCommand(handle.db, { id: before.id, container: true });

    expect(reshaped.type).toBeNull();
    expect(reshaped.problem).toContain("developer pack");
    expect(flipped.type).toBeNull();
    // And nothing moved.
    expect(story()).toEqual(before);
  });

  it("reshapes one nobody shipped", () => {
    const created = createItemTypeCommand(handle.db, { projectId, label: "Case", plural: "Cases", container: false, fields: CASE_FIELDS });

    const edited = updateItemTypeCommand(handle.db, {
      id: created.type!.id,
      label: "Case",
      plural: "Cases",
      container: true,
      fields: [{ name: "customer", kind: "string", required: false }],
    });

    expect(edited.problem).toBeNull();
    expect(edited.type).toMatchObject({ container: true });
    expect(edited.type!.specShape.required).toEqual([]);
  });

  it("says so when the row is not there any more", () => {
    expect(updateItemTypeCommand(handle.db, { id: "nope", label: "Case" }).problem).toContain("not here");
  });
});

describe("a project's own optional fields on a pack's type (EO-735)", () => {
  let handle: DbHandle;
  let projectId: Uuid;

  beforeEach(() => {
    handle = openMigratedTestDb();
    attachWorkspace(handle.db, { name: "acme-support", keyPrefix: "SUP", repoPath: "/tmp/eo-item-types-added", baseBranch: "main" });
    projectId = listProjects(handle.db)[0]!.id;
  });

  afterEach(() => {
    handle.close();
  });

  function packType() {
    return listItemTypesCommand(handle.db, { projectId }).types.find((type) => type.packSlug === "developer" && type.slug === "story")!;
  }

  /** The pack's fields exactly as the row has them, which every field list for its type starts with. */
  function packFields(): SpecFieldDraft[] {
    return specFields(packType().specShape)
      .filter((field) => !field.added)
      .map(({ name, kind, required }) => ({ name, kind, required }));
  }

  const AUTOMERGE: SpecFieldDraft = { name: "automerge", kind: "boolean", required: false };
  const NO_REVIEWERS: SpecFieldDraft = { name: "no_reviewers", kind: "boolean", required: false };

  function addFields(...added: SpecFieldDraft[]) {
    return updateItemTypeCommand(handle.db, { id: packType().id, fields: [...packFields(), ...added] });
  }

  function file(spec: Record<string, unknown>) {
    return applyNewItem(handle.db, projectId, { type: "story", title: "Throttle checkout", body: "…", spec: { acceptance_criteria: ["It throttles"], ...spec }, depends_on: [] }, null);
  }

  it("accepts optional fields beside the pack's, marked as added and leaving the pack's document as it was", () => {
    const before = packType();

    const saved = addFields(AUTOMERGE, NO_REVIEWERS);

    expect(saved.problem).toBeNull();
    const after = packType();
    const fields = specFields(after.specShape);
    expect(fields.filter((field) => field.added).map(({ name, kind, required }) => ({ name, kind, required }))).toEqual([AUTOMERGE, NO_REVIEWERS]);
    // The pack's properties are the pack's document, every keyword kept.
    for (const [name, property] of Object.entries(before.specShape.properties)) expect(after.specShape.properties[name]).toEqual(property);
    expect(after.specShape.required).toEqual(before.specShape.required);
    expect(after.container).toBe(before.container);
    expect(getItemType(handle.db, after.id as Uuid)!.actionOverrides).toEqual(getItemType(handle.db, before.id as Uuid)!.actionOverrides);
    // And the registry the doors read carries them.
    expect(Object.keys(itemTypesFor(handle.db, projectId).get("developer:story")!.specShape.properties)).toEqual(expect.arrayContaining(["automerge", "no_reviewers"]));
  });

  it("files an item of the type without them, and holds a value to its kind", () => {
    addFields(AUTOMERGE);

    expect(file({}).ok).toBe(true);
    const set = file({ automerge: true });
    expect(set.ok).toBe(true);
    const wrongKind = file({ automerge: "yes" });
    expect(wrongKind.ok).toBe(false);
    expect(wrongKind.ok === false && wrongKind.reason).toContain("automerge");
  });

  it("refuses a required added field, naming it", () => {
    const refused = addFields({ ...AUTOMERGE, required: true });

    expect(refused.type).toBeNull();
    expect(refused.problem).toContain("“automerge” cannot be required");
  });

  it("refuses removing, re-kinding or un-requiring a pack field, naming which", () => {
    const fields = packFields();
    const first = fields[0]!;

    const removed = updateItemTypeCommand(handle.db, { id: packType().id, fields: fields.slice(1) });
    expect(removed.problem).toContain(`“${first.name}” is the developer pack's field`);

    const rekinded = updateItemTypeCommand(handle.db, { id: packType().id, fields: [{ ...first, kind: "number" }, ...fields.slice(1)] });
    expect(rekinded.problem).toContain(`already has a field “${first.name}” from the developer pack`);

    const loosened = updateItemTypeCommand(handle.db, { id: packType().id, fields: [{ ...first, required: !first.required }, ...fields.slice(1)] });
    expect(loosened.problem).toContain(`Whether “${first.name}” is required`);
  });

  it("refuses a field of the project's own under a pack field's name", () => {
    const taken = packFields()[0]!;

    const refused = addFields({ name: taken.name, kind: taken.kind === "boolean" ? "number" : "boolean", required: false });

    expect(refused.type).toBeNull();
    expect(refused.problem).toContain(`already has a field “${taken.name}” from the developer pack`);
  });

  it("keeps a pack field's name as the pack wrote it, hyphen or capitals, and adds beside it", () => {
    // `SpecShapeSchema` allows any of these as a pack's field name; each is
    // the key the type's items hold their value under, so none of them is
    // normalised into another — or into the others.
    const shipped = createItemType(handle.db, {
      projectId,
      packSlug: "support",
      slug: "case",
      label: "Case",
      plural: "Cases",
      container: false,
      specShape: {
        type: "object",
        properties: { "customer-name": { type: "string", minLength: 1 }, customerName: { type: "string" }, customer_name: { type: "string" } },
        required: ["customer-name"],
      },
    });
    const own: SpecFieldDraft[] = [
      { name: "customer-name", kind: "string", required: true },
      { name: "customerName", kind: "string", required: false },
      { name: "customer_name", kind: "string", required: false },
    ];

    const saved = updateItemTypeCommand(handle.db, { id: shipped.id, fields: [...own, { name: "Escalated", kind: "boolean", required: false }] });

    expect(saved.problem).toBeNull();
    const after = getItemType(handle.db, shipped.id)!;
    expect(Object.keys(after.specShape.properties)).toEqual(["customer-name", "customerName", "customer_name", "escalated"]);
    expect(after.specShape.properties["customer-name"]).toEqual(shipped.specShape.properties["customer-name"]);
    expect(after.specShape.required).toEqual(["customer-name"]);
    expect(specFields(after.specShape).filter((field) => field.added).map((field) => field.name)).toEqual(["escalated"]);

    // A field of the project's own typed so it normalises onto a pack name is still the pack's name.
    const typedOnto = updateItemTypeCommand(handle.db, { id: shipped.id, fields: [...own, { name: "Customer Name", kind: "boolean", required: false }] });
    expect(typedOnto.type).toBeNull();
    expect(typedOnto.problem).toContain("already has a field “customer_name” from the support pack");
  });

  it("still refuses the container flag and the action overrides, saying which", () => {
    const flipped = updateItemTypeCommand(handle.db, { id: packType().id, container: true });
    expect(flipped.problem).toContain("whether it holds other items is the pack's");

    const overridden = updateItemTypeCommand(handle.db, { id: packType().id, actionOverrides: { refine: {} } });
    expect(overridden.type).toBeNull();
    expect(overridden.problem).toContain("what an action means on it is the pack's");
  });

  it("renames and removes an added field nothing holds a value for", () => {
    addFields(AUTOMERGE);
    file({});

    const renamed = addFields({ ...AUTOMERGE, name: "auto merge" });
    expect(renamed.problem).toBeNull();
    expect(specFields(packType().specShape).filter((field) => field.added).map((field) => field.name)).toEqual(["auto_merge"]);

    const removed = addFields();
    expect(removed.problem).toBeNull();
    expect(specFields(packType().specShape).some((field) => field.added)).toBe(false);
  });

  it("refuses removing or renaming one items hold a value for, with the count — false included", () => {
    addFields(AUTOMERGE);
    file({ automerge: true });
    file({ automerge: false });
    file({});

    const removed = addFields();
    expect(removed.type).toBeNull();
    expect(removed.problem).toContain("2 stories hold a value for “automerge”");

    const renamed = addFields({ ...AUTOMERGE, name: "merge_itself" });
    expect(renamed.problem).toContain("2 stories hold a value for “automerge”");
    expect(specFields(packType().specShape).filter((field) => field.added).map((field) => field.name)).toEqual(["automerge"]);
  });

  it("holds a type made here to the same rule about values", () => {
    const created = createItemTypeCommand(handle.db, { projectId, label: "Case", plural: "Cases", container: false, fields: CASE_FIELDS });
    applyNewItem(handle.db, projectId, { type: "case", title: "Card declined", body: "…", spec: { customer: "Acme", channel: "email" }, depends_on: [] }, null);

    const dropped = updateItemTypeCommand(handle.db, { id: created.type!.id, fields: [CASE_FIELDS[0]!] });

    expect(dropped.problem).toBe("1 case holds a value for “channel”. Clear it on that item before removing or renaming the field, or changing its kind.");
  });

  it("keeps the added fields and their values through a pack's seed, and refuses a pack field of the same name with a message naming both", () => {
    addFields(AUTOMERGE);
    const filed = file({ automerge: true });
    const before = packType();

    // The pack's next version ships its own `automerge` on the type.
    const shipped = itemTypesFor(handle.db, projectId).get("developer:story")!;
    const pack = {
      ...shipped,
      specShape: {
        ...shipped.specShape,
        properties: Object.fromEntries([
          ...Object.entries(shipped.specShape.properties).filter(([, property]) => property["x-eo-added"] !== true),
          ["automerge", { type: "string" as const }],
        ]),
      },
    };
    const report = syncItemTypes(handle.db, [pack]);

    expect(report.created).toEqual([]);
    expect(report.collisions.filter((collision) => collision.type.projectId === projectId).map((collision) => collision.field)).toEqual(["automerge"]);
    // Nothing merged: the row, and the item's value, are as they were.
    expect(packType()).toEqual(before);
    expect(filed.ok && getItem(handle.db, filed.created[0]!.id)?.spec).toMatchObject({ automerge: true });

    expect(announceAddedFieldCollisions(handle.db, report.collisions, false)).toBe(report.collisions.length);
    const told = listOpenMessages(handle.db, [LOCAL_PERSON_ID]).filter((message) => message.source === ADDED_FIELD_COLLISION_SOURCE && message.projectId === projectId);
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain("The developer pack's “Story” has a field “automerge”, and acme-support already added a field “automerge” of its own");
    expect(told[0]!.body).toContain("merged nothing");
    // Once: the seed runs on every launch.
    expect(announceAddedFieldCollisions(handle.db, syncItemTypes(handle.db, [pack]).collisions, false)).toBe(0);
  });
});

describe("deleting a type", () => {
  let handle: DbHandle;
  let projectId: Uuid;

  beforeEach(() => {
    handle = openMigratedTestDb();
    attachWorkspace(handle.db, { name: "acme-support", keyPrefix: "SUP", repoPath: "/tmp/eo-item-types-delete", baseBranch: "main" });
    projectId = listProjects(handle.db)[0]!.id;
  });

  afterEach(() => {
    handle.close();
  });

  it("refuses one with a single item on it, and the refusal names the 1", () => {
    const created = createItemTypeCommand(handle.db, { projectId, label: "Case", plural: "Cases", container: false, fields: [] });
    createTestItem(handle.db, { type: { packSlug: LOCAL_PACK, slug: "case" }, projectId, title: "Card declined", stepId: "todo" });

    const refused = deleteItemTypeCommand(handle.db, { id: created.type!.id });

    expect(refused.deleted).toBe(false);
    expect(refused.itemCount).toBe(1);
    expect(refused.problem).toContain("1 item");
    expect(listItemTypesCommand(handle.db, { projectId }).types.map((type) => type.slug)).toContain("case");
  });

  it("removes one nothing points at", () => {
    const created = createItemTypeCommand(handle.db, { projectId, label: "Case", plural: "Cases", container: false, fields: [] });

    const gone = deleteItemTypeCommand(handle.db, { id: created.type!.id });

    expect(gone).toEqual({ deleted: true, itemCount: 0, problem: null });
    expect(listItemTypesCommand(handle.db, { projectId }).types.map((type) => type.slug)).not.toContain("case");
  });

  it("refuses a pack's type even when nothing is filed as it, because the next start would write it back", () => {
    const bug = listItemTypesCommand(handle.db, { projectId }).types.find((type) => type.slug === "bug")!;

    const refused = deleteItemTypeCommand(handle.db, { id: bug.id });

    expect(refused.deleted).toBe(false);
    expect(refused.problem).toContain("developer pack");
  });

  it("counts what is filed as it, so the list can say so before anybody clicks", () => {
    createItemTypeCommand(handle.db, { projectId, label: "Case", plural: "Cases", container: false, fields: [] });
    createTestItem(handle.db, { type: { packSlug: LOCAL_PACK, slug: "case" }, projectId, title: "One", stepId: "todo" });
    createTestItem(handle.db, { type: { packSlug: LOCAL_PACK, slug: "case" }, projectId, title: "Two", stepId: "todo" });

    expect(listItemTypesCommand(handle.db, { projectId }).types.find((type) => type.slug === "case")!.itemCount).toBe(2);
  });
});
