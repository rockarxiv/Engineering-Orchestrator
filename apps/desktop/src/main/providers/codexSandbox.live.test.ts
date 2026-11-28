import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentEvent } from "@eo/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  credentialFiles,
  describeProbe,
  FORGE_TOKEN_VARIABLES,
  forgeRemote,
  makeSandboxScratch,
  probeCommand,
  probeMismatches,
  probeUnsandboxed,
  readProbe,
  SIGN_IN_CHANNEL_VARIABLES,
  signInSockets,
  writableRoots,
  type SandboxScratch,
} from "../testing/sandboxProbe.js";
import { RUNTIMES } from "../runtimes/catalog.js";
import { runtimeRoot } from "../runtimes/install.js";
import { resolveRuntime } from "../runtimes/resolve.js";
import type { AppServerSpawn } from "./codexAppServer.js";
import { codexClientOptions, createCodexProvider, type CodexProviderOptions } from "./codex.js";
import { CodexClient, type CodexThreadOptions } from "./codexClient.js";
import { prepareCodexHome } from "./codexHome.js";

/**
 * What Codex's sandbox does when EO hands it the settings EO-932
 * decided, through EO's own launch path (EO-933).
 *
 * EO-932's probe ran `codex sandbox` directly. EO runs Codex as
 * `codex app-server` in a locked-down home of the agent's own
 * (`codexHome.ts`), with `config` flattened into `-c` overrides and the
 * thread opened by `thread/start` (`codexClient.ts`). This drives
 * `createCodexProvider` through its `createCodex` seam: the client is
 * built from `codexClientOptions` exactly as the provider builds it, the
 * sandbox's config is laid over it, and the thread options are EO's own
 * with the sandbox swapped in for `danger-full-access`. The forge
 * variables are withheld through the provider's own
 * `withheldEnvironmentVariables`, which is how EO keeps a name from a
 * turn today.
 *
 * Every answer is read from what a probe script printed
 * (`testing/sandboxProbe.ts`), never from what the model says.
 *
 * **Established on Linux (CachyOS, kernel 7.3, bubblewrap 0.13.1)
 * against Codex 0.171.0, on 2026-11-28.** Re-run it on every bump:
 *
 * 1. **`thread/start` with `sandbox: "workspace-write"` and EO's
 *    writable roots** (`sandbox_workspace_write.writable_roots`, with
 *    `exclude_slash_tmp` and `exclude_tmpdir_env_var`) lets editing,
 *    `git commit` in the linked worktree and `git fetch` through, and
 *    refuses a write under `$HOME` outside the worktree, a write to
 *    `/tmp`, a hook planted in the common `.git/hooks` and
 *    `git config --local` ("Read-only file system"). **But it cannot
 *    hide anything**: nothing in `sandbox_workspace_write` takes a path
 *    away, so the canary is read, and with the forge variables stripped
 *    the SSH agent and the session bus are still reachable — `gh auth
 *    token` reads the token from the keyring, git gets it through
 *    `gh`'s credential helper, and `git ls-remote` over SSH
 *    authenticates through the agent.
 * 2. **A permission profile does all of it.** `default_permissions =
 *    "eo"` with `permissions.eo` extending `:workspace`, EO's writable
 *    roots mapped to `"write"`, `:slash_tmp` and `:tmpdir` to `"read"`
 *    (`:workspace` leaves `/tmp` writable otherwise), every hidden path
 *    to `"none"` and `network = { enabled = true }`: the work goes
 *    through, every write above is refused, the canary is "Permission
 *    denied", and every forge sign-in fails once `SSH_AUTH_SOCK` and
 *    `DBUS_SESSION_BUS_ADDRESS` are withheld and both sockets mapped to
 *    `"none"`. A profile ignores `sandbox_workspace_write` entirely, so
 *    the roots and the network have to be in the profile. A hidden path
 *    that does not exist (`~/.git-credentials` here) does not stop the
 *    sandbox starting.
 * 3. **The trap: a profile *and* `thread/start`'s `sandbox`.** The
 *    thread's sandbox wins, with its own defaults: the worktree's git
 *    directory is read-only again, so commit and fetch fail, the canary
 *    is readable, `/tmp` is writable and the network is off. Nothing
 *    warns. (`thread/start`'s own `permissions` field, which its schema
 *    says cannot be combined with `sandbox`, was not tried.)
 * 4. **The decision's list alone is not enough.** Hiding the `gh` hosts
 *    file, git's credential stores and `~/.ssh` and stripping
 *    `GH_TOKEN`/`GITHUB_TOKEN` still let `git ls-remote` over SSH
 *    authenticate, through the agent `SSH_AUTH_SOCK` names. (`gh` itself
 *    refuses to start without its hosts file, so the keyring went
 *    unasked on that turn.)
 * 5. **No prompts.** Every turn's `thread/start`, as EO wrote it to the
 *    app-server, carried `approvalPolicy: "never"`; the server made no
 *    request of EO naming an approval, and no `commandExecution` it
 *    completed was `declined` in its own words. Both are read off the
 *    app-server's stdio through the client's `spawn` seam, because EO's
 *    client translates `declined` to `failed` before any `AgentEvent`
 *    exists, and would refuse an approval request rather than wait on
 *    it — so a turn finishing is not, by itself, that evidence.
 * 6. **Network.** On with the profile's `network.enabled`; off without
 *    it. The profile's `network` table also takes `mode` (`"limited"` or
 *    `"full"`), `domains` (a map of domain to `"allow"` or `"deny"`),
 *    `allowed_domains`, `denied_domains`, `allow_unix_sockets`,
 *    `dangerously_allow_all_unix_sockets`, `allow_local_binding`,
 *    `proxy_url`, `socks_url` and `allow_upstream_proxy`. The domain rules
 *    are accepted and not enforced: with `mode = "limited"`, npm allowed
 *    and github.com denied, github.com was still reached. They are
 *    enforced by a managed network proxy, set up through a managed
 *    `requirements.toml` (`codex sandbox --transparent-tcp` refuses with
 *    "requires a managed network proxy"), which a person's own config
 *    cannot provide.
 * 7. **SSH and the system config.** Inside the sandbox's user namespace
 *    root-owned files look foreign-owned, and ssh refuses
 *    `/etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf` ("Bad owner or
 *    permissions") on this machine, so a git SSH remote fails before it
 *    authenticates unless ssh runs with `-F`. The probe passes `-F` so
 *    that the credential checks are about credentials.
 *
 * **Not established here:** macOS and Windows, a push to a real forge,
 * a distribution that restricts unprivileged user namespaces, and
 * whether `thread/resume` carries the profile (every turn here is a
 * fresh thread).
 *
 * **Opt-in, because it spends real credit on a real account** — five
 * short turns — and because it asks the person's real forge sign-in
 * whether it can be reached:
 *
 *     EO_LIVE_CODEX=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/providers/codexSandbox.live.test.ts
 *
 * It runs EO's own Codex at its pin (`RUNTIMES.codex`), resolved as the
 * app resolves it, and refuses when that is not installed;
 * `EO_CODEX_BIN` names another binary instead.
 *
 * `EO_LIVE_FORGE_REMOTE` names the forge remote the credential checks
 * ask (an SSH remote: it authenticates even for a public repository);
 * this checkout's `origin` otherwise. The machine must be signed in to
 * it with an SSH agent holding the key, or the first test fails saying
 * so.
 */

