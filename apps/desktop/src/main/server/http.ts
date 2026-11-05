import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createSignInThrottle, TOO_MANY_ATTEMPTS, type Throttle } from "./signInThrottle.js";
import {
  ipcContract,
  isActorScopedChannel,
  isAdminOnlyChannel,
  isDeviceScopedChannel,
  notADeviceRefusal,
  withDeviceIdentity,
  isMachineChannel,
  isUnauthenticatedChannel,
  machineOnlyRefusal,
  MAX_IPC_REQUEST_BYTES,
  notAnAdminRefusal,
  withoutWorkClaim,
  ORGANISATION_SECRETS_PATH,
  PUSH_STREAM_PATH,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_PATH_PREFIX,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  withActingAgent,
  withActingDevice,
  type IpcChannel,
  type IpcErr,
  type IpcResult,
} from "@eo/core";

/**
 * The record half of the contract, over HTTP (EO-319,
 * `ARCHITECTURE.md`, "The server").
 *
 * This is the server's answer to `ipcMain.handle` — the same door
 * `platform/electron.ts` hangs for the renderer, opening onto the same
 * `dispatchIpc` the MCP host calls. Nothing here knows what a handler
 * is: it authenticates, decides whether the channel is one a server can
 * answer at all, and hands the payload over.
 *
 * Three rules, and the order they are applied in is the whole design:
 *
 * 1. **The token first.** An unauthenticated caller is told 401 and
 *    nothing else — not whether the channel exists, not whether it is a
 *    record channel. A refusal that varies before the token is checked
 *    is a probe.
 * 2. **Then the half.** A machine channel answers with the typed refusal
 *    from core, not a 404: it is a real channel that this installation
 *    cannot answer, which is a different thing from a channel that does
 *    not exist, and the renderer branches on the difference.
 * 3. **Then dispatch**, and whatever comes back is an envelope — which
 *    is why the status is 200 even for `{ ok: false }`. The IPC contract
 *    already carries success and failure inside the body (F-04); putting
 *    a second, coarser answer in the status line would give a caller two
 *    disagreeing sources for one outcome. Non-2xx is reserved for
 *    problems with the *request*, which are things the contract has no
 *    way to express: no token, no such channel, a channel name whose
 *    percent-escapes are broken, a body that is not JSON or is larger
 *    than the contract's own maximum.
 *
 * `PUSH_STREAM_PATH` is the other door onto the record, and the only
 * one in this file that does not answer and close: a GET that stays open, carrying the pushes a
 * desktop gets over `webContents` (EO-321). The token is checked there
 * by the same function and for the same reason — everything past it is
 * the record — and what happens afterwards belongs to
 * `server/pushStream.ts`, which this file knows no more about than it
 * knows about a handler.
 *
 * Everything that is none of those is the renderer, served as static
 * files so an admin opens the address in a browser and sees the app.
 */
/**
 * Who is asking (EO-323).
 *
 * The operator's token is one caller and every signed-in device is
 * another. `admin` is true for the first by definition — it is the
 * token the process was started with, held by whoever runs the server —
 * and for a device whose person carries the admin flag (ARCHITECTURE.md, "Identity").
 */
export interface HttpCaller {
  kind: "operator" | "device";
  admin: boolean;
  /** The device row to touch, so the admin's list can say when it was last seen. */
  deviceId: string | null;
}

/**
 * How a presented token becomes a caller (EO-323).
 *
 * Handed in rather than looked up here, because this file knows no more
 * about SQLite than it knows about a handler: `startMain` builds it over
 * `devicesRepo` and passes it through `Platform.serveIpc`. A door with
 * none — which is what every test of this file that is not about
 * identity builds — accepts the operator's token and nothing else, which
 * is exactly what the server was between EO-319 and this story.
 */
export interface DeviceDirectory {
  /** The caller this token is, or null for one this server does not know. */
  identify(token: string): HttpCaller | null;
  /**
   * Whether this is a live device's **organisation-secrets key**
   * (EO-328, ARCHITECTURE.md, "Secrets") — the second credential, minted only for a client
   * that said it runs work.
   *
   * A yes-or-no rather than an identity, because nothing downstream
   * needs to know which device is collecting: what an organisation
   * publishes is the same for every device it published to.
   *
   * Deliberately *not* satisfied by a device token. A browser needs a
   * token to POST `/ipc/…` and keeps one in `sessionStorage`, so a route
   * the token opened would be a route the served renderer could call —
   * and this story's third acceptance criterion would be false however
   * careful the channels were.
   */
  opensSecrets(presented: string): boolean;
  /** Records that a device was heard from. Called once per authenticated request. */
  seen(deviceId: string): void;
}

