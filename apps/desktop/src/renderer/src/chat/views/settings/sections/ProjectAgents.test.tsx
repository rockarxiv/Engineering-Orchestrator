import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { IpcResponse } from "@eo/core";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../../../query/client";
import { ProjectAgents } from "./ProjectAgents";

/**
 * What a project's settings say about its agents (EO-475), in the chat
 * layout (held to both layouts' cases until the classic one went, EO-529):
 * the project's own agents, and for each agent step of its pipelines the
 * agent the step names, as `projects:staffing` reads it off the step (EO-876).
 */

const step = (stepName: string, agent: IpcResponse<"projects:staffing">["steps"][number]["agent"], problem: string | null = null) => ({
  stepId: `s-${stepName}`,
  stepName,
  pipelineId: "p-delivery",
  pipelineName: "Delivery",
  agent,
  problem,
});

const STAFFING: IpcResponse<"projects:staffing"> = {
  steps: [
    step("Implement", { id: "a-own", name: "Support implementer", role: "implementer", provider: "claude", model: "opus", projectId: "p-support" }),
    step("Review", { id: "a-rev", name: "Reviewer", role: "reviewer", provider: "codex", model: null, projectId: null }),
    step("Write", { id: "a-off", name: "Writer", role: "writer", provider: "fake", model: null, projectId: null }, "Writer is disabled, so nothing runs here until it is enabled or the step names another agent."),
    step("Check", null, "No agent is chosen for this step, so nothing runs here until one is."),
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

  it("says, step by step, the agent the step names, with its kind, backend and model", async () => {
    const calls = mount([agent("a-own", "Support implementer", "implementer", "p-support")]);

    const steps = await screen.findByRole("list", { name: "Who runs each step" });
    expect(within(steps).getByRole("listitem", { name: "Delivery · Implement" }).textContent).toBe("Delivery · Implement → Support implementer (implementer · Claude Code · opus)");
    expect(within(steps).getByRole("listitem", { name: "Delivery · Review" }).textContent).toBe("Delivery · Review → Reviewer (reviewer · Codex · default model)");
    expect(calls.find((call) => call.channel === "projects:staffing")?.payload).toEqual({ projectId: "p-support" });
  });

  it("says in words when a step's agent cannot run, or the step names none", async () => {
    mount([]);

    const steps = await screen.findByRole("list", { name: "Who runs each step" });
    expect(within(steps).getByRole("listitem", { name: "Delivery · Write" }).textContent).toContain("Writer (writer · Built in (fake) · default model) — Writer is disabled, so nothing runs here");
    expect(within(steps).getByRole("listitem", { name: "Delivery · Check" }).textContent).toBe("Delivery · Check → No agent is chosen for this step, so nothing runs here until one is.");
  });

  it("says a project with no agents of its own names global ones", async () => {
    mount([agent("a-glob", "Implementer", "implementer", null)], { steps: [step("Implement", { id: "a-glob", name: "Implementer", role: "implementer", provider: "fake", model: null, projectId: null })] });

    expect((await screen.findByLabelText("Agents of this project's own")).textContent).toContain("No agents of its own");
    expect((await screen.findByRole("listitem", { name: "Delivery · Implement" })).textContent).toContain("Implementer (implementer");
  });
});
