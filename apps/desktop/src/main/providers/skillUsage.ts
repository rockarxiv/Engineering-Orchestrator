import type { AgentEvent, InterruptibleStream } from "@eo/core";
import { TOOL_PLUGIN_NAME } from "../agentAttachments/pluginDirectory.js";
import { WORKTREE_SKILLS_PATH } from "../agentAttachments/worktreeSkills.js";

/**
 * What each adapter reports about EO's skills on a turn (EO-715): which
 * it delivered, and which the agent loaded — read off what the backend
 * did, never off what the agent says (invariant 5).
 *
 * Both detectors live here, side by side, because the two backends load
 * a skill in different ways and parity is easier to keep when the two
 * readings can be seen together (invariant 12). Each adapter calls its
 * own; `providerParity.test.ts` holds both to one observation.
 */

/** The turn's `skills_delivered` event, or nothing for a turn given no skill. */
export function skillsOffered(slugs: readonly string[]): AgentEvent[] {
  return slugs.length === 0 ? [] : [{ type: "skills_delivered", slugs: [...new Set(slugs)].sort() }];
}

/**
 * Claude: a `Skill` call naming one of EO's skills — `eo-attachments:<slug>`
 * — loads it. A skill under any other name is not EO's to count: one from
 * the person's own setup, on an agent that inherits it.
 */
export function claudeSkillLoaded(name: string, input: unknown): AgentEvent[] {
  if (name !== "Skill" || typeof input !== "object" || input === null) return [];
  const skill = (input as { skill?: unknown }).skill;
  const prefix = `${TOOL_PLUGIN_NAME}:`;
  if (typeof skill !== "string" || !skill.startsWith(prefix)) return [];
  const slug = skill.slice(prefix.length);
  return slug === "" ? [] : [{ type: "skill_loaded", slug }];
}

/**
 * Exactly a skill's `SKILL.md` in the worktree's `.agent/skills`, relative
 * (`./` or not) or under an absolute path — the whole of one argument or
 * one read action's path, never a path that merely contains it, so
 * `SKILL.md.bak` and `foo.agent/skills/…` are not it.
 */
const SKILL_FILE = new RegExp(`^(?:.*/)?${WORKTREE_SKILLS_PATH.replace(".", "\\.")}/([a-z0-9]+(?:-[a-z0-9]+)*)/SKILL\\.md$`);

/**
 * How one reading command takes its arguments, so a file operand can be
 * told from an option's value, a script or a pattern.
 *
 * - `valued`: the options that take a value — the next word, or the rest
 *   of the word (`-n40`, `--lines=40`). Every other option is a flag.
 * - `script`: the first operand is a script or a pattern, not a file,
 *   unless one of `scriptOptions` supplied it (`sed -e`, `grep -f`).
 * - `noRead`: options under which the command reads no file at all —
 *   help, version, or listing files rather than their contents.
 * - `edits`: options that make it write the file rather than read it.
 */
interface ReaderSpec {
  valued: readonly string[];
  script?: boolean;
  scriptOptions?: readonly string[];
  noRead?: readonly string[];
  edits?: readonly string[];
}

const NO_READ = ["--help", "--version"];

const GREP: ReaderSpec = {
  valued: ["-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D", "--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--label", "--include", "--exclude", "--exclude-dir", "--exclude-from", "--devices", "--directories", "--binary-files", "--group-separator"],
  script: true,
  scriptOptions: ["-e", "-f", "--regexp", "--file"],
  noRead: ["-V"],
};

