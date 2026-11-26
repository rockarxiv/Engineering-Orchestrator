import { stepAgentKind, stepAgentOf, stepAgentRefusal } from "@eo/core";
import type { Agent, DependencyWait, Run, Item, PipelineStep, StepAgentRefusal } from "@eo/core";
import { touchesOf, touchesOverlap, type Edge } from "./dag.js";

/**
 * A dependency edge as the scheduler reads it: the pair, and the rule
 * that releases the waiting item (EO-776, `DependencyWait`).
 *
 * Both optional, and absent is `finished` — what every edge meant before
 * the rule existed, so a caller that knows nothing of it schedules
 * exactly as it always did. A `reached` edge with no step can never be
 * met, and reads as `finished` too rather than holding for ever.
 */
export interface DependencyEdge extends Edge {
  wait?: DependencyWait;
  waitStepId?: string | null;
}

export interface Dispatch {
  item: Item;
  /**
   * The agent to run, or null on a `builtin` step — EO runs one of its own
   * functions there, so there is no role to staff and no agent to pick.
   */
  agent: Agent | null;
  action: string;
  /**
   * The step this dispatch came from.
   *
   * Carried rather than re-derived because the reverse lookup does not
   * work: nothing forbids two steps in one pipeline naming the same
   * `entryAction`, so an action cannot identify a step, and the manual
   * actions (`respond`, `discuss`, `configure`) name no step at all.
   * The run row records it, which is what lets a comment written during
   * that run be attributed to the step it was written at.
   */
  stepId: string;
}

/**
 * Why *this* step may not run against *this* item, according to whoever
 * installed the pack (ARCHITECTURE.md, "The core is domain-neutral", KAN-161).
 *
 * The engine's own reasons are the closed list in `DispatchBlocker`
 * below, and every one of them is a fact about scheduling: a step
 * nobody acts at, a dependency that has not finished, a role nobody
 * holds. What a *kind of work* additionally requires before it can be
 * judged — a story declaring acceptance criteria before a review — is
 * not a scheduling fact, and the engine cannot know it without knowing
 * what an installation is about.
 *
 * So it arrives as a function, and its answer travels as the blocker it
 * is: `kind` is the caller's own string, and the caller is what turns it
 * back into words for the person (invariant #8). The engine only ever
 * carries it.
 */
export interface DispatchRefusal {
  readonly kind: string;
}

/**
 * The gate itself. `null` is "nothing of mine stands in the way".
 *
 * Asked once per item per tick, after the engine's own standing facts
 * and before the staffing question — see `blockerFor`, which is where
 * the order is argued.
 */
export type DispatchGate<R extends DispatchRefusal = DispatchRefusal> = (item: Item, step: PipelineStep) => R | null;

/**
 * Which capacity bucket an item's run consumes, or `null` for none.
 *
 * The engine caps concurrency per bucket without knowing what a bucket
 * *is*: the developer pack answers with the repository, because two
 * agents in one checkout is the collision that matters there, and a pack
 * whose work touches nothing shared answers `null` and is capped by the
 * global limit alone. Equal strings share a bucket; that is the whole of
 * the contract.
 */
export type CapacityKeyOf = (item: Item) => string | null;

/**
 * Everything `tick()` needs to decide *whether* an item may be
 * dispatched, as opposed to whether there is room to dispatch it now.
 *
 * Split out from `TickInput` because the two questions have different
 * answers and different audiences (EO-135). "Is this item eligible"
 * is a standing fact about the item — its step, its dependencies, its
 * hold — and a person asking why nothing happened is owed that answer.
 * "Is there a free slot" is a fact about the rest of the board a moment
 * ago, and it is not a reason for anything: the next tick offers the
 * item again. Only the first half needs `limits`, so only the first
 * half asks for it.
 */
