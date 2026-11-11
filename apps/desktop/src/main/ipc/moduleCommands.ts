import { entryCheckManifestProblems, MODULE_COVERAGE_BAR, moduleMachineSpecificWarnings, portabilityWarnings, type CustomModule, type IpcPayload, type IpcResponse, type ModuleView } from "@eo/core";
import type { Db } from "../db/client.js";
import {
  addModuleTests,
  approveModule,
  archiveModule,
  getModule,
  getModuleTestResult,
  getModuleVersion,
  listModules,
  listModuleVersions,
  listModuleTestResults,
  listModuleTests,
  listPipelineSteps,
  moduleTestFingerprint,
  restoreModuleVersion,
  saveModule,
  type StoredModuleTestRun,
} from "../db/repos/index.js";
import type { ModuleTestRunner } from "../modules/moduleTestRunner.js";

/**
 * The module catalog, over IPC (KAN-103).
 *
 * Nothing here runs a module — that is the host (KAN-105). This is the
 * record and the screen that edits it, deliberately landed first so the
 * shape of a module is settled while it is still cheap to change.
 */

/**
 * How many steps run this module, across every pipeline.
 *
 * Derived rather than stored, like `AgentDetail.pipelineCount`: a count
 * kept in a column is a second thing to keep true, and it would be wrong
 * the first time a pipeline was saved without going through here.
 *
 * It is what makes archiving answerable — "this is used by three steps"
 * is the one fact a person needs before removing something reusable.
 */
function usageByModuleId(db: Db): Map<string, number> {
  const usage = new Map<string, number>();
  for (const step of listPipelineSteps(db)) {
    if (step.type !== "module" || step.entryAction === null) continue;
    usage.set(step.entryAction, (usage.get(step.entryAction) ?? 0) + 1);
  }
  return usage;
}

/**
 * The latest test run and whether it is still about this code (EO-352).
 *
 * Stale is a comparison, not a column: the run carries the fingerprint
 * of what it was taken against, and this is what is saved now. Nothing
 * has to remember to mark a result stale, so nothing can forget to.
 */
function testState(db: Db, module: CustomModule, stored: StoredModuleTestRun | undefined): TestState {
  const tests = listModuleTests(db, module.id);
  // How many cases there are now (EO-354), beside the run: a module with
  // none and a module whose cases have not run yet both have no run, and
  // only the first is "no tests".
  if (stored === undefined) return { testRun: null, testsStale: false, testCount: tests.length, cases: tests };
  return { testRun: stored.run, testsStale: stored.fingerprint !== moduleTestFingerprint(module, tests), testCount: tests.length, cases: tests };
}

/** What `toView` needs to know about a module's tests: the view's fields, and the cases themselves to scan (EO-449). */
type TestState = Pick<ModuleView, "testRun" | "testsStale" | "testCount"> & { cases: readonly { description: string; source: string }[] };

function toView(module: CustomModule, usedByStepCount: number, { cases, ...tests }: TestState): ModuleView {
  return {
    id: module.id,
    slug: module.slug,
    name: module.name,
    description: module.description,
    code: module.code,
    manifest: module.manifest,
    originalScript: module.originalScript,
    source: module.source,
    approvedAt: module.approvedAt,
    createdAt: module.createdAt,
    updatedAt: module.updatedAt,
    archivedAt: module.archivedAt,
    usedByStepCount,
    // Read off the code on every list, never stored (EO-80). Advice for
    // whoever is writing or approving this module, not a gate: what it
    // may actually import is decided exactly, by a loader hook, at the
    // moment it asks. Attached to the view rather than to the save so
    // the two screens that approve a module — Settings and the
    // architect's card — say the same thing without either having to
    // ask for it.
    portability: portabilityWarnings(module.code),
    // The same arrangement, for values that only hold on one machine
    // (EO-449): read off the code, the manifest and every test case on
    // each read, so it is never about a version that is gone. Advice
    // again — nothing that saves, approves or runs a module reads it.
    machineSpecific: moduleMachineSpecificWarnings({ code: module.code, manifest: module.manifest, tests: cases }),
    ...tests,
  };
}

