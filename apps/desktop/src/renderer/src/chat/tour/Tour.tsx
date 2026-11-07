import type { IpcResponse } from "@eo/core";
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { machineAvailable } from "../../ipc/bridge";
import { ipcQuery } from "../../query/client";
import { pipelinesKey, projectsKey, tourKey, useChromeVocabulary } from "../../query/hooks";
import { useInvalidateOnPush } from "../../query/useInvalidateOnPush";
import { Button } from "../kit";
import type { ChatView } from "../views/registry";
import { TOUR_START, TOUR_STOPS, countOf, isLast, next, screensOf, shownStops, skipMissing, stopsFor, type TourPosition, type TourStop } from "./stops";

/**
 * The first-board tour (EO-667, ARCHITECTURE.md, "What a person sees
 * first"): one part of the window at a time, highlighted, with a callout
 * saying what it is for.
 *
 * Starts on its own the first time a board is shown after first run was
 * left — the main process says when that is (`firstRun:tourState`) — and
 * never while first run is on screen, because `FirstRunGate` does not
 * draw the frame this sits in until then. Finishing or skipping is
 * recorded there too, so a relaunch does not show it again. Settings'
 * "Show the tour" replays it from the first stop (`useShowTour`).
 *
 * The tour goes to each screen it points at and back to the board at the
 * end. **Before it shows anything it surveys them**: behind a cover, it
 * visits each screen once and looks for every stop's element there. A
 * stop whose element is not on screen within `wait` is left out, so the
 * first callout already counts only the stops that will be shown, and
 * the last of those is the one whose button reads Done. An element that
 * goes away between the survey and its stop is passed over then.
 */

/** What Settings presses to replay the tour; null where no tour is drawn (the canvas's own window). */
const TourContext = createContext<(() => void) | null>(null);

export function useShowTour(): (() => void) | null {
  return useContext(TourContext);
}

/** How long a stop waits for its element — a screen being navigated to, its data loading — before it is passed over. */
const ANCHOR_WAIT_MS = 3000;

type Run =
  /** Looking at screen `screen` of `screensOf(stops)`, with what earlier screens lacked. */
  | { phase: "survey"; board: string | null; screen: number; missing: string[] }
  /** Showing `shown`, the stops the survey found, at `position`. */
  | { phase: "show"; board: string | null; shown: TourStop[]; position: TourPosition };

/** An element that is on screen: there, and not inside a hidden one — the conversation folded beside Settings. */
function anchorOf(stop: TourStop): HTMLElement | null {
  const element = document.querySelector<HTMLElement>(`[data-tour="${stop.anchor}"]`);
  return element !== null && element.closest("[hidden]") === null ? element : null;
}

/** Each frame where there are frames; a short wait where there are not (a test's document). Returns the cancel. */
function everyFrame(tick: () => boolean): () => void {
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const step = () => {
    if (!tick()) return;
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(step);
    else timer = setTimeout(step, 50);
  };
  step();
  return () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
  };
}

