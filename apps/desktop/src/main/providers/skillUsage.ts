import { renderSkillMarkdown, type AgentEvent, type InterruptibleStream, type Skill } from "@eo/core";
import { TOOL_PLUGIN_NAME } from "../agentAttachments/pluginDirectory.js";

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
 * The shortest body line that counts as a skill's own. Shorter lines —
 * `---`, a heading, `## Steps` — are in every other markdown file too.
 */
const MIN_SKILL_LINE_CHARS = 20;

/** How much of one command's output is looked through: no skill read is longer. */
const MAX_OUTPUT_CHARS = 2_000_000;

/** How far into an output line a prefix may run — `path:12:`, `   12\t` — before the skill's line. */
const MAX_PREFIX_CHARS = 512;

/**
 * The lines of each skill a turn was given that only that skill's
 * `SKILL.md` holds (EO-715), by slug: what the file's text looks like
 * when a command shows it. Its `description:` line always, which EO
 * wrote and which names the skill; every other line of the file at least
 * `MIN_SKILL_LINE_CHARS` long, trimmed, that no other skill given in the
 * same turn shares.
 */
export interface SkillTexts {
  /** Distinctive line → the slug of the one skill whose `SKILL.md` holds it. */
  readonly lines: ReadonlyMap<string, string>;
}

export const NO_SKILL_TEXTS: SkillTexts = { lines: new Map() };

/** The `SkillTexts` of the skills a turn actually delivered. */
export function skillTextsOf(skills: readonly Skill[]): SkillTexts {
  const owners = new Map<string, Set<string>>();
  for (const skill of skills) {
    for (const raw of renderSkillMarkdown(skill).split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("description: ") && line.length < MIN_SKILL_LINE_CHARS) continue;
      const held = owners.get(line) ?? new Set<string>();
      held.add(skill.slug);
      owners.set(line, held);
    }
  }
  const lines = new Map<string, string>();
  for (const [line, slugs] of owners) if (slugs.size === 1) lines.set(line, [...slugs][0]!);
  return { lines };
}

/**
 * Codex: a command whose output shows a skill's `SKILL.md` loaded it.
 * Codex has no skill tool — the prompt names each skill and says to read
 * that file (EO-207) — so a read is the load, and a read is told by its
 * result rather than by guessing at what a command line would do: the
 * output the backend returned to the agent holds a line only that skill's
 * file holds (`SkillTexts`), whole or after a prefix like grep's
 * `path:12:` or `cat -n`'s number.
 *
 * However the command read it — `cat`, `sed -n`, `rg`, `python3 -c
 * "open(…)"`, `xargs`, a subshell — the skill's text came back, and that
 * is what is counted (invariant 5). A command that only mentions the
 * path — `echo` or `ls` of it, a comment, a heredoc, `--help`, the path
 * as an option's value — returns no line of the skill, and is no load.
 * Nor is a line the command itself holds: an agent echoing a skill's
 * words back has typed them, not read them. One event per skill however
 * many of its lines the output shows.
 */
export function codexSkillsRead(command: string, output: string, texts: SkillTexts): AgentEvent[] {
  if (texts.lines.size === 0 || output === "") return [];
  const slugs = new Set<string>();
  const shown = (candidate: string): void => {
    const line = candidate.trim();
    const slug = texts.lines.get(line);
    if (slug !== undefined && !command.includes(line)) slugs.add(slug);
  };
  for (const raw of output.slice(0, MAX_OUTPUT_CHARS).split("\n")) {
    shown(raw);
    // After a prefix: every `:` or tab in the line's opening stretch.
    const head = raw.slice(0, MAX_PREFIX_CHARS);
    for (let at = 0; at < head.length; at += 1) {
      if (head[at] === ":" || head[at] === "\t") shown(raw.slice(at + 1));
    }
  }
  return [...slugs].sort().map((slug) => ({ type: "skill_loaded", slug }));
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