export function listModuleViews(db: Db, input: IpcPayload<"modules:list">): IpcResponse<"modules:list"> {
  const usage = usageByModuleId(db);
  const results = listModuleTestResults(db);
  return {
    modules: listModules(db, input.includeArchived ?? false).map((module) => toView(module, usage.get(module.id) ?? 0, testState(db, module, results.get(module.id)))),
  };
}

/**
 * Saves a module, and the test cases it arrived with when it carries any
 * (EO-355).
 *
 * One transaction for both, so a module is never saved without the
 * cases it was sent with: a case that cannot be written rolls the
 * module back too, and the caller is told why rather than handed a
 * module that will refuse approval for a reason it was not shown.
 */
export function saveModuleCommand(db: Db, input: IpcPayload<"modules:save">): IpcResponse<"modules:save"> {
  type Saved = Extract<ReturnType<typeof saveModule>, { ok: true }>;
  let result: Saved | { ok: false; reason: string };
  // Read before the write, so the answer can say whether this save is
  // what took the approval away (EO-498).
  const wasApproved = input.id !== undefined && (getModule(db, input.id)?.approvedAt ?? null) !== null;
  try {
    result = db.transaction(() => {
      const saved = saveModule(db, {
        ...(input.id === undefined ? {} : { id: input.id }),
        slug: input.slug,
        name: input.name,
        description: input.description,
        code: input.code,
        manifest: input.manifest,
        originalScript: input.originalScript,
        source: input.source,
      });
      if (!saved.ok || input.tests === undefined) return saved;
      for (const added of addModuleTests(db, saved.module.id, input.tests)) {
        // Thrown so the transaction rolls the module back with it.
        if (!added.ok) throw new TestCaseRefused(added.reason);
      }
      return saved;
    });
  } catch (error) {
    if (!(error instanceof TestCaseRefused)) throw error;
    result = { ok: false, reason: `A test case could not be saved with the module, so neither was: ${error.message}` };
  }
  if (!result.ok) return { saved: false, module: null, problem: result.reason, approvalWithdrawn: false };

  // As it stands after the cases are written: adding one to an approved
  // module withdraws its approval even where the code did not move.
  const module = getModule(db, result.module.id) ?? result.module;
  const usage = usageByModuleId(db);
  return {
    saved: true,
    module: toView(module, usage.get(module.id) ?? 0, testState(db, module, getModuleTestResult(db, module.id))),
    problem: null,
    approvalWithdrawn: wasApproved && module.approvedAt === null,
  };
}

/** A case the module arrived with could not be written; carries why, out of the transaction. */
class TestCaseRefused extends Error {}

/** A refusal that rests on no run, or on one whose coverage is beside the point. */
function refused(problem: string, lineCoverage: number | null = null): IpcResponse<"modules:approve"> {
  return { approved: false, problem, lineCoverage, coverageAcknowledgementNeeded: false, machineSpecific: [] };
}

function noTests(module: CustomModule): IpcResponse<"modules:approve"> {
  return refused(`"${module.name}" has no tests, so it cannot be approved. Add at least one test case — every case has to pass before it can be approved.`);
}

/** A save landed between the tests starting and the approval being written: that run is about code no longer there. */
function changedWhileTesting(module: CustomModule): IpcResponse<"modules:approve"> {
  return refused(`"${module.name}" changed while its tests were running, so that run is not about what is saved now. Approve it again to test what is saved.`);
}

/**
 * Records that a person accepted this module (KAN-106) — once its tests
 * have run and passed, at this moment (EO-353).
 *
 * The tests are run here rather than read from the stored result,
 * because a stored result is a claim about code as it was, and this is
 * the moment the claim is relied on (invariant #5). The rule:
 *
 * - at least one test case, or there is nothing to have passed;
 * - every case passes, and a refusal names each one that did not;
 * - line coverage under `MODULE_COVERAGE_BAR` is a question rather than
 *   a refusal: answered with the figure and
 *   `coverageAcknowledgementNeeded`, and approved when the caller asks
 *   again with `acknowledgeLowCoverage`.
 *
 * Every module is held to it, whoever wrote it. The exemption a
 * hand-written module had under the dry run is gone: having typed code
 * is not the same as having tested it.
 *
 * Enforced here rather than in a button's `disabled`, because a gate
 * enforced only in the renderer is a gate enforced nowhere — and Settings,
 * the approval card and `module_approve` all arrive here.
 */
