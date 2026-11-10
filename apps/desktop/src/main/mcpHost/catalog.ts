import {
  canonicalToolName,
  deprecatedToolName,
  deprecationNotice,
  describeMachineSpecificWarning,
  GuardConfigSchema,
  ipcContract,
  isActorScopedChannel,
  keptDefinitionsNote,
  MAX_MEMORY_ENTRY_CHARS,
  MemoryScopeKindSchema,
  MODULE_COVERAGE_BAR,
  PipelineSaveInputSchema,
  pipelineMachineSpecificWarnings,
  testCaseMachineSpecificWarnings,
  PostCommentInputSchema,
  CommentPathsSchema,
  replacementToolName,
  WEBHOOK_UNATTENDED_AGENT_REFUSAL,
  WEBHOOK_UNATTENDED_CARD_KIND,
  WEBHOOK_UNATTENDED_KEY,
  withActingAgent,
  type AgentRemovalImpact,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
} from "@eo/core";
import { z } from "zod";
import {
  renderAgentAttachmentSet,
  renderAgentAttachments,
  renderAgentSaved,
  renderAgents,
  renderArchived,
  renderCommentPinned,
  renderCommentPosted,
  renderCurrentView,
  renderHeld,
  renderDecided,
  renderMoved,
  renderMovedToVersion,
  renderPipelineProblems,
  renderPipelineSaved,
  renderPipelineVersions,
  renderUpdateConflict,
  renderSuggested,
  renderStepItemsMoved,
  renderResumed,
  renderRunCancelled,
  renderItemUpdated,
  renderEngineStatus,
  renderForgeDetection,
  renderGuards,
  renderGuardsWritten,
  renderInbox,
  renderJiraCheck,
  renderJiraConnections,
  renderJiraFields,
  renderJiraOutbox,
  renderJiraStatuses,
  renderMcpServers,
  renderMcpServerSaved,
  renderMcpServerSwitched,
  renderMemoryConsolidationRestored,
  renderMemoryConsolidateNow,
  renderMemoryConsolidations,
  renderMemoryEntry,
  renderMemoryWritten,
  renderMemorySearch,
  renderModules,
  renderMachineSpecific,
  approvalWithdrawnNote,
  renderModuleTestRun,
  renderModuleTests,
  renderPipeline,
  renderPipelines,
  renderRegistry,
  renderItemTypes,
  renderProjects,
  renderProjectWritten,
  renderRepositories,
  renderRepositoryCreated,
  renderWorkspaceCreated,
  renderWorkspaceUpdated,
  renderWorkspaces,
  renderRepositoryUpdated,
  renderRunEvents,
  renderRuns,
  renderRunSummary,
  renderRuntimeDescription,
  renderRuntimes,
  renderModuleVersion,
  renderModuleVersions,
  renderSettings,
  renderSettingsWritten,
  renderSkillLocked,
  renderSkillRestored,
  renderSkills,
  renderSkillSaved,
  renderSkillSwitched,
  renderSkillVersions,
  renderSpend,
  renderItem,
  renderItems,
  renderWorktrees,
  type MemoryConsolidationRestored,
  type RuntimeEntry,
  type SpendReport,
} from "./render.js";
import { GUIDES, guideNamed } from "./guides.js";
import { RUNTIMES } from "../runtimes/catalog.js";
import { ACTING_DEVICE_KEY, inputSchemaFor, isVoidChannel, withoutCallerIdentity, type JsonSchemaObject } from "./toolSchema.js";
import { boundaryArguments, LEGACY_BOUNDARY_NAMES, type ToolSpelling } from "./legacyNames.js";
import { blockedByActiveRunRefusal } from "../supervisor/itemLock.js";
import { narrowingKeysFor, withNarrowingProperties, type NarrowingKey } from "./narrow.js";
import { ITEM_ID_ARGUMENTS, itemIdArgumentsOf, KEY_ACCEPTED_SENTENCE, RESOLVE_KEY_CHANNEL, withKeyAcceptingProperties } from "./itemKeys.js";

/**
 * How much trust a tool needs.
 *
 * `read` and `write` are always offered. `dangerous` is withheld until
 * someone turns destructive operations on in Settings — see gate.ts for
 * what that switch is and why it is not a preference.
 */
export type ToolKind = "read" | "write" | "dangerous";

/** The subset of MCP's tool annotations EO has anything true to say with. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** How a tool reaches EO. The only way it may. */
export type Dispatch = (channel: IpcChannel, payload: unknown) => Promise<{ ok: true; data: unknown } | { ok: false; error: { message: string; issues?: string[] } }>;

/**
 * What a tool answers, before `callTool` puts it on the wire.
 *
 * `text` and `data` are not an answer and a note about it. They become
 * `content` and `structuredContent`, both attached to every successful
 * call, and the spec lets a client surface either — no tool here
 * declares an `outputSchema`, so nothing tells a client to prefer one.
 * They therefore have to be the same answer twice: `text` written for
 * whoever is reading a transcript, `data` for whatever is parsing one.
 *
 * A `channelTool` cannot get this wrong — it renders `text` from the
 * `data` it is about to send, so one value reaches both doors. A
 * hand-written `run` can, and did: `eo_guide` put the whole guide in
 * `text` and a name and a title in `data`, so a client reading
 * structured output got a label and no guide, well-formed enough to
 * look like the tool working (EO-202).
 *
 * The rule that follows, for anything built by hand here: **a tool
 * whose answer is prose must carry that prose in `data` too.** Where
 * `text` is a *rendering* — the facts of `data` written out for a
 * reader — one copy of them is enough, and that is what nearly every
 * tool does. It is the tool whose text is the substance that has to
 * duplicate it. `invariants.test.ts` holds this.
 */
export type ToolOutcome =
  | { ok: true; text: string; data: unknown; refused: boolean }
  | { ok: false; message: string; issues?: string[] };

export interface ToolSpec {
  /** Bare, like eoServer.mjs's. Clients namespace by server already. */
  name: string;
  description: string;
  kind: ToolKind;
  /**
   * Withheld from the external listener entirely (EO-192).
   *
   * A different axis from `kind`, and the difference is who is at the
   * other end rather than how much damage a call could do. The gate asks
   * "has somebody turned destructive operations on"; this asks "is this
   * server the one EO runs for its own agent". `view_current` is the
   * first: it answers with what is on the person's screen right now,
   * which is a fact about them rather than about the project, and it
   * exists so the assistant's agent can act on "this" — a stranger's
   * editor holding a pasted token has no such conversation and no
   * business watching somebody browse.
   *
   * Enforced on both paths, like the gate: `tools/list` does not offer
   * it and `tools/call` does not find it. A client can call a tool it
   * was never shown.
   */
  adminOnly?: boolean;
  /**
   * Withheld from the administrative listener entirely (EO-714) — the
   * other direction from `adminOnly`. A person's act that no agent may
   * take, not even the system agent acting with the person's authority:
   * locking a skill is what stops agents changing it, so an agent able to
   * unlock one would make the lock nothing. Enforced on both paths, as
   * `adminOnly` is.
   */
  personOnly?: boolean;
  annotations: ToolAnnotations;
  /**
   * Every channel this tool may touch.
   *
   * Not decoration: catalog.test.ts subtracts the union of these from
   * `ipcContract` and compares the remainder against a written-down
   * exclusion list, so a channel added to the contract fails the build
   * until someone says which bucket it belongs in.
   */
  channels: readonly IpcChannel[];
  inputSchema: JsonSchemaObject;
  /**
   * Where this read tool's main list sits in its answer, as a dot path in
   * EO's own words — `items` for `tickets_list` (EO-538).
   *
   * Declaring it is what makes a read tool list-shaped: the host then
   * offers `where`, `sort`, `limit` and `offset` on that list beside the
   * `fields` every read tool takes, and cuts an answer too large to use
   * to that list's first page. Absent on a read with no one list to page
   * through, and on every write. narrowing.test.ts holds every read tool
   * to a written-down answer, so a new one says which it is.
   */
  list?: string;
  /**
   * The narrowing parameters the host takes off a call to this tool
   * before running it (narrow.ts). Set once, where `TOOLS` is built, on
   * every read tool and on nothing else — a tool never declares these
   * itself.
   */
  narrowing?: readonly NarrowingKey[];
  /**
   * The arguments of this tool that hold an item's id, which the host
   * accepts an item's key in too and resolves before running it
   * (itemKeys.ts, EO-539). Set once, where `TOOLS` is built, on every
   * tool that advertises either spelling of an item id, and always both
   * spellings — a tool takes either. A tool never declares this itself.
   */
  itemKeys?: readonly string[];
  run: (dispatch: Dispatch, args: unknown) => Promise<ToolOutcome>;
  /**
   * The answer to narrow, for a tool whose channel pages its own list.
   *
   * `run` answers one page of the channel's, which is right for a call
   * nobody narrows. But a call that filters, sorts or pages has to be
   * narrowed over the whole list: filtering one channel page and then
   * paging it again with `offset` answers empty pages and a `total` that
   * counts only what the channel happened to send (EO-538). `callTool`
   * calls this instead of `run` when any narrowing parameter is given.
   * Absent on every tool whose channel answers its list whole.
   */
  runWhole?: (dispatch: Dispatch, args: unknown) => Promise<ToolOutcome>;
  /**
   * The same tool under EO's own name, for the ones whose names are
   * deprecated aliases (KAN-162).
   *
   * Built by `channelTool`, because only the call site still has the
   * channel's declared schema to advertise in the other spelling — and
   * read in exactly one place, where `TOOLS` flattens each pair into the
   * list a client is shown. Both halves end up in `TOOLS` as ordinary
   * entries; this reference is what keeps a twin beside the name it
   * replaces rather than in a block at the end.
   *
   * Absent on every tool whose name nobody is migrating away from.
   */
  twin?: ToolSpec;
}

interface ChannelToolSpec<K extends IpcChannel> {
  name: string;
  channel: K;
  description: string;
  kind: ToolKind;
  /** See `ToolSpec.adminOnly`. Absent means every server EO runs offers it. */
  adminOnly?: boolean;
  /** See `ToolSpec.personOnly`. */
  personOnly?: boolean;
  annotations: ToolAnnotations;
  /** See `ToolSpec.list`. */
  list?: string;
  /**
   * What this tool takes, when that is not what its channel takes.
   *
   * Two jobs, and both matter. It is what gets advertised — so
   * `worktrees_list` can offer `repositoryId` as optional where the
   * channel demands it be present. And its *parse output* is what gets
   * dispatched — so `pipeline_export` can pin `destination` to the value
   * that skips the save dialog, rather than merely describing a value it
   * hopes the caller sends.
   *
   * Advertising alone would be decoration: the channel's own defaults
   * would still apply, and for `pipeline_export` that means a modal
   * nobody is there to answer.
   */
  input?: z.ZodType;
  /**
   * The answer as text. Handed the request too, for the one tool whose
   * text depends on what was asked as well as what came back — `item_get`
   * renders the sections a call named (EO-540). Every other render reads
   * the answer alone and declares the one argument.
   */
  render: (data: IpcResponse<K>, request: IpcRequest<K>) => string;
  /**
   * A refusal that arrived on a *successful* call.
   *
   * `items:move` and its neighbours answer `{moved: false,
   * blockedByActiveRun: true}` with `ok: true` — the call worked and the
   * answer is no. Returning the sentence to show turns that into
   * something a model can act on instead of a JSON blob it has to
   * interpret. Null means the call did what was asked.
   *
   * `tool` is **EO's own name for this tool**, which for a release is
   * not always the name the call came in under (KAN-162) — see
   * `canonicalToolName`. Passed in rather than written into the sentence
   * because a literal drifts from the tool it names, and because both
   * halves of an aliased pair have to produce the same words: a refusal
   * that named whichever door the caller knocked on would leave
   * `ticket_move` and `item_move` answering one question two ways.
   */
  refusal?: (data: IpcResponse<K>, tool: string) => string | null;
  /**
   * What of the channel's answer an agent is given as structured data,
   * where that must be less than what the renderer gets (EO-522). Absent,
   * the agent gets the answer whole, as every other tool does.
   *
   * For a channel whose answer carries something the person may read and
   * an agent may not — a step's own environment variables, whose values a
   * person types on the assistant's card. `render` still receives the
   * whole answer, so a tool that sets this must render no more than it
   * gives; `environment_variables_list` is held to both halves by test.
   */
  forAgent?: (data: IpcResponse<K>) => unknown;
}

/**
 * One tool over one channel — and, where its name is a deprecated
 * alias, the twin that replaces it.
 *
 * The generic is bound here, at the call site, so every `render` and
 * `refusal` in the catalog below is written against its own channel's
 * response type and nothing needs a cast to say so.
 *
 * ## The pair (KAN-162)
 *
 * A tool whose name `deprecations.ts` lists comes back with its
 * description prefixed by the retirement notice and its `item_*` twin
 * attached. The twin is the same channel, the same handler, the same
 * `render` and the same `refusal` closure. Building both here rather
 * than deriving the twin later is what makes that true by construction:
 * there is one `ChannelToolSpec` and two readings of it, so a change to
 * either half is a change to both.
 *
 * **The two answer identically, and that is the story's criterion.** A
 * call to either name dispatches the same payload to the same channel
 * and comes back as the same `ToolOutcome` — the same `data`, the same
 * rendered `text`, the same refusal — because every sentence either
 * reading builds names the tool by `canonicalToolName` rather than by
 * the door the call came in through. `callTool` then puts the same
 * structured answer on the wire for both, in the spelling clients
 * registered against. `aliases.test.ts` drives all four combinations of
 * name and argument spelling through the public result to prove it.
 *
 * What the two differ in, past the notice on the description, is
 * exactly one thing: **which spelling of its arguments each
 * advertises.** The deprecated name offers `ticketId`,
 * as it always has; the twin offers `itemId`, which is EO's own word
 * and the only place it can reach a new caller without breaking an
 * installed one. Both *accept* either, so the difference is a
 * suggestion to whoever is reading `tools/list` and never a difference
 * in what a call may say.
 *
 * Derived from the name rather than declared per call site, so the list
 * of aliases lives in one place that the screens telling the person
 * about them read as well.
 */
export function channelTool<K extends IpcChannel>(spec: ChannelToolSpec<K>): ToolSpec {
  const replacement = replacementToolName(spec.name);
  if (replacement === null) return spelledTool(spec, ownSpelling(spec.name), spec.name, spec.description);

  // The old name, with the notice in front of whatever it already said,
  // and EO's own name beside it. The notice is first because a model
  // reads a tool list in order and stops reading a description once it
  // has decided what the tool is for.
  const deprecated = spelledTool(spec, "ticket", spec.name, `${deprecationNotice(replacement)} ${spec.description}`);
  return { ...deprecated, twin: spelledTool(spec, "item", replacement, spec.description) };
}

/**
 * Which vocabulary a tool that is nobody's replacement advertises in
 * (EO-310).
 *
 * The freeze in `legacyNames.ts` is about tools a client *registered
 * against*: their names, their arguments and their answers are frozen
 * because something out there is already calling them, and a rename
 * would break it silently. A tool added after that argument was made has
 * nobody calling it under any name, so there is nothing to keep — and
 * offering `ticketId` on a tool called `item_decide` would be EO
 * inventing a legacy it never had, and contradicting its own tool list
 * in the same breath.
 *
 * Read off the tool's own name rather than declared per tool, so the
 * next one cannot forget: a tool whose name says `item` takes `itemId`.
 * Every `ticket_*` name predates the rename by definition, and every
 * `item_*` twin is built by the branch above rather than by this one.
 */
function ownSpelling(name: string): ToolSpelling {
  return /^items?_/.test(name) || bornInItemVocabulary(name) ? "item" : "ticket";
}

/**
 * Tools added after the rename whose names do not say `item` but take one
 * (EO-541, EO-545). `item_decide`'s reason exactly: nobody has ever called them
 * under another name, so offering them `ticketId` would be EO inventing a
 * legacy it never had. They answer in the boundary's spelling like every
 * other tool. A declaration rather than a constant, so a tool built while
 * this module is still loading finds it.
 */
function bornInItemVocabulary(name: string): boolean {
  return name === "runs_list" || name === "runs_summary" || name === "memories_search";
}

/**
 * Which vocabulary the tool called `name` advertises its arguments in.
 *
 * The whole rule, in one place, because two tests read it as well as
 * `channelTool`: a replacement twin says EO's word by construction, and
 * everything else says whatever its own name says. Exported so those
 * tests ask this rather than restate it — a catalogue snapshot that
 * derived the column for itself is a snapshot that can agree with a
 * stale copy of the rule and disagree with the tools.
 */
export function advertisedSpelling(name: string): ToolSpelling {
  return deprecatedToolName(name) !== null ? "item" : ownSpelling(name);
}

/**
 * One reading of a spec: one name, and one vocabulary for the arguments
 * it advertises.
 *
 * `name` is the tool's identity — what `tools/list` calls it and what
 * `tools/call` finds it by. `canonical` is what EO *says*, and the two
 * differ only on the deprecated half of a pair: every sentence this
 * builds names the tool by EO's own name, so a pair's two readings are
 * word-for-word the same answer. `canonicalToolName` is where that rule
 * is written down.
 */
function spelledTool<K extends IpcChannel>(spec: ChannelToolSpec<K>, spelling: ToolSpelling, name: string, description: string): ToolSpec {
  const canonical = canonicalToolName(spec.name);
  // The caller's identity is never a tool argument (EO-326). Taken off
  // before anything else reads the schema, so no tool — present or added
  // later — can advertise it, and `run` below deletes it from what a
  // call actually sends.
  const declared = withoutCallerIdentity(spec.input ?? ipcContract[spec.channel].request);
  // Which words this tool's arguments are advertised in, and — for a
  // renamed key sent under either spelling — how they reach the channel
  // (see legacyNames.ts). Applied after the override rather than instead
  // of it, so a tool that reshapes its own arguments gets the right
  // spelling of whatever it ended up with, and applied here rather than
  // at each call site so that no tool — present or added later — can
  // forget it.
  const boundary = boundaryArguments(declared, spelling);
  const mustShape = spec.input !== undefined || boundary.translated;
  return {
    name,
    description,
    kind: spec.kind,
    ...(spec.adminOnly === true ? { adminOnly: true } : {}),
    ...(spec.personOnly === true ? { personOnly: true } : {}),
    annotations: spec.annotations,
    ...(spec.list !== undefined ? { list: spec.list } : {}),
    channels: [spec.channel],
    inputSchema: inputSchemaFor(boundary.advertised),
    async run(dispatch, args) {
      // The override runs first, so what reaches the channel is what
      // this tool promised rather than what the client happened to send
      // — `worktrees_list`'s default, `pipeline_export`'s pinned
      // destination. A failure is the caller's argument being wrong, and
      // is reported the way the channel's own validation would report it.
      let shaped: unknown = args;
      if (mustShape) {
        const parsed = boundary.accepts.safeParse(args);
        if (!parsed.success) {
          return { ok: false, message: `Invalid arguments for "${canonical}".`, issues: parsed.error.issues.map((issue) => issue.message) };
        }
        shaped = parsed.data;
      }

      // A channel that takes nothing declares `z.void()`, which rejects
      // `{}` — and `{}` is exactly what every MCP client sends for a
      // tool with an empty schema. Translated once, here, rather than by
      // widening twenty channels to tolerate it.
      let payload = isVoidChannel(spec.channel) ? undefined : shaped;
      // Deleted rather than trusted, whatever the schema above says. The
      // advertised shape does not declare it, but `boundary.accepts` is
      // loose by design and a client that sent it anyway would reach a
      // channel that *does* declare it — and would be acting as a device
      // it named for itself. There is no door in front of the MCP host:
      // on a desktop the person at the keyboard is the caller, and the
      // absent field is what says so.
      if (isActorScopedChannel(spec.channel) && payload !== null && typeof payload === "object") {
        const rest = { ...(payload as Record<string, unknown>) };
        delete rest[ACTING_DEVICE_KEY];
        payload = rest;
      }
      // And never an agent by its own say-so (EO-585). Which system agent
      // is asking is the administrative host's to say, from the credential
      // the turn holds, and it says so in the `dispatch` it hands this
      // tool — after this line, so nothing a client sent survives it.
      payload = withActingAgent(spec.channel, payload, undefined);
      const result = await dispatch(spec.channel, payload);
      if (!result.ok) return { ok: false, message: result.error.message, ...(result.error.issues ? { issues: result.error.issues } : {}) };

      // `handleIpcRequest` has already parsed this against
      // `ipcContract[channel].response` on the way out; re-parsing here
      // would be a second full pass over, say, an item's whole comment
      // thread, bought only to satisfy the compiler.
      //
      // The assertion is unavoidable rather than lazy: with `K` still
      // generic, TypeScript cannot see that the schema which validated
      // the value and the type being narrowed to index the same `K`.
      // What is asserted has already been checked at runtime — one
      // channel over, by the same schema.
      const data = result.data as IpcResponse<K>;
      const refused = spec.refusal?.(data, canonical) ?? null;
      return {
        ok: true,
        text: refused ?? spec.render(data, payload as IpcRequest<K>),
        // Shaped for an agent where the tool says so (EO-522), before the
        // host narrows anything (EO-538): narrowing reads this, never the
        // channel's whole answer.
        data: spec.forAgent === undefined ? data : spec.forAgent(data),
        refused: refused !== null,
      };
    },
  };
}

/**
 * `pipeline_save`, which publishes a graph and cannot accept a risk
 * (EO-405, invariant #11).
 *
 * Whether a webhook pipeline may send without a person reading what
 * arrived is a setting on the pipeline, and it is a person's: turned on
 * by the person pressing the button on the assistant's card for it
 * (EO-522), which goes through `assist:applyCard` to
 * `pipelines:setWebhookUnattended` — and no tool in this catalog reaches
 * either. That alone keeps every agent
 * out — `pipeline:save` has no field for it, so a key sent here would be
 * stripped on the way to the channel and the graph published without it.
 *
 * Which is exactly what this refuses to do quietly. An agent that sends
 * `webhookUnattended` is an agent that meant something by it: it wants
 * the pipeline to publish with nobody in it. Dropping the key and
 * answering "published" would tell it the thing was done — or, where
 * the refusal still stood, leave it looking at an error about an
 * approve step it had just tried to waive. So the call is refused whole,
 * before anything is dispatched, with the reason and what to tell the
 * person (invariant #8).
 *
 * `false` is let through, and removed: asking for the refusal to stand
 * is asking for what already happens, and not a reason to fail a publish.
 *
 * The system agent is the one agent that may reconfigure an
 * installation, and this is decided for it too. Its authority is the
 * person's, delegated — and a risk is the one thing that cannot be
 * delegated to whoever would be reading the payload.
 */
const PIPELINE_SAVE_TOOL: ToolSpec = withoutWebhookUnattended(
  withMachineSpecificSteps(
    channelTool({
      name: "pipeline_save",
      channel: "pipeline:save",
      description:
        "Publish a whole pipeline graph — every step and every route between them, in one call. There is no per-step " +
        "edit: what you send replaces what is there, and a step left out is a step removed. Read the current graph with " +
        "pipeline_get first. A step's `watch` is the one field that leaving out keeps: a step that keeps checking stays " +
        "as it is, `null` makes it run once, and `{ everyMinutes, giveUpAfterHours }` sets it — `giveUpAfterHours` left out is " +
        "a week, and `{ everyMinutes, neverGivesUp: true }` keeps checking until a result however long it takes. `entryRules` is what an " +
        "item must have to enter: left out keeps the pipeline's rules, `[]` clears them, and eo_change_pipeline says how they are written. Where a webhook job files " +
        "onto the pipeline, a graph in which a step that acts outside EO " +
        "can be reached before a human step is refused; a person may accept that for one pipeline by pressing the button " +
        `on the assistant's card for it (\`card\` with the kind \`${WEBHOOK_UNATTENDED_CARD_KIND}\`), and this tool cannot — ` +
        "a call that tries to is refused and publishes nothing.",
      // Without `restoredFrom` (EO-359): restoring who a human step waits on
      // is a person's decision, for the reason `steps:setOwner` is not a
      // tool. A graph published here leaves every step's owner where it is.
      //
      // Without `actions` (EO-426) either: those are the definitions a
      // draft *card* is published with, by a person. A definition the
      // assistant writes itself goes through `role_action_save`, which
      // answers with the save's own reasons.
      input: PipelineSaveInputSchema.omit({ restoredFrom: true, actions: true }),
      kind: "write",
      annotations: { idempotentHint: true, openWorldHint: false },
      render: renderPipelineSaved,
    }),
  ),
);

/**
 * A published graph's answer, with what in its steps looks like it only
 * holds on this machine (EO-450).
 *
 * Read off the steps the call sent, which on a publish are the steps
 * that were saved: `pipeline:save` answers with whether it published and
 * the version, not with the graph. Only on a publish — a refusal saved
 * nothing to advise about — and never a reason for one: the channel has
 * already answered by the time this reads anything.
 */
function withMachineSpecificSteps(tool: ToolSpec): ToolSpec {
  return {
    ...tool,
    async run(dispatch, args) {
      const outcome = await tool.run(dispatch, args);
      // `pipeline:save` refuses with `saved: false` on a successful call, which this tool does not mark as refused.
      if (!outcome.ok || outcome.refused || (outcome.data as IpcResponse<"pipeline:save">).saved !== true) return outcome;
      const steps = PipelineSaveInputSchema.shape.steps.safeParse((args as { steps?: unknown } | null)?.steps);
      if (!steps.success) return outcome;
      const advice = renderMachineSpecific(pipelineMachineSpecificWarnings(steps.data), "the pipeline");
      return advice === "" ? outcome : { ...outcome, text: outcome.text + advice };
    },
    ...(tool.twin === undefined ? {} : { twin: withMachineSpecificSteps(tool.twin) }),
  };
}

/** Refuses a call that would turn the setting on, and takes the key off one that would not. */
function withoutWebhookUnattended(tool: ToolSpec): ToolSpec {
  return {
    ...tool,
    async run(dispatch, args) {
      if (args === null || typeof args !== "object" || !(WEBHOOK_UNATTENDED_KEY in args)) return tool.run(dispatch, args);
      const { [WEBHOOK_UNATTENDED_KEY]: asked, ...rest } = args as Record<string, unknown>;
      // Anything but a plain `false` is read as asking for it. A string,
      // a 1, an object: none of them is "leave the refusal standing",
      // and guessing which way a malformed waiver was meant is guessing
      // in the one direction that publishes.
      if (asked !== false) return { ok: false, message: WEBHOOK_UNATTENDED_AGENT_REFUSAL };
      return tool.run(dispatch, rest);
    },
    ...(tool.twin === undefined ? {} : { twin: withoutWebhookUnattended(tool.twin) }),
  };
}

/**
 * A person's memory, written through MCP (EO-546): the memory panel's
 * own actions, over the panel's own `memory:*` channels, so every rule
 * the panel is held to holds here — and on a project the organisation's
 * record holds, the write is asked of the record by the same path, and
 * nothing is written to this desktop's replica but the rows the record
 * answers with.
 *
 * An entry written here is a person's, because the channel writes every
 * entry as a person's: a client connected to EO's MCP server is acting
 * for the person at this installation, as the system agent does through
 * `eo_admin`. Consolidation never rewrites a person's entry.
 *
 * Writes, not dangerous: nothing is deleted. An edit retires the old
 * version and writes a new one, a retirement only stamps the entry, and
 * `memory_restore` and `memory_consolidation_restore` undo what the
 * others did.
 */
