import { useState } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { Download, HardDriveDownload, KeyRound, Plus, Trash2 } from "lucide-react";
import type { RuntimeStatusView } from "@eo/core";
import { cn } from "@eo/ui";
import { ipcQuery } from "../../../query/client";
import { MANAGED_RUNTIMES } from "../../../shared/agents/catalog";
import { runtimeKey, runtimeState, runtimeTone } from "../../../shared/agents/runtimeStatus";
import { smallModelHint, useSmallModel } from "../../../shared/agents/smallModel";
import { Button, Card, Chip, Dialog, EmptyState, Field, GroupLabel, Loading, StatusDot, Switch, TextInput } from "../../kit";
import { CodexMemoryKeyringNotice } from "./CodexMemoryNotice";
import { ConsentPanel, toneOf } from "./runtime";
import { SignInDialog } from "./SignIn";

/**
 * The Runtimes tab of Agents, in the chat layout's terms.
 *
 * A runtime is the CLI a backend shells out to, and EO ships none of
 * them, so this tab is about a machine rather than an agent: what is
 * installed, where it came from, whether anybody is signed in, and the
 * one way a new one arrives — chosen from what EO knows how to fetch and
 * verify, with consent before a byte moves.
 *
 * Drawn only where `machineAvailable()`: on an organisation server there
 * is no disk here to describe.
 */
export function RuntimesPanel({ adding, onAddingChange }: { adding: boolean; onAddingChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  // Held here rather than on the card: a removal can move a runtime out of
  // the list its own card is drawn from, and the dialog has to outlive it.
  const [removing, setRemoving] = useState<string | null>(null);

  const results = useQueries({
    queries: MANAGED_RUNTIMES.map((choice) => ({
      queryKey: runtimeKey(choice.id),
      queryFn: () => ipcQuery("runtime:status", { provider: choice.id }),
    })),
  });

  const known = MANAGED_RUNTIMES.map((choice, index) => ({ choice, runtime: results[index]?.data?.runtime ?? null }));
  const loading = results.some((result) => result.isLoading);
  const installed = known.filter((entry) => entry.runtime !== null && runtimeState(entry.runtime) !== "needs_consent");
  const available = known.filter((entry) => entry.runtime === null || runtimeState(entry.runtime) === "needs_consent");
  const leaving = known.find((entry) => entry.choice.id === removing)?.runtime ?? null;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["runtime"] });
    // The model lists are fetched by spawning the CLI, so they were failing until a moment ago.
    void queryClient.invalidateQueries({ queryKey: ["providers"] });
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {loading && installed.length === 0 ? <Loading /> : null}

      {installed.map((entry) => (
        <RuntimeCard key={entry.choice.id} runtime={entry.runtime!} onChanged={refresh} onRemove={() => setRemoving(entry.choice.id)} />
      ))}

      {!loading && installed.length === 0 ? (
        <EmptyState
          title={
            <span className="inline-flex items-center gap-2">
              <HardDriveDownload size={15} className="text-ink-subtle" />
              No runtimes on this machine yet.
            </span>
          }
          action={
            <Button icon={<Plus size={12} />} onClick={() => onAddingChange(true)}>
              Add runtime
            </Button>
          }
        >
          EO doesn&apos;t ship the agent CLIs — they stay their publishers&apos; software, fetched on request. Agents on the built-in{" "}
          <code className="font-mono">fake</code> backend work without one.
        </EmptyState>
      ) : null}

      {leaving ? <RemoveRuntimeDialog runtime={leaving} onClose={() => setRemoving(null)} onChanged={refresh} /> : null}

      <AddRuntimeDialog
        open={adding}
        available={available}
        onClose={() => onAddingChange(false)}
        onInstalled={() => {
          refresh();
          onAddingChange(false);
        }}
      />
    </div>
  );
}

