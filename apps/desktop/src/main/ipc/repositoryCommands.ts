import type { IpcPayload, IpcResponse, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { previewProjectId } from "../gallery/commands.js";
import type { CredentialsOptions } from "../packs/developer/jira/credentials.js";
import { isGitRepo } from "../packs/developer/workspace/git.js";
import { jiraConfigView } from "./jiraCommands.js";
import {
  addWorkspaceToProject,
  adoptProjectlessItems,
  createDefaultProject,
  asGitWorkspace,
  createGitWorkspace,
  deleteWorkspace,
  getGitWorkspace,
  getJiraBinding,
  getProject,
  getSetting,
  listItems,
  listProjects,
  listGitWorkspaces,
  projectWorkspaceList,
  setSetting,
  suggestKeyPrefix,
  takenKeyPrefixes,
  updateWorkspace,
  type GitWorkspace,
  type Project,
} from "../db/repos/index.js";

/**
 * Which project the *window* is showing. A view concept only — the engine
 * advances every repository regardless (D-04), because progress that
 * depended on where the window happened to be would be a strange kind
 * of automation.
 *
 * Was `ui.activeProjectId` until projects became their own thing
 * (KAN-17). Nothing migrates the old key: falling through to the first
 * project lands somewhere sensible on the first launch after upgrading,
 * and the choice is one click to correct.
 */
export const ACTIVE_PROJECT_KEY = "ui.activeProjectId";

/**
 * One `git-worktree` workspace, as the Repositories screen reads it.
 *
 * The shape is unchanged by KAN-130 and its two halves now come from two
 * places: the commands and the forge settings off the workspace's own
 * config, and `jira` off the *project's* binding. So two repositories on
 * one project report the same Jira, which is what they now have — there
 * is one binding per project, not one per checkout.
 */
function toView(db: Db, workspace: GitWorkspace, credentials: CredentialsOptions): IpcResponse<"repositories:list">["repositories"][number] {
  const binding = workspace.projectId ? getJiraBinding(db, workspace.projectId) : undefined;
  return {
    id: workspace.id,
    name: workspace.config.name,
    description: workspace.config.description,
    repoPath: workspace.config.repoPath,
    baseBranch: workspace.config.baseBranch,
    testCommand: workspace.config.testCommand,
    lintCommand: workspace.config.lintCommand,
    buildCommand: workspace.config.buildCommand,
    itemCount: listItems(db, workspace.id).length,
    jira: jiraConfigView(db, binding, credentials),
    forge: {
      openPr: workspace.config.forgeOpenPr,
      kind: workspace.config.forgeKind,
      remote: workspace.config.forgeRemote,
      draft: workspace.config.forgeDraft,
      templatePath: workspace.config.forgeTemplatePath,
    },
  };
}

/**
 * The active project id, corrected on read.
 *
 * A stored id can outlive its project — it was removed, or the database
 * was moved between machines. Falling back to the first project beats
 * handing the UI an id that resolves to nothing and letting it render an
 * empty project that looks like lost work.
 */
export function activeProjectId(db: Db): Uuid | null {
  // An archived project is never the one the window shows (EO-347).
  // Archiving the one on screen moves the setting off it in the same
  // write, and this is what keeps a setting written before that — or
  // by anything else — from putting somebody on a board EO has put away.
  const projects = listProjects(db).filter((project) => project.archivedAt === null);
  if (projects.length === 0) return null;

  const stored = getSetting<string | null>(db, ACTIVE_PROJECT_KEY, null);
  const match = projects.find((project) => project.id === stored);
  return (match ?? projects[0]!).id;
}

/**
 * The workspace a new item belongs to, given the active project.
 *
 * Exactly one means the answer is obvious and the item gets it, which is
 * what keeps a one-repo project behaving as it always has. More than one
 * and a *feature* has no single answer — its stories carry the
 * workspaces, and it carries the project (KAN-17).
 */
export function soleWorkspaceOf(db: Db, projectId: Uuid | null): Uuid | null {
  if (projectId === null) return null;
  const members = projectWorkspaceList(db, projectId);
  return members.length === 1 ? members[0]!.id : null;
}

export function listRepositoriesCommand(db: Db, credentials: CredentialsOptions): IpcResponse<"repositories:list"> {
  return {
    repositories: listGitWorkspaces(db).map((workspace) => toView(db, workspace, credentials)),
  };
}

/**
 * Why a path is checked before it is stored.
 *
 * A repository in EO is a checkout that already exists on this machine:
 * nothing here clones, and every worktree an agent works in is cut from
 * this path. Stored unchecked, a path that is not a repository is
 * accepted in silence and surfaces as "the configured repo path is not a
 * git repository" at the first dispatch, hours later and nowhere near
 * the person who typed it. A folder picker only proves a folder exists,
 * so this is not something the screen was already doing — and a client
 * over MCP has no picker at all.
 *
 * Named, because "that is not a git repository" without saying which
 * path leaves a caller with two candidates and no way to tell them apart.
 *
 * Exported since EO-317: the needs check attaches a repository to a
 * project that already exists, which is a different write from this
 * file's — but it is the same question about the path, and asking it a
 * second way is how two doors come to disagree about what a checkout is.
 */
export async function repositoryPathProblem(repoPath: string): Promise<string | null> {
  if (await isGitRepo(repoPath)) return null;
  return (
    `${repoPath} is not a git repository. EO works inside a checkout that already exists on this machine — it ` +
    `clones nothing — so this has to be a path git itself recognises. Check the path, or run \`git init\` there first.`
  );
}

/**
 * Why a repository cannot join or leave a project mid-move (EO-605, EO-607),
 * for every door that does either. A move sends the project in pages, so a
 * repository added or taken away now would disagree with a page already
 * sent; the wording is `archiveProjectCommand`'s, ending in what this person
 * came to do.
 */
export function movingProjectRefusal(name: string): string {
  return `"${name}" is being moved to your organisation's record. Wait for the move to finish, then change its repositories.`;
}

/**
 * The project a repository is about to join, or null when one has to be
 * made for it. Asked before anything is written, because
 * `addWorkspaceToProject` *moves* a workspace off whichever project holds
 * it: a repository made first and placed afterwards is what broke the
 * earlier attempt at this.
 *
 * A project is what a person creates and a repository is what it holds,
 * so null is the exception. It means there is no real project to join:
 * none exists, or the one in question is the gallery's Preview, which is
 * EO's rehearsal rather than anybody's work.
 */
function projectToJoin(db: Db, requested: string | undefined): { project: Project | null; problem: null } | { project: null; problem: string } {
  const projectId = requested ?? activeProjectId(db);
  if (projectId === null) return { project: null, problem: null };
  const project = getProject(db, projectId as Uuid);
  if (project === undefined) return { project: null, problem: "That project no longer exists." };
  if (project.adoptingAt !== null) return { project: null, problem: movingProjectRefusal(project.name) };
  return { project: project.id === previewProjectId(db) ? null : project, problem: null };
}

export async function createRepositoryCommand(db: Db, credentials: CredentialsOptions, input: IpcPayload<"repositories:create">): Promise<IpcResponse<"repositories:create">> {
  const pathProblem = await repositoryPathProblem(input.repoPath);
  if (pathProblem) return { ok: false, problem: pathProblem };

  const { project: joining, problem } = projectToJoin(db, input.projectId);
  if (problem !== null) return { ok: false, problem };

  // A key prefix is a project's and is fixed when the project is made
  // (KAN-128), so it is only a question while one is about to be. It is
  // checked before anything is written: making a project writes the
  // repository first and the project second, so a prefix another project
  // holds used to insert the repository and then throw on the project —
  // leaving a repository behind with no project and no refusal.
  const requested = input.keyPrefix?.trim().toUpperCase();
  if (requested && joining) {
    return {
      ok: false,
      problem:
        `${input.name} joins ${joining.name}, whose key prefix is ${joining.keyPrefix} — a prefix is a project's, and fixed when ` +
        `the project is made, so a repository joining one has none to choose. Omit it.`,
    };
  }
  if (requested && takenKeyPrefixes(db).has(requested)) {
    return {
      ok: false,
      problem:
        `The key prefix "${requested}" is already in use by another project, and a prefix is one project's — both ` +
        `would number their tickets from the same counter. Omit it and EO derives a free one from the name.`,
    };
  }
  if (listGitWorkspaces(db).some((workspace) => workspace.config.repoPath === input.repoPath)) {
    // Named by its path, because the path is what was compared and what
    // the person can go and look at. The rename left this as "That
    // repository is already a repository", which is the shape of an
    // answer without being one.
    return { ok: false, problem: `${input.repoPath} is already attached to EO as a repository.` };
  }

  const wasFirst = listGitWorkspaces(db).length === 0;
  const workspace = createGitWorkspace(db, {
    config: {
      name: input.name,
      description: input.description ?? null,
      repoPath: input.repoPath,
      baseBranch: input.baseBranch,
      testCommand: input.testCommand,
      lintCommand: input.lintCommand,
      buildCommand: input.buildCommand,
    },
  });

  // Joining leaves the window alone: a repository added to one project
  // while another is on screen is no reason to move somebody. A project
  // made for it is another matter — there was nothing real to show, so
  // the window goes to the first thing there is.
  let project: Project;
  if (joining) {
    addWorkspaceToProject(db, joining.id, workspace.id);
    project = joining;
  } else {
    project = createDefaultProject(db, workspace, requested || suggestKeyPrefix(db, input.name));
    setSetting(db, ACTIVE_PROJECT_KEY, project.id);
  }

  // Items written before any repo was attached belong to the first
  // one — otherwise onboarding ends with them gone from the project.
  const adopted = wasFirst ? adoptProjectlessItems(db, workspace.id, project.id) : 0;

  return {
    ok: true,
    // Read back, because attaching it to the project is a second write.
    repository: toView(db, getGitWorkspace(db, workspace.id) ?? workspace, credentials),
    adoptedItems: adopted,
    project: { id: project.id, name: project.name, created: joining === null },
    problem: null,
  };
}

export async function updateRepositoryCommand(db: Db, credentials: CredentialsOptions, input: IpcPayload<"repositories:update">): Promise<IpcResponse<"repositories:update">> {
  // A workspace of another kind answers the same way as one that is
  // gone, and honestly: a folder is not a repository, and this command
  // is the Repositories screen's (EO-299).
  const workspace = getGitWorkspace(db, input.id as Uuid);
  if (!workspace) return { ok: false, problem: "That repository no longer exists." };

  // Moving a repository to a path that is not one is the same mistake as
  // attaching it there, and it fails the same way — so it is refused the
  // same way rather than only on the way in.
  if (input.repoPath !== undefined) {
    const problem = await repositoryPathProblem(input.repoPath);
    if (problem) return { ok: false, problem };

    // And the same goes for moving it onto a checkout EO already has.
    // `repositories:create` refuses to attach one path twice, so a second
    // record for one checkout is a state EO says it does not hold — but
    // update could still arrive at it, and two records for one checkout
    // mean two key prefixes minting keys over the same branches and two
    // sets of worktrees cut from the same place. Its own current path is
    // not a move and is left alone.
    const holder = listGitWorkspaces(db).find((other) => other.config.repoPath === input.repoPath && other.id !== workspace.id);
    if (holder) {
      return {
        ok: false,
        problem:
          `${input.repoPath} is already attached to EO as ${holder.config.name}, and one checkout is one repository — two ` +
          `records for it would mint keys and cut worktrees over the same branches. Point ${workspace.config.name} at a ` +
          `different checkout, or remove ${holder.config.name} first. Nothing changed.`,
      };
    }
  }

  // No key prefix in the patch, and none in the input schema: a
  // repository has none to change since KAN-128. Its project's is fixed
  // at creation, for the reason this comment used to give — existing
  // items carry it in their key.
  const patch = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.repoPath !== undefined ? { repoPath: input.repoPath } : {}),
    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
    ...(input.testCommand !== undefined ? { testCommand: input.testCommand } : {}),
    ...(input.lintCommand !== undefined ? { lintCommand: input.lintCommand } : {}),
    ...(input.buildCommand !== undefined ? { buildCommand: input.buildCommand } : {}),
    ...(input.forgeOpenPr !== undefined ? { forgeOpenPr: input.forgeOpenPr } : {}),
    ...(input.forgeKind !== undefined ? { forgeKind: input.forgeKind } : {}),
    ...(input.forgeRemote !== undefined ? { forgeRemote: input.forgeRemote } : {}),
    ...(input.forgeDraft !== undefined ? { forgeDraft: input.forgeDraft } : {}),
    ...(input.forgeTemplatePath !== undefined ? { forgeTemplatePath: input.forgeTemplatePath } : {}),
  };

  // The update kept the row's kind, so what comes back is the same
  // repository; the fallback is unreachable and is the pre-update row
  // rather than an invented one (EO-299).
  const updated = asGitWorkspace(updateWorkspace(db, workspace.id, { config: patch })) ?? workspace;
  return { ok: true, repository: toView(db, updated, credentials), problem: null };
}

