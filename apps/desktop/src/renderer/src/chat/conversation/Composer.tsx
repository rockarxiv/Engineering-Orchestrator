import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, File, LoaderCircle, Paperclip, Square, X } from "lucide-react";
import { cn } from "@eo/ui";
import { useAttachmentDrafts } from "../../shared/attachments/useAttachmentDrafts";
import { machineAvailable } from "../../ipc/bridge";
import { activeCompletion, extractMentions, type ComposerCompletion, type ComposerProps } from "../../shared/item/composer";
import { Button } from "../kit";
import { ReferenceText } from "./references";

export type { ComposerCompletion, ComposerProps } from "../../shared/item/composer";

/** How often, at most, a person still typing is said to be typing (`onTyping`): well inside the minute a warm backend waits. */
const TYPING_EVERY_MS = 20_000;

/** How many files one message may carry; `useAttachmentDrafts` owns the cap and says so past it. */
const MAX_FILES = 8;

/**
 * The chat layout's composer, the box under every conversation
 * (ARCHITECTURE.md, "The chat-centric layout"): the field and its row of controls in one
 * lit, rounded box, the send button the one accent on it.
 *
 * Every behaviour is the classic `item/Composer`'s, kept to the letter,
 * because each of them is a fix somebody needed: Enter posts and
 * Ctrl/Shift+Enter is a newline; `@`, `/` and `$` complete from the
 * mentionables and the caller's completions, with the arrows, Tab and
 * Enter to take one; files come by the picker, by paste and by drop, are
 * counted against the cap as they are offered, and are refused — out
 * loud — while a message is already on its way; the text stays until the
 * post has landed and a failure is shown without losing it; and an item
 * key in any of those sentences is a link.
 *
 * `clearOnSend` is the conversation's version of the second-to-last: the
 * box lets go of the message as it is sent, because the transcript is
 * drawing it as sending (EO-549), and a failure puts the words and the
 * staged files back with the reason under them.
 *
 * Both appearances are drawn here. `chat` is the conversation's box: one
 * line that grows with the draft, the paperclip and a hint in its row.
 * `default` is an item's comment box: three rows a person can drag
 * taller, and its buttons in words — "Attach", "Comment" — because a
 * comment box sits among a page of other buttons and an icon alone would
 * be one more thing to decode there.
 */
