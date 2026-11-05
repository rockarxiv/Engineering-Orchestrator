import type { QueryClient } from "@tanstack/react-query";

type Lane = { tail: Promise<unknown>; pending: number };

/** One lane per channel per query client, so they outlive any one mount of the screen that queued them. */
const lanes = new WeakMap<QueryClient, Map<string, Lane>>();

/**
 * Run `task` after every task already queued on `lane` for this query
 * client has settled (EO-563).
 *
 * For a channel that stores a whole object rather than a field: each save
 * must read what is stored only once the save before it has answered, or
 * the second of two quick edits writes back the value the first replaced.
 * The queue lives beside the query client rather than in the component,
 * because leaving the screen and coming back mounts a new component while
 * the old one's save is still on its way.
 *
 * `onIdle` runs once nothing is left on the lane — the place for the
 * read-back that is the backstop to whatever the tasks wrote.
 */
export function enqueueSave<T>(client: QueryClient, lane: string, task: () => Promise<T>, onIdle?: () => void): Promise<T> {
  let byLane = lanes.get(client);
  if (!byLane) {
    byLane = new Map();
    lanes.set(client, byLane);
  }
  let queued = byLane.get(lane);
  if (!queued) {
    queued = { tail: Promise.resolve(), pending: 0 };
    byLane.set(lane, queued);
  }
  const current = queued;
  current.pending += 1;
  const run = current.tail.then(task);
  current.tail = run
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      current.pending -= 1;
      if (current.pending === 0) onIdle?.();
    });
  return run;
}
