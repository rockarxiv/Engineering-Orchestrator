// EO-151: bounds a stdio MCP server's life by the process that started it.
//
// **Why this exists at all.** EO does not spawn the repository
// intelligence server. It composes a command line, hands it to a backend
// CLI, and the CLI starts it — so nothing EO owns holds a handle to that
// process, and "no orphan survives" was resting on two things EO does
// not control: that the SDK ends the CLI, and that the CLI then ends the
// servers it started. The first is measurable. The second is a promise
// made by a binary EO downloads, and the MCP stdio contract's answer to
// it — a server exits when its input closes — is a *should*, not a
// guarantee EO may plan around. Invariant #5 is exactly about this: what
// EO can check for itself, it must.
//
// So EO puts a process of its own in between, whose only job is to
// outlive nothing.
//
// **It is deliberately not in the data path.** The child inherits this
// process's stdin, stdout and stderr, so JSON-RPC flows straight between
// the CLI and the real server exactly as it would without this — no
// pumping, no buffering, nothing here to corrupt a protocol stream. The
// alternative, piping both directions through this file, would put a
// hand-written relay in the middle of every tool call an agent makes,
// and a bug there would be a subtly broken index rather than a loud
// failure.
//
// EO-164 is the story that tested that trade rather than assuming it.
// It asked whether the index's answers are too noisy to come back to —
// they carry symbols from unrelated screens and from test files — and
// whether filtering them here would earn the relay. The measurement is
// `scripts/index-answer-quality.mjs`, which replays every `mcp__repo__`
// call ever recorded against the very index that answered it and scores
// the answer against where that run then went. Removing the noise moves
// 0–10% of the payload and changes which files the answer names in one
// call out of eight — there, for the worse, because it dropped a test
// file the agent went on to open. The answers are not noisy so much as
// imprecise, and no filter here can add what an answer did not contain.
// So this stays out of the data path, and a future story that wants to
// put something in it should re-run that script rather than start from
// the intuition EO-164 already tested.
//
// What it watches instead is whether the process that started it is
// still there. That question is answerable on every platform EO ships
// on, costs nothing, and is true whether the CLI exited cleanly, was
// asked to stop, or was killed outright — which is the case the whole
// arrangement is for, because a killed CLI gets no chance to clean up
// after itself.
// The globals this file uses, declared the way `eoServer.mjs` declares
// its own: nothing here is bundled, so there is no tsconfig lib to say
// what a Node runtime provides.
/* global process, setTimeout, clearTimeout, setInterval, clearInterval */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve, win32 } from "node:path";

/** Windows' own PowerShell, below System32 (`windowsSystemExecutable`). */
const WINDOWS_POWERSHELL = "WindowsPowerShell\\v1.0\\powershell.exe";

/** How long one look at Windows' table, or one taskkill, is given — as `WINDOWS_LOOK_TIMEOUT_MS` in `process/processTree.ts`. */
const WINDOWS_LOOK_TIMEOUT_MS = 10000;

/** How long `end` waits on Windows for the holder to end the tree — its own budget, and a margin. */
const HOLDER_WAIT_MS = 35000;

/** How often to ask whether the process that started this one is still there. */
const POLL_MS = 500;

/** How long a child gets to end on its own terms before it is ended for it. */
const GRACE_MS = 2000;

/**
 * How long to wait for a killed child to actually be collected.
 *
 * Generous, because the cost of being wrong is opposite in the two
 * directions: too short and this leaves a zombie behind, which is the
 * whole thing it exists to prevent; too long and a process that was
 * going to exit anyway takes a moment more to do it.
 */
const REAP_BUDGET_MS = 5000;

/**
 * How often the server's descendants are looked for while it runs, where
 * its tree is not contained (EO-494), so one whose parent has gone by the
 * time this ends is still known.
 */
const TREE_POLL_MS = 2000;

/** Between looks while the server's tree is being ended. */
const SWEEP_MS = 50;

/** The variable the server's tree carries, where it cannot be contained. */
const MARK_VARIABLE = "EO_SUPERVISED_SERVER";

