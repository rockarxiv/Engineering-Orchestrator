import { spawn } from "node:child_process";
import { uuidv7 } from "@eo/core";
import { RUNTIMES } from "./catalog.js";
import { invalidateRuntimeAuth, type AuthProvider } from "./auth.js";

/**
 * Signing a runtime in without a terminal (EO-83).
 *
 * Someone whose only copy of these CLIs came from EO has no terminal to
 * run `claude` in, so EO runs the CLI's own login itself: it spawns the
 * binary `resolveRuntime` found, reads the OAuth URL off stdout, opens
 * it, and carries back whatever the flow needs. Nothing here writes
 * into `~/.claude` or `~/.codex` — every credential is written by the
 * CLI that owns it, and EO's whole part is running the right binary and
 * showing what it printed.
 *
 * The two providers are shaped differently and this file knows it:
 *
 * - `claude auth login` opens the browser **itself**, at a page that
 *   redirects to its own listener on `http://localhost:<port>/callback`,
 *   and exits 0 once the browser comes back there (EO-665). The URL it
 *   prints ("If the browser didn't open, visit: …") is only its fallback:
 *   that one redirects to `platform.claude.com/oauth/code/callback`, a
 *   page that displays an authorization code, and the child is still
 *   reading stdin for it ("Paste code here if prompted >"). So EO opens
 *   nothing, shows the printed URL with a copy button, waits for the
 *   exit, and keeps a field for the code as the fallback's other half.
 *   `claude auth login --console` behaves exactly the same — browser
 *   opened by the CLI, localhost redirect, the code page as the printed
 *   fallback — so it is handled the same way.
 * - `codex login` prints a URL and starts its own listener on
 *   `http://localhost:1455`. The browser redirects there and the child
 *   takes the code itself — it never passes through EO, so there is no
 *   field for it and nothing to submit. EO waits for the exit.
 * - `codex login --device-auth` is the "browser did not open" fallback:
 *   a URL *plus* a one-time code the person types into the page, which
 *   is the opposite direction from Claude's.
 *
 * Both Codex browser paths delete `~/.codex/auth.json` at the start, so
 * beginning a sign-in signs the machine out of Codex and abandoning it
 * leaves it signed out. EO says so in the dialog rather than restoring
 * the file behind the CLI's back — see the pinned decision on EO-81.
 *
 * API keys are the second way in, and they are shaped differently again
 * (EO-84). Codex has a flag — `signInWithApiKey` below pipes the key to
 * `codex login --with-api-key` on stdin and the CLI stores it, so EO
 * holds nothing. Claude has none, so its API-key paths are `claude auth
 * login --console`, which is a browser flow like any other and lives in
 * `SIGN_IN_FLOWS`, and a key typed into EO, which is stored with
 * `safeStorage` in `apiKey.ts` and never comes near this file.
 *
 * Every flow is line-oriented with stdout piped. The Claude flows were
 * verified against EO's managed Claude Code 0.3.318 (the binary reports
 * itself as 2.1.318) — 0.3.251, which they were first written against,
 * printed only the code-page URL and never finished by itself — and the
 * Codex flows against codex 0.151.0. No pty, and no new native
 * dependency: the spawn sits behind the `SignInSpawner` seam in the
 * manner of `forge/cli.ts`, so no test here starts a real CLI.
 */

export type SignInMode = "browser" | "device" | "console";

export interface SignInFlow {
  /** The argv, after the resolved executable. */
  argv: string[];
  /**
   * Whether the child also reads a code from stdin. Every flow finishes
   * by itself; for Claude a pasted code is the fallback, for when the
   * page displayed one instead of returning to the CLI's listener.
   */
  needsCode: boolean;
  /**
   * Whether the CLI opens the sign-in page itself. Then the URL it prints
   * is its own fallback, and EO opening that too would put a second page
   * — the one that shows a code — in front of the person.
   */
  cliOpensBrowser: boolean;
  /** Whether the CLI prints a one-time code for the *person* to type into the page. */
  printsVerificationCode: boolean;
}

