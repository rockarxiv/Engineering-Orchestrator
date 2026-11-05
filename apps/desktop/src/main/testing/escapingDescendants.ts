import { readFileSync } from "node:fs";
import { containmentAvailable } from "../process/cgroupContainment.js";

/**
 * What an agent's process starts that a kill to its one pid misses
 * (EO-494), as JavaScript for a stand-in agent to run.
 *
 * On Linux and macOS, three `sleep 600`s, each the shape of something an
 * agent really leaves:
 *
 * - **escaped**: `setsid sleep 600 &` from a shell that then exits, as a
 *   Bash call backgrounding a test runner does. Its own session, and by
 *   the time anything looks, pid 1's child, not the agent's.
 * - **bare**: `setsid sleep 600` started with an environment of its own,
 *   as Codex starts an MCP server. Its own session, and no mark — only
 *   its parent says whose it is.
 * - **vanished**: both at once — `env -i … setsid sleep 600 &` from a
 *   shell that exits. Nothing about it says whose it is: not its parent,
 *   not its session, not its environment. Only a cgroup still does.
 *
 * Where there is no `setsid` (macOS), Node's `detached`, which is the
 * same `setsid(2)`. On Windows, which has neither sessions nor a shell to
 * background from, two Node children — one plain, one `detached` into a
 * process group of its own.
 *
 * Expects `pidFile` to be defined, and writes `<kind> <pid>` lines to it
 * before returning.
 */
export const DESCENDANTS_SNIPPET = String.raw`
{
  const { execSync, spawn } = require("node:child_process");
  const fs = require("node:fs");
  const lines = [];
  if (process.platform === "win32") {
    const idle = ["-e", "setInterval(() => {}, 1000)"];
    const plain = spawn(process.execPath, idle, { stdio: "ignore", windowsHide: true });
    const detached = spawn(process.execPath, idle, { stdio: "ignore", detached: true, windowsHide: true });
    plain.unref();
    detached.unref();
    lines.push("plain " + plain.pid, "detached " + detached.pid);
  } else {
    let setsid = true;
    try { execSync("command -v setsid", { stdio: "ignore", shell: "/bin/sh" }); } catch { setsid = false; }
    const detach = JSON.stringify(process.execPath) + " -e 'const c = require(\"node:child_process\").spawn(\"sleep\", [\"600\"], { detached: true, stdio: \"ignore\" }); console.log(c.pid);'";
    const background = (prefix) => execSync(prefix + (setsid ? "setsid sleep 600 >/dev/null 2>&1 </dev/null & echo $!" : detach), { shell: "/bin/sh", encoding: "utf8", windowsHide: true }).trim();
    const escaped = background("");
    const vanished = background("env -i PATH=/usr/bin:/bin ");
    const bare = spawn(setsid ? "setsid" : "sleep", setsid ? ["sleep", "600"] : ["600"], { env: { PATH: process.env.PATH }, stdio: "ignore", detached: !setsid, windowsHide: true });
    // Not the reason the agent stays: an agent that goes on its own leaves it behind.
    bare.unref();
    lines.push("escaped " + escaped, "bare " + bare.pid, "vanished " + vanished);
  }
  fs.writeFileSync(pidFile, lines.join("\n") + "\n");
}
`;

export type DescendantKind = "escaped" | "bare" | "vanished" | "plain" | "detached";

/** How many descendants the stand-in starts on this platform. */
const STARTED = process.platform === "win32" ? 2 : 3;

/** The descendants a stand-in wrote, once it has: kind → pid. */
export async function descendantPids(pidFile: string, ms = 10_000): Promise<Map<DescendantKind, number>> {
  const deadline = Date.now() + ms;
  for (;;) {
    let text = "";
    try {
      text = readFileSync(pidFile, "utf8");
    } catch {
      // Not written yet.
    }
    const entries = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split(" "))
      .map(([kind, pid]) => [kind as DescendantKind, Number(pid)] as const);
    if (entries.length === STARTED && entries.every(([, pid]) => Number.isInteger(pid) && pid > 1)) return new Map(entries);
    if (Date.now() > deadline) throw new Error(`no descendant pids in ${pidFile}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * The descendants EO is held to ending on this machine — the named
 * exception approved on EO-494, and nothing wider (`processTree.ts`):
 * every one, where agent processes are contained in a cgroup of their
 * own; elsewhere every one but `vanished`, the one that replaced its
 * environment and lost its parent before anything looked, which nothing
 * short of containment can promise. Never anything else is excused.
 */
export function owed(descendants: Map<DescendantKind, number>): number[] {
  const contained = containmentAvailable();
  return [...descendants].filter(([kind]) => contained || kind !== "vanished").map(([, pid]) => pid);
}

/**
 * Set by CI where it has handed the suite a cgroup of its own, so a
 * machine that should contain agents and does not fails rather than
 * quietly holding EO to less.
 */
export const CONTAINMENT_EXPECTED = process.env["EO_EXPECT_CGROUP_CONTAINMENT"] === "1";

/** Whether a process is there, a zombie counted as gone: it is dead, only not yet collected. */
export function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^[ZX]$/.test(stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3));
  } catch {
    return false;
  }
}

/** Polls until none of `pids` is running, or `ms` has passed; whether they all went. */
export async function allGone(pids: readonly number[], ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (pids.some(running)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

/** Ends whatever a failing case left, so a red test does not leave sleeps behind. */
export function sweepUp(pids: readonly number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone.
    }
  }
}
