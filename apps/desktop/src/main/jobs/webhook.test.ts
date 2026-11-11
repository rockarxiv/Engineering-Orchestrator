import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WEBHOOK_TIMESTAMP_TOLERANCE_MS, type Job, type Uuid } from "@eo/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import {
  archivePipeline,
  getItem,
  heldEventCount,
  listAttachmentsForItem,
  listCommentsForItem,
  listItems,
  listJobEvents,
  listOccurrences,
  openMentionsForHuman,
  setJobPaused,
} from "../db/repos/index.js";
import { pipelines } from "../db/schema.js";
import { messagesAboutJob, openMigratedTestDb } from "../db/testHelpers.js";
import { createJob } from "./jobs.js";
import { MAX_HELD_EVENTS, WEBHOOK_PAYLOAD_NOTE, receiveWebhook, releaseHeldWebhookEvents, webhookAnswerWord } from "./webhook.js";
import { mintWebhookSecret, signWebhook } from "./webhookSignature.js";

/**
 * The webhook endpoint (EO-332, `ARCHITECTURE.md`,
 * "Webhooks").
 *
 * The clock is driven throughout rather than waited on: the cap is
 * stated in items per *hour*, and a test that could only observe it by
 * waiting one is a test nobody runs.
 */

let handle: DbHandle;
let storageRoot: string;
let storage: AttachmentStorage;

/** A real one, minted the way the Job page will mint it. */
const SECRET = mintWebhookSecret();
const TEMPLATE = { type: "developer:story", title: "Deploy for {{date}}", body: "Filed by {{job}}." };

/** A fixed moment to hang the whole clock off, rather than "now". */
const T = new Date(2026, 8, 22, 9, 0, 0).getTime();

beforeEach(() => {
  handle = openMigratedTestDb();
  storageRoot = mkdtempSync(join(tmpdir(), "eo-webhook-"));
  storage = new AttachmentStorage(storageRoot);
});

afterEach(() => {
  handle.close();
  rmSync(storageRoot, { recursive: true, force: true });
});

function webhookJob(overrides: Partial<Parameters<typeof createJob>[1]> = {}): Job {
  const result = createJob(handle.db, {
    projectId: null,
    name: "Deploys",
    trigger: { kind: "webhook", path: "deploys", secret: SECRET, mapping: { title: null, body: null, eventKey: null, spec: {} } },
    pipelineId: "default",
    template: TEMPLATE,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.problem);
  return result.job;
}

interface DeliveryOptions {
  now?: number;
  /** What the sender put in the header, where it is not the moment it sent. */
  timestamp?: number;
  /** A signature computed over something else — what a forgery looks like. */
  secret?: string;
  path?: string;
}

function deliver(body: string, options: DeliveryOptions = {}) {
  const now = options.now ?? T;
  const timestamp = options.timestamp ?? now;
  return receiveWebhook(
    handle.db,
    {
      path: options.path ?? "deploys",
      rawBody: body,
      signature: signWebhook(options.secret ?? SECRET, timestamp, body),
      timestamp: String(timestamp),
      now,
    },
    { storage },
  );
}

/**
 * Everything the job's guards told its owner — what a guard reaching a
 * person looks like (EO-729). Asserts on the way that none of it went to
 * the job's thread, and every one is the owner's and about the job.
 */
function ownerMessages(job: Job): string[] {
  expect(listCommentsForItem(handle.db, job.threadItemId as Uuid)).toEqual([]);
  const told = messagesAboutJob(handle.db, job.id);
  for (const message of told) expect(message).toMatchObject({ recipientId: job.ownerId, jobId: job.id });
  return told.map((message) => message.body);
}

function itemCount(): number {
  return listItems(handle.db).filter((item) => item.title.startsWith("Deploy")).length;
}

describe("a signed delivery", () => {
  it("creates exactly one item, records it, and attaches the payload", async () => {
    const job = webhookJob();

    const answer = await deliver('{"id":"evt-1"}');

    expect(answer.status).toBe(202);
    expect(answer.outcome).toBe("created");
    expect(itemCount()).toBe(1);

    const events = listJobEvents(handle.db, job.id as Uuid);
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe("created");
    expect(events[0]?.payload).toBe('{"id":"evt-1"}');
    expect(events[0]?.itemId).toBe(answer.itemId);

    // The occurrence is the firing, as it is for every other trigger —
    // which is what makes the item's provenance readable and the cap
    // countable.
    const occurrences = listOccurrences(handle.db, job.id as Uuid);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.status).toBe("fired");

    // ARCHITECTURE.md, "Webhooks": the payload is a file on the item, never the item's own text.
    const attachments = listAttachmentsForItem(handle.db, answer.itemId as Uuid);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.name).toBe("payload.json");
    expect(listCommentsForItem(handle.db, answer.itemId as Uuid).map((comment) => comment.body)).toContain(WEBHOOK_PAYLOAD_NOTE);
  });

  it("files it in the job owner's name, so its mentions reach that person", async () => {
    const job = webhookJob();

    const answer = await deliver('{"id":"evt-1"}');

    expect(getItem(handle.db, answer.itemId as Uuid)?.createdBy).toBe(job.ownerId);
  });

  it("reads the title, the body and the spec out of the payload where the mapping says to", async () => {
    webhookJob({
      trigger: {
        kind: "webhook",
        path: "deploys",
        secret: SECRET,
        mapping: { title: "/issue/summary", body: "/issue/description", eventKey: "/id", spec: { severity: "/issue/severity" } },
      },
    });

    const answer = await deliver('{"id":"evt-9","issue":{"summary":"Disk full","description":"on web-2","severity":3}}');

    const item = getItem(handle.db, answer.itemId as Uuid);
    expect(item?.title).toBe("Disk full");
    expect(item?.body).toBe("on web-2");
    expect(item?.spec).toEqual({ severity: 3 });
  });

  it("leaves the template's own text standing where the mapping names nothing", async () => {
    webhookJob();

    const answer = await deliver('{"id":"evt-1"}');

    expect(getItem(handle.db, answer.itemId as Uuid)?.title).toBe("Deploy for 2026-09-22");
  });
});

