import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { containmentAvailable } from "../process/cgroupContainment.js";
import { descendantPids, DESCENDANTS_SNIPPET, running } from "../testing/escapingDescendants.js";

/**
 * The one thing standing between a killed backend and an orphaned MCP
 * server (EO-151).
 *
 * Every other test of this feature asserts *configuration* — which
 * dispatch is handed a server, pointed where, wrapped in what. This one
 * asserts the wrapper actually works, with real processes, because
 * "no orphan survives" is a claim about the process table and cannot be
 * checked by reading an options object.
 *
 * ## Why EO owns this at all
 *
 * EO does not spawn the server. It composes a command line, hands it to
 * a backend CLI, and the CLI starts it — so the chain that ends a server
 * is EO's abort, then the SDK ending its CLI child, then the CLI ending
 * the servers it started. Only the first link is EO's. The last is a
 * promise made by a downloaded binary, and a CLI that is *killed* never
 * gets to keep it — which is precisely what a cancel and the wall-clock
 * guard both do.
 *
 * The control case at the end of this file is the evidence that the
 * problem is real rather than theoretical: the same server, started the
 * same way without the wrapper in between, survives its backend every
 * time.
 *
 * That this file is *found* at runtime — resolved from the right place
 * unpackaged, and shipped as an `extraResource` under the name the
 * resolver expects — is `packaging.test.ts`'s job, and it does it over
 * every resource rather than this one. A rename here fails there, which
 * is the only place worth asserting it: a second copy naming this file
 * by hand would be a second spelling to keep in step.
 *
 * ## What the three endings look like from here
 *
 * A run ends normally, is cancelled, or trips the wall-clock guard. By
 * the time it reaches this process those are not three different things:
 * they are "the backend exited" and "the backend was killed", and both
 * are covered below. That is what makes the guarantee adapter-agnostic —
 * the wrapper never learns which backend started it or why it stopped,
 * so there is no path through it that one adapter takes and the other
 * does not.
 */

const SUPERVISOR = join(dirname(fileURLToPath(import.meta.url)), "superviseStdioServer.mjs");

/**
 * Long enough for a 500ms poll plus the 2s grace a stubborn child gets —
 * and, on Windows, for the supervisor's two looks at the process table,
 * each a PowerShell start that a hosted runner busy with the rest of the
 * suite can take seconds over.
 */
const REAP_BUDGET_MS = process.platform === "win32" ? 30_000 : 8_000;

let scratch: string;
let started: ChildProcess[];
/**
 * Every server pid this file has put on the machine.
 *
 * Tracked separately from the backends because a server is a
 * *grandchild*: this process never holds a handle to one, so nothing
 * here reaps it by accident and `started` cannot stand in for it.
 *
 * The control below is the reason this list has to exist. It proves that
 * an unsupervised server outlives the backend that started it — which
 * means it is, by construction, the one process nothing else in the
 * chain is going to clean up. A suite about orphans that leaves an
 * orphan running on the machine it ran on is not a suite anybody should
 * trust, and on a CI box it would accumulate one per run.
 */
let launched: number[];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo-supervise-"));
  started = [];
  launched = [];
});

afterEach(() => {
  // Teardown only, never part of a proof: every assertion has run by
  // now, and nothing below is allowed to decide an outcome.
  //
  // Backends first, so a supervisor that is going to reap its own child
  // gets the chance and the ordinary case stays the ordinary case. Then
  // the servers directly, because "the supervisor will get it" is the
  // very thing under test and teardown may not assume the answer.
  for (const child of started) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone, which is what most of these tests are checking for.
    }
  }
  for (const pid of launched) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already reaped — the outcome every supervised case wanted.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * A stand-in server: it records its pid and then lingers on its input
 * the way a real stdio MCP server does.
 *
 * The lingering is the point. A script that exited on its own would be
 * absent afterwards whatever the wrapper did, which is the one way every
 * assertion in this file could pass while proving nothing.
 *
 * `stubborn` additionally ignores SIGTERM, which is the case the
 * wrapper's grace-then-SIGKILL exists for and the one a polite child
 * never exercises.
 */
