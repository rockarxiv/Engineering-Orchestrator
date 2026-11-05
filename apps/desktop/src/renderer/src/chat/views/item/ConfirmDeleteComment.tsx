import { useState } from "react";
import type { IpcRequest } from "@eo/core";
import { Button, Checkbox, Dialog } from "../../kit";
import { RefText } from "../items/ItemReference";
import { plural } from "./parts";

export interface DeleteCommentTarget {
  authorName: string;
  excerpt: string;
  /** Replies filed under it, which go with it. */
  replyCount: number;
  /** Whether it (or a reply) is in Jira too. */
  mirrored: boolean;
  jiraKey: string | null;
}

/**
 * The confirmation in front of removing a comment.
 *
 * Comments are the only channel there is (invariant 4), so deleting one
 * changes what every later agent reads. "Also in Jira" starts ticked —
 * the opposite of the item dialog — because unticked is the surprising
 * option: the next pull no longer recognises the comment and brings it
 * back here as a new one.
 */
export function ConfirmDeleteComment({
  target,
  busy,
  onConfirm,
  onCancel,
}: {
  target: DeleteCommentTarget;
  busy: boolean;
  onConfirm: (extra: Partial<IpcRequest<"comments:delete">>) => void;
  onCancel: () => void;
}) {
  const [deleteInJira, setDeleteInJira] = useState(true);
  return (
    <Dialog
      open
      onClose={onCancel}
      busy={busy}
      title="Delete this comment?"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Keep it
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => onConfirm({ deleteInJira })}>
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5 text-[13px] leading-relaxed text-ink-muted">
        <blockquote className="rounded-[10px] bg-canvas-raised px-3 py-2">
          <span className="text-ink">{target.authorName}</span>: “<RefText>{target.excerpt}</RefText>”
        </blockquote>
        <p>
          It will be removed for good, including from what later agents read. This cannot be undone.
          {target.replyCount > 0 ? ` The ${plural(target.replyCount, "reply", "replies")} filed under it go too.` : ""}
        </p>
        {target.mirrored ? (
          <Checkbox
            checked={deleteInJira}
            disabled={busy}
            onChange={setDeleteInJira}
            label={
              <span>
                Also delete it in {target.jiraKey ? <span className="font-mono text-ink">{target.jiraKey}</span> : "Jira"}. Unticked, it stays there — and the next
                sync, no longer recognising it, brings it back here as a new comment.
              </span>
            }
          />
        ) : null}
      </div>
    </Dialog>
  );
}
