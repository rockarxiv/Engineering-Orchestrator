import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runCodeWiki } from "./run.js";

/**
 * Running CodeWiki as a subprocess (EO-143).
 *
 * Real child processes, not a mocked `spawn`. Every property this
 * module exists to hold is a property of the boundary — that an
 * argument with a space in it arrives as one argument, that a cancelled
 * run leaves nothing running, that a hang is told apart from a failure
 * — and against a mocked `spawn` all of them would be assertions about
 * the mock.
 *
 * The stand-in for CodeWiki is a Node script reached through the
 * `configured` branch of resolution, which is precisely what that
 * branch is for. The executable is `process.execPath` rather than a
 * script with a shebang, because a shebang is not something Windows can
 * spawn and this suite runs there. So none of this needs the 46 MB
 * download and none of it touches the network.
 */

const scripts = mkdtempSync(join(tmpdir(), "eo-codewiki-shims-"));
afterAll(() => rmSync(scripts, { recursive: true, force: true }));

function shim(name: string, source: string): string {
  const path = join(scripts, `${name}.mjs`);
  writeFileSync(path, source);
  return path;
}

/**
 * Reports the argv and cwd it was actually given, so both can be
 * asserted exactly.
 *
 * `slice(2)` drops node and the shim's own path, so what it prints is
 * precisely the arguments that followed the stand-in binary — i.e. what
 * CodeWiki itself would have been given.
 */
const ARGV = shim("argv", `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))`);

/** An ordinary failure: something on stderr, and a non-zero status. */
const FAILING = shim("failing", `process.stderr.write("no tree-sitter grammar for brainfuck"); process.exit(3)`);

/**
 * Never finishes, and starts a grandchild that never finishes either.
 *
 * The grandchild is the point: CodeWiki shells out to `git config`
 * while resolving hook paths, so killing the direct child alone would
 * leave work running inside a worktree EO is about to remove. Both pids
 * are written to files so a test can ask the OS about them rather than
 * take this module's word for it.
 */
const HANGING = shim(
  "hanging",
  `import { spawn } from "node:child_process";
   import { writeFileSync } from "node:fs";
   spawn(process.execPath, [process.env.EO_SLEEPER, process.env.EO_GRANDCHILD_PID_FILE], { stdio: "ignore" });
   writeFileSync(process.env.EO_PID_FILE, String(process.pid));
   setInterval(() => {}, 1000);`,
);

const SLEEPER = shim("sleeper", `import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);`);

/** 4,911 characters on each stream, ending in a marker, so the truncation arithmetic is exact. */
const CHATTY = shim("chatty", `const text = "A".repeat(4900) + "TAIL-MARKER"; process.stdout.write(text); process.stderr.write(text);`);

/** Somewhere resolution reliably finds nothing, so the `cache` branch never fires by accident. */
const EMPTY_ROOT = join(tmpdir(), "eo-codewiki-no-such-root");

function configured(path: string): { root: string; configuredPath: string } {
  return { root: EMPTY_ROOT, configuredPath: path };
}

/** A directory whose name contains a space — what the gate fixtures deliberately do. */
function spacedDirectory(): string {
  return mkdtempSync(join(tmpdir(), "eo codewiki work "));
}

/**
 * A file's code with its comments taken out.
 *
 * So that an assertion about what this module does is not satisfied or
 * broken by prose that happens to discuss a shell. Neither this file
 * nor `run.ts` contains a `//` inside a string literal, which is the
 * only thing this would get wrong.
 */
function executableSource(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

async function waitFor(condition: () => boolean, whatFor: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await new Promise((settle) => setTimeout(settle, 25));
  }
  throw new Error(`Timed out waiting for ${whatFor}.`);
}

/**
 * Whether a pid is a process that is still *running*, as opposed to one
 * that has already died and not yet been reaped.
 *
 * `process.kill(pid, 0)` cannot tell those apart: a zombie still owns
 * its pid and still answers signal 0. That is normally invisible,
 * because whoever forked the process reaps it within milliseconds — but
 * the grandchild this file kills is reparented on death to pid 1, and
 * pid 1 in CI's container is the `tail -f /dev/null` that keeps the
 * container alive. `tail` reaps nothing. So the grandchild stayed a
 * zombie for the life of the job, and "is it gone?" answered yes
 * forever on a developer machine with systemd underneath it and no
 * forever on CI, which is why this test had never passed there.
 *
 * The kill itself was always correct — a zombie holds no worktree open
 * and chews on nothing, which is the whole of what `killTree` promises.
 * It was the observation that was wrong, so reading the process state
 * is what fixes it rather than a longer timeout.
 *
 * The state is taken from after the last `)` because the field before
 * it is the executable name, which may itself contain spaces and
 * brackets — splitting the line on whitespace is the bug this avoids.
 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  // procfs is Linux's. Everywhere else `kill(0)` is the whole answer,
  // and everywhere else there is something that reaps.
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 1).trim().charAt(0) !== "Z";
  } catch {
    // Gone between the two reads, which is gone.
    return false;
  }
}

function pidIn(file: string): number {
  return Number(readFileSync(file, "utf8"));
}

/** Environment for the hanging shim: where to leave its own pid and its grandchild's. */
function pidFiles(name: string): { pidFile: string; grandchildPidFile: string; env: Record<string, string> } {
  const pidFile = join(scripts, `${name}.pid`);
  const grandchildPidFile = join(scripts, `${name}.grandchild.pid`);
  rmSync(pidFile, { force: true });
  rmSync(grandchildPidFile, { force: true });
  return { pidFile, grandchildPidFile, env: { EO_PID_FILE: pidFile, EO_GRANDCHILD_PID_FILE: grandchildPidFile, EO_SLEEPER: SLEEPER } };
}

