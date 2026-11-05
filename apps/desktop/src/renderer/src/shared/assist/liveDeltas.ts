import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { IpcPushPayload, LiveDraft, LiveTurn } from "@eo/core";
import { bridge } from "../../ipc/bridge";

/**
 * The words a run is writing, as this window has been told them.
 *
 * The renderer's half of `liveDrafts.ts`. The main process pushes each
 * block's words a frame's worth at a time on `runs:delta`, carrying the
 * text because nothing stores it to be asked for again; the conversation
 * view also lists the drafts as they stood when it was read. A window
 * draws whichever of the two has said more, and a delta newer than the
 * view is drawn before the view has heard of it — which is what makes the
 * answer appear word by word rather than on the next refetch.
 *
 * `offset` is where each piece begins in its draft. A piece that starts
 * where this window's copy ends is appended; one that starts earlier
 * repeats what is already here and is cut to its new part; one that starts
 * later means pieces were missed — a window that opened mid-sentence — so
 * it is held, the caller reads the view again, and the view's copy of the
 * draft is taken in (`seed`) with the held pieces replayed on top of it.
 *
 * Only for the conversations a surface is drawing (`watch`): a push names
 * its item, and a window keeps nothing for a run it is not showing. A
 * run's drafts are let go when the run ends (`runs:changed`), not when a
 * component unmounts — React mounts twice in development, and a surface
 * that remounts mid-turn must not lose what it had.
 *
 * Module state rather than React state: the subscription is one per window
 * however many surfaces draw the room.
 */

interface RunDrafts {
  itemId: string;
  drafts: Map<number, LiveDraft>;
  /** Pieces that arrived past the end of this window's copy, waiting for the view's. */
  held: Map<number, { offset: number; text: string; stream: LiveDraft["stream"] }[]>;
}

const runs = new Map<string, RunDrafts>();
const gaps = new Set<string>();
const watched = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;
let subscriptions: (() => void)[] = [];

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function runFor(runId: string, itemId: string): RunDrafts {
  let run = runs.get(runId);
  if (!run) {
    run = { itemId, drafts: new Map(), held: new Map() };
    runs.set(runId, run);
  }
  return run;
}

/** Puts a piece into a draft if it fits; answers whether it did. */
function place(run: RunDrafts, id: number, stream: LiveDraft["stream"], offset: number, text: string): boolean {
  const current = run.drafts.get(id) ?? { id, stream, text: "" };
  if (offset > current.text.length) return false;
  const extended = current.text.slice(0, offset) + text;
  if (extended.length > current.text.length) run.drafts.set(id, { ...current, text: extended });
  else if (!run.drafts.has(id)) run.drafts.set(id, current);
  return true;
}

/** Replays held pieces that now fit, in the order they begin. */
function replay(run: RunDrafts, id: number): void {
  const held = run.held.get(id);
  if (!held) return;
  held.sort((a, b) => a.offset - b.offset);
  const still = held.filter((piece) => !place(run, id, piece.stream, piece.offset, piece.text));
  if (still.length === 0) run.held.delete(id);
  else run.held.set(id, still);
}

/** Applies one pushed piece. Exported for tests; the subscription is the real caller. */
export function applyDelta(push: IpcPushPayload<"runs:delta">): void {
  if (!watched.has(push.itemId)) return;
  const run = runFor(push.runId, push.itemId);
  if (place(run, push.draft.id, push.draft.stream, push.offset, push.text)) {
    replay(run, push.draft.id);
  } else {
    const held = run.held.get(push.draft.id) ?? [];
    held.push({ offset: push.offset, text: push.text, stream: push.draft.stream });
    run.held.set(push.draft.id, held);
    gaps.add(push.runId);
  }
  changed();
}

/**
 * Takes in the view's copy of a run's drafts where it has said more than
 * this window has, and replays anything held for them. Exported for tests;
 * `useLiveDrafts` is the real caller.
 */