const MEMORY_SCOPE_INPUT = z
  .object({
    kind: MemoryScopeKindSchema.describe("project, workspace or container."),
    id: z.string().min(1).describe("The project's id, the workspace's, or the container item's, as projects_list, workspaces_list, tickets_list or memories_search answers it."),
  })
  .describe("Where the entry is true: across a whole project, of one workspace in it, or only while the work filed under one container item is in progress.");

const MEMORY_TOOL_BODY = z
  .string()
  .trim()
  .min(1)
  .max(MAX_MEMORY_ENTRY_CHARS)
  .describe(`What the entry says: what the next run should know, at most ${MAX_MEMORY_ENTRY_CHARS.toLocaleString("en-US")} characters.`);

const MEMORY_ENTRY_ID = z.string().min(1).describe("The entry's id, as memories_search answers it.");

/**
 * The refusal for a body over what an entry holds — the panel's limit,
 * `MAX_MEMORY_ENTRY_CHARS` — said as a sentence before anything is
 * dispatched, rather than as the channel's invalid-argument error.
 */
function withMemoryToolBodyCap(tool: ToolSpec): ToolSpec {
  return {
    ...tool,
    async run(dispatch, args) {
      const body = isRecord(args) && typeof args["body"] === "string" ? args["body"].trim() : null;
      if (body !== null && body.length > MAX_MEMORY_ENTRY_CHARS) {
        const problem =
          `The entry is ${body.length.toLocaleString("en-US")} characters, and ${tool.name} writes at most ` +
          `${MAX_MEMORY_ENTRY_CHARS.toLocaleString("en-US")}. Nothing was written; shorten it, or split it into more than one entry.`;
        return { ok: true, text: problem, data: { ok: false, problem }, refused: true };
      }
      return tool.run(dispatch, args);
    },
  };
}

/**
 * Undoing a consolidation, answered with what it touched (EO-546).
 *
 * By hand rather than a `channelTool`, because the channel answers with
 * the consolidation and two counts and the tool answers with the entries
 * as well: what it had retired and what a skill it proposed took, active
 * again, and what it had written, retired now — read back from this database through `memory:search`
 * once the restore is done, which on a moved project already holds the
 * rows the record changed.
 */
const MEMORY_CONSOLIDATION_RESTORE_TOOL: ToolSpec = {
  name: "memory_consolidation_restore",
  description:
    "Undo one consolidation of a memory scope: every entry it replaced is active again and every entry it produced is " +
    "retired, in one action, as the memory panel's restore does. Nothing is deleted. Take the consolidation's id from " +
    "memory_consolidations_list or memory_get. Answers with the consolidation, how many entries were restored and " +
    "retired, and those entries as they now stand — or the reason nothing was changed: no consolidation has that id, " +
    "it was already restored, it changed nothing, or the record that holds it could not be reached.",
  kind: "write",
  annotations: { openWorldHint: false },
  channels: ["memory:restoreConsolidation", "memory:search"],
  inputSchema: inputSchemaFor(
    z.object({ consolidationId: z.string().min(1).describe("The consolidation's id, as memory_consolidations_list answers it.") }),
  ),
  async run(dispatch, args) {
    const result = await dispatch("memory:restoreConsolidation", args);
    if (!result.ok) return { ok: false, message: result.error.message, ...(result.error.issues ? { issues: result.error.issues } : {}) };
    const restored = result.data as IpcResponse<"memory:restoreConsolidation">;
    if (!restored.ok) return { ok: true, text: restored.problem, data: { ok: false, problem: restored.problem }, refused: true };
    // What the restore changed, and both of the consolidation's lists for
    // a record too old to say: evidence a skill it proposed took comes
    // back too, and is in neither list.
    const touched = new Set([...restored.changedIds, ...restored.consolidation.retiredIds, ...restored.consolidation.writtenIds]);
    const read = await dispatch("memory:search", { scopeKind: restored.consolidation.scope.kind, scopeId: restored.consolidation.scope.id });
    const entries = read.ok ? (read.data as IpcResponse<"memory:search">).entries.filter((entry) => touched.has(entry.id)) : [];
    const data: MemoryConsolidationRestored = { ...restored, entries };
    if (read.ok) return { ok: true, text: renderMemoryConsolidationRestored(data), data, refused: false };
    // Restored all the same: the read is the only thing that failed, and saying so is the whole of what is missing.
    const entriesUnread = `Its entries could not be read back: ${read.error.message}`;
    return { ok: true, text: `${renderMemoryConsolidationRestored(data)}\n\n${entriesUnread}`, data: { ...data, entriesUnread }, refused: false };
  },
};

const MEMORY_WRITE_TOOLS: readonly ToolSpec[] = [
  withMemoryToolBodyCap(
    channelTool({
      name: "memory_add",
      channel: "memory:add",
      description:
        "Write a memory entry as a person: one fact every later run in the scope is given when it bears on the task, as an " +
        `entry typed in the memory panel is. At most ${MAX_MEMORY_ENTRY_CHARS.toLocaleString("en-US")} characters. A ` +
        "person's entry is never rewritten by consolidation. Answers with the entry as it now stands, or the reason nothing " +
        "was written: no project or workspace has that id, the body is too long, or the record that holds the project could " +
        "not be reached.",
      input: z.object({ scope: MEMORY_SCOPE_INPUT, body: MEMORY_TOOL_BODY }),
      kind: "write",
      annotations: { openWorldHint: false },
      render: renderMemoryWritten("Added to memory, as a person's entry."),
      refusal: (data) => (data.ok ? null : data.problem),
    }),
  ),
  withMemoryToolBodyCap(
    channelTool({
      name: "memory_edit",
      channel: "memory:edit",
      description:
        "Change what an active memory entry says. The old version is retired, as edited, and a new entry is written in its " +
        "place as a person's, which consolidation never rewrites; memory_get on the new one shows the version it replaced. " +
        `At most ${MAX_MEMORY_ENTRY_CHARS.toLocaleString("en-US")} characters. Answers with the new entry, or the reason ` +
        "nothing was written: no entry has that id, it is retired (memory_restore it first), the body is too long, or the " +
        "record that holds the project could not be reached.",
      input: z.object({ id: MEMORY_ENTRY_ID, body: MEMORY_TOOL_BODY }),
      kind: "write",
      annotations: { openWorldHint: false },
      render: renderMemoryWritten("Edited. The old version is retired, and this is the entry now."),
      refusal: (data) => (data.ok ? null : data.problem),
    }),
  ),
  channelTool({
    name: "memory_retire",
    channel: "memory:retire",
    description:
      "Take an active memory entry out of what runs are given. Nothing is deleted: the entry stays, retired, and " +
      "memory_restore puts it back. Answers with the entry as it now stands, or the reason nothing was changed: no entry " +
      "has that id, it is already retired, or the record that holds the project could not be reached.",
    input: z.object({ id: MEMORY_ENTRY_ID }),
    kind: "write",
    annotations: { openWorldHint: false },
    render: renderMemoryWritten("Retired. Runs are no longer given it; memory_restore puts it back."),
    refusal: (data) => (data.ok ? null : data.problem),
  }),
  channelTool({
    name: "memory_restore",
    channel: "memory:restore",
    description:
      "Put a retired memory entry back into what runs are given — one a person retired, an edit replaced, an agent's " +
      "note superseded or a consolidation folded away. Answers with the entry as it now stands, or the reason nothing was changed: no entry has " +
      "that id, it is not retired, or the record that holds the project could not be reached. To undo a whole " +
      "consolidation at once, use memory_consolidation_restore.",
    input: z.object({ id: MEMORY_ENTRY_ID }),
    kind: "write",
    annotations: { openWorldHint: false },
    render: renderMemoryWritten("Restored. Runs are given it again."),
    refusal: (data) => (data.ok ? null : data.problem),
  }),
  MEMORY_CONSOLIDATION_RESTORE_TOOL,
];

/**
 * The guides, reachable by a client that cannot fetch a prompt.
 *
 * The same text `prompts/get` serves. Duplicated as a tool rather than
 * left to the prompt alone because prompt support is uneven — Claude
 * Desktop surfaces them, others do not, and a guide nobody can fetch is
 * worth nothing. One source, two doors; `guides.ts` is the source.
 *
 * Not a `channelTool`: it answers from a constant and touches no handler,
 * which is why it is built by hand here rather than pointed at a channel.
 */
const GUIDE_TOOL: ToolSpec = {
  name: "eo_guide",
  description:
    "How to do something in EO, in more depth than a tool description can carry. Call with no arguments to see what " +
    "guides exist. `eo_orient` is the model and vocabulary EO's tools assume; `eo_submit_work` is how to write a plan " +
    "or a ticket EO will accept and work well; `eo_change_pipeline` is what to know before editing a pipeline graph; " +
    "`eo_unblock` is how to work out why nothing is moving. Read the relevant one before a first attempt rather than " +
    "after a refusal.",
  kind: "read",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  channels: [],
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", enum: GUIDES.map((guide) => guide.name), description: "Which guide. Omit to list them." } },
    additionalProperties: false,
  },
  run: (_dispatch, args) => {
    const name = isRecord(args) && typeof args["name"] === "string" ? args["name"] : null;
    if (name === null) {
      return Promise.resolve({
        ok: true,
        refused: false,
        data: { guides: GUIDES.map((guide) => ({ name: guide.name, title: guide.title, description: guide.description })) },
        text: ["EO's guides — call eo_guide again with one of these names:", "", ...GUIDES.map((guide) => `- \`${guide.name}\` — ${guide.description}`)].join("\n"),
      });
    }

    const guide = guideNamed(name);
    if (guide === undefined) {
      return Promise.resolve({ ok: false, message: `EO has no guide named "${name}". Call eo_guide with no arguments to see what exists.` });
    }
    // The body twice, on purpose. `callTool` attaches `text` as
    // `content` and `data` as `structuredContent` on every answer, and a
    // client may show either; with the guide only in `text`, one that
    // prefers structured output was handed `{name, title}` and no guide
    // — an answer with nothing wrong on the face of it (EO-202). Two
    // doors onto the guide is what the comment above claims, and this is
    // what makes it true of the tool as well as of the prompt.
    return Promise.resolve({ ok: true, refused: false, data: { name: guide.name, title: guide.title, body: guide.body }, text: guide.body });
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * One dispatch, with its answer narrowed to the channel it came from.
 *
 * `channelTool` asserts this once for its single channel, and its
 * comment says why the assertion is honest rather than lazy:
 * `handleIpcRequest` has already parsed the value against
 * `ipcContract[channel].response` on the way out, and re-parsing here
 * would be a second full pass bought only to satisfy the compiler. A
 * tool that touches three channels would need that argument three
 * times, so it is made once here instead.
 */
async function ask<K extends IpcChannel>(
  dispatch: Dispatch,
  channel: K,
  payload: unknown,
): Promise<{ ok: true; data: IpcResponse<K> } | { ok: false; message: string; issues?: string[] }> {
  const result = await dispatch(channel, payload);
  if (!result.ok) return { ok: false, message: result.error.message, ...(result.error.issues ? { issues: result.error.issues } : {}) };
  return { ok: true, data: result.data as IpcResponse<K> };
}

/**
 * The backends EO knows how to fetch a CLI for.
 *
 * Read from the main process's own runtime catalog rather than written
 * down again here. The renderer keeps a second copy for a reason it
 * explains — importing that module would drag `node:fs` into the
 * renderer bundle to read two strings — and this host has no such
 * excuse: it runs in main, beside the thing that resolves and installs
 * these. A third list would be a third thing to keep in step.
 *
 * `runtime:status` takes one provider, and the question a caller
 * actually has is "what does this machine have" — so the tool asks once
 * per entry here and reports them together.
 */
const MANAGED_PROVIDERS: readonly string[] = Object.keys(RUNTIMES);

const RuntimeStatusArgsSchema = z.object({
  provider: z.string().min(1).optional().describe("One backend, by id. Omit to hear about every runtime EO can fetch."),
});

/**
 * What this machine has, for every backend rather than one.
 *
 * Hand-built rather than a `channelTool` because the channel answers
 * about a single provider and the gap this closes is the opposite one:
 * `runtime_install` and `runtime_remove` were offered while nothing
 * reported what was installed, so a client could act on runtimes it
 * could not inspect. A tool that made you name the provider first would
 * leave the same hole for anyone who did not already know the names.
 */
const RUNTIME_STATUS_TOOL: ToolSpec = {
  name: "runtime_status",
  description:
    "Which agent CLIs this machine has, and whether EO may use them. For every backend EO can fetch — or for one, if " +
    "you pass `provider` — this says whether EO's managed copy is installed, whether it is enabled, whether automatic " +
    "updates are on, and which agents are configured on it. Installed and enabled are separate facts: a disabled " +
    "runtime parks every step owned by an agent on that backend without saying so, and this is where that shows. " +
    "Read it before runtime_describe or runtime_install, and whenever an agent is not dispatching. A backend that " +
    "runs inside EO, like `fake`, has no CLI and says so rather than reporting one missing.",
  kind: "read",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  list: "runtimes",
  channels: ["runtime:status"],
  inputSchema: inputSchemaFor(RuntimeStatusArgsSchema),
  async run(dispatch, args) {
    const parsed = RuntimeStatusArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, message: 'Invalid arguments for "runtime_status".', issues: parsed.error.issues.map((issue) => issue.message) };
    }

    const providers = parsed.data.provider === undefined ? MANAGED_PROVIDERS : [parsed.data.provider];
    const entries: RuntimeEntry[] = [];
    for (const provider of providers) {
      const result = await dispatch("runtime:status", { provider });
      if (!result.ok) return { ok: false, message: result.error.message, ...(result.error.issues ? { issues: result.error.issues } : {}) };
      entries.push({ provider, runtime: (result.data as IpcResponse<"runtime:status">).runtime });
    }

    return { ok: true, refused: false, data: { runtimes: entries }, text: renderRuntimes(entries) };
  },
};

const RuntimeDescribeArgsSchema = z.object({
  provider: z.string().min(1).describe("The backend to price, by id. runtime_status reports the ids."),
});

/**
 * The read that makes an install a decision rather than a surprise.
 *
 * Two channels, because the two halves of "should I agree to this" live
 * apart: `runtime:describe` asks the npm registry how big the download
 * is and where it comes from, and `runtime:status` holds who publishes
 * it and the terms being agreed to. Asking both here means a caller
 * gets the whole consent dialog in one answer instead of having to know
 * to make a second call.
 *
 * Status first, and deliberately: a backend that runs in EO's own
 * process has nothing to fetch, and answering that from the local read
 * costs no network round trip at all.
 *
 * Not gated, though `runtime_install` is. Withholding the numbers and
 * offering the download would be exactly backwards — this is what the
 * person deciding reads, so it belongs beside the gated install rather
 * than behind the same switch.
 */
const RUNTIME_DESCRIBE_TOOL: ToolSpec = {
  name: "runtime_describe",
  description:
    "What installing an agent CLI would cost, before any of it is downloaded. This reaches out to the npm registry " +
    "to ask how large the package is and where its tarball comes from, and reports that with the publisher and the " +
    "terms a person would be agreeing to. It downloads nothing and changes nothing. Read it before asking anyone to " +
    "run runtime_install — that tool fetches hundreds of megabytes and is behind the destructive-operations switch, " +
    "and these are the numbers the decision is made on. Provider ids come from runtime_status.",
  kind: "read",
  // The one read in the catalog that leaves the machine. Every other
  // tool here answers from EO's own database or disk; this one is only
  // as available as npm is, and a client that plans around that has to
  // be told which.
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  channels: ["runtime:status", "runtime:describe"],
  inputSchema: inputSchemaFor(RuntimeDescribeArgsSchema),
  async run(dispatch, args) {
    const parsed = RuntimeDescribeArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, message: 'Invalid arguments for "runtime_describe".', issues: parsed.error.issues.map((issue) => issue.message) };
    }

    const { provider } = parsed.data;
    const status = await dispatch("runtime:status", { provider });
    if (!status.ok) return { ok: false, message: status.error.message, ...(status.error.issues ? { issues: status.error.issues } : {}) };

    const { runtime } = status.data as IpcResponse<"runtime:status">;
    if (runtime === null) {
      return {
        ok: true,
        refused: false,
        data: { provider, runtime: null, description: null },
        text:
          `\`${provider}\` has no managed runtime: it either runs inside EO's own process and fetches nothing, or it is not a ` +
          "backend EO knows. Either way there is nothing to download and nothing to price — runtime_status lists the ones there are.",
      };
    }

    const described = await dispatch("runtime:describe", { provider });
    if (!described.ok) return { ok: false, message: described.error.message, ...(described.error.issues ? { issues: described.error.issues } : {}) };

    const description = described.data as IpcResponse<"runtime:describe">;
    return { ok: true, refused: false, data: { provider, runtime, description }, text: renderRuntimeDescription(runtime, description) };
  },
};

/**
 * Whether `key` names a day that happened.
 *
 * The shape is not enough, and the two failures are different. An
 * unparseable key ("yesterday") gives `startOfDayForKey` `NaN` bounds,
 * and the sum between two `NaN`s is $0.00 — a wrong figure that reads
 * exactly like a right one. A key that is well-shaped but impossible
 * ("2026-02-31") is worse: `new Date(2026, 1, 31)` is 3 March rather
 * than an error, so the reply would carry March's spend under February's
 * label, and nothing in it would look odd.
 *
 * Constructing the date and reading the parts back off is the check —
 * a day that rolled over is not the day that went in. Built here rather
 * than in `dateUtils` because it exists for callers EO does not control:
 * every other caller of `startOfDayForKey` is handed a key EO itself
 * formatted.
 */
function isRealCalendarDay(key: string): boolean {
  const [year, month, day] = key.split("-").map(Number);
  const at = new Date(year!, month! - 1, day!, 0, 0, 0, 0);
  return at.getFullYear() === year && at.getMonth() === month! - 1 && at.getDate() === day;
}

const SpendArgsSchema = z.object({
  itemId: z
    .string()
    .min(1)
    .optional()
    .describe("One ticket's whole spend, as well as the day's. Omit to hear only about the day."),
  date: z
    .string()
    // Checked here rather than passed through: the channel takes any
    // string and answers with a figure whatever it made of it, so a
    // caller only ever finds out by not being told.
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be a calendar day written as "YYYY-MM-DD".')
    .refine(isRealCalendarDay, 'date must be a day that exists: "2026-02-31" is not one, and would be answered with 3 March\'s spend labelled 2026-02-31.')
    .optional()
    .describe('Which day, as "YYYY-MM-DD" in the machine\'s own timezone. Omit for today, which is the day the daily budget is measured over.'),
});

// `ticketId` on the wire, `itemId` once parsed — and `itemId` taken too,
// for the reason legacyNames.ts gives. Hand-built tools do not go
// through `channelTool`, so the two of them say so here.
//
// `spend_read` has no `item_*` twin, because its *name* was never
// renamed: there is nothing for a client calling it to migrate to, so
// it keeps the spelling it has always advertised.
const LEGACY_SPEND_ARGS = boundaryArguments(SpendArgsSchema, "ticket");

/**
 * What a calendar day has cost, and what one item has cost.
 *
 * Both, because the two budgets a run is stopped by are measured over
 * exactly these two figures: `perItemBudgetCents` against everything
 * ever spent on one item, `dailyBudgetCents` against everything spent
 * today. A client that could read the limits through guardrails_get and
 * not the spend could see that a budget was $20 and never that $19.40
 * of it was gone.
 *
 * Hand-built rather than a `channelTool` because it is two channels: the
 * day is always read, and the item is read as well when one is named.
 * The day is not optional even when an item was asked about — the
 * daily budget stops that item's next run as surely as its own does,
 * so leaving it out would answer half the question somebody had.
 */
const SPEND_READ_TOOL: ToolSpec = {
  name: "spend_read",
  description:
    "What EO has spent: today across every ticket, and — if you pass `ticketId` — everything one ticket has cost " +
    "across all of its runs. Both include EO's own short model calls, such as memory upkeep, which are listed as " +
    "their own line, and what testing pipeline drafts with real runs cost, which is counted in the day and said apart. These are the two figures the budget guardrails are measured against, so this is how " +
    "you tell how close work is to stopping: EO halts a run, other than the system agent's, the moment the day reaches `dailyBudgetCents` or the " +
    "ticket reaches `perTicketBudgetCents`, and guardrails_get is where those limits are read. Pass `date` as " +
    '"YYYY-MM-DD" for an earlier day. The figures beside the reply are in whole cents, as every amount in EO is.',
  kind: "read",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  channels: ["costs:getDaily", "costs:getForItem"],
  inputSchema: inputSchemaFor(LEGACY_SPEND_ARGS.advertised),
  async run(dispatch, args) {
    const parsed = LEGACY_SPEND_ARGS.accepts.safeParse(args);
    if (!parsed.success) {
      return { ok: false, message: 'Invalid arguments for "spend_read".', issues: parsed.error.issues.map((issue) => issue.message) };
    }

    const daily = await dispatch("costs:getDaily", parsed.data.date === undefined ? {} : { date: parsed.data.date });
    if (!daily.ok) return { ok: false, message: daily.error.message, ...(daily.error.issues ? { issues: daily.error.issues } : {}) };
    const day = daily.data as IpcResponse<"costs:getDaily">;

    let item: SpendReport["item"] = null;
    if (parsed.data.itemId !== undefined) {
      const forItem = await dispatch("costs:getForItem", { itemId: parsed.data.itemId });
      if (!forItem.ok) return { ok: false, message: forItem.error.message, ...(forItem.error.issues ? { issues: forItem.error.issues } : {}) };
      const spent = forItem.data as IpcResponse<"costs:getForItem">;
      item = { itemId: spent.itemId, costCents: spent.costCents, sideCalls: spent.sideCalls };
    }

    const report: SpendReport = { date: day.date, dailyCostCents: day.costCents, dailySideCalls: day.sideCalls, dailyTrialCostCents: day.trialCostCents, item };
    return { ok: true, refused: false, data: report, text: renderSpend(report) };
  },
};

/**
 * Connecting EO to a tracker, from outside EO.
 *
 * Eleven channels were excluded as "settings-screen minutiae", which is
 * a judgement about how interesting a capability looked rather than
 * about whether it could work. Between them they are the whole of
 * wiring EO to Jira and of seeing what it can reach a forge with — a
 * client that can read an item but never say where it mirrors is short
 * of parity by a screen, and a person connecting a fresh EO has no
 * other way to reach any of it.
 *
 * All of these are ordinary tools under the rule the gate runs on: none
 * writes a secret or approves anything, and every one can be read back
 * — through `jira_connections_list` for a site, and through
 * `repositories_list` for a repository's own settings, which is why
 * that listing reports them.
 *
 * `jira_disconnect` is the close call. What it takes away is EO's own
 * configuration, which the person who wrote it can write again — except
 * that on the last repository using a site the stored token goes too.
 * It stays ungated for `run_cancel`'s reason: it is the ordinary way to
 * undo a mirror somebody set up, and a switch you have to open to
 * correct a mistake is a switch that gets left open. What it gets
 * instead is `destructiveHint`, so a client asks first.
 *
 * The exceptions are the three that carry or bind a credential.
 * `jira_connection_save` takes a token inward and proves it against the
 * site before storing it; `jira_connection_remove` deletes one; and
 * `jira_connect` was already behind the switch and stays there. All
 * three are in `GATED_TOOLS` below.
 *
 * Nothing here returns a token, and nothing here can: no response in
 * `ipcContract` carries one, `credentials.ts` is the only module that
 * reads one, and `jiraConnections:list` reports that a credential
 * exists rather than what it is. The tests assert it over the wire
 * against a connection that has one, because it is the property this
 * whole surface would be worth withdrawing over.
 */
const TRACKER_READ_TOOLS: readonly ToolSpec[] = [
  channelTool({
    name: "jira_connections_list",
    channel: "jiraConnections:list",
    description:
      "Every Jira site EO knows about: its id, name and URL, whether it is Cloud or Data Center, the account email, " +
      "whether a token is stored for it on this machine, and how many repositories mirror through it. It reports " +
      "that a credential exists and never what it is — nothing in EO returns a token. Take an id from here for " +
      "jira_connect, which is what points a repository at one of these sites.",
    kind: "read",
    list: "connections",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderJiraConnections,
  }),
  channelTool({
    name: "jira_test",
    channel: "jira:test",
    description:
      "Prove one repository's whole path to Jira and report each step separately: the credentials, then the project " +
      "key, then the fields its feature issue type needs. Credentials that are refused, a project key that does not " +
      "exist and an issue type nobody can create fail for three different reasons, and a single \"it did not work\" " +
      "sends someone to check the wrong one. It changes nothing on either side. Read it after jira_connect, after " +
      "jira_save_config, and whenever jira_outbox shows pushes that will not land. repositoryId comes from " +
      "repositories_list.",
    kind: "read",
    list: "steps",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    render: renderJiraCheck,
  }),
  channelTool({
    name: "jira_fields",
    channel: "jira:fields",
    description:
      "What Jira will accept on a new issue of one type in this repository's project: every field, its id, whether " +
      "it is required, and the values it allows. This is where the `fields` map jira_save_config writes comes from " +
      "— key it by field id rather than by name, and for a field with allowed values send `{ \"id\": \"...\" }` " +
      "naming one of them rather than free text, which Jira rejects at create time. `issueType` is a Jira issue " +
      "type name, like Epic or Story.",
    kind: "read",
    list: "fields",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    render: renderJiraFields,
  }),
  channelTool({
    name: "jira_statuses",
    channel: "jira:statuses",
    description:
      "Every status this repository's Jira workflow has, by name. These are the values jira_save_status_map maps " +
      "EO's pipeline steps onto: the map stores a status name rather than a transition id, because ids are per " +
      "project and which ones exist depends on where the issue currently sits.",
    kind: "read",
    list: "statuses",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    render: renderJiraStatuses,
  }),
  channelTool({
    name: "jira_outbox",
    channel: "jira:outbox",
    description:
      "What EO has not managed to tell Jira yet for one repository: how many pushes are waiting, and how many of " +
      "those have already failed at least once and are being retried. This is the answer to \"the ticket moved here " +
      "and the issue did not move there\" — a queue that only grows is a path that is broken, and jira_test says " +
      "which part of it.",
    kind: "read",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderJiraOutbox,
  }),
  channelTool({
    name: "forge_detect",
    channel: "forge:detect",
    description:
      "What EO can see about a repository's pull-request forge: the remote it would push to, that remote's host, " +
      "whether EO reads it as GitHub or GitLab, whether the matching CLI (`gh` or `glab`) is installed and signed " +
      "in, and which pull-request template it found. EO opens pull requests through that CLI, so a repository whose " +
      "CLI is missing or signed out finishes work and opens nothing. This runs the CLI's own `auth status` and " +
      "changes nothing. A self-hosted host EO cannot classify is reported rather than guessed — name it with " +
      "repository_update (forgeKind), because guessing is how work reaches the wrong kind of server.",
    kind: "read",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    render: renderForgeDetection,
  }),
];

