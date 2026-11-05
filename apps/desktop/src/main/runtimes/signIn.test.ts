import { beforeEach, describe, expect, it } from "vitest";
import { cachedRuntimeAuth, invalidateRuntimeAuth, runtimeAuth, type AuthProbeRunner } from "./auth.js";
import {
  cancelSignIn,
  findSignInUrl,
  findVerificationCode,
  signInWithApiKey,
  startSignIn,
  submitSignInCode,
  withoutSecret,
  type SignInExit,
  type SignInProcess,
  type SignInSpawner,
} from "./signIn.js";

/**
 * Signing a runtime in from the app (EO-83).
 *
 * Every test here drives a fake child process. Spawning a real `claude`
 * or `codex` would open a browser on whoever ran the suite's machine
 * and then sit waiting for them to sign in, which is not a test — it is
 * why the spawn sits behind a seam at all.
 *
 * The fake is deliberately dumb: it records what was written to stdin,
 * lets a test push output at whatever moment it wants, and exits when
 * told. Everything the flow claims about the two CLIs — that Claude's
 * code goes to stdin, that Codex's never does, that `codex login`
 * announces its own localhost listener before the URL that matters — is
 * expressed as output a test feeds in, so a change in either CLI shows
 * up here as a fixture that no longer matches rather than as a green
 * suite over a broken product.
 */
interface FakeChild extends SignInProcess {
  /** What the child "printed", pushed at a moment of the test's choosing. */
  say(chunk: string): void;
  /** Ends the process with this code, as `close` would. */
  end(exit?: Partial<SignInExit>): void;
  written: string[];
  killed: number;
  /** Whether the flow closed the pipe — `codex login --with-api-key` may be reading to EOF. */
  stdinClosed: boolean;
}

function fakeSpawner(): { spawn: SignInSpawner; calls: { command: string; args: string[] }[]; child: () => FakeChild } {
  const calls: { command: string; args: string[] }[] = [];
  let latest: FakeChild | null = null;

  const spawn: SignInSpawner = (command, args) => {
    calls.push({ command, args });
    const listeners: ((chunk: string) => void)[] = [];
    let settle: (exit: SignInExit) => void = () => {};
    const exit = new Promise<SignInExit>((resolve) => {
      settle = resolve;
    });
    let done = false;

    const child: FakeChild = {
      written: [],
      killed: 0,
      stdinClosed: false,
      onOutput: (listener) => listeners.push(listener),
      write: (text) => child.written.push(text),
      closeStdin: () => {
        child.stdinClosed = true;
      },
      kill: () => {
        child.killed += 1;
        // A killed child still exits, and the flow's whole cancellation
        // path hangs on that being true.
        child.end({ code: null, signal: "SIGTERM" });
      },
      exit,
      say: (chunk) => {
        for (const listener of [...listeners]) listener(chunk);
      },
      end: (result) => {
        if (done) return;
        done = true;
        settle({ code: 0, signal: null, error: null, ...result });
      },
    };
    latest = child;
    return child;
  };

  return { spawn, calls, child: () => latest! };
}

/** Everything the real `openExternal` is asked to do, without an Electron in the room. */
function fakeBrowser(): { openExternal: (url: string) => Promise<void>; opened: string[] } {
  const opened: string[] = [];
  return { openExternal: async (url) => void opened.push(url), opened };
}

/**
 * The output the pinned CLIs actually print, as far as this flow cares.
 *
 * `codex login` announcing its own listener *first* is the load-bearing
 * part of the Codex fixture: the first URL on its stdout is
 * `localhost:1455`, and a scrape that took it would open a browser at
 * the child's own socket and achieve nothing.
 */
const CLAUDE_OUTPUT = "Opening browser to sign in…\nhttps://claude.ai/oauth/authorize?code=true&client_id=abc\n\nPaste code here: ";
const CODEX_OUTPUT =
  "Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?client_id=app_codex&state=xyz\n";
