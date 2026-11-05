/**
 * Values in a module that only hold on the machine it was written on
 * (EO-449).
 *
 * A module, its manifest and its test cases are meant to travel: exported
 * to another installation, imported from a pack, published by an
 * organisation. A path under somebody's home directory, a Windows drive
 * path, a loopback address or a shell one OS has and another does not
 * travels with it and breaks there — often on a branch nobody's tests
 * reached. This says so while the author is still looking.
 *
 * A text scan, beside `portabilityWarnings` and for the same reasons: it
 * lives in `core` so the main process (what is saved) and the module
 * editor (the draft in the textarea, on every keystroke) read the same
 * text the same way, and it is advice, never a gate. Nothing about
 * saving, approving or running a module waits on it.
 *
 * The same scan reads the other things that are shared (EO-450): a
 * pipeline step's name, instructions summary and text inputs, an agent's
 * instructions and a skill's body. Each warning says which of those it
 * is in, and what to use there instead — the step's working directory, a
 * step input, a declared environment variable or secret, something read
 * while the step runs.
 *
 * ## Why a list of machine roots rather than every absolute path
 *
 * Module code legitimately holds absolute paths that are not anybody's
 * machine: a forge API path (`/repos/{owner}/{repo}/pulls`), a URL's
 * path, a path inside the step's own worktree. Flagging every leading
 * `/` would bury the one warning that matters under those. So it matches
 * the roots that only make sense on one machine — home directories,
 * temporary directories, a package manager's prefix — and leaves the
 * rest alone. Paths inside a URL are skipped too (`https://example.com/home/docs`
 * is a web page, not a home directory), except under `file://`, which is
 * exactly a path on one machine.
 *
 * ## Why a test case's scripted output is skipped
 *
 * A case scripts what `ctx.exec` answers — `stderr: "fatal: 'main' is
 * already checked out at '/home/dev/app'"` — and that text is fake
 * output the module parses, not a file anything reads. Text after
 * `stdout:` or `stderr:` on the same line is left out of the scan.
 */

import type { MachineSpecificKind, MachineSpecificPlace, MachineSpecificWarning } from "./schemas/modules.js";

/** The kinds a scan of free text reports. The other two are a manifest's alone. */
export type MachineSpecificTextKind = Exclude<MachineSpecificKind, "absolute_binary" | "shell_binary">;

/** One value in a piece of text that looks like it only holds on one machine. */
export interface MachineSpecificMatch {
  /** 1-based. */
  line: number;
  /** What matched, verbatim. */
  text: string;
  kind: MachineSpecificTextKind;
}

/** The rest of a path once its root has matched: up to whitespace, a quote, or punctuation that ends a token. */
const TAIL = String.raw`[^\s"'\x60<>()\[\]{},;|]*`;

/**
 * Roots that only hold on one machine. `/usr/local/` and
 * `/opt/homebrew/` are a package manager's prefix, which differs between
 * an Intel Mac, an Apple Silicon Mac and Linux; `/var/folders/` is
 * macOS's per-user temporary directory.
 */
const MACHINE_ROOTS = ["/home/", "/Users/", "/root/", "/tmp/", "/var/folders/", "/opt/homebrew/", "/usr/local/"];

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Each kind's pattern, and whether it is read with URLs blanked out.
 *
 * A loopback address is read with them in, because `http://localhost:3000`
 * is the commonest way to write one. Everything else is a path, and a
 * path inside a URL is a web page's.
 */