export interface EligibilityInput<R extends DispatchRefusal = DispatchRefusal> {
  items: Item[];
  deps: DependencyEdge[];
  /**
   * The steps each dependency of a `reached` edge has ever arrived at,
   * keyed by the dependency's id (EO-776).
   *
   * Worked out by the host from `transitions`, which is append-only, for
   * the gated edges only: this package reads no table (invariant #2).
   * That is what makes the release latch — once an arrival is recorded
   * it is recorded for good, so the dependency going back to an earlier
   * step does not hold the waiting item again. Absent, or a dependency
   * missing from it, is "has arrived nowhere", which leaves a `reached`
   * edge holding until its dependency finishes.
   */
  arrivals?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Every item a `deps` edge may point *at* — including the ones
   * `items` deliberately leaves out (EO-335).
   *
   * `items` is the dispatch candidates, and the caller narrows it:
   * archived work is gone from the project (KAN-33) and work whose
   * project is half way between two databases must not be touched by
   * either (EO-325). `deps` is narrowed by neither, so an edge outlives
   * the item it points at — and the item lookup missing used to read as
   * "has not finished", which is the one answer there is no way back
   * from. Finishing an item and letting it be archived deadlocked
   * everything waiting on it, permanently.
   *
   * So dependencies resolve against this instead. Absent means "the
   * same set", which is what a caller with nothing hidden should pass —
   * every engine test, and any host that filters nothing.
   *
   * It does not change what *finished* means: the dependency is still
   * read through `stepFor` and still has to be standing on a terminal
   * step of its own pipeline. An archived item that never finished goes
   * on blocking, and an item mid-transfer goes on blocking, because
   * both are still here and neither is done.
   */
  dependencyItems?: Item[];
  /**
   * Items whose last run failed recently, and when each may be retried
   * (epoch ms).
   *
   * Worked out by the host, which has a clock, from the item's runs: a
   * failed run is retried in the same initiation, and starting that
   * retry on the very next tick turns a crash into a loop that spends
   * every attempt within seconds. Absent means none is waiting.
   */
  retryAfter?: ReadonlyMap<string, number>;
  /**
   * Items on a step that keeps checking that are being held between
   * checks, with when the next check is due and when the watch gives up
   * (epoch ms) (EO-456).
   *
   * Worked out by the host from the watch rows, for `retryAfter`'s
   * reason: this package has no clock. A check that came back waiting
   * leaves no run behind, so without this the item would look like any
   * other item on a builtin step with nothing running, and be checked
   * again on the very next tick. The host leaves an item out once
   * *either* moment has arrived — the deadline wakes the watch as surely
   * as the next check does, so that a step checking once a day still
   * gives up on the hour it was told to. Absent means nothing is
   * watching. A null `giveUpAt` is a watch that never gives up (EO-571),
   * held until its next check alone.
   */
  watchingUntil?: ReadonlyMap<string, { nextCheckAt: number; giveUpAt: number | null }>;
  /**
   * Items on a step that keeps checking that may not be checked at all
   * right now, and why (EO-457).
   *
   * A check that cannot reach what it checks fails, and failures count
   * towards the escalation — so a watch checked while the machine is
   * offline, or in the minute after a wake before the network is back,
   * spends its allowance on nothing it did wrong. The host knows both
   * facts and this package knows neither, so the host says which items
   * are held. Absent means none is.
   */
  watchesHeld?: ReadonlyMap<string, WatchHold>;
  /**
   * Every step of every pipeline, flat (KAN-56).
   *
   * Flat rather than pre-grouped because each row already knows its
   * `pipelineId` and the DB hands them over this way; `tick()` does the
   * grouping itself. What matters is that an item is only ever matched
   * against a step of *its own* pipeline — two pipelines may well both
   * have a step at position 3 owned by `implementer`, and dispatching one
   * pipeline's item against the other's step would run the wrong action.
   */
  steps: PipelineStep[];
  /**
   * The step definition an individual item must be dispatched by, where
   * that is not the live one (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
   *
   * Keyed by item id. A miss means "use `steps`", which is every item on
   * its pipeline's current version and every item at all until somebody
   * saves — so an installation that never edits a pipeline schedules
   * exactly as it always did.
   *
   * It is a map rather than a second flat list because `steps` is
   * indexed by `(pipelineId, stepId)`, and two items standing on one
   * step under two versions are two different definitions: one owned by
   * `implementer`, say, and one a person answers. That index cannot hold
   * both, and the difference decides whether the item is dispatched at
   * all.
   *
   * Data rather than a lookup, for `stepsElsewhere`'s reason in
   * `routing.ts`: this package is pure (invariant #2) and cannot go and
   * read a version, so it is told.
   */
  stepsByItem?: ReadonlyMap<string, PipelineStep>;
  agents: Agent[];
  activeRuns: Run[];
  /** itemIds whose last run ended awaiting a reply (ARCHITECTURE.md, "Escalation ends the run") */
  awaitingInput: Set<string>;
  /** itemIds a person manually parked without changing their pipeline step (EO-45) */
  heldItemIds: Set<string>;
  /**
   * Where each item has been dispatched (EO-912): for an item dispatched
   * at least once at a step of its own, the places — buckets, as
   * `capacityKeyOf` answers them — that it worked in, worked out by the
   * host from evidence of each dispatch rather than from the step the
   * item stands on now, since this package reads no table. A dispatch
   * that worked on no shared disk has no place and is not listed.
   *
   * With a step that is not terminal, that is what *in flight in a
   * place* means: work has started there, and whatever it changed is
   * not finished with yet — whichever step the item has gone on to,
   * a step that works on no disk included, since its changes are still
   * where it made them. Such an item holds back, by `touches_overlap`,
   * an item about to work in one of these places for the first time
   * whose `touches` overlap its own (`touchesHolds`). An item is never
   * held in a place it is listed in, whatever it overlaps there, so two
   * that both started there before the rule existed both carry on
   * rather than wait for each other for ever; and an item whose only
   * dispatches worked on no disk has changed nothing anywhere, so it
   * holds nothing and is held at the first place it would work in.
   * Absent is nobody dispatched anywhere, which holds nothing.
   */
  dispatchedIn?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Which bucket each item's run consumes (KAN-161).
   *
   * Absent means nothing is bucketed and the global cap alone applies,
   * which is what a core with no pack installed does.
   *
   * Here rather than on `TickInput` alone because it is also *where an
   * item's `touches` are paths in* (EO-912): two items in one bucket
   * share the place their runs work in, so a path in one names the same
   * file as that path in the other, and two in different buckets do
   * not, however alike their paths read. Absent is one place for
   * everything; an item whose bucket is null stands where nothing is
   * shared, so it is not held there for what it touches. Where an item
   * in flight holds others is `dispatchedIn`'s, not this: the places it
   * worked in, not the one it stands on now.
   */
  capacityKeyOf?: CapacityKeyOf;
  /**
   * The global pause (ARCHITECTURE.md, "Guardrails"): true means no new
   * dispatches, but for an agent step whose agent's kind is in
   * `pauseExemptRoles`.
   */
  paused: boolean;
  /**
   * The kinds a pause does not hold (EO-615). The host names them, because
   * who those are is its business: this package compares them with the
   * kind of the agent a step names and knows nothing else about them. A builtin or
   * module step has nobody to exempt. Absent is nobody.
   */
  pauseExemptRoles?: ReadonlySet<string>;
  /**
   * The installed pack's own reason a step may not run here, if it has
   * one (KAN-161).
   *
   * Optional, and absent is not a gap: a core with no pack installed has
   * nothing to add to the engine's own reasons, and every item the
   * engine would dispatch is dispatched.
   */
  dispatchGate?: DispatchGate<R>;
}

export interface TickInput<R extends DispatchRefusal = DispatchRefusal> extends EligibilityInput<R> {
  /**
   * `perRepositoryConcurrency` caps each capacity bucket independently,
   * so one busy bucket can't starve the others (D-04). Both it and the
   * global cap default to 1 in config, which keeps invariant #10 true out
   * of the box; raising only the global cap is what lets N buckets
   * progress at once while each stays serial.
   *
   * Named for what it caps in the installation EO ships — one bucket per
   * repository — because the name is the caller's contract, in the
   * settings store and on the Settings screen. What decides which bucket
   * an item is in is `capacityKeyOf`, and the engine does not ask.
   */
  limits: { globalConcurrency: number; perAgentConcurrency: number; perRepositoryConcurrency: number };
  /**
   * Global slots held by work that is not a run (EO-477): a side call
   * made on its own — consolidation — holds one while it runs, and one
   * it is queued for, so the slot a finishing run frees goes to it rather
   * than to the next dispatch. Counted against the global cap only: a
   * side call has no agent and touches no workspace.
   *
   * Absent is none, which is every tick before side calls existed.
   */
  reservedSlots?: number;
  /**
   * The kinds none of `limits` holds back (EO-616). An agent step whose
   * agent is of one is dispatched whatever the three caps say, and its run still
   * counts against them for everything else, as any run does. The host
   * names them, as it does `pauseExemptRoles`. A builtin or module step
   * has no role to exempt. Absent is nobody.
   */
  uncappedRoles?: ReadonlySet<string>;
  /**
   * Items the host wants offered a slot before everything else (EO-582).
   *
   * The engine does not know why, and does not need to: the desktop puts
   * here the trial items whose conversation is still testing a draft, so
   * that a loop waiting on one run is not left behind a queue of live
   * work for hours. It changes the order slots are handed out in and
   * nothing else — not the caps, not eligibility, and never a run already
   * going. Within the set, and outside it, the order is the usual one:
   * highest priority, then oldest. Absent is nobody first.
   */
  firstInLine?: ReadonlySet<string>;
}

