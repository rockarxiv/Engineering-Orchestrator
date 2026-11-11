import {
  EMPTY_WEBHOOK_MAPPING,
  WEBHOOK_TIMESTAMP_TOLERANCE_MS,
  resolveJsonPointer,
  webhookFieldText,
  type Item,
  type Job,
  type JobEvent,
  type JobEventOutcome,
  type Uuid,
  type WebhookMapping,
  type WebhookTrigger,
} from "@eo/core";
import type { AttachmentStorage } from "../attachments/storage.js";
import type { Db } from "../db/client.js";
import {
  eventAccepted,
  firedSince,
  getJob,
  getPipeline,
  heldEventCount,
  heldEvents,
  insertAttachments,
  jobsHoldingEvents,
  listAllJobs,
  postComment,
  recordJobEvent,
} from "../db/repos/index.js";
import { fireJob, jobEntryVerdicts } from "./fire.js";
import { JOB_MESSAGE_SOURCE, messageJobOwner } from "./ownerMessage.js";
import { hashWebhookBody, webhookSignatureMatches } from "./webhookSignature.js";

/**
 * The webhook endpoint's whole decision (EO-332,
 * `ARCHITECTURE.md`, "Trigger kinds",
 * "Webhooks").
 *
 * **A webhook always arrives at the server**, since only the server has
 * a public address. It verifies the signature, records the event with
 * its key, refuses a replay, applies the job's cap and creates the item;
 * the job's machine picks that item up when it is online and dispatches
 * it as any other. The server is the mailbox, not the runtime.
 *
 * Above the repository for `main/jobs/jobs.ts`'s reason: none of what
 * follows is a question about the `job_events` table and all of it is a
 * question about jobs, items and threads.
 *
 * ### One row per request, and one channel for the guards
 *
 * The review found the first draft had no answer to where a
 * deduplicated, malformed or over-cap event is recorded. It does now:
 * every request writes exactly one `job_events` row, and every outcome
 * that is not `created` — bar the two below — also sends the job's owner
 * a message (EO-729), because a guard where there is no item ends in a
 * message to the person who must act (invariant #8).
 *
 * ### Where the work then runs
 *
 * Nowhere near here. A webhook arrives at the server whatever the job's
 * `runsOn` says (EO-330 leaves this phase that sentence explicitly), and
 * what this file produces is an ordinary item on an ordinary step. Which
 * machine picks it up is placement's question, asked of the job by the
 * record's own dispatcher, and nothing about it is decided at the door.
 *
 * **Bad signatures and replays are recorded and never posted.** That is
 * the exception the story names and the reason for it is the attacker:
 * a stranger who can make EO send a message by sending an unsigned
 * request can fill somebody's inbox from the outside, which is a denial
 * of service dressed as a guard. They are counted at the door instead
 * (the throttle in `server/http.ts`) and readable on the Events tab,
 * which is where somebody looking for them would look.
 */

/** A delivery as the door read it, before anything about it is believed. */
export interface WebhookDelivery {
  /** The segment after `/webhooks/`. */
  path: string;
  /** The body exactly as it arrived. Raw, because the signature is over these bytes. */
  rawBody: string;
  /** `X-EO-Signature`, or null where the sender sent none. */
  signature: string | null;
  /** `X-EO-Timestamp`, as it was sent — parsed here rather than by the door. */
  timestamp: string | null;
  /** The moment the door read it. Injected so a test drives the clock rather than waiting for it. */
  now?: number;
}

export interface WebhookDeps {
  /**
   * Where the payload is kept as a file.
   *
   * Absent means the payload is not attached — which is a test with no
   * temporary directory, and never the server: `startMain` has one in
   * its hand when it builds this. The item is still created, because an
   * item is what the event is *for* and a missing attachment is not a
   * reason to drop somebody's work.
   */
  storage?: AttachmentStorage;
}

