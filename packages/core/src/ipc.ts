import { z } from "zod";
import { NONE_KIND } from "./schemas/workspaces.js";
import { StepVerificationSchema } from "./schemas/verification.js";
import { GalleryNeedSchema, GalleryTemplateViewSchema } from "./schemas/gallery.js";
import {
  AcceptInvitationRequestSchema,
  AcceptInvitationResponseSchema,
  DeviceViewSchema,
  GroupViewSchema,
  PersonViewSchema,
  SessionStatusSchema,
  SignInRequestSchema,
  SignInResponseSchema,
} from "./identity.js";
import { PipelineVersionSchema, PipelineVersionsToKeepSchema, VersionDiffSchema } from "./pipelineVersions.js";
import { TemplateStepIdsSchema, UpdateConflictAnswerSchema, UpdateConflictResolutionSchema } from "./updateConflict.js";
import { PipelineTemplateStatusSchema } from "./templateStatus.js";
import { OrganisationPolicySchema, PersonBudgetSchema, PublishedMcpServerSchema, UnavailableServerSchema } from "./policy.js";
import { PublishedSectionNameSchema, PublishedSectionSchema, SectionLockSchema, sectionLockedMessage, type SectionLock } from "./sections.js";
import { SuggestionViewSchema } from "./suggestions.js";
import { DebugAgentSchema } from "./debug.js";
import { MessageSchema } from "./messages.js";
import {
  RecordAdoptCountsSchema,
  RecordAdoptPageSchema,
  RecordChangesSchema,
  RecordCommandResultSchema,
  RecordCursorsSchema,
  RecordCommandSchema,
  RecordCommentCommandSchema,
  RecordItemSchema,
  RecordLeaseSchema,
  RecordRunCommandSchema,
  RecordOfferSchema,
  RecordProjectSchema,
  SyncStatusSchema,
} from "./record.js";

/**
 * Which document a card was drawn from, sent back by the buttons on it
 * (EO-316, `GalleryTemplateViewSchema.token`).
 *
 * Spread into both gallery actions rather than written twice, because
 * they mean the same thing in each: install *this* pack, not whatever
 * the slug points at by the time I press.
 *
 * Optional, and empty is the same as absent. A caller that never listed
 * has no token to send and is answered by slug — which is what the
 * bundled set is for, and what keeps this channel usable from a test
 * with no screen in front of it.
 */
const TEMPLATE_TOKEN = { token: z.string().optional() };
import {
  AgentDetailSchema,
  AgentRemovalImpactSchema,
  AgentViewSchema,
  ProjectViewSchema,
  BranchPrefixSchema,
  GuardConfigSchema,
  GuardSaveResultSchema,
  HeldWorktreeSchema,
  ProviderCapabilitiesSchema,
  ProviderModelSchema,
  WorkflowProblemSchema,
  HandOffTargetsSchema,
  ItemTypeViewSchema,
  StepHoldSchema,
  PipelineStepViewSchema,
  PipelineStepSaveSchema,
  PipelineViewSchema,
  StepRouteViewSchema,
  CreateRepositoryInputSchema,
  JiraConnectionViewSchema,
  JiraFieldSchema,
  JiraIssueKeySchema,
  JiraIssueSchema,
  RepositoryViewSchema,
  UpdateRepositoryInputSchema,
  WorkspaceViewSchema,
  CreateWorkspaceInputSchema,
  UpdateWorkspaceInputSchema,
  DiscussionSchema,
  AttachmentDraftSchema,
  AttachmentViewSchema,
  DiscussionMessageSchema,
  DiscussionSettingsSchema,
  LiveDraftSchema,
  TurnStepSchema,
  LiveTurnSchema,
  EngineStatusSchema,
  InboxItemSchema,
  InboxSummarySchema,
  McpAliasUseSchema,
  McpClientSchema,
  McpStatusSchema,
  OpenMentionViewSchema,
  CommentDeliverySchema,
  PostCommentInputSchema,
  RunEventViewSchema,
  RunGroupSchema,
  RunRecordSchema,
  RunTotalsSchema,
  RuntimeStatusSchema,
  ItemPageSchema,
  CommentViewSchema,
  ITEM_COMMENTS_PAGE,
  ItemSectionsSchema,
  ItemSummarySchema,
} from "./ipc-schemas.js";
import { SpecFieldDraftSchema } from "./itemTypeAuthoring.js";
import { JobOccurrenceRowSchema, JobOccurrenceViewSchema, JobSummarySchema, JobTemplateSchema, JobTriggerSchema } from "./schemas/jobs.js";
import { JobEventOutcomeSchema, JobEventRowSchema } from "./webhook.js";
import { EntryRulesSchema } from "./entryRules.js";
import { JobMachineSchema, JobPlacementSchema, JobRunsOnSchema } from "./placement.js";
import { ActionRouteUseSchema, ActionUseSchema, RegistryViewSchema } from "./registry/index.js";
import { ActionDefinitionDraftSchema, ActionDefinitionSchema } from "./schemas/actionDefinition.js";
import { UpdateStatusSchema } from "./updates.js";
import { SideCallSpendLineSchema, SmallModelViewSchema } from "./side-calls.js";
import {
  MemoryAddRequestSchema,
  MemoryConsolidateNowRequestSchema,
  MemoryConsolidateNowResultSchema,
  MemoryConsolidationsRequestSchema,
  MemoryConsolidationsResponseSchema,
  MemoryEditRequestSchema,
  MemoryEntryRequestSchema,
  MemoryGetRequestSchema,
  MemoryGetResponseSchema,
  MemorySearchRequestSchema,
  MemorySearchResponseSchema,
  RecordMemoryConsolidationsRequestSchema,
  RecordMemoryConsolidationsResponseSchema,
  MemoryListRequestSchema,
  MemoryListResponseSchema,
  MemoryRestoreConsolidationRequestSchema,
  MemoryRestoreConsolidationResultSchema,
  MemoryScopeSchema,
  MemoryWriteResultSchema,
  RecordMemoryRestoreAnswerSchema,
  RecordMemoryWriteAnswerSchema,
  RecordMemoryWriteSchema,
} from "./memory.js";
import { AgentAttachmentsSchema, AttachableKindSchema } from "./schemas/agentAttachments.js";
import { AssistWaitingModuleSchema } from "./schemas/assist.js";
import { AssistTrialCardSchema } from "./schemas/assistTrial.js";
import { TrialPublishCardSchema } from "./trialPublish.js";
import { McpKeychainSchema, McpServerDraftSchema, McpServerViewSchema } from "./schemas/mcpServers.js";
import { ConnectorViewSchema } from "./schemas/connectors.js";
import { PageDescriptorSchema } from "./schemas/pageDescriptor.js";
import { ProposalDetailSchema } from "./schemas/proposalSummary.js";
import { CurrentViewResultSchema, ViewSnapshotSchema } from "./schemas/viewSnapshot.js";
import {
  ModuleSaveInputSchema,
  ModuleTestCaseSchema,
  ModuleCreationAnswerSchema,
  ModuleCreationSchema,
  ModuleTestRunSchema,
  ModuleTestSaveInputSchema,
  ModuleVersionSchema,
  ModuleVersionSummarySchema,
  ModuleVersionsToKeepSchema,
  MachineSpecificWarningSchema,
  ModuleViewSchema,
} from "./schemas/modules.js";
import { EnvironmentVariableNameSchema, EnvironmentVariableSchema } from "./schemas/environmentVariables.js";
import { RefineStorySchema } from "./schemas/refine.js";
import { ItemPrioritySchema } from "./schemas/priority.js";
import { OutsideReachByStepSchema } from "./trialPlan.js";
import {
  RepositoryIndexActionSchema,
  RepositoryIndexRefSchema,
  RepositoryIntelligenceConfigPatchSchema,
  RepositoryIntelligenceStatusSchema,
} from "./schemas/repositoryIntelligence.js";
import { SkillDraftSchema, SkillListEntrySchema, SkillSchema, SkillVersionSchema } from "./schemas/skills.js";

/**
 * An address in the app, as a canvas tab remembers it: the path and its
 * query, the way `useLocation` spells them (EO-383).
 */
const CanvasPathSchema = z.string().min(1).max(2000).startsWith("/");

/**
 * The canvas's tabs and which one is open — everything a window needs to
 * draw the canvas another window was showing.
 *
 * Addresses only. A tab's label and its view are functions of its
 * address (`chat/views/registry.tsx`), so the window that receives these
 * works them out again rather than being told.
 */
export const CanvasTabsSchema = z.object({
  tabs: z.array(CanvasPathSchema).max(32),
  active: CanvasPathSchema,
});
export type CanvasTabs = z.infer<typeof CanvasTabsSchema>;

function channel<Req extends z.ZodType, Res extends z.ZodType>(request: Req, response: Res) {
  return { request: withinRequestLimit(request), response };
}

/**
 * Which device — and so which *person* — a request is on behalf of
 * (EO-326, `ARCHITECTURE.md`, "Identity").
 *
 * Stamped into a payload by the server's door, exactly as
 * `withDeviceIdentity` stamps the record protocol's four, and for the
 * same reason: an id a client sent would be a claim, and a door that
 * believed it would let anybody read another person's inbox or file a
 * move under their name. See `withActingDevice` for the whole argument.
 *
 * The three states are all meaningful, and a boolean could hold none of
 * them:
 *
 *  - **absent** — nobody stamped it, because nothing authenticated: a
 *    desktop, or the MCP host on one. The person at the keyboard owns
 *    the machine and its database, so the acting person is the local
 *    one and always was;
 *  - **null** — a door stamped "no device", which is the operator's
 *    key: the credential the container was started with, held by
 *    whoever runs the server. It administers an organisation and is not
 *    a member of it, so there is no person for it to act as;
 *  - **an id** — a signed-in device, whose row names the person.
 */
const ACTING_DEVICE = { actingDeviceId: z.string().max(100).nullable().optional() };

/**
 * Which system agent pressed or wrote this, where one did (EO-585,
 * ARCHITECTURE.md, "The assistant on trial items").
 *
 * The agent's counterpart of `ACTING_DEVICE`, and never a caller's word
 * for the same reason: an id somebody sent would be a claim. It is
 * stamped only by EO's administrative MCP host, from the per-turn
 * credential the request arrived on, which EO minted for one system
 * agent's turn (`withActingAgent`). Every other door takes it off what a
 * client sent — the MCP tools never advertise or pass it, and an
 * organisation server's HTTP door deletes it — so absent means what it
 * always meant: the person.
 */
const ACTING_AGENT = { actingAgentId: z.string().max(100).optional() };

/**
 * Where the files a comment names by path may be read from (EO-700).
 *
 * Never a caller's word, for `ACTING_AGENT`'s reason: it is the door that
 * knows who is asking, so it is the door that says it. EO's MCP hosts
 * stamp it on `comments:post` and the item channels that take `paths`
 * (`withPathsFrom`, `PATHS_CHANNELS`) — the external host
 * `anywhere`, because its client acts on a credential the person handed
 * it, and the administrative host `directory`, the directory the system
 * agent's turn runs in, or null for a turn that has none. Every door
 * takes it off what a client sent (`withActingAgent`), so absent means
 * no door granted any: the renderer, which stages a person's files
 * itself, and an organisation server's HTTP door, whose callers are on
 * other machines and have no business naming files on this one.
 */
export const PathsFromSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("anywhere") }),
  z.object({ kind: z.literal("directory"), directory: z.string().nullable() }),
]);
export type PathsFrom = z.infer<typeof PathsFromSchema>;

/** The field EO's MCP hosts stamp the grant in, spelled once. */
export const PATHS_FROM_KEY = "pathsFrom";

/** How many files one comment may carry, by path and by staged id together — the composer's eight (`MAX_ATTACHMENT_COUNT` in the desktop's storage layer). */
export const MAX_COMMENT_ATTACHMENTS = 8;

/**
 * Files on the machine running EO, uploaded and carried on the comment
 * being posted, beside any `attachmentIds` (EO-700). Honoured only where
 * a door stamped `pathsFrom`.
 */
export const CommentPathsSchema = z.array(z.string().min(1)).max(MAX_COMMENT_ATTACHMENTS);

/**
 * Files on the machine running EO, put on an item as its own files when
 * it is filed or edited (EO-704) — `work:submitItem`, `work:submitPlan`
 * (on the feature and on each story) and `items:update`. The same list
 * and the same limit as a comment's, read under the same grant — eight
 * in one call, which on a plan the handler counts across the feature's
 * list and every story's together.
 */
export const ItemPathsSchema = CommentPathsSchema;

/**
 * The channels that take `paths` and so are stamped with `pathsFrom`
 * (EO-700, EO-704). A channel not listed here is never stamped, so a
 * grant cannot reach a handler that would not know what to do with it.
 */
export const PATHS_CHANNELS: ReadonlySet<string> = new Set(["comments:post", "work:submitItem", "work:submitPlan", "items:update"]);

/**
 * Narrowing an item list in EO's own query rather than after it (EO-539).
 *
 * `tickets_list` on a busy project answered with every item, each
 * summarised — its runs read, its parent looked up, its mentions
 * counted — so that a caller wanting one step's work could throw the
 * rest away. Every one of these is a term of the statement that reads
 * the rows, so nothing is read, hydrated or summarised only to be
 * dropped. `stepName` and `atTerminalStep` are answered there by the
 * version each item entered on (EO-327), as the list itself answers
 * them; text is compared without regard to case in any script.
 *
 * Every one optional, and all of them combined with AND. A call that
 * sets none of them is answered exactly as it was before they existed.
 * Shared by the live list and the archive, which differ only in that a
 * finished-or-not filter means nothing on work already put away.
 */
const ITEM_LIST_FILTERS = {
  stepId: z.string().min(1).optional().describe("Only items on this step, by id."),
  stepName: z
    .string()
    .min(1)
    .optional()
    .describe("Only items on a step of this name, matched without regard to case — the name each item's own pipeline version gives its step."),
  pipelineId: z.string().min(1).optional().describe("Only items on this pipeline, by id."),
  type: z.string().min(1).optional().describe("Only items of this type, by the slug the list reports as `type`."),
  parentKey: z.string().min(1).optional().describe("Only the items filed under this container, by its key — EO-42."),
  keys: z.array(z.string().min(1)).min(1).max(1000).optional().describe("Only these items, by key — [\"EO-42\", \"EO-43\"]."),
  text: z.string().min(1).optional().describe("Only items whose title contains this, without regard to case."),
  createdSince: z.number().int().nonnegative().optional().describe("Only items created at or after this moment, in epoch milliseconds."),
  updatedSince: z.number().int().nonnegative().optional().describe("Only items changed at or after this moment, in epoch milliseconds."),
};

/** What `items:listArchived` narrows by — everything `items:list` does but `atTerminalStep`. */
export const ArchivedItemListFiltersSchema = z.object(ITEM_LIST_FILTERS);
export type ArchivedItemListFilters = z.infer<typeof ArchivedItemListFiltersSchema>;

/** What `items:list` narrows by (EO-539). */
export const ItemListFiltersSchema = z.object({
  ...ITEM_LIST_FILTERS,
  atTerminalStep: z
    .boolean()
    .optional()
    .describe("true for only the items standing on a terminal step of their own pipeline version — finished work not yet archived; false for only the rest, containers included."),
});
export type ItemListFilters = z.infer<typeof ItemListFiltersSchema>;

/**
 * Which runs `runs:list` and `runs:summary` read (EO-541).
 *
 * Applied in the query, every one combined with AND, and every one
 * optional — none of them is every run on the installation. Side calls
 * are read beside the runs under the action `side_call:<purpose>`: a
 * filter a side call has no answer to (a thread, a status no side call
 * has) leaves it out, as it would a run. Runs and side calls about a
 * preview are left out, as every spend reader leaves them (EO-313).
 */
export const RunFiltersSchema = z.object({
  itemId: z.string().min(1).optional().describe("Only runs on this item."),
  projectId: z.string().min(1).optional().describe("Only runs on this project's items, and the side calls made for it."),
  action: z
    .string()
    .min(1)
    .optional()
    .describe("Only runs of this action — implement, review — or side calls of one purpose, as side_call:memory_select."),
  backend: z.string().min(1).optional().describe("Only runs on this backend — claude or codex."),
  status: z.string().min(1).optional().describe("Only runs with this status — succeeded, failed, running — or side calls with this outcome."),
  threadId: z.string().min(1).optional().describe("Only runs on this backend thread. Side calls have none."),
  startedSince: z.number().int().nonnegative().optional().describe("Only runs started at or after this moment, in epoch milliseconds."),
  startedUntil: z.number().int().nonnegative().optional().describe("Only runs started before this moment, in epoch milliseconds."),
});
export type RunFilters = z.infer<typeof RunFiltersSchema>;

/** What `runs:summary` can group by (EO-541). A day is the machine's local day, as the daily budget's is. */
export const RUN_GROUPINGS = ["item", "action", "backend", "day"] as const;
export const RunGroupingSchema = z.enum(RUN_GROUPINGS);
export type RunGrouping = z.infer<typeof RunGroupingSchema>;

/** The runs `runs:list` reads, grouped (EO-541). */
export const RunSummaryRequestSchema = RunFiltersSchema.extend({
  groupBy: RunGroupingSchema.describe("Group the runs by item, action, backend or day."),
});
export type RunSummaryRequest = z.infer<typeof RunSummaryRequestSchema>;

/**
 * The parts of an item `items:getSections` can answer with (EO-540).
 *
 * `ticket` is the item's own fields — the summary, its description and
 * criteria, the watch on its step and its attachments' sync state. Each
 * of the rest is one list or one derived answer, read only when it is
 * asked for: `comments` is the thread and the output lifted from it
 * (EO-311, "The output is a comment"), `decision` is what a person may
 * decide on the step the item stands on.
 */
export const ITEM_SECTIONS = ["ticket", "comments", "runs", "transitions", "dependsOn", "decision"] as const;
export const ItemSectionSchema = z.enum(ITEM_SECTIONS);
export type ItemSection = z.infer<typeof ItemSectionSchema>;

/**
 * Reading part of one item rather than all of it (EO-540).
 *
 * Every field but the id is optional, and a call that sets none of them
 * is answered exactly as `items:get` answers. The limits narrow the
 * comments and the runs in the statements that read them, so a section
 * left out — or cut to its newest few — is not read only to be dropped.
 */
export const ItemSectionsRequestSchema = z.object({
  itemId: z.string(),
  include: z
    .array(ItemSectionSchema)
    .min(1)
    .optional()
    .describe("Only these parts of the item, of ticket, comments, runs, transitions, dependsOn and decision. Every part when omitted."),
  commentsLimit: z.number().int().positive().max(1000).optional().describe("Only the newest this many comments, still in thread order."),
  commentsSince: z.number().int().nonnegative().optional().describe("Only comments posted at or after this moment, in epoch milliseconds."),
  pinnedOnly: z.boolean().optional().describe("true for only the pinned comments — what somebody marked as settled."),
  runsLimit: z.number().int().positive().max(1000).optional().describe("Only the newest this many runs, still oldest first."),
});
export type ItemSectionsRequest = z.infer<typeof ItemSectionsRequestSchema>;

/**
 * The longest `dataBase64` an attachment may arrive as.
 *
 * `MAX_ATTACHMENT_BYTES` in `main/attachments/storage.ts` is 20 MiB, and
 * base64 is four characters per three bytes — `ceil(20971520 / 3) * 4`
 * is 27,962,028, rounded up here. The two are one limit in two units:
 * this is the wire, that is the disk, and the wire has to be the larger
 * of them or a file within the limit would be refused before anything
 * measured it.
 *
 * Named rather than written into the schema, because it stopped being a
 * fact about one channel the moment a second reader needed it: an
 * organisation server reads a request off a socket and has to know how
 * much to accept *before* it can parse it. See `MAX_IPC_REQUEST_BYTES`.
 */
export const MAX_ATTACHMENT_BASE64_CHARS = 28_000_000;

/**
 * The most a single request may be, as the JSON a transport carries
 * (EO-319).
 *
 * **A rule of the contract, not a transport's opinion of it.** That
 * distinction is the whole of this constant's history. It began as a
 * number the server's HTTP door picked for itself, which was wrong twice
 * over: first too small for `attachments:stage`, and then — once it was
 * derived from that channel — still not a *contract-wide* maximum,
 * because 368 request strings in the record half have no `.max()` on
 * them and arrays of them have no length. A door refusing what a schema
 * accepts is a door that is quietly wrong, and no amount of choosing the
 * number better fixes that: while the contract has no maximum, every
 * finite limit a transport picks is one the contract disagrees with.
 *
 * So the contract has one. `channel()` applies it to every request in
 * both halves — see `withinRequestLimit` — which is a shared bound on
 * *all* request content rather than 368 separate ones, and covers the
 * arrays and record keys that per-field bounds would still have left
 * open. Every door then enforces the same rule: the renderer's, the MCP
 * host's and the server's all dispatch through `handleIpcRequest`, and a
 * request over this is `Invalid request payload` on all three.
 *
 * Measured in UTF-8 bytes of the serialized payload, because that is
 * what a transport counts off a socket — the same unit on both sides of
 * the boundary, so neither can refuse what the other accepts.
 *
 * The size is the largest thing the contract can legitimately carry —
 * a 20 MiB attachment in base64 — with four mebibytes over it for the
 * envelope and for text sent alongside. Nothing a person types or an
 * agent writes approaches it; what it stops is a client claiming a
 * gigabyte.
 */
export const MAX_IPC_REQUEST_BYTES = MAX_ATTACHMENT_BASE64_CHARS + 4 * 1024 * 1024;

/**
 * The size of a payload, as the bytes its JSON takes on a wire.
 *
 * Exact rather than estimated, and deliberately so: it measures the very
 * string a transport sends, which leaves no escaping rule to replicate
 * and get subtly wrong. An estimate that ran under the truth would put
 * the contract's answer and the door's on opposite sides of the limit,
 * which is the bug this whole constant exists to stop.
 *
 * No short-circuit for the common case, because it was measured and does
 * not need one: a hundred thousand ordinary payloads cost 24ms between
 * them, and the largest attachment the contract allows costs 55ms once.
 */
export function ipcRequestBytes(payload: unknown): number {
  const json = JSON.stringify(payload);
  // `undefined` for a `z.void()` channel, which sends nothing at all.
  return json === undefined ? 0 : utf8Length(json);
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00) {
      // A surrogate pair is two units and four bytes; skipping the low
      // half is what keeps it from being counted as three more.
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * The rule above, put on one channel's request.
 *
 * A `check` rather than a `refine` so the schema keeps its own type:
 * `ipcContract[c].request` is read as a `ZodObject` elsewhere — `.shape`
 * in two tests and in the MCP catalogue — and `.def.type` is how
 * `toolSchema.ts` recognises a `z.void()` channel. `z.toJSONSchema`
 * ignores a custom check, so the tool schemas the MCP host publishes are
 * unchanged. The one thing a check does cost is `.partial()`, which Zod
 * refuses on a refined object; `catalog.ts` rebuilds its patch schema
 * from `.shape`, which is what it meant anyway.
 *
 * It measures the payload *after* parsing, which is the payload a
 * handler receives — so unknown keys, which Zod strips, are not counted.
 * A caller padding a request with content no channel declares is
 * therefore refused by a transport's byte count rather than here. That
 * asymmetry is deliberate and is the one place the two can disagree: a
 * streaming door has to bound its buffer before it can parse anything,
 * and EO's own doors only ever send declared fields.
 */
function withinRequestLimit<T extends z.ZodType>(request: T): T {
  return request.check((ctx) => {
    const bytes = ipcRequestBytes(ctx.value);
    if (bytes <= MAX_IPC_REQUEST_BYTES) return;
    ctx.issues.push({
      code: "custom",
      input: ctx.value,
      message: `That request is ${bytes} bytes, and EO carries at most ${MAX_IPC_REQUEST_BYTES}.`,
    });
  });
}

/**
 * Where an import lands, said outright (EO-521): a project's id, or
 * `null` for no project. An object rather than a bare nullable id so that
 * "no project" and "not said" are two different things on the wire.
 */
export const ImportDestinationSchema = z.object({ projectId: z.string().nullable() });

/**
 * What an imported pipeline would need here, before anything is written
 * (KAN-108) — `pipelines:importPreflight`'s answer, and what the
 * assistant's import card shows (EO-521). Named so the two say it in one
 * shape.
 */
export const ImportPreflightViewSchema = z.object({
  pipelineName: z.string(),
  missingBinaries: z.array(z.object({ name: z.string(), wantedBy: z.array(z.string()) })),
  missingSecrets: z.array(z.object({ name: z.string(), wantedBy: z.array(z.string()) })),
  wantsNetwork: z.array(z.string()),
  /** Modules whose manifest says they read EO's items (EO-74). */
  readsItems: z.array(z.string()),
  /** Modules whose manifest says they post comments (EO-75). */
  postsComments: z.array(z.string()),
  /** Modules whose manifest says they attach files (EO-414). */
  attachesFiles: z.array(z.string()),
  /** Modules whose manifest says they create work items (EO-433). */
  createsItems: z.array(z.string()),
  collisions: z.array(z.object({ slug: z.string(), localName: z.string(), incomingName: z.string() })),
  /**
   * The roles this document's steps need, and whether an agent
   * here fills each (KAN-178, `ARCHITECTURE.md`, "Import is the needs check").
   *
   * A pack names a role and the installing machine chooses the
   * agent, so importing one fills no slots. Saying which are
   * empty is what stops a step refusing to dispatch for a reason
   * the person was never shown.
   */
  roleSlots: z
    .array(
      z.object({
        slug: z.string(),
        filled: z.boolean(),
        carriesPrompt: z.boolean(),
        /**
         * What the pack's author ran this role on (EO-314,
         * ARCHITECTURE.md, "An agent is a row").
         *
         * Shown beside the role and binding nothing: "a pack
         * names the role each agent step needs and the
         * installing machine chooses the agent … it may
         * recommend a backend and model. It may not require
         * one."
         */
        recommendedBackend: z.string().nullable().default(null),
        recommendedModel: z.string().nullable().default(null),
        /** Whether that backend is signed in here; null when there is no recommendation to check. */
        backendSignedIn: z.boolean().nullable().default(null),
      }),
    )
    .default([]),
  /**
   * What this pack talks to outside EO, and whether it is
   * connected here (EO-314, ARCHITECTURE.md, "Import is the needs check").
   *
   * Connectors land disconnected — no site, no token, nothing
   * anybody's credentials travelled for — so each line is a need
   * rather than a report.
   */
  connectors: z
    .array(z.object({ slug: z.string(), label: z.string(), description: z.string(), connected: z.boolean() }))
    .default([]),
  /**
   * The pack's tool surface as capabilities, one line per MCP
   * server (EO-314, the original design).
   *
   * "Reads your Slack channels", not
   * `mcp__slack__conversations_history`: what the person is
   * agreeing to is what the pack can do.
   */
  capabilities: z.array(z.object({ server: z.string(), line: z.string() })).default([]),
  /**
   * Why this document cannot be imported at all, or null.
   *
   * Invariant #11's refusal, and not a need: nothing the person
   * can install or sign into turns it green.
   */
  refusal: z.string().nullable().default(null),
  /** The item types the pack ships, and whether this project already has each. */
  itemTypes: z.array(z.object({ type: z.string(), label: z.string(), present: z.boolean() })).default([]),
  /**
   * Prompts and module code still written against the tool names
   * EO renamed (KAN-178).
   *
   * `where` is the step or module it was found in, so the line
   * says what to go and edit rather than only that something
   * somewhere is on a clock.
   */
  oldNames: z
    .array(z.object({ where: z.string(), names: z.array(z.object({ deprecated: z.string(), replacement: z.string() })) }))
    .default([]),
  /**
   * Values in the document that look like they only hold on the
   * machine it was written on (EO-451), by the role prompt, step
   * or module they were found in. Advice: nothing about the
   * import is refused or changed because of one.
   */
  machineSpecific: z.array(z.object({ where: z.string(), warnings: z.array(MachineSpecificWarningSchema) })).default([]),
  moduleCount: z.number(),
});
export type ImportPreflightView = z.infer<typeof ImportPreflightViewSchema>;

/**
 * What a card for one step's own secret or variable shows (EO-522),
 * the same for both: the step and the name, by what they are called, and
 * whether a value is already set — never the value.
 *
 * Read across both lists and the organisation's, because that is how a
 * run is given a name (`environmentFor`): the organisation's value wins
 * outright; otherwise the step's own entry, secret or variable; otherwise
 * the shared one, secret or variable. So clearing a step's secret can
 * leave it on a shared *variable*, and a value set on the step changes
 * nothing while the organisation sets the name.
 */
const STEP_VALUE_CARD = {
  pipelineId: z.string(),
  pipelineName: z.string(),
  stepId: z.string(),
  stepName: z.string(),
  name: z.string(),
  action: z.enum(["set", "clear"]),
  /**
   * Whether the step already has a value of its own under this name, of
   * the card's kind. For a secret, a stored value or a reference to EO's
   * environment counts, whether or not it can still be read.
   */
  set: z.boolean(),
  /**
   * Whether the step's own entry for this name is of the *other* kind — a
   * variable on a secret's card, or a secret on a variable's. A name is
   * one or the other within a scope, so setting this card's kind is
   * refused until that one is removed.
   */
  setAsOther: z.boolean(),
  /** What the shared list holds under this name, which the step falls back to without its own: a secret, a variable, or nothing. */
  shared: z.enum(["secret", "variable"]).nullable(),
  /** Whether the organisation sets this name — its value is what a run is given, whatever the step or the shared list holds. */
  organisation: z.boolean(),
};

/**
 * One item type as an item-type card shows it (EO-523): what it is
 * called, the word items are filed under, whether it holds other items,
 * and its fields as the editor offered them. A field's name is as it
 * would be written — `Customer name` becomes `customer_name` — and may be
 * empty where nothing in what was typed can make a name, which the
 * card's `problem` then says.
 */
export const ItemTypeCardShapeSchema = z.object({
  label: z.string(),
  plural: z.string(),
  slug: z.string(),
  container: z.boolean(),
  fields: z.array(z.object({ name: z.string(), kind: SpecFieldDraftSchema.shape.kind, required: z.boolean() })),
});
export type ItemTypeCardShape = z.infer<typeof ItemTypeCardShapeSchema>;

/**
 * What a card for one existing item type also says (EO-523): which
 * project it is on — null for the installation's own — which pack ships
 * it (`local` for one made here), and how many items are of it.
 */
const EXISTING_ITEM_TYPE_CARD = {
  itemTypeId: z.string(),
  projectName: z.string().nullable(),
  packSlug: z.string(),
  itemCount: z.number().int(),
  /**
   * What `itemTypes:update` or `itemTypes:delete` would refuse the press
   * with now, in its own words, or null when it would carry it out. The
   * card shows it as the refusal and offers no button.
   */
  problem: z.string().nullable(),
};

/**
 * What a card offering something only a person may do shows (EO-521),
 * read by EO when the card is drawn — `assist:card`.
 *
 * Nothing here is the agent's word. The card named a pipeline, an
 * attachment or a step and a variable, and nothing else
 * (`AssistCardSchema`); its name, how many items it holds, whether this
 * machine's copy is still edited locally, what an import would need here,
 * whether a webhook job files onto it, and whether a step already has a
 * value of its own are read from the database, the file and the store,
 * so the card says what pressing it would do now. A value is never read
 * into it (EO-522): whether one is set, never what it is.
 */
export const AssistCardDetailSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pipelineExport"), pipelineId: z.string(), pipelineName: z.string() }),
  z.object({
    kind: z.literal("pipelineImport"),
    /** The attached file's name, as the person attached it. */
    attachmentName: z.string(),
    /** What `pipelines:importPreflight` says the document would need here, and every slug that collides with a module already here. */
    preflight: ImportPreflightViewSchema,
  }),
  z.object({
    kind: z.literal("pipelineDelete"),
    pipelineId: z.string(),
    pipelineName: z.string(),
    /** The items on it that are not archived yet — the ones Delete would archive with it. */
    itemCount: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("pipelineDiscardEdits"),
    pipelineId: z.string(),
    pipelineName: z.string(),
    /** The diverged line the configure screen draws ("Edited locally · based on v6"), or null where it has none to draw. */
    line: z.string().nullable(),
    /** The version the organisation published, which discarding puts back. Null where this machine does not hold it yet. */
    version: z.number().int().positive().nullable(),
  }),
  z.object({
    kind: z.literal("pipelineWebhookUnattended"),
    pipelineId: z.string(),
    pipelineName: z.string(),
    /** What pressing the card would make the setting: true lets webhook items reach a sending step unread. */
    unattended: z.boolean(),
    /** What the setting is now. */
    current: z.boolean(),
    /** Whether a webhook job files onto the pipeline — without one there is nothing to turn on. */
    entry: z.boolean(),
    /** Whether the organisation manages this machine's pipelines, so only an administrator may change it. */
    managed: z.boolean(),
  }),
  z.object({ kind: z.literal("stepSecret"), ...STEP_VALUE_CARD }),
  z.object({ kind: z.literal("stepVariable"), ...STEP_VALUE_CARD }),
  z.object({
    kind: z.literal("itemTypeCreate"),
    projectId: z.string(),
    projectName: z.string(),
    /** The type as it would be made. */
    type: ItemTypeCardShapeSchema,
    /** What `itemTypes:create` would refuse it with now — a name already taken, a field with no name — or null. */
    problem: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("itemTypeUpdate"),
    ...EXISTING_ITEM_TYPE_CARD,
    /** The type as it is. */
    before: ItemTypeCardShapeSchema,
    /** And as it would be once the card is pressed. */
    after: ItemTypeCardShapeSchema,
  }),
  z.object({
    kind: z.literal("itemTypeDelete"),
    ...EXISTING_ITEM_TYPE_CARD,
    /** The type that would go. */
    type: ItemTypeCardShapeSchema,
  }),
  z.object({
    /** Keep my pipeline and skip this update (EO-534). */
    kind: z.literal("pipelineKeepMine"),
    pipelineId: z.string(),
    pipelineName: z.string(),
    /** The held update's template and versions, or null where the pipeline no longer has one held — resolved since, or never. */
    held: z.object({ templateTitle: z.string(), fromVersion: z.string(), toVersion: z.string() }).nullable(),
  }),
  /** The publish card after a draft's trials (EO-588): everything on it read from the trial. */
  TrialPublishCardSchema.extend({ kind: z.literal("trialPublish") }),
]);
export type AssistCardDetail = z.infer<typeof AssistCardDetailSchema>;

/**
 * What `pipeline:save` takes: one whole graph, published in one go.
 *
 * Named rather than written inline so the MCP tool can take the same
 * thing minus `restoredFrom` — see that field.
 */
export const PipelineSaveInputSchema = z.object({
  pipelineId: z.string(),
  /** Each with `watch` optional: left out, a step keeps its keep-checking settings (EO-506). */
  steps: z.array(PipelineStepSaveSchema),
  routes: z.array(StepRouteViewSchema),
  /** Where work enters (ARCHITECTURE.md, "Vocabulary"). Published with the graph, since a step and its entry are edited together. */
  entryStepId: z.string().nullable(),
  /**
   * What an item must have to enter (EO-610, ARCHITECTURE.md, "Entry
   * rules"), in order. Left out keeps the rules the pipeline has, so a
   * save with no opinion about them cannot drop them; `[]` clears them.
   */
  entryRules: EntryRulesSchema.optional(),
  /**
   * The version this draft was restored from, where it was (EO-359).
   *
   * Who a human step waits on is not on this wire — it is set on the
   * board's column head through `steps:setOwner`, and an ordinary
   * publish leaves it exactly where it is. A restored version is the one
   * publish that has an opinion about it: the version's own document
   * says who each of its human steps waited on, and publishing the
   * version without that would file a graph whose steps wait on whoever
   * they wait on today.
   *
   * So the draft names the version, and the main process reads the
   * owners out of that version's own document — never a person or a
   * group the caller names. Not offered to MCP clients
   * (`pipeline_save` omits it), for the reason `steps:setOwner` is not a
   * tool: who waits at a step decides who holds every item that arrives
   * there.
   */
  restoredFrom: z.number().int().positive().optional(),
  /**
   * The action definitions this graph is published with (EO-426).
   *
   * What a draft card proposed beside its graph: each is written through
   * the one save every definition is written through, in the transaction
   * that writes the graph — so a refused pipeline leaves no definition
   * behind, and a refused definition no pipeline. The graph is judged
   * against the installation's definitions with these laid over them.
   *
   * A definition is part of the `agents` section, so on an installation
   * where that section is managed a save carrying any is refused whole.
   * Not offered to MCP clients (`pipeline_save` omits it): the assistant
   * proposes a definition on a card or writes one with
   * `role_action_save`, and a third way would be one nobody reads first.
   */
  actions: z.array(ActionDefinitionDraftSchema).optional(),
});

/** One assistant chat, as `assist:list` answers with it. */
const AssistChatSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  startedAt: z.number(),
  lastActivityAt: z.number(),
  live: z.boolean(),
  shown: z.boolean(),
  /**
   * What the chat is doing, as the rail marks it — Claude Desktop's
   * sidebar: a turn is running in it, it holds a question or a card that
   * waits on the person, or neither. Derived on every read and never
   * stored (invariant 6), so it cannot drift from the thread it describes.
   */
  state: z.enum(["working", "waiting", "idle"]).default("idle"),
});

// Renderer -> main, request/response. One entry per invoke channel; add
// domain channels here as their stories land — never add a bridge method
// per feature on the preload side (see F-04 scope).
//
// The contract is two literals, and `ipcContract` below is their union
// (KAN-127, ARCHITECTURE.md, "Where the seams are"). The split is by what
// answers the channel rather than by what it is about:
//
// - `recordContract` is everything an implementation answers from the
//   record — the database, the engine, the catalogues. An organisation
//   server implements all of it and none of the other half.
// - `machineContract` is everything that only makes sense on the machine
//   the person is sitting at: native dialogs, the OS viewer, what the
//   window is showing, the CLIs installed here, updating this binary,
//   the checkouts on this disk, and registering with the editors on it.
//
// Nothing else changes. Every reader takes `ipcContract` and sees the
// same 162 channels; the halves exist so that the boundary is a type
// rather than a list somebody keeps by hand. Moving a channel between
// them is moving its entry — a type test in ipc.test.ts holds that each
// is in exactly one.
export const recordContract = {
  "app:getVersion": channel(z.void(), z.object({ version: z.string() })),
  // ARCHITECTURE.md, "Guardrails" guardrails: cost figures per item and per calendar day (the
  // machine's local day, matching the daily budget guard's own
  // boundary), summed from runs.cost_cents and side_calls.cost_cents —
  // read-only for the renderer (U-06 is the UI on top of this). `date`
  // is "YYYY-MM-DD"; omitted on the request means today.
  //
  // `costCents` is the whole figure, side calls included (EO-477), so it
  // is still the one the budgets are measured against. `sideCalls` is the
  // part of it that was not a run, by spend group, so a screen can list
  // "Memory upkeep" as its own line; empty when there was none.
  "costs:getForItem": channel(
    z.object({ itemId: z.string() }),
    z.object({ itemId: z.string(), costCents: z.number(), sideCalls: z.array(SideCallSpendLineSchema) }),
  ),
  // `trialCostCents` is the part of `costCents` spent on trial items
  // (EO-582): counted in the day's figure, since a trial runs on real
  // backends and the daily budget stops it like anything else, and said
  // apart so a person can see what testing drafts cost.
  "costs:getDaily": channel(
    z.object({ date: z.string().optional() }),
    z.object({ date: z.string(), costCents: z.number(), sideCalls: z.array(SideCallSpendLineSchema), trialCostCents: z.number().default(0) }),
  ),

  // ── Reads (F-05) ────────────────────────────────────────────────
  /**
   * Explicit scope, defaulting to whatever the window is showing.
   *
   * Added for the MCP host, which has no window and must not acquire one
   * by changing which project the person is looking at. `projects:setActive`
   * *is* offered as a tool — moving the window is a thing somebody can
   * ask for, and its description says plainly that it does — and this
   * argument is what keeps a *read* from ever being the reason to.
   *
   * `.default({})` is what keeps every existing caller working
   * unchanged: they pass `undefined`, which parses to `{}` and falls
   * back to the active project, as it always did. That holds for the
   * types as well as the wire because `IpcRequest` is `z.input` — see
   * its comment, which this channel is the reason for.
   */
  "items:list": channel(
    z.object({ projectId: z.string().nullable().optional(), ...ItemListFiltersSchema.shape, ...ACTING_DEVICE }).default({}),
    z.object({ items: z.array(ItemSummarySchema) }),
  ),
  /**
   * One item as the screens draw it: everything but the thread whole —
   * the newest `ITEM_COMMENTS_PAGE` comments and the count of earlier
   * ones (EO-559). The rest is read with `items:earlierComments`.
   *
   * `from` holds the page's start still once somebody has read back
   * before it: every comment from that one on, however many have come
   * since, so the page cannot slide away from the history read behind
   * it. A `from` the thread no longer holds is answered as if it were
   * absent — the newest page — which is how the caller learns its
   * anchor is gone (the page does not start with it).
   */
  "items:get": channel(z.object({ itemId: z.string(), from: z.string().optional() }), ItemPageSchema.nullable()),
  /**
   * Older comments of an item, a page at a time (EO-559): the newest
   * `limit` before `before`, the oldest comment the page already has,
   * still oldest first. `earlier` is how many are older still. A
   * `before` the item's thread does not hold is an empty page.
   */
  "items:earlierComments": channel(
    z.object({ itemId: z.string(), before: z.string(), limit: z.number().int().positive().max(500).default(ITEM_COMMENTS_PAGE) }),
    z.object({ comments: z.array(CommentViewSchema), earlier: z.number().int().nonnegative() }),
  ),
  /**
   * The parts of one item a caller asked for (EO-540) — `item_get`'s
   * channel. Beside `items:get` rather than in place of it, because the
   * screens read an item whole and a detail whose every list might be
   * absent would be a type each of them had to second-guess.
   */
  "items:getSections": channel(ItemSectionsRequestSchema, ItemSectionsSchema.nullable()),
  /**
   * The item a key names — `EO-486` — through the project whose key
   * prefix it carries (EO-539).
   *
   * The one place a key becomes an id for a caller from outside: the MCP
   * host asks this before any tool that takes an item id runs, so every
   * such tool accepts a key without a line of its own. Null with a
   * sentence naming the key when it names nothing — no project carries
   * the prefix, or that project has no item numbered so. Archived items
   * are found, for `getItemByKey`'s reason: "EO-42 is archived" is a
   * better answer than "EO-42 does not exist".
   */
  "items:resolveKey": channel(z.object({ key: z.string() }), z.object({ itemId: z.string().nullable(), problem: z.string().nullable() })),
  /**
   * Runs across items, with their timing, tokens, cost and verdicts
   * (EO-541) — `runs_list`'s channel. Newest first; a run not yet
   * started last. Side calls are among them, as `side_call:<purpose>`.
   */
  "runs:list": channel(RunFiltersSchema, z.object({ runs: z.array(RunRecordSchema) })),
  /**
   * The same runs added up per item, action, backend or day (EO-541) —
   * `runs_summary`'s channel. `overall` is every run the filters
   * matched, whatever is later done to the groups.
   */
  "runs:summary": channel(
    RunSummaryRequestSchema,
    z.object({ groupBy: RunGroupingSchema, groups: z.array(RunGroupSchema), overall: RunTotalsSchema }),
  ),
  // Paged: a chatty agent produces thousands of events per run (ARCHITECTURE.md, "`run_events` is
  // the durability substrate"), and
  // the renderer must never be handed an unbounded log.
  //
  // `fromSeq` is inclusive, and `nextSeq` is the cursor to pass next —
  // so a follower loops until nextSeq is null without arithmetic of its
  // own. An exclusive "afterSeq" reads more naturally but is a trap:
  // run_events seq is 0-based, so a default of 0 silently skips the
  // first event of every run.
  "runs:listEvents": channel(
    z.object({ runId: z.string(), fromSeq: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(1000).default(200) }),
    // `total` is the whole run's, so a follower can tell a line landed behind
    // its cursor (EO-618): a run two devices write is not told in `seq` order.
    z.object({ events: z.array(RunEventViewSchema), nextSeq: z.number().nullable(), total: z.number().int().nonnegative() }),
  ),
  /**
   * Scoped like `items:list`, and for the same reason.
   *
   * Scoped to a *person* as well since EO-326: an inbox is "what is
   * waiting on me", and on a server there is more than one me. The
   * person is the acting device's, never the payload's — see
   * `ACTING_DEVICE`. On a desktop nothing stamps it and the answer is
   * the local person's inbox, which is the only inbox there has ever
   * been there.
   */
  "inbox:list": channel(
    z.object({ projectId: z.string().nullable().optional(), ...ACTING_DEVICE }).default({}),
    z.object({
      items: z.array(InboxItemSchema),
      /**
       * The open messages EO sent the person asking (EO-725, ARCHITECTURE.md
       * §7.1): what needs them that belongs to no item. Beside the item
       * questions rather than among them, because a message has no item, no
       * thread to reply on and no `!` marker. Newest first. Counted in
       * `summary.openCount`. A project read keeps the messages about that
       * project and the ones about none.
       */
      messages: z.array(MessageSchema),
      summary: InboxSummarySchema,
    }),
  ),
  /**
   * Answers an open message with one of its offered answers (EO-725).
   *
   * Only the message's recipient may, and only while it is open: a
   * message already answered, dismissed or resolved is refused, as is an
   * answer the message did not offer. The message drops out of the open
   * list and is kept, handled, until the retention sweep removes it.
   */
  "messages:answer": channel(
    z.object({ messageId: z.string(), answer: z.string().min(1), ...ACTING_DEVICE }),
    z.object({ message: MessageSchema }),
  ),
  /** Dismisses an open message without answering it (EO-725). Its recipient's only, like `messages:answer`. */
  "messages:dismiss": channel(
    z.object({ messageId: z.string(), ...ACTING_DEVICE }),
    z.object({ message: MessageSchema }),
  ),
  /**
   * Every unaddressed mention the caller may see, across projects
   * (EO-326, ARCHITECTURE.md, "Identity").
   *
   * The admin's counterpart to the inbox, and deliberately not a filter
   * on it. An inbox answers "what is waiting on *me*" and narrows as it
   * is read; this answers "what is waiting on *anybody*" and is read by
   * somebody who is not in any of it — so each row carries the person it
   * waits on and the project it is on, which an inbox row never has to
   * because the reader already knows both.
   *
   * Scoped by the same rule as `projects:list`: every project for an
   * admin, and the caller's own otherwise. It is a wider view of the
   * same rows, never a way around that rule.
   */
  "mentions:open": channel(
    z.object({ ...ACTING_DEVICE }).default({}),
    z.object({ mentions: z.array(OpenMentionViewSchema) }),
  ),
  "agents:list": channel(z.void(), z.object({ agents: z.array(AgentViewSchema) })),

  /**
   * A decomposition somebody has already agreed, submitted from outside
   * the app.
   *
   * The comment below explains why there is no `items:create`, and
   * this does not reopen that door: what it refuses is a *title typed
   * into a column*, work that nothing has thought about. This carries
   * the same shape EO's own product owner produces — an understanding,
   * the decisions that were settled, and stories with acceptance
   * criteria and dependencies — because it comes from an agent that has
   * just had that conversation with a person, outside EO, and is handing
   * over the result.
   *
   * It goes through exactly the code `assist:approve` goes through.
   * Same validation, same cycle check over the merged dependency graph,
   * same placement rules, same pinned understanding on the feature. Two
   * routes in, one implementation, so neither can quietly become the
   * lenient one.
   */
  "work:submitPlan": channel(
    z.object({
      /** Defaults to whichever project the window is showing. */
      projectId: z.string().nullable().optional(),
      /** Which pipeline the stories flow through: its name, preferred, or its id. Omitted picks the project's only one, or refuses. */
      pipeline: z.string().optional(),
      title: z.string().min(1),
      /** What was agreed, in the submitter's words. Pinned on the feature, as the product owner's is. */
      understanding: z.string().min(1),
      decisions: z.array(z.object({ topic: z.string().min(1), decision: z.string().min(1) })).default([]),
      /**
       * The feature's priority (EO-568). Left out, it is 0. Not handed
       * down: each story says its own through `priority`, and one that
       * says nothing is 0 whatever the feature's is.
       */
      priority: ItemPrioritySchema.optional(),
      /**
       * Each story as a plan's story is, plus `paths` (EO-704): files to
       * put on that story as its own. Added here rather than on
       * `RefineStorySchema`, which is also what the product owner's
       * proposals are read with, and no agent inside a conversation
       * names files on this machine.
       */
      stories: z.array(RefineStorySchema.extend({ paths: ItemPathsSchema.optional() })).min(1),
      /** Files to put on the feature as its own (EO-704). Honoured only where a door stamped `pathsFrom`. */
      paths: ItemPathsSchema.optional(),
      [PATHS_FROM_KEY]: PathsFromSchema.optional(),
      /**
       * The Jira issue the *feature* already is (EO-124).
       *
       * A plan agreed outside EO often mirrors an epic that is already
       * written, with its stories under it — each story says which it
       * is through its own `jira_key`, and this says which the feature
       * is. Optional, and leaving it out is the ordinary case: a plan
       * for work Jira has never heard of has no key to give.
       *
       * Attaching is local. Every key in the plan is checked for shape
       * and for whether another item already holds it *before*
       * anything is created, so a bad one comes back as a `problem`
       * with nothing made. Nothing is fetched and nothing is imported.
       *
       * A plain string here for the reason `RefineStorySchema.jira_key`
       * gives: this is one of three ways a plan's keys can be wrong, and
       * checking its format at the boundary would make it the only one
       * that never reaches the `problem` this channel answers with.
       */
      jiraKey: z.string().optional(),
      /**
       * Whether the items this plan creates talk to Jira at all
       * (EO-122).
       *
       * The default for the feature *and* every story under it: the
       * feature is created with it, and a story that says nothing
       * inherits it from the feature at creation. A story's own
       * `jira_sync` wins over it, and with neither said, sync is on —
       * which is what every plan submitted before this field existed
       * did.
       */
      jiraSync: z.boolean().optional(),
    }),
    z.object({
      created: z.boolean(),
      /** The feature, and the stories under it, once they exist. */
      featureKey: z.string().nullable(),
      storyKeys: z.array(z.string()),
      /** Why nothing was created. A plan that cannot be built is a refusal, not a fault. */
      problem: z.string().nullable(),
    }),
  ),

  /**
   * One bug or story, handed over on its own.
   *
   * The other half of `work:submitPlan`. Not everything worth doing is a
   * feature with stories under it: a bug someone hit is one item, and
   * so is a story added to work that already exists. Forcing either
   * through a decomposition would mean inventing a feature to hold it,
   * which is how a board fills up with containers holding one thing.
   *
   * `parent` is an existing *feature's* key. Absent means standalone,
   * which is ordinary — a bug found in something nobody modelled as a
   * feature has no parent to name.
   */
  "work:submitItem": channel(
    z.object({
      ...ACTING_DEVICE,
      projectId: z.string().nullable().optional(),
      pipeline: z.string().optional(),
      /**
       * Which type to file this as, by slug — `story` or `bug` on a
       * default installation.
       *
       * A slug rather than a closed list (KAN-146): the types a project
       * has are `item_types` rows, and an enum of three could only be
       * right for the developer pack. The handler resolves it against
       * the project's rows, and refuses two things in `problem` rather
       * than as a malformed payload — a slug the project does not have,
       * naming what it does have, and a *container* type, which is
       * `work:submitPlan`'s job because a container with no work under
       * it is not work.
       */
      type: z.string().min(1),
      title: z.string().min(1),
      body: z.string(),
      /** An existing feature's key to file this under. Absent means standalone. */
      parent: z.string().optional(),
      /** Which repository, by name. Only meaningful on a project spanning several. */
      repository: z.string().optional(),
      /** Required on a story: verification checks the implementer's claim against these. */
      acceptanceCriteria: z.array(z.string().min(1)).default([]),
      /** How soon it should be picked up (EO-568). Left out, it is 0 — inherited from no parent. */
      priority: ItemPrioritySchema.optional(),
      /**
       * The item's structured fields, under the names its type's shape
       * declares (KAN-147).
       *
       * The five fields above are the developer pack's, spelled flat and
       * in camelCase because a union renders as `anyOf` in a tool's JSON
       * Schema and models handle that far worse. They are also, without
       * this, the only fields any type could be handed: a pack shipping a
       * `Case` with a customer and a channel had no way to say either.
       *
       * What arrives here is merged over what the flat fields spell, and
       * merged *whole* — a key the type's shape does not declare is kept
       * rather than dropped, because a caller that named a field meant it
       * and a `spec` is an open bag. What the shape decides is what an
       * item must arrive *with*: the handler refuses a submission missing
       * a required field, naming it.
       */
      spec: z.record(z.string().min(1), z.unknown()).optional(),
      /** Repository-relative paths, which EO uses to serialise work that would collide. */
      touches: z.array(z.string().min(1)).default([]),
      /** Existing item *keys* this waits for. Unlike a plan's indices, these already exist. */
      dependsOn: z.array(z.string()).default([]),
      /**
       * Files to put on the item as its own, in the same transaction as
       * the item (EO-704). Honoured only where a door stamped
       * `pathsFrom`; a path that may not be read refuses the whole call.
       */
      paths: ItemPathsSchema.optional(),
      [PATHS_FROM_KEY]: PathsFromSchema.optional(),
      /**
       * The Jira issue this item already is (EO-123).
       *
       * Optional, and omitting it is the ordinary case — an item with
       * no key is an item EO alone knows about, which is what every
       * submission produced before this field existed.
       *
       * Attaching is a local write: `JiraIssueKeySchema` checks the
       * shape and the handler checks no other item holds the key.
       * Nothing is fetched, so a Jira that is down never costs somebody
       * the item they just submitted, and nothing is *imported* —
       * `jira_pull` is still how an issue's words come across.
       */
      jiraKey: JiraIssueKeySchema.optional(),
      /**
       * Whether this item talks to Jira at all (EO-122).
       *
       * Omitted means inherit: the parent feature's setting, or on when
       * there is no parent. Explicit `false` creates the item
       * silenced — it keeps its key and pushes nothing until somebody
       * switches it back on.
       */
      jiraSync: z.boolean().optional(),
      /**
       * A bug's four required facts, and the reason this is not a
       * discriminated union.
       *
       * A bug that reaches the board from here skips intake entirely, and
       * the pinned decision on KAN-4 is that an underspecified bug report
       * is not accepted — so all four are demanded when `type` is `bug`.
       * That check lives in the handler rather than the schema because a
       * union renders as `anyOf` in a tool's JSON Schema, which models
       * handle far worse than a flat object with a refusal that names
       * exactly what is missing.
       */
      stepsToReproduce: z.string().default(""),
      expected: z.string().default(""),
      actual: z.string().default(""),
      environment: z.string().default(""),
    }),
    z.object({
      created: z.boolean(),
      key: z.string().nullable(),
      problem: z.string().nullable(),
    }),
  ),

  // ── Writes (F-05) ───────────────────────────────────────────────
  /*
   * `items:create` used to be here: a form that made an item from a
   * title and a description. It was a third way in, and the one that
   * skipped the part that matters — work typed straight into a column has
   * not been understood by anything. Both remaining doors produce items
   * somebody has already agreed to: a decomposition approved in Discussions
   * (ARCHITECTURE.md, "A column is a responsibility, not a status"), or an issue imported from
   * Jira.
   */
  /**
   * `delivery` is null unless the person asked for one — an ordinary
   * comment answers exactly as it always did (EO-176).
   */
  /*
   * `paths` and `problem` are EO-700's: files named by path, uploaded on
   * the same call, and the sentence saying why a call naming one was
   * refused. A refusal is an answer rather than a throw because a throw
   * reaches a caller as "Internal error" in a packaged build, and the
   * path and the reason are the whole of what the caller needs. Then
   * `commentId` is null and nothing was written.
   */
  "comments:post": channel(
    PostCommentInputSchema.extend({ paths: CommentPathsSchema.optional(), [PATHS_FROM_KEY]: PathsFromSchema.optional(), ...ACTING_DEVICE, ...ACTING_AGENT }),
    z.object({
      commentId: z.string().nullable(),
      resumedRun: z.boolean(),
      delivery: CommentDeliverySchema.nullable().default(null),
      problem: z.string().nullable().default(null),
    }),
  ),
  /** Stages a pasted or dropped file. MIME and byte size are recomputed by main. */
  "attachments:stage": channel(
    z.object({ name: z.string().min(1), dataBase64: z.string().max(MAX_ATTACHMENT_BASE64_CHARS) }),
    z.object({ attachment: AttachmentDraftSchema }),
  ),
  "attachments:discard": channel(z.object({ attachmentId: z.string() }), z.object({ discarded: z.boolean() })),
  "attachments:preview": channel(z.object({ attachmentId: z.string() }), z.object({ dataUrl: z.string().nullable() })),
  /**
   * Deletes any file by id. One of the item's own files (EO-702) is
   * removed on the item page's terms — only by somebody who may edit the
   * item — so the request says who is asking, and a refusal comes back
   * as `problem` rather than as a thrown error.
   */
  "attachments:delete": channel(
    z.object({ attachmentId: z.string(), ...ACTING_DEVICE }),
    z.object({ deleted: z.boolean(), problem: z.string().nullable().default(null) }),
  ),
  /**
   * Puts staged files on the item itself rather than on a comment
   * (EO-702): part of what the item is, as its description is. The ids
   * are `attachments:stage` / `attachments:pick` drafts, so name, MIME
   * type and size are main's, as they are for a comment — and so are
   * the limits: eight in one go, twenty megabytes each.
   */
  "items:addAttachments": channel(
    z.object({ itemId: z.string(), attachmentIds: z.array(z.string()).min(1).max(8), ...ACTING_DEVICE }),
    z.object({ attachments: z.array(AttachmentViewSchema), problem: z.string().nullable() }),
  ),
  /**
   * Takes one of the item's own files off it: the row and the stored
   * bytes (EO-702). A comment's file is refused — it is part of what was
   * said and goes only with its comment.
   */
  "items:removeAttachment": channel(
    z.object({ attachmentId: z.string(), ...ACTING_DEVICE }),
    z.object({ removed: z.boolean(), problem: z.string().nullable() }),
  ),
  /**
   * Pins the comment a thread should be read from, or takes the pin off.
   *
   * `found` is the whole reason there are two booleans here. Pinning is
   * an UPDATE against one id, and an id nothing matches updates no rows
   * and raises nothing — so a caller that invented one, or named a
   * comment somebody deleted while it was reading, would be handed back
   * the `pinned` it sent and read that as done. The renderer only ever
   * pins a comment it just drew, but an MCP client composes ids from
   * whatever it was told, and "it worked" is the one answer that must
   * not be a guess.
   */
  "comments:setPinned": channel(
    z.object({ commentId: z.string(), pinned: z.boolean() }),
    z.object({ pinned: z.boolean(), found: z.boolean() }),
  ),
  /**
   * Removes a comment, the replies filed under it, and — unless told
   * otherwise — the Jira comments they are mirrored to.
   *
   * `deleteInJira` defaults to true, the opposite of `items:delete`,
   * and for a concrete reason rather than taste: a pull recognises EO's
   * own comments by the `jira_comment_id` on the local row. Delete the
   * row and leave Jira's, and the next sync no longer knows it — so the
   * comment is imported straight back. Local-only removal is offered,
   * because it is the honest thing for a comment somebody else wrote in
   * Jira, but it is not the default and the UI says what it costs.
   */
  "comments:delete": channel(
    z.object({ commentId: z.string(), deleteInJira: z.boolean().default(true) }),
    z.object({
      deleted: z.boolean(),
      /** How many comments went, the replies included. */
      deletedCount: z.number(),
      /** Why nothing was deleted, when `deleted` is false. */
      problem: z.string().nullable(),
      /**
       * null when Jira was never asked; otherwise what happened there,
       * whatever happened locally. A comment somebody else wrote is one
       * a token often may not delete, so this failing is ordinary.
       */
      jira: z.object({ attempted: z.number(), deleted: z.number(), problem: z.string().nullable() }).nullable(),
    }),
  ),
  // Editing an item's own text. Deliberately not state — that goes
  // through items:move, so every state change stays an audited
  // transition (invariant #1).
  "items:update": channel(
    z.object({
      // Who is editing (EO-368): on a step that waits on a group only the
      // person holding the item may change it, and on a server the door
      // is what knows who that is.
      ...ACTING_DEVICE,
      itemId: z.string(),
      title: z.string().min(1).optional(),
      body: z.string().optional(),
      /** An open integer the scheduler sorts descending; the UI names the common levels (U-13). The rule every creation door holds it to too (EO-568). */
      priority: ItemPrioritySchema.optional(),
      /**
       * Reclassifying an intake short-circuit before approving it
       * (KAN-37/EO-5). The human is the one who can override the PO's
       * guess, and `pending_approval` — before the item moves on to
       * `todo` — is where the pinned decisions put that judgement.
       *
       * An item type's slug, not a closed list of three (KAN-146). Which
       * types a project has is `item_types` data a pack seeded or a
       * person added (ARCHITECTURE.md, "An item type is data"), so a schema enumerating them here
       * could only ever be right for the developer pack — and would
       * refuse a reclassification into a type the project genuinely has
       * with `Invalid request payload`, which names neither the field
       * nor the fix. The handler resolves the slug against the project's
       * rows and answers an unknown one with `problem`, naming it.
       */
      type: z.string().min(1).optional(),
      /**
       * The definition of done, corrected after the fact (EO-166).
       *
       * Until now the only actor who could write an item's criteria was
       * Jira — `reconcileFields` replaces them wholesale on every pull —
       * so a criterion that went stale an hour after it was written
       * could only be worked around in the body, leaving an item that
       * contradicts itself.
       *
       * Whole-list, like every other field here: what is sent is what
       * the item ends up with. Omitting it leaves the criteria alone,
       * which is what makes an edit of the title safe to send on its
       * own. An empty list is *not* how they are cleared — the handler
       * refuses it, because a story EO would not have accepted at
       * submission is not one an edit should be able to produce.
       *
       * `z.string()` rather than `.min(1)`, unlike `work:submitItem`:
       * the handler drops blank entries, and the app's editor is a
       * textarea whose blank lines are typing rather than a mistake to
       * reject the whole edit over.
       */
      acceptanceCriteria: z.array(z.string()).optional(),
      /**
       * The item's structured fields, under the names its type's shape
       * declares (KAN-147).
       *
       * What the detail's spec editor sends: a bug's four reproduction
       * fields, a pack's `Case` with its customer and its channel. The
       * channel carries an open bag for the reason `work:submitItem`
       * does — which fields exist is the type's to say, and a schema
       * enumerating them here could only ever be right for the types EO
       * ships — and the handler holds what arrives to the type's shape,
       * exactly as the creation doors do.
       *
       * **Per field, not whole-object.** Each key sent replaces that key
       * and the rest of the spec is left alone, because the editor draws
       * the fields the item's *current* type declares and an item may
       * carry more than that: one reclassified before approval, or one
       * imported from Jira. Sending the object whole would make an
       * editor that shows four fields silently delete a fifth.
       */
      spec: z.record(z.string().min(1), z.unknown()).optional(),
      /**
       * The Jira issue this item mirrors, changed after the fact
       * (EO-125). `null` detaches it; omitting it leaves the link alone.
       *
       * A plain string rather than `JiraIssueKeySchema`, unlike
       * `work:submitItem`. A key's three refusals — malformed, held by
       * another item, item gone — all come back as `problem` on a
       * successful call, and validating the shape here would send that
       * one back as `Invalid request payload` instead, which names
       * neither the field nor the fix. The same reason EO-124 took the
       * schema back off a plan's keys. The canonical spelling is still
       * what lands: `linkJiraKey` parses through `JiraIssueKeySchema`.
       */
      jiraKey: z.string().nullable().optional(),
      /**
       * Whether this item talks to Jira at all (EO-122).
       *
       * On a feature this is the feature *and* every story under it —
       * the switch is stored per item and cascaded at the moment it is
       * thrown, never inherited dynamically (the pinned decision on
       * EO-121). Off keeps the key, so on resumes against the same issue.
       */
      jiraSync: z.boolean().optional(),
      /**
       * The branch this item's branch is to be cut from, and its pull
       * request opened against (EO-364). `null` clears it, so the item
       * goes back to the repository's base branch or to stacking;
       * omitting it leaves it alone.
       *
       * Only on an item that works on a branch of a git repository, and
       * only until that branch has been cut — after which where it
       * started is in git history, and the edit is refused naming the
       * branch. A plain string rather than a checked ref name for the
       * reason `jiraKey` is one: a name git would not accept comes back
       * as `problem`, saying what is wrong with it.
       */
      baseBranch: z.string().nullable().optional(),
      /**
       * A branch that already exists, to work on instead of cutting one
       * (EO-365). Stored as the item's `git` branch, marked as named by
       * a person. `null` clears it, so a branch is cut for the item as
       * usual; omitting it leaves it alone.
       *
       * Under the same rule as `baseBranch`: only on an item that works
       * on a branch of a git repository, and only until a branch is in
       * git for it — one EO cut, or this one once Worktree has attached
       * it.
       */
      existingBranch: z.string().nullable().optional(),
      /**
       * The outside issue this item belongs to, as a plain label
       * (EO-637). A string sets it, `null` — or a blank string — clears
       * it, and omitting it leaves it alone.
       *
       * Never sent to any tracker, and shared freely: any number of
       * items may hold the same value. Trimmed, and refused as `problem`
       * — the whole call with it — when it could not appear in a git
       * branch name. A plain string for the reason `baseBranch` is one.
       */
      reference: z.string().nullable().optional(),
      /**
       * Items this one is to wait for from now on, and items it is to
       * stop waiting for (EO-600) — each by key (`EO-42`) or by id, as
       * wherever an item's id is asked for.
       *
       * Until this a dependency could only be set when the work was
       * filed, so an existing item that had to wait on work filed after
       * it had to be deleted and filed again. The rule is the assistant
       * chat's reorder card's, shared rather than copied
       * (`roles/itemDependencies.ts`): the whole change is judged first —
       * a reference naming nothing, the item itself, an item on another
       * project, an edge to add that is already there or one to remove
       * that is not, or a cycle once the additions are merged into the
       * live graph — and refused whole, or written whole with one comment
       * on the item. On a project the organisation's record holds, the
       * record makes the change.
       */
      addDependsOn: z.array(z.string().min(1)).optional(),
      removeDependsOn: z.array(z.string().min(1)).optional(),
      /**
       * Files to add to the item as its own (EO-704), and ids of its own
       * files to take off it. Judged whole with the rest of the call: a
       * path that may not be read, or an id that is not one of this
       * item's own files — a comment's file included — refuses all of it.
       * `paths` is honoured only where a door stamped `pathsFrom`.
       */
      paths: ItemPathsSchema.optional(),
      removeAttachmentIds: z.array(z.string().min(1)).max(100).optional(),
      [PATHS_FROM_KEY]: PathsFromSchema.optional(),
    }),
    z.object({
      updated: z.boolean(),
      /**
       * Why nothing was written, when `updated` is false. Null when the
       * edit landed — and also when the request named no field to
       * change, which is nothing happening rather than a refusal.
       */
      problem: z.string().nullable(),
      /**
       * What a dependency change did (EO-600), by key — present only when
       * the call changed what the item waits for. `freed` says the change
       * left an item that was waiting with nothing open to wait for, so
       * the scheduler offers it on its next tick.
       */
      dependencies: z
        .object({
          added: z.array(z.string()),
          removed: z.array(z.string()),
          stillWaitsFor: z.array(z.string()),
          freed: z.boolean(),
        })
        .optional(),
    }),
  ),
  // A human dragging a card is a manual override (U-02): it records a
  // transitions row with actor "human" and, if an agent is mid-run on
  // that item, cancels it. `cancelActiveRun` is the caller confirming
  // it meant to — the handler refuses rather than discarding work
  // silently when a run is live and it wasn't set.
  "items:move": channel(
    z.object({
      ...ACTING_DEVICE,
      itemId: z.string(),
      toStepId: z.string(),
      /**
       * The pipeline the destination step belongs to (EO-70).
       *
       * How a person hands work to another pipeline: a `user` step is
       * never dispatched and produces no result, so no route is ever
       * taken out of one, and the move itself has to carry the pipeline.
       * Named, it is checked against the step and the pair is refused
       * rather than repaired if they disagree — writing the step without
       * the pipeline is what leaves an item on a step its own pipeline
       * does not have, invisible to every scheduler tick.
       *
       * Omitted means what it has always meant: a move within the
       * pipeline the item is already on, leaving that column untouched.
       */
      toPipelineId: z.string().optional(),
      cancelActiveRun: z.boolean().default(false),
      /**
       * What the person moving it wanted to say (ARCHITECTURE.md, "Moving an item by hand").
       *
       * Posted as a human comment *before* the transition, so it sits above
       * the move in the thread and in front of whichever agent the move
       * dispatches. Moving an item backwards almost always means there is
       * a correction to pass on, and a comment is the only way to pass one
       * (invariant #4) — the move alone tells the next agent nothing but
       * that the item arrived. Empty posts nothing.
       */
      comment: z.string().default(""),
    }),
    z.object({
      moved: z.boolean(),
      cancelledRunId: z.string().nullable(),
      blockedByActiveRun: z.boolean(),
      /** The comment the design posted, when there was one to post. */
      commentId: z.string().nullable().default(null),
      /**
       * Why nothing moved, in words, when `moved` is false and a run was
       * not what stopped it (EO-70).
       *
       * A refusal rather than an error on purpose: a step and a pipeline
       * that disagree is a call that worked and an answer of no, and a
       * throw would reach the caller as "Internal error" — which tells a
       * person nothing and a connected client less. Null whenever the
       * pair was never in question, the active-run refusal included,
       * which keeps its own field and its own words.
       */
      problem: z.string().nullable().default(null),
    }),
  ),
  /**
   * Somebody binding an item to another version of the pipeline it is
   * already on (EO-567, ARCHITECTURE.md, "Publish, lock and versions").
   *
   * An item finishes on the version it entered on, and nothing else
   * changes that: `items:move` within a pipeline never rebinds, and
   * refuses a step its own version lacks. This is the explicit request
   * that does — older or newer, by the number `pipeline:versions` lists.
   *
   * The step, the pipeline, the assignee and the branch stay as they
   * are and no transition is written, because the item does not move.
   * One comment says what changed and who asked. Every refusal is an
   * answer rather than an error, for `items:move`'s reason, and leaves
   * the item exactly as it was.
   */
  "items:moveToVersion": channel(
    z.object({
      ...ACTING_DEVICE,
      itemId: z.string(),
      /** The version number, as `pipeline_versions` lists it. */
      version: z.number().int().positive(),
      /** Why, in the asker's words. Included in the comment the move posts; empty adds nothing. */
      comment: z.string().default(""),
    }),
    z.object({
      moved: z.boolean(),
      /**
       * The move was handed to the organisation's record, which applies
       * it and posts its comment (EO-322). The new binding reaches this
       * desktop on the next sync. False everywhere a move is made here.
       */
      queued: z.boolean().default(false),
      /** The version the item was on, where it is on a pipeline at all. */
      fromVersion: z.number().int().nullable(),
      /** The version it is on now, or would have been. Null when it was refused before one was found. */
      toVersion: z.number().int().nullable(),
      /** The comment the move posted, or will post under on the record. Null when refused. */
      commentId: z.string().nullable(),
      /** Why nothing changed, in a sentence. Null when it moved. */
      problem: z.string().nullable(),
    }),
  ),
  /**
   * A person deciding on a human step (EO-310, ARCHITECTURE.md, "Results and routes").
   *
   * The gesture the non-developer product turns on. `items:move` is a
   * drag, and a drag bypasses routing entirely: it names a destination
   * rather than an answer, so "send it back, the Q3 number is wrong" has
   * no way to travel as a result and a marketing manager would have to
   * know that dropping a card in the "Post to Slack" column is what
   * approving looks like.
   *
   * This names the *answer*. The step declares its results, the route
   * says where each one goes, and the engine resolves the pair — the
   * same `resolveRoute` an agent's verdict takes, which is what makes a
   * person's decision a first-class result rather than an override of
   * one.
   *
   * Refused rather than thrown for `items:move`'s reason and one more of
   * its own: every refusal here is something a person can act on — the
   * wrong step, a key the step does not declare, a reason they have not
   * written yet — and a thrown error would reach them as "Internal
   * error" with the half-written comment lost.
   */
  "items:decide": channel(
    z.object({
      ...ACTING_DEVICE,
      ...ACTING_AGENT,
      itemId: z.string(),
      /** One of the keys the step declares. Not a step id: where it goes is the route's to say. */
      resultKey: z.string(),
      /**
       * Why, in the person's own words (ARCHITECTURE.md, "The item").
       *
       * Posted as their comment *before* the transition, so it sits
       * above the move in the thread and in front of whichever agent the
       * decision dispatches — `items:move`'s arrangement, for its
       * reason. Required when the result says so, which is how the
       * reason for a send-back reaches the step it is sent back to.
       */
      comment: z.string().default(""),
    }),
    z.object({
      decided: z.boolean(),
      /** Where the route sent it, so a caller can say so without re-reading the board. */
      toStepId: z.string().nullable().default(null),
      toStepName: z.string().nullable().default(null),
      /** Named only when the decision handed the item to another pipeline (EO-58). */
      toPipelineId: z.string().nullable().default(null),
      /** The comment posted first, when there was one. */
      commentId: z.string().nullable().default(null),
      /**
       * Why nothing was decided, in words that name which of the three
       * it was: the step, the key, or the missing reason.
       */
      problem: z.string().nullable().default(null),
    }),
  ),
  /**
   * Parks one item on its current pipeline step (EO-45).
   *
   * The active-run confirmation and optional leading human note mirror
   * `items:move`; only the stored effect differs. A hold never writes
   * workflow state.
   */
  "items:hold": channel(
    z.object({
      itemId: z.string(),
      cancelActiveRun: z.boolean().default(false),
      comment: z.string().default(""),
    }),
    z.object({
      held: z.boolean(),
      cancelledRunId: z.string().nullable(),
      blockedByActiveRun: z.boolean(),
      commentId: z.string().nullable().default(null),
    }),
  ),
  /**
   * Clears a manual hold without moving the item from its current step.
   *
   * The active-run guard is the same one `items:hold` and `items:move`
   * apply. A held item normally has nothing in flight — holding either
   * refused or cancelled the run — but cancellation is asynchronous, and a
   * run queued against an item that is about to become dispatchable again
   * is exactly the case where quietly resuming would put two agents on the
   * same work. So the refusal is the default and the caller has to confirm.
   *
   * Resume takes no note of its own: the drop dialog is where a person
   * explains themselves (EO-44), and there is no dialog on the way out.
   */
  "items:resume": channel(
    z.object({
      itemId: z.string(),
      cancelActiveRun: z.boolean().default(false),
    }),
    z.object({
      resumed: z.boolean(),
      cancelledRunId: z.string().nullable(),
      blockedByActiveRun: z.boolean(),
    }),
  ),
  /**
   * Takes an item, or hands it to somebody (EO-305, ARCHITECTURE.md, "Identity").
   *
   * Neither is a transition. Invariant #1 is about `items.stepId`, and
   * claiming writes `items.assignee_id` and nothing else: the item stays
   * exactly where it was, on the same step, in the same column. That is
   * what makes a claim safe to offer on a card — pressing it cannot
   * move work, only say who has it.
   *
   * Two channels rather than one with an optional person, because they
   * are different acts with different authority. Claiming is "I am
   * taking this", and its payload cannot name anybody else; assigning is
   * "you are taking this", which 7b will gate on who is asking. One
   * channel would have made the second indistinguishable from the first
   * on the wire.
   */
  "items:claim": channel(
    z.object({ itemId: z.string(), ...ACTING_DEVICE }),
    z.object({
      /**
       * Who now holds it, so the caller can say so without re-reading the board.
       *
       * Null on a signed-in desktop that cannot yet say (EO-367): a claim
       * there is asked of the organisation's record, and a machine with no
       * signed-in person to show — or an assignee it has no row for —
       * shows nobody until the record answers, rather than the local "you".
       */
      assigneeId: z.string().nullable(),
      assigneeName: z.string().nullable(),
      /**
       * The comment the claim posted — invariant #4's one channel, and how
       * the thread records it. On a signed-in desktop, the id the record's
       * comment will have once it applies the claim. On a refusal, the
       * comment that says why.
       */
      commentId: z.string(),
      /**
       * Why the claim was not applied (EO-368): the step waits on a group
       * the caller is not in, or somebody else holds the item. Null when
       * it was applied, and on a signed-in desktop, where the record
       * decides later and the answer arrives in the inbox.
       */
      problem: z.string().nullable().default(null),
    }),
  ),
  /**
   * Taking an item over from the person who holds it, on a step that
   * waits on a group (EO-368).
   *
   * Only the holder decides there, so a member who needs to act on
   * somebody else's item is warned — the warning names the holder — and
   * this is what confirming it sends. `fromPersonId` is the holder they
   * were warned about, and it is a condition: if the item has changed
   * hands since, nothing is taken and the answer names who holds it now.
   * Who is taking it is never in the payload; it is whoever is asking.
   */
  "items:takeOver": channel(
    z.object({ itemId: z.string(), fromPersonId: z.string(), ...ACTING_DEVICE }),
    z.object({
      /** As `items:claim`'s: who holds it now, or null where a signed-in desktop cannot yet say. */
      assigneeId: z.string().nullable(),
      assigneeName: z.string().nullable(),
      /** The takeover's comment, or the refusal's. Null where nothing was said because there was nothing to take. */
      commentId: z.string().nullable(),
      /** Why nothing was taken, when nothing was. */
      problem: z.string().nullable().default(null),
    }),
  ),
  /**
   * Who may act on this item where it stands, for the person asking
   * (EO-368).
   *
   * Null wherever nothing is gated — a step that is not a human one, one
   * with no owner or a single person as owner, and every item on a
   * desktop signed in to nothing — which is what keeps every screen as
   * it was outside a group-owned human step.
   *
   * Otherwise the group the step waits on, who holds the item, and which
   * of three the caller is: the `holder`, who decides; a `member`, who
   * may claim an unclaimed item or take a held one over after a warning;
   * or an `outsider`, who may do neither. An administrator outside the
   * group reads as a `member` on an item somebody holds — they may take
   * it over after the warning — and as an `outsider` on an unclaimed one,
   * which they may not claim (EO-368). The record's refusal remains
   * the enforcement; this is what lets a screen not offer what would be
   * refused.
   */
  "items:authority": channel(
    z.object({ itemId: z.string(), ...ACTING_DEVICE }),
    z.object({
      authority: z
        .object({
          group: z.object({ id: z.string(), name: z.string() }),
          holder: z.object({ id: z.string(), name: z.string() }).nullable(),
          you: z.enum(["holder", "member", "outsider"]),
        })
        .nullable(),
    }),
  ),
  "items:assign": channel(
    z.object({ itemId: z.string(), personId: z.string(), ...ACTING_DEVICE }),
    z.object({
      /** As `items:claim`'s: null where a signed-in desktop has no row for the person yet. */
      assigneeId: z.string().nullable(),
      assigneeName: z.string().nullable(),
      commentId: z.string(),
    }),
  ),
  /**
   * Removes an item and its stories for good (KAN-30).
   *
   * `cancelActiveRun` mirrors `items:move`: the handler refuses rather
   * than discarding an agent's work silently. `force` is the same
   * confirmation one level down, for a worktree holding uncommitted
   * changes that exist nowhere else.
   *
   * `deleteInJira` is separate from the local delete and reported
   * separately — the two are not one transaction, and a token without
   * the Delete Issues permission must not leave the project unchanged.
   */
  "items:delete": channel(
    z.object({
      itemId: z.string(),
      cancelActiveRun: z.boolean().default(false),
      deleteInJira: z.boolean().default(false),
      /** Discard a worktree holding uncommitted changes. Its branch survives regardless. */
      discardUncommitted: z.boolean().default(false),
    }),
    z.object({
      deleted: z.boolean(),
      /** How many items went, the parent included. */
      deletedCount: z.number(),
      /** Both refusals, so the UI knows which confirmation to offer rather than parsing prose. */
      blockedByActiveRun: z.boolean(),
      blockedByUncommittedWork: z.boolean(),
      /** Why nothing was deleted, when `deleted` is false. */
      problem: z.string().nullable(),
      /**
       * What happened to the mirrored issues, when there were any. Counts
       * rather than one key: a subtree can span several, and the local
       * delete stands whatever Jira did with its half.
       */
      jira: z.object({ attempted: z.number(), deleted: z.number(), problem: z.string().nullable() }).nullable(),
      /**
       * Checkouts the delete could not remove, left on disk (issue
       * #131).
       *
       * Reported on a *successful* delete, which is the point: the rows
       * are what the person asked to be gone and they are gone, but a
       * worktree that outlived them is a directory named after an item
       * nothing can explain any more. Naming the path and what stopped
       * the removal is the difference between something to clean up and
       * something to puzzle over — silence here is work dropped on the
       * floor (invariant #8).
       */
      leftoverWorktrees: z
        .array(z.object({ itemKey: z.string(), path: z.string(), problem: z.string() }))
        .default([]),
    }),
  ),
  /*
   * `items:approve` used to live here: approving a decomposition on a
   * feature parked at `pending_approval`. The gate did not go away — the design both insist a human
   * reads the story DAG
   * before it becomes twelve rows — it moved to `assist:approve`, which
   * is the same gate on the surface where the plan was written.
   */
  /**
   * What one run did, as steps (`TurnStepSchema`): its narration, its
   * reasoning, each tool call with what came back, the files it edited.
   * What a finished turn's fold opens to in a chat.
   */
  "runs:steps": channel(z.object({ runId: z.string() }), z.object({ steps: z.array(TurnStepSchema) })),
  /**
   * A running run as it stands this moment — its steps, and the words it
   * is writing that are not stored yet (`LiveTurnSchema`) — so a step's
   * transcript can draw the agent's words as they are written, the way a
   * chat does. Null once the run is over: there is nothing live to draw.
   */
  "runs:live": channel(z.object({ runId: z.string() }), z.object({ turn: LiveTurnSchema.nullable() })),
  "runs:cancel": channel(z.object({ runId: z.string() }), z.object({ cancelled: z.boolean() })),
  "engine:pause": channel(z.object({ cancelRunning: z.boolean().default(false) }), EngineStatusSchema),
  "engine:resume": channel(z.void(), EngineStatusSchema),
  "engine:status": channel(z.void(), EngineStatusSchema),
  // Preferences (U-04's Do Not Disturb today; U-06 will add more).
  /**
   * `archiveAfterDays` is how long finished work stays on the project
   * (KAN-33). `0` archives as soon as an item is done; `null` turns
   * archiving off entirely, which is why it is nullable rather than a
   * sentinel — someone will want the project to keep everything.
   */
  "settings:get": channel(
    z.void(),
    z.object({
      doNotDisturb: z.boolean(),
      archiveAfterDays: z.number().int().nonnegative().nullable(),
      /** How often EO pulls comments and edits from Jira. Null is off. */
      jiraPullMinutes: z.number().int().positive().nullable(),
      /** The path segment before `/<KEY>` in a branch name (EO-15). Seeded once from git config. */
      branchPrefix: BranchPrefixSchema,
      /**
       * How many versions of each pipeline are kept (EO-359). Whole, and
       * never below one: the version a pipeline is on cannot be deleted,
       * so a limit of none would be a setting EO could not honour.
       */
      pipelineVersionsToKeep: PipelineVersionsToKeepSchema,
      /**
       * How many versions of each module are kept (EO-360). A setting of
       * its own rather than the pipelines' one, and held to the same
       * floor for the same reason.
       */
      moduleVersionsToKeep: ModuleVersionsToKeepSchema,
    }),
  ),
  /**
   * A partial update: only the keys present are written.
   *
   * Deliberately not "send the whole object back". With every field
   * required, the Do Not Disturb toggle in the inbox — which knows
   * nothing about archiving — would reset the archive delay every time
   * someone clicked it. A screen should only be able to change the
   * setting it is showing.
   */
  "settings:set": channel(
    z.object({
      doNotDisturb: z.boolean().optional(),
      archiveAfterDays: z.number().int().nonnegative().nullable().optional(),
      jiraPullMinutes: z.number().int().positive().nullable().optional(),
      branchPrefix: BranchPrefixSchema.optional(),
      pipelineVersionsToKeep: PipelineVersionsToKeepSchema.optional(),
      moduleVersionsToKeep: ModuleVersionsToKeepSchema.optional(),
    }),
    z.object({
      doNotDisturb: z.boolean(),
      archiveAfterDays: z.number().int().nonnegative().nullable(),
      jiraPullMinutes: z.number().int().positive().nullable(),
      branchPrefix: BranchPrefixSchema,
      pipelineVersionsToKeep: PipelineVersionsToKeepSchema,
      moduleVersionsToKeep: ModuleVersionsToKeepSchema,
    }),
  ),
  /**
   * Pulls comments and edits from Jira for one item, now.
   *
   * A feature pulls its stories too — each is its own Jira issue, and
   * that is what "sync this feature" plainly means.
   */
  "jira:pull": channel(
    z.object({ itemId: z.string() }),
    z.object({ comments: z.number(), edits: z.number(), attachments: z.number(), skippedAttachments: z.number(), problem: z.string().nullable() }),
  ),
  /** What the project has put away (KAN-33). Scoped to the active project, like the project itself. */
  /** Scoped like `items:list`, and for the same reason. */
  "items:listArchived": channel(
    z.object({ projectId: z.string().nullable().optional(), ...ArchivedItemListFiltersSchema.shape, ...ACTING_DEVICE }).default({}),
    z.object({ items: z.array(ItemSummarySchema) }),
  ),
  /**
   * Puts an archived item back, or archives a live one by hand.
   *
   * The manual half exists because the sweep only ever considers
   * *finished* work — someone who wants an abandoned item off the
   * project has no other way to say so short of deleting it.
   */
  "items:setArchived": channel(
    z.object({ itemId: z.string(), archived: z.boolean() }),
    z.object({ archived: z.boolean(), problem: z.string().nullable() }),
  ),
  /**
   * Replaces what this item has produced with a corrected version
   * (EO-298, ARCHITECTURE.md, "The output is a comment").
   *
   * The command behind phase 6's editor, landed ahead of it and with no
   * screen on it yet. What it does is the whole of the design: the step
   * that sends, posts or publishes works from the item's *current*
   * output, so a person who fixes a drafted reply before it goes out has
   * to be able to make their version the current one.
   *
   * A new comment rather than an edit to the old one. The output it
   * replaces stays in the thread under it, which is what makes "the
   * approver changed this, and here is what it said before" a thing the
   * item can still answer — the same refusal to rewrite the record that
   * invariant 3 makes of `run_events`.
   *
   * Takes no `parentId`: which output this supersedes is not a caller's
   * choice. It is whichever one is current at the moment it lands, which
   * is the only answer that stays true if two edits race.
   */
  "items:setOutput": channel(
    z.object({ itemId: z.string(), body: z.string() }),
    z.object({
      /** The comment that is now the item's output, or null when nothing was posted. */
      commentId: z.string().nullable(),
      /** What it superseded, if it superseded anything. Null for an item that had no output. */
      supersededCommentId: z.string().nullable(),
      /** Why nothing was posted, when nothing was. */
      problem: z.string().nullable(),
    }),
  ),

  // ── The assistant's room (EO-188, EO-192, EO-193) ───────────────
  //
  // The third conversation with the system agent, and the same machinery
  // again — `DiscussionSchema` renders it, an @-mention dispatches it.
  //
  // It is not keyed on a page (EO-193). It used to be one thread per
  // page, keyed by `pageKeyFor`, and the reason was that the page was
  // preloaded into every turn: a thread opened on an item carried that
  // item's section, so carrying it to another screen would have described
  // somewhere the person had left. EO-192 ended that — the agent reads
  // the screen itself with `view_current`. Opening the room from
  // anywhere shows the same chat, and nothing here takes a key.
  //
  // Several chats can be live at once (EO-391), and one of them is on
  // show. Which one is the main process's to say, so every surface is
  // handed the same chat; starting another (`assist:new`) and showing
  // another (`assist:resume`) are navigation, and neither puts a chat
  // away or stops anything running in one. Each chat is its own item and
  // so its own provider session.
  //
  // `page` survives on `assist:send` alone, for the one job left to it:
  // it names the pipeline a graph raised in this room would be published
  // against, which is the only thing in the room that names one. It is a
  // **route and its parameters**, never a sentence, and the main process
  // resolves it to a pipeline that actually exists (invariant #5). It is
  // never rendered into a prompt and never read back as an account of
  // where somebody is — that is `view:current`'s answer, live.
  //
  // Opening carries none, because opening decides nothing any more: a
  // turn is only ever started by a message.
  //
  // A route this build does not know is accepted rather than refused. The
  // person still gets their turn — see `PageDescriptorSchema`.
  /**
   * The chat on show, started if there is none.
   *
   * Each live chat idle for longer than `engine.assistExpiryDays` is
   * archived on the way, on its own last word; when the one on show was
   * among them the answer is a fresh chat.
   */
  "assist:open": channel(z.void(), z.object({ conversation: DiscussionSchema })),
  /**
   * Starts a new chat and shows it, putting nothing away (EO-391).
   *
   * The chat that was on show stays live: a turn running in it runs to
   * its end and answers there, and nothing waiting in it is dismissed.
   * An empty chat is shown rather than a second one made, so pressing
   * this twice leaves one empty chat and not two.
   */
  "assist:new": channel(z.void(), z.object({ conversation: DiscussionSchema })),
  /**
   * Fix with assistant (EO-533): the chat about one held template
   * update, shown.
   *
   * The first press starts a new chat whose first message is EO's brief
   * — the pipeline, the template and both versions, the release notes
   * and the conflicting keys — with the pipeline as its subject, and the
   * assistant's first turn is dispatched without anybody typing. Every
   * later press, while that chat still exists, shows the same chat.
   *
   * `commentId` is the notice pressed, where there is one: a pipeline no
   * project has adopted is announced on several projects' threads, and
   * the chat is opened on the project whose notice was pressed.
   *
   * Refused, with the sentence to show and no chat, for a conflict this
   * installation does not hold, or one resolved before a chat was ever
   * opened for it.
   */
  "assist:openUpdateConflict": channel(
    z.object({ conflictId: z.string().min(1), commentId: z.string().nullable() }),
    z.object({ conversation: DiscussionSchema.nullable(), problem: z.string().nullable() }),
  ),
  /**
   * Archives the chat on show and leaves an empty one (EO-193).
   *
   * Archived rather than deleted, which is invariant #3 and the same
   * choice every other retirement in EO has made: everything said in it
   * and every run it hosted stays where it is, and a person can read it
   * in the archive. That is also what makes this safe to do in one click
   * with no dialog — nothing is destroyed, so there is nothing to
   * confirm.
   *
   * Only that chat (EO-391): every other live chat, and any turn running
   * in one, is untouched.
   *
   * Takes nothing: which chat is on show is not the renderer's to say.
   */
  "assist:clear": channel(z.void(), z.object({ conversation: DiscussionSchema })),
  /**
   * The assistant chats a person has: the live ones, then those put away
   * by Clear or by the idle expiry. A put-away chat nobody said anything
   * in is left out — there is nothing in it to go back to. A live one is
   * listed even when it is empty (EO-390).
   *
   * The live ones come in the order the person keeps them in (EO-438),
   * which only `assist:reorder` changes: showing a chat, or a message
   * landing in one, moves nothing. A chat with no place yet is given
   * one — a new chat first, one gone back to from the put-away ones
   * last — and before anything has been moved the live ones read
   * newest-started first. The put-away ones follow, most recently active
   * first. `lastActivityAt` is answered for every chat and orders only
   * those.
   *
   * `live` is each chat's own state — not archived — and more than one
   * can carry it (EO-391). `shown` marks the one every surface is
   * showing: at most one entry, and exactly one once the room has been
   * opened.
   *
   * `title` is the first thing the person said in it, cut to a line;
   * a chat is about whatever somebody opened it to ask. An empty live
   * one carries the room's own name.
   */
  "assist:list": channel(z.void(), z.object({ conversations: z.array(AssistChatSchema) })),
  /**
   * Moves one live chat to `index` among the live chats, counted from
   * the top, and stores the order (EO-438). The others keep their
   * relative order. An index past either end is the nearest end.
   *
   * Only live chats are ordered. For a chat that is put away, removed or
   * not an assistant chat nothing is written and `problem` says why —
   * moving a chat never changes whether it is put away.
   *
   * `conversations` is `assist:list`'s answer as it stands afterwards,
   * moved or not.
   */
  "assist:reorder": channel(
    z.object({ conversationId: z.string(), index: z.number().int().nonnegative() }),
    z.object({ conversations: z.array(AssistChatSchema), problem: z.string().nullable() }),
  ),
  /**
   * Shows another chat: a live one, or an earlier one made live again.
   *
   * Navigation (EO-391). The chat that was on show stays live, with
   * whatever is running or waiting in it, and no other chat is archived,
   * stopped or dismissed. Nothing is deleted (invariant #3); removing a
   * chat is `assist:remove`, below.
   * `problem` names why nothing changed (not an assistant thread, gone,
   * on an archived project), and the chat on show is returned with it.
   */
  "assist:resume": channel(z.object({ conversationId: z.string() }), z.object({ conversation: DiscussionSchema, problem: z.string().nullable() })),
  /**
   * Permanently removes one assistant thread and everything owned by it
   * — its messages, run history, queued requests and attachments
   * (EO-390). The deletion `deleteConversationItem` performs, and
   * invariant #3's one exception: a person asking for the thread itself
   * to be gone.
   *
   * Refused, with nothing deleted and `problem` saying why, for an id
   * that is not an assistant thread or no longer exists — a stale window
   * is an ordinary thing, so the reason travels in the validated
   * response rather than as an error.
   *
   * Removing a chat cancels a turn running in it. Removing the one on
   * show leaves an empty one in its place, as Clear does: `conversation`
   * is that chat. It is null when any other was removed, which leaves
   * what the room shows as it was.
   */
  "assist:remove": channel(
    z.object({ conversationId: z.string() }),
    z.discriminatedUnion("removed", [
      z.object({ removed: z.literal(true), conversation: DiscussionSchema.nullable() }),
      z.object({ removed: z.literal(false), problem: z.string() }),
    ]),
  ),
  /**
   * Permanently removes several assistant threads at once (EO-442): the
   * rail's multi-select, behind one warning. Each id goes through the
   * deletion `assist:remove` performs, so a turn running in one is
   * cancelled and its messages, run history, queued requests and
   * attachments go with it — invariant #3's exception, as for one.
   *
   * Each id stands on its own. One that is not an assistant thread or no
   * longer exists is refused with nothing of it touched, and its
   * sentence is in `refused`; the others in the same call are still
   * removed. `removed` lists the ids that were. A repeated id counts once.
   *
   * When the chat on show is among those removed, exactly one new empty
   * chat is left in its place, however many went: `conversation` is that
   * chat. It is null otherwise, and what the room shows did not change.
   */
  "assist:removeMany": channel(
    z.object({ conversationIds: z.array(z.string()).min(1) }),
    z.object({
      removed: z.array(z.string()),
      refused: z.array(z.object({ conversationId: z.string(), problem: z.string() })),
      conversation: DiscussionSchema.nullable(),
    }),
  ),
  /**
   * Says something from a page.
   *
   * `conversationId` is what lets a thread outlive the page it began on:
   * the panel does not close when you navigate, so somebody can open the
   * widget on an item, walk to Settings and keep typing. The
   * conversation stays the one they were in, and `page` carries the board
   * they are on now so that a graph proposed there is publishable there.
   *
   * Null sends to the chat on show, or starts one.
   */
  "assist:send": channel(
    z.object({
      page: PageDescriptorSchema,
      conversationId: z.string().nullable(),
      body: z.string().default(""),
      // The cap is the storage's own (EO-194): every surface that stages
      // files through `attachments:*` holds to it, so a room with a
      // different number in it would be a second opinion about the same
      // limit.
      attachmentIds: z.array(z.string()).max(8).optional(),
      interrupt: z.boolean().default(false),
    }),
    z.object({
      conversation: DiscussionSchema,
      // What became of a message sent while a turn was running (EO-395):
      // delivered into it, or left for the next one with `note` saying
      // why. Null when nothing was running, which is an ordinary send.
      delivery: CommentDeliverySchema.nullable().default(null),
    }),
  ),
  /**
   * Stops the turn running in an assistant chat — the Stop button, and
   * Escape in the composer.
   *
   * Asks the backend to end the turn (`InterruptibleStream.interrupt`)
   * rather than abandoning it, so the thread survives and the next
   * message continues the same conversation, and posts "Turn stopped."
   * so the thread says what happened (invariant 8). `stopped` is false
   * when nothing was running by the time it arrived.
   */
  "assist:stop": channel(z.object({ conversationId: z.string() }), z.object({ stopped: z.boolean(), conversation: DiscussionSchema })),
  /**
   * Changes the model, the reasoning effort or whether reasoning is shown
   * for the turns that follow in one assistant chat.
   */
  "assist:settings": channel(
    z.object({
      conversationId: z.string(),
      model: z.string().nullable().optional(),
      reasoningEffort: z.string().nullable().optional(),
      showReasoning: z.boolean().optional(),
    }),
    z.object({ settings: DiscussionSettingsSchema, conversation: DiscussionSchema }),
  ),
  /**
   * The person has started typing in an assistant chat with nothing
   * running in it: start the backend for the turn they are about to ask
   * for, so its first word arrives sooner (`AgentProvider.prewarm`) —
   * Claude Desktop starts its CLI while you type. Nothing is recorded; the
   * warm backend is shut down if nobody sends within a minute.
   */
  "assist:prewarm": channel(z.object({ conversationId: z.string() }), z.object({ warming: z.boolean() })),
  /**
   * Takes back a message that is waiting for the next turn — Claude
   * Desktop's Cancel on a queued message. The message stays in the thread
   * (it was said, and the thread is the record); what is withdrawn is the
   * request to the assistant, so no turn starts for it. Refused for a
   * message that is not waiting: one already being answered is stopped
   * with Stop.
   */
  "assist:withdraw": channel(
    z.object({ conversationId: z.string(), messageId: z.string() }),
    z.object({ withdrawn: z.boolean(), conversation: DiscussionSchema }),
  ),
  /**
   * Older messages of an assistant chat, a page at a time: the newest
   * `limit` before `before`, the oldest message the window already has.
   * The chat's view carries only its newest stretch (`DiscussionView.earlier`
   * says how much more there is), the way Claude Desktop pages a long
   * transcript rather than drawing it whole.
   */
  "assist:earlier": channel(
    z.object({ conversationId: z.string(), before: z.string(), limit: z.number().int().positive().max(500).default(50) }),
    z.object({ messages: z.array(DiscussionMessageSchema), earlier: z.number().int().nonnegative() }),
  ),
  /**
   * Starts a new chat holding this one's conversation up to a message,
   * and shows it — Claude Desktop's fork, and the honest form of "go back
   * and try that differently" in a thread that is a record (invariant 3).
   *
   * Nothing in the original changes. What was said up to and including
   * `messageId` is posted again into the new chat, signed by whoever said
   * it, under a first line naming where it came from; cards come across
   * as what they said, not as buttons, since approving work twice from
   * two chats is the outcome nobody wants.
   */
  "assist:fork": channel(
    z.object({ conversationId: z.string(), messageId: z.string() }),
    z.object({ conversation: DiscussionSchema, problem: z.string().nullable() }),
  ),
  /**
   * Answers a batch of questions the widget put on a card (EO-190).
   *
   * One request rather than one per question: the questions were asked
   * together so the answers go back together, and the last one is what
   * starts the next turn. A null `answer` is a skip, recorded as such, so
   * the assistant knows the question was seen and declined rather than
   * lost.
   */
  "assist:answer": channel(
    z.object({
      conversationId: z.string(),
      answers: z
        .array(z.object({ questionId: z.string(), answer: z.string().nullable() }))
        .min(1)
        .max(6),
    }),
    z.object({
      answered: z.number(),
      problem: z.string().nullable(),
      conversation: DiscussionSchema,
    }),
  ),
  /**
   * Creates the work a decomposition card proposes (EO-190).
   *
   * `applyDiscussionProposal` is behind it, as it is behind
   * `work:submitPlan`: the assistant is one surface a proposal can appear
   * on, never a second way of building one.
   */
  "assist:approve": channel(
    z.object({ conversationId: z.string(), messageId: z.string() }),
    z.object({
      applied: z.boolean(),
      problem: z.string().nullable(),
      createdKeys: z.array(z.string()),
      changedKeys: z.array(z.string()),
      conversation: DiscussionSchema,
    }),
  ),
  /**
   * A work proposal at full length, by the message its card is (EO-408).
   *
   * What the canvas draws a proposed item from: the same proposal
   * `assist:approve` files, with each item's description and where the
   * work would land. By message id alone — the view is an address, and
   * an address reloaded in a window that has since moved to another chat
   * must still find its proposal. Null for a message that is not a work
   * proposal in an assistant conversation.
   *
   * Reads only. A proposal that can no longer be approved still answers,
   * with `canApprove` false and `closed` saying why.
   */
  "assist:proposal": channel(z.object({ messageId: z.string() }), z.object({ proposal: ProposalDetailSchema.nullable() })),
  /**
   * The graph behind a draft card, ready for `pipeline:save` (EO-190).
   *
   * Answers with the whole publishable graph rather than the draft. There
   * is no editor to hold every step's configured inputs and timeout and
   * carry them across, and the assistant must not invent them, so the
   * carry-across happens in the main process, over the pipeline as it
   * stands, and what comes back is exactly what the person then
   * publishes through `pipeline:save`.
   *
   * `problem` with a null `pipelineId` is the honest answer for a draft
   * that has been superseded, that no longer fits the pipeline, or that
   * was raised somewhere with no pipeline to publish against.
   *
   * `newPipelineName` is set, with `pipelineId` null and no `problem`,
   * for a draft that creates a pipeline (EO-381). There is no id to give
   * yet — the pipeline is created when the person presses Publish, and
   * not before — so its steps and routes carry an empty `pipelineId`, and
   * Publish goes through `assist:publishNew` rather than `pipeline:save`.
   *
   * `waiting` is the modules the draft cannot be published without
   * (EO-399): ones nobody has approved yet, and ones deleted since the
   * card was posted. Waiting is a state of the card and not a refusal —
   * the graph is answered beside it, `problem` stays null, and the card
   * keeps its picture. Nothing here is the gate: `assist:publishNew` and
   * `pipeline:save` refuse a graph that runs an unapproved module
   * whatever this said. `waitingProblem` is the same fact as a sentence,
   * for a surface that has nowhere to list modules and ends Publish in
   * one.
   */
  "assist:draft": channel(
    z.object({ conversationId: z.string(), messageId: z.string() }),
    z.object({
      pipelineId: z.string().nullable(),
      newPipelineName: z.string().nullable().default(null),
      steps: z.array(PipelineStepViewSchema),
      routes: z.array(StepRouteViewSchema),
      entryStepId: z.string().nullable(),
      /** The entry rules the draft sets (EO-610), sent on to `pipeline:save`. Absent leaves the pipeline's alone. */
      entryRules: EntryRulesSchema.optional(),
      problem: z.string().nullable(),
      waiting: z.array(AssistWaitingModuleSchema).default([]),
      waitingProblem: z.string().nullable().default(null),
      /** The action definitions the draft is published with (EO-426), sent on to `pipeline:save` beside the graph. */
      actions: z.array(ActionDefinitionDraftSchema).default([]),
      /** The name the draft renames the pipeline to (EO-520), applied with `pipelines:update` once the graph has saved. Null when it keeps the name. */
      rename: z.string().nullable().default(null),
      /** The icon the draft gives the pipeline (EO-520), applied with the name. Null when it leaves the icon alone. */
      icon: z.string().nullable().default(null),
      /**
       * The version the draft restores (EO-520), sent on to `pipeline:save`
       * as `restoredFrom` — which reads who each of that version's person
       * steps waited on from the version itself and puts them back.
       */
      restoredFrom: z.number().int().positive().nullable().default(null),
      /**
       * The held template update publishing this draft resolves (EO-534),
       * or null. Set only on a draft raised in the chat Fix with assistant
       * opened for that update, for the pipeline it holds: once the graph
       * has saved, the caller says so with `assist:draftPublished`.
       */
      updateConflictId: z.string().nullable().default(null),
      /**
       * True where that update is held on the organisation's record
       * rather than here: Publish is then `assist:publishOnRecord`, which
       * saves the graph on the record, never `pipeline:save` on this copy.
       */
      updateConflictOnRecord: z.boolean().default(false),
      /**
       * The trial plan beside the draft (EO-587), where the assistant
       * planned a test with real runs: what makes the card a design card,
       * with Approve design and no Publish. Null on a publish card.
       */
      trial: AssistTrialCardSchema.nullable().default(null),
    }),
  ),
  /**
   * Approve design on a design card (EO-587) — a person pressed it.
   *
   * Approving says "this is the shape I want", and publishes nothing. In
   * one transaction: the draft is made into a hidden trial pipeline
   * (`createTrialFromDraft`), every module it runs is granted permission
   * to run on that trial's items only, within the needs it declares now,
   * the trial plan is recorded in the trial's terms, every test item is
   * filed as a trial item, and the first round is started. Refused, and
   * nothing is made, for a card that is superseded, has no trial plan, was
   * approved already, or whose draft or plan no longer fits.
   *
   * A design approved while an earlier one of the same conversation is
   * under test replaces it: the new trial runs the draft copies the loop
   * has already fixed, and the earlier trial and its test items are
   * discarded through the item-delete path.
   */
  "assist:approveDesign": channel(
    z.object({ conversationId: z.string(), messageId: z.string() }),
    z.object({
      approved: z.boolean(),
      /** The trial pipeline made. Null when nothing was. */
      trialPipelineId: z.string().nullable(),
      /** The round started: 1 for a new trial. Null when none was. */
      round: z.number().int().nullable(),
      /** The test items filed, in the plan's order. */
      items: z.array(z.object({ id: z.string(), key: z.string(), title: z.string() })).default([]),
      /** Why nothing was made, or — approved — what could not be done after, such as discarding the trial it replaced. */
      problem: z.string().nullable(),
    }),
  ),
  /**
   * A draft card's graph has been published (EO-534) — what the card
   * says once `pipeline:save` saved it.
   *
   * Where the draft was raised in the chat that holds a template update
   * conflict, for that pipeline, this resolves the conflict and moves the
   * pipeline's base to the held template version. Verified rather than
   * taken on trust (invariant #5): the pipeline must have filed a version
   * since the card was posted, and its graph must be the card's.
   * `resolved: false` with no `problem` for a draft that resolves
   * nothing; with a `problem` for one that should have and could not.
   */
  "assist:draftPublished": channel(
    z.object({ conversationId: z.string(), messageId: z.string() }),
    z.object({ resolved: z.boolean(), problem: z.string().nullable() }),
  ),
  /**
   * Publishes a draft card that resolves a template update the
   * organisation's record holds (EO-534) — Publish on such a card.
   *
   * The pipeline is the record's, and so is the conflict: the draft's
   * graph, read again from its run here, is sent to the record
   * (`record:resolveUpdateConflict`), which saves it, resolves the update
   * and moves the base. Replicas follow the record's graph; where the
   * organisation has not published the pipelines section this desktop
   * keeps its own copy, so the same graph is saved here too, once the
   * record has taken it. Nothing is written here when the record refuses.
   */
  "assist:publishOnRecord": channel(
    z.object({ conversationId: z.string(), messageId: z.string() }),
    z.object({ saved: z.boolean(), resolved: z.boolean(), problem: z.string().nullable() }),
  ),
  /**
   * Publishes a draft card that creates a pipeline (EO-381).
   *
   * The one assist write that is not `pipeline:save` from the renderer,
   * because there is nothing for `pipeline:save` to save into until the
   * pipeline exists — and a pipeline created by one call and filled by a
   * second is an empty board left behind whenever the second is refused.
   * So the pipeline is created and its graph saved through the same
   * `savePipeline` that channel uses, in one transaction: refused, and
   * nothing has been created.
   *
   * Re-reads and re-validates the draft from its run, as `assist:draft`
   * does, and is held to the same "newest card wins" rule.
   */
  "assist:publishNew": channel(
    z.object({ conversationId: z.string(), messageId: z.string() }),
    z.object({
      saved: z.boolean(),
      /** The pipeline created, when it was. */
      pipelineId: z.string().nullable(),
      /** Why nothing was created, in the words the validator or the name check used. Null when saved. */
      problem: z.string().nullable(),
    }),
  ),
  /**
   * Approve and publish on a draft card that needs modules nobody has
   * approved (EO-581) — one button for the whole card.
   *
   * Runs every such module's tests through the runner `modules:approve`
   * uses and holds each to the same rule: at least one case, every case
   * passing, line coverage at the bar or acknowledged. Then, in one
   * transaction, approves every one of them and publishes the pipeline —
   * creating it, as `assist:publishNew` does, or saving into the one that
   * exists, as `pipeline:save` does, with the name, icon and held template
   * update the card carries. Any module whose tests fail or do not run,
   * or a graph the save refuses, and nothing is approved and no version
   * is written.
   *
   * `acknowledgeLowCoverage` names the modules whose coverage figure the
   * person has confirmed on the card. A module under the bar that is not
   * named comes back in `coverage`, with nothing written, for the card to
   * ask about. `modules` is how each module's tests went, so the card can
   * say which module and which case refused.
   */
  "assist:approveAndPublish": channel(
    z.object({ conversationId: z.string(), messageId: z.string(), acknowledgeLowCoverage: z.array(z.string()).default([]) }),
    z.object({
      saved: z.boolean(),
      /** The pipeline published into, or created. Null when nothing was. */
      pipelineId: z.string().nullable(),
      /** True when publishing created the pipeline. */
      created: z.boolean(),
      /** True when publishing renamed the pipeline or changed its icon. */
      renamed: z.boolean(),
      /** Why nothing was written, or — saved — a held template update it should have resolved and did not. */
      problem: z.string().nullable(),
      /** Each module whose tests ran, and how that came out. */
      modules: z
        .array(
          z.object({
            id: z.string(),
            slug: z.string(),
            name: z.string(),
            outcome: z.enum(["passed", "refused", "coverage"]),
            /** Which case failed, or why the tests did not run. Null when they passed. */
            problem: z.string().nullable(),
            lineCoverage: z.number().nullable(),
          }),
        )
        .default([]),
      /** The modules under the coverage bar the person has not confirmed. Not empty means nothing was written, and the card asks. */
      coverage: z.array(z.object({ id: z.string(), name: z.string(), lineCoverage: z.number() })).default([]),
    }),
  ),
  /**
   * Publish on the publish card after a draft's trials (EO-588) — a
   * person pressed it.
   *
   * What `assist:approveAndPublish` is for a draft card, for the draft the
   * conversation has been testing: every module the published graph runs
   * has its tests run through the same runner and is held to the same
   * rule, then in one transaction every one of them is approved, each
   * draft copy takes the place of the live module it was copied from on
   * the published graph, and the graph is published as a new version of
   * the pipeline it changes — or as a new pipeline. Items already on that
   * pipeline finish on the version they entered on. Any module whose
   * tests fail or do not run, or a graph the save refuses, and nothing is
   * approved and nothing is published. Then, once it has published, the
   * trial and its test items are discarded through the item-delete path.
   *
   * Refused, with nothing written, while a change to the design waits for
   * the person, while a guardrail stop waits for their answer, or while a
   * test item of the newest round has not ended where it was expected to
   * and the person has not chosen "Publish anyway".
   */
  "assist:publishTrial": channel(
    z.object({ conversationId: z.string(), messageId: z.string(), acknowledgeLowCoverage: z.array(z.string()).default([]) }),
    z.object({
      saved: z.boolean(),
      pipelineId: z.string().nullable(),
      created: z.boolean(),
      /** Why nothing was written, or — saved — what could not be done after, such as discarding the trial. */
      problem: z.string().nullable(),
      modules: z
        .array(
          z.object({
            id: z.string(),
            slug: z.string(),
            name: z.string(),
            outcome: z.enum(["passed", "refused", "coverage"]),
            problem: z.string().nullable(),
            lineCoverage: z.number().nullable(),
          }),
        )
        .default([]),
      coverage: z.array(z.object({ id: z.string(), name: z.string(), lineCoverage: z.number() })).default([]),
    }),
  ),
  /**
   * Applies a change to an existing module that a card in the help chat
   * proposed (EO-418) — a person pressed Apply.
   *
   * `scenario:apply`'s answer shape, because it is the same act through
   * the same save: the card's code and manifest onto that module, and
   * here the test cases it listed too, in one write. A module save by
   * another name, so it withdraws the module's approval as an edit in
   * Settings does and is refused while the organisation manages the
   * pipelines section. `problem` with `applied: false` for a card that
   * has been superseded or already applied, a module that has been
   * deleted, or one whose code or manifest changed since the card was
   * drawn.
   */
  "assist:applyChange": channel(
    z.object({ conversationId: z.string(), messageId: z.string() }),
    z.object({
      applied: z.boolean(),
      problem: z.string().nullable(),
      conversation: DiscussionSchema,
    }),
  ),
  /**
   * What a card offering something only a person may do shows (EO-521):
   * the pipeline it names, how many items that holds, what an attached
   * pipeline file would need here — read now, from the database and the
   * file, not from anything the agent said.
   *
   * A read: nothing is written, and a card that has been pressed or
   * superseded is still answered, so it keeps saying what it was about.
   * `problem` with no `card` for a message that is not such a card, or
   * one whose pipeline or file can no longer be read.
   */
  "assist:card": channel(
    z.object({ conversationId: z.string(), messageId: z.string() }),
    z.object({ card: AssistCardDetailSchema.nullable(), problem: z.string().nullable() }),
  ),
  /**
   * Carries out what a card offers — a person pressed its button
   * (EO-521).
   *
   * Through the very channel the pipeline editor used, dispatched the way
   * the renderer would, so every lock, refusal and announcement that
   * channel carries applies here unchanged: `pipelines:export` with a
   * save dialog, `pipelines:import` with the person's `choices`,
   * `pipelines:delete`, `pipelines:discardEdits`, and since EO-522
   * `pipelines:setWebhookUnattended`, `moduleSecrets:set`/`clear` and
   * `environmentVariables:set`/`clear` with the `value` the person typed,
   * and since EO-523 `itemTypes:create`, `update` and `delete`.
   * Held to the "newest card wins" rule, and what came of it — done or
   * refused — is filed under the card, which is what makes it spent. A
   * save dialog the person closed is neither, nor is a Set pressed with
   * nothing typed, and either leaves the card to press again.
   *
   * `said` is the sentence filed under the card, and null when nothing
   * was. No agent can reach this channel: it is the person's.
   */
  "assist:applyCard": channel(
    z.object({
      conversationId: z.string(),
      messageId: z.string(),
      /** An import card's choice for each colliding module slug: keep mine (`reuse`), or bring theirs in beside it (`import`). */
      choices: z.record(z.string(), z.enum(["reuse", "import"])).default({}),
      /**
       * What the person typed on a card that sets a step's own secret or
       * variable (EO-522), and absent on every other press. Carried
       * straight to `moduleSecrets:set` or `environmentVariables:set` and
       * nowhere else: it is not filed under the card, not posted to the
       * chat, and never in anything an agent is given.
       */
      value: z.string().optional(),
    }),
    z.object({
      applied: z.boolean(),
      problem: z.string().nullable(),
      said: z.string().nullable(),
      conversation: DiscussionSchema,
    }),
  ),

  // ── A module's scenario chat (EO-356) ──────────────────────────
  //
  // "+ Add scenario" on a module's page: a conversation with the system
  // agent about that module, which writes a test case from what the
  // person describes, runs it and reports. The fourth room, built the
  // way the other three are — an item on an off-board step, turns driven
  // by an @-mention — and keyed on the module: one live thread per
  // module, resumed on reopening.
  /** The module's live scenario thread, started if it has none. */
  "scenario:open": channel(z.object({ moduleId: z.string() }), z.object({ conversation: DiscussionSchema })),
  /** Archives the module's thread and leaves an empty one — the assistant's Clear, for one module. */
  "scenario:clear": channel(z.object({ moduleId: z.string() }), z.object({ conversation: DiscussionSchema })),
  /** Says something in the module's thread. `conversationId` null resumes the live one, or starts it. */
  "scenario:send": channel(
    z.object({
      moduleId: z.string(),
      conversationId: z.string().nullable(),
      body: z.string().default(""),
      attachmentIds: z.array(z.string()).max(8).optional(),
      interrupt: z.boolean().default(false),
    }),
    z.object({ conversation: DiscussionSchema }),
  ),
  /** Answers a batch of questions on a card — the same shape and rule as every other room's. */
  "scenario:answer": channel(
    z.object({
      conversationId: z.string(),
      answers: z
        .array(z.object({ questionId: z.string(), answer: z.string().nullable() }))
        .min(1)
        .max(6),
    }),
    z.object({
      answered: z.number(),
      problem: z.string().nullable(),
      conversation: DiscussionSchema,
    }),
  ),
  /**
   * Applies a change to the module that a card proposed.
   *
   * The only way a scenario chat changes a module's code or manifest,
   * and a person is the one pressing it. Applying is a module save like any other, so
   * it withdraws the module's approval exactly as an edit in Settings
   * does. `problem` with `applied: false` for a card that has been
   * superseded or already applied, or a module that changed since.
   */
  "scenario:apply": channel(
    z.object({ conversationId: z.string(), messageId: z.string() }),
    z.object({
      applied: z.boolean(),
      problem: z.string().nullable(),
      conversation: DiscussionSchema,
    }),
  ),

  // ── Configuration (U-06) ────────────────────────────────────────
  /**
   * What roles, built-in functions and item types this installation
   * knows about (KAN-124).
   *
   * The renderer's one way to learn them, in place of importing the
   * constants. Two of its screens ask: the Agents editor marks a role
   * built-in and draws or omits the thread-reuse checkbox from the role
   * entry, and the pipeline editor fills a builtin step's result rows
   * from the builtins. Both answers used to come from a constant the
   * renderer and the main process each imported, which agreed only
   * because they were one build — a pack folded in at startup would
   * have changed the main process's answer and not the screen's.
   *
   * Schemas stay behind: the renderer validates no results. See
   * `RegistryViewSchema`.
   */
  "registry:get": channel(z.void(), RegistryViewSchema),
  /**
   * Creates a role's definition of an action, or replaces the one it has
   * (EO-425).
   *
   * Addressed by role and action, as the definition is. Everything the
   * shared save refuses comes back as `problems` with nothing written —
   * a refusal rather than an error, since the request was well formed
   * and the answer is "no".
   */
  "roleActions:save": channel(
    ActionDefinitionDraftSchema,
    z.object({ saved: z.boolean(), definition: ActionDefinitionSchema.nullable(), problems: z.array(z.string()) }),
  ),
  /**
   * Removes a role's definition of an action (EO-425).
   *
   * Refused while a pipeline step dispatches it, and `usedBy` names each
   * one: a step left on an action nothing defines answers in prose and
   * is read as `done`, which is the failure definitions exist to end.
   */
  "roleActions:delete": channel(
    z.object({ role: z.string(), action: z.string() }),
    z.object({ deleted: z.boolean(), problem: z.string().nullable(), usedBy: z.array(ActionUseSchema).default([]) }),
  ),
  /**
   * What a role's action is as things stand, for the agent screen
   * (EO-427): the schema a provider is handed when this role is
   * dispatched on it, and every step that dispatches it with the result
   * keys that step routes.
   *
   * Asked of a pair rather than read off `registry:get` for two reasons.
   * The schema of a pack's action never leaves the main process as part
   * of the registry — the renderer validates no results — so the one
   * screen that shows it asks for the one it is showing. And the pair
   * need not be defined yet: a step may already name a role and an
   * action nobody has defined, and whoever is about to define it has to
   * be told which steps that changes before the save rather than at the
   * next publish.
   *
   * `providerSchema` is null where nothing defines the action for this
   * role — its answer is prose, and no schema is handed over. A read:
   * nothing is announced and no section lock refuses it.
   */
  "roleActions:inspect": channel(
    z.object({ role: z.string(), action: z.string() }),
    z.object({ providerSchema: z.record(z.string(), z.unknown()).nullable(), uses: z.array(ActionRouteUseSchema) }),
  ),
  "agents:listDetailed": channel(z.void(), z.object({ agents: z.array(AgentDetailSchema) })),
  "agents:save": channel(
    z.object({
      id: z.string().optional(), // absent = create
      name: z.string().min(1),
      role: z.string().regex(/^[a-z0-9_]+$/, "Use lowercase letters, digits and underscores."),
      provider: z.string().min(1),
      model: z.string().nullable().default(null),
      instructions: z.string(),
      enabled: z.boolean().default(true),
      /**
       * The whole bag, or nothing — and **absent means "leave what is
       * stored"** rather than "empty it" (EO-185).
       *
       * It used to be `.default({})`, which made omitting this field
       * indistinguishable from clearing it. That is not a hypothetical:
       * a caller that saved a system agent with only its reasoning
       * effort in hand wrote `{"effort":"xhigh","reasoningEffort":"xhigh"}`
       * over an `allowedTools` five migrations had built up, and took
       * the agent's whole tool surface with it — `thread_read`, the five
       * configuration reads, and the grant that reaches `eo_admin`. A
       * default that quietly deletes is the kind of thing nobody notices
       * until a feature that was shipped turns out never to have run.
       *
       * Sent, it is still a replace and not a merge, because this
       * channel is the Agents screen's form: the editor has the whole
       * config in front of it and *unticking* a box is expressed by the
       * key being gone. Merging here would make removing a key
       * impossible from the one surface that exists to remove it. A
       * caller holding only part of a config wants `agent_save` over
       * MCP, which lays a patch over what is there — including inside
       * this object.
       */
      config: z.record(z.string(), z.unknown()).optional(),
      /**
       * The project this agent works for, or null for a global agent
       * (EO-474, ARCHITECTURE.md, "An agent is a row").
       *
       * Absent means "leave what is stored", for `config`'s reason — a
       * caller holding only a name and a prompt must not be able to make
       * a project's own agent global by not mentioning the project — and
       * on a create it means global, which is what every agent is unless
       * somebody scoped it. Refused with a sentence on a `system` agent,
       * which is always global, and for a project that does not exist.
       */
      projectId: z.string().nullable().optional(),
    }),
    /**
     * `{ saved, agent, problem }` rather than the bare `AgentDetail`
     * this used to answer (EO-328).
     *
     * A save can now be *refused*, and a refusal a caller cannot see is
     * the thing that shape could not express. What refuses it is the
     * organisation's allowed-backends list (ARCHITECTURE.md, "Policy"): a device may not bind
     * an agent to a backend outside it, and enforcing that only in the
     * picker would leave it to the renderer — which the design is explicit about, because the admin
     * MCP server reaches
     * this same handler from a chat. `agent_save` receives the same
     * sentence the editor does.
     *
     * Shaped like `guards:write` and `pipeline:save`, which had the
     * problem first: whether it saved, what is there now, and the
     * sentence saying why not. `agent` is null on a refusal — there is
     * nothing to draw, and on a refused *create* there is no row to
     * name.
     */
    z.object({
      saved: z.boolean().default(true),
      agent: AgentDetailSchema.nullable().default(null),
      /** Empty when it saved. One sentence, naming what to change. */
      problem: z.string().nullable().default(null),
    }),
  ),
  /**
   * A project's own copy of a global agent — "Customise for this
   * project" on the Agents screen (EO-475, ARCHITECTURE.md, "An agent is
   * a row").
   *
   * One command rather than an `agents:save` and a tick per attachment
   * from the renderer, so the copy and its MCP servers and skills are
   * written in one transaction: a copy that arrived without some of its
   * tools would be a project's own agent quietly narrower than the one
   * it replaced there, and it would take precedence the moment it
   * existed. Everything is copied — role, backend, model, `config`
   * (reasoning effort among it), instructions, enabled, attachments —
   * except the name, which says whose copy it is, and the project.
   *
   * Answered like `agents:save`, because it is one, through the same
   * refusals: a backend the organisation does not allow, and a project
   * on a `system` agent. Refused too for an agent that is not global — a
   * project's own agent is customised by editing it.
   */
  "agents:customise": channel(
    z.object({ agentId: z.string(), projectId: z.string() }),
    z.object({
      saved: z.boolean(),
      agent: AgentDetailSchema.nullable().default(null),
      problem: z.string().nullable().default(null),
    }),
  ),
  /**
   * Who will be dispatched on a project's work, role by role (EO-475) —
   * what a project's settings say under "Agents".
   *
   * One entry per role an agent step of the project's pipelines names,
   * answered by `staffingAgents` — the scheduler's own rule — asked of
   * a real item on the project. So it cannot say "the project's own
   * implementer" while the scheduler sends the global one: `from` is
   * `project` when the project's own agents are the candidates,
   * `global` when the global ones are, and `nobody` when no dispatchable
   * agent holds the role for this project at all.
   */
  "projects:staffing": channel(
    z.object({ projectId: z.string() }),
    z.object({
      roles: z.array(
        z.object({
          role: z.string(),
          from: z.enum(["project", "global", "nobody"]),
          agents: z.array(z.object({ id: z.string(), name: z.string() })),
        }),
      ),
    }),
  ),
  /**
   * Retires an agent (EO-186).
   *
   * `{ archived, problem }` rather than a throw, and one-way, which is
   * the contract `mcpServers:archive` and `skills:archive` already have:
   * the row is kept so its runs, the comments it wrote and the mentions
   * that named it still resolve (invariant #3), no channel un-archives
   * it, and a refusal is a sentence a person reads on the screen they
   * asked from (F-04).
   *
   * Nothing is archived until `confirm` is true (EO-350). An unconfirmed
   * call answers with `impact` — the steps the role owns, whether they
   * are left with nobody, the run it would cancel — which is what used
   * to be an outright refusal for the last enabled holder of a role.
   */
  "agents:archive": channel(
    z.object({ id: z.string(), confirm: z.boolean().default(false) }),
    z.object({
      archived: z.boolean(),
      problem: z.string().nullable(),
      /** What archiving would take away — on an unconfirmed call, which archives nothing (EO-350). */
      impact: AgentRemovalImpactSchema.nullable().default(null),
    }),
  ),
  /**
   * Deletes an agent (EO-350).
   *
   * Answers with `impact` and deletes nothing until `confirm` is true —
   * the same confirmation `agents:archive` takes. What is deleted is
   * everything but the name and the role: the row stays as a tombstone
   * so the runs it did and the comments it wrote still read as its own
   * (invariant #3, and `runs.agent_id` references the row), and it is
   * left out of the Agents screen, of dispatch and of the validator.
   */
  "agents:delete": channel(
    z.object({ id: z.string(), confirm: z.boolean().default(false) }),
    z.object({
      deleted: z.boolean(),
      problem: z.string().nullable(),
      impact: AgentRemovalImpactSchema.nullable().default(null),
    }),
  ),
  /**
   * Which backend and model this machine runs an agent on (EO-329,
   * `ARCHITECTURE.md`, "Publish, lock and versions").
   *
   * Two fields, and the narrowness is the whole point. "A published
   * agent carries role, prompt and tool surface. Backend and model stay
   * local, so a locked agents section never stops a person who is
   * signed in to one backend and not the other." A lock is per section
   * and never per field, and this is not a hole in one: `provider` and
   * `model` are not *in* the agents section — they are a fact about
   * which CLI is installed and signed in on this machine, and an
   * organisation that published them would be publishing an answer only
   * the machine can give.
   *
   * Deliberately not `agents:save` with a patch. That channel takes the
   * prompt, the role and `config` — the tool surface among it — and a
   * caller able to send those under another name would be invariant
   * 11's failure with a friendlier signature. This one cannot express
   * them.
   *
   * Refused for an agent that does not exist rather than creating one:
   * creating an agent *is* the agents section.
   */
  "agents:setBinding": channel(
    z.object({
      agentId: z.string(),
      provider: z.string().min(1),
      /** Null is "whatever that backend's default is", which is what the picker's empty option means. */
      model: z.string().nullable().default(null),
    }),
    z.object({ bound: z.boolean(), problem: z.string().nullable().default(null) }),
  ),
  // Saved as a whole pipeline rather than per state: reordering is a
  // property of the set, and validating one row at a time cannot catch a
  // duplicate position or a missing terminal state.
  // KAN-59: pipelines are per project and there are many, so every one of
  // these carries the pipeline it is about. `workflow:save` / `:validate`
  // took no scope at all, because there was only ever one workflow.
  "pipelines:list": channel(
    // `includeArchived` is what the Archive's Pipelines tab asks for: a
    // deleted pipeline is archived rather than dropped, so it has to be
    // listable somewhere even though the sidebar must never show it.
    z.object({ projectId: z.string().nullable().optional(), includeArchived: z.boolean().optional() }),
    z.object({ pipelines: z.array(PipelineViewSchema) }),
  ),
  "pipelines:create": channel(
    z.object({ projectId: z.string().nullable(), name: z.string().min(1), icon: z.string().nullable().optional() }),
    z.object({ pipeline: PipelineViewSchema }),
  ),
  "pipelines:update": channel(
    z.object({ id: z.string(), name: z.string().min(1).optional(), icon: z.string().nullable().optional(), position: z.number().optional() }),
    z.object({ pipeline: PipelineViewSchema }),
  ),
  /**
   * Lets one pipeline send what a webhook delivers without a person
   * reading it first, or stops letting it (EO-405).
   *
   * Its own channel rather than a field on `pipeline:save`, for three
   * reasons that are really one — the setting is not part of the graph.
   * A graph is what an agent drafts and what a file carries, and this is
   * neither: `pipeline_save` reaches `pipeline:save`, an export is a
   * graph, and a diverged copy is editable through `pipeline:save`
   * (EO-331). On that channel the setting would have been one optional
   * key away from all three. Here it has no tool, no place in a
   * document, and no exception to the pipelines lock.
   *
   * Refused, with the reason, where no webhook job files onto the
   * pipeline: there would be nothing for a person to be accepting, and a
   * waiver given in advance is one given without reading what it waives.
   * Turning it off is never refused.
   */
  "pipelines:setWebhookUnattended": channel(
    z.object({ pipelineId: z.string(), unattended: z.boolean() }),
    z.object({
      /** What the setting is now, whether or not this call changed it. */
      unattended: z.boolean(),
      /** Why it was left as it was, where it was. Null when the call did what was asked. */
      refused: z.string().nullable().default(null),
    }),
  ),
  "pipelines:delete": channel(
    z.object({ id: z.string() }),
    z.object({ deleted: z.boolean(), archivedItemCount: z.number(), blockedByActiveRun: z.boolean() }),
  ),
  // Steps and routes together: the dashboard and the configuration screen
  // both always want both, and two round-trips would let them disagree.
  // The steps, the routes and where work enters, together: all three are
  // one document to the configuration screen, and fetching them apart
  // would let them disagree for a render.
  "pipelineSteps:list": channel(
    z.object({ pipelineId: z.string() }),
    z.object({
      steps: z.array(PipelineStepViewSchema),
      routes: z.array(StepRouteViewSchema),
      entryStepId: z.string().nullable(),
      /** What an item must have to enter (EO-610), as `pipeline:save` takes them. */
      entryRules: EntryRulesSchema.default([]),
      /** The same rules in the words a refusal would use, or null for a pipeline with none. */
      entrySentence: z.string().nullable().default(null),
      /**
       * Where a route may hand work to (EO-58, EO-69).
       *
       * On the same channel as the graph rather than fetched per pipeline:
       * the target picker and the dashboard's map both need it in the same
       * render as the routes it explains, and two round-trips would let
       * them disagree — a route drawn as broken for a frame because the
       * pipeline it leaves for had not arrived yet.
       */
      elsewhere: z.array(HandOffTargetsSchema),
      /**
       * What each step would take with it, so removing one can be refused
       * where it is asked for rather than at Publish (EO-167).
       *
       * On the same channel as the graph for the reason `elsewhere` is:
       * the editor has to answer "can this step go?" in the same render
       * as the step it is asked about, and a second round-trip would let
       * the two disagree — a Remove button live for a frame on a step
       * that already holds work.
       *
       * Items are counted the way `validationInput` counts them,
       * archived ones and all: the two have to agree, or the screen
       * offers a removal that Publish then refuses. Steps with nothing on
       * them are omitted rather than listed as zero.
       */
      holds: z.array(StepHoldSchema),
      /**
       * Which kind of workspace these steps run on, as EO resolves it
       * today (EO-296, ARCHITECTURE.md, "The four kinds").
       *
       * On the same channel as the graph for `elsewhere`'s reason: the
       * step editor has to decide, in the same render as the step it is
       * drawing, whether "Works on a branch / Reads only" is a choice
       * anybody has here — it is not on a helpdesk, and not on no disk
       * at all — and a second round-trip would let the two disagree.
       *
       * One answer for the whole pipeline, because that is as
       * fine-grained as it gets today: a step cannot name a workspace of
       * its own until EO-301's picker, so every step of a pipeline
       * resolves to the kind its project's first workspace names.
       * Derived, never saved, and `pipeline:save` has no field for it.
       *
       * Defaulted, so a client that predates it still reads a graph.
       */
      workspaceKind: z.string().default(NONE_KIND),
      /**
       * The workspaces this pipeline's steps may pick among (EO-301,
       * ARCHITECTURE.md, "A workspace is a kind, attached to the project").
       *
       * The project's, and only the project's: a step that named
       * another project's disk is exactly what `pipeline:save` refuses,
       * so offering one here would be the editor proposing something
       * the save rejects — the disagreement EO-72 spent a field
       * stopping, one row over.
       *
       * On this channel rather than a second one for `workspaceKind`'s
       * reason: the editor decides in a single render which workspace a
       * step names and, from its kind, whether "Works on a branch /
       * Reads only" is a choice anybody has here. Two round-trips would
       * let the two disagree for a frame.
       *
       * Defaulted, so a client that predates the picker reads a graph.
       */
      workspaces: z.array(WorkspaceViewSchema).default([]),
      /**
       * What each step's head says is checked, and who a human step
       * waits on (EO-312, ARCHITECTURE.md, "What 'EO checks' means on a step", "The board").
       *
       * One row per step, on this channel rather than a second one for
       * `workspaceKind`'s reason: which kind a step runs on is resolved
       * here, per step, and a board that fetched the sentences
       * separately could draw a head for a step whose workspace the
       * other answer had already changed.
       *
       * Both screens read it. The board draws the line; the editor asks
       * whether `verification_failed` is a result this step could ever
       * report, which is the same question asked of the same answer —
       * and asking it twice, of two channels, is how a route gets
       * offered for a branch that can never be taken.
       *
       * Defaulted, so a client that predates it still reads a graph. An
       * empty list is read as "not told" rather than as "nothing is
       * checked": the board says nothing at all on one.
       */
      verification: z.array(StepVerificationSchema).default([]),
      /**
       * Whether a webhook job files onto this pipeline, and whether
       * somebody has let what it delivers be sent on unread (EO-405).
       *
       * On this channel for `workspaceKind`'s reason, and because both
       * of its readers are already here: the editor draws the control
       * only where `entry` is true, and the board's header states
       * `unattended` beside the name. A second channel would let a board
       * say one thing about a pipeline whose editor said the other.
       *
       * `entry` is derived from the jobs and never saved. `unattended`
       * is the stored setting, written by `pipelines:setWebhookUnattended`
       * and by nothing else — `pipeline:save` has no field for it.
       *
       * Defaulted, so a client that predates it still reads a graph, and
       * reads it as the refusal standing.
       */
      webhook: z.object({ entry: z.boolean(), unattended: z.boolean() }).default({ entry: false, unattended: false }),
      /**
       * Per step, whether it sends or creates outside EO (EO-584,
       * `outsideReachByStep`): the webhook refusal's own classification of
       * a builtin, a module and a connector-backed agent step. What the
       * assistant reads to propose how a step runs on a trial — real,
       * redirected or mocked. A step that does neither is absent.
       *
       * Defaulted, so a client that predates it still reads a graph.
       */
      outsideReach: OutsideReachByStepSchema.default({}),
      /**
       * Which version this pipeline is on, and what is still finishing
       * on older ones (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
       *
       * On the graph's own channel for `workspaceKind`'s reason: the
       * board draws the banner above the very columns this answer
       * describes, and a second round-trip would let it say "3 items
       * finish on v6" over a board that has already drawn them
       * elsewhere.
       *
       * Null on a pipeline nobody has ever asked what version it is on —
       * which is one with no work on it and no save behind it, and
       * therefore nothing to say.
       */
      version: PipelineVersionSchema.nullable().default(null),
      /**
       * The older versions still holding live work, newest first, with
       * how much. Empty is the ordinary case, and what makes the banner
       * absent rather than reassuring.
       */
      finishingOn: z.array(z.object({ number: z.number().int().positive(), items: z.number().int().positive() })).default([]),
      /**
       * Steps that exist only in an older version and still hold work —
       * the ghost columns (ARCHITECTURE.md, "Publish, lock and versions").
       *
       * Drawn to the right of the board, "Review (v6) · 2 finishing",
       * until the last item leaves. Off this list the moment it empties,
       * which is what makes the column disappear without anybody
       * dismissing it.
       */
      ghosts: z
        .array(z.object({ stepId: z.string(), name: z.string(), version: z.number().int().positive(), holding: z.number().int().positive() }))
        .default([]),
    }),
  ),
  "pipeline:save": channel(
    PipelineSaveInputSchema,
    z.object({
      saved: z.boolean(),
      problems: z.array(WorkflowProblemSchema),
      /** The version this save filed, when it saved (EO-327). Null on a refusal, which files none. */
      version: z.number().int().positive().nullable().default(null),
      /**
       * The steps this save stopped keeping checking (EO-506): each kept
       * checking before it and runs once after it.
       *
       * Said rather than left to be noticed, because a step that used to
       * wait on something outside EO and now runs once parks every item
       * that reaches it — and the save that did it publishes cleanly.
       * Empty on a refusal, which changed nothing.
       */
      watchTurnedOff: z.array(z.object({ stepId: z.string(), name: z.string() })).default([]),
    }),
  ),
  /**
   * Moves what a step holds somewhere else, so it can then be removed
   * (EO-327, the original design).
   *
   * "The admin is offered 'move them to X' through the ordinary
   * transition path with an engine comment." The offer is the other half
   * of the strand refusal: a person told "Review has 2 items on it" has
   * a task, and this is the door to it — through `transitionItem` like
   * every other move, with a comment on each thread saying why it
   * happened, because a card that changed column overnight with nothing
   * in its thread is the silence invariant #8 exists to prevent.
   *
   * Archived items are not moved and are reported instead: they are not
   * on the board, and restoring one is a decision of its own.
   */
  "pipeline:moveStepItems": channel(
    z.object({
      fromStepId: z.string(),
      toStepId: z.string(),
    }),
    z.object({
      moved: z.number().int().nonnegative(),
      /** Left behind because they are in the Archive — restored first, then moved. */
      archived: z.number().int().nonnegative(),
      /** Left behind because an agent is working on them: a move would discard a live run. */
      running: z.number().int().nonnegative(),
      /**
       * Left behind because the step they are being moved to is not part
       * of the version they entered on (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
       *
       * Counted rather than forced, like the two above. An item
       * finishing on v6 cannot stand on a step v7 added: its own graph
       * has no definition to run there and no route leaving it. The
       * board draws every step v6 still holds, including the ghosts, and
       * those are where it can go.
       */
      otherVersion: z.number().int().nonnegative().default(0),
      problem: z.string().nullable().default(null),
    }),
  ),
  /**
   * What changed between two versions of a pipeline (EO-327, the original design).
   *
   * "'View changes' opens the configure screen as a read-only diff of
   * steps, routes and prompts" — and the design shows the same view for a
   * suggestion, which is why the diff is computed here rather than by
   * the screen.
   *
   * `from` and `to` are version *numbers*, which is what a person is
   * looking at ("v6", "v7"); the ids are EO's business.
   */
  "pipeline:versions": channel(
    z.object({
      pipelineId: z.string(),
      from: z.number().int().positive().optional(),
      to: z.number().int().positive().optional(),
      /**
       * One version whose graph to send back whole, as `graph` (EO-359).
       *
       * What *Restore* asks for: the steps, routes and entry step that
       * version froze, in the shape the editor drafts and
       * `pipeline:save` publishes. Asking writes nothing — a restore is
       * a draft until somebody presses Publish, and Publish is an
       * ordinary save that files a new version.
       */
      graph: z.number().int().positive().optional(),
    }),
    z.object({
      versions: z.array(PipelineVersionSchema),
      /**
       * The number of the version the pipeline is on, which History marks
       * (EO-359). Not simply the newest: the organisation's rollback
       * points a pipeline back at an older one. Null for a pipeline that
       * has never had a version.
       */
      current: z.number().int().positive().nullable().default(null),
      /**
       * The graph `graph` asked for, or null when nothing was asked or the
       * version is not one this pipeline has (or its document cannot be
       * read). Off-board steps are left out, as `pipelineSteps:list`
       * leaves them out: a save keeps them whatever the draft says.
       */
      graph: z
        .object({
          number: z.number().int().positive(),
          steps: z.array(PipelineStepViewSchema),
          routes: z.array(StepRouteViewSchema),
          entryStepId: z.string().nullable(),
          entryRules: EntryRulesSchema.default([]),
        })
        .nullable()
        .default(null),
      /** Null when the pipeline has fewer than two versions, and so nothing to compare. */
      diff: VersionDiffSchema.nullable(),
      /**
       * The edits this machine has made and filed no version for
       * (EO-331, ARCHITECTURE.md, "Divergence and suggestions").
       *
       * *Compare* on a diverged pipeline is one of the design's three
       * actions, and the history above cannot answer it: a diverged
       * copy deliberately files no version, so in the ordinary case —
       * diverge, edit, nothing newer published — `versions` holds one
       * row, `diff` is null, and a person who has just rewritten half
       * their graph would be told there is nothing to compare.
       *
       * So the live graph is diffed against the version the copy was
       * based on, and that is what this carries. Null on every pipeline
       * nobody here has diverged, which is all of them on a solo
       * desktop and on a server.
       */
      local: z
        .object({
          /** The published version these edits were made against. */
          basedOn: z.number().int().positive(),
          diff: VersionDiffSchema,
        })
        .nullable()
        .default(null),
    }),
  ),
  /**
   * A pipeline's held template update, read whole (EO-534, ARCHITECTURE.md,
   * "Template versions and origins") — what the assistant reads through
   * `pipeline_update_conflict` before it proposes a resolution.
   *
   * The versions, the release notes, the three graphs, every key somebody
   * changed with its three values and which side changed it (conflicts
   * first), and the person's edits since the base. Compared now, against
   * the pipeline as it stands, so a pipeline edited since the update was
   * held is described as it is.
   *
   * Writes nothing. `problem` with no `conflict` for a pipeline that has
   * no open update conflict on this installation.
   */
  "pipeline:updateConflict": channel(
    z.object({ pipelineId: z.string().min(1) }),
    UpdateConflictAnswerSchema,
  ),
  /**
   * Where a pipeline came from and whether its template has news for it
   * (EO-536, ARCHITECTURE.md, "Template versions and origins") — what the
   * head of its board and Graph view says: the template and version of
   * its base, an update EO applied in the last few days with its release
   * notes, and a held update with its conflict count and where pressing
   * it goes.
   *
   * Asked of the record that holds the pipeline's updates, as
   * `pipeline:updateConflict` is: this database for a pipeline of its
   * own, the organisation's for one it holds — whose origin on a
   * replica is the one it had before it moved, and out of date the
   * moment the record applies an update. A record that cannot be asked
   * answers nothing, with `problem` saying why. Writes nothing.
   */
  "pipeline:templateStatus": channel(z.object({ pipelineId: z.string().min(1) }), PipelineTemplateStatusSchema),
  /**
   * Keeps the pipeline as it is and skips its held template update
   * (EO-534): the conflict is resolved, the notice closes, and the
   * pipeline's base moves to the held template version, so the same
   * conflict is never raised again. The graph is not touched.
   *
   * What the assistant's "Keep my pipeline" card presses. A person's
   * decision, never an agent's. `problem` with `kept: false` for a
   * pipeline with no open update conflict here.
   */
  "pipeline:keepOwnVersion": channel(
    z.object({ pipelineId: z.string().min(1) }),
    z.object({ kept: z.boolean(), toVersion: z.string().nullable(), problem: z.string().nullable() }),
  ),
  "pipeline:validate": channel(
    z.object({
      pipelineId: z.string(),
      // Read as `pipeline:save` reads it, so this says what that would (EO-506).
      steps: z.array(PipelineStepSaveSchema),
      routes: z.array(StepRouteViewSchema),
      entryStepId: z.string().nullable(),
      /** The rules it would be published with (EO-610), held to what `pipeline:save` holds them to. */
      entryRules: EntryRulesSchema.optional(),
      /** The definitions it would be published with (EO-426), so this says what `pipeline:save` would. */
      actions: z.array(ActionDefinitionDraftSchema).optional(),
    }),
    z.object({
      problems: z.array(WorkflowProblemSchema),
      /**
       * Per step of the graph sent, whether it sends or creates outside
       * EO (EO-584), as `pipelineSteps:list` says it of a published one:
       * what the assistant reads about a draft to propose each step's
       * mode on a trial.
       */
      outsideReach: OutsideReachByStepSchema.default({}),
    }),
  ),

  // ── A published pipeline somebody edited here (EO-331, ARCHITECTURE.md, "Divergence and
  // suggestions") ──────
  //
  // Three channels for one state. A pipeline the organisation publishes
  // and a person edits anyway is **diverged**: their copy is theirs
  // from that moment, EO's publishes stop applying to it silently, and
  // the only way their edit reaches anybody else is as a suggestion.

  /**
   * Whether this pipeline is diverged, and the line that says so.
   *
   * "Edited locally · based on v6 · v7 available." Composed here rather
   * than by the screen for `sections:list`'s reason — the configure
   * screen and the board's chip read the same answer, and two readings
   * of "is there something newer" is one of them being wrong.
   *
   * A read, so it locks nothing: a person whose organisation manages
   * their pipelines may always ask what state their own machine is in.
   */
  "pipelines:divergence": channel(
    z.object({ pipelineId: z.string() }),
    z.object({
      diverged: z.boolean(),
      /** The published version the local copy was made from. */
      basedOn: z.number().int().positive().nullable().default(null),
      /** What the organisation has published since, where it is newer than `basedOn`. */
      available: z.number().int().positive().nullable().default(null),
      /** `divergedLine`, or null where nothing has diverged. */
      line: z.string().nullable().default(null),
    }),
  ),
  /**
   * Pushes this machine's copy of a pipeline to the organisation as a
   * suggestion (ARCHITECTURE.md, "Divergence and suggestions").
   *
   * What *Suggest a change* on the lock does, what *Suggest my change*
   * on a diverged pipeline does, and what the assistant does when a
   * person says yes to its offer — one channel, so the three cannot
   * produce three different items.
   *
   * It diverges the pipeline first where it is not diverged already,
   * because the original design's sentence is "opens an editable copy that pushes as a
   * suggestion": suggesting from a locked pipeline with no local edits
   * is how a person starts, and the copy has to exist before it can be
   * edited.
   *
   * In the record half rather than the machine half although only a
   * desktop ever sends it: what it does is make an item on the record,
   * and a server asked it answers honestly that it has nothing diverged
   * rather than refusing on the grounds of where it is running.
   */
  "pipelines:suggest": channel(
    z.object({ pipelineId: z.string() }),
    z.object({
      suggested: z.boolean(),
      /** The item on the organisation's "pipeline changes" pipeline. */
      itemId: z.string().nullable().default(null),
      /** Its key, which is what a person quotes: "EO-412". */
      itemKey: z.string().nullable().default(null),
      problem: z.string().nullable().default(null),
    }),
  ),
  /**
   * Throws this machine's edits away and takes the published version
   * back (the design's third action).
   *
   * The graph is restored from the published version's own document,
   * exactly as a rollback restores one (`sections:publish` with a
   * version number), and the pipeline stops being diverged — so the
   * next publish applies to it again, which is the whole point of
   * discarding.
   */
  "pipelines:discardEdits": channel(
    z.object({ pipelineId: z.string() }),
    z.object({
      discarded: z.boolean(),
      /** The version now restored, for "back on v7". */
      version: z.number().int().positive().nullable().default(null),
      problem: z.string().nullable().default(null),
    }),
  ),
  // ── Custom modules ──────────────────────────────────────────────
  //
  // Deterministic work a step runs that EO did not ship (KAN-103). Not
  // scoped to a pipeline, unlike everything above: a module is written
  // once and used from any number of them, which is the point of there
  // being a catalog rather than a field on a step.
  "modules:list": channel(
    // Archived ones are kept so a historical run's transcript still
    // refers to something, and are asked for deliberately — the same
    // arrangement `pipelines:list` uses.
    z.object({ includeArchived: z.boolean().optional() }),
    z.object({ modules: z.array(ModuleViewSchema) }),
  ),
  "modules:save": channel(
    ModuleSaveInputSchema,
    // `problem` rather than a throw: a duplicate slug is a thing a person
    // typed, not a programmer error, and the editor has to show it beside
    // the field (F-04).
    //
    // `approvalWithdrawn`: whether this save took away an approval the
    // module had — by changing its code or manifest, or by adding a test
    // case it did not have (EO-498).
    z.object({ saved: z.boolean(), module: ModuleViewSchema.nullable(), problem: z.string().nullable(), approvalWithdrawn: z.boolean() }),
  ),
  /**
   * Records that a person read this module and accepted it (KAN-106).
   *
   * Its own channel rather than a flag on `modules:save`, so approving
   * cannot change the code in the same breath — the caller sends an id
   * and nothing else.
   *
   * Approving runs the module's tests at that moment (EO-353), never a
   * stored result: there has to be at least one case and every case has
   * to pass. Line coverage under `MODULE_COVERAGE_BAR` is not a refusal
   * the person cannot get past — it is answered with the figure and
   * `coverageAcknowledgementNeeded`, and the same call again with
   * `acknowledgeLowCoverage` approves. The tests run again on that
   * second call too, because "at that moment" is the whole rule.
   */
  "modules:approve": channel(
    z.object({
      id: z.string(),
      /** The person has seen the line coverage figure under the bar and approves anyway. */
      acknowledgeLowCoverage: z.boolean().default(false),
    }),
    z.object({
      approved: z.boolean(),
      problem: z.string().nullable(),
      /** Line coverage of the run this answer rests on, as a percentage. Null when no tests ran. */
      lineCoverage: z.number().nullable(),
      /**
       * True when every case passed and the only thing between this
       * module and approval is line coverage under the bar. The caller
       * shows `lineCoverage` and asks again with `acknowledgeLowCoverage`.
       */
      coverageAcknowledgementNeeded: z.boolean(),
      /**
       * What in the approved module's code, manifest and test cases looks
       * like it only holds on one machine (EO-449). Advice beside the
       * answer, never a reason for it: empty on every refusal, and a
       * module with warnings approves exactly as one without.
       */
      machineSpecific: z.array(MachineSpecificWarningSchema).default([]),
    }),
  ),
  "modules:archive": channel(z.object({ id: z.string() }), z.object({ archived: z.boolean(), usedByStepCount: z.number() })),

  // ── A module's versions (EO-360) ────────────────────────────────
  //
  // Every save that changes a module's code or manifest files a version
  // holding its name, description, code, manifest and test cases, and
  // whether a person approved it. History is never edited: restoring an
  // older version files a new one above every number the module has had.
  /** Every kept version of one module, newest first. */
  "moduleVersions:list": channel(
    z.object({ moduleId: z.string() }),
    z.object({ versions: z.array(ModuleVersionSummarySchema), problem: z.string().nullable() }),
  ),
  /** One version whole — its code, manifest and test cases. Null when it is not one this module has kept. */
  "moduleVersions:get": channel(
    z.object({ moduleId: z.string(), number: z.number().int().positive() }),
    z.object({ version: ModuleVersionSchema.nullable(), problem: z.string().nullable() }),
  ),
  /**
   * Puts an older version's code, manifest and test cases back on the
   * module, as a new version numbered above every one before it. The
   * restored version itself is left as it was.
   *
   * Approved again only if that exact code, manifest and set of test
   * cases are a kept version somebody approved (EO-498); otherwise it needs approving like any
   * edit. The tests re-run in the background either way.
   */
  "moduleVersions:restore": channel(
    z.object({ moduleId: z.string(), number: z.number().int().positive() }),
    z.object({
      restored: z.boolean(),
      module: ModuleViewSchema.nullable(),
      /** The number of the version the restore filed. */
      version: z.number().int().positive().nullable(),
      problem: z.string().nullable(),
    }),
  ),

  // ── A module's test cases (EO-352) ──────────────────────────────
  //
  // Each case is its own record, and running them runs every case of
  // the module against a scripted `ctx` in the module host's test mode:
  // nothing is spawned, nothing is posted, there are no secrets and no
  // network, and the module's time is faked. The latest run is kept
  // against the code and cases it was taken from, and `modules:list`
  // says whether that is still what is saved.
  "moduleTests:list": channel(
    z.object({ moduleId: z.string() }),
    z.object({ tests: z.array(ModuleTestCaseSchema), problem: z.string().nullable() }),
  ),
  /**
   * Writes one case. Saving marks the module's stored result stale and
   * re-runs its tests in the background — the answer does not wait for
   * that run; `moduleTests:run` is the one that does.
   *
   * A case added to an approved module, or edited to read differently,
   * withdraws its approval in the same write (EO-498), and
   * `approvalWithdrawn` says so, so every caller can tell the person.
   * Saving a case exactly as it already is withdraws nothing.
   */
  "moduleTests:save": channel(
    ModuleTestSaveInputSchema,
    z.object({ saved: z.boolean(), test: ModuleTestCaseSchema.nullable(), problem: z.string().nullable(), approvalWithdrawn: z.boolean() }),
  ),
  /** Removes one case. On an approved module that withdraws its approval (EO-498), and `approvalWithdrawn` says so. */
  "moduleTests:delete": channel(
    z.object({ id: z.string() }),
    // `moduleId` is the module the case belonged to, null when there was no such case (EO-501).
    z.object({ deleted: z.boolean(), problem: z.string().nullable(), approvalWithdrawn: z.boolean(), moduleId: z.string().nullable() }),
  ),
  /** Runs every case now and answers with the result, which is also stored. */
  "moduleTests:run": channel(
    z.object({ moduleId: z.string() }),
    z.object({ run: ModuleTestRunSchema.nullable(), problem: z.string().nullable() }),
  ),

  // ── Moving a pipeline between machines (KAN-108) ────────────────
  //
  // The payoff of the module contract: a module declares everything it
  // touches, so an import can be checked against this machine before
  // anything runs. Reading and writing the file is the main process's
  // job — the renderer has no filesystem access by design (F-02).
  /**
   * `destination` is which of two callers is asking.
   *
   * `"file"` is the configuration screen: build the document, put a save
   * dialog in front of it, write where the person chose. `"document"` is
   * a caller with no window and nobody to click — it gets the same
   * document as text and decides for itself what to do with it.
   *
   * One channel rather than two because it is one operation with one
   * meaning; what differs is only where the bytes end up. Splitting it
   * would leave the real work in a function two channels called, and the
   * second of them unreachable from the UI — which `reachable.test.ts`
   * would rightly complain about.
   */
  "pipelines:export": channel(
    z.object({ pipelineId: z.string(), destination: z.enum(["file", "document"]).default("file") }),
    z.object({
      written: z.boolean(),
      path: z.string().nullable(),
      /** The export itself, when `destination` was `"document"`. Null otherwise — a file was written instead. */
      document: z.string().nullable().default(null),
      problem: z.string().nullable(),
    }),
  ),
  /**
   * Reads a chosen file and reports what it would need here.
   *
   * Nothing is written by this — it exists so the person sees the cost
   * before agreeing to it, which a pasted shell command could never have
   * offered.
   */
  "pipelines:importPreflight": channel(
    /**
     * `document` is the export to check, for a caller that already has
     * one. Absent means "ask the person for a file", which is what the
     * configuration screen wants and what a caller with no window cannot
     * use.
     */
    z
      .object({
        document: z.string().optional(),
        /** The project the import would land in — see `pipelines:import`'s `into`. Absent is the active project. */
        into: ImportDestinationSchema.optional(),
      })
      .default({}),
    z.object({
      /** Null when the person cancelled the file picker. */
      preflight: ImportPreflightViewSchema.nullable(),
      /** The document itself, handed back so the import does not re-read the file. */
      document: z.string().nullable(),
      problem: z.string().nullable(),
    }),
  ),
  "pipelines:import": channel(
    z.object({
      document: z.string(),
      /** Per colliding slug: keep ours, or bring theirs in beside it. */
      choices: z.record(z.string(), z.enum(["reuse", "import"])).default({}),
      projectId: z.string().nullable().default(null),
      /**
       * The project it lands in, named by a caller that knows it exactly
       * (EO-521) — `null` included, which is no project at all rather
       * than "whichever is active". Wins over `projectId`, whose `null`
       * has always meant the active project. The assistant's import card
       * sends the chat's project here and to `pipelines:importPreflight`
       * alike, so what the card checked is where it imports.
       */
      into: ImportDestinationSchema.optional(),
    }),
    z.object({
      imported: z.boolean(),
      pipelineId: z.string().nullable(),
      /** What still has to be read and approved before this pipeline will publish. */
      unapprovedModules: z.array(z.string()),
      /**
       * The role and action of each definition the file carried that
       * this installation already had differently, and kept (EO-424).
       */
      keptDefinitions: z.array(z.object({ role: z.string(), action: z.string() })).default([]),
      problem: z.string().nullable(),
    }),
  ),

  // The secrets a module can be given (KAN-105). Names only, in both
  // directions: the value goes in and no channel in this half returns it,
  // the same arrangement the Jira token has. The one way back out is the
  // machine half's `moduleSecrets:reveal`, for the person pressing Reveal
  // at the desktop (EO-489, ARCHITECTURE.md §14.2).
  //
  // `stepId` is which step's value: absent or null means the shared one
  // every step falls back to, and a step id means that step's own. One
  // pipeline can deploy to staging and then to production, so the two
  // tokens have to be able to differ within a single graph.
  "moduleSecrets:list": channel(
    z.object({ stepId: z.string().nullable().optional() }),
    z.object({
      /** Set for every step. */
      names: z.array(z.string()),
      /** Set for the step asked about, and overriding the shared value. Empty without a `stepId`. */
      overrides: z.array(z.string()),
      /**
       * The names the organisation has set (EO-328, ARCHITECTURE.md, "Secrets").
       *
       * Names, like the two lists above, and for one more reason than
       * they have: this is the list a row draws
       * `ORGANISATION_SECRET_LINE` from, and the whole claim that line
       * makes is that the value is not on any channel.
       *
       * A **separate list rather than folded into `names`**, because
       * the two namespaces are distinct: a personal secret of the same
       * name is still set, still listed above, and still the person's
       * to change. What the organisation's presence changes is which
       * value a run is given, not whether the person has one.
       */
      organisation: z.array(z.string()).default([]),
      /**
       * The names that hold a reference rather than a stored value
       * (EO-416): "read this from EO's own environment variable".
       *
       * Every reference in the shared scope and in the step asked
       * about, *whether or not it resolves* — which is the difference
       * from the two lists above. A referenced name is in `names` or
       * `overrides` only when a dispatch would get a value; it is here
       * either way, with `available` saying which.
       *
       * The variable's name and a boolean. Never what the variable
       * holds: names may cross IPC, values never do.
       */
      references: z
        .array(
          z.object({
            name: z.string(),
            /** Which of EO's variables it reads. The declared name unless somebody chose another. */
            variable: z.string(),
            scope: z.enum(["shared", "step"]),
            /** Whether EO's environment, as it was launched, has that variable and it is not empty. */
            available: z.boolean(),
          }),
        )
        .default([]),
      /**
       * The names with a stored value on disk, by scope, *whether or not
       * it can still be read* (EO-417). `step` is empty without a `stepId`.
       *
       * Not `names` and `overrides`, which say a dispatch would get a
       * value and so leave out one that no longer decrypts. This is what
       * a reference saved in that scope would remove — and an unreadable
       * value is removed like any other, so the warning that comes first
       * has to be able to see it. Names only, as everywhere here.
       */
      stored: z.object({ shared: z.array(z.string()), step: z.array(z.string()) }).default({ shared: [], step: [] }),
    }),
  ),
  // One of `value` and `reference`, never both and never neither — the
  // handler refuses with a sentence rather than the schema with a parse
  // error, so a caller that got it wrong is told what to send.
  "moduleSecrets:set": channel(
    z.object({
      name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use an environment-variable name."),
      /** A value to store in the OS keychain. */
      value: z.string().min(1).optional(),
      /**
       * Read the name from EO's own environment instead of storing
       * anything (EO-416). `variable` is which one, and defaults to
       * `name`; it is held to the pattern a name is.
       */
      reference: z
        .object({ variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use an environment-variable name.").optional() })
        .optional(),
      stepId: z.string().nullable().optional(),
    }),
    z.object({
      saved: z.boolean(),
      problem: z.string().nullable(),
      /**
       * What this write removed from the same scope because a name holds
       * a value or a reference and never both (EO-416). `value` is the
       * one worth saying out loud: a stored value replaced by a
       * reference is gone for good. Null when the other kind was not
       * there, and when nothing was saved.
       */
      replaced: z.enum(["value", "reference"]).nullable().default(null),
    }),
  ),
  "moduleSecrets:clear": channel(
    z.object({ name: z.string(), stepId: z.string().nullable().optional() }),
    z.object({ cleared: z.boolean() }),
  ),

  // Environment variables (EO-485, ARCHITECTURE.md §14.2): named values
  // that are *not* secret, in a list beside the module secrets. The
  // other way round from the three channels above — the list returns
  // each value, because a variable is shown in full and edited in place.
  //
  // `stepId` scopes it exactly as it scopes a secret: absent or null is
  // the shared value, a step id is that step's own, which wins name by
  // name. Within one scope a name is a secret or a variable, never both,
  // and `set` refuses with a sentence naming the list that already has it.
  "environmentVariables:list": channel(
    z.object({ stepId: z.string().nullable().optional() }),
    z.object({
      /** Every shared variable, then the step's own when a `stepId` was given — each with its value and scope. */
      variables: z.array(EnvironmentVariableSchema),
    }),
  ),
  "environmentVariables:set": channel(
    z.object({
      name: EnvironmentVariableNameSchema,
      /** Kept in the clear under userData. Never encrypted, because it is not a secret. */
      value: z.string(),
      stepId: z.string().nullable().optional(),
    }),
    z.object({ saved: z.boolean(), problem: z.string().nullable() }),
  ),
  "environmentVariables:clear": channel(
    z.object({ name: z.string(), stepId: z.string().nullable().optional() }),
    z.object({ cleared: z.boolean() }),
  ),

  // ── The catalogue of MCP servers a person added (EO-104) ────────
  //
  // The catalogue only. Nothing here reaches an agent: attaching a server
  // to one is EO-106, and generating what a provider reads is EO-107 and
  // EO-108.
  //
  // Values in, names out. A server row carries the *names* of the
  // environment variables it needs; `setSecret` takes a value and nothing
  // in this half hands one back, which is the same arrangement the Jira
  // token and a module's secrets have and the reason no value is in
  // SQLite (ARCHITECTURE.md, "Secrets"). The machine half's
  // `mcpServers:revealSecret` is the one way back out, for the person
  // pressing Reveal at the desktop (EO-489).
  //
  // All six are offered as MCP tools — the read by EO-112, `save`,
  // `setEnabled` and `archive` by EO-113, the two secret channels by
  // EO-115. Reading a catalogue, choosing what is in it and filling in
  // what it needs are different acts and were decided separately, the
  // first two the same way: a read carries names — of the servers, and
  // of the variables they want — so there is nothing in it a transcript
  // should not hold, and a server added through a client is a person's
  // request relayed rather than code an agent wrote for itself.
  //
  // The secret channels were decided against a different precedent,
  // being the only two where the objection was to the value rather than
  // to who is asking. They went with `moduleSecrets:set` rather than
  // with `runtime:signInWithApiKey`, which is still excluded: a
  // third-party token for a server a person catalogued is not EO's own
  // operating credential, and the one-way arrangement above is what
  // makes a transcript carrying it a journey in with no way back out.
  // They are offered gated and warned, on that channel's exact terms.
  //
  // `mcpHost/catalog.test.ts` is where all of that is written down —
  // including what no approval gate catches now that the writes are
  // offered — and where a channel that is neither offered nor excluded
  // fails the build.
  "mcpServers:list": channel(
    // Archived ones are kept so an attachment still has something to
    // point at, and are asked for deliberately — the same arrangement
    // `modules:list` uses.
    z.object({ includeArchived: z.boolean().optional() }),
    z.object({
      servers: z.array(McpServerViewSchema),
      /**
       * What `safeStorage` actually chose, reported on every read.
       *
       * Beside the list rather than on its own channel, because it is
       * the answer to a question the list itself raises: a screen showing
       * "GITHUB_TOKEN: not set" has to be able to say whether that is
       * because nobody typed it or because this machine has nowhere safe
       * to put it.
       */
      keychain: McpKeychainSchema,
      /**
       * Which of these rows the organisation published (EO-328, ARCHITECTURE.md, "Policy").
       *
       * Ids rather than a flag on the row, because that is where the
       * fact actually lives: the published list *is* the answer, and a
       * column beside it would be a second copy with nothing keeping
       * the two honest through a publish that drops one (invariant 6).
       */
      managedIds: z.array(z.string()).default([]),
      /**
       * The organisation-secret names, so a server's variable row can
       * say `ORGANISATION_SECRET_LINE` rather than "Not set" for a
       * value this machine will be given at spawn and has never held.
       */
      organisationSecrets: z.array(z.string()).default([]),
      /**
       * The shared environment variables' names (EO-488, ARCHITECTURE.md
       * §14.2), so a server's variable row can say "From environment
       * variables" rather than "Not set" for a declared name no secret
       * fills and a variable will. Names only, though a variable is not
       * secret: what a row needs is whether one is there.
       *
       * Shared and not a step's, because this list belongs to no step: a
       * shared variable is the one every run is given. A step's own reaches
       * the runs on that step at spawn and is not claimed here.
       */
      environmentVariables: z.array(z.string()).default([]),
      /**
       * Servers the organisation published that this machine has not
       * installed, and why (EO-328, review).
       *
       * Today that is one case: the published name collides with a
       * server of this machine's own, which is refused rather than
       * renaming somebody's work. Refusing is right and being quiet
       * about it was not — the catalogue then shows the person's own
       * `github` and nothing about the organisation's, so the first
       * evidence was an agent reporting a tool it had never been given.
       *
       * Derived on every read, out of the published list and this
       * machine's rows (invariant 6). It stops being true the moment
       * either changes, which a stored column would not.
       */
      unavailable: z.array(UnavailableServerSchema).default([]),
    }),
  ),
  // `problem` rather than a throw: an empty command, a URL with a typo
  // and the name `eo` are all things a person typed, not programmer
  // errors, and the editor has to show them beside the field (F-04).
  "mcpServers:save": channel(
    McpServerDraftSchema,
    z.object({ saved: z.boolean(), server: McpServerViewSchema.nullable(), problem: z.string().nullable() }),
  ),
  /**
   * Turns a server on or off.
   *
   * Its own channel rather than a field on the save, so a switch cannot
   * change what the server points at in the same call — the same reason
   * `modules:approve` is separate from `modules:save`.
   */
  "mcpServers:setEnabled": channel(
    z.object({ id: z.string(), enabled: z.boolean() }),
    z.object({ server: McpServerViewSchema.nullable(), problem: z.string().nullable() }),
  ),
  /** Deleting a server archives it: invariant #3, and an attachment that named it still resolves. */
  "mcpServers:archive": channel(z.object({ id: z.string() }), z.object({ archived: z.boolean(), problem: z.string().nullable() })),
  "mcpServers:setSecret": channel(
    z.object({
      serverId: z.string(),
      name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use an environment-variable name."),
      value: z.string().min(1),
    }),
    // `keychain` comes back with the refusal as well as with the success:
    // a person told "EO will not store this" needs to be told which
    // backend it means in the same breath.
    z.object({ saved: z.boolean(), problem: z.string().nullable(), keychain: McpKeychainSchema }),
  ),
  // ── Connectors: an MCP server with a setup flow (EO-315) ────────
  //
  // Reads and writes about the *words* around a server and the values
  // behind it, never about how it is reached — that is `mcpServers:*`
  // above and stays there. A connector is a server, so everything a
  // connector can be dispatched with it already could be; what these
  // four add is a person who can give it what it needs without meeting a
  // command line or a JSON config (ARCHITECTURE.md, "A connector is an MCP server with a setup
  // flow").
  //
  // All four are excluded from the MCP host's catalogue, and on one
  // ground rather than several: connecting a connector is what puts a
  // server in front of an agent. An agent able to call `connectors:connectToken`
  // would be widening its own tool surface, which is the whole of
  // invariant 11 — and `connectors:connectOAuth` would be an agent
  // opening a browser window on somebody's machine and waiting for them
  // to sign into it.
  "connectors:list": channel(
    z.object({
      /**
       * Narrow to what a step owned by this role would reach.
       *
       * Null is every connector this installation has, which is what
       * Settings shows. A role is the step editor's question, and it is
       * answered the way a dispatch answers it — through the agents
       * staffing the role and what is attached to them.
       */
      role: z.string().nullable().default(null),
    }),
    z.object({
      connectors: z.array(ConnectorViewSchema),
      // Beside the list for `mcpServers:list`'s reason: a red line
      // saying "EO still needs SLACK_TOKEN" has to be able to say
      // whether the Connect button will refuse to store one.
      keychain: McpKeychainSchema,
    }),
  ),
  /**
   * The `token` setup kind: one value per declared secret, stored under
   * the name the definition declared.
   *
   * Every value in one call rather than one call per name, because a
   * connector wanting a token *and* a workspace id is connected by
   * neither of them alone — a person who filled both boxes and pressed
   * Connect once should not end up half-connected because the second
   * write failed on its own channel.
   */
  "connectors:connectToken": channel(
    z.object({
      serverId: z.string(),
      // The same pattern `mcpServers:setSecret` holds a name to, and
      // here for the same reason: a name is part of a path, and the path
      // builder refuses anything else by throwing.
      values: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use an environment-variable name."), z.string().min(1)),
    }),
    z.object({ connected: z.boolean(), problem: z.string().nullable(), keychain: McpKeychainSchema }),
  ),
  // The `oauth` setup kind is `connectors:connectOAuth`, in the machine
  // half below: it opens a browser on the machine the person is at and
  // waits for them to sign in, which is `runtime:startSignIn`'s shape
  // exactly. These three are answered from the record and the keychain,
  // like `mcpServers:setSecret` beside them.
  /**
   * Forgets a connector's values.
   *
   * The server stays. Disconnecting is "EO should not have this
   * credential any more", which is a different sentence from "this
   * server is not one I use" — that one is `mcpServers:archive`, and
   * conflating them would make signing out of Slack delete Slack.
   */
  "connectors:disconnect": channel(
    z.object({ serverId: z.string() }),
    z.object({ disconnected: z.boolean(), problem: z.string().nullable() }),
  ),

  "mcpServers:clearSecret": channel(
    // The same pattern the setter holds a name to, and here for a
    // sharper reason: a name is part of a path, and the path builder
    // refuses anything else by throwing. Holding the shape at the
    // boundary is what keeps that throw unreachable from outside.
    z.object({ serverId: z.string(), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use an environment-variable name.") }),
    z.object({ cleared: z.boolean() }),
  ),

  // ── The catalogue of skills a person wrote (EO-105) ─────────────
  //
  // The catalogue only. Nothing here reaches an agent: attaching a skill
  // to one is EO-106, and writing it into a plugin directory a provider
  // reads is EO-107.
  //
  // A skill crosses this boundary whole — slug, display name,
  // description, body and supporting files — because the thing on the
  // other side is an editor for exactly that. There is no secret in it
  // and so nothing here is one-way, which is the one respect in which
  // this is simpler than `mcpServers:*`.
  //
  // Offered over MCP whole — the read by EO-112, the three writes by
  // EO-113 — which is the one respect in which this is simpler than
  // `mcpServers:*` a second time: there is no secret here to hold back.
  // A client explaining what an agent will do has to be able to see the
  // instructions that agent is handed, and writing one through a client
  // is a person's request relayed rather than code an agent wrote for
  // itself. `mcpHost/catalog.test.ts` carries that decision and the
  // residual it leaves.
  "skills:list": channel(
    // Archived ones are kept so an attachment still has something to
    // point at, and are asked for deliberately — the same arrangement
    // `modules:list` and `mcpServers:list` use.
    z.object({ includeArchived: z.boolean().optional() }),
    // Each with how it has been used (EO-715), counted from `run_events`.
    z.object({ skills: z.array(SkillListEntrySchema) }),
  ),
  // `problem` rather than a throw: a slug that is not one, a supporting
  // file with `..` in its path and a slug another skill has are all
  // things a person typed, not programmer errors, and the editor has to
  // show them beside the field (F-04).
  // `actingAgentId` on the four skill writes (EO-714): a system agent's
  // write is versioned as the agent's, and a lock refuses it.
  "skills:save": channel(SkillDraftSchema.extend({ ...ACTING_AGENT }), z.object({ saved: z.boolean(), skill: SkillSchema.nullable(), problem: z.string().nullable() })),
  /**
   * Turns a skill on or off.
   *
   * Its own channel rather than a field on the save, so a switch cannot
   * change what the skill says in the same call — the same reason
   * `modules:approve` is separate from `modules:save`.
   *
   * Distinct from `disableModelInvocation`, which travels on the save:
   * that one is about whether the model is offered the skill, this one
   * about whether it is delivered at all.
   */
  "skills:setEnabled": channel(
    z.object({ id: z.string(), enabled: z.boolean(), ...ACTING_AGENT }),
    z.object({ skill: SkillSchema.nullable(), problem: z.string().nullable() }),
  ),
  /** Deleting a skill archives it: invariant #3, and an attachment that named it still resolves. */
  "skills:archive": channel(z.object({ id: z.string(), ...ACTING_AGENT }), z.object({ archived: z.boolean(), problem: z.string().nullable() })),
  /**
   * A person's lock (EO-714). While a skill is locked, every write whose
   * author is not a person is refused with nothing written. A person's
   * action only: EO's administrative MCP host refuses the tool, so no
   * agent can lock or unlock a skill.
   */
  "skills:setLocked": channel(
    z.object({ id: z.string(), locked: z.boolean() }),
    z.object({ skill: SkillSchema.nullable(), problem: z.string().nullable() }),
  ),
  /** Every write to one skill, newest first (EO-714). */
  "skills:versions": channel(z.object({ id: z.string() }), z.object({ versions: z.array(SkillVersionSchema), problem: z.string().nullable() })),
  /**
   * Puts an earlier version's description, body and files back, and brings
   * the skill back if it was archived (EO-714). A new version, never a
   * rewrite of the old one.
   */
  "skills:restoreVersion": channel(
    z.object({ id: z.string(), versionId: z.string(), ...ACTING_AGENT }),
    z.object({ skill: SkillSchema.nullable(), problem: z.string().nullable() }),
  ),

  // ── What each agent has been given out of those two (EO-106) ────
  //
  // The join, and the first thing on this contract that does reach an
  // agent: what is attached decides the tool surface the next dispatch
  // is built with, which is why a write here invalidates the cached
  // provider (`providerCacheKey`) and can refuse a thread resume
  // (`findReusableThread`).
  //
  // Both halves are offered over MCP, the read first (EO-112) and the
  // write after it (EO-114), and the write was the sharpest case of the
  // three: the reads only enumerate an agent's surface and the catalogue
  // writes only fill a shelf, while a tick here decides what the next
  // dispatch is built with. It was held on the reading that a client
  // reached *through* one MCP server, choosing which servers EO's agents
  // get, is a tool granting itself tools with the indirection removed —
  // and that was rejected because it names the wrong party. A client is a
  // person's request relayed, the standing under which it already calls
  // `agents:save`.
  //
  // Where the reading is literally true is a *step-owning* agent, and
  // EO-182 scoped that sentence rather than repealing it: no step-owning
  // agent may widen its own tool surface — an implementer or a reviewer
  // mid-run must not be able to decide what it will be dispatched with
  // next. EO's system agent may, and reaches this channel over the
  // internal `eo_admin` server, because reconfiguring the installation
  // is the whole of its job: it owns no step, so there is no run whose
  // surface it could widen from inside, and what it does here is the
  // person's authority delegated rather than an implementer reaching
  // sideways. mcpHost/catalog.ts carries the whole argument.
  "agentAttachments:list": channel(
    // One agent's, or every agent's. A screen that lists a server and
    // asks "which agents have this?" needs the whole map, and asking per
    // agent would be one round trip per role for an answer this size.
    z.object({ agentId: z.string().optional() }),
    z.object({ attachments: z.array(AgentAttachmentsSchema) }),
  ),
  /**
   * Ticks one catalogue entry on or off for one agent.
   *
   * One entry at a time rather than the whole set, because the whole set
   * is a last-writer-wins payload: two windows open on the same agent
   * would each send what they believed, and the second would silently
   * undo the first. A single tick says only what changed.
   *
   * `problem` rather than a throw: an agent or a catalogue entry that
   * has been removed since the screen last listed is a race, not a
   * programmer error, and the tick has to say so where it happened.
   */
  "agentAttachments:set": channel(
    z.object({ agentId: z.string(), kind: AttachableKindSchema, id: z.string(), attached: z.boolean() }),
    z.object({ attachments: AgentAttachmentsSchema.nullable(), problem: z.string().nullable() }),
  ),

  // U-11: what a backend can be configured with. Static options are
  // free; `refreshModels` asks the provider runtime, which spawns its CLI, so the
  // editor requests it deliberately rather than on every render.
  "providers:capabilities": channel(
    z.object({ provider: z.string(), refreshModels: z.boolean().default(false) }),
    z.object({ capabilities: ProviderCapabilitiesSchema, models: z.array(ProviderModelSchema), problem: z.string().nullable() }),
  ),
  // ── EO's MCP server for external clients ────────────────────────
  //
  // Its own channels rather than four more fields on `settings:set`.
  // That channel's own comment above explains why: a screen should only
  // be able to change the setting it is showing, and the inbox's Do Not
  // Disturb toggle has no business refetching when someone edits a port.
  //
  // Nothing here is offered as an MCP tool, and a test in the catalog
  // enforces it — a connected client must not be able to read its own
  // token or open its own gate.
  "mcp:getStatus": channel(z.void(), McpStatusSchema),
  /** A partial update, for the reason `settings:set` gives. */
  "mcp:setConfig": channel(
    z.object({
      enabled: z.boolean().optional(),
      dangerousOperations: z.boolean().optional(),
      /**
       * `0` means "find me a free one and write back what you found".
       *
       * Needed because the server refuses to wander on its own: a
       * configured port that is taken is reported rather than worked
       * around, since the number is sitting in a configuration file the
       * person has already pasted somewhere else. This is how they ask
       * for a different one without guessing.
       *
       * Every other value has to clear the same floor `McpStatusSchema`
       * reports, and the union rather than `min(0)` is why. A request
       * that accepted 80 would store 80, and the status response — which
       * demands 1024 — would then fail its own schema on every
       * subsequent read, leaving the settings panel stuck on a value only
       * a hand-edited database could undo.
       */
      port: z.union([z.literal(0), z.number().int().min(1024).max(65535)]).optional(),
    }),
    McpStatusSchema,
  ),
  /** Mints a new token and drops the old one. Every connected client stops working until its config is updated. */
  "mcp:regenerateToken": channel(z.void(), McpStatusSchema),

  // ── Repository intelligence (EO-141, EO-148, EO-154) ────────────
  //
  // Its own channels rather than more fields on `settings:set`, on the
  // argument that channel makes about itself: a screen should only be
  // able to change the setting it is showing, and the inbox's Do Not
  // Disturb toggle has no business refetching because somebody turned an
  // indexer on.
  //
  // Both of these answer with the whole state of the subsystem — the
  // switch, and what it has produced. That is one object because it is
  // one section: the person reading a status is the person deciding
  // about the switch, and a status list on a channel of its own would be
  // a second round trip for one screen. It is also what keeps EO's index
  // surface at the three operations below. A person can build an index,
  // refresh one or throw one away and start again; *looking* at one is
  // not a fourth thing they do, and giving it a verb of its own is how
  // a three-operation surface quietly becomes four.
  //
  // None of these is offered as an MCP tool: an external client must not
  // be able to switch on a subsystem that fetches a binary and indexes a
  // checkout on somebody's machine.
  "repositoryIntelligence:getConfig": channel(z.void(), RepositoryIntelligenceStatusSchema),
  /** A partial update, for the reason `settings:set` gives. Answers with the whole state. */
  "repositoryIntelligence:setConfig": channel(RepositoryIntelligenceConfigPatchSchema, RepositoryIntelligenceStatusSchema),

  // ── The three things a person can do to an index (EO-154) ───────
  //
  // Build one, bring one up to date, throw one away and start again.
  // That is the whole of it, and deliberately not everything the
  // subsystem can do. `getStatus` is a probe, and the state above is
  // read from EO's own notes instead — a settings screen that spawned an
  // indexer on every render would make opening Settings cost what a
  // dispatch costs, once per index. `getAgentMcpConfig` describes a
  // subprocess for an agent rather than an action anybody takes. And
  // `remove` is absent on purpose: it would leave a checkout with no
  // index *and* no note saying why, which is the state this screen
  // exists to get somebody out of. Rebuild is the recovery path, because
  // an index is derived and disposable and there is nothing else it
  // could be.
  //
  // **No channel accepts a provider argument.** Each names one row by
  // its id and nothing else. Which implementation runs is read from the
  // configuration in the main process at call time, the way every other
  // reader of that switch does it. A payload that could name one would
  // put the choice in front of a person the entire feature is built so
  // that they never have to make.
  //
  // None is offered over MCP, for the reason the two above are not:
  // these spawn an indexer against somebody's checkout and delete
  // directories on their machine.
  /** Builds an index for a checkout that has none. */
  "repositoryIntelligence:initializeRepositoryIndex": channel(RepositoryIndexRefSchema, RepositoryIndexActionSchema),
  /** Brings an existing index up to date with the checkout. What the Refresh button does. */
  "repositoryIntelligence:syncRepositoryIndex": channel(RepositoryIndexRefSchema, RepositoryIndexActionSchema),
  /** Throws the index away and builds it again. The recovery path for a corrupted one. */
  "repositoryIntelligence:rebuildRepositoryIndex": channel(RepositoryIndexRefSchema, RepositoryIndexActionSchema),

  /*
   * The project's item types, and making one (ARCHITECTURE.md, "An item type is data", KAN-164).
   *
   * A type is labels, a container flag and a spec shape, and none of
   * that is code — so creating one is a person's job in the configure
   * screen rather than a pack author's. Scoped to the project, because
   * `item_types` rows are: a "Case" added here is not added to every
   * other project on the installation.
   *
   * Every write answers with `problem` rather than throwing, for the
   * reason `resolveItemType` does: a duplicate word, a label with no
   * letters in it, a type somebody else's window deleted a moment ago,
   * a type with work filed under it — all of them are something a person
   * did, and a sentence is the answer to those.
   */
  "itemTypes:list": channel(
    // Omitted means the active project, which is what the screen wants
    // and what saves it threading one through. Explicit `null` is the
    // installation scope, and is not the same thing.
    z.object({ projectId: z.string().nullable().optional() }),
    z.object({ types: z.array(ItemTypeViewSchema) }),
  ),
  "itemTypes:create": channel(
    z.object({
      projectId: z.string().nullable().optional(),
      label: z.string().min(1),
      plural: z.string().min(1),
      /** Whether items of it hold other items rather than being work (ARCHITECTURE.md, "An item type is data"). */
      container: z.boolean().default(false),
      /** What the form offers. Compiled to the row's spec shape by `specShapeFromFields`. */
      fields: z.array(SpecFieldDraftSchema).default([]),
    }),
    z.object({ type: ItemTypeViewSchema.nullable(), problem: z.string().nullable() }),
  ),
  // Every field optional, because a pack's type may have only its labels
  // changed and the screen sends only what it is allowed to move —
  // sending `container` or `fields` for one is refused rather than
  // ignored, so a caller is never told a change landed when it did not.
  "itemTypes:update": channel(
    z.object({
      id: z.string(),
      label: z.string().min(1).optional(),
      plural: z.string().min(1).optional(),
      container: z.boolean().optional(),
      fields: z.array(SpecFieldDraftSchema).optional(),
    }),
    z.object({ type: ItemTypeViewSchema.nullable(), problem: z.string().nullable() }),
  ),
  // `itemCount` travels with the refusal so a caller can say something
  // else about it without reading the sentence back — the shape
  // `stepHoldsItemsMessage` established for the same rule on a step.
  "itemTypes:delete": channel(
    z.object({ id: z.string() }),
    z.object({ deleted: z.boolean(), itemCount: z.number().int(), problem: z.string().nullable() }),
  ),

  "guards:get": channel(z.void(), GuardConfigSchema),
  // Answers with a result rather than the configuration, because this
  // write can be refused: a run timeout below what a module step already
  // asks for is a contradiction EO declines to store (EO-162).
  "guards:set": channel(GuardConfigSchema, GuardSaveResultSchema),
  // D-04: one EO, many repos. `activeProjectId` is which one the window
  // is showing — the engine advances all of them regardless.
  //
  // **A repository here is a `git-worktree` workspace** (KAN-130). The
  // storage split into `workspaces` and `connector_bindings`; this
  // surface did not, and `repositoryId` on every channel below carries a
  // workspace id — the same id the repository had. The precedent is the
  // one CLAUDE.md sets for "ticket" against `items`: what a person picks
  // in Settings, and what `repositories_list` answers with, is a
  // repository, and a screen that called it a workspace would be a
  // rename nobody asked for. Settings → Workspaces, where the word does
  // change, is a later story in this phase.
  "repositories:list": channel(z.void(), z.object({ repositories: z.array(RepositoryViewSchema) })),

  // KAN-17: a project stops being a repository. Which project the window shows
  // is a view concept only — the engine advances every repository
  // regardless, exactly as it did when a project *was* one.
  /**
   * Every project this caller may see (EO-326, ARCHITECTURE.md, "Identity").
   *
   * Which is all of them on a desktop and for an admin, and the ones a
   * person has work on otherwise — see `visibleProjects` in main, which
   * is where the rule and its limits are written down.
   */
  "projects:list": channel(
    z.object({ ...ACTING_DEVICE }).default({}),
    z.object({ projects: z.array(ProjectViewSchema), activeProjectId: z.string().nullable() }),
  ),
  "projects:create": channel(
    z.object({ name: z.string().min(1), keyPrefix: z.string().min(1), repositoryIds: z.array(z.string()).default([]) }),
    z.object({ ok: z.boolean(), project: ProjectViewSchema.optional(), problem: z.string().nullable() }),
  ),
  "projects:update": channel(
    z.object({
      id: z.string(),
      name: z.string().min(1).optional(),
    }),
    z.object({ ok: z.boolean(), project: ProjectViewSchema.optional(), problem: z.string().nullable() }),
  ),
  "projects:setActive": channel(z.object({ id: z.string() }), z.object({ activeProjectId: z.string().nullable() })),
  "projects:addProject": channel(
    z.object({ projectId: z.string(), repositoryId: z.string() }),
    z.object({ ok: z.boolean(), project: ProjectViewSchema.optional(), problem: z.string().nullable() }),
  ),
  "projects:removeProject": channel(
    z.object({ projectId: z.string(), repositoryId: z.string() }),
    z.object({
      ok: z.boolean(),
      project: ProjectViewSchema.optional(),
      problem: z.string().nullable(),
    }),
  ),
  /**
   * Deletes a project and every item on it, for good (EO-346).
   *
   * Refuses first and confirms second, the way `items:delete` does.
   * Without `confirm` nothing is deleted and the answer is what
   * deleting would take: how many tickets, how many of them unfinished,
   * which have an agent running and which hold uncommitted work in a
   * worktree. Only a call with `confirm: true` deletes — stopping those
   * runs, removing those worktrees and keeping their branches.
   *
   * A project on the organisation's record is refused outright: the
   * record owns it, and `problem` says so. The project's repositories
   * stay in EO, attached to no project, and Jira is not touched.
   */
  "projects:delete": channel(
    z.object({ projectId: z.string(), confirm: z.boolean().default(false) }),
    z.object({
      deleted: z.boolean(),
      /** Why this project cannot be deleted at all. Null on a preview and on a delete. */
      problem: z.string().nullable(),
      name: z.string().nullable(),
      /** Every item on the project, archived ones included. */
      itemCount: z.number(),
      /** Not archived and not finished. */
      unfinishedCount: z.number(),
      /** Tickets with an agent running or queued on them. Confirming stops those runs. */
      running: z.array(z.object({ itemKey: z.string(), title: z.string() })),
      /** Tickets whose worktree holds uncommitted changes. Confirming removes the worktree; the branch stays. */
      uncommitted: z.array(z.object({ itemKey: z.string(), title: z.string(), changes: z.number() })),
      /** How many tickets went, on a delete. */
      deletedCount: z.number(),
      /** Checkouts the delete could not remove, left on disk (issue #131). */
      leftoverWorktrees: z.array(z.object({ itemKey: z.string(), path: z.string(), problem: z.string() })),
      /** Which project the window shows now. Null when none is left. */
      activeProjectId: z.string().nullable(),
    }),
  ),
  /**
   * Puts a project away, reversibly (EO-347).
   *
   * Refuses first and confirms second, as `projects:delete` does.
   * Without `confirm` nothing changes and the answer is what archiving
   * would do: how many unfinished tickets pause, and which have an
   * agent running that would be stopped. A confirmed call archives it,
   * stops those runs, and says so on each of those tickets.
   *
   * While archived, nothing on the project is dispatched, and it is out
   * of the switcher, the board, the Inbox and the attention counts.
   * `projects:restore` brings all of it back. A project on the
   * organisation's record is refused: the record owns it.
   */
  "projects:archive": channel(
    z.object({ projectId: z.string(), confirm: z.boolean().default(false) }),
    z.object({
      archived: z.boolean(),
      /** Why this project cannot be archived at all. Null on a preview and on an archive. */
      problem: z.string().nullable(),
      name: z.string().nullable(),
      /** Tickets that are not archived and not finished — the ones that pause. */
      unfinishedCount: z.number(),
      /** Tickets with an agent running or queued on them. Confirming stops those runs. */
      running: z.array(z.object({ itemKey: z.string(), title: z.string() })),
      /** Which project the window shows now. Null when none is left. */
      activeProjectId: z.string().nullable(),
    }),
  ),
  /**
   * Brings an archived project back (EO-347).
   *
   * Every item it paused is in front of the scheduler again on the
   * step it was on — those whose run the archive stopped included — and
   * nobody has to resume them one by one. An item somebody had put on
   * hold before is still on hold: archiving never touched it.
   */
  /**
   * Opens a project's notes — its thread, made the first time it is
   * asked for (EO-471, ARCHITECTURE.md, "One channel").
   *
   * Answers the item's id for the ordinary item view to open, or why
   * there is none: the project is gone, mid-move, or on a record this
   * desktop cannot reach.
   */
  "projects:thread": channel(
    z.object({ projectId: z.string() }),
    z.object({
      itemId: z.string().nullable(),
      problem: z.string().nullable(),
    }),
  ),
  "projects:restore": channel(
    z.object({ projectId: z.string() }),
    z.object({
      restored: z.boolean(),
      /** Why it was not restored — gone, or not archived. Null on a restore. */
      problem: z.string().nullable(),
      name: z.string().nullable(),
      /** Unfinished tickets back in front of the scheduler. Held ones are counted: they are back too, and still held. */
      unfinishedCount: z.number(),
    }),
  ),
  "repositories:create": channel(
    CreateRepositoryInputSchema,
    z.object({
      ok: z.boolean(),
      repository: RepositoryViewSchema.optional(),
      /** Items that predated every repository and were adopted by this one. */
      adoptedItems: z.number().optional(),
      /** The project it joined, or that was made for it when `created`. */
      project: z.object({ id: z.string(), name: z.string(), created: z.boolean() }).optional(),
      problem: z.string().nullable(),
    }),
  ),
  "repositories:update": channel(
    UpdateRepositoryInputSchema,
    z.object({ ok: z.boolean(), repository: RepositoryViewSchema.optional(), problem: z.string().nullable() }),
  ),
  "repositories:remove": channel(z.object({ id: z.string() }), z.object({ ok: z.boolean(), problem: z.string().nullable() })),

  // ── Workspaces ──────────────────────────────────────────────────
  //
  // Every kind of disk, where `repositories:*` above is the one kind
  // (EO-301, ARCHITECTURE.md, "A workspace is a kind, attached to the project"). The two are not
  // rivals and neither is a
  // deprecation of the other: a repository *is* a workspace and always
  // was the same row, so `repositories:*` stays as the git kind's own
  // door — it is what the MCP catalogue offers, what knows how to
  // refuse a path that is not a checkout, and what decides which project
  // a newly attached one joins. These channels are what a screen showing
  // *all four kinds* needs, and for the git kind they delegate to those
  // rather than growing a second opinion about what a repository is.
  "workspaces:list": channel(
    // Scoped by project, because that is what the screen shows and what
    // the step picker may offer. Null asks for every workspace there is,
    // including the ones a deleted project left behind — which is the
    // only place they are visible at all.
    z.object({ projectId: z.string().nullable().optional() }),
    z.object({ workspaces: z.array(WorkspaceViewSchema) }),
  ),
  "workspaces:create": channel(
    CreateWorkspaceInputSchema,
    z.object({ ok: z.boolean(), workspace: WorkspaceViewSchema.optional(), problem: z.string().nullable() }),
  ),
  "workspaces:update": channel(
    UpdateWorkspaceInputSchema,
    z.object({ ok: z.boolean(), workspace: WorkspaceViewSchema.optional(), problem: z.string().nullable() }),
  ),
  "workspaces:remove": channel(z.object({ id: z.string() }), z.object({ ok: z.boolean(), problem: z.string().nullable() })),

  // J-01: the optional Jira mirror. `jira:connect` is the only channel
  // that carries a token, and it carries it *inward* — nothing ever
  // returns one.
  // KAN-22: the site is its own record, so connecting a repository is
  // choosing one and naming a repository on it. The credential is the
  // connection's and is set through `jiraConnections:save`.
  //
  // KAN-130: what these channels *write* is the binding on the named
  // repository's **project**, because which Jira project an EO feature
  // becomes an issue in was never a fact about a checkout. They still
  // take a `repositoryId`, because a person configuring one is looking
  // at the Repositories screen; two repositories on one project
  // therefore read and write the same Jira, which is what they now
  // share. A repository on no project has no binding to reach and is
  // refused by name.
  "jiraConnections:list": channel(z.void(), z.object({ connections: z.array(JiraConnectionViewSchema) })),
  /**
   * Creates or updates a site, and stores its token.
   *
   * The token is proved against the site before it is stored: a stored
   * credential that has never worked reports a puzzling failure later
   * rather than a clear one now. Omitted on an update means "keep the
   * one you have" — renaming a connection should not require retyping a
   * secret.
   */
  "jiraConnections:save": channel(
    z.object({
      id: z.string().optional(), // absent = create
      name: z.string().default(""),
      baseUrl: z.string().min(1),
      flavour: z.enum(["cloud", "datacenter"]),
      email: z.string().nullable().default(null),
      token: z.string().optional(),
    }),
    z.object({ ok: z.boolean(), connection: JiraConnectionViewSchema.optional(), problem: z.string().nullable() }),
  ),
  "jiraConnections:remove": channel(
    z.object({ id: z.string() }),
    z.object({ ok: z.boolean(), problem: z.string().nullable() }),
  ),
  "jira:connect": channel(
    z.object({
      repositoryId: z.string(),
      connectionId: z.string(),
      projectKey: z.string().min(1),
      featureIssueType: z.string().default("Epic"),
      storyIssueType: z.string().default("Story"),
    }),
    z.object({ ok: z.boolean(), problem: z.string().nullable() }),
  ),
  "jira:disconnect": channel(z.object({ repositoryId: z.string() }), z.object({ ok: z.boolean() })),
  /** Proves the whole path — host, credentials, project key, fields — and says which part failed. */
  "jira:test": channel(
    z.object({ repositoryId: z.string() }),
    z.object({ ok: z.boolean(), steps: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })) }),
  ),
  "jira:fields": channel(
    z.object({ repositoryId: z.string(), issueType: z.string() }),
    z.object({ fields: z.array(JiraFieldSchema), problem: z.string().nullable() }),
  ),
  /** The extra field values sent on every create, and whether the checkbox starts ticked (J-03). */
  "jira:saveConfig": channel(
    z.object({
      repositoryId: z.string(),
      fields: z.record(z.string(), z.unknown()),
      createByDefault: z.boolean(),
      featureIssueType: z.string().min(1),
      storyIssueType: z.string().min(1),
    }),
    z.object({ ok: z.boolean(), problem: z.string().nullable() }),
  ),
  // J-02: starting from an issue that already exists. Searching and
  // previewing are reads; only `jira:import` writes, and it writes to
  // EO alone — nothing here changes anything in Jira.
  "jira:search": channel(
    z.object({ repositoryId: z.string(), query: z.string() }),
    z.object({ issues: z.array(JiraIssueSchema), problem: z.string().nullable() }),
  ),
  /** The issue, its children, and whether EO already has it — what the import dialog needs to ask the right question. */
  "jira:preview": channel(
    z.object({ repositoryId: z.string(), key: z.string() }),
    z.object({
      issue: JiraIssueSchema.nullable(),
      children: z.array(JiraIssueSchema),
      /** Set when this issue is already an EO item: the picker opens it instead of making a second one. */
      existingItemId: z.string().nullable(),
      problem: z.string().nullable(),
    }),
  ),
  "jira:import": channel(
    z.object({
      repositoryId: z.string(),
      key: z.string(),
      /**
       * What EO should do with it (KAN-19). `children` imports the Jira
       * children as stories, `plan` lets EO refine its own, and
       * `asWritten` takes the issue as a finished piece of work — which
       * any issue type may be, so this is asked rather than inferred.
       */
      mode: z.enum(["plan", "children", "asWritten"]),
      /**
       * Which repository the work happens in, when the project spans
       * several (KAN-17, KAN-19). Defaults to `repositoryId`, which is the
       * one holding the Jira connection — right for every single-repo
       * project, and a coin toss otherwise, which is why the picker asks.
       */
      targetProjectId: z.string().optional(),
    }),
    z.object({
      itemId: z.string().nullable(),
      storyCount: z.number(),
      alreadyImported: z.boolean(),
      problem: z.string().nullable(),
    }),
  ),

  /**
   * What EO can see about the repository's forge (F-06).
   *
   * Every step reported separately, like `jira:test`: "it did not work"
   * sends people to check the wrong thing.
   */
  "forge:detect": channel(
    z.object({ repositoryId: z.string() }),
    z.object({
      remoteUrl: z.string().nullable(),
      host: z.string().nullable(),
      kind: z.enum(["github", "gitlab"]).nullable(),
      cliInstalled: z.boolean(),
      authenticated: z.boolean(),
      templatePath: z.string().nullable(),
      problem: z.string().nullable(),
    }),
  ),

  // J-04: keeping the issues current. The map is EO state -> Jira
  // status *name*, never a transition id: ids are per repository and which
  // exist depends on where the issue currently sits.
  "jira:statuses": channel(
    z.object({ repositoryId: z.string() }),
    z.object({ statuses: z.array(z.string()), problem: z.string().nullable() }),
  ),
  "jira:saveStatusMap": channel(
    z.object({ repositoryId: z.string(), statusMap: z.record(z.string(), z.string()) }),
    z.object({ ok: z.boolean(), problem: z.string().nullable() }),
  ),
  /** The values sent with a transition that asks for them (J-05). */
  "jira:saveTransitionFields": channel(
    z.object({ repositoryId: z.string(), status: z.string(), values: z.record(z.string(), z.unknown()) }),
    z.object({ ok: z.boolean(), problem: z.string().nullable() }),
  ),
  /** What is still waiting to reach Jira, so a stuck queue is visible rather than mysterious. */
  "jira:outbox": channel(
    z.object({ repositoryId: z.string() }),
    z.object({ pending: z.number(), failing: z.number() }),
  ),


  // ── Jobs: the recurring definitions that stamp work out ─────────
  //
  // A job is configuration a person edits rather than a thing the app
  // drives, so these are the edits and nothing else: list them, make
  // one, read one, change one, run one now, stop and start one, ask
  // what one has cost, be done with one. EO-304 and EO-307 landed the
  // model before its screen and `reachable.test.ts` carried every one
  // of these in `AWAITING_ITS_SCREEN`; EO-308 is that screen
  // (`ARCHITECTURE.md`, "The inbox, the archive and jobs"), so those entries are gone and
  // each of these has a control behind it.
  /**
   * Every job on a project, newest first. Omitting the project means the
   * active one.
   *
   * Summaries rather than bare rows (EO-308): the Jobs list shows a
   * trigger summary, a next run, a last run and a status chip, and three
   * of those four are computed. Computed here because the next run needs
   * the schedule parser and the chip needs the occurrences — both in the
   * main process — and a renderer that derived them would be a second
   * opinion about when a job fires.
   */
  "jobs:list": channel(
    z.object({ projectId: z.string().nullable().optional() }),
    z.object({ jobs: z.array(JobSummarySchema) }),
  ),
  /**
   * One job and its history, for the Job page (EO-308,
   * ARCHITECTURE.md, "The inbox, the archive and jobs").
   *
   * The occurrences travel with the job rather than behind a second
   * channel, because the page has no state in which it wants one without
   * the other: the history *is* the page's lower half, and a job whose
   * rows arrive separately draws an empty table for a beat every time it
   * opens.
   *
   * Null for a job that has been deleted as well as one that never
   * existed. A tombstone is how an item still names what filed it
   * (`JobViewSchema.deletedAt`); it is not a page to open.
   */
  "jobs:get": channel(
    z.object({ jobId: z.string() }),
    z.object({ job: JobSummarySchema.nullable(), occurrences: z.array(JobOccurrenceRowSchema) }),
  ),
  /**
   * Edits a job (EO-308, ARCHITECTURE.md, "The inbox, the archive and jobs").
   *
   * Every field optional and absence meaning "leave it", so the page can
   * save the one thing a person changed rather than posting the whole
   * job back and racing whatever else moved. `null` where the schema
   * allows one is a real value — clearing a budget is said by sending
   * null, which is why these are `.nullable().optional()` rather than
   * merely optional.
   *
   * Answers with a problem for the reasons `jobs:create` does, and
   * checked by the same code: a schedule that does not parse, a zone
   * this machine does not know, a pipeline that has been deleted. An
   * edit that would leave a job unable to fire is refused at the moment
   * it is made rather than at the first morning nothing appears.
   */
  "jobs:update": channel(
    z.object({
      jobId: z.string(),
      name: z.string().min(1).optional(),
      trigger: JobTriggerSchema.optional(),
      pipelineId: z.string().nullable().optional(),
      template: JobTemplateSchema.nullable().optional(),
      budgetPerOccurrenceCents: z.number().int().min(0).nullable().optional(),
      maxItemsPerHour: z.number().int().min(1).nullable().optional(),
      /**
       * Where it runs (EO-330, ARCHITECTURE.md, "Where a job runs").
       *
       * Optional like every other field, and never nullable: a job runs
       * somewhere, so "clear it" is not a thing to say. Refused when the
       * pipeline cannot run there — `problem` carries every reason, and
       * the refusal is made in the command rather than only on the
       * screen because the screen is not the only door (the design's rule for
       * a lock: the system agent's admin MCP server reaches these same
       * handlers).
       */
      runsOn: JobRunsOnSchema.optional(),
    }),
    z.object({ job: JobSummarySchema.nullable(), problem: z.string().nullable() }),
  ),
  /**
   * Makes a job, and with it the off-board item it posts its guards on
   * (ARCHITECTURE.md, "What a job records").
   *
   * Answers with a problem rather than throwing, because every way of
   * getting this wrong is something the caller asked for: a pipeline
   * with no entry step, a template naming a type this project does not
   * have.
   */
  "jobs:create": channel(
    z.object({
      projectId: z.string().nullable().optional(),
      name: z.string().min(1),
      trigger: JobTriggerSchema,
      pipelineId: z.string().nullable().optional(),
      template: JobTemplateSchema.nullable().optional(),
      budgetPerOccurrenceCents: z.number().int().min(0).nullable().optional(),
      maxItemsPerHour: z.number().int().min(1).nullable().optional(),
      /** Omitted is `device`, which is where every job has always run (EO-330, ARCHITECTURE.md, "Where a job runs"). */
      runsOn: JobRunsOnSchema.optional(),
    }),
    z.object({ job: JobSummarySchema.nullable(), problem: z.string().nullable() }),
  ),
  /**
   * The `manual` trigger: fire this job once, now.
   *
   * Exactly one item and one occurrence, or one `failed` occurrence and
   * the sentence saying why — which the job's thread is told as well,
   * because a guard that fires when no item exists still has to end in
   * a comment (invariant #8).
   */
  "jobs:runNow": channel(
    z.object({ jobId: z.string() }),
    z.object({
      fired: z.boolean(),
      occurrence: JobOccurrenceViewSchema.nullable(),
      itemId: z.string().nullable(),
      problem: z.string().nullable(),
    }),
  ),
  /**
   * Is done with the job, and says what should happen to its work
   * (EO-308, ARCHITECTURE.md, "The inbox, the archive and jobs").
   *
   * `archiveItems` is the choice the dialog offers in as many words:
   * "archive its items" puts away everything the job ever filed, and
   * "keep them" leaves that work where it is — on the board, still
   * naming the job that filed it. Defaulted to false because it is the
   * destructive half of the pair and a caller that forgot to say should
   * not have chosen it by omission.
   *
   * The thread is archived either way, so what was said stays. The job
   * row itself becomes a tombstone rather than going — see
   * `JobViewSchema.deletedAt`, which is what lets a kept item go on
   * saying where it came from.
   */
  "jobs:delete": channel(
    z.object({ jobId: z.string(), archiveItems: z.boolean().default(false) }),
    z.object({ deleted: z.boolean(), archivedItemCount: z.number() }),
  ),
  /**
   * Stopping a job, and starting it again (EO-307,
   * ARCHITECTURE.md, "Controls").
   *
   * A paused job fires nothing: its occurrences still come round and are
   * still written down, as `skipped` rows carrying `paused`, so the
   * history says what did not happen rather than showing a gap. The
   * budget guard pauses a job on the person's behalf, which is why this
   * pair exists before the Job page does — something has to be able to
   * undo it.
   *
   * The job as it now stands comes back, rather than a bare
   * acknowledgement: `pausedAt` is what the button is drawn from and
   * `pausedFor` is what the chip beside it is, and a caller that has to
   * re-list to find out what it just did is a caller that will draw the
   * wrong one for a moment. A summary rather than the row, for that
   * second reason and so that every `jobs:*` answer about one job is
   * the same shape (EO-308).
   */
  "jobs:pause": channel(z.object({ jobId: z.string() }), z.object({ job: JobSummarySchema.nullable() })),
  "jobs:resume": channel(z.object({ jobId: z.string() }), z.object({ job: JobSummarySchema.nullable() })),
  /**
   * What this job has cost: every run of every item its occurrences
   * filed (ARCHITECTURE.md, "Jobs").
   *
   * Summed on demand rather than kept on the row, for the reason the
   * item's provenance is: the occurrences already record which items a
   * job produced, and a running total would be the same fact written
   * twice with nothing keeping the two honest.
   */
  "jobs:cost": channel(z.object({ jobId: z.string() }), z.object({ jobId: z.string(), costCents: z.number() })),

  // ── A webhook job's own surface (EO-333, ARCHITECTURE.md, "The inbox, the archive and jobs",
  // "Results and routes") ────────────
  //
  // Three channels beside the eight above, and each is a thing the Job
  // page does that no other job needs: read the deliveries, mint a new
  // secret, send one through the door on purpose. The URL, the secret
  // and the mapping are not among them — they are the job's trigger,
  // and `jobs:get` already carries it, so a fourth channel repeating
  // them would be a second account of one row.
  /**
   * What has arrived, and what is waiting (ARCHITECTURE.md, "The inbox, the archive and jobs",
   * "Webhooks").
   *
   * The Events tab: every delivery newest first, including the ones
   * that produced no item, which is the whole reason `job_events`
   * exists. `heldCount` is the original design's own sentence — with concurrency
   * at 1 a burst of forty shows one item, and "38 waiting" is the
   * difference between a queue draining and thirty-eight events lost.
   *
   * `lastPayload` is the body of the newest delivery that has one, and
   * it travels here rather than being fished out of `events` by the
   * page: the field-mapping table previews against it, the rows are
   * capped at a page, and a preview that went blank because the last
   * payload happened to fall off the end of the list would be a mapping
   * table that stopped working as a job got busy. Null before anything
   * has been received, and never a refused delivery's — those rows keep
   * no body at all (see `job_events.payload`).
   */
  "jobs:events": channel(
    z.object({ jobId: z.string(), limit: z.number().int().min(1).max(500).default(100) }),
    z.object({ events: z.array(JobEventRowSchema), heldCount: z.number(), lastPayload: z.string().nullable() }),
  ),
  /**
   * A new signing secret, and the old one stops working (ARCHITECTURE.md, "The inbox, the archive
   * and jobs").
   *
   * Minted in the main process rather than sent from the page, which is
   * the rule `mintWebhookSecret` states: a key chosen by the half of the
   * app that does not verify with it is a key whose randomness nobody
   * checked. So the request carries nothing but the job.
   *
   * There is no confirmation in the contract and deliberately none: the
   * old secret is invalid the moment this answers, every sender still
   * using it starts being refused, and the page says so before it asks.
   * A `problem` rather than a throw, because a deleted job and a job
   * that is not a webhook job are both things a caller can ask about.
   */
  "jobs:regenerateSecret": channel(
    z.object({ jobId: z.string() }),
    z.object({ job: JobSummarySchema.nullable(), problem: z.string().nullable() }),
  ),
  /**
   * One delivery, sent on purpose (ARCHITECTURE.md, "The inbox, the archive and jobs").
   *
   * Through the same door a sender reaches: the sample is signed with
   * the job's own secret and decided by `receiveWebhook`, so the
   * signature, the window, the event key, the cap and the row are the
   * real ones. What it skips is the socket and the throttle in front of
   * it — a record posting to its own public address would be asking
   * whatever terminates TLS in front of it for permission to talk to
   * itself, and on a desktop it would file the item somewhere this page
   * cannot link to.
   *
   * The answer is the outcome rather than a boolean, because every
   * outcome is a real thing to be told: a job at its cap answers `held`
   * and a paused one answers `held` too, and "it did not work" would be
   * the wrong sentence for either.
   */
  "jobs:testEvent": channel(
    z.object({ jobId: z.string() }),
    z.object({
      outcome: JobEventOutcomeSchema.nullable(),
      itemId: z.string().nullable(),
      /** What it filed, for the link the button draws beside its answer. Null for every other outcome. */
      itemKey: z.string().nullable(),
      /** The row's own sentence, or why there was no row at all. */
      problem: z.string().nullable(),
    }),
  ),

  // ── The gallery (EO-316, ARCHITECTURE.md, "What a person sees first") ───────────
  //
  // "A gallery, not an empty board." The door a non-developer comes in
  // through: a set of templates, each a data pack, with Preview before
  // any sign-in and a short form of the template's own blanks.
  //
  // Three channels because there are three gestures — look, rehearse,
  // commit — and each writes a different amount: nothing, a marked item
  // in a preview project, and a whole project.
  "gallery:list": channel(
    z.void(),
    z.object({
      templates: z.array(GalleryTemplateViewSchema),
      /**
       * Whether the fetched half arrived.
       *
       * Reported rather than shown as an error, and named `fetched`
       * rather than `problem` for that reason: the original design makes the bundled
       * set the fallback, so "offline" is a supported state of this
       * screen rather than a failure of it. A person who wants to know
       * why there are four cards and not nine can be told; nobody is
       * interrupted.
       */
      fetched: z.boolean(),
      /**
       * Who a role slot may be given to (ARCHITECTURE.md, "The gallery").
       *
       * Here rather than behind a channel of its own: the "Use this"
       * form is the only caller, and the pickers must offer real people
       * rather than a box to type a name into — an id EO does not know
       * is a foreign key, and a foreign key is not a sentence.
       *
       * Empty in solo mode, where the picker is hidden and the local
       * person is filled in by the main process (EO-302: solo mode
       * displays no names).
       */
      people: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
    }),
  ),
  /**
   * "Preview this pipeline" — the design, before any sign-in.
   *
   * Writes: a preview project if there is not one, the pack's pipeline
   * into it if it is not already there, and one marked item. Everything
   * it writes is excluded from inbox, archive and cost by EO-313, and
   * "Done previewing" removes the item.
   */
  "gallery:preview": channel(
    z.object({ slug: z.string().min(1), ...TEMPLATE_TOKEN }),
    z.object({
      itemId: z.string().nullable(),
      projectId: z.string().nullable(),
      /**
       * The board the rehearsal is on (EO-317).
       *
       * Answered as well as the item, because ARCHITECTURE.md, "The needs check"'s exit is
       * "Continue
       * with Preview only" *landing on the board* — the columns with the
       * marked card in the first of them, which is what shows that a
       * pipeline is a thing work moves through. Without it a screen can
       * only open the item, and the board behind it would be whichever
       * one the address falls back to.
       */
      pipelineId: z.string().nullable(),
      problem: z.string().nullable(),
    }),
  ),
  /**
   * "Use this" — the design.
   *
   * The project, the workspace, the pipeline, the agents, the job and
   * the item types, from one submission. Answers with the needs check's
   * lines, which is where the screen lands.
   */
  "gallery:use": channel(
    z.object({
      slug: z.string().min(1),
      ...TEMPLATE_TOKEN,
      /** What the person typed, keyed by `GalleryBlankViewSchema.key`. */
      answers: z.record(z.string(), z.string()).default({}),
      /** Who fills each role slot, keyed by the pack's own step id. Empty in solo mode (ARCHITECTURE.md, "The gallery"). */
      roleSlots: z.record(z.string(), z.string()).default({}),
      /** What to call the project. Absent means the template's title. */
      projectName: z.string().optional(),
    }),
    z.object({
      projectId: z.string().nullable(),
      pipelineId: z.string().nullable(),
      jobId: z.string().nullable(),
      /** One line per thing that still has to be true (ARCHITECTURE.md, "The needs check"). */
      needs: z.array(GalleryNeedSchema).default([]),
      problem: z.string().nullable(),
    }),
  ),
  /**
   * The needs check, read again (EO-317, ARCHITECTURE.md, "The needs check").
   *
   * `gallery:use` answers with these lines once; this is how the screen
   * asks for them *again*, which is the whole of "fixing it turns the
   * line green without leaving the screen". The pack is named the same
   * way both other gallery actions name one — slug and token — because
   * what a need is depends on the document as much as on the project:
   * which roles it wants, which connectors, whether it works in a
   * repository or a folder.
   */
  "gallery:needs": channel(
    z.object({ projectId: z.string(), slug: z.string().min(1), ...TEMPLATE_TOKEN }),
    z.object({
      needs: z.array(GalleryNeedSchema).default([]),
      /**
       * The job this project's template created, or null.
       *
       * What step 6 of the original design acts on: "the first item runs, and they watch
       * it". A template that files work on a schedule has one, and
       * running it now is the honest first item — a real report rather
       * than a canned example. A template with no job has no first item
       * to start, and the screen offers the board instead.
       */
      jobId: z.string().nullable().default(null),
      problem: z.string().nullable(),
    }),
  ),
  /**
   * The button on a red role line (EO-317, the original design).
   *
   * "An agent for the Reporter steps" goes red when nothing here can play that
   * role, and the commonest way to arrive there is an import: a pack
   * whose role names no backend — which is most of them, since a backend
   * is a fact about the installing machine — lands as an agent with
   * nothing to run on and switched off. Signing in does not move that
   * line, because the row is still pointed at nothing; so without this
   * the needs check carried a red line nobody could turn green, which is
   * exactly what the design forbids.
   *
   * Points that row at a backend this machine is signed in to and
   * switches it on. Where no such row exists — a pack whose role EO has
   * never made an agent for — one is created from the role the document
   * carries, prompt and all.
   */
  "gallery:staffRole": channel(
    z.object({
      slug: z.string().min(1),
      ...TEMPLATE_TOKEN,
      /** Which of the pack's roles to staff. */
      role: z.string().min(1),
      /**
       * Which backend to point it at. Absent means the one the pack was
       * built on where this machine is signed in to it, and otherwise
       * whatever it is signed in to.
       */
      backend: z.string().optional(),
    }),
    z.object({
      ok: z.boolean(),
      problem: z.string().nullable(),
      /**
       * The organisation publishes its agents, and this press would
       * have created one (EO-329, ARCHITECTURE.md, "Publish, lock and versions").
       *
       * Typed rather than left to the sentence, for
       * `IpcErr.lock`'s reason and one sharper than it. This channel
       * answers *a person looking at a screen*, and the refusal a
       * locked section writes is composed for an agent reading a
       * transcript — "tell the person it is managed and stop" is an
       * instruction to an assistant, and showing it to the person it
       * is about is worse than saying nothing. So the marker travels
       * and the screen draws the design's own lock text from it.
       *
       * Null on every other outcome, including the ordinary refusal
       * that nothing on this machine is signed in.
       */
      locked: SectionLockSchema.nullable().default(null),
    }),
  ),
  /**
   * The button on a red workspace line (EO-317, ARCHITECTURE.md, "The needs check").
   *
   * Attaches a folder or a repository **to the project the needs check
   * is about**, and repoints a broken workspace of that kind rather than
   * adding a second one, which is what makes it different from
   * `repositories:create`. Answers with the needs again, so the line
   * goes green where the person is rather than after a round trip they
   * have to make themselves.
   */
  "gallery:attachWorkspace": channel(
    z.object({
      projectId: z.string(),
      /** Typed or picked; a renderer has no filesystem, so either way it arrives as text. */
      path: z.string().min(1),
      /** `git` checks the path is a checkout; `folder` checks it is a directory. */
      kind: z.enum(["folder", "git"]),
    }),
    z.object({ ok: z.boolean(), problem: z.string().nullable() }),
  ),

  // ── First run (EO-317, ARCHITECTURE.md, "What a person sees first") ─────────────
  //
  // The order is the story: mode, gallery, Preview, the template's
  // blanks, the needs check, the first item. What the main process owns
  // of it is the two facts that outlive a window — which mode somebody
  // chose, and whether they have been through it — because a flow that
  // lived in renderer state alone would start again every launch for
  // anybody who left by "Continue with Preview only".
  "firstRun:state": channel(
    z.void(),
    z.object({
      /**
       * Whether first run is behind this installation.
       *
       * True the moment a real project exists — which is every
       * installation that predates this story — so an upgrade never
       * shows the flow to somebody with work on their board. A preview
       * project is not one: rehearsing a template is step 3, in the
       * middle of the flow, and must not end it.
       */
      done: z.boolean(),
      /** `solo`, `organisation`, or null before the first question is answered. */
      mode: z.enum(["solo", "organisation"]).nullable(),
    }),
  ),
  /**
   * Step 1's answer (the original design).
   *
   * "Solo goes straight in. Organisation asks for a server address,
   * signs in, and pulls the published packs." The sign-in is
   * `session:signIn`, made by the welcome screen before this is sent
   * (EO-661); `address` is the server it signed in to, kept beside the
   * mode.
   */
  "firstRun:setMode": channel(
    z.object({ mode: z.enum(["solo", "organisation"]), address: z.string().default("") }),
    z.object({ mode: z.enum(["solo", "organisation"]) }),
  ),
  /**
   * The needs check's way on for a template with no job (EO-664): every
   * line green, and no first item to start.
   *
   * Starts a new assistant chat and shows it. Its first message is EO's
   * brief for the first item — the project, the pipeline and the
   * template's own opening question (`PackTemplateSchema.openingQuestion`)
   * — posted by EO and mentioning the assistant, so its first turn is
   * dispatched without anybody typing. The pipeline is pinned to the
   * brief, so what the assistant raises in answer lands on it.
   *
   * `pipelineId` is the board `gallery:use` answered with; null means the
   * project's own pipeline. Refused, with the sentence to show and no
   * chat, where there is no assistant to talk to.
   */
  "gallery:openFirstItemChat": channel(
    z.object({ projectId: z.string(), slug: z.string().min(1), ...TEMPLATE_TOKEN, pipelineId: z.string().nullable() }),
    z.object({ conversation: DiscussionSchema.nullable(), problem: z.string().nullable() }),
  ),
  /**
   * The button on a red assistant line (EO-664): points the assistant at
   * `backend`, which this machine must be signed in to, and switches it
   * on. Only when pressed — EO never staffs the assistant unasked.
   * Refused, with the sentence to show, for a backend nothing here is
   * signed in to, one the organisation's policy does not allow, or an
   * installation with no assistant at all.
   */
  "gallery:staffAssistant": channel(z.object({ backend: z.string().min(1) }), z.object({ ok: z.boolean(), problem: z.string().nullable() })),
  /** Marks the flow behind them, by any exit — the first item, the assistant's brief, or "Continue with Preview only". */
  "firstRun:finish": channel(z.void(), z.object({ done: z.boolean() })),
  /**
   * The first-board tour (EO-667, ARCHITECTURE.md, "What a person sees
   * first"). `due` is true once first run has been left by one of its
   * exits and the tour has not yet been finished or skipped; an
   * installation that never went through first run is never shown it
   * unasked. Settings' "Show the tour" replays it whatever this says.
   */
  "firstRun:tourState": channel(z.void(), z.object({ due: z.boolean() })),
  /** The tour was finished or skipped: it does not start on its own again. */
  "firstRun:tourSeen": channel(z.void(), z.object({ due: z.boolean() })),

  // ── The organisation's list (EO-323, ARCHITECTURE.md, "Identity") ───
  //
  // People exist before the server. What the server adds is the list,
  // and every channel of it is in the *record* half, because that is
  // precisely where a list of people belongs: it is the shared record,
  // answered identically by a server over HTTP and by a desktop out of
  // its own SQLite. Nothing here needs the machine somebody is sitting
  // at — the machine half's two are `session:*`, which are about *this*
  // installation's sign-in and its keychain.

  /**
   * Everyone and every group EO can name, for the assignee picker and
   * the admin's People section.
   *
   * One channel for both, because every screen that offers one offers
   * the other: "who waits at this step" is answered by a person or by a
   * group, and a picker that fetched them separately would render half
   * of itself while the other half was in flight.
   */
  "people:list": channel(
    z.void(),
    z.object({
      people: z.array(PersonViewSchema),
      groups: z.array(GroupViewSchema),
      /**
       * Whether this came from an organisation server rather than from
       * this machine's own rows.
       *
       * The picker says so — "from your organisation" — because the
       * difference matters to the person choosing: a name that came from
       * the server is a colleague whose desktop will see the item, and a
       * name that came from here is a row this installation invented.
       */
      fromServer: z.boolean(),
    }),
  ),
  /**
   * Who is asking, as the thing asked knows them (EO-326, ARCHITECTURE.md, "Identity").
   *
   * The record half's answer to `session:status`, and the difference
   * between the two is the whole reason this exists. `session:status`
   * says what *this installation* signed in as, which a browser served
   * by a server has no answer to at all: it never signed in from a
   * machine, it holds a token, and nothing in the bundle knows whose.
   * This is answered by whoever holds the record, out of the credential
   * the request arrived on — so the renderer can say "you are Dana, and
   * you are an administrator here" without a machine to ask.
   *
   * `person` is null for the operator's key, which is not a member of
   * the organisation it administers, and `admin` is true for it anyway:
   * it is the credential the container was started with. So the two
   * fields are not one field — an admin need not be a person, and a
   * person need not be an admin.
   */
  "people:me": channel(
    z.object({ ...ACTING_DEVICE }).default({}),
    z.object({
      person: PersonViewSchema.nullable(),
      admin: z.boolean(),
      /**
       * Whether the answer came from a record that holds more than this
       * caller's own work.
       *
       * What the renderer hangs the admin surface off. Not
       * `person.isAdmin`: a solo desktop's one person may perfectly well
       * carry the admin flag — `people:setAdmin` is answered locally
       * when there is no server — and an admin surface on a machine with
       * one person and one project would be a second, emptier copy of
       * the board they are already looking at.
       */
      organisation: z.boolean(),
    }),
  ),
  /**
   * Invites somebody by email, and answers with the link to send them.
   *
   * The link rather than a sent email: EO has no SMTP configuration, no
   * sender identity and nothing to prove it is not spam, so it hands the
   * admin a one-time link to put into whatever their organisation
   * already sends mail with. `identity/directory.ts` says more.
   *
   * `problem` rather than an error envelope, because "that address is
   * already on the list" is an answer to the admin rather than a fault
   * in the request.
   */
  "people:invite": channel(
    z.object({ email: z.string().min(1).max(320), name: z.string().max(200).optional(), isAdmin: z.boolean().default(false) }),
    z.object({
      person: PersonViewSchema.nullable(),
      /**
       * The invitation, as a path — `/invite/<code>`.
       *
       * A path rather than a URL because this process does not reliably
       * know its own public address: it binds a host and a port, and what
       * a colleague can actually reach is whatever terminates TLS in
       * front of it (ARCHITECTURE.md, "The server"). The browser the admin is holding *does* know
       * — it is on that address — so the screen resolves this against its
       * own origin, and a server behind a reverse proxy produces a link
       * that works rather than one naming a port nobody can route to.
       */
      invitePath: z.string().nullable(),
      expiresAt: z.number().nullable(),
      problem: z.string().nullable(),
    }),
  ),
  /** Turns the admin flag on or off. "Everyone with it may edit on the server." */
  "people:setAdmin": channel(z.object({ personId: z.string(), isAdmin: z.boolean() }), z.object({ person: PersonViewSchema.nullable(), problem: z.string().nullable() })),
  /**
   * Accepting an invitation, from the browser the link was opened in.
   *
   * Unauthenticated by name (`UNAUTHENTICATED_CHANNELS`), because it is
   * made by somebody who is not yet anybody. Everything it will accept
   * is in its own request schema, and the code it carries is the whole
   * of what admits it.
   */
  "auth:acceptInvitation": channel(
    AcceptInvitationRequestSchema,
    z.object({ accepted: AcceptInvitationResponseSchema.nullable(), problem: z.string().nullable() }),
  ),
  /**
   * Signing a device in.
   *
   * Unauthenticated for `auth:acceptInvitation`'s reason — a sign-in is
   * by definition the request that has no token yet — and the one
   * channel in the contract whose *response* carries a secret. It is
   * said once and stored by the machine that asked; the server keeps a
   * hash.
   */
  "auth:signIn": channel(
    SignInRequestSchema,
    z.object({ session: SignInResponseSchema.nullable(), problem: z.string().nullable() }),
  ),
  /**
   * The admin's Devices list: name, who, last seen, and whether it has
   * been revoked.
   *
   * `problem` because an empty list is the one answer this channel must
   * never give by accident. A desktop asks its organisation for this,
   * and a server it cannot reach would otherwise answer "nobody has ever
   * signed in" — which is a sentence about the organisation, made up by
   * a client that could not ask.
   */
  "devices:list": channel(z.void(), z.object({ devices: z.array(DeviceViewSchema), problem: z.string().nullable() })),
  /**
   * Revoke, which is what makes a device token a credential an
   * organisation controls (ARCHITECTURE.md, "Identity").
   *
   * Its next request is a 401, and the desktop holding it says it was
   * signed out by your organisation.
   */
  "devices:revoke": channel(z.object({ deviceId: z.string() }), z.object({ device: DeviceViewSchema.nullable(), problem: z.string().nullable() })),
  /** Creates or replaces one group and its membership. Absent `id` creates. */
  "groups:save": channel(
    z.object({ id: z.string().optional(), name: z.string().min(1).max(200), memberIds: z.array(z.string()).default([]) }),
    z.object({ group: GroupViewSchema.nullable(), problem: z.string().nullable() }),
  ),
  /** Deletes a group, and unnames it on every step that was waiting on it. */
  "groups:delete": channel(z.object({ groupId: z.string() }), z.object({ deleted: z.boolean(), problem: z.string().nullable() })),
  /**
   * Who a human step waits on: a person, a group, or nobody (ARCHITECTURE.md, "Identity").
   *
   * Its own channel rather than a field on `pipeline:save`, and that is
   * the same decision `updateStep` already embodies: the configuration
   * screen publishes a whole graph because its *shape* is a property of
   * the set, and who waits at a step cannot make a graph invalid. It is
   * also what keeps a publish from silently unnaming an owner — the trap
   * `forWriting` exists for.
   */
  "steps:setOwner": channel(
    z.object({ stepId: z.string(), personId: z.string().nullable().default(null), groupId: z.string().nullable().default(null) }),
    z.object({ problem: z.string().nullable() }),
  ),

  // ── Policy (EO-328, ARCHITECTURE.md, "Policy", "Secrets") ─────────────
  //
  // The record half, for `people:list`'s reason exactly: what an
  // organisation allows is the shared record, answered identically by a
  // server over HTTP and by a desktop out of its own SQLite. A solo
  // desktop answers `NO_POLICY` and every screen that reads it draws
  // nothing, which is what makes this one code path rather than a
  // managed-mode branch.
  //
  // **Names in, values never out.** `policy:setSecret` takes a value and
  // nothing in this contract hands one back — the same one-way
  // arrangement `moduleSecrets:set` and `mcpServers:setSecret` have, and
  // here it is load-bearing rather than tidy: the story's third
  // acceptance criterion is that an organisation secret "is never
  // returned by any query the renderer can make". A desktop is given the
  // values over a route of the server's that is not a channel at all
  // (`server/http.ts`), which is what keeps that criterion a property of
  // the contract rather than a thing every new channel has to remember.

  /**
   * What the organisation allows, and what today has cost the person
   * asking.
   *
   * One channel for both, because every screen that wants one wants the
   * other: the top bar draws the budget line, the Agents screen greys
   * the backends, and a second round trip for the second half would have
   * the two disagree for as long as it was in flight.
   *
   * `fromServer` is `people:list`'s field and carries the same warning:
   * a desktop whose server is unreachable answers from its last
   * published copy and says so, rather than reporting an organisation
   * with no policy at all — which is a sentence about the organisation,
   * made up by a client that could not ask (ARCHITECTURE.md, "The record").
   *
   * `yours` is null wherever there is no per-person budget to report:
   * a solo desktop, and a managed one whose organisation has published
   * no ceiling.
   */
  "policy:get": channel(
    z.object({ ...ACTING_DEVICE }).default({}),
    z.object({
      policy: OrganisationPolicySchema,
      /**
       * Whether this answer came from a *remote* record.
       *
       * A fact about where the bytes came from, and nothing more. True
       * on a managed desktop that reached its server; false on a solo
       * desktop, on a desktop whose server is unreachable, and — this is
       * the part worth stating — **on the server itself**, which is the
       * record and has nobody to ask.
       *
       * It was doing double duty as the edit-authority flag and inverted
       * the two surfaces it was meant to separate: the admin's browser
       * read false and hid Publish, while every managed desktop read
       * true and was offered it. `mayPublish` is that question now, and
       * this one is back to the single thing it can honestly answer —
       * which is the wording beside the controls rather than the
       * controls: a desktop whose organisation publishes this is a
       * different sentence from a desktop that has no organisation.
       */
      fromServer: z.boolean(),
      /**
       * Whether *this caller, here* may publish the policy (ARCHITECTURE.md, "Publish, lock and
       * versions").
       *
       * Three things at once, because all three have to hold and any one
       * of them alone is a different question:
       *
       *  - **this process is the record.** The design is explicit that the
       *    admin edits policy *on the server*; a desktop is where a
       *    published policy is read, not where it is written;
       *  - **a door was crossed**, which is what separates the browser
       *    an admin opened the server's address in from the window on
       *    somebody's laptop. `ActingCaller.served` is the same flag
       *    `people:me` hangs its admin surface off, and for the same
       *    reason: a solo desktop's one person may carry the admin flag
       *    perfectly well and has nothing to administer;
       *  - **the caller is an admin**, which is the design's one flag and is
       *    what `ADMIN_ONLY_CHANNELS` refuses at that same door. So this
       *    is the screen agreeing with the door rather than guessing
       *    ahead of it.
       */
      mayPublish: z.boolean(),
      yours: PersonBudgetSchema.nullable(),
    }),
  ),
  /**
   * Publishes the policy section.
   *
   * Whole rather than by field, which is the design's rule for a section and
   * the reason this takes every part of it at once: an admin who cleared
   * the allowed-backends list and set a budget in one gesture must not
   * be able to land half of that.
   *
   * The secret *names* are not here. They are moved one at a time by the
   * two channels below, because a name without its value is not a state
   * anybody can publish — writing `["FLY_API_TOKEN"]` here would tell
   * every desktop to expect a value the server does not have.
   */
  "policy:save": channel(
    z.object({
      ...ACTING_DEVICE,
      allowedBackends: z.array(z.string()).nullable().default(null),
      perPersonDailyBudgetCents: z.number().int().min(0).nullable().default(null),
      mcpServers: z.array(PublishedMcpServerSchema).default([]),
    }),
    z.object({ saved: z.boolean(), policy: OrganisationPolicySchema, problem: z.string().nullable() }),
  ),
  /**
   * Sets an organisation secret, under a name.
   *
   * The value goes into the record's own secret store — a headless host
   * has no keychain, which is what `secrets/serverStore.ts` exists for —
   * and the name goes into the policy, where every desktop reads it and
   * draws `ORGANISATION_SECRET_LINE` beside it.
   */
  "policy:setSecret": channel(
    z.object({
      ...ACTING_DEVICE,
      // The same pattern every other secret name in this contract is
      // held to: a name is part of a path, and the path builders refuse
      // anything else by throwing.
      name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use an environment-variable name."),
      value: z.string().min(1),
    }),
    z.object({ saved: z.boolean(), problem: z.string().nullable() }),
  ),
  /** Forgets one, on the record and on every desktop at its next sync. */
  "policy:clearSecret": channel(
    z.object({ ...ACTING_DEVICE, name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use an environment-variable name.") }),
    z.object({ cleared: z.boolean(), problem: z.string().nullable() }),
  ),

  // ── What the organisation publishes, and what that locks (EO-329) ─
  //
  // Three channels, and the split between them is the one
  // `pipeline:validate` and `pipeline:save` already make: a person
  // about to publish over work in flight is owed the count *before*
  // the write, and a count computed by the same call that writes is a
  // count nobody can be shown in time to decide on.
  //
  // The record half, all three. Publishing is the record's act — the
  // rows live there and the sync carries them — and `sections:list` is
  // answered on a desktop out of its replica of exactly those rows, in
  // the same way `items:list` answers out of the replica of the items.

  /**
   * What this installation has published, or has had published to it
   * (ARCHITECTURE.md, "Publish, lock and versions").
   *
   * One channel for both ends, because it is one question asked from
   * two sides. On a server it is what the admin published and can roll
   * back; on a desktop it is what arrived, and what every locked screen
   * draws `SECTION_LOCK_TEXT` from.
   *
   * `locked` is the derived half — which of the five a person here
   * cannot edit — and it is derived rather than stored for invariant
   * #6's reason applied one subject over: on the record the very same
   * rows lock nothing, because the record is where an admin edits.
   */
  "sections:list": channel(
    z.void(),
    z.object({
      published: z.array(PublishedSectionSchema),
      /** The sections this installation may not write. Empty on the record itself. */
      locked: z.array(PublishedSectionNameSchema),
      /** `SECTION_LOCK_TEXT`, carried so the screens cannot each write their own. */
      lockText: z.string(),
    }),
  ),
  /**
   * What publishing this section would mean, before it is published
   * (ARCHITECTURE.md, "Publish, lock and versions").
   *
   * Answers the confirmation — "3 items in flight across 2 desktops
   * finish on v6" — and nothing else. Writes nothing, so a person can
   * open the dialogue and close it again.
   */
  "sections:publishPreflight": channel(
    z.object({
      section: PublishedSectionNameSchema,
      /** The pipeline a rollback names. Absent means "the section as it stands". */
      pipelineId: z.string().nullable().default(null),
      /** The older version a rollback goes back to. Absent means "what is current". */
      versionNumber: z.number().int().positive().nullable().default(null),
    }),
    z.object({
      confirmation: z.string(),
      items: z.number().int().nonnegative(),
      devices: z.number().int().nonnegative(),
      /** The version that work in flight finishes on, where there is any. */
      finishOn: z.number().int().positive().nullable(),
      problem: z.string().nullable().default(null),
    }),
  ),
  /**
   * Publishes a section to every signed-in desktop — and rolls one
   * back, which is publishing an older version again (ARCHITECTURE.md, "Publish, lock and
   * versions").
   *
   * Rollback is not a second verb: "rollback is publishing an older
   * version again", so it is this channel with a `versionNumber` on it.
   * A pipeline rolled back has its live graph restored from that
   * version's own document and its `current_version_id` pointed back at
   * it — never a rewrite of the version named, which is immutable
   * (EO-327).
   *
   * Refused, with the count, where the older version has no step for
   * work standing on one it removes: the same strand refusal a save
   * meets, from the same guard, because a rollback is a graph change
   * like any other.
   */
  "sections:publish": channel(
    z.object({
      section: PublishedSectionNameSchema,
      pipelineId: z.string().nullable().default(null),
      versionNumber: z.number().int().positive().nullable().default(null),
      ...ACTING_DEVICE,
    }),
    z.object({
      published: z.array(PublishedSectionSchema),
      /** The same sentence the preflight answered, as what happened rather than what would. */
      confirmation: z.string(),
      problem: z.string().nullable().default(null),
    }),
  ),

  // ── Suggestions (EO-331, ARCHITECTURE.md, "Divergence and suggestions")
  // ───────────────────────────────────
  //
  // The other end of `pipelines:suggest`: what the record does with a
  // document a desktop sends it, and what the admin reviewing one
  // reads. Both are answered by the record — the first writes the item,
  // and the second is the screen a browser the server serves draws.

  /**
   * Files a suggested change as an item on the "pipeline changes"
   * pipeline (ARCHITECTURE.md, "How a pack travels").
   *
   * The document travels as text rather than as a parsed object, and
   * deliberately: it is the item's **output**, which is a comment, and
   * what an output holds is what a person can read and copy. It is
   * parsed on arrival to be refused early if it will not parse at all,
   * and stored as it was sent.
   *
   * Actor-scoped, because a suggestion is somebody's: the author is who
   * the thread mentions when an admin sends it back, and an id a client
   * sent would be a claim about whose suggestion this is rather than a
   * fact about who asked.
   */
  "suggestions:create": channel(
    z.object({
      /** The pipeline this changes, by the id both machines know it by. */
      pipelineId: z.string(),
      /** What the author's machine calls it, for the title on a record that may not hold it yet. */
      pipelineName: z.string(),
      /** The version the author's copy was based on. */
      basedOn: z.number().int().positive().nullable().default(null),
      /** The export document, as JSON text. */
      document: z.string(),
      ...ACTING_DEVICE,
    }),
    z.object({
      itemId: z.string().nullable().default(null),
      itemKey: z.string().nullable().default(null),
      problem: z.string().nullable().default(null),
    }),
  ),
  /**
   * What the admin reviewing a suggestion is shown (ARCHITECTURE.md, "Divergence and suggestions").
   *
   * Null for any item that is not a suggestion, rather than a refusal:
   * the item screen asks this about whatever it is showing, and an
   * error on every ordinary item would be an error that means "no".
   */
  "suggestions:detail": channel(z.object({ itemId: z.string() }), z.object({ suggestion: SuggestionViewSchema.nullable().default(null) })),

  // ── The record, as a device reaches it (EO-324, ARCHITECTURE.md, "The record") ───────
  //
  // Four channels, and they are the record half by definition: they
  // *are* the record. A desktop signed in to an organisation sends them
  // to its server; a solo desktop and the server itself never send them
  // at all, because in those two cases the record is in the same
  // process and `ItemRecord` is called directly. One code path, and
  // managed mode is a matter of where the record lives — which is the
  // sentence this whole phase exists to keep true.
  //
  // See `record.ts` in this package for the shapes and for why a
  // command, a question and a change are three different things.

  /**
   * What may be dispatched, and the claim that comes with it (the original design:
   * "the record owns item state and runs the only scheduler").
   *
   * A *question*, which is what makes it the pivot of this story. The
   * device's tick used to decide what to run; now it asks, and the
   * record answers with work it has already leased to this device. So a
   * desktop that cannot reach its record gets no work — not because it
   * is forbidden to schedule but because it has not been offered
   * anything, which is the honest shape of "offline means finish the
   * run you hold, never keep scheduling locally" (the original design).
   *
   * The lease is granted here rather than in a second round trip: a
   * pick that is not also a claim is a window in which two devices can
   * both be offered the same item.
   */
  "record:work": channel(
    z.object({
      deviceId: z.string().min(1),
      /** How many dispatches this device could start right now. The record may offer fewer; it never offers more. */
      capacity: z.number().int().nonnegative().default(1),
    }),
    z.object({ offers: z.array(RecordOfferSchema) }),
  ),
  /**
   * This device saying its claims still stand.
   *
   * Sent every tick with every claim it is working under, so that the
   * record's sweep can tell a device that is busy from one that is
   * gone. `held` is what it still has: anything the device sent and
   * does not get back was swept while it was away, and the device
   * forgets it rather than renewing its way out of its own expiry.
   *
   * `releaseOthers` is the same sentence said at boot instead of on a
   * tick: "these are the claims I am working under, and anything else
   * with my name on it is from a run of this process that is over".
   * One channel for both, because they are one question — what is this
   * device actually doing — and two would be two answers that could
   * disagree about a dispatch that started between them.
   */
  "record:renew": channel(
    z.object({
      deviceId: z.string().min(1),
      itemIds: z.array(z.string()),
      releaseOthers: z.boolean().default(false),
    }),
    z.object({ held: z.array(RecordLeaseSchema), released: z.array(RecordLeaseSchema) }),
  ),
  /** Giving a claim back, the moment the dispatch it covered is over. */
  "record:release": channel(
    z.object({ deviceId: z.string().min(1), itemId: z.string() }),
    z.object({ released: z.boolean() }),
  ),
  /**
   * The commands a device made, in the order it made them (ARCHITECTURE.md, "The record").
   *
   * Everything a device *did* arrives here: a move, a comment, a run
   * and the events it produced. Batched and ordered, because the queue
   * on the device is ordered and replaying it out of order would be a
   * different history; idempotent per command, because a reconnect that
   * raced an acknowledgement must not double anything.
   *
   * Every command gets its own result, and a refusal stops nothing: a
   * move the record will not apply is one command of a batch, and the
   * comment behind it is still something that was said.
   */
  "record:apply": channel(
    z.object({ deviceId: z.string().min(1), commands: z.array(RecordCommandSchema).max(200) }),
    z.object({ results: z.array(RecordCommandResultSchema) }),
  ),
  /**
   * What the record has that this device has not seen.
   *
   * The half that makes two desktops show one board. A push says only
   * "something changed, ask again" (`ipcPushContract`), so this is the
   * asking: items, the moves applied to them, and what was said on
   * them, since a cursor the device keeps.
   */
  /**
   * One attachment's bytes, coming down (EO-324, ARCHITECTURE.md, "The record").
   *
   * The pull half of the file transfer, and a channel of its own for
   * the reason the command going up is one: a file fills a request by
   * itself, so it cannot ride along with a page of comments. A replica
   * learns that a file exists when the comment carrying its metadata
   * arrives, and asks for the bytes afterwards — a few per pass, so a
   * desktop catching up on a week of attachments does it over several
   * ticks rather than in one long stall.
   *
   * `found` is false for an attachment the record has metadata for and
   * no file behind — a device that queued the comment, was updated, and
   * never sent the bytes. Said rather than thrown, because the caller's
   * answer is to stop asking rather than to retry.
   */
  "record:attachment": channel(
    z.object({ attachmentId: z.string() }),
    z.object({
      found: z.boolean(),
      name: z.string(),
      mimeType: z.string(),
      dataBase64: z.string().max(MAX_ATTACHMENT_BASE64_CHARS),
    }),
  ),
  /**
   * A project's whole history, on its way to the record (EO-325,
   * `ARCHITECTURE.md`, "What a person sees first", "Identity").
   *
   * What "move it to the record" is, in requests. A person who signed
   * in with work already on their board chooses, per project, to keep
   * it here or hand it over; handing it over sends the project, the
   * graph its items stand on, the jobs that fire into it, and then the
   * items, runs, transcripts, moves, thread and files, in pages, in
   * dependency order.
   *
   * Not a `record:apply` command, and `RecordAdoptPageSchema` says at
   * length why: history is rows, and replaying it as commands would
   * walk every item through its own past and tell the person their past
   * had been superseded.
   *
   * Answers with what it wrote, counted by table, because the story's
   * own acceptance criterion is a count comparison. A page that half
   * landed says which half, and the device treats that as a failed
   * move rather than a footnote to a successful one.
   *
   * **Whose the project becomes is not on this payload**, and its
   * absence is the point. It was `ownerId`, sent by the device, and a
   * signed-in machine could name any other person on the list and make
   * somebody else's colleague the owner of a project they had never
   * seen. The record derives the owner from the device token the door
   * already authenticated — a device belongs to a person (EO-323) —
   * which is the only fact in this request that a client cannot
   * choose. `project.ownerId` is ignored for the same reason.
   */
  /**
   * What one person has spent today, as the record counts it (EO-328,
   * ARCHITECTURE.md, "Policy", review).
   *
   * The design's budget is **per person**, and a person has more than one
   * machine. A device that answered from its own replica gave each of
   * Anna's two desktops the whole ceiling to itself — and a replica that
   * had not synced yet answered with a fraction of what had really been
   * spent and let work through on the strength of it. The record is the
   * only thing that can see every device's runs at once, so it is the
   * only thing that can answer this.
   *
   * A device asks it immediately before a dispatch, so the number is as
   * fresh as the round trip. A record that cannot be reached answers
   * nothing and the device falls back to its own replica, which is a
   * *lower* figure and therefore the permissive direction — the design's rule
   * that managed mode never stops a person from working, applied to a
   * ceiling rather than to a board.
   *
   * `since` is an instant rather than the word "today", because the day
   * is the *device's* local calendar day: two people in two time zones
   * turn over at different moments, and the record has no business
   * picking one of them.
   */
  "record:spend": channel(
    z.object({ personId: z.string(), since: z.number() }),
    z.object({ spentCents: z.number().int().nonnegative() }),
  ),
  /**
   * A module's run on this device asking the record to create a work
   * item (EO-433).
   *
   * **Asking, not telling.** A move and a comment are written to the
   * replica and queued, because they have already happened here. A
   * creation has not: the module is waiting for the new item's key, the
   * key comes from the project's counter, and whether this is a repeat
   * of an earlier creation is a fact only the record holds. So it is a
   * round trip, and a device that cannot make it is told nothing was
   * created — never handed a key the organisation's board has no item
   * behind.
   *
   * The record applies every guard the device's own parent process
   * would: the module must be one it holds, approved and declaring
   * `needs.create`; the device must hold the lease on the originating
   * item; and the type, the spec, the pipeline, the idempotency key,
   * the generation and the cap are checked in the transaction that
   * writes.
   *
   * `run` is the run the module is executing under, sent with the
   * request because `comments.run_id` is a foreign key and the note the
   * record leaves on the new item names it — the same prerequisite the
   * drain carries ahead of a comment.
   *
   * `atCap` is the device saying this run has already created its ten.
   * The record counts for itself as well; either is enough to refuse a
   * new item, and neither stops a repeat being answered.
   */
  "record:createItem": channel(
    z.object({
      deviceId: z.string().min(1),
      originItemId: z.string().min(1),
      moduleId: z.string().min(1),
      run: RecordRunCommandSchema,
      creation: ModuleCreationSchema,
      atCap: z.boolean().default(false),
    }),
    ModuleCreationAnswerSchema,
  ),
  /**
   * A project's thread, asked of the record that owns the project
   * (EO-471, ARCHITECTURE.md, "One channel").
   *
   * **Asking, not telling**, for `record:createItem`'s reason: the
   * thread is an item, its key is the record's to mint, and whether the
   * project already has one is a fact only the record holds — another
   * desktop may have made it a minute ago. The record answers the one
   * it has, or makes it; the device copies the answer into its replica
   * so it can post on it at once.
   *
   * No device id: opening a project's notes is something a person does,
   * and the door has already said who they are.
   */
  "record:projectThread": channel(
    z.object({ projectId: z.string().min(1) }),
    z.object({
      /** The thread, as the pull would carry it. Null when the record would not open one. */
      item: RecordItemSchema.nullable(),
      /** Why not. Null whenever `item` is not. */
      problem: z.string().nullable(),
    }),
  ),
  /**
   * A change to what an item waits for, asked of the record that owns
   * the item (EO-600, ARCHITECTURE.md, "One work entity", "The record").
   *
   * **Asking, not telling**, for `record:createItem`'s reason: the edges
   * of a project the organisation holds are the record's, and whether a
   * change is allowed — a cycle once it is merged into the graph, an
   * edge another desktop added a minute ago — is a question only the
   * whole graph can answer. So the record judges and writes the change,
   * whole or not at all, with its one comment, and answers with the item
   * and the comment as the pull would carry them; the device copies both
   * into its replica at once. A record that cannot be reached changes
   * nothing, and is not queued: the caller has been told nothing changed.
   *
   * Each of `add` and `remove` names an item by key or by id, as the
   * caller sent it; the record resolves them against its own rows.
   *
   * On a step that waits on a group only the person holding the item may
   * change it, and that is judged here, against the record's own item
   * and the person the asking device belongs to — a replica's idea of
   * who holds it may be a takeover behind.
   */
  "record:changeDependencies": channel(
    z.object({
      deviceId: z.string().min(1),
      itemId: z.string().min(1),
      add: z.array(z.string().min(1)).default([]),
      remove: z.array(z.string().min(1)).default([]),
      /** Why, where this is a reorder card a person approved in a conversation; the comment says it. */
      why: z.string().nullable().default(null),
    }),
    z.object({
      changed: z.boolean(),
      /** Why nothing was written. Null whenever `changed` is true. */
      problem: z.string().nullable(),
      /** The item as the pull would carry it, its edges included. Null when nothing changed. */
      item: RecordItemSchema.nullable(),
      /** The comment saying what changed and who asked, as the pull would carry it. */
      comment: RecordCommentCommandSchema.nullable(),
      /** What the change did, by key. Null when nothing changed. */
      dependencies: z
        .object({
          added: z.array(z.string()),
          removed: z.array(z.string()),
          stillWaitsFor: z.array(z.string()),
          freed: z.boolean(),
        })
        .nullable(),
    }),
  ),
  /**
   * The assistant chat about one held template update, asked of the
   * record that holds the conflict (EO-533, ARCHITECTURE.md, "Template
   * versions and origins").
   *
   * A pipeline the record holds is compared on the record, so its
   * conflict, and the notice in an admin's inbox, are the record's. The
   * chat is too: one item on the record, made by the first press and
   * handed back on every press after, from whichever desktop, so every
   * admin who presses Fix with assistant is shown the same chat. Its
   * first message is EO's brief, written by the record — the only one
   * holding the conflict and its three graphs.
   *
   * The brief asks nobody on the record. Every admin's desktop pulls a
   * copy, and mention dispatch is each machine's own, so a brief asking
   * an assistant would be answered once per desktop. Instead the record
   * hands the first turn to one device — the first to ask, and that
   * device again if it asks again — and says so in `firstTurn`; that
   * desktop asks its own assistant on its copy.
   *
   * `answeringDeviceId` is the asking device, where it has an assistant
   * to answer with; null where it has none, which only an existing chat
   * can be answered for and is never handed the turn. `commentId` is the
   * notice pressed, which places a chat for a pipeline no project
   * adopted.
   */
  "record:updateConflictChat": channel(
    z.object({ conflictId: z.string().min(1), answeringDeviceId: z.string().nullable(), commentId: z.string().nullable() }),
    z.object({
      /** The chat, as the pull would carry it. Null when the record would not open one. */
      item: RecordItemSchema.nullable(),
      /** Its first message, EO's brief, as the pull would carry it — so the desktop can dispatch the first turn before its next pull. */
      brief: RecordCommentCommandSchema.nullable(),
      /** True when this request made the chat, rather than finding the one an earlier press made. */
      started: z.boolean(),
      /** True when the brief's first turn is the asking device's to dispatch. True for one device only. */
      firstTurn: z.boolean(),
      /**
       * The pipeline the chat is about, which the desktop pins to the
       * brief as the board a draft is published against: that pin is the
       * chat's own state (`items.spec`), which the pull does not carry.
       */
      pipelineId: z.string().nullable(),
      /** Why not. Null whenever `item` is not. */
      problem: z.string().nullable(),
    }),
  ),
  /**
   * A held template update, read whole, asked of the record that holds
   * it (EO-534, ARCHITECTURE.md, "Template versions and origins").
   *
   * What `pipeline_update_conflict` answers on a desktop for a pipeline
   * the organisation's record holds: compared there, so the conflict and
   * its three graphs are there. The record answers exactly what a desktop
   * answers for one of its own (`pipeline:updateConflict`). Writes
   * nothing.
   */
  "record:updateConflict": channel(
    z.object({ pipelineId: z.string().min(1) }),
    UpdateConflictAnswerSchema,
  ),
  /**
   * A pipeline's template origin and update state, asked of the record
   * that holds the pipeline (EO-536): what a desktop answers for one of
   * its own (`pipeline:templateStatus`). Writes nothing.
   */
  "record:templateStatus": channel(z.object({ pipelineId: z.string().min(1) }), PipelineTemplateStatusSchema),
  /**
   * Resolves a held template update the record holds, asked by an
   * administrator's desktop (EO-534).
   *
   * `kept` keeps the record's pipeline as it is. `published` is a draft
   * published from the chat about the update: `graph` is that draft as
   * the desktop read it from its card, saved on the record through the
   * same `savePipeline` a publish anywhere goes through, so the record
   * judges it itself and every replica follows the record's graph as it
   * always does. Either way the record resolves the conflict, moves the
   * pipeline's base to the held version — with `templateStepIds` for any
   * template step the draft gave a fresh id — and closes the notice's
   * mentions on its own threads.
   *
   * What the record checks for itself (invariant 5): the asking device
   * belongs to one of its admins, the conflict is open and is this
   * pipeline's, and a `published` one names the chat the update's Fix
   * with assistant opened.
   */
  "record:resolveUpdateConflict": channel(
    z.object({
      deviceId: z.string().min(1),
      pipelineId: z.string().min(1),
      resolution: UpdateConflictResolutionSchema,
      /** The chat the draft was published from. Required for `published`. */
      chatId: z.string().nullable().default(null),
      /** The draft's graph, as `pipeline:save` takes it. Required for `published`, absent for `kept`. */
      graph: z
        .object({ steps: z.array(PipelineStepSaveSchema), routes: z.array(StepRouteViewSchema), entryStepId: z.string().nullable(), entryRules: EntryRulesSchema.optional() })
        .nullable()
        .default(null),
      templateStepIds: TemplateStepIdsSchema.default({}),
    }),
    z.object({
      resolved: z.boolean(),
      /** The template version the base moved to, once resolved. */
      toVersion: z.string().nullable(),
      /** The pipeline version the published draft was filed as, where one was. */
      version: z.number().int().positive().nullable().default(null),
      problem: z.string().nullable(),
    }),
  ),
  /**
   * A write to a project's memory, asked of the record that holds the
   * project (EO-482, ARCHITECTURE.md, "The record").
   *
   * **Asking, not telling**, for `record:createItem`'s reason: the memory
   * of a project the organisation holds is the organisation's, shared by
   * every desktop that works on it, and an entry written to one replica
   * would be an entry nobody else is ever given. So a run's note, a note
   * extraction drew out of a run, and a person's add, edit, retirement or
   * restore are each a round trip, and a desktop that cannot make one is
   * told nothing was written — never left holding an entry of its own.
   *
   * `run` is the run a note was written by, sent ahead of it as
   * `record:createItem` sends one: the entry names it as its source, and
   * `memories.source_run_id` is a foreign key. Null for a person's write.
   *
   * Answers with every row it changed, so the desktop that asked copies
   * them into its replica at once; every other desktop takes them on its
   * next pull.
   */
  "record:memory": channel(
    z.object({
      deviceId: z.string().min(1),
      write: RecordMemoryWriteSchema,
      run: RecordRunCommandSchema.nullable().default(null),
    }),
    RecordMemoryWriteAnswerSchema,
  ),
  /**
   * A scope's consolidations, as the record holds them (EO-482).
   *
   * Consolidation for a project the record holds runs where the record
   * schedules work, so its history is there and not in any replica.
   * Paged newest first (EO-545); a replica reads to the last page.
   */
  "record:memoryConsolidations": channel(RecordMemoryConsolidationsRequestSchema, RecordMemoryConsolidationsResponseSchema),
  /** Undoing one of those consolidations, on the record that made it (EO-482). */
  "record:restoreMemoryConsolidation": channel(
    z.object({ deviceId: z.string().min(1), consolidationId: z.string().min(1) }),
    RecordMemoryRestoreAnswerSchema,
  ),
  "record:adopt": channel(
    z.object({
      deviceId: z.string().min(1),
      project: RecordProjectSchema,
      /**
       * How far this project's key counter has got — the number the
       * last item took (`key_counters.next_value`, which is a column
       * whose name has always been one ahead of what it holds).
       *
       * Carried because `items.key` is unique and the record mints the
       * next one. A record whose counter for this prefix stood at zero
       * beside two hundred moved items would collide on `SUP-1` with
       * the first thing anybody filed, and the collision is a
       * unique-index error rather than anything a person could read.
       */
      keyNextValue: z.number().int().nonnegative().default(0),
      /**
       * Whether this is the request that ends the transfer (EO-325,
       * the review's second finding).
       *
       * A move is a paged conversation, and until this flag existed the
       * record made the project live on the first page: an organisation
       * could draw half a project and its scheduler could dispatch an
       * item whose thread and runs were still on somebody's laptop —
       * while that laptop's own scheduler still had the same item. Two
       * writers for one item, which is the one thing invariant #1
       * cannot survive.
       *
       * So the project arrives *adopting*: present enough for foreign
       * keys to resolve, absent from `record:changes`, and out of the
       * scheduler's input. This is the page that says everything has
       * arrived, and it is the only one that makes it live.
       */
      final: z.boolean().default(false),
      /**
       * Give up on a transfer that did not finish, and take the partial
       * project back off the record.
       *
       * The other half of the same finding. A move that failed left a
       * half-written project on the server, and the person who could
       * see the failure could not see or reach the thing it left
       * behind. Sent by the machine that started the transfer, for a
       * project it owns and that is still adopting — a live project is
       * never removed this way, and somebody else's never is at all.
       */
      abandon: z.boolean().default(false),
      page: RecordAdoptPageSchema,
    }),
    z.object({ accepted: RecordAdoptCountsSchema, problem: z.string().nullable().default(null) }),
  ),
  "record:changes": channel(
    z.object({
      /** Where this device has read up to in each list — see `RecordCursorsSchema`. */
      cursors: RecordCursorsSchema.default({
        items: { ts: 0, id: "" },
        transitions: { ts: 0, id: "" },
        comments: { ts: 0, id: "" },
        runs: { ts: 0, id: "" },
        runEvents: { ts: 0, runId: "", seq: -1 },
        attachments: { ts: 0, id: "" },
        attachmentRemovals: { ts: 0, id: "" },
        projects: { ts: 0, id: "" },
        itemTypes: { ts: 0, id: "" },
        pipelines: { ts: 0, id: "" },
        agents: { ts: 0, id: "" },
        publishedSections: { ts: 0, id: "" },
        pins: { ts: 0, id: "" },
        mentions: { ts: 0, id: "" },
        watches: { ts: 0, id: "" },
        memories: { ts: 0, id: "" },
        skills: { ts: 0, id: "" },
      }),
      limit: z.number().int().positive().max(1000).default(500),
      /**
       * One project's history rather than the whole record (EO-325).
       *
       * A moved project arrives carrying its own dates, and a desktop
       * that had been syncing an active record for a month has cursors
       * far past them: it is handed the project row and never asks for
       * a single item behind it, because every list here pages strictly
       * forwards on when its rows were written. Restamping the history
       * would be a lie about when the work happened, so the desktop
       * asks again instead — same channel, same keyset, scoped to the
       * project, on a set of cursors kept per project and starting at
       * the beginning.
       *
       * Null is the ordinary pull: everything this device can see.
       */
      within: z.string().nullable().default(null),
    }),
    RecordChangesSchema,
  ),

  // ── Memory (EO-478) ─────────────────────────────────────────────
  /**
   * A scope's entries: the active ones, and with `includeRetired` the
   * history behind them. Record-half because a project's memory belongs
   * to the project, which is the record's.
   */
  "memory:list": channel(MemoryListRequestSchema, MemoryListResponseSchema),
  /**
   * Entries across every scope this database holds, filtered and, with a
   * query, found by approximate text search and ranked by bm25 (EO-545)
   * — `memories_search`'s channel. Read here, as `memory:list` is: a
   * desktop's sync keeps its copy of a moved project's memory level with
   * the record.
   */
  "memory:search": channel(MemorySearchRequestSchema, MemorySearchResponseSchema),
  /**
   * One entry in full, with the versions it replaced through edits and
   * the consolidations that wrote or retired it (EO-545) — `memory_get`'s
   * channel. The consolidations from the record that ran them.
   */
  "memory:get": channel(MemoryGetRequestSchema, MemoryGetResponseSchema),
  /** A person's entry. It takes effect on the next dispatch. */
  "memory:add": channel(MemoryAddRequestSchema, MemoryWriteResultSchema),
  /**
   * A new version of an entry. The old row is retired as `edited` and a
   * new one is written in its scope, so what it said before is kept.
   * Answers with the new row.
   */
  "memory:edit": channel(MemoryEditRequestSchema, MemoryWriteResultSchema),
  /** Takes an entry out of delivery. Nothing is deleted; `memory:restore` brings it back. */
  "memory:retire": channel(MemoryEntryRequestSchema, MemoryWriteResultSchema),
  /** Puts a retired entry back into delivery, whatever retired it. */
  "memory:restore": channel(MemoryEntryRequestSchema, MemoryWriteResultSchema),
  /**
   * A scope's consolidations, newest first, each with what it retired and
   * wrote (EO-480) and those counted, with whether it was restored
   * (EO-545) — `memory_consolidations_list`'s channel too.
   */
  "memory:consolidations": channel(MemoryConsolidationsRequestSchema, MemoryConsolidationsResponseSchema),
  /**
   * A person asking for one scope to be consolidated now (EO-589): queued
   * with the trigger `manual`, skipping the due rule and the backoff, and
   * kept to everything else — one per scope, one at a time, only while the
   * pipeline is idle, never while the engine is paused. Answers with what
   * happened, in a sentence and typed — `memory_consolidate_now`'s channel.
   */
  "memory:consolidateNow": channel(MemoryConsolidateNowRequestSchema, MemoryConsolidateNowResultSchema),
  /**
   * Puts back the set from before one consolidation, in one action
   * (EO-480): the entries it retired are active again and the ones it
   * wrote are retired. Nothing is deleted either way.
   */
  "memory:restoreConsolidation": channel(MemoryRestoreConsolidationRequestSchema, MemoryRestoreConsolidationResultSchema),
} as const;

/**
 * What pressing Reveal on a personal secret is answered with (EO-489,
 * ARCHITECTURE.md §14.2).
 *
 * Four answers rather than a nullable string, because three of them are
 * not "no value" in the same sense and a screen has to say which:
 *
 * - `value` — the stored value of *this* scope or server, decrypted.
 * - `unreadable` — something is stored and this machine can no longer
 *   decrypt it (another machine's keychain, a keychain reset). Drawn as
 *   a sentence saying so, never as an empty value.
 * - `reference` — the scope holds a reference to one of EO's own
 *   environment variables. A reference is never revealed: its variable's
 *   name is already on screen, and what that variable holds is the
 *   environment's, not a value EO stored.
 * - `absent` — nothing is stored there, including a step or a server
 *   that no longer exists.
 *
 * Only ever the *personal* store. An organisation's value is never read
 * to answer this, so a name that has both is answered with the person's
 * own — which is what `ipcLeak.test.ts` asserts.
 */
export const RevealedSecretSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("value"), value: z.string() }),
  z.object({ state: z.literal("unreadable") }),
  z.object({ state: z.literal("reference") }),
  z.object({ state: z.literal("absent") }),
]);
export type RevealedSecret = z.infer<typeof RevealedSecretSchema>;

/**
 * The machine half — see the note above `recordContract`.
 *
 * What these channels have in common is that a person has to be at
 * the machine for the answer to mean anything: a picker needs somebody
 * to click, `view:current` describes a window, `canvas:*` and
 * `debug:window` open one, `runtime:*` reports what is installed on this disk,
 * `updates:install` restarts this process. The MCP catalogue's hand-kept exclusion list used to
 * describe roughly this set; catalog.test.ts now types its remaining
 * list over `RecordChannel` so a machine channel cannot be written into
 * it at all.
 */
export const machineContract = {
  // ── This machine's sign-in (EO-323, ARCHITECTURE.md, "Identity") ──────────────────
  //
  // The machine half, and unmistakably so: the address and the email are
  // a preference of *this installation*, the token they earn is in this
  // machine's keychain, and neither means anything asked of a server —
  // which is a record and does not sign in to itself. The list they
  // reach is the record half's `people:*`.

  /**
   * Where this desktop stands: signed in, signed out, or turned out.
   *
   * `signedOutBy` is the third state and the reason this channel is not
   * a boolean. A device whose token was revoked is not the same as one
   * that never signed in: the person did nothing, their organisation
   * did, and EO says so in those words rather than quietly showing an
   * empty sign-in form.
   */
  "session:status": channel(z.void(), SessionStatusSchema),
  /**
   * This machine's link to its organisation's record (EO-324, ARCHITECTURE.md, "The record").
   *
   * On the machine half beside `session:status` and for the same
   * reason: a server *is* the record, so asking it how it is getting on
   * with the record is a question about nothing, and the browser an
   * admin opens it in would be shown a line about an outage it cannot
   * be having. The typed `machine-only` refusal is what the renderer
   * branches on to draw nothing at all there.
   *
   * What a screen does with it is one line and one card treatment:
   * "offline since 09:12" above the board, and a dashed card marked
   * *queued* for every item with a move still waiting to be replayed.
   */
  "sync:status": channel(z.void(), SyncStatusSchema),
  /**
   * Signs this machine in to an organisation server.
   *
   * Refuses a plain-http address that is not loopback before it sends
   * anything, with the one line `serverAddressProblem` writes: a
   * password and a device token crossing a network in the clear is not
   * something to warn about after the fact. `problem` is that sentence,
   * or the server's own.
   */
  "session:signIn": channel(
    z.object({ address: z.string().min(1).max(2000), email: z.string().min(1).max(320), password: z.string().min(1).max(1024) }),
    z.object({ status: SessionStatusSchema, problem: z.string().nullable() }),
  ),
  /**
   * Signs out, here.
   *
   * The token is forgotten by this machine and stays in the admin's list
   * until they revoke it — because this end cannot prove to the server
   * that it is the one giving it up, and a channel that let it would be
   * a way for anybody holding a stolen token to erase the row that names
   * the machine it was stolen from.
   */
  "session:signOut": channel(z.void(), z.object({ status: SessionStatusSchema })),

  // ── Keep it here, or move it to the record (EO-325, ARCHITECTURE.md, "What a person sees first")
  // ────
  //
  // The machine half, and for once unarguably so: what these do is
  // decide whether *this installation's* existing work is handed to an
  // organisation. The record has no opinion to offer about that — it is
  // the person's, on the machine the work is on — and the upload the
  // move performs is `record:adopt`, which is the record half and is
  // sent from here.

  /**
   * The projects the keep-or-move sheet has still to ask about.
   *
   * Empty on a solo desktop, which is what closes the sheet: it opens
   * on a list and an empty list is nothing to open. Empty again once
   * every project has an answer, so the sheet is stateless — there is
   * no "have I shown this yet" flag to get out of step with the rows it
   * would be about.
   *
   * `line` is the sentence that stands above the list, so that the
   * default reads as a promise rather than as a pre-ticked box.
   */
  "projects:undecided": channel(z.void(), z.object({ projects: z.array(ProjectViewSchema), line: z.string() })),
  /**
   * "Keep this one here."
   *
   * The sheet's default and, on a project the record already has, a
   * refusal: there is no way back in this version and `problem` says
   * so in `MOVE_IS_ONE_WAY_LINE`'s own terms.
   */
  "projects:keepLocal": channel(
    z.object({ projectId: z.string() }),
    z.object({ project: ProjectViewSchema.nullable(), problem: z.string().nullable() }),
  ),
  /**
   * "Move this one to the record."
   *
   * Sends the project's whole history over `record:adopt` — its rows,
   * its graphs, its jobs and its files — and only when the record has
   * accounted for every one of them rewrites what named the implicit
   * local person and marks the project as the record's. In that order,
   * because a project marked before its rows landed is one whose next
   * comment reaches a server that has never heard of the item it is
   * about, and because a project *rewritten* before they landed is one
   * whose identity references have changed while it is still the
   * person's.
   *
   * **All of it or none of it.** A row the record could not take, or
   * took fewer of than it was sent, ends the move with the project
   * untouched: still local, still undecided, still on the sheet, and
   * safe to try again — the transfer is idempotent by primary key. The
   * alternative, which this replaced, was a move that reported success
   * with three of its items missing and handed the person a sentence
   * about it and no way to act on one.
   *
   * Refused while this machine cannot reach its record. A move is not a
   * queued command and deliberately so: it is a long, ordered
   * conversation about thousands of rows, and "it will go up when you
   * are next online" is a promise about somebody's whole project that
   * EO would have no way to keep if the person quit the app.
   *
   * `moved` is what the record took, counted by table, so the count
   * comparison the story asks for is something a caller is handed
   * rather than something it has to go and take. It is only ever
   * present on a move that took everything.
   */
  "projects:moveToRecord": channel(
    z.object({ projectId: z.string() }),
    z.object({
      project: ProjectViewSchema.nullable(),
      moved: RecordAdoptCountsSchema.nullable().default(null),
      problem: z.string().nullable(),
    }),
  ),

  /**
   * The `oauth` setup kind on a connector (EO-315,
   * ARCHITECTURE.md, "A connector is an MCP server with a setup flow"): EO opens the provider's URL
   * in the
   * person's browser and receives the callback on a loopback listener it
   * started for the purpose.
   *
   * The machine half, and on `runtime:startSignIn`'s exact grounds: a
   * person has to be at this machine for any of it to mean anything —
   * there is a browser window to look at and a consent screen to press.
   * The three connector channels it belongs with are in the record half
   * above, because listing what is connected and storing what somebody
   * pasted are answered from the record and the keychain.
   *
   * One call that resolves when the round trip is over, rather than a
   * start and a poll. The renderer has a button that is busy until it is
   * done, which is exactly what an awaited call is; a second channel to
   * ask "is it finished yet" would be state in two places. It refuses
   * rather than hanging — the listener times out after five minutes and
   * comes back with a sentence, which is invariant 9's rule one level
   * down from a run.
   */
  "connectors:connectOAuth": channel(
    z.object({ serverId: z.string() }),
    z.object({ connected: z.boolean(), problem: z.string().nullable() }),
  ),
  /**
   * Updating EO (EO-201).
   *
   * Four channels rather than one `updateAndRestart`, so that a download
   * which fails cannot go on to restart the app, and so each half is
   * separately testable. The Updates section sequences them behind its
   * one button.
   *
   * Every one of them answers with the same `UpdateStatus`, validated on
   * the way through like everything else crossing this boundary — the
   * renderer never assembles a state out of what a call happened to
   * return.
   */
  "updates:status": channel(z.void(), UpdateStatusSchema),
  "updates:check": channel(z.void(), UpdateStatusSchema),
  "updates:download": channel(z.void(), UpdateStatusSchema),
  /**
   * Ask to restart into a staged update. `requested` is false when there
   * is nothing staged; when it is true the shutdown coordinator has been
   * asked and owns what happens next, which may well be a dialog and a
   * drain rather than an immediate exit.
   */
  "updates:install": channel(z.void(), z.object({ requested: z.boolean() })),
  /**
   * Open the GitHub release page of the available version in the
   * person's browser — the macOS path, where EO cannot install (EO-698).
   *
   * Takes nothing on purpose. The URL is built in the main process from
   * the repository EO publishes to and the version its own status names,
   * so this channel cannot be used to open an arbitrary link. `opened`
   * is false when no version is available to open a page for.
   */
  "updates:openReleasePage": channel(z.void(), z.object({ opened: z.boolean() })),
  /**
   * Native directory picker. A renderer cannot open one — it has no
   * filesystem access by design (F-02) — so choosing a repository has to
   * come back through here. `null` means the user cancelled.
   */
  "dialog:pickDirectory": channel(
    z.object({ title: z.string().optional() }),
    z.object({ path: z.string().nullable() }),
  ),

  /**
   * Stages picker files in EO storage; only opaque IDs cross back into later submissions.
   *
   * `omitted` counts the chosen files that were *not* staged because one
   * message may carry at most eight. The renderer cannot work this out
   * for itself — the native dialog belongs to main, so a person who
   * selected twelve files would otherwise be handed eight drafts and told
   * nothing about the other four (EO-194).
   */
  "attachments:pick": channel(
    z.void(),
    z.object({
      attachments: z.array(AttachmentDraftSchema),
      omitted: z.number().int().min(0),
      /**
       * Why nothing was staged, when a chosen file could not be — over
       * 20 MB, not a file, unreadable (EO-702). Answered rather than
       * thrown, because a packaged build turns a thrown sentence into
       * "Internal error" and the person never learns which file it was.
       */
      problem: z.string().nullable().default(null),
    }),
  ),
  /**
   * Hand one to the machine, or take one off it.
   *
   * The other five attachment channels are in the record half: staging,
   * discarding, previewing and deleting are all about the row. These two
   * are a viewer launching on somebody's desktop and a save dialog they
   * have to answer.
   */
  "attachments:open": channel(z.object({ attachmentId: z.string() }), z.object({ opened: z.boolean(), problem: z.string().nullable() })),
  "attachments:save": channel(z.object({ attachmentId: z.string() }), z.object({ saved: z.boolean(), problem: z.string().nullable() })),

  /**
   * Saves what the item has produced as a file of the person's choosing
   * (EO-311, ARCHITECTURE.md, "The item").
   *
   * The Export half of the pair on the output editor — Copy is the
   * renderer's own, because the clipboard is a thing a window has and
   * the main process does not. This one needs the main process twice
   * over: a renderer has no file dialog and no filesystem, by design
   * (F-02), so both the asking and the writing happen there.
   *
   * Only the *text* of an output. An output that carries a file carries
   * it as an attachment, and `attachments:save` is already the way a
   * person saves one of those — a second path to the same bytes would be
   * a second set of failures to keep in step.
   *
   * Takes the item rather than the comment: which output is current is
   * derived and not a caller's to name, exactly as `items:setOutput`
   * refuses a `parentId`.
   */
  "items:exportOutput": channel(
    z.object({ itemId: z.string() }),
    z.object({
      /** False both for a refusal and for a person who closed the dialog — `problem` tells them apart. */
      saved: z.boolean(),
      /** Where it went, so the screen can say so. */
      path: z.string().nullable(),
      /** Why nothing was written, when something should have been. Null when the person simply cancelled. */
      problem: z.string().nullable(),
    }),
  ),

  // ── The canvas's own window (EO-383) ────────────────────────────
  //
  // The machine half without argument: every one of these is about a
  // window on *this* desktop, and a browser tab has no way to be given
  // one. A served page sends none of them — the canvas there has no
  // "Pop out" to press.
  /**
   * "Pop the canvas out": open it in a window of its own, with these
   * tabs and this one open.
   *
   * `opened` is false where the platform has no windows to open, and
   * the canvas then stays where it was.
   */
  "canvas:window": channel(CanvasTabsSchema, z.object({ opened: z.boolean() })),
  /**
   * Open an address as a tab in the popped-out canvas.
   *
   * What the main window sends instead of drawing a view itself while
   * the canvas is out — an item's link in a message, a board in the
   * sidebar. `opened` is false when there is no canvas window after
   * all, and the sender draws the view itself.
   */
  "canvas:open": channel(z.object({ path: CanvasPathSchema }), z.object({ opened: z.boolean() })),
  /**
   * Close the popped-out canvas.
   *
   * With `restore`, this is "Pop in": the main window is handed these
   * tabs back and opens the one named. With null it is "Close the
   * canvas", and the main window stays on the conversation alone —
   * which is also what the window's own close button does, with no
   * channel involved at all.
   */
  "canvas:close": channel(z.object({ restore: CanvasTabsSchema.nullable() }), z.object({ closed: z.boolean() })),
  /**
   * Hand the person from the popped-out canvas to the conversation
   * (EO-408): the main window comes forward and its composer takes the
   * cursor.
   *
   * What a view's "ask the assistant" control does when the canvas is in
   * its own window, where there is no conversation to open. `handed` is
   * false when there is no canvas window to have asked from.
   */
  "canvas:ask": channel(z.void(), z.object({ handed: z.boolean() })),
  /**
   * Whether the canvas is popped out, and what its window opens with.
   *
   * Asked by a window when it loads: the main window to know whether
   * views open here or over there, and the canvas window for the tabs
   * it was popped out with — it is a fresh renderer and holds nothing.
   */
  "canvas:state": channel(
    z.void(),
    z.object({ poppedOut: z.boolean(), tabs: z.array(CanvasPathSchema), active: CanvasPathSchema.nullable() }),
  ),

  // ── Debug mode (EO-392) ──────────────────────────────────────────
  //
  // The machine half, all four. Debug mode is an instrument on *this*
  // desktop: what it records is what this machine hands the backends it
  // runs, and what it shows is a window on this screen. A served page
  // sends none of them, and a step-owning agent is offered none of them
  // as a tool — the window is read-only and so is everything here but
  // the switch itself, which is a person's to press.
  /**
   * Whether debug mode is on. Off until somebody turns it on.
   *
   * Its own settings key rather than a field on `settings:get`, for the
   * reason `ASSIST_EXPIRY_DAYS_KEY` gives: that object is written whole
   * by whichever screen shows part of it.
   */
  "debug:getMode": channel(z.void(), z.object({ enabled: z.boolean() })),
  /**
   * Turns debug mode on or off, and answers with what is stored.
   *
   * Read where it is used, so it applies to the next dispatch rather
   * than to the next launch. Turning it off stops recording and removes
   * nothing: `run_events` is append-only.
   */
  "debug:setMode": channel(z.object({ enabled: z.boolean() }), z.object({ enabled: z.boolean() })),
  /**
   * Opens the debug window, or focuses the one already open.
   *
   * `opened` is false while debug mode is off — F12 then does what it
   * has always done, which is nothing of EO's — and where the platform
   * has no windows to open.
   */
  "debug:window": channel(z.void(), z.object({ opened: z.boolean() })),
  /**
   * The window's tabs: every agent with a run in the project the board
   * is showing, each with its runs newest first.
   *
   * Agents with a run in flight come first, then the rest by their most
   * recent run. The system agent is one of them — its conversations are
   * items in the project like any other.
   *
   * A read. What was sent on a run, and what the agent is doing, come
   * from `runs:listEvents`, the same log the run transcript pages.
   */
  "debug:runs": channel(z.void(), z.object({ agents: z.array(DebugAgentSchema) })),

  // ── The main window's own title bar (EO-668) ───────────────────
  //
  // The machine half, both. The main window draws no native title bar:
  // its own top row is the title bar, with the system's window controls
  // drawn over it — the window's business on this desktop, and a browser
  // tab served the same renderer has no title bar to hide.
  /**
   * The main window as its top row needs to know it: whether it is full
   * screen, where there are no window controls to leave room for and no
   * window to drag.
   *
   * Asked when the renderer loads, and again on `window:changed`.
   */
  "window:state": channel(z.void(), z.object({ fullScreen: z.boolean() })),
  /**
   * The colours of the window controls Electron draws over the main
   * window's top row on Windows and Linux (`setTitleBarOverlay`): the
   * background they are drawn on and their symbols, as `#rrggbb` because
   * that is what Electron reads.
   *
   * Sent whenever the chat theme or what is under the controls changes.
   * `applied` is false where there is no overlay to colour — macOS,
   * whose traffic lights are the system's own; no main window; a host
   * with no screen.
   */
  "window:titleBar": channel(
    z.object({ color: z.string().regex(/^#[0-9a-f]{6}$/i), symbolColor: z.string().regex(/^#[0-9a-f]{6}$/i) }),
    z.object({ applied: z.boolean() }),
  ),

  // ── The current view (EO-192) ───────────────────────────────────
  /**
   * The renderer saying what is on screen.
   *
   * Sent on navigation and whenever the view parameters change, and
   * *replacing* what was there — there is one current view, held in
   * memory in the main process, and nothing about it is persisted. A
   * table would invite reading a screen back after it stopped being
   * true, which is precisely the failure the tool this feeds exists to
   * end.
   *
   * The payload is identifiers and view parameters and can hold nothing
   * else; see `ViewSnapshotSchema` for why that is the whole design.
   */
  "view:publish": channel(ViewSnapshotSchema, z.object({ published: z.boolean() })),
  /**
   * What is on screen right now, resolved.
   *
   * The read half, and the one an agent reaches through
   * `mcp__eo_admin__view_current`. Answered from the latest publish plus
   * a fresh look at the database, so calling it twice across a
   * navigation answers about two different screens with no dispatch in
   * between — which is the whole point of a tool where EO-189 had a
   * preloaded section.
   *
   * `{ view: null, absence: "…" }` where there is nothing honest to
   * describe. Never a throw: a person who wandered onto an unlisted
   * screen should cost the answer to "what am I looking at", not the
   * question they actually asked.
   */
  "view:current": channel(z.void(), CurrentViewResultSchema),

  // ── EO's MCP server, the two controls that reach this machine ───
  //
  // Its other three — status, config, token — are in the record half:
  // what they read and write is a settings row. These two run other
  // clients' CLIs on this desktop and write EO into configuration files
  // on it, which is what puts them here.
  /**
   * Which MCP clients are on this machine, and whether EO is in them.
   *
   * Runs their own `mcp list`, so it is a few subprocesses rather than a
   * file read, and is asked for on demand rather than polled.
   */
  "mcp:detectClients": channel(
    z.void(),
    z.object({
      clients: z.array(McpClientSchema),
      /**
       * Which of them are still calling `ticket_*`, and what to call
       * instead (KAN-178).
       *
       * Beside the clients rather than inside one, because the two lists
       * are about different things: a client is something EO found on
       * this machine, and this is something EO was *called* by. They
       * overlap and neither contains the other — an editor can be
       * installed and never have connected, and something EO cannot
       * detect at all can be calling `ticket_get` every minute.
       */
      oldNameUse: z.array(McpAliasUseSchema).default([]),
    }),
  ),
  /**
   * Registers EO with one client, through whatever that client provides.
   *
   * Per client rather than "add to everything", because each one can
   * fail or carry a caveat on its own and a single button reporting one
   * combined outcome would have to flatten that.
   */
  "mcp:registerWith": channel(
    z.object({ id: McpClientSchema.shape.id }),
    z.object({ client: McpClientSchema }),
  ),

  // G-03: what the worktrees are costing, and a way to let one go by
  // hand. Listing walks every checkout on disk, so it is a query the UI
  // asks for deliberately rather than something folded into a project load.
  "worktrees:list": channel(
    // Null means every repository — the listing is per repository in the UI,
    // but cleanup and diagnostics want all of them (D-04).
    z.object({ repositoryId: z.string().nullable() }),
    z.object({ worktrees: z.array(HeldWorktreeSchema), problem: z.string().nullable() }),
  ),
  "worktrees:release": channel(
    z.object({
      itemKey: z.string().min(1),
      /** Falls back to this when the item itself is gone but its worktree isn't. */
      repositoryId: z.string().nullable().default(null),
      /** Discards uncommitted work — only ever set from an explicit second confirmation. */
      force: z.boolean().default(false),
    }),
    z.object({ released: z.boolean(), reason: z.string().nullable() }),
  ),

  // EO-477: the small model each backend's side calls run on. Read with
  // its default, which for Codex is the smallest model the runtime
  // reports — so this one may spawn the CLI, and is asked when the
  // Runtimes tab opens rather than on every render.
  "sideCalls:smallModels": channel(z.void(), z.object({ backends: z.array(SmallModelViewSchema) })),
  /** Null goes back to the default. */
  "sideCalls:setSmallModel": channel(
    z.object({ backend: z.string(), model: z.string().trim().min(1).nullable() }),
    z.object({ ok: z.boolean(), problem: z.string().nullable() }),
  ),

  /**
   * The agent CLIs EO fetches rather than ships (A-08).
   *
   * `status` is local and cheap — it looks on disk. `describe` asks the
   * npm registry how big the download is and where it comes from, which
   * is what the consent dialog needs and the only reason it is a
   * separate channel: nobody should pay for a network round trip just to
   * render a settings screen.
   */
  "runtime:status": channel(
    z.object({
      provider: z.string(),
      /**
       * The agent's own `executablePath`, when the caller is asking on
       * behalf of one (EO-82).
       *
       * Whether a runtime is signed in is a fact about a *binary*, and
       * an agent pointed at its own copy resolves a different one from
       * EO's managed cache. Omitted, the answer describes the managed
       * copy — which is what the Runtimes tab is about, and what
       * dispatch would run for every agent that has set nothing.
       */
      executablePath: z.string().nullable().optional(),
    }),
    // Null for a backend that runs no CLI of its own, like `fake`.
    z.object({ runtime: RuntimeStatusSchema.nullable() }),
  ),
  "runtime:describe": channel(
    z.object({ provider: z.string() }),
    z.object({
      packageName: z.string().nullable(),
      packageVersion: z.string().nullable(),
      /**
       * How much lands on disk, as the registry reports it — not the
       * size of the transfer, which is gzipped and smaller. Named for
       * what it is: a "Size" under a Download button reads as the
       * download, and overstating that is the wrong way to be wrong.
       */
      unpackedBytes: z.number(),
      sourceUrl: z.string().nullable(),
      problem: z.string().nullable(),
    }),
  ),
  /** Only ever called after the user has read `describe` and agreed. */
  "runtime:install": channel(
    z.object({ provider: z.string() }),
    z.object({ ok: z.boolean(), runtime: RuntimeStatusSchema.nullable(), problem: z.string().nullable() }),
  ),
  "runtime:setAutomaticUpdates": channel(
    z.object({ provider: z.enum(["codex", "claude"]), enabled: z.boolean() }),
    z.object({ ok: z.boolean(), runtime: RuntimeStatusSchema.nullable(), problem: z.string().nullable() }),
  ),
  "runtime:setEnabled": channel(
    z.object({ provider: z.enum(["codex", "claude"]), enabled: z.boolean() }),
    z.object({ ok: z.boolean(), runtime: RuntimeStatusSchema.nullable(), problem: z.string().nullable() }),
  ),
  /**
   * Deletes EO's managed copy, having asked first.
   *
   * The counterpart to `runtime:install`, and destructive in a way
   * `runtime:setEnabled` is not: it revokes the download consent and
   * removes the directories EO unpacked. The guards the renderer shows
   * are re-checked here, because a confirmation dialog can sit open
   * while the machine stops being idle underneath it.
   */
  "runtime:remove": channel(
    z.object({ provider: z.enum(["codex", "claude"]) }),
    z.object({ ok: z.boolean(), runtime: RuntimeStatusSchema.nullable(), problem: z.string().nullable() }),
  ),

  /**
   * Signing a runtime in without a terminal (EO-83).
   *
   * Three channels rather than one, because a sign-in is not a request
   * and a response: EO spawns the CLI's own `login`, and the child then
   * sits there — printing a URL, waiting on a browser, and in Claude's
   * case waiting on stdin — until somebody finishes or abandons it. So
   * the flow is a session: `startSignIn` begins it and reports what the
   * dialog has to show, `submitSignInCode` hands the child what remains
   * and waits for it to exit, and `cancelSignIn` kills it.
   *
   * Both providers' children finish by themselves: the browser returns
   * to the child's own localhost listener, so the dialog's first submit
   * call carries no code and is purely "tell me when it is done". Claude
   * additionally prints a fallback page that displays an authorization
   * code, which goes browser → person → EO → the child's stdin in a
   * second submit call (EO-665). Codex's code never touches EO. EO
   * writes nothing into `~/.claude` or `~/.codex` either way.
   */
  "runtime:startSignIn": channel(
    z.object({
      provider: z.enum(["codex", "claude"]),
      /** The agent's own executable, when the caller is asking on behalf of one — resolved exactly as `runtime:status` does. */
      executablePath: z.string().nullable().optional(),
      /**
       * `browser` is the default for both providers, and for Codex it is
       * a deliberate choice: a desktop app has a browser, so plain
       * `codex login` with the child's own listener is the flow.
       * `device` is `codex login --device-auth`, the explicit "the
       * browser did not open" fallback — it prints a one-time code the
       * user types into the page, the opposite direction from Claude's.
       * `console` is `claude auth login --console`, the Anthropic
       * Console flow (EO-84): the same shape as the subscription login,
       * billed to an API account rather than a
       * subscription, and Claude's only one — Codex answers an API key
       * with `--with-api-key` instead, which is `runtime:signInWithApiKey`.
       */
      mode: z.enum(["browser", "device", "console"]).default("browser"),
    }),
    z.object({
      ok: z.boolean(),
      /** What `submitSignInCode` and `cancelSignIn` address. Null when the flow never started. */
      sessionId: z.string().nullable(),
      /** The OAuth URL the CLI printed. Shown with a copy button, because `openExternal` can fail silently. */
      url: z.string().nullable(),
      /** The one-time code the *page* asks for (`codex login --device-auth`). Null for every other flow. */
      verificationCode: z.string().nullable(),
      /**
       * Whether the child also takes a code on stdin. True for Claude, whose printed URL is a fallback page that
       * displays one; false for both Codex paths. Never a reason to stop waiting — every flow finishes by itself.
       */
      needsCode: z.boolean(),
      /** Whether the CLI opens the sign-in page itself, so `url` is only its fallback and EO did not open it. True for Claude. */
      cliOpensBrowser: z.boolean(),
      /** Whether EO had the OS open the URL. False is not a failure — the URL is on screen and copyable. */
      opened: z.boolean(),
      /** What the CLI printed, verbatim. The only honest thing to show when EO could not make sense of it. */
      transcript: z.string(),
      problem: z.string().nullable(),
    }),
  ),
  /**
   * Hands the child what remains, if anything, and waits for it to exit.
   *
   * `code` is the authorization code Claude's fallback page displayed.
   * Null is the ordinary call for every flow: it carries nothing and
   * exists only to wait, because the child finishes the exchange itself
   * and the dialog has to keep showing the URL while it does.
   */
  "runtime:submitSignInCode": channel(
    z.object({ sessionId: z.string().min(1), code: z.string().nullable().default(null) }),
    z.object({
      ok: z.boolean(),
      /** `cancelled` is distinct from `failed` on purpose: a killed child must not read as a sign-in that went wrong. */
      state: z.enum(["signed_in", "failed", "cancelled"]),
      transcript: z.string(),
      problem: z.string().nullable(),
    }),
  ),
  /** Kills the child. False means there was nothing running under that id — it had already finished or been cancelled. */
  "runtime:cancelSignIn": channel(z.object({ sessionId: z.string().min(1) }), z.object({ cancelled: z.boolean() })),

  /**
   * The other way in: a key rather than a subscription (EO-84).
   *
   * One call rather than a session, because neither provider's API-key
   * path has a browser half to wait on. What differs is who ends up
   * holding the secret, and the two answers are genuinely different:
   *
   * - **Codex** has a first-class flag. The key is piped to
   *   `codex login --with-api-key` on stdin and the CLI stores it in
   *   its own `auth.json`. EO holds nothing afterwards and writes
   *   nothing down.
   * - **Claude** has no such flag: it reads `ANTHROPIC_API_KEY` from
   *   the environment. So a key typed into EO is stored with
   *   `safeStorage` beside the Jira tokens and injected when the Claude
   *   provider spawns. That is the only place EO holds a billable
   *   secret, and it is deliberate.
   *
   * The key travels one way. Nothing in the response carries it back,
   * and nothing on either side of this channel writes it to the
   * database, to `run_events`, to a comment or to a log line — the
   * transcript is scrubbed of it before it is returned, in case a CLI
   * ever echoes what it was handed.
   */
  "runtime:signInWithApiKey": channel(
    z.object({
      provider: z.enum(["codex", "claude"]),
      /** The agent's own executable, when the caller is asking on behalf of one — resolved exactly as `runtime:status` does. */
      executablePath: z.string().nullable().optional(),
      apiKey: z.string().min(1),
    }),
    z.object({
      ok: z.boolean(),
      /** Where the key ended up: the CLI's own store, or EO's keychain. Null when nothing was stored. */
      heldBy: z.enum(["cli", "eo"]).nullable(),
      /** What the CLI printed, with any occurrence of the key removed. Empty for the path that spawns nothing. */
      transcript: z.string(),
      problem: z.string().nullable(),
    }),
  ),
  /**
   * Forgets a key EO stored.
   *
   * Only ever EO's own: a Codex key belongs to the Codex CLI from the
   * moment it is piped in, and reaching into another product's
   * credential store to delete it is the thing the pinned decision on
   * abandoned sign-ins already refused to do. `removed` is false when
   * there was nothing to forget, which is not a failure.
   */
  "runtime:removeApiKey": channel(
    z.object({ provider: z.enum(["codex", "claude"]) }),
    z.object({ ok: z.boolean(), removed: z.boolean(), problem: z.string().nullable() }),
  ),

  // ── Where a job runs (EO-330, ARCHITECTURE.md, "Where a job runs")
  // ──────────────────────────────

  /**
   * Where this job may run, and why it may not run in the other place.
   *
   * **On the machine half, and that is the whole of what makes the
   * answer honest.** Placement turns on how *this* machine is signed in
   * to its backends, which secrets are on *this* disk and which MCP
   * servers *this* catalogue holds. A server answering it would be
   * describing its own sign-ins to somebody asking about their laptop —
   * and getting "no personal login anywhere" right about the wrong
   * computer. So an admin's browser gets the typed `machine-only`
   * refusal and draws nothing, exactly as it does for `sync:status`.
   *
   * Its own channel rather than fields on `jobs:get` for a second
   * reason: the two answer at different speeds. A job and its history
   * are rows; a placement asks a CLI how this machine is signed in,
   * which is a spawn behind a fifteen-second cache, and folding it in
   * would put that in front of every Job page opening — including the
   * solo ones that never show the control.
   *
   * Nothing here is stored. Every reason is derived from the pipeline,
   * the agent rows, the secret namespaces and the published policy
   * (invariant #6), and every one of them stops being true the moment
   * an agent is re-bound or a secret is set — which is the behaviour the
   * story's first acceptance criterion is about.
   *
   * `machine` is the second half of the original design's sentence — "runs while EO is
   * open on Anna's MacBook · last online 3h ago" — and it is null
   * wherever there is nothing honest to say: a solo installation, which
   * hides the control entirely, and a job whose placement is the
   * server's, which runs on nobody's laptop.
   */
  "jobs:placement": channel(
    z.object({ jobId: z.string() }),
    z.object({ placement: JobPlacementSchema.nullable(), machine: JobMachineSchema.nullable() }),
  ),

  // ── Reveal a personal secret (EO-489, ARCHITECTURE.md §14.2) ────────
  //
  // The only two channels that return a secret's value, and machine
  // half on the sharpest grounds there are: what they read is *this*
  // machine's keychain, and the person asking is the one sitting at it.
  // A browser served by an organisation server gets the typed
  // `machine-only` refusal and draws no Reveal button at all, and no
  // eo_admin tool reaches either (`mcpHost/catalog.test.ts` writes the
  // reason down). `moduleSecrets:list` and `mcpServers:list` stay names
  // only; a value crosses only when somebody presses the button, and the
  // screen keeps it in component state for thirty seconds at most.
  //
  // Personal only. Neither reads the organisation's store, so a name the
  // organisation also set is answered with the person's own value.

  /**
   * The stored value of one module secret in one scope: the shared one,
   * or a step's own override when `stepId` is given. Never the fallback —
   * a step with no override of its own answers `absent`, as the Reveal it
   * would have been pressed on is the row's own scope.
   */
  "moduleSecrets:reveal": channel(
    z.object({
      name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use an environment-variable name."),
      stepId: z.string().nullable().optional(),
    }),
    RevealedSecretSchema,
  ),
  /** The stored value of one of a catalogued MCP server's variables, from this machine's keychain. */
  "mcpServers:revealSecret": channel(
    z.object({ serverId: z.string(), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use an environment-variable name.") }),
    RevealedSecretSchema,
  ),
} as const;

/**
 * The whole contract, which is what everything reads.
 *
 * Derived rather than written, so the halves are the source of truth
 * and the union cannot disagree with them. A key present in both would
 * be silently overridden by the spread here — which is why ipc.test.ts
 * asserts at the type level that `RecordChannel & MachineChannel` is
 * `never`.
 */
export const ipcContract = { ...recordContract, ...machineContract } as const;

export type RecordContract = typeof recordContract;
export type RecordChannel = keyof RecordContract;
export type MachineContract = typeof machineContract;
export type MachineChannel = keyof MachineContract;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;
/**
 * What a caller has to produce to send on a channel.
 *
 * `z.input`, not `z.infer`. The distinction only shows up on a field
 * with a `.default()`, and then it matters: `z.infer` is the schema's
 * *output* — what comes out the far side, with defaults filled in — so
 * typing the caller with it demands every defaulted field be sent, which
 * is the opposite of what a default is for. Adding `.default({})` to
 * `items:list` broke ten renderer call sites for exactly that reason,
 * none of which had anything to do with the change.
 *
 * It is the same argument `inputSchemaFor` makes for `io: "input"` when
 * deriving an MCP tool's JSON Schema, and `outputSchemaFor` makes in
 * `schemas/index.ts`: a schema shown to whoever must satisfy it
 * describes what they have to send, not what the reader will get.
 */
export type IpcRequest<K extends IpcChannel> = z.input<IpcContract[K]["request"]>;

/**
 * What a handler is handed, once the request has been parsed.
 *
 * The other side of the same schema: defaults applied, so a handler can
 * read `fromSeq` without asking whether it arrived. Handlers take this;
 * callers send `IpcRequest`. Collapsing the two is what made a default
 * a breaking change.
 */
export type IpcPayload<K extends IpcChannel> = z.infer<IpcContract[K]["request"]>;

export type IpcResponse<K extends IpcChannel> = z.infer<IpcContract[K]["response"]>;

export interface IpcOk<T> {
  ok: true;
  data: T;
}

/**
 * Why a call could not be answered, where the *caller* can do something
 * different knowing it (EO-319).
 *
 * A union of one, on purpose. Almost every failure EO returns is a
 * sentence for a person to read and nothing a program can branch on, and
 * those stay exactly that — a `message` and no code. This exists for the
 * one case that is not: a channel from the machine half asked of an
 * installation that has no machine. A renderer served by an organisation
 * server has to tell "this cannot work here" from "this went wrong",
 * because the first hides a control and the second shows an error, and
 * matching on the English would be a promise the sentence never made.
 */
export type IpcErrorCode = "machine-only" | "section-locked";

export interface IpcErr {
  ok: false;
  error: {
    message: string;
    issues?: string[];
    /** Absent on everything but the refusals above — see `IpcErrorCode`. */
    code?: IpcErrorCode;
    /**
     * The typed half of a locked section's refusal (EO-329, ARCHITECTURE.md, "Publish, lock and
     * versions").
     *
     * `{locked: true, section, publishedBy}`, exactly as the review
     * names it, carried where both doors already look: the renderer
     * branches on it to draw the lock rather than an error, and the MCP
     * host turns `message` into a tool error naming the section. A
     * refusal a caller had to recognise by its English would be a
     * promise the sentence never made — the same argument `code` makes
     * for `machine-only`, and the reason both are here rather than one.
     */
    lock?: SectionLock;
  };
}

export type IpcResult<T> = IpcOk<T> | IpcErr;

/** Whether a channel is one only the machine somebody is sitting at can answer. */
export function isMachineChannel(channel: string): channel is MachineChannel {
  return Object.hasOwn(machineContract, channel);
}

/**
 * What an installation with no machine answers on a machine channel
 * (EO-319, `ARCHITECTURE.md`, "The server").
 *
 * One sentence, written once, so the server's door and the renderer's
 * transport refuse in the same words — the transport short-circuits a
 * machine channel rather than spending a round trip to be told, and the
 * two answers have to be the same answer.
 *
 * Names the channel, because the alternative is a reader who knows only
 * that *something* wanted the machine. Carries `code` so the reader does
 * not have to parse the sentence to know which kind of failure it is.
 */
export function machineOnlyRefusal(channel: MachineChannel): IpcErr {
  return {
    ok: false,
    error: {
      code: "machine-only",
      message: `"${channel}" is not available on a server. ${NO_MACHINE_HERE}`,
    },
  };
}

/**
 * What a write into a published section is answered with (EO-329,
 * ARCHITECTURE.md, "Publish, lock and versions").
 *
 * Written once, here, for `machineOnlyRefusal`'s reason: the refusal
 * leaves the command layer and reaches three different readers — the
 * renderer, the MCP host, and a device's own screens — and three
 * spellings of one answer is three answers.
 */
export function sectionLockedRefusal(lock: SectionLock): IpcErr {
  return { ok: false, error: { code: "section-locked", message: sectionLockedMessage(lock), lock } };
}

/**
 * The channels whose payload says which device is asking (EO-324,
 * ARCHITECTURE.md, "The record").
 *
 * Every one of them *acts as* a device: it claims work, keeps or gives
 * back a claim, or files history under a machine's name. So the id in
 * the payload is not information — it is an identity claim, and a
 * server that believed it would let any signed-in device take another's
 * lease, renew a claim it never held, and write run events under
 * somebody else's name.
 *
 * Named here rather than decided at the door, so that the list and the
 * contract cannot drift: a new channel carrying `deviceId` is a new
 * entry here, and `ipc.test.ts` checks that every entry really has the
 * field.
 */
export const DEVICE_SCOPED_CHANNELS = [
  "record:work",
  "record:renew",
  "record:release",
  "record:apply",
  // Moving a project is something a *device* does, and the record
  // writes the device's id against the runs and transcripts it takes
  // (EO-325). A request with no device behind it is one the record
  // cannot attribute.
  "record:adopt",
  // Creating work is something a module's run on a *device* asks for,
  // and the record checks that device holds the originating item's
  // lease (EO-433).
  "record:createItem",
  // Writing a project's memory is something a run or a person on a
  // *device* asks for, and the record names that device's person as the
  // source of a person's entry (EO-482).
  "record:memory",
  "record:restoreMemoryConsolidation",
  // Resolving a held template update is an administrator's act, and the
  // record checks that the asking device is one of its admins' (EO-534).
  "record:resolveUpdateConflict",
  // Changing what an item waits for is something a person on a *device*
  // asks for, and the record names that device's person in the comment
  // that says so (EO-600).
  "record:changeDependencies",
] as const satisfies readonly RecordChannel[];

/** Whether this channel's payload names the device that is asking. */
export function isDeviceScopedChannel(channel: string): channel is (typeof DEVICE_SCOPED_CHANNELS)[number] {
  return (DEVICE_SCOPED_CHANNELS as readonly string[]).includes(channel);
}

/**
 * The payload, with the asking device's identity put back where it
 * belongs (EO-324).
 *
 * Stamped rather than checked, and that is the decision worth writing
 * down. A door that *rejected* a mismatch would answer a compromised
 * client with an error it could learn from, and would answer an
 * ordinary bug with a failure nobody could act on. A door that stamps
 * gives both the same harmless outcome: the request is about whoever
 * made it. A device asking for work gets its own work; a device filing
 * a transcript files it under its own name.
 *
 * Which leaves the honest reading of what a client sends: a *hint*,
 * always replaced, never trusted. The whole point of doing it here is
 * that nothing downstream has to remember to — `serveRecord.ts` reads
 * `payload.deviceId` and cannot be fooled, however it was reached.
 */
export function withDeviceIdentity(channel: string, payload: unknown, deviceId: string): unknown {
  if (!isDeviceScopedChannel(channel)) return payload;
  if (payload === null || typeof payload !== "object") return payload;
  return { ...(payload as Record<string, unknown>), deviceId };
}

/**
 * The channels answered *on behalf of a person* (EO-326, ARCHITECTURE.md, "Identity").
 *
 * Two kinds of thing, and they are one list because they ask one
 * question. A read here answers "what is mine" — my projects, my inbox,
 * the mentions I am allowed to see, who I am. A write here is attributed
 * to somebody — a move, a decision, a claim, an assignment, a comment —
 * and the original design's whole sentence is that an admin acting on another team's
 * item does it "as a human actor, through the same transition path as
 * anyone else". Both need the same fact: which person this request is.
 *
 * Which is not a fact a payload can carry. Every id on this list is
 * stamped at the server's door from the credential the request arrived
 * on, by `withActingDevice`, exactly as `DEVICE_SCOPED_CHANNELS` are
 * stamped by `withDeviceIdentity` — a client's own word here would let
 * anybody read another person's inbox and file a decision under their
 * name, from a token that is perfectly valid for itself.
 *
 * Named here rather than decided at the door so the list and the
 * contract cannot drift: a new channel that acts as somebody is a new
 * entry here, and `ipc.test.ts` checks that every entry really declares
 * the field.
 *
 * The three board reads are here for a narrower reason than the rest:
 * each takes a project and falls back to "whichever this installation is
 * showing", which is a setting rather than a fact about the caller. On a
 * server that fallback would put a person on a board they cannot see in
 * their own switcher — the list narrowed and the board did not. So they
 * carry the caller in order to answer the same question their own
 * `projectId` argument asks. See `scopedProjectId` in main.
 *
 * What is deliberately *not* here is the rest of the item surface —
 * `items:get`, `items:hold`, the configuration. Who may
 * read and edit what, per project, is the permission model the original design defers
 * ("per-project owner roles arrive with the first customer who asks"),
 * and half of it arriving here would be a second rule for the same
 * subject. These channels scope because each of them is about a person
 * by its own nature, not because a boundary is being drawn.
 */
export const ACTOR_SCOPED_CHANNELS = [
  "people:me",
  // EO-328. The policy itself is everybody's; the budget line beside it
  // is the caller's own day, which is exactly what this list is for —
  // nobody is refused, and "yours" means theirs. The three writes are
  // here for `items:move`'s reason rather than that one: what they
  // record is *who published*, and an id a client sent would be a claim
  // rather than a fact.
  "policy:get",
  "policy:save",
  "policy:setSecret",
  "policy:clearSecret",
  "work:submitItem",
  "projects:list",
  "items:list",
  "items:listArchived",
  "inbox:list",
  // EO-725. A message is its recipient's to answer or dismiss, and only the
  // door knows who is asking.
  "messages:answer",
  "messages:dismiss",
  "mentions:open",
  "items:move",
  // EO-567. The comment it posts names who asked, which only the door knows.
  "items:moveToVersion",
  "items:decide",
  "items:claim",
  "items:assign",
  // EO-368. On a step that waits on a group only the person holding the
  // item may take it over, edit it, or ask who may — each of them is
  // about whoever is asking, and only the door knows who that is.
  "items:takeOver",
  "items:update",
  // The item's own files are part of what it is, as its text is (EO-702),
  // so they are the holder's to change on the same terms.
  "items:addAttachments",
  "items:removeAttachment",
  "attachments:delete",
  "items:authority",
  "comments:post",
  // Who published it, for "Dana published it" on five screens and in
  // the refusal an agent is handed (EO-329). The record knows the
  // device; only the door knows which one is asking.
  "sections:publish",
  // Whose suggestion it is (EO-331, ARCHITECTURE.md, "Divergence and suggestions"). The author is
  // who the
  // thread mentions when an administrator sends a change back — "Send
  // back with a comment reaches the author's inbox" — and an id a
  // desktop sent would be a claim about whose change this is rather
  // than a fact about who asked. It is also the only fact the record
  // has: a document arrives with no name on it, because a pipeline
  // export deliberately carries none.
  "suggestions:create",
] as const satisfies readonly RecordChannel[];

/** Whether this channel is answered on behalf of whichever person is asking. */
export function isActorScopedChannel(channel: string): channel is (typeof ACTOR_SCOPED_CHANNELS)[number] {
  return (ACTOR_SCOPED_CHANNELS as readonly string[]).includes(channel);
}

/**
 * The payload, with the asking device put where the handler will read it
 * (EO-326).
 *
 * Stamped rather than checked, for `withDeviceIdentity`'s reason word
 * for word: a door that rejected a mismatch would teach a compromised
 * client something and would answer an ordinary bug with a failure
 * nobody could act on, while a door that stamps gives both the same
 * harmless outcome — the request is about whoever made it.
 *
 * `null` is stamped as deliberately as an id is. It is the difference
 * between "an operator's key, which is nobody" and "no door was
 * involved, so this is the machine's own person" — and a door that left
 * the field absent for the operator would say the second when it meant
 * the first, handing an organisation server's local-person row an
 * inbox and a name on a move.
 */
export function withActingDevice(channel: string, payload: unknown, deviceId: string | null): unknown {
  if (!isActorScopedChannel(channel)) return payload;
  if (payload !== null && typeof payload === "object") return { ...(payload as Record<string, unknown>), actingDeviceId: deviceId };
  // Every one of these channels takes an object, and three of them
  // default an absent payload to `{}` — so a caller that sent nothing
  // still has to be stamped, or `people:me` from a browser would answer
  // as though no door had been crossed.
  return payload === undefined ? { actingDeviceId: deviceId } : payload;
}

/**
 * The channels on which a system agent can act in its own name rather
 * than the person's (EO-585): pressing a result on a person's step, and
 * replying in a thread. Each declares `actingAgentId`, and `ipc.test.ts`
 * holds that true.
 */
export const AGENT_ACTED_CHANNELS = [
  "items:decide",
  "comments:post",
  // A skill write is versioned with its author, and a lock refuses an agent's (EO-714).
  "skills:save",
  "skills:setEnabled",
  "skills:archive",
  "skills:restoreVersion",
] as const satisfies readonly IpcChannel[];

/** The field EO's administrative MCP host stamps, spelled once. */
export const ACTING_AGENT_KEY = "actingAgentId";

/** Whether a system agent can be the one acting on this channel. */
export function isAgentActedChannel(channel: string): channel is (typeof AGENT_ACTED_CHANNELS)[number] {
  return (AGENT_ACTED_CHANNELS as readonly string[]).includes(channel);
}

/**
 * The payload with any claim to be an agent taken off, and — where
 * `agentId` is given and the channel is one a system agent acts on —
 * the agent that is really asking put back (EO-585).
 *
 * Taken off first, always, so a door that has no agent to stamp is the
 * same as a door that strips: `withActingAgent(channel, payload,
 * undefined)` is how an organisation server's HTTP door and the external
 * MCP host make sure a caller is never an agent by its own say-so.
 */
export function withActingAgent(channel: string, payload: unknown, agentId: string | undefined): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const rest = { ...(payload as Record<string, unknown>) };
  delete rest[ACTING_AGENT_KEY];
  // And any claim to a place files may be read from (EO-700), which is
  // the same kind of fact — the door's, never the caller's — so every
  // door that strips the one strips the other without being told twice.
  delete rest[PATHS_FROM_KEY];
  if (agentId !== undefined && isAgentActedChannel(channel)) rest[ACTING_AGENT_KEY] = agentId;
  return rest;
}

/**
 * The payload with the grant to read files by path put on it, where the
 * channel takes one (EO-700, EO-704) — those in `PATHS_CHANNELS`. Stamped
 * by EO's MCP hosts, below every tool and after `withActingAgent` has
 * taken off whatever a client sent under the same name.
 */
export function withPathsFrom(channel: string, payload: unknown, from: PathsFrom): unknown {
  if (!PATHS_CHANNELS.has(channel) || payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return { ...(payload as Record<string, unknown>), [PATHS_FROM_KEY]: from };
}

/**
 * The payload of a sign-in, with any claim to run work taken away
 * (EO-328, review).
 *
 * `SignInRequest.runsWork` decides whether the server mints the second
 * credential — the one that opens `ORGANISATION_SECRETS_PATH`. Left as a
 * field the client simply asserts, it bought nothing: the renderer a
 * server hands a browser could POST `auth:signIn` with `runsWork: true`,
 * read `secretsKey` out of the *response*, and fetch the organisation's
 * secrets with it. A separate credential is only separate if a renderer
 * cannot ask for one.
 *
 * So the door narrows the claim, and it can only ever narrow it: this
 * turns a true into a false and never the other way round. What the door
 * decides it on is `Origin` and `Sec-Fetch-Site`, which are **forbidden
 * header names** — a browser sets them on every request it makes and
 * page script may neither forge nor remove them, while a client that is
 * not a browser sends neither. That is the trust boundary, and it is the
 * server's rather than the client's.
 *
 * Stamped rather than refused, for `withActingDevice`'s reason: a
 * renderer that asked for a key is answered with a session that works
 * and a `secretsKey` of null, which is what it should have asked for. A
 * refusal would have been a sign-in screen that fails for a reason
 * nobody at the keyboard can act on.
 */
export function withoutWorkClaim(channel: string, payload: unknown): unknown {
  if (channel !== "auth:signIn") return payload;
  if (payload !== null && typeof payload === "object") return { ...(payload as Record<string, unknown>), runsWork: false };
  return payload;
}

/**
 * What a caller with no device of its own is told on those channels.
 *
 * The operator's token is the one key that belongs to no machine: it is
 * how the person who started the container reaches a server with nobody
 * on its people list yet (see `HttpDoorOptions.token`). It can
 * administer the organisation and it cannot *be* a device — there is no
 * laptop behind it to run anything, and no row to grant a lease to.
 */
export function notADeviceRefusal(channel: string): IpcErr {
  return {
    ok: false,
    error: {
      message:
        `"${channel}" is something a signed-in device asks on its own behalf, and this request came from a key that is not one. ` +
        `Sign a desktop in to this organisation and let it ask.`,
    },
  };
}

/**
 * The two channels a caller may reach without a token (EO-323,
 * `ARCHITECTURE.md`, "Identity").
 *
 * The server's door checks the token first, before it will say whether a
 * channel even exists, and that rule is worth keeping absolute: a
 * refusal that varies before authentication is a probe. These two are
 * the exceptions the rule cannot avoid — a sign-in is by definition the
 * request that has no token yet, and an invitation is accepted by
 * somebody who is not yet anybody.
 *
 * Named here rather than decided by the door, so that both ends read one
 * list: the server opens exactly these, and the desktop's client sends
 * exactly these without one.
 *
 * Each of them is admitted on what it carries and nothing else — a
 * password against a stored hash, a code against a stored hash — and
 * both answer every failure with one sentence, so that neither becomes a
 * way to learn who is on the list.
 */
export const UNAUTHENTICATED_CHANNELS = ["auth:signIn", "auth:acceptInvitation"] as const satisfies readonly RecordChannel[];

/** Whether this channel is one of the two a caller may reach before it has a token. */
export function isUnauthenticatedChannel(channel: string): boolean {
  return (UNAUTHENTICATED_CHANNELS as readonly string[]).includes(channel);
}

/**
 * What only an admin may do on a server (EO-323, the original design: "one admin flag.
 * Everyone with it may edit on the server").
 *
 * The list of the organisation, and who may hold a key to it. Every
 * other channel stays open to any signed-in device, which is the design's
 * reading — the record syncs up and an admin sees every board — rather
 * than a permission model nobody has asked for yet ("per-project owner
 * roles arrive with the first customer who asks, not before").
 *
 * That sentence still holds after EO-326, and the distinction it turns
 * on is worth keeping in sight because the two rules look alike. Nothing
 * on `ACTOR_SCOPED_CHANNELS` is *refused* to anybody: a colleague asking
 * for their projects, their inbox or the open mentions is answered, and
 * answered with their own. This list is about being turned away; that
 * one is about what "yours" means in an answer. A channel moved from
 * there to here would be a permission arriving under cover of a
 * visibility rule.
 *
 * Enforced **at the server's door**, where a caller has an identity, and
 * nowhere else. On a desktop there is no caller: the person at the
 * keyboard owns the machine and its database, and a flag on a row in it
 * would be a lock whose key is in the same drawer.
 *
 * What was deliberately *not* on this list when EO-323 wrote it is the
 * configuration — the pipelines, the agents, the packs. Who may change
 * those on a server is the publishing-and-locking question (ARCHITECTURE.md, "Publish, lock and
 * versions"), and half of that answer arriving early would have been a second
 * rule for the same subject, disagreeing with the first later.
 *
 * **The three `policy:*` writes are that question's first settled part**
 * (EO-328, ARCHITECTURE.md, "Policy"), and they are here rather than waiting because policy
 * is the one section with no local half at all. A pipeline, an agent or
 * a pack is something a person edits on their own desktop and an
 * organisation may then publish over; what an organisation *allows* has
 * never been a thing a desktop had an opinion about — it is the
 * organisation's by definition, in the same way its list of people is.
 * There is nothing here for a lock to protect a local copy from, so
 * "only an admin may write it" is the whole of the rule and it does not
 * pre-empt the section lock the next story brings.
 */
export const ADMIN_ONLY_CHANNELS = [
  "people:invite",
  "people:setAdmin",
  "devices:revoke",
  "groups:save",
  "groups:delete",
  "policy:save",
  "policy:setSecret",
  "policy:clearSecret",
  // Publishing is the act that locks four hundred desktops out of a
  // section, and rolling back is the same act pointed at an older
  // version (EO-329, ARCHITECTURE.md, "Publish, lock and versions"). `sections:list` is
  // deliberately not here:
  // everybody signed in has to be able to read what was published to
  // them, which is what every locked screen draws its lock from.
  "sections:publish",
  "sections:publishPreflight",
] as const satisfies readonly RecordChannel[];

/** Whether this channel is one only an admin may reach on a server. */
export function isAdminOnlyChannel(channel: string): boolean {
  return (ADMIN_ONLY_CHANNELS as readonly string[]).includes(channel);
}

/**
 * What a signed-in person without the admin flag is told.
 *
 * A sentence and no code, because there is nothing for a client to do
 * differently: the control that produced the request is one this person
 * should not have been offered, and the honest fix is on the server.
 */
export function notAnAdminRefusal(channel: string): IpcErr {
  return { ok: false, error: { message: `"${channel}" is something only an administrator of this EO server may do.` } };
}

/**
 * The tail of every "there is no machine here" sentence EO says.
 *
 * Exported because the refusal above is not the only place that has to
 * say it: a server's `Platform` is asked for a dialog by code that is
 * not going over IPC at all and has no envelope to put a code in, and
 * the two explanations have to be one explanation. The subject differs —
 * a channel there, a capability here — and the reason does not.
 */
export const NO_MACHINE_HERE = "It needs the machine somebody is sitting at.";

// Main -> renderer, fire-and-forget streaming (run events, item changes, ...).
export const ipcPushContract = {
  // Deliberately carry no payload beyond an id: a push says "this
  // changed, ask again", and the renderer refetches through the same
  // channels everything else uses. Pushing the new state instead would
  // give the UI a second source of truth that can disagree with the
  // first.
  "items:changed": z.object({ itemId: z.string().optional() }),
  "runs:changed": z.object({ runId: z.string(), itemId: z.string(), status: z.string() }),
  /**
   * A message was sent, answered, dismissed, resolved or swept (EO-725):
   * ask `inbox:list` again. Carries nothing, by the rule above — a message
   * names no item, so `items:changed` would make every window refetch
   * everything drawn from items for a row only the inbox shows.
   */
  "messages:changed": z.object({}),
  /**
   * The list of assistant chats changed and nothing else did (EO-439):
   * ask `assist:list` again. Carries nothing, by the rule above.
   *
   * Sent by `assist:reorder`, which changes where an open chat stands
   * and no item at all. It used to send `items:changed`, and every
   * window then refetched everything drawn from items — the open
   * conversation, the project's items, the inbox, the board — for a
   * chat moved one place. What draws the chat list (the chat layout's
   * rail) listens on both.
   */
  "assist:changed": z.object({}),
  /**
   * A memory scope's consolidation was queued, started or finished
   * (EO-589): ask `memory:consolidations` — and its entries — again. Says
   * which scope, as `items:changed` says which item.
   */
  "memory:changed": z.object({ scope: MemoryScopeSchema }),
  /**
   * A run has persisted more events (U-05). Throttled by the supervisor
   * and carrying no payload beyond the id: the transcript pages forward
   * from `run_events`, which is the durable log, so a coalesced or even
   * dropped signal costs a little latency and never an event. Pushing
   * the events themselves would make the renderer a second, lossy copy
   * of the substrate.
   */
  "runs:progress": z.object({ runId: z.string() }),
  /**
   * More of the block a run is writing (`OutputDeltaEvent`), coalesced to
   * about one per frame.
   *
   * Carries the text, against the rule at the top of this contract, for
   * the reason `updates:progress` gives: there is no substrate behind it.
   * The words are never stored as they arrive — the finished block is —
   * so an "ask again" would have nothing to ask. The draft as a whole is
   * also in the conversation's `liveTurn`, which is what a window that
   * missed the start reads; `offset` is how far into the draft this piece
   * begins, so a renderer can tell a repeat from a gap and ask again when
   * it finds one.
   */
  "runs:delta": z.object({
    runId: z.string(),
    itemId: z.string(),
    draft: LiveDraftSchema.omit({ text: true }),
    offset: z.number().int().nonnegative(),
    text: z.string(),
  }),
  /**
   * What changed in an assistant chat's messages (EO-553): the messages
   * that are new or no longer read as they did, and which messages the
   * view now holds, in its order.
   *
   * Carries the change, against the rule at the top of this contract, for
   * the reason `runs:delta` does: it is the hottest path in the app. A
   * chat is a room, and a turn posting several messages had every window
   * read the whole room again for each one. This is not a second source
   * of truth: applied to the view numbered one before it, a delta gives
   * exactly the messages and `earlier` that `assist:open` would answer
   * with at that moment, and the room re-reads as soon as it doubts it.
   *
   * - `messages` — the upserted messages, each as the view draws it.
   * - `messageIds` — every message the view now carries (its newest
   *   stretch), in order: what is in the view and not here has left it,
   *   by sliding out of the stretch or out of the thread.
   * - `earlier` — how many older messages the thread holds beyond them.
   *
   * `seq` goes up by one per delta for this chat, from the `deltaSeq` a
   * view carries. A renderer applies the next one and reads the room
   * again on a gap, on a delta about a chat whose base it does not hold,
   * for an id it holds no message for, and when `resync` says the change
   * is one a list of messages cannot carry: the chat's settings, its key,
   * its closing.
   *
   * Sent after every `items:changed` that names an assistant chat a view
   * has been served for — so whenever a comment there is posted or
   * changed — and only when something a delta can describe moved.
   */
  "assist:delta": z.object({
    conversationId: z.string(),
    seq: z.number().int().positive(),
    messages: z.array(DiscussionMessageSchema),
    messageIds: z.array(z.string()),
    earlier: z.number().int().nonnegative(),
    resync: z.boolean(),
  }),

  /**
   * Agents or the pipeline changed (U-06). Any open view derives its
   * columns and agent names from these, so a config change has to reach
   * views that were already rendered — not just the one that made it.
   */
  "config:changed": z.object({}),
  /**
   * The update status changed (EO-201) — a plain "ask again", carrying
   * nothing, exactly as the rule at the top of this contract says.
   *
   * It is what makes the six-hourly check worth keeping. The background
   * check moves the status with nobody having asked for it, and without
   * this an open Settings section would sit on whatever it read when it
   * mounted: a check that began before the section opened would still be
   * drawn as *checking* long after it had answered.
   *
   * Emitted per change of the status itself, never per download chunk —
   * progress is `updates:progress`'s job, and it carries the number so
   * that this one does not have to.
   */
  "updates:changed": z.object({}),
  /**
   * How far a download has got (EO-201), throttled by the updater.
   *
   * This one carries state, and the rule stated at the top of this
   * contract says a push should not. The exception holds for exactly the
   * reason the rule exists. `runs:progress` can afford to carry only a
   * `runId` because `run_events` is the durable truth and the renderer
   * pages forward from it — pushing the events themselves would make the
   * renderer a second, lossy copy of a substrate that already exists.
   *
   * Download progress has no substrate behind it. electron-updater's
   * event stream is the only copy there will ever be: nothing persists a
   * percentage, and a `updates:status` refetch triggered by a bare "ask
   * again" would race the next event and read a number already stale.
   * Carrying the percentage here is not creating a second source of
   * truth, it is carrying the only one.
   *
   * Which is also why it is safe to drop: a coalesced or lost tick costs
   * a frame of a progress readout, and the terminal states — `downloaded`
   * and `error` — arrive through `updates:status`, not through this.
   */
  "updates:progress": z.object({ percent: z.number().min(0).max(100) }),
  /**
   * Take the user somewhere — clicking a desktop notification (U-04).
   *
   * The one push that is not "something changed, ask again", because it
   * is not about data at all. It was being sent on a bare
   * `webContents.send("push:navigate", ...)` that bypassed this contract
   * entirely, and nothing anywhere listened for it: clicking a
   * notification raised the window and then sat there.
   */
  navigate: z.object({ to: z.string().min(1) }),
  /**
   * The canvas popped out into its own window, or came back (EO-383).
   *
   * Carries what happened rather than "ask again", for `navigate`'s
   * reason: `restore` is an event and not a state. It is the tabs a
   * "Pop in" hands back to the main window, exactly once — a refetch
   * that answered them would hand them back again to a window that
   * reloaded an hour later. Null when the canvas window was simply
   * closed, and the main window then stays on the conversation.
   */
  "canvas:changed": z.object({ poppedOut: z.boolean(), restore: CanvasTabsSchema.nullable() }),
  /**
   * Take the popped-out canvas somewhere (EO-383): `navigate`, for the
   * other window. Every window hears it and only the canvas's acts.
   */
  "canvas:opened": z.object({ path: CanvasPathSchema }),
  /**
   * The popped-out canvas handing the person to the conversation
   * (EO-408): a view there asked for the composer, which is in the main
   * window. Every window hears it and only the one drawing the
   * conversation acts. An event, like `navigate`: asking again an hour
   * later must not take the cursor a second time.
   */
  "canvas:asked": z.object({}),
  /**
   * The main window went into full screen or came out of it (EO-668).
   * Ask `window:state` again.
   */
  "window:changed": z.object({}),
} as const;

export type IpcPushContract = typeof ipcPushContract;
export type IpcPushChannel = keyof IpcPushContract;
export type IpcPushPayload<K extends IpcPushChannel> = z.infer<IpcPushContract[K]>;

/** The wire-level channel name main sends on and preload listens for. */
export function pushWireChannel(pushChannel: IpcPushChannel): string {
  return `push:${pushChannel}`;
}

/**
 * Where a client that has no preload in front of it attaches its push
 * stream (EO-321, `ARCHITECTURE.md`, "The server").
 *
 * Push had one transport — `webContents.send` — which is a window in
 * this process. A renderer served over HTTP is not that, so the same
 * pushes go over a server-sent-event stream on the same origin the
 * record half is answered from, and these three names are what the two
 * ends agree on. They are here rather than in either end for the reason
 * everything else crossing this boundary is: a path spelled twice is a
 * path that can differ in one place.
 *
 * Not under `/ipc/`, deliberately. Everything below that prefix is a
 * channel of the contract, POSTed to and answered once; this is neither
 * — it is one long-lived GET that outlives every request beside it.
 */
export const PUSH_STREAM_PATH = "/push";

/**
 * Where a device collects the organisation's secret **values** (EO-328,
 * `ARCHITECTURE.md`, "Secrets").
 *
 * **Not under `/ipc/`, and that is the whole point of it.** The story's
 * third acceptance criterion is that an organisation secret "is never
 * returned by any query the renderer can make", and the durable way to
 * keep that is for there to be no channel that could: a renderer holds
 * an `IpcChannel`-typed client and nothing else, so a value delivered
 * outside the contract is a value no screen, no push frame and no MCP
 * tool has a shape to carry. `apps/desktop/src/main/policy/ipcLeak.test.ts`
 * is the test that keeps it true as channels are added.
 *
 * What EO undertakes about these values is the design's exact claim and no
 * more: it does not *display* them. They are read by a desktop's main
 * process, kept under that machine's own keychain, and put into the
 * environment of a module or an MCP server at spawn — where, as the design says plainly, an agent
 * with a shell can read them. "Set by your
 * organisation · not shown here" is the honest sentence; "never
 * readable" would not be.
 */
export const ORGANISATION_SECRETS_PATH = "/organisation/secrets";

/**
 * The event a stream opens with, carrying nothing but its own id.
 *
 * Its whole job is to give a client an id before anything has been
 * pushed, so that the *next* connection is recognisable as a
 * reconnection. Without it a client that connected, was pushed nothing
 * and lost the socket would come back indistinguishable from one that
 * had never been here, and would not be told to ask again.
 */
export const PUSH_STREAM_READY_EVENT = "ready";

/**
 * "Ask for everything again."
 *
 * What a reconnecting client is answered with instead of a replay, and
 * what a client that fell behind is caught up with. It is sound because
 * of what a push is: every channel in `ipcPushContract` bar one says
 * "this changed, ask again" and carries no state of its own, so a
 * hundred missed pushes and a single refetch leave the renderer in the
 * same place — TanStack Query refetches what is mounted and the rest is
 * stale-marked. Replaying a log instead would mean keeping one, and
 * keeping one would mean deciding how long to keep it.
 *
 * The exception is `updates:progress`, which carries a percentage and
 * no substrate behind it. A dropped one costs a frame of a progress
 * readout; the terminal states arrive on `updates:changed`, which is an
 * invalidation like every other. That is exactly the trade the contract
 * already documents for a coalesced tick.
 */
export const PUSH_STREAM_REFETCH_EVENT = "refetch";