function serverScript(options: { stubborn?: boolean } = {}): string {
  const path = join(scratch, `server-${options.stubborn ? "stubborn" : "polite"}.mjs`);
  writeFileSync(
    path,
    [
      "import { appendFileSync, writeFileSync } from 'node:fs';",
      "writeFileSync(process.argv[2], String(process.pid));",
      // Whatever the backend sent, written where the test can read it.
      // This is the request direction, and the only part of the protocol
      // path the supervisor touches.
      "if (process.argv[3]) process.stdin.on('data', (b) => appendFileSync(process.argv[3], b));",
      ...(options.stubborn ? ["process.on('SIGTERM', () => {});"] : []),
      "process.stdin.resume();",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    "utf8",
  );
  return path;
}

/**
 * A backend that starts what it is told and never tidies up after
 * itself.
 *
 * Deliberately careless, because a careful one would hide the thing
 * being measured: if this reaped its own children, the wrapper could be
 * removed entirely and every test here would still pass.
 *
 * `exitAfterMs` is the difference between a run that ends normally and
 * one that is cancelled or timed out — from here, a backend that leaves
 * on its own versus one that is killed where it stands.
 */
function backendScript(options: { exitAfterMs?: number; letGoAfterMs?: number; sends?: string } = {}): string {
  const path = join(scratch, `backend-${options.exitAfterMs ?? "never"}-${options.letGoAfterMs ?? "holds"}-${options.sends === undefined ? "quiet" : "talks"}.mjs`);
  writeFileSync(
    path,
    [
      "import { spawn } from 'node:child_process';",
      "import { existsSync, readFileSync } from 'node:fs';",
      "const started = spawn(process.execPath, process.argv.slice(2), { stdio: ['pipe', 'ignore', 'ignore'] });",
      "process.stdin.resume();",
      // Both timers below mean "a while after the server is really
      // up", never "a while after this process started", and the
      // difference is the whole test. Between the two lies a `node`
      // startup for the wrapper and another for the server — 130ms on
      // an idle machine here, comfortably more than 150 under the load
      // `pnpm test:coverage` puts on one — so counting from the spawn
      // let the backend leave before the server had written its pid,
      // and `launch` below timed out on an empty file. `launch` sets
      // `EO_SERVER_PID_FILE` to the path the server publishes to;
      // waiting for it makes both cases deterministic rather than
      // merely likely.
      "const up = new Promise((resolve) => { const tick = () => { const file = process.env.EO_SERVER_PID_FILE; if (file && existsSync(file) && Number(readFileSync(file, 'utf8')) > 0) resolve(); else setTimeout(tick, 10); }; tick(); });",
      ...(options.sends === undefined ? [] : [`up.then(() => started.stdin.write(${JSON.stringify(options.sends)}));`]),
      // Letting go of the pipe without dying: the backend stays in the
      // process table, holding its own pid, while the thing it started
      // loses its connection to it.
      ...(options.letGoAfterMs === undefined ? [] : [`up.then(() => setTimeout(() => started.stdin.end(), ${options.letGoAfterMs}));`]),
      options.exitAfterMs === undefined
        ? "setInterval(() => {}, 1000);"
        : `up.then(() => setTimeout(() => process.exit(0), ${options.exitAfterMs}));`,
    ].join("\n"),
    "utf8",
  );
  return path;
}

function inPidTable(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // `EPERM` means it exists and this process may not signal it, which
    // is still "there". Reading it as gone is the mistake the wrapper
    // itself has a note about.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start a backend, through the wrapper or without it, and answer with
 * the server's pid once it is really running.
 */
async function launch(options: {
  supervised: boolean;
  stubborn?: boolean;
  exitAfterMs?: number;
  letGoAfterMs?: number;
  sends?: string;
  echoTo?: string;
  /** A server script of the test's own, and what it is passed after the pid file. */
  server?: { path: string; args: string[] };
  /** Added to the backend's environment, and so the supervisor's. */
  env?: Record<string, string>;
  /** What the supervisor runs in place of `node <server script>`; it is passed the pid file after it. */
  command?: string[];
}): Promise<{ backend: ChildProcess; server: number }> {
  const pidPath = join(scratch, `${options.supervised ? "sup" : "raw"}-${options.stubborn ? "stubborn" : "polite"}.pid`);
  const server = options.server?.path ?? serverScript(options.stubborn === undefined ? {} : { stubborn: options.stubborn });
  // The backend spawns `node <argv>`, so the supervised form inserts the
  // wrapper ahead of the command it is to run and the control does not.
  const echo = options.server?.args ?? (options.echoTo === undefined ? [] : [options.echoTo]);
  const argv = options.supervised ? [SUPERVISOR, ...(options.command ?? [process.execPath, server]), pidPath, ...echo] : [server, pidPath, ...echo];

  const backend = spawn(
    process.execPath,
    [
      backendScript({
        ...(options.exitAfterMs === undefined ? {} : { exitAfterMs: options.exitAfterMs }),
        ...(options.letGoAfterMs === undefined ? {} : { letGoAfterMs: options.letGoAfterMs }),
        ...(options.sends === undefined ? {} : { sends: options.sends }),
      }),
      ...argv,
    ],
    // The backend needs to know where its grandchild publishes its pid,
    // so that "exit after 150ms" can mean 150ms after the server is
    // running rather than 150ms after this line.
    { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, ...options.env, EO_SERVER_PID_FILE: pidPath } },
  );
  started.push(backend);

  // writeFileSync creates/truncates the file before writing its bytes.
  // On a busy Windows runner this process can observe that brief empty
  // file, so existence is not yet evidence that the pid was published.
  // On Windows the server is started by the supervisor's holder: a third
  // Node start between the backend and it, on a runner busy with the rest
  // of the suite.
  const deadline = Date.now() + (process.platform === "win32" ? 30_000 : 10_000);
  let recorded = "";
  let pid = Number.NaN;
  while (Date.now() < deadline) {
    if (existsSync(pidPath)) {
      recorded = readFileSync(pidPath, "utf8");
      pid = Number(recorded);
      if (Number.isInteger(pid) && pid > 0) break;
    }
    await sleep(10);
  }
  // Recorded here rather than at each call site: every server in this
  // file is started through this function, so a case added later is
  // cleaned up without its author having to remember.
  //
  // And recorded before the two checks below rather than between them,
  // because a pid that fails them is a *running process this file
  // started* just as much as one that passes — a garbled pid file means
  // EO cannot name what it spawned, not that it spawned nothing. The
  // moment a test can throw is the moment cleanup matters most.
  if (Number.isInteger(pid) && pid > 0) launched.push(pid);

  expect(Number.isInteger(pid) && pid > 0, `the server recorded "${recorded}" instead of a pid`).toBe(true);
  expect(inPidTable(pid), "the server was gone before anything ended it").toBe(true);
  return { backend, server: pid };
}

async function reapedWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!inPidTable(pid)) return true;
    await sleep(25);
  }
  return !inPidTable(pid);
}