/**
 * What the door answers with.
 *
 * `outcome` is null in exactly one case: no job owns that path, so there
 * was nothing to record a row against — `job_events.job_id` is a real
 * foreign key and a row for a job that does not exist is not a thing
 * this table can hold.
 */
export interface WebhookAnswer {
  status: number;
  outcome: JobEventOutcome | null;
  /** The row, for a caller that wants to assert on it. Null when none was written. */
  event?: JobEvent | null;
  /** What it created, where it created something. */
  itemId?: string | null;
}

/**
 * How many events one job will hold before it starts refusing them.
 *
 * A ceiling on the queue, and it is the difference between `held` and
 * `over_cap`. Holding is the right answer to a burst — the work is
 * wanted, it is only wanted more slowly — but a queue EO would grow
 * without limit is a disk somebody else fills by sending, and a person
 * coming back to five thousand items filed overnight is not being served
 * either. Five hundred is a fortnight of a job capped at ten an hour,
 * which is long enough that anybody reaching it has a runaway sender
 * rather than a busy morning.
 */
export const MAX_HELD_EVENTS = 500;

const HOUR_MS = 60 * 60 * 1000;

/** Milliseconds a timestamp header may be, as an integer. Anything else is not a timestamp. */
const TIMESTAMP_PATTERN = /^[0-9]{1,15}$/;

/**
 * The one word EO answers a sender with (ARCHITECTURE.md, "Webhooks").
 *
 * Deliberately not `describeJobEventOutcome`, which is the Events tab's
 * vocabulary and is read by somebody who signed in. This is read by a
 * stranger's HTTP client, and the two refusals collapse into one word on
 * purpose: a sender that could tell a bad signature from a stale
 * timestamp learns which half of the scheme to work on, and the row —
 * behind the admin's own sign-in — is where the difference is kept.
 *
 * `held` says "waiting" rather than "held", because what a sender needs
 * from this word is whether to retry, and "waiting" is the only one of
 * the two that says no.
 */
export function webhookAnswerWord(outcome: JobEventOutcome | null): string {
  switch (outcome) {
    case "created":
      return "created";
    case "deduplicated":
      return "deduplicated";
    case "held":
      return "waiting";
    case "malformed":
      return "unreadable";
    case "over_cap":
    case "refused":
      return "refused";
    case "rejected_signature":
    case "rejected_replay":
      return "rejected";
    case null:
    case undefined:
      return "unknown";
  }
}

/**
 * The job this path belongs to, or undefined.
 *
 * Walked rather than queried, because the path lives inside the trigger
 * JSON and an installation has jobs in the tens: an index over an
 * extracted JSON field would be a second place the path is written down
 * and a migration to keep in step, to save a scan of a table a person
 * scrolls. `listAllJobs` passes over deleted jobs, which is what makes a
 * deleted job's webhook a 404 rather than a row nobody will read.
 */
export function jobForWebhookPath(db: Db, path: string): Job | undefined {
  return listAllJobs(db).find((job) => job.trigger.kind === "webhook" && job.trigger.path === path);
}

/**
 * Receives one delivery, decides it, and records what it decided.
 *
 * The order of the checks is the design: the signature before anything
 * is read from the body, the window after it (the timestamp is inside
 * the signature, so an unverified one is a number an attacker chose),
 * the payload after that, the event key after the payload, and the cap
 * last — because a duplicate that was going to be refused as a duplicate
 * should not first consume an hour's allowance.
 */
