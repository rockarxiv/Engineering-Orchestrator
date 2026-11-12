import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArchivedItemListFiltersSchema, ItemListFiltersSchema, toRegistryView, type AgentRemovalImpact, type IpcChannel, type IpcResponse, type Message, type Uuid } from "@eo/core";
import { AttachmentStorage } from "../attachments/storage.js";
import { pipelineHome } from "./pipelineHome.js";
import type { Db } from "../db/client.js";
import { archiveAgentCommand, customiseAgent, deleteAgentCommand, listAgentDetails, projectStaffing, readGuards, saveAgent, setAgentBinding, savePipeline, validatePipelineCommand, writeGuards } from "./configCommands.js";
import { runMemoryFacts } from "../process/runScope.js";
import {
  createPipelineCommand,
  deletePipelineCommand,
  moveStepItemsCommand,
  pipelineVersionsCommand,
  setWebhookUnattendedCommand,
  updatePipelineCommand,
} from "./pipelineCommands.js";
import { deleteRoleActionCommand, inspectRoleActionCommand, saveRoleActionCommand, withActionUses } from "./roleActionCommands.js";
import { createItemTypeCommand, deleteItemTypeCommand, listItemTypesCommand } from "./itemTypeCommands.js";
import {
  approveModuleCommand,
  archiveModuleCommand,
  getModuleVersionCommand,
  listModuleVersionsCommand,
  listModuleViews,
  restoreModuleVersionCommand,
  saveModuleCommand,
} from "./moduleCommands.js";
import { deleteModuleTestCommand, listModuleTestsCommand, runModuleTestsCommand, saveModuleTestCommand } from "./moduleTestCommands.js";
import { createModuleTestRunner } from "../modules/moduleTestRunner.js";
import { clearModuleSecret, listModuleSecrets, revealModuleSecret, setModuleSecret } from "./moduleSecretCommands.js";
import { clearEnvironmentVariable, listEnvironmentVariables, setEnvironmentVariable } from "./environmentVariableCommands.js";
import {
  archiveMcpServerCommand,
  clearMcpServerSecretCommand,
  listMcpServerViews,
  revealMcpServerSecretCommand,
  saveMcpServerCommand,
  setMcpServerEnabledCommand,
  setMcpServerSecretCommand,
} from "./mcpServerCommands.js";
import { archiveSkillCommand, listSkillsCommand, listSkillVersionsCommand, restoreSkillVersionCommand, saveSkillCommand, setSkillEnabledCommand, setSkillLockedCommand } from "./skillCommands.js";
import {
  addMemoryCommand,
  editMemoryCommand,
  getMemoryCommand,
  consolidateNowCommand,
  listConsolidationsCommand,
  listMemoryCommand,
  restoreConsolidationCommand,
  restoreMemoryCommand,
  retireMemoryCommand,
  searchMemoryCommand,
} from "./memoryCommands.js";
import {
  connectConnectorOAuthCommand,
  connectConnectorTokenCommand,
  disconnectConnectorCommand,
  listConnectorsCommand,
} from "./connectorCommands.js";
import {
  attachWorkspaceCommand,
  galleryNeedsCommand,
  listGalleryCommand,
  previewGalleryCommand,
  staffRoleCommand,
  useGalleryCommand,
  openFirstItemChatCommand,
  staffAssistantCommand,
  type GalleryContext,
} from "./galleryCommands.js";
import { loadTemplateHistory, type TemplateHistory } from "../gallery/history.js";
import { finishFirstRunCommand, firstRunStateCommand, markTourSeenCommand, setFirstRunModeCommand, tourStateCommand } from "../firstRun/firstRun.js";
import {
  acceptInvitationCommand,
  deleteGroupCommand,
  invitePersonCommand,
  listDevicesCommand,
  itemAuthorityCommand,
  knowAssignee,
  listPeopleCommand,
  whoAmICommand,
  revokeDeviceCommand,
  saveGroupCommand,
  setAdminCommand,
  setStepOwnerCommand,
  signInCommand as serverSignInCommand,
  type IdentityContext,
} from "./identityCommands.js";
import { forgetOrganisationState } from "../policy/forget.js";
import { policyProtectingCopies, readPolicy } from "../policy/policy.js";
import {
  clearPolicySecretCommand,
  getPolicyCommand,
  savePolicyCommand,
  setPolicySecretCommand,
  type PolicyContext,
} from "./policyCommands.js";
import {
  sessionStatusCommand,
  signInCommand as desktopSignInCommand,
  signOutCommand,
  type SessionContext,
} from "./sessionCommands.js";
import type { ManagedDirectory } from "../managed/directory.js";
import { deviceIdentity, type SessionStoreOptions } from "../managed/session.js";
import { LOCAL_DEVICE_ID } from "../record/device.js";
import { listAgentAttachmentsCommand, setAgentAttachmentCommand } from "./agentAttachmentCommands.js";
import { clearStepSecrets } from "../modules/secrets.js";
import { createItemLock } from "../supervisor/itemLock.js";
import { registryForProject } from "../registry.js";
import { exportPipeline, importPipeline, parseExport, preflightImport } from "../modules/pipelineTransfer.js";
import {
  activeProjectId,
  createRepositoryCommand,
  listRepositoriesCommand,
  removeRepositoryCommand,
  updateRepositoryCommand,
} from "./repositoryCommands.js";
import { createWorkspaceCommand, listWorkspacesCommand, removeWorkspaceCommand, updateWorkspaceCommand } from "./workspaceCommands.js";
import { getDailyCost, getItemCost } from "./costHandlers.js";
import { checkForUpdates, createInstallRequest, downloadUpdate, installUpdate, openReleasePage, updateStatus, type UpdateContext } from "./updateCommands.js";
import { submitPlanCommand } from "./planCommands.js";
import { submitItemCommand } from "./itemCommands.js";
import { exportItemOutput, setItemOutput } from "./outputCommands.js";
import { detectMcpClients, getMcpStatus, registerMcpWith, regenerateMcpToken, setMcpConfig, type McpContext } from "./mcpCommands.js";
import { DEFAULT_PORT } from "../mcpHost/gate.js";
import { repositoryIntelligenceRoot, writeRepositoryIntelligenceConfig } from "../packs/developer/repositoryIntelligence/index.js";
import {
  initializeRepositoryIndexCommand,
  rebuildRepositoryIndexCommand,
  repositoryIntelligenceStatusCommand,
  syncRepositoryIndexCommand,
  type RepositoryIntelligenceContext,
} from "./repositoryIntelligenceCommands.js";
import {
  assignItem,
  cancelRun,
  claimItem,
  takeOverItem,
  decideItemChecked,
  engineStatus,
  holdItem,
  pauseEngine,
  moveItemChecked,
  moveItemToVersion,
  postCommentCommand,
  readSettings,
  resumeEngine,
  resumeHeldItem,
  setArchived,
  setPinned,
  writeSettings,
  type EngineHandle,
} from "./domainCommands.js";
import {
  answerAssistQuestions,
  forkAssistConversation,
  prewarmAssist,
  readEarlierAssist,
  withdrawAssistMessage,
  stopAssistTurn,
  updateAssistSettings,
  applyAssistCardCommand,
  applyAssistModuleChangeCommand,
  readAssistCardCommand,
  approveAssistProposalThroughRecord,
  readAssistProposal,
  clearAssist,
  listAssist,
  newAssist,
  openUpdateConflictAssist,
  openAssist,
  publishNewAssistPipeline,
  approveAndPublishAssistDraft,
  publishTrialCommand,
  readAssistDraftForPublishWithRecord,
  assistDraftPublished,
  publishOnRecord,
  removeAssist,
  removeManyAssist,
  reorderAssist,
  resumeAssist,
  sendToAssist,
} from "./assistCommands.js";
import { runLiveTurn, runSteps } from "./conversationView.js";
import { approveTrialDesign } from "../trials/design.js";
import { answerScenarioQuestions, applyScenarioChangeCommand, clearScenario, openScenario, sendToScenario } from "./scenarioCommands.js";
import {
  createJobCommand,
  deleteJobCommand,
  getJobCommand,
  jobCostCommand,
  jobPlacementCommand,
  listJobsCommand,
  pauseJobCommand,
  resumeJobCommand,
  runJobNowChecked,
  updateJobCommand,
  type JobsContext,
} from "./jobCommands.js";
import { jobEventsCommand, regenerateWebhookSecretCommand, sendTestWebhookEventCommand } from "./jobWebhookCommands.js";
import { askFromCanvas, canvasState, closeCanvas, openInCanvas, popOutCanvas } from "./canvasWindow.js";
import { getDebugMode, listDebugAgents, openDebugWindow, setDebugMode } from "./debugCommands.js";
import { publishView, readCurrentView } from "./currentView.js";
import { attachmentPath, attachmentPreview, deleteAttachmentCommand, pickAttachmentsCommand, saveAttachmentTo } from "./attachmentCommands.js";
import { addItemAttachmentsCommand, removeItemAttachmentCommand, updateItemCommand } from "./itemAttachmentCommands.js";
import { getAttachment } from "../db/repos/index.js";
import { deleteCommentCommand } from "./deleteCommentCommand.js";
import { deleteItemCommand } from "./deleteItemCommand.js";
import { deleteProjectCommand } from "./deleteProjectCommand.js";
import { archiveProjectCommand, restoreProjectCommand } from "./archiveProjectCommand.js";
import { pullItem } from "../packs/developer/jira/pull.js";
import { listRuns, summariseRuns } from "./runAnalysis.js";
import {
  getItemDetail,
  getEarlierItemComments,
  getItemSections,
  listAgentViews,
  listArchivedSummaries,
  listInbox,
  openMentionsCommand,
  listPipelineStepViews,
  listPipelineViews,
  listRunEventsPage,
  listItemSummaries,
  resolveItemKey,
} from "./domainQueries.js";
import type { JiraContext } from "../packs/developer/jira/connection.js";
import { capabilitiesFor, fetchClaudeModels } from "../providers/capabilities.js";
import { fetchCodexModels } from "../providers/codexModels.js";
import { chooseSmallModel, describeSmallModels, smallModelSources } from "../providers/smallModels.js";
import { connectJira, disconnectJira, jiraFields, listJiraConnectionsCommand, removeJiraConnection, saveJiraConnection, jiraOutboxView, jiraStatuses, saveJiraConfig, saveJiraStatusMap, saveJiraTransitionFields, testJira } from "./jiraCommands.js";
import { importJiraIssue, previewJiraIssue, searchJira } from "./jiraImportCommands.js";
import { detectForge } from "./forgeCommands.js";
import { actingCaller, actingReader, scopedProjectId } from "../identity/acting.js";
import { messageRecipientsFor, type MessageHandling } from "../messages/messages.js";
import { emitPush } from "./push.js";
import { recordFor } from "../record/localRecord.js";
import type { ItemRecord } from "../record/record.js";
import { syncStatus } from "../record/syncStatus.js";
import {
  serveAdopt,
  serveApply,
  serveAttachment,
  serveChanges,
  serveRelease,
  serveSpend,
  serveCreateItem,
  serveMemory,
  serveMemoryConsolidations,
  serveChangeDependencies,
  serveUpdateItemType,
  serveHandleMessage,
  serveMessages,
  serveSendMessage,
  serveUpdateConflictChat,
  serveUpdateConflict,
  serveTemplateStatus,
  serveResolveUpdateConflict,
  serveRestoreMemoryConsolidation,
  serveRestoreSkillVersion,
  serveRenew,
  serveWork,
  type ServeRecordContext,
} from "../record/serveRecord.js";
import { listWorktreesCommand, releaseWorktreeCommand } from "./worktreeCommands.js";
import { dispatchIpc, registerHandler } from "./registry.js";
import { sectionLockFor } from "../managed/locks.js";
import { listSectionsCommand, publishPreflightCommand, publishSectionCommand } from "./sectionCommands.js";
import type { Platform } from "./platform.js";
import {
  addRepositoryToProjectCommand,
  createProjectCommand,
  keepProjectLocalCommand,
  listProjectsCommand,
  moveProjectToRecordCommand,
  removeRepositoryFromProjectCommand,
  setActiveProjectCommand,
  undecidedProjectsCommand,
  updateProjectCommand,
  type KeepOrMoveContext,
} from "./projectCommands.js";
import {
  createSuggestionCommand,
  discardEditsCommand,
  divergenceCommand,
  suggestChangeCommand,
  suggestionDetailCommand,
  type SuggestionContext,
} from "./suggestionCommands.js";
import { runtimeRoot } from "../runtimes/install.js";
import { CLAUDE_SDK, resolvePackageSet } from "../runtimes/packages.js";
import { loadClaudeSdk } from "../providers/claudeSdk.js";
import {
  backendAuthKinds,
  backendLabel,
  cancelRuntimeSignIn,
  removeRuntimeApiKey,
  signInWithRuntimeApiKey,
  describeRuntime,
  installRuntimeCommand,
  removeManagedRuntime,
  runtimeStatus,
  runtimeStatusWithAuth,
  signedInBackends,
  setRuntimeAutomaticUpdates,
  setRuntimeEnabled,
  startRuntimeSignIn,
  submitRuntimeSignInCode,
  type RuntimeContext,
} from "./runtimeCommands.js";

/**
 * `engine` is optional so the app still starts — and the read-only
 * screens still work — if the engine failed to come up. A UI that goes
 * blank because the scheduler is unhappy would hide the very thing you
 * need to look at.
 */
