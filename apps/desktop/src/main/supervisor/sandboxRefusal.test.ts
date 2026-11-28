import type { SandboxAvailability } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listAgents, listCommentsForItem, listRunsForItem, updateAgent } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * A sandboxed agent's sandbox asked about before every turn of a run
 * (EO-935), the corrective one included: a correction reuses the run's
 * attachment, and the machine can stop being able to sandbox while the
 * turn before it ran.
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

const CAN: SandboxAvailability = { available: true, how: "bubblewrap and socat" };
const CANNOT: SandboxAvailability = {
  available: false,
  reason: "Claude's sandbox on Linux needs bubblewrap and socat, and bubblewrap (bwrap) is not installed on this machine.",
  fix: "Install bubblewrap (bwrap) (for example `sudo apt install bubblewrap`), then check again.",
};

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

/** A backend whose first result fails its schema, so the run asks for a correction; every resume is counted. */
function invalidThenValid() {
  const resumes: string[] = [];
  let starts = 0;
  return {
    resumes,
    starts: () => starts,
    provider: {
      async *start() {
        starts += 1;
        yield { type: "thread_started" as const, threadId: "t1" };
        yield { type: "result" as const, data: { nope: true } };
      },
      async *resume(_threadId: string, message: string) {
        resumes.push(message);
        yield { type: "result" as const, data: validImplementResult };
      },
    },
  };
}

function sandboxedImplementer(): void {
  const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  updateAgent(handle.db, implementer.id, { config: { ...implementer.config, sandboxed: true } });
}

describe("a sandboxed run's corrective turn (EO-935)", () => {
  it("is refused, and never sent, when the sandbox stopped being able to start during the turn before it", async () => {
    sandboxedImplementer();
    const item = createTestItem(handle.db, { type: "story", title: "Rate limiting", stepId: "todo" });
    const backend = invalidThenValid();
    const answers = [CAN, CANNOT];
    const asked: string[] = [];
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: backend.provider,
      limits: LIMITS,
      sandboxAvailability: async (agent) => {
        asked.push(agent.name);
        return answers.shift() ?? CANNOT;
      },
    });

    await supervisor.runOnce();

    // Asked for the first turn and again for the correction.
    expect(asked).toHaveLength(2);
    expect(backend.starts()).toBe(1);
    expect(backend.resumes).toEqual([]);
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs.map((run) => run.status)).toEqual(["awaiting_input"]);
    const told = listCommentsForItem(handle.db, item.id).map((comment) => comment.body).join("\n");
    expect(told).toContain("sandbox cannot start on this machine, so EO did not start the run");
    expect(told).toContain(CANNOT.reason);
    expect(told).toContain(CANNOT.fix);
  });

  it("is sent when the sandbox can still start", async () => {
    sandboxedImplementer();
    const item = createTestItem(handle.db, { type: "story", title: "Rate limiting", stepId: "todo" });
    const backend = invalidThenValid();
    let asked = 0;
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: backend.provider,
      limits: LIMITS,
      sandboxAvailability: async () => {
        asked += 1;
        return CAN;
      },
    });

    await supervisor.runOnce();

    expect(asked).toBe(2);
    expect(backend.resumes).toHaveLength(1);
    expect(listRunsForItem(handle.db, item.id).map((run) => run.status)).toEqual(["succeeded"]);
  });
});
