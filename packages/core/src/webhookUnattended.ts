/**
 * Letting a webhook pipeline send without a person in between (EO-405).
 *
 * A pipeline a webhook job files onto is refused at publish while a step
 * that acts outside EO can be reached before anybody has read what
 * arrived (EO-334, `webhookSideEffectProblems`). That stays the default.
 * This is the one way past it: a setting on the one pipeline, off until
 * a person turns it on, after which the same finding is a warning rather
 * than a refusal. Since EO-522 a person does that with the button on a
 * card the assistant offers in its chat — the agent proposes, and only
 * the person's press sets it.
 *
 * The words live here rather than beside any one screen because several
 * places say them and must not drift: the assistant's card, the editors'
 * controls while they last, and the statement on the board's header. A
 * risk described two ways is two risks to whoever reads both.
 */

/** What the control is called. Says what happens, not what is waived. */
export const WEBHOOK_UNATTENDED_LABEL = "Send webhook items on without a person reading them";

/**
 * The risk, in the reader's words: what arrives, who controls it, and
 * what it can reach. Three sentences because it is three facts, and the
 * last says what EO does when this is left alone, so that off reads as a
 * protection and not as a missing feature.
 */
export const WEBHOOK_UNATTENDED_RISK =
  "A webhook delivers text written by someone outside your organisation, and anyone who can reach its address controls what it says. " +
  "On this pipeline that text becomes part of an agent's instructions, and with this on it can reach a step that sends — a reply, an email, " +
  "a change in another system — before anyone here has read it. " +
  "Left off, EO refuses to publish this pipeline until a person approves before any step that sends.";

/** The statement on the board's pipeline header. A fact in muted ink, not an alarm. */
export const WEBHOOK_UNATTENDED_CHIP = "webhook items sent on unread";

/** What that statement says when somebody hovers it, and where to change it. */
export const WEBHOOK_UNATTENDED_CHIP_TITLE =
  "Items arriving by webhook on this pipeline can reach a step that sends without a person reading them first. " +
  "Someone turned that on for this pipeline. Ask the assistant to stop it, and press the button on the card it offers.";

/** What turning it on answers where no webhook job files onto the pipeline. */
export const WEBHOOK_UNATTENDED_NO_ENTRY =
  "No webhook job files onto this pipeline, so there is nothing to send on unread. Nothing was changed.";

/**
 * The key a graph would carry the setting under, if a graph could.
 *
 * It cannot: `pipeline:save` has no such field, and the setting is
 * written by `pipelines:setWebhookUnattended` alone. Named so that the
 * MCP host can recognise a `pipeline_save` that tries anyway and refuse
 * it with a reason, rather than dropping the key and publishing the rest
 * as though nothing had been asked (invariants 8 and 11).
 */
export const WEBHOOK_UNATTENDED_KEY = "webhookUnattended";

/**
 * The kind of the assistant's card that changes the setting (EO-522) —
 * `AssistCardSchema`'s `pipelineWebhookUnattended`. Named here so the
 * sentences that send an agent to it cannot name a card that is not
 * there.
 */
export const WEBHOOK_UNATTENDED_CARD_KIND = "pipelineWebhookUnattended";

/**
 * What an agent is told when it tries to turn the setting on.
 *
 * Written for a transcript, like `sectionLockedMessage`: it says nothing
 * was written, why, and what the assistant may do instead — which is
 * explain the setting and offer the card whose button changes it
 * (EO-522). The person presses it; no tool does.
 */
export const WEBHOOK_UNATTENDED_AGENT_REFUSAL =
  "Nothing was published. Letting a pipeline send what a webhook delivers without a person reading it first is a risk only a person may accept, " +
  "and no tool can turn it on. Tell the person what it does — text from outside the organisation reaches a step that sends, unread — and that " +
  `they turn it on themselves through EO's assistant, by pressing the button on the card it offers ("${WEBHOOK_UNATTENDED_LABEL}"). If you are ` +
  `that assistant, return \`card\` with the kind \`${WEBHOOK_UNATTENDED_CARD_KIND}\`. The setting is only offered once a webhook job files onto ` +
  `the pipeline. Then send the graph again without \`${WEBHOOK_UNATTENDED_KEY}\`.`;

/**
 * What the control says where it cannot be changed here, because the
 * organisation publishes this machine's pipelines. Said beside the
 * control itself: a diverged copy's editor is live, and this is the one
 * thing in it that is still the administrator's.
 */
export const WEBHOOK_UNATTENDED_MANAGED = "Your organisation manages this pipeline, so only an administrator can change this, on the organisation's server.";
