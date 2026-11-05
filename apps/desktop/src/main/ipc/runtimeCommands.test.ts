import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createAgent, createRun, updateAgent, updateRun } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import type { FetchLike } from "../runtimes/install.js";
import { CLAUDE_SDK } from "../runtimes/packages.js";
import { RUNTIMES, versionFor } from "../runtimes/catalog.js";
import { invalidateRuntimeAuth, type AuthProbeResult, type AuthProbeRunner } from "../runtimes/auth.js";
import type { SecretStore } from "../secrets/store.js";
import type { SignInProcess, SignInSpawner } from "../runtimes/signIn.js";
import { fixtureTar } from "../testing/tar.js";
import {
  cancelRuntimeSignIn,
  removeRuntimeApiKey,
  signInWithRuntimeApiKey,
  describeRuntime,
  installRuntimeCommand,
  managedProviderReady,
  reconcileManagedProvider,
  removeManagedRuntime,
  runtimeStatus,
  runtimeStatusWithAuth,
  setRuntimeEnabled,
  startManagedRuntimeReconciliation,
  startRuntimeSignIn,
  type RuntimeContext,
} from "./runtimeCommands.js";

/**
 * The runtime commands (A-08).
 *
 * These are what the Agents screen asks and what the consent dialog is
 * built from, so what matters is that they are *honest*: the size shown
 * is the registry's, the status reflects what resolution will actually
 * find, and a provider that runs no CLI says so rather than reporting a
 * missing one.
 */
let scratch: string;
let context: RuntimeContext;
let handle: DbHandle;
/**
 * A machine with no `claude` anywhere.
 *
 * Not optional: without it these read the developer's own PATH, and
 * "reports absent when nothing is installed" would pass or fail on
 * whether whoever ran the suite happens to have Claude Code.
 */
let machine: { platform: NodeJS.Platform; arch: string; env: NodeJS.ProcessEnv; home: string };

/**
 * Directory basenames whose deletion fails, by name.
 *
 * A removal that half-succeeds is a real state with its own required
 * behaviour, and there is no portable way to make a real `rmSync` fail
 * on demand: `chmod` does nothing on Windows, and the release workflow
 * runs this suite there. Everything else goes to the real filesystem,
 * so the only thing being faked is the failure itself.
 */
const undeletable = vi.hoisted(() => new Set<string>());
/**
 * Directories that cannot be listed, by absolute path.
 *
 * The other half of the same problem, for the same reason: a runtime
 * root EO cannot enumerate is a real state — a permission change, or
 * something that is no longer a directory — and one it must not mistake
 * for an empty one.
 */
const unlistable = vi.hoisted(() => new Set<string>());
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  // `readdirSync` is overloaded on its options, so delegation goes
  // through the single shape this codebase actually calls it with.
  const realReaddir = real.readdirSync as (path: string, options?: { withFileTypes?: true }) => unknown;
  return {
    ...real,
    readdirSync: ((path: string, options?: { withFileTypes?: true }) => {
      if (unlistable.has(path)) throw Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
      return realReaddir(path, options);
    }) as unknown as typeof real.readdirSync,
    rmSync: ((path: Parameters<typeof real.rmSync>[0], options?: Parameters<typeof real.rmSync>[1]) => {
      if (undeletable.has(basename(String(path)))) throw new Error("EACCES: permission denied");
      return real.rmSync(path, options);
    }) satisfies typeof real.rmSync,
  };
});

/** A tarball shaped like the npm package, plus a registry that serves it. */
function registry(): { fetchImpl: FetchLike; bytes: Buffer } {
  const source = join(scratch, "package");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "claude"), "#!/bin/sh\n", { mode: 0o755 });
  execFileSync(fixtureTar(), ["-czf", join(scratch, "p.tgz"), "-C", scratch, "package"]);
  const bytes = execFileSync("cat", [join(scratch, "p.tgz")], { encoding: "buffer" });

  const fetchImpl: FetchLike = async (url) =>
    url.endsWith(".tgz")
      ? new Response(bytes, { status: 200 })
      : new Response(
          JSON.stringify({
            versions: Object.fromEntries(
              [CLAUDE_VERSION, ...CLAUDE_SDK.packages.map((pin) => pin.version)].map((version) => [
                version,
                {
                dist: {
                  tarball: "https://registry.npmjs.org/pkg/-/pkg.tgz",
                  integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
                  unpackedSize: 277_000_000,
                },
                },
              ]),
            ),
          }),
          { status: 200 },
        );

  return { fetchImpl, bytes };
}

function placeCurrentClaude(): void {
  const cli = join(context.root, `claude@${CLAUDE_SDK.version}`, "claude");
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(cli, 0o755);
  const sdk = join(context.root, `${CLAUDE_SDK.id}@${CLAUDE_SDK.version}`, CLAUDE_SDK.entry);
  mkdirSync(dirname(sdk), { recursive: true });
  writeFileSync(sdk, "export {};");
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo runtime cmd "));
  handle = openMigratedTestDb();
  context = { root: join(scratch, "runtimes"), fetchImpl: async () => new Response("", { status: 500 }), db: handle.db };
  machine = { platform: "linux", arch: "x64", env: { PATH: "" }, home: join(scratch, "home") };
});

