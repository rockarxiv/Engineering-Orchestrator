import type { AgentEvent, InterruptibleStream, Skill } from "@eo/core";
import { TOOL_PLUGIN_NAME } from "../agentAttachments/pluginDirectory.js";
import { WORKTREE_SKILLS_PATH, worktreeSkillMarkdown } from "../agentAttachments/worktreeSkills.js";

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

/** How much of one command's output is looked through: no skill read is longer. */
const MAX_OUTPUT_CHARS = 2_000_000;

/**
 * One delivered skill as a command's output would show it (EO-715): the
 * id EO wrote into its frontmatter, the path it is read from, and every
 * line of the file as delivered (`worktreeSkillMarkdown`), trimmed.
 */
interface SkillText {
  id: string;
  /** `.agent/skills/<slug>/SKILL.md`. */
  path: string;
  lines: ReadonlySet<string>;
}

/** The skills a turn was given, by slug, as `codexSkillsRead` holds a command's output to them. */
export interface SkillTexts {
  readonly bySlug: ReadonlyMap<string, SkillText>;
}

export const NO_SKILL_TEXTS: SkillTexts = { bySlug: new Map() };

/** The `SkillTexts` of the skills a turn actually delivered, from the files as Codex was given them. */
export function skillTextsOf(skills: readonly Skill[]): SkillTexts {
  const bySlug = new Map<string, SkillText>();
  for (const skill of skills) {
    const lines = new Set(
      worktreeSkillMarkdown(skill)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    );
    bySlug.set(skill.slug, { id: skill.id, path: `${WORKTREE_SKILLS_PATH}/${skill.slug}/SKILL.md`, lines });
  }
  return { bySlug };
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The path where a command names it: the whole of `.agent/skills/<slug>/SKILL.md`,
 * relative or under any directory, and not a longer name it begins
 * (`SKILL.md.bak`) or ends (`foo.agent/…`).
 */
function namesPath(text: string, path: string): boolean {
  return new RegExp(`(?:^|[^A-Za-z0-9_.-])${escaped(path)}(?![A-Za-z0-9_.-])`).test(text);
}

/**
 * An output line as grep, rg or `cat -n` print it: whatever path prefix
 * it carries (`<dir>/.agent/skills/<slug>/SKILL.md:12:` or `…-12-` or
 * `…:`), and the line itself with any line number taken off.
 */
const GREP_PREFIX = /^(.*?\.agent\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/SKILL\.md)[:-](?:\d+[:-])?/;
const NUMBER_PREFIX = /^\s*\d+[:\t-]/;

function outputLine(raw: string): { prefixPath: string | null; texts: string[] } {
  const prefixed = GREP_PREFIX.exec(raw);
  const rest = prefixed ? raw.slice(prefixed[0].length) : raw;
  const texts = [rest.trim()];
  const numbered = NUMBER_PREFIX.exec(rest);
  if (numbered) texts.push(rest.slice(numbered[0].length).trim());
  if (prefixed) texts.push(raw.trim());
  return { prefixPath: prefixed?.[1] ?? null, texts: texts.filter((text) => text !== "") };
}

/**
 * Codex: which of the turn's skills a command loaded, from what Codex
 * reports — the command line and the output it returned to the agent.
 *
 * **A best-effort inference, not an observation.** Claude's load is
 * exact: the agent calls the `Skill` tool, and that call is the load.
 * Codex has no skill tool — the prompt names each skill and says to read
 * its file (EO-207) — and nothing Codex reports says which file a line of
 * output came from. So this infers, by the rule a person settled for
 * EO-715, leaning towards counting a read rather than missing one: these
 * counts decide which agent skills are archived as unused (EO-720), and a
 * missed read can archive a skill agents rely on where a false one only
 * keeps a skill a little longer.
 *
 * - The output holds the skill's id, which EO writes into the frontmatter
 *   of every `SKILL.md` it delivers on Codex and no other file holds: a
 *   load, whatever the command was — `cat`, `head`, `sed`, `python`,
 *   `xargs`, `find -exec`.
 * - A read that leaves the frontmatter out counts when the command names
 *   that skill's `SKILL.md` path and the output shows a line of the file,
 *   or when an output line carries the path as a grep-style prefix and
 *   shows a line of the file after it.
 *
 * Accepted gaps, as settled: a partial read that neither shows the
 * frontmatter nor names the path goes uncounted, and a contrived command
 * that names the path while printing other content with the same lines
 * can over-count. One event per skill however often the output shows it.
 */
export function codexSkillsRead(command: string, output: string, texts: SkillTexts): AgentEvent[] {
  if (texts.bySlug.size === 0 || output === "") return [];
  const shown = output.slice(0, MAX_OUTPUT_CHARS);
  const loaded = new Set<string>();
  const lines = shown.split("\n").map(outputLine);
  for (const [slug, skill] of texts.bySlug) {
    if (shown.includes(skill.id)) {
      loaded.add(slug);
      continue;
    }
    const named = namesPath(command, skill.path);
    const showsALine = lines.some(
      (line) => (named || (line.prefixPath !== null && namesPath(line.prefixPath, skill.path))) && line.texts.some((text) => skill.lines.has(text)),
    );
    if (showsALine) loaded.add(slug);
  }
  return [...loaded].sort().map((slug) => ({ type: "skill_loaded", slug }));
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
