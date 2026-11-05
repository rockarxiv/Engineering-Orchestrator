import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WEBHOOK_TEST_MARKER, type Job, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import { getJob, listItems } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { createJob } from "../jobs/jobs.js";
import { receiveWebhook, releaseHeldWebhookEvents } from "../jobs/webhook.js";
import { mintWebhookSecret, signWebhook } from "../jobs/webhookSignature.js";
import { jobEventsCommand, regenerateWebhookSecretCommand, sendTestWebhookEventCommand } from "./jobWebhookCommands.js";

/**
 * The Job page's webhook surface, from the main process's side
 * (EO-333, `ARCHITECTURE.md`, "The inbox, the archive and jobs",
 * "Webhooks").
 *
 * The clock is driven rather than waited on, for `webhook.test.ts`'s
 * reason: the cap these deliveries meet is stated in items per *hour*.
 */

let handle: DbHandle;
let storageRoot: string;
let storage: AttachmentStorage;

const SECRET = mintWebhookSecret();
const TEMPLATE = { type: "developer:story", title: "Deploy for {{date}}", body: "Filed by {{job}}." };
const MAPPING = { title: "/issue/fields/summary", body: null, eventKey: "/delivery_id", spec: {} };
const T = new Date(2026, 8, 22, 9, 0, 0).getTime();

beforeEach(() => {
  handle = openMigratedTestDb();
  storageRoot = mkdtempSync(join(tmpdir(), "eo-webhook-surface-"));
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
    trigger: { kind: "webhook", path: "deploys", secret: SECRET, mapping: MAPPING },
    pipelineId: "default",
    template: TEMPLATE,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.problem);
  return result.job;
}

function sendTest(job: Job) {
  return sendTestWebhookEventCommand(handle.db, { storage }, undefined, { jobId: job.id });
}

function events(job: Job) {
  return jobEventsCommand(handle.db, { jobId: job.id, limit: 100 });
}

describe("jobs:testEvent", () => {
  it("creates an item, and the Events tab shows a created row linking to it", async () => {
    const job = webhookJob();

    const answer = await sendTest(job);

    expect(answer.outcome).toBe("created");
    expect(answer.itemId).not.toBeNull();
    const listed = events(job);
    expect(listed.events).toHaveLength(1);
    expect(listed.events[0]?.outcome).toBe("created");
    expect(listed.events[0]?.itemId).toBe(answer.itemId);
    // The key, because that is what a link is drawn from — and the
    // title, because the item is what the press was for.
    expect(listed.events[0]?.itemKey).toBe(answer.itemKey);
    expect(listed.events[0]?.itemKey).not.toBeNull();
  });

  it("goes through the mapping, so the item is titled by the person's own pointer", async () => {
    const job = webhookJob();

    await sendTest(job);

    expect(listItems(handle.db).map((item) => item.title)).toContain("Test event from EO");
  });

  it("says it is a test in the payload it files", async () => {
    const job = webhookJob();

    await sendTest(job);

    const payload = JSON.parse(events(job).lastPayload ?? "{}") as Record<string, unknown>;
    expect(payload[WEBHOOK_TEST_MARKER]).toBe(true);
  });

  /**
   * Two presses are two events, which is what the nonce is for. A fixed
   * sample would carry one event key and the second press would be
   * answered — correctly — that this job has had this event already.
   */
  it("files a second item on a second press rather than deduplicating", async () => {
    const job = webhookJob();

    const first = await sendTest(job);
    const second = await sendTest(job);

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("created");
    expect(second.itemId).not.toBe(first.itemId);
  });

  /**
   * The signature, the window, the key, the cap and the row are the real
   * ones: the press goes through `receiveWebhook` rather than round it.
   * A job at its cap is the shortest proof of that — nothing about a
   * "test" is exempt.
   */
  it("is held by the job's own cap, and says so rather than claiming to have failed", async () => {
    const job = webhookJob({ maxItemsPerHour: 1 });

    const first = await sendTest(job);
    const second = await sendTest(job);

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("held");
    expect(second.itemId).toBeNull();
    expect(second.problem).toContain("at most 1 items an hour");
  });

  it("refuses a job that is not a webhook job, rather than inventing a delivery", async () => {
    const result = createJob(handle.db, {
      projectId: null,
      name: "Monday report",
      trigger: { kind: "manual" },
      pipelineId: "default",
      template: TEMPLATE,
    });
    if (!result.ok) throw new Error(result.problem);

    const answer = await sendTestWebhookEventCommand(handle.db, { storage }, undefined, { jobId: result.job.id });

    expect(answer.outcome).toBeNull();
    expect(answer.problem).toContain("not triggered by a webhook");
  });
});

