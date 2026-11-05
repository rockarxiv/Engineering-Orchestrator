import { useState } from "react";
import type { IpcRequest, IpcResponse } from "@eo/core";
import { useChromeVocabulary } from "../../../query/hooks";
import { Button, Checkbox, Dialog } from "../../kit";
import { ItemRef, RefText } from "../items/ItemReference";
import { plural } from "./parts";

export interface DeleteTarget {
  key: string;
  title: string;
  /** Whether this type holds work under it (KAN-146) — the flag, never the word. */
  container: boolean;
  jiraKey: string | null;
  /** The items underneath that go with it. */
  childCount: number;
  runCount: number;
  costCents: number;
}

/**
 * The confirmation in front of a delete (KAN-30).
 *
 * It says what goes before it goes, because nothing here comes back: the
 * work under a container, the thread, the runs and what they cost. The
 * two refusals — a live run, a worktree holding uncommitted work — come
 * from the main process rather than being guessed here; the dialog stays
 * open and becomes the sharper question. After a delete that left a
 * checkout on disk (issue #131) it stays up once more to name it, because
 * once it closes nothing connects that directory to the item it held.
 */
export function ConfirmDeleteItem({
  target,
  jiraConnected,
  busy,
  refusal,
  leftover,
  onConfirm,
  onCancel,
}: {
  target: DeleteTarget;
  jiraConnected: boolean;
  busy: boolean;
  refusal: IpcResponse<"items:delete"> | null;
  leftover: IpcResponse<"items:delete">["leftoverWorktrees"];
  onConfirm: (extra: Partial<IpcRequest<"items:delete">>) => void;
  onCancel: () => void;
}) {
  const vocabulary = useChromeVocabulary();
  const [deleteInJira, setDeleteInJira] = useState(false);
  const blocked = refusal?.blockedByActiveRun === true || refusal?.blockedByUncommittedWork === true;
  const canOfferJira = jiraConnected && target.jiraKey !== null;

  if (leftover.length > 0) {
    return (
      <Dialog open onClose={onCancel} title={`${target.key} was deleted`} footer={<Button onClick={onCancel}>Close</Button>}>
        <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-ink-muted">
          <p>
            It is gone, but EO could not remove {leftover.length === 1 ? "the worktree it was using, so it is" : "the worktrees it was using, so they are"}{" "}
            still on disk:
          </p>
          <ul role="alert" className="flex flex-col gap-2 text-paused">
            {leftover.map((entry) => (
              <li key={entry.path}>
                <span className="block font-mono text-[12px] text-ink">{entry.path}</span>
                {entry.problem}
              </li>
            ))}
          </ul>
        </div>
      </Dialog>
    );
  }

  const word = vocabulary.item.toLowerCase();
  const goes = [
    target.childCount > 0 ? plural(target.childCount, `${word} under it`, `${vocabulary.items.toLowerCase()} under it`) : null,
    target.runCount > 0 ? plural(target.runCount, "run") : null,
    target.costCents > 0 ? `${(target.costCents / 100).toFixed(2)} USD of recorded spend` : null,
  ].filter((entry): entry is string => entry !== null);

  return (
    <Dialog
      open
      onClose={onCancel}
      busy={busy}
      title={
        <>
          Delete <ItemRef itemKey={target.key} className="font-mono" />?
        </>
      }
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Keep it
          </Button>
          {blocked ? (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                onConfirm({
                  deleteInJira,
                  cancelActiveRun: refusal?.blockedByActiveRun ?? false,
                  discardUncommitted: refusal?.blockedByUncommittedWork ?? false,
                })
              }
            >
              {refusal?.blockedByActiveRun ? "Cancel the run and delete" : "Discard that work and delete"}
            </Button>
          ) : (
            <Button variant="danger" disabled={busy} onClick={() => onConfirm({ deleteInJira })}>
              {target.container && target.childCount > 0 ? "Delete this and everything under it" : `Delete this ${word}`}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-2.5 text-[13px] leading-relaxed text-ink-muted">
        <p>
          <span className="text-ink">{target.title}</span> and its comment thread will be removed for good. This cannot be undone.
        </p>
        {goes.length > 0 ? (
          <p>
            Also going: {goes.join(", ")}.{target.childCount > 0 ? " Everything filed under it is deleted with it." : ""}
          </p>
        ) : null}
        {canOfferJira ? (
          // Unticked by default: deleting somebody's Jira issue is not a
          // side effect of tidying a project.
          <Checkbox
            checked={deleteInJira}
            disabled={busy}
            onChange={setDeleteInJira}
            label={
              <span>
                Also delete <span className="font-mono text-ink">{target.jiraKey}</span> in Jira. Left unticked, the issue stays as it is and stops being
                mirrored.
              </span>
            }
          />
        ) : null}
        {refusal?.problem ? (
          <p role="alert" className={blocked ? "text-paused" : "text-danger"}>
            <RefText>{refusal.problem}</RefText>
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
