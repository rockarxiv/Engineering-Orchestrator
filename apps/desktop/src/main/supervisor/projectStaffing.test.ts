import { isDispatchable, type Agent, type Item, type Uuid } from "@eo/core";
import { dispatchBlocker, tick } from "@eo/engine";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { archiveAgent, createAgent, listAgents } from "../db/repos/agentsRepo.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { pipelines } from "../db/schema.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { validatePipelineCommand } from "../ipc/configCommands.js";
import { listPipelineStepViews } from "../ipc/domainQueries.js";
import { buildEligibilityInput, buildTickInput } from "./buildTickInput.js";
import { rerunContract } from "./manualDispatch.js";

/**
 * Project-scoped agents, asked of every door that decides who staffs a
 * step (EO-474).
 *
 * One table, and every row is put to all four: the scheduler's pick, its
 * "no enabled agent" blocker, the dispatch preflight (`rerunContract`,
 * which a rerun is admitted through and asked again before the run
 * starts) and `validatePipeline`'s warning, through the real command and
 * the real tick input. They share `staffingAgents`; this is what proves
 * they still do, so a fifth reader that re-derives the rule — or one of
 * these four drifting off it — fails here rather than parking work in
 * silence.
 *
 * Each row's pipeline belongs to the item's project, which is the
 * question the validator asks: who staffs this pipeline's work.
 */

type Scope = "P" | "Q" | null;

interface Row {
  name: string;
  /** The project the item is on — and the pipeline with it. */
  item: Scope;
  agents: { name: string; scope: Scope; enabled?: boolean }[];
  /** Who may be dispatched for the item, in order. Empty is "nobody". */
  staffedBy: string[];
}

const TABLE: Row[] = [
  { name: "a global implementer staffs a project's item", item: "P", agents: [{ name: "Global", scope: null }], staffedBy: ["Global"] },
  {
    name: "the project's own implementer outranks the global one",
    item: "P",
    agents: [
      { name: "Global", scope: null },
      { name: "P's own", scope: "P" },
    ],
    staffedBy: ["P's own"],
  },
  { name: "a project's own implementer alone staffs its item", item: "P", agents: [{ name: "P's own", scope: "P" }], staffedBy: ["P's own"] },
  {
    name: "another project's item keeps the global implementer",
    item: "Q",
    agents: [
      { name: "Global", scope: null },
      { name: "P's own", scope: "P" },
    ],
    staffedBy: ["Global"],
  },
  { name: "another project's implementer never staffs this item", item: "Q", agents: [{ name: "P's own", scope: "P" }], staffedBy: [] },
  {
    name: "an item on no project is staffed by global agents only",
    item: null,
    agents: [
      { name: "Global", scope: null },
      { name: "P's own", scope: "P" },
    ],
    staffedBy: ["Global"],
  },
  { name: "a project's implementer never staffs an item on no project", item: null, agents: [{ name: "P's own", scope: "P" }], staffedBy: [] },
  {
    name: "a switched-off project implementer outranks nobody",
    item: "P",
    agents: [
      { name: "Global", scope: null },
      { name: "P's own", scope: "P", enabled: false },
    ],
    staffedBy: ["Global"],
  },
  {
    name: "two of the project's own share the work and the global one still gets none",
    item: "P",
    agents: [
      { name: "Global", scope: null },
      { name: "P's first", scope: "P" },
      { name: "P's second", scope: "P" },
    ],
    staffedBy: ["P's first", "P's second"],
  },
];

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 5 };

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
  // The seeded implementer is global and would answer every row; each
  // row brings exactly the agents it is about.
  for (const agent of listAgents(handle.db).filter((candidate) => candidate.role === "implementer")) archiveAgent(handle.db, agent.id);
});

afterEach(() => {
  handle.close();
});

function arrange(row: Row): { item: Item; agents: Agent[] } {
  const db = handle.db;
  const projectIds: Record<"P" | "Q", Uuid> = {
    P: createProject(db, { name: "Support", keyPrefix: "SUP" }).id,
    Q: createProject(db, { name: "Shop", keyPrefix: "SHOP" }).id,
  };
  const projectOf = (scope: Scope): Uuid | null => (scope === null ? null : projectIds[scope]);
  db.update(pipelines).set({ projectId: projectOf(row.item) }).where(eq(pipelines.id, "default")).run();
  const agents = row.agents.map((spec) =>
    createAgent(db, { name: spec.name, role: "implementer", provider: "fake", instructions: "Implement.", enabled: spec.enabled ?? true, projectId: projectOf(spec.scope) }),
  );
  const item = createTestItem(db, { type: "story", title: "Something to do", stepId: "todo", projectId: projectOf(row.item) });
  return { item, agents };
}

