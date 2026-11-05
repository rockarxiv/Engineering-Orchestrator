import type { TranscriptEventView } from "./useTranscript";

/**
 * A transcript row: either one event, or a run of machine activity folded
 * behind a single line.
 *
 * A transcript is two things interleaved — what the agent *said*, and what
 * it *did*. Rendered flat they compete, and the doing wins on volume: a
 * turn that edits four files and calls six tools buries the one sentence
 * explaining why. Folding the activity leaves the narration as the spine
 * you can actually read down, with the detail one click away.
 */
export type TranscriptItem =
  | { kind: "event"; key: string; event: TranscriptEventView }
  | { kind: "activity"; key: string; events: TranscriptEventView[]; summary: string };

/**
 * An event's identity across the whole conversation.
 *
 * `seq` alone is not it. Sequence numbers are allocated per run and every
 * run starts at 0, so a group with two turns — the normal shape after an
 * escalation and a reply — contains seq 0 twice. Keying on it produced
 * duplicate React keys, and React responds by dropping children: the
 * second turn's events silently vanished from the transcript, and
 * expanding one folded block toggled another.
 */
export function eventKey(event: TranscriptEventView): string {
  return `${event.runId}:${event.seq}`;
}

/**
 * Event types that fold.
 *
 * Deliberately a small, closed list. `output`, `error` and `wind_down`
 * never fold — they are the narration and the things that went wrong, and
 * a transcript that hides a failure behind a chevron is worse than one
 * that is merely noisy. An unrecognised type never folds either: `type` is
 * an open string (D-02), and the whole reason unknown events render their
 * payload is that you are usually looking at them while debugging the
 * thing that produced them.
 *
 * `search_interception` is absent for the first reason rather than the
 * last (EO-168). It is EO speaking into somebody else's run, and folding
 * it in with the tool calls it sits between would put it back where it
 * started — happening, and invisible to whoever is watching.
 *
 * `human_message` is absent for the same reason, one step stronger
 * (EO-176): that is a *person* speaking into a run, at the point they
 * said it, and it is very often the most important line on the screen.
 */
const FOLDABLE = new Set(["tool_call", "tool_result", "file_edit", "result", "usage", "thread_started"]);

/**
 * Below this, folding costs more than it saves — a chevron hiding a single
 * tool call is a click in exchange for nothing.
 */
const MIN_RUN = 2;

function field(payload: unknown, key: string): unknown {
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)[key] : undefined;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * What the folded line says.
 *
 * Counts only what a person would scan for. `usage` and `thread_started`
 * fold but are not named — a line reading "4 tool calls, 2 token counts"
 * spends its width on the half nobody came for.
 *
 * Files are counted distinct rather than per-event: three edits to
 * `Messages.tsx` is one file touched three times, and saying "3 files
 * edited" when there is one file would be a small lie in the direction of
 * looking busier.
 *
 * `tool_result` folds but is not named either, and for the same reason
 * as files (EO-169): a result is the answer to a call already counted,
 * so counting both would say "12 tool calls, 12 results" about six
 * greps. It is the calls a person scans for, and the results are what
 * they open the fold to read.
 */
export function summarise(events: readonly TranscriptEventView[]): string {
  let toolCalls = 0;
  let results = 0;
  const paths = new Set<string>();

  for (const event of events) {
    if (event.type === "tool_call") toolCalls += 1;
    else if (event.type === "result") results += 1;
    else if (event.type === "file_edit") {
      const path = field(event.payload, "path");
      paths.add(typeof path === "string" ? path : `?${eventKey(event)}`);
    }
  }

  const parts: string[] = [];
  if (toolCalls > 0) parts.push(plural(toolCalls, "tool call", "tool calls"));
  if (paths.size > 0) parts.push(`${plural(paths.size, "file", "files")} edited`);
  if (results > 0) parts.push(plural(results, "result", "results"));

  // Only `usage` / `thread_started` in the run — nothing worth naming, but
  // the row still has to say how much it is hiding.
  if (parts.length === 0) return plural(events.length, "event", "events");

  return parts.join(", ");
}

/**
 * Fold consecutive machine activity, leave everything else standing.
 *
 * Order is never changed and nothing is dropped: every event in, every
 * event out, in the same sequence. The only question a fold answers is
 * whether you have to look at it right now.
 */
export function groupTranscriptEvents(events: readonly TranscriptEventView[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let run: TranscriptEventView[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    // A run too short to be worth folding goes back to being loose events.
    if (run.length < MIN_RUN) {
      for (const event of run) items.push({ kind: "event", key: `e${eventKey(event)}`, event });
    } else {
      items.push({ kind: "activity", key: `a${eventKey(run[0]!)}`, events: run, summary: summarise(run) });
    }
    run = [];
  };

  for (const event of events) {
    if (FOLDABLE.has(event.type)) {
      run.push(event);
      continue;
    }
    flush();
    items.push({ kind: "event", key: `e${eventKey(event)}`, event });
  }
  flush();

  return items;
}
