import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent, Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db, type DbHandle } from "../client.js";
import { runMigrations } from "../migrate.js";
import { listAgents } from "./agentsRepo.js";
import { createRunEventBuffer } from "./runEventBuffer.js";
import { listRunEvents } from "./runEventsRepo.js";
import { createRun } from "./runsRepo.js";

import { createTestItem } from "../testHelpers.js";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function seedItemAndAgent(db: Db): { item: Item; agent: Agent } {
  const item = createTestItem(db, { type: "story", title: "A story", stepId: "todo" });
  const agent = listAgents(db)[0]!;
  return { item, agent };
}

describe("createRunEventBuffer", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openDb(":memory:");
    runMigrations(handle.db, migrationsFolder);
  });

  afterEach(() => {
    handle.close();
  });

  it("writes 10,000 events in one batch, with contiguous seq and no gaps", () => {
    const { item, agent } = seedItemAndAgent(handle.db);
    const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement" });
    const buffer = createRunEventBuffer(handle.db);

    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      buffer.append(run.id, "stdout", { line: i });
    }
    buffer.flush();
    const elapsedMs = performance.now() - start;

    // A ceiling, not a benchmark. What it is here to catch is a buffer that
    // has stopped batching — a transaction per event, or a rewrite that is
    // quadratic in what it already holds — and either is slower than this by
    // orders of magnitude, not by a factor of two. The tight number this
    // started with measured the runner instead: 10,000 events take ~200ms on
    // a developer's machine and went over a second on a loaded hosted one,
    // failing a release for hardware.
    expect(elapsedMs).toBeLessThan(15_000);

    const events = listRunEvents(handle.db, run.id);
    expect(events).toHaveLength(10_000);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 10_000 }, (_, i) => i));

    buffer.dispose();
  });

  it("auto-flushes once the batch size threshold is reached", () => {
    const { item, agent } = seedItemAndAgent(handle.db);
    const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement" });
    // Interval effectively disabled so only the size threshold can trigger a flush here.
    const buffer = createRunEventBuffer(handle.db, { maxBatchSize: 10, flushIntervalMs: 60_000 });

    for (let i = 0; i < 25; i++) buffer.append(run.id, "stdout", { line: i });

    // Two full batches (20 events) auto-flushed; 5 remain buffered.
    expect(listRunEvents(handle.db, run.id)).toHaveLength(20);

    buffer.flush();
    expect(listRunEvents(handle.db, run.id)).toHaveLength(25);

    buffer.dispose();
  });

  it("auto-flushes on the interval even below the batch size threshold", () => {
    vi.useFakeTimers();
    try {
      const { item, agent } = seedItemAndAgent(handle.db);
      const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement" });
      const buffer = createRunEventBuffer(handle.db, { maxBatchSize: 500, flushIntervalMs: 200 });

      buffer.append(run.id, "stdout", { line: 0 });
      expect(listRunEvents(handle.db, run.id)).toHaveLength(0);

      vi.advanceTimersByTime(200);
      expect(listRunEvents(handle.db, run.id)).toHaveLength(1);

      buffer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues seq correctly for a run with events already persisted by a previous buffer", () => {
    const { item, agent } = seedItemAndAgent(handle.db);
    const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement" });

    const firstBuffer = createRunEventBuffer(handle.db);
    firstBuffer.append(run.id, "stdout", { line: "a" });
    firstBuffer.append(run.id, "stdout", { line: "b" });
    firstBuffer.dispose();

    // A fresh buffer, as if the app restarted mid-run and resumed it.
    const secondBuffer = createRunEventBuffer(handle.db);
    secondBuffer.append(run.id, "stdout", { line: "c" });
    secondBuffer.dispose();

    const events = listRunEvents(handle.db, run.id);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("dispose() flushes remaining events and stops the interval", () => {
    vi.useFakeTimers();
    try {
      const { item, agent } = seedItemAndAgent(handle.db);
      const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement" });
      const buffer = createRunEventBuffer(handle.db, { flushIntervalMs: 50 });

      buffer.append(run.id, "stdout", { line: 0 });
      buffer.dispose();
      expect(listRunEvents(handle.db, run.id)).toHaveLength(1);

      // If the interval weren't cleared, this would throw trying to flush
      // against a buffer whose db is still open but shouldn't be touched.
      vi.advanceTimersByTime(500);
      expect(listRunEvents(handle.db, run.id)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createRunEventBuffer crash safety", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "eo-run-event-buffer-"));
    dbPath = join(tempDir, "eo.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("a crash mid-stream leaves a valid, readable partial log — no corruption, no gaps in what was flushed", () => {
    const handle = openDb(dbPath);
    runMigrations(handle.db, migrationsFolder);
    const { item, agent } = seedItemAndAgent(handle.db);
    const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement" });

    // Interval disabled: only the size threshold auto-flushes here, so we
    // can deterministically leave a known number of events unflushed.
    const buffer = createRunEventBuffer(handle.db, { maxBatchSize: 50, flushIntervalMs: 60_000 });
    for (let i = 0; i < 120; i++) buffer.append(run.id, "stdout", { line: i });

    // Simulate a hard kill: no dispose(), no final flush — just stop.
    handle.close();

    const reopened = openDb(dbPath);
    const events = listRunEvents(reopened.db, run.id);

    // Two full 50-event batches were auto-flushed; the last 20 were still
    // buffered and are lost — expected for anything not yet flushed.
    expect(events).toHaveLength(100);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i));

    reopened.close();
  });
});
