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
 * `.agent/skills/<slug>/SKILL.md`, relative or under an absolute path,
 * wherever it stands in a command — `cat`, `sed -n`, `head`, inside a
 * `bash -lc '…'`. The character before `.agent` has to be one that ends a
 * word (a space, a quote, a slash), so `foo.agent/skills/…` is not it.
 */
const CODEX_SKILL_READ = new RegExp(`(?:^|[^A-Za-z0-9_.-])${WORKTREE_SKILLS_PATH.replace(".", "\\.")}/([a-z0-9]+(?:-[a-z0-9]+)*)/SKILL\\.md`, "g");

/**
 * Codex: a command that reads a skill's `SKILL.md` out of the worktree
 * loads it. Codex has no skill tool — the prompt names each skill and
 * says to read that file (EO-207) — so the read is the load. One event
 * per skill however many times the command names it.
 */
export function codexSkillsRead(command: string): AgentEvent[] {
  const slugs = new Set([...command.matchAll(CODEX_SKILL_READ)].map((match) => match[1] ?? ""));
  slugs.delete("");
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
