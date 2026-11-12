import { accessSync, constants, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix, win32 } from "node:path";
import {
  ENTRY_CHECK_PASS,
  ENTRY_CHECK_REFUSE,
  MODULE_ENTRY_RULE_KIND,
  describeDuration,
  entryRefusalSentence,
  qualifiedItemType,
  type CustomModule,
  type EntryDoor,
  type EntryRule,
  type Item,
} from "@eo/core";
import { moduleEntryChecks, type ModuleEntryCheck } from "@eo/engine";
import type { Db } from "../db/client.js";
import { moduleRefusalWords, runWithEntryVerdicts, unfitModuleClause, type PendingEntryCheck } from "../db/repos/entryRulesRepo.js";
import { getItemType } from "../db/repos/itemTypesRepo.js";
import { getModule } from "../db/repos/modulesRepo.js";
import { getPipeline, getStep } from "../db/repos/pipelineStepsRepo.js";
import { entryRulesForArrival } from "../db/repos/pipelineVersionsRepo.js";
import { asGitWorkspace, getWorkspace } from "../db/repos/workspacesRepo.js";
import { moduleItemView } from "../ipc/domainQueries.js";
import { readOrganisationSecretEntry, type OrganisationSecretsOptions } from "../policy/organisationSecrets.js";
import { searchDirectories } from "../process/searchPath.js";
import { runModule, type ModuleEntryContext, type ModuleHostLauncher } from "./runModule.js";
import { environmentFor, type ModuleSecretsOptions } from "./secrets.js";

/**
 * Running a pipeline's `module` entry rules (EO-736, ARCHITECTURE.md,
 * "Entry rules").
 *
 * A module rule names an approved module declared an entry check. At
 * every door where entry rules are judged, EO runs it against the item as
 * it would enter, and lets the item in only on `pass`. Everything else
 * refuses, naming the module and why: a `refuse`, a timeout, a crash, an
 * answer that is neither, a module that is missing, unapproved or no
 * longer an entry check, and a module that cannot run here. Fail closed.
 *
 * The data rules come first, and the doors only get here once they let
 * the item in, so a person is never kept waiting on a subprocess to be
 * told the description is missing.
 */

/** What this process runs entry checks with: the module host, and how a module's secrets are read. */
export interface EntryCheckOptions {
  launcher: ModuleHostLauncher;
  secrets: ModuleSecretsOptions;
  organisationSecrets?: OrganisationSecretsOptions;
  /**
   * The branch the item's pull request would target, as `open_pull_request`
   * would decide it — the developer pack's, handed in by the composition
   * root (invariant 13). Absent, `git.targetBranch` is null.
   */
  targetBranch?: (item: Item) => Promise<string | null>;
}

/**
 * Set once, where the engine is put together, as the registry is: the
 * doors are scattered through the IPC handlers, the supervisor, the jobs
 * and the record, and every one of them needs the same host. Null — a
 * process with no module host, or a test that never set one — refuses
 * every module rule, saying why.
 */
let configured: EntryCheckOptions | null = null;

export function configureEntryChecks(options: EntryCheckOptions | null): void {
  configured = options;
}

/** Whether this process can run entry checks at all. */
export function entryChecksAvailable(): boolean {
  return configured !== null;
}

/** The module host's words for a module that cannot be run here at all. */
const NO_HOST = "EO here has no module host to run it on";

/**
 * Runs a door's synchronous body until every module rule it met has a
 * verdict, and answers what its last run returned (EO-736).
 *
 * The body is run with the verdicts reached so far. A module rule it
 * meets with none refuses, as every entry refusal does, before anything
 * is written — so the body is the door's whole all-or-nothing write, and
 * running it again is safe. Each pending check is run once, in the order
 * met, and the body runs again with its verdict; a plan with several
 * stories meets them one round at a time. A door that refuses on data
 * rules first runs no module, since the data rules come before any
 * module rule is reached.
 *
 * A verdict is keyed by the arrival and by the rules and module revisions
 * it was reached under, so one whose rules or module changed while it ran
 * is not found on the next try, and the check runs again.
 *
 * `verdicts`, where given, is filled with every verdict reached, for a
 * caller that judges first and writes later (`jobEntryVerdicts`).
 */
