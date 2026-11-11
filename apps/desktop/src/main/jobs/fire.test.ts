import { LOCAL_PERSON_ID, type Job, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { archivePipeline, getItem, getPipeline, listCommentsForItem, listOccurrences, openMentionsForHuman } from "../db/repos/index.js";
import { messagesAboutJob, openMigratedTestDb } from "../db/testHelpers.js";
import { openMessagesFor } from "../messages/messages.js";
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

  it("records a failed occurrence and tells the owner, rather than creating half an item", () => {
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

  it("sends that guard to the job's owner as a message about the job, and posts no comment", () => {
    const monday = job();
    archivePipeline(handle.db, "default");

    const result = fireJob(handle.db, monday);

    const messages = messagesAboutJob(handle.db, monday.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ recipientId: LOCAL_PERSON_ID, jobId: monday.id, source: "job_failed", options: null });
    // Names the job and the reason.
    expect(messages[0]?.body).toBe(`"Monday report" could not run. ${result.problem}`);
    // Invariant #8 where there is no item: a message, not a comment.
    expect(listCommentsForItem(handle.db, monday.threadItemId as Uuid)).toEqual([]);
    expect(openMentionsForHuman(handle.db)).toEqual([]);
  });

  it("puts that guard in the owner's inbox", () => {
    const monday = job();
    archivePipeline(handle.db, "default");

    fireJob(handle.db, monday);

    expect(openMessagesFor(handle.db, undefined).map((message) => message.jobId)).toEqual([monday.id]);
  });

  it("tells the owner when the template no longer resolves to a type", () => {
    const monday = job();
    const broken: Job = { ...monday, template: { type: "developer:no-such-type", title: "{{job}}", body: null } };

    const result = fireJob(handle.db, broken);

    expect(result.item).toBeNull();
    expect(listOccurrences(handle.db, monday.id as Uuid)[0]?.status).toBe("failed");
    const messages = messagesAboutJob(handle.db, monday.id);
    expect(messages.map((message) => message.source)).toEqual(["job_failed"]);
    expect(messages[0]?.body).toContain("Monday report");
    expect(messages[0]?.body).toContain(result.problem!);
  });

  it("writes nothing to the job's thread however often it fails", () => {
    const monday = job();
    archivePipeline(handle.db, "default");

    fireJob(handle.db, monday);
    fireJob(handle.db, monday);

    expect(getItem(handle.db, monday.threadItemId as Uuid)?.archivedAt).toBeNull();
    expect(listCommentsForItem(handle.db, monday.threadItemId as Uuid)).toEqual([]);
    expect(messagesAboutJob(handle.db, monday.id)).toHaveLength(2);
    expect(listOccurrences(handle.db, monday.id as Uuid)).toHaveLength(2);
  });
});