/**
 * What `jira:saveConfig` demands, as what a caller wants to change.
 *
 * `guardrails_set`'s argument, one channel over. The channel is the
 * settings screen's form and wants all four values, because the screen
 * has all four in front of it. A client that wants EO to stop creating
 * a Jira issue for every new item has one boolean, and making it
 * restate the issue types to say so is how a repository that creates
 * Stories quietly starts creating Tasks.
 */
const JiraConfigPatchSchema = z.object({
  repositoryId: z.string().describe("The repository whose Jira settings to change. Ids come from repositories_list."),
  fields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Extra values sent with every issue EO creates, keyed by Jira field id. jira_fields lists the ids. Replaces the stored map."),
  createByDefault: z.boolean().optional().describe("Whether a new ticket creates a Jira issue without being asked."),
  featureIssueType: z.string().min(1).optional().describe("The Jira issue type EO creates for a feature — Epic, unless this project says otherwise."),
  storyIssueType: z.string().min(1).optional().describe("The Jira issue type EO creates for a story."),
});

/** The defaults `jira:connect` uses, for a repository that has never had either set. */
const DEFAULT_FEATURE_ISSUE_TYPE = "Epic";
const DEFAULT_STORY_ISSUE_TYPE = "Story";

const JIRA_SAVE_CONFIG_TOOL: ToolSpec = {
  name: "jira_save_config",
  description:
    "Change what EO sends Jira when it creates an issue for a repository. Send only the fields you mean to change: " +
    "EO reads the repository's current Jira settings, lays yours over them and writes the result, so setting the " +
    "extra fields cannot quietly change which issue type a story becomes. `fields` is keyed by Jira field id — " +
    "jira_fields lists them, with the values each one allows — and replaces the stored map rather than merging into " +
    "it. `createByDefault` decides whether a new ticket mirrors without being asked. Read it back through " +
    "repositories_list, which reports all four, and prove the result with jira_test.",
  kind: "write",
  annotations: { idempotentHint: true, openWorldHint: false },
  // Both halves declared, as `guardrails_set` and `agent_save` declare
  // theirs — which is also what accounts for `jira:saveConfig` in
  // catalog.test.ts's sweep rather than an exclusion.
  channels: ["repositories:list", "jira:saveConfig"],
  inputSchema: inputSchemaFor(JiraConfigPatchSchema),
  async run(dispatch, args) {
    const parsed = JiraConfigPatchSchema.safeParse(args);
    if (!parsed.success) {
      return {
        ok: false,
        message: 'Invalid arguments for "jira_save_config". Nothing has been written.',
        issues: parsed.error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message)),
      };
    }
    const patch = parsed.data;

    const listed = await dispatch("repositories:list", undefined);
    if (!listed.ok) return { ok: false, message: listed.error.message, ...(listed.error.issues ? { issues: listed.error.issues } : {}) };

    // Validated against `RepositoryViewSchema` on the way out of the
    // channel, exactly as `channelTool`'s own assertion is.
    const current = (listed.data as IpcResponse<"repositories:list">).repositories.find((repository) => repository.id === patch.repositoryId);
    if (current === undefined) {
      return { ok: false, message: `EO has no repository with id "${patch.repositoryId}". Call repositories_list for the ones that exist. Nothing has been written.` };
    }

    const merged = {
      repositoryId: current.id,
      fields: patch.fields ?? current.jira.fields ?? {},
      createByDefault: patch.createByDefault ?? current.jira.createByDefault,
      // Null rather than absent for a repository that has never been
      // connected. The channel demands a value, so the fallback is the
      // one `jira:connect` would have used.
      featureIssueType: patch.featureIssueType ?? current.jira.featureIssueType ?? DEFAULT_FEATURE_ISSUE_TYPE,
      storyIssueType: patch.storyIssueType ?? current.jira.storyIssueType ?? DEFAULT_STORY_ISSUE_TYPE,
    };

    const written = await dispatch("jira:saveConfig", merged);
    if (!written.ok) return { ok: false, message: written.error.message, ...(written.error.issues ? { issues: written.error.issues } : {}) };

    const data = written.data as IpcResponse<"jira:saveConfig">;
    if (!data.ok) return { ok: true, refused: true, data, text: `Nothing changed: ${data.problem ?? "EO refused."}` };

    const fields = Object.keys(merged.fields);
    return {
      ok: true,
      refused: false,
      data,
      text: [
        `Saved. ${current.name} creates ${merged.featureIssueType} for features and ${merged.storyIssueType} for stories, and a new ticket ` +
          `${merged.createByDefault ? "creates a Jira issue without being asked" : "creates no Jira issue unless someone asks for one"}.`,
        `Extra fields sent on create: ${fields.length === 0 ? "none" : fields.join(", ")}.`,
        "jira_test proves Jira will accept that; repositories_list reads it back.",
      ].join("\n"),
    };
  },
};

const TRACKER_WRITE_TOOLS: readonly ToolSpec[] = [
  JIRA_SAVE_CONFIG_TOOL,
  channelTool({
    name: "jira_save_status_map",
    channel: "jira:saveStatusMap",
    description:
      "Say which Jira status each of EO's pipeline steps means for one repository. Keys are step ids from " +
      "pipeline_get; values are status names from jira_statuses. When a ticket moves onto a step, EO moves its " +
      "issue to the mapped status. This replaces the whole map rather than merging into it — read the current one " +
      "from repositories_list and send it back with your change, because a step left out stops being mirrored. A " +
      "step with no mapping is a deliberate \"Jira has no opinion about this one\", which most steps are.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: () => "Status map saved. It is the whole map now — repositories_list reports it, and a step missing from it moves nothing in Jira.",
    refusal: (data) => (data.ok ? null : `Nothing changed: ${data.problem ?? "EO refused."}`),
  }),
  channelTool({
    name: "jira_save_transition_fields",
    channel: "jira:saveTransitionFields",
    description:
      "Fill in what a Jira transition insists on before it will run — the \"Resolution is required when moving to " +
      "Done\" kind. `status` is the Jira status being moved to and `values` is keyed by field id. EO learns what a " +
      "transition demands by being refused once, so this is refused for a status nothing is yet known about: " +
      "repositories_list reports the statuses that have requirements recorded, which fields they are, and which of " +
      "them already have a value. What you send here is sent with every later move into that status.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: () => "Transition fields saved. Every later move into that status sends them.",
    refusal: (data) =>
      data.ok
        ? null
        : `Nothing changed: ${data.problem ?? "EO refused."} EO records what a transition needs the first time Jira refuses one, so a status nothing has been pushed into yet has nothing to fill in.`,
  }),
  channelTool({
    name: "jira_disconnect",
    channel: "jira:disconnect",
    description:
      "Stop a repository mirroring to Jira. Its tickets stay exactly where they are and nothing in Jira is touched " +
      "or deleted, but EO forgets which project it mirrored to, the extra fields it sent and its status map — " +
      "reconnecting means setting all of that again. If this was the last repository using that Jira site, the " +
      "site's stored token goes with it and jira_connection_save has to be given a new one; a site other " +
      "repositories still use keeps its credential. jira_connect is what binds it again.",
    kind: "write",
    // Destructive without being gated, as run_cancel is: what it takes
    // away is EO's own configuration, which anyone can put back — but
    // the status map and the field values are not recoverable from
    // anywhere else, and on the last repository of a site the token goes
    // too. A caller should be asked before that, even though the switch
    // does not stand in front of it.
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    render: (data) =>
      data.ok
        ? "Disconnected. The repository mirrors nowhere: its project key, extra fields and status map are gone, and the site's token with them if nothing else was using it."
        : "Nothing changed.",
    refusal: (data) => (data.ok ? null : "Nothing changed: EO has no repository with that id. Call repositories_list for the ones it has."),
  }),
];

/**
 * What EO gives its own agents, offered to a client that can only read
 * it (EO-112).
 *
 * These three were withheld when the catalogues landed, on the argument
 * that a client reached *through* one MCP server must not enumerate the
 * set of them. What that argument missed is the difference between
 * reading and choosing. A client asked "what can this reviewer actually
 * do?" had no way to answer it — an agent's own row says what it is
 * told, and nothing said what it is handed — so the answer was a guess,
 * and a guess about an agent's tool surface is exactly the thing
 * EO-107's lockdown exists to make unnecessary.
 *
 * Reads only, and that was the whole of what this one decided. Writing
 * the two catalogues came next and stands on its own reasoning, at
 * `CATALOGUE_WRITE_TOOLS` below (EO-113), and ticking an entry onto an
 * agent is a third question answered at `AGENT_ATTACHMENT_SET_TOOL`
 * (EO-114). Putting a value in the keychain is a fourth and is still
 * held, on the harder ground the runtime API key is: it has its own
 * exclusion note in catalog.test.ts until that changes.
 *
 * Nothing about a secret is readable through any of them: a server row
 * carries the *names* of the environment variables it wants and
 * `secretsSet` says which of those has a value, and no value is on this
 * contract in either direction. render.ts is where that is kept true for
 * the text a client sees, and dispatch.test.ts sets one and proves it.
 *
 * The agent-facing service is untouched by this, and since EO-182 there
 * are two of those to keep apart. eoServer.mjs — the `eo` server every
 * dispatched agent gets — still offers none of these: an outside client
 * acting for a person is not an implementer mid-run reading its way
 * around its own tool surface. Beside it now runs `eo_admin`, an
 * internal listener serving this whole array to exactly one agent.
 *
 * The rule that separates them is about the agent and not the transport,
 * and it is the same one every comment below states: **no step-owning
 * agent may widen its own tool surface. The system agent may**, because
 * reconfiguring the installation is the whole of its job — the person's
 * authority delegated, rather than an implementer reaching sideways
 * mid-run.
 */
const CATALOGUE_READ_TOOLS: readonly ToolSpec[] = [
  channelTool({
    name: "mcp_servers_list",
    channel: "mcpServers:list",
    description:
      "The MCP servers a person has added to EO: how each one is launched, the environment variables it declares " +
      "and which of those has a value stored, and whether it is switched on. Names only, never values — a stored " +
      "value can never be read back out, by you or by the Settings screen, so the most this says about one is that " +
      "it is set. This is the catalogue and nothing more: agent_attachments_list is what says which agents are " +
      "actually dispatched with which of these. Pass includeArchived to see retired ones, which are kept rather " +
      "than deleted because an attachment can still point at them.",
    kind: "read",
    list: "servers",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderMcpServers,
  }),
  channelTool({
    name: "skills_list",
    channel: "skills:list",
    description:
      "The skills a person has written for EO's agents — instructions delivered beside an agent rather than tools it " +
      "calls. Each answers with its slug, what it is for, whether it is delivered at all, whether the model is " +
      "offered it to choose, who created it (`createdBy`: a person or an agent) and whether a person has locked it " +
      "(`locked`) so no agent can change it. The full body of each travels in the structured reply rather than in the text. This is " +
      "the catalogue: agent_attachments_list is what says which agents get which. Pass includeArchived to see " +
      "retired ones, which attachments can still point at.",
    kind: "read",
    list: "skills",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderSkills,
  }),
  channelTool({
    name: "skill_versions_list",
    channel: "skills:versions",
    description:
      "Every write to one skill, newest first (`id` from skills_list): what it did — create, edit, enable, disable, " +
      "archive, restore, lock, unlock, or sync for a copy taken from the organisation's record — who made it (a " +
      "person, a run by its id, or a memory consolidation by its id) and when. The description of each is in the " +
      "text; its body and files travel in the structured reply. skill_restore_version puts any of them back.",
    kind: "read",
    list: "versions",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderSkillVersions,
    refusal: (data) => data.problem,
  }),
  channelTool({
    name: "agent_attachments_list",
    channel: "agentAttachments:list",
    description:
      "Which catalogued MCP servers and skills each agent is dispatched with — the whole of what EO adds to an " +
      "agent's surface beyond its own instructions and the `eo` server every agent already has. Answers in ids: " +
      "agents_list says which agent each id is, and mcp_servers_list and skills_list say what the attached ids are. " +
      "Pass agentId for one agent, or omit it for every agent that has anything.",
    kind: "read",
    list: "attachments",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderAgentAttachments,
  }),
];

const RunEventsArgsSchema = z.object({
  runId: z.string().describe("The run whose transcript to read. Run ids come from ticket_get."),
  fromSeq: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("The first event to read, inclusive. The reply's cursor is the value to pass next; omit it to start at the beginning."),
});

/** The channel's own largest page, which is how many events one dispatch can carry. */
const RUN_EVENTS_PAGE = 1000;

/**
 * One run's transcript.
 *
 * Hand-built rather than a `channelTool` because the channel pages its
 * own list, and the host's narrowing has to see the whole of it (see
 * `ToolSpec.runWhole`). Called with nothing to narrow, it answers what
 * it always has: one channel page from `fromSeq`, with the cursor for
 * the next. Narrowed, it reads every event from `fromSeq` to the end of
 * the log so far and leaves `where`, `sort`, `offset` and `limit` to the
 * host — so `limit` means one thing on every read tool, and successive
 * offsets walk the same list.
 *
 * `limit` was this tool's own argument until EO-538, sent to the channel
 * as its page size. It is the host's now: the same count of events, from
 * the same place, answered as a narrowed page.
 */
const RUN_EVENTS_TOOL: ToolSpec = {
  name: "run_events",
  description:
    "One run's transcript, a page at a time. `fromSeq` is inclusive and the reply carries the cursor to pass next, " +
    "so following a live run means calling this again from the cursor until it comes back null. Run ids come from " +
    "ticket_get. Given any of fields, where, sort, limit or offset it reads every event from `fromSeq` to the end of " +
    "the log so far and pages them by offset instead of by cursor.",
  kind: "read",
  list: "events",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  channels: ["runs:listEvents"],
  inputSchema: inputSchemaFor(RunEventsArgsSchema),
  async run(dispatch, args) {
    const parsed = RunEventsArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, message: 'Invalid arguments for "run_events".', issues: parsed.error.issues.map((issue) => issue.message) };
    }
    const page = await ask(dispatch, "runs:listEvents", { runId: parsed.data.runId, fromSeq: parsed.data.fromSeq });
    if (!page.ok) return page;
    return { ok: true, refused: false, data: page.data, text: renderRunEvents(page.data) };
  },
  async runWhole(dispatch, args) {
    const parsed = RunEventsArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, message: 'Invalid arguments for "run_events".', issues: parsed.error.issues.map((issue) => issue.message) };
    }
    const events: IpcResponse<"runs:listEvents">["events"] = [];
    let fromSeq: number | null = parsed.data.fromSeq;
    let total = 0;
    while (fromSeq !== null) {
      const page: Awaited<ReturnType<typeof ask<"runs:listEvents">>> = await ask(dispatch, "runs:listEvents", { runId: parsed.data.runId, fromSeq, limit: RUN_EVENTS_PAGE });
      if (!page.ok) return page;
      events.push(...page.data.events);
      fromSeq = page.data.nextSeq;
      total = page.data.total;
    }
    // Every event to the end of the log so far, so no cursor: `nextOffset`
    // is how a narrowed caller reads on.
    const data: IpcResponse<"runs:listEvents"> = { events, nextSeq: null, total };
    return { ok: true, refused: false, data, text: renderRunEvents(data) };
  },
};

/**
 * The reads that were here first.
 *
 * Descriptions are written for a model deciding which tool to reach
 * for, not as a changelog: each says what the tool answers and, where it
 * matters, what to do with the answer.
 *
 * The three arrays below group by *when each landed*, not by kind — a
 * few reads (`pipeline_validate`, `jira_search`, the transfer pair) sit
 * with the writes they shipped beside. What decides whether a tool is
 * offered is its own `kind`, which `gate.ts` reads and
 * `catalog.test.ts` checks against `readOnlyHint`; array membership
 * decides nothing.
 */
const READ_TOOLS: readonly ToolSpec[] = [
  channelTool({
    name: "view_current",
    channel: "view:current",
    description:
      "What the person at EO's keyboard is looking at right now — the screen, and what EO resolved it to. Call this " +
      "before answering anything about \"this\", \"here\" or the current screen, and call it again if you think they " +
      "have moved: it is read live, so a second call after they navigate answers about the new screen. On a ticket " +
      "page it names the ticket, the step it is on and where each of that step's results sends it — which is what " +
      "lets \"move this to Review\" be acted on without the ticket being named. On a pipeline it names the steps, " +
      "what each is holding and the routes between them. On a pipeline's Changes view it names the pipeline, which " +
      "versions are compared — or this machine's own edits and the version they were based on — and what changed. " +
      "Three kinds of thing come back and they are not the same: " +
      "rows EO looked up, the parameters of the view (the filter as typed, what is selected, the sort), and edits " +
      "the person has typed and NOT saved — never act on an unsaved edit as though it were stored. Answers that " +
      "there is no view when no window is open or the screen is one EO does not describe; that is an answer, not a " +
      "failure, and the way to proceed is to ask which ticket or pipeline is meant.",
    kind: "read",
    // Only on `eo_admin`. See `ToolSpec.adminOnly`: this answers with
    // what is on somebody's screen right now, which is the one thing in
    // the catalogue that is about the person rather than the project.
    adminOnly: true,
    // The one read here that is not idempotent, and deliberately so. The
    // hint says "calling this again tells you nothing new", which is
    // true of every other listing and is the exact opposite of what this
    // tool is for: the person walks to another screen and the same call
    // answers differently, with nothing dispatched in between. A model
    // that read `idempotentHint: true` as licence to reuse the first
    // answer would rebuild the staleness EO-192 exists to remove.
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    render: renderCurrentView,
  }),
  channelTool({
    name: "projects_list",
    channel: "projects:list",
    description:
      "Every project in EO, and which one the app window is currently showing. Start here when you do not know what " +
      "exists. Archived projects are listed too, and marked archived: their tickets are paused, not gone. Reading this does not change what the person at the keyboard is looking at, and neither does reading " +
      "anything else — project_set_active is the only tool that moves their window, and it says so.",
    kind: "read",
    list: "projects",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderProjects,
  }),
  channelTool({
    name: "repositories_list",
    channel: "repositories:list",
    description:
      "Every git repository EO drives: where it is checked out, its base branch, its test, lint and build commands, " +
      "and how it is wired to Jira — the project key, the issue types EO creates, the extra fields it sends, which " +
      "Jira status each pipeline step means and what a transition into one demands. That is where jira_save_config, " +
      "jira_save_status_map and jira_save_transition_fields are read back, since each answers only that it worked.",
    kind: "read",
    list: "repositories",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderRepositories,
  }),
  channelTool({
    name: "tickets_list",
    channel: "items:list",
    description:
      "Live work on a project: key, type, which step it sits on, who is on it, and whether it is held, blocked on a " +
      "dependency or waiting on a person. Pass projectId from projects_list to read a project other than the one the " +
      "app window happens to be showing; omit it for that one. Call ticket_get for any of them in full. On a large " +
      "project, filter in EO's own query with stepId or stepName, pipelineId, type, parentKey, keys, text, " +
      "createdSince, updatedSince or atTerminalStep — every one given must hold.",
    kind: "read",
    list: "items",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderItems,
  }),
  channelTool({
    name: "tickets_list_archived",
    channel: "items:listArchived",
    description:
      "Finished work that has left a project. Nothing here is deleted — archiving removes no history. Takes the same " +
      "optional projectId as tickets_list, and the same filters but atTerminalStep: stepId or stepName, pipelineId, " +
      "type, parentKey, keys, text, createdSince and updatedSince, applied in EO's own query.",
    kind: "read",
    list: "items",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderItems,
  }),
  channelTool({
    name: "ticket_get",
    channel: "items:getSections",
    description:
      "One ticket in full: its description, acceptance criteria, dependencies, every run against it, and its whole " +
      "comment thread. Read this before proposing any change to work that already exists. To read part of it, pass " +
      "include with any of ticket, comments, runs, transitions, dependsOn and decision; commentsLimit, commentsSince " +
      "and pinnedOnly narrow the comments, and runsLimit the runs. What is left out is not read at all.",
    kind: "read",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderItem,
  }),
  channelTool({
    name: "inbox_list",
    channel: "inbox:list",
    description:
      "What is waiting on a person right now — agents that asked a question and parked their run until someone " +
      "answers. Re-read this after anything that might have finished; it is the fastest way to see whether the " +
      "pipeline is moving. Takes the same optional projectId as tickets_list.",
    kind: "read",
    list: "items",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderInbox,
  }),
  RUN_EVENTS_TOOL,
  channelTool({
    name: "runs_list",
    channel: "runs:list",
    description:
      "Runs across items, newest first, for timing and spend: each with its item's key, action, backend and model, " +
      "status, start and end, duration, tokens in and out, cache reads and writes, cost, turns and their scope, " +
      "attempt, thread, interruption, how many memory entries it was delivered and how many of those its answer said " +
      "it used (memoryDelivered, memoryUsed) and, on a review, its verdict. EO's own short model calls, such as memory " +
      "upkeep, are listed beside them under the action side_call:<purpose>, so their cost adds up with the runs'. " +
      "Filter in EO's own query by itemId, projectId, action, backend, status, threadId, startedSince and " +
      "startedUntil (epoch milliseconds) — every one given must hold. runs_summary adds the same runs up.",
    kind: "read",
    list: "runs",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderRuns,
  }),
  channelTool({
    name: "runs_summary",
    channel: "runs:summary",
    description:
      "The runs runs_list reads, added up by item, action, backend or day (groupBy) under the same filters: per " +
      "group the count, active minutes (the sum of the runs' durations), elapsed minutes (first start to last end), " +
      "tokens, cost in whole cents and, for reviews, how many rejected; overall is every run the filters matched. " +
      "Side calls are counted as the action side_call:<purpose>, so the cost is the whole of what was spent.",
    kind: "read",
    list: "groups",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderRunSummary,
  }),
  channelTool({
    name: "memories_search",
    channel: "memory:search",
    description:
      "What EO's agents and people have learned: memory entries from every project, workspace and container scope EO holds, newest " +
      "first. Each with its id, scope and the scope's name, body, source (a person, or a run with its run id and item key), " +
      "whether EO extracted it from a run, its state (active, retired, consolidated) and retirement reason, consolidation " +
      "id, whether it contradicts a repository file, the version an edit of it replaced (replacesId), the entries it " +
      "superseded as a note (supersededIds), when it was created and last changed, and how many runs it was delivered " +
      "to and how many said they used it (deliveries, uses) — an entry delivered often and never used is one to question. query is approximate text " +
      "search over the bodies — part of a word, another form of it or a small misspelling still matches — ranked best " +
      "first by bm25, each match with a score. Filter in EO's own query by scopeKind, scopeId, scopeName (a project's or " +
      "workspace's name), projectId, sourceKind (person or run), runId, itemId, extracted, state, contradictsRepositoryFile, " +
      "createdSince, createdUntil, updatedSince and updatedUntil (epoch milliseconds) — every one given must hold. " +
      "state: active is what runs are given now. memory_get reads one entry with its history.",
    kind: "read",
    list: "entries",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderMemorySearch,
  }),
  channelTool({
    name: "memory_get",
    channel: "memory:get",
    description:
      "One memory entry in full by its id from memories_search, with its history: the earlier versions it replaced " +
      "through edits, newest first and every one of them; the entries it superseded, where an agent's note named the " +
      "entries it corrects or repeats (superseded); the consolidation that wrote it, if one did; and the newest " +
      "consolidation that retired it, if one did, with whether that was restored.",
    kind: "read",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderMemoryEntry,
    refusal: (data) => (data.ok ? null : data.problem),
  }),
  channelTool({
    name: "memory_consolidations_list",
    channel: "memory:consolidations",
    description:
      "A memory scope's consolidations, newest first — the times EO folded the scope's agent-written entries into fewer: " +
      "when each started and finished, why it ran, how it ended, how many entries it replaced (replacedCount) and produced " +
      "(producedCount) with their ids, and whether a person restored the set from before it — every one the scope has " +
      "had. Pass the scope as " +
      "memories_search answers it: kind project, workspace or container, and its id.",
    kind: "read",
    list: "consolidations",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderMemoryConsolidations,
  }),
  channelTool({
    name: "memory_consolidate_now",
    channel: "memory:consolidateNow",
    description:
      "Ask EO to consolidate one memory scope now, rather than waiting for it to be due: it runs whether or not the scope " +
      "is over a cap or due on its daily schedule, and even while it is backing off after failures. Everything else holds — " +
      "one consolidation per scope at a time, one scope at a time, only while no pipeline work is waiting or going, never " +
      "while EO is paused — and it is recorded with the trigger manual. Pass the scope as memories_search answers it: kind " +
      "project or workspace, and its id. Answers whether it started, was queued (and behind what), was already queued or " +
      "running, or was refused and why. How it ended is memory_consolidations_list's.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: renderMemoryConsolidateNow,
    refusal: (data) => (data.outcome === "refused" ? data.message : null),
  }),
  channelTool({
    name: "engine_status",
    channel: "engine:status",
    description:
      "Whether EO is dispatching work, and how many agents are running. The system agent carries on while paused, so " +
      "its runs are counted here even then. Re-read this after engine_pause or engine_resume, and whenever a ticket " +
      "seems not to be moving.",
    kind: "read",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderEngineStatus,
  }),
  channelTool({
    name: "registry_get",
    channel: "registry:get",
    description:
      "What this EO knows about: the roles it ships, the action catalog, and the built-in functions a builtin step can run with the " +
      "results each returns. The catalog is every action an agent step can dispatch, by role: what it is for, each result key it " +
      "can return with its label and when to return it, any extra answer fields, whether a pack ships it (read-only) or the role " +
      "defined it (editable with role_action_save), and the pipeline steps that use it. Read this before pipeline_save so an agent " +
      "step names an action its role has and routes every key that action declares, and a builtin step names a function that " +
      "exists and routes every result it has.",
    kind: "read",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderRegistry,
  }),
  channelTool({
    name: "item_types_list",
    channel: "itemTypes:list",
    description:
      "A project's item types: each one's id, label and plural, the word items of it are filed under, whether it holds " +
      "other items or is the work, how many items are of it, and its fields — name, kind, whether required, and what a " +
      "pack wrote about it. Says which are a pack's: a pack's type can only be renamed and never deleted; one made here " +
      "can be reshaped, and deleted while no item is of it. Pass projectId from projects_list; omit it for the project " +
      "the app window is showing. No tool adds, changes or removes a type — that is a card a person presses in the " +
      "assistant's chat.",
    kind: "read",
    list: "types",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    // The channel takes an explicit null for the installation's own
    // types, which no reader of a project means; a project or nothing.
    input: z.object({ projectId: z.string().min(1).optional() }),
    render: renderItemTypes,
  }),
  channelTool({
    name: "agents_list",
    channel: "agents:listDetailed",
    description: "The configured agents: which role each staffs, which backend and model it runs on, and whether it is enabled.",
    kind: "read",
    list: "agents",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderAgents,
  }),
  RUNTIME_STATUS_TOOL,
  RUNTIME_DESCRIBE_TOOL,
  channelTool({
    name: "pipelines_list",
    channel: "pipelines:list",
    description: "The pipelines on a project. Pass includeArchived to see deleted ones, which are archived rather than dropped.",
    kind: "read",
    list: "pipelines",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderPipelines,
  }),
  channelTool({
    name: "pipeline_get",
    channel: "pipelineSteps:list",
    description:
      "One pipeline's steps and the routes between them — where work enters, what each step is for, and which result " +
      "key sends a ticket where. The graph is data, so this is the whole of it.",
    kind: "read",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderPipeline,
  }),
  channelTool({
    name: "modules_list",
    channel: "modules:list",
    description:
      "The custom-module catalog: deterministic code a step can run instead of an agent. A module that is not " +
      "approved will stop a pipeline naming it from publishing.",
    kind: "read",
    list: "modules",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderModules,
  }),
  channelTool({
    name: "module_versions_list",
    channel: "moduleVersions:list",
    description:
      "A custom module's history, newest first: every kept version's number, when it was saved, whether a person " +
      "approved it, how many test cases went with it, and which one is current. Every save that changes a module's " +
      "code or manifest files a version; renaming it files none. module_version_get reads one whole.",
    kind: "read",
    list: "versions",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderModuleVersions,
    refusal: (data) => data.problem,
  }),
  channelTool({
    name: "module_version_get",
    channel: "moduleVersions:get",
    description:
      "One version of a custom module, whole: its name, description, code, manifest and the test cases that went " +
      "with that code, by the number module_versions_list gives. Reading it changes nothing; module_version_restore " +
      "is what puts it back.",
    kind: "read",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderModuleVersion,
    refusal: (data) => (data.version === null ? data.problem : null),
  }),
  channelTool({
    name: "settings_read",
    channel: "settings:get",
    description:
      "EO's own preferences: whether notifications are muted, how long finished work stays on a project before it " +
      "is archived, how often EO pulls from Jira, and the prefix it puts before /<KEY> when it names a branch. " +
      "Read this before settings_write — that tool writes only the keys you name, and this is what tells you what " +
      "the rest are set to.",
    kind: "read",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderSettings,
  }),
  channelTool({
    name: "guardrails_get",
    channel: "guards:get",
    description:
      "The limits EO applies before every dispatch: concurrency caps, attempt limit, run timeout, and spend budgets. " +
      "Of the limits on a run, only the attempt limit applies to the system agent; what it spends still counts towards the budgets. " +
      "guardrails_set changes any of them, one field at a time — read this first to see what you are not changing.",
    kind: "read",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderGuards,
  }),
  SPEND_READ_TOOL,
  channelTool({
    name: "worktrees_list",
    channel: "worktrees:list",
    description:
      "Every git worktree EO is holding, with its branch, its size, whether a run is using it, and whether it holds " +
      "uncommitted changes that exist nowhere else.",
    kind: "read",
    list: "worktrees",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    // The channel's own schema has `repositoryId` nullable but required,
    // so a client would have to be told to send an explicit null — and a
    // model told that will forget. Defaulting it means "every
    // repository" is what you get by saying nothing, which is also the
    // right answer for a caller that has not asked about one.
    input: z.object({ repositoryId: z.string().nullable().default(null) }),
    render: renderWorktrees,
  }),
  ...TRACKER_READ_TOOLS,
  ...CATALOGUE_READ_TOOLS,
];