/**
 * **What the server's tree is (EO-494).** A server launched through `npx`
 * is `npx`, a shell, and then the server, and anything it starts may
 * leave its parent, its session and its environment behind. So the tree
 * is owned the way `process/processTree.ts` owns an agent's — restated
 * here because this file ships on its own and imports nothing of EO's;
 * change one and look at the other:
 *
 * - **Contained**, on Linux with cgroup v2 where this process's cgroup is
 *   its user's (inside an agent's turn it is the turn's own): the server
 *   is moved, the moment it is spawned, into a cgroup of its own below
 *   this one. Everything it ever starts is born there and stays there,
 *   whatever it does, and the kernel kills all of it at once.
 * - **Found**, everywhere else: the server's descendants by parentage,
 *   remembered with their start times as they are seen, and every process
 *   carrying the mark this process starts the server with.
 *
 * Windows has no cgroup and no readable environment, and this process may
 * not get to look at anything: a backend that is Node starts it in a job
 * object that ends it outright the moment the backend is killed. So on
 * Windows the server is started, held and ended by a process outside
 * every job (`windowsHolder`), from a table read through CIM, with
 * `taskkill /T` waited for before anything else is done.
 *
 * The same guarantee and the same named exception as an agent's tree
 * (`processTree.ts`): guaranteed where the server is contained; where it
 * is only found, a descendant that both replaces its environment and is
 * orphaned before this looks can outlive the server. On Windows, whose
 * environment is not read, the exception is wider (EO-502): a descendant
 * orphaned before the holder looks, whatever its environment — every
 * process between it and the server gone first, as when a Node server
 * exits on its own and the job it kept its undetached children in takes
 * them with it, leaving what they detached naming a parent nobody saw.
 * The holder looks before it passes EOF on, so a server that exits on
 * EOF is not that case; one that exits of its own accord can be.
 */
const mark = `${process.pid}-${randomUUID()}`;

/** The server's cgroup directory, once it has one. */
let cgroup = null;

/** cgroup v2 directory of this process, or null. */
function ownCgroup() {
  if (process.platform !== "linux") return null;
  try {
    if (!existsSync("/sys/fs/cgroup/cgroup.controllers")) return null;
    const line = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((entry) => entry.startsWith("0::"));
    return line === undefined ? null : join("/sys/fs/cgroup", line.slice(3).trim());
  } catch {
    return null;
  }
}

/**
 * The shell that puts itself in the cgroup named by `$0` and becomes the
 * server, so the server is inside before it runs an instruction of its
 * own and nothing it starts is ever outside. A failed write does not
 * withhold the server; `adopt` tries again from outside.
 */
const TRAMPOLINE = 'echo $$ > "$0/cgroup.procs" 2>/dev/null; exec "$@"';