const PATTERNS: readonly { kind: MachineSpecificTextKind; pattern: RegExp; outsideUrls: boolean }[] = [
  {
    kind: "machine_path",
    // Not preceded by a character that would make it the middle of a
    // longer path or word: `src/home/x` is a relative path.
    pattern: new RegExp(String.raw`(?<![\w.\-/~$%\\])(?:${MACHINE_ROOTS.map(escape).join("|")})${TAIL}`, "g"),
    outsideUrls: true,
  },
  {
    kind: "windows_path",
    // `C:\`, `C:\\` (as a JS string spells it) or `C:/`. A word character
    // before the letter is how `https:/` stays out; a slash before it is
    // allowed, for `file:///C:/…`.
    pattern: new RegExp(String.raw`(?<![\w\\])[A-Za-z]:(?:\\|/)${TAIL}`, "g"),
    outsideUrls: true,
  },
  {
    kind: "unc_path",
    // `\\host\share`, or `\\\\host\\share` as a JS string spells it.
    pattern: new RegExp(String.raw`(?<![\w\\])(?:\\\\){1,2}[\w.$-]+(?:\\){1,2}[\w.$-]+${TAIL}`, "g"),
    outsideUrls: true,
  },
  {
    kind: "home_reference",
    pattern: new RegExp(String.raw`(?<![\w~])~/${TAIL}|(?:\$HOME(?!\w)|\$\{HOME\}|%USERPROFILE%|%APPDATA%)(?:[\\/]${TAIL})?`, "gi"),
    outsideUrls: true,
  },
  {
    kind: "loopback",
    pattern: /(?<![\w.\-\])])(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?![\w-])/g,
    outsideUrls: false,
  },
];

/** A URL, other than `file://` — its path is a web page's, not a machine's. */
const URL_PATTERN = /\b(?!file:)[a-z][a-z0-9+.-]*:\/\/[^\s"'\x60<>]*/gi;

/**
 * The scheme of a `file://` URL, blanked so the path after it reads as
 * one: `file:///home/dev` is a path on one machine, and the slash before
 * `/home/` would otherwise make it the middle of a longer one.
 */
const FILE_SCHEME = /\bfile:\/\//gi;

/** The same text with every match of `pattern` replaced by spaces, so offsets and line numbers still hold. */
function blank(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => match.replace(/[^\n]/g, " "));
}

/**
 * Every value in `text` that looks like it only holds on one machine,
 * in the order they appear.
 *
 * Over-eager on purpose, in the way `portabilityWarnings` is: a value a
 * person has to glance at and dismiss costs a moment, and one that goes
 * unreported costs a run on somebody else's machine.
 *
 * Two matches over the same characters are one — `C:/Users/dev` is a
 * Windows path, not a Windows path and a home directory.
 */
export function machineSpecificValues(text: string): MachineSpecificMatch[] {
  const outsideUrls = blank(blank(text, URL_PATTERN), FILE_SCHEME);
  const found: { start: number; end: number; kind: MachineSpecificTextKind }[] = [];
  for (const { kind, pattern, outsideUrls: skipUrls } of PATTERNS) {
    for (const match of (skipUrls ? outsideUrls : text).matchAll(pattern)) {
      if (match[0].length === 0) continue;
      found.push({ start: match.index, end: match.index + match[0].length, kind });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);

  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  // `found` is in order, so the line only ever moves forward.
  let line = 0;
  const lineOf = (offset: number): number => {
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= offset) line++;
    return line + 1;
  };

  const matches: MachineSpecificMatch[] = [];
  let reached = -1;
  for (const each of found) {
    if (each.start < reached) continue;
    reached = each.end;
    matches.push({ line: lineOf(each.start), text: text.slice(each.start, each.end), kind: each.kind });
  }
  return matches;
}

/**
 * A test case's source with scripted output blanked: everything after
 * `stdout:` or `stderr:` (or `"stdout":`) on the same line. That is what
 * the case makes `ctx.exec` answer, not a file anything reads.
 */
function withoutScriptedOutput(source: string): string {
  return source.replace(/\b(?:stdout|stderr)\b["']?\s*:([^\n]*)/g, (match, rest: string) => match.slice(0, match.length - rest.length) + " ".repeat(rest.length));
}

/** The shells a `needs.bin` entry is reported for: each is missing from, or different on, some OS. */
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "cmd", "powershell", "pwsh"]);

/** `/usr/bin/git`, `~/bin/x`, `C:\tools\x.exe`, `\\host\share\x`. */
const ABSOLUTE_BINARY = /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/;

/** What to use instead, for this kind of value in this part of a module. */
function insteadFor(kind: MachineSpecificKind, place: MachineSpecificPlace["in"]): string {
  if (place === "step") return insteadInStep(kind, false);
  if (place === "instructions" || place === "skill") return insteadInProse(kind);
  // A test case's working directory is `harness.cwd`; the module's is `ctx.cwd`.
  const cwd = place === "test" ? "harness.cwd" : "ctx.cwd";
  switch (kind) {
    case "machine_path":
    case "windows_path":
    case "unc_path":
      return `use ${cwd} for the step's working directory, or take the path as a step input`;
    case "home_reference":
      return `use ${cwd}, a step input, or a declared environment variable`;
    case "loopback":
      return "take the address as a step input, or a declared environment variable or secret";
    case "absolute_binary":
      return 'name the binary on PATH — "git", not "/usr/bin/git"';
    case "shell_binary":
      return "run the program you need directly, named on PATH";
  }
}