afterEach(() => {
  undeletable.clear();
  unlistable.clear();
  // Module-level and keyed on the executable, which these tests reuse
  // paths for — one test's answer would otherwise be the next one's.
  invalidateRuntimeAuth();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** A directory tree EO would have unpacked, with something inside it to prove it went. */
// Read off the catalog: these tests assert that the *pinned* build is
// the one found, reported and cleaned up, so restating a version here
// would let a bump turn them into tests about a stale directory.
const CLAUDE_VERSION = versionFor(RUNTIMES.claude, "linux", "x64")!;
const CODEX_VERSION = versionFor(RUNTIMES.codex, "linux", "x64")!;

function placeDirectory(...segments: string[]): string {
  const directory = join(context.root, ...segments);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "marker"), "x");
  return directory;
}

function placeCurrentCodex(): string {
  const directory = join(context.root, `codex@${CODEX_VERSION}`, "vendor", "x86_64-unknown-linux-gnu", "bin");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(join(directory, "codex"), 0o755);
  return join(context.root, `codex@${CODEX_VERSION}`);
}

describe("status", () => {
  it("says nothing rather than something wrong for a provider with no CLI", () => {
    // `fake` runs in-process. Reporting "not installed" for it would
    // send someone looking for a download that does not exist.
    expect(runtimeStatus(context, { provider: "fake" })).toEqual({ runtime: null });
  });

  it("reports absent, and what it would fetch, when there is nothing installed", () => {
    const { runtime } = runtimeStatus(context, { provider: "claude" }, machine);

    expect(runtime).toMatchObject({
      source: "absent",
      path: null,
      packageName: "@anthropic-ai/claude-agent-sdk-linux-x64",
      packageVersion: CLAUDE_VERSION,
      publisher: "Anthropic PBC",
    });
  });

  it("says when the person's Codex keeps its sign-in in the keyring, and says nothing otherwise (EO-378)", () => {
    // What an agent's editor reads to say that a Codex agent runs with
    // the person's own setup: no home of its own can reach a keyring
    // credential.
    const codexHome = join(scratch, "home", ".codex");
    mkdirSync(codexHome, { recursive: true });
    expect(runtimeStatus(context, { provider: "codex" }, machine).runtime).not.toHaveProperty("codexSignInInKeyring");

    writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
    expect(runtimeStatus(context, { provider: "codex" }, machine).runtime?.codexSignInInKeyring).toBe(true);
    expect(runtimeStatus(context, { provider: "claude" }, machine).runtime).not.toHaveProperty("codexSignInInKeyring");
    // `auto` too, even with a credential file beside it: Codex reads the
    // keyring first, so the file may be a stale one.
    writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "auto"\n');
    writeFileSync(join(codexHome, "auth.json"), "{}");
    expect(runtimeStatus(context, { provider: "codex" }, machine).runtime?.codexSignInInKeyring).toBe(true);

    // And it follows a CODEX_HOME the person set, as Codex does.
    const named = join(scratch, "elsewhere");
    mkdirSync(named);
    expect(runtimeStatus(context, { provider: "codex" }, { ...machine, env: { PATH: "", CODEX_HOME: named } }).runtime).not.toHaveProperty("codexSignInInKeyring");
  });

  it("asks the resolved binary whether it is signed in", async () => {
    // EO-82. The answer comes from running the executable EO resolved —
    // not from testing for files under $HOME, which described neither
    // the truth nor the copy that would actually run.
    const directory = join(context.root, `claude@${CLAUDE_VERSION}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "claude"), "#!/bin/sh\n");
    chmodSync(join(directory, "claude"), 0o755);
    const asked: { command: string; args: string[] }[] = [];
    const authProbe: AuthProbeRunner = async (command, args) => {
      asked.push({ command, args });
      return { ok: true, stdout: JSON.stringify({ loggedIn: false }), error: "", notFound: false } satisfies AuthProbeResult;
    };

    const { runtime } = await runtimeStatusWithAuth({ ...context, authProbe }, { provider: "claude" }, machine);

    expect(asked).toEqual([{ command: join(directory, "claude"), args: ["auth", "status", "--json"] }]);
    expect(runtime?.auth).toEqual({ state: "signed_out", method: null, kind: "unknown", storedKey: false, account: null, problem: null });
  });

  it("spawns once for a tab that asks repeatedly", async () => {
    // Rendering the Runtimes tab asks per card, per render. A process
    // per render is the thing the cache exists to prevent.
    const directory = join(context.root, `claude@${CLAUDE_VERSION}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "claude"), "#!/bin/sh\n");
    chmodSync(join(directory, "claude"), 0o755);
    let spawns = 0;
    const authProbe: AuthProbeRunner = async () => {
      spawns += 1;
      return { ok: true, stdout: JSON.stringify({ loggedIn: true }), error: "", notFound: false };
    };
    const asking = { ...context, authProbe };

    await runtimeStatusWithAuth(asking, { provider: "claude" }, machine);
    await runtimeStatusWithAuth(asking, { provider: "claude" }, machine);

    expect(spawns).toBe(1);
  });

  it("asks the agent's own executable when the question is about an agent", async () => {
    // EO-82, and the reason the answer is keyed on a path rather than
    // on a provider: an agent pointed at its own copy resolves a
    // different binary from EO's managed one. Asking the managed copy
    // and rendering the answer beside that agent's provider picker
    // would say "Connected" about a binary the agent will never run,
    // while dispatch — which does resolve the agent's own — refuses it.
    const directory = join(context.root, `claude@${CLAUDE_VERSION}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "claude"), "#!/bin/sh\n");
    chmodSync(join(directory, "claude"), 0o755);
    const asked: string[] = [];
    const authProbe: AuthProbeRunner = async (command) => {
      asked.push(command);
      return { ok: true, stdout: JSON.stringify({ loggedIn: command === join(directory, "claude") }), error: "", notFound: false };
    };
    const asking = { ...context, authProbe };

    const managed = await runtimeStatusWithAuth(asking, { provider: "claude" }, machine);
    const own = await runtimeStatusWithAuth(asking, { provider: "claude", executablePath: "/usr/local/bin/claude" }, machine);

    expect(asked).toEqual([join(directory, "claude"), "/usr/local/bin/claude"]);
    expect(managed.runtime?.auth.state).toBe("signed_in");
    expect(own.runtime?.auth.state).toBe("signed_out");
  });

  it("says unknown, never signed out, when there is nothing installed to ask", async () => {
    const authProbe: AuthProbeRunner = async () => {
      throw new Error("nothing should have been spawned");
    };

    const { runtime } = await runtimeStatusWithAuth({ ...context, authProbe }, { provider: "claude" }, machine);

    expect(runtime?.auth.state).toBe("unknown");
    expect(runtime?.auth.problem).toContain("no Claude Code executable");
  });

  it("carries the terms, because the consent dialog has to link to them", () => {
    const { runtime } = runtimeStatus(context, { provider: "claude" }, machine);

    expect(runtime?.termsUrl).toMatch(/^https:\/\//);
  });

  it("names no package for a platform nobody publishes a build for", () => {
    const { runtime } = runtimeStatus(context, { provider: "claude" }, { ...machine, platform: "freebsd" as NodeJS.Platform });

    expect(runtime).toMatchObject({ source: "absent", packageName: null, packageVersion: null });
  });

  it("reports what EO downloaded, with the version", () => {
    const directory = join(context.root, `claude@${CLAUDE_VERSION}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "claude"), "#!/bin/sh\n");
    chmodSync(join(directory, "claude"), 0o755);

    expect(runtimeStatus(context, { provider: "claude" }, machine).runtime).toMatchObject({
      source: "cache",
      version: CLAUDE_VERSION,
      path: join(directory, "claude"),
    });
  });

  it("lists every configured agent, including disabled agents", () => {
    createAgent(handle.db, { name: "Claude reviewer", role: "reviewer", provider: "claude", instructions: "Review.", enabled: true });
    createAgent(handle.db, { name: "Paused Claude", role: "tester", provider: "claude", instructions: "Test.", enabled: false });

    expect(runtimeStatus(context, { provider: "claude" }, machine).runtime?.usedBy).toEqual([
      expect.objectContaining({ name: "Claude reviewer", enabled: true }),
      expect.objectContaining({ name: "Paused Claude", enabled: false }),
    ]);
  });
});