export async function approveModuleCommand(
  db: Db,
  runner: Pick<ModuleTestRunner, "run">,
  input: IpcPayload<"modules:approve">,
): Promise<IpcResponse<"modules:approve">> {
  const judged = await judgeModuleForApproval(db, runner, input.id, input.acknowledgeLowCoverage);
  if (!judged.ready) return judged.answer;

  // Checked again where it is written, with no await between the two
  // (EO-581): returning from the judgement is itself an asynchronous
  // boundary, and a save landing in it would otherwise be approved on
  // the strength of tests that ran against the code before it.
  const approved = db.transaction(() => {
    if (!stillAsJudged(db, judged)) return false;
    approveModule(db, judged.module.id);
    return true;
  });
  if (!approved) return changedWhileTesting(judged.module);

  // Approved whatever the scan says (EO-449): what it finds rides along
  // with the answer as advice, read off exactly what was approved.
  const machineSpecific = moduleMachineSpecificWarnings({ code: judged.module.code, manifest: judged.module.manifest, tests: listModuleTests(db, judged.module.id) });
  return { approved: true, problem: null, lineCoverage: judged.lineCoverage, coverageAcknowledgementNeeded: false, machineSpecific };
}

/**
 * What running a module's tests for approval came to, before anything is
 * written (EO-581): ready to approve, with the fingerprint of what ran,
 * or the answer `modules:approve` refuses with.
 */
export type ModuleApprovalJudgement =
  | { ready: true; module: CustomModule; fingerprint: string; lineCoverage: number }
  | { ready: false; answer: IpcResponse<"modules:approve"> };

/**
 * `approveModuleCommand`'s rule, without the approval (EO-581): runs the
 * module's tests now and judges the run — at least one case, every case
 * passing, coverage at the bar or acknowledged, and the run about what is
 * saved.
 *
 * Split out so the draft card's Approve and publish holds every module it
 * approves to exactly this rule, through the same runner, and can then
 * approve them all and publish the pipeline in one transaction — which
 * an awaited test run cannot sit inside. Whoever approves on the strength
 * of a judgement checks `stillAsJudged` in the same transaction as the
 * write, since a save may land between the two.
 */
export async function judgeModuleForApproval(
  db: Db,
  runner: Pick<ModuleTestRunner, "run">,
  id: string,
  acknowledgeLowCoverage: boolean,
): Promise<ModuleApprovalJudgement> {
  const no = (answer: IpcResponse<"modules:approve">): ModuleApprovalJudgement => ({ ready: false, answer });
  const module = getModule(db, id);
  if (!module) return no(refused("That module no longer exists."));
  if (module.archivedAt !== null) return no(refused("That module has been deleted."));
  // An entry check only reads (EO-736): one whose manifest says it also
  // creates, comments, attaches or reaches outside EO is refused before
  // its tests run, which could not make it any less so.
  const reaching = entryCheckManifestProblems(module.manifest);
  if (reaching.length > 0) return no(refused(`"${module.name}" was not approved: ${reaching.join(" ")} Remove ${reaching.length === 1 ? "it" : "them"} from its manifest, or stop declaring it an entry check.`));
  // Before queueing a run that could only say the same thing.
  if (listModuleTests(db, module.id).length === 0) return no(noTests(module));

  const answer = await runner.run(module.id);
  if (answer.run === null) return no(refused(`"${module.name}" was not approved: its tests did not run. ${answer.problem}`));

  // What ran has to be what is approved. The run read the module and its
  // cases when it started; a save that landed while they ran leaves this
  // run about code that is no longer there.
  const now = getModule(db, module.id);
  if (!now) return no(refused("That module no longer exists."));
  if (now.archivedAt !== null) return no(refused("That module has been deleted."));
  if (answer.fingerprint !== moduleTestFingerprint(now, listModuleTests(db, now.id))) return no(changedWhileTesting(now));

  const { run } = answer;
  if (run.cases.length === 0) return no(noTests(now));

  const lineCoverage = run.coverage.lines.percent;
  const failing = run.cases.filter((each) => !each.passed);
  if (failing.length > 0) {
    const named = failing.map((each) => `- ${each.description}${each.failure === null ? "" : `: ${each.failure}`}`).join("\n");
    return no(
      refused(
        `"${now.name}" was not approved: ${failing.length} of ${run.cases.length} test case${run.cases.length === 1 ? "" : "s"} failed.\n${named}`,
        lineCoverage,
      ),
    );
  }

  if (lineCoverage < MODULE_COVERAGE_BAR && !acknowledgeLowCoverage) {
    return no({
      approved: false,
      problem: `Every test case passed, but line coverage of "${now.name}" is ${lineCoverage}% — under the ${MODULE_COVERAGE_BAR}% bar. Approving it anyway needs that figure confirmed.`,
      lineCoverage,
      coverageAcknowledgementNeeded: true,
      machineSpecific: [],
    });
  }

  return { ready: true, module: now, fingerprint: answer.fingerprint, lineCoverage };
}

