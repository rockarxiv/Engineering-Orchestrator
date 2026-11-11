import { EMPTY_WEBHOOK_MAPPING, parseQualifiedItemType, type Job, type JobRunsOn, type JobTemplate, type JobTrigger, type ScheduleTrigger, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import {
  getItem,
  getJob,
  getPipeline,
  insertJob,
  itemIdsFiredBy,
  jobForConversation,
  listAllJobs,
  localPerson,
  markJobDeleted,
  resolveItemType,
  setItemArchived,
  updateJobRow,
  type ItemTypeName,
  type UpdateJobInput,
  arrivalRefusal,
} from "../db/repos/index.js";
import { compileSchedule } from "../schedule/cron.js";
import { isKnownTimeZone } from "../schedule/timeZone.js";

/**
 * Making a job, and being done with one (EO-304,
 * `ARCHITECTURE.md`, "What a job records").
 *
 * Above the repository because neither act is only a question about the
 * `jobs` table: creating one checks that it could fire against the
 * project's pipelines and types, and deleting one may archive the work
 * it filed and, for a from-discussion job, its conversation.
 */

export interface CreateJobInput {
  projectId: Uuid | null;
  name: string;
  trigger: JobTrigger;
  pipelineId?: string | null;
  template?: JobTemplate | null;
  /** Defaults to the local person — in solo mode, the one there is. */
  ownerId?: Uuid;
  budgetPerOccurrenceCents?: number | null;
  maxItemsPerHour?: number | null;
  /** Omitted is `device` (EO-330, ARCHITECTURE.md, "Where a job runs") — where every job has always run. */
  runsOn?: JobRunsOn;
}

/**
 * A job, or the reason there is none.
 *
 * A typed refusal rather than a throw, for `createItem`'s reason: every
 * way of getting this wrong is something a person or an agent asked for
 * — a pipeline that has since been archived, a template naming a type
 * this project does not have — rather than a fault in EO.
 */
export type CreateJobResult = { ok: true; job: Job } | { ok: false; problem: string };

/**
 * Creates a job, or finds the one a conversation already made.
 *
 * Everything is checked before anything is written. A job whose
 * pipeline has no entry step, or whose template names a type nothing
 * resolves, is refused here rather than at the first occurrence —
 * because a job that cannot fire is a thing a person set up and then
 * waits on, and the moment to say so is the moment they set it up.
 */
export function createJob(db: Db, input: CreateJobInput): CreateJobResult {
  const name = input.name.trim();
  if (name === "") return { ok: false, problem: "A job needs a name — it is what the Jobs list shows and what `{{job}}` expands to." };

  const ownerId = input.ownerId ?? (localPerson(db).id as Uuid);
  const pipelineId = input.pipelineId ?? null;
  const template = input.template ?? null;

  if (input.trigger.kind === "from-discussion") {
    // One job per conversation (ARCHITECTURE.md, "What a job records"): a second Create there
    // reuses the job the first one made.
    const conversation = getItem(db, input.trigger.conversationId as Uuid);
    if (!conversation) return { ok: false, problem: "That conversation no longer exists, so there is nothing to record the item as coming from." };
    const existing = jobForConversation(db, conversation.id);
    if (existing) return { ok: true, job: existing };
    return {
      ok: true,
      job: insertJob(db, {
        projectId: input.projectId,
        name,
        trigger: input.trigger,
        // Neither: the approval resolved the placement and the
        // conversation supplied the item. See the column's own note.
        pipelineId: null,
        template: null,
        ownerId,
        ...(input.budgetPerOccurrenceCents === undefined ? {} : { budgetPerOccurrenceCents: input.budgetPerOccurrenceCents }),
        ...(input.maxItemsPerHour === undefined ? {} : { maxItemsPerHour: input.maxItemsPerHour }),
        ...(input.runsOn === undefined ? {} : { runsOn: input.runsOn }),
      }),
    };
  }

  const fireable = checkFireable(db, input.projectId, input.trigger, pipelineId, template) ?? templateRefusal(db, input.projectId, input.trigger, pipelineId, template);
  if (fireable !== null) return { ok: false, problem: fireable };

  return {
    ok: true,
    job: insertJob(db, {
      projectId: input.projectId,
      name,
      trigger: input.trigger,
      pipelineId,
      template,
      ownerId,
      ...(input.budgetPerOccurrenceCents === undefined ? {} : { budgetPerOccurrenceCents: input.budgetPerOccurrenceCents }),
      ...(input.maxItemsPerHour === undefined ? {} : { maxItemsPerHour: input.maxItemsPerHour }),
      ...(input.runsOn === undefined ? {} : { runsOn: input.runsOn }),
    }),
  };
}

/**
 * Whether this job could fire as described, and the sentence saying it
 * could not (EO-308).
 *
 * The whole of what `createJob` refuses, lifted out so that `updateJob`
 * refuses exactly the same things. Two copies of these checks would be
 * two answers to "can this job fire", and the one that drifted would be
 * the edit path — the one nobody writes first. Everything is checked
 * *before* anything is written, on `createJob`'s own rule: a job that
 * cannot fire is a thing a person set up and then waits on, and the
 * moment to say so is the moment they set it up, not the first morning
 * nothing appears.
 */
function checkFireable(
  db: Db,
  projectId: Uuid | null,
  trigger: JobTrigger,
  pipelineId: string | null,
  template: JobTemplate | null,
  exceptJobId: Uuid | null = null,
): string | null {
  if (pipelineId === null || template === null) {
    return "A job that fires on its own needs a pipeline to file work on and a template to file.";
  }

  if (trigger.kind === "webhook") {
    // One address, one job (EO-332, ARCHITECTURE.md, "Webhooks"). Checked here rather than by a
    // unique index, because the path lives inside the trigger JSON —
    // and checked at the moment somebody sets it up, on `createJob`'s
    // own rule: a second job on an address that is already taken would
    // be a job whose events all go somewhere else, discovered at the
    // first delivery.
    const taken = listAllJobs(db).find(
      (other) => other.id !== exceptJobId && other.trigger.kind === "webhook" && other.trigger.path === trigger.path,
    );
    if (taken) return `"${taken.name}" already receives webhooks at /${trigger.path}, and one address cannot belong to two jobs.`;
  }

  if (trigger.kind === "schedule") {
    // Checked here rather than in the schema, because both answers have
    // to come from the parser the scheduler will actually compute with
    // — a Zod regex that agreed with it today would be a second opinion
    // waiting to disagree.
    const schedule = validateSchedule(trigger);
    if (schedule !== null) return schedule;
  }

  const pipeline = getPipeline(db, pipelineId);
  if (!pipeline) return "That pipeline no longer exists.";
  if (pipeline.archivedAt !== null) return `"${pipeline.name}" has been deleted, so nothing new can start on it.`;
  if (pipeline.entryStepId === null) {
    return `"${pipeline.name}" has no step for new work to start on, so a job cannot file anything on it.`;
  }

  const type = resolveItemType(db, projectId, templateType(template));
  return type.ok ? null : type.problem;
}

/**
 * Whether this job's pipeline would refuse what its template files
 * (EO-610, ARCHITECTURE.md, "Entry rules"), on `checkFireable`'s rule that
 * the moment to say so is when somebody sets it up.
 *
 * Judged on what the template holds, so a value with a blank in it counts
 * as present: it is text whatever the blank expands to. A field a webhook
 * mapping fills counts too, since only the payload can say more, and the
 * firing asks again with what actually arrived. A template holds no spec,
 * no workspace and no pack state, so a rule asking for those can only be
 * met by a mapping.
 */
function templateRefusal(db: Db, projectId: Uuid | null, trigger: JobTrigger, pipelineId: string | null, template: JobTemplate | null): string | null {
  if (pipelineId === null || template === null) return null;
  const type = resolveItemType(db, projectId, templateType(template));
  if (!type.ok) return null;
  const mapping = trigger.kind === "webhook" ? (trigger.mapping ?? EMPTY_WEBHOOK_MAPPING) : EMPTY_WEBHOOK_MAPPING;
  return arrivalRefusal(db, {
    pipelineId,
    stepId: getPipeline(db, pipelineId)?.entryStepId ?? null,
    type: type.type,
    body: mapping.body !== null ? MAPPED_VALUE : template.body,
    spec: Object.fromEntries(Object.keys(mapping.spec).map((field) => [field, MAPPED_VALUE])),
    hasWorkspace: false,
    extensions: {},
  });
}

/** Stands for what a webhook's payload will supply. Never stored: it only has to be a value. */
const MAPPED_VALUE = "mapped";

/** What the Job page may change (EO-308, ARCHITECTURE.md, "The inbox, the archive and jobs"). Absence is "leave it" — `UpdateJobInput` says why. */
export interface EditJobInput extends UpdateJobInput {
  jobId: Uuid;
}

/**
 * Changing a job, from the Job page (EO-308,
 * `ARCHITECTURE.md`, "The inbox, the archive and jobs").
 *
 * **The edit is checked against the job as it would be**, not against
 * the fields that arrived. A person moving a schedule from 08:00 to
 * 09:00 sends a trigger and nothing else, and whether that job can
 * still fire depends on the pipeline and the template it already has —
 * so the patch is merged first and `checkFireable` is asked about the
 * result, which is the same question `createJob` asks about the same
 * shape.
 *
 * A `from-discussion` job is not edited here. Its trigger names the
 * conversation it belongs to and it has neither pipeline nor template
 * by design (ARCHITECTURE.md, "Trigger kinds"); the only thing a person can meaningfully do with
 * one is delete it, which is what the page offers instead.
 *
 * Renaming touches nothing but the job (EO-729): its guards are messages
 * that name it as it is when they are sent.
 */
export function updateJob(db: Db, input: EditJobInput): CreateJobResult {
  const job = getJob(db, input.jobId);
  if (!job || job.deletedAt !== null) return { ok: false, problem: "That job no longer exists." };
  if (job.trigger.kind === "from-discussion") {
    return {
      ok: false,
      problem: "This job belongs to its conversation, so there is nothing here to change. Deleting it is what stops items being recorded as coming from that chat.",
    };
  }

  const name = input.name === undefined ? job.name : input.name.trim();
  if (name === "") return { ok: false, problem: "A job needs a name — it is what the Jobs list shows and what `{{job}}` expands to." };

  const trigger = input.trigger ?? job.trigger;
  if (trigger.kind === "from-discussion") {
    return { ok: false, problem: "A job cannot be turned into a conversation's — pressing Create in a conversation makes its own." };
  }
  const pipelineId = input.pipelineId === undefined ? job.pipelineId : input.pipelineId;
  const template = input.template === undefined ? job.template : input.template;

  const fireable = checkFireable(db, job.projectId as Uuid | null, trigger, pipelineId, template, job.id as Uuid);
  if (fireable !== null) return { ok: false, problem: fireable };
  // Only where the save touches what the rules read, so a rule added
  // later cannot stop somebody renaming a job or changing its budget. A
  // job left as it is fails at the firing, with the sentence in a message to its owner.
  if (input.trigger !== undefined || input.pipelineId !== undefined || input.template !== undefined) {
    const refused = templateRefusal(db, job.projectId as Uuid | null, trigger, pipelineId, template);
    if (refused !== null) return { ok: false, problem: refused };
  }

  const updated = updateJobRow(db, input.jobId, { ...input, name, trigger, pipelineId, template });
  if (!updated) return { ok: false, problem: "That job no longer exists." };
  return { ok: true, job: updated };
}

/**
 * Whether EO can actually compute from this schedule, and the sentence
 * saying it cannot (EO-306).
 *
 * The zone is checked against the machine's own IANA table: a mistyped
 * `Europe/Berln` is not a zone anywhere, and a job stored with one would
 * throw inside the tick rather than at the person who typed it.
 */
function validateSchedule(trigger: ScheduleTrigger): string | null {
  if (!isKnownTimeZone(trigger.timeZone)) {
    return `"${trigger.timeZone}" is not a time zone this machine knows. IANA names look like "Europe/Berlin" or "America/New_York".`;
  }
  const compiled = compileSchedule(trigger.schedule);
  return compiled.ok ? null : compiled.problem;
}

/**
 * The template's type as the resolver takes it.
 *
 * Qualified — `developer:story` — because two packs may ship a `case`
 * and the resolver refuses a word with two answers. A spelling that does
 * not split is handed on as a bare slug rather than dropped, so the
 * refusal naming it comes from the resolver, which knows what this
 * project does have.
 */
function templateType(template: JobTemplate): ItemTypeName {
  return parseQualifiedItemType(template.type) ?? template.type;
}

/** What a person chose about the work a job filed, on the way out (EO-308, ARCHITECTURE.md, "The inbox, the archive and jobs"). */
export interface DeleteJobOptions {
  /** "Archive its items", against "keep them". False is the quiet half of the pair. */
  archiveItems?: boolean;
}

/**
 * Being done with a job (EO-304, EO-308, ARCHITECTURE.md, "The inbox, the archive and jobs").
 *
 * **The row stays and records that it is gone.** EO-304 removed it and
 * let the cascade take its occurrences; this story's delete offers
 * "archive its items" *or* "keep them", and an item somebody chose to
 * keep reads back what filed it through exactly those occurrences. So
 * deleting is `deleted_at`, and what it means is what a person asking
 * for it means: out of every list, out of the scheduler's sweep, out of
 * the conversation-reuse path, refused by Run now. Nothing about what
 * happened while it existed is rewritten, which is what invariant #3
 * asks everywhere else — migration 0080 says the whole of it.
 *
 * **A from-discussion job's conversation is archived rather than
 * deleted.** Archiving a conversation is what closing one already does;
 * deleting that job closes the conversation with it, which is what a
 * person asking for "stop recording items as coming from this chat"
 * means. Everything said in it stays, along with any runs and their
 * cost, and an archived item drops out of `listItems` — which is what
 * stops the mention path from ever dispatching against it again.
 *
 * **"Archive its items" archives; it does not delete.** A job that has
 * run for a year owns a year of work, with its runs, its costs and its
 * conversations on it, and the choice the design offers is between putting that
 * away and leaving it out — not between two kinds of loss. Restoring
 * one is the same button it is for anything else in the archive.
 */
export function deleteJob(db: Db, id: Uuid, options: DeleteJobOptions = {}): { deleted: boolean; archivedItemCount: number } {
  const job = getJob(db, id);
  if (!job || job.deletedAt !== null) return { deleted: false, archivedItemCount: 0 };
  const now = Date.now();
  const conversation = job.trigger.kind === "from-discussion" ? getItem(db, job.trigger.conversationId as Uuid) : undefined;
  if (conversation && conversation.archivedAt === null) setItemArchived(db, conversation.id, now);

  let archivedItemCount = 0;
  if (options.archiveItems === true) {
    // Deduplicated, for `jobCostCents`' reason: one item can be named by
    // more than one occurrence, and counting it twice would make the
    // sentence the dialog reports back untrue.
    for (const itemId of new Set(itemIdsFiredBy(db, id))) {
      const item = getItem(db, itemId as Uuid);
      if (!item || item.archivedAt !== null) continue;
      setItemArchived(db, item.id, now);
      archivedItemCount += 1;
    }
  }

  markJobDeleted(db, id, now);
  return { deleted: true, archivedItemCount };
}
