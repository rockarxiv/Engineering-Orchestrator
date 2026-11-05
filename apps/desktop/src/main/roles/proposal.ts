import { refineChildren, type Comment, type Item, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getAgent, getItem, getRun, listCommentsForItem, postComment } from "../db/repos/index.js";
import { packMeaningInForce } from "../registry.js";
import { buildProposal } from "./refine.js";

/**
 * A decomposition, posted for a human to argue with (R-04).
 *
 * `decision` rather than `question`: it is a plan the product owner is
 * standing behind, not an open question. What makes it a proposal is the
 * run behind it — approval reads that run's result, so the plan that
 * gets built is the one that was displayed.
 */
export const PROPOSAL_KIND = "decision";

/**
 * Is this the comment carrying a plan? A proposal is a decision written
 * during a `refine` run — the pack's `refine`, which is the one that
 * decomposes (EO-422).
 *
 * A role that defined `refine` for itself answers in its own shape, and
 * a decision it left in the thread is a decision, not a plan anybody
 * can approve into tickets. Asked of the run's own agent, since the
 * definition is that role's and nobody else's; a run whose agent or
 * item is gone is read by its action alone, as it always was.
 */
export function isProposal(db: Db, comment: Comment): boolean {
  if (comment.kind !== PROPOSAL_KIND || comment.runId === null) return false;
  const run = getRun(db, comment.runId);
  if (run?.action !== "refine") return false;
  const item = getItem(db, run.itemId);
  const agent = run.agentId === null ? undefined : getAgent(db, run.agentId);
  return item === undefined || agent === undefined || packMeaningInForce(db, item, agent.role, run.action);
}

/**
 * The newest proposal on a feature, or undefined.
 *
 * Ties on `createdAt` are broken by id, which is not arbitrary: ids are
 * UUIDv7, so they sort in creation order. Two proposals can land in the
 * same millisecond — a revision arriving fast, or a test — and without
 * this "newest" was whatever the sort happened to do, which decided
 * whether approving built the plan you were looking at.
 */
export function latestProposal(db: Db, featureId: Uuid): Comment | undefined {
  return listCommentsForItem(db, featureId)
    .filter((comment) => isProposal(db, comment))
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0];
}

/**
 * Posts what a `refine` run came back with (R-04).
 *
 * No items are created here — that was the shortcut this story
 * removes. A plan you cannot argue with before it becomes twelve rows in
 * a table is not a plan, it is a fait accompli.
 */
export function postRefineProposal(db: Db, feature: Item, agentId: Uuid, runId: Uuid, parsedResult: unknown): void {
  // Read rather than re-validated against a shape written here
  // (KAN-147): a decomposition's children are of the types this project
  // has, each held to that type's own fields, and A-02 has already held
  // this result to exactly that composed document.
  const children = refineChildren(parsedResult);

  // Every child the answer claimed has to reach the plan, or the person
  // is told why (invariant 8, KAN-147).
  //
  // A-02 held the result to the composed document, so this should not
  // happen — but "should not" is how a plan disappears. `refineChildren`
  // skips an entry it cannot read, and a silent skip here would post a
  // proposal missing work the agent did, or no comment at all for a run
  // that reported success: the feature would sit at the refine step
  // looking finished with nothing to approve. So the count is compared,
  // and a plan that did not survive being read is a rejection rather
  // than a silence.
  const claimed = childEntries(parsedResult);
  if (children.length < claimed || children.length === 0) {
    postComment(db, {
      itemId: feature.id,
      runId,
      author: { type: "agent", agentId },
      kind: "rejection",
      mentions: [{ type: "human" }],
      body:
        `EO could not read ${claimed === 0 ? "a plan" : `${claimed - children.length} of the ${claimed} tickets`} out of this decomposition, so there is nothing to approve. ` +
        `Ask for the plan again — and if it keeps happening, one of this project's item types redefines a field a plan carries (\`depends_on\`, \`touches\`, \`repository\`) as something EO reads differently.`,
    });
    return;
  }

  const proposal = buildProposal(db, feature.projectId, children);

  if (!proposal.ok) {
    // An unbuildable plan must not reach the human as approvable, so
    // this is posted as a rejection with no proposal behind it: there is
    // nothing to approve, only something to redo.
    postComment(db, {
      itemId: feature.id,
      runId,
      author: { type: "agent", agentId },
      kind: "rejection",
      mentions: [{ type: "human" }],
      body: proposal.reason,
    });
    return;
  }

  postComment(db, {
    itemId: feature.id,
    runId,
    author: { type: "agent", agentId },
    kind: PROPOSAL_KIND,
    mentions: [{ type: "human" }],
    body: proposal.body,
  });
}

export type ApproveProposalResult =
  /** `stories` so the caller can mirror them into Jira (J-03) without re-deriving which ones are new. */
  | { ok: true; approved: number; stories: Item[] }
  | { ok: false; reason: string };

/*
 * Approving a decomposition used to live here: a feature parked on
 * `pending_approval` with a plan in its thread, approved (or sent back to
 * `backlog`) from the item screen.
 *
 * That gate has not been weakened — the design is emphatic that
 * the story DAG is the one handoff the engine cannot verify, so a human
 * reads it before it becomes twelve rows. It moved. It is the "Create
 * item" button on a proposal in Discussions now (ARCHITECTURE.md, "A column is a responsibility,
 * not a status"), which is the same
 * gate on a different surface: a person reads the plan and says yes, and
 * only then do items exist.
 *
 * What is gone is the *column*. `intake`, `backlog` and `pending_approval`
 * were places an item sat while it was still becoming an item, and a
 * pipeline that holds only work has nowhere to put that.
 */

/**
 * How many children an answer claimed, before any of them was read.
 *
 * The other half of `refineChildren`, which returns what it could read:
 * comparing the two is what makes a child that fell out of the reading
 * something EO says rather than something it loses. Both spellings,
 * because both are plans (see `refineChildren`).
 */
function childEntries(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  const bag = value as Record<string, unknown>;
  const entries = bag["children"] ?? bag["stories"];
  return Array.isArray(entries) ? entries.length : 0;
}
