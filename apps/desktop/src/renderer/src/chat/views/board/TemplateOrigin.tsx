import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { templateOriginLabel, templateUpdatedLabel, templateVersionLabel, templateWaitingLabel, versionLabel, type PipelineTemplateWaiting } from "@eo/core";
import { useTemplateStatus } from "../../../query/hooks";
import { Button, Chip, Dialog, ErrorLine } from "../../kit";
import { useOpenUpdateConflictChat } from "../../updateConflictChat";

/**
 * Where a pipeline came from, and whether its template has news for it
 * (EO-536, ARCHITECTURE.md, "Template versions and origins") — on the
 * head the board and the Graph view share.
 *
 * - "From *Software feature to merge* v1.1": the template and the version
 *   the pipeline's base is. A fact, in muted ink.
 * - "Updated to v1.1", for a few days after EO applied an update: pressed,
 *   it shows that version's release notes.
 * - "Update waiting: 1 conflict", while an update is held: pressed, it
 *   opens the assistant chat about it, or — before anybody has pressed
 *   Fix with assistant — the notice that offers that button.
 *
 * Nothing at all for a pipeline made from no template. Nothing here
 * changes the pipeline: the update is resolved in the chat, by the
 * person publishing one of the assistant's drafts or keeping their own.
 */
export function TemplateOrigin({ pipelineId }: { pipelineId: string }) {
  const status = useTemplateStatus(pipelineId);
  const [notesOpen, setNotesOpen] = useState(false);
  if (status === null || status.origin === null) return null;
  const { origin, updated, waiting } = status;

  return (
    <>
      <Chip title={`This pipeline was made from the ${origin.title} template, and its base is version ${origin.version}.`}>{templateOriginLabel(origin)}</Chip>
      {updated === null ? null : (
        <>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={`${templateUpdatedLabel(updated)} — read the release notes`}
            onClick={() => setNotesOpen(true)}
            className="inline-flex rounded-[7px] hover:opacity-80"
          >
            <Chip>{templateUpdatedLabel(updated)}</Chip>
          </button>
          <Dialog
            open={notesOpen}
            onClose={() => setNotesOpen(false)}
            title={`${origin.title} ${templateVersionLabel(updated.version)}`}
            description={`EO applied this template update as the pipeline's ${versionLabel(updated.pipelineVersion)} on ${new Date(updated.at).toLocaleString()}.`}
            footer={<Button onClick={() => setNotesOpen(false)}>Close</Button>}
          >
            <div aria-label="Release notes" className="text-[13px] leading-relaxed whitespace-pre-line text-ink">
              {updated.notes === "" ? <span className="text-ink-subtle">This version came with no release notes.</span> : updated.notes}
            </div>
          </Dialog>
        </>
      )}
      {waiting === null ? null : <UpdateWaiting waiting={waiting} />}
    </>
  );
}

/**
 * The held update, as a button: to the chat about it where there is one,
 * else to a notice posted on the project thread before messages (EO-727).
 * Where neither exists — the notice is a message, on no item — it opens
 * the chat the notice's button would have.
 */
function UpdateWaiting({ waiting }: { waiting: PipelineTemplateWaiting }) {
  const navigate = useNavigate();
  const chat = useOpenUpdateConflictChat();
  const label = templateWaitingLabel(waiting);
  const goesTo = waiting.chatId === null && waiting.notice !== null ? "see the notice" : "open the assistant chat about it";

  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        aria-label={`${label} — ${goesTo}`}
        title={`Version ${waiting.toVersion} of this pipeline's template is waiting for you, and nothing from it has been applied: the pipeline works exactly as it did.`}
        disabled={chat.isPending}
        onClick={() => {
          if (waiting.chatId === null && waiting.notice !== null) {
            void navigate(`/items/${waiting.notice.itemId}`);
            return;
          }
          chat.open({ conflictId: waiting.conflictId, commentId: waiting.notice?.commentId ?? null });
        }}
        className="inline-flex rounded-[7px] hover:opacity-80"
      >
        <Chip tone="paused">{label}</Chip>
      </button>
      {chat.problem ? <ErrorLine>{chat.problem}</ErrorLine> : null}
    </span>
  );
}
