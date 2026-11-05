import {
  DEFAULT_JOB_RUNS_ON,
  NONE_KIND,
  SCRATCH_KIND,
  isBoundAgent,
  isDeliverableMcpServer,
  isManagedServer,
  placementReason,
  staffingAgents,
  stepWorkspaceChoice,
  type Job,
  type JobPlacement,
  type JobRunsOn,
  type PlacementReason,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { getModule } from "../db/repos/modulesRepo.js";
import { listAgents, listStepsForPipeline, projectWorkspaceList, workspaceLabel } from "../db/repos/index.js";
import { getWorkspace } from "../db/repos/workspacesRepo.js";
import { resolveAgentAttachments } from "../db/repos/agentAttachmentsRepo.js";
import { readPolicy } from "../policy/policy.js";
import { listSecretNames, type ModuleSecretsOptions } from "../modules/secrets.js";

/**
 * What a job's pipeline needs, and therefore where it may run (EO-330,
 * `ARCHITECTURE.md`, "Where a job runs").
 *
 * The gathering half. `packages/core/src/placement.ts` decides what the
 * facts mean and composes every sentence; this walks the pipeline and
 * finds them, because finding them means reading a database, a
 * keychain's index and — for a personal login — the answer a CLI gave
 * when EO last asked it. None of that belongs in a pure package, and
 * all of it is the reason placement is computed in the main process and
 * handed to the screen rather than worked out by it.
 *
 * ## What is walked
 *
 * Every step of the job's pipeline, and for each of them the four
 * things the design names: who acts there, what it reads, where it works and
 * what it is served. A step that names none of them contributes no
 * reason, which is the ordinary case — most steps are a role and a
 * prompt.
 *
 * The agent for an `agent` step is found the way dispatch finds it —
 * `ownerRole`, dispatchable, bound — so that placement describes the
 * run that would actually happen rather than the row somebody might
 * have meant. A role nothing staffs contributes nothing: an unstaffed
 * step is already refused at dispatch with its own sentence, and a
 * second one here wearing placement's name would send a person to the
 * wrong screen.
 *
 * ## Why this is not the import preflight
 *
 * It answers the same shape of question — "what would this need here" —
 * and the story says as much. It is not the same function because
 * `preflightImport` reads a *document*: a pack somebody is about to
 * install, whose modules and roles exist only in the JSON in front of
 * it. This reads a pipeline that is installed and running, whose agents
 * are rows and whose secrets are on this disk. Folding the two together
 * would make the interesting half of each one a flag, which is the
 * argument `modules/secrets.ts` makes for the three secret stores.
 */

/**
 * The one fact placement cannot read out of the database.
 *
 * Whether a backend is signed in with a personal login or with a key is
 * something only the CLI knows, and EO learns it by spawning one
 * (`runtimes/auth.ts`). A seam rather than a direct call so that the
 * whole of the decision is testable without a binary under it — and so
 * that a caller which already has the answers (the IPC handler asks for
 * every backend at once) does not make this function probe again.
 */
export type BackendAuthKind = "subscription" | "api_key" | "unknown";

export interface PlacementFacts {
  /**
   * How this machine is signed in to a backend.
   *
   * `unknown` is not a reason and never becomes one. It is
   * `RuntimeAuthSchema`'s own rule — "a probe that could not run must
   * not be allowed to block work on a machine that is perfectly well
   * signed in" — applied to a control instead of to a dispatch: greying
   * an option on the strength of a question EO could not ask would be
   * inventing the answer, and the person would have no way to tell.
   */
  authKind: (provider: string) => BackendAuthKind;
  /** What the backend is called where a person reads it — "Claude", "Codex". */
  backendLabel?: (provider: string) => string;
  /** Where this machine's personal module secrets live, for their names. */
  secrets?: ModuleSecretsOptions;
}

/**
 * Where this job may run, and everything standing in the way of the
 * place it may not.
 *
 * A job with no pipeline — a `from-discussion` one — is placeable
 * anywhere as far as this is concerned, because its work is whatever
 * the approval resolved and there is no graph here to read. It never
 * reaches a control either: the Jobs screen does not keep such a job
 * (`keptByAPerson`).
 */
export function placementForJob(db: Db, job: Job, facts: PlacementFacts): JobPlacement {
  const machineBound: PlacementReason[] = [];
  const serverBound: PlacementReason[] = [];
  const placement = { runsOn: job.runsOn ?? DEFAULT_JOB_RUNS_ON, machineBound, serverBound };
  if (job.pipelineId === null) return placement;

  const policy = readPolicy(db);
  const organisationSecrets = new Set(policy.secretNames);
  // Read once for the walk rather than per step: a pipeline of eight
  // steps sharing one implementer would otherwise list the agents eight
  // times to answer the same question.
  const agents = listAgents(db);
  const personalSecrets = facts.secrets === undefined ? new Set<string>() : new Set(listSecretNames(facts.secrets));
  const inherited = job.projectId === null ? [] : projectWorkspaceList(db, job.projectId as Uuid);

  for (const step of listStepsForPipeline(db, job.pipelineId as Uuid)) {
    const stepName = step.name;

    if (step.type === "agent" && step.ownerRole !== null) {
      // The same predicate dispatch uses, so that placement describes
      // the run that would happen. A role nobody staffs is silent here
      // — see the header.
      // Since EO-474 that includes the project: the job files onto its
      // project, so another project's agent never runs it and the
      // project's own outranks a global one.
      const agent = staffingAgents(agents, step.ownerRole, { previewAt: null, projectId: job.projectId as Uuid | null }).find(isBoundAgent);
      if (agent !== undefined) {
        if (facts.authKind(agent.provider) === "subscription") {
          machineBound.push(
            placementReason({
              kind: "personal-login",
              subject: agent.name,
              stepName,
              detail: facts.backendLabel?.(agent.provider) ?? agent.provider,
            }),
          );
        }
        for (const server of resolveAgentAttachments(db, agent.id).servers) {
          // Switched off or archived here is not "the organisation's
          // only" — it is a server this machine is not serving and the
          // organisation still is, which is exactly the state the original design
          // leaves to the device ("whether a server is switched on here
          // is this machine's business"). So a published row this
          // machine would not deliver is a server-bound reason, and a
          // row nobody published is a machine-bound one whatever its
          // switches say: the organisation server has never heard of it.
          if (isManagedServer(policy, server.id)) {
            if (!isDeliverableMcpServer(server)) {
              serverBound.push(placementReason({ kind: "organisation-mcp-server", subject: server.name, stepName }));
            }
            continue;
          }
          machineBound.push(placementReason({ kind: "local-mcp-server", subject: server.name, stepName }));
        }
      }
    }

    // A module step names its module in `entryAction`, and what
    // the module *reads* is the names its manifest declares. The two
    // namespaces are distinct (EO-328) and they point in opposite
    // directions, so a name is checked against the organisation's list
    // first: a personal value of the same name shadows nothing, and the
    // organisation's is the one a run would be handed.
    if (step.type === "module" && step.entryAction !== null) {
      const module = getModule(db, step.entryAction);
      for (const name of module?.manifest.needs.env ?? []) {
        if (organisationSecrets.has(name)) {
          serverBound.push(placementReason({ kind: "organisation-secret", subject: name, stepName }));
          continue;
        }
        if (personalSecrets.has(name)) {
          machineBound.push(placementReason({ kind: "personal-secret", subject: name, stepName }));
        }
      }
    }

    const workspace = workspaceForStep(db, step, inherited);
    if (workspace !== null) {
      machineBound.push(
        placementReason({ kind: "local-workspace", subject: workspace.label, stepName, detail: workspace.path }),
      );
    }
  }

  return placement;
}

/**
 * The disk a step would work on, where that disk is this machine's.
 *
 * Two kinds answer "no machine needed" and everything else is a path
 * here. `none` is the sentinel a step sets to say "no disk" out loud,
 * and `scratch` is a temporary directory EO makes for the run — a host
 * with a filesystem has one, so it binds the work to nothing. A
 * repository and a folder are both an absolute path on somebody's
 * laptop, and a kind a pack contributed is treated as one too: a
 * workspace is disk (`ARCHITECTURE.md`, "Workspace kinds"), and for a guard that
 * must never let a job quietly fail, "I do not recognise this kind" has
 * to mean the machine rather than the server.
 *
 * The path travels where there is one, because it is the thing that
 * makes the reason obvious on sight — "/Users/anna/reports" is an
 * explanation and "a folder" is not.
 */
function workspaceForStep(
  db: Db,
  step: { workspaceId: string | null },
  inherited: readonly { id: Uuid; kind: string }[],
): { label: string; path: string | null } | null {
  const choice = stepWorkspaceChoice(step.workspaceId);
  if (choice.pick === "none") return null;
  const id = choice.pick === "workspace" ? (choice.workspaceId as Uuid) : (inherited[0]?.id ?? null);
  if (id === null) return null;
  const workspace = getWorkspace(db, id);
  if (workspace === undefined) return null;
  if (workspace.kind === NONE_KIND || workspace.kind === SCRATCH_KIND) return null;
  const label = workspaceLabel(workspace);
  const path = pathOf(workspace.config);
  return { label, path: path === label ? null : path };
}

/**
 * The absolute path in a workspace's configuration, where its kind
 * carries one.
 *
 * Read off the parsed configuration by name rather than by kind, so
 * that a kind EO does not ship still names its folder if it happens to
 * describe one the same way. Nothing is invented: a configuration with
 * neither key contributes no path, and the reason reads without one.
 */
function pathOf(config: unknown): string | null {
  if (typeof config !== "object" || config === null) return null;
  const record = config as Record<string, unknown>;
  const candidate = record["repoPath"] ?? record["path"];
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate : null;
}

/** The place a job asks for, defaulted for a row written before 0101. */
export function runsOnOf(job: Pick<Job, "runsOn">): JobRunsOn {
  return job.runsOn ?? DEFAULT_JOB_RUNS_ON;
}
