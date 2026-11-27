import type { Item, Uuid } from "@eo/core";
import { touchesHoldsOver, touchesOf } from "@eo/engine";
import type { CapacityKeyOf, DispatchBlocker, DispatchGate, EligibilityInput, TickInput, WatchHold } from "@eo/engine";
import type { Db } from "../db/client.js";
import {
  gateArrivals,
  getItem,
  getStep,
  listActiveRuns,
  listAgents,
  listAllDependencies,
  listAwaitingInputItemIds,
  listDispatches,
  listHeldItemIds,
  listLegacyDispatches,
  listItemsIncludingArchived,
  listPipelineSteps,
  listRunsFailedSince,
  listRunsForItem,
  listTransitionsForItem,
  setInferredDispatch,
  stepForItem,
  stepsByItemVersion,
  trialItemsInRunningLoops,
} from "../db/repos/index.js";
import { archivedProjectOf, itemsMidAdoption, itemsOnArchivedProjects } from "../db/repos/projectsRepo.js";
import { parkedForMissingCriteria } from "./reviewCriteria.js";
import type { GateRefusal, ItemBlocker, ProjectArchived, WaitingOnOverlap } from "./dispatchBlockers.js";
import { watchesHeld, watchingUntil } from "./watches.js";
import { isSignInStop } from "./runtimeBlocks.js";

/**
 * What the installed packs contribute to a scheduling decision
 * (KAN-161).
 *
 * Both optional, and both absent is the core with no pack installed:
 * nothing is bucketed, so the global cap alone applies, and nothing is
 * gated, so the engine's own reasons are the only ones an item can be
 * turned away for. `createEngine` folds these out of the packs and the
 * supervisor passes them through on every tick.
 */
export interface PackScheduling {
  capacityKeyOf?: CapacityKeyOf;
  dispatchGate?: DispatchGate<GateRefusal>;
}

const NO_ROLES: ReadonlySet<string> = new Set();

/**
 * The half of `tick()`'s input that decides *whether* an item may be
 * dispatched (EO-135).
 *
 * Separate from `buildTickInput` because it has a second caller that
 * has no business knowing the concurrency caps: the code that has to
 * explain, on the item, why nothing is going to pick it up. Reading
 * the same rows for the same question keeps that explanation and the
 * scheduler's own decision from drifting apart.
 */
