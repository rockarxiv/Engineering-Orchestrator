import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedRuntimeAuth,
  createAuthProbeRunner,
  checkRuntimeAuth,
  invalidateRuntimeAuth,
  probeRuntimeAuth,
  runtimeAuth,
  type AuthProbeResult,
  type AuthProbeRunner,
} from "./auth.js";

/**
 * Asking a runtime whether it is signed in (EO-82).
 *
 * Every test here runs against a stubbed runner. Spawning a real
 * `claude` or `codex` would make the suite depend on whoever ran it
 * being signed in, which is the exact class of mistake the old $HOME
 * probe was: an answer about the machine the test happens to be on
 * rather than about the code.
 *
 * The load-bearing property is that `unknown` never becomes
 * `signed_out`. Dispatch refuses on `signed_out`, so a probe that
 * timed out, or a CLI that printed something new, must not park work on
 * a machine that could have done it.
 */
function answering(result: Partial<AuthProbeResult>): { run: AuthProbeRunner; calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = [];
  const run: AuthProbeRunner = async (command, args) => {
    calls.push({ command, args });
    return { ok: true, stdout: "", error: "", notFound: false, ...result };
  };
  return { run, calls };
}

beforeEach(() => {
  // Module-level cache: without this, one test's answer is the next
  // test's cached answer.
  invalidateRuntimeAuth();
});

describe("the Claude probe", () => {
  it("asks the resolved executable, not $HOME", async () => {
    const { run, calls } = answering({ stdout: JSON.stringify({ loggedIn: true }) });

    await probeRuntimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run });

    expect(calls).toEqual([{ command: "/opt/eo/claude", args: ["auth", "status", "--json"] }]);
  });

  it("reports signed in, with what the CLI said about who", async () => {
    const { run } = answering({
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: "claudeai",
        email: "someone@example.com",
        orgName: "Example",
        subscriptionType: "max",
      }),
    });

    expect(await probeRuntimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run })).toEqual({
      state: "signed_in",
      method: "claudeai",
      // EO-84: the normalised half of the same answer. "claudeai" is a
      // subscription however the next release of the CLI spells it.
      kind: "subscription",
      storedKey: false,
      account: "someone@example.com",
      problem: null,
    });
  });

  it("reports signed out when the CLI says so", async () => {
    const { run } = answering({ stdout: JSON.stringify({ loggedIn: false }) });

    expect(await probeRuntimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run })).toEqual({
      state: "signed_out",
      method: null,
      kind: "unknown",
      storedKey: false,
      account: null,
      problem: null,
    });
  });

  it("trusts the JSON over the exit code", async () => {
    // A CLI that answers the question and then exits non-zero has still
    // answered it. Reporting `unknown` over the top would throw away
    // the one fact this story exists to surface.
    const { run } = answering({ ok: false, stdout: JSON.stringify({ loggedIn: false }), error: "not authenticated" });

    expect((await probeRuntimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run })).state).toBe("signed_out");
  });

  it("says unknown, never signed out, when the binary is missing", async () => {
    const { run } = answering({ ok: false, notFound: true, error: "spawn ENOENT" });

    const auth = await probeRuntimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run });

    expect(auth.state).toBe("unknown");
    expect(auth.problem).toContain("not there");
  });

  it("says unknown when there is no executable to ask at all", async () => {
    const { run, calls } = answering({});

    const auth = await probeRuntimeAuth({ provider: "claude", executablePath: null, run });

    expect(auth.state).toBe("unknown");
    expect(auth.problem).toContain("no Claude Code executable");
    expect(calls).toEqual([]); // nothing to spawn, so nothing was spawned
  });

  it("says unknown on a non-zero exit with nothing to read", async () => {
    const { run } = answering({ ok: false, error: "killed after 15000ms" });

    const auth = await probeRuntimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run });

    expect(auth.state).toBe("unknown");
    expect(auth.problem).toContain("killed after 15000ms");
  });

  it("says unknown when the output cannot be parsed", async () => {
    // A future CLI that changes its output shape must degrade to "EO
    // could not tell", not to "signed out" — which would refuse every
    // dispatch on a perfectly working machine.
    const { run } = answering({ stdout: "Auth status: fine, thanks" });

    const auth = await probeRuntimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run });

    expect(auth.state).toBe("unknown");
    expect(auth.problem).toContain("Auth status: fine, thanks");
  });

  it("says unknown when the JSON parses but carries no answer", async () => {
    const { run } = answering({ stdout: JSON.stringify({ apiProvider: "anthropic" }) });

    expect((await probeRuntimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run })).state).toBe("unknown");
  });

  it("survives a runner that throws", async () => {
    const run: AuthProbeRunner = () => {
      throw new Error("EACCES");
    };

    const auth = await probeRuntimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run });

    expect(auth.state).toBe("unknown");
    expect(auth.problem).toContain("EACCES");
  });
});

