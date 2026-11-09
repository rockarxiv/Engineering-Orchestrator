import { homedir } from "node:os";
import { join } from "node:path";
import { commentToolEnabled, configToolsEnabled, fullThreadEnabled, memoryNoteEnabled, type Agent, type AgentProvider, type McpServer, type JobRunsOn, type RunRuntimeSource, type Skill, type Item } from "@eo/core";
import { agentSurfaceKey } from "./agentAttachments/fingerprint.js";
import { readMcpServerSecret, type McpServerSecretsOptions } from "./mcp/serverSecrets.js";
import { readOrganisationSecretEntry, type OrganisationSecretsOptions } from "./policy/organisationSecrets.js";
import type { AgentWriteBridge } from "./mcp/writeBridge.js";
import type { Db } from "./db/client.js";
import { onCommentPosted, onCommentsRemoved } from "./db/commentEvents.js";
import { createChangeAnnouncers } from "./changeAnnouncers.js";
import { createDemoProvider } from "./providers/demo.js";
import { createClaudeProvider, type AttachedServerEnvironment, type ClaudeAgentConfig } from "./providers/claude.js";
import { RUNTIMES } from "./runtimes/catalog.js";
import { resolveRuntime } from "./runtimes/resolve.js";
import { checkRuntimeAuth, runtimeAuth } from "./runtimes/auth.js";
import { CLAUDE_SDK, resolvePackageSet } from "./runtimes/packages.js";
import { hasApiKey, readApiKey, type ApiKeyStoreOptions } from "./runtimes/apiKey.js";
import { attachmentEnvironment } from "./agentAttachments/serverEnvironment.js";
import { releaseItemToolDirectories, writeAgentToolDirectory } from "./agentAttachments/pluginDirectory.js";
import { adminDeliveryFor, adminDispatchFor, type AdminMcpLookup } from "./agentAttachments/adminDelivery.js";
import type { AdminMcpEndpoint } from "./mcpHost/admin.js";
import { createCodexProvider, SECRET_WITHHELD, type CodexAgentConfig, type ServerSecretRead } from "./providers/codex.js";
import { agentsWithCodexHomes, chooseCodexHome, codexHomeRefusal, inheritsAmbientConfig, signInIsInKeyringAsync, sideCallCodexHome, sweepCodexHomes, type CodexHomeOptions } from "./providers/codexHome.js";
import { createSideCallProvider, sideCallSignedIn, sideCallSignInUnreachable } from "./providers/sideCallProviders.js";
import { defaultAgentModel, resolveSmallModel, smallModelSources } from "./providers/smallModels.js";
import { managedProviderReady, managedRuntimeEnabled } from "./ipc/runtimeCommands.js";
import { readGuards } from "./ipc/configCommands.js";
import {
  readRepositoryIntelligenceConfig,
  repositoryIntelligenceFingerprint,
  repositorySearchNudge,
} from "./packs/developer/repositoryIntelligence/index.js";
import { emitPush } from "./ipc/push.js";
import { liveDrafts } from "./supervisor/liveDrafts.js";
import { createRunSupervisor, type ArtifactStore, type RunSupervisor } from "./supervisor/runSupervisor.js";
import { skillRunScope } from "./supervisor/workspaceResolution.js";
import { recordFor } from "./record/localRecord.js";
import type { ItemRecord } from "./record/record.js";
import { createModuleRunnerLookup } from "./modules/registry.js";
import { agentRunVariables, redirectWithheldVariables, type ModuleSecretsOptions } from "./modules/secrets.js";
import { foldPacks, missingPackRefusal, type CodePack } from "./packs/pack.js";
import { developerPack } from "./packs/developer/index.js";
import { useRegistry } from "./registry.js";
import { useWorkspaceKinds } from "./workspaceKinds.js";
import { usePackConnectors } from "./connectors/declared.js";
import { listAgents, resolveAgentAttachments } from "./db/repos/index.js";
import { isEnginePausePreferred } from "./engineActivity.js";

