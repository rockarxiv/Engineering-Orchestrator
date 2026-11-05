import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { ModuleTestCase, ModuleView } from "@eo/core";
import { ThemeProvider } from "@eo/ui";
import { createQueryClient } from "../../query/client";
import { ipcStub, sent, type Answers } from "../views/settings/org/testing";
import { ModuleTests } from "./ModuleTests";

/**
 * The Tests panel on the Modules screen, in the chat layout: deleting a
 * case of an approved module, or opening the scenario chat that writes
 * them, withdraws its approval (EO-498), so the panel asks first and
 * offers Approve after (EO-500). The classic
 * layout's panel is held to the same cases in `modules/ModuleTests.test.tsx`.
 */

const CASE: ModuleTestCase = {
  id: "t1",
  moduleId: "mod-1",
  description: "merges once CI is green",
  source: "export default async function (harness) {}",
  createdAt: 0,
  updatedAt: 0,
};

function module(overrides: Partial<ModuleView> = {}): ModuleView {
  return {
    id: "mod-1",
    slug: "deploy",
    name: "Deploy",
    description: "Deploys the release.",
    code: "export default async () => ({ ok: true, result: 'deployed' });",
    manifest: {
      name: "Deploy",
      description: "Deploys the release.",
      inputs: {},
      needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
      results: ["deployed"],
    },
    originalScript: null,
    source: "user",
    approvedAt: null,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    usedByStepCount: 2,
    portability: [],
    machineSpecific: [],
    testRun: null,
    testsStale: false,
    testCount: 1,
    ...overrides,
  };
}

/** The panel with the providers the Modules screen gives it, kept across a rerender so a test can hand it the module as the list comes back. */
function draw(view: ModuleView, answers: Answers = {}) {
  const stub = ipcStub({
    "moduleTests:list": { tests: [CASE], problem: null },
    "moduleTests:delete": { deleted: true, problem: null, approvalWithdrawn: view.approvedAt !== null },
    ...answers,
  });
  window.eo.ipc.invoke = stub.invoke as never;
  const client = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
  const { rerender } = render(<ModuleTests module={view} />, { wrapper });
  return Object.assign(stub.calls, { update: (next: ModuleView) => rerender(<ModuleTests module={next} />) });
}

/** The question in front of a write, as opposed to the scenario chat's own floating panel. */
function confirmation(name: RegExp | string) {
  return screen.findByRole("dialog", { name });
}

/** The list's own two clicks: Delete, then Confirm delete. */
async function pressDelete() {
  fireEvent.click(await screen.findByRole("button", { name: `Delete ${CASE.description}` }));
  fireEvent.click(screen.getByRole("button", { name: `Confirm deleting ${CASE.description}` }));
}

