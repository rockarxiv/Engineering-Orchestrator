import { RESERVED_MCP_SERVER_NAME, SKILL_READ_TOOL_NAME, type AgentEvent, type InterruptibleStream } from "@eo/core";
import { TOOL_PLUGIN_NAME } from "../agentAttachments/pluginDirectory.js";

/**
 * What each adapter reports about EO's skills on a turn (EO-715): which
 * it delivered, and which the agent loaded — read off what the backend
 * did, never off what the agent says (invariant 5).
 *
 * Both detectors live here, side by side, because the two backends load
 * a skill through different tools — the SDK's `Skill` on Claude, EO's
 * `skill_read` on Codex (EO-721) — and parity is easier to keep when the
 * two readings can be seen together (invariant 12). Each adapter calls its
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
 * Codex: a call to EO's `skill_read` tool on the `eo` server that EO
 * answered loads that skill (EO-721) — as exact as Claude's `Skill` call,
 * because it is one: EO serves the instructions, so the call is the load.
 *
 * Only a call that completed counts. A refusal — a skill the run was not
 * given, a malformed call, EO unreachable — is the tool's error, which
 * Codex reports as a failed call, and loaded nothing. Whether the run was
 * given the skill is still the supervisor's question, as it is on Claude.
 */
export function codexSkillLoaded(server: string, tool: string, input: unknown, completed: boolean): AgentEvent[] {
  if (!completed || server !== RESERVED_MCP_SERVER_NAME || tool !== SKILL_READ_TOOL_NAME || typeof input !== "object" || input === null) return [];
  const slug = (input as { slug?: unknown }).slug;
  if (typeof slug !== "string" || slug.trim() === "") return [];
  return [{ type: "skill_loaded", slug: slug.trim() }];
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

/**
 * The same stream without the events of these types (EO-732): on a turn
 * whose calls are refused as they are made, what a call says by being
 * made — a skill loaded, a file edited — did not happen. `interrupt` and
 * `steer` pass straight through, as in `leadingWith`.
 */
export function withoutEvents(stream: InterruptibleStream<AgentEvent>, types: ReadonlySet<AgentEvent["type"]>): InterruptibleStream<AgentEvent> {
  const wrapped: InterruptibleStream<AgentEvent> = {
    [Symbol.asyncIterator]: () => {
      const inner = stream[Symbol.asyncIterator]();
      return {
        next: async () => {
          for (;;) {
            const next = await inner.next();
            if (next.done || !types.has(next.value.type)) return next;
          }
        },
        return: async (value?: unknown) => (await inner.return?.(value)) ?? { done: true, value: value as AgentEvent },
      };
    },
  };
  if (stream.interrupt) wrapped.interrupt = () => stream.interrupt!();
  if (stream.steer) wrapped.steer = (message, attachments) => stream.steer!(message, attachments);
  return wrapped;
}