const OPTED_IN = process.env["EO_LIVE_CODEX"] === "1";

/**
 * The binary the caller names, or else EO's own at its pin
 * (`RUNTIMES.codex`), resolved as the app resolves it — never whatever
 * `codex` is on PATH, which on a developer's machine is rarely EO's.
 * Refuses clearly when the pinned one is not installed.
 */
function pinnedCodex(): string {
  const named = process.env["EO_CODEX_BIN"];
  if (named) return named;
  const root = process.env["EO_RUNTIME_ROOT"] ?? runtimeRoot(join(homedir(), ".config", "EO"));
  const path = resolveRuntime({ spec: RUNTIMES.codex, root }).path;
  if (path === null) throw new Error(`Codex is not installed at EO's pin (codex@${RUNTIMES.codex.version}) under ${root}; install it or name one with EO_CODEX_BIN.`);
  return path;
}
const MODEL = process.env["EO_LIVE_CODEX_MODEL"];

const scratches: string[] = [];

afterAll(() => {
  for (const path of scratches) rmSync(path, { recursive: true, force: true });
});

interface Variant {
  config: Record<string, unknown>;
  thread: (options: CodexThreadOptions) => CodexThreadOptions;
}

interface Turn {
  events: AgentEvent[];
  finished: boolean;
  /** What the thread was opened with, after the variant had its say. */
  thread?: CodexThreadOptions;
  /** Every JSON-RPC message EO wrote to the app-server, as written. */
  sent: WireMessage[];
  /** Every JSON-RPC message the app-server wrote back, before EO translated any of it. */
  received: WireMessage[];
}

