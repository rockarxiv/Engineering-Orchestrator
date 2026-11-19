import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve as resolvePath } from "node:path";
import { cliToolCommandProblem, type CliToolDescriptionDraft, type CliToolDetection } from "@eo/core";
import { launchablePath } from "../modules/readiness.js";
import { killTree } from "../process/killTree.js";

/**
 * Whether a command-line tool is installed here, and a description
 * drafted from its own `--help` (EO-819).
 *
 * Verify, don't trust (invariant 5): a catalogue row's word that `gh`
 * exists is checked on this machine, against the PATH an agent is
 * actually spawned with, every time it matters — the screen asks with
 * `cliTools:detect`, and a dispatch asks before it names the CLI to an
 * agent.
 *
 * Both backends spawn their CLI over EO's own environment, and PATH is a
 * name a run's variables may never replace (`withoutReservedEnvironment
 * Variables`), so the agent's PATH is EO's inherited one. Not the login
 * shell's (`process/searchPath.ts`): that is where EO looks for the tools
 * *it* runs, and a CLI found only there would be named to an agent that
 * cannot start it.
 *
 * Detection only looks the command up: it starts nothing, so a dispatch
 * never runs an attached CLI (EO-858). The one program started here is
 * the draft's `--help`, with no stdin, under a timeout and with its
 * output capped — directly, or through `cmd.exe` for a Windows `.cmd` or
 * `.bat`, which cannot be started any other way — and nothing on this
 * path throws: a command that is missing, hangs or prints a novel
 * answers with nothing.
 */

export interface CliToolProbeOptions {
  /** The environment the agent is spawned with. Defaults to EO's own, which both backends inherit. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /**
   * The directory a run is spawned in. Outside a run, `os.tmpdir()`.
   * One directory for both the lookup and the probe: a relative PATH
   * entry, and an empty one, which means the directory itself, resolve
   * against it, so what is found is what the probe starts.
   */
  cwd?: string;
  /** Per invocation. */
  timeoutMs?: number;
  /** Per invocation, stdout and stderr together. */
  maxOutputBytes?: number;
}

export const CLI_TOOL_PROBE_TIMEOUT_MS = 3_000;
export const CLI_TOOL_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
const DESCRIPTION_MAX = 240;

/**
 * The directories on the agent spawn environment's PATH, in order, as
 * `spawn` searches them. On POSIX an empty entry — `PATH=/usr/bin:`, or
 * an empty PATH — is the directory the child is spawned in, returned as
 * "."; an unset PATH is the C library's default, as libuv takes it.
 */
export function agentSpawnSearchDirectories(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    // Windows spells it `Path` as often as `PATH`; Node's env lookup is
    // case-insensitive there and a plain object's is not.
    const value = Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
    return value.split(";").filter(Boolean);
  }
  const value = env["PATH"];
  if (value === undefined) return ["/usr/bin", "/bin"];
  return value.split(":").map((entry) => (entry === "" ? "." : entry));
}

/** The one directory a probe both looks up from and runs in: absolute. */
function probeDirectory(options: CliToolProbeOptions): string {
  // Not EO's working directory: a program that writes beside itself on
  // `--help` should not write into wherever EO started.
  return resolvePath(options.cwd ?? tmpdir());
}

/** What cmd.exe, PowerShell and `where.exe` try when `PATHEXT` is unset. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** A Windows environment variable's value, whatever case its name is spelled in. */
function windowsVariable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
}

/**
 * The extensions a bare Windows command is tried with, in order: from
 * `PATHEXT`, as the agent's shell takes them (EO-858). Lower-cased,
 * which Windows' file system does not mind, so the path an agent is
 * told reads `confluence.cmd`.
 */
function windowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
  const value = windowsVariable(env, "PATHEXT");
  const extensions = (value === undefined || value.trim() === "" ? DEFAULT_PATHEXT : value).split(";").map((extension) => extension.trim().toLowerCase());
  return extensions.filter((extension) => extension !== "");
}

