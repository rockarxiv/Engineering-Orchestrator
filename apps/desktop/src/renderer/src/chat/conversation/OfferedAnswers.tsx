import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { answerOptions, type DiscussionMessage } from "@eo/core";
import { ipcQuery } from "../../query/client";
import { Button } from "../kit";

/**
 * The answers one of EO's own messages offers, as buttons (EO-586): a
 * guardrail stopping a draft's testing asks "keep going, publish anyway,
 * or discard?". Pressing one files it as the person's reply under the
 * message, which is what EO reads; the buttons go once a reply is there
 * (`canAnswer`), however it was given.
 */
export function OfferedAnswers({ message, conversationId, onDone }: { message: DiscussionMessage; conversationId: string; onDone: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const answer = useMutation({
    mutationFn: (option: string) => ipcQuery("comments:post", { itemId: conversationId, body: option, parentId: message.id, mentions: [], pinned: false }),
    onSuccess: () => onDone(),
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });
  const options = answerOptions(message.options);
  if (!message.canAnswer || options.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5" aria-label="Offered answers">
        {options.map((option) => (
          <Button
            key={option}
            size="sm"
            disabled={answer.isPending}
            onClick={() => {
              setProblem(null);
              answer.mutate(option);
            }}
          >
            {option}
          </Button>
        ))}
      </div>
      {problem !== null ? (
        <p role="alert" className="text-[12px] text-danger">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