describe("managed runtime lifecycle", () => {
  it("persists disablement separately from files and automatic updates, then enables without fetching", async () => {
    placeCurrentClaude();
    expect(runtimeStatus(context, { provider: "claude" }, machine).runtime).toMatchObject({
      state: "ready",
      automaticUpdates: true,
    });

    const disabled = setRuntimeEnabled(context, { provider: "claude", enabled: false }, machine);
    const restartedContext = { ...context, fetchImpl: async () => { throw new Error("enabling must not download"); } };

    expect(disabled).toMatchObject({ ok: true, runtime: { state: "disabled", enabled: false, automaticUpdates: true } });
    expect(runtimeStatus(restartedContext, { provider: "claude" }, machine).runtime).toMatchObject({
      state: "disabled",
      enabled: false,
      automaticUpdates: true,
    });
    expect(await reconcileManagedProvider(restartedContext, "claude", machine)).toMatchObject({
      ok: true,
      runtime: { state: "disabled", enabled: false },
    });
    expect(existsSync(join(context.root, `claude@${CLAUDE_SDK.version}`, "claude"))).toBe(true);

    expect(setRuntimeEnabled(restartedContext, { provider: "claude", enabled: true }, machine)).toMatchObject({
      ok: true,
      runtime: { state: "ready", enabled: true },
    });
  });

  it("refuses active managed work but allows an active agent with its own executable", () => {
    placeCurrentClaude();
    const managed = createAgent(handle.db, { name: "Managed Claude", role: "reviewer", provider: "claude", instructions: "Review." });
    const item = createTestItem(handle.db, { type: "story", title: "Busy", stepId: "todo" });
    const run = createRun(handle.db, {
      itemId: item.id,
      agentId: managed.id,
      action: "review",
      status: "queued",
      provider: "claude",
      runtimeSource: "managed",
    });

    const blocked = setRuntimeEnabled(context, { provider: "claude", enabled: false }, machine);
    expect(blocked).toMatchObject({ ok: false, runtime: { enabled: true } });
    expect(blocked.problem).toContain("Managed Claude");

    // Agent settings are mutable, but the already-running subprocess is
    // not. Adding an override must not rewrite how this run was launched.
    updateAgent(handle.db, managed.id, { config: { executablePath: "/opt/new/claude" } });
    const stillBlocked = setRuntimeEnabled(context, { provider: "claude", enabled: false }, machine);
    expect(stillBlocked).toMatchObject({ ok: false, runtime: { enabled: true } });
    expect(stillBlocked.problem).toContain("Managed Claude");

    updateRun(handle.db, run.id, { status: "succeeded", endedAt: Date.now() });
    const configured = createAgent(handle.db, {
      name: "Corporate Claude",
      role: "tester",
      provider: "claude",
      instructions: "Test.",
      config: { executablePath: "/opt/corp/claude" },
    });
    const configuredItem = createTestItem(handle.db, { type: "story", title: "Override", stepId: "todo" });
    createRun(handle.db, {
      itemId: configuredItem.id,
      agentId: configured.id,
      action: "test",
      status: "running",
      provider: "claude",
      runtimeSource: "configured",
    });

    expect(setRuntimeEnabled(context, { provider: "claude", enabled: false }, machine).ok).toBe(true);
    expect(managedProviderReady({ root: context.root, db: handle.db }, "claude")).toBe(false);
    expect(managedProviderReady({ root: context.root, db: handle.db, configuredPath: "/opt/corp/claude" }, "claude")).toBe(true);
  });
});