export function seed(turn: LiveTurn, itemId: string): void {
  if (turn.drafts.length === 0) return;
  const run = runFor(turn.runId, itemId);
  let moved = false;
  for (const draft of turn.drafts) {
    const mine = run.drafts.get(draft.id);
    if (!mine || mine.text.length < draft.text.length) {
      run.drafts.set(draft.id, draft);
      moved = true;
    }
    if (run.held.has(draft.id)) {
      replay(run, draft.id);
      moved = true;
    }
  }
  if (![...run.held.values()].some((pieces) => pieces.length > 0)) gaps.delete(turn.runId);
  if (moved) changed();
}

/** Forgets a run's drafts — it has ended. */
export function forgetRun(runId: string): void {
  const had = runs.delete(runId);
  const gapped = gaps.delete(runId);
  if (had || gapped) changed();
}

function ensureSubscribed(): void {
  if (subscriptions.length > 0) return;
  subscriptions = [
    bridge().subscribe("runs:delta", applyDelta),
    // A run that has ended is writing nothing, whichever surface drew it.
    bridge().subscribe("runs:changed", (push) => {
      if (push.status !== "running" && push.status !== "queued") forgetRun(push.runId);
    }),
  ];
}

function subscribe(listener: () => void): () => void {
  ensureSubscribed();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Keeps pushes for this conversation while a surface draws it. */
function watch(itemId: string): () => void {
  watched.set(itemId, (watched.get(itemId) ?? 0) + 1);
  return () => {
    const left = (watched.get(itemId) ?? 1) - 1;
    if (left > 0) {
      watched.set(itemId, left);
      return;
    }
    watched.delete(itemId);
    for (const [runId, run] of runs) if (run.itemId === itemId) runs.delete(runId);
  };
}

/**
 * The drafts to draw for a running turn: the view's, each extended by
 * whatever this window has been pushed since, then any this window has
 * that are newer than the view.
 *
 * A draft the view no longer lists and this window still holds has become
 * a step and is not drawn (`lastDraftId` says which are old). `onGap` is
 * called when pieces were missed, so the caller can read the view again.
 */
export function useLiveDrafts(turn: LiveTurn | null | undefined, conversationId: string | null | undefined, onGap: () => void): LiveDraft[] {
  const seen = useSyncExternalStore(subscribe, () => version);
  const runId = turn?.runId ?? null;

  useEffect(() => {
    if (!conversationId) return undefined;
    return watch(conversationId);
  }, [conversationId]);

  // The view's copy goes into the store, so pieces pushed after it extend
  // it rather than reading as a gap.
  useEffect(() => {
    if (turn && conversationId) seed(turn, conversationId);
  }, [turn, conversationId]);

  useEffect(() => {
    if (runId === null || !gaps.has(runId)) return;
    gaps.delete(runId);
    onGap();
  }, [runId, seen, onGap]);

  return useMemo(() => {
    if (!turn) return [];
    void seen;
    const local = runs.get(turn.runId)?.drafts ?? new Map<number, LiveDraft>();
    const listed = turn.drafts.map((draft) => {
      const mine = local.get(draft.id);
      return mine && mine.text.length > draft.text.length ? mine : draft;
    });
    const newer = [...local.values()].filter((draft) => draft.id > turn.lastDraftId && !turn.drafts.some((listedDraft) => listedDraft.id === draft.id) && draft.text !== "");
    return [...listed, ...newer].sort((a, b) => a.id - b.id);
  }, [turn, seen]);
}

/** For tests: back to an empty window. */
export function resetLiveDeltas(): void {
  runs.clear();
  gaps.clear();
  watched.clear();
  for (const unsubscribe of subscriptions) unsubscribe();
  subscriptions = [];
  changed();
}

/** For tests: draws pushes for a conversation without mounting a surface. */
export function watchForTest(itemId: string): () => void {
  return watch(itemId);
}
