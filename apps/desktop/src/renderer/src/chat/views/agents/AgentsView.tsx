import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Bot, MoreHorizontal, Plus } from "lucide-react";
import { summarizeInstructions } from "@eo/core";
import type { AgentDetail, AgentRemovalImpact, IpcRequest } from "@eo/core";
import { cn } from "@eo/ui";
import { ipcQuery } from "../../../query/client";
import { agentAttachmentsKey, agentsKey, useLockedSections, useRegistry } from "../../../query/hooks";
import { agentDetailsKey } from "../../../shared/settings/primitives";
import { runtimeLabel } from "../../../shared/agents/catalog";
import { machineAvailable } from "../../../ipc/bridge";
import { agentStatus, executablePath } from "../../../shared/agents/agents";
import type { AgentRemoval } from "../../../shared/agents/removal";
import { runtimeState, useRuntimeStatus } from "../../../shared/agents/runtimeStatus";
import { useViewParameters } from "../../../shared/view/ViewPublisher";
import { groupAgentsByScope, groupHeading, useScopeProjects } from "../../../shared/agents/agentScope";
import { ManagedLockLine } from "../../managed/ManagedSection";
import { Button, EmptyState, ErrorLine, Loading, Menu, SearchInput, Select, StatusDot, Tabs, ViewHeader, type MenuEntry } from "../../kit";
import { ACTIONS_FACET } from "./address";
import { AgentEditor } from "./AgentEditor";
import { ConfirmRemove } from "./ConfirmRemove";
import { RuntimesPanel } from "./RuntimesPanel";
import { toneOf } from "./runtime";

/**
 * Agents (`/agents`), drawn in the chat layout's own terms: the agents
 * as a narrow list on the left and the open one's editor as cards on the
 * right, with the machine's runtimes on a second tab.
 *
 * Everything the classic screen does, it does: search and the role,
 * status and archived filters; a menu per agent with Edit, Enable or
 * Disable, Archive and Delete (Edit and Delete only on an archived one,
 * Edit only under an organisation lock); archive and delete behind the
 * confirmation that names what they take away (EO-350); two saves under
 * a lock (`agents:save` for the published fields, `agents:setBinding`
 * for the runtime and model); the Runtimes tab only where this machine
 * can be asked (`machineAvailable()`). And it publishes exactly what the
 * classic screen publishes (EO-192) — the *effective* selection, nothing
 * while New agent is open, and only the tab while Runtimes is.
 *
 * Not wrapped in `ManagedSection`: a fence around the whole view would
 * take the runtime picker with it, so the lock is drawn around the
 * published fields alone (`AgentEditor`).
 */

type Tab = "agents" | "runtimes";

/** One agent in the list. The menu sits beside the row's button, never inside it. */
function AgentRow({
  agent,
  selected,
  locked,
  onSelect,
  onToggleEnabled,
  onArchive,
  onDelete,
}: {
  agent: AgentDetail;
  selected: boolean;
  locked: boolean;
  onSelect: () => void;
  onToggleEnabled: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  // The agent's own copy when it has one: signed in is a fact about the binary this agent would run (EO-82).
  const runtime = useRuntimeStatus(agent.provider, executablePath(agent.config)).data?.runtime ?? null;
  const managedState = runtime ? runtimeState(runtime) : null;
  const status = agentStatus(agent.enabled, agent.archivedAt, managedState === "disabled" && executablePath(agent.config) ? "ready" : managedState);
  const summary = summarizeInstructions(agent.instructions);

  // Disable, Archive and Delete are writes into a published section, refused under a lock — so left off rather than drawn dead (EO-329).
  // Nothing un-archives, so an archived agent is offered Edit and Delete only (EO-186, EO-350).
  const entries: MenuEntry[] = locked
    ? [{ label: "Edit", onSelect }]
    : agent.archivedAt !== null
      ? [
          { label: "Edit", onSelect },
          { label: "Delete", onSelect: onDelete, tone: "danger" },
        ]
      : [
          { label: "Edit", onSelect },
          { label: agent.enabled ? "Disable" : "Enable", onSelect: onToggleEnabled },
          { label: "Archive", onSelect: onArchive },
          { label: "Delete", onSelect: onDelete, tone: "danger" },
        ];

  return (
    <li className="relative">
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected}
        className={cn(
          "flex w-full min-w-0 items-start gap-2.5 rounded-[10px] py-2 pl-2.5 pr-9 text-left",
          selected ? "bg-canvas-raised" : "hover:bg-canvas-subtle",
          agent.archivedAt !== null && "opacity-70",
        )}
      >
        <span className="mt-[6px] flex">
          <StatusDot tone={toneOf(status.tone)} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn("truncate text-[13px]", selected ? "text-ink" : "text-ink-muted")}>{agent.name}</span>
          <span className="truncate font-mono text-[11px] text-ink-subtle">{agent.role}</span>
          <span className="truncate text-[11px] text-ink-subtle">
            {runtimeLabel(agent.provider)} · {agent.model ?? "default model"}
          </span>
          <span className="truncate text-[11px] text-ink-subtle">
            {status.label} · Pipelines: {agent.pipelineCount}
          </span>
          {/* What it is told, in a line, as the classic card said it. */}
          {summary ? <span className="line-clamp-2 text-[11px] leading-snug text-ink-subtle">{summary}</span> : null}
        </span>
      </button>
      <span className="absolute right-1 top-1">
        <Menu label={`Actions for ${agent.name}`} trigger={<MoreHorizontal size={15} />} entries={entries} />
      </span>
    </li>
  );
}

