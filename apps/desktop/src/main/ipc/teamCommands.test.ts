import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ipcContract, StepTeamSchema, TEAM_PARTICIPANT_ACTION, type Item, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createAgent } from "../db/repos/agentsRepo.js";
import { createRun, updateRun } from "../db/repos/runsRepo.js";
import { endTeamSession, openTeamSession, startTeamAttempt } from "../db/repos/teamSessionsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import type { EngineHandle } from "./domainCommands.js";
import { cancelTeamSessionCommand, retryTeamSessionCommand, teamSessionsCommand } from "./teamCommands.js";

/**
 * The team session channels (EO-849) as their callers get them: answers
 * that hold to the contract, and every refusal a sentence rather than a
 * throw, which a packaged build would turn into "Internal error".
 */

const TEAM = StepTeamSchema.parse({
  coordination: "independent",
  participants: [{ key: "security", role: "reviewer", instructions: "Look for ways in." }],
  outcomes: [{ key: "clear", label: "Nothing found" }],
  completion: { rules: [], fallback: "approved" },
});

let handle: DbHandle;
let item: Item;

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "Review the change", stepId: "todo" });
});

afterEach(() => handle.close());

/** An engine that must not be asked: every refusal here comes before it. */
const untouched = new Proxy({}, { get: (_target, key) => { throw new Error(`The engine was asked for ${String(key)}.`); } }) as EngineHandle;

describe("the team session channels (EO-849)", () => {
  it("answers an item no team worked with no sessions, and one with a session in the contract's shape", () => {
    expect(ipcContract["items:teamSessions"].response.parse(teamSessionsCommand(handle.db, { itemId: item.id }))).toEqual({ sessions: [] });
    const agent = createAgent(handle.db, { name: "Rita", role: "reviewer", provider: "claude", model: null, instructions: "Review." }).id as Uuid;
    const parent = createRun(handle.db, { itemId: item.id, agentId: null, action: "review", stepId: "todo", status: "running" });
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM, runId: parent.id });
    const run = createRun(handle.db, { itemId: item.id, agentId: agent, action: TEAM_PARTICIPANT_ACTION, stepId: "todo", status: "running", provider: "claude" });
    updateRun(handle.db, run.id, { startedAt: 1 });
    startTeamAttempt(handle.db, { sessionId: session.id, assignmentKey: "security", role: "reviewer", agentId: agent, instructions: "Look.", runId: run.id });
    const answer = ipcContract["items:teamSessions"].response.parse(teamSessionsCommand(handle.db, { itemId: item.id }));
    expect(answer.sessions.map((one) => [one.id, one.state, one.assignments.length])).toEqual([[session.id, "running", 1]]);
  });

  it("refuses an unknown session, and a settled one, in words", () => {
    expect(cancelTeamSessionCommand(handle.db, untouched, { sessionId: "nope" })).toEqual({ cancelled: false, problem: "There is no such team session." });
    expect(retryTeamSessionCommand(handle.db, untouched, { sessionId: "nope" })).toEqual({ retried: false, keys: [], problem: "There is no such team session." });

    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM });
    endTeamSession(handle.db, { sessionId: session.id, status: "cancelled" });
    const cancelled = cancelTeamSessionCommand(handle.db, untouched, { sessionId: session.id });
    expect(cancelled.cancelled).toBe(false);
    expect(cancelled.problem).toContain("already ended (cancelled)");
    const retried = retryTeamSessionCommand(handle.db, untouched, { sessionId: session.id });
    expect(retried.retried).toBe(false);
    expect(retried.problem).toContain("never runs again");
  });

  it("says so when no engine runs work here, rather than pretending to stop a team", () => {
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM });
    expect(cancelTeamSessionCommand(handle.db, undefined, { sessionId: session.id })).toEqual({ cancelled: false, problem: "EO is not running work on this desktop, so it cannot stop a team here." });
  });
});
