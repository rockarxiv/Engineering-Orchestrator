import { describe, expect, it } from "vitest";
import {
  codeMachineSpecificWarnings,
  describeMachineSpecificPlace,
  instructionsMachineSpecificWarnings,
  pipelineMachineSpecificWarnings,
  pipelineStepMachineSpecificWarnings,
  skillMachineSpecificWarnings,
  describeMachineSpecificWarning,
  machineSpecificValues,
  manifestMachineSpecificWarnings,
  moduleMachineSpecificWarnings,
  testCaseMachineSpecificWarnings,
} from "./machineSpecific.js";

/**
 * Values that only hold on the machine a module was written on (EO-449).
 *
 * Each kind is pinned, and so is what it deliberately leaves alone: a
 * URL's path, a forge API path, the output a test case scripts. Like
 * `portabilityWarnings` it is advice and allowed to be over-eager — but
 * not about the things a module legitimately holds every day.
 */
describe("machineSpecificValues", () => {
  it("finds nothing in text that holds anywhere", () => {
    const code = [
      'const out = await ctx.exec("git", ["status"], { cwd: ctx.cwd });',
      'const api = `/repos/${owner}/${repo}/pulls`;',
      'const file = "src/home/index.ts";',
      'const rel = "./tmp/out.txt";',
    ].join("\n");
    expect(machineSpecificValues(code)).toEqual([]);
  });

  it.each([
    ["/home/dev/app", "/home/dev/app"],
    ["/Users/dev/Projects/app", "/Users/dev/Projects/app"],
    ["/root/.ssh/id_rsa", "/root/.ssh/id_rsa"],
    ["/tmp/build/out.txt", "/tmp/build/out.txt"],
    ["/var/folders/xy/T/run", "/var/folders/xy/T/run"],
    ["/opt/homebrew/bin/gh", "/opt/homebrew/bin/gh"],
    ["/usr/local/bin/node", "/usr/local/bin/node"],
  ])("reports a path under a machine root: %s", (path, text) => {
    expect(machineSpecificValues(`const where = "${path}";`)).toEqual([{ line: 1, text, kind: "machine_path" }]);
  });

  it("reports the 1-based line and stops the path at a quote", () => {
    expect(machineSpecificValues(`// first\n\nawait fs.readFile('/home/dev/notes.md', "utf8");`)).toEqual([{ line: 3, text: "/home/dev/notes.md", kind: "machine_path" }]);
  });

  it("reports a path in a PATH-style list", () => {
    expect(machineSpecificValues("PATH=/usr/bin:/opt/homebrew/bin").map((match) => match.text)).toEqual(["/opt/homebrew/bin"]);
  });

  it.each([
    ["C:\\Users\\dev\\app", "C:\\Users\\dev\\app"],
    ["C:\\\\Users\\\\dev", "C:\\\\Users\\\\dev"],
    ["D:/work/app", "D:/work/app"],
  ])("reports a Windows drive path: %s", (path, text) => {
    expect(machineSpecificValues(`const where = "${path}";`)).toEqual([{ line: 1, text, kind: "windows_path" }]);
  });

  it("reports a drive path once, not again as the home directory inside it", () => {
    expect(machineSpecificValues('"C:/Users/dev"')).toEqual([{ line: 1, text: "C:/Users/dev", kind: "windows_path" }]);
  });

  it.each([
    ["\\\\fileserver\\share\\builds", "\\\\fileserver\\share\\builds"],
    ["\\\\\\\\fileserver\\\\share", "\\\\\\\\fileserver\\\\share"],
  ])("reports a UNC path: %s", (path, text) => {
    expect(machineSpecificValues(`const where = "${path}";`)).toEqual([{ line: 1, text, kind: "unc_path" }]);
  });

  it.each([
    ["~/", "~/.config/gh/hosts.yml", "~/.config/gh/hosts.yml"],
    ["$HOME", "$HOME/.npmrc", "$HOME/.npmrc"],
    ["${HOME}", "${HOME}", "${HOME}"],
    ["%USERPROFILE%", "%USERPROFILE%\\.gitconfig", "%USERPROFILE%\\.gitconfig"],
    ["%APPDATA%", "%APPDATA%", "%APPDATA%"],
  ])("reports a home reference: %s", (_name, value, text) => {
    expect(machineSpecificValues(`const where = "${value}";`)).toEqual([{ line: 1, text, kind: "home_reference" }]);
  });

  it.each([
    ["localhost", "localhost"],
    ["localhost:3000", "localhost:3000"],
    ["127.0.0.1", "127.0.0.1"],
    ["127.0.0.1:8080", "127.0.0.1:8080"],
    ["0.0.0.0", "0.0.0.0"],
    ["0.0.0.0:9000", "0.0.0.0:9000"],
    ["[::1]", "[::1]"],
    ["[::1]:5432", "[::1]:5432"],
  ])("reports a loopback address: %s", (value, text) => {
    expect(machineSpecificValues(`const host = "${value}";`)).toEqual([{ line: 1, text, kind: "loopback" }]);
  });

  it("reports a loopback address inside a URL", () => {
    expect(machineSpecificValues('await fetch("http://localhost:3000/home/api");')).toEqual([{ line: 1, text: "localhost:3000", kind: "loopback" }]);
  });

  it("does not read 127.0.0.10 or isLocalhost as loopback", () => {
    expect(machineSpecificValues('const a = "127.0.0.10"; isLocalhost(a); localhostish();')).toEqual([]);
  });

  it("does not report a path inside a URL", () => {
    expect(machineSpecificValues('const docs = "https://example.com/home/docs";')).toEqual([]);
    expect(machineSpecificValues("see https://api.github.com/Users/tmp/ and http://x.test/C:/y")).toEqual([]);
  });

  it("reports a path inside a file:// URL", () => {
    expect(machineSpecificValues('"file:///home/dev/report.html"')).toEqual([{ line: 1, text: "/home/dev/report.html", kind: "machine_path" }]);
  });

  it("reports several values in order", () => {
    const text = 'a("/tmp/x");\nb("localhost", "~/y");';
    expect(machineSpecificValues(text)).toEqual([
      { line: 1, text: "/tmp/x", kind: "machine_path" },
      { line: 2, text: "localhost", kind: "loopback" },
      { line: 2, text: "~/y", kind: "home_reference" },
    ]);
  });
});

