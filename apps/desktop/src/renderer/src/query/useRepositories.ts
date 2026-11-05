import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipcQuery } from "./client";
import { pipelineStepsRootKey, projectsKey, repositoriesKey, itemsKey, worktreesKey } from "./hooks";
import { useInvalidateOnPush } from "./useInvalidateOnPush";
import { archivedKey } from "../shared/pipeline/archive";

/** The configured repositories. Which one you are *looking* at is a project question — see `useProjects`. */
export function useRepositories() {
  const query = useQuery({ queryKey: repositoriesKey, queryFn: () => ipcQuery("repositories:list", undefined) });
  useInvalidateOnPush("config:changed", repositoriesKey);
  // Each repository shows how many items it has, so the project changing
  // changes this list too.
  useInvalidateOnPush("items:changed", repositoriesKey);

  return { repositories: query.data?.repositories ?? [], isLoading: query.isLoading };
}

/**
 * The projects and which one the window is showing (U-07, KAN-17).
 *
 * The active project is a *view* concept: the engine keeps advancing every
 * repository regardless of what's on screen (D-04). Switching here changes
 * what you are looking at, never what is running.
 *
 * A project used to be a repository, and for one repository it still looks
 * like one. The difference only shows when a project spans several.
 */
export function useProjects() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: projectsKey, queryFn: () => ipcQuery("projects:list", undefined) });
  useInvalidateOnPush("config:changed", projectsKey);
  useInvalidateOnPush("items:changed", projectsKey);

  const setActive = useMutation({
    mutationFn: (id: string) => ipcQuery("projects:setActive", { id }),
    onSuccess: () => {
      // Everything on screen belongs to one project, so switching
      // invalidates all of it rather than each screen doing its own.
      //
      // The pipeline steps are in that list for a reason that is not
      // obvious (EO-72): a pipeline no project has adopted is offered the
      // hand-off targets of whichever project it is being *edited* in, and
      // the validator scopes a save the same way. Leaving the cached
      // answer in place after a switch would let the editor go on
      // proposing the previous project's steps while `pipeline:save`
      // rejects them — the picker and the validator disagreeing, which is
      // exactly what EO-72 set out to stop. The root key covers every
      // pipeline, because which one is open is not knowable from here.
      for (const key of [repositoriesKey, worktreesKey, pipelineStepsRootKey]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      // The item lists are not keyed by project — `items:list` answers for
      // whichever is active — so an invalidation alone would leave the
      // previous project's cards on screen until the new answer landed
      // (EO-562). Resetting them drops that answer, cancels any read begun
      // before the switch, and asks again: every screen reading them shows
      // its loading state until the new project's items arrive.
      for (const key of [itemsKey, archivedKey]) {
        void queryClient.resetQueries({ queryKey: key, exact: true });
      }
      // Held until the list says which project is active, so `switchingTo`
      // covers the whole switch and the rail never flicks back to the old name.
      return queryClient.invalidateQueries({ queryKey: projectsKey });
    },
  });

  // Live projects are the ones anything can switch to, list or pick
  // from, so they are what `projects` means (EO-347). Archived ones come
  // back from `projects:list` as well, for Settings to offer Restore
  // on, and are handed out separately so that no switcher or picker can
  // show one by forgetting to filter.
  //
  // Memoised on the answer, so each keeps the identity the unsplit list
  // had: callers put these in effect dependencies.
  const data = query.data;
  const { projects, archivedProjects } = useMemo(() => {
    const all = data?.projects ?? [];
    return {
      projects: all.filter((project) => project.archivedAt == null),
      archivedProjects: all.filter((project) => project.archivedAt != null),
    };
  }, [data]);
  const activeProjectId = query.data?.activeProjectId ?? null;

  // Stable identity: callers put this in effect dependencies, and a new
  // function every render would re-run those effects every render.
  const { mutate } = setActive;
  const switchTo = useCallback((id: string) => mutate(id), [mutate]);

  return {
    projects,
    archivedProjects,
    activeProjectId,
    active: projects.find((project) => project.id === activeProjectId) ?? null,
    isLoading: query.isLoading,
    setActive: switchTo,
    /** The project a switch made through this hook is on its way to, until the main process has answered (EO-562). */
    switchingTo: setActive.isPending ? (setActive.variables ?? null) : null,
  };
}

/**
 * Which repository the per-repository settings are being edited for
 * (KAN-20).
 *
 * A project over one repository has an obvious answer and no picker. Over
 * several there is a genuine choice, so it is made explicitly rather
 * than guessed — pointing a forge remote or a Jira project key at an
 * arbitrary member would configure the wrong repository silently, which
 * is the failure this exists to prevent.
 *
 * The choice is remembered per project for the life of the window, so
 * moving between Settings sections does not keep resetting it. It is
 * not persisted: it is a place in the UI, not a preference.
 */
const chosenPerProject = new Map<string, string>();

export function useConfiguredRepository() {
  const { repositories } = useRepositories();
  const { active } = useProjects();
  const [, bump] = useState(0);

  const members = (active?.repositoryIds ?? []).flatMap((id) => repositories.find((repository) => repository.id === id) ?? []);
  const remembered = active ? chosenPerProject.get(active.id) : undefined;
  const repository = members.find((entry) => entry.id === remembered) ?? members[0] ?? null;

  const choose = useCallback(
    (id: string) => {
      if (active) chosenPerProject.set(active.id, id);
      bump((count) => count + 1);
    },
    [active],
  );

  return { repository, members, choose };
}

/**
 * The Jira this project's *features* are mirrored into, as one of its
 * repositories reports it.
 *
 * Not a choice, and deliberately not the picker above. The project used
 * to nominate which member's Jira received its features, because each
 * member carried its own; since KAN-130 there is one binding on the
 * project and every repository on it reports the same Jira — so this is
 * the first member, and on the ordinary single-repository project it is
 * the only one.
 *
 * Still a repository rather than the project itself, because what the
 * caller needs is an id the `jira:*` channels take, and those name a
 * repository (the screen a person configures one on shows repositories).
 */
export function useFeatureJiraProject() {
  const { repositories } = useRepositories();
  const { active } = useProjects();

  if (!active) return null;
  const id = active.repositoryIds[0];
  return repositories.find((repository) => repository.id === id) ?? null;
}