describe("a server started through EO's supervisor", () => {
  it("is reaped when the backend is killed where it stands", async () => {
    // A cancel and the wall-clock guard both come out here: the SDK ends
    // its CLI child, and a killed CLI runs no cleanup of its own.
    const { backend, server } = await launch({ supervised: true });

    backend.kill("SIGKILL");

    expect(await reapedWithin(server, REAP_BUDGET_MS), `the server (pid ${server}) outlived a killed backend`).toBe(true);
  });

  it("is reaped when the backend exits on its own", async () => {
    // What a run that finishes normally looks like from here.
    const { server } = await launch({ supervised: true, exitAfterMs: 150 });

    expect(await reapedWithin(server, REAP_BUDGET_MS), `the server (pid ${server}) outlived a backend that exited`).toBe(true);
  });

  it("is reaped even when it ignores being asked politely", async () => {
    // The grace period earns its place here and nowhere else: a server
    // that swallows SIGTERM is exactly the orphan this is for.
    const { backend, server } = await launch({ supervised: true, stubborn: true });

    backend.kill("SIGKILL");

    expect(await reapedWithin(server, REAP_BUDGET_MS), `the server (pid ${server}) survived SIGTERM and was never killed`).toBe(true);
  });

  /**
   * **The pid-reuse failure mode, made deterministic.**
   *
   * Deciding "is my backend still there" by probing the number it had at
   * startup looks equivalent to asking the real question and is not.
   * Pids are reused. A backend that exits and has its number taken by an
   * unrelated process leaves that probe answering "still there" for as
   * long as the machine is up, and the server it started runs forever —
   * the exact orphan this file exists to prevent, reached by the
   * mechanism meant to prevent it.
   *
   * Waiting for the number to actually be recycled would be a test that
   * takes hours and passes by luck. This inverts it instead: the backend
   * lets go of the pipe and **stays alive**, so its pid is not merely
   * possibly-reused but definitely, verifiably occupied — by the backend
   * itself, the strongest form of "that pid is still there" there is.
   *
   * A supervisor that consults the pid cannot pass this. One that watches
   * the connection cannot fail it, because the connection is gone and no
   * pid was ever part of the answer.
   */
  it("reaps the server when the backend lets go, even though its pid is still very much taken", async () => {
    const { backend, server } = await launch({ supervised: true, letGoAfterMs: 200 });

    expect(await reapedWithin(server, REAP_BUDGET_MS), `the server (pid ${server}) outlived a backend that let go of it`).toBe(true);

    // The half that makes the case: the pid was never free to be reused,
    // because its original owner never left. Asserted after the reap so
    // a failure here reads as "the backend died early and this proved
    // nothing" rather than as the reap itself.
    expect(backend.pid !== undefined && inPidTable(backend.pid), "the backend exited, so this was the ordinary case rather than the reuse one").toBe(true);
  });

  /**
   * The cost of the mechanism above, guarded.
   *
   * Requests used to be *inherited* — the server read the backend's
   * descriptor directly and this process was not in the path at all.
   * Noticing when that descriptor closes means holding it, which means
   * relaying, and a relay that silently dropped bytes would break every
   * tool call an agent makes while every other test here still passed.
   *
   * The answer direction, which carries the volume, is still inherited
   * and never passes through this process.
   */
  it("carries what the backend sends through to the server", async () => {
    const echoTo = join(scratch, "received.txt");
    const payload = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n';

    await launch({ supervised: true, sends: payload, echoTo });

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !existsSync(echoTo)) await sleep(25);
    expect(existsSync(echoTo), "nothing reached the server, so the request channel is broken").toBe(true);
    expect(readFileSync(echoTo, "utf8")).toBe(payload);
  });

  it("is left alone for as long as the backend is there", async () => {
    // The other direction, and the reason the three above are not
    // satisfied by a wrapper that simply kills everything on sight.
    const { server } = await launch({ supervised: true });

    await sleep(1_500); // three poll intervals

    expect(inPidTable(server), "the supervisor ended a server whose backend was still running").toBe(true);
  });
});

