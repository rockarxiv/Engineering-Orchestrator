import { SOMEONE_ELSE, type Item, type StepRefusal, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getGroup } from "../db/repos/groupsRepo.js";
import { getPerson } from "../db/repos/peopleRepo.js";
import { stepForItem } from "../db/repos/pipelineVersionsRepo.js";

/**
 * Who may act on an item on a human step owned by a group (EO-368, the
 * revised decision on EO-366).
 *
 * Two facts govern it: membership of the step's group, and who holds the
 * item (`items.assignee_id`).
 *
 * 1. Only a member of the step's group may claim the item.
 * 2. Only the holder may decide on it, move it off the step, or edit it.
 * 3. A member who does not hold it may take it over — but only from the
 *    holder they were warned about.
 * 4. An unclaimed item has nobody to decide for it: a member claims it,
 *    then decides.
 * 5. An administrator outside the group may take an item over from its
 *    holder, after the same warning, and decide on it once they hold it.
 *    They may not claim it, and may not decide on it without taking it
 *    over first (decided on EO-368, 2026-10-08). An unclaimed item has no
 *    holder to take over from, so it stays with the group.
 *
 * Commenting is not on the list and never asks: comments are the only
 * channel (invariant #4), and nobody is kept out of a thread.
 *
 * Asked by whatever applies a person's command to the record — the
 * record answering a device (`serveRecord.ts`) and the record answering
 * a browser directly (`ipc/domainCommands.ts`). Never on a solo desktop,
 * which has one person and nobody to refuse, and never for a transition
 * an agent, a module or the engine made: those are not a person acting.
 *
 * Steps with no owner and steps naming a single person answer null here,
 * which is "unchanged": whether a person-owned step should be limited to
 * that person was not decided, and is not decided by this file.
 */

/** What is being attempted, as the rule sees it. A move, a decision and an edit are one act: changing the item. */
export type GatedAct = "claim" | "takeover" | "change";

/**
 * Whether a transition is a decision on a person's step rather than a
 * drag or a run's result — told by the reason `decideItem` writes, which
 * is the one thing that travels with a queued move to say so.
 */
export function isDecision(reason: string | null | undefined): boolean {
  return reason?.startsWith("decided ") === true;
}

/** What `moveStepItemsCommand` writes, which is the one thing that travels with the move to say what it is. */
export function stepClearanceReason(stepName: string): string {
  return `moved off ${stepName} before it is removed`;
}

/** Whether a transition is work being cleared off a step that is going (EO-610). */
export function isStepClearance(reason: string | null | undefined): boolean {
  return reason?.startsWith("moved off ") === true && reason.endsWith(" before it is removed");
}

export interface GroupStep {
  group: { id: string; name: string; memberIds: readonly string[] };
}

/** The group the item's current human step waits on, or null where none does. */
export function groupStepOf(db: Db, item: Pick<Item, "stepId" | "pipelineId" | "pipelineVersionId">): GroupStep | null {
  const step = stepForItem(db, item);
  if (step === undefined || step.type !== "user" || step.ownerGroupId === null) return null;
  // A step naming a group this record has no row for is a step whose
  // group was deleted under it — `deleteGroup` unnames the steps it
  // knows about in the same transaction, so this is a published graph
  // naming somebody else's. It waits on nobody this record can name, and
  // refusing everybody on its behalf would be a step nothing can leave.
  const group = getGroup(db, step.ownerGroupId);
  if (group === undefined) return null;
  return { group: { id: group.id, name: group.name, memberIds: group.memberIds } };
}

/** Who holds an item, by name, or null for nobody. */
export function holderView(db: Db, assigneeId: string | null): { id: string; name: string } | null {
  if (assigneeId === null) return null;
  return { id: assigneeId, name: getPerson(db, assigneeId as Uuid)?.name || SOMEONE_ELSE };
}

/**
 * Whether this person may do this to this item where it stands, and if
 * not, why — or null for "nothing here stops them".
 *
 * `personId` null is a caller who is nobody — the operator's key on a
 * server — and nobody is a member of anything.
 *
 * `warnedAbout` is a takeover's condition: the holder the person was
 * shown before confirming. Ignored for every other act.
 *
 * A claim is judged on membership only. Who already holds the item is
 * the record's arbitration (`arbitrateClaim`, EO-367), which tells the
 * loser who won; doing it twice would be two sentences for one event.
 * Callers with no arbitration of their own ask `judgeClaimOutright`.
 */
