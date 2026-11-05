import { serverAddressRefusal, type IpcPayload, type IpcResponse } from "@eo/core";
import { createServerClient, thisMachineName } from "../managed/serverClient.js";
import { forgetSession, rememberedDeviceId, rememberSession, sessionStatus, type SessionStoreOptions } from "../managed/session.js";

/**
 * This machine's sign-in (EO-323,
 * `ARCHITECTURE.md`, "Identity").
 *
 * The machine half of identity, and the only part of this story that
 * belongs there: the address is a preference of this installation, the
 * token lands in this machine's keychain, and neither means anything
 * asked of a server. The *list* those three things reach is the record
 * half's `people:*`.
 *
 * Three channels and no fourth. There is no "check whether my token
 * still works": a token is checked by using it, and a channel that
 * polled would be a second answer to a question the next real request
 * answers anyway — with the added cost that it would tell a person they
 * had been signed out at a moment when they were not doing anything.
 */

export interface SessionContext {
  session: SessionStoreOptions;
  /** `globalThis.fetch` in production. A test hands its own rather than opening a socket. */
  fetch?: typeof globalThis.fetch;
  /** What this machine calls itself in the admin's list. The hostname, unless a test says otherwise. */
  machineName?: () => string;
}

export function sessionStatusCommand(context: SessionContext): IpcResponse<"session:status"> {
  return sessionStatus(context.session);
}

/**
 * Signs this machine in.
 *
 * The address is judged before a socket is opened: plain http to
 * anything that is not loopback is refused with the one line
 * `serverAddressProblem` writes, because what this request carries is a
 * password and what it comes back with is a token for the life of the
 * installation. There is no override and no "continue anyway" — an
 * organisation without TLS on its server has something to fix, and a
 * checkbox here is how it never gets fixed.
 *
 * The device id from any previous sign-in is sent along, so that signing
 * in again — after a revocation, after a keychain reset — re-issues onto
 * the row the admin already knows rather than growing a second one
 * beside it.
 */
export async function signInCommand(context: SessionContext, payload: IpcPayload<"session:signIn">): Promise<IpcResponse<"session:signIn">> {
  const refusal = serverAddressRefusal(payload.address);
  if (refusal !== null) return { status: sessionStatus(context.session), problem: refusal };

  const client = createServerClient({
    address: payload.address,
    // Nothing to present yet: this is the request that earns one. The
    // client is told so explicitly, which is also what stops a 401 here
    // from being read as a revocation — see `onSignedOut`'s comment.
    token: null,
    ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
  });

  const deviceName = (context.machineName ?? thisMachineName)();
  const deviceId = rememberedDeviceId(context.session);
  const answer = await client.request("auth:signIn", {
    email: payload.email,
    password: payload.password,
    deviceName,
    // This *is* a machine that runs work, and saying so is what earns
    // the second credential (EO-328, ARCHITECTURE.md, "Secrets"): the one that opens
    // `ORGANISATION_SECRETS_PATH`, which the desktop keeps in its
    // keychain and hands to no window. The renderer a server serves says
    // nothing here and is issued none, so the token in its
    // `sessionStorage` opens nothing.
    runsWork: true,
    ...(deviceId === undefined ? {} : { deviceId }),
  });

  if (!answer.ok) return { status: sessionStatus(context.session), problem: answer.error.message };
  if (answer.data.session === null) {
    return { status: sessionStatus(context.session), problem: answer.data.problem ?? "That server refused the sign-in without saying why." };
  }

  const session = answer.data.session;
  const remembered = rememberSession(context.session, {
    address: client.address,
    email: payload.email,
    token: session.token,
    secretsKey: session.secretsKey,
    personId: session.person.id,
    personName: session.person.name,
    isAdmin: session.person.isAdmin,
    deviceId: session.deviceId,
    deviceName,
  });
  if (!remembered.ok) {
    // The server has issued a token this machine cannot keep. Said
    // plainly rather than left as a session that appears to work until
    // the next launch, when the token is not there any more.
    return { status: sessionStatus(context.session), problem: remembered.problem };
  }

  return { status: sessionStatus(context.session), problem: null };
}

/** Signs out, here. The device row stays in the admin's list — see `forgetSession`. */
export function signOutCommand(context: SessionContext): IpcResponse<"session:signOut"> {
  forgetSession(context.session);
  return { status: sessionStatus(context.session) };
}