/** Whether `command` names a file that can be run, as `spawn` would look it up. */
function runnable(command) {
  const candidates = command.includes("/") ? [isAbsolute(command) ? command : resolve(command)] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * How to spawn the server so it starts inside a cgroup of its own below
 * this process's: `/bin/sh -c TRAMPOLINE <cgroup> command args…`. A
 * command that is not there is spawned as it is, so its failure is the
 * `ENOENT` reported below rather than a shell's exit 127. `path` is the
 * cgroup, or null where there is none to be had.
 */
function containedLaunch(command, args) {
  const unchanged = { command, args, path: null };
  // `EO_SUPERVISOR_CONTAIN=0` is for this file's tests of the other way,
  // on a machine where containment works.
  if (process.env.EO_SUPERVISOR_CONTAIN === "0") return unchanged;
  const parent = ownCgroup();
  if (parent === null) return unchanged;
  const path = join(parent, `eo-server-${mark}`);
  try {
    mkdirSync(path);
  } catch {
    return unchanged;
  }
  if (!runnable(command) || !runnable("/bin/sh")) return { command, args, path };
  return { command: "/bin/sh", args: ["-c", TRAMPOLINE, path, command, ...args], path };
}

/** Moves the spawned server in from outside as well — the whole of it where the shell was not used — and answers the cgroup, or null. */
function adopt(path, pid) {
  if (path === null) return null;
  if (pid === undefined) {
    removeCgroup(path);
    return null;
  }
  try {
    writeFileSync(join(path, "cgroup.procs"), String(pid));
  } catch (error) {
    // Gone already is the server's business; anything else, and the shell
    // — the same user — was refused too.
    if (error.code !== "ESRCH") {
      removeCgroup(path);
      return null;
    }
  }
  return path;
}

/** `path` and every cgroup below it, parents first. */
function cgroups(path) {
  const found = [path];
  for (let index = 0; index < found.length; index++) {
    try {
      for (const entry of readdirSync(found[index], { withFileTypes: true })) if (entry.isDirectory()) found.push(join(found[index], entry.name));
    } catch {
      // Gone while being read.
    }
  }
  return found;
}

/** Every process in the server's cgroup and below it. */
function containedPids() {
  if (cgroup === null) return [];
  const pids = new Set();
  for (const directory of cgroups(cgroup)) {
    try {
      for (const pid of readFileSync(join(directory, "cgroup.procs"), "utf8").split("\n").filter(Boolean)) pids.add(Number(pid));
    } catch {
      // Gone while being read.
    }
  }
  return [...pids];
}

/** SIGKILL to everything in the server's cgroup, by the kernel, where it can (Linux 5.14). */
function killContained() {
  if (cgroup === null) return;
  try {
    writeFileSync(join(cgroup, "cgroup.kill"), "1");
  } catch {
    // An older kernel: every pid is signalled instead.
  }
}

function removeCgroup(path) {
  for (const directory of cgroups(path).reverse()) {
    try {
      rmdirSync(directory);
    } catch {
      // Not empty, or gone.
    }
  }
}

/**
 * The process table: pid → { ppid, start, zombie, marked }, or null where
 * it cannot be read. `start` is what tells a reused pid apart from the
 * process once seen under it; `marked`, asked for only when it is needed,
 * whether the process carries this server's mark.
 */
function processTable(withMark) {
  try {
    const table = new Map();
    const needle = `${MARK_VARIABLE}=${mark}`;
    if (process.platform === "linux") {
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        let stat;
        try {
          stat = readFileSync(`/proc/${name}/stat`, "utf8");
        } catch {
          continue; // Gone between the listing and the read.
        }
        let marked = false;
        if (withMark) {
          try {
            marked = `\0${readFileSync(`/proc/${name}/environ`, "latin1")}\0`.includes(`\0${needle}\0`);
          } catch {
            // Not ours to read.
          }
        }
        // `pid (comm) state ppid …`; comm may hold spaces and parentheses.
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        table.set(Number(name), { ppid: Number(fields[1]), start: fields[19] ?? "", zombie: fields[0] === "Z" || fields[0] === "X", marked });
      }
      return table;
    }
    if (process.platform === "darwin") {
      const listing = execFileSync(DARWIN_PS, ["-A", "-o", "pid=,ppid=,stat=,lstart="], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true });
      for (const line of listing.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
        if (match) table.set(Number(match[1]), { ppid: Number(match[2]), start: match[4], zombie: match[3].startsWith("Z"), marked: false });
      }
      if (withMark) {
        const environments = execFileSync(DARWIN_PS, ["-A", "-wwE", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true });
        for (const line of environments.split("\n")) {
          const match = /^\s*(\d+)\s/.exec(line);
          const row = match && table.get(Number(match[1]));
          if (row && ` ${line} `.includes(` ${needle} `)) row.marked = true;
        }
      }
      return table;
    }
  } catch {
    // Unreadable: what is known already is all there is to go on.
  }
  return null;
}

/** Every descendant of the server seen so far: pid → start. */
const known = new Map();

/**
 * The server's tree now, the server itself left out: what is in its
 * cgroup; the server's descendants while it is still this process's
 * child; those of every remembered descendant that is still the same
 * process — so one re-parented when its own parent went is still found;
 * and, where there is no cgroup, everything carrying the mark. Never this
 * process.
 */
function descendants(withMark = cgroup === null) {
  const table = processTable(withMark);
  const found = new Set();
  for (const pid of containedPids()) if (pid !== child.pid && pid !== process.pid) found.add(pid);
  if (!table) return [...found];
  const seeds = [];
  if (child.pid !== undefined && !exited()) seeds.push(child.pid);
  for (const [pid, start] of known) if (table.get(pid)?.start === start) seeds.push(pid);
  const children = new Map();
  for (const [pid, row] of table) {
    if (row.marked) seeds.push(pid);
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(pid);
    else children.set(row.ppid, [pid]);
  }
  const seen = new Set();
  while (seeds.length > 0) {
    const pid = seeds.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = table.get(pid);
    if (row && !row.zombie && pid !== child.pid && pid !== process.pid && pid > 1) {
      found.add(pid);
      known.set(pid, row.start);
    }
    seeds.push(...(children.get(pid) ?? []));
  }
  return [...found];
}