/**
 * Removing what EO installed (A-08).
 *
 * The only destructive control on the Runtimes tab, so what these
 * establish is the shape of the blast radius: everything EO unpacked
 * for that one provider goes, and nothing else does. The two guards are
 * re-checked here rather than trusted from the renderer, because the
 * dialog that asked can sit open while the machine stops being idle.
 */
describe("removing a managed runtime", () => {
  it("deletes both Claude component sets, revokes consent, and offers it under Add runtime again", () => {
    placeCurrentClaude();
    const stale = placeDirectory("claude@0.1.0");
    const stalePartial = placeDirectory("claude-sdk@0.1.0.partial");

    const result = removeManagedRuntime(context, { provider: "claude" }, machine);

    expect(result).toMatchObject({
      ok: true,
      problem: null,
      // Back to what an uninstalled provider looks like, which is what
      // moves it out of the installed list and into "Add runtime".
      runtime: { state: "needs_consent", source: "absent", path: null, automaticUpdates: false },
    });
    expect(existsSync(join(context.root, `claude@${CLAUDE_SDK.version}`))).toBe(false);
    expect(existsSync(join(context.root, `${CLAUDE_SDK.id}@${CLAUDE_SDK.version}`))).toBe(false);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(stalePartial)).toBe(false);
  });

  it("deletes every Codex directory and leaves the rest of the root alone", () => {
    const current = placeCurrentCodex();
    const stale = placeDirectory("codex@0.100.0-linux-x64");
    const partial = placeDirectory(`codex@${CODEX_VERSION}.partial`);
    placeCurrentClaude();
    const unrelated = join(context.root, "notes.txt");
    writeFileSync(unrelated, "not EO's to delete");

    expect(removeManagedRuntime(context, { provider: "codex" }, machine).ok).toBe(true);

    for (const directory of [current, stale, partial]) expect(existsSync(directory)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    // The other provider is a separate consent and a separate install.
    expect(runtimeStatus(context, { provider: "claude" }, machine).runtime).toMatchObject({ state: "ready", automaticUpdates: true });
  });

  it("never touches an executable outside its own root, or the path an agent was given", () => {
    // The reason removal is written as "the directories EO made" rather
    // than "the paths this provider resolves to": someone's own Claude
    // install, and an agent pointed at a corporate build, are not EO's
    // to delete.
    placeCurrentClaude();
    const elsewhere = join(scratch, "opt", "claude");
    mkdirSync(dirname(elsewhere), { recursive: true });
    writeFileSync(elsewhere, "#!/bin/sh\n", { mode: 0o755 });
    const configured = join(scratch, "opt", "codex");
    writeFileSync(configured, "#!/bin/sh\n", { mode: 0o755 });
    const agent = createAgent(handle.db, {
      name: "Corporate Codex",
      role: "tester",
      provider: "codex",
      instructions: "Test.",
      config: { executablePath: configured },
    });

    expect(removeManagedRuntime(context, { provider: "claude" }, machine).ok).toBe(true);

    expect(existsSync(elsewhere)).toBe(true);
    expect(existsSync(configured)).toBe(true);
    expect(runtimeStatus(context, { provider: "codex" }, machine).runtime?.usedBy).toEqual([expect.objectContaining({ id: agent.id })]);
    expect(managedProviderReady({ root: context.root, db: handle.db, configuredPath: configured }, "codex")).toBe(true);
  });

  it("refuses while any agent is configured for the provider, and names them", () => {
    placeCurrentClaude();
    createAgent(handle.db, { name: "Implementer", role: "implementer", provider: "claude", instructions: "Build.", enabled: true });
    createAgent(handle.db, { name: "Paused reviewer", role: "reviewer", provider: "claude", instructions: "Review.", enabled: false });

    const refused = removeManagedRuntime(context, { provider: "claude" }, machine);

    expect(refused.ok).toBe(false);
    expect(refused.problem).toContain("Implementer");
    // A disabled agent still blocks: it is one edit away from dispatching.
    expect(refused.problem).toContain("Paused reviewer (disabled)");
    expect(existsSync(join(context.root, `claude@${CLAUDE_SDK.version}`))).toBe(true);
    // A refusal changes nothing, consent included.
    expect(refused.runtime).toMatchObject({ state: "ready", automaticUpdates: true });
  });

  it("refuses while managed work is still running, even once no agent is configured for it", () => {
    // Not covered by the configured-agents guard, and the case that
    // actually deletes a binary out from under a live subprocess: the
    // agent was repointed after its run started.
    placeCurrentClaude();
    const agent = createAgent(handle.db, { name: "Managed Claude", role: "reviewer", provider: "claude", instructions: "Review." });
    const item = createTestItem(handle.db, { type: "story", title: "Busy", stepId: "todo" });
    const run = createRun(handle.db, {
      itemId: item.id,
      agentId: agent.id,
      action: "review",
      status: "running",
      provider: "claude",
      runtimeSource: "managed",
    });
    updateAgent(handle.db, agent.id, { provider: "fake" });

    const refused = removeManagedRuntime(context, { provider: "claude" }, machine);

    expect(refused.ok).toBe(false);
    expect(refused.problem).toContain("Managed Claude");
    expect(existsSync(join(context.root, `claude@${CLAUDE_SDK.version}`))).toBe(true);

    // A gate, not a wall.
    updateRun(handle.db, run.id, { status: "succeeded", endedAt: Date.now() });
    expect(removeManagedRuntime(context, { provider: "claude" }, machine).ok).toBe(true);
  });

  it("forgets disablement, so a later install starts enabled", async () => {
    placeCurrentClaude();
    expect(setRuntimeEnabled(context, { provider: "claude", enabled: false }, machine).ok).toBe(true);

    expect(removeManagedRuntime(context, { provider: "claude" }, machine)).toMatchObject({
      ok: true,
      runtime: { state: "needs_consent", enabled: true },
    });

    // The SDK is placed by hand, as the install tests do — the fake
    // registry serves a CLI tarball, and this is about the CLI's install
    // finding an enabled runtime rather than a disabled one.
    const sdkEntry = join(context.root, `${CLAUDE_SDK.id}@${CLAUDE_SDK.version}`, CLAUDE_SDK.entry);
    mkdirSync(dirname(sdkEntry), { recursive: true });
    writeFileSync(sdkEntry, "export {};");
    context.fetchImpl = registry().fetchImpl;

    expect(await installRuntimeCommand(context, { provider: "claude" }, machine)).toMatchObject({
      ok: true,
      runtime: { source: "cache", state: "ready", enabled: true, automaticUpdates: true },
    });
  });

  it("leaves startup reconciliation with nothing to reinstall", () => {
    placeCurrentClaude();
    expect(removeManagedRuntime(context, { provider: "claude" }, machine).ok).toBe(true);

    const restarted = {
      ...context,
      fetchImpl: async () => {
        throw new Error("startup must not refetch a removed runtime");
      },
    };
    startManagedRuntimeReconciliation(restarted);

    // `reconcileManagedProvider` marks the provider `updating`
    // synchronously, so anything dispatched would already show here.
    expect(runtimeStatus(restarted, { provider: "claude" }, machine).runtime).toMatchObject({ state: "needs_consent" });
  });

  it("reports a root it cannot read instead of calling a removal that inspected nothing a success", () => {
    placeCurrentClaude();
    // Reading the status is what stores the inferred consent, exactly as
    // it happens on a machine that has the runtime installed.
    expect(runtimeStatus(context, { provider: "claude" }, machine).runtime).toMatchObject({ state: "ready", automaticUpdates: true });
    expect(setRuntimeEnabled(context, { provider: "claude", enabled: false }, machine).ok).toBe(true);
    const changed = vi.fn();
    context.onChanged = changed;
    unlistable.add(context.root);

    const result = removeManagedRuntime(context, { provider: "claude" }, machine);

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("could not read its managed runtime folder");
    expect(changed).toHaveBeenCalled();
    // Nothing was listed, so nothing was deleted, so nothing about the
    // runtime may have moved: still disabled because the user disabled
    // it, and still consented because revoking consent for a removal
    // that touched no file just breaks updates for an intact install.
    expect(result.runtime).toMatchObject({ state: "disabled", enabled: false, automaticUpdates: true });
    expect(existsSync(join(context.root, `claude@${CLAUDE_SDK.version}`, "claude"))).toBe(true);
    expect(existsSync(join(context.root, `${CLAUDE_SDK.id}@${CLAUDE_SDK.version}`))).toBe(true);
  });

  it("treats a root that was never created as nothing to remove rather than a failure", () => {
    // The one benign way to fail to list the root: it does not exist, so
    // it holds no managed directory of anyone's. Reporting a problem
    // here would ask someone to go and fix a folder whose absence is the
    // state they asked for.
    expect(existsSync(context.root)).toBe(false);

    expect(removeManagedRuntime(context, { provider: "claude" }, machine)).toMatchObject({
      ok: true,
      problem: null,
      runtime: { state: "needs_consent", source: "absent", automaticUpdates: false },
    });
  });

  it("reports what it could not delete, and describes what is left rather than what was asked for", () => {
    placeCurrentClaude();
    undeletable.add(`${CLAUDE_SDK.id}@${CLAUDE_SDK.version}`);

    const result = removeManagedRuntime(context, { provider: "claude" }, machine);

    expect(result.ok).toBe(false);
    expect(result.problem).toContain(`${CLAUDE_SDK.id}@${CLAUDE_SDK.version}`);
    expect(existsSync(join(context.root, `claude@${CLAUDE_SDK.version}`))).toBe(false);
    expect(existsSync(join(context.root, `${CLAUDE_SDK.id}@${CLAUDE_SDK.version}`))).toBe(true);
    expect(result.runtime).toMatchObject({
      source: "absent",
      // Revoked before the first deletion on purpose: a half-removed
      // tree that reconciliation reinstalls is the worse failure.
      automaticUpdates: false,
      components: expect.arrayContaining([
        expect.objectContaining({ id: "claude", installed: false }),
        expect.objectContaining({ id: CLAUDE_SDK.id, installed: true }),
      ]),
    });
  });
});