/** Tells the other windows a project changed. Returns its argument so it can wrap a command inline. */
/** A pipeline change alters the sidebar and every column that renders it. */
function announcePipeline<T>(result: T): T {
  emitPush("config:changed", {});
  return result;
}

/**
 * The runs a confirmed agent removal cancelled (EO-350), said to every
 * window. The engine announces the ones it was driving itself; saying
 * it again for those costs a refetch, and a run nothing was driving has
 * nobody else to announce it.
 */
function announceCancelledRuns(impact: AgentRemovalImpact | null): void {
  if (impact === null || impact.activeRuns.length === 0) return;
  for (const run of impact.activeRuns) emitPush("runs:changed", { runId: run.runId, itemId: run.itemId, status: "cancelled" });
  // Each item once, by name (EO-557), so a window can tell whether it is one it is showing.
  for (const itemId of new Set(impact.activeRuns.map((run) => run.itemId))) emitPush("items:changed", { itemId });
}

function announce<T extends { ok: boolean }>(result: T): T {
  if (result.ok) emitPush("config:changed", {});
  return result;
}

export interface HandlerResources {
  /**
   * EO's MCP server for external clients, when this build has one.
   *
   * Optional for the same reason `engine` is: the screens that do not
   * need it still work. A build without it registers the channels anyway
   * and answers "not available", rather than leaving three channels the
   * renderer calls and nothing answers.
   */
  mcp?: McpContext;
  /**
   * Where `moduleHost.mjs` lives (KAN-106).
   *
   * Passed in rather than resolved here: `resolveResourcePaths` is
   * called once, at startup, and a second call in this file would be a
   * second place for the packaged/unpackaged split to be got wrong.
   * Omitting it leaves a module's tests answering that the host is not
   * available rather than failing to register — the screens that do not
   * need it still work.
   */
  moduleHostPath?: string;
  /**
   * The update controller and the way out of the process (EO-201).
   *
   * Optional for the same reason `mcp` is: a build without one — or a
   * test that has no Electron to load electron-updater into — still
   * registers the channels and answers "there is nothing to update
   * here", rather than leaving four channels the renderer calls and
   * nothing answers.
   */
  updates?: UpdateContext;
  /**
   * Where the gallery's bundled templates are — `ResourcePaths.gallery`
   * (EO-316).
   *
   * Passed in for `moduleHostPath`'s reason: the packaged/unpackaged
   * split is resolved once at startup and must not be re-decided here.
   * Absent shows an empty gallery rather than failing to register — a
   * build that shipped no templates has nothing to offer, and saying so
   * is a screen state rather than an error.
   */
  galleryDirectory?: string;
  /**
   * What the machine provides (KAN-127): dialogs, the OS viewer, the
   * keychain, where state lives. The one thing here that is not
   * optional, because nothing below can be registered without knowing
   * where `userData` is — and because the point of the seam is that this
   * file never asks Electron itself. index.ts passes the Electron
   * implementation; a test passes a fake and registers every channel
   * under plain Node.
   */
  platform: Platform;
  /**
   * How this installation reaches its organisation, when it has one
   * (EO-323).
   *
   * Optional for `mcp`'s reason and one of its own: a server *is* the
   * record and has nobody to ask, so it passes none and `people:list`
   * answers from its own tables — which is the same code path.
   */
  managed?: ManagedDirectory;
  /**
   * Where this machine's own sign-in lives: the settings that say what
   * it is signed in to, and the keychain the device token is kept in
   * (EO-323).
   *
   * Absent leaves `session:*` registered and answering "signed out",
   * which is the truth on a build that has nowhere to keep a token. A
   * channel that exists and refuses is what invariant #12 asks for over
   * a channel the renderer calls and nothing answers.
   */
  session?: SessionStoreOptions;
  /**
   * The device record, where the composition root has one (EO-471).
   *
   * Only for what has to be *asked* of whichever record owns a project —
   * a project's memory (EO-482) and what its items wait for
   * (EO-600) — since a moved
   * project's are the organisation's. Absent in a test and on a server, where this database is
   * the record and `recordFor(db)` is the answer.
   */
  record?: Pick<
    ItemRecord,
    | "updateConflictChat"
    | "updateConflict"
    | "resolveUpdateConflict"
    | "templateStatus"
    | "writeMemory"
    | "memoryConsolidations"
    | "restoreMemoryConsolidation"
    | "restoreSkillVersion"
    | "changeDependencies"
    | "updateItemType"
    | "handleMessage"
  >;
}

/**
 * What `session:*` answers on a process with nowhere to keep a device
 * token (EO-323).
 *
 * A server, and a test that built its handlers without a session store.
 * Registered and answering rather than absent, because a channel the
 * renderer calls and nothing answers is the failure invariant #12 is
 * about — a control that does nothing is worse than one that says why.
 */
const SIGNED_OUT = { state: "signed-out" } as const;
const NO_KEYCHAIN_HERE = "This EO process has nowhere to keep a device token, so it cannot sign in to an organisation server.";

/**
 * Which project a board read is about, for whoever is asking (EO-326).
 *
 * The argument if there is one, this installation's own choice if there
 * is not, and then narrowed to what the caller may see — which changes
 * nothing on a desktop and nothing for an admin. Written once here
 * because the three reads that ask it have to agree: a board, an archive
 * and an inbox showing different projects to the same person would be
 * three answers to "where am I".
 */
function boardProjectId(db: Db, payload: { projectId?: string | null | undefined; actingDeviceId?: string | null | undefined }): string | null {
  return scopedProjectId(db, actingCaller(db, payload.actingDeviceId), payload.projectId ?? activeProjectId(db));
}

