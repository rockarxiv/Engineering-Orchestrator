import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { RUN_MEMORY_MAX_MB, RUN_MEMORY_MIN_MB, type GuardConfigView, type RunMemoryFacts, type RunProcessScope } from "@eo/core";
import { containedLaunch, containment, executable, type ContainedLaunch, type Containment } from "./cgroupContainment.js";

/**
 * A run's process tree in a systemd scope of its own (EO-738).
 *
 * On 2026-11-11 a 14 GB machine ran out of memory twice while three
 * implementers ran lint, typecheck and tests. Each time the kernel killed
 * one agent's `node`, and because every agent's processes lived inside
 * EO's own unit (`app-EO-….scope`, started by the desktop launcher), whose
 * `OOMPolicy` is systemd's default `stop`, systemd stopped the whole unit:
 * EO, every other run, and the network service with them. Nothing said why.
 *
 * So, where a systemd user manager is reachable on Linux, the tree a run
 * starts — the backend's CLI and everything it starts, or a module run's
 * host — is started by `systemd-run --user --scope` in a transient unit of
 * its own, a sibling of EO's in `app.slice` and never inside it:
 *
 * - `MemoryMax` is the `runMemoryMaxMb` guardrail, or EO's default for
 *   this machine (`defaultRunMemoryMaxMb`).
 * - `OOMPolicy=stop` is said rather than inherited: an OOM kill inside the
 *   scope stops that scope, all of it, and nothing else. EO's own unit
 *   sees none of it, whatever unit or launcher EO was started by, because
 *   a kill counts against the cgroup it happened in and its ancestors —
 *   and EO's cgroup is neither.
 *
 * `systemd-run --scope` registers the scope for its own pid and then
 * `exec`s the command, so the process EO spawned *is* the command — the
 * same pid, the same pipes and descriptors, the same environment — now
 * inside the scope before it runs an instruction of its own. The scope's
 * cgroup is then what EO-494's containment is (`cgroupContainment.ts`):
 * what holds every process the run started, and what `cgroup.kill` ends.
 *
 * One spawn site: `launchTree` is the only way a run's tree is planned,
 * and both backends' adapters and the module host go through it, which
 * `providerParity.test.ts` holds. Everything that talks to systemd is in
 * this file, behind `RunScopes`, the way a native module has one import
 * site behind an interface. A process EO starts for a run outside that
 * tree — a check command after the run, a git call — is not in it.
 *
 * Anywhere else — macOS, Windows, Linux with no systemd user manager to
 * reach, or one that does not delegate the memory controller — a run
 * starts exactly as it did, contained by EO-494 where that works, and
 * `runMemoryFacts` says the limit does not apply, which the Guardrails
 * screen shows rather than offering a control that does nothing.
 */

/** What became of a run whose scope ran out of memory. */
export interface RunOutOfMemory {
  runId: string;
  /** The transient unit, `eo-run-….scope`. */
  unit: string;
  /** The `MemoryMax` the scope was started with. */
  memoryMaxMb: number;
  /**
   * True when the run reached its own limit, false when the machine as a
   * whole ran out and the kernel chose a process in this run; null where
   * nothing EO can read says which.
   */
  limitReached: boolean | null;
  /**
   * The process the kernel killed, and how EO knows: `kernel` when the
   * kernel's own log named it; `ranked` when it is the process with the
   * highest OOM score in the scope when EO last looked, which is the one
   * the kernel picks; `launched` when the scope was gone before EO could
   * look inside it at all, and it is the process the run started with.
   */
  killed: { pid: number; name: string; how: "kernel" | "ranked" | "launched" } | null;
}

export type RunScopeAvailability = { applies: true } | { applies: false; reason: string };

/**
 * The interface every run's tree is started through (EO-738). One real
 * implementation, `systemdRunScopes`; tests put their own in its place
 * with `setRunScopes`.
 */