const CODEX_DEVICE_OUTPUT = "Open https://auth.openai.com/device to sign in.\nYour one-time code is: WDJB-MJHT\n";

beforeEach(() => {
  invalidateRuntimeAuth();
});

describe("starting a Claude sign-in", () => {
  it("runs `auth login` against the resolved executable and opens what it printed", async () => {
    const { spawn, calls, child } = fakeSpawner();
    const browser = fakeBrowser();

    const started = startSignIn({ provider: "claude", executablePath: "/opt/eo/claude", mode: "browser", spawn, openExternal: browser.openExternal });
    child().say(CLAUDE_OUTPUT);
    const result = await started;

    expect(calls).toEqual([{ command: "/opt/eo/claude", args: ["auth", "login"] }]);
    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://claude.ai/oauth/authorize?code=true&client_id=abc");
    // Opened *and* returned: `openExternal` resolving is not proof a
    // browser appeared, so the dialog shows the URL regardless.
    expect(browser.opened).toEqual(["https://claude.ai/oauth/authorize?code=true&client_id=abc"]);
    expect(result.opened).toBe(true);
    // The code travels browser → person → EO → stdin, so the dialog
    // needs a field for it.
    expect(result.needsCode).toBe(true);
    expect(result.verificationCode).toBeNull();
  });

  it("writes the authorization code to stdin, with the newline the CLI is blocked on", async () => {
    const { spawn, child } = fakeSpawner();

    const started = startSignIn({ provider: "claude", executablePath: "/opt/eo/claude", mode: "browser", spawn });
    child().say(CLAUDE_OUTPUT);
    const session = await started;

    const finishing = submitSignInCode({ sessionId: session.sessionId!, code: " code-from-the-page " });
    // Trimmed, because a pasted code arrives with whatever whitespace
    // the page's copy button put around it.
    expect(child().written).toEqual(["code-from-the-page\n"]);

    child().end({ code: 0 });
    await expect(finishing).resolves.toMatchObject({ ok: true, state: "signed_in", problem: null });
  });

  it("refuses to submit nothing rather than blocking the child on an empty line", async () => {
    const { spawn, child } = fakeSpawner();
    const started = startSignIn({ provider: "claude", executablePath: "/opt/eo/claude", mode: "browser", spawn });
    child().say(CLAUDE_OUTPUT);
    const session = await started;

    const result = await submitSignInCode({ sessionId: session.sessionId!, code: "  " });

    expect(result).toMatchObject({ ok: false, state: "failed" });
    expect(result.problem).toContain("authorization code");
    expect(child().written).toEqual([]);
  });

  it("reports a non-zero exit with what the CLI actually said", async () => {
    const { spawn, child } = fakeSpawner();
    const started = startSignIn({ provider: "claude", executablePath: "/opt/eo/claude", mode: "browser", spawn });
    child().say(CLAUDE_OUTPUT);
    const session = await started;

    const finishing = submitSignInCode({ sessionId: session.sessionId!, code: "wrong" });
    child().say("Error: invalid authorization code\n");
    child().end({ code: 1 });

    const result = await finishing;
    expect(result).toMatchObject({ ok: false, state: "failed" });
    expect(result.problem).toContain("exited with code 1");
    // Whatever it printed, verbatim — EO has nothing better to offer
    // than the CLI's own diagnosis.
    expect(result.problem).toContain("invalid authorization code");
    expect(result.transcript).toContain("invalid authorization code");
  });
});