export function TourHost({ view, children, wait = ANCHOR_WAIT_MS }: { view: ChatView | null; children: ReactNode; wait?: number }) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const here = `${pathname}${search}`;
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: tourKey, queryFn: () => ipcQuery("firstRun:tourState", undefined) });
  // `firstRun:finish` pushes this, and is what makes the tour due.
  useInvalidateOnPush("config:changed", tourKey);
  const seen = useMutation({
    mutationFn: () => ipcQuery("firstRun:tourSeen", undefined),
    onSuccess: (answer) => queryClient.setQueryData(tourKey, answer),
  });

  const vocabulary = useChromeVocabulary();
  const words = useMemo(() => ({ item: vocabulary.item.toLowerCase(), items: vocabulary.items.toLowerCase() }), [vocabulary]);
  const stops = useMemo(() => stopsFor(TOUR_STOPS, machineAvailable()), []);

  // The board a replay starts on: the last one shown.
  const lastBoard = useRef<string | null>(null);
  useEffect(() => {
    if (view?.kind === "board") lastBoard.current = here;
  }, [view?.kind, here]);

  const [run, setRun] = useState<Run | null>(null);
  /** Started this session, on its own or replayed: it never starts itself a second time. */
  const started = useRef(false);

  useEffect(() => {
    if (run !== null || started.current || state.data?.due !== true || view?.kind !== "board") return;
    started.current = true;
    setRun({ phase: "survey", board: here, screen: 0, missing: [] });
  }, [run, state.data?.due, view?.kind, here]);

  const replay = useCallback(() => {
    started.current = true;
    setRun({ phase: "survey", board: lastBoard.current ?? firstBoard(queryClient), screen: 0, missing: [] });
  }, [queryClient]);

  const end = useCallback(() => {
    if (run === null) return;
    setRun(null);
    queryClient.setQueryData(tourKey, { due: false });
    seen.mutate();
    if (run.board !== null) void navigate(run.board);
  }, [run, navigate, queryClient, seen]);

  const goOn = useCallback(
    (step: (shown: readonly TourStop[], position: TourPosition) => TourPosition | null) => {
      if (run === null || run.phase !== "show") return;
      const after = step(run.shown, run.position);
      if (after === null) end();
      else setRun({ ...run, position: after });
    },
    [run, end],
  );

  const screens = useMemo(() => screensOf(stops), [stops]);
  const addressOf = (at: TourStop["at"]) => (run === null ? null : at === "board" ? run.board : at);

  // ── The survey: each screen once, every stop's element looked for ──
  const surveyKey = run?.phase === "survey" ? `${run.screen}|${run.board ?? ""}` : null;
  const finishSurvey = useRef(end);
  finishSurvey.current = end;
  useEffect(() => {
    if (run === null || run.phase !== "survey") return;
    const screen = screens[run.screen];
    if (screen === undefined) {
      const shown = shownStops(stops, run.missing);
      if (shown.length === 0) finishSurvey.current();
      else setRun({ phase: "show", board: run.board, shown, position: TOUR_START });
      return;
    }
    const target = addressOf(screen.at);
    if (target !== null && target !== here) void navigate(target);
    const deadline = Date.now() + wait;
    return everyFrame(() => {
      const absent = screen.stops.filter((stop) => anchorOf(stop) === null).map((stop) => stop.id);
      if (absent.length > 0 && Date.now() < deadline) return true;
      setRun((current) =>
        current !== null && current.phase === "survey" && current.screen === run.screen
          ? { ...current, screen: current.screen + 1, missing: [...current.missing, ...absent] }
          : current,
      );
      return false;
    });
    // Only on reaching a screen: the address is this effect's own to move.
  }, [surveyKey]);

  // ── Showing: each stop takes the window to its screen, once, as it is reached ──
  const stop = run?.phase === "show" ? (run.shown[run.position.index] ?? null) : null;
  const stopKey = run?.phase === "show" ? `${run.position.index}|${run.board ?? ""}` : null;
  useEffect(() => {
    const target = stop === null ? null : addressOf(stop.at);
    if (target !== null && target !== here) void navigate(target);
    // Only on reaching a stop: the address moving afterwards is the person's, or this.
  }, [stopKey]);

  const rect = useAnchor(stop, stopKey, wait, () => goOn(skipMissing));

  return (
    <TourContext.Provider value={replay}>
      {children}
      {run?.phase === "survey" ? <SurveyCover onSkip={end} /> : null}
      {run?.phase === "show" && stop !== null ? (
        <TourOverlay
          stop={stop}
          rect={rect}
          count={countOf(run.shown, run.position)}
          last={isLast(run.shown, run.position)}
          text={stop.text(words)}
          onNext={() => goOn(next)}
          onSkip={end}
        />
      ) : null}
    </TourContext.Provider>
  );
}

/**
 * What the window shows while the tour looks at the screens it will visit:
 * a cover, so the screens going by are not mistaken for the tour, and
 * Escape to skip it.
 */
function SurveyCover({ onSkip }: { onSkip: () => void }) {
  const skip = useRef(onSkip);
  skip.current = onSkip;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      skip.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] grid place-items-center bg-canvas">
      <p role="status" className="text-[13px] text-ink-subtle">
        Getting the tour ready…
      </p>
    </div>,
    document.body,
  );
}

/**
 * With no board shown yet this session, the active project's first
 * pipeline — read from what the rail has already asked, rather than
 * asking again from here.
 */
