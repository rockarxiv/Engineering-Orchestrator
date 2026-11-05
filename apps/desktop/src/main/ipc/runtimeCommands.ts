import type { IpcPayload, IpcResponse, RuntimeAuthView, RuntimeStatusView } from "@eo/core";
import { readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { RUNTIMES, versionFor, type RuntimeId, type RuntimeSpec } from "../runtimes/catalog.js";
import { installRuntime, resolveRelease, type FetchLike } from "../runtimes/install.js";
import { resolveRuntime } from "../runtimes/resolve.js";
import { cachedRuntimeAuth, invalidateRuntimeAuth, runtimeAuth, type AuthProbeRunner } from "../runtimes/auth.js";
import { cancelSignIn, signInWithApiKey, startSignIn, submitSignInCode, type SignInSpawner } from "../runtimes/signIn.js";
import { clearApiKey, hasApiKey, storeApiKey, type ApiKeyStoreOptions } from "../runtimes/apiKey.js";
import { CLAUDE_SDK, installPackageSet, resolvePackageSet } from "../runtimes/packages.js";
import type { Db } from "../db/client.js";
import { clearSetting, getSetting, listActiveRuns, listAgents, setSetting } from "../db/repos/index.js";
import { personCodexHome, signInIsInKeyring } from "../providers/codexHome.js";

/**
 * The agent-runtime commands (A-08).
 *
 * EO downloads provider runtimes only after one explicit consent. That
 * consent is durable: later EO releases reconcile to their pinned versions
 * automatically and discard superseded managed copies after success.
 */

export interface RuntimeContext {
  /** `userData/runtimes` in production. */
  root: string;
  /** The seam, as everywhere else — no test here touches the network. */
  fetchImpl: FetchLike;
  db?: Db;
  onChanged?: () => void;
  /** Seam for tests — asking a runtime whether it is signed in spawns it (EO-82). */
  authProbe?: AuthProbeRunner;
  /** Seam for tests — a sign-in spawns the CLI's own `login` and drives it (EO-83). */
  signInSpawn?: SignInSpawner;
  /**
   * How a URL reaches the person's browser — `shell.openExternal` in
   * production (EO-83).
   *
   * Injected rather than imported so `runtimes/signIn.ts` stays free of
   * `electron`, the same way `fetchImpl` keeps the network out of it.
   */
  openExternal?: (url: string) => Promise<void>;
  /**
   * Where a Claude API key typed into EO is kept (EO-84).
   *
   * `userData/credentials` in production — the directory the Jira
   * tokens are already in, under the same keychain and the same rule.
   * Omitted, EO simply holds no key: every status reads as it did
   * before, and storing one answers with the reason it could not.
   */
  apiKeys?: ApiKeyStoreOptions;
}

/**
 * The machine being asked about.
 *
 * Every field is a fact about the host, and every one of them is
 * overridable so platform-specific resolution can be tested without
 * making a test depend on its host machine.
 */
export interface Machine {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

type ManagedProvider = "codex" | "claude";
type UpdateState = { state: "updating" | "error"; problem: string | null };
const updates = new Map<string, UpdateState>();
const inFlight = new Map<string, Promise<IpcResponse<"runtime:install">>>();

function providerOf(value: string): ManagedProvider | null {
  if (value === "codex") return "codex";
  if (value === "claude" || value === CLAUDE_SDK.id) return "claude";
  return null;
}

function consentKey(provider: ManagedProvider): string {
  return `runtimes.autoUpdate.${provider}`;
}

function enabledKey(provider: ManagedProvider): string {
  return `runtimes.enabled.${provider}`;
}

function cachePrefixes(provider: ManagedProvider): string[] {
  return provider === "claude" ? ["claude@", `${CLAUDE_SDK.id}@`] : ["codex@"];
}

function hasManagedCache(root: string, provider: ManagedProvider): boolean {
  try {
    return readdirSync(root).some((name) => cachePrefixes(provider).some((prefix) => name.startsWith(prefix)) && !name.endsWith(".partial"));
  } catch {
    return false;
  }
}

function automaticUpdates(context: RuntimeContext, provider: ManagedProvider): boolean {
  if (!context.db) return false;
  const existing = getSetting<boolean | null>(context.db, consentKey(provider), null);
  if (existing !== null) return existing;
  const inferred = hasManagedCache(context.root, provider);
  if (inferred) setSetting(context.db, consentKey(provider), true);
  return inferred;
}

function setAutomaticUpdates(context: RuntimeContext, provider: ManagedProvider, enabled: boolean): void {
  if (context.db) setSetting(context.db, consentKey(provider), enabled);
}

/** Durable independently of update consent: disabling selects no managed binary but removes nothing. */
export function managedRuntimeEnabled(context: Pick<RuntimeContext, "db">, provider: ManagedProvider): boolean {
  return context.db ? getSetting(context.db, enabledKey(provider), true) : true;
}

function configuredExecutablePath(config: Record<string, unknown>): string | null {
  const value = config["executablePath"];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Queued or running work launched against EO's managed copy.
 *
 * `agentName` is null when the agent has since been deleted. The run
 * itself is still live and still holding the files open, which is why
 * the row survives the lookup rather than being filtered out by it.
 */
function activeManagedRuns(context: RuntimeContext, provider: ManagedProvider): { agentName: string | null }[] {
  if (!context.db) return [];
  const agentsById = new Map(listAgents(context.db).map((agent) => [agent.id, agent]));
  return listActiveRuns(context.db)
    .filter((run) => {
      const agent = run.agentId === null ? undefined : agentsById.get(run.agentId);
      if ((run.provider ?? agent?.provider) !== provider) return false;
      if (run.runtimeSource !== null) return run.runtimeSource === "managed";
      // Rows created before EO-41 have no immutable snapshot. Preserve
      // the old conservative inference for those until they leave the
      // queued/running set, and stay conservative about a run whose
      // agent is gone: unknown is not the same as "not managed".
      return agent === undefined || configuredExecutablePath(agent.config) === null;
    })
    .map((run) => ({ agentName: (run.agentId === null ? undefined : agentsById.get(run.agentId))?.name ?? null }));
}

/**
 * The named agents behind that work.
 *
 * Disable asks only this much: it changes no files, so a run whose
 * agent has been deleted is not something disabling can break, and
 * naming nobody in the refusal would leave someone with no way to act
 * on it. Removal takes the wider view — see `removeManagedRuntime`.
 */
function activeManagedUsers(context: RuntimeContext, provider: ManagedProvider): string[] {
  return activeManagedRuns(context, provider).flatMap((run) => (run.agentName === null ? [] : [run.agentName]));
}

function componentsFor(context: RuntimeContext, provider: ManagedProvider, machine: Machine = {}) {
  const platform = machine.platform ?? process.platform;
  const arch = machine.arch ?? process.arch;
  const spec = RUNTIMES[provider];
  const cli = resolveRuntime({ spec, root: context.root, platform, arch });
  const components: Array<{ id: string; label: string; version: string; installed: boolean; packageName: string | null }> = [
    {
      id: provider,
      label: `${spec.label} CLI`,
      version: versionFor(spec, platform, arch) ?? spec.version,
      installed: cli.source === "cache" || cli.source === "configured",
      packageName: spec.packageFor(platform, arch),
    },
  ];
  if (provider === "claude") {
    components.push({
      id: CLAUDE_SDK.id,
      label: CLAUDE_SDK.label,
      version: CLAUDE_SDK.version,
      installed: resolvePackageSet(context.root, CLAUDE_SDK) !== null,
      packageName: CLAUDE_SDK.packages[0]?.name ?? null,
    });
  }
  return { cli, components };
}

export function managedProviderReady(
  context: Pick<RuntimeContext, "root" | "db"> & { configuredPath?: string | null },
  provider: string,
): boolean {
  if (provider !== "codex" && provider !== "claude") return true;
  const cli = resolveRuntime({
    spec: RUNTIMES[provider],
    root: context.root,
    configuredPath: context.configuredPath ?? null,
    managedEnabled: managedRuntimeEnabled(context, provider),
  });
  if (cli.source !== "cache" && cli.source !== "configured") return false;
  return provider !== "claude" || resolvePackageSet(context.root, CLAUDE_SDK) !== null;
}

function specFor(provider: string): RuntimeSpec | null {
  return provider in RUNTIMES ? RUNTIMES[provider as RuntimeId] : null;
}

/** Legacy component id retained for callers that describe the SDK alone. */
function isPackageSet(provider: string): boolean {
  return provider === CLAUDE_SDK.id;
}

/**
 * Where this machine's copy is, if it has one.
 *
 * Reports the source as well as the path so the UI can distinguish an
 * explicit enterprise override from EO's managed cache.
 */
export function runtimeStatus(
  context: RuntimeContext,
  input: IpcPayload<"runtime:status">,
  machine: Machine = {},
): IpcResponse<"runtime:status"> {
  const provider = providerOf(input.provider);
  const spec = provider ? RUNTIMES[provider] : specFor(input.provider);
  // `fake` and anything added later that runs in-process. Not an error:
  // "this backend needs no CLI" is a real and correct answer.
  if (!spec) return { runtime: null };

  const platform = machine.platform ?? process.platform;
  const arch = machine.arch ?? process.arch;
  const managed = provider ?? (spec.id as ManagedProvider);
  const { cli: resolved, components } = componentsFor(context, managed, machine);
  const ready = components.every((component) => component.installed);
  const update = updates.get(`${context.root}:${managed}`);
  const consent = automaticUpdates(context, managed);
  const enabled = managedRuntimeEnabled(context, managed);
  const state = !enabled && resolved.source === "cache"
    ? "disabled"
    : update?.state ?? (ready ? "ready" : consent ? "updating" : "needs_consent");
  const usedBy = context.db
    ? listAgents(context.db)
        .filter((agent) => agent.provider === managed)
        .map((agent) => ({ id: agent.id, name: agent.name, enabled: agent.enabled }))
    : [];

  return {
    runtime: {
      id: managed,
      label: spec.label,
      publisher: spec.publisher,
      termsUrl: spec.termsUrl,
      source: resolved.source,
      path: resolved.path,
      version: resolved.version,
      packageName: spec.packageFor(platform, arch),
      packageVersion: versionFor(spec, platform, arch),
      state,
      enabled,
      // The last answer, never a fresh probe: this function is called
      // from write paths that re-read status after changing a
      // preference, and none of them has any business spawning a CLI.
      // `runtimeStatusWithAuth` is the one caller that asks.
      auth: cachedRuntimeAuth(managed, authTarget(context, managed, input, machine), { storedKey: storedKeyFor(context, managed) }),
      automaticUpdates: consent,
      problem: update?.problem ?? null,
      usedBy,
      components,
      // Whether Codex agents can be locked down at all on this machine
      // (EO-378). Only ever present as true, so a status about any other
      // backend — or a Codex that keeps a file — is exactly what it was.
      ...(managed === "codex" && signInIsInKeyring(personCodexHome(machine.env ?? process.env, machine.home ?? homedir())) ? { codexSignInInKeyring: true } : {}),
    } satisfies RuntimeStatusView,
  };
}

/**
 * Which binary this question is about (EO-82).
 *
 * The same resolution dispatch does — the agent's own `executablePath`
 * when the caller named one, EO's managed copy otherwise, and nothing
 * at all when the managed copy is disabled and no path was set. Being
 * signed in is a fact about a *binary*, so an answer resolved any other
 * way describes some copy other than the one that would run: an agent
 * pointed at a signed-out `/usr/local/bin/claude` would read
 * "Connected" beside its provider picker on the strength of EO's
 * managed copy, while dispatch refused it.
 *
 * Only `auth` follows it. Everything else in the status — source,
 * version, components, updates — is about EO's managed copy, because
 * that is what the download, enable and remove controls act on, and an
 * agent's own executable has no lifecycle EO owns.
 */
function authTarget(context: RuntimeContext, provider: ManagedProvider, input: IpcPayload<"runtime:status">, machine: Machine): string | null {
  return resolveRuntime({
    spec: RUNTIMES[provider],
    root: context.root,
    configuredPath: input.executablePath ?? null,
    managedEnabled: managedRuntimeEnabled(context, provider),
    platform: machine.platform ?? process.platform,
    arch: machine.arch ?? process.arch,
  }).path;
}

/**
 * The same facts, plus the one only the binary can give (EO-82).
 *
 * Separate from `runtimeStatus` because probing runs a process. This is
 * what `runtime:status` answers with — the channel every surface that
 * *shows* a runtime renders from, and therefore the one place that
 * should pay for the spawn. The answer is cached briefly, so a tab full
 * of cards costs one probe per runtime rather than one per render, and
 * keyed on the executable, so asking on behalf of two agents with
 * different copies gets two honest answers rather than one shared one.
 */
export async function runtimeStatusWithAuth(
  context: RuntimeContext,
  input: IpcPayload<"runtime:status">,
  machine: Machine = {},
): Promise<IpcResponse<"runtime:status">> {
  const status = runtimeStatus(context, input, machine);
  const provider = providerOf(input.provider);
  if (status.runtime === null || provider === null) return status;

  const auth = await runtimeAuth({
    provider,
    executablePath: authTarget(context, provider, input, machine),
    storedKey: storedKeyFor(context, provider),
    ...(context.authProbe ? { run: context.authProbe } : {}),
  });
  return { runtime: { ...status.runtime, auth } };
}

/**
 * The backends this machine is signed in to (EO-314).
 *
 * What a data pack's recommendation is measured against: a pack may
 * recommend a backend and may not require one (ARCHITECTURE.md, "An agent is a row"), so the import
 * binds the agent it creates only where the answer below includes that
 * backend, and otherwise leaves it for a person to choose.
 *
 * `runtimeStatusWithAuth` per managed runtime, which is the same probe —
 * and the same short-lived cache — the Runtimes cards read. Two
 * consequences worth stating: this may spawn a CLI, so it belongs on a
 * person-initiated path and not in a loop; and `unknown` is not counted,
 * because a probe that could not answer is not a sign-in. The cost of
 * being wrong that way is an agent that arrives unbound, which is one
 * click to fix and the state the design expects anyway.
 */
export async function signedInBackends(context: RuntimeContext, machine: Machine = {}): Promise<string[]> {
  const answers = await Promise.all(
    (Object.keys(RUNTIMES) as ManagedProvider[]).map(async (provider) => {
      const status = await runtimeStatusWithAuth(context, { provider }, machine);
      return status.runtime?.auth?.state === "signed_in" ? provider : null;
    }),
  );
  return answers.filter((provider): provider is ManagedProvider => provider !== null);
}

/**
 * How this machine is signed in to each managed backend (EO-330, ARCHITECTURE.md, "Where a job
 * runs").
 *
 * `signedInBackends`' sibling, and asked for the same reason by the
 * same probe: where that one answers "can this machine run this
 * backend at all", placement needs "and is the credential one the
 * organisation's server could have too". A personal login — a
 * claude.ai or ChatGPT session — is this desktop's and nobody else's,
 * and a job whose pipeline needs one cannot be moved to a server.
 *
 * The caveats are that one's, verbatim: this may spawn a CLI, so it
 * belongs on a person-initiated path; and `unknown` is answered as
 * `unknown` rather than collapsed, because a probe that could not run
 * must not grey out a control on a machine that is perfectly well
 * signed in.
 *
 * A backend EO does not manage — a pack's own, the `fake` provider a
 * test binds — is absent from the map, which every reader treats as
 * `unknown`. EO has no way to ask it and saying either answer would be
 * inventing one.
 */
export async function backendAuthKinds(context: RuntimeContext, machine: Machine = {}): Promise<Map<string, RuntimeAuthView["kind"]>> {
  const answers = await Promise.all(
    (Object.keys(RUNTIMES) as ManagedProvider[]).map(async (provider) => {
      const status = await runtimeStatusWithAuth(context, { provider }, machine);
      return [provider, status.runtime?.auth?.kind ?? "unknown"] as const;
    }),
  );
  return new Map(answers);
}

/** What a backend is called where a person reads it. Its own id for one EO does not manage. */
export function backendLabel(provider: string): string {
  return RUNTIMES[provider as ManagedProvider]?.label ?? provider;
}

/**
 * Whether EO is holding this provider's key (EO-84).
 *
 * A boolean, never the key. It decides an *answer* — a runtime whose
 * only credential is the one EO injects at spawn is signed in, and
 * asking the binary would say the opposite — so it has to reach the
 * status and the dispatch preflight, both of which are read by things
 * that must never be one step from the secret.
 *
 * Only Claude can have one. Codex's key went to the CLI and belongs to
 * it, which is exactly what makes `storedKey` the right thing for the
 * card to hang a Remove button on.
 */
function storedKeyFor(context: RuntimeContext, provider: ManagedProvider): boolean {
  return provider === "claude" && hasApiKey(context.apiKeys, "claude");
}

/**
 * Signing a runtime in, driven from the app (EO-83).
 *
 * The binary is resolved exactly as `runtime:status` resolves it, and
 * for the same reason: signing in is a thing that happens to a
 * *binary*, so a flow that signed EO's managed copy in while the agent
 * runs its own `/usr/local/bin/claude` would have changed nothing the
 * dispatch can see.
 *
 * Everything past that resolution lives in `runtimes/signIn.ts`, which
 * knows how the two CLIs' login flows differ and nothing about IPC.
 */
export async function startRuntimeSignIn(
  context: RuntimeContext,
  input: IpcPayload<"runtime:startSignIn">,
  machine: Machine = {},
): Promise<IpcResponse<"runtime:startSignIn">> {
  return startSignIn({
    provider: input.provider,
    executablePath: authTarget(context, input.provider, input, machine),
    mode: input.mode,
    ...(context.signInSpawn ? { spawn: context.signInSpawn } : {}),
    ...(context.openExternal ? { openExternal: context.openExternal } : {}),
  });
}

/**
 * Hands the running child what remains and waits for it to exit.
 *
 * Takes no context: a session is addressed by the id `startRuntimeSignIn`
 * minted, and the child it belongs to is already running against a
 * binary that was resolved then. Re-resolving here could only disagree
 * with the process it is talking to.
 */
export async function submitRuntimeSignInCode(
  input: IpcPayload<"runtime:submitSignInCode">,
): Promise<IpcResponse<"runtime:submitSignInCode">> {
  return submitSignInCode({ sessionId: input.sessionId, code: input.code });
}

export function cancelRuntimeSignIn(input: IpcPayload<"runtime:cancelSignIn">): IpcResponse<"runtime:cancelSignIn"> {
  return cancelSignIn(input.sessionId);
}

/**
 * Signing in with a key rather than a subscription (EO-84).
 *
 * The two providers part company here, and this function is where the
 * pinned decision about who holds the secret is actually made:
 *
 * - **Codex** has a flag for it. The key is piped to `codex login
 *   --with-api-key` on stdin, the CLI stores it, and EO keeps nothing —
 *   the key exists in this process for as long as one spawn takes.
 * - **Claude** has none, so the key is written to EO's keychain and
 *   injected as `ANTHROPIC_API_KEY` when the provider spawns. Nothing
 *   about it goes to the database, and nothing comes back out of this
 *   function: the response says where it went, never what it was.
 *
 * `claude auth login --console` is the third option and is not here —
 * it is an ordinary browser flow, so it goes through
 * `runtime:startSignIn` like the subscription login it is shaped after.
 */
export async function signInWithRuntimeApiKey(
  context: RuntimeContext,
  input: IpcPayload<"runtime:signInWithApiKey">,
  machine: Machine = {},
): Promise<IpcResponse<"runtime:signInWithApiKey">> {
  if (input.provider === "codex") {
    const result = await signInWithApiKey({
      provider: "codex",
      executablePath: authTarget(context, "codex", input, machine),
      apiKey: input.apiKey,
      ...(context.signInSpawn ? { spawn: context.signInSpawn } : {}),
    });
    return { ok: result.ok, heldBy: result.ok ? "cli" : null, transcript: result.transcript, problem: result.problem };
  }

  if (!context.apiKeys) {
    return {
      ok: false,
      heldBy: null,
      transcript: "",
      problem: "EO has nowhere to keep a key on this machine, so it cannot store one. Signing in through the Anthropic Console works without one.",
    };
  }

  const stored = storeApiKey(context.apiKeys, "claude", input.apiKey.trim());
  if (!stored.ok) return { ok: false, heldBy: null, transcript: "", problem: stored.reason };

  // The binary has not changed and nobody has run its login, but the
  // answer has: this runtime is now authenticated by something only EO
  // knows about, and the cached probe result predates it.
  invalidateRuntimeAuth("claude");
  return { ok: true, heldBy: "eo", transcript: "", problem: null };
}

/**
 * Forgets a key EO stored, after which the runtime says what the binary
 * says (EO-84).
 *
 * Codex is refused rather than silently doing nothing. Its key is in
 * the CLI's own `auth.json` and deleting that would be reaching into
 * another product's credential store — the same thing the pinned
 * decision on abandoned sign-ins refused to do in the other direction.
 * The sentence says where to go instead.
 */
export function removeRuntimeApiKey(
  context: RuntimeContext,
  input: IpcPayload<"runtime:removeApiKey">,
): IpcResponse<"runtime:removeApiKey"> {
  if (input.provider === "codex") {
    return {
      ok: false,
      removed: false,
      problem:
        "EO holds no Codex key — the key you gave it went to the Codex CLI, which stores it. Start a new Codex sign-in to replace it.",
    };
  }

  if (!context.apiKeys) return { ok: true, removed: false, problem: null };

  const removed = clearApiKey(context.apiKeys, "claude");
  invalidateRuntimeAuth("claude");
  return { ok: true, removed, problem: null };
}

/**
 * What would be fetched, asked of the registry rather than guessed.
 *
 * A hardcoded "about 277 MB" is wrong the moment a version bumps, and
 * being wrong about the size of something you are asking permission to
 * download is exactly the wrong thing to be wrong about. The registry
 * reports the *unpacked* size, so that is what this is called and what
 * the dialog says — the transfer itself is gzipped and smaller.
 */
export async function describeRuntime(
  context: RuntimeContext,
  input: IpcPayload<"runtime:describe">,
  machine: Machine = {},
): Promise<IpcResponse<"runtime:describe">> {
  if (isPackageSet(input.provider)) return describePackageSet(context);

  const platform = machine.platform ?? process.platform;
  const arch = machine.arch ?? process.arch;
  const spec = specFor(input.provider);
  if (!spec) return { packageName: null, packageVersion: null, unpackedBytes: 0, sourceUrl: null, problem: null };

  const packageName = spec.packageFor(platform, arch);
  const packageVersion = versionFor(spec, platform, arch);
  if (!packageName || !packageVersion) {
    return {
      packageName: null,
      packageVersion: null,
      unpackedBytes: 0,
      sourceUrl: null,
      problem: `${spec.label} does not publish a build for ${platform} ${arch}. Set an executable path by hand if you have one.`,
    };
  }

  try {
    const release = await resolveRelease(context.fetchImpl, packageName, packageVersion);
    let unpackedBytes = release.unpackedBytes;
    if (input.provider === "claude") {
      for (const pin of CLAUDE_SDK.packages) {
        unpackedBytes += (await resolveRelease(context.fetchImpl, pin.name, pin.version)).unpackedBytes;
      }
    }
    return { packageName, packageVersion, unpackedBytes, sourceUrl: release.tarball, problem: null };
  } catch (error) {
    // The registry being unreachable is not a reason to hide the name of
    // what would be downloaded — that is the part the consent is about.
    return {
      packageName,
      packageVersion,
      unpackedBytes: 0,
      sourceUrl: null,
      problem: `EO could not reach the npm registry: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Fetches, verifies and unpacks — then re-resolves, so the reply is what resolution will actually find. */
export async function installRuntimeCommand(
  context: RuntimeContext,
  input: IpcPayload<"runtime:install">,
  machine: Machine = {},
): Promise<IpcResponse<"runtime:install">> {
  const provider = providerOf(input.provider);
  if (!provider) return { ok: false, runtime: null, problem: `${input.provider} has no managed runtime.` };
  setAutomaticUpdates(context, provider, true);
  return reconcileManagedProvider(context, provider, machine);
}

function activeDirectories(provider: ManagedProvider, machine: Machine = {}): Set<string> {
  const platform = machine.platform ?? process.platform;
  const arch = machine.arch ?? process.arch;
  const cliVersion = versionFor(RUNTIMES[provider], platform, arch);
  const active = new Set<string>();
  if (cliVersion) active.add(`${provider}@${cliVersion}`);
  if (provider === "claude") active.add(`${CLAUDE_SDK.id}@${CLAUDE_SDK.version}`);
  return active;
}

function cleanupSuperseded(context: RuntimeContext, provider: ManagedProvider, machine: Machine = {}): void {
  const active = activeDirectories(provider, machine);
  let entries: string[];
  try {
    entries = readdirSync(context.root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!cachePrefixes(provider).some((prefix) => name.startsWith(prefix))) continue;
    if (active.has(name)) continue;
    rmSync(join(context.root, name), { recursive: true, force: true });
  }
}

export async function reconcileManagedProvider(
  context: RuntimeContext,
  provider: ManagedProvider,
  machine: Machine = {},
): Promise<IpcResponse<"runtime:install">> {
  const key = `${context.root}:${provider}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const task = (async (): Promise<IpcResponse<"runtime:install">> => {
    updates.set(key, { state: "updating", problem: null });
    context.onChanged?.();
    const platform = machine.platform ?? process.platform;
    const arch = machine.arch ?? process.arch;

    try {
      const spec = RUNTIMES[provider];
      try {
        const resolved = resolveRuntime({ spec, root: context.root, platform, arch });
        if (resolved.source !== "cache" && resolved.source !== "configured") {
          const cli = await installRuntime({ spec, root: context.root, fetchImpl: context.fetchImpl, platform, arch });
          if (!cli.ok) throw new Error(cli.problem ?? `Installing ${spec.label} failed.`);
        }
        if (provider === "claude" && !resolvePackageSet(context.root, CLAUDE_SDK)) {
          const sdk = await installPackageSet({ spec: CLAUDE_SDK, root: context.root, fetchImpl: context.fetchImpl });
          if (!sdk.ok) throw new Error(sdk.problem ?? `Installing ${CLAUDE_SDK.label} failed.`);
        }
      } finally {
        // Whatever just happened, the binary EO would ask is not the one
        // the cached answer was about — a newly unpacked runtime nobody
        // has signed into must not inherit "signed in" from the copy it
        // replaced, and half an install is no safer to answer from.
        invalidateRuntimeAuth(provider);
      }
      // Completeness and selection are different facts. A disabled copy
      // may still receive an automatic update, and remaining disabled
      // after that successful update is not an installation failure.
      if (!componentsFor(context, provider, machine).components.every((component) => component.installed)) {
        throw new Error(`${RUNTIMES[provider].label} is still incomplete after installation.`);
      }

      cleanupSuperseded(context, provider, machine);
      updates.delete(key);
      const status = runtimeStatus(context, { provider }, machine);
      context.onChanged?.();
      return { ok: true, runtime: status.runtime, problem: null };
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      updates.set(key, { state: "error", problem });
      context.onChanged?.();
      return { ok: false, runtime: runtimeStatus(context, { provider }, machine).runtime, problem };
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, task);
  return task;
}

export function startManagedRuntimeReconciliation(context: RuntimeContext): void {
  for (const provider of ["codex", "claude"] as const) {
    // Even with updates disabled, a complete current version can safely
    // trigger cleanup without a download. An older-only cache is retained
    // until the user grants consent again, so a failed replacement remains
    // recoverable and no network work happens behind the toggle.
    if (!automaticUpdates(context, provider) && !managedProviderReady(context, provider)) continue;
    void reconcileManagedProvider(context, provider);
  }
}

export async function setRuntimeAutomaticUpdates(
  context: RuntimeContext,
  input: IpcPayload<"runtime:setAutomaticUpdates">,
): Promise<IpcResponse<"runtime:setAutomaticUpdates">> {
  setAutomaticUpdates(context, input.provider, input.enabled);
  if (!input.enabled) return { ok: true, runtime: runtimeStatus(context, { provider: input.provider }).runtime, problem: null };
  return reconcileManagedProvider(context, input.provider);
}

/**
 * Enables or disables selection of EO's cached runtime.
 *
 * The active-run check and preference write are deliberately synchronous.
 * Electron handles this command and scheduler dispatches on the same main
 * process event loop, so no dispatch can interleave between the check and
 * write. The supervisor performs its own final availability check after
 * async preflight to close the opposite race.
 */
export function setRuntimeEnabled(
  context: RuntimeContext,
  input: IpcPayload<"runtime:setEnabled">,
  // Threaded through for the same reason every other command here takes
  // it: the runtime it reports back is resolved for a machine, and a
  // caller that has already said which one should not have the answer
  // silently recomputed for the host instead.
  machine: Machine = {},
): IpcResponse<"runtime:setEnabled"> {
  if (!context.db) {
    return { ok: false, runtime: runtimeStatus(context, { provider: input.provider }, machine).runtime, problem: "Runtime preferences are unavailable." };
  }

  if (!input.enabled) {
    const active = activeManagedUsers(context, input.provider);
    if (active.length > 0) {
      const agents = [...new Set(active)].join(", ");
      return {
        ok: false,
        runtime: runtimeStatus(context, { provider: input.provider }, machine).runtime,
        problem: `${RUNTIMES[input.provider].label} cannot be disabled while queued or running work is using EO's managed copy (${agents}).`,
      };
    }
  }

  setSetting(context.db, enabledKey(input.provider), input.enabled);
  context.onChanged?.();
  return { ok: true, runtime: runtimeStatus(context, { provider: input.provider }, machine).runtime, problem: null };
}

/**
 * Every directory under EO's runtime root that belongs to this provider.
 *
 * Matched on the `<component>@` prefix EO itself names its install
 * directories with, so the answer is bounded by construction: nothing
 * outside `context.root`, and nothing inside it that EO did not unpack.
 * An agent's own `executablePath` points wherever that machine keeps
 * its copy and can never be one of these — which is the whole reason
 * removal is expressed as "the directories EO made" rather than "the
 * paths this provider resolves to".
 *
 * `.partial` trees are included: they are EO's litter from an
 * interrupted download, and leaving them behind would leave the
 * provider looking half-present on disk.
 *
 * Failing to read the root is reported rather than flattened to "no
 * directories". Everywhere else in this file that distinction does not
 * matter — an unreadable root infers no consent and cleans nothing up,
 * and both are harmless. Here it decides whether a removal that looked
 * at no file at all gets to call itself done.
 */
type ManagedDirectories = { ok: true; directories: string[] } | { ok: false; problem: string };

function managedDirectories(root: string, provider: ManagedProvider): ManagedDirectories {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (error) {
    // A root that does not exist is the one benign failure: it holds no
    // managed directory, so there is genuinely nothing of this
    // provider's to delete. Every other error means EO cannot see what
    // it owns, which is not the same as owning nothing.
    if ((error as { code?: string }).code === "ENOENT") return { ok: true, directories: [] };
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
  return {
    ok: true,
    directories: entries
      .filter((name) => cachePrefixes(provider).some((prefix) => name.startsWith(prefix)))
      .map((name) => join(root, name)),
  };
}

/**
 * Deletes EO's managed copy of a provider (A-08).
 *
 * Three things have to be true together, and none of them can be
 * decided in the renderer: no agent is configured for the provider, no
 * queued or running work is using the managed copy, and no update is
 * part-way through unpacking into the directories about to be deleted.
 * The confirmation dialog checks the first two so it can explain
 * itself, but a dialog can sit open for a minute while the machine
 * stops being idle underneath it — so they are checked again here,
 * against the same tables, immediately before anything is unlinked.
 *
 * Consent is revoked *before* the first `rmSync`. A crash between the
 * two leaves a partly-removed tree with automatic updates off, which
 * startup reconciliation ignores; the other order leaves one that
 * reconciliation helpfully reinstalls, which is the opposite of what
 * was asked for.
 */
export function removeManagedRuntime(
  context: RuntimeContext,
  input: IpcPayload<"runtime:remove">,
  machine: Machine = {},
): IpcResponse<"runtime:remove"> {
  const provider = input.provider;
  const label = RUNTIMES[provider].label;
  // Status is always re-read from disk and the database rather than
  // described from what was intended: a refusal and a partial failure
  // both have to report what is actually there now.
  const fail = (problem: string): IpcResponse<"runtime:remove"> => ({
    ok: false,
    runtime: runtimeStatus(context, { provider }, machine).runtime,
    problem,
  });

  if (!context.db) return fail("Runtime preferences are unavailable.");

  const configured = listAgents(context.db).filter((agent) => agent.provider === provider);
  if (configured.length > 0) {
    const names = configured.map((agent) => (agent.enabled ? agent.name : `${agent.name} (disabled)`)).join(", ");
    return fail(
      `${label} cannot be removed while agents are configured for it (${names}). Point them at another backend, or delete them, and try again.`,
    );
  }

  // Not covered by the check above: an agent can be deleted, or pointed
  // at another backend, while the run it started is still running. The
  // subprocess is still holding the managed executable open.
  const busy = activeManagedRuns(context, provider);
  if (busy.length > 0) {
    const names = [...new Set(busy.flatMap((run) => (run.agentName === null ? [] : [run.agentName])))];
    const who = names.length > 0 ? names.join(", ") : `${busy.length} run${busy.length === 1 ? "" : "s"} whose agent has since been deleted`;
    return fail(`${label} cannot be removed while queued or running work is using EO's managed copy (${who}).`);
  }

  const key = `${context.root}:${provider}`;
  if (inFlight.has(key)) {
    return fail(`${label} is being updated right now. Wait for that to finish, then remove it.`);
  }

  // Enumerated before consent is revoked, and deliberately: if EO
  // cannot read its own root it will delete nothing, and a removal that
  // touches no file should leave nothing behind it either — not a
  // revoked consent the user then has to grant again for a runtime that
  // is still installed and still working. The revoke-before-`rmSync`
  // ordering below is untouched; listing a directory is not deleting one.
  const managed = managedDirectories(context.root, provider);
  if (!managed.ok) {
    context.onChanged?.();
    return fail(
      `EO could not read its managed runtime folder (${context.root}): ${managed.problem}. Nothing was removed, and ${label} still reports whatever is on disk.`,
    );
  }

  setAutomaticUpdates(context, provider, false);

  const failures: string[] = [];
  for (const directory of managed.directories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(`${basename(directory)} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  if (failures.length > 0) {
    // Deliberately not clearing the disabled state: files are still
    // there, so a runtime the user had disabled must not come back
    // enabled as a side effect of a removal that did not happen.
    context.onChanged?.();
    return fail(
      `EO could not delete every ${label} file: ${failures.join("; ")}. Automatic updates are off, and the runtime now reports whatever is still on disk.`,
    );
  }

  // Disablement described a copy that no longer exists. Forgetting it
  // rather than storing `true` keeps one meaning for the key — "the
  // user said so" — and lets a later explicit install start enabled.
  clearSetting(context.db, enabledKey(provider));
  updates.delete(key);
  context.onChanged?.();

  return { ok: true, runtime: runtimeStatus(context, { provider }, machine).runtime, problem: null };
}

/**
 * The size of the whole set, summed from the registry.
 *
 * Seven packages, and the six after the first are only there because
 * Node resolves bare specifiers relative to the importing file. Showing
 * the SDK's size alone would understate what actually lands on disk,
 * and this number exists to be honest rather than flattering.
 */
async function describePackageSet(context: RuntimeContext): Promise<IpcResponse<"runtime:describe">> {
  const primary = CLAUDE_SDK.packages[0];
  try {
    let unpackedBytes = 0;
    let sourceUrl: string | null = null;
    for (const pin of CLAUDE_SDK.packages) {
      const release = await resolveRelease(context.fetchImpl, pin.name, pin.version);
      unpackedBytes += release.unpackedBytes;
      if (pin === primary) sourceUrl = release.tarball;
    }
    return { packageName: primary?.name ?? null, packageVersion: CLAUDE_SDK.version, unpackedBytes, sourceUrl, problem: null };
  } catch (error) {
    return {
      packageName: primary?.name ?? null,
      packageVersion: CLAUDE_SDK.version,
      unpackedBytes: 0,
      sourceUrl: null,
      problem: `EO could not reach the npm registry: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