describe("starting a Codex sign-in", () => {
  it("runs `login`, skips the child's own listener, and offers no code field", async () => {
    const { spawn, calls, child } = fakeSpawner();
    const browser = fakeBrowser();

    const started = startSignIn({ provider: "codex", executablePath: "/opt/eo/codex", mode: "browser", spawn, openExternal: browser.openExternal });
    child().say(CODEX_OUTPUT);
    const result = await started;

    expect(calls).toEqual([{ command: "/opt/eo/codex", args: ["login"] }]);
    // Not `http://localhost:1455`: that is the child's own socket, and
    // opening a browser at it would achieve nothing.
    expect(result.url).toBe("https://auth.openai.com/oauth/authorize?client_id=app_codex&state=xyz");
    expect(browser.opened).toEqual(["https://auth.openai.com/oauth/authorize?client_id=app_codex&state=xyz"]);
    expect(result.needsCode).toBe(false);
    expect(result.verificationCode).toBeNull();
  });

  it("waits for the exit and never writes the code to the child", async () => {
    const { spawn, child } = fakeSpawner();
    const started = startSignIn({ provider: "codex", executablePath: "/opt/eo/codex", mode: "browser", spawn });
    child().say(CODEX_OUTPUT);
    const session = await started;

    // What the dialog sends: nothing at all. Codex's code goes from the
    // browser to the child's own listener and never passes through EO.
    const finishing = submitSignInCode({ sessionId: session.sessionId!, code: null });
    child().say("Successfully logged in\n");
    child().end({ code: 0 });

    await expect(finishing).resolves.toMatchObject({ ok: true, state: "signed_in" });
    expect(child().written).toEqual([]);
  });

  it("drops a code sent to a flow that does not take one", async () => {
    // Defensive: the dialog does not offer a field, but a channel is a
    // channel. Writing to a child that is not reading stdin would leave
    // a credential in a pipe nobody drains.
    const { spawn, child } = fakeSpawner();
    const started = startSignIn({ provider: "codex", executablePath: "/opt/eo/codex", mode: "browser", spawn });
    child().say(CODEX_OUTPUT);
    const session = await started;

    const finishing = submitSignInCode({ sessionId: session.sessionId!, code: "12345678" });
    child().end({ code: 0 });
    await finishing;

    expect(child().written).toEqual([]);
  });

  it("reports a non-zero exit from the browser half with what the CLI said", async () => {
    const { spawn, child } = fakeSpawner();
    const started = startSignIn({ provider: "codex", executablePath: "/opt/eo/codex", mode: "browser", spawn });
    child().say(CODEX_OUTPUT);
    const session = await started;

    const finishing = submitSignInCode({ sessionId: session.sessionId!, code: null });
    child().say("error: authorization was declined\n");
    child().end({ code: 1 });

    const result = await finishing;
    expect(result).toMatchObject({ ok: false, state: "failed" });
    expect(result.problem).toContain("exited with code 1");
    expect(result.problem).toContain("authorization was declined");
  });

  it("falls back to --device-auth, showing the URL and the code to type into the page", async () => {
    const { spawn, calls, child } = fakeSpawner();
    const started = startSignIn({ provider: "codex", executablePath: "/opt/eo/codex", mode: "device", spawn, codeGraceMs: 5 });
    child().say(CODEX_DEVICE_OUTPUT);
    const result = await started;

    expect(calls).toEqual([{ command: "/opt/eo/codex", args: ["login", "--device-auth"] }]);
    expect(result.url).toBe("https://auth.openai.com/device");
    // The opposite direction from Claude's: EO shows this one, the
    // person types it into the page, and it never comes back through EO.
    expect(result.verificationCode).toBe("WDJB-MJHT");
    expect(result.needsCode).toBe(false);
  });

  it("goes ahead with the URL when the device code never arrives", async () => {
    // The code scrape is a heuristic over wording that is not a
    // contract. Holding the dialog hostage over it would turn a
    // cosmetic CLI change into a sign-in nobody can start.
    const { spawn, child } = fakeSpawner();
    const started = startSignIn({ provider: "codex", executablePath: "/opt/eo/codex", mode: "device", spawn, codeGraceMs: 5 });
    child().say("Open https://auth.openai.com/device and follow the instructions.\n");
    const result = await started;

    expect(result).toMatchObject({ ok: true, url: "https://auth.openai.com/device", verificationCode: null });
    expect(result.transcript).toContain("follow the instructions");
  });

  it("has no device flow for Claude", async () => {
    const { spawn, calls } = fakeSpawner();

    const result = await startSignIn({ provider: "claude", executablePath: "/opt/eo/claude", mode: "device", spawn });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("no device-code sign-in");
    expect(calls).toEqual([]);
  });
});

