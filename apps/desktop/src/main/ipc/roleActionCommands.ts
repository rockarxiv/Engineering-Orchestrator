import { outputSchemaFor, type ActionRouteUse, type ActionUse, type IpcPayload, type IpcResponse, type PipelineStep, type RegistryView, type StepRoute, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import {
  deleteActionDefinition,
  getActionDefinition,
  listPipelines,
  listRoutesForPipeline,
  listStepsForPipeline,
  olderVersionsInUse,
  saveActionDefinition,
} from "../db/repos/index.js";
import { registryForProject } from "../registry.js";

/**
 * A role's action definitions, read and written from outside the agent
 * screen (EO-425).
 *
 * The record and the one save are `actionDefinitionsRepo`'s; what is
 * here is the half that needs the pipelines as well — which steps
 * dispatch a definition, said on `registry:get` and asked before a
 * delete — and the two commands the `roleActions:*` channels answer
 * with. Both channels are in `SECTION_LOCKED_CHANNELS.agents`, so on an
 * installation whose agents section is managed neither function is
 * reached at all.
 */

/** `role` and `action` as one map key. A space cannot appear in either: a role is a slug and an action matches `ACTION_KEY_PATTERN`. */
function pairKey(role: string, action: string): string {
  return `${role} ${action}`;
}

/**
 * Every agent step in a live pipeline, by the role and action it
 * dispatches.
 *
 * **Live pipelines, on every project.** A definition is the
 * installation's rather than a project's, so a step on a project the
 * window is not showing uses it just the same. An archived pipeline
 * dispatches nothing and is left out: a refusal naming a step nobody can
 * open would be a refusal nobody could clear.
 *
 * **The pair, exactly.** A step uses a definition when its owner is the
 * definition's role and its entry action is the definition's action —
 * the first thing a dispatch resolves (EO-421). A custom role falling
 * through to a pack's action of the same name is not a use of that
 * role's own entry, and is not listed under it.
 *
 * Off-board steps are included, for `agentRemovalImpact`'s reason: one
 * somebody wired to a role is a step items can still reach.
 *
 * **The current graph, and every older version unfinished work is
 * still on.** A step a publish removed is retired rather than dropped
 * (EO-327) and its row goes on naming the role and the action, so
 * reading every row (`listPipelineSteps`) reports uses nobody can clear:
 * the refusal says to remove the step, and removing it is what retired
 * it. But the current graph alone is too little. An item finishes on the
 * version it entered on — `stepForItem` dispatches it by that version's
 * definition of the step — while the answer schema is resolved from the
 * definitions as they stand now. So a definition an older version's step
 * names is still what an item bound to that version will be held to when
 * it gets there, whether the step has since been removed or only given
 * another owner or action. Those uses are listed with the version and
 * the number of items, and they clear themselves: when the last such
 * item finishes or is archived, the version is no longer in use.
 *
 * Every step of such a version counts, not only the ones its items can
 * still reach from where they stand. Routes go backwards as a matter of
 * course, a person may move an item by hand to any step its version
 * has, and a refusal that depended on a reachability walk would be one
 * nobody could predict.
 */
export function actionUses(db: Db): Map<string, ActionUse[]> {
  const uses = new Map<string, ActionUse[]>();
  const add = (step: PipelineStep, pipelineName: string, finishing?: { version: number; items: number }) => {
    if (step.type !== "agent" || step.ownerRole === null || step.entryAction === null) return;
    const key = pairKey(step.ownerRole, step.entryAction);
    const held = uses.get(key) ?? [];
    // A step the current graph still defines this way is one use, said
    // once: the older version adds nothing a person has to act on.
    if (finishing !== undefined && held.some((use) => use.stepId === step.id && use.finishing === undefined)) return;
    held.push({ pipelineId: step.pipelineId, pipelineName, stepId: step.id, stepName: step.name, ...(finishing === undefined ? {} : { finishing }) });
    uses.set(key, held);
  };

  for (const pipeline of listPipelines(db)) {
    for (const step of listStepsForPipeline(db, pipeline.id)) add(step, pipeline.name);
    for (const version of olderVersionsInUse(db, pipeline.id)) {
      for (const step of version.steps) add(step, pipeline.name, { version: version.number, items: version.items });
    }
  }

  return uses;
}

/**
 * The steps that dispatch `role`'s `action`, each with the result keys
 * it routes (EO-427).
 *
 * `actionUses`' walk, for one pair and with the routes in hand — and
 * with one difference in what counts as a second use. There, a step the
 * current graph still defines this way is said once, because the older
 * version adds nothing a person has to act on. Here it is said again
 * where that version routes the step *differently*: the items bound to
 * it are carried by its routes, so a key the live step routes and theirs
 * does not is somewhere those items can still be left with nowhere to
 * go, and the live graph's answer would hide it.
 *
 * The pair need not be defined. A step names a role and an action as
 * words, and this is asked before a definition is created as well as
 * after.
 */
export function actionRouteUses(db: Db, role: string, action: string): ActionRouteUse[] {
  const uses: ActionRouteUse[] = [];
  const add = (step: PipelineStep, routes: readonly StepRoute[], pipelineName: string, finishing?: { version: number; items: number }) => {
    if (step.type !== "agent" || step.ownerRole !== role || step.entryAction !== action) return;
    const routedKeys = [...new Set(routes.filter((route) => route.fromStepId === step.id).map((route) => route.resultKey))];
    if (finishing !== undefined) {
      const live = uses.find((use) => use.stepId === step.id && use.finishing === undefined);
      if (live !== undefined && live.routedKeys.length === routedKeys.length && routedKeys.every((key) => live.routedKeys.includes(key))) return;
    }
    uses.push({ pipelineId: step.pipelineId, pipelineName, stepId: step.id, stepName: step.name, routedKeys, ...(finishing === undefined ? {} : { finishing }) });
  };

  for (const pipeline of listPipelines(db)) {
    const routes = listRoutesForPipeline(db, pipeline.id);
    for (const step of listStepsForPipeline(db, pipeline.id)) add(step, routes, pipeline.name);
    for (const version of olderVersionsInUse(db, pipeline.id)) {
      for (const step of version.steps) add(step, version.routes, pipeline.name, { version: version.number, items: version.items });
    }
  }

  return uses;
}

/**
 * What `role`'s `action` is as things stand: the schema a provider is
 * handed for it, and the steps a change to it would reach.
 *
 * The schema is `outputSchemaFor`'s answer for this role — the very call
 * a dispatch makes — so a pack's action is shown in the pack's own
 * shape, a role's definition in the generated one, and an action
 * nothing defines as no schema at all. Asked with no item type, so an
 * action whose shape a type overrides is shown as the action's own.
 */
export function inspectRoleActionCommand(db: Db, projectId: Uuid | null, payload: IpcPayload<"roleActions:inspect">): IpcResponse<"roleActions:inspect"> {
  return {
    providerSchema: outputSchemaFor(registryForProject(db, projectId), payload.action, undefined, payload.role) ?? null,
    uses: actionRouteUses(db, payload.role, payload.action),
  };
}

/**
 * One use, as a sentence names it: `"Check" (Quality)`, or `"Check"
 * (Quality v1, 2 tickets still finishing on it)` for a step only an
 * older version still has this way.
 *
 * One function because the catalog's rendering and a delete's refusal
 * both say it, and two spellings of one fact is how they come to differ.
 * Here rather than in the core beside the schema, because the sentence
 * uses the developer pack's word for an item, as these tools do, and
 * the core has no such word.
 */
export function describeActionUse(use: ActionUse): string {
  if (use.finishing === undefined) return `"${use.stepName}" (${use.pipelineName})`;
  const { version, items } = use.finishing;
  return `"${use.stepName}" (${use.pipelineName} v${version}, ${items} ticket${items === 1 ? "" : "s"} still finishing on it)`;
}

/** The steps that dispatch `role`'s `action`. */
export function actionUsedBy(db: Db, role: string, action: string): ActionUse[] {
  return actionUses(db).get(pairKey(role, action)) ?? [];
}

/**
 * `registry:get`'s answer with each action's `usedBy` filled in.
 *
 * Done here rather than in `toRegistryView` because that function is
 * the core's and is handed a registry alone; which steps exist is the
 * database's to say.
 */
export function withActionUses(db: Db, view: RegistryView): RegistryView {
  const uses = actionUses(db);
  const used = <A extends { action: string }>(role: string, actions: readonly A[]) =>
    actions.map((entry) => ({ ...entry, usedBy: uses.get(pairKey(role, entry.action)) ?? [] }));

  return {
    ...view,
    roles: view.roles.map((role) => (role.actions === undefined ? role : { ...role, actions: used(role.slug, role.actions) })),
    ...(view.roleActions === undefined ? {} : { roleActions: view.roleActions.map((entry) => ({ ...entry, actions: used(entry.role, entry.actions) })) }),
  };
}

/**
 * Creates or edits a definition, through the shared save.
 *
 * Nothing is decided here: every rule is `readActionDefinitionDraft`'s,
 * reached through `saveActionDefinition`, so this door refuses exactly
 * what the agent screen's and an import's do.
 */
export function saveRoleActionCommand(db: Db, payload: IpcPayload<"roleActions:save">): IpcResponse<"roleActions:save"> {
  const saved = saveActionDefinition(db, payload);
  if (!saved.ok) return { saved: false, definition: null, problems: saved.problems };
  return { saved: true, definition: saved.definition, problems: [] };
}

/**
 * Removes a definition nothing dispatches.
 *
 * Refused while a step uses it, naming each pipeline and step: with the
 * definition gone that step would be dispatched with no schema, answer
 * in prose, be read as `done` and park on every other key its routes
 * name — which a person would meet as an agent that stopped working.
 */
export function deleteRoleActionCommand(db: Db, payload: IpcPayload<"roleActions:delete">): IpcResponse<"roleActions:delete"> {
  if (getActionDefinition(db, payload.role, payload.action) === undefined) {
    return {
      deleted: false,
      problem: `The ${payload.role} role defines no "${payload.action}" action. A pack's own action is not a definition and cannot be deleted.`,
      usedBy: [],
    };
  }

  const usedBy = actionUsedBy(db, payload.role, payload.action);
  if (usedBy.length > 0) {
    // Two kinds of use, cleared two different ways, so each is told its
    // own: a step of the graph as it stands is edited away, and a step
    // only an older version has cannot be — the work bound to it has to
    // finish.
    const current = usedBy.some((use) => use.finishing === undefined);
    const older = usedBy.some((use) => use.finishing !== undefined);
    const next = [
      ...(current ? ["Give each step of a current pipeline another action, or remove it."] : []),
      ...(older
        ? [
            "A ticket finishes on the pipeline version it entered on, so a step an older version defines can still be dispatched for the tickets bound to it and would then have no answer shape: that use clears when those tickets have finished or been archived, not by editing the pipeline.",
          ]
        : []),
    ];
    return {
      deleted: false,
      problem: `The ${payload.role} role's "${payload.action}" action is used by ${usedBy.map(describeActionUse).join(", ")}. ${next.join(" ")} Delete it then.`,
      usedBy,
    };
  }

  deleteActionDefinition(db, payload.role, payload.action);
  return { deleted: true, problem: null, usedBy: [] };
}
