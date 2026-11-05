import { answerOptions, type DiscussionMessage } from "@eo/core";

/** One question the product owner asked, with whatever has been filed under it. */
export interface AskedQuestion {
  id: string;
  /** The question and its `why`, as markdown — exactly what the thread holds. */
  body: string;
  options: string[];
  /** The answer already given, or null while it is still being asked. */
  answer: string | null;
}

/** One turn's worth of questions: everything a single run put to the person at once. */
export interface QuestionBatch {
  /**
   * The run that asked them — and the question's own id when it carries
   * no run, so an unattributable question stands alone rather than
   * pooling with every other one.
   */
  id: string;
  questions: AskedQuestion[];
}

/**
 * The questions in a transcript, batched by the turn that asked them.
 *
 * Beside the card rather than in the panels that draw it, because both
 * panels that draw one fold the message list the same way — and
 * `canAnswer` is the only thing either list turns on. That flag is
 * decided in the main process (`answerableQuestionIds`), so this is a
 * projection of a decision rather than a copy of one; what it is worth
 * keeping in one place is the *grouping*, since a panel that split a
 * batch differently would offer half a card.
 *
 * `live` stays flat because it is at most one batch: the main process
 * scopes it to the newest run. `closed` is the part that has to be
 * grouped (EO-338). It used to be one flat list, which meant every
 * question a thread ever held rendered as a single card — three from one
 * turn and two from the next read as one five-row block, and in the
 * assist room, whose thread never rotates (EO-193), the block grew
 * across every unrelated topic until somebody pressed Clear.
 *
 * Discussions folds its own rows instead, and not out of neglect: it
 * virtualizes, so its questions have to be interleaved with the
 * messages around them in one flat list (`buildRows`) rather than
 * collected into two.
 */
export function questionsFrom(messages: DiscussionMessage[]): { live: AskedQuestion[]; closed: QuestionBatch[] } {
  const answers = new Map<string, string>();
  for (const message of messages) {
    if (message.authorType === "human" && message.parentId) answers.set(message.parentId, message.body);
  }

  const live: AskedQuestion[] = [];
  const closed: QuestionBatch[] = [];
  const byRun = new Map<string, QuestionBatch>();
  for (const message of messages) {
    if (message.kind !== "question" || message.authorType !== "agent") continue;
    const asked: AskedQuestion = {
      id: message.id,
      body: message.body,
      options: answerOptions(message.options),
      answer: answers.get(message.id) ?? null,
    };
    if (message.canAnswer) {
      live.push(asked);
      continue;
    }
    const key = message.runId ?? message.id;
    let batch = byRun.get(key);
    if (!batch) {
      // Pushed on first sight, so the batches come back in the order
      // they were asked — the transcript arrives sorted by time.
      batch = { id: key, questions: [] };
      byRun.set(key, batch);
      closed.push(batch);
    }
    batch.questions.push(asked);
  }
  return { live, closed };
}

/** One entry in a transcript as a panel draws it: a message, or a whole batch of questions. */
export type TranscriptRow =
  | { kind: "message"; message: DiscussionMessage }
  | { kind: "questions"; batch: QuestionBatch; live: boolean };

/**
 * The transcript in the order it happened, with each batch of questions
 * standing where it was asked (EO-362).
 *
 * `questionsFrom` decides what a batch is; this decides where it goes —
 * at the position of its first question message, so the card sits after
 * whatever preceded it and before anything said afterwards. The panels
 * used to skip every question in the message list and draw the cards
 * after it, which stacked every answered batch at the bottom of the
 * thread in ask-order and pushed the newest reply above them, out of
 * sight of a panel that scrolls to the end. One helper rather than the
 * placement repeated in each panel, so the grouping and the ordering
 * cannot drift apart.
 *
 * The live batch is keyed on its first question's id rather than its
 * run: the card holds which question it is showing, and a new batch has
 * to be a new instance. Question messages that belong to no batch — one
 * a person wrote — are dropped here exactly as `questionsFrom` drops
 * them, which is what the panels did before.
 */
export function transcriptRows(messages: DiscussionMessage[]): TranscriptRow[] {
  const { live, closed } = questionsFrom(messages);
  const startsAt = new Map<string, TranscriptRow>();
  for (const batch of closed) {
    const first = batch.questions[0];
    if (first) startsAt.set(first.id, { kind: "questions", batch, live: false });
  }
  const firstLive = live[0];
  if (firstLive) startsAt.set(firstLive.id, { kind: "questions", batch: { id: firstLive.id, questions: live }, live: true });

  const rows: TranscriptRow[] = [];
  for (const message of messages) {
    if (message.kind !== "question") {
      rows.push({ kind: "message", message });
      continue;
    }
    const row = startsAt.get(message.id);
    if (row) rows.push(row);
  }
  return rows;
}

export interface QuestionCardProps {
  questions: AskedQuestion[];
  /** True while the batch can still be answered. False renders the record of what was picked. */
  live: boolean;
  busy: boolean;
  onSubmit: (answers: { questionId: string; answer: string | null }[]) => Promise<unknown>;
}