describe("when nothing usable comes back", () => {
  it("fails with what the CLI printed rather than waiting on an invisible prompt", async () => {
    const { spawn, child } = fakeSpawner();

    const started = startSignIn({ provider: "claude", executablePath: "/opt/eo/claude", mode: "browser", spawn, urlTimeoutMs: 20 });
    child().say("Checking for updates…\n");
    const result = await started;

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("printed no sign-in URL");
    expect(result.problem).toContain("Checking for updates");
    expect(result.sessionId).toBeNull();
    // Nothing is left running: a child holding Codex's fixed port, or
    // Claude's blocked on a stdin nobody will ever write to, is the
    // hang this timeout exists to prevent.
    expect(child().killed).toBe(1);
  });

  it("says so when the CLI printed nothing at all", async () => {
    const { spawn } = fakeSpawner();

    const result = await startSignIn({ provider: "codex", executablePath: "/opt/eo/codex", mode: "browser", spawn, urlTimeoutMs: 20 });

    expect(result.problem).toContain("printed nothing at all");
  });

  it("reports a child that died before printing a URL", async () => {
    const { spawn, child } = fakeSpawner();

    const started = startSignIn({ provider: "codex", executablePath: "/opt/eo/codex", mode: "browser", spawn, urlTimeoutMs: 5_000 });
    child().say("error: config.toml is invalid\n");
    child().end({ code: 2 });
    const result = await started;

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("exited with code 2");
    expect(result.problem).toContain("config.toml is invalid");
  });

  it("does not offer a URL belonging to a child that has already died", async () => {
    // Following it would mean signing in against a process that is not
    // there, and then waiting for a completion nothing can deliver.
    const { spawn, child } = fakeSpawner();

    const started = startSignIn({ provider: "claude", executablePath: "/opt/eo/claude", mode: "browser", spawn, urlTimeoutMs: 5_000 });
    // Printed with nothing after it, so it was still arriving as far as
    // the scrape could tell — and then the process was gone.
    child().say("Sign in at https://claude.ai/oauth/authorize");
    child().end({ code: 1 });
    const result = await started;

    expect(result).toMatchObject({ ok: false, url: null, sessionId: null });
    expect(result.problem).toContain("exited with code 1");
    // Not hidden, just stripped of the promise that following it would
    // achieve anything.
    expect(result.transcript).toContain("https://claude.ai/oauth/authorize");
  });

  it("has nothing to run when no executable resolved", async () => {
    const { spawn, calls } = fakeSpawner();

    const result = await startSignIn({ provider: "claude", executablePath: null, mode: "browser", spawn });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("no Claude Code executable");
    expect(calls).toEqual([]);
  });

  it("stops waiting for a child that never finishes", async () => {
    const { spawn, child } = fakeSpawner();
    const started = startSignIn({ provider: "codex", executablePath: "/opt/eo/codex", mode: "browser", spawn });
    child().say(CODEX_OUTPUT);
    const session = await started;

    const result = await submitSignInCode({ sessionId: session.sessionId!, code: null, completionTimeoutMs: 20 });

    expect(result).toMatchObject({ ok: false, state: "failed" });
    expect(result.problem).toContain("did not finish signing in");
    expect(child().killed).toBe(1);
  });

  it("refuses a session that is no longer running", async () => {
    const result = await submitSignInCode({ sessionId: "01920000-0000-7000-8000-000000000000", code: "x" });

    expect(result).toMatchObject({ ok: false, state: "failed" });
    expect(result.problem).toContain("no longer running");
  });
});