describe("the Codex probe", () => {
  it("asks the resolved executable", async () => {
    const { run, calls } = answering({ stdout: "Logged in using ChatGPT" });

    await probeRuntimeAuth({ provider: "codex", executablePath: "/opt/eo/codex", run });

    expect(calls).toEqual([{ command: "/opt/eo/codex", args: ["login", "status"] }]);
  });

  it("reads the sentence the CLI prints", async () => {
    const { run } = answering({ stdout: "Logged in using ChatGPT" });

    expect(await probeRuntimeAuth({ provider: "codex", executablePath: "/opt/eo/codex", run })).toEqual({
      state: "signed_in",
      method: "ChatGPT",
      kind: "subscription",
      storedKey: false,
      account: null,
      problem: null,
    });
  });

  it("picks the account out when it is printed", async () => {
    const { run } = answering({ stdout: "Logged in using ChatGPT (someone@example.com)" });

    expect(await probeRuntimeAuth({ provider: "codex", executablePath: "/opt/eo/codex", run })).toMatchObject({
      state: "signed_in",
      method: "ChatGPT",
      account: "someone@example.com",
    });
  });

  it("reads 'Not logged in' as signed out rather than signed in", async () => {
    // "Not logged in" contains "logged in". Matching in the wrong order
    // reports the exact opposite of the truth.
    const { run } = answering({ ok: false, stdout: "Not logged in. Run `codex login` to sign in." });

    expect(await probeRuntimeAuth({ provider: "codex", executablePath: "/opt/eo/codex", run })).toEqual({
      state: "signed_out",
      method: null,
      kind: "unknown",
      storedKey: false,
      account: null,
      problem: null,
    });
  });

  it("reads a signed-out answer off stderr too", async () => {
    const { run } = answering({ ok: false, stdout: "", error: "Not logged in" });

    expect((await probeRuntimeAuth({ provider: "codex", executablePath: "/opt/eo/codex", run })).state).toBe("signed_out");
  });

  it("says unknown, never signed out, when the binary is missing", async () => {
    const { run } = answering({ ok: false, notFound: true, error: "spawn ENOENT" });

    const auth = await probeRuntimeAuth({ provider: "codex", executablePath: "/opt/eo/codex", run });

    expect(auth.state).toBe("unknown");
    expect(auth.problem).toContain("not there");
  });

  it("says unknown on a non-zero exit that says nothing about credentials", async () => {
    const { run } = answering({ ok: false, error: "error: unexpected argument 'status'" });

    const auth = await probeRuntimeAuth({ provider: "codex", executablePath: "/opt/eo/codex", run });

    expect(auth.state).toBe("unknown");
    expect(auth.problem).toContain("unexpected argument");
  });

  it("says unknown when the output cannot be parsed", async () => {
    const { run } = answering({ stdout: "codex 0.147.0" });

    expect((await probeRuntimeAuth({ provider: "codex", executablePath: "/opt/eo/codex", run })).state).toBe("unknown");
  });
});

