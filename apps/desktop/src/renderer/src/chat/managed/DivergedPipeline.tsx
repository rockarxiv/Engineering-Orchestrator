import { Link } from "react-router-dom";
import { DIVERGED_CHIP, DIVERGED_CHIP_TITLE, pipelineChangesPath } from "@eo/core";
import { useDivergence } from "../../query/hooks";
import { Chip } from "../kit";

/**
 * A pipeline this machine has edited out from under its organisation
 * (EO-331, `ARCHITECTURE.md`, "Divergence and suggestions") — the chat
 * layout's drawing of it.
 *
 * Only the chip. Suggesting the change or discarding it is done through
 * the assistant's cards (EO-521), and the notice that offered both on
 * the pipeline editor went with the editor (EO-525). The chip is a fact
 * rather than a warning: no alert role and no colour.
 */

/**
 * The chip on a pipeline's header: one word, in muted ink, and nothing
 * when the copy is the organisation's. A link to what the word is about
 * (EO-524): the Changes view on this machine's own edits.
 */
export function DivergedChip({ pipelineId }: { pipelineId: string | null }) {
  const { diverged } = useDivergence(pipelineId);
  if (!diverged || pipelineId === null) return null;
  return (
    <Link to={pipelineChangesPath(pipelineId, { kind: "local" })} aria-label={`${DIVERGED_CHIP} — see your edits`} className="inline-flex rounded-[7px] hover:opacity-80">
      <Chip title={DIVERGED_CHIP_TITLE}>{DIVERGED_CHIP}</Chip>
    </Link>
  );
}