describe("describe", () => {
  it("reports the size the registry published, not one EO invented", async () => {
    // A hardcoded number is wrong the day a version bumps, and this one
    // is the number someone reads before agreeing to a download. It is
    // the *unpacked* size — named and labelled for that, because the
    // transfer is gzipped and smaller, and overstating a download is
    // the wrong way round to be wrong.
    context.fetchImpl = registry().fetchImpl;

    const described = await describeRuntime(context, { provider: "claude" }, machine);

    expect(described).toMatchObject({
      packageName: "@anthropic-ai/claude-agent-sdk-linux-x64",
      unpackedBytes: 277_000_000 * (CLAUDE_SDK.packages.length + 1),
      sourceUrl: "https://registry.npmjs.org/pkg/-/pkg.tgz",
      problem: null,
    });
  });

  it("still names the package when the registry cannot be reached", async () => {
    // The name and publisher are the part consent is actually about, so
    // an offline machine gets a dialog that is missing a size rather
    // than one that is missing the point.
    const described = await describeRuntime(context, { provider: "claude" }, machine);

    expect(described.packageName).toBe("@anthropic-ai/claude-agent-sdk-linux-x64");
    expect(described.problem).toContain("registry");
  });

  it("explains an unsupported platform instead of offering a download", async () => {
    const described = await describeRuntime(context, { provider: "claude" }, { ...machine, platform: "freebsd" as NodeJS.Platform });

    expect(described.problem).toContain("does not publish a build");
  });
});

