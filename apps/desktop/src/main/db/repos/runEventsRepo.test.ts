import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SEARCH_INTERCEPTION_EVENT, type Run } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db, type DbHandle } from "../client.js";
import { runMigrations } from "../migrate.js";
import { listAgents } from "./agentsRepo.js";
import { createRunEventBuffer } from "./runEventBuffer.js";
import { appendRunEventAt, appendSyncedRunEvents, countSearchInterceptions, hasOwnRunEventsAfter, listRunEvents, listRunEventsFrom, listRunEventsSince } from "./runEventsRepo.js";
import { createRun } from "./runsRepo.js";

import { createTestItem } from "../testHelpers.js";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

describe("a line on a run more than one device writes (EO-618)", () => {
  const AT = 1_800_000_000_000;
  let handle: DbHandle;
  let db: Db;

  beforeEach(() => {
    handle = openDb(":memory:");
    runMigrations(handle.db, migrationsFolder);
    db = handle.db;
  });

  afterEach(() => {
    handle.close();
  });

  function newRunId() {
    const item = createTestItem(db, { type: "story", title: "A story", stepId: "todo" });
    return createRun(db, { itemId: item.id, agentId: null, action: "wait_until" }).id;
  }

  it("takes the number it is given, whatever else the run holds", () => {
    const id = newRunId();
    appendSyncedRunEvents(db, id, "another-device", [{ seq: AT, ts: AT, type: "output", payload: {} }]);

    appendRunEventAt(db, id, { seq: AT + 300_000, ts: AT }, "output", { n: 2 });

    expect(listRunEvents(db, id).map((event) => event.seq)).toEqual([AT, AT + 300_000]);
  });

  it("goes past what this device holds, for a second line under one lease and because a line behind the bookmark is never sent", () => {
    const id = newRunId();
    appendSyncedRunEvents(db, id, "another-device", [{ seq: AT, ts: AT, type: "output", payload: {} }]);

    appendRunEventAt(db, id, { seq: AT - 60_000, ts: AT }, "output", { n: 2 });
    appendRunEventAt(db, id, { seq: AT - 60_000, ts: AT }, "output", { n: 3 });

    expect(listRunEvents(db, id).map((event) => event.seq)).toEqual([AT, AT + 1, AT + 2]);
  });

  it("leaves gaps a reader pages across", () => {
    const id = newRunId();
    appendRunEventAt(db, id, { seq: AT, ts: AT }, "output", { n: 1 });
    appendRunEventAt(db, id, { seq: AT + 300_000, ts: AT }, "output", { n: 2 });

    expect(listRunEventsFrom(db, id, AT + 1, 10).map((event) => event.payload)).toEqual([{ n: 2 }]);
  });

  it("is owed to the record only if this device wrote it", () => {
    const id = newRunId();
    appendRunEventAt(db, id, { seq: 100, ts: 100 }, "output", {});
    appendSyncedRunEvents(db, id, "", [{ seq: 200, ts: 200, type: "output", payload: {} }]);

    expect(hasOwnRunEventsAfter(db, id, 99)).toBe(true);
    expect(hasOwnRunEventsAfter(db, id, 100)).toBe(false);
  });
});

describe("the record's transcript feed (EO-618)", () => {
  const FUTURE = 8_000_000_000_000;
  let handle: DbHandle;
  let db: Db;

  beforeEach(() => {
    handle = openDb(":memory:");
    runMigrations(handle.db, migrationsFolder);
    db = handle.db;
  });

  afterEach(() => {
    handle.close();
  });

  function newRunId() {
    const item = createTestItem(db, { type: "story", title: "A story", stepId: "todo" });
    return createRun(db, { itemId: item.id, agentId: null, action: "wait_until" }).id;
  }

  const line = (seq: number, ts = seq) => ({ seq, ts, type: "output", payload: { seq } });

  it("delivers a line written before a reader's cursor when it arrives after it", () => {
    const id = newRunId();
    appendSyncedRunEvents(db, id, "dana", [line(200)]);
    const [read] = listRunEventsSince(db, { ts: 0, runId: "", seq: -1 }, 10);

    // Anna's line was written earlier and reaches the record now.
    appendSyncedRunEvents(db, id, "anna", [line(100)]);

    const late = listRunEventsSince(db, { ts: read!.position, runId: read!.runId, seq: read!.seq }, 10);
    expect(late.map((event) => event.seq)).toEqual([100]);
    expect(late[0]?.ts).toBe(100);
  });

  it("goes past a device clock that ran ahead, so what arrives after it is not behind it", () => {
    const id = newRunId();
    appendSyncedRunEvents(db, id, "fast", [line(1, FUTURE)]);
    appendSyncedRunEvents(db, id, "fast", [line(2, FUTURE)]);
    const [first, second] = listRunEventsSince(db, { ts: 0, runId: "", seq: -1 }, 10);
    expect(second!.position).toBeGreaterThan(first!.position);

    appendSyncedRunEvents(db, id, "slow", [line(3, 5)]);

    expect(listRunEventsSince(db, { ts: second!.position, runId: id, seq: 2 }, 10).map((event) => event.seq)).toEqual([3]);
  });

  it("keeps a cursor taken before lines had an arrival: what was read is not read again, and what comes next is", () => {
    const id = newRunId();
    const buffer = createRunEventBuffer(db);
    buffer.append(id, "output", { n: 0 });
    buffer.append(id, "output", { n: 1 });
    buffer.dispose();
    const [, last] = listRunEvents(db, id);

    expect(listRunEventsSince(db, { ts: last!.ts, runId: id, seq: last!.seq }, 10)).toEqual([]);

    appendSyncedRunEvents(db, id, "anna", [line(5, 1)]);

    expect(listRunEventsSince(db, { ts: last!.ts, runId: id, seq: last!.seq }, 10).map((event) => event.seq)).toEqual([5]);
  });

  it("does not move a line that is sent again", () => {
    const id = newRunId();
    appendSyncedRunEvents(db, id, "anna", [line(1)]);
    const [read] = listRunEventsSince(db, { ts: 0, runId: "", seq: -1 }, 10);

    expect(appendSyncedRunEvents(db, id, "anna", [line(1)])).toBe(0);

    expect(listRunEventsSince(db, { ts: read!.position, runId: id, seq: 1 }, 10)).toEqual([]);
  });
});