export function Composer({
  mentionables,
  onSubmit,
  busy,
  readOnly = false,
  placeholder,
  submitLabel,
  textareaRef,
  ariaLabel = "Write a comment",
  appearance = "default",
  statusText,
  completions = [],
  running = false,
  onStop,
  stopping = false,
  recallLast,
  onCommand,
  controls,
  prefill = null,
  onTyping,
  typingScope,
  clearOnSend = false,
}: ComposerProps & {
  /**
   * A turn is running in the conversation this box sends to. With
   * `onStop`, the send button becomes Stop while the box is empty and
   * Escape stops the turn — Claude Desktop's box. Typing still sends: a
   * message sent now goes into the running turn.
   */
  running?: boolean;
  onStop?: () => void;
  stopping?: boolean;
  /** What Up in an empty box brings back: the last thing this person sent, to edit and send again. */
  recallLast?: string | null;
  /**
   * Handles a `/command` typed as the whole message. Answers whether it
   * did; one it did not is sent as an ordinary message. Rejecting shows
   * the reason under the box and keeps what was typed.
   */
  onCommand?: (command: string, rest: string) => boolean | Promise<boolean>;
  /** Controls drawn in the box's own row, beside the paperclip: the chat's model, effort and thinking. */
  controls?: ReactNode;
  /**
   * Text put into the box from outside — a message being edited — with the
   * cursor at its end. Applied when `nonce` changes, so the same words can
   * be put back twice.
   */
  prefill?: { text: string; nonce: number } | null;
  /**
   * Somebody is typing a message: called on the first character and at
   * most every 20 seconds after while they go on, so the room can warm
   * the backend for the turn they are about to ask for.
   */
  onTyping?: (() => void) | undefined;
  /**
   * What the box is sending to — a chat's id. Typing into another one is
   * typing into a turn nothing has warmed, so it is said at once rather
   * than after `onTyping`'s pause.
   */
  typingScope?: string | undefined;
  /**
   * Empty the box as the message is sent rather than once it has landed,
   * for a caller that draws the message as sending somewhere else. A
   * failed send gives the text and the staged files back.
   */
  clearOnSend?: boolean;
}) {
  const [body, setBody] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlighted, setHighlighted] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * True from the moment a submit starts until it settles — a ref, set
   * before the first `await`, because a caller's `busy` is a render behind
   * `onSubmit` and some callers pass none (EO-194).
   */
  const sending = useRef(false);
  const ownTextarea = useRef<HTMLTextAreaElement>(null);
  const textarea = textareaRef ?? ownTextarea;
  const attachmentState = useAttachmentDrafts();
  /**
   * The staged files of a message `clearOnSend` let go of: still the
   * drafts hook's until the send lands, so a failure has them back by
   * drawing them again, but not drawn — the box is empty.
   */
  const [lettingGo, setLettingGo] = useState(false);
  const attachments = lettingGo ? [] : attachmentState.attachments;
  const chat = appearance === "chat";

  // The conversation's box starts at one line and follows the draft; the
  // body dependency also shrinks it back after a send. A comment box keeps
  // its three rows and the handle to drag it taller.
  useLayoutEffect(() => {
    if (!chat) return;
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [chat, body, textarea]);

  /** The draft a person closed the suggestion list on with Escape; it stays closed until they type. */
  const [dismissedOn, setDismissedOn] = useState<string | null>(null);
  /** When `onTyping` was last called, so a burst of keystrokes asks once. */
  const typedAt = useRef(0);
  const typing = (value: string): void => {
    if (!onTyping || value.trim() === "") return;
    const now = Date.now();
    if (now - typedAt.current < TYPING_EVERY_MS) return;
    typedAt.current = now;
    onTyping();
  };

  useEffect(() => {
    typedAt.current = 0;
  }, [typingScope]);

  const appliedPrefill = useRef(prefill?.nonce ?? 0);
  useEffect(() => {
    if (!prefill || prefill.nonce === appliedPrefill.current) return;
    appliedPrefill.current = prefill.nonce;
    setBody(prefill.text);
    setCaret(prefill.text.length);
    const element = textarea.current;
    if (!element) return;
    element.focus();
    requestAnimationFrame(() => element.setSelectionRange(prefill.text.length, prefill.text.length));
  }, [prefill, textarea]);

  const completion = activeCompletion(body, caret);
  const suggestions = useMemo(() => {
    if (completion === null || dismissedOn === body) return [];
    const mentionSuggestions: ComposerCompletion[] = completion.trigger === "@" ? mentionables.map((name) => ({ trigger: "@", value: name })) : [];
    return [...mentionSuggestions, ...completions]
      .filter((item) => item.trigger === completion.trigger && item.value.toLowerCase().includes(completion.query.toLowerCase()))
      .slice(0, 8);
  }, [completion, completions, mentionables, dismissedOn, body]);

  function accept(item: ComposerCompletion) {
    if (!completion) return;
    const before = `${body.slice(0, completion.start)}${item.trigger}${item.value} `;
    setBody(before + body.slice(caret));
    setCaret(before.length);
    setHighlighted(0);
    textarea.current?.focus();
  }

  /** Clears only once the post has landed; a caller that returns nothing clears at once. */
  async function submit() {
    const trimmed = body.trim();
    // Checked here as well as on the button: Enter never consults a
    // disabled attribute, and a message sent while a batch is still
    // staging would leave without those files (EO-194).
    if ((!trimmed && attachments.length === 0) || busy || readOnly || attachmentState.busy || sending.current) return;

    sending.current = true;
    setProblem(null);
    try {
      const command = onCommand && attachments.length === 0 ? /^\/([\w-]+)\s*([\s\S]*)$/.exec(trimmed) : null;
      if (command && onCommand && (await onCommand(command[1]!, command[2]!.trim()))) {
        setBody("");
        setCaret(0);
        return;
      }
      const sent = body;
      if (clearOnSend) {
        setBody("");
        setCaret(0);
        setLettingGo(true);
      }
      try {
        await onSubmit(trimmed, extractMentions(trimmed, mentionables), attachments.map((attachment) => attachment.id));
      } catch (error) {
        // Given back as it was, ahead of anything typed since.
        if (clearOnSend) {
          setBody((current) => (current === "" ? sent : `${sent}\n${current}`));
          setCaret(sent.length);
        }
        throw error;
      }
      // The next message is the next turn: its first character warms it.
      typedAt.current = 0;
      setBody("");
      setCaret(0);
      attachmentState.clearCommitted();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      sending.current = false;
      setLettingGo(false);
    }
  }

  /** A file offered mid-send would belong to neither message, so it is refused rather than staged. */
  function tooLateToAttach(): boolean {
    return busy || sending.current;
  }

  function refuseWhileSending(): void {
    setProblem("The message was already sending, so that file was not attached. Try again once it has gone.");
  }

  /** Handed on whole: the drafts hook owns the cap and the sentence for exceeding it. */
  function attachFiles(files: FileList | File[]): void {
    setProblem(null);
    void attachmentState.stageFiles(files);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    if (tooLateToAttach()) {
      refuseWhileSending();
      return;
    }
    attachFiles(files);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    if (event.dataTransfer.files.length === 0) return;
    // Prevented either way: left to the browser, a dropped file replaces
    // the window, and the unsent message with it.
    event.preventDefault();
    if (tooLateToAttach()) {
      refuseWhileSending();
      return;
    }
    attachFiles(event.dataTransfer.files);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Keys pressed while an input method is composing are the method's.
    if (event.nativeEvent.isComposing) return;
    if (suggestions.length > 0) {
      // Escape closes the list first; only an Escape with nothing open
      // reaches the running turn.
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedOn(body);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlighted((current) => (current + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlighted((current) => (current - 1 + suggestions.length) % suggestions.length);
        return;
      }
      // Plain Enter takes the suggestion; a modified Enter is still a newline.
      if (event.key === "Tab" || (event.key === "Enter" && !event.ctrlKey && !event.shiftKey)) {
        event.preventDefault();
        accept(suggestions[highlighted]!);
        return;
      }
    }
    // Escape stops a running turn, as it does in Claude Desktop.
    if (event.key === "Escape" && running && onStop && !stopping) {
      event.preventDefault();
      onStop();
      return;
    }
    // Up in an empty box brings back the last message, to edit and resend.
    if (event.key === "ArrowUp" && recallLast && body === "" && attachments.length === 0) {
      event.preventDefault();
      setBody(recallLast);
      setCaret(recallLast.length);
      requestAnimationFrame(() => textarea.current?.setSelectionRange(recallLast.length, recallLast.length));
      return;
    }
    // Enter posts; Ctrl+Enter and Shift+Enter keep the native newline.
    if (event.key === "Enter" && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  const empty = body.trim() === "" && attachments.length === 0;
  const sendDisabled = busy || readOnly || attachmentState.busy || empty;
  const attachDisabled = busy || readOnly || attachmentState.busy || attachments.length >= MAX_FILES;
  const shownProblem = problem ?? attachmentState.problem;
  const label = submitLabel ?? (chat ? "Send" : "Comment");

  return (
    <div className="relative" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
      <div
        className={cn(
          "flex flex-col gap-2.5 rounded-[18px] bg-canvas-subtle pb-2.5 pl-4 pr-3 pt-3 shadow-[inset_0_0_0_1px_var(--color-line)] transition-shadow duration-[var(--dur-short)] ease-out",
          "focus-within:shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
        )}
      >
        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-1.5" aria-label="Attachments">
            {attachments.map((attachment) => (
              <span
                key={attachment.id}
                className="inline-flex h-[26px] max-w-56 min-w-0 items-center gap-1.5 rounded-[8px] bg-canvas-raised pl-2 pr-1 text-[12px] text-ink-muted"
              >
                <File aria-hidden size={12} className="shrink-0 text-ink-subtle" />
                <span className="truncate">{attachment.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => attachmentState.remove(attachment.id)}
                  className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] text-ink-subtle hover:bg-canvas-hover hover:text-ink"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <textarea
          ref={textarea}
          aria-label={ariaLabel}
          value={body}
          rows={chat ? 1 : 3}
          placeholder={placeholder ?? (chat ? "Ask anything…" : "Comment… @user or @agent to notify. Enter to post; Ctrl/Shift+Enter for a newline.")}
          onChange={(event) => {
            setBody(event.target.value);
            setCaret(event.target.selectionStart);
            typing(event.target.value);
          }}
          onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
          onClick={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          // Disabled while posting, so a frozen box reads as deliberate and
          // a second submit cannot double-post.
          disabled={busy || readOnly}
          // The box carries the focus ring; the field inside draws none.
          className={cn(
            "w-full bg-transparent pr-1 font-sans text-[14.5px] leading-[1.5] text-ink outline-none placeholder:text-ink-subtle focus-visible:shadow-none disabled:opacity-60",
            chat ? "min-h-[22px] resize-none overflow-y-hidden" : "min-h-[4.5rem] resize-y",
          )}
        />

        {shownProblem ? (
          <p role="alert" className="text-[12.5px] leading-snug text-danger">
            <ReferenceText>{shownProblem}</ReferenceText>
          </p>
        ) : null}

        <div className="flex items-center gap-1.5">
          {/* The picker is the machine's, so a server does not offer it
              (EO-319); paste and drop still stage through the record. */}
          {machineAvailable() ? (
            chat ? (
              <button
                type="button"
                aria-label="Attach files"
                title="Attach files"
                onClick={() => void attachmentState.pick()}
                disabled={attachDisabled}
                className="-ml-1.5 grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[10px] text-ink-subtle hover:bg-canvas-raised hover:text-ink disabled:pointer-events-none disabled:opacity-40"
              >
                <Paperclip size={15} />
              </button>
            ) : (
              <Button variant="ghost" size="sm" className="-ml-1.5" icon={<Paperclip size={13} />} onClick={() => void attachmentState.pick()} disabled={attachDisabled}>
                Attach
              </Button>
            )
          ) : null}
          {chat && controls ? controls : null}
          {chat ? <span className="min-w-0 truncate text-[11.5px] text-ink-subtle">{statusText ?? "@ files · / commands · paste or drop images"}</span> : null}
          <span className="flex-1" />
          {chat && running && onStop && empty ? (
            <button
              type="button"
              aria-label="Stop"
              title="Stop (Esc)"
              onClick={onStop}
              disabled={stopping}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-canvas-raised text-ink hover:bg-canvas-hover disabled:pointer-events-none disabled:opacity-50"
            >
              {stopping ? <LoaderCircle size={14} className="animate-spin" /> : <Square size={12} fill="currentColor" />}
            </button>
          ) : chat ? (
            <button
              type="button"
              aria-label={label}
              title={label}
              onClick={() => void submit()}
              disabled={sendDisabled}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-accent text-accent-ink hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-50"
            >
              {busy ? <LoaderCircle size={14} className="animate-spin" /> : <ArrowUp size={15} />}
            </button>
          ) : (
            <Button variant="primary" size="sm" onClick={() => void submit()} disabled={sendDisabled}>
              {busy ? "Posting…" : label}
            </Button>
          )}
        </div>
      </div>

      {suggestions.length > 0 ? (
        <ul
          role="listbox"
          aria-label={chat ? "Composer suggestions" : "Mention suggestions"}
          className="absolute bottom-full left-0 z-[var(--z-dropdown)] mb-1.5 flex max-h-72 w-80 max-w-full flex-col gap-px overflow-auto rounded-[14px] bg-canvas-raised p-1.5 shadow-panel"
        >
          {suggestions.map((item, index) => (
            <li key={`${item.trigger}${item.value}`}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                onMouseDown={(event) => {
                  event.preventDefault(); // keep focus in the field
                  accept(item);
                }}
                className={cn(
                  "flex w-full min-w-0 flex-col rounded-lg px-2 py-1.5 text-left text-[13px]",
                  index === highlighted ? "bg-canvas-hover text-ink" : "text-ink-muted hover:bg-canvas-hover hover:text-ink",
                )}
              >
                <span className="truncate">
                  <span className="text-ink-subtle">{item.trigger}</span>
                  {item.label ?? item.value}
                </span>
                {/* The comment box's list has always been names alone. */}
                {chat && item.description ? <span className="truncate text-[11.5px] text-ink-subtle">{item.description}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