export interface EngineOptions {
  db: Db;
  /** Told each time the computer wakes, so a run's silence across a sleep is not held against it (`RunSupervisorOptions.onWake`). */
  onWake?: (listener: () => void) => () => void;
  /** Whether EO can reach the network, so no watch is checked while it cannot (`RunSupervisorOptions.isOnline`, EO-457). */
  isOnline?: () => boolean;
  /** Whether the machine sleeps, so a late watchdog pass holds the watches (`RunSupervisorOptions.sleeps`, EO-514). */
  sleeps?: boolean;
  /** The durable DB path read by the provider-neutral MCP subprocess, and by the module host (EO-74). */
  dbPath?: string;
  /** Where the shared EO MCP service lives. Unpackaged path differs from packaged. */
  eoMcpServerPath: string;
  /**
   * The wrapper that bounds a delivered MCP server's life by the backend
   * that started it (EO-151).
   *
   * Optional so a caller with no packaged resources — the v1 gate, a
   * test — still builds an engine. Absent means a server is handed over
   * as the provider composed it, which is what EO did before this and is
   * still correct for anything that never spawns one.
   */
  mcpServerSupervisorPath?: string;
  /**
   * Where the command Codex runs as EO's broad-search hook lives
   * (EO-379). Same packaged/unpackaged split.
   *
   * Optional for the reason the supervisor's path is. Absent means a
   * Codex agent is configured with no hook, and hears no nudge.
   */
  codexSearchHookCommandPath?: string;
  /** Where the custom-module host lives (KAN-105). Same packaged/unpackaged split. */
  moduleHostPath?: string;
  /**
   * Where the files a run produced are kept (EO-299).
   *
   * What a workspace kind says the run produced as a *file* — the
   * report on the drive, everything in the scratch directory — is
   * copied in here and attached to the item's output comment.
   * `main/index.ts` passes the app's own attachment store, so a run's
   * output lands beside every other attachment EO holds rather than in
   * a second place with its own lifetime.
   *
   * Omitted — the v1 gate, most tests — and a file artifact is named in
   * the output and left where the run put it.
   */
  artifactStore?: ArtifactStore;
  /** The keychain a module's declared secrets are read from. */
  moduleSecrets?: ModuleSecretsOptions;
  /**
   * The keychain a Claude API key is read from (EO-84).
   *
   * `userData/credentials` in production. Two things need it and both
   * are here: the dispatch preflight, which must not refuse a runtime
   * whose only credential is the one EO holds, and the Claude provider,
   * which spends it as `ANTHROPIC_API_KEY`. Omitted — the v1 gate, most
   * tests — EO simply has no key and everything behaves as it did.
   */
  apiKeys?: ApiKeyStoreOptions;
  /**
   * The keychain an attached MCP server's declared values are read from
   * (EO-104, spent by EO-107 and EO-108).
   *
   * `userData/mcp-server-secrets` in production — the directory EO-104's
   * catalogue writes into, and the one the Servers screen reports "set"
   * from. A second one would have the screen say a value is set while
   * the dispatch found none.
   *
   * Omitted, each provider degrades the way it should: Claude delivers
   * an attached server with its `${VAR}` references unexpanded, and
   * Codex hands one none of its declared variables, which is what an
   * unset one already looks like. That is what an installation with no
   * catalogue, and every test that is not about this, wants.
   */
  mcpServerSecrets?: McpServerSecretsOptions;
  /**
   * The keychain the *organisation's* named values are read from
   * (EO-328, ARCHITECTURE.md, "Secrets").
   *
   * `userData/organisation-secrets` in production, filled by
   * `policy/sync.ts` from the record rather than by anybody typing into
   * a field. Spent in the same two places a personal secret is — a
   * module's environment and an attached MCP server's `${VAR}` — and it
   * wins over the personal one of the same name, which
   * `modules/secrets.ts` argues at length.
   *
   * Omitted — a solo installation that never signed in, the v1 gate,
   * most tests — and everything behaves exactly as it did.
   */
  organisationSecrets?: OrganisationSecretsOptions;
  /**
   * Where the generated per-agent tool directories are written (EO-107).
   *
   * `userData/agent-tools` in production, and deliberately nowhere near
   * a worktree: `verify.ts` fails a run whose `git status --porcelain`
   * is not empty, and an untracked directory counts. Omitted, nothing is
   * generated and an agent runs as it did before the catalogues existed.
   */
  toolDirectoryRoot?: string;
  /**
   * Where each locked-down Codex agent's own Codex home is kept (EO-378).
   *
   * `userData/codex-homes` in production — never in a worktree, for the
   * reason `toolDirectoryRoot` is not in one, and not under a temporary
   * directory, which Codex warns about. Omitted — the v1 gate, most
   * tests — and a Codex agent runs with the person's own `~/.codex`, as
   * every Codex agent did before.
   */
  codexHomeRoot?: string;
  /**
   * Where such a home goes when it cannot be linked under the root above
   * (EO-378): `~/.eo/codex-homes` in production. On Windows a hard link
   * to the person's `auth.json` cannot cross drives, and EO's data folder
   * is not always on the drive their Codex home is on; EO's folder in
   * their profile is. Ignored without `codexHomeRoot`.
   */
  codexHomeAlternateRoot?: string;
  /**
   * Where EO's own administrative MCP server is listening, asked per
   * dispatch (EO-182).
   *
   * A function rather than a value because the socket is bound after the
   * engine is built — the listener cannot start until
   * `registerAllHandlers` has filled the registry it dispatches through,
   * and the engine is constructed before that. Null while it is not up,
   * which is the ordinary answer during startup and the permanent one in
   * every test that is not about this.
   *
   * Only the agent that holds the grant is given the entry; the
   * predicate is `adminToolsEnabled`, and it is read here rather than
   * inside the directory writer because the writer has no business
   * knowing what an `allowedTools` list means.
   */
  adminMcp?: () => AdminMcpEndpoint | null;
  /** Where the `eo` server hands every write an agent asks for (EO-543). See `RunSupervisorOptions.agentWriteBridge`. */
  agentWriteBridge?: () => Pick<AgentWriteBridge, "tokenFor"> | null;
  /** Overridable so the v1 gate can drive the whole engine with scripted agents. */
  provider?: AgentProvider;
  /**
   * What side calls run on, by backend (EO-477). Overridable for the
   * reason `provider` is. Absent with `provider` given, side calls have
   * none and fail saying so, which keeps a scripted engine from reaching
   * a real CLI; absent otherwise, each backend's own is built.
   */
  sideCallProvider?: (backend: string) => AgentProvider | null;
  worktreeRoot?: string;
  /** Where A-08 caches fetched agent CLIs. `userData/runtimes` in production. */
  runtimeRoot?: string;
  /**
   * Where the fetched repository-index binary is cached (EO-149).
   * `userData/repositoryIntelligence` in production.
   *
   * A sibling of `runtimeRoot` rather than an entry in it: the thing it
   * caches is not an agent runtime and must not surface in the Runtimes
   * settings screen. Nothing is ever written here with the feature off,
   * because the gate is read before the path is.
   */
  repositoryIntelligenceRoot?: string;
  /** Called after any item or run change — U-04 uses it to refresh the badge and notifications. */
  onDomainChange?: () => void;
  /**
   * The record this installation's device talks to (EO-324, ARCHITECTURE.md, "The record").
   *
   * Omitted — the v1 gate, most tests — and the supervisor builds a
   * local one over the same database, which is solo mode: one process,
   * both roles, a local lease. The composition root passes the record it
   * shares with the IPC commands, which in managed mode is the one with
   * a server behind it.
   */
  record?: ItemRecord;
  /** Which device this machine is on that record. Read per use — a sign-in changes it. */
  deviceId?: string | (() => string);
  /**
   * Whether this process runs the device half (EO-324, ARCHITECTURE.md, "The record").
   *
   * True in production on both machines since EO-330 — see
   * `RunSupervisorOptions.dispatches`, which argues why a server may
   * now run one. It stays an option for a process that is the record
   * and no kind of device at all, which is what a test asserting the
   * old shape configures.
   */
  dispatches?: boolean;
  /**
   * Which kind of device this process is (EO-330, ARCHITECTURE.md, "Where a job runs").
   *
   * `device` on a desktop and `server` on a server, so that the record
   * offers each of them only the work a job placed there. Passed
   * through untouched; `RunSupervisorOptions.runsWhere` says the rest.
   */
  runsWhere?: JobRunsOn;
  /** Test seam for keeping the built-in provider active during Electron close-flow coverage. */
  demoProviderDelayMs?: number;
}

/**
 * Composes every piece into a running engine.
 *
 * This is the one place that knows the whole assembly, and until it
 * existed the pieces were individually correct and collectively inert —
 * G-01's workspace, G-02's verifier and R-01..R-03's role wiring all
 * had tests and no production caller. That is the failure mode this
 * file exists to close.
 *
 * **`packs` is what this installation is about** (KAN-144, ARCHITECTURE.md,
 * "Where the seams are"). The workspace, the verifier, the clean-tree check, borrowed
 * files, the repository MCP server, the index sync and the two
 * settlement hooks used to be written out below, each of them typed on
 * a worktree path or calling git; the role wiring was spread in at the
 * end of the same object. All of it is one value now, folded in by
 * `foldPacks`, and with none installed the supervisor's own defaults
 * stand — the core composes and ticks with no pack, which is the
 * invariant this phase adds.
 *
 * The default is the developer pack, so that a caller with no opinion
 * about packs — the v1 gate, a test, anything that only wants "the
 * engine EO ships" — is unaffected. `main/index.ts` names it outright,
 * because that is where an installation is actually chosen.
 *
 * Provider choice follows the agents table (ARCHITECTURE.md, "An agent is a row": roles are
 * configuration,
 * not code). Every agent configured for `fake` keeps the loop runnable
 * with no credentials and no spend, which is what makes the engine
 * demonstrable before anyone logs in.
 */