type WireMessage = Record<string, unknown>;

/** Each JSON line `stream` carries, as it arrives. */
function readLines(stream: NodeJS.ReadableStream, onMessage: (message: WireMessage) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line === "") continue;
      try {
        onMessage(JSON.parse(line) as WireMessage);
      } catch {
        // Not JSON: nothing this test reads.
      }
    }
  });
}

/**
 * The real spawn, with both directions of the app-server's stdio
 * recorded on the way past. EO's client translates what it reads — a
 * `commandExecution` the server calls `declined` reaches an `AgentEvent`
 * as `failed` (`codexClient.ts`) — so what the server said, and what EO
 * asked it, can only be read here.
 */
function tappedSpawn(turn: Turn): AppServerSpawn {
  return (command, args, options) => {
    const child = nodeSpawn(command, args, { ...options, windowsHide: true });
    readLines(child.stdout, (message) => turn.received.push(message));
    const write = child.stdin.write.bind(child.stdin) as (chunk: unknown, ...rest: unknown[]) => boolean;
    const sent = new StringDecoder("utf8");
    let pending = "";
    child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
      pending += typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? sent.write(chunk) : "";
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        try {
          if (line !== "") turn.sent.push(JSON.parse(line) as WireMessage);
        } catch {
          // Not JSON.
        }
      }
      return write(chunk, ...rest);
    }) as typeof child.stdin.write;
    return child;
  };
}

/** The `params` of the first request EO sent with `method`. */
function sentParams(turn: Turn, method: string): Record<string, unknown> | undefined {
  return turn.sent.find((message) => message["method"] === method)?.["params"] as Record<string, unknown> | undefined;
}

/** Every `commandExecution` item the server completed, with the status it gave, untranslated. */
function rawCommandStatuses(turn: Turn): unknown[] {
  return turn.received
    .filter((message) => message["method"] === "item/completed")
    .map((message) => (message["params"] as { item?: { type?: unknown; status?: unknown } } | undefined)?.item)
    .filter((item) => item?.type === "commandExecution")
    .map((item) => item?.status);
}

/** Every request the server made of EO — a message with both an id and a method. Approvals arrive this way. */
function serverRequests(turn: Turn): string[] {
  return turn.received.filter((message) => message["id"] !== undefined && typeof message["method"] === "string").map((message) => message["method"] as string);
}

