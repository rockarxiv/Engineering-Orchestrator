import { z } from "zod";

/**
 * A webhook: what a job is triggered by when the event comes from
 * somewhere else (EO-332, `ARCHITECTURE.md`, "Trigger kinds",
 * "Webhooks").
 *
 * **A webhook always arrives at the server**, since only the server has
 * a public address. It is verified there, recorded there, deduplicated
 * there and turned into an item there; the job's machine picks that item
 * up when it is online and dispatches it as any other. The server is the
 * mailbox, not the runtime.
 *
 * Everything in this file is the part both ends have to agree on — the
 * path, the two headers, the string that is signed, the window a
 * timestamp is accepted in, the pointers a payload is read through and
 * the words an outcome is recorded under. It is in `@eo/core` for the
 * reason `PUSH_STREAM_PATH` is: a scheme spelled twice is a scheme that
 * can differ in one place, and here the two places are the door that
 * verifies and the Job page that tells a person what to configure at the
 * other end.
 *
 * What is deliberately **not** here is the HMAC itself. `node:crypto`
 * does not exist in a renderer and `globalThis.crypto.subtle` is
 * asynchronous, so the computation lives in the main process beside the
 * door that performs it (`main/jobs/webhookSignature.ts`) and this file
 * says only what is computed *over*.
 */

/**
 * Where a webhook is delivered: `/webhooks/<the job's own path>`.
 *
 * Not under `/ipc/`, for `PUSH_STREAM_PATH`'s reason and one more of its
 * own: everything below that prefix is a channel of the contract,
 * reached with a device's bearer token. A webhook carries no token at
 * all — the sender is a third-party service that has never signed in —
 * and is admitted by a signature over its body instead. Two different
 * things to be, so two different doors.
 */
export const WEBHOOK_PATH_PREFIX = "/webhooks/";

/** The path a job is delivered on, from the segment stored on its trigger. */
export function webhookPath(path: string): string {
  return `${WEBHOOK_PATH_PREFIX}${path}`;
}

/**
 * The signature, as `sha256=<hex>`.
 *
 * Prefixed with the algorithm rather than bare, which is what every
 * service that sends one of these already does, and for their reason:
 * the day a second algorithm is accepted, a bare hex string would be
 * indistinguishable from the first.
 */
export const WEBHOOK_SIGNATURE_HEADER = "x-eo-signature";

/** The algorithm EO signs with today, and the only one it accepts. */
export const WEBHOOK_SIGNATURE_PREFIX = "sha256=";

/** When the sender says it sent it, in milliseconds since the epoch. */
export const WEBHOOK_TIMESTAMP_HEADER = "x-eo-timestamp";

/**
 * How far out of step with this server a sender's clock may be.
 *
 * Five minutes either way, which is the window every comparable scheme
 * settles on: wide enough for an unsynchronised clock and a slow
 * network, narrow enough that a request somebody recorded off the wire
 * is worthless by the time they replay it.
 *
 * It is the *other* half of replay protection and not the whole of it.
 * This closes the window; the event key and its unique index close the
 * door inside that window, because a request replayed nine seconds
 * later is perfectly fresh and still must not create a second item.
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60_000;

/**
 * The bytes EO will read of one delivery.
 *
 * A megabyte, which is two orders of magnitude more than any webhook
 * worth mapping into a title, and small enough that the ceiling on held
 * events is a ceiling on megabytes rather than on gigabytes. A body
 * larger than this is refused before it is read at all — see the door —
 * so nothing about it is ever recorded: the request never became an
 * event.
 */
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

/**
 * What is signed: the timestamp, a full stop, and the body exactly as it
 * was sent.
 *
 * The timestamp is inside the signature rather than beside it, which is
 * the whole point of having one — a header a sender signs nothing over
 * is a header an attacker rewrites, and the window would then protect
 * nothing. The body is the *raw bytes*: re-serialising parsed JSON and
 * signing that would make the signature depend on key order and number
 * formatting, which is a verification that fails for honest senders and
 * a bug nobody can reproduce.
 */
