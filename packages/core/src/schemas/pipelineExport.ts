import { z } from "zod";
import { namesAdminServer } from "../agent-capabilities.js";
import { EntryRulesSchema } from "../entryRules.js";
import { ConnectorSetupSchema, connectorSetupProblems } from "./connectors.js";
import { PipelineStepViewSchema, StepRouteViewSchema } from "../ipc-schemas.js";
import { ActionOverridesSchema } from "../registry/index.js";
import { ActionResultSchema } from "./actionDefinition.js";
import { ModuleManifestSchema, ModuleTestCaseInputSchema } from "./modules.js";
import { JsonSchemaDocumentSchema } from "./outputSchema.js";
import { SpecShapeSchema } from "./specShape.js";

/**
 * A pipeline as a file (KAN-108).
 *
 * The reason the module contract is shaped the way it is. A module
 * declares everything it touches — `needs.bin`, `needs.env`,
 * `needs.network` — and has nothing else in scope, so an import can
 * answer "what does this need on your machine" *before* anything runs.
 * A step holding a shell command line could never support that: the
 * command reaches the ambient PATH and the whole environment, and a
 * `needs` typed beside it would be a comment nothing enforces.
 */

/**
 * Bumped when the shape changes in a way an older EO cannot read.
 *
 * Checked rather than ignored, because a partially-imported pipeline is
 * worse than a refused one: half a graph is not a smaller graph.
 *
 * **2 (KAN-178).** The document carries the roles its agent steps name,
 * each with the prompt that role runs on — the original design's widening, which is what turns this
 * document into a pack: "that
 * document plus … the roles with prompts … One file, one format
 * version, the same import gate." A prompt is where a tool is named in
 * prose, so it is what the import preflight has to read to tell the
 * person that what they are about to adopt still calls `ticket_detail`.
 *
 * Bumped rather than added quietly, even though `roles` defaults to
 * empty and an older build would parse the rest of the document
 * perfectly: that build would drop the prompts without a word, and
 * silently dropping the half of a pack that says what an agent is meant
 * to do is exactly what this number exists to prevent.
 *
 * **3 (EO-310).** A human step declares its results — the buttons a
 * person is offered and whether taking one needs a reason typed first
 * (ARCHITECTURE.md, "Results and routes") — and the document carries them, because they are the
 * graph's
 * own shape rather than a fact about the machine that exported it.
 *
 * Bumped for version 2's reason, and the consequence here is sharper
 * than dropped prose. `results` defaults to empty, so a build that
 * predates this reads the document perfectly and writes a pipeline whose
 * human steps offer *nothing* — and then `validatePipeline` on that
 * build has no opinion about it either, because its checks arrived with
 * the field. The person gets a graph that looks like the one they
 * imported, with every branch drawn out of the approval step and no way
 * on earth to take one. Refused by the number instead: an older EO says
 * "update EO and try again", which is a sentence somebody can act on.
 *
 * **4 (EO-314).** The document becomes a **data pack**
 * (`ARCHITECTURE.md`, "One document"): the item types with their spec
 * shapes, the roles widened to carry their output schemas as JSON
 * Schema and the tool surface each asks for, the connector definitions,
 * the vocabulary, and a template item for Preview. "One file, one format
 * version, the same import gate."
 *
 * Bumped for version 2's and 3's reason, and here what an older build
 * drops silently is the whole pack: it reads the graph perfectly and
 * writes a pipeline with no types to file work under, no prompts, and no
 * idea that a role asked for a tool surface — an installation that looks
 * imported and can do nothing. It says "update EO and try again"
 * instead.
 *
 * Reading an *older* document stays possible, and that is the other half
 * of this number: every field the pack added is defaulted, so a version
 * 1, 2 or 3 export parses as a pack that ships no types, no connectors
 * and no vocabulary — which is precisely what it is.
 *
 * **5 (EO-315).** A declared MCP server carries its **connector setup**:
 * whether a person pastes a value or signs in, the names those values
 * are stored under, and where the OAuth round trip goes.
 *
 * Bumped on the same argument as every number above it, and the silent
 * drop here is a sharp one. A version-4 build strips the field it has
 * never heard of, so the pack imports *looking* complete — the server is
 * declared, its capability line is on the gate, the role is wired to it
 * — and the one thing the pack existed to arrange is missing: there is
 * no Connect button anywhere in the product, and no name for the
 * credential to be stored under. Nothing says so, because nothing knows.
 * "Update EO and try again" is the sentence somebody can act on.
 *
 * Reading older documents is unchanged: `connector` defaults to null, so
 * a version 1 to 4 export parses as a pack whose servers are servers
 * rather than connectors, which is exactly what they are.
 *
 * **6 (EO-316).** A pack may describe itself as a **gallery template**:
 * the plain description a card shows, the version it is at, and the
 * blanks it asks rather than sending somebody into an empty
 * conversation (`ARCHITECTURE.md`, "The gallery", "What a person sees first").
 *
 * In the pack rather than beside it, because that is what a template
 * *is* — "a set of templates, each a data pack" (the original design) — and a gallery
 * whose descriptions lived in a second file would be a gallery that can
 * only show the templates EO shipped. A fetched one has to carry its own
 * words, and a pack passed hand to hand has to arrive with them.
 *
 * Bumped for version 4's reason and with the sharpest consequence yet: a
 * build that predates this reads the document perfectly and drops the
 * questions. The person gets the pipeline with no folder chosen, no
 * schedule and no key prefix — every blank the template existed to ask
 * silently unasked, and nothing anywhere to say one was missed.
 *
 * Its own number rather than sharing 5 with the connector setup above,
 * even though the two land in the same release and no build will ever
 * have read one without the other. What this number is *for* is telling
 * a reader which fields a document may carry, and a pack is a file that
 * outlives the release it was written in — two changes folded into one
 * number would leave the next person unable to say which of them a
 * document at version 5 was written against.
 *
 * **7 (EO-355).** A module carries its **test cases**: each one's
 * description and source.
 *
 * Bumped for version 4's reason. A version-6 build strips the field and
 * imports every module with no tests at all — which it then cannot
 * approve, since approving runs them (EO-353) and a module with none is
 * refused. The person is left to rewrite, by hand or with the agent,
 * cases that were in the file they were handed. "Update EO and try
 * again" costs them a download instead.
 *
 * Reading an older document is unchanged in kind: `tests` defaults to
 * empty, so a version 1 to 6 export imports its modules with no tests,
 * and each shows as not fully tested until somebody writes some — which
 * is exactly what it is.
 *
 * **8 (EO-424).** A role carries its **action definitions**: for each
 * action it defines, the description, the results with their labels and
 * meanings, and the fields.
 *
 * Bumped for version 4's reason. A version-7 build strips `actions` and,
 * since a definition no longer travels as a generated schema under
 * `schemasByAction`, imports the role defining nothing: every step that
 * dispatches one of those actions answers in prose, is read as `done`,
 * and parks on the first step that routes on any other key. The graph
 * looks imported and no item gets through it. "Update EO and try again"
 * is the sentence somebody can act on.
 *
 * Reading an older document is unchanged: `actions` defaults to empty,
 * and a version 1 to 7 export that carries `schemasByAction` still has
 * each schema turned into a definition by the mapping EO-421 added.
 *
 * **9 (EO-456).** A step carries **keep checking** — how often it checks
 * and when it gives up — and a module's manifest says whether it **can
 * wait** (`watch`).
 *
 * Bumped for version 4's reason, and the silent drop here changes what a
 * step *does*. A version-8 build strips both fields and imports the step
 * as one that runs once: a pipeline built to wait on a signature for a
 * week invokes its check a single time, gets `waiting` back as a result
 * nothing routes, and parks the first item that reaches it — or, on a
 * module whose manifest lost its flag, a step that can no longer be set
 * to wait at all. Nothing says so, because nothing knows. "Update EO and
 * try again" is the sentence somebody can act on.
 *
 * Reading an older document is unchanged: `watch` defaults to null on a
 * step and to absent on a manifest, so a version 1 to 8 export imports
 * every step as one that runs once — which is exactly what it was.
 *
 * **10 (EO-571).** A step's keep checking can say it **never gives up**
 * (`watch.neverGivesUp`), and keeps checking until a check has a result.
 *
 * Bumped for version 4's reason, and the silent drop here is a deadline
 * nobody asked for. A version-9 build strips the flag, since zod drops a
 * key it does not know, and reads the step's `giveUpAfterHours`, which
 * is a week when left out. So a pull request a person takes a month to
 * review parks after seven days with "has stopped checking", on a
 * pipeline whose author said it never would. The flag is a key of its own
 * rather than a word in place of the hours so that an older build parses
 * the document and refuses it here, with "Update EO and try again". A
 * string where it reads a number would fail as "damaged" instead.
 *
 * Reading an older document is unchanged: the flag is absent, so a
 * version 1 to 9 export imports every watch with the deadline it had.
 *
 * **11 (EO-610).** A pipeline carries its **entry rules**.
 *
 * Bumped for version 4's reason, and the silent drop here opens a door.
 * A version-10 build strips the key and imports a pipeline that takes
 * anything, under the name of one its author said would not.
 *
 * Reading an older document is unchanged: the key is absent, so a
 * version 1 to 10 export imports a pipeline that asks for nothing.
 *
 * **12 (EO-736).** An entry rule may be a **module rule**, naming by slug
 * an entry-check module the document carries, with its own time limit.
 *
 * Bumped for version 11's reason, and the silent harm here is a door that
 * looks guarded and is not. A version-11 build parses `module` as a kind,
 * drops the `module` and `timeoutMs` keys it does not know, and keeps a
 * rule naming no module — or, judged as data, refuses everything. Neither
 * is what the author published. "Update EO and try again" is.
 *
 * Reading an older document is unchanged: no rule in it is a module rule.
 *
 * **13 (EO-762).** A document may carry **more than one board**
 * (`boards`), with routes from a step on one to a step on another.
 *
 * Bumped for version 4's reason, and the silent drop here is a whole
 * board. A version-12 build strips `boards` and imports the first board
 * alone: where it routes into the others it is refused as damaged, and
 * where it does not it imports half a template, under the template's
 * name, and nothing says so. "Update EO and try again" is the sentence.
 *
 * Reading an older document is unchanged: it carries one board.
 */
