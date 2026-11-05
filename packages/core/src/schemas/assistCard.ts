import { z } from "zod";
import { WEBHOOK_UNATTENDED_CARD_KIND } from "../webhookUnattended.js";
import { SpecFieldDraftSchema } from "../itemTypeAuthoring.js";

/**
 * Something only a person may do, offered by the assistant as a card
 * whose button does it (EO-521).
 *
 * The pipeline editor is going (EO-517), and with it the last place a
 * person could export a pipeline to a file, import one, delete one, or
 * throw away this machine's edits to one their organisation manages.
 * None of them is the assistant's to do. Exporting puts a file where a
 * person chooses; importing brings code written elsewhere onto this
 * machine, after a person has read what it needs; deleting archives a
 * pipeline and everything on it; and discarding edits is deliberately a
 * person's decision (ARCHITECTURE.md, "Divergence and suggestions"). So
 * the assistant names the thing in a card, and the person presses the
 * card's button — the way a draft is published.
 *
 * Returning one applies nothing. The card is posted as a proposal; its
 * button calls `assist:applyCard`, which carries it out through the very
 * channel the editor used — `pipelines:export`, `pipelines:import`,
 * `pipelines:delete` or `pipelines:discardEdits` — and files what came of
 * it under the card, which is what makes it spent.
 *
 * One `kind` per thing a person can do, each naming only what the card
 * cannot be drawn without. Everything a person reads before pressing —
 * the pipeline's name, how many items it holds, what an import would
 * need here — is read by EO when the card is drawn, never taken from the
 * agent. Further kinds join the union (EO-522, EO-523) without a second
 * card pattern.
 *
 * Two of them are settings that are deliberately a person's (EO-522):
 * letting a webhook pipeline's items reach a sending step unread, and a
 * step's own secrets and environment variables. For the second, the
 * card names the step and the variable and nothing else — the value is
 * typed on the card by the person and travels only in the press, so it
 * reaches neither the agent nor anything stored about the card.
 *
 * Three are a project's item types (EO-523): adding one, changing one,
 * and removing one — what the editor's Types section did through
 * `itemTypes:create`, `update` and `delete`. The card shows the type as
 * it would be, read against the row as it is now; whatever the channel
 * would refuse — a pack's type reshaped, a type with items filed under
 * it, a name already taken — is shown on the card as the refusal.
 *
 * Every branch writes all of its keys, so it is the same document from
 * both backends: there is no optional field for a Codex agent to fill
 * with `null` (invariant #12). A change to a type says `null` for what it
 * leaves as it is, which both backends write the same way.
 */
/**
 * The card that keeps a pipeline as it is and skips its held template
 * update (EO-534): "Keep my pipeline and skip this update".
 */
export const KEEP_PIPELINE_CARD_KIND = "pipelineKeepMine";

/**
 * The publish card after a draft's trials (EO-588): what was proven, and
 * one button that publishes the pipeline and approves every module it
 * runs. See `TrialPublishCardSchema`.
 */
export const TRIAL_PUBLISH_CARD_KIND = "trialPublish";

