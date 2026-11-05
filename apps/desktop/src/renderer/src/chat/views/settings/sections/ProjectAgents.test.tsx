import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { IpcResponse } from "@eo/core";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../../../query/client";
import { ProjectAgents } from "./ProjectAgents";

/**
 * What a project's settings say about its agents (EO-475), in the chat
 * layout (held to both layouts' cases until the classic one went, EO-529):
 * the project's own agents, and for each role its pipelines
 * use, who `projects:staffing` says will be dispatched.
 */

const STAFFING: IpcResponse<"projects:staffing"> = {
  roles: [
    { role: "implementer", from: "project", agents: [{ id: "a-own", name: "Support implementer" }] },
    { role: "reviewer", from: "global", agents: [{ id: "a-rev", name: "Reviewer" }] },
    { role: "writer", from: "nobody", agents: [] },
  ],
};

function agent(id: string, name: string, role: string, projectId: string | null, overrides: Record<string, unknown> = {}) {
  return { id, name, role, provider: "fake", model: null, enabled: true, instructions: "", defaultInstructions: null, builtin: false, config: {}, archivedAt: null, pipelineCount: 1, projectId, ...overrides };
}

function mount(agents: unknown[], staffing: IpcResponse<"projects:staffing"> = STAFFING) {
  const calls: { channel: string; payload: unknown }[] = [];
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === "agents:listDetailed") return { ok: true, data: { agents } };
    if (channel === "projects:staffing") return { ok: true, data: staffing };
    return { ok: true, data: {} };
  }) as never;
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ProjectAgents projectId="p-support" />
    </QueryClientProvider>,
  );
  return calls;
}

describe("a project's agents in its settings (chat layout)", () => {
  it("lists the project's own agents, and nobody else's", async () => {
    mount([
      agent("a-own", "Support implementer", "implementer", "p-support"),
      agent("a-off", "Support writer", "writer", "p-support", { enabled: false }),
      agent("a-gone", "Old helper", "helper", "p-support", { archivedAt: 1 }),
      agent("a-glob", "Implementer", "implementer", null),
      agent("a-shop", "Shop implementer", "implementer", "p-shop"),
    ]);

    const own = await screen.findByLabelText("Agents of this project's own");
    await within(own).findByText("Support implementer");
    expect(own.textContent).toContain("Support implementer (implementer)");
    expect(own.textContent).toContain("Support writer (writer, disabled)");
    expect(own.textContent).not.toContain("Old helper");
    expect(own.textContent).not.toContain("Shop implementer");
    expect(own.textContent).not.toMatch(/\bImplementer \(/);
  });

  it("says, role by role, whether the project's own agent or the global one will be dispatched", async () => {
    const calls = mount([agent("a-own", "Support implementer", "implementer", "p-support")]);

    const roles = await screen.findByRole("list", { name: "Who is dispatched, by role" });
    expect(within(roles).getByRole("listitem", { name: "implementer" }).textContent).toBe("implementer → Support implementer — this project's own");
    expect(within(roles).getByRole("listitem", { name: "reviewer" }).textContent).toBe("reviewer → Reviewer — global");
    expect(within(roles).getByRole("listitem", { name: "writer" }).textContent).toBe("writer → Nobody — no enabled agent holds this role");
    expect(calls.find((call) => call.channel === "projects:staffing")?.payload).toEqual({ projectId: "p-support" });
  });

  it("says a project with no agents of its own uses the global ones", async () => {
    mount([agent("a-glob", "Implementer", "implementer", null)], { roles: [{ role: "implementer", from: "global", agents: [{ id: "a-glob", name: "Implementer" }] }] });

    expect((await screen.findByLabelText("Agents of this project's own")).textContent).toContain("No agents of its own");
    expect((await screen.findByRole("listitem", { name: "implementer" })).textContent).toBe("implementer → Implementer — global");
  });
});