/**
 * How a delivery reaches the job that is waiting for one (EO-332,
 * `ARCHITECTURE.md`, "Webhooks").
 *
 * Structural, and deliberately so: this file knows no more about a job
 * than it knows about a handler. It reads a method, counts bytes, counts
 * knocks, and hands over three strings and a path. Everything that
 * decides what a delivery *is* — the signature, the window, the key, the
 * cap, the row — is `main/jobs/webhook.ts`'s, and `startMain` is what
 * puts the two in the same hand.
 */
export interface WebhookDoor {
  receive(delivery: WebhookHttpDelivery): Promise<{ status: number; say: string }>;
}

export interface WebhookHttpDelivery {
  /** The segment after `/webhooks/`, already percent-decoded. */
  path: string;
  /** The body exactly as it arrived — the bytes the signature is over. */
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
}

export interface HttpDoorOptions {
  /**
   * The operator's token, compared in constant time.
   *
   * Still here after sign-in shipped, and deliberately: it is how the
   * person who started the container reaches a server that has nobody on
   * its people list yet — which is every server on its first boot, since
   * the first invitation has to be written by somebody. It is an
   * operator's key rather than an identity, and no device row is ever
   * written for it.
   */
  token: string;
  /** The built renderer, or null — see `ServerConfig.rendererDirectory`. */
  rendererDirectory: string | null;
  /** Normally `dispatchIpc` from ipc/registry.ts. */
  dispatch: (channel: IpcChannel, payload: unknown) => Promise<IpcResult<unknown>>;
  /**
   * Normally `attach` from the `PushStream` this server bridged its
   * pushes onto (EO-321).
   *
   * Handed a request whose token has already been checked, and expected
   * never to answer it: it writes the response head itself and keeps
   * the socket. Optional because a door without a push stream behind it
   * is a coherent thing — that is what this server was between EO-319
   * and this story — and it answers 503 rather than hanging.
   */
  attachPushStream?: (request: IncomingMessage, response: ServerResponse) => void;
  /**
   * The organisation's device list, when this process has one (EO-323).
   *
   * Absent means the operator's token is the only key that opens this
   * door.
   */
  devices?: DeviceDirectory;
  /**
   * The organisation's secret values, for the devices that inject them
   * (EO-328, ARCHITECTURE.md, "Secrets").
   *
   * A function rather than a value, for the reason every other secret
   * read in this app is one: it is answered at the moment it is asked,
   * so a value an admin cleared a second ago is not still being handed
   * out by a closure that read it at startup.
   *
   * Absent on a door with no secret store behind it, which answers 404
   * — the same honest "this server does not do that" a channel that does
   * not exist gets, rather than an empty set that would have every
   * device quietly forget what it holds.
   */
  organisationSecrets?: () => Record<string, string>;
  /**
   * How often one address may try the front door. A default one is built
   * per listener; a test hands its own so it can exhaust it in three
   * lines rather than eleven.
   */
  throttle?: Throttle;
  /**
   * Where a webhook delivery goes (EO-332).
   *
   * Absent on a door with no record behind it — a desktop never has one,
   * because a webhook has nowhere to arrive on a machine with no public
   * address — and the route then answers 404, which is the same honest
   * "this server does not do that" the secrets route gives.
   */
  webhooks?: WebhookDoor;
  /**
   * How often one job's address may be knocked on. A default is built
   * per listener; a test hands its own.
   */
  webhookThrottle?: Throttle;
}

/**
 * What this door wraps a payload in: `{"payload":` and `}`.
 *
 * Counted rather than estimated, because it is the difference between
 * the contract's limit and this transport's — and an off-by-twelve there
 * is a 413 on a request the contract accepts, which is precisely the
 * class of bug this file has already produced twice.
 */
const BODY_ENVELOPE_BYTES = '{"payload":}'.length;

/**
 * How much of a request this door will hold.
 *
 * The contract's own maximum plus the wrapper this door puts around it,
 * so the two can never disagree — a request the contract accepts is a
 * request this reads to the end, and a request this refuses is one the
 * contract would have refused too.
 *
 * Both halves of that sentence were false in turn. First the number was
 * 8 MiB chosen here, which refused every attachment over about 6 MB.
 * Then it was derived from `attachments:stage`, which was still not a
 * contract-wide maximum, because most request strings carry no `.max()`
 * and a schema-valid `items:setOutput` could sail past it. The answer
 * was not a better number: it was for the contract to have a maximum at
 * all, which it now does — `channel()` puts `MAX_IPC_REQUEST_BYTES` on
 * every request in both halves, in the same unit this counts in.
 *
 * It remains a cap, and that is still its job here: the body is counted
 * as it arrives and the socket destroyed the moment it goes over, so a
 * client cannot make this process hold a gigabyte by promising a
 * payload it never sends.
 *
 * Which leaves one asymmetry, named here rather than left to be found.
 * The contract measures a payload *after* parsing and Zod strips unknown
 * keys, so a body padded with content no channel declares would parse
 * under the limit while this refuses it for its raw size. It cannot be
 * closed — a streaming door has to bound its buffer before there is
 * anything to parse — and it cannot be reached by EO's own clients,
 * which send declared fields and nothing else.
 */
