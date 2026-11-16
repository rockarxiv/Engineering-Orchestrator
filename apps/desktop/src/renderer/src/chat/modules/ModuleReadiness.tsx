import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { unsetModuleEnvironment, type ModuleEnvironmentReadiness, type ModuleReadinessCheck, type ModuleView } from "@eo/core";
import { machineAvailable } from "../../ipc/bridge";
import { ipcQuery } from "../../query/client";
import { moduleReadinessKey } from "../../query/hooks";
import { Button, Chip, ErrorLine, Loading, Segmented, Select } from "../kit";
import { EnvironmentVariables } from "./EnvironmentVariables";
import { ModuleSecrets } from "./ModuleSecrets";

/**
 * Whether a module could run on this device, where it is proposed,
 * changed and drafted (EO-817): every CLI and environment variable it
 * declares, each with what EO found, all at once.
 *
 * Beside approval and never part of it. Approval is about the code and
 * holds on every device; this is about one device and one scope, so a
 * module can be Approved and Not ready here, and setting a value or
 * installing a CLI makes it ready without anything being approved again.
 * The doors that launch module code check the same thing again before
 * they launch (EO-816), so this is advice to act on now rather than a
 * promise about the run.
 *
 * The answer is `modules:readiness`, on the machine half: names and
 * statuses, never values, and nothing installed or run to find them. A
 * browser served by an organisation server cannot ask the desktop that
 * will do the work, so it says it cannot tell rather than guessing.
 *
 * Missing values are set here through `ModuleSecrets` and
 * `EnvironmentVariables` — the editors Settings → Modules uses — in the
 * scope the checklist names, so a value goes from the box to this
 * device's store and never into the conversation.
 */
export interface ModuleReadinessProps {
  module: ModuleView;
  /** An unapplied change to check instead of what is saved: what an update adds is read before Apply. */
  change?: { conversationId: string; messageId: string } | null;
  /** The module is in a pipeline draft whose steps are not published, so no step of it can hold values yet. */
  unpublished?: boolean;
}

type Kind = "secret" | "variable";

const KIND_OPTIONS: readonly { value: Kind; label: string }[] = [
  { value: "secret", label: "As a secret" },
  { value: "variable", label: "As a plain variable" },
];

/** The value of the scope picker for the shared values; a step is its id. */
const SHARED = "";

