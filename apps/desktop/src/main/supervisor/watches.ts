import { createHash } from "node:crypto";
import type { Item, ItemWatchView, MentionTarget, PipelineStep, Run, Uuid } from "@eo/core";
import { watchGiveUpAt, type WatchHold } from "@eo/engine";
import type { Db } from "../db/client.js";
import { appendRunEventAt, createRun, getItemWatch, getRun, listCommentsForItem, listItemWatches, listTransitionsForItem, updateRun, type ItemWatch } from "../db/repos/index.js";
import { watchStayOf } from "../db/repos/itemWatchesRepo.js";
import { ownerOfItem } from "../policy/personBudget.js";

/**
 * Keep checking, the host's half (EO-456, ARCHITECTURE.md, "A step",
 * "Guardrails").
 *
 * The engine decides from facts; this is where the facts are read. A
 * watch is a row in `item_watches`, and a row is only the watch for the
 * item *now* if it belongs to the move that brought the item onto the
 * step — an item that left and came back is watched afresh, with a new
 * clock and no news posted.
 */

/**
 * The reason on a transition a watch made (EO-456).
 *
 * How the round-trip guardrail tells a watch's moves from every other
 * one: the moves are counted by it, so it is a constant rather than a
 * sentence somebody might reword.
 */
export const WATCH_ROUTED_REASON = "a step that keeps checking reported a result";

/**
 * The reason on a move a watch made because its workspace could not
 * confirm what the check reported — the `verification_failed` route.
 *
 * Its own words, because the timeline should say what happened, and
 * counted with the one above: a check the workspace keeps refusing sends
 * the item round exactly as one that keeps reporting a failure does.
 */
export const WATCH_VERIFICATION_FAILED_REASON = "a step that keeps checking reported a result its workspace could not confirm";

/** Every reason a move made by a watch carries — what the round-trip guardrail counts. */
const WATCH_REASONS: ReadonlySet<string> = new Set([WATCH_ROUTED_REASON, WATCH_VERIFICATION_FAILED_REASON]);

/**
 * The move that brought the item onto the step it stands on: the id of
 * the latest transition into it, or a stable name for an item that has
 * stood there since it was created.
 */
export function watchArrival(db: Db, item: Pick<Item, "id" | "stepId">): string {
  return watchStayOf(db, item);
}

/** The item's watch on this step, if it is the watch for the item's current stay there. */
export function currentWatch(db: Db, item: Pick<Item, "id" | "stepId">, stepId: string): ItemWatch | undefined {
  const row = getItemWatch(db, item.id, stepId);
  if (row === undefined || item.stepId !== stepId) return undefined;
  return row.initiationId === watchArrival(db, item) ? row : undefined;
}

/** What a check that is still waiting says when it gave no detail of its own (EO-618). */
export function waitingLine(detail: string): string {
  return detail.trim() === "" ? "Still waiting." : detail;
}

/**
 * Writes a check that answered `waiting` with nothing new (EO-618,
 * ARCHITECTURE.md, "A step"): one `output` line on the run holding this
 * stay's quiet checks, which the first of them makes.
 *
 * That run is a record rather than work, and two things about its row
 * keep it out of everything that decides anything:
 *
 * - **`succeeded` from the start.** `queued` or `running` would count as
 *   active between checks: the item blocked as `run_active`, its moves
 *   refused, and a concurrency slot spent on a wait.
 * - **`started_at` stays null.** Every order over an item's runs puts such
 *   a run behind all that started, so a park, a retry's backoff and the
 *   initiation of a retry all still read the same newest run they read
 *   before it existed — and `result` stays null, so it is not what the item
 *   shipped. `ended_at` is the last check, which is what the Runs tab sorts
 *   it by.
 *
 * One run across every device too (`quietRunId`), because the watch row
 * reaches the next device before this run does, so whoever checks next may
 * hold none of it, or only part. Each line is numbered from `leasedAt`, when
 * the record granted the lease this check ran under (`appendRunEventAt`): a
 * grant has one clock and happens once, so no two devices share a number
 * however far apart their clocks are, and the lines read in the order the
 * checks ran.
 */