describe("manifestMachineSpecificWarnings", () => {
  it("says nothing about binaries named on PATH", () => {
    expect(manifestMachineSpecificWarnings({ needs: { bin: ["git", "gh", "node"] } })).toEqual([]);
    expect(manifestMachineSpecificWarnings({})).toEqual([]);
  });

  it("reports an entry that is an absolute path, naming it", () => {
    const warnings = manifestMachineSpecificWarnings({ needs: { bin: ["git", "/usr/bin/gh", "C:\\tools\\jq.exe"] } });
    expect(warnings.map((warning) => [warning.where, warning.kind])).toEqual([
      [{ in: "manifest", entry: 'needs.bin "/usr/bin/gh"' }, "absolute_binary"],
      [{ in: "manifest", entry: 'needs.bin "C:\\tools\\jq.exe"' }, "absolute_binary"],
    ]);
    expect(warnings[0]!.instead).toContain("on PATH");
  });

  it.each(["sh", "bash", "zsh", "fish", "cmd", "powershell", "pwsh", "cmd.exe"])("reports the shell %s, naming it", (shell) => {
    expect(manifestMachineSpecificWarnings({ needs: { bin: [shell] } })).toEqual([
      { where: { in: "manifest", entry: `needs.bin "${shell}"` }, text: shell, kind: "shell_binary", instead: expect.stringContaining("on PATH") },
    ]);
  });

  it("reports a shell named by absolute path as both", () => {
    expect(manifestMachineSpecificWarnings({ needs: { bin: ["/bin/bash"] } }).map((warning) => warning.kind)).toEqual(["absolute_binary", "shell_binary"]);
  });
});

