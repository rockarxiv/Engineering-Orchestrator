import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DEFAULT_MODULE_TIMEOUT_MS,
  GIT_WORKTREE_KIND,
  NONE_KIND,
  NO_WORKSPACE,
  WAITING_RESULT,
  builtinCanWait,
  describeDuration,
  type HandOffTargets,
  type ModuleView,
  type PipelineStepView,
  type StepInputValue,
  type StepRouteView,
  type StepVerification,
  type WorkspaceView,
} from "@eo/core";
import { ipcQuery } from "../../../query/client";
import { environmentVariablesKey, environmentVariablesRootKey, moduleSecretsKey, moduleSecretsRootKey, useChromeVocabulary, useModules, useRegistry } from "../../../query/hooks";
import { useInvalidateOnPush } from "../../../query/useInvalidateOnPush";
import { WORKSPACE_MODES, declaredInputs, declaredResults, resultLabel } from "../../../shared/pipeline/configuration";
import { CardSection, Chip, Facts, StepKindChip } from "../../kit";
import { targetName } from "../shared";

/**
 * One step of a published pipeline, read-only (EO-524): who acts on it
 * and what it runs, what it is configured with, where it works, where
 * each of its results sends work, and which variables and secrets it has
 * of its own.
 *
 * The Graph view's answer to "how is this set up?" now that the editor is
 * going. Nothing here is a control: a step is changed by asking the
 * assistant, and a secret is never shown — only whether one is set.
 */
