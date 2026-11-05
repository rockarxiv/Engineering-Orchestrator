import { FOLDER_KIND, FolderWorkspaceConfigSchema, GIT_WORKTREE_KIND, GitWorkspaceConfigSchema, type IpcPayload, type IpcResponse, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import {
  createWorkspace,
  deleteWorkspace,
  folderPathProblem,
  getWorkspace,
  listItems,
  listProjects,
  listWorkspaces,
  projectWorkspaceList,
  updateWorkspace,
  workspaceLabel,
  workspaceProblem,
  workspaceSummary,
  type Workspace,
} from "../db/repos/index.js";
import { createRepositoryCommand, removeRepositoryCommand, updateRepositoryCommand, activeProjectId } from "./repositoryCommands.js";

/**
 * The Jira credential store, named by the function this file forwards it
 * to rather than imported from the pack that defines it.
 *
 * Nothing here reads it, opens it or knows what is in it: the git kind
 * delegates to `createRepositoryCommand`, that command reports the
 * project's Jira binding in what it answers with, and this is the
 * second argument it takes. Deriving the type from the call rather than
 * importing `CredentialsOptions` keeps this file off the
 * pack-import allowlist (`packs/importAllowlist.test.ts`), which exists
 * to shrink and should not grow for a parameter a function only passes
 * along — and it cannot drift, because it *is* that parameter.
 */
type ForwardedCredentials = Parameters<typeof createRepositoryCommand>[1];

/**
 * Every kind of disk, as Settings → Workspaces reads and writes them
 * (EO-301, ARCHITECTURE.md, "A workspace is a kind, attached to the project").
 *
 * **Why this is not simply `repositories:*` renamed.** A repository is a
 * workspace and has been the same row since KAN-130, so the temptation
 * is to widen those commands and delete this file. Two things stop it.
 * The first is that `repositories:*` is not only a screen's back end: it
 * is in the MCP catalogue, it is what an agent and a script call, and
 * every one of its callers means *a checkout* — a channel that started
 * answering with folders would be lying to all of them. The second is
 * that attaching a repository does four things nothing else does — it
 * asks git whether the path is a checkout, refuses a path already
 * attached, decides which project it joins and adopts the items that
 * predate every workspace — and re-deriving those here would be a
 * second opinion about what a repository is, which is exactly the drift
 * KAN-130 spent a migration ending.
 *
 * So the git kind delegates. What is here is the part that is genuinely
 * new: one list over four kinds, an add flow that asks the kind first,
 * and the validation the screen shows while a person is still looking
 * at the field.
 */

/**
 * One workspace, flattened into the three questions every kind answers.
 *
 * The kind-specific parts — `label`, `summary`, `problem` — are three
 * functions in `workspacesRepo`, not three branches here, because the
 * board's badge asks the first of them too and a second implementation
 * would be a second answer.
 */
export function workspaceView(db: Db, workspace: Workspace): IpcResponse<"workspaces:list">["workspaces"][number] {
  return {
    id: workspace.id,
    projectId: workspace.projectId,
    kind: workspace.kind,
    label: workspaceLabel(workspace),
    summary: workspaceSummary(workspace),
    problem: workspaceProblem(workspace),
    position: workspace.position,
    itemCount: listItems(db, workspace.id).length,
    // The kind's own JSON, passed through rather than picked apart: the
    // git form reads its fields and nothing else looks inside, so a kind
    // a pack contributed keeps a configuration this file has never heard
    // of — the same pass-through `parseWorkspaceConfig` makes, for the
    // same reason.
    config: workspace.config as Record<string, unknown>,
  };
}

/**
 * The project's workspaces, or every one there is.
 *
 * Scoped by project because that is what a step may pick among and what
 * the screen shows. The unscoped answer includes the workspaces no
 * project holds — what a deleted project leaves behind — and this is
 * the only place they are visible at all, which is the point: a disk
 * EO still knows about and nothing can reach is worth being able to see
 * and remove.
 */
export function listWorkspacesCommand(db: Db, input: IpcPayload<"workspaces:list">): IpcResponse<"workspaces:list"> {
  const projectId = input.projectId ?? null;
  const rows = projectId === null ? listWorkspaces(db) : projectWorkspaceList(db, projectId as Uuid);
  return { workspaces: rows.map((workspace) => workspaceView(db, workspace)) };
}

/**
 * What is wrong with a config for this kind, before anything is written.
 *
 * The screen asks the same questions while a person is still looking at
 * the field; this is the answer that is authoritative, because a client
 * over MCP has no screen. Null is "go ahead".
 *
 * `scratch` and `none` are absent deliberately rather than by omission:
 * neither has anything to configure, so neither has anything to be
 * wrong with — see `SCRATCH_KIND`'s note on why a temporary directory
 * has no settings.
 */
function configProblem(kind: string, config: unknown): string | null {
  if (kind === FOLDER_KIND) {
    const parsed = FolderWorkspaceConfigSchema.safeParse(config);
    if (!parsed.success) return "A folder workspace needs a path to a directory that already exists.";
    // And the path itself, on the way *in* as well as on the way out.
    // `createWorkspace` asks this too and throws, which is its last line
    // of defence — but an update never reached that check, so a folder
    // could be moved to a path that is not there and the failure would
    // wait for the run that met it. The screen asks the same question
    // while a person is still looking at the field; this is the answer
    // that holds for a caller that has no screen.
    return folderPathProblem(parsed.data.path);
  }
  if (kind === GIT_WORKTREE_KIND) {
    const parsed = GitWorkspaceConfigSchema.safeParse(config);
    if (!parsed.success) return "A repository workspace needs a name and a path to a checkout on this machine.";
    // Blank is not a value either field may hold, which the old
    // `repositories:*` channels said with `.min(1)` on their own input
    // schemas. `GitWorkspaceConfigSchema` cannot: it describes the
    // *stored* config, and a `z.string()` there is happy with "". So the
    // two emptiness cases are named here rather than lost between the
    // schemas — a repository called nothing is one no picker can offer,
    // and an empty path is a checkout nothing can find.
    if (parsed.data.name.trim() === "") return "A repository workspace needs a name — it is what the picker and the board call it.";
    if (parsed.data.repoPath.trim() === "") return "A repository workspace needs a path to a checkout on this machine.";
    // Whether that path *is* a checkout, and whether another workspace
    // already holds it, are `repositoryPathProblem`'s and
    // `updateRepositoryCommand`'s — asked by the delegation below rather
    // than answered a second time here.
    return null;
  }
  return null;
}

/**
 * Attaches a workspace: the kind first, then that kind's config
 * (EO-301).
 *
 * The git kind goes to `repositories:create`, which is what keeps "the
 * developer's existing repositories, with their settings intact" true of
 * the ones attached *after* this story as well as before it: the path
 * check, the duplicate refusal, the project it joins and the items it
 * adopts are all that command's, and there is no second version of them
 * here to drift.
 *
 * Every other kind needs a project that already exists. It has to:
 * `createDefaultProject` names a project after its workspace, and a
 * scratch directory has no name to give one. A kind with nothing to be
 * called cannot be the first thing in an installation — which is not a
 * limitation so much as a description of what a project is.
 */
export async function createWorkspaceCommand(
  db: Db,
  credentials: ForwardedCredentials,
  input: IpcPayload<"workspaces:create">,
): Promise<IpcResponse<"workspaces:create">> {
  if (input.kind === GIT_WORKTREE_KIND) {
    const parsed = GitWorkspaceConfigSchema.safeParse(input.config);
    if (!parsed.success) return { ok: false, problem: configProblem(GIT_WORKTREE_KIND, input.config) };

    const created = await createRepositoryCommand(db, credentials, {
      name: parsed.data.name,
      description: parsed.data.description,
      repoPath: parsed.data.repoPath,
      baseBranch: parsed.data.baseBranch,
      testCommand: parsed.data.testCommand,
      lintCommand: parsed.data.lintCommand,
      buildCommand: parsed.data.buildCommand,
      ...(input.keyPrefix ? { keyPrefix: input.keyPrefix } : {}),
      ...(input.projectId !== null ? { projectId: input.projectId } : {}),
    });
    if (!created.ok || !created.repository) return { ok: false, problem: created.problem };

    // The forge settings are the git workspace's own since KAN-130, and
    // this form is where they are typed — so they are laid over the row
    // the command just made rather than added to that command's input,
    // which is the Repositories screen's and knows nothing about them.
    const patch = {
      forgeOpenPr: parsed.data.forgeOpenPr,
      forgeKind: parsed.data.forgeKind,
      forgeRemote: parsed.data.forgeRemote,
      forgeDraft: parsed.data.forgeDraft,
      forgeTemplatePath: parsed.data.forgeTemplatePath,
    };
    const workspace = updateWorkspace(db, created.repository.id as Uuid, { config: patch });
    return { ok: true, workspace: workspaceView(db, getWorkspace(db, workspace.id) ?? workspace), problem: null };
  }

  const projectId = input.projectId ?? activeProjectId(db);
  if (projectId === null) {
    return {
      ok: false,
      problem:
        `A ${input.kind} workspace attaches to a project, and this installation has none yet. A project is named after the ` +
        `first workspace on it, and a ${input.kind} workspace has no name to give one — attach a repository or a folder first.`,
    };
  }
  if (!listProjects(db).some((project) => project.id === projectId)) {
    return { ok: false, problem: "That project no longer exists." };
  }

  const problem = configProblem(input.kind, input.config);
  if (problem) return { ok: false, problem };

  try {
    const workspace = createWorkspace(db, {
      projectId: projectId as Uuid,
      kind: input.kind,
      // Cast rather than narrowed: which shape this is, is the kind's to
      // say, and `createWorkspace` parses it by the same slug it was
      // checked against above. The two agree because there is one
      // parser — `parseWorkspaceConfig` — and both go through it.
      ...(input.config !== undefined ? { config: input.config as never } : {}),
      // Appended rather than first: a workspace added later is added to
      // the end of the project's list, and the first one is what an item
      // with no workspace of its own still falls back to.
      position: projectWorkspaceList(db, projectId as Uuid).length,
    });
    return { ok: true, workspace: workspaceView(db, workspace), problem: null };
  } catch (error) {
    // `createWorkspace` throws for a folder whose path is not a
    // directory — its own last line of defence, which the check above
    // means we should never reach. Answered rather than rethrown: an
    // IPC boundary returns typed results, and a path that stopped being
    // a directory between the two checks is a thing about the world
    // rather than a programmer error.
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Changes a workspace's configuration in place.
 *
 * A patch over the kind's config, which `updateWorkspace` lays over what
 * is stored — so the git form saving a base branch does not have to
 * restate the forge settings to keep them. The kind itself never
 * changes: a repository that became a folder would be the same row
 * meaning something else, with every item on it still pointing at it.
 */
/**
 * The git kind's config patch, as `repositories:update` spells the same
 * fields.
 *
 * Only the keys actually present are forwarded. That is what keeps a
 * partial patch partial: `updateRepositoryCommand` reads `undefined` as
 * "leave it alone", so copying every key would turn "change the base
 * branch" into "restate the whole repository", and a `repoPath` restated
 * at its current value would be checked as though it were a move.
 */
function gitRepositoryPatch(patch: Record<string, unknown>): Omit<IpcPayload<"repositories:update">, "id"> {
  const keys = [
    "name",
    "description",
    "repoPath",
    "baseBranch",
    "testCommand",
    "lintCommand",
    "buildCommand",
    "forgeOpenPr",
    "forgeKind",
    "forgeRemote",
    "forgeDraft",
    "forgeTemplatePath",
  ] as const;
  const forwarded: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in patch) forwarded[key] = patch[key];
  }
  return forwarded as Omit<IpcPayload<"repositories:update">, "id">;
}

export async function updateWorkspaceCommand(
  db: Db,
  credentials: ForwardedCredentials,
  input: IpcPayload<"workspaces:update">,
): Promise<IpcResponse<"workspaces:update">> {
  const workspace = getWorkspace(db, input.id as Uuid);
  if (!workspace) return { ok: false, problem: "That workspace no longer exists." };

  const patch = (input.config ?? {}) as Record<string, unknown>;
  const merged = { ...(workspace.config as Record<string, unknown>), ...patch };
  const problem = configProblem(workspace.kind, merged);
  if (problem) return { ok: false, problem };

  // **The git kind delegates, exactly as attaching one does.** This is
  // the half that was missing and that the review caught: changing a
  // repository's path is the same act as attaching it at one, and it
  // fails the same two ways — a path git does not recognise, and a path
  // another workspace already holds, which would mint keys and cut
  // worktrees over the same branches from two records. Those checks are
  // `updateRepositoryCommand`'s and have been since long before this
  // screen existed; re-deriving them here would be the second opinion
  // about what a repository is that `createWorkspaceCommand` refuses to
  // grow, and the version that drifted would be this one.
  if (workspace.kind === GIT_WORKTREE_KIND) {
    const updated = await updateRepositoryCommand(db, credentials, { id: workspace.id, ...gitRepositoryPatch(patch) });
    if (!updated.ok) return { ok: false, problem: updated.problem };
    // Read back rather than rebuilt from what that command answered
    // with: its view is the Repositories screen's shape, and this
    // channel's is the workspace row's.
    const after = getWorkspace(db, workspace.id);
    return after ? { ok: true, workspace: workspaceView(db, after), problem: null } : { ok: false, problem: "That workspace no longer exists." };
  }

  try {
    const updated = updateWorkspace(db, workspace.id, { config: patch as never });
    return { ok: true, workspace: workspaceView(db, updated), problem: null };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Detaches a workspace. Never touches what is on disk.
 *
 * The git kind delegates again, for `createWorkspaceCommand`'s reason.
 * Removing any kind refuses while items sit on it — invariant 3, their
 * runs are append-only and EO will not delete them — and is asked here
 * in the same words. The project stays whichever kind went, last or not.
 */
export function removeWorkspaceCommand(db: Db, input: IpcPayload<"workspaces:remove">): IpcResponse<"workspaces:remove"> {
  const workspace = getWorkspace(db, input.id as Uuid);
  if (!workspace) return { ok: false, problem: "That workspace no longer exists." };
  if (workspace.kind === GIT_WORKTREE_KIND) return removeRepositoryCommand(db, input);

  const items = listItems(db, workspace.id);
  if (items.length > 0) {
    return {
      ok: false,
      problem:
        `${workspaceLabel(workspace)} still has ${items.length} ticket(s), so it can't be removed — their run history is ` +
        `append-only and EO won't delete it. Nothing on disk is touched by this either way.`,
    };
  }

  // Every step that named it lets go of it here, which is
  // `deleteWorkspace`'s doing rather than this command's: a step left
  // pointing at a workspace that is gone would resolve to the ticket's
  // anyway, but it would go on *saying* it had picked one.
  deleteWorkspace(db, workspace.id);
  return { ok: true, problem: null };
}
