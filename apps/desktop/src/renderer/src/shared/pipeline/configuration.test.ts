import { buildRegistry, coreBuiltins, developerRegistry, fromRegistryView, toRegistryView } from "@eo/core";
import type { ModuleView, PipelineStepView, StepRouteView } from "@eo/core";
import { describe, expect, it } from "vitest";
import { declaredResults, engineResultOffers, fillResults, keptInputs } from "./configuration";

/**
 * The pipeline editor's pure rules, held without a screen: what a step
 * keeps when what it runs changes, and which results an agent step
 * declares. Moved here from the classic configuration screen's suite
 * (EO-529), which is gone with that layout.
 */


/**
 * What `registry:get` answers with (KAN-124): the registry as EO ships
 * it, which is where the editor learns what a builtin step can return.
 */
const registryView = toRegistryView(installedRegistry());

/**
 * The registry an installation with the developer pack has: the core's
 * own functions, then the pack's (EO-507) — the order `foldPacks` claims
 * them in, so `wait_until` is one of the functions the picker offers.
 */
function installedRegistry() {
  const developer = developerRegistry();
  return buildRegistry({ ...developer, builtins: new Map([...coreBuiltins(), ...developer.builtins]) });
}

const installed = fromRegistryView(registryView);

/**
 * A module with something to configure (EO-78).
 *
 * Three inputs, one of each declared type, because the control a person
 * gets differs per type — and a boolean has three states rather than two,
 * "whatever the module decides" being one of them.
 */
const MERGE_MODULE = {
  id: "019fb8c6-0000-7000-8000-0000000000bb",
  slug: "merge",
  name: "Merge",
  description: "Waits for CI and merges.",
  approvedAt: 1,
  manifest: {
    name: "Merge",
    description: "Waits for CI and merges.",
    inputs: {
      wait_seconds: { type: "number", description: "How long to wait for CI before giving up.", default: 900 },
      environment: { type: "string", description: "Which environment to check.", default: "staging" },
      force: { type: "boolean", description: "Merge even with checks pending.", default: false },
    },
    needs: { bin: [], env: [], network: true, item: false, comment: false, attach: false, create: false },
    results: ["merged"],
  },
};

const DEPLOY_MODULE = {
  id: "019fb8c6-0000-7000-8000-0000000000aa",
  slug: "deploy",
  name: "Deploy",
  description: "Deploys the branch.",
  approvedAt: 1,
  manifest: {
    name: "Deploy",
    description: "Deploys.",
    inputs: {},
    needs: { bin: [], env: ["FLY_API_TOKEN"], network: true, item: false, comment: false, attach: false, create: false },
    // Two, and in this order: the editor fills a row per result and draws
    // them the way the manifest lists them (EO-77).
    results: ["deployed", "rolled_back"],
  },
};

/**
 * What a step keeps when what it runs changes (EO-78).
 *
 * Used in two places that cannot both be reached through the screen in a
 * test: picking another module from the select, and applying an
 * architect's draft — which carries no inputs at all, because the
 * architect is not asked for them, and so must leave each step's own
 * alone rather than send `{}` and wipe them.
 */
describe("keptInputs", () => {
  // The fixtures are what the channel answers with, which is the part
  // that matters here — a catalog entry's timestamps are not.
  const catalog = [MERGE_MODULE, DEPLOY_MODULE] as unknown as ModuleView[];

  const module = (entryAction: string | null) => ({ type: "module" as const, entryAction });
  const builtin = (entryAction: string | null) => ({ type: "builtin" as const, entryAction });

  it("keeps what the module it now runs declares", () => {
    expect(keptInputs(installed, module(MERGE_MODULE.id), { wait_seconds: 90 }, catalog)).toEqual({ wait_seconds: 90 });
  });

  it("drops what it does not", () => {
    expect(keptInputs(installed, module(DEPLOY_MODULE.id), { wait_seconds: 90 }, catalog)).toEqual({});
  });

  // EO-507: a builtin declares its inputs in the registry, and the same
  // rule holds — what the function declares stays, and only that.
  it("keeps what the builtin it runs declares, and drops only what it does not", () => {
    expect(keptInputs(installed, builtin("wait_until"), { at: "2026-11-01T09:00+01:00", stale: 1 }, catalog)).toEqual({ at: "2026-11-01T09:00+01:00" });
    expect(keptInputs(installed, builtin("watch_pull_request"), { reportReady: true }, catalog)).toEqual({ reportReady: true });
    expect(keptInputs(installed, builtin("watch_pull_request"), { at: "2026-11-01T09:00+01:00" }, catalog)).toEqual({});
    // A function that declares none keeps none.
    expect(keptInputs(installed, builtin("open_pull_request"), { reportReady: true }, catalog)).toEqual({});
  });

  // An agent's action, a function nothing declares, or nothing at all:
  // none of them declares an input, so none of them keeps a value.
  it("keeps none for a step whose action declares no inputs", () => {
    expect(keptInputs(installed, { type: "agent", entryAction: "implement" }, { wait_seconds: 90 }, catalog)).toEqual({});
    expect(keptInputs(installed, builtin("no_such_function"), { at: "x" }, catalog)).toEqual({});
    expect(keptInputs(installed, module(null), { wait_seconds: 90 }, catalog)).toEqual({});
    // A module id on a builtin step is not that module's anything.
    expect(keptInputs(installed, builtin(MERGE_MODULE.id), { wait_seconds: 90 }, catalog)).toEqual({});
  });
});


