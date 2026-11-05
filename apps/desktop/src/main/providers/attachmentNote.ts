import type { AgentInputAttachment } from "@eo/core";

/**
 * What an agent is told about the files that came with a message.
 *
 * Metadata only: each file's id, name and MIME type, and the tool that
 * reads it. The bytes stay behind `attachment_read`, which is named
 * without either backend's punctuation (invariant 12) because this one
 * sentence goes to both.
 *
 * One function because there are four places that say it — a fresh
 * turn and a resumed one on each backend — and since EO-395 a fifth and
 * sixth: a message steered into a turn that is already running. That
 * one is why `text` may be empty. A screenshot with nothing typed under
 * it is a message, and steering it as an empty string would be telling
 * the agent nothing at all, so the note stands on its own there.
 */
export function withAttachmentNote(text: string, attachments: readonly AgentInputAttachment[] = []): string {
  if (attachments.length === 0) return text;
  const metadata = attachments.map((attachment) =>
    `- ID: ${attachment.id}; name: ${attachment.name}; MIME type: ${attachment.mimeType}; size: ${attachment.size} bytes; origin: ${attachment.origin}; synchronization state: ${attachment.synchronizationState}`,
  );
  const note = `Attachments (metadata only; use attachment_read for content):\n${metadata.join("\n")}`;
  return text === "" ? note : `${text}\n\n${note}`;
}
