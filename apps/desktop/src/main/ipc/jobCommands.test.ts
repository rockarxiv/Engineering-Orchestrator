import type { IpcPayload, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { archivePipeline, listItemsForProject, listJobs, listOccurrences } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { openAssistConversation } from "../roles/assist.js";
import { recordItemsFromConversation } from "../jobs/fromDiscussion.js";
import { createJobCommand, deleteJobCommand, getJobCommand, jobPlacementCommand, listJobsCommand, runJobNowCommand, updateJobCommand } from "./jobCommands.js";
import { getItemDetail, listInbox, listItemSummaries } from "./domainQueries.js";

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

const TEMPLATE = { type: "developer:story", title: "{{job}} for {{date}}", body: null };

/**
 * The machine facts the two saves ask for (EO-330, ARCHITECTURE.md, "Where a job runs").
 *
 * `api_key` and no personal secrets, which is the shape of a machine
 * nothing binds to itself — so every job here is placeable in both
 * directions and these tests go on being about what they were about.
 * `placement.test.ts` is where the greying is held to account.
 */
const JOBS = { facts: async () => ({ authKind: () => "api_key" as const }) };

async function create(overrides: Partial<IpcPayload<"jobs:create">> = {}) {
  return createJobCommand(handle.db, JOBS, {
    projectId: null,
    name: "Monday report",
    trigger: { kind: "manual" },
    pipelineId: "default",
    template: TEMPLATE,
    ...overrides,
  });
}

describe("jobs:create", () => {
  it("makes the job and its thread, and lists it", async () => {
    const result = await create();

    expect(result.problem).toBeNull();
    expect(result.job?.name).toBe("Monday report");
    expect(listJobsCommand(handle.db, { projectId: null }).jobs.map((job) => job.id)).toEqual([result.job?.id]);
  });

  it("answers with the reason rather than throwing", async () => {
    const result = await create({ pipelineId: null, template: null });

    expect(result.job).toBeNull();
    expect(result.problem).not.toBeNull();
  });
});

describe("jobs:runNow", () => {
  it("creates exactly one item and one fired occurrence", async () => {
    const job = (await create()).job!;
    const before = listItemsForProject(handle.db, null).length;

    const result = runJobNowCommand(handle.db, undefined, { jobId: job.id });

    expect(result.fired).toBe(true);
    expect(result.problem).toBeNull();
    expect(listItemsForProject(handle.db, null).length).toBe(before + 1);
    const occurrences = listOccurrences(handle.db, job.id as Uuid);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.status).toBe("fired");
    expect(occurrences[0]?.itemId).toBe(result.itemId);
  });

  it("names the job on the item it created", async () => {
    // What the detail rail draws (EO-304): the item says where it came
    // from, read back through the occurrence that created it.
    const job = (await create()).job!;

    const result = runJobNowCommand(handle.db, undefined, { jobId: job.id });

    const detail = getItemDetail(handle.db, { itemId: result.itemId! });
    expect(detail?.item.origin).toMatchObject({ jobId: job.id, jobName: "Monday report", trigger: "manual" });
  });

  it("fires once per press, not once per job", async () => {
    const job = (await create()).job!;

    runJobNowCommand(handle.db, undefined, { jobId: job.id });
    runJobNowCommand(handle.db, undefined, { jobId: job.id });

    expect(listOccurrences(handle.db, job.id as Uuid)).toHaveLength(2);
  });

  it("refuses a from-discussion job, because its items come from somebody pressing Create", async () => {
    const conversation = openAssistConversation(handle.db, null);
    recordItemsFromConversation(handle.db, conversation, [
      createTestItem(handle.db, { type: "story", title: "Page the importer", stepId: "todo", projectId: null }),
    ]);
    const job = listJobs(handle.db, null)[0]!;

    const result = runJobNowCommand(handle.db, undefined, { jobId: job.id });

    expect(result.fired).toBe(false);
    expect(result.problem).toContain("Create");
    // The one the Create wrote, and no more.
    expect(listOccurrences(handle.db, job.id as Uuid)).toHaveLength(1);
  });

  it("says so rather than throwing for a job that is gone", async () => {
    const result = runJobNowCommand(handle.db, undefined, { jobId: "01a0a0af-0000-7000-8000-000000000000" });

    expect(result).toMatchObject({ fired: false, occurrence: null, itemId: null });
    expect(result.problem).not.toBeNull();
  });
});