export function buildEligibilityInput(
  db: Db,
  paused: boolean,
  scheduling: PackScheduling = {},
  now: number = Date.now(),
  /** `perItemAttemptLimit`: a failure that spent the last attempt is not waited out, because nothing is retried after it. */
  attemptLimit: number = Number.POSITIVE_INFINITY,
  /** Whether checks are held because EO is offline or just woke (`watchHold`, EO-457). Null, the default, holds nothing. */
  watchHold: WatchHold | null = null,
  /** The roles `paused` does not hold (EO-615). Nobody, the default. */
  pauseExemptRoles: ReadonlySet<string> = NO_ROLES,
): EligibilityInput<GateRefusal> {
  /**
   * Work whose project is half way between two databases (EO-325).
   *
   * Never a candidate, on either side of the transfer and for the same
   * reason: the record has some of this project and the machine sending
   * it still has all of it, so a dispatch from either would be a second
   * writer on an item whose thread, runs and acceptance criteria may be
   * somewhere else. Filtered here rather than in `listItems`, because
   * this is about *scheduling* and not about what an item is — every
   * screen still shows it, and the person who pressed Move still sees
   * their board.
   */
  const moving = itemsMidAdoption(db);
  /**
   * Every item there is, archived ones included (EO-335).
   *
   * Not the candidate list — that is `items` below — but what a
   * dependency edge is allowed to resolve against. `listAllDependencies`
   * is unfiltered, so an edge outlives the archiving of the item it
   * points at; resolving those edges against the *live* list alone made
   * the lookup miss, and a miss used to mean "has not finished". Which
   * turned finishing a story and letting it be swept into the Archive
   * into a permanent deadlock for everything waiting on it.
   */
  const everyItem = listItemsIncludingArchived(db);
  /**
   * Work on a project somebody put away (EO-347).
   *
   * Paused, and paused by being left out here rather than by anything
   * written on the items: nothing sets `heldAt`, so the hold below is
   * still exactly the set of items a *person* held, and restoring the
   * project — clearing one column — puts every other item back in front
   * of the scheduler on the step it never left. Beside `heldItemIds`
   * in spirit and not in the set itself, because the explanation has to
   * differ: `archivedProjectBlocker` names the project where a hold
   * would only say "on hold".
   *
   * Still in `dependencyItems`, like every item hidden from the
   * scheduler: an item elsewhere waiting on one of these is waiting on
   * whether it finished, and archiving its project did not finish it.
   */
  const shelved = itemsOnArchivedProjects(db);
  const items = everyItem.filter((item) => item.archivedAt === null && !moving.has(item.id) && !shelved.has(item.id));
  const steps = listPipelineSteps(db);
  const stepsByItem = stepsByItemVersion(db, everyItem);
  // The step each item is dispatched by — its own version's where it has
  // one — for the one question below that needs it: whether the step it
  // stands on keeps checking (EO-456).
  const liveSteps = new Map(steps.map((step) => [step.id, step]));
  const stepFor = (item: Item) => stepsByItem.get(item.id) ?? (item.stepId === null ? undefined : liveSteps.get(item.stepId));
  const deps = listAllDependencies(db);
  return {
    items,
    deps,
    // Where each `reached` edge's dependency has ever arrived (EO-776),
    // read from `transitions` here because the engine reads no table.
    arrivals: gateArrivals(db, deps),
    dependencyItems: everyItem,
    steps,
    // What each item finishing on an older version must be dispatched
    // by (EO-327, ARCHITECTURE.md, "Publish, lock and versions"). Empty for a board nobody has
    // edited since its
    // work started, which is the ordinary case and costs one pass over
    // the items; for the rest it is what makes "an item finishes on the
    // version it entered on" true of the *run* and not only of the
    // route it takes afterwards. A step whose type or role a later save
    // changed would otherwise stop dispatching for work already
    // standing on it.
    stepsByItem,
    agents: listAgents(db),
    activeRuns: listActiveRuns(db),
    awaitingInput: schedulingParks(db),
    heldItemIds: listHeldItemIds(db),
    // Where each item has worked (EO-912): an item in flight there holds
    // back one about to work there for the first time whose `touches`
    // overlap its own.
    // Finished items are left out: they hold nothing and wait for nothing.
    // Proven places and places only believed (`claimedIn`) apart: the
    // second hold others back but let nobody past.
    ...dispatchedPlaces(
      db,
      items.filter((item) => stepFor(item)?.isTerminal !== true),
      scheduling.capacityKeyOf,
    ),
    retryAfter: retryBackoffs(db, items, now, attemptLimit),
    // Between one check of a step that keeps checking and the next
    // (EO-456). A check that came back waiting left no active run, so
    // nothing else here would hold the item.
    watchingUntil: watchingUntil(db, items, stepFor, now),
    // No check at all while offline or just after a wake (EO-457).
    watchesHeld: watchesHeld(items, stepFor, watchHold),
    paused,
    pauseExemptRoles,
    ...(scheduling.dispatchGate ? { dispatchGate: scheduling.dispatchGate } : {}),
    // The bucket is also where an item's `touches` are paths in (EO-912),
    // so the explanation of a hold needs it as much as the tick does.
    ...(scheduling.capacityKeyOf ? { capacityKeyOf: scheduling.capacityKeyOf } : {}),
  };
}

