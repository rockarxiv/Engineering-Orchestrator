import type { IpcPushPayload, LiveDraft } from "@eo/core";

/**
 * What an agent is writing right now, block by block, before it is stored.
 *
 * The other half of `OutputDeltaEvent`. The words of a block arrive as
 * deltas and are never written to `run_events` — the finished block is —
 * so between the first word and the stored block, this is the only place
 * they exist. Two readers need them:
 *
 * - **A window that is watching**, sent each piece as `runs:delta`,
 *   coalesced to about one push per frame. Claude Desktop does the same
 *   with a 16 ms timer over consecutive deltas of one block, and for the
 *   same reason: an agent produces deltas far faster than a window can
 *   usefully draw them, and one IPC message per token would be most of the
 *   work.
 * - **A window that opens mid-sentence**, which reads `snapshot` through
 *   the conversation's `liveTurn` and appends the pushes that follow.
 *
 * A draft is *settled* when the event that finishes its block is stored,
 * and is kept, settled, until that event has been written to the database.
 * The view drops it from then on, so the words are on screen as a draft
 * until they are on screen as a step — never both, never neither.
 *
 * In memory only, and per process: a restart loses nothing that matters,
 * because a block that was being written when EO stopped was never going
 * to be finished by the process that stopped.
 */
export interface LiveDrafts {
  /** More of the block a run is writing. Opens a new draft when the stream changed or the last one settled. */
  append: (runId: string, itemId: string, stream: LiveDraft["stream"], text: string) => void;
  /**
   * A block has finished and its event was stored as `seq`: the oldest
   * draft still being written on that stream is the one it finished, or
   * every one when `stream` is null (an error ends whatever was being
   * written). The draft stays until the database holds that row.
   */
  settle: (runId: string, seq: number, stream: LiveDraft["stream"] | null) => void;
  /**
   * The turn has ended, whether or not the run has — a corrective turn
   * may follow on the same run. A block it left unfinished will never be
   * stored, so it is dropped rather than left for the next turn's words
   * to be joined onto. Drafts waiting for their row to land stay.
   */
  endTurn: (runId: string) => void;
  /**
   * The drafts a view of the run should draw, given the highest `seq` the
   * database holds for it: those still being written, and those whose
   * finishing event is not stored yet.
   */
  snapshot: (runId: string, storedThrough: number) => LiveDraft[];
  /** The id of the newest draft the run has opened, 0 for none. */
  lastId: (runId: string) => number;
  /** The run has ended; nothing it was writing is still being written. */
  clear: (runId: string) => void;
  /** Where coalesced pieces go. One listener — the engine's push. */
  onDelta: (listener: ((push: IpcPushPayload<"runs:delta">) => void) | null) => void;
}

interface Draft extends LiveDraft {
  /** The `seq` of the event that finished this block, once one has. */
  settledAt: number | null;
}

interface Pending {
  itemId: string;
  draft: Draft;
  /** Where in the draft's text the unsent piece starts. */
  offset: number;
  timer: ReturnType<typeof setTimeout>;
}

/** About one frame: the window draws at most this often anyway. */
const COALESCE_MS = 16;
/**
 * Drafts a run keeps. One is the usual count and two is a block finishing
 * while the next begins; the cap is a bound on a backend that opens blocks
 * and never finishes any.
 */
const KEPT_DRAFTS = 8;

export function createLiveDrafts(options: { coalesceMs?: number } = {}): LiveDrafts {
  const coalesceMs = options.coalesceMs ?? COALESCE_MS;
  const drafts = new Map<string, Draft[]>();
  const pending = new Map<string, Pending>();
  const counters = new Map<string, number>();
  let listener: ((push: IpcPushPayload<"runs:delta">) => void) | null = null;

  function flush(runId: string): void {
    const unsent = pending.get(runId);
    if (!unsent) return;
    pending.delete(runId);
    clearTimeout(unsent.timer);
    const text = unsent.draft.text.slice(unsent.offset);
    if (text === "") return;
    // Never allowed to throw into its caller: this runs from a timer,
    // where a throw is an uncaught exception in the main process, and
    // from `settle` inside a run, where it would fail the run over a
    // window that missed a few words.
    try {
      listener?.({ runId, itemId: unsent.itemId, draft: { id: unsent.draft.id, stream: unsent.draft.stream }, offset: unsent.offset, text });
    } catch (error) {
      console.warn("[eo] a live draft could not be pushed:", error);
    }
  }

  return {
    append(runId, itemId, stream, text) {
      if (text === "") return;
      const list = drafts.get(runId) ?? [];
      let open = list.at(-1);
      if (!open || open.settledAt !== null || open.stream !== stream) {
        // A new block: whatever was waiting to be sent belongs to the old
        // one and goes first, so a window never sees the new draft before
        // the end of the last.
        flush(runId);
        const id = (counters.get(runId) ?? 0) + 1;
        counters.set(runId, id);
        open = { id, stream, text: "", settledAt: null };
        list.push(open);
        if (list.length > KEPT_DRAFTS) list.splice(0, list.length - KEPT_DRAFTS);
        drafts.set(runId, list);
      }
      const offset = open.text.length;
      open.text += text;
      if (!pending.has(runId)) {
        const timer = setTimeout(() => flush(runId), coalesceMs);
        timer.unref?.();
        pending.set(runId, { itemId, draft: open, offset, timer });
      }
    },

    settle(runId, seq, stream) {
      const list = drafts.get(runId) ?? [];
      const open = list.filter((draft) => draft.settledAt === null && (stream === null || draft.stream === stream));
      if (open.length === 0) return;
      flush(runId);
      for (const draft of stream === null ? open : open.slice(0, 1)) draft.settledAt = seq;
    },

    endTurn(runId) {
      const list = drafts.get(runId);
      if (!list) return;
      flush(runId);
      drafts.set(
        runId,
        list.filter((draft) => draft.settledAt !== null),
      );
    },

    snapshot(runId, storedThrough) {
      const list = drafts.get(runId) ?? [];
      // Forgotten here as well as filtered: once its row is stored a
      // settled draft is a step, and nothing will ask for it again.
      const kept = list.filter((draft) => draft.settledAt === null || draft.settledAt > storedThrough);
      if (kept.length !== list.length) drafts.set(runId, kept);
      return kept.map(({ id, stream, text }) => ({ id, stream, text }));
    },

    lastId(runId) {
      return counters.get(runId) ?? 0;
    },

    clear(runId) {
      flush(runId);
      drafts.delete(runId);
      counters.delete(runId);
    },

    onDelta(next) {
      listener = next;
    },
  };
}

/**
 * The process's one store. The supervisor writes to it and the
 * conversation view reads it; both are in the main process and neither
 * owns the other, so it is a module rather than a field of either.
 */
export const liveDrafts: LiveDrafts = createLiveDrafts();
