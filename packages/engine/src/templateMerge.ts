/**
 * Comparing a pipeline three ways (EO-532, ARCHITECTURE.md, "Template
 * versions and origins").
 *
 * A pipeline made from a template remembers the version it came from —
 * its *base*. When a later release ships a newer version of that
 * template, three graphs are on the table: the base, the pipeline as the
 * person has it now, and the new version. Comparing the person's graph
 * with the base says what the person changed; comparing the new version
 * with the base says what the template changed. Each key is then one of:
 *
 * | Changed by               | Outcome                   |
 * |--------------------------|---------------------------|
 * | only the template        | take the template's       |
 * | only the person          | keep the person's         |
 * | both, to the same value  | nothing to do             |
 * | both, differently        | conflict                  |
 *
 * Keys are:
 *
 * - a **step**, by id, where it is missing from at least one of the
 *   three — an addition or a deletion. Its value is the step's compared
 *   settings, or null where it is absent. So a step one side deleted and
 *   the other changed is a conflict by the table above, with nothing
 *   special about it: the deleting side's value is null, the changing
 *   side's is the changed settings, and neither is the base's.
 * - a step **setting**, by step id and field, where the step is in all
 *   three: its type, its entry action, its owner, keep checking, its
 *   inputs, its time limit and its results (`COMPARED_STEP_FIELDS`).
 * - a **route**, by the step it leaves and the result key it routes —
 *   two routes out of one result is a graph the validator refuses, so
 *   that pair is a route's identity. Its value is where it goes, with
 *   its label and tone, or null where it is absent.
 *
 * What is not compared stays the person's: a step's name, its summary,
 * its place on the board, a route's order. A template that renames a
 * step does not rename the person's.
 *
 * Pure, and about nothing in particular: a step is an id with some
 * settings, a route is an edge with a key. The caller translates its
 * own rows into these shapes and back, and decides what an applied
 * merge is written as.
 */

/** The step settings compared field by field. */
export const COMPARED_STEP_FIELDS = ["type", "entryAction", "ownerRole", "watch", "inputs", "timeoutMs", "results"] as const;
export type ComparedStepField = (typeof COMPARED_STEP_FIELDS)[number];

/** The route fields that make up a route's value. Its order among its siblings is not one of them. */
export const COMPARED_ROUTE_FIELDS = ["target", "label", "tone"] as const;
export type ComparedRouteField = (typeof COMPARED_ROUTE_FIELDS)[number];

/** A step as the comparison reads it: an id, and the settings it compares. Anything else on it is carried, never read. */
export type ComparableStep = { readonly id: string } & { readonly [F in ComparedStepField]: unknown };

/** A route as the comparison reads it. Anything else on it is carried, never read. */
export type ComparableRoute = { readonly fromStepId: string; readonly resultKey: string } & { readonly [F in ComparedRouteField]: unknown };

/**
 * One of the three graphs, its steps in board order.
 *
 * The order is what a merged graph places a step the template added by:
 * after the step it follows in the template.
 */
export interface ComparableGraph<S extends ComparableStep = ComparableStep, R extends ComparableRoute = ComparableRoute> {
  steps: readonly S[];
  routes: readonly R[];
}

/** What a key is. */
export type UpdateKey =
  | { kind: "step"; stepId: string }
  | { kind: "setting"; stepId: string; field: ComparedStepField }
  | { kind: "route"; fromStepId: string; resultKey: string };

/** Who changed a key, and so what a merge does with it. */
export type KeyOutcome =
  /** Only the template changed it: the merge takes the template's. */
  | "template"
  /** Only the person changed it: the merge keeps theirs. */
  | "person"
  /** Both changed it, to the same value: nothing to do. */
  | "same"
  /** Both changed it, differently: the update is held. */
  | "conflict";

/**
 * One key somebody changed, with its three values.
 *
 * A value is null where the step or route is absent from that graph. A
 * setting's value is never "absent" — settings are compared only for a
 * step all three graphs have — so a null there is the setting's own.
 */
export interface KeyChange {
  key: UpdateKey;
  outcome: KeyOutcome;
  base: unknown;
  current: unknown;
  template: unknown;
}

export interface ThreeWayComparison {
  /**
   * Every key somebody changed, steps first in the order the person's
   * graph and then the template's has them, then routes. A key nobody
   * changed is not listed: all three agree, and a merge leaves it.
   */
  changes: KeyChange[];
  /** The changes whose outcome is a conflict. Empty means the update can be applied. */
  conflicts: KeyChange[];
}