/**
 * Why an item is not going to be dispatched — when the answer is
 * something about the item rather than something about the moment
 * (EO-135).
 *
 * Every one of these is a standing fact: it will still be true on the
 * next tick, and on every tick after that, until somebody or something
 * changes it. That is deliberately *not* the whole of `tick()`'s skip
 * list. An item that loses a capacity slot is not blocked, it is
 * queuing — the next tick offers it again — and reporting that as a
 * reason would tell a person to go and fix a thing that is already
 * fixing itself.
 *
 * The distinction exists because EO now has to answer "why did nothing
 * happen?" out loud (invariant #8), and an answer that drifts from what
 * the scheduler actually does is worse than no answer at all. So this
 * type and `tick()` are fed by one function, below, rather than by two
 * lists of rules that agree today.
 */
export type DispatchBlocker<R extends DispatchRefusal = DispatchRefusal> =
  /** The global pause is on, and the role this step answers to is not one it lets through. */
  | { kind: "paused" }
  /** No item by that id, or it sits on a step its own pipeline does not have. */
  | { kind: "unknown_step" }
  /** A `user` step or a terminal one: EO was told not to act here. */
  | { kind: "step_not_dispatchable"; stepId: string }
  /**
   * At least one edge out of it still holds (EO-776): its dependency has
   * not finished, and the edge's rule has not released it either.
   *
   * Names the first edge that holds — `dependsOnId`, and the rule it is
   * waiting under, with `waitStepId` the step a `reached` edge waits for
   * and null otherwise — so whoever explains it can say which item and
   * what it is waiting for that item to do. A `none` edge never appears
   * here: it never holds.
   */
  | { kind: "open_dependency"; dependsOnId: string; wait: Exclude<DependencyWait, "none">; waitStepId: string | null }
  /**
   * It has not been dispatched in the place it would work in now, and
   * the paths it declares overlap, by `touchesOverlap`, those of
   * `holderId` — an item in flight in that place (EO-912,
   * `dispatchedIn`, `touchesHolds`). `path` is this item's entry and
   * `holderPath` the holder's it overlaps, which are the same string
   * where both name one file.
   *
   * Lifts by itself once the holder finishes or leaves flight. Derived
   * on every ask from the items themselves, never stored and never an
   * edge: the plan's own dependencies are the only rows there are, and
   * a dependency path between the two either way exempts the pair,
   * because then the edges say how they are ordered.
   */
  | ({ kind: "touches_overlap" } & TouchesHold)
  /** Its most recent run parked waiting for a reply. */
  | { kind: "awaiting_input" }
  /** Somebody parked it by hand. */
  | { kind: "held" }
  /** Something is working on it right now. */
  | { kind: "run_active" }
  /**
   * Its last run failed a moment ago, and the retry waits until `until`
   * (epoch ms) rather than starting on the very next tick.
   */
  | { kind: "retry_backoff"; until: number }
  /**
   * It stands on a step that keeps checking on something outside EO, and
   * the next check is not due until `nextCheckAt` (epoch ms) (EO-456).
   * `giveUpAt` is when the watch stops waiting, which can come first, or
   * null for a watch that never gives up (EO-571).
   */
  | { kind: "watching"; nextCheckAt: number; giveUpAt: number | null }
  /**
   * It stands on a step that keeps checking, and no check may run yet
   * because EO is offline or has only just woken (EO-457, `WatchHold`).
   */
  | ({ kind: "watch_held" } & WatchHold)
  /**
   * The `agent` step names no agent (EO-875), so nobody can run it until
   * somebody chooses one.
   */
  | { kind: "no_agent" }
  /**
   * The agent the step names cannot run this item (EO-875):
   * `stepAgentRefusal`'s reason, or `missing` for a name whose row is not
   * here at all. `agentName` is null only for `missing`.
   *
   * Never answered by handing the item to another agent of the same
   * kind: the step says who runs it, and only changing the step changes
   * that.
   */
  | { kind: "agent_unavailable"; agentId: string; agentName: string | null; why: StepAgentRefusal | "missing" }
  /**
   * The installed pack turned this step away (`dispatchGate`).
   *
   * A standing fact like every other member here — the gate is asked the
   * same question on every tick and answers the same way until somebody
   * changes the item — which is why it belongs in this union at all
   * rather than beside it. What it says is the pack's business: the
   * developer pack's is that a step judging an item has nothing to
   * judge it against, and EO-204 is what that cost unsaid, eleven
   * rejections and thirteen implementation runs against an item that
   * declared no criteria.
   */
  | R;

/**
 * Why no check may run for a step that keeps checking, whatever its
 * schedule says (EO-457): EO is `offline`, or the machine woke a moment
 * ago and checks are `waking` until `until` (epoch ms).
 */
export type WatchHold = { reason: "offline" } | { reason: "waking"; until: number };

/** Which in-flight item holds another back for what both touch, and by which paths (`touches_overlap`). */
export interface TouchesHold {
  holderId: string;
  /** The held item's own entry. */
  path: string;
  /** The holder's entry it overlaps. */
  holderPath: string;
}

/** An item in flight, with the paths it declared (`touchesOf`). */
export interface TouchesClaim {
  item: Item;
  touches: readonly string[];
}

