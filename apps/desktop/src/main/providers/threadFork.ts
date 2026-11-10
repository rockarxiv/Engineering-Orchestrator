import { isThreadNotFound, type AgentEvent, type AgentForkResult, type InterruptibleStream } from "@eo/core";
import { leadingWith } from "./skillUsage.js";

/**
 * A fork's turn, read up to the backend opening the copy (EO-716).
 *
 * Both adapters open a fork the way they open a resume — in the stream,
 * because that is where the backend answers — so whether the thread
 * could be forked is known only once the stream says `thread_started`
 * or fails before it. This reads that far, and turns a failure into the
 * typed answer `AgentProvider.fork` promises rather than a throw: a
 * missing thread (`ThreadNotFoundError`, which each adapter already
 * translates its backend's words into) as `thread_not_found`, anything
 * else as `failed`.
 *
 * What was read is said again at the head of the stream handed back, so
 * the caller sees the turn whole, `thread_started` included.
 */
export async function openedFork(threadId: string, stream: InterruptibleStream<AgentEvent>): Promise<AgentForkResult> {
  const iterator = stream[Symbol.asyncIterator]();
  const read: AgentEvent[] = [];
  let opened: string | null = null;
  try {
    while (opened === null) {
      const next = await iterator.next();
      if (next.done) {
        // Ended without opening anything: the backend's last word, if it
        // said one, is the reason.
        const said = [...read].reverse().find((event) => event.type === "error");
        return { ok: false, reason: "failed", threadId, message: said?.type === "error" ? said.message : `The fork of thread "${threadId}" ended before the backend opened it.` };
      }
      read.push(next.value);
      if (next.value.type === "thread_started") opened = next.value.threadId;
    }
  } catch (error) {
    if (isThreadNotFound(error)) return { ok: false, reason: "thread_not_found", threadId, message: error.message };
    return { ok: false, reason: "failed", threadId, message: `Thread "${threadId}" could not be forked: ${error instanceof Error ? error.message : String(error)}` };
  }
  const rest: InterruptibleStream<AgentEvent> = { [Symbol.asyncIterator]: () => iterator };
  if (stream.interrupt) rest.interrupt = () => stream.interrupt!();
  if (stream.steer) rest.steer = (message, attachments) => stream.steer!(message, attachments);
  return { ok: true, threadId: opened, events: leadingWith(read, rest) };
}