export const PIPELINE_EXPORT_VERSION = 13;

/**
 * An action a role defines, as the document carries it (EO-424).
 *
 * The definition itself rather than the schema EO generates from it. A
 * generated schema says which keys `result` may take and nothing about
 * what each means, so a definition that travelled as one arrived with
 * its labels guessed from its keys and its meanings and description
 * gone — and the meaning is the sentence that tells the agent which of
 * the keys is true.
 *
 * No `role`, because it sits inside the role it is defined for, and no
 * `id` or timestamps, for `ExportedModuleSchema`'s reason: those are
 * local. Deliberately loose about what a key may look like: the rules a
 * definition is held to are `readActionDefinitionDraft`'s, the import
 * asks them of every entry before it writes anything, and a second copy
 * of them here would be a second answer for a file to fall between.
 */
export const ExportedActionSchema = z.object({
  action: z.string().min(1),
  description: z.string().default(""),
  results: z.array(ActionResultSchema),
  /** The extra answer properties, as a JSON Schema describing an object. `{}` for none. */
  fields: z.record(z.string(), z.unknown()).default({}),
});

/**
 * A role the document's steps need, and the prompt it runs on
 * (`ARCHITECTURE.md`, "One document").
 *
 * The prompt as the exporting machine has it, which is the agent's
 * instructions rather than the file a pack shipped: EO owns the text it
 * wrote and a person owns the text they edited (`roles/prompts.ts`), so
 * the tuned version is the one worth carrying and the one that can
 * still name a tool EO has renamed.
 *
 * No credential, ever. A backend and a model travel as of EO-314 and
 * travel as a **recommendation** (the original design): "a pack names the role each
 * agent step needs and the installing machine chooses the agent … it may
 * recommend a backend and model. It may not require one." So an import
 * binds the agent it creates to that backend only where this machine is
 * signed in to it, and otherwise leaves it unbound for a person to
 * choose — which is the same sentence the original design writes as "role slots land
 * unfilled", said now that the prompt and the tool surface have
 * somewhere to land.
 */
