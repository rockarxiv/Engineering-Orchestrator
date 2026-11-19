import {
  DEFAULT_CATCH_UP_MINUTES,
  JOB_CARD_CLEAR,
  WebhookMappingSchema,
  describeJobTrigger,
  webhookPath,
  type AssistCard,
  type AssistCardDetail,
  type AssistCardView,
  type IpcPayload,
  type Job,
  type JobCardLine,
  type JobCardTemplateSchema,
  type JobCardTrigger,
  type JobCardTriggerEdit,
  type JobRunsOn,
  type JobTrigger,
  type Uuid,
} from "@eo/core";
import type { z } from "zod";
import type { Db } from "../db/client.js";
import { getItem, getJob, getModule, getPipeline, getProject, getWorkspace, itemIdsFiredBy, workspaceLabel } from "../db/repos/index.js";
import { runsOnOf } from "../jobs/placement.js";
import { unfitWatchModule } from "../jobs/watch.js";

/**
 * The assistant's cards for jobs (EO-786): making one, changing one,
 * deleting one, and a webhook job's two buttons — a new signing secret
 * and a test event.
 *
 * The Jobs screen no longer edits a job (EO-784): EO's system agent
 * proposes the change, and the person presses the card's button, which
 * calls `jobs:create`, `update`, `delete`, `regenerateSecret` or
 * `testEvent` — the channels that screen called, with the same refusals.
 * The agent has no tool that writes a job.
 *
 * What the card shows is EO's read of the rows, in words: the job as it
 * is, and as pressing the card would leave it. Never a webhook trigger's
 * signing secret — no card, agent answer or chat comment carries it; the
 * person reads it on the Job page.
 */

export type JobCard = Extract<AssistCard, { kind: "jobCreate" | "jobUpdate" | "jobDelete" | "jobWebhook" }>;
type JobUpdateCard = Extract<AssistCard, { kind: "jobUpdate" }>;
type JobCardTemplate = z.infer<typeof JobCardTemplateSchema>;

/** Whether a card is one of the four for jobs. */
export function isJobCard(card: AssistCard): card is JobCard {
  return card.kind === "jobCreate" || card.kind === "jobUpdate" || card.kind === "jobDelete" || card.kind === "jobWebhook";
}

/** A job as a card describes one, whether it exists yet or not. */
interface JobShape {
  name: string;
  trigger: JobTrigger;
  pipelineId: string | null;
  template: JobCardTemplate | null;
  budgetPerOccurrenceCents: number | null;
  maxItemsPerHour: number | null;
  runsOn: JobRunsOn;
  /** The repository its items are filed on (EO-856), or null for none named. */
  workspaceId: string | null;
}

/**
 * A job the Jobs list keeps, or null: a deleted one, an unknown id, or a
 * conversation's job, which ends with its conversation (`keptByAPerson`
 * in jobCommands.ts, and `job_get`'s answer to the same three).
 */
export function keptJob(db: Db, jobId: string): Job | null {
  const job = getJob(db, jobId as Uuid);
  return job === undefined || job.deletedAt !== null || job.trigger.kind === "from-discussion" ? null : job;
}

function shapeOf(job: Job): JobShape {
  return {
    name: job.name,
    trigger: job.trigger,
    pipelineId: job.pipelineId,
    template: job.template === null ? null : { type: job.template.type, title: job.template.title, body: job.template.body },
    budgetPerOccurrenceCents: job.budgetPerOccurrenceCents,
    maxItemsPerHour: job.maxItemsPerHour,
    runsOn: runsOnOf(job),
    workspaceId: job.workspaceId,
  };
}

/**
 * A card's trigger as `jobs:create` and `jobs:update` take one. A
 * schedule's grace left null is the one the job has where it already
 * runs on a schedule, and EO's default otherwise.
 */
export function triggerOfCard(trigger: JobCardTrigger, standing: JobTrigger | null = null): JobTrigger {
  switch (trigger.kind) {
    case "manual":
      return { kind: "manual" };
    case "schedule":
      return {
        kind: "schedule",
        schedule: trigger.schedule,
        timeZone: trigger.timeZone,
        catchUpWithinMinutes: trigger.catchUpWithinMinutes ?? (standing?.kind === "schedule" ? standing.catchUpWithinMinutes : DEFAULT_CATCH_UP_MINUTES),
      };
    case "watch":
      return { kind: "watch", moduleId: trigger.moduleId, inputs: trigger.inputs, everyMinutes: trigger.everyMinutes, waitWhileOpen: trigger.waitWhileOpen };
  }
}