/**
 * The in-flight item whose declared paths overlap this one's, if any
 * (EO-912): the rule behind `touches_overlap`, exported so that a host
 * explaining a card asks the very function the scheduler decides with.
 *
 * `inFlight` is the claims in this item's place only — the caller
 * knows what a place is, and this does not. `related` answers whether
 * dependency edges join the two ids either way, which exempts the pair.
 * The oldest holder is named where several overlap, so the answer does
 * not depend on the order the claims arrive in.
 */
export function touchesHold(item: Item, inFlight: readonly TouchesClaim[], related: (a: string, b: string) => boolean): TouchesHold | null {
  const own = touchesOf(item);
  if (own.length === 0) return null;
  const ordered = [...inFlight].sort((a, b) => a.item.createdAt - b.item.createdAt || a.item.id.localeCompare(b.item.id));
  for (const claim of ordered) {
    if (claim.item.id === item.id || related(item.id, claim.item.id)) continue;
    for (const path of own) {
      const holderPath = claim.touches.find((other) => touchesOverlap(path, other));
      if (holderPath !== undefined) return { holderId: claim.item.id, path, holderPath };
    }
  }
  return null;
}

/** What `touchesHolds` reads: `EligibilityInput`'s own facts, with the step and place lookups the scheduler has built. */
export interface TouchesHoldsInput {
  /** Every item the scheduler is considering — holders and held alike. */
  items: readonly Item[];
  stepFor: (item: Item) => PipelineStep | undefined;
  /** `EligibilityInput.dispatchedIn`. */
  dispatchedIn: ReadonlyMap<string, ReadonlySet<string>>;
  /** The place an item works in at the step it stands on now; null for none shared. */
  placeOf: (item: Item) => string | null;
  /** Every dependency edge, whatever its rule. */
  deps: readonly Edge[];
  /**
   * The items each one is held back by on an edge that holds it now
   * (`open_dependency`). Waits the overlap hold must see to find a ring
   * that runs through edges as well as through overlaps. Absent is none.
   */
  waitsOnDependencies?: (item: Item) => readonly string[];
}

/** The overlap hold over one input (`touchesHolds`). */
export interface TouchesHolds {
  /** What holds this item back for what it touches, or null. */
  holdOf(item: Item): TouchesHold | null;
  /** Counts an item as in flight where it works now: `tick()` calls it for each item it dispatches. */
  claim(item: Item): void;
}

/**
 * The overlap hold (EO-912, `touches_overlap`) over everything the
 * scheduler is asked about at once, exported so that a host explaining
 * a card asks the very rule the tick decides with.
 *
 * An item is in flight in each place `dispatchedIn` lists for it while
 * its step is not terminal, and holds there what it declared it touches.
 * An item is asked about at the place it would work in now, if it has
 * not been dispatched there before: an item already under way in a
 * place carries on there, so two that started together both go on, but
 * one under way elsewhere entering a place for the first time waits
 * like any other.
 *
 * Those that wait can wait on each other in a ring — one under way in A
 * wanting B, another under way in B wanting A — which no finish would
 * ever end; and a ring can run through dependency edges as well, where
 * an item one of them waits for by an edge is itself waiting on the
 * other's place (`waitsOnDependencies`). In each such ring the oldest
 * member that no edge inside the ring holds, and that waits there for
 * a place, goes first: it is held by nothing in the ring, so no edge is
 * ever bypassed. The next tick it is under way where it went, the ring
 * is broken, and the rest wait for it as for anyone.
 *
 * Two items a dependency path joins, either way and however long, are
 * left to their edges: the plan has already said how they go, and an
 * overlap hold across a chain of edges could close a ring of its own.
 */
export function touchesHolds(input: TouchesHoldsInput): TouchesHolds {
  const { items, stepFor, dispatchedIn, placeOf } = input;
  const related = dependencyLinked(input.deps);

  const claimsByPlace = new Map<string, TouchesClaim[]>();
  const addClaim = (item: Item, place: string): void => {
    const touches = touchesOf(item);
    if (touches.length === 0) return;
    const claims = claimsByPlace.get(place);
    if (claims === undefined) claimsByPlace.set(place, [{ item, touches }]);
    else if (!claims.some((claim) => claim.item.id === item.id)) claims.push({ item, touches });
  };
  for (const item of items) {
    const places = dispatchedIn.get(item.id);
    if (places === undefined || places.size === 0) continue;
    const step = stepFor(item);
    if (step === undefined || step.isTerminal) continue;
    for (const place of places) addClaim(item, place);
  }

  /** The place this item is asked about, or null where the hold does not apply to it. */
  const askedAt = (item: Item): string | null => {
    if (touchesOf(item).length === 0) return null;
    const step = stepFor(item);
    if (step === undefined || step.isTerminal || step.type === "user") return null;
    const place = placeOf(item);
    if (place === null || dispatchedIn.get(item.id)?.has(place) === true) return null;
    return place;
  };
  const overlapsWith = (item: Item, claims: readonly TouchesClaim[]): TouchesClaim[] => {
    const own = touchesOf(item);
    return claims.filter(
      (claim) =>
        claim.item.id !== item.id &&
        !related(item.id, claim.item.id) &&
        own.some((path) => claim.touches.some((other) => touchesOverlap(path, other))),
    );
  };

  // Who waits on whom, and the rings in it. An overlap wait is an item
  // wanting a place where an overlapping item is in flight; a dependency
  // wait is an edge that holds it. Either may close a ring — A wants B's
  // place, B's edge waits on C, C wants D's place, D's edge waits on A —
  // and only an overlap wait can be broken, since edges are the plan's.
  const overlapWaits = new Map<string, Set<string>>();
  const byId = new Map<string, Item>();
  for (const item of items) {
    const place = askedAt(item);
    if (place === null) continue;
    const holders = overlapsWith(item, claimsByPlace.get(place) ?? []).map((claim) => claim.item.id);
    if (holders.length === 0) continue;
    overlapWaits.set(item.id, new Set(holders));
  }
  const goesFirstPast = new Map<string, ReadonlySet<string>>();
  if (overlapWaits.size > 0) {
    const dependencyWaits = new Map<string, Set<string>>();
    for (const item of items) {
      byId.set(item.id, item);
      const step = stepFor(item);
      if (step === undefined || step.isTerminal || step.type === "user") continue;
      const on = input.waitsOnDependencies?.(item) ?? [];
      if (on.length > 0) dependencyWaits.set(item.id, new Set(on));
    }
    const waitsOn = new Map<string, string[]>();
    for (const id of new Set([...overlapWaits.keys(), ...dependencyWaits.keys()])) {
      waitsOn.set(id, [...(overlapWaits.get(id) ?? []), ...(dependencyWaits.get(id) ?? [])]);
    }
    for (const ring of rings(waitsOn)) {
      const inRing = new Set(ring);
      // Who may go past the ring: one whose overlap wait is inside it and
      // whom no edge inside it holds. There is always one — the edges are
      // acyclic, so some member waits on no other by an edge, and it is
      // in the ring by an overlap wait — though an edge out of the ring
      // may still hold it, which is waiting on something that can finish.
      const free = ring.flatMap((id) => {
        const item = byId.get(id);
        if (item === undefined) return [];
        const byOverlap = [...(overlapWaits.get(id) ?? [])].some((other) => inRing.has(other));
        const byEdge = [...(dependencyWaits.get(id) ?? [])].some((other) => inRing.has(other));
        return byOverlap && !byEdge ? [item] : [];
      });
      const oldest = [...free].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
      if (oldest !== undefined) goesFirstPast.set(oldest.id, inRing);
    }
  }

  return {
    holdOf(item) {
      const place = askedAt(item);
      if (place === null) return null;
      const past = goesFirstPast.get(item.id);
      const claims = claimsByPlace.get(place) ?? [];
      return touchesHold(item, past === undefined ? claims : claims.filter((claim) => !past.has(claim.item.id)), related);
    },
    claim(item) {
      const place = placeOf(item);
      if (place !== null) addClaim(item, place);
    },
  };
}

