import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { delimiter, join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import { MCP_HOST_SERVER_KEY, MCP_TOKEN_VAR, claudeCodeAddArgs, codexAddArgs, mcpConnectCommand, mcpRemoteArgs, mcpRemoteEnv } from "@eo/core";

const execFileAsync = promisify(execFile);

/**
 * Registering EO with the MCP clients a person already has.
 *
 * Two rules shape everything here.
 *
 * **Ambient, not managed.** `runtimes/resolve.ts` deliberately ignores
 * ambient installations — EO runs the versions it tested and owns their
 * lifecycle. This is the opposite policy on purpose, and the two are not
 * in conflict because they are about different things. That file is
 * about the agent EO *drives*; this is about the editor the person
 * *uses*. EO's managed copy of `claude` has no configuration a human
 * ever opens, so registering a server into it would help nobody.
 *
 * **Their mechanism, not ours.** Every client here that ships an `mcp
 * add` gets driven through it rather than having its configuration file
 * edited underneath it. Their command knows their format, migrates it
 * when it changes, and validates what we pass; a hand-rolled TOML writer
 * would be wrong the first time either happened. Claude Desktop is the
 * exception, and only because it ships no CLI at all — there, the file
 * is merged key by key and everything already in it is preserved.
 */

/** A CLI that answered, or did not. Mirrors `forge/cli.ts`'s result, for the same reasons. */
interface RunResult {
  ok: boolean;
  stdout: string;
  error: string;
  notFound: boolean;
}

export type Runner = (cli: string, args: string[]) => Promise<RunResult>;

/**
 * Nothing here may sit waiting on a prompt nobody can see, and nothing
 * may reach a pager. Same discipline as `forge/cli.ts`, and `execFile`
 * with an argument array rather than a shell — a bearer token going
 * through a shell is a quoting problem on three platforms and an
 * injection hole on all of them.
 */
const NON_INTERACTIVE_ENV: Record<string, string> = {
  PAGER: "cat",
  NO_COLOR: "1",
  CLICOLOR: "0",
  CI: "1",
};

/**
 * Where to look for a CLI beyond whatever PATH this process inherited.
 *
 * Load-bearing on macOS, where an app launched from Finder gets a PATH
 * of roughly `/usr/bin:/bin:/usr/sbin:/sbin` and sees neither Homebrew
 * nor anything npm installed. A person with `claude` working perfectly
 * in their terminal would otherwise be told it is not installed, which
 * is the single most confusing thing this screen could say.
 */
function searchPath(home: string, platform: NodeJS.Platform): string[] {
  const fromEnv = (process.env["PATH"] ?? "").split(delimiter).filter(Boolean);
  if (platform === "win32") return fromEnv;
  return [
    ...fromEnv,
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

export function createRunner(home = homedir(), platform = osPlatform(), timeoutMs = 20_000): Runner {
  const path = searchPath(home, platform).join(delimiter);
  return async (cli, args) => {
    try {
      const { stdout } = await execFileAsync(cli, args, {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...NON_INTERACTIVE_ENV, PATH: path },
      });
      return { ok: true, stdout: stdout.trim(), error: "", notFound: false };
    } catch (error) {
      const detail = error as { code?: string; stderr?: string; stdout?: string; message?: string };
      return {
        ok: false,
        stdout: (detail.stdout ?? "").trim(),
        error: (detail.stderr ?? "").trim() || detail.message || String(error),
        notFound: detail.code === "ENOENT",
      };
    }
  };
}

export type ClientId = "claude-code" | "codex" | "claude-desktop";

/** What to do by hand, when the button cannot or did not. */
export interface ManualStep {
  label: string;
  text: string;
}

export interface ClientState {
  id: ClientId;
  label: string;
  /** Whether EO found it on this machine at all. */
  installed: boolean;
  /** Whether EO is already registered with it. Null when that cannot be determined. */
  registered: boolean | null;
  /**
   * Something the person has to do themselves for the registration to
   * work. Not an error — the registration succeeded — which is why it is
   * separate from `problem`.
   */
  caveat: string | null;
  problem: string | null;
  /** Null only when there is no server to connect to yet, so there is nothing to paste. */
  manual: ManualStep | null;
}

export interface ClientContext {
  run: Runner;
  home: string;
  platform: NodeJS.Platform;
}

export interface Registration {
  url: string;
  token: string;
}

/** The name EO registers under, everywhere. Matches what the connection snippets say. */
export const SERVER_KEY = MCP_HOST_SERVER_KEY;

/**
 * The environment variable Codex and Claude Code read the token from.
 *
 * The rule for every client here, and the reason the arguments come from
 * `@eo/core`'s `mcpConnect`: **the token never appears in an argument EO
 * writes, runs or shows** (EO-601). Settings shows the same commands, so
 * one source keeps the two from drifting. EO cannot set a variable in the
 * person's shell, so neither CLI registration is finished when it returns
 * — hence the caveat, which the screen shows rather than leaving them to
 * find out when a tool call comes back unauthorized.
 */
export const TOKEN_VAR = MCP_TOKEN_VAR;

/**
 * The arguments EO passes, and the command it shows.
 *
 * One source for both. The point of showing a command is that someone
 * can run the thing EO just failed at and see the error their CLI
 * actually prints — which stops working the moment the two drift, and
 * they drift the first time an argument changes in only one of them.
 */
function claudeArgs({ url }: Registration): string[] {
  return claudeCodeAddArgs(url);
}

function codexArgs({ url }: Registration): string[] {
  return codexAddArgs(url);
}

function manualFor(id: ClientId, registration: Registration | null, home: string, platform: NodeJS.Platform): ManualStep | null {
  if (registration === null) return null;

  // Two lines for either CLI, because the first one alone leaves the
  // client connecting and being refused — the token is not in what
  // `mcp add` writes.
  if (id === "claude-code" || id === "codex") {
    return { label: "Run these in a terminal", text: mcpConnectCommand(id, registration.url, registration.token) };
  }

  return {
    label: `Add this to ${claudeDesktopConfig(home, platform)}`,
    text: JSON.stringify({ mcpServers: { [SERVER_KEY]: desktopEntry(registration) } }, null, 2),
  };
}

// ── Claude Desktop ──────────────────────────────────────────────────

/**
 * Where Claude Desktop keeps the file it reads on launch — the paths the
 * MCP project's "Connect to local MCP servers" page gives for each
 * platform.
 *
 * Joined the way `platform` joins paths, as `claudeSettingsLayers` is
 * (EO-598), so that naming a platform names its paths too, and a test
 * can hold every platform's answer whatever machine runs it.
 */
export function claudeDesktopConfig(home: string, platform: NodeJS.Platform): string {
  const paths = platform === "win32" ? win32 : posix;
  if (platform === "darwin") return paths.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return paths.join(process.env["APPDATA"] ?? paths.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return paths.join(home, ".config", "Claude", "claude_desktop_config.json");
}

/**
 * Claude Desktop speaks stdio, and EO speaks HTTP.
 *
 * `mcp-remote` is the bridge the MCP project publishes for exactly this
 * gap, and it is what the app's own documentation points at for a
 * server that is not a local command. It costs a `npx` on first launch;
 * the alternative is telling someone to add a custom connector by hand,
 * which is the thing this button exists to avoid.
 *
 * Claude Desktop hands `args` to the process unchanged, so a token there
 * would sit on `mcp-remote`'s command line for as long as the app runs.
 * Instead the header names a variable set in `env` — `mcp-remote`'s own
 * documented shape, explained in `@eo/core`'s `mcpRemoteArgs`. The token
 * does stay in this file: the client has to read it from somewhere, and
 * the file is the person's own.
 */
function desktopEntry({ url, token }: Registration): Record<string, unknown> {
  return { command: "npx", args: mcpRemoteArgs(url), env: mcpRemoteEnv(token) };
}

/**
 * Whether an `eo` entry is the shape EO wrote before EO-601, with the
 * token in `args`.
 *
 * Any bearer credential written literally into an argument counts, not
 * only the current token: one from before a rotation is just as readable
 * on the command line, and is the same entry needing the same fix.
 */
function desktopEntryLeaksToken(entry: unknown, registration: Registration | null): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const args = (entry as Record<string, unknown>)["args"];
  if (!Array.isArray(args)) return false;
  return args.some(
    (argument) =>
      typeof argument === "string" &&
      (/Bearer\s+[^\s$]/i.test(argument) || (registration !== null && registration.token !== "" && argument.includes(registration.token))),
  );
}

function readDesktopConfig(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Absent is ordinary — the app writes it on first run. Unreadable is
    // not, and is handled by the caller refusing to write over it.
    return {};
  }
}

// ── Detection ───────────────────────────────────────────────────────

async function detectClaudeCode(context: ClientContext, registration: Registration | null): Promise<ClientState> {
  const manual = manualFor("claude-code", registration, context.home, context.platform);
  const base = { id: "claude-code" as const, label: "Claude Code", problem: null, manual };
  const version = await context.run("claude", ["--version"]);
  if (version.notFound) return { ...base, installed: false, registered: null, caveat: null };

  const listed = await context.run("claude", ["mcp", "list"]);
  // `mcp list` prints one line per server; a name match is the whole
  // question. If the command itself failed, say "unknown" rather than
  // "not registered" — offering to add something that is already there
  // is a worse answer than admitting we cannot tell.
  const registered = listed.ok ? new RegExp(`(^|\\s)${SERVER_KEY}\\b`, "m").test(listed.stdout) : null;
  return {
    ...base,
    installed: true,
    registered,
    caveat: registered === true ? tokenVarCaveat("Claude Code") : null,
  };
}

async function detectCodex(context: ClientContext, registration: Registration | null): Promise<ClientState> {
  const manual = manualFor("codex", registration, context.home, context.platform);
  const base = { id: "codex" as const, label: "Codex", problem: null, manual };
  const version = await context.run("codex", ["--version"]);
  if (version.notFound) return { ...base, installed: false, registered: null, caveat: null };

  const listed = await context.run("codex", ["mcp", "list"]);
  const registered = listed.ok ? new RegExp(`(^|\\s)${SERVER_KEY}\\b`, "m").test(listed.stdout) : null;
  return {
    ...base,
    installed: true,
    registered,
    caveat: registered === true ? tokenVarCaveat("Codex") : null,
  };
}

function tokenVarCaveat(client: "Codex" | "Claude Code"): string {
  return (
    `${client} reads the token from ${TOKEN_VAR} rather than storing it, so add ` +
    `\`export ${TOKEN_VAR}=…\` to your shell profile with the token above. ` +
    `Until you do, ${client} will connect and be refused.`
  );
}

function detectClaudeDesktop(context: ClientContext, registration: Registration | null): ClientState {
  const file = claudeDesktopConfig(context.home, context.platform);
  const manual = manualFor("claude-desktop", registration, context.home, context.platform);
  const base = { id: "claude-desktop" as const, label: "Claude Desktop", caveat: null, problem: null, manual };
  // The directory rather than the file: the app creates the directory on
  // install and the config only once something writes it, so keying off
  // the file would call a fresh install "not installed".
  if (!existsSync(join(file, ".."))) return { ...base, installed: false, registered: null };

  const servers = readDesktopConfig(file)["mcpServers"];
  const registered = servers !== null && typeof servers === "object" ? SERVER_KEY in (servers as Record<string, unknown>) : false;
  if (registered && desktopEntryLeaksToken((servers as Record<string, unknown>)[SERVER_KEY], registration)) {
    // Not registered, so the screen offers the button: registering
    // overwrites the entry, which is the whole upgrade, and nothing
    // rewrites the person's config without that press.
    return {
      ...base,
      installed: true,
      registered: false,
      problem:
        "EO's entry in Claude Desktop's configuration is an older one that puts the token on mcp-remote's command line, " +
        "where other users on this machine can read it. Add EO again to replace it.",
    };
  }
  return { ...base, installed: true, registered, caveat: registered ? desktopCaveat() : null };
}

function desktopCaveat(): string {
  return "Claude Desktop reads this file at launch, so quit and reopen it. It bridges to EO with npx, which needs Node installed.";
}

export async function detectClients(context: ClientContext, registration: Registration | null = null): Promise<ClientState[]> {
  return [
    await detectClaudeCode(context, registration),
    await detectCodex(context, registration),
    detectClaudeDesktop(context, registration),
  ];
}

// ── Registration ────────────────────────────────────────────────────

export async function registerWith(context: ClientContext, id: ClientId, registration: Registration): Promise<ClientState> {
  const manual = manualFor(id, registration, context.home, context.platform);

  if (id === "claude-code") {
    // `--scope user` so it is there in every project rather than only
    // whichever directory this happened to run from.
    const added = await context.run("claude", claudeArgs(registration));
    if (!added.ok) return failed(id, "Claude Code", added.notFound ? "Claude Code is not installed." : added.error, manual);
    return { id, label: "Claude Code", installed: true, registered: true, caveat: tokenVarCaveat("Claude Code"), problem: null, manual };
  }

  if (id === "codex") {
    const added = await context.run("codex", codexArgs(registration));
    if (!added.ok) return failed(id, "Codex", added.notFound ? "Codex is not installed." : added.error, manual);
    return { id, label: "Codex", installed: true, registered: true, caveat: tokenVarCaveat("Codex"), problem: null, manual };
  }

  return registerWithDesktop(context, registration, manual);
}

/**
 * A failure that still leaves somewhere to go.
 *
 * `manual` travels with it deliberately: EO could not run their CLI, and
 * the most useful next thing is the command itself — run by hand it
 * prints the error their CLI actually gives, which is nearly always more
 * specific than what EO can report through a pipe.
 */
function failed(id: ClientId, label: string, problem: string, manual: ManualStep | null): ClientState {
  return { id, label, installed: false, registered: false, caveat: null, problem, manual };
}

/**
 * The one client EO edits directly, because it ships no CLI to ask.
 *
 * Read, add one key, write the whole file back — so every preference
 * already in there survives, and so does every other MCP server. A
 * config that exists but will not parse is left completely alone: it is
 * more likely to be something the person is midway through editing than
 * something EO should overwrite.
 */
function registerWithDesktop(context: ClientContext, registration: Registration, manual: ManualStep | null): ClientState {
  const file = claudeDesktopConfig(context.home, context.platform);
  const base = { id: "claude-desktop" as const, label: "Claude Desktop", installed: true, manual };

  if (existsSync(file)) {
    try {
      JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return {
        ...base,
        registered: false,
        caveat: null,
        problem: "Claude Desktop's configuration file is not valid JSON, so EO has left it untouched. Fix or remove it and try again.",
      };
    }
  }

  const config = readDesktopConfig(file);
  const existing = config["mcpServers"];
  const servers = existing !== null && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
  servers[SERVER_KEY] = desktopEntry(registration);

  try {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    return { ...base, registered: false, caveat: null, problem: `EO could not write Claude Desktop's configuration: ${String(error)}` };
  }

  return { ...base, registered: true, caveat: desktopCaveat(), problem: null };
}
