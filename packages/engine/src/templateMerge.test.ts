import { describe, expect, it } from "vitest";
import { classifyKey, compareThreeWay, describeUpdateKey, mergeThreeWay, sameValue, type ComparableGraph, type KeyChange } from "./templateMerge.js";

/**
 * The three-way comparison (EO-532): the base a pipeline came from, the
 * pipeline as the person has it, and the new template version.
 */

interface Step {
  id: string;
  name: string;
  type: string;
  entryAction: string | null;
  ownerRole: string | null;
  watch: { everyMinutes: number; giveUpAfterHours: number } | null;
  inputs: Record<string, unknown>;
  timeoutMs: number | null;
  results: unknown[];
}

interface Route {
  fromStepId: string;
  resultKey: string;
  target: string;
  label: string;
  tone: string;
  position: number;
}

function step(id: string, overrides: Partial<Step> = {}): Step {
  return { id, name: id, type: "agent", entryAction: "work", ownerRole: "worker", watch: null, inputs: {}, timeoutMs: null, results: [], ...overrides };
}

function route(fromStepId: string, resultKey: string, target: string, overrides: Partial<Route> = {}): Route {
  return { fromStepId, resultKey, target, label: resultKey, tone: "success", position: 0, ...overrides };
}

/** Write → Check → Done, with Check's `approved` going to Done. */
function baseGraph(): ComparableGraph<Step, Route> {
  return {
    steps: [step("write"), step("check", { ownerRole: "checker" }), step("done", { type: "user", entryAction: null, ownerRole: null })],
    routes: [route("write", "done", "check"), route("check", "approved", "done"), route("check", "rejected", "write", { tone: "warning" })],
  };
}

function changeOf(changes: readonly KeyChange[], label: string): KeyChange | undefined {
  return changes.find((change) => describeUpdateKey(change.key) === label);
}

describe("classifying one key", () => {
  it("takes the template's where only the template changed it", () => {
    expect(classifyKey("a", "a", "b")).toBe("template");
  });

  it("keeps the person's where only the person changed it", () => {
    expect(classifyKey("a", "b", "a")).toBe("person");
  });

  it("has nothing to do where both changed it to the same value", () => {
    expect(classifyKey("a", "b", "b")).toBe("same");
  });

  it("is a conflict where both changed it differently", () => {
    expect(classifyKey("a", "b", "c")).toBe("conflict");
  });

  it("is unchanged where nobody changed it", () => {
    expect(classifyKey({ x: 1 }, { x: 1 }, { x: 1 })).toBe("unchanged");
  });

  it("compares structurally, so key order and an absent field are not changes", () => {
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
  });
});

