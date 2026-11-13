import { actionFactsFor, builtinResultLabel, builtinInputs, builtinResults, declaredStepInputs, ENGINE_RESULTS, resultsFromRoutes, stepHoldsItemsMessage, uuidv7, VERIFICATION_FAILED_RESULT } from "@eo/core";
import type { ModuleInput, ModuleView, PipelineStepView, RegistryFacts, StepHold, StepInputs, StepResult, StepRouteView, WorkspaceMode } from "@eo/core";

/**
 * What a pipeline step can be, and the rules for its results, inputs
 * and removal, apart from any editor that draws them (EO-519). Read by
 * the classic `pipeline/PipelineConfiguration.tsx` and the chat
 * layout's Graph view (`chat/views/board/StepDetails.tsx`).
 */

/** Who acts on a step — the selector that decides which fields it carries. */
export const STEP_TYPES: { value: PipelineStepView["type"]; label: string }[] = [
  { value: "agent", label: "Agent — a role does the work" },
  { value: "user", label: "You — the engine hands off and waits" },
  { value: "builtin", label: "Built in — EO does it itself" },
  // Its own kind rather than a third built-in function, because the two
  // are different trust classes: `builtin` is code EO ships and audited,
  // a module is code somebody here approved (KAN-104).
  { value: "module", label: "Module — run one of your own" },
];

/**
 * How a step uses the repository it runs against (EO-296, ARCHITECTURE.md, "The four kinds").
 *
 * A segmented control rather than two entries in a workspace picker: a
 * person attached one repository and thinks of it as one repository, and
 * "Repository" beside "Repository (read only)" reads like a mistake
 * somebody made rather than like a choice. The words are about what the
 * *step* does, not about what the kind is called, for the same reason.
 */
export const WORKSPACE_MODES: { value: WorkspaceMode; label: string; explains: string }[] = [
  { value: "isolated", label: "Works on a branch", explains: "Gets a worktree and a branch of its own, and what it commits there is the work." },
  { value: "read", label: "Reads only", explains: "Gets the repository as it stands. Reads the repository, changes nothing." },
];

/**
 * The functions a built-in step can run, as the picker offers them: every
 * one the installed registry has, by the label it declares (EO-507).
 *
 * Read from the registry rather than listed here. A list here was a list
 * of the builtins somebody remembered to add to it — the core's
 * `wait_until` was not, so a Wait until step could only be made by
 * import — and the core builds without any pack, so which functions
 * exist is the installation's answer, not this file's.
 */
export function builtinOptions(registry: RegistryFacts): { action: string; label: string }[] {
  return [...registry.builtins].map(([action, entry]) => ({ action, label: entry.label }));
}

/**
 * How an edge is drawn, and a decision about the pipeline rather than a
 * fact about the thing that runs — so it stays editable on every kind of
 * step, including the ones whose keys this screen now states (EO-77).
 * `deployed` is a success on one pipeline and the thing you watch for on
 * another; only whoever wired it knows which.
 */
export const TONES: { value: StepRouteView["tone"]; label: string; dot: string }[] = [
  { value: "success", label: "Success", dot: "bg-success" },
  { value: "warning", label: "Warning", dot: "bg-paused" },
  { value: "info", label: "Info", dot: "bg-reviewing" },
  { value: "danger", label: "Danger", dot: "bg-danger" },
];

/**
 * Roles that answer in a conversation rather than owning a column.
 *
 * One since EO-181, and still a set: the reason is a property of the
 * role rather than a count. It is reached through the mention path with
 * an action no pipeline declares, so a step owned by it would be
 * dispatched by nothing and hold its item forever. Excluded from the
 * owner picker rather than merely discouraged, because the failure is
 * silent.
 */
export const CONVERSATIONAL_ROLES = new Set(["system"]);

/**
 * What a "move them to X" left behind, in one sentence (EO-327, ARCHITECTURE.md, "Publish, lock and
 * versions").
 *
 * Said out loud because the alternative is a bulk move that reports
 * nothing and appears to have half worked: the step's count goes down
 * and does not reach zero, and nothing on the screen says why. Each
 * reason is a different task — restore it, decide about the run, or
 * leave it to finish on the version it entered on — so each is named.
 *
 * Null when everything moved, which is the ordinary case and deserves
 * no line at all.
 */
