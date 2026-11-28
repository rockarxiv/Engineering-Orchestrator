import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { SandboxAvailability } from "@eo/core";
import { searchDirectories, searchPath } from "../process/searchPath.js";

/**
 * Whether a backend's sandbox can start on this machine (EO-935,
 * ARCHITECTURE.md §12.7).
 *
 * What each backend needs is what EO-933 measured and what the pinned
 * binaries say of themselves:
 *
 * - **Linux, Claude.** The CLI's sandbox is bubblewrap, with socat
 *   carrying its network proxy, and the CLI looks for both on the PATH it
 *   is launched with ("bubblewrap (bwrap) not installed", "socat not
 *   installed" — Claude Code 2.1.329). So EO looks on the same PATH, the
 *   search PATH an agent is spawned with (`agentSpawnPath`), and then
 *   starts bubblewrap once, since a bubblewrap a kernel or a security
 *   module will not let create namespaces is installed and still useless.
 * - **Linux, Codex.** Codex 0.171.0 carries its own bubblewrap
 *   (`codex-resources/bwrap`) and runs with none on the PATH, so nothing
 *   need be installed. What can still stop it is the kernel, so EO starts
 *   the sandbox itself, as the binary does for a turn: `codex sandbox --
 *   true`, in a home of its own so the person's `~/.codex` is not read.
 * - **macOS, both.** Seatbelt, `/usr/bin/sandbox-exec`, which every macOS
 *   has. Not measured by EO's live tests.
 * - **Windows, both.** Not established for either CLI, so not offered:
 *   EO will not vouch for a sandbox nobody has seen hold.
 *
 * Null for any other backend, which runs no commands and has no sandbox
 * to start (`capabilitiesFor(...).sandboxes`).
 */
export async function sandboxAvailability(
  provider: string,
  executablePath: string | null,
  deps: SandboxAvailabilityDeps = DEFAULT_DEPS,
): Promise<SandboxAvailability | null> {
  if (provider !== "claude" && provider !== "codex") return null;
  if (deps.platform === "win32") {
    return {
      available: false,
      reason: `EO has not established ${backendName(provider)}'s sandbox on Windows, so it does not run a sandboxed agent there.`,
      fix: "Run this agent unsandboxed, or run it on Linux or macOS.",
    };
  }
  if (deps.platform === "darwin") {
    return deps.executable(SEATBELT)
      ? { available: true, how: "macOS's Seatbelt (sandbox-exec)" }
      : {
          available: false,
          reason: `${SEATBELT} is missing, and ${backendName(provider)}'s sandbox on macOS is Seatbelt.`,
          fix: "Repair or reinstall macOS, which ships it.",
        };
  }
  if (deps.platform !== "linux") {
    return {
      available: false,
      reason: `EO has not established ${backendName(provider)}'s sandbox on ${deps.platform}.`,
      fix: "Run this agent unsandboxed, or run it on Linux or macOS.",
    };
  }
  return provider === "claude" ? claudeOnLinux(deps) : codexOnLinux(executablePath, deps);
}

