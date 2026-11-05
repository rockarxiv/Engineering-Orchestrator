import { useQuery } from "@tanstack/react-query";
import type { RuntimeStatusView } from "@eo/core";
import type { StatusTone } from "@eo/ui";
import { machineAvailable } from "../../ipc/bridge";
import { ipcQuery } from "../../query/client";

/**
 * A runtime's status as both layouts read it: the query, its key, and
 * what its state means in one word (EO-519). The classic layout draws
 * it in `agents/RuntimeStatus.tsx`, the chat layout in
 * `chat/views/agents/`.
 */

/**
 * The query key for one runtime, optionally as one agent sees it.
 *
 * An agent with its own `executablePath` gets its own entry, because
 * the answer is genuinely different: signed in is a fact about a
 * binary, and that agent resolves a different one. `["runtime",
 * provider]` stays a prefix of it, so every existing invalidation —
 * after an install, after a removal — still reaches both.
 */
export function runtimeKey(provider: string, executablePath: string | null = null): readonly string[] {
  return executablePath ? ["runtime", provider, executablePath] : ["runtime", provider];
}

export function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * `state` is optional on the wire — a main process older than the
 * reconcile work reports only `source`. One place decides what that
 * means, so the rail and the Runtimes tab can't disagree about it.
 */
export function runtimeState(runtime: RuntimeStatusView): NonNullable<RuntimeStatusView["state"]> {
  return runtime.state ?? (runtime.source === "absent" ? "needs_consent" : "ready");
}

/**
 * What a runtime's state means in one word.
 *
 * The rail's chip and the Runtimes tab's cards both say it, and they must
 * say the same thing — a runtime that reads "Connected" beside the
 * provider picker and "Needs components" two clicks away is worse than
 * either answer alone.
 *
 * `auth` is a required argument for that reason: being installed and
 * being usable are different facts, and a surface that forgets the
 * second one goes back to calling a signed-out runtime "Connected"
 * (EO-82).
 */
export function runtimeTone(state: RuntimeStatusView["state"], auth: RuntimeStatusView["auth"]): { tone: StatusTone; label: string } {
  if (state === "updating") return { tone: "reviewing", label: "Updating" };
  if (state === "error") return { tone: "danger", label: "Error" };
  if (state === "disabled") return { tone: "paused", label: "Disabled" };
  if (state === "needs_consent") return { tone: "paused", label: "Not installed" };
  // Present is not the same as usable: a runtime EO downloaded and
  // nobody signed into runs exactly zero turns. `unknown` says nothing
  // here — EO could not ask, which is not evidence either way.
  if (auth.state === "signed_out") return { tone: "warning", label: "Not signed in" };
  return { tone: "running", label: "Connected" };
}

/**
 * The state of one backend, for anything that needs the answer rather
 * than the row.
 *
 * Shared key with `RuntimeStatus`, so a screen rendering both pays for
 * one round trip and an install refreshes both at once.
 *
 * `executablePath` is the agent's own, when there is an agent in the
 * question. It is sent as well as keyed on: the main process resolves
 * it and asks *that* binary whether it is signed in, so the chip beside
 * a provider picker describes the copy that agent's dispatch would run
 * rather than EO's managed one (EO-82).
 */
export function useRuntimeStatus(provider: string, executablePath: string | null = null) {
  return useQuery({
    queryKey: runtimeKey(provider, executablePath),
    queryFn: () => ipcQuery("runtime:status", { provider, executablePath }),
    // What is installed on this disk, which on a server is not the disk
    // anybody is asking about (EO-319). Not asked rather than asked and
    // refused: this hook is called once per agent row, and every caller
    // already treats "no answer" as "nothing to say about a runtime".
    enabled: machineAvailable(),
  });
}
