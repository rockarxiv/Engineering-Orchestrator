import type { query } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_USAGE_METHOD } from "../providers/claudeUsage.js";

/** A stand-in for the Claude Agent SDK's `query`, for the plan usage read (EO-896). */
export interface FakeSession {
  options: Record<string, unknown> | undefined;
  /** What the session's prompt yielded, read until the prompt ended. */
  yielded: unknown[];
  promptEnded: Promise<void>;
  closed: boolean;
  usageCalls: unknown[];
}

/** A `query` whose sessions answer the usage method with `answer`, or throw it, or lack it. */
export function fakeClaudeQuery(answer: () => unknown, options: { missing?: boolean } = {}): { runQuery: typeof query; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  const runQuery = ((params: { prompt: AsyncIterable<unknown>; options?: Record<string, unknown> }) => {
    const session: FakeSession = { options: params.options, yielded: [], promptEnded: Promise.resolve(), closed: false, usageCalls: [] };
    session.promptEnded = (async () => {
      for await (const message of params.prompt) session.yielded.push(message);
    })();
    let close: () => void = () => {};
    const closed = new Promise<void>((resolve) => (close = resolve));
    // The session's own messages: none, until it is closed.
    const messages = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async (): Promise<IteratorResult<never>> => {
        await closed;
        return { done: true, value: undefined };
      },
    };
    sessions.push(session);
    return Object.assign(messages, {
      close: () => {
        session.closed = true;
        close();
      },
      ...(options.missing
        ? {}
        : {
            [CLAUDE_USAGE_METHOD]: async (opts: unknown) => {
              session.usageCalls.push(opts);
              const value = answer();
              if (value instanceof Error) throw value;
              return value;
            },
          }),
    });
  }) as unknown as typeof query;
  return { runQuery, sessions };
}

export const CLAUDE_USAGE = (fiveHour: number, sevenDay: number, resetsAt = "2026-11-23T15:40:00.000Z") => ({
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: fiveHour, resets_at: resetsAt },
    seven_day: { utilization: sevenDay, resets_at: "2026-11-26T09:00:00.000Z" },
    seven_day_opus: { utilization: 12, resets_at: null },
    seven_day_sonnet: null,
  },
});