/**
 * A server shaped like one `npx` starts (EO-494): the process the
 * supervisor spawns is only a launcher, and the server proper is its
 * child — one that ignores SIGTERM, as a server busy on a request might.
 * Beside it, the launcher starts the descendants a pid-kill misses
 * (`escapingDescendants.ts`): a `setsid sleep 600` backgrounded from a
 * shell that exits at once, one with an environment of its own, and one
 * that is both. A supervisor that ends only its direct child ends the
 * launcher and leaves all of them.
 *
 * `onSigterm: "exit"` is a launcher that goes at once on SIGTERM without
 * passing it on; `exitAfterMs` one that goes on its own, leaving its
 * children to pid 1 — the ordinary ending, which the supervisor follows.
 */
function launcherScript(options: { onSigterm?: "exit"; exitAfterMs?: number; nested?: boolean; exitOnEof?: boolean } = {}): string {
  // CommonJS, because the snippet `require`s.
  const path = join(scratch, `launcher-${options.onSigterm ?? "dies"}-${options.exitAfterMs ?? "stays"}${options.nested ? "-nested" : ""}${options.exitOnEof ? "-eof" : ""}.cjs`);
  writeFileSync(
    path,
    [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const [serverPidPath, pidFile] = process.argv.slice(2);",
      "const server = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore', windowsHide: true });",
      "server.unref();",
      DESCENDANTS_SNIPPET,
      "writeFileSync(pidFile + '.server', String(server.pid));",
      ...(options.nested
        ? [
            `spawn(process.execPath, ['-e', ${JSON.stringify(INTERMEDIARY)}, pidFile + '.nested'], { stdio: 'ignore', windowsHide: true }).unref();`,
            // Started is not running: the intermediary is a Node start of
            // its own, and then a second one for its detached child. Until
            // it has recorded both, the launcher neither says it is up nor
            // starts its own exit — on Windows a launcher that exits at
            // 300ms took the intermediary with it before it had started
            // anything, and the case had no tree to test.
            "{",
            "  const { readFileSync } = require('node:fs');",
            "  const recorded = () => { try { return readFileSync(pidFile + '.nested', 'utf8').trim().split(' ').filter((pid) => Number(pid) > 0).length === 2; } catch { return false; } };",
            "  const until = Date.now() + 20000;",
            "  while (!recorded() && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);",
            "}",
          ]
        : []),
      // Last, because `launch` waits on it: by then everything is running.
      "writeFileSync(serverPidPath, String(process.pid));",
      ...(options.onSigterm === "exit" ? ["process.on('SIGTERM', () => process.exit(0));"] : []),
      ...(options.exitAfterMs === undefined ? ["setInterval(() => {}, 1000);"] : [`setTimeout(() => process.exit(0), ${options.exitAfterMs});`]),
      // As a stdio MCP server does when its input closes.
      ...(options.exitOnEof ? ["process.stdin.on('end', () => process.exit(0));"] : []),
      "process.stdin.resume();",
    ].join("\n"),
    "utf8",
  );
  return path;
}