describe("testCaseMachineSpecificWarnings", () => {
  it("skips what a case scripts as stderr", () => {
    const source = [
      "export default async function (harness) {",
      "  const result = await harness.run({ exec: [{ bin: \"git\", args: [\"worktree\", \"add\"], code: 128,",
      "    stderr: \"fatal: 'main' is already checked out at '/home/dev/app'\" }] });",
      "}",
    ].join("\n");
    expect(testCaseMachineSpecificWarnings({ description: "reports a checked-out branch", source })).toEqual([]);
  });

  it("skips what a case scripts as stdout, quoted key or not", () => {
    const source = ['{ stdout: "/Users/dev/app\\n" }', '{ "stdout": "C:\\\\work" }', "{ stderr : `localhost:3000 refused` }"].join("\n");
    expect(testCaseMachineSpecificWarnings({ description: "x", source })).toEqual([]);
  });

  it("still reports what comes before the scripted output on the line, and on other lines", () => {
    const source = ['{ args: ["/tmp/repo"], stdout: "/home/dev" }', 'await fs.writeFile("/home/dev/out.txt", "x");'].join("\n");
    expect(testCaseMachineSpecificWarnings({ description: "writes a file", source })).toEqual([
      { where: { in: "test", description: "writes a file", line: 1 }, text: "/tmp/repo", kind: "machine_path", instead: expect.stringContaining("harness.cwd") },
      { where: { in: "test", description: "writes a file", line: 2 }, text: "/home/dev/out.txt", kind: "machine_path", instead: expect.stringContaining("harness.cwd") },
    ]);
  });
});

describe("module warnings", () => {
  it("names where each one is and what to use instead", () => {
    const warnings = moduleMachineSpecificWarnings({
      code: 'export default async function run(ctx) {\n  await ctx.exec("bash", ["-c", "ls /home/dev"]);\n  await fetch("http://127.0.0.1:8080");\n}',
      manifest: { needs: { bin: ["bash"] } },
      tests: [{ description: "lists the home directory", source: 'export default async (harness) => {\n  await harness.run({ inputs: { dir: "$HOME" } });\n};' }],
    });
    expect(warnings.map(describeMachineSpecificWarning)).toEqual([
      'code line 2: "/home/dev" is a path that only exists on one machine — use ctx.cwd for the step\'s working directory, or take the path as a step input.',
      'code line 3: "127.0.0.1:8080" is a loopback address — take the address as a step input, or a declared environment variable or secret.',
      'manifest needs.bin "bash": "bash" is a shell that is not the same, or not there, on every OS — run the program you need directly, named on PATH.',
      'test case "lists the home directory" line 2: "$HOME" is somebody\'s home directory — use harness.cwd, a step input, or a declared environment variable.',
    ]);
  });

  it("each kind says what to use instead", () => {
    const code = ['"/home/a"', '"C:/a"', '"\\\\h\\s"', '"~/a"', '"localhost"'].join("\n");
    for (const warning of codeMachineSpecificWarnings(code)) {
      expect(warning.instead).toMatch(/ctx\.cwd|step input|environment variable|secret|on PATH/);
    }
    expect(codeMachineSpecificWarnings(code)).toHaveLength(5);
  });
});

/**
 * The other things that are shared (EO-450): a pipeline step's fields,
 * an agent's instructions, a skill's body. The same scan, with each
 * warning naming the field or line and what to use there instead.
 */
