import { resultSchemaFor } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptCarriedSchemas, carriedSchemaRefusal, migrateCarriedSchemas } from "./actionDefinitionAdoption.js";
import type { DbHandle } from "./db/client.js";
import { archiveAgent, createAgent, getAgent } from "./db/repos/agentsRepo.js";
import { getActionDefinition, listActionDefinitions, saveActionDefinition } from "./db/repos/actionDefinitionsRepo.js";
import { openMigratedTestDb } from "./db/testHelpers.js";
import { registryForProject } from "./registry.js";

const TRIAGE = {
  type: "object",
  properties: { result: { type: "string", enum: ["urgent", "routine"] }, severity: { type: "string" } },
  required: ["result", "severity"],
};
const SORT = { type: "object", properties: { bucket: { type: "string" } }, required: ["bucket"] };

/**
 * `agents.config.schemasByAction`, turned into definitions (EO-421).
 *
 * The config key was where a role that arrived as data kept its output
 * schemas, read back by the registry on every dispatch. These are the
 * rows a database that has the key ends up with, and what is left of
 * the key afterwards.
 */
describe("migrating the schemas an agent's config carried", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  function agent(role: string, config: Record<string, unknown>) {
    return createAgent(handle.db, { name: role, role, provider: "claude", instructions: "Do it.", config });
  }

  it("writes one definition per role and action: the result enum as its keys, or done where the schema has none", () => {
    agent("triager", { schemasByAction: { triage: TRIAGE, sort: SORT }, allowedTools: ["Read"] });

    const report = migrateCarriedSchemas(handle.db);

    expect(report.defined).toEqual([{ role: "triager", action: "triage" }, { role: "triager", action: "sort" }]);
    expect(listActionDefinitions(handle.db)).toHaveLength(2);
    expect(getActionDefinition(handle.db, "triager", "triage")).toMatchObject({
      results: [
        { key: "urgent", label: "Urgent", meaning: "" },
        { key: "routine", label: "Routine", meaning: "" },
      ],
      fields: { type: "object", properties: { severity: { type: "string" } }, required: ["severity"] },
    });
    expect(getActionDefinition(handle.db, "triager", "sort")).toMatchObject({
      results: [{ key: "done", label: "Done", meaning: "" }],
      fields: SORT,
    });
  });

  it("takes the key out of the agent's config and leaves the rest of it alone", () => {
    const triager = agent("triager", { schemasByAction: { triage: TRIAGE }, allowedTools: ["Read"] });

    migrateCarriedSchemas(handle.db);

    expect(getAgent(handle.db, triager.id)?.config).toEqual({ allowedTools: ["Read"] });
  });

  it("holds the role to the migrated definition, and no other role to it", () => {
    agent("triager", { schemasByAction: { triage: TRIAGE } });
    migrateCarriedSchemas(handle.db);

    const registry = registryForProject(handle.db, null);
    const schema = resultSchemaFor(registry, "triage", undefined, "triager");
    expect(schema?.parse({ result: "urgent", summary: "Paged.", severity: "high" }).ok).toBe(true);
    expect(schema?.parse({ result: "later", summary: "Paged.", severity: "high" }).ok).toBe(false);
    expect(resultSchemaFor(registry, "triage", undefined, "reviewer")).toBeUndefined();
    expect(resultSchemaFor(registry, "triage")).toBeUndefined();
  });

  it("is not read from the config any more: a key written back by hand changes nothing", () => {
    agent("triager", { schemasByAction: { triage: TRIAGE } });

    expect(resultSchemaFor(registryForProject(handle.db, null), "triage", undefined, "triager")).toBeUndefined();
    expect(resultSchemaFor(registryForProject(handle.db, null), "triage")).toBeUndefined();
  });

  it("runs again without writing anything twice", () => {
    agent("triager", { schemasByAction: { triage: TRIAGE } });
    migrateCarriedSchemas(handle.db);
    const first = listActionDefinitions(handle.db);

    expect(migrateCarriedSchemas(handle.db)).toEqual({ defined: [], packs: [], kept: [], refused: [] });
    expect(listActionDefinitions(handle.db)).toEqual(first);
  });

  it("gives a role two agents staff the first agent's schemas, once", () => {
    agent("triager", { schemasByAction: { triage: TRIAGE } });
    const second = agent("triager", { schemasByAction: { triage: SORT } });

    const report = migrateCarriedSchemas(handle.db);

    expect(report.kept).toEqual([{ role: "triager", action: "triage" }]);
    expect(getActionDefinition(handle.db, "triager", "triage")?.results.map((result) => result.key)).toEqual(["urgent", "routine"]);
    expect(getAgent(handle.db, second.id)?.config).toEqual({});
  });

  /**
   * Role plus action is the key, so a custom role's schema for a pack's
   * action name is that role's own version of it: written as its
   * definition and in force for it, while every role without one is
   * still answered by the pack.
   */
  it("makes a custom role's schema for a pack's action name that role's own definition", () => {
    const shipped = JSON.stringify(resultSchemaFor(registryForProject(handle.db, null), "review")?.toJsonSchema());
    const verdict = { type: "object", properties: { result: { type: "string", enum: ["passed", "failed"] } }, required: ["result"] };
    const qa = agent("qa", { schemasByAction: { review: verdict, implement: SORT } });

    const report = migrateCarriedSchemas(handle.db);

    expect(report.defined).toEqual([{ role: "qa", action: "review" }, { role: "qa", action: "implement" }]);
    expect(report.packs).toEqual([]);
    expect(getActionDefinition(handle.db, "qa", "review")?.results.map((result) => result.key)).toEqual(["passed", "failed"]);
    expect(getActionDefinition(handle.db, "qa", "implement")?.results.map((result) => result.key)).toEqual(["done"]);
    expect(getAgent(handle.db, qa.id)?.config).toEqual({});

    const registry = registryForProject(handle.db, null);
    expect(resultSchemaFor(registry, "review", undefined, "qa")?.parse({ result: "passed", summary: "Fine." }).ok).toBe(true);
    // The pack's shape for the shipped reviewer, for a custom role that
    // defines nothing, and for a caller with no role in hand.
    for (const role of ["reviewer", "auditor", undefined]) {
      expect(JSON.stringify(resultSchemaFor(registry, "review", undefined, role)?.toJsonSchema())).toEqual(shipped);
    }
  });

  /**
   * The one pair left out: an installed pack's own role restating its
   * own shipped action, which is what the shipped pipeline's export
   * carries. The pack already holds that role to that shape; a
   * definition generated from it would replace the verdict with `done`.
   */
  it("makes no definition of a pack role's own shipped action", () => {
    const shipped = JSON.stringify(resultSchemaFor(registryForProject(handle.db, null), "review")?.toJsonSchema());
    const second = agent("reviewer", { schemasByAction: { review: SORT, triage: TRIAGE } });

    const report = migrateCarriedSchemas(handle.db);

    expect(report.packs).toEqual([{ role: "reviewer", action: "review" }]);
    expect(report.defined).toEqual([{ role: "reviewer", action: "triage" }]);
    expect(getActionDefinition(handle.db, "reviewer", "review")).toBeUndefined();
    expect(JSON.stringify(resultSchemaFor(registryForProject(handle.db, null), "review", undefined, "reviewer")?.toJsonSchema())).toEqual(shipped);
    expect(getAgent(handle.db, second.id)?.config).toEqual({});
  });

  it("leaves a schema the save refuses in the config, reports why, and converts the rest", () => {
    const unnameable = { type: "object", properties: { result: { type: "string", enum: ["Needs Work"] } } };
    const triager = agent("triager", { schemasByAction: { triage: TRIAGE, grade: unnameable } });

    const report = migrateCarriedSchemas(handle.db);

    expect(report.defined).toEqual([{ role: "triager", action: "triage" }]);
    expect(report.refused).toEqual([{ role: "triager", action: "grade", problems: [expect.stringContaining('"Needs Work"')] }]);
    expect(getAgent(handle.db, triager.id)?.config).toEqual({ schemasByAction: { grade: unnameable } });
    expect(getActionDefinition(handle.db, "triager", "grade")).toBeUndefined();
  });

  it("leaves an archived agent exactly as it is", () => {
    const retired = agent("triager", { schemasByAction: { triage: TRIAGE } });
    archiveAgent(handle.db, retired.id);

    migrateCarriedSchemas(handle.db);

    expect(listActionDefinitions(handle.db)).toEqual([]);
    expect(getAgent(handle.db, retired.id)?.config).toEqual({ schemasByAction: { triage: TRIAGE } });
  });

  it("drops a key that is not a map of schemas at all", () => {
    const odd = agent("triager", { schemasByAction: "review" });

    migrateCarriedSchemas(handle.db);

    expect(getAgent(handle.db, odd.id)?.config).toEqual({});
    expect(listActionDefinitions(handle.db)).toEqual([]);
  });
});

