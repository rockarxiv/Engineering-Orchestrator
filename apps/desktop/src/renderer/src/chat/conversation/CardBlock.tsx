import type { AssistCardKind, AssistCardView, DiscussionMessage } from "@eo/core";
import { OperationCard, type CardPress } from "./OperationCard";
import { PressBlock } from "./PressBlock";
import { TrialPublishCard } from "./TrialPublishCard";

/**
 * Kinds a block never presses all of at once: a step's own secret or
 * variable, whose button needs a value typed on the card, and the publish
 * card, whose press can stop to ask about coverage first.
 */
const NO_DO_ALL: ReadonlySet<AssistCardKind> = new Set<AssistCardKind>(["stepSecret", "stepVariable", "trialPublish"]);

/**
 * One reply's cards (EO-862) as one block in the conversation (EO-863),
 * paged the way a batch of questions is, each card drawn exactly as it is
 * alone with its own button (`PressBlock`). A reply with one card is that
 * card and nothing more.
 *
 * When every card is of one kind and two or more can be pressed, "do all"
 * presses each in order through its own press, the very call its button
 * makes; a card that fails stays open with its reason and its button.
 */
export function CardBlock({ message, conversationId, onDone }: { message: DiscussionMessage; conversationId: string; onDone: () => void }) {
  const cards = message.cards ?? [];
  const kind = cards[0]?.kind;
  const sameKind = kind !== undefined && !NO_DO_ALL.has(kind) && cards.every((card) => card.kind === kind);
  const pages = cards.map((card) => ({ key: String(card.index), open: message.canApprove && card.outcome === null, done: card.outcome?.done === true }));
  return (
    <PressBlock label="Cards from the assistant" noun="card" pages={pages} doAll={sameKind}>
      {(position, controls) => (
        <OneCard message={message} card={cards[position]!} conversationId={conversationId} onDone={onDone} {...(controls ?? {})} />
      )}
    </PressBlock>
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
