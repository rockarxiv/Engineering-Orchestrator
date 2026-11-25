import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSearchPathForTests, resolveSearchPath, searchPath } from "../process/searchPath.js";
import { type CliToolProbeOptions, agentSpawnEnvironment, agentSpawnSearchDirectories, describeFromHelp, detectCliTool, draftCliToolDescription, helpInvocation, resolveCliToolPath } from "./cliTools.js";

/**
 * Whether a CLI is installed, and a description drafted from it (EO-819).
 *
 * The real lookup and real child processes: what is being promised is
 * what the lookup finds and the draft starts on this machine, which a
 * stub would only restate.
 */
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo-cli-tools-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A POSIX script on the scratch PATH, named `name` (or at `name` under scratch, where it has a directory). */
function script(name: string, body: string): void {
  const path = join(scratch, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

const onScratch = { env: { PATH: "" } as NodeJS.ProcessEnv };
beforeEach(() => {
  // The scripts' own PATH too, so `sleep` and `yes` are found by them.
  onScratch.env = { PATH: `${scratch}${delimiter}${process.env["PATH"] ?? ""}` };
});

// Node itself, which is on every machine this suite runs on: found on
// Windows too, where a shell script is not.
const node = basename(process.execPath).replace(/\.exe$/i, "");
const nodeEnv = { PATH: dirname(process.execPath) };

/** Whether the process `pid` is gone, waiting a little for a kill to land. */
async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe("with no environment given: the PATH both backends spawn an agent with (EO-906)", () => {
  afterEach(() => {
    resetSearchPathForTests();
    vi.unstubAllEnvs();
  });

  // Windows searches the PATH EO inherited, which the PATHEXT tests hold.
  it.skipIf(process.platform === "win32")("finds a CLI only the login shell's PATH has, where EO inherited launchd's", async () => {
    script(join("brew", "foo"), "echo foo");
    // What an app started from Finder or the Dock inherits.
    vi.stubEnv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    expect(await detectCliTool("foo")).toEqual({ found: false });

    await resolveSearchPath({ shell: "/bin/zsh", run: async () => ({ code: 0, stdout: `__EO_LOGIN_SHELL_PATH_START__\n${join(scratch, "brew")}:/usr/bin\n__EO_LOGIN_SHELL_PATH_END__\n`, timedOut: false }) });

    expect(await detectCliTool("foo")).toEqual({ found: true, path: join(scratch, "brew", "foo") });
    expect(agentSpawnEnvironment()["PATH"]).toBe(searchPath());
  });

  it("is EO's own environment on Windows, the PATH as inherited", () => {
    expect(agentSpawnEnvironment("win32")).toBe(process.env);
  });
});

describe("detectCliTool", () => {
  it("reports found, with the absolute path, for a command on the agent's PATH", async () => {
    const detection = await detectCliTool(node, { env: nodeEnv });
    expect(detection).toEqual({ found: true, path: process.execPath });
  });

  it("only looks the command up: a found program is not started (EO-858)", async () => {
    // Were it run, with any argument or none, it would leave the marker.
    const marker = join(scratch, "ran");
    if (process.platform === "win32") writeFileSync(join(scratch, "marks.cmd"), `@echo ran> "${marker}"\r\n`);
    else script("marks", `touch "${marker}"`);
    const detection = await detectCliTool("marks", onScratch);
    expect(detection.found).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(marker)).toBe(false);
  });

  it("reports not found for a command on no directory of that PATH", async () => {
    expect(await detectCliTool("eo-no-such-cli", onScratch)).toEqual({ found: false });
  });

  it("looks only on the PATH the agent is spawned with, not on EO's own", async () => {
    // Found where the agent's PATH holds it; not found where it does not,
    // whatever EO's own process.env would say.
    expect(resolveCliToolPath(node, { env: nodeEnv })).toBe(process.execPath);
    expect(resolveCliToolPath(node, { env: { PATH: scratch } })).toBeNull();
  });

  it("reports not found for something that is not a single command", async () => {
    expect(await detectCliTool(`${node} --help`, { env: nodeEnv })).toEqual({ found: false });
    expect(await detectCliTool("", { env: nodeEnv })).toEqual({ found: false });
  });

  it.skipIf(process.platform === "win32")("skips a file of that name that is not executable", async () => {
    writeFileSync(join(scratch, "plain"), "#!/bin/sh\necho hi\n");
    expect(await detectCliTool("plain", onScratch)).toEqual({ found: false });
  });
});

describe.skipIf(process.platform === "win32")("the directory a command is looked up from and run in", () => {
  const runs = "exit 0";

  it("resolves a relative PATH entry against the run's directory, and answers with an absolute path the probe can start", async () => {
    script("bin/tool", runs);
    expect(await detectCliTool("tool", { env: { PATH: "bin" }, cwd: scratch })).toEqual({ found: true, path: join(scratch, "bin", "tool") });
  });

  it("outside a run, resolves a relative PATH entry against the directory the probe runs in, not EO's own", async () => {
    // EO's process.cwd() is the repository; the probe runs in tmpdir().
    script("bin/tool", runs);
    const fromTmp = relative(tmpdir(), join(scratch, "bin"));
    expect(await detectCliTool("tool", { env: { PATH: fromTmp } })).toEqual({ found: true, path: join(scratch, "bin", "tool") });
  });

  it("takes an empty PATH entry for the run's directory, as spawn does", async () => {
    script("tool", runs);
    for (const PATH of [`${join(scratch, "nowhere")}:`, `:${join(scratch, "nowhere")}`, `${join(scratch, "nowhere")}::/nowhere`, ""]) {
      expect(await detectCliTool("tool", { env: { PATH }, cwd: scratch })).toEqual({ found: true, path: join(scratch, "tool") });
    }
    expect(await detectCliTool("tool", { env: { PATH: join(scratch, "nowhere") }, cwd: scratch })).toEqual({ found: false });
  });
});

describe("resolveCliToolPath on Windows: PATHEXT, as the agent's shell looks (EO-858)", () => {
  // Windows' rules over real files in a temp directory, on every OS: the
  // lookup takes its rules from the platform it is given.
  const win = (env: NodeJS.ProcessEnv) => ({ platform: "win32" as const, env, cwd: join(scratch, "work") });
  function files(directory: string, ...names: string[]): string {
    const at = join(scratch, directory);
    mkdirSync(at, { recursive: true });
    for (const name of names) writeFileSync(join(at, name), "");
    return at;
  }
  beforeEach(() => {
    mkdirSync(join(scratch, "work"));
  });

  it("finds npm's .cmd shim for a bare name, beside its sh script and .ps1, with no .exe", () => {
    const npm = files("npm", "confluence", "confluence.cmd", "confluence.ps1");
    expect(resolveCliToolPath("confluence", win({ PATH: npm, PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC" }))).toBe(join(npm, "confluence.cmd"));
  });

  it("tries PATHEXT's extensions in order, so with the default an .exe beats a .cmd beside it", () => {
    const bin = files("bin", "tool.cmd", "tool.exe");
    expect(resolveCliToolPath("tool", win({ PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }))).toBe(join(bin, "tool.exe"));
    expect(resolveCliToolPath("tool", win({ PATH: bin, PATHEXT: ".CMD;.EXE" }))).toBe(join(bin, "tool.cmd"));
  });

  it("falls back to .COM;.EXE;.BAT;.CMD when PATHEXT is unset", () => {
    const bin = files("bin", "tool.cmd", "tool.bat", "tool.ps1");
    expect(resolveCliToolPath("tool", win({ PATH: bin }))).toBe(join(bin, "tool.bat"));
    expect(resolveCliToolPath("tool", win({ PATH: files("ps", "only.ps1") }))).toBeNull();
  });

  it("reads PATHEXT, and Path, whatever case they are spelled in", () => {
    const bin = files("bin", "tool.exe", "tool.cmd");
    expect(resolveCliToolPath("tool", win({ Path: bin, PathExt: ".CMD" }))).toBe(join(bin, "tool.cmd"));
  });

  it("looks in the probe directory, then each PATH directory in order, trying every extension in each", () => {
    const first = files("first", "tool.cmd");
    const second = files("second", "tool.exe");
    expect(resolveCliToolPath("tool", win({ PATH: `${first};${second}` }))).toBe(join(first, "tool.cmd"));
    files("work", "tool.bat");
    expect(resolveCliToolPath("tool", win({ PATH: `${first};${second}` }))).toBe(join(scratch, "work", "tool.bat"));
  });

  it("tries a name that has an extension as given, and finds no extensionless file for a bare name", () => {
    const npm = files("npm", "confluence", "confluence.ps1");
    expect(resolveCliToolPath("confluence.ps1", win({ PATH: npm }))).toBe(join(npm, "confluence.ps1"));
    expect(resolveCliToolPath("confluence", win({ PATH: npm }))).toBeNull();
    expect(resolveCliToolPath("eo-no-such-cli", win({ PATH: npm }))).toBeNull();
  });
});

describe("helpInvocation (EO-858)", () => {
  it("starts a Windows .cmd or .bat through cmd.exe /d /s /c, with the path quoted and --help the only argument", () => {
    const path = "C:\\Program Files\\nodejs\\confluence.cmd";
    expect(helpInvocation(path, { platform: "win32", env: {} })).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\Program Files\\nodejs\\confluence.cmd" --help"'],
      windowsVerbatimArguments: true,
    });
    expect(helpInvocation("C:\\tools\\old.BAT", { platform: "win32", env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" } })).toEqual({
      file: "C:\\Windows\\system32\\cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\tools\\old.BAT" --help"'],
      windowsVerbatimArguments: true,
    });
  });

  it("starts anything else directly", () => {
    expect(helpInvocation("C:\\bin\\gh.exe", { platform: "win32", env: {} })).toEqual({ file: "C:\\bin\\gh.exe", args: ["--help"], windowsVerbatimArguments: false });
    expect(helpInvocation("/usr/bin/tool.cmd", { platform: "linux", env: {} })).toEqual({ file: "/usr/bin/tool.cmd", args: ["--help"], windowsVerbatimArguments: false });
  });
});

describe.skipIf(process.platform === "win32")("draftCliToolDescription for a Windows .cmd, through a stand-in cmd.exe (EO-858)", () => {
  // `ComSpec` names a POSIX stand-in for cmd.exe that records what it was
  // handed and runs the quoted command line as `/s` would leave it, so
  // the timeout, the cap and the kill are those of the real run.
  let windows: CliToolProbeOptions;
  beforeEach(() => {
    script("cmd.exe", `printf '%s\\n' "$@" > "${join(scratch, "cmd-argv")}"; line=\${4#\\"}; line=\${line%\\"}; eval "$line"`);
    // Found in the probe directory, which Windows looks in first: the
    // POSIX PATH the scripts need for `sleep` and `yes` is not one a
    // Windows lookup can split.
    windows = { platform: "win32", cwd: scratch, env: { ...onScratch.env, ComSpec: join(scratch, "cmd.exe") } };
  });

  it("runs the .cmd's --help through cmd.exe /d /s /c and drafts from it", async () => {
    script("acme.cmd", '[ "$1" = "--help" ] && echo "Work with Acme deployments from the command line."');
    expect(await draftCliToolDescription("acme", windows)).toEqual({ description: "Work with Acme deployments from the command line." });
    expect(readFileSync(join(scratch, "cmd-argv"), "utf8").split("\n").slice(0, 4)).toEqual(["/d", "/s", "/c", `""${join(scratch, "acme.cmd")}" --help"`]);
  });

  it("still stops at the timeout, and stops what the .cmd started", async () => {
    const pidFile = join(scratch, "descendant.pid");
    script("waits.cmd", `sleep 30 & echo $! > "${pidFile}"; wait`);
    const started = Date.now();
    expect(await draftCliToolDescription("waits", { ...windows, timeoutMs: 300 })).toEqual({ description: "" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await gone(Number(readFileSync(pidFile, "utf8")))).toBe(true);
  });

  it("still stops reading at the output cap", async () => {
    script("chatty.cmd", 'exec yes "this line repeats for ever and ever"');
    const started = Date.now();
    const draft = await draftCliToolDescription("chatty", { ...windows, timeoutMs: 10_000, maxOutputBytes: 4_096 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(draft.description.startsWith("this line repeats for ever and ever")).toBe(true);
  });
});

describe("agentSpawnSearchDirectories", () => {
  it("keeps an empty POSIX entry as the spawn directory, and an unset PATH as the default", () => {
    expect(agentSpawnSearchDirectories({ PATH: "/a::/b:" }, "linux")).toEqual(["/a", ".", "/b", "."]);
    expect(agentSpawnSearchDirectories({ PATH: "" }, "darwin")).toEqual(["."]);
    expect(agentSpawnSearchDirectories({}, "linux")).toEqual(["/usr/bin", "/bin"]);
  });

  it("reads Windows' PATH whatever its case", () => {
    expect(agentSpawnSearchDirectories({ Path: "C:\\a;;C:\\b" }, "win32")).toEqual(["C:\\a", "C:\\b"]);
  });
});

describe.skipIf(process.platform === "win32")("draftCliToolDescription", () => {
  it("drafts a short description from --help, and runs nothing else", async () => {
    script(
      "acme",
      [
        'if [ "$1" = "--help" ]; then',
        "  echo 'Work with Acme deployments from the command line. Lists, rolls back and promotes releases.'",
        "  echo 'Every command takes --env.'",
        "  echo ''",
        "  echo 'USAGE'",
        "  echo '  acme <command> [flags]'",
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
    );
    expect(await draftCliToolDescription("acme", onScratch)).toEqual({
      description: "Work with Acme deployments from the command line. Lists, rolls back and promotes releases.",
    });
  });

  it("runs the program without a shell, so nothing in its name or output is interpreted", async () => {
    // Were a shell involved, `$1` would arrive expanded or split; the
    // script sees exactly the one argument it was given.
    script("argv", 'echo "Received exactly $# argument, which was $1 here."');
    expect((await draftCliToolDescription("argv", onScratch)).description).toBe("Received exactly 1 argument, which was --help here.");
  });

  it("returns an empty draft, without throwing, for a command that hangs", async () => {
    script("hangs", "exec sleep 30");
    const started = Date.now();
    expect(await draftCliToolDescription("hangs", { ...onScratch, timeoutMs: 200 })).toEqual({ description: "" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("drafts nothing from a --help that failed, whose output is an error rather than a description", async () => {
    script("fails", 'echo "this program does not understand that flag at all" >&2; exit 2');
    expect(await draftCliToolDescription("fails", onScratch)).toEqual({ description: "" });
  });

  it("returns an empty draft, without throwing, for a command that does not exist", async () => {
    expect(await draftCliToolDescription("eo-no-such-cli", onScratch)).toEqual({ description: "" });
  });

  it("stops reading at the output cap, rather than at the timeout, for a program that never stops printing", async () => {
    script("chatty", 'exec yes "this line repeats for ever and ever"');
    const started = Date.now();
    const draft = await draftCliToolDescription("chatty", { ...onScratch, timeoutMs: 10_000, maxOutputBytes: 4_096 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(draft.description.length).toBeLessThanOrEqual(240);
    expect(draft.description.startsWith("this line repeats for ever and ever")).toBe(true);
  });

  it("at the cap, stops a wrapper's printing descendant too, not only the wrapper", async () => {
    // The wrapper does not exec: `yes` is its child, holding the same pipe.
    const pidFile = join(scratch, "descendant.pid");
    script("wrapper", `yes "a descendant that prints for ever" & echo $! > "${pidFile}"; wait`);
    const draft = await draftCliToolDescription("wrapper", { ...onScratch, timeoutMs: 10_000, maxOutputBytes: 4_096 });
    expect(draft.description.startsWith("a descendant that prints for ever")).toBe(true);
    expect(await gone(Number(readFileSync(pidFile, "utf8")))).toBe(true);
  });

  it("at the timeout, stops a wrapper's silent descendant too", async () => {
    const pidFile = join(scratch, "descendant.pid");
    script("waits", `sleep 30 & echo $! > "${pidFile}"; wait`);
    expect(await draftCliToolDescription("waits", { ...onScratch, timeoutMs: 300 })).toEqual({ description: "" });
    expect(await gone(Number(readFileSync(pidFile, "utf8")))).toBe(true);
  });
});

describe("describeFromHelp", () => {
  it("takes the opening sentence before the usage", () => {
    expect(describeFromHelp("Work seamlessly with GitHub from the command line.\n\nUSAGE\n  gh <command> <subcommand> [flags]\n")).toBe(
      "Work seamlessly with GitHub from the command line.",
    );
  });

  it("keeps the command's own spelling at the start of a sentence", () => {
    expect(describeFromHelp("kubectl controls the Kubernetes cluster manager.\n\n Find more information at: https://kubernetes.io\n")).toBe(
      "kubectl controls the Kubernetes cluster manager.",
    );
  });

  it("skips a usage line, a heading and options to reach the prose", () => {
    const help = "Usage: terraform [global options] <subcommand> [args]\n\nThe available commands for execution are listed below. The primary workflow commands are given first, followed by less common or more advanced commands.\n\nMain commands:\n  init  Prepare your working directory\n";
    expect(describeFromHelp(help)).toBe(
      "The available commands for execution are listed below. The primary workflow commands are given first, followed by less common or more advanced commands.",
    );
  });

  it("is empty when nothing reads as prose", () => {
    expect(describeFromHelp("usage: tool [-a] [-b]\n  -a  all\n  -b  brief\n")).toBe("");
    expect(describeFromHelp("")).toBe("");
    expect(describeFromHelp("error: unknown option '--help'\n")).toBe("");
  });

  it("strips colour codes and ends the sentence", () => {
    expect(describeFromHelp("\u001b[1mManage the Acme fleet from here\u001b[0m\n")).toBe("Manage the Acme fleet from here.");
  });
});