export interface RunScopes {
  /** Whether a run's processes are given a scope of their own on this machine, and if not, why. */
  availability(): RunScopeAvailability;
  /**
   * How to start `command args` inside a new scope for the run, or null
   * where none can be made for it — the caller then starts the tree as
   * it always did.
   */
  plan(scope: RunProcessScope, name: string, command: string, args: readonly string[], env: NodeJS.ProcessEnv | undefined, cwd: string | undefined): ContainedLaunch | null;
  /**
   * Whether any scope of the run ended out of memory — the run reaching
   * its limit, or the kernel choosing a process in it when the machine
   * ran out. Asked once a run has ended badly; settles once each of the
   * run's scopes can say, and never rejects.
   */
  outOfMemory(runId: string): Promise<RunOutOfMemory | null>;
  /**
   * Files the scopes made under `from` under `to` instead: a process
   * started ahead of its turn, in a scope filed under its conversation
   * (`warm:…`), adopted by a run, whose ending is then that run's to ask
   * about (`outOfMemory`).
   */
  handOver(from: string, to: string): void;
}

let current: RunScopes | null = null;

/** The run scopes this process starts trees through. */
export function runScopes(): RunScopes {
  current ??= systemdRunScopes();
  return current;
}

/** Seam for tests: starts every tree through `scopes` until the returned function is called. */
export function setRunScopes(scopes: RunScopes): () => void {
  const before = current;
  current = scopes;
  return () => {
    current = before;
  };
}

/**
 * Plans how a run's process tree is started — the one place that is
 * decided (EO-738).
 *
 * With a scope, and where `RunScopes` can make one, inside a transient
 * systemd scope of the run's own. Otherwise as EO-494 starts it: in a
 * cgroup below EO's own where the machine allows, and as it is anywhere
 * else.
 */
export function launchTree(
  name: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
  cwd: string | undefined,
  scope: RunProcessScope | undefined,
): ContainedLaunch {
  if (scope !== undefined) {
    const scoped = runScopes().plan(scope, name, command, args, env, cwd);
    if (scoped !== null) return scoped;
  }
  return containedLaunch(name, command, args, env, cwd);
}

/**
 * A module run's host in the run's scope (EO-738): the same interface,
 * and null where no scope can be made — the host then starts as it
 * always has, in a process group of its own and in no cgroup EO made,
 * rather than in EO-494's containment, which a module host never had.
 */
export function launchInRunScope(
  scope: RunProcessScope,
  name: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
  cwd: string | undefined,
): ContainedLaunch | null {
  return runScopes().plan(scope, name, command, args, env, cwd);
}

/**
 * What a warm process's scope must share with the turn that adopts it
 * (EO-738): its memory limit. Which run it names is not — a warm process
 * is started before any run exists — so both adapters put this, and not
 * the scope, into what a warm process must match: a limit changed since
 * the warm-up starts the turn afresh at the new one.
 */
export function warmScopeKey(scope: RunProcessScope | undefined): number | null {
  return scope?.memoryMaxMb ?? null;
}

/**
 * A process started ahead of its turn, adopted by it (EO-738): its scope,
 * filed under the warm-up, is the run's from now on, so an out-of-memory
 * ending is the run's to hear of. Both adapters call this as they adopt.
 */
export function adoptWarmScope(warm: RunProcessScope | undefined, turn: RunProcessScope | undefined): void {
  if (warm === undefined || turn === undefined || warm.runId === turn.runId) return;
  runScopes().handOver(warm.runId, turn.runId);
}

/** The variables `systemd-run` finds the user manager through, from `env`. */
export function busEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    const value = env[name];
    if (value) found[name] = value;
  }
  return found;
}

/** The machine's memory, in whole megabytes. */
export function machineMemoryMb(): number {
  return Math.floor(totalmem() / (1024 * 1024));
}

/**
 * EO's default `runMemoryMaxMb` for a machine (EO-738): three quarters of
 * its memory, shared between as many runs as the global concurrency cap
 * lets run at once. The quarter left over is for EO, the desktop and
 * everything else on the machine; dividing by the cap is what keeps every
 * run at its limit at once still inside the three quarters. Held to the
 * guardrail's own range.
 */
export function defaultRunMemoryMaxMb(totalMb: number, globalConcurrency: number): number {
  const share = Math.floor((totalMb * 0.75) / Math.max(1, globalConcurrency));
  return Math.min(RUN_MEMORY_MAX_MB, Math.max(RUN_MEMORY_MIN_MB, share));
}