export async function receiveWebhook(db: Db, delivery: WebhookDelivery, deps: WebhookDeps = {}): Promise<WebhookAnswer> {
  const now = delivery.now ?? Date.now();
  const job = jobForWebhookPath(db, delivery.path);
  if (job === undefined || job.trigger.kind !== "webhook") {
    // No row, because there is no job to file one against — and one
    // sentence for a path that never existed and a job somebody
    // deleted, for `SIGN_IN_AGAIN`'s reason: telling them apart is how
    // a stranger enumerates the paths an installation once had.
    return { status: 404, outcome: null, event: null, itemId: null };
  }
  const trigger = job.trigger;

  // The signature first, over the raw bytes, and nothing of the body is
  // believed until it passes. The key on these rows is a hash of what
  // arrived rather than anything read out of it: a pointer into an
  // unverified document is a pointer a stranger chose.
  const timestamp = readTimestamp(delivery.timestamp);
  if (timestamp === null || delivery.signature === null || !webhookSignatureMatches(trigger.secret, timestamp, delivery.rawBody, delivery.signature)) {
    return refused(db, job, now, delivery.rawBody, "rejected_signature", "Its signature did not match this job's secret.");
  }
  if (Math.abs(now - timestamp) > WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
    return refused(db, job, now, delivery.rawBody, "rejected_replay", "Its timestamp is outside the window EO accepts.");
  }

  // Signed by somebody holding the secret, so from here on the body is
  // this job's event and is kept in full whatever becomes of it.
  const parsed = readPayload(delivery.rawBody);
  if (!parsed.ok) {
    return recorded(db, job, {
      receivedAt: now,
      eventKey: hashWebhookBody(delivery.rawBody),
      payload: delivery.rawBody,
      outcome: "malformed",
      reason: parsed.problem,
      status: 400,
    });
  }

  const mapping = trigger.mapping ?? EMPTY_WEBHOOK_MAPPING;
  const declared = mapping.eventKey === null ? null : webhookFieldText(resolveJsonPointer(parsed.payload, mapping.eventKey));
  if (mapping.eventKey !== null && declared === null) {
    // A mapping that does not fit this payload, said out loud rather
    // than fallen back from. Falling back to a hash of the body would
    // dedupe by accident and leave a person with a field-mapping table
    // that has been quietly wrong since the day they saved it.
    return recorded(db, job, {
      receivedAt: now,
      eventKey: hashWebhookBody(delivery.rawBody),
      payload: delivery.rawBody,
      outcome: "malformed",
      reason: `Its event key is mapped to "${mapping.eventKey}", and this payload has nothing there.`,
      status: 400,
    });
  }
  const eventKey = declared ?? hashWebhookBody(delivery.rawBody);

  if (eventAccepted(db, job.id as Uuid, eventKey)) {
    return recorded(db, job, {
      receivedAt: now,
      eventKey,
      payload: delivery.rawBody,
      outcome: "deduplicated",
      reason: "This job has already had this event, so no second item was created.",
      // 200 rather than a 4xx, and deliberately: a sender retrying
      // after a timeout has done nothing wrong, and answering it an
      // error would have it retry again.
      status: 200,
    });
  }

  // The job's own reasons, and then the queue's: nothing may overtake
  // what is already waiting. Without the second a burst would be filed
  // out of order the moment an hour rolled over — the newest delivery
  // would find room while the oldest was still in the queue behind it.
  // It is asked here and not in `whyItWaits` because the release path
  // is *draining* that queue, and a check that refused while anything
  // was waiting would refuse for ever.
  const wait =
    whyItWaits(db, job, now) ??
    (heldEventCount(db, job.id as Uuid) > 0 ? "Events that arrived before this one are still waiting." : null);
  if (wait !== null) {
    if (heldEventCount(db, job.id as Uuid) >= MAX_HELD_EVENTS) {
      return recorded(db, job, {
        receivedAt: now,
        eventKey,
        payload: delivery.rawBody,
        outcome: "over_cap",
        reason: `${wait} It is already holding ${MAX_HELD_EVENTS} events, so this one was refused rather than added to them.`,
        status: 429,
      });
    }
    return recorded(db, job, {
      receivedAt: now,
      eventKey,
      payload: delivery.rawBody,
      outcome: "held",
      reason: wait,
      // Accepted, and not yet acted on — which is exactly what 202 is
      // for and what a sender needs to hear so that it does not retry.
      status: 202,
    });
  }

  const accepted: AcceptedEvent = { receivedAt: now, eventKey, payload: delivery.rawBody };
  const filed = await fileTheItem(db, job, accepted, deps, now);
  if (filed.kind === "created") return { status: 202, outcome: "created", event: filed.row, itemId: filed.item.id };
  if (filed.kind === "duplicate") {
    return recorded(db, job, {
      ...accepted,
      outcome: "deduplicated",
      reason: "This job has already had this event, so no second item was created.",
      status: 200,
    });
  }
  if (filed.kind === "refused") {
    // 422: read and understood, and no amount of sending it again makes
    // this payload fill the field. `fireJob` has told the owner.
    return recorded(db, job, { ...accepted, outcome: "refused", reason: filed.reason, status: 422 });
  }
  return recorded(db, job, { ...accepted, outcome: "held", reason: filed.reason, status: 202 });
}

