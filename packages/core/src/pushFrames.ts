/**
 * EO's push stream, as bytes (EO-321, EO-324).
 *
 * `ipcPushContract` says what a push *means*; `PUSH_STREAM_PATH` says
 * where it arrives; this says what it looks like on the wire. Server-
 * sent events, which is a plain enough format that the temptation is to
 * parse it at each call site — and there are two, now that a desktop
 * subscribes to its organisation's record as well as a browser
 * subscribing to the server it was served from.
 *
 * Two parsers would be two readings of one format, and the ways they
 * would drift are not hypothetical: a `data` field spread over several
 * lines, a heartbeat comment, `\r\n` where the other end wrote `\n`.
 * Each of those is a frame one client handles and the other silently
 * drops, and a silently dropped invalidation is a board that stops
 * refreshing on one kind of machine.
 *
 * Deliberately not a client. Holding a connection open, reconnecting
 * and backing off are a *transport's* business and the two transports
 * differ — a browser has `ReadableStream` and a tab lifetime, a main
 * process has a session that can be signed out from under it. What they
 * share is this: given the text between two blank lines, what did the
 * server say.
 */

/** One frame's fields, as SSE defines them. */
export interface PushFrame {
  /** The wire channel, or `message` where the server named none. */
  event: string;
  /** The id, for `Last-Event-ID` on the next connection. Null when the frame carried none. */
  id: string | null;
  /** The payload text. Null when the frame had no `data` field at all — a comment, or a bare id. */
  data: string | null;
}

/**
 * One frame, as SSE defines it: fields by line, `data` accumulating.
 *
 * A line beginning with a colon is a comment, which is what the
 * server's heartbeat is and why a heartbeat moves nothing. A field with
 * no colon is a field with an empty value. One leading space after the
 * colon is part of the format rather than part of the value.
 *
 * `data` accumulates across lines joined by newlines, which is the
 * format's own rule and the one a naive parser gets wrong: a payload
 * containing a newline arrives as several `data:` lines and has to be
 * put back together before it is JSON again.
 */
export function parsePushFrame(frame: string): PushFrame {
  let event = "message";
  let id: string | null = null;
  let data: string | null = null;

  for (const line of frame.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = (colon === -1 ? "" : line.slice(colon + 1)).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") data = data === null ? value : `${data}\n${value}`;
  }

  return { event, id, data };
}

/**
 * Splits a growing buffer into whole frames.
 *
 * Answers the frames it could read and what is left over, because a
 * chunk off a socket ends wherever the network decided rather than on a
 * frame boundary. The caller keeps the remainder and hands it back with
 * the next chunk.
 *
 * `\r\n` and `\r` are normalised to `\n` on the way in: SSE allows
 * either ending and one frame may legally mix them, so everything after
 * this only has to know about one.
 */
export function readPushFrames(buffer: string): { frames: string[]; rest: string } {
  const normalised = buffer.replace(/\r\n?/g, "\n");
  const frames: string[] = [];
  let rest = normalised;

  let boundary = rest.indexOf("\n\n");
  while (boundary !== -1) {
    frames.push(rest.slice(0, boundary));
    rest = rest.slice(boundary + 2);
    boundary = rest.indexOf("\n\n");
  }

  return { frames, rest };
}