export function createEngine(options: EngineOptions, packs: readonly CodePack[] = [developerPack(options)]): RunSupervisor {
  const { db, dbPath, eoMcpServerPath } = options;
  // Everything the installed packs supply, as one set of supervisor
  // options and one registry, with a collision between two of them
  // refused here rather than resolved (KAN-144). Before the supervisor
  // is built, because the registry it reads — what validates a result,
  // which actions are functions EO runs, whether a role reuses its
  // thread — has to be the folded one by the time anything ticks.
  const { registry: installedRegistry, connectors: installedConnectors, ...installed } = foldPacks(packs);
  useRegistry(installedRegistry);
  // And what those packs can vouch for, where a screen can ask (EO-312).
  // The supervisor takes the kinds as options below; a column head
  // saying "EO checks: commits, tests ran" is drawn by an IPC query that
  // has no supervisor in hand, and this is where it asks instead.
  useWorkspaceKinds(installed.kinds);
  // And the words the packs put around the servers EO hands an agent
  // (EO-315). Installed for the same reason and at the same moment: the
  // reach list on a step and the needs check both read it through an IPC
  // handler that has no engine in hand.
  usePackConnectors(installedConnectors);
  // Neither fallback is what production resolves: `main/index.ts`
  // passes both, under Electron's `userData`. These are what a caller
  // that passes nothing gets — a test, or the v1 gate. The sentence
  // that used to sit here said the opposite, which is worse than no
  // comment at all: the next person to touch this reads it and believes
  // it (EO-157).
  const runtimeRoot = options.runtimeRoot ?? join(homedir(), ".eo", "runtimes");

  // Where locked-down Codex agents' homes go (EO-378). The homes left
  // behind while EO was not running are swept by `startMain` once the
  // window is open (EO-566), not here: nothing the engine does on
  // starting depends on them being gone.
  const codexHomeRoots = codexHomeRootsOf(options);

  // A `items:changed` push is not cheap on the far side — it
  // invalidates the project, the inbox, the archive and the repository list,
  // and the last of those stats a credentials file per repo. An agent
  // writing five notes in a second, or an import writing fifty comments
  // in one transaction, should cost one round of that, not fifty.
  // Leading edge, so the first comment is never delayed.
  //
  // Since EO-557 the same coalescer carries every item push the engine
  // sends — a run ending, a module creating an item — and runs have one
  // of their own (`changeAnnouncers.ts`). U-04: the badge follows all of
  // it through `onDomainChange`.
  const { announceItem, announceRun } = createChangeAnnouncers(options.onDomainChange);

  // The record and the device, wired into one process (EO-322,
  // `ARCHITECTURE.md`, "The record").
  //
  // This is the composition root, and in solo mode it composes both
  // roles here: the record owns item state and runs the only scheduler,
  // the supervisor is the device that claims a dispatch under a local
  // lease and reports what happened. `recordFor` rather than a fresh
  // one, because the IPC commands behind a drag and a decision reach
  // the same record over the same database — a second one would be a
  // second name for one thing, and invariant #1 would be true of each
  // of them separately and of neither together.
  //
  // Since EO-324 the composition root may hand one in, and then this
  // line is the *default* rather than the arrangement: a desktop signed
  // in to an organisation passes a record with a server behind it, and
  // everything below is unchanged because it is the same interface.
  const record = options.record ?? recordFor(db);

  // The words a run is writing, a frame's worth at a time, to whichever
  // window is watching (`liveDrafts.ts`). Not throttled by the supervisor
  // like `runs:progress` — the store already coalesces — and carrying the
  // text, since nothing stores it to be asked for again.
  liveDrafts.onDelta((push) => emitPush("runs:delta", push));

  const supervisor = createRunSupervisor({
    db,
    record,
    // Where the files a run produced are kept (EO-299). Conditional
    // because an absent store and an explicit `undefined` are different
    // things under `exactOptionalPropertyTypes`.
    ...(options.artifactStore ? { artifactStore: options.artifactStore } : {}),
    // Restore the user's preference while the supervisor is constructed,
    // before start() can reconcile a provider thread or run its first
    // dispatch tick. Runtime-only drains call supervisor.beginClose()
    // directly and therefore remain separate from this saved preference.
    initialPaused: isEnginePausePreferred(db),
    ...(options.onWake ? { onWake: options.onWake } : {}),
    ...(options.isOnline ? { isOnline: options.isOnline } : {}),
    ...(options.sleeps === undefined ? {} : { sleeps: options.sleeps }),
    ...(options.deviceId === undefined ? {} : { deviceId: options.deviceId }),
    ...(options.dispatches === undefined ? {} : { dispatches: options.dispatches }),
    ...(options.runsWhere === undefined ? {} : { runsWhere: options.runsWhere }),
    ...(options.agentWriteBridge === undefined ? {} : { agentWriteBridge: options.agentWriteBridge }),
    // Both read on every tick, so a change in settings takes effect on
    // the next dispatch rather than the next launch (U-06).
    limits: () => {
      const guards = readGuards(db);
      return {
        globalConcurrency: guards.globalConcurrency,
        perAgentConcurrency: guards.perAgentConcurrency,
        perRepositoryConcurrency: guards.perRepositoryConcurrency,
      };
    },
    guards: () => readGuards(db),
    // Per agent, not per supervisor (A-06): `agents.provider` already
    // says which backend each role uses, and mixing them is a reasonable
    // thing to want.
    provider:
      options.provider ??
      ((agent) =>
        providerForAgent(
          agent,
          eoMcpServerPath,
          dbPath,
          runtimeRoot,
          db,
          options.demoProviderDelayMs,
          options.apiKeys,
          options.mcpServerSecrets,
          options.adminMcp,
          options.organisationSecrets,
          codexHomeRoots,
          options.codexSearchHookCommandPath,
        )),
    runtimeSource: options.provider
      ? () => null
      : (agent) => runtimeSourceForAgent(agent, runtimeRoot, db),
    // An agent run's environment variables (EO-487): read from disk as
    // each turn opens and handed to that turn, so they are never part of
    // `providerCacheKey` and an edit reaches the next run.
    ...(options.moduleSecrets ? { runEnvironment: runEnvironmentFor(options.moduleSecrets), runEnvironmentWithheld: withheldFor(options.moduleSecrets) } : {}),
    // What a `module` step runs (KAN-105). Omitted when the caller has no
    // host path — the v1 gate drives the engine with scripted agents and
    // has no packaged resources — in which case a module step parks and
    // says so, rather than the engine failing to construct.
    ...(options.moduleHostPath && options.moduleSecrets
      ? {
          moduleRunner: createModuleRunnerLookup({
            db,
            // Who a module's creation is asked of (EO-433): the record
            // that owns the item, which for an organisation's project
            // is not this database.
            record,
            launcher: {
              execPath: process.execPath,
              hostPath: options.moduleHostPath,
              // The same trick the MCP service is launched with: Electron
              // *is* Node when told to be, so there is no second runtime
              // to install and no version to keep in step.
              hostEnv: { ELECTRON_RUN_AS_NODE: "1" },
              // What the host opens read-only for `ctx.ticket()` (EO-74).
              // Absent leaves the reads answering "unavailable", which is
              // the v1 gate's case and not a reason to refuse to run.
              ...(dbPath ? { dbPath } : {}),
            },
            secrets: options.moduleSecrets,
            // Where a file a module attaches is kept (EO-414): the store
            // a run's artifacts already go to.
            ...(options.artifactStore ? { attachments: options.artifactStore } : {}),
            // An item a module created (EO-433): the board it landed on
            // is told, as it is for any other change to an item.
            onItemCreated: (itemId) => announceItem(itemId),
            // EO-328: and the organisation's, which win over both the
            // step override and the shared value.
            ...(options.organisationSecrets ? { organisationSecrets: options.organisationSecrets } : {}),
          }),
        }
      : {}),
    checkAuth: (agent) => checkAgentAuth(agent, runtimeRoot, db, options.apiKeys, codexHomeRoots),
    // EO's short model calls that are not runs (EO-477): each backend's
    // own adapter for them, its small model, and its sign-in.
    sideCalls: sideCallsFor(options, runtimeRoot, db, codexHomeRoots),
    // Why nothing at all can be dispatched: no pack is installed, so
    // there is no workspace to run in, no shape to answer in, no
    // function to run and no wiring to route what came back (KAN-144).
    // Asked on both dispatch paths — an agent's and a `builtin` step's
    // — so that a core with nothing installed says the same thing
    // wherever a person meets it. Null, and therefore silent, for every
    // installation that has a pack.
    dispatchRefusal: (subject) => missingPackRefusal(packs, subject),
    // What EO was asked to do for this agent and will not (EO-378): lock
    // a Codex agent down to a home of its own, when the person's Codex
    // sign-in is in the OS keyring and no home but theirs can reach it.
    // The agent runs with their own setup instead, and the item says so.
    //
    // The only one left. `codexSecretNotices` told a person that a Codex
    // agent's attached servers would start without their declared values,
    // until EO-377 delivered them; `codexSkillNotices` went the same way
    // when EO-207 delivered skills.
    dispatchNotices: (agent) => (codexHomeRoots ? codexOwnSetupNotices(agent, codexHomeRoots) : []),
    isAgentAvailable: options.provider
      ? () => true
      : (agent) =>
          managedProviderReady(
            { root: runtimeRoot, db, configuredPath: configuredExecutablePath(agent) },
            agent.provider,
          ),
    // What this dispatch's agent has been given out of the two
    // catalogues, written where the backend it drives can read it
    // (EO-107). Under `userData` and never in the checkout: an untracked
    // directory there would fail the `clean` step of every run that had
    // anything attached.
    ...(options.toolDirectoryRoot
      ? {
          // The path *and* what was written into it: the startup report
          // this turn will send is judged against the second, because by
          // the time it arrives the catalogue may have moved on (EO-107).
          prepareToolDirectory: (item: Item, agent: Agent) =>
            writeAgentToolDirectory(db, {
              root: options.toolDirectoryRoot as string,
              itemId: item.id,
              agentId: agent.id,
              // EO-470: only the skills whose scope takes this run in —
              // its project, or the workspace its step works in.
              scope: skillRunScope(db, item),
              // EO-182: and EO's own administrative server, for the one
              // agent whose allowlist names it. Every other agent's
              // directory is exactly what it was.
              admin: adminDeliveryFor(agent, options.adminMcp),
            }),
          // And let go of them when the item settles — the moment no
          // thread on it will be resumed again. Never when a run ends: a
          // parked run's conversation outlives it.
          releaseToolDirectories: (item: Item) => releaseItemToolDirectories(options.toolDirectoryRoot as string, item.id),
        }
      : {}),
    // F-05: tell the renderer something moved, so its queries refetch
    // instead of polling.
    // Already throttled by the supervisor (pushThrottleMs), so this is
    // at most a handful of signals a second no matter how chatty the
    // agent is.
    onPushEvents: (runId) => emitPush("runs:progress", { runId }),
    // Coalesced per item and per run since EO-557 (`changeAnnouncers.ts`):
    // a run's end announces itself several times in a few milliseconds.
    onItemChanged: (itemId) => announceItem(itemId),
    onRunChanged: (runId, itemId, status) => announceRun(runId, itemId, status),
    // A memory scope's consolidation queued, started or finished (EO-589):
    // the Memory section's history and its Consolidate now button.
    onMemoryConsolidationChanged: (scope) => emitPush("memory:changed", { scope }),
    // The installed packs, last: the workspace kinds a run can happen
    // in (EO-295), the two scheduling hooks, the functions a `builtin`
    // step runs, and the wiring that says what a result means
    // (KAN-144). Spread here rather than
    // written out above, because which of them exist is now a property
    // of what is installed rather than of this file — and with nothing
    // installed the supervisor's own defaults stand, which is what
    // `createEngine(options, [])` is for.
    ...installed,
  });

  // A comment *is* the thread (invariant 4), and nothing announced one.
  // `onItemChanged` above fires only from `announceRun`, whose every
  // call site passes a terminal run status — so between a run starting
  // and finishing, an open item froze however much the agent wrote.
  //
  // One subscription covers every writer: the supervisor, all six roles,
  // the Jira import, the outbox, the archive sweep, and whatever writes
  // a comment next.
  onCommentPosted(db, (comment) => announceItem(comment.itemId));
  // And when one is removed: `!` derives from mentions a deleted
  // comment may have carried or answered, so the project and the badge
  // are as stale as they are after a new one.
  onCommentsRemoved(db, (itemId) => announceItem(itemId));

  return supervisor;
}