describe("a guard about a job", () => {
  it("reaches the inbox the app actually draws, as a message to the owner", async () => {
    // Not the messages table but the query the Inbox screen calls.
    const job = (await create()).job!;
    // The pipeline goes out from under a job that was valid when it was
    // made: the guard case with no item to comment on.
    archivePipeline(handle.db, "default");

    runJobNowCommand(handle.db, undefined, { jobId: job.id });

    const inbox = listInbox(handle.db, null);
    expect(inbox.items).toEqual([]);
    expect(inbox.messages.map((message) => [message.jobId, message.source])).toEqual([[job.id, "job_failed"]]);
    expect(inbox.messages[0]?.body).toContain(job.name);
    expect(inbox.summary.openCount).toBe(1);
  });
});

/**
 * What the board reads to narrow itself and to name a card's origin on
 * hover (EO-308, ARCHITECTURE.md, "The inbox, the archive and jobs").
 *
 * The filter is a predicate over the summaries the board already has
 * (`matchesBoardQuery`), so "exactly the job's items" is only true if
 * every card carries what filed it — this is that half, in the main
 * process, where the renderer's fixtures cannot vouch for it.
 */
describe("what a job filed, on the board's own rows", () => {
  it("names the job and what the occurrence cost on every card it filed, and nothing on the rest", async () => {
    const job = (await create()).job!;
    const filed = runJobNowCommand(handle.db, undefined, { jobId: job.id }).itemId!;
    const typed = createTestItem(handle.db, { type: "story", title: "Typed by hand", stepId: "todo", projectId: null });

    const summaries = listItemSummaries(handle.db, null).items;

    expect(summaries.find((item) => item.id === filed)?.origin).toMatchObject({ jobId: job.id, jobName: "Monday report", costCents: 0 });
    expect(summaries.find((item) => item.id === typed.id)?.origin).toBeNull();
  });
});

/**
 * The original design's own sentence: "a developer with no jobs never sees the entry".
 * The sidebar draws that entry from `jobs:list`, and a conversation's
 * job — which nobody set up, nobody can edit and nothing can run — would
 * put it in front of every developer who has ever pressed Create in a
 * chat.
 */
describe("which jobs the Jobs screen keeps", () => {
  it("leaves a conversation's job out of the list and off its own page", async () => {
    const conversation = openAssistConversation(handle.db, null);
    recordItemsFromConversation(handle.db, conversation, [
      createTestItem(handle.db, { type: "story", title: "Page the importer", stepId: "todo", projectId: null }),
    ]);
    const fromChat = listJobs(handle.db, null)[0]!;
    const kept = (await create()).job!;

    expect(listJobsCommand(handle.db, { projectId: null }).jobs.map((job) => job.id)).toEqual([kept.id]);
    expect(getJobCommand(handle.db, { jobId: fromChat.id }).job).toBeNull();
  });
});

describe("jobs:get", () => {
  it("answers with the job and its history", async () => {
    const job = (await create()).job!;
    runJobNowCommand(handle.db, undefined, { jobId: job.id });

    const answer = getJobCommand(handle.db, { jobId: job.id });

    expect(answer.job?.id).toBe(job.id);
    expect(answer.occurrences).toHaveLength(1);
    expect(answer.occurrences[0]?.itemKey).not.toBeNull();
  });

  /**
   * A tombstone is not a page to open. The row survives so that the
   * items it filed can still name it (`deleteJob`); a page that opened
   * would offer Run now and a paused toggle for something that no
   * longer fires.
   */
  it("answers with nothing for a job that has been deleted", async () => {
    const job = (await create()).job!;
    deleteJobCommand(handle.db, { jobId: job.id, archiveItems: false });

    expect(getJobCommand(handle.db, { jobId: job.id }).job).toBeNull();
  });
});

