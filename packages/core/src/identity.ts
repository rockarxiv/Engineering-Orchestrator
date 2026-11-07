import { z } from "zod";

/**
 * The organisation's list: people, groups, devices and the invitation
 * that puts somebody on it (EO-323, `ARCHITECTURE.md`, "Identity").
 *
 * People already exist — phase 5 gave every installation one row, the
 * implicit local person, because a job needs an owner before any server
 * does. What the server adds is *the list*: an admin invites somebody by
 * email, they accept and set a credential, they sign in from their own
 * desktop, and the server issues that machine a token it can revoke.
 * From then on a mention targets a person by name across machines, and a
 * human step can wait on a group rather than on one pair of hands.
 *
 * Everything here is the shape of that on the wire. The schemas are in
 * `core` rather than in the server because both ends parse them: the
 * server reads a sign-in off a socket, and the desktop reads the answer
 * — and the two disagreeing about a field is exactly the class of bug a
 * shared schema exists to make impossible (the working agreement's
 * "Zod schemas in `packages/core` are the single source of truth for
 * anything crossing a boundary").
 */

/**
 * How a person proves who they are (ARCHITECTURE.md, "Identity").
 *
 * Recorded rather than assumed, because the story asks for it in those
 * words — "accepting sets a password or, for the first version, a
 * passkey through the browser's WebAuthn if the platform provides it,
 * else a password. Record the choice."
 *
 * **One value today, and deliberately.** `passkey` was here, with the
 * accept screen offering it and this column recording it — and nothing
 * anywhere registering a WebAuthn credential or verifying an assertion.
 * That is worse than not offering it at all, twice over: the control did
 * nothing (invariant #12), and the record then said "passkey" about an
 * account whose only credential was a password. The one question this
 * column exists to answer — how does this person get in — would have
 * been answered wrongly, by EO, about its own data.
 *
 * Adding the value back is a front door rather than an enum entry. A
 * passkey has to be *registered* against a challenge this server issued
 * and *verified* on the way in, and the way in for this version is the
 * desktop's sign-in screen, which the scope itself describes as "server
 * address, email, password". A credential only a browser could present,
 * to a browser sign-in that does not exist, is a credential nobody can
 * use — so the flow comes first and this value comes with it, as single
 * sign-on will ("changes only the front door", ARCHITECTURE.md, "Identity").
 */
export const CredentialKindSchema = z.enum(["password"]);
export type CredentialKind = z.infer<typeof CredentialKindSchema>;

/** Somebody on the organisation's list, as the admin screens and the pickers read them. */
export const PersonViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  /** "One admin flag. Everyone with it may edit on the server." (the original design) */
  isAdmin: z.boolean(),
  /** When they were invited, or null for a row that was never an invitation — the local person. */
  invitedAt: z.number().nullable(),
  /** When they accepted and set a credential. Null means the invitation is still outstanding. */
  acceptedAt: z.number().nullable(),
  /** Null until they have accepted. */
  credentialKind: CredentialKindSchema.nullable(),
});
export type PersonView = z.infer<typeof PersonViewSchema>;

/**
 * A group, so a human step can say "Support team · anyone claims" (ARCHITECTURE.md, "Identity").
 *
 * Two columns and a membership table, and nothing about permission: a
 * group is who a piece of work is offered to, not what anybody is
 * allowed to do. Per-project roles are named out of scope by this story
 * and per-project owners by the original design — "with the first customer who asks,
 * not before".
 */
export const GroupViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  memberIds: z.array(z.string()),
});
export type GroupView = z.infer<typeof GroupViewSchema>;

/**
 * A machine somebody signed in from, in the admin's Devices list.
 *
 * `token` is not here and never is: the server keeps a hash and the
 * device keeps the only copy of the secret, so this is the list of what
 * may talk rather than of what to talk with.
 */
export const DeviceViewSchema = z.object({
  id: z.string(),
  personId: z.string(),
  /** Who it belongs to, so the list reads as sentences rather than as ids. */
  personName: z.string(),
  /** What the machine calls itself — a hostname, usually. */
  name: z.string(),
  createdAt: z.number(),
  /** When it last presented its token. Null until it has made a request past the sign-in. */
  lastSeenAt: z.number().nullable(),
  /** When an admin revoked it. Null while it still works. */
  revokedAt: z.number().nullable(),
});
export type DeviceView = z.infer<typeof DeviceViewSchema>;