export async function withModuleEntryChecks<T>(db: Db, door: EntryDoor, body: () => T, verdicts = new Map<string, string | null>()): Promise<T> {
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const { result, pending } = runWithEntryVerdicts(door, verdicts, body);
    const fresh = pending.filter((check) => !verdicts.has(check.fingerprint));
    if (fresh.length === 0) return result;
    for (const check of fresh) verdicts.set(check.fingerprint, await moduleEntryRefusal(db, check));
  }
  // A body that keeps meeting arrivals it has not met before is not
  // settling. It is run once more with what it has, and a check still
  // without a verdict refuses, saying it cannot run here, rather than the
  // door going round for ever or letting anything in unjudged.
  return runWithEntryVerdicts(door, verdicts, body, { final: true }).result;
}

/** More rounds than a door has items to create: a plan's stories are met one round each. */
const MAX_ROUNDS = 64;

/**
 * The sentence refusing this arrival on its module rules, or null where
 * every module it must pass answers `pass`.
 *
 * One run per module, whatever the number of rules naming it, in the
 * order the rules list them, stopping at the first refusal.
 */
export async function moduleEntryRefusal(
  db: Db,
  /** `checks`, where given, are the ones the door met; absent, they are read now. */
  arrival: Pick<PendingEntryCheck, "door" | "item" | "creating" | "fromStepId"> & { checks?: ModuleEntryCheck[] },
): Promise<string | null> {
  const { item } = arrival;
  if (item.pipelineId === null) return null;
  const type = getItemType(db, item.typeId);
  if (type === undefined) return null;
  const checks = arrival.checks ?? moduleEntryChecks(entryRulesForArrival(db, item.pipelineId, item.stepId), qualifiedItemType(type));
  if (checks.length === 0) return null;
  const pipelineName = getPipeline(db, item.pipelineId)?.name ?? "This pipeline";
  for (const check of checks) {
    const module = check.module === "" ? undefined : getModule(db, check.module);
    const why = await judge(db, check, module, arrival, pipelineName);
    if (why !== null) return entryRefusalSentence(pipelineName, [moduleRefusalWords(check.rules[0]!, module, check.module, why)]);
  }
  return null;
}

/** A sentence without its closing stop, to sit inside another. */
function clause(text: string): string {
  return text.trim().replace(/[.\s]+$/, "");
}

/**
 * Why one module keeps this arrival out, as a clause about it, or null on
 * `pass`.
 */
async function judge(db: Db, check: ModuleEntryCheck, module: CustomModule | undefined, arrival: Pick<PendingEntryCheck, "door" | "item" | "creating" | "fromStepId">, pipelineName: string): Promise<string | null> {
  const unfit = unfitModuleClause(check, module);
  if (unfit !== null || module === undefined) return unfit ?? "cannot run: it is not a module this installation has";
  const options = configured;
  if (options === null) return `cannot run here: ${NO_HOST}`;

  const missingBins = binariesNotFound(module.manifest.needs.bin);
  if (missingBins.length > 0) return `cannot run here: ${missingBins.join(", ")} ${missingBins.length === 1 ? "is" : "are"} not installed where this door is`;

  // Shared values only: the item stands on no step of this pipeline yet,
  // so no step's own override is its to read.
  const organisation = options.organisationSecrets;
  const { env, unreadable, dangling, variables } = environmentFor(
    options.secrets,
    module.manifest.needs.env,
    null,
    organisation === undefined ? undefined : (name: string) => readOrganisationSecretEntry(organisation, name),
  );
  const missing = [...unreadable, ...dangling.map(({ name }) => name), ...module.manifest.needs.env.filter((name) => !(name in env) && !unreadable.includes(name) && !dangling.some((each) => each.name === name))];
  if (missing.length > 0) return `cannot run here: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set — set ${missing.length === 1 ? "it" : "them"} under Settings → Modules`;

  const { item } = arrival;
  const workspaceRow = item.workspaceId === null ? undefined : getWorkspace(db, item.workspaceId);
  const git = asGitWorkspace(workspaceRow);
  // The repository's own checkout where there is one: an entry check only
  // reads, and the item has no worktree before it is let in.
  const cwd = git !== undefined && existsSync(git.config.repoPath) ? git.config.repoPath : tmpdir();

  let targetBranch: string | null;
  try {
    targetBranch = (await options.targetBranch?.(item)) ?? null;
  } catch {
    // Unknown is null, and the module decides what null means — the
    // fixture this story ships refuses on it.
    targetBranch = null;
  }
  const view = moduleItemView(db, item, targetBranch);
  const entering = arrival.creating ? { ...view, id: null, key: null, createdAt: null, updatedAt: null } : view;
  const fromStep = arrival.fromStepId === null ? undefined : getStep(db, arrival.fromStepId);
  const entry: ModuleEntryContext = {
    door: arrival.door,
    pipeline: { id: item.pipelineId!, name: pipelineName },
    fromStep: arrival.fromStepId === null ? null : { id: arrival.fromStepId, name: fromStep?.name ?? null },
  };
  const context = await options.launcher.items?.context({
    item,
    runId: "",
    workspace: { cwd, kind: workspaceRow?.kind ?? "none", workspaceId: workspaceRow?.id ?? null },
  });

  let outcome;
  try {
    outcome = await runModule(options.launcher, {
      module,
      item,
      cwd,
      env,
      variables,
      timeoutMs: check.timeoutMs,
      entry,
      entering: entering as typeof view,
      ...(context === undefined ? {} : { context }),
    });
  } catch (error) {
    return `failed: ${clause(error instanceof Error ? error.message : String(error))}`;
  }

  if (!outcome.ok) {
    if (outcome.timedOut === true) return `did not answer within ${describeDuration(check.timeoutMs)}`;
    return `failed: ${clause(outcome.reason)}`;
  }
  if (outcome.result === ENTRY_CHECK_PASS) return null;
  if (outcome.result === ENTRY_CHECK_REFUSE) {
    const reason = clause(outcome.reason ?? "");
    return reason === "" ? "refused it, without saying why" : `refused it: ${reason}`;
  }
  return `answered "${outcome.result}", which is neither ${ENTRY_CHECK_PASS} nor ${ENTRY_CHECK_REFUSE}`;
}

