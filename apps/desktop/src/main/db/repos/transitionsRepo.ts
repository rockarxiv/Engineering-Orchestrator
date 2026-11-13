import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { onProject } from "./projectScope.js";
import { uuidv7, type Item, type PipelineStepType, type RecordCursor, type Transition, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { pipelineSteps, items, transitions } from "../schema.js";
import { getItem, jiraStateFor } from "./itemsRepo.js";
import { assigneeOnArrival } from "./peopleRepo.js";
import { boundGraphForItem, versionForArrival } from "./pipelineVersionsRepo.js";
import { enqueueOutbox } from "./outboxRepo.js";
import { notifyTransitionApplied } from "../transitionEvents.js";
import { isReplica } from "../recordRole.js";

function toDomain(row: typeof transitions.$inferSelect): Transition {
  return {
    id: row.id as Uuid,
    itemId: row.itemId as Uuid,
    fromStepId: row.fromStepId,
    toStepId: row.toStepId,
    actor: row.actor,
    runId: row.runId as Uuid | null,
    reason: row.reason,
    ts: row.ts,
  };
}

export interface TransitionItemInput {
  /**
   * The id this move already has, where it has one (EO-324, ARCHITECTURE.md, "The record").
   *
   * A replica mirroring a move the record applied writes the record's
   * own id, and that is what makes the mirror idempotent: the audit row
   * is a primary key, so a pull that re-sends a transition it already
   * sent — which every pull does at its own cursor boundary — inserts
   * nothing the second time. Without it the same move would be applied
   * again on each pull and the thread would grow a duplicate move per
   * reconnect.
   *
   * Absent everywhere else, which is every move made here: a move that
   * is being decided now has no id until this function gives it one.
   */
  id?: Uuid;
  itemId: Uuid;
  toStepId: string;
  /**
   * The pipeline the destination step belongs to (EO-57).
   *
   * Named, it is checked against the step rather than believed: see the
   * guard in `transitionItem`. A routed move names it always (EO-59),
   * same-pipeline ones included — the check is worth having wherever the
   * two halves could disagree, not only where a pipeline changes.
   *
   * Omitted — a move made by hand, and the orphan record that puts an
   * item back where it was — the item's `pipelineId` is left exactly
   * as it was.
   */
  toPipelineId?: Uuid | null;
  actor: string; // "human" | agent_id
  /**
   * The machine this move came from (EO-324). Absent on a solo desktop,
   * where there is one and naming it would tell nobody anything.
   */
  deviceId?: string | null;
  /**
   * This move is the record's, being copied onto a replica (EO-324).
   *
   * The one thing it changes is that nothing is announced: a replica
   * that announced a mirrored move would queue a command telling the
   * record about a move the record itself made, and the queue would
   * grow by one per reconnect for ever. See `transitionEvents.ts`.
   *
   * Absent everywhere else, which is every move anybody actually makes.
   */
  mirrored?: boolean;
  runId?: Uuid | null;
  reason?: string | null;
  /**
   * The declared result the move was made on, where one was (EO-586): a
   * route's key, or the result a person pressed. Not written — the row
   * keeps the shape it has always had — but told to whatever listens to
   * moves (`AppliedTransition.resultKey`), because once a pack has read an
   * answer its own way the key cannot be read back from the run.
   */
  resultKey?: string | null;
}

/**
 * The ONLY function in this codebase allowed to UPDATE items.stepId
 * (enforced by architecturalInvariants.test.ts). Writes the item row
 * and the transitions row in a single transaction, so a crash between the
 * two is impossible — either both land or neither does.
 *
 * That is also why a *pipeline* change belongs here and nowhere else
 * (EO-57): `pipelineId` and `stepId` only mean anything together, so the
 * one place allowed to write the step is the one place that can move the
 * item to another pipeline without the two ever being apart.
 */
export function transitionItem(db: Db, input: TransitionItemInput): Item {
  // Whether this installation owns the item, asked once and outside the
  // transaction (EO-324). A replica writes everything a record writes —
  // that is what makes it a replica — and pushes nothing outside EO,
  // because a provisional move is not something Jira has a word for.
  // See `recordRole.ts`.
  //
  // Asked of the item rather than of the database (EO-325): a project
  // the person kept local at first sign-in is still theirs, and its
  // moves still belong in their tracker, on a machine whose other
  // projects are the organisation's.
  const ours = !isReplica(db, input.itemId);
  const written = db.transaction((tx) => {
    const current = tx.select().from(items).where(eq(items.id, input.itemId)).get();
    if (!current) {
      throw new Error(`transitionItem: ticket ${input.itemId} not found`);
    }

    // A named pipeline is verified against the step, never trusted
    // (invariant #5) — and refused rather than repaired, because a caller
    // naming two things that disagree has no correct answer to pick from.
    //
    // Half a move is the failure this exists to prevent: the scheduler
    // resolves a step as `stepsByPipeline.get(item.pipelineId)?.get(item.stepId)`,
    // so an item whose two columns point at different pipelines resolves
    // to no step at all. It is then skipped by every tick and stops — with
    // no error, no run, and nothing on the board to say so.
    const toPipelineId = input.toPipelineId ?? null;
    if (toPipelineId !== null) {
      const destination = tx
        .select({ pipelineId: pipelineSteps.pipelineId })
        .from(pipelineSteps)
        .where(eq(pipelineSteps.id, input.toStepId))
        .get();
      if (!destination || destination.pipelineId !== toPipelineId) {
        throw new Error(
          `transitionItem: step "${input.toStepId}" does not belong to pipeline "${toPipelineId}" — refusing a move that would leave the ticket on a step its own pipeline does not have`,
        );
      }
    }

    // …and the same check against the item's own *version* (EO-327,
    // the original design). "An item binds to the version it entered on and finishes
    // there" cuts both ways: a step added after this item entered has no
    // definition in its version and no route leaving it, so an item put
    // there would run by the current graph and then have nowhere to go —
    // the strand this story exists to prevent, reached from the other
    // side.
    //
    // Only within the item's own pipeline. A move to *another* pipeline
    // is entering that pipeline, and the patch below binds the item to
    // the version it is entering on, so there is nothing to be outside
    // of.
    //
    // Skipped for a mirrored move, which is the record's decision being
    // copied onto a replica (EO-324): the record has already applied it,
    // and a replica that refused would hold a different board from the
    // record's for ever after.
    //
    // A throw, like the guard above and for its reason: this is the
    // backstop under a typed refusal the callers make first, so anything
    // that reaches it is a caller that did not ask.
    const staysOnPipeline = toPipelineId === null || toPipelineId === current.pipelineId;
    if (input.mirrored !== true && staysOnPipeline) {
      const bound = boundGraphForItem(tx as unknown as Db, current);
      if (bound !== null && !bound.steps.some((step) => step.id === input.toStepId)) {
        throw new Error(
          `transitionItem: step "${input.toStepId}" is not part of v${bound.number}, which item ${input.itemId} entered on — ` +
            "refusing a move that would leave it on a step its own version cannot dispatch or route out of",
        );
      }
    }

    const now = Date.now();

    // The pipeline is written only when one was named. Callers that name
    // no pipeline are moving within the one the item is already on, and
    // the column must read exactly as it did before they called.
    const patch: { stepId: string; updatedAt: number; pipelineId?: string; assigneeId?: string | null; pipelineVersionId?: string | null } = {
      stepId: input.toStepId,
      updatedAt: now,
    };
    if (toPipelineId !== null) patch.pipelineId = toPipelineId;

    // Arriving on *another* pipeline is entering it, so the item binds to
    // a version of that pipeline (EO-327, ARCHITECTURE.md, "Publish, lock and versions"). A move
    // within the
    // pipeline it is already on changes nothing here — that is the whole
    // promise: "an item binds to the version it entered on and finishes
    // there", and every step of finishing is a move.
    //
    // **A version that has the step**, rather than flatly the current
    // one. A route is resolved against the *sending* item's version, so
    // a hand-off drawn in an older version of this pipeline can still
    // name a step the destination has since retired — and an item bound
    // to the destination's current version while standing on a step that
    // version does not contain is stranded the moment it arrives.
    // `versionForArrival` is where that is decided; it answers with the
    // current version for every ordinary hand-off.
    const arrival = toPipelineId !== null && toPipelineId !== current.pipelineId ? versionForArrival(tx as unknown as Db, toPipelineId, input.toStepId) : undefined;
    if (arrival !== undefined) patch.pipelineVersionId = arrival.id;

    // Arriving on a human step is what decides who has it (EO-305, ARCHITECTURE.md, "The board").
    //
    // Here rather than at the callers for the reason the Jira enqueue
    // below is here: this is the one place an item can arrive anywhere,
    // so it is the only place where "on arrival" can mean it. A caller
    // that did its own assignment would be a caller that forgot to on
    // the day somebody added a new route.
    //
    // It is not a transition of its own and needs none — the assignee is
    // a column on the row this statement is already writing, inside the
    // transaction that records the move. Nothing about the step changes,
    // so invariant #1 is not in play; the one writer of `stepId` is
    // still this function.
    // And **by the item's own version**, for an arrival within its own
    // pipeline (EO-327, ARCHITECTURE.md, "Publish, lock and versions"). Who waits at a step is part
    // of what a
    // version says: if v1 sends an item to a step Dana approves at and
    // v2 hands that step to Pat, the item that entered on v1 arrives on
    // Dana's step, not on Pat's. `bound` is null for everything on the
    // current version and for a hand-off — which rebinds above — so the
    // live row answers, exactly as it always did.
    // For a hand-off, the same question is asked of the version the item
    // is arriving *on*: it may be an older one (see `versionForArrival`
    // above), and who waits at a step is part of what a version says.
    const arrivedOn = staysOnPipeline
      ? boundGraphForItem(tx as unknown as Db, current)?.steps.find((step) => step.id === input.toStepId)
      : boundGraphForItem(tx as unknown as Db, { pipelineId: toPipelineId, pipelineVersionId: arrival?.id ?? null })?.steps.find(
          (step) => step.id === input.toStepId,
        );
    const destination =
      arrivedOn ??
      tx
        .select({ type: pipelineSteps.type, ownerPersonId: pipelineSteps.ownerPersonId, ownerGroupId: pipelineSteps.ownerGroupId })
        .from(pipelineSteps)
        .where(eq(pipelineSteps.id, input.toStepId))
        .get();
    // All three columns, because who waits at a step is one question
    // with two columns to read and reading one of them is how a team's
    // step came to be treated as an unowned one (EO-323).
    const arrivesWith = assigneeOnArrival(
      tx as unknown as Db,
      destination === undefined
        ? undefined
        : {
            type: destination.type as PipelineStepType,
            ownerPersonId: destination.ownerPersonId as Uuid | null,
            ownerGroupId: destination.ownerGroupId,
          },
    );
    if (arrivesWith !== undefined) patch.assigneeId = arrivesWith;

    const updated = tx
      .update(items)
      .set(patch)
      .where(eq(items.id, input.itemId))
      .returning()
      .get();

    // The transition records a cross-pipeline move without a column for
    // it: a step belongs to exactly one pipeline, so from-step and to-step
    // already name where the item left and where it arrived.
    const transitionId = input.id ?? (uuidv7() as Uuid);
    tx.insert(transitions)
      .values({
        id: transitionId,
        itemId: input.itemId,
        fromStepId: current.stepId,
        toStepId: input.toStepId,
        deviceId: input.deviceId ?? null,
        actor: input.actor,
        runId: input.runId ?? null,
        reason: input.reason ?? null,
        ts: now,
      })
      .run();

    const moved = current.stepId !== input.toStepId;

    // Opening the pull request used to happen here, off an
    // `opens_pull_request` flag on the state being arrived at. It is a
    // step now — a `builtin` running `open_pull_request` — which is what
    // gives it an elapsed time, a transcript and somewhere to route when
    // the forge refuses. Arriving somewhere is not an action, so the one
    // action this function performed has moved to where actions run.

    // The push and its cause commit together (J-04). Enqueued here
    // rather than at the callers because invariant #1 makes this the one
    // place a state change can happen — anywhere else and a new call
    // site would silently stop mirroring.
    // The switch alongside the key (EO-122): the key says which issue,
    // the switch says whether to talk to it at all. Both are the item's
    // `jira` extension since KAN-148 rather than columns on the row this
    // statement just updated.
    const jira = jiraStateFor(tx as unknown as Db, input.itemId);
    // `ours` is the half EO-324 added, and it is two failures rather
    // than one. A signed-in desktop pushing its own move would tell the
    // tracker about a move the record may yet refuse as superseded; and
    // the accepted move comes back to every desktop on the next pull,
    // each of which would push it again. The record does it once.
    if (ours && jira.key && updated.workspaceId && jira.sync && moved) {
      enqueueOutbox(tx as unknown as Db, {
        itemId: input.itemId,
        workspaceId: updated.workspaceId as Uuid,
        channel: "jira",
        kind: "status",
        payload: { toStepId: input.toStepId, fromStepId: current.stepId },
      });
    }

    // Read back through the join rather than mapped from the row: the
    // item's type is a row of its own now, and `getItem` is the one
    // place that turns it back into the word `Item.type` carries
    // (KAN-129).
    const item = getItem(tx as unknown as Db, input.itemId);
    if (!item) throw new Error(`transitionItem: item ${input.itemId} vanished mid-transition`);
    // The move as written, carried out of the transaction so it can be
    // announced once the transaction has actually committed.
    return {
      item,
      applied: {
        id: transitionId,
        itemId: input.itemId,
        fromStepId: current.stepId,
        toStepId: input.toStepId,
        actor: input.actor,
        runId: input.runId ?? null,
        reason: input.reason ?? null,
        ts: now,
        toPipelineId,
        resultKey: input.resultKey ?? null,
      },
    };
  });

  // Said out loud, after the transaction and only when this move was
  // decided here (EO-324). A replica applying what the record already
  // decided passes `mirrored`, because announcing that would queue a
  // command telling the record about its own move — a loop that grows
  // by one transition per reconnect.
  //
  // Everything else announces: a drag, a decision on a human step, the
  // route an agent's result took. `transitionEvents.ts` argues why the
  // hook is here rather than at the call sites, and invariant #1 is
  // what makes "here" a single place.
  if (input.mirrored !== true) notifyTransitionApplied(db, written.applied);
  return written.item;
}

/**
 * Who moved this item last, and from which machine (EO-324, ARCHITECTURE.md, "The record").
 *
 * Its own function rather than the last element of
 * `listTransitionsForItem`, because it answers a question `Transition`
 * deliberately does not carry: which *device* applied the move. The
 * domain type is what a thread and a timeline read, and neither of them
 * has any business knowing about machines; the one caller that does is
 * the record deciding what sentence to put in front of somebody whose
 * move was superseded.
 */
export function lastMover(db: Db, itemId: Uuid): { actor: string; deviceId: string | null } | null {
  const row = db
    .select({ actor: transitions.actor, deviceId: transitions.deviceId })
    .from(transitions)
    .where(eq(transitions.itemId, itemId))
    .orderBy(desc(transitions.ts), desc(transitions.id))
    .limit(1)
    .get();
  return row === undefined ? null : { actor: row.actor, deviceId: row.deviceId };
}

/**
 * Whether this move has already been recorded here (EO-324).
 *
 * The idempotence check behind mirroring. A device pulls changes from a
 * cursor that deliberately re-sends its own boundary, and a reconnect
 * re-sends more than that, so "have I already applied this one" has to
 * be answerable — and it is answerable exactly because a mirrored move
 * keeps the record's own id (see `TransitionItemInput.id`).
 */
export function hasTransition(db: Db, id: string): boolean {
  return db.select({ id: transitions.id }).from(transitions).where(eq(transitions.id, id)).get() !== undefined;
}

/**
 * Every move the record applied after a point, oldest first.
 *
 * What a device asks the record for, and what the record's own
 * `record:changes` handler reads. Ordered by `ts` then `id` for
 * `listTransitionsForItem`'s reason — several moves can share a
 * millisecond, and the id is what settles them.
 */
/**
 * `within` scopes the page to one project (EO-325, review).
 *
 * The move does not restamp what it transfers — a comment written in
 * March is a comment written in March — so a desktop whose cursors had
 * already run past March saw the project row arrive and none of its
 * history behind it. It asks for that history here, on cursors of its
 * own, and the keyset is the same one: the scope narrows, nothing else
 * about the paging changes.
 */
export function listTransitionsSince(db: Db, cursor: RecordCursor, limit: number, within?: string): Transition[] {
  return db
    .select()
    .from(transitions)
    // Strictly after the pair — see `RecordCursor`. Reconciliation
    // writes one transition per orphaned run, so two moves in one
    // millisecond is not a corner case here, it is a boot.
    .where(
      and(
        sql`(${transitions.ts} > ${cursor.ts} or (${transitions.ts} = ${cursor.ts} and ${transitions.id} > ${cursor.id}))`,
        within === undefined ? undefined : onProject(transitions.itemId, within),
      ),
    )
    .orderBy(asc(transitions.ts), asc(transitions.id))
    .limit(limit)
    .all()
    .map(toDomain);
}

/**
 * An item's transitions, oldest first, ties broken by id.
 *
 * `ts` alone does not order them: reconciliation writes one per orphaned
 * run, so an item with two stale runs gets two transitions in the same
 * millisecond — and `workflowInitiationId` takes the last of these to
 * decide which attempt cycle a dispatch belongs to. Ids are UUIDv7 and
 * monotonic, so they settle it.
 */
export function listTransitionsForItem(db: Db, itemId: Uuid): Transition[] {
  return db
    .select()
    .from(transitions)
    .where(eq(transitions.itemId, itemId))
    .orderBy(asc(transitions.ts), asc(transitions.id))
    .all()
    .map(toDomain);
}

/**
 * When each item last entered one of these states (KAN-33).
 *
 * The honest answer to "how long has this been finished". `updatedAt`
 * is not: any edit bumps it, so a comment on a done item would reset
 * its clock.
 *
 * The *latest* entry, because an item can finish, be reopened by a
 * rejection, and finish again — and it is the most recent one that says
 * how long the current spell has lasted. One query rather than one per
 * item, since the sweep asks about the whole project at once.
 */
export function lastEntryIntoStates(db: Db, stateIds: string[]): Map<Uuid, number> {
  if (stateIds.length === 0) return new Map();

  const rows = db
    .select({ itemId: transitions.itemId, latest: sql<number>`max(${transitions.ts})` })
    .from(transitions)
    .where(inArray(transitions.toStepId, stateIds))
    .groupBy(transitions.itemId)
    .all();

  return new Map(rows.map((row) => [row.itemId as Uuid, row.latest]));
}

/**
 * The move that brought each of these items onto the step it stands on
 * now: the id of the latest transition into it, in the order
 * `listTransitionsForItem` reads (EO-699). What `watchStayOf` answers for
 * one item, for a whole board in one query. An item that has never moved
 * onto its step is missing from the map.
 */
export function stepEntryTransitionIds(db: Db, itemIds: readonly string[]): Map<string, string> {
  if (itemIds.length === 0) return new Map();
  const rows = db
    .select({ itemId: transitions.itemId, id: transitions.id })
    .from(transitions)
    .innerJoin(items, and(eq(items.id, transitions.itemId), eq(items.stepId, transitions.toStepId)))
    .where(inArray(transitions.itemId, [...itemIds]))
    .orderBy(asc(transitions.ts), asc(transitions.id))
    .all();
  // Ascending, so the last row written for an item is its latest entry.
  return new Map(rows.map((row) => [row.itemId, row.id]));
}

/**
 * When each of these items last arrived on the step it stands on now
 * (EO-570).
 *
 * The board's corner time, for the whole board in one query rather than
 * one per card — through `idx_transitions_item`, narrowed to the
 * transitions whose destination is the item's own current step. An item
 * with no such transition is missing from the map: creating an item
 * writes no transition, so one that has never moved has never "arrived"
 * anywhere, and the caller falls back to `createdAt`.
 */
export function stepEntryTimes(db: Db, itemIds: readonly string[]): Map<string, number> {
  if (itemIds.length === 0) return new Map();

  const rows = db
    .select({ itemId: transitions.itemId, entered: sql<number>`max(${transitions.ts})` })
    .from(transitions)
    .innerJoin(items, and(eq(items.id, transitions.itemId), eq(items.stepId, transitions.toStepId)))
    .where(inArray(transitions.itemId, [...itemIds]))
    .groupBy(transitions.itemId)
    .all();

  return new Map(rows.map((row) => [row.itemId, row.entered]));
}

/**
 * For every `reached` dependency edge, whether its dependency has ever
 * arrived at the step the edge waits for (EO-776): what the scheduler
 * reads as `EligibilityInput.arrivals`, keyed by the dependency's id.
 *
 * Read from `transitions`, which is append-only, so an arrival once
 * recorded stays recorded: the edge latches, and the dependency going
 * back afterwards holds nothing again. Never stored anywhere else.
 *
 * The dependency standing on the step right now counts as well. Creating
 * an item writes no transition (`stepEntryTimes`), so an item made on the
 * gate step has arrived there without a row saying so.
 *
 * Only the gated edges are asked about, in one query through
 * `idx_transitions_item`, because this runs on every tick.
 */
export function gateArrivals(
  db: Db,
  edges: readonly { dependsOnId: string; wait: string; waitStepId: string | null }[],
): Map<string, Set<string>> {
  const arrivals = new Map<string, Set<string>>();
  const gates = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.wait !== "reached" || edge.waitStepId === null) continue;
    const steps = gates.get(edge.dependsOnId);
    if (steps === undefined) gates.set(edge.dependsOnId, new Set([edge.waitStepId]));
    else steps.add(edge.waitStepId);
  }
  if (gates.size === 0) return arrivals;

  const note = (itemId: string, stepId: string | null): void => {
    if (stepId === null || !gates.get(itemId)?.has(stepId)) return;
    const seen = arrivals.get(itemId);
    if (seen === undefined) arrivals.set(itemId, new Set([stepId]));
    else seen.add(stepId);
  };
  const dependencyIds = [...gates.keys()];
  const stepIds = [...new Set([...gates.values()].flatMap((steps) => [...steps]))];
  for (const row of db
    .select({ itemId: transitions.itemId, stepId: transitions.toStepId })
    .from(transitions)
    .where(and(inArray(transitions.itemId, dependencyIds), inArray(transitions.toStepId, stepIds)))
    .all()) {
    note(row.itemId, row.stepId);
  }
  for (const row of db.select({ id: items.id, stepId: items.stepId }).from(items).where(inArray(items.id, dependencyIds)).all()) {
    note(row.id, row.stepId);
  }
  return arrivals;
}
