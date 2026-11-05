import { useState } from "react";
import type { CommentDelivery, MessageDelivery } from "@eo/core";
import type { LiveRun } from "../../../shared/transcript/grouping";
import { useChromeVocabulary } from "../../../query/hooks";
import { Composer } from "../../conversation/Composer";
import { Select } from "../../kit";

/**
 * A composer that knows an agent is working (EO-176).
 *
 * It says which turn a message is going into, and lets a person choose
 * when there is a choice: only when the run's own backend can be spoken
 * to mid-turn. A backend that cannot gets a sentence rather than a
 * control, because a dropdown whose second option does nothing is worse
 * than none (invariant 12). Used on the item and beside its transcript.
 */
export interface RunComposerProps {
  live: LiveRun | null;
  mentionables: string[];
  /** Posts the comment; `delivery` is undefined when nothing is running. Returns what became of it. */
  onSubmit: (body: string, mentions: string[], attachmentIds: string[], delivery: MessageDelivery | undefined) => Promise<CommentDelivery | null>;
  busy?: boolean;
  readOnly?: boolean;
  submitLabel?: string;
  placeholder?: string;
}

/** What the composer is about to do, in a sentence: "said now" and "queued" are minutes apart in effect. */
export function deliveryIntent(live: LiveRun, mode: MessageDelivery, item: string): string {
  if (!live.steerable) {
    return `${live.agentName} is working. Its backend cannot be spoken to mid-turn, so this will be read by the next run on this ${item.toLowerCase()}.`;
  }
  return mode === "now"
    ? `${live.agentName} is working — this will be said to it now, in the turn it is on.`
    : `${live.agentName} is working — this will be read by the next run rather than interrupting the turn it is on.`;
}

export function RunComposer({ live, mentionables, onSubmit, busy, readOnly, submitLabel, placeholder }: RunComposerProps) {
  const vocabulary = useChromeVocabulary();
  // Defaults to being heard now: somebody who opens the box while an agent
  // works is usually reacting to what they can see it doing.
  const [mode, setMode] = useState<MessageDelivery>("now");
  const [report, setReport] = useState<string | null>(null);
  const effective: MessageDelivery = live === null || live.steerable ? mode : "next";

  return (
    <div className="flex flex-col gap-1.5">
      <Composer
        mentionables={mentionables}
        busy={busy ?? false}
        readOnly={readOnly ?? false}
        {...(submitLabel === undefined ? {} : { submitLabel })}
        {...(placeholder === undefined ? {} : { placeholder })}
        onSubmit={async (body, mentions, attachmentIds) => {
          setReport(null);
          const delivery = await onSubmit(body, mentions, attachmentIds, live === null ? undefined : effective);
          // Only when it differs from what was asked: a message that missed
          // its turn is the thing invariant 8 will not leave unsaid.
          setReport(delivery?.note ?? null);
        }}
      />

      {live !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[11.5px] leading-snug text-ink-subtle">{deliveryIntent(live, effective, vocabulary.item)}</p>
          {live.steerable ? (
            <Select aria-label="Send behavior" value={effective} onChange={(event) => setMode(event.target.value as MessageDelivery)} className="w-[13rem]">
              <option value="now">Say it now</option>
              <option value="next">Queue for the next turn</option>
            </Select>
          ) : null}
        </div>
      ) : null}

      {report ? (
        <p role="status" className="text-[11.5px] text-paused">
          {report}
        </p>
      ) : null}
    </div>
  );
}