describe("jobs:update", () => {
  it("changes what a person changed and leaves the rest", async () => {
    const job = (await create()).job!;

    const result = await updateJobCommand(handle.db, JOBS, { jobId: job.id, name: "Weekly digest" });

    expect(result.problem).toBeNull();
    expect(result.job?.name).toBe("Weekly digest");
    // Untouched, because the patch said nothing about it.
    expect(result.job?.template).toEqual(TEMPLATE);
  });

  it("answers with the reason rather than throwing", async () => {
    const job = (await create()).job!;

    const result = await updateJobCommand(handle.db, JOBS, { jobId: job.id, pipelineId: "no-such-pipeline" });

    expect(result.job).toBeNull();
    expect(result.problem).toBe("That pipeline no longer exists.");
  });

  it("will not run, pause or be read once it has been deleted", async () => {
    const job = (await create()).job!;
    deleteJobCommand(handle.db, { jobId: job.id, archiveItems: false });

    expect(runJobNowCommand(handle.db, undefined, { jobId: job.id }).problem).toBe("That job no longer exists.");
    expect((await updateJobCommand(handle.db, JOBS, { jobId: job.id, name: "Anything" })).problem).toBe("That job no longer exists.");
  });
});

describe("jobs:delete", () => {
  /**
   * The acceptance criterion, both halves. "Archive its items" puts
   * away everything the job filed; "keep them" leaves that work on the
   * board, and it goes on naming the job — which is what the tombstone
   * `deleted_at` is for.
   */
  it("archives every item it filed when that is what was chosen", async () => {
    const job = (await create()).job!;
    runJobNowCommand(handle.db, undefined, { jobId: job.id });
    runJobNowCommand(handle.db, undefined, { jobId: job.id });

    expect(deleteJobCommand(handle.db, { jobId: job.id, archiveItems: true })).toEqual({ deleted: true, archivedItemCount: 2 });

    expect(listItemsForProject(handle.db, null).filter((item) => item.archivedAt === null)).toEqual([]);
  });

  it("leaves them where they are otherwise, still naming the job", async () => {
    const job = (await create()).job!;
    const itemId = runJobNowCommand(handle.db, undefined, { jobId: job.id }).itemId!;

    deleteJobCommand(handle.db, { jobId: job.id, archiveItems: false });

    const detail = getItemDetail(handle.db, { itemId });
    expect(detail?.item.origin?.jobName).toBe("Monday report");
  });

  it("removes the job and archives its thread", async () => {
    const job = (await create()).job!;

    expect(deleteJobCommand(handle.db, { jobId: job.id, archiveItems: false })).toEqual({ deleted: true, archivedItemCount: 0 });

    expect(listJobsCommand(handle.db, { projectId: null }).jobs).toEqual([]);
    // Archived, so it is out of the project — and still there, with
    // everything that was said on it.
    expect(listItemsForProject(handle.db, null).some((item) => item.id === job.threadItemId)).toBe(false);
  });
});

/**
 * Where a job runs, asked and changed (EO-330, ARCHITECTURE.md, "Where a job runs").
 *
 * The command layer's half of placement. What the *reasons* are is
 * `jobs/placement.test.ts` and what they say is
 * `packages/core/src/placement.test.ts`; these are about the two things
 * a handler owes: an answer a screen can draw, and a refusal that holds
 * whether or not the screen was the thing that asked.
 */