/**
 * Counting the times an agent was redirected (EO-168).
 *
 * The count is the whole feature. An interception that fires and leaves
 * no trace makes two entirely different runs look identical — one where
 * the hook never fired, and one where it fired and the agent went on
 * searching the tree — and this project has already shipped that mistake
 * twice, once by advertising a capability agents had been told was
 * unavailable and once by reporting that a mechanism fired when nothing
 * could show it had.
 *
 * So both worlds are written out here as runs, and the query is asked to
 * tell them apart. Everything goes in through the same append-only
 * buffer the supervisor writes with, because a test that inserted rows
 * its own way would be measuring its own fixture.
 */
describe("countSearchInterceptions", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openDb(":memory:");
    runMigrations(handle.db, migrationsFolder);
  });

  afterEach(() => {
    handle.close();
  });

  function newRun(db: Db): Run {
    const item = createTestItem(db, { type: "story", title: "A story", stepId: "todo" });
    return createRun(db, { itemId: item.id, agentId: listAgents(db)[0]!.id, action: "implement" });
  }

  /** One interception, as the Claude adapter emits it. */
  const interception = (needle: string, callId = "toolu_1") => ({
    type: SEARCH_INTERCEPTION_EVENT,
    tool: "Bash",
    callId,
    kind: "symbol",
    needle,
    suggestion: `That searched the whole checkout for \`${needle}\`. … Your command was not blocked and has run.`,
  });

  const search = (command: string) => ({ type: "tool_call", name: "Bash", args: { command } });

  it("counts nothing for a run where the interception never fired", () => {
    // A run full of broad searches and not one of them interrupted. The
    // hook was never delivered — no index, no vocabulary, a backend with
    // nowhere to put one — and the honest reading of this log is that
    // the agent was never told anything. A wiring problem.
    const run = newRun(handle.db);
    const buffer = createRunEventBuffer(handle.db);
    buffer.append(run.id, "tool_call", search("grep -rn transitionItem ."));
    buffer.append(run.id, "tool_call", search("rg RunEvent apps packages"));
    buffer.append(run.id, "tool_call", search("find . -name '*.test.ts'"));
    buffer.dispose();

    expect(countSearchInterceptions(handle.db, run.id)).toBe(0);
  });

  it("counts every firing on a run where it fired and the agent searched on regardless", () => {
    // The same three searches, the same shell-heavy transcript, and the
    // opposite diagnosis: EO spoke twice and was ignored. A persuasion
    // problem, and nothing but these rows distinguishes it from the run
    // above.
    const run = newRun(handle.db);
    const buffer = createRunEventBuffer(handle.db);
    buffer.append(run.id, "tool_call", search("grep -rn transitionItem ."));
    buffer.append(run.id, SEARCH_INTERCEPTION_EVENT, interception("transitionItem", "toolu_1"));
    buffer.append(run.id, "tool_call", search("rg RunEvent apps packages"));
    buffer.append(run.id, SEARCH_INTERCEPTION_EVENT, interception("RunEvent", "toolu_2"));
    buffer.append(run.id, "tool_call", search("cat packages/core/src/execution.ts"));
    buffer.dispose();

    expect(countSearchInterceptions(handle.db, run.id)).toBe(2);
  });

  it("counts one run's interceptions and not its neighbour's", () => {
    // Concurrency is 1 today (invariant #10) but the log is not: a
    // item's second attempt is a second run against the same items
    // table, and a count that summed across them would report a figure
    // no single run produced.
    const quiet = newRun(handle.db);
    const nudged = newRun(handle.db);
    const buffer = createRunEventBuffer(handle.db);
    buffer.append(quiet.id, "tool_call", search("pnpm test"));
    buffer.append(nudged.id, SEARCH_INTERCEPTION_EVENT, interception("transitionItem"));
    buffer.dispose();

    expect(countSearchInterceptions(handle.db, quiet.id)).toBe(0);
    expect(countSearchInterceptions(handle.db, nudged.id)).toBe(1);
  });

  it("leaves what was suggested readable, so a count can be turned into a reason", () => {
    // The count answers "how many times was the agent nudged". What it
    // took, or did not, is read off the payloads beside it — which is
    // why the suggestion is on the record rather than merely tallied.
    const run = newRun(handle.db);
    const buffer = createRunEventBuffer(handle.db);
    buffer.append(run.id, SEARCH_INTERCEPTION_EVENT, interception("transitionItem"));
    buffer.dispose();

    const events = listRunEvents(handle.db, run.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(SEARCH_INTERCEPTION_EVENT);
    expect(events[0]?.payload).toMatchObject({ tool: "Bash", callId: "toolu_1", kind: "symbol", needle: "transitionItem" });
  });
});