/**
 * Releases what is waiting, oldest first (ARCHITECTURE.md, "Controls", "The inbox, the archive and
 * jobs").
 *
 * Called from the job tick, which is where it belongs: the record owns
 * the scheduler, and a burst held at 09:00 is released by the same sweep
 * that decides every other occurrence. Per job and in arrival order, so
 * the tenth event of a burst is never overtaken by the fortieth.
 *
 * A job that still cannot file work — paused, or its pipeline deleted —
 * is passed over in silence. It said why when it held the first one, and
 * a sentence a minute about a state that has not changed is how an inbox
 * becomes something nobody reads.
 */
export async function releaseHeldWebhookEvents(db: Db, deps: WebhookDeps & { now?: number } = {}): Promise<JobEvent[]> {
  const now = deps.now ?? Date.now();
  const released: JobEvent[] = [];
  for (const jobId of jobsHoldingEvents(db)) {
    const job = getJob(db, jobId as Uuid);
    if (job === undefined || job.trigger.kind !== "webhook") continue;
    for (const held of heldEvents(db, jobId as Uuid)) {
      // Asked again for every event rather than once per job, because
      // filing one is what puts the next one over the cap.
      if (whyItWaits(db, job, now) !== null) break;
      const filed = await fileTheItem(db, job, { receivedAt: held.receivedAt, eventKey: held.eventKey, payload: held.payload }, deps, now);
      // Anything but a creation means this job cannot file work at all
      // this minute, so the rest of its queue keeps its order and waits
      // for the next sweep. Nothing is recorded for it: the `held` row
      // is already the record, and a second one per minute would grow
      // the queue this loop exists to drain.
      //
      // Except one the pipeline's entry rules refuse (EO-610): that is
      // this event's own problem, and it would wait at the head of the
      // queue for ever with every later one behind it. Recorded, which
      // is what takes it out of the queue, and the next one goes on.
      if (filed.kind === "refused") {
        recordJobEvent(db, { jobId: job.id as Uuid, receivedAt: held.receivedAt, eventKey: held.eventKey, payload: held.payload, outcome: "refused", reason: filed.reason });
        continue;
      }
      if (filed.kind !== "created") break;
      released.push(filed.row);
    }
  }
  return released;
}

/** The event, as the two callers that create an item from one hold it. */
interface AcceptedEvent {
  receivedAt: number;
  eventKey: string;
  payload: string;
}

/**
 * What came of trying to file one.
 *
 * Returned rather than recorded here, because the two callers record
 * different things. A delivery that cannot be filed writes a `held` row
 * saying why; the tick releasing a queue writes nothing at all, because
 * the row is already there — a second one per minute would grow the
 * queue this function exists to drain.
 */
type FileResult = { kind: "created"; item: Item; row: JobEvent } | { kind: "duplicate" } | { kind: "unfiled"; reason: string } | { kind: "refused"; reason: string };

/**
 * Creates the item, records the event that created it, and attaches the
 * payload.
 *
 * The item and the row go in one transaction, so a delivery that loses
 * the race on the unique index leaves no item behind: SQLite refuses the
 * second `created` row for one event key, the transaction rolls back,
 * and what is recorded instead is the `deduplicated` row that is the
 * truth of it. That is the original design's "an event key that is unique per job so
 * the same event never creates two items", enforced rather than hoped
 * for — a read-then-write would have a window two deliveries fit inside.
 *
 * `createdBy` is the job's owner, which is `fireJob`'s rule and not this
 * one: the server creates the item and the owner's inbox is where its
 * mentions go (ARCHITECTURE.md, "Where a job runs").
 */
