import type { RunOutOfMemory } from "../process/runScope.js";

/**
 * A run that ran out of memory, in words (EO-738, ARCHITECTURE.md,
 * "Guardrails").
 *
 * Its own stop rather than a failure like any other, for two reasons the
 * words have to carry. Trying again runs the same work into the same
 * limit, so EO does not, and the item waits for somebody to change
 * something — the concurrency, the limit, or what grew. And it is not the
 * agent's fault, so it is not an attempt: `isOutOfMemoryStop` is how the
 * attempt count tells this run's `error` from every other one, which is
 * why the sentence starts the same way every time.
 *
 * `setting` is the person's limit, or null where it is EO's default for
 * this machine — what that default is made of comes with it, so the
 * person can see what lowering the concurrency would change.
 */
export function outOfMemoryStop(
  report: RunOutOfMemory,
  who: string,
  limit: { setting: number | null; totalMb: number; globalConcurrency: number },
): string {
  const mb = (value: number) => `${value.toLocaleString("en-US")} MB`;
  const cause =
    report.limitReached === true
      ? `${who} reached the run's memory limit of ${mb(report.memoryMaxMb)}`
      : report.limitReached === false
        ? `this machine ran out of memory while ${who} was running`
        : `${who} ran out of memory`;
  const killed =
    report.killed === null
      ? "a process in the run that EO could not identify"
      : report.killed.how === "kernel"
        ? `\`${report.killed.name}\` (process ${report.killed.pid})`
        : report.killed.how === "ranked"
          ? `a process in the run — most likely \`${report.killed.name}\` (process ${report.killed.pid}), the one the kernel ranked first when EO last looked`
          : `a process in the run — most likely \`${report.killed.name}\` (process ${report.killed.pid}), the one the run started with, since the run ended before EO could look inside it`;
  const source =
    limit.setting === null
      ? `EO's default for this machine: three quarters of its ${mb(limit.totalMb)}, shared across a concurrency of ${limit.globalConcurrency}`
      : "set on the Guardrails screen";
  return (
    `${OUT_OF_MEMORY_PREFIX} ${cause}, and the kernel killed ${killed}. Only this run's processes were stopped; EO and every other run carried on.\n\n` +
    `The run memory limit is ${mb(report.memoryMaxMb)} (${source}). This was not counted as an attempt, and EO has not tried again, because the same work would run into the same limit. ` +
    `Lower the concurrency, raise the run memory limit on the Guardrails screen, or fix what grew — then reply to try again.`
  );
}

const OUT_OF_MEMORY_PREFIX = "Ran out of memory:";

/** Whether a run's `error` is the out-of-memory stop — a run that is not an attempt. */
export function isOutOfMemoryStop(error: string | null | undefined): boolean {
  return typeof error === "string" && error.startsWith(OUT_OF_MEMORY_PREFIX);
}