/** Whether a path of dependency edges joins two items, either way (`touchesHolds`). */
function dependencyLinked(deps: readonly Edge[]): (a: string, b: string) => boolean {
  const out = new Map<string, string[]>();
  for (const edge of deps) {
    const list = out.get(edge.itemId);
    if (list) list.push(edge.dependsOnId);
    else out.set(edge.itemId, [edge.dependsOnId]);
  }
  const reached = new Map<string, Set<string>>();
  const reachable = (from: string): Set<string> => {
    const known = reached.get(from);
    if (known) return known;
    const seen = new Set<string>();
    const stack = [...(out.get(from) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(out.get(next) ?? []));
    }
    reached.set(from, seen);
    return seen;
  };
  return (a, b) => reachable(a).has(b) || reachable(b).has(a);
}

/** The strongly connected sets of more than one member in a waits-on graph (Tarjan's). */
function rings(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue; // waits on nobody, so in no ring
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) as number, low.get(next) as number));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) as number, index.get(next) as number));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const ring: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      ring.push(member);
    } while (member !== node);
    if (ring.length > 1) found.push(ring);
  };
  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return found;
}

/**
 * The rule an edge holds under, as `open_dependency` reports it: absent,
 * and a `reached` edge naming no step, are both `finished` (see
 * `DependencyEdge`). Only asked of an edge that holds, so never `none`.
 */
function gateOf(edge: DependencyEdge): { wait: "finished" | "reached"; waitStepId: string | null } {
  return edge.wait === "reached" && edge.waitStepId ? { wait: "reached", waitStepId: edge.waitStepId } : { wait: "finished", waitStepId: null };
}

/**
 * What a scheduling question reads an item's step and its dependencies
 * by, built once from the input (`eligibility`, `touchesHoldsOver`).
 */
interface Lookups {
  stepFor: (item: Item) => PipelineStep | undefined;
  itemById: Map<string, Item>;
  depsByItem: Map<string, DependencyEdge[]>;
  hasOpenDep: (edge: DependencyEdge) => boolean;
}

/** What `lookupsOf` reads: the items, their steps and their edges. */
type LookupInput = Pick<EligibilityInput, "items" | "deps" | "steps" | "stepsByItem" | "dependencyItems" | "arrivals">;

function lookupsOf(input: LookupInput): Lookups {
  const { items, deps, steps } = input;
  // Step lookup is scoped by pipeline, not global. Two pipelines may use
  // the same step id only if one was copied from the other, but they will
  // routinely share positions, roles and names — so the pipeline is part
  // of the key, and an item can never resolve to another pipeline's step.
  const stepsByPipeline = new Map<string, Map<string, PipelineStep>>();
  for (const step of steps) {
    let byId = stepsByPipeline.get(step.pipelineId);
    if (!byId) stepsByPipeline.set(step.pipelineId, (byId = new Map()));
    byId.set(step.id, step);
  }
  // An item on no pipeline is a feature (ARCHITECTURE.md, "One work entity") — a container, not
  // work.
  // There is nothing to dispatch against it and never was: its state was
  // always its stories' state wearing a step id.
  const stepFor = (item: Item): PipelineStep | undefined => {
    if (item.pipelineId === null || item.stepId === null) return undefined;
    // The item's own version's definition first (EO-327). Held to the
    // same rule as the lookup under it: a step it names must belong to
    // this item's pipeline, so a stale or crossed entry cannot dispatch
    // one pipeline's item against another's step.
    const bound = input.stepsByItem?.get(item.id);
    if (bound && bound.pipelineId === item.pipelineId && bound.id === item.stepId) return bound;
    return stepsByPipeline.get(item.pipelineId)?.get(item.stepId);
  };

  const itemById = new Map(items.map((item) => [item.id, item]));

  // What a dependency edge resolves against (EO-335). A superset of
  // `itemById` where the caller hides anything from the scheduler, and
  // the same map where it does not — see `dependencyItems`.
  const dependencyById = input.dependencyItems ? new Map(input.dependencyItems.map((item) => [item.id, item])) : itemById;

  const depsByItem = new Map<string, DependencyEdge[]>();
  for (const edge of deps) {
    const list = depsByItem.get(edge.itemId);
    if (list) list.push(edge);
    else depsByItem.set(edge.itemId, [edge]);
  }

  /**
   * Whether this edge still holds the item waiting on it (EO-776).
   *
   * A finished dependency releases every edge, whatever its rule, and is
   * asked first for that reason: a `reached` edge whose step a later
   * save retired, or whose dependency moved to another pipeline, can then
   * never block for good (EO-335). After that the rule: `none` never
   * holds, and `reached` holds until the host has recorded the
   * dependency arriving at its step.
   */
  const hasOpenDep = (edge: DependencyEdge): boolean => {
    const depItem = dependencyById.get(edge.dependsOnId);
    // An edge pointing at no item at all cannot be waiting for
    // anything (EO-335). There is nothing left to finish it and no
    // tick that will ever resolve it differently, so counting it as
    // open is not caution — it is a permanent block chosen by a
    // lookup miss. The dangling edge is what is wrong; the item
    // waiting behind it is not.
    if (!depItem) return false;
    // A dependency resolves against *its own* pipeline. Cross-pipeline
    // dependencies are legitimate now — a story in one pipeline can
    // block a story in another — so this must not reuse the current
    // item's pipeline to look the step up.
    if (stepFor(depItem)?.isTerminal) return false;
    const gate = edge.wait ?? "finished";
    if (gate === "none") return false;
    if (gate === "reached" && edge.waitStepId) return !input.arrivals?.get(edge.dependsOnId)?.has(edge.waitStepId);
    return true;
  };

  return { stepFor, itemById, depsByItem, hasOpenDep };
}

