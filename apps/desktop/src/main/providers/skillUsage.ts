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

/** Commands whose file arguments they read. `sed -i` is an edit, and is excluded where it is seen. */
const READERS = new Set(["cat", "head", "tail", "sed", "nl", "less", "more", "bat", "batcat", "tac", "awk", "view"]);

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
    if (!READERS.has(program)) continue;
    if (program === "sed" && args.some((arg) => arg.startsWith("-i") || arg.startsWith("--in-place"))) continue;
    for (let at = 0; at < args.length; at += 1) {
      // What follows `>` is written, not read.
      if (args[at] === ">") {
        at += 1;
        continue;
      }
      const slug = SKILL_FILE.exec(args[at]!)?.[1];
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
 * `sed -n`, `head`, `nl`, … — with exactly that file as an argument.
 * `echo` or `ls` of the path, or a read of `SKILL.md.bak`, is no load.
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
