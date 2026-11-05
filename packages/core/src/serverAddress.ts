/**
 * What a desktop will and will not sign in to (EO-323,
 * the original design).
 *
 * "Today the only listener refuses anything but loopback by design. The
 * server exposes that surface publicly, so: TLS is required." A sign-in
 * carries a password and comes back with a device token that is then on
 * every request this machine makes for the life of the installation.
 * Over plain HTTP to an address somewhere else, both are readable by
 * anything between here and there — and unlike a leaked password, a
 * token nobody knows was taken is not one anybody thinks to revoke.
 *
 * Loopback is the one exception, and it is not a loosening: `http://127.0.0.1`
 * never leaves the machine, so there is no wire to read it off. It is
 * what makes `pnpm start:server` on a laptop, and every test in this
 * repository, something a person can actually sign in to.
 *
 * Read by hand rather than with `new URL`, because this package is on
 * the pure side of invariant #2 and has neither DOM nor Node in its
 * `lib` — the same reason and the same shape as `httpUrlFault`, which
 * this leans on for everything that is not about TLS. The two are
 * deliberately separate calls: "is this a URL at all" is asked of a
 * connector's endpoint and an MCP server's address as well, and "must
 * this one be encrypted" is asked only here.
 */

import { httpUrlFault, type HttpUrlFault } from "./schemas/httpUrl.js";

/** Why EO will not sign in to an address. */
export type ServerAddressFault =
  /** Not a URL EO could open at all — carries `httpUrlFault`'s own answer. */
  | { kind: "not-a-url"; fault: HttpUrlFault }
  /** `http://` to somewhere that is not this machine. Carries the host, so the sentence can name it. */
  | { kind: "insecure"; host: string };

/**
 * The host of an `http(s)://` address, lower-cased, with any port,
 * userinfo, path, query and fragment taken off.
 *
 * Exported because the sign-in screen has a second use for it — naming
 * the server in a sentence — and because a second hand-rolled parser is
 * how two callers come to disagree about what `http://a@b:1/c` is.
 *
 * An IPv6 literal keeps its brackets off: `http://[::1]:8765` answers
 * `::1`, which is what `isLoopbackHost` compares against.
 */
export function addressHost(url: string): string {
  const afterScheme = url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");
  const authority = afterScheme.split(/[/?#]/)[0] ?? "";
  // Userinfo first: `user:pass@host` would otherwise have its password
  // read as a host and its host thrown away with the port.
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostAndPort.startsWith("[")) {
    const close = hostAndPort.indexOf("]");
    return (close === -1 ? hostAndPort.slice(1) : hostAndPort.slice(1, close)).toLowerCase();
  }
  const [host = ""] = hostAndPort.split(":");
  return host.toLowerCase();
}

/**
 * Is this host this machine?
 *
 * The whole of 127.0.0.0/8 rather than `127.0.0.1` alone, because that
 * is what the range *is* — `127.0.0.2` is as local as `.1` and a person
 * who binds a second server to it is not doing anything exotic. `::1`
 * and `localhost` complete the set; `0.0.0.0` deliberately does not,
 * since as a destination it means "this machine" on Linux and nothing
 * portable anywhere else, and an address a person types to reach a
 * server is never it.
 */
export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase();
  if (name === "localhost" || name === "::1" || name === "0:0:0:0:0:0:0:1") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(name);
}

/** The fault in an address a desktop was asked to sign in to, or null when there is none. */
export function serverAddressFault(address: string): ServerAddressFault | null {
  const trimmed = address.trim();
  const fault = httpUrlFault(trimmed);
  if (fault !== null) return { kind: "not-a-url", fault };
  if (trimmed.toLowerCase().startsWith("https://")) return null;

  const host = addressHost(trimmed);
  return isLoopbackHost(host) ? null : { kind: "insecure", host };
}

/**
 * The one line a person is shown instead of a sign-in.
 *
 * One line because that is what the story asks for — "the desktop
 * refuses plain HTTP to a non-local address with a one-line reason" —
 * and because the reason is genuinely one sentence: what would be sent
 * in the clear, and what to type instead. No "are you sure" and no
 * override: an organisation that has not put TLS on its server has a
 * thing to fix, and a checkbox here is how that never gets fixed.
 */
export function serverAddressProblem(fault: ServerAddressFault): string {
  if (fault.kind === "insecure") {
    return (
      `EO will not sign in to ${fault.host} over plain http, because your password and this device's token would ` +
      `cross the network in the clear — use https://${fault.host} instead.`
    );
  }
  switch (fault.fault.kind) {
    case "empty":
      return "Type the address of your organisation's EO server, such as https://eo.example.com.";
    case "no-scheme":
      return "A server address starts with https:// — such as https://eo.example.com.";
    case "not-http":
      return `EO talks to its server over https, not ${fault.fault.protocol}://.`;
    case "no-host":
      return "That address has no server in it — such as https://eo.example.com.";
  }
}

/** The fault and its sentence in one call, for the callers that only ever want the sentence. */
export function serverAddressRefusal(address: string): string | null {
  const fault = serverAddressFault(address);
  return fault === null ? null : serverAddressProblem(fault);
}

/**
 * The address as EO stores and sends it: no trailing slash, so that
 * `${address}${SIGN_IN_PATH}` is one path rather than sometimes two.
 */
export function normalizeServerAddress(address: string): string {
  return address.trim().replace(/\/+$/, "");
}
