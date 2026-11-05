import type { DebugAgent, DebugRun, IpcResponse, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { listAgents } from "../db/repos/agentsRepo.js";
import { listAgentsWithRecordedRunsOnProject, listRecentRecordedRunsOfAgentOnProject } from "../db/repos/runsRepo.js";
import { readDebugMode, writeDebugMode } from "../debug/debugMode.js";
import { runView } from "./domainQueries.js";
import type { Platform } from "./platform.js";
import { emitPush } from "./push.js";
import { activeProjectId } from "./repositoryCommands.js";

/**
 * Debug mode's four channels (EO-392).
 *
 * **Everything here reads, except the switch.** The window offers no
 * control that changes a run, an agent or a thread (invariants #1 and
 * #11): it lists, and what it lists it reads out of `runs` and — through
 * `runs:listEvents`, the transcript's own channel — `run_events`.
 */

/**
 * How many of one agent's recorded runs its tab is handed, newest first.
 *
 * Per agent, so the bound shortens a tab and can never cost an agent
 * its tab. A bound rather than a page: this is an instrument for looking
 * at what just happened, the tab says how many older runs it is not
 * showing, and each of those is reached from its item's own runs screen.
 *
 * Applied after the "was it recorded" filter, in the query (EO-394):
 * fifty unrecorded runs do not use the bound up.
 */
export const RUNS_PER_AGENT = 50;

export function getDebugMode(db: Db): IpcResponse<"debug:getMode"> {
  return { enabled: readDebugMode(db) };
}

/**
 * Turns it on or off. Every window is told, because the F12 listener
 * lives in each of them and the one that did not flip the switch has to
 * hear about it.
 */
export function setDebugMode(db: Db, enabled: boolean): IpcResponse<"debug:setMode"> {
  const stored = writeDebugMode(db, enabled);
  emitPush("config:changed", {});
  return { enabled: stored };
}

/**
 * Opens the window, while debug mode is on.
 *
 * Asked again here rather than trusted from the renderer that pressed
 * F12: the setting is the gate, and a window whose copy of it is a
 * moment stale must not be able to open what was just switched off.
 */
export function openDebugWindow(db: Db, platform: Platform): IpcResponse<"debug:window"> {
  if (!readDebugMode(db)) return { opened: false };
  return { opened: platform.openDebug() };
}

/**
 * One tab per agent with a recorded run in the project the board is
 * showing.
 *
 * **Recorded** (EO-394): a run with at least one `debug_sent` row in
 * `run_events`. Debug mode is off by default, so most runs of a real
 * installation have none, and listing them buried the few that do under
 * rows with nothing to show. They are left out here, in the main
 * process and in the query, rather than in the window — which sees only
 * the bounded list and the selected run's events, and so could neither
 * count them nor reach a recorded run past fifty unrecorded ones. An
 * agent with no recorded run has no tab; the counts, the newest run and
 * `live` are all of recorded runs only. Nothing is removed: every run is
 * still on the runs screen of the work it belongs to.
 *
 * **Every** such agent: the tabs are counted from the runs themselves,
 * unbounded, and only the runs inside each tab are bounded
 * (`RUNS_PER_AGENT`). Agents with a run in flight come first, then the
 * rest by their most recent run. A retired agent keeps its tab: its runs
 * happened, and what it was sent is as readable as anybody's.
 */
export function listDebugAgents(db: Db): IpcResponse<"debug:runs"> {
  const projectId = activeProjectId(db) as Uuid | null;
  const agentsById = new Map(listAgents(db).map((agent) => [agent.id as string, agent]));

  const tabs = listAgentsWithRecordedRunsOnProject(db, projectId)
    // Live first; within each half, the newest run first. Ids are
    // UUIDv7, so comparing them is comparing when the runs were made.
    .sort((a, b) => Number(b.live) - Number(a.live) || (a.newestRunId < b.newestRunId ? 1 : a.newestRunId > b.newestRunId ? -1 : 0))
    .map((tab): DebugAgent => {
      const agent = agentsById.get(tab.agentId);
      const name = agent?.name ?? "unknown agent";
      const runs = listRecentRecordedRunsOfAgentOnProject(db, projectId, tab.agentId, RUNS_PER_AGENT).map(
        ({ run, itemKey, itemTitle }): DebugRun => ({ ...runView(db, run, name), itemId: run.itemId, itemKey, itemTitle, provider: run.provider, cwd: run.cwd }),
      );
      return { agentId: tab.agentId, name, role: agent?.role ?? "", provider: agent?.provider ?? "", live: tab.live, totalRuns: tab.runs, runs };
    });

  return { agents: tabs };
}