export function webhookSigningString(timestamp: number, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/**
 * The shortest secret EO will accept.
 *
 * Thirty-two characters, because this is an HMAC key rather than a
 * password: there is no rate limit that helps once somebody has a copy
 * of the body, and the whole security of the endpoint is that guessing
 * it is hopeless. EO mints one of full length; the minimum is for a
 * secret somebody pastes in because the other end generated it.
 */
export const WEBHOOK_SECRET_MIN_LENGTH = 32;

/**
 * Where in a payload each of the item's fields is (ARCHITECTURE.md, "Results and routes", "The
 * inbox, the archive and jobs").
 *
 * RFC 6901 JSON pointers — `/issue/fields/summary` — and not a template
 * language. A pointer either resolves or does not, it cannot compute,
 * and it cannot be made to read something the payload does not contain;
 * an expression language here would be a sender-controlled program
 * running in the record's process, which is the opposite of the way
 * the design asks this payload to be treated.
 *
 * Every field is optional. A mapping that names nothing is a job whose
 * template stands as written, which is what a webhook that is a bare
 * "something happened" signal wants.
 */
export const WebhookMappingSchema = z.object({
  /** Replaces the template's title when it resolves to something. */
  title: z.string().nullable().default(null),
  /** Replaces the template's body when it resolves to something. */
  body: z.string().nullable().default(null),
  /**
   * The sender's own id for this event.
   *
   * Declared where the sender has one — `/delivery_id`, `/id` — because
   * that is what makes a retry recognisable as the same event: a sender
   * that retries after a timeout usually sends the identical body, but
   * one that re-renders it (a timestamp, a "attempt: 2") would hash
   * differently and arrive as a second event. Absent falls back to a
   * hash of the body, which is right for a sender that offers no id.
   */
  eventKey: z.string().nullable().default(null),
  /** Spec field name to pointer — what the item type's own fields are filled from. */
  spec: z.record(z.string(), z.string()).default({}),
});
export type WebhookMapping = z.infer<typeof WebhookMappingSchema>;

/** A mapping that names nothing — the default, and what an unmapped job has. */
export const EMPTY_WEBHOOK_MAPPING: WebhookMapping = { title: null, body: null, eventKey: null, spec: {} };

/**
 * What a job's delivery path may be.
 *
 * Lower-case letters, digits and hyphens, because it is a URL segment a
 * person copies into somebody else's configuration screen — and because
 * anything that needs percent-escaping is a path that will be typed back
 * wrongly. Not derived from the job's id: a path is a thing a person
 * reads out, and a job that is deleted and made again keeps working at
 * the address the other end is already configured with.
 */
export const WEBHOOK_PATH_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

export const WebhookTriggerSchema = z.object({
  kind: z.literal("webhook"),
  /** The segment after `/webhooks/`. Unique across an installation — `createJob` refuses a second. */
  path: z.string().regex(WEBHOOK_PATH_PATTERN),
  /**
   * The shared secret the signature is computed under.
   *
   * On the trigger, in the record, in plain text — and that is a
   * decision rather than an oversight. This is a *symmetric* key: the
   * sender holds the same string, EO cannot verify without it, and the original design
   * puts it on the Job page in as many words ("a webhook job adds the
   * URL and secret"), because a secret a person cannot read back is a
   * secret they cannot configure the other end with. A write-only store
   * would buy nothing against the one attacker it matters against —
   * anybody who can read this database can read the items it protects —
   * and would make the surface the next story draws impossible.
   */
  secret: z.string().min(WEBHOOK_SECRET_MIN_LENGTH),
  mapping: WebhookMappingSchema.default(EMPTY_WEBHOOK_MAPPING),
});
export type WebhookTrigger = z.infer<typeof WebhookTriggerSchema>;

/**
 * What one delivery did (EO-332, `ARCHITECTURE.md`, "Webhooks").
 *
 * The review's question, answered: *where is a deduplicated, malformed
 * or over-cap event recorded?* Here, as a row, for every request without
 * exception — because the alternative EO had was nowhere, and an event
 * that arrived and produced nothing is precisely the case a person goes
 * looking for.
 *
 * - `created` — verified, new, under the cap: one item exists.
 * - `deduplicated` — this job has seen this event key. No second item.
 * - `rejected_signature` — the signature did not match. Nothing was read
 *   from the body and nothing of it is kept.
 * - `rejected_replay` — the timestamp is outside the window.
 * - `malformed` — signed by somebody who holds the secret, and not
 *   something EO can read as an event.
 * - `over_cap` — the job's queue of held events is full, so this one is
 *   refused rather than held. A queue EO would grow without limit is a
 *   disk somebody else fills.
 * - `held` — over the job's items-per-hour, or on a job that cannot file
 *   work this minute. Waiting, and released by the tick in the order it
 *   arrived.
 * - `refused` — the pipeline's entry rules refused the item this payload
 *   would have filed (EO-610). Nothing was created, and a later delivery
 *   with what was missing can still land.
 */
export const JobEventOutcomeSchema = z.enum([
  "created",
  "deduplicated",
  "rejected_signature",
  "rejected_replay",
  "malformed",
  "over_cap",
  "held",
  "refused",
]);
export type JobEventOutcome = z.infer<typeof JobEventOutcomeSchema>;

/**
 * One delivery, as it crosses a boundary.
 *
 * An append-only record, the way an occurrence is and never a channel
 * (ARCHITECTURE.md, "What a job records"). What a person is *told* about an event that produced
 * nothing
 * is the comment on the job's thread; this is what the Events tab reads
 * back.
 */
export const JobEventViewSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  receivedAt: z.number(),
  /** The sender's id for it, or a hash of the body. Unique per job among the rows that created an item. */
  eventKey: z.string(),
  /**
   * The body exactly as it arrived.
   *
   * Empty on a row whose signature or timestamp was refused, and that is
   * deliberate: an unverified body is not this job's event, and keeping
   * it would let a stranger with no secret write into the record as fast
   * as the throttle admits them.
   */
  payload: z.string(),
  outcome: JobEventOutcomeSchema,
  /** The sentence the thread was told, where there was one. */
  reason: z.string().nullable(),
  /** What it created. The item may since have been deleted. */
  itemId: z.string().nullable(),
});
/** The row and the view are the same shape — see `JobOccurrence`. */
export type JobEvent = z.infer<typeof JobEventViewSchema>;

