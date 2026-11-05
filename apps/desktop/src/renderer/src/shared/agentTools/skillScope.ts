import { useQuery } from "@tanstack/react-query";
import type { Skill, SkillScope } from "@eo/core";
import { ipcQuery } from "../../query/client";
import { projectsKey, skillsKey, workspacesKey } from "../../query/hooks";

/**
 * A skill's scope, as both layouts show and pick it (EO-470,
 * ARCHITECTURE.md §13.3).
 *
 * One module for the classic Skills screen, the chat layout's Skills
 * panel and the two pairs of settings screens that list a project's and
 * a workspace's skills, so the four cannot come to describe one scope
 * four ways. The rule about which runs a scope reaches is not here: that
 * is `skillInRunScope` in `packages/core`, and this only says it.
 */

/** What a scope can point at: the projects and workspaces this installation has. */
export interface ScopeTargets {
  projects: { id: string; name: string }[];
  workspaces: { id: string; label: string; projectId: string | null }[];
}

/**
 * The projects and every workspace, for the picker and the labels.
 *
 * Every workspace rather than the active project's, because a skill may
 * be scoped to a workspace on any project. Asked with `projectId: null`
 * under the key the Workspaces screen uses for the same question, so the
 * two share one answer and one invalidation.
 */
export function useSkillScopeTargets(): ScopeTargets {
  const projects = useQuery({ queryKey: projectsKey, queryFn: () => ipcQuery("projects:list", undefined) });
  const workspaces = useQuery({ queryKey: [...workspacesKey, null] as const, queryFn: () => ipcQuery("workspaces:list", { projectId: null }) });
  return {
    // Archived projects too, named as such: a skill scoped to one is not
    // scoped to nothing, and calling it that would be untrue.
    projects: (projects.data?.projects ?? []).map((project) => ({ id: project.id, name: project.archivedAt === null ? project.name : `${project.name} (archived)` })),
    workspaces: (workspaces.data?.workspaces ?? []).map((workspace) => ({ id: workspace.id, label: workspace.label, projectId: workspace.projectId })),
  };
}

/** A scope as one `<select>` value: `global`, `project:<id>` or `workspace:<id>`. */
export function scopeValue(scope: SkillScope): string {
  switch (scope.kind) {
    case "global":
      return "global";
    case "project":
      return `project:${scope.projectId}`;
    case "workspace":
      return `workspace:${scope.workspaceId}`;
  }
}

/** The other way round. Anything that is not one of the three reads as global. */
export function scopeFromValue(value: string): SkillScope {
  if (value.startsWith("project:")) return { kind: "project", projectId: value.slice("project:".length) };
  if (value.startsWith("workspace:")) return { kind: "workspace", workspaceId: value.slice("workspace:".length) };
  return { kind: "global" };
}

function projectName(targets: ScopeTargets, projectId: string | null): string | null {
  return projectId === null ? null : targets.projects.find((project) => project.id === projectId)?.name ?? null;
}

function workspaceName(targets: ScopeTargets, workspaceId: string): string | null {
  const workspace = targets.workspaces.find((candidate) => candidate.id === workspaceId);
  if (workspace === undefined) return null;
  const project = projectName(targets, workspace.projectId);
  return project === null ? workspace.label : `${workspace.label} (${project})`;
}

/**
 * Which runs a skill reaches, in words.
 *
 * A project or a workspace that has gone is said so rather than shown as
 * an id: the skill reaches no run until somebody moves it, and the
 * sentence has to make that visible.
 */
export function scopeLabel(scope: SkillScope, targets: ScopeTargets): string {
  switch (scope.kind) {
    case "global":
      return "Every run";
    case "project": {
      const name = projectName(targets, scope.projectId);
      return name === null ? "A project that no longer exists — reaches no run" : `Runs on ${name}`;
    }
    case "workspace": {
      const name = workspaceName(targets, scope.workspaceId);
      return name === null ? "A workspace that no longer exists — reaches no run" : `Runs in ${name}`;
    }
  }
}

/** One choice in the picker. */
export interface ScopeOption {
  value: string;
  label: string;
  group: "global" | "project" | "workspace";
}

/**
 * Every scope a skill can be given, plus the one it has.
 *
 * The one it has is kept even when its project or workspace is gone, so
 * opening such a skill shows where it points instead of silently
 * selecting something else — a save that did not mean to move it must
 * not move it.
 */
export function scopeOptions(targets: ScopeTargets, current: SkillScope): ScopeOption[] {
  const options: ScopeOption[] = [
    { value: "global", label: "Every run (global)", group: "global" },
    ...targets.projects.map((project) => ({ value: `project:${project.id}`, label: project.name, group: "project" as const })),
    ...targets.workspaces.map((workspace) => ({ value: `workspace:${workspace.id}`, label: workspaceName(targets, workspace.id) ?? workspace.label, group: "workspace" as const })),
  ];
  const value = scopeValue(current);
  if (!options.some((option) => option.value === value)) options.push({ value, label: scopeLabel(current, targets), group: current.kind });
  return options;
}

/** What a project's or a workspace's settings ask about. */
export type ScopeSubject = { kind: "project"; projectId: string } | { kind: "workspace"; workspaceId: string };

/** The skills scoped to exactly this project or workspace, archived ones left out. Pure, for the hook below and its tests. */
export function skillsScopedTo(skills: readonly Skill[], subject: ScopeSubject): Skill[] {
  return skills.filter((skill) => {
    if (skill.archivedAt !== null) return false;
    if (subject.kind === "project") return skill.scope.kind === "project" && skill.scope.projectId === subject.projectId;
    return skill.scope.kind === "workspace" && skill.scope.workspaceId === subject.workspaceId;
  });
}

/**
 * The skills scoped to one project or workspace.
 *
 * Read off the catalogue's own query — the same key and the same request
 * the Skills screen makes — so a scope changed there is the list here
 * the moment it saves.
 */
export function useScopedSkills(subject: ScopeSubject): Skill[] {
  const skills = useQuery({ queryKey: skillsKey, queryFn: () => ipcQuery("skills:list", { includeArchived: true }) });
  return skillsScopedTo(skills.data?.skills ?? [], subject);
}