/**
 * Where each of `items` declaring `touches` is in flight (EO-912), as the
 * scheduler's `dispatchedIn` and `claimedIn` take them, derived from the
 * item's runs on every ask and never stored.
 *
 * `dispatchedIn` is what is proven: a run the supervisor stamped as it
 * was made (`runs.dispatched_in`, basis `stamped`, `dispatchPlace`) says
 * the bucket the item was in at that step as its own version then
 * defined it. Not the bucket of the step it stands on now, nor of the
 * version it is bound to now: an item whose work moved on to a step
 * that picks no disk, or that was moved to a version whose step works
 * somewhere else, still has its changes where it made them, and an item
 * that only drafted on no disk has made none anywhere.
 *
 * `claimedIn` is what is believed without proof, which holds others
 * back but never lets the item past: a run from before the stamp, read
 * once by the item's own definition of the step as it stood at the first
 * start after the stamp came in (`freezeLegacyDispatches`, basis
 * `inferred`) and kept as read; one of those not read yet (`legacy`);
 * and a run with no basis at all — a run from another machine, say —
 * read here, by the item's own definition of the step, as a dispatch
 * where its action is that step's entry action and in the bucket that
 * definition picks. Every other unstamped run (a reply to a mention, a
 * discussion) is not a dispatch.
 *
 * A dispatch with no bucket adds nothing, and an item with no bucket at
 * all is left out of both. Without a bucket function every place is the
 * one place, the engine's own reading of an absent `capacityKeyOf`.
 */
export function dispatchedPlaces(db: Db, items: readonly Item[], capacityKeyOf: CapacityKeyOf | undefined): DispatchedPlaces {
  const dispatchedIn = new Map<string, Set<string>>();
  const claimedIn = new Map<string, Set<string>>();
  const touching = items.filter((item) => touchesOf(item).length > 0);
  if (touching.length === 0) return { dispatchedIn, claimedIn };
  const dispatches = listDispatches(db, touching.map((item) => item.id));
  for (const item of touching) {
    const runs = dispatches.get(item.id);
    if (runs === undefined) continue;
    const proven = new Set<string>();
    const claimed = new Set<string>();
    for (const run of runs) {
      const places =
        run.basis === "stamped" || run.basis === "inferred"
          ? (run.dispatchedIn ?? [])
          : placesByDefinition(db, item, run.stepId, run.action, capacityKeyOf);
      for (const place of places) (run.basis === "stamped" ? proven : claimed).add(capacityKeyOf ? place : "");
    }
    for (const place of proven) claimed.delete(place);
    if (proven.size > 0) dispatchedIn.set(item.id, proven);
    if (claimed.size > 0) claimedIn.set(item.id, claimed);
  }
  return { dispatchedIn, claimedIn };
}

/** `dispatchedPlaces`' answer: places proven, and places only believed. */
export interface DispatchedPlaces {
  dispatchedIn: Map<string, Set<string>>;
  claimedIn: Map<string, Set<string>>;
}

/**
 * Where a run at `stepId` of `action` was dispatched, as the item's own
 * definition of that step reads now (EO-912): `[]` where it was not the
 * step's entry action or picks no shared disk. A reconstruction, so only
 * ever a claim — see `dispatchedPlaces`.
 */
function placesByDefinition(db: Db, item: Item, stepId: string, action: string, capacityKeyOf: CapacityKeyOf | undefined): string[] {
  const place = placeByDefinition(db, item, stepId, action, capacityKeyOf);
  return place === null || place === undefined ? [] : [place];
}

/** The bucket, null for no shared disk, or undefined where the run was not the step's own entry action. */
function placeByDefinition(db: Db, item: Item, stepId: string, action: string, capacityKeyOf: CapacityKeyOf | undefined): string | null | undefined {
  const asDispatched = { ...item, stepId: stepId as Item["stepId"] };
  if (stepForItem(db, asDispatched)?.entryAction !== action) return undefined;
  return capacityKeyOf ? capacityKeyOf(asDispatched) : "";
}

