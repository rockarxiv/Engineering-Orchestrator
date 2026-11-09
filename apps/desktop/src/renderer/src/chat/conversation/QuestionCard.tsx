import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, LoaderCircle, Minus, Pencil, X } from "lucide-react";
import { Markdown, cn } from "@eo/ui";
import type { AskedQuestion, QuestionCardProps } from "../../shared/discussions/questions";
import { Button, IconButton } from "../kit";
import { ReferenceText } from "./references";

// The grouping is the thread's, not the drawing's: one helper, so this
// card and the classic one can never batch a transcript differently.
export { questionsFrom, transcriptRows } from "../../shared/discussions/questions";
export type { AskedQuestion, QuestionBatch, QuestionCardProps, TranscriptRow } from "../../shared/discussions/questions";

/** The first line of a question — its heading, without the italic `why` under it. */
function headline(body: string): string {
  return body.split("\n")[0] ?? body;
}

/**
 * A batch of questions from the assistant, as the chat layout draws
 * a card in the conversation: the lit block a drafted pipeline sits in,
 * one question on it at a time, its options as numbered rows that answer
 * with a click.
 *
 * Every behaviour is the classic `assist/QuestionCard`'s. Nothing is
 * sent until the last question is answered, so the set arrives together;
 * the number keys pick and the arrows move, which is why a live card
 * takes focus when it arrives; "Something else" takes an answer no option
 * covers and Escape abandons it; "Skip" passes on this one and the ✕
 * passes on the rest; and a failed send keeps every pick on screen.
 *
 * Closed, the same card is the record: what was asked, what was on offer
 * and what was said — and when nothing was, it says that in its label and
 * its marks as well as in words.
 */
