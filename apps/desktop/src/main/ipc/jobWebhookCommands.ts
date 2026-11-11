import { sampleWebhookPayload, uuidv7, type IpcPayload, type IpcResponse, type JobEventRow, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getItem, getJob, heldEventCount, lastJobEventPayload, listJobEvents } from "../db/repos/index.js";
import { updateJob } from "../jobs/jobs.js";
import { jobSummary } from "../jobs/summary.js";
import { receiveWebhook, type WebhookDeps } from "../jobs/webhook.js";
import { mintWebhookSecret, signWebhook } from "../jobs/webhookSignature.js";
import type { EngineHandle } from "./domainCommands.js";
import { emitPush } from "./push.js";

/**
 * The three `jobs:*` commands only a webhook job has (EO-333,
 * `ARCHITECTURE.md`, "The inbox, the archive and jobs", "Results and routes",
 * "Webhooks").
 *
 * Their own file rather than eight more screens' worth of
 * `jobCommands.ts`, for `jobs/webhook.ts`'s reason: none of this is a
 * question about jobs in general, and all of it is a question about the
 * door the design put in front of one kind of them.
 *
 * What is deliberately **not** here is the URL, the secret and the
 * mapping. They are the job's trigger, `jobs:get` already carries it,
 * and a channel that answered them again would be a second account of
 * one row — the failure `ItemOrigin` avoids by being derived. The Job
 * page reads them off the job it already has, and the address they hang
 * from is the renderer's, which is the only end that knows what a
 * browser reached this record at.
 */

/**
 * The Events tab, and the line above it (ARCHITECTURE.md, "The inbox, the archive and jobs",
 * "Webhooks").
 *
 * The finding, in one channel: *with concurrency at 1, a burst of forty
 * events also needs "38 waiting" or the team sees one item and assumes
 * the rest were lost.* So the count travels with the rows rather than
 * being counted off them — the rows are a page and the queue is not,
 * and a burst of five hundred would otherwise be reported as however
 * many happened to fit.
 *
 * A job that is not a webhook job answers an empty list rather than a
 * refusal. It is a question with an honest answer — nothing has ever
 * been delivered to it — and the page that asks decides whether to draw
 * a tab from the trigger it already has, not from an error.
 */
export function jobEventsCommand(db: Db, input: IpcPayload<"jobs:events">): IpcResponse<"jobs:events"> {
  const jobId = input.jobId as Uuid;
  const job = getJob(db, jobId);
  if (!job || job.deletedAt !== null) return { events: [], heldCount: 0, lastPayload: null };
  return {
    events: listJobEvents(db, jobId, input.limit).map((event): JobEventRow => {
      // Resolved here rather than left as an id, for `occurrenceRows`'
      // reason: `job_events.item_id` carries no foreign key so that
      // deleting an item does not erase the record of the delivery, and
      // this is where that becomes a blank cell instead of a link to
      // nothing.
      const item = event.itemId === null ? undefined : getItem(db, event.itemId as Uuid);
      return { ...event, itemKey: item?.key ?? null, itemTitle: item?.title ?? null };
    }),
    heldCount: heldEventCount(db, jobId),
    lastPayload: lastJobEventPayload(db, jobId),
  };
}

/**
 * A new secret, and the old one stops working the moment this answers
 * (ARCHITECTURE.md, "The inbox, the archive and jobs").
 *
 * Through `updateJob` rather than by writing the trigger column, so the
 * one place that decides whether a job is still fireable stays the one
 * place — and so a regenerate is refused for the same reasons a save is
 * rather than for a shorter list of its own.
 *
 * Nothing is sent to the job's owner. A guard that fires with no item
 * has to say so somewhere (invariant #8); this is a person pressing a
 * button and watching the new secret appear, which is `pauseJobCommand`'s
 * distinction exactly.
 */
export function regenerateWebhookSecretCommand(
  db: Db,
  input: IpcPayload<"jobs:regenerateSecret">,
): IpcResponse<"jobs:regenerateSecret"> {
  const job = getJob(db, input.jobId as Uuid);
  if (!job || job.deletedAt !== null) return { job: null, problem: "That job no longer exists." };
  if (job.trigger.kind !== "webhook") {
    return { job: null, problem: "This job is not triggered by a webhook, so it has no secret to replace." };
  }
  const result = updateJob(db, { jobId: job.id as Uuid, trigger: { ...job.trigger, secret: mintWebhookSecret() } });
  if (!result.ok) return { job: null, problem: result.problem };
  return { job: jobSummary(db, result.job), problem: null };
}

/**
 * One delivery, sent on purpose (ARCHITECTURE.md, "The inbox, the archive and jobs").
 *
 * **Through the door rather than round it.** The sample is signed with
 * the job's own secret and handed to `receiveWebhook`, which is the
 * function the HTTP route calls with the bytes off the socket: the
 * signature is verified, the window is checked, the event key is
 * computed, the cap is applied and the row is written, all of them for
 * real. A command that created an item directly would be a test of a
 * second code path, and would go on passing after the first one broke.
 *
 * What it does not do is open a socket to the record's public address.
 * A record posting to itself would be asking whatever terminates TLS in
 * front of it for permission to talk to itself; and from a desktop,
 * which has no public address at all (ARCHITECTURE.md, "Webhooks"), the item would be filed on
 * the far end where this page cannot link to it.
 *
 * The sample is built from the job's **own mapping**
 * (`sampleWebhookPayload`), so the item that comes back is the person's
 * pointers as they have written them — which is the question somebody
 * pressing this is actually asking. The nonce is what makes a second
 * press a second event rather than a `deduplicated` row.
 */
export async function sendTestWebhookEventCommand(
  db: Db,
  deps: WebhookDeps,
  engine: EngineHandle | undefined,
  input: IpcPayload<"jobs:testEvent">,
): Promise<IpcResponse<"jobs:testEvent">> {
  const job = getJob(db, input.jobId as Uuid);
  if (!job || job.deletedAt !== null) return { outcome: null, itemId: null, itemKey: null, problem: "That job no longer exists." };
  if (job.trigger.kind !== "webhook") {
    return { outcome: null, itemId: null, itemKey: null, problem: "This job is not triggered by a webhook, so there is nothing to send it." };
  }

  const body = JSON.stringify(sampleWebhookPayload(job.trigger.mapping, uuidv7()));
  const now = Date.now();
  const answer = await receiveWebhook(
    db,
    {
      path: job.trigger.path,
      rawBody: body,
      signature: signWebhook(job.trigger.secret, now, body),
      timestamp: String(now),
      now,
    },
    deps,
  );

  if (answer.itemId != null) {
    emitPush("items:changed", { itemId: answer.itemId });
    // New work on a step, exactly as a delivery off the socket is: the
    // scheduler should look now rather than on its next tick.
    engine?.notifyStateChange();
  }
  // Every other outcome is a message to the job's owner, which pushes `messages:changed` itself.

  return {
    outcome: answer.outcome,
    itemId: answer.itemId ?? null,
    itemKey: (answer.itemId == null ? undefined : getItem(db, answer.itemId as Uuid))?.key ?? null,
    // The row's own sentence, not a second wording of it — `History`'s
    // rule, for its reason. A `created` delivery has nothing to explain.
    problem: answer.event?.reason ?? null,
  };
}