export const ExportedRoleSchema = z.object({
  slug: z.string().min(1),
  /**
   * The prompt the role runs on, or null where the exporting
   * installation has nobody in it (EO-424).
   *
   * Null rather than empty, because the two are different facts: an
   * empty prompt is an agent somebody left blank, and null is no agent
   * at all. A role with nobody in it used to contribute nothing to the
   * document, and still does unless it defines actions — a definition
   * is the role's rather than an agent's, it outlives the agent being
   * archived, and the steps that dispatch it are in this file. So the
   * entry is there to carry `actions`, and the import writes those and
   * makes no agent out of a prompt nobody wrote.
   */
  prompt: z.string().nullable(),
  /**
   * What each of this role's actions must answer in, as JSON Schema
   * (ARCHITECTURE.md, "One document", "Zod for schemas in code, ajv for schemas that arrive as
   * data").
   *
   * JSON Schema rather than zod because zod can emit it and cannot
   * consume it, and a pack is a file: the receiving machine reads a
   * document. `jsonSchemaOutputSchema` is what turns one back into
   * something the validation path takes, so a pack-shipped shape and a
   * code pack's zod one sit behind the same interface (`OutputSchema`).
   *
   * Keyed by action, exactly as `RoleEntry.schemasByAction` is, because
   * that is the lookup — a step dispatches a role on an action, and the
   * action is what the result is held to.
   *
   * As of EO-424 this is where a **code pack's** role states its shipped
   * shapes and nothing else: an action the role defines for itself
   * travels in `actions` below. A document from before that carries its
   * definitions here as generated schemas, and still imports.
   */
  schemasByAction: z.record(z.string().min(1), JsonSchemaDocumentSchema).default({}),
  /**
   * The actions this role defines for itself (EO-424) — see
   * `ExportedActionSchema`.
   *
   * Where an action is named both here and in `schemasByAction`, this is
   * the one that is read: it says everything the schema does and what
   * the schema cannot.
   */
  actions: z.array(ExportedActionSchema).default([]),
  /**
   * The tool surface this role asks for, or null where it asks for
   * nothing in particular.
   *
   * Shown to the person as **capabilities** rather than as tool names
   * (the original design): "reads your Slack channels" is a sentence
   * somebody can agree to, and `mcp__slack__conversations_history` is
   * not. And refused outright when it names EO's administrative server
   * — see `ADMIN_GRANT_REFUSAL` below.
   *
   * Null rather than `[]`, because the two mean different things to
   * every reader of `allowedTools`: an absent list is "whatever the
   * provider advertises, and nothing is *granted*", and an empty one is
   * "nothing at all". A pack that says nothing about tools must not be
   * read as a pack that forbids them.
   */
  allowedTools: z.array(z.string()).nullable().default(null),
  /**
   * The backend and model this pack was built against — a
   * recommendation, never a requirement (the original design).
   *
   * "The author cannot know what the reader has signed in." So a pack
   * names the *role* each agent step needs, and this pair is shown
   * beside the role on import as what the author ran it on. The
   * installing machine binds the agent to it only if that backend is
   * signed in here, and otherwise leaves the agent unbound for a person
   * to choose.
   */
  backend: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
});