/**
 * What the supervisor's side calls run on (EO-477): an adapter per
 * backend built for side calls alone (`sideCallProviders.ts`), cached on
 * the runtime it was built from; the small model, chosen or defaulted
 * (`smallModels.ts`); and the same sign-in probe a dispatch asks.
 */
function sideCallsFor(
  options: EngineOptions,
  runtimeRoot: string,
  db: Db,
  codexHomeRoots: readonly string[] | undefined,
): NonNullable<Parameters<typeof createRunSupervisor>[0]["sideCalls"]> {
  const sources = smallModelSources((backend) => runtimePathFor(backend, runtimeRoot, db, null));
  const built = new Map<string, AgentProvider | null>();
  const provider =
    options.sideCallProvider ??
    (options.provider
      ? () => null
      : (backend: string) => {
          const executablePath = runtimePathFor(backend, runtimeRoot, db, null);
          const sdkEntryPath = resolvePackageSet(runtimeRoot, CLAUDE_SDK);
          const key = JSON.stringify([backend, executablePath, sdkEntryPath]);
          if (!built.has(key)) {
            built.set(
              key,
              createSideCallProvider(backend, {
                executablePath,
                claudeSdkEntryPath: () => sdkEntryPath,
                ...(options.apiKeys ? { claudeApiKey: () => readApiKey(options.apiKeys!, "claude") } : {}),
                // Its own home or none — never `readyCodexHome`, whose
                // keyring answer is the person's own home (EO-477).
                ...(codexHomeRoots ? { codexHome: () => sideCallHome(codexHomeRoots) } : {}),
              }),
            );
          }
          return built.get(key) ?? null;
        });
  return {
    provider,
    smallModel: (backend, signal) => resolveSmallModel(db, backend, sources, signal),
    // What a call on the system agent's model runs on when it names none (EO-578).
    defaultModel: (backend, signal) => defaultAgentModel(backend, sources, signal),
    // A scripted engine has no runtime to ask, and nothing to sign in.
    ...(options.provider || options.sideCallProvider
      ? {}
      : {
          signedIn: (backend: string, signal: AbortSignal) => sideCallSignedIn(backend, runtimePathFor(backend, runtimeRoot, db, null), hasApiKey(options.apiKeys, "claude"), signal),
          signInUnreachable: (backend: string) => sideCallSignInUnreachable(backend),
        }),
  };
}

/**
 * The backend for one agent, from its `agents.provider` (ARCHITECTURE.md, "An agent is a row":
 * roles are
 * configuration, not code).
 *
 * Cached so a run doesn't rebuild an SDK client or recalculate its
 * shared MCP subprocess configuration on every dispatch, and bounded at
 * one entry per agent so that caching text a person edits — an attached
 * skill's body (EO-106) — cannot grow it without limit. What counts as a
 * different provider, and why the bound is where it is, is on
 * `providerCacheKey`.
 */
const providerCache = new Map<string, AgentProvider>();