describe("cancelling", () => {
  it.each(["claude", "codex"] as const)("kills the %s child and reports it as cancelled, not as a failure", async (provider) => {
    const { spawn, child } = fakeSpawner();
    const started = startSignIn({ provider, executablePath: `/opt/eo/${provider}`, mode: "browser", spawn });
    child().say(provider === "claude" ? CLAUDE_OUTPUT : CODEX_OUTPUT);
    const session = await started;

    // The dialog's wait is already in flight when Cancel is pressed —
    // which is the whole point for Codex, where the wait *is* the flow.
    const finishing = submitSignInCode({ sessionId: session.sessionId!, code: provider === "claude" ? "code" : null });
    expect(cancelSignIn(session.sessionId!)).toEqual({ cancelled: true });

    const result = await finishing;
    expect(child().killed).toBe(1);
    // Not `signed_in`, and not `failed` either: a killed child must
    // neither close the dialog as though it worked nor hand someone an
    // error to interpret.
    expect(result).toMatchObject({ ok: false, state: "cancelled" });
    expect(result.problem).toContain("cancelled");
  });

  it("says there was nothing to cancel when the flow has already finished", async () => {
    const { spawn, child } = fakeSpawner();
    const started = startSignIn({ provider: "codex", executablePath: "/opt/eo/codex", mode: "browser", spawn });
    child().say(CODEX_OUTPUT);
    const session = await started;

    const finishing = submitSignInCode({ sessionId: session.sessionId!, code: null });
    child().end({ code: 0 });
    await finishing;

    expect(cancelSignIn(session.sessionId!)).toEqual({ cancelled: false });
  });

  it("kills a leftover flow when a second one starts on the same runtime", async () => {
    // Codex's listener is on a fixed port, so a forgotten child is not
    // merely untidy: the next attempt fails for a reason that has
    // nothing to do with the person's credentials.
    const { spawn, child } = fakeSpawner();
    const first = startSignIn({ provider: "codex", executablePath: "/opt/eo/codex", mode: "browser", spawn });
    child().say(CODEX_OUTPUT);
    await first;
    const abandoned = child();

    const second = startSignIn({ provider: "codex", executablePath: "/opt/eo/codex", mode: "device", spawn, codeGraceMs: 5 });
    child().say(CODEX_DEVICE_OUTPUT);
    await second;

    expect(abandoned.killed).toBe(1);
  });
});

describe("what a sign-in does to the cached answer", () => {
  const signedIn: AuthProbeRunner = async () => ({ ok: true, stdout: "Logged in using ChatGPT", error: "", notFound: false });

  it("drops it the moment a Codex flow starts, because the CLI has deleted the credential", async () => {
    // Both `codex login` paths remove `~/.codex/auth.json` on the way
    // in. A cached "signed in" from fifteen seconds ago now describes a
    // machine that is signed out.
    await runtimeAuth({ provider: "codex", executablePath: "/opt/eo/codex", run: signedIn });
    expect(cachedRuntimeAuth("codex", "/opt/eo/codex").state).toBe("signed_in");

    const { spawn, child } = fakeSpawner();
    const started = startSignIn({ provider: "codex", executablePath: "/opt/eo/codex", mode: "browser", spawn });
    child().say(CODEX_OUTPUT);
    await started;

    expect(cachedRuntimeAuth("codex", "/opt/eo/codex").state).toBe("unknown");
  });

  it("drops it again when the flow ends, so the next question reaches the binary", async () => {
    const { spawn, child } = fakeSpawner();
    const started = startSignIn({ provider: "claude", executablePath: "/opt/eo/claude", mode: "browser", spawn });
    child().say(CLAUDE_OUTPUT);
    const session = await started;

    // An answer cached *during* the flow describes the half-signed-in
    // middle of it, which is nobody's idea of the truth.
    await runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run: signedIn });
    const finishing = submitSignInCode({ sessionId: session.sessionId!, code: "code" });
    child().end({ code: 0 });
    await finishing;

    expect(cachedRuntimeAuth("claude", "/opt/eo/claude").state).toBe("unknown");
  });
});