export function recordQuietCheck(
  db: Db,
  check: { itemId: Uuid; stepId: string; action: string; provider: "builtin" | "module"; stay: string; detail: string; at: number; leasedAt: number },
): { run: Run; created: boolean } {
  const id = quietRunId(check.itemId, check.stay);
  const existing = getRun(db, id);
  const run = existing ?? createRun(db, { id, itemId: check.itemId, agentId: null, action: check.action, stepId: check.stepId, status: "succeeded", provider: check.provider });
  appendRunEventAt(db, run.id, { seq: check.leasedAt, ts: check.at }, "output", { type: "output", text: waitingLine(check.detail) });
  return { run: updateRun(db, run.id, { endedAt: check.at }), created: existing === undefined };
}

/** Whether a check on this stay answered `waiting` with nothing new, which is the one answer that leaves no run of its own. */
export function hasQuietCheck(db: Db, itemId: Uuid, stay: string): boolean {
  return getRun(db, quietRunId(itemId, stay)) !== undefined;
}

/**
 * The id of the run holding one stay's quiet checks: worked out from the
 * stay rather than minted, so two devices that have not heard of each
 * other's run still name the same one, and the item and the stay put it on
 * no other run. An item that leaves the step and comes back is on a new
 * stay, so it gets a new run.
 *
 * A UUIDv7 in shape, taking its time from the id of the stay's own
 * transition (or the item, for a stay with none), because ids are what
 * `listRunsForItem` orders on: it sorts from when the stay began.
 */
function quietRunId(itemId: Uuid, stay: string): Uuid {
  const began = (stay.startsWith("initial:") ? itemId : stay).replaceAll("-", "").slice(0, 12);
  const hash = createHash("sha256").update(`quiet-checks:${itemId}:${stay}`).digest("hex");
  return `${began.slice(0, 8)}-${began.slice(8)}-7${hash.slice(0, 3)}-8${hash.slice(3, 6)}-${hash.slice(6, 18)}` as Uuid;
}

/**
 * Items on a step that keeps checking that are held between checks, with
 * when the next check is due and when the watch gives up
 * (`EligibilityInput.watchingUntil`).
 *
 * Held only while *both* moments are still ahead. The deadline is a
 * reason to wake the watch on its own: a step that checks once a day and
 * gives up after an hour must give up on the hour, not at the next day's
 * check — and the same goes for a deadline that falls inside a failing
 * check's backoff. The check that wakes then parks the item without
 * asking anything (`runWatchCheck` asks the deadline before whether a
 * check is due).
 *
 * A watch that never gives up (EO-571) has no deadline to wake it, so it
 * is held until its next check alone, however long ago it started.
 *
 * Read from the watch rows rather than from every item, because this is
 * asked on every tick and almost nothing is watching. A row for a step
 * the item has left, or for an earlier stay on this one, holds nothing:
 * the item is due the moment it arrives.
 */
export function watchingUntil(
  db: Db,
  items: readonly Item[],
  stepFor: (item: Item) => PipelineStep | undefined,
  now: number,
): Map<string, { nextCheckAt: number; giveUpAt: number | null }> {
  const held = new Map<string, { nextCheckAt: number; giveUpAt: number | null }>();
  const watches = listItemWatches(db).filter((watch) => watch.nextCheckAt > now);
  if (watches.length === 0) return held;
  const byId = new Map(items.map((item) => [item.id as string, item]));
  for (const watch of watches) {
    const item = byId.get(watch.itemId);
    if (!item || item.stepId !== watch.stepId) continue;
    const settings = stepFor(item)?.watch;
    if (settings == null) continue;
    const giveUpAt = watchGiveUpAt(settings, watch.startedAt);
    if (giveUpAt !== null && giveUpAt <= now) continue;
    if (watch.initiationId !== watchArrival(db, item)) continue;
    held.set(item.id, { nextCheckAt: watch.nextCheckAt, giveUpAt });
  }
  return held;
}

