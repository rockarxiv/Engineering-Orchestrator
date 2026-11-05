import { execFile } from "node:child_process";
import type { RuntimeAuthView } from "@eo/core";
import { RUNTIMES, type RuntimeId } from "./catalog.js";

/**
 * Whether the runtime EO resolved is signed in (EO-82).
 *
 * This used to be answered by looking for files under `$HOME` —
 * `~/.claude/.credentials.json`, `~/.claude.json`, `~/.codex/auth.json`
 * — which is wrong in both directions and knows nothing about *which*
 * executable will run. `~/.claude.json` exists after mere onboarding, so
 * it said "signed in" when nobody was; on macOS Claude keeps its
 * credentials in the Keychain, so it said "signed out" when everything
 * was fine. Neither file has any bearing on an agent pointed at its own
 * `executablePath`.
 *
 * So the question goes to the binary dispatch would actually spawn.
 * Nothing here writes into `~/.claude` or `~/.codex`: EO asks, and the
 * CLI that owns the credential answers.
 *
 * `unknown` is a first-class answer and never collapses to
 * `signed_out`. Dispatch refuses on `signed_out`, so a probe that could
 * not run, or one whose output made no sense, must not be allowed to
 * block work on a machine that is perfectly well signed in.
 */

export type AuthProvider = RuntimeId;

/**
 * What running the probe produced.
 *
 * Same shape as `forge/cli.ts`'s `CliResult`, and for the same reasons:
 * stdout is captured even on failure, and "the binary is not there" is
 * kept distinct from "the binary said no".
 */
export interface AuthProbeResult {
  /** Exited zero. */
  ok: boolean;
  stdout: string;
  /** stderr, or the failure message when the process could not run at all. */
  error: string;
  notFound: boolean;
}

export type AuthProbeRunner = (command: string, args: string[]) => Promise<AuthProbeResult>;

/**
 * The argv each CLI answers this question with.
 *
 * Verified by running the pinned binaries EO downloads (claude 0.3.251,
 * codex 0.151.0) — neither is guessable. `claude auth status --json`
 * prints `{loggedIn, authMethod, apiProvider, email, orgId, orgName,
 * subscriptionType}`; `codex login status` prints a sentence such as
 * "Logged in using ChatGPT".
 */
export const AUTH_PROBE_ARGV: Record<AuthProvider, string[]> = {
  claude: ["auth", "status", "--json"],
  codex: ["login", "status"],
};

/**
 * Nothing here may sit waiting on a prompt nobody can see — the same
 * discipline `forge/cli.ts` documents. A status probe that blocks on a
 * pager holds the dispatch preflight open for as long as the process
 * lives.
 */
const PROBE_ENV: Record<string, string> = {
  NO_COLOR: "1",
  CLICOLOR: "0",
  PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
};

/** Long enough for a cold start of a large binary, short enough that a wedged probe is not a hung dispatch. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * How long an answer is reused.
 *
 * The Runtimes tab renders one card per runtime and re-renders freely;
 * without this, describing a machine would spawn a process per render.
 * Short enough that signing in elsewhere is noticed on its own, and
 * `invalidateRuntimeAuth` closes the gap for the changes EO itself
 * causes.
 */
export const AUTH_CACHE_TTL_MS = 15_000;

/** EO has not asked yet. Not a probe outcome, so it carries no problem text. */
const UNASKED: RuntimeAuthView = { state: "unknown", method: null, kind: "unknown", storedKey: false, account: null, problem: null };

/**
 * `signal` stops the probe's process (EO-477): a side call that times out
 * while it asks must not leave the CLI running. The shared runner the
 * cache uses takes none, because several callers wait on one probe.
 */
export function createAuthProbeRunner(timeoutMs = PROBE_TIMEOUT_MS, signal?: AbortSignal): AuthProbeRunner {
  return (command, args) =>
    new Promise((resolve) => {
      execFile(
        command,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, ...PROBE_ENV }, ...(signal ? { signal } : {}) },
        (error, stdout, stderr) => {
          const detail = error as (Error & { code?: string | number }) | null;
          resolve({
            ok: detail === null,
            stdout: String(stdout).trim(),
            error: String(stderr).trim() || detail?.message || "",
            notFound: detail?.code === "ENOENT",
          });
        },
      );
    });
}

