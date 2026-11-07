import { useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { Download, KeyRound } from "lucide-react";
import type { RuntimeStatusView } from "@eo/core";
import { machineAvailable } from "../../../ipc/bridge";
import { ipcQuery } from "../../../query/client";
import { useInvalidateOnPush } from "../../../query/useInvalidateOnPush";
import { MANAGED_RUNTIMES, type RuntimeChoice } from "../../../shared/agents/catalog";
import { runtimeKey, runtimeState } from "../../../shared/agents/runtimeStatus";
import { Button, Chip, ErrorLine, Loading, StatusDot } from "../../kit";
import { ConsentPanel } from "./runtime";
import { SignInDialog } from "./SignIn";

/**
 * Installing and signing in a coding agent without leaving the screen
 * that needs one (EO-659): first run's "Connect a coding agent" step, and
 * the needs check's coding-agent line on a machine with nothing installed.
 *
 * Nothing here is a second install or sign-in path. The download is
 * `ConsentPanel` — the Agents → Runtimes consent, on `runtime:install` —
 * and the sign-in is `SignInDialog`. What this adds is only the list of
 * what EO can fetch, drawn where the person already is.
 */

/** One entry of `MANAGED_RUNTIMES` and what this machine says about it. Null until it has answered. */
export interface CodingAgentEntry {
  choice: RuntimeChoice;
  runtime: RuntimeStatusView | null;
}

/**
 * Every managed runtime's status, and whether any of them is signed in.
 *
 * The same queries, under the same keys, the Runtimes tab and the needs
 * check read, so an install or a sign-in anywhere refreshes all three.
 * `signedIn` counts only a probe that answered "signed in": `unknown` is
 * EO not having been able to ask, which is not a sign-in.
 *
 * On a served tab nothing is asked (there is no disk here to describe),
 * so `signedIn` is false and `loading` is false.
 */
export function useCodingAgents(): { entries: CodingAgentEntry[]; loading: boolean; signedIn: boolean } {
  const machine = machineAvailable();
  const results = useQueries({
    queries: MANAGED_RUNTIMES.map((choice) => ({
      queryKey: runtimeKey(choice.id),
      queryFn: () => ipcQuery("runtime:status", { provider: choice.id }),
      enabled: machine,
    })),
  });
  const entries = MANAGED_RUNTIMES.map((choice, index) => ({ choice, runtime: results[index]?.data?.runtime ?? null }));
  return {
    entries,
    loading: machine && results.some((result) => result.isLoading),
    signedIn: entries.some((entry) => entry.runtime?.auth.state === "signed_in"),
  };
}

/** Whether EO has anything on disk for this runtime yet. */
export function runtimeInstalled(runtime: RuntimeStatusView | null): boolean {
  return runtime !== null && runtime.source !== "absent" && runtimeState(runtime) !== "needs_consent";
}

/**
 * The list: each runtime EO knows how to fetch, with the one thing to do
 * next for it — install, sign in, or nothing because it is signed in.
 *
 * `onSignedIn` is called once a sign-in has finished and the statuses
 * have been asked again. The caller decides from those statuses what
 * happens next, rather than from the dialog's say-so (invariant 5).
 */
export function ConnectAgentPanel({ onSignedIn }: { onSignedIn?: () => void }) {
  const queryClient = useQueryClient();
  const { entries, loading } = useCodingAgents();
  // An install reports "updating" and its end through `config:changed`.
  useInvalidateOnPush("config:changed", ["runtime"], machineAvailable());

  if (!machineAvailable()) {
    return (
      <p className="text-[13px] leading-relaxed text-ink-muted">
        Signing a coding agent in happens on the machine that runs the agent, which is not this one. Open EO on that machine to connect one.
      </p>
    );
  }

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["runtime"] });
    // The model lists are fetched by spawning the CLI, so they were failing until a moment ago.
    void queryClient.invalidateQueries({ queryKey: ["providers"] });
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {loading ? <Loading>Asking this machine what it has…</Loading> : null}
      <ul aria-label="Coding agents" className="flex min-w-0 flex-col gap-2">
        {entries.map((entry) => (
          <li key={entry.choice.id}>
            <AgentRow
              entry={entry}
              onChanged={() => void refresh()}
              onSignedIn={() => {
                void refresh().then(() => onSignedIn?.());
              }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function AgentRow({ entry, onChanged, onSignedIn }: { entry: CodingAgentEntry; onChanged: () => void; onSignedIn: () => void }) {
  const [installing, setInstalling] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const runtime = entry.runtime;
  const label = runtime?.label ?? entry.choice.label;

  if (runtime !== null && installing) {
    return (
      <ConsentPanel
        runtime={runtime}
        onCancel={() => setInstalling(false)}
        onInstalled={() => {
          setInstalling(false);
          onChanged();
        }}
      />
    );
  }

  const state = runtime === null ? null : runtimeState(runtime);
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-1.5 rounded-[12px] bg-canvas-subtle px-3.5 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13.5px] font-medium text-ink">{label}</span>
          <span className="text-[12px] text-ink-subtle">{runtime === null ? "asking this machine…" : `${runtime.publisher} · ${line(runtime)}`}</span>
        </div>
        {runtime === null ? null : <Action runtime={runtime} onInstall={() => setInstalling(true)} onSignIn={() => setSigningIn(true)} />}
      </div>
      {state === "updating" ? <Loading>Installing {label}…</Loading> : null}
      {state === "error" ? <ErrorLine>{runtime?.problem ?? `Installing ${label} failed.`}</ErrorLine> : null}
      {runtime !== null && signingIn ? (
        <SignInDialog
          runtime={runtime}
          open
          onOpenChange={setSigningIn}
          onSignedIn={() => {
            setSigningIn(false);
            onSignedIn();
          }}
        />
      ) : null}
    </section>
  );
}

/** Where this runtime stands, in the words the Runtimes tab uses. */
function line(runtime: RuntimeStatusView): string {
  const state = runtimeState(runtime);
  if (state === "updating") return "installing";
  if (state === "error") return "the last install failed";
  if (state === "disabled") return "installed, and turned off on this machine";
  if (!runtimeInstalled(runtime)) return runtime.packageName === null ? "no build is published for this platform" : "not installed";
  if (runtime.auth.state === "signed_in") return "signed in";
  if (runtime.auth.state === "signed_out") return "installed, not signed in";
  return "installed";
}

function Action({ runtime, onInstall, onSignIn }: { runtime: RuntimeStatusView; onInstall: () => void; onSignIn: () => void }) {
  const state = runtimeState(runtime);
  if (state === "updating" || state === "disabled") return null;
  if (state === "error" || !runtimeInstalled(runtime)) {
    if (runtime.packageName === null) return null;
    return (
      <Button size="sm" icon={<Download size={12} />} onClick={onInstall}>
        {state === "error" ? "Try again" : `Install ${runtime.label}`}
      </Button>
    );
  }
  if (runtime.auth.state === "signed_in") {
    return (
      <Chip tone="running">
        <StatusDot tone="running" />
        Signed in
      </Chip>
    );
  }
  return (
    <Button size="sm" variant="primary" icon={<KeyRound size={12} />} onClick={onSignIn}>
      Sign in to {runtime.label}
    </Button>
  );
}