describe("reading what the CLI printed", () => {
  it("skips a localhost listener and takes the URL after it", () => {
    expect(findSignInUrl(CODEX_OUTPUT)).toBe("https://auth.openai.com/oauth/authorize?client_id=app_codex&state=xyz");
    expect(findSignInUrl("http://127.0.0.1:1455/callback\nhttps://example.com/auth\n")).toBe("https://example.com/auth");
  });

  it("waits for a URL that may still be arriving, and takes it on the last look", () => {
    // A chunk boundary mid-URL would otherwise open a browser at half
    // an address.
    expect(findSignInUrl("go to https://claude.ai/oauth/auth")).toBeNull();
    expect(findSignInUrl("go to https://claude.ai/oauth/auth", false)).toBe("https://claude.ai/oauth/auth");
  });

  it("does not take the sentence's punctuation with it", () => {
    expect(findSignInUrl("Visit https://example.com/auth?x=1. Then sign in.")).toBe("https://example.com/auth?x=1");
  });

  it("finds a device code in either the labelled or the shaped form", () => {
    expect(findVerificationCode("Your one-time code is: WDJB-MJHT\n")).toBe("WDJB-MJHT");
    expect(findVerificationCode("Enter WDJB-MJHT at https://auth.openai.com/device\n")).toBe("WDJB-MJHT");
    expect(findVerificationCode("No code here, just https://auth.openai.com/device\n")).toBeNull();
  });
});

/**
 * The Anthropic Console flow (EO-84).
 *
 * Claude's API-key path that leaves EO holding nothing: the same
 * browser-plus-paste shape as the subscription login, one flag apart, so
 * everything the subscription flow already does is reused rather than
 * re-implemented. What is worth asserting is the argv — a `--console`
 * that never reaches the child is a person signing into the wrong kind
 * of account and finding out on their invoice.
 */
describe("signing in through the Anthropic Console", () => {
  it("runs `auth login --console` and still carries the code to stdin", async () => {
    const { spawn, calls, child } = fakeSpawner();
    const browser = fakeBrowser();

    const started = startSignIn({ provider: "claude", executablePath: "/opt/eo/claude", mode: "console", spawn, openExternal: browser.openExternal });
    child().say("Opening browser…\nhttps://console.anthropic.com/oauth/authorize?code=true\n\nPaste code here: ");
    const result = await started;

    expect(calls).toEqual([{ command: "/opt/eo/claude", args: ["auth", "login", "--console"] }]);
    expect(result.url).toBe("https://console.anthropic.com/oauth/authorize?code=true");
    // The page displays a code, exactly as the subscription flow does.
    expect(result.needsCode).toBe(true);

    const finished = submitSignInCode({ sessionId: result.sessionId!, code: "console-code" });
    child().end({ code: 0 });

    expect(await finished).toMatchObject({ ok: true, state: "signed_in" });
    expect(child().written).toEqual(["console-code\n"]);
  });

  it("is Claude's alone — Codex answers a key with a flag, not a browser", async () => {
    const { spawn, calls } = fakeSpawner();

    const result = await startSignIn({ provider: "codex", executablePath: "/opt/eo/codex", mode: "console", spawn });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("Anthropic Console");
    expect(calls).toEqual([]); // nothing was spawned to find that out
  });
});

/**
 * Codex's API key, piped (EO-84).
 *
 * `codex login --with-api-key` reads the key from stdin and stores it
 * itself. The two things that must be true: the key is on stdin and not
 * on the argv — an argv is visible to every process listing on the
 * machine — and EO keeps nothing afterwards.
 */
