import { memo, useState } from "react";
import { Pin, PinOff, Reply, Trash2 } from "lucide-react";
import { answerOptions, type CommentView } from "@eo/core";
import { CollapsibleMarkdown, cn } from "@eo/ui";
import { CommentActions } from "../../CommentActions";
import { Composer } from "../../conversation/Composer";
import { Button, Chip, type Tone } from "../../kit";
import { RefText } from "../items/ItemReference";
import { ItemAttachment } from "./ItemAttachment";
import { Initial, when } from "./parts";

/** A comment's kind, where it is not a plain note: an output among notes is a different kind of thing. */
const KIND_TONE: Record<string, Tone> = {
  question: "accent",
  decision: "accent",
  approval: "running",
  rejection: "danger",
  escalation: "paused",
  output: "accent",
};

interface ThreadProps {
  comment: CommentView;
  replies: CommentView[];
  mentionables: string[];
  busy: boolean;
  /** Closed to this reader rather than mid-send: a drop reaches a wrapper no fence disables (EO-194). */
  readOnly: boolean;
  /** The comments with a pin or unpin in flight, and which way each is going (EO-562). */
  pinning: ReadonlyMap<string, boolean>;
  onTogglePin: (commentId: string, pinned: boolean) => void;
  /** The replies travel with it: deleting a question deletes its answers. */
  onDelete: (comment: CommentView, replies: CommentView[]) => void;
  /** Posts a reply under `parentId` — this thread's comment. */
  onReply: (parentId: string, body: string, mentions: string[], attachmentIds: string[]) => Promise<unknown>;
}

/**
 * A comment and the answers to it (D-05).
 *
 * Replies sit indented under what they answer, so two open questions get
 * two distinguishable answers. A question nobody has answered opens its
 * reply box on its own — hiding it behind a click makes the item look as
 * though it needs nothing — and offers its options as one-press answers,
 * with the box below for anything else. The box closes once an answer
 * has landed, and only then: closing first lost the text on a failure.
 *
 * Memoised (EO-565): a page holds many threads, and a reply posted to one,
 * or a pin pressed on one, redraws that thread alone. Its replies are a
 * fresh array whenever the timeline is worked out again, so they are
 * compared a comment at a time (`sameThread`); everything else must be
 * handed in stable.
 */
