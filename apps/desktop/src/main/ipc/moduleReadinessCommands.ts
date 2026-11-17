import type { IpcPayload, IpcResponse, ModuleManifest, ModuleReadinessStep, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getItem, getModule, listPipelines, listStepsForPipeline } from "../db/repos/index.js";
import { searchDirectories } from "../process/searchPath.js";
import { dependsOnRunDirectory, moduleReadiness, type LaunchableOptions } from "../modules/readiness.js";
import type { ModuleSecretsOptions } from "../modules/secrets.js";
import { readOrganisationSecretEntry, type OrganisationSecretsOptions } from "../policy/organisationSecrets.js";
import { assistModuleChangeFor } from "../roles/assist.js";
import { ASSIST_STEP, SCENARIO_STEP } from "../roles/conversationSteps.js";
import { scenarioChangeFor, scenarioModuleIdOf } from "../roles/scenario.js";

/**
 * Whether a module could run on this device, for the cards it is
 * proposed, changed and drafted on (EO-817).
 *
 * The check is `moduleReadiness` — the one every door that launches
 * module code runs first (EO-816) — so a card and the run after it read
 * the same PATH and the same resolution of every value. Nothing here
 * installs anything or runs anything of the module's, and no value is
 * in the answer: names, statuses and the device's own name.
 *
 * What a card cannot know is said as unknown rather than guessed: a CLI
 * named by a relative path is found from the directory a run is spawned
 * in, and outside a run there is none.
 */
export interface ModuleReadinessDeps {
  secrets: ModuleSecretsOptions;
  organisation?: OrganisationSecretsOptions | undefined;
  /** What this machine calls itself. */
  device: () => string;
  /** For tests: the directories searched, the OS, and what counts as a runnable file. */
  binaries?: Partial<LaunchableOptions>;
}

/** Every published, live step that runs this module, named as a person finds it. */
function stepsRunning(db: Db, moduleId: string): ModuleReadinessStep[] {
  return listPipelines(db).flatMap((pipeline) =>
    listStepsForPipeline(db, pipeline.id)
      .filter((step) => step.type === "module" && step.entryAction === moduleId)
      .map((step) => ({ stepId: step.id, name: step.name, pipelineName: pipeline.name })),
  );
}

/** The manifest an unapplied change on this message proposes for this module, or a sentence saying why there is none. */
function proposedManifest(db: Db, moduleId: string, saved: ModuleManifest, at: { conversationId: string; messageId: string }): ModuleManifest | string {
  const conversation = getItem(db, at.conversationId as Uuid);
  const notAChange = "That message does not propose a change to this module.";
  if (!conversation) return notAChange;
  if (conversation.stepId === ASSIST_STEP) {
    const change = assistModuleChangeFor(db, conversation, at.messageId);
    if (change === null || change.moduleId !== moduleId) return notAChange;
    return change.manifest ?? saved;
  }
  if (conversation.stepId === SCENARIO_STEP) {
    if (scenarioModuleIdOf(conversation) !== moduleId) return notAChange;
    const change = scenarioChangeFor(db, conversation, at.messageId);
    if (change === null) return notAChange;
    return change.manifest ?? saved;
  }
  return notAChange;
}

export function moduleReadinessCommand(db: Db, deps: ModuleReadinessDeps, input: IpcPayload<"modules:readiness">): IpcResponse<"modules:readiness"> {
  const module = getModule(db, input.moduleId);
  if (!module) return { check: null, problem: "That module no longer exists." };
  if (module.archivedAt !== null) return { check: null, problem: `${module.name} has been deleted.` };

  const manifest = input.change ? proposedManifest(db, module.id, module.manifest, input.change) : module.manifest;
  if (typeof manifest === "string") return { check: null, problem: manifest };

  const steps = stepsRunning(db, module.id);
  const stepId = input.stepId ?? null;
  const step = stepId === null ? null : steps.find((candidate) => candidate.stepId === stepId);
  if (step === undefined) return { check: null, problem: "That step does not run this module, or is no longer published." };

  const platform = deps.binaries?.platform ?? process.platform;
  const known = manifest.needs.bin.filter((bin) => !dependsOnRunDirectory(bin, platform));
  const unknownBins = manifest.needs.bin.filter((bin) => dependsOnRunDirectory(bin, platform));
  const directories = deps.binaries?.directories ?? searchDirectories();
  const organisation = deps.organisation;
  const readiness = moduleReadiness(
    { needs: { ...manifest.needs, bin: known } },
    {
      secrets: deps.secrets,
      // A published step's own scope; a card never stands for a trial item, so never a redirected one.
      step: step === null ? null : step.stepId,
      organisation: organisation === undefined ? undefined : (name: string) => readOrganisationSecretEntry(organisation, name),
      binaries: { ...deps.binaries, directories },
    },
  );

  const saved = module.manifest.needs;
  return {
    check: {
      device: deps.device(),
      platform,
      scope: step === null ? { kind: "shared" } : { kind: "step", step },
      // Not ready while anything is unknown: nothing has shown it is there.
      readiness: { ...readiness, ready: readiness.ready && unknownBins.length === 0 },
      unknownBins,
      introduced: input.change
        ? { bin: manifest.needs.bin.filter((bin) => !saved.bin.includes(bin)), env: manifest.needs.env.filter((name) => !saved.env.includes(name)) }
        : { bin: [], env: [] },
      searched: [...directories],
      steps,
    },
    problem: null,
  };
}