async function fileTheItem(db: Db, job: Job, event: AcceptedEvent, deps: WebhookDeps, now: number): Promise<FileResult> {
  const trigger = job.trigger as WebhookTrigger;
  const overrides = itemFromPayload(trigger.mapping ?? EMPTY_WEBHOOK_MAPPING, event.payload);

  // The pipeline's module entry rules first (EO-736): the firing below is
  // one transaction, which cannot wait on a module.
  const entryVerdicts = await jobEntryVerdicts(db, job, { dueAt: event.receivedAt, firedAt: now, overrides });
  let filed: { item: Item; row: JobEvent } | { refused: string };
  try {
    filed = db.transaction(() => {
      // `dueAt` is when the event arrived and `firedAt` is when EO got
      // to it, and for a held event those are hours apart: the
      // occurrence keeps both, which is what makes the cap countable
      // and the history readable.
      const fired = fireJob(db, job, { dueAt: event.receivedAt, firedAt: now, overrides, entryVerdicts });
      // Returned rather than thrown: this firing is over, and its `failed`
      // occurrence and the owner's message have to outlive this
      // transaction, which a throw would take back (EO-610).
      if (fired.item === null && fired.refusedAtEntry === true) return { refused: fired.problem ?? "Its pipeline refused it." };
      if (fired.item === null) throw new Unfiled(fired.problem ?? "EO could not file an item for it.");
      return {
        item: fired.item,
        row: recordJobEvent(db, {
          jobId: job.id as Uuid,
          receivedAt: event.receivedAt,
          eventKey: event.eventKey,
          payload: event.payload,
          outcome: "created",
          itemId: fired.item.id,
        }),
      };
    });
  } catch (error) {
    // Nothing of this firing survives the rollback, and the caller's
    // `held` row is the record of it: the job tries again when it can.
    if (error instanceof Unfiled) return { kind: "unfiled", reason: error.reason };
    // Everything else is the unique index doing its job.
    return { kind: "duplicate" };
  }

  if ("refused" in filed) return { kind: "refused", reason: filed.refused };
  await attachPayload(db, filed.item, event.payload, deps);
  return { kind: "created", item: filed.item, row: filed.row };
}

/** Carries "nothing was filed" out through the transaction that has to roll back for it. */
class Unfiled extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "Unfiled";
  }
}

/**
 * What the payload says the item should be.
 *
 * Only what resolves. A pointer that finds nothing leaves the template's
 * own text standing, which is what makes a mapping something a person
 * can add one field at a time rather than a thing that must be complete
 * before the job works at all.
 */
function itemFromPayload(mapping: WebhookMapping, rawBody: string): { title?: string; body?: string; spec?: Record<string, unknown> } {
  let document: unknown;
  try {
    document = JSON.parse(rawBody);
  } catch {
    return {};
  }
  const title = mapping.title === null ? null : webhookFieldText(resolveJsonPointer(document, mapping.title));
  const body = mapping.body === null ? null : webhookFieldText(resolveJsonPointer(document, mapping.body));
  const spec: Record<string, unknown> = {};
  for (const [field, pointer] of Object.entries(mapping.spec)) {
    const value = resolveJsonPointer(document, pointer);
    if (value !== undefined) spec[field] = value;
  }
  return {
    // An empty string is not a title. A template's title is what the
    // board shows, and a sender whose summary field is blank would
    // otherwise file a card with no name on it.
    ...(title === null || title.trim() === "" ? {} : { title }),
    ...(body === null ? {} : { body }),
    ...(Object.keys(spec).length === 0 ? {} : { spec }),
  };
}