const MAX_BODY_BYTES = MAX_IPC_REQUEST_BYTES + BODY_ENVELOPE_BYTES;

/**
 * How often one job's webhook may be delivered to (EO-332, the original design).
 *
 * "Webhooks are signed, with replay protection and a rate limit" —
 * this is the third of the three, and its job is narrower than it
 * sounds. The signature is what keeps a stranger from creating work;
 * what a signature cannot stop is a stranger *making EO write* — every
 * refused delivery is a `job_events` row, and a row an unauthenticated
 * sender can cause is a database an unauthenticated sender can grow.
 * So the knocks are counted before anything is recorded.
 *
 * Keyed on the job's own path rather than on the address, which is the
 * choice worth naming. The thing being protected is one job's slice of
 * the record, and an attacker with a thousand addresses would walk
 * straight past a per-address count while writing a thousand rows. The
 * cost is that a flood aimed at one path delays that path's real
 * sender for the rest of the minute — which is a minute of a sender
 * that will retry, against a table that would otherwise grow without
 * limit.
 *
 * Two a second, which is a hundred times what a webhook job wants and
 * comfortably above the burst a cap of ten an hour is meant to absorb.
 */
const WEBHOOK_ATTEMPT_LIMIT = 120;

export function createRequestListener(options: HttpDoorOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const staticRoot = options.rendererDirectory === null ? null : resolve(options.rendererDirectory);
  // One per door, held for the life of the process. See
  // `signInThrottle.ts` for what it does and does not claim.
  const throttle = options.throttle ?? createSignInThrottle();
  // A second counter, with its own limit and its own key — see
  // `WEBHOOK_ATTEMPT_LIMIT`. Sharing the sign-in one would let a
  // webhook burst lock a person out of signing in, and the two windows
  // count entirely different things.
  const webhookThrottle = options.webhookThrottle ?? createSignInThrottle(WEBHOOK_ATTEMPT_LIMIT);

  return (request, response) => {
    // Everything below is inside a boundary, and that is the point of it.
    //
    // A `request` listener runs on Node's event loop with nothing above
    // it: a synchronous throw here is an uncaught exception, and a
    // rejected promise nobody awaited is an unhandled rejection — which
    // since Node 15 ends the process by default. So a single malformed
    // request would take the whole server down and every run on it with
    // it. `POST /ipc/%` did exactly that, through a `decodeURIComponent`
    // that is now caught where it is made (see `handleIpc`); this is the
    // net under all of it, so that the next one is a 500 rather than an
    // outage.
    try {
      // A relative-URL base that is never used for anything but parsing:
      // only `pathname` is read, and the Host header is not trusted for it.
      const url = new URL(request.url ?? "/", "http://server.invalid");

      if (url.pathname === "/ipc" || url.pathname.startsWith("/ipc/")) {
        handleIpc(url.pathname.slice("/ipc/".length), request, response, options, throttle).catch((error: unknown) => failed(response, error));
        return;
      }

      if (url.pathname === PUSH_STREAM_PATH) {
        handlePush(request, response, options);
        return;
      }

      if (url.pathname === ORGANISATION_SECRETS_PATH) {
        handleOrganisationSecrets(request, response, options);
        return;
      }

      if (url.pathname.startsWith(WEBHOOK_PATH_PREFIX)) {
        handleWebhook(url.pathname.slice(WEBHOOK_PATH_PREFIX.length), request, response, options, webhookThrottle).catch((error: unknown) =>
          failed(response, error),
        );
        return;
      }

      serveRenderer(url.pathname, request, response, staticRoot);
    } catch (error) {
      failed(response, error);
    }
  };
}