let defaultRunner: AuthProbeRunner | null = null;

function unknownAuth(problem: string): RuntimeAuthView {
  return { state: "unknown", method: null, kind: "unknown", storedKey: false, account: null, problem };
}

/**
 * Which of the two ways in this is (EO-84).
 *
 * Read off whatever the CLI printed, because there is nothing better to
 * read it off: `claude auth status --json` reports an `authMethod` and
 * an `apiProvider`, `codex login status` reports a sentence, and the
 * spellings are neither shared nor promised. So this matches loosely
 * and answers `unknown` when nothing matches — an unrecognised method
 * is not evidence of a subscription, and a card that said "Subscription"
 * over an API key would be wrong about the thing somebody is being
 * billed for.
 *
 * API keys are tested first. "console" and "apiKey" are both API
 * billing, and Claude prints a `subscriptionType` regardless — so a
 * subscription-first order would call a Console sign-in a subscription
 * on the strength of a field that was there either way.
 */
const API_KEY_METHOD = /api[\s_-]?key|apikey|console|bedrock|vertex/i;
const SUBSCRIPTION_METHOD = /claude\.?ai|chatgpt|subscription|\bpro\b|\bmax\b|\bplus\b|\bteam\b|\benterprise\b/i;

export function authKindOf(...said: (string | null | undefined)[]): RuntimeAuthView["kind"] {
  const text = said.filter((part) => typeof part === "string" && part !== "").join(" ");
  if (text === "") return "unknown";
  if (API_KEY_METHOD.test(text)) return "api_key";
  return SUBSCRIPTION_METHOD.test(text) ? "subscription" : "unknown";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parsedObject(value: string): Record<string, unknown> | null {
  if (value === "") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Why EO could not tell, in words a person can act on rather than a stack trace. */
function problemFrom(result: AuthProbeResult, provider: AuthProvider): string {
  const label = RUNTIMES[provider].label;
  const command = `${label} ${AUTH_PROBE_ARGV[provider].join(" ")}`;
  if (result.notFound) return `EO could not run \`${command}\` — the executable it resolved is not there.`;
  const said = result.error !== "" ? result.error : result.stdout;
  if (!result.ok) return `\`${command}\` failed${said === "" ? "." : `: ${said}`}`;
  return `EO could not make sense of what \`${command}\` answered${said === "" ? "." : `: ${said}`}`;
}

/**
 * Claude's answer, read from its own JSON.
 *
 * The JSON is trusted ahead of the exit code, deliberately. A CLI that
 * prints `{"loggedIn": false}` and then exits non-zero has told us the
 * thing this whole story exists to surface, and reporting `unknown`
 * over the top of it would throw the answer away.
 */
export function readClaudeAuth(result: AuthProbeResult): RuntimeAuthView {
  const parsed = parsedObject(result.stdout);
  const loggedIn = parsed?.["loggedIn"];
  if (typeof loggedIn !== "boolean") return unknownAuth(problemFrom(result, "claude"));

  return {
    state: loggedIn ? "signed_in" : "signed_out",
    method: text(parsed?.["authMethod"]) ?? text(parsed?.["apiProvider"]) ?? text(parsed?.["subscriptionType"]),
    // Every field it named, not just the one shown: `authMethod` alone
    // is what says "console", and `apiProvider` alone is what says
    // "anthropic" on a machine whose `authMethod` was a word nobody
    // here has seen yet.
    kind: loggedIn
      ? authKindOf(text(parsed?.["authMethod"]), text(parsed?.["apiProvider"]), text(parsed?.["subscriptionType"]))
      : "unknown",
    // The key EO stores is layered on by `probeRuntimeAuth`, which is
    // the only caller that knows whether there is one. Nothing the CLI
    // prints could tell us: a key in EO's keychain is not a key the CLI
    // has ever seen.
    storedKey: false,
    account: text(parsed?.["email"]) ?? text(parsed?.["orgName"]),
    problem: null,
  };
}

/**
 * Codex's answer, read from the sentence it prints.
 *
 * Signed out is matched *first*: "Not logged in" contains "logged in",
 * and getting that order wrong reports the exact opposite of the truth.
 * Both streams are read because a signed-out `codex login status` may
 * exit non-zero and say so on stderr — which is an answer, not a
 * failure, so it is not flattened to `unknown`.
 */
const CODEX_SIGNED_OUT = /not\s+(?:logged|signed)\s+in|logged\s+out|no\s+credentials|run\s+["'`]?codex\s+login/i;
const CODEX_SIGNED_IN = /(?:logged|signed)\s+in(?:\s+(?:using|with|as)\s+(?<method>[^\n]+))?/i;
/**
 * A key held by the CLI, as 0.165.0 words it (EO-599): "API key
 * configured - sk-…", then "Authentication is checked when you send a
 * request." 0.163.0 said "Logged in using an API key - sk-…" for the
 * same state, which `CODEX_SIGNED_IN` reads. The state did not change
 * between them: neither binary checks the key when it is stored, so
 * both report a key nobody has used yet as signed in, and so does this.
 */
const CODEX_API_KEY_CONFIGURED = /^\s*api\s+key\s+configured\b/im;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;

export function readCodexAuth(result: AuthProbeResult): RuntimeAuthView {
  const said = [result.stdout, result.error].filter((part) => part !== "").join("\n");
  if (said !== "" && CODEX_SIGNED_OUT.test(said)) {
    return { state: "signed_out", method: null, kind: "unknown", storedKey: false, account: null, problem: null };
  }

  if (CODEX_API_KEY_CONFIGURED.test(said)) {
    return { state: "signed_in", method: "API key", kind: "api_key", storedKey: false, account: null, problem: null };
  }

  const match = CODEX_SIGNED_IN.exec(said);
  if (!match) return unknownAuth(problemFrom(result, "codex"));

  const account = EMAIL.exec(said)?.[0] ?? null;
  // Whatever it printed after "using", minus the account if that is
  // where the account was printed, minus the punctuation around it.
  const method = text((match.groups?.["method"] ?? "").replace(account ?? "", "").replace(/[(),.\s]+$/, "").replace(/^[(,.\s]+/, ""));
  // `storedKey` is false even when the method *is* an API key: the key
  // went to `codex login --with-api-key` and the CLI has held it ever
  // since. EO has nothing to remove and must not offer to.
  return { state: "signed_in", method, kind: authKindOf(method), storedKey: false, account, problem: null };
}

export interface ProbeOptions {
  provider: AuthProvider;
  /** What `resolveRuntime` found — EO's managed copy, or the agent's own `executablePath`. */
  executablePath: string | null;
  /**
   * Whether EO holds an API key for this provider (EO-84).
   *
   * A fact about the keychain, never the key: nothing in this file has
   * any business seeing one. It is passed in rather than read here so
   * `packages/engine`-style purity holds at the seam that matters —
   * this module knows how to ask a binary a question, and knows nothing
   * about where EO keeps secrets.
   */
  storedKey?: boolean;
  /** Seam for tests. The real one spawns a CLI, which a unit test must never do. */
  run?: AuthProbeRunner;
}

/**
 * The answer when EO itself holds the credential (EO-84).
 *
 * Asking the binary here would report the *opposite* of the truth. A
 * stored key is injected as `ANTHROPIC_API_KEY` when the provider
 * spawns, so the copy dispatch runs is authenticated; the probe EO would
 * run to ask has no such key in its environment and would answer
 * "signed out" — refusing dispatch on a machine that can do the work.
 *
 * So this is the answer, and the probe is skipped entirely. It is also
 * what makes removing the key from the card honest: with nothing stored,
 * the question goes back to the binary and the binary says what it
 * always said.
 *
 * A stored key that has been *revoked* still reads as signed in. That is
 * true of every credential here — the CLI's own stored session can be
 * revoked just as easily — and the first dispatch says so precisely.
 */
function storedKeyAuth(): RuntimeAuthView {
  return { state: "signed_in", method: "API key", kind: "api_key", storedKey: true, account: null, problem: null };
}

/** Runs the probe once, unconditionally. `runtimeAuth` is what callers normally want. */
export async function probeRuntimeAuth(options: ProbeOptions): Promise<RuntimeAuthView> {
  const { provider, executablePath } = options;
  const label = RUNTIMES[provider].label;
  // Before the executable check as well as before the spawn: a key EO
  // injects is a credential whether or not there is a binary resolved
  // yet, and reporting "EO has nothing to ask" over the top of it would
  // hide the one thing the person just did.
  if (provider === "claude" && options.storedKey === true) return storedKeyAuth();

  if (executablePath === null || executablePath.trim() === "") {
    return unknownAuth(`EO has no ${label} executable to ask — nothing is installed and no executable path is set.`);
  }

  const run = options.run ?? (defaultRunner ??= createAuthProbeRunner());
  let result: AuthProbeResult;
  try {
    result = await run(executablePath, AUTH_PROBE_ARGV[provider]);
  } catch (error) {
    // A runner is not supposed to throw, but one that does must not take
    // a dispatch preflight or a settings screen down with it.
    return unknownAuth(`EO could not run ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return provider === "claude" ? readClaudeAuth(result) : readCodexAuth(result);
}

type Answered = { at: number; answer: RuntimeAuthView };

/** Keyed on the executable as well as the provider: two agents can resolve different copies. */
const answers = new Map<string, Answered>();
const asking = new Map<string, Promise<RuntimeAuthView>>();

/**
 * Which era of the binary a probe belongs to.
 *
 * An install replaces the executable underneath a probe that is already
 * running, and that probe's answer describes the copy that is now gone.
 * Dropping the promise from `asking` stops that answer being *reused*;
 * this stops it being *written back* when it finally lands, which is
 * the same bug arriving a moment later. Counted per provider, so
 * installing one runtime does not discard an in-flight answer about the
 * other.
 */
const generations = new Map<AuthProvider, number>();

function generationOf(provider: AuthProvider): number {
  return generations.get(provider) ?? 0;
}

/**
 * `storedKey` is part of the key, not merely an input to the answer.
 *
 * Storing or removing one changes what the *same* binary is reported to
 * answer, and both ends of that call `invalidateRuntimeAuth` — but a
 * cache keyed only on the executable would still hand a
 * fifteen-second-old answer to the card in the window before an
 * invalidation some future caller forgets to make. Two slots cost
 * nothing and cannot disagree with each other.
 */
function cacheKey(provider: AuthProvider, executablePath: string | null, storedKey = false): string {
  return `${provider}\u0000${executablePath ?? ""}\u0000${storedKey ? "key" : ""}`;
}

/**
 * The last answer, without asking again.
 *
 * For callers that must stay synchronous — `runtimeStatus` reads the
 * machine off disk and is called from write paths that have no business
 * spawning a process. `unknown` here means "EO has not asked", which is
 * exactly what it is.
 */
export function cachedRuntimeAuth(
  provider: AuthProvider,
  executablePath: string | null,
  options: { storedKey?: boolean; now?: () => number } = {},
): RuntimeAuthView {
  const now = options.now ?? Date.now;
  const entry = answers.get(cacheKey(provider, executablePath, options.storedKey));
  if (entry === undefined || now() - entry.at >= AUTH_CACHE_TTL_MS) return UNASKED;
  return entry.answer;
}

/** The answer, from cache when it is fresh and from the binary when it is not. */
export async function runtimeAuth(options: ProbeOptions & { now?: () => number }): Promise<RuntimeAuthView> {
  const now = options.now ?? Date.now;
  const key = cacheKey(options.provider, options.executablePath, options.storedKey);

  const entry = answers.get(key);
  if (entry !== undefined && now() - entry.at < AUTH_CACHE_TTL_MS) return entry.answer;

  // Rendering the tab asks for every runtime at once, and React asks
  // again before the first answer lands. One spawn, one answer.
  const pending = asking.get(key);
  if (pending !== undefined) return pending;

  // Read before the probe starts and compared after it lands. An
  // install finishing in between makes this an answer about a binary
  // that no longer exists, and caching it would hand the replacement
  // its predecessor's credentials.
  const generation = generationOf(options.provider);
  const task = probeRuntimeAuth(options)
    .then((answer) => {
      if (generationOf(options.provider) === generation) answers.set(key, { at: now(), answer });
      return answer;
    })
    // Only if this task still owns the slot. An invalidation may have
    // dropped it and a later question started a fresh probe, and
    // deleting that one would leave a probe running that nobody can
    // join.
    .finally(() => {
      if (asking.get(key) === task) asking.delete(key);
    });
  asking.set(key, task);
  return task;
}

/**
 * Forgets what was asked, so the next question reaches the binary.
 *
 * Called when an install completes: the copy on disk a moment ago is
 * not the copy on disk now, and a freshly downloaded runtime nobody has
 * signed into must not inherit an answer given about something else.
 *
 * A probe that is still *running* is the same staleness one moment
 * later, so both halves of it are dealt with: the promise is dropped,
 * so the next question spawns rather than joining the queue behind a
 * question about the replaced binary, and the generation is bumped, so
 * the answer it eventually produces is discarded instead of written
 * back over the cache.
 */
export function invalidateRuntimeAuth(provider?: AuthProvider): void {
  const providers = provider === undefined ? (Object.keys(RUNTIMES) as AuthProvider[]) : [provider];
  for (const id of providers) generations.set(id, generationOf(id) + 1);

  if (provider === undefined) {
    answers.clear();
    asking.clear();
    return;
  }
  const prefix = `${provider}\u0000`;
  for (const key of [...answers.keys()]) {
    if (key.startsWith(prefix)) answers.delete(key);
  }
  for (const key of [...asking.keys()]) {
    if (key.startsWith(prefix)) asking.delete(key);
  }
}

/**
 * The dispatch preflight (invariant #8: every guard ends in a comment).
 *
 * Only `signed_out` refuses. `unknown` means the probe failed, and
 * refusing on that would park work on a machine that can do it — the
 * CLI itself will say so far more precisely if it really cannot run.
 *
 * The refusal names Agents → Runtimes rather than telling anyone to run
 * a CLI in a terminal. Someone whose only copy of these tools came from
 * EO has no such terminal, which is the whole reason this story exists.
 *
 * `storedKey` is what stops this refusing the one case EO created
 * itself (EO-84): a key typed into EO is injected at spawn and is never
 * visible to `claude auth status`, so without it the preflight would
 * park every dispatch on a machine whose only credential is the one EO
 * is holding.
 */
export async function checkRuntimeAuth(options: {
  provider: string;
  agentName: string;
  executablePath: string | null;
  storedKey?: boolean;
  run?: AuthProbeRunner;
}): Promise<{ ok: boolean; reason?: string }> {
  if (!(options.provider in RUNTIMES)) return { ok: true }; // `fake`, and anything else that runs in-process
  const provider = options.provider as AuthProvider;

  const auth = await runtimeAuth({
    provider,
    executablePath: options.executablePath,
    ...(options.storedKey === undefined ? {} : { storedKey: options.storedKey }),
    ...(options.run ? { run: options.run } : {}),
  });
  if (auth.state !== "signed_out") return { ok: true };

  const label = RUNTIMES[provider].label;
  const where = options.executablePath === null ? "" : ` The copy EO resolved is \`${options.executablePath}\`.`;
  return {
    ok: false,
    reason:
      `${label} is not signed in, so ${options.agentName} has nothing to run with.${where} ` +
      `Sign it in from Agents → Runtimes, then reply here to retry.`,
  };
}