describe("adopting a role's carried schemas", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("keeps a definition the installation already has", () => {
    saveActionDefinition(handle.db, { role: "triager", action: "triage", results: [{ key: "mine" }] });

    expect(adoptCarriedSchemas(handle.db, "triager", { triage: TRIAGE }).kept).toEqual([{ role: "triager", action: "triage" }]);
    expect(getActionDefinition(handle.db, "triager", "triage")?.results.map((result) => result.key)).toEqual(["mine"]);
  });

  it("says before anything is written which schema could not be a definition", () => {
    expect(carriedSchemaRefusal("triager", { triage: TRIAGE })).toBeNull();
    expect(carriedSchemaRefusal("triager", { grade: { type: "object", properties: { result: { enum: ["Needs Work"] } } } })).toContain('The triager role\'s "grade" action cannot be defined');
    // A custom role's version of a pack's action name is a definition like any other, and held to the same rules.
    expect(carriedSchemaRefusal("triager", { review: { type: "object", properties: { result: { enum: ["Needs Work"] } } } })).toContain('The triager role\'s "review" action cannot be defined');
    // A pack role's own shipped action is not written at all, so there is nothing for this check to refuse.
    expect(carriedSchemaRefusal("reviewer", { review: { type: "object", properties: { result: { enum: ["Needs Work"] } } } })).toBeNull();
  });
});
