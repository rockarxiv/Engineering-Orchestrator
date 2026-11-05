import { RecordRunCommandSchema } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listAgents } from "../db/repos/agentsRepo.js";
import { createRun, getRun, updateRun } from "../db/repos/runsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { asRunCommand, runPatchFrom } from "./runCommand.js";

describe("a run's report to the record", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("carries why a run was cut short, so the record's attempt count leaves it out too", () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "queued" });
    updateRun(handle.db, run.id, { status: "cancelled", interruption: "quit", endedAt: Date.now() });

    const sent = RecordRunCommandSchema.parse(JSON.parse(JSON.stringify(asRunCommand(getRun(handle.db, run.id)!, "cmd-1", 0))));

    expect(sent.interruption).toBe("quit");
    expect(runPatchFrom(sent).interruption).toBe("quit");
  });

  it("reads an older device's report, which says nothing about it, as no interruption", () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "queued" });
    const older: Record<string, unknown> = { ...asRunCommand(getRun(handle.db, run.id)!, "cmd-2", 0) };
    delete older["interruption"];

    expect(runPatchFrom(RecordRunCommandSchema.parse(older)).interruption).toBeNull();
  });
});