describe("the same delivery twice", () => {
  it("writes a deduplicated row and creates no second item", async () => {
    const job = webhookJob();
    await deliver('{"id":"evt-1"}');

    const second = await deliver('{"id":"evt-1"}');

    expect(second.status).toBe(200);
    expect(second.outcome).toBe("deduplicated");
    expect(itemCount()).toBe(1);
    expect(listJobEvents(handle.db, job.id as Uuid).map((event) => event.outcome)).toEqual(["deduplicated", "created"]);
    // A guard that fired when no item exists ends in a message to the
    // person who must act (invariant #8), and in no comment.
    expect(ownerMessages(job).some((body) => body.includes("had this event already"))).toBe(true);
    expect(messagesAboutJob(handle.db, job.id).map((message) => message.source)).toEqual(["job_webhook"]);
  });

  it("recognises a retry by the sender's own id even when the body is re-rendered", async () => {
    const job = webhookJob({
      trigger: { kind: "webhook", path: "deploys", secret: SECRET, mapping: { title: null, body: null, eventKey: "/id", spec: {} } },
    });

    await deliver('{"id":"evt-1","attempt":1}');
    const retry = await deliver('{"id":"evt-1","attempt":2}');

    expect(retry.outcome).toBe("deduplicated");
    expect(itemCount()).toBe(1);
    expect(listJobEvents(handle.db, job.id as Uuid)).toHaveLength(2);
  });
});

describe("a delivery EO will not believe", () => {
  it("records a bad signature, answers 401, and says nothing to the owner", async () => {
    const job = webhookJob();

    const answer = await deliver('{"id":"evt-1"}', { secret: mintWebhookSecret() });

    expect(answer.status).toBe(401);
    expect(answer.outcome).toBe("rejected_signature");
    expect(itemCount()).toBe(0);
    const events = listJobEvents(handle.db, job.id as Uuid);
    expect(events).toHaveLength(1);
    // The body is not kept: an unverified payload is not this job's
    // event, and storing it would let a stranger grow the record.
    expect(events[0]?.payload).toBe("");
    // Never posted, so an attacker cannot fill an inbox from outside.
    expect(ownerMessages(job)).toEqual([]);
    expect(openMentionsForHuman(handle.db)).toEqual([]);
  });

  it("records a stale timestamp as a replay, answers 401, and says nothing to the owner", async () => {
    const job = webhookJob();
    const stale = T - WEBHOOK_TIMESTAMP_TOLERANCE_MS - 1;

    // Signed correctly, and over the stale timestamp — which is the
    // only forgery worth testing, since the timestamp is inside the
    // signature.
    const answer = await deliver('{"id":"evt-1"}', { timestamp: stale });

    expect(answer.status).toBe(401);
    expect(answer.outcome).toBe("rejected_replay");
    expect(listJobEvents(handle.db, job.id as Uuid).map((event) => event.outcome)).toEqual(["rejected_replay"]);
    expect(ownerMessages(job)).toEqual([]);
  });

  it("answers both refusals with the same word, so neither says which half failed", () => {
    expect(webhookAnswerWord("rejected_signature")).toBe(webhookAnswerWord("rejected_replay"));
  });

  it("records a signed body it cannot read as malformed, and does say so", async () => {
    const job = webhookJob();

    const answer = await deliver("not json at all");

    expect(answer.status).toBe(400);
    expect(answer.outcome).toBe("malformed");
    expect(itemCount()).toBe(0);
    // Signed by somebody holding the secret, so the body is kept in full.
    expect(listJobEvents(handle.db, job.id as Uuid)[0]?.payload).toBe("not json at all");
    expect(ownerMessages(job).some((body) => body.includes("could not read"))).toBe(true);
  });

  it("says so when the declared event key is not in the payload", async () => {
    const job = webhookJob({
      trigger: { kind: "webhook", path: "deploys", secret: SECRET, mapping: { title: null, body: null, eventKey: "/delivery", spec: {} } },
    });

    const answer = await deliver('{"id":"evt-1"}');

    expect(answer.outcome).toBe("malformed");
    expect(listJobEvents(handle.db, job.id as Uuid)[0]?.reason).toContain("/delivery");
    expect(itemCount()).toBe(0);
  });

  it("answers a path no job owns with nothing at all", async () => {
    webhookJob();

    const answer = await deliver('{"id":"evt-1"}', { path: "nobody" });

    expect(answer.status).toBe(404);
    expect(answer.outcome).toBeNull();
    expect(answer.event).toBeNull();
  });
});

