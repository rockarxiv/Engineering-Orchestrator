import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import {
  aliasNotice,
  backendAllowed,
  CONSOLIDATION_OVERRIDE_KEYS,
  deprecatedToolsNamedIn,
  instructionsMachineSpecificWarnings,
  isBuiltinRole,
  NOT_ALLOWED_BY_YOUR_ORGANISATION,
  reusesThreadPerItem,
} from "@eo/core";
import type { AgentDetail, IpcRequest, ProviderCapabilities, ProviderModel, RegistryFacts } from "@eo/core";
import type { StatusTone } from "@eo/ui";
import { ipcQuery } from "../../../query/client";
import { useChromeVocabulary, usePolicy } from "../../../query/hooks";
import { useAliasesRetired } from "../../../hooks/useAppVersion";
import { PROVIDERS, runtimeLabel } from "../../../shared/agents/catalog";
import { executablePath } from "../../../shared/agents/agents";
import { runtimeState, runtimeTone, useRuntimeStatus } from "../../../shared/agents/runtimeStatus";
import { ManagedLockLine } from "../../managed/ManagedSection";
import { ReadOnlyFence } from "../../admin/ReadOnlyFence";
import { Button, CardSection, Chip, ErrorLine, Field, Notice, Select, StatusDot, TextArea, TextInput } from "../../kit";
import { AgentToolPicker } from "../agentTools/attach";
import { ActionsSection } from "./ActionsSection";
import { CodexMemoryKeyringNotice } from "./CodexMemoryNotice";
import { TickOption } from "../agentTools/ticks";
import { RuntimeLine, toneOf } from "./runtime";
import { MachineSpecificValues } from "../../modules/MachineSpecificValues";
import {
  agentProjectId,
  agentScopeOptions,
  canCustomise,
  canScope,
  GLOBAL_SCOPE,
  projectIdFromScope,
  scopeLine,
  type ScopeProject,
} from "../../../shared/agents/agentScope";

const CUSTOM = "__custom__";

/**
 * One agent, open for editing — the chat layout's drawing of the classic
 * `AgentEditor`, as a stack of cards: who it is, what it runs on, what it
 * is told, which tools it gets, what its role answers in
 * (`ActionsSection`), and the bar that saves it.
 *
 * Every rule is the classic editor's. Under an organisation lock (EO-329,
 * ARCHITECTURE.md, "Publish, lock and versions") the published fields — name, role, the backend's
 * settings, the
 * prompt, the tools — sit behind `ReadOnlyFence`, while the runtime and
 * the model stay live and save through `agents:setBinding` (the caller
 * decides which door). Role is fixed once created. A backend the
 * organisation does not allow is greyed with the reason, except the one
 * this agent is already on (EO-328). A refusal keeps the draft.
 */

/** A prompt that still names a tool EO renamed (KAN-178): advice, read off the draft as it is typed. */
function OldToolNames({ text }: { text: string }) {
  const retired = useAliasesRetired();
  const names = deprecatedToolsNamedIn(text);
  if (names.length === 0) return null;
  return (
    <Notice tone={retired ? "danger" : "paused"}>
      <p>These instructions {aliasNotice("pack", retired)}. The agent can still call them; what changes is the release after this one.</p>
      {names.map((name) => (
        <p key={name.deprecated} className="text-ink-subtle">
          <span className="font-mono">mcp__eo__{name.deprecated}</span> → <span className="font-mono">mcp__eo__{name.replacement}</span>
        </p>
      ))}
    </Notice>
  );
}

