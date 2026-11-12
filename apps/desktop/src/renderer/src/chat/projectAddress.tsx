import { useEffect } from "react";
import type { NavigateFunction } from "react-router-dom";
import { CHAT_HOME_ROUTE } from "@eo/core";
import { usePipelines } from "../query/hooks";
import { useProjects } from "../query/useRepositories";

/** The board with no pipeline in its address — a job or a template with none links here (EO-191). */
export const PROJECT_ROUTE = "/project";

/** Whether this address is `/project`, which names no pipeline of its own. */
export function isProjectAddress(pathname: string): boolean {
  return (pathname.replace(/\/+$/, "") || "/") === PROJECT_ROUTE;
}

/**
 * Where `/project` goes (EO-766): the board of the active project's first
 * pipeline, as its rail lists them, keeping `?view=graph` and anything
 * else asked of the address. A project with no pipeline has no board to
 * open, so it is the conversation.
 *
 * Never `default`: the seeded Delivery is one project's at most, and a
 * project made without its template never had it.
 */
export function projectBoardAddress(firstPipelineId: string | null, search: string): string {
  return firstPipelineId === null ? CHAT_HOME_ROUTE : `/pipelines/${encodeURIComponent(firstPipelineId)}${search}`;
}

/**
 * Replaces `/project` with the address of the board it means, once the
 * active project's pipelines are known (EO-766).
 *
 * Drawn only while the window is on `/project`, so nothing anywhere else
 * reads the project's pipelines for it or redraws when they change.
 * Draws nothing itself.
 */
export function ProjectAddress({ search, navigate }: { search: string; navigate: NavigateFunction }): null {
  const projects = useProjects();
  const pipelines = usePipelines(projects.activeProjectId);
  // Both answers first: until the projects are read the active one reads
  // as none, and the pipelines of none are not this project's.
  const known = !projects.isLoading && !pipelines.isLoading;
  const to = known ? projectBoardAddress(pipelines.pipelines[0]?.id ?? null, search) : null;
  useEffect(() => {
    if (to !== null) void navigate(to, { replace: true });
  }, [to, navigate]);
  return null;
}
