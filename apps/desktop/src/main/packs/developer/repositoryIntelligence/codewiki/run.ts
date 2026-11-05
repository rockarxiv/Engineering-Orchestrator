import { spawn } from "node:child_process";
import { killTree } from "../../../../process/killTree.js";
import { resolveCodeWiki, type ResolveOptions } from "../binary/resolve.js";

/**
 * The only file in this codebase that spawns the CodeWiki binary, and
 * the only one that imports the path to it.
 *
 * The arrangement is the one `better-sqlite3`, `git` and `gh`/`glab`
 * each already have, and `workspace/git.ts` gives the reason: an
 * argument-quoting rule is enforceable when there is one place to
 * enforce it and merely hoped for when there are five. Repository paths
 * and item names are user-controlled, and a concatenated command line
 * is how that becomes somebody else's problem — EO's own gate fixtures
 * put spaces in directory names precisely to catch it.
 *
 * So: `spawn` with an argument array, never a shell, never a string.
 * There is no `shell: true` here and there must never be one. `spawn`
 * rather than `execFile` because three of this module's obligations —
 * bounded capture that keeps output instead of discarding it, a kill
 * that reaches the whole process group, and telling a timeout apart
 * from a non-zero exit — all need the handle `execFile` hides.
 *
 * Nothing here throws for an invocation that failed. A missing binary,
 * a non-zero exit, a hang and a cancelled run are all ordinary outcomes
 * carrying a sentence somebody can read, because repository
 * intelligence degrades rather than blocks: an agent whose index failed
 * still has filesystem and git tools. Throwing is reserved for
 * programmer error, per this codebase's error convention.
 *
 * What is deliberately *not* baked in here is the environment. The
 * `codewiki init` hook redirection and any output-colour settings
 * belong to the stories that run those subcommands; this module carries
 * `env` through so they have somewhere to put it, and invents none of
 * it on their behalf.
 */

/**
 * How long any one invocation may run before it is killed.
 *
 * A cold index measured 55s for kubernetes (17,176 Go files) and 62s
 * for microsoft/TypeScript (39,296 files), so ten minutes is an order
 * of magnitude of headroom over the largest repository anyone has
 * pointed this at. The number matters less than there being one: an
 * indexer that wedges without a timeout leaves the step `running` with
 * nothing on screen and no way out but cancelling the whole item,
 * which is the failure `NETWORK_TIMEOUT_MS` exists to prevent for git.
 */
export const DEFAULT_CODEWIKI_TIMEOUT_MS = 600_000;

/**
 * How much of each stream is kept.
 *
 * Per stream, not shared: a run that fails prints its explanation on
 * stderr, and letting a chatty progress log on stdout evict it would
 * throw away the only part worth reading.
 */
export const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024;

/** How long to wait for a killed process tree to actually die before giving up on it. */
const KILL_GRACE_MS = 5000;

/**
 * What happened, in the one field a caller has to branch on.
 *
 * `timeout` is separate from `exit` because they are separate
 * conditions and the caller does different things with them: a non-zero
 * exit is CodeWiki saying no and its stderr is the answer, while a
 * timeout produced no answer at all and says nothing about the
 * repository except that indexing it took too long. Folding them
 * together — reporting a hang as "exited 1" — is how a retry-worthy
 * failure gets recorded as a permanent one.
 *
 * `unavailable` means nothing ran: no build exists for this machine, EO
 * has not downloaded one, or the path it was pointed at is not
 * executable. Every one of those is the graceful-degradation path
 * rather than an error.
 */
export type CodeWikiStatus = "ok" | "exit" | "timeout" | "cancelled" | "unavailable";

export interface CodeWikiRunResult {
  status: CodeWikiStatus;
  /** Exactly `status === "ok"`. Kept because every call site would otherwise write it out. */
  ok: boolean;
  /** Null when nothing ran, when the wall-clock timeout fired, or when a signal killed it. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Either stream hit the bound and lost its earliest output. */
  truncated: boolean;
  /** Null only when `status` is `ok`. Written for a person to read. */
  problem: string | null;
}