/** The model, from the list the provider actually offers (U-11), with a custom entry because discovery must never be the only way in. */
function ModelField({
  provider,
  value,
  models,
  loading,
  problem,
  onChange,
  label = "Model",
  emptyLabel = "provider default",
}: {
  provider: string;
  value: string | null;
  models: ProviderModel[];
  loading: boolean;
  problem: string | null;
  onChange: (model: string | null) => void;
  /** What the field is called; "Model" unless it is another model than the agent's own. */
  label?: string;
  /** What the empty choice says: the backend's default, or whatever it follows. */
  emptyLabel?: string;
}) {
  const [custom, setCustom] = useState(false);

  if (provider === "fake") {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-ink-muted">{label}</span>
        <p className="text-[12.5px] text-ink-subtle">The fake provider has no model.</p>
      </div>
    );
  }

  const known = models.some((model) => model.value === value);
  const typing = custom || (value !== null && value !== "" && !known && !loading);

  return (
    // The note sits outside the Field: anything inside a <label> is part of the control's name.
    <div className="flex min-w-0 flex-col gap-1">
      {typing ? (
        <div className="flex min-w-0 items-end gap-1.5">
          <Field label={label} className="flex-1">
            <TextInput value={value ?? ""} placeholder={emptyLabel} onChange={(event) => onChange(event.target.value || null)} />
          </Field>
          {models.length > 0 ? (
            <Button
              onClick={() => {
                setCustom(false);
                onChange(null);
              }}
            >
              List
            </Button>
          ) : null}
        </div>
      ) : (
        <Field label={label}>
          <Select
            value={value ?? ""}
            disabled={loading}
            onChange={(event) => {
              if (event.target.value === CUSTOM) {
                setCustom(true);
                return;
              }
              onChange(event.target.value || null);
            }}
          >
            <option value="">{loading ? "asking the provider…" : emptyLabel}</option>
            {models.map((model) => (
              <option key={model.value} value={model.value}>
                {model.label}
              </option>
            ))}
            <option value={CUSTOM}>custom…</option>
          </Select>
        </Field>
      )}
      {problem ? <p className="text-[11.5px] text-paused">{problem}</p> : null}
    </div>
  );
}

/** The key an agent's reasoning effort is saved under: each backend's own SDK's word for it. */
function effortKeyOf(provider: string): string {
  return provider === "claude" ? "effort" : "reasoningEffort";
}

/**
 * What else a backend takes (U-11): reasoning effort where the chosen
 * model takes one, at its levels. The settings with one correct answer
 * under EO are not offered (EO-178), and neither is max turns, which
 * Codex has no equivalent for and so went from both backends (EO-375).
 */