/**
 * Reads, once, every run from before the stamp (EO-912, basis `legacy`,
 * migration 0187) by the item's own definition of the step as it stands
 * now, and writes the reading down (`inferred`), so that no later move
 * to another version, edit of the step or change of workspace can read
 * it again differently — the reviewer's case was a holder moved to a
 * version whose step picks no disk, which read now would have stopped
 * holding anything.
 *
 * Called as the supervisor starts, before anything can move an item:
 * the first start after the migration is the moment the definition
 * that went with these runs is likeliest to still be the one in force.
 * Still a reconstruction — an item moved before the upgrade is read by
 * where it stands — and so a claim, never proof (`dispatchedPlaces`).
 * A run of an item that is gone is left as it is. Returns how many runs
 * it read.
 */
export function freezeLegacyDispatches(db: Db, capacityKeyOf: CapacityKeyOf | undefined): number {
  const legacy = listLegacyDispatches(db);
  if (legacy.length === 0) return 0;
  const itemsById = new Map<string, Item | undefined>();
  let read = 0;
  db.transaction(() => {
    for (const run of legacy) {
      if (!itemsById.has(run.itemId)) itemsById.set(run.itemId, getItem(db, run.itemId));
      const item = itemsById.get(run.itemId);
      if (item === undefined) continue;
      const place = placeByDefinition(db, item, run.stepId, run.action, capacityKeyOf);
      setInferredDispatch(db, run.id, place === undefined ? null : place === null ? [] : [place]);
      read += 1;
    }
  });
  return read;
}

/**
 * Each of `listed` that the overlap hold keeps back (EO-912), with its
 * holder named — what a card says in place of a pack's refusal.
 *
 * The engine's own `touchesHoldsOver`, over the facts the scheduler's
 * input reads them from: the same candidates, steps, edges and arrivals,
 * the same in-flight rule (`dispatchedPlaces`, on a step of its own
 * version that is not terminal) and the same bucket, so the rings it
 * breaks and the pairs dependencies exempt are the tick's. Reads nothing
 * more than an item list when no listed item declares `touches`.
 */
export function touchesHoldsOf(db: Db, listed: readonly Item[], capacityKeyOf: CapacityKeyOf | undefined): Map<string, WaitingOnOverlap> {
  const holds = new Map<string, WaitingOnOverlap>();
  if (!listed.some((item) => touchesOf(item).length > 0)) return holds;

  const moving = itemsMidAdoption(db);
  const shelved = itemsOnArchivedProjects(db);
  const everyItem = listItemsIncludingArchived(db);
  const candidates = everyItem.filter((item) => item.archivedAt === null && !moving.has(item.id) && !shelved.has(item.id));
  const candidateIds = new Set(candidates.map((item) => item.id));
  const steps = listPipelineSteps(db);
  const liveSteps = new Map(steps.map((step) => [step.id, step]));
  const stepsByItem = stepsByItemVersion(db, everyItem);
  const stepFor = (item: Item) => stepsByItem.get(item.id) ?? (item.stepId === null ? undefined : liveSteps.get(item.stepId));
  const deps = listAllDependencies(db);
  const overlap = touchesHoldsOver({
    items: candidates,
    deps,
    arrivals: gateArrivals(db, deps),
    dependencyItems: everyItem,
    steps,
    stepsByItem,
    // Unfinished only, as the tick's: a finished item holds nothing and waits for nothing.
    ...dispatchedPlaces(
      db,
      candidates.filter((item) => stepFor(item)?.isTerminal !== true),
      capacityKeyOf,
    ),
    ...(capacityKeyOf ? { capacityKeyOf } : {}),
  });
  const keys = new Map(candidates.map((item) => [item.id as string, item.key]));
  for (const item of listed) {
    if (!candidateIds.has(item.id)) continue;
    const hold = overlap.holdOf(item);
    if (hold) holds.set(item.id, { kind: "touches_overlap", ...hold, holderKey: keys.get(hold.holderId) ?? hold.holderId });
  }
  return holds;
}

