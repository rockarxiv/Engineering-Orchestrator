import { readFile } from "node:fs/promises";
import {
  declaredResults,
  dispatchBlocker,
  dispatchBlockers,
  renderWatchNews,
  resolveRoute,
  unseenNews,
  validateRefineGraph,
  WATCH_FAILURE_LIMIT,
  watchFailuresExhausted,
  watchHasGivenUp,
  watchIntervalMs,
  watchRetryDelayMs,
  hasDispatchableItem,
  type Dispatch,
  type DispatchGate,
  type SectionRenderer,
  type TickInput,
  type EligibilityInput,
  type WatchHold,
} from "@eo/engine";
import type { MemoryConsolidateNowResult, MemoryScope, OrganisationPolicy, PersonBudget } from "@eo/core";
import { isDispatchable, isSystemAgent, mockedOutputBody, SYSTEM_ROLE } from "@eo/core";
import {
  backendAllowed,
  disallowedBackendRefusal,
  overPersonBudget,
  personBudgetAcross,
  personBudgetRefusal,
  UNSCOPED_RUN,
  ATTACHMENT_ADD_TOOL_NAME,
  COMMENT_TOOL_NAME,
  EMPTY_SPEC_SHAPE,
  NONE_KIND,
  type AttachmentSource,
  type AgentWriteAnswer,
  type AgentWriteBridgeAddress,
  type AgentWriteRequest,
  FAILED_RESULT,
  VERIFICATION_FAILED_RESULT,
  REVIEW_ACTION,
  asClarification,
  createQuotaRefusals,
  DEBUG_SENT_EVENT,
  LEARNING_REVIEW_ACTIVITY_EVENTS,
  HUMAN_MESSAGE_EVENT,
  MEMORY_DELIVERED_EVENT,
  MEMORY_USED_EVENT,
  SKILL_LOADED_EVENT,
  SKILLS_DELIVERED_EVENT,
  SKILLS_SETTLED_EVENT,
  type SkillLoadAgentEvent,
  type SkillLoadedEvent,
  type SkillsDeliveredEvent,
  type SkillsSettledEvent,
  type SkillsOfferedEvent,
  MEMORY_EXTRACTED_EVENT,
  LEARNING_REVIEW_EVENT,
  LEARNING_REVIEW_TIMEOUT_MS,
  type AgentWriteTool,
  MEMORY_NOTE_TOOL_NAME,
  MEMORY_READ_TOOL_NAME,
  REPOSITORY_CHECKOUT_TOOL_NAME,
  RepositoryCheckoutArgsSchema,
  SKILL_READ_TOOL_NAME,
  SkillReadArgsSchema,
  SKILL_CREATE_TOOL_NAME,
  SKILL_FILE_REMOVE_TOOL_NAME,
  SKILL_FILE_WRITE_TOOL_NAME,
  SKILL_PATCH_TOOL_NAME,
  SKILL_VIEW_TOOL_NAME,
  SKILL_WRITE_TOOLS,
  type SkillWriteTool,
  memoryNoteEnabled,
  DEFAULT_MEMORY_DELIVERY_CHARS,
  DEFAULT_MEMORY_SCOPE_MAX_CHARS,
  DEFAULT_MEMORY_SCOPE_MAX_ENTRIES,
  DEFAULT_SKILL_ARCHIVE_AFTER_RUNS,
  DEFAULT_SKILL_STALE_AFTER_RUNS,
  type MemoryReadScope,
  type LearningReviewKind,
  actionAnswerSummary,
  actionSchemaName,
  definedActionFor,
  INTERPRET_ACTION,
  builtinResults,
  isBuiltinAction,
  servesProject,
  staffingAgents,
  isThreadNotFound,
  isTurnNotEnded,
  TurnNotEndedError,
  outputSchemaFor,
  parseIfFenced,
  quotaStopReason,
  REFINE_ACTION,
  DEFAULT_JOB_RUNS_ON,
  reusesThreadPerItem,
  UNKNOWN_ITEM_TYPE,
  validateActionResult,
  type ActionSubject,
  type Agent,
  type AgentInputAttachment,
  type Registry,
  type SpecShape,
  type AgentEvent,
  type AgentProvider,
  type DebugSent,
  type AgentProviderResumeOptions,
  type ClarificationRequired,
  type HumanMessageEvent,
  type InterruptibleStream,
  type MentionTarget,
  type MessageDelivery,
  type PersistedRunResult,
  type QuotaEvent,
  type RunRuntimeSource,
  type RunStatus,
  refineChildren,
  acceptanceCriteriaOf,
  type Run,
  type RunProcessScope,
  type RunCheck,
  type RunInterruption,
  type ForkCopy,
  type Item,
  type JobRunsOn,
  type UsageEvent,
  type Uuid,
  type PipelineStep,
  type WorkspaceKindSlug,
  skillToolNotServed,
  uuidv7,
  WAITING_RESULT,
  watchDurationWords,
  watchGiveUpWords,
} from "@eo/core";
import { agentAttachmentsHash, EMPTY_ATTACHMENTS_HASH } from "../agentAttachments/fingerprint.js";
import { qualifiedServerName } from "../agentAttachments/pluginDirectory.js";
import { deliverableSkills, skillReadAnswer } from "../agentAttachments/worktreeSkills.js";
import { resolveAgentAttachmentsForRun } from "../db/repos/agentAttachmentsRepo.js";
import type { Db } from "../db/client.js";
import { startOfDay } from "../dateUtils.js";
import { packMeaningInForce, proposedActionsProblem, registry, registryForProject } from "../registry.js";
import { previewBuiltinRunner } from "../preview.js";
import { announceDailyBudgetDefault } from "../guardDefaultNotice.js";
import type { BuiltinOutcome, BuiltinRunner } from "./builtins.js";
import {
  NOTHING_ATTACHED,
  verifies,
  verifyRun,
  type Artifact,
  type Check,
  type PrepareWorkspaceOutcome,
  type PrepareWorkspaceRequest,
  type PreparedWorkspace,
  type VerifiableRun,
  type WorkspaceAttachment,
  type WorkspaceKind,
} from "./workspaceKind.js";

/**
 * Where a run's output is kept (EO-299).
 *
 * One method, named structurally rather than by importing
 * `AttachmentStorage`: what the supervisor needs is somewhere to put
 * bytes that answers with the record a comment can hang, and saying so
 * in one method is what lets a test hand over a directory of its own
 * without building the app's attachment store.
 */
export interface ArtifactStore {
  storeImported(input: { name: string; mimeType?: string; data: Uint8Array }): Promise<Omit<CreateAttachmentRecord, "itemId" | "commentId">>;
  /**
   * Removes files that were stored and then never got a comment to hang
   * on (EO-412). Optional, so a test's one-method store is still a
   * store; `AttachmentStorage` has it.
   */
  rollback?(records: Omit<CreateAttachmentRecord, "itemId" | "commentId">[]): Promise<void>;
}
import { handOffModuleRefusal, handOffRefusal, reportedResultKey, routeResult } from "./routeResult.js";
import { stepScopeFor, trialStepMode } from "../trials/stepModes.js";
import { attemptLimitStop } from "./attemptLimit.js";
import { isOutOfMemoryStop, outOfMemoryStop } from "./outOfMemory.js";
import { scopedProvider } from "./scopedProvider.js";
import { effectiveRunMemoryMaxMb, machineMemoryMb, runScopes, type RunOutOfMemory } from "../process/runScope.js";
import { createUsageTally, sessionTotalBefore, type ThreadUsage } from "./usageTally.js";
import {
  createRun,
  itemsOnArchivedProjects,
  getRun,
  createRunEventBuffer,
  dismissOpenMentionForAgent,
  dismissOpenMentionsForComment,
  getAgent,
  getComment,
  getItem,
  getItemType,
  getProject,
  getStep,
  listActiveRuns,
  listAwaitingInputItemIds,
  listCommentsForItem,
  activeMemoriesIn,
  listRunEvents,
  listRunsForItem,
  listAgents,
  listItems,
  listTransitionsForItem,
  listPipelineSteps,
  listRoutesForPipeline,
  boundGraphForItem,
  graphForItem,
  openMentionsForHuman,
  postComment,
  postOutputComment,
  type PostCommentInput,
  type UpdateRunInput,
  clearSetting,
  getSetting,
  setSetting,
  sumCostCentsForItem,
  usageHistoryOnThread,
  recordSideCall,
  personCostCentsSince,
  sumCostCentsSince,
  updateRun,
  startItemWatch,
  updateItemWatch,
  type ItemWatch,
  type CreateAttachmentRecord,
  type RunEventBuffer,

  stepForItem,
  memoryDeliveredToRun,
  getSkill,
  skillsLoadedByRun,
  ownRunsToSettle,
} from "../db/repos/index.js";
import { budgetRefusal, occurrenceOverBudget, pauseForBudget } from "../jobs/budget.js";
import { readPolicy } from "../policy/policy.js";
import { ownerOfItem, parkForPersonBudget } from "../policy/personBudget.js";
import { postClarificationQuestions, unansweredQuestions } from "../roles/clarificationQuestions.js";
import { buildTurnContext, followUpComments } from "./buildDispatchContext.js";
import { archivedProjectBlocker, buildEligibilityInput, buildTickInput, type PackScheduling } from "./buildTickInput.js";
import { createLocalRecord } from "../record/localRecord.js";
import type { ItemRecord, WorkOffer } from "../record/record.js";
import { LOCAL_DEVICE_ID, type Device, type DispatchAttempt, type DispatchSubject, type PreflightOutcome } from "../record/device.js";
import type { DispatchLease } from "../db/repos/leasesRepo.js";
import { noneWorkspaceKind } from "./noneKind.js";
import { folderWorkspaceKind } from "./folderKind.js";
import { scratchWorkspaceKind } from "./scratchKind.js";
import { resolveItemWorkspace, skillRunScope } from "./workspaceResolution.js";
import { EMPTY_ITEM_FILES_HASH, findReusableThread, itemFilesHash, staleAttachmentsRefusal } from "./threadReuse.js";
import {
  rerunContract,
  findPendingInterpretations,
  findPendingResponses,
  newestParkedRun,
  RESPOND_ACTION,
  type PendingInterpretationDispatch,
  type PendingResponse,
  conversationActionFor,
} from "./manualDispatch.js";
import { awaitsTheStep, interpretationsOn, pendingInterpretation } from "../roles/interpretation.js";
import { ASSIST_ACTION, conversationTurnOptions, CONVERSATION_SETTINGS_KEY, SCENARIO_ACTION } from "../roles/conversationSteps.js";
import { attachRunFiles } from "./runAttachments.js";
import { blockedByActiveRunRefusal, createItemLock, type ItemHold, type ItemLock } from "./itemLock.js";
import { archivedAgentRefusal, mentionDepthRefusal, outOfProjectDispatchRefusal, outOfProjectMentionRefusal, outOfProjectRecoveryNote, rerunRefusal, stoppedByHandNote, type GateRefusal, type ItemBlocker, type OutOfProject, type RerunBlocker } from "./dispatchBlockers.js";
import { declaresNoCriteria, isMissingCriteriaAsk, missingCriteriaRefusal } from "./reviewCriteria.js";
import { recordStop, stopStands } from "./stoppedByHand.js";
import { promptHash } from "../roles/prompts.js";
import { readDebugMode } from "../debug/debugMode.js";
import { capturingProvider, type SendContext } from "../providers/sentCapture.js";
import { scenarioResultProblem } from "../roles/scenario.js";
import { proposedPipelineProblem } from "../roles/discussion.js";
import { liveDrafts } from "./liveDrafts.js";
import { createSideCaller, type SideCaller, type SideCallerOptions } from "../sideCalls/sideCall.js";
import { deliverMemory, memoryReadScopes, memoryScopesFor, type DeliveredMemory } from "../memory/dispatchMemory.js";
import type { MemoryScopeInfo } from "../memory/selection.js";
import { renderMemoryWritingSection } from "../memory/writing.js";
import { closestEntries } from "../memory/duplicates.js";
import { closestEntriesAnswer, writeMemoryNote } from "../memory/memoryNote.js";
import { heldToDelivered } from "../memory/memoryUse.js";
import type { AgentWriteBridge, AgentWriteHandler } from "../mcp/writeBridge.js";
import { writeAgentComment } from "./agentComments.js";
import { projectMovedToTheRecord } from "../db/repos/projectsRepo.js";
import { extractionEvent, extractMemory, runProduce } from "../memory/extraction.js";
import { learningReviewEvent, learningReviewFor, learningReviewPrompt, learningReviewSkillsPrompt, type LearningReviewOutcome } from "../memory/learningReview.js";
import { answerReviewSkillTool, reviewableSkills, reviewSkillState, type ReviewSkillState } from "../memory/reviewSkills.js";
import { runSubject } from "../modules/runName.js";
import { createSideCallSlots } from "../sideCalls/slots.js";
import { endAllProcessTrees } from "../process/processTree.js";
import { createMemoryConsolidator, type MemoryConsolidatorOptions } from "../memory/consolidator.js";
import { archiveReachOf, archiveUnusedSkills } from "../skills/archival.js";
import { currentWatch, markCheckInFlight, ownerMention, recordQuietCheck, waitingLine, watchArrival, watchHold, watchRoundTrips, WATCH_ROUTED_REASON, WATCH_VERIFICATION_FAILED_REASON } from "./watches.js";
import { agentMentionChain } from "./escalation.js";

function safeTurnAttachments(attachments: NonNullable<ReturnType<typeof listCommentsForItem>[number]["attachments"]>): AgentInputAttachment[] {
  return attachments.flatMap((attachment) => attachment.id ? [{
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    origin: attachment.origin ?? "eo",
    synchronizationState: attachment.synchronizationState ?? "local",
  }] : []);
}

/**
 * A step to move to, and the pipeline that step belongs to (EO-59).
 *
 * Both halves, always — including the ordinary case where the pipeline is
 * the one the item is already on. `RouteOutcome` settled that shape for
 * the same reason it applies here: "which pipeline is this" should not be
 * a question with two answers depending on whether the move happens to
 * cross one. A destination that names only a step is a destination whose
 * caller can forget the pipeline, and forgetting it is precisely the
 * half-moved item `stepFor` resolves to nothing.
 */
export interface NextStepDestination {
  stepId: string;
  pipelineId: Uuid;
  /**
   * The declared result the item is sent on, where a route named it
   * (EO-586). Carried to the move (`TransitionItemInput.resultKey`) so
   * whatever listens to moves can say which result it was, which an
   * answer whose meaning a pack decides cannot be read back from.
   */
  resultKey?: string;
}

/**
 * Where a finished run leaves its item.
 *
 * A destination moves it there; `null` leaves it where it is and lets the
 * run finish; `{ park }` leaves it where it is and ends the run
 * `awaiting_input`, so the scheduler stops considering the item until a
 * human replies (KAN-55). Parking is what a `user_attention` route means —
 * the item is flagged in place rather than moved to a "needs human"
 * column, which is what the design asks for.
 */
export type NextStep = NextStepDestination | null | { park: string };

/** The reason a move made for a mocked step on a trial carries (EO-584). */
export const MOCKED_STEP_REASON = "mocked on a trial";

/** Both non-null cases are objects now, so `typeof` no longer separates them. */
function isPark(next: NextStep): next is { park: string } {
  return next !== null && "park" in next;
}

/**
 * A generated tool directory, as the supervisor needs to know it
 * (EO-107).
 *
 * The path is what a turn is pointed at. The names are the snapshot the
 * backend's startup report is judged against, and they travel together
 * for a reason: by the time that report arrives the catalogue may have
 * moved on, and asking the database then would have EO complain about a
 * server this turn was never given, or stay silent about one it was.
 */
export interface PreparedToolDirectory {
  path: string;
  /** Every server written into this directory, by the name the backend will report. */
  serverNames: string[];
}

export interface RunSupervisorOptions {
  db: Db;
  /**
   * Whether a run's processes ended out of memory (EO-738), asked once a
   * run has ended badly. Seam for tests; the run scopes every run's tree
   * is started through (`process/runScope.ts`) otherwise.
   */
  outOfMemory?: (runId: Uuid) => Promise<RunOutOfMemory | null>;
  /**
   * What EO's side calls run on (EO-477): short model calls that are not
   * runs. Absent, every side call fails saying the backend makes none,
   * which is what a test that is not about them wants.
   */
  sideCalls?: Pick<SideCallerOptions, "provider" | "smallModel" | "defaultModel" | "signedIn" | "signInUnreachable">;
  /**
   * Seams for automatic memory consolidation (EO-480): which backend,
   * model and reasoning effort it runs on (the system agent's by default,
   * EO-578), the workspace files it is given, and how often every scope
   * is looked at.
   */
  memoryConsolidation?: Pick<MemoryConsolidatorOptions, "systemAgent" | "repositoryFiles" | "intervalMs" | "sendMessage">;
  /**
   * Where the `eo` server hands every write an agent asks for — `comment`,
   * `attachment_add`, `memory_note` — to this supervisor (EO-543,
   * ARCHITECTURE.md §13.1), read per turn: null until its socket is
   * bound, and absent in a test that is not about it. Its handler is
   * `handleAgentWrite`. A turn given none has write tools that answer
   * that nothing could be written, because nothing could write it.
   */
  agentWriteBridge?: () => Pick<AgentWriteBridge, "tokenFor"> | null;
  /** Runtime gate state at construction. Used to restore the saved preference before any start path can run. */
  initialPaused?: boolean;
  /**
   * The provider for an agent. A function rather than a value since
   * A-06: with two real backends, one provider for the whole supervisor
   * stops being defensible — reviewing Codex's work with Claude is an
   * obvious thing to want, and `agents.provider` already says which is
   * which.
   */
  provider: AgentProvider | ((agent: Agent) => AgentProvider);
  /** Snapshots the executable selection used by each provider subprocess. */
  runtimeSource?: (agent: Agent) => RunRuntimeSource | null;
  /**
   * The environment variables an agent run on this step is given
   * (EO-487): every shared one, with the step's own over them. Null is
   * a run on no step.
   *
   * Asked as each turn opens and handed to the provider with that turn,
   * never to the provider itself: a provider is cached for the life of
   * the process, and a value it held would outlive an edit. Absent in a
   * test that is not about them, which gives every run none.
   *
   * `trialScope` is set for a step a trial plan redirects, on a trial
   * item (EO-584): its trial-only variables in place of the step's own.
   * `stepId` is the scope of the step's own values, which for a trial's
   * copy of a live step is the live step's (`stepScopeFor`).
   */
  runEnvironment?: (stepId: string | null, trialScope?: string) => Record<string, string>;
  /**
   * The names a redirected step's run must start without (EO-584): the
   * variables the step sets for itself that its trial-only scope does not
   * replace. Handed to the backend with the turn, which takes them out of
   * what the CLI inherits as well — leaving a name out of
   * `runEnvironment`'s map does not stop the CLI inheriting EO's own
   * value for it. Absent in a test that is not about them.
   */
  runEnvironmentWithheld?: (stepId: string, trialScope: string) => string[];
  /**
   * Defaults to 1 everywhere —
   * deliberately 1 until the loop is provably reliable (invariant #10),
   * and no bar to the system agent, which none of the three holds back.
   * A function is read on every tick, so a change in settings applies
   * without a restart (U-06).
   */
  limits?: Limits | (() => Limits);
  /**
   * ARCHITECTURE.md, "Guardrails" guardrails. A function is read on every use, so edits in settings
   * (U-06) take effect on the next dispatch rather than the next
   * restart — which is the difference between a tunable limit and a
   * constant you have to relaunch to change.
   */
  guards?: Partial<GuardConfig> | (() => Partial<GuardConfig>);
  now?: () => number;
  tickIntervalMs?: number;
  debounceMs?: number;
  /** How often the inactivity guard looks at the runs in flight (`watchLiveRuns`). */
  watchdogIntervalMs?: number;
  /**
   * Tells the supervisor the computer has just woken — Electron's
   * `powerMonitor` in the app. Returns how to stop listening.
   *
   * Absent in tests and on a server, where nothing sleeps. A watchdog
   * pass that comes long after it was due is taken as a wake as well,
   * which is the one signal every platform gives: a process that was not
   * running did not run its timers.
   */
  onWake?: (listener: () => void) => () => void;
  /**
   * Whether EO can reach the network right now — Electron's
   * `net.isOnline()` in the app, always true on a server (EO-457).
   *
   * Read on every tick. While it says no, no step that keeps checking is
   * checked: a check that cannot reach what it checks fails, and its
   * failures would escalate the item over an outage. Absent means
   * online.
   */
  isOnline?: () => boolean;
  /**
   * Whether this machine sleeps — true on a desktop, false on a server
   * (`Platform.sleeps`, EO-514). Absent means it does.
   *
   * A wake holds every watch for `WAKE_GRACE_MS`, because the network is
   * often not back yet. A machine that does not sleep never wakes: a
   * watchdog pass that comes late there is a paused container or a
   * stalled event loop, its network was never gone, and holding the
   * watches would only delay them. The late pass still counts for the
   * inactivity guard — time the process was not running is no run's
   * silence wherever it happens.
   */
  sleeps?: boolean;
  /**
   * The workspace kinds this installation has, by slug (EO-295,
   * ARCHITECTURE.md, "The interface").
   *
   * Eight options until this story — a hook that prepared a worktree,
   * three that checked what had been done in one, two that released one,
   * two that lent the agent what the checkout had to offer — every one of
   * them typed on a path and none of them naming the thing they were
   * about. They are five members of one value now — four methods and a
   * table of verifiers keyed by action (EO-297) — contributed by the
   * installed packs and keyed by the slug a workspace row names.
   *
   * Empty is a supervisor with nothing installed, and it still runs:
   * every dispatch prepares the process working directory and nothing
   * else, which is what a test that is not about workspaces wants and
   * what an EO with no pack is. EO-296 is where that fallback is deleted
   * in favour of the `none` kind.
   */
  kinds?: ReadonlyMap<WorkspaceKindSlug, WorkspaceKind>;
  /**
   * What a `builtin` step runs, by action name. Injectable for the same
   * reason the kinds are: the shipped implementations touch git and the
   * forge, and a test wants neither.
   */
  builtins?: Record<string, BuiltinRunner>;
  /**
   * What a `module` step runs, by module id (KAN-105).
   *
   * A lookup rather than a record, because the catalog is rows: a module
   * saved a second ago has to be runnable without the supervisor having
   * been rebuilt. Returning undefined — an id naming nothing, an
   * archived module, one nobody approved — lands on the same "not one of
   * EO's functions" path a mistyped builtin does, which parks the item
   * and says so (invariant #8).
   */
  moduleRunner?: (moduleId: string) => BuiltinRunner | undefined;
  /**
   * The record this device reports to (EO-322,
   * `ARCHITECTURE.md`, "The record").
   *
   * The supervisor is the **device**: it claims a dispatch under a
   * lease, runs the machine-local preflight, runs the dispatch and
   * reports. It does not write `items.stepId` — it sends a transition
   * command and the record applies it (invariant #1), which is what
   * makes two desktops and a server one writer rather than three.
   *
   * Defaults to a local record over the same database, which is solo
   * mode: one process, both roles, a local lease, one code path. The
   * composition root passes the record it shares with the IPC commands.
   */
  record?: ItemRecord;
  /**
   * Whether this process runs the device half at all (EO-324, ARCHITECTURE.md, "The record").
   *
   * True on a desktop, which is somebody's machine. False on a server,
   * which is the record: it owns item state, it runs the only scheduler
   * and it answers `record:work`, but the work happens on the machines
   * that ask it for some.
   *
   * What it switches off is the *device* — asking for work, holding
   * claims, running mentions and replies — and nothing else. The
   * record's own housekeeping still runs on every tick, because an
   * expired lease has to be released and said out loud (invariant #8)
   * whether or not this process would have run the work itself.
   *
   * Without it a server is a third contender for every lease, and one
   * that always wins: its record is in the same process and answers
   * with no network in the way. It would win only to refuse at
   * preflight — there is no backend signed in on a server — so every
   * item would be claimed, refused, commented on and released, on a
   * loop, while the desktops that could actually do the work were never
   * offered it.
   *
   * **A server sets it true since EO-330, and `runsWhere` is what makes
   * that safe.** Placement gave the server work of its own — a job a
   * person put on it, checked at the moment they put it there against
   * everything the pipeline needs (ARCHITECTURE.md, "Where a job runs") — so a server that ran no
   * device loop would file those items and leave them. What kept the
   * paragraph above true was never the flag: it was that the server
   * would be offered *everything*. It is offered only server-placed
   * work now, so it contends for nothing a desktop wants, and the
   * preflight it reaches is one the placement check has already been
   * over. The flag stays for what it says on its face — a process that
   * is the record and no kind of device at all.
   */
  dispatches?: boolean;
  /**
   * Which kind of device this process is, for the record to place work
   * by (EO-330, `ARCHITECTURE.md`, "Where a job runs").
   *
   * `device` — somebody's desktop, with their logins, their secrets and
   * their disk — or `server`, the organisation's. It is not a second
   * spelling of `dispatches`: what that one says is whether this
   * process runs a device loop, and what this one says is which work
   * the loop may be offered.
   *
   * Defaulted to `device` because that is what every caller that has
   * never thought about it is: a desktop, a test, and the record door a
   * remote desktop reaches (`offerWork` takes its own, so a server
   * answering `record:work` for somebody's laptop answers about the
   * laptop).
   */
  runsWhere?: JobRunsOn;
  /**
   * Which device this supervisor is. One per machine; `local` where
   * there is only ever one.
   *
   * A function is read on every use, because the answer changes without
   * a restart: signing in to an organisation issues this machine a
   * device row, and a supervisor that had closed over `local` would go
   * on claiming leases under a name the record's Devices list has never
   * heard of — so the admin's "which machine went quiet" would name a
   * device nobody can revoke. Signing out takes it back the other way.
   */
  deviceId?: string | (() => string);
  /**
   * How long a claim stands without being renewed.
   *
   * Left alone outside tests: the default is minutes against a
   * five-second tick, and this supervisor renews every claim it holds
   * on every tick.
   */
  leaseTtlMs?: number;
  /**
   * Is this agent's backend usable — signed in, credentials present?
   * Checked before a run row exists, so "you are not logged in" arrives
   * as an engine comment on the item (invariant #8) instead of a
   * stack trace from inside a provider stream. Defaults to yes, which
   * is right for the fake and scripted providers.
   */
  checkAuth?: (agent: Agent) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * What EO is configured to do for this agent and deliberately will
   * not, as sentences to post on the item (EO-108).
   *
   * Distinct from `checkAuth`, and the difference is the whole point:
   * that refuses the dispatch, this lets it proceed. The case it exists
   * for is an attached MCP server whose declared value EO does not
   * carry to a Codex agent — the server is still delivered and still
   * useful, so refusing would be wrong, and saying nothing would leave
   * a person watching an agent fail to authenticate against a tool they
   * had every reason to think was configured. Invariant 8 with nothing
   * dropped rather than nothing said.
   *
   * Provider-shaped knowledge stays out of here: the supervisor asks
   * for sentences and posts them, and `engine.ts` decides what is worth
   * a sentence.
   */
  dispatchNotices?: (agent: Agent) => string[];
  /**
   * Why nothing can be dispatched at all, whatever this dispatch is
   * (KAN-144).
   *
   * The one condition that is not about the item, the agent or the
   * step: **no pack is installed**, so nothing supplies a workspace to
   * run in, a shape to answer in, a function to run or a word of wiring.
   * The core still composes, starts and ticks with nothing installed —
   * that is the invariant this phase adds — and this is what stops it
   * composing and then dispatching into nothing.
   *
   * Asked on both paths, which is the whole reason it is a seam of its
   * own rather than a sentence folded into `checkAuth`: an agent
   * dispatch has an agent to authenticate and a `builtin` step has
   * neither an agent nor a backend, so a refusal that lived in the auth
   * check reached exactly half of the dispatches it needed to. A
   * builtin's half is worse than uncovered: with an empty registry the
   * action classifies as a module id, so the step parked saying a module
   * was missing, deleted or unapproved — a sentence about a thing the
   * pipeline never named.
   *
   * `role` is the step's owner where there is one and null for a
   * `builtin` step, which is owned by nobody; the caller words the
   * refusal from whichever it was given. Returning null — every real
   * installation, every test — carries on.
   */
  dispatchRefusal?: (subject: { role: string | null; action: string }) => string | null;
  /** Temporary provider readiness. False silently defers dispatch without creating a run or escalation. */
  isAgentAvailable?: (agent: Agent) => boolean;
  /**
   * The directory this dispatch's agent reads its attached MCP servers
   * and skills out of (EO-107), or null when it has nothing attached.
   *
   * Injected for the reason a workspace kind is: generating it writes
   * files, and the supervisor keeps knowing nothing about the
   * filesystem. Defaults to nothing attached, which is what every test
   * that is not about this wants and what an EO with an empty catalogue
   * is anyway.
   *
   * Synchronous, unlike its neighbours. It writes a handful of small
   * files with the sync `fs` calls, and `reconcile()` — one of the three
   * paths that has to call it — is not async and cannot become so
   * without every caller of it changing shape.
   *
   * Called on each of the three paths rather than once per thread: it is
   * cheap, it is how a directory somebody deleted between runs heals,
   * and a resumed turn has to be pointed at the directory again because
   * resuming spawns the backend's process afresh.
   */
  prepareToolDirectory?: (item: Item, agent: Agent) => PreparedToolDirectory | null;
  /**
   * The item is finished with, and so are the directories its agents
   * were reading their servers and skills out of (EO-107).
   *
   * Here rather than where a run ends, and that is the whole decision: a
   * run that parks at `awaiting_input` ends while its conversation is
   * still waiting on a person, and the reply that unparks it resumes
   * that same thread — which needs the same directory. A settled item
   * is the first moment nothing on it will be resumed again, which is
   * why this fires beside the kind's own `release` and its worktree.
   */
  releaseToolDirectories?: (item: Item) => void;
  /**
   * Where the `none` kind's empty directories are made (EO-296).
   *
   * The same seam the git kind takes a `worktreeRoot` for, and for the
   * same reason: a test must be able to watch a run happen somewhere
   * without writing into the person's `~/.eo`. The app passes nothing.
   */
  noDiskRoot?: string;
  /**
   * Where the `scratch` kind's per-run directories are made (EO-299).
   *
   * `noDiskRoot`'s seam for the other kind the core ships with a disk,
   * and taken for the same reason: a test that watches a scratch run
   * produce a file, and then watches the directory go, must be able to
   * do it somewhere other than the person's `~/.eo`. The app passes
   * nothing.
   */
  scratchRoot?: string;
  /**
   * Where the files a run produced are kept (EO-299).
   *
   * What a workspace kind hands back as a *file* artifact — the report
   * on the drive, everything in the scratch directory — is copied in
   * here and hung off the item's output comment as an attachment. An
   * attachment is a file rather than a string, and a `.docx` read
   * through JavaScript text is a corrupt `.docx`, which is why this is
   * a store rather than a body.
   *
   * Absent, a file artifact is named in the output comment and left
   * where the run put it, and no kind is told to let go of it: a
   * supervisor with nowhere to put a file must not delete the only copy
   * of one. `main/index.ts` passes the same store the rest of the app
   * writes attachments into; a test that is not about output passes
   * nothing.
   */
  artifactStore?: ArtifactStore;
  /**
   * What the installed pack requires of a step before it will run
   * (KAN-161).
   *
   * The developer pack's is that a step judging an item has criteria to
   * judge it against (EO-213). Absent, the engine's own reasons are the
   * only ones an item is turned away for.
   */
  dispatchGate?: DispatchGate<GateRefusal>;
  /**
   * The prompt sections the installed pack writes itself (KAN-161).
   *
   * Passed to the default `buildContext` below rather than read here:
   * acceptance criteria, the plan-mode check and the `refine` wording
   * are a pack's words, and the assembly in `packages/engine` renders
   * whatever it is handed. Absent, an agent is sent the core's sections
   * and nothing else.
   */
  sectionRenderers?: readonly SectionRenderer[];
  /** Defaults to buildTurnContext (E-06). Injectable so tests can assert on what an agent was actually handed. */
  /**
   * May be async: assembling a context can need the repository on disk
   * (F-06 reads the pull request template out of the base branch).
   *
   * `resumingRun` is the agent's prior run on this item whose provider
   * thread this dispatch is continuing (EO-86), or null when it is
   * opening a fresh one — which is every dispatch by an agent that has
   * not opted into thread reuse. It is the same seam rather than a
   * second one beside it because both answers are the prompt this turn
   * sends, and a test that wants to know which was built asks the same
   * question in both cases.
   *
   * Both paths that reach a provider come through here, including
   * `resumeItem`, where a person's reply continues a parked run — that
   * one always names a `resumingRun`, since a reply with no thread to
   * carry on is a fresh dispatch and takes the branch above instead.
   */
  buildContext?: (
    db: Db,
    item: Item,
    agent: Agent,
    action: string,
    resumingRun: Run | null,
  ) => string | Promise<string>;
  /**
   * What state an item moves to on success.
   *
   * Supplied by an installed pack's wiring (KAN-144), because what a
   * result *means* is domain knowledge: review's approve/reject branch
   * reads a reviewer's structured verdict, and this supervisor has no
   * business knowing what a reviewer is.
   *
   * **`undefined` is "no opinion"** and falls through to the default
   * below — the reported result key, else `done`, routed through
   * `step_routes` like any other. `null` is not the same answer: it
   * means "do not move this item" and let the run finish, which is
   * what a conversation turn is.
   *
   * A destination names its pipeline as well as its step (EO-59), which
   * an override reads off the step it chose rather than assumes.
   *
   * `role` is the dispatched agent's, or null where EO ran the step
   * itself (EO-422). A pack reads it to tell its own meaning of an
   * action name from one the role defined for itself, and answers
   * `undefined` for the second.
   */
  resolveNextState?: (
    currentState: PipelineStep,
    states: PipelineStep[],
    parsedResult: unknown,
    action: string,
    item: Item,
    role?: string | null,
  ) => NextStep | undefined;
  /**
   * Called after a run succeeds and before it transitions, for
   * role-specific side effects the generic supervisor shouldn't know
   * about — R-03 uses it to post the reviewer's feedback into the
   * thread, which is the only thing the next attempt receives from it.
   */
  onRunSucceeded?: (
    item: Item,
    agent: Agent,
    action: string,
    parsedResult: unknown,
    runId: Uuid,
  ) => void;
  /** Throttled push to the renderer — injected so this stays testable without Electron/IPC. */
  onPushEvents?: (runId: string, events: AgentEvent[]) => void;
  /**
   * Whether debug mode is on, asked at each send (EO-392).
   *
   * Defaults to the setting in this supervisor's database, read every
   * time rather than once — so turning it on in Settings applies to the
   * next dispatch, not the next launch. Injectable for tests.
   */
  debugMode?: () => boolean;
  /**
   * Announces that something the UI shows has changed (F-05). Carries
   * ids only: a push means "ask again", and the renderer refetches
   * through the same channels it always uses. Pushing new state instead
   * would give the UI a second source of truth free to disagree with
   * the first.
   */
  onItemChanged?: (itemId: Uuid) => void;
  onRunChanged?: (runId: Uuid, itemId: Uuid, status: RunStatus) => void;
  /** A memory scope's consolidation was queued, started or finished (EO-589). Ids only, by the rule above. */
  onMemoryConsolidationChanged?: (scope: MemoryScope) => void;
  pushThrottleMs?: number;
  /**
   * "pid alive and ours" from the design's reconciliation algorithm. No provider
   * in this codebase yet spawns a real subprocess and records its pid on
   * the run (that lands with a future provider) — `run.pid` is always
   * null in production today, so the default is conservative and always
   * says no, which correctly falls through to the thread_id/orphan
   * branches. Override with a stub to exercise the reattach branch, or
   * to prove a recycled pid isn't mistaken for a live one (E-04).
   */
  isOurLiveProcess?: (run: Run) => boolean;
}

/** ARCHITECTURE.md, "Guardrails" guardrails table. The app reads these from the settings store on every tick (`readGuards`); a supervisor built without them falls back to `DEFAULT_GUARDS` below. */
export interface Limits {
  globalConcurrency: number;
  perAgentConcurrency: number;
  /** Per repo (D-04). Defaults to 1 with the others, so behaviour is unchanged for a single repository. */
  perRepositoryConcurrency: number;
}

export interface GuardConfig {
  /** Maximum real runs in one state-entry, direct-request, or authorized retry cycle. */
  perItemAttemptLimit: number;
  wallClockTimeoutMs: number;
  /** No word from the backend for this long, with no tool running, ends the run (or carries it on, after a sleep). 0 is off. */
  inactivityTimeoutMs: number;
  perItemBudgetCents: number | null;
  dailyBudgetCents: number | null;
  /**
   * Whether a free-text reply to a parked builtin or module step is read
   * by the system agent (EO-184).
   *
   * A switch rather than a settled question, because the cost argument
   * cuts both ways: `builtins.ts` is right that there is no judgement in
   * `git worktree add` and that paying a model for it buys nothing, and
   * it is equally right that reading a sentence somebody typed is the
   * one part of this with judgement in it. Off, the behaviour is exactly
   * what it was before this existed — the step runs again and asks
   * again — which is why it belongs beside the other limits a person
   * sets rather than in code.
   */
  interpretReplies: boolean;
  /**
   * How many agent-to-agent mention hops an item may carry since the
   * last human comment (EO-212).
   *
   * The original design's other guard — "agents may not resolve a mention aimed at you" —
   * is structural, in `resolveMentionsForComment`. This one is a number
   * because the right number is a judgement about how much unattended
   * back-and-forth is useful, and nothing else in EO bounds the chain:
   * `wallClockTimeoutMs` bounds one run, `perItemAttemptLimit` is per
   * initiation and each mention is a fresh one, and both budgets ship
   * unset.
   */
  agentMentionDepth: number;
  /**
   * How many times steps that keep checking may send an item to another
   * step since a person last commented on it (EO-456). Past it the item
   * is parked at the watch with a comment, and any comment from a person
   * starts the count again.
   */
  watchRoundTripsPerItem: number;
  /**
   * How many characters of memory a dispatch is given without a
   * selection being asked for (EO-478). Over it, a small model picks;
   * if that fails, the newest entries up to this many are delivered.
   */
  memoryDeliveryChars: number;
  /**
   * The most active memory entries, and characters of them, one scope
   * holds (EO-480). Reaching either queues a consolidation of that scope.
   */
  memoryScopeMaxEntries: number;
  memoryScopeMaxChars: number;
  /**
   * How many runs in a row an agent's unlocked skill may be given without
   * a load before it is stale, and before EO archives it (EO-720).
   */
  skillStaleAfterRuns: number;
  skillArchiveAfterRuns: number;
  /**
   * Whether trial items whose conversation is still testing a draft are
   * offered a slot before live work (EO-582). The order only.
   */
  trialsFirst: boolean;
  /**
   * The memory one run's processes may use together, in megabytes, or
   * null for EO's default for this machine (EO-738). Where the machine
   * allows, every run's process tree starts in a systemd scope of its
   * own with this as its `MemoryMax`.
   */
  runMemoryMaxMb: number | null;
}

/**
 * What a supervisor constructed with no `guards` falls back to — which
 * in the app is never: `engine.ts` passes `readGuards(db)` on every
 * tick, and *that* is where the shipped defaults live
 * (`DEFAULT_GUARD_CONFIG`, including the daily spend ceiling EO-211 put
 * on by default).
 *
 * Both budgets stay null here on purpose. This table is the fallback for
 * a supervisor built without a settings store — every test in this
 * folder — and a figure in it would put a second, quieter answer beside
 * the one a person can see and change on the Guardrails screen.
 */
export const DEFAULT_GUARDS: GuardConfig = {
  perItemAttemptLimit: 3,
  wallClockTimeoutMs: 2 * 60 * 60 * 1000,
  inactivityTimeoutMs: 10 * 60 * 1000,
  perItemBudgetCents: null,
  dailyBudgetCents: null,
  interpretReplies: true,
  agentMentionDepth: 3,
  watchRoundTripsPerItem: 5,
  memoryDeliveryChars: DEFAULT_MEMORY_DELIVERY_CHARS,
  memoryScopeMaxEntries: DEFAULT_MEMORY_SCOPE_MAX_ENTRIES,
  memoryScopeMaxChars: DEFAULT_MEMORY_SCOPE_MAX_CHARS,
  skillStaleAfterRuns: DEFAULT_SKILL_STALE_AFTER_RUNS,
  skillArchiveAfterRuns: DEFAULT_SKILL_ARCHIVE_AFTER_RUNS,
  trialsFirst: true,
  runMemoryMaxMb: null,
};

export interface ReconcileSummary {
  reattached: number;
  resumed: number;
  orphaned: number;
}

/**
 * Why a run is being stopped (EO-175).
 *
 * It decides one thing, and it is not about the run: what the scheduler
 * does on the next tick. A cancellation that is the whole of what
 * somebody asked for ends the initiation — EO does not offer the same
 * step again by itself — while one that is part of a larger action does
 * not, because that action has already decided where the item goes.
 * The seam is not new: `restartAfterResume` drew exactly this
 * distinction for the pause that puts its runs back when the engine
 * resumes, and this widens it rather than adding a second one beside it.
 */
export type Cancellation =
  /**
   * Somebody asked for this run to stop and for nothing else: the Cancel
   * button, `run_cancel` over MCP. The item stays where it is, and it
   * takes a person — a mention, a move, or resuming a hold — to start it
   * again.
   */
  | "asked-to-stop"
  /**
   * The cancellation belongs to something larger, and that larger thing
   * has already settled what becomes of the item: a move routes it, a
   * hold parks it, a delete removes it, a shutdown ends the process.
   * Each writes its own sentence in the thread, and none of them wants
   * this one.
   *
   * It also covers the opposite shape, where the answer is that nothing
   * becomes of the item and it carries straight on: a rebuild of the
   * repository index stops whatever holds the checkout because it is
   * about to delete the index out from under it, and wants that work
   * dispatched again the moment it lets go. Read as a person's stop,
   * that maintenance would end the initiation it interrupted and the
   * rebuild's own success would be the reason the item then sat still.
   */
  | "superseded"
  /** `pause({cancelRunning})`: these runs are put back when the engine resumes, exactly as they always were. */
  | "restart-on-resume";

/** A person's message, on its way to a run that is already going (EO-176). */
export interface SteeredMessage {
  /** The comment it was posted as. The comment is the record; this is the delivery. */
  commentId: Uuid;
  body: string;
  /** What was asked for. `"next"` never touches the backend — it is recorded and left for the next turn. */
  delivery: MessageDelivery;
  /**
   * The files posted with it (EO-395), as a turn's own prompt would
   * name them.
   *
   * Optional, and the usual caller leaves it out: `steerRun` reads them
   * off the comment itself, which is the record, so a caller cannot
   * forget them and cannot claim one the comment does not carry.
   */
  attachments?: AgentInputAttachment[];
}

/**
 * What became of it (EO-176).
 *
 * Four answers rather than a boolean, because three of them mean "the
 * message is queued" for three different reasons and a person is owed
 * the right sentence. Only `"steered"` means the running agent has it.
 */
export type SteerResult =
  /** Pushed into the turn that is running. The agent's next step reflects it. */
  | "steered"
  /** Queued, because that is what was asked for. */
  | "queued"
  /** Queued, because this process is not driving that run — it ended, or another process owns it. */
  | "no-live-run"
  /** Queued, because this run's backend has no way to be spoken to mid-turn. */
  | "unsupported"
  /** Queued, because the turn ended between the message being written and the push landing. */
  | "turn-over";

export interface RunSupervisor {
  start: () => void;
  stop: () => void;
  /**
   * Makes a write an agent asked for with one of the `eo` server's write
   * tools, handed over the agent write bridge for an item (EO-543): as
   * the turn this process is driving on that item, held to that turn's
   * rules, through the record that holds the item's project where that
   * applies — and answers with what happened, which is what the tool
   * answers the agent. A call on an item with no turn being read now is
   * refused, and nothing is written.
   */
  handleAgentWrite: AgentWriteHandler;
  /**
   * This machine, as the record sees it (EO-322).
   *
   * On the interface for the item lock's reason: the supervisor is not
   * the only thing that will ever claim an item on this device, and a
   * second answer to "which device is this and what is it holding"
   * would be the thing that drifts. Its lease is also what a test
   * asserts against — a claim taken, refused or released is the only
   * visible half of a preflight that writes no run row.
   */
  device: Device;
  /**
   * What the record will let a device run (EO-324, ARCHITECTURE.md, "The record").
   *
   * The supervisor's own use of it is its tick. It is on the interface
   * because a process that *is* the record has a second caller: the
   * `record:work` handler, which is another device asking this one for
   * work. Both go through here so that the record's scheduler is the
   * scheduler — same guards, same caps, same pack contributions — and
   * not a second one assembled beside it.
   */
  offerWork: (deviceId: string, capacity: number) => Promise<WorkOffer[]>;
  /** Call after any item/run state change so the next tick isn't stuck waiting on the interval. */
  /**
   * Starts the backend for the turn a person is typing in a conversation
   * (`AgentProvider.prewarm`). Answers whether one was asked for; nothing
   * is recorded either way.
   */
  prewarmConversation: (itemId: Uuid, agentId: Uuid) => Promise<boolean>;
  /** Asks for a tick soon — at once with `promptly`, for a person's own send. */
  notifyStateChange: (options?: { promptly?: boolean }) => void;
  /**
   * Stops a run. `cancellation` says on whose behalf, which is what
   * decides whether the scheduler offers the step again (EO-175); it
   * defaults to the plain reading of this verb, somebody asking for the
   * run to stop.
   */
  cancelRun: (runId: string, cancellation?: Cancellation) => void;
  /**
   * Says something to a run that is already going (EO-176).
   *
   * Beside `cancelRun` because it reads the same map of live streams,
   * and deliberately *unlike* it in every other respect: no run row is
   * written, `items.step_id` is untouched, no `Cancellation` is
   * classified and the item lock is not taken. Nothing transitions, so
   * invariant #1 is not in play; the subprocess was already running and
   * no human is being waited on, so neither is invariant #9. A person
   * who wants the run to *end* still presses Cancel.
   *
   * The message is already a comment on the item by the time this is
   * called — invariant #4, and the reason this returns a word rather
   * than throwing: every answer here leaves the person's message safely
   * recorded, and what differs is only which turn reads it.
   */
  steerRun: (runId: string, message: SteeredMessage) => Promise<SteerResult>;
  shutdown: () => Promise<void>;
  /** Runs one tick and waits for every dispatch it produced to finish. For tests and manual triggers, not the interval loop. */
  runOnce: () => Promise<void>;
  /** One pass of the inactivity guard, as the watchdog timer makes every `watchdogIntervalMs`. */
  watchLiveRuns: () => void;
  /**
   * The reply path: when a human (or the escalated-to agent) replies to an
   * item whose last run is awaiting_input, call this to resume the same
   * thread — a new run row, attempt + 1, same thread_id.
   *
   * `requestedBy` decides what a lost lock sounds like; see
   * `ResumeItemOptions`.
   */
  resumeItem: (itemId: Uuid, opts?: ResumeItemOptions) => Promise<void>;
  /**
   * The design's boot-time reconciliation: for every run left `queued`/`running`
   * by a prior process, either leave it alone (still ours and alive),
   * resume it on its thread, or mark it orphaned and hand the item
   * back. Idempotent, and awaited by `start()` before the first tick so
   * nothing dispatches against unreconciled state. Asynchronous because
   * a recovered run is given the same tool surface a fresh one would be,
   * and settling that reads a row and asks a binary (EO-151).
   */
  reconcile: () => Promise<ReconcileSummary>;
  /**
   * The global pause (ARCHITECTURE.md, "Guardrails"). Stops new dispatches of every agent but
   * the system agent, and every builtin and module, as of the next tick —
   * `tick()` itself answers to the paused flag, so this doesn't depend on
   * any particular guard's plumbing. `cancelRunning` additionally aborts
   * every run in flight right now, the system agent's excepted.
   */
  pause: (opts?: { cancelRunning?: boolean }) => void;
  /**
   * EO closing: `pause`, with nobody excepted (EO-615). No run of any agent
   * starts from here on, and `cancelRunning` stops the system agent's too.
   * One way: `resume` does nothing afterwards.
   */
  beginClose: (opts?: { cancelRunning?: boolean }) => void;
  /** Lifts the pause — dispatch resumes as of the next tick. */
  resume: () => void;
  isPaused: () => boolean;
  /**
   * Why this item is not going to be dispatched, or null when the only
   * thing between it and a run is a free slot (EO-135, KAN-161).
   *
   * On the interface because the answer depends on what is *installed*:
   * the gate that turns an item away is a pack's (`dispatchGate`), and
   * this supervisor is the only thing holding the fold. The IPC command
   * that acknowledges a resume used to build the scheduler's input for
   * itself, which was safe while every rule was the engine's own and
   * became a lie the moment one of them was not — EO promising a pickup
   * that the very next tick refuses is #142 again, one layer along.
   */
  dispatchBlockerFor: (itemId: Uuid) => ItemBlocker | null;
  /** Provider streams currently owned by this process. Preflight and stale DB rows are not active agents. */
  activeRunCount: () => number;
  /** The active runs a pause or a close is waiting out: every one but the system agent's while it is only paused, which carry on. */
  finishingRunCount: () => number;
  /**
   * One run at a time per item (EO-132).
   *
   * On the interface rather than a closure variable inside it, because
   * the supervisor is not the only thing that starts a process in an
   * item's worktree: rebuilding a repository index runs on the IPC side
   * and spawns an indexer in the same checkout, so it has to be able to
   * take the same lock. A
   * second, differently-worded answer to "is anything working on this
   * item" is exactly what this story exists to remove.
   *
   * Callers outside the supervisor take it and release it themselves —
   * `acquire` for the whole span of their work, or `run` to have the
   * release done for them.
   */
  itemLock: ItemLock;
  /** Resolves after all work already admitted through the activity gate has settled. */
  waitForIdle: () => Promise<void>;
  /**
   * Asks a small model one short question (EO-477). Never throws: the
   * answer, or a reason and a sentence. A call made inside a run's
   * dispatch or settle passes `insideRunId` and uses that run's slot; one
   * made on its own waits for a free global slot and holds it. Shutdown
   * stops every call in flight.
   */
  sideCall: SideCaller["sideCall"];
  /**
   * A person asking for one memory scope to be consolidated now (EO-589):
   * handed to the consolidator this supervisor owns, which queues it with
   * the trigger `manual`. Refused while EO is paused or stopping.
   */
  consolidateMemoryNow: (scope: MemoryScope) => MemoryConsolidateNowResult;
  /** Whether a consolidation of the scope is queued or running now, or neither (EO-589). */
  memoryConsolidationPending: (scope: MemoryScope) => "queued" | "running" | null;
}

const DEFAULT_TICK_INTERVAL_MS = 5000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 30_000;
/** How much later than due a watchdog pass must be to mean the process was not running. */
const LATE_PASS_MS = 90_000;
/** What a run whose backend went quiet across a sleep is told when it is carried on. */
const SLEEP_RESUME_MESSAGE =
  "(The computer went to sleep while you were working, and your session did not pick up again after it woke. Continue from where you left off.)";
const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_PUSH_THROTTLE_MS = 200;
const RECONCILE_RESUME_MESSAGE =
  "(EO restarted after an interruption; continuing this thread from where it left off.)";
/** What a run cut short by "Stop agents and close" is told when EO opens again and carries it on. */
const QUIT_RESUME_MESSAGE =
  "(EO was closed while you were working and has just been opened again. Continue from where you left off.)";
/**
 * How many times one initiation may be interrupted before EO stops
 * carrying it on by itself.
 *
 * Interruptions are not attempts (`RunInterruption`), so without a
 * ceiling a run that took EO down with it would be resumed into the
 * same crash on every launch for ever — Claude Desktop parks a session
 * its crash-loop guard catches for the same reason. Five is well past
 * what closing a laptop and quitting the app produce in an ordinary
 * day, and well short of a loop going unnoticed.
 *
 * Not the system agent's (EO-616), and a person chose that knowing what
 * it gives up: nothing else bounds this loop, so a run of the system
 * agent that takes EO down with it is resumed on every launch.
 */
const MAX_INTERRUPTIONS_PER_INITIATION = 5;
const DEFAULT_LIMITS = {
  globalConcurrency: 1,
  perAgentConcurrency: 1,
  perRepositoryConcurrency: 1,
};
/** A-02: "max 2 retries → then escalate". One initial attempt plus this many corrections. */
const MAX_RESULT_VALIDATION_RETRIES = 2;

/** The roles a pause does not hold (`EligibilityInput.pauseExemptRoles`), and what a close leaves of them. */
const PAUSE_EXEMPTIONS: ReadonlySet<string> = new Set([SYSTEM_ROLE]);
const NO_PAUSE_EXEMPTIONS: ReadonlySet<string> = new Set();
/** The roles no concurrency cap holds back (`TickInput.uncappedRoles`). */
const UNCAPPED_ROLES: ReadonlySet<string> = new Set([SYSTEM_ROLE]);
/**
 * How many events a wound-up turn may still emit before the drain gives
 * up (KAN-24). Generous for a wind-down — the observed tail is two —
 * and finite, so a backend that ignores `interrupt` cannot hold an
 * already-ended run open.
 */
const MAX_DRAIN_EVENTS = 50;
/**
 * What a backend says while being wound up, as opposed to something
 * going wrong (KAN-26). `run_events.type` is an open string (D-02), so
 * a new kind is a new payload shape rather than an engine change.
 */
const WIND_DOWN_EVENT = "wind_down";

const FORCED_RESTARTS_KEY = "engine.forced-restarts";

/**
 * What a dispatch was asked for beyond its item, agent and action.
 *
 * Lifted out of the parameter position it was written in so the lock
 * wrapper and the dispatch it wraps can be given the same shape without
 * either of them restating it (EO-132).
 */
interface DispatchOptions {
  initiationId?: string;
  transitionOnSuccess?: boolean;
  onRunAdmitted?: () => void;
  /**
   * Asked again after every preflight await, and last of all immediately
   * before the run row is written (EO-135). False abandons the dispatch
   * having written nothing.
   *
   * Preflight is auth, a worktree and a context assembly, which is
   * seconds at best and a git clone at worst, and the caller's decision
   * to dispatch was made before all of it. `dispatchHeld` already
   * rechecks the three things it owns — pause, the item's existence,
   * the runtime — but not the scheduler's eligibility, so a person who
   * holds an item while a run is being prepared used to get the run
   * anyway. Whoever knows what eligibility meant for this dispatch
   * passes it in here rather than having that knowledge duplicated.
   *
   * The caller is told nothing by this: a dispatch that turns back
   * writes no run, and the caller checks for one afterwards.
   */
  stillEligible?: () => boolean;
  /**
   * The step the scheduler dispatched from, where there is one.
   *
   * Absent on a manual dispatch — a mention reply runs wherever the
   * item happens to sit — and `createRun` then reads the item's
   * own step, which is that same answer.
   */
  stepId?: string;
  /**
   * The caller is already holding this item's lock and this dispatch
   * is part of the work it claimed the item for (EO-132).
   *
   * `resumeItem` is the only caller that sets it: a reply that turns
   * out to have no thread to resume falls through to a fresh dispatch,
   * and that dispatch is the *same* piece of work — asking for the lock
   * a second time would have the reply refuse itself.
   *
   * A caller that sets this must outlive the dispatch, so that the hold
   * it releases still covers the run. Every one of them awaits it.
   */
  holdingItemLock?: boolean;
  /**
   * Carry an interrupted run on in its own thread, told `message`,
   * rather than starting or reusing one by the role's own rule.
   *
   * What "Stop agents and close" promises (`restartForcedRuns`): the
   * stopped run, continued where it was cut off — through every check a
   * dispatch makes before anything starts, because the person may have
   * run out of budget, lost a sign-in or put the project away while EO
   * was closed. If what the thread was opened with stops matching the
   * agent during those checks, the dispatch turns back having written
   * nothing, and the caller tries again with a fresh session.
   */
  continueThread?: { from: Run; threadId: string; message: string };
  /**
   * The thread this work would have carried on was refused already, and
   * this says why (EO-703).
   *
   * Set by a resume that found, at its own provider boundary, that the
   * item's files changed while it was being prepared. No thread is
   * weighed up — the caller has decided — and the sentence is posted on
   * the fresh run as a refusal is, once, so the next dispatch does not
   * explain the same change a second time.
   */
  freshBecause?: string;
}

/**
 * What a builtin or module run was asked for beyond its item, action
 * and step.
 *
 * `stillEligible` is `DispatchOptions`' own, for the same reason and
 * with the same contract — EO runs its own code at a step it has been
 * moved off no more happily than it runs an agent's (EO-175).
 */
interface BuiltinRunOptions {
  holdingItemLock?: boolean;
  stillEligible?: () => boolean;
  /**
   * A person answered a parked watch (EO-456): start its clock again and
   * record the check that follows as a run, whatever it says, so the
   * park it answered is closed by something.
   */
  resumingWatch?: boolean;
}

/**
 * A check of a step that keeps checking that came back with a result key
 * (EO-456), handed to the ordinary builtin path to be verified and
 * routed exactly as a result of a step that runs once is. `run` is its
 * row, already made; `lines` what it said while it ran.
 */
interface CheckedResult {
  run: Run;
  outcome: Extract<BuiltinOutcome, { ok: true }>;
  lines: readonly string[];
}

/**
 * Who is asking for a parked item to be picked back up.
 *
 * It decides one thing only: what happens when the reply loses the
 * item's lock (EO-132). Losing it is not the same event for the
 * scheduler as for a person. The scheduler's recovery pass has written
 * nothing and lost nothing — it offers the same item again on the next
 * tick — so it says nothing. A person pressed Post and is owed an
 * answer, and gets the refusal EO already gives for this condition.
 *
 * Defaults to `"human"` where it is omitted, deliberately: this is the
 * reply path, its callers are overwhelmingly people, and the failure
 * mode of guessing wrong in that direction is one comment too many
 * rather than a person's reply disappearing.
 */
export interface ResumeItemOptions {
  requestedBy?: "human" | "scheduler";
}

interface ForcedRestartIntent {
  cancelledRunId: string;
  itemId: Uuid;
  agentId: Uuid;
  action: string;
  transitionOnSuccess: boolean;
  /** What stopped the run, which decides what it is told when it is carried on. Absent on an intent saved before this existed: a close. */
  interruption?: RunInterruption;
}

function isManualAction(action: string): boolean {
  // An interpretation belongs here for a stronger reason than the other
  // two (EO-184): the item it runs on is parked on somebody else's
  // step, so a transition on its result would move an item on the
  // strength of a run that is not that step's.
  //
  // A module's scenario chat (EO-356) belongs here because a turn moves
  // no item, and its conversation sits on an off-board step whose
  // position fallback is the next off-board step along. A scenario turn
  // recovered after a restart and routed like a stage would leave its
  // room — the thread a module page opens would simply be gone.
  return action === RESPOND_ACTION || action === INTERPRET_ACTION || action === SCENARIO_ACTION;
}

function defaultIsOurLiveProcess(run: Run): boolean {
  if (run.pid == null || run.pid !== process.pid) return false;
  try {
    process.kill(run.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** What `untilTurnEnded` yields when the turn has been ended over the agent write bridge. */
const TURN_ENDED = Symbol("turn ended over the agent write bridge");

/** A turn `processStream` is reading, as the agent write bridge finds it (EO-543). */
interface LiveTurn {
  item: Item;
  agent: Agent;
  /** Where the turn may attach files from — the directory a path is checked against — or null where it has none. */
  attachFrom: AttachmentSource | null;
  /** Set once a blocking comment has ended the turn: no write is made for it after that. */
  ended: boolean;
  end: () => void;
}

/**
 * The stream, with one more thing it can say: that the turn has been
 * ended by a write the agent made over the bridge (EO-543).
 *
 * A blocking comment ends a run as it is posted (invariant 9), and it is
 * posted while the reader is waiting on the backend's next event — the
 * call that posted it is still open. So the reader has to be woken by
 * the post rather than by the backend: `TURN_ENDED` is yielded the moment
 * `ended` settles, whatever the backend is doing, and reading goes on
 * from the same pending event if the reader wants it (to drain an
 * interrupted turn for its accounting).
 *
 * Ending the reading here ends it below too, and waits for that to
 * settle, which is where `untilStopped` confirms the turn's process is
 * gone (EO-493): a failure to confirm that is still the failure it was.
 */
async function* untilTurnEnded(stream: AsyncIterable<AgentEvent>, ended: Promise<void>): AsyncGenerator<AgentEvent | typeof TURN_ENDED> {
  const iterator = stream[Symbol.asyncIterator]();
  let signalled: Promise<typeof TURN_ENDED> | null = ended.then(() => TURN_ENDED);
  let pending: Promise<IteratorResult<AgentEvent>> | null = null;
  try {
    for (;;) {
      pending ??= iterator.next();
      const step = signalled === null ? await pending : await Promise.race([pending, signalled]);
      if (step === TURN_ENDED) {
        signalled = null;
        yield TURN_ENDED;
        continue;
      }
      pending = null;
      if (step.done) return;
      yield step.value;
    }
  } finally {
    // An event still being waited for when the reading stopped: the
    // reader gave up on it, so what it settles to is not news — unless
    // what it settles to is the turn failing to end. Ending the reading
    // below has to wait for it either way (a generator answers `return()`
    // only between events), and is bounded the way ending a turn is.
    const pendingStep = pending;
    const ending = (async (): Promise<unknown> => {
      const late = pendingStep === null ? null : await pendingStep.then(() => null, (error: unknown) => error);
      await iterator.return?.(undefined);
      return late;
    })();
    ending.catch(() => undefined);
    const settled = await settlesWithin(ending, TURN_END_WAIT_MS);
    // eslint-disable-next-line no-unsafe-finally -- a turn that did not end outranks whatever ended the reading, as in `untilStopped`
    if (settled === false) throw notEnded(false);
    // eslint-disable-next-line no-unsafe-finally -- as above
    if (settled !== true) throw settled.failed;
    const late = await ending;
    // eslint-disable-next-line no-unsafe-finally -- as above
    if (late !== null && isTurnNotEnded(late)) throw late;
  }
}

/** How long a stopped run's backend is given to end its turn before EO stops waiting for it. */
const STOP_GRACE_MS = 15_000;

/**
 * How long a learning review that was stopped — at its time limit, or by
 * EO quitting — is read for what its backend says on the way out (its
 * spend), before it is let go without waiting further (EO-717).
 */
const REVIEW_STOP_GRACE_MS = 2_000;

/**
 * The stream, given up on once the run has been stopped and its backend
 * has not ended the turn within `STOP_GRACE_MS`.
 *
 * Every stop asks the backend to end its turn, and both normally do at
 * once. One that does not — a process wedged on a dead connection, which
 * is exactly what a sleep leaves behind — would otherwise hold the run's
 * driver, and with it the item's lock, for as long as it liked: a run
 * stopped so it could be carried on would never let go of the item it
 * is to be carried on in. Ending here ends as an abort, which is what a
 * stop is.
 */
async function* untilStopped(stream: AsyncIterable<AgentEvent>, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  const iterator = stream[Symbol.asyncIterator]();
  // Armed once, when the run is stopped: one timer and one listener for
  // the whole stream, not one per event.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let arm = (): void => undefined;
  const givingUp = Object.assign(new Error("The backend did not end its turn after it was stopped."), { name: "AbortError" });
  const gaveUp = new Promise<never>((_, reject) => {
    arm = () => {
      timer = setTimeout(() => reject(givingUp), STOP_GRACE_MS);
      timer.unref?.();
    };
  });
  // Settled only when it wins a race; otherwise nobody is listening.
  gaveUp.catch(() => undefined);
  if (signal.aborted) arm();
  else signal.addEventListener("abort", arm, { once: true });
  // Whether this stopped waiting on the backend, rather than the reader
  // stopping reading it.
  let wedged = false;
  try {
    for (;;) {
      const step = await Promise.race([iterator.next(), gaveUp]).catch((error: unknown) => {
        wedged = error === givingUp;
        throw error;
      });
      if (step.done) return;
      yield step.value;
    }
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", arm);
    const ending = Promise.resolve(iterator.return?.(undefined));
    // Waited for (EO-493). Ending a turn ends its process — SIGTERM, and
    // SIGKILL after a grace — and the provider settles this once that
    // process has exited. Every way out of reading a turn comes through
    // here: its result read, a correction about to be opened on the same
    // thread, an escalation drained, an error. So nothing after this —
    // a correction's turn, the run's ending, the next run resuming the
    // thread — happens beside a previous turn's agent that is still
    // working, and nothing that agent goes on to say can be recorded,
    // because nobody reads it again.
    //
    // And it fails closed. An ending that rejects — the backend's own
    // `TurnNotEndedError`, a process still there after SIGKILL, or any
    // other failure to let go — or that has not settled within
    // `TURN_END_WAIT_MS` is not an ended turn, and is thrown as one that
    // did not end: the run stops there, opens no correction, and its
    // thread is never resumed (`runToCompletion`). Bounded rather than
    // waited on for ever, so a backend that broke its promise cannot hold
    // the run — and with it the item's lock — open.
    //
    // A backend this gave up on — stopped, and not ending its turn within
    // `STOP_GRACE_MS` — is held to the same: the run was stopped, so its
    // signal is already ending the process, and an ending that is then
    // confirmed lets the stop stand as it is. One that is not confirmed
    // within the bound fails closed like any other, so the stopped run's
    // thread is written off rather than resumed — by a restart, or by
    // the stop's own carrying-on — beside an agent that may still be
    // running. Observed either way, so a late rejection is never left
    // unhandled.
    ending.catch(() => undefined);
    const ended = await settlesWithin(ending, TURN_END_WAIT_MS);
    // In a `finally` on purpose: it is the only place a generator can
    // answer `return()` with a failure, and an ending that failed must
    // outrank whatever ended the reading.
    // eslint-disable-next-line no-unsafe-finally -- see above
    if (ended !== true) throw notEnded(ended, wedged ? givingUp : undefined);
  }
}

/** A turn's ending that failed or never came, as the one error the run's ending recognises. */
function notEnded(how: false | { failed: unknown }, stopped?: Error): TurnNotEndedError {
  if (how === false) {
    return new TurnNotEndedError({
      provider: null,
      detail: stopped
        ? `The backend did not end its turn after the run was stopped, and did not confirm it had ended within a further ${TURN_END_WAIT_MS / 1000} seconds.`
        : `The backend did not confirm the turn EO stopped reading had ended within ${TURN_END_WAIT_MS / 1000} seconds.`,
      ...(stopped ? { cause: stopped } : {}),
    });
  }
  if (isTurnNotEnded(how.failed)) return how.failed;
  const reason = how.failed instanceof Error ? how.failed.message : String(how.failed);
  return new TurnNotEndedError({ provider: null, detail: `The backend failed to end the turn EO stopped reading: ${reason}`, cause: how.failed });
}

/**
 * How long ending a turn EO has stopped reading is waited for (EO-493).
 * Well past what either backend takes — SIGTERM, a grace, SIGKILL, a
 * grace — so it is only ever reached by a backend that did not do that.
 */
const TURN_END_WAIT_MS = 30_000;

/** `true` once `promise` resolves, its rejection if it rejects first, and `false` if `ms` passes first. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<true | false | { failed: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise.then((): true => true, (failed: unknown) => ({ failed })), late]);
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Whether a turn ended because EO stopped it — a guard, a cancel —
 * rather than because the backend failed.
 *
 * Asked of EO's own controller as well as of the error, because the two
 * backends do not end a stopped turn the same way: Codex's is an
 * `AbortError`, and the Claude SDK throws "Claude Code process aborted
 * by user" under a plain `Error`. Read off the name alone, every guard
 * that stopped a Claude run — the wall clock, the silence guard — was
 * recorded as the backend failing, with no escalation saying why.
 */
function stoppedByEo(error: unknown, controller: AbortController): boolean {
  return isAbortError(error) || controller.signal.aborted;
}

/**
 * A run parked without a provider thread behind it: the zero-work row the
 * attempt-limit guard writes when it refuses to dispatch, and any parked
 * builtin, which never talks to a provider at all. Either way the item
 * reads as `awaiting_input` and the scheduler stops re-dispatching it.
 *
 * The missing thread is what identifies it — a run that reached a real
 * agent always records one, since providers emit `thread_started` before
 * anything else. Both the attempt counter (which must not count a
 * refusal as an attempt) and resumeItem (which has no thread to resume
 * and must dispatch fresh instead) key off this.
 */
function isGuardPlaceholder(run: Run): boolean {
  return run.status === "awaiting_input" && run.threadId === null;
}

/**
 * As much of what an agent sent as belongs in a comment.
 *
 * Quoting it is the point — invariant #8 is that the agent and what it
 * sent are both named — but "what it sent" can be a refine result
 * carrying fifty stories, and a thread is not a transcript. The whole of
 * it is in `run_events` either way.
 */
function excerpt(text: string, limit = 600): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

/**
 * The session's running total as the run's row holds it (EO-504). Nothing
 * at all while the tally has read none, so a turn-by-turn backend's row
 * keeps the nulls that say it never reported one.
 */
function sessionColumns(total: ThreadUsage | null): UpdateRunInput {
  if (total === null) return {};
  return {
    sessionTokensIn: total.tokensIn,
    sessionTokensOut: total.tokensOut,
    sessionCacheReadTokens: total.cacheReadTokens,
    sessionCacheWriteTokens: total.cacheWriteTokens,
    sessionCostCents: total.costCents,
  };
}

/**
 * The note a run gets when its backend reported tokens and no money and
 * EO has no price for the model they were spent on (EO-374).
 *
 * Says the two things the person who set a budget needs: which model,
 * so the price can be added, and that the budgets will not stop this
 * run, because its cost is counted as nothing. The tokens are recorded
 * either way, and saying so keeps "uncounted" from reading as "lost".
 */
function unpricedRunNote(agentName: string, model: string | null): string {
  const named = model === null ? "a model its backend did not name" : `**${model}**`;
  return (
    `${agentName} is running on ${named}, and EO has no price for it. Its backend reports tokens but not what they cost, ` +
    "so this run's cost is not counted: the per-ticket and daily budgets cannot see it and will not stop it. " +
    "Its tokens are still recorded on the run."
  );
}

/**
 * What a run produced, as the body of one output comment (EO-298).
 *
 * Whole and unabridged. The comment is the *record* of what the run
 * produced and it is not what anybody pays for on a turn — the prompt's
 * copy is capped by the pack section that renders it and by the engine's
 * marker in the thread, both of which point back here. Truncating at
 * this end would mean the ticket no longer holds the thing it produced,
 * which is the one place it has to.
 *
 * Fenced unless the artifact is already prose. A diff opens with lines
 * beginning `+++`, `---` and `@@`, every one of which markdown renders
 * as something other than itself, and this body is read by a person on
 * the item, mirrored to Jira and inlined in the next step's prompt. The
 * fence is labelled with the kind the workspace gave it, so `diff`
 * highlights as a diff wherever it lands.
 *
 * A heading per artifact only when there is more than one, so the
 * ordinary case — git's single diff — is the artifact and nothing else.
 */
function composeOutputBody(artifacts: readonly Artifact[]): string {
  // A file is named rather than inlined (EO-299). What a folder or a
  // scratch run produces is a `.docx`, a spreadsheet, a rendered chart;
  // putting its bytes in a markdown fence would be an unreadable
  // comment *and* a corrupt file, since a comment body is text and
  // these are not. The file rides on the comment as an attachment —
  // which is what `attachments.comment_id` is for — and the body says
  // which files those are and where in the workspace they sat, because
  // an attachment carries a filename and `figures/q3.csv` is stored
  // under its leaf.
  const files = artifacts.filter((artifact) => artifact.path !== undefined);
  const texts = artifacts.filter((artifact) => artifact.path === undefined);
  const render = (artifact: Artifact): string => {
    if (artifact.body === undefined) return `\`${artifact.name}\``;
    const prose = artifact.mediaType === "text/markdown" || artifact.mediaType === "text/plain";
    if (prose) return artifact.body;
    // Longer than the longest run of backticks inside it, which is what
    // markdown requires of a fence and what a three-backtick one gets
    // wrong on the commonest diff there is: a change to a file that
    // itself contains a fenced code block. The body would end early, and
    // the rest of the diff would render as prose with half a fence in
    // the middle of it.
    // Folded rather than spread into `Math.max`: a diff of a
    // documentation file can carry more backtick runs than an argument
    // list is allowed to hold, and `Math.max(...huge)` throws a
    // RangeError rather than answering.
    let longest = 0;
    for (const run of artifact.body.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
    const fence = "`".repeat(Math.max(3, longest + 1));
    return [fence + artifact.kind, artifact.body.replace(/\n$/, ""), fence].join("\n");
  };
  // Named rather than claimed as attached: whether the copy succeeded
  // is not this function's to know, and a heading that said "attached"
  // over a file EO could not keep would be contradicted three lines
  // further down by the sentence that says so.
  const named = files.length === 0 ? [] : [`${files.length === 1 ? "The file this run produced" : "The files this run produced"}:\n\n${files.map((file) => `- ${file.name}`).join("\n")}`];
  // The ordinary case — git's single diff — is the artifact and nothing
  // else: no heading, no preamble.
  if (files.length === 0 && texts.length === 1 && texts[0]) return render(texts[0]);
  return [...named, ...texts.map((artifact) => `### ${artifact.name}\n\n${render(artifact)}`)].join("\n\n");
}

/**
 * A turn EO declined to start, carried through the stream that would
 * have been the turn (EO-386).
 *
 * Thrown by `refusedTurn` and by nothing else, and caught where every
 * stream is consumed, where it becomes a tripped guard: the run ends
 * awaiting a person, and the reason is posted on the item. An error
 * only because a stream has no other way to say "there is no turn" —
 * it never leaves the supervisor.
 */
class TurnRefused extends Error {
  override readonly name = "TurnRefused";
}

/** The stream of a turn that was never opened: no backend was called, and consuming it says why. */
function refusedTurn(reason: string): InterruptibleStream<AgentEvent> {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new TurnRefused(reason)) }),
  };
}

type StreamOutcome =
  | { kind: "escalated" }
  | { kind: "result"; data: unknown }
  /**
   * `retryable` is the backend's own word on whether trying again could
   * end differently (EO-437). It is carried rather than dropped because
   * the two answers end the run in different places: a failure worth
   * retrying is a failed run the scheduler offers again, and one that is
   * not is parked for a person after the one attempt.
   */
  | { kind: "error"; message: string; retryable: boolean }
  /**
   * The stream stopped without ever saying it was done.
   *
   * `finalText` is the last thing the agent wrote that *looked* like an
   * answer rather than prose — the raw text, unparsed, exactly as it
   * arrived. It is carried because a turn can deliver a perfectly good
   * terminal result and still end this way: the payload is in the
   * agent's own message and only the `result` event that would have
   * announced it is missing (#141).
   */
  | { kind: "ended"; finalText: string | null }
  | { kind: "paused" }
  /**
   * The backend refused because a plan window is full (EO-172).
   *
   * Its own outcome rather than a `guardTripped` with a different
   * sentence in it, because the two are opposite claims about whose
   * fault the stop was: a tripped guard is EO deciding to stop, and this
   * is EO being told it may not carry on. Only this one is exempt from
   * the correction attempts every other malformed result gets, and
   * making that exemption a distinct outcome is what keeps it from
   * quietly widening to cover a genuinely malformed result later.
   */
  | { kind: "limitReached"; quota: QuotaEvent }
  | { kind: "guardTripped"; reason: string };

/**
 * Which of the servers this turn was given the backend did not bring
 * up.
 *
 * The comparison is here rather than in the adapter because it needs
 * both halves and each side only has one: the backend knows what came
 * up, EO knows what it delivered.
 *
 * **What it is given is a snapshot, never a query.** The startup
 * report arrives some time after the process was spawned, and a person
 * can tick a box in between. Reading the catalogue at that moment
 * would report a server as missing that this turn was never given, and
 * stay silent about one it was given and that failed — both of them
 * comments about a surface no run ever had. The names come from the
 * directory as it was written for this turn.
 *
 * Names are matched leniently on purpose. A server EO hands to the SDK
 * keeps its plain catalogue name, and one the CLI discovers in a
 * plugin directory is registered as `plugin:<plugin>:<name>` — this
 * build's spelling rather than a documented one, and the arrangement
 * that would be live again if the strict flag were ever dropped. Both
 * count as the same server. Getting that wrong in the strict direction
 * would put a false "did not start" on every item, which is worse
 * than missing a real one.
 *
 * Anything that is not `connected` is reported with the backend's own
 * word for it, unmapped: `needs-auth` and `failed` are different
 * things to do something about, and a status this file has never heard
 * of is exactly the one worth showing verbatim.
 *
 * Module scope and exported so that a live check of what a backend
 * reports can apply this rule rather than a copy of it (EO-444).
 */
export function attachedServersMissing(expected: string[], reported: { name: string; status: string }[]): { name: string; detail: string }[] {
  const missing: { name: string; detail: string }[] = [];

  for (const name of expected) {
    const qualified = qualifiedServerName(name);
    const match = reported.find((entry) => entry.name === qualified || entry.name === name);
    if (!match) {
      missing.push({ name, detail: "the backend never reported it at all" });
    } else if (match.status !== "connected") {
      missing.push({ name, detail: `the backend reported it as "${match.status}"` });
    }
  }

  return missing;
}

export function createRunSupervisor(
  options: RunSupervisorOptions,
): RunSupervisor {
  const {
    db,
    provider,
    runtimeSource = () => null,
    runEnvironment,
    runEnvironmentWithheld,
    initialPaused = false,
    limits = DEFAULT_LIMITS,

    guards: guardOverrides,
    outOfMemory = (runId: Uuid) => runScopes().outOfMemory(runId),
    now = Date.now,
    watchdogIntervalMs = DEFAULT_WATCHDOG_INTERVAL_MS,
    onWake,
    isOnline = () => true,
    sleeps = true,
    tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    // Nothing installed prepares nothing: every dispatch works in the
    // process's own directory, which is where EO was before a pack
    // existed and where a test that is not about workspaces still is.
    kinds = new Map<WorkspaceKindSlug, WorkspaceKind>(),
    // Nothing, unless a pack contributed some (KAN-144). It used to
    // default to the three the developer pack now ships, which made the
    // supervisor import from what became a pack — and made "EO with no
    // pack installed" quietly still able to cut a worktree. A step
    // naming a function nobody installed parks and says so, which is
    // the same path a mistyped action already took.
    builtins = {},
    moduleRunner,
    record: providedRecord,
    dispatches = true,
    runsWhere = DEFAULT_JOB_RUNS_ON,
    deviceId: deviceIdOption = LOCAL_DEVICE_ID,
    leaseTtlMs,
    checkAuth = async () => ({ ok: true as const }),
    dispatchNotices = () => [],
    dispatchRefusal = () => null,
    isAgentAvailable = () => true,
    prepareToolDirectory = () => null,
    releaseToolDirectories = () => {},
    noDiskRoot,
    scratchRoot,
    artifactStore,
    dispatchGate,
    sectionRenderers = [],
    // Wrapped rather than passed as the bare default, so the pack's own
    // sections reach the assembly without the seam growing a parameter
    // every test that stubs it would have to ignore.
    buildContext = (db, item, agent, action, resumingRun) => buildTurnContext(db, item, agent, action, resumingRun, sectionRenderers),
    resolveNextState = () => undefined,
    onRunSucceeded = () => {},
    onPushEvents,
    debugMode = () => readDebugMode(db),
    onItemChanged = () => {},
    onRunChanged = () => {},
    pushThrottleMs = DEFAULT_PUSH_THROTTLE_MS,
    isOurLiveProcess = defaultIsOurLiveProcess,
  } = options;
  /**
   * The record this device reports to (EO-322).
   *
   * Solo mode by default: a record over the same database, in the same
   * process, with a local lease. Managed mode changes where the record
   * lives and nothing here — the supervisor talks to the interface
   * either way, which is the whole point of doing the split now rather
   * than when there is a server to justify it.
   */
  const record: ItemRecord = providedRecord ?? createLocalRecord(db, leaseTtlMs === undefined ? {} : { leaseTtlMs });

  /**
   * The claims this device is working under right now, by item.
   *
   * In memory, like the item lock and for the same reason: it is what
   * *this process* is doing, and a process that stops is exactly the
   * case the lease's expiry covers. The durable half is the row.
   */
  const heldLeases = new Map<Uuid, DispatchLease>();

  /**
   * Every run this process is driving to its end, by run, with its item —
   * set when `runToCompletion` starts and cleared once its extraction has
   * returned (EO-479).
   *
   * Extraction happens after the run's row is terminal, so the scheduler's
   * active runs no longer count it, and inside the run, so its side call
   * never asks for a slot of its own. A dispatch keeps its lease through
   * it and is counted that way; a reply to a parked run, a recovery and a
   * mention reply hold no lease, and without this nothing would be
   * counting them while extraction runs.
   */
  const drivenRuns = new Map<Uuid, Uuid>();

  /**
   * The global slots runs are still using once nothing else counts them:
   * past their terminal row, in extraction, with no lease held for their
   * item. Counted with the leases (`busy`, `capacityFor`) and with the
   * side calls' slots (the tick's `reservedSlots`), never twice — a
   * queued or running row is the scheduler's to count, and a leased item
   * the lease's.
   */
  function slotsOfFinishingRuns(): number {
    let count = 0;
    for (const [runId, itemId] of drivenRuns) {
      if (heldLeases.has(itemId)) continue;
      const status = getRun(db, runId)?.status;
      if (status === undefined || status === "queued" || status === "running") continue;
      count += 1;
    }
    return count;
  }

  /**
   * The global slots runs are using, as a standalone side call has to
   * see them (EO-508).
   *
   * Every queued or running run, leased or not — the same rows the
   * scheduler's `activeRuns` counts, so the gate and the tick agree on
   * what is busy. Counting the leases alone missed a reply to a parked
   * run, a recovery and a mention reply, none of which takes one, and a
   * consolidation started beside them: two model processes at a limit of
   * one. Then the leases with no such row yet (a dispatch between its
   * claim and its run's row), each item once, and the runs past their
   * terminal row still extracting (`slotsOfFinishingRuns`), which skips
   * leased items and live rows and so is never counted twice here.
   */
  function slotsOfRuns(): number {
    const active = listActiveRuns(db);
    const itemsWithActiveRun = new Set(active.map((run) => run.itemId));
    let leasedWithoutRun = 0;
    for (const itemId of heldLeases.keys()) {
      if (!itemsWithActiveRun.has(itemId)) leasedWithoutRun += 1;
    }
    return active.length + leasedWithoutRun + slotsOfFinishingRuns();
  }

  /**
   * The global slots side calls hold (EO-477). Counted beside every run
   * in flight (`slotsOfRuns`), and a side call that waits is given the
   * next slot a run frees before the tick is (`slots.ts`).
   */
  const sideCallSlots = createSideCallSlots({
    limit: () => (typeof limits === "function" ? limits() : limits).globalConcurrency,
    busy: slotsOfRuns,
    // A slot given back is a dispatch the tick may now make.
    onRelease: () => notifyStateChange(),
  });
  const sideCaller = createSideCaller({
    db,
    provider: options.sideCalls?.provider ?? (() => null),
    smallModel: options.sideCalls?.smallModel ?? (async () => null),
    ...(options.sideCalls?.defaultModel ? { defaultModel: options.sideCalls.defaultModel } : {}),
    ...(options.sideCalls?.signedIn ? { signedIn: options.sideCalls.signedIn } : {}),
    // A Codex sign-in in the keyring (EO-509): refused as `sign_in_unreachable` before anything is spawned.
    ...(options.sideCalls?.signInUnreachable ? { signInUnreachable: options.sideCalls.signInUnreachable } : {}),
    guards: () => {
      const guards = readGuards();
      return { perItemBudgetCents: guards.perItemBudgetCents, dailyBudgetCents: guards.dailyBudgetCents };
    },
    slots: sideCallSlots,
    now,
  });

  /**
   * Keeps each memory scope under its caps (EO-480): looks at every scope
   * on its own interval and after each delivery, and consolidates the due
   * ones one at a time through a side call that holds a global slot. Not
   * while the engine is paused or stopping; never on a dispatch's path.
   * And never while pipeline work is waiting or going (EO-577): an item
   * the tick could dispatch, or any run in flight — what the slot is for.
   */
  const memoryConsolidator = createMemoryConsolidator({
    db,
    sideCall: sideCaller.sideCall,
    caps: () => {
      const guards = readGuards();
      return { maxEntries: guards.memoryScopeMaxEntries, maxChars: guards.memoryScopeMaxChars };
    },
    now,
    canStart: () => !paused && !stopped && !shuttingDown,
    // The runs `slotsOfRuns` counts, as a standalone side call sees them,
    // and any item with nothing between it and a run but a free slot —
    // asked of the same eligibility the tick decides with, so "waiting to
    // be dispatched" here and there cannot come apart.
    pipelineBusy: () =>
      slotsOfRuns() > 0 || hasDispatchableItem(eligibilityNow()),
    // The message saying a scope is stuck (EO-727): the record's sender,
    // so on the organisation's record it reaches each admin.
    sendMessage: (input) => record.sendMessage(input),
    // A project an organisation's record holds is consolidated where the
    // record schedules work, never on a desktop holding a replica of it
    // (EO-482): two desktops folding one scope would be two writers of
    // the organisation's memory.
    heldElsewhere: (projectId) => runsWhere !== "server" && projectMovedToTheRecord(db, projectId as Uuid),
    // …and on that server, its projects' workspaces' memory is here
    // though the workspaces never are.
    workspacesElsewhere: runsWhere === "server",
    // What the Memory section's Consolidate now button and history are
    // drawn from changed (EO-589).
    onPendingChanged: (scope) => options.onMemoryConsolidationChanged?.(scope),
    ...options.memoryConsolidation,
  });

  /**
   * Which device this is, right now.
   *
   * Read per use rather than once, because signing in to an
   * organisation issues this machine a device row and signing out takes
   * it back — see `RunSupervisorOptions.deviceId`.
   */
  const deviceId = (): string => (typeof deviceIdOption === "function" ? deviceIdOption() : deviceIdOption);

  /**
   * This desktop, as a device (EO-322,
   * `ARCHITECTURE.md`, "The record").
   *
   * Every method here is something this file already did; naming them
   * as one role is what makes the second story's server possible
   * without a second engine. The preflight in particular is unmoved —
   * `isAgentAvailable`, `checkAuth` and `prepareWorkspace`, in that
   * order, before a run row exists — because it is the half that can
   * only be answered on the machine the work runs on.
   */
  const device: Device = {
    get id() {
      return deviceId();
    },

    adopt: (lease) => {
      heldLeases.set(lease.itemId, lease);
    },

    renewClaims: async () => {
      // What the record says this device still holds, rather than what
      // this device asked to keep. A renewal never *takes* a lease and
      // never revives a lapsed one (see `renewLease`), so a claim that
      // does not come back is this device's claim being gone: released
      // by the sweep while it was away and handed on, or past its
      // deadline and about to be. Forgetting it here is what lets the
      // record release the row and post the comment the expiry owes a
      // person — a device that renewed its way out of its own expiry
      // would be a machine that slept through the whole term and
      // reported nothing on waking.
      //
      // A record that could not be reached answers nothing, and this
      // device forgets every claim. That is the safe direction and it
      // is the original design's: the run in flight carries on — "finish the run you
      // hold" — and the record sweeps its side with a comment naming
      // this device, which is the honest account of a machine that went
      // quiet.
      const held = await record.renewClaims(deviceId(), [...heldLeases.keys()]);
      const standing = new Set(held.map((lease) => lease.itemId));
      for (const lease of held) heldLeases.set(lease.itemId, lease);
      for (const itemId of [...heldLeases.keys()]) {
        if (!standing.has(itemId)) heldLeases.delete(itemId);
      }
    },

    release: async (lease) => {
      // By item rather than by identity: a renewal replaces the value in
      // this map, so the lease a dispatch is holding when it ends is
      // rarely the object it was handed at the start. The row is what
      // the release is guarded on, and `releaseLease` compares the
      // device — so a late release still cannot take an item away from
      // whoever holds it now.
      heldLeases.delete(lease.itemId);
      // A run's slot is free: a side call waiting for one may take it.
      sideCallSlots.poke();
      // …and the pipeline may be idle now, which is when a consolidation
      // queued behind it starts (EO-577), rather than at the next look.
      memoryConsolidator.poke();
      await record.releaseLease(lease);
    },

    preflight: async ({ item, agent }: DispatchSubject): Promise<PreflightOutcome> => {
      // The runtime this machine has, asked before the credentials it
      // holds: an uninstalled backend has nothing to be signed in to.
      // Silent, because nothing was promised — the same silence this
      // check has always had at the top of `dispatchHeld`.
      if (!isAgentAvailable(agent)) return { kind: "stand-down" };
      const auth = await checkAuth(runsOn(agent, item));
      if (auth.ok) return { kind: "ready" };
      return { kind: "refused", reason: auth.reason ?? `The "${agent.provider}" backend is not available.` };
    },

    prepareWorkspace: (item, action, request) => prepareWorkspace(item, action, request),

    run: (dispatch, opts) =>
      dispatch.agent === null
        ? runBuiltin(dispatch.item, dispatch.action, dispatch.stepId, { stillEligible: opts.stillEligible })
        : dispatchRun(dispatch.item, dispatch.agent, dispatch.action, {
            stepId: dispatch.stepId,
            stillEligible: opts.stillEligible,
          }),

    report: ({ item, agent, action }: DispatchSubject, refusal, { initiationId, attempt }: DispatchAttempt) => {
      refuseDispatch(item, agent, action, refusal.reason, initiationId, attempt, refusal.options);
    },
  };

  /**
   * No disk at all, which is what having no workspace *is* (EO-296).
   *
   * Built here rather than taken from a pack, and it is the one kind
   * that works that way: every run has to have somewhere to be, and
   * "somewhere" cannot be a thing only an installed pack can supply. A
   * pack that contributes its own `none` replaces it, on the same terms
   * as any other slug.
   */
  const noDisk = noneWorkspaceKind(noDiskRoot);

  /**
   * The kinds the core ships, keyed the way the packs' are (EO-299).
   *
   * Three now: `none`, and the two kinds with a disk that are nobody's
   * domain — a folder somebody already has, and a directory per run.
   * None of the three is developer-specific, and an installation with
   * no pack installed still has to be able to draft a report in a
   * folder, so they cannot be a thing only an installed pack supplies.
   *
   * **A pack's kind wins.** `kindFor` looks in the installed kinds
   * first and falls back here, so a pack contributing its own `folder`
   * replaces this one whole rather than colliding with it — the same
   * terms `none` has had since EO-296, and the reason the fold's
   * collision check is between *packs* rather than against the core.
   */
  const coreKinds = new Map<WorkspaceKindSlug, WorkspaceKind>(
    [noDisk, folderWorkspaceKind({ db }), scratchWorkspaceKind({ db, ...(scratchRoot ? { root: scratchRoot } : {}) })].map((kind) => [kind.slug, kind]),
  );

  /**
   * What the installed packs decided about scheduling, as one value the
   * two input builders take (KAN-161, EO-296).
   *
   * The capacity key is the kind's, not a pack hook's: **concurrency is
   * per shared filesystem**, and only the thing that prepares a
   * filesystem knows what two runs would share. It used to be one
   * function the developer pack supplied for every item alike, reading
   * the workspace id off the item and bucketing everything with none
   * under the empty string — which was true only because every such item
   * ran in EO's own process directory. Now `none` answers null and the
   * git kind answers with the checkout, in either mode.
   *
   * `dispatchGate` is still the pack's and still conditional: it is
   * genuinely absent with no pack installed, and an explicit `undefined`
   * is not the same thing under `exactOptionalPropertyTypes`.
   */
  const scheduling: PackScheduling = {
    capacityKeyOf: (item: Item) => kindFor(item).capacityKeyOf(item),
    ...(dispatchGate ? { dispatchGate } : {}),
  };

  /**
   * This item's type, as its row has it (KAN-147).
   *
   * The container flag rides on the item itself (KAN-146) because fourteen
   * sites read it; the spec shape does not, because the three that read it
   * are all here and all have the database. A row that has gone — a type
   * deleted in another window — demands nothing, which is the same answer
   * `specShapeOf` gives a malformed one and for the same reason: the row
   * is what is wrong, and refusing every run is not a better report of it.
   */
  const shapeOf = (item: Item): SpecShape => getItemType(db, item.typeId)?.specShape ?? EMPTY_SPEC_SHAPE;

  /**
   * And the same row for what its actions mean (KAN-163).
   *
   * What a run's result is held to, and whether the answer has a
   * dependency graph in it, are the type's to say: the `refine` override
   * names the shape, and a type that overrides nothing inherits the
   * default the role shipping the action declared for its kind. Read
   * here rather than carried on the item for `shapeOf`'s reason — every
   * site that asks is in this file, and each of them has the database.
   *
   * A row that has gone answers as a leaf with nothing to say, which
   * inherits the leaf defaults: the same direction the missing flag took
   * before, and the one that asks a question rather than inventing a
   * plan.
   */
  const typeOf = (item: Item): ActionSubject => getItemType(db, item.typeId) ?? UNKNOWN_ITEM_TYPE;

  /**
   * The registry as this item's project sees it (KAN-129, KAN-147).
   *
   * Roles and builtins are the installation's, and the same everywhere.
   * Item types are rows scoped to a project, and `intake`'s shape is
   * composed from them — so an item on a project that added a type gets a
   * schema that can classify into it, and one on a project that renamed a
   * type gets the name it has. The module-level registry answers for
   * everything with no item in hand.
   */
  const registryFor = (item: Item): Registry => registryForProject(db, item.projectId);

  /**
   * The role whose own definition of an action this run is held to
   * (EO-421), or null where none can be.
   *
   * The dispatched agent's, for real work. **Null for a preview**: it
   * runs on the placeholder backend (`runsOn`), whose canned answer is
   * not in any shape a person defined, so holding it to a role's
   * definition would end every rehearsal of such a step in a validation
   * guard. A preview is answered by the by-action lookup it always was,
   * and routes on the step's first declared result
   * (`previewAwareResultKey`).
   *
   * One function, so the schema sent, the validation applied, the route
   * taken and the summary posted cannot come to different conclusions
   * about whether the definition was in force.
   */
  const definingRole = (item: Item, agent: Agent): string | null => (item.previewAt === null ? agent.role : null);

  /**
   * The workspace kind this item's work happens in (EO-295).
   *
   * The item's workspace row names the slug — or, for an item that names
   * none, the first workspace its project spans — and the installed
   * packs say what that slug *is*. Two answers used to fall to null and
   * they were different things said the same way: an item with no
   * workspace of its own, and a workspace naming a kind nothing
   * installed. Both now land on `none`, which is a kind with an empty
   * directory rather than the absence of one.
   *
   * **Nothing falls to the process working directory.** That was the old
   * answer, and it was EO's own launch directory — for a packaged app,
   * not a checkout of anything and frequently not a git repository at
   * all, so a provider that checks it is inside a trusted repository
   * refused before the agent started (EO-296).
   */
  function kindFor(item: Item): WorkspaceKind {
    // A preview works nowhere (EO-313, ARCHITECTURE.md, "Preview").
    //
    // The same sentence as the module gate, applied to the other kind of
    // step: preparing this item's real workspace would cut a branch in
    // somebody's repository for a rehearsal, which is the "nothing was
    // sent" promise broken on disk rather than in a channel. `none` is
    // an empty directory of EO's own making — the kind that exists
    // precisely for an agent whose work is not a checkout.
    //
    // It also settles what is verified, and settles it correctly rather
    // than conveniently. `none` vouches for nothing, so a preview's
    // canned `implement` claim is never checked for commits that a
    // rehearsal did not make. Invariant #5 says verify what an agent
    // claims where EO can — and here EO knows there is no claim: the
    // backend is fake, the directory is empty, and a check would be
    // asking git about work nobody did.
    if (item.previewAt !== null) return noDisk;
    const slug = resolveItemWorkspace(db, item).kind;
    return kinds.get(slug) ?? coreKinds.get(slug) ?? noDisk;
  }

  /** Where this run is to happen, from the item's kind. */
  async function prepareWorkspace(item: Item, action: string, request?: { signal?: AbortSignal; onProgress?: (text: string) => void }): Promise<PrepareWorkspaceOutcome> {
    return kindFor(item).prepare(item, action, request);
  }

  /**
   * What the item's workspace lends this agent, for one turn.
   *
   * Called on each of the three paths that reach a provider. The two
   * resume paths have a directory on the run row rather than a freshly
   * prepared workspace, so they rebuild one from it: the run worked
   * there, and the kind is the item's, which is what decides both what
   * is lent and — on the handover — what is brought up to date
   * afterwards.
   */
  async function attachWorkspace(item: Item, agent: Agent, workspace: PreparedWorkspace | null): Promise<WorkspaceAttachment> {
    if (workspace === null) return NOTHING_ATTACHED;
    return kindFor(item).attach(item, agent, workspace);
  }

  /** The workspace a run recorded, as the value the kind's methods take. Null when EO recorded no directory for it. */
  function workspaceOfRun(item: Item, run: { cwd?: string | null }): PreparedWorkspace | null {
    if (!run.cwd) return null;
    return { cwd: run.cwd, kind: kindFor(item).slug, workspaceId: item.workspaceId };
  }

  /**
   * Where a run may attach files from, as a turn is told it — or
   * nothing, for a run that has nowhere (EO-412).
   *
   * Asked on every path that opens a turn and again where an accepted
   * call is acted on, so what the `eo` server was told and what the
   * supervisor re-checks against are one answer rather than two.
   *
   * Three runs have nothing to attach from. One that recorded no
   * directory never reached a workspace. One on `none` has a directory —
   * `runs.cwd` is the empty one EO made for it — and that is exactly
   * why the kind is asked rather than the column: nothing the run
   * produced is in there. And a conversation is not work on an item at
   * all; whatever directory its turn happens to open in, a chat that
   * could put files on its own thread is the system agent attaching
   * from a chat, which this story leaves out.
   *
   * Nothing, too, on an installation with nowhere to keep a file. The
   * tool would be offered, accept a call and then be unable to honour
   * any of it, which is an absence left for an agent to discover.
   */
  function attachSourceOf(item: Item, run: { id: Uuid; cwd?: string | null }): AttachmentSource | null {
    if (!artifactStore || !run.cwd) return null;
    if (item.stepId !== null && Object.hasOwn(CONVERSATION_SETTINGS_KEY, item.stepId)) return null;
    if (kindFor(item).slug === NONE_KIND) return null;
    return { runId: run.id, directory: run.cwd };
  }

  /** The same answer, as the option a turn carries: absent rather than null, because an adapter reads absence. */
  function attachOption(item: Item, run: { id: Uuid; cwd?: string | null }): { attachFrom?: AttachmentSource } {
    const source = attachSourceOf(item, run);
    return source ? { attachFrom: source } : {};
  }

  /**
   * The memory scopes a turn on this item draws from (EO-478): the
   * item's project, and the workspace its step works in — unless the
   * step has none, which a conversation and the `none` kind do not, and
   * a preview works nowhere. Empty for an item with no project, and on a
   * read that fails: memory is never why a dispatch does not happen.
   */
  function turnMemoryScopes(item: Item): MemoryScopeInfo[] {
    try {
      const conversation = item.stepId !== null && Object.hasOwn(CONVERSATION_SETTINGS_KEY, item.stepId);
      return memoryScopesFor(db, item, { worksInWorkspace: !conversation && kindFor(item).slug !== NONE_KIND });
    } catch (error) {
      console.warn(`[eo] the memory scopes of ${item.key} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * The memory option a turn carries, so the `eo` server lists
   * `memory_read` for these scopes (EO-478). Absent where the item has
   * none. Carried on every turn of a thread that was given memory — a
   * resume, a correction, a recovery — and not only on the turn that
   * delivered it, so the tool does not vanish between two turns of one
   * conversation.
   */
  function memoryOption(item: Item): { memoryScopes?: MemoryReadScope[] } {
    const scopes = turnMemoryScopes(item);
    return scopes.length > 0 ? { memoryScopes: memoryReadScopes(scopes) } : {};
  }

  /**
   * The memory-writing block for a turn of this agent on these scopes
   * (EO-593): there exactly when the turn is served `memory_note` — the
   * agent holds the grant and the turn has a scope to write to, the `eo`
   * server's own rule for listing the tool — and null otherwise. Asked of
   * the grant, never of the role.
   *
   * The one predicate every send asks: a dispatch, a reply, a
   * continuation, a corrective turn and a recovery. Not only the turns
   * that choose memory, because a thread being carried on cannot be
   * assumed to hold the block already — one opened before it existed, by
   * an agent 0148 has since granted the tool, holds none.
   */
  function memoryWritingFor(agent: Agent, scopes: readonly MemoryScopeInfo[]): string | null {
    return memoryNoteEnabled(agent) ? renderMemoryWritingSection(scopes) : null;
  }

  /** What a turn sends, with the memory-writing block after it where the turn is served `memory_note`. */
  function withMemoryWriting(text: string, agent: Agent, scopes: readonly MemoryScopeInfo[]): string {
    const writing = memoryWritingFor(agent, scopes);
    return writing === null ? text : `${text}\n\n${writing}`;
  }

  /**
   * Where a turn on this item hands what its agent writes (EO-543): the
   * bridge's address and this item's credential. Carried on every turn —
   * a start, a resume, a correction, a recovery, a warmed backend —
   * because every one of them starts an `eo` server whose write tools
   * need it. Absent while no bridge is listening.
   */
  function writeBridgeOption(item: Item): { writeBridge?: AgentWriteBridgeAddress } {
    const bridge = options.agentWriteBridge?.() ?? null;
    return bridge === null ? {} : { writeBridge: bridge.tokenFor(item.id) };
  }

  /**
   * The turns being read right now, by run: what an agent's write over
   * the bridge is made as (EO-543). Set by `processStream` for exactly
   * the span it reads one turn, so a write arriving from a turn nobody is
   * reading — one already given up on, or a process that outlived its
   * run — finds nothing to be made as, and is refused.
   *
   * `ended` is a blocking comment having been posted: the run's fate is
   * decided from then on (invariant 9), so a parting write cannot add to
   * it — the same rule the drain after an escalation keeps for anything
   * else the agent says on its way out.
   */
  const liveTurns = new Map<Uuid, LiveTurn>();

  /**
   * A write an agent asked for, handed over the bridge for an item
   * (EO-543): made as the turn this process is reading on that item,
   * held to that turn's rules as they are now (invariant 5), and
   * answered with what happened — which is what the tool answers the
   * agent, so "written" is only ever said of something that was.
   */
  async function handleAgentWrite(itemId: string, request: AgentWriteRequest, writes: readonly AgentWriteTool[] | null = null): Promise<AgentWriteAnswer> {
    // A credential minted for some writes alone is a learning review's
    // (EO-717), and is made as that review, never as a run's turn.
    if (writes !== null) return reviewWrite(itemId, request, writes);
    const found = [...liveTurns].find(([, turn]) => turn.item.id === itemId);
    if (found === undefined) return { ok: false, code: "NO_RUN", problem: "No run of this desktop's is working on this item now, so nothing was written." };
    const [runId, turn] = found;
    if (turn.ended) return { ok: false, code: "RUN_ENDED", problem: "Your run has already ended on the comment you posted, so nothing more was written. Stop working now." };
    const item = getItem(db, itemId as Uuid);
    if (!item) return { ok: false, code: "NO_RUN", problem: "EO no longer has the item this run is on, so nothing was written." };
    try {
      // The run's lines so far, written down before what it writes: on a
      // run with no lease they are how the record knows this device ran
      // it, and they are sent ahead of the write (EO-482).
      activeEventBuffers.get(runId)?.flush();
      switch (request.tool) {
        case COMMENT_TOOL_NAME: {
          const outcome = writeAgentComment(db, { itemId: item.id, runId, agentId: turn.agent.id }, request.args);
          // A blocking comment ends the turn as it is posted (invariant
          // 9): the reader of this turn is woken here, not by anything
          // the backend goes on to say about the call.
          if (outcome.ends) turn.end();
          return outcome.answer;
        }
        case ATTACHMENT_ADD_TOOL_NAME:
          return await attachRunFiles({
            db,
            store: artifactStore,
            itemId: item.id,
            runId,
            agent: turn.agent,
            directory: turn.attachFrom?.directory ?? null,
            args: request.args,
          });
        case MEMORY_NOTE_TOOL_NAME:
          return await noteMemory(item, runId, request.args);
        case REPOSITORY_CHECKOUT_TOOL_NAME:
          return await checkoutForAgent(item, request.args);
        case SKILL_READ_TOOL_NAME:
          return readSkillForAgent(runId, request.args);
        // The learning review's alone (EO-718), and a run's turn is never
        // one. The `eo` server lists them on a run's turn all the same
        // (EO-732), so that its review is sent the same tools, and refuses
        // them there: a call that reaches here anyway is refused too, and
        // nothing is read or written.
        case SKILL_VIEW_TOOL_NAME:
        case SKILL_CREATE_TOOL_NAME:
        case SKILL_PATCH_TOOL_NAME:
        case SKILL_FILE_WRITE_TOOL_NAME:
        case SKILL_FILE_REMOVE_TOOL_NAME:
          return { ok: false, code: "TOOL_NOT_SERVED", problem: skillToolNotServed(request.tool) };
      }
    } catch (error) {
      return { ok: false, code: "WRITE_FAILED", problem: `EO could not write it, so nothing was written: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * A `skill_read` call (EO-721): the instructions of a skill this run
   * was given, by slug, and where its supporting files are — or a refusal
   * naming the skills it was given, for one it was not.
   *
   * Which skills those are is the run's `skills_delivered` (`runSkills`),
   * the same record a load is held to; the load itself is read off the
   * call by the adapter and recorded by `recordSkillUsage`, as Claude's
   * `Skill` call is. A refusal records nothing.
   */
  function readSkillForAgent(runId: Uuid, args: unknown): AgentWriteAnswer {
    const parsed = SkillReadArgsSchema.safeParse(args);
    if (!parsed.success) return { ok: false, code: "INVALID_ARGUMENT", problem: "skill_read takes `slug`, a skill's name as your prompt lists it, and nothing else." };
    const given = runSkills.get(runId);
    const slugs = given === undefined ? [] : [...given.bySlug.keys()].sort();
    const skillId = given?.bySlug.get(parsed.data.slug);
    const skill = skillId === undefined ? undefined : getSkill(db, skillId);
    if (skill === undefined) {
      const which = slugs.length === 0 ? "EO gave this run no skills" : `The skills EO gave this run are ${slugs.map((slug) => `\`${slug}\``).join(", ")}`;
      return { ok: false, code: "SKILL_NOT_GIVEN", problem: `EO did not give this run a skill called \`${parsed.data.slug}\`, so nothing was loaded. ${which}.` };
    }
    const answer = skillReadAnswer(skill);
    return { ok: true, text: answer.text, data: answer.data };
  }

  /**
   * The learning reviews under way, by the run each reviews (EO-717):
   * the item, the entries the review's `memory_note` calls wrote, in
   * order, for its `learning_review` event, and what its skill tools
   * have read and written (EO-718).
   */
  const reviewTurns = new Map<Uuid, { itemId: Uuid; entryIds: string[]; skills: ReviewSkillState }>();

  /**
   * A write a learning review asked for (EO-717): `memory_note`, made as
   * the reviewed run — the note's source — and marked as extracted, as
   * the notes the review replaces were; and the skill tools (EO-718),
   * answered for this review in `memory/reviewSkills.ts`, each write
   * authored by the reviewed run. Anything else is refused, whatever the
   * credential says, so a review cannot post, attach or check anything
   * out.
   */
  async function reviewWrite(itemId: string, request: AgentWriteRequest, writes: readonly AgentWriteTool[]): Promise<AgentWriteAnswer> {
    const tool = request.tool;
    const skillTool = (SKILL_WRITE_TOOLS as readonly string[]).includes(tool);
    if ((tool !== MEMORY_NOTE_TOOL_NAME && !skillTool) || !writes.includes(tool)) {
      return { ok: false, code: "TOOL_NOT_SERVED", problem: `This turn is not served ${tool}, so nothing was written.` };
    }
    const found = [...reviewTurns].find(([, review]) => review.itemId === itemId);
    if (found === undefined) return { ok: false, code: "NO_RUN", problem: "No learning review of this desktop's is under way on this item now, so nothing was written." };
    const [runId, review] = found;
    const item = getItem(db, itemId as Uuid);
    if (!item) return { ok: false, code: "NO_RUN", problem: "EO no longer has the item this run is on, so nothing was written." };
    try {
      if (skillTool) return answerReviewSkillTool(db, review.skills, tool as SkillWriteTool, request.args, now());
      const answer = await noteMemory(item, runId, request.args, true);
      const entryId = answer.ok ? answer.data["entryId"] : undefined;
      if (typeof entryId === "string") review.entryIds.push(entryId);
      return answer;
    } catch (error) {
      return { ok: false, code: "WRITE_FAILED", problem: `EO could not write it, so nothing was written: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * A `repository_checkout` call (EO-633): a reference checkout for the
   * item, made by the kind that lends one (EO-632) — the item's own kind
   * if it can, or else any installed kind that can, since an item whose
   * own workspace is not a checkout may still read one. The answer names
   * the path, the commit and where the commit came from; a refusal is
   * the kind's own sentence, which the tool hands the agent as its error.
   */
  async function checkoutForAgent(item: Item, args: unknown): Promise<AgentWriteAnswer> {
    const parsed = RepositoryCheckoutArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, code: "INVALID_ARGUMENT", problem: "repository_checkout takes `repository`, a repository's name as your prompt lists it, and `branch`, and nothing else." };
    }
    const own = kindFor(item);
    const lender = own.referenceCheckout ? own : [...kinds.values(), ...coreKinds.values()].find((kind) => kind.referenceCheckout !== undefined);
    if (!lender?.referenceCheckout) return { ok: false, code: "REPOSITORY_CHECKOUT_REFUSED", problem: "Nothing installed in EO can check out a repository, so nothing was checked out." };
    const outcome = await lender.referenceCheckout(item, { repository: parsed.data.repository, branch: parsed.data.branch });
    if (!outcome.ok) return { ok: false, code: "REPOSITORY_CHECKOUT_REFUSED", problem: outcome.reason };
    const { path, commit, source, repository, branch } = outcome.checkout;
    const from =
      source === "remote"
        ? `the commit \`${branch}\` points to on ${repository}'s remote, fetched just now`
        : `the commit of ${repository}'s local branch \`${branch}\`, because its remote has no branch of that name`;
    return {
      ok: true,
      text: `EO checked out \`${branch}\` of ${repository} at ${path}, detached at ${commit}: ${from}. It is for reading; EO removes it when this ticket is finished.`,
      data: { path, commit, source, repository, branch },
    };
  }

  /**
   * A `memory_note` call (EO-479, EO-543): the rules applied against the
   * scopes the item has now, and the entry written with the run as its
   * source — through the organisation's record where the record holds
   * the project (EO-482), so "noted" is said there only of a note the
   * record took. The answer names the active entries closest to it
   * (EO-611), read here after the write: a record's answer has already
   * been copied into this database, and what the note replaced is gone.
   */
  async function noteMemory(item: Item, runId: Uuid, args: unknown, extracted = false): Promise<AgentWriteAnswer> {
    const scopes = turnMemoryScopes(item);
    const onRecord = memoryOnRecord(item);
    const written = await writeMemoryNote({ record, args, scopes, runId, item, ...(extracted ? { extracted: true } : {}), now: now() });
    if (!written.ok) return { ok: false, code: "MEMORY_NOTE_REFUSED", problem: onRecord ? `The note was not saved. ${written.problem}` : written.problem };
    const scope = scopes.find((candidate) => candidate.scope.kind === written.entry.scope.kind && candidate.scope.id === written.entry.scope.id);
    const title = `${written.entry.scope.kind === "project" ? "Project" : "Workspace"}: ${scope?.name ?? written.entry.scope.id} (scope ${written.entry.scope.id})`;
    const closest = closestEntries(
      written.entry.body,
      activeMemoriesIn(db, [written.entry.scope]).filter((entry) => entry.id !== written.entry.id),
    );
    return {
      ok: true,
      text: `EO noted this in the memory of ${title}${onRecord ? ", which your organisation's record keeps" : ""}. Later runs on other items are given it from now on. ${closestEntriesAnswer(written.entry.id, closest)}`,
      data: { entryId: written.entry.id, scope: { kind: written.entry.scope.kind, id: written.entry.scope.id } },
    };
  }

  /**
   * Whether an item's memory is an organisation's record's to write, from
   * here (EO-482): a project somebody moved there, on a desktop. On the
   * organisation's server this process *is* that record.
   */
  function memoryOnRecord(item: Item): boolean {
    return runsWhere !== "server" && item.projectId !== null && projectMovedToTheRecord(db, item.projectId as Uuid);
  }

  /**
   * An answer's `memoryUsed`, held to what the run was given, with what
   * it kept and dropped recorded on the run's log as `memory_used`
   * (EO-597, `memory/memoryUse.ts`). Written after the run's buffer is
   * disposed, so straight to the record. Never throws: a log that could
   * not be read or written leaves the answer as it was and says why.
   */
  function memoryUseHeldToDelivery(runId: Uuid, itemId: Uuid, threadId: string | null, answer: unknown): unknown {
    try {
      const held = heldToDelivered(answer, memoryDeliveredToRun(db, runId, itemId, threadId));
      if (held.event !== null) record.appendRunEvent(runId, MEMORY_USED_EVENT, held.event);
      return held.answer;
    } catch (error) {
      console.warn(`[eo] which memory run ${runId} used could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
      return answer;
    }
  }

  /**
   * Chooses this turn's memory and records what was chosen on the run
   * (EO-478). Synchronous when nothing has to be asked — no candidates,
   * or few enough to give them all — and a promise only when a selection
   * side call is made. Never throws: whatever goes wrong, the turn is
   * dispatched without a memory section and the reason is logged.
   *
   * And how to write memory (EO-593): the block EO appends for an agent
   * served `memory_note` — granted it, on a turn with a scope to write
   * to, which is the `eo` server's own rule for listing the tool — after
   * the memory section, or alone where no scope holds an entry or the
   * delivery failed. Asked of the grant, never of the role.
   */
  function memoryForTurn(
    run: Run,
    item: Item,
    agent: Agent,
    action: string,
    scopes: readonly MemoryScopeInfo[],
  ): { section: string | null } | Promise<{ section: string | null }> {
    const nothing = { section: null };
    if (scopes.length === 0) return nothing;
    const writing = memoryWritingFor(agent, scopes);
    const withWriting = (section: string | null): { section: string | null } => ({
      section: section === null ? writing : writing === null ? section : `${section}\n\n${writing}`,
    });
    const noted = (memory: DeliveredMemory): { section: string | null } => {
      if (memory.event.candidateCount > 0) {
        try {
          // The ids delivered and whether selection ran, on the run's
          // own log — the record of what this agent was told.
          record.appendRunEvent(run.id, MEMORY_DELIVERED_EVENT, memory.event);
          // One more run given these scopes' memory: the scheduled
          // consolidation counts those (EO-480).
          memoryConsolidator.poke();
        } catch (error) {
          console.warn(`[eo] what run ${run.id} was given from memory could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return withWriting(memory.section);
    };
    const failed = (error: unknown) => {
      console.warn(`[eo] memory was not delivered to run ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
      return withWriting(null);
    };
    try {
      const pending = deliverMemory({
        db,
        item,
        agent,
        action,
        runId: run.id,
        backend: runsOn(agent, item).provider,
        scopes,
        conversation: item.stepId !== null && Object.hasOwn(CONVERSATION_SETTINGS_KEY, item.stepId),
        thresholdChars: readGuards().memoryDeliveryChars,
        sideCall: sideCaller.sideCall,
        now: now(),
      });
      return pending instanceof Promise ? pending.then(noted, failed) : noted(pending);
    } catch (error) {
      return failed(error);
    }
  }

  /**
   * Extraction after a run (EO-479): one `memory_extract` side call when
   * a run has ended — succeeded, failed or awaiting input — inside it,
   * so it uses the run's slot, which is held until this returns. Called
   * once the run's row is terminal and its item has moved, so it cannot
   * delay or change the transition. Never throws; a failure writes
   * nothing, is logged, and is not asked again. Skipped while EO shuts
   * down, since the side call would only be aborted.
   */
  async function extractAfterRun(runId: Uuid, item: Item, agent: Agent): Promise<void> {
    if (shuttingDown) return;
    try {
      const run = getRun(db, runId);
      if (!run) return;
      const outcome = await extractMemory({
        db,
        run,
        item: getItem(db, item.id) ?? item,
        agent,
        backend: runsOn(agent, item).provider,
        scopes: turnMemoryScopes(item),
        sideCall: sideCaller.sideCall,
        // The record that holds the item's project (EO-482).
        record,
        now,
      });
      if (outcome.kind === "failed") console.warn(`[eo] memory was not extracted from run ${runId}: ${outcome.reason}: ${outcome.message}`);
      // How it ended, on the run's own log (EO-511): an answer of no
      // notes is told apart from notes written and from a failed call
      // once this has returned. Nothing for a run that was not asked about.
      const event = extractionEvent(outcome);
      if (event !== null) {
        try {
          record.appendRunEvent(runId, MEMORY_EXTRACTED_EVENT, event);
        } catch (error) {
          console.warn(`[eo] how memory extraction ended for run ${runId} could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      console.warn(`[eo] memory was not extracted from run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The learning reviews in flight, so quitting EO stops them (EO-717). */
  const reviewControllers = new Set<AbortController>();

  /**
   * The learning review after a run (EO-717): where extraction ran, EO
   * forks the run's thread and sends one review turn on the fork, served
   * `memory_read` and `memory_note` and no other write. Inside the run,
   * so it holds the run's slot until it returns, and after the item has
   * moved, so it cannot change where the item went. Bounded by
   * `LEARNING_REVIEW_TIMEOUT_MS`, past which it is stopped and recorded
   * as failed.
   *
   * Where the thread cannot be forked — none, one on another backend, a
   * backend that cannot fork, or the fork refused — `memory_extract`
   * runs instead, exactly as before, and the event says it fell back and
   * why. Every review that was asked for appends one `learning_review`
   * event; a run it skips (as extraction skips it) appends none. Never
   * throws.
   *
   * A run that called `memory_note` itself gets the skill half alone
   * (EO-731): no `memory_note` on its fork, and, where its thread cannot
   * be forked, nothing in its place — extraction writes memory alone,
   * and the run wrote its own.
   */
  async function reviewAfterRun(runId: Uuid, item: Item, agent: Agent, action: string, runTurns: RunTurns | undefined): Promise<void> {
    if (shuttingDown) return;
    let outcome: LearningReviewOutcome;
    let review: LearningReviewKind = "full";
    try {
      const run = getRun(db, runId);
      if (!run) return;
      const current = getItem(db, item.id) ?? item;
      const scopes = turnMemoryScopes(item);
      const asked = learningReviewFor(run, current, runProduce(db, run), scopes);
      if ("skip" in asked) return;
      review = asked.review;
      outcome = await reviewOnFork(run, current, agent, scopes, review, { item, action, toolDirectory: runTurns?.toolDirectory, attachment: runTurns?.attachment });
    } catch (error) {
      outcome = { kind: "failed", entryIds: [], skillIds: [], reason: `The learning review could not be run: ${error instanceof Error ? error.message : String(error)}`, forkThreadId: null };
    }
    if (outcome.kind === "fell_back" && review === "full") {
      console.warn(`[eo] the learning review of run ${runId} fell back to memory extraction: ${outcome.reason}`);
      await extractAfterRun(runId, item, agent);
    } else if (outcome.kind === "fell_back") {
      console.warn(`[eo] the skill review of run ${runId} could not be run, and nothing ran in its place: ${outcome.reason}`);
    } else if (outcome.kind === "failed") {
      console.warn(`[eo] the learning review of run ${runId} failed: ${outcome.reason}`);
    }
    try {
      record.appendRunEvent(runId, LEARNING_REVIEW_EVENT, learningReviewEvent(outcome, review));
    } catch (error) {
      console.warn(`[eo] how the learning review of run ${runId} ended could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * EO's pass over the agent skills nobody loads (EO-720), after a run on
   * a project: those within the project's reach given `skillArchiveAfterRuns`
   * runs in a row without a load are archived, and nothing is posted (EO-728).
   * The guardrails are read now, so a change to them takes effect here.
   *
   * For a project the organisation's record holds, a desktop archives
   * only its own global skills: the project's are the record's, which
   * runs its pass when this run's settled transcript reaches it
   * (`serveApply`) — an archive in this replica would be undone by the
   * record's next copy. What the pass could not do it says in a message,
   * or leaves for the next pass (`archival.ts`).
   */
  async function archiveAfterRun(item: Item): Promise<void> {
    if (shuttingDown) return;
    settleOwnSkillUsage();
    const projectId = (getItem(db, item.id) ?? item).projectId;
    if (projectId === null) return;

    try {
      const guards = readGuards();
      await archiveUnusedSkills({
        db,
        projectId,
        reach: archiveReachOf(db, projectId, runsWhere === "server"),
        ageing: { staleAfterRuns: guards.skillStaleAfterRuns, archiveAfterRuns: guards.skillArchiveAfterRuns },
        sendMessage: (message) => record.sendMessage(message),
        now,
      });
    } catch (error) {
      console.warn(`[eo] the pass archiving unused agent skills failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * What a learning review's fork is opened with, of the run's own
   * options (EO-732): what `driveToCompletion` resumes a corrective turn
   * with — the directory, the answer schema, the tool directory, the
   * repository server, the run and where it attaches from, the memory
   * scopes, and the model, effort and budget — less the credential and
   * the signal, which are the review's own. The item is the run's as its
   * turns saw it, before it moved: a conversation's settings and the
   * answer schema are read off where it was.
   */
  function reviewForkOptions(run: Run, runTurn: { item: Item; action: string; toolDirectory: string | undefined; attachment: WorkspaceAttachment | undefined }, agent: Agent): AgentProviderResumeOptions {
    const { item } = runTurn;
    const actionSchema = outputSchemaFor(registryFor(item), runTurn.action, typeOf(item), definingRole(item, agent));
    return {
      ...(run.cwd ? { cwd: run.cwd } : {}),
      ...(actionSchema ? { outputSchema: actionSchema } : {}),
      ...(runTurn.toolDirectory ? { toolDirectory: runTurn.toolDirectory } : {}),
      ...(runTurn.attachment?.mcpServers[0] ? { repositoryMcp: runTurn.attachment.mcpServers[0] } : {}),
      ...attachOption(item, run),
      ...memoryOption(item),
      ...discussionTurnOptions(item, agent),
    };
  }

  /**
   * The review turn on a fork of the run's thread, read to its end or its
   * time limit. A fork that cannot be opened is `fell_back`. A
   * `skills_only` review (EO-731) is sent the skill part alone and handed
   * a credential naming the skill tools and not `memory_note`, which is
   * listed to it as to the run and refused when called.
   *
   * Opened with the run's own options (EO-732): the servers, the tool
   * directory, the skills, the answer schema, the model and its effort —
   * what `driveToCompletion` resumes a corrective turn with — so the
   * fork's prompt starts exactly as the run's last request did and the
   * backend reads the thread out of its prompt cache, rather than writing
   * all of it again because one tool was missing. Two things differ, and
   * neither changes the prompt: the credential, which names the writes
   * the review is served, and `refuseCallsExcept`, under which the adapter
   * refuses every other call as it is made. `runTurn` is the run as its
   * turns saw it: the item before it moved, the action and what the run
   * was lent.
   */
  async function reviewOnFork(run: Run, item: Item, agent: Agent, scopes: readonly MemoryScopeInfo[], kind: LearningReviewKind, runTurn: { item: Item; action: string; toolDirectory: string | undefined; attachment: WorkspaceAttachment | undefined }): Promise<LearningReviewOutcome> {
    const backend = runsOn(agent, item).provider;
    if (run.threadId === null) return { kind: "fell_back", reason: "The run has no thread to fork." };
    if (run.provider !== null && run.provider !== backend) {
      return { kind: "fell_back", reason: `The run's thread is on ${run.provider}, and ${agent.name} now runs on ${backend}.` };
    }
    // In a scope of the run's, as the run's turns were (EO-738): the
    // fork's CLI is a process EO starts for the run, and the scope is
    // one more of the run's options the fork keeps (EO-732).
    const inner = scopedProvider(providerFor(agent, item), processScopeOf(run.id));
    if (!inner.fork) return { kind: "fell_back", reason: `The ${backend} backend cannot fork a thread.` };
    const bridge = options.agentWriteBridge?.() ?? null;
    if (bridge === null) return { kind: "fell_back", reason: "EO has nowhere listening for the review's notes." };
    // Recorded while debug mode is on, and only for a run whose own
    // opening send was, for the reason a correction is (EO-734): a
    // review alone would read as the whole of what the run was sent.
    // Wrapped as every send is, above both adapters (invariant 12).
    const recording = debugMode() && capturedRuns.has(run.id);
    const provider = recording
      ? capturingProvider(
          inner,
          {
            backend,
            purpose: "learning_review",
            refusal: null,
            threadInstructions: threadInstructionsOf(run.id, agent),
            // The run's answer schema, which the fork is sent as the run
            // was so that its prompt starts as the run's did (EO-732).
            outputSchemaName: actionSchemaName(registryFor(runTurn.item), runTurn.action, typeOf(runTurn.item), definingRole(runTurn.item, agent)),
          },
          (sent) => recordSent(run.id, sent),
        )
      : inner;

    const startedAt = now();
    const controller = new AbortController();
    reviewControllers.add(controller);
    const skillScope = skillRunScope(db, item);
    const review = { itemId: item.id, entryIds: [] as string[], skills: reviewSkillState({ runId: run.id, agentId: agent.id, scope: skillScope }) };
    reviewTurns.set(run.id, review);
    const loaded = new Set(skillsLoadedByRun(db, run.id));
    const skills = reviewableSkills(db, review.skills).map((skill) => ({ slug: skill.slug, description: skill.description, loaded: loaded.has(skill.id), locked: skill.locked }));
    const offered = { skills, canCreate: skillScope.projectId !== null };
    /** The writes this review is served: the skill tools, and `memory_note` unless the run wrote its own notes (EO-731). */
    const served: AgentWriteTool[] = kind === "full" ? [MEMORY_NOTE_TOOL_NAME, ...SKILL_WRITE_TOOLS] : [...SKILL_WRITE_TOOLS];
    // The fork's running total starts where the run left the thread, on
    // either backend, and the row is its own spend (EO-733) — taken off by
    // the rule a resumed run's is, wherever that rule lives. A Claude
    // session reading is the tally's to take it off, as for a resumed run
    // (`driveToCompletion`). A Codex reading is a turn's, which the tally
    // adds and never takes anything off: its client reports a turn's
    // share of the thread's total already (`TurnTranslator.turnUsage`),
    // for a fork as for a resume, so `earlierOnThread` is not read for it.
    const usage = createUsageTally({ earlierOnThread: sessionTotalBefore(usageHistoryOnThread(db, run.threadId, uuidv7() as Uuid)) });
    let model: string | null = null;
    /** Whether the backend said anything about spend: a fork that reported none leaves no row claiming it cost nothing. */
    let reported = false;
    let forkThreadId: string | null = null;
    /** How the backend copied the thread, where it said (EO-732): Codex's prediction-mode fork, or the plain one and why. */
    let forkCopy: ForkCopy | undefined;
    let failure: string | null = null;
    let timedOut = false;
    let interrupt: (() => Promise<void>) | undefined;
    let stop: () => void = () => {};
    const stopped = new Promise<"stopped">((resolve) => {
      stop = () => resolve("stopped");
    });
    // Stopped however it is stopped — its time limit or EO quitting — what
    // the backend says on its way out is read for a moment more, for its
    // spend, and never waited on past that.
    controller.signal.addEventListener("abort", () => {
      void interrupt?.().catch(() => {});
      setTimeout(stop, REVIEW_STOP_GRACE_MS);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, LEARNING_REVIEW_TIMEOUT_MS);
    try {
      const forked = await Promise.race([
        provider.fork!(run.threadId, kind === "full" ? learningReviewPrompt(scopes, offered) : learningReviewSkillsPrompt(offered), {
          ...reviewForkOptions(run, runTurn, agent),
          // A credential for `memory_note` and the skill tools (EO-718)
          // alone: the `eo` server lists what the run's did, and it and
          // the bridge refuse any other write made with it. No other
          // turn's credential names the skill tools, so no other turn is
          // served them. A skill-only review (EO-731) has the skill tools
          // alone: the run it reviews wrote its own notes, so
          // `memory_note`, listed as on the run, is refused when called.
          writeBridge: bridge.tokenFor(item.id, served),
          // And every other call refused as it is made (EO-732): an edit,
          // a command, an attached server, EO's administrative server —
          // which the system agent's every turn is given (invariant 11)
          // and so is listed here — and a `Skill` or `skill_read` load,
          // which would count as the run's use: the review reads skills
          // with `skill_view`, which is how EO knows what it read before
          // it lets it write.
          refuseCallsExcept: [MEMORY_READ_TOOL_NAME, ...served],
          signal: controller.signal,
        }),
        stopped,
      ]);
      if (forked === "stopped") return failedReview(null);
      if (!forked.ok) {
        if (timedOut) return failedReview(null);
        return { kind: "fell_back", reason: `${forked.reason}: ${forked.message}` };
      }
      forkThreadId = forked.threadId;
      interrupt = forked.events.interrupt;
      const iterator = forked.events[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await Promise.race([iterator.next(), stopped]);
          if (next === "stopped") {
            void iterator.return?.()?.catch(() => {});
            break;
          }
          if (next.done) break;
          const event = next.value;
          if (recording) recordReviewActivity(run.id, forked.threadId, event);
          if (event.type === "thread_started") {
            if (event.model) model = event.model;
            if (event.fork) forkCopy = event.fork;
          } else if (event.type === "usage" && usage.record(event)) reported = true;
          else if (event.type === "error" && event.fatal !== false && failure === null) failure = event.message;
        }
      } catch (error) {
        if (failure === null) failure = error instanceof Error ? error.message : String(error);
      }
      if (timedOut || shuttingDown || failure !== null) return failedReview(forkThreadId);
      return review.entryIds.length > 0 || review.skills.written.length > 0
        ? { kind: "written", entryIds: [...review.entryIds], skillIds: [...review.skills.written], forkThreadId, ...(forkCopy ? { fork: forkCopy } : {}) }
        : { kind: "nothing_to_save", forkThreadId, ...(forkCopy ? { fork: forkCopy } : {}) };
    } finally {
      clearTimeout(timer);
      reviewControllers.delete(controller);
      reviewTurns.delete(run.id);
      recordReviewSpend();
    }

    function failedReview(threadId: string | null): LearningReviewOutcome {
      const reason = timedOut
        ? `The learning review ran past its ${String(LEARNING_REVIEW_TIMEOUT_MS / 60_000)}-minute limit and was stopped.`
        : shuttingDown
          ? "EO shut down while the learning review was under way."
          : `The learning review's turn failed: ${failure ?? "it ended without saying why."}`;
      return { kind: "failed", entryIds: [...review.entryIds], skillIds: [...review.skills.written], reason, forkThreadId: threadId, ...(forkCopy ? { fork: forkCopy } : {}) };
    }

    /**
     * What the fork's turn spent, as a side call's row (`learning_review`),
     * so the budgets that count side calls beside runs count it: the run's
     * own row is already final. Written however the review ended, where
     * the backend reported what it spent.
     */
    function recordReviewSpend(): void {
      if (!reported) return;
      try {
        const totals = usage.totals();
        recordSideCall(db, {
          purpose: "learning_review",
          projectId: (item.projectId as Uuid | null) ?? null,
          itemId: item.id,
          runId: run.id,
          backend,
          model,
          tokensIn: totals.tokensIn,
          tokensOut: totals.tokensOut,
          costMicrocents: usage.costMicrocents(),
          startedAt,
          durationMs: Math.max(0, now() - startedAt),
          outcome: forkThreadId !== null && failure === null && !timedOut && !shuttingDown ? "succeeded" : "failed",
          reason: forkThreadId !== null && failure === null && !timedOut && !shuttingDown ? null : timedOut ? "timeout" : "error",
        });
      } catch (error) {
        console.warn(`[eo] what the learning review of run ${run.id} spent could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Closes a run that was written and never started (EO-478): the
   * selection of its memory yielded, and the world changed meanwhile so
   * that the boundary's checks no longer pass. Cancelled with the reason
   * on the row and said on the item, rather than left queued for the
   * next reconciliation to find (invariant 8).
   */
  /**
   * This turn's memory, chosen against the run row just written, or null
   * when the run was closed instead of started (EO-478). Shared by every
   * path that writes a run and then reaches a backend with a new turn —
   * a dispatch and a person's reply to a parked run — so both are given
   * memory as it stands now and both re-ask the same questions after a
   * selection that yielded.
   *
   * Synchronous when nothing is asked. When a selection was made:
   *
   * - a row somebody else closed meanwhile is left as they left it;
   * - EO quitting closes it as shutdown's sweep closes a live run —
   *   cancelled, "stopped when EO was closed", an interruption rather
   *   than an attempt — because that sweep reaches only runs with a
   *   controller, and this one has none yet;
   * - a pause, a delete, an archived project, an agent gone or an item
   *   moved closes it with the reason (`closeBeforeStart`).
   *
   * `stillEligible` is not asked: it was written for the window before
   * the row, and would find this very run standing on the item. The row
   * guards the step from here, so the item still being where the run was
   * decided is the part left to check.
   */
  function memoryBeforeStart(
    run: Run,
    item: Item,
    agent: Agent,
    action: string,
    scopes: readonly MemoryScopeInfo[],
    agentGone: () => boolean,
  ): { section: string | null } | null | Promise<{ section: string | null } | null> {
    const pending = memoryForTurn(run, item, agent, action, scopes);
    if (!(pending instanceof Promise)) return pending;
    return pending.then((memory) => {
      if (getRun(db, run.id)?.status !== "queued") return null;
      if (shuttingDown) {
        updateRun(db, run.id, { status: "cancelled", error: "stopped when EO was closed, before its backend was started", interruption: "quit", endedAt: now() });
        announceRun(run.id, item.id, "cancelled");
        return null;
      }
      const itemNow = getItem(db, item.id);
      const stale = heldBack(agent, item.id)
        ? "EO was paused"
        : !itemNow
          ? "the item was deleted"
          : shelved(item.id)
            ? "the item's project was archived"
            : !isAgentAvailable(agent) || agentGone()
              ? `${agent.name} stopped being available for this item`
              : itemNow.stepId !== item.stepId
                ? "the item was moved to another step"
                : null;
      if (stale !== null) {
        closeBeforeStart(run, item, agent, stale);
        return null;
      }
      return memory;
    });
  }

  function closeBeforeStart(run: Run, item: Item, agent: Agent, why: string): void {
    if (!getItem(db, item.id)) return; // deleted, and its runs with it
    const sentence = `${why} while the memory for ${agent.name}'s run was being chosen, so the run was not started.`;
    updateRun(db, run.id, { status: "cancelled", endedAt: now(), error: sentence.charAt(0).toUpperCase() + sentence.slice(1) });
    announceRun(run.id, item.id, "cancelled");
    postComment(db, {
      itemId: item.id,
      runId: run.id,
      author: { type: "engine" },
      kind: "note",
      body: `${sentence.charAt(0).toUpperCase() + sentence.slice(1)} Nothing was sent to the "${agent.provider}" backend, and the item waits where it stands.`,
    });
  }

  /**
   * Opens a turn on a backend, unless the workspace it would run in
   * refuses it (EO-386).
   *
   * **Every call that reaches a provider goes through here** — a fresh
   * dispatch, a reused thread, a person's reply, a recovery after a
   * crash and both corrective turns — so the question is asked per turn
   * rather than once per agent, and it is asked of the workspace's kind
   * rather than of the agent's role or of whichever adapter happens to
   * be underneath. Claude and Codex are refused, or not, by the same
   * sentence, because neither is consulted (invariant 12).
   *
   * `open` is not called on a refusal, so nothing is spawned. What comes
   * back instead is a stream that says why, which `processStream` reads
   * as a tripped guard: the run ends awaiting a person and the reason is
   * a comment on the item (invariants 8 and 9). A stream rather than a
   * verdict for each caller to act on, because the five call sites end a
   * run in five different surroundings and all of them already hand
   * their stream to the one place that knows how.
   *
   * No workspace is no question: a run EO recorded no directory for has
   * nothing for a kind to judge.
   */
  function openTurn(item: Item, workspace: PreparedWorkspace | null, open: () => InterruptibleStream<AgentEvent>): InterruptibleStream<AgentEvent> {
    if (workspace === null) return open();
    const kind = kinds.get(workspace.kind) ?? coreKinds.get(workspace.kind) ?? noDisk;
    const refusal = kind.refusesTurn?.(item, workspace) ?? null;
    return refusal === null ? open() : refusedTurn(refusal);
  }

  const readGuards = (): GuardConfig => ({
    ...DEFAULT_GUARDS,
    ...(typeof guardOverrides === "function"
      ? guardOverrides()
      : guardOverrides),
  });

  /**
   * The agent as this dispatch actually runs it (EO-313, ARCHITECTURE.md, "Preview").
   *
   * Itself for real work, and the same agent on the `fake` backend for a
   * preview — whatever its configured backend says. A preview is a
   * person watching the machine work before they have signed into
   * anything, so "run it, but on Claude, because that is what the
   * implementer is set to" would be a preview that spent money, asked
   * for a login, and put real words into a real repository.
   *
   * The whole agent rather than a provider picked out of it, because
   * three other things are decided from the same field and every one of
   * them would otherwise describe a backend that did not run: the run
   * row's `provider` column, the runtime snapshot beside it, and the
   * sign-in check that would park a preview on an account it never
   * needed.
   *
   * A copy rather than a write: nothing about the agent a person
   * configured changes, and the next dispatch of the same agent against
   * real work reads its own row untouched.
   */
  const runsOn = (agent: Agent, item: Item): Agent => (item.previewAt === null ? agent : { ...agent, provider: "fake" });

  /** The provider for this agent on this item — see the `provider` option, and `runsOn` on why the item is in the question. */
  const providerFor = (agent: Agent, item: Item): AgentProvider =>
    typeof provider === "function" ? provider(runsOn(agent, item)) : provider;

  /** Runs whose opening send was recorded, so their corrective turns are recorded too (EO-392). */
  const capturedRuns = new Set<string>();

  /**
   * Appends one send to a run's log (EO-392, invariant #3).
   *
   * Through the run's live buffer when it has one and straight to the
   * record when it does not, for the reason `recordMessageOnRun` gives:
   * two allocators over one run hand out the same `seq` twice. An
   * opening send is written before the run has a buffer, so it is the
   * run's first event; a corrective one arrives mid-run and goes through
   * the buffer that is numbering everything else.
   */
  function recordSent(runId: Uuid, sent: DebugSent): void {
    appendDebugRow(runId, DEBUG_SENT_EVENT, sent);
  }

  /** One row debug mode writes to a run's log, through its buffer when it has one, for `recordSent`'s reason. */
  function appendDebugRow(runId: Uuid, type: string, payload: unknown): void {
    const buffer = activeEventBuffers.get(runId);
    if (buffer) {
      buffer.append(runId, type, payload);
      buffer.flush();
    } else {
      record.appendRunEvent(runId, type, payload);
    }
    onPushEvents?.(runId, []);
  }

  /**
   * What a learning review's fork did, on the reviewed run's log while
   * debug mode records it (EO-734): its tool calls, their results and its
   * words, each under a learning-review type of its own and never the
   * run's — so nothing counting the run's tool calls, skills, memory,
   * turns or cost counts the review's — with the fork's thread beside it.
   * Everything else the fork says is left out, as it is with debug mode
   * off. A row that cannot be written says so on the console; the review
   * goes on.
   */
  function recordReviewActivity(runId: Uuid, forkThreadId: string, event: AgentEvent): void {
    if (event.type !== "tool_call" && event.type !== "tool_result" && event.type !== "output") return;
    try {
      appendDebugRow(runId, LEARNING_REVIEW_ACTIVITY_EVENTS[event.type], { ...event, forkThreadId });
    } catch (error) {
      console.warn(`[eo] debug mode could not record what the learning review of run ${runId} did: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The instructions a resumed or forked thread keeps — the ones it was
   * opened with, which the run row holds the hash of (EO-87). Where the
   * agent's still hash to it, they are those instructions and can be
   * shown; where they do not, EO no longer has the text and says so
   * rather than showing the edited ones as though they had been sent.
   */
  function threadInstructionsOf(runId: Uuid, agent: Agent): string | null {
    const bornWith = getRun(db, runId)?.instructionsHash ?? null;
    return bornWith !== null && bornWith === promptHash(agent.instructions) ? agent.instructions : null;
  }

  /**
   * The provider a run's turn is opened on — recording what it is handed
   * while debug mode is on (EO-392).
   *
   * **Every send goes through here**, the five `openTurn` call sites
   * alike, so there is one place the capture is decided and it sits
   * above both adapters (invariant 12). With debug mode off this is
   * `providerFor` and nothing more: no wrapper, no row, nothing stored.
   *
   * The setting is read here, per send, which is what makes turning it
   * on apply to the next dispatch — and what makes turning it off stop
   * the recording at once: nothing is written while the switch is off,
   * a corrective turn of a run that was being recorded included.
   *
   * A *corrective* turn has one more condition. It is recorded only
   * when its run's opening send was, so a run dispatched with debug
   * mode off stays unrecorded for its whole life even if the switch is
   * turned on meanwhile — which is what the window's "not recorded"
   * sentence promises. A correction alone, with no record of the
   * dispatch it corrects, would read as the whole of what was sent.
   */
  function sendingProvider(
    run: { id: Uuid },
    agent: Agent,
    item: Item,
    action: string,
    send: { purpose: SendContext["purpose"]; refusal?: string | null },
  ): AgentProvider {
    // Every turn of a run, whichever backend: its CLI starts in the run's
    // own systemd scope where the machine has one, with the run's memory
    // limit (EO-738). Said once here, the one door every run's turn goes
    // through, rather than at each of the places a turn is opened.
    const inner = scopedProvider(providerFor(agent, item), processScopeOf(run.id));
    const capturing = debugMode() && (send.purpose !== "correction" || capturedRuns.has(run.id));
    if (!capturing) return inner;
    capturedRuns.add(run.id);
    return capturingProvider(
      inner,
      {
        backend: runsOn(agent, item).provider,
        purpose: send.purpose,
        refusal: send.refusal ?? null,
        threadInstructions: threadInstructionsOf(run.id, agent),
        // Resolved the way `outputSchemaFor` resolves the schema itself,
        // so the name is the schema's and not merely the action's: a
        // type may hold an action to another action's answer.
        outputSchemaName: actionSchemaName(registryFor(item), action, typeOf(item), definingRole(item, agent)),
      },
      (sent) => recordSent(run.id, sent),
    );
  }

  /** What a run's processes are started under (EO-738): the run, and its memory limit as the guardrails say now. */
  function processScopeOf(runId: Uuid): RunProcessScope {
    const memoryMaxMb = effectiveRunMemoryMaxMb({
      runMemoryMaxMb: readGuards().runMemoryMaxMb,
      globalConcurrency: (typeof limits === "function" ? limits() : limits).globalConcurrency,
    });
    return { runId, memoryMaxMb };
  }

  /**
   * Whether a run that ended badly ran out of memory (EO-738). Never
   * throws: a question nothing could answer is a run that failed the
   * ordinary way.
   */
  async function ranOutOfMemory(runId: Uuid): Promise<RunOutOfMemory | null> {
    try {
      return await outOfMemory(runId);
    } catch {
      return null;
    }
  }

  /**
   * Ends an agent's run that ran out of memory (EO-738): `failed`, with
   * the limit and the killed process in its error — which keeps it out of
   * the attempt count (`isOutOfMemoryStop`) — and the item parked the way
   * a guard parks it, with the same sentence as an escalation. Not
   * retried: the same work would run into the same limit. A reply starts
   * a fresh initiation, as a reply to any guard's park does.
   *
   * A module run (`agent` null) ends the same way: the run `failed`, and
   * the park a placeholder of its own, so the run that ran out is not
   * mistaken for a question it asked.
   */
  function endOutOfMemory(runId: Uuid, item: Item, agent: Agent | null, action: string, threadId: string | null, report: RunOutOfMemory): void {
    const reason = outOfMemoryReason(report, agent, action);
    updateRun(db, runId, { status: "failed", error: reason, endedAt: now(), ...(threadId === null ? {} : { threadId }) });
    announceRun(runId, item.id, "failed");
    const row = getRun(db, runId);
    refuseDispatch(item, agent, action, reason, row?.initiationId ?? workflowInitiationId(item, action), row?.attempt ?? 1);
  }

  /** The out-of-memory sentence for a run: the agent by name, or the module step by its action. */
  function outOfMemoryReason(report: RunOutOfMemory, agent: Agent | null, action: string): string {
    return outOfMemoryStop(report, agent?.name ?? `"${action}"`, outOfMemoryLimit());
  }

  /**
   * Whether a module run that failed did so because its host's scope ran
   * out of memory (EO-738). Asked only of a module that ran and failed:
   * one that succeeded, or never started, has nothing to say.
   */
  async function moduleRanOutOfMemory(outcome: BuiltinOutcome, runId: Uuid): Promise<RunOutOfMemory | null> {
    return outcome.ok ? null : ranOutOfMemory(runId);
  }

  /** Where the limit an out-of-memory run was held to came from, for its sentence. */
  function outOfMemoryLimit(): { setting: number | null; totalMb: number; globalConcurrency: number } {
    return {
      setting: readGuards().runMemoryMaxMb,
      totalMb: machineMemoryMb(),
      globalConcurrency: (typeof limits === "function" ? limits() : limits).globalConcurrency,
    };
  }

  /**
   * Where a finished run sends its item: what the installed packs'
   * wiring says, or — when none of them claims the action — the key the
   * run reported, else `done` (KAN-144).
   *
   * The default was a walk to the next step by position, which ignored
   * the routing table altogether, so the core's answer and every pack's
   * answer were reached by different code. That walk is still taken, but
   * as `resolveRoute`'s answer for a step that declares no results,
   * which is the one case it was ever right for.
   */
  const nextStateFor = (
    currentStep: PipelineStep,
    steps: PipelineStep[],
    parsedResult: unknown,
    action: string,
    item: Item,
    /** The dispatched agent's role, or null where EO ran the step itself — a builtin or a module has no role to define an action. */
    role: string | null,
  ): NextStep => {
    // A role's own action routes on the `result` it answered with, and
    // no pack is asked what the action name means to it (EO-421): the
    // definition declared the keys, the schema held the answer to them,
    // and the route table is all that is left to read.
    //
    // `packMeaningInForce` is the question (EO-422) — the one every
    // site that acts on an action's name asks — and `role` arrives here
    // already null for a preview, which that function would have made of
    // it anyway.
    if (!packMeaningInForce(db, item, role, action)) {
      return routeResult(db, currentStep, steps, previewAwareResultKey(parsedResult, currentStep, item), item);
    }
    const claimed = resolveNextState(currentStep, steps, parsedResult, action, item, role);
    return claimed === undefined ? routeResult(db, currentStep, steps, previewAwareResultKey(parsedResult, currentStep, item), item) : claimed;
  };

  /**
   * The result key a finished run routes on — the step's own first, for
   * a preview that reported none (EO-313, ARCHITECTURE.md, "Preview").
   *
   * `reportedResultKey` answers `done` for an agent run that reported
   * nothing in particular, which is what the shipped pipeline's steps
   * route on and is right for them. A template's step is the other
   * shape: it declares two or three outcomes of its own — "drafted",
   * "needs another pass" — and `done` is not among them, so
   * `resolveRoute` reads the answer as a configuration gap and parks
   * the item asking somebody to add a route. On a preview that is the
   * wrong reading twice over: nothing judged anything, so there is no
   * outcome to have reported, and parking ends the walk the preview
   * exists to show.
   *
   * So a preview falls to the step's first declared result — the same
   * rule, and the same sentence, as the module gate: `manifest.results`
   * and `step_routes` are both written success-first, and the first
   * entry is the author's own "this worked".
   *
   * Only where the run reported nothing. A preview that *did* report a
   * key — the canned `review` verdict, say — is routed on it like any
   * other run, because that key is the demo's considered answer rather
   * than an absence.
   */
  function previewAwareResultKey(parsedResult: unknown, currentStep: PipelineStep, item: Item): string {
    const reported = (parsedResult as { result?: unknown } | null)?.result;
    if (typeof reported === "string") return reported;
    if (item.previewAt === null) return reportedResultKey(parsedResult);
    // The item's own version's routes (EO-327): a preview walking an
    // older version takes the first result *that version* declares.
    const declared = declaredResults(currentStep.id, graphForItem(db, item).routes);
    return declared[0]?.resultKey ?? reportedResultKey(parsedResult);
  }

  /**
   * Whichever room this conversation is in, not just the first one that
   * had settings. `settingsFor` reads them back by the same key.
   *
   * The body is `conversationTurnOptions` in `roles/conversationSteps` —
   * out here it sat inside this closure, where nothing could reach it to
   * test it.
   */
  /**
   * What every turn is opened with beyond its own: a conversation's
   * settings where the item is one (`conversationTurnOptions`), and for
   * every run the words as they are written — what a person watching a
   * step's transcript reads while it works, as they would in a chat. The
   * words are transient and never stored, and a pipeline step's are
   * already asked of the backend for the inactivity guard. Two things stay
   * a conversation's, because asking for them changes the turn and not
   * only what is shown: reasoning summaries, which change how a model
   * thinks, and the answer streamed as it is written (`streamAnswer`),
   * which on Claude streams every tool's input.
   */
  const discussionTurnOptions = (
    item: Item,
    agent: Agent,
  ): Pick<
    AgentProviderResumeOptions,
    "model" | "reasoningEffort" | "showReasoning" | "streamDeltas" | "streamAnswer" | "budgetCents" | "skillScope" | "environmentVariables" | "withheldEnvironmentVariables"
  > => {
    // Every turn's, not only a conversation's, despite the name — every
    // turn path spreads it. `skillScope` is where the run works, for the
    // adapter that narrows the skills it writes itself (EO-470).
    return {
      streamDeltas: true,
      ...conversationTurnOptions(item),
      ...turnBudget(item, agent),
      skillScope: skillRunScope(db, item),
      ...turnEnvironment(item),
    };
  };

  /**
   * The run's environment variables (EO-487), read from disk now — every
   * turn that spawns a CLI process asks again as it opens, so an edit or
   * a removal reaches the next process without EO restarting. Nothing
   * when there are none, so a turn carries no empty map.
   */
  const turnEnvironment = (item: Item): { environmentVariables?: Record<string, string>; withheldEnvironmentVariables?: string[] } => {
    // A step a trial plan redirects reads its trial-only variables, on a
    // trial item and nowhere else (EO-584) — and the names it sets for
    // itself and does not redirect reach the CLI from nowhere, not even
    // from what it would inherit.
    const scope = stepScopeFor(db, item, item.stepId);
    const environmentVariables = (scope.trialScope === undefined ? runEnvironment?.(scope.stepId) : runEnvironment?.(scope.stepId, scope.trialScope)) ?? {};
    const withheld = scope.trialScope !== undefined && scope.stepId !== null ? (runEnvironmentWithheld?.(scope.stepId, scope.trialScope) ?? []) : [];
    return {
      ...(Object.keys(environmentVariables).length > 0 ? { environmentVariables } : {}),
      ...(withheld.length > 0 ? { withheldEnvironmentVariables: withheld } : {}),
    };
  };

  /**
   * The tool surface a run of this agent on this item is given, as the
   * hash thread reuse compares (EO-106, EO-470): its servers, and the
   * attached skills whose scope takes in the item's project or its step's
   * workspace. The same narrowing the tool directory and the Codex turn
   * deliver, so the hash describes what the run actually received.
   */
  const runAttachmentsHash = (agent: Agent, item: Item): string => agentAttachmentsHash(db, agent.id, skillRunScope(db, item));

  /**
   * What a turn on this item may spend (`budgetCents`), worked out when the
   * turn opens — every turn, a run's corrections included, since each
   * spends against what the turns before it left.
   *
   * Work only. A conversation's turn is short and is started ahead of time
   * (`prewarm`), and a cap fixed when its backend was started would never
   * match the turn it was started for. A preview runs on no real backend
   * and spends nothing, and is never asked to authorize spend. The system
   * agent is held to neither budget (EO-616), so its turn has no cap for a
   * backend to stop it at.
   */
  const turnBudget = (item: Item, agent: Agent): { budgetCents?: number } => {
    if (item.previewAt !== null || isSystemAgent(agent) || Object.keys(conversationTurnOptions(item)).length > 0) return {};
    const remaining = remainingBudgetCents(item.id);
    return remaining === null ? {} : { budgetCents: remaining };
  };

  const activeControllers = new Map<string, AbortController>();
  /**
   * The handover index syncs in flight, by run (EO-153).
   *
   * A second map rather than a reuse of `activeControllers`, because
   * the two stand for different claims. That one means "a backend is
   * running and this run's row is not terminal yet"; every reader of it
   * — `activeRunCount`, reconciliation's adoption filter,
   * `cancelActiveRun`'s decision to write `cancelled` — depends on that
   * being true, and a run whose result has already been accepted and
   * recorded would break all three.
   *
   * What is still true at that point is narrower and is the only thing
   * this claims: a process EO started is running in somebody's
   * checkout, and a cancel has to be able to end it. `driveToCompletion`
   * lets go of the run's own controller before it reaches the terminal
   * switch, so without this the abort would have nowhere to land and an
   * indexer would outlive the cancel meant to stop it.
   */
  const activeHandoverSyncs = new Map<string, AbortController>();
  const activeStreams = new Map<string, InterruptibleStream<AgentEvent>>();
  /**
   * The transcript each live run is being written to, by run (EO-176).
   *
   * Held for one reason: `run_events.seq` is allocated in memory by the
   * buffer, one counter per run, and a second writer against the same
   * run would hand out numbers the first has already used. So a message
   * steered in from the IPC side cannot simply insert a row — it has to
   * go through the same buffer the stream is using, which means the
   * buffer has to be reachable from outside the closure that made it.
   * Entries live exactly as long as the run's own does.
   */
  const activeEventBuffers = new Map<string, RunEventBuffer>();
  const activeRestartIntents = new Map<string, ForcedRestartIntent>();
  /** Runs explicitly cancelled by a person or forced shutdown stay cancelled even if a backend races to finish. */
  const forcedCancellationRunIds = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  /** Set right before aborting a run for a guard reason, so the catch block can tell a guard trip apart from a plain cancelRun(). */
  const guardTripReasons = new Map<string, string>();
  /**
   * The provider session a live run is talking to, while it is talking.
   *
   * The run row is written the moment the backend names its thread (so
   * a restart can carry the run on), and again when the run ends; this
   * is the same id held in memory for the paths that close a run
   * without a terminal branch — #141's stranded row, which once came to
   * have a delivered outcome and a null `threadId`, and
   * `closeAbandonedRun`, which writes this instead of another null.
   * Entries live no longer than the run.
   */
  const lastKnownThreadIds = new Map<Uuid, string>();
  /**
   * One run at a time per item (EO-132). Every path that ends in a
   * process holding an item's worktree claims it here first.
   */
  const itemLock = createItemLock();
  /**
   * Holds taken by `reconcile()` for a run it *adopted* rather than
   * re-dispatched — one this process was already driving when the last
   * one died, whose stream nothing here owns.
   *
   * Every other hold is scoped to the async work it guards and released
   * by a `finally`. These have no such scope, so they are released the
   * only way they can be: by asking, before each tick, whether the run
   * they stand for has reached a terminal status. Without that a run
   * this process cannot see the end of would hold its item for the
   * lifetime of the process.
   */
  const adoptedHolds = new Map<Uuid, ItemHold>();

  /**
   * Rerun requests this process is already acting on, keyed by the
   * comment that asked (EO-135).
   *
   * The item lock cannot stand in for this. A request is only closed
   * once its run row exists, and everything before that — auth, the
   * worktree, the context — is awaits during which the mention is still
   * open and the item is claimed. Offering it again in that window
   * produces a second attempt that loses the lock to the first and
   * reports the item as busy because of the very run it is starting.
   */
  const rerunsInFlight = new Set<string>();

  let intervalTimer: ReturnType<typeof setInterval> | undefined;
  let watchdogTimer: ReturnType<typeof setInterval> | undefined;
  let stopHearingWakes: (() => void) | undefined;
  /**
   * What the inactivity guard knows of each run in flight: when its
   * backend last said anything, which tool calls it has open, and the
   * last thing it said, for the comment if it has to be stopped.
   */
  const runActivity = new Map<
    string,
    {
      /** When a watchdog pass last found the run had said something new — silence is measured to the pass, not the event. */
      lastAt: number;
      /** Everything the backend has said, counted, and the count the last pass saw: one increment per event rather than a clock read. */
      events: number;
      seenEvents: number;
      openCalls: Set<string>;
      /** Tool calls since EO last restated the brief, which is what earns the next reminder (`restatedBrief`). */
      callsSinceReminder: number;
      lastWord: string | null;
      agentName: string;
      /** The system agent's, which no silence stops (EO-616), though one after a wake is still carried on. */
      systemAgent: boolean;
    }
  >();
  /**
   * The skills each run in flight was given, by slug, and which of them it
   * has loaded (EO-715) — what holds a `skill_loaded` event to the run's
   * own delivery and to once per skill. Set by the run's first
   * `skills_delivered`, dropped when the run is over.
   */
  const runSkills = new Map<string, { bySlug: Map<string, string>; loaded: Set<string> }>();
  /** When the computer last woke, as `onWake` or a late watchdog pass said. Silence before it is not the run's. */
  let lastWakeAt: number | null = null;
  let lastWatchdogPassAt: number | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The pass that is running, or null.
   *
   * A promise rather than a boolean since EO-324, and the difference is
   * what a *second* caller is owed. A tick now awaits the record before
   * it knows what to dispatch — a round trip, in managed mode — so the
   * window between "a tick started" and "its dispatches exist" is no
   * longer a few synchronous statements. A caller that arrived inside
   * that window and was simply told "one is already running" would
   * return before the work it asked about had been created, and
   * `runOnce`'s promise — run a tick and wait for what it produced —
   * would be answering about nothing.
   *
   * So a second caller waits for the pass in flight and still asks for
   * another afterwards, which is what `rerunRequested` has always
   * meant: the tick you asked for is not the one you joined, and you
   * are owed it.
   */
  let tickInFlight: Promise<void> | null = null;
  let rerunRequested = false;
  /**
   * Set for as long as reconciliation is in flight, and the whole of how
   * the original design's "nothing dispatches before reconciliation completes" is
   * enforced (EO-151).
   *
   * It used to be enforced by *ordering*: reconciliation ran
   * synchronously, so a tick could not interleave with it. Making it
   * asynchronous quietly removed that, and chaining the callers' own
   * ticks behind it only fixed the ticks the callers knew about. The
   * interval `start()` creates and anything `notifyStateChange`
   * debounces both reach `runTickOnce` directly, so a slow
   * reconciliation — one awaiting a repository server for a stale run —
   * was a window in which either could dispatch an item reconciliation
   * had not yet cancelled, re-dispatched or taken a hold on. Two runs in
   * one checkout is the cost.
   *
   * A flag rather than more chaining, because chaining is a rule every
   * future caller has to remember and this is one every caller obeys by
   * going where they already go. It is assigned *synchronously* by
   * `reconcile()`, which is what makes it a barrier at all: a caller
   * that starts reconciliation and ticks on the very next line still
   * finds it set.
   */
  let reconciling: Promise<ReconcileSummary> | null = null;
  let stopped = true;
  /**
   * Set once `shutdown` begins, and never cleared. Not `stopped`, which
   * is also true before `start` and so in every supervisor driven by
   * `runOnce` alone: this is "EO is quitting", which a dispatch past its
   * run row has to tell apart from "nobody started the timers" (EO-478).
   */
  let shuttingDown = false;
  let paused = initialPaused;
  /**
   * Set once EO starts to close (`beginClose`), and never cleared. Not
   * `shuttingDown`, which only starts when a drain has ended. A close uses
   * the pause, so `paused` is true for as long as this is.
   */
  let closing = false;

  /**
   * Whether a run of this agent may not start now, on any path (EO-615).
   * A pause holds everybody but the system agent, and it too if somebody
   * switched it off or archived it: `dispatchBlockers.ts` lets a mention or
   * a reply reach a disabled agent, but that is no reason to reach one
   * while EO is paused. So does a hold on the item the run is for, which
   * on other days stops the tick and a rerun, not a mention or a reply:
   * with both a pause and a hold on it, what a person has said is to leave
   * that item alone, and the mention or reply is kept for after. Null or
   * undefined is a run with no agent, a builtin or a module, or one whose
   * agent has gone. The scheduler asks the same thing of a step, through
   * `pauseExemptRoles` and its own blockers.
   */
  function heldBack(agent: Agent | null | undefined, itemId?: Uuid): boolean {
    if (closing) return true;
    if (!paused) return false;
    if (!agent || !isSystemAgent(agent) || !isDispatchable(agent)) return true;
    return itemId !== undefined && (getItem(db, itemId)?.heldAt ?? null) !== null;
  }

  /**
   * Whether a run already going is one a pause leaves alone: the system
   * agent's, by its role alone, because a pause stops what starts and
   * this has started. Switching the agent off meanwhile does not change
   * that. Nothing is left alone once EO is closing.
   */
  function carriesOn(runId: string): boolean {
    return !closing && isSystemAgent(agentOf(getRun(db, runId as Uuid)));
  }

  function agentOf(run: Run | undefined): Agent | undefined {
    return run?.agentId == null ? undefined : getAgent(db, run.agentId);
  }

  /** What `tick()`'s eligibility is decided from, as things stand right now. */
  function eligibilityNow(): EligibilityInput<GateRefusal> {
    return buildEligibilityInput(db, paused, scheduling, now(), readGuards().perItemAttemptLimit, currentWatchHold(), closing ? NO_PAUSE_EXEMPTIONS : PAUSE_EXEMPTIONS);
  }

  function tickInputNow(): TickInput<GateRefusal> {
    return buildTickInput(
      db,
      typeof limits === "function" ? limits() : limits,
      paused,
      scheduling,
      now(),
      readGuards().perItemAttemptLimit,
      currentWatchHold(),
      // Trial items ahead of live work while their loop runs (EO-582).
      readGuards().trialsFirst,
      closing ? NO_PAUSE_EXEMPTIONS : PAUSE_EXEMPTIONS,
      UNCAPPED_ROLES,
    );
  }

  function forcedRestartIntents(): ForcedRestartIntent[] {
    return getSetting<ForcedRestartIntent[]>(db, FORCED_RESTARTS_KEY, []);
  }

  function persistForcedRestart(intent: ForcedRestartIntent): void {
    const existing = forcedRestartIntents();
    if (existing.some((candidate) => candidate.cancelledRunId === intent.cancelledRunId)) return;
    setSetting(db, FORCED_RESTARTS_KEY, [...existing, intent]);
  }

  function clearForcedRestart(cancelledRunId: string): void {
    const remaining = forcedRestartIntents().filter(
      (intent) => intent.cancelledRunId !== cancelledRunId,
    );
    if (remaining.length === 0) clearSetting(db, FORCED_RESTARTS_KEY);
    else setSetting(db, FORCED_RESTARTS_KEY, remaining);
  }

  /**
   * Declines to start a run, leaving the item parked for a human.
   *
   * Writes a zero-work run row so the item reads as `awaiting_input`
   * and the scheduler stops re-offering it, then explains itself as an
   * engine comment (ARCHITECTURE.md, "Escalation ends the run", invariant #8). Used by every
   * pre-dispatch
   * refusal — the attempt limit, since G-01 an unusable workspace, and
   * since EO-213 a review with nothing to judge against.
   *
   * `agent` is nullable for that last one alone. A refusal decided at
   * the *scheduler* boundary rather than inside a dispatch has no agent
   * in hand and may have none to find — a step whose role nobody holds
   * is refused for its criteria first, because the criteria are the half
   * the person reading the item can fix — and a run row that names no
   * agent is a shape this table already carries for every builtin.
   */
  function refuseDispatch(
    item: Item,
    agent: Agent | null,
    action: string,
    reason: string,
    initiationId: string,
    attempt: number,
    options?: string[],
  ): void {
    const guardRun = createRun(db, {
      itemId: item.id,
      agentId: agent?.id ?? null,
      action,
      status: "awaiting_input",
      initiationId,
      attempt,
    });
    updateRun(db, guardRun.id, {
      startedAt: now(),
      endedAt: now(),
      error: reason,
    });
    postGuardEscalation(item.id, guardRun.id, reason, options);
    announceRun(guardRun.id, item.id, "awaiting_input");
  }

  /**
   * Why a run failed, in the thread.
   *
   * A failed run used to leave nothing behind: `runs.error` held the
   * reason and the item said only that it had stopped, so the one
   * place a person actually looks was silent. Every other stopping point
   * — a tripped guard, a rejected claim, a review — posts. This is the
   * gap in invariant 8.
   *
   * A note rather than a mention, and it names the attempt: the
   * scheduler retries a failed run, so three of these in a row are the
   * attempt loop being visible rather than a stutter. The attempt-limit
   * guard is what finally asks for a person.
   */
  function postRunFailure(itemId: Uuid, runId: Uuid, reason: string): void {
    // Read back rather than passed in: the caller's `run` is a narrow
    // shape that does not carry the attempt number.
    const attempt = getRun(db, runId)?.attempt ?? 1;
    postComment(db, {
      itemId,
      runId,
      author: { type: "engine" },
      kind: "note",
      body: `Attempt ${attempt} stopped.\n\n${reason}`,
    });
  }

  /**
   * Where the item is now, in a sentence, for a comment that has to
   * say so.
   *
   * A run that ends with nothing to act on leaves the board looking
   * unchanged, and "unchanged" is exactly what a person cannot tell
   * apart from "still working" (invariant #8). Read fresh rather than
   * from the caller's snapshot: by the time this is written the run may
   * have moved the item, or a person may have.
   */
  function whereTheItemStands(itemId: Uuid): string {
    const current = getItem(db, itemId);
    if (!current) return "The ticket itself is gone.";
    const step = stepForItem(db, current);
    return step ? `The ticket is at "${step.name}".` : "The ticket is not on any step.";
  }

  /**
   * Says what EO will not do for this dispatch, once (EO-108).
   *
   * **Once is the hard part, not the posting.** This describes how the
   * agent is configured, not what this run did, so a note per dispatch
   * would repeat on every step of every item forever — and EO cannot
   * see the person acting on it, because the fix lands in a file
   * (`~/.codex/config.toml`) that EO deliberately does not read. A
   * notice nobody can silence is noise, and noise is how invariant 8
   * gets quietly switched off by whoever is tired of reading it.
   *
   * So: not already on this item, in those words. The body names the
   * servers, so attaching another one changes it and says so, while the
   * same configuration dispatched six times says it once. Compared by
   * text rather than by a marker hidden in it, because the thing that
   * must not repeat *is* the sentence, and a marker is one more thing
   * that can drift from what it marks.
   *
   * Unanchored to a run on purpose. There is no run yet — this is
   * preflight, the same place `checkAuth` sits — and tying a standing
   * fact about configuration to whichever dispatch happened to notice
   * it first would read as though that run had caused it.
   */
  function postDispatchNotices(item: Item, agent: Agent): void {
    const notices = dispatchNotices(agent);
    if (notices.length === 0) return;

    const alreadySaid = new Set(
      listCommentsForItem(db, item.id)
        .filter((comment) => comment.authorType === "engine")
        .map((comment) => comment.body),
    );
    for (const body of notices) {
      if (alreadySaid.has(body)) continue;
      postComment(db, { itemId: item.id, author: { type: "engine" }, kind: "note", body });
      // Two notices with the same text in one pass would otherwise both
      // post: the set was read before either of them existed.
      alreadySaid.add(body);
    }
  }

  /** Announces a run changing status, and the item alongside it — its badge changes too. */
  function announceRun(runId: Uuid, itemId: Uuid, status: RunStatus): void {
    onRunChanged(runId, itemId, status);
    onItemChanged(itemId);
  }

  /**
   * ARCHITECTURE.md, "Guardrails": every guard resolves the same way — post as the engine, mention
   * @user, and stop.
   *
   * `options` are offered when the guard is a question EO can name the
   * answers to — picking one posts it as an ordinary reply, which is
   * what resumes the item. A guard that is merely reporting a fact
   * passes none, and the comment renders exactly as it always has.
   *
   * Nothing in the reason is an address (EO-213). A guard escalation
   * quotes text EO did not write — a provider's sign-out message, git's
   * complaint about the worktree, and since this story a bug's own
   * `expected` — and `postComment` turns an `@token` in a body into a
   * mention by default. A mention is a dispatch trigger, so an `@` that
   * a person happened to type into a bug report would summon an agent to
   * an item EO has just refused to dispatch. The one mention this means
   * is the human one below, passed explicitly, which is exactly the
   * distinction `parseBodyMentions` exists to draw.
   */
  function postGuardEscalation(
    itemId: Uuid,
    runId: Uuid,
    reason: string,
    options?: string[],
  ): void {
    postComment(db, {
      itemId,
      runId,
      author: { type: "engine" },
      kind: "escalation",
      mentions: [{ type: "human" }],
      parseBodyMentions: false,
      body: reason,
      ...(options && options.length > 0 ? { options } : {}),
    });
  }

  /**
   * The item is done: let go of whatever its runs were holding.
   *
   * Only for a state marked terminal — anything earlier gets dispatched
   * again, and releasing its workspace mid-pipeline would make the next
   * run start from nothing. Failures here never fail the run: the work
   * is committed and the item has moved, so a directory that could not
   * be removed is a note on the item, not a reason to undo any of it.
   */
  async function settleItem(
    item: Item,
    nextStateId: string,
  ): Promise<void> {
    // Terminal **by the version this item is on** (EO-327, ARCHITECTURE.md, "Publish, lock and
    // versions"), and
    // read off the row as it stands now rather than the value this
    // function was handed: the move has already happened, and a
    // cross-pipeline one rebinds the item to a version of its new
    // pipeline. Whether the work is over decides whether EO lets go of
    // the workspace, so a later save marking a step terminal must not
    // release the checkout of something still being worked.
    const moved = getItem(db, item.id) ?? item;
    const state = stepForItem(db, { pipelineId: moved.pipelineId, stepId: nextStateId, pipelineVersionId: moved.pipelineVersionId });
    if (!state?.isTerminal) return;

    try {
      // Before the workspace, and for a different reason: this is EO's
      // own scratch rather than the person's checkout, so there is
      // nothing here that could be somebody's uncommitted work.
      releaseToolDirectories(item);
      const { keptReason } = await kindFor(item).release({ what: "settled", item, step: state });
      if (keptReason) {
        postComment(db, {
          itemId: item.id,
          author: { type: "engine" },
          kind: "note",
          body: keptReason,
        });
      }
      // Every installed kind, not the item's own (EO-632): a reference
      // checkout is lent to an item whatever its own workspace is, and
      // goes when it settles even if it never had a worktree. By slug, as
      // the stale sweep does, so a kind is asked once.
      const lending = new Map<WorkspaceKindSlug, WorkspaceKind>([...coreKinds, ...kinds]);
      for (const kind of lending.values()) await kind.releaseReferenceCheckouts?.(item);
    } catch (error) {
      postComment(db, {
        itemId: item.id,
        author: { type: "engine" },
        kind: "note",
        body: `Could not release this ticket's workspace: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /** One entry into a workflow state is one initiation, even after review sends the item back. */
  function workflowInitiationId(item: Item, action: string): string {
    const entry = listTransitionsForItem(db, item.id)
      .filter((transition) => transition.toStepId === item.stepId)
      .at(-1);
    const latestRun = listRunsForItem(db, item.id)
      .filter((run) => !isGuardPlaceholder(run))
      .sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0) || left.id.localeCompare(right.id))
      .at(-1);
    // A failed dispatch is retried inside its existing initiation. A
    // later workflow transition (including returning from review) wins
    // and starts a new state-entry initiation instead.
    if (
      latestRun?.action === action &&
      latestRun.status === "failed" &&
      latestRun.initiationId &&
      (!entry || entry.ts < (latestRun.endedAt ?? latestRun.startedAt ?? 0))
    ) {
      return latestRun.initiationId;
    }
    // A newly created item has not transitioned yet. Its initial state
    // still needs one stable cycle id across automatic retries.
    return entry?.id ?? `initial:${item.id}:${item.stepId}`;
  }

  /** Guard placeholders record a refusal, not an attempt. */
  function countAttempts(itemId: Uuid, initiationId: string): number {
    // An interrupted run is not an attempt (`RunInterruption`): the
    // agent did nothing wrong, and the run that carries it on takes the
    // same attempt number.
    // Nor is a run that ran out of memory (EO-738): it parked for a
    // person rather than being retried, and what it hit was the machine's
    // limit, not the agent's work.
    return listRunsForItem(db, itemId).filter(
      (run) => run.initiationId === initiationId && !isGuardPlaceholder(run) && run.interruption === null && !isOutOfMemoryStop(run.error),
    ).length;
  }

  /** How often this initiation has been cut short without failing — see `MAX_INTERRUPTIONS_PER_INITIATION`. */
  function countInterruptions(itemId: Uuid, initiationId: string | null): number {
    if (initiationId === null) return 0;
    return listRunsForItem(db, itemId).filter((run) => run.initiationId === initiationId && run.interruption !== null).length;
  }

  function alreadyRefused(itemId: Uuid, initiationId: string): boolean {
    return listRunsForItem(db, itemId).some(
      (run) => run.initiationId === initiationId && isGuardPlaceholder(run),
    );
  }

  /**
   * A-02's validation pipeline for one agent result: the action's zod
   * schema first, then the checks zod can't express.
   *
   * The refine graph is the only such case today, and it has to run
   * before any item is created — a dangling index or a cycle would
   * otherwise deadlock the scheduler or leave a half-built DAG behind
   * (ARCHITECTURE.md, "Transitions").
   *
   * The item, rather than anything taken off it, because two things
   * about it decide what its result is held to: its type, because
   * `refine` is two different actions wearing one name (KAN-19) and the
   * type is what says which this is (KAN-163) — only a decomposition has
   * a graph to check; and its project, because `intake`'s shape is
   * composed from that project's item types (KAN-147). Both come off the
   * item, so no caller can pass one that disagrees with the other.
   */
  function validateResult(
    item: Item,
    action: string,
    raw: unknown,
    role: string | null,
  ): { ok: true; clarification: ClarificationRequired } | { ok: true; value: unknown } | { ok: false; error: string } {
    // Checked first, and against the raw result (KAN-29). An agent
    // saying it is blocked is deliberately nothing like the shape the
    // action would otherwise return, so validating it against that
    // schema would call it malformed — and being blocked is not a
    // malformed answer, it is a different one.
    const clarification = asClarification(raw);
    if (clarification) return { ok: true, clarification };

    const registry = registryFor(item);
    const type = typeOf(item);
    const parsed = validateActionResult(registry, action, raw, type, role);
    if (!parsed.ok) return parsed;

    // A graph to check is a property of the *shape* that was demanded,
    // not of the action or of the kind of item (KAN-163): a
    // decomposition answers with children that depend on one another, and
    // a clarification — or whatever third shape a pack's type names for
    // its own `refine` — has nothing to walk.
    if (actionSchemaName(registry, action, type, role) === REFINE_ACTION) {
      const graph = validateRefineGraph(refineChildren(parsed.value));
      if (!graph.ok) {
        return {
          ok: false,
          error: `The children parsed, but their dependency graph is invalid:\n${graph.error}`,
        };
      }
    }

    // A scenario turn reporting on a test case is held to the stored run
    // of that case (EO-356): a failure has to arrive with its evidence
    // and a question for the person, and a report about a case nobody
    // ran is not a report. A schema cannot see the run, so this is where
    // it is checked — and a turn that falls short is re-prompted with
    // what is missing, as one that fails its schema is.
    if (action === SCENARIO_ACTION) {
      const problem = scenarioResultProblem(db, item, parsed.value);
      if (problem !== null) return { ok: false, error: problem };
    }

    // A draft's proposed action definitions are held to the save's
    // rules before the reply is accepted (EO-426). The schema has asked
    // every rule that is about the definition alone; the one that is
    // about this installation — a pack's own role redefining the action
    // that pack ships for it — needs the registry, so it is asked here,
    // and the agent is re-prompted with the reason while its turn is
    // still open rather than told through a rejection in the thread
    // after the run has succeeded.
    if (action === ASSIST_ACTION) {
      const problem = proposedActionsProblem(registry, parsed.value);
      if (problem !== null) return { ok: false, error: problem };
    }

    // A proposal naming a pipeline its conversation's project does not
    // have is sent back while the turn is open (EO-440), and so is one
    // naming none on a project with more than one (EO-441), rather than
    // posted as a card that is refused only once a person presses
    // Create. The resolver is approval's own, so this cannot refuse a
    // value approval would accept, or let through one it would refuse.
    if (action === ASSIST_ACTION) {
      const problem = proposedPipelineProblem(db, item.projectId, parsed.value);
      if (problem !== null) return { ok: false, error: problem };
    }

    return parsed;
  }

  /**
   * Whether the person whose item this is has spent their organisation's
   * daily allowance (EO-328, ARCHITECTURE.md, "Policy", review).
   *
   * **The figure is the record's**, which is the whole of what the
   * review corrected. The design's budget is per *person*, and a person has
   * more than one machine: a device that summed its own rows gave each
   * of Anna's desktops the whole ceiling, and a replica mid-sync
   * answered with a fraction of the real spend and let work through on
   * it. So the question goes to whoever owns the answer — over the wire
   * on a signed-in desktop, out of this database on a solo one, where
   * the two sets of rows are the same rows.
   *
   * **The larger of the two readings wins**, and that is not belt and
   * braces. Each is incomplete in a different direction: the record has
   * not yet been told about the run this device finished a second ago
   * (results ship on the tick), and this replica has never been told
   * about the other desktop's at all. Whichever is higher is the closer
   * of the two to the truth, and being closer to the truth on a ceiling
   * means erring towards enforcing it.
   *
   * Combined through `personBudgetAcross`, which is core's and is what
   * `policy:get` draws the top-bar line from. One function because the
   * two have to agree: a person watching "$0 of $10" while this guard
   * refuses their work has no way to tell which of the two is lying.
   *
   * By the item's **owner** rather than by whoever this machine signed
   * in as. An item on a project somebody kept local has no owner on the
   * record and no organisation ceiling to be under — which is the same
   * answer the design gives, since the budget is a thing an organisation
   * publishes and a kept project is not theirs.
   */
  async function personDayOverspent(db: Db, policy: OrganisationPolicy, item: Item): Promise<PersonBudget | null> {
    const budgetCents = policy.perPersonDailyBudgetCents;
    if (budgetCents === null) return null;
    const personId = ownerOfItem(db, item.id);
    if (personId === null) return null;

    const since = startOfDay(now());
    // Nought when the record could not be reached, which leaves the
    // replica's own figure standing: a ceiling nobody can verify must
    // not stop a person working (ARCHITECTURE.md, "The record").
    const onTheRecord = await record.personSpendToday(personId, since);
    const budget = personBudgetAcross(budgetCents, [onTheRecord, personCostCentsSince(db, personId, since)]);
    return overPersonBudget(budget) ? budget : null;
  }

  /**
   * What a run may still spend, in cents: the least of what the item's
   * budget and the day's have left, or null where neither is set.
   * Handed to the backend as the turn's own cap (`budgetCents`).
   *
   * Read from runs that each record their own spend, a resumed one
   * included (EO-490) — before that, every resumed run's row held the
   * whole thread's, and this left a turn on an item that had been round
   * the review loop a fraction of what it really had. The cap is not
   * raised on a resumed turn: Claude's CLI holds `maxBudgetUsd` to what
   * the process itself spends, not to the session cost it restored on
   * resume (`claude.ts`, where the cap is set).
   */
  function remainingBudgetCents(itemId: Uuid): number | null {
    const guards = readGuards();
    let remaining: number | null = null;
    if (guards.perItemBudgetCents != null) remaining = guards.perItemBudgetCents - sumCostCentsForItem(db, itemId);
    if (guards.dailyBudgetCents != null) {
      const today = guards.dailyBudgetCents - sumCostCentsSince(db, startOfDay(now()));
      remaining = remaining === null ? today : Math.min(remaining, today);
    }
    return remaining === null ? null : Math.max(0, remaining);
  }

  /** Why a run the backend stopped at its cap ended, when the figures EO holds do not yet say a budget is spent. */
  function budgetStopReason(): string {
    return "Stopped at what this run was allowed to spend — the item's budget or the day's — before the turn could go past it. Raise the budget on the Guardrails screen to let it go on.";
  }

  /** Returns the reason a budget guard trips, or null if both are within budget (or unconfigured). */
  function checkBudgetGuard(itemId: Uuid): string | null {
    const guards = readGuards();
    if (guards.perItemBudgetCents != null) {
      const spent = sumCostCentsForItem(db, itemId);
      if (spent >= guards.perItemBudgetCents) {
        return `Per-ticket cost budget of ${guards.perItemBudgetCents}¢ reached (spent ${spent}¢ so far). Stopping — raise the per-ticket budget on the Guardrails screen to let it go on.`;
      }
    }
    if (guards.dailyBudgetCents != null) {
      const spent = sumCostCentsSince(db, startOfDay(now()));
      if (spent >= guards.dailyBudgetCents) {
        return `Daily cost budget of ${guards.dailyBudgetCents}¢ reached across all tickets (spent ${spent}¢ today). Stopping until tomorrow, or until the daily budget is raised on the Guardrails screen.`;
      }
    }
    return null;
  }

  /**
   * Consumes one stream (from either start() or resume()) up to its next
   * terminal moment: a blocking comment posted over the agent write
   * bridge, a result, an error event, or the stream simply ending — each
   * an outcome for the caller to act on.
   *
   * It writes nothing the agent asked for (ARCHITECTURE.md §13.1). What
   * an agent writes reaches EO over the bridge (`handleAgentWrite`) while
   * its turn is registered here, and a `tool_call` or `tool_result` is
   * recorded as what the agent did and nothing more —
   * `agentWriteBoundary.test.ts` holds this file to that.
   */
  /**
   * A run's skill usage, as run events (EO-715).
   *
   * `skills_delivered` once per run: the first report names what the run
   * was given — slugs the adapter delivered, resolved to the ids of the
   * agent's skills in the run's scope — and a later turn of the same run
   * (a correction, a resume) is the same run given the same skills.
   * `skill_loaded` once per skill per run, and only for a skill the run
   * was given: a load of anything else records nothing.
   */
  function recordSkillUsage(runId: Uuid, buffer: RunEventBuffer, item: Item, agent: Agent, event: SkillsOfferedEvent | SkillLoadAgentEvent): void {
    if (event.type === "skills_delivered") {
      if (runSkills.has(runId)) return;
      const scoped = deliverableSkills(resolveAgentAttachmentsForRun(db, agent.id, skillRunScope(db, item)).skills);
      const bySlug = new Map<string, string>();
      for (const slug of event.slugs) {
        const skill = scoped.find((candidate) => candidate.slug === slug);
        if (skill !== undefined) bySlug.set(slug, skill.id);
      }
      runSkills.set(runId, { bySlug, loaded: new Set() });
      if (bySlug.size === 0) return;
      const delivered: SkillsDeliveredEvent = { type: SKILLS_DELIVERED_EVENT, skillIds: [...bySlug.values()], slugs: [...bySlug.keys()] };
      buffer.append(runId, SKILLS_DELIVERED_EVENT, delivered);
      return;
    }
    const given = runSkills.get(runId);
    const skillId = given?.bySlug.get(event.slug);
    if (given === undefined || skillId === undefined || given.loaded.has(skillId)) return;
    given.loaded.add(skillId);
    const loaded: SkillLoadedEvent = { type: SKILL_LOADED_EVENT, skillId, slug: event.slug };
    buffer.append(runId, SKILL_LOADED_EVENT, loaded);
  }

  /**
   * Closes a run's skill usage (EO-720): one `skills_settled` event, after
   * every `skill_loaded` this run could write, for a run that was given
   * any. Only a settled run counts towards a skill's stretch without a
   * load, and the organisation's record runs its archival pass when one
   * arrives — by then every load of the run has, since a transcript
   * reaches it in order. Through the run's buffer where it still has one,
   * for `recordSent`'s reason.
   */
  function settleSkillUsage(runId: Uuid): void {
    const given = runSkills.get(runId);
    if (given === undefined || given.bySlug.size === 0) return;
    const settled: SkillsSettledEvent = { type: SKILLS_SETTLED_EVENT };
    try {
      const buffer = activeEventBuffers.get(runId);
      if (buffer) {
        buffer.append(runId, SKILLS_SETTLED_EVENT, settled);
        buffer.flush();
      } else {
        record.appendRunEvent(runId, SKILLS_SETTLED_EVENT, settled);
      }
    } catch (error) {
      console.warn(`[eo] the end of run ${runId}'s skill usage could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Settles every run this installation ran and finished that has not
   * settled (EO-720, `ownRunsToSettle`): those recorded before
   * `skills_settled` existed, and those whose process died before
   * `settleSkillUsage` could write it. Not a run being driven now — its
   * own end settles it. On reconciling, so an upgraded installation counts
   * its earlier runs at once, and before each archival pass. The events
   * reach the record like any other line of the run.
   */
  function settleOwnSkillUsage(): void {
    try {
      for (const runId of ownRunsToSettle(db)) {
        if (drivenRuns.has(runId)) continue;
        const settled: SkillsSettledEvent = { type: SKILLS_SETTLED_EVENT };
        record.appendRunEvent(runId, SKILLS_SETTLED_EVENT, settled);
      }
    } catch (error) {
      console.warn(`[eo] runs that ended without settling their skill usage could not be settled: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function processStream(
    stream: InterruptibleStream<AgentEvent>,
    ctx: {
      /** The run's own: once it is aborted, a backend that does not end its turn is not waited on for long (`untilStopped`). */
      signal: AbortSignal;
      runId: Uuid;
      buffer: RunEventBuffer;
      item: Item;
      agent: Agent;
      /** Which action's outcome shape a message would have to match to end this run (#144). */
      action: string;
      /** What this turn was actually given, not what the catalogue says now (EO-107). */
      expectedServers: string[];
      /** Where this run may attach files from, as its turns were told — null when it has nowhere (EO-412). */
      attachFrom: AttachmentSource | null;
      onThreadId: (threadId: string) => void;
      onUsage: (usage: UsageEvent) => void;
      /**
       * Every reading of the backend's own allowance (EO-172).
       *
       * All of them, not only the refusals: a window that has *stopped*
       * refusing is no longer holding the work up, and the tracker can
       * only forget it if it is told.
       */
      onQuota: (quota: QuotaEvent) => void;
      pushEvent: (event: AgentEvent) => void;
    },
  ): Promise<StreamOutcome> {
    // Set once the agent has escalated. From then on the loop is only
    // draining what the backend says on its way out — see below.
    let escalated = false;
    // A wind-down is short. Bounding it means a backend that ignores
    // `interrupt` and keeps working cannot hold this run open: without
    // the cap the drain would last as long as the agent felt like
    // going, which is what invariant 9 forbids and what the wall-clock
    // guard would eventually notice minutes later.
    let remainingDrain = MAX_DRAIN_EVENTS;
    // The last thing the agent said that could be an answer (#141). One
    // string, replaced rather than accumulated: a long turn's output is
    // already in `run_events`, and holding all of it here for the life
    // of the run to re-read a few hundred bytes at the end would be a
    // second copy of the transcript in memory.
    //
    // "Last" is meant strictly (#144). Anything the agent goes on to do
    // clears this, so what survives to the end of the stream is the
    // agent's final word and not merely the most recent thing it said
    // that happened to parse — see `superseded` below.
    let finalText: string | null = null;
    // Said once per run. An agent that reports progress in the outcome
    // shape does it on every turn, and forty identical notes in a thread
    // is not visibility, it is a thread nobody opens.
    let progressReported = false;

    /**
     * The agent has acted again, so whatever it last said was not its
     * final word (#144).
     *
     * This is the whole of the fix. #141 taught the loop to accept a
     * terminal payload the provider never announced, by keeping the last
     * message that parsed as JSON and promoting it once the stream ends.
     * What that cannot see is *when* the message was sent: an implementer
     * that opens with `{"outcome":{"branch":"in_progress",…}}` and then
     * works for an hour leaves that payload standing as long as nothing
     * it says afterwards is JSON — so the run finalises on a progress
     * update, the branch in `runs.result` is a sentinel, "Work in
     * progress." is posted as the implementer's handoff, and the item
     * routes to Review having shipped nothing.
     *
     * A terminal outcome is the last thing an agent says. So a further
     * message, tool call or file edit retires the candidate outright.
     * Usage, quota and server-status events do not: those are the
     * backend's bookkeeping rather than the agent speaking, and a turn
     * that ends with the trailing usage event #141 describes is exactly
     * the case that must still work.
     *
     * Invariant #8: a payload dropped here is said out loud on the
     * item, so an agent using the wrong shape is visible rather than
     * silently tolerated — by `reportDroppedOutcome`, once this stream
     * has been read, rather than here: what an agent does is recorded as
     * it happens and acted on by nothing (ARCHITECTURE.md §13.1).
     */
    let droppedOutcome: string | null = null;
    const superseded = (): void => {
      if (finalText === null) return;
      const dropped = finalText;
      finalText = null;
      if (progressReported) return;
      // Only worth a word if it would actually have ended the run. An
      // agent narrating in JSON for its own reasons is not making this
      // mistake, and telling it off for one it did not make is noise.
      if (!validateResult(ctx.item, ctx.action, dropped, definingRole(ctx.item, ctx.agent)).ok) return;
      progressReported = true;
      droppedOutcome = dropped;
    };

    /** Says on the item what `superseded` dropped, if anything. Called once the stream has been read. */
    const reportDroppedOutcome = (): void => {
      if (droppedOutcome === null) return;
      const dropped = droppedOutcome;
      droppedOutcome = null;
      postComment(db, {
        itemId: ctx.item.id,
        runId: ctx.runId,
        author: { type: "engine" },
        kind: "note",
        body:
          `${ctx.agent.name} sent a complete "${ctx.action}" outcome and then carried on working, so EO has read it as a ` +
          `progress update rather than as an answer and has not acted on it. Nothing in it has been recorded as this ` +
          `ticket's branch or as what this run produced.\n\n` +
          "```json\n" +
          `${excerpt(dropped)}\n` +
          "```\n\n" +
          `A terminal outcome is the *last* thing an agent says; this run will still end on whatever ${ctx.agent.name} ` +
          `says last. To report progress mid-run, write it as ordinary prose or post a comment — an outcome emitted ` +
          `mid-flight would otherwise finish the run on values that were never final.`,
      });
    };

    // A new turn of the run: whatever calls the last one left open — a
    // stream given up on for a correction, before its results came —
    // are not this one's (`runActivity`).
    const activity = runActivity.get(ctx.runId);
    activity?.openCalls.clear();

    // This turn, as the agent write bridge finds it (EO-543): what an
    // agent's write is made as while it is being read. `end` is a
    // blocking comment having been posted over the bridge, which ends
    // the turn — the reader is woken by it rather than by anything the
    // backend goes on to say about the call (ARCHITECTURE.md §13.1).
    let wake: () => void = () => undefined;
    const turnEnded = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const live: LiveTurn = {
      item: ctx.item,
      agent: ctx.agent,
      attachFrom: ctx.attachFrom,
      ended: false,
      end: () => {
        live.ended = true;
        wake();
      },
    };
    liveTurns.set(ctx.runId, live);

    try {
      for await (const step of untilTurnEnded(untilStopped(stream, ctx.signal), turnEnded)) {
        // The agent posted a blocking comment over the bridge (EO-543):
        // its run ends here, awaiting the people it mentioned
        // (invariant 9). The turn is over — but walking away now costs
        // the run its tokens and its cost, which the Claude SDK reports
        // only at the end of a turn (KAN-24), so a backend that can be
        // interrupted is, and drained for its accounting. One that
        // cannot is abandoned: draining it would mean waiting for the
        // agent to finish on its own, holding a subprocess open for a run
        // that has already ended.
        if (step === TURN_ENDED) {
          if (escalated) continue;
          if (!stream.interrupt) return { kind: "escalated" };
          await stream.interrupt();
          escalated = true;
          continue;
        }
        const event = step;
        // Everything the backend says is a sign it is alive — what the
        // inactivity guard reads — and a heartbeat is nothing else: it is
        // neither stored nor shown.
        noteActivity(ctx.runId, event);
        if (event.type === "heartbeat") continue;
        // A backend objects to being cut short: the Claude SDK ends an
        // interrupted turn with `error_during_execution`. Recording that
        // as an `error` made a transcript for a perfectly good plan-mode
        // proposal read as a failed run, every time (KAN-26).
        //
        // The words are kept verbatim in the payload — nothing about a
        // provider's own output is dropped. Only the classification
        // changes, and only for the tail after *we* interrupted, so a
        // genuine mid-run error is still an error.
        // The words of a block as they are written: shown to whoever is
        // watching and never stored (`OutputDeltaEvent`). The block they
        // belong to arrives whole a moment later, and that is the record.
        if (event.type === "output_delta") {
          liveDrafts.append(ctx.runId, ctx.item.id, event.stream, event.text);
          continue;
        }
        // What the adapter says about EO's skills (EO-715) is recorded as
        // the run's own events, with the skills' ids, rather than as it
        // came: a load is held to what the run was given.
        if (event.type === "skills_delivered" || event.type === "skill_loaded") {
          recordSkillUsage(ctx.runId, ctx.buffer, ctx.item, ctx.agent, event);
          continue;
        }
        const seq = ctx.buffer.append(ctx.runId, escalated && event.type === "error" ? WIND_DOWN_EVENT : event.type, event);
        // A finished block ends the draft that was showing it, which the
        // view goes on drawing until this row is in the database.
        // Which draft is decided by the stream it was written on: a
        // message or the answer's tool call finishes a text block, a
        // reasoning event a reasoning one, and an error whatever was
        // being written.
        if (event.type === "output" || event.type === "tool_call") liveDrafts.settle(ctx.runId, seq, "text");
        else if (event.type === "reasoning") liveDrafts.settle(ctx.runId, seq, "reasoning");
        else if (event.type === "error") liveDrafts.settle(ctx.runId, seq, null);
        ctx.pushEvent(event);

        // Past the escalation the run's fate is decided; the only reason
        // to still be here is the accounting (KAN-24). Everything else is
        // recorded above and then ignored, so a parting comment cannot
        // re-decide a run that has already ended.
        if (escalated) {
          if (event.type === "usage") ctx.onUsage(event);
          if (--remainingDrain <= 0) return { kind: "escalated" };
          continue;
        }

        if (event.type === "thread_started") {
          ctx.onThreadId(event.threadId);
          continue;
        }

        // The conversation was compacted, and with it the brief the run
        // was seeded with (`CompactedEvent`): restated now, into the turn
        // that is running, so the agent carries on knowing what it is
        // working on — and recorded, because what EO tells an agent is
        // part of the run. A conversation is its own brief, and is left
        // as it is.
        if (event.type === "compacted") {
          // Once per stretch of work: a compaction straight after a
          // reminder, before the agent has done anything with it, is the
          // reminder and its answer filling a window that was already
          // full — restating it again would only fill it again.
          const activity = runActivity.get(ctx.runId);
          const earned = (activity?.callsSinceReminder ?? 1) > 0;
          if (!isManualAction(ctx.action) && earned) {
            if (activity) activity.callsSinceReminder = 0;
            const reminder = restatedBrief(ctx.item);
            // Recorded with whether it got through, as a person's message
            // to a running agent is (`HUMAN_MESSAGE_EVENT`): a turn that
            // was already over, or a backend with no way in, refuses it.
            //
            // Not awaited here. A Codex steer is answered over the same
            // pipe this loop drains, so waiting on it in the loop waits for
            // ever; it is recorded when it settles instead, and flushed then,
            // because the run may have ended and stopped flushing by then.
            const record = (delivered: boolean): void => {
              ctx.buffer.append(ctx.runId, "reminder", { type: "reminder", text: reminder, delivered });
              ctx.buffer.flush();
            };
            void Promise.resolve(stream.steer?.(reminder)).then(
              (taken) => record(taken === true),
              () => record(false),
            );
          }
          continue;
        }

        // The backend has said which of its MCP servers came up. EO
        // attached some of them, and this is where it finds out whether
        // it got what the catalogue screen says it got (EO-107,
        // invariant #5) rather than assuming a directory it wrote is a
        // server that started.
        //
        // A comment and not a failure. A run whose GitHub server did not
        // start can still do most of its work, and killing it would
        // trade a degraded run for no run at all — but nothing may drop
        // it on the floor either (invariant #8), so it lands in the
        // thread where the person who attached it will read it.
        if (event.type === "server_status") {
          const missing = attachedServersMissing(ctx.expectedServers, event.servers);
          if (missing.length > 0) {
            postComment(db, {
              itemId: ctx.item.id,
              runId: ctx.runId,
              author: { type: "engine" },
              kind: "note",
              body:
                `${ctx.agent.name} was given ${missing.length === 1 ? "an MCP server that did not start" : `${missing.length} MCP servers that did not start`}, and is running without ` +
                `${missing.length === 1 ? "it" : "them"}:\n\n${missing.map((server) => `- **${server.name}** — ${server.detail}`).join("\n")}\n\n` +
                "Check the server's command or URL on the Servers screen, and whether every secret it declares has a value.",
            });
          }
          continue;
        }

        // The agent is working, so it has not finished (#144). Whatever
        // it said before this was a progress report, whatever shape it
        // wore, and must not survive to be read as the run's answer.
        if (event.type === "tool_call" || event.type === "file_edit") superseded();

        // Remembered, not acted on. A turn's prose is not a result and
        // never becomes one here — but a turn that ends without a
        // `result` event may still have *said* its answer, and this is
        // the only place that sentence exists (#141).
        //
        // Only text that parses as JSON is kept, so narration and
        // reasoning can never be mistaken for an answer, and the last
        // such message wins. Codex's reasoning used to arrive through the
        // same `output` event as its agent message; it is a `reasoning`
        // event now and never reaches here.
        //
        // Every message retires the one before it, including a plain
        // prose one (#144). An agent that answers and then keeps talking
        // has not answered yet, and leaving the earlier payload standing
        // is what let a run finalise on its opening progress update.
        //
        // …unless the shape was never the agent's to choose (EO-199). A
        // backend handed a turn-level schema returns every message in the
        // answer's shape, so "it parses" stops being evidence and this
        // test would promote a preamble — which is what it did, on every
        // review EO ran against Codex. A backend that says so also names
        // its answer outright in a `result` event, so there is nothing
        // here for the fallback to recover and no reading of the shape
        // that could beat the adapter's own account.
        //
        // `superseded()` is called either way and is unchanged. It still
        // has a candidate to drop wherever a candidate could exist, and
        // the case it was written for — an agent that emits a terminal
        // outcome by choice and then carries on — is untouched. What it
        // no longer does is announce a mistake nobody made.
        if (event.type === "output") {
          superseded();
          if (!event.schemaConstrained && typeof parseIfFenced(event.text) !== "string") finalText = event.text;
          continue;
        }

        if (event.type === "usage") {
          ctx.onUsage(event);
          // Recorded above whoever's it is: the system agent's spend still
          // counts in the totals and can still stop other agents' work.
          const guardReason = isSystemAgent(ctx.agent) ? null : checkBudgetGuard(ctx.item.id);
          if (guardReason) {
            return { kind: "guardTripped", reason: guardReason };
          }
          continue;
        }

        // The backend has said how much of its own allowance is left, and
        // — the part that matters — whether it is still answering
        // (EO-172). A refusal is remembered rather than acted on here:
        // the turn it interrupted may still say something usable on its
        // way out, and a run that finishes anyway is not a run stopped by
        // a limit. What it changes is what happens to a turn that *does*
        // end badly, which `runToCompletion` decides.
        //
        // Passed on whatever the status says. Deciding which readings
        // matter is the tracker's job, and it needs the ones that are not
        // refusals to know when a window has come back.
        if (event.type === "quota") {
          ctx.onQuota(event);
          continue;
        }

        if (event.type === "result") {
          return { kind: "result", data: event.data };
        }
        // A warning the backend raised without ending its turn (EO-369)
        // has been recorded above and is nothing more: the turn carries
        // on, and the run ends on what it ends on.
        // The backend stopped the turn at the budget EO gave it
        // (`budgetCents`): the budget guard tripping, during the turn
        // rather than after it, and ended as that guard ends a run.
        if (event.type === "error" && event.budget) {
          return { kind: "guardTripped", reason: checkBudgetGuard(ctx.item.id) ?? budgetStopReason() };
        }
        if (event.type === "error" && event.fatal !== false) {
          return { kind: "error", message: event.message, retryable: event.retryable };
        }
      }
    } catch (error) {
      // Cutting a turn short is not a graceful thing to do to a
      // backend, and the Claude SDK objects: after `interrupt()` it
      // emits `error_during_execution` and then throws. That throw is
      // the expected end of a wind-down, not a failed run — letting it
      // escape turned a parked escalation into a failure, and then into
      // a retry of work a human was already being asked about.
      //
      // Only swallowed when the interrupt was ours. Anything thrown
      // before that is a real failure and still propagates.
      //
      // Except a turn EO itself declined to open (EO-386), which is not
      // a failure of anything: no backend was reached, and the reason is
      // the workspace's to give.
      if (error instanceof TurnRefused) return { kind: "guardTripped", reason: error.message };
      // A turn whose process could not be confirmed gone (EO-493) is never
      // part of a wind-down, whatever came before it: it ends the run.
      if (isTurnNotEnded(error)) throw error;
      if (!escalated) throw error;
    } finally {
      if (liveTurns.get(ctx.runId) === live) liveTurns.delete(ctx.runId);
      try {
        reportDroppedOutcome();
      } catch (error) {
        console.warn(`[eo] the outcome run ${ctx.runId} sent mid-flight could not be reported: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return escalated ? { kind: "escalated" } : { kind: "ended", finalText };
  }

  /**
   * Runs a stream (from start() or resume()) to a terminal DB state,
   * persisting events and throttling the renderer push. The supervisor decides transitions here — never the agent
   * (ARCHITECTURE.md, "Transitions"): the only call that can move items.stepId is
   * transitionItem(), below.
   */
  /**
   * What the item's workspace has to say about this run (G-02,
   * invariant 5, EO-295, EO-297).
   *
   * Three hooks until EO-295, called at three different moments and
   * each with its own idea of what "checked" meant: the mechanical
   * verification of an implementation, whether a plan-mode run had left
   * its worktree alone, and whether a file on the branch had been copied
   * out of another item's unmerged work. They are the kind's verifier
   * for `implement` now, and which actions a kind can vouch for at all
   * is a table it publishes — the supervisor asks and reports, and knows
   * nothing about git either way.
   *
   * **Asked on every path a run ends on**, which is EO-297's half: an
   * agent's claim, a builtin's, and a module's. A module step on a folder
   * claiming it wrote a report went unchecked until this story, not
   * because nothing could check it but because only the agent path ever
   * asked.
   *
   * Nothing to check where the run recorded no directory, which is the
   * same silence the two guards kept: a run without one never reached a
   * workspace to have done anything in.
   */
  async function checkWorkspace(
    run: { id: Uuid; cwd?: string | null },
    item: Item,
    action: string,
    result: unknown,
    ended: VerifiableRun["ended"],
    /** The dispatched agent's role, or null where EO ran the step itself — what says whose action this was (EO-422). */
    role: string | null,
  ): Promise<readonly Check[]> {
    const workspace = workspaceOfRun(item, run);
    if (workspace === null) return [];
    return verifyRun(kindFor(item), item, { id: run.id, action, packAction: packMeaningInForce(db, item, role, action), workspace, result, ended });
  }

  /**
   * Where a failed check sends its item, when the pipeline says
   * (EO-297).
   *
   * `verification_failed` is a result key like any other in the routing
   * table, and unlike any other in where it comes from: nothing that
   * *runs* declares it. An agent's verdict cannot report it — the whole
   * point is that the agent said the opposite — and no manifest lists
   * it. The workspace kind is what contributes it, which is why this
   * asks the kind whether it has a verifier for the action before
   * reading the graph at all: a route declared on a step whose kind
   * checks nothing is wiring for a branch that can never be taken, and
   * taking it would be worse than ignoring it.
   *
   * Null when no route declares it, and the park-and-escalate each path
   * already did holds. Null too for a route that points back at the step
   * it left, on the builtin path's reasoning: a module has no attempt
   * cap, so re-running it against exactly what just failed verification
   * is a loop that closes on the next tick.
   */
  function verificationRoute(item: Item, action: string, step: PipelineStep | undefined): NextStepDestination | null {
    if (step === undefined || !verifies(kindFor(item), action)) return null;
    const destination = routeOnResult(item, step, VERIFICATION_FAILED_RESULT);
    return destination === null || destination.stepId === step.id ? null : destination;
  }

  /**
   * What a set of checks says, as a person would read it (invariant 5:
   * "say what you checked").
   *
   * Every check, not only the one that failed. A verification that says
   * "the tests did not run" has said nothing about whether there were
   * commits to run them against, and a person reading a parked item
   * wants the whole of what was looked at — which is also what the
   * column head will be assembled from in phase 6.
   */
  function describeChecks(checks: readonly Check[]): string {
    return checks.map((check) => `- ${check.passed ? "Passed" : "Failed"}: ${check.describes}`).join("\n");
  }

  /**
   * The files among a run's artifacts, copied into EO's attachment
   * store (EO-299).
   *
   * A file artifact names a path in the workspace rather than carrying
   * its bytes, because the things a folder or a scratch run produces
   * are documents: a `.docx` read through a JavaScript string is a
   * corrupt `.docx`, and a comment body is text. So the copy happens
   * here, where the bytes go into the same managed store every other
   * attachment on the item lives in, and the record that comes back is
   * what the output comment hangs them off.
   *
   * **What could not be copied is said rather than dropped** (invariant
   * 8). A file too large for the store, or one that vanished between
   * the walk and the read, leaves the work where the run left it — and
   * `complete` is false, which is what stops the workspace being
   * released out from under it.
   */
  async function copyArtifactFiles(artifacts: readonly Artifact[]): Promise<{ records: Omit<CreateAttachmentRecord, "itemId" | "commentId">[]; notice: string; complete: boolean }> {
    const files = artifacts.filter((artifact) => artifact.path !== undefined);
    if (files.length === 0) return { records: [], notice: "", complete: true };

    const records: Omit<CreateAttachmentRecord, "itemId" | "commentId">[] = [];
    const refused: string[] = [];
    for (const file of files) {
      if (!artifactStore) {
        refused.push(`${file.name} — this installation has nowhere to keep it`);
        continue;
      }
      try {
        records.push(await artifactStore.storeImported({ name: file.name, mimeType: file.mediaType, data: await readFile(file.path as string) }));
      } catch (error) {
        refused.push(`${file.name} — ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const notice =
      refused.length === 0
        ? ""
        : `\n\nEO could not attach ${refused.length === 1 ? "one of these" : `${refused.length} of these`}, so ${refused.length === 1 ? "it is" : "they are"} still where the run left ${refused.length === 1 ? "it" : "them"}:\n\n${refused.map((line) => `- ${line}`).join("\n")}`;
    return { records, notice, complete: refused.length === 0 };
  }

  /**
   * What the run produced, posted as the item's output (EO-298,
   * ARCHITECTURE.md, "The output is a comment").
   *
   * A comment of kind `output` rather than a row of its own: an output
   * that carries files already had to hang on a comment, so a table
   * would have been a second communication channel beside the one
   * invariant 4 says is the only one. The kind decides what it has
   * produced and whether this run produced any of it — git answers with
   * the diff of an implement run and with nothing at all otherwise,
   * exactly as it decides for itself which checks an action deserves.
   *
   * Chained, not replaced. `postOutputComment` points the new comment at
   * the output it supersedes, so a second implement attempt's diff does
   * not erase the first one's — and when the editor arrives (phase 6),
   * a person's correction joins the same chain and becomes the current
   * one by the same rule.
   *
   * **Nothing here may fail a run that has already succeeded.** The work
   * is done, the checks passed, and the item is about to move; a
   * workspace that could not say what it produced is worth a sentence in
   * the thread (invariant 8) and is not worth throwing the work away
   * over.
   */
  async function postArtifacts(
    run: { id: Uuid; cwd?: string | null },
    item: Item,
    author: PostCommentInput["author"],
    action: string,
    result: unknown,
    ended: VerifiableRun["ended"],
    /** The dispatched agent's role, or null where EO ran the step itself — `checkWorkspace`'s, and for its reason (EO-422). */
    role: string | null,
  ): Promise<void> {
    // Where the run worked, from the row that records it — the agent
    // path writes `cwd` at dispatch and a builtin or a module writes it
    // as its runner prepares (EO-297), so one reading answers for every
    // path that reaches here. Null is a run that never prepared
    // anywhere, which has nothing anybody could gather.
    const workspace = workspaceOfRun(item, run);
    if (workspace === null) return;

    // The writing is inside the guard as well as the gathering. What
    // comes back here is a body of no bounded size, assembled and then
    // handed to SQLite, and either step can fail on one that is large
    // enough — a throw escaping into the success path above would leave
    // a run recorded as succeeded and an item that never transitioned,
    // which is a worse outcome than an output nobody got.
    try {
      const artifacts = await kindFor(item).artifacts(item, { id: run.id, action, packAction: packMeaningInForce(db, item, role, action), workspace, result, ended });
      if (artifacts.length === 0) return;
      // The files, copied into EO's own store before the comment they
      // will hang on exists (EO-299). A run on a folder or a scratch
      // workspace produces documents rather than text — and a scratch
      // directory is about to be removed — so a comment that only
      // *named* them would name files that are gone by the time anybody
      // clicks.
      const copied = await copyArtifactFiles(artifacts);
      postOutputComment(db, {
        itemId: item.id,
        // Authored by the run: whoever produced it — an agent, a module,
        // or EO itself for one of its own functions — and the run it was
        // produced during, which is what places the output at a step.
        //
        // A module's output is deliberately *not* signed in its body the
        // way `postModuleComment` signs a module's note (EO-75). That
        // signature is there because a remark in a thread needs a voice
        // and the body is the only part Jira receives; an output is the
        // deliverable, and a step that sends it would send the signature
        // along with it. Who produced it is on the row and on the run.
        runId: run.id,
        author,
        body: composeOutputBody(artifacts) + copied.notice,
        // An agent's diff can contain anything at all, `@someone`
        // included. Summoning a person out of a line of somebody else's
        // code is the back door `postAssistReply` closes for the
        // same reason.
        parseBodyMentions: false,
        ...(copied.records.length > 0 ? { attachmentRecords: copied.records } : {}),
      });

      // And now — and only now — the workspace may let go of what it was
      // holding. A scratch directory exists to hold one run's output;
      // once that output is a comment with the files on it, keeping the
      // directory would be keeping a second copy nobody will look at.
      //
      // Skipped when anything could not be copied, which is the one
      // state where deleting would lose the work: what is on disk is
      // then the only copy there is, and the sentence in the comment
      // above is what tells a person where to find it.
      if (copied.complete) {
        await kindFor(item)
          .release({ what: "collected", item, workspace })
          .catch((error: unknown) => {
            console.error(`[eo] could not release ${item.key}'s workspace after taking its output: ${error instanceof Error ? error.message : String(error)}`);
            return {};
          });
      }
    } catch (error) {
      postComment(db, {
        itemId: item.id,
        author: { type: "engine" },
        kind: "note",
        body: `EO could not record what this run produced, so this ticket has no output from it: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * The check that stops the run, if one of them does.
   *
   * Exactly `verifyRun`'s old verdict, derived rather than declared: a
   * failed check that blocks fails the run and keeps the item where it
   * is, and every other failed check is a note on work that stands.
   */
  function blockingFailure(checks: readonly Check[]): Check | undefined {
    return checks.find((check) => check.blocks === true && !check.passed);
  }

  /**
   * What the checks saw, for `runs.verification`.
   *
   * Merged over the checks that carry evidence, which today is the
   * mechanical verification alone — so the column holds exactly the
   * object it has always held. Undefined where nothing had anything to
   * record, so that a run is not given an empty verification it never
   * had.
   */
  /**
   * The checks themselves, for `runs.checks` (EO-312).
   *
   * Everything a reader needs and nothing the supervisor needed in the
   * moment: whether a failure blocked is on the run's own status,
   * whatever was posted is in the thread, and the evidence is in
   * `verification` beside this. What is left is the list the original design puts in the
   * sidebar — a mark and a sentence each, which is invariant 5's "say
   * what you checked" made readable after the fact rather than only at
   * the moment it mattered.
   *
   * An empty list is written as null: "nothing was checked" and "there
   * is nothing to show" are the same sentence to whoever reads it, and
   * the row that says neither is the honest one.
   */
  function keptChecks(checks: readonly Check[]): RunCheck[] | null {
    if (checks.length === 0) return null;
    return checks.map((check) => ({ key: check.key, passed: check.passed, describes: check.describes }));
  }

  function evidenceOf(checks: readonly Check[]): Record<string, unknown> | undefined {
    const carried = checks.filter((check) => check.evidence !== undefined);
    return carried.length === 0 ? undefined : Object.assign({}, ...carried.map((check) => check.evidence));
  }

  /**
   * What a failed check that does not block leaves in the thread
   * (invariant 8).
   *
   * A note, not a rejection: the work stands, the item moves, and what
   * was noticed is said on the item, where whoever reads it next will
   * meet it. Posted without a run id, exactly as the two guards this replaces
   * were — the sentence is about the item's branch rather than about the
   * conversation, and it reads as the item's own note.
   *
   * A blocking failure is the caller's to handle and is skipped here,
   * with one exception: a run that has already ended `awaiting_input`
   * has nothing left to block, so everything it failed is reported.
   */
  function postCheckNotes(item: Item, checks: readonly Check[], including: "all" | "reports" = "reports"): void {
    for (const check of checks) {
      if (check.passed) continue;
      if (including === "reports" && check.blocks === true) continue;
      postComment(db, {
        itemId: item.id,
        author: { type: "engine" },
        kind: "note",
        body: check.comment ?? check.describes,
      });
    }
  }

  /**
   * Did the implementer ever stop to propose on this item?
   *
   * A parked run is the evidence: plan mode works by escalating, which
   * ends the run `awaiting_input`, and the approved implementation then
   * arrives as a second run on the same thread. So one parked
   * `implement` run anywhere in this item's history means a human saw
   * a plan before the work landed.
   */
  function everProposed(itemId: Uuid, action: string): boolean {
    return listRunsForItem(db, itemId).some(
      (run) => run.action === action && run.status === "awaiting_input",
    );
  }

  /**
   * Plan mode's other failure, and the one the worktree guard cannot see
   * (KAN-25).
   *
   * The git kind's clean-tree check only runs when the implementer
   * escalated — it catches an agent that proposed *and* wrote, which is
   * the one thing a parked run can be wrong about. It is blind to the
   * agent that ignored the instruction outright, implemented the story
   * and returned a perfectly valid result: that run succeeds, the item
   * moves on, and a setting the user deliberately turned on was
   * overridden without a word.
   *
   * Which is the wrong way round. The guard exists because a prompt is a
   * request rather than a constraint, and that reasoning applies at
   * least as much to an agent that never planned at all.
   *
   * Reports rather than reverts, for the same reason the other one does:
   * the work is real and discarding it would be a second surprise. The
   * transition still happens — invariant 1 keeps state changes in one
   * place, and this is not a verification failure.
   */
  function reportPlanModeSkipped(item: Item, action: string, role: string | null): void {
    if (action !== "implement" || !item.projectId) return;
    // Plan mode is asked of the pack's `implement`. One the dispatched
    // role defined for itself was sent no plan-mode section (EO-422),
    // so it skipped nothing, and saying it did would be EO reporting a
    // broken instruction it never gave.
    if (!packMeaningInForce(db, item, role, action)) return;
    if (!stepForItem(db, item)?.planMode) return;
    if (everProposed(item.id, action)) return; // proposed, approved, then implemented — the intended path

    postComment(db, {
      itemId: item.id,
      author: { type: "engine" },
      body:
        `This project is in plan mode, so this ticket was meant to be proposed before anything changed — but this run implemented it directly and never stopped to ask.\n\n` +
        `Nothing has been discarded and the ticket has moved on. Review what landed with more care than usual: nobody approved the approach.`,
      kind: "note",
    });
  }

  /**
   * The conversation this run was continuing is not on the backend any
   * more (EO-93).
   *
   * A stored thread id is a claim about a file EO does not own — Claude
   * keeps sessions under `~/.claude`, Codex under `~/.codex/sessions` —
   * and either can be cleaned up between one dispatch and the next. The
   * provider has already translated its backend's wording into one typed
   * error; what is left is to stop believing in that thread, say so, and
   * do the work anyway.
   *
   * Three things, in that order:
   *
   * - **Write the thread off.** On the run that found it missing, beside
   *   the id it tried — not by nulling `thread_id`, which would describe
   *   a run that never had a thread. It is the marker `findReusableThread`
   *   reads, and without it the next dispatch finds the same dead id on
   *   the run before this one and fails exactly the same way, until the
   *   attempt limit refuses the item for a reason that has nothing to
   *   do with the work.
   * - **Say so once.** A provider error about a session id tells a person
   *   nothing; this says what was lost, that nothing else was, and what
   *   happens next (invariant #8). Only here — the fresh dispatch that
   *   follows reads a thread it was never offered, so it has nothing to
   *   add.
   * - **Carry on.** Same item, same action, same initiation, so the
   *   attempt guard still counts this and a genuinely broken backend
   *   still stops. The new dispatch assembles the full context, which is
   *   what makes the lost conversation cost tokens rather than work.
   *
   * `cancelled` rather than `failed`, for the reason `reconcile` marks an
   * interrupted run cancelled: the run did not fail at what it was asked
   * to do, it was abandoned before it could start and a successor is
   * carrying the work. A red run on the board would be about EO's
   * bookkeeping, not about this item.
   */
  async function carryOnWithoutTheThread(
    run: { id: Uuid; itemId: Uuid },
    item: Item,
    agent: Agent,
    action: string,
    deadThreadId: string,
    runOpts: { transitionOnSuccess?: boolean },
  ): Promise<void> {
    updateRun(db, run.id, {
      status: "cancelled",
      error:
        `The "${agent.provider}" backend had no conversation with session id "${deadThreadId}", so this run was ` +
        `abandoned and the work restarted on a fresh thread.`,
      endedAt: now(),
      // Kept, deliberately: the run really was handed this session and
      // really did try it. `threadLost` is what says it is gone.
      threadId: deadThreadId,
      threadLost: true,
    });
    postComment(db, {
      itemId: item.id,
      runId: run.id,
      author: { type: "engine" },
      kind: "note",
      body:
        `The conversation ${agent.name} had going on this ticket is no longer available on the "${agent.provider}" backend. ` +
        `Provider sessions live outside EO — under the backend's own directory — and can be cleaned up, which is what ` +
        `appears to have happened here.\n\n` +
        `Nothing is lost: this ticket is starting a fresh conversation, which is given the newest word from every step and everything you have said since, and can search the rest.`,
    });
    announceRun(run.id, item.id, "cancelled");

    // Read back rather than passed in: `run` is the narrow shape
    // `runToCompletion` works with, and the initiation is what keeps this
    // inside the attempt allowance the work already had.
    const initiationId = getRun(db, run.id)?.initiationId ?? undefined;
    await dispatchRun(item, agent, action, {
      ...(initiationId ? { initiationId } : {}),
      ...(runOpts.transitionOnSuccess !== undefined ? { transitionOnSuccess: runOpts.transitionOnSuccess } : {}),
      // This is the same piece of work, restarted on a fresh thread —
      // every caller of `runToCompletion` is already holding the item,
      // so asking for it again would have the work refuse itself
      // (EO-132).
      holdingItemLock: true,
    });
  }

  /**
   * Closes a run that is still `running` after the stream behind it has
   * gone (#141).
   *
   * The last thing between a stranded run and a board that lies. Every
   * branch of `driveToCompletion` writes a terminal status, and a run
   * was still found `running` with a null `endedAt` and no comment,
   * because "every branch" is only true of the branches: a throw after
   * the stream loop — a verification that blew up, a transition that
   * refused — leaves the function by a path that writes nothing, the
   * dispatch promise is settled and forgotten, and no in-process check
   * ever looks at a `running` run with no stream behind it again. Boot
   * reconcile is the only thing that would, and only after a restart.
   *
   * So the guarantee is made structurally rather than branch by branch:
   * whatever happens in there, a run whose driver has returned is not
   * left open. Recovery is a write to the run row and an appended
   * comment — `run_events` is append-only (invariant #3), and a
   * stranded stream is closed by saying so, never by tidying what it
   * already recorded.
   *
   * Silent about a run that ended properly, which is all of them.
   */
  function closeAbandonedRun(runId: Uuid, itemId: Uuid): void {
    const current = getRun(db, runId);
    if (current?.status !== "running") return;

    const reason =
      "This run's stream ended without finalising it, so EO closed the run rather than leave it open with " +
      "nothing behind it. Whatever the agent did has not been applied.";
    // What the run was actually talking to, where it got far enough to be
    // told. A terminal row that omits a session it demonstrably had is
    // the same missing fact that made this run unreadable while it was
    // stuck.
    const threadId = lastKnownThreadIds.get(runId);
    updateRun(db, runId, {
      status: "failed",
      error: reason,
      endedAt: now(),
      ...(threadId ? { threadId } : {}),
    });
    postRunFailure(itemId, runId, `${reason} ${whereTheItemStands(itemId)}`);
    announceRun(runId, itemId, "failed");
  }

  /**
   * Take hold of a run's cancellation from the moment its row says
   * `running`, rather than from the moment its backend starts (EO-151).
   *
   * `driveToCompletion` registers both of these at its top, and for most
   * of this file's life that was early enough: the row went `running`
   * and the driver was entered in the same synchronous block, so there
   * was no moment in between for anything to arrive.
   *
   * Resolving a repository query server put an `await` in that gap on
   * the two resume paths, and the gap is not theoretical — it reads a
   * row and asks a binary. A `cancelRun` landing in it found no
   * controller and returned having done *nothing*: not aborted, and not
   * even marked the row cancelled. EO would then go on to start the
   * backend, and its MCP server with it, for a run the person had
   * already stopped.
   *
   * So the claim moves to where the *row* is claimed. `driveToCompletion`
   * setting the same values again is a deliberate no-op — one that keeps
   * every other caller working exactly as it did.
   *
   * The restart intent travels with it, and that is not tidiness either:
   * `pause({ cancelRunning: true })` reads it to decide whether a run it
   * kills should be started again on resume, and a pause landing in the
   * gap would otherwise cancel a run that could never come back.
   */
  function claimRunControl(
    run: { id: Uuid; itemId: Uuid },
    agentId: Uuid,
    action: string,
    controller: AbortController,
    transitionOnSuccess: boolean,
  ): void {
    activeControllers.set(run.id, controller);
    activeRestartIntents.set(run.id, {
      cancelledRunId: run.id,
      itemId: run.itemId,
      agentId,
      action,
      transitionOnSuccess,
    });
  }

  /**
   * Let go of a claim whose run never reached a backend.
   *
   * Only ever reached when the claim was cancelled while the dispatch
   * was still being prepared. The run row is already terminal by then —
   * `cancelActiveRun` writes `cancelled` before it aborts — so there is
   * nothing to close here, only the two maps to leave clean. Left
   * behind, the controller would make `activeRunCount` overcount for the
   * life of the process and hold `shutdown` up on a run that never was.
   */
  function releaseRunControl(runId: Uuid): void {
    activeControllers.delete(runId);
    activeRestartIntents.delete(runId);
  }

  /**
   * Brings the item's index up to date before its work changes hands
   * (EO-153), and says so in the thread when it could not.
   *
   * **Nothing here may stop the transition.** Repository intelligence
   * degrades and never blocks (EO-141), and holding a person's item in
   * place because a cache did not refresh would be the wrong trade — so
   * a refusal becomes a comment and a throw becomes a comment, and the
   * caller moves the item either way. The seam is specified not to
   * throw; the catch is here because "specified not to" is not the same
   * as "cannot", and the cost of being wrong about that is a succeeded
   * run whose item silently never moves.
   *
   * The controller is held only for as long as the sync runs. It is
   * registered rather than merely created because a cancel arriving
   * mid-sync has to be able to find it — see `activeHandoverSyncs`.
   */
  async function syncIndexAtHandover(
    run: { id: Uuid; itemId: Uuid; cwd?: string | null },
    item: Item,
    attachment: WorkspaceAttachment,
  ): Promise<void> {
    // No directory and nothing lent, nothing to bring up to date. A run
    // that never had one is a conversational one, and a workspace that
    // lent nothing has nothing of its own to resync.
    if (!run.cwd || attachment.sync === undefined) return;

    const controller = new AbortController();
    activeHandoverSyncs.set(run.id, controller);
    try {
      const { notice } = await attachment.sync(controller.signal);
      if (notice !== null) postHandoverNotice(item.id, run.id, notice);
    } catch (error) {
      postHandoverNotice(
        item.id,
        run.id,
        `EO could not bring this ticket's repository index up to date before it moved on: ` +
          `${error instanceof Error ? error.message : String(error)}. The ticket moves on regardless, and the ` +
          `next run goes ahead with the filesystem and git tools every agent has always had.`,
      );
    } finally {
      activeHandoverSyncs.delete(run.id);
    }
  }

  /**
   * A note, not an escalation. Nothing is waiting on an answer — the
   * item has moved — and the point of saying it at all is that the
   * only other visible difference between "the index answered" and
   * "the index was out of date" is how much the next agent spends
   * finding its way around (invariant #8).
   */
  function postHandoverNotice(itemId: Uuid, runId: Uuid, body: string): void {
    postComment(db, { itemId, runId, author: { type: "engine" }, kind: "note", body });
  }

  /**
   * `driveToCompletion` with that guarantee attached. Every caller goes
   * through here; nothing calls the driver directly.
   */
  /** What a run's turns were opened with, beyond the item and the agent: `driveToCompletion`'s last argument. */
  type RunTurns = Parameters<typeof driveToCompletion>[7];

  async function runToCompletion(
    ...args: Parameters<typeof driveToCompletion>
  ): Promise<void> {
    const [run, item, agent] = args;
    // Held from before the row can turn terminal, so there is no moment
    // between the run ending and its extraction starting when its slot
    // is nobody's (EO-479).
    drivenRuns.set(run.id, item.id);
    try {
      try {
        await driveToCompletion(...args);
      } finally {
        closeAbandonedRun(run.id, item.id);
        lastKnownThreadIds.delete(run.id);
        runActivity.delete(run.id);
        settleSkillUsage(run.id);
        runSkills.delete(run.id);
      }
      // After the run is terminal and its item has moved, and before the
      // caller gives the run's slot back (EO-479). Not on a throw: a run
      // that ended that way was closed by EO, not by its agent. The
      // learning review on a fork of the run's thread, or the extraction
      // it falls back to (EO-717).
      // Handed what the run's turns were opened with, so the fork is
      // opened with it too (EO-732).
      await reviewAfterRun(run.id, item, agent, args[3], args[7]);
      // The run moved the counts of the skills it was given (EO-720).
      await archiveAfterRun(item);
    } finally {
      // Kept until the review is over, which is recorded when the run was (EO-734).
      capturedRuns.delete(run.id);
      drivenRuns.delete(run.id);
      // A run with no lease gives its slot back here, not in a release:
      // a waiting side call may take it, and the tick may dispatch.
      if (!heldLeases.has(item.id)) {
        sideCallSlots.poke();
        notifyStateChange();
      }
    }
  }

  async function driveToCompletion(
    run: { id: Uuid; itemId: Uuid; cwd?: string | null },
    item: Item,
    agent: Agent,
    action: string,
    initialStream: InterruptibleStream<AgentEvent>,
    initialThreadId: string | null,
    controller: AbortController,
    runOpts: {
      transitionOnSuccess?: boolean;
      /**
       * The directory this run's turns are pointed at (EO-107).
       *
       * Carried in rather than re-derived, because a corrective turn is
       * *this* turn continued: re-reading the catalogue here would let a
       * detach mid-run change what the conversation can reach halfway
       * through, and re-generating would rewrite the directory a live
       * process is holding open.
       */
      toolDirectory?: string;
      /**
       * The servers that directory was written with, for the same reason
       * and with sharper teeth: this is what the backend's startup
       * report is checked against, and it is a snapshot precisely
       * because the report arrives after the catalogue has had a chance
       * to change.
       */
      toolServerNames?: string[];
      /**
       * What the workspace lent this run (EO-151, EO-295).
       *
       * Carried in for the reason `toolDirectory` is: a corrective turn
       * is *this* turn continued, and it respawns the backend. Attached
       * again here it could answer differently halfway through a run —
       * a sync between the two turns is enough — and an agent asked to
       * fix its result would be answering with a different tool surface
       * from the one it produced the result with.
       *
       * The handover sync rides on it rather than being resolved at the
       * handover, and for the same reason in reverse: what is brought up
       * to date has to be the thing that was lent.
       */
      attachment?: WorkspaceAttachment;
    } = {},
  ): Promise<void> {
    activeControllers.set(run.id, controller);
    activeStreams.set(run.id, initialStream);
    activeRestartIntents.set(run.id, {
      cancelledRunId: run.id,
      itemId: item.id,
      agentId: agent.id,
      action,
      transitionOnSuccess: runOpts.transitionOnSuccess !== false,
    });
    const buffer = createRunEventBuffer(db);
    // Registered next to the stream, and released next to it below: a
    // message steered into this turn is written to this run's transcript
    // through this buffer, and the two facts a person needs — that the
    // agent is reachable and where the message landed — are true for
    // exactly the same span (EO-176).
    activeEventBuffers.set(run.id, buffer);

    const guards = readGuards();
    // The same controller reaches initial, resumed, and corrective turns,
    // so one timeout/cancellation mechanism covers the entire run. The
    // system agent's has none (EO-616).
    const timeoutTimer =
      guards.wallClockTimeoutMs > 0 && !isSystemAgent(agent)
        ? setTimeout(() => {
            guardTripReasons.set(
              run.id,
              `Wall-clock timeout of ${guards.wallClockTimeoutMs}ms exceeded.`,
            );
            controller.abort();
          }, guards.wallClockTimeoutMs)
        : undefined;
    timeoutTimer?.unref?.();
    const clearTimeoutGuard = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    };

    // Watched for silence from here until the run ends (`watchLiveRuns`).
    runActivity.set(run.id, { lastAt: now(), events: 0, seenEvents: 0, openCalls: new Set(), callsSinceReminder: 1, lastWord: null, agentName: agent.name, systemAgent: isSystemAgent(agent) });
    let threadId = initialThreadId;
    // Known from the first moment it is known, so a run that never
    // reaches a terminal branch can still be closed against the session
    // it was actually using (#141).
    if (threadId) lastKnownThreadIds.set(run.id, threadId);
    // A resumed thread's running total already holds what its earlier
    // runs spent, and the CLI reports it as this run's (EO-490): the tally
    // takes off where those runs left the session, so this one records
    // its own. Where they left it is the figure the newest of them read,
    // not the sum of their shares (EO-504) — a row from before EO-490
    // holds the whole conversation, and a sum over it overshoots.
    const usage = createUsageTally({ earlierOnThread: initialThreadId ? sessionTotalBefore(usageHistoryOnThread(db, initialThreadId, run.id)) : null });
    // Whether this run has said yet that the budgets cannot count it
    // (EO-374). Once per run: every turn on the same unpriced model is
    // the same fact, and a note per turn would bury the thread.
    let unpricedNoted = false;
    let pushBuffer: AgentEvent[] = [];
    let lastPushAt = 0;
    const flushPush = (): void => {
      if (pushBuffer.length > 0) {
        onPushEvents?.(run.id, pushBuffer);
        pushBuffer = [];
      }
    };
    const pushEvent = (event: AgentEvent): void => {
      pushBuffer.push(event);
      const nowMs = now();
      if (nowMs - lastPushAt >= pushThrottleMs) {
        flushPush();
        lastPushAt = nowMs;
      }
    };

    // A resumed turn is the same run continued, so it needs the same
    // workspace and the same output shape it was originally asked for.
    // Neither survives in the provider session: the Claude CLI cannot
    // even find a session resumed from a different directory, and a
    // corrective turn without the schema re-fails the validation it was
    // sent to fix.
    const actionSchema = outputSchemaFor(registryFor(item), action, typeOf(item), definingRole(item, agent));
    const resumeOptions: AgentProviderResumeOptions = {
      ...(run.cwd ? { cwd: run.cwd } : {}),
      ...(actionSchema ? { outputSchema: actionSchema } : {}),
      // And the same tools. A corrective turn respawns the backend just
      // as an ordinary resume does, so a turn built without this reaches
      // the model with `plugins` unset and an empty skills allowlist —
      // the agent's attached server and its skills gone, mid-run,
      // between being asked for a result and being asked to fix it.
      ...(runOpts.toolDirectory ? { toolDirectory: runOpts.toolDirectory } : {}),
      // And the query server, on exactly the same argument: a corrective
      // turn respawns the backend, and a turn built without this reaches
      // the model with the index gone — between being asked for a result
      // and being asked to fix it.
      ...(runOpts.attachment?.mcpServers[0] ? { repositoryMcp: runOpts.attachment.mcpServers[0] } : {}),
      // And which run this is and where it works (EO-412), or the `eo`
      // server the corrective turn starts would stop listing
      // `attachment_add` between the answer and its correction.
      ...attachOption(item, run),
      // And `memory_read`, on the same argument (EO-478).
      ...memoryOption(item),
      // And where the agent's writes go (EO-543).
      ...writeBridgeOption(item),
      signal: controller.signal,
      ...discussionTurnOptions(item, agent),
    };

    /**
     * What a corrective turn resumes with: the run's options, with what
     * this turn may spend and the run's environment variables read again
     * now (EO-487). A corrective turn spawns a CLI process of its own,
     * and the initial stream may have run for an hour — a variable edited
     * or removed meanwhile must reach it, so the snapshot taken when the
     * run opened is dropped rather than spread under the fresh one.
     */
    const correctionOptions = (): AgentProviderResumeOptions => {
      const options: AgentProviderResumeOptions = { ...resumeOptions, ...turnBudget(item, agent) };
      delete options.environmentVariables;
      delete options.withheldEnvironmentVariables;
      return { ...options, ...turnEnvironment(item) };
    };

    let outcome: StreamOutcome;
    let validatedResult: unknown;
    /** Set when the agent answered with questions rather than an answer (KAN-29). */
    let askedFor: ClarificationRequired | null = null;
    /**
     * The refusals standing against this run (EO-172).
     *
     * Held across the whole of the loop rather than per stream: a reading
     * arrives during whichever turn ran out, and every turn after it
     * would run against the same exhausted allowance.
     *
     * A set rather than a slot, because a plan's windows exhaust
     * independently and two of them can refuse in one run. Keeping only
     * the newest would report whichever landed second instead of the one
     * that actually gates the work.
     */
    const refusals = createQuotaRefusals();
    try {
      let stream = initialStream;
      let resultRetries = 0;
      for (;;) {
        outcome = await processStream(stream, {
          signal: controller.signal,
          runId: run.id,
          buffer,
          item,
          agent,
          action,
          expectedServers: runOpts.toolServerNames ?? [],
          attachFrom: attachSourceOf(item, run),
          onThreadId: (id) => {
            // Written the moment it is known, not only when the run ends:
            // a run EO is killed under never reaches an ending, and the
            // row is all a restart has to carry it on with (§6.3). Without
            // it a fresh run interrupted by a crash could only be orphaned
            // and started over.
            if (id !== threadId || getRun(db, run.id)?.threadId !== id) updateRun(db, run.id, { threadId: id });
            threadId = id;
            lastKnownThreadIds.set(run.id, id);
          },
          onUsage: (event) => {
            // Only when the reading changed something. A reading the
            // tally rejected as empty must not write a row of zeroes over
            // the nulls that say nothing was ever reported.
            //
            // The session's own total goes beside the run's share, for
            // the next run on the thread to start from (EO-504).
            if (usage.record(event)) updateRun(db, run.id, { ...usage.totals(), ...sessionColumns(usage.sessionTotal()) });
            // Tokens with no price behind them (EO-374): a Codex turn on
            // a model EO's table does not hold. Its cost sums as zero, so
            // the budgets in cents would let it run on without a word —
            // which is what every Codex run did before the table. Said on
            // the item instead (invariant 8), naming the model, so the
            // person who set a budget knows this run is outside it.
            if (event.unpriced && !unpricedNoted) {
              unpricedNoted = true;
              postComment(db, { itemId: item.id, runId: run.id, author: { type: "engine" }, kind: "note", body: unpricedRunNote(agent.name, event.unpriced.model) });
            }
          },
          onQuota: (quota) => {
            refusals.record(quota);
          },
          pushEvent,
        });
        // Whatever the turn left unfinished goes with it, however it
        // ended: a corrective turn on the same run must not have its
        // words joined onto the last one's half-written block.
        liveDrafts.endTurn(run.id);

        // The answer arrived; only the event that announces it did not
        // (#141). A reviewer returned a well-formed
        // `{"outcome":{"verdict":"approve",...}}` as its last message
        // and the stream then closed after the trailing usage event,
        // with no `result` event behind it — so the approval was read,
        // recorded in `run_events`, and thrown away, and the item sat
        // at Review with a reviewer shown as working on it forever.
        //
        // The bar for treating a message as the answer is deliberately
        // the same bar a `result` event has to clear: it must parse and
        // it must satisfy the action's own schema. Anything less stays
        // `ended` and is reported as a run that produced nothing, which
        // is what it is. This is not prose being read for meaning
        // (ARCHITECTURE.md, "A run") — a message that is not the exact shape the action
        // declared never becomes a result here.
        //
        // Asked before the limit check below, and not after: a turn that
        // finished its answer and *then* ran the window dry has done the
        // work, and reporting it as stopped by a limit would throw away a
        // result EO already holds (EO-172).
        if (outcome.kind === "ended" && outcome.finalText !== null && validateResult(item, action, outcome.finalText, definingRole(item, agent)).ok) {
          // The raw text, not the parsed value: `persisted.raw` is what
          // the agent actually said, and the validation below is what
          // turns it into what the engine acts on — exactly as it would
          // have for a result the provider announced.
          outcome = { kind: "result", data: outcome.finalText };
        }

        // A limit was reached and the turn came back with nothing usable
        // (EO-172). Every one of these three would otherwise be
        // re-prompted or reported as the agent's failure, and both are
        // wrong for the same reason: the allowance is spent, so asking
        // again cannot produce a different answer, and the thing that
        // needs saying on the item is the limit rather than the shape
        // of what a cut-off turn managed to write.
        //
        // `escalated`, `paused` and `guardTripped` are deliberately not
        // here. Each is EO or a person having already decided how this
        // run ends, and a refusal arriving alongside does not overrule
        // that. `result` is not here either — it is checked below, after
        // validation, because a valid one is work that got done.
        //
        // Whichever outstanding refusal holds the work longest, so that
        // waiting out the time this names waits out every other window
        // too. Asked for here rather than remembered from the callback,
        // because a window that stopped refusing during the turn no
        // longer counts and the answer can only shrink after it arrives.
        const blockingRefusal = refusals.blocking(now());
        if (blockingRefusal !== null && (outcome.kind === "ended" || outcome.kind === "error")) {
          outcome = { kind: "limitReached", quota: blockingRefusal };
          break;
        }

        // A-02: a result is a *claim* until it matches its action's
        // schema. Re-prompt with the exact validation error rather than
        // discarding the run — format errors are the solvable half of
        // the design, and the agent can usually fix them given the message.
        if (outcome.kind === "result") {
          const validation = validateResult(item, action, outcome.data, definingRole(item, agent));
          if (validation.ok) {
            if ("clarification" in validation) askedFor = validation.clarification;
            else validatedResult = validation.value;
            break;
          }
          // This is the exact shape of what EO-172 was reported for: a
          // turn cut off by an exhausted window leaves half a result
          // behind, which fails its schema for a reason that has nothing
          // to do with the schema. Correcting it means re-prompting
          // against the allowance that just ran out, twice, and then
          // telling a person the agent cannot produce valid output.
          //
          // Below the `validation.ok` break, so a result that is *fine*
          // is still acted on. Above the retry, because the retry is the
          // thing that must not happen.
          if (blockingRefusal !== null) {
            outcome = { kind: "limitReached", quota: blockingRefusal };
            break;
          }
          if (resultRetries < MAX_RESULT_VALIDATION_RETRIES && threadId) {
            if (heldBack(agent)) {
              outcome = { kind: "paused" };
              break;
            }
            resultRetries += 1;
            usage.commit(); // a new stream, as above
            const correctedThreadId = threadId;
            // With the memory-writing block where the turn is served
            // `memory_note` (EO-593): it carries on a thread that may
            // never have been given it.
            const correction = withMemoryWriting(`${validation.error}\n\nPlease return a corrected result that matches the schema.`, agent, turnMemoryScopes(item));
            stream = openTurn(item, workspaceOfRun(item, run), () =>
            sendingProvider(run, agent, item, action, { purpose: "correction" }).resume(correctedThreadId, correction, correctionOptions()),
          );
            activeStreams.set(run.id, stream);
            continue;
          }
          outcome = {
            kind: "guardTripped",
            reason:
              `The "${action}" result still failed validation after ` +
              `${resultRetries} correction attempt(s), so this run stopped rather than acting on it.\n\n${validation.error}`,
          };
        }

        break;
      }
      flushPush();
    } catch (error) {
      flushPush();
      buffer.dispose();
      liveDrafts.clear(run.id);
      activeControllers.delete(run.id);
      activeStreams.delete(run.id);
      activeEventBuffers.delete(run.id);
      activeRestartIntents.delete(run.id);
      clearTimeoutGuard();
      const guardReason = guardTripReasons.get(run.id);
      guardTripReasons.delete(run.id);
      const forcedCancellation = forcedCancellationRunIds.delete(run.id);
      // A turn EO stopped reading whose process it could not confirm gone
      // (EO-493). Failed closed: this is the one place it can land, so no
      // correction was opened after it, and the thread is written off —
      // `threadLost` is what every later resume asks (`findReusableThread`,
      // restart recovery, a stop meant to be carried on) — because
      // resuming it would start a second agent on a session the first may
      // still be working in.
      //
      // On every ending, a stop included. A run EO stopped — cancelled,
      // or parked by a guard — keeps the ending the stop gave it, and its
      // thread goes all the same; a run nobody stopped is a failure.
      const survivor = isTurnNotEnded(error) ? error : null;
      const writtenOff = survivor !== null && threadId !== null ? { threadLost: true } : {};
      if (survivor !== null && !forcedCancellation && !stoppedByEo(error, controller)) {
        updateRun(db, run.id, { status: "failed", error: survivor.message, endedAt: now(), threadId, ...writtenOff });
        announceRun(run.id, item.id, "failed");
      } else if (forcedCancellation) {
        // The cancellation was persisted synchronously by cancelActiveRun.
        // Never let a late provider throw reclassify it as failed.
        if (survivor !== null) updateRun(db, run.id, { threadId, ...writtenOff });
      } else if (stoppedByEo(error, controller) && guardReason) {
        updateRun(db, run.id, {
          status: "awaiting_input",
          error: guardReason,
          endedAt: now(),
          threadId,
          ...writtenOff,
        });
        postGuardEscalation(item.id, run.id, guardReason);
        announceRun(run.id, item.id, "awaiting_input");
      } else if (stoppedByEo(error, controller)) {
        updateRun(db, run.id, {
          status: "cancelled",
          endedAt: now(),
          threadId,
          ...writtenOff,
        });
        announceRun(run.id, item.id, "cancelled");
      } else if (isThreadNotFound(error) && threadId !== null) {
        // The backend has no such session (EO-93). Not a failure of the
        // work — nothing was asked and nothing was answered — so it is
        // not reported as one; the thread is written off and the work
        // starts again from a fresh one.
        //
        // `threadId !== null` because there is nothing to write off
        // otherwise: a `start()` that somehow produced this error opened
        // no session, and a run with no thread marked as having lost one
        // would be a lie in the table. That falls through below and
        // fails like any other provider error.
        await carryOnWithoutTheThread(run, item, agent, action, threadId, runOpts);
      } else {
        // A CLI the kernel or systemd stopped because the run ran out of
        // memory dies like any other (EO-738); its scope is what says so.
        const outOfMemory = await ranOutOfMemory(run.id);
        if (outOfMemory !== null) endOutOfMemory(run.id, item, agent, action, threadId, outOfMemory);
        else {
        updateRun(db, run.id, {
          status: "failed",
          error: String(error),
          endedAt: now(),
          threadId,
        });
        // The message rather than `String(error)`: the thread is read by
        // a person, and "Error: " in front of it helps nobody.
        postRunFailure(item.id, run.id, error instanceof Error ? error.message : String(error));
        announceRun(run.id, item.id, "failed");
        }
      }
      // Said however the run ended (invariant 8): a process that may still
      // be working in this run's workspace is the thing a person has to know.
      if (survivor !== null) {
        postRunFailure(
          item.id,
          run.id,
          `${survivor.message}\n\n` +
            `EO could not confirm that ${agent.name}'s process has stopped, so it has not opened another turn on this conversation ` +
            `and will not resume it: the next run starts a fresh one. If the process is still running it may still be working in the run's workspace` +
            `${survivor.pids.length > 0 ? ` — it is process ${survivor.pids.join(", ")} on this machine` : ""}; stop it before carrying the work on.`,
        );
      }
      return;
    }

    clearTimeoutGuard();
    guardTripReasons.delete(run.id); // a timeout that fired on an unabortable resumed stream would otherwise leave its reason behind forever
    buffer.dispose(); // flush before deciding the terminal state, so the persisted log is complete first
    liveDrafts.clear(run.id);
    activeControllers.delete(run.id);
    activeStreams.delete(run.id);
    activeEventBuffers.delete(run.id);
    activeRestartIntents.delete(run.id);

    if (forcedCancellationRunIds.delete(run.id)) {
      // Some providers wind down with a normal result after cancellation.
      // The user's destructive choice wins over that late terminal event.
      return;
    }

    switch (outcome.kind) {
      case "escalated":
        // Escalation ends the run — it does not hold a subprocess waiting (ARCHITECTURE.md,
        // "Escalation ends the run").
        updateRun(db, run.id, {
          status: "awaiting_input",
          endedAt: now(),
          threadId,
        });
        announceRun(run.id, item.id, "awaiting_input");
        // A run that stopped to ask still worked in a workspace, and the
        // workspace still has something to say about what happened in it
        // (KAN-18): an implementer asked to propose may have written
        // half the change while it proposed. Nothing here can fail the
        // run — it has already ended, and the item is waiting on a
        // person — so every check that did not pass is reported.
        {
          const parked = await checkWorkspace(run, item, action, null, "escalated", agent.role);
          // On the row as well as in the thread (EO-312): a parked run
          // is exactly the one somebody opens the sidebar on, and what
          // was checked while it proposed is part of what they are
          // deciding with.
          updateRun(db, run.id, { checks: keptChecks(parked) });
          postCheckNotes(item, parked, "all");
        }
        return;

      case "error": {
        // Out of memory first (EO-738): the backend's word on retrying is
        // about its own error, and a CLI the run's scope stopped reports
        // whatever its death looked like from inside.
        const outOfMemory = await ranOutOfMemory(run.id);
        if (outOfMemory !== null) {
          endOutOfMemory(run.id, item, agent, action, threadId, outOfMemory);
          return;
        }
        // The backend said trying again will not help (EO-437) — a
        // content filter's refusal is the one this was found on. A
        // `failed` row is what the scheduler retries, so leaving it one
        // spent the whole attempt allowance on an answer already known,
        // and only then asked for a person. Parked instead, the way a
        // tripped guard is: the item stops being offered, the thread
        // says why and mentions the person, and a reply is what starts
        // it again.
        if (!outcome.retryable) {
          const reason = `${agent.name} was stopped by an error its backend reports as not retryable, so this was not tried again:\n\n${outcome.message}\n\nReply to try again.`;
          updateRun(db, run.id, {
            status: "awaiting_input",
            error: outcome.message,
            endedAt: now(),
            threadId,
          });
          postGuardEscalation(item.id, run.id, reason);
          announceRun(run.id, item.id, "awaiting_input");
          return;
        }
        updateRun(db, run.id, {
          status: "failed",
          error: outcome.message,
          endedAt: now(),
          threadId,
        });
        postRunFailure(item.id, run.id, outcome.message);
        announceRun(run.id, item.id, "failed");
        return;
      }

      case "result": {
        // The agent answered with questions rather than an answer
        // (KAN-29). Nothing is verified and nothing transitions: there
        // is no claim to check and no work to move on. The questions go
        // into the thread and the item waits for every one of them.
        if (askedFor) {
          postClarificationQuestions(db, item, agent.id, run.id, askedFor);
          updateRun(db, run.id, { status: "awaiting_input", endedAt: now(), threadId });
          announceRun(run.id, item.id, "awaiting_input");
          return;
        }

        // What the answer says it relied on from memory, held to what
        // the run was given (EO-597): an id it was not delivered leaves
        // the parsed half and is recorded as dropped. `raw` keeps it as
        // the agent said it.
        validatedResult = memoryUseHeldToDelivery(run.id, item.id, threadId, validatedResult);

        // Both halves persisted (ARCHITECTURE.md, "A run"): `parsed` is what the engine acts
        // on, `raw` is what the agent actually said — which is what you
        // want when something turns out to be wrong later.
        const persisted: PersistedRunResult = {
          raw: outcome.data,
          parsed: validatedResult,
        };

        // G-02: the agent has *claimed* success. Check it before acting
        // on it — this runs after the result is validated and before any
        // transition, because a claim that fails verification must not
        // move the item (the original design: "never accept 'I'm done'").
        const checks = await checkWorkspace(run, item, action, validatedResult, "succeeded", agent.role);
        const verification = evidenceOf(checks);
        const blocked = blockingFailure(checks);
        if (blocked) {
          updateRun(db, run.id, {
            status: "failed",
            result: persisted as unknown as Record<string, unknown>,
            ...(verification ? { verification } : {}),
            checks: keptChecks(checks),
            error: blocked.describes,
            endedAt: now(),
            threadId,
          });
          // The item stays where it is; the next attempt reads this
          // comment through the assembled context (E-06).
          postComment(db, {
            itemId: item.id,
            runId: run.id,
            author: { type: "engine" },
            kind: "rejection",
            body: blocked.comment ?? blocked.describes,
          });
          // Unless this pipeline has somewhere for a failed verification
          // to go (EO-297). The rejection is posted either way — what it
          // says is true wherever the item ends up, and the next attempt
          // reads it — and the route is what decides whether the item
          // waits here for that attempt or goes somewhere that handles
          // it. Nothing declared means nothing changes: the item stays,
          // which is what a failed verification has always done.
          const failedTo = verificationRoute(item, action, stepForItem(db, item));
          if (failedTo && runOpts.transitionOnSuccess !== false) {
            // Unless that is a pipeline this item may not enter (EO-610).
            // Its module rules too (EO-736), once the data rules let it in.
            // The move is made where the module rules are last judged.
            const enter = (): void => {
              record.applyTransition({
                itemId: item.id,
                toStepId: failedTo.stepId,
                toPipelineId: failedTo.pipelineId,
                actor: agent.id,
                runId: run.id,
                reason: "verification failed",
                resultKey: failedTo.resultKey ?? null,
              });
            };
            const refused = handOffRefusal(db, item, failedTo) ?? (await handOffModuleRefusal(db, item, failedTo, enter));
            if (refused !== null) {
              updateRun(db, run.id, { status: "awaiting_input", error: refused, endedAt: now(), threadId });
              announceRun(run.id, item.id, "awaiting_input");
              return;
            }
            await settleItem(item, failedTo.stepId);
          }
          announceRun(run.id, item.id, "failed");
          return;
        }

        updateRun(db, run.id, {
          status: "succeeded",
          result: persisted as unknown as Record<string, unknown>,
          ...(verification ? { verification } : {}),
          checks: keptChecks(checks),
          endedAt: now(),
          threadId,
        });
        // A role's own action leaves its `summary` in the thread, as
        // the agent's comment (EO-421). Here rather than in a pack's
        // wiring because nothing about it is any pack's: the definition
        // is the role's, the property is one EO's generated schema
        // requires, and a role nobody shipped has no pack to post for
        // it. Before the transition, like every record of a run, so it
        // is in front of whoever the move dispatches next.
        if (definedActionFor(registryFor(item), definingRole(item, agent), action) !== undefined) {
          const summary = actionAnswerSummary(validatedResult);
          if (summary !== null) postComment(db, { itemId: item.id, runId: run.id, author: { type: "agent", agentId: agent.id }, kind: "note", body: summary });
        }
        onRunSucceeded(item, agent, action, validatedResult, run.id);
        // Before the transition, so the notes sit above the move in the
        // thread rather than trailing an item that has already left.
        reportPlanModeSkipped(item, action, agent.role);
        postCheckNotes(item, checks);
        // And what the run actually produced, as the item's output
        // (EO-298). After the checks, because a run whose work did not
        // survive verification never gets here — an output is a claim
        // about what the ticket has produced, and EO does not make one
        // on work it has just refused. Before the transition, because
        // the next step's context is assembled from where the item
        // lands, and the thing it is meant to work from has to be on the
        // ticket by then.
        await postArtifacts(run, item, { type: "agent", agentId: agent.id }, action, validatedResult, "succeeded", agent.role);

        if (runOpts.transitionOnSuccess === false) {
          // A manual dispatch answers a question; it is not pipeline
          // progress, so nothing below this runs — no route is read and
          // no `transitionItem` is called (invariant #1).
          //
          // But it still finished, and until EO-339 nobody was told
          // (EO-339). The `return` used to sit in front of the
          // announcement at the foot of this branch, so a mention-driven
          // run emitted no `runs:changed` and no `items:changed` at all:
          // the last push a client got was the progress flush from
          // inside the stream loop, taken *before* the run was marked
          // succeeded and before the reply was written. Every client
          // that refetched on it read a turn still in flight, and
          // `staleTime` then held that stale snapshot as fresh. The
          // assist panel's question card stayed invisible until the
          // person typed something else — and typing is what made those
          // same questions unanswerable.
          //
          // Announcing is a notification, not a transition: it carries
          // ids and says "ask again". Placed here, after
          // `onRunSucceeded` has written the note, the questions, the
          // proposals and the draft, and after `postArtifacts` — so the
          // first view fetched on this push holds the whole turn rather
          // than half of one.
          announceRun(run.id, item.id, "succeeded");
          return;
        }
        const currentState = stepForItem(db, item);
        const destination = currentState
          ? nextStateFor(
              currentState,
              listPipelineSteps(db),
              validatedResult,
              action,
              item,
              definingRole(item, agent),
            )
          : null;
        if (destination && isPark(destination)) {
          // Escalation ends the run rather than holding a subprocess open
          // for a human (invariant #9). The thread id is persisted, so a
          // reply resumes the same conversation with attempt + 1.
          updateRun(db, run.id, { status: "awaiting_input", error: destination.park, endedAt: now(), threadId });
          announceRun(run.id, item.id, "awaiting_input");
          return;
        }

        if (destination) {
          // The handover (EO-153). After the verification above, because
          // a run that failed it produced nothing worth indexing; before
          // the move below, because an item that has already moved is
          // the next agent's problem rather than this one's. The next
          // agent is dispatched against `destination` and reads the
          // index as it stands at this instant, so this is the last
          // moment at which what it will see is still EO's to decide.
          await syncIndexAtHandover(run, item, runOpts.attachment ?? NOTHING_ATTACHED);
          // A pipeline's module entry rules, where the destination is
          // another pipeline (EO-736): its data rules were judged where
          // the route was decided, and a refusal here parks and asks as
          // that one does. After the handover rather than before it, so
          // nothing awaits between the modules' answer and the move: the
          // move is made in the same pass as their last judgement, of the
          // item as it stands then.
          const enter = (): void => {
            record.applyTransition({
              itemId: item.id,
              toStepId: destination.stepId,
              // The same transition it always was, naming one more column
              // (EO-59). Passed on every move rather than only the ones that
              // cross a pipeline, because naming it is what makes
              // `transitionItem` check the step against it — and a
              // destination whose two halves disagree is the item the
              // scheduler cannot see, which is worth refusing wherever it
              // could arise rather than only where we expect it to.
              toPipelineId: destination.pipelineId,
              actor: agent.id,
              runId: run.id,
              reason: "run succeeded",
              // Which result it was sent on (EO-586) — not stored; told to the
              // listeners, which cannot read it back from a pack's answer.
              resultKey: destination.resultKey ?? null,
            });
          };
          const refusedByModule = await handOffModuleRefusal(db, item, destination, enter);
          if (refusedByModule !== null) {
            updateRun(db, run.id, { status: "awaiting_input", error: refusedByModule, endedAt: now(), threadId });
            announceRun(run.id, item.id, "awaiting_input");
            return;
          }
          // A feature used to be pushed along here, both ways: a story
          // finishing closed it, a story sent back reopened it. It is
          // derived now (ARCHITECTURE.md, "One work entity") — nothing to write, nothing to
          // disagree.
          await settleItem(item, destination.stepId);
          // After the move, because the sentence names where the item
          // is *now* and that is the only reason it is worth posting
          // (EO-176).
          reportQueuedMessagesHandedOn(run.id, item, agent.name);
        }
        announceRun(run.id, item.id, "succeeded");
        return;
      }

      case "ended":
        // Nothing usable came back — the recovery above has already
        // asked whether the agent's last message was the answer, and it
        // was not. The run ends here rather than staying open, and it
        // says where that leaves the item: a person reading this
        // needs to know whether the work moved, and invariant #8 is the
        // reason they are told at all.
        updateRun(db, run.id, {
          status: "failed",
          error: "provider stream ended without a result",
          endedAt: now(),
          threadId,
        });
        postRunFailure(
          item.id,
          run.id,
          `This run ended without a usable result, so nothing the agent did has been applied. ${whereTheItemStands(item.id)}`,
        );
        announceRun(run.id, item.id, "failed");
        return;

      case "paused":
        // The provider turn that was already running finished normally;
        // only its follow-up was withheld. A failed terminal row makes
        // automatic work and open mentions eligible again after resume
        // without pretending a human response is required.
        updateRun(db, run.id, {
          status: "failed",
          error: "paused before starting a provider retry",
          endedAt: now(),
          threadId,
        });
        announceRun(run.id, item.id, "failed");
        return;

      case "limitReached": {
        // Parked, not failed (EO-172). Three things follow from
        // `awaiting_input` and all three are wanted here: the scheduler
        // stops offering the item, so the attempt budget that exists to
        // catch genuine loops is not spent waiting for a window to
        // refresh; the thread id is persisted, so a reply carries on the
        // same conversation rather than starting the work again from
        // nothing; and the item asks for a person, which is right
        // because waiting is a decision only they can take.
        const reason = quotaStopReason({ agentName: agent.name, event: outcome.quota, now: now() });
        updateRun(db, run.id, {
          status: "awaiting_input",
          error: reason,
          endedAt: now(),
          threadId,
        });
        // The same words in the thread as in `runs.error`, and an option
        // to press: picking it posts an ordinary reply, which is exactly
        // what resumes the run. A person who comes back after the window
        // has refreshed should not have to work out what to type.
        postGuardEscalation(item.id, run.id, reason, ["The window has refreshed — carry on"]);
        announceRun(run.id, item.id, "awaiting_input");
        return;
      }

      case "guardTripped":
        updateRun(db, run.id, {
          status: "awaiting_input",
          error: outcome.reason,
          endedAt: now(),
          threadId,
        });
        postGuardEscalation(item.id, run.id, outcome.reason);
        announceRun(run.id, item.id, "awaiting_input");
    }
  }

  /**
   * The one place a scheduler dispatch reaches a provider — used by both
   * a normal tick and a human re-authorizing after the attempt-limit
   * guard stopped an item with no thread to resume.
   * Every caller supplies (or derives) an initiation id. Automatic
   * retries reuse it; a workflow return, direct mention, or explicit
   * human authorization gets a fresh one and therefore a fresh limit.
   *
   * It starts a brand-new thread unless the agent keeps one per item
   * and there is one worth carrying on (EO-86), in which case it resumes
   * that conversation with only what the agent has not seen. Which of
   * the two happens changes what is *sent*, and nothing above the
   * provider boundary: the attempt-limit guard, the auth check, the
   * workspace and the rechecks that guard each await are the same either
   * way, so a reused thread can no more outrun a pause than a fresh one.
   */
  /**
   * The item's project has been archived (EO-347).
   *
   * Asked wherever a run is admitted, beside the pause and for the same
   * reason: both are true or false of the moment the run would start,
   * not of the moment the dispatch was decided. Archiving cancels the
   * runs that have rows; a dispatch still in preflight has none, so
   * nothing but this stops it from writing one on a project the person
   * has just put away. One question rather than a check in each
   * caller's `stillEligible`, because a caller that forgot it — a
   * respond, an interpretation, a forced restart — is the gap.
   *
   * Silent, as the pause recheck is: the archive has already said what
   * it stopped, and whatever this dispatch was for — a mention, a
   * reply, a restart — is still in the thread and is offered again once
   * the project is restored.
   */
  function shelved(itemId: Uuid): boolean {
    return archivedProjectBlocker(db, itemId) !== null;
  }

  /**
   * Starts the backend for the turn a person is typing in a conversation,
   * so its first word arrives sooner (`AgentProvider.prewarm`) — Claude
   * Desktop starts its CLI while you type.
   *
   * Every decision is the one `dispatchHeld` will make for that turn, in
   * the same order and from the same functions: the workspace, whether
   * the thread is resumed, the tool directory, the schema and the
   * conversation's settings. That is what lets the dispatch adopt the warm
   * backend — the provider adopts it only when the options match exactly,
   * and anything that changed in between simply starts as it always did.
   *
   * Nothing is recorded and no run exists: a warm backend is a process
   * with no turn in it, shut down if nobody sends. Answers whether one was
   * asked for.
   */
  /** Every provider asked to warm a backend and for whom, so a pause can let go of what it holds and a quit of all of it. */
  const warmedProviders = new Map<AgentProvider, Agent>();
  const dropWarm = (shouldDrop: (agent: Agent) => boolean): void => {
    for (const [provider, agent] of warmedProviders) {
      if (!shouldDrop(agent)) continue;
      provider.dropWarm?.();
      warmedProviders.delete(provider);
    }
  };

  async function prewarmConversation(itemId: Uuid, agentId: Uuid): Promise<boolean> {
    if (shelved(itemId)) return false;
    const item = getItem(db, itemId);
    const action = conversationActionFor(item?.stepId ?? null);
    const agent = getAgent(db, agentId);
    if (!item || !action || !agent || !isAgentAvailable(agent) || heldBack(agent, itemId)) return false;
    if (listActiveRuns(db).some((run) => run.itemId === item.id)) return false;
    const provider = providerFor(agent, item);
    if (!provider.prewarm) return false;
    // A dispatch already in its preflight holds the lock and is about to
    // start this turn itself; and the tool directory is its to write.
    if (itemLock.isHeld(item.id)) return false;

    const prepared = await device.prepareWorkspace(item, action);
    if (!prepared.ok) return false;
    const workspace = prepared.workspace;
    const reuse = reusesThreadPerItem(registry, agent, action) ? findReusableThread(db, { itemId: item.id, agent, cwd: workspace.cwd }) : null;
    const attachments = runAttachmentsHash(agent, item);
    const resuming =
      reuse?.kind === "resume" && reuse.run.threadId !== null && (reuse.run.agentAttachmentsHash ?? EMPTY_ATTACHMENTS_HASH) === attachments ? reuse.run.threadId : null;
    const attachment = await attachWorkspace(item, agent, workspace);
    if (heldBack(agent, itemId) || listActiveRuns(db).some((run) => run.itemId === item.id)) return false;
    const toolDirectory = prepareToolDirectory(item, agent);
    const outputSchema = outputSchemaFor(registryFor(item), action, typeOf(item), definingRole(item, agent));
    const turn = {
      cwd: workspace.cwd,
      ...(outputSchema ? { outputSchema } : {}),
      ...discussionTurnOptions(item, agent),
      ...(toolDirectory ? { toolDirectory: toolDirectory.path } : {}),
      ...(attachment.mcpServers[0] ? { repositoryMcp: attachment.mcpServers[0] } : {}),
      ...attachOption(item, { id: item.id, cwd: workspace.cwd }),
      // What the turn this warms will tell the `eo` server (EO-478), so
      // the warmed process lists the tools the turn would have.
      ...memoryOption(item),
      // And where the agent's writes go (EO-543).
      ...writeBridgeOption(item),
      // In a scope of its own with the run's memory limit (EO-738), so a
      // warm process is outside EO's unit like every run's. No run exists
      // yet, so it is filed under the conversation; the turn that adopts
      // it runs in it, and both adapters leave the scope out of what a
      // warm process must match.
      processScope: processScopeOf(`warm:${item.id}` as Uuid),
      warmKey: attachments,
    };
    provider.prewarm(resuming ? { kind: "resume", threadId: resuming, ...turn } : { kind: "start", instructions: agent.instructions, ...turn });
    warmedProviders.set(provider, agent);
    return true;
  }

  async function dispatchRun(
    item: Item,
    agent: Agent,
    action: string,
    opts: DispatchOptions = {},
  ): Promise<void> {
    // The item, claimed for the whole of the dispatch (EO-132) —
    // preflight, provider stream and all — and given back only when the
    // run has reached a terminal status, whichever way it got there.
    // `run()` releases on a throw as readily as on a return, so a
    // provider that falls over cannot strand the item.
    //
    // Losing the claim is not an event: the scheduler that could not
    // take it has written nothing, moved nothing and said nothing, and
    // the next tick offers the same item again.
    if (opts.holdingItemLock === true) {
      await dispatchHeld(item, agent, action, opts);
      return;
    }
    await itemLock.run(item.id, () => dispatchHeld(item, agent, action, opts));
  }

  /** `dispatchRun` with the item already claimed. Never call it directly. */
  async function dispatchHeld(
    item: Item,
    agent: Agent,
    action: string,
    opts: DispatchOptions = {},
  ): Promise<void> {
    if (heldBack(agent, item.id)) return;
    if (shelved(item.id)) return;
    // A step a trial plan mocks runs no backend (EO-584): asked before
    // the runtime, the preflight and the budget, none of which a step
    // that does not run has any use for. Asked without an await first, so
    // a step that runs reaches the checks below in the same turn of the
    // event loop it always did.
    if (isMockedOnTrial(item, opts.stepId)) {
      await runMockedStep(item, agent, action, opts.stepId, opts.stillEligible);
      return;
    }
    if (!isAgentAvailable(agent)) return;

    const initiationId = opts.initiationId ?? workflowInitiationId(item, action);
    const priorAttempts = countAttempts(item.id, initiationId);
    const nextAttempt = priorAttempts + 1;

    // No provider is ever started as a retired agent (EO-186).
    //
    // Here rather than only at the entry points, because this is the one
    // door every start goes through and the entry points are not the
    // only way in. `tick()` never offers an archived agent and the
    // mention guards turn their own requests back earlier and with
    // better words; what reaches this is the *continuation* paths — a
    // forced restart after a destructive close, and a thread EO found
    // gone — which come straight here holding an `Agent` they read
    // before their own preflight, and which have already promised a
    // replacement run in the thread.
    //
    // Refused rather than dropped, and refused the way every other guard
    // in this function refuses: a placeholder run carrying the reason,
    // an escalation in the thread and `!` on the item. The work this
    // was going to do still needs doing and only a person can say by
    // whom, which is what an escalation is for (invariant #8).
    //
    // A run already streaming is left alone. This is about *starting*
    // one: a conversation under way is work in progress, and archiving
    // an agent is not a cancel.
    //
    // Read back rather than taken from the caller's `Agent`, for
    // `stepAuthorisationBlocker`'s reason — every caller is holding a
    // value from before its own awaits, and archiving is something a
    // person does while EO is busy.
    const currentAgent = getAgent(db, agent.id);
    if (currentAgent !== undefined && currentAgent.archivedAt !== null) {
      if (alreadyRefused(item.id, initiationId)) return;
      refuseDispatch(
        item,
        agent,
        action,
        archivedAgentRefusal({ kind: "agent_archived", agentName: agent.name, role: currentAgent.role }, "start this run"),
        initiationId,
        nextAttempt,
      );
      return;
    }

    // Nor as an agent whose project this item is not on (EO-474), for
    // the archived refusal's reason: this is the door every start goes
    // through. `tick()` never offers one, and the mention, reply,
    // recovery and forced-restart paths settle their own cases first
    // and in better words; this is what holds if one of them — or a
    // path written later — does not.
    const currentItem = getItem(db, item.id) ?? item;
    if (currentAgent !== undefined && !servesProject(currentAgent, currentItem)) {
      if (alreadyRefused(item.id, initiationId)) return;
      refuseDispatch(item, agent, action, outOfProjectDispatchRefusal(outOfProjectWords(currentAgent, currentItem)), initiationId, nextAttempt);
      return;
    }

    /**
     * Retired — or deleted — while a preflight await was open (EO-186).
     *
     * Asked again at each of the three points below, beside the pause
     * and the deleted item, because it is the same kind of fact: true
     * when the dispatch was decided, false by the time it would start.
     *
     * Silent, unlike the refusal above, and for the reason the pause
     * recheck is silent: the refusal has already been posted if this
     * dispatch was ever going to be refused, and a second comment about
     * a row that changed while EO was working would be EO reporting its
     * own timing rather than anything a person can act on.
     */
    // And moved to another project mid-preflight (EO-474): the same kind
    // of fact, turned back the same silent way.
    const agentRetiredMidPreflight = (): boolean => {
      const row = getAgent(db, agent.id);
      const itemRow = getItem(db, item.id);
      return row === undefined || row.archivedAt !== null || (itemRow !== undefined && !servesProject(row, itemRow));
    };

    // No review is started against an item that declares nothing to
    // judge it by (EO-213).
    //
    // `tick()` will not offer one — `no_acceptance_criteria` is a
    // scheduler blocker, and the tick refuses it out loud before it gets
    // this far — so what this catches is every *other* door onto a
    // dispatch: a reply that resumes a parked run, a mention asking for
    // the step again, a forced restart after a lost thread. Each of
    // those comes straight here holding an item it read before its own
    // preflight, exactly as the archived-agent refusal above describes,
    // and a review that starts with nothing to check is the eleven-round
    // loop this story exists to end.
    //
    // Read back rather than taken from the caller's `Item`, for that
    // refusal's reason: writing criteria is something a person does
    // while EO is busy, and this is the last moment the answer can
    // change.
    const asItStands = getItem(db, item.id) ?? item;
    if (action === REVIEW_ACTION && declaresNoCriteria(asItStands, shapeOf(asItStands))) {
      if (alreadyRefused(item.id, initiationId)) return;
      refuseDispatch(item, agent, action, missingCriteriaRefusal(asItStands, shapeOf(asItStands)), initiationId, nextAttempt);
      return;
    }

    const guards = readGuards();
    const interruptions = countInterruptions(item.id, initiationId);
    if (interruptions >= MAX_INTERRUPTIONS_PER_INITIATION && !isSystemAgent(agent)) {
      if (alreadyRefused(item.id, initiationId)) return;
      refuseDispatch(
        item,
        agent,
        action,
        `Stopped after this "${action}" was interrupted ${interruptions} times — by EO being closed or restarting, or the computer sleeping, while it ran — ` +
          `without finishing. EO no longer carries it on by itself, in case what keeps interrupting it is the work itself. ` +
          `Reply to start a new initiation.`,
        initiationId,
        nextAttempt,
      );
      return;
    }
    if (priorAttempts >= guards.perItemAttemptLimit) {
      if (alreadyRefused(item.id, initiationId)) return;
      refuseDispatch(
        item,
        agent,
        action,
        attemptLimitStop(priorAttempts, action, guards.perItemAttemptLimit),
        initiationId,
        nextAttempt,
      );
      return;
    }

    // What one occurrence of a job is allowed to spend (EO-307,
    // `ARCHITECTURE.md`, "Controls").
    //
    // Before the dispatch and not during it, which is the whole shape of
    // this guard: money a turn has already committed cannot be got back,
    // and a turn cut off halfway leaves work neither done nor undone. So
    // the budget bounds the *sequence* of runs on an occurrence's item —
    // the loop a runaway job actually is — and the guard is the ordinary
    // refusal every other one in this function is: a placeholder run
    // carrying the reason, an escalation in the thread, `!` on the item.
    // There is nothing to route on, because nothing ran.
    //
    // Next to the attempt limit because it is the same kind of fact:
    // this item has had enough of something, and only a person can say
    // it should have more. Unlike the attempt limit it also stops the
    // job, since parking one item leaves the definition that filed it
    // due again in an hour.
    //
    // Not asked of the system agent (EO-616): only the attempt limit is,
    // so its run neither stops here nor pauses the job.
    const overBudget = isSystemAgent(agent) ? null : occurrenceOverBudget(db, item.id);
    if (overBudget !== null) {
      if (alreadyRefused(item.id, initiationId)) return;
      // The pause first: it is what stops the next occurrence, and the
      // park below is what says so where this item's person is looking.
      pauseForBudget(db, overBudget, item);
      refuseDispatch(item, agent, action, budgetRefusal(overBudget), initiationId, nextAttempt);
      return;
    }

    // What the organisation allows, and what it allows this person to
    // spend (EO-328, `ARCHITECTURE.md`, "Policy", "Secrets").
    //
    // Read once, here, because both questions are answered from the same
    // cached copy and the second of them is the more expensive: a policy
    // that publishes no budget never reaches a sum at all.
    //
    // Beside the job budget and after it on purpose. The job's is about
    // one definition that ran away and pauses that definition; these two
    // are about the *installation* — which backends may run here, and
    // whether this person's day is spent — so a runaway job should still
    // be named as a runaway job when both would fire.
    const policy = readPolicy(db);

    // A device may not dispatch to a backend outside the list (ARCHITECTURE.md, "Policy").
    //
    // The Agents screen greys the disallowed ones so nobody binds an
    // agent to one in the first place, and this is what makes that a
    // rule rather than a hint: a row written before the policy was
    // published, by the system agent through `eo_admin`, or by a hand on
    // the database, still cannot run. Invariant 5 — where EO can check a
    // claim independently, it must.
    //
    // A preview is exempt, and not by omission: it runs on the fake
    // provider whatever its agent says (`runsOn`, EO-313), so no backend
    // is reached and there is nothing for an organisation to have an
    // opinion about.
    if (item.previewAt === null && !backendAllowed(policy, agent.provider)) {
      if (alreadyRefused(item.id, initiationId)) return;
      refuseDispatch(
        item,
        agent,
        action,
        disallowedBackendRefusal({ agentName: agent.name, provider: agent.provider, policy }),
        initiationId,
        nextAttempt,
      );
      return;
    }

    // …and what one person's day may cost (ARCHITECTURE.md, "Policy").
    //
    // Before the dispatch for `occurrenceOverBudget`'s reason exactly —
    // money a turn has committed cannot be got back — and the ordinary
    // refusal every other guard here is: a placeholder run carrying the
    // reason, an escalation mentioning the person in the thread, `!` on
    // the item. Nothing is routed, because nothing ran.
    //
    // Nothing is paused. A job budget stops the definition that filed
    // the item because the definition is what ran away; a person's day
    // turns over on its own, and pausing every job they own would be a
    // state somebody has to remember to undo tomorrow morning.
    //
    // **The figure comes from the record, not from this replica**
    // (review). The design's ceiling is a *person's*, and a person has more
    // than one machine: summing the local rows gave each of Anna's two
    // desktops the whole budget to itself, and a replica that had not
    // synced yet answered with a fraction of the real spend and let work
    // through on the strength of it. `personSpendToday` asks whoever
    // owns the answer — over the wire on a signed-in desktop, out of
    // this database on a solo one, where the two are the same rows.
    //
    // `await` here and not at the top of the function: this is the last
    // thing checked before the machine-local preflight, so a policy
    // that publishes no ceiling never opens a socket for it. Existence
    // is read again afterwards along with every other fact a preflight
    // await can invalidate.
    // The item's budget and the day's, already spent before this run
    // starts: refused here, before a turn spends more, rather than started
    // and stopped at its first reading. Said the way the guard says it
    // when it trips mid-run. The system agent is held to neither (EO-616).
    const alreadySpent = item.previewAt === null && !isSystemAgent(agent) ? checkBudgetGuard(item.id) : null;
    if (alreadySpent) {
      if (alreadyRefused(item.id, initiationId)) return;
      refuseDispatch(item, agent, action, alreadySpent, initiationId, nextAttempt);
      return;
    }

    const daySpent = await personDayOverspent(db, policy, item);
    if (heldBack(agent, item.id) || !getItem(db, item.id) || shelved(item.id) || !isAgentAvailable(agent) || agentRetiredMidPreflight()) return;
    if (opts.stillEligible?.() === false) return;
    if (daySpent !== null) {
      if (alreadyRefused(item.id, initiationId)) return;
      // The same sentence the record writes when it withholds the work
      // instead, and written through the same one-owner helper so that
      // whichever of the two gets there first, the item is told once.
      parkForPersonBudget(db, item.id, daySpent);
      refuseDispatch(item, agent, action, personBudgetRefusal(daySpent), initiationId, nextAttempt);
      return;
    }

    // Cheaper than the auth probe, and prior to it: with no pack
    // installed there is nothing for a signed-in backend to do either
    // (KAN-144). The builtin path asks the same question of the same
    // seam, so the two halves of "EO has nothing installed" cannot
    // drift apart.
    const unavailable = dispatchRefusal({ role: agent.role, action });
    if (unavailable !== null) {
      if (alreadyRefused(item.id, initiationId)) return;
      refuseDispatch(item, agent, action, unavailable, initiationId, nextAttempt);
      return;
    }

    // Cheapest refusal first: a signed-out backend cannot do anything
    // with a worktree, and preparing one would leave a branch behind
    // for a run that never starts.
    //
    // Asked of the *device*, which is what this half of the dispatch is
    // (EO-322): whether the backend is installed on this machine and
    // whether the person is signed in to it are facts only the machine
    // the work runs on can answer, and a managed record holding this
    // item has no way to know either. What it gets back is a result or
    // a refusal, and the refusal is reported as a comment.
    const preflight = await device.preflight({ item, agent, action });
    // A destructive delete can land while any preflight await is open.
    // The dispatch holds an old Item value, so existence must be read
    // again before it writes or starts a provider; otherwise a request
    // removed with its conversation could still wake up afterwards.
    if (heldBack(agent, item.id) || !getItem(db, item.id) || shelved(item.id) || !isAgentAvailable(agent) || agentRetiredMidPreflight()) return;
    if (opts.stillEligible?.() === false) return;
    // The runtime went away while the credentials were being read.
    // Silent, exactly as the check at the top of this function is.
    if (preflight.kind === "stand-down") return;
    if (preflight.kind === "refused") {
      device.report({ item, agent, action }, preflight, { initiationId, attempt: nextAttempt });
      return;
    }

    // What EO is configured to do for this agent and will not (EO-108).
    // After the auth refusal and before any work: a dispatch that is
    // about to be turned away for a signed-out backend has a more
    // pressing thing to say, and one that proceeds should carry this
    // ahead of the run it is about to open.
    postDispatchNotices(item, agent);

    // The agent's filesystem: a git worktree once one is configured
    // (G-01). Prepared *before* the run row exists, so a dirty repo or a
    // clashing branch escalates without an agent ever starting.
    //
    // The second half of the device's preflight, for the first half's
    // reason: the disk is the machine's, and the record cannot prepare
    // one it has never seen.
    const prepared = await device.prepareWorkspace(item, action);
    if (heldBack(agent, item.id) || !getItem(db, item.id) || shelved(item.id) || !isAgentAvailable(agent) || agentRetiredMidPreflight()) return;
    if (opts.stillEligible?.() === false) return;
    if (!prepared.ok) {
      device.report(
        { item, agent, action },
        { kind: "refused", reason: prepared.reason, ...(prepared.options ? { options: prepared.options } : {}) },
        { initiationId, attempt: nextAttempt },
      );
      return;
    }
    const workspace = prepared.workspace;

    /** Set when the thread was fine when it was weighed up and not by the time it was needed. */
    let staleReuse: string | null = null;
    // Is there a conversation to carry on rather than a fresh one to
    // open (EO-86)? Asked here and not earlier because the answer
    // depends on the worktree this dispatch actually got — a session
    // resumes only in the directory it started in — and asked at all
    // only for an agent whose owner ticked the box.
    //
    // The action is part of that question since EO-210. The system agent
    // serves five, and only three of them are chats whose item is the
    // conversation; `interpret` and `respond` run against real work
    // items, where a thread keyed on the item would accumulate
    // unrelated dispatches in one conversation. `reusesThreadPerItem`
    // carries the argument.
    // Not asked for a continuation, which names its thread itself — and
    // whose answer would post a note about starting fresh beside a
    // thread that is in fact being carried on.
    //
    // Unless the workspace has moved since the run was stopped: a
    // session resumes only from the directory it was opened in, so that
    // one starts fresh, by the role's own rule, as any dispatch would.
    const continuation =
      opts.continueThread && (opts.continueThread.from.cwd === null || opts.continueThread.from.cwd === workspace.cwd) ? opts.continueThread : null;
    const reuse =
      continuation === null && opts.freshBecause === undefined && reusesThreadPerItem(registry, agent, action)
        ? findReusableThread(db, { itemId: item.id, agent, cwd: workspace.cwd })
        : null;
    // A caller that refused the thread itself says why (EO-703), and that
    // sentence is this dispatch's refusal: posted on the run below, and
    // handed to the backend with the fresh context.
    if (opts.freshBecause !== undefined) staleReuse = opts.freshBecause;
    // `findReusableThread` never offers a candidate without a thread —
    // `notACandidate` excludes a run that has none — but `Run.threadId`
    // cannot say so in the type, and the difference between narrowing it
    // here and asserting it is `resume(null!, ...)` reaching a provider.
    // The item's files as this dispatch is about to tell the agent about
    // them (EO-703). Read before the context is, so a file that lands
    // while it is being assembled is missing from this hash rather than
    // claimed by it — the next dispatch then refuses the thread and the
    // file is seen, which is the safe side to be wrong on.
    const itemFiles = itemFilesHash(db, item.id);
    let resuming = continuation
      ? { run: continuation.from, threadId: continuation.threadId }
      : reuse?.kind === "resume" && reuse.run.threadId !== null
        ? { run: reuse.run, threadId: reuse.run.threadId }
        : null;

    // The full assembly, or the follow-up prompt when a thread is being
    // continued: what the agent has not already seen, which is the whole
    // saving. A run carried on after an interruption is told only why it
    // is being spoken to again: everything else is already in its thread.
    const context = continuation ? continuation.message : await buildContext(db, item, agent, action, resuming?.run ?? null);
    // And what the workspace lends this turn (EO-151, EO-295) — for a
    // git worktree, the index it may query rather than rediscovering the
    // repository. Above the boundary because answering it reads a row
    // and asks a binary, and below it nothing may await; the answer is a
    // small object, and it is the last thing this dispatch waits for.
    //
    // Asked per dispatch and deliberately not folded into the provider:
    // a provider is cached per agent and works every item that agent is
    // given, and what is lent here is pointed at one workspace. It is
    // also what makes a server that failed between two dispatches simply
    // stop being passed, with no cached object anybody has to
    // invalidate.
    const attachment = await attachWorkspace(item, agent, workspace);
    // This is the provider boundary. Everything above is preflight and
    // may yield to the event loop; everything below is synchronous until
    // start() has returned its stream. Rechecking here closes the race
    // where Pause arrived while auth, workspace, or context was loading.
    if (heldBack(agent, item.id) || !getItem(db, item.id) || shelved(item.id) || !isAgentAvailable(agent) || agentRetiredMidPreflight()) return;
    if (opts.stillEligible?.() === false) return;

    // And the tool surface, which the assembly above yielded the event
    // loop for (EO-107). `findReusableThread` weighed this thread up
    // against the catalogue as it was *before* that await; somebody
    // ticking a box during it would otherwise have the old thread
    // resumed against a directory generated from the new one — the
    // mismatch this story exists to make impossible.
    //
    // Read once, here, and used for all three of the decision, the
    // directory and the row below. There is no `await` between them, so
    // no edit can land in the middle: the read, the write and the row
    // are one synchronous block.
    const attachments = runAttachmentsHash(agent, item);
    // A continuation has only the message, not a context a fresh session
    // could start from, so it turns back having written nothing. Its
    // intent is still standing, and the next tick finds the changed tools
    // through `resumeBlockedReason` and starts the fresh session.
    if (continuation && (continuation.from.agentAttachmentsHash ?? EMPTY_ATTACHMENTS_HASH) !== attachments) return;
    // The same for the item's own files (EO-703): a continuation is told
    // nothing about the item, so one whose files changed during preflight
    // turns back too, and the next tick refuses its thread with a comment
    // (`resumeBlockedReason`) and starts the fresh one.
    if (continuation && (continuation.from.itemFilesHash ?? EMPTY_ITEM_FILES_HASH) !== itemFilesHash(db, item.id)) return;
    // And any other dispatch whose item's files changed during preflight
    // (EO-703). A resumed thread was chosen for the list as it stood
    // before the awaits above and is sent a follow-up that says nothing
    // about the item, so carrying it on now would leave the new file
    // unseen; a fresh context may have been read before the file landed.
    // Rebuilding here would be an await below the boundary, so the
    // dispatch turns back having written nothing. The next tick weighs the
    // thread up against the files as they are — refusing it with a
    // comment where it was born with another list — and assembles the
    // full context that lists them.
    if (!continuation && itemFilesHash(db, item.id) !== itemFiles) return;
    if (resuming && (resuming.run.agentAttachmentsHash ?? EMPTY_ATTACHMENTS_HASH) !== attachments) {
      staleReuse = staleAttachmentsRefusal(agent);
      resuming = null;
    }
    // What this agent has been given out of the two catalogues, written
    // where the backend can read it. Regenerated on every dispatch,
    // resumed threads included, because the CLI is spawned again each
    // turn and has to be pointed at the directory again.
    const toolDirectory = prepareToolDirectory(item, agent);

    const run = createRun(db, {
      itemId: item.id,
      agentId: agent.id,
      action,
      ...(opts.stepId ? { stepId: opts.stepId } : {}),
      status: "queued",
      // The thread this run is continuing, exactly as `resumeItem`
      // records it — so a crash mid-run leaves the conversation
      // recoverable from this row, and the next dispatch weighing up
      // reuse finds this run rather than the one before it.
      //
      // `cwd` and `provider` below need no such branch: a candidate
      // whose backend or directory differed from this dispatch's was
      // refused, so they are already the thread's own.
      ...(resuming ? { threadId: resuming.threadId } : {}),
      cwd: workspace.cwd,
      provider: runsOn(agent, item).provider, // whose session id thread_id will hold (A-07) — `fake` for a preview, which is what actually ran (EO-313)
      runtimeSource: runtimeSource(runsOn(agent, item)),
      // What this thread is being born with (EO-87). Neither backend
      // re-sends instructions on resume, so the only record of which ones
      // a thread got is the one written here, at the moment they are sent.
      // A continuation's thread was born with the interrupted run's, and
      // a resume re-sends none, so that is what this row records.
      instructionsHash: continuation ? continuation.from.instructionsHash : promptHash(agent.instructions),
      // And the other half of what this thread is being born with
      // (EO-106): the MCP servers and skills the agent has attached, as
      // a fingerprint of their resolved content. Recorded here for the
      // same reason and at the same moment — no backend re-sends
      // configuration on resume either, so this row is the only record
      // of the tool surface the session opened with.
      agentAttachmentsHash: attachments,
      // And the item's own files this thread was told about (EO-703). A
      // continuation tells it nothing new, so its thread keeps the list
      // the interrupted run's was born with.
      itemFilesHash: continuation ? continuation.from.itemFilesHash : itemFiles,
      initiationId,
      attempt: nextAttempt,
    });
    // The memory this turn is given (EO-478, ARCHITECTURE.md, "What an
    // agent is given"): the active entries of the item's project and of
    // the workspace its step works in, all of them when they are small,
    // otherwise the ones a selection picks. After the row, because the
    // selection is a side call *inside* this run — on its slot, against
    // its item's budget, recorded against it — and a side call names a
    // run that exists.
    //
    // Not on a continuation: that is the same turn carried on after an
    // interruption, and its thread already holds what it was given. It
    // keeps `memory_read` all the same, as every later turn of a thread
    // that was given memory does.
    //
    // The one await below the boundary, and only when a selection is
    // actually asked for: everything a small set needs is read here and
    // now. When it does yield, the boundary's question is asked again
    // after it, and a run that may no longer start is closed rather than
    // started (`closeBeforeStart`).
    const memoryScopes = turnMemoryScopes(item);
    let turnContext = context;
    if (!continuation) {
      const pending = memoryBeforeStart(run, item, agent, action, memoryScopes, agentRetiredMidPreflight);
      const memory = pending instanceof Promise ? await pending : pending;
      // Closed rather than started: the selection yielded and the world
      // changed meanwhile (`memoryBeforeStart`).
      if (memory === null) return;
      if (memory.section !== null) turnContext = `${context}\n\n${memory.section}`;
    } else {
      // A continuation chooses no memory again — its thread holds what it
      // was given — but is told how to write it all the same, since the
      // thread may predate the block (`memoryWritingFor`).
      turnContext = withMemoryWriting(context, agent, memoryScopes);
    }
    // A thread existed and EO chose not to carry it over. The item has
    // just paid for a full context assembly it might have been spared,
    // and nothing else on the board says why (invariant #8). Only a
    // refusal: the ordinary "nothing to reuse yet" of a first dispatch is
    // not a decision anyone needs telling about, and posting it would put
    // an engine comment on the opening of every item.
    //
    // After the recheck above, so a pause or a deleted item during
    // preflight leaves no explanation for a run that never happened, and
    // on the run that is paying for it rather than on the one that ended.
    if (reuse?.kind === "refused" || staleReuse) {
      postComment(db, {
        itemId: item.id,
        runId: run.id,
        author: { type: "engine" },
        kind: "note",
        // The later refusal wins where there is one: it is the reason
        // this run is assembling a full context, and the earlier answer
        // was "there is a thread to carry on".
        body: staleReuse ?? (reuse?.kind === "refused" ? reuse.reason : ""),
      });
    }
    // What the workspace could not lend, in its own words (EO-151,
    // invariant 8). Nothing is blocked and the run proceeds exactly as
    // it would have — which is precisely why it has to be said out loud,
    // because otherwise the only visible difference between "the index
    // answered" and "there was no index" is how much the agent spent
    // finding its way around. The kind decides what is worth a sentence;
    // this posts what it is given.
    for (const notice of attachment.notices) {
      postComment(db, {
        itemId: item.id,
        runId: run.id,
        author: { type: "engine" },
        kind: "note",
        body: notice,
      });
    }
    updateRun(db, run.id, { status: "running", startedAt: now() });
    // A run starting is news too. Until this, the first thing the project
    // heard about a run was it *ending*, so a card sat there looking idle
    // for the whole of its work.
    announceRun(run.id, item.id, "running");
    opts.onRunAdmitted?.();

    const controller = new AbortController();
    // Constrain generation natively where the action defines a shape
    // (ARCHITECTURE.md, "A run": demand structured output, never parse prose). Validation
    // still runs on the way back — this reduces failures, it doesn't
    // replace the check. Omitted entirely for an action with no schema,
    // rather than passed as undefined.
    const outputSchema = outputSchemaFor(registryFor(item), action, typeOf(item), definingRole(item, agent));
    const initiatingAttachments = initiationId
      ? listCommentsForItem(db, item.id).find((comment) => comment.id === initiationId)?.attachments ?? []
      : [];
    const turnOptions = {
      cwd: workspace.cwd,
      ...(outputSchema ? { outputSchema } : {}),
      ...discussionTurnOptions(item, agent),
      // What a backend warmed for this turn must also have been warmed
      // with (`prewarmConversation`): the tool surface's hash, which the
      // directory's path alone does not say.
      warmKey: attachments,
      ...(initiatingAttachments.length > 0 ? { attachments: safeTurnAttachments(initiatingAttachments) } : {}),
      ...(toolDirectory ? { toolDirectory: toolDirectory.path } : {}),
      ...(attachment.mcpServers[0] ? { repositoryMcp: attachment.mcpServers[0] } : {}),
      // The run and its directory, which is what the `eo` server needs
      // to offer `attachment_add` and to refuse a path truthfully
      // (EO-412).
      ...attachOption(item, run),
      // And the memory scopes this turn was drawn from, so the `eo`
      // server lists `memory_read` and reads those and no others
      // (EO-478).
      ...(memoryScopes.length > 0 ? { memoryScopes: memoryReadScopes(memoryScopes) } : {}),
      // And where its `eo` server hands what the agent writes (EO-543).
      ...writeBridgeOption(item),
      signal: controller.signal,
    };
    // Where the saving is actually taken. `instructions` are absent from
    // the resumed turn because neither backend accepts them there — the
    // session keeps the ones it was started with, which is exactly why
    // an edit to them refuses the reuse rather than being sent again.
    const stream = openTurn(item, workspace, () =>
      resuming
        ? sendingProvider(run, agent, item, action, { purpose: "dispatch" }).resume(resuming.threadId, turnContext, turnOptions)
        : sendingProvider(run, agent, item, action, {
            purpose: "dispatch",
            // Why a thread that existed is not being carried on, which is
            // the same sentence the comment above posted on the item.
            refusal: staleReuse ?? (reuse?.kind === "refused" ? reuse.reason : null),
          }).start({
            instructions: agent.instructions,
            context: turnContext, // ARCHITECTURE.md, "What an agent is given": seeded from the thread, or the whole of it for a conversational role — and the memory chosen for it
            ...turnOptions,
          }),
    );

    await runToCompletion(
      run,
      item,
      agent,
      action,
      stream,
      // The conversation a mid-run correction continues (A-02). Null
      // here would fork a second thread out of the first correction on
      // every resumed dispatch — the thread id only arrives on
      // `thread_started`, which a resumed turn never emits.
      resuming?.threadId ?? null,
      controller,
      {
        ...(opts.transitionOnSuccess !== undefined
          ? { transitionOnSuccess: opts.transitionOnSuccess }
          : {}),
        ...(toolDirectory ? { toolDirectory: toolDirectory.path, toolServerNames: toolDirectory.serverNames } : {}),
        attachment,
      },
    );
  }

  async function executeDispatch(dispatch: Dispatch, lease: DispatchLease): Promise<void> {
    // A run somebody stopped stays stopped (EO-175). `tick()` cannot ask
    // this — it is not a fact about the board, it is a decision a person
    // took about this initiation — so the scheduler's own door is where
    // it is asked, and only here: a mention runs under an initiation of
    // its own and a reply is the person themselves, so neither is
    // turned back by it.
    if (stopStands(db, dispatch.item.id, workflowInitiationId(dispatch.item, dispatch.action))) return;

    /**
     * The claim came with the offer (EO-322, EO-324).
     *
     * The record does not offer work it has not already leased to this
     * device — the pick and the grant are one call, because a dispatch
     * that is offered and not yet claimed is a window in which a second
     * device can be offered the same item. So there is nothing to
     * acquire here; what this does is register the claim so the tick
     * renews it while the run lasts.
     *
     * The item lock says *this process* is working on it; the lease
     * says *this machine* is, which is the half a second desktop would
     * otherwise have no way to hear.
     */
    device.adopt(lease);

    /**
     * Still the step this was decided from (EO-175).
     *
     * The decision to dispatch was made against the board as it was at
     * the top of the tick, and everything between here and the run row
     * yields the event loop: auth, a worktree, a context assembly, or
     * simply waiting for the item lock. `DispatchOptions.stillEligible`
     * was built for exactly this and only the mention path passed one,
     * so a scheduler dispatch could run on a decision of any age — and
     * write the step it was decided from onto the row, which is how
     * EO-173 left evidence of the implementer running at To Do while the
     * item sat at Index.
     */
    const stillEligible = (): boolean =>
      stepAuthorisationBlocker(dispatch.item.id, dispatch.agent, dispatch.stepId, dispatch.action) === null;

    // And then the device runs what it claimed. Which of the two ways
    // it runs it — an agent, or one of EO's own functions at a `builtin`
    // step — is `device.run`'s: everything the agent path does before
    // the provider, auth and attempt limits and context assembly, is
    // about talking to a model, so a builtin skips all of it and goes
    // straight to the work, the result, and the route.
    //
    // A `finally`, for the item lock's reason: a dispatch that throws
    // still gives the item back. Without it one failed dispatch would
    // hold the item until its lease ran out, which is minutes of an
    // item nobody is working on and nobody is offering.
    try {
      await device.run(dispatch, { stillEligible });
    } finally {
      await device.release(lease);
    }
  }

  /**
   * Where a step sends one named result, when its pipeline says at all
   * (EO-77, EO-297).
   *
   * Deliberately not `resolveNextState`. That is the path a *result*
   * takes, and both of its fallbacks are wrong for the two keys asked
   * for here: a step with no routes at all walks to the next one by
   * position there, which would advance a failed item exactly as a
   * successful one, and a result with no route posts its own "add a
   * route for it" escalation, which says nothing about what actually
   * went wrong. So this asks the graph one narrow question — is there an
   * explicit route for this key, and where does it lead — and everything
   * it cannot answer falls through to the park, which is what every
   * builtin failure did before this existed.
   *
   * Two keys reach it. `failed` is the runner saying it could not do its
   * work; `verification_failed` is the runner saying it did while the
   * workspace disagreed. One question, asked twice, because the answer
   * has the same shape and the same fallback either way.
   *
   * `user_attention` resolves to null on purpose. It means "ask a
   * person", which is what the park already does — and the park is the
   * version of that which carries the reason and the answers the function
   * offered, where a route can only carry its own label.
   */
  function routeOnResult(item: Item, step: PipelineStep | undefined, resultKey: string): NextStepDestination | null {
    if (!step) return null;

    // The item's own version's graph, not the pipeline's (EO-327, ARCHITECTURE.md, "Publish, lock
    // and versions").
    // A failure routed by a graph published while this run was in flight
    // is precisely the re-routing versions exist to stop, and it is the
    // sharpest case for it: the item is being sent somewhere on the
    // strength of a verdict it produced under the old rules.
    const bound = boundGraphForItem(db, item);
    const routes = bound?.routes ?? listRoutesForPipeline(db, step.pipelineId);
    if (!routes.some((route) => route.fromStepId === step.id && route.resultKey === resultKey)) return null;

    const steps = listPipelineSteps(db);
    const outcome = resolveRoute({
      step,
      steps: (bound?.steps ?? steps).filter((candidate) => candidate.pipelineId === step.pipelineId),
      routes,
      result: resultKey,
      stepsElsewhere: steps.filter((candidate) => candidate.pipelineId !== step.pipelineId),
    });
    return outcome.kind === "step" ? { stepId: outcome.stepId, pipelineId: outcome.pipelineId as Uuid, resultKey } : null;
  }

  /** Whether this step is mocked for this item (EO-584) — read synchronously, so asking costs a step that runs no turn of the event loop. */
  function isMockedOnTrial(item: Item, stepId: string | undefined): boolean {
    return item.trialAt !== null && trialStepMode(db, item, stepId ?? item.stepId).mode === "mocked";
  }

  /**
   * A step a trial plan mocks, on a trial item (EO-584, ARCHITECTURE.md,
   * "Step modes on a trial"). Answers true where it dealt with the
   * dispatch — the caller then runs nothing — and false for every step
   * that runs, which is every step on every item that is not a trial
   * item.
   *
   * Every door a step's work goes through asks this — the agent path's
   * and the builtin and module path's — so a scheduler dispatch, a reply
   * re-running a parked step and a mention alike report what the plan
   * names instead of running. Nothing is started: no run row, no backend,
   * no module host, no workspace. What happens instead is what a run
   * reporting the planned result would have caused:
   *
   *   * the plan's output is posted as an output comment, EO's own and
   *     opening with the mocked mark (`mockedOutputBody`), so the thread
   *     says nothing ran and nothing later can read it as the step's work;
   *   * the result key is routed by `routeResult` — the resolution every
   *     run's result takes, on the item's own version — and the item moves
   *     by `transitionItem`, with EO as the actor.
   *
   * Where the plan names nothing for this item, or the result routes to
   * a person or nowhere, the item is held where it is with the reason and
   * a comment (invariant #8), on a placeholder that names no thread — the
   * shape every refusal parks on — so the scheduler does not offer the
   * step again every tick. A person's reply re-runs it, which asks this
   * again: a plan fixed in between is what it reads.
   *
   * `answering` is the parked run a reply is answering (`resumeItemHeld`).
   * A mock writes no run of its own to supersede it, so where the item
   * moves the park is closed here — left open, the item would still read
   * as waiting for a person on the step it has moved to. Where the plan
   * still names nothing, the reply is answered by parking again, newer
   * than the reply, which is what stops the scheduler's recovery pass
   * offering the same reply on every tick.
   */
  async function runMockedStep(item: Item, agent: Agent | null, action: string, stepId: string | undefined, stillEligible?: () => boolean, answering?: Run): Promise<boolean> {
    const mode = trialStepMode(db, item, stepId ?? item.stepId);
    if (mode.mode !== "mocked") return false;
    if (stillEligible?.() === false) return true;
    // Re-read: the decision may be older than the item's last move, and a
    // step it has left is not this one's to report for.
    const current = getItem(db, item.id) ?? item;
    const step = current.stepId === mode.stepId ? stepForItem(db, current) : undefined;
    if (step === undefined) return true;
    const initiationId = workflowInitiationId(current, action);
    const hold = (reason: string): void => {
      const held = createRun(db, { itemId: current.id, agentId: agent?.id ?? null, action, status: "awaiting_input", initiationId, attempt: countAttempts(current.id, initiationId) + 1 });
      updateRun(db, held.id, { startedAt: now(), endedAt: now(), error: reason });
      announceRun(held.id, current.id, "awaiting_input");
    };

    if (mode.mock === null) {
      if (answering === undefined && alreadyRefused(current.id, initiationId)) return true;
      refuseDispatch(
        current,
        agent,
        action,
        `"${step.name}" is mocked on this trial, and the trial plan names no result for this test item, so the step was not run and the item has not moved. ` +
          "Add a result for it to the plan, or plan the step as real.",
        initiationId,
        countAttempts(current.id, initiationId) + 1,
      );
      return true;
    }

    postComment(db, { itemId: current.id, author: { type: "engine" }, kind: "output", body: mockedOutputBody(step.name, mode.mock.resultKey, mode.mock.output) });
    const next = routeResult(db, step, listPipelineSteps(db), mode.mock.resultKey, current);
    if (next === null) {
      const reason = `"${step.name}" is mocked on this trial and reported "${mode.mock.resultKey}", which leads nowhere from this step, so the item has not moved.`;
      postComment(db, { itemId: current.id, author: { type: "engine" }, kind: "escalation", body: reason, mentions: [{ type: "human" }] });
      hold(reason);
      return true;
    }
    // `routeResult` has said why in the thread already.
    if (isPark(next)) {
      hold(next.park);
      return true;
    }
    if (answering !== undefined) {
      updateRun(db, answering.id, { status: "cancelled", endedAt: answering.endedAt ?? now() });
      announceRun(answering.id, current.id, "cancelled");
    }
    record.applyTransition({ itemId: current.id, toStepId: next.stepId, toPipelineId: next.pipelineId, actor: "engine", reason: MOCKED_STEP_REASON, resultKey: mode.mock.resultKey });
    await settleItem(current, next.stepId);
    return true;
  }

  /**
   * One run of a `builtin` step (ARCHITECTURE.md, "A step").
   *
   * A real run row, for the reason the step exists at all: the worktree and
   * the pull request were invisible side effects, and a thing that can take
   * time and fail needs somewhere to say so. `agentId` is null — there is
   * no agent — and the result routes through exactly the same table an
   * agent's verdict does, so nothing here decides where the item goes.
   *
   * Both ways of not succeeding park the item at `awaiting_input`: a
   * builtin has no attempt cap, so a step left on an agent-owned column
   * is a step the scheduler offers again on the next tick, forever.
   * `resumeItem` re-runs it when a person replies.
   */
  async function runBuiltin(
    item: Item,
    action: string,
    stepId?: string,
    opts: BuiltinRunOptions = {},
  ): Promise<void> {
    // The same claim an agent dispatch takes, and for the same reason
    // (EO-132): a builtin cuts worktrees and opens pull requests, and a
    // module runs somebody's code in the item's checkout. Held for the
    // whole run, released however it ends.
    //
    // `resumeItem` is the one caller that already holds it — a reply
    // to a parked builtin re-runs the function as part of the work the
    // reply claimed the item for.
    if (opts.holdingItemLock === true) {
      await runBuiltinHeld(item, action, stepId, opts);
    } else {
      await itemLock.run(item.id, () => runBuiltinHeld(item, action, stepId, opts));
    }
    await handWatchToRecord(item, stepId);
  }

  /**
   * After a check of a step that keeps checking, tell the record where
   * the watch stands before anything else happens to the item (EO-456).
   *
   * On a desktop signed in to an organisation the watch is shared state:
   * the record holds the item until the next check from its own copy of
   * the row, and the next device it leases the item to carries the watch
   * on from that copy. The lease is given back the moment this returns,
   * and a record that had not heard about the check would offer the item
   * again at once — to a device that would check it again with the old
   * watch's clock, failures and news. So what this check queued goes now
   * rather than on the next tick.
   *
   * Nothing on a solo desktop, where this database is the record. A
   * record that cannot be reached keeps the report queued for the next
   * sync, which is what every other report does.
   */
  async function handWatchToRecord(item: Item, stepId: string | undefined): Promise<void> {
    if (record.flush === undefined || item.previewAt !== null || stepToWatch(item, stepId) === undefined) return;
    try {
      await record.flush();
    } catch (error) {
      console.warn(`[eo] the watch on ${item.key} could not be handed to the record yet: ${String(error)}`);
    }
  }

  /** `runBuiltin` with the item already claimed. Never call it directly. */
  async function runBuiltinHeld(item: Item, action: string, stepId?: string, opts: BuiltinRunOptions = {}): Promise<void> {
    if (paused) return;
    // After the claim, which is what the wait was (EO-347): an archive
    // that landed while this queued behind another run is as final as a
    // pause that did.
    if (shelved(item.id)) return;
    // Asked here rather than before the claim, because the claim is what
    // the wait was (EO-175). An item held by an agent run hands the lock
    // over minutes later, and a module that queued behind it would
    // otherwise start on whatever the board said when the tick decided —
    // a step the item may long since have left. Nothing below yields
    // before the run row, so once is enough.
    if (opts.stillEligible?.() === false) return;

    // A step a trial plan mocks runs no module and no builtin (EO-584).
    if (isMockedOnTrial(item, stepId)) {
      await runMockedStep(item, null, action, stepId);
      return;
    }

    // Before the classification below, because with nothing installed
    // that classification is what misreports (KAN-144). An empty
    // registry knows no builtin actions, so `open_pull_request` reads
    // as a module id and the step parked saying a module was missing,
    // deleted or unapproved — a sentence about something the pipeline
    // never named, on a step whose function is simply not installed.
    //
    // No role in the question: this path is a `builtin` or a `module`
    // step and both are owned by nobody, so the refusal names the
    // function instead. Asked before the step is read because it
    // answers null in every installation that has a pack, which is
    // every installation but the one this guard is about.
    const unavailable = dispatchRefusal({ role: null, action });
    if (unavailable !== null) {
      const onStep = stepId ?? item.stepId;
      // The item's own version's definition where the step is the one it
      // is standing on (EO-327); a named step it has since left is read
      // live, because there is no version of this item that describes it.
      const dispatchedStep =
        onStep === null || onStep === undefined ? undefined : onStep === item.stepId ? stepForItem(db, item) : getStep(db, onStep);
      // A `module` step is exempt, and reading the step's own row is the
      // only way to know: a module is the core's own machinery
      // (KAN-105), its host is nobody's pack, and it runs perfectly well
      // with nothing installed. Where there is no step row to read — a
      // reply re-running a parked function names no step — the item's
      // own is the same answer, and a builtin with no step at all is
      // refused, which is right: nothing installed means nothing to run
      // it.
      if (dispatchedStep?.type !== "module") {
        const refusalInitiation = workflowInitiationId(item, action);
        if (alreadyRefused(item.id, refusalInitiation)) return;
        // The same refusal an agent dispatch gets, through the same
        // function: a parked run carrying the reason and an escalation
        // naming it, so the scheduler stops offering the step and a
        // person is told why rather than left watching nothing happen
        // (invariant #8).
        refuseDispatch(item, null, action, unavailable, refusalInitiation, countAttempts(item.id, refusalInitiation) + 1);
        return;
      }
    }

    // A builtin names one of EO's own functions; anything else on this
    // path is a module id (KAN-105). The two cannot collide — builtin
    // actions are fixed names and module ids are UUIDv7 — and keeping
    // them apart in the run row is what leaves a transcript able to say
    // whether audited code or approved code ran.
    const builtin = isBuiltinAction(registry, action);
    // A preview runs neither (EO-313, ARCHITECTURE.md, "Preview").
    //
    // An agent step on a preview is swapped onto the fake backend and
    // still runs, because what it produces is words and words are what a
    // person came to watch. A `builtin` or a `module` step has nothing
    // to swap: its whole content is the effect — a branch cut, a pull
    // request opened, a message posted — and there is no rehearsal of
    // opening a pull request that is not opening one.
    //
    // A module is refused inside its own lookup rather than here,
    // because the sentence is better there: that side holds the
    // module's name and the inputs this step resolved, which is the
    // difference between "would have sent" and "would have sent to
    // #marketing". This branch is the builtin half, which has a fixed
    // name and no inputs to state.
    //
    // The first result the registry declares, so the item carries on
    // down the pipeline — `BUILTIN_RESULTS` orders them with the
    // function's own success first, and a preview that stopped at the
    // worktree step would have shown a person the first column and
    // nothing else.
    const previewing = item.previewAt !== null;
    const runner =
      previewing && builtin
        ? previewBuiltinRunner(action, builtinResults(registry, action))
        : builtin
          ? builtins[action]
          : moduleRunner?.(action);

    // A step that keeps checking (EO-456). The check runs first, with no
    // run row: one that comes back waiting with nothing new writes the
    // item's watch and a line on the stay's quiet run, and only a check
    // with more to record makes a run of its own. A result key comes back
    // here with its row made, and goes the rest of the way exactly as a
    // step that runs once does — the same verification, the same routes,
    // the same `transitionItem`.
    //
    // Not on a preview, whose builtins and modules do not run at all.
    const watchingStep = previewing ? undefined : stepToWatch(item, stepId);
    let checked: CheckedResult | null = null;
    if (watchingStep !== undefined) {
      checked = await runWatchCheck(item, action, watchingStep, runner, builtin, opts.resumingWatch === true);
      if (checked === null) return;
    }

    const run = checked?.run ?? createRun(db, { itemId: item.id, agentId: null, action, ...(stepId ? { stepId } : {}), status: "running", provider: builtin ? "builtin" : "module" });
    if (checked === null) updateRun(db, run.id, { startedAt: now() });
    announceRun(run.id, item.id, "running");

    // Registered so this run can be cancelled like any other.
    //
    // Without it `cancelRun` was a silent no-op here: it looks the run up
    // in `activeControllers`, which only the agent path filled. So
    // dragging an item off a running module posted "run cancelled
    // because you moved this" — a false statement — while the deploy
    // carried on. `pause({cancelRunning})` and `shutdown()` iterate the
    // same map and were equally powerless.
    const controller = new AbortController();
    activeControllers.set(run.id, controller);

    // The transcript. One buffer for the whole run, shared by a builtin's
    // narration and a module's output: `run_events.seq` is allocated in
    // memory per buffer, so two buffers over one run would hand out the
    // same numbers twice and the transcript would drop rows.
    //
    // Registered under `activeEventBuffers` for exactly the span the
    // controller is, and for the same reason the agent path registers
    // its own: a person can say something to this run while it is going
    // (EO-176), and `recordMessageOnRun` writes that message through
    // whichever buffer is live rather than reading `max(seq)` off the
    // disk. Left unregistered, the message was inserted with the number
    // this buffer had already handed out in memory, and the buffer's
    // next timed flush died on the unique index — an uncaught throw in
    // the main process, on the run the person was watching.
    //
    // Flushed before each push rather than after: the push says "there is
    // more", the renderer reads `run_events`, and pushing ahead of the
    // write means it reads nothing and does not come back. Throttled for
    // the same reason the agent path is — a chatty module produces lines
    // faster than a round trip.
    const buffer = createRunEventBuffer(db);
    activeEventBuffers.set(run.id, buffer);
    let pushScheduled: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const pushTranscript = (): void => {
      buffer.flush();
      onPushEvents?.(run.id, []);
    };
    const report = (text: string): void => {
      buffer.append(run.id, "output", { type: "output", text });

      // After the run's log is closed there is no timer left to carry
      // this, so it is written on the spot. A module that was killed
      // keeps its stdout handler attached while the tree dies
      // (`runModule`'s kill grace), so its last words arrive here after
      // everything else has finished — and those are the words you want.
      // Buffering them behind a timer that will never fire again is how
      // they were being dropped for the process's lifetime.
      if (closed) {
        pushTranscript();
        return;
      }

      if (pushScheduled) return;
      pushScheduled = setTimeout(() => {
        pushScheduled = null;
        pushTranscript();
      }, pushThrottleMs);
      pushScheduled.unref?.();
    };
    const closeTranscript = (): void => {
      closed = true;
      // Nulled, not merely cleared: a cleared handle is still truthy, so
      // leaving it set made the `pushScheduled` guard above permanent.
      if (pushScheduled) clearTimeout(pushScheduled);
      pushScheduled = null;
      buffer.dispose();
      // Released in the same breath as it is disposed, so a message that
      // lands after this reads the persisted maximum — which, with the
      // final flush done, is the whole truth. A late `report` above still
      // writes through the disposed buffer and flushes on the spot, so
      // the two allocators never hold different numbers across an await.
      activeEventBuffers.delete(run.id);
      onPushEvents?.(run.id, []);
    };

    /**
     * Where this run worked, recorded as it is asked for (EO-297).
     *
     * A builtin and a module are handed the *preparation* rather than
     * the kind — they ask for somewhere to work and are told where — so
     * until this story nothing outside the runner knew which directory
     * that was, and `runs.cwd` was null on every one of these rows while
     * the agent path had written it since EO-295. That null was the
     * whole reason verification could not reach here: the check asks a
     * workspace what happened in it, and nobody had said which one.
     *
     * The run's own, not the item's. A function that asked for nowhere
     * to work did nothing anywhere to check, and preparing one on its
     * behalf in order to have something to verify would cut a worktree
     * as a side effect of asking a question.
     *
     * On the row rather than in a variable, deliberately: the row is
     * what a person inspecting the run reads, what a crash leaves
     * behind, and — since the check below reads it back, and so does the
     * artifact path after it (EO-298) — the one account of where this
     * run happened.
     */
    const prepareAndRecord = async (forItem: Item, forAction: string, request?: PrepareWorkspaceRequest): Promise<PrepareWorkspaceOutcome> => {
      const prepared = await prepareWorkspace(forItem, forAction, request);
      if (prepared.ok) updateRun(db, run.id, { cwd: prepared.workspace.cwd });
      return prepared;
    };

    // A step naming a function EO does not ship, or a module that is
    // gone, archived or unapproved. The validator rejects the first at
    // save time, and a module can lose its approval after a pipeline was
    // published — either way invariant #8 says it ends in a comment.
    // What the check said while it ran, onto this run's transcript now
    // that there is one (EO-456).
    for (const line of checked?.lines ?? []) report(line);

    // What the step set for its inputs (EO-459): the item's own version's
    // definition where it is the step the item stands on, for
    // `dispatchedStep`'s reason above.
    const ranStep = stepId === undefined || stepId === item.stepId ? stepForItem(db, item) : getStep(db, stepId);

    const ran: BuiltinOutcome = checked
      ? checked.outcome
      : runner
      ? await runner({
          db,
          item,
          prepareWorkspace: prepareAndRecord,
          report,
          runId: run.id,
          // A module's host starts in the run's own scope (EO-738).
          processScope: processScopeOf(run.id),
          signal: controller.signal,
          ...(ranStep ? { inputs: ranStep.inputs } : {}),
        }).catch((error: unknown) => ({
          ok: false as const,
          reason: error instanceof Error ? error.message : String(error),
        }))
      : {
          ok: false,
          reason: builtin
            ? `"${action}" is not one of EO's built-in functions.`
            : `This step runs a module that is missing, deleted, or no longer approved. Check it under Settings → Modules.`,
        };
    // A host its scope stopped for running out of memory (EO-738) dies
    // like any other failure from inside; its scope is what says so, and
    // the sentence that does is what the run's log and park carry.
    const outOfMemory = !checked && runner ? await moduleRanOutOfMemory(ran, run.id) : null;
    const ranOutWords = outOfMemory === null ? null : outOfMemoryReason(outOfMemory, null, action);
    const outcome: BuiltinOutcome = ranOutWords === null ? ran : { ok: false, reason: ranOutWords };

    activeControllers.delete(run.id);

    // Cancelled while it ran. The agent path discards a late result for
    // the same reason (`forcedCancellationRunIds`): whoever cancelled has
    // already been told the run stopped, and moving the item on what it
    // returned would silently undo their decision.
    //
    // Checked before the outcome is written to the log, not after. What a
    // cancelled call returns is not a report, it is whatever its
    // half-killed git and forge calls degraded into — an unresolvable ref,
    // or a dependency that looks unmerged because the fetch that would
    // have said otherwise was killed. Writing that into the transcript
    // gave a run the person themselves stopped a red line blaming their
    // repository.
    if (forcedCancellationRunIds.has(run.id)) {
      forcedCancellationRunIds.delete(run.id);
      closeTranscript();
      updateRun(db, run.id, { status: "cancelled", endedAt: now() });
      announceRun(run.id, item.id, "cancelled");
      return;
    }

    // What it ended up doing, on the run's own log — a red line for a
    // refusal, the reported result for anything else. The reason already
    // reaches `runs.error` and a comment; this is the third place it
    // belongs, because a person reading a transcript to find out what
    // happened should not have to leave it to learn that it failed.
    if (outcome.ok) {
      if (outcome.detail !== "") buffer.append(run.id, "output", { type: "output", text: outcome.detail });
    } else {
      buffer.append(run.id, "error", { type: "error", message: outcome.reason });
    }
    closeTranscript();

    // Re-read rather than trusting the dispatch-time snapshot, on both
    // the failure path and the success one. A module can run for
    // minutes, and so can the pull request builtin now that it opens one
    // rather than queueing it (EO-77) — acting on the step the item sat
    // on *then* would move it out of wherever a person has since put it,
    // using a result that step never declared.
    const current = getItem(db, item.id) ?? item;
    const moved = current.stepId !== item.stepId;
    const step = stepForItem(db, current);

    // Out of memory (EO-738): the run `failed`, not a question, and not
    // routed — a module's failure is never a result the graph routes, and
    // trying again runs into the same limit. The item parks and asks, as
    // an agent's run that ran out does; one a person has moved meanwhile
    // is not frozen on the step they chose, only told.
    if (outOfMemory !== null && ranOutWords !== null) {
      if (moved) {
        updateRun(db, run.id, { status: "failed", error: ranOutWords, endedAt: now() });
        postComment(db, {
          itemId: item.id,
          runId: run.id,
          author: { type: "engine" },
          kind: "escalation",
          body: ranOutWords,
          mentions: [{ type: "human" }],
        });
        announceRun(run.id, item.id, "failed");
        return;
      }
      endOutOfMemory(run.id, item, null, action, null, outOfMemory);
      return;
    }

    if (!outcome.ok) {
      // Where this pipeline sends a failure, when it says (EO-77).
      //
      // A builtin only. `failed` is one of the results `BUILTIN_RESULTS`
      // declares for EO's own functions, so a builtin's refusal is a
      // result the graph can be wired for. A module declares its own
      // results and can already return one meaning "it did not work" —
      // `{ ok: false }` from a module stays the narrower thing it always
      // was, "I could not run at all", which is a question for whoever
      // configured it rather than a branch in the graph (KAN-105).
      //
      // Null for an item that has moved, either way: routing it from a
      // step it has left is the mistake the success path below refuses to
      // make.
      const destination = builtin && !moved ? routeOnResult(item, step, FAILED_RESULT) : null;

      if (destination) {
        // Routing a failure straight back into the step that produced it
        // is the forever-loop the park below exists to prevent, restored
        // by configuration: a builtin has no attempt cap, so the same
        // refusal would be re-dispatched on every tick, minting a run and
        // a comment each time. Nothing rejects the wiring — a cycle is
        // legitimate in a pipeline, and `validatePipeline` only asks
        // whether a terminal is still reachable, which it is by the
        // success route. So it is refused here, where the loop would
        // actually close, and the item parks with the reason instead.
        //
        // A cycle through *another* step is not caught: that one gets a
        // whole tick and any attempt cap the step in between has, which
        // is a different situation from a step re-running itself with
        // nothing changed.
        if (destination.stepId === step?.id) {
          updateRun(db, run.id, { status: "awaiting_input", error: outcome.reason, endedAt: now() });
          postComment(db, {
            itemId: item.id,
            runId: run.id,
            author: { type: "engine" },
            kind: "escalation",
            body:
              `"${action}" could not finish: ${outcome.reason}\n\n` +
              `"${step?.name ?? "This step"}" routes its own failures back to itself, which would run it again against exactly what it just refused, so this is waiting for you instead.`,
            mentions: [{ type: "human" }],
            ...(outcome.options && outcome.options.length > 0 ? { options: outcome.options } : {}),
          });
          announceRun(run.id, item.id, "awaiting_input");
          return;
        }

        // Unless that is a pipeline this item may not enter (EO-610), by
        // its data rules or its module rules (EO-736). What is written
        // with the move is written where the module rules are last
        // judged, so nothing is said of a move that did not happen.
        const enter = (): void => {
          // The graph has somewhere for this to go, so the item goes
          // there instead of stopping. `failed` on the run, because it did
          // not do its work — and unlike the park below, a failed run does
          // not hold the item still, which is exactly right when the
          // pipeline has just said who picks it up next.
          updateRun(db, run.id, {
            status: "failed",
            error: outcome.reason,
            result: { raw: outcome, parsed: { result: FAILED_RESULT } },
            endedAt: now(),
          });
          // Invariant #8 — every guard ends in a comment.
          //
          // A note when EO is *reporting* something: the pipeline named who
          // handles this, and mentioning a human as well would raise `!` on
          // an item already on its way somewhere that deals with it.
          //
          // An escalation when it is *asking* something. `options` is what
          // tells the two apart — a refusal that names the answers it would
          // take is a question, and a tied stack target is the live example:
          // the only thing that resolves it is a person replying with one of
          // those keys, read back out of this thread. Routing the item
          // does not answer it, so posting the reason without the question
          // asked one nobody could ever hear.
          const asking = outcome.options !== undefined && outcome.options.length > 0;
          postComment(db, {
            itemId: item.id,
            runId: run.id,
            author: { type: "engine" },
            kind: asking ? "escalation" : "note",
            body: `"${action}" could not finish: ${outcome.reason}`,
            ...(asking ? { options: outcome.options, mentions: [{ type: "human" as const }] } : {}),
          });
          record.applyTransition({
            itemId: item.id,
            toStepId: destination.stepId,
            toPipelineId: destination.pipelineId,
            actor: "engine",
            runId: run.id,
            reason: "built-in step failed",
            resultKey: destination.resultKey ?? null,
          });
        };
        const refused = handOffRefusal(db, item, destination) ?? (await handOffModuleRefusal(db, item, destination, enter));
        if (refused !== null) {
          updateRun(db, run.id, { status: "awaiting_input", error: refused, endedAt: now() });
          announceRun(run.id, item.id, "awaiting_input");
          return;
        }
        await settleItem(item, destination.stepId);
        announceRun(run.id, item.id, "failed");
        return;
      }

      if (builtin && moved) {
        // Failed after a person moved it. Said, because a pull request
        // that did not open is not something anything else will mention —
        // but deliberately not parked: `awaiting_input` keeps the
        // scheduler away from the item entirely, and freezing it on a
        // step somebody has just chosen for it would be the run reaching
        // out of its own lane.
        updateRun(db, run.id, {
          status: "failed",
          error: outcome.reason,
          result: { raw: outcome, parsed: { result: FAILED_RESULT } },
          endedAt: now(),
        });
        postComment(db, {
          itemId: item.id,
          runId: run.id,
          author: { type: "engine" },
          kind: "escalation",
          body: `"${action}" could not finish, and this ticket had moved on by the time it stopped, so nothing was routed: ${outcome.reason}`,
          mentions: [{ type: "human" }],
          ...(outcome.options && outcome.options.length > 0 ? { options: outcome.options } : {}),
        });
        announceRun(run.id, item.id, "failed");
        return;
      }

      // Nowhere to send it, so it stops here and asks — the default, and
      // still the only behaviour a pipeline that routes nothing gets.
      //
      // `awaiting_input`, not `failed`: the difference is whether the
      // item parks. Nothing in the scheduler skips an item whose last
      // run failed, so a builtin whose precondition can never be met (a
      // story with no repository, say) used to be re-dispatched on every
      // tick forever, minting a run and an inbox item each time. Parking
      // is what the refusal below it already does for an unroutable
      // result, and what `refuseDispatch` does on the agent path.
      updateRun(db, run.id, { status: "awaiting_input", error: outcome.reason, endedAt: now() });
      postComment(db, {
        itemId: item.id,
        runId: run.id,
        author: { type: "engine" },
        kind: "escalation",
        body: `${runSubject(db, run)} could not finish: ${outcome.reason}`,
        mentions: [{ type: "human" }],
        // A builtin that stopped to ask something names the answers it
        // would take; one that stopped because of a fact names none.
        ...(outcome.options && outcome.options.length > 0 ? { options: outcome.options } : {}),
      });
      announceRun(run.id, item.id, "awaiting_input");
      return;
    }

    // A check answering `waiting` on a step that runs once (EO-505).
    //
    // `validatePipeline` refuses the configuration now, but a pipeline
    // published before it can still run a function or module that waits
    // on a step with keep checking off. Nothing will ask it again, so the
    // answer is not a result to route: routing it was what told a person
    // to add a `waiting` route, which published and then looped the item
    // round to a check that said `waiting` again. A step that keeps
    // checking never reaches this line with `waiting` — `runWatchCheck`
    // handles that answer and returns null — so this is only ever the
    // step that runs once. An item a person has moved is left to the
    // note below that says so, rather than parked on a step it has left.
    //
    // What the comment offers is what will actually work for *this*
    // item. Turning keep checking on publishes a new version, and an
    // item finishes on the version it entered on (EO-327): `stepForItem`
    // goes on reading this step as one that runs once, so neither a
    // reply nor the scheduler would start a watch for it, and saying
    // otherwise would send the person round to this same park. So the
    // setting is named for the items that enter afterwards, and this one
    // is offered what its own version can do: a reply checks once more,
    // and routes if what it waits on has happened; or a move by hand.
    if (outcome.result === WAITING_RESULT && checked === null && !moved) {
      // The function by name for a builtin; a module's action is its id,
      // which means nothing to the person reading, so it is named by the
      // step it runs on instead.
      const stepName = step?.name ?? "this step";
      const subject = builtin ? `"${action}"` : `The module on "${stepName}"`;
      const reason = `${subject} answered "${WAITING_RESULT}", but "${stepName}" runs once, so nothing would ask it again.`;
      updateRun(db, run.id, { status: "awaiting_input", result: { raw: outcome, parsed: { result: WAITING_RESULT } }, error: reason, endedAt: now() });
      postComment(db, {
        itemId: item.id,
        runId: run.id,
        author: { type: "engine" },
        kind: "escalation",
        parseBodyMentions: false,
        body:
          `${subject} answered "${WAITING_RESULT}": it checks on something until it has a result, and "${stepName}" runs it once, so nothing will ask it again. ` +
          `"${stepName}" needs keep checking turned on.\n\n` +
          `Turning it on in the pipeline's settings reaches items that enter this pipeline afterwards, not this one: it finishes on the version it entered on, where "${stepName}" runs once. ` +
          `For this one, reply here to check once more — it carries on if what it waits on has happened, and stops here again if not — or move it on by hand.`,
        mentions: [{ type: "human" }],
      });
      announceRun(run.id, item.id, "awaiting_input");
      return;
    }

    // G-02 on this path as well (EO-297, invariant 5).
    //
    // A builtin and a module claim things about a workspace exactly as
    // an agent does — a branch pushed, a report written into a folder —
    // and until this story nobody asked the workspace whether any of it
    // was true: `verify` was called from the agent path alone, so a
    // module step could say whatever it liked and be believed. The claim
    // is checked here for the agent path's reason and at the same moment
    // in the sequence: after the result is in hand and before anything
    // routes on it.
    //
    // The run is read back rather than carried, because `cwd` is what
    // the runner's own preparation wrote there and a run that prepared
    // nowhere has nothing that could be checked.
    const checks = await checkWorkspace({ id: run.id, cwd: getRun(db, run.id)?.cwd ?? null }, current, action, { result: outcome.result }, "succeeded", null);
    const verification = evidenceOf(checks);
    const blocked = blockingFailure(checks);
    if (blocked) {
      // Every check, not only the one that failed: what was looked at is
      // as much of the answer as what came of it, and a person reading
      // this is deciding whether to believe the run (invariant 5).
      const account =
        `${runSubject(db, run)} finished, but ${current.key}'s workspace could not confirm what it did.\n\n` +
        `${describeChecks(checks)}` +
        (blocked.comment ? `\n\n${blocked.comment}` : "");
      const failedTo = moved ? null : verificationRoute(current, action, step);
      const failed = {
        status: "failed" as const,
        result: { raw: outcome, parsed: { result: VERIFICATION_FAILED_RESULT } },
        ...(verification ? { verification } : {}),
        checks: keptChecks(checks),
        error: blocked.describes,
        endedAt: now(),
      };

      if (failedTo) {
        // The graph has somewhere for a failed verification to go, so
        // the item goes there rather than stopping. A note rather than
        // an escalation, for the failure route's reason: the pipeline
        // has named who picks this up, and mentioning a human as well
        // would raise `!` on an item already on its way to someone.
        // Written where the module rules are last judged (EO-736).
        const enter = (): void => {
          updateRun(db, run.id, failed);
          postComment(db, { itemId: current.id, runId: run.id, author: { type: "engine" }, kind: "note", body: account });
          record.applyTransition({
            itemId: current.id,
            toStepId: failedTo.stepId,
            toPipelineId: failedTo.pipelineId,
            actor: "engine",
            runId: run.id,
            // A watch's move says so whichever route it took (EO-456): a
            // check whose claim the workspace refused is a round trip like
            // any other, and the guardrail counts exactly these.
            reason: checked ? WATCH_VERIFICATION_FAILED_REASON : "verification failed",
            resultKey: failedTo.resultKey ?? null,
          });
        };
        // Unless that is a pipeline this item may not enter (EO-610).
        const refusedHandOff = handOffRefusal(db, current, failedTo) ?? (await handOffModuleRefusal(db, current, failedTo, enter));
        if (refusedHandOff !== null) {
          updateRun(db, run.id, { ...failed, status: "awaiting_input", error: refusedHandOff });
          postComment(db, { itemId: current.id, runId: run.id, author: { type: "engine" }, kind: "note", body: account });
          announceRun(run.id, item.id, "awaiting_input");
          return;
        }
        await settleItem(current, failedTo.stepId);
        announceRun(run.id, item.id, "failed");
        return;
      }

      if (moved) {
        // Checked after a person moved it. Said, because a claim nothing
        // could confirm is worth knowing about wherever the item has
        // gone — but deliberately not parked, for the reason the failure
        // path above gives: freezing an item on a step somebody has just
        // chosen for it would be the run reaching out of its own lane.
        updateRun(db, run.id, failed);
        postComment(db, {
          itemId: current.id,
          runId: run.id,
          author: { type: "engine" },
          kind: "escalation",
          body: `${account}\n\nThis ticket had moved on by the time that was checked, so nothing was routed and it has been left where it is.`,
          mentions: [{ type: "human" }],
        });
        announceRun(run.id, item.id, "failed");
        return;
      }

      // Nothing routes it, so it stops here and asks — the same park an
      // unroutable result and a refusal both get on this path, and the
      // behaviour a pipeline that declares no `verification_failed`
      // route keeps.
      updateRun(db, run.id, { ...failed, status: "awaiting_input" });
      postComment(db, {
        itemId: current.id,
        runId: run.id,
        author: { type: "engine" },
        kind: "escalation",
        body: `${account}\n\nNothing in this pipeline routes a failed check, so this is waiting for you.`,
        mentions: [{ type: "human" }],
      });
      announceRun(run.id, item.id, "awaiting_input");
      return;
    }

    // What it did lives on the run — its result, its elapsed time, its
    // status. Deliberately not a comment: a builtin succeeds on almost
    // every item, and "the worktree is ready" in every thread would be
    // noise in the one place agents actually read (invariant #4 is about
    // having a channel, not about narrating into it). A failure does
    // comment, above, because that is a guard and guards must be seen.
    updateRun(db, run.id, {
      status: "succeeded",
      result: { raw: outcome, parsed: { result: outcome.result } },
      ...(verification ? { verification } : {}),
      checks: keptChecks(checks),
      endedAt: now(),
    });

    // A check that did not pass and does not block: the work stands, the
    // item moves, and what was noticed is said on the item — the same
    // note the agent path posts, from the same function.
    postCheckNotes(current, checks);

    // And what it *produced*, which is a different question from what it
    // did (EO-298, ARCHITECTURE.md, "The interface"). A module is the
    // whole reason this path needs it: the report a step writes into a
    // folder is exactly the kind of deliverable an output comment exists
    // to carry, and until this line the only run that could post one was
    // an agent's. The design asks the supervisor on the agent path and on the
    // builtin and module path alike, and the kind decides for itself
    // whether this action produced anything — git answers with nothing
    // for `create_worktree` and `open_pull_request`, so no installation
    // that has one today gains a comment it did not have.
    //
    // In the agent path's place in the sequence, which since EO-297 is
    // a real position rather than a convention: *after* the verification
    // above, which returns before this on a blocking failure, so EO does
    // not claim a ticket has produced something on work its own
    // workspace has just refused to confirm. Before the routing below,
    // so the output is on the ticket by the time whatever this routes to
    // is dispatched against it.
    //
    // A module speaks as a module and a builtin as EO, which is the
    // attribution each of their other comments already carries. The run
    // is read back for `cwd` for `checkWorkspace`'s reason: it is the
    // runner's own preparation that wrote it there.
    await postArtifacts(
      { id: run.id, cwd: getRun(db, run.id)?.cwd ?? null },
      current,
      builtin ? { type: "engine" } : { type: "module" },
      action,
      { result: outcome.result },
      "succeeded",
      null,
    );

    if (moved) {
      updateRun(db, run.id, {
        status: "succeeded",
        result: { raw: outcome, parsed: { result: outcome.result } },
        error: `Finished after this ticket was moved to another step, so it was left where it is.`,
        endedAt: now(),
      });
      postComment(db, {
        itemId: item.id,
        runId: run.id,
        author: { type: "engine" },
        kind: "note",
        body: `${runSubject(db, run)} finished with "${outcome.result}" after you moved this ticket, so it has been left where it is rather than routed from the step it started on.`,
      });
      announceRun(run.id, item.id, "succeeded");
      return;
    }

    const next = step ? nextStateFor(step, listPipelineSteps(db), { result: outcome.result }, action, current, null) : null;

    if (next && isPark(next)) {
      updateRun(db, run.id, { status: "awaiting_input", error: next.park, endedAt: now() });
      announceRun(run.id, item.id, "awaiting_input");
      return;
    }

    if (next === null) {
      // The function worked but its result goes nowhere: a route pointing
      // at a terminal this pipeline does not have, or a result the step
      // could not match and that has no name to report. A result that
      // *is* named but unroutable parks in the wiring instead (EO-59),
      // which is where its comment is written. Succeeding without moving
      // leaves the item exactly where the scheduler will find it again,
      // which is the same forever-loop the failure branch above had. No
      // comment is posted here: a second one for the same stop would be
      // the duplicate, not the guard.
      updateRun(db, run.id, {
        status: "awaiting_input",
        error: `${runSubject(db, run)} reported "${outcome.result}", which has no route out of "${step?.name ?? "this step"}".`,
        endedAt: now(),
      });
      announceRun(run.id, item.id, "awaiting_input");
      return;
    }

    // A pipeline's module entry rules, where the destination is another
    // pipeline (EO-736): parked and asked, as a route its data rules
    // refuse is.
    // The move is made in the same pass as their last judgement.
    //
    // `engine`, not an agent id: EO did this itself, and attributing it
    // to an agent would put a name in the audit log that never ran.
    //
    // A builtin hands work on exactly as an agent does: same actor, same
    // run id, same reason, and the destination's pipeline alongside its
    // step (EO-59).
    const enter = (): void => {
      record.applyTransition({
        itemId: item.id,
        toStepId: next.stepId,
        toPipelineId: next.pipelineId,
        actor: "engine",
        runId: run.id,
        // A watch's move says so, because the round-trip guardrail counts
        // exactly these (EO-456).
        reason: checked ? WATCH_ROUTED_REASON : "built-in step finished",
        resultKey: next.resultKey ?? null,
      });
    };
    const refusedByModule = await handOffModuleRefusal(db, current, next, enter);
    if (refusedByModule !== null) {
      updateRun(db, run.id, { status: "awaiting_input", error: refusedByModule, endedAt: now() });
      announceRun(run.id, item.id, "awaiting_input");
      return;
    }
    await settleItem(item, next.stepId);
    announceRun(run.id, item.id, "succeeded");
  }

  /**
   * The step this builtin or module run is a check of, when that step
   * keeps checking and the item is standing on it (EO-456), else
   * undefined. A run naming a step the item has left runs once.
   */
  function stepToWatch(item: Item, stepId: string | undefined): PipelineStep | undefined {
    if (stepId !== undefined && stepId !== item.stepId) return undefined;
    const step = stepForItem(db, item);
    if (!step || step.watch === null) return undefined;
    if (step.type !== "builtin" && step.type !== "module") return undefined;
    return step;
  }

  /**
   * Parks a watch that has stopped, with the sentence saying why (EO-456,
   * invariant 8).
   *
   * A run with no thread at `awaiting_input` — the guard placeholder
   * every other refusal leaves — so the scheduler stands off and a reply
   * is what picks the watch up again. Mentions whoever `mentions` names:
   * a watch that gave up tells the item's owner.
   */
  function parkWatch(item: Item, action: string, step: PipelineStep, reason: string, body: string, mentions: MentionTarget[], existing?: Run): void {
    const at = now();
    const run =
      existing ??
      createRun(db, { itemId: item.id, agentId: null, action, stepId: step.id, status: "awaiting_input", provider: isBuiltinAction(registry, action) ? "builtin" : "module" });
    updateRun(db, run.id, { status: "awaiting_input", ...(existing ? {} : { startedAt: at }), endedAt: at, error: reason });
    postComment(db, { itemId: item.id, runId: run.id, author: { type: "engine" }, kind: "escalation", mentions, parseBodyMentions: false, body });
    announceRun(run.id, item.id, "awaiting_input");
  }

  /**
   * One check of a step that keeps checking (EO-456, ARCHITECTURE.md, "A
   * step").
   *
   * Answers with the result for the ordinary builtin path to route, or
   * null when there is nothing left to do here: the check came back
   * waiting, or failed and will be tried again, or the watch stopped and
   * said so. In order:
   *
   * 1. **The watch row.** This stay's, or a fresh one. A check that is
   *    not due yet does nothing — the scheduler would not have offered
   *    it, but a dispatch decided a moment ago or by another machine's
   *    record can still arrive.
   * 2. **The guards.** Past its give-up time the watch parks and mentions
   *    the owner. Past the round-trip guardrail it parks too.
   * 3. **The check**, with no run row: it gets an id up front, and the row
   *    is only made when it has a run of its own to record.
   * 4. **What it said.** Waiting with nothing new writes the watch row
   *    and one line on the stay's quiet run (`recordQuietCheck`), which
   *    never counts as active. Waiting with news is a run and one comment
   *    holding only the entries not posted before. A failure is a failed
   *    run and a retry after 1, 2, 5, 10, then 30 minutes — and the sixth
   *    in a row parks the item with the error. A result key goes back to
   *    the caller to route.
   */
  async function runWatchCheck(
    item: Item,
    action: string,
    step: PipelineStep,
    runner: BuiltinRunner | undefined,
    builtin: boolean,
    resuming: boolean,
  ): Promise<CheckedResult | null> {
    // No check while EO is offline or has only just woken (EO-457), by
    // whichever door it came: the scheduler already holds the item, and
    // this is where every other way of running a check — a reply to a
    // parked watch above all — is held too. Before the row is touched,
    // so a park stays a park and a reply stays unread: the scheduler's
    // recovery pass (`deferredReplyItemIds`) offers it again on every
    // tick, and the first after the hold lifts runs it.
    if (currentWatchHold() !== null) return null;

    const watch = step.watch!;
    const started = now();

    let row: ItemWatch | undefined = currentWatch(db, item, step.id);
    if (row === undefined) {
      row = startItemWatch(db, { itemId: item.id, stepId: step.id, initiationId: watchArrival(db, item), startedAt: started });
    } else if (resuming) {
      // A person answered the park: the watch starts again from now, with
      // nothing failed — and with the news it already posted still
      // posted, because a reply is not a request to hear it twice.
      row = updateItemWatch(db, row.id, { startedAt: started, nextCheckAt: started, consecutiveFailures: 0, lastError: null }) ?? row;
    }

    // The deadline before whether a check is due, and without asking
    // anything (EO-456). The scheduler wakes the watch at whichever of
    // the two comes first, so a deadline that falls between checks — or
    // inside a failing check's backoff — arrives here with the next check
    // still ahead, and must park the item on the hour it was told to
    // rather than at the next check. A watch that never gives up (EO-571)
    // never stops here, however long ago it started.
    if (watchHasGivenUp(watch, row.startedAt, started)) {
      const watched = watchDurationWords(started - row.startedAt);
      parkWatch(
        item,
        action,
        step,
        `gave up after watching for ${watched}`,
        `"${step.name}" has stopped checking: it watched for ${watched}, and it ${watchGiveUpWords(watch)}. ` +
          `${row.checks} check${row.checks === 1 ? "" : "s"} ran${row.lastCheckedAt === null ? "" : `, the last at ${new Date(row.lastCheckedAt).toLocaleString()}`}, and none had a result.\n\n` +
          `Reply here to keep watching from now, or move this ticket on yourself.`,
        [ownerMention(db, item)],
      );
      return null;
    }

    // Not due yet: a dispatch decided a moment ago, or by a record that
    // has not heard of the last check. Nothing to do until it is.
    if (row.nextCheckAt > started) return null;

    const cap = readGuards().watchRoundTripsPerItem;
    const trips = watchRoundTrips(db, item.id);
    if (trips >= cap) {
      parkWatch(
        item,
        action,
        step,
        `watch round trips: ${trips} of ${cap}`,
        `Stopped before "${step.name}" checked again: steps that keep checking have sent this ticket to another step ${trips} time${trips === 1 ? "" : "s"} since anybody commented on it, and the limit is ${cap}. ` +
          `It keeps coming back for the same reason, so it is waiting for you.\n\nSay something here and it carries on watching, or move it.`,
        [{ type: "human" }],
      );
      return null;
    }

    // Held for one interval while the check runs, so nothing offers the
    // item again in the meantime; whatever the check says replaces it.
    updateItemWatch(db, row.id, { nextCheckAt: started + watchIntervalMs(watch) });

    const runId = uuidv7() as Uuid;
    const lines: string[] = [];
    let cwd: string | null = null;
    let run: Run | undefined;
    const ensureRun = (): Run => {
      if (run !== undefined) return run;
      run = createRun(db, {
        id: runId,
        itemId: item.id,
        agentId: null,
        action,
        stepId: step.id,
        status: "running",
        provider: builtin ? "builtin" : "module",
        ...(cwd === null ? {} : { cwd }),
      });
      updateRun(db, runId, { startedAt: started });
      announceRun(runId, item.id, "running");
      return run;
    };

    // Registered under the id it will have, so a pause that cancels
    // running work, or EO closing, stops a check as it stops a run.
    const controller = new AbortController();
    activeControllers.set(runId, controller);
    // Said to be running for as long as the runner is (EO-699), so a
    // card says "Checking now" rather than counting down to the check
    // after this one. Cleared in `finally`, and everything after the
    // runner is synchronous, so no read sees the mark gone and the
    // watch row not yet written.
    markCheckInFlight(db, item.id, true);
    onItemChanged(item.id);
    let outcome: BuiltinOutcome;
    try {
      outcome = runner
        ? await runner({
            db,
            item,
            prepareWorkspace: async (forItem, forAction, request) => {
              const prepared = await prepareWorkspace(forItem, forAction, request);
              if (prepared.ok) {
                cwd = prepared.workspace.cwd;
                if (run !== undefined) updateRun(db, runId, { cwd });
              }
              return prepared;
            },
            report: (text) => {
              lines.push(text);
            },
            runId,
            // A module's host starts in the run's own scope (EO-738).
            processScope: processScopeOf(runId),
            signal: controller.signal,
            ensureRun: () => {
              ensureRun();
            },
            inputs: step.inputs,
          })
            .catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }))
        : {
            ok: false,
            reason: builtin
              ? `"${action}" is not one of EO's built-in functions.`
              : `This step runs a module that is missing, deleted, or no longer approved. Check it under Settings → Modules.`,
          };
    } finally {
      activeControllers.delete(runId);
      markCheckInFlight(db, item.id, false);
      onItemChanged(item.id);
    }
    // A host its scope stopped for running out of memory (EO-738): said
    // as that, and below, not retried like a check that failed.
    const outOfMemory = runner ? await moduleRanOutOfMemory(outcome, runId) : null;
    if (outOfMemory !== null) outcome = { ok: false, reason: outOfMemoryReason(outOfMemory, null, action) };
    const ended = now();

    // Stopped while it checked: whoever stopped it has been told, and the
    // watch picks up again on its next check.
    if (forcedCancellationRunIds.has(runId)) {
      forcedCancellationRunIds.delete(runId);
      return null;
    }

    // Moved while it checked. What it found is about a step the item has
    // left, so nothing is routed and the watch is left as it was.
    const current = getItem(db, item.id);
    if (!current || current.stepId !== item.stepId) {
      if (outOfMemory !== null && !outcome.ok) {
        // Not a success, and said (invariant 8), but nothing parked: the
        // item is on a step somebody chose for it since.
        ensureRun();
        updateRun(db, runId, { status: "failed", error: outcome.reason, endedAt: ended });
        postComment(db, { itemId: item.id, runId, author: { type: "engine" }, kind: "escalation", mentions: [{ type: "human" }], parseBodyMentions: false, body: outcome.reason });
        announceRun(runId, item.id, "failed");
        return null;
      }
      if (run !== undefined) {
        updateRun(db, runId, { status: "succeeded", error: "Finished after this ticket was moved to another step, so it was left where it is.", endedAt: ended });
        announceRun(runId, item.id, "succeeded");
      }
      return null;
    }

    const recordLines = (into: Run, detail = outcome.ok ? outcome.detail : ""): void => {
      const buffer = createRunEventBuffer(db);
      for (const text of lines) buffer.append(into.id, "output", { type: "output", text });
      if (detail !== "") buffer.append(into.id, "output", { type: "output", text: detail });
      if (!outcome.ok) buffer.append(into.id, "error", { type: "error", message: outcome.reason });
      buffer.dispose();
      onPushEvents?.(into.id, []);
    };

    // Out of memory (EO-738): not a check to retry after a backoff — the
    // same check would run into the same limit — and not one of the
    // failures in a row that the watch gives up after. The run that ran
    // out stays `failed`, and the watch parks at once on a run of its
    // own, asking; a reply starts the watch again from then.
    if (outOfMemory !== null && !outcome.ok) {
      const failedRun = ensureRun();
      recordLines(failedRun);
      updateItemWatch(db, row.id, { lastCheckedAt: ended, checks: row.checks + 1, lastError: outcome.reason });
      updateRun(db, runId, { status: "failed", error: outcome.reason, endedAt: ended });
      announceRun(runId, item.id, "failed");
      parkWatch(item, action, step, outcome.reason, `"${step.name}" has stopped checking.\n\n${outcome.reason}`, [{ type: "human" }]);
      return null;
    }

    if (!outcome.ok) {
      const failures = row.consecutiveFailures + 1;
      const failedRun = ensureRun();
      recordLines(failedRun);
      updateItemWatch(db, row.id, { lastCheckedAt: ended, checks: row.checks + 1, consecutiveFailures: failures, lastError: outcome.reason, nextCheckAt: ended + watchRetryDelayMs(failures) });
      if (watchFailuresExhausted(failures)) {
        parkWatch(
          item,
          action,
          step,
          outcome.reason,
          `"${step.name}" has stopped checking: its check failed ${failures} times in a row, and after ${WATCH_FAILURE_LIMIT} EO stops retrying and asks. The last error was:\n\n${outcome.reason}\n\nReply here once it should try again.`,
          [{ type: "human" }],
          failedRun,
        );
        return null;
      }
      updateRun(db, runId, { status: "failed", error: outcome.reason, endedAt: ended });
      announceRun(runId, item.id, "failed");
      return null;
    }

    const steady = { lastCheckedAt: ended, checks: row.checks + 1, consecutiveFailures: 0, lastError: null };
    if (outcome.result === WAITING_RESULT) {
      const fresh = unseenNews(outcome.news ?? [], row.postedNewsIds);
      updateItemWatch(db, row.id, { ...steady, nextCheckAt: ended + watchIntervalMs(watch), postedNewsIds: [...row.postedNewsIds, ...fresh.map((entry) => entry.id)] });
      // Nobody to answer and nothing that needs a run of its own: one
      // line on the stay's quiet run. The item is still said to change,
      // because the watch row is what the item page draws its last and
      // next check from, and the screens refetch on a push rather than
      // on a timer — without this an open item would show the check
      // before last for as long as the watch went on waiting.
      if (fresh.length === 0 && run === undefined && !resuming) {
        const quiet = recordQuietCheck(db, { itemId: item.id, stepId: step.id, action, provider: builtin ? "builtin" : "module", stay: watchArrival(db, item), detail: outcome.detail, at: ended, leasedAt: heldLeases.get(item.id)?.grantedAt ?? ended });
        if (quiet.created) onRunChanged(quiet.run.id, item.id, "succeeded");
        onPushEvents?.(quiet.run.id, []);
        onItemChanged(item.id);
        return null;
      }
      const waitingRun = ensureRun();
      recordLines(waitingRun, fresh.length === 0 ? waitingLine(outcome.detail) : outcome.detail);
      updateRun(db, runId, { status: "succeeded", result: { raw: outcome, parsed: { result: WAITING_RESULT } }, endedAt: ended });
      if (fresh.length > 0) {
        postComment(db, {
          itemId: item.id,
          runId,
          author: builtin ? { type: "engine" } : { type: "module" },
          kind: "note",
          parseBodyMentions: false,
          body: renderWatchNews(step.name, fresh),
        });
      }
      announceRun(runId, item.id, "succeeded");
      return null;
    }

    // A result can carry news too (EO-460): the failed job a check reports
    // `checks_failed` over, the review comment behind `changes_requested`.
    // Posted the same way, in one comment of only the entries this watch
    // has not posted, and before the result routes — so the comment is on
    // the item by the time whoever it routes to is dispatched to read it.
    const freshWithResult = unseenNews(outcome.news ?? [], row.postedNewsIds);
    updateItemWatch(db, row.id, {
      ...steady,
      nextCheckAt: ended + watchIntervalMs(watch),
      ...(freshWithResult.length > 0 ? { postedNewsIds: [...row.postedNewsIds, ...freshWithResult.map((entry) => entry.id)] } : {}),
    });
    const resultRun = ensureRun();
    if (freshWithResult.length > 0) {
      postComment(db, {
        itemId: item.id,
        runId,
        author: builtin ? { type: "engine" } : { type: "module" },
        kind: "note",
        parseBodyMentions: false,
        body: renderWatchNews(step.name, freshWithResult, outcome.result),
      });
    }
    return { run: resultRun, outcome, lines };
  }

  /**
   * A manually dispatched run: someone `@`-mentioned this agent (ARCHITECTURE.md, "Agent to
   * agent").
   *
   * The asking comment starts its own attempt cycle. Retrying that same
   * open mention reuses the comment id; a later request gets a new id
   * and therefore a fresh allowance.
   *
   * Nothing transitions on the way out: answering a question is not
   * progress through the pipeline, and the reply lands in the thread
   * either way.
   */
  async function executeRespond(pending: PendingResponse): Promise<void> {
    // The item is claimed by `dispatchRun` below, which is the only
    // thing on this path that writes a run (EO-132).
    // `findPendingResponses` keeps its own `listActiveRuns` read, but
    // that is a filter and not the guarantee: it decides which mentions
    // are worth offering this tick, and the claim decides what actually
    // starts.
    const item = getItem(db, pending.itemId);
    const agent = getAgent(db, pending.agentId);
    if (!item || !agent) return; // referenced rows must exist; defensive

    // Archived since the mention was written (EO-186). `resolveAndValidateMentions`
    // stops a *new* mention naming a retired agent, and this is the
    // other half: a mention that was open when somebody archived it is
    // still open now, its row is still there, and every tick goes on
    // offering it. Refused out loud and the mention closed, because a
    // guard that returned quietly would leave the request sitting open
    // forever with nothing said (invariant #8) — and closing it is what
    // stops the same paragraph being posted on the next tick.
    if (agent.archivedAt !== null) {
      refuseArchivedMention(item.id, agent, pending.commentId);
      return;
    }

    // Another project's own agent (EO-474). The scheduler never sends it
    // this item, and a mention is not a way round that: it would read
    // this thread and this workspace and answer here. Refused out loud
    // and closed, for the archived case's reason above. A global agent
    // named on a project that has its own is still answered — a person
    // asking somebody by name is not the staffing of a step, which is
    // what precedence decides.
    if (!servesProject(agent, item)) {
      refuseOutOfProjectMention(item, agent, pending.commentId);
      return;
    }

    await dispatchRun(item, agent, pending.action, {
      // The asking comment is stable while a failed response retries,
      // and a new direct request has a different comment id.
      initiationId: pending.commentId,
      transitionOnSuccess: false,
      // Asked again after each preflight await, as the rerun path does:
      // preflight is auth, a worktree and a context assembly long, and
      // an agent archived in the middle of it must not still get a run
      // row. Silent on purpose — the mention stays open, the next tick
      // offers it again, and the refusals above are what do the talking.
      // The project is asked again for the same reason (EO-474): an
      // agent re-scoped, or an item moved to another project, while the
      // context was being assembled must not still start.
      stillEligible: () => {
        const agentNow = getAgent(db, agent.id);
        const itemNow = getItem(db, item.id);
        return agentNow !== undefined && itemNow !== undefined && agentNow.archivedAt === null && servesProject(agentNow, itemNow);
      },
    });
  }

  /**
   * A free-text reply to a parked builtin or module step, handed to the
   * system agent (EO-184).
   *
   * Ordinary in every way that matters: it claims the item like any
   * other run, it is subject to the same guards, and it ends. What it
   * does *not* do is transition — `transitionOnSuccess: false` and
   * `resultKeyFor` both say so, and they say it twice because the item
   * is sitting on somebody else's step for the whole of this run.
   *
   * Nothing is resumed from here. What the interpretation decided is
   * read back out of its own result by `deferredReplyItemIds` on the
   * next tick, which is the one path that resumes a parked item — so
   * a resume survives a crash between the run ending and the step being
   * run again, and there is no second resume path to disagree with the
   * first.
   */
  async function executeInterpret(pending: PendingInterpretationDispatch): Promise<void> {
    const item = getItem(db, pending.itemId);
    const agent = getAgent(db, pending.agentId);
    if (!item || !agent) return; // referenced rows must exist; defensive

    await dispatchRun(item, agent, pending.action, {
      // The reply itself, so one sentence can only ever start one
      // interpretation — and so a retry after a failure is the same
      // initiation rather than a fresh allowance.
      initiationId: pending.commentId,
      transitionOnSuccess: false,
      // Asked again after each preflight await, like the rerun path
      // (EO-175): preflight is long enough for the person to say
      // something else or for the item to be moved off the step that
      // parked, and either makes this the reading of a stale sentence.
      // The next tick offers whatever is true then.
      stillEligible: () => {
        const current = getItem(db, item.id);
        const parked = newestParkedRun(db, item.id);
        if (!current || !parked) return false;
        return pendingInterpretation(db, current, parked, readGuards().interpretReplies)?.commentId === pending.commentId;
      },
    });

    // The tick that reads what this decided. Without it the item waits
    // for the interval, which is a person watching a reply they wrote
    // sit there for no reason.
    notifyStateChange();
  }

  /**
   * A mention that handed the step back to its own agent (EO-135).
   *
   * The difference from `executeRespond` is what gets dispatched. A
   * question is answered as `respond`, which routes nowhere and moves
   * nothing; this runs the step's *own* action, at the step's own id,
   * and routes on the result like any other run of that step. Which is
   * what "rerun the Review step" has to mean — a prose reply saying
   * "sure, rerunning" is exactly the outcome #142 reported, an item
   * that looked attended to and moved nowhere.
   *
   * Every path out of here either starts a run or says why not, and
   * closes the mention either way. Leaving it open would re-offer the
   * same request on the very next tick — and, on the refusal side, post
   * the same comment every five seconds until somebody killed the app.
   */
  async function executeRerun(pending: PendingResponse, rerunStepId: string): Promise<void> {
    const item = getItem(db, pending.itemId);
    const agent = getAgent(db, pending.agentId);
    // By the item's own version (EO-327): a rerun runs what that version
    // says this step is — its role, its action, and whether it is
    // terminal — not what a save made of it since.
    const step = item && item.stepId === rerunStepId ? stepForItem(db, item) : getStep(db, rerunStepId);
    if (!item || !agent || !step) return; // referenced rows must exist; defensive

    // One attempt at a time per request. Preflight is several awaits
    // long — auth, workspace, context — and the mention stays open
    // across all of it, so without this the next tick offers the same
    // request again, loses the item lock to the dispatch already
    // starting, and posts "an agent is working on it right now" about
    // the very run it asked for.
    if (rerunsInFlight.has(pending.commentId)) return;
    rerunsInFlight.add(pending.commentId);
    try {
      const blocker = stepAuthorisationBlocker(item.id, agent, rerunStepId, pending.action);
      if (blocker) {
        rerunTurnedBack(item.id, agent, step, pending.commentId, blocker);
        return;
      }

      /**
       * What the admission gate saw, when it turned the dispatch back.
       *
       * Null covers both "the gate was never reached" and "it passed" —
       * and the two are told apart by whether a run exists, below, not
       * by this.
       */
      let turnedBackBy: RerunBlocker | null = null;
      const outcome = await itemLock.run(item.id, () =>
        dispatchRun(item, agent, pending.action, {
          // The asking comment, so a rerun that fails and is asked for
          // again gets a fresh allowance rather than inheriting the
          // exhausted one from the initiation it is recovering.
          initiationId: pending.commentId,
          stepId: rerunStepId,
          holdingItemLock: true,
          // The same question as the one above, asked again after each
          // preflight await and last of all immediately before the run
          // row. Preflight is long enough for a person to hold the
          // item in the middle of it, and eligibility decided a clone
          // ago is not eligibility.
          stillEligible: () => {
            turnedBackBy = stepAuthorisationBlocker(item.id, agent, rerunStepId, pending.action);
            return turnedBackBy === null;
          },
          // Closed the moment the run row exists — not before it, and
          // not after the run has finished. Before loses the request
          // outright if preflight turns back, and after leaves it open
          // for the rest of the run. Admission is the first instant at
          // which something durable exists to point at.
          onRunAdmitted: () => dismissOpenMentionForAgent(db, pending.commentId, agent.id),
        }),
      );
      if (!outcome.claimed) {
        // Lost the item between reading the board and claiming it. For
        // a scheduled dispatch that is a non-event, but a person asked
        // for this one and is owed the same refusal every other blocked
        // action gives (EO-132, invariant #8).
        refuseRerun(item.id, agent, step, pending.commentId, { kind: "run_active" });
        return;
      }

      // Did anything durable come of it? Both a real run and the guard
      // placeholder a refused preflight writes carry this initiation id,
      // and the guard has already posted its own escalation — so either
      // way the request has been answered and the mention can close.
      //
      // Read from the database rather than trusting `onRunAdmitted`,
      // because the guard paths never reach it: this has to be the
      // question "is there a run for this request", not "did the hook
      // fire".
      if (listRunsForItem(db, item.id).some((run) => run.initiationId === pending.commentId)) {
        dismissOpenMentionForAgent(db, pending.commentId, agent.id);
        return;
      }

      // Turned back at the gate: the same reasons, answered the same
      // way as they would have been a moment earlier.
      if (turnedBackBy !== null) {
        rerunTurnedBack(item.id, agent, step, pending.commentId, turnedBackBy);
        return;
      }

      // Nothing was admitted, nothing was written, and eligibility never
      // objected — so preflight turned back on one of the three things
      // it owns: a managed backend that went away mid-flight, Pause
      // landing while auth was loading, the item being deleted.
      deferRerun(item.id, agent, step, pending.commentId);
    } finally {
      rerunsInFlight.delete(pending.commentId);
    }
  }

  /**
   * A rerun that could not start yet, and will be tried again (EO-135).
   *
   * Not a refusal: the mention stays open, so the next tick offers the
   * request again and runs it the moment the way is clear. What this
   * adds is the sentence, because the conditions that get here are the
   * ones that reach a person as nothing happening — a managed backend
   * mid-update, Pause landing during preflight.
   *
   * A scheduled dispatch in the same position says nothing, and that is
   * right: EO had no one waiting on it and offers the item again next
   * tick. This is somebody's explicit request, and EO-132 already draws
   * exactly that line for a lost lock — the scheduler's own attempt is
   * silent, a person's gets an answer.
   *
   * Once per request, not once per tick: the condition can last for the
   * whole of a provider update, and a paragraph every five seconds is
   * how invariant 8 gets switched off by whoever is tired of reading it.
   */
  function deferRerun(itemId: Uuid, agent: Agent, step: PipelineStep, commentId: Uuid): void {
    // Deleted while its own dispatch was in preflight: there is nowhere
    // to post, and nothing left that anyone is waiting for.
    if (!getItem(db, itemId)) return;

    const body = heldBack(agent, itemId)
      ? `Not running "${step.name}" again just yet: EO was paused before the run could start. ` +
        `Your request is still queued — resume the engine and it runs from there. Nothing has been lost.`
      : `Not running "${step.name}" again just yet: ${agent.name} is not ready — EO installs and updates ` +
        `these backends in the background. Your request is still queued and runs as soon as it is back. Nothing has been lost.`;

    // Anchored to the request rather than to the item, so a second
    // request weeks later still gets told, while one request waiting out
    // a long update is told once.
    const askedAt = getComment(db, commentId)?.createdAt ?? 0;
    const alreadySaid = listCommentsForItem(db, itemId).some(
      (comment) => comment.authorType === "engine" && comment.body === body && comment.createdAt >= askedAt,
    );
    if (alreadySaid) return;

    postComment(db, { itemId, author: { type: "engine" }, kind: "note", body });
    onItemChanged(itemId);
  }

  /**
   * Says no to a rerun request, in the thread, once.
   *
   * The *once* is this function's own contribution — the wording lives
   * in `rerunRefusal`. Closing the mention is what bounds it: an open
   * request is re-read every tick, so a refusal that left it open would
   * post the same paragraph every five seconds for as long as the
   * condition held.
   */
  function refuseRerun(
    itemId: Uuid,
    agent: Agent,
    step: PipelineStep,
    commentId: Uuid,
    blocker: RerunBlocker,
  ): void {
    if (!getItem(db, itemId)) return; // deleted under the request; nowhere to post
    dismissOpenMentionForAgent(db, commentId, agent.id);
    postComment(db, {
      itemId,
      author: { type: "engine" },
      kind: "note",
      body: rerunRefusal(step, blocker),
    });
    onItemChanged(itemId);
  }

  /**
   * Says no to a mention that named a retired agent, in the thread, once
   * (EO-186).
   *
   * `refuseRerun`'s shape, for `refuseRerun`'s reason: the mention is
   * closed as the refusal is posted, because an open mention is re-read
   * every tick and a refusal that left it open would say the same thing
   * every five seconds for as long as the row stayed archived — which,
   * archiving being one-way, is forever.
   */
  function refuseArchivedMention(itemId: Uuid, agent: Agent, commentId: Uuid): void {
    if (!getItem(db, itemId)) return; // deleted under the mention; nowhere to post
    dismissOpenMentionForAgent(db, commentId, agent.id);
    postComment(db, {
      itemId,
      author: { type: "engine" },
      kind: "note",
      body: archivedAgentRefusal({ kind: "agent_archived", agentName: agent.name, role: agent.role }, "answer this mention"),
    });
    onItemChanged(itemId);
  }

  /**
   * Says no to a mention that named another project's agent, in the
   * thread, once (EO-474) — `refuseArchivedMention`'s shape, and closed
   * as it is posted so the next tick does not say it again.
   */
  function refuseOutOfProjectMention(item: Item, agent: Agent, commentId: Uuid): void {
    if (!getItem(db, item.id)) return; // deleted under the mention; nowhere to post
    dismissOpenMentionForAgent(db, commentId, agent.id);
    postComment(db, {
      itemId: item.id,
      author: { type: "engine" },
      kind: "note",
      body: outOfProjectMentionRefusal(outOfProjectWords(agent, item)),
    });
    onItemChanged(item.id);
  }

  /** Who this agent works for and where the item is, by name, for the out-of-project sentences (EO-474). */
  function outOfProjectWords(agent: Agent, item: Item): OutOfProject {
    const agentProject = agent.projectId === null ? undefined : getProject(db, agent.projectId);
    const itemProject = item.projectId === null ? undefined : getProject(db, item.projectId);
    return { agentName: agent.name, agentProject: agentProject?.name ?? "another", itemProject: itemProject?.name ?? null };
  }

  /**
   * Closes a parked run whose agent has moved to another project since
   * it parked (EO-474) — `closeParkOfArchivedAgent`'s shape, for its
   * reason: the reply is what would start the agent again, here, on an
   * item it no longer works for. Closed rather than left parked, so the
   * scheduler is free to hand the step to whoever staffs it for this
   * item's project now.
   */
  function closeParkOfOutOfProjectAgent(item: Item, priorRun: Run, agent: Agent): void {
    updateRun(db, priorRun.id, { status: "cancelled", endedAt: now() });
    postComment(db, {
      itemId: item.id,
      runId: priorRun.id,
      author: { type: "engine" },
      kind: "note",
      body: outOfProjectRecoveryNote(outOfProjectWords(agent, item), "The run that was waiting for your answer here", agent.role),
    });
    announceRun(priorRun.id, item.id, "cancelled");
  }

  /**
   * The design's mention-depth cap, asked of one pending mention (EO-212).
   *
   * The design names two guards before agents may mention agents.
   * The second — "agents may not resolve a mention aimed at you" — is
   * structural, in `resolveMentionsForComment`. This is the first, and
   * without it nothing bounds A→B→A at all: the wall-clock timeout ends
   * one run, the attempt limit is per *initiation* and every mention is
   * a fresh one, and both cost budgets ship as null. Thirty minutes a
   * hop, forever.
   *
   * Asked here, at the dispatch door, rather than in the `comment` tool
   * an agent writes with. That is the whole difference between this and
   * a cap on what agents may type: a mention pulled in from Jira or
   * left by a module never goes through that tool, and both of them
   * dispatch through this loop like any other. One door, one count.
   *
   * A mention aimed at a human is never seen here — `findPendingResponses`
   * only ever offers `targetType === "agent"` — and a human's own
   * mention of an agent scores zero hops, because the count restarts at
   * their comment.
   *
   * A mention of the system agent is answered however deep it is (EO-616).
   * What it writes next is still weighed, so a chain that runs on through
   * another agent stops at that agent.
   */
  function mentionDepthBlocker(pending: PendingResponse): Extract<RerunBlocker, { kind: "mention_depth" }> | null {
    if (isSystemAgent(getAgent(db, pending.agentId))) return null;
    const cap = readGuards().agentMentionDepth;
    const chain = agentMentionChain(db, pending.itemId, pending.commentId);
    // The mention being weighed is itself the last hop in that count, so
    // `cap` hops all dispatch and the one after them does not.
    if (chain.hops <= cap) return null;
    return { kind: "mention_depth", agents: chain.agents, hops: chain.hops, cap };
  }

  /**
   * Says no to a mention that ran the chain past its cap (EO-212).
   *
   * `refuseArchivedMention`'s shape, and closed for its reason: an open
   * mention is re-read on every tick, so a refusal that merely skipped
   * it would offer the same request every five seconds and answer it the
   * same way — which is the lesson `findPendingResponses` already
   * records about skipping rather than closing.
   *
   * An escalation rather than a note, unlike the archived refusal. That
   * one names a switch somebody can go and look at; this one has no fix
   * that is not a person saying something, so it raises `!` and asks
   * (invariant 8). Nothing is left running to wait for them: no run was
   * ever created, which is invariant 9 satisfied by never having started.
   */
  function refuseMentionDepth(pending: PendingResponse, blocker: Extract<RerunBlocker, { kind: "mention_depth" }>): void {
    if (!getItem(db, pending.itemId)) return; // deleted under the mention; nowhere to post
    dismissOpenMentionForAgent(db, pending.commentId, pending.agentId);
    postComment(db, {
      itemId: pending.itemId,
      author: { type: "engine" },
      kind: "escalation",
      mentions: [{ type: "human" }],
      body: mentionDepthRefusal(blocker),
    });
    onItemChanged(pending.itemId);
  }

  /**
   * Everything standing between a dispatch decided against one step and
   * its run (EO-135, EO-175).
   *
   * The rule an agent, a module and a builtin all run under: a
   * step-driven run may only start if the item is still on the step
   * that authorised it, and that step still says what it said. Both
   * callers ask it — the mention that hands a step back to its agent,
   * and the scheduler's own dispatch — because it is one question and
   * two answers to it is how EO-173 happened: a dispatch decided while
   * the item was on To Do wrote its run row 1.3 seconds later, after
   * the person had dragged the item to Index, and ran the implementer
   * on a step it did not own while the step that did sat waiting.
   *
   * The scheduler's own eligibility, plus the question it cannot ask:
   * whether *this* agent is switched on. `tick()` staffs a step from
   * whoever holds its role, so with two reviewers and one of them off
   * its answer is "fine" — and dispatching the one the person named
   * would then run a disabled agent. `isAgentAvailable` does not cover
   * it either; that is about a managed runtime being installed, not
   * about a setting.
   *
   * The same holds for retirement (EO-186), and more sharply: `tick()`
   * does not count an archived agent as staffing anything, but a mention
   * names an agent directly and never goes through the scheduler at all.
   * So this is the gate both kinds of dispatch pass, and it reads the
   * row rather than trusting the `Agent` it was handed.
   *
   * `agent` is null on a `builtin` or `module` step, where there is no
   * role to staff and nobody to switch off: what is asked instead is
   * that the step is still EO's own to run and still names this action.
   *
   * Re-read rather than taken from the caller's `Agent`, because this is
   * asked twice: once before preflight and once at the end of it, and
   * the switch can be flipped in between.
   */
  function stepAuthorisationBlocker(itemId: Uuid, agent: Agent | null, stepId: string, action: string): RerunBlocker | null {
    if (agent !== null) {
      const current = getAgent(db, agent.id);
      // Retired, and said so as its own reason (EO-186). Asked before
      // the switch because it is the stronger fact — an archived agent
      // is usually a disabled one too, and "enable it in Settings" is
      // advice about a switch that no longer decides anything.
      if (current && current.archivedAt !== null) return { kind: "agent_archived", agentName: agent.name, role: current.role };
      if (!current?.enabled) return { kind: "agent_disabled", agentName: agent.name };
    }

    const item = getItem(db, itemId);
    // Deleted under the request. `dispatchHeld` turns back on its own
    // check for this and `deferRerun` finds nothing to post to, which is
    // the whole of the right answer.
    if (!item) return null;

    // Its project was archived (EO-347) — possibly in the middle of this
    // very preflight, which is the window this recheck exists for. A
    // dispatch decided a moment before the archive would otherwise start
    // an agent on a project the person has just put away, and nothing
    // would stop that one: the archive cancelled the runs that had rows.
    const shelved = archivedProjectBlocker(db, itemId);
    if (shelved) return shelved;

    // The request was about one step, and the item may not be on it
    // any more. `moveItem` guards on a run row and preflight has not
    // written one, so a person can move the item out from under a
    // rerun that is still assembling its context — and the dispatch is
    // holding a `Item` value read before the move. What made this
    // worth a guard of its own rather than a stale-read curiosity is
    // where it ends up: the run would carry the old step's action, and
    // the success path resolves its route from that same stale snapshot,
    // so a review that passed would transition the item out of Review
    // — a step it had already been moved off — and overwrite the move.
    // The item's own version's definition of the step it is on
    // (EO-327). Read as a definition two paragraphs below — is it still
    // terminal, is it still a builtin, does it still name this action —
    // so it has to be the definition this item would actually run.
    const requested = item.stepId === stepId ? stepForItem(db, item) : getStep(db, stepId);
    if (item.stepId !== stepId || (requested && item.pipelineId !== requested.pipelineId)) {
      return { kind: "step_moved", ...whereItStandsNow(item) };
    }

    // Still the same step by id — but a step is data somebody can edit
    // while preflight is open (invariant #7). Change Review's owner role
    // to `implementer` and generic eligibility still says yes: the step
    // is staffed, the item is on it, nothing is held. What it cannot
    // see is that the request was classified against a contract that has
    // since stopped holding, and admitting it would run the reviewer at
    // a step the reviewer no longer owns, with an action it may no
    // longer have. Asked of the same function the classification used,
    // so the two cannot answer differently.
    const contract =
      agent === null
        // EO's own code rather than an agent's: the step has to still be
        // one EO runs itself, still not terminal, and still name the
        // function this dispatch was decided for. A step retyped to
        // `agent` while the module was waiting on the item lock is the
        // same stale authorisation the branch below turns back, and it
        // would run a module the pipeline no longer asks for.
        ? (requested && !requested.isTerminal && (requested.type === "builtin" || requested.type === "module")
            ? { action: requested.entryAction }
            : null)
        : rerunContract(db, itemId, agent.id, stepId);
    if (!contract || contract.action !== action) {
      const now = whereItStandsNow(item);
      return { kind: "step_reassigned", stepName: now.nowAt, rerunWith: now.rerunWith };
    }

    const blocker = dispatchBlocker(eligibilityNow(), itemId);
    // A retry's wait is EO pacing its own retries, not a reason to turn
    // a person away: somebody asking for the step again is exactly the
    // fresh look the wait was buying time for.
    // Nor is a watch's wait between checks (EO-456): it is EO pacing
    // its own checks in the same way. A hold for being offline or just
    // woken is not (EO-457): it is kept for a person asking too, because
    // the check would fail all the same and count against the watch.
    return blocker?.kind === "retry_backoff" || blocker?.kind === "watching" ? null : blocker;
  }

  /**
   * Where the item stands and who would run it there (EO-135).
   *
   * The second half is what makes this worth saying: "that is not the
   * step this was about any more" leaves a person to work out for
   * themselves who to ask instead, and the answer is one lookup EO can
   * do for them. Null where the step is nobody's to run — a `user` step,
   * a terminal one, a builtin — because then there is no one to name.
   */
  /**
   * What a run is working on, restated for an agent whose conversation
   * has just been compacted (`CompactedEvent`).
   *
   * Short on purpose. The agent's instructions survive a compaction — the
   * system prompt is not summarised — and what it did is in the summary;
   * what can be lost is the brief it was seeded with. So: the item, the
   * step, and what will be checked.
   */
  function restatedBrief(item: Item): string {
    const current = getItem(db, item.id) ?? item;
    const step = stepForItem(db, current);
    const criteria = acceptanceCriteriaOf(current, shapeOf(current));
    return [
      `(From EO, not from a person: your conversation was just compacted, so here is what you are working on, restated: ${current.key} "${current.title}"` +
        `${step ? `, at the "${step.name}" step` : ""}.`,
      ...(criteria.length > 0 ? ["What it will be checked against:", ...criteria.map((criterion) => `- ${criterion}`)] : []),
      "Carry on from where you were.)",
    ].join("\n");
  }

  function whereItStandsNow(item: Item): { nowAt: string; rerunWith: string | null } {
    const step = stepForItem(db, item);
    const owner =
      step && step.type === "agent" && !step.isTerminal && step.ownerRole !== null
        ? staffingAgents(listAgents(db), step.ownerRole, item)[0]
        : undefined;
    return { nowAt: step?.name ?? "no step", rerunWith: owner?.name ?? null };
  }

  /**
   * A rerun request that did not become a run, answered the one way its
   * reason deserves (EO-135).
   *
   * One function, called from both sides of preflight, so that a hold
   * arriving a second before the run row is treated exactly as one
   * arriving a second before the tick. That equivalence is the whole
   * point: which side of an await a person happened to land on is not
   * something they can see, so it must not change what EO does.
   *
   * A hold and the kill switch are somebody deliberately pausing EO, and
   * the person who did it is the person who will undo it — so the
   * request is kept, in silence, and offered again on the tick after
   * they resume. Silence is right here and nowhere else on this path:
   * the item already carries the hold's own comment saying it will
   * stay put until resumed, and the request is not lost, merely waiting
   * for the thing the person just asked for.
   */
  function rerunTurnedBack(
    itemId: Uuid,
    agent: Agent,
    step: PipelineStep,
    commentId: Uuid,
    blocker: RerunBlocker,
  ): void {
    if (blocker.kind === "held" || blocker.kind === "paused") return;
    refuseRerun(itemId, agent, step, commentId, blocker);
  }

  /**
   * Give back the item of every adopted run that has since ended
   * (EO-132).
   *
   * An adopted run is one `reconcile()` found alive and left alone. Its
   * stream belongs to nobody here, so there is no `finally` to hang the
   * release off — the run row reaching a terminal status is the only
   * signal this process gets that the item is free, and this is where
   * that signal is read. Called before each tick, which is the only
   * moment the answer is needed.
   */
  function releaseSettledAdoptions(): void {
    for (const [runId, hold] of [...adoptedHolds]) {
      const status = getRun(db, runId)?.status;
      if (status === "queued" || status === "running") continue;
      hold();
      adoptedHolds.delete(runId);
    }
  }

  /**
   * ARCHITECTURE.md, "Reconciling on launch": runs left `queued`/`running` by a process that's no
   * longer
   * driving them. Filtered against `activeControllers` (not just DB
   * status) so a second call — or a call after `start()` has already
   * reconciled once — is a no-op: anything this process is already
   * driving (a fresh dispatch, or a resume kicked off by an earlier
   * reconcile() call) is left alone rather than reconciled twice.
   *
   * **Asynchronous since EO-151, and the reason is worth stating.** A
   * recovered run is dispatched with the same tool surface a fresh one
   * would be, and settling what that surface *is* — does this item
   * have an index an agent can query? — reads a row and asks a binary.
   * This was written synchronously and the recovery path was, for one
   * release, the single place an agent silently went without repository
   * intelligence it was entitled to. Awaiting is what removes that
   * special case; `start()` chains its first tick behind the promise, so
   * the design guarantee that nothing dispatches against unreconciled state
   * is unchanged.
   */
  function reconcile(): Promise<ReconcileSummary> {
    // Joined rather than started twice: a second caller during a pass
    // gets the pass already running, which is what `reconcileNow`'s own
    // filter against `activeControllers` would have made a no-op anyway
    // — but this way the barrier has a single promise to be raised for.
    reconciling ??= reconcileNow().finally(() => {
      reconciling = null;
    });
    return reconciling;
  }

  /**
   * Carries an interrupted run on in its own thread (E-04).
   *
   * The continuation is a new row on the same step, initiation and
   * attempt, resumed with `message` so the agent knows why it is being
   * spoken to again: EO found it still marked running after a restart
   * (`reconcileNow`). A run a person stopped by closing EO is carried on
   * through `dispatchRun` instead (`DispatchOptions.continueThread`),
   * because EO was open and checking when it stopped, and is again now.
   *
   * `hold` is the item's lock, already taken; it is given back when the
   * continuation ends or does not start. False when nothing was started.
   */
  async function continueOnThread(run: Run, agentForRun: Agent | undefined, resumableThreadId: string, hold: () => void, message: string): Promise<boolean> {
      const item = getItem(db, run.itemId);
      const agent = agentForRun;
      if (!item || !agent) {
        hold(); // referenced rows must exist; defensive, shouldn't happen
        return false;
      }

      const newRun = createRun(db, {
        itemId: run.itemId,
        agentId: run.agentId,
        action: run.action,
        // The step the crashed run was dispatched from, not wherever the
        // item sits now: this run is that one continued.
        stepId: run.stepId,
        status: "queued",
        threadId: resumableThreadId,
        provider: run.provider,
        runtimeSource: runtimeSource(runsOn(agent, item)),
        // What the *thread* was born with, carried over rather than
        // re-read from the agent as it is now — the same pair, for the
        // same reason, as the human-reply resume path below. This run
        // resumes a session; a resume re-sends neither the instructions
        // (EO-87) nor the configuration that decides the tool surface
        // (EO-106), so what this conversation can reach is what it
        // opened with, not what somebody has edited or ticked since the
        // app was killed.
        //
        // Load-bearing, and in two different ways. This row becomes the
        // newest one behind the thread, so it is what
        // `findReusableThread` weighs up on the next automatic
        // dispatch. Left to default, `instructionsHash` reads as "no
        // record" and costs the item its thread for nothing; and
        // `agentAttachmentsHash` — which reads a null as the *empty*
        // surface — would let a recovered thread be reused after an
        // attached server was detached, keeping a tool the person had
        // just taken away. Null only where `run` genuinely holds none.
        //
        // Both, not one. Dropping `instructionsHash` refuses the thread
        // on its own rule before the attachment rule is ever reached —
        // so fixing only the attachment column would have left the new
        // guarantee resting on a neighbouring bug, and reinstated the
        // hole the moment somebody tidied that one up.
        instructionsHash: run.instructionsHash,
        agentAttachmentsHash: run.agentAttachmentsHash,
        // And the item's files the thread was told about (EO-703), on the
        // same terms: a resume tells it nothing about the item again.
        itemFilesHash: run.itemFilesHash,
        initiationId: run.initiationId,
        // The same attempt, carried on: an interruption is not a try the
        // agent spent (`RunInterruption`), so `countAttempts` leaves the
        // interrupted row out and this one takes its number.
        attempt: run.attempt,
        // The continuation works in the same directory the crashed run did.
        cwd: run.cwd,
      });
      updateRun(db, newRun.id, { status: "running", startedAt: now() });
      announceRun(newRun.id, run.itemId, "running");

      const resumeSchema = outputSchemaFor(registryFor(item), run.action, typeOf(item), definingRole(item, agent));
      const controller = new AbortController();
      // Claimed here, before the await below, so a cancel arriving
      // while this dispatch is being prepared is not a no-op (EO-151).
      claimRunControl(newRun, agent.id, run.action, controller, !isManualAction(run.action));
      // The recovered thread needs its directory as much as a fresh
      // dispatch does (EO-107): the app was killed, and whatever
      // process was holding those servers open died with it.
      const recoveredToolDirectory = prepareToolDirectory(item, agent);
      // And the query server, for the same reason and on the same
      // terms (EO-151): the process that was holding it open died with
      // the app, and the CLI this resume spawns starts the servers it
      // is told about now. Resolved rather than carried on the row —
      // EO was not running, and the index may have been rebuilt or
      // thrown away while it was not.
      const recoveredAttachment = await attachWorkspace(item, agent, workspaceOfRun(item, run));
      // The person may have cancelled, or the app begun shutting down,
      // while that resolved. Starting the backend now would spawn a
      // process — and the query server under it — for a run already
      // written off, which is the whole of what claiming early buys.
      // `cancelActiveRun` has already marked the row and announced it,
      // so there is nothing to say here beyond letting the claim go.
      if (controller.signal.aborted) {
        releaseRunControl(newRun.id);
        hold();
        return false;
      }

      // A close or a pause landed while that resolved (EO-615). No backend
      // has been spoken to, so nothing starts, and the promise this run
      // stands for is kept: `cancelActiveRun` writes the row off and
      // persists its restart, which is how a run stopped by closing EO is
      // carried on, and `restartForcedRuns` takes it up from there.
      if (heldBack(agent, run.itemId)) {
        cancelActiveRun(newRun.id, "restart-on-resume");
        releaseRunControl(newRun.id);
        hold();
        return false;
      }

      // Archived while *that* resolved (EO-186). The same last window
      // the reply path has, on the same terms: the row exists by now,
      // it never reached a backend, so it is closed as cancelled with
      // the reason on it rather than left running for the next
      // reconciliation to find. Said out loud because nothing else
      // here would — the row this continued was written off as
      // "resumed on the same thread" a moment ago, and that is no
      // longer what happened (invariant #8).
      if (getAgent(db, agent.id)?.archivedAt !== null) {
        updateRun(db, newRun.id, {
          status: "cancelled",
          endedAt: now(),
          error: `${agent.name} was archived before this recovery reached the "${agent.provider}" backend, so nothing was started.`,
        });
        releaseRunControl(newRun.id);
        announceRun(newRun.id, run.itemId, "cancelled");
        postComment(db, {
          itemId: run.itemId,
          runId: newRun.id,
          author: { type: "engine" },
          kind: "note",
          body:
            `${agent.name} was archived while EO was picking this ticket back up after a restart, so the run it was ` +
            `interrupted in the middle of was not resumed after all: an archived agent is dispatched to nothing, and ` +
            `nothing brings one back. This ticket waits where it stands for the next agent on the "${agent.role}" role.`,
        });
        hold();
        return false;
      }
      // Moved to another project while that resolved (EO-474). The same
      // window, closed the same way; `reconcileNow` has already turned
      // away an agent that was out of scope before this began.
      const agentNow = getAgent(db, agent.id);
      const itemNow = getItem(db, run.itemId);
      if (agentNow && itemNow && !servesProject(agentNow, itemNow)) {
        updateRun(db, newRun.id, {
          status: "cancelled",
          endedAt: now(),
          error: `${agent.name} was moved to another project before this recovery reached the "${agent.provider}" backend, so nothing was started.`,
        });
        releaseRunControl(newRun.id);
        announceRun(newRun.id, run.itemId, "cancelled");
        postComment(db, {
          itemId: run.itemId,
          runId: newRun.id,
          author: { type: "engine" },
          kind: "note",
          body: outOfProjectRecoveryNote(outOfProjectWords(agentNow, itemNow), `The run interrupted by the restart (attempt ${run.attempt})`, agentNow.role),
        });
        hold();
        return false;
      }

      // The item's files changed while that resolved (EO-703).
      // `resumeBlockedReason` passed this thread before the await; the
      // resume below tells it nothing about the item, so carrying it on
      // now would leave a file unseen. Nothing has been sent: the row is
      // closed and a fresh dispatch of the same work takes the lock this
      // recovery holds, with the full context and the reason posted once.
      if (!itemFilesUnchangedFor(run)) {
        closeForChangedFiles(newRun, run.itemId);
        const fresh = dispatchRun(item, agent, run.action, {
          ...(run.initiationId !== null ? { initiationId: run.initiationId } : {}),
          transitionOnSuccess: !isManualAction(run.action),
          holdingItemLock: true, // this recovery's own claim, not a second one
          freshBecause: itemFilesChangedWhilePreparing(agent),
        }).finally(() => {
          inFlight.delete(fresh);
          hold();
        });
        inFlight.add(fresh);
        return true;
      }

      for (const notice of recoveredAttachment.notices) {
        postComment(db, {
          itemId: run.itemId,
          runId: newRun.id,
          author: { type: "engine" },
          kind: "note",
          body: notice,
        });
      }
      const stream = openTurn(item, workspaceOfRun(item, run), () =>
        // With the memory-writing block where the turn is served
        // `memory_note` (EO-593): the thread being recovered may predate it.
        sendingProvider(newRun, agent, item, run.action, { purpose: "recovery" }).resume(resumableThreadId, withMemoryWriting(message, agent, turnMemoryScopes(item)), {
          ...(run.cwd ? { cwd: run.cwd } : {}),
          ...(resumeSchema ? { outputSchema: resumeSchema } : {}),
          ...discussionTurnOptions(item, agent),
          ...(recoveredToolDirectory ? { toolDirectory: recoveredToolDirectory.path } : {}),
          ...(recoveredAttachment.mcpServers[0] ? { repositoryMcp: recoveredAttachment.mcpServers[0] } : {}),
          // The continuation's own id: what it attaches is counted
          // against, and filed under, the run that attached it (EO-412).
          ...attachOption(item, newRun),
          // The thread was given memory; its tool stays (EO-478).
          ...memoryOption(item),
          // And where the agent's writes go (EO-543).
          ...writeBridgeOption(item),
          signal: controller.signal,
        }),
      );
      const promise = runToCompletion(
        newRun,
        item,
        agent,
        run.action,
        stream,
        resumableThreadId,
        controller,
        {
          transitionOnSuccess: !isManualAction(run.action),
          ...(recoveredToolDirectory
            ? { toolDirectory: recoveredToolDirectory.path, toolServerNames: recoveredToolDirectory.serverNames }
            : {}),
          attachment: recoveredAttachment,
        },
      ).finally(() => {
        inFlight.delete(promise);
        // The recovered run is over; the item is free (EO-132).
        hold();
      });
      inFlight.add(promise);
      return true;
  }

  async function reconcileNow(): Promise<ReconcileSummary> {
    // Anything adopted by an earlier call whose run has since ended is
    // not holding its item against this one.
    releaseSettledAdoptions();
    // And anything *this device* left claimed when it stopped (EO-322).
    //
    // A lease outlives the process that took it — that is what makes it
    // durable and what makes the expiry sweep necessary — but a device
    // coming back up knows something the sweep has to wait minutes to
    // infer: whatever it was doing under those claims is over. Handing
    // them back here is what keeps a crash costing the next tick rather
    // than the lease's whole term, and it is silent because the run
    // this reconciliation is about to resume, orphan or adopt is where
    // the account of what happened belongs.
    //
    // Except the claims this process is working under at this instant,
    // which is the difference between "left behind" and "held". This is
    // not only a boot path: `resume()` reconciles, and `pause()` leaves
    // a run in flight alone unless it was asked to cancel it — so
    // pausing and resuming while an agent is working is an ordinary
    // thing to do, and it arrives here with `executeDispatch` still
    // holding its lease and still minutes from the `finally` that gives
    // it back. Handing that one over would let another machine start
    // the same item underneath a live run, which is the one thing the
    // lease exists to prevent. `heldLeases` is exactly the set that
    // must survive, and at boot it is empty.
    //
    // Awaited, and `reconcileNow` is the barrier every tick waits on
    // (`runTickOnce` above), so nothing dispatches against a record
    // that has not yet been told which claims this device has given up.
    // In managed mode that is a round trip, which is exactly why it is
    // awaited rather than fired off: a boot that raced its own release
    // would have the record refuse to offer this machine the work it
    // just handed back.
    await record.releaseLeasesOf(deviceId(), heldLeases.keys());
    const summary: ReconcileSummary = {
      reattached: 0,
      resumed: 0,
      orphaned: 0,
    };
    // Restored pause applies before boot reconciliation as well as the
    // first scheduler tick: resuming an interrupted provider thread is
    // still new agent activity. The rows of whoever it holds are left
    // untouched so a later resume can reconcile the same work instead of
    // losing it. A system agent's is carried on now, or the conversation
    // it was having would sit there as `running` until somebody resumed.
    const stale = listActiveRuns(db).filter((run) => !activeControllers.has(run.id) && !heldBack(agentOf(run), run.itemId));

    for (const run of stale) {
      if (isOurLiveProcess(run)) {
        // A live process we already own is presumably still streaming
        // into this run — nothing to reconcile.
        //
        // Except the lock, which does not survive a restart and so has
        // to be seeded with what is already running (EO-132). Without
        // this the very first tick after boot would dispatch on top of a
        // live process in the same checkout. Nothing here owns that
        // stream, so the hold is registered rather than scoped, and
        // `releaseSettledAdoptions` gives it back when the run ends.
        const adopted = itemLock.acquire(run.itemId);
        if (adopted) adoptedHolds.set(run.id, adopted);
        summary.reattached++;
        continue;
      }

      // Read before the branch: a provider can be changed while the app
      // is closed, which is exactly the window this loop exists for.
      // A builtin run has no agent. Nothing here applies to one: there is
      // no backend to have switched and no thread to resume.
      const agentForRun = run.agentId === null ? undefined : getAgent(db, run.agentId);
      /**
       * Retired while the app was down (EO-186).
       *
       * The window this loop exists for is exactly the window an agent
       * can be archived in, and archiving the last enabled holder of a
       * staffed role is refused — so the ordinary case is an
       * installation that has *another* agent on the role and retired
       * this one, and recovery handing its thread back would be the one
       * dispatch that ignored that.
       *
       * Not folded into `resumeBlockedReason`, deliberately. That answer
       * means "this thread cannot carry the agent as it is now, so start
       * a fresh run instead", and a fresh run as this agent is the thing
       * that must not happen. This one means "not by this agent at all",
       * which is what the orphan tail below already does correctly: the
       * run is written off, the item is handed back where it stands,
       * and the scheduler dispatches the step to whoever holds the role
       * now.
       */
      const retiredAgent = agentForRun !== undefined && agentForRun.archivedAt !== null ? agentForRun : null;
      /**
       * Moved to another project while the app was down (EO-474) — "not
       * by this agent at all", exactly as retired is, and handed to the
       * orphan tail for the same reason: the scheduler then dispatches
       * the step to whoever staffs it for this item's project.
       */
      const runItem = getItem(db, run.itemId);
      const outOfProjectAgent =
        retiredAgent === null && agentForRun !== undefined && runItem !== undefined && !servesProject(agentForRun, runItem) ? agentForRun : null;
      // Not only a backend switch since EO-107: an agent whose attached
      // servers or skills changed while the app was closed cannot have
      // its thread resumed either.
      const notResumable = retiredAgent !== null || outOfProjectAgent !== null ? null : agentForRun ? resumeBlockedReason(run, agentForRun) : null;

      // The item, claimed before a row is written, so a refusal leaves
      // no run behind (EO-132). A recovered thread is a live process in
      // the item's checkout the moment it is resumed, and the lock has
      // to know about it before the first tick does.
      // Interrupted too often to be carried on again (`MAX_INTERRUPTIONS_PER_INITIATION`):
      // handed back through the orphan tail, where the next dispatch
      // refuses it and says why.
      const interruptedTooOften = !isSystemAgent(agentForRun) && countInterruptions(run.itemId, run.initiationId) + 1 >= MAX_INTERRUPTIONS_PER_INITIATION;
      const resumableThreadId = notResumable || retiredAgent || outOfProjectAgent || interruptedTooOften ? null : run.threadId;
      const hold = resumableThreadId === null ? null : itemLock.acquire(run.itemId);
      // A second interrupted run on the same item, when the first has
      // already been adopted or resumed. It cannot be resumed as well —
      // two continuations in one checkout is exactly what the lock
      // exists to prevent — so it falls through to the orphan tail
      // below, which hands the item back and says so.
      const claimedElsewhere = resumableThreadId !== null && hold === null;

      if (hold && resumableThreadId !== null) {
        updateRun(db, run.id, {
          status: "cancelled",
          error: "interrupted by an app restart; resumed on the same thread",
          interruption: "restart",
          endedAt: now(),
        });

        if (!(await continueOnThread(run, agentForRun, resumableThreadId, hold, RECONCILE_RESUME_MESSAGE))) continue;
        summary.resumed++;
        continue;
      }

      // No usable thread: orphan it and hand the item back (ARCHITECTURE.md, "Guardrails": the
      // engine explains itself instead of silently dropping the work).
      // The scheduler re-dispatches from the item's state, and the new
      // run is seeded from the thread — including the note below, which is
      // the newest word at this step and therefore carried.
      updateRun(db, run.id, {
        status: "orphaned",
        error: claimedElsewhere
          ? "interrupted by an app restart; another interrupted run on this ticket was picked up instead"
          : retiredAgent
            ? "interrupted by an app restart; its agent has been archived since, so it was not resumed"
            : outOfProjectAgent
              ? "interrupted by an app restart; its agent works for another project since, so it was not resumed"
              : notResumable
              ? "interrupted by an app restart; what the thread was opened with has changed, so it was not resumable"
              : interruptedTooOften
                ? `interrupted by an app restart; interrupted ${MAX_INTERRUPTIONS_PER_INITIATION} times without finishing, so not carried on again`
                : "interrupted by an app restart; no thread to resume",
        // Interrupted, not failed: whatever is dispatched next does not
        // count this one against the item's attempts.
        interruption: "restart",
        endedAt: now(),
      });

      const item = getItem(db, run.itemId);
      // An item on no step cannot record "it stayed where it was" — but
      // a feature never had a run to orphan in the first place.
      if (item && item.stepId !== null) {
        record.applyTransition({
          itemId: item.id,
          toStepId: item.stepId,
          actor: "engine",
          runId: run.id,
          reason:
            "orphaned: run interrupted by an app restart with no thread to resume",
        });
        postComment(db, {
          itemId: item.id,
          author: { type: "engine" },
          body: claimedElsewhere
            ? `Two runs on this ticket were interrupted by an app restart. Only one of them can carry on — a ticket has one checkout, and two agents in it is a diff nobody wrote — so attempt ${run.attempt} is marked orphaned and the other one continues. The ticket stays in "${item.stepId}".`
            : retiredAgent
              ? `${retiredAgent.name} was archived while EO was not running, so the run it was interrupted in the middle of (attempt ${run.attempt}) is marked orphaned rather than resumed: an archived agent is dispatched to nothing, and nothing brings one back. The ticket stays in "${item.stepId}" for the next agent on the "${retiredAgent.role}" role to pick up.`
              : outOfProjectAgent
                ? outOfProjectRecoveryNote(outOfProjectWords(outOfProjectAgent, item), `The run interrupted by the restart (attempt ${run.attempt})`, outOfProjectAgent.role)
                : (notResumable ??
                `A run on this ticket (attempt ${run.attempt}) was interrupted and had no thread to resume, so it's marked orphaned. The ticket stays in "${item.stepId}".`),
          // A change the user made themselves — the backend on the
          // agent, the servers ticked onto it — needs no reply: the
          // scheduler will pick the item up again on its own. Nor does
          // a duplicate interrupted run, which needs no reply because
          // the run that won is already carrying on.
          //
          // An archived agent is the same kind of thing: a person
          // retired it, the step is owned by a role rather than by that
          // agent, and the item goes back to the scheduler for whoever
          // else holds it. Where nobody does, the step says so through
          // `no_enabled_agent` — which is the answer to a different
          // question than "did your run survive the restart".
          ...(notResumable || claimedElsewhere || retiredAgent || outOfProjectAgent
            ? {}
            : { mentions: [{ type: "human" as const }] }),
        });
      }

      announceRun(run.id, run.itemId, "orphaned");
      summary.orphaned++;
    }

    // E-04's remaining step: "then release stale git worktrees". Fired
    // after the run rows are settled above, so "no active run" is
    // already true for anything just orphaned. Deliberately still not
    // awaited, even now that this function is async: what `start()` and
    // `resume()` chain their first tick behind is the *reconciling*, and
    // releasing a directory is not something that tick depends on.
    // Awaiting it would put a git operation on the path between a person
    // pressing Resume and the first agent moving.
    void releaseStale();

    // The runs that ended with skills given and no settled event — from
    // before the event existed, or orphaned just above (EO-720).
    settleOwnSkillUsage();

    return summary;
  }

  /**
   * Every installed kind lets go of whatever nothing is working in any
   * more (EO-295).
   *
   * Each in turn rather than the item's one, because this sweep has no
   * item: it is the question "is anything still using this" asked of
   * every disk EO has ever prepared, and only the kind that prepared one
   * can answer it. Failures are the kind's to report — the sweep runs
   * behind a reconciliation nobody is waiting on.
   */
  async function releaseStale(): Promise<void> {
    // The core's kinds too, and by slug so that a pack replacing one is
    // swept once rather than twice (EO-299). `scratch` is why this
    // matters: its directories are the only thing EO makes that nothing
    // else would ever come back for.
    const sweeping = new Map<WorkspaceKindSlug, WorkspaceKind>([...coreKinds, ...kinds]);
    for (const kind of sweeping.values()) await kind.release({ what: "stale", hasActiveRun });
  }

  /** Does any run for this item key still hold its worktree? Drives stale-worktree cleanup. */
  function hasActiveRun(itemKey: string): boolean {
    return listActiveRuns(db).some(
      (run) => getItem(db, run.itemId)?.key === itemKey,
    );
  }

  /**
   * The forced restarts that may happen now: every one but those on an
   * archived project (EO-347), and those of an agent a pause holds (EO-615).
   *
   * Kept rather than dropped, so a project archived while the engine
   * was paused gets its replacement runs when it is restored. Filtered
   * in both places the tick reads them, because a tick that waited for
   * the list to empty before dispatching anything else would wait for
   * as long as the project stayed archived.
   */
  function restartableIntents(): ForcedRestartIntent[] {
    const shelved = itemsOnArchivedProjects(db);
    return forcedRestartIntents().filter((intent) => !shelved.has(intent.itemId) && !heldBack(getAgent(db, intent.agentId as Uuid), intent.itemId as Uuid));
  }

  async function restartForcedRuns(): Promise<void> {
    await Promise.all(
      restartableIntents().map(async (intent) => {
        const item = getItem(db, intent.itemId);
        const agent = getAgent(db, intent.agentId);
        if (!item || !agent) {
          clearForcedRestart(intent.cancelledRunId);
          return;
        }

        // Moved to another project since its run was stopped (EO-474).
        // The promised replacement was a replacement *by this agent*,
        // and this agent no longer works here — so the promise is
        // settled with a sentence rather than kept, and the item is
        // left for the scheduler to staff from its own project.
        if (!servesProject(agent, item)) {
          clearForcedRestart(intent.cancelledRunId);
          postComment(db, {
            itemId: item.id,
            author: { type: "engine" },
            kind: "note",
            body: outOfProjectRecoveryNote(outOfProjectWords(agent, item), "The run that was stopped here", agent.role),
          });
          onItemChanged(item.id);
          return;
        }

        // Carried on in its own thread where it can be, as a restart is
        // (`continueOnThread`): the agent keeps what it had read and
        // planned, and is told why it is being spoken to again. The
        // thread has to be one this agent can still resume — the same
        // rules `reconcileNow` applies — and the initiation must not have
        // been interrupted past its ceiling.
        const stopped = getRun(db, intent.cancelledRunId as Uuid);
        const threadId =
          stopped && stopped.threadId !== null && !stopped.threadLost && agent.archivedAt === null && resumeBlockedReason(stopped, agent) === null
            ? stopped.threadId
            : null;
        // The stopped run is counted already: it is the latest interruption.
        const withinCeiling = stopped !== undefined && (isSystemAgent(agent) || countInterruptions(stopped.itemId, stopped.initiationId) < MAX_INTERRUPTIONS_PER_INITIATION);
        if (stopped && threadId !== null && withinCeiling && stopped.initiationId !== null) {
          // Through `dispatchRun`, so every check a dispatch makes before
          // anything starts still applies: the budgets, the backends an
          // organisation allows, the sign-in, an archived project.
          const continuing = dispatchRun(item, agent, intent.action, {
            initiationId: stopped.initiationId,
            transitionOnSuccess: intent.transitionOnSuccess,
            onRunAdmitted: () => clearForcedRestart(intent.cancelledRunId),
            continueThread: { from: stopped, threadId, message: intent.interruption === "sleep" ? SLEEP_RESUME_MESSAGE : QUIT_RESUME_MESSAGE },
          }).finally(() => inFlight.delete(continuing));
          inFlight.add(continuing);
          await continuing;
          letGoIfRefused(intent, stopped.initiationId);
          return;
        }

        // A destructive close promises a replacement for this exact job,
        // not merely another scheduler opportunity. Give it a fresh
        // initiation so an exhausted interrupted attempt cannot block the
        // replacement, and always enter through provider.start().
        //
        // Except an initiation already interrupted past its ceiling: that
        // one is dispatched under its own id, so the refusal that ceiling
        // carries is what answers it, with its comment, rather than a
        // fresh id quietly starting the count again.
        const initiationId =
          stopped !== undefined && !withinCeiling && stopped.initiationId !== null ? stopped.initiationId : `forced-restart:${intent.cancelledRunId}`;
        const promise = dispatchRun(item, agent, intent.action, {
          initiationId,
          transitionOnSuccess: intent.transitionOnSuccess,
          // Consume the interrupted run's intent as soon as its replacement
          // has a durable row. If that replacement is force-cancelled too,
          // cancelActiveRun persists its own intent, preserving one logical
          // replacement across repeated destructive closes.
          onRunAdmitted: () => clearForcedRestart(intent.cancelledRunId),
        }).finally(() => inFlight.delete(promise));
        inFlight.add(promise);
        await promise;
        letGoIfRefused(intent, initiationId);
      }),
    );
  }

  /**
   * Forgets a forced restart whose dispatch was refused.
   *
   * A refusal writes a placeholder run and its comment — that is the
   * account of what became of the promised restart — but no run is
   * admitted, so `onRunAdmitted` never clears the intent. Left standing,
   * it would be offered again on every tick, refused silently each time
   * (`alreadyRefused`), and hold every other dispatch back behind it: the
   * tick runs nothing else while a restart is pending. A dispatch that
   * turned back without a refusal — paused, or the agent's tools changed
   * under it — keeps its intent, and the next tick tries again.
   */
  function letGoIfRefused(intent: ForcedRestartIntent, initiationId: string): void {
    if (alreadyRefused(intent.itemId, initiationId)) clearForcedRestart(intent.cancelledRunId);
  }

  /**
   * What the record will let this device run (EO-324, ARCHITECTURE.md, "The record").
   *
   * The supervisor's own door onto `ItemRecord.offerWork`, and the one
   * the record's `record:work` handler is wired to on a server — which
   * is the point of it being here rather than inline in the tick. The
   * record's scheduler has to be *the* scheduler: the same guards, the
   * same concurrency caps, the same pack contributions this process
   * would apply to a dispatch of its own. A second tick input built
   * somewhere else would be a second scheduler with a different opinion.
   *
   * `input` is passed by the tick, which has just built one for the
   * standing asks (EO-213) and has no reason to build it twice. The
   * record handler passes none and one is built here.
   */
  async function offerWork(
    who: string,
    capacity: number | null,
    input?: TickInput<GateRefusal>,
    // What kind of machine is asking (EO-330, ARCHITECTURE.md, "Where a job runs"). Defaulted
    // rather
    // than taken from this supervisor's own `runsWhere`, and the
    // difference matters on exactly one caller: a server answering
    // `record:work` is answering *for somebody's laptop*, and passing
    // its own placement there would offer a desktop the work a person
    // put on the server.
    runsOn: JobRunsOn = DEFAULT_JOB_RUNS_ON,
  ): Promise<WorkOffer[]> {
    // No early return for a capacity of nought or null, deliberately.
    // Asking for no work is still asking, and the record's sweep happens
    // inside the ask — a server whose desktops are all asleep would
    // otherwise never release an expired lease or say that it had
    // (invariant #8). A record that is somewhere else answers such an
    // ask without a round trip, because the sweep is its own business
    // and it is already doing it.
    const tickInput = input ?? tickInputNow();
    return record.offerWork({ deviceId: who, capacity, tickInput, runsOn });
  }

  /**
   * How many dispatches this machine could start right now.
   *
   * The configured global cap less what this device is already holding.
   * The record applies its own ceiling on top — it is the only thing
   * that can see every device at once — so this is a statement about
   * this machine rather than a decision about the installation. Nought
   * is not "nothing": what no cap holds back is offered past it (EO-616).
   */
  function capacityFor(input: TickInput<GateRefusal>): number | null {
    // A process that is not a device could not run a dispatch if it
    // were offered one, so it asks for none, not even that. Null rather
    // than a branch around the ask, because the record still has to hear
    // from this tick: `offerWork` is where the sweep lives, and an expired
    // lease on a server with no desktop currently asking would
    // otherwise never be released or said out loud (invariant #8).
    if (!dispatches) return null;
    // Less the slots side calls hold or wait for (EO-477), which are as
    // real a use of the global limit as a run is.
    // And less the runs still extracting with no lease to count them (EO-479).
    return Math.max(0, input.limits.globalConcurrency - heldLeases.size - sideCallSlots.reserved() - slotsOfFinishingRuns());
  }

  async function runTickOnce(): Promise<void> {
    // The barrier. Every dispatch trigger arrives here — the interval,
    // the debounce, `runOnce`, and the tick a caller fires straight after
    // asking for reconciliation — so this is the one place that has to
    // hold them, and holding them here means no caller has to remember.
    //
    // Waited on rather than skipped, because the guarantee is about
    // *order* and not about dropping work: a caller that awaited a tick
    // is owed one, and a tick that returned early here would strand a
    // `notifyStateChange` until the next interval. Several triggers
    // waiting on the same promise all resume together and collapse into
    // one pass through `tickInFlight` below.
    //
    // And nothing is rechecked afterwards. `stopped` starts *true* and
    // only `start()` clears it, so a guard on it here would refuse every
    // `runOnce` on a supervisor a test drives directly — which is most
    // of them. Whether a tick already in flight should notice a `stop()`
    // is a question this file answered before EO-151 and is not one the
    // barrier gets to change.
    if (reconciling !== null) await reconciling;

    if (tickInFlight !== null) {
      rerunRequested = true;
      await tickInFlight;
      return;
    }
    let settle = (): void => {};
    tickInFlight = new Promise<void>((resolve) => {
      settle = resolve;
    });
    try {
      // A run this process adopted at boot but does not drive holds its
      // item until it ends, and this is where the end is noticed
      // (EO-132). Before anything below decides what to dispatch.
      releaseSettledAdoptions();
      // This device says its claims still stand, before anything else
      // (EO-322). It has to come first so that a run in flight is never
      // swept out from under itself; the sweep that releases whatever is
      // left over — by definition a device that stopped saying so, this
      // one before a crash or in managed mode a laptop that was closed —
      // is the record's own, and it happens inside `offerWork` below.
      // Each release is a comment naming the device (invariant #8).
      // A device says its claims still stand. A process that is not one
      // holds none and has nothing to say.
      if (dispatches) await device.renewClaims();
      // And then settle up with the record, if it is somewhere else
      // (EO-324, ARCHITECTURE.md, "The record"). What this device did goes over, what the record
      // has comes back, and only then does anything below decide what
      // to dispatch — because deciding against a board a reconnect is
      // about to change is deciding twice.
      //
      // Absent in solo mode, where both halves of that sentence are
      // this process.
      await record.sync?.();
      // Before the first dispatch of the upgrade, and only ever once:
      // an installation that has just been given a daily spend ceiling
      // it never chose is told so before anything can be stopped by it
      // (EO-211). Silent on every other tick, and on every installation
      // whose saved guardrails already answer the question.
      announceDailyBudgetDefault(db);
      // Forced-close replacements take priority over both workflow and
      // mention scheduling. In particular, a resolved manual mention or
      // a human-owned state has no ordinary dispatch to fall back on.
      if (dispatches && restartableIntents().length > 0) {
        await restartForcedRuns();
        if (restartableIntents().length > 0) return;
      }

      // The scheduler's second entry point (ARCHITECTURE.md, "Agent to agent", R-02): an agent that
      // has
      // been @-mentioned runs regardless of who owns the item's state.
      //
      // Offered *before* the state-driven dispatches below, which is new
      // with EO-132 and follows from what the lock made true: an item
      // now admits one of them rather than both, and whichever is
      // offered first is the one that claims it. Automatic dispatch is
      // the half that comes back unchanged — the item has not moved,
      // so the next tick offers it again — whereas an open mention is
      // only re-offered while nothing is running on the item, so
      // giving the state dispatch the item first would let a question
      // somebody asked wait behind a queue of attempts nobody is waiting
      // on. The person's question goes first; the pipeline is a tick
      // behind, which it can afford to be.
      // Held while paused, exactly like a normal dispatch: a pause stops
      // new work of every agent but the system agent, not just the
      // state-driven half. So what is the system agent's goes ahead here —
      // a chat turn, a mention of it, the reading of a reply — and anybody
      // else's is left open and offered again once EO is resumed.
      //
      // And skipped entirely on a process that is not a device (EO-324).
      // A mention and a reply are dispatches by another door: they run
      // an agent on this machine, which is precisely what a server has
      // none of. Gating only the state-driven half below would leave the
      // record answering people's questions with agents it cannot run.
      if (dispatches && !closing) {
        // A reply posted while paused is already durable, but its direct
        // resume call was gated. Recover those replies from the database
        // on every open-gate tick so they also survive an app restart.
        for (const itemId of deferredReplyItemIds()) {
          // Tracked in `inFlight` like every other branch of this loop.
          // It used to be launched loose, which worked only because
          // `resumeItem` reached its own `inFlight.add` before it first
          // yielded — an accident of there being no await above it, and
          // one that stopped being true the moment its prompt began to be
          // built asynchronously (EO-91). Untracked, the tick reports
          // itself idle with a resumed run still going, and the DB can
          // close underneath it.
          const promise = resumeItem(itemId, { requestedBy: "scheduler" })
            .catch((error: unknown) => {
              console.error(`[eo] resuming deferred reply on ${itemId} failed:`, error);
            })
            .finally(() => inFlight.delete(promise));
          inFlight.add(promise);
        }

        // A reply nobody could match, waiting to be read (EO-184).
        // Before the mention pass below only because it is the cheaper
        // question; either way each dispatch claims its own item, and
        // an item already held is simply offered again next tick.
        // Every item on a live project (EO-347). A mention or a reply on
        // an archived project's item is kept, as a pause keeps it, and
        // answered once the project is restored: while it is archived
        // no agent runs on anything of it, by any door.
        const shelved = itemsOnArchivedProjects(db);
        const answerable = listItems(db)
          .map((item) => item.id)
          .filter((id) => !shelved.has(id));

        for (const pending of findPendingInterpretations(
          db,
          answerable,
          readGuards().interpretReplies,
        )) {
          // Here and not left to the dispatch's own door: `executeInterpret`
          // asks for a tick when it ends, so one turned back at the door
          // would be offered again and again for as long as the hold lasted.
          if (heldBack(getAgent(db, pending.agentId), pending.itemId)) continue;
          const promise = executeInterpret(pending).finally(() => inFlight.delete(promise));
          inFlight.add(promise);
        }

        for (const pending of findPendingResponses(db, answerable)) {
          // Ahead of every refusal below: a mention a pause holds is not
          // answered yet, one way or the other, and it stays open.
          if (heldBack(getAgent(db, pending.agentId), pending.itemId)) continue;

          // The design's mention-depth cap, before the split below rather than
          // inside either branch (EO-212): a rerun request an agent
          // wrote is a hop in the same chain as a question it asked, and
          // a cap one of the two paths did not apply would be a cap with
          // a way round it.
          const tooDeep = mentionDepthBlocker(pending);
          if (tooDeep) {
            refuseMentionDepth(pending, tooDeep);
            continue;
          }

          // A mention that asked for the step to be run again is a
          // dispatch, not a reply, and takes the other path (EO-135).
          const work =
            pending.rerunStepId === undefined
              ? executeRespond(pending)
              : executeRerun(pending, pending.rerunStepId);
          const promise = work.finally(() => inFlight.delete(promise));
          inFlight.add(promise);
        }
      }

      const tickInput = {
        ...tickInputNow(),
        // The global slots side calls hold or wait for (EO-477), so the
        // record's own pick leaves them free as `capacityFor` does.
        // And a run past its terminal row, still extracting, that no
        // lease is counting (EO-479).
        reservedSlots: sideCallSlots.reserved() + slotsOfFinishingRuns(),
      };
      // Said before anything is dispatched, and from the same input the
      // dispatches are decided from (EO-213). An item turned away for
      // want of criteria is turned away on every tick from here on, and
      // silence is what EO-204 cost: eleven rounds of a reviewer coping
      // with an item EO should never have handed it. The same pass
      // takes the ask back down again, on the tick that sees the
      // criteria and before the review it releases.
      settleReviewCriteriaAsks(tickInput);
      // **The device asks; it does not decide** (EO-324, ARCHITECTURE.md, "The record"). What
      // comes back is work the record has already leased to this
      // machine. In one process that is the same sweep-pick-claim this
      // loop used to perform in three statements of its own; across two
      // it is the only arrangement in which the record is the only
      // scheduler, because a device that never picks cannot pick
      // differently. A record that cannot be reached offers nothing,
      // which is "offline means finish the run you hold, never keep
      // scheduling locally" (the original design) with no branch to write.
      for (const offer of await offerWork(deviceId(), capacityFor(tickInput), undefined, runsWhere)) {
        const promise = executeDispatch(offer.dispatch, offer.lease).finally(() =>
          inFlight.delete(promise),
        );
        inFlight.add(promise);
      }
    } finally {
      tickInFlight = null;
      // Released before the rerun is started, so a caller joining this
      // pass is not also made to wait on the next one.
      settle();
      if (rerunRequested) {
        rerunRequested = false;
        void runTickOnce();
      }
    }
  }

  /**
   * EO's standing ask for the criteria a review needs, raised and
   * lowered (EO-213).
   *
   * Both halves in one pass because they are one fact. `tick()` skipping
   * an item is silent by construction — it returns the dispatches it
   * made, not the ones it declined — and silence is what a person cannot
   * tell apart from "still working" (invariant #8). So the one blocker
   * EO can act on rather than merely report gets the treatment every
   * other refusal gets: a placeholder run carrying the reason, an
   * escalation naming a human, and `!` on the item.
   *
   * Refused here rather than inside the run, which is the point of the
   * story. A review that starts and then finds it has nothing to judge
   * against has already spent the dispatch, and what it does next is
   * improvise a list out of the thread — which EO-200's coverage check
   * then has nothing to hold it to.
   *
   * **And withdrawn once it is answered**, which is the half that makes
   * the ask honest. `!` is derived and never stored (invariant #6), so
   * it derives from an open human mention — and a mention nothing ever
   * closes is an item that sits in the inbox after its review has run
   * and been approved, asking for something it already has. Nothing else
   * would close it: the criteria arrive as an edit, not as a reply, so
   * neither the resume path nor `resolveMentions` ever sees them.
   *
   * Withdrawn from the *item's* state rather than from the edit that
   * changed it, which is why this is here and not in `updateItemText`.
   * Criteria reach an item through more than one door — `ticket_update`
   * and the item screen share one, and a Jira pull is another — and a
   * fix at one door leaves the others raising an `!` nobody can lower.
   *
   * Dismissed rather than addressed, and silently: nothing replied to
   * it, and EO turning its own request into the run it was asking for is
   * exactly what `dismissOpenMentionsForComment` is for. The thread
   * already shows what happened — the criteria edit posts its own
   * `decision` comment, and the review follows it on this same tick — so
   * a third comment saying "thank you" would be noise on every item
   * this ever touches.
   *
   * The open ask is also what stops the refusal repeating, in place of
   * the `alreadyRefused` gate the attempt-limit guard uses. That gate
   * asks about a run row, which is a proxy; this asks the question the
   * refusal exists to raise — is EO already asking? — so raising and
   * lowering cannot come apart, and a condition that somehow returned
   * after being answered would be asked about again rather than
   * silently blocking the item forever.
   *
   * The agent is looked up rather than passed because there is no
   * dispatch to have carried one. It may be null: a review step whose
   * role nobody holds is refused for its criteria first, since that is
   * the half the person reading the item can fix.
   */
  function settleReviewCriteriaAsks(input: TickInput<GateRefusal>): void {
    const itemById = new Map(input.items.map((item) => [item.id, item]));
    /** Items already being asked, so the refusal below says it once rather than once a tick. */
    const asked = new Set<Uuid>();

    for (const { comment } of openMentionsForHuman(db)) {
      if (!isMissingCriteriaAsk(comment.body)) continue;
      // Not in this tick's items: archived or deleted since. Neither is
      // ours to answer, and an archived item's inbox entry goes with
      // the archive rather than with this.
      const item = itemById.get(comment.itemId);
      if (!item) continue;
      if (declaresNoCriteria(item, shapeOf(item))) {
        asked.add(item.id);
        continue;
      }
      dismissOpenMentionsForComment(db, comment.id);
      // No run row changed, so nothing else asks the renderer to refetch
      // — and the `!` coming off the card is the visible half of this.
      onItemChanged(item.id);
    }

    for (const { item, blocker } of dispatchBlockers(input)) {
      if (blocker.kind !== "no_acceptance_criteria") continue;
      if (asked.has(item.id)) continue;
      const initiationId = workflowInitiationId(item, REVIEW_ACTION);
      const step = stepForItem(db, item);
      const reviewer =
        staffingAgents(input.agents, step?.ownerRole ?? null, item)[0] ?? null;
      refuseDispatch(
        item,
        reviewer,
        REVIEW_ACTION,
        missingCriteriaRefusal(item, shapeOf(item)),
        initiationId,
        countAttempts(item.id, initiationId) + 1,
      );
    }
  }

  /**
   * The parked items with something the step that parked has not read.
   *
   * A person's reply, which is what this has always meant — and since
   * EO-184 a system agent's reading of one, because a reply nobody could
   * match is answered by the interpreter rather than by the step, and
   * the answer it posts is what the step is then run against.
   *
   * The two halves are exclusive by construction, which is what stops
   * this offering the same item every tick forever: a reply the
   * interpreter has taken — already read, or about to be — is not work
   * for the step, so re-running it would be running the very thing the
   * interpretation was dispatched instead of. `awaitsTheStep` is where
   * that is decided, from the interpret runs on the item.
   */
  function deferredReplyItemIds(): Uuid[] {
    const awaiting = listAwaitingInputItemIds(db);
    // Not on an archived project (EO-347). The reply stays durable and
    // this offers it again on the first tick after the project is
    // restored, which is exactly what it already does for a pause.
    const shelved = itemsOnArchivedProjects(db);
    return [...awaiting].filter((itemId) => {
      if (shelved.has(itemId)) return false;
      if (unansweredQuestions(db, itemId).length > 0) return false;
      const priorRun = newestParkedRun(db, itemId);
      if (!priorRun) return false;
      // A reply to a run a pause holds, or to a parked builtin or module,
      // waits for the resume: only what the system agent parked carries on.
      if (heldBack(agentOf(priorRun), itemId)) return false;
      const item = getItem(db, itemId);
      const pending = item ? pendingInterpretation(db, item, priorRun, readGuards().interpretReplies) : null;
      const interpretations = interpretationsOn(db, itemId);
      const endedAt = priorRun.endedAt ?? 0;
      return listCommentsForItem(db, itemId).some(
        (comment) =>
          awaitsTheStep(comment, interpretations, pending) &&
          (comment.createdAt > endedAt || (comment.createdAt === endedAt && comment.id > priorRun.id)),
      );
    });
  }

  async function waitForIdle(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  }

  function start(): void {
    if (!stopped) return;
    stopped = false;
    // ARCHITECTURE.md, "Reconciling on launch": no dispatch before reconciliation completes.
    // `reconciling` is
    // what enforces that now, and it is raised synchronously by the call
    // below — so the timer can be created immediately and the ordering
    // no longer rests on this function having remembered to chain.
    //
    // That matters more than it reads. The chained version was correct
    // about its *own* tick and silent about the interval it then created,
    // which is exactly the gap this closes: a timer firing mid-pass now
    // waits at the barrier like everything else.
    void reconcile();
    intervalTimer = setInterval(() => void runTickOnce(), tickIntervalMs);
    intervalTimer.unref?.();
    lastWatchdogPassAt = now();
    watchdogTimer = setInterval(watchLiveRuns, watchdogIntervalMs);
    watchdogTimer.unref?.();
    stopHearingWakes = onWake?.(() => noteWake());
    memoryConsolidator.start();
    void runTickOnce(); // do not rely on the interval alone — also tick once at startup
  }

  function stop(): void {
    stopped = true;
    if (intervalTimer) clearInterval(intervalTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    stopHearingWakes?.();
    memoryConsolidator.stop();
    intervalTimer = undefined;
    debounceTimer = undefined;
    watchdogTimer = undefined;
    stopHearingWakes = undefined;
  }

  function notifyStateChange(options?: { promptly?: boolean }): void {
    if (stopped) return;
    // A person pressing Send in a conversation is one deliberate act, not
    // a burst worth coalescing, and every millisecond here is a
    // millisecond before the first word: the tick is brought forward to
    // the next turn of the loop rather than waiting out the debounce.
    if (options?.promptly) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        void runTickOnce();
      }, 0);
      return;
    }
    if (debounceTimer) return; // a tick is already scheduled
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void runTickOnce();
    }, debounceMs);
  }

  /** What the inactivity guard reads off one event (`runActivity`). */
  function noteActivity(runId: string, event: AgentEvent): void {
    const activity = runActivity.get(runId);
    if (!activity) return;
    activity.events += 1;
    if (event.type === "heartbeat") {
      if (event.callStarted) activity.openCalls.add(event.callStarted);
      return;
    }
    activity.lastWord =
      event.type === "tool_call"
        ? `a call to ${event.name}`
        : event.type === "retrying"
          ? "a retry"
          : event.type === "compacted"
            ? "a compaction of its conversation"
            : `its ${event.type.replace(/_/g, " ")}`;
    // Only a call with an id is held open: its result names it, and that
    // is what closes it. A call with none — Codex's web search — has no
    // result to wait for, and counting it would switch the guard off for
    // the rest of the turn.
    if (event.type === "tool_call") activity.callsSinceReminder += 1;
    if (event.type === "tool_call" && event.callId) activity.openCalls.add(event.callId);
    else if (event.type === "tool_result" && event.callId) activity.openCalls.delete(event.callId);
    else if (event.type === "result") activity.openCalls.clear();
  }

  /**
   * One pass of the inactivity guard over the runs in flight — what the
   * watchdog timer does every `watchdogIntervalMs`, and what a test calls
   * as it would `runOnce`.
   *
   * Claude Desktop does the same for its sessions: a run whose backend
   * has said nothing for `inactivityTimeoutMs` has most likely stopped
   * responding, and waiting out the whole wall clock on it is half an
   * hour of nobody knowing. Two things are not silence. A tool that is
   * running — a test suite, a build — is the agent at work however quiet
   * it is, so a run with a call open is not measured. And time the
   * computer spent asleep is nobody's: silence is counted from the later
   * of the run's last word and the last wake.
   *
   * A run that goes on being silent after a wake is carried on in its
   * own thread and told why, as Desktop does after a sleep — the
   * backend's connection did not survive it, and the agent did nothing
   * wrong. Any other is stopped the way the wall clock stops one: parked
   * with an escalation that says so, its thread kept for a reply. But for
   * the system agent's, which is left to go on being silent (EO-616).
   */
  function watchLiveRuns(): void {
    const at = now();
    if (lastWatchdogPassAt !== null && at - lastWatchdogPassAt > watchdogIntervalMs + LATE_PASS_MS) noteWake(at);
    lastWatchdogPassAt = at;
    const limit = readGuards().inactivityTimeoutMs;
    if (!(limit > 0)) return;
    for (const [runId, activity] of runActivity) {
      if (activity.events !== activity.seenEvents) {
        activity.seenEvents = activity.events;
        activity.lastAt = at;
      }
      const controller = activeControllers.get(runId);
      if (!controller || guardTripReasons.has(runId)) continue;
      if (activity.openCalls.size > 0) continue;
      const quietSince = Math.max(activity.lastAt, lastWakeAt ?? 0);
      if (at - quietSince < limit) continue;
      if (lastWakeAt !== null && activity.lastAt < lastWakeAt) {
        cancelActiveRun(runId, "restart-on-resume", "sleep");
        notifyStateChange();
        continue;
      }
      if (activity.systemAgent) continue;
      const minutes = Math.max(1, Math.round((at - activity.lastAt) / 60_000));
      guardTripReasons.set(
        runId,
        `No word from ${activity.agentName}'s backend for ${minutes} minute(s) while no tool was running — the last thing it said was ` +
          `${activity.lastWord ?? "nothing at all"} — so EO stopped the run rather than wait on a process that may have stopped responding. ` +
          `Reply to carry on in the same thread.`,
      );
      controller.abort();
    }
  }

  /**
   * The computer has woken: silence before now is not any run's.
   *
   * What a run said since the last pass is credited to before the sleep,
   * which is when it said it — so a backend that went quiet across the
   * sleep is recognised as having done so, not as having just spoken.
   */
  /**
   * Whether checks are held right now (EO-457): offline, or within a
   * minute of the last wake — `onWake`'s, or a late watchdog pass's.
   * Never for a wake on a machine that does not sleep (`sleeps`, EO-514).
   */
  function currentWatchHold(): WatchHold | null {
    return watchHold(isOnline(), sleeps ? lastWakeAt : null, now());
  }

  function noteWake(at: number = now()): void {
    const before = Math.min(lastWatchdogPassAt ?? at, at - 1);
    for (const activity of runActivity.values()) {
      if (activity.events === activity.seenEvents) continue;
      activity.seenEvents = activity.events;
      activity.lastAt = Math.max(activity.lastAt, before);
    }
    lastWakeAt = at;
    // The pass after a wake is not late: the wake is already noted, and a
    // second note would credit what was said since to before the sleep.
    lastWatchdogPassAt = at;
  }

  function cancelActiveRun(runId: string, cancellation: Cancellation, interruptedBy: RunInterruption | null = null): void {
    // A pause that puts its runs back is a close unless something else is named.
    const interruption: RunInterruption | null = cancellation === "restart-on-resume" ? (interruptedBy ?? "quit") : interruptedBy;
    // Before the guard below, and that is the whole reason it is a
    // separate line rather than part of the block that follows. A run
    // syncing its index at a handover (EO-153) has already given up its
    // entry in `activeControllers` — its result is accepted and its row
    // is terminal — so every early return under this point would leave
    // the indexer running in a checkout the person has finished with.
    activeHandoverSyncs.get(runId)?.abort();

    const controller = activeControllers.get(runId);
    if (!controller) return;
    const id = runId as Uuid;

    // Persist before asking the backend to stop. Shutdown cleanup is
    // deliberately bounded, so this row must already be terminal if the
    // provider ignores cancellation and the process exits first.
    if (cancellation === "restart-on-resume") {
      const intent = activeRestartIntents.get(runId);
      if (intent) persistForcedRestart({ ...intent, ...(interruption ? { interruption } : {}) });
    }
    forcedCancellationRunIds.add(runId);
    const run = getRun(db, id);
    if (run && (run.status === "queued" || run.status === "running")) {
      updateRun(db, id, {
        status: "cancelled",
        error:
          interruption === "sleep"
            ? "its backend went quiet after the computer slept; carried on in the same thread"
            : interruption === "quit"
              ? cancellation === "restart-on-resume"
                ? "stopped when EO was closed; carried on when it opens again"
                : "stopped when EO was closed"
              : "cancelled before the agent finished",
        // "Stop agents and close", or a sleep the backend did not come
        // back from: the run is carried on in its own thread
        // (`restartForcedRuns`), and is not an attempt the agent spent.
        ...(interruption ? { interruption } : {}),
        // The session it was talking to, where it got far enough to be
        // told one. A fresh run's id is held in memory until the run
        // ends, and this ending comes before that: without it a stopped
        // run would have no thread to be carried on in.
        ...(lastKnownThreadIds.has(runId as Uuid) ? { threadId: lastKnownThreadIds.get(runId as Uuid)! } : {}),
        endedAt: now(),
      });
      // Only where the cancellation was the whole of what was asked for,
      // and only once — this block runs once per run, because the guard
      // above returns for a run nothing is driving (EO-175).
      if (cancellation === "asked-to-stop") endInitiation(run);
      announceRun(id, run.itemId, "cancelled");
    }

    controller.abort();
    try {
      void activeStreams.get(runId)?.interrupt?.().catch(() => undefined);
    } catch {
      // The durable cancelled row is authoritative even if a provider's
      // best-effort interrupt hook throws synchronously.
    }
  }

  function cancelRun(runId: string, cancellation: Cancellation = "asked-to-stop"): void {
    cancelActiveRun(runId, cancellation);
  }

  /**
   * A person's message, said to the agent that is working right now
   * (EO-176).
   *
   * Reads `activeStreams` exactly as `cancelActiveRun` does, and writes
   * none of what that writes. The comparison is worth making explicit,
   * because the difference is the story: cancelling ends a turn and has
   * to leave a durable account of having done so, while this changes one
   * without ending it. There is no state for it to record. The run row
   * is untouched, the item has not moved, and if this function did
   * start writing run rows the thing being built would be
   * stop-and-restart again — which EO already has, under the name
   * `discussions:send`'s `interrupt`, and which is not what was asked
   * for here.
   *
   * What it does write is one append-only `run_events` row, and that is
   * a record of the *delivery* rather than of a decision: it puts the
   * message in the transcript at the point it landed, which is where
   * somebody watching the agent work will look for it. Written for a
   * queued message too — a person who typed into the box while a run was
   * going should be able to see that they did.
   */
  async function steerRun(runId: string, message: SteeredMessage): Promise<SteerResult> {
    const stream = activeStreams.get(runId);
    if (!stream) {
      // No turn to push into — but a run row can be live for a long
      // while with no stream against it, and a message that lands in
      // one of those windows must not simply evaporate.
      //
      // There are two of them, and they are ordinary rather than
      // exotic. A dispatch writes `running` and then spends seconds
      // preparing — auth, a worktree, a context assembly, resolving the
      // query server — before a provider stream exists (`resumeItem`
      // does exactly this around its `repositoryMcpServer` await). And
      // at the other end, a turn's stream is finished and released
      // several awaits before the row it belongs to becomes terminal.
      //
      // What makes those windows dangerous is the watermark rather than
      // the silence. A comment posted while a run is live is *older*
      // than the `endedAt` that run eventually gets, so the follow-up
      // delta drops it (`followUpComments`), and a next turn that reuses
      // the thread would never see it at all. The undelivered row is
      // exactly what that function looks for, so writing one here is
      // what keeps the message reaching somebody.
      //
      // Only against a row that is not terminal yet. Once a run has an
      // `endedAt`, the comment is on the later side of the watermark and
      // the ordinary delta carries it — a row written then would earn
      // nothing and would tell a second turn to re-read a message it had
      // already been given.
      const run = getRun(db, runId as Uuid);
      if (run && (run.status === "queued" || run.status === "running")) recordMessageOnRun(runId, message, false);
      return "no-live-run";
    }

    const outcome = await deliver(stream, { ...message, attachments: message.attachments ?? attachmentsPostedWith(message.commentId) });
    recordMessageOnRun(runId, message, outcome === "steered");
    return outcome;
  }

  /**
   * The files on the comment a steered message was posted as (EO-395).
   *
   * Read here rather than taken from the caller. The comment is the
   * record and this is only its delivery, so the list the agent is
   * given is the list a person can see under their message — and every
   * composer that steers gets it without having to know to ask. Before
   * this, a steered message was its text alone: a screenshot sent a
   * moment after the message it belonged to was never mentioned to the
   * agent, and one sent with nothing typed steered an empty string.
   */
  function attachmentsPostedWith(commentId: Uuid): AgentInputAttachment[] {
    return safeTurnAttachments(getComment(db, commentId)?.attachments ?? []);
  }

  /**
   * The push itself, kept apart from the recording so the two cannot
   * disagree about what happened.
   *
   * `steer` being absent is the optional-capability contract of
   * `InterruptibleStream` being exercised, not a fault: Codex is a
   * backend that genuinely cannot be spoken to mid-turn, and a caller
   * that treated its absence as a failure would be lying to the person
   * about a message that is perfectly safe on the item.
   */
  async function deliver(stream: InterruptibleStream<AgentEvent>, message: SteeredMessage): Promise<SteerResult> {
    if (message.delivery === "next") return "queued";
    if (!stream.steer) return "unsupported";
    try {
      return (await stream.steer(message.body, message.attachments ?? [])) ? "steered" : "turn-over";
    } catch {
      // A backend that threw on the way in has not taken the message,
      // and that is all this needs to know. The comment stands, the next
      // turn reads it, and the person is told which of the two happened.
      return "turn-over";
    }
  }

  /**
   * The delivery, in the run's own log (invariant #3: appended, never
   * updated).
   *
   * Through the run's own buffer where there is one, because
   * `run_events.seq` is allocated in memory per run — see
   * `activeEventBuffers` — and a second allocator over the same run
   * would hand out a number the stream had already spent. Where there is
   * none, and only then, the row is inserted directly: a run being
   * prepared or already wound down has nothing buffering it, so reading
   * the persisted maximum is the whole truth. The choice and the write
   * are one synchronous breath, which is what makes the choice sound —
   * `driveToCompletion` and `runBuiltinHeld` each register and release
   * their buffer without an await between, so this cannot see a
   * half-torn-down one. Every run the supervisor drives is registered
   * here while its buffer is live. (A module dry run was the one writer
   * that was not, until EO-353 removed it; a run row flagged `dry_run`
   * from before then is history, and `deliverToLiveRun` never steers
   * into one.)
   *
   * Flushed on the spot and pushed either way, because the person who
   * typed the message is watching this transcript *now* and a throttled
   * write would show it seconds late or not at all.
   */
  function recordMessageOnRun(runId: string, message: SteeredMessage, delivered: boolean): void {
    const payload: HumanMessageEvent = {
      commentId: message.commentId,
      body: message.body,
      delivery: message.delivery,
      delivered,
    };
    const buffer = activeEventBuffers.get(runId);
    if (buffer) {
      buffer.append(runId as Uuid, HUMAN_MESSAGE_EVENT, payload);
      buffer.flush();
    } else {
      record.appendRunEvent(runId as Uuid, HUMAN_MESSAGE_EVENT, payload);
    }
    onPushEvents?.(runId, []);
  }

  /**
   * Where a queued message has gone, once the run it was queued behind
   * has handed the item on (EO-176, invariant #8).
   *
   * The one case a person cannot work out for themselves. They wrote to
   * an implementer, were told it would be read by the next turn, and the
   * next turn is a different agent at a different step — so the message
   * is not lost, but it is not going where they thought either. Silence
   * here is the failure mode this exists to prevent, and the sentence
   * has to name the destination or it is not worth posting.
   *
   * Only for messages that were never delivered. One that was steered
   * into the turn has already been read by the agent it was written to,
   * and saying anything about it now would be telling somebody their
   * message went somewhere it did not.
   */
  function reportQueuedMessagesHandedOn(runId: Uuid, item: Item, fromAgentName: string): void {
    const queued = listRunEvents(db, runId).filter(
      (event) => event.type === HUMAN_MESSAGE_EVENT && (event.payload as HumanMessageEvent | null)?.delivered === false,
    );
    if (queued.length === 0) return;

    const moved = getItem(db, item.id);
    if (!moved) return; // deleted under the handover; nowhere to post
    const { nowAt, rerunWith } = whereItStandsNow(moved);
    const one = queued.length === 1;

    postComment(db, {
      itemId: item.id,
      runId,
      author: { type: "engine" },
      kind: "note",
      body:
        `${one ? "Your message" : `Your ${queued.length} messages`} to ${fromAgentName} ` +
        `${one ? "was" : "were"} queued for the next turn, and that run has now finished and handed this ticket on. ` +
        `It is at **${nowAt}** now, so ${one ? "it" : "they"} will be read by ` +
        `${rerunWith ?? `whoever picks the item up at "${nowAt}"`} rather than by ${fromAgentName}.\n\n` +
        `If ${one ? "it was" : "they were"} meant for ${fromAgentName}, @-mention ${fromAgentName} to send the ticket back.`,
    });
  }

  /**
   * A person's stop, made to last (EO-175).
   *
   * Cancelling wrote `cancelled` and stopped there, and the item was
   * then in none of the states the scheduler stands off: it had not
   * moved, was not held, was not awaiting an answer. So the next tick
   * offered the same step again, in the same initiation, and kept
   * offering it until the attempt limit stopped it three runs later —
   * which is a person's decision being treated as a hiccup to recover
   * from.
   *
   * Nothing is parked here, deliberately. A hold is a different state
   * with its own affordance and its own resume, and somebody who
   * cancelled a run has not asked for the item to be held; what they
   * asked for is for EO to stop, which is what recording the stop does
   * and nothing more.
   */
  function endInitiation(run: Run): void {
    const item = getItem(db, run.itemId);
    if (!item) return; // deleted under the cancellation; nowhere to post and nothing to stop

    // A step nothing was ever going to be dispatched at — a `user` step,
    // a terminal one, a discussion — stops nothing, and saying "nothing
    // will pick this up again" about it would be EO claiming a decision
    // it never had to take.
    const step = stepForItem(db, item);
    if (!step || step.isTerminal || step.type === "user") return;

    // The initiation read exactly as `dispatchHeld` reads its own, so
    // the stop and the dispatch it stops cannot name different things.
    recordStop(db, item.id, workflowInitiationId(item, run.action));

    const { nowAt, rerunWith } = whereItStandsNow(item);
    postComment(db, {
      itemId: item.id,
      runId: run.id,
      author: { type: "engine" },
      kind: "note",
      body: stoppedByHandNote(nowAt, rerunWith),
    });
  }

  function pause(opts: { cancelRunning?: boolean } = {}): void {
    paused = true;
    // Paused is nothing starting: a backend warmed for a turn is let go,
    // unless the turn is one that still starts.
    dropWarm(heldBack);
    // And EO's own housekeeping stops, not only what has yet to start
    // (EO-514). A memory consolidation is not work anybody is owed, and it
    // holds a global slot while it runs; a paused engine gives that back.
    // A run in flight is left to finish unless asked, because it is.
    memoryConsolidator.abortRunning();
    if (opts.cancelRunning) {
      for (const runId of [...activeControllers.keys()]) {
        if (!carriesOn(runId)) cancelActiveRun(runId, "restart-on-resume");
      }
      // Swept separately because they are in neither map the loop above
      // reads (EO-153). A run past its result is not restartable and is
      // not cancellable in the sense that loop means — there is nothing
      // to mark and nothing to resume — but the indexer it started is
      // as real as any other process and must not survive the drain.
      for (const [runId, controller] of activeHandoverSyncs) {
        if (!carriesOn(runId)) controller.abort();
      }
    }
  }

  function beginClose(opts: { cancelRunning?: boolean } = {}): void {
    closing = true;
    pause(opts);
  }

  function resume(): void {
    // The window stays open through a drain, and a Resume pressed there
    // must not start the work the close is waiting to be rid of.
    if (closing) return;
    paused = false;
    if (stopped) return;
    // Reconciliation may have been intentionally deferred at boot by a
    // restored pause — `reconcileNow` leaves the runs a pause holds alone,
    // so for an engine that started paused this is the *first* time it
    // reaches them, and each of them is still unreconciled.
    //
    // Nothing is chained here any more. `reconcile()` raises the barrier
    // synchronously, so the tick on the next line waits for the pass to
    // finish and so does every interval and debounce tick that fires
    // meanwhile. That is the difference between an ordering one function
    // arranges for itself and one the scheduler actually has: the
    // chained version left the interval free to dispatch an item this
    // pass had not reached yet.
    void reconcile();
    void runTickOnce();
  }

  /**
   * The scheduler's own answer about one item, asked with what this
   * installation actually has (KAN-161).
   *
   * `paused` is read here rather than taken from the caller for the
   * reason the input is built here: a caller assembling either for
   * itself is a second opinion, and the whole point of this seam is that
   * there is one.
   */
  function dispatchBlockerFor(itemId: Uuid): ItemBlocker | null {
    // The project first (EO-347): an item on an archived one is not in
    // the scheduler's input, and the engine would call it unknown.
    return archivedProjectBlocker(db, itemId) ?? dispatchBlocker(eligibilityNow(), itemId);
  }

  function isPaused(): boolean {
    return paused;
  }

  function activeRunCount(): number {
    return activeControllers.size;
  }

  function finishingRunCount(): number {
    return [...activeControllers.keys()].filter((runId) => !carriesOn(runId)).length;
  }

  async function shutdown(): Promise<void> {
    // Before anything is stopped, so a dispatch waiting on its memory's
    // selection sees it when the side call below is aborted (EO-478).
    shuttingDown = true;
    dropWarm(() => true);
    stop();
    // Side calls in flight, and waiting ones, are stopped: none of them
    // is work anybody is owed, and none may hold up quitting (EO-477).
    sideCaller.abortAll();
    // And the learning reviews, which are no more owed than a side call (EO-717).
    for (const controller of reviewControllers) controller.abort();
    // `superseded`: quitting is not somebody stopping this step, and a
    // shutdown that ended every live initiation would leave a board that
    // dispatches nothing on the next launch (EO-175).
    // And interrupted rather than failed (`RunInterruption`): EO going
    // away is not something the agent did, so whatever is dispatched for
    // this step next does not count it.
    for (const runId of [...activeControllers.keys()]) cancelActiveRun(runId, "superseded", "quit");
    // Same reason as in `pause`: a handover sync is a live process that
    // no entry in `activeControllers` stands for, and quitting EO must
    // not leave one behind (EO-153). `waitForIdle` below still waits for
    // the run's own promise, which is what the sync is inside of.
    for (const controller of activeHandoverSyncs.values()) controller.abort();
    // Give in-flight runs a chance to observe the abort and finish their
    // own cleanup (flush + mark cancelled) before returning control to
    // before-quit — bounded, so a stuck cleanup can't hang app shutdown.
    // If the app is killed harder than this, E-04 reconciles whatever's
    // left `running`.
    await Promise.race([
      waitForIdle(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    // And then nothing an agent started outlives EO (EO-494). Every turn
    // has been asked to end its own process tree, and one that has in
    // the time above is not here any more; one still in its grace — an
    // agent ignoring SIGTERM, a test runner it left in a session of its
    // own — is killed outright, because EO going away is not something a
    // process EO stops watching should survive. `exit` has a synchronous
    // backstop for a quit that never reaches this line (`processTree.ts`).
    await endAllProcessTrees();
  }

  async function runOnce(): Promise<void> {
    await runTickOnce();
    await waitForIdle();
  }

  /**
   * Can this run's session be handed to the agent's current backend?
   *
   * A session id means nothing outside the provider that issued it: give
   * a Codex thread to the Claude CLI and it answers "No conversation
   * found with session ID", which reaches the user as an opaque failure
   * on the reply they just wrote. A run with no recorded provider
   * predates A-07, so it is trusted rather than restarted — that is the
   * old behaviour, and it was right whenever the provider hadn't changed.
   */
  /**
   * Whether the item's files are still the ones a thread was told about
   * (EO-703) — asked at a resume's provider boundary, after the awaits
   * `resumeBlockedReason` was answered before.
   */
  function itemFilesUnchangedFor(run: Run): boolean {
    return (run.itemFilesHash ?? EMPTY_ITEM_FILES_HASH) === itemFilesHash(db, run.itemId);
  }

  /** What a resume that finds the item's files changed at its boundary says (EO-703). */
  function itemFilesChangedWhilePreparing(agent: Agent): string {
    return (
      `The files on this item changed while ${agent.name}'s conversation was being picked back up. A conversation ` +
      `already under way is not told about the item again, so it couldn't be carried over — starting a fresh run ` +
      `instead, which is how it sees the files as they are now. Nothing is lost: the new run is given the newest ` +
      `word from every step and everything you have said since.`
    );
  }

  /**
   * Closes a resume's run that never reached a backend because the item's
   * files changed under it (EO-703).
   *
   * Its thread id is cleared: the row opened no session of its own, and
   * left holding one it would be the agent's last run (`lastRunOf`) — the
   * watermark a fresh seed counts what the person said from, which would
   * put the reply this run was carrying behind it.
   */
  function closeForChangedFiles(run: Run, itemId: Uuid): void {
    updateRun(db, run.id, {
      status: "cancelled",
      endedAt: now(),
      threadId: null,
      interruption: "restart",
      error: "The item's files changed before this resume reached the backend, so nothing was started; a fresh run was dispatched instead.",
    });
    releaseRunControl(run.id);
    announceRun(run.id, itemId, "cancelled");
  }

  function resumeBlockedReason(run: Run, agent: Agent): string | null {
    if (run.provider !== null && run.provider !== agent.provider) {
      return (
        `This run was parked on the "${run.provider}" backend, and ${agent.name} now uses "${agent.provider}". ` +
        `A provider session can't be moved between backends, so the conversation couldn't be carried over — ` +
        `starting a fresh run instead. Nothing is lost: the new run is given the newest word from every step and everything you have said since, and can search the rest.`
      );
    }

    // The tool surface, on the same rule `findReusableThread` applies to
    // an automatic dispatch (EO-106) and for a reason EO-107 made
    // sharper. A resume re-spawns the backend and points it at a
    // directory generated from the catalogue *now*, so a thread whose
    // agent has had a server detached since would be resumed either with
    // that server quietly taken away mid-conversation, or — if it was
    // the only one — with the directory removed out from under it.
    // Refusing is the answer the rest of the codebase already gives:
    // the thread ends, a fresh run picks the new surface up, and the
    // reply is not lost because the new run is seeded from the thread.
    //
    // Null reads as the empty surface rather than as unknown, exactly as
    // it does in `findReusableThread`: nothing could be attached before
    // migration 0052, so a row predating it is not missing an answer.
    const runItem = getItem(db, run.itemId);
    const wanted = runItem ? runAttachmentsHash(agent, runItem) : agentAttachmentsHash(db, agent.id, UNSCOPED_RUN);
    if ((run.agentAttachmentsHash ?? EMPTY_ATTACHMENTS_HASH) !== wanted) {
      return (
        `The MCP servers or skills attached to ${agent.name} have changed since this run started. A provider ` +
        `session keeps the tools it was started with, so the conversation couldn't be carried over — starting a ` +
        `fresh run instead, which is how it picks the new ones up. Nothing is lost: the new run is given the ` +
        `newest word from every step and everything you have said since.`
      );
    }

    // The item's own files, on the rule `findReusableThread` applies to an
    // automatic dispatch (EO-703). A resumed thread is told nothing about
    // the item again, so a file put on it while the run was parked or
    // interrupted would never reach the agent, and one taken off would
    // still be listed in what it was told. Null reads as no files, as it
    // does there.
    if (runItem && (run.itemFilesHash ?? EMPTY_ITEM_FILES_HASH) !== itemFilesHash(db, runItem.id)) {
      return (
        `The files on this item have changed since this run started. A conversation already under way is not ` +
        `told about the item again, so it couldn't be carried over — starting a fresh run instead, which is how ` +
        `it sees the files as they are now. Nothing is lost: the new run is given the newest word from every step ` +
        `and everything you have said since.`
      );
    }

    return null;
  }

  /**
   * Ends a park whose agent has been retired, and says so (EO-186).
   *
   * The run is closed rather than left parked, exactly as
   * `resumeItemHeld` closes one whose item has moved off the step,
   * and for the same reason: `awaiting_input` on the newest run is what
   * keeps the scheduler away from this item, so a park nobody can ever
   * answer is an item stuck for good — the silent failure this whole
   * story is about. Cancelled rather than succeeded, because it did not
   * finish its work; it was abandoned.
   *
   * What the person said is not lost. It is a comment, which is the
   * record (invariant #4), and whoever picks the step up next is given
   * it along with everything else said since.
   *
   * Its own function because the reply path asks the question twice —
   * once when it reads the agent, and again after `buildContext` has
   * yielded the event loop — and one refusal in two wordings would be
   * two answers to the same fact.
   */
  function closeParkOfArchivedAgent(item: Item, priorRun: Run, agent: Agent): void {
    updateRun(db, priorRun.id, { status: "cancelled", endedAt: now() });
    postComment(db, {
      itemId: item.id,
      runId: priorRun.id,
      author: { type: "engine" },
      kind: "note",
      body:
        `${agent.name} was waiting for your answer here, and has since been archived. An archived agent is ` +
        `dispatched to nothing and nothing brings one back, so that run is closed and this ticket is free to ` +
        `carry on — give the "${agent.role}" role another agent if this step is still to be run.`,
    });
    announceRun(priorRun.id, item.id, "cancelled");
  }

  async function resumeItem(itemId: Uuid, opts: ResumeItemOptions = {}): Promise<void> {
    // A reply is work on the item like any other, so it claims the
    // item like any other (EO-132). This was the widest of the six
    // holes: it found the newest parked run and dispatched, without ever
    // asking whether something else was already live in that checkout.
    const outcome = await itemLock.run(itemId, () => resumeItemHeld(itemId, opts.requestedBy));
    if (outcome.claimed) return;

    // The scheduler's own recovery pass, which is not owed an answer:
    // it has written nothing, the item has not moved, and
    // `deferredReplyItemIds` offers the same item again on the next
    // open-gate tick. A comment per tick would report contention as if
    // it were a guard dropping work.
    if (opts.requestedBy === "scheduler") return;

    // A person, though, pressed Post and was told the reply had been
    // picked up. `postHumanComment` does not await this — resuming runs
    // an agent for minutes and the IPC response cannot be held open that
    // long — so the response has already gone out saying `resumedRun`.
    // The thread is the only channel left to correct that (invariant #4),
    // and saying nothing here is the version of this bug that looks like
    // a reply vanishing.
    //
    // A note rather than an escalation, and no human mention: the item
    // is being worked on right now, and raising `!` on it would be EO
    // asking for attention it does not need. The person is looking at
    // this thread — they just typed into it.
    postComment(db, {
      itemId,
      author: { type: "engine" },
      kind: "note",
      body: blockedByActiveRunRefusal("pick this ticket back up after your reply"),
    });
    // No run row to announce, so the refetch has to be asked for here.
    onItemChanged(itemId);
  }

  /** `resumeItem` with the item already claimed. Never call it directly. */
  async function resumeItemHeld(itemId: Uuid, requestedBy?: ResumeItemOptions["requestedBy"]): Promise<void> {
    // Not on an archived project (EO-347), for the same reason and with
    // the same recovery: `deferredReplyItemIds` offers the reply again
    // once the project is restored.
    if (shelved(itemId)) return;
    // Newest first, ties broken by id — the same order
    // `deferredReplyItemIds` and `listAwaitingInputItemIds` use, and
    // they must agree: those two decide *that* this item has a reply
    // waiting, this decides *which run* the reply belongs to. `startedAt`
    // alone does not settle it. `listRunsForItem` has no ORDER BY, so a
    // tie falls back to whatever order SQLite returned, and two parked
    // runs sharing a millisecond is exactly the case ids are minted
    // monotonically to resolve (see uuidv7). Picking the older one hands
    // the reply to the wrong run — most visibly when the newer is a real
    // parked run and the older a guard placeholder, which has no thread,
    // so a conversation that should have continued starts from scratch.
    const priorRun = newestParkedRun(db, itemId);
    if (!priorRun) return; // nothing awaiting a reply on this item

    const item = getItem(db, itemId);
    if (!item) return; // referenced rows must exist; defensive, shouldn't happen

    // Whoever parked is who a pause is asked about: a system agent's thread
    // carries on (EO-615). A reply to a parked builtin or module is read
    // now, by the interpretation the next tick offers, and the step it
    // would wake waits: `deferredReplyItemIds` offers it after the resume.
    const parkedAgent = agentOf(priorRun) ?? null;
    if (heldBack(parkedAgent, itemId)) {
      if (pendingInterpretation(db, item, priorRun, readGuards().interpretReplies) !== null) notifyStateChange();
      return;
    }

    // A step a trial plan mocks, on a trial item (EO-584), is mocked on a
    // reply too: before a parked builtin is re-run, a parked thread is
    // resumed or anything is prepared for a backend. The plan may have
    // been saved while the step was parked — a real run that stopped to
    // ask, planned as mocked before the answer — and a reply must not
    // start the run the person chose not to have. What the plan names now
    // is what is reported, and the park the reply answers is closed.
    if (isMockedOnTrial(item, undefined)) {
      await runMockedStep(item, parkedAgent, priorRun.action, undefined, undefined, priorRun);
      return;
    }

    // A parked builtin has no agent to resume *as*, and no thread to
    // resume — so the reply re-runs the function instead. Without this the
    // item is stuck for good: the scheduler skips it because it is
    // parked, and this is the only thing that unparks it. Whatever the
    // person changed (assigning a repository, committing the dirty base)
    // is read fresh by the runner. If they changed nothing it parks
    // again — one run per reply, which is a person's pace, not a tick's.
    if (priorRun.agentId === null) {
      // Only while the item is still on the step that parked it. If a
      // person moved it in the meantime, re-running the old step's
      // function would route the item off whatever step it is on now,
      // using a result that step never declared.
      const parkedStep = stepForItem(db, item);
      // A module parks and resumes exactly as a builtin does — it has no
      // agent and no thread either, and the reply re-runs the function.
      // A missing secret is the case this matters for: the person sets it
      // and answers, and the runner reads it fresh (KAN-105).
      if ((parkedStep?.type !== "builtin" && parkedStep?.type !== "module") || parkedStep.entryAction !== priorRun.action) {
        // The item has been moved off the step that parked it — the
        // natural response to a module that cannot run is to route around
        // it. Returning silently left the item dead: `awaitingInput`
        // keeps the scheduler away, and this is the only thing that lifts
        // it, so nothing would ever dispatch on the new step and nothing
        // anywhere said so (invariant #8).
        //
        // Releasing the park is what the reply was asking for. The run is
        // closed as cancelled rather than succeeded: it did not do its
        // work, it was abandoned.
        updateRun(db, priorRun.id, { status: "cancelled", endedAt: now() });
        postComment(db, {
          itemId: item.id,
          runId: priorRun.id,
          author: { type: "engine" },
          kind: "note",
          body: `${runSubject(db, priorRun)} was waiting for you here, but this ticket has moved to another step. That run is closed and this ticket is free to carry on.`,
        });
        announceRun(priorRun.id, item.id, "cancelled");
        return;
      }
      // A sentence rather than one of the answers this step offered
      // (EO-184). The step cannot use it — it would re-run, hand-parse
      // the thread, find nothing and ask the identical question — so it
      // goes to the system agent instead, and the item stays exactly
      // as parked as it was.
      //
      // Not dispatched from here, deliberately. This function holds the
      // item lock, and a model call inside it would serialise the
      // whole board behind one person's reply. `notifyStateChange` is
      // enough: the next tick offers the interpretation as an ordinary
      // run, which claims the item in its own right.
      //
      // This is the single decision point. `postHumanComment` calls
      // `resumeItem` for every reply and the scheduler's recovery pass
      // calls it again, so deciding it anywhere else would be two
      // decisions that can disagree about the same sentence.
      if (pendingInterpretation(db, item, priorRun, readGuards().interpretReplies) !== null) {
        notifyStateChange();
        return;
      }

      // A reply to a watch while EO is offline or has only just woken
      // (EO-457). The check it asks for would fail all the same and
      // count against the watch, so it waits: the park and the reply are
      // left exactly as they are, and the scheduler's recovery pass runs
      // the reply on its first tick after the hold lifts. Said once, to
      // the person who has just written, and never by that recovery pass
      // — it asks on every tick, and a note per tick is noise.
      // `runWatchCheck` refuses as well; this is where the reason is said.
      const hold = parkedStep.watch === null ? null : currentWatchHold();
      if (hold !== null) {
        if (requestedBy !== "scheduler") {
          postComment(db, {
            itemId: item.id,
            runId: priorRun.id,
            author: { type: "engine" },
            kind: "note",
            body:
              hold.reason === "offline"
                ? `"${parkedStep.name}" will start checking again from your reply, but EO is offline, so it waits until the connection is back rather than spend a check that cannot reach anything.`
                : `"${parkedStep.name}" will start checking again from your reply, but the computer has just woken, so it waits until ${new Date(hold.until).toLocaleTimeString()} for the network to come back first.`,
          });
          onItemChanged(item.id);
        }
        return;
      }

      // No step named, deliberately: `createRun` reads the item's
      // current one when a caller does not, and the check above has just
      // established that the item is still on the step that parked.
      // Passing it would say the same thing twice.
      const builtinPromise = runBuiltin(item, priorRun.action, undefined, {
        // This reply already holds the item; asking again would have
        // it refuse itself (EO-132).
        holdingItemLock: true,
        // A reply to a watch that stopped is a person saying "keep
        // watching" (EO-456): its clock starts again, and the check that
        // follows is a run whatever it says, so the park is closed.
        ...(parkedStep.watch === null ? {} : { resumingWatch: true }),
      }).finally(() => inFlight.delete(builtinPromise));
      inFlight.add(builtinPromise);
      await builtinPromise;
      return;
    }

    const agent = getAgent(db, priorRun.agentId);
    if (!agent) return; // referenced rows must exist; defensive, shouldn't happen

    // Archived while its run was parked (EO-186).
    //
    // The case the rest of this story does not reach: the reply is the
    // one thing that starts a parked agent again, and it comes through
    // here rather than through the scheduler or a mention. Left alone it
    // would resume the retired agent's own conversation — the strongest
    // form of the thing archiving means to stop.
    //
    // Asked twice, here and again at the provider boundary below, for
    // the reason the pause is asked twice: `buildContext` is an await,
    // and a person can retire an agent while it runs.
    if (agent.archivedAt !== null) {
      closeParkOfArchivedAgent(item, priorRun, agent);
      return;
    }

    // Moved to another project while its run was parked (EO-474) — the
    // same door, and the same answer, as archived: a reply must not
    // start an agent on an item its project does not reach. Asked again
    // after each await below, and on the fresh-start fallbacks by
    // `dispatchHeld` itself.
    if (!servesProject(agent, item)) {
      closeParkOfOutOfProjectAgent(item, priorRun, agent);
      return;
    }

    if (!isAgentAvailable(agent)) return;

    // A backend switch — or a change to what is attached to this agent
    // (EO-107) — loses the thread but not the work: the fresh run below
    // is seeded from the thread, including the reply that got us here
    // (invariant #4 — that is what makes this recoverable).
    const notResumable = resumeBlockedReason(priorRun, agent);
    if (notResumable) {
      postComment(db, {
        itemId,
        runId: priorRun.id,
        author: { type: "engine" },
        kind: "note",
        body: notResumable,
      });
    }

    // Nor a thread written off (EO-493): a run parked by a guard whose
    // turn's process EO could not confirm gone may still have an agent
    // working in it, and a reply must not start a second one beside it.
    const resumableThreadId =
      isGuardPlaceholder(priorRun) || notResumable || priorRun.threadLost
        ? null
        : priorRun.threadId;
    if (resumableThreadId === null) {
      // Nothing to resume — the attempt-limit guard refused before any
      // thread existed, or the thread cannot carry what the agent now
      // is, or is gone. A human reply is exactly the guard's escape hatch, so it
      // starts a fresh initiation with its own full allowance; a refused
      // resume does the same, and the fresh dispatch is also what
      // generates the directory for the surface it will actually have.
      //
      // The initiation is named after the last thing said that this agent
      // has not already seen — the same delta the resumed prompt below
      // carries, so "which comment re-authorized this" and "what is the
      // agent actually told" cannot answer with different comments.
      const replyInitiationId =
        followUpComments(db, itemId, agent.id, priorRun).at(-1)?.id ?? `reauthorized:${priorRun.id}`;
      const bypassPromise = dispatchRun(item, agent, priorRun.action, {
        initiationId: replyInitiationId,
        holdingItemLock: true, // this reply's own claim, not a second one
      }).finally(() => inFlight.delete(bypassPromise));
      inFlight.add(bypassPromise);
      await bypassPromise;
      return;
    }

    // What the resumed conversation is told: the task line, and the
    // comments this agent has not seen. Through the same seam a dispatch
    // resuming a thread uses (EO-86) rather than a renderer of its own,
    // which is what this was and what it cost — a `createdAt >` with no
    // tie-break, so a reply landing in the same millisecond its run ended
    // was dropped, and no exclusion, so the agent was read its own
    // comments back out of the thread it is resuming. Both are the same
    // waste on this path as on the automatic one, and one builder is the
    // only way they stay fixed in both places.
    //
    // `priorRun` is the run being continued, so it is both the thread and
    // the watermark — the same pairing `dispatchRun` hands the seam.
    const message = await buildContext(db, item, agent, priorRun.action, priorRun);

    // A direct reply can race the Pause IPC just like automatic
    // preflight — and now genuinely does rather than defensively: the
    // message above is built asynchronously (a review turn reads the pull
    // request template off disk), so a pause, a sign-out or a delete can
    // land while it loads. Rechecked here at the provider boundary, and
    // including the item for the reason `dispatchRun` does: a request
    // removed with its conversation must not wake up afterwards, and
    // there is a run row about to be written against it.
    // And the project archived while it loaded (EO-347): the check at
    // the top of this function was made before the await, and resuming
    // a parked conversation writes a run row just below.
    if (heldBack(agent, itemId) || !getItem(db, itemId) || shelved(itemId) || !isAgentAvailable(agent)) return;

    // And archived, which the check above this function's await cannot
    // answer for the time the build took (EO-186). This is the last
    // moment before the parked conversation is resumed, and resuming one
    // is the thing archiving exists to stop — so the row is read again,
    // not the `Agent` this function has been carrying since before the
    // reply was even read.
    //
    // Refused with the same sentence and the same closing of the park as
    // the check before the await: a person who retired an agent a second
    // earlier is owed the same answer as one who retired it a second
    // later.
    const agentNow = getAgent(db, agent.id);
    if (!agentNow) return; // the row went while the context was building; nothing left to resume as
    if (agentNow.archivedAt !== null) {
      closeParkOfArchivedAgent(item, priorRun, agentNow);
      return;
    }
    // And re-scoped while it loaded (EO-474), read back for the same
    // reason — before the fallback below as well as before the resume.
    const itemNow = getItem(db, itemId);
    if (itemNow && !servesProject(agentNow, itemNow)) {
      closeParkOfOutOfProjectAgent(itemNow, priorRun, agentNow);
      return;
    }

    // And the tool surface, for the reason `dispatchRun` re-reads it
    // (EO-107): the message above yielded the event loop, and the check
    // that let this reply resume the thread was made before it. A box
    // ticked in between would otherwise resume the parked conversation
    // against a directory generated from a surface it never had.
    //
    // Asked of the same function as the first check, so the sentence the
    // person reads is the same one either way, and the fresh dispatch it
    // falls back to is the same branch above.
    const nowBlocked = resumeBlockedReason(priorRun, agent);
    if (nowBlocked) {
      postComment(db, {
        itemId,
        runId: priorRun.id,
        author: { type: "engine" },
        kind: "note",
        body: nowBlocked,
      });
      const lateInitiationId =
        followUpComments(db, itemId, agent.id, priorRun).at(-1)?.id ?? `reauthorized:${priorRun.id}`;
      const latePromise = dispatchRun(item, agent, priorRun.action, {
        initiationId: lateInitiationId,
        holdingItemLock: true, // this reply's own claim, not a second one
      }).finally(() => inFlight.delete(latePromise));
      inFlight.add(latePromise);
      await latePromise;
      return;
    }

    const run = createRun(db, {
      itemId,
      agentId: priorRun.agentId,
      action: priorRun.action,
      stepId: priorRun.stepId, // the step the parked run was dispatched from

      status: "queued",
      threadId: priorRun.threadId,
      provider: priorRun.provider,
      runtimeSource: runtimeSource(runsOn(agent, item)),
      // The instructions the *thread* was born with, carried over rather
      // than re-hashed from the agent as it is now (EO-87). A resume
      // sends no instructions — the session keeps the ones it opened
      // with — so hashing the current ones would record something this
      // conversation was never given.
      //
      // Load-bearing, not bookkeeping: this row is now the newest one
      // behind the thread, so it is the row `findReusableThread` weighs
      // up on the next automatic dispatch. Left null it reads as "EO has
      // no record of the instructions", which is never a match, and a
      // reply to a parked run would cost the item its thread — a fresh
      // full-context run with nothing having changed. Null here only
      // when `priorRun` genuinely holds none, which is honest: a row
      // predating EO-87 says nothing about what its thread was told.
      instructionsHash: priorRun.instructionsHash,
      // Carried over rather than re-read for exactly the reason above
      // (EO-106): this run resumes a session, and a resume sends no
      // configuration, so the tools it can reach are the ones the thread
      // was opened with — not the ones somebody has ticked since. Left
      // to default it would read as the empty surface, and the next
      // automatic dispatch would weigh this row up against an agent that
      // has servers attached and refuse a thread that was fine.
      agentAttachmentsHash: priorRun.agentAttachmentsHash,
      // The item's files the thread was told about (EO-703), carried
      // over for the same reason: a reply resumes the thread and tells it
      // nothing about the item, so a file added while it was parked is
      // what the next automatic dispatch refuses the thread over.
      itemFilesHash: priorRun.itemFilesHash,
      initiationId: priorRun.initiationId,
      attempt: priorRun.attempt + 1,
      cwd: priorRun.cwd,
    });
    // The memory this reply's turn is given (EO-478 review): chosen now,
    // against this new run, as a dispatch's is. Memory may have changed
    // while the run was parked, and the reply may be about entries the
    // first turn was not given; the thread's earlier section is neither.
    const replyMemory = memoryBeforeStart(run, item, agentNow, priorRun.action, turnMemoryScopes(item), () => {
      const row = getAgent(db, agent.id);
      const itemRow = getItem(db, itemId);
      return row === undefined || row.archivedAt !== null || (itemRow !== undefined && !servesProject(row, itemRow));
    });
    const memory = replyMemory instanceof Promise ? await replyMemory : replyMemory;
    if (memory === null) return;
    const replyMessage = memory.section === null ? message : `${message}\n\n${memory.section}`;
    updateRun(db, run.id, { status: "running", startedAt: now() });
    // Nobody awaits this resume any more (see postHumanComment), so this
    // announcement is how the UI learns the reply was picked up.
    announceRun(run.id, itemId, "running");

    const replySchema = outputSchemaFor(registryFor(item), priorRun.action, typeOf(item), definingRole(item, agent));
    const controller = new AbortController();
    // Claimed here, before the await below, so a cancel arriving while
    // this dispatch is being prepared is not a no-op (EO-151).
    claimRunControl(run, agent.id, priorRun.action, controller, !isManualAction(priorRun.action));
    // A parked run ended; its conversation did not, and this is what
    // carries on (EO-107). The directory is still there — nothing
    // removes one until the item settles — and this points the newly
    // spawned CLI back at it.
    const replyToolDirectory = prepareToolDirectory(item, agent);
    // And the query server, resolved again rather than remembered
    // (EO-151). A parked run's conversation can wait days for a reply,
    // and the index behind it may have been rebuilt, resynced or lost in
    // between — what the newly spawned CLI is told about is what it
    // starts.
    const replyAttachment = await attachWorkspace(item, agent, workspaceOfRun(item, priorRun));
    // Cancelled while that resolved — see the same check on the
    // reconciliation path. Returning here releases the item lock this
    // runs under, so the reply is not left holding a checkout for a run
    // nobody wants.
    if (controller.signal.aborted) {
      releaseRunControl(run.id);
      return;
    }

    // A close or a pause landed while that resolved (EO-615). No backend
    // has been spoken to, so the item goes back to waiting, on this row
    // since a newer row is what says it waits. It keeps the parked run's
    // `endedAt` so the reply still reads as unanswered: `deferredReplyItemIds`
    // offers it again, and it is read in the thread rather than lost.
    if (heldBack(agent, itemId)) {
      updateRun(db, run.id, { status: "awaiting_input", endedAt: priorRun.endedAt, error: priorRun.error, interruption: "quit" });
      releaseRunControl(run.id);
      announceRun(run.id, itemId, "awaiting_input");
      return;
    }

    // Archived while *that* resolved — the last await before the backend
    // is spoken to, and so the last window this rule has to close
    // (EO-186). Rarer than the one above `createRun`, and handled
    // differently for one reason: the run row exists by now. It never
    // reached a provider, so it is closed as cancelled rather than left
    // running for a reconciliation to find, and the park it was
    // continuing is closed with it — one refusal in the thread for what
    // is one fact, and an item that is free rather than waiting on a
    // conversation that will never be picked up.
    if (getAgent(db, agent.id)?.archivedAt !== null) {
      updateRun(db, run.id, {
        status: "cancelled",
        endedAt: now(),
        error: `${agent.name} was archived before this resume reached the "${agent.provider}" backend, so nothing was started.`,
      });
      releaseRunControl(run.id);
      announceRun(run.id, itemId, "cancelled");
      closeParkOfArchivedAgent(item, priorRun, agent);
      return;
    }
    // Re-scoped while that resolved (EO-474): the same last window, closed
    // the same way — the row never reached a backend.
    const agentAtBoundary = getAgent(db, agent.id);
    const itemAtBoundary = getItem(db, itemId);
    if (agentAtBoundary && itemAtBoundary && !servesProject(agentAtBoundary, itemAtBoundary)) {
      updateRun(db, run.id, {
        status: "cancelled",
        endedAt: now(),
        error: `${agent.name} was moved to another project before this resume reached the "${agent.provider}" backend, so nothing was started.`,
      });
      releaseRunControl(run.id);
      announceRun(run.id, itemId, "cancelled");
      closeParkOfOutOfProjectAgent(itemAtBoundary, priorRun, agentAtBoundary);
      return;
    }

    // The item's files changed while that resolved, or while the memory
    // was chosen (EO-703). `resumeBlockedReason` passed this thread
    // before those awaits, and the resume below tells it nothing about
    // the item. Nothing has been sent: the row is closed without a thread
    // of its own, so the reply stays unanswered, and a fresh dispatch of
    // the same work — under this reply's own claim, with the full
    // context and the reply in it — says why, once.
    if (!itemFilesUnchangedFor(priorRun)) {
      closeForChangedFiles(run, itemId);
      const freshInitiationId = followUpComments(db, itemId, agent.id, priorRun).at(-1)?.id ?? `reauthorized:${priorRun.id}`;
      const freshPromise = dispatchRun(item, agent, priorRun.action, {
        initiationId: freshInitiationId,
        holdingItemLock: true, // this reply's own claim, not a second one
        freshBecause: itemFilesChangedWhilePreparing(agent),
      }).finally(() => inFlight.delete(freshPromise));
      inFlight.add(freshPromise);
      await freshPromise;
      return;
    }

    for (const notice of replyAttachment.notices) {
      postComment(db, {
        itemId,
        runId: run.id,
        author: { type: "engine" },
        kind: "note",
        body: notice,
      });
    }
    const stream = openTurn(item, workspaceOfRun(item, priorRun), () =>
      sendingProvider(run, agent, item, priorRun.action, { purpose: "reply" }).resume(resumableThreadId, replyMessage, {
        ...(priorRun.cwd ? { cwd: priorRun.cwd } : {}),
        ...(replySchema ? { outputSchema: replySchema } : {}),
        ...discussionTurnOptions(item, agent),
        ...(replyToolDirectory ? { toolDirectory: replyToolDirectory.path } : {}),
        ...(replyAttachment.mcpServers[0] ? { repositoryMcp: replyAttachment.mcpServers[0] } : {}),
        ...attachOption(item, run),
        // The parked thread was given memory; its tool stays (EO-478).
        ...memoryOption(item),
        // And where the agent's writes go (EO-543).
        ...writeBridgeOption(item),
        signal: controller.signal,
      }),
    );

    const promise = runToCompletion(
      run,
      item,
      agent,
      priorRun.action,
      stream,
      resumableThreadId,
      controller,
      {
        transitionOnSuccess: !isManualAction(priorRun.action),
        ...(replyToolDirectory ? { toolDirectory: replyToolDirectory.path, toolServerNames: replyToolDirectory.serverNames } : {}),
        attachment: replyAttachment,
      },
    ).finally(() => inFlight.delete(promise));
    inFlight.add(promise);
    await promise;
  }

  return {
    start,
    stop,
    handleAgentWrite,
    device,
    offerWork,
    notifyStateChange,
    prewarmConversation,
    cancelRun,
    steerRun,
    shutdown,
    runOnce,
    watchLiveRuns,
    resumeItem,
    reconcile,
    pause,
    beginClose,
    resume,
    isPaused,
    dispatchBlockerFor,
    activeRunCount,
    finishingRunCount,
    itemLock,
    waitForIdle,
    sideCall: sideCaller.sideCall,
    consolidateMemoryNow(scope) {
      if (stopped || shuttingDown) return { outcome: "refused", reason: "unavailable", message: "EO is stopping, so no consolidation was queued." };
      return memoryConsolidator.requestNow(scope);
    },
    memoryConsolidationPending: (scope) => memoryConsolidator.pending(scope),
  };
}