/** The binaries a manifest declares that `ctx.exec` could not start from any directory EO searches. */
function binariesNotFound(bins: readonly string[]): string[] {
  const directories = searchDirectories();
  return bins.filter((bin) => !launchable(bin, { directories }));
}

/**
 * Scripts Node will not start without a shell (CVE-2024-27980), which
 * `ctx.exec` never uses.
 */
const WINDOWS_SHELL_SCRIPTS = new Set([".bat", ".cmd"]);

export interface LaunchableOptions {
  directories: readonly string[];
  platform?: NodeJS.Platform;
  /** Whether the file at this path is one the platform would execute. */
  runnable?: (path: string) => boolean;
}

/**
 * Whether `ctx.exec(bin)` could start `bin` (EO-736): what the module
 * host's `spawn`, which has no shell, finds on its PATH and can run —
 * not merely a file of that name, which is what let a `.cmd` on Windows,
 * or a file without its execute bit, pass the record's check at save and
 * fail at the first door.
 *
 * Node's lookup, as libuv does it. On Windows a bare name is tried with
 * `.com` and `.exe`, and a name with its own extension as given too,
 * unless that extension is `.bat` or `.cmd`. Elsewhere the name itself,
 * which must be a regular file with its execute bit. A name with a
 * separator in it is not looked up but taken as written.
 */
export function launchable(bin: string, options: LaunchableOptions): boolean {
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const runnable = options.runnable ?? ((candidate: string) => runnableFile(candidate, platform));
  const named = platform === "win32" ? /[\\/]/.test(bin) : bin.includes("/");
  const bases = named ? [bin] : options.directories.map((directory) => path.join(directory, bin));
  const forms = (base: string): string[] => {
    if (platform !== "win32") return [base];
    const extension = path.extname(bin).toLowerCase();
    const asGiven = extension !== "" && !WINDOWS_SHELL_SCRIPTS.has(extension) ? [base] : [];
    return [...asGiven, `${base}.com`, `${base}.exe`];
  };
  return bases.some((base) => forms(base).some(runnable));
}

function runnableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (platform !== "win32") accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Why this installation could not run the module rules being published,
 * one sentence per module, or none (EO-736). Asked at `pipeline:save` on
 * the record, so a rule its doors could never pass is refused when it is
 * published rather than discovered by the first item at the door.
 */
export function moduleRulesUnrunnableHere(db: Db, rules: readonly EntryRule[]): string[] {
  const ids = [...new Set(rules.filter((rule) => rule.kind === MODULE_ENTRY_RULE_KIND && rule.module !== undefined).map((rule) => rule.module!))];
  return ids.flatMap((id) => {
    const module = getModule(db, id);
    if (module === undefined) return [];
    if (configured === null) return [`The entry rule runs "${module.name}", which this record cannot run: ${NO_HOST}.`];
    const missing = binariesNotFound(module.manifest.needs.bin);
    return missing.length === 0 ? [] : [`The entry rule runs "${module.name}", which this record cannot run: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not installed here.`];
  });
}