async function handleIpc(
  rawChannel: string,
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpDoorOptions,
  throttle: Throttle,
): Promise<void> {
  if (request.method !== "POST") {
    // Read before the token on purpose: a GET is not an attempt to reach
    // anything, and answering 401 to it would only teach a browser's
    // address bar to ask for credentials.
    sendEnvelope(response, 405, problem("EO's IPC channels are POSTed to."));
    return;
  }

  // `decodeURIComponent` throws a `URIError` on a broken escape — `%`,
  // `%zz`, a truncated `%e2` — and a thrown one here used to become an
  // unhandled rejection and end the process. Caught where it is made,
  // and answered as what it is: a request this server could not read,
  // which is a 400 and not a channel that does not exist.
  let channel: string;
  try {
    channel = decodeURIComponent(rawChannel);
  } catch {
    sendEnvelope(response, 400, problem("That is not a readable channel name: its percent-escapes are malformed."));
    return;
  }

  // The token, and then what the caller may do with it (EO-323).
  //
  // Still first, and still before this door will say whether a channel
  // exists — that rule has not moved, it has grown one written-down
  // exception. `auth:signIn` and `auth:acceptInvitation` are the two
  // requests that by definition carry no token, so they are let past it
  // by name (`UNAUTHENTICATED_CHANNELS`) and admitted on what they
  // carry: a password against a stored hash, a code against a stored
  // hash, each answering every failure with one sentence.
  //
  // Which means the channel name is read before the token for those two
  // alone. It is not a probe: the name is a constant in the contract
  // every client already holds, and the answer to an unknown channel is
  // the same 401 as a known one.
  const openChannel = isUnauthenticatedChannel(channel);
  const caller = openChannel ? null : authenticate(request, options);
  if (!openChannel && caller === null) {
    sendEnvelope(response, 401, problem(SIGN_IN_AGAIN));
    return;
  }

  // A door anybody may knock on is a door worth counting knocks at.
  if (openChannel && !throttle.allow(request.socket.remoteAddress ?? "unknown")) {
    sendEnvelope(response, 429, problem(TOO_MANY_ATTEMPTS));
    return;
  }

  if (!Object.hasOwn(ipcContract, channel)) {
    sendEnvelope(response, 404, problem(`EO has no channel called "${channel}".`));
    return;
  }

  // "One admin flag. Everyone with it may edit on the server"
  // (the original design). Enforced here rather than in the
  // handlers, because here is the only place there is a caller at all:
  // on a desktop the person at the keyboard owns the machine and its
  // database, and the same handler must not refuse them.
  if (caller !== null && !caller.admin && isAdminOnlyChannel(channel)) {
    sendEnvelope(response, 200, notAnAdminRefusal(channel));
    return;
  }

  // The whole point of the phase, in one branch. A server implements the
  // record half and none of the other (`ARCHITECTURE.md`, "The server"), and
  // this is where that sentence is enforced rather than hoped for: the
  // handlers for the machine half are registered in this process like
  // every other, because `registerAllHandlers` registers the contract
  // and not a subset of it, and they would happily run and answer
  // something. What they would answer is a lie told by a platform with
  // no screen. Refused at the door instead, in the contract's own words.
  if (isMachineChannel(channel)) {
    sendEnvelope(response, 200, machineOnlyRefusal(channel));
    return;
  }

  const body = await readBody(request);
  if (!body.ok) {
    sendEnvelope(response, body.status, problem(body.problem));
    return;
  }

  // `{ payload }` rather than the payload itself, so that a channel
  // taking `z.void()` is distinguishable from a malformed body: an
  // absent member parses as `undefined`, which is what `z.void()` wants,
  // while an empty body is a request that never said anything.
  let payload: unknown;
  if (body.text.length > 0) {
    try {
      const parsed: unknown = JSON.parse(body.text);
      if (parsed === null || typeof parsed !== "object") {
        sendEnvelope(response, 400, problem("An IPC request body is a JSON object with a `payload` member."));
        return;
      }
      payload = (parsed as { payload?: unknown }).payload;
    } catch {
      sendEnvelope(response, 400, problem("That request body is not JSON."));
      return;
    }
  }

  // Who is asking, put back into the request before anything reads it
  // (EO-324, ARCHITECTURE.md, "The record").
  //
  // Four channels carry a `deviceId`, and on each of them it is an
  // identity claim rather than information: they take a lease, keep or
  // give back a claim, and file history under a machine's name. A door
  // that passed the client's own word through would let any signed-in
  // device claim another's work, renew a claim it never held, and write
  // run events under somebody else's name — every one of those from a
  // token that is perfectly valid for *itself*.
  //
  // So the door stamps. `withDeviceIdentity` is in the contract beside
  // the channel list, so the two cannot drift, and the stamping happens
  // here because here is the only place in the process that knows who
  // authenticated.
  if (isDeviceScopedChannel(channel)) {
    // The operator's key belongs to no machine — there is no laptop
    // behind it and no device row to lease to. Refused rather than
    // stamped with an invented id, because a lease granted to nothing
    // is an item nobody can work on until it expires.
    if (caller?.deviceId == null) {
      sendEnvelope(response, 200, notADeviceRefusal(channel));
      return;
    }
    payload = withDeviceIdentity(channel, payload, caller.deviceId);
  }

  // And who is asking, for the channels that answer on behalf of a
  // person (EO-326, ARCHITECTURE.md, "Identity").
  //
  // The same rule as the four above and for the same reason — an id a
  // client sent would be a claim, not a fact — but a wider list and a
  // softer failure: these are a person's projects, their inbox, and the
  // moves and comments filed under their name, and a caller who is not a
  // device is stamped `null` rather than refused. That is the operator's
  // key, which administers an organisation without being a member of
  // one; `identity/acting.ts` is where the three readings of this field
  // are turned back into a person.
  //
  // Stamped for the operator too, and that is the part worth not losing:
  // leaving the field absent for a key with no device would say "no door
  // was crossed", which is a desktop, and would hand a server's own
  // local-person row an inbox.
  if (isActorScopedChannel(channel)) {
    payload = withActingDevice(channel, payload, caller?.deviceId ?? null);
  }

  // And never an agent (EO-585). Only EO's own administrative MCP host
  // says a system agent is the one pressing or replying, from the
  // credential it minted for that agent's turn; a browser naming one
  // would be a person passing their press off as the assistant's.
  payload = withActingAgent(channel, payload, undefined);

  // And whether this client may ask to *run work* (EO-328, review).
  //
  // `SignInRequest.runsWork` is what earns the second credential, the
  // one that opens `ORGANISATION_SECRETS_PATH`. A field the client
  // simply asserted bought nothing: the renderer this server hands a
  // browser could have POSTed `auth:signIn` with it set, read
  // `secretsKey` out of the answer, and fetched the organisation's
  // secrets with it.
  //
  // So the door takes the claim away from anything that is a browser,
  // and `fromABrowser` says how it can tell — on headers page script
  // cannot forge or remove. Narrowing only: this turns a true into a
  // false and never the reverse, so no request gains anything here.
  if (fromABrowser(request)) payload = withoutWorkClaim(channel, payload);

  sendEnvelope(response, 200, await options.dispatch(channel as IpcChannel, payload));
}