/**
 * Who changed a key, given its three values — or `unchanged` where
 * neither side did.
 *
 * The table at the top of this file, and nothing else. Values are
 * compared structurally: an object's key order is not a change.
 */
export function classifyKey(base: unknown, current: unknown, template: unknown): KeyOutcome | "unchanged" {
  const personChanged = !sameValue(base, current);
  const templateChanged = !sameValue(base, template);
  if (!personChanged && !templateChanged) return "unchanged";
  if (!personChanged) return "template";
  if (!templateChanged) return "person";
  return sameValue(current, template) ? "same" : "conflict";
}

/** Compares the three graphs key by key. */
export function compareThreeWay(base: ComparableGraph, current: ComparableGraph, template: ComparableGraph): ThreeWayComparison {
  const changes: KeyChange[] = [];

  const baseSteps = byStepId(base.steps);
  const currentSteps = byStepId(current.steps);
  const templateSteps = byStepId(template.steps);
  for (const stepId of unionInOrder(current.steps.map((s) => s.id), template.steps.map((s) => s.id), base.steps.map((s) => s.id))) {
    const inBase = baseSteps.get(stepId);
    const inCurrent = currentSteps.get(stepId);
    const inTemplate = templateSteps.get(stepId);
    if (inBase !== undefined && inCurrent !== undefined && inTemplate !== undefined) {
      for (const field of COMPARED_STEP_FIELDS) {
        const values = { base: inBase[field], current: inCurrent[field], template: inTemplate[field] };
        const outcome = classifyKey(values.base, values.current, values.template);
        if (outcome !== "unchanged") changes.push({ key: { kind: "setting", stepId, field }, outcome, ...values });
      }
      continue;
    }
    const values = { base: stepValue(inBase), current: stepValue(inCurrent), template: stepValue(inTemplate) };
    const outcome = classifyKey(values.base, values.current, values.template);
    if (outcome !== "unchanged") changes.push({ key: { kind: "step", stepId }, outcome, ...values });
  }

  const baseRoutes = byRouteKey(base.routes);
  const currentRoutes = byRouteKey(current.routes);
  const templateRoutes = byRouteKey(template.routes);
  for (const routeKey of unionInOrder([...currentRoutes.keys()], [...templateRoutes.keys()], [...baseRoutes.keys()])) {
    const sample = currentRoutes.get(routeKey) ?? templateRoutes.get(routeKey) ?? baseRoutes.get(routeKey);
    if (sample === undefined) continue;
    const values = { base: routeValue(baseRoutes.get(routeKey)), current: routeValue(currentRoutes.get(routeKey)), template: routeValue(templateRoutes.get(routeKey)) };
    const outcome = classifyKey(values.base, values.current, values.template);
    if (outcome !== "unchanged") changes.push({ key: { kind: "route", fromStepId: sample.fromStepId, resultKey: sample.resultKey }, outcome, ...values });
  }

  return { changes, conflicts: changes.filter((change) => change.outcome === "conflict") };
}

export type ThreeWayMerge<S extends ComparableStep, R extends ComparableRoute> =
  | { ok: true; comparison: ThreeWayComparison; merged: { steps: S[]; routes: R[] } }
  | { ok: false; comparison: ThreeWayComparison };

/**
 * The person's graph with every change only the template made applied
 * to it — or, where any key conflicts, nothing at all.
 *
 * All or nothing, deliberately: a partial merge can break a graph. A
 * step the template added, whose route in is the conflicting one, would
 * arrive unreachable.
 *
 * What the merged graph is made of:
 *
 * - a step the template added is the template's step, placed after the
 *   step it follows in the template (or first, if it follows none that
 *   the merged graph has);
 * - a step the template removed is gone;
 * - a step whose settings the template changed is the person's step
 *   with those fields taken from the template's, and everything else on
 *   it — its name, its place, whatever the caller carries — the
 *   person's;
 * - a route the template added is the template's route, after the
 *   person's; one it removed is gone; one it re-pointed or relabelled is
 *   the person's route with the template's target, label and tone.
 *
 * Whether the result is a pipeline that works is not this function's
 * question. The caller validates it, and one that does not validate is
 * held exactly as a conflict is.
 */