describe("deleting a case on the Modules screen, in the chat layout", () => {
  it("on an approved module, asks first — naming the module and that its steps stop until it is approved again", async () => {
    const calls = draw(module({ approvedAt: 5 }));
    await pressDelete();

    const dialog = await confirmation(`Delete "${CASE.description}"?`);
    expect(dialog).toHaveTextContent(`Delete "${CASE.description}"?`);
    expect(dialog).toHaveTextContent("Deploy is approved.");
    expect(dialog).toHaveTextContent("withdraws its approval");
    expect(dialog).toHaveTextContent("steps that run Deploy stop until it is approved again");
    expect(sent(calls, "moduleTests:delete")).toEqual([]);
  });

  it("writes nothing when the confirmation is cancelled", async () => {
    const calls = draw(module({ approvedAt: 5 }));
    await pressDelete();

    fireEvent.click(within(await confirmation(`Delete "${CASE.description}"?`)).getByRole("button", { name: "Keep it" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(sent(calls, "moduleTests:delete")).toEqual([]);
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("after a confirmed delete, shows the module as not approved and offers Approve, which approves it", async () => {
    const calls = draw(module({ approvedAt: 5 }), { "modules:approve": { approved: true, problem: null, coverageAcknowledgementNeeded: false, lineCoverage: null } });
    await pressDelete();

    fireEvent.click(within(await confirmation(`Delete "${CASE.description}"?`)).getByRole("button", { name: "Delete and withdraw approval" }));

    await waitFor(() => expect(sent(calls, "moduleTests:delete")).toEqual([{ id: CASE.id }]));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Not approved");
    expect(status).toHaveTextContent("The approval of Deploy is withdrawn. Steps that run it stop until it is approved again.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The module prop still says approved — the list has not come back —
    // and that must not read as approved again.

    fireEvent.click(within(status).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(sent(calls, "modules:approve")).toEqual([{ id: "mod-1", acknowledgeLowCoverage: false }]));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("on a module that is not approved, deletes without asking and offers no Approve", async () => {
    const calls = draw(module({ approvedAt: null }));
    await pressDelete();

    await waitFor(() => expect(sent(calls, "moduleTests:delete")).toEqual([{ id: CASE.id }]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("says a refused approval beside Approve", async () => {
    draw(module({ approvedAt: 5 }), {
      "modules:approve": { approved: false, problem: "Not approved: 1 test case failed.", coverageAcknowledgementNeeded: false, lineCoverage: null },
    });
    await pressDelete();
    fireEvent.click(within(await confirmation(`Delete "${CASE.description}"?`)).getByRole("button", { name: "Delete and withdraw approval" }));
    fireEvent.click(within(await screen.findByRole("status")).getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("Not approved: 1 test case failed.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Not approved");
  });
});

describe("adding a scenario on the Modules screen, in the chat layout", () => {
  const SCENARIOS = "Scenarios for Deploy";
  const ASK = "Add a scenario to Deploy?";

  it("on an approved module, asks before the chat opens — naming the module and that its steps stop until it is approved again", async () => {
    const calls = draw(module({ approvedAt: 5 }));
    fireEvent.click(await screen.findByRole("button", { name: "Add scenario" }));

    const dialog = await confirmation(ASK);
    expect(dialog).toHaveTextContent("Deploy is approved.");
    expect(dialog).toHaveTextContent("withdraws its approval");
    expect(dialog).toHaveTextContent("steps that run Deploy stop until it is approved again");
    expect(dialog).toHaveTextContent("saves each case it writes or fixes");
    expect(screen.queryByRole("dialog", { name: SCENARIOS })).not.toBeInTheDocument();
    expect(sent(calls, "scenario:open")).toEqual([]);
  });

  it("opens nothing, so nothing can be written, when the confirmation is cancelled", async () => {
    const calls = draw(module({ approvedAt: 5 }));
    fireEvent.click(await screen.findByRole("button", { name: "Add scenario" }));
    fireEvent.click(within(await confirmation(ASK)).getByRole("button", { name: "Keep it" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: ASK })).not.toBeInTheDocument());
    expect(screen.queryByRole("dialog", { name: SCENARIOS })).not.toBeInTheDocument();
    expect(sent(calls, "agents:list")).toEqual([]);
    expect(sent(calls, "scenario:open")).toEqual([]);
  });

  it("opens the chat once agreed, and offers Approve when the agent's write has withdrawn the approval", async () => {
    const calls = draw(module({ approvedAt: 5 }), { "modules:approve": { approved: true, problem: null, coverageAcknowledgementNeeded: false, lineCoverage: null } });
    fireEvent.click(await screen.findByRole("button", { name: "Add scenario" }));
    fireEvent.click(within(await confirmation(ASK)).getByRole("button", { name: "Open the scenario chat" }));

    expect(await screen.findByRole("dialog", { name: SCENARIOS })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: ASK })).not.toBeInTheDocument();
    // Nothing is withdrawn by opening a chat.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // Asked once per approval: closing and reopening does not ask again.
    fireEvent.click(screen.getByRole("button", { name: "Add scenario" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: SCENARIOS })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add scenario" }));
    expect(await screen.findByRole("dialog", { name: SCENARIOS })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: ASK })).not.toBeInTheDocument();

    // The agent saves a case; the module list comes back unapproved.
    calls.update(module({ approvedAt: null }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Not approved");
    expect(status).toHaveTextContent("The approval of Deploy is withdrawn.");

    fireEvent.click(within(status).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(sent(calls, "modules:approve")).toEqual([{ id: "mod-1", acknowledgeLowCoverage: false }]));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("on a module that is not approved, opens the chat without asking", async () => {
    draw(module({ approvedAt: null }));
    fireEvent.click(await screen.findByRole("button", { name: "Add scenario" }));

    expect(await screen.findByRole("dialog", { name: SCENARIOS })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: ASK })).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("an open scenario chat across approvals, in the chat layout", () => {
  const SCENARIOS = "Scenarios for Deploy";
  const SEND = "Send this to the scenario chat?";
  const SYSTEM_AGENT = { id: "agent-system", name: "System agent", role: "system", provider: "claude", model: null, enabled: true, archivedAt: null };

  function conversation(messages: unknown[] = []) {
    return {
      id: "conv-1",
      key: "SCN-1",
      startedAt: 0,
      closedAt: null,
      thinking: false,
      thinkingSince: null,
      liveOutput: "",
      liveActivity: [],
      settings: { agentId: SYSTEM_AGENT.id, agentName: "System agent", provider: "claude", model: null, defaultModel: null, reasoningEffort: null, defaultReasoningEffort: null },
      messages,
    };
  }

  /** A live question from the agent, answered by picking an option. */
  const QUESTION = {
    id: "q1",
    authorType: "agent",
    authorName: "System agent",
    body: "Which branch should it merge?",
    attachments: [],
    kind: "question",
    parentId: null,
    runId: "r1",
    options: ["main", "release"],
    canAnswer: true,
    createdAt: 1,
    canApprove: false,
    approves: null,
    proposedType: null,
    status: null,
  };

  function room(view: ModuleView, messages: unknown[] = []) {
    return draw(view, {
      "agents:list": { agents: [SYSTEM_AGENT] },
      "scenario:open": { conversation: conversation(messages) },
      "scenario:send": { conversation: conversation(messages) },
      "scenario:answer": { answered: 1, problem: null, conversation: conversation(messages) },
    });
  }

  async function say(text: string) {
    const chat = await screen.findByRole("dialog", { name: SCENARIOS });
    const box = await within(chat).findByRole("textbox", { name: "Describe a scenario" });
    fireEvent.change(box, { target: { value: text } });
    fireEvent.keyDown(box, { key: "Enter" });
    return box;
  }

  it("asks again before a message once the module is approved again with the chat still open, and a kept approval sends nothing", async () => {
    const calls = room(module({ approvedAt: 5 }));
    fireEvent.click(await screen.findByRole("button", { name: "Add scenario" }));
    fireEvent.click(within(await confirmation("Add a scenario to Deploy?")).getByRole("button", { name: "Open the scenario chat" }));

    // Agreed for this approval: the first message goes straight through.
    await say("It merges once CI is green.");
    await waitFor(() => expect(sent(calls, "scenario:send")).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: SEND })).not.toBeInTheDocument();

    // The agent's case withdrew it; a message to a module with no approval asks nothing.
    calls.update(module({ approvedAt: null }));
    await say("And it waits while CI runs.");
    await waitFor(() => expect(sent(calls, "scenario:send")).toHaveLength(2));
    expect(screen.queryByRole("dialog", { name: SEND })).not.toBeInTheDocument();

    // Approved again — here, in the chat or anywhere — while the chat stays open.
    calls.update(module({ approvedAt: 9 }));
    const box = await say("And it refuses a draft.");
    const ask = await confirmation(SEND);
    expect(ask).toHaveTextContent("Deploy is approved.");
    expect(ask).toHaveTextContent("withdraws its approval");
    expect(ask).toHaveTextContent("steps that run Deploy stop until it is approved again");
    expect(sent(calls, "scenario:send")).toHaveLength(2);

    fireEvent.click(within(ask).getByRole("button", { name: "Keep it" }));
    expect(await screen.findByText("Not sent. Deploy keeps its approval.")).toBeInTheDocument();
    expect(box).toHaveValue("And it refuses a draft.");
    expect(sent(calls, "scenario:send")).toHaveLength(2);

    // Agreeing sends it, and the rest of this approval's messages go straight through.
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.click(within(await confirmation(SEND)).getByRole("button", { name: "Send and withdraw approval" }));
    await waitFor(() => expect(sent(calls, "scenario:send")).toHaveLength(3));
    expect((sent(calls, "scenario:send")[2] as { body: string }).body).toBe("And it refuses a draft.");
    await waitFor(() => expect(box).toHaveValue(""));
    await say("And it reports the merge commit.");
    await waitFor(() => expect(sent(calls, "scenario:send")).toHaveLength(4));
    expect(screen.queryByRole("dialog", { name: SEND })).not.toBeInTheDocument();
  });

  it("asks before a message when the chat was opened unapproved and the module is approved with it open", async () => {
    const calls = room(module({ approvedAt: null }));
    fireEvent.click(await screen.findByRole("button", { name: "Add scenario" }));
    await say("It merges once CI is green.");
    await waitFor(() => expect(sent(calls, "scenario:send")).toHaveLength(1));

    calls.update(module({ approvedAt: 7 }));
    await say("And it waits while CI runs.");
    fireEvent.click(within(await confirmation(SEND)).getByRole("button", { name: "Keep it" }));
    expect(await screen.findByText("Not sent. Deploy keeps its approval.")).toBeInTheDocument();
    expect(sent(calls, "scenario:send")).toHaveLength(1);
  });

  it("asks before answering the agent's questions on a newly approved module, and a kept approval answers nothing", async () => {
    const calls = room(module({ approvedAt: null }), [QUESTION]);
    fireEvent.click(await screen.findByRole("button", { name: "Add scenario" }));
    const chat = await screen.findByRole("dialog", { name: SCENARIOS });
    await within(chat).findByText("Which branch should it merge?");

    calls.update(module({ approvedAt: 7 }));
    fireEvent.click(within(chat).getByRole("button", { name: "main" }));
    fireEvent.click(within(await confirmation(SEND)).getByRole("button", { name: "Keep it" }));
    expect(await within(chat).findByText("Not sent. Deploy keeps its approval.")).toBeInTheDocument();
    expect(sent(calls, "scenario:answer")).toEqual([]);

    fireEvent.click(within(chat).getByRole("button", { name: "main" }));
    fireEvent.click(within(await confirmation(SEND)).getByRole("button", { name: "Send and withdraw approval" }));
    await waitFor(() => expect(sent(calls, "scenario:answer")).toEqual([{ conversationId: "conv-1", answers: [{ questionId: "q1", answer: "main" }] }]));
  });
});
