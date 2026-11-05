import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listRunsForItem } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { endAllProcessTrees, liveProcessTrees, ProcessTree, TREE_MARKER_VARIABLE } from "../process/processTree.js";
import { createFakeProvider } from "../providers/fake.js";
import { allGone, descendantPids, DESCENDANTS_SNIPPET, owed, sweepUp } from "../testing/escapingDescendants.js";
import { nodeScript } from "../testing/nodeScript.js";
import { createRunSupervisor } from "./runSupervisor.js";

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/**
 * Quitting EO leaves nothing an agent started running (EO-494).
 *
 * Every turn ends its own process tree when EO stops reading it, and
 * that takes as long as the tree makes it: SIGTERM, a grace, SIGKILL.
 * Quitting gives runs two seconds to finish ending and then goes on, so
 * an agent that ignores SIGTERM — or a turn whose ending is still on its
 * way — would otherwise be left to outlive the main process, in its
 * cgroup, as on EO-487.
 *
 * The backend here starts a real process tree with its turn — an agent
 * that ignores SIGTERM, a `setsid sleep 600` backgrounded from a shell
 * that has exited, one in a session of its own with an environment of
 * its own, and one that is both (`escapingDescendants.ts`) — and never
 * ends it: the worst an adapter could do. What is
 * asserted is that once the supervisor's shutdown has returned, none of
 * it is running.
 */
describe("quitting EO (EO-494)", () => {
  let handle: DbHandle;
  let directory: string;
  let item: Item;
  const pids: number[] = [];

  beforeEach(() => {
    handle = openMigratedTestDb();
    directory = mkdtempSync(join(tmpdir(), "eo-quit-"));
    item = createTestItem(handle.db, { type: "story", title: "Quit while an agent works", stepId: "todo" });
  });

  afterEach(async () => {
    sweepUp(pids.splice(0));
    await endAllProcessTrees();
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("ends every process an agent's turn started, a stubborn agent and its setsid descendants included", async () => {
    const pidFile = join(directory, "descendants");
    let agentPid: number | undefined;
    const base = createFakeProvider({ steps: [{ output: "Working on it." }, { sleepMs: 60_000 }] });
    const provider: AgentProvider = {
      ...base,
      start(options) {
        // What an adapter does with its CLI, and nothing of what it does
        // to end one: the tree is started, and only quitting can end it.
        const marker = ProcessTree.newMarker();
        const source = `const pidFile = ${JSON.stringify(pidFile)}; process.on("SIGTERM", () => {}); ${DESCENDANTS_SNIPPET} setInterval(() => {}, 1000);`;
        const agent = spawn(process.execPath, [nodeScript(source)], { env: { ...process.env, [TREE_MARKER_VARIABLE]: marker }, stdio: "ignore", windowsHide: true });
        agentPid = agent.pid;
        new ProcessTree(agent, marker);
        return base.start(options);
      },
    };
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS });

    const running = supervisor.runOnce();
    const descendants = await descendantPids(pidFile);
    pids.push(agentPid!, ...descendants.values());
    // Every one, the env -i setsid one that only a cgroup can say is the
    // agent's included, wherever agents are contained (`owed`).
    const all = [agentPid!, ...owed(descendants)];

    await supervisor.shutdown();

    // Already gone when shutdown returns: a moment's allowance for the
    // kernel to reap, nothing a quitting process would wait out.
    expect(await allGone(all, 250)).toBe(true);
    expect(liveProcessTrees()).toBe(0);
    // And the run was the one quitting stopped, not one that ended some other way.
    await running;
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("cancelled");
  });
});