/**
 * What to use instead, in a pipeline step's field (EO-450).
 *
 * A step input is the answer for a name or a summary, and not for an
 * input — the value is already one, and what makes it travel is that
 * the installation it lands on supplies it rather than the pipeline.
 */
function insteadInStep(kind: MachineSpecificKind, input: boolean): string {
  switch (kind) {
    case "loopback":
      return input
        ? "leave the address to a declared environment variable or secret each installation sets"
        : "take the address as a step input, or a declared environment variable or secret";
    default:
      return input
        ? "leave it to a declared environment variable or secret each installation sets, or to something the step reads while it runs"
        : "take it as a step input, or have the step read it while it runs — its working directory is the step's own";
  }
}

/**
 * What to use instead, in prose an agent reads: its instructions or a
 * skill's body (EO-450). The agent runs wherever the step does, so it is
 * told where to find the value rather than what the value was here.
 */
function insteadInProse(kind: MachineSpecificKind): string {
  switch (kind) {
    case "loopback":
      return "name a step input or a declared environment variable or secret that holds the address";
    default:
      return "refer to the step's working directory, or to a step input or declared environment variable the agent reads while it runs";
  }
}

/** What a kind of value is, in a few words. */
const WHAT: Record<MachineSpecificKind, string> = {
  machine_path: "a path that only exists on one machine",
  windows_path: "a Windows drive path",
  unc_path: "a Windows network share",
  home_reference: "somebody's home directory",
  loopback: "a loopback address",
  absolute_binary: "a binary named by absolute path",
  shell_binary: "a shell that is not the same, or not there, on every OS",
};

/** Machine-specific values in a module's code. */
export function codeMachineSpecificWarnings(code: string): MachineSpecificWarning[] {
  return machineSpecificValues(code).map(({ line, text, kind }) => ({ where: { in: "code", line }, text, kind, instead: insteadFor(kind, "code") }));
}

/**
 * Machine-specific values in a module's manifest: a `needs.bin` entry
 * that names a binary by absolute path, or that is a shell. Both name
 * the entry.
 */
export function manifestMachineSpecificWarnings(manifest: { needs?: { bin?: readonly string[] } }): MachineSpecificWarning[] {
  const warnings: MachineSpecificWarning[] = [];
  for (const bin of manifest.needs?.bin ?? []) {
    const entry = `needs.bin "${bin}"`;
    if (ABSOLUTE_BINARY.test(bin)) warnings.push({ where: { in: "manifest", entry }, text: bin, kind: "absolute_binary", instead: insteadFor("absolute_binary", "manifest") });
    const base = (bin.split(/[\\/]/).pop() ?? bin).toLowerCase().replace(/\.exe$/, "");
    if (SHELLS.has(base)) warnings.push({ where: { in: "manifest", entry }, text: bin, kind: "shell_binary", instead: insteadFor("shell_binary", "manifest") });
  }
  return warnings;
}

/** Machine-specific values in one test case's source, leaving out the output it scripts. */
export function testCaseMachineSpecificWarnings(test: { description: string; source: string }): MachineSpecificWarning[] {
  return machineSpecificValues(withoutScriptedOutput(test.source)).map(({ line, text, kind }) => ({
    where: { in: "test", description: test.description, line },
    text,
    kind,
    instead: insteadFor(kind, "test"),
  }));
}

/** Every machine-specific value in a module: its code, then its manifest, then each test case in order. */
export function moduleMachineSpecificWarnings(module: {
  code: string;
  manifest: { needs?: { bin?: readonly string[] } };
  tests?: readonly { description: string; source: string }[];
}): MachineSpecificWarning[] {
  return [
    ...codeMachineSpecificWarnings(module.code),
    ...manifestMachineSpecificWarnings(module.manifest),
    ...(module.tests ?? []).flatMap((test) => testCaseMachineSpecificWarnings(test)),
  ];
}

