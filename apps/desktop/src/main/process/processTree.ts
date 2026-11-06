import { execFile, execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { constants as osConstants, setPriority } from "node:os";
import { uuidv7 } from "@eo/core";
import { contain as containInCgroup, type Containment } from "./cgroupContainment.js";
import { END_PROCESS_GRACE_MS, endProcess, hasExited, type EndableProcess } from "./endProcess.js";
import { windowsSystemExecutable } from "./systemTar.js";

/**
 * An agent's process and everything it started, ended together (EO-494).
 *
 * `endProcess` reaches the one pid it is given, and on EO-487 that was
 * not enough: the CLI went, and its shells, its test runners and its MCP
 * servers stayed — re-parented, still in EO's cgroup, still holding
 * memory. A process group does not answer it either: the agent's Bash
 * commands are free to start something with `setsid`, in the background
 * of a shell that then exits, under `env -i` — and by the time the CLI
 * is told to stop, the test runner it started belongs to pid 1 and
 * carries nothing of the agent's.
 *
 * **Contained, where the machine allows it.** On Linux the root starts
 * inside a cgroup of its own below EO's — put there by the shell it is
 * exec'd from, before it runs (`containedLaunch` in `cgroupContainment.ts`). Every process it ever starts is born in that
 * cgroup and stays there whatever it does to its session, its parent or
 * its environment, so the cgroup *is* the tree, and the kernel ends all
 * of it at once (`cgroup.kill`). This is what a systemd desktop session —
 * EO's own `app-….scope` — and the CI job both provide.
 *
 * **Found, where it does not.** macOS has no such thing, nor a Linux
 * whose cgroup EO's user cannot write to; Windows' equivalent, a job
 * object, is out of Node's reach without a native module. There the tree
 * is found, and found two ways:
 *
 * - **By parentage.** The root's descendants as the process table says
 *   now, and, polled while the root lives, every descendant it has had —
 *   remembered with its start time, so one whose parent has gone is
 *   still found and a pid reused since is never mistaken for it.
 * - **By a mark.** The root is started with `EO_PROCESS_TREE=<id>` in its
 *   environment, which everything it starts inherits unless something
 *   replaces the environment on purpose. `setsid`, `nohup`, a double
 *   fork, a shell that exited: none of them touch it.
 *
 * What finding cannot promise is a process that both replaces its
 * environment and loses its parent between two polls; containment is
 * what does not have that hole, and `contained` says which of the two a
 * tree has.
 *
 * **The guarantee, and its named exception (approved on EO-494).**
 * Every descendant of an agent's turn is ended:
 *
 * - **Guaranteed** on Linux with cgroup v2 where EO's own cgroup is its
 *   user's to write to — every systemd desktop session, and the hosted
 *   CI job, which is handed one and fails rather than skips without it
 *   (`EO_EXPECT_CGROUP_CONTAINMENT`).
 * - **Best effort** everywhere else — macOS; Windows; a Linux on cgroup
 *   v1, without a systemd session, or whose cgroup is root's or
 *   read-only, as in the self-hosted CI container: parentage, and the
 *   inherited mark on macOS and Linux; on Windows parentage alone, a
 *   parent read by creation time (`windowsMembers`). There, and only
 *   there, a descendant that both replaces its environment and is
 *   orphaned before EO looks can outlive its turn — and on Windows, whose
 *   environment EO does not read, one orphaned before EO looks whatever
 *   its environment: every process between it and the root gone before
 *   any look (widened on EO-502). A native component (a Linux subreaper,
 *   Windows job objects) could close that on two of the three and was
 *   declined; an unprivileged macOS app has nothing that could. EO says which of the
 *   two a machine gets, once, in the log (`cgroupContainment.ts`), and
 *   the tests hold each to exactly that (`owed` in
 *   `testing/escapingDescendants.ts`).
 *
 * Ending it is the pinned order (EO-493), applied to the whole tree:
 * SIGTERM to everything at once, as a signal to a process group would
 * be; the grace; SIGKILL to whatever is left, looked for again first so a
 * child started in the meantime is not missed. The root is ended through
 * `endProcess`, so a caller still learns whether *it* went. On Windows,
 * where there is no SIGTERM to be gentle with, `taskkill /T` takes the
 * tree while the root still parents it, and is waited for before
 * anything else is done to the root.
 *
 * `superviseStdioServer.mjs` restates this for a server's tree: it ships
 * as a standalone file a backend CLI runs by path, and imports nothing.
 * Change one and look at the other.
 */

/** The environment variable a tree's processes carry. */
export const TREE_MARKER_VARIABLE = "EO_PROCESS_TREE";

/** How often a live root's descendants are looked for, so one whose parent goes later is still known. */
export const TREE_POLL_MS = 2_000;

/** How long a tree killed outright at quit is waited on before EO goes anyway. */
const KILL_WAIT_MS = 1_000;

/** Between looks while a tree is being ended. */
const SWEEP_MS = 50;

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** When the process started, as the platform says it — what tells a reused pid apart. */
  start: string;
  zombie: boolean;
}

