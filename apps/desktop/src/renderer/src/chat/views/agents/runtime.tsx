import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink } from "lucide-react";
import type { RuntimeStatusView } from "@eo/core";
import type { StatusTone } from "@eo/ui";
import { ipcQuery } from "../../../query/client";
import { megabytes, runtimeKey, runtimeState, useRuntimeStatus } from "../../../shared/agents/runtimeStatus";
import { Button, Checkbox, ErrorLine, Facts, Loading, type Tone } from "../../kit";

/**
 * What a runtime looks like from an agent's editor, and the consent in
 * front of fetching one — the chat layout's drawing of
 * `agents/RuntimeStatus` (A-08, EO-82).
 *
 * The facts come from the same hooks and helpers (`useRuntimeStatus`,
 * `runtimeState`, `runtimeTone`), so the word beside a provider picker
 * here and on the Runtimes tab is the one the classic screen says.
 */

/** The design system's status words, in the kit's tones: a status colour only ever for a state. */
export function toneOf(tone: StatusTone): Exclude<Tone, "tag"> {
  switch (tone) {
    case "running":
    case "success":
      return "running";
    case "reviewing":
      return "reviewing";
    case "paused":
    case "warning":
      return "paused";
    case "danger":
      return "danger";
    case "idle":
      return "neutral";
  }
}

/**
 * The runtime an agent would run on, beside its provider picker.
 *
 * Nothing here is ever fatal: a missing runtime is a line and a button,
 * and an agent can still be saved against one that is not installed yet.
 * Null for a backend that runs no CLI (`fake`) — there is nothing to say.
 */
export function RuntimeLine({ provider, configuredPath = null }: { provider: string; configuredPath?: string | null }) {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);

  const status = useRuntimeStatus(provider, configuredPath);
  const automatic = useMutation({
    mutationFn: (enabled: boolean) => ipcQuery("runtime:setAutomaticUpdates", { provider: provider as "codex" | "claude", enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: runtimeKey(provider) }),
  });

  const runtime = status.data?.runtime ?? null;
  if (!runtime) return null;

  const state = runtimeState(runtime) === "disabled" && configuredPath ? "ready" : runtimeState(runtime);

  if (state === "updating") return <p className="text-[12.5px] text-ink-muted">Updating {runtime.label} components…</p>;

  if (state === "error") {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-[12.5px] text-danger">
        <span>{runtime.problem ?? `Updating ${runtime.label} failed.`}</span>
        <Button size="sm" onClick={() => setAsking(true)}>
          Retry
        </Button>
      </div>
    );
  }

  if (asking) {
    return (
      <ConsentPanel
        runtime={runtime}
        onCancel={() => setAsking(false)}
        onInstalled={() => {
          setAsking(false);
          void queryClient.invalidateQueries({ queryKey: runtimeKey(provider) });
          // The whole `providers` prefix: the model list was failing until a moment ago.
          void queryClient.invalidateQueries({ queryKey: ["providers"] });
        }}
      />
    );
  }

  if (state === "needs_consent") {
    return (
      <div role="group" aria-label={`${runtime.label} runtime`} className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="text-paused">{runtime.label} needs managed components.</span>
        {runtime.packageName ? (
          <Button size="sm" icon={<Download size={12} />} onClick={() => setAsking(true)}>
            Download
          </Button>
        ) : (
          <span className="text-ink-subtle">No build is published for this platform.</span>
        )}
      </div>
    );
  }

  // Where it came from, not just that it works: a `claude` off PATH is one somebody else updates.
  const where = configuredPath || runtime.source === "configured" ? "Using the executable configured for this agent" : `${runtime.label} — managed by EO`;

  return (
    <div role="group" aria-label={`${runtime.label} runtime`} className="flex flex-col gap-1.5 rounded-[12px] bg-canvas-subtle px-3 py-2.5">
      <p className="text-[12.5px] text-ink-muted">{where}</p>
      {runtime.components?.map((component) => (
        <p key={component.id} className="text-[11.5px] text-ink-subtle">
          {component.label} <span className="font-mono">{component.version}</span>
        </p>
      ))}
      <Checkbox label={<span className="text-[12px] text-ink-muted">Automatic updates</span>} checked={runtime.automaticUpdates ?? false} onChange={(next) => automatic.mutate(next)} />
    </div>
  );
}

