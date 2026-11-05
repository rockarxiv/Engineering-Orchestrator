import type { ReactNode } from "react";
import { act } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../query/client";
import { useScenarioRoom } from "./useScenarioRoom";

/**
 * A module's scenario chat is re-read only for its own thread and its own
 * run (EO-550), by the rule the assistant room follows — see
 * `useAssistRoom.test.tsx`, "the pushes the room is re-read for".
 */
const MODULE_ID = "019fb8c6-de92-7a41-9c33-4471f0c2b100";
const OWN_RUN = "019fb8c6-de92-7a41-9c33-4471f0c2b1f0";
const OTHER_RUN = "019fb8c6-de92-7a41-9c33-4471f0c2b1f1";
const OTHER_ITEM = "019fb8c6-de92-7a41-9c33-4471f0c2b1f2";

const SYSTEM_AGENT = { id: "019fb8c6-de92-7a41-9c33-4471f0c2b1df", name: "Assistant", role: "system", provider: "claude", model: null, enabled: true, archivedAt: null };

const THREAD = {
  id: "019fb8c6-de92-7a41-9c33-4471f0c2b1de",
  key: "SCN-1",
  startedAt: 0,
  closedAt: null,
  thinking: true,
  thinkingSince: 1,
  activeRunId: OWN_RUN,
  liveOutput: "",
  liveActivity: [],
  settings: { agentId: "a", agentName: "Assistant", provider: "claude", model: null, defaultModel: null, reasoningEffort: null, defaultReasoningEffort: null },
  messages: [],
};

let listeners: Map<string, Set<(payload: unknown) => void>>;
function emit(channel: string, payload: unknown) {
  for (const listener of listeners.get(channel) ?? []) listener(payload);
}

beforeEach(() => {
  listeners = new Map();
  window.eo.ipc.subscribe = vi.fn((channel: string, callback: (payload: unknown) => void) => {
    const set = listeners.get(channel) ?? new Set();
    set.add(callback);
    listeners.set(channel, set);
    return () => set.delete(callback);
  }) as never;
});

async function openThread() {
  const invoke = vi.fn((channel: string) =>
    Promise.resolve({ ok: true, data: channel === "agents:list" ? { agents: [SYSTEM_AGENT] } : { conversation: THREAD } }),
  );
  window.eo.ipc.invoke = invoke as never;
  const client = createQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useScenarioRoom(MODULE_ID, true), { wrapper: Wrapper });
  await waitFor(() => expect(result.current.conversation).not.toBeNull());
  await waitFor(() => expect(client.isFetching()).toBe(0));
  return { opens: () => invoke.mock.calls.filter(([channel]) => channel === "scenario:open").length };
}

async function after(push: () => void) {
  await act(async () => {
    push();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("the pushes a scenario chat is re-read for", () => {
  it("is re-read for its own run's progress and not another run's", async () => {
    const { opens } = await openThread();
    const before = opens();

    await after(() => emit("runs:progress", { runId: OTHER_RUN }));
    expect(opens()).toBe(before);

    await after(() => emit("runs:progress", { runId: OWN_RUN }));
    await waitFor(() => expect(opens()).toBe(before + 1));
  });

  it("is re-read for its own thread's change or an unnamed one, and not another item's", async () => {
    const { opens } = await openThread();
    const before = opens();

    await after(() => emit("items:changed", { itemId: OTHER_ITEM }));
    await after(() => emit("runs:changed", { runId: OTHER_RUN, itemId: OTHER_ITEM, status: "succeeded" }));
    expect(opens()).toBe(before);

    await after(() => emit("items:changed", { itemId: THREAD.id }));
    await waitFor(() => expect(opens()).toBe(before + 1));
    await after(() => emit("items:changed", {}));
    await waitFor(() => expect(opens()).toBe(before + 2));
    await after(() => emit("runs:changed", { runId: OWN_RUN, itemId: THREAD.id, status: "succeeded" }));
    await waitFor(() => expect(opens()).toBe(before + 3));
  });
});
