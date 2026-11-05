import { Sparkles } from "lucide-react";
import { actionOptions, type CommentOption } from "@eo/core";
import { Button, ErrorLine } from "./kit";
import { useOpenUpdateConflictChat } from "./updateConflictChat";

/**
 * The buttons on a comment that open something rather than answer it
 * (EO-533, `CommentActionOption`).
 *
 * Drawn apart from the offered answers, and pressing one posts nothing:
 * it is not a reply, and the mention it sits on stays open until what it
 * opened is settled. Each target opens through its own channel, and the
 * main process decides what it opens — the renderer sends which notice
 * was pressed and nothing it wrote itself.
 *
 * The first, and so far only, target is the assistant chat about a held
 * template update: Fix with assistant on the conflict notice
 * (`useOpenUpdateConflictChat`).
 */
export function CommentActions({ options, commentId, className }: { options: readonly CommentOption[] | null; commentId: string; className?: string }) {
  const actions = actionOptions(options);
  const { open, isPending, problem } = useOpenUpdateConflictChat();

  if (actions.length === 0) return null;
  return (
    <div className={className}>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Actions">
        {actions.map((action) => (
          <Button
            key={`${action.opens.type}:${action.label}`}
            size="sm"
            variant="primary"
            icon={<Sparkles size={12} />}
            disabled={isPending}
            onClick={() => open({ conflictId: action.opens.conflictId, commentId })}
          >
            {action.label}
          </Button>
        ))}
      </div>
      {problem ? <ErrorLine>{problem}</ErrorLine> : null}
    </div>
  );
}
