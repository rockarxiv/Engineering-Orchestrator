import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODULE_TIMEOUT_MS, describeDuration } from "@eo/core";
import type { CustomModule, ModuleTestCaseResult, ModuleTestRun } from "@eo/core";
import { MAX_ATTACH_PATHS, MAX_COMMENTS_PER_RUN, MAX_CREATIONS_PER_RUN, MAX_COMMENT_CHARS, MAX_OPTIONS, MAX_OPTION_CHARS, systemRootEnv, type ModuleHostLauncher } from "./runModule.js";
import { moduleCoverage, type V8CoverageRange, type V8FunctionCoverage } from "./testCoverage.js";

/**
 * Running a module's test cases, from the outside (EO-352).
 *
 * One host per case, in the module host's test mode: the harness, the
 * faked time and the refusals all live in `moduleHost.mjs`, whose header
 * documents them. This side owns what a case cannot be trusted to do
 * for itself — making and removing its temporary directory, stopping it
 * when it never yields, and folding every case's coverage into one
 * figure.
 *
 * A process per case rather than one for all of them, because a case
 * that spins without yielding can only be stopped by killing its
 * process, and the cases after it still have to run. It also means no
 * case can leave anything behind for the next: not a global it patched,
 * not a file, not a timer.
 */

/** How much of one case's output is kept. The tail is where a failure explains itself. */
const MAX_CASE_OUTPUT_CHARS = 20_000;

/** Caps on what this side holds from one case's channels, as `runModule` caps its own. */
const MAX_CHANNEL_CHARS = 5_000_000;

/** Longest a Node timer can be set for. Longer fires at once, which would kill every case. */
const MAX_TIMER_MS = 2_147_483_647;

export interface ModuleTestCaseInput {
  id: string;
  description: string;
  source: string;
}

export interface RunModuleTestsRequest {
  module: Pick<CustomModule, "code" | "manifest">;
  /** In the order they should run. */
  tests: readonly ModuleTestCaseInput[];
  /**
   * The module's time limit: what `ctx.timeoutMs` reads by default, and
   * how long a case may take in real time before it is stopped. A case
   * shortens its own run's limit with the `timeoutMs` fixture.
   * Defaults to `DEFAULT_MODULE_TIMEOUT_MS`, what a step that sets none
   * gives the module.
   */
  timeoutMs?: number;
  /** Aborted when EO shuts down. Stops the case running and the rest are not started. */
  signal?: AbortSignal;
}

/** What the host signed for one case. */
interface CaseReport {
  passed: boolean;
  failure: string | null;
  coverage: unknown;
}

/** The part of a case's coverage this side reads, checked rather than cast: it crossed a process boundary. */
function asCoverage(value: unknown): V8FunctionCoverage[] | null {
  if (!Array.isArray(value)) return null;
  const functions: V8FunctionCoverage[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") return null;
    const { functionName, ranges, isBlockCoverage } = entry as Record<string, unknown>;
    if (!Array.isArray(ranges)) return null;
    const checked: V8CoverageRange[] = [];
    for (const range of ranges) {
      if (range === null || typeof range !== "object") return null;
      const { startOffset, endOffset, count } = range as Record<string, unknown>;
      if (typeof startOffset !== "number" || typeof endOffset !== "number" || typeof count !== "number") return null;
      checked.push({ startOffset, endOffset, count });
    }
    functions.push({ functionName: typeof functionName === "string" ? functionName : "", ranges: checked, isBlockCoverage: isBlockCoverage === true });
  }
  return functions;
}

/** The sentence a case stopped at its limit is reported with — the host says the same when it gets there first. */
function limitFailure(ms: number): string {
  return `This case did not finish within the module's time limit of ${describeDuration(ms)}, so EO stopped it.`;
}

/**
 * One case in one host, and what became of it.
 *
 * Always resolves. A case that throws, hangs, crashes its host or never
 * starts is a failed case with a reason, and the run goes on to the next.
 */