export interface ProcessTable {
  rows: Map<number, ProcessRow>;
  /** The pids whose environment carries the mark asked for. */
  marked: Set<number>;
}

/** The process table, and who carries `marker`; null where it cannot be read. */
export async function readProcessTable(marker?: string): Promise<ProcessTable | null> {
  try {
    if (process.platform === "linux") return await linuxTable(marker);
    if (process.platform === "darwin") return darwinTable(await run(DARWIN_PS, ["-A", "-o", "pid=,ppid=,stat=,lstart="]), marker === undefined ? undefined : await run(DARWIN_PS, ["-A", "-wwE", "-o", "pid=,command="]), marker);
    if (process.platform === "win32") return windowsTable(await run(windowsSystemExecutable(WINDOWS_POWERSHELL), WINDOWS_TABLE_ARGS, WINDOWS_LOOK_TIMEOUT_MS));
  } catch (error) {
    console.warn("[eo] could not read the process table:", error);
  }
  return null;
}

/** The same, synchronously, for the one place that cannot wait: the main process's `exit`. */
export function readProcessTableSync(marker?: string): ProcessTable | null {
  try {
    if (process.platform === "linux") {
      const table: ProcessTable = { rows: new Map(), marked: new Set() };
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        linuxRow(table, name, readOrNull(() => readFileSync(`/proc/${name}/stat`, "utf8")), marker === undefined ? null : readOrNull(() => readFileSync(`/proc/${name}/environ`, "latin1")), marker);
      }
      return table;
    }
    if (process.platform === "darwin") {
      const listing = (args: string[]) => execFileSync(DARWIN_PS, args, { encoding: "utf8", maxBuffer: TABLE_BUFFER, windowsHide: true });
      return darwinTable(listing(["-A", "-o", "pid=,ppid=,stat=,lstart="]), marker === undefined ? undefined : listing(["-A", "-wwE", "-o", "pid=,command="]), marker);
    }
    if (process.platform === "win32") return windowsTable(execFileSync(windowsSystemExecutable(WINDOWS_POWERSHELL), WINDOWS_TABLE_ARGS, { encoding: "utf8", maxBuffer: TABLE_BUFFER, timeout: WINDOWS_LOOK_TIMEOUT_MS, windowsHide: true }));
  } catch {
    // Nothing to be done about it this late.
  }
  return null;
}

async function linuxTable(marker: string | undefined): Promise<ProcessTable> {
  const table: ProcessTable = { rows: new Map(), marked: new Set() };
  const names = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  await Promise.all(
    names.map(async (name) => {
      const [stat, environ] = await Promise.all([
        readFile(`/proc/${name}/stat`, "utf8").catch(() => null),
        // Another user's environment is not readable, and not ours to end.
        marker === undefined ? null : readFile(`/proc/${name}/environ`, "latin1").catch(() => null),
      ]);
      linuxRow(table, name, stat, environ, marker);
    }),
  );
  return table;
}

