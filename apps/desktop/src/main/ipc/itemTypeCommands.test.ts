import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actionOverrideFor, LOCAL_PACK, specFields, type SpecFieldDraft, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listProjects } from "../db/repos/index.js";
import { listItemTypes } from "../db/repos/itemTypesRepo.js";
import { registryForProject } from "../registry.js";
import { applyNewItem } from "../roles/discussion.js";
import { createItemTypeCommand, deleteItemTypeCommand, listItemTypesCommand, updateItemTypeCommand } from "./itemTypeCommands.js";

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
