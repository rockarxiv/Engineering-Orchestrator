import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resultSchemaFor } from "@eo/core";
import type { DbHandle } from "./db/client.js";
import { createAgent } from "./db/repos/agentsRepo.js";
import { saveActionDefinition } from "./db/repos/actionDefinitionsRepo.js";
import { createProject } from "./db/repos/projectsRepo.js";
import { openMigratedTestDb } from "./db/testHelpers.js";
import { registry, registryForProject } from "./registry.js";

/**
 * The registry, once item types are rows (KAN-129).
 *
 * Roles and builtins are code a pack contributes and are the same on
 * every project. Item types are data, scoped to a project, so the
 * question has a project in it — and the answer has to come from the
 * table rather than from the constants the pack shipped, or the seventh
 * story's editor would change a row nothing reads.
 */
describe("the registry as one project sees it", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("reads item types from the table, so an edited row is what a lookup answers", () => {
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    handle.db.run(sql`UPDATE item_types SET label = 'Chore', plural = 'Chores' WHERE slug = 'story' AND project_id = ${shop.id}`);

    expect(registryForProject(handle.db, shop.id).itemTypes.get("developer:story")).toMatchObject({ label: "Chore", plural: "Chores" });
    // The constants are untouched: they are what the pack ships and what
    // the startup seed writes, not what a project has.
    expect(registry.itemTypes.get("developer:story")?.label).toBe("Story");
  });

  it("answers one project's types without another's", () => {
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    const admin = createProject(handle.db, { name: "Admin", keyPrefix: "ADM" });
    handle.db.run(
      sql`INSERT INTO item_types (id, project_id, pack_slug, slug, label, plural, container, spec_shape, created_at)
          VALUES ('t-incident', ${shop.id}, 'support', 'incident', 'Incident', 'Incidents', 0, '[]', 1)`,
    );

    expect([...registryForProject(handle.db, shop.id).itemTypes.keys()].sort()).toEqual([
      "developer:bug",
      "developer:feature",
      "developer:story",
      "support:incident",
    ]);
    expect([...registryForProject(handle.db, admin.id).itemTypes.keys()].sort()).toEqual(["developer:bug", "developer:feature", "developer:story"]);
  });

  it("keeps the roles and the builtins of the installation, whatever the project", () => {
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    const scoped = registryForProject(handle.db, shop.id);

    expect([...scoped.roles.keys()]).toEqual([...registry.roles.keys()]);
    expect([...scoped.builtins.keys()]).toEqual([...registry.builtins.keys()]);
  });

  it("answers the installation scope for work that belongs to no project", () => {
    expect([...registryForProject(handle.db, null).itemTypes.keys()].sort()).toEqual(["developer:bug", "developer:feature", "developer:story"]);
  });
});

/**
 * The actions roles define for themselves (EO-421).
 *
 * A definition is a row keyed by role and action, and this is where it
 * meets the lookups that answer what a run's result is held to. It
 * replaced reading `agents.config.schemasByAction` here, which filed an
 * imported role's schema as a role entry and so answered for that action
 * on every role.
 */
describe("the actions roles define for themselves", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  const SHAPE = { type: "object", properties: { severity: { type: "string" } }, required: ["severity"] };

  it("answers for the role that defined the action, and for no other", () => {
    saveActionDefinition(handle.db, { role: "triager", action: "triage", results: [{ key: "urgent" }, { key: "routine" }], fields: SHAPE });

    const registryHere = registryForProject(handle.db, null);
    const schema = resultSchemaFor(registryHere, "triage", undefined, "triager");
    expect(schema?.parse({ result: "urgent", summary: "Paged.", severity: "high" }).ok).toBe(true);
    expect(schema?.parse({ result: "urgent", summary: "Paged." }).ok).toBe(false);
    expect(resultSchemaFor(registryHere, "triage", undefined, "sorter")).toBeUndefined();
    expect(resultSchemaFor(registryHere, "triage")).toBeUndefined();
  });

  it("reads a definition saved while the app is running", () => {
    expect(resultSchemaFor(registryForProject(handle.db, null), "triage", undefined, "triager")).toBeUndefined();

    saveActionDefinition(handle.db, { role: "triager", action: "triage", results: [{ key: "urgent" }] });
    expect(resultSchemaFor(registryForProject(handle.db, null), "triage", undefined, "triager")?.parse({ result: "urgent", summary: "Paged." }).ok).toBe(true);

    saveActionDefinition(handle.db, { role: "triager", action: "triage", results: [{ key: "routine" }] });
    expect(resultSchemaFor(registryForProject(handle.db, null), "triage", undefined, "triager")?.parse({ result: "urgent", summary: "Paged." }).ok).toBe(false);
  });

  /** `agents.config.schemasByAction` is where these used to be read from. It is not read any more. */
  it("does not read an agent's config for schemas", () => {
    createAgent(handle.db, { name: "Triager", role: "triager", provider: "claude", instructions: "Route it.", config: { schemasByAction: { triage: SHAPE } } });

    const registryHere = registryForProject(handle.db, null);
    expect(resultSchemaFor(registryHere, "triage", undefined, "triager")).toBeUndefined();
    expect(registryHere.roles.has("triager")).toBe(false);
  });

  /**
   * A row the save could not have written is skipped, not thrown. The
   * save refuses fields ajv cannot compile and a definition with no
   * results, so reaching one here takes a hand-edited database — and a
   * registry that throws is a supervisor that cannot dispatch anything
   * at all.
   */
  it("skips a row it cannot use rather than costing the installation its registry", () => {
    saveActionDefinition(handle.db, { role: "triager", action: "sort", results: [{ key: "sorted" }] });
    handle.db.run(
      sql`INSERT INTO action_definitions (id, role, action, description, results, fields, created_at, updated_at)
          VALUES ('d-broken', 'triager', 'triage', '', '[{"key":"urgent","label":"Urgent","meaning":""}]', '{"properties":{"severity":{"type":"obect"}}}', 1, 1),
                 ('d-empty', 'triager', 'grade', '', '[]', '{}', 1, 1)`,
    );

    const registryHere = registryForProject(handle.db, null);
    expect(resultSchemaFor(registryHere, "triage", undefined, "triager")).toBeUndefined();
    expect(resultSchemaFor(registryHere, "grade", undefined, "triager")).toBeUndefined();
    expect(resultSchemaFor(registryHere, "sort", undefined, "triager")).toBeDefined();
  });

  it("leaves the installed roles exactly as they are", () => {
    saveActionDefinition(handle.db, { role: "triager", action: "triage", results: [{ key: "urgent" }] });

    const roles = registryForProject(handle.db, null).roles;
    expect(roles.get("implementer")).toEqual(registry.roles.get("implementer"));
    expect([...roles.keys()]).toEqual([...registry.roles.keys()]);
  });
});