function ProviderConfig({
  provider,
  caps,
  models,
  model,
  config,
  onChange,
}: {
  provider: string;
  caps: ProviderCapabilities | undefined;
  models: ProviderModel[];
  model: string | null;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}) {
  if (!caps) return null;

  const set = (key: string, value: unknown) => {
    const next = { ...config };
    if (value === "" || value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };

  const chosen = models.find((entry) => entry.value === model);
  const efforts = chosen?.supportsEffort ? chosen.effortLevels : caps.reasoningEfforts;
  const showEffort = efforts.length > 0 && (provider !== "claude" || (chosen?.supportsEffort ?? false));
  const options: { key: string; label: string; values: string[] }[] = [
    ...(showEffort ? [{ key: effortKeyOf(provider), label: "Reasoning effort", values: efforts }] : []),
  ];

  if (options.length === 0) return null;

  return (
    <div className="grid gap-3 @xl:grid-cols-2">
      {options.map((option) => (
        <Field key={option.key} label={option.label}>
          <Select value={String(config[option.key] ?? "")} onChange={(event) => set(option.key, event.target.value)}>
            <option value="">provider default</option>
            {option.values.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </Field>
      ))}
    </div>
  );
}

/** One override field from the draft's config: what is set, or null where it follows the agent. */
function overrideOf(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The system agent's consolidation override (EO-578): the model and
 * reasoning effort memory consolidation runs on, each optional. An empty
 * field follows the agent's own, so changing the agent's model or effort
 * above changes consolidation's with it. Kept in the agent's own config
 * under EO's keys (`CONSOLIDATION_OVERRIDE_KEYS`), and drawn only here —
 * not on the Runtimes tab, whose small model is what selection and
 * extraction run on.
 */
function ConsolidationOverride({
  provider,
  caps,
  models,
  loading,
  agentModel,
  config,
  onChange,
}: {
  provider: string;
  caps: ProviderCapabilities | undefined;
  models: ProviderModel[];
  loading: boolean;
  agentModel: string | null;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const model = overrideOf(config, CONSOLIDATION_OVERRIDE_KEYS.model);
  const effort = overrideOf(config, CONSOLIDATION_OVERRIDE_KEYS.reasoningEffort);
  const agentEffort = overrideOf(config, effortKeyOf(provider));
  const set = (key: string, value: string | null) => {
    const next = { ...config };
    if (value === null || value.trim() === "") delete next[key];
    else next[key] = value;
    onChange(next);
  };
  // The levels of the model consolidation will run on: the override's, or the agent's it follows.
  const chosen = models.find((entry) => entry.value === (model ?? agentModel));
  const efforts = chosen?.supportsEffort ? chosen.effortLevels : (caps?.reasoningEfforts ?? []);
  // A stored level the model no longer lists stays selectable, or opening the agent would silently drop it.
  const levels = effort !== null && !efforts.includes(effort) ? [...efforts, effort] : efforts;

  return (
    <div className="grid gap-3 @xl:grid-cols-2">
      <ModelField
        provider={provider}
        value={model}
        models={models}
        loading={loading}
        problem={null}
        label="Consolidation model"
        emptyLabel={`follows the agent (${agentModel ?? "provider default"})`}
        onChange={(next) => set(CONSOLIDATION_OVERRIDE_KEYS.model, next)}
      />
      {levels.length > 0 ? (
        <Field label="Consolidation reasoning effort">
          <Select value={effort ?? ""} onChange={(event) => set(CONSOLIDATION_OVERRIDE_KEYS.reasoningEffort, event.target.value || null)}>
            <option value="">{`follows the agent (${agentEffort ?? "provider default"})`}</option>
            {levels.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
    </div>
  );
}

export function AgentEditor({
  agent,
  registry,
  locked,
  busy,
  error,
  revealActions = false,
  projects = [],
  activeProject = null,
  onSave,
  onCustomise,
  onCancel,
}: {
  agent: AgentDetail;
  registry: RegistryFacts;
  /** Every project, for the scope picker (EO-475). */
  projects?: ScopeProject[];
  /** The project the window is on — what "Customise for this project" copies for. */
  activeProject?: ScopeProject | null;
  /** Make the active project's own copy of this global agent (`agents:customise`). */
  onCustomise?: (agentId: string, projectId: string) => void;
  /** Whether the organisation publishes the agents section (EO-329, ARCHITECTURE.md, "Publish, lock and versions"). */
  locked: boolean;
  busy: boolean;
  error?: string | undefined;
  /** Whether the address asked for this role's Actions section (EO-428). */
  revealActions?: boolean;
  onSave: (input: IpcRequest<"agents:save">) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(agent);
  const isNew = agent.id === "";
  const { policy } = usePolicy();
  const word = useChromeVocabulary().item.toLowerCase();

  // One query for the whole editor: the model picker and the effort picker both need it.
  const capabilities = useQuery({
    queryKey: ["providers", draft.provider],
    queryFn: () => ipcQuery("providers:capabilities", { provider: draft.provider, refreshModels: true }),
    staleTime: Infinity,
  });
  const models = capabilities.data?.models ?? [];

  const runtime = useRuntimeStatus(draft.provider, executablePath(draft.config)).data?.runtime ?? null;
  // Why a Codex agent is not locked down after all (EO-378): the
  // person's sign-in is in the keyring, which no home of its own reaches.
  // The classic editor draws the same sentence (`agents/CodexKeyringNotice`).
  const keyringNotice = draft.provider === "codex" && runtime?.codexSignInInKeyring === true && draft.config["inheritAmbientConfig"] !== true;
  // And that its memory cannot run at all (EO-509): EO's memory calls
  // never use the person's home, ticked or not. The status is the one
  // asked for this draft's backend, and the flag only ever comes on Codex's.
  const memoryKeyringNotice = runtime?.codexSignInInKeyring === true;
  const chip: { tone: StatusTone; label: string } =
    draft.archivedAt !== null
      ? { tone: "idle", label: "Archived" }
      : !draft.enabled
        ? { tone: "paused", label: "Disabled" }
        : runtime === null
          ? { tone: "idle", label: "Built in" }
          : runtimeTone(runtimeState(runtime) === "disabled" && executablePath(draft.config) ? "ready" : runtimeState(runtime), runtime.auth);

  const allowed = backendAllowed(policy, draft.provider);
  const canSave = !busy && draft.name.trim() !== "" && draft.role.trim() !== "" && !(locked && isNew);

  return (
    <section aria-label="Edit agent" className="@container flex min-w-0 flex-col gap-3">
      {/* Who it is: the name, its state, and where it is used. */}
      <div className="flex min-w-0 flex-col gap-3 rounded-[14px] bg-canvas px-[18px] py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-subtle text-accent-soft">
            <Bot size={17} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="truncate text-[15px] font-semibold text-ink">{isNew ? "New agent" : draft.name}</h2>
            <p className="truncate text-[11.5px] text-ink-subtle">
              {agent.pipelineCount === 0 ? "Not used by any pipeline" : `Used by ${agent.pipelineCount} pipeline${agent.pipelineCount === 1 ? "" : "s"}`}
              {" · "}
              {runtimeLabel(draft.provider)}
              {draft.model ? ` · ${draft.model}` : ""}
            </p>
          </div>
          <Chip tone={toneOf(chip.tone)}>
            <StatusDot tone={toneOf(chip.tone)} />
            {chip.label}
          </Chip>
        </div>
        {/* What the organisation manages, said where somebody is about to try to edit it. */}
        <ManagedLockLine section="agents" />
        {/* Reachable to be read, and must not imply that Save brings it back (EO-186). */}
        {draft.archivedAt !== null ? (
          <Notice>
            This agent is archived. It is dispatched to nothing and staffs no role; its runs and the comments it wrote are kept, and nothing brings it
            back.
          </Notice>
        ) : null}
      </div>

      <CardSection title="Identity" description="What a person reads, and the role EO dispatches against.">
        <ReadOnlyFence readOnly={locked}>
          <div className="grid gap-3 @xl:grid-cols-2">
            <Field label="Display name">
              <TextInput value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </Field>
            {/* Immutable after creation: steps point at the role by name. */}
            <Field label="Role" {...(isNew ? {} : { hint: "fixed once created" })}>
              <TextInput
                className="font-mono"
                value={draft.role}
                disabled={!isNew}
                // A new agent's `builtin` comes from the same registry the main process uses (KAN-124).
                onChange={(event) => setDraft({ ...draft, role: event.target.value, builtin: isBuiltinRole(registry, event.target.value) })}
              />
            </Field>
          </div>
          {/* Which project's work it is dispatched for (EO-475). Not on the system agent, which `agents:save` keeps global. */}
          {canScope(draft) ? (
            <Field label="Scope" hint={scopeLine(draft, projects)}>
              <Select
                aria-label="Scope"
                value={agentProjectId(draft) ?? GLOBAL_SCOPE}
                onChange={(event) => setDraft({ ...draft, projectId: projectIdFromScope(event.target.value) })}
              >
                {agentScopeOptions(projects, agentProjectId(agent)).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </ReadOnlyFence>
        {/* A project's own copy of this global agent (EO-475): written at once, and not offered under a lock, where it would be refused. */}
        {!locked && onCustomise !== undefined && activeProject !== null && canCustomise(agent, activeProject) ? (
          <Notice
            action={
              <Button size="sm" disabled={busy} onClick={() => onCustomise(agent.id, activeProject.id)}>
                Customise for this project
              </Button>
            }
          >
            <p>
              A copy that only {activeProject.name} uses, with the same role, backend, model, instructions and tools. Editing it leaves this one as it
              is.
            </p>
          </Notice>
        ) : null}
      </CardSection>

      <CardSection title="Runtime" description="Which backend answers, and how. The runtime and the model are always yours to change.">
        <div className="grid gap-3 @xl:grid-cols-2">
          <Field label="Runtime" {...(policy.allowedBackends === null ? {} : { hint: `your organisation allows ${policy.allowedBackends.join(", ") || "no backend"}` })}>
            <Select value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value })}>
              {PROVIDERS.map((choice) => {
                const ok = backendAllowed(policy, choice.id);
                return (
                  // The agent's current backend stays selectable even when disallowed, or opening it would silently re-point it.
                  <option key={choice.id} value={choice.id} disabled={!ok && choice.id !== agent.provider}>
                    {ok ? choice.label : `${choice.label} — ${NOT_ALLOWED_BY_YOUR_ORGANISATION}`}
                  </option>
                );
              })}
            </Select>
          </Field>
          <ModelField
            provider={draft.provider}
            value={draft.model}
            models={models}
            loading={capabilities.isLoading}
            problem={capabilities.data?.problem ?? null}
            onChange={(model) => setDraft({ ...draft, model })}
          />
        </div>
        {allowed ? null : (
          <p role="alert" className="text-[12.5px] text-danger">
            {`"${runtimeLabel(draft.provider)}" is ${NOT_ALLOWED_BY_YOUR_ORGANISATION}. Nothing dispatches to this agent until it is pointed at one that is.`}
          </p>
        )}

        {/* Published from here down: `config` carries the tool surface and EO's own switches (invariant 11). */}
        <ReadOnlyFence readOnly={locked}>
          <ProviderConfig
            provider={draft.provider}
            caps={capabilities.data?.capabilities}
            models={models}
            model={draft.model}
            config={draft.config}
            onChange={(config) => setDraft({ ...draft, config })}
          />
          {/* EO's own switch, not a backend's (EO-88) — and not drawn on a role EO ships, which `reusesThreadPerItem` settles (EO-178). */}
          {!draft.builtin ? (
            <TickOption
              checked={reusesThreadPerItem(registry, draft)}
              onChange={(next) => {
                const config = { ...draft.config };
                if (next) config["reuseThreadPerItem"] = true;
                else delete config["reuseThreadPerItem"];
                setDraft({ ...draft, config });
              }}
            >
              <span className="text-ink">Reuse the thread for a whole {word}</span> — the agent keeps one conversation per {word} instead of starting fresh
              every time, which saves the tokens of re-reading everything it has already read. It will not pick up edits to its instructions until that{" "}
              {word} is done.
            </TickOption>
          ) : null}
          {/* Both backends: EO locks the agent down to the catalogue, and this hands the person's own setup back (EO-107, EO-378). */}
          {draft.provider === "claude" ? (
            <TickOption
              checked={draft.config["inheritAmbientConfig"] === true}
              onChange={(next) => {
                const config = { ...draft.config };
                if (next) config["inheritAmbientConfig"] = true;
                else delete config["inheritAmbientConfig"];
                setDraft({ ...draft, config });
              }}
            >
              <span className="text-ink">Let this agent use your own Claude setup</span> — by default EO gives it the MCP servers and skills you attached
              here and nothing else, ignoring your <code className="font-mono">~/.claude</code> settings and any skills installed on this machine. Tick
              this to hand all of that back, for an agent that depends on it. The repository&apos;s own <code className="font-mono">CLAUDE.md</code> and
              project settings apply either way.
            </TickOption>
          ) : null}
          {draft.provider === "codex" ? (
            <TickOption
              checked={draft.config["inheritAmbientConfig"] === true}
              onChange={(next) => {
                const config = { ...draft.config };
                if (next) config["inheritAmbientConfig"] = true;
                else delete config["inheritAmbientConfig"];
                setDraft({ ...draft, config });
              }}
            >
              <span className="text-ink">Let this agent use your own Codex setup</span> — by default EO gives it the MCP servers and skills you attached
              here and nothing else, ignoring the <code className="font-mono">config.toml</code>, <code className="font-mono">AGENTS.md</code>, skills and
              MCP servers in your <code className="font-mono">~/.codex</code>. Tick this to hand all of that back, for an agent that depends on it. Your
              Codex sign-in, your saved conversations and the repository&apos;s own <code className="font-mono">AGENTS.md</code> apply either way.
            </TickOption>
          ) : null}
          {keyringNotice ? (
            <p role="note" className="text-[11.5px] leading-snug text-paused">
              Your Codex is set to keep its sign-in in your operating system&apos;s keyring, which EO cannot carry into a Codex home of this agent&apos;s own — so
              this agent runs with your own Codex setup, as if the box above were ticked. To lock it down, set{" "}
              <code className="font-mono">cli_auth_credentials_store = &quot;file&quot;</code> in your <code className="font-mono">~/.codex/config.toml</code>{" "}
              and sign in to Codex again.
            </p>
          ) : null}
          {memoryKeyringNotice ? <CodexMemoryKeyringNotice className="text-[11.5px]" /> : null}
        </ReadOnlyFence>

        <RuntimeLine provider={draft.provider} configuredPath={executablePath(draft.config)} />
        {!isNew && draft.provider !== agent.provider ? (
          <p className="text-[11.5px] leading-snug text-ink-subtle">
            Applies from the next dispatch. A run parked mid-conversation can&apos;t move to a different backend, so it restarts as a fresh run — it keeps
            the {word}&apos;s comments, but not the agent&apos;s train of thought.
          </p>
        ) : null}
      </CardSection>

      {/* The system agent's own setting, where its other settings are (EO-578). Published with the config, so fenced under a lock. */}
      {draft.role === "system" ? (
        <ReadOnlyFence readOnly={locked}>
          <CardSection
            title="Memory consolidation"
            description="Consolidation keeps each memory scope under its caps, about once a day, on this agent's model and reasoning effort. Set either here to run it on something else; a field left empty follows the agent."
          >
            <ConsolidationOverride
              provider={draft.provider}
              caps={capabilities.data?.capabilities}
              models={models}
              loading={capabilities.isLoading}
              agentModel={draft.model}
              config={draft.config}
              onChange={(config) => setDraft({ ...draft, config })}
            />
          </CardSection>
        </ReadOnlyFence>
      ) : null}

      <ReadOnlyFence readOnly={locked}>
        <CardSection title="Instructions" description="Applies to the next dispatch, not to runs already in flight.">
          <TextArea
            aria-label="Instructions"
            className="min-h-48 font-mono text-[12px]"
            value={draft.instructions}
            onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
          />
          <OldToolNames text={draft.instructions} />
          {/* Beside it, what the instructions hold that only exists on this machine (EO-450), each by its line. Advice: Save is never refused for it. */}
          <MachineSpecificValues warnings={instructionsMachineSpecificWarnings(draft.instructions, draft.defaultInstructions)} subject="the agent" />
          {/* Only ever over someone's own text: EO updates an unedited prompt itself. Loading it is a draft, not a save. */}
          {draft.defaultInstructions !== null && draft.instructions.trim() !== draft.defaultInstructions.trim() ? (
            <Notice
              action={
                <Button size="sm" onClick={() => setDraft({ ...draft, instructions: draft.defaultInstructions ?? "" })}>
                  Load default
                </Button>
              }
            >
              <p>
                These differ from the instructions EO ships for the <span className="font-mono">{draft.role}</span> role.
              </p>
            </Notice>
          ) : null}
        </CardSection>

        {/* Ticked onto the agent the moment it is made, not carried on this draft (EO-109). */}
        <CardSection title="Tools" description="MCP servers and skills from Agent tools.">
          {isNew ? (
            <p className="text-[12.5px] text-ink-subtle">Create the agent first, then give it MCP servers and skills from Agent tools.</p>
          ) : (
            <AgentToolPicker agentId={draft.id} />
          )}
        </CardSection>
      </ReadOnlyFence>

      {/* The role's, not this agent's, and saved on its own — so outside the fence above and beside its own (EO-427). */}
      {isNew ? null : <ActionsSection role={agent.role} locked={locked} reveal={revealActions} />}

      {/* The bar that saves it, kept in view while the cards above scroll. */}
      <div className="sticky bottom-0 z-[1] flex flex-col gap-2 rounded-[14px] bg-canvas px-[18px] py-3 shadow-panel">
        {error ? <ErrorLine>{error}</ErrorLine> : null}
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {isNew ? (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : draft.archivedAt === null && !locked ? (
            // Whether it is dispatched at all is published with it, so not offered under a lock.
            <Button onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}>{draft.enabled ? "Disable agent" : "Enable agent"}</Button>
          ) : null}
          <Button
            variant="primary"
            disabled={!canSave}
            onClick={() =>
              onSave({
                ...(isNew ? {} : { id: draft.id }),
                name: draft.name,
                role: draft.role,
                provider: draft.provider,
                model: draft.model,
                instructions: draft.instructions,
                enabled: draft.enabled,
                config: draft.config,
                // Left out on the system agent: absent keeps what is stored, which is global.
                ...(canScope(draft) ? { projectId: agentProjectId(draft) } : {}),
              })
            }
          >
            {/* Says which of the two saves this is: under a lock only the backend and the model are written (ARCHITECTURE.md, "Publish, lock and versions"). */}
            {isNew ? "Create agent" : locked ? "Save backend" : "Save changes"}
          </Button>
        </div>
      </div>
    </section>
  );
}
