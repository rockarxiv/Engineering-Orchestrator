import { WEBHOOK_UNATTENDED_CHIP, WEBHOOK_UNATTENDED_CHIP_TITLE } from "@eo/core";
import { useWebhookUnattended } from "../../query/hooks";
import { Chip } from "../kit";

/**
 * Letting one pipeline send what a webhook delivers without a person
 * reading it first (EO-405) — the chat layout's drawing of it.
 *
 * Only the chip: the setting is changed through the assistant's card
 * (EO-522), and the editor's switch for it went with the editor
 * (EO-525). The words are `@eo/core`'s, so the two layouts cannot
 * disagree about what the setting is.
 */

/** The statement on a pipeline's header: muted ink, and nothing while the setting is off. */
export function WebhookUnattendedChip({ pipelineId }: { pipelineId: string | null }) {
  const { unattended } = useWebhookUnattended(pipelineId);
  if (!unattended) return null;
  return <Chip title={WEBHOOK_UNATTENDED_CHIP_TITLE}>{WEBHOOK_UNATTENDED_CHIP}</Chip>;
}