function runCase(
  launcher: ModuleHostLauncher,
  request: RunModuleTestsRequest,
  test: ModuleTestCaseInput,
): Promise<{ result: ModuleTestCaseResult; coverage: V8FunctionCoverage[] | null }> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_MODULE_TIMEOUT_MS;
  const nonce = randomUUID();
  const started = Date.now();
  // Real-pathed, so the directory the host is told it may write in is
  // the one `process.cwd()` reports there — on macOS `tmpdir()` is a
  // symlink, and the two spellings would disagree about "inside".
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "eo-module-test-")));

  return new Promise((resolve) => {
    const child = spawn(launcher.execPath, [launcher.hostPath], {
      cwd: directory,
      // fd 3 is the case's transcript, fd 4 its signed result — the same
      // arrangement a real run has, for the same reasons.
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
      // The host's own environment and nothing else: no secret, no PATH.
      // The host empties even this before the case runs. Windows needs
      // SystemRoot for Node to start at all, so it is passed there.
      env: {
        ...launcher.hostEnv,
        ...systemRootEnv(process.platform, process.env),
      },
      windowsHide: true,
    });

    let output = "";
    let transcript = "";
    let resultText = "";
    let settled = false;
    let stoppedAt: number | null = null;
    let cancelled = false;
    let startFailure: string | null = null;
    let handoffFailure: string | null = null;

    const say = (text: string): void => {
      output = (output + text).slice(-MAX_CASE_OUTPUT_CHARS);
    };

    /** Stops the case, remembering which limit it was stopped at for the sentence that reports it. */
    const stopAt = (ms: number) => (): void => {
      stoppedAt ??= ms;
      child.kill("SIGKILL");
    };
    // The module's time limit, for the whole case, from the moment it
    // started. Never moved: a case's `timeoutMs` fixture can shorten the
    // limit a run is held to, and must not be able to lengthen it — a
    // case that asked for an hour and then spun without yielding would
    // otherwise hold the queue for that hour, past the limit the case is
    // supposed to be stopped at.
    const deadline = started + timeoutMs;
    const watchdog = setTimeout(stopAt(timeoutMs), Math.min(timeoutMs, MAX_TIMER_MS));
    /** A shorter limit a run inside the case is held to, when it asks for one, timed from when it starts. */
    let runWatchdog: ReturnType<typeof setTimeout> | undefined;
    const rearm = (ms: number): void => {
      clearTimeout(runWatchdog);
      runWatchdog = undefined;
      // Only ever shorter than what the module's limit still leaves.
      if (ms < deadline - Date.now()) runWatchdog = setTimeout(stopAt(ms), Math.min(ms, MAX_TIMER_MS));
    };

    // EO quitting mid-case must not leave a case spinning with nobody
    // left to stop it. Nothing else would: this host is not in a process
    // group of its own, because in test mode it starts no children.
    const onExit = (): void => {
      child.kill("SIGKILL");
    };
    process.once("exit", onExit);
    const onAbort = (): void => {
      cancelled = true;
      child.kill("SIGKILL");
    };
    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener("abort", onAbort, { once: true });

    const signedReport = (): CaseReport | null => {
      for (const line of resultText.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const framed = JSON.parse(line) as { nonce?: unknown; payload?: unknown };
          if (framed.nonce !== nonce || framed.payload === null || typeof framed.payload !== "object") continue;
          const payload = framed.payload as Record<string, unknown>;
          if (typeof payload.passed !== "boolean") continue;
          return { passed: payload.passed, failure: typeof payload.failure === "string" ? payload.failure : null, coverage: payload.coverage };
        } catch {
          // Not a line the host wrote. Ignored, as `runModule` ignores one.
        }
      }
      return null;
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearTimeout(runWatchdog);
      process.removeListener("exit", onExit);
      request.signal?.removeEventListener("abort", onAbort);
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Left behind in the OS's temporary directory, which the OS
        // clears; not worth failing a finished case over.
      }

      const report = signedReport();
      const failure = (reason: string): { result: ModuleTestCaseResult; coverage: null } => ({
        result: { testId: test.id, description: test.description, passed: false, failure: reason, durationMs: Date.now() - started, output },
        coverage: null,
      });
      if (report !== null) {
        const passed = report.passed && report.failure === null;
        resolve({
          result: {
            testId: test.id,
            description: test.description,
            passed,
            failure: passed ? null : (report.failure ?? "The case failed without saying why."),
            durationMs: Date.now() - started,
            output,
          },
          coverage: asCoverage(report.coverage),
        });
        return;
      }
      if (cancelled) return resolve(failure("The test run was cancelled while this case was running."));
      if (stoppedAt !== null) return resolve(failure(limitFailure(stoppedAt)));
      if (startFailure !== null) return resolve(failure(`The module host could not be started: ${startFailure}`));
      if (handoffFailure !== null) return resolve(failure(`EO could not hand this case to the module host, which exited before reading it: ${handoffFailure}`));
      resolve(failure("The module host ended without reporting on this case."));
    };

    child.stdout?.on("data", (chunk: Buffer) => say(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => say(chunk.toString()));

    const resultPipe = child.stdio[4];
    if (resultPipe && "on" in resultPipe) {
      resultPipe.on("data", (chunk: Buffer) => {
        resultText = (resultText + chunk.toString()).slice(-MAX_CHANNEL_CHARS);
      });
    }

    const transcriptPipe = child.stdio[3];
    if (transcriptPipe && "on" in transcriptPipe) {
      transcriptPipe.on("data", (chunk: Buffer) => {
        transcript += chunk.toString();
        const lines = transcript.split("\n");
        transcript = (lines.pop() ?? "").slice(-MAX_CHANNEL_CHARS);
        for (const line of lines) {
          if (line.trim() === "") continue;
          try {
            const event = JSON.parse(line) as { type?: string; text?: string; bin?: string; args?: string[]; ms?: number };
            if (event.type === "output" && typeof event.text === "string") say(event.text);
            else if (event.type === "exec") say(`$ ${event.bin} ${(event.args ?? []).join(" ")} (scripted)\n`);
            else if (event.type === "limit" && typeof event.ms === "number" && Number.isFinite(event.ms) && event.ms > 0) rearm(event.ms);
            // A `comment` event is never posted, and neither is an
            // `attach` (EO-414) — and a `create` (EO-433) is never sent
            // at all: the host answers it from the case's script. The case records both in the host, and
            // this side has no way to post one
            // at all — which is what makes "a test posts nothing" a
            // property of the code rather than of the case's good manners.
          } catch {
            say(`${line}\n`);
          }
        }
      });
    }

    child.on("error", (error) => {
      startFailure = error.message;
      // 'close' does not always follow a spawn that never started.
      finish();
    });
    child.on("close", finish);
    child.stdin?.on("error", (error: Error) => {
      handoffFailure ??= error.message;
    });

    child.stdin?.end(
      JSON.stringify({
        mode: "test",
        nonce,
        code: request.module.code,
        needs: request.module.manifest.needs,
        // So a case sees `waiting` refused, or accepted with its news,
        // exactly as a real run would (EO-458).
        watch: request.module.manifest.watch === true,
        // Whether a `refuse` carries its reason (EO-736), as on a real run.
        entryCheck: request.module.manifest.entryCheck === true,
        // The declarations, defaults and types both, so a case's inputs
        // are resolved and checked as a real run's are.
        inputs: request.module.manifest.inputs,
        caseSource: test.source,
        comments: { maxPerRun: MAX_COMMENTS_PER_RUN, maxChars: MAX_COMMENT_CHARS },
        attachments: { maxPaths: MAX_ATTACH_PATHS },
        creations: { maxPerRun: MAX_CREATIONS_PER_RUN },
        options: { max: MAX_OPTIONS, maxChars: MAX_OPTION_CHARS },
        timeoutMs,
      }),
    );
  });
}

/**
 * Runs every case of a module, one after another, and reports each with
 * the module's line and branch coverage across all of them.
 *
 * Always resolves. No cases is an empty run with 0% coverage: nothing of
 * the module ran.
 */
export async function runModuleTests(launcher: ModuleHostLauncher, request: RunModuleTestsRequest): Promise<ModuleTestRun> {
  const ranAt = Date.now();
  const cases: ModuleTestCaseResult[] = [];
  const reports: V8FunctionCoverage[][] = [];
  for (const test of request.tests) {
    if (request.signal?.aborted) {
      cases.push({ testId: test.id, description: test.description, passed: false, failure: "The test run was cancelled before this case ran.", durationMs: 0, output: "" });
      continue;
    }
    const { result, coverage } = await runCase(launcher, request, test);
    cases.push(result);
    if (coverage !== null) reports.push(coverage);
  }
  return { ranAt, cases, coverage: moduleCoverage(request.module.code, reports) };
}