export function StepDetails({
  step,
  steps,
  routes,
  elsewhere,
  verification,
  workspaces,
  workspaceKind,
}: {
  step: PipelineStepView;
  steps: PipelineStepView[];
  routes: StepRouteView[];
  elsewhere: HandOffTargets[];
  verification: StepVerification | undefined;
  workspaces: WorkspaceView[];
  /** The kind a step that picks no workspace inherits — the project's. */
  workspaceKind: string | null;
}) {
  const { registry } = useRegistry();
  const modules = useModules().data?.modules ?? [];
  const vocabulary = useChromeVocabulary();
  const module = step.type === "module" ? modules.find((candidate) => candidate.id === step.entryAction) : undefined;
  // Whether what it runs can keep checking (EO-456): its declaration says so, and `waiting` is then an outcome it has whatever its results list.
  const canWait = step.type === "builtin" ? builtinCanWait(registry, step.entryAction) : step.type === "module" ? module?.manifest.watch === true : false;
  const results = resultRows(step, steps, routes, elsewhere, declaredResults(registry, step, modules), (key) => resultLabel(registry, key), canWait);
  const declared = declaredInputs(registry, step, modules) ?? {};
  const inputNames = [...new Set([...Object.keys(declared), ...Object.keys(step.inputs)])];

  const facts: { term: ReactNode; value: ReactNode }[] = [{ term: "Who acts", value: whoActs(step, verification) }];
  const runs = whatItRuns(step, module, registry.builtins.get(step.entryAction ?? "")?.label);
  if (runs !== null) facts.push(runs);
  if (step.type === "agent" && step.planMode) facts.push({ term: "Plan first", value: "Proposes a plan and changes nothing, then waits" });
  if (step.type !== "user") {
    facts.push({
      term: "Inputs",
      value:
        inputNames.length === 0 ? (
          <span className="text-ink-subtle">None</span>
        ) : (
          <ul aria-label="Inputs" className="flex flex-col gap-0.5">
            {inputNames.map((name) => (
              <li key={name}>
                <span className="font-mono text-[12px]">{name}</span>: {inputValue(step.inputs[name], declared[name]?.default)}
              </li>
            ))}
          </ul>
        ),
    });
    facts.push({ term: "Time limit", value: timeLimit(step) });
    facts.push({
      term: "Keep checking",
      value:
        step.watch == null
          ? "Off"
          : `Every ${step.watch.everyMinutes} minutes, ${step.watch.neverGivesUp === true ? "never giving up" : `giving up after ${step.watch.giveUpAfterHours} hours`}`,
    });
    facts.push({ term: "Works on", value: worksOn(step, workspaces, vocabulary.item.toLowerCase()) });
    const picked = step.workspaceId ? workspaces.find((workspace) => workspace.id === step.workspaceId) : undefined;
    const kind = step.workspaceId === NO_WORKSPACE ? NONE_KIND : step.workspaceId ? (picked?.kind ?? NONE_KIND) : (workspaceKind ?? NONE_KIND);
    // A mode is a git thing (EO-296): said only where the step has a repository.
    if (kind === GIT_WORKTREE_KIND) facts.push({ term: "Repository", value: WORKSPACE_MODES.find((mode) => mode.value === step.workspaceMode)?.label ?? step.workspaceMode });
  }
  if (step.isTerminal) facts.push({ term: "Finishes the work", value: `Terminal — ${vocabulary.item.toLowerCase()} here is done` });
  if (step.instructionsSummary) facts.push({ term: "Instructions", value: step.instructionsSummary });

  return (
    <CardSection
      title={step.name}
      // The kind chip the drawing it was clicked in uses (EO-680, EO-681); an end is not a kind of work.
      {...(step.isTerminal ? {} : { titleAside: <StepKindChip step={step} /> })}
      description="This step as published. To change it, ask the assistant."
    >
      <Facts label="Step details" items={facts} />
      <section aria-label="Results" className="flex flex-col gap-1.5">
        <h3 className="text-[12.5px] font-medium text-ink">Results and where each goes</h3>
        {results.length === 0 ? (
          <p className="text-[12.5px] text-ink-subtle">
            {step.isTerminal ? "None — work here is finished." : "None routed from here. Work on this step is moved on by hand."}
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-[12.5px] text-ink-muted">
            {results.map((row) => (
              <li key={row.key}>
                <span className="text-ink">{row.label}</span>
                {/* The key beside a label that is not it: the label is the board's word, the key the runner's. */}
                {row.key !== null && row.label !== row.key ? (
                  <>
                    {" "}
                    <span className="font-mono text-[11.5px] text-ink-subtle">{row.key}</span>
                  </>
                ) : null}
                {" → "}
                <span className={row.routed ? "text-ink" : "text-ink-subtle"}>{row.goes}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {/* A person's step runs nothing, so nothing of its own is given to a run. */}
      {step.type === "user" ? null : <StepValues stepId={step.id} declared={module?.manifest.needs.env ?? []} />}
    </CardSection>
  );
}

/** One line of "Results and where each goes". `key` is null for the one line that stands for whatever an undeclaring step returns. */
interface ResultRow {
  key: string | null;
  label: string;
  goes: string;
  /** Whether a route says where it goes, rather than the engine's own fallback. */
  routed: boolean;
}

/**
 * Every result the step can return and where each sends work — its
 * routes, and what the engine does with a result no route names
 * (`resolveRoute`, `routeResult`), so a result left unrouted is said
 * rather than silently missing.
 *
 *   * A step that routes nothing walks every result to the next step by
 *     position — or, with no step after it, parks the item and asks.
 *   * A step that routes some results parks the item and asks a person
 *     about any result it does not route (`pipelineValidation` warns, and
 *     publishes).
 *   * `waiting` is never routed (EO-505): a step that keeps checking holds
 *     the item and checks again; one that runs once parks it and asks for
 *     keep checking to be turned on. It is the reserved outcome of every
 *     check, so a function or module that can wait has it even where its
 *     declared results leave it out — `watch_pull_request` and `wait_until`
 *     do, on purpose — and `canWait` adds it.
 */
export function resultRows(
  step: PipelineStepView,
  steps: PipelineStepView[],
  routes: StepRouteView[],
  elsewhere: HandOffTargets[],
  declared: readonly string[] | null,
  labelOf: (resultKey: string) => string,
  canWait = false,
): ResultRow[] {
  const outgoing = routes.filter((route) => route.fromStepId === step.id).sort((a, b) => a.position - b.position);
  const rows: ResultRow[] = outgoing.map((route) => ({
    key: route.resultKey,
    label: route.label || route.resultKey,
    goes: targetName(route.target, steps, elsewhere),
    routed: true,
  }));
  if (step.type === "user" || step.isTerminal) return rows;

  const next = steps.filter((candidate) => candidate.position > step.position).sort((a, b) => a.position - b.position)[0];
  const fallback =
    outgoing.length > 0
      ? "stays here and asks you — no route names it"
      : next === undefined
        ? "stays here and asks you — no route, and no step after this one"
        : `${next.name}, the next step — this step routes nothing`;

  if (declared === null && outgoing.length === 0) rows.push({ key: null, label: "Whatever it returns", goes: fallback, routed: false });
  for (const key of declared ?? []) {
    if (key === WAITING_RESULT || outgoing.some((route) => route.resultKey === key)) continue;
    rows.push({ key, label: labelOf(key), goes: fallback, routed: false });
  }
  // Last, as a check answers it: what it says while what it waits on has not happened yet.
  if (canWait || (declared ?? []).includes(WAITING_RESULT)) {
    rows.push({
      key: WAITING_RESULT,
      label: labelOf(WAITING_RESULT),
      goes: step.watch == null ? "stays here and asks you — it runs once, so keep checking would have to be on" : "stays here, and EO checks again",
      routed: false,
    });
  }
  return rows;
}

function whoActs(step: PipelineStepView, verification: StepVerification | undefined): string {
  switch (step.type) {
    case "agent":
      return step.ownerRole === null ? "An agent — no role picked" : `An agent — ${step.ownerRole}`;
    case "user":
      return verification?.waitsOn ? `A person — waits on ${verification.waitsOn}` : "A person — EO hands off and waits";
    case "module":
      return "A module — one of your own";
    default:
      return "EO itself — built in";
  }
}

function whatItRuns(step: PipelineStepView, module: ModuleView | undefined, builtinLabel: string | undefined): { term: string; value: ReactNode } | null {
  switch (step.type) {
    case "agent":
      return { term: "Action", value: step.entryAction ?? <span className="text-ink-subtle">None picked</span> };
    case "builtin":
      return {
        term: "Built-in function",
        value:
          step.entryAction === null ? (
            <span className="text-ink-subtle">None picked</span>
          ) : (
            <>
              {builtinLabel ?? step.entryAction} <span className="font-mono text-[11.5px] text-ink-subtle">{step.entryAction}</span>
            </>
          ),
      };
    case "module":
      return {
        term: "Module",
        value:
          step.entryAction === null ? (
            <span className="text-ink-subtle">None picked</span>
          ) : (
            <>
              {module?.name ?? step.entryAction}
              {module === undefined ? <span className="text-ink-subtle"> — not installed here</span> : module.approvedAt === null ? <span className="text-ink-subtle"> — not approved</span> : null}
            </>
          ),
      };
    default:
      return null;
  }
}

function inputValue(value: StepInputValue | undefined, fallback: StepInputValue | null | undefined): ReactNode {
  if (value !== undefined) return String(value);
  if (fallback !== undefined && fallback !== null) return <span className="text-ink-subtle">{String(fallback)} (the default)</span>;
  return <span className="text-ink-subtle">not set</span>;
}

function timeLimit(step: PipelineStepView): string {
  if (step.timeoutMs !== null) return describeDuration(step.timeoutMs);
  // EO-162: a module stops at EO's default when it names none.
  if (step.type === "module") return `EO's default of ${describeDuration(DEFAULT_MODULE_TIMEOUT_MS)}`;
  return "None of its own";
}

function worksOn(step: PipelineStepView, workspaces: WorkspaceView[], item: string): string {
  if (step.workspaceId === null) return `The ${item}'s own workspace`;
  if (step.workspaceId === NO_WORKSPACE) return "No disk — MCP servers and connectors only";
  const workspace = workspaces.find((candidate) => candidate.id === step.workspaceId);
  if (workspace === undefined) return "A workspace this project no longer has";
  return workspace.problem === null ? workspace.label : `${workspace.label} — unavailable: ${workspace.problem}`;
}

/**
 * The step's own variables and secrets, by name: each marked set or not,
 * and never with its value (EO-522, EO-524).
 *
 * Every name a module step declares it needs, and every name the step has
 * a value of its own for. `environmentVariables:list` carries values; they
 * are read for their names and go no further than this function.
 */
function StepValues({ stepId, declared }: { stepId: string; declared: readonly string[] }) {
  const secrets = useQuery({ queryKey: moduleSecretsKey(stepId), queryFn: () => ipcQuery("moduleSecrets:list", { stepId }) });
  const variables = useQuery({ queryKey: environmentVariablesKey(stepId), queryFn: () => ipcQuery("environmentVariables:list", { stepId }) });
  // A card the assistant offers sets these while the view is open (EO-522).
  useInvalidateOnPush("config:changed", moduleSecretsRootKey);
  useInvalidateOnPush("config:changed", environmentVariablesRootKey);

  // `overrides` holds what a run here would be given: a stored value, or a
  // reference to EO's environment that resolves. A step reference that
  // does not resolve is only in `references`, and is configured but not set.
  const ownSecrets = new Set(secrets.data?.overrides ?? []);
  const unavailable = new Set(
    (secrets.data?.references ?? [])
      .filter((reference) => reference.scope === "step" && !reference.available && !ownSecrets.has(reference.name))
      .map((reference) => reference.name),
  );
  // A value stored for the step that no longer decrypts (EO-417) is in
  // `stored.step` and nowhere else: configured, and given to no run.
  const unreadable = new Set((secrets.data?.stored?.step ?? []).filter((name) => !ownSecrets.has(name) && !unavailable.has(name)));
  const ownVariables = new Set((variables.data?.variables ?? []).filter((variable) => variable.scope === "step").map((variable) => variable.name));
  const names = [...new Set([...declared, ...[...ownSecrets, ...unavailable, ...unreadable].sort(), ...[...ownVariables].sort()])];

  return (
    <section aria-label="Variables and secrets" className="flex flex-col gap-1.5">
      <h3 className="text-[12.5px] font-medium text-ink">Its own variables and secrets</h3>
      {secrets.isLoading || variables.isLoading ? null : names.length === 0 ? (
        <p className="text-[12.5px] text-ink-subtle">None of its own. A run here is given the shared ones.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-[12.5px]">
          {names.map((name) => (
            <li key={name} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[12px] text-ink">{name}</span>
              {ownSecrets.has(name) ? (
                <Chip>secret · set</Chip>
              ) : unavailable.has(name) ? (
                <Chip tone="paused" title="It reads one of EO's environment variables, and EO was started without it, so a run here is given no value.">
                  secret · not set — its variable is missing
                </Chip>
              ) : unreadable.has(name) ? (
                <Chip tone="paused" title="A value is stored for this step, and EO can no longer read it, so a run here is given no value.">
                  secret · not set — its stored value cannot be read
                </Chip>
              ) : ownVariables.has(name) ? (
                <Chip>variable · set</Chip>
              ) : (
                <Chip>not set</Chip>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