/**
 * One row of the Events tab (EO-333, ARCHITECTURE.md, "The inbox, the archive and jobs").
 *
 * `JobOccurrenceRowSchema`'s twin, and resolved for its reason: the
 * event outlives what it created. `job_events.item_id` carries no
 * foreign key precisely so that deleting an item does not erase the
 * record of the delivery, so this is where "the item is gone" becomes a
 * blank cell rather than a link to nothing.
 *
 * The key rather than only the id, because a link is drawn from the key
 * — it is what the item is called on every other screen, and what a
 * person reads out when they go and ask somebody about it.
 */
export const JobEventRowSchema = JobEventViewSchema.extend({
  /** Null when nothing was created, and when what was created has been deleted. */
  itemKey: z.string().nullable(),
  itemTitle: z.string().nullable(),
});
export type JobEventRow = z.infer<typeof JobEventRowSchema>;

/** What the Events tab calls each outcome (ARCHITECTURE.md, "The inbox, the archive and jobs"). */
export function describeJobEventOutcome(outcome: JobEventOutcome): string {
  switch (outcome) {
    case "created":
      return "Created";
    case "deduplicated":
      return "Deduplicated";
    case "rejected_signature":
      return "Bad signature";
    case "rejected_replay":
      return "Outside the time window";
    case "malformed":
      return "Unreadable";
    case "over_cap":
      return "Over cap";
    case "held":
      return "Waiting";
    case "refused":
      return "Refused by the pipeline";
  }
}

/** Whether this is a pointer EO can follow at all — `""` or `/`-led (RFC 6901). */
export function isJsonPointer(pointer: string): boolean {
  return pointer === "" || pointer.startsWith("/");
}

/**
 * Follows a JSON pointer into a payload (RFC 6901).
 *
 * `undefined` for a pointer that does not resolve, which is a different
 * thing from a pointer that resolves to `null` — a field the sender
 * explicitly cleared is an answer, and a field that is not there is not.
 * The caller decides what to do with each; `webhookFieldText` treats
 * both as "nothing to put here".
 *
 * Array indices are read as the standard asks — `/items/0` — and `-`,
 * which the standard reserves for "one past the end" when adding to an
 * array, resolves to nothing, because there is nothing there to read.
 */
export function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (!isJsonPointer(pointer)) return undefined;
  if (pointer === "") return document;
  let current: unknown = document;
  for (const raw of pointer.slice(1).split("/")) {
    // `~1` is `/` and `~0` is `~`, and in that order: unescaping `~0`
    // first would turn `~01` into `/` instead of into `~1`.
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      // A leading zero is not a number the standard admits, so `/00` is
      // nothing rather than the first element.
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      current = current[Number(token)];
      continue;
    }
    if (current === null || typeof current !== "object") return undefined;
    if (!Object.hasOwn(current, token)) return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