/**
 * How long a failed run's retry waits, by the attempt that failed.
 *
 * A failed run is retried inside its initiation until the attempt limit
 * (`perItemAttemptLimit`), and that retry used to start on the very next
 * tick: a backend crashing on start spent every attempt in about fifteen
 * seconds, faster than anybody could look. Growing waits give a passing
 * fault — a network blip, a rate limit, an overloaded API — time to
 * clear, and give a person time to see the first failure before the
 * last. The last entry repeats for any attempt past it.
 */
export const RETRY_BACKOFF_MS = [30_000, 120_000, 480_000] as const;

export function retryBackoffFor(attempt: number): number {
  return RETRY_BACKOFF_MS[Math.min(Math.max(attempt, 1), RETRY_BACKOFF_MS.length) - 1]!;
}

/**
 * Items whose last run failed and whose retry is not due yet, with when
 * it is (`EligibilityInput.retryAfter`).
 *
 * Exactly the runs `workflowInitiationId` retries inside their own
 * initiation: the item's latest run failed, and the item has not
 * entered its step since — a move, or review sending it back, starts a
 * new initiation and owes nothing to the failure before it. Read from
 * the few runs that failed within the longest wait, not from every
 * item's history, because this is asked on every tick.
 */
function retryBackoffs(db: Db, items: Item[], now: number, attemptLimit: number): Map<string, number> {
  const due = new Map<string, number>();
  const longest = RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
  const failures = listRunsFailedSince(db, now - longest);
  if (failures.length === 0) return due;
  const candidates = new Map(items.map((item) => [item.id as string, item]));
  const steps = new Map(listPipelineSteps(db).map((step) => [step.id, step]));
  for (const failed of failures) {
    if (due.has(failed.itemId) || failed.endedAt === null) continue;
    // The last attempt's failure is answered by the attempt limit's
    // escalation, on the next tick, not by a wait for a retry that will
    // never come.
    if (failed.attempt >= attemptLimit) continue;
    // A run its backend's sign-in stopped (EO-797) is not retried: the
    // runtime's block holds the item, and it goes as soon as that lifts.
    if (isSignInStop(failed.error)) continue;
    // Only the step's own automatic run is retried in its initiation: a
    // failed reply, discussion or interpretation is no reason to hold
    // back the step's next dispatch, which is a different piece of work.
    const item = candidates.get(failed.itemId);
    const step = item?.stepId ? steps.get(item.stepId) : undefined;
    if (!item || !step || failed.stepId !== item.stepId || step.entryAction !== failed.action) continue;
    // A failed check on a step that keeps checking waits on its own
    // backoff, which its watch row holds (EO-456); this one is for a run
    // that is retried once.
    if (step.watch !== null) continue;
    const until = failed.endedAt + retryBackoffFor(failed.attempt);
    if (until <= now) continue;
    // Refusal placeholders are not runs of the step (`isGuardPlaceholder`).
    const latest = listRunsForItem(db, failed.itemId)
      .filter((run) => !(run.status === "awaiting_input" && run.threadId === null))
      .sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0) || left.id.localeCompare(right.id))
      .at(-1);
    if (latest?.id !== failed.id) continue;
    const entered = listTransitionsForItem(db, failed.itemId).at(-1);
    if (entered && entered.ts >= failed.endedAt) continue;
    due.set(failed.itemId, until);
  }
  return due;
}

/**
 * The parks the scheduler is meant to respect (EO-213).
 *
 * Every parked run but one is waiting on something only a person can
 * supply, and holding the item still is the whole point of the park.
 * The exception is EO's own refusal to review an item that declares no
 * acceptance criteria: what that is waiting for is a criterion, EO reads
 * criteria on every tick, and `no_acceptance_criteria` already holds the
 * item while there are none. Left in, the park would outlive its own
 * reason — a person who added the criterion the escalation asked for
 * would watch nothing happen, which is the failure this whole change is
 * about.
 *
 * Filtered here rather than in `listAwaitingInputItemIds` because it
 * is not a fact about the runs table: "waiting for a reply" is still
 * exactly what that row says, and the resume path is still what answers
 * it. This is only about which of those the scheduler must stand off
 * for.
 */