export function ModuleReadiness({ module, change = null, unpublished = false }: ModuleReadinessProps) {
  const [stepId, setStepId] = useState<string | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [kind, setKind] = useState<Kind>("secret");
  const ids = useId();
  const reachable = machineAvailable();
  const declaresNothing = change === null && module.manifest.needs.bin.length === 0 && module.manifest.needs.env.length === 0;

  const query = useQuery({
    queryKey: moduleReadinessKey(module.id, stepId, change?.messageId ?? null),
    queryFn: () => ipcQuery("modules:readiness", { moduleId: module.id, stepId, change }),
    enabled: reachable && !declaresNothing,
    // Asked afresh every time the card is drawn: a CLI installed since is a fact nothing pushes.
    staleTime: 0,
  });

  const heading = change === null ? "On this device" : "On this device, if applied";

  if (!reachable) {
    return (
      <Panel label={`Readiness of ${module.name}`} heading={heading} verdict={<Chip>Readiness unknown</Chip>}>
        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          This window is served by the organisation&apos;s server, which cannot see the CLIs or values of the desktop that will run this module. Open
          this conversation in EO on that desktop to check it and set it up there.
        </p>
      </Panel>
    );
  }

  if (declaresNothing) {
    return (
      <Panel label={`Readiness of ${module.name}`} heading={heading} verdict={<Chip tone="success">Nothing to set up</Chip>}>
        <p className="text-[12.5px] text-ink-muted">It declares no CLIs or environment variables, so there is nothing to install or set on any device.</p>
      </Panel>
    );
  }

  const check = query.data?.check ?? null;
  const recheck = (
    <Button size="sm" variant="ghost" disabled={query.isFetching} onClick={() => void query.refetch()}>
      {query.isFetching ? "Checking…" : "Recheck"}
    </Button>
  );

  if (check === null) {
    return (
      <Panel label={`Readiness of ${module.name}`} heading={heading} verdict={query.isPending ? null : <Chip>Readiness unknown</Chip>} action={recheck}>
        {query.isPending ? <Loading>Checking this device…</Loading> : null}
        {query.data?.problem ? <ErrorLine>{query.data.problem}</ErrorLine> : null}
        {query.isError ? <ErrorLine>{query.error.message}</ErrorLine> : null}
      </Panel>
    );
  }

  const missingBins = check.readiness.bin.filter((bin) => bin.status === "missing").map((bin) => bin.name);
  const unsetNames = unsetModuleEnvironment(check.readiness).filter((name) => check.readiness.env.find((entry) => entry.name === name)?.status !== "withheld");
  const scopeLine = check.scope.kind === "shared" ? "the shared values every step falls back to" : `${check.scope.step.pipelineName} › ${check.scope.step.name}, its own values over the shared ones`;
  const verdict =
    check.readiness.ready ? (
      <Chip tone="success">Ready on this device</Chip>
    ) : missingBins.length === 0 && unsetNames.length === 0 && check.unknownBins.length > 0 ? (
      <Chip>Readiness unknown</Chip>
    ) : (
      <Chip tone="paused">Not ready on this device</Chip>
    );
  const introduced = new Set([...check.introduced.bin, ...check.introduced.env]);
  const scopeName = check.scope.kind === "shared" ? "the shared values" : `${check.scope.step.name}'s own values`;

  return (
    <Panel label={`Readiness of ${module.name}`} heading={heading} verdict={verdict} action={recheck}>
      <p className="text-[12px] text-ink-subtle">
        Checked on <b className="font-medium text-ink-muted">{check.device}</b>, in {scopeLine}. Separate from approval: it is checked again before every
        run, and setting things up here needs no new approval.
      </p>

      {check.steps.length > 0 ? (
        <label className="flex min-w-0 flex-wrap items-center gap-2 text-[12px] text-ink-muted">
          <span>Check in</span>
          <Select
            aria-label={`Scope to check ${module.name} in`}
            value={stepId ?? SHARED}
            onChange={(event) => {
              setStepId(event.target.value === SHARED ? null : event.target.value);
            }}
          >
            <option value={SHARED}>Shared values</option>
            {check.steps.map((step) => (
              <option key={step.stepId} value={step.stepId}>
                {step.pipelineName} › {step.name}
              </option>
            ))}
          </Select>
        </label>
      ) : null}

      {unpublished ? (
        <p className="text-[12px] leading-relaxed text-ink-subtle">
          This draft&apos;s steps are not published yet, so whether one of them will set a value of its own is unknown. This checks the shared values;
          a step&apos;s own values can be set once the pipeline is published.
        </p>
      ) : null}

      <ul aria-label={`What ${module.name} needs on this device`} className="flex min-w-0 flex-col gap-1">
        {check.readiness.bin.map((bin) => (
          <Requirement key={`bin-${bin.name}`} kind="CLI" name={bin.name} introduced={introduced.has(bin.name)} status={bin.status === "found" ? { text: "Installed", tone: "ok" } : { text: "Not installed", tone: "missing" }} />
        ))}
        {check.unknownBins.map((name) => (
          <Requirement key={`unknown-${name}`} kind="CLI" name={name} introduced={introduced.has(name)} status={{ text: "Unknown — a relative path, found from the directory a run works in", tone: "unknown" }} />
        ))}
        {check.readiness.env.map((entry) => (
          <Requirement key={`env-${entry.name}`} kind="Variable" name={entry.name} introduced={introduced.has(entry.name)} status={environmentStatus(entry)} />
        ))}
      </ul>

      {missingBins.length > 0 ? <InstallGuidance names={missingBins} check={check} /> : null}

      {unsetNames.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-2">
          <div>
            <Button size="sm" aria-expanded={settingUp} aria-controls={`${ids}-setup`} onClick={() => setSettingUp((was) => !was)}>
              {settingUp ? "Hide setup" : unsetNames.length === 1 ? "Set up the missing value" : `Set up the ${unsetNames.length} missing values`}
            </Button>
          </div>
          {settingUp ? (
            <section id={`${ids}-setup`} aria-label={`Set up ${module.name}`} className="flex min-w-0 flex-col gap-2.5 rounded-[10px] bg-canvas-raised px-3 py-2.5">
              <p className="text-[12px] leading-relaxed text-ink-muted">
                Setting {scopeName} on {check.device}. Each value goes straight to this device&apos;s store — never into this conversation, so the assistant
                does not see it.
              </p>
              <Segmented size="sm" label="How the values are kept" value={kind} options={KIND_OPTIONS} onChange={setKind} />
              {/* One mount per scope and kind, as both editors ask: what is typed is held by name. */}
              {kind === "secret" ? (
                <ModuleSecrets key={`secret-${stepId ?? SHARED}`} stepId={stepId} declared={unsetNames} />
              ) : (
                <EnvironmentVariables key={`variable-${stepId ?? SHARED}`} stepId={stepId} declared={unsetNames} />
              )}
            </section>
          ) : null}
        </div>
      ) : null}

      {query.isError ? <ErrorLine>{query.error.message}</ErrorLine> : null}
    </Panel>
  );
}