/** Where `command` resolves on the agent's PATH, or null. Synchronous: a few stats. */
export function resolveCliToolPath(command: string, options: CliToolProbeOptions = {}): string | null {
  const trimmed = command.trim();
  if (cliToolCommandProblem(trimmed) !== null) return null;
  const platform = options.platform ?? process.platform;
  const directories = agentSpawnSearchDirectories(options.env, platform);
  const cwd = probeDirectory(options);
  if (platform === "win32") return windowsShellLookup(trimmed, options.env ?? process.env, directories, cwd);
  return launchablePath(trimmed, { directories, platform, cwd });
}

/**
 * Where the agent's shell on Windows would find `command` (EO-858): not
 * `launchablePath`, which is Node's shell-less `spawn` and the module
 * host's rule (EO-736), and so refuses `.cmd` and `.bat` — every shim
 * npm, pnpm and Scoop install. An agent runs a CLI through its own shell,
 * and that shell follows `PATHEXT`.
 *
 * The probe directory first, then each PATH directory; in each, a name
 * with its own extension as given, then the name with each `PATHEXT`
 * extension in order. A name with a separator in it — an absolute path —
 * is not looked up but tried where it is.
 */
function windowsShellLookup(command: string, env: NodeJS.ProcessEnv, directories: string[], cwd: string): string | null {
  const bases = /[\\/]/.test(command) ? [command] : [cwd, ...directories].map((directory) => join(resolvePath(cwd, directory), command));
  const extensions = windowsPathExtensions(env);
  for (const base of bases) {
    const candidates = [...(extname(command) === "" ? [] : [base]), ...extensions.map((extension) => `${base}${extension}`)];
    for (const candidate of candidates) if (isFile(candidate)) return candidate;
  }
  return null;
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Found, with the absolute path it resolved to, or not found. Only a
 * lookup: nothing is started, so a dispatch never runs the program.
 */
export async function detectCliTool(command: string, options: CliToolProbeOptions = {}): Promise<CliToolDetection> {
  const path = resolveCliToolPath(command, options);
  return path === null ? { found: false } : { found: true, path };
}

/**
 * A one- or two-sentence description drafted from `--help`, for a
 * person to edit. Empty when the command is not found, hangs or says
 * nothing usable. Never saved by anything here.
 */
export async function draftCliToolDescription(command: string, options: CliToolProbeOptions = {}): Promise<CliToolDescriptionDraft> {
  const path = resolveCliToolPath(command, options);
  if (path === null) return { description: "" };
  const help = await runBounded(helpInvocation(path, options), options);
  // Only what a program printed on purpose: an exit of 0, or output cut
  // off at the cap. A failure's output is an error message — a shell's
  // "not found", "unknown option" — and no description of anything.
  const usable = help.code === 0 || help.capped;
  return { description: usable ? describeFromHelp(help.output) : "" };
}

/** One program and its arguments, as `spawn` is handed them. */
export interface ProbeInvocation {
  file: string;
  args: string[];
  /** Windows only: the arguments are a command line already, quoted here, and must not be quoted again. */
  windowsVerbatimArguments: boolean;
}

/**
 * How `path --help` is started (EO-858). Directly, except for a Windows
 * `.cmd` or `.bat`, which `spawn` without a shell cannot start: that goes
 * through `cmd.exe /d /s /c "<quoted path> --help"`, which is how Node
 * itself runs a command line on Windows. The only argument is the fixed
 * literal `--help`, so nothing a person typed reaches the shell, and the
 * command's name has passed `cliToolCommandProblem`, which refuses spaces
 * and separators in a bare name. `cmd.exe` is the one `ComSpec` names,
 * as Node takes it, rather than whatever a lookup in the probe directory
 * would find first.
 */
export function helpInvocation(path: string, options: Pick<CliToolProbeOptions, "env" | "platform"> = {}): ProbeInvocation {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && /\.(cmd|bat)$/i.test(path)) {
    const comspec = windowsVariable(options.env ?? process.env, "COMSPEC") || "cmd.exe";
    return { file: comspec, args: ["/d", "/s", "/c", `""${path}" --help"`], windowsVerbatimArguments: true };
  }
  return { file: path, args: ["--help"], windowsVerbatimArguments: false };
}