/**
 * What is about to be downloaded, before a byte of it moves.
 *
 * The package, the publisher, the size, where it comes from and whose
 * terms apply — EO is a fetcher here, not a redistributor, and that only
 * holds if the person is the one who asked.
 */
export function ConsentPanel({
  runtime,
  onCancel,
  onInstalled,
  framed = true,
}: {
  runtime: RuntimeStatusView;
  onCancel: () => void;
  onInstalled: () => void;
  /** Inside a dialog the panel is already on a raised surface. */
  framed?: boolean;
}) {
  const details = useQuery({
    queryKey: ["runtime", runtime.id, "describe"],
    queryFn: () => ipcQuery("runtime:describe", { provider: runtime.id }),
    staleTime: 60_000,
  });

  const install = useMutation({
    mutationFn: () => ipcQuery("runtime:install", { provider: runtime.id }),
    onSuccess: (result) => {
      if (result.ok) onInstalled();
    },
  });

  const problem = install.data?.ok === false ? install.data.problem : install.error?.message;

  return (
    <section aria-label={`Download ${runtime.label}`} className={framed ? "flex flex-col gap-2.5 rounded-[12px] bg-canvas-subtle p-3.5" : "flex flex-col gap-2.5"}>
      <p className="text-[13px] leading-relaxed text-ink">
        EO doesn&apos;t ship {runtime.label}. Downloading it fetches the package {runtime.publisher} publishes to npm and keeps it in EO&apos;s own
        data directory.
      </p>

      <Facts
        label="What would be downloaded"
        items={[
          {
            term: "Package",
            value: (
              <span className="font-mono">
                {runtime.packageName}@{runtime.packageVersion}
              </span>
            ),
          },
          { term: "Publisher", value: runtime.publisher },
          {
            term: "Size on disk",
            value: details.isLoading ? "asking npm…" : details.data?.unpackedBytes ? megabytes(details.data.unpackedBytes) : "unknown",
          },
          { term: "From", value: <span className="font-mono">{details.data?.sourceUrl ?? "registry.npmjs.org"}</span> },
        ]}
      />

      {runtime.components && runtime.components.length > 1 ? (
        <div className="text-[12.5px] text-ink-muted">
          <p>This provider requires:</p>
          <ul className="list-disc pl-5">
            {runtime.components.map((component) => (
              <li key={component.id}>
                {component.label} {component.version}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-[12.5px] text-ink-muted">
        It stays {runtime.publisher}&apos;s software, under {runtime.publisher}&apos;s terms — not EO&apos;s.{" "}
        <a href={runtime.termsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent-soft hover:underline">
          Read them <ExternalLink size={11} />
        </a>
      </p>
      <p className="text-[12px] text-ink-subtle">EO checks the download against the checksum npm publishes for it before anything is unpacked or made executable.</p>
      <p className="text-[12px] text-ink-subtle">
        You consent once for this provider. EO will automatically fetch versions required by future EO updates; you can disable that later.
      </p>

      {details.data?.problem ? <p className="text-[12.5px] text-paused">{details.data.problem}</p> : null}
      {/* Said while it happens, not only on the button: a runtime is tens of megabytes. */}
      {install.isPending ? <Loading>Downloading {runtime.label} and checking it…</Loading> : null}
      {problem ? <ErrorLine>{problem}</ErrorLine> : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={install.isPending}>
          Cancel
        </Button>
        <Button variant="primary" disabled={install.isPending} onClick={() => install.mutate()}>
          {install.isPending ? "Downloading…" : "Download"}
        </Button>
      </div>
    </section>
  );
}