/** What a run is given: the person's limit where they set one, EO's default for this machine where not. */
export function effectiveRunMemoryMaxMb(guards: Pick<GuardConfigView, "runMemoryMaxMb" | "globalConcurrency">, totalMb: number = machineMemoryMb()): number {
  return guards.runMemoryMaxMb ?? defaultRunMemoryMaxMb(totalMb, guards.globalConcurrency);
}

/** `guards:runMemory`'s answer. */
export function runMemoryFacts(guards: Pick<GuardConfigView, "runMemoryMaxMb" | "globalConcurrency">, scopes: RunScopes = runScopes(), totalMb: number = machineMemoryMb()): RunMemoryFacts {
  const availability = scopes.availability();
  return {
    applies: availability.applies,
    reason: availability.applies ? null : availability.reason,
    totalMb,
    defaultMb: defaultRunMemoryMaxMb(totalMb, guards.globalConcurrency),
    effectiveMb: effectiveRunMemoryMaxMb(guards, totalMb),
  };
}

// ───────────────────────────── systemd ─────────────────────────────

const CGROUP_ROOT = "/sys/fs/cgroup";
/** How often a live scope is looked at: what it holds, and what its memory events say. */
const SAMPLE_MS = 2_000;
/**
 * The first looks at a new scope, sooner than `SAMPLE_MS`: a run that
 * runs out of memory in its first seconds is still seen with what it
 * started, so its process can be named where the kernel log cannot be
 * read.
 */
const FIRST_LOOKS_MS = [25, 100, 250, 500, 1_000] as const;
/** How long a scope that never appeared is waited for before it is given up on. */
const NEVER_APPEARED_MS = 30_000;
/** How long a run's ending waits for its scopes to say how they ended. */
const VERDICT_WAIT_MS = 15_000;
/** How long an out-of-memory report nobody asked for is kept. */
const UNCLAIMED_REPORT_MS = 60 * 60 * 1000;
/** How long a unit still stopping is waited on for its result. */
const SETTLE_MS = 12_000;
/** How long a scope is given to stop after SIGTERM before systemd kills what is left. */
const STOP_TIMEOUT = "10s";

interface Manager {
  systemdRun: string;
  systemctl: string;
  journalctl: string | null;
  /** The cgroup directory transient scopes in `app.slice` are made in. */
  scopesDirectory: string;
}

/** Where on `PATH` a program is, or null. */
function which(program: string): string | null {
  for (const directory of (process.env["PATH"] ?? "/usr/bin:/bin").split(":").filter(Boolean)) {
    const candidate = join(directory, program);
    if (executable(candidate, undefined, undefined)) return candidate;
  }
  return null;
}

/** How many probes this process has made: each needs a unit name of its own while the last may still be collected. */
let probes = 0;

export interface SystemdRunScopesOptions {
  /** Extra `-p` properties for every scope — a test's `MemorySwapMax=0`, so its limit is reached rather than swapped past. */
  properties?: readonly string[];
  /** Seam for tests: false reads no kernel log, as for a user the kernel log is closed to. */
  kernelLog?: boolean;
}

/**
 * The real `RunScopes`: `systemd-run --user --scope`.
 *
 * Whether it works here is found out once, the first time anybody asks,
 * by starting a scope that does nothing — the only check that answers
 * "is a user manager reachable, and will it make me a scope" without
 * guessing from the environment — and said once to the log when it does
 * not.
 */