/**
 * The payload as a file on the item (ARCHITECTURE.md, "The inbox, the archive and jobs", and
 * "Webhooks"'s own reason).
 *
 * An attachment rather than the item's description, which is the design in as
 * many words: a webhook payload is never the item's own text. It hangs
 * off an engine comment, because that is what an attachment hangs off in
 * this app and a file with no comment is a file nothing in the thread
 * mentions.
 *
 * Never the reason an item is lost. The item is already created and
 * committed by the time this runs; a storage that cannot write is a
 * problem with the file, and the work still belongs on the board.
 */
async function attachPayload(db: Db, item: Item, payload: string, deps: WebhookDeps): Promise<void> {
  const storage = deps.storage;
  if (storage === undefined) return;
  try {
    const stored = await storage.storeImported({ name: "payload.json", mimeType: "application/json", data: Buffer.from(payload, "utf8") });
    const comment = postComment(db, {
      itemId: item.id,
      author: { type: "engine" },
      kind: "note",
      body: WEBHOOK_PAYLOAD_NOTE,
      // EO's own sentence, so nothing in it is re-read as an @-mention.
      parseBodyMentions: false,
    });
    insertAttachments(db, [{ ...stored, itemId: item.id, commentId: comment.id as Uuid }]);
  } catch (error) {
    console.error(`[eo] the webhook payload for ${item.key} could not be attached:`, error);
  }
}

/**
 * What the comment carrying the payload says.
 *
 * Deliberately flat. The third story of this phase is what renders a
 * payload into an agent's context as a quoted untrusted block with a
 * preamble (ARCHITECTURE.md, "What an agent is given"); this sentence is the thread's, and saying
 * anything
 * here about what the payload means would be the first half of that work
 * done in the wrong place.
 */
export const WEBHOOK_PAYLOAD_NOTE = "The webhook payload that created this item is attached.";

/**
 * Why this job cannot file an item right now, or null.
 *
 * Three states, one answer, because from the sender's side they are the
 * same thing: the event is good, and EO is not filing it this minute.
 * Each one says which, because the row and the comment are what a person
 * reads to know whether to wait or to go and fix something.
 *
 * Deliberately about the *job* and not about the queue — see the caller
 * that adds the queue's own reason on top of it.
 */
function whyItWaits(db: Db, job: Job, now: number): string | null {
  if (job.pausedAt !== null) {
    // A pause stops work rather than discarding the record (ARCHITECTURE.md, "Controls"), so
    // the event waits for the resume instead of being dropped on the
    // floor at the door.
    return "This job is paused, so its events wait until it is resumed.";
  }
  const unfireable = whyItCannotFile(db, job);
  if (unfireable !== null) return unfireable;
  const cap = job.maxItemsPerHour;
  if (cap === null) return null;
  const filed = firedSince(db, job.id as Uuid, now - HOUR_MS);
  return filed >= cap ? `This job files at most ${cap} items an hour, and it has filed ${filed} in the last hour.` : null;
}

/**
 * Whether the job could file work at all, in `checkFireable`'s words.
 *
 * Asked before the item is attempted rather than after it fails, so a
 * job whose pipeline was deleted holds its events and says so once,
 * instead of writing a `failed` occurrence and a message for
 * every delivery that arrives until somebody notices.
 */
function whyItCannotFile(db: Db, job: Job): string | null {
  if (job.template === null || job.pipelineId === null) {
    return "This job has no pipeline and template to file work with, so its events wait.";
  }
  const pipeline = getPipeline(db, job.pipelineId);
  if (!pipeline) return "The pipeline this job files work on no longer exists, so its events wait.";
  if (pipeline.archivedAt !== null) return `"${pipeline.name}" has been deleted, so its events wait.`;
  if (pipeline.entryStepId === null) {
    return `"${pipeline.name}" has no step for new work to start on, so its events wait.`;
  }
  // The template's *type* is deliberately not checked here.
  // `createItem` resolves it against the project and `fireJob` refuses
  // with its own sentence, and a second resolution in this file would
  // be a second answer to "does this type exist" — the thing
  // `checkFireable` was extracted to stop there being.
  return null;
}