/**
 * How long after a wake no watch is checked (EO-457): the network is
 * often not back yet, and a check that cannot reach what it checks fails
 * and counts towards the escalation.
 */
export const WAKE_GRACE_MS = 60_000;

/**
 * Whether checks are held right now, and why (EO-457, ARCHITECTURE.md,
 * "A step"): while EO is offline, and for `WAKE_GRACE_MS` after the
 * machine last woke. Null when checks may run.
 *
 * The policy Claude Desktop's scheduled tasks use. A watch that fell
 * due while the machine slept needs nothing more than this: a check
 * schedules the next one from when it ran, so the first check after the
 * hold is the only one an overdue watch gets, however many intervals
 * the sleep spanned.
 */
export function watchHold(online: boolean, lastWakeAt: number | null, now: number): WatchHold | null {
  if (!online) return { reason: "offline" };
  if (lastWakeAt !== null && now < lastWakeAt + WAKE_GRACE_MS) return { reason: "waking", until: lastWakeAt + WAKE_GRACE_MS };
  return null;
}

/**
 * Every item a hold keeps from being checked (`EligibilityInput.watchesHeld`):
 * each one standing on a step that keeps checking, whether or not its
 * watch has started — an item arriving while EO is offline would be
 * checked on arrival, and that check would fail like any other.
 *
 * A rehearsal is left out, because it does not watch (`stepToWatch`).
 */
export function watchesHeld(items: readonly Item[], stepFor: (item: Item) => PipelineStep | undefined, hold: WatchHold | null): Map<string, WatchHold> {
  const held = new Map<string, WatchHold>();
  if (hold === null) return held;
  for (const item of items) {
    if (item.previewAt !== null) continue;
    const step = stepFor(item);
    if (step == null || step.watch == null || (step.type !== "builtin" && step.type !== "module")) continue;
    held.set(item.id, hold);
  }
  return held;
}

/**
 * How many times watches have sent this item to another step since a
 * person last said anything on it (EO-456, the round-trip guardrail).
 *
 * Since the last *human* comment, for the mention-depth guard's reason:
 * a person in the thread is what makes another round legitimate, so any
 * comment at all starts the count again.
 *
 * A route back to the step it left counts too (EO-617). It is a new stay,
 * so the watch starts afresh on the next tick with no interval to wait:
 * nothing else stops that round.
 */
export function watchRoundTrips(db: Db, itemId: Uuid): number {
  const lastHuman = listCommentsForItem(db, itemId)
    .filter((comment) => comment.authorType === "human")
    .reduce((latest, comment) => Math.max(latest, comment.createdAt), Number.NEGATIVE_INFINITY);
  return listTransitionsForItem(db, itemId).filter(
    (transition) => transition.reason !== null && WATCH_REASONS.has(transition.reason) && transition.ts > lastHuman,
  ).length;
}

/**
 * Who a watch that gave up tells: the person the item waits on, else
 * whoever owns its project, else whoever filed it — and where EO knows
 * none of them, the person at this installation, which is what an
 * unnamed human mention resolves to.
 */
export function ownerMention(db: Db, item: Item): MentionTarget {
  const personId = item.assigneeId ?? ownerOfItem(db, item.id) ?? item.createdBy;
  return personId === null ? { type: "human" } : { type: "human", personId };
}

/** The item's watch as the item page draws it, or null when it is not watching (`ItemDetail.watch`). */
export function itemWatchView(db: Db, item: Item, step: PipelineStep | undefined): ItemWatchView | null {
  if (!step || step.watch === null || item.stepId !== step.id) return null;
  const watch = currentWatch(db, item, step.id);
  if (watch === undefined) return null;
  return {
    stepId: watch.stepId,
    startedAt: watch.startedAt,
    lastCheckedAt: watch.lastCheckedAt,
    nextCheckAt: watch.nextCheckAt,
    giveUpAt: watchGiveUpAt(step.watch, watch.startedAt),
    checks: watch.checks,
    consecutiveFailures: watch.consecutiveFailures,
    lastError: watch.lastError,
  };
}
