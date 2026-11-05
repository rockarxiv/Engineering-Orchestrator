import { CLARIFY_ACTION, INTERPRET_ACTION, UNDISPATCHED_ACTIONS } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registry } from "../../registry.js";
import { ASSIST_ACTION, SCENARIO_ACTION } from "../../roles/conversationSteps.js";
import { RESPOND_ACTION } from "../../supervisor/manualDispatch.js";
import type { DbHandle } from "../client.js";
import { actionDefinitions } from "../schema.js";
import { openMigratedTestDb } from "../testHelpers.js";
import { getActionDefinition, listActionDefinitions, listActionDefinitionsForRole, saveActionDefinition } from "./actionDefinitionsRepo.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ALIGNMENT = {
  role: "qa",
  action: "alignment",
  description: "Check the work against what was asked for.",
  results: [
    { key: "aligned", label: "Aligned", meaning: "Everything asked for is there." },
    { key: "gaps_found", label: "Gaps found", meaning: "Something asked for is missing." },
  ],
  fields: { type: "object", properties: { gaps: { type: "array", items: { type: "string" } } } },
};

/** The one write to `action_definitions` (EO-421): what it stores, and what it refuses to. */
describe("saving an action definition", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  const rows = (): number => handle.db.select().from(actionDefinitions).all().length;

  it("stores a definition under a UUIDv7, keyed by role and action", () => {
    const saved = saveActionDefinition(handle.db, ALIGNMENT, 1_000);

    expect(saved.ok).toBe(true);
    const stored = getActionDefinition(handle.db, "qa", "alignment");
    expect(stored).toMatchObject({ ...ALIGNMENT, createdAt: 1_000, updatedAt: 1_000 });
    expect(stored?.id).toMatch(UUID_V7);
    expect(getActionDefinition(handle.db, "editor", "alignment")).toBeUndefined();
  });

  it("replaces the role's definition of that action rather than adding a second", () => {
    const first = saveActionDefinition(handle.db, ALIGNMENT, 1_000);
    const second = saveActionDefinition(handle.db, { ...ALIGNMENT, results: [{ key: "ok" }] }, 2_000);

    expect(rows()).toBe(1);
    expect(second.ok && first.ok && second.definition.id).toBe(first.ok && first.definition.id);
    expect(getActionDefinition(handle.db, "qa", "alignment")).toMatchObject({ results: [{ key: "ok", label: "Ok", meaning: "" }], createdAt: 1_000, updatedAt: 2_000 });
  });

  it("keeps two roles' definitions of one action name apart", () => {
    saveActionDefinition(handle.db, ALIGNMENT);
    saveActionDefinition(handle.db, { role: "editor", action: "alignment", results: [{ key: "on_brief" }] });

    expect(listActionDefinitions(handle.db).map((definition) => `${definition.role}/${definition.action}`)).toEqual(["editor/alignment", "qa/alignment"]);
    expect(listActionDefinitionsForRole(handle.db, "editor").map((definition) => definition.results[0]?.key)).toEqual(["on_brief"]);
  });

  it.each([
    ["duplicate result keys", { results: [{ key: "aligned" }, { key: "aligned" }] }, "more than once"],
    ["no results", { results: [] }, "at least one result"],
    ["a field named result", { fields: { properties: { result: { type: "string" } } } }, 'may not be named "result"'],
    ["a field named summary", { fields: { properties: { summary: { type: "string" } } } }, 'may not be named "summary"'],
    ["fields that do not compile", { fields: { properties: { gaps: { type: "aray" } } } }, "not a JSON Schema EO can read"],
    ["an action key with a capital in it", { action: "Alignment" }, '"Alignment"'],
    ["a result key with a space in it", { results: [{ key: "gaps found" }] }, '"gaps found"'],
  ])("refuses %s with the reason, and writes nothing", (_what, change, reason) => {
    const saved = saveActionDefinition(handle.db, { ...ALIGNMENT, ...change });

    expect(saved.ok).toBe(false);
    expect(!saved.ok && saved.problems.join("\n")).toContain(reason);
    expect(rows()).toBe(0);
  });

  it("leaves the definition that was there when a replacement is refused", () => {
    saveActionDefinition(handle.db, ALIGNMENT, 1_000);

    expect(saveActionDefinition(handle.db, { ...ALIGNMENT, results: [] }, 2_000).ok).toBe(false);
    expect(getActionDefinition(handle.db, "qa", "alignment")).toMatchObject({ results: ALIGNMENT.results, updatedAt: 1_000 });
  });
});

/**
 * The two refusals that are about *which* action (EO-422), at the one
 * write — so the agent screen, an import and the system agent's tool
 * are all refused by the same sentence.
 */
describe("what may not be defined at all", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  const RESULTS = [{ key: "done" }];

  it.each(["respond", "interpret", "assist", "scenario", "clarify"])(
    "refuses %s, which no pipeline step dispatches, naming it and writing nothing",
    (action) => {
      const saved = saveActionDefinition(handle.db, { role: "qa", action, results: RESULTS });

      expect(saved.ok).toBe(false);
      expect(saved.ok ? [] : saved.problems.join(" ")).toContain(`"${action}"`);
      expect(handle.db.select().from(actionDefinitions).all()).toEqual([]);
    },
  );

  it.each([
    ["reviewer", "review"],
    ["implementer", "implement"],
    ["system", "refine"],
    ["system", "intake"],
  ])("refuses the %s role's own shipped %s, naming both and writing nothing", (role, action) => {
    const saved = saveActionDefinition(handle.db, { role, action, results: RESULTS });

    expect(saved.ok).toBe(false);
    const said = saved.ok ? "" : saved.problems.join(" ");
    expect(said).toContain(role);
    expect(said).toContain(`"${action}"`);
    expect(handle.db.select().from(actionDefinitions).all()).toEqual([]);
  });

  it("refuses every action the system role ships", () => {
    const shipped = [...(registry.roles.get("system")?.schemasByAction.keys() ?? [])];
    expect(shipped.length).toBeGreaterThan(0);

    for (const action of shipped) {
      const saved = saveActionDefinition(handle.db, { role: "system", action, results: RESULTS });
      expect(saved.ok, action).toBe(false);
      expect(saved.ok ? "" : saved.problems.join(" "), action).toContain(`"${action}"`);
    }
    expect(handle.db.select().from(actionDefinitions).all()).toEqual([]);
  });

  // Role plus action is the key (the pinned decision): only the role
  // that ships an action is barred from it.
  it("still lets a custom role define a pack's action name, and a shipped role one it does not ship", () => {
    expect(saveActionDefinition(handle.db, { role: "qa", action: "review", results: [{ key: "passed" }, { key: "failed" }] }).ok).toBe(true);
    expect(saveActionDefinition(handle.db, { role: "qa", action: "implement", results: RESULTS }).ok).toBe(true);
    expect(saveActionDefinition(handle.db, { role: "implementer", action: "review", results: RESULTS }).ok).toBe(true);
  });

  it("spells the undispatched actions the way the code that runs them does", () => {
    expect([...UNDISPATCHED_ACTIONS].sort()).toEqual(
      [RESPOND_ACTION, INTERPRET_ACTION, ASSIST_ACTION, SCENARIO_ACTION, CLARIFY_ACTION].sort(),
    );
  });
});