export function whatWasLeft(outcome: { moved: number; archived: number; running: number; otherVersion: number } | undefined): string | null {
  if (!outcome) return null;
  const left = [
    outcome.archived === 0 ? null : `${outcome.archived} archived — restore ${outcome.archived === 1 ? "it" : "them"} from the Archive first`,
    outcome.running === 0 ? null : `${outcome.running} with an agent working on ${outcome.running === 1 ? "it" : "them"} — move ${outcome.running === 1 ? "that one" : "those"} by hand`,
    outcome.otherVersion === 0
      ? null
      : `${outcome.otherVersion} finishing on an older version that has no such step — ${outcome.otherVersion === 1 ? "it" : "they"} can only move to a step that version has`,
  ].filter((line): line is string => line !== null);
  if (left.length === 0) return null;
  return `${outcome.moved === 0 ? "Nothing moved" : `${outcome.moved} moved`}. Left where ${left.length === 1 ? "it was" : "they were"}: ${left.join("; ")}.`;
}

/**
 * Switching who acts, with the fields the old kind owned cleared out.
 *
 * Without this a step could carry a role while being a built-in, or an
 * entry action while being a person's — contradictions the old four kinds
 * allowed because nothing read them. The validator now rejects both, and a
 * screen that can produce a state its own validator refuses is a screen
 * that traps people.
 */
export function changeKind(step: PipelineStepView, type: PipelineStepView["type"], roles: string[]): Partial<PipelineStepView> {
  // `inputs` goes with `entryAction` every time (EO-78). A configured
  // value belongs to the module that declared the input, and every branch
  // below clears the action — so keeping the values would leave numbers
  // filed against a module this step no longer runs, invisible until
  // somebody pointed it back at one.
  //
  // `timeoutMs` goes the same way (EO-162), for a narrower reason: only a
  // module step can hold one, so every branch that lands somewhere else
  // is clearing a limit that now has nothing to apply it to — which the
  // validator refuses, and meeting that at Publish would be meeting it a
  // screen too late. Becoming a module step brings none along, because
  // there was nowhere for one to have been.
  //
  // `watch` goes too (EO-456): keep checking belongs to the function or
  // module the step ran, which every branch clears, and only a builtin or
  // a module step can keep checking at all.
  if (type === "agent") return { type, ownerRole: step.ownerRole ?? roles[0] ?? null, entryAction: null, inputs: {}, timeoutMs: null, watch: null, moduleVersion: null, isTerminal: false };
  if (type === "builtin" || type === "module") return { type, ownerRole: null, entryAction: null, inputs: {}, timeoutMs: null, watch: null, moduleVersion: null, isTerminal: false };
  // Only a `user` step may be terminal — nothing runs where work is done.
  return { type, ownerRole: null, entryAction: null, inputs: {}, timeoutMs: null, watch: null, moduleVersion: null };
}

/**
 * The inputs the thing this step runs declares, or null when nothing
 * declares any (EO-78, EO-507).
 *
 * A module's come from its manifest and a builtin's from the registry —
 * the same shape, so both editors draw them with one component. An agent
 * step, a person's step and a step with nothing picked have none.
 */
export function declaredInputs(registry: RegistryFacts, step: Pick<PipelineStepView, "type" | "entryAction">, modules: ModuleView[]): Record<string, ModuleInput> | null {
  if (step.type === "builtin") {
    const inputs = builtinInputs(registry, step.entryAction);
    return inputs === null ? null : { ...inputs };
  }
  if (step.type === "module") return modules.find((module) => module.id === step.entryAction)?.manifest.inputs ?? null;
  return null;
}