/**
 * Everything about a provider that comes from the process rather than
 * from the agent.
 *
 * An object because the key builder is exported and tested, and nine
 * positional strings is a signature whose arguments can be transposed
 * without the compiler noticing.
 */
export interface ProviderIdentity {
  eoMcpServerPath: string;
  dbPath: string | undefined;
  runtimeRoot: string;
  executablePath: string | null;
  sdkEntryPath: string | null;
  /** The keychain's directory. Never the key inside it — see below. */
  apiKeyDirectory: string | undefined;
  demoProviderDelayMs: number | undefined;
  /** Where locked-down Codex agents' homes are, in the order tried (EO-378). Changes where a Codex CLI runs. */
  codexHomeRoots?: readonly string[] | undefined;
}

/**
 * What makes one cached provider a different provider from another.
 *
 * The resolved paths are part of the identity: a provider cached before
 * a runtime was installed would keep the old answer forever.
 * `runtimeRoot` is part of it for the same reason the resolved paths
 * are: it reaches the MCP subprocess's environment, so a provider cached
 * under one root would keep answering `runtimes_list` from it.
 *
 * The keychain's *directory* is part of the identity; the key inside it
 * deliberately is not. A cache key carrying a secret would put one in a
 * Map key that outlives the run — and it does not need to, because the
 * provider reads the key at spawn rather than holding it
 * (`providers/claude.ts`).
 *
 * **The attachments (EO-106) arrive as a fingerprint of their resolved
 * content, and that is what makes them safe to key on.** A server's row
 * holds environment-variable names and `${VAR}` references, never
 * values, so there is nothing secret to leak here even before hashing —
 * and hashing means nothing a person typed reaches this string in any
 * case. It has to be the content and not the ids: a renamed command or
 * an edited skill body changes what the agent can do without moving an
 * id, and a key over ids would hand back the provider built for the old
 * one until the app restarted.
 *
 * **The agent's id leads, and it is how this cache stays bounded.** The
 * map is module-level and had only `get` and `set`; keyed on
 * `JSON.stringify(agent.config)` alone that was already a slow leak, and
 * keying it on a fingerprint of text a person edits would have made it a
 * fast one — a retained provider per keystroke-saved skill body, for the
 * life of the app. Rather than pick a cap and an eviction order with no
 * principle behind either, the id makes the bound the real one: **at
 * most one cached provider per agent.** A miss discards that agent's
 * previous entry before storing the new one, because an agent has
 * exactly one current configuration and the superseded provider will
 * never be asked for again. Discarding it does not disturb a run already
 * holding it — the object outlives the map entry.
 *
 * The cost is that two agents configured identically no longer share one
 * provider, which was a side effect of the old key rather than a goal,
 * and which attachments would have ended anyway.
 *
 * **Repository intelligence is in the key for the reason everything
 * else is** (EO-148): it changes what an agent can do. A dispatch under
 * it is handed a query server a dispatch without it is not, and a
 * provider cached before the switch moved would go on offering the
 * capability it was built with — so the flag would read as set and
 * behave as it was, which is the failure a rollout switch exists to
 * prevent. Read out of the database here rather than passed in, because
 * the identity object is what the *process* contributes and this is a
 * preference somebody can change while EO is running.
 */
export function providerCacheKey(agent: Agent, db: Db, identity: ProviderIdentity): string {
  // Every attached entry with its scope, not one run's narrowing of them
  // (EO-470): the provider holds them all and narrows per turn, so a
  // skill whose scope moved has to discard it.
  const attachments = agentSurfaceKey(db, agent.id);
  // Read here rather than passed in, and read on every call rather than
  // resolved once: this is the third layer of the same gate
  // `mcpHost/gate.ts` describes, and a value captured at startup would
  // make the switch take effect on the next launch.
  const intelligence = repositoryIntelligenceFingerprint(readRepositoryIntelligenceConfig(db));
  return [
    agent.id,
    agent.provider,
    identity.executablePath ?? "",
    identity.sdkEntryPath ?? "",
    identity.eoMcpServerPath,
    identity.dbPath ?? "",
    identity.runtimeRoot,
    identity.apiKeyDirectory ?? "",
    JSON.stringify(agent.config),
    attachments,
    identity.demoProviderDelayMs ?? 0,
    intelligence,
    (identity.codexHomeRoots ?? []).join("|"),
  ].join(":");
}

/** The prefix every key for this agent shares — see `providerCacheKey` on why the id leads. */
function agentKeyPrefix(agent: Agent): string {
  return `${agent.id}:`;
}

export function providerForAgent(
  agent: Agent,
  eoMcpServerPath: string,
  dbPath: string | undefined,
  runtimeRoot: string,
  db: Db,
  demoProviderDelayMs?: number,
  apiKeys?: ApiKeyStoreOptions,
  mcpServerSecrets?: McpServerSecretsOptions,
  adminMcp?: AdminMcpLookup,
  organisationSecrets?: OrganisationSecretsOptions,
  codexHomeRoots?: readonly string[],
  codexSearchHookCommandPath?: string,
): AgentProvider {
  const identity: ProviderIdentity = {
    eoMcpServerPath,
    dbPath,
    runtimeRoot,
    executablePath: runtimePathFor(agent.provider, runtimeRoot, db, configuredExecutablePath(agent)),
    // The SDK EO imports, as opposed to the binary it spawns. Both are
    // fetched, and a machine can have one without the other.
    sdkEntryPath: agent.provider === "claude" ? resolvePackageSet(runtimeRoot, CLAUDE_SDK) : null,
    apiKeyDirectory: apiKeys?.directory,
    demoProviderDelayMs,
    codexHomeRoots,
  };
  const key = providerCacheKey(agent, db, identity);
  const cached = providerCache.get(key);
  if (cached) return cached;

  // This agent's previous provider, if it has one, is now superseded:
  // whatever it was built from is not what the agent is configured with
  // any more. Dropped here rather than left to grow — the reasoning is
  // on `providerCacheKey`.
  for (const existing of [...providerCache.keys()]) {
    if (!existing.startsWith(agentKeyPrefix(agent))) continue;
    // And whatever it had warmed is for a configuration that is gone.
    providerCache.get(existing)?.dropWarm?.();
    providerCache.delete(existing);
  }

  const created = buildProvider(
    agent,
    eoMcpServerPath,
    dbPath,
    identity.executablePath,
    identity.sdkEntryPath,
    demoProviderDelayMs,
    runtimeRoot,
    apiKeys,
    // Resolved here, where the cache miss happened, because the
    // fingerprint that produced the miss was taken over exactly these
    // rows: a provider is built with the surface its key describes, and
    // a second read somewhere further down could disagree with it.
    // Both catalogues, for the reason either alone would be wrong: the
    // servers are merged into `mcp_servers` and the skills are written
    // into the worktree (EO-207), and the fingerprint that produced this
    // miss was taken over both.
    { ...resolveAgentAttachments(db, agent.id), ...(mcpServerSecrets ? { secrets: mcpServerSecrets } : {}) },
    // Closed over here rather than passed as a store, so `buildProvider`
    // stays ignorant of the database — and called per turn rather than
    // now, so a value somebody sets after this provider was cached is
    // the one the next dispatch spends (EO-107).
    //
    // The line above and this one are the same attachments read two
    // ways, because the two providers need different halves: Codex is
    // given the rows so it can merge them into `mcp_servers`, Claude an
    // environment because its servers are already on disk carrying
    // `${VAR}` names. An agent with none gets an empty object.
    //
    // Handed the turn's environment variables by the adapter (EO-488),
    // because they are the run's step's and this provider is the agent's.
    (variables) => dispatchEnvironment(db, agent, mcpServerSecrets, organisationSecrets, variables),
    // And EO's own administrative server, which both backends now ask
    // per turn for a bearer of that turn's own (EO-444): Codex for its
    // `mcp_servers` entry as well (EO-203), Claude for the environment
    // only, because its `.mcp.json` was written with the URL a dispatch
    // earlier.
    adminMcp,
    // Codex's half of the organisation's secrets (EO-328). Claude's
    // arrived in the closure above, because its servers are already on
    // disk carrying `${VAR}` names; Codex asks per name at spawn.
    organisationSecrets,
    codexHomeRoots,
    // Not part of the cache key: it is one path for the life of the
    // process, the same for every agent.
    codexSearchHookCommandPath,
  );
  providerCache.set(key, created);
  return created;
}