function firstBoard(queryClient: QueryClient): string | null {
  const projects = queryClient.getQueryData<IpcResponse<"projects:list">>(projectsKey);
  const pipelines = queryClient.getQueryData<IpcResponse<"pipelines:list">>(pipelinesKey(projects?.activeProjectId ?? null));
  const first = pipelines?.pipelines[0]?.id;
  return first === undefined ? null : `/pipelines/${encodeURIComponent(first)}`;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Where the stop's element is, followed frame by frame so the highlight
 * stays on it as the window lays out; `onMissing` once it has not
 * appeared within `wait`.
 */
function useAnchor(stop: TourStop | null, stopKey: string | null, wait: number, onMissing: () => void): Box | null {
  // Kept with the stop it was measured for, so a new stop is never drawn against the last one's element.
  const [measured, setMeasured] = useState<{ stopKey: string; box: Box } | null>(null);
  const missing = useRef(onMissing);
  missing.current = onMissing;

  useEffect(() => {
    if (stop === null || stopKey === null) return;
    const deadline = Date.now() + wait;
    let found = false;
    let last = "";
    return everyFrame(() => {
      const element = anchorOf(stop);
      if (element !== null) {
        if (!found) {
          found = true;
          element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        }
        const { top, left, width, height } = element.getBoundingClientRect();
        const key = `${top}|${left}|${width}|${height}`;
        if (key !== last) {
          last = key;
          setMeasured({ stopKey, box: { top, left, width, height } });
        }
      } else if (!found && Date.now() >= deadline) {
        missing.current();
        return false;
      }
      return true;
    });
  }, [stopKey]);

  return measured !== null && measured.stopKey === stopKey ? measured.box : null;
}

const CALLOUT_WIDTH = 320;
const GAP = 12;
const MARGIN = 12;

/** Beside the element where there is room — right, left, below, above — and over its corner where there is none. */
export function placeCallout(anchor: Box, viewport: { width: number; height: number }, height: number): { top: number; left: number } {
  const width = CALLOUT_WIDTH;
  const clampTop = (top: number) => Math.max(MARGIN, Math.min(top, viewport.height - height - MARGIN));
  const clampLeft = (left: number) => Math.max(MARGIN, Math.min(left, viewport.width - width - MARGIN));
  const right = anchor.left + anchor.width;
  const bottom = anchor.top + anchor.height;
  if (viewport.width - right >= width + GAP + MARGIN) return { top: clampTop(anchor.top), left: right + GAP };
  if (anchor.left >= width + GAP + MARGIN) return { top: clampTop(anchor.top), left: anchor.left - GAP - width };
  if (viewport.height - bottom >= height + GAP + MARGIN) return { top: bottom + GAP, left: clampLeft(anchor.left) };
  if (anchor.top >= height + GAP + MARGIN) return { top: anchor.top - GAP - height, left: clampLeft(anchor.left) };
  return { top: clampTop(bottom - height - 2 * GAP), left: clampLeft(right - width - 2 * GAP) };
}

function TourOverlay({
  stop,
  rect,
  count,
  last,
  text,
  onNext,
  onSkip,
}: {
  stop: TourStop;
  rect: Box | null;
  count: { n: number; m: number };
  last: boolean;
  text: string;
  onNext: () => void;
  onSkip: () => void;
}) {
  const id = useId();
  const callout = useRef<HTMLDivElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const [height, setHeight] = useState(180);
  const shown = rect !== null;

  useLayoutEffect(() => {
    if (callout.current && callout.current.offsetHeight > 0) setHeight(callout.current.offsetHeight);
  });
  // Focus moves into the callout at every stop.
  useEffect(() => {
    if (shown) nextButton.current?.focus();
  }, [shown, stop.id]);

  // Escape skips and Right Arrow goes on wherever focus is; Enter goes on
  // unless it is on a button, which answers for itself.
  const keys = useRef({ onNext, onSkip });
  keys.current = { onNext, onSkip };
  useEffect(() => {
    if (!shown) return;
    const onKey = (event: KeyboardEvent) => {
      const onButton = event.target instanceof HTMLElement && event.target.closest("button") !== null;
      if (event.key === "Escape") keys.current.onSkip();
      else if (event.key === "ArrowRight" || (event.key === "Enter" && !onButton)) keys.current.onNext();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [shown]);

  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const place = rect === null ? null : placeCallout(rect, viewport, height);
  const PAD = 4;

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)]">
      {/* Holds the window still while the tour is on: a press behind it is not a step of it. */}
      <div aria-hidden className="absolute inset-0" />
      {rect !== null ? (
        <div
          aria-hidden
          data-testid="tour-highlight"
          className="pointer-events-none absolute rounded-[12px] outline-2 outline-solid outline-accent"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + 2 * PAD,
            height: rect.height + 2 * PAD,
            boxShadow: "0 0 0 9999px var(--color-scrim)",
          }}
        />
      ) : null}
      {place !== null ? (
        <div
          ref={callout}
          role="dialog"
          aria-label="Tour"
          aria-describedby={`${id}-title ${id}-text`}
          className="absolute flex flex-col gap-2 rounded-[14px] bg-canvas-subtle p-4 text-ink shadow-panel"
          style={{ top: place.top, left: place.left, width: CALLOUT_WIDTH }}
        >
          <h2 id={`${id}-title`} className="text-[14px] font-semibold">
            {stop.title}
          </h2>
          <p id={`${id}-text`} className="text-[12.5px] leading-relaxed text-ink-muted">
            {text}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <span className="flex-1 text-[12px] tabular-nums text-ink-subtle">{`${count.n} of ${count.m}`}</span>
            <Button variant="ghost" size="sm" onClick={onSkip}>
              Skip tour
            </Button>
            <Button ref={nextButton} variant="primary" size="sm" onClick={onNext}>
              {last ? "Done" : "Next"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
