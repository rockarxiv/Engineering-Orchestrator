import { useState } from "react";
import { REVIEWERS_FROM_REPOSITORY, type ItemReference, type ItemReviewers } from "@eo/core";
import { Button, Chip, GroupLabel, TextInput } from "../../kit";
import { RefText } from "../items/ItemReference";
import { StatusLine } from "./parts";

/**
 * The outside issue an item's work is filed under — its Reference —
 * read and set from the item page (EO-637).
 *
 * The same `items:update` door the agents' update tool uses, so a person
 * and an agent are told the same refusals by the same handler. A refused
 * value stays in the box with the reason under it; the row above goes on
 * naming the Reference the item actually has. A blank box is clearing.
 *
 * Shows the Reference as it takes effect: the item's own, or its
 * feature's marked as inherited. Clearing is offered only for the item's
 * own — an inherited one is the feature's to clear.
 *
 * Keyed by the caller on the item's own value, so a write that lands
 * resets it to what the item now says.
 */
export function ReferenceField({
  own,
  reference,
  busy,
  problem,
  onSave,
  onCancel,
}: {
  /** The item's own Reference, null when it names none. */
  own: string | null;
  /** What takes effect, own or inherited, null when nothing does. */
  reference: ItemReference | null;
  busy: boolean;
  problem: string | null;
  onSave: (reference: string | null) => void;
  onCancel: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(own ?? "");
  const trimmed = draft.trim();
  const next = trimmed === "" ? null : trimmed;
  const send = (): void => {
    if (busy || next === own) return;
    onSave(next);
  };

  return (
    <section aria-label="Reference" className="flex min-w-0 flex-col gap-2 border-t border-line/60 pt-3">
      <GroupLabel>Reference</GroupLabel>
      {reference !== null ? (
        <span className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
          <span className="min-w-0 truncate font-mono text-ink" title={reference.value}>
            {reference.value}
          </span>
          {reference.inheritedFrom !== null ? <Chip title={`No Reference of its own, so ${reference.inheritedFrom}'s is used`}>Inherited from {reference.inheritedFrom}</Chip> : null}
        </span>
      ) : (
        <span className="text-[12.5px] text-ink-subtle">None</span>
      )}

      {editing ? (
        <div className="flex flex-col gap-1.5">
          <TextInput
            aria-label="Reference value"
            placeholder={reference?.value ?? "PROJ-123"}
            value={draft}
            disabled={busy}
            className="font-mono"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              send();
            }}
          />
          <span className="flex flex-wrap gap-1">
            <Button size="sm" variant="secondary" disabled={busy || next === own} onClick={send}>
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(own ?? "");
                setEditing(false);
                onCancel();
              }}
            >
              Cancel
            </Button>
          </span>
        </div>
      ) : (
        <span className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
            {own === null ? "Set" : "Change"}
          </Button>
          {own !== null ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSave(null)}>
              Clear
            </Button>
          ) : null}
        </span>
      )}

      {problem ? (
        <StatusLine tone="danger">
          <RefText>{problem}</RefText>
        </StatusLine>
      ) : null}
    </section>
  );
}

/**
 * Who is asked to review the pull request an item opens, read and set
 * from the item page beside its Reference (EO-742).
 *
 * Shows the list as it takes effect — the item's own, its feature's, or
 * the repository's default — and says which. Three things can be done
 * to the item's own list: set it (handles separated by commas or
 * spaces), set it to nobody, which asks nobody whatever the repository
 * says, and clear it, which goes back to inheriting. Through
 * `items:update`, so a refusal is the handler's own words.
 *
 * Keyed by the caller on the item's own list, so a write that lands
 * resets the draft to what the item now says.
 */
export function ReviewersField({
  own,
  reviewers,
  busy,
  problem,
  onSave,
  onCancel,
}: {
  /** The item's own list: null when it inherits, `[]` when it asks nobody. */
  own: string[] | null;
  /** What takes effect and where it came from; null from a main process that predates it. */
  reviewers: ItemReviewers | null;
  busy: boolean;
  problem: string | null;
  onSave: (reviewers: string[] | null) => void;
  onCancel: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState((own ?? []).join(", "));
  const handles = draft.split(/[\s,]+/).filter((handle) => handle !== "");
  const unchanged = own !== null && handles.join(",") === own.join(",");
  const send = (): void => {
    if (busy || handles.length === 0 || unchanged) return;
    onSave(handles);
  };
  const shown = reviewers ?? (own === null ? null : { value: own, inheritedFrom: null });

  return (
    <section aria-label="Pull request reviewers" className="flex min-w-0 flex-col gap-2 border-t border-line/60 pt-3">
      <GroupLabel>Pull request reviewers</GroupLabel>
      {shown !== null ? (
        <span className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
          {shown.value.length > 0 ? (
            <span className="min-w-0 truncate font-mono text-ink" title={shown.value.join(", ")}>
              {shown.value.join(", ")}
            </span>
          ) : (
            <span className="text-ink-subtle">Nobody</span>
          )}
          {shown.inheritedFrom === REVIEWERS_FROM_REPOSITORY ? (
            <Chip title="No reviewers of its own or its feature's, so the repository's default reviewers are asked">From the repository</Chip>
          ) : shown.inheritedFrom !== null ? (
            <Chip title={`No reviewers of its own, so ${shown.inheritedFrom}'s are asked`}>Inherited from {shown.inheritedFrom}</Chip>
          ) : null}
        </span>
      ) : (
        <span className="text-[12.5px] text-ink-subtle">Nobody</span>
      )}

      {editing ? (
        <div className="flex flex-col gap-1.5">
          <TextInput
            aria-label="Reviewers"
            placeholder={shown !== null && shown.value.length > 0 ? shown.value.join(", ") : "alice, acme/backend"}
            value={draft}
            disabled={busy}
            className="font-mono"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              send();
            }}
          />
          <span className="flex flex-wrap gap-1">
            <Button size="sm" variant="secondary" disabled={busy || handles.length === 0 || unchanged} onClick={send}>
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft((own ?? []).join(", "));
                setEditing(false);
                onCancel();
              }}
            >
              Cancel
            </Button>
          </span>
        </div>
      ) : (
        <span className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
            {own === null || own.length === 0 ? "Set" : "Change"}
          </Button>
          {own === null || own.length > 0 ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSave([])}>
              Ask nobody
            </Button>
          ) : null}
          {own !== null ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSave(null)}>
              Inherit
            </Button>
          ) : null}
        </span>
      )}

      {problem ? (
        <StatusLine tone="danger">
          <RefText>{problem}</RefText>
        </StatusLine>
      ) : null}
    </section>
  );
}
