import { spawn } from "node:child_process";

/**
 * Kills a whole process tree.
 *
 * Killing the direct child isn't enough: check commands are run through
 * a shell, so `pnpm test` is a shell whose grandchildren do the work. If
 * only the shell dies the test runner keeps going, holding the CPU and
 * the worktree — the hang G-02 exists to stop would simply become an
 * invisible hang.
 *
 * Three callers, one implementation rather than three that drift:
 * `runCommand` beside this (the check commands), the module host
 * (KAN-105), which has the same problem one layer deeper — the host is
 * a child, and everything a module runs through `ctx.exec` is a
 * grandchild — and the repository index's own build. Each spawns its
 * child into a process group of its own so that the negative pid below
 * reaches the whole tree.
 *
 * An agent's process is not one of them: what an agent starts is free to
 * leave any group with `setsid`, so `processTree.ts` contains or finds its
 * tree another way (EO-494).
 *
 * Here rather than in `workspace/`, where it began, because the module
 * host is core and `workspace/` is on its way into the developer pack
 * (KAN-126): nothing in the core may import from a pack.
 */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // negative pid = the process group created by detached
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
