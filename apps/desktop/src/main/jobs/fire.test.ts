import { LOCAL_PERSON_ID, type Job, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  archivePipeline,
  getItem,
  getPipeline,
  listCommentsForItem,
  listMentionsForComment,
  listOccurrences,
  openMentionsForHuman,
} from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { fireJob } from "./fire.js";
import { createJob } from "./jobs.js";

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

const TEMPLATE = { type: "developer:story", title: "{{job}} for {{date}}", body: "Filed by {{job}}." };

function job(overrides: Partial<Parameters<typeof createJob>[1]> = {}): Job {
  const result = createJob(handle.db, {
    projectId: null,
    name: "Monday report",
    trigger: { kind: "manual" },
    pipelineId: "default",
    template: TEMPLATE,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.problem);
  return result.job;
}

describe("firing a job", () => {
  it("creates one item from the template and one fired occurrence", () => {
    const monday = job();
    const dueAt = new Date(2026, 8, 14, 9, 0).getTime();

    const result = fireJob(handle.db, monday, { dueAt });

    expect(result.problem).toBeNull();
    expect(result.item?.title).toBe("Monday report for 2026-09-14");
    expect(result.item?.body).toBe("Filed by Monday report.");
    const occurrences = listOccurrences(handle.db, monday.id as Uuid);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.status).toBe("fired");
    expect(occurrences[0]?.dueAt).toBe(dueAt);
    expect(occurrences[0]?.itemId).toBe(result.item?.id);
    expect(occurrences[0]?.firedAt).not.toBeNull();
  });

  it("files it on the pipeline's entry step, in the owner's name", () => {
    const monday = job();

    const result = fireJob(handle.db, monday);

    expect(result.item?.pipelineId).toBe("default");
    // Entry rather than "the lowest position": reordering the columns
    // must never re-route what a job files.
    expect(result.item?.stepId).toBe(getPipeline(handle.db, "default")?.entryStepId);
    // The owner's, not the presser's — the work fills their inbox and
    // draws on their budget.
    expect(result.item?.createdBy).toBe(LOCAL_PERSON_ID);
  });

  it("records a failed occurrence and tells the thread, rather than creating half an item", () => {
    const monday = job();
    // The pipeline is deleted out from under a job that was valid when
    // it was made — which is exactly the case a check at creation
    // cannot cover.
    archivePipeline(handle.db, "default");

    const result = fireJob(handle.db, monday);

    expect(result.item).toBeNull();
    expect(result.problem).toContain("deleted");
    const occurrences = listOccurrences(handle.db, monday.id as Uuid);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.status).toBe("failed");
    expect(occurrences[0]?.reason).toBe(result.problem);
    expect(occurrences[0]?.itemId).toBeNull();
  });

  it("posts that guard on the job's thread, from the engine, mentioning the owner", () => {
    const monday = job();
    archivePipeline(handle.db, "default");

    fireJob(handle.db, monday);

    const comments = listCommentsForItem(handle.db, monday.threadItemId as Uuid);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.authorType).toBe("engine");
    expect(comments[0]?.body).toContain("Monday report");
    // Invariant #8 with invariant #4: the guard ends in a comment, on
    // the one channel there is, aimed at the person who owns the job.
    const mentions = listMentionsForComment(handle.db, comments[0]!.id);
    expect(mentions.map((mention) => [mention.targetType, mention.targetId])).toEqual([["human", LOCAL_PERSON_ID]]);
  });

  it("puts that guard in the owner's inbox", () => {
    const monday = job();
    archivePipeline(handle.db, "default");

    fireJob(handle.db, monday);

    const inbox = openMentionsForHuman(handle.db);
    expect(inbox.map((entry) => entry.comment.itemId)).toEqual([monday.threadItemId]);
  });

  it("leaves the thread item itself off-board and alive, so the guard has somewhere to land next time", () => {
    const monday = job();
    archivePipeline(handle.db, "default");

    fireJob(handle.db, monday);
    fireJob(handle.db, monday);

    expect(getItem(handle.db, monday.threadItemId as Uuid)?.archivedAt).toBeNull();
    expect(listCommentsForItem(handle.db, monday.threadItemId as Uuid)).toHaveLength(2);
    expect(listOccurrences(handle.db, monday.id as Uuid)).toHaveLength(2);
  });
});
