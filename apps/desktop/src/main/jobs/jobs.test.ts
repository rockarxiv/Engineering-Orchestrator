import { LOCAL_PERSON_ID, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  getItem,
  getJob,
  listAllJobs,
  listItemsForProject,
  listJobs,
  listOccurrences,
  listPipelineSteps,
  recordOccurrence,
} from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { fireJob } from "./fire.js";
import { createJob, deleteJob, updateJob } from "./jobs.js";
import { originOfItem } from "./origin.js";
import { JOB_THREAD_KEY_PREFIX, JOB_THREAD_STEP } from "./thread.js";

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

const TEMPLATE = { type: "developer:story", title: "{{job}} for {{date}}", body: "Written by {{job}}." };

function manualJob(overrides: Partial<Parameters<typeof createJob>[1]> = {}) {
  return createJob(handle.db, {
    projectId: null,
    name: "Monday report",
    trigger: { kind: "manual" },
    pipelineId: "default",
    template: TEMPLATE,
    ...overrides,
  });
}

function scheduleJob(schedule: { kind: "daily"; hour: number; minute: number } | { kind: "cron"; expression: string }) {
  return createJob(handle.db, {
    projectId: null,
    name: "Monday report",
    trigger: { kind: "schedule", schedule, timeZone: "Europe/Berlin", catchUpWithinMinutes: 180 },
    pipelineId: "default",
    template: TEMPLATE,
  });
}

describe("creating a job", () => {
  it("gives it a thread on an off-board step, titled after the job", () => {
    const result = manualJob();

    expect(result.ok).toBe(true);
    const job = result.ok ? result.job : undefined;
    const thread = getItem(handle.db, job!.threadItemId as Uuid);
    expect(thread?.title).toBe("Job: Monday report");
    expect(thread?.stepId).toBe(JOB_THREAD_STEP);
    expect(thread?.key.startsWith(`${JOB_THREAD_KEY_PREFIX}-`)).toBe(true);

    // Off-board is the property the story names, and it is the step's
    // own rather than this test's opinion of it.
    const step = listPipelineSteps(handle.db).find((entry) => entry.id === JOB_THREAD_STEP);
    expect(step?.offBoard).toBe(true);
    // On the Discussions pipeline, which is the one that is never a
    // sidebar entry because every step of it is off-board.
    expect(step?.pipelineId).toBe("discussions");
  });

  it("owns it to the local person when nobody says otherwise", () => {
    const result = manualJob();

    expect(result.ok && result.job.ownerId).toBe(LOCAL_PERSON_ID);
  });

  it("refuses a self-firing job with no pipeline or template, and writes nothing", () => {
    const result = createJob(handle.db, { projectId: null, name: "Nightly", trigger: { kind: "manual" } });

    expect(result.ok).toBe(false);
    expect(listJobs(handle.db, null)).toEqual([]);
    // The refusal must not leave a thread behind for a job that does
    // not exist.
    expect(itemsOn(JOB_THREAD_STEP)).toEqual([]);
  });

  it("refuses a template naming a type this project does not have, before creating a thread", () => {
    const result = manualJob({ template: { ...TEMPLATE, type: "local:incident" } });

    expect(result.ok).toBe(false);
    expect(itemsOn(JOB_THREAD_STEP)).toEqual([]);
  });

  it("refuses a nameless job", () => {
    const result = manualJob({ name: "   " });

    expect(result.ok).toBe(false);
  });
});

describe("creating a schedule job", () => {
  it("accepts a simple form and an expression alike", () => {
    expect(scheduleJob({ kind: "daily", hour: 8, minute: 0 }).ok).toBe(true);
    expect(scheduleJob({ kind: "cron", expression: "0 8 * * 1" }).ok).toBe(true);
  });

  it("refuses an expression it cannot read, at the moment it is set up", () => {
    // Not at the first occurrence. A job that cannot fire is a thing
    // somebody set up and then waits on, and the moment to say so is
    // the moment they set it up.
    const refused = scheduleJob({ kind: "cron", expression: "0 8 * *" });

    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.problem).toContain("five fields");
    // And nothing was written — no thread for a job that does not exist.
    expect(itemsOn(JOB_THREAD_STEP)).toEqual([]);
  });

  it("refuses a time zone this machine has never heard of", () => {
    const refused = createJob(handle.db, {
      projectId: null,
      name: "Monday report",
      trigger: { kind: "schedule", schedule: { kind: "daily", hour: 8, minute: 0 }, timeZone: "Europe/Berln", catchUpWithinMinutes: 180 },
      pipelineId: "default",
      template: TEMPLATE,
    });

    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.problem).toContain("Europe/Berln");
  });
});