/** The job a create card would make. */
function shapeOfCreate(card: Extract<AssistCard, { kind: "jobCreate" }>): JobShape {
  return {
    name: card.name.trim(),
    trigger: triggerOfCard(card.trigger),
    pipelineId: card.pipelineId,
    template: card.template,
    budgetPerOccurrenceCents: card.budgetPerOccurrenceCents,
    maxItemsPerHour: card.maxItemsPerHour,
    runsOn: card.runsOn ?? "device",
    workspaceId: card.workspaceId,
  };
}

/**
 * The trigger an update card saves, or the sentence refusing it.
 *
 * A webhook job stays one and keeps its address and its signing secret:
 * the sender is configured with both, so the card changes only what it
 * files. The two are filled in from the job as it stands, which is the
 * only place a card meets the secret, and nothing it shows repeats it.
 * And no job becomes a webhook job on a card: there is no secret to give it.
 */
function editedTrigger(standing: JobTrigger, edit: JobCardTriggerEdit): JobTrigger | string {
  if (standing.kind === "webhook") {
    if (edit.kind !== "webhook") {
      return `This is a webhook job, and making it a ${edit.kind} job would take away the address and signing secret its sender is configured with. A card changes only what a webhook job files, as \`{ "kind": "webhook", "mapping": … }\`.`;
    }
    return { kind: "webhook", path: standing.path, secret: standing.secret, mapping: WebhookMappingSchema.parse(edit.mapping) };
  }
  if (edit.kind === "webhook") return "This is not a webhook job, and a card does not make one a webhook job.";
  return triggerOfCard(edit, standing);
}

/** Two values the same, whatever order their keys were written in. */
function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );
}

/**
 * What an update card asks `jobs:update` for — only what it would
 * actually change — or the sentence refusing its trigger. A value the
 * card repeats is left out rather than sent, so a card that restates the
 * job changes nothing and is said to.
 */
export function jobUpdatePayload(job: Job, card: JobUpdateCard): IpcPayload<"jobs:update"> | string {
  const standing = shapeOf(job);
  const payload: IpcPayload<"jobs:update"> = { jobId: job.id };
  if (card.name !== null && card.name.trim() !== standing.name) payload.name = card.name;
  if (card.trigger !== null) {
    const trigger = editedTrigger(job.trigger, card.trigger);
    if (typeof trigger === "string") return trigger;
    if (!same(trigger, job.trigger)) payload.trigger = trigger;
  }
  if (card.pipelineId !== null && card.pipelineId !== standing.pipelineId) payload.pipelineId = card.pipelineId;
  if (card.template !== null && !same(card.template, standing.template)) payload.template = card.template;
  const budget = card.budgetPerOccurrenceCents === JOB_CARD_CLEAR ? null : card.budgetPerOccurrenceCents;
  if (card.budgetPerOccurrenceCents !== null && budget !== standing.budgetPerOccurrenceCents) payload.budgetPerOccurrenceCents = budget;
  const cap = card.maxItemsPerHour === JOB_CARD_CLEAR ? null : card.maxItemsPerHour;
  if (card.maxItemsPerHour !== null && cap !== standing.maxItemsPerHour) payload.maxItemsPerHour = cap;
  if (card.runsOn !== null && card.runsOn !== standing.runsOn) payload.runsOn = card.runsOn;
  const repository = card.workspaceId === JOB_CARD_CLEAR ? null : card.workspaceId;
  if (card.workspaceId !== null && repository !== standing.workspaceId) payload.workspaceId = repository;
  return payload;
}

/** Whether an update asks for anything at all. */
function changesSomething(payload: IpcPayload<"jobs:update">): boolean {
  return Object.keys(payload).some((key) => key !== "jobId");
}

/** The job as an update would leave it. */
function shapeAfter(job: Job, payload: IpcPayload<"jobs:update">): JobShape {
  const standing = shapeOf(job);
  return {
    name: payload.name?.trim() ?? standing.name,
    trigger: payload.trigger ?? standing.trigger,
    pipelineId: payload.pipelineId === undefined ? standing.pipelineId : payload.pipelineId,
    template: payload.template === undefined ? standing.template : payload.template,
    budgetPerOccurrenceCents: payload.budgetPerOccurrenceCents === undefined ? standing.budgetPerOccurrenceCents : payload.budgetPerOccurrenceCents,
    maxItemsPerHour: payload.maxItemsPerHour === undefined ? standing.maxItemsPerHour : payload.maxItemsPerHour,
    runsOn: payload.runsOn ?? standing.runsOn,
    workspaceId: payload.workspaceId === undefined ? standing.workspaceId : payload.workspaceId,
  };
}