function linuxRow(table: ProcessTable, name: string, stat: string | null, environ: string | null, marker: string | undefined): void {
  if (stat === null) return; // Gone between the listing and the read.
  // `pid (comm) state ppid …`, where comm may hold spaces and parentheses
  // of its own: the fields are counted from the last `)`.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const pid = Number(name);
  // starttime is field 22 of the line, the 20th after comm.
  table.rows.set(pid, { pid, ppid: Number(fields[1]), start: fields[19] ?? "", zombie: fields[0] === "Z" || fields[0] === "X" });
  if (marker !== undefined && environ !== null && `\0${environ}\0`.includes(`\0${TREE_MARKER_VARIABLE}=${marker}\0`)) table.marked.add(pid);
}

/**
 * macOS's `ps`, by its path, never looked up on PATH (EO-640): as with
 * Windows' System32 programs below, a caller that narrowed PATH — a test
 * stubbing it to `/probe/bin:/usr/bin` did, on the first macOS run —
 * would otherwise leave every tree unfound, its descendants unended.
 * `ps` lives in `/bin` there, and nowhere else.
 */
const DARWIN_PS = "/bin/ps";

/** Large: `ps -E` prints every environment on the machine that is ours. */
const TABLE_BUFFER = 256 * 1024 * 1024;

/**
 * How long one look at Windows' table, or one taskkill, is given before
 * it is given up on (EO-502). CIM can stall for minutes — a fresh
 * machine's first query did, on every release runner — and a turn's end
 * must not wait on it: a look that does not answer is a table that could
 * not be read, and `taskkill /T` still takes the tree while its root
 * parents it.
 */
export const WINDOWS_LOOK_TIMEOUT_MS = 10_000;

function run(command: string, args: readonly string[], timeout = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: "utf8", maxBuffer: TABLE_BUFFER, timeout, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    if (process.platform === "win32") raiseLookPriority(child.pid);
  });
}

/**
 * A look at Windows' table, run ahead of everything else on the machine
 * (EO-645). Most of a look is PowerShell starting; the query itself takes
 * a tenth of a second. On a machine whose every CPU is busy — a hosted CI
 * runner mid-suite, a person's machine with agents at work — PowerShell
 * started at normal priority took up to ten seconds to start, the look
 * ran out its limit, and the tree it was for went unfound. Windows hands
 * the CPU to the higher priority class first, so the look takes what it
 * needs and is gone; it is bounded by its own limit either way.
 * `superviseStdioServer.mjs` does the same for its holder's looks.
 */
export function raiseLookPriority(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    setPriority(pid, osConstants.priority.PRIORITY_HIGH);
  } catch {
    // Already gone, or not ours to change: the look runs at normal priority.
  }
}

function darwinTable(listing: string, environments: string | undefined, marker: string | undefined): ProcessTable {
  const table: ProcessTable = { rows: new Map(), marked: new Set() };
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    table.rows.set(pid, { pid, ppid: Number(match[2]), start: match[4]!, zombie: match[3]!.startsWith("Z") });
  }
  if (environments !== undefined && marker !== undefined) {
    const needle = `${TREE_MARKER_VARIABLE}=${marker}`;
    for (const line of environments.split("\n")) {
      const match = /^\s*(\d+)\s/.exec(line);
      // The environment follows the command, space-separated; the mark is
      // a whole word of it.
      if (match && ` ${line} `.includes(` ${needle} `)) table.marked.add(Number(match[1]));
    }
  }
  return table;
}

/**
 * Every process with its parent and creation time, from CIM: the one
 * table Windows offers a process that is not an administrator. Slow — a
 * PowerShell start, seconds on a busy machine — so read only when a tree
 * is being ended, never polled, and as few times as the ending allows.
 * Only the three properties used are asked for: the full class has a
 * process's command line in it, which CIM reads out of every process on
 * the machine. A Windows parent pid is not re-pointed when the parent
 * goes, which is what the creation time is kept for.
 *
 * PowerShell and taskkill are named by their System32 paths, never looked
 * up on PATH (`windowsSystemExecutable`): a caller that narrowed PATH
 * would otherwise leave every tree unfound, its descendants unended.
 */