describe("a burst beyond the cap", () => {
  /** Forty deliveries inside one minute, each its own event. */
  async function burst(now: number): Promise<void> {
    for (let index = 0; index < 40; index += 1) {
      await deliver(JSON.stringify({ id: `evt-${index}` }), { now: now + index * 1000 });
    }
  }

  /**
   * The three moments the clock is driven to.
   *
   * An hour after the burst *ends*, then an hour after each release —
   * because the cap is a rolling hour and the ten just filed are
   * themselves inside the next one.
   */
  const AN_HOUR = 60 * 60_000;
  const FIRST_RELEASE = T + 60_000 + AN_HOUR;
  const SECOND_RELEASE = FIRST_RELEASE + AN_HOUR + 1;
  const THIRD_RELEASE = SECOND_RELEASE + AN_HOUR + 1;

  it("creates ten items and holds thirty, then releases them in order over the hours", async () => {
    const job = webhookJob({ maxItemsPerHour: 10 });

    await burst(T);

    expect(itemCount()).toBe(10);
    const events = listJobEvents(handle.db, job.id as Uuid);
    expect(events.filter((event) => event.outcome === "created")).toHaveLength(10);
    expect(events.filter((event) => event.outcome === "held")).toHaveLength(30);

    // One comment for the burst rather than thirty: the queue is spoken
    // for once and the count lives on the Events tab (ARCHITECTURE.md, "The inbox, the archive and
    // jobs").
    expect(ownerMessages(job).filter((body) => body.includes("is waiting"))).toHaveLength(1);

    // An hour on, ten more — and exactly ten, because the ten just
    // filed are themselves inside the hour that follows.
    await releaseHeldWebhookEvents(handle.db, { storage, now: FIRST_RELEASE });
    expect(itemCount()).toBe(20);
    await releaseHeldWebhookEvents(handle.db, { storage, now: FIRST_RELEASE + 1 });
    expect(itemCount()).toBe(20);

    await releaseHeldWebhookEvents(handle.db, { storage, now: SECOND_RELEASE });
    expect(itemCount()).toBe(30);
    await releaseHeldWebhookEvents(handle.db, { storage, now: THIRD_RELEASE });
    expect(itemCount()).toBe(40);

    // Nothing left waiting, and the thirty held rows are still there
    // saying what happened when they arrived: the release appended,
    // it did not rewrite.
    expect(listJobEvents(handle.db, job.id as Uuid).filter((event) => event.outcome === "held")).toHaveLength(30);
    expect(listJobEvents(handle.db, job.id as Uuid).filter((event) => event.outcome === "created")).toHaveLength(40);
  });

  it("releases them oldest first, so the tenth is never overtaken by the fortieth", async () => {
    const job = webhookJob({ maxItemsPerHour: 10 });
    await burst(T);

    await releaseHeldWebhookEvents(handle.db, { storage, now: FIRST_RELEASE });

    // Twenty filed: the ten that arrived under the cap, and the next
    // ten in the order they arrived. Nothing from the tail.
    const filed = listJobEvents(handle.db, job.id as Uuid)
      .filter((event) => event.outcome === "created")
      .map((event) => (JSON.parse(event.payload) as { id: string }).id)
      .sort((left, right) => Number(left.slice(4)) - Number(right.slice(4)));
    expect(filed).toEqual(Array.from({ length: 20 }, (_, index) => `evt-${index}`));
  });

  it("holds nothing when the job names no cap", async () => {
    const job = webhookJob();

    await burst(T);

    expect(itemCount()).toBe(40);
    expect(listJobEvents(handle.db, job.id as Uuid).filter((event) => event.outcome === "held")).toHaveLength(0);
  });
});

