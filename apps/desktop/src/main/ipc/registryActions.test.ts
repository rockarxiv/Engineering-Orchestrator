import { rmSync } from "node:fs";
import { fromRegistryView, RegistryViewSchema, type PipelineStepView, type RegistryView, type StepRouteView } from "@eo/core";
import { validatePipeline, type ValidatePipelineInput } from "@eo/engine";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { saveActionDefinition } from "../db/repos/actionDefinitionsRepo.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { registryForProject } from "../registry.js";
import { fakePlatform } from "../testing/platform.js";
import { validatePipelineCommand } from "./configCommands.js";
import { listPipelineStepViews } from "./domainQueries.js";
import { clearHandlerRegistry, dispatchIpc } from "./registry.js";

/**
 * A role's actions on the wire, and the validator that reads them on
 * both sides of it (EO-423).
 *
 * `validatePipeline` holds an agent step's routes to what its action
 * declares, and the declaration has two homes: a pack ships some, and a
 * role defines the rest in a table. Schemas stay in the main process, so
 * what the renderer's validator is told is whatever `registry:get`
 * carried — and the two sides agreeing is not something either side's
 * own tests can see. These go through the channel itself.
 */

const directories: string[] = [];
let handle: DbHandle;

beforeEach(async () => {
  handle = openMigratedTestDb();
  const platform = fakePlatform();
  directories.push(platform.userDataPath);
  const { registerAllHandlers } = await import("./handlers.js");
  registerAllHandlers(handle.db, undefined, { platform });
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

/** `registry:get` as a renderer receives it: through the channel, and through JSON, which is the narrowest transport it crosses. */
async function registryOverIpc(): Promise<RegistryView> {
  const answer = await dispatchIpc("registry:get", undefined);
  if (!answer.ok) throw new Error("registry:get refused");
  return RegistryViewSchema.parse(JSON.parse(JSON.stringify(answer.data)));
}

function shipped(): { steps: PipelineStepView[]; routes: StepRouteView[] } {
  const { steps, routes } = listPipelineStepViews(handle.db, { pipelineId: "default" });
  return { steps, routes };
}

describe("a role's actions over registry:get (EO-423)", () => {
  it("carries the pack's actions with their result keys and labels, marked as shipped", async () => {
    const view = await registryOverIpc();
    const actionsOf = (slug: string) => view.roles.find((role) => role.slug === slug)?.actions ?? [];

    expect(actionsOf("implementer")).toEqual([
      {
        action: "implement",
        description: expect.any(String),
        results: [{ key: "done", label: "Done" }],
        packShipped: true,
        // The shipped pipeline's own step, by name (EO-425).
        usedBy: [{ pipelineId: "default", pipelineName: "Delivery", stepId: "todo", stepName: "To Do" }],
      },
    ]);
    expect(actionsOf("reviewer").map((action) => [action.action, action.results.map((result) => result.key), action.packShipped])).toEqual([
      ["review", ["approved", "changes_requested", "needs_user_input"], true],
    ]);
    expect(Object.fromEntries(actionsOf("system").map((action) => [action.action, action.results.map((result) => result.key)]))).toEqual({
      refine: ["decomposed", "clarified"],
      intake: ["done", "classified_non_feature"],
    });
    // Nothing EO runs for itself: no step dispatches those, so there is
    // nothing for a route to be held to.
    expect(actionsOf("system").map((action) => action.action)).not.toContain("respond");
    expect(view.roleActions).toEqual([]);
  });

  it("reflects a definition saved while the app is running, with no restart", async () => {
    expect((await registryOverIpc()).roleActions).toEqual([]);

    const saved = saveActionDefinition(handle.db, {
      role: "qa",
      action: "alignment",
      description: "Checks the work against the brief.",
      results: [{ key: "aligned", label: "Aligned" }, { key: "gaps_found" }],
    });
    expect(saved.ok).toBe(true);

    // The same handlers, registered before the save.
    expect((await registryOverIpc()).roleActions).toEqual([
      {
        role: "qa",
        actions: [
          {
            action: "alignment",
            description: "Checks the work against the brief.",
            results: [
              { key: "aligned", label: "Aligned", meaning: "" },
              { key: "gaps_found", label: "Gaps found", meaning: "" },
            ],
            packShipped: false,
            // What EO-425 added to the answer: the definition's fields,
            // and the steps that dispatch it — none yet.
            fields: {},
            usedBy: [],
          },
        ],
      },
    ]);
  });
});

describe("the shipped pipeline, held to its actions' declared results (EO-423)", () => {
  it("validates with nothing to say but the two comment results its watch does not route yet (EO-759)", () => {
    const { steps, routes } = shipped();
    // Template 1.3 predates `author_commented` and `others_commented`; a
    // builtin's unrouted result is a warning, never an error.
    expect(validatePipelineCommand(handle.db, { pipelineId: "default", steps, routes, entryStepId: "worktree" }).problems).toEqual([
      expect.objectContaining({ severity: "warning", stateId: "pull_request_watch", resultKey: "author_commented" }),
      expect.objectContaining({ severity: "warning", stateId: "pull_request_watch", resultKey: "others_commented" }),
    ]);
  });

  it("is refused once Review loses the route for one of its verdicts", () => {
    const { steps, routes } = shipped();
    const without = routes.filter((route) => !(route.fromStepId === "review" && route.resultKey === "changes_requested"));

    const problems = validatePipelineCommand(handle.db, { pipelineId: "default", steps, routes: without, entryStepId: "worktree" }).problems;
    expect(problems.filter((problem) => problem.resultKey === "changes_requested")).toEqual([
      expect.objectContaining({ severity: "error", stateId: "review", message: expect.stringContaining("user_attention") }),
    ]);
  });
});

describe("one graph, validated in the renderer and in the main process (EO-423)", () => {
  /**
   * A graph with something to say about each kind of action: a pack's
   * with a key missing, a role's own with a key it does not declare, and
   * one nobody defines.
   */
  function graph(registry: ValidatePipelineInput["registry"]): ValidatePipelineInput {
    const step = (id: string, position: number, overrides: Partial<ValidatePipelineInput["steps"][number]>) =>
      ({
        id,
        pipelineId: "p1",
        position,
        name: id,
        type: "agent",
        ownerRole: null,
        entryAction: null,
        instructionsSummary: null,
        isTerminal: false,
        planMode: false,
        workspaceMode: "isolated",
        workspaceId: null,
        offBoard: false,
        inputs: {},
        timeoutMs: null,
        watch: null,
        ownerPersonId: null,
        ownerGroupId: null,
        results: [],
        ...overrides,
      }) as ValidatePipelineInput["steps"][number];
    const route = (fromStepId: string, resultKey: string, target: string, position = 0) =>
      ({ id: `${fromStepId}:${resultKey}`, pipelineId: "p1", fromStepId, resultKey, label: resultKey, tone: "info", target, position }) as ValidatePipelineInput["routes"][number];

    return {
      steps: [
        step("review", 0, { ownerRole: "reviewer", entryAction: "review" }),
        step("check", 1, { ownerRole: "qa", entryAction: "alignment" }),
        step("muse", 2, { ownerRole: "qa", entryAction: "ponder" }),
        step("end", 3, { type: "user", isTerminal: true }),
      ],
      routes: [
        route("review", "approved", "check"),
        route("review", "changes_requested", "review", 1),
        route("check", "aligned", "muse"),
        route("check", "gaps_found", "review", 1),
        route("check", "shrugged", "end", 2),
        route("muse", "done", "end"),
      ],
      entryStepId: "review",
      staffedRoles: ["reviewer", "qa"],
      itemCountByStep: {},
      existingSteps: [],
      registry,
    };
  }

  it("produces the same problems from the registry the renderer was sent as from the one main holds", async () => {
    saveActionDefinition(handle.db, { role: "qa", action: "alignment", results: [{ key: "aligned" }, { key: "gaps_found" }] });

    const inMain = validatePipeline(graph(registryForProject(handle.db, null)));
    const inRenderer = validatePipeline(graph(fromRegistryView(await registryOverIpc())));

    expect(inRenderer).toEqual(inMain);
    // And they are the three the graph was built to have, so "the same"
    // is not two empty lists agreeing.
    expect(inMain.map((problem) => [problem.severity, problem.stateId, problem.resultKey])).toEqual([
      ["error", "review", "needs_user_input"],
      ["error", "check", "shrugged"],
      ["warning", "muse", undefined],
    ]);
  });
});
