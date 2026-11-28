import type { Item, Uuid } from "@eo/core";
import type { Db } from "../../../db/client.js";
import { appendRunEvent, getGitWorkspace, getItem, getRun, runEventPayloadsOfType } from "../../../db/repos/index.js";
import { git } from "./git.js";
import { itemBranchName } from "./workName.js";

/**
 * The `run_events.type` the commit an item's branch was on when a run
 * finished is recorded under (EO-930).
 *
 * Written by the git kind on `implement` runs, once the branch has passed
 * verification (and been rebased by it), and on `review` runs, at the end
 * of the review. It is what lets EO tell, after a To Do run, whether the
 * branch is still the commit Review last approved, from git rather than
 * from anything either agent said: both commits are read here, by EO,
 * from the repository.
 *
 * An event rather than a column on the run, because it is a fact about
 * one run that only this pack has a word for, and `run_events` is where a
 * run's facts are appended (invariant 3: never updated).
 */
export const BRANCH_HEAD_EVENT = "branch_head";

/** The payload of a {@link BRANCH_HEAD_EVENT} row. */
export interface BranchHeadEvent {
  /** The full commit id `refs/heads/<branch>` resolved to. */
  commit: string;
  /** The branch it was read from. */
  branch: string;
}

/**
 * Which commit the item's branch is on, read from its repository. Null
 * where the item has no Git workspace, or the branch does not resolve to
 * a commit: an answer EO could not read is never taken for a match.
 */
export async function readBranchHead(db: Db, item: Item): Promise<BranchHeadEvent | null> {
  // Read fresh, for the reason the verifier does: the branch is written
  // to the row by `prepare`, after the in-memory item was dispatched.
  const stored = getItem(db, item.id) ?? item;
  const workspace = stored.workspaceId === null ? undefined : getGitWorkspace(db, stored.workspaceId);
  if (workspace === undefined) return null;
  const branch = await itemBranchName(db, stored);
  const head = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], workspace.config.repoPath);
  return head.ok && head.stdout !== "" ? { commit: head.stdout, branch } : null;
}

/**
 * Reads the branch's commit and records it on the run. Nothing is
 * recorded where it could not be read, which leaves the run comparable
 * with nothing.
 *
 * Appended without a buffer: the git kind is asked to verify a run after
 * its stream has ended, which is when `REVIEW_VERDICT_EVENT` is written
 * too.
 */
export async function recordBranchHead(db: Db, item: Item, runId: Uuid): Promise<BranchHeadEvent | null> {
  const head = await readBranchHead(db, item);
  // A run with no row — a check asked of a run nothing recorded — has
  // nowhere to keep it, and is compared with nothing later either.
  if (head !== null && getRun(db, runId) !== undefined) appendRunEvent(db, runId, BRANCH_HEAD_EVENT, head);
  return head;
}

/** The branch head each of these runs recorded, by run id. A run that recorded none is absent. */
export function branchHeadsOfRuns(db: Db, runIds: readonly string[]): Map<string, BranchHeadEvent> {
  const heads = new Map<string, BranchHeadEvent>();
  for (const [runId, payload] of runEventPayloadsOfType(db, runIds, BRANCH_HEAD_EVENT)) {
    const head = asBranchHead(payload);
    if (head !== null) heads.set(runId, head);
  }
  return heads;
}

function asBranchHead(payload: unknown): BranchHeadEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { commit, branch } = payload as { commit?: unknown; branch?: unknown };
  return typeof commit === "string" && commit !== "" && typeof branch === "string" ? { commit, branch } : null;
}