describe("the cache", () => {
  it("answers a second question without spawning again", async () => {
    // Rendering the Runtimes tab asks per card, per render. Without
    // this, describing a machine spawns a process every time React
    // decides to draw.
    const { run, calls } = answering({ stdout: JSON.stringify({ loggedIn: true }) });

    await runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run });
    await runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run });

    expect(calls).toHaveLength(1);
  });

  it("asks once for concurrent questions", async () => {
    let resolveProbe: ((result: AuthProbeResult) => void) | null = null;
    const calls: string[] = [];
    const run: AuthProbeRunner = (command) => {
      calls.push(command);
      return new Promise((resolve) => {
        resolveProbe = resolve;
      });
    };

    const both = Promise.all([
      runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run }),
      runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run }),
    ]);
    await vi.waitFor(() => expect(resolveProbe).not.toBeNull());
    resolveProbe!({ ok: true, stdout: JSON.stringify({ loggedIn: true }), error: "", notFound: false });

    expect((await both).map((auth) => auth.state)).toEqual(["signed_in", "signed_in"]);
    expect(calls).toHaveLength(1);
  });

  it("asks again once the answer has aged out", async () => {
    const { run, calls } = answering({ stdout: JSON.stringify({ loggedIn: true }) });
    let clock = 1_000;

    await runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run, now: () => clock });
    clock += 60_000;
    await runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run, now: () => clock });

    expect(calls).toHaveLength(2);
  });

  it("keeps two executables apart", async () => {
    const runner: AuthProbeRunner = async (command) => ({
      ok: true,
      stdout: JSON.stringify({ loggedIn: command === "/opt/eo/claude" }),
      error: "",
      notFound: false,
    });

    expect((await runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run: runner })).state).toBe("signed_in");
    expect((await runtimeAuth({ provider: "claude", executablePath: "/usr/local/bin/claude", run: runner })).state).toBe("signed_out");
  });

  it("forgets what it knew when told to", async () => {
    // What an install does: the copy on disk is not the copy the cached
    // answer was about, and a freshly downloaded runtime nobody has
    // signed into must not inherit "signed in" from its predecessor.
    const { run, calls } = answering({ stdout: JSON.stringify({ loggedIn: true }) });

    await runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run });
    invalidateRuntimeAuth("claude");
    await runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run });

    expect(calls).toHaveLength(2);
  });

  it("leaves the other provider's answer alone", async () => {
    const { run, calls } = answering({ stdout: JSON.stringify({ loggedIn: true }) });

    await runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run });
    invalidateRuntimeAuth("codex");
    await runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run });

    expect(calls).toHaveLength(1);
  });

  it("does not answer from a probe that was already running when the binary changed", async () => {
    // The install-time race. Rendering the Runtimes tab starts a probe;
    // the download finishes while it is still running. Forgetting only
    // the *completed* answers would leave that promise in place, and
    // the next question would be answered by a probe of the copy the
    // install just deleted.
    const pending: ((result: AuthProbeResult) => void)[] = [];
    const run: AuthProbeRunner = () => new Promise((resolve) => void pending.push(resolve));

    const before = runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run });
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    invalidateRuntimeAuth("claude");
    const after = runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run });

    // A second spawn, rather than a second subscriber to the first.
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0]!({ ok: true, stdout: JSON.stringify({ loggedIn: true }), error: "", notFound: false });
    pending[1]!({ ok: true, stdout: JSON.stringify({ loggedIn: false }), error: "", notFound: false });

    expect((await before).state).toBe("signed_in"); // the caller that asked first still gets what it asked
    expect((await after).state).toBe("signed_out"); // and the one that asked after the install gets the truth
  });

  it("throws away an answer that lands after the binary it described was replaced", async () => {
    // The other half of the same race, and the one ordering makes
    // invisible: the stale probe finishing *last*. Dropping it from the
    // in-flight map is not enough — when it resolves it would write
    // itself into the cache, handing the freshly downloaded runtime the
    // credentials of the one it replaced.
    const pending: ((result: AuthProbeResult) => void)[] = [];
    const run: AuthProbeRunner = () => new Promise((resolve) => void pending.push(resolve));

    const before = runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    invalidateRuntimeAuth("claude");

    const after = runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!({ ok: true, stdout: JSON.stringify({ loggedIn: false }), error: "", notFound: false });
    await after;
    // Only now, and about a copy that is no longer on disk. Awaited, so
    // the assertion runs after whatever it was going to do to the cache.
    pending[0]!({ ok: true, stdout: JSON.stringify({ loggedIn: true }), error: "", notFound: false });
    await before;

    expect(cachedRuntimeAuth("claude", "/opt/eo/claude").state).toBe("signed_out");
  });
});

