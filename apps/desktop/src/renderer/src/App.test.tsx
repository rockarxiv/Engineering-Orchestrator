import { NO_GIT_STATE } from "@eo/core";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";

/**
 * The window (EO-529): one layout, the chat layout, whatever this device
 * once chose — and every address an older EO had either opens its view
 * or comes home to the conversation. What the layout does once it is
 * open is `chat/ChatLayout.test.tsx`'s.
 */
describe("App shell", () => {
  it.each([
    ["nothing", null],
    ["the classic layout", "classic"],
  ] as const)("opens at /chat on a device whose eo.layout said %s", async (_said, stored) => {
    if (stored === null) window.localStorage.removeItem("eo.layout");
    else window.localStorage.setItem("eo.layout", stored);
    window.location.hash = "#/";
    render(<App />);

    await waitFor(() => expect(window.location.hash).toBe("#/chat"));
    expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    window.localStorage.removeItem("eo.layout");
  });

  it.each(["#/nowhere", "#/assist", "#/assist/"])("sends %s, which nothing draws, to the conversation", async (hash) => {
    window.location.hash = hash;
    render(<App />);

    await waitFor(() => expect(window.location.hash).toBe("#/chat"));
    expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
  });

  it.each(["#/project", "#/inbox", "#/items", "#/archive", "#/jobs", "#/agents", "#/agent-tools", "#/settings", "#/gallery", "#/mentions"])(
    "opens %s, an address the classic layout had, as the chat layout's view of it",
    async (hash) => {
      window.location.hash = hash;
      render(<App />);

      expect(await screen.findByRole("region", { name: "Canvas" })).toBeInTheDocument();
      expect(window.location.hash).toBe(hash);
    },
  );

  it("draws no floating assistant and offers no window of its own for it (EO-529)", async () => {
    window.location.hash = "#/settings";
    render(<App />);

    await screen.findByRole("region", { name: "Canvas" });
    // What the floating panel drew: its handles, and the room in a box of its own.
    for (const name of ["Move the assistant", "Resize the assistant", "Close the assistant"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    // The one conversation, and its one transcript, are the window's own.
    expect(document.querySelectorAll('[aria-label="Conversation"]')).toHaveLength(1);
    expect(screen.getAllByLabelText("Assistant transcript")).toHaveLength(1);
    const invoke = window.eo.ipc.invoke as unknown as { mock?: { calls: unknown[][] } };
    expect((invoke.mock?.calls ?? []).some(([channel]) => channel === "assist:window")).toBe(false);
  });

  it("is dark, with no way to make it otherwise", () => {
    // EO is designed dark (ARCHITECTURE.md, "Colour"). Following
    // `prefers-color-scheme` meant the design most people saw was the one
    // nobody drew, so the light palette and its toggle are both gone.
    render(<App />);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(screen.queryByRole("button", { name: /Switch to (light|dark) theme/ })).not.toBeInTheDocument();
  });
});

describe("a Discussions deep link", () => {
  /**
   * Discussions is gone, and its conversations with it (EO-526). A link
   * to one — an old comment, a bookmark, a hash a window was left on —
   * comes home to the conversation rather than to a screen that is not
   * there, and asks for no Discussions conversation on the way.
   */
  it.each(["#/discussions", "#/discussions/c1"])("sends %s home", async (hash) => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "projects:list") return { ok: true, data: { projects: [], activeProjectId: null } };
      if (channel === "repositories:list") return { ok: true, data: { repositories: [] } };
      return { ok: true, data: { files: [], items: [], conversations: [] } };
    });
    window.eo.ipc.invoke = invoke as never;
    window.location.hash = hash;

    render(<App />);

    await waitFor(() => expect(window.location.hash).toBe("#/chat"));
    expect(invoke.mock.calls.map(([channel]) => channel).filter((channel) => channel.startsWith("discussions:"))).toEqual([]);
  });
});

/**
 * Clicking a desktop notification (U-04).
 *
 * The main process was sending `push:navigate` on a channel that was not
 * in the contract and that nothing subscribed to, so the window came to
 * the front and stayed exactly where it was.
 */
describe("a notification opening its item", () => {
  it("navigates where the main process asks", async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    window.eo.ipc.subscribe = vi.fn((channel: string, callback: (payload: unknown) => void) => {
      listeners.set(channel, callback);
      return () => listeners.delete(channel);
    }) as never;
    window.eo.ipc.invoke = vi.fn(async (channel: string) => {
      if (channel === "items:get") {
        return {
          ok: true,
          data: {
            item: { id: "t1", key: "EO-1", type: "story", parentId: null, repositoryId: null, repositoryName: null, projectId: null, title: "Rate limit the API", stepId: "todo", priority: 0, git: NO_GIT_STATE, workspace: { kind: "git-worktree", mode: "isolated", label: null }, jiraKey: null, jiraUrl: null, updatedAt: 1, needsAttention: false, openDependencyCount: 0, latestRunStatus: null, body: null, acceptanceCriteria: [], createdAt: 1, attachments: [] },
            comments: [],
            transitions: [],
            runs: [],
            dependsOn: [],
            decision: [],
          },
        };
      }
      return { ok: true, data: { items: [], agents: [], states: [], projects: [], repositories: [], activeProjectId: null } };
    }) as never;

    render(<App />);

    // Somebody is listening at all — this is what was missing. Awaited
    // since EO-317: everything that subscribes is under the first-run
    // gate, which draws nothing until it knows whether this
    // installation has been through the flow.
    await waitFor(() => expect(listeners.has("navigate")).toBe(true));

    act(() => listeners.get("navigate")!({ to: "/items/t1" }));

    await waitFor(() => expect(window.location.hash).toBe("#/items/t1"));
    expect(await screen.findByRole("region", { name: "Canvas" })).toBeInTheDocument();
  });
});