/**
 * A refusal that arrived on a successful call.
 *
 * Shared by the four item tools that guard the same way, so they
 * cannot come to phrase the same refusal differently. Every one of these
 * names the argument that would get past it — a model told only "no"
 * retries the identical call, or goes looking for another tool.
 */
function activeRunRefusal(verb: string, tool: string, blocked: boolean): string | null {
  if (!blocked) return null;
  // The sentence itself lives with the lock that produces the condition
  // (EO-132), so every refusal for "something is already working on this
  // item" is one wording rather than a family of them. The string this
  // returns is unchanged.
  return blockedByActiveRunRefusal(`${verb} the ticket`, { tool });
}

/**
 * What `guards:set` demands, as what a caller wants to change.
 *
 * `GuardConfigSchema` is a closed object with every field required —
 * right for a settings screen holding every one of them in a form, wrong for a
 * client that wants the daily budget raised. That caller would have to
 * send the concurrency caps and the attempt limit back unchanged, which
 * means reading them first and getting them right, and a model that
 * guesses one of them silently rewrites a limit nobody asked it to
 * touch.
 *
 * So the tool advertises the partial and does the read-merge-write
 * itself. `settings:set` is already this shape by contract and needs no
 * such help — see its doc comment, which makes the same argument about
 * the Do Not Disturb toggle resetting the archive delay.
 */
const GuardPatchSchema = GuardConfigSchema.partial();

// The two budget fields are optional, which is what made this the worst
// of the breakages: zod strips a key it does not know, so a client
// sending `perTicketBudgetCents` was answered "saved" for a write that
// never happened.
const LEGACY_GUARD_PATCH = boundaryArguments(GuardPatchSchema, "ticket");

/**
 * The one tool that is more than one channel.
 *
 * Hand-built rather than a `channelTool` because it dispatches twice —
 * `guards:get` to learn what is there, `guards:set` to write the merge —
 * and `channels` names both, so catalog.test.ts accounts for `guards:set`
 * through this tool rather than through an exclusion.
 *
 * Validating the patch here rather than leaving it to `guards:set` is
 * what makes a refusal readable: the channel's own issues arrive as bare
 * sentences ("Too big: expected number to be <=16") with the field only
 * in a path nobody joins, and a model told a number is too big without
 * being told which number retries the same call. Nothing is written when
 * this refuses — the read has not happened yet.
 */
const GUARDRAILS_SET_TOOL: ToolSpec = {
  name: "guardrails_set",
  description:
    "Change one of EO's limits without restating the others. Send only the fields you mean to change: EO reads the " +
    "current guardrails, lays yours over them and writes the result, so anything you leave out keeps the value " +
    "guardrails_get reports. Budgets are in cents and null means no budget; the timeout is in milliseconds. " +
    "interpretReplies is whether the system agent reads a reply somebody typed to a step that stopped and asked, " +
    "instead of that step simply asking again; it is on unless somebody turned it off. " +
    "Concurrency stays at 1 by design until the loop is provably reliable, the system agent being the one thing it does not hold back — raising it is a decision to make with " +
    "the person, not on their behalf. A value outside its allowed range is refused by name and nothing is written. " +
    "So is a run timeout shorter than a module step's own time limit — raise the step's limit first, or leave the " +
    "run timeout where it is.",
  kind: "write",
  annotations: { idempotentHint: true, openWorldHint: false },
  channels: ["guards:get", "guards:set"],
  inputSchema: inputSchemaFor(LEGACY_GUARD_PATCH.advertised),
  async run(dispatch, args) {
    const parsed = LEGACY_GUARD_PATCH.accepts.safeParse(args);
    if (!parsed.success) {
      return {
        ok: false,
        message: 'Invalid arguments for "guardrails_set". Nothing has been written.',
        // The path is the field, and the field is the whole point of the
        // message: a caller told only that a number is out of range has
        // to guess which of the fields it sent was wrong.
        issues: parsed.error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message)),
      };
    }

    const current = await dispatch("guards:get", undefined);
    if (!current.ok) return { ok: false, message: current.error.message, ...(current.error.issues ? { issues: current.error.issues } : {}) };

    // `current.data` was validated against `GuardConfigSchema` on the way
    // out of the channel, one module over, by the same schema the merge
    // is about to be checked against — the assertion states what has
    // already been proved, exactly as `channelTool`'s does.
    const merged = { ...(current.data as IpcResponse<"guards:get">), ...parsed.data };
    const written = await dispatch("guards:set", merged);
    if (!written.ok) return { ok: false, message: written.error.message, ...(written.error.issues ? { issues: written.error.issues } : {}) };

    const data = written.data as IpcResponse<"guards:set">;
    // A write the channel declined is a refusal, not a result (EO-162):
    // lowering the run timeout under a module step that already asks for
    // longer is the one contradiction it will not store. `refused` is what
    // stops a caller reading "here are the guardrails" as "and they are
    // what I asked for".
    return { ok: true, text: renderGuardsWritten(data), data, refused: !data.saved };
  },
};

/**
 * What `agents:save` demands, as what a caller wants to change.
 *
 * The same argument `GuardPatchSchema` makes, one channel over. The
 * channel is the settings screen's form: it wants the whole agent, and
 * it has the whole agent in front of it. A client that wants an agent
 * moved onto a different model has one field, and making it restate the
 * name, the role, the provider and the entire prompt to change that
 * field is how a prompt somebody wrote gets replaced by a model's guess
 * at what it probably said.
 *
 * Derived from the channel rather than written out again, so a field
 * added to `agents:save` arrives here without anyone remembering to
 * copy it.
 *
 * Through the shape rather than `request.partial()`, which Zod refuses
 * on a schema carrying a refinement — and since EO-319 every request in
 * the contract carries one, the size rule `channel()` applies. Rebuilding
 * from the shape is the right answer rather than a way around it: this is
 * a patch to merge, not a request to dispatch, and the rule belongs to
 * the request that eventually is one.
 */
const AgentPatchSchema = z.object(ipcContract["agents:save"].request.shape).partial();

/** Without an `id` there is nothing to merge with, so these have to arrive. */
const AGENT_CREATE_FIELDS = ["name", "role", "provider", "instructions"] as const;

/**
 * A config patch, laid over the config that is already there (EO-185).
 *
 * The promise this tool makes in its own description — "send only the
 * fields you mean to change and EO lays them over what is there" —
 * stopped at the edge of `config`. Inside it the object was swapped
 * whole, so a caller that knew one key and sent one key deleted every
 * key it had never heard of. That is not a corner: `config` is where an
 * agent's `allowedTools` lives, and an agent saved by something holding
 * a reasoning effort and nothing else came back with no tool surface at
 * all — the failure this whole story is about.
 *
 * Key by key rather than deep, because the values are not trees: an
 * `allowedTools` sent here is a whole new list, which is the only way to
 * *remove* a tool and the reading a caller sending an array expects.
 *
 * `null` removes the key, and that direction has to exist. Merging
 * without it would mean a config key, once written, could never be taken
 * off an agent from here — and this is the surface EO's own system agent
 * reconfigures the installation through, so "you can set it but never
 * unset it" would be a trap with no way out of it. Undefined is not that
 * signal: JSON has no undefined, so every key that arrives arrived
 * deliberately.
 */
function mergedConfig(current: Record<string, unknown>, patch: Record<string, unknown> | undefined): Record<string, unknown> {
  if (patch === undefined) return current;
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/**
 * Create an agent, or change one that exists.
 *
 * A composite for the reason above, and it earns the second channel
 * twice over: the read is also what makes the role refusal possible.
 * `role` is immutable after creation — a pipeline step names the role
 * rather than the agent, so renaming one would leave every step that
 * names it with nobody to dispatch to — and the handler enforces that by
 * simply not passing `role` to `updateAgent`. Silence is the wrong
 * answer to a caller that asked: it would report the save as done and
 * the agent would still staff the old role. So the current row is read
 * and a changed role is refused by name.
 */
const AGENT_SAVE_TOOL: ToolSpec = {
  name: "agent_save",
  description:
    "Create an agent, or change one that exists. Omit `id` to create — that needs name, role, provider and " +
    "instructions, because an agent with no prompt looks staffed and behaves like nothing at all. Pass an existing " +
    "agent's id, from agents_list, to edit: send only the fields you mean to change and EO lays them over what is " +
    "there, so changing the model cannot quietly rewrite the prompt. That goes for `config` too — it is laid over " +
    "key by key, so a config you send one key of keeps the rest, and `null` as a key's value is how you remove one. " +
    "A key holding a list, such as `allowedTools`, is replaced whole by the list you send. `role` is fixed at creation — a pipeline step " +
    "names the role rather than the agent — and an edit that changes it is refused rather than silently ignored. " +
    "`provider` is the backend that runs it: `fake` runs inside EO and fetches nothing, while `claude` and `codex` " +
    "need a runtime this machine actually has, so check runtime_status before moving an agent onto one. `model` " +
    "null means the provider's own default. `projectId` scopes the agent to one project: it then runs only that " +
    "project's tickets, and there it is used instead of the global agents in its role; null makes it global again, " +
    "and a `system` agent is always global, so a project id on one is refused. New instructions take effect on the " +
    "next dispatch, not on a run already in flight.",
  kind: "write",
  annotations: { openWorldHint: false },
  channels: ["agents:listDetailed", "agents:save"],
  inputSchema: inputSchemaFor(AgentPatchSchema),
  async run(dispatch, args) {
    const parsed = AgentPatchSchema.safeParse(args);
    if (!parsed.success) {
      return {
        ok: false,
        message: 'Invalid arguments for "agent_save". Nothing has been written.',
        // Pathed, for `guardrails_set`'s reason: "Use lowercase letters,
        // digits and underscores." names no field, and a caller told
        // that about an object with seven of them has to guess.
        issues: parsed.error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message)),
      };
    }
    const patch = parsed.data;

    if (patch.id === undefined) {
      const missing = AGENT_CREATE_FIELDS.filter((field) => patch[field] === undefined);
      if (missing.length > 0) {
        return {
          ok: false,
          message:
            `Creating an agent needs ${missing.join(", ")}. Pass an existing agent's id from agents_list if you meant ` +
            "to edit one instead. Nothing has been created.",
        };
      }
      return savedAgent(await dispatch("agents:save", patch));
    }

    const listed = await dispatch("agents:listDetailed", undefined);
    if (!listed.ok) return { ok: false, message: listed.error.message, ...(listed.error.issues ? { issues: listed.error.issues } : {}) };

    // Validated against `AgentDetailSchema` on the way out of the
    // channel, exactly as `channelTool`'s own assertion is.
    const current = (listed.data as IpcResponse<"agents:listDetailed">).agents.find((agent) => agent.id === patch.id);
    if (current === undefined) {
      return { ok: false, message: `EO has no agent with id "${patch.id}". Call agents_list for the ones that exist. Nothing has been written.` };
    }

    if (patch.role !== undefined && patch.role !== current.role) {
      return {
        ok: false,
        message:
          `EO does not change an agent's role after it is created. ${current.name} staffs \`${current.role}\`, and a ` +
          `pipeline step names the role rather than the agent — so renaming it would leave every step owned by ` +
          `\`${current.role}\` with nobody to dispatch to. Create a second agent on \`${patch.role}\` instead, or leave ` +
          "role out to change everything else about this one. Nothing has been written.",
      };
    }

    return savedAgent(
      await dispatch("agents:save", {
        id: current.id,
        name: patch.name ?? current.name,
        // Never the caller's, even when it matches: the field the
        // handler acts on is the one that was already there.
        role: current.role,
        provider: patch.provider ?? current.provider,
        // `model` is nullable, so an explicit null is a value and only
        // an absent key means "leave it alone".
        model: patch.model !== undefined ? patch.model : current.model,
        instructions: patch.instructions ?? current.instructions,
        enabled: patch.enabled ?? current.enabled,
        // Laid over rather than swapped in, unlike every field above it:
        // those are scalars where "sent" and "whole" are the same thing,
        // and this one is a bag a caller can hold a corner of.
        config: mergedConfig(current.config, patch.config),
        // Nullable like `model`: an explicit null makes the agent global,
        // and only an absent key leaves its project alone (EO-474). The
        // handler is what refuses a scope on a system agent, so this
        // tool and the Agents screen are told the same sentence.
        projectId: patch.projectId !== undefined ? patch.projectId : current.projectId,
      }),
    );
  },
};

/**
 * What archiving or deleting an agent would take away, in the sentences
 * the person should hear before it happens (EO-350).
 *
 * The same facts, in the same order, as the Agents screen's
 * confirmation: the steps the role owns, whether they are left with
 * nobody or who still covers them, the run it would cancel, and the
 * Assistant losing its last agent.
 */
export function describeAgentRemoval(impact: AgentRemovalImpact): string {
  const parts: string[] = [];
  if (impact.steps.length > 0) {
    const steps = impact.steps.map((step) => `"${step.stepName}" (${step.pipelineName})`).join(", ");
    parts.push(`\`${impact.role}\` owns ${steps}.`);
    if (impact.leavesStepsWithNobody) {
      parts.push(`${impact.agentName} is the last enabled agent on that role: those steps will have nobody, and tickets reaching them will wait until another agent takes the role.`);
    } else if (impact.coveredBy.length > 0) {
      parts.push(`Still covered by ${impact.coveredBy.join(", ")}.`);
    }
  }
  if (impact.activeRuns.length > 0) {
    parts.push(`${impact.agentName} is working on ${impact.activeRuns.map((run) => run.itemKey).join(", ")} now; confirming cancels that run.`);
  }
  if (impact.lastSystemAgent) parts.push("It is the last enabled system agent: the Assistant will have nobody to answer.");
  return parts.join(" ");
}

/** The unconfirmed answer both agent tools give, or the problem that stopped them. */
function unconfirmedAgentRemoval(
  data: { problem: string | null; impact: AgentRemovalImpact | null },
  verb: "archived" | "deleted",
  tool: string,
): string {
  if (data.problem !== null || data.impact === null) return `Nothing was ${verb}: ${data.problem ?? "it refused."} Nothing has changed.`;
  const affected = describeAgentRemoval(data.impact);
  return (
    `Nothing has been ${verb} yet.${affected === "" ? "" : ` ${affected}`} Tell the person, and call ${tool} again with ` +
    "confirm: true only once they have said to go ahead."
  );
}

/**
 * Retire an agent (EO-186).
 *
 * Beside `agent_save` rather than in `CATALOGUE_WRITE_TOOLS`, because an
 * agent is not a catalogue entry: it is who a run was dispatched to.
 * Ungated all the same, and by the same rule the two catalogue archives
 * are — it deletes nothing. The row stays, so its runs, the comments it
 * wrote and the mentions that named it all still resolve; what changes
 * is that nothing dispatches it again.
 *
 * Confirmed like `agent_delete` (EO-350): without `confirm` it answers
 * with what archiving would take away and archives nothing.
 *
 * `destructiveHint` because nothing brings it back. There is no
 * un-archive channel, deliberately, so a client that archives the wrong
 * agent has to create a new one — and `agent_save` with `enabled: false`
 * is the reversible half to reach for first, which the description says
 * out loud for the model that never reads an annotation.
 */
const AGENT_ARCHIVE_TOOL: ToolSpec = channelTool({
  name: "agent_archive",
  channel: "agents:archive",
  description:
    "Retire an agent. It is dispatched to nothing afterwards, it staffs no role, and it stops being offered as a " +
    "step's owner — but the row is kept rather than deleted, so its runs and the comments it wrote still read as " +
    "its own, and agents_list goes on showing it marked archived. Nothing brings it back, so a person who wants " +
    "that agent again has to create one afresh; agent_save with `enabled: false` is the reversible half and is what " +
    "to reach for while you are working out whether an agent is helping. Call it without confirm first: nothing is " +
    "archived, and the answer names every pipeline step the agent's role owns, whether those steps are left with " +
    "nobody (tickets reaching them then wait until another agent takes the role) or who still covers them, the " +
    "ticket of any run it has in progress (confirming cancels it), and whether it is the last system agent. Tell " +
    "the person, and call again with confirm: true only once they have said to go ahead.",
  kind: "write",
  annotations: { destructiveHint: true, openWorldHint: false },
  render: () => "Agent archived. Nothing dispatches it now; the row is kept, so its runs and comments still resolve and agents_list still shows it.",
  refusal: (data, tool) => (data.archived ? null : unconfirmedAgentRemoval(data, "archived", tool)),
});

/**
 * Define an action for a role, or change the definition it has (EO-425).
 *
 * The catalog `registry_get` reads, written. One channel and no rule of
 * its own: what it refuses is what the shared save refuses, so the
 * system agent and the agent screen cannot come to disagree about what
 * a definition may say.
 *
 * Ungated, as `agent_save` is: it deletes nothing, and a save of a pair
 * that exists can be read back and saved again.
 */
const ROLE_ACTION_SAVE_TOOL: ToolSpec = channelTool({
  name: "role_action_save",
  channel: "roleActions:save",
  description:
    "Define an action for a role, or replace the definition that role already has for it. A definition is addressed by " +
    "`role` and `action` together — there is no id — so saving a pair that exists edits it, and what you send replaces the " +
    "whole definition: read it from registry_get first and send back everything you mean to keep. `results` is every " +
    "outcome a run of the action can end in, each with a `key` (lowercase letters, digits and underscores; what the " +
    "step's routes name), a `label` a person reads, and a `meaning` saying when to return it — the agent is shown that " +
    "sentence beside the key. `fields` is a JSON Schema object for any extra answer properties (`properties`, and " +
    "`required` for the ones that must arrive); leave it out for an action that answers with a result and a summary " +
    "alone. EO generates the answer shape from this: `result` as exactly the declared keys, a required `summary` it posts " +
    "to the thread, then the fields — so no field may be named `result` or `summary`. Refused, with every reason and " +
    "nothing written: no results, a repeated key, fields that are not a schema EO can read, an action EO runs for " +
    "itself (respond, interpret, discuss, configure, assist, scenario, clarify), and a pack's own role redefining the " +
    "action that pack ships for it. A custom role may define its own version of a pack's action name, such as review; " +
    "it then answers in this shape and none of the pack's behaviour for that name applies to it. Every step that uses " +
    "the action must route each key it declares, so after adding a key give those steps a route for it with " +
    "pipeline_save. A definition applies to its own role and no other, and takes effect on the next dispatch.",
  kind: "write",
  annotations: { idempotentHint: true, openWorldHint: false },
  render: (data) =>
    data.definition === null
      ? "Nothing was saved."
      : `Saved the ${data.definition.role} role's "${data.definition.action}" action. It can return: ` +
        `${data.definition.results.map((result) => result.key).join(", ")}. Every step that uses it must route each of those keys.`,
  refusal: (data) => (data.saved ? null : `Nothing was saved: ${data.problems.length > 0 ? data.problems.join(" ") : "it refused."} Nothing has changed.`),
});

function savedAgent(result: Awaited<ReturnType<Dispatch>>): ToolOutcome {
  if (!result.ok) return { ok: false, message: result.error.message, ...(result.error.issues ? { issues: result.error.issues } : {}) };

  const data = result.data as IpcResponse<"agents:save">;
  // A refused save is a *refusal* and not a fault (EO-328): the
  // organisation's allowed-backends list is the one thing this channel
  // can now say no to, and it says so in a sentence. Surfaced as
  // `refused` rather than as an error for the reason every other write
  // in this catalogue draws that line — the request was well formed and
  // the answer is "no", which is something a client reports rather than
  // retries. It is also why the policy is enforced in the domain
  // command: this tool and the Agents screen reach the same handler, and
  // a lock only the renderer knew about would let the assistant bind an
  // agent to a backend nobody is allowed to run (ARCHITECTURE.md, "Publish, lock and versions").
  if (!data.saved) return { ok: true, refused: true, data, text: data.problem ?? "Nothing was saved." };
  return { ok: true, refused: false, data, text: renderAgentSaved(data) };
}

/**
 * Setting EO up, from outside EO.
 *
 * These six were excluded as "one-time setup", which is a claim about
 * how often somebody does it rather than about whether they can. A
 * client that can move an item but cannot say which repository the work
 * is in is not at parity with the app, and a person connecting a fresh
 * EO has no other way to reach any of it.
 *
 * All six are ordinary writes under the rule the gate runs on: none
 * deletes, none stores a secret, none approves or installs anything, and
 * every one of them can be read back and corrected. `repositories:remove`
 * is the exception and stays behind the gate, because detaching a
 * repository is the only one of these that takes something away.
 */