describe("signing Codex in with an API key", () => {
  it("pipes the key to stdin, closes it, and puts nothing on the argv", async () => {
    const { spawn, calls, child } = fakeSpawner();

    const running = signInWithApiKey({ provider: "codex", executablePath: "/opt/eo/codex", apiKey: "sk-codex-secret", spawn });
    child().end({ code: 0 });
    const result = await running;

    expect(calls).toEqual([{ command: "/opt/eo/codex", args: ["login", "--with-api-key"] }]);
    // Not on the argv: `ps` on a shared machine would otherwise show it.
    expect(JSON.stringify(calls)).not.toContain("sk-codex-secret");
    expect(child().written).toEqual(["sk-codex-secret\n"]);
    // The newline is for a line reader; the close is for one that takes
    // the whole stream. A flow that only did the first would hang
    // against the other.
    expect(child().stdinClosed).toBe(true);
    expect(result).toEqual({ ok: true, transcript: "", problem: null });
  });

  it("reports a rejected key with what the CLI said, and never the key", async () => {
    const { spawn, child } = fakeSpawner();

    const running = signInWithApiKey({ provider: "codex", executablePath: "/opt/eo/codex", apiKey: "sk-codex-secret", spawn });
    child().say("error: the API key was rejected\n");
    child().end({ code: 1 });
    const result = await running;

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("the API key was rejected");
    expect(result.problem).not.toContain("sk-codex-secret");
  });

  it("scrubs the key out of the transcript, in case the CLI echoes it", async () => {
    // `codex login --with-api-key` does not echo stdin — but "does not
    // today" is not something EO can assert about somebody else's
    // binary, and this transcript is shown on screen and crosses IPC.
    const { spawn, child } = fakeSpawner();

    const running = signInWithApiKey({ provider: "codex", executablePath: "/opt/eo/codex", apiKey: "sk-codex-secret", spawn });
    child().say("read key sk-codex-secret from stdin\n");
    child().end({ code: 1 });
    const result = await running;

    expect(result.transcript).not.toContain("sk-codex-secret");
    expect(result.transcript).toContain("«api key»");
    expect(withoutSecret("nothing to redact", "sk-codex-secret")).toBe("nothing to redact");
  });

  it("gives up rather than waiting forever on a CLI that says nothing", async () => {
    const { spawn, child } = fakeSpawner();

    const result = await signInWithApiKey({
      provider: "codex",
      executablePath: "/opt/eo/codex",
      apiKey: "sk-codex-secret",
      spawn,
      timeoutMs: 5,
    });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("stopped waiting");
    expect(child().killed).toBe(1);
  });

  it("says so when there is no executable to pipe to", async () => {
    const { spawn, calls } = fakeSpawner();

    const result = await signInWithApiKey({ provider: "codex", executablePath: null, apiKey: "sk-codex-secret", spawn });

    expect(result).toEqual({ ok: false, transcript: "", problem: expect.stringContaining("no Codex executable") });
    expect(calls).toEqual([]);
  });

  it("drops the cached auth answer at both ends, so the status re-probes", async () => {
    const { spawn, child } = fakeSpawner();
    const probe: AuthProbeRunner = async () => ({ ok: false, stdout: "Not logged in", error: "", notFound: false });
    await runtimeAuth({ provider: "codex", executablePath: "/opt/eo/codex", run: probe });
    expect(cachedRuntimeAuth("codex", "/opt/eo/codex").state).toBe("signed_out");

    const running = signInWithApiKey({ provider: "codex", executablePath: "/opt/eo/codex", apiKey: "sk-codex-secret", spawn });
    child().end({ code: 0 });
    await running;

    // The CLI has just written its own credentials; what EO knew a
    // moment ago describes the ones it had before.
    expect(cachedRuntimeAuth("codex", "/opt/eo/codex").state).toBe("unknown");
  });
});