/**
 * `nested`: an undetached process the launcher starts, which starts a
 * detached one of its own and stays — the shape where killing the chain
 * from the top leaves something that names a parent already gone. The
 * detached one keeps the environment it inherited: it is not the named
 * exception.
 */
const INTERMEDIARY = [
  "const deep = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true });",
  "deep.unref();",
  "require('node:fs').writeFileSync(process.argv[1], process.pid + ' ' + deep.pid);",
  "setInterval(() => {}, 1000);",
].join(" ");

/** Starts a backend whose supervised server is `launcherScript`'s: the launcher, the server it started, and the rest of what it started. */
async function launchTree(options: { onSigterm?: "exit"; exitAfterMs?: number; letGoAfterMs?: number; nested?: boolean; exitOnEof?: boolean; contained: boolean }) {
  const pidFile = join(scratch, "descendants");
  const { backend, server: launcher } = await launch({
    supervised: true,
    ...(options.contained ? {} : { env: { EO_SUPERVISOR_CONTAIN: "0" } }),
    ...(options.letGoAfterMs === undefined ? {} : { letGoAfterMs: options.letGoAfterMs }),
    server: { path: launcherScript(options), args: [pidFile] },
  });
  const descendants = await descendantPids(pidFile);
  const server = Number(readFileSync(`${pidFile}.server`, "utf8"));
  launched.push(server, ...descendants.values());
  const nested: number[] = [];
  if (options.nested) {
    const deadline = Date.now() + 10_000;
    while (nested.length === 0) {
      const pids = existsSync(`${pidFile}.nested`) ? readFileSync(`${pidFile}.nested`, "utf8").trim().split(" ").map(Number) : [];
      if (pids.length === 2 && pids.every((pid) => Number.isInteger(pid) && pid > 0)) nested.push(...pids);
      else if (Date.now() > deadline) throw new Error("the launcher's intermediary never recorded its pids");
      else await sleep(10);
    }
    launched.push(...nested);
  }
  return { backend, launcher, server, descendants, nested, contained: options.contained };
}

/**
 * What the supervisor is held to ending besides the launcher — EO-494's
 * named exception and nothing wider (`processTree.ts`): the server behind
 * the launcher, and every descendant, where the server is contained in a
 * cgroup. Where
 * it is only found, all but a descendant that replaced its environment
 * and lost its parent before the supervisor looked: `vanished` always,
 * and `bare` too when the launcher went before the first look.
 */
function owedBy(tree: Awaited<ReturnType<typeof launchTree>>, options: { launcherGoneAtOnce?: boolean } = {}): number[] {
  const kept = [...tree.descendants].filter(([kind]) => tree.contained || (kind !== "vanished" && !(options.launcherGoneAtOnce && kind === "bare"))).map(([, pid]) => pid);
  return [tree.server, ...kept];
}

/**
 * The launcher reaped — it is the supervisor's own child, and leaving it
 * a zombie is the very thing this file guards against — and every other
 * process ended.
 *
 * Ended rather than reaped for the rest, because reaping them is not the
 * supervisor's to do: they are grandchildren and orphans, collected by
 * their own parent or by pid 1. Inside a container pid 1 is often a
 * process that collects nobody — CI's job container runs `tail -f
 * /dev/null` — and there an orphan EO killed stays a zombie for good:
 * dead, holding nothing, and still answering `kill(pid, 0)`.
 */
async function allReaped(launcher: number, pids: number[]): Promise<void> {
  expect(await reapedWithin(launcher, REAP_BUDGET_MS), `the launcher (pid ${launcher}) was not reaped`).toBe(true);
  for (const pid of pids) expect(await endedWithin(pid, REAP_BUDGET_MS), `pid ${pid} outlived the supervised server`).toBe(true);
}

/** Whether `pid` has ended within `ms` — a zombie counted as ended (`running`). */
async function endedWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!running(pid)) return true;
    await sleep(25);
  }
  return !running(pid);
}

const WAYS = [
  // Contained: the server in a cgroup of its own, where the machine allows it.
  ...(containmentAvailable() ? [{ way: "contained in a cgroup", contained: true }] : []),
  // Found: by parentage and the supervisor's mark, as on macOS or a Linux whose cgroup is not EO's.
  { way: "found by parentage and mark", contained: false },
];

