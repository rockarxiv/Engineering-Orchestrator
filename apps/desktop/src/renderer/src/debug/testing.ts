import { vi } from "vitest";

/**
 * A main process for the debug screens' tests: answers by channel, keeps
 * what it was asked, and can push. The caller installs `eo` as the
 * preload.
 */
export function debugBridge(answers: Record<string, (payload: unknown) => unknown>) {
  const calls: { channel: string; payload: unknown }[] = [];
  const subscribers = new Map<string, Set<(payload: unknown) => void>>();

  const eo = {
    versions: { electron: "0.0.0-test", chrome: "0.0.0-test", node: "0.0.0-test" },
    ipc: {
      invoke: vi.fn(async (channel: string, payload: unknown) => {
        calls.push({ channel, payload });
        const answer = answers[channel];
        if (!answer) return { ok: false, error: { code: "unknown", message: `no answer for ${channel}` } };
        return { ok: true, data: answer(payload) };
      }) as never,
      subscribe: vi.fn((channel: string, callback: (payload: unknown) => void) => {
        const set = subscribers.get(channel) ?? new Set();
        set.add(callback);
        subscribers.set(channel, set);
        return () => set.delete(callback);
      }) as never,
    },
  };

  return {
    /**
     * What a test installs as the preload's object. Handed back rather
     * than installed here: the preload's global is named in
     * `ipc/bridge.ts` and in tests, and nowhere else — the confinement
     * case in `ipc/bridge.test.ts` holds that.
     */
    eo,
    calls,
    asked: (channel: string) => calls.filter((call) => call.channel === channel),
    push: (channel: string, payload: unknown = {}) => {
      for (const callback of subscribers.get(channel) ?? []) callback(payload);
    },
  };
}
