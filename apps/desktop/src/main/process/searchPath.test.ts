import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SHELL_PATH_ARGS,
  composeSearchDirectories,
  describeSearchedDirectories,
  fixedDirectories,
  parseShellPath,
  readLoginShellPath,
  resetSearchPathForTests,
  resolveSearchPath,
  searchDirectories,
  searchPath,
  spawnShell,
  type ShellRun,
  type ShellRunner,
} from "./searchPath.js";

const FINDER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const HOME = "/Users/someone";
const START = "__EO_LOGIN_SHELL_PATH_START__";
const END = "__EO_LOGIN_SHELL_PATH_END__";

/** A shell that answers with what it is given, and records being asked. */
function shellSaying(run: Partial<ShellRun>, asked: string[][] = []): ShellRunner {
  return async (shell, args) => {
    asked.push([shell, ...args]);
    return { code: 0, stdout: "", timedOut: false, ...run };
  };
}

const marked = (path: string) => `${START}\n${path}\n${END}\n`;

afterEach(() => {
  resetSearchPathForTests();
  vi.restoreAllMocks();
});

describe("reading the login shell's PATH", () => {
  it("asks an interactive login shell, through printenv between markers", async () => {
    const asked: string[][] = [];

    const result = await readLoginShellPath({ platform: "darwin", shell: "/bin/zsh", run: shellSaying({ stdout: marked("/opt/homebrew/bin:/usr/bin") }, asked) });

    expect(result).toEqual({ ok: true, path: "/opt/homebrew/bin:/usr/bin" });
    expect(asked).toEqual([["/bin/zsh", "-ilc", `echo ${START}; printenv PATH; echo ${END}`]]);
  });

  it("reads the value out from among whatever the profile prints around it", async () => {
    const stdout = `Welcome to oh-my-zsh!\nnvm: using node v22\n${START}\n/opt/homebrew/bin:/usr/bin:/bin\n${END}\nlogout\n`;

    expect(await readLoginShellPath({ platform: "darwin", shell: "/bin/zsh", run: shellSaying({ stdout }) })).toEqual({
      ok: true,
      path: "/opt/homebrew/bin:/usr/bin:/bin",
    });
  });

  // What each shell actually prints for the command. Fish is the one that
  // matters: `echo $PATH` there gives a space-separated list, and
  // `printenv` gives the exported, colon-joined value.
  it.each([
    ["zsh", "/bin/zsh", `${START}\n/opt/homebrew/bin:/usr/bin:/bin\n${END}\n`],
    ["bash", "/bin/bash", `bash: no job control in this shell\n${START}\n/opt/homebrew/bin:/usr/bin:/bin\n${END}\n`],
    ["fish", "/opt/homebrew/bin/fish", `${START}\r\n/opt/homebrew/bin:/usr/bin:/bin\r\n${END}\r\n`],
  ])("reads it from %s", async (_name, shell, stdout) => {
    expect(await readLoginShellPath({ platform: "darwin", shell, run: shellSaying({ stdout }) })).toEqual({ ok: true, path: "/opt/homebrew/bin:/usr/bin:/bin" });
  });

  it("gives up when $SHELL is unset", async () => {
    const asked: string[][] = [];

    const result = await readLoginShellPath({ platform: "linux", shell: undefined, run: shellSaying({ stdout: marked("/x") }, asked) });

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("$SHELL") });
    expect(asked).toEqual([]);
  });

  it("gives up when the shell exits non-zero, even having printed a PATH", async () => {
    expect(await readLoginShellPath({ platform: "linux", shell: "/bin/bash", run: shellSaying({ code: 1, stdout: marked("/x") }) })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("exited with 1"),
    });
  });

  it("gives up when the shell times out", async () => {
    expect(await readLoginShellPath({ platform: "linux", shell: "/bin/bash", timeoutMs: 50, run: shellSaying({ code: null, timedOut: true }) })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("50 ms"),
    });
  });

  it("gives up when the shell cannot be started", async () => {
    expect(await readLoginShellPath({ platform: "linux", shell: "/nope", run: shellSaying({ code: null, error: "spawn /nope ENOENT" }) })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("ENOENT"),
    });
  });

  it.each([
    ["no markers", "/opt/homebrew/bin:/usr/bin\n"],
    ["no closing marker", `${START}\n/opt/homebrew/bin\n`],
    ["nothing between the markers", `${START}\n${END}\n`],
    ["more than one line between the markers", `${START}\nhello\n/opt/homebrew/bin\n${END}\n`],
  ])("gives up when the output has %s", async (_case, stdout) => {
    expect(await readLoginShellPath({ platform: "linux", shell: "/bin/bash", run: shellSaying({ stdout }) })).toMatchObject({ ok: false });
  });

  it("runs no shell on Windows", async () => {
    const asked: string[][] = [];

    const result = await readLoginShellPath({ platform: "win32", shell: "C:\\bash.exe", run: shellSaying({ stdout: marked("/x") }, asked) });

    expect(result.ok).toBe(false);
    expect(asked).toEqual([]);
  });

  it("parses only what sits between the markers", () => {
    expect(parseShellPath(`noise ${START}/a:/b${END} more`)).toBe("/a:/b");
    expect(parseShellPath(`${END}${START}/a`)).toBeNull();
  });
});