/**
 * Machine-specific values in one pipeline step (EO-450): its name, its
 * instructions summary, and each input whose value is text. A number or
 * a switch holds the same everywhere.
 *
 * A repository convention — a default branch of `main`, a workflow's
 * file name — is not reported, because the scan does not match it: as a
 * step input it is a value another installation can override.
 */
export function pipelineStepMachineSpecificWarnings(step: {
  name: string;
  instructionsSummary?: string | null;
  inputs?: Readonly<Record<string, unknown>>;
}): MachineSpecificWarning[] {
  const fields: { field: string; value: string; input: boolean }[] = [{ field: "name", value: step.name, input: false }];
  if (step.instructionsSummary) fields.push({ field: "instructions summary", value: step.instructionsSummary, input: false });
  for (const [key, value] of Object.entries(step.inputs ?? {})) {
    if (typeof value === "string") fields.push({ field: `input "${key}"`, value, input: true });
  }
  return fields.flatMap(({ field, value, input }) => {
    const multiline = value.includes("\n");
    return machineSpecificValues(value).map(({ line, text, kind }) => ({
      where: { in: "step" as const, step: step.name, field, line: multiline ? line : null },
      text,
      kind,
      instead: insteadInStep(kind, input),
    }));
  });
}

/** Machine-specific values in every step of a pipeline, in the order the steps are given. */
export function pipelineMachineSpecificWarnings(
  steps: readonly { name: string; instructionsSummary?: string | null; inputs?: Readonly<Record<string, unknown>> }[],
): MachineSpecificWarning[] {
  return steps.flatMap((step) => pipelineStepMachineSpecificWarnings(step));
}

/**
 * Machine-specific values in an agent's instructions, by line (EO-450).
 *
 * `shipped` is the instructions EO ships for the agent's role, where it
 * ships any. A line found verbatim in them is EO's own text rather than
 * the person's, and is left out: the system agent's prompt names
 * `/home/…` and `localhost:5173` as what *not* to write, and an editor
 * that warned about that on every built-in agent would teach a person to
 * stop reading the warning. A line they changed is read like any other.
 */
export function instructionsMachineSpecificWarnings(instructions: string, shipped: string | null = null): MachineSpecificWarning[] {
  const theirs = shipped === null ? null : new Set(shipped.split("\n").map((line) => line.trim()));
  const lines = theirs === null ? [] : instructions.split("\n");
  return machineSpecificValues(instructions)
    .filter(({ line }) => theirs === null || !theirs.has((lines[line - 1] ?? "").trim()))
    .map(({ line, text, kind }) => ({ where: { in: "instructions", line }, text, kind, instead: insteadFor(kind, "instructions") }));
}

/** Machine-specific values in a skill's body, by line (EO-450). */
export function skillMachineSpecificWarnings(body: string): MachineSpecificWarning[] {
  return machineSpecificValues(body).map(({ line, text, kind }) => ({ where: { in: "skill", line }, text, kind, instead: insteadFor(kind, "skill") }));
}

/**
 * Where a warning is, as an author would look for it: `code line 4`,
 * `manifest needs.bin "bash"`, `test case "fails cleanly" line 7`,
 * `step "Build" input "outDir"`, `instructions line 12`, `skill body line 3`.
 */
export function describeMachineSpecificPlace(where: MachineSpecificPlace): string {
  switch (where.in) {
    case "code":
      return `code line ${where.line}`;
    case "manifest":
      return `manifest ${where.entry}`;
    case "test":
      return `test case "${where.description}" line ${where.line}`;
    case "step": {
      const step = where.step.trim() === "" ? "an unnamed step" : `step "${where.step}"`;
      return `${step} ${where.field}${where.line === null ? "" : ` line ${where.line}`}`;
    }
    case "instructions":
      return `instructions line ${where.line}`;
    case "skill":
      return `skill body line ${where.line}`;
  }
}

/** One warning as a sentence: where, what matched, what it is, and what to use instead. */
export function describeMachineSpecificWarning(warning: MachineSpecificWarning): string {
  return `${describeMachineSpecificPlace(warning.where)}: "${warning.text}" is ${WHAT[warning.kind]} — ${warning.instead}.`;
}
