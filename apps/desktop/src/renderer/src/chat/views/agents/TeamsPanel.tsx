import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Archive, Lock, LockOpen, SlidersHorizontal, Sparkles, Trash2 } from "lucide-react";
import { backendAllowed, memberModeWords, NOT_ALLOWED_BY_YOUR_ORGANISATION, summarizeInstructions } from "@eo/core";
import type { TeamMemberView, TeamVersionView, TeamView } from "@eo/core";
import { cn } from "@eo/ui";
import { ipcQuery } from "../../../query/client";
import { agentsKey, useLockedSections, usePolicy } from "../../../query/hooks";
import { useInvalidateOnPush } from "../../../query/useInvalidateOnPush";
import { PROVIDERS, runtimeLabel } from "../../../shared/agents/catalog";
import { useRuntimeStatus } from "../../../shared/agents/runtimeStatus";
import { useAskAssistant } from "../../askAssistant";
import { Button, CardSection, Chip, Dialog, EmptyState, ErrorLine, Facts, Field, Loading, Select } from "../../kit";
import { when } from "../item/parts";
import { agentDetailsKey } from "../../../shared/settings/primitives";
import { ModelField, reasoningLevelsFor } from "./AgentEditor";

/**
 * The Teams tab of Agents (EO-884): every declared team, drawn where its
 * agents are. A team's leader and members are agents, each with its own
 * kind, runtime, model, reasoning and instructions, and the team beside
 * them declares a tool pool, a model range, limits and a member cap.
 *
 * What a person does to a team here: change any member's runtime, model
 * and reasoning effort — the leader's included — each a new version of
 * the team; restore an earlier version, which puts back its members'
 * settings too; and lock it against every change, its leader's additions
 * included. Its instructions and its membership are changed only through
 * the assistant's draft and Publish, or by its leader adding a member
 * (EO-880) — so nothing here edits them, and the one way to is the link
 * to the assistant.
 *
 * And archive or delete it (EO-897), its own agents with it: asked first
 * unconfirmed, which changes nothing and says what goes with it, or why it
 * is refused — a lock, or the steps that still name it.
 */

/** Under `agentsKey`, so whatever refreshes the agents refreshes the teams naming them. */
export const teamsKey = ["agents", "teams"] as const;

const LIMIT_WORDS: Record<string, string> = {
  maxParticipants: "Participants in all",
  maxParallel: "At once",
  maxRounds: "Rounds",
  maxRetries: "Retries of a failed run",
  timeoutMs: "Time limit",
  budgetCents: "Budget",
};

function limitValue(key: string, value: number): string {
  if (key === "timeoutMs") return `${String(Math.round(value / 60_000))} min`;
  if (key === "budgetCents") return `$${(value / 100).toFixed(2)}`;
  return String(value);
}

