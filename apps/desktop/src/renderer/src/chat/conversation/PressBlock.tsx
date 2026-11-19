import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../kit";
import type { CardPress } from "./OperationCard";
import { Pager, pageByArrow } from "./Pager";

/** One page of a block: a card, or a work proposal. */
export interface PressPage {
  /** Stable for the page's life: a card's index, a proposal's message id. */
  key: string;
  /** Its own button could be pressed now. */
  open: boolean;
  /** Pressed, and it ended done. */
  done: boolean;
}

/** What a page is handed inside a block of several: held still, and asked for its own press. */
export interface PageControls {
  disabled: boolean;
  onPress: (press: CardPress | null) => void;
}

/**
 * One reply's things to press as one block in the conversation (EO-863):
 * a reply's action cards (`CardBlock`) and a reply's work proposals
 * (`ProposalBlock`, EO-864). Paged the way a batch of questions is:
 * Previous/Next and "N of M", the arrow keys while the block has focus,
 * one page on show at a time and drawn exactly as it is alone, with its
 * own button. A block of one page is that page and nothing more.
 *
 * Every page stays mounted and only the one on show is visible, so each
 * keeps what the person chose on it and its own press. Pressing one moves
 * the block on to the next page still open.
 *
 * With `doAll` and two or more pages open, "… all" presses each in order
 * through its own press, the very call its button makes. Each files its
 * own outcome; one that fails stays as its press left it, with its
 * reason, and the rest go ahead. Then the block says what came of it and
 * shows the first that failed. It waits for any page pressed on its own
 * to land first, so nothing is pressed twice at once.
 */
export function PressBlock({
  label,
  noun,
  pages,
  doAll,
  children,
}: {
  /** The block's accessible name: "Cards from the assistant". */
  label: string;
  /** A page in the chevrons' labels: "Next card". */
  noun: string;
  pages: readonly PressPage[];
  /** Whether "… all" may be offered at all; it still needs two pages open. */
  doAll: boolean;
  /** The page at `position`, with the block's controls — null for a block of one, drawn as it is alone. */
  children: (position: number, controls: PageControls | null) => ReactNode;
}) {
  const [page, setPage] = useState(0);
  const [running, setRunning] = useState<{ verb: string; count: number } | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  /** Each page's own press while its button could be pressed, by the page's key. */
  const [presses, setPresses] = useState<Record<string, CardPress | null>>({});
  const runningNow = useRef(false);

  const shown = Math.min(page, Math.max(pages.length - 1, 0));

  // Pressed on its own — here or in another window — the page on show
  // moves the block on to the next page still open. "Do all" moves it itself.
  const wasOpen = useRef(new Map(pages.map((each) => [each.key, each.open])));
  useEffect(() => {
    const before = wasOpen.current;
    wasOpen.current = new Map(pages.map((each) => [each.key, each.open]));
    if (runningNow.current) return;
    const current = pages[shown];
    if (current === undefined || current.open || before.get(current.key) !== true) return;
    setSummary(null);
    const next = nextOpen(pages, shown);
    if (next !== null) setPage(next);
  });

  const register = useCallback((key: string, press: CardPress | null) => {
    setPresses((before) => (before[key] === press ? before : { ...before, [key]: press }));
  }, []);

  if (pages.length === 1) return <>{children(0, null)}</>;

  const ready = doAll ? pages.filter((each) => each.open && presses[each.key]) : [];
  const verbs = new Set(ready.map((each) => presses[each.key]!.verb));
  const all = running ?? (ready.length >= 2 ? { verb: verbs.size === 1 ? [...verbs][0]! : "Do", count: ready.length } : null);
  const done = pages.filter((each) => each.done).length;
  // A page pressed on its own and not back yet: no batch starts over it.
  const inFlight = pages.some((each) => presses[each.key]?.pending === true);

  const pressAll = async () => {
    if (runningNow.current || inFlight) return;
    const queue = ready.map((each) => ({ position: pages.indexOf(each), press: presses[each.key]! }));
    runningNow.current = true;
    setRunning({ verb: all!.verb, count: queue.length });
    setSummary(null);
    const failed: number[] = [];
    for (const { position, press } of queue) {
      setPage(position);
      if (!(await press.press())) failed.push(position);
    }
    runningNow.current = false;
    setRunning(null);
    const succeeded = queue.length - failed.length;
    setSummary(failed.length === 0 ? `${succeeded} done` : `${succeeded} done, ${failed.length} failed`);
    if (failed.length > 0) setPage(failed[0]!);
  };

  return (
    <div
      role="group"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={(event) => {
        // A box being typed in, or a choice the arrows already moved, keeps its keys.
        if (event.defaultPrevented || running !== null) return;
        const target = event.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        pageByArrow(event, shown, pages.length, setPage);
      }}
      className="flex flex-col gap-2 focus:outline-none"
    >
      <div className="flex items-center gap-2 text-[11.5px] text-ink-subtle">
        {all !== null ? (
          <Button size="sm" disabled={running !== null || inFlight} onClick={() => void pressAll()}>
            {all.verb} all ({all.count})
          </Button>
        ) : null}
        <span aria-live="polite">{summary ?? `${done} of ${pages.length} done`}</span>
        <div className="-mr-1.5 ml-auto flex shrink-0 items-center gap-0.5">
          <Pager noun={noun} index={shown} count={pages.length} disabled={running !== null} onChange={setPage} />
        </div>
      </div>
      {pages.map((each, position) => (
        <div key={each.key} hidden={position !== shown}>
          {children(position, { disabled: running !== null, onPress: (press) => register(each.key, press) })}
        </div>
      ))}
    </div>
  );
}

/** The next page after `from` still open, wrapping round, or null when none is. */
function nextOpen(pages: readonly PressPage[], from: number): number | null {
  for (let step = 1; step < pages.length; step++) {
    const position = (from + step) % pages.length;
    if (pages[position]!.open) return position;
  }
  return null;
}