export function judgeOnGroupStep(
  db: Db,
  item: Pick<Item, "stepId" | "pipelineId" | "pipelineVersionId" | "assigneeId">,
  personId: string | null,
  act: GatedAct,
  warnedAbout?: string,
): StepRefusal | null {
  const gated = groupStepOf(db, item);
  if (gated === null) {
    // Nothing gates a step that does not wait on a group — except that a
    // takeover is only ever *of* such a step. One that arrives after the
    // item moved on (it was queued, and the holder decided meanwhile) has
    // nothing to take over, and the person who sent it is told so in
    // their inbox like any other refusal here.
    return act === "takeover"
      ? { why: "notGroupStep", groupName: "", holder: holderView(db, item.assigneeId), stepId: item.stepId, pipelineId: item.pipelineId }
      : null;
  }
  const refusal = (why: StepRefusal["why"]): StepRefusal => ({
    why,
    groupName: gated.group.name,
    holder: holderView(db, item.assigneeId),
    stepId: item.stepId,
    pipelineId: item.pipelineId,
  });

  if (personId === null) return refusal("notInGroup");
  if (!gated.group.memberIds.includes(personId)) {
    // An administrator outside the group (rule 5): a takeover is judged
    // like a member's, and a change by the person holding the item —
    // which an admin can only have become by taking it over — stands.
    // Everything else, a claim included, is refused as for anybody else.
    const admin = isAdmin(db, personId);
    if (!(admin && (act === "takeover" || (act === "change" && item.assigneeId === personId)))) return refusal("notInGroup");
  }

  switch (act) {
    case "claim":
      return null;
    case "takeover":
      // Only from the holder they were warned about, and from nobody else
      // — themselves included. An item that reached the sender by some
      // other way since the warning has still changed hands, and they are
      // told so rather than acknowledged. A replay of a takeover that
      // landed is recognised by its own comment id before this is asked
      // (`serveRecord.ts`), never by who holds the item now.
      return item.assigneeId !== null && item.assigneeId === warnedAbout && item.assigneeId !== personId ? null : refusal("stale");
    case "change":
      if (item.assigneeId === null) return refusal("unclaimed");
      return item.assigneeId === personId ? null : refusal("heldBy");
  }
}

/**
 * A claim judged in full — membership, and whether somebody else already
 * holds the item — for a caller that has no arbitration of its own: the
 * record answering a browser directly, where the claim is applied as it
 * arrives rather than queued and arbitrated.
 */
export function judgeClaimOutright(
  db: Db,
  item: Pick<Item, "stepId" | "pipelineId" | "pipelineVersionId" | "assigneeId">,
  personId: string | null,
): StepRefusal | null {
  const refusal = judgeOnGroupStep(db, item, personId, "claim");
  if (refusal !== null || item.assigneeId === null || item.assigneeId === personId) return refusal;
  // A member, on an item somebody else holds — on a group step only; an
  // ungrouped step is unchanged, and answers null from the judge above
  // without ever being asked who holds it.
  const gated = groupStepOf(db, item);
  if (gated === null) return null;
  return {
    why: "heldBy",
    groupName: gated.group.name,
    holder: holderView(db, item.assigneeId),
    stepId: item.stepId,
    pipelineId: item.pipelineId,
  };
}

/** Who may act on an item where it stands, as `items:authority` answers it. */
export interface ItemAuthority {
  group: { id: string; name: string };
  holder: { id: string; name: string } | null;
  you: "holder" | "member" | "outsider";
}

/**
 * The rule above, said to a screen rather than applied to a command: for
 * this person, on this item, which of the three they are. Null wherever
 * nothing is gated.
 *
 * The holder must be in the group to decide — a non-member can neither
 * claim nor decide — so an item somebody handed to a person outside the
 * group reads as that person being an outsider to it, which is exactly
 * what the record would answer them. The one exception is rule 5's
 * administrator, who reads as a member on an item somebody holds (so is
 * offered Take over) and as the holder once they have taken it.
 */
export function authorityFor(
  db: Db,
  item: Pick<Item, "stepId" | "pipelineId" | "pipelineVersionId" | "assigneeId">,
  personId: string | null,
): ItemAuthority | null {
  const gated = groupStepOf(db, item);
  if (gated === null) return null;
  const group = { id: gated.group.id, name: gated.group.name };
  const holder = holderView(db, item.assigneeId);
  if (personId !== null && gated.group.memberIds.includes(personId)) {
    return { group, holder, you: item.assigneeId === personId ? "holder" : "member" };
  }
  // An administrator outside the group (rule 5) is offered what a member
  // is on an item somebody holds — the warning and Take over — and the
  // decision once it is theirs. On an unclaimed item there is nobody to
  // take it from and they may not claim it, so they are told whose step
  // it is, as anybody outside the group is.
  if (personId !== null && isAdmin(db, personId) && holder !== null) {
    return { group, holder, you: holder.id === personId ? "holder" : "member" };
  }
  return { group, holder, you: "outsider" };
}

function isAdmin(db: Db, personId: string): boolean {
  return getPerson(db, personId as Uuid)?.isAdmin === true;
}