/**
 * An item type the pack ships, exactly as the registry holds one
 * (ARCHITECTURE.md, "One document", "An item type is data").
 *
 * The same seven fields `ItemTypeEntry` has, and deliberately not a
 * reduced copy of them: a type whose `specShape` did not travel is a
 * type that demands nothing, so an item filed under it on the far side
 * would be accepted without the fields the pack exists to collect — and
 * a type whose `actionOverrides` did not travel would refine as a leaf
 * on a container, which is the branch KAN-163 removed.
 *
 * No `id` and no project, for `ExportedModuleSchema`'s reason: both are
 * local. A type is identified across machines by the pack that shipped
 * it and its own word, which is what `qualifiedItemType` spells.
 */
export const ExportedItemTypeSchema = z.object({
  packSlug: z.string().min(1),
  slug: z.string().min(1),
  label: z.string().min(1),
  plural: z.string().min(1),
  container: z.boolean(),
  specShape: SpecShapeSchema,
  actionOverrides: ActionOverridesSchema.default({}),
});

/**
 * A connector the pack expects to reach something outside EO (ARCHITECTURE.md, "One document").
 *
 * The **definition**, never the connection: which site, which token and
 * which project key are facts about the installation that exported it,
 * and `connector_bindings.config` holds them. What travels is that this
 * pack talks to Jira, what Jira is called, and what reaching it means
 * in the person's words — so an import can land it **disconnected** and
 * say so on the needs check (ARCHITECTURE.md, "Import is the needs check") instead of carrying
 * somebody's
 * credentials to a stranger.
 *
 * `description` is the line the preflight shows as a capability, and
 * `mcpServer` is what ties it to a tool surface: a role granted
 * `mcp__slack__*` is asking for whatever the pack's `slack` connector
 * says it does.
 */
export const ExportedConnectorSchema = z.object({
  slug: z.string().min(1),
  label: z.string().min(1),
  /** One line, in the person's words: "reads your Slack channels". */
  description: z.string(),
  /** The MCP server this connector is reached through, where it is one. */
  mcpServer: z.string().nullable().default(null),
});

/**
 * An MCP server the pack's roles reach, as the person is told about it
 * (EO-314, ARCHITECTURE.md, "The `eo_admin` grant").
 *
 * **The name and the words, never the command.** A definition here
 * carries what the far side has to *say* — "reads your Slack channels",
 * which is the capability line the import gate shows — and nothing it
 * would have to *run*. Carrying the transport would mean a document
 * could write a row naming a command to spawn, which is a pack shipping
 * executable configuration under a different name; modules travel that
 * way and land unapproved for exactly that reason, and a server has no
 * equivalent gate. So an import writes no server row at all: the person
 * adds the server, with its command and its secrets, the way they add
 * every other one.
 *
 * `description` is the server definition's own, carried because the
 * machine reading this pack has no `slack` row to read it off — which is
 * the whole situation a pack is for.
 *
 * `connector` is the other half of the same argument, and the reason it
 * is safe under the same rule (EO-315). A pack that ships a connector is
 * the ordinary case — "the person sees Connect Slack, signs in, and the
 * step's list gains an entry" is the design's whole sentence — and the setup
 * is exactly what a document *may* carry: a label, whether a person
 * pastes a value or signs in, the names those values are stored under,
 * and where the OAuth round trip goes. Not one word of it is a
 * transport, so the rule above is untouched: the person still says how
 * the server runs. What travels is what they would otherwise have had to
 * be told out of band and type by hand.
 *
 * Held to `connectorSetupProblems` by the refinement at the bottom of
 * this file, on the same grounds the admin grant is refused there: a
 * setup whose flow cannot complete is a Connect button that does nothing
 * on the machine that trusted the pack, and the person who can still fix
 * it is the author.
 */
export const ExportedMcpServerSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  /** The setup flow, where this server is a connector. Null for a server a person simply configures. */
  connector: ConnectorSetupSchema.nullable().default(null),
});

/**
 * The words this pack puts in front of a person (ARCHITECTURE.md, "What a pack labels", "One
 * document").
 *
 * Derived rather than stored, and that is the decision worth writing
 * down. A pack labels its types, its steps and its results, and every
 * one of those labels is already carried by something else in this
 * document — the type rows carry their own, a step carries its name, a
 * result carries the word on its button. A second copy that could
 * disagree with the first would be a vocabulary nothing keeps true.
 *
 * So this block is the same words gathered in one place, for the two
 * readers that want the vocabulary without walking the graph: the
 * import screen, which says what this pack calls things before anybody
 * agrees to it, and the diff a suggestion is reviewed as (ARCHITECTURE.md, "Divergence and
 * suggestions").
 * Reproducing it on the far side is therefore reproducing the rows and
 * the steps, which is what the round-trip test asserts.
 */
