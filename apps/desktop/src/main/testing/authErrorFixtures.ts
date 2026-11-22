import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * What the pinned CLIs really say when a run's sign-in is no good, and
 * what they say for an error that is not about signing in (EO-797).
 *
 * Recorded from EO's managed runtimes, never written by hand: each file
 * under `providers/__fixtures__` says in `recordedWith` how. The adapters
 * read only the fields these show, so a bump of either pin re-records
 * them (the `bump-agent-runtime-pin` skill) rather than editing them.
 *
 * Only tests import this module (`testing.test.ts`).
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "providers", "__fixtures__");

export interface AuthErrorCase<T> {
  case: string;
  turn: T[];
}

interface Recorded<K extends string, T> {
  signIn: (Record<"case", string> & Record<K, T[]>)[];
  notSignIn: (Record<"case", string> & Record<K, T[]>)[];
}

function load<K extends string, T>(file: string, key: K): { signIn: AuthErrorCase<T>[]; notSignIn: AuthErrorCase<T>[] } {
  const recorded = JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as Recorded<K, T>;
  const cases = (list: Recorded<K, T>["signIn"]) => list.map((entry) => ({ case: entry.case, turn: entry[key] }));
  return { signIn: cases(recorded.signIn), notSignIn: cases(recorded.notSignIn) };
}

/** Claude CLI 2.1.329's messages after `system/init`, as the SDK hands them over. */
export const CLAUDE_AUTH_ERRORS = load<"messages", SDKMessage>("claude-0.3.329-auth-errors.json", "messages");

/** A notification from the Codex app-server, as `fakeCodexAppServer` plays one. */
export interface AppServerNotification {
  method: string;
  params: Record<string, unknown>;
}

const recordedCodex = load<"notifications", AppServerNotification>("codex-0.171.0-auth-errors.json", "notifications");

/**
 * The app-server 0.171.0's notifications, with the recorded thread and
 * turn ids put back to the ones `fakeCodexAppServer` hands out
 * (`thr-fake`, `turn-1`): the client drops a notification about any
 * other thread or turn as somebody else's. Nothing else is changed.
 */
export const CODEX_AUTH_ERRORS = {
  signIn: recordedCodex.signIn.map(onFakeIds),
  notSignIn: recordedCodex.notSignIn.map(onFakeIds),
};

function onFakeIds({ case: name, turn }: AuthErrorCase<AppServerNotification>): AuthErrorCase<AppServerNotification> {
  return {
    case: name,
    turn: turn.map((notification) => {
      const params: Record<string, unknown> = { ...notification.params, threadId: "thr-fake" };
      if ("turnId" in params) params["turnId"] = "turn-1";
      if (typeof params["turn"] === "object" && params["turn"] !== null) params["turn"] = { ...(params["turn"] as Record<string, unknown>), id: "turn-1", rootTurnId: "turn-1" };
      return { method: notification.method, params };
    }),
  };
}
