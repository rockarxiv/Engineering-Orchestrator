/**
 * A clock that is an hour later every time it is read.
 *
 * For a test that drives a run to failure and then expects the retry on
 * the next tick: a failed run's retry waits out a backoff
 * (`RETRY_BACKOFF_MS`), and on a real clock the next tick comes a few
 * milliseconds later, well inside it. Passed as a supervisor's `now`,
 * every wait has elapsed by the next reading — the retries still happen
 * one per tick, the way the test means them to.
 */
export function hourlyClock(start = Date.now()): () => number {
  let reading = start;
  return () => (reading += 3_600_000);
}
