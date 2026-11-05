import type { IpcPayload, IpcResponse } from "@eo/core";
import type { Db } from "../db/client.js";
import { getItem, listActiveRuns, listItemsIncludingArchived } from "../db/repos/index.js";
import { branchPrefix } from "../packs/developer/workspace/branchPrefix.js";
import { allWorktreeConfigs, releaseWorktree } from "../packs/developer/workspace/dispatchWorkspace.js";
import { listHeldWorktrees } from "../packs/developer/workspace/worktrees.js";

/**
 * Which item keys a run is currently working in.
 *
 * The same question the boot-time cleanup asks (`hasActiveRun`), asked
 * here so the UI can grey out a Release button rather than offering an
 * action that would delete the directory an agent is writing to.
 */
function activeItemKeys(db: Db): Set<string> {
  const keys = new Set<string>();
  for (const run of listActiveRuns(db)) {
    const item = getItem(db, run.itemId);
    if (item) keys.add(item.key);
  }
  return keys;
}

/**
 * Every EO worktree on disk, with its size and whether it is safe to
 * release (G-03).
 *
 * `problem` rather than a thrown error: no workspace configured, or a
 * repo that has moved, is a normal state for this screen — it should say
 * so in place, not blank out.
 */
export async function listWorktreesCommand(db: Db, input: IpcPayload<"worktrees:list">, worktreeRoot?: string): Promise<IpcResponse<"worktrees:list">> {
  const repositories = allWorktreeConfigs(db, worktreeRoot).filter(
    (entry) => input.repositoryId === null || entry.workspace.id === input.repositoryId,
  );
  if (repositories.length === 0) return { worktrees: [], problem: "No repository is configured yet, so there are no worktrees." };

  const active = activeItemKeys(db);
  // Archived too (KAN-33): a checkout on disk is a real thing taking
  // real space whether or not the project still shows its item, and a
  // worktree nobody can name is one nobody will release.
  const stateByKey = new Map(listItemsIncludingArchived(db).map((item) => [item.key, item.stepId]));
  const worktrees: IpcResponse<"worktrees:list">["worktrees"] = [];
  const problems: string[] = [];
  const prefix = await branchPrefix(db);

  for (const { workspace, config } of repositories) {
    const held = await listHeldWorktrees(config, prefix);
    if (!held.ok) {
      problems.push(held.reason);
      continue;
    }

    for (const entry of held.value) {
      const { itemKey, path, branch, sizeBytes, uncommittedChanges } = entry;
      worktrees.push({
        itemKey,
        path,
        branch,
        sizeBytes,
        uncommittedChanges,
        itemState: stateByKey.get(itemKey) ?? null,
        inUse: active.has(itemKey),
        repositoryId: workspace.id,
        repositoryName: workspace.config.name,
      });
    }
  }

  return { worktrees, problem: problems.length > 0 ? problems.join("\n\n") : null };
}

/**
 * Releases one worktree by hand, keeping its branch.
 *
 * Refuses while a run is using it. `force` exists for the one case the
 * automatic path will never take — a tree with uncommitted changes the
 * user has looked at and decided to discard — and even then the branch
 * survives, so nothing committed is ever lost here.
 */
export async function releaseWorktreeCommand(
  db: Db,
  input: IpcPayload<"worktrees:release">,
  worktreeRoot?: string,
): Promise<IpcResponse<"worktrees:release">> {
  // The item's own workspace — releasing has to run git in the repo
  // that owns the checkout, not in whichever one happens to be first.
  const item = listItemsIncludingArchived(db).find((candidate) => candidate.key === input.itemKey);
  const config = allWorktreeConfigs(db, worktreeRoot).find(
    (entry) => entry.workspace.id === (item?.workspaceId ?? input.repositoryId),
  )?.config;
  if (!config) return { released: false, reason: `Could not work out which repository ${input.itemKey} belongs to.` };

  if (activeItemKeys(db).has(input.itemKey)) {
    return { released: false, reason: `${input.itemKey} has a run in progress — cancel it first, or wait for it to finish.` };
  }

  // Through `releaseWorktree` rather than `removeWorktree`, so a tree
  // released by hand forgets its index record exactly as one released
  // automatically does (EO-174). This is the release a person watches
  // happen, so a row left behind here is the one they would see.
  const removed = await releaseWorktree(db, config, input.itemKey, { force: input.force, deleteBranch: false });
  return removed.ok ? { released: true, reason: null } : { released: false, reason: removed.reason };
}
