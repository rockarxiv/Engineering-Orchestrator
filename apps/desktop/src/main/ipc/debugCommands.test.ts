import { DEBUG_SENT_EVENT, type Agent, type Run } from "@eo/core";
import { desc, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { appendRunEvent, createRun as createUnrecordedRun, listAgents, listRunEvents, listRunsForItem, type CreateRunInput } from "../db/repos/index.js";
import { hasRecordedSend } from "../db/repos/runsRepo.js";
import { runs } from "../db/schema.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { openAssistConversation } from "../roles/assist.js";
import { fakePlatform } from "../testing/platform.js";
import { getDebugMode, listDebugAgents, openDebugWindow, RUNS_PER_AGENT, setDebugMode } from "./debugCommands.js";
import { createProject, setSetting } from "../db/repos/index.js";
import { ACTIVE_PROJECT_KEY, activeProjectId } from "./repositoryCommands.js";

/**
 * What fills the debug window, and what guards it (EO-392) — recorded
 * runs only (EO-394).
 */
describe("debug mode's channels", () => {
  let handle: DbHandle;
  let implementer: Agent;
  let reviewer: Agent;
  let system: Agent;

  beforeEach(() => {
    handle = openMigratedTestDb();
    const agents = listAgents(handle.db);
    implementer = agents.find((agent) => agent.role === "implementer")!;
    reviewer = agents.find((agent) => agent.role === "reviewer")!;
    system = agents.find((agent) => agent.role === "system")!;
  });

  afterEach(() => {
    handle.close();
  });

  /** What debug mode writes at a send. The list asks only whether the row is there, never what it holds. */
  const record = (run: Run): Run => {
    appendRunEvent(handle.db, run.id, DEBUG_SENT_EVENT, { purpose: "dispatch", prompt: `sent to ${run.id}` });
    return run;
  };

  /** A run dispatched with debug mode on: the run, and the send recorded for it. */
  const createRun = (db: DbHandle["db"], input: CreateRunInput): Run => record(createUnrecordedRun(db, input));

  const story = (title: string) => createTestItem(handle.db, { type: "story", title, stepId: "todo", projectId: activeProjectId(handle.db) });

  it("is off until somebody turns it on, and answers with what is stored", () => {
    expect(getDebugMode(handle.db)).toEqual({ enabled: false });
    expect(setDebugMode(handle.db, true)).toEqual({ enabled: true });
    expect(getDebugMode(handle.db)).toEqual({ enabled: true });
  });

  it("asks the setting before the platform, so a stale window cannot open what was switched off", () => {
    let asked = 0;
    const platform = {
      ...fakePlatform(),
      openDebug: () => {
        asked += 1;
        return true;
      },
    };

    expect(openDebugWindow(handle.db, platform)).toEqual({ opened: false });
    expect(asked).toBe(0);

    setDebugMode(handle.db, true);
    expect(openDebugWindow(handle.db, platform)).toEqual({ opened: true });
    expect(asked).toBe(1);
  });

  it("lists nobody when nothing has run", () => {
    expect(listDebugAgents(handle.db)).toEqual({ agents: [] });
  });

  it("gives one tab per agent with runs, agents with a run in flight first", () => {
    const first = story("First");
    const second = story("Second");
    // Oldest to newest: the reviewer finished, then the implementer
    // finished, then the reviewer started again and is still going.
    createRun(handle.db, { itemId: first.id, agentId: reviewer.id, action: "review", status: "succeeded" });
    createRun(handle.db, { itemId: first.id, agentId: implementer.id, action: "implement", status: "succeeded" });
    createRun(handle.db, { itemId: second.id, agentId: implementer.id, action: "implement", status: "failed" });
    const live = createRun(handle.db, { itemId: second.id, agentId: reviewer.id, action: "review", status: "running" });

    const { agents } = listDebugAgents(handle.db);

    expect(agents.map((agent) => [agent.name, agent.live])).toEqual([
      [reviewer.name, true],
      [implementer.name, false],
    ]);
    // Each tab's runs, newest first, naming the item each worked on.
    expect(agents[0]?.runs.map((run) => [run.id, run.itemKey, run.status])).toEqual([
      [live.id, second.key, "running"],
      [expect.any(String), first.key, "succeeded"],
    ]);
    expect(agents[1]?.runs.map((run) => run.status)).toEqual(["failed", "succeeded"]);
  });

  it("puts a live agent ahead of one whose run is merely newer", () => {
    const item = story("Only");
    createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "queued" });
    createRun(handle.db, { itemId: item.id, agentId: reviewer.id, action: "review", status: "succeeded" });

    expect(listDebugAgents(handle.db).agents.map((agent) => agent.name)).toEqual([implementer.name, reviewer.name]);
  });

  it("includes the assistant, whose conversations are items on the project", () => {
    const conversation = openAssistConversation(handle.db, activeProjectId(handle.db));
    createRun(handle.db, { itemId: conversation.id, agentId: system.id, action: "assist", status: "running", threadId: "thr-1", provider: system.provider, cwd: "/tmp/wt" });

    const { agents } = listDebugAgents(handle.db);

    expect(agents.map((agent) => agent.role)).toEqual(["system"]);
    expect(agents[0]?.runs[0]).toMatchObject({ action: "assist", threadId: "thr-1", provider: system.provider, cwd: "/tmp/wt", itemId: conversation.id });
  });

  it("keeps a tab for an agent whose last run is older than hundreds of runs by the others", () => {
    // The case a bound across agents loses: one review long ago, then
    // far more implementer runs than any one tab is handed.
    const item = story("Long-lived");
    const old = createRun(handle.db, { itemId: item.id, agentId: reviewer.id, action: "review", status: "succeeded" });
    for (let index = 0; index < 320; index += 1) createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" });

    const { agents } = listDebugAgents(handle.db);

    expect(agents.map((agent) => agent.name)).toEqual([implementer.name, reviewer.name]);
    expect(agents[1]?.runs.map((run) => run.id)).toEqual([old.id]);
    // The busy agent's tab is the one that is shortened, and it says by
    // how much rather than passing fifty off as all of them.
    expect(agents[0]?.runs).toHaveLength(RUNS_PER_AGENT);
    expect(agents[0]?.totalRuns).toBe(320);
    expect(agents[1]?.totalRuns).toBe(1);
  });

  it("marks an agent live for a run in flight that is older than its tab's bound", () => {
    const item = story("Queued long ago");
    createRun(handle.db, { itemId: item.id, agentId: reviewer.id, action: "review", status: "queued" });
    for (let index = 0; index < RUNS_PER_AGENT + 5; index += 1) createRun(handle.db, { itemId: item.id, agentId: reviewer.id, action: "review", status: "succeeded" });
    createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" });

    const { agents } = listDebugAgents(handle.db);

    expect(agents.map((agent) => [agent.name, agent.live])).toEqual([
      [reviewer.name, true],
      [implementer.name, false],
    ]);
  });

  it("answers for the project the board is showing, and for the other one once it is switched", () => {
    const first = createProject(handle.db, { name: "Here", keyPrefix: "HERE" });
    const second = createProject(handle.db, { name: "Elsewhere", keyPrefix: "ELSE" });
    const here = createTestItem(handle.db, { type: "story", title: "Here", stepId: "todo", projectId: first.id });
    const there = createTestItem(handle.db, { type: "story", title: "There", stepId: "todo", projectId: second.id });
    createRun(handle.db, { itemId: here.id, agentId: implementer.id, action: "implement", status: "succeeded" });
    createRun(handle.db, { itemId: there.id, agentId: reviewer.id, action: "review", status: "succeeded" });

    setSetting(handle.db, ACTIVE_PROJECT_KEY, first.id);
    expect(listDebugAgents(handle.db).agents.map((agent) => agent.name)).toEqual([implementer.name]);

    setSetting(handle.db, ACTIVE_PROJECT_KEY, second.id);

    expect(listDebugAgents(handle.db).agents.map((agent) => agent.name)).toEqual([reviewer.name]);
  });

  describe("runs that were not recorded (EO-394)", () => {
    it("lists the recorded run and not the one dispatched while debug mode was off", () => {
      const item = story("Mixed");
      const unrecorded = createUnrecordedRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" });
      appendRunEvent(handle.db, unrecorded.id, "output", { text: "did the work, unobserved" });
      const recorded = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" });
      appendRunEvent(handle.db, recorded.id, "output", { text: "did the work" });
      const before = listRunEvents(handle.db, unrecorded.id);

      const { agents } = listDebugAgents(handle.db);

      expect(agents.map((agent) => agent.name)).toEqual([implementer.name]);
      expect(agents[0]?.runs.map((run) => run.id)).toEqual([recorded.id]);
      expect(agents[0]?.totalRuns).toBe(1);

      // Left out of this window and nowhere else: the item's own runs
      // screen is drawn from `listRunsForItem`, which still has both, and
      // the unrecorded run's log is exactly what it was.
      expect(listRunsForItem(handle.db, item.id).map((run) => run.id)).toEqual([unrecorded.id, recorded.id]);
      expect(listRunEvents(handle.db, unrecorded.id)).toEqual(before);
    });

    it("leaves an unrecorded run out while it is in flight too, and does not call its agent live for it", () => {
      const item = story("In flight");
      createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" });
      createUnrecordedRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "running" });
      createUnrecordedRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "queued" });

      const { agents } = listDebugAgents(handle.db);

      expect(agents.map((agent) => [agent.name, agent.live, agent.totalRuns])).toEqual([[implementer.name, false, 1]]);
      expect(agents[0]?.runs.map((run) => run.status)).toEqual(["succeeded"]);
    });

    it("gives no tab to an agent none of whose runs were recorded", () => {
      const item = story("One of two");
      createUnrecordedRun(handle.db, { itemId: item.id, agentId: reviewer.id, action: "review", status: "running" });
      createUnrecordedRun(handle.db, { itemId: item.id, agentId: reviewer.id, action: "review", status: "succeeded" });
      createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" });

      expect(listDebugAgents(handle.db).agents.map((agent) => agent.name)).toEqual([implementer.name]);
    });

    it("lists nobody when runs exist and none was recorded", () => {
      const item = story("Never on");
      createUnrecordedRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" });
      createUnrecordedRun(handle.db, { itemId: item.id, agentId: reviewer.id, action: "review", status: "running" });

      expect(listDebugAgents(handle.db)).toEqual({ agents: [] });
    });

    it("applies the bound after the filter: recorded runs older than fifty unrecorded ones are still listed", () => {
      const item = story("Debug mode switched off since");
      const older = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" });
      const newer = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "failed" });
      for (let index = 0; index < RUNS_PER_AGENT; index += 1) {
        createUnrecordedRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" });
      }

      const { agents } = listDebugAgents(handle.db);

      expect(agents).toHaveLength(1);
      expect(agents[0]?.runs.map((run) => run.id)).toEqual([newer.id, older.id]);
      expect(agents[0]?.totalRuns).toBe(2);
    });

    it("counts only recorded runs past the bound, so the note about older runs is about recorded ones", () => {
      const item = story("Long recorded history");
      for (let index = 0; index < RUNS_PER_AGENT + 3; index += 1) {
        createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" });
        createUnrecordedRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" });
      }

      const [tab] = listDebugAgents(handle.db).agents;

      expect(tab?.runs).toHaveLength(RUNS_PER_AGENT);
      // Three older recorded runs are not listed — not fifty-six.
      expect(tab?.totalRuns).toBe(RUNS_PER_AGENT + 3);
    });

    it("lists a run from the moment its first send is recorded, and its agent's tab with it", () => {
      const item = story("Just dispatched");
      const run = createUnrecordedRun(handle.db, { itemId: item.id, agentId: reviewer.id, action: "review", status: "running" });
      expect(listDebugAgents(handle.db)).toEqual({ agents: [] });

      record(run);

      const { agents } = listDebugAgents(handle.db);
      expect(agents.map((agent) => [agent.name, agent.live])).toEqual([[reviewer.name, true]]);
      expect(agents[0]?.runs.map((listed) => listed.id)).toEqual([run.id]);
    });

    it("counts a run with several recorded sends once", () => {
      const item = story("Corrected");
      const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" });
      record(run);

      const [tab] = listDebugAgents(handle.db).agents;

      expect(tab?.totalRuns).toBe(1);
      expect(tab?.runs.map((listed) => listed.id)).toEqual([run.id]);
    });

    it("lists a run whose recorded send cannot be parsed: it was recorded, and the window says it cannot read it", () => {
      const item = story("Unreadable");
      const run = createUnrecordedRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" });
      appendRunEvent(handle.db, run.id, DEBUG_SENT_EVENT, "not a record");

      expect(listDebugAgents(handle.db).agents[0]?.runs.map((listed) => listed.id)).toEqual([run.id]);
    });

    it("answers from the index over recorded sends rather than by reading each run's transcript", () => {
      // `idx_run_events_debug_sent` is partial, and SQLite uses a partial
      // index only when the statement itself says `type = 'debug_sent'`.
      // Asked with the very condition the list is built on, the plan must
      // name it — for the run list and for the count behind the tabs.
      const plan = (query: { toSQL(): { sql: string; params: unknown[] } }) => {
        const statement = query.toSQL();
        // Nothing bound: a bound type is one SQLite cannot match to the index.
        expect(statement.params.filter((param) => param === DEBUG_SENT_EVENT)).toEqual([]);
        expect(statement.sql).toContain(`'${DEBUG_SENT_EVENT}'`);
        const inlined = statement.params.reduce<string>((text, param) => text.replace("?", typeof param === "number" ? String(param) : `'${String(param)}'`), statement.sql);
        return handle.db
          .all<{ detail: string }>(sql.raw(`EXPLAIN QUERY PLAN ${inlined}`))
          .map((row) => row.detail)
          .join("\n");
      };

      const listed = plan(handle.db.select({ id: runs.id }).from(runs).where(hasRecordedSend).orderBy(desc(runs.id)).limit(RUNS_PER_AGENT));
      const counted = plan(handle.db.select({ agentId: runs.agentId, runs: sql<number>`count(*)` }).from(runs).where(hasRecordedSend).groupBy(runs.agentId));

      expect(listed).toContain("idx_run_events_debug_sent");
      expect(counted).toContain("idx_run_events_debug_sent");
      // And the index is what the migration says it is: those rows only.
      expect(handle.db.get<{ sql: string }>(sql`select sql from sqlite_master where name = 'idx_run_events_debug_sent'`)?.sql).toMatch(/WHERE `type` = 'debug_sent'/);
    });
  });

  it("leaves out runs EO made itself, which were sent to no backend", () => {
    const item = story("Builtin");
    createRun(handle.db, { itemId: item.id, agentId: null, action: "merge", status: "succeeded" });

    expect(listDebugAgents(handle.db)).toEqual({ agents: [] });
  });
});