describe.each(WAYS)("everything a supervised server started, $way (EO-494)", ({ contained }) => {
  // On Windows a Node backend killed outright takes the supervisor with
  // it, through the job object Node starts it in, before the supervisor
  // can look. The backend-killed cases are what the holder is for
  // (EO-502, `windowsHolder`): the server's tree is out of that job's
  // reach, and nothing here is excused on Windows.
  it("is ended with it when the backend is killed: the server behind an npx-style launcher, and everything else the launcher started", async () => {
    const tree = await launchTree({ contained });

    tree.backend.kill("SIGKILL");

    await allReaped(tree.launcher, owedBy(tree));
  });

  it("is ended with it when the backend is killed: a detached process two generations below the launcher, whose undetached parent the kill reaches first, included", async () => {
    // On Windows the case a supervisor that only looks after the fact
    // cannot meet: every job between the backend and that process closes
    // at once, its parent goes with them, and the parent it names is gone
    // before anything has seen it. The holder keeps the chain whole.
    const tree = await launchTree({ nested: true, contained });

    tree.backend.kill("SIGKILL");

    await allReaped(tree.launcher, [...owedBy(tree), ...tree.nested]);
  });

  it("is ended when the launcher exits on EOF: a detached process two generations below it, whose undetached parent goes with the launcher, included", async () => {
    // The holder looks before it passes EOF on, so on Windows too the
    // parent is seen before the launcher's exit takes it.
    const tree = await launchTree({ nested: true, exitOnEof: true, letGoAfterMs: 200, contained });

    await allReaped(tree.launcher, [...owedBy(tree), ...tree.nested]);
  });

  it("is ended when the launcher exits of its own accord, a detached process two generations below it included — but on Windows, EO-494's named exception", async () => {
    // Nobody looked while the launcher ran. Where the mark is read, the
    // detached process is found by it. On Windows, whose environment is
    // not read, its parent went with the launcher's job before the holder
    // could see it, and it names a parent nobody saw: the exception as
    // widened on EO-502, and nothing wider — the rest is still owed.
    const tree = await launchTree({ nested: true, exitAfterMs: 300, contained });
    const [intermediary, deep] = tree.nested as [number, number];

    await allReaped(tree.launcher, [...owedBy(tree, { launcherGoneAtOnce: true }), intermediary, ...(process.platform === "win32" ? [] : [deep])]);
  });

  it("is ended when the launcher goes at once on SIGTERM and leaves its children to pid 1", async () => {
    const tree = await launchTree({ onSigterm: "exit", contained });

    tree.backend.kill("SIGKILL");

    await allReaped(tree.launcher, owedBy(tree));
  });

  it("is ended on EOF after the launcher has stayed past a poll, the background setsid sleep whose shell exited included", async () => {
    // The reproduction: the launcher runs `setsid sleep 600 … & echo $!`
    // through a shell, stays 2.2 seconds, and then the backend lets go
    // of the supervisor's stdin.
    const tree = await launchTree({ letGoAfterMs: 2_200, contained });

    await allReaped(tree.launcher, owedBy(tree));
  });

  it("is ended when the launcher exits on its own before any poll could have seen what it started", async () => {
    // 300ms: long enough for `launch` to see it running, and nowhere
    // near the supervisor's first two-second look at its tree.
    const tree = await launchTree({ exitAfterMs: 300, contained });

    await allReaped(tree.launcher, owedBy(tree, { launcherGoneAtOnce: true }));
  });
});

describe.runIf(process.platform === "linux" && containmentAvailable())("a supervised server contained before it can fork (EO-494)", () => {
  it("ends an env -i setsid orphan the server made in its first instant, however late the supervisor moves it", async () => {
    // A shell server, which forks in its first millisecond: it orphans an
    // `env -i … setsid sleep 600` from a subshell that exits, and becomes
    // a long sleep. The supervisor's move from outside is held back 300ms,
    // so the orphan is inside only if the server was put there before it ran.
    const script = join(scratch, "early.sh");
    writeFileSync(script, '#!/bin/sh\n(env -i PATH=/usr/bin:/bin setsid sleep 600 >/dev/null 2>&1 </dev/null & echo $! > "$1.orphan")\necho $$ > "$1"\nexec sleep 600\n');
    const { backend, server } = await launch({ supervised: true, command: ["/bin/sh", script], env: { EO_SUPERVISOR_ADOPT_DELAY_MS: "300" } });
    const orphan = Number(readFileSync(join(scratch, "sup-polite.pid.orphan"), "utf8").trim());
    launched.push(orphan);
    expect(inPidTable(orphan)).toBe(true);

    backend.kill("SIGKILL");

    await allReaped(server, [orphan]);
  });
});