const NO_CHANGE = (name: string) => `“${name}” already is what the card says, so there is nothing to change.`;

/** Why a pipeline cannot be named on a job card, or null. */
function pipelineRefusal(db: Db, pipelineId: string): string | null {
  const pipeline = getPipeline(db, pipelineId);
  if (pipeline !== undefined && pipeline.archivedAt === null) return null;
  return (
    `No card was offered: there is no pipeline with the ID "${pipelineId}"${pipeline === undefined ? "" : " that has not been deleted"}. ` +
    "Read the pipelines with `pipelines_list` and name one by the ID it gives."
  );
}

/** Why a watch trigger's module cannot be named, or null: one not here, archived, unapproved, or not declaring `watch: true`. */
function watchRefusal(db: Db, trigger: { kind: string; moduleId?: string }): string | null {
  if (trigger.kind !== "watch" || trigger.moduleId === undefined) return null;
  const unfit = unfitWatchModule(getModule(db, trigger.moduleId), trigger.moduleId);
  return unfit === null ? null : `No card was offered: ${unfit}`;
}

const NO_JOB = (jobId: string) =>
  `No card was offered: there is no job with the ID "${jobId}" on the Jobs list — it was deleted, it never existed, or it is a conversation's job, which ends with its conversation. ` +
  "Read the jobs with `jobs_list` or `job_get` and name one by the ID it gives.";

/**
 * Why a job card cannot be offered at all, or null when it can — asked
 * when the reply is posted (see `assistCardRefusal`).
 *
 * What makes the card about nothing: a project, a pipeline, a job or a
 * watch module that is not here or not approved, a change that changes
 * nothing, a webhook button on a job that is not a webhook job. What
 * `jobs:create` or `update` would refuse beyond those — a schedule that
 * does not parse, an item type the project lacks — is the press's to
 * say, and is filed under the card as its refusal.
 */
export function jobCardRefusal(db: Db, card: JobCard): string | null {
  if (card.kind === "jobCreate") {
    const project = getProject(db, card.projectId as Uuid);
    if (project === undefined || project.archivedAt !== null) {
      return (
        `No card was offered: there is no project with the ID "${card.projectId}"${project === undefined ? "" : " that has not been archived"}. ` +
        "Read the projects with `projects_list` and name one by the ID it gives."
      );
    }
    return pipelineRefusal(db, card.pipelineId) ?? watchRefusal(db, card.trigger);
  }
  const job = keptJob(db, card.jobId);
  if (job === null) return NO_JOB(card.jobId);
  if (card.kind === "jobWebhook" && job.trigger.kind !== "webhook") {
    return `No card was offered: “${job.name}” is not a webhook job, so it has no secret to replace and nothing to send a test event to.`;
  }
  if (card.kind !== "jobUpdate") return null;
  if (card.pipelineId !== null) {
    const refused = pipelineRefusal(db, card.pipelineId);
    if (refused !== null) return refused;
  }
  if (card.trigger !== null) {
    const refused = watchRefusal(db, card.trigger);
    if (refused !== null) return refused;
  }
  const payload = jobUpdatePayload(job, card);
  if (typeof payload === "string") return `No card was offered: ${payload}`;
  return changesSomething(payload) ? null : `No card was offered: ${NO_CHANGE(job.name)}`;
}

