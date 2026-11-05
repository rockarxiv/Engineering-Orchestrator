import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_SPEC_SHAPE, developerRegistry, schemaByAction, type ItemTypeEntry, type Uuid } from "@eo/core";
import type { DbHandle } from "../client.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../testHelpers.js";
import { adoptProjectlessItems, createItem, getItem, listItems } from "./itemsRepo.js";
import { listWorkspaces } from "./workspacesRepo.js";
import { createProject, listProjects } from "./projectsRepo.js";
import { copyItemTypesToProject, getItemType, itemTypesFor, listItemTypes, resolveItemType, syncItemTypes } from "./itemTypesRepo.js";

/** What the developer pack ships, as the startup seed reads it. */
function developerTypes(): ItemTypeEntry[] {
  return [...developerRegistry().itemTypes.values()];
}

/** A second pack's `case`, and a third's — the same word, two packs (ARCHITECTURE.md, "An item type is data"). */
function caseType(packSlug: string, label: string): ItemTypeEntry {
  return { packSlug, slug: "case", label, plural: `${label}s`, container: false, specShape: EMPTY_SPEC_SHAPE, actionOverrides: {} };
}

describe("item types as rows (KAN-129)", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("gives a database being born the three the developer pack ships, in the installation scope", () => {
    expect(listItemTypes(handle.db, null).map((type) => type.slug).sort()).toEqual(["bug", "feature", "story"]);

    const feature = listItemTypes(handle.db, null).find((type) => type.slug === "feature")!;
    expect(feature).toMatchObject({ packSlug: "developer", label: "Feature", plural: "Features", container: true });

    // The shape is a JSON Schema for the item's `spec` (KAN-147): what
    // creation validates against, and what the intake schema is composed
    // from. `required` is how "creation demands this" is spelled, and
    // `x-eo-criteria` is how a type says which field holds its criteria.
    const story = listItemTypes(handle.db, null).find((type) => type.slug === "story")!;
    expect(story.specShape).toMatchObject({
      type: "object",
      required: ["acceptance_criteria"],
      properties: { acceptance_criteria: { type: "array", items: { type: "string" }, minItems: 1, "x-eo-criteria": true } },
    });
  });

  it("writes refine's two shapes onto the rows, which is what five branches say today (KAN-129)", () => {
    const byType = new Map(listItemTypes(handle.db, null).map((type) => [type.slug, type]));

    // A container is broken into stories: the refine shape, the
    // `decomposed` route, and a plan a person approves.
    expect(byType.get("feature")?.actionOverrides).toEqual({
      refine: { schema: "refine", resultKey: "decomposed", poster: "refine_proposal" },
    });
    // A leaf is checked rather than broken up, and says so in the other
    // shape. Written on the leaf rows too, not left to a default nobody
    // can see (ARCHITECTURE.md, "An item type is data").
    const clarifies = { refine: { schema: "clarify", resultKey: "clarified", poster: "clarification_note" } };
    expect(byType.get("story")?.actionOverrides).toEqual(clarifies);
    expect(byType.get("bug")?.actionOverrides).toEqual(clarifies);

    // And every schema an override names is one the registry can
    // answer — an override naming nothing would be data in appearance
    // only.
    for (const type of byType.values()) {
      for (const override of Object.values(type.actionOverrides)) {
        expect(schemaByAction(developerRegistry(), override.schema), override.schema).toBeDefined();
      }
    }
  });

  it("stamps a new project with its own copy, so renaming one does not rename the others", () => {
    attachWorkspace(handle.db, { name: "api", repoPath: "/tmp/api", keyPrefix: "API" });
    const [project] = listProjects(handle.db);

    expect(listItemTypes(handle.db, project!.id).map((type) => type.slug).sort()).toEqual(["bug", "feature", "story"]);
    // A copy, not the installation's rows shared: the ids differ, which
    // is what lets the design's editor touch one project's and no other's.
    const installation = new Set(listItemTypes(handle.db, null).map((type) => type.id));
    expect(listItemTypes(handle.db, project!.id).some((type) => installation.has(type.id))).toBe(false);
  });

  it("creates the pack's types once on an installation that has none, and nothing on the next start", () => {
    // The upgrade this story is written for, produced honestly: the
    // rows the migration wrote, deleted, which is the state an
    // installation that gained a pack is in.
    handle.db.run(sql`DELETE FROM item_types`);

    const first = syncItemTypes(handle.db, developerTypes());
    expect(first.created.sort()).toEqual(["developer:bug", "developer:feature", "developer:story"]);

    const second = syncItemTypes(handle.db, developerTypes());
    expect(second.created).toEqual([]);
    expect(listItemTypes(handle.db, null)).toHaveLength(3);
  });

  it("reaches every project as well as the installation, so an existing board gains a pack's new type", () => {
    attachWorkspace(handle.db, { name: "api", repoPath: "/tmp/api", keyPrefix: "API" });
    const [project] = listProjects(handle.db);

    const report = syncItemTypes(handle.db, [...developerTypes(), caseType("support", "Case")]);

    // Once for the installation and once for the project; the three the
    // developer pack ships were already there and are left alone.
    expect(report.created).toEqual(["support:case", "support:case"]);
    expect(listItemTypes(handle.db, project!.id).map((type) => type.slug)).toContain("case");
    expect(listItemTypes(handle.db, null).map((type) => type.slug)).toContain("case");
  });

  it("leaves a type somebody edited exactly as they left it", () => {
    handle.db.run(sql`UPDATE item_types SET label = 'Chore' WHERE slug = 'story' AND project_id IS NULL`);

    syncItemTypes(handle.db, developerTypes());

    expect(listItemTypes(handle.db, null).find((type) => type.slug === "story")?.label).toBe("Chore");
  });

  it("answers a slug its project does not have with a refusal naming it, rather than an exception", () => {
    attachWorkspace(handle.db, { name: "api", repoPath: "/tmp/api", keyPrefix: "API" });
    const [project] = listProjects(handle.db);

    const resolved = resolveItemType(handle.db, project!.id, "incident");

    expect(resolved.ok).toBe(false);
    expect(resolved).toMatchObject({ slug: "incident" });
    expect(resolved.ok === false && resolved.problem).toContain('"incident"');
    // And it says what there is instead, because a refusal that names
    // only what is missing leaves the asker guessing.
    expect(resolved.ok === false && resolved.problem).toContain("story");
  });

  it("refuses to create an item of a type this project does not have, with a result naming the slug", () => {
    attachWorkspace(handle.db, { name: "api", repoPath: "/tmp/api", keyPrefix: "API" });
    const [project] = listProjects(handle.db);
    handle.db.run(sql`DELETE FROM item_types WHERE slug = 'bug' AND project_id = ${project!.id}`);

    // The repository's own answer, not a thrown error: creating an item
    // of a type a project does not have is a refusal, and `slug` is on
    // the result so a caller can act on it without reading the prose.
    const refused = createItem(handle.db, { type: "bug", projectId: project!.id, title: "Something broken", stepId: "todo" });

    expect(refused.ok).toBe(false);
    expect(refused).toMatchObject({ ok: false, slug: "bug" });
    expect(refused.ok === false && refused.problem).toContain('"bug"');
    // Nothing was written, the key counter included: a refused request
    // must not leave the next item numbered as though it had happened.
    expect(listItems(handle.db)).toEqual([]);

    // The type it does have still works, so this is a refusal about one
    // slug rather than a project that has stopped accepting work.
    const made = createItem(handle.db, { type: "story", projectId: project!.id, title: "Some work", stepId: "todo" });
    expect(made.ok && made.item.type).toBe("story");
    expect(made.ok && made.item.key).toBe("API-1");
  });

  it("seeds two packs' same-named types side by side, each under its own pack (§2.2)", () => {
    attachWorkspace(handle.db, { name: "api", repoPath: "/tmp/api", keyPrefix: "API" });
    const [project] = listProjects(handle.db);

    const report = syncItemTypes(handle.db, [caseType("support", "Case"), caseType("legal", "Case")]);

    // Two rows per scope, not one pack overwriting the other: the
    // table's identity is (project, pack, slug), and "Case (Support)"
    // beside "Case (Legal)" is what the picker is meant to show.
    expect(report.created).toEqual(["support:case", "support:case", "legal:case", "legal:case"]);
    expect(listItemTypes(handle.db, project!.id).filter((type) => type.slug === "case").map((type) => type.packSlug).sort()).toEqual([
      "legal",
      "support",
    ]);
    // And the registry holds both, because it is keyed by the pair too.
    expect([...itemTypesFor(handle.db, project!.id).keys()].filter((key) => key.endsWith(":case")).sort()).toEqual(["legal:case", "support:case"]);
  });

  it("refuses a word two packs both ship, and answers the qualified name", () => {
    attachWorkspace(handle.db, { name: "api", repoPath: "/tmp/api", keyPrefix: "API" });
    const [project] = listProjects(handle.db);
    syncItemTypes(handle.db, [caseType("support", "Case"), caseType("legal", "Case")]);

    // The bare word names two rows. Refused rather than resolved, for
    // `PackCollisionError`'s reason: whichever was dropped would be
    // somebody's type, silently.
    const ambiguous = resolveItemType(handle.db, project!.id, "case");
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.ok === false && ambiguous.problem).toContain("legal:case");
    expect(ambiguous.ok === false && ambiguous.problem).toContain("support:case");

    // Said which, it answers.
    const exact = resolveItemType(handle.db, project!.id, { packSlug: "legal", slug: "case" });
    expect(exact.ok && exact.type.packSlug).toBe("legal");

    // A pack that ships nothing of that name is a refusal naming what
    // was asked for, qualified as it was asked.
    const missing = resolveItemType(handle.db, project!.id, { packSlug: "finance", slug: "case" });
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.problem).toContain("finance:case");
  });

  it("creates an item of a qualified type, and refuses the bare word two packs share", () => {
    attachWorkspace(handle.db, { name: "api", repoPath: "/tmp/api", keyPrefix: "API" });
    const [project] = listProjects(handle.db);
    syncItemTypes(handle.db, [caseType("support", "Case"), caseType("legal", "Case")]);

    const refused = createItem(handle.db, { type: "case", projectId: project!.id, title: "Whose case?", stepId: "todo" });
    expect(refused).toMatchObject({ ok: false, slug: "case" });

    const made = createItem(handle.db, { type: { packSlug: "support", slug: "case" }, projectId: project!.id, title: "A case", stepId: "todo" });
    expect(made.ok && made.item.type).toBe("case");
    // The row it points at is the support pack's, which is the whole
    // point of the qualified name.
    expect(made.ok && getItemType(handle.db, made.item.typeId)?.packSlug).toBe("support");
  });

  it("keeps each project's types to itself", () => {
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    const admin = createProject(handle.db, { name: "Admin", keyPrefix: "ADM" });
    handle.db.run(sql`UPDATE item_types SET label = 'Case' WHERE slug = 'story' AND project_id = ${shop.id}`);

    expect(itemTypesFor(handle.db, shop.id).get("developer:story")?.label).toBe("Case");
    expect(itemTypesFor(handle.db, admin.id).get("developer:story")?.label).toBe("Story");
    // And an item that belongs to no project reads the installation's.
    expect(itemTypesFor(handle.db, null).get("developer:story")?.label).toBe("Story");
  });

  it("moves an adopted item onto its new project's type row", () => {
    // Work written before any repository was attached belongs to no
    // project and resolves against the installation scope. When the
    // first repository adopts it (KAN-17) the row it points at has to
    // move with it, or renaming the project's "Story" would leave the
    // adopted items reading a label the configure screen cannot reach.
    const orphan = createTestItem(handle.db, { type: "story", title: "Before any repository", stepId: "todo" });
    attachWorkspace(handle.db, { name: "api", repoPath: "/tmp/api", keyPrefix: "API" });
    const [project] = listProjects(handle.db);

    expect(adoptProjectlessItems(handle.db, listWorkspaces(handle.db)[0]!.id, project!.id)).toBe(1);

    const typeId = handle.db.get<{ type_id: string }>(sql`SELECT type_id FROM items WHERE id = ${orphan.id}`)!.type_id;
    expect(listItemTypes(handle.db, project!.id).map((type) => type.id)).toContain(typeId);
    expect(getItem(handle.db, orphan.id)?.type).toBe("story");
  });

  it("adopts a projectless item onto its own pack's row, not a word two packs share", () => {
    // The case the bare word cannot answer: an item of the support
    // pack's `case`, written before any repository existed, arriving at
    // a project that also has the legal pack's. Asked by the word, the
    // lookup has two answers and is refused — leaving the item
    // project-scoped and still pointing at the installation's row.
    // Asked by the row it holds, there is one answer.
    syncItemTypes(handle.db, [caseType("support", "Case"), caseType("legal", "Case")]);
    const orphan = createItem(handle.db, { type: { packSlug: "support", slug: "case" }, title: "Before any repository", stepId: "todo" });
    expect(orphan.ok).toBe(true);
    if (!orphan.ok) return;

    attachWorkspace(handle.db, { name: "api", repoPath: "/tmp/api", keyPrefix: "API" });
    const [project] = listProjects(handle.db);
    adoptProjectlessItems(handle.db, listWorkspaces(handle.db)[0]!.id, project!.id);

    const moved = getItem(handle.db, orphan.item.id)!;
    const type = getItemType(handle.db, moved.typeId)!;
    expect(moved.projectId).toBe(project!.id);
    // This project's row, this pack's type — not the installation's, and
    // not the other pack's.
    expect(type.projectId).toBe(project!.id);
    expect(type.packSlug).toBe("support");
    expect(moved.type).toBe("case");
  });

  it("leaves an adopted item on the row it has when the project lacks that pack's type", () => {
    // `syncItemTypes` gives every project every installed pack's types,
    // so this is a row somebody deleted. The item is still of a valid
    // type and still reads the right word; it is merely in the wider
    // scope, which is wrong in a smaller way than an onboarding that
    // throws.
    syncItemTypes(handle.db, [caseType("support", "Case")]);
    const orphan = createItem(handle.db, { type: { packSlug: "support", slug: "case" }, title: "Before any repository", stepId: "todo" });
    if (!orphan.ok) return;
    attachWorkspace(handle.db, { name: "api", repoPath: "/tmp/api", keyPrefix: "API" });
    const [project] = listProjects(handle.db);
    handle.db.run(sql`DELETE FROM item_types WHERE pack_slug = 'support' AND project_id = ${project!.id}`);

    adoptProjectlessItems(handle.db, listWorkspaces(handle.db)[0]!.id, project!.id);

    const moved = getItem(handle.db, orphan.item.id)!;
    expect(moved.projectId).toBe(project!.id);
    expect(moved.typeId).toBe(orphan.item.typeId);
    expect(moved.type).toBe("case");
  });

  it("copies nothing twice when a project already has a pack's type", () => {
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });

    expect(copyItemTypesToProject(handle.db, shop.id as Uuid)).toBe(0);
    expect(listItemTypes(handle.db, shop.id)).toHaveLength(3);
  });
});