export function systemdRunScopes(options: SystemdRunScopesOptions = {}): RunScopes {
  let probed: Manager | { reason: string } | null = null;
  const watches = new Map<string, ScopeWatch[]>();

  const manager = (): Manager | { reason: string } => {
    if (probed !== null) return probed;
    probed = probe(++probes);
    if (!("reason" in probed) && options.kernelLog === false) probed = { ...probed, journalctl: null };
    if ("reason" in probed) console.warn(`[eo] a run's processes are not given a memory scope of their own: ${probed.reason}. Runs start as they did, and the run memory limit does not apply.`);
    return probed;
  };

  return {
    availability() {
      const found = manager();
      return "reason" in found ? { applies: false, reason: found.reason } : { applies: true };
    },

    plan(scope, name, command, args, env, cwd) {
      const found = manager();
      if ("reason" in found) return null;
      const environment = env ?? process.env;
      // `systemd-run` finds the user manager through these, and the
      // command runs with the same environment. A launch handed one
      // without them is started as before rather than one that fails.
      if (!environment["XDG_RUNTIME_DIR"] && !environment["DBUS_SESSION_BUS_ADDRESS"]) return null;
      // A command that is not there is spawned as it is, so the caller
      // sees the `ENOENT` Node gives it — how a backend that is not
      // installed is told apart — rather than `systemd-run`'s exit 1.
      if (!executable(command, environment["PATH"], cwd)) return null;
      const unit = `eo-run-${name.replace(/^eo-tree-/, "")}.scope`;
      const path = join(found.scopesDirectory, unit);
      return {
        command: found.systemdRun,
        args: [
          "--user",
          "--scope",
          "--quiet",
          "--slice=app.slice",
          `--unit=${unit}`,
          `--description=EO run ${scope.runId}`,
          "-p",
          `MemoryMax=${scope.memoryMaxMb}M`,
          "-p",
          "OOMPolicy=stop",
          "-p",
          `TimeoutStopSec=${STOP_TIMEOUT}`,
          ...(options.properties ?? []).flatMap((property) => ["-p", property]),
          "--",
          command,
          ...args,
        ],
        adopt(pid) {
          if (pid === undefined) return null; // Never started; no scope will appear.
          // What it started as, for a scope that is gone before EO has
          // looked inside it: `systemd-run` execs the command, so the pid
          // is the command's, and its name is what the kernel calls it.
          const launched = { pid, name: basename(command).slice(0, 15) };
          const watch: ScopeWatch = new ScopeWatch(found, scope, unit, path, launched, () => {
            const list = watches.get(watch.owner)?.filter((other) => other !== watch) ?? [];
            if (list.length > 0) watches.set(watch.owner, list);
            else watches.delete(watch.owner);
          });
          watches.set(scope.runId, [...(watches.get(scope.runId) ?? []), watch]);
          return scopeContainment(path);
        },
      };
    },

    async outOfMemory(runId) {
      const list = watches.get(runId) ?? [];
      for (const watch of list) {
        const report = await Promise.race([watch.verdict(), new Promise<null>((resolve) => setTimeout(() => resolve(null), VERDICT_WAIT_MS).unref())]);
        if (report !== null) {
          watch.forget();
          return report;
        }
      }
      return null;
    },

    handOver(from, to) {
      const moving = watches.get(from);
      if (moving === undefined) return;
      watches.delete(from);
      for (const watch of moving) watch.owner = to;
      watches.set(to, [...(watches.get(to) ?? []), ...moving]);
    },
  };

  function probe(attempt: number): Manager | { reason: string } {
    if (process.platform !== "linux") return { reason: `${process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : process.platform} has no systemd` };
    if (!existsSync(join(CGROUP_ROOT, "cgroup.controllers"))) return { reason: "this machine does not use the cgroup v2 hierarchy" };
    if (!process.env["XDG_RUNTIME_DIR"] && !process.env["DBUS_SESSION_BUS_ADDRESS"]) return { reason: "EO was started outside a user session, so there is no systemd user manager to reach" };
    const systemdRun = which("systemd-run");
    const systemctl = which("systemctl");
    if (systemdRun === null || systemctl === null) return { reason: "systemd-run is not installed" };
    let output: string;
    try {
      output = execFileSync(
        systemdRun,
        ["--user", "--scope", "--quiet", "--collect", "--slice=app.slice", `--unit=eo-probe-${process.pid}-${attempt}.scope`, "--", "/bin/cat", "/proc/self/cgroup"],
        { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
    } catch (error) {
      const stderr = (error as { stderr?: unknown }).stderr;
      const said = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim().split("\n")[0] : error instanceof Error ? error.message : String(error);
      return { reason: `the systemd user manager could not be reached (${said})` };
    }
    const line = output.split("\n").find((entry) => entry.startsWith("0::"));
    if (line === undefined) return { reason: "a scope systemd started reported no cgroup v2 path" };
    const scopesDirectory = join(CGROUP_ROOT, dirname(line.slice(3).trim()));
    let delegated = "";
    try {
      delegated = readFileSync(join(scopesDirectory, "cgroup.subtree_control"), "utf8");
    } catch {
      // Unreadable is the same as not delegated, below.
    }
    if (!delegated.split(/\s+/).includes("memory")) return { reason: "the systemd user manager does not have the memory controller, so a limit would not be enforced" };
    return { systemdRun, systemctl, journalctl: which("journalctl"), scopesDirectory };
  }
}

/**
 * The scope's cgroup as EO-494's containment: what it holds, and the
 * kernel's kill. Never taken away by EO — the scope is systemd's, and
 * systemd removes its cgroup once the last process has gone.
 */
function scopeContainment(path: string): Containment {
  const inner = containment(path);
  return { path, pids: inner.pids, kill: inner.kill, remove: () => !existsSync(path) };
}

/** `memory.events`, as numbers. */
function memoryEvents(path: string): Record<string, number> | null {
  try {
    const events: Record<string, number> = {};
    for (const line of readFileSync(join(path, "memory.events"), "utf8").split("\n")) {
      const [key, value] = line.trim().split(/\s+/);
      if (key && value !== undefined) events[key] = Number(value);
    }
    return events;
  } catch {
    return null;
  }
}

/** Every pid in a cgroup and the cgroups below it. */
function scopePids(path: string): number[] {
  return containment(path).pids();
}

function readProc(pid: number, file: string): string | null {
  try {
    return readFileSync(`/proc/${pid}/${file}`, "utf8").trim();
  } catch {
    return null;
  }
}

function run(program: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(program, [...args], { encoding: "utf8", timeout: 5_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout));
  });
}

