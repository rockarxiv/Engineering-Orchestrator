import type { IpcPayload, IpcResponse } from "@eo/core";
import type { Db } from "../db/client.js";
import { getAgentAttachments, listAgentAttachments, setAgentAttachment } from "../db/repos/index.js";

/**
 * Which servers and skills each agent has been given, over IPC (EO-106).
 *
 * The first pair of channels in this feature that changes what a
 * dispatch does. Everything EO-104 and EO-105 landed reaches nobody
 * until a tick here, and a tick here takes effect on the *next*
 * dispatch — not on the next launch, which is what the provider cache
 * would have made of it, and not on the next item, which is what a
 * resumed thread would have made of it. Both of those are handled
 * outside this file, in `providerCacheKey` and `findReusableThread`.
 *
 * A refusal is a sentence, never a throw: an agent or a catalogue entry
 * deleted in another window between the screen listing it and the person
 * clicking it is a race, and races are not programmer error.
 */

export function listAgentAttachmentsCommand(
  db: Db,
  input: IpcPayload<"agentAttachments:list">,
): IpcResponse<"agentAttachments:list"> {
  // One agent's answer is still a list of one, so a caller that asked
  // about a particular agent unwraps the same shape as a caller that
  // asked about all of them — and an agent with nothing attached comes
  // back as an empty row rather than as no row, because it was asked
  // about by name.
  if (input.agentId !== undefined) return { attachments: [getAgentAttachments(db, input.agentId)] };
  return { attachments: listAgentAttachments(db) };
}

/**
 * Ticks one catalogue entry on or off for one agent.
 *
 * Idempotent in both directions — attaching what is attached and
 * detaching what is not are both fine — so a screen never has to know
 * what it last saw in order to send the right verb.
 */
export function setAgentAttachmentCommand(
  db: Db,
  input: IpcPayload<"agentAttachments:set">,
): IpcResponse<"agentAttachments:set"> {
  const result = setAgentAttachment(db, input);
  if (!result.ok) return { attachments: null, problem: result.problem };
  return { attachments: result.attachments, problem: null };
}