export const ExportedVocabularySchema = z.object({
  /** `developer:story` → "Story" / "Stories", one entry per type the pack ships. */
  types: z
    .array(z.object({ type: z.string().min(1), label: z.string().min(1), plural: z.string().min(1) }))
    .default([]),
  /** `approved` → "Ship it": what this pack's steps call each result they offer. */
  results: z.array(z.object({ key: z.string().min(1), label: z.string().min(1) })).default([]),
});

/**
 * The template item a pack ships for Preview (ARCHITECTURE.md, "Preview", "One document").
 *
 * Preview walks an example item through every step with canned output,
 * before the person has signed anything in — so the example has to
 * arrive with the pack rather than be made up by the machine reading it.
 *
 * **Authored, never harvested.** Nothing in EO writes this today, and
 * the exporter deliberately does not fill it from the newest item on the
 * pipeline: that item is somebody's actual work, and putting it into a
 * file meant to carry a *pipeline* would leak a customer's complaint or
 * an unreleased feature to everyone the pack is sent to. It is in the
 * format so that a gallery template — which is authored — can carry one
 * and this build imports it unharmed; where a preview item is written is
 * the gallery story's.
 *
 * Nothing is created from it on import, for the same reason nothing is
 * created from a pack's connectors: a preview item is Preview's to make,
 * marked as Preview and excluded from inbox, archive and cost.
 */
export const PreviewItemSchema = z.object({
  title: z.string().min(1),
  /** `developer:story` — qualified, because two packs may ship the same word (ARCHITECTURE.md, "An item type is data"). */
  type: z.string().min(1),
  body: z.string().default(""),
  spec: z.record(z.string(), z.unknown()).default({}),
});

/**
 * What the import gate says to a pack that asks for the admin grant
 * (ARCHITECTURE.md, "The `eo_admin` grant", invariant #11).
 *
 * The exact line the screen shows, held here because three places have
 * to say the same thing: the schema that refuses the document, the
 * preflight that reports it, and the import that refuses it a second
 * time for a caller holding a document it did not parse here.
 *
 * **Refused, not stripped.** Stripping would import a pack that quietly
 * does less than it says — a role whose prompt tells an agent to
 * reconfigure the installation, with the tools to do it silently
 * removed — and leave nobody to notice. A pack is data, `allowedTools`
 * is what invariant #11 governs, and data deciding it is the thing that
 * invariant exists to prevent. So the answer is no, said out loud, and
 * nothing is written.
 */
/**
 * One blank a template asks before it creates anything (the original design).
 *
 * "The template already knows what the person wants; it lacks which
 * folder, which channel, which day, who approves." So this is the
 * *question*, never the answer: a pack carries what to ask and the
 * installing machine carries what was said, which is the same line
 * `inputs` and `workspaceId` are already omitted from the document for.
 *
 * `kind` is what the form draws and what "Use this" does with the value,
 * and the four that do something are the four the design names. Each is a
 * blank EO knows how to *act* on rather than merely store:
 *
 *  - `folder` becomes the project's folder workspace;
 *  - `schedule` becomes a job on the pipeline;
 *  - `keyPrefix` becomes the project's key prefix;
 *  - `connector` names one of the pack's connectors to set up;
 *  - `stepInput` sets a module step's declared input, named
 *    `stepId.inputName` — the half of the form that comes from
 *    `pipeline_steps.inputs` rather than from this list.
 *
 * A kind EO does not know how to act on is deliberately absent. A free
 * `text` blank would be a value collected and dropped on the floor,
 * which is the failure the whole gate exists to prevent.
 */
export const TemplateBlankKindSchema = z.enum(["folder", "schedule", "keyPrefix", "connector", "stepInput"]);
export type TemplateBlankKind = z.infer<typeof TemplateBlankKindSchema>;

export const TemplateBlankSchema = z.object({
  /** What the answer is filed under. For `stepInput`, `<stepId>.<inputName>`. */
  key: z.string().min(1),
  kind: TemplateBlankKindSchema,
  /** The line above the field: "Where the reports go". */
  label: z.string().min(1),
  /** One sentence under it, or empty. */
  help: z.string().default(""),
  /**
   * Whether "Use this" may proceed without it.
   *
   * A blank that is not required is one the needs check will later say
   * is red — which is the honest arrangement for a connector nobody can
   * authorise before signing in (ARCHITECTURE.md, "The needs check"), and the wrong one for the
   * folder
   * the pipeline writes into.
   */
  required: z.boolean().default(true),
  /** What the field starts at. A string in every kind, parsed by the kind. */
  default: z.string().default(""),
  /** For `connector`, which of the pack's connectors this is about. */
  connector: z.string().nullable().default(null),
});
export type TemplateBlank = z.infer<typeof TemplateBlankSchema>;