/**
 * macOS's `ps`, by its path, for the reason `windowsSystemExecutable`
 * gives below: the backend chose this process's PATH, and a PATH without
 * `/bin` left the server's tree unfound (EO-640). As `DARWIN_PS` in
 * `process/processTree.ts`, restated because this file imports nothing.
 */
const DARWIN_PS = "/bin/ps";

/**
 * One of Windows' own programs, by its System32 path: the backend chose
 * this process's PATH, and finding or ending the server's tree must not
 * depend on what it put there. As `windowsSystemExecutable` in
 * `process/systemTar.ts`, restated because this file imports nothing.
 */
function windowsSystemExecutable(relative) {
  const configured = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "";
  return win32.join(win32.isAbsolute(configured) ? configured : "C:\\Windows", "System32", relative);
}

/** The PowerShell command that lists every process with its parent and creation time, as `pid ppid FILETIME` lines. */
const WINDOWS_TABLE_COMMAND = "Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, CreationDate FROM Win32_Process' | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }";

/**
 * **The holder, Windows only (EO-502).** Run as a process of its own, from
 * its source (`String(windowsHolder)`), so it shares nothing with this one
 * but what it is handed: the server's command, where PowerShell and
 * taskkill are, and the command that lists the process table.
 *
 * Why it exists: a backend that is Node starts this supervisor in a job
 * object that is closed, and every process in it ended, when the backend
 * goes — and Node puts each child it starts in such a job of its own. A
 * server started from here would go the instant this process did, and
 * each of its undetached children with it, job after job; whatever had
 * been detached below them would be left naming a parent that no longer
 * exists, and nothing could say whose it was. The holder is started
 * detached, so it is in no job, and it starts the server: this process's
 * death reaches nothing of the server's tree, which stays whole — every
 * parent still there — until the holder has ended it.
 *
 * It ends the tree when it is told `end`, when the channel to this
 * process drops without that (this process was killed), and when the
 * server exits on its own (what it left). In the order `processTree.ts`
 * uses on Windows: a look while the server still parents what it
 * started; `taskkill /T`; and then looks, and SIGKILL to what they find,
 * until nothing is left or the budget is spent. Then it exits, with the
 * server's code where the server ended on its own.
 *
 * Every process a look finds is remembered with its creation time, and
 * every look starts from all of them, gone or not: a child started after
 * one look and orphaned before the next is still found by the parent it
 * names. A pid now held by somebody created later is that somebody, and
 * is never signalled — nor is anything it started. The server itself is
 * known by the window its creation falls in until a look has seen it.
 */