/** Whether the validator warns that the item's step has nobody — on the pipeline the item is on. */
function validatorSaysUnstaffed(): boolean {
  const graph = listPipelineStepViews(handle.db, { pipelineId: "default" });
  const problems = validatePipelineCommand(handle.db, { pipelineId: "default", steps: graph.steps, routes: graph.routes, entryStepId: graph.entryStepId }).problems;
  return problems.some((problem) => problem.stateId === "todo" && problem.message.includes("which has no enabled agent"));
}

describe("project-scoped agents — scheduler, blocker, preflight and validator agree (EO-474)", () => {
  it.each(TABLE)("$name", (row) => {
    const { item, agents } = arrange(row);
    const staffed = row.staffedBy.length > 0;

    // The scheduler: who it picks, when it picks anybody — the first
    // candidate, since every agent here has room.
    const dispatched = tick(buildTickInput(handle.db, LIMITS, false)).filter((dispatch) => dispatch.item.id === item.id);
    expect(dispatched.map((dispatch) => dispatch.agent?.name ?? null)).toEqual(staffed ? [row.staffedBy[0]] : []);

    // Its "no enabled agent" blocker: said exactly when nobody is picked.
    const blocker = dispatchBlocker(buildEligibilityInput(handle.db, false), item.id);
    expect(blocker).toEqual(staffed ? null : { kind: "no_enabled_agent", role: "implementer" });

    // The dispatch preflight: a rerun naming an agent is admitted for
    // exactly the agents the scheduler could have picked. A switched-off
    // agent is refused one layer up, as switched off, so it is left out.
    const admitted = agents.filter((agent) => isDispatchable(agent) && rerunContract(handle.db, item.id, agent.id, "todo") !== null).map((agent) => agent.name);
    expect(admitted).toEqual(row.staffedBy);

    // The validator, on the pipeline the item is on.
    expect(validatorSaysUnstaffed()).toBe(!staffed);
  });
});

/**
 * A pipeline no project has adopted belongs to whichever project is
 * asking, and the scheduler staffs each item on it by the item's own
 * project — so the validator asks it of those projects too (EO-514).
 */
describe("an unadopted pipeline is staffed by the projects whose work it carries (EO-514)", () => {
  function arrangeShop(): { shop: Uuid; agent: Agent } {
    const db = handle.db;
    db.update(pipelines).set({ projectId: null }).where(eq(pipelines.id, "default")).run();
    const shop = createProject(db, { name: "Shop", keyPrefix: "SHOP" }).id;
    const agent = createAgent(db, { name: "Shop's own", role: "implementer", provider: "fake", instructions: "Implement.", projectId: shop });
    return { shop, agent };
  }

  it("does not warn that the role is unstaffed when only SHOP has an implementer and SHOP's work is on it", () => {
    const { shop } = arrangeShop();
    const item = createTestItem(handle.db, { type: "story", title: "Something to do", stepId: "todo", projectId: shop });

    const dispatched = tick(buildTickInput(handle.db, LIMITS, false)).filter((dispatch) => dispatch.item.id === item.id);
    expect(dispatched.map((dispatch) => dispatch.agent?.name ?? null)).toEqual(["Shop's own"]);
    expect(validatorSaysUnstaffed()).toBe(false);
  });

  it("does not warn before any work is on it, since SHOP could bring some", () => {
    arrangeShop();
    expect(validatorSaysUnstaffed()).toBe(false);
  });

  it("still warns when the only work on it is a project the implementer is not part of", () => {
    arrangeShop();
    const support = createProject(handle.db, { name: "Support", keyPrefix: "SUP" }).id;
    const item = createTestItem(handle.db, { type: "story", title: "Something to do", stepId: "todo", projectId: support });

    expect(tick(buildTickInput(handle.db, LIMITS, false)).filter((dispatch) => dispatch.item.id === item.id)).toEqual([]);
    expect(validatorSaysUnstaffed()).toBe(true);
  });

  it("still warns when no project has an implementer at all", () => {
    handle.db.update(pipelines).set({ projectId: null }).where(eq(pipelines.id, "default")).run();
    createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    expect(validatorSaysUnstaffed()).toBe(true);
  });
});