describe("install", () => {
  it("installs, then reports the status resolution will actually find", async () => {
    const sdkEntry = join(context.root, `${CLAUDE_SDK.id}@${CLAUDE_SDK.version}`, CLAUDE_SDK.entry);
    mkdirSync(dirname(sdkEntry), { recursive: true });
    writeFileSync(sdkEntry, "export {};");
    context.fetchImpl = registry().fetchImpl;

    const result = await installRuntimeCommand(context, { provider: "claude" }, machine);

    expect(result.ok).toBe(true);
    expect(result.runtime).toMatchObject({ source: "cache", version: CLAUDE_VERSION });
    expect(existsSync(result.runtime!.path!)).toBe(true);
  });

  it("reports the problem and installs nothing when the bytes are wrong", async () => {
    const { bytes } = registry();
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 20] = (tampered[tampered.length - 20]! ^ 0xff) & 0xff;
    context.fetchImpl = async (url) =>
      url.endsWith(".tgz")
        ? new Response(tampered, { status: 200 })
        : new Response(
            JSON.stringify({
              versions: {
                [CLAUDE_VERSION]: { dist: { tarball: "https://x/-/x.tgz", integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, unpackedSize: 1 } },
              },
            }),
            { status: 200 },
          );

    const result = await installRuntimeCommand(context, { provider: "claude" }, machine);

    expect(result).toMatchObject({ ok: false });
    expect(result.problem).toContain("checksum");
    expect(runtimeStatus(context, { provider: "claude" }, machine).runtime?.source).toBe("absent");
  });

  it("forgets what it knew about signing in, because the binary just changed", async () => {
    // EO-82. The copy on disk after an install is not the copy the
    // cached answer was about. A freshly downloaded runtime nobody has
    // signed into must not inherit "signed in" from its predecessor.
    const sdkEntry = join(context.root, `${CLAUDE_SDK.id}@${CLAUDE_SDK.version}`, CLAUDE_SDK.entry);
    mkdirSync(dirname(sdkEntry), { recursive: true });
    writeFileSync(sdkEntry, "export {};");
    context.fetchImpl = registry().fetchImpl;
    let answer = true;
    let spawns = 0;
    const authProbe: AuthProbeRunner = async () => {
      spawns += 1;
      return { ok: true, stdout: JSON.stringify({ loggedIn: answer }), error: "", notFound: false };
    };
    const asking = { ...context, authProbe };

    await installRuntimeCommand(asking, { provider: "claude" }, machine);
    await runtimeStatusWithAuth(asking, { provider: "claude" }, machine);
    expect(spawns).toBe(1);

    // Same path, same 15 seconds — only the install in between.
    answer = false;
    await installRuntimeCommand(asking, { provider: "claude" }, machine);
    const after = await runtimeStatusWithAuth(asking, { provider: "claude" }, machine);

    expect(spawns).toBe(2);
    expect(after.runtime?.auth.state).toBe("signed_out");
  });

  it("refuses a provider that runs no CLI, rather than downloading something arbitrary", async () => {
    const result = await installRuntimeCommand(context, { provider: "fake" }, machine);

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("no managed runtime");
  });
});

describe("managed updates", () => {
  it("infers one-time consent from an existing EO-managed cache", () => {
    mkdirSync(join(context.root, "claude@0.1.0"), { recursive: true });

    expect(runtimeStatus(context, { provider: "claude" }, machine).runtime).toMatchObject({ automaticUpdates: true });
  });

  it("deletes superseded and partial directories after the current provider is ready", async () => {
    placeCurrentClaude();
    const oldCli = join(context.root, "claude@0.1.0");
    const oldSdk = join(context.root, "claude-sdk@0.1.0");
    const partial = join(context.root, "claude@broken.partial");
    for (const directory of [oldCli, oldSdk, partial]) mkdirSync(directory, { recursive: true });

    const result = await reconcileManagedProvider(context, "claude", machine);

    expect(result.ok).toBe(true);
    expect(existsSync(oldCli)).toBe(false);
    expect(existsSync(oldSdk)).toBe(false);
    expect(existsSync(partial)).toBe(false);
  });

  it("keeps the previous cache when an automatic replacement fails", async () => {
    const old = join(context.root, "claude@0.1.0");
    mkdirSync(old, { recursive: true });

    const result = await reconcileManagedProvider(context, "claude", machine);

    expect(result.ok).toBe(false);
    expect(existsSync(old)).toBe(true);
  });
});

/**
 * The Claude backend needs two things, not one (A-08).
 *
 * The `claude` executable and the Agent SDK EO drives it through, and
 * EO ships neither. They are separate because someone who already has
 * Claude Code installed still needs the SDK — the case a single
 * "installed / not installed" gets wrong in both directions.
 */