/** One installed runtime: where it came from, what it is made of, who is signed in, and whether EO keeps it current. */
function RuntimeCard({ runtime, onChanged, onRemove }: { runtime: RuntimeStatusView; onChanged: () => void; onRemove: () => void }) {
  const queryClient = useQueryClient();
  const state = runtimeState(runtime);
  const status = runtimeTone(state, runtime.auth);
  const [signingIn, setSigningIn] = useState(false);

  const automatic = useMutation({
    mutationFn: (enabled: boolean) => ipcQuery("runtime:setAutomaticUpdates", { provider: runtime.id as "codex" | "claude", enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: runtimeKey(runtime.id) }),
  });
  const lifecycle = useMutation({
    mutationFn: (enabled: boolean) => ipcQuery("runtime:setEnabled", { provider: runtime.id as "codex" | "claude", enabled }),
    onSuccess: (result) => {
      if (result.ok) onChanged();
    },
  });

  // Where it came from: a run that changes after an unrelated `brew upgrade` is otherwise a mystery.
  const where = runtime.source === "cache" ? "Managed by EO" : runtime.source === "configured" ? "Configured for this machine" : "Not resolved";
  const users = runtime.usedBy ?? [];

  return (
    <Card label={`${runtime.label} runtime`}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="text-[14px] font-medium text-ink">{runtime.label}</h3>
          <p className="text-[12.5px] text-ink-subtle">
            {runtime.publisher} · {where}
          </p>
        </div>
        <Chip tone={toneOf(status.tone)}>
          <StatusDot tone={toneOf(status.tone)} />
          {state === "error" ? (runtime.problem ?? status.label) : status.label}
        </Chip>
      </div>

      {runtime.components && runtime.components.length > 0 ? (
        <ul aria-label={`${runtime.label} components`} className="flex flex-col gap-1">
          {runtime.components.map((component) => (
            <li key={component.id} className="flex items-center justify-between gap-3 text-[12.5px]">
              <span className="truncate text-ink-muted">{component.label}</span>
              <span className={cn("shrink-0 font-mono text-[11.5px]", component.installed ? "text-ink-subtle" : "text-paused")}>
                {component.installed ? component.version : "missing"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {runtime.path ? (
        <p className="truncate font-mono text-[11.5px] text-ink-subtle" title={runtime.path}>
          {runtime.path}
        </p>
      ) : null}

      <RuntimeAuthLine runtime={runtime} onAuthorize={() => setSigningIn(true)} onChanged={onChanged} />
      {/* Only ever present for Codex (EO-509): signed in, but not where EO's memory calls can use it. */}
      {runtime.codexSignInInKeyring === true ? <CodexMemoryKeyringNotice className="text-[12.5px]" /> : null}
      {signingIn ? <SignInDialog open runtime={runtime} onOpenChange={setSigningIn} onSignedIn={onChanged} /> : null}

      <div className="flex flex-col gap-1.5 border-t border-line/60 pt-3">
        <GroupLabel>Used by</GroupLabel>
        {users.length === 0 ? (
          <p className="text-[12.5px] text-ink-subtle">No agents use this runtime.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5" aria-label={`Agents using ${runtime.label}`}>
            {users.map((agent) => (
              <li key={agent.id}>
                <Chip>
                  {agent.name}
                  {agent.enabled ? "" : " (disabled)"}
                </Chip>
              </li>
            ))}
          </ul>
        )}
      </div>

      <SmallModelField runtime={runtime} />

      <div className="border-t border-line/60 pt-3">
        <Switch
          label={`Automatic updates for ${runtime.label}`}
          description="EO fetches the versions its own updates need."
          checked={runtime.automaticUpdates ?? false}
          onChange={(next) => {
            automatic.mutate(next);
            onChanged();
          }}
        />
      </div>

      <div className="flex flex-col items-start gap-2 border-t border-line/60 pt-3">
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant={runtime.enabled === false ? "primary" : "secondary"}
            disabled={lifecycle.isPending}
            onClick={() => {
              lifecycle.reset();
              lifecycle.mutate(runtime.enabled === false);
            }}
          >
            {lifecycle.isPending ? (runtime.enabled === false ? "Enabling…" : "Disabling…") : runtime.enabled === false ? "Enable" : "Disable"}
          </Button>
          {/* Separate from Disable: one is a preference, the other deletes bytes. */}
          <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={onRemove}>
            Remove
          </Button>
        </div>
        {lifecycle.data?.ok === false ? (
          <p role="alert" className="text-[12.5px] text-paused">
            {lifecycle.data.problem}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * The model EO's own short questions run on with this backend (EO-477).
 * An empty box is the default, which is said under it.
 */
function SmallModelField({ runtime }: { runtime: RuntimeStatusView }) {
  const small = useSmallModel(runtime.id);
  if (!small.view) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-line/60 pt-3">
      <Field label="Small model" hint={smallModelHint(small.view)} error={small.problem}>
        <TextInput
          aria-label={`Small model for ${runtime.label}`}
          value={small.text}
          placeholder={small.view.defaultModel ?? "The backend's own default"}
          onChange={(event) => small.setText(event.target.value)}
          onBlur={small.commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") small.commit();
          }}
        />
      </Field>
      {small.view.chosen !== null ? (
        <Button size="sm" variant="secondary" className="self-start" disabled={small.saving} onClick={small.useDefault}>
          Use the default
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Whether anything can actually run on it (EO-82, EO-83, EO-84).
 *
 * Authorize only on `signed_out`: `unknown` means EO could not ask —
 * including before the first probe lands — and is said as that. A key EO
 * itself holds is the one credential it can let go of, so only that one
 * gets a Remove key.
 */
function RuntimeAuthLine({ runtime, onAuthorize, onChanged }: { runtime: RuntimeStatusView; onAuthorize: () => void; onChanged: () => void }) {
  const auth = runtime.auth;
  const removeKey = useMutation({
    mutationFn: () => ipcQuery("runtime:removeApiKey", { provider: runtime.id as "codex" | "claude" }),
    onSettled: () => onChanged(),
  });

  if (auth.state === "signed_out") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] bg-paused/15 px-3.5 py-2.5">
        <p className="min-w-0 flex-1 text-[12.5px] text-ink">Not signed in. {runtime.label} is installed, but nothing can run on it until someone signs in.</p>
        <Button size="sm" variant="primary" icon={<KeyRound size={12} />} onClick={onAuthorize}>
          Authorize
        </Button>
      </div>
    );
  }

  if (auth.state === "unknown") {
    return <p className="text-[12.5px] text-ink-subtle">{auth.problem ?? `EO has not asked ${runtime.label} whether it is signed in.`}</p>;
  }

  // What is being billed, then whatever the CLI said about it.
  const how = auth.kind === "api_key" ? "API key" : auth.kind === "subscription" ? "Subscription" : null;
  const who = [how, auth.account, auth.storedKey ? null : auth.method].filter((part) => part !== null && part !== "").join(" · ");

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[12.5px] text-ink-subtle">
        Signed in{who === "" ? "" : ` — ${who}`}
        {auth.storedKey ? <span className="text-ink-muted"> (stored by EO)</span> : null}
      </p>
      {auth.storedKey ? (
        <Button size="sm" disabled={removeKey.isPending} onClick={() => removeKey.mutate()}>
          {removeKey.isPending ? "Removing…" : "Remove key"}
        </Button>
      ) : null}
      {removeKey.data?.ok === false ? (
        <p role="alert" className="w-full text-[12.5px] text-paused">
          {removeKey.data.problem}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Confirming a deletion, having said what is about to be deleted — and
 * what will not be. The two refusals are drawn here as well as enforced
 * in the main process, which stays the authority: a failure keeps the
 * dialog open with the explanation, and every finished attempt refreshes
 * the status, because a partial failure deleted some of it.
 */
function RemoveRuntimeDialog({ runtime, onClose, onChanged }: { runtime: RuntimeStatusView; onClose: () => void; onChanged: () => void }) {
  const remove = useMutation({
    mutationFn: () => ipcQuery("runtime:remove", { provider: runtime.id as "codex" | "claude" }),
    onSuccess: (result) => {
      if (result.ok) onClose();
    },
    onSettled: () => onChanged(),
  });

  const users = runtime.usedBy ?? [];
  const problem = remove.data?.ok === false ? remove.data.problem : remove.error?.message;
  const close = () => {
    remove.reset();
    onClose();
  };

  return (
    <Dialog
      open
      onClose={close}
      busy={remove.isPending}
      title={`Remove ${runtime.label}`}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button variant="danger" disabled={users.length > 0 || remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? "Removing…" : `Remove ${runtime.label}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-ink-muted">
        <p className="text-ink">
          This deletes the {runtime.label} files EO downloaded and manages, from EO&apos;s own data directory. EO will stop fetching updates for it.
        </p>
        {runtime.components && runtime.components.length > 0 ? (
          <ul className="list-disc pl-5 text-[12.5px]" aria-label={`${runtime.label} components to delete`}>
            {runtime.components.map((component) => (
              <li key={component.id}>
                {component.label} {component.version}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-[12.5px] text-ink-subtle">
          Nothing else is touched: an agent with its own executable path keeps using it, and {runtime.publisher}&apos;s software installed anywhere else
          on this machine is left alone. You can add {runtime.label} again later.
        </p>
        {users.length > 0 ? (
          <p role="alert" className="text-[12.5px] text-paused">
            {runtime.label} cannot be removed while agents are configured for it:{" "}
            {users.map((agent) => (agent.enabled ? agent.name : `${agent.name} (disabled)`)).join(", ")}. Point them at another backend, or delete them,
            and try again.
          </p>
        ) : null}
        {problem ? (
          <p role="alert" className="text-[12.5px] text-danger">
            {problem}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * Choosing what to fetch, then agreeing to fetch it: Add runtime opens a
 * list, never a download; a choice opens the consent panel, and only its
 * button starts one.
 */
function AddRuntimeDialog({
  open,
  available,
  onClose,
  onInstalled,
}: {
  open: boolean;
  available: { choice: { id: string; label: string }; runtime: RuntimeStatusView | null }[];
  onClose: () => void;
  onInstalled: () => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const picked = available.find((entry) => entry.choice.id === chosen)?.runtime ?? null;
  const close = () => {
    setChosen(null);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={picked ? `Add ${picked.label}` : "Add runtime"}
      {...(picked ? {} : { description: "EO fetches these from their publishers on request. Pick one to see what it downloads." })}
      width="w-[32rem]"
    >
      {picked ? (
        <ConsentPanel framed={false} runtime={picked} onCancel={() => setChosen(null)} onInstalled={onInstalled} />
      ) : available.length === 0 ? (
        <p className="text-[13px] text-ink-muted">
          Every runtime EO knows how to fetch is already on this machine. Adding another would mean teaching EO to verify it first.
        </p>
      ) : (
        <ul aria-label="Runtimes to add" className="flex flex-col gap-1.5">
          {available.map((entry) => (
            <li key={entry.choice.id}>
              <button
                type="button"
                disabled={entry.runtime === null || entry.runtime.packageName === null}
                onClick={() => setChosen(entry.choice.id)}
                className="flex w-full items-center gap-3 rounded-[12px] bg-canvas-raised px-3 py-2.5 text-left hover:bg-canvas-hover disabled:opacity-50"
              >
                <Download size={14} className="shrink-0 text-ink-subtle" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] text-ink">{entry.runtime?.label ?? entry.choice.label}</span>
                  <span className="truncate text-[11.5px] text-ink-subtle">
                    {entry.runtime === null
                      ? "asking this machine…"
                      : entry.runtime.packageName === null
                        ? "No build is published for this platform."
                        : `${entry.runtime.publisher} · ${entry.runtime.packageName}@${entry.runtime.packageVersion}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