/**
 * What each provider's sign-in actually is.
 *
 * Claude has no device flow: its printed fallback page displays a code
 * to paste, which is already the headless-friendly direction. Codex has both, and
 * `browser` is the default deliberately — a desktop app has a browser,
 * so the child's own listener is the better path and `--device-auth`
 * stays an explicit fallback.
 */
export const SIGN_IN_FLOWS: Record<AuthProvider, Partial<Record<SignInMode, SignInFlow>>> = {
  claude: {
    browser: { argv: ["auth", "login"], needsCode: true, cliOpensBrowser: true, printsVerificationCode: false },
    // The Anthropic Console flow (EO-84): API billing rather than a
    // subscription, and on 0.3.318 the same shape as the login above —
    // the CLI opens the page itself and finishes on its own, with the
    // code page as the printed fallback. It is the API-key path that
    // leaves EO holding nothing: the CLI stores what it gets.
    console: { argv: ["auth", "login", "--console"], needsCode: true, cliOpensBrowser: true, printsVerificationCode: false },
  },
  codex: {
    browser: { argv: ["login"], needsCode: false, cliOpensBrowser: false, printsVerificationCode: false },
    device: { argv: ["login", "--device-auth"], needsCode: false, cliOpensBrowser: false, printsVerificationCode: true },
    // Codex's API key has no browser half at all — see `signInWithApiKey`.
  },
};

/**
 * How the child exited. Never a rejection: a sign-in that could not
 * start is an answer the dialog has to show, not an exception.
 */
export interface SignInExit {
  code: number | null;
  signal: string | null;
  /** Set when the process could not be spawned at all. */
  error: string | null;
}

/**
 * A running sign-in, as this module needs to see one.
 *
 * `onOutput` carries raw chunks rather than lines. Both CLIs are
 * line-oriented, but a *prompt* is not — `claude auth login` writes its
 * "paste the code" prompt with no trailing newline, and a strictly
 * line-oriented reader waits forever for a line that never ends. The
 * session accumulates the chunks and scans the accumulation, which also
 * makes a URL split across two reads a non-event.
 */
export interface SignInProcess {
  onOutput(listener: (chunk: string) => void): void;
  /** Writes to the child's stdin — Claude's authorization code, or Codex's API key. */
  write(text: string): void;
  /**
   * Closes the child's stdin.
   *
   * Optional because only one flow needs it: `codex login --with-api-key`
   * reads the key *from* stdin, and a reader that takes the whole stream
   * rather than one line sits there until the pipe closes. Every browser
   * flow must leave stdin open instead — Claude's is still waiting to be
   * handed a code — which is why this is a separate call and not
   * something `write` does.
   *
   * Named for the pipe rather than for the process. `end` would read as
   * "end the child", which is `kill`, and a fake that implemented the
   * wrong one would exit the process the moment the key was handed over.
   */
  closeStdin?(): void;
  kill(): void;
  readonly exit: Promise<SignInExit>;
}

export type SignInSpawner = (command: string, args: string[]) => SignInProcess;

/**
 * Nothing here may sit waiting on a prompt nobody can see — the same
 * discipline `forge/cli.ts` documents. Colour is off as well as paging:
 * an ANSI-decorated URL is a URL this file has to un-decorate before it
 * can be opened, and not producing one is better than repairing one.
 */
const SIGN_IN_ENV: Record<string, string> = {
  NO_COLOR: "1",
  CLICOLOR: "0",
  FORCE_COLOR: "0",
  PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
};

/**
 * How long the CLI has to print a URL before EO gives up on it.
 *
 * The acceptance criterion this exists for: a flow that prints no URL
 * must fail with whatever the CLI actually printed, and must never
 * leave a dialog spinning on an invisible prompt.
 */
const URL_TIMEOUT_MS = 30_000;

/**
 * How long a device code has to follow the URL it belongs to.
 *
 * `codex login --device-auth` prints both, but not necessarily in one
 * write. Waiting the full URL timeout for the second half would hold a
 * dialog hostage over a formatting change, so after the URL lands the
 * code gets a moment and then the flow goes ahead with what it has —
 * the transcript is returned either way, so nobody is left with nothing
 * to read.
 */
