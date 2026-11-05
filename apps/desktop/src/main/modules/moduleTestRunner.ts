import type { ModuleTestRun } from "@eo/core";
import type { Db } from "../db/client.js";
import { getModule, getModuleTestResult, listModuleTests, moduleTestFingerprint, storeModuleTestResult } from "../db/repos/index.js";
import type { ModuleHostLauncher } from "./runModule.js";
import { runModuleTests } from "./runModuleTests.js";

/**
 * Keeps each module's stored test result about the code and cases that
 * are saved now (EO-352).
 *
 * Saving a module's code or any of its cases makes the stored result
 * stale — derived, by comparing fingerprints on read — and asks this to
 * run the tests again in the background. A person asking for a run
 * (`moduleTests:run`) goes through the same queue and waits for it.
 *
 * One run at a time, across every module. Each case is a process of its
 * own, and a burst of saves — an agent writing five cases in a row —
 * must not become five concurrent test runs of the same module. A save
 * while that module's run is still queued joins the queued run rather
 * than adding another; the queued run reads what is saved when it
 * starts, so it covers the later save too.
 */

export interface ModuleTestRunnerOptions {
  db: Db;
  /** Null in a build with no module host: every run answers so rather than failing to register. */
  launcher: ModuleHostLauncher | null;
  /** Told after every stored result, so open windows refetch the module. */
  onStored?: (moduleId: string) => void;
  /** The module time limit a case is held to. `DEFAULT_MODULE_TIMEOUT_MS` when absent. */
  timeoutMs?: number;
}

/**
 * `fingerprint` is of the code, manifest and cases that run was taken
 * against — read when it started, not when it was asked for. Approval
 * (EO-353) compares it with what is saved once the run is back, so a
 * save that landed while the cases ran cannot be approved on the
 * strength of a run about the code before it.
 */
export type ModuleTestRunAnswer = { run: ModuleTestRun; fingerprint: string; problem: null } | { run: null; problem: string };

export interface ModuleTestRunner {
  /** Runs the module's tests now (after whatever is ahead in the queue), stores the result and answers it. */
  run(moduleId: string): Promise<ModuleTestRunAnswer>;
  /**
   * Re-runs the module's tests in the background, if what is stored is
   * not about what is saved.
   *
   * `force` runs them even when it is (EO-360): a restore puts back code
   * and cases a stored result can still match exactly — restore v1 after
   * v2 was saved but before v2's tests ran — and a restore promises a run
   * whatever is stored.
   */
  schedule(moduleId: string, options?: { force?: boolean }): void;
  /** Stops the case running now and refuses any more. */
  dispose(): void;
}

export function createModuleTestRunner(options: ModuleTestRunnerOptions): ModuleTestRunner {
  const stopping = new AbortController();
  /** Runs queued and not yet started, by module — what a second request for the same module joins. */
  const queued = new Map<string, Promise<ModuleTestRunAnswer>>();
  let tail: Promise<unknown> = Promise.resolve();

  const execute = async (moduleId: string): Promise<ModuleTestRunAnswer> => {
    if (stopping.signal.aborted) return { run: null, problem: "EO is shutting down." };
    if (options.launcher === null) return { run: null, problem: "The module host is not available in this build." };
    const module = getModule(options.db, moduleId);
    if (!module) return { run: null, problem: "That module no longer exists." };

    // Read when the run starts, and fingerprinted from exactly what is
    // handed to the host — so the stored result is about what ran, and
    // a save that lands while it runs leaves it stale, as it should.
    const tests = listModuleTests(options.db, moduleId);
    const fingerprint = moduleTestFingerprint(module, tests);
    const run = await runModuleTests(options.launcher, {
      module,
      tests,
      signal: stopping.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    if (stopping.signal.aborted) return { run: null, problem: "EO is shutting down." };

    // The module can have gone while its cases ran; its result has
    // nowhere to be kept then, and the cascade has already removed any
    // older one.
    if (!getModule(options.db, moduleId)) return { run: null, problem: "That module no longer exists." };
    storeModuleTestResult(options.db, moduleId, fingerprint, run);
    options.onStored?.(moduleId);
    return { run, fingerprint, problem: null };
  };

  const enqueue = (moduleId: string): Promise<ModuleTestRunAnswer> => {
    const waiting = queued.get(moduleId);
    if (waiting) return waiting;
    const next = tail.then(() => {
      queued.delete(moduleId);
      return execute(moduleId);
    });
    // Nothing below `execute` throws by design, but a queue that one
    // rejection could wedge for good is not worth the bet.
    const settled = next.catch((error: unknown) => ({ run: null, problem: error instanceof Error ? error.message : String(error) }) as const);
    queued.set(moduleId, settled);
    tail = settled;
    return settled;
  };

  return {
    run: (moduleId) => enqueue(moduleId),
    schedule: (moduleId, scheduling) => {
      if (stopping.signal.aborted || options.launcher === null) return;
      const module = getModule(options.db, moduleId);
      if (!module || module.archivedAt !== null) return;
      const stored = getModuleTestResult(options.db, moduleId);
      if (scheduling?.force !== true && stored && stored.fingerprint === moduleTestFingerprint(module, listModuleTests(options.db, moduleId))) return;
      void enqueue(moduleId);
    },
    dispose: () => stopping.abort(),
  };
}