export function AgentsView() {
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: agentDetailsKey, queryFn: () => ipcQuery("agents:listDetailed", undefined) });
  const { registry } = useRegistry();
  const [tab, setTab] = useState<Tab>("agents");
  // A runtime is a CLI on *this* disk (EO-319): on an organisation server there is no tab.
  const runtimesTab = machineAvailable();
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState<AgentDetail | null>(null);
  const [addingRuntime, setAddingRuntime] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  /** A refused binding or archive, said where the list is rather than beside the prompt (EO-186). */
  const [rowProblem, setRowProblem] = useState<string | null>(null);
  const locked = useLockedSections().isLocked("agents");
  // `?actions=<role>` (EO-428): the role whose Actions section somebody was sent here for.
  const [searchParams] = useSearchParams();
  const actionsRole = searchParams.get(ACTIONS_FACET);

  const save = useMutation({
    mutationFn: (input: IpcRequest<"agents:save">) => ipcQuery("agents:save", input),
    onSuccess: (result) => {
      // A refusal leaves the editor open, holding what was typed (EO-328).
      if (!result.saved) return;
      void queryClient.invalidateQueries({ queryKey: agentDetailsKey });
      void queryClient.invalidateQueries({ queryKey: agentsKey });
      setCreating(null);
    },
  });

  /** The local half of an agent — see `agents:setBinding`. */
  const bind = useMutation({
    mutationFn: (input: { agentId: string; provider: string; model: string | null }) => ipcQuery("agents:setBinding", input),
    onSuccess: (result) => {
      if (!result.bound) {
        setRowProblem(result.problem);
        return;
      }
      setRowProblem(null);
      void queryClient.invalidateQueries({ queryKey: agentDetailsKey });
      void queryClient.invalidateQueries({ queryKey: agentsKey });
    },
  });

  /** A project's own copy of a global agent (EO-475), opened in the editor the moment it exists. */
  const { projects, activeProject } = useScopeProjects();
  const customise = useMutation({
    mutationFn: (input: { agentId: string; projectId: string }) => ipcQuery("agents:customise", input),
    onSuccess: (result) => {
      if (!result.saved || result.agent === null) return;
      void queryClient.invalidateQueries({ queryKey: agentDetailsKey });
      void queryClient.invalidateQueries({ queryKey: agentsKey });
      // The copy's MCP servers and skills were written with it, into a
      // join the picker reads from its own cache entry. Left alone, the
      // copy's editor would draw the answer from before it existed —
      // every copied tool unticked, and nothing to untick.
      void queryClient.invalidateQueries({ queryKey: agentAttachmentsKey });
      setCreating(null);
      setSelectedId(result.agent.id);
    },
  });

  /** Archiving or deleting: asked first with `confirm: false`, which changes nothing and answers with what would be affected (EO-350). */
  const [removing, setRemoving] = useState<{
    id: string;
    name: string;
    removal: AgentRemoval;
    impact: AgentRemovalImpact | null;
    problem: string | null;
  } | null>(null);
  const removeAgent = (id: string, removal: AgentRemoval, confirm: boolean) =>
    removal === "delete"
      ? ipcQuery("agents:delete", { id, confirm }).then((result) => ({ done: result.deleted, problem: result.problem, impact: result.impact }))
      : ipcQuery("agents:archive", { id, confirm }).then((result) => ({ done: result.archived, problem: result.problem, impact: result.impact }));
  const askToRemove = useMutation({
    mutationFn: (input: { id: string; removal: AgentRemoval }) => removeAgent(input.id, input.removal, false),
    onSuccess: (answer, input) => setRemoving((current) => (current?.id === input.id ? { ...current, impact: answer.impact, problem: answer.problem } : current)),
    onError: (error: Error, input) => setRemoving((current) => (current?.id === input.id ? { ...current, problem: error.message } : current)),
  });
  const confirmRemove = useMutation({
    mutationFn: (input: { id: string; removal: AgentRemoval }) => removeAgent(input.id, input.removal, true),
    onSuccess: (answer) => {
      if (!answer.done) {
        setRemoving((current) => (current === null ? null : { ...current, problem: answer.problem ?? "Nothing was changed." }));
        return;
      }
      setRemoving(null);
      setRowProblem(null);
      void queryClient.invalidateQueries({ queryKey: agentDetailsKey });
      void queryClient.invalidateQueries({ queryKey: agentsKey });
    },
    onError: (error: Error) => setRemoving((current) => (current === null ? null : { ...current, problem: error.message })),
  });
  const openRemove = (agent: { id: string; name: string }, removal: AgentRemoval) => {
    setRemoving({ id: agent.id, name: agent.name, removal, impact: null, problem: null });
    askToRemove.mutate({ id: agent.id, removal });
  };

  const all = agents.data?.agents ?? [];
  // Retired agents are listed and hidden, not dropped (EO-186).
  const live = all.filter((agent) => agent.archivedAt === null);
  const archived = all.filter((agent) => agent.archivedAt !== null);
  // `?actions=<role>` names a role, not an agent (EO-428), and is asked
  // of every agent rather than of what the filters leave: a live one
  // first, since that is who a pipeline step dispatches, and otherwise a
  // retired one — a step can still name a role nobody live holds, and
  // its actions are still that role's. Falling through to the first
  // agent in the list would open another role's actions under an
  // address that named this one.
  const addressed = actionsRole === null ? undefined : (live.find((agent) => agent.role === actionsRole) ?? archived.find((agent) => agent.role === actionsRole));
  // A retired agent the address opened is listed while it is what is
  // open, so the editor is never of a row the list does not have.
  const addressedOnly = addressed !== undefined && addressed.archivedAt !== null && selectedId === null && !showArchived ? [addressed] : [];
  const shown = showArchived ? [...live, ...archived] : [...live, ...addressedOnly];
  const roles = [...new Set(shown.map((agent) => agent.role))];
  const needle = search.trim().toLowerCase();
  const visible = shown
    .filter((agent) => needle === "" || `${agent.name} ${agent.role} ${agent.provider}`.toLowerCase().includes(needle))
    .filter((agent) => roleFilter === "" || agent.role === roleFilter)
    // An archived agent answers neither Enabled nor Disabled.
    .filter((agent) => statusFilter === "" || (agent.archivedAt === null && (statusFilter === "enabled") === agent.enabled));
  // Grouped by scope (EO-475): the global agents, then each project's own.
  const groups = groupAgentsByScope(visible, projects);
  // Never a blank editor while there is anything to edit. Until somebody
  // picks one, an address that names a role opens the agent it resolved to.
  const selected = creating ?? visible.find((agent) => agent.id === selectedId) ?? addressed ?? groups[0]?.agents[0] ?? null;

  // What this view has picked out (EO-192): the effective selection, none while New agent is open, and none on Runtimes.
  const onAgents = tab === "agents";
  const selectedAgentId = onAgents && creating === null && selected !== null ? selected.id : null;
  useViewParameters({
    selection: selectedAgentId === null ? [] : [selectedAgentId],
    filter: onAgents
      ? { text: search, facets: { tab, role: roleFilter || "all", status: statusFilter || "all", archived: showArchived ? "true" : "false" } }
      : { text: "", facets: { tab } },
  });

  // `builtin: false` because the role is empty; recomputed as the role is typed.
  const blank: AgentDetail = {
    id: "",
    name: "",
    role: "",
    provider: "fake",
    model: null,
    enabled: true,
    archivedAt: null,
    instructions: "",
    defaultInstructions: null,
    builtin: false,
    config: {},
    pipelineCount: 0,
    projectId: null,
  };

  const row = (agent: AgentDetail) => (
    <AgentRow
      key={agent.id}
      agent={agent}
      selected={creating === null && selected?.id === agent.id}
      locked={locked}
      onSelect={() => {
        setCreating(null);
        setSelectedId(agent.id);
      }}
      onToggleEnabled={() =>
        save.mutate({
          id: agent.id,
          name: agent.name,
          role: agent.role,
          provider: agent.provider,
          model: agent.model,
          instructions: agent.instructions,
          enabled: !agent.enabled,
          config: agent.config,
        })
      }
      onArchive={() => openRemove(agent, "archive")}
      onDelete={() => openRemove(agent, "delete")}
    />
  );

  // One list, a group per scope inside it (EO-475).
  const list = (
    <ul aria-label="Agents" className="flex min-w-0 flex-col gap-3">
      {groups.map((group) => (
        <li key={group.key}>
          <section aria-label={groupHeading(group)} className="flex min-w-0 flex-col gap-0.5">
            <h3 className="truncate px-2.5 text-[11px] font-medium uppercase tracking-wide text-ink-subtle">{groupHeading(group)}</h3>
            <ul className="flex min-w-0 flex-col gap-0.5">{group.agents.map(row)}</ul>
          </section>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="@container flex min-w-0 flex-col">
      <ViewHeader
        icon={<Bot size={15} />}
        title="Agents"
        meta={onAgents ? "Who your agents are, which backend each runs on, and what each is told." : "The agent CLIs on this machine, and who is signed in to them."}
        actions={
          // One primary action, for whatever the visible tab is about. Creating an agent *is* the agents section, so it goes under a lock.
          <Button
            variant="primary"
            icon={<Plus size={14} />}
            disabled={onAgents && locked}
            onClick={() => (onAgents ? setCreating(blank) : setAddingRuntime(true))}
          >
            {onAgents ? "New agent" : "Add runtime"}
          </Button>
        }
      >
        {runtimesTab ? (
          <Tabs
            label="Agents"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: "agents", label: "Agents", count: live.length },
              { value: "runtimes", label: "Runtimes" },
            ]}
          />
        ) : null}
      </ViewHeader>

      {tab === "runtimes" && runtimesTab ? (
        <RuntimesPanel adding={addingRuntime} onAddingChange={setAddingRuntime} />
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          <ManagedLockLine section="agents" />

          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <SearchInput label="Search agents" placeholder="Search agents…" value={search} onChange={setSearch} className="w-full @lg:w-56" />
            <Select aria-label="Filter by role" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} className="w-auto min-w-32">
              <option value="">Role: All</option>
              {roles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </Select>
            <Select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="w-auto min-w-32">
              <option value="">Status: All</option>
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
            </Select>
            {/* Kept because their runs and comments point at them (invariant #3); hidden because nobody has them. */}
            {archived.length > 0 ? (
              <Button variant="ghost" onClick={() => setShowArchived((value) => !value)}>
                {showArchived ? "Hide archived" : `Show archived (${String(archived.length)})`}
              </Button>
            ) : null}
          </div>

          {rowProblem !== null ? <p role="alert" className="whitespace-pre-line text-[12.5px] text-danger">{rowProblem}</p> : null}
          {agents.error ? <ErrorLine>{agents.error.message}</ErrorLine> : null}

          {removing !== null ? (
            <ConfirmRemove
              name={removing.name}
              removal={removing.removal}
              impact={removing.impact}
              problem={removing.problem}
              busy={askToRemove.isPending || confirmRemove.isPending}
              onConfirm={() => confirmRemove.mutate({ id: removing.id, removal: removing.removal })}
              onCancel={() => setRemoving(null)}
            />
          ) : null}

          {agents.isLoading ? (
            <Loading />
          ) : selected === null ? (
            <EmptyState
              title={all.length === 0 ? "No agents configured yet." : "No agent matches this filter."}
              {...(all.length === 0 && !locked
                ? {
                    action: (
                      <Button icon={<Plus size={13} />} onClick={() => setCreating(blank)}>
                        New agent
                      </Button>
                    ),
                  }
                : {})}
            />
          ) : (
            // Not the kit's SplitView: its list scrolls on its own, which would clip each row's menu.
            <div className="flex min-w-0 flex-1 gap-4">
              <nav aria-label="Agent list" className="flex w-[12.5rem] shrink-0 flex-col gap-0.5 @3xl:w-[15rem]">
                {list}
                {visible.length === 0 ? <p className="px-2.5 py-2 text-[12px] text-ink-subtle">No agent matches this filter.</p> : null}
              </nav>
              <div className="flex min-w-0 flex-1 flex-col">
                <AgentEditor
                  key={selected.id || "new"}
                  agent={selected}
                  registry={registry}
                  locked={locked}
                  projects={projects}
                  activeProject={activeProject}
                  onCustomise={(agentId, projectId) => customise.mutate({ agentId, projectId })}
                  revealActions={actionsRole !== null && selected.role === actionsRole}
                  busy={save.isPending || bind.isPending || customise.isPending}
                  error={
                    save.error?.message ??
                    bind.error?.message ??
                    customise.error?.message ??
                    (save.data?.saved === false ? (save.data.problem ?? undefined) : undefined) ??
                    (customise.data?.saved === false ? (customise.data.problem ?? undefined) : undefined)
                  }
                  onCancel={() => setCreating(null)}
                  // Two saves under a lock: the published fields through `agents:save`, the runtime and model through `agents:setBinding`.
                  onSave={(draft) =>
                    locked && draft.id !== undefined ? bind.mutate({ agentId: draft.id, provider: draft.provider, model: draft.model ?? null }) : save.mutate(draft)
                  }
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
