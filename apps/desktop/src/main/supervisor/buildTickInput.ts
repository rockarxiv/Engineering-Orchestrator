import type { Item, Uuid } from "@eo/core";
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
  listHeldItemIds,
  listItemsIncludingArchived,
  listPipelineSteps,
  listRunsFailedSince,
  listRunsForItem,
  listTransitionsForItem,
  stepForItem,
  stepsByItemVersion,
  trialItemsInRunningLoops,
} from "../db/repos/index.js";
import { archivedProjectOf, itemsMidAdoption, itemsOnArchivedProjects } from "../db/repos/projectsRepo.js";
import { parkedForMissingCriteria } from "./reviewCriteria.js";
import type { GateRefusal, ItemBlocker, ProjectArchived } from "./dispatchBlockers.js";
import { watchesHeld, watchingUntil } from "./watches.js";

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
  };
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
 * resolved to the names a person reads (EO-776, `WaitingOnDependency`).
 * Every other reason passes through as it is.
 *
 * Wherever EO turns the engine's `dispatchBlocker` into words, it goes
 * through here first: the engine has ids and no database.
 */
export function namedBlocker(db: Db, blocker: DispatchBlocker<GateRefusal>): ItemBlocker;
export function namedBlocker(db: Db, blocker: DispatchBlocker<GateRefusal> | null): ItemBlocker | null;
export function namedBlocker(db: Db, blocker: DispatchBlocker<GateRefusal> | null): ItemBlocker | null {
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
    ...(scheduling.capacityKeyOf ? { capacityKeyOf: scheduling.capacityKeyOf } : {}),
    ...(trialsFirst ? { firstInLine: trialItemsInRunningLoops(db) } : {}),
  };
}