export const CommentThread = memo(function CommentThread({
  comment,
  replies,
  mentionables,
  busy,
  readOnly,
  pinning,
  onTogglePin,
  onDelete,
  onReply,
}: ThreadProps) {
  const [replying, setReplying] = useState(comment.awaitingHuman);
  const [problem, setProblem] = useState<string | null>(null);
  // Answers only: an action (EO-533) is drawn on the comment itself, and never posts a reply.
  const options = answerOptions(comment.options);

  async function answerWith(option: string) {
    setProblem(null);
    try {
      await onReply(comment.id, option, [], []);
      setReplying(false);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <CommentRow
        comment={comment}
        pinning={pinning.get(comment.id)}
        onTogglePin={() => onTogglePin(comment.id, !comment.pinned)}
        onDelete={() => onDelete(comment, replies)}
        onReplyToggle={() => setReplying((was) => !was)}
      />

      {replies.length > 0 || replying ? (
        <div className="ml-[9px] flex min-w-0 flex-col gap-1.5 border-l border-line pl-4">
          {replies.map((reply) => (
            // One level deep: a reply has nothing under it, so deleting one takes only itself.
            <CommentRow
              key={reply.id}
              comment={reply}
              pinning={pinning.get(reply.id)}
              onTogglePin={() => onTogglePin(reply.id, !reply.pinned)}
              onDelete={() => onDelete(reply, [])}
            />
          ))}

          {replying ? (
            <div className="flex flex-col gap-2 pt-1">
              {options.length > 0 ? (
                <div className="flex flex-wrap gap-1.5" aria-label="Offered answers">
                  {options.map((option) => (
                    // The press target sits under the words, so a key
                    // inside an option is a link of its own and following
                    // it never posts the answer.
                    <div key={option} className="group relative">
                      <button
                        type="button"
                        aria-label={option}
                        disabled={busy}
                        onClick={() => void answerWith(option)}
                        className="absolute inset-0 rounded-[10px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:pointer-events-none"
                      />
                      <span
                        className={cn(
                          "pointer-events-none relative z-10 inline-flex h-[26px] items-center rounded-[10px] bg-canvas-raised px-2.5 text-xs font-medium text-ink group-hover:bg-canvas-hover",
                          busy && "opacity-50",
                        )}
                      >
                        <RefText linkClassName="pointer-events-auto underline underline-offset-2">{option}</RefText>
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              {problem ? (
                <p role="alert" className="text-[12px] text-danger">
                  <RefText>{problem}</RefText>
                </p>
              ) : null}
              <Composer
                mentionables={mentionables}
                busy={busy}
                readOnly={readOnly}
                submitLabel="Post reply"
                placeholder={options.length > 0 ? "…or answer in your own words" : "Reply…"}
                onSubmit={async (body, mentions, attachmentIds) => {
                  await onReply(comment.id, body, mentions, attachmentIds);
                  setReplying(false);
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}, sameThread);

/** Whether a thread would draw the same: its replies one by one, everything else as handed in. */
function sameThread(before: ThreadProps, after: ThreadProps): boolean {
  return (
    before.comment === after.comment &&
    before.replies.length === after.replies.length &&
    before.replies.every((reply, index) => reply === after.replies[index]) &&
    before.mentionables === after.mentionables &&
    before.busy === after.busy &&
    before.readOnly === after.readOnly &&
    before.pinning === after.pinning &&
    before.onTogglePin === after.onTogglePin &&
    before.onDelete === after.onDelete &&
    before.onReply === after.onReply
  );
}

function CommentRow({
  comment,
  pinning,
  onTogglePin,
  onDelete,
  onReplyToggle,
}: {
  comment: CommentView;
  /** Where a pin pressed here is going, while it is in flight (EO-562); undefined when none is. */
  pinning?: boolean | undefined;
  onTogglePin: () => void;
  onDelete: () => void;
  onReplyToggle?: () => void;
}) {
  const quiet = "opacity-0 group-hover/comment:opacity-100 group-focus-within/comment:opacity-100";
  // Drawn the way it is going at once, and as pending — never as settled — until the thread is read again.
  const sending = pinning !== undefined;
  const pinned = pinning ?? comment.pinned;
  return (
    <article
      aria-label={`${comment.authorName}, ${when(comment.createdAt)}`}
      className={cn(
        "group/comment flex min-w-0 flex-col gap-1.5 rounded-[12px] px-3 py-2.5",
        // An unanswered question is marked in the thread itself — the same
        // open mention the `!` on the project derives from (invariant 6).
        comment.awaitingHuman ? "bg-paused/10 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-paused),transparent_60%)]" : "bg-canvas-subtle",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
        <Initial name={comment.authorName} />
        <span className="font-medium text-ink">{comment.authorName}</span>
        {comment.authorRole ? <span className="text-ink-subtle">{comment.authorRole}</span> : null}
        {comment.kind !== "note" ? <Chip tone={KIND_TONE[comment.kind] ?? "neutral"}>{comment.kind}</Chip> : null}
        {comment.awaitingHuman ? <Chip tone="paused">awaiting your reply</Chip> : null}
        {sending ? <Chip tone="neutral">{pinned ? "pinning…" : "unpinning…"}</Chip> : comment.pinned ? <Chip tone="accent">pinned</Chip> : null}
        <span className="ml-auto flex items-center gap-0.5 text-[11px] text-ink-subtle">
          <span className="pr-1">{when(comment.createdAt)}</span>
          <button
            type="button"
            aria-label={sending ? (pinned ? "Pinning comment…" : "Unpinning comment…") : pinned ? "Unpin comment" : "Pin comment"}
            aria-busy={sending}
            disabled={sending}
            title={pinned ? "Unpin — stops surviving context truncation" : "Pin — survives context truncation (E-06)"}
            onClick={onTogglePin}
            className={cn(
              "grid h-6 w-6 place-items-center rounded-[7px] hover:bg-canvas-raised hover:text-ink disabled:opacity-60 disabled:hover:bg-transparent",
              !pinned && !sending && quiet,
            )}
          >
            {pinned ? <PinOff size={12} /> : <Pin size={12} />}
          </button>
          {/* Hidden until hover or focus: a destructive control on every
              row of a conversation should be reachable, not inviting. */}
          <button
            type="button"
            aria-label="Delete comment"
            title="Delete — removes it here, in Jira, and from what later agents read"
            onClick={onDelete}
            className={cn("grid h-6 w-6 place-items-center rounded-[7px] hover:bg-danger/15 hover:text-danger", quiet)}
          >
            <Trash2 size={12} />
          </button>
        </span>
      </div>

      {/* Only the body clips when it runs long (EO-419): the header above
          and the attachments and Reply below stay where they are. */}
      <CollapsibleMarkdown className="min-w-0 text-ink" toggleClassName="rounded-[7px] text-[12px] focus-visible:outline-focus">
        {comment.body}
      </CollapsibleMarkdown>

      {(comment.attachments?.length ?? 0) > 0 ? <CommentAttachments comment={comment} /> : null}

      {/* What the comment opens (EO-533), on the comment rather than in
          the reply box: pressing one answers nothing. */}
      <CommentActions options={comment.options} commentId={comment.id} />

      {onReplyToggle ? (
        <div>
          <Button size="sm" variant="ghost" icon={<Reply size={12} />} onClick={onReplyToggle} className="-ml-2">
            Reply
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function CommentAttachments({ comment }: { comment: CommentView }) {
  return (
    <div className="flex flex-wrap gap-2" aria-label="Comment attachments">
      {comment.attachments?.map((attachment) => <ItemAttachment key={attachment.id} attachment={attachment} />)}
    </div>
  );
}