/**
 * What a desktop is told when its token has stopped working.
 *
 * The exact words the story asks the desktop to show, in one place, so
 * that the sign-in screen, the session state and the test that proves
 * the acceptance criterion cannot each have their own version of them.
 *
 * Any 401 means this. A token this machine holds was issued to it and
 * accepted once; the server refusing it now is the server having
 * forgotten it or an admin having revoked it, and from where the person
 * sits those are the same event with the same answer — sign in again if
 * you think that was a mistake.
 */
export const SIGNED_OUT_BY_ORGANISATION = "signed out by your organisation";

/** The sentence the desktop puts on the screen when that happens. */
export const SIGNED_OUT_BY_ORGANISATION_LINE = `This device was ${SIGNED_OUT_BY_ORGANISATION}. Sign in again to keep using it.`;

// ── The front door ──────────────────────────────────────────────────
//
// `auth:signIn` and `auth:acceptInvitation` are ordinary channels of the
// record half, named in `UNAUTHENTICATED_CHANNELS` so the server's door
// lets exactly those two past the token. A route of their own would have
// meant a second door with its own body reading, its own size limit and
// its own validation — three things the contract already does for every
// other request, and three more places for the two ends to disagree.
// What they get instead is one exception, written down in one list.

/** The path an invitation link points at. The code is the last segment. */
export const INVITATION_PATH_PREFIX = "/invite/";

/** That path, for one code. The admin's screen resolves it against the origin their browser is on. */
export function invitationPath(code: string): string {
  return `${INVITATION_PATH_PREFIX}${encodeURIComponent(code)}`;
}

