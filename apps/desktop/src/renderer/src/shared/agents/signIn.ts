import type { IpcResponse, RuntimeStatusView } from "@eo/core";
import { ipcQuery } from "../../query/client";

/**
 * What signing a runtime in says and does, apart from how it is drawn
 * (EO-519): the words for each provider and the cancel. The classic
 * dialog is `agents/SignInDialog.tsx`, the chat layout's
 * `chat/views/agents/SignIn.tsx`.
 */

export type Started = IpcResponse<"runtime:startSignIn">;

/** Where the flow is, from the dialog's point of view. */
export type Phase = "intro" | "api_key" | "waiting" | "failed" | "cancelled";

/**
 * What starting a Codex sign-in costs, said before it starts.
 *
 * Both `codex login` paths delete `~/.codex/auth.json` before the flow
 * completes, so beginning one signs this machine out and abandoning one
 * leaves it signed out. EO does not snapshot or restore that file — it
 * is another product's credential store and the CLI dropped the
 * credential deliberately — so the honest thing is to say so first.
 */
export const CODEX_WARNING =
  "Signing in signs this machine out of Codex first: the Codex CLI deletes its stored credentials at the start of the flow. " +
  "If you abandon this dialog before it finishes, Codex is left signed out and you will need to sign in again.";

/**
 * Kills a child whose start landed after the dialog let go of it.
 *
 * `startSignIn` is not instant — it spawns the CLI and scrapes stdout
 * for a URL — and until it answers there is a child EO has asked for
 * but cannot yet name. Closing the dialog in that window used to drop
 * it on the floor: there was no session id to cancel, so nothing was
 * sent, and the flow surfaced a moment later with nobody left to stop
 * it. Claude's would sit blocked on a stdin no one will write to and
 * Codex's would keep `localhost:1455`, which is the one port the next
 * attempt needs.
 *
 * At module scope so the unmount cleanup can call it without taking a
 * render's closure as a dependency.
 */
export function cancelStarted(result: Started): void {
  if (result.ok && result.sessionId !== null) void ipcQuery("runtime:cancelSignIn", { sessionId: result.sessionId });
}

export function introFor(runtime: RuntimeStatusView): string {
  if (runtime.id === "codex") {
    return `EO will run \`codex login\` and open the sign-in page in your browser. Codex completes the exchange itself — no code passes through EO.`;
  }
  return `EO will run \`claude auth login\` and open the sign-in page in your browser. The page displays an authorization code — paste it back here.`;
}

/**
 * What happens to a key typed into the field below, said before it is
 * typed.
 *
 * The difference is not cosmetic: for Codex the key is gone from EO the
 * moment the child exits, and for Claude EO is keeping it until somebody
 * removes it. Someone pasting a billable credential into a desktop app
 * should be told which of those they are agreeing to.
 */
export function keyCustodyFor(runtime: RuntimeStatusView): string {
  if (runtime.id === "codex") {
    return `EO pipes the key to \`codex login --with-api-key\` and the Codex CLI stores it. EO keeps no copy and writes it nowhere.`;
  }
  return (
    `Claude Code has no command that takes a key, so EO stores this one with your operating system's keychain and passes it to Claude as ` +
    `ANTHROPIC_API_KEY each time it runs. It never reaches EO's database, a comment or a log — and you can remove it from the Runtimes card.`
  );
}
