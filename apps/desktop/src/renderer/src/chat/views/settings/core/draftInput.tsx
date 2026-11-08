import { type InputHTMLAttributes, useEffect, useRef, useState } from "react";
import { TextInput } from "../../../kit";

/** How long a field waits after the last keystroke before it saves (EO-563). */
export const DRAFT_SAVE_DELAY_MS = 500;

type DraftInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange" | "onBlur"> & {
  /** What is stored, as the field draws it. */
  value: string;
  /**
   * Save what was typed. Resolves `true` once it is stored, `false` when it
   * was not — refused, or the write failed — in which case the field keeps
   * what was typed rather than snapping back to `value`.
   */
  onCommit: (text: string) => Promise<boolean>;
};

/**
 * A text box that edits its own draft and saves on blur, or once typing has
 * paused for {@link DRAFT_SAVE_DELAY_MS} (EO-563).
 *
 * A box drawn straight from the stored value and saved on every keystroke
 * snaps back between the keystroke and the refetch, which garbles typing.
 * Here what is typed is what is drawn until a save of exactly that text has
 * come back stored; a save that comes back while the person has gone on
 * typing leaves the newer text alone, and a save that fails keeps it.
 *
 * Whatever was typed is sent, even when it matches what is stored: with an
 * earlier save still on its way, "the same as stored" is the value that save
 * is about to replace, and skipping it would let the older edit win.
 *
 * Saves are matched to edits by number, not by text: every keystroke is a
 * new edit, a save carries the number of the edit it sent, and an answer
 * clears the draft only when no edit has come since. Typing 7, then 9, then 7
 * again while the first two are on their way is three edits, so the first
 * 7's answer does not mistake the last 7 for itself. The only edits not
 * sent are one already sent and not yet answered — a blur straight after
 * the pause has saved it — and one already saved, which a blur can still
 * find in the draft before React has drawn the answer (EO-670).
 */
export function DraftInput({ value, onCommit, ...props }: DraftInputProps) {
  const [draft, setDraft] = useState<{ text: string; edit: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** How many edits this box has seen; each keystroke's number. */
  const edits = useRef(0);
  /** The edit handed to `onCommit` and not yet answered. */
  const sent = useRef<number | null>(null);
  /** The newest edit stored, which nothing need send again. */
  const saved = useRef<number | null>(null);
  // The newest of each, for the timer and the unmount flush, which would
  // otherwise close over the render that started them.
  const latest = useRef({ draft, onCommit });
  latest.current = { draft, onCommit };

  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  const commit = () => {
    cancel();
    const { draft: typed, onCommit: save } = latest.current;
    if (typed === null || typed.edit === sent.current || typed.edit === saved.current) return;
    const { text, edit } = typed;
    sent.current = edit;
    void save(text).then((stored) => {
      // A failed edit may be sent again — the next blur retries it.
      if (sent.current === edit) sent.current = null;
      if (!stored) return;
      saved.current = edit;
      // Only the edit that was saved goes back to being drawn from storage;
      // anything typed since is still the person's, whatever its text.
      setDraft((current) => (current?.edit === edit ? null : current));
    });
  };

  // Leaving the screen inside the delay still saves what was typed.
  useEffect(
    () => () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      const { draft: typed, onCommit: save } = latest.current;
      if (typed !== null && typed.edit !== sent.current && typed.edit !== saved.current) void save(typed.text);
    },
    [],
  );

  return (
    <TextInput
      {...props}
      value={draft === null ? value : draft.text}
      onChange={(event) => {
        edits.current += 1;
        const next = { text: event.target.value, edit: edits.current };
        // Read by a blur that lands before React has drawn this keystroke.
        latest.current = { ...latest.current, draft: next };
        setDraft(next);
        cancel();
        timer.current = setTimeout(commit, DRAFT_SAVE_DELAY_MS);
      }}
      onBlur={commit}
    />
  );
}
