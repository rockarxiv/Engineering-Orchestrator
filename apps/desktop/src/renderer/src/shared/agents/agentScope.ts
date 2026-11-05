import { useQuery } from "@tanstack/react-query";
import type { AgentDetail, IpcResponse } from "@eo/core";
import { ipcQuery } from "../../query/client";
import { agentsKey, projectsKey } from "../../query/hooks";
import { agentDetailsKey } from "../settings/primitives";
import { useInvalidateOnPush } from "../../query/useInvalidateOnPush";

/**
 * An agent's project, as both layouts show and pick it (EO-475,
 * ARCHITECTURE.md, "An agent is a row").
 *
 * One module for the classic Agents screen, the chat layout's Agents
 * view and both layouts' project settings, so the four cannot come to
 * describe one scope four ways — `skillScope` is the same idea for
 * skills. The rule about which agent a project's work goes to is not
 * here: that is `staffingAgents` in `packages/core`, which the main
 * process asks on `projects:staffing`, and this only says its answer.
 */

/** The `<select>` value for a global agent. A project's own is its project's id. */
export const GLOBAL_SCOPE = "global";

/**
 * The project an agent works for, or null for a global one.
 *
 * `?? null` because the listing is not parsed on the way in, and a row
 * from before the column read as global is what every agent was.
 */
export function agentProjectId(agent: Pick<AgentDetail, "projectId">): string | null {
  return agent.projectId ?? null;
}

/**
 * Whether an agent can be scoped at all. The system agent cannot: the
 * assistant is one agent with the same instructions for everyone, and
 * `agents:save` refuses it a project — so its editor offers no control
 * that could only be refused.
 */
export function canScope(agent: Pick<AgentDetail, "role">): boolean {
  return agent.role.trim() !== "system";
}

/** What a scope can point at: every project this installation has, archived ones named as such. */
export interface ScopeProject {
  id: string;
  name: string;
}

/** The projects, for the picker, the group headings and the copy's button. Shares `projectsKey` with every other reader. */
export function useScopeProjects(): { projects: ScopeProject[]; activeProject: ScopeProject | null } {
  const query = useQuery({ queryKey: projectsKey, queryFn: () => ipcQuery("projects:list", undefined) });
  const all = query.data?.projects ?? [];
  const projects = all.map((project) => ({ id: project.id, name: project.archivedAt == null ? project.name : `${project.name} (archived)` }));
  const active = all.find((project) => project.id === query.data?.activeProjectId && project.archivedAt == null);
  return { projects, activeProject: active === undefined ? null : { id: active.id, name: active.name } };
}

/**
 * The picker's choices: global, then every project — plus the one the
 * agent has when that project is not in the list, so opening such an
 * agent shows where it points rather than silently selecting global, and
 * a save that did not mean to move it cannot.
 */
export function agentScopeOptions(projects: readonly ScopeProject[], current: string | null): { value: string; label: string }[] {
  const options = [{ value: GLOBAL_SCOPE, label: "Global — every project" }, ...projects.map((project) => ({ value: project.id, label: project.name }))];
  if (current !== null && !projects.some((project) => project.id === current)) options.push({ value: current, label: "A project that no longer exists" });
  return options;
}

/** A picker value back into the save's `projectId`. */
export function projectIdFromScope(value: string): string | null {
  return value === GLOBAL_SCOPE ? null : value;
}

/** One heading on the Agents screen and the agents under it. */
export interface AgentGroup<A> {
  /** `global`, or the project's id — stable for a React key and an accessible name. */
  key: string;
  projectId: string | null;
  label: string;
  agents: A[];
}

/**
 * Agents grouped by scope: global first, then each project's own in the
 * order the projects come, and last any whose project is not listed.
 * Order within a group is the order given. A group with nobody in it is
 * left out — a heading over nothing would be a project the person has
 * to read past.
 */
export function groupAgentsByScope<A extends Pick<AgentDetail, "projectId">>(agents: readonly A[], projects: readonly ScopeProject[]): AgentGroup<A>[] {
  const groups: AgentGroup<A>[] = [{ key: GLOBAL_SCOPE, projectId: null, label: "Global", agents: agents.filter((agent) => agentProjectId(agent) === null) }];
  for (const project of projects) {
    groups.push({ key: project.id, projectId: project.id, label: project.name, agents: agents.filter((agent) => agentProjectId(agent) === project.id) });
  }
  const known = new Set(projects.map((project) => project.id));
  const strays = agents.filter((agent) => {
    const projectId = agentProjectId(agent);
    return projectId !== null && !known.has(projectId);
  });
  if (strays.length > 0) groups.push({ key: "unknown", projectId: null, label: "A project that no longer exists", agents: strays });
  return groups.filter((group) => group.agents.length > 0);
}

/** A heading's words: whose agents these are. */
export function groupHeading(group: AgentGroup<unknown>): string {
  return group.key === GLOBAL_SCOPE ? "Global agents" : `${group.label}'s own agents`;
}

/** Which runs an agent is dispatched for, in a line. */
export function scopeLine(agent: Pick<AgentDetail, "projectId">, projects: readonly ScopeProject[]): string {
  const projectId = agentProjectId(agent);
  if (projectId === null) return "Global — every project without an agent of its own in this role";
  const project = projects.find((candidate) => candidate.id === projectId);
  return project === undefined ? "A project that no longer exists — dispatched for nothing" : `Only ${project.name}'s work, ahead of the global agents in this role`;
}

/**
 * Whether "Customise for this project" is offered: on a live global
 * agent that may be scoped, while there is an active project to make the
 * copy for.
 */
export function canCustomise(agent: Pick<AgentDetail, "id" | "role" | "projectId" | "archivedAt">, activeProject: ScopeProject | null): boolean {
  return agent.id !== "" && activeProject !== null && agent.archivedAt === null && agentProjectId(agent) === null && canScope(agent);
}

/** The cache entry for one project's staffing — under `agentsKey`, so every agent save refreshes it. */
export function projectStaffingKey(projectId: string) {
  return [...agentsKey, "staffing", projectId] as const;
}

export type RoleStaffing = IpcResponse<"projects:staffing">["roles"][number];

/**
 * Who a project's work goes to, role by role — `projects:staffing`,
 * which is the scheduler's rule asked by the main process. Refreshed on
 * `config:changed` as well, since a pipeline published elsewhere changes
 * which roles the project uses.
 */
export function useProjectStaffing(projectId: string) {
  const key = projectStaffingKey(projectId);
  useInvalidateOnPush("config:changed", key);
  return useQuery({ queryKey: key, queryFn: () => ipcQuery("projects:staffing", { projectId }) });
}

/** One role's line in project settings: who will be dispatched, and why it is them. */
export function staffingLine(entry: RoleStaffing): string {
  const names = entry.agents.map((agent) => agent.name).join(" or ");
  switch (entry.from) {
    case "project":
      return `${names} — this project's own`;
    case "global":
      return `${names} — global`;
    case "nobody":
      return "Nobody — no enabled agent holds this role";
  }
}

/**
 * A project's own agents, archived ones left out — read off the Agents
 * screen's own query, so an agent scoped there is listed here the moment
 * it saves.
 */
export function useProjectOwnAgents(projectId: string): AgentDetail[] {
  const query = useQuery({ queryKey: agentDetailsKey, queryFn: () => ipcQuery("agents:listDetailed", undefined) });
  return (query.data?.agents ?? []).filter((agent) => agent.archivedAt === null && agentProjectId(agent) === projectId);
}
