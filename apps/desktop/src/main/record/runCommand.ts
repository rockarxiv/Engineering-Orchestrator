import type { RecordRunCommand, Run, RunCheck, Uuid } from "@eo/core";

/**
 * A run, as it travels (EO-324).
 *
 * One mapper, used in both directions: a device reporting what it ran,
 * and the record telling every other device about it. They are the same
 * fact going opposite ways, and two mappers would be two accounts of
 * one run — the kind that agree for a year and then differ by one field
 * nobody notices until a board shows a finished run with no result on
 * it.
 *
 * ### What travels, and what stays on the machine
 *
 * Everything that says what *happened*: the status, when it started and
 * ended, what it produced, what was checked, what it cost, and which
 * attempt at which initiation it was. The result is the point of the
 * second acceptance criterion — *"its result reaches the server"* — and
 * the cost is the point of the record being the only scheduler, since a
 * budget it enforces against a number that is always zero is not a
 * budget.
 *
 * Nothing that is true only of the machine it ran on: the provider's
 * session id, the working directory, the process id, the hashes of the
 * instructions and tool surface the thread was born with. A record
 * holding a `cwd` from somebody's laptop would be storing a path that
 * resolves nowhere, and a resumed session id is meaningless to any
 * process but the one that opened it.
 */
export function asRunCommand(run: Run, id: string, updatedAt: number): RecordRunCommand {
  return {
    kind: "run",
    id,
    runId: run.id,
    itemId: run.itemId,
    agentId: run.agentId,
    stepId: run.stepId,
    action: run.action,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    error: run.error,
    result: run.result ?? null,
    checks: run.checks ?? null,
    verification: run.verification ?? null,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    cacheReadTokens: run.cacheReadTokens,
    cacheWriteTokens: run.cacheWriteTokens,
    turns: run.turns,
    turnsScope: run.turnsScope,
    costCents: run.costCents,
    attempt: run.attempt,
    initiationId: run.initiationId,
    interruption: run.interruption,
    dryRun: run.dryRun,
    updatedAt,
  };
}

/**
 * The patch a run command makes to a row, wherever it lands.
 *
 * Shared by the record taking a device's report and a replica taking
 * the record's, for `asRunCommand`'s reason: a field carried and then
 * not written is a field that travelled for nothing, and the way to
 * make that impossible is for one function to do the writing.
 *
 * `startedAt` is only written when the sender had one, because a run
 * that has not started has no answer and `undefined` leaves the column
 * as it was.
 */
export function runPatchFrom(command: RecordRunCommand): {
  status: Run["status"];
  startedAt?: number;
  endedAt: number | null;
  error: string | null;
  result: Record<string, unknown> | null;
  checks: RunCheck[] | null;
  verification: Record<string, unknown> | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  turns: number | null;
  turnsScope: string | null;
  costCents: number | null;
  interruption: Run["interruption"];
  updatedAt: number;
} {
  return {
    status: command.status as Run["status"],
    ...(command.startedAt === null ? {} : { startedAt: command.startedAt }),
    endedAt: command.endedAt,
    error: command.error,
    // Cast rather than parsed, and deliberately: a result's shape is the
    // pack's and the registry validates it at the step that declared it
    // (`registry.ts`). The record stores what it was handed — it is not
    // the place that decides what a result may be, and a record that
    // refused an unfamiliar one would be refusing a pack it has not been
    // told about.
    result: command.result as Record<string, unknown> | null,
    checks: command.checks as RunCheck[] | null,
    verification: command.verification as Record<string, unknown> | null,
    tokensIn: command.tokensIn,
    tokensOut: command.tokensOut,
    cacheReadTokens: command.cacheReadTokens,
    cacheWriteTokens: command.cacheWriteTokens,
    turns: command.turns,
    turnsScope: command.turnsScope,
    costCents: command.costCents,
    interruption: command.interruption,
    updatedAt: command.updatedAt,
  };
}

/** The id a run's own report travels under, so a replay is recognisably the same report. */
export function runCommandId(runId: Uuid, status: string): string {
  return `${runId}:row:${status}`;
}