describe("jobs:events", () => {
  function deliver(body: string, now: number) {
    return receiveWebhook(
      handle.db,
      { path: "deploys", rawBody: body, signature: signWebhook(SECRET, now, body), timestamp: String(now), now },
      { storage },
    );
  }

  /**
   * The original design, as a number: *with concurrency at 1, a burst of forty
   * events also needs "38 waiting" or the team sees one item and assumes
   * the rest were lost.*
   */
  it("counts what is waiting, and the count falls as the record releases them", async () => {
    const job = webhookJob({ maxItemsPerHour: 10 });
    for (let index = 0; index < 40; index += 1) {
      await deliver(JSON.stringify({ delivery_id: `evt-${index}` }), T + index * 1000);
    }

    expect(events(job).heldCount).toBe(30);

    const AN_HOUR = 60 * 60_000;
    await releaseHeldWebhookEvents(handle.db, { storage, now: T + 60_000 + AN_HOUR });

    expect(events(job).heldCount).toBe(20);

    // And the held rows are all still listed: the release appended a
    // second row rather than rewriting the first, so the tab goes on
    // saying that thirty were held at nine o'clock.
    expect(events(job).events.filter((event) => event.outcome === "held")).toHaveLength(30);
  });

  it("lists what produced no item at all, with the row's own reason", async () => {
    const job = webhookJob();

    await deliver("not json at all", T);

    const listed = events(job).events;
    expect(listed[0]?.outcome).toBe("malformed");
    expect(listed[0]?.reason).toContain("not JSON");
    expect(listed[0]?.itemKey).toBeNull();
  });

  it("previews against the newest body it has, and never against one it refused", async () => {
    const job = webhookJob();
    await deliver(JSON.stringify({ delivery_id: "evt-1", issue: { fields: { summary: "Printer on fire" } } }), T);
    // Signed with something else: the row is written with no body at
    // all, and a preview against it would be a stranger's document.
    const forged = JSON.stringify({ delivery_id: "evt-2" });
    await receiveWebhook(
      handle.db,
      { path: "deploys", rawBody: forged, signature: signWebhook("not the secret", T + 1, forged), timestamp: String(T + 1), now: T + 1 },
      { storage },
    );

    expect(events(job).lastPayload).toContain("Printer on fire");
  });

  it("answers emptily for a job nothing was ever delivered to", () => {
    const job = webhookJob();

    expect(events(job)).toEqual({ events: [], heldCount: 0, lastPayload: null });
  });
});

describe("jobs:regenerateSecret", () => {
  it("replaces the secret, and what was signed with the old one is refused", async () => {
    const job = webhookJob();
    const body = JSON.stringify({ delivery_id: "evt-1" });

    const result = regenerateWebhookSecretCommand(handle.db, { jobId: job.id });

    expect(result.problem).toBeNull();
    const now = getJob(handle.db, job.id as Uuid);
    const secret = now?.trigger.kind === "webhook" ? now.trigger.secret : "";
    expect(secret).not.toBe(SECRET);
    expect(secret.length).toBeGreaterThanOrEqual(32);

    const stale = await receiveWebhook(
      handle.db,
      { path: "deploys", rawBody: body, signature: signWebhook(SECRET, T, body), timestamp: String(T), now: T },
      { storage },
    );
    expect(stale.outcome).toBe("rejected_signature");

    const fresh = await receiveWebhook(
      handle.db,
      { path: "deploys", rawBody: body, signature: signWebhook(secret, T, body), timestamp: String(T), now: T },
      { storage },
    );
    expect(fresh.outcome).toBe("created");
  });

  it("keeps the path and the mapping — only the secret changes", () => {
    const job = webhookJob();

    regenerateWebhookSecretCommand(handle.db, { jobId: job.id });

    const now = getJob(handle.db, job.id as Uuid);
    expect(now?.trigger.kind === "webhook" ? now.trigger.path : null).toBe("deploys");
    expect(now?.trigger.kind === "webhook" ? now.trigger.mapping : null).toEqual(MAPPING);
  });

  it("refuses a job that has no secret to replace", () => {
    const result = createJob(handle.db, {
      projectId: null,
      name: "Monday report",
      trigger: { kind: "manual" },
      pipelineId: "default",
      template: TEMPLATE,
    });
    if (!result.ok) throw new Error(result.problem);

    expect(regenerateWebhookSecretCommand(handle.db, { jobId: result.job.id }).problem).toContain("no secret to replace");
  });
});