/**
 * The configured values a step keeps once it runs what it now runs (EO-78, EO-507).
 *
 * The declaration decides what exists — a module's manifest, a builtin's
 * registry entry. A value for an input the newly chosen function or
 * module does not declare is discarded rather than carried, because it is
 * not that one's anything — nothing would render it, nothing would read
 * it, and it would sit in the row waiting for a declaration to give it a
 * meaning nobody intended. One it does declare is kept: picking the same
 * function again, or applying a draft that leaves it where it was, must
 * not erase an `at` or a `reportReady` that came from an import. A step
 * that runs nothing declaring inputs — an agent's action, nothing at all
 * — keeps none.
 */
export function keptInputs(registry: RegistryFacts, step: Pick<PipelineStepView, "type" | "entryAction">, values: StepInputs, modules: ModuleView[]): StepInputs {
  const declared = declaredInputs(registry, step, modules);
  return declared ? declaredStepInputs({ inputs: declared }, values) : {};
}

/**
 * What the thing this step runs can return, or null when nothing declares
 * it (EO-77).
 *
 * A builtin and a module both say up front everything they can answer —
 * one in the registry, one in its manifest — so the editor can fill
 * the result rows in and fix the keys. An agent step says it too, since
 * an action became a declared thing (EO-428): the keys of whatever
 * (owner role, entry action) resolves to, by `actionFactsFor` — the one
 * lookup the validator holds the same step to at publish, so the rows
 * this fills in are the rows Publish asks for.
 *
 * Null is "nothing declares it", and it is not "returns nothing": an
 * agent step whose action no definition covers answers in prose, which
 * is read as `done`, so its keys stay free text. A step with nothing
 * picked yet is null too — there is no declaration to read until
 * something is chosen.
 */
export function declaredResults(registry: RegistryFacts, step: PipelineStepView, modules: ModuleView[]): string[] | null {
  if (step.type === "builtin") {
    const results = builtinResults(registry, step.entryAction);
    return results ? [...results] : null;
  }
  if (step.type === "module") return modules.find((module) => module.id === step.entryAction)?.manifest.results ?? null;
  if (step.type === "agent" && step.entryAction !== null) return actionFactsFor(registry, step.ownerRole, step.entryAction)?.results.map((result) => result.key) ?? null;
  return null;
}

/**
 * The engine's results an agent step may still be given a route for
 * (EO-428).
 *
 * Once an action declares its keys the rows are fixed and "Add result"
 * goes, which would leave no way to say where a run that stopped to ask
 * or one that escalated should go — results EO produces whatever the
 * action is (`ENGINE_RESULTS`), permitted on every agent step and
 * required on none. So they are offered by name instead of typed.
 *
 * Not `verification_failed`: that one is the workspace kind's word and
 * has its own offer, made only on a step whose action is checked
 * (EO-312). Nothing for a step whose keys are still free text, where
 * "Add result" is the way in, nor for a builtin or a module.
 */
export function engineResultOffers(step: PipelineStepView, declared: string[] | null, routes: StepRouteView[]): string[] {
  if (step.type !== "agent" || declared === null) return [];
  const routed = new Set(routes.filter((route) => route.fromStepId === step.id).map((route) => route.resultKey));
  return ENGINE_RESULTS.filter((key) => key !== VERIFICATION_FAILED_RESULT && !declared.includes(key) && !routed.has(key));
}

/**
 * One of a human step's declared results, by key (EO-310).
 *
 * Read through `resultsFromRoutes` rather than off the step, so the row
 * the checkbox draws is the row the publish sends: a result whose route
 * has just been added has a declaration here before anybody has written
 * one, and one whose route has gone has none.
 */
export function declaredResultFor(step: PipelineStepView, routes: StepRouteView[], resultKey: string): StepResult | undefined {
  return resultsFromRoutes(step, routes).find((result) => result.key === resultKey);
}

/**
 * What to call the thing whose results these are: the module, or the
 * function. Never the step — renaming a column does not change what
 * comes back from it.
 */
export function runnerName(step: PipelineStepView, modules: ModuleView[]): string {
  if (step.type === "module") return modules.find((module) => module.id === step.entryAction)?.name ?? "This module";
  return step.entryAction ?? "This step";
}