export interface CodeWikiRunRequest {
  /**
   * argv after the binary itself — `["index", "--path", worktree]`.
   *
   * An array, and it stays an array all the way to `spawn`. A path with
   * a space in it is one element here and one argument there; no
   * quoting happens because there is no shell to quote for, and on
   * Windows there is no second set of quoting rules to get wrong.
   */
  args: string[];
  cwd: string;
  /** How to find the binary: `runtimes`-style resolution, configured path first. */
  binary: ResolveOptions;
  /**
   * Kills the child when a person cancels the run this belongs to.
   *
   * The whole process group goes, not just the direct child: CodeWiki
   * shells out to `git config` while resolving hook paths, and a
   * cancelled item that leaves an indexer chewing through a worktree
   * EO is about to remove is the orphan this exists to prevent.
   */
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputChars?: number;
  /** Merged over the inherited environment. */
  env?: Record<string, string>;
}

/**
 * A tail-keeping buffer that knows exactly how much it threw away.
 *
 * The tail rather than the head, for `runCommand`'s reason: whatever
 * went wrong is printed last. Not `runCommand`'s `truncateHead`,
 * deliberately — that one truncates at read time behind a 4x streaming
 * slack, so the count it prints is of the slack rather than of the
 * output, and it merges the two streams into one buffer. Both are fine
 * for a check command and neither is right here, where the bound has to
 * hold per stream and "37 characters omitted" must not be a guess.
 *
 * Memory is bounded while the process is still running, which is the
 * point: a cold index of a large repository is chatty, and a buffer
 * that only gets trimmed once the child exits is a buffer that grows
 * until it doesn't.
 */
function boundedCapture(maxChars: number): { append(chunk: string): void; read(): { text: string; truncated: boolean } } {
  let text = "";
  let omitted = 0;
  return {
    append(chunk: string): void {
      text += chunk;
      if (text.length > maxChars) {
        const excess = text.length - maxChars;
        text = text.slice(excess);
        omitted += excess;
      }
    },
    read(): { text: string; truncated: boolean } {
      const kept = text.trim();
      if (omitted === 0) return { text: kept, truncated: false };
      return { text: `[... ${omitted} earlier characters omitted ...]\n${kept}`, truncated: true };
    },
  };
}

/**
 * Refuses an argv this module could only mangle.
 *
 * The one place throwing is right, and only because neither case can
 * come from a person: an empty array asks CodeWiki to run no subcommand
 * at all, and a non-string element is a call site that meant to
 * stringify something and forgot. Both are bugs in EO, which is what
 * the convention reserves a throw for. A repository path that does not
 * exist, an item named something strange, a binary that is not there —
 * none of those are programmer error and none of them throw.
 */
function assertArgv(args: string[]): void {
  if (args.length === 0) {
    throw new TypeError("runCodeWiki needs at least one argument — the CodeWiki subcommand to run.");
  }
  const index = args.findIndex((argument) => typeof argument !== "string");
  if (index !== -1) {
    throw new TypeError(`runCodeWiki takes an array of strings, and argument ${index} is not one. Convert it at the call site rather than letting it stringify here.`);
  }
}

/**
 * Runs one CodeWiki invocation and resolves with what it did.
 *
 * Always resolves. Resolution runs first, so a machine with no build
 * and a machine that has not downloaded one both come back
 * `unavailable` carrying the reason `binary/resolve.ts` wrote, without
 * anything having been spawned.
 */
export function runCodeWiki(request: CodeWikiRunRequest): Promise<CodeWikiRunResult> {
  assertArgv(request.args);

  const resolved = codeWikiExecutable(request.binary);
  if (resolved.path === null) {
    return Promise.resolve(unavailable(resolved.reason ?? "EO could not find a CodeWiki binary to run."));
  }
  return spawnCodeWiki(resolved.path, request);
}

/** What resolution found, for a caller that needs the path without starting anything. */
export interface CodeWikiExecutable {
  /** The binary to run, or null when this machine has none. */
  path: string | null;
  /** The version resolution can vouch for without asking the binary — null when it cannot. */
  version: string | null;
  /** Why there is nothing, in words meant for a person. Null when there is something. */
  reason: string | null;
}

/**
 * Where the binary is, without starting one.
 *
 * Not every use of CodeWiki is an invocation. The MCP server an agent
 * queries is spawned by the agent's own runtime from a command, some
 * arguments and an environment (EO-141), so somebody has to hand out a
 * path that EO itself never runs — and this module is where a path to
 * this binary is allowed to come from. `codewiki/importSites.test.ts`
 * holds that line: exactly one file may both find the binary and start
 * one, and a second caller reaching for resolution directly is what
 * that test fails on.
 *
 * A projection of `ResolvedCodeWiki` rather than the thing itself,
 * deliberately: `source` says *how* it was found, which is resolution's
 * own business and nothing a caller should branch on.
 */
