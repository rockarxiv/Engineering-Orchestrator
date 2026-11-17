import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeFromHelp, detectCliTool, draftCliToolDescription, resolveCliToolPath } from "./cliTools.js";

/**
 * Whether a CLI is installed, and a description drafted from it (EO-819).
 *
 * The real lookup and real child processes: what is being promised is
 * what `spawn` without a shell does on this machine, which a stub would
 * only restate.
 */
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo-cli-tools-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A POSIX script on the scratch PATH, named `name`. */
function script(name: string, body: string): void {
  const path = join(scratch, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

const onScratch = { env: { PATH: "" } as NodeJS.ProcessEnv };
beforeEach(() => {
  // The scripts' own PATH too, so `sleep` and `yes` are found by them.
  onScratch.env = { PATH: `${scratch}${delimiter}${process.env["PATH"] ?? ""}` };
});

// Node itself, which is on every machine this suite runs on and answers
// `--version`: found on Windows too, where a shell script is not.
const node = basename(process.execPath).replace(/\.exe$/i, "");
const nodeEnv = { PATH: dirname(process.execPath) };

describe("detectCliTool", () => {
  it("reports found, with the absolute path and the version, for a command on the agent's PATH", async () => {
    const detection = await detectCliTool(node, { env: nodeEnv });
    expect(detection).toEqual({ found: true, path: process.execPath, version: process.version });
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
    expect(await detectCliTool(`${node} --version`, { env: nodeEnv })).toEqual({ found: false });
    expect(await detectCliTool("", { env: nodeEnv })).toEqual({ found: false });
  });

  it.skipIf(process.platform === "win32")("reports found with no version for a program that does not answer --version", async () => {
    script("quiet", 'echo "unknown flag: $1" >&2; exit 2');
    expect(await detectCliTool("quiet", onScratch)).toEqual({ found: true, path: join(scratch, "quiet"), version: null });
  });

  it.skipIf(process.platform === "win32")("skips a file of that name that is not executable", async () => {
    writeFileSync(join(scratch, "plain"), "#!/bin/sh\necho hi\n");
    expect(await detectCliTool("plain", onScratch)).toEqual({ found: false });
  });
});

describe.skipIf(process.platform === "win32")("draftCliToolDescription", () => {
  it("drafts a short description from --help, and reads the version", async () => {
    script(
      "acme",
      [
        'if [ "$1" = "--version" ]; then echo "acme version 2.4.1"; exit 0; fi',
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
      version: "acme version 2.4.1",
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
    expect(await draftCliToolDescription("hangs", { ...onScratch, timeoutMs: 200 })).toEqual({ version: null, description: "" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("drafts nothing from a --help that failed, whose output is an error rather than a description", async () => {
    script("fails", 'echo "this program does not understand that flag at all" >&2; exit 2');
    expect(await draftCliToolDescription("fails", onScratch)).toEqual({ version: null, description: "" });
  });

  it("returns an empty draft, without throwing, for a command that does not exist", async () => {
    expect(await draftCliToolDescription("eo-no-such-cli", onScratch)).toEqual({ version: null, description: "" });
  });

  it("stops reading at the output cap, rather than at the timeout, for a program that never stops printing", async () => {
    script("chatty", '[ "$1" = "--version" ] && exit 1; exec yes "this line repeats for ever and ever"');
    const started = Date.now();
    const draft = await draftCliToolDescription("chatty", { ...onScratch, timeoutMs: 10_000, maxOutputBytes: 4_096 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(draft.description.length).toBeLessThanOrEqual(240);
    expect(draft.description.startsWith("this line repeats for ever and ever")).toBe(true);
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

  it("does not take the version line for a description", () => {
    expect(describeFromHelp("acme version 2.4.1\n", "acme version 2.4.1")).toBe("");
  });

  it("strips colour codes and ends the sentence", () => {
    expect(describeFromHelp("\u001b[1mManage the Acme fleet from here\u001b[0m\n")).toBe("Manage the Acme fleet from here.");
  });
});