/** The commands whose file operands they read. */
const READERS: ReadonlyMap<string, ReaderSpec> = new Map<string, ReaderSpec>([
  ["cat", { valued: [] }],
  ["tac", { valued: ["-s", "--separator"] }],
  ["head", { valued: ["-n", "-c", "--lines", "--bytes"] }],
  ["tail", { valued: ["-n", "-c", "-s", "--lines", "--bytes", "--pid", "--sleep-interval", "--max-unchanged-stats"] }],
  ["nl", { valued: ["-b", "-d", "-f", "-h", "-i", "-l", "-n", "-s", "-v", "-w", "--body-numbering", "--section-delimiter", "--footer-numbering", "--header-numbering", "--line-increment", "--join-blank-lines", "--number-format", "--number-separator", "--starting-line-number", "--number-width"] }],
  ["less", { valued: ["-b", "-h", "-j", "-k", "-o", "-O", "-p", "-P", "-t", "-T", "-x", "-y", "-z"], noRead: ["-V"] }],
  ["more", { valued: ["-n"], noRead: ["-V"] }],
  ["view", { valued: ["-c", "-S", "-u", "-i", "-T", "-w", "-W", "-s", "-t", "-q"] }],
  ...["bat", "batcat"].map((name): [string, ReaderSpec] => [
    name,
    {
      valued: ["-l", "-H", "-r", "-m", "--language", "--highlight-line", "--line-range", "--map-syntax", "--style", "--theme", "--tabs", "--wrap", "--terminal-width", "--pager", "--color", "--decorations", "--italic-text", "--file-name", "--diff-context", "--paging"],
      noRead: ["-V", "-L", "--list-languages", "--list-themes", "--config-file", "--config-dir", "--cache-dir"],
    },
  ]),
  [
    "sed",
    {
      valued: ["-e", "-f", "-l", "--expression", "--file", "--line-length"],
      script: true,
      scriptOptions: ["-e", "-f", "--expression", "--file"],
      edits: ["-i", "--in-place"],
    },
  ],
  ...["awk", "gawk", "mawk", "nawk"].map((name): [string, ReaderSpec] => [name, { valued: ["-f", "-v", "-F", "--file", "--assign", "--field-separator"], script: true, scriptOptions: ["-f", "--file"] }]),
  ...["grep", "egrep", "fgrep"].map((name): [string, ReaderSpec] => [name, GREP]),
  [
    "rg",
    {
      valued: ["-e", "-f", "-g", "-t", "-T", "-m", "-A", "-B", "-C", "-M", "-j", "-r", "-E", "-d", "--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--type-add", "--type-clear", "--max-count", "--after-context", "--before-context", "--context", "--max-columns", "--threads", "--replace", "--encoding", "--max-depth", "--color", "--colors", "--sort", "--sortr", "--pre", "--pre-glob", "--ignore-file", "--path-separator", "--context-separator", "--field-match-separator", "--field-context-separator", "--engine", "--max-filesize", "--dfa-size-limit", "--regex-size-limit", "--hostname-bin", "--hyperlink-format", "--generate"],
      script: true,
      scriptOptions: ["-e", "-f", "--regexp", "--file"],
      noRead: ["-V", "-h", "--files", "--type-list", "--generate", "--pcre2-version"],
    },
  ],
]);

/**
 * The files one invocation of a reading command reads, by its arguments,
 * or null where it reads nothing at all — help, version, a listing, an
 * in-place edit. Options, their values and a script or pattern operand
 * are never files; after `--` every word is.
 */
function fileOperands(spec: ReaderSpec, args: readonly string[]): string[] | null {
  const valued = new Set(spec.valued);
  const scriptOptions = new Set(spec.scriptOptions ?? []);
  const stops = new Set([...NO_READ, ...(spec.noRead ?? []), ...(spec.edits ?? [])]);
  const operands: string[] = [];
  let scriptGiven = false;
  let optionsOver = false;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (optionsOver || arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    if (arg === "--") {
      optionsOver = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const [name = arg] = arg.split("=", 1);
      if (stops.has(name)) return null;
      if (scriptOptions.has(name)) scriptGiven = true;
      if (valued.has(name) && !arg.includes("=")) at += 1;
      continue;
    }
    // A cluster of short options: `-nE`, `-n40`, `-A3`. A valued one
    // takes the rest of the word, or the next word when it ends it.
    for (let index = 1; index < arg.length; index += 1) {
      const option = `-${arg[index]!}`;
      if (stops.has(option)) return null;
      if (scriptOptions.has(option)) scriptGiven = true;
      if (valued.has(option)) {
        if (index === arg.length - 1) at += 1;
        break;
      }
    }
  }
  return spec.script && !scriptGiven ? operands.slice(1) : operands;
}

/** Shells whose `-c` script is parsed in turn: Codex runs every command as `bash -lc '…'`. */
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

/** Beyond this, a command is not parsed: no skill read is that long. */
const MAX_COMMAND_CHARS = 20_000;
const MAX_SHELL_DEPTH = 3;

/**
 * A command line as simple commands, each a list of words, with `>` and
 * `<` kept as words of their own so a redirect target can be told from
 * an argument. Quotes and backslashes are honoured; `;`, `&&`, `||`, `|`,
 * `&` and newlines end a simple command. Bounded rather than a shell:
 * substitutions and expansions are left as text, which only ever makes a
 * read go uncounted, never counts a mention.
 */
function simpleCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word: string | null = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (char === "'") {
      const close = command.indexOf("'", index + 1);
      const to = close === -1 ? command.length : close;
      word = (word ?? "") + command.slice(index + 1, to);
      index = to;
    } else if (char === '"') {
      let text = "";
      let at = index + 1;
      for (; at < command.length && command[at] !== '"'; at += 1) {
        if (command[at] === "\\" && at + 1 < command.length && '"\\$`'.includes(command[at + 1]!)) at += 1;
        text += command[at]!;
      }
      word = (word ?? "") + text;
      index = at;
    } else if (char === "\\") {
      index += 1;
      if (index < command.length && command[index] !== "\n") word = (word ?? "") + command[index]!;
    } else if (char === " " || char === "\t") {
      endWord();
    } else if (char === ";" || char === "\n" || char === "&" || char === "|") {
      endCommand();
    } else if (char === ">" || char === "<") {
      endWord();
      if (char === ">" && command[index + 1] === ">") index += 1;
      words.push(char);
    } else {
      word = (word ?? "") + char;
    }
  }
  endCommand();
  return commands;
}

/** The skills one command line reads with a reading command, by slug. */
function skillsReadBy(command: string, depth: number): string[] {
  if (command.length > MAX_COMMAND_CHARS || depth > MAX_SHELL_DEPTH) return [];
  const slugs: string[] = [];
  for (const words of simpleCommands(command)) {
    // Leading variable assignments are not the program.
    const start = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    if (start === -1) continue;
    const program = words[start]!.split("/").pop() ?? "";
    const args = words.slice(start + 1);
    if (SHELLS.has(program)) {
      const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
      const script = flag === -1 ? undefined : args[flag + 1];
      if (script !== undefined) slugs.push(...skillsReadBy(script, depth + 1));
      continue;
    }
    const spec = READERS.get(program);
    if (spec === undefined) continue;
    // Redirects first: what follows `>` is written, and what follows `<`
    // is read as standard input — where the command reads at all, which
    // a help or version invocation does not.
    const operands: string[] = [];
    const input: string[] = [];
    for (let at = 0; at < args.length; at += 1) {
      if (args[at] === ">" || args[at] === "<") {
        const target = args[at + 1];
        if (args[at] === "<" && target !== undefined) input.push(target);
        at += 1;
        continue;
      }
      operands.push(args[at]!);
    }
    const files = fileOperands(spec, operands);
    if (files === null) continue;
    for (const file of [...files, ...input]) {
      const slug = SKILL_FILE.exec(file)?.[1];
      if (slug !== undefined) slugs.push(slug);
    }
  }
  return slugs;
}

/**
 * Codex: a command that reads a skill's `SKILL.md` out of the worktree
 * loads it. Codex has no skill tool — the prompt names each skill and
 * says to read that file (EO-207) — so the read is the load.
 *
 * A read, not a mention (invariant 5): either the app-server's own parse
 * of the command says it reads exactly that file (`reads`, its `read`
 * actions), or the command line itself runs a reading command — `cat`,
 * `sed -n`, `head`, `nl`, `grep`, `rg`, … — with exactly that file as a
 * file operand. `echo` or `ls` of the path, a read of `SKILL.md.bak`, the
 * path as an option's value or a script (`sed -e <path> /dev/null`), and
 * a help or version invocation (`cat --help <path>`) are no load.
 * One event per skill however many times the command reads it.
 */
export function codexSkillsRead(command: string, reads: readonly string[] = []): AgentEvent[] {
  const slugs = new Set<string>();
  for (const path of reads) {
    const slug = SKILL_FILE.exec(path)?.[1];
    if (slug !== undefined) slugs.add(slug);
  }
  for (const slug of skillsReadBy(command, 0)) slugs.add(slug);
  return [...slugs].map((slug) => ({ type: "skill_loaded", slug }));
}

/**
 * The same stream, saying `first` before anything the backend says.
 * `interrupt` and `steer` pass straight through, so a caller holding the
 * stream can still reach the turn.
 */
export function leadingWith<T>(first: readonly T[], stream: InterruptibleStream<T>): InterruptibleStream<T> {
  if (first.length === 0) return stream;
  const wrapped: InterruptibleStream<T> = {
    [Symbol.asyncIterator]: () => {
      const pending = [...first];
      let inner: AsyncIterator<T> | null = null;
      const reader = () => (inner ??= stream[Symbol.asyncIterator]());
      return {
        next: async () => {
          const value = pending.shift();
          return value !== undefined ? { done: false, value } : reader().next();
        },
        return: async (value?: unknown) => (await reader().return?.(value)) ?? { done: true, value: value as T },
      };
    },
  };
  if (stream.interrupt) wrapped.interrupt = () => stream.interrupt!();
  if (stream.steer) wrapped.steer = (message, attachments) => stream.steer!(message, attachments);
  return wrapped;
}