function listed(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

/** Whether this machine is known to be signed out of a backend: false where it is signed in, or nothing can be asked. */
function useSignedOut(provider: string): boolean {
  const runtime = useRuntimeStatus(provider).data?.runtime ?? null;
  return runtime !== null && runtime.auth.state === "signed_out";
}

/** Says, where a member's runtime is shown or chosen, that this machine is not signed in to it (invariant 12). */
function SignedOutLine({ provider }: { provider: string }) {
  if (!useSignedOut(provider)) return null;
  return (
    <p role="note" className="text-[12px] text-paused">
      This machine is not signed in to {runtimeLabel(provider)}, so this member cannot run here until somebody signs in on the Runtimes tab.
    </p>
  );
}

function AddedBy({ member }: { member: TeamMemberView }) {
  const origin = member.addedBy;
  if (origin.kind === "leader") {
    return (
      <span>
        Added by the team's leader, on{" "}
        <Link to={`/items/${origin.itemId}`} className="font-mono text-accent hover:underline">
          {origin.itemKey ?? "an item"}
        </Link>
      </span>
    );
  }
  if (origin.kind === "person") return <span>Added by {origin.personName ?? "a person"}</span>;
  if (origin.kind === "assistant") return <span>Added by a person, through the assistant</span>;
  // Neither of EO's tools adds a member (EO-900), but a version either made is what a member's origin is read from.
  if (origin.kind === "system") return <span>Added by EO's system agent</span>;
  if (origin.kind === "client") return <span>Added by an outside client, over EO's MCP server</span>;
  return <span>Added when EO declared a team that already existed (from a step, an import or the record)</span>;
}

/**
 * A member's runtime, model and reasoning effort, chosen (EO-884): the only
 * part of a member the Teams tab edits. Saved as a new version of the team.
 * A backend this machine is not signed in to says so in the picker and
 * under it (invariant 12); one the organisation does not allow is offered
 * only where the member is already on it.
 */
function MemberSettingsEditor({ teamId, member, label, onDone }: { teamId: string; member: TeamMemberView; label: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const { policy } = usePolicy();
  const [provider, setProvider] = useState(member.provider ?? "claude");
  const [model, setModel] = useState<string | null>(member.model);
  const [reasoning, setReasoning] = useState<string | null>(member.reasoning);
  const signedOut: Record<string, boolean> = { claude: useSignedOut("claude"), codex: useSignedOut("codex") };
  const capabilities = useQuery({
    queryKey: ["providers", provider],
    queryFn: () => ipcQuery("providers:capabilities", { provider, refreshModels: true }),
    staleTime: Infinity,
  });
  const models = capabilities.data?.models ?? [];
  const levels = reasoningLevelsFor(provider, capabilities.data?.capabilities, models, model);
  const shownLevels = reasoning !== null && !levels.includes(reasoning) ? [...levels, reasoning] : levels;
  const save = useMutation({
    mutationFn: () => ipcQuery("teams:setMemberSettings", { teamId, agentId: member.agentId, provider, model, reasoning: levels.length === 0 ? null : reasoning }),
    onSuccess: (result) => {
      if (result.problem !== null) return;
      void queryClient.invalidateQueries({ queryKey: teamsKey });
      void queryClient.invalidateQueries({ queryKey: agentDetailsKey });
      void queryClient.invalidateQueries({ queryKey: agentsKey });
      onDone();
    },
  });
  const problem = save.error?.message ?? save.data?.problem ?? null;

  return (
    <div role="group" aria-label={`${label}'s runtime, model and reasoning`} className="flex min-w-0 flex-col gap-2 rounded-[10px] bg-canvas px-3 py-2.5">
      <div className="grid gap-3 @xl:grid-cols-3">
        <Field label="Runtime" {...(policy.allowedBackends === null ? {} : { hint: `your organisation allows ${policy.allowedBackends.join(", ") || "no backend"}` })}>
          <Select
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value);
              setModel(null);
              setReasoning(null);
            }}
          >
            {PROVIDERS.map((choice) => {
              const ok = backendAllowed(policy, choice.id);
              const words = !ok ? ` — ${NOT_ALLOWED_BY_YOUR_ORGANISATION}` : signedOut[choice.id] === true ? " — not signed in on this machine" : "";
              return (
                <option key={choice.id} value={choice.id} disabled={!ok && choice.id !== member.provider}>
                  {choice.label}
                  {words}
                </option>
              );
            })}
          </Select>
        </Field>
        <ModelField
          provider={provider}
          value={model}
          models={models}
          loading={capabilities.isLoading}
          problem={capabilities.data?.problem ?? null}
          onChange={(next) => {
            setModel(next);
            setReasoning(null);
          }}
        />
        {shownLevels.length > 0 ? (
          <Field label="Reasoning effort">
            <Select value={reasoning ?? ""} onChange={(event) => setReasoning(event.target.value || null)}>
              <option value="">provider default</option>
              {shownLevels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>
      <SignedOutLine provider={provider} />
      {problem !== null ? <ErrorLine>{problem}</ErrorLine> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="primary" size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
          Save as a new version
        </Button>
        <Button size="sm" disabled={save.isPending} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function MemberCard({ teamId, member, role, editable }: { teamId: string; member: TeamMemberView; role: "Leader" | "Member"; editable: boolean }) {
  const label = member.name ?? "An agent that no longer exists";
  const summary = summarizeInstructions(member.instructions);
  const [editing, setEditing] = useState(false);
  const canEdit = editable && !member.archived;
  return (
    <li aria-label={`${role} ${label}`} className="flex min-w-0 flex-col gap-1.5 rounded-[12px] bg-canvas-subtle px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        {member.kind !== null ? <Chip tone="tag">{member.kind}</Chip> : null}
        {member.key !== null ? <span className="font-mono text-[11.5px] text-ink-subtle">{member.key}</span> : null}
        {member.archived ? <Chip tone="paused">archived</Chip> : null}
        {canEdit && !editing ? (
          <span className="ml-auto">
            <Button size="sm" icon={<SlidersHorizontal size={12} />} onClick={() => setEditing(true)}>
              Change runtime, model or reasoning
            </Button>
          </span>
        ) : null}
      </div>
      {editing && canEdit ? <MemberSettingsEditor teamId={teamId} member={member} label={label} onDone={() => setEditing(false)} /> : null}
      <Facts
        label={`${label}'s settings`}
        items={[
          { term: "Runtime", value: member.provider === null ? "—" : runtimeLabel(member.provider) },
          { term: "Model", value: member.model ?? "the runtime's default" },
          { term: "Reasoning effort", value: member.reasoning ?? "the model's default" },
          { term: "Added", value: <AddedBy member={member} /> },
        ]}
      />
      {member.provider !== null ? <SignedOutLine provider={member.provider} /> : null}
      {member.teamInstructions !== null ? (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[11.5px] text-ink-subtle">{role === "Leader" ? "What the team asks of its leader" : "What the team asks of it"}</span>
          <p className="whitespace-pre-line text-[12.5px] text-ink">{member.teamInstructions}</p>
        </div>
      ) : null}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[11.5px] text-ink-subtle">Its own instructions</span>
        {member.instructions.trim() === "" ? (
          <p className="text-[12.5px] text-ink-muted">None.</p>
        ) : (
          // Read-only: instructions change only through the assistant's draft (EO-884).
          <details className="group min-w-0">
            <summary className="cursor-pointer text-[12.5px] text-ink-muted">
              {summary ?? "Show all"} <span className="text-ink-subtle group-open:hidden">· Show all</span>
            </summary>
            <p aria-label={`${label}'s instructions`} className="mt-1 whitespace-pre-wrap break-words text-[12.5px] text-ink">
              {member.instructions}
            </p>
          </details>
        )}
      </div>
    </li>
  );
}

function VersionAuthor({ version }: { version: TeamVersionView }) {
  const author = version.author;
  if (author.kind === "leader") {
    return (
      <span>
        {version.authorName ?? "The team's leader"}, leading on{" "}
        <Link to={`/items/${author.itemId}`} className="font-mono text-accent hover:underline">
          {version.itemKey ?? "an item"}
        </Link>
      </span>
    );
  }
  if (author.kind === "person") return <span>{version.authorName ?? "A person"}</span>;
  if (author.kind === "assistant") return <span>The assistant, in a draft a person published</span>;
  // Members' runtime, model and reasoning, set through EO's tools (EO-900).
  if (author.kind === "system") return <span>{version.authorName ?? "EO's system agent"}, EO's system agent</span>;
  if (author.kind === "client") return <span>An outside client, over EO's MCP server</span>;
  // A version EO made for a reason of its own says it in its note (EO-899).
  if (version.note !== null) return <span>EO</span>;
  return <span>EO, declaring a team that already existed (from a step, an import or the record)</span>;
}

/** The link to the one place a team's instructions and members change. */
function ChangeWithAssistant() {
  const askAssistant = useAskAssistant();
  const navigate = useNavigate();
  return (
    <Button icon={<Sparkles size={13} />} onClick={() => (askAssistant ? askAssistant() : void navigate("/chat"))}>
      Change members or instructions with the assistant
    </Button>
  );
}

type TeamRemoval = "archive" | "delete";

/** The answer to an archive or delete, whichever was asked. */
interface RemovalAnswer {
  done: boolean;
  problem: string | null;
  members: string[];
}

function removeTeam(teamId: string, removal: TeamRemoval, confirm: boolean): Promise<RemovalAnswer> {
  return removal === "delete"
    ? ipcQuery("teams:delete", { teamId, confirm }).then((result) => ({ done: result.deleted, problem: result.problem, members: result.members }))
    : ipcQuery("teams:archive", { teamId, confirm }).then((result) => ({ done: result.archived, problem: result.problem, members: result.members }));
}

/**
 * The confirmation in front of archiving or deleting a team (EO-897). What
 * it says is the main process's unconfirmed answer, not anything cached:
 * nothing is offered to confirm until that answer is in, and a refusal is
 * shown as the sentence it came back as.
 */
function ConfirmRemoveTeam({ team, removal, onDone, onCancel }: { team: TeamView; removal: TeamRemoval; onDone: () => void; onCancel: () => void }) {
  const verb = removal === "delete" ? "Delete" : "Archive";
  const asked = useQuery({ queryKey: ["teams", "removal", team.id, removal], queryFn: () => removeTeam(team.id, removal, false), gcTime: 0, staleTime: 0 });
  const confirm = useMutation({
    mutationFn: () => removeTeam(team.id, removal, true),
    onSuccess: (answer) => {
      if (answer.done) onDone();
    },
  });
  const answer = asked.data ?? null;
  const problem = confirm.error?.message ?? (confirm.data !== undefined && !confirm.data.done ? (confirm.data.problem ?? "Nothing was changed.") : null) ?? asked.error?.message ?? answer?.problem ?? null;
  const offered = answer !== null && answer.problem === null;

  return (
    <Dialog
      open
      onClose={onCancel}
      busy={confirm.isPending}
      title={`${verb} ${team.name}?`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={confirm.isPending}>
            {offered ? "Keep it" : "Close"}
          </Button>
          {offered ? (
            <Button variant="danger" disabled={confirm.isPending} onClick={() => confirm.mutate()}>
              {verb} {team.name}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px] leading-relaxed text-ink-muted">
        {asked.isLoading ? <p role="status">Checking what uses it…</p> : null}
        {offered ? (
          <>
            <p>
              {removal === "delete"
                ? "The team and its versions go, and its own agents with it. Their past runs and comments keep their names. This cannot be undone."
                : "It leaves this tab and no step can run as it. Its own agents are archived with it, and nothing brings it back."}
            </p>
            {answer.members.length > 0 ? (
              <div aria-label="Agents that go with it" className="flex flex-col gap-1">
                <p>Its own agents go with it:</p>
                <ul className="list-disc pl-5">
                  {answer.members.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
        {problem !== null ? (
          <p role="alert" className="text-danger">
            {problem}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function TeamDetail({ team }: { team: TeamView }) {
  const queryClient = useQueryClient();
  // Restoring or unlocking changes what the graph's steps run as, so an organisation's published pipelines hold both (EO-884).
  const graphManaged = useLockedSections().isLocked("pipelines");
  const refresh = () => void queryClient.invalidateQueries({ queryKey: teamsKey });
  const restore = useMutation({
    mutationFn: (version: number) => ipcQuery("teams:restore", { teamId: team.id, version }),
    onSuccess: () => {
      refresh();
      // A restore can put members' runtimes back, which the Agents tab draws.
      void queryClient.invalidateQueries({ queryKey: agentDetailsKey });
    },
  });
  const lock = useMutation({ mutationFn: (locked: boolean) => ipcQuery("teams:setLocked", { teamId: team.id, locked }), onSuccess: refresh });
  const problem = restore.error?.message ?? lock.error?.message ?? (restore.data?.restored === false ? restore.data.problem : null) ?? lock.data?.problem ?? null;
  const [removing, setRemoving] = useState<TeamRemoval | null>(null);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <CardSection
        title={team.name}
        titleAside={team.locked ? <Chip tone="paused">Locked</Chip> : null}
        description={
          team.coordination === null
            ? "EO cannot read what this team declares. Restore an earlier version, or ask the assistant to declare it again."
            : `${team.coordination === "leader" ? "Leader-led" : "Independent"}, with ${memberModeWords(team.memberMode ?? "report_only")} members${team.projectName === null ? "" : ` · ${team.projectName}`} · version ${String(team.version)}`
        }
        actions={
          // Archiving and deleting a team are writes into the graph too, held by the same lock (EO-897).
          graphManaged ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <Button icon={team.locked ? <LockOpen size={13} /> : <Lock size={13} />} disabled={lock.isPending} onClick={() => lock.mutate(!team.locked)}>
                {team.locked ? "Unlock" : "Lock"}
              </Button>
              <Button icon={<Archive size={13} />} onClick={() => setRemoving("archive")}>
                Archive
              </Button>
              <Button icon={<Trash2 size={13} />} onClick={() => setRemoving("delete")}>
                Delete
              </Button>
            </div>
          )
        }
      >
        <p className="text-[12.5px] text-ink-subtle">
          {team.locked
            ? "Locked: nothing changes this team — not the assistant's draft, not a restore, not its leader adding a member — until a person unlocks it."
            : "Unlocked: a draft a person publishes, a restore, or its leader adding a member can change it, each as a new version."}
          {graphManaged ? " Your organisation manages the pipelines, so the team can't be locked or unlocked here." : null}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <ChangeWithAssistant />
          <span className="text-[12px] text-ink-subtle">A team's instructions and members change only through the assistant's draft, or by its leader adding a member.</span>
        </div>
        {problem !== null ? <ErrorLine>{problem}</ErrorLine> : null}
        {removing !== null ? (
          <ConfirmRemoveTeam
            team={team}
            removal={removing}
            onCancel={() => setRemoving(null)}
            onDone={() => {
              setRemoving(null);
              refresh();
            }}
          />
        ) : null}
      </CardSection>

      {team.leader !== null ? (
        <CardSection title="Leader" description="Assigns the work to members and answers the step's action.">
          <ul className="flex min-w-0 flex-col gap-2">
            <MemberCard teamId={team.id} member={team.leader} role="Leader" editable={!team.locked} />
          </ul>
        </CardSection>
      ) : null}

      <CardSection
        title="Members"
        description={`${team.memberCap === null ? "" : `${String(team.members.length)} of at most ${String(team.memberCap)}. `}${team.locked ? "Unlock the team to change a member's runtime, model or reasoning." : "Each change to a member's runtime, model or reasoning is a new version of the team."}`}
      >
        <ul className="flex min-w-0 flex-col gap-2">
          {team.members.map((member) => (
            <MemberCard key={member.key ?? member.agentId} teamId={team.id} member={member} role="Member" editable={!team.locked} />
          ))}
        </ul>
      </CardSection>

      <CardSection title="What it may use" description="What a member may be given, and what a member its leader adds may run on.">
        <Facts
          label="Tool pool, model range and limits"
          items={[
            { term: "CLI tools", value: listed(team.toolPool?.cliTools ?? []) },
            { term: "MCP servers", value: listed(team.toolPool?.mcpServers ?? []) },
            { term: "Skills", value: listed(team.toolPool?.skills ?? []) },
            { term: "Runtimes", value: listed((team.modelRange?.runtimes ?? []).map(runtimeLabel)) },
            { term: "Models", value: listed(team.modelRange?.models ?? []) },
            { term: "Reasoning", value: listed(team.modelRange?.reasoning ?? []) },
            { term: "Member cap", value: team.memberCap === null ? "—" : String(team.memberCap) },
            ...Object.entries(team.limits ?? {}).map(([key, value]) => ({ term: LIMIT_WORDS[key] ?? key, value: limitValue(key, value) })),
          ]}
        />
      </CardSection>

      <CardSection title="Used by" description="The pipeline steps that run as this team.">
        {team.steps.length === 0 ? (
          <p className="text-[12.5px] text-ink-subtle">No step runs as this team.</p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-1 text-[12.5px]">
            {team.steps.map((step) => (
              <li key={step.stepId}>
                <Link to={`/pipelines/${step.pipelineId}`} className="text-ink hover:underline">
                  {step.pipelineName} · {step.stepName}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardSection>

      <CardSection
        title="Versions"
        description={
          team.locked
            ? "Unlock the team to restore one."
            : graphManaged
              ? "Your organisation manages the pipelines, so a version can't be restored here."
              : "Restoring one puts it back as a new version, its members' runtime, model and reasoning with it."
        }
      >
        <ol aria-label="Versions" className="flex min-w-0 flex-col gap-1.5">
          {team.versions.map((version) => (
            <li key={version.number} aria-label={`Version ${String(version.number)}`} className="flex min-w-0 flex-wrap items-center gap-2 text-[12.5px]">
              <span className="font-mono text-ink">v{version.number}</span>
              <span className="text-ink-muted">
                <VersionAuthor version={version} />
              </span>
              <span className="text-ink-subtle">{when(version.createdAt)}</span>
              {version.restoredFrom !== null ? <span className="text-ink-subtle">restored v{version.restoredFrom}</span> : null}
              {version.note !== null ? <span className="min-w-0 basis-full text-ink-subtle">{version.note}</span> : null}
              {version.number === team.version ? (
                <Chip tone="success">current</Chip>
              ) : team.locked || graphManaged ? null : (
                <Button size="sm" disabled={restore.isPending} onClick={() => restore.mutate(version.number)}>
                  Restore
                </Button>
              )}
            </li>
          ))}
        </ol>
      </CardSection>
    </div>
  );
}

export function TeamsPanel({ selectedId, onSelect }: { selectedId: string | null; onSelect: (teamId: string) => void }) {
  const teams = useQuery({ queryKey: teamsKey, queryFn: () => ipcQuery("teams:list", undefined) });
  useInvalidateOnPush("config:changed", teamsKey);
  const all = teams.data?.teams ?? [];
  const selected = all.find((team) => team.id === selectedId) ?? all[0] ?? null;
  // The team drawn is the team picked, so what the view publishes is the one the person sees.
  const shownId = selected?.id ?? null;
  useEffect(() => {
    if (shownId !== null && shownId !== selectedId) onSelect(shownId);
  }, [shownId, selectedId, onSelect]);

  if (teams.isLoading) return <Loading />;
  if (teams.error) return <ErrorLine>{teams.error.message}</ErrorLine>;
  if (selected === null) {
    return (
      <EmptyState title="No team is declared yet." action={<ChangeWithAssistant />}>
        A team is declared through the assistant's draft, and a step runs as it once the draft is published.
      </EmptyState>
    );
  }
  return (
    <div className="flex min-w-0 flex-1 gap-4">
      <nav aria-label="Team list" className="flex w-[12.5rem] shrink-0 flex-col gap-0.5 @3xl:w-[15rem]">
        <ul aria-label="Teams" className="flex min-w-0 flex-col gap-0.5">
          {all.map((team) => (
            <li key={team.id}>
              <button
                type="button"
                onClick={() => onSelect(team.id)}
                aria-current={team.id === selected.id}
                className={cn("flex w-full min-w-0 flex-col gap-0.5 rounded-[10px] px-2.5 py-2 text-left", team.id === selected.id ? "bg-canvas-raised" : "hover:bg-canvas-subtle")}
              >
                <span className={cn("truncate text-[13px]", team.id === selected.id ? "text-ink" : "text-ink-muted")}>{team.name}</span>
                <span className="truncate text-[11px] text-ink-subtle">
                  {team.leader === null ? "" : `Led by ${team.leader.name ?? "an agent that no longer exists"} · `}
                  {String(team.members.length)} {team.members.length === 1 ? "member" : "members"}
                  {team.locked ? " · locked" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <TeamDetail key={selected.id} team={selected} />
      </div>
    </div>
  );
}