function windowsHolder(configText) {
  const { execFile, spawn: startServer } = process.getBuiltinModule("node:child_process");
  const { constants: osConstants, setPriority } = process.getBuiltinModule("node:os");
  const { command, args, powershell, taskkill, tableCommand, lookTimeoutMs } = JSON.parse(configText);
  /** How long ending the tree may take, looks included, before the holder goes anyway. */
  const BUDGET_MS = 30000;
  /** Between looks while the tree is being ended. */
  const SWEEP_MS = 100;
  const fileTime = (ms) => (BigInt(Math.floor(ms)) + 11644473600000n) * 10000n;
  const pause = (ms) => new Promise((resolveLater) => setTimeout(resolveLater, ms));
  const run = (file, argv) =>
    new Promise((resolveLater) => {
      // Bounded (`lookTimeoutMs`): CIM can stall for minutes, and a look
      // that does not answer must not hold up the taskkill after it.
      const child = execFile(file, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: lookTimeoutMs, windowsHide: true }, (error, stdout) => resolveLater(error ? null : stdout));
      // Ahead of everything else on the machine, as `raiseLookPriority` in
      // `processTree.ts` says why (EO-645): on a busy machine PowerShell at
      // normal priority can take the whole limit just to start.
      try {
        setPriority(child.pid, osConstants.priority.PRIORITY_HIGH);
      } catch {
        // Gone already, or not ours to change.
      }
    });

  const spawnedAfter = fileTime(Date.now() - 1000);
  const server = startServer(command, args, { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
  const spawnedBefore = fileTime(Date.now() + 1000);
  server.stdin.on("error", () => {});
  // EOF is passed on only once a look has seen the tree: a server that
  // exits on it takes its undetached children with it, and what those
  // detached is then known only by having been seen.
  process.stdin.pipe(server.stdin, { end: false });
  process.stdin.once("end", () => {
    void look().finally(() => server.stdin.end());
  });

  /** Every process of the tree a look has found, the server included: pid → creation time. */
  const known = new Map();

  /** The tree as the table says it is now, from the server and every process ever seen in it; null where the table cannot be read. */
  const look = async () => {
    const listing = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", tableCommand]);
    if (listing === null) return null;
    const rows = new Map();
    const children = new Map();
    for (const line of listing.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) continue;
      const row = { pid: Number(match[1]), ppid: Number(match[2]), start: BigInt(match[3]) };
      rows.set(row.pid, row);
      const siblings = children.get(row.ppid);
      if (siblings) siblings.push(row);
      else children.set(row.ppid, [row]);
    }
    const found = new Map();
    // [pid, created no earlier than, created before (or null)]: a
    // process's children are those created after it; where its pid now
    // names somebody else, only those created before that somebody was.
    const queue = [];
    const seed = (pid, start, isIt) => {
      const row = rows.get(pid);
      if (row && isIt(row.start)) {
        found.set(pid, row.start);
        queue.push([pid, row.start, null]);
      } else {
        queue.push([pid, start, row ? row.start : null]);
      }
    };
    const serverStart = known.get(server.pid);
    seed(server.pid, serverStart ?? spawnedAfter, (start) => (serverStart === undefined ? start >= spawnedAfter && start <= spawnedBefore : start === serverStart));
    for (const [pid, start] of known) if (pid !== server.pid) seed(pid, start, (now) => now === start);
    while (queue.length > 0) {
      const [pid, from, until] = queue.pop();
      for (const row of children.get(pid) ?? []) {
        if (row.start < from || (until !== null && row.start >= until)) continue;
        if (row.pid === process.pid || row.pid <= 4 || found.has(row.pid)) continue;
        found.set(row.pid, row.start);
        queue.push([row.pid, row.start, null]);
      }
    }
    for (const [pid, start] of found) known.set(pid, start);
    return [...found.keys()];
  };

  let ending = false;
  const endTree = async (code) => {
    if (ending) return;
    ending = true;
    const deadline = Date.now() + BUDGET_MS;
    // Looked at while the server still parents what it started: whatever
    // goes from here on is still known by who it was.
    await look();
    if (server.exitCode === null && server.signalCode === null) await run(taskkill, ["/pid", String(server.pid), "/T", "/F"]);
    for (;;) {
      const left = await look();
      for (const pid of left ?? []) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Gone already.
        }
      }
      if (left?.length === 0 || Date.now() >= deadline) break;
      // A table that cannot be read says nothing more on the next look;
      // with the server gone, taskkill has done what can be done.
      if (left === null && (server.exitCode !== null || server.signalCode !== null)) break;
      await pause(SWEEP_MS);
    }
    process.exit(code);
  };

  server.on("error", (error) => {
    process.stderr.write(`eo: could not start the supervised server: ${String(error.message ?? error)}\n`);
    process.exit(127);
  });
  server.on("exit", (code, signal) => void endTree(signal === null ? (code ?? 0) : 0));
  process.on("message", (message) => {
    if (message === "end") void endTree(0);
  });
  process.on("disconnect", () => void endTree(0));
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch {
    // Gone, or not ours to signal.
  }
}