/**
 * What makes this pack a gallery template (ARCHITECTURE.md, "The gallery", "Preview").
 *
 * Null on an ordinary export, which is what an exported pipeline is: a
 * person sending their graph to a colleague is not publishing a
 * template, and a `title` and `description` invented for them would be a
 * machine writing marketing copy about somebody's work.
 *
 * `version` travels with the pack rather than with the index that listed
 * it, for the reason the description does: "a fetched template is shown
 * with its source and version" (ARCHITECTURE.md, "The gallery"), and a pack passed on from a
 * person's downloads folder has no index behind it to be asked.
 */
export const PackTemplateSchema = z.object({
  /** Stable across versions — it is what a card is chosen by. */
  slug: z.string().min(1),
  /** "Weekly report". The pipeline's own name may differ and usually does. */
  title: z.string().min(1),
  /** Plain words, for somebody who has never seen EO. */
  description: z.string().min(1),
  /** The author's own, shown beside the source. Free-form: "1.0", "2026-09-01". */
  version: z.string().min(1),
  blanks: z.array(TemplateBlankSchema).default([]),
  /**
   * What the assistant asks first, about the first item (EO-664): "What
   * is the first feature you want built?".
   *
   * For a template with no job, which has no first item of its own to
   * start: first run ends in an assistant chat whose brief carries this
   * question, and the plan the assistant files from the answer is the
   * first item. Absent, the brief asks a generic question built from the
   * title and description.
   *
   * Not a reason to bump `PIPELINE_EXPORT_VERSION`: an older build drops
   * it and asks the generic question, which is still the right thing to
   * ask.
   */
  openingQuestion: z.string().min(1).optional(),
});
export type PackTemplate = z.infer<typeof PackTemplateSchema>;

export const ADMIN_GRANT_REFUSAL = "This pack asks for admin tools. EO does not allow that from a pack.";

/**
 * How a refusal about a connector's setup opens (EO-315).
 *
 * A prefix rather than a whole sentence, because what is wrong is
 * `connectorSetupProblems`' to say and it says several different things.
 * `parseExport` matches on this to tell "the connector in this pack is
 * not one EO could complete" from "this file is damaged" — the same
 * arrangement the admin grant has, and for the same reason: a person
 * told their file is broken cannot act on it, and the author can act on
 * this immediately.
 */
export const CONNECTOR_SETUP_REFUSAL = "This pack ships a connector EO could not set up.";

/**
 * A module travelling with a pipeline.
 *
 * `id` is deliberately absent. Ids are local — a module means the same
 * thing on two machines and has a different uuid on each — so the
 * document refers to modules by slug, and the steps that name one are
 * rewritten to slugs on export and back to ids on import.
 *
 * `approvedAt` is absent for a stronger reason: approval does not
 * travel. It records that somebody *here* read this code, and an
 * exported approval would be a stranger's word for it.
 */
export const ExportedModuleSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  code: z.string().min(1),
  manifest: ModuleManifestSchema,
  /** Kept so the translation stays diffable on the far side too. */
  originalScript: z.string().nullable().default(null),
  /**
   * Its test cases, by description and source (EO-355).
   *
   * Travelling with the code because they are what approving it runs
   * (EO-353): a module that arrived without them could not be approved
   * on the far side until somebody wrote them again. Ids and timestamps
   * stay behind with the module's own id, for that id's reason.
   *
   * Their latest *result* stays behind too, as approval does: it is a
   * record of the code running on another machine, and the case runs
   * again here, against a scripted ctx, before anything relies on it.
   *
   * Defaulted, so a document from before this imports with no tests
   * rather than being refused as damaged — see `PIPELINE_EXPORT_VERSION`.
   */
  tests: z.array(ModuleTestCaseInputSchema).default([]),
});

/** A board's own head: its name, icon, where work enters and what it must have to. */
export const ExportedPipelineHeadSchema = z.object({
  name: z.string().min(1),
  icon: z.string().nullable().default(null),
  /** A step id within this board. */
  entryStepId: z.string().nullable(),
  /** What an item must have to enter (EO-610). Part of what the pipeline says, so it travels. */
  entryRules: EntryRulesSchema.default([]),
});

/** A step as the document carries it — see `PipelineExportSchema.steps` for what is left out and why. */
export const ExportedStepSchema = PipelineStepViewSchema.omit({ pipelineId: true, inputs: true, timeoutMs: true, workspaceMode: true, workspaceId: true });
/** A route as the document carries it. Its target is a step of any board in the document, or a sentinel. */
export const ExportedRouteSchema = StepRouteViewSchema.omit({ id: true, pipelineId: true });

/**
 * A board the document carries besides its first (EO-762,
 * ARCHITECTURE.md, "The gallery").
 *
 * A template may ship several boards that hand work to each other —
 * Delivery and the board its pull request comments are planned on — and
 * they are installed, updated and exported together. Each is a pipeline
 * of its own when installed, with its own head, steps and routes; what
 * ties them is that a route on one may name a step on another. Step ids
 * are therefore unique across the whole document, which is what lets a
 * route name a step without saying which board it is on.
 *
 * The first board is the document's own `pipeline`, `steps` and
 * `routes`, so a document with one board is exactly what it always was.
 */
