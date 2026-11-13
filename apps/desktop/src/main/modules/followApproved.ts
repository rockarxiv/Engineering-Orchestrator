import { MODULE_ENTRY_RULE_KIND, moduleUpdateAuthor, versionLabel, type EntryRule, type Pipeline, type PipelineStep } from "@eo/core";
import type { Db } from "../db/client.js";
import { getModule, listPipelines, listRoutesForPipeline, listStepsForPipeline, newestModuleVersion, replacePipelineGraph } from "../db/repos/index.js";
import { heldByTheRecord } from "../gallery/templateUpdates.js";
import { storedGraphProblems } from "../ipc/configCommands.js";
import { resolveMessagesAbout, sendMessageHere } from "../messages/messages.js";

/**
 * Approving a module version moves every pipeline that pins an older one
 * forward (EO-771, ARCHITECTURE.md, "Modules: a step that is a script").
 *
 * Called inside the transaction that approves, so the approval and the
 * pipeline versions it files land together. For each non-trial,
 * unarchived pipeline whose current graph pins an older version of the
 * module — on a module step or a module entry rule — the graph with those
 * pins moved to the newly approved version is judged as a publish judges
 * it (`storedGraphProblems`, which runs `validatePipeline`):
 *
 * - **Moved.** It validates: it is written through `replacePipelineGraph`,
 *   which catches the live graph up first (`catchUpCurrentVersion`) and
 *   files an ordinary pipeline version, its author the module update
 *   (`moduleUpdateAuthor`) and its notes "Notify v3 → v4". Items in flight
 *   stay bound to the version they entered on, and so run the module
 *   version it pins.
 * - **Held.** It does not: the pipeline keeps its pin, and a message
 *   (`module_update_held`) to the person who must act names the pipeline,
 *   the module, both versions and the validator's words (invariant 8).
 *   The other pipelines are still moved.
 *
 * A pipeline that already pins the approved version or a newer one, or
 * does not use the module, is left alone. A desktop never files a version
 * for a pipeline it follows from its organisation's record
 * (`heldByTheRecord`): the record files it when the module is approved
 * there, and it reaches replicas like any publish.
 */

/** The `messages.source` of an update that did not fit a pipeline. */
export const MODULE_UPDATE_HELD_SOURCE = "module_update_held";

export type ModuleUpdateResult =
  | { pipelineId: string; outcome: "moved"; from: number[]; to: number; version: number }
  | { pipelineId: string; outcome: "held"; from: number[]; to: number; problems: string[] };

export interface FollowApprovedModuleOptions {
  /** Whether this installation is the organisation's record (or, for messages, decides who is told) — `!platform.hasMachine`. */
  isTheRecord: boolean;
}

export function followApprovedModule(db: Db, moduleId: string, options: FollowApprovedModuleOptions): ModuleUpdateResult[] {
  const module = getModule(db, moduleId);
  const to = newestModuleVersion(db, moduleId);
  if (module === undefined || to === null) return [];
  const results: ModuleUpdateResult[] = [];
  for (const pipeline of listPipelines(db)) {
    if (!options.isTheRecord && heldByTheRecord(db, pipeline.id)) continue;
    const moved = movedGraph(db, pipeline, moduleId, to);
    if (moved === null) continue;
    const subject = `${pipeline.id}:${moduleId}`;
    const routes = listRoutesForPipeline(db, pipeline.id);
    let problems: string[];
    try {
      problems = storedGraphProblems(
        db,
        pipeline.id,
        moved.steps.filter((step) => !step.offBoard),
        routes,
        pipeline.entryStepId,
        new Map(),
        moved.entryRules,
      )
        .filter((problem) => problem.severity === "error")
        .map((problem) => problem.message);
      if (problems.length === 0) {
        const written = replacePipelineGraph(
          db,
          pipeline.id,
          moved.steps.map(({ ownerPersonId: _person, ownerGroupId: _group, ...step }) => step),
          routes.map(({ id: _id, ...route }) => route),
          {
            entryStepId: pipeline.entryStepId,
            entryRules: moved.entryRules,
            createdBy: moduleUpdateAuthor(module.slug, to),
            releaseNotes: `${module.name} ${moved.from.map(versionLabel).join(", ")} → ${versionLabel(to)}`,
          },
        );
        if (written.replaced) {
          // An earlier version of this module that did not fit is moot now.
          resolveMessagesAbout(db, MODULE_UPDATE_HELD_SOURCE, subject);
          results.push({ pipelineId: pipeline.id, outcome: "moved", from: moved.from, to, version: written.version });
          continue;
        }
        problems = written.holding.map((hold) => `"${hold.stepName}" still holds ${hold.count} item(s).`);
      }
    } catch (error) {
      problems = [error instanceof Error ? error.message : String(error)];
    }
    // One open message per pipeline and module: a newer one says what is true now.
    resolveMessagesAbout(db, MODULE_UPDATE_HELD_SOURCE, subject);
    sendMessageHere(db, { projectId: pipeline.projectId, source: MODULE_UPDATE_HELD_SOURCE, subject, body: heldBody(pipeline.name, module.name, moved.from, to, problems) }, options.isTheRecord);
    results.push({ pipelineId: pipeline.id, outcome: "held", from: moved.from, to, problems });
  }
  return results;
}

/** The pipeline's live graph with every pin on an older version of the module moved to `to`, or null where nothing pins one. */
function movedGraph(db: Db, pipeline: Pipeline, moduleId: string, to: number): { steps: PipelineStep[]; entryRules: EntryRule[]; from: number[] } | null {
  const from = new Set<number>();
  const behind = (version: number | null | undefined): version is number => typeof version === "number" && version < to;
  const steps = listStepsForPipeline(db, pipeline.id).map((step) => {
    if (step.type !== "module" || step.entryAction !== moduleId || !behind(step.moduleVersion)) return step;
    from.add(step.moduleVersion);
    return { ...step, moduleVersion: to };
  });
  const entryRules = pipeline.entryRules.map((rule) => {
    if (rule.kind !== MODULE_ENTRY_RULE_KIND || rule.module !== moduleId || !behind(rule.moduleVersion)) return rule;
    from.add(rule.moduleVersion);
    return { ...rule, moduleVersion: to };
  });
  if (from.size === 0) return null;
  return { steps, entryRules, from: [...from].sort((a, b) => a - b) };
}

function heldBody(pipelineName: string, moduleName: string, from: readonly number[], to: number, problems: readonly string[]): string {
  const was = from.map(versionLabel).join(", ");
  return [
    `**${pipelineName}** stays on ${moduleName} ${was}. ${moduleName} ${versionLabel(to)} was approved, but moving the pipeline to it would leave a pipeline that does not validate:`,
    "",
    ...problems.map((problem) => `- ${problem}`),
    "",
    `Change ${pipelineName} so it works with ${moduleName} ${versionLabel(to)} and publish it, or change the module and approve it again.`,
  ].join("\n");
}