export function mergeThreeWay<S extends ComparableStep, R extends ComparableRoute>(
  base: ComparableGraph<S, R>,
  current: ComparableGraph<S, R>,
  template: ComparableGraph<S, R>,
): ThreeWayMerge<S, R> {
  const comparison = compareThreeWay(base, current, template);
  if (comparison.conflicts.length > 0) return { ok: false, comparison };

  const templateSteps = byStepId(template.steps);
  const templateRoutes = byRouteKey(template.routes);
  const taken = comparison.changes.filter((change) => change.outcome === "template");

  const removedSteps = new Set<string>();
  const addedSteps = new Set<string>();
  const fieldsByStep = new Map<string, ComparedStepField[]>();
  const removedRoutes = new Set<string>();
  const addedRoutes = new Set<string>();
  const changedRoutes = new Set<string>();
  for (const change of taken) {
    const { key } = change;
    if (key.kind === "step") {
      if (change.template === null) removedSteps.add(key.stepId);
      else addedSteps.add(key.stepId);
    } else if (key.kind === "setting") {
      fieldsByStep.set(key.stepId, [...(fieldsByStep.get(key.stepId) ?? []), key.field]);
    } else {
      const routeKey = routeKeyOf(key.fromStepId, key.resultKey);
      if (change.template === null) removedRoutes.add(routeKey);
      else if (change.current === null) addedRoutes.add(routeKey);
      else changedRoutes.add(routeKey);
    }
  }

  // The person's steps, in their order, with the template's settings
  // laid over the fields only it changed.
  const steps: S[] = [];
  for (const step of current.steps) {
    if (removedSteps.has(step.id)) continue;
    const fields = fieldsByStep.get(step.id);
    const fromTemplate = templateSteps.get(step.id);
    if (fields === undefined || fromTemplate === undefined) {
      steps.push(step);
      continue;
    }
    const updated: Record<string, unknown> = { ...step };
    for (const field of fields) updated[field] = fromTemplate[field];
    steps.push(updated as S);
  }

  // Then each step the template added, after the one it follows there.
  for (const [index, step] of template.steps.entries()) {
    if (!addedSteps.has(step.id)) continue;
    let at = 0;
    for (let before = index - 1; before >= 0; before--) {
      const previous = template.steps[before];
      const found = previous === undefined ? -1 : steps.findIndex((placed) => placed.id === previous.id);
      if (found >= 0) {
        at = found + 1;
        break;
      }
    }
    steps.splice(at, 0, step);
  }

  const routes: R[] = [];
  for (const route of current.routes) {
    const routeKey = routeKeyOf(route.fromStepId, route.resultKey);
    if (removedRoutes.has(routeKey)) continue;
    const fromTemplate = templateRoutes.get(routeKey);
    if (changedRoutes.has(routeKey) && fromTemplate !== undefined) {
      const updated: Record<string, unknown> = { ...route };
      for (const field of COMPARED_ROUTE_FIELDS) updated[field] = fromTemplate[field];
      routes.push(updated as R);
    } else {
      routes.push(route);
    }
  }
  for (const route of template.routes) {
    if (addedRoutes.has(routeKeyOf(route.fromStepId, route.resultKey))) routes.push(route);
  }

  return { ok: true, comparison, merged: { steps, routes } };
}

/** How a key reads in a sentence: "step review", "review: entryAction", "merge_request → opened". */
export function describeUpdateKey(key: UpdateKey): string {
  if (key.kind === "step") return `step ${key.stepId}`;
  if (key.kind === "setting") return `${key.stepId}: ${key.field}`;
  return `${key.fromStepId} → ${key.resultKey}`;
}

/**
 * Whether two values are the same, structurally.
 *
 * `undefined` reads as null, so a field one graph leaves out and
 * another states as null are the same statement.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, inner]) => [key, normalise(inner)]));
  }
  return value;
}

function stepValue(step: ComparableStep | undefined): Record<string, unknown> | null {
  if (step === undefined) return null;
  return Object.fromEntries(COMPARED_STEP_FIELDS.map((field) => [field, step[field] ?? null]));
}

function routeValue(route: ComparableRoute | undefined): Record<string, unknown> | null {
  if (route === undefined) return null;
  return Object.fromEntries(COMPARED_ROUTE_FIELDS.map((field) => [field, route[field] ?? null]));
}

function byStepId<S extends ComparableStep>(steps: readonly S[]): Map<string, S> {
  return new Map(steps.map((step) => [step.id, step]));
}

function routeKeyOf(fromStepId: string, resultKey: string): string {
  return JSON.stringify([fromStepId, resultKey]);
}

function byRouteKey<R extends ComparableRoute>(routes: readonly R[]): Map<string, R> {
  return new Map(routes.map((route) => [routeKeyOf(route.fromStepId, route.resultKey), route]));
}

/** Every value of the lists, once each, in the order they are first met. */
function unionInOrder(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const value of list) {
      if (seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}