export const ExportedBoardSchema = z.object({
  pipeline: ExportedPipelineHeadSchema,
  steps: z.array(ExportedStepSchema),
  routes: z.array(ExportedRouteSchema),
});
export type ExportedBoard = z.infer<typeof ExportedBoardSchema>;

export const PipelineExportSchema = z.object({
  eoPipelineExport: z.number().int().positive(),
  pipeline: ExportedPipelineHeadSchema,
  /**
   * Steps as the editor sees them, minus the pipeline they belonged to.
   *
   * A `module` step's `entryAction` holds the module's **slug** here, not
   * its id — see `ExportedModuleSchema`.
   *
   * `inputs` is omitted too (EO-78), and for the reason a secret is: what
   * a step sets for its module's declared inputs is a fact about *this*
   * installation. The case the feature was built for is the merge module
   * waiting for CI — ninety seconds on one repository and eight minutes
   * on another — so carrying the number across would be carrying the
   * wrong one, stated as though somebody here had chosen it. An imported
   * pipeline runs on the manifest's defaults, which travel with the
   * module, until somebody sets its values.
   *
   * `timeoutMs` is omitted for exactly that reason (EO-162): how long a
   * step may run is how slow *this* repository's CI is, and it is bounded
   * by a run timeout the receiving machine sets for itself. Importing one
   * would either carry a number that is wrong here or be refused for
   * exceeding a ceiling the person importing never chose. An imported
   * step runs on EO's default until somebody raises it.
   */
  // `workspaceMode` is omitted with `inputs` and `timeoutMs`, and for
  // their reason (EO-296): it is a fact about the disk an installation
  // has, not about the shape of the graph. A document that carried
  // "reads only" would be asserting it about a workspace the receiving
  // machine may not have, and on an import that overwrote an existing
  // step it would silently change what that step does to a checkout.
  //
  // `workspaceId` goes with it and rather more obviously (EO-301): it is
  // a UUID of a row on the machine the document was written on, and it
  // means nothing whatever on the machine reading it. An imported step
  // inherits the ticket's workspace until somebody picks one here.
  //
  // `results` is carried rather than omitted (EO-310), which is the one
  // decision on this list that goes the other way — and for the reason
  // the others do not: what a human step offers a person is the graph's
  // own shape, not a fact about this installation's disk or its CI. A
  // document that carried the branches out of an approval step without
  // the buttons that take them would import a step nobody can act on,
  // and `validatePipeline` would refuse it on the far side. Carrying
  // them is what makes the format version above a 3.
  steps: z.array(ExportedStepSchema),
  routes: z.array(ExportedRouteSchema),
  /**
   * The boards it carries besides the first (EO-762) — see
   * `ExportedBoardSchema`. Empty on a document with one board, which is
   * every document written before this field.
   */
  boards: z.array(ExportedBoardSchema).default([]),
  modules: z.array(ExportedModuleSchema).default([]),
  /**
   * The roles the steps above name, with their prompts (KAN-178).
   *
   * Defaulted, so a document written before this field parses as a
   * document that carries no prompts rather than as a damaged one.
   */
  roles: z.array(ExportedRoleSchema).default([]),
  /**
   * The item types the pack ships (EO-314, ARCHITECTURE.md, "One document").
   *
   * What makes this a pack a non-developer can use rather than a graph:
   * a pipeline that files no kind of work is a set of columns. Defaulted
   * for `roles`' reason — a document written before this field carries
   * no types, which is a true statement about it.
   */
  itemTypes: z.array(ExportedItemTypeSchema).default([]),
  /** The outside things this pack talks to, as definitions. They land disconnected (ARCHITECTURE.md, "Import is the needs check"). */
  connectors: z.array(ExportedConnectorSchema).default([]),
  /**
   * The MCP servers its roles' tool surfaces name, with what each does
   * in a person's words (EO-314).
   *
   * Carried so the import gate can show a capability per server on a
   * machine that has none of them. Names and words only — see
   * `ExportedMcpServerSchema`.
   */
  mcpServers: z.array(ExportedMcpServerSchema).default([]),
  /** The words it puts in front of a person, gathered from the rest of the document (ARCHITECTURE.md, "What a pack labels"). */
  vocabulary: ExportedVocabularySchema.default({ types: [], results: [] }),
  /** The example Preview walks, where the pack was authored with one (ARCHITECTURE.md, "Preview"). */
  previewItem: PreviewItemSchema.nullable().default(null),
  /** What this pack says about itself on a gallery card, where it is a template (EO-316, ARCHITECTURE.md, "The gallery"). */
  template: PackTemplateSchema.nullable().default(null),
})
  /**
   * The import gate, in the schema rather than beside it (ARCHITECTURE.md, "The `eo_admin` grant",
   * invariant #11).
   *
   * Here because this is the one place every reader of a pack goes
   * through. A check in the importer would leave the preflight, a future
   * gallery install and anything else that parses a document each
   * needing to remember — and the one that forgets is the one that
   * writes an agent row holding EO's administrative surface, which is a
   * pack rewriting the installation that trusted it.
   *
   * See `ADMIN_GRANT_REFUSAL` for why this refuses rather than strips.
   */
  .superRefine((document, ctx) => {
    for (const [index, role] of document.roles.entries()) {
      if (role.allowedTools === null || !namesAdminServer(role.allowedTools)) continue;
      ctx.addIssue({ code: "custom", message: ADMIN_GRANT_REFUSAL, path: ["roles", index, "allowedTools"] });
    }
    // And a connector whose setup could not be completed here (EO-315).
    //
    // Here for the reason the grant is: this is the one place every
    // reader of a pack goes through, and the alternatives are both
    // worse. Writing the row anyway leaves a person a red line with a
    // button that cannot finish — the dead end
    // `connectorSetupProblems` exists to keep out of a needs check.
    // Dropping the setup silently leaves them a server they were told
    // they could connect and no way to, which is a guard dropping work
    // on the floor (invariant 8). So the document does not parse, and
    // the refusal names the connector so the author can fix it.
    for (const [index, server] of document.mcpServers.entries()) {
      if (server.connector === null) continue;
      for (const problem of connectorSetupProblems(server.connector)) {
        ctx.addIssue({ code: "custom", message: `${CONNECTOR_SETUP_REFUSAL} ${problem}`, path: ["mcpServers", index, "connector"] });
      }
    }
  });

