import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allGone, CONTAINMENT_EXPECTED, descendantPids, DESCENDANTS_SNIPPET, running, sweepUp, type DescendantKind } from "../testing/escapingDescendants.js";
import { nodeScript } from "../testing/nodeScript.js";
import { containmentAvailable } from "./cgroupContainment.js";
import type { EndableProcess } from "./endProcess.js";
import { endAllProcessTrees, fileTime, liveProcessTrees, ProcessTree, readProcessTable, TREE_MARKER_VARIABLE, type ProcessTable, type ProcessTreeOptions } from "./processTree.js";

const directories: string[] = [];
const leftovers: number[] = [];
const roots: ChildProcess[] = [];

afterEach(async () => {
  sweepUp(leftovers.splice(0));
  for (const root of roots.splice(0)) if (root.exitCode === null && root.signalCode === null) root.kill("SIGKILL");
  await endAllProcessTrees();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * An agent's process, as far as a tree is concerned: started with the
 * mark, it starts the descendants a pid-kill misses
 * (`escapingDescendants.ts`) and then, unless it `exitsAfterMs`, stays —
 * ignoring SIGTERM if `stubborn`, as a CLI busy on its own terms might.
 */
async function agent(options: { stubborn?: boolean; exitsAfterMs?: number; tree?: ProcessTreeOptions } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "eo-tree-"));
  directories.push(directory);
  const pidFile = join(directory, "pids");
  const marker = ProcessTree.newMarker();
  const source = `const pidFile = ${JSON.stringify(pidFile)}; ${options.stubborn ? 'process.on("SIGTERM", () => {});' : ""} ${DESCENDANTS_SNIPPET} ${options.exitsAfterMs === undefined ? "setInterval(() => {}, 1000);" : `setTimeout(() => process.exit(0), ${options.exitsAfterMs});`}`;
  const root = spawn(process.execPath, [nodeScript(source)], { env: { ...process.env, [TREE_MARKER_VARIABLE]: marker }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  roots.push(root);
  const tree = new ProcessTree(root, marker, { pollMs: 50, ...options.tree });
  const descendants = await descendantPids(pidFile);
  leftovers.push(...descendants.values());
  const pid = (kind: DescendantKind) => descendants.get(kind)!;
  return { root, tree, descendants, pid, all: [...descendants.values()] };
}

const exitOf = (root: ChildProcessWithoutNullStreams) => (root.exitCode === null && root.signalCode === null ? new Promise((resolve) => root.once("exit", resolve)) : Promise.resolve());
const linux = process.platform === "linux";
const posix = process.platform !== "win32";
const contained = linux && containmentAvailable();

describe.runIf(linux && CONTAINMENT_EXPECTED)("where CI has handed the suite a cgroup of its own", () => {
  it("agents are contained, so no case below is quietly held to less", () => {
    expect(containmentAvailable()).toBe(true);
  });
});

describe.runIf(contained)("a contained process tree (EO-494)", () => {
  it("is started where finding cannot reach: one descendant whose parent, session and environment all say nothing of the agent", async () => {
    const { root, tree, pid } = await agent();
    const table = (await readProcessTable(tree.marker))!;

    expect(tree.contained).toBe(true);
    expect(pid("vanished") > 1 && running(pid("vanished"))).toBe(true);
    expect(table.rows.get(pid("vanished"))?.ppid).not.toBe(root.pid);
    expect(table.marked.has(pid("vanished"))).toBe(false);
  });

  it("ends the agent and everything it started, the env -i setsid one whose shell exited a moment ago included", async () => {
    // The reproduction: `env -i PATH=/usr/bin:/bin setsid sleep 600 … &
    // echo $!` through a shell, 200ms, then the end.
    const { root, tree, all } = await agent();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const path = (tree as unknown as { containment: { path: string } }).containment.path;

    expect(await tree.end(100)).toEqual([]);

    expect(root.exitCode !== null || root.signalCode !== null).toBe(true);
    expect(await allGone(all, 1_000)).toBe(true);
    expect(existsSync(path), "the tree's cgroup is taken away once it is empty").toBe(false);
    expect(liveProcessTrees()).toBe(0);
  });

  it("escalates to SIGKILL for an agent that ignores SIGTERM, and still takes everything it started", async () => {
    const { root, tree, all } = await agent({ stubborn: true });

    expect(await tree.end(150)).toEqual([]);

    expect(root.signalCode).toBe("SIGKILL");
    expect(await allGone(all, 1_000)).toBe(true);
  });

  it("ends what an agent left when it went on its own before anything looked", async () => {
    // Gone at once: no poll ever saw its children while it parented them.
    const { root, tree, all } = await agent({ exitsAfterMs: 0 });
    await exitOf(root);

    expect(all.every(running)).toBe(true);
    expect(await tree.end(500)).toEqual([]);
    expect(await allGone(all, 1_000)).toBe(true);
  });

  it("reports the agent as a survivor when no signal reaches it, and still ends what it started", async () => {
    const { root, tree, all } = await agent();
    // No real process survives SIGKILL on demand; the signals are what is taken away.
    root.kill = () => true;

    expect(await tree.end(50)).toEqual([root.pid]);
    expect(await allGone(all, 1_000)).toBe(true);
    expect(liveProcessTrees()).toBe(1);
  });

  it("ends every tree outright at quit, whatever its agent would do with SIGTERM", async () => {
    const first = await agent({ stubborn: true });
    const second = await agent();

    await endAllProcessTrees();

    expect(await allGone([first.root.pid!, ...first.all, second.root.pid!, ...second.all], 2_000)).toBe(true);
    expect(liveProcessTrees()).toBe(0);
  });

  it("is killed synchronously by the main process's exit backstop, for a quit that never reached the shutdown path", async () => {
    const { root, tree, all } = await agent({ stubborn: true });

    tree.killSync();

    expect(await allGone([root.pid!, ...all], 1_000)).toBe(true);
    expect(liveProcessTrees()).toBe(0);
  });
});

describe.runIf(posix)("a process tree found rather than contained — macOS, or a Linux whose cgroup is not EO's to write (EO-494)", () => {
  const found = { contain: false } as const;

  it("ends the agent and the descendants it can find, the setsid one whose shell exited included", async () => {
    const { root, tree, pid } = await agent({ tree: found });

    expect(tree.contained).toBe(false);
    expect(await tree.end(2_000)).toEqual([]);

    expect(root.signalCode).toBe("SIGTERM");
    expect(await allGone([pid("escaped"), pid("bare")], 1_000)).toBe(true);
  });

  it("finds what an agent left after it went on its own: the marked one by its mark, the unmarked one because it was seen while its parent lived", async () => {
    // Gone once a poll (every 50ms here) has had the chance to see its children.
    const { root, tree, pid } = await agent({ exitsAfterMs: 300, tree: found });
    await exitOf(root);

    expect(running(pid("escaped")) && running(pid("bare"))).toBe(true);
    expect(await tree.end(500)).toEqual([]);
    expect(await allGone([pid("escaped"), pid("bare")], 1_000)).toBe(true);
  });

  it("at quit, signals what a slow first look found however long the look took, and does not let go of a tree it could not end", async () => {
    // A root with a plain child, and a process table that takes longer
    // to read than quit's whole wait.
    const root = spawn(process.execPath, ["-e", 'const c = require("node:child_process").spawn("sleep", ["600"], { stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1000);'], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    roots.push(root);
    const childPid = await new Promise<number>((resolve) => root.stdout.once("data", (chunk: Buffer) => resolve(Number(String(chunk).trim()))));
    leftovers.push(childPid);
    const slow = async (marker?: string) => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      return readProcessTable(marker);
    };
    const tree = new ProcessTree(root, ProcessTree.newMarker(), { contain: false, readTable: slow });

    await tree.kill();

    expect(await allGone([childPid], 500)).toBe(true);
    expect(liveProcessTrees()).toBe(0);

    // And one whose child no signal moves stays EO's, for the exit backstop.
    const stuck = new ProcessTree(spawn("sleep", ["600"], { stdio: "ignore", windowsHide: true }), ProcessTree.newMarker(), {
      contain: false,
      readTable: async () => ({ rows: new Map([[7_777_777, { pid: 7_777_777, ppid: 1, start: "1", zombie: false }]]), marked: new Set() }),
      signal: () => undefined,
    });
    (stuck as unknown as { known: Map<number, string> }).known.set(7_777_777, "1");
    await stuck.kill();
    expect(liveProcessTrees()).toBe(1);
    stuck.dispose();
  });

  it("leaves alone a process that only shares a pid with one it once saw", async () => {
    // What a reused pid looks like from here: a pid the tree remembers,
    // now naming a process that started at another time.
    const stranger = spawn("sleep", ["600"], { stdio: "ignore", windowsHide: true });
    leftovers.push(stranger.pid!);
    const { tree } = await agent({ exitsAfterMs: 0, tree: found });
    (tree as unknown as { known: Map<number, string> }).known.set(stranger.pid!, "not when it started");

    await tree.end(100);

    expect(running(stranger.pid!)).toBe(true);
  });
});

describe.runIf(process.platform === "win32")("a process tree on Windows (EO-494)", () => {
  it("ends the children of an agent that went on its own before anything looked", async () => {
    const { root, tree, pid, all } = await agent({ exitsAfterMs: 300 });
    await exitOf(root);

    // Node puts a child it did not detach in a job object that is closed,
    // and the child with it, when Node exits — so the plain one may have
    // gone with the agent. The detached one is in no job: it is what an
    // agent that went on its own leaves behind.
    expect(running(pid("detached"))).toBe(true);
    expect(await tree.end(2_000)).toEqual([]);
    expect(await allGone(all, 2_000)).toBe(true);
  });

  it("ends the agent and both its children, the one detached into a group of its own included", async () => {
    const { root, tree, all } = await agent();

    expect(await tree.end(2_000)).toEqual([]);

    expect(root.exitCode !== null || root.signalCode !== null).toBe(true);
    expect(await allGone(all, 2_000)).toBe(true);
    expect(liveProcessTrees()).toBe(0);
  });
});

/**
 * Windows' order, held on any platform (EO-494): `taskkill /T` walks the
 * tree from its root, so it has to have *finished* before anything is
 * done to the root, and the tree is let go of only once the table says
 * it has gone. The root, the table, taskkill and the signals are all
 * stand-ins: what is under test is the sequence.
 */
describe("ending a tree on Windows, in order", () => {
  const ROOT = 7_001;
  const CHILD = 7_002;

  /**
   * `childReplaced`: taskkill ends the child, and by the time anything
   * looks again its pid belongs to a stranger — created later, parented
   * elsewhere. Windows hands pids out again quickly.
   */
  function windows(options: { taskkillSays: boolean; childSurvives: boolean; childReplaced?: boolean }) {
    const events: string[] = [];
    let rootAlive = true;
    let childAlive = true;
    let childReplaced = false;
    const exitListeners: (() => void)[] = [];
    const root: EndableProcess = {
      pid: ROOT,
      get exitCode() {
        return rootAlive ? null : 1;
      },
      signalCode: null,
      kill(name) {
        events.push(`root ${name}`);
        return true;
      },
      once(_event, listener) {
        exitListeners.push(listener);
      },
    };
    const readTable = async (): Promise<ProcessTable> => ({
      rows: new Map([
        ...(rootAlive ? [[ROOT, { pid: ROOT, ppid: 1, start: "10", zombie: false }] as const] : []),
        ...(childAlive ? [[CHILD, { pid: CHILD, ppid: ROOT, start: "20", zombie: false }] as const] : []),
        ...(childReplaced ? [[CHILD, { pid: CHILD, ppid: 999, start: "30", zombie: false }] as const] : []),
      ]),
      marked: new Set(),
    });
    const taskkill = async (pid: number) => {
      events.push(`taskkill ${pid} started`);
      // Long enough that a root killed alongside it, rather than after,
      // would be dead before taskkill had walked its tree.
      await new Promise((resolve) => setTimeout(resolve, 30));
      events.push(`taskkill ${pid} finished`);
      if (!options.childSurvives) childAlive = false;
      if (options.childReplaced) childReplaced = true;
      rootAlive = false;
      for (const listener of exitListeners.splice(0)) listener();
      return options.taskkillSays;
    };
    const signal = (pid: number, name: NodeJS.Signals) => {
      events.push(`${pid} ${name}`);
    };
    const tree = new ProcessTree(root, "mark", { platform: "win32", readTable, taskkill, signal, contain: false });
    return { tree, events, readTable };
  }

  it("waits for taskkill to finish before anything is done to the root, and lets go once the table says the tree is gone", async () => {
    const { tree, events } = windows({ taskkillSays: true, childSurvives: false });

    expect(await tree.end(100)).toEqual([]);

    expect(events[0]).toBe(`taskkill ${ROOT} started`);
    expect(events[1]).toBe(`taskkill ${ROOT} finished`);
    // Neither the root nor the child taskkill took is then signalled
    // blind as if it were still there.
    expect(events.filter((event) => event.startsWith("root "))).toEqual([]);
    expect(events.filter((event) => event.startsWith(`${CHILD} `))).toEqual([]);
    expect(liveProcessTrees()).toBe(0);
  });

  it("never signals a stranger who took a descendant's pid while taskkill ran — end", async () => {
    const { tree, events } = windows({ taskkillSays: true, childSurvives: false, childReplaced: true });

    expect(await tree.end(100)).toEqual([]);

    expect(events.filter((event) => event.startsWith(`${CHILD} `))).toEqual([]);
    expect(liveProcessTrees()).toBe(0);
  });

  it("never signals a stranger who took a descendant's pid while taskkill ran — quit", async () => {
    const { tree, events } = windows({ taskkillSays: true, childSurvives: false, childReplaced: true });

    await tree.kill();

    expect(events.slice(0, 2)).toEqual([`taskkill ${ROOT} started`, `taskkill ${ROOT} finished`]);
    expect(events.filter((event) => event.startsWith(`${CHILD} `))).toEqual([]);
    expect(liveProcessTrees()).toBe(0);
  });

  it("signals, at exit, only remembered descendants whose pid still names them", () => {
    // Remembered: the child (created at 20) and the child's own child
    // (at 25). At exit the child's pid is a stranger's (created at 30);
    // the grandchild is still itself, and is the only one signalled.
    const signalled: number[] = [];
    const taskkilled: number[] = [];
    const root: EndableProcess = { pid: ROOT, exitCode: 0, signalCode: null, kill: () => true, once: () => undefined };
    const tree = new ProcessTree(root, "mark", {
      platform: "win32",
      contain: false,
      bornAfter: 10n,
      readTableSync: () => ({
        rows: new Map([
          [CHILD, { pid: CHILD, ppid: 999, start: "30", zombie: false }],
          [7_004, { pid: 7_004, ppid: CHILD, start: "25", zombie: false }],
        ]),
        marked: new Set(),
      }),
      taskkillSync: (pid) => taskkilled.push(pid),
      signal: (pid) => signalled.push(pid),
    });
    const known = (tree as unknown as { known: Map<number, string> }).known;
    known.set(CHILD, "20");
    known.set(7_004, "25");

    tree.killSync();

    expect(signalled).toEqual([7_004]);
    // The root had already gone: nothing for taskkill to walk.
    expect(taskkilled).toEqual([]);
    expect(liveProcessTrees()).toBe(0);
  });

  it("keeps a root's children once the root has gone on its own — a Windows parent pid is never re-pointed — and leaves a stranger who inherited a pid alone", async () => {
    const born = fileTime(Date.now() - 1_000);
    const later = (ms: number) => String(born + BigInt(ms) * 10_000n);
    const alive = new Set([CHILD, 7_003, 7_004]);
    const signalled: number[] = [];
    const exitListeners: (() => void)[] = [];
    let rootAlive = true;
    const root: EndableProcess = {
      pid: ROOT,
      get exitCode() {
        return rootAlive ? null : 0;
      },
      signalCode: null,
      kill: () => true,
      once: (_event, listener) => exitListeners.push(listener),
    };
    const rows = () =>
      new Map(
        [
          // The root's child, created after it.
          { pid: CHILD, ppid: ROOT, start: later(500), zombie: false },
          // A stranger: it names the root's pid as its parent, but was
          // created before the root — the child of whoever had that pid before.
          { pid: 7_003, ppid: ROOT, start: String(born - 10_000_000n), zombie: false },
          // The child's own child, created after it.
          { pid: 7_004, ppid: CHILD, start: later(900), zombie: false },
        ]
          .filter((row) => alive.has(row.pid))
          .map((row) => [row.pid, row] as const),
      );
    const tree = new ProcessTree(root, "mark", {
      platform: "win32",
      contain: false,
      bornAfter: born,
      readTable: async () => ({ rows: rows(), marked: new Set() }),
      taskkill: async () => true,
      signal: (pid) => {
        signalled.push(pid);
        alive.delete(pid);
      },
    });
    // The root goes on its own, before anything looked: an app-server
    // reading EOF, a launcher that is done.
    rootAlive = false;
    for (const listener of exitListeners.splice(0)) listener();

    expect(await tree.end(100)).toEqual([]);

    expect(new Set(signalled)).toEqual(new Set([CHILD, 7_004]));
    expect(alive.has(7_003)).toBe(true);
  });

  it.each([
    { case: "the root went on its own before the end", rootGoesFirst: true },
    { case: "taskkill left a child behind", rootGoesFirst: false },
  ])("ends what a look found even when the look takes longer than the grace — $case", async ({ rootGoesFirst }) => {
    // A look on Windows is a PowerShell start, which on a busy machine
    // takes longer than a grace of 100ms. What it found must still be
    // signalled, not reported as a survivor that was never asked to go.
    let rootAlive = true;
    let childAlive = true;
    const exitListeners: (() => void)[] = [];
    const signalled: number[] = [];
    const root: EndableProcess = {
      pid: ROOT,
      get exitCode() {
        return rootAlive ? null : 0;
      },
      signalCode: null,
      kill: () => true,
      once: (_event, listener) => exitListeners.push(listener),
    };
    const born = fileTime(Date.now() - 500);
    const tree = new ProcessTree(root, "mark", {
      platform: "win32",
      contain: false,
      bornAfter: born,
      readTable: async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { rows: new Map(childAlive ? [[CHILD, { pid: CHILD, ppid: ROOT, start: String(born + 10_000n), zombie: false }] as const] : []), marked: new Set() };
      },
      taskkill: async () => {
        rootAlive = false;
        for (const listener of exitListeners.splice(0)) listener();
        return false;
      },
      signal: (pid) => {
        signalled.push(pid);
        if (pid === CHILD) childAlive = false;
      },
    });
    if (rootGoesFirst) {
      rootAlive = false;
      for (const listener of exitListeners.splice(0)) listener();
    }

    expect(await tree.end(100)).toEqual([]);

    expect(signalled).toContain(CHILD);
    expect(childAlive).toBe(false);
  });

  it("does not read the table again to refresh a tree whose root has gone: the next look finds what it left by the root's pid", async () => {
    let reads = 0;
    const root: EndableProcess = { pid: ROOT, exitCode: 0, signalCode: null, kill: () => true, once: () => undefined };
    const tree = new ProcessTree(root, "mark", {
      platform: "win32",
      contain: false,
      readTable: async () => {
        reads += 1;
        return { rows: new Map(), marked: new Set() };
      },
    });

    await tree.refresh();

    expect(reads).toBe(0);
    tree.dispose();
  });

  it("does not take taskkill's word for it: a child still in the table is ended one by one, and reported if it will not go", async () => {
    const { tree, events } = windows({ taskkillSays: false, childSurvives: true });

    expect(await tree.end(100)).toEqual([CHILD]);

    expect(events.slice(0, 2)).toEqual([`taskkill ${ROOT} started`, `taskkill ${ROOT} finished`]);
    expect(events.filter((event) => event === `${CHILD} SIGKILL`).length).toBeGreaterThan(0);
    expect(events.indexOf(`${CHILD} SIGKILL`)).toBeGreaterThan(events.indexOf(`taskkill ${ROOT} finished`));
    // Not let go of: the quit path still owes it an ending.
    expect(liveProcessTrees()).toBe(1);
    tree.dispose();
  });
});