/** The code out of such a path, or null when the path is not one. Read by the accept screen. */
export function invitationCodeFrom(pathname: string): string | null {
  if (!pathname.startsWith(INVITATION_PATH_PREFIX)) return null;
  const raw = pathname.slice(INVITATION_PATH_PREFIX.length);
  if (raw.length === 0) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * A whole invitation link, as somebody pasted it — `https://eo.acme.com/invite/<code>`
 * — split into the server it came from and its code, or null when it is
 * not one (EO-661).
 *
 * The address is the link's origin, because that is what the admin's
 * screen resolves `invitationPath` against, and so it is the address
 * the desktop then signs in to. Only http and https: anything else is
 * not a server's page to open in a browser.
 */
export function invitationLinkFrom(link: string): { address: string; code: string } | null {
  // A regular expression rather than `URL`, which this package does not
  // assume (see `addressHost`): scheme and authority, then the path.
  const match = /^(https?:\/\/[^/?#@\s]+)(\/[^?#\s]*)(?:[?#]\S*)?$/i.exec(link.trim());
  if (match === null) return null;
  const [, origin = "", path = ""] = match;
  const code = invitationCodeFrom(path);
  if (code === null || code.includes("/")) return null;
  return { address: origin, code };
}

/** What an invitation link looks like, said when something else was pasted. */
export const INVITATION_LINK_SHAPE_LINE =
  "That is not an invitation link. One looks like https://eo.example.com/invite/ followed by a code: your organisation's server address, then /invite/ and the code.";

/**
 * A password, as a rule rather than as a policy screen.
 *
 * A minimum length and nothing else: composition rules push people to
 * `Password1!` and are worse than the length they replace. Twelve is
 * what a passphrase of three words reaches and what a dictionary of one
 * word does not.
 */
export const MIN_PASSWORD_LENGTH = 12;

export const PasswordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(1024);

/**
 * What a browser sends when somebody follows an invitation link.
 *
 * No `credentialKind`. There is one kind, so there is nothing to choose
 * and nothing to ask: a field a caller could only ever fill in one way
 * is a field that reads like a choice and is not one, and the moment a
 * second kind exists it will arrive with the flow that can honour it.
 * What is *recorded* is `acceptInvitation`'s to write, out of what it
 * actually stored.
 */
export const AcceptInvitationRequestSchema = z.object({
  code: z.string().min(1).max(200),
  password: PasswordSchema,
  /** A person may correct the name the admin typed for them. */
  name: z.string().min(1).max(200).optional(),
});
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequestSchema>;

export const AcceptInvitationResponseSchema = z.object({
  personId: z.string(),
  name: z.string(),
  email: z.string(),
  credentialKind: CredentialKindSchema,
});
export type AcceptInvitationResponse = z.infer<typeof AcceptInvitationResponseSchema>;

/** What a desktop sends to sign in. */
export const SignInRequestSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  /**
   * What this machine calls itself, for the admin's list. A hostname in
   * practice — "Anna's MacBook" is what a person recognises when they
   * are deciding which row to revoke, and an id is not.
   */
  deviceName: z.string().min(1).max(200),
  /**
   * The device row to re-issue a token for, when this machine has signed
   * in before.
   *
   * Sent so that signing in again after a token was revoked, or after
   * one was lost with a reinstalled keychain, does not leave the admin's
   * list growing a row per sign-in. Unknown ids and ids belonging to
   * somebody else are ignored rather than refused: the server mints a
   * new row, which is the honest reading of "this machine cannot prove
   * it is the one that held that row".
   */
  deviceId: z.string().max(100).optional(),
  /**
   * Whether this client is a machine that runs work (EO-328, ARCHITECTURE.md, "Secrets").
   *
   * A desktop's main process says true; the renderer a server hands a
   * browser says nothing and takes the default. What it decides is
   * whether the server mints a **second** credential for this device —
   * the one that opens `ORGANISATION_SECRETS_PATH` and nothing else.
   *
   * It exists because the device token cannot be that credential. A
   * browser needs a token to POST `/ipc/…` and keeps it in
   * `sessionStorage`; a route guarded by the device token is therefore a
   * route the served renderer can call, and the acceptance criterion
   * that no query the renderer can make returns an organisation secret
   * would be false however careful the channels were. So the key that
   * does open it is one a browser never asks for and is never given.
   *
   * **Declared by the client and then narrowed by the server**, which is
   * the half a review corrected. On its own this was a field a renderer
   * could simply assert: the browser could POST `auth:signIn` with it
   * set, read `secretsKey` out of the answer, and fetch the
   * organisation's secrets with it — so a separate credential was not
   * separate at all. `withoutWorkClaim` is the boundary, applied at the
   * server's door to anything that carries browser fetch metadata
   * (`Origin`, `Sec-Fetch-Site`), both of which are forbidden header
   * names a page cannot forge or remove. The door only ever turns a true
   * into a false, so nothing is gained by claiming it.
   *
   * What that buys is the property the story's third acceptance
   * criterion needs: the credential in a renderer's `sessionStorage`
   * opens nothing, and a renderer cannot obtain one that does.
   */
  runsWork: z.boolean().default(false),
});
export type SignInRequest = z.infer<typeof SignInRequestSchema>;

export const SignInResponseSchema = z.object({
  /** The only time the server says this out loud. It keeps a hash. */
  token: z.string(),
  /**
   * This device's organisation-secrets key, or null (EO-328, ARCHITECTURE.md, "Secrets").
   *
   * Said once, like the token above, and kept as a hash. Null for a
   * client that did not ask to run work — so a browser's sign-in
   * response does not carry one and there is nothing for
   * `sessionStorage` to hold.
   *
   * A desktop's main process puts it straight into the OS keychain
   * beside the token and never hands it to a window. It is what
   * `policy/sync.ts` presents on the one request that is not a channel.
   */
  secretsKey: z.string().nullable().default(null),
  deviceId: z.string(),
  person: PersonViewSchema,
});
export type SignInResponse = z.infer<typeof SignInResponseSchema>;

// ── Where this desktop stands ───────────────────────────────────────

/**
 * This installation's own sign-in, as the screens read it (EO-323,
 * ARCHITECTURE.md, "Identity").
 *
 * Three states rather than a boolean, and the third is the one the story
 * names: a device whose token was revoked has been *signed out by its
 * organisation*, which is not the same as one that never signed in. The
 * person did nothing; their admin did. Showing them an empty form and
 * saying nothing is how a person concludes the app is broken.
 */
export const SessionStatusSchema = z.discriminatedUnion("state", [
  /** Solo. No server has ever been signed in to from this machine. */
  z.object({ state: z.literal("signed-out") }),
  z.object({
    state: z.literal("signed-in"),
    /** The server, normalised — no trailing slash. */
    address: z.string(),
    email: z.string(),
    personId: z.string(),
    personName: z.string(),
    isAdmin: z.boolean(),
    /** This machine's row in the admin's Devices list. */
    deviceId: z.string(),
    deviceName: z.string(),
  }),
  z.object({
    state: z.literal("revoked"),
    address: z.string(),
    email: z.string(),
    /** `SIGNED_OUT_BY_ORGANISATION_LINE`, carried so every surface says it identically. */
    line: z.string(),
  }),
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** Both front-door channels answer this when they refuse, with the same envelope the rest use. */
export const AuthProblemSchema = z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) });
