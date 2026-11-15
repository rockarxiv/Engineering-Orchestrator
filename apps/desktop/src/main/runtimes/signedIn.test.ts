import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeId } from "./catalog.js";
import * as auth from "./auth.js";
import { cachedRuntimeAuth, runtimeAuth, type AuthProbeRunner } from "./auth.js";
import { onRuntimeSignedIn, runtimeSignedIn } from "./signedIn.js";
import { cancelSignIn, signInWithApiKey, startSignIn, submitSignInCode, type SignInExit, type SignInSpawner } from "./signIn.js";

vi.mock("./auth.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./auth.js")>();
  return { ...original, invalidateRuntimeAuth: vi.fn(original.invalidateRuntimeAuth) };
});

/**
 * "A runtime was just signed in", heard in main (EO-795).
 *
 * The Sign in button on a runtime's message opens `SignInDialog`, which
 * ends in `runtime:submitSignInCode` (or `runtime:signInWithApiKey`).
 * When the CLI says that worked, main drops the cached auth answer and
 * tells whoever subscribed — the hook a later story lifts a block from.
 */

/** A child that prints and exits when told, which is all these tests need of `claude auth login` / `codex login`. */
function fakeSpawner(): { spawn: SignInSpawner; say: (chunk: string) => void; end: (exit?: Partial<SignInExit>) => void } {
  let settle: (exit: SignInExit) => void = () => {};
  const listeners: ((chunk: string) => void)[] = [];
  const spawn: SignInSpawner = () => {
    const exit = new Promise<SignInExit>((resolve) => {
      settle = resolve;
    });
    return {
      onOutput: (listener) => void listeners.push(listener),
      write: () => {},
      closeStdin: () => {},
      kill: () => settle({ code: null, signal: "SIGTERM", error: null }),
      exit,
    };
  };
  return {
    spawn,
    say: (chunk) => {
      for (const listener of [...listeners]) listener(chunk);
    },
    end: (exit) => settle({ code: 0, signal: null, error: null, ...exit }),
  };
}

/** What each CLI prints before the sign-in can be waited on (the fixtures in signIn.test.ts, cut to what the flow reads). */
const PRINTS: Record<RuntimeId, string> = {
  claude: "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true\nPaste code here if prompted > ",
  codex: "Open https://auth.openai.com/device to sign in.\nYour one-time code is: WDJB-MJHT\n",
};
const MODES: Record<RuntimeId, "browser" | "device"> = { claude: "browser", codex: "device" };

async function started(provider: RuntimeId) {
  const child = fakeSpawner();
  const starting = startSignIn({ provider, executablePath: `/opt/eo/${provider}`, mode: MODES[provider], spawn: child.spawn });
  child.say(PRINTS[provider]);
  const session = await starting;
  return { child, sessionId: session.sessionId! };
}

const signedInProbe: AuthProbeRunner = async () => ({ ok: true, stdout: '{"loggedIn": true}', error: "", notFound: false });

let heard: RuntimeId[];
let stop: () => void;

beforeEach(() => {
  auth.invalidateRuntimeAuth();
  vi.mocked(auth.invalidateRuntimeAuth).mockClear();
  heard = [];
  stop = onRuntimeSignedIn((runtime) => heard.push(runtime));
});

afterEach(() => stop());

describe("a runtime signed in", () => {
  it("drops the cached answer and tells every listener, the cache already gone when they hear it", async () => {
    await runtimeAuth({ provider: "claude", executablePath: "/opt/eo/claude", run: signedInProbe });
    vi.mocked(auth.invalidateRuntimeAuth).mockClear();
    const seen: string[] = [];
    const stopSecond = onRuntimeSignedIn(() => seen.push(cachedRuntimeAuth("claude", "/opt/eo/claude").state));

    runtimeSignedIn("claude");
    stopSecond();

    expect(auth.invalidateRuntimeAuth).toHaveBeenCalledWith("claude");
    expect(heard).toEqual(["claude"]);
    expect(seen).toEqual(["unknown"]);
  });

  it("still tells the rest when one listener throws, and stops telling one that unsubscribed", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const stopBroken = onRuntimeSignedIn(() => {
      throw new Error("broken");
    });
    runtimeSignedIn("codex");
    stopBroken();
    stop();
    runtimeSignedIn("codex");
    quiet.mockRestore();

    expect(heard).toEqual(["codex"]);
  });
});

describe("what the sign-in dialog's flows fire", () => {
  for (const provider of ["claude", "codex"] as const) {
    it(`fires for ${provider} when the CLI's login exits 0`, async () => {
      const { child, sessionId } = await started(provider);
      vi.mocked(auth.invalidateRuntimeAuth).mockClear();

      const waiting = submitSignInCode({ sessionId, code: null });
      child.end({ code: 0 });

      await expect(waiting).resolves.toMatchObject({ state: "signed_in" });
      expect(auth.invalidateRuntimeAuth).toHaveBeenCalledWith(provider);
      expect(heard).toEqual([provider]);
    });
  }

  it("fires nothing when the login fails or is cancelled", async () => {
    const first = await started("claude");
    const failed = submitSignInCode({ sessionId: first.sessionId, code: null });
    first.child.end({ code: 1 });
    await expect(failed).resolves.toMatchObject({ state: "failed" });

    const second = await started("claude");
    const waiting = submitSignInCode({ sessionId: second.sessionId, code: null });
    cancelSignIn(second.sessionId);
    await expect(waiting).resolves.toMatchObject({ state: "cancelled" });

    expect(heard).toEqual([]);
  });

  it("fires for Codex when its API key is taken, and not when it is refused", async () => {
    const taken = fakeSpawner();
    const ok = signInWithApiKey({ provider: "codex", executablePath: "/opt/eo/codex", apiKey: "sk-test", spawn: taken.spawn });
    taken.end({ code: 0 });
    await expect(ok).resolves.toMatchObject({ ok: true });

    const refused = fakeSpawner();
    const no = signInWithApiKey({ provider: "codex", executablePath: "/opt/eo/codex", apiKey: "sk-test", spawn: refused.spawn });
    refused.end({ code: 1 });
    await expect(no).resolves.toMatchObject({ ok: false });

    expect(heard).toEqual(["codex"]);
  });
});
