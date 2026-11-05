import type { DiscussionMessage } from "@eo/core";
import { Markdown } from "@eo/ui";
import { moduleChangeNote, useModuleChangeCard } from "../../shared/modules/useModuleChangeCard";
import { Button, Chip } from "../kit";
import { MachineSpecificValues } from "./MachineSpecificValues";
import { useModuleApproval } from "./useModuleApproval";

/**
 * A change to a module that already exists, where the conversation is
 * (EO-418): the diff of its code and of its manifest, and the two things
 * a person does with one — apply it, then approve the module again.
 *
 * The body is the card EO drew when the reply was posted: the summary,
 * the diffs against what was saved at that moment, the test cases it adds,
 * replaces or removes, and what Apply will do. Nothing is saved until Apply is
 * pressed.
 *
 * Once applied the card keeps its place and trades Apply for Approve —
 * the module lost its approval by being changed, and this is where the
 * person was when that happened. Approve is `useModuleApproval`: the same
 * `modules:approve` call Settings → Modules makes, which runs the tests
 * at that moment and names each failing case when it refuses.
 */
export function ModuleChangeCard({ message, conversationId, onDone }: { message: DiscussionMessage; conversationId: string; onDone: () => void }) {
  const card = useModuleChangeCard(message, conversationId, onDone);
  const approval = useModuleApproval({ onApproved: card.refreshCatalog });
  const { offer, module } = card;
  const note = moduleChangeNote(offer, module?.name ?? "the module");

  return (
    <section aria-label="Proposed module change" className="flex flex-col gap-2.5 rounded-[14px] bg-canvas-subtle px-4 py-3.5">
      <Markdown className="text-[13px] leading-relaxed">{message.body}</Markdown>

      {offer === "apply" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" disabled={card.applying} onClick={card.apply}>
            {card.applying ? "Applying…" : "Apply change"}
          </Button>
          <span className="text-[11.5px] text-ink-subtle">or say what should change</span>
        </div>
      ) : null}

      {offer === "approve" && module ? (
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="paused">Applied · not approved</Chip>
          <Button variant="primary" size="sm" disabled={approval.approving} onClick={() => approval.approve(module)}>
            {approval.approving ? "Running its tests…" : "Approve"}
          </Button>
          <span className="text-[11px] text-ink-subtle">Approving runs its tests</span>
        </div>
      ) : null}

      {offer === "approved" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="success">Applied · approved</Chip>
        </div>
      ) : null}
      {note && offer !== "approved" ? <p className="text-[12.5px] leading-relaxed text-ink-muted">{note}</p> : null}
      {/* The saved module's machine-specific values (EO-449), once the
          change is what is saved — before Apply the catalog still holds
          the old code. Advice; Approve does not wait on it. */}
      {(offer === "approve" || offer === "approved") && module ? <MachineSpecificValues warnings={module.machineSpecific} /> : null}

      {card.problem ? (
        <p role="alert" className="text-[12px] text-danger">
          {card.problem}
        </p>
      ) : null}
      {/* One line per failing case, so kept as written. */}
      {approval.problem && offer === "approve" ? (
        <p role="alert" className="whitespace-pre-line text-[12.5px] text-danger">
          {approval.problem}
        </p>
      ) : null}
      {approval.dialog}
    </section>
  );
}