const WINDOWS_POWERSHELL = "WindowsPowerShell\\v1.0\\powershell.exe";
const WINDOWS_TABLE_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, CreationDate FROM Win32_Process' | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }",
];

export function windowsTable(listing: string): ProcessTable {
  const table: ProcessTable = { rows: new Map(), marked: new Set() };
  for (const line of listing.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) table.rows.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), start: match[3]!, zombie: false });
  }
  return table;
}

/** `taskkill /T /F` for a tree, settled once taskkill itself has finished: whether it said it did. */
function taskkillTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(windowsSystemExecutable("taskkill.exe"), ["/pid", String(pid), "/T", "/F"], { timeout: WINDOWS_LOOK_TIMEOUT_MS, windowsHide: true }, (error) => resolve(error === null));
  });
}

function taskkillTreeSync(pid: number): void {
  try {
    execFileSync(windowsSystemExecutable("taskkill.exe"), ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", timeout: WINDOWS_LOOK_TIMEOUT_MS, windowsHide: true });
  } catch {
    // Gone already, or nothing more can be done this late.
  }
}

/**
 * How a tree is ended on Windows when nobody said otherwise: `taskkill /T
 * /F`. An object, so a test standing in for a process no signal moves can
 * take this away as well as its handle's `kill` — on Windows, taskkill
 * reaches a process whatever its handle does.
 */
export const windowsTreeKill = { run: taskkillTree, runSync: taskkillTreeSync };

function readOrNull(read: () => string): string | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** Every tree not yet ended, for the quit path. */
const live = new Set<ProcessTree>();
let exitHooked = false;

export interface ProcessTreeOptions {
  /** How often a live root's descendants are looked for, where the tree is not contained. */
  pollMs?: number;
  /** Seams, for a test of one platform's ending on another. */
  platform?: NodeJS.Platform;
  readTable?: (marker?: string) => Promise<ProcessTable | null>;
  readTableSync?: (marker?: string) => ProcessTable | null;
  taskkill?: (pid: number) => Promise<boolean>;
  /** `taskkill /T /F`, run to completion, for the exit backstop. */
  taskkillSync?: (pid: number) => void;
  /** How a pid other than the root's is signalled. */
  signal?: (pid: number, name: NodeJS.Signals) => void;
  /** How the root is contained; `false` for not at all — a test of finding where containment is the default. */
  contain?: ((pid: number, name: string) => Containment | null) | false;
  /**
   * The cgroup the root was started in (`containedLaunch`), when the
   * caller contained it before it ran; null when that could not be done.
   * Given, it is the tree's containment and nothing is moved afterwards.
   */
  containment?: Containment | null;
  /**
   * Windows: a time no later than the root's creation, as a FILETIME. A
   * Windows parent pid is not re-pointed when the parent goes, so a
   * process naming the root's pid as its parent is the root's only if it
   * was created after the root was — this is the bound when the root
   * itself is gone from the table. Defaults to a second before the tree
   * was made, which is the moment after the root was spawned.
   */
  bornAfter?: bigint;
}

/** A Windows FILETIME — 100ns ticks since 1601 — for a JavaScript time. */
export function fileTime(ms: number): bigint {
  return (BigInt(Math.floor(ms)) + 11_644_473_600_000n) * 10_000n;
}

function ticks(start: string): bigint {
  try {
    return BigInt(start);
  } catch {
    return 0n;
  }
}

export class ProcessTree {
  /** Every descendant seen so far: pid → start, so a reused pid is not mistaken for it. */
  private readonly known = new Map<number, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling: Promise<void> | null = null;
  private readonly platform: NodeJS.Platform;
  private readonly readTable: (marker?: string) => Promise<ProcessTable | null>;
  private readonly taskkill: (pid: number) => Promise<boolean>;
  private readonly readTableSync: (marker?: string) => ProcessTable | null;
  private readonly taskkillSync: (pid: number) => void;
  private readonly send: (pid: number, name: NodeJS.Signals) => void;
  /** The root's cgroup, where it has one: every process of the tree, whatever it did to be found. */
  private readonly containment: Containment | null;
  private readonly bornAfter: bigint;

  /**
   * `root` is the process handle, not its pid: it is ended through its
   * own `kill`, so a caller's seam on it (a test's process no signal
   * moves) still holds, and Node's own word on whether it has exited is
   * what says whether its pid still names it.
   *
   * Made the moment the root is spawned, before anything else: that is
   * when a root not started inside its cgroup is moved into one.
   */
  constructor(
    private readonly root: EndableProcess,
    /** What the root was started with in `TREE_MARKER_VARIABLE`. */
    readonly marker: string,
    options: ProcessTreeOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.readTable = options.readTable ?? readProcessTable;
    this.taskkill = options.taskkill ?? ((pid) => windowsTreeKill.run(pid));
    this.readTableSync = options.readTableSync ?? readProcessTableSync;
    this.taskkillSync = options.taskkillSync ?? ((pid) => windowsTreeKill.runSync(pid));
    this.send = options.signal ?? signal;
    this.bornAfter = options.bornAfter ?? fileTime(Date.now() - 1_000);
    const contain = options.contain === false ? null : (options.contain ?? containInCgroup);
    this.containment =
      options.containment !== undefined ? options.containment : contain && root.pid !== undefined && !hasExited(root) && this.platform === "linux" ? contain(root.pid, `eo-tree-${marker}`) : null;
    live.add(this);
    hookExit();
    if (root.pid === undefined) return;
    // Polled only where it is the tree's memory: a contained tree has the
    // kernel's, and Windows' table is a PowerShell start.
    if (this.containment === null && this.platform !== "win32") {
      this.timer = setInterval(() => void this.refresh(), options.pollMs ?? TREE_POLL_MS);
      // An agent being watched is no reason for EO itself to stay up.
      this.timer.unref?.();
    }
    // What a root that went on its own left behind is looked at once:
    // nothing, and the tree is done with; something, and it waits for
    // `end`, which every caller reaches.
    root.once("exit", () => {
      void this.sweep().then((left) => {
        if (left.length === 0) this.finished();
      });
    });
  }

  /** A fresh mark, for a process about to be started as a tree's root. */
  static newMarker(): string {
    return uuidv7();
  }

  /** Whether the tree is contained (a cgroup of its own), rather than found. */
  get contained(): boolean {
    return this.containment !== null;
  }

  /**
   * Looks for the root's descendants now, and remembers them — what a
   * caller does before it lets the root go on its own, so its children
   * are still known once it has. Nothing to do for a contained tree.
   */
  async refresh(): Promise<void> {
    if (this.containment !== null) return;
    // Windows never re-points a parent pid, so what a root that has gone
    // left behind is still found by its pid at the next look
    // (`windowsMembers`): a look now would only cost a PowerShell start.
    if (this.platform === "win32" && hasExited(this.root)) return;
    if (this.polling) return this.polling;
    this.polling = (async () => {
      const table = await this.readTable();
      if (table) this.remember(this.members(table));
    })().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  /**
   * Ends the root and everything it started: SIGTERM to all of it, the
   * grace, SIGKILL to what is left. Settles once all of it has gone.
   *
   * Answers the pids still there after SIGKILL and its grace — the root
   * first if it is one — and an empty list when the tree is gone. Never
   * throws: what a survivor means is the caller's to say.
   */
  async end(graceMs: number = END_PROCESS_GRACE_MS): Promise<number[]> {
    if (this.platform === "win32") return this.endOnWindows(graceMs);
    const rootPid = this.root.pid;
    const began = Date.now();
    const signalled = new Set<number>();
    const term = (rows: ProcessRow[]) => {
      for (const row of rows) {
        if (signalled.has(row.pid)) continue;
        signalled.add(row.pid);
        this.send(row.pid, "SIGTERM");
      }
    };
    // Found before the root is signalled: once it has gone, its children
    // belong to somebody else.
    term(await this.sweep());
    const [rootGone] = await Promise.all([endProcess(this.root, graceMs), this.until(began + graceMs, term)]);

    let left = await this.sweep();
    const deadline = Date.now() + graceMs;
    while (left.length > 0) {
      // The kernel's kill reaches the root too, so only once the root has
      // gone the ordinary way: a root no signal moves is reported as one,
      // and `cgroup.kill` is a signal like any other.
      if (rootGone) this.containment?.kill();
      for (const row of left) this.send(row.pid, "SIGKILL");
      left = await this.until(Math.min(Date.now() + 250, deadline));
      if (Date.now() >= deadline) break;
    }

    if (rootGone && left.length === 0) this.finished();
    return [...(rootGone || rootPid === undefined ? [] : [rootPid]), ...left.map((row) => row.pid)];
  }

  /**
   * Windows, in the order that works there: the tree is found; `taskkill
   * /T` takes it while the root still parents it, and is waited for to
   * finish; only then is the root ended and confirmed gone; and what is
   * left of the tree is ended one by one and looked for again. Nothing is
   * let go of until the table says the tree has gone.
   *
   * Only what a look *after* taskkill still finds is signalled: a
   * descendant taskkill ended may have had its pid given to somebody
   * else by then, and the table, read with creation times, is what tells
   * the two apart (`windowsMembers`). Where the root had gone before
   * this began, there is nothing for taskkill to walk, and the first look
   * is already that look.
   *
   * What a look finds is signalled before the grace is consulted: a look
   * is a PowerShell start, which on a busy machine can take longer than
   * the whole grace, and a descendant found and never signalled would be
   * reported as one that would not go.
   */
  private async endOnWindows(graceMs: number): Promise<number[]> {
    const rootPid = this.root.pid;
    // Looked at for its memory, too: `sweep` remembers who each
    // descendant is, creation time and all, while the root still parents them.
    let left = await this.sweep();
    const walked = rootPid !== undefined && !hasExited(this.root);
    if (walked) {
      const said = await this.taskkill(rootPid);
      if (!said) console.warn(`[eo] taskkill could not end the tree of ${rootPid}; ending what is left of it one by one`);
    }
    const rootGone = await endProcess(this.root, graceMs);
    if (walked) left = await this.sweep();
    const deadline = Date.now() + graceMs;
    while (left.length > 0) {
      for (const row of left) this.send(row.pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, SWEEP_MS));
      left = await this.sweep();
      if (Date.now() >= deadline) break;
    }
    if (rootGone && left.length === 0) this.finished();
    return [...(rootGone || rootPid === undefined ? [] : [rootPid]), ...left.map((row) => row.pid)];
  }

  /**
   * Everything, SIGKILL, now — for a main process on its way out, which
   * has already given every turn its own chance to end (`endAllProcessTrees`).
   *
   * Whatever the first look finds is signalled however long the look
   * took, and the wait for it to go is counted from then. A tree with
   * anything still there afterwards stays EO's — the `exit` backstop's
   * to kill — rather than being let go of as if it had ended.
   */
  async kill(): Promise<void> {
    // Looked for before the root goes, as in `end`.
    const found = await this.sweep();
    if (this.platform === "win32") {
      if (this.root.pid !== undefined && !hasExited(this.root)) await this.taskkill(this.root.pid);
    } else {
      this.containment?.kill();
    }
    if (!hasExited(this.root)) signalHandle(this.root, "SIGKILL");
    // Signalled only as who they still are. On Windows, after an awaited
    // taskkill, that is a fresh look; elsewhere the first look is checked
    // pid by pid against the start time it saw, so a slow look whose pids
    // have since been reused signals none of the strangers.
    const targets = this.platform === "win32" ? await this.sweep() : found.filter((row) => this.stillTheSame(row));
    for (const row of targets) this.send(row.pid, "SIGKILL");
    const deadline = Date.now() + KILL_WAIT_MS;
    let left = await this.sweep();
    while (left.length > 0 && Date.now() < deadline) {
      this.containment?.kill();
      for (const row of left) this.send(row.pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, SWEEP_MS));
      left = await this.sweep();
    }
    const rootGone = await exitWithin(this.root, Math.max(100, deadline - Date.now()));
    if (rootGone && left.length === 0) this.finished();
  }

  /** `kill`, synchronously and without waiting, for the main process's `exit`. */
  killSync(): void {
    if (this.platform === "win32") {
      // Synchronous, so it has finished before the root is touched.
      if (this.root.pid !== undefined && !hasExited(this.root)) this.taskkillSync(this.root.pid);
    } else {
      this.containment?.kill();
      for (const pid of this.containment?.pids() ?? []) this.send(pid, "SIGKILL");
    }
    // What is left, as a fresh look says it is: a remembered descendant
    // is signalled only while its pid still names it — on Windows the
    // creation time says so (`windowsMembers`), never the pid alone.
    const table = this.readTableSync(this.marker);
    if (table) for (const row of this.members(table)) this.send(row.pid, "SIGKILL");
    if (!hasExited(this.root)) signalHandle(this.root, "SIGKILL");
    // The kernel's kill is under way, not done: a moment for the cgroup
    // to empty, so it can be taken away — bounded, because this is a
    // process on its way out. One still occupied is left for EO's own
    // cgroup to take with it.
    const deadline = Date.now() + 200;
    while (this.containment !== null && this.containment.pids().length > 0 && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    this.finished();
  }

  /** Stops watching. The tree is no longer EO's to end. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    live.delete(this);
  }

  /** Done with: the cgroup taken away, once empty, and the watching stopped. */
  private finished(): void {
    this.containment?.remove();
    this.dispose();
  }

  /** What of the tree is alive now — its cgroup, its parentage, its mark — remembered as it goes. */
  private async sweep(): Promise<ProcessRow[]> {
    const table = await this.readTable(this.marker);
    const members = table ? this.members(table) : [];
    this.remember(members);
    if (this.containment === null) return members;
    const found = new Set(members.map((row) => row.pid));
    for (const pid of this.containment.pids()) {
      if (found.has(pid) || pid === this.root.pid || pid === process.pid) continue;
      found.add(pid);
      members.push(table?.rows.get(pid) ?? { pid, ppid: 0, start: "", zombie: false });
    }
    return members;
  }

  /** Sweeps until nothing is left or `deadline`, handing each sweep to `each`. What is left at the end. */
  private async until(deadline: number, each?: (rows: ProcessRow[]) => void): Promise<ProcessRow[]> {
    for (;;) {
      const left = await this.sweep();
      each?.(left);
      if (left.length === 0 || Date.now() >= deadline) return left;
      await new Promise((resolve) => setTimeout(resolve, Math.min(SWEEP_MS, Math.max(0, deadline - Date.now()))));
    }
  }

  /** The root's descendants in `table`, every remembered one still the same process, and every marked one — and theirs. Never the root itself, nor EO. */
  private members(table: ProcessTable): ProcessRow[] {
    if (this.platform === "win32") return this.windowsMembers(table);
    const seeds: number[] = [];
    const rootPid = this.root.pid;
    // Node has not reaped it, so its pid still names it.
    if (rootPid !== undefined && !hasExited(this.root)) seeds.push(rootPid);
    for (const [pid, start] of this.known) if (table.rows.get(pid)?.start === start) seeds.push(pid);
    seeds.push(...table.marked);

    const children = new Map<number, number[]>();
    for (const row of table.rows.values()) {
      const siblings = children.get(row.ppid);
      if (siblings) siblings.push(row.pid);
      else children.set(row.ppid, [row.pid]);
    }
    const found = new Map<number, ProcessRow>();
    const queue = [...seeds];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const pid = queue.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const row = table.rows.get(pid);
      if (row && !row.zombie && pid !== rootPid && pid !== process.pid && pid > 1) found.set(pid, row);
      queue.push(...(children.get(pid) ?? []));
    }
    return [...found.values()];
  }

  /**
   * The same on Windows, where a parent pid is never re-pointed: a process
   * is a parent's child if it names the parent's pid and was created no
   * earlier than the parent was — and, where the pid has since been taken
   * by somebody else, before that somebody was. So the root's children are
   * still its children once it has gone, and so are those of every
   * descendant once seen, gone or not; a stranger who inherited a pid is
   * never mistaken for the process that had it.
   */
  private windowsMembers(table: ProcessTable): ProcessRow[] {
    const rootPid = this.root.pid;
    const children = new Map<number, ProcessRow[]>();
    for (const row of table.rows.values()) {
      const siblings = children.get(row.ppid);
      if (siblings) siblings.push(row);
      else children.set(row.ppid, [row]);
    }
    const queue: [number, bigint][] = [];
    if (rootPid !== undefined) {
      const row = table.rows.get(rootPid);
      queue.push([rootPid, !hasExited(this.root) && row ? ticks(row.start) : this.bornAfter]);
    }
    const found = new Map<number, ProcessRow>();
    for (const [pid, start] of this.known) {
      const row = table.rows.get(pid);
      if (row && row.start === start && pid !== process.pid) found.set(pid, row);
      queue.push([pid, ticks(start)]);
    }
    const seen = new Set<string>();
    while (queue.length > 0) {
      const [pid, start] = queue.pop()!;
      const key = `${pid}@${start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const holder = table.rows.get(pid);
      const taken = holder !== undefined && ticks(holder.start) !== start;
      for (const row of children.get(pid) ?? []) {
        const born = ticks(row.start);
        if (born < start || (taken && born >= ticks(holder.start))) continue;
        if (row.pid === rootPid || row.pid === process.pid || row.pid <= 4) continue;
        found.set(row.pid, row);
        queue.push([row.pid, born]);
      }
    }
    return [...found.values()];
  }

  /**
   * Whether `row`'s pid still names the process that row saw: on Linux,
   * its start time read again. Elsewhere, and for a row with no start,
   * the look it came from is all there is.
   */
  private stillTheSame(row: ProcessRow): boolean {
    if (this.platform !== "linux" || row.start === "") return true;
    const stat = readOrNull(() => readFileSync(`/proc/${row.pid}/stat`, "utf8"));
    if (stat === null) return false;
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === row.start;
  }

  private remember(rows: ProcessRow[]): void {
    for (const row of rows) if (row.start !== "") this.known.set(row.pid, row.start);
  }
}

/**
 * Every tree EO has not finished ending, ended outright — the quit
 * path's last word, once every run has had its own chance (EO-494).
 */
export async function endAllProcessTrees(): Promise<void> {
  await Promise.allSettled([...live].map((tree) => tree.kill()));
}

/** How many trees are still EO's to end. */
export function liveProcessTrees(): number {
  return live.size;
}

/**
 * The backstop beneath `endAllProcessTrees`: whatever is still being
 * watched when the main process exits — a quit that did not wait, a
 * `process.exit` — is killed on the way out. Synchronous, because `exit`
 * runs nothing else.
 */
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.once("exit", () => {
    for (const tree of [...live]) tree.killSync();
  });
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Gone, or not ours to signal.
  }
}

/** Whether `child` has exited, waiting up to `ms` for it. */
function exitWithin(child: EndableProcess, ms: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(hasExited(child)), ms);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function signalHandle(child: EndableProcess, name: NodeJS.Signals): void {
  try {
    child.kill(name);
  } catch {
    // Gone between the check and the signal.
  }
}
