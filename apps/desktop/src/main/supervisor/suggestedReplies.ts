import type { AgentEvent, AgentProvider, InterruptibleStream } from "@eo/core";

/**
 * How long a turn's stream is read past its `result` for a suggested
 * reply before it is let go. Claude settles one within 30 seconds of its
 * input closing, or ends its stream with none; the margin is for a
 * backend that makes its own.
 */
export const SUGGESTION_WAIT_MS = 60_000;

/** A suggested reply, for the chat it belongs to and the run whose turn it follows. */
export interface SuggestedReply {
  conversationId: string;
  runId: string;
  text: string;
}

/**
 * The suggested next message of an assistant chat (EO-809), read off the
 * turn that asked for one.
 *
 * The backend sends it after the turn's `result`, on the same stream
 * (`PromptSuggestionEvent`). The run is over at that `result` and must
 * not wait for it, nor hold its slot while it comes: so the stream is
 * handed here at the `result`, still open, and read on beside the run's
 * ending — the run lets go of its end of it without ending it.
 *
 * Every turn that asks is opened with a signal of its own beside the
 * run's, and that is what stops the reading: a newer turn on the same
 * chat (`wrap`), a person saying anything in it (`drop`), or the wait
 * running out. Stopping a turn's signal after its `result` aborts only
 * what it is still doing — making the suggestion — and its process with
 * it. A suggestion that comes after it was stopped is dropped.
 *
 * Nothing here is recorded. The suggestion is not a comment, a message or
 * a run event: it goes to `onSuggestion`, which shows it to whoever has
 * the chat open, and nowhere else.
 */
export interface SuggestedReplies {
  /**
   * The provider a chat's turn is opened through. A turn opened through
   * it stops whatever is still being read for the chat, and one asking
   * for a suggestion is given the signal that will stop its own.
   */
  wrap: (provider: AgentProvider, conversationId: string, runId: string) => AgentProvider;
  /**
   * The stream as the run reads it: unchanged for a turn that asked for
   * no suggestion. For one that did, `afterResult` — called once its
   * `result` has been read, before the run stops reading — hands the rest
   * of it to be read here, and the run's own letting go of it then ends
   * nothing.
   */
  reading: (stream: InterruptibleStream<AgentEvent>) => { stream: AsyncIterable<AgentEvent>; afterResult: () => void };
  /** Stops reading for a chat's suggestion, and drops one that comes later. */
  drop: (conversationId: string) => void;
}

interface Asked {
  conversationId: string;
  runId: string;
  controller: AbortController;
}

export function createSuggestedReplies(options: { onSuggestion: (reply: SuggestedReply) => void; waitMs?: number }): SuggestedReplies {
  const waitMs = options.waitMs ?? SUGGESTION_WAIT_MS;
  /** The turns that asked, by the stream they were opened as. */
  const asked = new WeakMap<object, Asked>();
  /** What is being read for each chat, once its turn's `result` is in. */
  const readers = new Map<string, Asked>();

  function drop(conversationId: string): void {
    const reader = readers.get(conversationId);
    if (!reader) return;
    readers.delete(conversationId);
    reader.controller.abort();
  }

  function opened(stream: InterruptibleStream<AgentEvent>, conversationId: string, runId: string, controller: AbortController | null): InterruptibleStream<AgentEvent> {
    if (controller) asked.set(stream, { conversationId, runId, controller });
    return stream;
  }

  /** A signal that ends the turn when the run's does, and when its suggestion is stopped. */
  function signalFor(own: AbortController, signal: AbortSignal | undefined): AbortSignal {
    return signal ? AbortSignal.any([signal, own.signal]) : own.signal;
  }

  async function read(iterator: AsyncIterator<AgentEvent>, reader: Asked): Promise<void> {
    const stopped = new Promise<"stopped">((resolve) => {
      if (reader.controller.signal.aborted) resolve("stopped");
      else reader.controller.signal.addEventListener("abort", () => resolve("stopped"), { once: true });
    });
    const timer = setTimeout(() => reader.controller.abort(), waitMs);
    timer.unref?.();
    try {
      for (;;) {
        // Raced against the stop, so a backend that does not end when its
        // signal does cannot keep this waiting.
        const step = await Promise.race([iterator.next(), stopped]);
        if (step === "stopped" || step.done) return;
        if (step.value.type !== "prompt_suggestion") continue;
        const text = step.value.text.trim();
        if (text !== "" && readers.get(reader.conversationId) === reader && !reader.controller.signal.aborted) {
          options.onSuggestion({ conversationId: reader.conversationId, runId: reader.runId, text });
        }
        return;
      }
    } catch {
      // Stopped, or the backend failed after its turn was over: no
      // suggestion, which is not an error of anything.
    } finally {
      clearTimeout(timer);
      if (readers.get(reader.conversationId) === reader) readers.delete(reader.conversationId);
      // Let go of the stream, which ends the turn's process. Not waited
      // for: a stream still being read answers only once its read does,
      // and the signal stopping it is what ends that.
      void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined);
    }
  }

  return {
    wrap(provider, conversationId, runId) {
      // A newer turn on the chat: whatever the last one is still making
      // is for a reply nobody will see next to it.
      const own = (suggest: boolean | undefined): AbortController | null => {
        drop(conversationId);
        return suggest === true ? new AbortController() : null;
      };
      return {
        ...provider,
        start: (opts) => {
          const controller = own(opts.suggestNextMessage);
          return opened(provider.start(controller ? { ...opts, signal: signalFor(controller, opts.signal) } : opts), conversationId, runId, controller);
        },
        resume: (threadId, message, opts) => {
          const controller = own(opts?.suggestNextMessage);
          return opened(
            provider.resume(threadId, message, controller ? { ...opts, signal: signalFor(controller, opts?.signal) } : opts),
            conversationId,
            runId,
            controller,
          );
        },
      };
    },

    reading(stream) {
      const turn = asked.get(stream);
      if (!turn) return { stream, afterResult: () => undefined };
      const iterator = stream[Symbol.asyncIterator]();
      let handed = false;
      const reader: AsyncIterator<AgentEvent> = {
        next: () => iterator.next(),
        // Once handed on, the run's letting go is not the turn's end.
        return: (value?: unknown) => (handed ? Promise.resolve({ done: true, value: undefined }) : (iterator.return?.(value) ?? Promise.resolve({ done: true, value: undefined }))),
      };
      return {
        stream: { [Symbol.asyncIterator]: () => reader },
        afterResult: () => {
          if (handed) return;
          handed = true;
          drop(turn.conversationId);
          readers.set(turn.conversationId, turn);
          void read(iterator, turn);
        },
      };
    },

    drop,
  };
}
