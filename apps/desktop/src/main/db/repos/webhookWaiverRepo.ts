import { sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { isReplica } from "../recordRole.js";
import { jobs, pipelines } from "../schema.js";
import { publishedSectionRow } from "./publishedSectionsRepo.js";

/**
 * Turns off every waiver whose pipeline no webhook job files onto any
 * more (EO-405).
 *
 * `pipelines.webhook_unattended` is somebody accepting that what *a
 * webhook* delivers reaches a step that sends, unread. It is accepted
 * about an exposure that exists: the control is only drawn while a
 * webhook job files onto the pipeline, and the command refuses to turn
 * it on without one. So a waiver that outlived its last webhook job
 * would be the thing both of those exist to prevent — invisible in the
 * editor, since there is no control to draw, and waiting for whichever
 * webhook job arrived next to walk through a door nobody remembered
 * leaving open. The next job has to be accepted by a person again.
 *
 * ## Why a sweep, and why here
 *
 * A webhook entry can go away five ways — a job deleted, moved to
 * another pipeline, changed to another kind of trigger, removed with
 * the conversation that owned it, or rewritten by a project arriving on
 * a record — and each is a different statement in a different file.
 * Passing "the pipeline this job used to file onto" out of every one of
 * them is five chances to get the before-state wrong. One statement
 * that asks the question of the whole table needs no before-state at
 * all: it is called after any write that could have removed an entry,
 * and it is right whichever write that was.
 *
 * The same test as `pipelineHasWebhookEntry`: a job that is not
 * deleted, on this pipeline, whose trigger is a webhook. A paused job
 * still counts, for that function's reason — a pause is a switch
 * somebody flips back.
 *
 * Stamps `updated_at`, which is what carries the change from a record
 * to its replicas, exactly as turning it off by hand does.
 *
 * ## The one machine it leaves alone
 *
 * A desktop whose organisation publishes its pipelines does not own the
 * setting: it is the administrator's, it arrives with the pipeline from
 * the record, and the webhook job it is about lives on the server — a
 * webhook has an address only there, so this machine usually holds no
 * webhook job at all. Sweeping here would clear what the administrator
 * chose the first time anybody edited an unrelated local job, and the
 * board would stop saying what is true on the server. The record runs
 * this same sweep on its own jobs, and its answer is what arrives.
 *
 * Returns how many waivers it turned off.
 */
export function dropWebhookWaiversWithoutEntry(db: Db, at: number = Date.now()): number {
  if (isReplica(db) && publishedSectionRow(db, "pipelines") !== undefined) return 0;
  return db
    .update(pipelines)
    .set({ webhookUnattended: false, updatedAt: at })
    .where(
      sql`${pipelines.webhookUnattended} = 1 and not exists (
        select 1 from ${jobs}
        where ${jobs.pipelineId} = ${pipelines.id}
          and ${jobs.deletedAt} is null
          and json_extract(${jobs.trigger}, '$.kind') = 'webhook'
      )`,
    )
    .run().changes;
}