/**
 * Is the module still exactly what was judged (EO-581)? Asked inside the
 * transaction that approves it, so a save, a new case or a deletion that
 * landed after its tests ran is not approved on the strength of them.
 */
export function stillAsJudged(db: Db, judged: Extract<ModuleApprovalJudgement, { ready: true }>): boolean {
  const now = getModule(db, judged.module.id);
  return now !== undefined && now.archivedAt === null && moduleTestFingerprint(now, listModuleTests(db, now.id)) === judged.fingerprint;
}

/**
 * Archives a module, unless a step still runs it.
 *
 * Refused rather than cascaded, for the reason `validatePipeline` refuses
 * to remove a step items are sitting on: archiving one out from under a
 * step would leave a pipeline that validates today and parks every item
 * tomorrow, with nothing anywhere having said so. The count comes back
 * either way so the screen can name what is in the way.
 */
export function archiveModuleCommand(db: Db, input: IpcPayload<"modules:archive">): IpcResponse<"modules:archive"> {
  const module = getModule(db, input.id);
  if (!module) return { archived: false, usedByStepCount: 0 };

  const usedByStepCount = usageByModuleId(db).get(input.id) ?? 0;
  if (usedByStepCount > 0) return { archived: false, usedByStepCount };

  archiveModule(db, input.id);
  return { archived: true, usedByStepCount: 0 };
}

// ── A module's versions (EO-360) ──────────────────────────────────

export function listModuleVersionsCommand(db: Db, input: IpcPayload<"moduleVersions:list">): IpcResponse<"moduleVersions:list"> {
  if (!getModule(db, input.moduleId)) return { versions: [], problem: "That module no longer exists." };
  return { versions: listModuleVersions(db, input.moduleId), problem: null };
}

export function getModuleVersionCommand(db: Db, input: IpcPayload<"moduleVersions:get">): IpcResponse<"moduleVersions:get"> {
  const module = getModule(db, input.moduleId);
  if (!module) return { version: null, problem: "That module no longer exists." };
  const version = getModuleVersion(db, input.moduleId, input.number);
  if (!version) return { version: null, problem: `"${module.name}" has no v${input.number} — it was never filed, or has since been deleted.` };
  return { version, problem: null };
}

/**
 * Restores an older version as a new current one (EO-360), and re-runs
 * its tests in the background, as after any save.
 *
 * Forced, rather than left to `schedule`'s "is the stored result still
 * about this?": a restore puts back code and cases that an older stored
 * result can match exactly, and the promise is that the tests run after
 * every restore. Scheduled here rather than by the handler, so every
 * caller of this command gets the run and a test of it tests the run.
 */
export function restoreModuleVersionCommand(
  db: Db,
  runner: Pick<ModuleTestRunner, "schedule">,
  input: IpcPayload<"moduleVersions:restore">,
): IpcResponse<"moduleVersions:restore"> {
  const result = restoreModuleVersion(db, input.moduleId, input.number);
  if (!result.ok) return { restored: false, module: null, version: null, problem: result.reason };
  runner.schedule(input.moduleId, { force: true });
  const module = getModule(db, input.moduleId)!;
  const usage = usageByModuleId(db);
  return {
    restored: true,
    module: toView(module, usage.get(module.id) ?? 0, testState(db, module, getModuleTestResult(db, module.id))),
    version: result.number,
    problem: null,
  };
}