export type ExportedModule = z.infer<typeof ExportedModuleSchema>;
export type ExportedRole = z.infer<typeof ExportedRoleSchema>;
export type ExportedAction = z.infer<typeof ExportedActionSchema>;
export type ExportedItemType = z.infer<typeof ExportedItemTypeSchema>;
export type ExportedConnector = z.infer<typeof ExportedConnectorSchema>;
export type ExportedMcpServer = z.infer<typeof ExportedMcpServerSchema>;
export type ExportedVocabulary = z.infer<typeof ExportedVocabularySchema>;
export type PreviewItem = z.infer<typeof PreviewItemSchema>;
export type PipelineExport = z.infer<typeof PipelineExportSchema>;

/**
 * The role in this document that asks for the admin grant, if any
 * (EO-314).
 *
 * The same question the schema refuses on, asked of a document that is
 * already parsed — which is what the preflight and the importer hold. A
 * document that reached them through `parseExport` cannot answer yes;
 * one built in code, or read by something that skipped the schema, can,
 * and invariant #11 is not a rule to enforce only on the paths somebody
 * remembered.
 */
/**
 * Every board a document carries, its first board first (EO-762).
 *
 * The first is the document's own `pipeline`, `steps` and `routes`; the
 * rest are `boards`. Whatever reads a document whole — the import gate,
 * the import, a template update — reads it through this, so a second
 * board is never a board somebody forgot.
 */
export function documentBoards(document: Pick<PipelineExport, "pipeline" | "steps" | "routes" | "boards">): ExportedBoard[] {
  return [{ pipeline: document.pipeline, steps: document.steps, routes: document.routes }, ...document.boards];
}

/** Every step on every board of a document. */
export function documentSteps(document: Pick<PipelineExport, "pipeline" | "steps" | "routes" | "boards">): ExportedBoard["steps"] {
  return documentBoards(document).flatMap((board) => board.steps);
}

/**
 * Which of a document's boards holds these step ids: the index of the
 * board holding the most of them, or 0 — the first board — where none
 * holds any.
 *
 * How a pipeline made from a template knows which board of it it is
 * (EO-762): its step map is keyed by the template's step ids, and step
 * ids are unique across a document's boards, so the board its map names
 * is its board. A pipeline from before templates had boards names the
 * first board's steps, or nothing, and is the first board either way.
 */
export function boardHolding(document: Pick<PipelineExport, "pipeline" | "steps" | "routes" | "boards">, stepIds: Iterable<string>): number {
  const wanted = new Set(stepIds);
  let best = 0;
  let most = 0;
  for (const [index, board] of documentBoards(document).entries()) {
    const held = board.steps.filter((step) => wanted.has(step.id)).length;
    if (held > most) {
      best = index;
      most = held;
    }
  }
  return best;
}

/**
 * One board of a document, as a document of one board (EO-762): its head,
 * steps and routes in the first board's place and no others. Everything
 * else — the template block, the roles, the modules — is the document's.
 *
 * What reading one pipeline's board through code written for a one-board
 * document takes: a template update compares a pipeline with its own
 * board, never with the first.
 */
export function boardDocument<T extends PipelineExport>(document: T, index: number): T {
  const board = documentBoards(document)[index] ?? documentBoards(document)[0]!;
  return { ...document, pipeline: board.pipeline, steps: board.steps, routes: board.routes, boards: [] };
}

export function roleAskingForAdminGrant(document: Pick<PipelineExport, "roles">): string | null {
  const found = document.roles.find((role) => role.allowedTools !== null && namesAdminServer(role.allowedTools));
  return found?.slug ?? null;
}