const PROJECT_SETUP_TOOLS: readonly ToolSpec[] = [
  channelTool({
    name: "project_create",
    channel: "projects:create",
    description:
      "Create a project. A project is what a person works in: it carries the key prefix every ticket on it is " +
      "numbered with — whichever of its repositories the work is routed to — and it spans one or more repositories — which is how one application across a UI and a " +
      "backend is a single project whose stories each name one repository. The prefix is letters and digits " +
      "starting with a letter (SHOP, WEB2), is fixed at creation because existing keys carry it, and is refused if " +
      "another project already uses it. Pass repositoryIds from repositories_list to give it repositories now, or " +
      "project_add_repository later; naming one twice spans it once, not twice. This does not change what the app " +
      "window is showing — project_set_active does.",
    kind: "write",
    annotations: { openWorldHint: false },
    render: (data) => renderProjectWritten(data, "Created"),
    refusal: (data) => (data.ok ? null : `Nothing was created: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "project_update",
    channel: "projects:update",
    description:
      "Rename a project. Send only the field you mean to change; anything left out keeps the value projects_list " +
      "reports. The key prefix cannot be changed — every key already minted carries it. Which Jira a project " +
      "mirrors into is no longer named here: a project has one Jira connection covering everything on it, " +
      "whichever repository the work is in, and jira_connect is what sets it.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: (data) => renderProjectWritten(data, "Updated"),
    refusal: (data) => (data.ok ? null : `Nothing changed: ${data.problem ?? "it refused."}`),
  }),
  channelTool({
    name: "project_add_repository",
    channel: "projects:addProject",
    description:
      "Give a project another repository to span. Nothing is cloned or copied — the repository is already attached " +
      "to EO by repository_create, and this says the project covers it. Stories on the project can then name it, " +
      "which is what lets one feature produce work in a UI repository and a backend one. A repository belongs to " +
      "one project at a time, so this takes it off whichever project held it. Refused for the Preview project: " +
      "Preview is EO's rehearsal, and a repository belongs on a real project. Read it back with projects_list.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: (data) => renderProjectWritten(data, "Added"),
    refusal: (data) => (data.ok ? null : `Nothing was added: ${data.problem ?? "it refused."}`),
  }),
  channelTool({
    name: "project_remove_repository",
    channel: "projects:removeProject",
    description:
      "Take a repository off a project. It stays attached to EO and nothing on disk is touched, so this is undone " +
      "by project_add_repository — repository_remove is the one that detaches it altogether. Refused while tickets " +
      "on this project belong to that repository: leaving them would point them at a repository the project no " +
      "longer covers, so move or close them first. A repository belongs to one project at a time, so adding it to " +
      "another is what moves it; this leaves it belonging to none.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: (data) => renderProjectWritten(data, "Removed"),
    refusal: (data) => (data.ok ? null : `Nothing was removed: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  // EO-347. Archiving is reversible, so it is an ordinary write, as
  // ticket_archive and ticket_hold are — but it stops agents, so it asks
  // first the way project_delete does: the unconfirmed call is the
  // question, and names every ticket an agent would be stopped on.
  channelTool({
    name: "project_archive",
    channel: "projects:archive",
    description:
      "Archive a project: put it away without deleting anything. While it is archived no agent is dispatched on any " +
      "of its tickets, and it is left out of the project switcher, the board, the Inbox and the attention counts; " +
      "project_restore brings all of it back, and every paused ticket carries on from the step it was on. Call it " +
      "without confirm first: nothing changes, and the answer says how many unfinished tickets would pause and which " +
      "have an agent running. Tell the person, and call again with confirm: true only once they have said to go " +
      "ahead — that stops those runs, and says so on each ticket. A ticket somebody put on hold stays on hold through " +
      "an archive and a restore. A project on the organisation's record is refused: the record owns it.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: (data) => {
      const stopped = data.running.length === 0 ? "" : ` Stopped the agent on ${data.running.map((entry) => entry.itemKey).join(", ")}.`;
      return (
        `Archived "${data.name ?? "the project"}". ${data.unfinishedCount} unfinished ticket(s) are paused until it is restored.${stopped} ` +
        `The app window is showing ${data.activeProjectId === null ? "no project" : `project ${data.activeProjectId}`}.`
      );
    },
    refusal: (data, tool) => {
      if (data.archived) return null;
      if (data.problem !== null) return `EO did not archive it: ${data.problem} Nothing has changed.`;
      const running =
        data.running.length === 0
          ? ""
          : ` An agent is running on ${data.running.map((entry) => entry.itemKey).join(", ")}; archiving stops it.`;
      return (
        `Nothing has been archived yet. "${data.name ?? "This project"}" has ${data.unfinishedCount} unfinished ticket(s), ` +
        `and every one of them pauses until it is restored.${running} Call ${tool} again with confirm: true only once ` +
        "the person has said to archive it."
      );
    },
  }),
  channelTool({
    name: "project_restore",
    channel: "projects:restore",
    description:
      "Restore an archived project. It is back in the project switcher, and every unfinished ticket on it is back in " +
      "front of the scheduler on the step it was on — those whose run the archive stopped included — with nobody " +
      "having to resume them one by one. A ticket that was on hold before the archive is still on hold. " +
      "projects_list says which projects are archived.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: (data) => `Restored "${data.name ?? "the project"}". ${data.unfinishedCount} unfinished ticket(s) are back in front of the scheduler.`,
    refusal: (data) => (data.restored ? null : `EO did not restore it: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  // Every kind of disk, where the three `repository_*` tools are the one
  // kind (EO-301, ARCHITECTURE.md, "A workspace is a kind, attached to the project"). Both doors
  // are offered rather than one
  // replacing the other, for the reason `workspaceCommands.ts` gives at
  // length: `repository_create` means *a checkout* to every caller that
  // has one, and the git kind's own checks — is this path a git
  // repository, is it already attached, which project does it join — are
  // that command's and are not re-derived here. What these add is the
  // three kinds it has no way to say.
  channelTool({
    name: "workspace_list",
    channel: "workspaces:list",
    description:
      "Every workspace a project holds, of every kind — a git repository, a folder somebody already has, a scratch " +
      "directory per run, or no disk at all. Each line says its kind, what it is called, a summary of how it is " +
      "configured, how many tickets are on it, and what is wrong with it right now if anything is: a drive that is " +
      "not mounted this morning is a workspace that cannot be worked in whatever it was when it was attached. Omit " +
      "projectId for every workspace EO knows about, including any a deleted project left behind. repositories_list " +
      "is the same question asked only of the git kind, and reports the Jira binding and forge settings this does not.",
    kind: "read",
    list: "workspaces",
    annotations: { idempotentHint: true, readOnlyHint: true, openWorldHint: false },
    render: renderWorkspaces,
  }),
  channelTool({
    name: "workspace_create",
    channel: "workspaces:create",
    description:
      "Attach somewhere for a project's work to happen. `kind` decides what `config` must hold and is asked first: " +
      '"git-worktree" takes a repository — name and repoPath, and this delegates to the same checks ' +
      "repository_create makes, so a path that is not a git repository is refused by name; \"folder\" takes a path to " +
      "a directory that already exists, and perItemSubfolder to give each ticket a subfolder of its own; " +
      '"scratch" and "none" take nothing at all, because a temporary directory and an empty one have nothing to ' +
      "decide. Every kind joins `projectId`, or the project the window is showing, after the workspaces already " +
      "there, and the window stays where it is. A repository is the one kind that can start a project: with no real " +
      "project to join — none exists, or it would join the gallery's Preview project — one is made, named after the " +
      "repository, and the window switches to it. `keyPrefix` is only for that case and is refused otherwise. A " +
      "`projectId` EO does not have is refused. A step then picks among them with pipeline_save.",
    kind: "write",
    annotations: { openWorldHint: false },
    render: renderWorkspaceCreated,
    refusal: (data) => (data.ok ? null : `Nothing was attached: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "workspace_update",
    channel: "workspaces:update",
    description:
      "Change a workspace's configuration. `config` is a patch in that kind's own shape, laid over what is stored " +
      "rather than replacing it, so changing a folder's path cannot quietly turn its per-ticket subfolders off. " +
      "The kind itself never changes — a repository that became a folder would be the same row meaning something " +
      "else, with every ticket on it still pointing at it. Read it back with workspace_list.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: renderWorkspaceUpdated,
    refusal: (data) => (data.ok ? null : `Nothing changed: ${data.problem ?? "it refused."}`),
  }),
  channelTool({
    name: "repository_create",
    channel: "repositories:create",
    description:
      "Attach a git repository for EO to work in. `repoPath` is a path on this machine that is already a git " +
      "repository: EO clones nothing and fetches nothing, and a path that is not a git repository is refused by " +
      "name rather than stored and discovered later. `baseBranch` is what every agent's worktree is cut from. " +
      "`testCommand`, `lintCommand` and `buildCommand` are what verification shells out to, and null means EO has " +
      "nothing to run for that step — which is worth setting, because a run that cannot be verified is taken on " +
      "trust. The repository joins `projectId`, or the project the app window is showing, after the workspaces " +
      "already there; no project is made and the window stays where it is, and a `projectId` EO does not have is " +
      "refused. Only with no real project to join — none exists, or it would join the gallery's Preview project — is " +
      "one made, named after the repository, and the window switches to it. `keyPrefix` is that new project's key " +
      "prefix, which is what its tickets are numbered with: it is fixed at creation, omitting it derives one from " +
      "the name, and sending one for a repository joining a project is refused.",
    kind: "write",
    annotations: { openWorldHint: false },
    render: renderRepositoryCreated,
    refusal: (data) => (data.ok ? null : `Nothing was attached: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "repository_update",
    channel: "repositories:update",
    description:
      "Change an attached repository: its name, its description, where it is checked out, its base branch, the " +
      "test, lint and build commands verification runs, and how it opens pull requests. Send only the fields you " +
      "mean to change; anything left out keeps the value repositories_list reports. null on a command means EO has " +
      "nothing to run for that step. A repoPath that is not a git repository is refused by name, and so is one " +
      "another repository is already attached to — one checkout is one repository — exactly as on the way in. A " +
      "repository has no key prefix of its own: the prefix its tickets carry is its project's, and projects_list " +
      "reports it.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: renderRepositoryUpdated,
    refusal: (data) => (data.ok ? null : `Nothing changed: ${data.problem ?? "it refused."}`),
  }),
];

/**
 * The one tool that moves what a person is looking at.
 *
 * Offered rather than withheld: it is a thing the app does and a thing
 * somebody can ask for, and a client that cannot do it is not at parity.
 * What withholding it was really protecting against is a *read* that
 * switches the window as a side effect, and the reads are already built
 * so that cannot happen — tickets_list, tickets_list_archived, inbox_list
 * and pipelines_list all take an explicit projectId precisely so that
 * looking at another project never means moving to it. So this says
 * plainly what it does, and the reads keep pointing at that argument.
 *
 * A composite for `agent_save`'s reason rather than `guardrails_set`'s:
 * the read is what makes a refusal possible. `projects:setActive` answers
 * with the active project either way — an id it does not recognise
 * leaves the stored one alone and reports that one back, which reads as
 * success to anything that does not compare the two. So the projects are
 * read first, an id that is not among them is refused by name, and the
 * confirmation names the project rather than echoing an id.
 */
const PROJECT_SET_ACTIVE_TOOL: ToolSpec = {
  name: "project_set_active",
  description:
    "Change which project the app window is showing. This moves what the person at the keyboard is looking at, so " +
    "do it because they asked and not to set up a read of your own: tickets_list, tickets_list_archived, " +
    "inbox_list and pipelines_list all take an explicit projectId, precisely so that reading one project never " +
    "means switching someone to it. Nothing about what EO runs changes either way — the engine advances every " +
    "project regardless of which one is on screen. Take the id from projects_list; one EO does not have is refused " +
    "by name rather than quietly ignored.",
  kind: "write",
  annotations: { idempotentHint: true, openWorldHint: false },
  channels: ["projects:list", "projects:setActive"],
  inputSchema: inputSchemaFor(ipcContract["projects:setActive"].request),
  async run(dispatch, args) {
    const parsed = ipcContract["projects:setActive"].request.safeParse(args);
    if (!parsed.success) {
      return {
        ok: false,
        message: 'Invalid arguments for "project_set_active". The window is still showing whatever it was.',
        issues: parsed.error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message)),
      };
    }

    const listed = await dispatch("projects:list", undefined);
    if (!listed.ok) return { ok: false, message: listed.error.message, ...(listed.error.issues ? { issues: listed.error.issues } : {}) };

    // Validated against `ProjectViewSchema` on the way out of the
    // channel, exactly as `channelTool`'s own assertion is.
    const wanted = (listed.data as IpcResponse<"projects:list">).projects.find((project) => project.id === parsed.data.id);
    if (wanted === undefined) {
      return {
        ok: false,
        message:
          `EO has no project with id "${parsed.data.id}". Call projects_list for the ones that exist. The window is ` +
          "still showing whatever it was showing.",
      };
    }
    // Listed, and not somewhere the window can go (EO-347): an archived
    // project has no board, and `projects:setActive` would answer with
    // the project already showing — which this tool would then report
    // as a switch that happened.
    if (wanted.archivedAt !== null) {
      return {
        ok: false,
        message:
          `"${wanted.name}" is archived, so there is no board of it to show. Restore it with project_restore first. ` +
          "The window is still showing whatever it was showing.",
      };
    }

    const written = await dispatch("projects:setActive", parsed.data);
    if (!written.ok) return { ok: false, message: written.error.message, ...(written.error.issues ? { issues: written.error.issues } : {}) };

    const data = written.data as IpcResponse<"projects:setActive">;
    return {
      ok: true,
      refused: false,
      data,
      text:
        `The app window is now showing ${wanted.name} (id: ${data.activeProjectId ?? "none"}). That is what the ` +
        "person at the keyboard is looking at.",
    };
  },
};

/** What `pipeline_manage` takes. Create and rename in one shape — see the tool for which fields go together. */
const PipelineManageInput = z.object({
  id: z.string().optional(),
  projectId: z.string().optional(),
  name: z.string().min(1).optional(),
  icon: z.string().nullable().optional(),
});

/**
 * A pipeline on the same project already holding the name being asked for.
 *
 * Uniqueness is not a database constraint and this does not invent one:
 * what it protects is name *resolution*. A submitted plan names its
 * pipeline as a string, and `resolvePlacement` matches that against the
 * pipelines the project can see, trimmed and case-insensitively — so two
 * of the same name there is work that could land on either one, decided
 * by array order. Matched the same way, for that reason.
 *
 * "The pipelines the project can see" is `listPipelines`' own rule: its
 * own, plus the ones no project has adopted. A project-less pipeline is
 * therefore in scope for every project, which is why a null `projectId`
 * compares against all of them.
 *
 * Archived ones are excluded. Nothing places work on an archived
 * pipeline, so the name it holds is free.
 */
function pipelineNamed(
  pipelines: IpcResponse<"pipelines:list">["pipelines"],
  projectId: string | null,
  name: string,
  exceptId?: string,
): IpcResponse<"pipelines:list">["pipelines"][number] | null {
  const wanted = name.trim().toLowerCase();
  return (
    pipelines.find(
      (pipeline) =>
        pipeline.archivedAt === null &&
        pipeline.id !== exceptId &&
        (projectId === null || pipeline.projectId === projectId || pipeline.projectId === null) &&
        pipeline.name.trim().toLowerCase() === wanted,
    ) ?? null
  );
}

/** A refusal from this tool: a successful call whose answer is no, in the shape its successes use. */
function pipelineRefusal(problem: string): ToolOutcome {
  return { ok: true, refused: true, text: problem, data: { created: false, pipeline: null, problem } };
}

/**
 * Making a pipeline and renaming one, as a single tool.
 *
 * `pipelines:create` and `pipelines:update` are the same idea at two
 * moments — a name and an icon, with or without an id to hang them on —
 * so they are offered as one description a model reads once rather than
 * two nearly identical ones it has to tell apart.
 *
 * Not a `channelTool`, because it reads `pipelines:list` first, and that
 * read is the whole reason this is written by hand. `pipelines:update`
 * throws on an id no row has, and a throw is "Internal error" by the
 * time it reaches a client — `handleIpcRequest` keeps the detail off a
 * packaged build, and rightly. So the id is checked against what exists
 * and the answer is a sentence. The same read answers the other
 * question worth asking before writing: whether the name is already
 * taken.
 */
const PIPELINE_MANAGE_TOOL: ToolSpec = {
  name: "pipeline_manage",
  description:
    "Create a pipeline, or rename one. Omit `id` and send `projectId` (from projects_list) and `name` to create one; " +
    "the reply carries the new pipeline's id. Send an existing pipeline's `id` with a new `name`, `icon`, or both, " +
    "to change it, and nothing is created. A new pipeline is empty — no steps, no entry step, no routes — so nothing " +
    "can be placed on it and nothing runs through it until pipeline_save publishes a graph into it, which is the " +
    "next call to make and takes the id from here. A name another pipeline on the project already has is refused " +
    "rather than duplicated, because work is placed on a pipeline by name and two of the same name make that " +
    "ambiguous; read what exists from pipelines_list. `icon` is one of square-stack, boxes, database, monitor or " +
    "workflow, and any other name falls back to a generic glyph.",
  kind: "write",
  annotations: { openWorldHint: false },
  channels: ["pipelines:list", "pipelines:create", "pipelines:update"],
  inputSchema: inputSchemaFor(PipelineManageInput),
  async run(dispatch, args) {
    const parsed = PipelineManageInput.safeParse(args);
    if (!parsed.success) {
      return { ok: false, message: `Invalid arguments for "pipeline_manage".`, issues: parsed.error.issues.map((issue) => issue.message) };
    }
    const input = parsed.data;

    // What both branches check themselves against, called inside each of
    // them rather than once above both, so a call missing an argument is
    // told so without a round trip nothing was going to read.
    //
    // Archived pipelines are included because the two questions this
    // answers want opposite halves of it: an id naming an archived
    // pipeline is an id that exists, while the name that pipeline holds
    // is free. It also stops the listing hiding a pipeline whose every
    // step is off-board, which would otherwise be an id a client can
    // hold and not rename.
    const readExisting = () => ask(dispatch, "pipelines:list", { includeArchived: true });

    if (input.id === undefined) {
      if (input.name === undefined) {
        return { ok: false, message: "pipeline_manage needs a `name` to create a pipeline, or the `id` of one to change. It was given neither." };
      }
      if (input.projectId === undefined) {
        return {
          ok: false,
          message: "Creating a pipeline needs the `projectId` it belongs to — read one from projects_list. To change a pipeline that already exists, pass its `id` instead.",
        };
      }

      const listed = await readExisting();
      if (!listed.ok) return listed;

      const clash = pipelineNamed(listed.data.pipelines, input.projectId, input.name);
      if (clash !== null) {
        return pipelineRefusal(
          `Nothing was created: this project already has a pipeline called "${clash.name}" (id: ${clash.id}), and work is ` +
            `placed on a pipeline by name. Pick another name, or pass id: "${clash.id}" to rename that one. Nothing has changed.`,
        );
      }

      const created = await ask(dispatch, "pipelines:create", {
        projectId: input.projectId,
        name: input.name,
        ...(input.icon === undefined ? {} : { icon: input.icon }),
      });
      if (!created.ok) return created;

      const pipeline = created.data.pipeline;
      return {
        ok: true,
        refused: false,
        data: { created: true, pipeline },
        text:
          `Created "${pipeline.name}" (id: ${pipeline.id}). It has no steps, no entry step and no routes, so nothing ` +
          `can be placed on it and nothing runs through it yet — publish a graph into it with pipeline_save, naming that id.`,
      };
    }

    if (input.name === undefined && input.icon === undefined) {
      return {
        ok: false,
        message: "Nothing to change: pass `name`, `icon`, or both, beside `id`. A pipeline's steps and routes are published with pipeline_save, not here.",
      };
    }

    const listed = await readExisting();
    if (!listed.ok) return listed;

    const target = listed.data.pipelines.find((pipeline) => pipeline.id === input.id);
    if (target === undefined) {
      return pipelineRefusal(`EO has no pipeline with id "${input.id}". Read the ids from pipelines_list. Nothing has changed.`);
    }

    if (input.name !== undefined) {
      const clash = pipelineNamed(listed.data.pipelines, target.projectId, input.name, target.id);
      if (clash !== null) {
        return pipelineRefusal(
          `EO did not rename it: this project already has a pipeline called "${clash.name}" (id: ${clash.id}), and work ` +
            `is placed on a pipeline by name. Pick another name. Nothing has changed.`,
        );
      }
    }

    const updated = await ask(dispatch, "pipelines:update", {
      id: input.id,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.icon === undefined ? {} : { icon: input.icon }),
    });
    if (!updated.ok) return updated;

    const pipeline = updated.data.pipeline;
    return {
      ok: true,
      refused: false,
      data: { created: false, pipeline },
      text: `Pipeline ${pipeline.id} is now called "${pipeline.name}". Its steps and routes are untouched — pipeline_save is what changes those.`,
    };
  },
};

/**
 * The two catalogues, written from a client (EO-113).
 *
 * These six were withheld with the reads, on the argument that a client
 * reached *through* one MCP server must not choose the set of them. The
 * distinction that argument does not draw is who is asking: a server or
 * a skill added through a client is a person's request relayed, not code
 * an agent wrote for itself. That is the standing a client already has
 * when it calls `pipeline_save`, `agent_save` or `module_save` — and
 * `module_save` writes code EO later runs unsandboxed with the person's
 * privileges, which is a larger thing to hand a client than a catalogue
 * row.
 *
 * No approval gate, deliberately, and the residual is worth writing down
 * because nothing else catches it. A module needs a person to read its
 * code before a pipeline naming it will publish; a catalogue row gets no
 * equivalent, so a client that has been prompt-injected can add a stdio
 * entry — `command` plus `args` — that runs a local command the next
 * time an agent it is attached to is dispatched. Attaching was the
 * separate decision that narrowed that window, and EO-114 has since
 * opened it: a client that can both add an entry and tick it onto an
 * agent needs no second hand. `AGENT_ATTACHMENT_SET_TOOL` is where that
 * was weighed. If EO ever becomes a shared or multi-person installation,
 * revisit this before anything else here.
 *
 * Ordinary writes, not gated ones, by the rule the gate runs on: these
 * delete nothing, write no secret and approve nothing, and every one of
 * them can be read back through the listing and corrected. Archiving is
 * the exception that still warns — the row survives, but no channel
 * un-archives it, so from here it is one-way and `destructiveHint` is
 * what asks a person first.
 *
 * eoServer.mjs is untouched, as it was for the reads. A tool that let an
 * implementer add a server to EO's catalogue mid-run would be a tool
 * granting itself tools, which is the thing the original argument was
 * actually about.
 *
 * EO-182 scoped that sentence rather than repealing it: it binds a
 * *step-owning* agent. EO's system agent holds these over the internal
 * `eo_admin` server, because filling EO's shelves is the whole of what
 * that role is for — the person's authority delegated, rather than an
 * implementer reaching sideways.
 */
const CATALOGUE_WRITE_TOOLS: readonly ToolSpec[] = [
  channelTool({
    name: "mcp_server_save",
    channel: "mcpServers:save",
    description:
      "Add an MCP server to EO's catalogue, or change one that is there. `transport` decides which half of the " +
      "entry is read: `stdio` is a local process — `command` plus `args`, launched on this machine with the " +
      "person's own privileges whenever an agent that has it is dispatched — while `http` and `sse` are a `url` " +
      "with `headers`. `envNames` declares the *names* of the environment variables the server needs and never " +
      "their values: a value lives in the OS keychain and nothing reads one back out, so a header that needs one " +
      "is written `Authorization: Bearer ${TOKEN}` with `TOKEN` named here. Omit `id` to add a server; pass one " +
      "from mcp_servers_list to edit it in place, and leave `enabled` out to leave the switch as it is. The name " +
      "is the key the model sees in every tool id, so it is lowercase letters, digits, hyphens and underscores; " +
      "`eo` is EO's own server, which every agent already has, and is refused, as is a name another entry holds. " +
      "A refusal comes back as a sentence with nothing saved. What you save is catalogued and nothing more — it " +
      "reaches no agent until it is attached to one.",
    kind: "write",
    annotations: { openWorldHint: false },
    render: renderMcpServerSaved,
    refusal: (data) => (data.saved ? null : `Nothing was saved: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "mcp_server_set_enabled",
    channel: "mcpServers:setEnabled",
    description:
      "Switch a catalogued MCP server on or off. Off means no agent is dispatched with it, whatever is still " +
      "attached to them — the switch a person flips while they work out whether a server is behaving, rather than " +
      "a way to retire one; mcp_server_archive is that. Its own tool rather than a field on mcp_server_save, so " +
      "switching a server off cannot change what it points at in the same call. It takes effect on the next " +
      "dispatch, not on a run already in flight. An id the catalogue does not have is refused by name.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: renderMcpServerSwitched,
    refusal: (data) => (data.server === null ? `Nothing was switched: ${data.problem ?? "it refused."} Nothing has changed.` : null),
  }),
  channelTool({
    name: "mcp_server_archive",
    channel: "mcpServers:archive",
    description:
      "Retire a catalogued MCP server. No agent is dispatched with it again, and mcp_servers_list stops showing it " +
      "unless you pass includeArchived. The row is kept rather than deleted — an attachment that named it still " +
      "resolves, and so does the record of a run that used it — but nothing brings it back, so a person who wants " +
      "it again has to add it afresh. Any values stored for it are left where they are. Ask before calling this " +
      "on a server you did not just add; switching it off with mcp_server_set_enabled is the reversible half.",
    kind: "write",
    annotations: { destructiveHint: true, openWorldHint: false },
    render: () => "MCP server archived. Nothing is dispatched with it now; the row is kept, so mcp_servers_list with includeArchived still shows it.",
    refusal: (data) => (data.archived ? null : `Nothing was archived: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "skill_save",
    channel: "skills:save",
    description:
      "Write a skill into EO's catalogue, or change one that is there. A skill is instructions delivered beside an " +
      "agent rather than a tool it calls: `description` is what the model reads to decide whether this is the one, " +
      "`body` is what it reads once it has, and `files` are supporting files that sit in the skill's own folder " +
      "beside it. `slug` is the only part a model can invoke — leave it out when creating and EO decides one from " +
      "the name, or send one and a spelling that is not a slug comes back refused rather than being rewritten " +
      "under you, because it is the identifier somebody is about to put in a prompt. Omit `id` to add a skill; " +
      "pass one from skills_list to edit it in place, and leave `enabled` and `disableModelInvocation` out to " +
      "leave those switches as they are. A supporting file whose path climbs out of the skill's folder is " +
      "refused, and so is one called SKILL.md, which is where the body goes. A refusal comes back as a sentence " +
      "with nothing saved. `scope` decides which runs it reaches once attached: `{\"kind\":\"global\"}` (a new " +
      "skill's default) for every run, `{\"kind\":\"project\",\"projectId\"}` for runs on that project, " +
      "`{\"kind\":\"workspace\",\"workspaceId\"}` for runs whose step works in that workspace; leave it out on an " +
      "edit to keep the scope it has. What you save is catalogued and nothing more — it reaches no agent until it is " +
      "attached to one.",
    kind: "write",
    annotations: { openWorldHint: false },
    render: renderSkillSaved,
    refusal: (data) => (data.saved ? null : `Nothing was saved: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "skill_set_enabled",
    channel: "skills:setEnabled",
    description:
      "Switch a catalogued skill on or off. Off means it is not delivered at all — which is a different thing from " +
      "`disableModelInvocation` on skill_save, where the skill is delivered but kept out of what the model is " +
      "choosing between. Its own tool rather than a field on the save, so switching a skill off cannot rewrite " +
      "what it says in the same call. It takes effect on the next dispatch, not on a run already in flight. An id " +
      "the catalogue does not have is refused by name.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: renderSkillSwitched,
    refusal: (data) => (data.skill === null ? `Nothing was switched: ${data.problem ?? "it refused."} Nothing has changed.` : null),
  }),
  channelTool({
    name: "skill_archive",
    channel: "skills:archive",
    description:
      "Retire a catalogued skill. No agent is delivered it again, and skills_list stops showing it unless you pass " +
      "includeArchived. The row is kept rather than deleted — an attachment that named it still resolves — and " +
      "skill_restore_version brings it back. The archive is a version in its history, naming who archived it. Ask " +
      "before calling this on a skill you did not just write; switching it off with skill_set_enabled is the " +
      "lighter half.",
    kind: "write",
    annotations: { destructiveHint: true, openWorldHint: false },
    render: () =>
      "Skill archived. It is delivered to nobody now; the row is kept, so skills_list with includeArchived still shows it, " +
      "and skill_restore_version brings it back.",
    refusal: (data) => (data.archived ? null : `Nothing was archived: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "skill_restore_version",
    channel: "skills:restoreVersion",
    description:
      "Put one of a skill's earlier versions back: its description, body and files become that version's, and an " +
      "archived skill is live again. `id` is the skill's and `versionId` one from skill_versions_list. Nothing is " +
      "rewritten — the restore is itself a new version, naming the person who asked for it. A version that is not " +
      "that skill's is refused by name.",
    kind: "write",
    annotations: { openWorldHint: false },
    render: renderSkillRestored,
    refusal: (data) => (data.skill === null ? `Nothing was restored: ${data.problem ?? "it refused."} Nothing has changed.` : null),
  }),
  channelTool({
    name: "skill_set_locked",
    channel: "skills:setLocked",
    description:
      "Lock a skill, or unlock it. While a skill is locked, every write to it whose author is not a person — a " +
      "run's learning review, a memory consolidation, EO's own system agent — is refused, and nothing is written; a person can still edit, " +
      "archive and restore it. A person's act only: EO's own agents are not offered this tool.",
    kind: "write",
    personOnly: true,
    annotations: { idempotentHint: true, openWorldHint: false },
    render: renderSkillLocked,
    refusal: (data) => (data.skill === null ? `Nothing was changed: ${data.problem ?? "it refused."} Nothing has changed.` : null),
  }),
];

/**
 * Ticking a catalogued entry onto an agent, from a client (EO-114).
 *
 * The last of the three arguments the catalogues were withheld on, and
 * the one the exclusion list called sharpest: the reads only enumerate
 * an agent's surface and the catalogue writes only fill a shelf, while
 * this decides what the next dispatch is actually built with. The
 * reading it was held on was that a client reached *through* one MCP
 * server, choosing the set of servers EO's agents get, is a tool
 * granting itself tools with the indirection taken out.
 *
 * That reading was rejected here for the reason the catalogue writes
 * were: it describes the wrong party. The client is not the agent. It is
 * a person's request relayed — the same standing under which a client
 * already calls `agent_save`, which decides the prompt and the model the
 * next dispatch runs on, and `module_save`, which writes code EO later
 * runs unsandboxed with the person's privileges. Neither of those is
 * smaller than handing an agent a catalogue row somebody already
 * approved onto the shelf.
 *
 * Where the reading does hold is a *step-owning* agent, and that is why
 * it is kept rather than deleted: an implementer or a reviewer attaching
 * a server to itself mid-run is the literal case, with no indirection to
 * argue about. EO-107's `settingSources` lockdown exists so that "this
 * agent has these tools" is a true statement, and a running agent that
 * could widen its own surface would make it false again.
 *
 * EO-182 put the boundary where it belongs, which is the agent rather
 * than the transport. EO's system agent holds this tool over the
 * internal `eo_admin` server, and that is not the contradiction it
 * looks like: it owns no pipeline step, so there is no run of its own
 * whose surface it could widen from inside, and deciding what EO's other
 * agents are dispatched with is the entirety of what it is for. The
 * rule, stated once and meant everywhere: **no step-owning agent may
 * widen its own tool surface; the system agent may, because that is its
 * job.**
 *
 * Not destructive, deliberately. Detaching removes the join row and
 * nothing else: the catalogue entry survives, `mcp_servers_list` and
 * `skills_list` still show it, and the same call with `attached: true`
 * puts it back. `mcp_server_archive` and `skill_archive` are the one-way
 * pair, and they carry the hint this does not — the sweep in
 * catalog.test.ts over tools that destroy nothing is what holds that
 * apart.
 *
 * Not a `channelTool`, for the one reason a tool here ever stops being
 * one: the channel's own reply cannot answer the question the tool is
 * for. `agentAttachments:set` answers in ids, and an id says nothing
 * about whether the row behind it is switched on — while a disabled or
 * archived attachment is accepted by the channel and then filtered out
 * by `deliverableAttachments` before a dispatch ever sees it. So the two
 * listings are read back and the render separates delivered from merely
 * attached. Widening the channel's own response instead was the
 * alternative and was rejected: the join is ids by design, and putting
 * catalogue state inside it would be the second copy that gets to go
 * stale.
 */
const AGENT_ATTACHMENT_SET_TOOL: ToolSpec = {
  name: "agent_attachments_set",
  description:
    "Give one agent a catalogued MCP server or skill, or take one away — the tick that decides what EO actually " +
    "dispatches that agent with. `agentId` comes from agents_list, `kind` is `mcpServer` or `skill`, and `id` is a " +
    "row from mcp_servers_list or skills_list. One entry per call, and `attached` says which way: true attaches, " +
    "false detaches. The reply is the agent's whole attachment set afterwards, not just the row you sent, and it " +
    "separates what will actually be delivered from what is merely attached — a disabled or archived entry stays " +
    "attached and reaches no agent, so attaching one is accepted and reported as not delivered rather than " +
    "refused. Attaching what is already attached and detaching what is not are both fine and change nothing. It " +
    "takes effect on the next dispatch, not on a run already in flight. Detaching destroys nothing — the " +
    "catalogue row stays and the same call with `attached: true` puts it back, which is what makes this the " +
    "reversible half of mcp_server_archive. An agent or an entry that no longer exists comes back as a sentence " +
    "with nothing changed.",
  kind: "write",
  annotations: { idempotentHint: true, openWorldHint: false },
  // The two listings are read, never written. They are here because the
  // answer this tool owes is "what will this agent be dispatched with?",
  // and the join it writes carries ids alone — deliberately, so that a
  // renamed or retired row cannot be stale inside it. Resolving them is
  // the only way to tell an attachment that will be delivered from one
  // that will not.
  channels: ["agentAttachments:set", "mcpServers:list", "skills:list"],
  inputSchema: inputSchemaFor(ipcContract["agentAttachments:set"].request),
  async run(dispatch, args) {
    const set = await ask(dispatch, "agentAttachments:set", args);
    if (!set.ok) return set;

    const data = set.data;
    if (data.attachments === null) {
      return {
        ok: true,
        refused: true,
        data,
        text: `Nothing was attached or detached: ${data.problem ?? "it refused."} Nothing has changed.`,
      };
    }

    // Archived rows included on purpose: an attachment may point at one,
    // and the whole question here is which attachments are live. Asking
    // for the live ones only would make an archived entry indexed as
    // missing and reported as the wrong thing.
    const servers = await ask(dispatch, "mcpServers:list", { includeArchived: true });
    const skills = await ask(dispatch, "skills:list", { includeArchived: true });

    // A listing that failed does not fail the tool. The tick is already
    // written, and answering `ok: false` would tell a caller nothing
    // happened when something did — the worst of the available answers.
    // The render drops its delivery claim instead and says it did.
    return {
      ok: true,
      refused: false,
      data,
      text: renderAgentAttachmentSet(data, servers.ok ? servers.data.servers : null, skills.ok ? skills.data.skills : null),
    };
  },
};

/**
 * What `paths` takes on the tools that file or edit an item (EO-704), and
 * the rule for each caller — `comment_post`'s (EO-700), said once for the
 * three of them.
 */
const ITEM_PATHS_RULE =
  "A client of EO's MCP server names any absolute path to a regular file the person's account can read; a " +
  "relative path is refused. EO's own system agent, over eo_admin, names only files inside the directory its turn " +
  "runs in — a path relative to it or an absolute one beneath it, reached through no symbolic link — and a turn " +
  "that runs in no directory can name none. At most 8 files in one call — on a plan, the feature's and every " +
  "story's paths together — each within 20 MB; EO works out each " +
  "file's type and size itself. A path that is missing, not a regular file, too large or not one this caller may " +
  "name refuses the whole call, naming the path and the reason, and nothing is created or changed. ";

const UNGATED_WRITE_TOOLS: readonly ToolSpec[] = [
  channelTool({
    name: "work_submit_plan",
    channel: "work:submitPlan",
    description:
      "Hand EO a decomposition you and the person you are working with have already agreed, and it becomes a feature " +
      "with its stories underneath, placed on a pipeline and ready to be worked. Send `understanding` — what the " +
      "work is, in your words, which is pinned on the feature and is what every agent downstream reads instead of " +
      "your conversation — the `decisions` you settled, and `stories`, each with acceptance criteria someone who did " +
      "not write it could check. Read the pipelines from pipelines_list before naming a `pipeline`: its name is preferred " +
      "and its id is accepted, and one this project does not have is refused, not guessed at. `depends_on` holds indices into your own stories array, and " +
      "`touches` holds repository-relative paths, which EO uses to serialise work that would collide. `priority` is an " +
      "integer, 0 or more, that the scheduler picks highest first — 0 Normal, 1 High, 2 Urgent — and left out it is 0: " +
      "the plan's own `priority` is the feature's, and each story takes only the one it carries, so a story sent without " +
      "one is 0 whatever the feature's is. A negative or fractional one refuses the whole plan. This is the " +
      "same shape and the same validation EO's own system agent goes through; a plan it will not build comes back " +
      "saying why, and nothing is created until it does. Set jiraKey when the feature is already an epic in Jira — " +
      "KAN-10 — and jira_key on a story that is already an issue of its own, and those tickets mirror those issues " +
      "from then on: their status, comments and attachments are pushed there. Attaching also reads each issue in " +
      "shortly after the plan lands — its comments and attachments arrive on the ticket, and Jira's summary, " +
      "description and acceptance criteria replace what you sent, with a note on the ticket recording what they " +
      "replaced. Send the plan you agreed rather than guessing at Jira's wording; Jira's wins where they differ, and " +
      "jira_pull is the same read asked for again. " +
      "Every key is checked before anything is created — one that is not a Jira key, one another EO " +
      "ticket already holds, or the same key on two of your stories refuses the whole plan and creates nothing. " +
      "Leave them out for work Jira has never heard of. Set jiraSync: false to create the feature and every story " +
      "with Jira switched off in both directions, which keeps any key attached for when it is switched back on; a " +
      "story's own jira_sync overrides it. Set base_branch on a story whose branch should be cut from a branch other " +
      "than the repository's base — release/2.4 — and its pull request opens against that branch too, even where the " +
      "story would otherwise stack on an unmerged sibling. The branch has to exist on the repository's remote by the " +
      "time the story is picked up, and a story on a pipeline that does not work on a branch of a git repository " +
      "refuses the plan. Set existing_branch on a story that should be worked on a branch that already exists — " +
      "feature/rate-limits — instead of on one EO cuts: Worktree checks that branch out with every commit on it, " +
      "its pull request opens from it, and EO never renames, deletes, rebases or force-pushes it. It has to exist " +
      "locally or on the repository's remote, and must not be checked out anywhere else, by the time the story is " +
      "picked up. " +
      "paths puts files on the feature as its own, and paths on a story puts them on that story: files on the " +
      "machine running EO that become part of what the item is, beside its description, written with the item so " +
      "the first agent dispatched on it already has them. " +
      ITEM_PATHS_RULE +
      "Read the eo_submit_work guide, via eo_guide, before a " +
      "first plan.",
    kind: "write",
    annotations: { openWorldHint: false },
    render: (data) =>
      data.created
        ? `Created ${data.featureKey} with ${data.storyKeys.length} storie(s): ${data.storyKeys.join(", ")}. They are on the pipeline now and will be picked up in dependency order.`
        : `Nothing was created: ${data.problem ?? "the plan was refused."}`,
    refusal: (data) => (data.created ? null : `Nothing was created: ${data.problem ?? "the plan was refused."} Nothing has changed — fix the plan and send it again.`),
  }),
  channelTool({
    name: "work_submit_ticket",
    channel: "work:submitItem",
    description:
      "Hand EO a single bug or story, rather than a whole decomposition. Use this when the work is one ticket — a bug " +
      "somebody hit, or a story added to a feature that already exists. `parent` is an existing feature's key, and " +
      "leaving it out is ordinary: standalone work is still work. A story needs acceptance criteria someone who did " +
      "not write it could check. A bug needs stepsToReproduce, expected, actual and environment, all of them: filed " +
      "this way it reaches the board without meeting EO's intake, so it has to arrive complete. acceptanceCriteria " +
      "is optional on a bug and kept when you send it — send the ones the person agreed rather than leaving them in " +
      "your conversation, because what the ticket declares is what its review is checked against. `priority` is an " +
      "integer, 0 or more, that the scheduler picks highest first — 0 Normal, 1 High, 2 Urgent — and left out the " +
      "ticket is 0, whatever its parent's is. Read pipelines " +
      "from pipelines_list and name one in `pipeline` — its name is preferred and its id is accepted; one this project " +
      "does not have is refused, not guessed at. Set jiraKey when the work " +
      "is already an issue in Jira — KAN-123 — and the ticket mirrors that issue from then on: its status, comments " +
      "and attachments are pushed there. Attaching also reads the issue in shortly after the ticket lands — its " +
      "comments and attachments arrive on the ticket, and Jira's summary, description and acceptance criteria " +
      "replace the ones you send here, with a note on the ticket recording what they replaced. Send the ticket you " +
      "mean rather than guessing at Jira's wording; Jira's wins where they differ, and jira_pull is the same read " +
      "asked for again. A key another EO ticket already holds is refused, and so is one that is not a " +
      "Jira key. Leave jiraKey out for work Jira has never heard of. Set jiraSync: false to create the ticket with " +
      "Jira switched off in both directions — nothing pushed, nothing pulled — which keeps any key attached for when " +
      "it is switched back on; leave it out to inherit the parent feature's setting, or on when there is no parent. " +
      "paths puts files on the ticket as its own: files on the machine running EO that become part of what the " +
      "ticket is, beside its description, written with the ticket so the first agent dispatched on it already has " +
      "them. " +
      ITEM_PATHS_RULE +
      "Read the eo_submit_work guide, via eo_guide, before a first ticket.",
    kind: "write",
    annotations: { openWorldHint: false },
    render: (data) => (data.created ? `Created ${data.key}. It is on the pipeline now.` : `Nothing was created: ${data.problem ?? "it was refused."}`),
    refusal: (data) => (data.created ? null : `Nothing was created: ${data.problem ?? "it was refused."} Nothing has changed — fix it and send it again.`),
  }),
  channelTool({
    name: "comment_post",
    channel: "comments:post",
    description:
      "Say something on a ticket. This is the only way to communicate in EO: mention an agent by name to hand it the " +
      "work, or mention the human to ask a question. Use parentId to file an answer under the question it answers, " +
      "which is how a reply reaches whoever was waiting. " +
      "paths puts files on the comment in the same call: files on the machine running EO, uploaded and carried " +
      "beside any attachmentIds, and read by an agent later dispatched on the ticket exactly as a file a person " +
      "dropped in. A client of EO's MCP server names any absolute path to a regular file the person's account can " +
      "read; a relative path is refused. EO's own system agent, over eo_admin, names only files inside the " +
      "directory its turn runs in — a path relative to it or an absolute one beneath it, reached through no " +
      "symbolic link — and a turn that runs in no directory can name none. A comment carries at most 8 files, " +
      "paths and attachmentIds together, each within 20 MB; EO works out each file's type and size itself. A path " +
      "that is missing, not a regular file, too large or not one this caller may name refuses the whole call, " +
      "naming the path and the reason, and nothing is posted.",
    kind: "write",
    annotations: { openWorldHint: false },
    // Everything the channel takes except `delivery`, which is a
    // person's choice and stays one (EO-176). Steering pushes a message
    // into a turn that is already running, and agent-to-agent messaging
    // is the loop risk the mention-depth cap exists for (ARCHITECTURE.md, "Agent to agent") — a
    // live
    // channel into a running turn is a worse version of that risk, not a
    // safer one. Omitted from the schema rather than refused at the
    // handler, so it is not something a tool can even ask for.
    // And `paths` (EO-700), which the channel honours only where the host
    // that took the call stamped where they may be read from — see
    // `withPathsFrom` in server.ts.
    input: PostCommentInputSchema.omit({ delivery: true }).extend({ paths: CommentPathsSchema.optional() }),
    render: renderCommentPosted,
    refusal: (data) => (data.commentId === null ? renderCommentPosted(data) : null),
  }),
  channelTool({
    name: "comment_pin",
    channel: "comments:setPinned",
    description:
      "Pin a comment, so it is the one a thread is read from — or unpin one, with pinned: false. A pinned comment " +
      "survives context truncation: when a thread grows past what fits, EO drops ordinary chatter and keeps the " +
      "pinned comments, and the ones pinned on a feature are carried into every story underneath it. Pin the " +
      "decision later work has to honour rather than restating it on each ticket. Comment ids come from ticket_get, " +
      "which marks the pinned ones.",
    kind: "write",
    // Not gated, and not destructive: it takes nothing away — an
    // unpinned comment is still in the thread — and ticket_get reads it
    // back, which is the rule the gate runs on.
    annotations: { idempotentHint: true, openWorldHint: false },
    render: renderCommentPinned,
    // An id that matched nothing is a refusal, not a write that
    // happened. The text is the renderer's own not-found branch rather
    // than a second copy of it, so the two cannot drift into disagreeing
    // about what did not happen.
    refusal: (data) => (data.found ? null : renderCommentPinned(data)),
  }),
  channelTool({
    name: "ticket_update",
    channel: "items:update",
    description:
      "Edit a ticket's title, body, priority, type, acceptance criteria or dependencies, and what it says to Jira. It cannot move a " +
      "ticket between steps — that is ticket_move, and the difference is deliberate: where a ticket sits is the " +
      "engine's business. " +
      "priority is an integer, 0 or more, that the scheduler picks highest first — 0 Normal, 1 High, 2 Urgent. " +
      "acceptanceCriteria is the whole list: what you send is what the ticket ends up with, leaving it out keeps the " +
      "criteria it has, and an empty list is refused rather than read as an instruction to clear them. What they " +
      "were is recorded on the ticket, because they are what a reviewer judges the work against — which is also why " +
      "changing them is refused while an agent is working on the ticket, while it is in review, and once it is " +
      "finished or archived: propose a follow-up instead, or wait for the run to end. On a ticket that mirrors a " +
      "Jira issue they are refused too, naming the issue — the criteria live in its description, EO writes no field " +
      "back to Jira, and an edit here would only be overwritten by the next pull. Edit them in Jira and EO reads " +
      "them back. " +
      "Set jiraKey to attach the ticket to an issue that already exists — KAN-123 — or to move it from the issue it " +
      "mirrors now to another one; the ticket's status, comments and attachments are pushed there from then on. " +
      "Attaching also reads the issue in, moments later — its comments and attachments arrive on the ticket, and " +
      "Jira's summary, description and acceptance criteria replace what the ticket holds, with a note recording " +
      "what they replaced. Do not send a title or body in the same call expecting them to survive attaching; " +
      "Jira's win, and jira_pull is the same read asked for again. Send " +
      "jiraKey: null to detach the ticket, which stops it talking to Jira and drops whatever it still had queued " +
      "for that issue. A key another EO ticket already holds is refused, naming that ticket, and so is one that is " +
      "not a Jira key — nothing is changed when it is refused, this ticket's title included. Set jiraSync: false to " +
      "silence a ticket in both directions — nothing pushed, nothing pulled — while it keeps its key, so " +
      "jiraSync: true resumes against the same issue rather than needing the key again — and reads in whatever was " +
      "written on the issue while it was off. On a feature the switch carries down to every story under it. " +
      "Set baseBranch to cut the ticket's branch from that branch instead of the repository's base, and open its pull " +
      "request against it — it wins over stacking on an unmerged dependency — or send baseBranch: null to go back to " +
      "the repository's base. Only on a ticket that works on a branch of a git repository, and only until its branch " +
      "has been cut: after that it is refused, naming the branch, because where the branch started is already in " +
      "git history. Set existingBranch to have the ticket worked on a branch that already exists instead of one EO " +
      "cuts — its commits are kept, its pull request opens from it, and EO never renames, deletes, rebases or " +
      "force-pushes it — or send existingBranch: null to go back to a branch EO cuts. The same rule applies: only " +
      "until Worktree has checked the branch out, and refused after, naming it. " +
      "Set reference to name the outside ticket this one belongs to — PROJ-123, a GitHub issue, anything — as a " +
      "plain label: it is never sent to Jira or any other tracker, and any number of tickets may hold the same one. " +
      "A story without one of its own reads its feature's. Send reference: null or an empty string to clear it. " +
      "It is trimmed, and refused — with nothing else in the call changed — when it could not appear in a git " +
      "branch name: whitespace, .., ~, ^, :, ?, *, [, \\, @{, //, a leading - or /, a trailing . or /, or a part " +
      "between slashes that starts with . or ends with .lock. " +
      "Dependencies can be changed after filing: addDependsOn lists tickets this one is to wait for from now on, and " +
      "removeDependsOn tickets it is to stop waiting for, each by key — EO-42 — or id. The whole change is judged " +
      "before anything is written: a ticket that does not exist, the ticket itself, one on another project, an edge " +
      "to add that is already there or one to remove that is not, or an addition that would make the dependencies " +
      "circular refuses the whole call, naming the tickets, and nothing in it is changed. They change on the same " +
      "terms as the criteria — not while an agent is working on the ticket, in review, or once it is finished. One " +
      "comment on the ticket says what it now waits for and no longer waits for, and who asked; a ticket that " +
      "waits for an unfinished one is not picked up until that one finishes, and the answer says when a removal " +
      "has left it free to be picked up on the next tick. On a project your organisation's record holds, the record " +
      "makes the change: send the two lists in a call of their own, and if the record cannot be reached nothing " +
      "changes and the answer says so. " +
      "paths adds files to the ticket as its own — part of what it is, beside its description, not said on a " +
      "comment — and removeAttachmentIds takes the ticket's own files off it by id, from ticket_get; a comment's " +
      "file goes only with its comment, and naming one refuses the call. " +
      ITEM_PATHS_RULE.trimEnd(),
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: renderItemUpdated,
    // A refused edit is a successful call whose answer is no: a key
    // another item holds, a key that is not one, an item deleted
    // meanwhile. The handler's own sentence is carried through rather
    // than rewritten, so a client and the board cannot come to describe
    // the same refusal differently.
    refusal: (data) => (data.problem === null ? null : `${data.problem} Nothing has changed.`),
  }),
  channelTool({
    name: "ticket_move",
    channel: "items:move",
    description:
      "Move a ticket to another step of its pipeline, as a person dragging its card would. Pass `comment` with what " +
      "the move is for: moving a ticket backwards almost always means there is a correction to pass on, and the move " +
      "alone tells the next agent nothing but that the ticket arrived. To hand the ticket to another pipeline, send " +
      "`toPipelineId` as well as a `toStepId` that pipeline owns — both columns move together, and a step and a " +
      "pipeline that disagree are refused rather than half-written. Refuses while an agent is working on it.",
    kind: "write",
    annotations: { openWorldHint: false },
    render: renderMoved,
    // Two refusals, and only one of them is about the item. A step that
    // is not the named pipeline's is a fact about the arguments, so the
    // handler's own sentence is the answer — carried through rather than
    // rewritten, so the board and a client cannot come to describe the
    // same refusal differently — with the read that supplies the right
    // ids added, which is the part a client needs and a person does not.
    refusal: (data, tool) =>
      data.problem === null
        ? activeRunRefusal("move", tool, data.blockedByActiveRun)
        : `${data.problem} pipeline_get lists a pipeline's steps and which of them work enters on. Nothing has changed.`,
  }),
  channelTool({
    name: "item_decide",
    channel: "items:decide",
    description:
      "Answer on a step a person acts on: send one of the results that step declares, and EO takes the route that " +
      "result is wired to. This is not `item_move` — a move names a destination, and this names an answer, so the " +
      "pipeline decides where the ticket goes. `pipeline_get` lists each step's results and where each one leads. " +
      "Pass `comment` with why: some results refuse to be taken without one, because a ticket sent back with no " +
      "words leaves whoever picks it up next with nothing to go on. Refuses on a step nobody decides on, on a result " +
      "the step does not declare, and while an agent is working on the ticket.",
    kind: "write",
    annotations: { openWorldHint: false },
    render: renderDecided,
    // One field for every refusal, and the handler's own sentence is the
    // answer — each already names which of them it was, and rewriting it
    // here is how a client and the board come to describe the same
    // refusal differently.
    refusal: (data) => (data.problem === null ? null : data.problem),
  }),
  channelTool({
    name: "item_move_to_version",
    channel: "items:moveToVersion",
    description:
      "Bind a ticket to another version of the pipeline it is already on, older or newer — `version` is a number as " +
      "`pipeline_versions` lists it. A ticket finishes on the version it entered on unless somebody moves it with this. " +
      "Its step, pipeline, assignee and branch stay as they are and it does not move on the board; from here it is " +
      "routed and dispatched by the version you name, and the current version means the pipeline as it stands. One " +
      "comment on the ticket says which version it left, which it is on now and who asked; pass `comment` to add why. " +
      "Refuses, changing nothing, when the ticket's step is not in that version (move it with `item_move` to a step both " +
      "versions have first), when the pipeline does not keep that version, when the ticket is already on it, while an " +
      "agent is working on it, and when it is archived or on no pipeline. To hand a ticket to another pipeline, use " +
      "`item_move` with `toPipelineId`.",
    kind: "write",
    annotations: { idempotentHint: false, openWorldHint: false },
    render: renderMovedToVersion,
    // Every refusal is the handler's own sentence, carried through so the
    // record and a client cannot come to describe the same one differently.
    refusal: (data) => (data.problem === null ? null : `${data.problem} Nothing has changed.`),
  }),
  channelTool({
    name: "ticket_hold",
    channel: "items:hold",
    description:
      "Park a ticket on the step it is already on, so the scheduler stops picking it up. It does not move the ticket " +
      "and records no transition. Refuses while an agent is working on it.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: renderHeld,
    refusal: (data, tool) => activeRunRefusal("hold", tool, data.blockedByActiveRun),
  }),
  channelTool({
    name: "ticket_resume",
    channel: "items:resume",
    description: "Clear a manual hold, leaving the ticket on the step it was already on.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: renderResumed,
    refusal: (data, tool) => activeRunRefusal("resume", tool, data.blockedByActiveRun),
  }),
  channelTool({
    name: "ticket_archive",
    channel: "items:setArchived",
    description:
      "Put a finished ticket away, or bring an archived one back. Archiving deletes nothing and removes no history — " +
      "it only takes the ticket off the project.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: renderArchived,
  }),
  channelTool({
    name: "run_cancel",
    channel: "runs:cancel",
    description:
      "Interrupt an agent mid-run. Whatever it had not finished is discarded, and the ticket stays where it is — and " +
      "stays put: EO does not start that step again by itself afterwards, until somebody mentions an agent, moves the " +
      "ticket, or holds and resumes it. Run ids come from ticket_get.",
    kind: "write",
    // Destructive without being gated: it throws away work in progress,
    // which a caller should be told about — but it is also the ordinary
    // way to stop something going wrong, and putting it behind the
    // switch would make the switch the thing you reach for in a hurry.
    annotations: { destructiveHint: true, openWorldHint: false },
    render: renderRunCancelled,
  }),
  channelTool({
    name: "engine_pause",
    channel: "engine:pause",
    description:
      "Stop EO dispatching new work, except the system agent's runs, which carry on while paused: its chats, mentions " +
      "of it, reading a reply on a parked step, and any step its role owns. Runs already in flight continue unless " +
      "cancelRunning is set, and even then the system agent's are left running. Nothing else moves until engine_resume.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: renderEngineStatus,
  }),
  channelTool({
    name: "engine_resume",
    channel: "engine:resume",
    description: "Start dispatching again after engine_pause.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: renderEngineStatus,
  }),
  // An ordinary write, and not gated, because an empty pipeline does
  // nothing: it routes nothing and runs nothing until a graph is
  // published into it, and `pipeline_save` already refuses a graph
  // naming an unapproved module. `pipeline_delete` is the gated one, and
  // for a reason that does not apply here — archiving a pipeline
  // archives the items on it.
  PIPELINE_MANAGE_TOOL,
  channelTool({
    name: "pipeline_validate",
    channel: "pipeline:validate",
    description:
      "Check a pipeline graph without publishing it. Writes nothing. Call this before pipeline_save — a graph with a " +
      "blocking problem is refused there anyway, and this says what is wrong while it is still cheap to fix.",
    kind: "read",
    list: "problems",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderPipelineProblems,
  }),
  PIPELINE_SAVE_TOOL,
  /**
   * What a person does when the pipelines section is managed (EO-331,
   * ARCHITECTURE.md, "Divergence and suggestions").
   *
   * The other half of the lock. Until this existed, an assistant told
   * "that section is managed by your organisation" had nothing to offer
   * but the sentence — the prompt said say so and stop, because there
   * was nowhere for the change to go. Now there is: this makes the
   * local copy editable, pushes it to the organisation's server as a
   * suggestion, and leaves an administrator to approve it.
   *
   * Not gated and not admin-only, on the same reading as
   * `pipeline_save`: it publishes nothing and locks nothing. What it
   * does is write a document into somebody's review queue, which is the
   * mildest thing EO can do with a change nobody here is allowed to
   * make. Invariant #11 is untouched — no tool surface widens, and the
   * one agent that could reconfigure the installation still reaches
   * nothing here it did not already.
   */
  channelTool({
    name: "pipeline_suggest",
    channel: "pipelines:suggest",
    description:
      "Suggest a change to a pipeline your organisation manages. Use this when pipeline_save is refused because the " +
      "pipelines section is managed: it makes this machine's copy editable, sends it to the organisation's server as a " +
      "suggestion, and an administrator approves it or sends it back with a reason. Edit the copy with pipeline_save " +
      "first if the change is not in it yet, then call this. It publishes nothing by itself.",
    kind: "write",
    annotations: { openWorldHint: false },
    render: renderSuggested,
  }),
  channelTool({
    name: "pipeline_versions",
    channel: "pipeline:versions",
    description:
      "What changed between two versions of a pipeline, and every version it has. Saving a pipeline files a version; " +
      "work already on the pipeline finishes on the version it entered on, so this is how you find out what an item " +
      "mid-flight is actually routing by. Defaults to the newest pair. Name a version number as `graph` to be sent " +
      "that version's whole graph, which is how a version is restored: publish it with pipeline_save, which files " +
      "it as a new version. Who each human step waits on is not restored that way — it stays as it is, and putting " +
      "it back is for a person: in EO's help chat, the version's graph proposed as a draft with `restoredFrom` set to " +
      "its number is a card whose Publish restores them too.",
    kind: "read",
    list: "versions",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderPipelineVersions,
  }),
  /**
   * A held template update, read whole (EO-534, ARCHITECTURE.md,
   * "Template versions and origins"). What the brief of a Fix with
   * assistant chat tells the system agent to read first: the versions,
   * the release notes, the three graphs, every changed key with its three
   * values and which side changed it, and the person's edits since the
   * base. A read — it resolves nothing, and nothing an agent can call
   * does: publishing a draft or pressing Keep my pipeline is a person's.
   */
  channelTool({
    name: "pipeline_update_conflict",
    channel: "pipeline:updateConflict",
    description:
      "A pipeline's held template update: the template and both versions, the release notes, the three graphs (the base the " +
      "pipeline was made from, the pipeline as the person has it now, and the new template version) in the pipeline's own step " +
      "ids, every key somebody changed with its base, current and template values and which side changed it — conflicts first — " +
      "and the person's own edits since the base, from the pipeline's versions. Read this before proposing drafts that resolve " +
      "the update. Writes nothing and resolves nothing: the update is resolved only when the person publishes a draft from the " +
      "chat about it, or presses Keep my pipeline.",
    kind: "read",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderUpdateConflict,
    refusal: (data) => (data.conflict === null ? data.problem : null),
  }),
  channelTool({
    name: "pipeline_move_step_items",
    channel: "pipeline:moveStepItems",
    description:
      "Move everything sitting on one step to another, so the first step can be removed. This is the answer to " +
      "pipeline_save refusing a graph because a step it drops still holds items. Each item moves through the ordinary " +
      "transition path and gets a note in its thread saying why. Archived items and items with an agent working on " +
      "them are left where they are, and counted.",
    kind: "write",
    annotations: { openWorldHint: false },
    render: renderStepItemsMoved,
  }),
  channelTool({
    name: "module_save",
    channel: "modules:save",
    description:
      "Write a custom module: deterministic code a pipeline step runs instead of an agent. The manifest is the whole " +
      "of what it may reach — the binaries and environment variables it is given, whether it gets the network — and " +
      "its `results` are the outcomes a route can be drawn from, so a result you do not declare is one no step can " +
      "route. Omit `id` to create one; pass an existing module's id to replace it in place. What you save is " +
      "unapproved and stays unapproved: EO will not publish a pipeline naming an unapproved module, so nothing here " +
      "runs until a person has read the code and approved it with module_approve. Editing an approved module's code " +
      "or manifest withdraws that approval for the same reason, and so does adding a test case it did not have: any " +
      "change to an approved module's test cases withdraws its approval. Approving runs the module's test cases and refuses a module with " +
      "none, so save a new module with its `tests`: [{ description, source }], each written exactly as module_test_save " +
      "describes. They are added to the module in the same write — a case it already has with the same description and " +
      "source is not added twice, and nothing is ever removed or replaced through here (module_test_save edits a case, " +
      "module_test_delete removes one). Saving re-runs the tests in the background; module_tests_run waits for a result.",
    kind: "write",
    annotations: { openWorldHint: false },
    // No way to approve through here, and none to strip (EO-353):
    // `modules:save` carries no `approve` at all, because approving runs
    // the module's tests and is `modules:approve`'s alone. A crafted call
    // that names `approve` anyway has it dropped by the parse, which
    // dispatch.test.ts asserts against the row.
    render: (data) => {
      if (!data.saved || data.module === null) return `Nothing was saved: ${data.problem ?? "it refused."}`;
      // How many cases it has now (EO-355), so an agent that sent some
      // can see they landed, and one that sent none is reminded that
      // approval will refuse it until it has.
      const cases =
        data.module.testCount === 0
          ? " It has no test cases yet, and cannot be approved until it has at least one."
          : ` It has ${data.module.testCount} test case(s); they are re-running in the background.`;
      // Said whichever way it went (EO-498), so an agent that edited an
      // approved module knows whether it took the approval away.
      const approval = data.approvalWithdrawn
        ? "This save withdrew its approval, so steps that run it stop and no pipeline naming it will publish until a person " +
          "approves it again with module_approve, which runs every test case."
        : data.module.approvedAt !== null
          ? "It is still approved: its code, manifest and test cases are the ones that were approved."
          : "It is not approved, so no pipeline naming it will publish until a person has read the code and approved it.";
      return `Saved "${data.module.name}" (slug: ${data.module.slug}, id: ${data.module.id}). ${approval}${cases}` + renderMachineSpecific(data.module.machineSpecific);
    },
    refusal: (data) => (data.saved ? null : `Nothing was saved: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "module_tests_list",
    channel: "moduleTests:list",
    description:
      "A custom module's test cases: each one's id, description and source. Read this before module_test_save to edit " +
      "a case rather than add a second one saying the same thing. The latest result of running them, and whether it is " +
      "stale, is on modules_list.",
    kind: "read",
    list: "tests",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    render: renderModuleTests,
    refusal: (data) => data.problem,
  }),
  channelTool({
    name: "module_test_save",
    channel: "moduleTests:save",
    description:
      "Write one test case for a custom module: a short description and its source. Omit `id` to add a case; pass an " +
      "existing case's id to replace it. The source is an ES module (Node builtins only, written node:…) whose default " +
      "export is an async function taking the harness, asserting with node:assert. `await harness.run(fixtures)` runs " +
      "the module once against a scripted ctx and answers { outcome, comments, attachments, created, logs, execs }. Fixtures, all optional: " +
      "exec — [{ bin, args, code, stdout, stderr }], the answers ctx.exec gives, each answering one call matched on bin " +
      "and args in order; a call nothing scripts fails the case. item — the ticket ctx.item() answers with, any of: id, key, type, title, " +
      "body, parentKey, branch, prUrl, jiraKey, createdAt, updatedAt, comments, spec, fields ([{ name, kind, required }]), priority, " +
      "heldAt, archivedAt, trial, createdBy, pipeline ({ id, name }), step ({ id, name, kind, ownerRole }), pipelineVersion " +
      "({ id, number }), git ({ branch, baseBranch, namedBranch, attachedAt, pullRequest, reference, targetBranch }), extensions, " +
      "parent, children, dependsOn, dependedOnBy (each { key, title, type, stepName, finished }) and attachments ([{ id, name, " +
      "mimeType, size, commentId, createdAt }]); a field left out is null, false, [] or {}. itemByKey — { KEY: item } in the same " +
      "shape, for ctx.itemByKey and ctx.commentOn. runs — { KEY: [{ id, step ({ id, name }), action, agentName, status, resultKey, answer, error, " +
      "attempt, startedAt, endedAt, costCents }] }, what await ctx.runs(key) answers. transitions — { KEY: [{ from, to (each { id, name }), " +
      "actor, reason, at }] }, what await ctx.transitions(key) answers; a key the case knows but scripted none for answers []. items — " +
      "[{ key, title, type, pipelineName, stepName, parentKey }], the tickets await ctx.items(filter) searches, filtered (type, stepId, " +
      "stepName, pipelineId, parentKey, keys, text, createdSince, updatedSince, atTerminalStep) and paged (offset, limit) as EO does; an entry " +
      "may carry stepId, pipelineId, createdAt, updatedAt and atTerminalStep for the filters reading them. attachments — { ID: { name, " +
      "mimeType, content } }, content a string or bytes, what await ctx.readAttachment(id) answers with its bytes. run — ctx.run: " +
      "{ step ({ id, name }), pipeline ({ id, name }), attempt, cameFrom ({ step, result }: the step and result that sent the ticket here), " +
      "trial, watch ({ startedAt, waitingMs, intervalMs }, on a step that keeps checking) }. workspace — ctx.workspace: { kind, id, name, " +
      "git ({ repositoryName, mainCheckout, baseBranch, testCommand, lintCommand, buildCommand, forge ({ kind, remote, draft, " +
      "opensPullRequests }) }, null off a git repository) }; git.worktreePath is always harness.cwd, as it is ctx.cwd on a real run. " +
      "project — ctx.project (null unless scripted): { id, name, keyPrefix, workspaces ([{ kind, id, name }]), itemTypes ([{ id, slug, " +
      "label, container, fields }]), pipelines ([{ id, name, steps ([{ id, name, kind }]) }]) }. Left out is null, false or []. Step and " +
      "pipeline ids and names, workspace ids, names and paths and the project's name and key prefix differ between installations: a " +
      "module reads them but must not branch on them. answer — " +
      "ctx.answer(). inputs — the step's values. timeoutMs — ctx.timeoutMs. createItem — [{ key } or { reason }], the answers ctx.createItem gets in order (NEW-1, NEW-2… when none is scripted). Nothing real happens: no process is " +
      "spawned, comments are recorded in `comments` and never posted, files given to ctx.attach are recorded in " +
      "`attachments` as [{ key, caption, paths }] and never copied, items given to ctx.createItem are recorded in `created` as [{ idempotencyKey, key, type, title, body, spec, pipeline, " +
      "parent, repository, existingBranch, wait, dependsOn }] and never created, there are no secrets and no network, writes " +
      "outside harness.cwd fail, and time is faked so a polling loop finishes at once. Saving re-runs the module's tests " +
      "in the background; module_tests_run runs them and answers with the result. Any change to an approved module's " +
      "test cases withdraws its approval: adding a case, or saving one with a different description or source, leaves " +
      "the module unapproved until a person approves it again with module_approve, which runs every case. Saving a case " +
      "exactly as it already is changes nothing.",
    kind: "write",
    annotations: { openWorldHint: false },
    render: (data) =>
      data.saved && data.test !== null
        ? `Saved the test case "${data.test.description}" (id: ${data.test.id}). The module's tests are re-running in the background; module_tests_run waits for a result.` +
          approvalWithdrawnNote(data.approvalWithdrawn) +
          // Read off the case that was saved (EO-449), with what it scripts as stdout/stderr left out.
          renderMachineSpecific(testCaseMachineSpecificWarnings(data.test))
        : `Nothing was saved: ${data.problem ?? "it refused."}`,
    refusal: (data) => (data.saved ? null : `Nothing was saved: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "module_test_delete",
    channel: "moduleTests:delete",
    description:
      "Delete one test case of a custom module, by the id module_tests_list gives. It is removed outright — there is no " +
      "archive to restore it from — and the module's tests re-run without it. Deleting a case of an approved module " +
      "withdraws its approval, which a person gives again with module_approve.",
    kind: "dangerous",
    annotations: { destructiveHint: true, openWorldHint: false },
    render: (data) => "Test case deleted. The module's tests are re-running without it." + approvalWithdrawnNote(data.approvalWithdrawn),
    refusal: (data) => (data.deleted ? null : `Nothing was deleted: ${data.problem ?? "it refused."}`),
  }),
  channelTool({
    name: "module_tests_run",
    channel: "moduleTests:run",
    description:
      "Run every test case of a custom module now and answer with each case's pass or failure — the failure message " +
      "and the case's output — plus line and branch coverage of the module's code. The result is also stored, and is " +
      "what modules_list reports. Nothing real happens while they run; see module_test_save for what a case runs under.",
    kind: "write",
    annotations: { openWorldHint: false },
    render: (data) => (data.run === null ? `The tests did not run: ${data.problem ?? "it refused."}` : renderModuleTestRun(data.run)),
    refusal: (data) => (data.run === null ? `The tests did not run: ${data.problem ?? "it refused."}` : null),
  }),
  channelTool({
    name: "pipeline_export",
    channel: "pipelines:export",
    description:
      "One pipeline as a portable document — its steps, its routes and any custom modules they use. Returns the " +
      "document itself rather than writing a file, so you can read it, diff it, or hand it to pipeline_import_check " +
      "on another machine.",
    kind: "read",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    // The channel defaults to putting a save dialog in front of a person.
    // Fixed here rather than left to the caller: there is no person on
    // this side of it, and a tool that could open a modal nobody sees
    // would hang until the app was closed.
    input: z.object({ pipelineId: z.string() }).transform((value) => ({ ...value, destination: "document" as const })),
    render: (data) => data.document ?? `Nothing was exported: ${data.problem ?? "it refused."}`,
  }),
  channelTool({
    name: "pipeline_import_check",
    channel: "pipelines:importPreflight",
    description:
      "What importing a pipeline document would cost on this machine: binaries it needs and does not find, secrets " +
      "it wants that are not set, modules that would reach the network, and module slugs that collide with ones " +
      "already here. A pack also brings item types, roles and connectors, so it reports which role slots are " +
      "unfilled, which backend each role was built on, which connectors would land disconnected, and what the " +
      "pack's tool surface amounts to. It also lists values in the document that look like they only hold on the " +
      "machine it was written on — a home-directory path, a drive letter, a loopback address — as advice that " +
      "refuses nothing. Writes nothing. Read this before pipeline_import — an imported module " +
      "arrives unapproved and inert, a collision has to be decided rather than guessed, and a pack asking for " +
      "EO's admin tools is refused outright.",
    kind: "read",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    input: z.object({ document: z.string() }),
    render: (data) => {
      if (data.problem !== null) return `That document cannot be imported: ${data.problem}`;
      if (data.preflight === null) return "Nothing to check.";
      const p = data.preflight;
      const lines = [`Importing "${p.pipelineName}" would bring ${p.moduleCount} module(s).`, ""];
      if (p.missingBinaries.length > 0) lines.push("Missing binaries:", ...p.missingBinaries.map((item) => `- ${item.name} (wanted by ${item.wantedBy.join(", ")})`), "");
      if (p.missingSecrets.length > 0) lines.push("Secrets not set here:", ...p.missingSecrets.map((item) => `- ${item.name} (wanted by ${item.wantedBy.join(", ")})`), "");
      if (p.wantsNetwork.length > 0) lines.push(`Modules that reach the network: ${p.wantsNetwork.join(", ")}`, "");
      if (p.collisions.length > 0) {
        lines.push("Slug collisions — each has to be decided in pipeline_import:", ...p.collisions.map((item) => `- ${item.slug}: yours "${item.localName}" vs theirs "${item.incomingName}"`), "");
      }
      // The pack half (EO-314), said here as well as on the screen:
      // invariant #12 is that a capability reaches both surfaces, and a
      // system agent checking a pack before installing it is asking the
      // same question a person is.
      if (p.refusal !== null) lines.push(p.refusal, "");
      if (p.capabilities.length > 0) lines.push("What this pack can reach:", ...p.capabilities.map((item) => `- ${item.server}: ${item.line}`), "");
      if (p.itemTypes.length > 0) lines.push(`Item types: ${p.itemTypes.map((item) => `${item.label}${item.present ? " (already here, kept as it is)" : ""}`).join(", ")}`, "");
      if (p.roleSlots.length > 0) {
        lines.push(
          "Roles:",
          ...p.roleSlots.map((slot) => {
            const recommendation = slot.recommendedBackend === null ? "no backend recommended" : `built on ${slot.recommendedBackend}${slot.recommendedModel === null ? "" : ` (${slot.recommendedModel})`}${slot.backendSignedIn === false ? ", not signed in here" : ""}`;
            return `- ${slot.slug}: ${slot.filled ? "filled here" : "no agent here"}, ${recommendation}`;
          }),
          "",
        );
      }
      if (p.connectors.length > 0) {
        lines.push("Connectors (they land disconnected):", ...p.connectors.map((item) => `- ${item.label}${item.connected ? " — connected here" : " — not connected here"}`), "");
      }
      // Values that only hold on the machine the document was written on
      // (EO-451), said here as the import screens say them: advice, by
      // the prompt, step or module each is in.
      if (p.machineSpecific.length > 0) {
        lines.push(
          "These look like they only hold on the machine the document was written on, and may not work here. This is advice — the import is not refused or changed because of it:",
          ...p.machineSpecific.flatMap((entry) => entry.warnings.map((warning) => `- ${entry.where}, ${describeMachineSpecificWarning(warning)}`)),
          "",
        );
      }
      if (p.missingBinaries.length === 0 && p.missingSecrets.length === 0 && p.collisions.length === 0) lines.push("Nothing is missing and nothing collides.");
      return lines.join("\n");
    },
  }),
  channelTool({
    name: "pipeline_import",
    channel: "pipelines:import",
    description:
      "Import a pipeline document. `choices` decides each colliding module slug: `reuse` keeps the one already here, " +
      "`import` brings theirs in beside it. Any module that arrives is unapproved and inert until someone reads it — " +
      "the pipeline will not publish until they have.",
    kind: "write",
    annotations: { openWorldHint: false },
    render: (data) => {
      if (!data.imported) return `Nothing was imported: ${data.problem ?? "it refused."}`;
      const unapproved =
        data.unapprovedModules.length === 0
          ? ""
          : ` ${data.unapprovedModules.length} module(s) arrived unapproved and must be read and approved before this pipeline will publish: ${data.unapprovedModules.join(", ")}.`;
      const kept = keptDefinitionsNote(data.keptDefinitions);
      return `Imported as pipeline ${data.pipelineId}.${unapproved}${kept === "" ? "" : ` ${kept}`}`;
    },
    refusal: (data) => (data.imported ? null : `Nothing was imported: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "jira_pull",
    channel: "jira:pull",
    description: "Pull comments and edits made in Jira onto one EO ticket now, rather than waiting for the next scheduled sync.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: true },
    render: (data) => `Pulled ${data.comments} comment(s), ${data.edits} edit(s) and ${data.attachments} attachment(s).`,
  }),
  channelTool({
    name: "settings_write",
    channel: "settings:set",
    description:
      "Change one of EO's preferences. Send only the keys you mean to change — a key you leave out keeps the value " +
      "settings_read reports, so muting notifications cannot reset the archive delay. null is a value rather than " +
      "an omission on the two that take it: archiveAfterDays null keeps finished work on the project forever and 0 " +
      "archives it the moment it is done, and jiraPullMinutes null turns the Jira pull off. pipelineVersionsToKeep " +
      "is a whole number of 1 or more, applied to each pipeline at its next save; moduleVersionsToKeep is the same for " +
      "each module. The reply is every " +
      "preference as it now stands. Nothing here is destructive — read it back and correct it.",
    kind: "write",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: renderSettingsWritten,
  }),
  GUARDRAILS_SET_TOOL,
  AGENT_SAVE_TOOL,
  AGENT_ARCHIVE_TOOL,
  ROLE_ACTION_SAVE_TOOL,
  ...PROJECT_SETUP_TOOLS,
  PROJECT_SET_ACTIVE_TOOL,
  ...TRACKER_WRITE_TOOLS,
  ...CATALOGUE_WRITE_TOOLS,
  ...MEMORY_WRITE_TOOLS,
  AGENT_ATTACHMENT_SET_TOOL,
];

/**
 * The tools that stay off until someone turns destructive operations on.
 *
 * Three kinds of thing are in here, and it is worth naming why each is:
 *
 * - **Deletes.** Nothing else in EO destroys anything — archiving keeps
 *   history, cancelling a run keeps the item. These do not.
 * - **Secrets and credentials.** Module secrets, the values behind a
 *   catalogued MCP server's declared variables, the Jira connection, the
 *   licence. A connected client that can write these can make EO talk to
 *   somewhere else entirely. Not every credential is in here rather than
 *   excluded outright — EO's own runtime API key still is — and the
 *   comment above `mcp_server_set_secret` is where that line is drawn.
 * - **Approval and installation.** `module_approve` records that a
 *   person read code and accepted it, which is a claim only a person can
 *   truthfully make; the runtime tools download and delete directories.
 *
 * `runtime_set_enabled` is here rather than in the write set because
 * disabling a runtime silently parks every item whose step is owned by
 * an agent on that backend. The effect is closer to engine_pause than to
 * a preference, and it does not announce itself.
 *
 * `runtime_set_automatic_updates` is here for the plainer of the three
 * reasons: it installs. Turning it on grants the durable download
 * consent `runtime:install` is built around and reconciles the provider
 * on the spot — for a backend with nothing on disk that is the install,
 * under a name that sounds like a checkbox. Reading it as a preference
 * and offering it ungated would leave a door through the gate
 * `runtime_install` stands behind, which is the one thing the gate
 * cannot survive. Turning it *off* takes nothing away and could have
 * been an ordinary write, but a tool has one kind and it is the
 * dangerous half that decides which.
 */
const GATED_TOOLS: readonly ToolSpec[] = [
  channelTool({
    name: "ticket_delete",
    channel: "items:delete",
    description:
      "Delete a ticket and every story under it, for good. Refuses while an agent is working on it, and again if a " +
      "worktree holds uncommitted changes that exist nowhere else — pass discardUncommitted only if losing them is " +
      "intended. deleteInJira is separate and off by default.",
    kind: "dangerous",
    annotations: { destructiveHint: true, openWorldHint: false },
    render: (data) => {
      const jira = data.jira === null ? "" : ` Jira: ${data.jira.deleted}/${data.jira.attempted} deleted${data.jira.problem === null ? "" : ` (${data.jira.problem})`}.`;
      // A checkout the delete could not remove is still on disk, and the
      // rows that explained it have just gone. Said here rather than
      // left out, because "Deleted 1 item(s)." is otherwise the whole
      // truth an agent gets (issue #131).
      const leftover =
        data.leftoverWorktrees.length === 0
          ? ""
          : ` Still on disk: ${data.leftoverWorktrees.map((entry) => `${entry.path} (${entry.problem})`).join("; ")}`;
      return `Deleted ${data.deletedCount} ticket(s).${jira}${leftover}`;
    },
    refusal: (data, tool) => {
      if (data.deleted) return null;
      if (data.blockedByUncommittedWork) {
        return (
          `EO did not delete it: a worktree holds uncommitted changes that exist nowhere else. Call ${tool} ` +
          "again with discardUncommitted: true only if losing that work is intended. Nothing has changed."
        );
      }
      if (data.blockedByActiveRun) return activeRunRefusal("delete", tool, true);
      return `EO did not delete it: ${data.problem ?? "it refused."} Nothing has changed.`;
    },
  }),
  // EO-346. Refuse first, confirm second, like ticket_delete — but with
  // one confirmation rather than two, because the first answer already
  // names every ticket an agent is on and every worktree holding
  // uncommitted work, which is what ticket_delete's second question is
  // for. The same facts the Settings dialog shows, in the same order.
  channelTool({
    name: "project_delete",
    channel: "projects:delete",
    description:
      "Delete a project and every ticket on it — their comments, runs and attachments — for good, along with its " +
      "pipelines, item types, jobs and connector bindings. Its repositories stay in EO, attached to no project, and " +
      "no Jira issue is touched. Call it without confirm first: nothing is deleted, and the answer says how many " +
      "tickets the project has, how many are unfinished, which have an agent running and which have uncommitted " +
      "changes in their worktree. Tell the person, and call again with confirm: true only once they have said to " +
      "go ahead — that stops those runs and removes those worktrees, keeping their branches. A project on the " +
      "organisation's record is refused: the record owns it.",
    kind: "dangerous",
    annotations: { destructiveHint: true, openWorldHint: false },
    render: (data) => {
      const leftover =
        data.leftoverWorktrees.length === 0
          ? ""
          : ` Still on disk: ${data.leftoverWorktrees.map((entry) => `${entry.path} (${entry.problem})`).join("; ")}`;
      return `Deleted "${data.name ?? "the project"}" and ${data.deletedCount} ticket(s).${leftover}`;
    },
    refusal: (data, tool) => {
      if (data.deleted) return null;
      if (data.problem !== null) return `EO did not delete it: ${data.problem} Nothing has changed.`;
      const running =
        data.running.length === 0 ? "" : ` An agent is running on ${data.running.map((entry) => entry.itemKey).join(", ")}; deleting stops it.`;
      const dirty =
        data.uncommitted.length === 0
          ? ""
          : ` Uncommitted changes in the worktree of ${data.uncommitted
              .map((entry) => `${entry.itemKey} (${entry.changes})`)
              .join(", ")} would be lost; their branches are kept.`;
      return (
        `Nothing has been deleted yet. "${data.name ?? "This project"}" has ${data.unfinishedCount} unfinished ticket(s) ` +
        `of ${data.itemCount}, and every one of them goes with its history.${running}${dirty} Call ${tool} again with ` +
        "confirm: true only once the person has said to delete it."
      );
    },
  }),
  // EO-350. The same confirmation `agent_archive` takes, one step
  // further: the agent goes from the Agents screen altogether. Gated
  // like `ticket_delete` for an outside client; the system agent is
  // served every tool, so this is how it deletes one when asked.
  channelTool({
    name: "agent_delete",
    channel: "agents:delete",
    description:
      "Delete an agent, archived ones included. Its name and role are kept so its past runs and comments still say " +
      "who did them; everything else about it goes, it disappears from the Agents screen and agents_list stops " +
      "offering it, and nothing dispatches it again. Call it without confirm first: nothing is deleted, and the " +
      "answer names every pipeline step the agent's role owns, whether those steps are left with nobody (tickets " +
      "reaching them then wait until another agent takes the role) or who still covers them, the ticket of any run " +
      "it has in progress (confirming cancels it), and whether it is the last system agent. Tell the person, and " +
      "call again with confirm: true only once they have said to delete it. agent_save with `enabled: false` is the " +
      "reversible alternative.",
    kind: "dangerous",
    annotations: { destructiveHint: true, openWorldHint: false },
    render: () => "Agent deleted. Nothing dispatches it now; its past runs and comments still show its name.",
    refusal: (data, tool) => (data.deleted ? null : unconfirmedAgentRemoval(data, "deleted", tool)),
  }),
  // EO-425. Gated like `module_test_delete`, and for its reason: the
  // definition is removed outright, with no archive to bring it back.
  // The channel refuses while a step dispatches it, so what this can
  // take away is only ever a definition nothing uses.
  channelTool({
    name: "role_action_delete",
    channel: "roleActions:delete",
    description:
      "Delete a role's own definition of an action, by `role` and `action`. Refused while any pipeline step dispatches " +
      "it, and the refusal names each pipeline and step: move those steps to another action with pipeline_save, or " +
      "remove them, and call this again. A step named with a version (\"Delivery v3, 2 tickets still finishing on it\") " +
      "is one the current pipeline no longer defines that way but tickets already in flight still run by; no edit " +
      "clears it, only those tickets finishing or being archived, so tell the person rather than retrying. It is removed outright — there is no archive to restore it from. A pack's " +
      "own action (packShipped in registry_get) is not a definition and cannot be deleted. Where the role had defined " +
      "its own version of a pack's action name, the pack's version applies to it again afterwards.",
    kind: "dangerous",
    annotations: { destructiveHint: true, openWorldHint: false },
    render: () => "Action definition deleted.",
    refusal: (data) => (data.deleted ? null : `Nothing was deleted: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "comment_delete",
    channel: "comments:delete",
    description:
      "Delete a comment and the replies filed under it. deleteInJira defaults to true, unlike ticket deletion — a " +
      "comment mirrored into Jira is the same comment, so leaving it there would be leaving a copy of something you " +
      "just removed.",
    kind: "dangerous",
    annotations: { destructiveHint: true, openWorldHint: false },
    render: (data) => (data.deleted ? `Deleted ${data.deletedCount} comment(s).` : `Nothing was deleted: ${data.problem ?? "it refused."}`),
    refusal: (data) => (data.deleted ? null : `EO did not delete it: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "attachment_delete",
    channel: "attachments:delete",
    description:
      "Delete a file somebody attached to a comment. The comment stays; the file does not — EO removes the row and " +
      "the bytes from its own storage when this call returns, and that part is final. A file that was also mirrored " +
      "onto the ticket's Jira issue is queued for deletion there rather than deleted: the request goes out when the " +
      "Jira outbox next drains, so the copy on the issue outlives this call and stays if that request keeps failing. " +
      "There is no flag to keep it, either — unlike comment_delete, this channel has no deleteInJira. Attachment " +
      "ids come from ticket_get, which lists each comment's attachments by id.",
    kind: "dangerous",
    annotations: { destructiveHint: true, openWorldHint: false },
    render: (data) =>
      data.deleted
        ? "Attachment deleted: the row and the file are gone from EO. If it was mirrored to Jira, deleting it there " +
          "is queued and happens when the outbox next drains — until then the issue still has its copy."
        : "Nothing was deleted.",
    refusal: (data) =>
      data.deleted
        ? null
        : data.problem !== null
          ? `Nothing was deleted: ${data.problem} Nothing has changed.`
          : "Nothing was deleted: EO has no attachment with that id. Read the ids off ticket_get rather than " +
            "constructing one. Nothing has changed.",
  }),
  channelTool({
    name: "pipeline_delete",
    channel: "pipelines:delete",
    description:
      "Archive a pipeline. Its tickets are archived with it rather than deleted, and the reply says how many — read " +
      "that number before assuming this was small.",
    kind: "dangerous",
    annotations: { destructiveHint: true, openWorldHint: false },
    render: (data) => `Pipeline archived, and ${data.archivedItemCount} ticket(s) with it.`,
    refusal: (data, tool) => (data.deleted ? null : activeRunRefusal("archive", tool, data.blockedByActiveRun) ?? "EO did not archive it. Nothing has changed."),
  }),
  channelTool({
    name: "module_approve",
    channel: "modules:approve",
    description:
      "Record that a person read this module's code and accepted it. EO will not publish a pipeline naming an " +
      "unapproved module. Approving runs the module's tests first, at that moment: a module with no test cases, or " +
      "with any case failing, is refused, and the refusal names each failing case. When every case passes but line " +
      `coverage is under ${MODULE_COVERAGE_BAR}%, it is refused with the coverage figure unless acknowledgeLowCoverage ` +
      "is true — set that only once the person has seen the figure and said to approve anyway. Approving is a claim " +
      "about a human having read something — do not make it on their behalf unless they have said so.",
    kind: "dangerous",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: (data) =>
      data.approved
        ? `Module approved. Every test case passed; line coverage ${data.lineCoverage ?? 0}%.${renderMachineSpecific(data.machineSpecific)}`
        : `Not approved: ${data.problem ?? "it refused."}`,
    // The coverage refusal says how past it, and on whose word: the
    // figure goes to the person and the acknowledgement comes back from
    // them (EO-353). Every other refusal is the module's to fix.
    refusal: (data, tool) => {
      if (data.approved) return null;
      if (data.coverageAcknowledgementNeeded) {
        return (
          `Not approved: every test case passed, but line coverage is ${data.lineCoverage ?? 0}% — under the ` +
          `${MODULE_COVERAGE_BAR}% bar. Tell the person that figure; call ${tool} again with acknowledgeLowCoverage: ` +
          "true only if they say to approve it anyway. Nothing has changed."
        );
      }
      return `Not approved: ${data.problem ?? "it refused."} Nothing has changed.`;
    },
  }),
  channelTool({
    name: "module_version_restore",
    channel: "moduleVersions:restore",
    description:
      "Put an older version of a custom module back: its code, manifest and test cases replace the module's own, as " +
      "a new version numbered above every one before it. The version you restore is left as it was, and so is the " +
      "module's name and description. It comes back approved only if exactly that code, manifest and set of test " +
      "cases are a kept version a person approved; otherwise it needs approving like any edit, and a pipeline naming it will not " +
      "publish until it is. Its tests re-run in the background.",
    kind: "dangerous",
    annotations: { openWorldHint: false },
    render: (data) =>
      data.restored && data.module !== null
        ? `Restored "${data.module.name}" as v${data.version ?? "?"}. It is ${data.module.approvedAt === null ? "**not approved** — it needs approving before a pipeline naming it will publish" : "approved, because a person approved exactly this code and these test cases before"}. ` +
          `It has ${data.module.testCount} test case(s); they are re-running in the background.`
        : `Nothing was restored: ${data.problem ?? "it refused."}`,
    refusal: (data) => (data.restored ? null : `Nothing was restored: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "module_archive",
    channel: "modules:archive",
    description: "Retire a module. Refuses while any pipeline step still uses it, and says how many do.",
    kind: "dangerous",
    annotations: { destructiveHint: true, openWorldHint: false },
    render: () => "Module archived.",
    refusal: (data) =>
      data.archived ? null : `EO did not archive it: ${data.usedByStepCount} pipeline step(s) still use it. Take it off those steps first. Nothing has changed.`,
  }),
  channelTool({
    name: "module_secrets_list",
    channel: "moduleSecrets:list",
    description:
      "Which module secrets are set — names only, in both directions. A value goes in and no tool ever returns it, " +
      "the same arrangement the Jira token has. A name may instead hold a reference to one of EO's own environment " +
      "variables: those are listed with the variable each reads and whether EO's environment has it, and count as " +
      "set only when it does. The variable's value is never returned.",
    kind: "dangerous",
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    render: (data) => {
      const shared = data.names.length === 0 ? "none" : data.names.join(", ");
      const overrides = data.overrides.length === 0 ? "none" : data.overrides.join(", ");
      const references =
        data.references.length === 0
          ? "none"
          : data.references
              .map(
                (reference) =>
                  `\n- ${reference.name} ${reference.scope === "step" ? "(this step)" : "(shared)"} reads ${reference.variable} — ` +
                  (reference.available ? "EO's environment has it" : "missing or empty in EO's environment, so a step needing it will be refused"),
              )
              .join("");
      return `Shared: ${shared}\nOverriding for this step: ${overrides}\nReferences to EO's environment: ${references}`;
    },
  }),
  channelTool({
    name: "module_secret_set",
    channel: "moduleSecrets:set",
    description:
      "Give a module secret a value, or point it at one of EO's own environment variables. Pass `value` to store it " +
      "in the OS keychain: it goes in and can never be read back out — not by you, not by the Settings screen. Pass " +
      "`reference` instead to have EO read the name from its own environment at dispatch (`reference.variable` says " +
      "which variable, and defaults to the name); nothing is stored, no keychain is needed, and EO reads its " +
      "environment when it starts. Exactly one of the two. A name holds a value or a reference, so setting one " +
      "removes the other in the same scope — a stored value replaced by a reference is lost for good, and the " +
      "answer says so. Pass stepId to set it for one step rather than for every step that falls back.",
    kind: "dangerous",
    // Destructive despite the name: a value that is overwritten here can
    // never be read back, so setting one over an existing secret — or a
    // reference over one (EO-416) — loses the old one irrecoverably.
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    render: (data) => {
      if (!data.saved) return `Not stored: ${data.problem ?? "it refused."}`;
      if (data.replaced === "value") {
        return "Reference set. It replaced a stored value for this name in the same scope, and that value is gone for good.";
      }
      if (data.replaced === "reference") return "Secret stored in the OS keychain. It replaced a reference to EO's environment for this name in the same scope.";
      return "Saved.";
    },
    refusal: (data) => (data.saved ? null : `Not stored: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "module_secret_clear",
    channel: "moduleSecrets:clear",
    description:
      "Remove one module secret — its stored value, or its reference to EO's environment, whichever the name holds. " +
      "Any pipeline step whose module declares it will run without it after this, which usually means the step " +
      "fails rather than that it does less.",
    kind: "dangerous",
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    render: (data) => (data.cleared ? "Secret removed." : "There was no such secret."),
  }),
  /**
   * Environment variables (EO-485, ARCHITECTURE.md §14.2): values that
   * are not secret, so the list returns each one.
   *
   * The read is an ordinary read — nothing in it is a credential, which
   * is the whole difference between a variable and a secret. The two
   * writes are behind the gate all the same, and not because of the
   * value: a variable is handed to modules, MCP servers and every agent
   * run, so a client able to set one could change what every process EO
   * starts is launched with. That is a person's decision to delegate,
   * as it is for a secret. Setting one is not destructive — the list
   * gives the old value back first — and clearing one is, because the
   * value goes with it.
   */
  channelTool({
    name: "environment_variables_list",
    channel: "environmentVariables:list",
    description:
      "List the environment variables set on this machine — named values that are not secret — with each shared one's value. " +
      "Pass stepId to see which names that step sets for itself, which win over the shared ones: those are listed by name " +
      "with no value, because a step's own value is the person's, typed on the assistant's card, and never shown to an agent. " +
      "A module is given only the names its manifest declares in needs.env. Variables are this machine's own setting and are " +
      "never exported with a pipeline. Secrets are a separate list (module_secrets_list) and their values are never returned.",
    kind: "read",
    list: "variables",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    // A step's own variable is set by a person on the assistant's card
    // (EO-522), and the value they typed reaches neither the agent nor
    // its transcript — so this read, which every agent may make, says
    // that one is set and not what it is. The person's screens read the
    // channel itself and still get every value.
    forAgent: (data) => ({ variables: data.variables.map((variable) => (variable.scope === "step" ? { name: variable.name, value: null, scope: "step" } : variable)) }),
    render: (data) => {
      if (data.variables.length === 0) return "No environment variables are set.";
      return data.variables
        .map((variable) =>
          variable.scope === "step"
            ? `- ${variable.name} (this step) — set; a step's own value is not shown to agents`
            : `- ${variable.name}=${variable.value} (shared)`,
        )
        .join("\n");
    },
  }),
  channelTool({
    name: "environment_variable_set",
    channel: "environmentVariables:set",
    description:
      "Set an environment variable: a named value that is not secret, kept in the clear on this machine and shown in " +
      "full. Pass stepId to set it for one step, where it wins over the shared value of the same name. A name that is " +
      "already a module secret in the same scope is refused — a name is a secret or a variable, never both — and so " +
      "are PATH, HOME and names starting EO_, which EO sets itself. An organisation secret of the same name still wins. " +
      "For a credential use module_secret_set instead: a variable is not hidden anywhere.",
    kind: "dangerous",
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    render: (data) => (data.saved ? "Environment variable saved." : `Not saved: ${data.problem ?? "it refused."}`),
    refusal: (data) => (data.saved ? null : `Not saved: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "environment_variable_clear",
    channel: "environmentVariables:clear",
    description:
      "Remove one environment variable from the shared list, or from one step's when you pass stepId. A step that loses " +
      "its own value falls back to the shared one; a module that declares the name and has nothing left will be refused.",
    kind: "dangerous",
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    render: (data) => (data.cleared ? "Environment variable removed." : "That is not an environment variable name."),
  }),
  /**
   * The values behind a catalogued MCP server's declared variables, from
   * a client (EO-115).
   *
   * The last two channels the catalogues were withheld on, and the only
   * ones that were not withheld on who is asking. Everything else in
   * EO-111 turned on the client being a person's request relayed rather
   * than an agent writing its own surface. These two turned on the value
   * itself: that a third-party token must not travel through a client's
   * transcript, and that a client must not drop a credential this
   * machine's agents run on. Both sentences are true of
   * `runtime:signInWithApiKey` word for word, and that one is still
   * excluded — so the question was which precedent a server's token
   * belongs to rather than whether the earlier argument extends.
   *
   * What separates them is whose credential it is. The runtime key is
   * EO's own: it is billed to the person, every dispatch on that backend
   * runs on it, and a client able to set or drop it could move where
   * this machine's work goes and who pays for it. A GitHub PAT for a
   * server somebody catalogued is a third-party token for a third-party
   * service, which is what `module_secret_set` already takes — and takes
   * on terms that answer the transcript objection rather than waving it
   * off: the value goes into the OS keychain, no channel reads one back,
   * and the most anything says afterwards is that a name has something
   * behind it. One journey in, and none out.
   *
   * So these are `module_secret_set`'s arrangement exactly. `dangerous`,
   * so neither is offered until a person turns destructive operations
   * on, which is off by default. `destructiveHint` on the setter as well
   * as on the clearer, because a value written over another loses it
   * with nothing able to print it first. And a description that says
   * plainly what a client is agreeing to, since what it sends here it
   * can never read back.
   */
  channelTool({
    name: "mcp_server_set_secret",
    channel: "mcpServers:setSecret",
    description:
      "Store the value of one environment variable a catalogued MCP server needs, in this machine's OS keychain. " +
      "The value goes in and can never be read back out — not by you, not by any other tool here, not by the " +
      "Settings screen; mcp_servers_list says that a name is set and never what is behind it. `serverId` comes " +
      "from mcp_servers_list and `name` is one of that server's `envNames`, spelled exactly as the entry declares " +
      "it — a value filed under a name the server does not declare is stored where nothing will read it and " +
      "nothing will list it. Writing over a value that is already there replaces it and the old one is gone, and " +
      "nothing can show it to you first, so ask before setting a variable mcp_servers_list already reports as " +
      "set. A machine with no keychain, or with the weak backend Electron falls back to when no keyring is " +
      "running, is refused rather than written to in the clear, and the refusal says which it was; a keychain or " +
      "a disk that fails when asked is refused the same way, in a sentence that repeats nothing of what it was " +
      "given. The value reaches a server on the next dispatch of an agent it is attached to, not on a run " +
      "already in flight.",
    kind: "dangerous",
    // Destructive despite the name, and for `module_secret_set`'s exact
    // reason: a value overwritten here can never be read back, so
    // setting one over an existing secret loses the old one
    // irrecoverably. `DESTRUCTIVE` in catalog.test.ts is where that is
    // written down.
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    render: (data) =>
      data.saved
        ? "Value stored in the OS keychain. Nothing reads it back out — mcp_servers_list will say the name is set and never what is behind it."
        : `Nothing was stored: ${data.problem ?? "it refused."}`,
    refusal: (data) => {
      if (data.saved) return null;
      // The keychain status travels with the refusal deliberately: "EO
      // will not store this" is only actionable if it says which backend
      // it means. It *is* the problem when the keychain is what refused,
      // so it is added only when it has something the problem does not —
      // a server that no longer exists is a different failure and the
      // warning would be noise beside it.
      const problem = data.problem ?? "it refused.";
      const keychain = data.keychain.warning === null || data.keychain.warning === problem ? "" : ` ${data.keychain.warning}`;
      return `Nothing was stored: ${problem}${keychain} Nothing has changed.`;
    },
  }),
  channelTool({
    name: "mcp_server_clear_secret",
    channel: "mcpServers:clearSecret",
    description:
      "Forget the value stored for one of a catalogued MCP server's environment variables. A value goes in and can " +
      "never be read back out — not by this tool, not by mcp_servers_list — so there is nowhere to copy it from " +
      "first, and setting it again means somebody still having it elsewhere. Every agent the server is attached " +
      "to is dispatched without it from the next dispatch on, which for a token usually means the server fails to " +
      "start rather than that it does less. `serverId` comes from mcp_servers_list and `name` is the variable, " +
      "spelled as the entry declares it. A name with nothing behind it, and a server EO no longer has, are both " +
      "reported as already gone rather than as a failure.",
    kind: "dangerous",
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    // "EO holds no value" rather than "removed", because the channel
    // answers `{ cleared: true }` for a name that never had one and for
    // a server that is already gone — deliberately, since neither is a
    // failure — and a reply claiming a removal that did not happen would
    // have a client tell somebody their token was taken out of a place
    // it had never been in.
    render: (data) =>
      data.cleared
        ? "EO holds no value for that variable now. Any agent that server is attached to is dispatched without it, from the next dispatch on."
        : "There was no such value.",
  }),
  channelTool({
    name: "jira_connection_save",
    channel: "jiraConnections:save",
    description:
      "Add a Jira site to EO, or change one it has. `baseUrl` is the site root, like https://acme.atlassian.net; " +
      "`flavour` is `cloud` or `datacenter`; `email` is the account the token belongs to on Cloud and null on Data " +
      "Center. The token is proved against the site before anything is stored — a credential that has never worked " +
      "reports a puzzling failure weeks later rather than a clear one now — and it then goes into the OS keychain, " +
      "where nothing can read it back, this tool included. Pass an `id` from jira_connections_list to change a site " +
      "that exists, and leave `token` out to keep the stored one: renaming a connection should not mean retyping a " +
      "secret. This adds a site; jira_connect is what points a repository at it.",
    kind: "dangerous",
    annotations: { idempotentHint: true, openWorldHint: true },
    render: (data) => {
      if (!data.ok) return `Nothing was saved: ${data.problem ?? "it refused."}`;
      // The reply carries the site it wrote, but the channel types it as
      // optional — so the confirmation says what happened either way
      // rather than reading "Saved undefined".
      const site = data.connection;
      const named = site === undefined ? "The site" : `${site.name.trim() || site.baseUrl} (id: ${site.id})`;
      return `${named} is saved, and its token is stored on this machine where nothing can read it back. jira_connect points a repository at it${site === undefined ? " — jira_connections_list has its id" : ""}.`;
    },
    refusal: (data) => (data.ok ? null : `Nothing was saved: ${data.problem ?? "it refused."} EO proves a token before storing it, so nothing has changed.`),
  }),
  channelTool({
    name: "jira_connection_remove",
    channel: "jiraConnections:remove",
    description:
      "Forget a Jira site and the token stored for it. Refused while any repository still mirrors through it, and " +
      "says how many and which — disconnect those with jira_disconnect first, because deleting the site under them " +
      "would stop them mirroring with nothing on screen to say why. A site EO does not have is reported as already " +
      "gone rather than as a failure. The token is unrecoverable afterwards and has to be given again.",
    kind: "dangerous",
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    render: (data) => (data.ok ? "Site forgotten, and its stored token with it." : `Nothing was removed: ${data.problem ?? "it refused."}`),
    refusal: (data) => (data.ok ? null : `Nothing was removed: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "jira_connect",
    channel: "jira:connect",
    description:
      "Bind a repository to a Jira site and project, so its tickets mirror there. `connectionId` comes from " +
      "jira_connections_list and `projectKey` is the key of a project on that site — both are proved against Jira " +
      "before anything is written, so a project the account cannot see is refused now rather than at the first " +
      "push. `featureIssueType` and `storyIssueType` are what EO creates for each; jira_save_config changes them " +
      "afterwards, and jira_test proves the whole path.",
    kind: "dangerous",
    annotations: { idempotentHint: true, openWorldHint: true },
    render: (data) => (data.ok ? "Repository connected to Jira. jira_save_status_map is what makes its tickets move issues." : `Not connected: ${data.problem ?? "it refused."}`),
    refusal: (data) => (data.ok ? null : `Not connected: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "runtime_install",
    channel: "runtime:install",
    description:
      "Download and unpack an agent CLI into EO's own cache. This fetches code from the network and runs it later — " +
      "the Settings screen shows the publisher, size and terms before a person agrees, and there is no such screen here.",
    kind: "dangerous",
    annotations: { openWorldHint: true },
    render: (data) => (data.ok ? "Runtime installed." : `Not installed: ${data.problem ?? "it refused."}`),
    refusal: (data) => (data.ok ? null : `Not installed: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "runtime_set_automatic_updates",
    channel: "runtime:setAutomaticUpdates",
    description:
      "Let EO keep an agent CLI at the version this build pins, or stop it doing so. Turning it on is the same " +
      "consent runtime_install asks for and acts on it immediately: EO reconciles the provider there and then, which " +
      "for a backend that has nothing on disk means downloading it. Turning it off leaves everything installed " +
      "exactly where it is and only stops future versions arriving on their own. Read runtime_status first to see " +
      "which it currently is, and again afterwards — the setting is reported there.",
    kind: "dangerous",
    annotations: { idempotentHint: true, openWorldHint: true },
    render: (data) => (data.ok ? "Automatic updates setting applied." : `The setting was written, but reconciling the runtime failed: ${data.problem ?? "it refused."}`),
    // Deliberately not a refusal: the setting is stored before the
    // reconcile is attempted, so a failed download is a report about the
    // download and not "nothing has changed". Saying the latter would
    // send a caller back to set a value that is already set.
  }),
  channelTool({
    name: "runtime_remove",
    channel: "runtime:remove",
    description: "Delete EO's managed copy of an agent CLI. Refuses while agents are configured to use it.",
    kind: "dangerous",
    annotations: { destructiveHint: true, openWorldHint: false },
    render: (data) => (data.ok ? "Runtime removed." : `Not removed: ${data.problem ?? "it refused."}`),
    refusal: (data) => (data.ok ? null : `Not removed: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "runtime_set_enabled",
    channel: "runtime:setEnabled",
    description:
      "Enable or disable an agent backend. Disabling one silently parks every ticket whose step is owned by an agent " +
      "running on it — closer to pausing the engine than to changing a preference, which is why it sits behind this " +
      "switch.",
    kind: "dangerous",
    annotations: { idempotentHint: true, openWorldHint: false },
    render: (data) => (data.ok ? "Runtime setting applied." : `Not applied: ${data.problem ?? "it refused."}`),
    refusal: (data) => (data.ok ? null : `Not applied: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "repository_remove",
    channel: "repositories:remove",
    description: "Detach a repository from EO. Its checkout on disk is left alone.",
    kind: "dangerous",
    annotations: { destructiveHint: true, openWorldHint: false },
    render: (data) => (data.ok ? "Repository detached." : `Not detached: ${data.problem ?? "it refused."}`),
    refusal: (data) => (data.ok ? null : `Not detached: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "workspace_remove",
    channel: "workspaces:remove",
    description:
      "Detach a workspace of any kind from EO. Nothing on disk is touched — the repository, the folder and " +
      "everything in them are left exactly as they are. Refused while tickets are on it: their run history is " +
      "append-only and EO will not delete it. Every pipeline step that named this workspace falls back to the " +
      "ticket's own, which is what a step with no pick has always done. repository_remove is this same door for " +
      "the git kind, and does the same thing.",
    kind: "dangerous",
    annotations: { destructiveHint: true, openWorldHint: false },
    render: (data) => (data.ok ? "Workspace detached. Nothing on disk was touched." : `Not detached: ${data.problem ?? "it refused."}`),
    refusal: (data) => (data.ok ? null : `Not detached: ${data.problem ?? "it refused."} Nothing has changed.`),
  }),
  channelTool({
    name: "worktree_release",
    channel: "worktrees:release",
    description:
      "Release a git worktree EO is holding. Its branch survives. `force` discards uncommitted changes that exist " +
      "nowhere else — read worktrees_list first and only force what you have decided to lose.",
    kind: "dangerous",
    annotations: { destructiveHint: true, openWorldHint: false },
    render: (data) => (data.released ? "Worktree released. Its branch is untouched." : `Not released: ${data.reason ?? "it refused."}`),
    refusal: (data) => (data.released ? null : `Not released: ${data.reason ?? "it refused."} Nothing has changed.`),
  }),
];

/**
 * Everything EO offers over MCP. What a client actually sees depends on
 * the gate — see gate.ts.
 *
 * Flattened, so that a tool whose name is a deprecated alias appears
 * twice: once under EO's own name and once under the name clients
 * registered against (KAN-162). The twin comes first, because
 * `tools/list` preserves this order and the name to prefer should be the
 * one a model reads first.
 *
 * Both entries are ordinary members of this list, and nothing
 * downstream knows a pair from a single tool: the gate filters them by
 * kind, `toolNamed` finds either by name, and `callTool` treats both
 * exactly alike. The pairing exists in `deprecations.ts` and in the
 * test that holds the two halves to each other, and nowhere in the
 * serving path — which is what it means for an alias to be an alias
 * rather than a second tool.
 */
export const TOOLS: readonly ToolSpec[] = [GUIDE_TOOL, ...READ_TOOLS, ...UNGATED_WRITE_TOOLS, ...GATED_TOOLS]
  .flatMap((tool) => (tool.twin === undefined ? [tool] : [tool.twin, tool]))
  .map(withItemKeys)
  .map(withNarrowing);

/**
 * A tool that takes an item's id, accepting the item's key there too
 * (EO-539).
 *
 * Here, where the catalogue is assembled, for `withNarrowing`'s reason:
 * a tool added later that takes `itemId` or `ticketId` accepts a key
 * without a line of its own. What it gains is the channel a key is
 * resolved through, a sentence in its description, and a description on
 * the argument; `callTool` in server.ts is what resolves the key, before
 * the tool runs (itemKeys.ts). Before `withNarrowing`, so the narrowing
 * sentence stays the last thing a list tool's description says.
 */
function withItemKeys(tool: ToolSpec): ToolSpec {
  const names = itemIdArgumentsOf(tool.inputSchema);
  if (names.length === 0) return tool;
  return {
    ...tool,
    description: `${tool.description} ${KEY_ACCEPTED_SENTENCE}`,
    channels: [...tool.channels, RESOLVE_KEY_CHANNEL],
    inputSchema: withKeyAcceptingProperties(tool.inputSchema, names),
    // Both spellings, whichever this tool advertises: either is accepted
    // (legacyNames.ts), so a key sent under the other one has to be
    // resolved — and a bad one refused — just the same.
    itemKeys: ITEM_ID_ARGUMENTS,
  };
}

/**
 * A read tool with the shared narrowing parameters added (EO-538).
 *
 * Here, where the catalogue is assembled, rather than at each tool —
 * so a read tool added later has `fields`, and with a declared `list`
 * the other four, without a line of its own. What it gains is
 * advertised in its input schema and named in one line of its
 * description; `callTool` in server.ts is what takes the parameters off
 * a call and applies them to the answer (narrow.ts).
 *
 * Applied to both halves of an aliased pair alike, after flattening, so
 * the twin and the name it replaces still differ only in the notice and
 * the spelling of their own arguments.
 */
function withNarrowing(tool: ToolSpec): ToolSpec {
  if (tool.kind !== "read") return tool;
  const description =
    tool.list === undefined
      ? tool.description
      : `${tool.description} Narrow the answer with fields, where, sort, limit and offset on its \`${legacyListName(tool.list)}\` list; the eo_orient guide says how.`;
  return { ...tool, description, inputSchema: withNarrowingProperties(tool.inputSchema, tool.list), narrowing: narrowingKeysFor(tool.list) };
}

/** A declared list path as a client reads it, since answers arrive in the old words (legacyNames.ts). */
function legacyListName(list: string): string {
  return list
    .split(".")
    .map((segment) => LEGACY_BOUNDARY_NAMES[segment] ?? segment)
    .join(".");
}
