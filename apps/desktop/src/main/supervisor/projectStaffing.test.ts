import { isDispatchable, type Agent, type Item, type Uuid } from "@eo/core";
import { dispatchBlocker, tick } from "@eo/engine";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { archiveAgent, createAgent, listAgents } from "../db/repos/agentsRepo.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { pipelineSteps, pipelines } from "../db/schema.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { validatePipelineCommand } from "../ipc/configCommands.js";
import { listPipelineStepViews } from "../ipc/domainQueries.js";
import { buildEligibilityInput, buildTickInput } from "./buildTickInput.js";
import { rerunContract } from "./manualDispatch.js";

/**
 * The agent a step names, asked of every door that decides who runs it
 * (EO-474, EO-875).
 *
 * One table, and every row is put to all four: the scheduler's pick, its
 * blocker, the dispatch preflight (`rerunContract`, which a rerun is
 * admitted through and asked again before the run starts) and
 * `validatePipeline`, through the real command and the real tick input.
 * A step names one agent, and each door asks about that agent and no
 * other: there is no precedence between a project's own agents and the
 * global ones any more, so an agent of the same kind beside it never
 * runs the step, however it is scoped.
 *
 * Each row's pipeline belongs to the item's project, which is what the
 * validator asks a step's agent to fit.
 */

type Scope = "P" | "Q" | null;

interface Row {
  name: string;
  /** The project the item is on — and the pipeline with it. */
  item: Scope;
  agents: { name: string; scope: Scope; enabled?: boolean }[];
  /** The agent the step names, by name. */
  names: string;
  /** Who runs the item: the named agent, or nobody. */
  runs: string | null;
  /** What the validator says about the step: nothing, a warning or an error. */
  validator: "nothing" | "warning" | "error";
}

const TABLE: Row[] = [
  { name: "a global implementer runs a project's item", item: "P", agents: [{ name: "Global", scope: null }], names: "Global", runs: "Global", validator: "nothing" },
  {
    name: "the project's own implementer runs it where the step names it",
    item: "P",
    agents: [
      { name: "Global", scope: null },
      { name: "P's own", scope: "P" },
    ],
    names: "P's own",
    runs: "P's own",
    validator: "nothing",
  },
  {
    name: "the global implementer runs it where the step names it, with the project's own beside it",
    item: "P",
    agents: [
      { name: "Global", scope: null },
      { name: "P's own", scope: "P" },
    ],
    names: "Global",
    runs: "Global",
    validator: "nothing",
  },
  {
    name: "another project's implementer never runs this item, and the validator refuses it",
    item: "Q",
    agents: [
      { name: "Global", scope: null },
      { name: "P's own", scope: "P" },
    ],
    names: "P's own",
    runs: null,
    validator: "error",
  },
  {
    name: "a project's implementer never runs an item on no project, and is refused on a pipeline with none",
    item: null,
    agents: [
      { name: "Global", scope: null },
      { name: "P's own", scope: "P" },
    ],
    names: "P's own",
    runs: null,
    validator: "error",
  },
  {
    name: "a switched-off implementer runs nothing, and the global one beside it is not handed the work",
    item: "P",
    agents: [
      { name: "Global", scope: null },
      { name: "P's own", scope: "P", enabled: false },
    ],
    names: "P's own",
    runs: null,
    validator: "warning",
  },
  {
    name: "of two of the project's own, only the one the step names runs",
    item: "P",
    agents: [
      { name: "Global", scope: null },
      { name: "P's first", scope: "P" },
      { name: "P's second", scope: "P" },
    ],
    names: "P's second",
    runs: "P's second",
    validator: "nothing",
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
  const named = agents.find((agent) => agent.name === row.names)!;
  db.update(pipelineSteps).set({ agentId: named.id }).where(eq(pipelineSteps.id, "todo")).run();
  const item = createTestItem(db, { type: "story", title: "Something to do", stepId: "todo", projectId: projectOf(row.item) });
  return { item, agents };
}

/** The worst the validator says of the item's step — on the pipeline the item is on. */
function validatorSays(): Row["validator"] {
  const graph = listPipelineStepViews(handle.db, { pipelineId: "default" });
  const problems = validatePipelineCommand(handle.db, { pipelineId: "default", steps: graph.steps, routes: graph.routes, entryStepId: graph.entryStepId }).problems.filter(
    (problem) => problem.stateId === "todo",
  );
  if (problems.some((problem) => problem.severity === "error")) return "error";
  return problems.some((problem) => problem.severity === "warning") ? "warning" : "nothing";
}

describe("the agent a step names — scheduler, blocker, preflight and validator agree (EO-474, EO-875)", () => {
  it.each(TABLE)("$name", (row) => {
    const { item, agents } = arrange(row);
    const named = agents.find((agent) => agent.name === row.names)!;

    // The scheduler: the named agent, when it can run the item, and
    // nobody else.
    const dispatched = tick(buildTickInput(handle.db, LIMITS, false)).filter((dispatch) => dispatch.item.id === item.id);
    expect(dispatched.map((dispatch) => dispatch.agent?.name ?? null)).toEqual(row.runs === null ? [] : [row.runs]);

    // Its blocker: said exactly when nobody is picked, and about the
    // agent the step names.
    const blocker = dispatchBlocker(buildEligibilityInput(handle.db, false), item.id);
    expect(blocker).toEqual(row.runs === null ? expect.objectContaining({ kind: "agent_unavailable", agentId: named.id }) : null);

    // The dispatch preflight: a rerun is admitted for the named agent
    // where the scheduler could pick it, and for no other agent of the
    // kind. A switched-off agent is refused one layer up, as switched
    // off, so it is left out.
    const admitted = agents.filter((agent) => isDispatchable(agent) && rerunContract(handle.db, item.id, agent.id, "todo") !== null).map((agent) => agent.name);
    expect(admitted).toEqual(row.runs === null ? [] : [row.runs]);

    // The validator, on the pipeline the item is on.
    expect(validatorSays()).toBe(row.validator);
  });
});
