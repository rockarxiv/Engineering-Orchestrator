import { homedir } from "node:os";
import { startAgentWriteBridge, type AgentWriteBridge } from "./mcp/writeBridge.js";
import { join } from "node:path";
import { aliasNotice, aliasRetirementReached, type JobRunsOn } from "@eo/core";
import { announceSweep, startArchiveSweep } from "./archive/schedule.js";
import { startMessageSweep } from "./messages/messages.js";
import { onPush } from "./ipc/push.js";
import { AttachmentStorage } from "./attachments/storage.js";
import { getSchemaVersion, isNewDatabase, openDb, runMigrations } from "./db/index.js";
import { syncItemTypes } from "./db/repos/index.js";
import { migrateCarriedSchemas } from "./actionDefinitionAdoption.js";
import { loadTemplateHistory } from "./gallery/history.js";
import { backfillPipelineOrigins } from "./gallery/origins.js";
import { applyTemplateUpdates } from "./gallery/templateUpdates.js";
import { codexHomeRootsOf, createEngine, sweepUnusedCodexHomes } from "./engine.js";
import { installTrialLoop } from "./trials/loop.js";
import { createDeviceDirectory } from "./identity/callers.js";
import { createManagedDirectory } from "./managed/directory.js";
import { deviceIdentity, markRevoked, readSecretsKey, readToken, sessionStatus } from "./managed/session.js";
import { createPushClient } from "./managed/pushClient.js";
import { createDeviceRecord } from "./record/deviceRecord.js";
import { organisationSecretValues } from "./policy/organisationSecrets.js";
import { forgetOrganisationState } from "./policy/forget.js";
import { createPolicySync } from "./policy/sync.js";
import { persistEnginePause } from "./engineActivity.js";
import { settleDailyBudgetNotice } from "./guardDefaultNotice.js";
import { emitPush, registerAllHandlers, type Platform } from "./ipc/index.js";
import { startManagedRuntimeReconciliation } from "./ipc/runtimeCommands.js";
import { createInstallRequest, quitOrInstall } from "./ipc/updateCommands.js";
import { assistDeltaView } from "./ipc/assistCommands.js";
import { watchAssistDeltas } from "./ipc/assistDeltas.js";
import { startJobScheduler } from "./jobs/scheduler.js";
import { receiveWebhook, webhookAnswerWord } from "./jobs/webhook.js";
import { createAdminMcpHost } from "./mcpHost/admin.js";
import { approvedModuleTestWriteRefusal } from "./roles/assist.js";
import { recordScenarioApprovalWithdrawal, scenarioModuleWriteRefusal } from "./roles/scenario.js";
import { createMcpHost } from "./mcpHost/index.js";
import { createInboxNotifier, notificationFor, notificationForJobGuard, notificationForMessage, shouldInterrupt } from "./notifications.js";
import { startOutboxDrain } from "./outbox/drainLoop.js";
import { retireForgeQueue } from "./outbox/retireForgeQueue.js";
import { retireConversationRooms } from "./ipc/retireConversationRooms.js";
import { developerPack } from "./packs/developer/index.js";
import { hasToken, rekeyJiraTokens } from "./packs/developer/jira/credentials.js";
import { forgetLegacyJiraTokenOwners, legacyJiraTokenOwners } from "./packs/developer/jira/legacyTokenOwners.js";
import { startJiraPull } from "./packs/developer/jira/pullSchedule.js";
import { createJiraSender } from "./packs/developer/jira/sender.js";
import { repositoryIntelligenceRoot } from "./packs/developer/repositoryIntelligence/index.js";
import { checkGitAvailable } from "./packs/developer/workspace/index.js";
import { itemTypeContributions } from "./packs/pack.js";
import { preflightPackPrompts, promptReader } from "./packs/promptPreflight.js";
import { syncRolePrompts, usePromptsDir } from "./roles/prompts.js";
import { resolveSearchPath } from "./process/searchPath.js";
import { runtimeRoot } from "./runtimes/install.js";
import { createShutdownCoordinator, type ShutdownChoice } from "./shutdownCoordinator.js";
import { startDeferredAutoUpdate } from "./updater.js";

/**
 * What `startMain` hands back to whoever started it.
 *
 * There is exactly one member, and it exists for the reason phase 7a
 * exists: a caller that is not Electron has to be able to bring the
 * process down again. The desktop never calls it — the shutdown
 * coordinator inside owns every path out of an Electron process, and
 * `platform.quit()` is the last thing it does — but a test, and a
 * server binary asked to stop, need the same work done without an
 * `app.quit()` on the end of it.
 */
export interface RunningMain {
  /**
   * Stops everything this call started: the schedulers, the MCP
   * listeners, the update timer and the engine, in that order. Does not
   * end the process, and deliberately does not close the database.
   *
   * The database outlives it because the supervisor's stale-worktree
   * sweep is unawaited on purpose — releasing a directory is not
   * something the first tick may wait behind (runSupervisor.ts) — so
   * there is no moment this function can prove nothing will read a table
   * again. A closed handle would turn that into "The database connection
   * is not open" thrown from a sweep nobody is holding. The process
   * exiting is what closes it, which is what has always closed it.
   */
  stop(): Promise<void>;
}

/**
 * EO's main process, composed out of nothing but a `Platform`
 * (EO-318, `ARCHITECTURE.md`, "The server").
 *
 * This is the body index.ts used to hold, with every Electron call in it
 * replaced by a member of the interface. The value of the move is
 * exactly the acceptance criterion it was written to: this file can be
 * imported and run under plain Node, with a fake machine, and it serves
 * a real request over `dispatchIpc` — which is what a server binary will
 * do with the record half of the contract in the next story
 * (`ARCHITECTURE.md`, "The server").
 *
 * The order below is load-bearing and is the order it has always been
 * in. Migrations before anything reads a table; the registry filled
 * before `serveIpc` hangs a door on it; the door before
 * `openUserInterface`, because a renderer invokes IPC the moment it
 * loads. And after the window, the housekeeping no screen's first read
 * depends on (EO-566), so it does not delay the first paint.
 */
