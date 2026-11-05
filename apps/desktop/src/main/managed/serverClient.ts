import { hostname } from "node:os";
import {
  isMachineChannel,
  normalizeServerAddress,
  serverAddressRefusal,
  type IpcChannel,
  type IpcPayload,
  type IpcResponse,
  type IpcResult,
} from "@eo/core";

/**
 * How a desktop talks to its organisation's record (EO-323,
 * `ARCHITECTURE.md`, "The record", "Identity").
 *
 * The mirror image of `server/http.ts`: the same envelope, the same
 * path, the same `Authorization: Bearer`. What this end adds is the two
 * rules that are a *client's* to keep.
 *
 * **TLS, or loopback, and nothing else.** Checked before a socket is
 * opened rather than after: a password and a device token are what this
 * carries, and "we noticed afterwards that it went in the clear" is not
 * a thing worth being able to say. The sentence is
 * `serverAddressProblem`'s, so the sign-in screen and this agree.
 *
 * **A 401 is a signing-out.** This machine's token was issued to it and
 * accepted once, so a server refusing it now is a server that has
 * forgotten it or an admin who has revoked it. Either way the person has
 * to be told, and told something other than "request failed" — which is
 * why `onSignedOut` is a constructor argument rather than something a
 * caller is trusted to check.
 *
 * Nothing here syncs anything. Sync is the next story; what this exists
 * for today is the front door and the people list behind it.
 */

export interface ServerClientOptions {
  /** The server, as the person typed it. Normalised here; refused here if it is not one EO will use. */
  address: string;
  /** This machine's device token, or null while signing in. */
  token: string | null;
  /**
   * What to do when the server stops accepting this machine's token.
   *
   * Called at most once per request, and with nothing: the fact is
   * always the same fact. `session.markRevoked` is what production
   * passes.
   */
  onSignedOut?: () => void;
  /** `globalThis.fetch` in production. A test passes its own rather than opening a socket. */
  fetch?: typeof globalThis.fetch;
  /** How long to wait. A person is watching a sign-in button, so it is short. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export interface ServerClient {
  /** The address this client talks to, normalised. */
  readonly address: string;
  request<K extends IpcChannel>(channel: K, payload: IpcPayload<K>): Promise<IpcResult<IpcResponse<K>>>;
}

export function createServerClient(options: ServerClientOptions): ServerClient {
  const address = normalizeServerAddress(options.address);
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    address,

    async request(channel, payload) {
      const refusal = serverAddressRefusal(address);
      if (refusal !== null) return { ok: false, error: { message: refusal } };

      // Refused here rather than at the far end, exactly as the
      // browser's transport refuses it: the answer is the same sentence
      // either way — core's — and there is no reason to spend a round
      // trip being told what this end already knows.
      if (isMachineChannel(channel)) {
        return { ok: false, error: { message: `"${channel}" is about this machine and is never asked of a server.` } };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(`${address}/ipc/${encodeURIComponent(channel)}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.token === null ? {} : { authorization: `Bearer ${options.token}` }),
          },
          // Wrapped, so a channel taking `z.void()` is distinguishable
          // from a body that never said anything — see server/http.ts.
          body: JSON.stringify({ payload }),
          signal: controller.signal,
        });

        if (response.status === 401) {
          // Only when this machine actually presented something. A
          // sign-in attempt with no token that comes back 401 is a
          // password that was wrong, not a device that was turned out,
          // and saying "your organisation signed you out" to somebody
          // who has never signed in would be a lie in the one place a
          // person is least able to check it.
          if (options.token !== null) options.onSignedOut?.();
          return { ok: false, error: { message: await problemFrom(response) } };
        }

        if (!response.ok && response.status !== 200) {
          return { ok: false, error: { message: await problemFrom(response) } };
        }

        return (await response.json()) as IpcResult<IpcResponse<typeof channel>>;
      } catch (error) {
        const reason = controller.signal.aborted ? `${address} did not answer in time.` : String(error);
        return { ok: false, error: { message: `EO could not reach ${address}: ${reason}` } };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The server's own sentence for a request it refused, or a fallback.
 *
 * Read out of the envelope rather than assumed, because the server says
 * something useful — "sign in again, or ask your admin whether this
 * device was revoked" — and replacing it with a status code would throw
 * that away. A body that is not an envelope at all is what a proxy in
 * front of the server returns, and it gets a sentence naming the status.
 */
async function problemFrom(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string" && message.length > 0) return message;
  } catch {
    // Not JSON. Fall through.
  }
  return `That server answered ${response.status}.`;
}

/**
 * What this machine calls itself in the admin's Devices list.
 *
 * The hostname, because it is what a person recognises in a list of
 * their own machines — "anna-macbook" beside "anna-desktop" — and
 * because EO has nothing better to offer: Electron knows the OS and the
 * architecture, and neither distinguishes two laptops. A host with no
 * name at all is rare enough that a sentence is the right answer.
 */
export function thisMachineName(): string {
  const name = hostname().trim();
  return name.length === 0 ? "an unnamed machine" : name;
}