describe("creating a webhook job", () => {
  const SECRET = "s".repeat(64);

  function webhookJob(path: string, name = "Deploys") {
    return createJob(handle.db, {
      projectId: null,
      name,
      trigger: { kind: "webhook", path, secret: SECRET, mapping: { title: null, body: null, eventKey: null, spec: {} } },
      pipelineId: "default",
      template: TEMPLATE,
    });
  }

  it("takes a path, a secret and a mapping", () => {
    expect(webhookJob("deploys").ok).toBe(true);
  });

  it("refuses a second job at an address that is already taken", () => {
    // One address, one job: the second would be a job whose events all
    // went somewhere else, discovered at the first delivery. Refused at
    // the moment somebody sets it up, which is `createJob`'s own rule.
    webhookJob("deploys");

    const refused = webhookJob("deploys", "Deploys again");

    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.problem).toContain("already receives webhooks at /deploys");
    expect(itemsOn(JOB_THREAD_STEP)).toHaveLength(1);
  });

  it("lets a job keep its own address when something else about it is edited", () => {
    const created = webhookJob("deploys");
    const job = created.ok ? created.job : undefined;

    const renamed = updateJob(handle.db, { jobId: job!.id as Uuid, name: "Production deploys" });

    expect(renamed.ok).toBe(true);
  });
});

describe("deleting a job", () => {
  it("archives its thread rather than deleting it, so what was said stays", () => {
    const created = manualJob();
    const job = created.ok ? created.job : undefined;

    expect(deleteJob(handle.db, job!.id as Uuid)).toEqual({ deleted: true, archivedItemCount: 0 });

    const thread = getItem(handle.db, job!.threadItemId as Uuid);
    expect(thread).toBeDefined();
    expect(thread?.archivedAt).not.toBeNull();
  });

  /**
   * EO-304 let the cascade take the occurrences and this test said so.
   * EO-308 is where that stopped being right: the delete now offers
   * "archive its items" or "keep them", and an item somebody chose to
   * keep reads back what filed it *through* those occurrences. So the
   * row stays as a tombstone — gone from every list, still able to say
   * what it did — which is what invariant #3 asks for everywhere else.
   */
  it("leaves the job out of every list, and its occurrences intact", () => {
    const created = manualJob();
    const job = created.ok ? created.job : undefined;
    recordOccurrence(handle.db, { jobId: job!.id as Uuid, dueAt: 1, status: "skipped", reason: "paused" });

    deleteJob(handle.db, job!.id as Uuid);

    expect(listJobs(handle.db, null)).toEqual([]);
    expect(listAllJobs(handle.db)).toEqual([]);
    expect(listOccurrences(handle.db, job!.id as Uuid)).toHaveLength(1);
    expect(getJob(handle.db, job!.id as Uuid)?.deletedAt).not.toBeNull();
  });

  it("archives every item it filed when that is what was chosen", () => {
    const created = manualJob();
    const job = created.ok ? created.job : undefined;
    const first = fireJob(handle.db, job!).item;
    const second = fireJob(handle.db, job!).item;

    expect(deleteJob(handle.db, job!.id as Uuid, { archiveItems: true })).toEqual({ deleted: true, archivedItemCount: 2 });

    expect(getItem(handle.db, first!.id)?.archivedAt).not.toBeNull();
    expect(getItem(handle.db, second!.id)?.archivedAt).not.toBeNull();
  });

  /**
   * The other half of the choice, and the reason the row is a tombstone:
   * work a person kept has to go on saying where it came from.
   */
  it("leaves the items alone when they are kept, still naming the job", () => {
    const created = manualJob();
    const job = created.ok ? created.job : undefined;
    const filed = fireJob(handle.db, job!).item;

    deleteJob(handle.db, job!.id as Uuid, { archiveItems: false });

    expect(getItem(handle.db, filed!.id)?.archivedAt).toBeNull();
    expect(originOfItem(handle.db, filed!.id)?.jobName).toBe("Monday report");
  });

  it("says so rather than throwing when there is no such job", () => {
    expect(deleteJob(handle.db, "01a0a0af-0000-7000-8000-000000000000" as Uuid)).toEqual({ deleted: false, archivedItemCount: 0 });
  });

  /**
   * The tombstone is a record, not a job. Every door that fires one is
   * closed to it — `fireJob` is where they all arrive, which is why the
   * guard is there rather than at each caller.
   */
  it("files nothing afterwards, whichever door is tried", () => {
    const created = manualJob();
    const job = created.ok ? created.job : undefined;
    deleteJob(handle.db, job!.id as Uuid);

    const result = fireJob(handle.db, getJob(handle.db, job!.id as Uuid)!);

    expect(result.item).toBeNull();
    expect(result.problem).toBe("It has been deleted, so it files nothing.");
  });

  it("refuses a second time — a tombstone is not a job to delete", () => {
    const created = manualJob();
    const job = created.ok ? created.job : undefined;
    deleteJob(handle.db, job!.id as Uuid);

    expect(deleteJob(handle.db, job!.id as Uuid)).toEqual({ deleted: false, archivedItemCount: 0 });
  });
});

/**
 * Every item sitting on a step.
 *
 * Asked of the items table rather than derived from the jobs, so that
 * "the refusal wrote nothing" is a statement about what is on disk and
 * not a restatement of "there is no job".
 */
function itemsOn(stepId: string): string[] {
  return listItemsForProject(handle.db, null)
    .filter((item) => item.stepId === stepId)
    .map((item) => item.id);
}
