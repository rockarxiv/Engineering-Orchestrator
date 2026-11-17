import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { cliToolCommandProblem, type CliToolDescriptionDraft, type CliToolDetection } from "@eo/core";
import { launchablePath } from "../modules/readiness.js";
import { killTree } from "../process/killTree.js";

/**
 * Whether a command-line tool is installed here, and what it says about
 * itself (EO-819).
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
 * Every program here is started without a shell, with no stdin, under a
 * timeout and with its output capped, and nothing on this path throws: a
 * command that is missing, hangs or prints a novel answers with nothing.
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
const VERSION_MAX = 120;
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

/** Where `command` resolves on the agent's PATH, or null. Synchronous: a few stats. */
export function resolveCliToolPath(command: string, options: CliToolProbeOptions = {}): string | null {
  const trimmed = command.trim();
  if (cliToolCommandProblem(trimmed) !== null) return null;
  const platform = options.platform ?? process.platform;
  return launchablePath(trimmed, {
    directories: agentSpawnSearchDirectories(options.env, platform),
    platform,
    cwd: probeDirectory(options),
  });
}

/** Found, with its absolute path and the first line `--version` printed, or not found. */
export async function detectCliTool(command: string, options: CliToolProbeOptions = {}): Promise<CliToolDetection> {
  const path = resolveCliToolPath(command, options);
  if (path === null) return { found: false };
  const run = await runBounded(path, ["--version"], options);
  return { found: true, path, version: run.code === 0 ? versionLine(run.output) : null };
}

/**
 * A one- or two-sentence description drafted from `--version` and
 * `--help`, for a person to edit. Empty when the command is not found,
 * hangs or says nothing usable. Never saved by anything here.
 */
export async function draftCliToolDescription(command: string, options: CliToolProbeOptions = {}): Promise<CliToolDescriptionDraft> {
  const path = resolveCliToolPath(command, options);
  if (path === null) return { version: null, description: "" };
  const version = await runBounded(path, ["--version"], options);
  const help = await runBounded(path, ["--help"], options);
  const versionText = version.code === 0 ? versionLine(version.output) : null;
  // Only what a program printed on purpose: an exit of 0, or output cut
  // off at the cap. A failure's output is an error message — a shell's
  // "not found", "unknown option" — and no description of anything.
  const usable = help.code === 0 || help.capped;
  return { version: versionText, description: usable ? describeFromHelp(help.output, versionText) : "" };
}

interface BoundedRun {
  /** Null when it never started, was killed, or timed out. */
  code: number | null;
  output: string;
  /** Stopped because it printed as much as is read. */
  capped: boolean;
}

/**
 * Runs one program with one argument list: no shell, stdin closed,
 * stdout and stderr read together up to a cap, killed at the timeout.
 *
 * In a process group of its own, so that what stops it — the timeout or
 * the cap — kills everything it started too (`killTree`), and closes both
 * pipes: a wrapper's printing descendant neither outlives the probe nor
 * keeps feeding a reader nobody is listening to. Resolves there rather
 * than waiting for the streams to close.
 */
function runBounded(path: string, args: string[], options: CliToolProbeOptions): Promise<BoundedRun> {
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
      child = spawn(path, args, {
        shell: false,
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

/** The first non-empty line `--version` printed, shortened. */
export function versionLine(output: string): string | null {
  const line = cleanLines(output).find((candidate) => candidate !== "");
  if (line === undefined) return null;
  return line.length > VERSION_MAX ? `${line.slice(0, VERSION_MAX - 1)}…` : line;
}

const NOT_PROSE = /^(usage|error|warning|unknown|invalid|unrecognized|unrecognised|illegal|fatal)\b/i;

/**
 * The opening sentence or two of a program's `--help`, or "".
 *
 * Help text has no standard shape, but most of it opens with a line
 * about what the program does — "Work seamlessly with GitHub from the
 * command line.", "kubectl controls the Kubernetes cluster manager." —
 * before the usage and the options. So the first paragraph that reads as
 * prose is taken: not a usage line, a heading, an option, an error or
 * the version, and at least three words.
 */
export function describeFromHelp(help: string, version: string | null = null): string {
  const lines = cleanLines(help);
  const prose = (line: string) =>
    line !== "" &&
    !NOT_PROSE.test(line) &&
    !line.endsWith(":") &&
    !/^[-[<]/.test(line) &&
    line !== version &&
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
