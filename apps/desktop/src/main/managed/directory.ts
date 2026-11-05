import { createServerClient, type ServerClient } from "./serverClient.js";
import { markRevoked, readToken, sessionStatus, type SessionStoreOptions } from "./session.js";

/**
 * How this installation reaches its organisation, if it has one
 * (EO-323, `ARCHITECTURE.md`, "Identity").
 *
 * One member, and the null it returns is the whole of managed mode as
 * the rest of the process sees it: a solo desktop has no organisation to
 * ask, a server *is* the record and has nobody to ask, and a signed-in
 * desktop has a client that carries its device token and reports a 401
 * as a signing-out.
 *
 * Built fresh per call rather than held, because the token can change
 * under it — a sign-in, a sign-out, a revocation met by another request
 * — and a client that closed over a stale token would carry it until the
 * app restarted, which is precisely how "signed out by your
 * organisation" becomes "signed out, and nothing says why".
 */
export interface ManagedDirectory {
  client(): ServerClient | null;
}

export interface ManagedDirectoryOptions {
  /**
   * How the rest of the app is told this machine was turned out
   * (EO-323, the story's first acceptance criterion).
   *
   * **The half that was missing.** A revocation is the one state change
   * in this story that nobody asks for: it is discovered by a request
   * that was made for some other reason, deep inside a handler, and the
   * only evidence is a 401 that handler then recovers from — `people:list`
   * falls back to the local rows and answers perfectly well. Writing
   * `revoked` to the database and stopping there left every open window
   * still rendering a signed-in session, because nothing had told them
   * to ask again: the desktop knew, and the person did not.
   *
   * So the write is paired with a push, at the one place that knows the
   * write happened. `startMain` passes `emitPush("config:changed")`,
   * which is what every other "ask again" in this process is
   * (`ipcPushContract`: a push says "this changed", never what changed),
   * and `useSession` is subscribed to it on both surfaces that show the
   * sentence.
   *
   * Called at most once per revocation — see `markRevoked`, which
   * answers whether this was the transition — so five requests failing
   * together are one announcement.
   */
  onRevoked?: () => void;
}

export function createManagedDirectory(options: SessionStoreOptions, notify: ManagedDirectoryOptions = {}): ManagedDirectory {
  return {
    client() {
      const status = sessionStatus(options);
      if (status.state !== "signed-in") return null;
      const token = readToken(options);
      if (token === null) return null;
      return createServerClient({
        address: status.address,
        token,
        onSignedOut: () => {
          if (markRevoked(options)) notify.onRevoked?.();
        },
      });
    },
  };
}