/**
 * The overlap hold over a scheduling input (EO-912), with the lookups
 * already built: the place an item works in is `capacityKeyOf`'s answer,
 * and an item waits by dependency on each edge that still holds it.
 */
function overlapOver(
  input: Pick<EligibilityInput, "items" | "deps" | "dispatchedIn" | "capacityKeyOf">,
  lookups: Pick<Lookups, "stepFor" | "depsByItem" | "hasOpenDep">,
): TouchesHolds {
  const { stepFor, depsByItem, hasOpenDep } = lookups;
  return touchesHolds({
    items: input.items,
    stepFor,
    dispatchedIn: input.dispatchedIn ?? new Map(),
    placeOf: (item) => (input.capacityKeyOf ? input.capacityKeyOf(item) : ""),
    deps: input.deps,
    waitsOnDependencies: (item) => (depsByItem.get(item.id) ?? []).filter(hasOpenDep).map((edge) => edge.dependsOnId),
  });
}

/** What `touchesHoldsOver` reads: `EligibilityInput`'s own facts about items, steps, edges and where work was dispatched. */
export type OverlapInput = LookupInput & Pick<EligibilityInput, "dispatchedIn" | "capacityKeyOf">;

/**
 * The overlap hold exactly as `tick()` applies it, over the part of its
 * input it reads (EO-912): what a host explaining a card asks, so the
 * card and the tick decide by one rule over the same facts.
 */
export function touchesHoldsOver(input: OverlapInput): TouchesHolds {
  return overlapOver(input, lookupsOf(input));
}

/**
 * The lookups every eligibility question needs, built once.
 *
 * `tick()` builds this for the whole board and asks it per item;
 * `dispatchBlocker` builds it to ask about exactly one. Sharing the
 * construction is the point — see `DispatchBlocker` above.
 */
