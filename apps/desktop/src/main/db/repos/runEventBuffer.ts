import { eq, sql } from "drizzle-orm";
import type { Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { runEvents } from "../schema.js";

export interface RunEventBufferOptions {
  /** Flush once this many events are buffered. */
  maxBatchSize?: number;
  /** Flush at least this often, in ms, regardless of batch size. */
  flushIntervalMs?: number;
}

export interface RunEventBuffer {
  /**
   * Buffers an event; does not touch the DB until a flush. Answers the
   * `seq` it was given, which is what it will be stored under.
   */
  append: (runId: Uuid, type: string, payload: unknown) => number;
  /** Writes every buffered event in one transaction. Safe to call with an empty buffer. */
  flush: () => void;
  /** Stops the flush timer and does a final flush. Anything appended after this is lost. */
  dispose: () => void;
}

interface PendingEvent {
  runId: string;
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
}

/**
 * Batches run_events writes — a chatty agent emits thousands of events,
 * and one write per event thrashes the disk (ARCHITECTURE.md, "`run_events` is the durability
 * substrate"). seq is allocated
 * per-run in memory, not via a DB query per event; the DB is only queried
 * once per run (lazily, on first touch) to continue correctly if this run
 * already has persisted events from a previous process.
 */
export function createRunEventBuffer(db: Db, options: RunEventBufferOptions = {}): RunEventBuffer {
  const maxBatchSize = options.maxBatchSize ?? 500;
  const flushIntervalMs = options.flushIntervalMs ?? 200;

  const pending: PendingEvent[] = [];
  const nextSeqByRun = new Map<string, number>();

  function allocateSeq(runId: Uuid): number {
    let next = nextSeqByRun.get(runId);
    if (next === undefined) {
      const row = db
        .select({ maxSeq: sql<number | null>`max(${runEvents.seq})` })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .get();
      next = (row?.maxSeq ?? -1) + 1;
    }
    nextSeqByRun.set(runId, next + 1);
    return next;
  }

  function append(runId: Uuid, type: string, payload: unknown): number {
    const seq = allocateSeq(runId);
    pending.push({ runId, seq, ts: Date.now(), type, payload });
    if (pending.length >= maxBatchSize) {
      flush();
    }
    return seq;
  }

  function flush(): void {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    // One multi-row INSERT per flush, not one statement per event — that's
    // the whole point of batching (ARCHITECTURE.md, "`run_events` is the durability substrate").
    db.transaction((tx) => {
      tx.insert(runEvents).values(batch).run();
    });
  }

  const timer = setInterval(flush, flushIntervalMs);
  timer.unref?.();

  return {
    append,
    flush,
    dispose: () => {
      clearInterval(timer);
      flush();
    },
  };
}