/**
 * One scope, watched from the moment its process is spawned until systemd
 * has said how it ended.
 *
 * While it is there, it is looked at — a few times in its first second
 * (`FIRST_LOOKS_MS`), then every `SAMPLE_MS` — for which process in
 * it the kernel would pick first (`/proc/<pid>/oom_score`, the kernel's
 * own ranking), and its memory events. Once its cgroup has gone, systemd
 * is asked for the unit's `Result` — `oom-kill` is what an OOM kill
 * inside it ends as — and a failed unit is reset so it does not linger.
 */
class ScopeWatch {
  /** The run the scope is filed under: a warm-up's until a run adopts it (`handOver`). */
  owner: string;
  private readonly startedAt = Date.now();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly firstLooks: ReturnType<typeof setTimeout>[];
  private appeared = false;
  private events: Record<string, number> = {};
  private likeliest: { pid: number; name: string; how: "ranked" | "launched" };
  private ending: Promise<RunOutOfMemory | null> | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private forgotten = false;

  constructor(
    private readonly manager: Manager,
    private readonly scope: RunProcessScope,
    private readonly unit: string,
    private readonly path: string,
    launched: { pid: number; name: string },
    private readonly onForget: () => void,
  ) {
    this.owner = scope.runId;
    this.likeliest = { ...launched, how: "launched" };
    this.timer = setInterval(() => this.look(), SAMPLE_MS);
    this.timer.unref();
    this.firstLooks = FIRST_LOOKS_MS.map((ms) => {
      const look = setTimeout(() => this.look(), ms);
      look.unref();
      return look;
    });
  }

  /** Whether this scope ended out of memory, as soon as that can be said. */
  verdict(): Promise<RunOutOfMemory | null> {
    if (this.ending !== null) return this.ending;
    // Still there: what the kernel has counted in it so far is the
    // answer. A run that failed for any other reason has nothing here,
    // and is not held up waiting for its scope to go. Gone — even between
    // looking for it and reading it — and systemd's word on the unit is.
    const events = existsSync(this.path) ? memoryEvents(this.path) : null;
    if (events === null) return this.end();
    this.look();
    if ((events["oom_kill"] ?? 0) + (events["oom_group_kill"] ?? 0) === 0) return Promise.resolve(null);
    return this.report(events);
  }