export function startMain(platform: Platform): RunningMain {
  const resources = platform.resources;
  // Set once, before anything reads a prompt: every reader — the startup
  // sync, and the Agents screen offering the default — has to resolve the
  // same directory, and in a packaged build it is not the source tree.
  usePromptsDir(resources.prompts);

  // EO-655: ask the person's login shell for its PATH, so the tools EO
  // runs for them — `gh`, `glab`, a module's binaries — are found where
  // their terminal finds them. In the background and under a time limit:
  // startup never waits, and until it answers everything searches the
  // inherited PATH plus the fixed folders.
  void resolveSearchPath();

  const userDataPath = platform.userDataPath;
  console.log(`[eo] userData path: ${userDataPath}`);

  const dbPath = join(userDataPath, "eo.db");
  const dbHandle = openDb(dbPath);
  const { db } = dbHandle;

  // Asked before the migrations and answered after them, because this
  // is the only moment a database EO is creating can be told from one
  // it is upgrading (EO-211). A default guard applied to an
  // installation that ran without one is news; the same default on a
  // database being born with it is not.
  const newInstallation = isNewDatabase(db);

  try {
    runMigrations(db, resources.migrations);
  } catch (error) {
    console.error("[eo] migration failed, refusing to start:", error);
    platform.showErrorBox(
      "EO failed to start",
      "A database migration failed. EO will not start with a " + `partially migrated database.\n\n${String(error)}`,
    );
    platform.exit(1);
    // Reached only where `exit` does not end the process — a fake
    // machine in a test. The handle is closed rather than leaked, and
    // the caller gets a `stop` that has nothing left to do.
    dbHandle.close();
    return { stop: () => Promise.resolve() };
  }

  // Immediately after the migrations, because `app_settings` does not
  // exist until they have run. Nothing said here, ever — this is the
  // installation writing down that it was born under the ceiling, so
  // the first tick has nothing to announce.
  if (newInstallation) settleDailyBudgetNotice(db);

  // KAN-22: tokens are files, so migration 0017 could not move them
  // from the repositories that held them to the connections that now do.
  // Idempotent and skipped entirely once done, so it costs a few
  // statements on every launch and saves everyone re-entering a
  // credential they already gave us.
  //
  // The pairing comes from what 0072 wrote down, not from the
  // bindings. A token file is named after the repository that held it,
  // and a workspace keeps the id its repository had (KAN-130) — but
  // which *connection* that repository's token was for is no longer in
  // the schema to be read, since a project keeps one binding and the
  // rest of the `jira_connection_id` values went with the table. A
  // project whose repositories used two Jira accounts would otherwise
  // have the first one's token moved onto the survivor's connection
  // and the correct one deleted behind it.
  const credentials = { directory: join(userDataPath, "credentials"), store: platform.keychain };
  const legacyOwners = legacyJiraTokenOwners(db);
  const rekeyed = rekeyJiraTokens(credentials, legacyOwners);
  if (rekeyed > 0) console.log(`[eo] moved ${rekeyed} Jira token(s) onto their connections`);

  // Forgotten only once none of them has a file left. A pass that
  // could not store one — the keychain unavailable — keeps the record
  // so the next launch can finish, since nothing else knows the
  // pairing any more.
  if (legacyOwners.length > 0 && legacyOwners.every((owner) => !hasToken(credentials, owner.repositoryId))) {
    forgetLegacyJiraTokenOwners(db);
  }

  const { migrationsApplied, latestMigrationAt } = getSchemaVersion(db);
  const latest = latestMigrationAt ? new Date(latestMigrationAt).toISOString() : "n/a";
  console.log(`[eo] schema version: ${migrationsApplied} migration(s) applied, latest at ${latest}`);

  // G-01: verify git at startup. Every worktree operation needs it, so
  // one clear line at boot beats an opaque ENOENT on the first
  // dispatch. Not fatal — EO is still usable for intake and refinement
  // without a workspace.
  void checkGitAvailable().then((result) => {
    console.log(result.ok ? `[eo] ${result.stdout}` : `[eo] ${result.error}`);
  });

  // R-01: every prompt EO wrote is brought up to the version this build
  // ships. Anything a human edited is left exactly as they left it
  // (U-06) and reported, since the Agents screen offers it there.
  const { updated, customised } = syncRolePrompts(db);
  if (updated.length > 0) console.log(`[eo] updated default prompts for: ${updated.join(", ")}`);
  if (customised.length > 0)
    console.log(`[eo] kept your edited prompt for: ${customised.join(", ")} (a newer default ships with this build)`);

  // The engine itself. start() reconciles anything a previous process
  // left mid-run before it dispatches anything new (E-04).
  // U-04: the badge and notifications follow the inbox. Created before
  // the engine so it can be driven by engine changes rather than
  // polled — the engine already knows when a mention appeared.
  const notifier = createInboxNotifier(db, {
    // What it says is notifications.ts's (the file about when somebody
    // is interrupted); showing it is the platform's (KAN-127). Composed
    // here, which is the one place that has both.
    notify: (item) =>
      platform.notify({
        ...notificationFor(item),
        onClick: () => {
          platform.showWindow();
          // Through `emitPush` like every other push. This was a bare
          // `webContents.send` on a channel that was not in the contract
          // and that nothing subscribed to, so clicking a notification
          // raised the window and then did nothing at all.
          emitPush("navigate", { to: `/items/${item.itemId}` });
        },
      }),
    // A message from EO (EO-725) has no item: clicking it opens the Inbox.
    notifyMessage: (message) =>
      platform.notify({
        ...notificationForMessage(message),
        onClick: () => {
          platform.showWindow();
          emitPush("navigate", { to: "/inbox" });
        },
      }),
    // The dock or taskbar count, the platform's since EO-318 for the
    // same reason the toast above is.
    setBadge: (count) => platform.setBadgeCount(count),
  });
  // A message sent, answered, dismissed or swept changes the badge, and a
  // new one notifies; no item changed, so the engine's hook above does not
  // hear it.
  onPush("messages:changed", () => notifier.scheduleRefresh());

  const managedRuntimeRoot = runtimeRoot(userDataPath);
  startManagedRuntimeReconciliation({
    root: managedRuntimeRoot,
    fetchImpl: (url, init) => fetch(url, init),
    db,
    onChanged: () => emitPush("config:changed", {}),
  });

  // EO-182: EO's own administrative MCP server — the whole mcpHost
  // catalogue, ungated, on a loopback port, for the system agent.
  //
  // Built here rather than beside its start below for the same reason
  // its neighbour is, plus one of its own: the engine is constructed
  // on the next line and has to close over `endpoint`, while the
  // socket cannot be bound until `registerAllHandlers` has filled the
  // registry it dispatches through. Construction starts nothing, so
  // the closure simply answers null until it does.
  // A scenario chat never changes its module itself (EO-356): while one
  // is running, this server refuses to save, approve or archive that
  // module before anything is written.
  let agentWriteBridge: AgentWriteBridge | null = null;
  // And in the help chat, an approved module's test cases are changed on
  // a card the person applies (EO-499): `module_test_save` and
  // `module_test_delete` are refused on one unless its scenario chat is
  // the turn running. When that turn's case write withdraws the approval,
  // EO records it against the turn from the call's own answer, so the
  // scenario chat can say so under the reply (EO-501).
  const adminMcpHost = createAdminMcpHost({
    db,
    version: platform.version,
    refuseCall: (tool, args) => scenarioModuleWriteRefusal(db, tool, args) ?? approvedModuleTestWriteRefusal(db, tool, args),
    observeCall: (tool, args, data) => recordScenarioApprovalWithdrawal(db, tool, args, data),
  });

  // One store, built before the record and the engine because both
  // write into it: the files a run produced are copied here and
  // attached to the item's output (EO-299), and a file that arrives
  // from another desktop lands here too (EO-324). The Jira pull below
  // is handed the same instance — two would be two views of one
  // directory, which is a thing to avoid rather than a thing that
  // happens to work.
  const attachmentStorage = new AttachmentStorage(join(userDataPath, "attachments"));

  // EO-526: Discussions and the Architecture panel are gone, and so are
  // their conversations. As soon as there is somewhere to remove their
  // files from, and long before the engine starts: every row is deleted
  // by the time this call returns, so nothing can reconcile or dispatch
  // against one, and only the files are left to go in the background. On
  // the organisation server as well, which starts here too.
  void retireConversationRooms(db, attachmentStorage).then(
    (count) => {
      if (count > 0) console.log(`[eo] deleted ${count} conversation(s) from Discussions and the Architecture panel, which no longer exist`);
    },
    (error: unknown) => console.error("[eo] could not finish deleting the conversations Discussions and the Architecture panel left behind:", error),
  );

  // This machine's sign-in to an organisation server, if it has one
  // (EO-323). Its own directory under `userData`, beside the other
  // secret stores and for the same reason: clearing one kind of secret
  // must not be able to disturb another.
  //
  // Built before the engine since EO-324, because the engine needs the
  // record and *which* record this is depends on the sign-in.
  const session = { db, directory: join(platform.userDataPath, "managed"), store: platform.keychain };
  // Where the organisation's named values live on this machine (EO-328,
  // ARCHITECTURE.md, "Secrets"). Built here because three things need the same one: the engine
  // spends them, the IPC handlers list their names, and — on a server —
  // the door hands them to the devices that asked.
  const organisationSecrets = { directory: join(userDataPath, "organisation-secrets"), store: platform.keychain };
  /**
   * What this machine does when it learns it was turned out (EO-323,
   * EO-328).
   *
   * Two things, and the second was missing. It **announces**, because a
   * revocation is a state change nobody asked for: every open window is
   * rendering a signed-in session and nothing else would tell them
   * otherwise. And it **forgets what the organisation gave it** — the
   * secret values and the cached policy — because a revoked desktop that
   * kept them would go on injecting somebody else's credentials into
   * every module it ran for the projects it still schedules, and go on
   * enforcing an allowed-backends list from a record it no longer
   * belongs to (review).
   *
   * One function, passed to both seams that can learn it: the ordinary
   * request client's `onRevoked` and the push stream's `onSignedOut`.
   * Either can be the first to meet the 401, and `markRevoked` answers
   * whether the transition was this one — so this runs once per
   * revocation however many requests were in flight when the admin
   * pressed the button.
   */
  const turnedOut = (): void => {
    forgetOrganisationState(db, organisationSecrets);
    emitPush("config:changed", {});
  };
  const managed = createManagedDirectory(session, { onRevoked: turnedOut });

  /**
   * The record this desktop talks to (EO-324, ARCHITECTURE.md, "The record").
   *
   * One object for both topologies, because that is the whole claim of
   * this phase: solo mode is this process being its own record with a
   * local lease, and managed mode is the same interface with a network
   * in the middle. Nothing downstream — the supervisor, the IPC
   * commands behind a drag — asks which it has.
   *
   * The sign-in is read per call rather than captured, so signing in
   * and out takes effect on the next tick rather than on the next
   * launch. That matters more than it sounds: a signed-in desktop still
   * scheduling locally is invariant #1 broken, and a relaunch is not
   * something a person knows they owe.
   */
  const record = createDeviceRecord({
    db,
    // A server *is* the record; a desktop has one elsewhere. Not
    // inferable from the transport, which is null in both cases for
    // opposite reasons — see `DeviceRecordOptions.isTheRecord`.
    isTheRecord: !platform.hasMachine,
    transport: () => managed.client(),
    deviceId: () => deviceIdentity(session),
    // Where a file this desktop posts is read from on its way to the
    // record, and where one from another desktop is written (EO-324,
    // `ARCHITECTURE.md`, "The record": attachments sync because they are
    // comments). The same store every other attachment lives in.
    attachments: attachmentStorage,
    // Both halves of what a sync changes are things an open screen is
    // already showing: the board (an item that moved on the record) and
    // the sync line itself (how long this machine has been out of touch,
    // and how much is queued behind it).
    onSyncChange: () => {
      emitPush("items:changed", {});
      emitPush("config:changed", {});
    },
    // A transcript hears this rather than either of those, and a run
    // going on another machine reaches it by no other way.
    onRunEvents: (runId) => emitPush("runs:progress", { runId }),
    // …and the organisation's policy, taken on the same tick (EO-328,
    // ARCHITECTURE.md, "Policy"). Rate-limited on its own terms — see `createPolicySync` —
    // because the engine ticks far more often than an admin publishes.
    policySync: createPolicySync({
      db,
      client: () => managed.client(),
      secrets: organisationSecrets,
      // The secrets key, never the device token (EO-328, ARCHITECTURE.md, "Secrets"): the
      // token is what a renderer holds, and the route deliberately
      // refuses it.
      secretsKey: () => readSecretsKey(session),
      // Where a publish this machine could not take is said out loud.
      // `readAttachmentEnv`'s precedent: the log is the right place for
      // a fact about the installation rather than about somebody's work.
      onProblem: (line) => console.warn(`[eo] ${line}`),
    }),
  });

  const demoProviderDelayMs = Number.parseInt(process.env["EO_E2E_AGENT_DELAY_MS"] ?? "", 10);
  // What this installation is *about*, as a value (KAN-144). The
  // engine takes whatever packs it is given and folds them into the
  // supervisor's options; naming the developer one here rather than
  // letting `createEngine` assume it is what makes the choice a line
  // somebody can read, and what a second pack will be added to.
  const engineOptions = {
    db,
    dbPath,
    onWake: (listener: () => void) => platform.onWake(listener),
    isOnline: () => platform.isOnline(),
    sleeps: platform.sleeps,
    eoMcpServerPath: resources.eoMcpServer,
    mcpServerSupervisorPath: resources.mcpServerSupervisor,
    codexSearchHookCommandPath: resources.codexSearchHookCommand,
    moduleHostPath: resources.moduleHost,
    // Beside the Jira token, under the same keychain and the same rule:
    // secrets go to the OS keychain and never into SQLite (ARCHITECTURE.md, "Secrets").
    moduleSecrets: { directory: join(userDataPath, "module-secrets"), store: platform.keychain },
    // EO-328: and what the organisation published, which wins over both
    // of the person's own. Filled by `policy/sync.ts` from the record
    // rather than by anybody typing into a field, and its own directory
    // so that signing out can forget all of these and none of theirs.
    organisationSecrets,
    // EO-84: the Claude API key, if there is one. Read at each spawn
    // and injected as ANTHROPIC_API_KEY — the same keychain, the same
    // directory as the Jira tokens, and never the database.
    apiKeys: { directory: join(userDataPath, "credentials"), store: platform.keychain },
    // EO-104: the values behind the variable names an attached MCP
    // server declares, spent by both providers. The same directory the
    // Servers screen writes into — a second one would have the screen
    // say a value is set while the dispatch found none. Read at spawn
    // and put in the CLI's environment: never on its command line and
    // never in the generated files.
    mcpServerSecrets: { directory: join(userDataPath, "mcp-server-secrets"), store: platform.keychain },
    // And where those generated files go (EO-107). Under `userData`
    // rather than in the item's checkout, which `verify.ts` requires
    // to be clean before anything merges.
    toolDirectoryRoot: join(userDataPath, "agent-tools"),
    // EO-378: and where each locked-down Codex agent's own Codex home
    // goes — its sign-in and saved conversations linked in from the
    // person's, and nothing else of theirs.
    codexHomeRoot: join(userDataPath, "codex-homes"),
    // And where one goes instead when that folder is on a different
    // drive from the person's Codex home, which on Windows a hard link
    // to their sign-in cannot cross: EO's folder in their profile.
    codexHomeAlternateRoot: join(homedir(), ".eo", "codex-homes"),
    // And where EO's own administrative server is, for the one agent
    // whose allowlist names it (EO-182). Asked per dispatch: this is
    // null until the socket below is bound.
    adminMcp: () => adminMcpHost.endpoint(),
    // EO-543: where the `eo` server hands every write an agent asks for,
    // so the tool answers with what EO actually wrote. Null until the
    // socket below is bound.
    agentWriteBridge: () => agentWriteBridge,
    // A-08: fetched agent CLIs live beside the app's other state, not
    // inside the bundle, which on macOS is signed and read-only.
    runtimeRoot: managedRuntimeRoot,
    // EO-149: and where the fetched index binary goes. Beside the
    // runtimes rather than inside them — it is not an agent runtime,
    // and it must not appear in that settings screen.
    repositoryIntelligenceRoot: repositoryIntelligenceRoot(userDataPath),
    // Where the files a run produced are kept (EO-299): the same
    // managed store every other attachment goes into, so a report
    // drafted on a folder workspace is a file on the item like any
    // other rather than a second kind of thing with its own lifetime.
    artifactStore: attachmentStorage,
    // Coalesced (EO-557): a burst of changes reads the inbox once a window.
    onDomainChange: () => notifier.scheduleRefresh(),
    // The record, and which device this machine is on it (EO-324).
    // Shared with the IPC commands rather than a second one: a person
    // dragging a card and an agent finishing a run are talking to the
    // same record.
    record,
    deviceId: () => deviceIdentity(session),
    // …and whether this process is a device at all (EO-324, ARCHITECTURE.md, "The record"), and
    // which kind of one (EO-330, ARCHITECTURE.md, "Where a job runs").
    //
    // Both processes run a device loop now. A server is still the
    // record — it schedules, it leases, and almost all of the work
    // happens on the desktops that ask it for some — but placement gave
    // it work of its own: a job a person deliberately put on the
    // organisation server, checked when they put it there against
    // everything the pipeline needs. A server that ran no device loop
    // would file those items every morning and leave them standing.
    //
    // What stops it contending for a desktop's work is not this flag
    // but `runsWhere`: the record offers a server only server-placed
    // items, so the loop below is never handed a dispatch that needs
    // somebody's login or somebody's disk.
    dispatches: true,
    runsWhere: (platform.hasMachine ? "device" : "server") as JobRunsOn,
    ...(Number.isFinite(demoProviderDelayMs) && demoProviderDelayMs > 0 ? { demoProviderDelayMs } : {}),
  };
  const packs = [developerPack(engineOptions)];
  const engine = createEngine(engineOptions, packs);

  // KAN-129: every installed pack's item types, on first run and on
  // upgrade — the same bargain `syncRolePrompts` makes above. After
  // the fold, so two packs claiming one slug are refused before either
  // is written, and before `start()`, so nothing dispatches against a
  // project whose types have not arrived yet.
  const seeded = syncItemTypes(db, itemTypeContributions(packs));
  if (seeded.created.length > 0) console.log(`[eo] seeded item types: ${[...new Set(seeded.created)].join(", ")}`);

  // EO-421: the output schemas a role's agent used to carry in its
  // config become that role's action definitions. After the fold for the
  // reason above and one more — which entries are a pack's own role
  // restating its own shipped action depends on the fold — and before `start()`, so
  // no dispatch is resolved against a role whose definitions have not
  // been written yet.
  const adopted = migrateCarriedSchemas(db);

  // EO-531: pipelines that predate template origins get one, once, by
  // matching their step ids against the template versions the app ships.
  // On a new installation this is what gives the seeded Delivery its
  // origin. Before `start()`, for no stronger reason than that nothing
  // after it should see a pipeline half-way through being given one.
  const templateHistory = loadTemplateHistory(resources.gallery);
  const backfilled = backfillPipelineOrigins(db, templateHistory);
  for (const origin of backfilled.recorded) console.log(`[eo] pipeline ${origin.pipelineId} comes from template ${origin.slug} ${origin.version}`);

  // EO-532: and each pipeline whose template has shipped a newer version
  // than its base is compared three ways and, where nothing conflicts,
  // updated as a new version — the way template changes reach installed
  // pipelines now, instead of a guarded migration. After the backfill, so
  // a pipeline given its origin this launch is compared this launch.
  // A desktop leaves alone what it follows from its organisation's
  // record; the record compares those itself, running this same line.
  for (const update of applyTemplateUpdates(db, templateHistory, { isTheRecord: !platform.hasMachine })) {
    const what =
      update.outcome === "applied"
        ? `updated as v${update.version}`
        : update.outcome === "caught-up"
          ? "already had every change"
          : update.outcome === "deferred"
            ? `left for the next launch: ${update.reason}`
            : "held: it conflicts";
    console.log(`[eo] pipeline ${update.pipelineId}: template ${update.slug} ${update.from} → ${update.to}, ${what}`);
  }
  const named = (entries: readonly { role: string; action: string }[]): string => entries.map(({ role, action }) => `${role}/${action}`).join(", ");
  if (adopted.defined.length > 0) console.log(`[eo] action definitions written from agent config: ${named(adopted.defined)}`);
  for (const refused of adopted.refused) {
    console.warn(`[eo] could not turn the ${refused.role} role's "${refused.action}" schema into an action definition, so it is left in the agent's config and is not in force: ${refused.problems.join(" ")}`);
  }

  /**
   * And this desktop listening to its organisation's record (EO-324,
   * ARCHITECTURE.md, "The record", "The server").
   *
   * The inbound half. Without it everything this machine does reaches
   * the record within a tick and nothing the record has reaches this
   * machine until its own tick comes round — so a colleague's move
   * appeared here five seconds late at best, and the first acceptance
   * criterion's *"a move on one appears on the other"* was true only in
   * the way a clock is right twice a day.
   *
   * A push carries no data (`ipcPushContract`), so the whole of what it
   * does with one is sync: the same sync the tick does, which is what
   * keeps a pushed change and a polled one from being two paths that
   * could disagree.
   *
   * Inert on a solo desktop: `session()` answers null, and the loop
   * waits rather than ends — somebody may sign in without relaunching.
   */
  const pushes = createPushClient({
    session: () => {
      const status = sessionStatus(session);
      if (status.state !== "signed-in") return null;
      const token = readToken(session);
      return token === null ? null : { address: status.address, token };
    },
    onChanged: async () => {
      // `published`, not a poll (EO-328, review). A push is the record
      // saying *this changed*, and the policy sync's rate limit — which
      // is there to stop a laptop asking for a list of credentials every
      // few seconds — was swallowing it. An admin who disallowed a
      // backend then watched this device go on dispatching to it for up
      // to a minute, and the acceptance criterion is that it *cannot*
      // dispatch rather than that it stops shortly.
      //
      // Awaited before the tick below, so the dispatch that follows
      // reads the policy that has just arrived rather than the one it
      // replaced.
      await record.sync("published");
      // And the tick, because what arrived may be work: an item the
      // record has just moved onto a step this machine staffs is a
      // dispatch that should not wait for the interval.
      engine.notifyStateChange();
    },
    onSignedOut: () => {
      // The push stream's own path to the same fact, and the same
      // answer to it — see `turnedOut`. A device can be revoked while
      // it is holding a stream open and making no requests at all.
      if (markRevoked(session)) turnedOut();
    },
  });

  engine.start();
  console.log("[eo] engine started");

  // J-04: whatever the outbox is still holding, including anything a
  // previous process queued and never got to send.
  const jiraContext = { credentials: { directory: join(userDataPath, "credentials"), store: platform.keychain } };
  // The interval is settable so an end-to-end test does not have to
  // wait out twenty seconds to watch one push land. Nothing else
  // reads it, and the default is what ships.
  // Before the drain, not after: a queue must not be half in the old
  // world and half in the new one while something is reading it.
  const retired = retireForgeQueue(db);
  if (retired > 0) console.log(`[eo] retired ${retired} pull request(s) the old forge queue was still holding`);

  const drainInterval = Number.parseInt(process.env["EO_OUTBOX_INTERVAL_MS"] ?? "", 10);
  const stopOutboxDrain = startOutboxDrain(
    db,
    { jira: createJiraSender(jiraContext, (itemId) => emitPush("items:changed", { itemId })) },
    Number.isFinite(drainInterval) && drainInterval > 0 ? drainInterval : undefined,
  );

  // KAN-33: finished work leaves the project on its own. At launch as
  // well as on the timer — a desktop app closed every evening would
  // otherwise never reach a daily tick.
  // `announceSweep` logs it and pushes `items:changed` (EO-384), so a
  // window open across the sweep stops counting what it put away.
  const stopArchiveSweep = startArchiveSweep(db, { onSwept: announceSweep });
  // EO-725: a handled message is deleted 7 days after it was handled, and
  // nobody keeps more than 100 handled ones. Open ones are never touched.
  const stopMessageSweep = startMessageSweep(db);

  // EO-304's loop, now that EO-306 has given it something to fire: a
  // `schedule` job's occurrences, caught up within their grace or
  // skipped out loud. At launch as well as every minute, which is what
  // makes a laptop opened at 09:10 file the 08:00 report within
  // seconds (ARCHITECTURE.md, "Schedules, and a machine that was off").
  const stopJobScheduler = startJobScheduler(db, {
    // Where a released webhook event's payload is kept (EO-332, ARCHITECTURE.md, "Webhooks").
    // The same instance everything else attaches through — two would be
    // two views of one directory.
    webhooks: { storage: attachmentStorage },
    // What it says is notifications.ts's and showing it is the
    // platform's, composed here — the same split `notify` above makes,
    // and for the same reason. Do Not Disturb silences the alert and
    // nothing else: the comment is on the thread and the mention is in
    // the inbox either way.
    notify: (guard) => {
      if (!shouldInterrupt(db)) return;
      platform.notify({
        ...notificationForJobGuard(guard),
        onClick: () => {
          platform.showWindow();
          emitPush("navigate", { to: `/items/${guard.itemId}` });
        },
      });
    },
  });

  // Jira, the other way round: comments and edits written there reach
  // the project without anyone asking. Reads only — status stays EO's.
  const stopJiraPull = startJiraPull(db, jiraContext, {
    attachmentStorage,
    onPulled: (result) => {
      if (result.comments > 0 || result.edits > 0 || result.attachments > 0) emitPush("items:changed", {});
    },
  });

  // A draft's test-fix loop (EO-586): a trial item ending, parking, failing
  // past its attempts or reaching a person's step wakes the assistant in
  // the conversation the trial came from, and a person's answer to a
  // guardrail stop is read. Hooked at the writes, so every path is.
  const stopTrialLoop = installTrialLoop(db, { engine, attachmentStorage });

  // The MCP server for external clients (Claude Code, Codex, Claude
  // Desktop). Built here rather than beside its start below, because
  // the shutdown coordinator closes over it and is registered on
  // `before-quit` before that point — constructing it later would put
  // a temporal-dead-zone reference in the one path that runs when the
  // app is already trying to exit.
  //
  // Building it starts nothing. It is off unless someone has turned it
  // on, and `reconcile` never throws: a busy port or a missing keychain
  // leaves it stopped with a reason, and the app carries on. Nothing in
  // EO calls through it, so there is no state where the app is degraded
  // because a socket did not open.
  const mcpTokens = { directory: join(userDataPath, "mcp"), store: platform.keychain };
  const mcpHost = createMcpHost({ db, version: platform.version, tokens: mcpTokens });

  // P-01: check for updates on a packaged build only. Failures are
  // logged, never fatal — the user's agents are mid-run.
  //
  // EO-201: and nothing is downloaded by it. The six-hourly check stays
  // — it is what lets the Updates section already know an update is
  // waiting the first time somebody opens it — but fetching a release
  // is now a decision somebody makes.
  //
  // Built here because both the shutdown coordinator below and the
  // update handlers close over it, and built *synchronously* so that
  // there is never a moment where an installed build has no answer:
  // the updater arrives through the platform's dynamic import, and
  // until it does `startDeferredAutoUpdate` stands in with an error.
  //
  // The same two variables electron-updater reads for itself, and in
  // the same order. Neither is needed — the release feed is public — and
  // electron-updater uses whichever is set without being told; it is
  // read here only so the startup log says which way the feed is read.
  const updateToken = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  const updates = startDeferredAutoUpdate({
    deps: {
      isPackaged: platform.isPackaged,
      ...(updateToken ? { token: updateToken } : {}),
      // EO-698: the Mac builds are ad-hoc signed and electron-updater
      // cannot install over them, so there EO checks and never downloads,
      // and the renderer sends the person to the release page. Decided
      // here and carried on the status, so the renderer never sniffs it.
      manual: process.platform === "darwin",
      // The one push that carries state rather than saying "ask again"
      // — see the argument beside `updates:progress` in the contract.
      // The updater's event stream is the only copy of a download's
      // progress there is.
      onProgress: (percent) => emitPush("updates:progress", { percent }),
      // And the one that does follow the rule. This is what reaches a
      // Settings section that was already open when the six-hourly
      // check answered.
      onStatusChange: () => emitPush("updates:changed", {}),
    },
    // Whatever this platform replaces itself with, if anything (EO-318).
    // The dynamic import of electron-updater that used to be written out
    // here is in platform/electron.ts, which is the only file left that
    // may name it.
    load: () => platform.loadAutoUpdater(),
    // The placeholder answered while the module loaded; whatever
    // replaced it is a different answer, and an open section should not
    // have to wait for a refetch to hear it.
    onReplaced: () => emitPush("updates:changed", {}),
  });

  const stopBackgroundServices = (): void => {
    stopOutboxDrain();
    stopArchiveSweep();
    stopMessageSweep();
    stopJobScheduler();
    stopJiraPull();
    stopTrialLoop();
    updates.current().stop();
    // An MCP client holding the notification stream open would
    // otherwise keep the socket — and so the app — from closing.
    void mcpHost.stop();
    // The same for the internal one, which is always listening when
    // the app is up (EO-182).
    void adminMcpHost.stop();
  };

  // EO-696: set only by *Restart and update*, so an ordinary quit
  // leaves a downloaded update on disk rather than installing it.
  const installRequest = createInstallRequest();
  const shutdown = createShutdownCoordinator({
    engine,
    showActiveRunsDialog: async (): Promise<ShutdownChoice> => {
      const choices = ["keep-open", "close-when-finished", "cancel-and-close"] as const;
      const chosen = await platform.askQuestion({
        title: "Agents are still working",
        message: "Agents are still working",
        detail:
          "Close when finished blocks new agent starts and exits after current work completes. " +
          "Stop agents and close stops current work and keeps EO paused until you resume it; each agent then carries on where it left off.",
        buttons: ["Keep EO open", "Close when finished", "Stop agents and close"],
        defaultIndex: 0,
      });
      // Nobody to ask is not the same as "keep open" (EO-318). A
      // machine with no screen was asked to stop by something that
      // takes no answer — a signal, a service manager — and holding the
      // process open forever waiting for a person who is not there is
      // the one reply that cannot be right. It drains instead, which is
      // the gentlest of the two that actually ends.
      if (chosen === null) return "close-when-finished";
      return choices[chosen] ?? "keep-open";
    },
    persistPause: () => persistEnginePause(db),
    stopBackgroundServices,
    // EO-201: the only place a staged update is ever installed —
    // reached after the active-agents question has already been asked
    // and answered, which is the whole reason the button routes here.
    // EO-696: and only when the button is what led to this quit.
    quit: quitOrInstall(updates.current, installRequest, () => platform.quit()),
    // *Keep EO open* withdraws a pending restart for an update, so the
    // next ordinary quit does not install it.
    onStayOpen: installRequest.withdraw,
  });
  // Every way out of the process — a window closing, the menu, the OS
  // asking — through the one coordinator that can tell a second request
  // from the first.
  platform.onBeforeQuit(shutdown.requestClose);

  registerAllHandlers(db, engine, {
    // The machine, as the handlers are allowed to see it (KAN-127).
    platform,
    session,
    // How the pickers reach the organisation's people list when this
    // installation is signed in to one. Inert otherwise: `client()`
    // answers null and every read is answered from here.
    managed,
    moduleHostPath: resources.moduleHost,
    galleryDirectory: resources.gallery,
    mcp: { host: mcpHost, tokens: mcpTokens },
    // EO-201. `requestClose` rather than anything of the updater's own:
    // restarting into an update is a way out of the process, and the
    // coordinator owns all of those.
    updates: { controller: updates.current, requestClose: () => shutdown.requestClose(), installRequest },
    // EO-471. What has to be asked of whichever record owns a project —
    // its thread — rather than written to this database.
    record,
  });
  // An assistant chat's changes, sent as numbered deltas after every
  // `items:changed` that names one a window has open (EO-553). Before the
  // door opens, so the first view served is numbered against a watcher
  // that is already listening.
  const stopAssistDeltas = watchAssistDeltas(db, (conversationId) => assistDeltaView(db, conversationId));

  // Only now, because the registry every door dispatches through is what
  // `registerAllHandlers` just filled — a request arriving earlier would
  // find it empty.
  // The door, and who may open it besides whoever started the process
  // (EO-323). The desktop's platform ignores the argument — its door is
  // its own window — and the server's hands it to `createRequestListener`.
  platform.serveIpc({
    devices: createDeviceDirectory(db),
    // What this process hands a signed-in device (EO-328, ARCHITECTURE.md, "Secrets"). Read
    // afresh per request rather than captured, so a value an admin
    // cleared a second ago is not still being handed out — the same rule
    // every other secret read in this app follows. A desktop's platform
    // ignores it: a desktop is nobody's record, and receives these
    // rather than serving them.
    organisationSecrets: () => organisationSecretValues(organisationSecrets),
    // And where a webhook delivery goes (EO-332,
    // `ARCHITECTURE.md`, "Webhooks"). Built here for
    // `organisationSecrets`' reason exactly: it needs the database and
    // the attachment directory in one hand, and this is the only place
    // that has both. The desktop's platform ignores it — a machine with
    // no public address is a machine no webhook can arrive at — and the
    // server's hands it to `createRequestListener`.
    webhooks: {
      receive: async (delivery) => {
        const answer = await receiveWebhook(db, delivery, { storage: attachmentStorage });
        return { status: answer.status, say: webhookAnswerWord(answer.outcome) };
      },
    },
  });

  // Unconditional, because `reconcile` on a database nobody has turned
  // it on in does nothing at all. What decides whether a socket opens
  // is Settings → MCP server, which is where someone can also see why
  // it did not.
  const mcpReconciled = mcpHost.reconcile().then((status) => {
    if (status.listeningPort !== null) console.log(`[eo] MCP server listening on 127.0.0.1:${status.listeningPort}`);
    else if (status.problem !== null) console.warn(`[eo] MCP server not listening: ${status.problem}`);
  });

  // And EO's own, for the same reason and at the same moment: it
  // dispatches through the registry `registerAllHandlers` just filled.
  // Unconditional — there is no setting, because this listener is not
  // an accessory a person turns on but the tool surface EO's system
  // agent is dispatched with. It still cannot fail startup: a port
  // that will not bind is a warning here and an agent that finds no
  // administrative tools, exactly as if it held no grant.
  //
  // The port is not logged. Nothing needs to reach it by hand, and the
  // one thing that does reach it is handed the URL directly.
  const adminStarted = adminMcpHost.start().then((status) => {
    if (status.problem !== null) console.warn(`[eo] EO's administrative MCP server is not listening: ${status.problem}`);
  });
  // The agent write bridge (EO-543), which cannot fail startup either: a
  // turn with no bridge has write tools that answer that nothing was
  // written, because nothing could write it — never that it was.
  const writeBridgeStarted = startAgentWriteBridge((itemId, request, writes) => engine.handleAgentWrite(itemId, request, writes)).then(
    (bridge) => {
      agentWriteBridge = bridge;
    },
    (error: unknown) => console.warn(`[eo] EO's agent write bridge is not listening: ${error instanceof Error ? error.message : String(error)}`),
  );

  // Last of what the first read needs: a renderer invokes IPC as soon as
  // it loads, and the door above is what answers it.
  platform.openUserInterface();

  /**
   * Startup housekeeping that no screen's first read depends on (EO-566).
   *
   * Everything above runs before the window opens, and so delays the
   * first paint; this is what did not have to. Deferred a turn rather
   * than run inline, so the window gets the event loop first. What stays
   * above — the migrations, the backfills and template updates, the
   * prompt and item-type syncs, the retirements — either changes what
   * a screen reads or has to be in place before `engine.start()`.
   *
   * Skipped when `stop()` arrives first: a process stopped during startup
   * has nobody to show a badge to, and a database a caller is about to
   * close is no place to start reading.
   */
  let stopping = false;
  const housekeeping = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
    if (stopping) return;
    try {
      // The inbox baseline, so a relaunch does not re-announce old
      // questions. The badge and the toasts are all it feeds; every
      // screen reads the inbox through its own request. Whichever read
      // comes first is the baseline — this one, or a change the engine
      // announced since it started — so nothing is announced twice.
      notifier.refresh();
    } catch (error) {
      console.error("[eo] could not read the inbox for the badge:", error);
    }

    // KAN-178: what the packs this build installed still tell an agent
    // to call. Runs where a pack's prompts enter the installation, which
    // is here until packs are importable — and says it out loud, because
    // a prompt naming a tool that is about to be retired is a thing only
    // the person who owns the prompt can fix. A line in the log and
    // nothing else: the Agents screen works the same warning out for
    // itself, beside the instructions it is about.
    try {
      for (const warning of preflightPackPrompts(packs, promptReader(resources.prompts))) {
        const pairs = warning.names.map((name) => `${name.deprecated} → ${name.replacement}`).join(", ");
        console.log(
          `[eo] the ${warning.pack} pack's ${warning.role} prompt (${warning.file}) ${aliasNotice("pack", aliasRetirementReached(platform.version))}: ${pairs}`,
        );
      }
    } catch (error) {
      console.error("[eo] could not check the installed packs' prompts for retiring tool names:", error);
    }

    // Codex homes left behind by agents that were deleted, moved to
    // Claude or ticked over to the person's own setup while EO was not
    // running (EO-378). The dispatch preflight sweeps too; this is the
    // one that runs when no Codex agent is ever dispatched again. Never
    // rejects.
    const codexHomeRoots = codexHomeRootsOf(engineOptions);
    if (codexHomeRoots && !stopping) await sweepUnusedCodexHomes(db, codexHomeRoots);
  });

  return {
    async stop() {
      stopping = true;
      // Awaited before anything is stopped, so a listener whose socket
      // was still binding cannot outlive the stop that was meant to
      // close it — the one race a fire-and-forget start can lose. The
      // housekeeping with them, so nothing is still reading the database
      // once this resolves.
      await Promise.allSettled([mcpReconciled, adminStarted, writeBridgeStarted, housekeeping]);
      stopBackgroundServices();
      // Stop listening for what this device does. The subscriptions are
      // keyed on the database, so a process that re-opened one without
      // this would queue every move twice.
      record.stop();
      pushes.stop();
      stopAssistDeltas();
      await Promise.allSettled([mcpHost.stop(), adminMcpHost.stop(), agentWriteBridge?.close() ?? Promise.resolve()]);
      await engine.shutdown();
    },
  };
}