// Windows may place a process tree in a job that tears descendants down
// with the parent. In that environment an unsupervised child cannot be
// made to outlive its backend, so this Linux/macOS control would assert a
// runner policy rather than the supervisor's behaviour.
describe.skipIf(process.platform === "win32")("the same server without the supervisor", () => {
  it("outlives its backend, which is why the supervisor exists", async () => {
    // The control. Without it every test above would pass just as
    // happily against a mechanism that did nothing, because something
    // else in the chain might have been doing the reaping.
    const { backend, server } = await launch({ supervised: false });

    backend.kill("SIGKILL");

    expect(await reapedWithin(server, 2_000)).toBe(false);
    expect(inPidTable(server), "nothing reaped it, so the orphan this guards against is real").toBe(true);
  });
});

/**
 * The Windows holder's own logic (EO-502), anywhere a shell script can
 * stand in for PowerShell and taskkill: what it is handed is a process
 * table, and what it does with one is not Windows-specific. Taken from the
 * supervisor's source as the supervisor takes it (`String(windowsHolder)`)
 * and run the same way, over a server that is a real process. That the
 * holder is out of reach of a killed backend's job object only Windows can
 * show — the backend-killed cases above, there.
 *
 * Every pid in a table here is a real process this file started, so
 * whatever the holder signals, it signals nothing of anybody else's.
 */