/** What the check reads of the machine. A seam for tests; the real machine otherwise. */
export interface SandboxAvailabilityDeps {
  platform: NodeJS.Platform;
  /** The first executable of this name on the search PATH an agent is spawned with, or null. */
  findOnPath: (name: string) => string | null;
  /** Whether this absolute path is an executable file. */
  executable: (path: string) => boolean;
  /** Runs a program to its end, with no shell. `ok` is a zero exit within the time allowed; `output` is what it wrote to stderr, then stdout. */
  run: (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<{ ok: boolean; output: string }>;
  /** A directory of its own for the check, removed when it is done. */
  scratch: () => { path: string; remove: () => void };
}

const SEATBELT = "/usr/bin/sandbox-exec";
const PROBE_TIMEOUT_MS = 20_000;

function backendName(provider: "claude" | "codex"): string {
  return provider === "claude" ? "Claude" : "Codex";
}

async function claudeOnLinux(deps: SandboxAvailabilityDeps): Promise<SandboxAvailability> {
  const bwrap = deps.findOnPath("bwrap");
  const socat = deps.findOnPath("socat");
  const missing = [bwrap === null ? "bubblewrap (bwrap)" : null, socat === null ? "socat" : null].filter((name) => name !== null);
  if (bwrap === null || socat === null) {
    return {
      available: false,
      reason: `Claude's sandbox on Linux needs bubblewrap and socat, and ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not installed on this machine.`,
      fix: `Install ${missing.join(" and ")} (for example \`sudo apt install ${[bwrap === null ? "bubblewrap" : null, socat === null ? "socat" : null].filter(Boolean).join(" ")}\`), then check again.`,
    };
  }
  const scratch = deps.scratch();
  try {
    const started = await deps.run(bwrap, ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-all", "--die-with-parent", "--", "true"], {
      cwd: scratch.path,
      env: { ...process.env, PATH: searchPath() },
    });
    if (!started.ok) {
      return {
        available: false,
        reason: `bubblewrap is installed but could not start a sandbox on this machine${said(started.output)}`,
        fix: "Allow unprivileged user namespaces for bubblewrap (a kernel setting or a security module such as AppArmor usually forbids them), then check again.",
      };
    }
  } finally {
    scratch.remove();
  }
  return { available: true, how: `bubblewrap (${bwrap}) and socat (${socat})` };
}

async function codexOnLinux(executablePath: string | null, deps: SandboxAvailabilityDeps): Promise<SandboxAvailability> {
  if (executablePath === null || (isAbsolute(executablePath) && !deps.executable(executablePath))) {
    return {
      available: false,
      reason: `Codex is not installed${executablePath === null ? "" : ` at ${executablePath}`}, so EO cannot start its sandbox to see whether it works here.`,
      fix: "Install Codex in Settings → Runtimes, then check again.",
    };
  }
  const scratch = deps.scratch();
  try {
    // A home of its own: the person's `~/.codex/config.toml` could name a
    // sandbox of its own, and the check is of the machine, not of them.
    const started = await deps.run(executablePath, ["sandbox", "--", "true"], {
      cwd: scratch.path,
      env: { ...process.env, PATH: searchPath(), CODEX_HOME: scratch.path },
    });
    if (!started.ok) {
      return {
        available: false,
        reason: `Codex could not start its sandbox on this machine${said(started.output)}`,
        fix: "Allow unprivileged user namespaces (a kernel setting or a security module such as AppArmor usually forbids them; Codex does not sandbox under WSL1), then check again.",
      };
    }
  } finally {
    scratch.remove();
  }
  return { available: true, how: "Codex's bubblewrap, which it carries with it" };
}

/** What a failed start said, as the end of a sentence. */
function said(output: string): string {
  const last = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("WARNING:"))
    .slice(-2)
    .join(" ");
  if (last === "") return ".";
  return `: ${last.length > 300 ? `${last.slice(0, 300)}…` : last}`;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return existsSync(path);
  } catch {
    return false;
  }
}

const DEFAULT_DEPS: SandboxAvailabilityDeps = {
  platform: process.platform,
  findOnPath: (name) => {
    for (const directory of searchDirectories()) {
      const candidate = join(directory, name);
      if (isExecutable(candidate)) return candidate;
    }
    return null;
  },
  executable: isExecutable,
  run: (command, args, { cwd, env }) =>
    new Promise((resolve) => {
      execFile(command, [...args], { cwd, env, timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ ok: error === null, output: `${String(stderr)}\n${String(stdout)}${error && !stderr ? `\n${error.message}` : ""}` });
      });
    }),
  scratch: () => {
    const path = mkdtempSync(join(tmpdir(), "eo-sandbox-check-"));
    return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
  },
};
