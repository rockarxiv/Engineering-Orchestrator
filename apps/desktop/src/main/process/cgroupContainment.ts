import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/**
 * A cgroup of an agent's own, below EO's (EO-494).
 *
 * The one record of "started by this agent" that nothing the agent does
 * can lose. Finding an agent's descendants by parentage loses one whose
 * parent exits before anybody looks; finding them by an inherited
 * environment variable loses one started with `env -i`. A process's
 * cgroup is inherited across fork and exec, is not touched by `setsid`,
 * by re-parenting or by any environment, and can only be changed by a
 * deliberate write to a cgroup EO's user may write to — so every process
 * in the agent's cgroup is the agent's, and the agent's cgroup holds
 * every process the agent started.
 *
 * Linux with cgroup v2, where EO's own cgroup is its user's to write to:
 * what a systemd user session gives every desktop application (EO runs
 * in an `app-….scope` of its own), and what the CI job is handed before
 * the suite runs. Anywhere else — macOS, Windows, a cgroup EO's user
 * does not own, cgroup v1 — `contain` answers null and the tree falls
 * back to finding descendants (`processTree.ts`), which is said there.
 *
 * The agent is in its cgroup before it runs a single instruction of its
 * own (`containedLaunch`): what is spawned is `/bin/sh`, which writes its
 * own pid into the cgroup and then `exec`s the agent in its place — the
 * same pid, the same pipes, the same environment, now born contained. A
 * launcher that forks the moment it starts cannot fork outside. Moving
 * the process in after `spawn` returns is only the second line, for a
 * spawn that could not go through the shell.
 */

const ROOT = "/sys/fs/cgroup";

/** Why `contain` will not work here, once one attempt has said so; undefined until something has asked. */
let unavailable: string | null | undefined;

/** EO's own cgroup directory, on cgroup v2; null where there is none. */
export function ownCgroupDirectory(): string | null {
  if (process.platform !== "linux") return null;
  try {
    if (!existsSync(join(ROOT, "cgroup.controllers"))) return null; // Not the unified hierarchy.
    const line = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((entry) => entry.startsWith("0::"));
    if (line === undefined) return null;
    return join(ROOT, line.slice(3).trim());
  } catch {
    return null;
  }
}

export interface Containment {
  /** The cgroup's directory. */
  readonly path: string;
  /** Every process in it and in any cgroup below it — what the agent has made of it. */
  pids(): number[];
  /**
   * SIGKILL to every process in it, by the kernel (`cgroup.kill`, Linux
   * 5.14): nothing in it can fork its way out of the kill. False where
   * the kernel is older and every pid has to be signalled instead.
   */
  kill(): boolean;
  /** Takes the cgroup away once it is empty. Whether it is gone. */
  remove(): boolean;
}

/**
 * Says once, to the log, that this machine gets the best-effort side of
 * EO-494's named exception (`processTree.ts`), and why; every later
 * spawn is planned without containment.
 */
function giveUp(reason: string): void {
  if (unavailable) return;
  unavailable = reason;
  console.warn(
    `[eo] agent processes are not contained in a cgroup of their own: ${reason}. What an agent starts is found by its parentage and its environment instead, ` +
      "which cannot promise a process that both replaces its environment and is orphaned before EO looks.",
  );
}

/**
 * Moves `pid` into a new cgroup named `name` below EO's own, and answers
 * it; null where that cannot be done here, said once to the console.
 */