export const AssistCardSchema = z.discriminatedUnion("kind", [
  z.object({
    /** Save one pipeline to a file, where the person chooses — the editor's Export. */
    kind: z.literal("pipelineExport"),
    /** The pipeline, by the id `pipelines_list` gives. */
    pipelineId: z.string().min(1),
  }),
  z.object({
    /** Import a pipeline file a person attached to this chat — the editor's Import. */
    kind: z.literal("pipelineImport"),
    /** The attachment, by the ID the conversation lists it under. Only a file attached to this chat. */
    attachmentId: z.string().min(1),
  }),
  z.object({
    /** Archive a pipeline and the items on it — the editor's Delete pipeline. */
    kind: z.literal("pipelineDelete"),
    pipelineId: z.string().min(1),
  }),
  z.object({
    /** Throw this machine's edits to an organisation pipeline away and take the published version back — "Discard my edits". */
    kind: z.literal("pipelineDiscardEdits"),
    pipelineId: z.string().min(1),
  }),
  z.object({
    /**
     * Let the items a webhook files onto a pipeline reach a step that
     * sends without a person reading them first, or stop letting them
     * (EO-522) — `pipelines:setWebhookUnattended`, a risk only a person
     * may accept (EO-405).
     */
    kind: z.literal(WEBHOOK_UNATTENDED_CARD_KIND),
    pipelineId: z.string().min(1),
    /** True to let them through unread; false to stop, so a person approves before any step that sends. */
    unattended: z.boolean(),
  }),
  z.object({
    /**
     * Set or clear one step's own module secret (EO-522) — the value that
     * step is given in place of the shared one. The person types the value
     * on the card; the agent never names it and never sees it.
     */
    kind: z.literal("stepSecret"),
    /** The step, by the id `pipeline_get` gives. */
    stepId: z.string().min(1),
    /** The secret's name, as a module's `needs.env` declares it. */
    name: z.string().min(1),
    action: z.enum(["set", "clear"]),
  }),
  z.object({
    /**
     * Set or clear one step's own environment variable (EO-522), typed on
     * the card by the person as a secret is. Not secret, but still the
     * person's to set: a variable reaches every process the step starts.
     */
    kind: z.literal("stepVariable"),
    stepId: z.string().min(1),
    name: z.string().min(1),
    action: z.enum(["set", "clear"]),
  }),
  z.object({
    /** Add an item type to a project (EO-523) — `itemTypes:create`, as the editor's "Add a type" did. */
    kind: z.literal("itemTypeCreate"),
    /** The project, by the id `projects_list` gives. */
    projectId: z.string().min(1),
    /** What one item of it is called — "Case". */
    label: z.string().min(1),
    /** And several — "Cases". */
    plural: z.string().min(1),
    /** Whether items of it hold other items rather than being the work. */
    container: z.boolean(),
    /** What an item of it carries beside its title and description, in order. */
    fields: z.array(SpecFieldDraftSchema),
  }),
  z.object({
    /**
     * Change one item type (EO-523) — `itemTypes:update`. Each of the
     * four is the value it would have, or null to leave it as it is. A
     * pack's type takes a new label and plural only, as in the editor.
     */
    kind: z.literal("itemTypeUpdate"),
    /** The type, by the id `item_types_list` gives. */
    itemTypeId: z.string().min(1),
    label: z.string().min(1).nullable(),
    plural: z.string().min(1).nullable(),
    container: z.boolean().nullable(),
    /** The whole field list as it would be, or null to keep the one it has. */
    fields: z.array(SpecFieldDraftSchema).nullable(),
  }),
  z.object({
    /** Remove one item type (EO-523) — `itemTypes:delete`. Only a type nothing is filed under, and never a pack's. */
    kind: z.literal("itemTypeDelete"),
    itemTypeId: z.string().min(1),
  }),
  z.object({
    /**
     * Keep a pipeline as it is and skip its held template update (EO-534)
     * — `pipeline:keepOwnVersion`. The conflict is resolved and the
     * pipeline's base moves to the held template version; its graph is
     * not touched. Offered beside the drafts that would resolve the
     * update another way.
     */
    kind: z.literal(KEEP_PIPELINE_CARD_KIND),
    /** The pipeline whose update is held, by the id `pipeline_update_conflict` was asked about. */
    pipelineId: z.string().min(1),
  }),
  z.object({
    /**
     * Publish the draft this conversation has been testing with real runs
     * (EO-588), once every test item of the newest round ended where it
     * was expected to, or the person chose "Publish anyway" at a
     * guardrail stop. It names nothing: the conversation has one trial
     * under test, and everything the card shows is EO's reading of it.
     */
    kind: z.literal(TRIAL_PUBLISH_CARD_KIND),
  }),
]);

export type AssistCard = z.infer<typeof AssistCardSchema>;
export type AssistCardKind = AssistCard["kind"];

/** Every kind of card, for a reader that has to tell them apart without a value in hand. */
export const ASSIST_CARD_KINDS = [
  "pipelineExport",
  "pipelineImport",
  "pipelineDelete",
  "pipelineDiscardEdits",
  "pipelineWebhookUnattended",
  "stepSecret",
  "stepVariable",
  "itemTypeCreate",
  "itemTypeUpdate",
  "itemTypeDelete",
  "pipelineKeepMine",
  "trialPublish",
] as const satisfies readonly AssistCardKind[];

/**
 * What a card says about itself on the message it is (EO-521) — see
 * `DiscussionMessage.card`.
 *
 * Its kind, so the conversation draws the right card, and what pressing
 * it came to: null while it is still to press. Everything else the card
 * shows is read with `assist:card` when it is drawn, so what it says
 * about a pipeline is true at the moment it is read.
 */
export const AssistCardViewSchema = z.object({
  kind: z.enum(ASSIST_CARD_KINDS),
  /**
   * What came of pressing it, as EO filed it under the card: `done` when
   * it was carried out, and false when it was refused, with the sentence
   * either way. Once there is one the card is spent — it shows this and
   * offers no button.
   */
  outcome: z.object({ done: z.boolean(), said: z.string() }).nullable(),
});

export type AssistCardView = z.infer<typeof AssistCardViewSchema>;
