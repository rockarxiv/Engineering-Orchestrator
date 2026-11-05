import { rmSync } from "node:fs";

/**
 * Removing a test's temporary directory, on every platform.
 *
 * Windows will not delete a file somebody still has open, and answers
 * EBUSY instead. Two things hold one open after a test is finished with
 * it: a child process whose handle outlives its exit by a moment, which
 * retrying covers, and the SQLite file under a started app, which
 * no retry covers — `RunningMain.stop()` leaves the database open on
 * purpose (startMain.ts says why), so it closes when the worker exits
 * and not before. The retries are few for that reason: Node backs off
 * linearly, and twenty of them would spend half a minute per test on a
 * handle that is never going to close. Giving up quietly is right for
 * both, because this is a directory under TEMP and a cleanup that loses
 * a race is not a failed test.
 *
 * Only tests import this module; see `testing/git.ts` for why that is
 * safe and `testing.test.ts` for what holds it.
 */
export function removeScratch(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Left for the operating system to reclaim.
  }
}