/**
 * The values behind this agent's attached servers' `${VAR}` names, for
 * its CLI's environment at spawn (EO-107).
 *
 * Read per spawn rather than captured, for the reason every other reader
 * here is: the provider is cached for the life of the process.
 *
 * The bearer for EO's administrative server used to be added here too
 * (EO-182). It is a turn's own now, with a release that has to reach the
 * adapter that knows when the turn is over (EO-444), so the Claude
 * adapter is handed it as `admin` — the call Codex already made — and
 * applies it after these, so a catalogue entry declaring the same name
 * still cannot displace it.
 *
 * **Claude's, despite the general name.** This is passed as
 * `attachmentEnv`, which only the Claude adapter takes: Codex reads its
 * attached servers' values through `serverSecret` and builds its own
 * spawn environment.
 */
function dispatchEnvironment(
  db: Db,
  agent: Agent,
  secrets: McpServerSecretsOptions | undefined,
  organisationSecrets: OrganisationSecretsOptions | undefined,
  variables: Readonly<Record<string, string>>,
): AttachedServerEnvironment {
  return secrets ? readAttachmentEnv(db, agent, secrets, organisationSecrets, variables) : { env: {}, withheld: [] };
}

/**
 * This agent's attached servers' secrets, and a word about the ones that
 * are not there (EO-107).
 *
 * The values go to the provider; the gaps go to the log. Not a comment
 * on the item, because this is not a guard and nothing is being
 * dropped — the server is still delivered and still started, with the
 * variable unset, which is often exactly what an unauthenticated server
 * looks like. What *is* a comment is that server failing to come up,
 * which the supervisor posts from what the backend reports; this line is
 * what tells whoever reads it why.
 */
function readAttachmentEnv(
  db: Db,
  agent: Agent,
  secrets: McpServerSecretsOptions,
  organisationSecrets: OrganisationSecretsOptions | undefined,
  variables: Readonly<Record<string, string>>,
): AttachedServerEnvironment {
  const { env, unresolved, withheld } = attachmentEnvironment(
    db,
    agent.id,
    secrets,
    // Read at spawn and never held, exactly as the line above is: an
    // organisation secret this desktop's last sync withdrew must not go
    // on being injected by a closure that read it an hour ago.
    organisationSecrets === undefined ? undefined : (name: string) => readOrganisationSecretEntry(organisationSecrets, name),
    // The last layer a declared name is filled from (EO-488).
    variables,
  );
  for (const gap of unresolved) {
    console.warn(
      `[eo] ${agent.name}'s "${gap.server}" server declares ${gap.name}, and EO ` +
        `${gap.reason === "absent" ? "has no value for it" : "can no longer read the value it holds for it"}.`,
    );
  }
  return { env, withheld };
}

/**
 * What an agent run on a step is given of the environment variables
 * (EO-487): every shared one, with the step's own over them. A function
 * of its own so the composition root reads as wiring.
 */
function runEnvironmentFor(secrets: ModuleSecretsOptions): (stepId: string | null, trialScope?: string) => Record<string, string> {
  return (stepId, trialScope) => agentRunVariables(secrets, stepId, trialScope);
}

/** What a redirected step's agent run starts without (EO-584). A function of its own for `runEnvironmentFor`'s reason. */
function withheldFor(secrets: ModuleSecretsOptions): (stepId: string, trialScope: string) => string[] {
  return (stepId, trialScope) => redirectWithheldVariables(secrets, stepId, trialScope);
}

/**
 * Where this agent's CLI actually is (A-08).
 *
 * Null means "let the SDK decide", which in a packaged build means
 * nothing to run — the Agents screen says so and offers to fetch it.
 */