/**
 * What an agent step declares, read off its action (EO-428): the same
 * lookup the validator holds the step to, so the rows the editor fills
 * in are the rows Publish asks for.
 */
describe("an agent step's declared results", () => {
  const facts = fromRegistryView({
    ...toRegistryView(developerRegistry()),
    roleActions: [
      {
        role: "qa",
        actions: [
          { action: "alignment", description: "", results: [{ key: "aligned", label: "Aligned with the spec" }, { key: "gaps_found", label: "" }], packShipped: false, fields: {} },
          { action: "review", description: "", results: [{ key: "passed", label: "Passed" }], packShipped: false, fields: {} },
        ],
      },
    ],
  });
  const step = (ownerRole: string | null, entryAction: string | null): PipelineStepView => ({
    id: "s",
    pipelineId: "default",
    position: 0,
    name: "Step",
    type: "agent",
    ownerRole,
    entryAction,
    instructionsSummary: null,
    isTerminal: false,
    planMode: false,
    workspaceMode: "isolated",
    workspaceId: null,
    inputs: {},
    timeoutMs: null,
    watch: null,
    results: [],
    moduleVersion: null,
  });
  const route = (resultKey: string, position: number, fromStepId = "s"): StepRouteView => ({ id: `${fromStepId}:${resultKey}`, pipelineId: "default", fromStepId, resultKey, label: "Mine", tone: "danger", target: "elsewhere", position });

  it("answers the role's own definition, then the pack's, and null only where nothing defines the action", () => {
    expect(declaredResults(facts, step("qa", "alignment"), [])).toEqual(["aligned", "gaps_found"]);
    // Role plus action wins, for that role alone.
    expect(declaredResults(facts, step("qa", "review"), [])).toEqual(["passed"]);
    expect(declaredResults(facts, step("reviewer", "review"), [])).toEqual(["approved", "changes_requested", "needs_user_input"]);
    // A role that defined nothing falls back to the pack's.
    expect(declaredResults(facts, step("qa", "implement"), [])).toEqual(["done"]);
    expect(declaredResults(facts, step(null, "implement"), [])).toEqual(["done"]);

    expect(declaredResults(facts, step("reviewer", "alignment"), [])).toBeNull();
    expect(declaredResults(facts, step("qa", "legacy_check"), [])).toBeNull();
    expect(declaredResults(facts, step("qa", null), [])).toBeNull();
  });

  it("fills a row per key with the definition's label, keeps the engine's rows and reports the rest as dropped", () => {
    const routes = [route("aligned", 0), route("done", 1), route("escalation", 2), route("verification_failed", 3), route("done", 0, "other")];
    const filled = fillResults(facts, step("qa", "alignment"), routes, ["aligned", "gaps_found"], "next");
    const mine = filled.routes.filter((each) => each.fromStepId === "s").sort((a, b) => a.position - b.position);

    expect(mine.map((each) => [each.resultKey, each.position])).toEqual([["aligned", 0], ["gaps_found", 1], ["escalation", 2], ["verification_failed", 3]]);
    // What was there keeps its wiring; what is new takes the definition's label, or the key's where it has none.
    expect(mine[0]).toMatchObject({ id: "s:aligned", label: "Mine", target: "elsewhere" });
    expect(mine[1]).toMatchObject({ label: "Gaps found", target: "next", tone: "info" });
    expect(mine[2]).toMatchObject({ id: "s:escalation", target: "elsewhere" });
    expect(filled.dropped.map((each) => each.resultKey)).toEqual(["done"]);
    expect(filled.routes.filter((each) => each.fromStepId === "other")).toHaveLength(1);
    expect(fillResults(facts, step("qa", "alignment"), [], ["aligned"], "next").routes[0]?.label).toBe("Aligned with the spec");
  });

  it("still drops everything undeclared from a builtin's rows", () => {
    const builtin = { ...step(null, "open_pull_request"), type: "builtin" as const };
    expect(fillResults(facts, builtin, [route("escalation", 0)], ["opened"], "next").dropped.map((each) => each.resultKey)).toEqual(["escalation"]);
  });

  it("offers the engine's results an agent step with fixed keys does not route yet, and nothing where the keys are free", () => {
    const qa = step("qa", "alignment");
    expect(engineResultOffers(qa, ["aligned", "gaps_found"], [])).toEqual(["needs_user_input", "escalation"]);
    expect(engineResultOffers(qa, ["aligned", "gaps_found"], [route("escalation", 0)])).toEqual(["needs_user_input"]);
    // Declared by the action, so it is a row already.
    expect(engineResultOffers(step("reviewer", "review"), ["approved", "changes_requested", "needs_user_input"], [])).toEqual(["escalation"]);
    expect(engineResultOffers(step("qa", "legacy_check"), null, [])).toEqual([]);
    expect(engineResultOffers({ ...step(null, "open_pull_request"), type: "builtin" }, ["opened"], [])).toEqual([]);
  });
});