function Panel({ label, heading, verdict, action, children }: { label: string; heading: string; verdict: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-2 rounded-[10px] border border-line px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="text-[12.5px] font-medium text-ink">{heading}</h3>
        {verdict}
        {action ? <span className="ml-auto">{action}</span> : null}
      </div>
      {children}
    </section>
  );
}

type Tone = "ok" | "missing" | "unknown";

const TONE: Record<Tone, string> = { ok: "text-success", missing: "text-danger", unknown: "text-ink-subtle" };

function Requirement({ kind, name, status, introduced }: { kind: string; name: string; status: { text: string; tone: Tone }; introduced: boolean }) {
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]">
      <span className="w-[4.5rem] shrink-0 text-[11.5px] text-ink-subtle">{kind}</span>
      <code className="font-mono text-[12px] text-ink">{name}</code>
      {introduced ? <Chip tone="reviewing">New in this change</Chip> : null}
      <span className={`ml-auto text-[11.5px] ${TONE[status.tone]}`}>{status.text}</span>
    </li>
  );
}

function environmentStatus(entry: ModuleEnvironmentReadiness): { text: string; tone: Tone } {
  switch (entry.status) {
    case "set":
      return { text: "Set", tone: "ok" };
    case "unset":
      return { text: "Not set", tone: "missing" };
    case "unreadable":
      return { text: "Stored, but cannot be read on this device — set it again", tone: "missing" };
    case "dangling":
      return { text: `Reads ${entry.variable} from EO's environment, which is missing or empty`, tone: "missing" };
    case "withheld":
      return { text: "Withheld on this trial", tone: "missing" };
  }
}

/**
 * What to do about a CLI that is not there. EO never installs software
 * (EO-815), so this says how a person does it and where EO will look.
 */
function InstallGuidance({ names, check }: { names: string[]; check: ModuleReadinessCheck }) {
  const listed = names.join(", ");
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-[12px] leading-relaxed text-ink-muted" aria-label="How to install the missing CLIs">
      <p>
        EO never installs software. Install <b className="font-medium text-ink">{listed}</b> yourself, so that {names.length === 1 ? "it runs" : "each runs"} from a
        terminal by that name, then press Recheck. {platformHint(check.platform)}
      </p>
      {check.platform === "win32" ? <p>EO starts only .exe and .com files by name — a .bat or .cmd wrapper is not found.</p> : null}
      <details className="min-w-0">
        <summary className="cursor-default text-ink-subtle">Where EO looks</summary>
        <p className="mt-1">
          A bare name is looked for in these directories, in order. Installed somewhere else, add that directory to PATH in your shell profile and restart
          EO — it reads your login shell&apos;s PATH when it starts.
        </p>
        <ul className="mt-1 flex min-w-0 flex-col gap-0.5">
          {check.searched.map((directory, index) => (
            <li key={`${index}-${directory}`} className="min-w-0 break-all">
              <code className="font-mono text-[11.5px]">{directory}</code>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function platformHint(platform: string): string {
  if (platform === "darwin") return "On macOS a package manager such as Homebrew is the usual route; the tool's own install instructions give its package name.";
  if (platform === "win32") return "On Windows winget or the tool's own installer is the usual route.";
  if (platform === "linux") return "On Linux your distribution's package manager, or the tool's own installer, is the usual route; its install instructions give the package name.";
  return "The tool's own install instructions say how.";
}