const CODE_GRACE_MS = 2_000;

/**
 * How long the child may take to finish once the browser half starts.
 *
 * Generous because it covers a person signing in: opening the page,
 * choosing an account, approving. Bounded because a CLI that re-prompts
 * on stdin after a rejected code would otherwise leave EO waiting on a
 * prompt nobody can see, which is the thing this file must never do.
 */
const COMPLETION_TIMEOUT_MS = 5 * 60_000;

/** CSI sequences, so a decorated line does not become a URL with escape codes glued to it. */
// eslint-disable-next-line no-control-regex -- the whole point is to match control characters
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/**
 * The URL the person is meant to open.
 *
 * `localhost` is skipped, and that is load-bearing rather than tidy:
 * `codex login` announces its own listener ("Starting local login
 * server on http://localhost:1455") *before* it prints the OAuth URL,
 * so the first URL on stdout is the one address opening a browser at
 * would achieve nothing.
 *
 * `requireTerminator` is about half-arrived output. A URL at the very
 * end of what has been read so far may still be arriving, so while EO
 * is still willing to wait it only accepts one with something after it.
 * On the last look — the timeout, or the child exiting — it takes what
 * it has, because by then there is no more coming.
 */
export function findSignInUrl(transcript: string, requireTerminator = true): string | null {
  const pattern = /https?:\/\/[^\s"'<>`]+/g;
  for (const match of transcript.matchAll(pattern)) {
    const url = match[0].replace(/[.,;:)\]}]+$/, "");
    if (/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(url)) continue;
    if (requireTerminator && match.index + match[0].length >= transcript.length) continue;
    return url;
  }
  return null;
}

/**
 * The one-time code `codex login --device-auth` wants typed into the page.
 *
 * A heuristic, and knowingly one: the CLI's exact wording is not a
 * contract. The labelled form is tried first, then the shape these
 * codes take — a short dashed run of capitals and digits — and when
 * neither matches the flow still returns its transcript, so a person
 * can read the code off what the CLI printed rather than being stuck.
 */
export function findVerificationCode(transcript: string): string | null {
  const labelled = /(?:one[- ]time|user|device|verification)?\s*code(?:\s+is)?\s*[:=]?\s*["'`]?([A-Za-z0-9][A-Za-z0-9-]{3,})/i.exec(transcript);
  if (labelled?.[1] !== undefined && codeShaped(labelled[1])) return labelled[1];

  const shaped = /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/.exec(transcript.replace(/https?:\/\/\S+/g, " "));
  return shaped?.[1] ?? null;
}

/**
 * What one of these codes looks like, and what an ordinary word does not.
 *
 * The label match is loose enough to catch "code:", "code is" and "your
 * one-time code", which means it is also loose enough to catch "No code
 * here" and offer someone `HERE` to type into a page. Showing the wrong
 * code is worse than showing none — the transcript is on screen either
 * way — so the capture has to be upper case and carry a digit or a dash
 * before EO will put a person's sign-in on it.
 */
function codeShaped(value: string): boolean {
  return /^[A-Z0-9][A-Z0-9-]{3,}$/.test(value) && /[\d-]/.test(value);
}

/**
 * The real spawner.
 *
 * `spawn` with an argument array and no shell, like every other
 * shell-out in this codebase. stdin stays a pipe even for Codex, which
 * never reads it: a child whose stdin is inherited from a packaged app
 * has no terminal behind it, and a CLI that decides to prompt on one
 * would block on a read that can never complete.
 */
export function createSignInSpawner(): SignInSpawner {
  return (command, args) => {
    const listeners: ((chunk: string) => void)[] = [];
    const emit = (chunk: string): void => {
      for (const listener of [...listeners]) listener(chunk);
    };

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...SIGN_IN_ENV },
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    // Both streams: these CLIs put their prompts and their errors on
    // whichever one they feel like, and a flow that read only stdout
    // would report "no URL" over a stderr full of explanation.
    child.stdout?.on("data", (chunk: string) => emit(String(chunk)));
    child.stderr?.on("data", (chunk: string) => emit(String(chunk)));
    // An unwritable stdin is not worth crashing the main process over —
    // the child exiting says the same thing, with more detail.
    child.stdin?.on("error", () => {});

    const exit = new Promise<SignInExit>((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error: error.message }));
      child.once("close", (code, signal) => resolve({ code, signal, error: null }));
    });

    return {
      onOutput: (listener) => listeners.push(listener),
      write: (text) => void child.stdin?.write(text),
      closeStdin: () => void child.stdin?.end(),
      kill: () => void child.kill(),
      exit,
    };
  };
}

