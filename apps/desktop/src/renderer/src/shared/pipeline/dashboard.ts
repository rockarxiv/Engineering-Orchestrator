import { JOB_ID_FACET, STEP_ID_FACET, describeItemOriginKind, type PipelineStepView, type ItemSummary, type StepVerification, type ViewFilter } from "@eo/core";
import { costOf } from "../jobs/format";

/**
 * What the paused rail registers as a drop target (EO-46).
 *
 * Deliberately not a step id: a hold is a fact about the item, not a
 * transition, so `resolveDropTarget` never answers with it and the rail
 * is resolved before the columns are consulted at all.
 */
export const PAUSED_RAIL_DROPPABLE_ID = "paused-rail";

/**
 * The rail's other drop target: hand this to another pipeline (EO-71).
 *
 * EO-70 said a gesture could not express a hand-off because the other
 * pipeline's columns are not on screen. That is true of the board and
 * false of the rail, which already reveals itself for the length of a
 * drag for exactly this reason — dragging is when you need somewhere to
 * drop. Like the hold, it is deliberately not a step id: which step the
 * item lands on is the destination pipeline's business, and it is not
 * decided until the dialog is answered.
 */
export const HAND_OFF_DROPPABLE_ID = "pipeline-hand-off";

/** Running and queued work is what makes an otherwise ordinary action destructive. */
export function hasRunInFlight(item: ItemSummary): boolean {
  return item.latestRunStatus === "running" || item.latestRunStatus === "queued";
}

/** Where a drop landed, or null when the move is a no-op. */
export function resolveDropTarget(
  columns: { id: string }[],
  items: ItemSummary[],
  activeId: string,
  overId: string | undefined,
): { item: ItemSummary; toStepId: string } | null {
  if (!overId) return null;
  const item = items.find((candidate) => candidate.id === activeId);
  if (!item) return null;

  // Dropping onto a card means that card's column: order inside a column
  // is derived from when the work was created (`newestFirst`), so there is
  // nothing to persist and a drop inside one column stays a no-op.
  const overItem = items.find((candidate) => candidate.id === overId);
  const toStepId = overItem ? overItem.stepId : columns.find((column) => column.id === overId)?.id;
  if (!toStepId || toStepId === item.stepId) return null;
  return { item, toStepId };
}

/**
 * A column's cards, newest work first (EO-85).
 *
 * The board used to show whatever order `items:list` returned, which is
 * SQLite's insertion order — so the item you just added landed at the
 * bottom, under everything that had been sitting there.
 *
 * **The ordering key is the id, not a `createdAt` on the summary.** Every
 * item id is a UUIDv7 minted by `uuidv7()` in `@eo/core`: the leading
 * bits are the millisecond it was minted, and it spends the bits below
 * them (rand_a) on a monotonic counter rather than on randomness, so
 * lexicographic order *is* creation order — right down to two items
 * minted in the same millisecond, which is what makes this total and
 * stable instead of a coin flip that reshuffles between renders.
 * `createItem` is the only writer of an item row and stamps
 * `created_at` from the same `Date.now()` the id carries, so ordering by
 * id and ordering by (created_at, id) are the same answer — and the id is
 * already on `ItemSummary`, so it costs no new field on the wire and no
 * second round trip.
 *
 * Deliberately not `updatedAt`: an agent writing a comment on old work
 * would jump it to the top. Derived here at render time; nothing about
 * the order is persisted, which is what keeps a drop inside a card's own
 * column a no-op (`resolveDropTarget`).
 */
export function newestFirst(items: ItemSummary[]): ItemSummary[] {
  // Copied before sorting: the array handed in belongs to the query cache
  // via `items`, and sorting in place would mutate what TanStack holds.
  return [...items].sort((a, b) => b.id.localeCompare(a.id));
}

/**
 * The board's search box, and the step it is narrowed to, in the shape
 * that crosses IPC (EO-192, EO-230).
 *
 * One spelling, so the cards this component draws and the counts the
 * main process resolves cannot be narrowed by two different questions.
 */
export function boardViewFilter(query: string, stepFilter: string | null = null, jobFilter: string | null = null): ViewFilter {
  return {
    text: query,
    facets: {
      ...(stepFilter === null || stepFilter === "" ? {} : { [STEP_ID_FACET]: stepFilter }),
      ...(jobFilter === null || jobFilter === "" ? {} : { [JOB_ID_FACET]: jobFilter }),
    },
  };
}

/** The step's current owner as the picker's `<option>` value, or "" for nobody. */
export function ownerIdOf(step: PipelineStepView, verification: readonly StepVerification[]): string {
  const entry = verification.find((candidate) => candidate.stepId === step.id);
  return entry?.waitsOnId ?? "";
}

/** A default line under a step name, when nobody wrote one. */
export function descriptionFor(step: PipelineStepView): string {
  if (step.type === "builtin") {
    if (step.entryAction === "open_pull_request") return "Opens the pull request";
    if (step.entryAction === "watch_pull_request") return "Watches the pull request";
    if (step.entryAction === "index_repository") return "Indexes the code for the agents";
    return "Prepares the worktree";
  }
  if (step.type === "user") return step.isTerminal ? "Finished work" : "Waiting on a person";
  return step.ownerRole ? `Owned by ${step.ownerRole}` : "";
}

/**
 * "From job \"Monday report\" · 12¢" (EO-308, ARCHITECTURE.md, "What a job records").
 *
 * The same word the rail uses — job, conversation or webhook — from the
 * one function that spells it, so that the hover and the detail are one
 * sentence about one fact rather than two descriptions of it, and the
 * same cost formatting the Job page uses.
 *
 * **The cost is always there, `0¢` included.** The design asks for the job
 * and the occurrence's cost, and an item filed this morning has almost
 * always cost nothing yet — suppressing the nought would have hidden
 * the number on exactly the cards a person is most likely to hover.
 * "Nought so far" is an answer; a missing clause is a person wondering
 * whether EO knows.
 */
export function originHover(origin: NonNullable<ItemSummary["origin"]>): string {
  return `From ${describeItemOriginKind(origin.trigger)} "${origin.jobName}" · ${costOf(origin.costCents)}`;
}