export function registerAllHandlers(db: Db, engine: EngineHandle | undefined, resources: HandlerResources): void {
  const { platform } = resources;
  /** Whichever record holds a pipeline's template update (EO-534): read when asked, since `resources.record` is fixed but a sign-in is not. */
  const conflictRecord = (): Pick<ItemRecord, "updateConflict" | "resolveUpdateConflict" | "templateStatus"> => resources.record ?? recordFor(db);
  /**
   * The template history this build ships (EO-536), read once and on
   * first use: a pipeline's header reads titles and release notes from
   * it, and nothing else on this side does.
   */
  let shippedHistory: TemplateHistory | undefined;
  const templateHistory = (): TemplateHistory => (shippedHistory ??= loadTemplateHistory(resources.galleryDirectory ?? ""));
  // The engine's per-item lock (EO-132), so that an IPC path which
  // starts a process in an item's worktree is excluded from the agent
  // that might be working in it. Without an engine there are no runs for
  // anything to collide with, and a private lock nobody else can hold is
  // the honest stand-in — it still serialises this process's own dry
  // runs against each other.
  const itemLock = engine?.itemLock ?? createItemLock();
  const exposeErrorDetails = !platform.isPackaged;
  /**
   * Every door, one lock (EO-329, ARCHITECTURE.md, "Publish, lock and versions").
   *
   * Handed to `registerHandler` rather than written into the eighteen
   * commands that write a published section, because the renderer's
   * `ipcMain.handle`, the MCP host's `dispatchIpc` and a server's HTTP
   * door all arrive through `handleIpcRequest` — and a lock that one of
   * them did not know about is what the design is about. See
   * `managed/locks.ts` for why it is asked per call rather than read
   * once.
   */
  const opts = { exposeErrorDetails, sectionLock: (channel: IpcChannel, payload: unknown) => sectionLockFor(db, channel, payload) };
  const attachmentStorage = new AttachmentStorage(join(platform.userDataPath, "attachments"));

  // The Jira token's home: encrypted by the OS keychain, written under
  // userData, never in the database (J-01, ARCHITECTURE.md, "Secrets"). The keychain
  // is the platform's — safeStorage is imported in exactly one place,
  // platform/electron.ts, and this file never sees it.
  const jira: JiraContext = { credentials: { directory: join(platform.userDataPath, "credentials"), store: platform.keychain } };

  // A module's declared secrets, in the same keychain and under the same
  // rule (KAN-105). Its own directory rather than sharing `credentials`,
  // so clearing one kind cannot disturb the other.
  const moduleSecrets = { directory: join(platform.userDataPath, "module-secrets"), store: platform.keychain };

  // A catalogued MCP server's declared values (EO-104). Its own
  // directory again, for the same reason: clearing one kind of secret
  // must not be able to disturb another.
  const mcpServerSecrets = { directory: join(platform.userDataPath, "mcp-server-secrets"), store: platform.keychain };

  /**
   * Whether this process *is* the record (EO-328, review).
   *
   * The same question `policyCommands` asks and the same way of asking
   * it: a managed desktop has a client to forward to, and a server and a
   * solo desktop have nobody. Asked per call rather than once, because a
   * person signs in and out without relaunching — and a handler that had
   * captured the answer at startup would go on protecting rows that
   * stopped being copies, or stop protecting rows that started being
   * them.
   */
  const isTheRecord = (): boolean => (resources.managed?.client() ?? null) === null;

  // The organisation's own (EO-328, ARCHITECTURE.md, "Secrets"). Its own directory for the two
  // reasons above and one more: signing out of an organisation forgets
  // all of these and none of the person's, which is a `rm -r` of a
  // directory rather than a list of names somebody has to keep current.
  const organisationSecrets = { directory: join(platform.userDataPath, "organisation-secrets"), store: platform.keychain };

  // A-08. The root is computed in one place and imported, so this
  // screen cannot come to disagree with the engine about what is
  // installed.
  const runtimes: RuntimeContext = {
    root: runtimeRoot(platform.userDataPath),
    fetchImpl: (url, init) => fetch(url, init),
    db,
    onChanged: () => emitPush("config:changed", {}),
    // EO-83: a sign-in opens the CLI's own OAuth URL in the person's
    // real browser. The platform's browser, not Electron's directly —
    // `runtimes/signIn.ts` must stay importable under plain Node, and
    // so, now, must this file.
    openExternal: (url) => platform.openExternal(url),
    // EO-84: a Claude key typed into EO, beside the Jira tokens and
    // under the same keychain. The only place EO holds a billable
    // secret — Codex's goes to its own CLI and is never written here.
    apiKeys: { directory: join(platform.userDataPath, "credentials"), store: platform.keychain },
  };

  registerHandler("app:getVersion", () => ({ version: platform.version }), opts);

  // EO-201. Four channels rather than one, so a download that fails
  // cannot go on to restart the app. `updates:install` reaches the
  // shutdown coordinator and never `quitAndInstall` — see
  // updateCommands.ts.
  const updates: UpdateContext = resources.updates ?? { controller: () => undefined, requestClose: () => false, installRequest: createInstallRequest() };
  registerHandler("updates:status", () => updateStatus(updates), opts);
  registerHandler("updates:check", () => checkForUpdates(updates), opts);
  registerHandler("updates:download", () => downloadUpdate(updates), opts);
  registerHandler("updates:install", () => installUpdate(updates), opts);
  // EO-698: macOS sends the person to the release page. Nothing crosses
  // from the renderer — the address is built here, not handed over.
  registerHandler("updates:openReleasePage", () => openReleasePage(updates, (url) => platform.openExternal(url)), opts);
  registerHandler(
    "dialog:pickDirectory",
    async (payload) => ({ path: await platform.pickDirectory({ title: payload.title ?? "Choose a folder" }) }),
    opts,
  );
  registerHandler("costs:getForItem", (payload) => getItemCost(db, payload), opts);
  registerHandler("costs:getDaily", (payload) => getDailyCost(db, payload), opts);

  // Scoped to the repository the window is showing (U-07). The engine is
  // unaffected: it advances every repository regardless.
  // The filters are the payload's own fields (EO-539), picked out by the
  // schema that declared them rather than by deleting the two that are not.
  registerHandler("items:list", (payload) => listItemSummaries(db, boardProjectId(db, payload) as Uuid | null, ItemListFiltersSchema.parse(payload)), opts);
  registerHandler("items:get", (payload) => getItemDetail(db, payload), opts);
  registerHandler("items:earlierComments", (payload) => getEarlierItemComments(db, payload), opts);
  registerHandler("items:getSections", (payload) => getItemSections(db, payload), opts);
  registerHandler("items:resolveKey", (payload) => resolveItemKey(db, payload), opts);
  // Runs across items, for timing and spend (EO-541). Read-only.
  registerHandler("runs:list", (payload) => listRuns(db, payload), opts);
  registerHandler("runs:summary", (payload) => summariseRuns(db, payload), opts);
  registerHandler("runs:listEvents", (payload) => listRunEventsPage(db, payload), opts);
  // One run's steps, as a chat draws a finished turn's fold.
  registerHandler("runs:steps", (payload) => ({ steps: runSteps(db, payload.runId) }), opts);
  registerHandler("runs:live", (payload) => ({ turn: runLiveTurn(db, payload.runId) }), opts);
  registerHandler(
    "inbox:list",
    (payload) =>
      listInbox(db, boardProjectId(db, payload) as Uuid | null, actingReader(db, payload.actingDeviceId), messageRecipientsFor(db, payload.actingDeviceId)),
    opts,
  );
  // EO's messages to a person outside any item (EO-725): answered with one
  // of their options or dismissed, by their recipient only. Each pushes
  // `messages:changed` itself.
  // On whichever installation holds the message (EO-726): the
  // organisation's record for one about a project it holds, so the
  // recipient's other desktops hear of it.
  const handleMessage = async (request: MessageHandling): Promise<{ message: Message }> => {
    const handled = await (resources.record ?? recordFor(db)).handleMessage(request);
    if (!handled.ok) throw new Error(handled.problem);
    return { message: handled.message };
  };
  registerHandler(
    "messages:answer",
    (payload) => handleMessage({ messageId: payload.messageId, how: "answered", answer: payload.answer, actingDeviceId: payload.actingDeviceId }),
    opts,
  );
  registerHandler("messages:dismiss", (payload) => handleMessage({ messageId: payload.messageId, how: "dismissed", answer: null, actingDeviceId: payload.actingDeviceId }), opts);
  registerHandler("mentions:open", (payload) => openMentionsCommand(db, payload), opts);
  registerHandler("agents:list", () => listAgentViews(db), opts);
  registerHandler("pipelineSteps:list", (payload) => listPipelineStepViews(db, payload), opts);
  registerHandler("pipelines:list", (payload) => listPipelineViews(db, payload), opts);
  registerHandler("pipelines:create", (payload) => announcePipeline(createPipelineCommand(db, payload)), opts);
  registerHandler("pipelines:update", (payload) => announcePipeline(updatePipelineCommand(db, payload)), opts);
  registerHandler("pipelines:delete", (payload) => announcePipeline(deletePipelineCommand(db, payload)), opts);
  // Whether a webhook pipeline may send unread (EO-405). Announced like
  // the edits beside it: the editor's control, the problems under it and
  // the board's header all read what this changes.
  registerHandler("pipelines:setWebhookUnattended", (payload) => announcePipeline(setWebhookUnattendedCommand(db, payload)), opts);
  // What a pipeline's versions are, and what changed between two of them
  // (EO-327). A read: no push, nothing announced.
  registerHandler("pipeline:versions", (payload) => pipelineVersionsCommand(db, payload), opts);
  // A held template update, read whole for the assistant (EO-534). A
  // read: nothing pushed.
  // Asked of the record that holds it: this database for a pipeline of
  // its own, the organisation's for one it holds.
  registerHandler("pipeline:updateConflict", (payload) => conflictRecord().updateConflict({ pipelineId: payload.pipelineId, onTheRecord: !platform.hasMachine }), opts);
  // Where a pipeline came from and whether its template has news for it
  // (EO-536): the head of its board and Graph view. A read, asked of the
  // record that holds its updates, for the reason the line above is.
  registerHandler(
    "pipeline:templateStatus",
    (payload) => conflictRecord().templateStatus({ pipelineId: payload.pipelineId, onTheRecord: !platform.hasMachine, history: templateHistory() }),
    opts,
  );
  // Keep my pipeline and skip this update (EO-534): resolves the held
  // update and moves the base, the graph untouched — on the record that
  // holds it. Pushed, because the notice it closes is in every window's
  // inbox.
  registerHandler(
    "pipeline:keepOwnVersion",
    async (payload) => {
      const kept = await conflictRecord().resolveUpdateConflict({
        pipelineId: payload.pipelineId,
        resolution: "kept",
        chatId: null,
        graph: null,
        templateStepIds: {},
        onTheRecord: !platform.hasMachine,
        createdBy: null,
      });
      if (kept.resolved) emitPush("items:changed", {});
      return { kept: kept.resolved, toVersion: kept.toVersion, problem: kept.resolved ? null : kept.problem };
    },
    opts,
  );
  /**
   * A pipeline this machine edited out from under its organisation, and
   * what somebody does about it (EO-331, ARCHITECTURE.md, "Divergence and suggestions").
   *
   * The read draws the line and the chip; the two writes are the design's
   * *Suggest my change* and *Discard my edits*, which are also the two
   * the lock itself offers and the two the assistant performs when a
   * person says yes to its offer. `config:changed` on both, because
   * what changed is which state the configuration screen is in.
   *
   * `suggestionContext` is built per call for `galleryContext`'s
   * reason: whether this machine has an organisation to suggest to is
   * something a person changes without relaunching.
   */
  const suggestionContext = async (): Promise<SuggestionContext> => ({
    ...(resources.managed === undefined ? {} : { managed: resources.managed }),
    moduleSecrets,
    signedInBackends: await signedInBackends(runtimes),
  });
  registerHandler("pipelines:divergence", (payload) => divergenceCommand(db, payload), opts);
  registerHandler("pipelines:suggest", async (payload) => announcePipeline(await suggestChangeCommand(db, await suggestionContext(), payload)), opts);
  registerHandler("pipelines:discardEdits", (payload) => announcePipeline(discardEditsCommand(db, payload)), opts);
  // The record's half: the document a desktop sends, and the screen an
  // admin reviews it on. A suggestion is an item, so the board hears
  // about it the way it hears about any other new one.
  registerHandler(
    "suggestions:create",
    (payload) => {
      const result = createSuggestionCommand(db, payload);
      if (result.itemId !== null) emitPush("items:changed", { itemId: result.itemId });
      return result;
    },
    opts,
  );
  registerHandler("suggestions:detail", async (payload) => suggestionDetailCommand(db, await suggestionContext(), payload), opts);

  // Moving what a step holds so the step can go (EO-327, ARCHITECTURE.md, "Publish, lock and
  // versions").
  // `items:changed` rather than `config:changed`: nothing about the
  // configuration moved, several cards did.
  registerHandler(
    "pipeline:moveStepItems",
    (payload) => {
      const result = moveStepItemsCommand(db, payload);
      if (result.moved > 0) emitPush("items:changed", {});
      return result;
    },
    opts,
  );

  // The module catalog (KAN-103). `config:changed` on a write because a
  // saved module changes what the pipeline configuration screen can offer
  // in its Type selector, not only what Settings lists.
  // A module's tests (EO-352). One runner for the process: it keeps
  // every module's stored result about what is saved now, one run at a
  // time, and a person's "run them" waits in the same queue. In test
  // mode the host spawns nothing and opens no database, so it is given
  // neither a PATH nor `dbPath`.
  const moduleTests = createModuleTestRunner({
    db,
    launcher: resources.moduleHostPath === undefined ? null : { execPath: process.execPath, hostPath: resources.moduleHostPath, hostEnv: { ELECTRON_RUN_AS_NODE: "1" } },
    onStored: () => emitPush("config:changed", {}),
  });
  registerHandler("modules:list", (payload) => listModuleViews(db, payload), opts);
  registerHandler(
    "modules:save",
    (payload) => {
      const result = saveModuleCommand(db, payload);
      // Changed code makes the stored result stale; the runner skips a
      // save that changed nothing it was taken against, like a rename.
      if (result.module !== null) moduleTests.schedule(result.module.id);
      return announcePipeline(result);
    },
    opts,
  );
  registerHandler("moduleTests:list", (payload) => listModuleTestsCommand(db, payload), opts);
  registerHandler("moduleTests:save", (payload) => announcePipeline(saveModuleTestCommand(db, moduleTests, payload)), opts);
  registerHandler("moduleTests:delete", (payload) => announcePipeline(deleteModuleTestCommand(db, moduleTests, payload)), opts);
  registerHandler("moduleTests:run", async (payload) => runModuleTestsCommand(moduleTests, payload), opts);
  // Approving runs the module's tests at that moment (EO-353), in the
  // same queue as every other run of them.
  registerHandler("modules:approve", async (payload) => announcePipeline(await approveModuleCommand(db, moduleTests, payload)), opts);
  registerHandler("modules:archive", (payload) => announcePipeline(archiveModuleCommand(db, payload)), opts);
  // A module's history (EO-360). A restore is a save: it changes the
  // code and the cases, so the tests re-run in the background after it —
  // always, which `restoreModuleVersionCommand` sees to.
  registerHandler("moduleVersions:list", (payload) => listModuleVersionsCommand(db, payload), opts);
  registerHandler("moduleVersions:get", (payload) => getModuleVersionCommand(db, payload), opts);
  registerHandler("moduleVersions:restore", (payload) => announcePipeline(restoreModuleVersionCommand(db, moduleTests, payload)), opts);

  // Moving a pipeline between machines (KAN-108). The file dialogs live
  // here because a renderer has no filesystem access by design (F-02).
  registerHandler(
    "pipelines:export",
    async (payload) => {
      const built = exportPipeline(db, payload.pipelineId);
      if (!built.ok) return { written: false, path: null, document: null, problem: built.reason };

      const serialised = JSON.stringify(built.document, null, 2);
      // A caller with no window: it gets the document itself and never
      // meets a dialog it could not have answered.
      if (payload.destination === "document") return { written: false, path: null, document: serialised, problem: null };

      const chosen = await platform.saveFile({
        title: "Export pipeline",
        defaultPath: `${built.document.pipeline.name.replace(/[^A-Za-z0-9-_ ]/g, "")}.eo-pipeline.json`,
        filters: [{ name: "EO pipeline", extensions: ["json"] }],
      });
      if (chosen === null) return { written: false, path: null, document: null, problem: null };

      writeFileSync(chosen, serialised);
      return { written: true, path: chosen, document: null, problem: null };
    },
    opts,
  );
  registerHandler(
    "pipelines:importPreflight",
    async (payload) => {
      // What the document's recommendations are measured against, and
      // which project its types and connectors would land in (EO-314).
      // Resolved here rather than in `pipelineTransfer`, which reads a
      // database and a PATH and has no business spawning a CLI to ask a
      // provider whether anybody is signed in.
      // Where the caller says it would land, when it says (EO-521) — the
      // same answer `pipelines:import` resolves from the same field.
      // A pipeline belongs to a project (EO-766): with none to land in,
      // said before the person is asked for a file.
      const home = pipelineHome(db, importDestination(db, payload.into));
      if (!home.ok) return { preflight: null, document: null, problem: home.problem };
      const against = { signedInBackends: await signedInBackends(runtimes), projectId: home.projectId };

      // A caller that already has the document skips the picker — which
      // is the only part of this it could not have answered.
      if (payload.document !== undefined) {
        const given = parseExport(payload.document);
        if (!given.ok) return { preflight: null, document: null, problem: given.reason };
        return { preflight: preflightImport(db, moduleSecrets, given.document, against), document: payload.document, problem: null };
      }

      const [path] = await platform.pickFile({ title: "Import pipeline", filters: [{ name: "EO pipeline", extensions: ["json"] }] });
      if (path === undefined) return { preflight: null, document: null, problem: null };

      const text = readFileSync(path, "utf8");
      const parsed = parseExport(text);
      if (!parsed.ok) return { preflight: null, document: null, problem: parsed.reason };

      return { preflight: preflightImport(db, moduleSecrets, parsed.document, against), document: text, problem: null };
    },
    opts,
  );
  registerHandler(
    "pipelines:import",
    async (payload) => {
      const parsed = parseExport(payload.document);
      if (!parsed.ok) return { imported: false, pipelineId: null, unapprovedModules: [], keptDefinitions: [], problem: parsed.reason };

      // Always onto a project (EO-766): the one named, otherwise the
      // one the window is on, and refused with nothing written where
      // there is none.
      const home = pipelineHome(db, payload.into !== undefined ? importDestination(db, payload.into) : ((payload.projectId as Uuid | null) ?? activeProjectId(db)));
      if (!home.ok) return { imported: false, pipelineId: null, unapprovedModules: [], keptDefinitions: [], problem: home.problem };
      const result = importPipeline(db, {
        document: parsed.document,
        choices: payload.choices,
        projectId: home.projectId,
        // Asked again rather than carried from the preflight: the person
        // may have signed in on the strength of the line that said they
        // had not, which is exactly what the needs check is for.
        signedInBackends: await signedInBackends(runtimes),
      });
      if (!result.ok) return { imported: false, pipelineId: null, unapprovedModules: [], keptDefinitions: [], problem: result.reason };

      // The cases the modules arrived with, run here (EO-355): their
      // result did not travel, and until a run lands the module page and
      // every step running one says coverage is not measured.
      for (const moduleId of result.createdModuleIds) moduleTests.schedule(moduleId);
      emitPush("config:changed", {});
      return { imported: true, pipelineId: result.pipelineId, unapprovedModules: result.unapprovedModules, keptDefinitions: result.keptDefinitions, problem: null };
    },
    opts,
  );

  // The MCP server catalogue (EO-104). `config:changed` on a write for
  // the reason the module catalogue emits it: what a saved server changes
  // is what the configuration screens can offer, not only what Settings
  // lists. Nothing here reaches an agent — attachment is EO-106.
  registerHandler(
    "mcpServers:list",
    (payload) => listMcpServerViews(db, mcpServerSecrets, payload, { secrets: organisationSecrets, policy: readPolicy(db) }, moduleSecrets),
    opts,
  );
  registerHandler(
    "mcpServers:save",
    (payload) => announcePipeline(saveMcpServerCommand(db, mcpServerSecrets, payload, policyProtectingCopies(db, isTheRecord()))),
    opts,
  );
  registerHandler("mcpServers:setEnabled", (payload) => announcePipeline(setMcpServerEnabledCommand(db, mcpServerSecrets, payload)), opts);
  registerHandler("mcpServers:archive", (payload) => announcePipeline(archiveMcpServerCommand(db, payload, policyProtectingCopies(db, isTheRecord()))), opts);
  // Values in, names out. Not announced: a secret changes nothing any
  // other window is showing, and a push saying one moved is a push
  // saying more than it should.
  registerHandler("mcpServers:setSecret", (payload) => setMcpServerSecretCommand(db, mcpServerSecrets, payload), opts);
  registerHandler("mcpServers:clearSecret", (payload) => clearMcpServerSecretCommand(db, mcpServerSecrets, payload), opts);
  // The one way a value comes back out (EO-489, ARCHITECTURE.md §14.2):
  // the machine half, for the person pressing Reveal at this desktop. A
  // server refuses it at the door, and no eo_admin tool is built on it.
  registerHandler("mcpServers:revealSecret", (payload) => revealMcpServerSecretCommand(db, mcpServerSecrets, payload), opts);

  // Connectors: the same servers, with words around them and a way in
  // (EO-315). The store is `mcpServerSecrets` and no other — a connector
  // is a server, so its values belong in the directory a server's values
  // have always been in, and a second one would be a second place to
  // look for the token a dispatch reads.
  registerHandler("connectors:list", (payload) => listConnectorsCommand(db, mcpServerSecrets, payload), opts);
  // Announced, unlike `mcpServers:setSecret`: connecting changes what
  // every reach list and every needs check on every window is showing —
  // a red line goes green. What is announced is that configuration
  // changed, which is exactly as much as the other windows are told
  // about any other write.
  registerHandler("connectors:connectToken", (payload) => announcePipeline(connectConnectorTokenCommand(db, mcpServerSecrets, payload)), opts);
  registerHandler(
    "connectors:connectOAuth",
    async (payload) =>
      announcePipeline(
        await connectConnectorOAuthCommand(db, mcpServerSecrets, payload, { openExternal: (url) => platform.openExternal(url) }),
      ),
    opts,
  );
  registerHandler("connectors:disconnect", (payload) => announcePipeline(disconnectConnectorCommand(db, mcpServerSecrets, payload)), opts);

  // The skill catalogue (EO-105). `config:changed` on a write for the
  // reason the other two catalogues emit it: what a saved skill changes
  // is what the configuration screens can offer, not only what Settings
  // lists. Nothing here reaches an agent — attachment is EO-106.
  registerHandler("skills:list", (payload) => listSkillsCommand(db, payload), opts);
  registerHandler("skills:save", (payload) => announcePipeline(saveSkillCommand(db, payload)), opts);
  registerHandler("skills:setEnabled", (payload) => announcePipeline(setSkillEnabledCommand(db, payload)), opts);
  registerHandler("skills:archive", (payload) => announcePipeline(archiveSkillCommand(db, payload)), opts);
  registerHandler("skills:setLocked", (payload) => announcePipeline(setSkillLockedCommand(db, payload)), opts);
  registerHandler("skills:versions", (payload) => listSkillVersionsCommand(db, payload), opts);
  // On the record for a skill it holds (EO-728), and here for any other.
  registerHandler("skills:restoreVersion", async (payload) => announcePipeline(await restoreSkillVersionCommand(db, payload, resources.record ?? recordFor(db))), opts);
  // EO-478: a scope's memory, read and written by a person. Every write
  // keeps the row it replaces; nothing here deletes.
  registerHandler("memory:list", (payload) => listMemoryCommand(db, payload), opts);
  // Every write goes to the record that holds the scope's project
  // (EO-482): the organisation's, for a project somebody moved there.
  const memoryRecord = resources.record ?? recordFor(db);
  registerHandler("memory:add", (payload) => addMemoryCommand(memoryRecord, payload), opts);
  registerHandler("memory:edit", (payload) => editMemoryCommand(memoryRecord, payload), opts);
  registerHandler("memory:retire", (payload) => retireMemoryCommand(memoryRecord, payload), opts);
  registerHandler("memory:restore", (payload) => restoreMemoryCommand(memoryRecord, payload), opts);
  // EO-545: every scope's entries, searched, and one entry with its
  // history — `memories_search` and `memory_get`. Read-only.
  registerHandler("memory:search", (payload) => searchMemoryCommand(db, payload), opts);
  registerHandler("memory:get", (payload) => getMemoryCommand(db, memoryRecord, payload), opts);
  // EO-480: the consolidations EO made on its own, and undoing one.
  registerHandler("memory:consolidations", (payload) => listConsolidationsCommand(memoryRecord, payload, engine), opts);
  // EO-589: a person asking for one now, skipping the due rule and the
  // backoff. The supervisor owns the consolidator.
  registerHandler("memory:consolidateNow", (payload) => consolidateNowCommand(engine, payload), opts);
  registerHandler("memory:restoreConsolidation", (payload) => restoreConsolidationCommand(db, memoryRecord, payload), opts);

  // Which agent gets what, out of those two catalogues (EO-106). The
  // first write in this feature that changes a dispatch rather than a
  // list: the tick lands here, and it takes effect on the next dispatch
  // because `providerCacheKey` keys the cached provider on a fingerprint
  // of what is attached and `findReusableThread` refuses a thread born
  // under a different one. `config:changed` for the reason the
  // catalogues emit it — an open Agents screen is showing this.
  registerHandler("agentAttachments:list", (payload) => listAgentAttachmentsCommand(db, payload), opts);
  registerHandler("agentAttachments:set", (payload) => announcePipeline(setAgentAttachmentCommand(db, payload)), opts);

  registerHandler("moduleSecrets:list", (payload) => listModuleSecrets(db, moduleSecrets, payload, organisationSecrets), opts);
  registerHandler("moduleSecrets:set", (payload) => setModuleSecret(db, moduleSecrets, payload), opts);
  registerHandler("moduleSecrets:clear", (payload) => clearModuleSecret(db, moduleSecrets, payload), opts);
  // Machine half (EO-489): the personal value of one scope, on request at this desktop.
  registerHandler("moduleSecrets:reveal", (payload) => revealModuleSecret(db, moduleSecrets, payload), opts);
  // Environment variables (EO-485): values that are not secret, in the
  // same scope directories as the module secrets' references, so a
  // step's removal below takes its variables with it.
  registerHandler("environmentVariables:list", (payload) => listEnvironmentVariables(db, moduleSecrets, payload), opts);
  registerHandler("environmentVariables:set", (payload) => setEnvironmentVariable(db, moduleSecrets, payload), opts);
  registerHandler("environmentVariables:clear", (payload) => clearEnvironmentVariable(db, moduleSecrets, payload), opts);

  registerHandler(
    "attachments:pick",
    () =>
      pickAttachmentsCommand(
        () =>
          platform.pickFile({
            title: "Attach files",
            multiple: true,
            filters: [
              { name: "Images and documents", extensions: ["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "md", "json", "csv", "log"] },
              { name: "All files", extensions: ["*"] },
            ],
          }),
        attachmentStorage,
      ),
    opts,
  );
  registerHandler("attachments:stage", (payload) => attachmentStorage.stageData(payload).then((attachment) => ({ attachment })), opts);
  registerHandler("attachments:discard", (payload) => attachmentStorage.discard(payload.attachmentId).then((discarded) => ({ discarded })), opts);
  registerHandler("attachments:preview", (payload) => attachmentPreview(db, payload), opts);
  registerHandler("attachments:open", async (payload) => {
    const problem = await platform.openPath(attachmentPath(db, payload.attachmentId));
    return { opened: problem === "", problem: problem || null };
  }, opts);
  registerHandler("attachments:save", async (payload) => {
    const attachment = getAttachment(db, payload.attachmentId as Uuid);
    if (!attachment) throw new Error("That attachment no longer exists.");
    const destination = await platform.saveFile({ title: "Save attachment", defaultPath: attachment.name });
    if (destination === null) return { saved: false, problem: null };
    try {
      await saveAttachmentTo(db, payload.attachmentId, destination);
      return { saved: true, problem: null };
    } catch (error) {
      return { saved: false, problem: error instanceof Error ? error.message : String(error) };
    }
  }, opts);
  registerHandler("attachments:delete", (payload) => deleteAttachmentCommand(db, attachmentStorage, payload), opts);
  // The item's own files (EO-702): part of what it is, beside its description.
  registerHandler("items:addAttachments", (payload) => addItemAttachmentsCommand(db, attachmentStorage, payload), opts);
  registerHandler("items:removeAttachment", (payload) => removeItemAttachmentCommand(db, attachmentStorage, payload), opts);

  // Jobs (EO-304, ARCHITECTURE.md, "Jobs"). The Jobs page that calls them is the
  // sixth story of this phase; `reachable.test.ts` carries them in
  // `AWAITING_ITS_SCREEN` until it lands.
  registerHandler("jobs:list", (payload) => listJobsCommand(db, payload), opts);
  registerHandler("jobs:get", (payload) => getJobCommand(db, payload), opts);
  // Where a job runs, and the two saves that may move it (EO-330,
  // ARCHITECTURE.md, "Where a job runs"). The facts are a function rather than a value because
  // finding
  // them spawns a CLI: the list, the page and the history want none of
  // it, and a context built eagerly would put a probe in front of every
  // one of them.
  const jobs: JobsContext = {
    facts: async () => {
      const kinds = await backendAuthKinds(runtimes);
      return { authKind: (provider: string) => kinds.get(provider) ?? "unknown", backendLabel, secrets: moduleSecrets };
    },
    ...(resources.session === undefined ? {} : { session: resources.session }),
  };
  // `config:changed` on the three that can add or remove a pipeline's
  // webhook entry (EO-405). The pipeline's editor draws its webhook
  // control from whether one exists, and the board's header states a
  // waiver that removing the last one has just turned off — both read
  // `pipelineSteps:list`, which listens for this and nothing else.
  registerHandler("jobs:create", async (payload) => announcePipeline(await createJobCommand(db, jobs, payload)), opts);
  registerHandler("jobs:update", async (payload) => announcePipeline(await updateJobCommand(db, jobs, payload)), opts);
  registerHandler("jobs:placement", (payload) => jobPlacementCommand(db, jobs, payload), opts);
  registerHandler("jobs:runNow", (payload) => runJobNowChecked(db, engine, payload), opts);
  registerHandler("jobs:delete", (payload) => announcePipeline(deleteJobCommand(db, payload)), opts);
  // EO-307: a paused job fires nothing, and what one has cost is asked
  // rather than stored.
  registerHandler("jobs:pause", (payload) => pauseJobCommand(db, payload), opts);
  registerHandler("jobs:resume", (payload) => resumeJobCommand(db, payload), opts);
  registerHandler("jobs:cost", (payload) => jobCostCommand(db, payload), opts);
  // A webhook job's own surface (EO-333, ARCHITECTURE.md, "The inbox, the archive and jobs"). The
  // storage is the same
  // instance everything else attaches through, for the reason
  // `startJobScheduler` is given it: a test event's payload hangs off
  // the item it creates exactly as a real delivery's does, and two views
  // of one directory would be two answers to where a file is.
  registerHandler("jobs:events", (payload) => jobEventsCommand(db, payload), opts);
  registerHandler("jobs:regenerateSecret", (payload) => regenerateWebhookSecretCommand(db, payload), opts);
  registerHandler("jobs:testEvent", (payload) => sendTestWebhookEventCommand(db, { storage: attachmentStorage }, engine, payload), opts);

  // The gallery (EO-316, ARCHITECTURE.md, "What a person sees first"). Where a
  // non-developer comes in: bundled templates, an index fetched when
  // there is a network, Preview before any sign-in, and a short form of
  // the template's own blanks.
  //
  // `signedInBackends` is asked per call rather than captured, for the
  // reason `pipelines:import` asks it again after the preflight: a
  // person may have signed in on the strength of a line that said they
  // had not, which is exactly what the needs check is for.
  const galleryContext = async (): Promise<GalleryContext> => ({
    directory: resources.galleryDirectory ?? "",
    moduleSecrets,
    signedInBackends: await signedInBackends(runtimes),
    // Who a role slot may be given to, once this desktop is signed in (EO-661).
    ...(resources.managed === undefined ? {} : { managed: resources.managed }),
  });
  registerHandler("gallery:list", async () => listGalleryCommand(db, await galleryContext()), opts);
  registerHandler("gallery:preview", async (payload) => previewGalleryCommand(db, await galleryContext(), payload), opts);
  registerHandler(
    "gallery:use",
    async (payload) => {
      const result = await useGalleryCommand(db, await galleryContext(), payload);
      // One submission creates a project, a workspace, a pipeline,
      // agents, item types and a job — which is most of what every
      // configuration screen in EO draws, and all of what the sidebar
      // does.
      if (result.problem === null) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler("gallery:needs", async (payload) => galleryNeedsCommand(db, await galleryContext(), payload), opts);
  registerHandler(
    "gallery:staffRole",
    async (payload) => {
      const result = await staffRoleCommand(db, await galleryContext(), payload);
      // An agent row was written or switched on: the Agents screen, the
      // step editor and the needs check are all reading it.
      if (result.ok) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler(
    "gallery:attachWorkspace",
    async (payload) => {
      const result = await attachWorkspaceCommand(db, payload);
      // The sidebar, the Workspaces screen and every step picker read
      // what this wrote — and the needs check is watching for the line
      // it just turned green (EO-317).
      if (result.ok) emitPush("config:changed", {});
      return result;
    },
    opts,
  );

  // The button on a red assistant line (EO-664). The Agents screen and the
  // needs check both read the row it wrote.
  registerHandler(
    "gallery:staffAssistant",
    async (payload) => {
      const result = staffAssistantCommand(db, await galleryContext(), payload);
      if (result.ok) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  // The needs check's way on for a template with no job (EO-664): a new
  // assistant chat with EO's brief for the first item. Pushed like New
  // chat: it changes which chat the room shows.
  registerHandler(
    "gallery:openFirstItemChat",
    async (payload) => {
      const opened = await openFirstItemChatCommand(db, await galleryContext(), engine, payload);
      if (opened.conversation !== null) emitPush("items:changed", {});
      return opened;
    },
    opts,
  );

  // First run (EO-317, ARCHITECTURE.md, "What a person sees first"). Which mode somebody
  // chose and whether the flow is behind them — the two facts about it
  // that outlive a window. Everything else in the order is a screen.
  registerHandler("firstRun:state", () => firstRunStateCommand(db), opts);
  registerHandler("firstRun:setMode", (payload) => setFirstRunModeCommand(db, payload), opts);
  // The first-board tour (EO-667): whether it is still to be shown, and
  // that it has been. Held here rather than in the window's storage, so
  // a relaunch, a second window and a served tab all agree.
  registerHandler("firstRun:tourState", () => tourStateCommand(db), opts);
  registerHandler("firstRun:tourSeen", () => markTourSeenCommand(db), opts);
  registerHandler(
    "firstRun:finish",
    () => {
      const result = finishFirstRunCommand(db);
      // The window this was pressed in has already moved on — it knows
      // what it did. The push is for every other reader of "is first run
      // behind this installation": a second window, and the next thing
      // to ask after a reload.
      emitPush("config:changed", {});
      return result;
    },
    opts,
  );

  // The assistant. The same chat
  // wherever it is opened (EO-193), of the several that can be live
  // (EO-391); `send` carries the route the
  // person is on, which names the board a graph raised here would be
  // published against and nothing else — never a sentence the renderer
  // wrote. The three below `send` are the buttons on its cards (EO-190).
  // Opening archives each chat that has gone idle, on show or not, and
  // pushes when it did: the lists every window draws are cached, and one
  // of them would otherwise go on showing an archived chat as open.
  registerHandler("assist:open", () => openAssist(db, () => emitPush("items:changed", {})), opts);
  // An empty chat on show, and nothing put away (EO-391). Pushed for the
  // reason the three below are: it changes which chat the room shows.
  registerHandler(
    "assist:new",
    () => {
      const started = newAssist(db);
      emitPush("items:changed", {});
      return started;
    },
    opts,
  );
  // Fix with assistant on a conflict notice (EO-533): the chat about one
  // held template update, started with EO's brief on the first press and
  // the same chat on every press after. Pushed like New chat: it changes
  // which chat the room shows.
  registerHandler(
    "assist:openUpdateConflict",
    async (payload) => {
      const opened = await openUpdateConflictAssist(db, engine, payload, resources.record ?? recordFor(db));
      emitPush("items:changed", {});
      return opened;
    },
    opts,
  );
  // Archives the thread and leaves an empty one (EO-193). No
  // confirmation anywhere on this path: nothing is deleted, so there is
  // nothing for a dialog to protect.
  // Both of these change which chat is on show, and every window that
  // holds the room is told, so none of them sends into one put away.
  registerHandler(
    "assist:clear",
    () => {
      const cleared = clearAssist(db, engine);
      emitPush("items:changed", {});
      return cleared;
    },
    opts,
  );
  // The chats a person has, and showing another: navigation, which puts
  // nothing away and stops nothing (EO-391), so it is handed no engine.
  registerHandler("assist:list", () => listAssist(db), opts);
  registerHandler(
    "assist:resume",
    (payload) => {
      const resumed = resumeAssist(db, payload);
      emitPush("items:changed", {});
      return resumed;
    },
    opts,
  );
  // Where an open chat stands in the list (EO-438). Pushed because the
  // order is one order: every window that lists the open chats draws
  // the same one. On `assist:changed` and not `items:changed`
  // (EO-439): no item changed, and that push refetches everything every
  // window draws from items.
  registerHandler(
    "assist:reorder",
    (payload) => {
      const reordered = reorderAssist(db, payload);
      emitPush("assist:changed", {});
      return reordered;
    },
    opts,
  );
  // Removing a chat for good (EO-390). Pushed for the reason the two
  // above are: the rail's list is drawn in every window, and removing
  // the chat on show changes which conversation the room is.
  registerHandler(
    "assist:remove",
    async (payload) => {
      const removed = await removeAssist(db, engine, payload, attachmentStorage);
      emitPush("items:changed", {});
      return removed;
    },
    opts,
  );
  // Removing several at once (EO-442), from the rail's selection behind
  // one warning. Pushed for the same reason as one.
  registerHandler(
    "assist:removeMany",
    async (payload) => {
      const removed = await removeManyAssist(db, engine, payload, attachmentStorage);
      emitPush("items:changed", {});
      return removed;
    },
    opts,
  );
  // A send that names no chat opens the room, so it can archive too.
  registerHandler("assist:send", (payload) => sendToAssist(db, engine, payload, attachmentStorage, () => emitPush("items:changed", {})), opts);
  // Stopping the turn running in a chat, and what the next ones run with.
  // Both write to the chat itself, and every window holding it is told.
  registerHandler(
    "assist:stop",
    (payload) => {
      const stopped = stopAssistTurn(db, engine, payload);
      emitPush("items:changed", { itemId: payload.conversationId });
      return stopped;
    },
    opts,
  );
  registerHandler(
    "assist:settings",
    (payload) => {
      const updated = updateAssistSettings(db, payload);
      emitPush("items:changed", { itemId: payload.conversationId });
      return updated;
    },
    opts,
  );
  // The backend started while a person types, so the turn starts sooner.
  registerHandler("assist:prewarm", (payload) => prewarmAssist(db, engine, payload), opts);
  // Older pages of a chat, read as the person scrolls back.
  registerHandler("assist:earlier", (payload) => readEarlierAssist(db, payload), opts);
  // A queued message taken back before its turn starts. Pushed, so every
  // window holding the chat drops its "waiting" line.
  registerHandler(
    "assist:withdraw",
    (payload) => {
      const withdrawn = withdrawAssistMessage(db, payload);
      emitPush("items:changed", { itemId: payload.conversationId });
      return withdrawn;
    },
    opts,
  );
  // A new chat holding this one up to a message, shown: it changes which
  // chat the room is, as `assist:new` does.
  registerHandler(
    "assist:fork",
    (payload) => {
      const forked = forkAssistConversation(db, payload);
      emitPush("items:changed", {});
      return forked;
    },
    opts,
  );
  registerHandler("assist:answer", (payload) => answerAssistQuestions(db, engine, payload), opts);
  // A reorder card on an item the organisation's record holds is asked
  // of the record (EO-600); every other card is approved here.
  registerHandler("assist:approve", (payload) => approveAssistProposalThroughRecord(db, engine, resources.record ?? recordFor(db), payload), opts);
  registerHandler("assist:proposal", (payload) => readAssistProposal(db, payload), opts);
  // A change to a module that exists, applied from its card (EO-418): a
  // module save, so it needs the runner that re-runs that module's tests.
  registerHandler("assist:applyChange", (payload) => applyAssistModuleChangeCommand(db, engine, moduleTests, payload), opts);
  // Cards for what only a person may do (EO-521): export, import or
  // delete a pipeline, or discard this machine's edits to one. Carried
  // out through the channel the editor called, by `dispatchIpc`, so the
  // lock, the save dialog and the pushes those channels own come with it.
  const cardDoors = { dispatch: dispatchIpc, readAttachment: (path: string) => attachmentStorage.read(path) };
  registerHandler("assist:card", (payload) => readAssistCardCommand(db, cardDoors, payload), opts);
  registerHandler("assist:applyCard", (payload) => applyAssistCardCommand(db, engine, cardDoors, payload), opts);
  // No `assist:save`: a draft raised in the widget is published through
  // `pipeline:save`, the channel the configuration screen's own Publish
  // button calls. This one only reads the graph back out.
  // Asked of the record too where the draft resolves a template update
  // the organisation's record holds (EO-534).
  registerHandler("assist:draft", (payload) => readAssistDraftForPublishWithRecord(db, conflictRecord(), payload, { onTheRecord: !platform.hasMachine }), opts);
  // A draft card's graph was published (EO-534): from the chat that holds
  // a template update conflict, that resolves it. Pushed for the notice
  // it closes.
  // Publish on a draft resolving a template update the organisation's
  // record holds (EO-534): saved and resolved there, and here where this
  // desktop keeps its own copy.
  registerHandler(
    "assist:publishOnRecord",
    async (payload) => {
      const result = await publishOnRecord(db, engine, conflictRecord(), payload);
      if (result.saved) emitPush("config:changed", {});
      if (result.resolved) emitPush("items:changed", {});
      return result;
    },
    opts,
  );
  registerHandler(
    "assist:draftPublished",
    (payload) => {
      const result = assistDraftPublished(db, payload, { onTheRecord: !platform.hasMachine });
      if (result.resolved) emitPush("items:changed", {});
      return result;
    },
    opts,
  );
  // Creates a pipeline and publishes its graph (EO-381): a write to the
  // configuration, so every window hears about it as `pipeline:save` and
  // `pipelines:create` are heard about.
  registerHandler(
    "assist:publishNew",
    (payload) => {
      const result = publishNewAssistPipeline(db, engine, payload);
      if (result.saved) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  // Approve and publish on a draft card that needs modules (EO-581):
  // every module's tests run in the queue `modules:approve` uses, then the
  // approvals and the publish land in one transaction. The secrets of
  // steps nothing can reach any more go after the commit, as on
  // `pipeline:save`.
  registerHandler(
    "assist:approveAndPublish",
    async (payload) => {
      const result = await approveAndPublishAssistDraft(db, engine, moduleTests, conflictRecord(), payload, {
        place: { onTheRecord: !platform.hasMachine },
        onStepsRemoved: (stepIds) => {
          for (const stepId of stepIds) clearStepSecrets(moduleSecrets, stepId);
        },
      });
      if (result.saved) {
        emitPush("config:changed", {});
        // For the notice a resolved template update closes (EO-534).
        emitPush("items:changed", {});
      }
      return result;
    },
    opts,
  );
  // Publish on the publish card after a draft's trials (EO-588): Approve
  // and publish for the draft under test — the modules' tests, then their
  // approvals and the publish in one transaction — and then the trial is
  // discarded through the item-delete path.
  registerHandler(
    "assist:publishTrial",
    async (payload) => {
      const result = await publishTrialCommand(db, engine, moduleTests, { attachmentStorage }, payload, {
        onStepsRemoved: (stepIds) => {
          for (const stepId of stepIds) clearStepSecrets(moduleSecrets, stepId);
        },
      });
      if (result.saved) {
        emitPush("config:changed", {});
        emitPush("items:changed", {});
      }
      return result;
    },
    opts,
  );
  // Approve design (EO-587): the trial, its grants, its test items and
  // its first round, made in one act. Publishes nothing, so no
  // `config:changed`; the conversation it answers in changes.
  registerHandler(
    "assist:approveDesign",
    async (payload) => {
      const result = await approveTrialDesign(db, { engine, attachmentStorage }, payload, { onTheRecord: !platform.hasMachine });
      if (result.approved) emitPush("items:changed", {});
      return result;
    },
    opts,
  );
  // The canvas's own window (EO-383). Through the platform, because
  // `new BrowserWindow` is written in exactly one file and this is not
  // it — and on a machine with no screen the answer is `false` rather
  // than a window nobody sees. What the window opens with, and what a
  // "Pop in" hands back, is held in canvasWindow.ts.
  registerHandler("canvas:window", (payload) => popOutCanvas(platform, payload), opts);
  registerHandler("canvas:open", (payload) => openInCanvas(platform, payload), opts);
  registerHandler("canvas:close", (payload) => closeCanvas(platform, payload), opts);
  registerHandler("canvas:ask", () => askFromCanvas(platform), opts);
  registerHandler("canvas:state", () => canvasState(platform), opts);

  // Debug mode (EO-392): the switch, the window, and what fills it. The
  // window is the platform's for the canvas window's reason, and opens
  // only while the setting is on.
  registerHandler("debug:getMode", () => getDebugMode(db), opts);
  registerHandler("debug:setMode", (payload) => setDebugMode(db, payload.enabled), opts);
  registerHandler("debug:window", () => openDebugWindow(db, platform), opts);
  registerHandler("debug:runs", () => listDebugAgents(db), opts);

  // The main window's own title bar (EO-668): the platform's, because
  // the window is, and nothing to it but the window.
  registerHandler("window:state", () => ({ fullScreen: platform.isFullScreen() }), opts);
  registerHandler("window:titleBar", (payload) => ({ applied: platform.setTitleBarColours(payload) }), opts);

  // A module's scenario chat (EO-356): "+ Add scenario" on its page. One
  // thread per module. Apply is the one button here that writes anything
  // outside the thread — a module save, with the module's tests re-run
  // against the new code in the same queue every other run of them uses.
  registerHandler("scenario:open", (payload) => openScenario(db, payload), opts);
  registerHandler("scenario:clear", (payload) => clearScenario(db, engine, payload), opts);
  registerHandler("scenario:send", (payload) => sendToScenario(db, engine, payload, attachmentStorage), opts);
  registerHandler("scenario:answer", (payload) => answerScenarioQuestions(db, engine, payload), opts);
  registerHandler("scenario:apply", (payload) => applyScenarioChangeCommand(db, engine, moduleTests, payload), opts);

  // What is on screen right now (EO-192). The renderer publishes
  // identifiers and view parameters as they change; the read resolves
  // them against the database and is what `view_current` reaches over
  // `eo_admin`. Nothing here is stored — see currentView.ts.
  registerHandler("view:publish", (payload) => publishView(payload), opts);
  registerHandler(
    "view:current",
    () => readCurrentView(db, { hasWindow: () => platform.hasWindow(), proposal: (messageId) => readAssistProposal(db, { messageId }).proposal }),
    opts,
  );

  // With the item files named by path (EO-704), checked and stored
  // before the items are written, and written with them.
  registerHandler("work:submitPlan", (payload) => submitPlanCommand(db, engine, payload, attachmentStorage), opts);
  registerHandler("work:submitItem", (payload) => submitItemCommand(db, engine, payload, attachmentStorage), opts);
  registerHandler("comments:post", (payload) => postCommentCommand(db, engine, payload, attachmentStorage), opts);
  registerHandler("comments:setPinned", (payload) => setPinned(db, payload), opts);
  registerHandler(
    "comments:delete",
    async (payload) => {
      const result = await deleteCommentCommand(db, jira, payload, attachmentStorage);
      // Every window showing this item, not just the one that asked —
      // and the project too, since `!` derives from mentions a deleted
      // comment may have carried or answered.
      if (result.deleted) emitPush("items:changed", {});
      return result;
    },
    opts,
  );
  // What an item waits for goes to whichever record owns it (EO-600):
  // on a project the organisation's record holds, the record makes the
  // change. Everything else is this database's, as it always was —
  // item files added by path and removed by id included (EO-704).
  registerHandler("items:update", (payload) => updateItemCommand(db, resources.record ?? recordFor(db), payload, attachmentStorage), opts);
  // A pipeline's module entry rules are run before the move (EO-736).
  registerHandler("items:move", (payload) => moveItemChecked(db, engine, payload), opts);
  registerHandler("items:moveToVersion", (payload) => moveItemToVersion(db, engine, payload), opts);
  // A person answering rather than dragging (EO-310). It goes near the
  // engine for `items:move`'s reason and one more: the step a decision
  // routes the item onto may be dispatchable the instant it arrives.
  registerHandler("items:decide", (payload) => decideItemChecked(db, engine, payload), opts);
  registerHandler("items:hold", (payload) => holdItem(db, engine, payload), opts);
  // Neither is a transition, so neither goes near the engine: the item
  // stays on its step and whatever is running stays running (EO-305).
  registerHandler("items:claim", (payload) => claimItem(db, payload), opts);
  // A member taking an item over from its holder, after the warning
  // (EO-368). Not a transition either.
  registerHandler("items:takeOver", (payload) => takeOverItem(db, payload), opts);
  // …and who may do which of those, for the screen that offers them.
  registerHandler(
    "items:authority",
    (payload) => itemAuthorityCommand(db, payload, resources.managed === undefined ? {} : { managed: resources.managed }),
    opts,
  );
  // …except that an assignment on a signed-in desktop may name a
  // colleague this machine has never written down: the picker offers the
  // organisation's list. `knowAssignee` adopts them first (EO-367).
  registerHandler(
    "items:assign",
    async (payload) => {
      await knowAssignee(db, payload, resources.managed === undefined ? {} : { managed: resources.managed });
      return assignItem(db, payload);
    },
    opts,
  );
  registerHandler("items:resume", (payload) => resumeHeldItem(db, engine, payload), opts);
  registerHandler(
    "items:delete",
    async (payload) => {
      const result = await deleteItemCommand(db, engine, jira, payload, attachmentStorage);
      if (result.deleted) {
        // The project has to lose the row — in every window, not just the
        // one that asked. This emitted only `config:changed` before,
        // which no project listens to.
        emitPush("items:changed", { itemId: payload.itemId });
        // The worktrees screen counts them too, and a delete may have
        // released one.
        emitPush("config:changed", {});
      }
      return result;
    },
    opts,
  );
  registerHandler("runs:cancel", (payload) => cancelRun(engine, payload), opts);
  registerHandler("engine:pause", (payload) => pauseEngine(db, engine, payload), opts);
  registerHandler("engine:resume", () => resumeEngine(db, engine), opts);
  registerHandler("engine:status", () => engineStatus(db, engine), opts);
  registerHandler("settings:get", () => readSettings(db), opts);
  // Reading Jira on demand. Comments arriving this way already announce
  // themselves through `postComment`, so the thread updates itself; the
  // item list is refreshed here for a changed title.
  registerHandler(
    "jira:pull",
    async (payload) => {
      const result = await pullItem(db, jira, payload.itemId as Uuid, attachmentStorage);
      if (result.comments > 0 || result.edits > 0 || result.attachments > 0) emitPush("items:changed", { itemId: payload.itemId });
      return result;
    },
    opts,
  );
  // KAN-33: what the project has put away, and putting one back.
  registerHandler(
    "items:listArchived",
    (payload) => listArchivedSummaries(db, boardProjectId(db, payload) as Uuid | null, ArchivedItemListFiltersSchema.parse(payload)),
    opts,
  );
  registerHandler(
    "items:setArchived",
    (payload) => {
      const result = setArchived(db, payload);
      // The project gained or lost a row, and the engine's view of what is
      // dispatchable changed with it.
      if (result.problem === null) {
        emitPush("items:changed", { itemId: payload.itemId });
        engine?.notifyStateChange();
      }
      return result;
    },
    opts,
  );
  // A person's correction becomes what the next step works from
  // (EO-298). The item's thread gained a comment, so the open item
  // refetches — `postComment` announces the comment itself, and this is
  // what refreshes anything reading the item rather than the thread.
  registerHandler(
    "items:setOutput",
    (payload) => {
      const result = setItemOutput(db, payload);
      if (result.problem === null) emitPush("items:changed", { itemId: payload.itemId });
      return result;
    },
    opts,
  );
  // Saving what the item produced (EO-311). A dialog and a write, both
  // of them the machine's — which is why the channel is in the machine
  // half of the contract and why the renderer has to come here for it
  // (F-02). Nothing is pushed: exporting changes nothing about the item.
  registerHandler("items:exportOutput", (payload) => exportItemOutput(db, platform, payload), opts);
  registerHandler("settings:set", (payload) => writeSettings(db, payload), opts);

  // The registry, short of its schemas (KAN-124). The same value the
  // handlers above and the supervisor consult, so the editor's built-in
  // marking and the running behaviour cannot disagree.
  //
  // Item types come from the table, for the project the window is on
  // (KAN-129) — they are rows scoped to a project now, and answering
  // from the packs' constants would show a renderer a type list its
  // board does not have. The channel takes no project id: the window
  // shows one project at a time, and `items:list` and `inbox:list`
  // already read the active one the same way.
  //
  // Each action also says which steps dispatch it (EO-425), which is the
  // one part of the answer that is about the pipelines rather than the
  // registry.
  registerHandler("registry:get", () => withActionUses(db, toRegistryView(registryForProject(db, activeProjectId(db) as Uuid | null))), opts);
  // A role's own action definitions (EO-425). Announced like an agent
  // save: the pipeline editor's validation and the agent screen both
  // read what these change.
  registerHandler("roleActions:save", (payload) => announcePipeline(saveRoleActionCommand(db, payload)), opts);
  registerHandler("roleActions:delete", (payload) => announcePipeline(deleteRoleActionCommand(db, payload)), opts);
  // What one action is and which steps it reaches (EO-427). A read: no push.
  registerHandler("roleActions:inspect", (payload) => inspectRoleActionCommand(db, activeProjectId(db) as Uuid | null, payload), opts);
  registerHandler("agents:listDetailed", () => listAgentDetails(db), opts);
  registerHandler(
    "agents:save",
    (payload) => {
      const saved = saveAgent(db, payload);
      emitPush("config:changed", {});
      return saved;
    },
    opts,
  );
  // A project's own copy of a global agent (EO-475). Announced like a
  // save, since it is one: the copy takes precedence on the project the
  // moment it exists, and every staffing check reads the same list.
  registerHandler(
    "agents:customise",
    (payload) => {
      const saved = customiseAgent(db, payload);
      if (saved.saved) emitPush("config:changed", {});
      return saved;
    },
    opts,
  );
  // Who a project's work goes to, role by role (EO-475). A read: no push.
  registerHandler("projects:staffing", (payload) => projectStaffing(db, payload), opts);
  // Which backend and model this machine runs a published agent on
  // (EO-329, ARCHITECTURE.md, "Publish, lock and versions"). Never locked, and unable to express
  // anything the
  // agents section publishes — see `setAgentBinding`.
  registerHandler(
    "agents:setBinding",
    (payload) => {
      const bound = setAgentBinding(db, payload);
      if (bound.bound) emitPush("config:changed", {});
      return bound;
    },
    opts,
  );
  // Retiring an agent (EO-186). `config:changed` because the step-owner
  // picker and every staffing check read the same list: an archived
  // agent staffs nothing, and a screen still offering it as an owner is
  // offering a step that would never dispatch.
  //
  // Both answer with what would be affected until the call confirms
  // (EO-350), and only a confirmed one changes anything — announced
  // either way, which costs a refetch and says nothing untrue.
  registerHandler("agents:archive", (payload) => {
    const result = archiveAgentCommand(db, payload, engine);
    if (result.archived) announceCancelledRuns(result.impact);
    return announcePipeline(result);
  }, opts);
  registerHandler("agents:delete", (payload) => {
    const result = deleteAgentCommand(db, payload, engine);
    if (result.deleted) announceCancelledRuns(result.impact);
    return announcePipeline(result);
  }, opts);
  registerHandler("pipeline:validate", (payload) => validatePipelineCommand(db, payload), opts);
  registerHandler(
    "pipeline:save",
    (payload) => {
      // A step nothing can reach any more takes its secret values with
      // it: they are reachable only through its id, so leaving them
      // would leave ciphertext nothing can read, list or remove again.
      //
      // "Nothing can reach" rather than "this save removed" since
      // EO-327: a removed step is retired so that an item finishing on
      // an older version can still be routed onto it, and a ghost step
      // whose credential EO had already thrown away is a run that fails
      // with the module's name on it. `savePipeline` decides which
      // steps those are.
      const result = savePipeline(db, engine, payload, (stepIds) => {
        for (const stepId of stepIds) clearStepSecrets(moduleSecrets, stepId);
      });
      if (result.saved) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler(
    "providers:capabilities",
    async (payload) => {
      const capabilities = capabilitiesFor(payload.provider);
      if (!payload.refreshModels || !capabilities.modelsAreLive) {
        return { capabilities, models: capabilities.models, problem: null };
      }

      try {
        const runtime = runtimeStatus(runtimes, { provider: payload.provider }).runtime;
        if (runtime?.enabled === false) {
          return { capabilities, models: [], problem: `${runtime.label} is disabled in Runtimes.` };
        }
        const executablePath = runtime?.path ?? null;
        const fetched =
          payload.provider === "codex"
            ? await fetchCodexModels(executablePath)
            : await (async () => {
                const { query } = await loadClaudeSdk(resolvePackageSet(runtimes.root, CLAUDE_SDK));
                return fetchClaudeModels(query, executablePath);
              })();
        return fetched.ok
          ? { capabilities: { ...capabilities, models: fetched.models }, models: fetched.models, problem: null }
          : { capabilities, models: [], problem: fetched.reason };
      } catch (error) {
        // Not installed yet is the ordinary first-run state, not a
        // failure — the editor still opens and a model can still be
        // typed by hand.
        return { capabilities, models: [], problem: error instanceof Error ? error.message : String(error) };
      }
    },
    opts,
  );
  // The one caller that asks the binary whether it is signed in (EO-82):
  // this is the channel every surface showing a runtime renders from.
  registerHandler("runtime:status", (payload) => runtimeStatusWithAuth(runtimes, payload), opts);
  registerHandler("runtime:describe", (payload) => describeRuntime(runtimes, payload), opts);
  // EO-477: the small model each backend's side calls run on, with its
  // default — Codex's is the smallest its runtime reports, which asks
  // the CLI, so the list is kept for a while (`smallModelSources`).
  registerHandler(
    "sideCalls:smallModels",
    async () => ({
      backends: await describeSmallModels(db, smallModelSources((backend) => runtimeStatus(runtimes, { provider: backend }).runtime?.path ?? null)),
    }),
    opts,
  );
  registerHandler("sideCalls:setSmallModel", (payload) => chooseSmallModel(db, payload.backend, payload.model), opts);
  registerHandler(
    "runtime:install",
    async (payload) => {
      const result = await installRuntimeCommand(runtimes, payload);
      // The engine needs no telling — it re-resolves on every dispatch,
      // and the resolved path is part of its provider cache key. This is
      // for the other windows, whose runtime status just went stale.
      if (result.ok) emitPush("config:changed", {});
      return result;
    },
    opts,
  );

  /**
   * Signing a runtime in without a terminal (EO-83).
   *
   * Three channels because a sign-in is a session rather than a call:
   * the child sits there printing a URL and waiting — on a browser, or
   * on stdin — until somebody finishes or abandons it.
   *
   * Both ends push `config:changed`, and a *cancelled* one pushes as
   * hard as a successful one does: both Codex login paths delete
   * `~/.codex/auth.json` on the way in, so walking away from the dialog
   * has signed this machine out and every window still saying
   * "Connected" is now wrong.
   */
  registerHandler("runtime:startSignIn", (payload) => startRuntimeSignIn(runtimes, payload), opts);
  registerHandler(
    "runtime:submitSignInCode",
    async (payload) => {
      const result = await submitRuntimeSignInCode(payload);
      emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler(
    "runtime:cancelSignIn",
    (payload) => {
      const result = cancelRuntimeSignIn(payload);
      if (result.cancelled) emitPush("config:changed", {});
      return result;
    },
    opts,
  );

  /**
   * The API-key way in (EO-84).
   *
   * Both push `config:changed` on success, for the reason the sign-in
   * channels do: every other window is still rendering a runtime whose
   * credentials have just changed. A removal pushes too — a card still
   * offering to remove a key that is gone is the same staleness.
   *
   * Nothing here logs the payload. The key is in `payload.apiKey` on the
   * way in and in nothing on the way out.
   */
  registerHandler(
    "runtime:signInWithApiKey",
    async (payload) => {
      const result = await signInWithRuntimeApiKey(runtimes, payload);
      if (result.ok) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler(
    "runtime:removeApiKey",
    (payload) => {
      const result = removeRuntimeApiKey(runtimes, payload);
      if (result.removed) emitPush("config:changed", {});
      return result;
    },
    opts,
  );

  // ── The organisation's list (EO-323, ARCHITECTURE.md, "Identity") ───
  //
  // Registered on both processes, because both are a record: a server
  // answers from the organisation's tables and a desktop from its own.
  // The server's door is what decides who may reach which of them —
  // `ADMIN_ONLY_CHANNELS` — because the door is the only place there is
  // a caller to ask about.
  //
  // `config:changed` after each write, for the reason every other
  // configuration write emits it: a column head names the person or the
  // group a step waits on, so a board that is already open has to hear
  // about a change made in Settings.
  const identity: IdentityContext = resources.managed === undefined ? {} : { managed: resources.managed };
  registerHandler("people:list", () => listPeopleCommand(db, identity), opts);
  registerHandler("people:me", (payload) => whoAmICommand(db, payload), opts);
  registerHandler("people:invite", (payload) => invitePersonCommand(db, payload, identity), opts);
  registerHandler(
    "people:setAdmin",
    async (payload) => {
      const result = await setAdminCommand(db, payload, identity);
      if (result.problem === null) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  // Policy (EO-328, ARCHITECTURE.md, "Policy"). The same `managed` seam the identity
  // commands take, so the rule is one rule: a desktop signed in to an
  // organisation forwards its writes to the record, and a solo desktop
  // and the server answer from their own row.
  const policy: PolicyContext = { secrets: organisationSecrets, ...(resources.managed === undefined ? {} : { managed: resources.managed }) };
  registerHandler("policy:get", (payload) => getPolicyCommand(db, policy, payload), opts);
  registerHandler(
    "policy:save",
    async (payload) => {
      const result = await savePolicyCommand(db, policy, payload);
      // Every screen that reads a policy is one somebody may have open:
      // the Agents editor's picker, the top bar's budget line, the
      // secret rows. One push, as every other configuration write emits.
      if (result.saved) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler(
    "policy:setSecret",
    async (payload) => {
      const result = await setPolicySecretCommand(db, policy, payload);
      if (result.saved) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler(
    "policy:clearSecret",
    async (payload) => {
      const result = await clearPolicySecretCommand(db, policy, payload);
      if (result.cleared) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler("auth:acceptInvitation", (payload) => acceptInvitationCommand(db, payload), opts);
  registerHandler("auth:signIn", (payload) => serverSignInCommand(db, payload), opts);
  registerHandler("devices:list", () => listDevicesCommand(db, identity), opts);
  registerHandler("devices:revoke", (payload) => revokeDeviceCommand(db, payload, identity), opts);
  registerHandler(
    "groups:save",
    async (payload) => {
      const result = await saveGroupCommand(db, payload, identity);
      if (result.problem === null) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler(
    "groups:delete",
    async (payload) => {
      const result = await deleteGroupCommand(db, payload, identity);
      if (result.deleted) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler(
    "steps:setOwner",
    async (payload) => {
      const result = await setStepOwnerCommand(db, payload, identity);
      if (result.problem === null) emitPush("config:changed", {});
      return result;
    },
    opts,
  );

  // ── What the organisation publishes, and what that locks ────────
  //
  // The admin's half of EO-329. `sections:list` is answered on both
  // ends of the link and means something different on each: on the
  // record it is what an admin published, on a desktop it is what
  // arrived and what its screens are therefore drawn locked. The two
  // writes are admin-only and are refused on a desktop by the server's
  // door, which is the only place a device could reach them from.
  registerHandler("sections:list", () => listSectionsCommand(db), opts);
  registerHandler("sections:publishPreflight", (payload) => publishPreflightCommand(db, payload), opts);
  registerHandler(
    "sections:publish",
    (payload) => {
      const result = publishSectionCommand(db, payload);
      // The admin's own screens first: a publish changes what the
      // section looks like here as well as everywhere else, and a
      // rollback has just rewritten the graph the board is drawing.
      // Every other desktop learns of it on its next pull.
      if (result.problem === null) emitPush("config:changed", {});
      return result;
    },
    opts,
  );

  // ── The record, as a device reaches it (EO-324, ARCHITECTURE.md, "The record") ──────
  //
  // Registered on both processes for `people:*`'s reason and one more
  // of its own. A server answers these because it is the record. A solo
  // desktop answers them because it is *also* the record — and nothing
  // sends them to it, because a process that is its own record calls
  // `ItemRecord` rather than posting itself a request. One
  // implementation, reachable either way, which is the sentence the design
  // spends this whole phase keeping true.
  //
  // What the server's door adds is who may ask: every one of these is a
  // record channel behind a device token (`server/http.ts`), and none
  // of them is admin-only — a device asking for its own work is the
  // ordinary case, not an administrative one.
  const serving: ServeRecordContext = {
    db,
    record: recordFor(db),
    // Through the engine, so that the record's scheduler is the
    // scheduler. Without one — the v1 gate, a test — this process has
    // nothing to dispatch with and offers nothing, which is honest:
    // there is no engine here to have leased anything.
    offerWork: (deviceId, capacity) => engine?.offerWork(deviceId, capacity) ?? Promise.resolve([]),
    // Where a file a device sends is kept, and read back from. The same
    // store every other attachment in this installation lives in, so
    // one that arrived from somebody's laptop is a file on the record
    // like any other rather than a second kind of thing.
    attachments: attachmentStorage,
    // The caps a scope is settled under when a device undoes one of this
    // record's consolidations (EO-482).
    memoryCaps: () => {
      const guards = readGuards(db);
      return { maxEntries: guards.memoryScopeMaxEntries, maxChars: guards.memoryScopeMaxChars };
    },
    templateHistory,
    // How an agent's unused skill of a project held here is aged (EO-720).
    skillAgeing: () => {
      const guards = readGuards(db);
      return { staleAfterRuns: guards.skillStaleAfterRuns, archiveAfterRuns: guards.skillArchiveAfterRuns };
    },
  };
  registerHandler("record:work", (payload) => serveWork(serving, payload), opts);
  registerHandler("record:renew", (payload) => serveRenew(serving, payload), opts);
  registerHandler("record:release", (payload) => serveRelease(serving, payload), opts);
  registerHandler("record:spend", (payload) => serveSpend(serving, payload), opts);
  // A module's run on a device asking for a work item (EO-433).
  registerHandler("record:createItem", (payload) => serveCreateItem(serving, payload), opts);
  // A device asking to change what an item of a project this record
  // holds waits for: the graph is the record's to judge (EO-600).
  registerHandler("record:changeDependencies", (payload) => serveChangeDependencies(serving, payload), opts);
  // A device asking to change an item type of a project this record
  // holds: the type, and the items its fields are judged against, are
  // the record's (EO-735).
  registerHandler("record:updateItemType", (payload) => serveUpdateItemType(serving, payload), opts);
  // A device sending a message about a project this record holds, a
  // person on one answering or dismissing it, and a device pulling its
  // person's: messages about the record's projects live here (EO-726).
  registerHandler("record:sendMessage", (payload) => serveSendMessage(serving, payload), opts);
  registerHandler("record:handleMessage", (payload) => serveHandleMessage(serving, payload), opts);
  registerHandler("record:messages", (payload) => serveMessages(serving, payload), opts);
  // A device whose admin pressed Fix with assistant on a notice about a
  // conflict this record holds: the chat is the record's to make, once
  // for every admin (EO-533).
  registerHandler("record:updateConflictChat", (payload) => serveUpdateConflictChat(serving, payload), opts);
  // A device reading a template update this record holds, and an admin's
  // device resolving one: kept, or a draft published from its chat,
  // saved here (EO-534).
  registerHandler("record:updateConflict", (payload) => serveUpdateConflict(serving, payload), opts);
  registerHandler("record:templateStatus", (payload) => serveTemplateStatus(serving, payload), opts);
  registerHandler("record:resolveUpdateConflict", (payload) => serveResolveUpdateConflict(serving, payload), opts);
  // A device writing to the memory of a project this record holds, and
  // the consolidations this record ran over it (EO-482).
  registerHandler("record:memory", (payload) => serveMemory(serving, payload), opts);
  registerHandler("record:memoryConsolidations", (payload) => serveMemoryConsolidations(serving, payload), opts);
  registerHandler("record:restoreMemoryConsolidation", (payload) => serveRestoreMemoryConsolidation(serving, payload), opts);
  // A device restoring a skill this record holds (EO-728).
  registerHandler("record:restoreSkillVersion", (payload) => serveRestoreSkillVersion(serving, payload), opts);
  // The push that follows a command landing is `serveApply`'s own — it
  // is the record that changed, and a door emitting it would be a
  // second place to remember.
  registerHandler("record:apply", (payload) => serveApply(serving, payload), opts);
  registerHandler("record:changes", (payload) => serveChanges(serving, payload), opts);
  registerHandler("record:attachment", (payload) => serveAttachment(serving, payload), opts);
  // A project handed over, one page at a time (EO-325). The record's
  // side of the keep-or-move sheet: somebody's existing work arriving
  // with its own ids, written and counted.
  registerHandler("record:adopt", (payload) => serveAdopt(serving, payload), opts);

  // This machine's own sign-in — the machine half of identity, and the
  // only part of it that is not the record's (EO-323, ARCHITECTURE.md, "The record", "Identity").
  const session: SessionContext | null = resources.session === undefined ? null : { session: resources.session };
  registerHandler("session:status", () => (session === null ? SIGNED_OUT : sessionStatusCommand(session)), opts);
  // How this machine is getting on with its record (EO-324, ARCHITECTURE.md, "The record").
  //
  // The machine half, beside the sign-in it depends on: a server is the
  // record and has no link to one, so the browser an admin opens it in
  // is refused here by name and draws no line at all.
  registerHandler(
    "sync:status",
    () => syncStatus(db, session !== null && sessionStatusCommand(session).state === "signed-in"),
    opts,
  );
  registerHandler(
    "session:signIn",
    async (payload) => {
      if (session === null) return { status: SIGNED_OUT, problem: NO_KEYCHAIN_HERE };
      const result = await desktopSignInCommand(session, payload);
      // The people list, the column heads and the top bar all change on
      // a sign-in, and none of them asked for it.
      if (result.problem === null) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler(
    "session:signOut",
    () => {
      if (session === null) return { status: SIGNED_OUT };
      const result = signOutCommand(session);
      // Everything the organisation gave this machine goes with the
      // token (EO-328, ARCHITECTURE.md, "Secrets") — the secret values and the cached policy
      // both. `forgetOrganisationState` is the one function, because a
      // *revocation* is the same event from this machine's point of view
      // and used to forget neither. The person's own secrets are
      // untouched, which is what the separate directory is for and what
      // the lock text promises: "your sign-ins, local folders and
      // personal secrets are yours".
      forgetOrganisationState(db, organisationSecrets);
      emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  // EO's MCP server for external clients. The handlers write settings
  // and read status; starting and stopping is the host's own business,
  // which is what keeps the MCP SDK out of this file.
  //
  // See `unavailableMcpStatus` below for what a build without one says.
  const mcp = resources.mcp;
  registerHandler(
    "mcp:getStatus",
    () => (mcp === undefined ? unavailableMcpStatus() : getMcpStatus(mcp)),
    opts,
  );
  registerHandler(
    "mcp:setConfig",
    async (payload) => (mcp === undefined ? unavailableMcpStatus() : setMcpConfig(db, mcp, payload)),
    opts,
  );
  registerHandler(
    "mcp:regenerateToken",
    async () => (mcp === undefined ? unavailableMcpStatus() : regenerateMcpToken(mcp)),
    opts,
  );
  registerHandler(
    "mcp:detectClients",
    async () => (mcp === undefined ? { clients: [], oldNameUse: [] } : detectMcpClients(db, mcp)),
    opts,
  );
  registerHandler(
    "mcp:registerWith",
    async (payload) =>
      mcp === undefined
        ? { client: { id: payload.id, label: payload.id, installed: false, registered: false, caveat: null, problem: "This build has no MCP server.", manual: null } }
        : registerMcpWith(mcp, payload),
    opts,
  );

  // Repository intelligence's rollout switch (EO-148). Two lines, like
  // the guards above and for the same reason: the gate module already
  // has exactly this signature, so there is no command layer worth
  // writing between them. Nothing here starts or stops anything —
  // every reader looks the setting up when it needs an answer, so the
  // next dispatch is the one that behaves differently.
  // The switch and what it produced, on the same two channels (EO-148,
  // EO-154). Both answer through `repositoryIntelligenceStatusCommand`,
  // which re-reads what is stored — so the write's reply is the truth
  // rather than an echo of the patch, and the screen never has to ask
  // twice for one section's worth of state.
  registerHandler("repositoryIntelligence:getConfig", () => repositoryIntelligenceStatusCommand(db), opts);
  registerHandler(
    "repositoryIntelligence:setConfig",
    (payload) => {
      writeRepositoryIntelligenceConfig(db, payload);
      return repositoryIntelligenceStatusCommand(db);
    },
    opts,
  );

  // And how to put it right. The root is the engine's own, imported from
  // the one place that computes it, so this screen and a dispatch can
  // never disagree about which binary is installed. Nothing is cached:
  // each operation builds a runtime per call, so turning the switch off
  // takes effect on the next press rather than the next launch.
  // The engine handle comes along because Rebuild is a recovery path:
  // it stops whatever is holding the index before deleting it, and
  // `cancelRun` is the only way to make a run let go. Without one — a
  // build with no engine — there are no runs for anything to collide
  // with, which is why the context takes it optional.
  const repositoryIntelligence: RepositoryIntelligenceContext = {
    root: repositoryIntelligenceRoot(platform.userDataPath),
    // The claim the supervisor's own dispatches take, for the reason
    // `itemLock` gives: an IPC path that starts a process in an item's
    // worktree takes that lock rather than keeping a second answer about
    // who has the checkout.
    itemLock,
    ...(engine ? { engine } : {}),
  };
  registerHandler(
    "repositoryIntelligence:initializeRepositoryIndex",
    (payload) => initializeRepositoryIndexCommand(db, repositoryIntelligence, payload),
    opts,
  );
  registerHandler(
    "repositoryIntelligence:syncRepositoryIndex",
    (payload) => syncRepositoryIndexCommand(db, repositoryIntelligence, payload),
    opts,
  );
  registerHandler(
    "repositoryIntelligence:rebuildRepositoryIndex",
    (payload) => rebuildRepositoryIndexCommand(db, repositoryIntelligence, payload),
    opts,
  );

  // The Types section of the configure screen (ARCHITECTURE.md, "An item type is data", KAN-164).
  // No push
  // of its own: the section owns the only screen that writes one, and
  // the registry the rest of the app reads is refetched by the renderer
  // on the same success — `registryForProject` reads the table on every
  // call, so main has nothing cached to invalidate.
  registerHandler("itemTypes:list", (payload) => listItemTypesCommand(db, payload), opts);
  registerHandler("itemTypes:create", (payload) => createItemTypeCommand(db, payload), opts);
  // Through the record (EO-735): a type on a project the organisation's
  // record holds is changed there, and copied here; any other, here.
  registerHandler("itemTypes:update", (payload) => (resources.record ?? recordFor(db)).updateItemType(payload), opts);
  registerHandler("itemTypes:delete", (payload) => deleteItemTypeCommand(db, payload), opts);

  registerHandler("guards:get", () => readGuards(db), opts);
  registerHandler("guards:set", (payload) => writeGuards(db, payload), opts);
  // What the run memory limit comes to here (EO-738): whether this
  // machine gives a run a systemd scope at all, and its default.
  registerHandler("guards:runMemory", () => runMemoryFacts(readGuards(db)), opts);
  registerHandler("repositories:list", () => listRepositoriesCommand(db, jira.credentials), opts);
  registerHandler(
    "repositories:create",
    async (payload) => {
      const result = await createRepositoryCommand(db, jira.credentials, payload);
      // The project, the worktree listing and the switcher can all change
      // at once when a repo is attached.
      if (result.ok) {
        emitPush("config:changed", {});
        emitPush("items:changed", {}); // adopted items appear on the project
      }
      return result;
    },
    opts,
  );
  registerHandler(
    "repositories:update",
    async (payload) => {
      const result = await updateRepositoryCommand(db, jira.credentials, payload);
      if (result.ok) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler(
    "repositories:remove",
    (payload) => {
      const result = removeRepositoryCommand(db, payload);
      if (result.ok) emitPush("config:changed", {});
      return result;
    },
    opts,
  );

  // Every kind of disk, where the four above are the one kind (EO-301).
  // The same pushes, because attaching any workspace changes the same
  // things: the project's list, the step picker, and — for a repository,
  // through the delegation — the items it adopted.
  registerHandler("workspaces:list", (payload) => listWorkspacesCommand(db, payload), opts);
  registerHandler(
    "workspaces:create",
    async (payload) => {
      const result = await createWorkspaceCommand(db, jira.credentials, payload);
      if (result.ok) {
        emitPush("config:changed", {});
        emitPush("items:changed", {});
      }
      return result;
    },
    opts,
  );
  registerHandler(
    "workspaces:update",
    async (payload) => {
      const result = await updateWorkspaceCommand(db, jira.credentials, payload);
      if (result.ok) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler(
    "workspaces:remove",
    (payload) => {
      const result = removeWorkspaceCommand(db, payload);
      if (result.ok) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  // KAN-17: which project the window shows. A view concept only — the
  // engine advances every repository regardless, exactly as it did when a
  // project *was* a repository.
  registerHandler("projects:list", (payload) => listProjectsCommand(db, payload), opts);
  // Keep it here, or move it to the record (EO-325, ARCHITECTURE.md, "What a person sees first").
  //
  // The machine half: what it decides is whether *this installation's*
  // existing work is handed to an organisation, which is a question
  // about the machine the work is on. The upload itself goes back out
  // over `record:adopt`, through the same client every other request to
  // the organisation uses.
  const keepOrMove: KeepOrMoveContext = {
    db,
    signedIn: () => resources.managed?.client() != null,
    personId: () => {
      const status = session === null ? SIGNED_OUT : sessionStatusCommand(session);
      return status.state === "signed-in" && status.personId !== "" ? (status.personId as Uuid) : null;
    },
    personName: () => {
      const status = session === null ? SIGNED_OUT : sessionStatusCommand(session);
      return status.state === "signed-in" ? status.personName : undefined;
    },
    // The files go up with everything else rather than behind it, so
    // this is the store they are read from — the same one every other
    // attachment in this installation lives in.
    files: attachmentStorage,
    send: async (request) => {
      const client = resources.managed?.client() ?? null;
      if (client === null) return { ok: false, problem: "EO is not signed in to an organisation." };
      const answer = await client.request("record:adopt", {
        // The record derives the owner from this, and from nothing the
        // client could choose — see `serveAdopt` (EO-325).
        deviceId: resources.session === undefined ? LOCAL_DEVICE_ID : deviceIdentity(resources.session),
        project: request.project,
        keyNextValue: request.keyNextValue,
        final: request.final,
        abandon: request.abandon,
        page: request.page,
      });
      if (!answer.ok) return { ok: false, problem: answer.error.message };
      if (answer.data.problem !== null) return { ok: false, problem: answer.data.problem };
      return { ok: true, accepted: answer.data.accepted };
    },
  };
  registerHandler("projects:undecided", () => undecidedProjectsCommand(keepOrMove), opts);
  registerHandler(
    "projects:keepLocal",
    (payload) => {
      const result = keepProjectLocalCommand(keepOrMove, payload);
      emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler(
    "projects:moveToRecord",
    async (payload) => {
      const result = await moveProjectToRecordCommand(keepOrMove, payload);
      // A project changing hands is every screen's business: the
      // switcher regroups, the board is drawn against a record
      // somewhere else, and the sync line has a queue of files behind
      // it now.
      emitPush("config:changed", {});
      emitPush("items:changed", {});
      return result;
    },
    opts,
  );
  // Spelled out rather than looped: reachable.test.ts reads this file
  // statically to prove every channel has a handler, and a loop hides
  // them from it. The guard is worth more than the four saved lines.
  // Created here and handed to the organisation at once when this
  // machine has one (EO-325) — the same `record:adopt` the keep-or-move
  // sheet uses, because there is one way for a project to reach the
  // record and this is it.
  registerHandler("projects:create", async (payload) => announce(await createProjectCommand(db, payload, keepOrMove)), opts);
  registerHandler("projects:update", (payload) => announce(updateProjectCommand(db, payload)), opts);
  registerHandler("projects:addProject", (payload) => announce(addRepositoryToProjectCommand(db, payload)), opts);
  registerHandler("projects:removeProject", (payload) => announce(removeRepositoryFromProjectCommand(db, payload)), opts);
  // EO-346. Only a confirmed call writes anything; an unconfirmed one
  // is the question the dialog asks, and announcing it would refetch
  // every screen for nothing.
  registerHandler(
    "projects:delete",
    async (payload) => {
      const result = await deleteProjectCommand(db, engine, payload, attachmentStorage);
      if (result.deleted) {
        // The switcher, the board, the repositories screen (a workspace
        // just lost its project) and the worktrees screen all changed.
        emitPush("config:changed", {});
        emitPush("items:changed", {});
      }
      return result;
    },
    opts,
  );
  // EO-347. As with a delete, only a confirmed archive changes anything,
  // and only a change is announced: the switcher loses or regains the
  // project, the board and the Inbox lose or regain its tickets.
  registerHandler(
    "projects:archive",
    (payload) => {
      const result = archiveProjectCommand(db, engine, payload);
      if (result.archived) {
        emitPush("config:changed", {});
        emitPush("items:changed", {});
      }
      return result;
    },
    opts,
  );
  registerHandler(
    "projects:restore",
    (payload) => {
      const result = restoreProjectCommand(db, engine, payload);
      if (result.restored) {
        emitPush("config:changed", {});
        emitPush("items:changed", {});
      }
      return result;
    },
    opts,
  );
  registerHandler(
    "projects:setActive",
    (payload) => {
      const result = setActiveProjectCommand(db, payload);
      emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler(
    "jira:connect",
    async (payload) => {
      const result = await connectJira(db, jira, payload);
      if (result.ok) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler(
    "jira:disconnect",
    (payload) => {
      const result = disconnectJira(db, jira, payload);
      if (result.ok) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler("jira:test", (payload) => testJira(db, jira, payload), opts);
  // KAN-22: sites are their own thing, shared by the repositories that
  // mirror to them.
  registerHandler("jiraConnections:list", () => listJiraConnectionsCommand(db, jira.credentials), opts);
  registerHandler("jiraConnections:save", async (payload) => announce(await saveJiraConnection(db, jira, payload)), opts);
  registerHandler("jiraConnections:remove", (payload) => announce(removeJiraConnection(db, jira, payload)), opts);
  registerHandler("forge:detect", (payload) => detectForge(db, payload), opts);
  registerHandler("jira:search", (payload) => searchJira(db, jira, payload), opts);
  registerHandler("jira:statuses", (payload) => jiraStatuses(db, jira, payload), opts);
  registerHandler("jira:outbox", (payload) => jiraOutboxView(db, payload), opts);
  registerHandler(
    "jira:saveTransitionFields",
    (payload) => {
      const result = saveJiraTransitionFields(db, payload);
      if (result.ok) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler(
    "jira:saveStatusMap",
    (payload) => {
      const result = saveJiraStatusMap(db, payload);
      if (result.ok) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler("jira:preview", (payload) => previewJiraIssue(db, jira, payload), opts);
  registerHandler(
    "jira:import",
    async (payload) => {
      const result = await importJiraIssue(db, jira, engine, payload, attachmentStorage);
      if (result.itemId) emitPush("items:changed", { itemId: result.itemId });
      return result;
    },
    opts,
  );
  registerHandler("jira:fields", (payload) => jiraFields(db, jira, payload), opts);
  registerHandler(
    "jira:saveConfig",
    (payload) => {
      const result = saveJiraConfig(db, payload);
      if (result.ok) emitPush("config:changed", {});
      return result;
    },
    opts,
  );

  registerHandler("worktrees:list", (payload) => listWorktreesCommand(db, payload), opts);
  registerHandler(
    "worktrees:release",
    async (payload) => {
      const result = await releaseWorktreeCommand(db, payload);
      // Only the listing changed, and only the screen showing it cares.
      if (result.released) emitPush("config:changed", {});
      return result;
    },
    opts,
  );
  registerHandler("runtime:setAutomaticUpdates", (payload) => setRuntimeAutomaticUpdates(runtimes, payload), opts);
  registerHandler(
    "runtime:setEnabled",
    (payload) => {
      const result = setRuntimeEnabled(runtimes, payload);
      if (result.ok) {
        emitPush("config:changed", {});
        engine?.notifyStateChange();
      }
      return result;
    },
    opts,
  );
  registerHandler(
    "runtime:remove",
    (payload) => {
      const result = removeManagedRuntime(runtimes, payload);
      // Told even on a refusal: `removeManagedRuntime` pushes its own
      // change when a removal fails part-way, and this is the success
      // half — every window's runtime status just went stale, and the
      // engine's resolved-path cache with it.
      if (result.ok) {
        emitPush("config:changed", {});
        engine?.notifyStateChange();
      }
      return result;
    },
    opts,
  );
}

/**
 * What Settings is told when this build has no MCP server at all.
 *
 * A refusal shaped like a status, rather than a thrown error: the screen
 * renders the same way and simply cannot be switched on, which is more
 * use than an empty panel and a console message.
 */
function unavailableMcpStatus(): IpcResponse<"mcp:getStatus"> {
  return {
    enabled: false,
    dangerousOperations: false,
    // The default rather than 0: the schema's floor is 1024, and a
    // response that fails its own contract is a thrown programmer error
    // rather than the graceful degradation this function is for.
    port: DEFAULT_PORT,
    listeningPort: null,
    token: null,
    problem: "This build has no MCP server.",
    toolCount: 0,
  };
}

/**
 * The project an import lands in: exactly the one a caller named in
 * `into`, `null` included, and the active project when it named none
 * (EO-521). One reading for `pipelines:importPreflight` and
 * `pipelines:import`, so a check and the import it describes cannot be
 * about two different projects.
 */
function importDestination(db: Db, into: { projectId: string | null } | undefined): Uuid | null {
  return into === undefined ? activeProjectId(db) : (into.projectId as Uuid | null);
}
