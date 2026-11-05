import type { AgentRemovalImpact } from "@eo/core";
import type { AgentRemoval } from "../../../shared/agents/removal";
import { useChromeVocabulary } from "../../../query/hooks";
import { Button, Dialog } from "../../kit";
import { ItemKeyLink } from "../../conversation/references";

/**
 * The confirmation in front of archiving or deleting an agent (EO-350) —
 * the chat layout's drawing of `agents/ConfirmRemoveAgent`.
 *
 * What it says comes from the main process's unconfirmed
 * `agents:archive` / `agents:delete`, not from anything cached: who else
 * holds the role and which run is in progress are facts about this
 * moment. Nothing is offered to confirm until that answer is in, and a
 * refusal is shown as the sentence it came back as.
 */
export function ConfirmRemove({
  name,
  removal,
  impact,
  busy,
  problem,
  onConfirm,
  onCancel,
}: {
  name: string;
  removal: AgentRemoval;
  /** The unconfirmed answer. Null while it is being asked for. */
  impact: AgentRemovalImpact | null;
  busy: boolean;
  /** Why it was refused, or why the confirmed call failed. */
  problem: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const vocabulary = useChromeVocabulary();
  const verb = removal === "delete" ? "Delete" : "Archive";

  return (
    <Dialog
      open
      onClose={onCancel}
      // Locked only while the confirmed call is in flight, so its answer is
      // shown to somebody; while EO is still checking what the agent
      // staffs, closing loses nothing and is always a way out.
      busy={busy && impact !== null}
      title={`${verb} ${name}?`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {impact === null && problem !== null ? "Close" : "Keep it"}
          </Button>
          {impact !== null ? (
            <Button variant="danger" disabled={busy} onClick={onConfirm}>
              {verb} {name}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px] leading-relaxed text-ink-muted">
        {impact === null ? (
          problem === null ? (
            <p role="status">Checking what it staffs…</p>
          ) : null
        ) : (
          <>
            <p>
              {removal === "delete"
                ? "It disappears from this screen, archived agents included, and nothing dispatches it again. Its past runs and comments keep its name. This cannot be undone."
                : "Nothing dispatches it again and it staffs no role. Its runs and comments are kept, and nothing brings it back."}
            </p>

            {impact.steps.length > 0 ? (
              <div aria-label="Steps owned by its role" className="flex flex-col gap-1">
                <p>
                  Its role, <span className="font-mono text-ink">{impact.role}</span>, owns these steps:
                </p>
                <ul className="list-disc pl-5">
                  {impact.steps.map((step) => (
                    <li key={step.stepId}>
                      <span className="text-ink">{step.stepName}</span> in {step.pipelineName}
                    </li>
                  ))}
                </ul>
                {impact.leavesStepsWithNobody ? (
                  <p role="alert" className="text-paused">
                    {impact.agentName} is the last enabled agent on this role. These steps will have nobody, and {vocabulary.items.toLowerCase()} reaching
                    them will wait until another agent takes the role.
                  </p>
                ) : impact.coveredBy.length > 0 ? (
                  <p>Still covered by {impact.coveredBy.join(", ")}.</p>
                ) : null}
              </div>
            ) : null}

            {impact.activeRuns.length > 0 ? (
              <div role="alert" aria-label="Runs in progress" className="flex flex-col gap-1 text-paused">
                <p>It is working on this now. {verb === "Delete" ? "Deleting" : "Archiving"} cancels the run:</p>
                <ul className="list-disc pl-5">
                  {impact.activeRuns.map((run) => (
                    <li key={run.runId}>
                      <ItemKeyLink itemKey={run.itemKey} className="font-mono" /> {run.itemTitle}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {impact.lastSystemAgent ? (
              <p role="alert" className="text-paused">
                It is the last enabled system agent. The assistant will have nobody to answer.
              </p>
            ) : null}
          </>
        )}

        {problem !== null ? (
          <p role="alert" className="text-danger">
            {problem}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