let defaultSpawner: SignInSpawner | null = null;

interface Session {
  id: string;
  provider: AuthProvider;
  flow: SignInFlow;
  child: SignInProcess;
  transcript: () => string;
  /** Set by `cancelSignIn`, so the exit that follows is reported as a cancellation and not a failure. */
  cancelled: boolean;
}

const sessions = new Map<string, Session>();

export interface StartSignInOptions {
  provider: AuthProvider;
  /** What `resolveRuntime` found — EO's managed copy, or the agent's own `executablePath`. */
  executablePath: string | null;
  mode: SignInMode;
  /** Seam for tests. The real one spawns a CLI, which a unit test must never do. */
  spawn?: SignInSpawner;
  /** `shell.openExternal` in production, injected because this file must not import electron. */
  openExternal?: (url: string) => Promise<void>;
  urlTimeoutMs?: number;
  codeGraceMs?: number;
  newId?: () => string;
}

export interface StartSignInResult {
  ok: boolean;
  sessionId: string | null;
  url: string | null;
  verificationCode: string | null;
  needsCode: boolean;
  cliOpensBrowser: boolean;
  opened: boolean;
  transcript: string;
  problem: string | null;
}

export interface SubmitSignInOptions {
  sessionId: string;
  /**
   * Claude's authorization code, when the page displayed one. Null — or
   * blank — to only wait for the child to finish by itself, which every
   * flow does.
   */
  code: string | null;
  completionTimeoutMs?: number;
}

export interface SubmitSignInResult {
  ok: boolean;
  state: "signed_in" | "failed" | "cancelled";
  transcript: string;
  problem: string | null;
}

function failedStart(problem: string, transcript = "", flow?: SignInFlow): StartSignInResult {
  return {
    ok: false,
    sessionId: null,
    url: null,
    verificationCode: null,
    needsCode: flow?.needsCode ?? false,
    cliOpensBrowser: flow?.cliOpensBrowser ?? false,
    opened: false,
    transcript,
    problem,
  };
}

/** What a flow is called when EO has to say it does not exist. */
const MODE_NAMES: Record<SignInMode, string> = { browser: "browser", device: "device-code", console: "Anthropic Console" };

/** What the CLI said, preferred over anything EO could make up about it. */
function said(transcript: string): string {
  const trimmed = transcript.trim();
  return trimmed === "" ? "" : ` It printed:\n${trimmed}`;
}

/**
 * Begins a sign-in and waits only as far as the URL.
 *
 * Returning here rather than at the end of the flow is the point: the
 * dialog has to be on screen showing the URL while the browser half
 * happens, and for Codex that half is the whole sign-in.
 */