  /**
   * Stops keeping a report somebody has now read. The watching goes on
   * until the unit has gone, so a failed one is still reset.
   */
  forget(): void {
    this.forgotten = true;
    if (this.expiry) clearTimeout(this.expiry);
    this.onForget();
  }

  private look(): void {
    if (this.ending !== null) return;
    if (!existsSync(this.path)) {
      if (this.appeared || Date.now() - this.startedAt > NEVER_APPEARED_MS) void this.end();
      return;
    }
    this.appeared = true;
    this.events = memoryEvents(this.path) ?? this.events;
    let best: { pid: number; name: string; score: number } | null = null;
    for (const pid of scopePids(this.path)) {
      const score = Number(readProc(pid, "oom_score") ?? NaN);
      const name = readProc(pid, "comm");
      if (Number.isNaN(score) || name === null) continue;
      if (best === null || score > best.score) best = { pid, name, score };
    }
    if (best !== null) this.likeliest = { pid: best.pid, name: best.name, how: "ranked" };
  }

  /** The unit has gone, or never came: what systemd says it ended as. */
  private end(): Promise<RunOutOfMemory | null> {
    if (this.ending !== null) return this.ending;
    clearInterval(this.timer);
    for (const look of this.firstLooks) clearTimeout(look);
    this.ending = (async () => {
      // A unit still stopping has not settled its result yet: the run's
      // process can be seen gone before systemd has finished with it.
      let result: string;
      for (const deadline = Date.now() + SETTLE_MS; ; ) {
        const [state = "", said = ""] = ((await run(this.manager.systemctl, ["--user", "show", "--property=ActiveState,Result", "--value", this.unit])) ?? "").split("\n").map((line) => line.trim());
        result = said;
        if (!["active", "activating", "deactivating", "reloading"].includes(state) || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (result !== "" && result !== "success") await run(this.manager.systemctl, ["--user", "reset-failed", this.unit]);
      const counted = (this.events["oom_kill"] ?? 0) + (this.events["oom_group_kill"] ?? 0) > 0;
      if (result !== "oom-kill" && !counted) {
        this.onForget();
        return null;
      }
      const report = await this.report(this.events);
      // Kept for the run's ending to read; let go of if it never does.
      if (!this.forgotten) {
        this.expiry = setTimeout(() => this.onForget(), UNCLAIMED_REPORT_MS);
        this.expiry.unref();
      }
      return report;
    })();
    return this.ending;
  }

  private async report(events: Record<string, number>): Promise<RunOutOfMemory> {
    const kernel = await this.fromKernelLog();
    return {
      runId: this.owner,
      unit: this.unit,
      memoryMaxMb: this.scope.memoryMaxMb,
      limitReached: kernel?.limitReached ?? ((events["oom"] ?? 0) > 0 ? true : null),
      killed: kernel?.killed ?? this.likeliest,
    };
  }

  /**
   * The kernel's own line for the kill, where this user may read the
   * kernel log: `oom-kill:constraint=…,oom_memcg=…,task_memcg=…,task=…,pid=…`.
   * Which cgroup ran out says whether it was this run's limit or the
   * whole machine; `task` and `pid` name the process.
   */
  private async fromKernelLog(): Promise<{ limitReached: boolean; killed: { pid: number; name: string; how: "kernel" } } | null> {
    if (this.manager.journalctl === null) return null;
    const since = Math.floor(this.startedAt / 1000) - 1;
    const log = await run(this.manager.journalctl, ["-k", "-q", "-o", "cat", "--no-pager", `--since=@${since}`]);
    if (log === null) return null;
    const cgroup = this.path.slice(CGROUP_ROOT.length);
    const within = (memcg: string) => memcg === cgroup || memcg.startsWith(`${cgroup}/`);
    for (const line of log.split("\n")) {
      const fields = /oom-kill:.*\boom_memcg=([^,]*),task_memcg=([^,]*),task=([^,]*),pid=(\d+)/.exec(line);
      if (fields === null || !within(fields[2]!)) continue;
      return { limitReached: within(fields[1]!), killed: { pid: Number(fields[4]), name: fields[3]!, how: "kernel" } };
    }
    return null;
  }
}