describe("comparing three graphs", () => {
  it("lists nothing where the three are the same", () => {
    expect(compareThreeWay(baseGraph(), baseGraph(), baseGraph())).toEqual({ changes: [], conflicts: [] });
  });

  it("classifies each step setting by field", () => {
    const current = baseGraph();
    const template = baseGraph();
    current.steps = current.steps.map((s) => (s.id === "write" ? { ...s, ownerRole: "writer", timeoutMs: 60_000 } : s));
    template.steps = template.steps.map((s) => (s.id === "write" ? { ...s, entryAction: "draft", timeoutMs: 60_000 } : s.id === "check" ? { ...s, watch: { everyMinutes: 5, giveUpAfterHours: 24 } } : s));

    const { changes, conflicts } = compareThreeWay(baseGraph(), current, template);

    expect(changeOf(changes, "write: ownerRole")?.outcome).toBe("person");
    expect(changeOf(changes, "write: entryAction")?.outcome).toBe("template");
    expect(changeOf(changes, "write: timeoutMs")?.outcome).toBe("same");
    expect(changeOf(changes, "check: watch")).toMatchObject({ outcome: "template", base: null, current: null, template: { everyMinutes: 5, giveUpAfterHours: 24 } });
    expect(conflicts).toEqual([]);
  });

  it("is a conflict where both sides set one field differently, with all three values", () => {
    const current = baseGraph();
    const template = baseGraph();
    current.steps = current.steps.map((s) => (s.id === "check" ? { ...s, ownerRole: "auditor" } : s));
    template.steps = template.steps.map((s) => (s.id === "check" ? { ...s, ownerRole: "reviewer" } : s));

    const { conflicts } = compareThreeWay(baseGraph(), current, template);

    expect(conflicts).toEqual([{ key: { kind: "setting", stepId: "check", field: "ownerRole" }, outcome: "conflict", base: "checker", current: "auditor", template: "reviewer" }]);
  });

  it("compares inputs, results and type field by field too", () => {
    const current = baseGraph();
    const template = baseGraph();
    current.steps = current.steps.map((s) => (s.id === "done" ? { ...s, results: [{ key: "ok" }] } : s));
    template.steps = template.steps.map((s) => (s.id === "done" ? { ...s, results: [{ key: "fine" }] } : s.id === "write" ? { ...s, type: "module", inputs: { every: 5 } } : s));

    const { changes, conflicts } = compareThreeWay(baseGraph(), current, template);

    expect(conflicts.map((change) => describeUpdateKey(change.key))).toEqual(["done: results"]);
    expect(changeOf(changes, "write: type")?.outcome).toBe("template");
    expect(changeOf(changes, "write: inputs")?.outcome).toBe("template");
  });

  it("does not compare what is not a setting: a step's name stays the person's", () => {
    const template = baseGraph();
    template.steps = template.steps.map((s) => (s.id === "write" ? { ...s, name: "Draft" } : s));
    expect(compareThreeWay(baseGraph(), baseGraph(), template).changes).toEqual([]);
  });

  it("is template-only where the template added a step, and where it removed one", () => {
    const template = baseGraph();
    template.steps = [...template.steps, step("publish")];
    template.steps = template.steps.filter((s) => s.id !== "check");

    const { changes, conflicts } = compareThreeWay(baseGraph(), baseGraph(), template);

    expect(changeOf(changes, "step publish")).toMatchObject({ outcome: "template", base: null, current: null });
    expect(changeOf(changes, "step check")).toMatchObject({ outcome: "template", current: { ownerRole: "checker" }, template: null });
    expect(conflicts).toEqual([]);
  });

  it("is person-only where the person removed a step the template left alone", () => {
    const current = baseGraph();
    current.steps = current.steps.filter((s) => s.id !== "check");
    expect(changeOf(compareThreeWay(baseGraph(), current, baseGraph()).changes, "step check")?.outcome).toBe("person");
  });

  it("is a conflict where the person deleted a step the template changed", () => {
    const current = baseGraph();
    current.steps = current.steps.filter((s) => s.id !== "check");
    const template = baseGraph();
    template.steps = template.steps.map((s) => (s.id === "check" ? { ...s, entryAction: "inspect" } : s));

    const change = changeOf(compareThreeWay(baseGraph(), current, template).conflicts, "step check");

    expect(change).toMatchObject({ outcome: "conflict", base: { entryAction: "work" }, current: null, template: { entryAction: "inspect" } });
  });

  it("is a conflict where the template deleted a step the person changed", () => {
    const current = baseGraph();
    current.steps = current.steps.map((s) => (s.id === "check" ? { ...s, watch: { everyMinutes: 1, giveUpAfterHours: 1 } } : s));
    const template = baseGraph();
    template.steps = template.steps.filter((s) => s.id !== "check");

    expect(changeOf(compareThreeWay(baseGraph(), current, template).conflicts, "step check")).toMatchObject({ current: { watch: { everyMinutes: 1 } }, template: null });
  });

  it("is the same where both deleted a step", () => {
    const current = baseGraph();
    current.steps = current.steps.filter((s) => s.id !== "check");
    const template = baseGraph();
    template.steps = template.steps.filter((s) => s.id !== "check");
    expect(changeOf(compareThreeWay(baseGraph(), current, template).changes, "step check")?.outcome).toBe("same");
  });

  it("keys routes by the step they leave and the result they route", () => {
    const current = baseGraph();
    current.routes = [...current.routes, route("write", "blocked", "done")];
    const template = baseGraph();
    template.routes = template.routes.map((r) => (r.resultKey === "rejected" ? { ...r, label: "Sent back" } : r));

    const { changes, conflicts } = compareThreeWay(baseGraph(), current, template);

    expect(changeOf(changes, "write → blocked")).toMatchObject({ outcome: "person", base: null });
    expect(changeOf(changes, "check → rejected")).toMatchObject({ outcome: "template", base: { label: "rejected" }, template: { label: "Sent back" } });
    expect(conflicts).toEqual([]);
  });

  it("does not count a route's order among its siblings as a change", () => {
    const current = baseGraph();
    current.routes = current.routes.map((r) => ({ ...r, position: 7 }));
    expect(compareThreeWay(baseGraph(), current, baseGraph()).changes).toEqual([]);
  });

  it("is a conflict where both re-pointed one route differently, with each target", () => {
    const current = baseGraph();
    current.routes = current.routes.map((r) => (r.resultKey === "approved" ? { ...r, target: "elsewhere" } : r));
    const template = baseGraph();
    template.routes = template.routes.map((r) => (r.resultKey === "approved" ? { ...r, target: "publish" } : r));

    expect(compareThreeWay(baseGraph(), current, template).conflicts).toEqual([
      {
        key: { kind: "route", fromStepId: "check", resultKey: "approved" },
        outcome: "conflict",
        base: { target: "done", label: "approved", tone: "success" },
        current: { target: "elsewhere", label: "approved", tone: "success" },
        template: { target: "publish", label: "approved", tone: "success" },
      },
    ]);
  });

  it("is a conflict where one side deleted a route the other re-pointed", () => {
    const current = baseGraph();
    current.routes = current.routes.filter((r) => r.resultKey !== "rejected");
    const template = baseGraph();
    template.routes = template.routes.map((r) => (r.resultKey === "rejected" ? { ...r, target: "check" } : r));
    expect(compareThreeWay(baseGraph(), current, template).conflicts.map((change) => describeUpdateKey(change.key))).toEqual(["check → rejected"]);
  });
});

