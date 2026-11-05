/**
 * What is wrong with a string that was supposed to be an http URL, as a
 * fact rather than as a sentence.
 *
 * Read by hand rather than with `new URL`. This package is on the pure
 * side of invariant #2 and its `lib` has neither DOM nor Node in it, so
 * `URL` is not a name here — and the four things worth refusing are
 * exactly the four somebody gets wrong: nothing typed, no scheme, a
 * scheme that is not http, and no host.
 *
 * A **fault rather than a message**, because two callers want the same
 * check under different words. `readMcpServerDraft` is answering a
 * person who typed a server's address into a form, and says "a remote
 * server's address starts with http://"; `connectorDefinitionProblems`
 * is answering whoever authored a pack, and has to name *which* of a
 * connector's two URLs is wrong. One predicate and two vocabularies
 * beats two predicates that agree today — the arrangement `mcpToolId`
 * settled for the same reason.
 *
 * It is deliberately not a parser. Nothing here returns a host or a
 * path: the question is only whether this is a URL EO could open, and
 * every caller that actually opens one is in the main process, where
 * `URL` exists and is what does the parsing.
 */

const URL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

export type HttpUrlFault =
  /** Nothing typed at all. */
  | { kind: "empty" }
  /** No `scheme://` in front of it — usually somebody pasted a bare host. */
  | { kind: "no-scheme" }
  /** A scheme EO cannot open a connection over. Carries it, lower-cased, so a message can name it. */
  | { kind: "not-http"; protocol: string }
  /** `http:///path` — a scheme and nothing to connect to. */
  | { kind: "no-host" };

/** The fault, or null when the string is an http URL EO could open. */
export function httpUrlFault(url: string): HttpUrlFault | null {
  if (url === "") return { kind: "empty" };

  const scheme = URL_SCHEME_PATTERN.exec(url);
  if (scheme === null) return { kind: "no-scheme" };

  const protocol = (scheme[1] ?? "").toLowerCase();
  if (protocol !== "http" && protocol !== "https") return { kind: "not-http", protocol };

  const authority = url.slice(scheme[0].length).split(/[/?#]/)[0] ?? "";
  if (authority === "") return { kind: "no-host" };

  return null;
}