function eligibility<R extends DispatchRefusal>(input: EligibilityInput<R>) {
  const { agents, activeRuns, awaitingInput, heldItemIds } = input;
  const { stepFor, itemById, depsByItem, hasOpenDep } = lookupsOf(input);

  const activeRunItemIds = new Set(activeRuns.map((run) => run.itemId));

  // The overlap hold (EO-912, `dispatchedIn`), over every item at once:
  // who is in flight where, and who waits on whom.
  const overlap = overlapOver(input, { stepFor, depsByItem, hasOpenDep });

  /**
   * Why the agent this step names cannot run this item, capacity aside,
   * or null when it can (EO-875).
   *
   * The step names one agent and only that agent is asked about. Live
   * (`isDispatchable` by its parts: not deleted, archived or disabled),
   * of this item's project or global, and not a preview's own on a real
   * item — `stepAgentRefusal`, which the pick in step 7 below relies on
   * having been asked, so "the step's agent can run this" and "here is
   * the run" cannot come apart.
   */
  const agentBlocker = (step: PipelineStep, item: Item): DispatchBlocker<never> | null => {
    if (step.agentId === null) return { kind: "no_agent" };
    const agent = stepAgentOf(agents, step);
    if (agent === undefined) return { kind: "agent_unavailable", agentId: step.agentId, agentName: null, why: "missing" };
    const why = stepAgentRefusal(agent, item);
    return why === null ? null : { kind: "agent_unavailable", agentId: agent.id, agentName: agent.name, why };
  };

  /**
   * Whether the pause stands between this item and a run: every item,
   * but for an agent step whose agent is of a kind the host exempted. An
   * item on a step nobody can find is held with the rest.
   */
  const heldByPause = (item: Item): boolean => {
    if (!input.paused) return false;
    const step = stepFor(item);
    const kind = step === undefined ? null : stepAgentKind(agents, step);
    return kind === null || !input.pauseExemptRoles?.has(kind);
  };

  /**
   * The skip chain, in the order `tick()` has always applied it.
   *
   * Returns null when the only thing left between this item and a run
   * is a free slot.
   */
  function blockerFor(item: Item): DispatchBlocker<R> | null {
    const step = stepFor(item);
    // Unknown step — malformed data, or a step belonging to a pipeline
    // this item is not on. Skipping is the safe direction: dispatching
    // against a same-named step of another pipeline would run the wrong
    // action against the wrong role.
    if (!step) return { kind: "unknown_step" };

    // 1. Nobody acts here. A `user` step is the engine handing off, and a
    // terminal step is work that has finished — dispatching against either
    // would be the engine acting where it was told not to. Terminal
    // matters more than it looks: a terminal step that also ran something
    // would re-run it on every tick, since an item that has arrived
    // nowhere new is an item with no active run.
    if (step.type === "user" || step.isTerminal) return { kind: "step_not_dispatchable", stepId: step.id };

    const holding = (depsByItem.get(item.id) ?? []).find((edge) => hasOpenDep(edge));
    if (holding) {
      // 2. blocked by another item
      const gate = gateOf(holding);
      return { kind: "open_dependency", dependsOnId: holding.dependsOnId, wait: gate.wait, waitStepId: gate.waitStepId };
    }

    // 2b. Held back by an item in flight that changes the same paths
    // (EO-912) — `open_dependency` extended from one plan to everything
    // in flight, with no edge written. Not in a place it is already
    // under way in: there it carries on.
    const overlapping = overlap.holdOf(item);
    if (overlapping) return { kind: "touches_overlap", ...overlapping };

    if (awaitingInput.has(item.id)) return { kind: "awaiting_input" }; // 3. blocked on a reply

    if (heldItemIds.has(item.id)) return { kind: "held" }; // manually parked; not awaiting an answer and still on this step

    if (activeRunItemIds.has(item.id)) return { kind: "run_active" }; // 4. already working

    // Its last run failed and the retry is not due yet. A fact the host
    // works out with its own clock — this function has none — and hands
    // over as `retryAfter`.
    const retryAt = input.retryAfter?.get(item.id);
    if (retryAt !== undefined) return { kind: "retry_backoff", until: retryAt };

    // A step that keeps checking, between checks (EO-456). Here, beside
    // the retry it resembles: both are a wait the host timed, and both
    // end on their own.
    const watching = input.watchingUntil?.get(item.id);
    // Offline, or just woken (EO-457). Named whenever it is what stands
    // between the item and its next check: always while offline, since
    // nobody knows when that ends, and after a wake only when the hold
    // outlasts the wait the watch was already in — a check due in an
    // hour is still due in an hour, and that is the honest answer.
    const hold = input.watchesHeld?.get(item.id);
    if (hold !== undefined && (watching === undefined || hold.reason === "offline" || hold.until > watching.nextCheckAt)) {
      return { kind: "watch_held", ...hold };
    }
    if (watching !== undefined) return { kind: "watching", nextCheckAt: watching.nextCheckAt, giveUpAt: watching.giveUpAt };

    // 5. Whatever the installed pack requires of this step before it
    // will run — a review with nothing to judge against being the one
    // EO ships (EO-213, KAN-161).
    //
    // Below `run_active` so a run already streaming still reports itself
    // as the reason a second one will not start, and above everything
    // that follows because a gate's answer is a fact about the item
    // rather than about the installation: an unstaffed role is fixed in
    // Settings and this is fixed on the item, and the item is what
    // the person reading it can act on.
    //
    // Given the step rather than only the item, so the pack can key on
    // the action: a step id is a slug that stops matching the moment a
    // second pipeline exists, and an owner role misses the architect's
    // own `qa`-step example. Above the builtin/module branch below so a
    // gate applies to a step of any type.
    const refusal = input.dispatchGate?.(item, step) ?? null;
    if (refusal) return refusal;

    // A builtin or module step is EO running a function rather than
    // asking anyone, so there is no role to staff and nothing further to
    // check here.
    if (step.type === "builtin" || step.type === "module") {
      // Nothing named to run; the validator rejects this at save time.
      return step.entryAction === null ? { kind: "step_not_dispatchable", stepId: step.id } : null;
    }

    // 8. The step names no agent, or one that cannot run this item.
    // Capacity is *not* asked about: an agent that is merely busy is not
    // a reason, it is a queue.
    return agentBlocker(step, item);
  }

  return { stepFor, itemById, blockerFor, heldByPause, claimTouches: overlap.claim };
}

/**
 * Why this item is not being dispatched at its current step, or null
 * when the only thing between it and a run is a free slot (EO-135).
 *
 * The question a person asks after resuming an item and watching
 * nothing happen. Answered from the same function `tick()` decides with,
 * so "EO says it will be picked up" and "EO picks it up" cannot come
 * apart — which is the shape of the bug this was written for.
 */
export function dispatchBlocker<R extends DispatchRefusal>(input: EligibilityInput<R>, itemId: string): DispatchBlocker<R> | null {
  const item = input.items.find((candidate) => candidate.id === itemId);
  if (!item) return input.paused ? { kind: "paused" } : { kind: "unknown_step" };
  const { blockerFor, heldByPause } = eligibility(input);
  return heldByPause(item) ? { kind: "paused" } : blockerFor(item);
}

/**
 * The same question asked of the whole board at once (EO-213).
 *
 * `dispatchBlocker` builds its lookups per call, which is right for the
 * one item a person is asking about and quadratic for every item on
 * the board. The supervisor needs the second form: a tick has to find
 * the reviews it is refusing before it can say so, and it does that on
 * every tick.
 *
 * Only the items that are blocked appear, and `paused` is deliberately
 * not one of the answers. A pause is a fact about the installation, not
 * about any item — reporting it here would have a caller looking at a
 * board of blockers that all say the same thing and none of which is
 * about the item it names. So an item a pause holds does not appear at
 * all, and one on a step it lets through answers as it always would.
 */
export function dispatchBlockers<R extends DispatchRefusal>(input: EligibilityInput<R>): { item: Item; blocker: DispatchBlocker<R> }[] {
  const { blockerFor, heldByPause } = eligibility(input);
  const blocked: { item: Item; blocker: DispatchBlocker<R> }[] = [];
  for (const item of input.items) {
    if (heldByPause(item)) continue;
    const blocker = blockerFor(item);
    if (blocker) blocked.push({ item, blocker });
  }
  return blocked;
}

/**
 * Whether any item is waiting to be dispatched (EO-577): one with nothing
 * between it and a run but a free slot — no dependency open, no reply
 * owed, no hold, no run already going, nobody missing to staff it — the
 * same question `tick()` asks of each item, without the slots. An item
 * whose agents are all busy is still waiting. An item a pause holds is
 * not.
 *
 * What EO's own housekeeping asks before it takes the global slot, so it
 * never takes it from pipeline work.
 */
export function hasDispatchableItem<R extends DispatchRefusal>(input: EligibilityInput<R>): boolean {
  const { blockerFor, heldByPause } = eligibility(input);
  return input.items.some((item) => !heldByPause(item) && blockerFor(item) === null);
}

/**
 * The heart of EO (ARCHITECTURE.md, "The tick"). Pure: no DB, no clock, no I/O —
 * `now` isn't even a parameter because nothing here needs it. Given the
 * same input, always returns the same output in the same order.
 */