describe("the SDK, alongside the CLI", () => {
  it("ignores a system CLI and reports both managed components missing", () => {
    mkdirSync(join(scratch, "bin"), { recursive: true });
    writeFileSync(join(scratch, "bin", "claude"), "#!/bin/sh\n");
    chmodSync(join(scratch, "bin", "claude"), 0o755);
    const withCli = { ...machine, env: { PATH: join(scratch, "bin") } };

    expect(runtimeStatus(context, { provider: "claude" }, withCli).runtime).toMatchObject({
      source: "absent",
      path: null,
      components: expect.arrayContaining([
        expect.objectContaining({ id: "claude", installed: false }),
        expect.objectContaining({ id: CLAUDE_SDK.id, installed: false }),
      ]),
    });
  });

  it("never claims the SDK came from the system", () => {
    // A library EO imports by absolute path is one EO put there.
    // Picking up a stray copy off the machine is the thing this whole
    // mechanism exists to avoid.
    const status = runtimeStatus(context, { provider: CLAUDE_SDK.id }, machine);

    expect(status.runtime?.source).not.toBe("system");
  });

  it("sums the whole set's size, not just the SDK's", async () => {
    // Six of the seven packages are there only because Node resolves
    // bare specifiers relative to the importing file. Quoting the SDK
    // alone would understate what lands on disk.
    let asked = 0;
    context.fetchImpl = async (url) => {
      if (url.endsWith(".tgz")) return new Response(Buffer.alloc(0), { status: 200 });
      asked += 1;
      return new Response(
        JSON.stringify({ versions: { [urlVersion(url)]: { dist: { tarball: "https://x/-/x.tgz", integrity: "sha512-x", unpackedSize: 1_000_000 } } } }),
        { status: 200 },
      );
    };

    const described = await describeRuntime(context, { provider: CLAUDE_SDK.id }, machine);

    expect(asked).toBe(CLAUDE_SDK.packages.length);
    expect(described.unpackedBytes).toBe(CLAUDE_SDK.packages.length * 1_000_000);
  });

  it("still names the SDK when the registry cannot be reached", async () => {
    const described = await describeRuntime(context, { provider: CLAUDE_SDK.id }, machine);

    expect(described.packageName).toBe("@anthropic-ai/claude-agent-sdk");
    expect(described.problem).toContain("registry");
  });

  it("reports the failure rather than a half-installed library", async () => {
    const result = await installRuntimeCommand(context, { provider: CLAUDE_SDK.id }, machine);

    expect(result).toMatchObject({ ok: false });
    expect(runtimeStatus(context, { provider: CLAUDE_SDK.id }, machine).runtime?.source).toBe("absent");
  });
});

/**
 * The version the packument request is for — every pin differs.
 *
 * Matched on the end of the URL rather than `includes`, because `ajv`
 * is a substring of `ajv-formats` and a loose match quietly answers one
 * package's request with another's version.
 */
function urlVersion(url: string): string {
  const pin = CLAUDE_SDK.packages.find((entry) => url.endsWith(`/${entry.name.replace("/", "%2F")}`));
  return pin?.version ?? "0.0.0";
}

/**
 * Which binary a sign-in signs in (EO-83).
 *
 * The command's own job is exactly this resolution — everything past it
 * lives in `runtimes/signIn.ts` and is tested there. It matters because
 * signing in is a thing that happens to a *binary*: a flow that signed
 * EO's managed copy in while the agent runs its own executable would
 * have changed nothing dispatch can see.
 */
describe("starting a sign-in", () => {
  function spawner(output: string): { spawn: SignInSpawner; calls: { command: string; args: string[] }[] } {
    const calls: { command: string; args: string[] }[] = [];
    const spawn: SignInSpawner = (command, args) => {
      calls.push({ command, args });
      const child: SignInProcess = {
        onOutput: (listener) => queueMicrotask(() => listener(output)),
        write: () => {},
        kill: () => {},
        exit: new Promise(() => {}),
      };
      return child;
    };
    return { spawn, calls };
  }

  const URL_LINE = "Open https://auth.example.com/authorize to sign in.\n";

  it("runs the copy EO resolved, and opens what it printed", async () => {
    placeCurrentCodex();
    const { spawn, calls } = spawner(URL_LINE);
    const opened: string[] = [];

    const result = await startRuntimeSignIn(
      { ...context, signInSpawn: spawn, openExternal: async (url) => void opened.push(url) },
      { provider: "codex", mode: "browser" },
      machine,
    );

    expect(calls[0]?.command).toContain(`codex@${CODEX_VERSION}`);
    expect(calls[0]?.args).toEqual(["login"]);
    expect(opened).toEqual(["https://auth.example.com/authorize"]);
    expect(result.ok).toBe(true);
    if (result.sessionId !== null) cancelRuntimeSignIn({ sessionId: result.sessionId });
  });

  it("follows the agent's own executable, exactly as the status probe does", async () => {
    placeCurrentCodex();
    const { spawn, calls } = spawner(URL_LINE);

    const result = await startRuntimeSignIn(
      { ...context, signInSpawn: spawn },
      { provider: "codex", executablePath: "/usr/local/bin/codex", mode: "browser" },
      machine,
    );

    // Not EO's managed copy: an agent pointed at its own binary is
    // signed in by signing *that* one in.
    expect(calls[0]?.command).toBe("/usr/local/bin/codex");
    if (result.sessionId !== null) cancelRuntimeSignIn({ sessionId: result.sessionId });
  });

  it("has nothing to run when the managed copy is disabled and no path is set", async () => {
    placeCurrentCodex();
    setRuntimeEnabled(context, { provider: "codex", enabled: false }, machine);
    const { spawn, calls } = spawner(URL_LINE);

    const result = await startRuntimeSignIn({ ...context, signInSpawn: spawn }, { provider: "codex", mode: "browser" }, machine);

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("no Codex executable");
    expect(calls).toEqual([]);
  });
});