/**
 * A webhook delivery (EO-332, `ARCHITECTURE.md`, "Trigger kinds",
 * "Webhooks" and "Identity").
 *
 * **The one door in this file that no token opens**, and that is what it
 * is for: the sender is somebody else's service, it has never signed in,
 * and it never will. What admits it is a signature over its own body —
 * checked on the other side of `options.webhooks`, which is where the
 * job and its secret are.
 *
 * So the order here is the order everything else in this file uses, with
 * the middle step missing. The method first, because a GET is not an
 * attempt to reach anything. Then the *knocks*, counted before a byte of
 * the body is read, because every delivery this door accepts becomes a
 * row and a row a stranger can cause is a table a stranger can grow.
 * Then the bytes, bounded at `WEBHOOK_MAX_BODY_BYTES` and destroyed on
 * the socket the moment they go over — a body EO will not read is a body
 * it does not first hold a megabyte of.
 *
 * The status comes from the receiver rather than from here: whether a
 * delivery was created, deduplicated, held or refused is a fact about
 * the job, and this file is not allowed to know it. What it adds is the
 * three answers a receiver cannot give — not POSTed, too large, and
 * "this server has no record behind it".
 *
 * The body is one word, deliberately. A sender needs to know whether to
 * retry; it does not need to be told which half of a signature scheme it
 * got wrong, and `say` is chosen on the other side so that a bad
 * signature and a stale timestamp read identically.
 */
async function handleWebhook(
  rawPath: string,
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpDoorOptions,
  throttle: Throttle,
): Promise<void> {
  if (request.method !== "POST") {
    sendWebhookAnswer(response, 405, "not posted");
    return;
  }

  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    // `handleIpc`'s reason exactly: a `URIError` thrown on the event
    // loop with nothing above it ends the process.
    sendWebhookAnswer(response, 400, "unreadable");
    return;
  }

  if (!throttle.allow(path)) {
    sendWebhookAnswer(response, 429, "too many");
    return;
  }

  if (options.webhooks === undefined) {
    // A desktop, or a server started without a record behind its door.
    // 404 rather than 503: there is no webhook here, which is the same
    // thing this address means on any host that has never had one.
    sendWebhookAnswer(response, 404, "unknown");
    return;
  }

  const body = await readBody(request, WEBHOOK_MAX_BODY_BYTES, WEBHOOK_MAX_BODY_BYTES);
  if (!body.ok) {
    sendWebhookAnswer(response, body.status, "too large");
    return;
  }

  const answer = await options.webhooks.receive({
    path,
    rawBody: body.text,
    signature: headerOf(request, WEBHOOK_SIGNATURE_HEADER),
    timestamp: headerOf(request, WEBHOOK_TIMESTAMP_HEADER),
  });
  sendWebhookAnswer(response, answer.status, answer.say);
}

