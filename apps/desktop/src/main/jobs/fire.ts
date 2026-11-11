import { parseQualifiedItemType, type Item, type Job, type JobOccurrence, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { createItem, getPipeline, getProject, recordOccurrence } from "../db/repos/index.js";
import { isProjectReplica } from "../db/recordRole.js";
import { fillTemplate } from "./template.js";
import { JOB_MESSAGE_SOURCE, messageJobOwner } from "./ownerMessage.js";

/**
 * Firing a job (EO-304, `ARCHITECTURE.md`, "What a job records").
 *
 * One occurrence, one item, in one transaction. The occurrence is the
 * durable record `pullSchedule.ts` never had — it kept its last-run time
 * in memory, so a desktop that closed forgot what it had done — and it
 * is what the item's provenance is read back through.
 *
 * Every way of not firing ends in a message to the job's owner
 * (invariant #8, EO-729): at the moment a firing fails there is no item
 * to comment on, so the person who must act is told directly.
 */

export interface FireOptions {
  /** The moment the occurrence is *for*. Defaults to now, which is what a manual run means. */
  dueAt?: number;
  /**
   * What this particular firing puts in place of the template's own
   * text (EO-332, ARCHITECTURE.md, "What a job records").
   *
   * One caller: a webhook, whose mapping reads the title, the body and
   * the item type's spec fields out of the payload it arrived with
   * (`jobs/webhook.ts`). Absent for every other trigger, which is what
   * a template being a *template* means — a schedule stamps the same
   * item out every morning, and a field that varied would be a second
   * definition of the job hidden in the occurrence.
   *
   * Each member is a replacement rather than a merge, and an absent
   * one leaves the template's own text standing: a mapping that names
   * only the title is a job whose body is still the sentence its owner
   * wrote. The blanks are filled first and then overridden, so
   * `{{date}}` in a template a webhook replaces costs nothing and a
   * template it does not replace behaves exactly as it always has.
   */
  overrides?: FireOverrides;
  /**
   * The moment the firing *happens*, against `dueAt`'s moment it was
   * *for* (EO-332).
   *
   * They are the same for a schedule caught up on time and for a press,
   * and they are not for a webhook event that arrived at 09:00 and was
   * held until 11:00 — `dueAt` keeps the arrival, because that is what
   * the event's own row keeps, and this is when EO got to it.
   *
   * Injected for `CatchUpDeps.now`'s reason as well: it is what a test
   * of the release order drives, and a cap counted off `Date.now()`
   * could only be tested by waiting an hour.
   */
  firedAt?: number;
}

/** What a trigger may put in place of the template — see `FireOptions.overrides`. */
export interface FireOverrides {
  title?: string;
  body?: string;
  spec?: Record<string, unknown>;
}

export interface FireResult {
  /**
   * The row written for this attempt, or null where nothing was
   * written at all (EO-325).
   *
   * Null in one situation and it is new: the job's project is not this
   * installation's to file work on — a transfer in flight, or one that
   * has finished and left this machine a replica. Every *other* way of
   * not firing writes a `failed` row, because a failure is a thing that
   * happened here and the history is the point. This is the opposite: a
   * row saying "this machine declined" is a row the record never hears
   * about, on a project whose whole account of itself is meant to be
   * the record's.
   */
  occurrence: JobOccurrence | null;
  /** Null when the occurrence is `failed`. */
  item: Item | null;
  /** The sentence the owner was told, or null when it fired. */
  problem: string | null;
  /**
   * The pipeline's entry rules refused what this firing would have filed
   * (EO-610). Set apart because it is about this one item and not about
   * the job, so a webhook does not hold the event to try it again.
   */
  refusedAtEntry?: true;
}

/** Carries a refusal out through the transaction that has to roll back for it. */
class Refused extends Error {
  constructor(
    readonly reason: string,
    readonly refusedAtEntry = false,
  ) {
    super(reason);
    this.name = "Refused";
  }
}

/**
 * Stamps one item out of the job's template and records what happened.
 *
 * `createdBy` is the owner, not the person who pressed the button:
 * whoever asks EO to run a job now, the work is the owner's — it fills
 * their inbox and draws on their budget (ARCHITECTURE.md, "Controls"). In solo mode they are
 * the same person, which is exactly why writing it down now is what
 * stops them silently diverging in 7b.
 *
 * The item lands on the pipeline's *entry* step and not on its lowest
 * position: entry is explicit for the design's reason, so reordering the
 * columns never silently re-routes what a job files.
 */
export function fireJob(db: Db, job: Job, options: FireOptions = {}): FireResult {
  const dueAt = options.dueAt ?? Date.now();

  /**
   * A job whose project this installation is not the writer for
   * (EO-325).
   *
   * Before the transaction rather than inside it, and writing no
   * occurrence, which is the difference between this and every other
   * refusal here. A `failed` row is a thing that happened on this
   * machine and the history is the point; a row saying "this machine
   * declined to file work on somebody else's project" is a row the
   * record never hears about, on a project whose whole account of
   * itself is meant to be the record's.
   *
   * Here for the reason the pause guard is here, and the review found
   * what the alternative costs: the tick was gated and the presses were
   * not, so Run now — and a reply of "run it now" to an offer made
   * before the move — filed an item and an occurrence on a machine that
   * is a replica of the project they belong to.
   *
   * Two sentences, because they are two situations a person can act on.
   * **Adopting** is a transfer in flight, on either side of it: the rows
   * are half here and half there, and a new item filed into the middle
   * belongs to neither. **The record's** is the finished state on the
   * machine that handed it over: the record files this now, and the work
   * still runs here when the record leases it (ARCHITECTURE.md, "Where a job runs").
   *
   * The person is told either way (invariant #8), and told here:
   * it is an account of what *this machine* did, like the drain's note
   * about its own queue, and the record has its own view of the same
   * job — so the message is the person in front of this machine's,
   * about no project, and never goes to the record.
   */
  const project = job.projectId === null ? undefined : getProject(db, job.projectId as Uuid);
  const notOurs =
    project?.adoptingAt != null
      ? `"${project.name}" is being moved to your organisation's record, so nothing new is filed on it until that is done.`
      : isProjectReplica(db, job.projectId as Uuid | null)
        ? "This project is on your organisation's record now, so the record files its work rather than this machine."
        : null;
  if (notOurs !== null) {
    messageJobOwner(db, job, `EO did not run "${job.name}". ${notOurs}`, { source: JOB_MESSAGE_SOURCE.declined, staysHere: true });
    return { occurrence: null, item: null, problem: notOurs };
  }

  try {
    return db.transaction(() => {
      // A paused job files nothing, whichever door this was reached
      // through (EO-307). Here rather than at each caller because that
      // is what makes the sentence true: Run now, a reply saying "Run
      // it now" to an offer made before the pause, and anything a later
      // trigger adds all arrive at this one function, and a guard
      // written at three of them is a guard the fourth forgets. The
      // tick never gets this far — it writes a `skipped` row with
      // `paused`, which is what a due occurrence deserves; this is for
      // the presses, and a press is not an occurrence that came round.
      if (job.pausedAt !== null) {
        throw new Refused("It is paused, so it files nothing until it is resumed.");
      }
      // And a job somebody deleted files nothing at all, for the same
      // reason and at the same door (EO-308). Its row survives as a
      // tombstone so that the items it filed can still name it, which
      // means `getJob` answers for one — so the guard has to be here,
      // where every way of firing arrives, rather than at each caller.
      if (job.deletedAt !== null) {
        throw new Refused("It has been deleted, so it files nothing.");
      }
      const template = job.template;
      if (template === null || job.pipelineId === null) {
        throw new Refused("This job has no pipeline and template to file work with, so there was nothing to create.");
      }
      const pipeline = getPipeline(db, job.pipelineId);
      if (!pipeline) throw new Refused("The pipeline this job files work on no longer exists.");
      if (pipeline.archivedAt !== null) throw new Refused(`"${pipeline.name}" has been deleted, so nothing new can start on it.`);
      if (pipeline.entryStepId === null) {
        throw new Refused(`"${pipeline.name}" has no step for new work to start on, so there was nowhere to file this.`);
      }

      const blanks = { dueAt, job: job.name };
      const overrides = options.overrides ?? {};
      const created = createItem(db, {
        type: parseQualifiedItemType(template.type) ?? template.type,
        title: overrides.title ?? fillTemplate(template.title, blanks),
        body: overrides.body ?? (template.body === null ? null : fillTemplate(template.body, blanks)),
        ...(overrides.spec === undefined ? {} : { spec: overrides.spec }),
        projectId: job.projectId as Uuid | null,
        pipelineId: pipeline.id as Uuid,
        stepId: pipeline.entryStepId,
        createdBy: job.ownerId as Uuid,
      });
      if (!created.ok) throw new Refused(created.problem, created.refusedAtEntry === true);

      const occurrence = recordOccurrence(db, {
        jobId: job.id as Uuid,
        dueAt,
        status: "fired",
        firedAt: options.firedAt ?? Date.now(),
        itemId: created.item.id,
      });
      return { occurrence, item: created.item, problem: null };
    });
  } catch (error) {
    if (!(error instanceof Refused)) throw error; // a genuine fault, not a guard
    // Outside the rolled-back transaction, so the record of the failure
    // survives the failure. `reason` and the message carry the same
    // sentence on purpose: the row is what the history lists and the
    // message is what reaches the person, and two wordings would be two
    // accounts of one event.
    const occurrence = recordOccurrence(db, {
      jobId: job.id as Uuid,
      dueAt,
      status: "failed",
      firedAt: options.firedAt ?? Date.now(),
      reason: error.reason,
    });
    messageJobOwner(db, job, `"${job.name}" could not run. ${error.reason}`, { source: JOB_MESSAGE_SOURCE.failed });
    return { occurrence, item: null, problem: error.reason, ...(error.refusedAtEntry ? { refusedAtEntry: true as const } : {}) };
  }
}