describe.runIf(process.platform !== "win32")("the supervisor's Windows holder, as a program of its own (EO-502)", () => {
  const source = readFileSync(SUPERVISOR, "utf8");
  const begin = source.indexOf("function windowsHolder(");
  const holderSource = source.slice(begin, source.indexOf("\n}\n", begin) + 2);
  /** A Windows FILETIME for a JavaScript time, as the holder counts. */
  const fileTime = (ms: number) => (BigInt(Math.floor(ms)) + 11_644_473_600_000n) * 10_000n;

  function sleeper(): number {
    const child = spawn("sleep", ["600"], { stdio: "ignore", windowsHide: true });
    started.push(child);
    launched.push(child.pid!);
    return child.pid!;
  }

  /**
   * Starts the holder over a server that records its pid. The process
   * table is `tables[n]` for the holder's n-th look and the last one after
   * that, listing only rows whose pid is still running; taskkill ends the
   * pid it is given and every pid in `alsoTakes` (`/T`).
   */
  async function hold(options: { server?: string; tableHangs?: boolean; lookTimeoutMs?: number } = {}) {
    const serverPidFile = join(scratch, "holder-server.pid");
    const calls = join(scratch, "table-calls");
    const powershell = join(scratch, "powershell.sh");
    writeFileSync(
      powershell,
      [
        "#!/bin/sh",
        `n=$(cat '${calls}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${calls}'`,
        // CIM stalled, as on a fresh Windows runner: no answer at all.
        ...(options.tableHangs ? ["exec sleep 600"] : []),
        `f='${scratch}/table-'$n; [ -f "$f" ] || f='${scratch}/table-last'`,
        `while read pid ppid start; do kill -0 "$pid" 2>/dev/null && echo "$pid $ppid $start"; done < "$f"`,
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const alsoTakes = join(scratch, "taskkill-takes");
    writeFileSync(alsoTakes, "");
    const taskkill = join(scratch, "taskkill.sh");
    writeFileSync(taskkill, ["#!/bin/sh", 'kill -9 "$2" 2>/dev/null', `for pid in $(cat '${alsoTakes}'); do kill -9 "$pid" 2>/dev/null; done`, "exit 0", ""].join("\n"), { mode: 0o755 });
    const server = options.server ?? "setInterval(() => {}, 1000);";
    const config = { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(serverPidFile)}, String(process.pid)); ${server}`], powershell, taskkill, tableCommand: "unused", ...(options.lookTimeoutMs === undefined ? {} : { lookTimeoutMs: options.lookTimeoutMs }) };
    const born = Date.now();
    const holder = spawn(process.execPath, ["-e", `(${holderSource})(process.argv[1])`, JSON.stringify(config)], { stdio: ["pipe", "ignore", "pipe", "ipc"], windowsHide: true });
    started.push(holder);
    const exit = new Promise<number | null>((resolve) => holder.once("exit", (code) => resolve(code)));
    const deadline = Date.now() + 10_000;
    while (!existsSync(serverPidFile) || Number(readFileSync(serverPidFile, "utf8")) <= 0) {
      if (Date.now() > deadline) throw new Error("the holder's server never started");
      await sleep(10);
    }
    const serverPid = Number(readFileSync(serverPidFile, "utf8"));
    launched.push(serverPid);
    // No later than the server's creation, and no earlier than a second
    // before the holder started it: inside the window the holder knows it by.
    const serverStart = fileTime(born);
    const at = (ms: number) => String(serverStart + BigInt(ms) * 10_000n);
    const tables = (...rows: string[][]) => {
      rows.forEach((table, index) => writeFileSync(join(scratch, index === rows.length - 1 ? "table-last" : `table-${index + 1}`), table.map((row) => `${row}\n`).join("")));
    };
    return { holder, exit, serverPid, at, tables, takes: (pids: number[]) => writeFileSync(alsoTakes, pids.join(" ")) };
  }

  it("ends a child it first saw after a look, under a parent taskkill has since ended — and signals no process that only holds a remembered pid, nor its children, nor one older than the server", async () => {
    const { holder, exit, serverPid, at, tables, takes } = await hold();
    const child = sleeper();
    const grandchild = sleeper();
    const reused = sleeper();
    const reusedsChild = sleeper();
    const older = sleeper();
    tables(
      // The first look, while the server still parents its tree.
      [`${serverPid} ${holder.pid} ${at(0)}`, `${child} ${serverPid} ${at(10)}`, `${reused} ${serverPid} ${at(20)}`, `${older} ${serverPid} ${at(-100)}`],
      // Every look after taskkill: the child is gone, and the one it
      // started after the first look names it as its parent; `reused`'s
      // pid belongs to a process created later, with a child of its own.
      [`${grandchild} ${child} ${at(30)}`, `${reused} 999 ${at(500)}`, `${reusedsChild} ${reused} ${at(600)}`, `${older} ${serverPid} ${at(-100)}`],
    );
    takes([child]);

    // The supervisor gone without a word.
    holder.disconnect();

    expect(await exit).toBe(0);
    expect(await endedWithin(serverPid, 2_000), "the server").toBe(true);
    expect(await endedWithin(grandchild, 2_000), "the child its parent started after the first look").toBe(true);
    expect(running(reused), "a process holding a pid the tree once had").toBe(true);
    expect(running(reusedsChild), "that process's child").toBe(true);
    expect(running(older), "a process created before the server, naming its pid").toBe(true);
  });

  it("ends what the server left when it exits on its own, and exits with the server's code", async () => {
    const { exit, serverPid, at, tables } = await hold({ server: "setTimeout(() => process.exit(3), 1500);" });
    const left = sleeper();
    // Nobody looked while the server ran: what it left is found by the
    // server's pid and the window its creation falls in.
    tables([`${left} ${serverPid} ${at(10)}`]);

    expect(await exit).toBe(3);
    expect(await endedWithin(left, 2_000)).toBe(true);
  });

  it("looks at the tree before it passes EOF on to the server", async () => {
    const seen = join(scratch, "looks-before-eof");
    const calls = join(scratch, "table-calls");
    const { holder, exit, serverPid, at, tables } = await hold({ server: `process.stdin.on("end", () => { require("node:fs").writeFileSync(${JSON.stringify(seen)}, require("node:fs").existsSync(${JSON.stringify(calls)}) ? require("node:fs").readFileSync(${JSON.stringify(calls)}, "utf8") : "0"); process.exit(0); }); process.stdin.resume();` });
    tables([`${serverPid} ${holder.pid} ${at(0)}`]);

    holder.stdin!.end();

    expect(await exit).toBe(0);
    expect(Number(readFileSync(seen, "utf8")), "looks before the server read EOF").toBeGreaterThanOrEqual(1);
  });

  it("still ends the server when the table never answers: each look is given up on, and taskkill goes ahead", async () => {
    const { holder, exit, serverPid } = await hold({ tableHangs: true, lookTimeoutMs: 300 });
    const began = Date.now();

    holder.disconnect();

    expect(await exit).toBe(0);
    expect(await endedWithin(serverPid, 2_000)).toBe(true);
    // Not the holder's whole budget: an unreadable table and a server gone is the end of it.
    expect(Date.now() - began).toBeLessThan(10_000);
  });

  it("ends the server and its tree when told to, and only then exits", async () => {
    const { holder, exit, serverPid, at, tables } = await hold();
    const child = sleeper();
    tables([`${serverPid} ${holder.pid} ${at(0)}`, `${child} ${serverPid} ${at(10)}`]);

    holder.send("end");

    expect(await exit).toBe(0);
    expect(running(serverPid) || running(child)).toBe(false);
  });
});