export async function startSignIn(options: StartSignInOptions): Promise<StartSignInResult> {
  const { provider, mode } = options;
  const label = RUNTIMES[provider].label;
  const flow = SIGN_IN_FLOWS[provider][mode];
  if (!flow) return failedStart(`${label} has no ${MODE_NAMES[mode]} sign-in.`);

  const executablePath = options.executablePath?.trim() ?? "";
  if (executablePath === "") {
    return failedStart(`EO has no ${label} executable to sign in with — nothing is installed and no executable path is set.`);
  }

  // A previous attempt still running holds the child's own listener
  // open, and Codex's is a fixed port: starting a second one on top of
  // it fails in a way that has nothing to do with the person's
  // credentials.
  cancelSignInsFor(provider);

  // Both Codex login paths delete `~/.codex/auth.json` before the flow
  // completes, so this machine is signed out from this moment — a
  // cached "signed in" from fifteen seconds ago is now a lie.
  invalidateRuntimeAuth(provider);

  const child = (options.spawn ?? (defaultSpawner ??= createSignInSpawner()))(executablePath, flow.argv);
  let transcript = "";
  const session: Session = { id: (options.newId ?? uuidv7)(), provider, flow, child, transcript: () => transcript, cancelled: false };

  const found = await new Promise<{ url: string; verificationCode: string | null } | { problem: string }>((resolve) => {
    let settled = false;
    let urlTimer: ReturnType<typeof setTimeout> | null = null;
    let codeTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (value: { url: string; verificationCode: string | null } | { problem: string }): void => {
      if (settled) return;
      settled = true;
      if (urlTimer) clearTimeout(urlTimer);
      if (codeTimer) clearTimeout(codeTimer);
      resolve(value);
    };

    // `final` means nothing more is coming — the child has exited, or
    // EO has stopped waiting. Until then a trailing match may still be
    // half-written, and a code may still be a line away.
    const look = (final: boolean): void => {
      const url = findSignInUrl(transcript, !final);
      if (url === null) return;
      const code = flow.printsVerificationCode ? findVerificationCode(transcript) : null;
      if (flow.printsVerificationCode && code === null && !final) {
        codeTimer ??= setTimeout(() => finish({ url, verificationCode: findVerificationCode(transcript) }), options.codeGraceMs ?? CODE_GRACE_MS);
        return;
      }
      finish({ url, verificationCode: code });
    };

    child.onOutput((chunk) => {
      transcript += String(chunk).replace(ANSI, "");
      look(false);
    });

    // Deliberately without a last look for a URL. A child that printed
    // one and then died has left nothing to finish the exchange with —
    // no listener, no stdin — so showing that URL would send somebody
    // off to sign in against a process that is not there. The transcript
    // goes back with the failure, so the URL is not hidden, only
    // stripped of the promise that following it would achieve anything.
    void child.exit.then((exit) => {
      const why = exit.error ?? (exit.signal !== null ? `it was killed (${exit.signal})` : `it exited with code ${exit.code ?? "unknown"}`);
      finish({ problem: `${label} stopped before the sign-in could start: ${why}.${said(transcript)}` });
    });

    urlTimer = setTimeout(() => {
      look(true);
      finish({
        problem:
          `${label} printed no sign-in URL within ${Math.round((options.urlTimeoutMs ?? URL_TIMEOUT_MS) / 1000)} seconds.` +
          `${said(transcript) || " It printed nothing at all."}`,
      });
    }, options.urlTimeoutMs ?? URL_TIMEOUT_MS);
  });

  if ("problem" in found) {
    child.kill();
    return failedStart(found.problem, transcript, flow);
  }

  // The URL is shown with a copy button whatever happens here: an
  // `openExternal` that resolves is not proof a browser appeared, and
  // one that rejects is not a reason to abandon a flow the person can
  // still complete by pasting. A CLI that opened the page itself has
  // printed its fallback, which EO leaves for the person to open only
  // if theirs did not appear.
  let opened = false;
  if (!flow.cliOpensBrowser) {
    try {
      await options.openExternal?.(found.url);
      opened = options.openExternal !== undefined;
    } catch {
      opened = false;
    }
  }

  sessions.set(session.id, session);
  return {
    ok: true,
    sessionId: session.id,
    url: found.url,
    verificationCode: found.verificationCode,
    needsCode: flow.needsCode,
    cliOpensBrowser: flow.cliOpensBrowser,
    opened,
    transcript,
    problem: null,
  };
}

/**
 * Hands the child what remains, if anything, and waits for it to exit.
 *
 * Every flow finishes by itself — the child's own localhost listener
 * takes the code — so the dialog calls this with no code as soon as the
 * flow starts, and that call is purely the wait. For Claude a second
 * call may carry the authorization code its fallback page displayed,
 * written to stdin with the newline the CLI is waiting for; both calls
 * wait on the same exit and answer alike.
 */