describe("arguments reach the child as an array", () => {
  it("passes a repository path containing spaces through as a single argument", async () => {
    const workspace = spacedDirectory();
    try {
      expect(workspace).toContain(" ");
      const result = await runCodeWiki({ binary: configured(process.execPath), args: [ARGV, "index", "--path", workspace], cwd: workspace });

      expect(result.status).toBe("ok");
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.problem).toBeNull();
      expect(result.truncated).toBe(false);

      const reported = JSON.parse(result.stdout) as { argv: string[]; cwd: string };
      // One element, not two. A command line assembled into a string
      // and handed to a shell would have split this on the space, which
      // is the whole reason this module exists.
      expect(reported.argv).toEqual(["index", "--path", workspace]);
      expect(reported.argv.at(-1)).toBe(workspace);
      expect(reported.cwd).toContain(" ");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("passes shell metacharacters through untouched", async () => {
    // Not hypothetical: branch names and item titles reach argv, and
    // through a shell this is command injection rather than a quoting
    // inconvenience.
    const hostile = `; touch pwned "$(whoami)" 'x' && echo | $HOME`;
    const result = await runCodeWiki({ binary: configured(process.execPath), args: [ARGV, hostile], cwd: scripts });

    expect(result.status).toBe("ok");
    expect((JSON.parse(result.stdout) as { argv: string[] }).argv).toEqual([hostile]);
    expect(existsSync(join(scripts, "pwned"))).toBe(false);
  });

  it("never asks for a shell, and never turns the argv into a string", () => {
    // Comments stripped first, so this asserts about code rather than
    // about prose that happens to discuss a shell.
    const source = executableSource(join(dirname(fileURLToPath(import.meta.url)), "run.ts"));

    expect(source).not.toMatch(/\bshell\b/);
    // `exec`/`execSync` take a command line where `spawn` takes an argv.
    expect(source).not.toMatch(/\bexecSync\b|\bexec\s*\(/);

    // The point, and what the two tests above cannot quite reach: the
    // argv is read in exactly two places in the whole module, and
    // neither makes a string of it. One checks it is well formed; the
    // other hands the array itself to `spawn`, by reference. There is
    // no third place for a command line to be assembled in — not for a
    // shell, and not for an error message either, which is why nothing
    // in that module names the subcommand.
    expect([...source.matchAll(/\brequest\.args\b/g)]).toHaveLength(2);
    expect(source).toMatch(/assertArgv\(request\.args\)/);
    expect(source).toMatch(/spawn\(binaryPath, request\.args,/);
  });
});

describe("what a failed invocation reports", () => {
  it("reports a non-zero exit as a typed result rather than throwing", async () => {
    const result = await runCodeWiki({ binary: configured(process.execPath), args: [FAILING, "index"], cwd: scripts });

    expect(result.status).toBe("exit");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("no tree-sitter grammar for brainfuck");
    expect(result.problem).toContain("exited with status 3");
  });

  it("reports a hang as a timeout, distinguishably from a non-zero exit, and kills it", async () => {
    const { pidFile, env } = pidFiles("timeout");
    const running = runCodeWiki({ binary: configured(process.execPath), args: [HANGING, "index"], cwd: scripts, timeoutMs: 2000, env });

    // Waited for before the timeout can fire, so a slow runner cannot
    // turn "the child had not written its pid yet" into a flake.
    await waitFor(() => existsSync(pidFile), "the hanging child to start");
    const pid = pidIn(pidFile);

    const result = await running;
    expect(result.status).toBe("timeout");
    // The distinction a caller branches on: a timeout produced no
    // answer, so there is no exit status to read and none is invented.
    expect(result.exitCode).toBeNull();
    expect(result.problem).toContain("2000ms");
    expect(result.problem).toContain("did not finish");

    await waitFor(() => !isRunning(pid), "the timed-out child to be gone");
    expect(isRunning(pid)).toBe(false);
  });

  it("reports an absent binary rather than throwing", async () => {
    const missing = await runCodeWiki({ binary: configured(join(scripts, "no such directory", "codewiki")), args: ["index"], cwd: scripts });
    expect(missing.status).toBe("unavailable");
    expect(missing.ok).toBe(false);
    expect(missing.exitCode).toBeNull();
    expect(missing.problem).toContain("no such file");

    // Nothing downloaded yet: resolution answers before anything spawns.
    const notInstalled = await runCodeWiki({ binary: { root: EMPTY_ROOT }, args: ["index"], cwd: scripts });
    expect(notInstalled.status).toBe("unavailable");
    expect(notInstalled.problem).toContain("has not downloaded");

    // A platform upstream publishes no build for. The real instance is
    // an Intel Mac, and it has to read as a reason rather than as a
    // crash: repository intelligence degrades, it does not block.
    const unsupported = await runCodeWiki({ binary: { root: EMPTY_ROOT, platform: "darwin", arch: "x64" }, args: ["index"], cwd: scripts });
    expect(unsupported.status).toBe("unavailable");
    expect(unsupported.problem).toContain("Intel Macs");
  });

  it("throws only for programmer error", () => {
    // Neither of these can come from a person: an empty argv asks
    // CodeWiki to run no subcommand, and a non-string element is a call
    // site that forgot to stringify. Both are bugs in EO.
    expect(() => runCodeWiki({ binary: configured(process.execPath), args: [], cwd: scripts })).toThrow(TypeError);
    expect(() => runCodeWiki({ binary: configured(process.execPath), args: ["index", 42 as unknown as string], cwd: scripts })).toThrow(/argument 1 is not one/);
  });
});

describe("cancellation", () => {
  it("kills the running child, and the whole group it started", async () => {
    const controller = new AbortController();
    const { pidFile, grandchildPidFile, env } = pidFiles("cancel");

    const running = runCodeWiki({
      binary: configured(process.execPath),
      args: [HANGING, "index", "--path", scripts],
      cwd: scripts,
      signal: controller.signal,
      env,
    });

    await waitFor(() => existsSync(pidFile) && existsSync(grandchildPidFile), "the child and its grandchild to start");
    const pid = pidIn(pidFile);
    const grandchildPid = pidIn(grandchildPidFile);
    expect(isRunning(pid)).toBe(true);
    expect(isRunning(grandchildPid)).toBe(true);

    controller.abort();
    const result = await running;

    expect(result.status).toBe("cancelled");
    expect(result.exitCode).toBeNull();
    expect(result.problem).toContain("was cancelled");

    await waitFor(() => !isRunning(pid), "the cancelled child to be gone");
    expect(isRunning(pid)).toBe(false);
    // Not merely the direct child: an indexer left chewing on a
    // worktree EO is about to remove is the orphan this prevents.
    await waitFor(() => !isRunning(grandchildPid), "the grandchild to be gone");
    expect(isRunning(grandchildPid)).toBe(false);
  });

  it("reports a signal that had already aborted as cancelled, and leaves nothing running", async () => {
    const { pidFile, env } = pidFiles("pre-aborted");
    const result = await runCodeWiki({
      binary: configured(process.execPath),
      args: [HANGING, "index"],
      cwd: scripts,
      signal: AbortSignal.abort(),
      env,
    });

    expect(result.status).toBe("cancelled");
    // It may have been spawned and killed within the same tick; what
    // must not happen is that it survives the call.
    if (existsSync(pidFile)) await waitFor(() => !isRunning(pidIn(pidFile)), "the pre-aborted child to be gone");
  });
});

describe("captured output is bounded", () => {
  it("keeps the tail of each stream, truncates the rest, and says how much it dropped", async () => {
    const result = await runCodeWiki({ binary: configured(process.execPath), args: [CHATTY, "index"], cwd: scripts, maxOutputChars: 100 });

    expect(result.status).toBe("ok");
    expect(result.truncated).toBe(true);

    for (const stream of [result.stdout, result.stderr]) {
      // The tail, because whatever went wrong is printed last.
      expect(stream.endsWith("TAIL-MARKER")).toBe(true);
      // 4,911 characters in, 100 kept: the count is exact rather than a
      // guess about a streaming slack.
      expect(stream).toContain("[... 4811 earlier characters omitted ...]");
      expect(stream.length).toBeLessThan(200);
    }
  });

  it("says nothing about truncation when nothing was truncated", async () => {
    const result = await runCodeWiki({ binary: configured(process.execPath), args: [ARGV, "index"], cwd: scripts, maxOutputChars: 100_000 });

    expect(result.truncated).toBe(false);
    expect(result.stdout).not.toContain("omitted");
  });
});