/** One header, as one string — Node hands an array back for a header sent twice, and a repeated signature is not one. */
function headerOf(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/** A webhook's answer: a status and one word, in the JSON a sender's library will parse without being asked to. */
function sendWebhookAnswer(response: ServerResponse, status: number, say: string): void {
  const text = JSON.stringify({ outcome: say });
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

/**
 * The push stream (EO-321).
 *
 * The same two gates the channels are behind, in the same order and out
 * of the same function — a stream carries the record, so it is the
 * record's token that opens it.
 *
 * The method is read first for `handleIpc`'s reason exactly: a POST here
 * is not an attempt to reach anything, and answering 401 to it would
 * teach a browser's address bar to ask for credentials over a mistake.
 *
 * Nothing is written on the success path. `attach` takes the response
 * from here and does not give it back, which is what makes this the one
 * route in the file with no `sendEnvelope` at the end of it.
 */
function handlePush(request: IncomingMessage, response: ServerResponse, options: HttpDoorOptions): void {
  if (request.method !== "GET") {
    sendEnvelope(response, 405, problem("EO's push stream is a GET that stays open."));
    return;
  }

  if (authenticate(request, options) === null) {
    sendEnvelope(response, 401, problem(SIGN_IN_AGAIN));
    return;
  }

  if (options.attachPushStream === undefined) {
    // A sentence rather than a silence. A client left holding a socket
    // that will never say anything is a UI that looks live and is not,
    // which is the failure this whole story exists to end.
    sendEnvelope(response, 503, problem("This EO server was started without a push stream."));
    return;
  }

  options.attachPushStream(request, response);
}

/**
 * One sentence for every 401 this door sends (EO-323).
 *
 * No token, a token that was never issued, a token an admin revoked: one
 * answer, because telling them apart is how a caller learns which tokens
 * once existed. The desktop reads any 401 as "this device was signed out
 * by your organisation", which is the honest reading of a token that was
 * accepted once and is not now.
 */
const SIGN_IN_AGAIN = "This EO server did not accept that token. Sign in again, or ask your admin whether this device was revoked.";

/**
 * What the secrets route says to everything that is not a machine.
 *
 * Deliberately different from `SIGN_IN_AGAIN`, and the difference is the
 * useful part: a device that presented a perfectly good *token* here has
 * not been revoked and should not be told to sign in again. It is
 * holding the wrong credential, on purpose, because the credential that
 * opens this is one only a client that runs work is issued.
 */
const SECRETS_KEY_REQUIRED =
  "This EO server serves organisation secrets only to a device that signed in to run work, and only against that device's " +
  "own secrets key — not its request token. Sign in from the desktop app, or ask your admin whether this device was revoked.";

/**
 * Who this request is, or null (EO-323).
 *
 * The operator's token first, because it is a string comparison and
 * because a server with no people on it yet has nothing else to offer.
 * Then the device list, which is a hash and an indexed lookup — see
 * `deviceByTokenHash`, which answers nothing for a revoked row as well
 * as for an unknown one.
 *
 * `seen` is called here, on the way through, which makes "last seen" a
 * fact about the last request rather than about the last time somebody
 * opened the Devices screen.
 */
/**
 * The organisation's secret values, to a device that is signed in
 * (EO-328, ARCHITECTURE.md, "Secrets").
 *
 * **Deliberately not a channel.** Everything under `/ipc/` is the
 * contract, and the contract is what a renderer holds a typed client
 * for; a value delivered here has no shape any screen, push frame or
 * MCP tool could carry it in. That is how "never returned by any query
 * the renderer can make" is kept as a property of the transport rather
 * than as a rule every future channel has to remember.
 *
 * **The device token does not open it**, and that is the half a review
 * caught. Everything under `/ipc/` is reachable by the renderer a
 * server hands a browser, which holds a device token in
 * `sessionStorage` because it needs one — so "not a channel" bought
 * nothing while the same credential opened both. What opens this is the
 * device's *organisation-secrets key*: a second secret, minted only for
 * a client that declared it runs work, kept by a desktop in its OS
 * keychain and handed to no window. A browser is issued none, so there
 * is nothing in `sessionStorage` that opens this and nothing for a
 * renderer query to return.
 *
 * The operator's key opens it too. That is the credential the container
 * was started with, it is in nobody's browser, and it is how an operator
 * checks what their own server is handing out.
 *
 * It is still not a claim that the value is unrecoverable, and the design is
 * careful about the difference: a device that holds the key puts these
 * into a module's environment, where an agent with a shell can read
 * them. That is the arrangement the design accepted. What EO undertakes
 * is that it does not display them.
 *
 * The method is read first for `handleIpc`'s reason.
 */
function handleOrganisationSecrets(request: IncomingMessage, response: ServerResponse, options: HttpDoorOptions): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendEnvelope(response, 405, problem("A device collects the organisation's secrets with a GET."));
    return;
  }
  const presented = bearerToken(request);
  // The two credentials that open this, and a device token is neither.
  // Ordered operator-first only because it is the cheaper comparison;
  // both are constant-time or an indexed hash lookup.
  const admitted =
    presented !== null && (matchesToken(presented, options.token) || (options.devices?.opensSecrets(presented) ?? false));
  if (!admitted) {
    sendEnvelope(response, 401, problem(SECRETS_KEY_REQUIRED));
    return;
  }
  if (options.organisationSecrets === undefined) {
    sendEnvelope(response, 404, problem("This server keeps no organisation secrets."));
    return;
  }

  // `no-store`, because the one thing that must not happen to this
  // response is for a proxy between the two ends to keep a copy of it.
  const body = JSON.stringify({ secrets: options.organisationSecrets() });
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(body)),
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function authenticate(request: IncomingMessage, options: HttpDoorOptions): HttpCaller | null {
  const presented = bearerToken(request);
  if (presented === null) return null;
  if (matchesToken(presented, options.token)) return { kind: "operator", admin: true, deviceId: null };

  const caller = options.devices?.identify(presented) ?? null;
  if (caller?.deviceId != null) options.devices?.seen(caller.deviceId);
  return caller;
}