describe("the dispatch preflight", () => {
  it("refuses a signed-out runtime, and says where to fix it", async () => {
    const { run } = answering({ stdout: JSON.stringify({ loggedIn: false }) });

    const result = await checkRuntimeAuth({
      provider: "claude",
      agentName: "Implementer",
      executablePath: "/opt/eo/claude",
      run,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Agents → Runtimes");
    expect(result.reason).toContain("Implementer");
    expect(result.reason).toContain("/opt/eo/claude"); // which copy, since an agent can carry its own
  });

  it("no longer tells anyone to run a CLI in a terminal", async () => {
    // The machine this story is about is a desktop-only one whose only
    // copy of these tools came from EO. It has no terminal to run
    // `claude` in, so the old advice was unfollowable.
    const { run } = answering({ ok: false, stdout: "Not logged in" });

    const result = await checkRuntimeAuth({ provider: "codex", agentName: "Reviewer", executablePath: "/opt/eo/codex", run });

    expect(result.reason).not.toMatch(/terminal/i);
    expect(result.reason).not.toMatch(/run `?codex login`?/i);
  });

  it("lets an unknown answer through rather than parking the work", async () => {
    const { run } = answering({ ok: false, notFound: true, error: "spawn ENOENT" });

    expect(await checkRuntimeAuth({ provider: "claude", agentName: "Implementer", executablePath: "/opt/eo/claude", run })).toEqual({
      ok: true,
    });
  });

  it("passes a signed-in runtime", async () => {
    const { run } = answering({ stdout: "Logged in using ChatGPT" });

    expect(await checkRuntimeAuth({ provider: "codex", agentName: "Reviewer", executablePath: "/opt/eo/codex", run })).toEqual({ ok: true });
  });

  it("asks nothing of a backend that runs in EO's own process", async () => {
    const { run, calls } = answering({});

    expect(await checkRuntimeAuth({ provider: "fake", agentName: "Implementer", executablePath: null, run })).toEqual({ ok: true });
    expect(calls).toEqual([]);
  });
});

/**
 * Which way in is being used (EO-84).
 *
 * The card has to distinguish a subscription from an API key, and
 * neither CLI spells either one the same way. What matters here is the
 * failure that would be worst: calling an API key a subscription, on a
 * screen somebody reads to find out what they are being billed for.
 */
describe("the method in use", () => {
  it("reads Claude's Console sign-in as an API key, not as a subscription", async () => {
    // `subscriptionType` is printed either way, so a subscription-first
    // match would call this one a subscription on the strength of a
    // field that is always there.
    const { run } = answering({
      stdout: JSON.stringify({ loggedIn: true, authMethod: "console", apiProvider: "anthropic", subscriptionType: "unknown" }),
    });

    expect(await probeRuntimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run })).toMatchObject({
      state: "signed_in",
      kind: "api_key",
      storedKey: false, // the CLI's key, not EO's — nothing here to remove
    });
  });

  it("reads Claude's apiKey method as an API key", async () => {
    const { run } = answering({ stdout: JSON.stringify({ loggedIn: true, authMethod: "apiKey" }) });

    expect((await probeRuntimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run })).kind).toBe("api_key");
  });

  it("reads Codex's API-key sentence as an API key", async () => {
    const { run } = answering({ stdout: "Logged in using an API key" });

    expect(await probeRuntimeAuth({ provider: "codex", executablePath: "/opt/eo/codex", run })).toMatchObject({
      state: "signed_in",
      kind: "api_key",
      // The key went to `codex login --with-api-key` and the CLI has it.
      // EO has nothing to remove and must not offer to.
      storedKey: false,
    });
  });

  it("reads Codex 0.165.0's API-key sentence as an API key too (EO-599)", async () => {
    // Verbatim from `codex login status` at 0.165.0, and word for word the same at 0.166.0 (EO-644), with a key stored by
    // `login --with-api-key`; 0.163.0 printed "Logged in using an API key - sk-…".
    const { run } = answering({ stdout: "API key configured - sk-eo599***bogus\nAuthentication is checked when you send a request." });

    expect(await probeRuntimeAuth({ provider: "codex", executablePath: "/opt/eo/codex", run })).toMatchObject({
      state: "signed_in",
      method: "API key",
      kind: "api_key",
      storedKey: false,
      account: null,
    });
  });

  it("answers unknown for a method nobody here has seen, rather than guessing", async () => {
    // An unrecognised method is not evidence of a subscription. Saying
    // "Subscription" over an API key would be wrong about the thing
    // somebody is paying for.
    const { run } = answering({ stdout: JSON.stringify({ loggedIn: true, authMethod: "something-new" }) });

    expect((await probeRuntimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run })).kind).toBe("unknown");
  });

  it("says nothing about the method of a runtime that is signed out", async () => {
    const { run } = answering({ stdout: JSON.stringify({ loggedIn: false, subscriptionType: "max" }) });

    expect((await probeRuntimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run })).kind).toBe("unknown");
  });
});