describe("a job that cannot file work this minute", () => {
  it("holds a paused job's events rather than dropping them, and files them on the resume", async () => {
    const job = webhookJob();
    setJobPaused(handle.db, job.id as Uuid, T, "by hand");

    const answer = await deliver('{"id":"evt-1"}', { now: T + 1000 });

    expect(answer.status).toBe(202);
    expect(answer.outcome).toBe("held");
    expect(itemCount()).toBe(0);
    expect(ownerMessages(job).some((body) => body.includes("paused"))).toBe(true);

    setJobPaused(handle.db, job.id as Uuid, null);
    await releaseHeldWebhookEvents(handle.db, { storage, now: T + 2000 });

    expect(itemCount()).toBe(1);
  });

  it("holds events for a job whose pipeline has gone, and says so once", async () => {
    const job = webhookJob();
    archivePipeline(handle.db, "default");

    await deliver('{"id":"evt-1"}', { now: T });
    await deliver('{"id":"evt-2"}', { now: T + 1000 });

    expect(listJobEvents(handle.db, job.id as Uuid).filter((event) => event.outcome === "held")).toHaveLength(2);
    expect(ownerMessages(job).filter((body) => body.includes("has been deleted"))).toHaveLength(1);
    // The tick passes over it in silence rather than writing a row a
    // minute about a state that has not changed.
    await releaseHeldWebhookEvents(handle.db, { storage, now: T + 2000 });
    expect(listJobEvents(handle.db, job.id as Uuid)).toHaveLength(2);
  });

  it("refuses rather than holds once the queue is full", async () => {
    const job = webhookJob();
    setJobPaused(handle.db, job.id as Uuid, T, "by hand");
    for (let index = 0; index < MAX_HELD_EVENTS; index += 1) {
      await deliver(JSON.stringify({ id: index }), { now: T + index });
    }

    const answer = await deliver('{"id":"one-too-many"}', { now: T + MAX_HELD_EVENTS });

    expect(answer.status).toBe(429);
    expect(answer.outcome).toBe("over_cap");
    expect(ownerMessages(job).some((body) => body.includes("was refused"))).toBe(true);
  });
});

describe("a payload a pipeline's entry rules refuse (EO-610)", () => {
  const WANTS_A_BODY = '"Delivery" needs these before work can enter it: a description.';

  /** A job whose payload fills the description, on a pipeline that asks for one. */
  function mappedJob(): Job {
    const job = webhookJob({
      trigger: { kind: "webhook", path: "deploys", secret: SECRET, mapping: { title: null, body: "/text", eventKey: null, spec: {} } },
      template: { ...TEMPLATE, body: null },
    });
    handle.db.update(pipelines).set({ entryRules: [{ kind: "description" }] }).where(eq(pipelines.id, "default")).run();
    return job;
  }

  it("creates nothing, fails the occurrence with the sentence, tells the owner, and takes the next event", async () => {
    const job = mappedJob();

    const answer = await deliver('{"id":"evt-1","text":""}', { now: T });

    expect(answer).toMatchObject({ status: 422, outcome: "refused", itemId: null });
    expect(itemCount()).toBe(0);
    expect(listOccurrences(handle.db, job.id as Uuid)).toEqual([expect.objectContaining({ status: "failed", reason: WANTS_A_BODY })]);
    expect(ownerMessages(job).some((body) => body.includes(WANTS_A_BODY))).toBe(true);
    expect(webhookAnswerWord("refused")).toBe("refused");

    expect(await deliver('{"id":"evt-2","text":"Deployed."}', { now: T + 1000 })).toMatchObject({ status: 202, outcome: "created" });
    expect(itemCount()).toBe(1);
  });

  it("does not leave a refused event at the head of the queue with the rest behind it", async () => {
    const job = mappedJob();
    setJobPaused(handle.db, job.id as Uuid, T, "by hand");
    await deliver('{"id":"evt-1","text":" "}', { now: T + 1 });
    await deliver('{"id":"evt-2","text":"Deployed."}', { now: T + 2 });
    setJobPaused(handle.db, job.id as Uuid, null);

    await releaseHeldWebhookEvents(handle.db, { storage, now: T + 3 });

    expect(itemCount()).toBe(1);
    expect(heldEventCount(handle.db, job.id as Uuid)).toBe(0);
    expect(listJobEvents(handle.db, job.id as Uuid).map((event) => event.outcome)).toEqual(expect.arrayContaining(["refused", "created"]));
  });

  it("files a payload that fills it", async () => {
    mappedJob();
    expect(await deliver('{"id":"evt-1","text":"Deployed."}', { now: T })).toMatchObject({ outcome: "created" });
  });
});
