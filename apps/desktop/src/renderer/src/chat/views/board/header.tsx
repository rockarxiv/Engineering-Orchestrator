import { Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../kit";
import { useAskAssistant } from "../../askAssistant";
import { DivergedChip } from "../../managed/DivergedPipeline";
import { WebhookUnattendedChip } from "../../managed/WebhookUnattended";
import { TemplateOrigin } from "./TemplateOrigin";
import { WatchIntakeChips } from "./WatchIntake";

/**
 * The head both ways of seeing a pipeline share: its name and the
 * "diverged" chip beside it, and the way to the assistant from an empty
 * one. The switch between board and graph is `PipelineViews`
 * (`../shared`), the same on both.
 */

/**
 * The pipeline's name, and beside it whether this board is drawn from
 * this machine's own copy of an organisation's pipeline (EO-331, ARCHITECTURE.md, "Divergence and
 * suggestions"):
 * a fact in muted ink, not a warning. And, in the same ink, whether what
 * a webhook files here is sent on with nobody reading it first (EO-405)
 * — on the head the board and the graph share, so it is said wherever
 * this pipeline is looked at. And the template it came from, with any
 * update applied lately or waiting for the person (EO-536). And each
 * watch job that files onto it, linking to the job (EO-754).
 */
export function PipelineTitle({ name, pipelineId }: { name: string; pipelineId: string }) {
  // Two groups that wrap rather than squeeze (EO-536): the name keeps its
  // own width, and the chips go under it — wrapping among themselves —
  // once a narrow canvas cannot hold both on one line. A row that would
  // not wrap left the name no width at all beside the template's chips.
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span data-pipeline-name className="min-w-0 max-w-full truncate">
        {name}
      </span>
      <span data-pipeline-chips className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5 text-[12px] font-normal">
        <DivergedChip pipelineId={pipelineId} />
        <WebhookUnattendedChip pipelineId={pipelineId} />
        <TemplateOrigin pipelineId={pipelineId} />
        <WatchIntakeChips pipelineId={pipelineId} />
      </span>
    </span>
  );
}

/**
 * What an empty board or graph says, and its one action. A pipeline is
 * changed through the assistant (EO-518), so that is where an empty one
 * points: the button opens the conversation with the cursor in its box,
 * or — with no chat frame around the view — goes to the chat.
 */
export const EMPTY_PIPELINE_TEXT = "Describe the pipeline you want to the assistant, and it will propose its steps for you to apply.";

export function AskAssistantButton() {
  const askAssistant = useAskAssistant();
  const navigate = useNavigate();
  return (
    <Button icon={<Sparkles size={13} />} onClick={() => (askAssistant ? askAssistant() : void navigate("/chat"))}>
      Ask the assistant
    </Button>
  );
}