export function QuestionCard({ questions, live, busy, onSubmit }: QuestionCardProps) {
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<Record<string, string | null>>({});
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * Where the answers are: not sent, on their way, or landed and waiting
   * for the conversation that closed the card to be drawn — which the
   * reply already carries, but arrives a moment after it.
   */
  const [phase, setPhase] = useState<"idle" | "sending" | "sent">("idle");
  /** The drawing of the card the answers landed on; a newer one that is still live says the card is open again. */
  const sentFor = useRef<AskedQuestion[] | null>(null);
  const custom = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);

  const current = questions[Math.min(index, questions.length - 1)];

  useEffect(() => {
    if (writing) custom.current?.focus();
  }, [writing]);

  // A live card takes focus when it arrives — which is what makes the
  // number keys work — while the person is reading, not typing.
  useEffect(() => {
    if (live) card.current?.focus();
  }, [live]);

  useEffect(() => {
    if (phase === "sent" && live && sentFor.current !== questions) setPhase("idle");
  }, [phase, live, questions]);

  // Back from a refusal, the card takes focus again, so the number keys
  // answer once more without a click.
  useEffect(() => {
    if (live && phase === "idle" && problem) card.current?.focus();
  }, [live, phase, problem]);

  if (!current) return null;

  // Closed as soon as the last answer is given (EO-549): drawn from the
  // picks, marked as sending, until the conversation that closed it is on
  // screen. A refusal brings the live card back with every pick on it.
  if (!live) return <Answered questions={questions} answers={(question) => question.answer} />;
  if (phase !== "idle") return <Answered questions={questions} answers={(question) => picked[question.id] ?? null} sending={phase === "sending"} />;

  const answeredCount = Object.keys(picked).length;

  const send = async (answers: Record<string, string | null>) => {
    setProblem(null);
    setPhase("sending");
    try {
      await onSubmit(questions.map((question) => ({ questionId: question.id, answer: answers[question.id] ?? null })));
      sentFor.current = questions;
      setPhase("sent");
    } catch (error) {
      // The picks stay: a failed send costs the click, not the decisions.
      setProblem(error instanceof Error ? error.message : String(error));
      setPhase("idle");
    }
  };

  /** Records one answer and moves on; the last one sends the batch, in one round trip. */
  const answer = async (value: string | null) => {
    const next = { ...picked, [current.id]: value };
    setPicked(next);
    setWriting(false);
    setDraft("");

    const remaining = questions.findIndex((question) => !(question.id in next));
    if (remaining !== -1) {
      setIndex(remaining);
      return;
    }
    await send(next);
  };

  /** The ✕: everything still unanswered is a skip, and the batch goes anyway. */
  const skipRest = async () => {
    const next = { ...picked };
    for (const question of questions) if (!(question.id in next)) next[question.id] = null;
    setPicked(next);
    await send(next);
  };

  const disabled = busy;
  const why = current.body.split("\n").slice(1).join("\n");

  return (
    <div
      ref={card}
      role="group"
      aria-label="Questions from the product owner"
      tabIndex={-1}
      // Number keys pick, arrows move between questions.
      onKeyDown={(event) => {
        if (disabled || writing) return;
        const digit = Number(event.key);
        if (Number.isInteger(digit) && digit >= 1 && digit <= current.options.length) {
          event.preventDefault();
          void answer(current.options[digit - 1] ?? null);
          return;
        }
        if (event.key === "ArrowLeft" && index > 0) {
          event.preventDefault();
          setIndex(index - 1);
        }
        if (event.key === "ArrowRight" && index < questions.length - 1) {
          event.preventDefault();
          setIndex(index + 1);
        }
      }}
      className="flex flex-col gap-2.5 rounded-[14px] bg-canvas-subtle px-4 py-3.5 shadow-[inset_0_0_0_1px_var(--color-line-strong)] focus:outline-none"
    >
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-[14px] font-medium leading-snug text-ink">
            <ReferenceText>{headline(current.body)}</ReferenceText>
          </p>
          {/* The `why`: what this blocks, so it is answerable without the agent's context. */}
          <div className="text-[12.5px] leading-relaxed text-ink-subtle">
            <Markdown>{why}</Markdown>
          </div>
        </div>
        <div className="-mr-1.5 -mt-1 flex shrink-0 items-center gap-0.5 text-[11.5px] text-ink-subtle">
          {questions.length > 1 ? (
            <>
              <IconButton
                label="Previous question"
                icon={<ChevronLeft size={14} />}
                disabled={index === 0 || disabled}
                onClick={() => setIndex(index - 1)}
                className="h-[26px] w-[26px] disabled:opacity-30"
              />
              <span aria-live="polite" className="tabular-nums">
                {index + 1} of {questions.length}
              </span>
              <IconButton
                label="Next question"
                icon={<ChevronRight size={14} />}
                disabled={index === questions.length - 1 || disabled}
                onClick={() => setIndex(index + 1)}
                className="h-[26px] w-[26px] disabled:opacity-30"
              />
            </>
          ) : null}
          <IconButton
            label="Skip the rest"
            title="Skip whatever is left and let the product owner decide"
            icon={<X size={14} />}
            disabled={disabled}
            onClick={() => void skipRest()}
            className="ml-0.5 h-[26px] w-[26px] disabled:opacity-30"
          />
        </div>
      </div>

      <ul className="-mx-2 flex flex-col gap-px">
        {current.options.map((option, position) => {
          const chosen = picked[current.id] === option;
          return (
            <li key={option} className="group relative">
              {/* The row is a button laid under its text, so an item key in
                  an option stays a link of its own rather than a nested
                  control. */}
              <button
                type="button"
                aria-label={option}
                disabled={disabled}
                onClick={() => void answer(option)}
                className="absolute inset-0 rounded-[10px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:pointer-events-none"
              />
              <span
                className={cn(
                  "pointer-events-none relative z-10 flex w-full items-center gap-2.5 rounded-[10px] px-2 py-2 text-left text-[13.5px]",
                  chosen ? "bg-accent-subtle text-ink" : "text-ink-muted group-hover:bg-canvas-raised group-hover:text-ink",
                  disabled && "opacity-50",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-[6px] font-mono text-[11px]",
                    chosen ? "bg-accent text-accent-ink" : "bg-canvas text-ink-subtle",
                  )}
                >
                  {chosen ? <Check size={11} /> : position + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <ReferenceText linkClassName="pointer-events-auto">{option}</ReferenceText>
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-2">
        {writing ? (
          <span className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[10px] bg-canvas-raised px-2.5">
            <Pencil size={13} aria-hidden className="shrink-0 text-ink-subtle" />
            <input
              ref={custom}
              aria-label="Answer in your own words"
              placeholder="Type your answer…"
              value={draft}
              disabled={disabled}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && draft.trim() !== "") {
                  event.preventDefault();
                  void answer(draft.trim());
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setWriting(false);
                  setDraft("");
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-subtle focus:outline-none"
            />
          </span>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setWriting(true)}
            className="-ml-2 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[10px] px-2 text-left text-[13px] text-ink-subtle hover:bg-canvas-raised hover:text-ink disabled:opacity-50"
          >
            <Pencil size={13} aria-hidden className="shrink-0" />
            <span>Something else</span>
          </button>
        )}
        {/* This one, and on to the next: the ✕ above is the one that abandons the rest. */}
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void answer(null)}>
          Skip
        </Button>
      </div>

      {problem || answeredCount > 0 ? (
        <div className="border-t border-line/60 pt-2 text-[12px]">
          {problem ? (
            <span role="alert" className="text-danger">
              <ReferenceText>{problem}</ReferenceText>
            </span>
          ) : (
            <span className="text-ink-subtle">
              {answeredCount} of {questions.length} answered — the product owner reads them together
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The closed card: what was asked, what was on offer and what was said —
 * and when nothing was, it says that in its label and its marks as well as
 * in words. `sending` draws answers that have not landed yet: faded, with
 * a line saying so, and never as the record.
 */
function Answered({ questions, answers, sending = false }: { questions: AskedQuestion[]; answers: (question: AskedQuestion) => string | null; sending?: boolean }) {
  const filed = questions.filter((question) => answers(question) !== null).length;
  return (
    <div
      className="flex flex-col rounded-[14px] bg-canvas-subtle px-4 py-1"
      aria-busy={sending || undefined}
      aria-label={filed === 0 ? "Questions that closed unanswered" : filed === questions.length ? "Questions you answered" : "Questions you partly answered"}
    >
      <div className={cn("flex flex-col", sending && "opacity-60")}>
        {questions.map((question, position) => {
          const answer = answers(question);
          const given = answer !== null;
          return (
            <div key={question.id} className={cn("flex gap-3 py-3", position > 0 && "border-t border-line/60")}>
              {/* A filled mark for a decision, an empty ring for one never
                  made: the two read apart without being read. */}
              <span
                aria-hidden
                className={cn(
                  "mt-[3px] grid size-4 shrink-0 place-items-center rounded-full",
                  given ? "bg-canvas-active text-ink-muted" : "border border-line text-ink-subtle",
                )}
              >
                {given ? <Check size={11} /> : <Minus size={9} />}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className={cn("text-[12.5px]", given ? "text-ink-muted" : "text-ink-subtle")}>
                  <ReferenceText>{headline(question.body)}</ReferenceText>
                </p>
                <div className="text-[13.5px] leading-[1.55] text-ink">
                  {answer === null ? <span className="text-ink-subtle">Not answered</span> : <Markdown>{answer}</Markdown>}
                </div>
                {/* What was on offer, kept: a question that closed
                    unanswered only reads beside the choices nobody took. */}
                {question.options.length > 0 ? (
                  <ul aria-label="Suggested answers" className="flex flex-wrap gap-1 pt-0.5">
                    {question.options.map((option, slot) => (
                      <li
                        key={`${slot}-${option}`}
                        className={cn("rounded-[7px] px-2 py-[3px] text-[11.5px]", option === answer ? "bg-accent-subtle text-ink" : "bg-canvas text-ink-subtle")}
                      >
                        <ReferenceText>{option}</ReferenceText>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {sending ? (
        <p role="status" className="flex items-center gap-1.5 border-t border-line/60 py-2 text-[12px] text-ink-subtle">
          <LoaderCircle aria-hidden size={11} className="animate-spin" />
          Sending your answers…
        </p>
      ) : null}
    </div>
  );
}
