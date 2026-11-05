import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Item, ModuleManifest, Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { archiveModule, createRun, createStep, listAgents, saveModule } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { runView } from "../ipc/domainQueries.js";
import { runActionName, runSubject } from "./runName.js";

/**
 * A module run's action is the module's id (KAN-105), and a person is
 * shown its name instead (EO-619). `runView` is what the screens read, so
 * a run from before this works the same as a new one.
 */

const GONE = "019a0000-0000-7000-8000-000000000001";

const manifest: ModuleManifest = {
  name: "Deploy",
  description: "Deploys the branch.",
  inputs: {},
  needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
  results: ["deployed"],
};

let handle: DbHandle;
let item: Item;
let moduleId: string;

/** A module-shaped run: no agent, and `provider` as whichever writer left it. */
function moduleRun(action: string, extra: { stepId?: string | null; provider?: string } = { provider: "module" }) {
  return createRun(handle.db, { itemId: item.id, agentId: null, action, status: "succeeded", ...extra });
}

beforeEach(() => {
  handle = openMigratedTestDb();
  const saved = saveModule(handle.db, { slug: "deploy", name: "Staging deploy", description: manifest.description, code: "export default async function run() {}", manifest, approve: true });
  if (!saved.ok) throw new Error(saved.reason);
  moduleId = saved.module.id;
  createStep(handle.db, { id: "lost", pipelineId: "default" as Uuid, position: 15, name: "Lost step", type: "module", entryAction: GONE });
  item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });
});

afterEach(() => {
  handle.close();
});

describe("the name a screen shows for a run", () => {
  it("is the module's, beside an action that still holds its id", () => {
    const view = runView(handle.db, moduleRun(moduleId), "EO");

    expect(view.actionName).toBe("Staging deploy");
    expect(view.action).toBe(moduleId);
  });

  it("is the module's on a row with no provider, as a refusal's placeholder and an old run have", () => {
    expect(runActionName(handle.db, moduleRun(moduleId, {}))).toBe("Staging deploy");
  });

  it("is still the module's once the module is archived", () => {
    const run = moduleRun(moduleId);
    archiveModule(handle.db, moduleId);

    expect(runActionName(handle.db, run)).toBe("Staging deploy");
  });

  it("is the step's when the module is gone", () => {
    expect(runActionName(handle.db, moduleRun(GONE, { stepId: "lost", provider: "module" }))).toBe("Lost step");
  });

  it("is the step naming the module when the run names no step", () => {
    expect(runActionName(handle.db, moduleRun(GONE, { stepId: null, provider: "module" }))).toBe("Lost step");
    expect(runActionName(handle.db, moduleRun(GONE, { stepId: null }))).toBe("Lost step");
  });

  it("is a plain word when the step is gone too, and never the id", () => {
    const other = "019a0000-0000-7000-8000-000000000002";

    expect(runActionName(handle.db, moduleRun(other, { stepId: "nowhere", provider: "module" }))).toBe("a module");
    expect(runActionName(handle.db, moduleRun(other, { stepId: null }))).toBe("a module");
  });

  it("is the action itself on a builtin run", () => {
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "watch_pull_request", status: "succeeded", provider: "builtin" });
    const placeholder = createRun(handle.db, { itemId: item.id, agentId: null, action: "open_pull_request", status: "awaiting_input" });

    expect(runActionName(handle.db, run)).toBe("watch_pull_request");
    expect(runActionName(handle.db, placeholder)).toBe("open_pull_request");
  });

  it("is the action itself on an agent run", () => {
    const agentId = listAgents(handle.db).find((agent) => agent.role === "implementer")!.id;
    const run = createRun(handle.db, { itemId: item.id, agentId, action: "implement", status: "succeeded", provider: "claude" });

    expect(runActionName(handle.db, run)).toBe("implement");
    expect(runView(handle.db, run, "Implementer")).toMatchObject({ action: "implement", actionName: "implement" });
  });
});

describe("a run as the subject of a sentence", () => {
  it("quotes the module's name", () => {
    expect(runSubject(handle.db, moduleRun(moduleId))).toBe(`"Staging deploy"`);
  });

  it("says which step when the module is gone, and leaves the id out", () => {
    expect(runSubject(handle.db, moduleRun(GONE, { stepId: "lost", provider: "module" }))).toBe(`The module on "Lost step"`);
  });

  it("falls back to a plain word when the step is gone too", () => {
    expect(runSubject(handle.db, moduleRun("019a0000-0000-7000-8000-000000000002", { stepId: null, provider: "module" }))).toBe("A module");
  });

  it("quotes a builtin's action as it always did", () => {
    expect(runSubject(handle.db, createRun(handle.db, { itemId: item.id, agentId: null, action: "open_pull_request", status: "failed", provider: "builtin" }))).toBe(`"open_pull_request"`);
  });
});