function configuredExecutablePath(agent: Agent): string | null {
  const value = agent.config["executablePath"];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function runtimeSourceForAgent(agent: Agent, runtimeRoot: string, db: Db): RunRuntimeSource | null {
  if (agent.provider !== "claude" && agent.provider !== "codex") return null;
  const resolved = resolveRuntime({
    spec: RUNTIMES[agent.provider],
    root: runtimeRoot,
    configuredPath: configuredExecutablePath(agent),
    managedEnabled: managedRuntimeEnabled({ db }, agent.provider),
  });
  if (resolved.source === "cache") return "managed";
  return resolved.source === "configured" ? "configured" : null;
}

function runtimePathFor(provider: string, runtimeRoot: string, db: Db, configuredPath: string | null): string | null {
  if (provider !== "claude" && provider !== "codex") return null;
  return resolveRuntime({
    spec: RUNTIMES[provider],
    root: runtimeRoot,
    configuredPath,
    managedEnabled: managedRuntimeEnabled({ db }, provider),
  }).path;
}

// The three capability predicates moved to `@eo/core`
// (`agent-capabilities.ts`) when the dispatch context started asking the
// same question this file does: whether an agent has the full-thread read
// decides both what its prompt contains and what it may fetch, and those
// two must be one answer. The reasoning they were written with — named
// tools, never `agent.role`, because roles are configuration (ARCHITECTURE.md, "An agent is a row")
// — is
// unchanged and now stated there.

/**
 * The value a Codex dispatch hands an attached server for one declared
 * name, read at the moment it is asked (EO-328, EO-377).
 *
 * **The organisation's value for a name wins over this machine's own**,
 * and is asked first for that reason — the precedence
 * `attachmentEnvironment` applies on the Claude path, so a server is
 * handed the same credential whichever backend its agent runs on.
 *
 * **An unreadable organisation value stops the fallback rather than
 * passing it**, which is why this is not
 * `readOrganisationSecret(…) ?? readMcpServerSecret(…)`. That form
 * collapsed "there but undecipherable" into "absent" and handed the
 * server the *person's* value of the same name — a personal secret
 * shadowing an organisation one in exactly the failure state nobody
 * would notice. `attachmentEnvironment` takes the same care, and says
 * more about why. It answers `SECRET_WITHHELD` rather than null, because
 * null leaves the name to whatever the Codex CLI inherited, and a
 * variable of that name in the person's shell is a substitution of the
 * same kind (EO-377). The variable arrives unset, which is what a server
 * reads as "you are not signed in" — the honest answer, and a long way
 * better than a wrong credential.
 *
 * An empty organisation value is a value: it wins like any other.
 *
 * **A name neither holds is filled from the run's environment variables**
 * (EO-488), handed in per client by the adapter: the order is the
 * organisation's value, the server's own secret, the step's variable and
 * the shared variable, the last two already composed.
 *
 * Exported so that precedence can be asserted against real stores.
 */
export function codexServerSecretReader(
  attachedSecrets: McpServerSecretsOptions | undefined,
  organisationSecrets: OrganisationSecretsOptions | undefined,
): (serverId: string, name: string, variables?: Readonly<Record<string, string>>) => ServerSecretRead {
  return (serverId, name, variables = {}) => {
    const theirs = organisationSecrets ? readOrganisationSecretEntry(organisationSecrets, name) : { state: "absent" as const };
    if (theirs.state === "value") return theirs.value;
    if (theirs.state === "unreadable") return SECRET_WITHHELD;
    const own = attachedSecrets ? readMcpServerSecret(attachedSecrets, serverId, name) : null;
    if (own !== null) return own;
    // The run's environment variables, last (EO-488): the step's over
    // the shared, already composed by `agentRunVariables`. A secret of
    // the server's own that no longer decrypts is not a value, and a
    // variable fills it as the inherited environment always has — the
    // rule `attachmentEnvironment` applies on the other backend.
    return Object.hasOwn(variables, name) ? (variables[name] as string) : null;
  };
}

/**
 * What an agent has attached, and where the values behind it are kept.
 *
 * One argument rather than two because they are one subject, and because
 * `buildProvider`'s positional list is already long enough that a pair
 * of same-shaped optionals at the end of it would be transposable
 * without the compiler noticing — the reason `ProviderIdentity` exists a
 * few lines up.
 */
interface AgentAttachmentDelivery {
  servers: McpServer[];
  /**
   * Unfiltered, like the servers, and for the same reason: the one rule
   * about what a disabled or archived row does lives where the delivery
   * is written, not in a second copy here (EO-207).
   */
  skills: Skill[];
  secrets?: McpServerSecretsOptions;
}

function buildProvider(
  agent: Agent,
  eoMcpServerPath: string,
  dbPath: string | undefined,
  executablePath: string | null,
  sdkEntryPath: string | null,
  demoProviderDelayMs?: number,
  runtimeRoot?: string,
  apiKeys?: ApiKeyStoreOptions,
  attachments?: AgentAttachmentDelivery,
  attachmentEnv?: (variables: Readonly<Record<string, string>>) => AttachedServerEnvironment,
  adminMcp?: AdminMcpLookup,
  /** The organisation's named values, for the backend that reads them one at a time (EO-328). */
  organisationSecrets?: OrganisationSecretsOptions,
  /** Where this agent's own Codex home goes, when it is locked down (EO-378). */
  codexHomeRoots?: readonly string[],
  /** The command Codex runs as EO's broad-search hook (EO-379). */
  codexSearchHookCommandPath?: string,
): AgentProvider {
  const enableCommentTool = commentToolEnabled(agent);
  const enableConfigTools = configToolsEnabled(agent);
  // Writing to memory mid-run (EO-479): a grant, read the way the comment
  // tool's is, and handed to both backends inside `eoMcp`.
  const enableMemoryNote = memoryNoteEnabled(agent);
  // Bound once so the closure below can be narrowed: the reader is
  // handed to the provider and called at each spawn, long after this.
  const attachedSecrets = attachments?.secrets;
  // The unbounded read of an item and its whole thread. Only the roles
  // whose work *is* the conversation have it; everything else is seeded
  // and searches. Same predicate the dispatch context asks, so the prompt
  // and the tool list cannot disagree about what an agent can see.
  const enableFullThread = fullThreadEnabled(agent);
  // Only ever passed when the config tools are on: `runtimes_list` is the
  // one reader, and an agent that cannot call it has no business being
  // told where EO keeps its binaries.
  const eoMcp = {
    serverPath: eoMcpServerPath,
    ...(dbPath ? { dbPath } : {}),
    ...(enableConfigTools && runtimeRoot ? { runtimeRoot } : {}),
    enableFullThread,
    enableCommentTool,
    enableConfigTools,
    enableMemoryNote,
  };
  switch (agent.provider) {
    case "codex":
      return createCodexProvider({
        eoMcp,
        executablePath,
        // EO-108: what a person ticked onto this agent, merged into the
        // `mcp_servers` object `eo` already sits in.
        ...(attachments ? { attachedServers: attachments.servers } : {}),
        // EO-207: and what a person ticked onto it out of the other
        // catalogue, which until now reached this backend not at all.
        ...(attachments ? { attachedSkills: attachments.skills } : {}),
        // Read per spawn, not captured here, for the reason the Claude
        // API key below is: this provider is cached, and a value read
        // once would be a value the cache outlives — which is also what
        // keeps every secret out of the cache key (`providerCacheKey`).
        // The organisation's value for a name is asked first (EO-328).
        // The run's environment variables are the last layer (EO-488),
        // so the reader is handed even where EO holds no secret store.
        serverSecret: codexServerSecretReader(attachedSecrets, organisationSecrets),
        // EO's own administrative server, which until EO-203 reached only
        // the other backend: it was delivered by writing a `.mcp.json`
        // into the generated tool directory, and that directory is the
        // Claude CLI's arrangement. Codex assembles `mcp_servers` itself,
        // so it is handed the fact instead of the file.
        //
        // Unconditional, and read per turn: with no host to ask, this
        // answers null — the same answer every agent but one gets, and the
        // answer this agent gets before the listener has bound.
        admin: (directory) => adminDispatchFor(agent, adminMcp, directory),
        // EO-378: the agent's own Codex home, made ready per turn. The
        // provider skips it when the agent is ticked over to the
        // person's own setup — the flag is in `config` below, and the
        // adapter is where it is read, as on Claude.
        ...(codexHomeRoots ? { codexHome: () => readyCodexHome(codexHomeRoots, agent.id) } : {}),
        // Nothing here says whether a turn must be inside a Git
        // repository (EO-386). That was decided on this line, from the
        // agent's role, for this backend only — and this provider is
        // cached per agent, so the answer was fixed for every item the
        // agent worked. It is the item's workspace kind that knows, per
        // turn, and the supervisor asks it before either adapter runs.
        // The same judgement the Claude adapter below is handed, and
        // the same function (EO-379): one classifier, in the pack, and
        // two adapters that each only deliver it. The path is this
        // backend's delivery — a Codex hook is a command.
        searchNudge: repositorySearchNudge,
        ...(codexSearchHookCommandPath ? { searchHookCommandPath: codexSearchHookCommandPath } : {}),
        config: { ...(agent.config as CodexAgentConfig), ...(agent.model ? { model: agent.model } : {}) },
        // Either an event `mapThreadEvent` does not know or an app-server
        // notification nothing translates (EO-372); named by its own key.
        onUnmappedEvent: (event) => console.warn(`[eo] unmapped Codex event: ${"method" in event ? event.method : event.type}`),
      });

    case "claude":
      return createClaudeProvider({
        eoMcp,
        enableCommentTool,
        executablePath,
        sdkEntryPath,
        // EO-84: read per turn, not captured here. This provider is
        // cached for the life of the process, and a key added or removed
        // from the Runtimes card has to take effect on the next dispatch
        // rather than the next launch.
        ...(apiKeys ? { apiKey: () => readApiKey(apiKeys, "claude") } : {}),
        // The values behind the `${VAR}` names in this agent's generated
        // `.mcp.json`, on the same terms as the key above and for the
        // same reason (EO-107).
        ...(attachmentEnv ? { attachmentEnv } : {}),
        // EO's own administrative server's bearer, one per turn and let go
        // of when the turn is over (EO-444) — the same call the Codex
        // branch above makes. The URL is already in this agent's
        // `.mcp.json`, written by `adminDeliveryFor` when its directory
        // was prepared; what is per turn is the credential.
        admin: (directory) => adminDispatchFor(agent, adminMcp, directory),
        // The judgement about broad searches is repository intelligence's
        // and the adapter only delivers it (KAN-126). Supplied here, by
        // the composition root, until the developer pack supplies it.
        searchNudge: repositorySearchNudge,
        config: { ...(agent.config as ClaudeAgentConfig), ...(agent.model ? { model: agent.model } : {}) },
        onUnmappedMessage: (message) => console.warn(`[eo] unmapped Claude message: ${message.type}`),
      });

    default:
      // Unknown or "fake": the demo provider, which takes a feature in
      // and decomposes it so EO is worth looking at before anyone signs
      // in — and stops at `implement` saying why, because a placeholder
      // cannot write code (KAN-34).
      //
      // This used to be one generic result for every action, which
      // satisfied no schema, so the first thing anyone did produced a
      // validation escalation.
      return createDemoProvider(demoProviderDelayMs === undefined ? {} : { delayMs: demoProviderDelayMs });
  }
}

/**
 * Is the agent's backend signed in? (EO-82)
 *
 * Asked of the executable this agent would actually run — its own
 * `executablePath` when it has one, EO's managed copy otherwise — rather
 * than of files under `$HOME`, which described neither. The answer is
 * cached briefly, so running this before every dispatch costs one spawn
 * per runtime rather than one per dispatch, and it turns "not signed in"
 * into a comment on the item instead of a stream that dies partway
 * through.
 */
async function checkAgentAuth(
  agent: Agent,
  runtimeRoot: string,
  db: Db,
  apiKeys?: ApiKeyStoreOptions,
  codexHomeRoots?: readonly string[],
): Promise<{ ok: boolean; reason?: string }> {
  const executablePath = runtimePathFor(agent.provider, runtimeRoot, db, configuredExecutablePath(agent));
  const verdict = await checkRuntimeAuth({
    provider: agent.provider,
    agentName: agent.name,
    executablePath,
    // A key EO holds is invisible to `claude auth status` — it is spent
    // at spawn, in that child's environment — so without this the
    // preflight would park every dispatch on a machine whose only
    // credential is the one EO is about to inject (EO-84).
    storedKey: agent.provider === "claude" && hasApiKey(apiKeys, "claude"),
  });
  if (!verdict.ok || agent.provider !== "codex" || !codexHomeRoots || inheritsAmbientConfig(agent.config)) return verdict;
  // The card's answer is asked again rather than threaded out of the
  // call above, and costs nothing: that call just put it in the cache
  // this reads from.
  return codexHomePreflight(agent, db, codexHomeRoots, async () => (await runtimeAuth({ provider: "codex", executablePath })).state);
}

/**
 * Every folder a locked-down Codex agent's home can be in (EO-378): EO's
 * own, and the one in the person's profile used when that is on another
 * drive. Undefined where no root was given — a test, or the v1 gate.
 */
export function codexHomeRootsOf(options: Pick<EngineOptions, "codexHomeRoot" | "codexHomeAlternateRoot">): string[] | undefined {
  return options.codexHomeRoot ? [options.codexHomeRoot, ...(options.codexHomeAlternateRoot ? [options.codexHomeAlternateRoot] : [])] : undefined;
}

/**
 * The half of the Codex preflight a locked-down agent adds (EO-378):
 * its own home made ready, homes nobody uses any more swept, and a
 * refusal where the dispatch would run signed out while the Runtimes
 * card — `cardSays`, which asks the person's own home — says signed in.
 * Or, when the person's sign-in is in the keyring, none of that: the
 * agent runs in their own home (decided on EO-378).
 *
 * Exported so the refusal and the sweep can be asserted against a real
 * database without spawning a CLI to ask.
 */
export async function codexHomePreflight(
  agent: Agent,
  db: Db,
  roots: readonly string[],
  cardSays: () => Promise<"signed_in" | "signed_out" | "unknown">,
  seams: CodexHomeSeams = {},
): Promise<{ ok: boolean; reason?: string }> {
  const choice = chooseCodexHome({ ...seams, roots, agentId: agent.id });
  await sweepUnusedCodexHomes(db, roots);
  // An agent running in the person's own home, because their sign-in is
  // in the keyring, asks the home the card asks: nothing to refuse, and
  // `codexOwnSetupNotices` tells the item why it is not locked down. One
  // with no home it could be given is refused.
  const refusal = codexHomeRefusal(choice, await cardSays(), agent.name);
  return refusal === null ? { ok: true } : { ok: false, reason: refusal };
}

/** The platform and filesystem `chooseCodexHome` works against — the Windows path, in a test. */
type CodexHomeSeams = Pick<CodexHomeOptions, "platform" | "fs">;

/**
 * This agent's own Codex home, ready to run in; null for the person's
 * own, when their sign-in is in the keyring; and a turn that fails saying
 * why when no home could be made — never a run in the person's home
 * that nobody asked for (EO-378). The preflight refuses that case first.
 */
function readyCodexHome(roots: readonly string[], agentId: string): string | null {
  const choice = chooseCodexHome({ roots, agentId });
  if (choice.kind === "unavailable") throw new Error(choice.problem);
  return choice.kind === "own" ? choice.path : null;
}

/** The side calls' own Codex home; throws with the reason where there can be none (`sideCallCodexHome`). */
function sideCallHome(roots: readonly string[]): string {
  const home = sideCallCodexHome({ roots });
  if (!home.ok) throw new Error(home.problem);
  return home.path;
}

/**
 * The note a locked-down Codex agent's dispatch carries when it runs with
 * the person's own setup after all (EO-378): their sign-in is in the
 * keyring. Empty for every other agent.
 */
export function codexOwnSetupNotices(agent: Agent, roots: readonly string[], seams: CodexHomeSeams = {}): string[] {
  if (agent.provider !== "codex" || inheritsAmbientConfig(agent.config)) return [];
  const choice = chooseCodexHome({ ...seams, roots, agentId: agent.id });
  return choice.kind === "person" ? [choice.notice(agent.name)] : [];
}

/**
 * Removes the Codex homes no agent uses any more (EO-378). Never rejects.
 *
 * Two callers: the dispatch preflight, and `startMain` once the window
 * is open — the one that runs when no Codex agent is ever dispatched
 * again. Asynchronous throughout since EO-566, because the second ran
 * before the first paint and walked directories on the event loop the
 * window is answered on.
 */
export async function sweepUnusedCodexHomes(db: Db, roots: readonly string[]): Promise<void> {
  try {
    // With the sign-in in the keyring every Codex agent runs in the
    // person's own home, so no agent's home is in use.
    const keyring = await signInIsInKeyringAsync();
    const keep = (): ReadonlySet<string> => (keyring ? new Set<string>() : agentsWithCodexHomes(listAgents(db)));
    for (const root of roots) await sweepCodexHomes(root, keep);
  } catch (error) {
    console.warn(`[eo] could not sweep unused Codex homes: ${error instanceof Error ? error.message : String(error)}`);
  }
}