/** `changes_requested` → "Changes requested". A starting point for a label, not a translation. */
function humanize(resultKey: string): string {
  const words = resultKey.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What to call a result before anybody has renamed it (EO-309, ARCHITECTURE.md, "What a pack
 * labels").
 *
 * The pack's own word first, for the two results the engine produces
 * rather than a runner — a support pack calling `escalation` "Hand to a
 * supervisor" says so once on its vocabulary rather than once per
 * pipeline that routes it. `humanize` for everything else, which is
 * every result a builtin or a module declares: those keys are the
 * runner's own words and the pack has nothing to add to them.
 *
 * A seed either way. The row is an editable label from the moment it
 * appears, and what somebody types on it wins for good.
 */
export function resultLabel(registry: RegistryFacts, resultKey: string): string {
  return builtinResultLabel(registry, resultKey) ?? humanize(resultKey);
}

/**
 * The result rows a step gets when its module or builtin is picked (EO-77).
 *
 * One per declared result, in the order the declaration lists them, and
 * nothing else — which is the whole point: the key is a fact about the
 * thing that runs, so the editor states it rather than asking. Everything
 * about the routing is still a decision, so a result the previous choice
 * also had keeps the row it had, label, tone, target and id intact:
 * swapping a module for one that also returns `failed` should not throw
 * away where `failed` went.
 *
 * What the new choice cannot return comes back as `dropped` instead of
 * being deleted quietly — those rows are somebody's wiring, and a screen
 * that removes wiring without saying so is a screen you cannot trust.
 *
 * On an agent step two things differ (EO-428). A new row takes the label
 * the action's definition gives the key, which is what somebody wrote
 * for exactly this. And a row on one of the engine's own results
 * (`ENGINE_RESULTS`) stays where the action does not declare it: EO
 * produces those whatever the action is, so the row is not a branch the
 * new choice cannot take, and it is neither dropped nor reported.
 */
export function fillResults(
  registry: RegistryFacts,
  step: PipelineStepView,
  routes: StepRouteView[],
  results: string[],
  fallbackTarget: string,
): { routes: StepRouteView[]; dropped: StepRouteView[] } {
  const mine = routes.filter((route) => route.fromStepId === step.id);
  const byKey = new Map(mine.map((route) => [route.resultKey, route]));
  const declared = step.type === "agent" && step.entryAction !== null ? actionFactsFor(registry, step.ownerRole, step.entryAction)?.results : undefined;
  const kept = step.type === "agent" ? mine.filter((route) => ENGINE_RESULTS.includes(route.resultKey) && !results.includes(route.resultKey)) : [];
  const filled = results.map((resultKey, position) => {
    const existing = byKey.get(resultKey);
    if (existing) return { ...existing, position };
    return {
      // Fresh, for the reason `addStep` and `addResult` give: a route id
      // is a global primary key, so nothing here may derive one.
      id: uuidv7(),
      pipelineId: step.pipelineId,
      fromStepId: step.id,
      resultKey,
      label: declared?.find((result) => result.key === resultKey)?.label || resultLabel(registry, resultKey),
      tone: "info" as const,
      target: fallbackTarget,
      position,
    };
  });

  return {
    routes: [
      ...routes.filter((route) => route.fromStepId !== step.id),
      ...filled,
      // After the declared rows, in the order they were in.
      ...kept.sort((a, b) => a.position - b.position).map((route, index) => ({ ...route, position: filled.length + index })),
    ],
    dropped: mine.filter((route) => !results.includes(route.resultKey) && !kept.includes(route)),
  };
}

/**
 * The graph with one step taken out of it (EO-167).
 *
 * Staged like every other structural edit on this screen: it lands in the
 * draft, is drawn in the preview, and is only written by Publish — which
 * is also the last chance to refuse it, since items move while a draft
 * is open.
 *
 * Three things follow the step out, and each is a decision rather than
 * bookkeeping.
 *
 * The routes, both directions. Its own results go because the rows that
 * edited them go with it, and one left behind is an error nobody could
 * then clear. The routes *into* it go because they would point at a step
 * in no pipeline — an error too, and the one this screen has to show
 * before the click rather than after: those edges are somebody's wiring.
 * Removed rather than repointed, because where a branch goes is a
 * decision somebody made, and silently choosing a new destination is
 * inventing wiring nobody drew. What is left is a result with no route,
 * which walks to the next step and which the validator says out loud.
 *
 * The positions, renumbered to a contiguous run. Not tidiness: `addStep`
 * numbers a new step by how many there are, so a gap left by a removal
 * makes the next added step collide with whatever already sits at that
 * number — and the validator refuses the save, naming a position rather
 * than the removal that caused it.
 *
 * The entry step, when it was the one removed. The first remaining step
 * that is not terminal, which is the same answer `addStep` gives an empty
 * pipeline: work has to land somewhere, and leaving it unset would be
 * removing a step and publishing a pipeline nothing can enter. Terminal
 * ones are skipped because the validator refuses an entry that finishes
 * the work — it would arrive done. Null when there is no candidate at
 * all, which Publish then refuses by name rather than this pretending to
 * have solved it.
 */
export function withoutStep(
  stepId: string,
  steps: PipelineStepView[],
  routes: StepRouteView[],
  entryStepId: string | null,
): { steps: PipelineStepView[]; routes: StepRouteView[]; entryStepId: string | null } {
  const kept = steps
    .filter((step) => step.id !== stepId)
    .sort((a, b) => a.position - b.position)
    .map((step, index) => ({ ...step, position: index }));

  return {
    steps: kept,
    routes: routes.filter((route) => route.fromStepId !== stepId && route.target !== stepId),
    entryStepId: entryStepId === stepId ? (kept.find((step) => !step.isTerminal)?.id ?? null) : entryStepId,
  };
}

/**
 * What the armed Remove button asks (EO-167).
 *
 * "Delete it — and archive its work?" is the model: one question, in
 * place, naming the consequence rather than asking whether you are sure.
 * The count is in the question because the routes are the part that is
 * easy not to have noticed — the step is right there on the screen, the
 * edges pointing at it are drawn from three other panels.
 */
export function removalQuestion(routesIn: number): string {
  if (routesIn === 0) return "Remove it?";
  return routesIn === 1 ? "Remove it — and the route into it?" : `Remove it — and the ${routesIn} routes into it?`;
}

/**
 * Why this step cannot be removed, or null when it can (EO-167).
 *
 * Refusing rather than removing and reporting afterwards, and refused
 * here rather than at Publish: all three of these are things a person can
 * go and fix, and none of them is something this screen may fix on their
 * behalf. Moving work is the engine's business, stopping a run is a
 * decision with a subprocess on the other end, and a hand-off belongs to
 * the pipeline that declares it.
 *
 * Ordered by which is worse. A run in flight is the strongest case — the
 * item is not merely parked on the step, an agent is working on it — so
 * it is what gets said even when items and routes are wrong too;
 * answering the smallest problem first would walk somebody through three
 * refusals to reach the one that mattered.
 */
export function removalRefusal(step: Pick<PipelineStepView, "name">, held: StepHold | undefined): string | null {
  if (!held) return null;
  if (held.running > 0) {
    return held.running === 1
      ? "A run is in flight on this step. Stop it before removing the step."
      : `${held.running} runs are in flight on this step. Stop them before removing the step.`;
  }
  // The sentence Publish and the repository use for the same fact
  // (EO-230), so the refusal read beside the step is the one a save
  // would give — named and counted the same way.
  if (held.items > 0) return stepHoldsItemsMessage({ stepName: step.name, count: held.items, archived: held.archived });
  if (held.routesIn.length > 0) {
    // Named by the pipeline that declares them, because that is where the
    // person has to go: this screen edits one pipeline's routes, and
    // these are not its.
    const named = held.routesIn.map((route) => `${route.pipelineName} · ${route.label}`).join(", ");
    return held.routesIn.length === 1
      ? `${named} routes work here from another pipeline. Repoint it there before removing this step.`
      : `${named} route work here from other pipelines. Repoint them there before removing this step.`;
  }
  return null;
}