describe("pipelineStepMachineSpecificWarnings", () => {
  it("reports the name, the instructions summary and each text input, naming the field", () => {
    const warnings = pipelineStepMachineSpecificWarnings({
      name: "Copy to /tmp/out",
      instructionsSummary: "Build the app.\nThen open http://localhost:3000 and check it.",
      inputs: { repoPath: "/Users/dev/app", retries: 3, dryRun: true, branch: "main" },
    });
    expect(warnings.map((warning) => [warning.where, warning.text, warning.kind])).toEqual([
      [{ in: "step", step: "Copy to /tmp/out", field: "name", line: null }, "/tmp/out", "machine_path"],
      [{ in: "step", step: "Copy to /tmp/out", field: "instructions summary", line: 2 }, "localhost:3000", "loopback"],
      [{ in: "step", step: "Copy to /tmp/out", field: 'input "repoPath"', line: null }, "/Users/dev/app", "machine_path"],
    ]);
  });

  it("leaves a repository convention held as a step input alone", () => {
    expect(pipelineStepMachineSpecificWarnings({ name: "Release", instructionsSummary: null, inputs: { branch: "main", workflow: ".github/workflows/ci.yml" } })).toEqual([]);
  });

  it("says where it is and what to use instead, differently for a summary and an input", () => {
    const [summary, input] = pipelineStepMachineSpecificWarnings({ name: "Build", instructionsSummary: "Write to ~/out", inputs: { outDir: "C:\\build" } });
    expect(describeMachineSpecificWarning(summary!)).toMatch(/^step "Build" instructions summary: "~\/out" is somebody's home directory — take it as a step input/);
    expect(describeMachineSpecificWarning(input!)).toMatch(/^step "Build" input "outDir": "C:\\build" is a Windows drive path — leave it to a declared environment variable or secret/);
  });

  it("reads every step of a pipeline in order", () => {
    const warnings = pipelineMachineSpecificWarnings([
      { name: "A", instructionsSummary: "uses $HOME/x" },
      { name: "B", instructionsSummary: null },
      { name: "C", inputs: { url: "http://127.0.0.1:8080" } },
    ]);
    expect(warnings.map((warning) => describeMachineSpecificPlace(warning.where))).toEqual(['step "A" instructions summary', 'step "C" input "url"']);
  });
});

describe("instructionsMachineSpecificWarnings and skillMachineSpecificWarnings", () => {
  it("names the line of an agent's instructions", () => {
    const warnings = instructionsMachineSpecificWarnings("You are the implementer.\n\nThe repo is at /home/dev/app.");
    expect(warnings).toHaveLength(1);
    expect(describeMachineSpecificWarning(warnings[0]!)).toBe(
      'instructions line 3: "/home/dev/app." is a path that only exists on one machine — refer to the step\'s working directory, or to a step input or declared environment variable the agent reads while it runs.',
    );
  });

  it("leaves out a line EO ships for the role, and reads one the person changed", () => {
    const shipped = "Never write in:\n\n- Absolute paths — `/home/…`, `C:\\…`.\n- Local ports — `localhost:5173`.";
    expect(instructionsMachineSpecificWarnings(shipped, shipped)).toEqual([]);

    const edited = `${shipped}\n\nOur checkout is at /Users/dev/app.`;
    expect(instructionsMachineSpecificWarnings(edited, shipped).map((warning) => [warning.where, warning.text])).toEqual([
      [{ in: "instructions", line: 6 }, "/Users/dev/app."],
    ]);
    // Without the shipped text, every line is the person's.
    expect(instructionsMachineSpecificWarnings(edited)).toHaveLength(4);
  });

  it("names the line of a skill's body", () => {
    const warnings = skillMachineSpecificWarnings("# Deploy\nCall http://localhost:8080/deploy.");
    expect(warnings.map((warning) => [describeMachineSpecificPlace(warning.where), warning.kind])).toEqual([["skill body line 2", "loopback"]]);
    expect(warnings[0]!.instead).toMatch(/declared environment variable or secret/);
  });

  it("finds nothing in prose that holds anywhere", () => {
    expect(instructionsMachineSpecificWarnings("Read the item with mcp__eo__item_detail and work in the current directory.")).toEqual([]);
    expect(skillMachineSpecificWarnings("See https://example.com/home/docs for the API.")).toEqual([]);
  });
});