/**
 * What a resolved pointer puts in a title or a body.
 *
 * A string is itself; a number or a boolean is its own spelling; an
 * object or an array is its JSON, because a title reading
 * `[object Object]` is worse than a title reading the object. Nothing at
 * all — absent, or explicitly null — is null, which every caller reads
 * as "leave what the template said".
 *
 * A string is **not** trimmed to a length here. The design renders a webhook
 * payload into an agent's context as a quoted untrusted block, which is
 * the third story of this phase; truncating it now would make that
 * block a lie about what arrived.
 */
export function webhookFieldText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Writes a value at a JSON pointer, making the objects on the way
 * (RFC 6901, EO-333).
 *
 * `resolveJsonPointer`'s inverse, and it exists for one caller: the
 * sample payload a Send test event press posts (ARCHITECTURE.md, "The inbox, the archive and
 * jobs"). A test event that
 * did not fit the job's own mapping would be a test of the door and of
 * nothing else — worse, a job whose event key is mapped is refused as
 * `malformed` when the key is not there, so a fixed sample would make
 * the button fail on exactly the jobs that configured it most carefully.
 *
 * Every container it makes is a plain **object**, including for a
 * numeric token, which looks wrong and is deliberate:
 * `resolveJsonPointer` reads `/items/0` off `{items: {"0": …}}` as
 * happily as off an array, so the pair round-trips, and guessing that
 * `/0` meant an array would be this function inventing a shape the
 * pointer does not state.
 *
 * A pointer that is not one — anything not `/`-led — writes nothing and
 * answers the document unchanged, which is `""` as well: the whole
 * document is not a place to put a field.
 */
export function withJsonPointer(document: Record<string, unknown>, pointer: string, value: unknown): Record<string, unknown> {
  if (!pointer.startsWith("/")) return document;
  const tokens = pointer
    .slice(1)
    .split("/")
    // `~1` before `~0`, for `resolveJsonPointer`'s reason.
    .map((raw) => raw.replace(/~1/g, "/").replace(/~0/g, "~"));
  const root = { ...document };
  let current: Record<string, unknown> = root;
  for (const [index, token] of tokens.entries()) {
    if (index === tokens.length - 1) {
      current[token] = value;
      break;
    }
    const next = current[token];
    // Copied rather than written through, so a caller's own document is
    // never edited under it — and replaced outright where what is there
    // is not something a pointer can descend into, because a sample
    // that silently dropped half its mapping would be a test that
    // passed while saying nothing.
    const child: Record<string, unknown> = next !== null && typeof next === "object" && !Array.isArray(next) ? { ...(next as Record<string, unknown>) } : {};
    current[token] = child;
    current = child;
  }
  return root;
}

/**
 * What the Send test event button posts (ARCHITECTURE.md, "The inbox, the archive and jobs",
 * "Results and routes").
 *
 * **Shaped by the job's own mapping**, so what comes back is an item
 * with the person's pointers in it rather than a card titled after the
 * template. Every mapped pointer gets something, which is what makes the
 * press answer the question it is actually asked — "have I written these
 * pointers correctly?" — rather than only "is the endpoint up?".
 *
 * `nonce` is what keeps two presses from being one event. A job that
 * declares an event key would otherwise send the same key twice and be
 * told, correctly, that it has had this event already; a job that
 * declares none is deduplicated on a hash of the body, which two
 * identical samples share. So the caller passes something new each time
 * and it lands in both places.
 *
 * The marker is at the top level under a name no sender uses, so that an
 * item filed by a test is recognisable as one from the payload alone —
 * on the attachment, in the Events tab, and in the quoted block the design
 * renders into an agent's context.
 */
export const WEBHOOK_TEST_MARKER = "eo_test_event";

export function sampleWebhookPayload(mapping: WebhookMapping, nonce: string): Record<string, unknown> {
  let payload: Record<string, unknown> = { [WEBHOOK_TEST_MARKER]: true, id: nonce };
  payload = withJsonPointer(payload, mapping.title ?? "", "Test event from EO");
  payload = withJsonPointer(payload, mapping.body ?? "", `EO sent this to check the webhook for this job. Its id is ${nonce}.`);
  for (const [field, pointer] of Object.entries(mapping.spec)) {
    payload = withJsonPointer(payload, pointer, `Test value for ${field}`);
  }
  // The key last, so that a mapping pointing two fields at one place
  // still leaves the door something to deduplicate on. Without it the
  // press would be answered `malformed` — which is the right answer to
  // a payload with no key in it and the wrong thing for EO to have
  // built on purpose.
  payload = withJsonPointer(payload, mapping.eventKey ?? "", nonce);
  return payload;
}