/**
 * Is there still a process behind this id?
 *
 * `EPERM` counts as yes, and getting that wrong is the whole of what
 * this function has to be careful about: it means the process exists and
 * this one may not signal it, which is the answer a re-parented child
 * gets when it asks about pid 1. Reading that as "gone" would make every
 * supervised server shut itself down a moment after starting.
 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  process.stderr.write("eo: superviseStdioServer needs a command to run\n");
  process.exit(2);
}

// Read before anything else can change it. Once the parent dies this
// process is re-parented — to pid 1, or on Windows to nothing at all —
// so the id has to be captured while it still names the CLI.
const startedBy = process.ppid;

// Already orphaned before this got going: the CLI died in the moment
// between spawning this and this reading its own parent. Starting the
// server now would be starting one nobody is going to stop.
if (startedBy <= 1) process.exit(0);

// `stdout` and `stderr` are inherited, so the server's replies reach the
// backend down the descriptor they always would — untouched, not copied.
// `stdin` is a pipe because this process has to be able to notice when
// its end of it closes, which is the whole mechanism below.
//
// `windowsHide` because this process is not started by EO (EO-204). The
// backend CLI starts it, and a Windows process with no console of its
// own gets a fresh one — with a window — the moment it spawns a console
// program. Whether this one has a console depends on how a downloaded
// binary chose to spawn it, which is not something EO can assert; the
// flag costs nothing when there is already a console to inherit, and is
// the whole fix when there is not.
//
// The mark goes on top of whatever environment this was given (EO-494),
// and the server starts inside a cgroup of its own (`containedLaunch`).
//
// On Windows what is spawned here is the holder, detached so it is in no
// job object, and the holder spawns the server (`windowsHolder`); a
// channel to it carries `end`, and its dropping says this process went.
const launchPlan = containedLaunch(command, args);
const child =
  process.platform === "win32"
    ? spawn(
        process.execPath,
        [
          "-e",
          `(${String(windowsHolder)})(process.argv[1])`,
          JSON.stringify({ command, args, powershell: windowsSystemExecutable(WINDOWS_POWERSHELL), taskkill: windowsSystemExecutable("taskkill.exe"), tableCommand: WINDOWS_TABLE_COMMAND, lookTimeoutMs: WINDOWS_LOOK_TIMEOUT_MS }),
        ],
        { detached: true, stdio: ["pipe", "inherit", "inherit", "ipc"], env: { ...process.env, [MARK_VARIABLE]: mark }, windowsHide: true },
      )
    : spawn(launchPlan.command, launchPlan.args, { stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, [MARK_VARIABLE]: mark }, windowsHide: true });
// `EO_SUPERVISOR_ADOPT_DELAY_MS` is for this file's tests: it holds back
// the move from outside, which is what shows the server was inside its
// cgroup without it.
const adoptDelay = Number(process.env.EO_SUPERVISOR_ADOPT_DELAY_MS ?? 0);
if (adoptDelay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, adoptDelay);
cgroup = adopt(launchPlan.path, child.pid);

// Requests are relayed rather than inherited, and that is the price of
// the guarantee. It buys the only signal that is immune to a reused pid,
// and it is a straight byte pipe rather than anything that parses: the
// direction carrying volume — the server's answers — is still inherited
// and never passes through here.
process.stdin.pipe(child.stdin);
// Writing into a server that has already gone is not news; its own
// `exit` below is the account of what happened.
child.stdin.on("error", () => {});

let ending = false;

// Who the server's descendants are, looked at while it runs, where its
// cgroup cannot say: an `npx` leaves its real server to pid 1 the moment
// it goes, and from then on only having seen it says whose it is (EO-494).
// Windows' table is a PowerShell start, so it is read only at the end.
const treeWatch = cgroup === null && process.platform !== "win32" ? setInterval(() => descendants(false), TREE_POLL_MS) : null;
treeWatch?.unref?.();

function exited() {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolves once the child has exited, or after `ms`. */
function childExit(ms) {
  if (exited()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * End the server and everything it started, then this process. Graceful
 * first, then not.
 *
 * The whole tree, not only the child (EO-494): a SIGTERM that reached
 * only `npx` left the server behind it running. So the tree is found
 * before anything is signalled, SIGTERM goes to all of it with the child,
 * and whatever is still there after the grace gets SIGKILL — looked for
 * again first, so one started meanwhile is not missed — until the tree
 * is gone. Only then does this process leave.
 *
 * And then wait, rather than leaving in the same breath as the signal.
 * Reaping a child takes a trip through the event loop, so a process that
 * exits here has abandoned one that is dead but not yet collected — and
 * an unreaped orphan stays in the process table wherever pid 1 does not
 * clean up after strangers, which is the ordinary case inside a
 * container. `exited()` is true once the child is really gone, and that,
 * with nothing it started still there, is the only honest moment to
 * leave. SIGKILL cannot be refused, so that moment is coming; the
 * backstop is for the case where this process no longer has a handle
 * worth waiting on: whatever else happens, the supervisor does not
 * become the thing that lingers.
 */
async function end(code) {
  if (ending) return;
  ending = true;
  if (treeWatch) clearInterval(treeWatch);
  if (process.platform === "win32") await endOnWindows();
  else await endTreeOnPosix();
  if (cgroup !== null) removeCgroup(cgroup);
  process.exit(code);
}

/** `endOnPosix`, then SIGKILL to whatever is still found, until the tree is gone or the budget is spent. */
async function endTreeOnPosix() {
  const began = Date.now();
  await endOnPosix();
  for (;;) {
    const left = descendants();
    if (exited() && left.length === 0) break;
    // Signalled before the budget is consulted: what a look found must
    // be ended, not only named.
    if (!exited()) child.kill("SIGKILL");
    killContained();
    for (const pid of left) signal(pid, "SIGKILL");
    if (Date.now() - began >= GRACE_MS + REAP_BUDGET_MS) {
      process.stderr.write(`eo: the supervised server's tree did not end: ${[...(exited() ? [] : [child.pid]), ...left].join(", ")}\n`);
      break;
    }
    await pause(SWEEP_MS);
  }
}

/** SIGTERM to the whole tree, the grace, then SIGKILL to what is left. */
async function endOnPosix() {
  const began = Date.now();
  const termed = new Set();
  const term = () => {
    for (const pid of descendants()) {
      if (termed.has(pid)) continue;
      termed.add(pid);
      signal(pid, "SIGTERM");
    }
  };
  term();
  if (!exited()) child.kill("SIGTERM");
  // A server that goes quietly, with all it started, does not have to
  // wait out the grace period.
  while (Date.now() - began < GRACE_MS) {
    term();
    if (exited() && descendants().length === 0) return;
    await pause(SWEEP_MS);
  }
  killContained();
  if (!exited()) child.kill("SIGKILL");
  for (const pid of descendants()) signal(pid, "SIGKILL");
}

/**
 * Windows: the holder is told to end the tree, and waited on. The order
 * that works there — a look while the server still parents its tree,
 * `taskkill /T` waited for, then looks and SIGKILL until nothing is left —
 * is the holder's (`windowsHolder`), because the holder is what survives
 * this process being killed, and so the one that has to know how.
 */
async function endOnWindows() {
  if (!exited()) {
    try {
      // A callback, so a channel already gone is not an `error` on the child.
      child.send("end", () => {});
    } catch {
      // Gone: the holder has seen the channel drop and is ending the tree.
    }
  }
  await childExit(HOLDER_WAIT_MS);
  if (!exited()) process.stderr.write(`eo: the supervised server's holder did not finish ending its tree: ${child.pid}\n`);
}

/**
 * **The signal that decides this, and the reason it is not the pid.**
 *
 * When the backend goes — exited, killed, or crashed — the kernel closes
 * the write end of the pipe this process is reading, and it does so
 * unconditionally and without anybody choosing to. Reading EOF is
 * therefore the one piece of evidence that arrives however the backend
 * went, and, crucially, it says nothing about pids.
 *
 * That last part is the point. Asking whether a captured pid is still
 * alive looked equivalent and is not: pids are reused. A backend that
 * exits and has its number taken by an unrelated process leaves the
 * probe answering "still there" forever, and the server it started runs
 * until the machine is rebooted — the exact orphan this file exists to
 * prevent, arrived at by the mechanism meant to prevent it. Nothing here
 * consults `startedBy` any more except the fallback below, which can
 * only ever end things *earlier*.
 */
process.stdin.on("end", () => void end(0));
process.stdin.on("close", () => void end(0));
process.stdin.on("error", () => void end(0));

/**
 * The fallback, for a stdin that will never say anything.
 *
 * EOF is the better signal and cannot be the only one: a backend is free
 * to hand this process a stdin that never closes — a terminal, or a
 * descriptor it holds open past its own death — and then no amount of
 * waiting produces one. So the pid is still watched, and a pid that has
 * *gone* is honest evidence: nothing reuses a number that is still in
 * use, so a false "gone" is not a thing that happens.
 *
 * The failure it cannot have is the one above: this can be late, or
 * silent, and EOF has already covered that. It may never be the only
 * mechanism, which is what the reuse test beside this file pins.
 */
const watch = setInterval(() => {
  if (!alive(startedBy)) void end(0);
}, POLL_MS);
// Do not hold the process open on the timer's account — the child
// handle is what keeps this alive, and when the child is gone so is the
// reason to be here.
watch.unref?.();

// The ordinary ending: the server stopped on its own, so this stops too,
// reporting what it reported. Anything reading this process sees the
// server's own outcome rather than a wrapper's — once whatever the
// server left behind has been ended with it (EO-494).
child.once("exit", (code, signal) => {
  clearInterval(watch);
  if (!ending) void end(signal === null ? (code ?? 0) : 0);
});

// A command that could not be started at all is this process's failure
// to report, not a silent hang.
child.once("error", (error) => {
  process.stderr.write(`eo: could not start the supervised server: ${String(error.message ?? error)}\n`);
  process.exit(127);
});