interface BoundedRun {
  /** Null when it never started, was killed, or timed out. */
  code: number | null;
  output: string;
  /** Stopped because it printed as much as is read. */
  capped: boolean;
}

/**
 * Runs one program with one argument list: stdin closed, stdout and
 * stderr read together up to a cap, killed at the timeout. No shell of
 * Node's: where `cmd.exe` is involved, `helpInvocation` named it.
 *
 * In a process group of its own, so that what stops it — the timeout or
 * the cap — kills everything it started too (`killTree`), and closes both
 * pipes: a wrapper's printing descendant neither outlives the probe nor
 * keeps feeding a reader nobody is listening to. Resolves there rather
 * than waiting for the streams to close.
 */
function runBounded(invocation: ProbeInvocation, options: CliToolProbeOptions): Promise<BoundedRun> {
  const timeoutMs = options.timeoutMs ?? CLI_TOOL_PROBE_TIMEOUT_MS;
  const maxBytes = options.maxOutputBytes ?? CLI_TOOL_PROBE_MAX_OUTPUT_BYTES;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (code: number | null, capped: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output: Buffer.concat(chunks).toString("utf8"), capped });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.file, invocation.args, {
        shell: false,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...(options.env ?? process.env), NO_COLOR: "1" },
        cwd: probeDirectory(options),
        // Its own process group, for `killTree`'s negative pid.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch {
      resolve({ code: null, output: "", capped: false });
      return;
    }
    const stop = (capped: boolean) => {
      if (settled) return;
      if (child.pid !== undefined) killTree(child.pid);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(null, capped);
    };
    const timer = setTimeout(() => stop(false), timeoutMs);
    const take = (chunk: Buffer) => {
      if (size >= maxBytes) return;
      const kept = chunk.subarray(0, maxBytes - size);
      chunks.push(kept);
      size += kept.length;
      // Enough read: the rest is not wanted, and a program that would go
      // on printing for ever is stopped here rather than at the timeout.
      if (size >= maxBytes) stop(true);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", () => finish(null, false));
    child.on("close", (code) => finish(code, false));
  });
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

function cleanLines(text: string): string[] {
  return text
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim());
}

const NOT_PROSE = /^(usage|error|warning|unknown|invalid|unrecognized|unrecognised|illegal|fatal)\b/i;

/**
 * The opening sentence or two of a program's `--help`, or "".
 *
 * Help text has no standard shape, but most of it opens with a line
 * about what the program does — "Work seamlessly with GitHub from the
 * command line.", "kubectl controls the Kubernetes cluster manager." —
 * before the usage and the options. So the first paragraph that reads as
 * prose is taken: not a usage line, a heading, an option or an error,
 * and at least three words.
 */
export function describeFromHelp(help: string): string {
  const lines = cleanLines(help);
  const prose = (line: string) =>
    line !== "" &&
    !NOT_PROSE.test(line) &&
    !line.endsWith(":") &&
    !/^[-[<]/.test(line) &&
    !/^[A-Z0-9 _-]+$/.test(line) &&
    line.split(" ").length >= 3;
  const start = lines.findIndex(prose);
  if (start === -1) return "";
  const paragraph: string[] = [];
  for (const line of lines.slice(start)) {
    if (!prose(line)) break;
    paragraph.push(line);
  }
  const text = paragraph.join(" ");
  const sentences = text.match(/[^.!?]+[.!?]+(?=\s|$)/g);
  let description = sentences === null ? text : sentences.slice(0, 2).join("").trim();
  if (description.length > DESCRIPTION_MAX) description = `${description.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`;
  if (!/[.!?…]$/.test(description)) description = `${description}.`;
  return description;
}