/**
 * Unlinks a repository from EO. Never touches the repository.
 *
 * Refused while it still has items, and deliberately so: removing them
 * would mean removing their runs, and `run_events` is append-only —
 * invariant #3, the durability substrate. A repository with history is not
 * something this command can honestly delete, and quietly deleting the
 * items while orphaning their event log would be worse than refusing.
 *
 * Its project stays, whichever repository this was: a project is what a
 * person made, and it keeps its pipelines, its tickets and its notes with
 * nowhere to work until a repository is added to it again.
 */
export function removeRepositoryCommand(db: Db, input: IpcPayload<"repositories:remove">): IpcResponse<"repositories:remove"> {
  const workspace = getGitWorkspace(db, input.id as Uuid);
  if (!workspace) return { ok: false, problem: "That repository no longer exists." };

  const project = workspace.projectId ? getProject(db, workspace.projectId) : undefined;
  if (project && project.adoptingAt !== null) return { ok: false, problem: movingProjectRefusal(project.name) };

  const items = listItems(db, workspace.id);
  if (items.length > 0) {
    return {
      ok: false,
      problem:
        `${workspace.config.name} still has ${items.length} ticket(s), so it can't be removed — their run history is ` +
        `append-only and EO won't delete it. The repository itself is never touched by this either way.`,
    };
  }

  deleteWorkspace(db, workspace.id);
  return { ok: true, problem: null };
}