describe("jobs:placement", () => {
  /** A machine signed in to Codex personally, which is the design's first reason. */
  const PERSONAL = {
    facts: async () => ({ authKind: () => "subscription" as const, backendLabel: () => "Codex" }),
  };

  it("answers with the reasons the organisation server is greyed", async () => {
    const job = (await create()).job!;

    const answer = await jobPlacementCommand(handle.db, PERSONAL, { jobId: job.id });

    expect(answer.placement?.runsOn).toBe("device");
    expect(answer.placement?.machineBound.map((reason) => reason.kind)).toContain("personal-login");
    expect(answer.placement?.serverBound).toEqual([]);
  });

  it("names no machine on an installation with no organisation", async () => {
    // Solo: the control is hidden and the page says what it has always
    // said, so there is nothing here to name.
    const job = (await create()).job!;

    expect((await jobPlacementCommand(handle.db, JOBS, { jobId: job.id })).machine).toBeNull();
  });

  it("answers nulls for a job the Jobs screen does not keep, and for one that is gone", async () => {
    const conversation = openAssistConversation(handle.db, null);
    recordItemsFromConversation(handle.db, conversation, [
      createTestItem(handle.db, { type: "story", title: "Page the importer", stepId: "todo", projectId: null }),
    ]);
    const fromChat = listJobs(handle.db, null)[0]!;
    const deleted = (await create()).job!;
    deleteJobCommand(handle.db, { jobId: deleted.id, archiveItems: false });

    expect(await jobPlacementCommand(handle.db, JOBS, { jobId: fromChat.id })).toEqual({ placement: null, machine: null });
    expect(await jobPlacementCommand(handle.db, JOBS, { jobId: deleted.id })).toEqual({ placement: null, machine: null });
  });
});

describe("moving a job to a place it cannot run", () => {
  const PERSONAL = {
    facts: async () => ({ authKind: () => "subscription" as const, backendLabel: () => "Codex" }),
  };

  it("is refused with every reason and its fix, and writes nothing", async () => {
    // The design's rule for a lock, applied to a placement: the refusal is
    // made here and not only on the screen, because the system agent's
    // admin MCP server reaches this same handler.
    const job = (await create()).job!;

    const result = await updateJobCommand(handle.db, PERSONAL, { jobId: job.id, runsOn: "server" });

    expect(result.job).toBeNull();
    expect(result.problem).toContain("organisation server");
    expect(result.problem).toContain("personal login");
    expect(result.problem).toContain("nothing was saved");
    expect(getJobCommand(handle.db, { jobId: job.id }).job?.runsOn).toBe("device");
  });

  it("goes through once nothing is in the way", async () => {
    const job = (await create()).job!;

    const result = await updateJobCommand(handle.db, JOBS, { jobId: job.id, runsOn: "server" });

    expect(result.problem).toBeNull();
    expect(result.job?.runsOn).toBe("server");
  });

  it("does not refuse a save that re-sends the place the job is already in", async () => {
    // A guard on a choice, not on a row: work already running somewhere
    // is not made to stop because a login was reported personal this
    // morning. What a save may not do is *move* it.
    const job = (await create()).job!;

    const result = await updateJobCommand(handle.db, PERSONAL, { jobId: job.id, runsOn: "device", name: "Weekly digest" });

    expect(result.problem).toBeNull();
    expect(result.job?.name).toBe("Weekly digest");
  });

  it("refuses a job being set up somewhere it could not run", async () => {
    // `createJob`'s own rule — the moment to say a job cannot work is
    // the moment somebody sets it up — so the check happens before
    // anything is written.
    const result = await createJobCommand(handle.db, PERSONAL, {
      projectId: null,
      name: "Monday report",
      trigger: { kind: "manual" },
      pipelineId: "default",
      template: TEMPLATE,
      runsOn: "server",
    });

    expect(result.job).toBeNull();
    expect(result.problem).toContain("personal login");
    expect(listJobsCommand(handle.db, { projectId: null }).jobs).toEqual([]);
  });
});
