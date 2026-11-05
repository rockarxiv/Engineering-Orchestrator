import { useState, type ReactNode } from "react";
import type { ItemSummary } from "@eo/core";
import { useChromeVocabulary } from "../../../query/hooks";
import { Button, Dialog, ErrorLine, Field, Notice, Select, TextArea } from "../../kit";
import { KeyLink } from "./references";

/**
 * The dialogs a drop opens: a move to another column, a hand-off to
 * another pipeline, a hold in the paused rail.
 *
 * A drop only records intent; nothing moves until one of these is
 * confirmed, so a mis-drop never changes state and every manual move
 * has the same chance to carry a comment (ARCHITECTURE.md, "Moving an item by hand"). The comment
 * is always
 * optional.
 */

function DropDialog({
  title,
  description,
  choice = null,
  commentLabel,
  commentPlaceholder,
  confirmLabel,
  busyLabel,
  danger,
  busy,
  confirmDisabled = false,
  focusChoice = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: ReactNode;
  /** What the dialog still has to ask before the comment: the hand-off's pipeline. */
  choice?: ReactNode;
  commentLabel: string;
  commentPlaceholder: string;
  confirmLabel: string;
  busyLabel: string;
  danger: boolean;
  busy: boolean;
  confirmDisabled?: boolean;
  /** Put the cursor on the choice rather than the comment, while the choice is open. */
  focusChoice?: boolean;
  onConfirm: (comment: string) => void;
  onCancel: () => void;
}) {
  const [comment, setComment] = useState("");
  return (
    <Dialog
      open
      onClose={onCancel}
      busy={busy}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} disabled={busy || confirmDisabled} onClick={() => onConfirm(comment)}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px] leading-relaxed text-ink-muted">
        {description}
        {choice}
        <Field label="Anything to pass on? (optional)">
          <TextArea
            aria-label={commentLabel}
            rows={3}
            value={comment}
            disabled={busy}
            placeholder={commentPlaceholder}
            onChange={(event) => setComment(event.target.value)}
            {...(focusChoice ? {} : { "data-autofocus": true })}
          />
        </Field>
      </div>
    </Dialog>
  );
}

/** What a run in flight costs, in the same words wherever it is about to be cancelled. */
function ActiveRunWarning({ item }: { item: ItemSummary }) {
  return (
    <Notice tone="paused" title="Active work will be cancelled.">
      <span>
        <KeyLink itemKey={item.key} itemId={item.id} /> has a running or queued run; it will stop, and any work it has not committed may be lost.
      </span>
    </Notice>
  );
}

export type MoveDestination =
  | { kind: "step"; name: string }
  | {
      kind: "pipeline";
      /** Every pipeline this item can be handed to. */
      options: { id: string; name: string }[];
      /** The one chosen so far, or null while the question is open. */
      selectedId: string | null;
      onSelect: (pipelineId: string) => void;
    };

export function ConfirmItemMove({
  item,
  destination,
  cancelActiveRun,
  problem = null,
  busy,
  onConfirm,
  onCancel,
}: {
  item: ItemSummary;
  /** A step for a column drop; for a hand-off, the pipelines to choose from (EO-71). Names, never ids. */
  destination: MoveDestination;
  /** Running and queued work makes the otherwise ordinary move destructive. */
  cancelActiveRun: boolean;
  /** What the last attempt was refused with, when it was refused rather than blocked. */
  problem?: string | null;
  busy: boolean;
  onConfirm: (comment: string) => void;
  onCancel: () => void;
}) {
  const word = useChromeVocabulary().item.toLowerCase();
  const handOff = destination.kind === "pipeline";
  const chosen = destination.kind === "pipeline" ? (destination.options.find((option) => option.id === destination.selectedId) ?? null) : null;
  const going = destination.kind === "pipeline" ? chosen?.name : destination.name;
  return (
    <DropDialog
      title={handOff ? (going === undefined ? `Send ${item.key} to another pipeline?` : `Send ${item.key} to ${going}?`) : `Move ${item.key} to ${going}?`}
      description={
        <>
          {cancelActiveRun ? (
            <ActiveRunWarning item={item} />
          ) : handOff ? (
            <p>
              <KeyLink itemKey={item.key} itemId={item.id} className="text-ink" /> leaves this pipeline and lands where{" "}
              {going === undefined ? "the one you choose" : <span className="text-ink">{going}</span>} takes work in.
            </p>
          ) : (
            <p>
              Confirm moving <KeyLink itemKey={item.key} itemId={item.id} className="text-ink" /> to <span className="text-ink">{going}</span>.
            </p>
          )}
          {/* A refusal, in the main process's words. Nothing moved, so the dialog stays. */}
          {problem === null ? null : <ErrorLine>{problem}</ErrorLine>}
        </>
      }
      choice={
        destination.kind === "pipeline" ? (
          <Field label="Which pipeline?">
            <Select
              aria-label={`Pipeline to send the ${word} to`}
              value={destination.selectedId ?? ""}
              disabled={busy}
              onChange={(event) => destination.onSelect(event.target.value)}
              {...(chosen === null ? { "data-autofocus": true } : {})}
            >
              <option value="" disabled>
                Choose a pipeline…
              </option>
              {destination.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null
      }
      focusChoice={handOff && chosen === null}
      commentLabel="Comment to post with the move"
      commentPlaceholder="What should be done differently…"
      confirmLabel={cancelActiveRun ? `Cancel the run and ${handOff ? "send" : "move"}` : handOff ? `Send ${word}` : `Move ${word}`}
      busyLabel={handOff ? "Sending…" : "Moving…"}
      danger={cancelActiveRun}
      busy={busy}
      // Nothing to send until a pipeline is chosen.
      confirmDisabled={handOff && chosen === null}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

/** The dialog a drop into the paused rail opens (EO-46): a hold never moves anything. */
export function ConfirmItemHold({
  item,
  cancelActiveRun,
  busy,
  onConfirm,
  onCancel,
}: {
  item: ItemSummary;
  cancelActiveRun: boolean;
  busy: boolean;
  onConfirm: (comment: string) => void;
  onCancel: () => void;
}) {
  const word = useChromeVocabulary().item.toLowerCase();
  return (
    <DropDialog
      title={`Hold ${item.key}?`}
      description={
        cancelActiveRun ? (
          <ActiveRunWarning item={item} />
        ) : (
          <p>
            <KeyLink itemKey={item.key} itemId={item.id} className="text-ink" /> stays on <span className="text-ink">{item.stepName}</span>, and no agent picks
            it up until you resume it.
          </p>
        )
      }
      commentLabel="Comment to post with the hold"
      commentPlaceholder="Why you're parking this…"
      confirmLabel={cancelActiveRun ? "Cancel the run and hold" : `Hold ${word}`}
      busyLabel="Holding…"
      danger={cancelActiveRun}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