export function codeWikiExecutable(binary: ResolveOptions): CodeWikiExecutable {
  const resolved = resolveCodeWiki(binary);
  return { path: resolved.path, version: resolved.version, reason: resolved.reason };
}

function unavailable(problem: string): CodeWikiRunResult {
  return { status: "unavailable", ok: false, exitCode: null, stdout: "", stderr: "", truncated: false, problem };
}

function spawnCodeWiki(binaryPath: string, request: CodeWikiRunRequest): Promise<CodeWikiRunResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_CODEWIKI_TIMEOUT_MS;
  const maxOutputChars = request.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  return new Promise((resolve) => {
    // The argument array, straight through. Note what is absent: no
    // `shell`, and nothing built by concatenation.
    const child = spawn(binaryPath, request.args, {
      cwd: request.cwd,
      windowsHide: true,
      // A process group of its own, so `killTree` reaches the `git
      // config` CodeWiki shells out to and not merely CodeWiki.
      detached: process.platform !== "win32",
      ...(request.env ? { env: { ...process.env, ...request.env } } : {}),
    });

    const stdout = boundedCapture(maxOutputChars);
    const stderr = boundedCapture(maxOutputChars);
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk.toString()));

    const finish = (status: CodeWikiStatus, exitCode: number | null, problem: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      // A run's signal can outlive the run — the supervisor's does —
      // and a listener left on it is a leak per invocation.
      request.signal?.removeEventListener("abort", onAbort);
      const out = stdout.read();
      const err = stderr.read();
      resolve({
        status,
        ok: status === "ok",
        exitCode,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        problem,
      });
    };

    /**
     * Killing is a request, not a completion.
     *
     * On Windows it is an asynchronous `taskkill`, so the child can
     * still be alive — and still holding a handle on the worktree — for
     * a moment after. Resolving straight away let the caller go on to
     * remove that directory and fail with EBUSY. Waiting for `close`
     * means the OS has reaped it; the grace timer means a genuinely
     * unkillable process still cannot hang EO, which is the thing the
     * timeout exists to prevent in the first place.
     */
    const stop = (then: () => void): void => {
      if (child.pid !== undefined) killTree(child.pid);
      graceTimer = setTimeout(then, KILL_GRACE_MS);
      graceTimer.unref?.();
    };

    // Deliberately impersonal: these name neither the subcommand nor
    // the argv. Naming the subcommand would mean reading an element out
    // of `request.args` and interpolating it into a sentence, and the
    // moment that happens, "this module never assembles a command line"
    // stops being something a reader — or `run.test.ts` — can establish
    // by looking at the file. `request.args` reaches exactly two places
    // here, the check that it is well formed and `spawn`, and that is
    // the property worth more than a slightly richer sentence. The
    // caller knows which invocation it made and says so in its own
    // words; this only has to say what became of it.
    const timeoutProblem = `CodeWiki ran for longer than ${timeoutMs}ms and was stopped. It did not fail — it did not finish.`;
    const cancelledProblem = "CodeWiki was cancelled.";

    const onAbort = (): void => {
      cancelled = true;
      stop(() => finish("cancelled", null, cancelledProblem));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop(() => finish("timeout", null, timeoutProblem));
    }, timeoutMs);
    timer.unref?.();

    if (request.signal) {
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Nothing ran: the path is wrong, not executable, or on a
    // filesystem that says no. Degradation, not an error — same shape
    // as a platform with no published build.
    child.on("error", (error: NodeJS.ErrnoException) => {
      const detail = error.code === "ENOENT" ? "there is no such file" : error.message;
      finish("unavailable", null, `EO could not start the CodeWiki binary at ${binaryPath}: ${detail}.`);
    });

    child.on("close", (code, signalName) => {
      // Cancellation and the timeout are checked before the exit
      // status, because a killed process reports one and it is ours
      // rather than CodeWiki's.
      if (cancelled) {
        finish("cancelled", null, cancelledProblem);
      } else if (timedOut) {
        finish("timeout", null, timeoutProblem);
      } else if (code === 0) {
        finish("ok", 0, null);
      } else if (code === null) {
        finish("exit", null, `CodeWiki was killed by ${signalName ?? "a signal"}.`);
      } else {
        finish("exit", code, `CodeWiki exited with status ${code}.`);
      }
    });
  });
}