async function codexTurn(scratch: SandboxScratch, prompt: string, variant: Variant, withheld: readonly string[]): Promise<Turn> {
  const homes = mkdtempSync(join(homedir(), ".eo933-codex-homes-"));
  scratches.push(homes);
  const prepared = prepareCodexHome({ root: homes, agentId: "eo933-live", itemId: "item-1", personHome: join(homedir(), ".codex") });
  if (!prepared.ok) throw new Error(prepared.problem);
  const base: CodexProviderOptions = { executablePath: pinnedCodex(), codexHome: () => prepared.path };
  const turn: Turn = { events: [], finished: false, sent: [], received: [] };
  const provider = createCodexProvider({
    ...base,
    createCodex: (repositoryMcp, searchHook, attachFrom, memoryScopes, environmentVariables, writeBridge, withheldNames, adminDirectory, skillSlugs, itemId) => {
      const built = codexClientOptions(base, repositoryMcp, searchHook, attachFrom, memoryScopes, environmentVariables, writeBridge, withheldNames, adminDirectory, skillSlugs, itemId);
      const client = new CodexClient({ ...built, config: { ...(built.config ?? {}), ...variant.config }, spawn: tappedSpawn(turn) });
      return {
        startThread: (options?: CodexThreadOptions) => client.startThread((turn.thread = variant.thread(options ?? {}))),
        resumeThread: (id: string, options?: CodexThreadOptions) => client.resumeThread(id, (turn.thread = variant.thread(options ?? {}))),
      };
    },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 400_000);
  try {
    const stream = provider.start({
      instructions: "You are running checks in a scratch repository. Do exactly what you are asked and nothing more.",
      context: prompt,
      cwd: scratch.worktree,
      ...(MODEL ? { model: MODEL } : {}),
      withheldEnvironmentVariables: [...withheld],
      signal: controller.signal,
    });
    for await (const event of stream as AsyncIterable<AgentEvent>) {
      turn.events.push(event);
      if (event.type === "result") {
        turn.finished = true;
        break;
      }
    }
  } catch (error) {
    turn.events.push({ type: "error", message: error instanceof Error ? error.message : String(error) } as AgentEvent);
  } finally {
    clearTimeout(timer);
  }
  return turn;
}

function runProbe(scratch: SandboxScratch, forge: string): string {
  return `Run this shell command exactly once, unchanged:\n\n${probeCommand(scratch, forge)}\n\nThen reply with the single word DONE.`;
}

function shown(turn: Turn, scratch: SandboxScratch): string {
  const tools = turn.events
    .filter((event) => event.type === "tool_result" || event.type === "error" || event.type === "result")
    .map((event) => JSON.stringify(event).slice(0, 500))
    .join("\n");
  return `${describeProbe(readProbe(scratch))}\n--- events\n${tools}`;
}

/** What an implementer has to be able to do. */
const WORK = { edit: true, commit: true, fetch: true } as const;
/** What EO-932's writes decision refuses. */
const REFUSED = { "write-outside": false, "write-tmp": false, "plant-hook": false, "git-config-local": false } as const;
/** What EO-932's credentials decision hides, and every way this probe knows of reaching a forge sign-in. */
const HIDDEN = {
  "read-hidden": false,
  "forge-token-env": false,
  "gh-auth-token": false,
  "git-credential-https": false,
  "ls-remote-forge": false,
  "ssh-agent-keys": false,
} as const;

const WITHHELD = [...FORGE_TOKEN_VARIABLES, ...SIGN_IN_CHANNEL_VARIABLES];

/**
 * `thread/start` with `sandbox: "workspace-write"` and EO's writable
 * roots in `sandbox_workspace_write` — the spelling EO-933 names.
 */
function workspaceWrite(scratch: SandboxScratch): Variant {
  return {
    config: { sandbox_workspace_write: { writable_roots: writableRoots(scratch), network_access: true, exclude_slash_tmp: true, exclude_tmpdir_env_var: true } },
    thread: (options) => ({ ...options, sandboxMode: "workspace-write" }),
  };
}

/**
 * The same sandbox as a permission profile, which is the only way Codex
 * hides a file: `:workspace` extended with EO's writable roots, the
 * temporary directories made read-only, the hidden paths mapped to
 * `"none"`, and the network on. `keepThreadSandbox` also sends
 * `thread/start` its `sandbox`, which is the trap.
 */
function profile(scratch: SandboxScratch, hidden: readonly string[], keepThreadSandbox = false, network: Record<string, unknown> = { enabled: true }): Variant {
  return {
    config: {
      default_permissions: "eo",
      permissions: {
        eo: {
          extends: ":workspace",
          network,
          filesystem: Object.fromEntries([
            ...writableRoots(scratch).map((path) => [path, "write"]),
            [":slash_tmp", "read"],
            [":tmpdir", "read"],
            ...(hidden.length === 0 ? [] : [scratch.canary, ...hidden]).map((path) => [path, "none"]),
          ]),
        },
      },
    },
    thread: (options) => {
      const rest = { ...options };
      delete rest.sandboxMode;
      return keepThreadSandbox ? { ...rest, sandboxMode: "workspace-write" } : rest;
    },
  };
}

describe.skipIf(!OPTED_IN)("Codex's sandbox, through EO's launch path", () => {
  const forge = OPTED_IN ? forgeRemote(process.cwd()) : "";

  async function probed(label: string, variant: (scratch: SandboxScratch) => Variant, withheld: readonly string[]): Promise<{ scratch: SandboxScratch; turn: Turn; said: string }> {
    const scratch = makeSandboxScratch("eo933-codex");
    scratches.push(scratch.root, scratch.outsideTmp);
    const turn = await codexTurn(scratch, runProbe(scratch, forge), variant(scratch), withheld);
    const said = `[codex: ${label}]\n${shown(turn, scratch)}`;
    expect(turn.finished, `the turn never finished:\n${said}`).toBe(true);
    // Launched as EO launches every Codex thread, nobody to approve
    // anything — read off what EO actually sent the app-server.
    const opened = sentParams(turn, "thread/start");
    expect(opened?.["approvalPolicy"], said).toBe("never");
    // And no command waited on or was refused an approval: the server
    // asked EO nothing that names one, and no command it completed is
    // `declined` in its own words. EO's client would refuse such a
    // request rather than wait on it, so a turn that finished is not by
    // itself the evidence; these two are.
    const statuses = rawCommandStatuses(turn);
    expect(statuses.length, `the probe never ran:\n${said}`).toBeGreaterThan(0);
    expect(statuses, said).not.toContain("declined");
    expect(serverRequests(turn).filter((method) => /approval/i.test(method)), said).toEqual([]);
    return { scratch, turn, said };
  }

  it(
    "with workspace-write on thread/start and EO's writable roots, lets the work through and refuses the writes, but can hide nothing",
    async () => {
      const control = makeSandboxScratch("eo933-codex-ctl");
      scratches.push(control.root, control.outsideTmp);
      const open = probeUnsandboxed(control, forge);
      expect(probeMismatches(open, { "gh-auth-token": true, "git-credential-https": true, "ls-remote-forge": true, "ssh-agent-keys": true }), `this machine is not signed in to ${forge}, so the credential checks would prove nothing:\n${describeProbe(open)}`).toEqual([]);

      const { scratch, turn, said } = await probed("workspace-write", workspaceWrite, FORGE_TOKEN_VARIABLES);
      expect(sentParams(turn, "thread/start")?.["sandbox"]).toBe("workspace-write");
      expect(
        probeMismatches(readProbe(scratch), {
          ...WORK,
          ...REFUSED,
          "net-npm": true,
          "net-github": true,
          // Nothing in `sandbox_workspace_write` hides a path, and the
          // forge variables gone is not the sign-in gone: the SSH agent
          // and the session bus are reachable, so `gh` reads its token
          // from the keyring and git gets it through `gh`.
          "read-hidden": true,
          "forge-token-env": false,
          "ssh-agent-keys": true,
          "gh-auth-token": true,
          "git-credential-https": true,
          "ls-remote-forge": true,
        }),
        said,
      ).toEqual([]);
      expect(existsSync(scratch.outside)).toBe(false);
    },
    900_000,
  );

  it(
    "with EO's settings as a permission profile, lets the work through, refuses the rest and hides what EO hides",
    async () => {
      const { scratch, turn, said } = await probed("profile", (s) => profile(s, [...credentialFiles(), ...signInSockets()]), WITHHELD);
      expect(sentParams(turn, "thread/start")?.["sandbox"]).toBeUndefined();
      expect(probeMismatches(readProbe(scratch), { ...WORK, ...REFUSED, ...HIDDEN, "net-npm": true, "net-github": true }), said).toEqual([]);
      expect(existsSync(scratch.outside)).toBe(false);
      expect(existsSync(join(scratch.commonGit, "hooks", "pre-push-probe"))).toBe(false);
    },
    900_000,
  );

  it(
    "with only the decision's credential files hidden, still lets the SSH agent through",
    async () => {
      const { scratch, said } = await probed("profile, decision's list only", (s) => profile(s, credentialFiles()), FORGE_TOKEN_VARIABLES);
      expect(
        probeMismatches(readProbe(scratch), {
          ...WORK,
          ...REFUSED,
          "read-hidden": false,
          // `gh` will not start without its hosts file, so the keyring
          // goes unasked and git's `gh` helper fails with it.
          "gh-auth-token": false,
          "git-credential-https": false,
          // The agent is a socket `SSH_AUTH_SOCK` names, not a file.
          "ssh-agent-keys": true,
          "ls-remote-forge": true,
        }),
        said,
      ).toEqual([]);
    },
    900_000,
  );

  it(
    "drops a permission profile's writable roots and hidden paths when thread/start also names a sandbox",
    async () => {
      const { scratch, said } = await probed("profile + thread sandbox", (s) => profile(s, [...credentialFiles(), ...signInSockets()], true), WITHHELD);
      expect(
        probeMismatches(readProbe(scratch), {
          edit: true,
          // The worktree's own git directory is read-only again…
          commit: false,
          fetch: false,
          // …the canary readable, `/tmp` writable and the network off:
          // what applies is `workspace-write` with its defaults.
          "read-hidden": true,
          "write-tmp": true,
          "net-npm": false,
          "net-github": false,
        }),
        said,
      ).toEqual([]);
    },
    900_000,
  );

  it(
    "accepts a domain list in a permission profile and does not enforce it",
    async () => {
      const { scratch, said } = await probed(
        "profile, domains",
        (s) => profile(s, [...credentialFiles(), ...signInSockets()], false, { enabled: true, mode: "limited", domains: { "registry.npmjs.org": "allow", "github.com": "deny" } }),
        WITHHELD,
      );
      // Enforced only by a managed network proxy (requirements.toml),
      // which a person's own config cannot set up.
      expect(probeMismatches(readProbe(scratch), { "net-npm": true, "net-github": true }), said).toEqual([]);
    },
    900_000,
  );
});