/**
 * Whether this request was made by a browser (EO-328, review).
 *
 * The trust boundary under `runsWork`, and it rests on the two headers
 * the Fetch standard makes **forbidden header names**:
 *
 *  - `Sec-Fetch-Site` is set by the browser on every request it makes
 *    and is unsettable and unremovable from page script — that is what
 *    the `Sec-` prefix is reserved for;
 *  - `Origin` is set on every request whose method is not GET or HEAD,
 *    which is every `/ipc/…` POST, and is likewise page script's to
 *    neither write nor erase.
 *
 * A client that is not a browser — `ServerClient`, over Node's `fetch`,
 * which is how a desktop reaches its organisation — sends neither. So
 * "either header is present" is a reliable *yes, a browser*, and its
 * absence is what a desktop looks like.
 *
 * Both are checked rather than one, so that a browser old enough to
 * predate `Sec-Fetch-*` is still recognised by its `Origin`.
 *
 * **It grants nothing.** A request this answers false for is not
 * thereby trusted; it still has to sign in with a password like any
 * other, and all it may then do is *ask* for a credential the route
 * checks separately. What this prevents is the one thing a served
 * renderer must not be able to do: ask for that credential at all.
 *
 * A proxy in front of the server that added `Origin` to a desktop's
 * request would cost that desktop its organisation secrets and nothing
 * else — it would be told, by `PolicySyncResult.unresolved`, which names
 * every published secret it holds no value for. That is the safe
 * direction for a mistake of this shape to fail in.
 */
function fromABrowser(request: IncomingMessage): boolean {
  return request.headers["sec-fetch-site"] !== undefined || request.headers.origin !== undefined;
}

/** The token in `Authorization: Bearer <token>`, or null when there is no such header. */
function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

/**
 * Whether two tokens are the same.
 *
 * Constant time, and length-checked first because `timingSafeEqual`
 * throws on a length mismatch — which would otherwise turn "the wrong
 * length" into a 500 and, worse, into a measurably different answer from
 * "the wrong token".
 */
function matchesToken(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type BodyResult = { ok: true; text: string } | { ok: false; status: number; problem: string };

/**
 * The body, bounded.
 *
 * `max` is what this door will hold and `stated` is the number the
 * refusal quotes, because the two differ by the envelope on the IPC path
 * and not at all on the webhook one — a sender told "larger than
 * 8388620 bytes" would be reading this transport's arithmetic rather
 * than the limit it was given.
 */
function readBody(request: IncomingMessage, max: number = MAX_BODY_BYTES, stated: number = MAX_IPC_REQUEST_BYTES): Promise<BodyResult> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        // Destroyed rather than drained: the alternative is reading a
        // body this process has already decided not to answer.
        request.destroy();
        resolveBody({
          ok: false,
          status: 413,
          problem: `That request body is larger than the ${stated} bytes EO carries here, so it was refused before it was read.`,
        });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    request.on("error", () => resolveBody({ ok: false, status: 400, problem: "That request ended before its body arrived." }));
  });
}

function problem(message: string): IpcErr {
  return { ok: false, error: { message } };
}

/**
 * What a request that threw is answered with.
 *
 * A 500 and an envelope, with the reason logged rather than sent: a
 * server is somebody else's machine, and `exposeErrorDetails` is false
 * on it for the same reason a packaged desktop hides a stack trace.
 *
 * Headers already sent means the failure arrived mid-body — a file that
 * vanished under a read, say — and there is no status left to change. The
 * socket is destroyed, which is how a truncated response is told apart
 * from a complete one by whatever is reading it.
 */
function failed(response: ServerResponse, error: unknown): void {
  console.error("[eo] the server could not answer a request:", error);
  if (response.headersSent) {
    response.destroy();
    return;
  }
  sendEnvelope(response, 500, problem("EO's server could not answer that request."));
}

function sendEnvelope(response: ServerResponse, status: number, body: IpcResult<unknown>): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    // Nothing here is ever a cached answer, and a record that changed
    // between two identical requests is the normal case.
    "cache-control": "no-store",
  });
  response.end(text);
}

// ─── The renderer, as static files ──────────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * The app itself, to whoever opens the address.
 *
 * Served without the token, and deliberately: this is the bundle, which
 * is the same bundle the desktop ships and carries no record in it. The
 * token gates the data, which is `/ipc/…` above — gating the HTML as
 * well would mean either a login page this story does not own (7b) or a
 * token in a query string that every proxy log would keep.
 *
 * Anything that is not a file falls through to `index.html`, because the
 * renderer is a single-page app: `/items/01a0…` is a route inside it
 * rather than a file on disk.
 */
