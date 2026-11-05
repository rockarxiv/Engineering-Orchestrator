import { statSync } from "node:fs";
import { join } from "node:path";
import { asc, eq, isNull } from "drizzle-orm";
import {
  FOLDER_KIND,
  GIT_WORKTREE_KIND,
  NONE_KIND,
  NO_WORKSPACE,
  SCRATCH_KIND,
  parseWorkspaceConfig,
  uuidv7,
  type FolderWorkspaceConfig,
  type GitWorkspaceConfig,
  type Uuid,
  type WorkspaceConfig,
  type WorkspaceKindSlug,
} from "@eo/core";
import type { Db } from "../client.js";
import { pipelineSteps, workspaces } from "../schema.js";

/**
 * Where work happens (KAN-130, ARCHITECTURE.md, "A workspace is a kind, attached to the project").
 *
 * `repositories` until this story, and the id is the same one — an item
 * that named a repository names the workspace that replaced it. What
 * changed is what the row holds: the key prefix went to the project in
 * KAN-128, the eight Jira columns are a connector binding on the project
 * (`connectorBindingsRepo.ts`), and what is left is this kind's config.
 *
 * The domain object is the row rather than the old columns flattened
 * back out: `config` is the *kind's* to describe. Readers said
 * `workspace.config.repoPath`, which is a sentence that stops making
 * sense on a `folder` workspace — and since EO-299 there is one, so the
 * kind check this file predicted is here: `config` is a union, and
 * `asGitWorkspace` is what a caller that wants a repository says.
 */
export interface Workspace {
  id: Uuid;
  /**
   * The project this workspace belongs to, or null for one whose project
   * was deleted.
   *
   * Nullable for the reason `items.projectId` is: EO is usable before
   * anything is configured, and a repository outlived its project before
   * this story too — the membership row cascaded, the repository did not.
   * A run resolves the item's workspace, so detaching is the honest
   * answer where deleting would take the disk with it.
   */
  projectId: Uuid | null;
  /**
   * The slug of the kind that prepares this workspace (EO-295).
   *
   * A string rather than a closed set, because which kinds exist is
   * which packs are installed: the supervisor resolves this against the
   * kinds the fold gave it, and a slug nothing answers to is a run with
   * no disk of its own rather than a row that fails to parse.
   */
  kind: WorkspaceKindSlug;
  /** Orders the picker. Was the membership row's position. */
  position: number;
  /**
   * This kind's configuration, parsed by the kind that named it
   * (EO-299).
   *
   * A union rather than the git kind's shape, and every reader that
   * wants a repository path now has to establish that it is looking at a
   * repository — which is the kind check this file predicted when it
   * said `workspace.config.repoPath` is a sentence that stops making
   * sense on a `folder` workspace. `asGitWorkspace` and
   * `asFolderWorkspace` below are how that check is spelled, so that the
   * narrowing happens once where the workspace is fetched rather than at
   * every field.
   */
  config: WorkspaceConfig;
  createdAt: number;
  updatedAt: number;
}