/**
 * What a signature or a window refused (ARCHITECTURE.md, "Webhooks").
 *
 * Recorded with an **empty payload**, which is the whole of why this is
 * its own function. An unverified body is not this job's event: keeping
 * it would let a stranger who holds no secret write a megabyte into the
 * record for every request the throttle admits, which is an attack the
 * record would be helping with.
 *
 * And never told the owner. That is the story's own exception and its
 * reason is in one sentence: an attacker who can make EO send a message
 * can fill an inbox from outside.
 */
function refused(db: Db, job: Job, now: number, rawBody: string, outcome: JobEventOutcome, reason: string): WebhookAnswer {
  const event = recordJobEvent(db, {
    jobId: job.id as Uuid,
    receivedAt: now,
    eventKey: hashWebhookBody(rawBody),
    payload: "",
    outcome,
    reason,
  });
  // One status for both, deliberately. A caller who could tell a bad
  // signature from a stale timestamp learns which half of the scheme to
  // work on; the row says which, and the row is behind the admin's own
  // sign-in.
  return { status: 401, outcome, event, itemId: null };
}

/** Everything that is recorded *and* said to the owner — which is every outcome bar the two above. */
function recorded(
  db: Db,
  job: Job,
  input: AcceptedEvent & { outcome: JobEventOutcome; reason: string; status: number },
): WebhookAnswer {
  const event = recordJobEvent(db, {
    jobId: job.id as Uuid,
    receivedAt: input.receivedAt,
    eventKey: input.eventKey,
    payload: input.payload,
    outcome: input.outcome,
    reason: input.reason,
  });
  const sentence = ownerSentence(db, job, event);
  if (sentence !== null) messageJobOwner(db, job, sentence, { source: JOB_MESSAGE_SOURCE.webhook });
  return { status: input.status, outcome: input.outcome, event, itemId: null };
}

/**
 * What the job's owner is told, or null for an outcome that says
 * nothing.
 *
 * A held event says it **once per burst**, and that is the one piece of
 * judgement in this file. The rule the story states is that a
 * non-created outcome is said; applied literally to a burst of forty it
 * would send thirty messages about one situation, which is the failure
 * `catchUp.ts` already names — a guard is worth a message and
 * sixty of them a day is worth nothing. So the first event to start a
 * queue speaks for the queue, and the Events tab's "N waiting" is where
 * the number lives (ARCHITECTURE.md, "The inbox, the archive and jobs").
 */
function ownerSentence(db: Db, job: Job, event: JobEvent): string | null {
  if (event.outcome === "held") {
    // One, because this row is in the count: anything higher means a
    // queue was already waiting and has already been spoken for.
    return heldEventCount(db, job.id as Uuid) > 1 ? null : `An event for "${job.name}" is waiting. ${event.reason ?? ""}`.trim();
  }
  if (event.outcome === "deduplicated") return `"${job.name}" had this event already, so nothing new was filed.`;
  if (event.outcome === "malformed") return `An event arrived for "${job.name}" that EO could not read. ${event.reason ?? ""}`.trim();
  if (event.outcome === "over_cap") return `An event for "${job.name}" was refused. ${event.reason ?? ""}`.trim();
  return null;
}

function readTimestamp(header: string | null): number | null {
  if (header === null || !TIMESTAMP_PATTERN.test(header)) return null;
  return Number(header);
}

type PayloadResult = { ok: true; payload: unknown } | { ok: false; problem: string };

/**
 * The body as a document.
 *
 * An object or an array, and nothing else: a bare `4` or `"hello"` is
 * valid JSON and is not an event — there is nowhere in it for a pointer
 * to point, and a mapping over it could never say anything.
 */
function readPayload(rawBody: string): PayloadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, problem: "Its body is not JSON." };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, problem: "Its body is not a JSON object or array, so there is nothing in it to map." };
  }
  return { ok: true, payload: parsed };
}