export async function submitSignInCode(options: SubmitSignInOptions): Promise<SubmitSignInResult> {
  const session = sessions.get(options.sessionId);
  if (!session) {
    return { ok: false, state: "failed", transcript: "", problem: "That sign-in is no longer running. Start it again." };
  }
  const label = RUNTIMES[session.provider].label;

  const code = (options.code ?? "").trim();
  // The newline is the submission: the CLI is blocked on a line read,
  // not on a byte count — which is also why a blank code is not written,
  // as an empty line would be a wrong answer rather than no answer.
  if (session.flow.needsCode && code !== "") session.child.write(`${code}\n`);
  // A code sent to a flow that does not take one is dropped rather than
  // written. Codex's code belongs to its own listener, and pushing one
  // into a child that is not reading stdin achieves nothing.

  const timeoutMs = options.completionTimeoutMs ?? COMPLETION_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const exit = await Promise.race([
    session.child.exit,
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  sessions.delete(session.id);
  // Whatever happened, the answer EO cached before this started
  // describes a binary whose credentials have since moved.
  invalidateRuntimeAuth(session.provider);
  const transcript = session.transcript();

  if (exit === "timeout") {
    session.child.kill();
    return {
      ok: false,
      state: "failed",
      transcript,
      problem: `${label} did not finish signing in within ${Math.round(timeoutMs / 60_000)} minutes, so EO stopped waiting.${said(transcript)}`,
    };
  }

  if (session.cancelled) {
    return { ok: false, state: "cancelled", transcript, problem: `Sign-in was cancelled, so ${label} is still signed out.` };
  }

  if (exit.error !== null) {
    return { ok: false, state: "failed", transcript, problem: `EO could not run ${label}: ${exit.error}` };
  }

  if (exit.code === 0) return { ok: true, state: "signed_in", transcript, problem: null };

  const why = exit.signal !== null ? `was killed (${exit.signal})` : `exited with code ${exit.code ?? "unknown"}`;
  return { ok: false, state: "failed", transcript, problem: `${label} ${why} without signing in.${said(transcript)}` };
}

/**
 * Kills the child.
 *
 * The session is marked before the kill, so the exit a pending
 * `submitSignInCode` is waiting on is reported as a cancellation rather
 * than as a sign-in that went wrong — a killed child must never look
 * like a failure the person should try to interpret, and must never
 * look like a success either.
 */
export function cancelSignIn(sessionId: string): { cancelled: boolean } {
  const session = sessions.get(sessionId);
  if (!session) return { cancelled: false };
  session.cancelled = true;
  sessions.delete(sessionId);
  session.child.kill();
  // Codex deleted its credentials on the way in, so an abandoned flow
  // has changed this machine even though nobody signed in.
  invalidateRuntimeAuth(session.provider);
  return { cancelled: true };
}

/** Every live sign-in for one provider, killed. Used when a second attempt starts on top of the first. */
export function cancelSignInsFor(provider: AuthProvider): void {
  for (const session of [...sessions.values()]) {
    if (session.provider === provider) cancelSignIn(session.id);
  }
}

/**
 * The other way in, for the CLI that has a flag for it (EO-84).
 *
 * `codex login --with-api-key` reads the key from stdin and the CLI
 * stores it in its own `auth.json`. EO's whole part is to spawn the
 * binary, write the key, close the pipe and report what happened — it
 * neither stores the key nor logs it, and holds nothing once the child
 * has exited.
 *
 * There is no browser half and nothing for a person to read, so this is
 * one call rather than a session: no URL to scrape, no code to carry, no
 * dialog to keep on screen. Claude has no equivalent flag, which is why
 * it is not here — a key typed into EO for Claude is stored with
 * `safeStorage` and injected at spawn instead, and `claude auth login
 * --console` is the flow for anyone who would rather EO held nothing.
 */
export interface ApiKeySignInOptions {
  /** Only the provider whose CLI takes one. Claude's key is stored by EO, not piped anywhere. */
  provider: "codex";
  /** What `resolveRuntime` found — EO's managed copy, or the agent's own `executablePath`. */
  executablePath: string | null;
  apiKey: string;
  /** Seam for tests. The real one spawns a CLI, which a unit test must never do. */
  spawn?: SignInSpawner;
  timeoutMs?: number;
}

export interface ApiKeySignInResult {
  ok: boolean;
  /** What the CLI printed, with the key scrubbed out of it. */
  transcript: string;
  problem: string | null;
}

/** The argv, verified against codex 0.151.0. The key is not on it — it goes to stdin. */
export const API_KEY_ARGV = ["login", "--with-api-key"];

/**
 * Long enough for a cold start and a round trip to the provider,
 * bounded because a CLI that decided to prompt for something else would
 * otherwise hold the dialog open forever on a question nobody can see.
 */
const API_KEY_TIMEOUT_MS = 60_000;

/**
 * Whatever the CLI printed, minus the key it was handed.
 *
 * The transcript is shown to the person and crosses IPC, so this is the
 * one place a piped key could plausibly come back out. `codex login
 * --with-api-key` does not echo stdin — but "does not today" is not a
 * property EO can assert about somebody else's binary, and invariant 5
 * is that where EO can check a claim independently it must. Scrubbing
 * costs one string replacement per sign-in.
 */
export function withoutSecret(transcript: string, secret: string): string {
  if (secret === "") return transcript;
  return transcript.split(secret).join("«api key»");
}

export async function signInWithApiKey(options: ApiKeySignInOptions): Promise<ApiKeySignInResult> {
  const label = RUNTIMES[options.provider].label;
  const executablePath = options.executablePath?.trim() ?? "";
  if (executablePath === "") {
    return { ok: false, transcript: "", problem: `EO has no ${label} executable to sign in with — nothing is installed and no executable path is set.` };
  }

  const key = options.apiKey.trim();
  if (key === "") return { ok: false, transcript: "", problem: `${label} needs an API key. Paste the one you want it to use.` };

  // A browser flow already running holds `localhost:1455` and is midway
  // through rewriting the same `auth.json` this is about to write. One
  // sign-in at a time, as `startSignIn` also insists.
  cancelSignInsFor(options.provider);
  // Whatever EO knew about this runtime a moment ago describes the
  // credentials it had a moment ago.
  invalidateRuntimeAuth(options.provider);

  const child = (options.spawn ?? (defaultSpawner ??= createSignInSpawner()))(executablePath, API_KEY_ARGV);
  let transcript = "";
  child.onOutput((chunk) => {
    transcript += String(chunk).replace(ANSI, "");
  });

  child.write(`${key}\n`);
  // The newline is for a line reader; the close is for a reader that
  // takes the whole stream. Which one the CLI is, is not EO's to know,
  // and a flow that only did the first would hang against the other.
  child.closeStdin?.();

  const timeoutMs = options.timeoutMs ?? API_KEY_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const exit = await Promise.race([
    child.exit,
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  // The CLI has just written its own credentials — or failed to — so the
  // cached answer is stale either way.
  invalidateRuntimeAuth(options.provider);
  const said = withoutSecret(transcript, key);

  if (exit === "timeout") {
    child.kill();
    return {
      ok: false,
      transcript: said,
      problem: `${label} did not finish within ${Math.round(timeoutMs / 1000)} seconds, so EO stopped waiting.${said.trim() === "" ? "" : ` It printed:\n${said.trim()}`}`,
    };
  }

  if (exit.error !== null) return { ok: false, transcript: said, problem: `EO could not run ${label}: ${exit.error}` };
  if (exit.code === 0) return { ok: true, transcript: said, problem: null };

  const why = exit.signal !== null ? `was killed (${exit.signal})` : `exited with code ${exit.code ?? "unknown"}`;
  return {
    ok: false,
    transcript: said,
    problem: `${label} ${why} without accepting the key.${said.trim() === "" ? "" : ` It printed:\n${said.trim()}`}`,
  };
}