describe("merging", () => {
  it("applies only what the template changed, and keeps everything the person did", () => {
    const current = baseGraph();
    current.steps = current.steps.map((s) => (s.id === "write" ? { ...s, name: "Write it", ownerRole: "writer" } : s));
    current.routes = [...current.routes, route("write", "blocked", "done", { position: 1 })];
    const template = baseGraph();
    template.steps = template.steps.map((s) => (s.id === "check" ? { ...s, watch: { everyMinutes: 5, giveUpAfterHours: 24 } } : s));
    template.routes = template.routes.map((r) => (r.resultKey === "rejected" ? { ...r, label: "Sent back", position: 3 } : r));

    const merge = mergeThreeWay(baseGraph(), current, template);

    expect(merge.ok).toBe(true);
    if (!merge.ok) return;
    const write = merge.merged.steps.find((s) => s.id === "write");
    expect(write).toMatchObject({ name: "Write it", ownerRole: "writer" });
    expect(merge.merged.steps.find((s) => s.id === "check")?.watch).toEqual({ everyMinutes: 5, giveUpAfterHours: 24 });
    // The person's route, with the template's label — and the person's position.
    expect(merge.merged.routes.find((r) => r.resultKey === "rejected")).toMatchObject({ label: "Sent back", position: 0 });
    expect(merge.merged.routes.find((r) => r.resultKey === "blocked")).toBeDefined();
  });

  it("places a step the template added after the step it follows there, with its routes", () => {
    const current = baseGraph();
    current.steps = [step("intake"), ...current.steps];
    const template = baseGraph();
    template.steps = [template.steps[0]!, template.steps[1]!, step("publish"), template.steps[2]!];
    template.routes = template.routes.map((r) => (r.resultKey === "approved" ? { ...r, target: "publish" } : r));
    template.routes = [...template.routes, route("publish", "done", "done")];

    const merge = mergeThreeWay(baseGraph(), current, template);

    expect(merge.ok).toBe(true);
    if (!merge.ok) return;
    expect(merge.merged.steps.map((s) => s.id)).toEqual(["intake", "write", "check", "publish", "done"]);
    expect(merge.merged.routes.find((r) => r.resultKey === "approved")?.target).toBe("publish");
    expect(merge.merged.routes.find((r) => r.fromStepId === "publish")).toEqual(route("publish", "done", "done"));
  });

  it("removes what the template removed, and leaves what the person removed removed", () => {
    const current = baseGraph();
    current.routes = current.routes.filter((r) => r.resultKey !== "rejected");
    const template = baseGraph();
    template.steps = template.steps.filter((s) => s.id !== "check");
    template.routes = [route("write", "done", "done")];

    const merge = mergeThreeWay(baseGraph(), current, template);

    // `write → done` was re-pointed by the template only; `check → approved`
    // removed by the template only; `check → rejected` removed by both.
    expect(merge.ok).toBe(true);
    if (!merge.ok) return;
    expect(merge.merged.steps.map((s) => s.id)).toEqual(["write", "done"]);
    expect(merge.merged.routes).toEqual([route("write", "done", "done")]);
  });

  it("applies nothing at all where any key conflicts", () => {
    const current = baseGraph();
    current.routes = current.routes.map((r) => (r.resultKey === "approved" ? { ...r, target: "elsewhere" } : r));
    const template = baseGraph();
    template.steps = [...template.steps, step("publish")];
    template.routes = template.routes.map((r) => (r.resultKey === "approved" ? { ...r, target: "publish" } : r));

    const merge = mergeThreeWay(baseGraph(), current, template);

    expect(merge.ok).toBe(false);
    expect("merged" in merge).toBe(false);
    expect(merge.comparison.conflicts).toHaveLength(1);
    // The new step is still reported, as a change only the template made.
    expect(changeOf(merge.comparison.changes, "step publish")?.outcome).toBe("template");
  });
});