/**
 * The API-key way in (EO-84).
 *
 * These are the commands the dialog and the card call, so what matters
 * is the fork: a Codex key is piped to the CLI and EO keeps nothing, a
 * Claude key is stored by EO and reported as such, and removing the
 * stored one puts the question back to the binary.
 */
describe("signing in with an API key", () => {
  /** safeStorage's stand-in, as `credentials.test.ts` uses. */
  function keychain(available = true): SecretStore {
    return {
      isEncryptionAvailable: () => available,
      encryptString: (plain) => Buffer.from(`v1:${Buffer.from(plain).toString("base64")}`),
      decryptString: (encrypted) => {
        const text = encrypted.toString();
        if (!text.startsWith("v1:")) throw new Error("not encrypted by this keychain");
        return Buffer.from(text.slice(3), "base64").toString();
      },
    };
  }

  function withKeychain(store: SecretStore = keychain()): RuntimeContext {
    return { ...context, apiKeys: { directory: join(scratch, "credentials"), store } };
  }

  /** A child that exits how the test says, recording what it was written. */
  function fakeSpawner(exit: Partial<{ code: number | null; signal: string | null; error: string | null }> = {}) {
    const calls: { command: string; args: string[] }[] = [];
    const written: string[] = [];
    const spawn: SignInSpawner = (command, args) => {
      calls.push({ command, args });
      const child: SignInProcess = {
        onOutput: () => {},
        write: (text) => void written.push(text),
        closeStdin: () => {},
        kill: () => {},
        exit: Promise.resolve({ code: 0, signal: null, error: null, ...exit }),
      };
      return child;
    };
    return { spawn, calls, written };
  }

  it("pipes a Codex key to the CLI and stores nothing in EO", async () => {
    const codex = placeCurrentCodex();
    const { spawn, calls, written } = fakeSpawner();
    const ctx = { ...withKeychain(), signInSpawn: spawn };

    const result = await signInWithRuntimeApiKey(ctx, { provider: "codex", apiKey: "sk-codex-secret" }, machine);

    expect(result).toEqual({ ok: true, heldBy: "cli", transcript: "", problem: null });
    expect(calls).toEqual([
      { command: join(codex, "vendor", "x86_64-unknown-linux-gnu", "bin", "codex"), args: ["login", "--with-api-key"] },
    ]);
    expect(written).toEqual(["sk-codex-secret\n"]);
    // EO holds nothing afterwards: no file, and nothing on the card to remove.
    expect(existsSync(join(scratch, "credentials", "runtime-codex-api-key.bin"))).toBe(false);
  });

  it("stores a Claude key, and the runtime then reports an API key it can remove", async () => {
    placeCurrentClaude();
    const ctx = withKeychain();
    // A CLI that says nobody is signed in — which is the truth about
    // *its* credentials, and no longer the truth about this machine.
    const authProbe: AuthProbeRunner = async () => ({ ok: true, stdout: JSON.stringify({ loggedIn: false }), error: "", notFound: false });

    expect(await signInWithRuntimeApiKey(ctx, { provider: "claude", apiKey: "sk-ant-secret" }, machine)).toMatchObject({
      ok: true,
      heldBy: "eo",
    });

    const { runtime } = await runtimeStatusWithAuth({ ...ctx, authProbe }, { provider: "claude" }, machine);
    expect(runtime?.auth).toMatchObject({ state: "signed_in", kind: "api_key", storedKey: true });
  });

  it("says why when the machine has no keychain, rather than writing the key in the clear", async () => {
    placeCurrentClaude();

    const result = await signInWithRuntimeApiKey(withKeychain(keychain(false)), { provider: "claude", apiKey: "sk-ant-secret" }, machine);

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("no OS keychain");
    expect(existsSync(join(scratch, "credentials"))).toBe(false);
  });

  it("removing the stored key puts the question back to the binary", async () => {
    placeCurrentClaude();
    const ctx = withKeychain();
    const authProbe: AuthProbeRunner = async () => ({ ok: true, stdout: JSON.stringify({ loggedIn: false }), error: "", notFound: false });
    await signInWithRuntimeApiKey(ctx, { provider: "claude", apiKey: "sk-ant-secret" }, machine);

    expect(removeRuntimeApiKey(ctx, { provider: "claude" })).toEqual({ ok: true, removed: true, problem: null });

    const { runtime } = await runtimeStatusWithAuth({ ...ctx, authProbe }, { provider: "claude" }, machine);
    expect(runtime?.auth).toMatchObject({ state: "signed_out", storedKey: false });
  });

  it("refuses to pretend it can remove a Codex key, and says where that one lives", () => {
    // It is in the CLI's own auth.json. Deleting that would be reaching
    // into another product's credential store — the same thing EO
    // refuses to do in the other direction for an abandoned sign-in.
    const result = removeRuntimeApiKey(withKeychain(), { provider: "codex" });

    expect(result).toMatchObject({ ok: false, removed: false });
    expect(result.problem).toContain("Codex CLI");
  });

  it("removing nothing is not a failure", () => {
    expect(removeRuntimeApiKey(withKeychain(), { provider: "claude" })).toEqual({ ok: true, removed: false, problem: null });
  });
});