describe("where EO looks", () => {
  it("puts the shell's PATH first, then the inherited one, then the fixed folders, each once", () => {
    expect(composeSearchDirectories({ shellPath: "/opt/homebrew/bin:/usr/bin:/bin", inherited: FINDER_PATH, home: HOME, platform: "darwin" })).toEqual([
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      `${HOME}/.local/bin`,
      `${HOME}/bin`,
      `${HOME}/.npm-global/bin`,
      `${HOME}/.bun/bin`,
      "/usr/local/bin",
    ]);
  });

  it("falls back to the inherited PATH plus the fixed folders when there is no shell answer", () => {
    expect(composeSearchDirectories({ shellPath: null, inherited: FINDER_PATH, home: HOME, platform: "darwin" })).toEqual([
      ...FINDER_PATH.split(":"),
      ...fixedDirectories(HOME, "darwin"),
    ]);
  });

  it("uses PATH as inherited on Windows", () => {
    expect(composeSearchDirectories({ shellPath: null, inherited: "C:\\Windows;C:\\Tools", home: "C:\\Users\\x", platform: "win32" })).toEqual([
      "C:\\Windows",
      "C:\\Tools",
    ]);
  });

  it("serves the fallback until the shell answers, and its answer after", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const options = { env: { PATH: FINDER_PATH }, home: HOME, platform: "darwin" as const };
    let answer: (run: ShellRun) => void = () => {};
    const slowShell: ShellRunner = () => new Promise((resolve) => (answer = resolve));

    const resolving = resolveSearchPath({ platform: "darwin", shell: "/bin/zsh", run: slowShell });
    expect(searchPath(options)).toBe([...FINDER_PATH.split(":"), ...fixedDirectories(HOME, "darwin")].join(":"));

    answer({ code: 0, stdout: marked("/opt/homebrew/bin:/usr/bin"), timedOut: false });
    await resolving;
    expect(searchDirectories(options)[0]).toBe("/opt/homebrew/bin");
    expect(describeSearchedDirectories(options)).toContain("EO looked in: /opt/homebrew/bin, /usr/bin, /bin");
  });

  it("asks the shell once however many times it is started", async () => {
    const asked: string[][] = [];
    const run = shellSaying({ stdout: marked("/a") }, asked);

    await Promise.all([resolveSearchPath({ platform: "linux", shell: "/bin/sh", run }), resolveSearchPath({ platform: "linux", shell: "/bin/sh", run })]);

    expect(asked).toHaveLength(1);
  });

  it.each([
    ["unset", { shell: undefined, run: shellSaying({ stdout: marked("/a") }) }],
    ["failing", { shell: "/bin/zsh", run: shellSaying({ code: 2 }) }],
    ["timing out", { shell: "/bin/zsh", run: shellSaying({ code: null, timedOut: true }) }],
    ["unreadable", { shell: "/bin/zsh", run: shellSaying({ stdout: "Last login: today\n/opt/homebrew/bin\n" }) }],
  ])("keeps the fallback when the shell is %s", async (_case, shellOptions) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await resolveSearchPath({ platform: "darwin", ...shellOptions });

    expect(result.ok).toBe(false);
    expect(searchDirectories({ env: { PATH: FINDER_PATH }, home: HOME, platform: "darwin" })).toEqual([...FINDER_PATH.split(":"), ...fixedDirectories(HOME, "darwin")]);
  });
});

/** A shell installed on this machine, by name, or null. */
function installed(name: string): string | null {
  for (const dir of ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
      // eslint-disable-next-line no-empty
    } catch {}
  }
  return null;
}

/**
 * The real shells, where this machine has them, each given a profile in
 * a scratch home that adds a directory — the file each reads only as an
 * interactive login shell, so `-ilc` is what is under test.
 */
describe.skipIf(process.platform === "win32")("asking a real shell", () => {
  let home = "";

  afterEach(() => {
    vi.unstubAllEnvs();
    if (home) rmSync(home, { recursive: true, force: true });
    home = "";
  });

  function scratchHome(profile: string, text: string): string {
    home = mkdtempSync(join(tmpdir(), "eo-shell-"));
    mkdirSync(join(home, profile, ".."), { recursive: true });
    writeFileSync(join(home, profile), text);
    vi.stubEnv("HOME", home);
    vi.stubEnv("ZDOTDIR", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    vi.stubEnv("PATH", "/usr/bin:/bin");
    return home;
  }

  it.each([
    ["zsh", ".zshrc", 'echo "hello from zshrc"\nexport PATH="/eo/from-zshrc:$PATH"\n', "/eo/from-zshrc"],
    ["bash", ".bash_profile", 'echo "hello from bash"\nexport PATH="/eo/from-bash:$PATH"\n', "/eo/from-bash"],
    ["fish", ".config/fish/config.fish", 'echo "hello from fish"\nset -gx PATH /eo/from-fish $PATH\n', "/eo/from-fish"],
  ])("reads %s", async (name, profile, text, added) => {
    const shell = installed(name);
    if (!shell) return; // Not on this machine; the scripted cases above still cover its output.
    scratchHome(profile, text);

    const result = await readLoginShellPath({ platform: "linux", shell, timeoutMs: 15_000 });

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.path.split(":")).toContain(added);
    expect(result.ok && result.path).not.toContain(" ");
  }, 20_000);

  it("kills a shell that does not answer in time", async () => {
    const started = Date.now();

    const result = await spawnShell("/bin/sh", ["-c", "sleep 5"], 200);

    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("reports a shell that is not there rather than throwing", async () => {
    expect(await readLoginShellPath({ platform: "linux", shell: "/eo/no/such/shell" })).toMatchObject({ ok: false });
  });

  it("uses the arguments it says it uses", () => {
    expect(SHELL_PATH_ARGS[0]).toBe("-ilc");
  });
});