function minutes(count: number): string {
  return count === 1 ? "1 minute" : `${count} minutes`;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** A trigger in words, with its time zone where it has one — and never a webhook's secret. */
function triggerWords(trigger: JobTrigger): string {
  if (trigger.kind === "schedule") {
    return `${describeJobTrigger(trigger)}, ${trigger.timeZone} — a missed time is still run within ${minutes(trigger.catchUpWithinMinutes)}`;
  }
  if (trigger.kind === "webhook") return `${describeJobTrigger(trigger)}, at ${webhookPath(trigger.path)}`;
  return describeJobTrigger(trigger);
}

/** A webhook job's mapping in words: what each part of the item is filled from. */
function mappingWords(trigger: Extract<JobTrigger, { kind: "webhook" }>): string {
  const { title, body, eventKey, spec } = trigger.mapping;
  const parts = [
    title === null ? null : `title from ${title}`,
    body === null ? null : `body from ${body}`,
    eventKey === null ? null : `event key from ${eventKey}`,
    ...Object.entries(spec).map(([field, pointer]) => `${field} from ${pointer}`),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "Nothing — the template as it is" : parts.join(", ");
}

/**
 * A job, line by line, as a job card shows it: what the Job page calls
 * each field, and its value in words.
 */
function linesOf(db: Db, shape: JobShape): JobCardLine[] {
  const { trigger } = shape;
  const pipeline = shape.pipelineId === null ? undefined : getPipeline(db, shape.pipelineId);
  const lines: JobCardLine[] = [
    { label: "Name", value: shape.name },
    { label: "Trigger", value: triggerWords(trigger) },
  ];
  if (trigger.kind === "watch") {
    const inputs = Object.entries(trigger.inputs);
    lines.push(
      { label: "Module", value: getModule(db, trigger.moduleId)?.name ?? trigger.moduleId },
      { label: "Inputs", value: inputs.length === 0 ? "None — the module's defaults" : inputs.map(([name, value]) => `${name} = ${JSON.stringify(value)}`).join(", ") },
      { label: "Checks every", value: minutes(trigger.everyMinutes) },
      { label: "Wait while open", value: trigger.waitWhileOpen ? "Yes — no check while an item it filed is unfinished" : "No" },
    );
  }
  if (trigger.kind === "webhook") lines.push({ label: "From the event", value: mappingWords(trigger) });
  lines.push(
    { label: "Pipeline", value: shape.pipelineId === null ? "None" : (pipeline?.name ?? shape.pipelineId) },
    { label: "Template type", value: shape.template?.type ?? "None" },
    { label: "Title", value: shape.template?.title ?? "None" },
    { label: "Body", value: shape.template?.body ?? "None" },
    { label: "Budget per run", value: shape.budgetPerOccurrenceCents === null ? "None" : money(shape.budgetPerOccurrenceCents) },
    { label: "Items an hour", value: shape.maxItemsPerHour === null ? "No cap" : `At most ${shape.maxItemsPerHour}` },
    { label: "Runs on", value: shape.runsOn === "server" ? "The organisation server" : "This machine" },
    { label: "Repository", value: repositoryWords(db, shape.workspaceId) },
  );
  return lines;
}

/** The repository a job names (EO-856), by its name where it is still here. */
function repositoryWords(db: Db, workspaceId: string | null): string {
  if (workspaceId === null) return "None named — the project's only repository, if it has one";
  const workspace = getWorkspace(db, workspaceId as Uuid);
  return workspace === undefined ? `${workspaceId}, which no longer exists` : workspaceLabel(workspace);
}

/** Each line an update changes, as it is and as it would be. */
function changesOf(db: Db, job: Job, payload: IpcPayload<"jobs:update">): { label: string; before: string; after: string }[] {
  const before = linesOf(db, shapeOf(job));
  const after = linesOf(db, shapeAfter(job, payload));
  const labels = [...new Set([...before, ...after].map((line) => line.label))];
  const valueOf = (lines: JobCardLine[], label: string) => lines.find((line) => line.label === label)?.value ?? "—";
  return labels.map((label) => ({ label, before: valueOf(before, label), after: valueOf(after, label) })).filter((change) => change.before !== change.after);
}

/**
 * The sentence filed under a create card once it is done, which names the
 * job it made — and the job it names, read back out, for the card's link.
 * One pair, so what is written and what is read cannot drift.
 */
export function createdJobSaid(job: { id: string; name: string }, notice: string | null | undefined): string {
  return [`Created the job “${job.name}” (job ${job.id}).`, notice ?? ""].filter(Boolean).join(" ");
}

function createdJobOf(db: Db, outcome: AssistCardView["outcome"]): { jobId: string; name: string } | null {
  const id = outcome?.done ? /\(job ([^)\s]+)\)/.exec(outcome.said)?.[1] : undefined;
  const job = id === undefined ? null : keptJob(db, id);
  return job === null ? null : { jobId: job.id, name: job.name };
}

/** The sentence filed under a test event card when its event filed an item — and the item, read back out. */
export function filedItemSaid(item: { id: string; key: string }): string {
  return `It filed ${item.key} (item ${item.id}).`;
}

function filedItemOf(db: Db, outcome: AssistCardView["outcome"]): { itemId: string; itemKey: string } | null {
  const id = outcome?.done ? /\(item ([^)\s]+)\)/.exec(outcome.said)?.[1] : undefined;
  const item = id === undefined ? undefined : getItem(db, id as Uuid);
  return item === undefined ? null : { itemId: item.id, itemKey: item.key };
}