/**
 * A key EO holds is a credential the binary cannot see (EO-84).
 *
 * It is injected as `ANTHROPIC_API_KEY` when the provider spawns, and
 * the probe EO would run to ask has no such key in its environment. So
 * asking would report the opposite of the truth, and dispatch — which
 * refuses on `signed_out` — would park work on a machine that can do it.
 */
describe("a key EO is holding", () => {
  it("reports signed in with an API key, without spawning anything", async () => {
    const { run, calls } = answering({ stdout: JSON.stringify({ loggedIn: false }) });

    expect(await probeRuntimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", storedKey: true, run })).toEqual({
      state: "signed_in",
      method: "API key",
      kind: "api_key",
      storedKey: true,
      account: null,
      problem: null,
    });
    expect(calls).toEqual([]);
  });

  it("answers even before a runtime is resolved", async () => {
    // The key is what makes it usable; a binary is a separate question,
    // and reporting "EO has nothing to ask" over the top of the key
    // would hide the thing the person just did.
    expect(await probeRuntimeAuth({ provider: "claude", executablePath: null, storedKey: true })).toMatchObject({
      state: "signed_in",
      storedKey: true,
    });
  });

  it("goes back to what the binary says once the key is gone", async () => {
    // The acceptance criterion for the Remove button: with nothing
    // stored, the question returns to the CLI and the CLI says what it
    // always said.
    const { run } = answering({ stdout: JSON.stringify({ loggedIn: false }) });

    await runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", storedKey: true, run });
    const after = await runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", storedKey: false, run });

    expect(after).toMatchObject({ state: "signed_out", storedKey: false });
  });

  it("does not let dispatch refuse the one credential EO itself is injecting", async () => {
    const { run } = answering({ stdout: JSON.stringify({ loggedIn: false }) });

    expect(
      await checkRuntimeAuth({ provider: "claude", agentName: "Implementer", executablePath: "/opt/eo/claude", storedKey: true, run }),
    ).toEqual({ ok: true });
  });

  it("is Claude's alone — a Codex key belongs to the Codex CLI", async () => {
    // Nothing stores one for Codex, but if a caller ever passed the
    // flag, the answer must still come from the binary that holds the
    // credential rather than from a claim about EO's keychain.
    const { run, calls } = answering({ ok: false, stdout: "Not logged in" });

    expect(await probeRuntimeAuth({ provider: "codex", executablePath: "/opt/eo/codex", storedKey: true, run })).toMatchObject({
      state: "signed_out",
    });
    expect(calls).toHaveLength(1);
  });
});

describe("a probe that can be stopped (EO-477)", () => {
  it.skipIf(process.platform === "win32")("kills the probe's process when its signal ends, and answers at once", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = createAuthProbeRunner(30_000, controller.signal)("sleep", ["20"]);
    setTimeout(() => controller.abort(), 20);

    const result = await pending;

    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
