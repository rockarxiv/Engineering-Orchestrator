import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecordPipelineSchema, type StepWatch, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createPipeline, createStep, listStepsForPipeline, setEntryStep } from "../db/repos/index.js";
import { listPipelinesUpdatedSince, upsertReplicaPipeline } from "../db/repos/projectMoveRepo.js";
import { openMigratedTestDb } from "../db/testHelpers.js";

/**
 * The organisation record's copy of a step's keep checking (EO-571).
 *
 * Keep checking travels with the graph — it is what the step does, not a
 * fact about one machine (EO-456) — so a step that never gives up has to
 * arrive on every device still never giving up. Sent the way the record
 * sends it: read off the record's rows, through JSON and the record's
 * schema, and written into a desktop's.
 */

let recordDb: DbHandle;
let desktopDb: DbHandle;

beforeEach(() => {
  recordDb = openMigratedTestDb();
  desktopDb = openMigratedTestDb();
});

afterEach(() => {
  recordDb.close();
  desktopDb.close();
});

/** A pipeline on the record whose one step keeps checking as `watch` says. */
function watchingPipeline(watch: StepWatch): string {
  const pipeline = createPipeline(recordDb.db, { name: "Waiting" });
  createStep(recordDb.db, { id: "wait-step", pipelineId: pipeline.id, position: 0, name: "Wait", type: "builtin", entryAction: "wait_until", watch });
  createStep(recordDb.db, { id: "done-step", pipelineId: pipeline.id, position: 1, name: "Done", type: "user", isTerminal: true });
  setEntryStep(recordDb.db, pipeline.id, "wait-step");
  return pipeline.id;
}

/** The record's pipelines, over the wire and into the desktop. */
function sync(): void {
  for (const pipeline of listPipelinesUpdatedSince(recordDb.db, { ts: 0, id: "" }, 100)) {
    upsertReplicaPipeline(desktopDb.db, RecordPipelineSchema.parse(JSON.parse(JSON.stringify(pipeline))));
  }
}

const watchOn = (db: DbHandle, pipelineId: string) => listStepsForPipeline(db.db, pipelineId as Uuid).find((step) => step.id === "wait-step")?.watch;

describe("a step's keep checking on the organisation's record", () => {
  it("reaches a desktop still never giving up", () => {
    const pipelineId = watchingPipeline({ everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true });
    const sent = listPipelinesUpdatedSince(recordDb.db, { ts: 0, id: "" }, 100).find((pipeline) => pipeline.id === pipelineId)!;
    expect(sent.steps.find((step) => step.id === "wait-step")?.watch).toEqual({ everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true });

    sync();

    expect(watchOn(desktopDb, pipelineId)).toEqual({ everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true });
  });

  it("reaches a desktop with the deadline it has, as before", () => {
    const pipelineId = watchingPipeline({ everyMinutes: 5, giveUpAfterHours: 24 });

    sync();

    expect(watchOn(desktopDb, pipelineId)).toEqual({ everyMinutes: 5, giveUpAfterHours: 24 });
  });
});
