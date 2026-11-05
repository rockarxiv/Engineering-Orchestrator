import type { AgentProvider } from "@eo/core";
import { cachedRuntimeAuth, createAuthProbeRunner, probeRuntimeAuth, type AuthProvider } from "../runtimes/auth.js";
import { RUNTIMES } from "../runtimes/catalog.js";
import { createClaudeProvider } from "./claude.js";
import { createCodexProvider } from "./codex.js";
import { personCodexHome, sideCallKeyringRefusal, signInIsInKeyring } from "./codexHome.js";

/**
 * The adapters EO's side calls run on (EO-477), one per backend.
 *
 * Built for side calls and nothing else, rather than borrowed from an
 * agent: a side call belongs to no agent — consolidation is a scope's,
 * not anybody's — and an agent's provider carries that agent's servers,
 * skills, admin grant and Codex home, none of which a side call may
 * have. What is left is the runtime: the binary, the SDK, the sign-in
 * EO holds, and a Codex home of the side calls' own.
 */
export interface SideCallRuntime {
  /** The CLI EO resolved for this backend, as a dispatch would run it. */
  executablePath: string | null;
  /** Where the Claude Agent SDK is, which only Claude's adapter loads. */
  claudeSdkEntryPath: () => string | null;
  /** The Claude API key EO holds, read at spawn. */
  claudeApiKey?: () => string | null;
  /** The side calls' own Codex home, made ready before each call (`SIDE_CALL_CODEX_HOME`). */
  codexHome?: () => string | null;
}

/** Null for a backend with no side calls of its own — the fake and the demo, which answer from a script. */
export function createSideCallProvider(backend: string, runtime: SideCallRuntime): AgentProvider | null {
  if (backend === "claude") {
    return createClaudeProvider({
      executablePath: runtime.executablePath,
      sdkEntryPath: runtime.claudeSdkEntryPath(),
      ...(runtime.claudeApiKey ? { apiKey: runtime.claudeApiKey } : {}),
    });
  }
  if (backend === "codex") {
    return createCodexProvider({ executablePath: runtime.executablePath, ...(runtime.codexHome ? { codexHome: runtime.codexHome } : {}) });
  }
  return null;
}

/**
 * Whether a side call on this backend has a sign-in to run with — the
 * same probe a dispatch's preflight asks, and a key EO holds counts for
 * Claude as it does there (EO-84).
 *
 * The cached answer when it is fresh. Otherwise a probe of the side
 * call's own, not the shared one, because it is handed the call's
 * signal: a call stopped at its deadline or by shutdown kills the probe's
 * process rather than leaving it running, which the shared probe — with
 * other callers waiting on it — could not do. A backend with no CLI of
 * its own (the fake) has nothing to be signed in to.
 */
export async function sideCallSignedIn(backend: string, executablePath: string | null, claudeKeyHeld: boolean, signal?: AbortSignal): Promise<boolean> {
  if (!(backend in RUNTIMES)) return true;
  const provider = backend as AuthProvider;
  const storedKey = backend === "claude" ? claudeKeyHeld : false;
  const cached = cachedRuntimeAuth(provider, executablePath, { storedKey });
  const answer = cached.state !== "unknown" ? cached : await probeRuntimeAuth({ provider, executablePath, storedKey, run: createAuthProbeRunner(undefined, signal) });
  return answer.state !== "signed_out";
}

/**
 * Why this backend's side calls cannot be made on this machine however
 * often they are asked, or null (EO-509).
 *
 * Codex's, where the person's Codex keeps its sign-in in the operating
 * system's keyring or on `auto`: a side call runs only in a Codex home of
 * its own (`sideCallCodexHome`), and none can reach that sign-in. Asked
 * before anything is spawned, so the call fails as `sign_in_unreachable`
 * with the sentence that says how to fix it, rather than as an `error`
 * thrown from inside the adapter. Reads one file; spawns nothing.
 */
export function sideCallSignInUnreachable(backend: string, personHome: string = personCodexHome()): string | null {
  if (backend !== "codex") return null;
  return signInIsInKeyring(personHome) ? sideCallKeyringRefusal(personHome) : null;
}