/**
 * What a job card shows, read now (EO-786), or the sentence for a card
 * whose project or job has gone since. `outcome` is what pressing it came
 * to, for the link to what it made.
 */
export function jobCardDetail(db: Db, card: JobCard, outcome: AssistCardView["outcome"]): { detail: AssistCardDetail } | { problem: string } {
  if (card.kind === "jobCreate") {
    const project = getProject(db, card.projectId as Uuid);
    if (project === undefined) return { problem: "The project this card was about no longer exists." };
    const shape = shapeOfCreate(card);
    return { detail: { kind: card.kind, projectName: project.name, name: shape.name, lines: linesOf(db, shape), created: createdJobOf(db, outcome) } };
  }

  const job = keptJob(db, card.jobId);
  if (job === null) return { problem: "The job this card was about is not on the Jobs list any more." };
  switch (card.kind) {
    case "jobDelete":
      return { detail: { kind: card.kind, jobId: job.id, jobName: job.name, lines: linesOf(db, shapeOf(job)), itemCount: liveItemsOf(db, job) } };
    case "jobWebhook":
      if (job.trigger.kind !== "webhook") return { problem: `“${job.name}” is not a webhook job any more.` };
      return {
        detail: { kind: card.kind, jobId: job.id, jobName: job.name, action: card.action, address: webhookPath(job.trigger.path), filed: card.action === "testEvent" ? filedItemOf(db, outcome) : null },
      };
    case "jobUpdate": {
      const payload = jobUpdatePayload(job, card);
      if (typeof payload === "string") return { problem: payload };
      if (!changesSomething(payload)) return { problem: NO_CHANGE(job.name) };
      return { detail: { kind: card.kind, jobId: job.id, jobName: job.name, changes: changesOf(db, job, payload) } };
    }
  }
}

/** The items a job filed that are not archived — what "archive its items" puts away, counted as `deleteJob` counts them. */
function liveItemsOf(db: Db, job: Job): number {
  return [...new Set(itemIdsFiredBy(db, job.id as Uuid))].filter((itemId) => {
    const item = getItem(db, itemId as Uuid);
    return item !== undefined && item.archivedAt === null;
  }).length;
}

function described(lines: readonly JobCardLine[]): string {
  return lines.map((line) => `${line.label}: ${line.value}`).join("; ");
}

/**
 * What a job card says in prose — what a later turn reads back. The job
 * as it would be, and what pressing it does. Never a webhook's secret.
 */
export function jobCardBody(db: Db, card: JobCard): string {
  const read = jobCardDetail(db, card, null);
  if ("problem" in read) return read.problem;
  const { detail } = read;
  switch (detail.kind) {
    case "jobCreate":
      return `**Create** the job “${detail.name}” on ${detail.projectName}. ${described(detail.lines)}. Nothing is made until Create job is pressed on the card.`;
    case "jobUpdate":
      return (
        `**Change** the job “${detail.jobName}”: ${detail.changes.map((change) => `${change.label} ${change.before} → ${change.after}`).join("; ")}. ` +
        "Nothing changes until Save job is pressed on the card."
      );
    case "jobDelete":
      return (
        `**Delete** the job “${detail.jobName}”. It fires nothing again; the person chooses on the card whether its ${detail.itemCount === 1 ? "item is" : `${detail.itemCount} items are`} kept or archived. ` +
        "Nothing is deleted until Delete job is pressed on the card."
      );
    case "jobWebhook":
      return detail.action === "regenerateSecret"
        ? `**Regenerate the signing secret** of “${detail.jobName}”. The old secret stops working the moment the button is pressed, so every sender still signing with it is refused until it is given the new one, which the person reads on the Job page. Nothing changes until Regenerate secret is pressed on the card.`
        : `**Send a test event** to “${detail.jobName}”, through its webhook at ${detail.address}, signed with its own secret. It may file an item on its pipeline. Nothing is sent until Send test event is pressed on the card.`;
    default:
      return "";
  }
}