function toDomain(row: typeof workspaces.$inferSelect): Workspace {
  return {
    id: row.id as Uuid,
    projectId: (row.projectId as Uuid | null) ?? null,
    kind: row.kind,
    position: row.position,
    // Parsed with the schema's defaults rather than cast: `config` is
    // JSON, so a row written by an older EO — or by a migration that ran
    // before a key existed — is a real possibility, and every reader
    // would otherwise have to cope with `undefined` where the type
    // promises a value. Which schema is the *kind's* to say since
    // EO-299: the git schema requires a repository path, which a folder
    // row has never had and would fail to parse.
    config: parseWorkspaceConfig(row.kind, row.config),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * A workspace of the git kind, where `config` is the git kind's
 * (EO-299).
 *
 * The type most of the developer pack actually wants. Everything in it
 * — cutting a worktree, resolving a stack target, opening a pull
 * request, running the test command — is about a repository and has
 * nothing to say about a folder, so it takes one of these and the
 * narrowing happens once, where the workspace is fetched.
 */
export interface GitWorkspace extends Workspace {
  config: GitWorkspaceConfig;
}

/** A workspace of the folder kind, where `config` is the folder kind's. */
export interface FolderWorkspace extends Workspace {
  config: FolderWorkspaceConfig;
}

/**
 * This workspace if it is a repository, else undefined (EO-299).
 *
 * The cast is the one place in the codebase that asserts what the slug
 * means about the config, and it is sound because `toDomain` chose the
 * parser by that same slug: a row whose kind is `git-worktree` was
 * parsed with the git schema or the read threw. Doing it here, once,
 * is what keeps every caller from either repeating the assertion or
 * inventing its own answer to "what if it is a folder".
 *
 * Undefined rather than a throw, because "this item is not on a
 * repository" is an ordinary state of the world since there are kinds
 * that are not repositories — and every caller here already has an
 * answer for a workspace that is missing.
 */
export function asGitWorkspace(workspace: Workspace | undefined): GitWorkspace | undefined {
  return workspace?.kind === GIT_WORKTREE_KIND ? (workspace as GitWorkspace) : undefined;
}

/** The same narrowing for the folder kind, which its own `prepare` and `verify` ask for. */
export function asFolderWorkspace(workspace: Workspace | undefined): FolderWorkspace | undefined {
  return workspace?.kind === FOLDER_KIND ? (workspace as FolderWorkspace) : undefined;
}

/**
 * What to call this workspace where a person sees it (EO-299).
 *
 * A repository has a name somebody typed. A folder has a path, which is
 * what a person would call it anyway — "the reports drive" is what the
 * path says — and giving it a name field of its own would be a second
 * thing to keep in step with the directory it points at. Anything else
 * is named by its kind, which is all EO knows about a workspace a pack
 * contributed.
 *
 * One function because the three places that show one — the project's
 * name when a repository is attached, the board's per-item label and
 * the settings lists — must agree, and until this story they agreed
 * only because there was one kind.
 */
export function workspaceLabel(workspace: Workspace): string {
  const git = asGitWorkspace(workspace);
  if (git) return git.config.name;
  const folder = asFolderWorkspace(workspace);
  if (folder) return folder.config.path;
  return workspace.kind;
}

/** The git workspace with this id, or undefined where there is none or it is of another kind. */
export function getGitWorkspace(db: Db, id: Uuid): GitWorkspace | undefined {
  return asGitWorkspace(getWorkspace(db, id));
}

/**
 * What is wrong with a folder workspace's path, in a sentence (EO-299).
 *
 * A folder workspace is the one kind whose configuration names
 * something that has to already exist: a repository EO can clone or be
 * pointed at, a scratch directory it makes itself, an empty directory
 * for `none` — but a shared drive is somebody else's, and a path that
 * is not there is a typo rather than a thing to create. Creating the
 * directory would be worse than refusing: a mistyped path would
 * silently become a new empty folder, and the report nobody can find
 * would be in it.
 *
 * Checked when the workspace is created, which is where a person can
 * still do something about it — and read again by the folder kind's own
 * `prepare`, and by the needs check (phase 6), because a drive that is
 * not mounted this morning is a workspace that cannot be worked in
 * whatever it was when it was attached.
 *
 * Null is "nothing wrong". Anything else is a sentence for a person.
 */
export function folderPathProblem(path: string): string | null {
  if (path.trim() === "") return "A folder workspace needs a path, and this one is empty.";
  try {
    const stats = statSync(path);
    if (!stats.isDirectory()) return `${path} is not a directory, so it cannot be a folder workspace.`;
    return null;
  } catch {
    return `${path} does not exist, so it cannot be a folder workspace. EO does not create it: a path that is not there is usually a typo, and a folder made to match one is a folder nobody will look in.`;
  }
}

/**
 * What is wrong with a *git* workspace's checkout, in a sentence
 * (EO-301).
 *
 * `folderPathProblem`'s counterpart for the kind that has one, and the
 * other half of what the Workspaces screen shows and the needs check
 * (phase 6) will read. A repository is attached once, checked properly
 * then — `repositoryPathProblem` in `repositoryCommands.ts` asks git
 * itself, because whether a path is a checkout is git's question — and
 * then lives on a disk that can be unplugged, renamed or wiped by
 * somebody cleaning up. This is the question asked *afterwards*, every
 * time somebody looks.
 *
 * Deliberately cheaper than the attach-time check and deliberately
 * synchronous: it is asked about every workspace every time the list is
 * drawn, and spawning a `git rev-parse` per row to redraw a settings
 * screen would be paying a process for an answer three `stat` calls
 * give. What it catches is the failure that actually happens to an
 * attached repository — the directory is gone, or it is not a directory
 * any more, or the `.git` inside it is. What it misses is a checkout
 * corrupted in a way only git can see, which `prepare` meets and
 * refuses before the agent starts.
 *
 * Null is "nothing wrong". Anything else is a sentence for a person.
 */
export function repositoryReadProblem(repoPath: string): string | null {
  if (repoPath.trim() === "") return "A repository workspace needs a path, and this one is empty.";
  try {
    if (!statSync(repoPath).isDirectory()) return `${repoPath} is not a directory any more, so EO cannot work in it.`;
  } catch {
    return `${repoPath} is not there any more. If the drive it is on is unmounted, mount it; if the checkout moved, point this workspace at where it went.`;
  }
  // Both spellings: a directory in an ordinary checkout, a file holding
  // `gitdir:` in a worktree or a submodule. `statSync` answers for both
  // without caring which, which is the point of asking about existence
  // rather than about shape.
  try {
    statSync(join(repoPath, ".git"));
  } catch {
    return `${repoPath} is still there but is no longer a git checkout — nothing inside it is called .git. EO clones nothing, so this has to be a repository that already exists.`;
  }
  return null;
}

/**
 * What is wrong with this workspace right now, whatever kind it is
 * (EO-301).
 *
 * One function over four kinds, because the screen draws one list and
 * the needs check reads one line per workspace: a caller asking "can
 * this be worked in?" must not have to know which kind it is holding in
 * order to ask. The kinds that can be wrong answer; `scratch` makes its
 * own directory and `none` is an empty one, so neither can be, and a
 * kind a pack contributed is not this package's to judge.
 */
export function workspaceProblem(workspace: Workspace): string | null {
  const git = asGitWorkspace(workspace);
  if (git) return repositoryReadProblem(git.config.repoPath);
  const folder = asFolderWorkspace(workspace);
  if (folder) return folderPathProblem(folder.config.path);
  return null;
}

/**
 * A sentence under the name, saying what this workspace *is* (EO-301).
 *
 * The kind-specific half of a row whose other halves are the same for
 * everything: where the repository is and what it branches from, where
 * the folder is, and for the two kinds with nothing to say, the plain
 * statement that there is nothing to say. "scratch" and "none" read
 * thinly on purpose — a sentence padded out to match the git row's
 * would be inventing configuration neither kind has.
 */
export function workspaceSummary(workspace: Workspace): string {
  const git = asGitWorkspace(workspace);
  if (git) return `${git.config.repoPath} · ${git.config.baseBranch}`;
  const folder = asFolderWorkspace(workspace);
  if (folder) return folder.config.perItemSubfolder ? `${folder.config.path} · a subfolder per ticket` : folder.config.path;
  if (workspace.kind === SCRATCH_KIND) return "scratch — a fresh directory per run, kept only until its output is posted";
  if (workspace.kind === NONE_KIND) return "none — no disk. The agent works through MCP servers and connectors.";
  return workspace.kind;
}

export interface CreateWorkspaceInput {
  /** Null attaches it to nothing; `addWorkspaceToProject` or `createDefaultProject` is what usually follows. */
  projectId?: Uuid | null;
  kind?: WorkspaceKindSlug;
  /**
   * What this kind needs to be configured with, in that kind's own
   * shape (EO-299).
   *
   * A union rather than the git kind's config, and absent for the kinds
   * that have nothing to configure — `scratch` makes its own directory
   * and `none` is an empty one. Parsed by the slug, so a git workspace
   * created without a repository path is still refused at the same
   * moment it always was.
   */
  config?: (Partial<GitWorkspaceConfig> & Pick<GitWorkspaceConfig, "name" | "repoPath">) | (Partial<FolderWorkspaceConfig> & Pick<FolderWorkspaceConfig, "path">);
  position?: number;
}

/**
 * A workspace, and nothing about item keys.
 *
 * The key prefix was on the repository until KAN-128 and is the
 * project's now: keys were per project in practice, and a project
 * spanning two repositories had two counters minting keys for work that
 * was one project's. A workspace numbers its items from the project it
 * is attached to.
 */
export function createWorkspace(db: Db, input: CreateWorkspaceInput): Workspace {
  const now = Date.now();
  const kind = input.kind ?? GIT_WORKTREE_KIND;
  const config = parseWorkspaceConfig(kind, input.config ?? {});
  // The one kind whose config names something that must already be
  // there (EO-299). A throw rather than a typed result because this is
  // meant to be the last line of the defence rather than the first: the
  // screen that attaches a folder (EO-301) asks `folderPathProblem`
  // while the person is still looking at the field, and reaching here
  // with a path that is not a directory means nothing did.
  if (kind === FOLDER_KIND) {
    const problem = folderPathProblem((config as FolderWorkspaceConfig).path);
    if (problem !== null) throw new Error(problem);
  }
  const row = db
    .insert(workspaces)
    .values({
      id: uuidv7(),
      projectId: input.projectId ?? null,
      kind,
      config,
      position: input.position ?? 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toDomain(row);
}

/**
 * A repository, attached (EO-299).
 *
 * The named door for the one kind a person can attach today, and what
 * `repositories:add` calls. The cast is sound for `asGitWorkspace`'s
 * reason and is spelled once here rather than at the call site: the
 * kind passed in is the kind the config was parsed with, so what comes
 * back is a git workspace by construction.
 */
export function createGitWorkspace(db: Db, input: Omit<CreateWorkspaceInput, "kind" | "config"> & { config: Partial<GitWorkspaceConfig> & Pick<GitWorkspaceConfig, "name" | "repoPath"> }): GitWorkspace {
  return createWorkspace(db, { ...input, kind: GIT_WORKTREE_KIND, config: input.config }) as GitWorkspace;
}

export function listWorkspaces(db: Db): Workspace[] {
  return db.select().from(workspaces).orderBy(asc(workspaces.createdAt)).all().map(toDomain);
}

/**
 * Every repository EO drives (EO-299).
 *
 * What the Repositories screen lists, and what "is this path already
 * attached?" is asked of. A folder workspace is not a repository and
 * has no repository path to clash with one, so it is not in this list —
 * the screen that shows *every* kind is Settings → Workspaces, which is
 * EO-301's.
 */
export function listGitWorkspaces(db: Db): GitWorkspace[] {
  return listWorkspaces(db).filter((workspace): workspace is GitWorkspace => workspace.kind === GIT_WORKTREE_KIND);
}

export function getWorkspace(db: Db, id: Uuid): Workspace | undefined {
  const row = db.select().from(workspaces).where(eq(workspaces.id, id)).get();
  return row ? toDomain(row) : undefined;
}

/**
 * The workspace an item belongs to, or undefined for an item written
 * before any was attached.
 *
 * Everything that needs a path goes through here rather than through
 * "the configured one", which is what used to make a second repository
 * impossible.
 */
export function getWorkspaceForItem(db: Db, workspaceId: Uuid | null): Workspace | undefined {
  return workspaceId === null ? undefined : getWorkspace(db, workspaceId);
}

export type UpdateWorkspaceInput = { position?: number } & { config?: Partial<GitWorkspaceConfig> | Partial<FolderWorkspaceConfig> };

/**
 * Lays a patch over the kind's config and writes the result.
 *
 * Read-modify-write because `config` is one JSON value: a caller that
 * only means to change the test command must not have to restate the
 * forge settings to keep them, which is the trap a JSON column sets for
 * every partial update.
 */
export function updateWorkspace(db: Db, id: Uuid, patch: UpdateWorkspaceInput): Workspace {
  const current = getWorkspace(db, id);
  if (!current) throw new Error(`no workspace with id ${id}`);

  const row = db
    .update(workspaces)
    .set({
      ...(patch.position !== undefined ? { position: patch.position } : {}),
      // Re-parsed by the row's own kind, so a patch over a folder's
      // config is held to the folder schema and a pack kind's config —
      // which this package has no schema for — survives a change of
      // position rather than being emptied by a parser that did not
      // recognise it (EO-299).
      ...(patch.config !== undefined ? { config: parseWorkspaceConfig(current.kind, { ...current.config, ...patch.config }) } : {}),
      updatedAt: Date.now(),
    })
    .where(eq(workspaces.id, id))
    .returning()
    .get();
  return toDomain(row);
}

/** Every workspace no project holds — what a deleted project leaves behind. */
export function unattachedWorkspaces(db: Db): Workspace[] {
  return db.select().from(workspaces).where(isNull(workspaces.projectId)).orderBy(asc(workspaces.createdAt)).all().map(toDomain);
}

/**
 * Detaches a workspace, and lets go of every step that named it
 * (EO-301).
 *
 * The second half is what a foreign key would have done, done by hand
 * and better: `pipeline_steps.workspace_id` carries no key because one
 * of its legal values — the `none` sentinel — is not a row, and
 * `ON DELETE SET NULL` could not have told a step that lost its
 * workspace apart from a step that chose no disk on purpose. Cleared
 * here, the step falls back to the ticket's workspace, which is what it
 * did before anybody picked and the only fallback that leaves work
 * running.
 *
 * The sentinel is explicitly not matched: `id` is a UUID and the
 * sentinel is not, so the comparison cannot collide — but the
 * inequality is written down rather than argued, because the day a
 * kind slug and an id could collide is a day this would silently take
 * "no disk" away from every step that had asked for it.
 */
export function deleteWorkspace(db: Db, id: Uuid): void {
  if (id !== NO_WORKSPACE) {
    db.update(pipelineSteps).set({ workspaceId: null }).where(eq(pipelineSteps.workspaceId, id)).run();
  }
  db.delete(workspaces).where(eq(workspaces.id, id)).run();
}