function schedulingParks(db: Db): Set<Uuid> {
  const parked = listAwaitingInputItemIds(db);
  for (const itemId of parked) {
    if (parkedForMissingCriteria(db, itemId)) parked.delete(itemId);
  }
  return parked;
}

/**
 * Why this item is not moving, when the reason is its project (EO-347).
 *
 * Asked ahead of the engine's own `dispatchBlocker` wherever EO has to
 * explain an item, because the engine cannot give this answer: the
 * item is not in its input at all, and an item it has never heard of
 * reads as `unknown_step` — "not sitting on a step an agent is
 * dispatched at", about an item that is sitting on exactly such a step
 * and would be dispatched there the moment the project came back.
 *
 * Kept out of `packages/engine` for the reason `RerunBlocker`'s own
 * reasons are: it is a fact about what this installation has put away,
 * decided before the scheduler is asked anything.
 */
export function archivedProjectBlocker(db: Db, itemId: Uuid): ProjectArchived | null {
  const project = archivedProjectOf(db, itemId);
  return project ? { kind: "project_archived", projectName: project.name } : null;
}

/**
 * The scheduler's answer about an item, with an open dependency's ids
 * resolved to the names a person reads (EO-776, `WaitingOnDependency`),
 * and an overlap hold's holder to its key (EO-912, `WaitingOnOverlap`).
 * Every other reason passes through as it is.
 *
 * Wherever EO turns the engine's `dispatchBlocker` into words, it goes
 * through here first: the engine has ids and no database.
 */
export function namedBlocker(db: Db, blocker: DispatchBlocker<GateRefusal>): ItemBlocker;
export function namedBlocker(db: Db, blocker: DispatchBlocker<GateRefusal> | null): ItemBlocker | null;
export function namedBlocker(db: Db, blocker: DispatchBlocker<GateRefusal> | null): ItemBlocker | null {
  if (blocker?.kind === "touches_overlap") {
    return { ...blocker, holderKey: getItem(db, blocker.holderId as Uuid)?.key ?? blocker.holderId };
  }
  if (blocker?.kind !== "open_dependency") return blocker;
  const dependency = getItem(db, blocker.dependsOnId as Uuid);
  return {
    ...blocker,
    dependencyKey: dependency?.key ?? blocker.dependsOnId,
    nowAt: dependency === undefined ? null : (stepForItem(db, dependency)?.name ?? null),
    gateStepName: blocker.waitStepId === null ? null : (getStep(db, blocker.waitStepId)?.name ?? null),
  };
}

/** Assembles tick()'s pure input from the current DB state. */
export function buildTickInput(
  db: Db,
  limits: TickInput["limits"],
  paused: boolean,
  scheduling: PackScheduling = {},
  now: number = Date.now(),
  attemptLimit: number = Number.POSITIVE_INFINITY,
  watchHold: WatchHold | null = null,
  /**
   * The `trialsFirst` guardrail (EO-582): whether the trial items whose
   * conversation is still testing a draft are offered a slot before live
   * work. Off, the default here, orders everything by priority and age.
   */
  trialsFirst = false,
  pauseExemptRoles: ReadonlySet<string> = NO_ROLES,
  /** The roles the concurrency caps do not hold (EO-616). Nobody, the default. */
  uncappedRoles: ReadonlySet<string> = NO_ROLES,
): TickInput<GateRefusal> {
  return {
    ...buildEligibilityInput(db, paused, scheduling, now, attemptLimit, watchHold, pauseExemptRoles),
    limits,
    uncappedRoles,
    ...(trialsFirst ? { firstInLine: trialItemsInRunningLoops(db) } : {}),
  };
}
