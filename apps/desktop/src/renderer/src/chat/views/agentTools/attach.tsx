import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AttachableKind } from "@eo/core";
import { ipcQuery } from "../../../query/client";
import { agentsKey, mcpServersKey, skillsKey, useChromeVocabulary } from "../../../query/hooks";
import { useAgentAttachments, useTick } from "../../../shared/agentTools/attach";
import { withArticleCapital } from "../../parts";
import { Chip, ErrorLine } from "../../kit";
import { TickChip, TickOption } from "./ticks";

/**
 * Ticking a catalogue entry onto an agent, from either end (EO-109) — the
 * chat layout's drawing of `agentTools/Attach`.
 *
 * The same hooks as the classic screen (`useAgentAttachments`,
 * `useTick`): one tick, one call to `agentAttachments:set`, its refusal
 * handed back as a sentence. Only the drawing is this layout's.
 */

/**
 * What a tick reaches, and what it does not — `NEXT_DISPATCH_NOTE`, in
 * the project's own word for the thing in flight rather than the
 * developer pack's. Where the developer pack is the only one, the
 * sentence is the classic one word for word.
 */
export function useNextDispatchNote(): string {
  const word = useChromeVocabulary().item.toLowerCase();
  return `Applies from the next dispatch. ${withArticleCapital(word)} already in flight keeps the tools its run started with, and its agent starts a fresh conversation on that ${word} rather than resuming the one it had.`;
}

/**
 * Which agents get this catalogue entry — the catalogue's end.
 *
 * Each tick is named for the sentence it stands for: several entries are
 * on screen at once, each with a row of agents, so "Reviewer" alone would
 * name four different boxes; "Reviewer gets github" names one.
 */
export function AttachedAgents({ kind, entryId, entryName }: { kind: AttachableKind; entryId: string; entryName: string }) {
  const [problem, setProblem] = useState<string | null>(null);
  const agents = useQuery({ queryKey: agentsKey, queryFn: () => ipcQuery("agents:list", undefined) });
  const attachments = useAgentAttachments();
  const tick = useTick(setProblem);

  // Live agents only (EO-186): an archived one is not coming back, so a
  // tick against it would file a row nothing will ever deliver. A
  // disabled one is still tickable — configuring one you switched off is
  // ordinary.
  const rows = (agents.data?.agents ?? []).filter((agent) => agent.archivedAt === null);
  if (rows.length === 0) return <p className="text-[12px] text-ink-subtle">No agents to give this to yet.</p>;

  const held = (agentId: string) => {
    const attached = attachments.of(agentId);
    return kind === "mcpServer" ? attached.mcpServerIds.includes(entryId) : attached.skillIds.includes(entryId);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11.5px] text-ink-subtle">Given to</span>
        {rows.map((agent) => (
          <TickChip
            key={agent.id}
            label={`${agent.name} gets ${entryName}`}
            checked={held(agent.id)}
            disabled={tick.isPending}
            onChange={(attached) => tick.mutate({ agentId: agent.id, kind, id: entryId, attached })}
          >
            <span className="truncate">{agent.name}</span>
            {/* Tickable, but the row should not imply it is about to run. */}
            {agent.enabled ? null : <span className="text-[11px] text-ink-subtle">off</span>}
          </TickChip>
        ))}
      </div>
      {problem !== null ? <ErrorLine>{problem}</ErrorLine> : null}
    </div>
  );
}

/**
 * Which catalogue entries this agent gets — the agent's end, mounted in
 * the agent editor.
 *
 * Written the moment it is ticked, not carried on the editor's draft: an
 * attachment is a row in a join table, and a half-filled editor nobody
 * saves must not be able to strand one. Archived entries the agent still
 * holds stay listed, so they can be taken off.
 */
export function AgentToolPicker({ agentId }: { agentId: string }) {
  const [problem, setProblem] = useState<string | null>(null);
  const attachments = useAgentAttachments();
  const tick = useTick(setProblem);
  const note = useNextDispatchNote();

  const servers = useQuery({ queryKey: mcpServersKey, queryFn: () => ipcQuery("mcpServers:list", { includeArchived: true }) });
  const skills = useQuery({ queryKey: skillsKey, queryFn: () => ipcQuery("skills:list", { includeArchived: true }) });

  const held = attachments.of(agentId);
  const serverRows = (servers.data?.servers ?? []).filter((server) => server.archivedAt === null || held.mcpServerIds.includes(server.id));
  const skillRows = (skills.data?.skills ?? []).filter((skill) => skill.archivedAt === null || held.skillIds.includes(skill.id));

  if (serverRows.length === 0 && skillRows.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-[12.5px] text-ink-subtle">
          Nothing in the catalogue yet. Agent tools is where an MCP server or a skill is defined; this is where an agent is given one.
        </p>
        {problem !== null ? <ErrorLine>{problem}</ErrorLine> : null}
      </div>
    );
  }

  const entries = [
    ...serverRows.map((server) => ({ kind: "mcpServer" as const, id: server.id, name: server.name, archived: server.archivedAt !== null, enabled: server.enabled })),
    ...skillRows.map((skill) => ({ kind: "skill" as const, id: skill.id, name: skill.name, archived: skill.archivedAt !== null, enabled: skill.enabled })),
  ];

  return (
    <div className="flex flex-col gap-2">
      <ul aria-label="Tools" className="flex min-w-0 flex-col gap-1.5">
        {entries.map((entry) => {
          const checked = entry.kind === "mcpServer" ? held.mcpServerIds.includes(entry.id) : held.skillIds.includes(entry.id);
          return (
            <li key={`${entry.kind}:${entry.id}`} className="flex min-w-0 items-center gap-2">
              <TickOption
                label={entry.name}
                checked={checked}
                disabled={tick.isPending}
                onChange={(attached) => tick.mutate({ agentId, kind: entry.kind, id: entry.id, attached })}
              >
                <span className="truncate text-[13px] text-ink">{entry.name}</span>
              </TickOption>
              <Chip>{entry.kind === "mcpServer" ? "server" : "skill"}</Chip>
              {entry.archived ? <Chip tone="paused">archived</Chip> : entry.enabled ? null : <Chip>off</Chip>}
            </li>
          );
        })}
      </ul>
      <p className="text-[11.5px] leading-snug text-ink-subtle">{note}</p>
      {problem !== null ? <ErrorLine>{problem}</ErrorLine> : null}
    </div>
  );
}