export function contain(pid: number, name: string): Containment | null {
  if (unavailable) return null;
  const parent = ownCgroupDirectory();
  if (parent === null) {
    giveUp("no cgroup v2 hierarchy");
    return null;
  }
  const path = join(parent, name);
  try {
    mkdirSync(path);
  } catch (error) {
    giveUp(`cannot create a cgroup under ${parent} (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
    return null;
  }
  try {
    writeFileSync(join(path, "cgroup.procs"), String(pid));
  } catch (error) {
    try {
      rmdirSync(path);
    } catch {
      // Left empty; harmless, and gone with EO's own cgroup.
    }
    const code = (error as NodeJS.ErrnoException).code;
    // A process already gone is this one's problem, not the machine's.
    if (code !== "ESRCH") {
      giveUp(`cannot move a process into ${path} (${code ?? String(error)})`);
    }
    return null;
  }
  return containment(path);
}

/** How an agent is to be spawned so that it starts inside its cgroup, and what to do once it has been. */
export interface ContainedLaunch {
  /** What to spawn in place of the agent's own command — `/bin/sh`, where the agent can be contained. */
  readonly command: string;
  readonly args: string[];
  /**
   * Called with the spawned pid at once: moves it in a second time —
   * harmless when the shell already has, and the whole of it for a spawn
   * that did not go through the shell — and answers the cgroup, or null.
   */
  adopt(pid: number | undefined): Containment | null;
}

/**
 * The shell that puts itself in the cgroup named by `$0` and becomes the
 * agent. A write that fails is not a reason to withhold the agent: it
 * starts all the same, and `adopt` tries once more from outside.
 */
const TRAMPOLINE = 'echo $$ > "$0/cgroup.procs" 2>/dev/null; exec "$@"';

/**
 * Plans `command args` so it starts inside a new cgroup named `name`
 * (EO-494): `/bin/sh -c TRAMPOLINE <cgroup> command args…`.
 *
 * Only for a command that is there to be run. One that is not is
 * spawned as it is, so the caller sees the `ENOENT` Node gives it —
 * which is how a backend that is not installed is told apart — rather
 * than a shell's "not found" and exit 127. Where nothing can be
 * contained, the plan is the command unchanged and `adopt` answers null.
 */
export function containedLaunch(name: string, command: string, args: readonly string[], env: NodeJS.ProcessEnv | undefined, cwd: string | undefined): ContainedLaunch {
  const unchanged = { command, args: [...args] };
  if (process.platform !== "linux") giveUp(`${process.platform} has no cgroups`);
  if (unavailable) return { ...unchanged, adopt: () => null };
  const parent = ownCgroupDirectory();
  if (parent === null) {
    giveUp("no cgroup v2 hierarchy");
    return { ...unchanged, adopt: () => null };
  }
  const path = join(parent, name);
  try {
    mkdirSync(path);
  } catch (error) {
    giveUp(`cannot create a cgroup under ${parent} (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
    return { ...unchanged, adopt: () => null };
  }
  const runnable = executable(command, env?.["PATH"] ?? process.env["PATH"], cwd) && executable("/bin/sh", undefined, undefined);
  return {
    ...(runnable ? { command: "/bin/sh", args: ["-c", TRAMPOLINE, path, command, ...args] } : unchanged),
    adopt(pid) {
      if (pid === undefined) {
        // Never started; nothing will be in it.
        removeDirectory(path);
        return null;
      }
      try {
        writeFileSync(join(path, "cgroup.procs"), String(pid));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Gone already is the process's business. Anything else, and the
        // shell — writing as the same user — was refused too.
        if (code !== "ESRCH") {
          removeDirectory(path);
          giveUp(`cannot move a process into ${path} (${code ?? String(error)})`);
          return null;
        }
      }
      return containment(path);
    },
  };
}

/** Whether `command` names a file that can be run, as `spawn` would look it up. */
function executable(command: string, path: string | undefined, cwd: string | undefined): boolean {
  const candidates = command.includes("/") ? [isAbsolute(command) ? command : resolve(cwd ?? process.cwd(), command)] : (path ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function removeDirectory(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // Left empty; harmless, and gone with EO's own cgroup.
  }
}

/**
 * Whether `contain` can work here: cgroup v2, a cgroup EO can make below
 * its own, and EO's own `cgroup.procs` its to write — which moving a
 * process out of it into one below needs. Asked without moving anything.
 */
export function containmentAvailable(): boolean {
  if (unavailable !== undefined) return unavailable === null;
  const parent = ownCgroupDirectory();
  if (parent === null) return false;
  const probe = join(parent, `eo-probe-${process.pid}`);
  try {
    accessSync(join(parent, "cgroup.procs"), constants.W_OK);
    mkdirSync(probe);
    accessSync(join(probe, "cgroup.procs"), constants.W_OK);
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmdirSync(probe);
    } catch {
      // Never made.
    }
  }
}

function containment(path: string): Containment {
  return {
    path,
    pids: () => [...new Set(walk(path).flatMap(readPids))],
    kill() {
      const file = join(path, "cgroup.kill");
      if (!existsSync(file)) return false;
      try {
        writeFileSync(file, "1");
        return true;
      } catch {
        return false;
      }
    },
    remove() {
      // Deepest first: a cgroup with cgroups below it cannot go.
      for (const directory of walk(path).reverse()) {
        try {
          rmdirSync(directory);
        } catch {
          // Not empty yet, or already gone.
        }
      }
      return !existsSync(path);
    },
  };
}

/** `path` and every cgroup below it, parents first. */
function walk(path: string): string[] {
  const found = [path];
  for (let index = 0; index < found.length; index++) {
    try {
      for (const entry of readdirSync(found[index]!, { withFileTypes: true })) if (entry.isDirectory()) found.push(join(found[index]!, entry.name));
    } catch {
      // Gone while being read.
    }
  }
  return found;
}

function readPids(directory: string): number[] {
  try {
    return readFileSync(join(directory, "cgroup.procs"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}
