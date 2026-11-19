import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistCardKind, AssistCardView, DiscussionMessage } from "@eo/core";
import { Button } from "../kit";
import { OperationCard, type CardPress } from "./OperationCard";
import { Pager, pageByArrow } from "./Pager";
import { TrialPublishCard } from "./TrialPublishCard";

/**
 * Kinds a block never presses all of at once: a step's own secret or
 * variable, whose button needs a value typed on the card, and the publish
 * card, whose press can stop to ask about coverage first.
 */
const NO_DO_ALL: ReadonlySet<AssistCardKind> = new Set<AssistCardKind>(["stepSecret", "stepVariable", "trialPublish"]);

/**
 * One reply's cards (EO-862) as one block in the conversation (EO-863),
 * paged the way a batch of questions is: Previous/Next and "N of M", the
 * arrow keys while the block has focus, one card on show at a time and
 * drawn exactly as it is alone, with its own button. A reply with one card
 * is that card and nothing more.
 *
 * Every card stays mounted and only the one on show is visible, so each
 * keeps what the person chose on it and its own press. Pressing one moves
 * the block on to the next card still open.
 *
 * When every card is of one kind and two or more can be pressed, "do all"
 * presses each in order through its own press, the very call its button
 * makes. Each files its own outcome; one that fails stays open with its
 * reason and its button, and the rest go ahead. Then the block says what
 * came of it and shows the first that failed.
 */
export function CardBlock({ message, conversationId, onDone }: { message: DiscussionMessage; conversationId: string; onDone: () => void }) {
  const cards = message.cards ?? [];
  const [page, setPage] = useState(0);
  const [running, setRunning] = useState<{ verb: string; count: number } | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  /** Each card's own press while its button could be pressed, by the card's index. */
  const [presses, setPresses] = useState<Record<number, CardPress | null>>({});
  const runningNow = useRef(false);

  const isOpen = (card: AssistCardView) => message.canApprove && card.outcome === null;
  const shown = Math.min(page, Math.max(cards.length - 1, 0));

  // Pressed on its own — here or in another window — the card on show
  // moves the block on to the next card still open. "Do all" moves it itself.
  const outcomes = useRef(new Map(cards.map((card) => [card.index, card.outcome])));
  useEffect(() => {
    const before = outcomes.current;
    outcomes.current = new Map(cards.map((card) => [card.index, card.outcome]));
    if (runningNow.current) return;
    const current = cards[shown];
    if (current === undefined || current.outcome === null || before.get(current.index) !== null) return;
    setSummary(null);
    const next = nextOpen(cards, shown, isOpen);
    if (next !== null) setPage(next);
  });

  const register = useCallback((index: number, press: CardPress | null) => {
    setPresses((before) => (before[index] === press ? before : { ...before, [index]: press }));
  }, []);

  if (cards.length === 1) return <OneCard message={message} card={cards[0]!} conversationId={conversationId} onDone={onDone} />;

  const kind = cards[0]?.kind;
  const sameKind = kind !== undefined && !NO_DO_ALL.has(kind) && cards.every((card) => card.kind === kind);
  const ready = sameKind ? cards.filter((card) => isOpen(card) && presses[card.index]) : [];
  const verbs = new Set(ready.map((card) => presses[card.index]!.verb));
  const doAll = running ?? (ready.length >= 2 ? { verb: verbs.size === 1 ? [...verbs][0]! : "Do", count: ready.length } : null);
  const done = cards.filter((card) => card.outcome?.done === true).length;

  const pressAll = async () => {
    const queue = ready.map((card) => ({ position: cards.indexOf(card), press: presses[card.index]! }));
    runningNow.current = true;
    setRunning({ verb: doAll!.verb, count: queue.length });
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
      aria-label="Cards from the assistant"
      tabIndex={-1}
      onKeyDown={(event) => {
        // A box being typed in, or a choice the arrows already moved, keeps its keys.
        if (event.defaultPrevented || running !== null) return;
        const target = event.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        pageByArrow(event, shown, cards.length, setPage);
      }}
      className="flex flex-col gap-2 focus:outline-none"
    >
      <div className="flex items-center gap-2 text-[11.5px] text-ink-subtle">
        {doAll !== null ? (
          <Button size="sm" disabled={running !== null} onClick={() => void pressAll()}>
            {doAll.verb} all ({doAll.count})
          </Button>
        ) : null}
        <span aria-live="polite">{summary ?? `${done} of ${cards.length} done`}</span>
        <div className="-mr-1.5 ml-auto flex shrink-0 items-center gap-0.5">
          <Pager noun="card" index={shown} count={cards.length} disabled={running !== null} onChange={setPage} />
        </div>
      </div>
      {cards.map((card, position) => (
        <div key={card.index} hidden={position !== shown}>
          <OneCard
            message={message}
            card={card}
            conversationId={conversationId}
            onDone={onDone}
            disabled={running !== null}
            onPress={(press) => register(card.index, press)}
          />
        </div>
      ))}
    </div>
  );
}

/** One card, as it is drawn alone. */
function OneCard({
  message,
  card,
  conversationId,
  onDone,
  disabled,
  onPress,
}: {
  message: DiscussionMessage;
  card: AssistCardView;
  conversationId: string;
  onDone: () => void;
  disabled?: boolean;
  onPress?: (press: CardPress | null) => void;
}) {
  // The publish card after a draft's trials (EO-588): its own card, with the graph and the module rows.
  if (card.kind === "trialPublish") return <TrialPublishCard message={message} card={card} conversationId={conversationId} onDone={onDone} />;
  return (
    <OperationCard
      message={message}
      card={card}
      conversationId={conversationId}
      onDone={onDone}
      {...(disabled === undefined ? {} : { disabled })}
      {...(onPress === undefined ? {} : { onPress })}
    />
  );
}

/** The next card after `from` still open, wrapping round, or null when none is. */
function nextOpen(cards: readonly AssistCardView[], from: number, isOpen: (card: AssistCardView) => boolean): number | null {
  for (let step = 1; step < cards.length; step++) {
    const position = (from + step) % cards.length;
    if (isOpen(cards[position]!)) return position;
  }
  return null;
}