export function tick<R extends DispatchRefusal>(input: TickInput<R>): Dispatch[] {
  const { items, agents, activeRuns, limits } = input;

  // Whether an item may be dispatched at all is `eligibility`'s
  // question, not this one's (EO-135). What is left here is the half
  // that depends on the moment rather than on the item: who has a slot
  // free, and in what order the slots are handed out.
  const { stepFor, itemById, blockerFor, heldByPause, claimTouches } = eligibility(input);

  // No pack, or a pack with nothing to share: every item is in a
  // bucket of its own, so only the global cap and the per-agent cap
  // decide anything.
  const capacityKeyOf = input.capacityKeyOf ?? (() => null);

  const activeRunCountByAgent = new Map<string, number>();
  const activeRunCountByBucket = new Map<string, number>();
  for (const run of activeRuns) {
    // A builtin run has no agent, so it consumes no agent's capacity —
    // it consumes the global and bucket slots below, which is what
    // actually matters: it touches whatever its bucket stands for.
    if (run.agentId !== null) activeRunCountByAgent.set(run.agentId, (activeRunCountByAgent.get(run.agentId) ?? 0) + 1);
    // A run's bucket is its item's. Runs whose item isn't in this
    // input count against nothing — they can't, there is no item here
    // to ask about them.
    const runItem = itemById.get(run.itemId);
    const key = runItem ? capacityKeyOf(runItem) : null;
    if (key !== null) activeRunCountByBucket.set(key, (activeRunCountByBucket.get(key) ?? 0) + 1);
  }

  // Highest priority, then oldest, first — both for picking agents (a
  // lower-priority item must never take a capacity slot ahead of a
  // higher-priority one) and for the final list order. Whatever the host
  // put first in line goes ahead of all of it (EO-582).
  const firstInLine = input.firstInLine;
  const orderedItems = [...items].sort((a, b) => {
    if (firstInLine !== undefined) {
      const aFirst = firstInLine.has(a.id);
      if (aFirst !== firstInLine.has(b.id)) return aFirst ? -1 : 1;
    }
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.createdAt - b.createdAt;
  });

  const remainingCapacityByAgent = new Map<string, number>();
  function agentHasCapacity(agent: Agent): boolean {
    const used = activeRunCountByAgent.get(agent.id) ?? 0;
    const remaining = remainingCapacityByAgent.get(agent.id) ?? limits.perAgentConcurrency - used;
    return remaining > 0;
  }
  function consumeAgentCapacity(agent: Agent): void {
    const used = activeRunCountByAgent.get(agent.id) ?? 0;
    const remaining = remainingCapacityByAgent.get(agent.id) ?? limits.perAgentConcurrency - used;
    remainingCapacityByAgent.set(agent.id, remaining - 1);
  }

  const remainingCapacityByBucket = new Map<string, number>();
  // An item in no bucket is never turned away here and never consumes
  // anything: the global cap is the only one it answers to.
  function bucketHasCapacity(item: Item): boolean {
    const key = capacityKeyOf(item);
    if (key === null) return true;
    const used = activeRunCountByBucket.get(key) ?? 0;
    return (remainingCapacityByBucket.get(key) ?? limits.perRepositoryConcurrency - used) > 0;
  }
  function consumeBucketCapacity(item: Item): void {
    const key = capacityKeyOf(item);
    if (key === null) return;
    const used = activeRunCountByBucket.get(key) ?? 0;
    const remaining = remainingCapacityByBucket.get(key) ?? limits.perRepositoryConcurrency - used;
    remainingCapacityByBucket.set(key, remaining - 1);
  }

  // An item dispatched on this tick is in flight where it works from
  // here on (EO-912), so a later item in the same tick that overlaps it
  // is held, rather than both starting together because neither had run
  // there before.
  function startedNow(item: Item): void {
    claimTouches(item);
  }

  const dispatches: Dispatch[] = [];
  let globalRemaining = Math.max(0, limits.globalConcurrency - activeRuns.length - (input.reservedSlots ?? 0));

  for (const item of orderedItems) {
    // Everything standing between this item and a run that is not
    // about capacity: unknown step, nobody-acts-here, dependencies, a
    // reply owed, a hold, a run already going, an unstaffed role. The
    // pause first: it takes effect the very next tick, ahead of all of them.
    if (heldByPause(item) || blockerFor(item)) continue;
    // Always found once `blockerFor` has passed the item — an absent
    // step is the first thing it turns away. Re-asked rather than
    // asserted, so this stays a narrowing and not a promise.
    const step = stepFor(item);
    if (!step) continue;

    const kind = stepAgentKind(agents, step);
    const uncapped = kind !== null && input.uncappedRoles?.has(kind) === true;
    // A `continue` and not a `break`: a step further down may answer to no cap.
    if (!uncapped && globalRemaining <= 0) continue;
    if (!uncapped && !bucketHasCapacity(item)) continue; // 5. this bucket is already as busy as it's allowed to be

    // 6. A builtin or module step is EO running a function rather than
    // asking anyone: no role to staff, so no agent to find and no
    // per-agent capacity to consume. Both still take a global and a
    // bucket slot, because they touch whatever the bucket stands for
    // just as an agent would and two of those must not overlap.
    //
    // A module joins this branch rather than getting its own because the
    // scheduling question is identical — the difference between them is
    // whose code runs, which is the supervisor's business (KAN-105).
    if (step.type === "builtin" || step.type === "module") {
      // `blockerFor` has already turned away a step naming nothing to
      // run; kept so the push below needs no assertion.
      if (step.entryAction === null) continue;
      consumeBucketCapacity(item);
      dispatches.push({ item, agent: null, action: step.entryAction, stepId: step.id });
      startedNow(item);
      globalRemaining -= 1;
      continue;
    }

    // 7. `blockerFor` has established that the agent the step names can
    // run this item, so the only thing left is whether it has a slot. A
    // busy agent leaves the item waiting for it: the step names one
    // agent, and its work is never handed to another of the same kind
    // (EO-875).
    const agent = stepAgentOf(agents, step);
    if (!agent) continue;
    if (!uncapped && !agentHasCapacity(agent)) continue;

    consumeAgentCapacity(agent);
    consumeBucketCapacity(item);
    dispatches.push({ item, agent, action: step.entryAction ?? "", stepId: step.id });
    startedNow(item);
    globalRemaining -= 1;
  }

  return dispatches;
}