function serveRenderer(pathname: string, request: IncomingMessage, response: ServerResponse, staticRoot: string | null): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "text/plain; charset=utf-8", "EO's server answers GET here.");
    return;
  }

  if (staticRoot === null) {
    // A sentence rather than a 404. "There is no renderer here" is a
    // configuration somebody chose, and the failure mode worth avoiding
    // is an admin staring at a blank page wondering which of the two
    // halves is broken.
    sendText(
      response,
      503,
      "text/html; charset=utf-8",
      "<!doctype html><meta charset=utf-8><title>EO</title>" +
        "<p>This EO server is answering IPC but was not given a built renderer to serve. " +
        "Set <code>EO_SERVER_RENDERER</code> to the directory <code>pnpm build</code> wrote.",
    );
    return;
  }

  // The fallback is for routes, not for assets. `/items/01a0…` is a
  // screen inside the app and must be answered with the app; a missing
  // `/assets/index-a1b2.js` must not be, because a browser handed HTML
  // where it asked for a module reports a syntax error in a file that is
  // not the problem.
  const named = resolveWithin(staticRoot, pathname);
  const file = named ?? (extname(pathname) === "" ? join(staticRoot, "index.html") : null);
  if (file === null || !existsSync(file) || !statSync(file).isFile()) {
    sendText(response, 404, "text/plain; charset=utf-8", "Not found.");
    return;
  }

  // The page is rewritten on the way out; everything else is a file.
  if (file.endsWith("index.html")) {
    sendPage(response, request.method === "HEAD", withAbsoluteAssets(readFileSync(file, "utf8")));
    return;
  }

  response.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": statSync(file).size,
    // Only assets reach here, and every one of their names carries its
    // own content hash — see `sendPage` for why the page itself does not.
    "cache-control": "public, max-age=31536000, immutable",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(file);
  // A read that fails after the headers are out — the file deleted
  // between `statSync` and here — emits on the stream, and an `error`
  // with no listener is thrown. There is no status left to send by then,
  // so the socket is dropped and the client sees a body that stopped.
  stream.on("error", (error) => failed(response, error));
  stream.pipe(response);
}

/**
 * The app's page, with its assets made findable from any route.
 *
 * **The bug this exists for.** `electron-vite` builds the renderer with
 * relative asset URLs — `./assets/index-DIJ_ibVJ.js` — because the
 * desktop loads the page off disk through `loadFile`, where `/assets`
 * would mean the root of the filesystem. Served over HTTP that is fine
 * at `/` and broken everywhere else: a browser opening or refreshing
 * `/items/01a0…` resolves the same reference against `/items/` and asks
 * for `/items/assets/index-DIJ_ibVJ.js`, which is not a file. Both the
 * script and the stylesheet 404, and the page that arrives is a blank
 * one — the deep link a person was sent, and the refresh they press when
 * it looks wrong, are exactly the two ways to meet it.
 *
 * A `<base href="/">` is the whole fix, and it is done here rather than
 * in the build on purpose: changing the renderer's `base` to `/` would
 * repoint the desktop's own `file://` load at the root of the disk, and
 * the desktop is what this story must leave alone. The server rewrites
 * its own copy; `out/renderer` is untouched and Electron still loads the
 * bytes it always did.
 *
 * Injected after `<head>` so it precedes every reference — `<base>` only
 * governs what follows it. A document that already declares one is left
 * as it is, since a second is ignored and quietly disagreeing with a
 * page about its own base is worse than doing nothing.
 */
export function withAbsoluteAssets(html: string): string {
  if (/<base\b/i.test(html)) return html;
  const head = /<head[^>]*>/i.exec(html);
  if (head === null) return `<base href="/">${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}<base href="/">${html.slice(at)}`;
}

/**
 * The page itself, from memory rather than off the disk.
 *
 * It is rewritten, so there is no file whose size is its length, and it
 * is small enough that reading it per navigation costs nothing worth
 * measuring. `no-store` because the name carries no content hash: a
 * cached page is how a browser comes to ask for the assets of a deploy
 * ago.
 */
function sendPage(response: ServerResponse, headOnly: boolean, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
  });
  if (headOnly) {
    response.end();
    return;
  }
  response.end(html);
}

/**
 * The file a URL path names, or null if it names one outside the root or
 * no file at all.
 *
 * Null is the single-page fallback as well as the traversal refusal, and
 * that is not a shortcut: `/../../etc/passwd` and `/items/01a0…` are both
 * "not a file under here", and answering the app to both is the honest
 * response. Nothing outside the root is ever opened, which is the part
 * that matters.
 */
export function resolveWithin(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // a malformed escape is not a path
  }
  if (decoded === "/" || decoded === "") return join(root, "index.html");
  if (decoded.includes("\0")) return null;

  const candidate = resolve(root, `.${decoded}`);
  const inside = relative(root, candidate);
  if (inside === "" || inside.startsWith("..") || inside.startsWith(`..${sep}`)) return null;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return null;
  return candidate;
}

function sendText(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  response.end(body);
}
