import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunEventView } from "@eo/core";
import { bridge } from "../../ipc/bridge";
import { ipcQuery } from "../../query/client";

const PAGE_SIZE = 500;

/**
 * An event, plus the run it came from.
 *
 * `run_events.seq` is allocated per run and every run starts at 0, so a
 * group's concatenated log contains the same seq once per turn. Anything
 * that needs to identify an event across the whole conversation — a React
 * key, most of all — has to carry the run too.
 */
export type TranscriptEventView = RunEventView & { runId: string };

export interface TranscriptState {
  events: TranscriptEventView[];
  loading: boolean;
  error: Error | null;
}

/** Joined into one dependency, so a fresh array of the same ids is not a change. */
const SEPARATOR = " ";

/**
 * A conversation's event log, paged forward and kept live.
 *
 * Takes every run in the group, oldest first, and reads as one log: a
 * resumed run is the same conversation continued (see `groupRuns`), and
 * showing only its latest row would hide everything said before the
 * human replied.
 *
 * Deliberately not a TanStack query: this is an append-only cursor over
 * a growing log, not a value that gets refetched. Re-running a query
 * would re-fetch thousands of events to learn about the twenty new ones.
 *
 * The push signal only says "there is more" — the events themselves come
 * from `run_events`, the durable substrate. That is what makes the tail
 * lossless: a coalesced or dropped signal costs latency, never an event,
 * because the next fetch resumes from the cursor regardless.
 *
 * Fetches are serialised per run through `inFlight`. A chatty agent
 * produces signals faster than a round-trip, and overlapping fetches
 * would interleave pages and duplicate rows.
 *
 * A cursor only sees what lands ahead of it, and a watch's quiet run can
 * gain a line behind it: another device's check, reaching this machine
 * after a later one (EO-618). The log's `total` says when that happened,
 * and the run is then read again and put in place of what was held, which
 * is the only time this re-reads anything.
 */
/** Every page of a run's log from a sequence on, each handed over as it comes. Answers how long the log is. */
async function walk(runId: string, fromSeq: number, onPage: (events: RunEventView[]) => void): Promise<number> {
  for (let next = fromSeq; ; ) {
    const page = await ipcQuery("runs:listEvents", { runId, fromSeq: next, limit: PAGE_SIZE });
    if (page.events.length > 0) onPage(page.events);
    if (page.nextSeq === null) return page.total;
    next = page.nextSeq;
  }
}

export function useTranscript(runIds: readonly string[]): TranscriptState & { refresh: () => void } {
  const key = runIds.join(SEPARATOR);
  // Read by callbacks that must not be rebuilt every render; `key` is
  // what actually says the group changed.
  const idsRef = useRef(runIds);
  idsRef.current = runIds;

  const [pages, setPages] = useState<Record<string, RunEventView[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const cursors = useRef(new Map<string, number>());
  /** How many lines each run has on screen, to hold against the log's `total`. */
  const held = useRef(new Map<string, number>());
  const inFlight = useRef(new Set<string>());
  const pending = useRef(new Set<string>());

  const drain = useCallback(async (runId: string) => {
    if (inFlight.current.has(runId)) {
      // Remember that something arrived while we were busy, so the tail
      // doesn't stall one signal short of the end.
      pending.current.add(runId);
      return;
    }

    inFlight.current.add(runId);
    // Claimed up front rather than on the first page, so a run with no
    // events yet still counts as fetched and isn't re-read from zero
    // every time the group changes.
    if (!cursors.current.has(runId)) cursors.current.set(runId, 0);
    try {
      const total = await walk(runId, cursors.current.get(runId) ?? 0, (events) => {
        setPages((current) => ({ ...current, [runId]: [...(current[runId] ?? []), ...events] }));
        cursors.current.set(runId, events.at(-1)!.seq + 1);
        held.current.set(runId, (held.current.get(runId) ?? 0) + events.length);
      });
      if (total > (held.current.get(runId) ?? 0)) {
        const whole: RunEventView[] = [];
        await walk(runId, 0, (events) => whole.push(...events));
        setPages((current) => ({ ...current, [runId]: whole }));
        cursors.current.set(runId, (whole.at(-1)?.seq ?? -1) + 1);
        held.current.set(runId, whole.length);
      }
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      inFlight.current.delete(runId);
      if (pending.current.delete(runId)) void drain(runId);
    }
  }, []);

  // A different conversation is a different log. A *longer* one is not:
  // when a reply resumes a run, the group gains a turn, and re-reading
  // what is already on screen would blank the transcript mid-run.
  useEffect(() => {
    const ids = idsRef.current;
    const wanted = new Set(ids);
    for (const id of [...cursors.current.keys()]) {
      if (wanted.has(id)) continue;
      cursors.current.delete(id);
      held.current.delete(id);
    }
    setPages((current) => {
      const kept: Record<string, RunEventView[]> = {};
      for (const id of ids) if (current[id]) kept[id] = current[id]!;
      return kept;
    });
    setError(null);

    const fresh = ids.filter((id) => !cursors.current.has(id));
    if (fresh.length === 0) return;

    setLoading(true);
    void Promise.all(fresh.map((id) => drain(id))).finally(() => setLoading(false));
  }, [key, drain]);

  useEffect(() => {
    if (idsRef.current.length === 0) return;
    return bridge().subscribe("runs:progress", (payload) => {
      if (idsRef.current.includes(payload.runId)) void drain(payload.runId);
    });
  }, [key, drain]);

  // Concatenated in group order, so the turns read the way they happened
  // rather than in whichever order their pages came back.
  const events = useMemo(
    () =>
      key === ""
        ? []
        : key.split(SEPARATOR).flatMap((id) => (pages[id] ?? []).map((event) => ({ ...event, runId: id }))),
    [key, pages],
  );

  return { events, loading, error, refresh: () => idsRef.current.forEach((id) => void drain(id)) };
}
