import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderSection } from "../views/settings/org/testing";
import { AddScenario } from "./ScenarioChat";

/**
 * "+ Add scenario" on a module's page, and the chat behind it (EO-356), in
 * the chat layout. What the renderer owns is which module the chat is
 * about, the buttons, and drawing what the main process decided.
 */

const MODULE = { id: "019fb8c6-de92-7a41-9c33-4471f0c2b100", name: "Merge pull request" };

const SYSTEM_AGENT = { id: "019fb8c6-de92-7a41-9c33-4471f0c2b101", name: "System agent", role: "system", provider: "claude", model: null, enabled: true, archivedAt: null };

function message(overrides: Record<string, unknown>) {
  return {
    id: "m",
    authorType: "agent",
    authorName: "System agent",
    body: "",
    attachments: [],
    kind: "note",
    parentId: null,
    runId: "r1",
    options: null,
    canAnswer: false,
    createdAt: 1,
    canApprove: false,
    approves: null,
    proposedType: null,
    status: null,
    ...overrides,
  };
}

function conversation(messages: unknown[] = []) {
  return {
    id: "019fb8c6-de92-7a41-9c33-4471f0c2b1de",
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

function bridge(answers: Record<string, unknown> = {}, agents: unknown[] = [SYSTEM_AGENT]) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === "agents:list") return { ok: true, data: { agents } };
    if (channel in answers) return { ok: true, data: answers[channel] };
    return { ok: true, data: {} };
  });
  window.eo.ipc.invoke = invoke as never;
  return invoke;
}

describe("Add scenario, in the chat layout", () => {
  it("opens a chat about that module, and reopening shows the same conversation", async () => {
    const thread = conversation([
      message({ id: "h1", authorType: "human", authorName: "You", body: "It should merge once CI is green." }),
      message({ id: "a1", body: "Saved “merges when CI is green”. It passed." }),
    ]);
    const invoke = bridge({ "scenario:open": { conversation: thread } });
    renderSection(<AddScenario module={MODULE} />);

    // Nothing is opened, and so nothing created, until somebody presses it.
    expect(invoke.mock.calls.filter(([channel]) => channel === "scenario:open")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Add scenario" }));

    const dialog = await screen.findByRole("dialog", { name: "Scenarios for Merge pull request" });
    expect(await within(dialog).findByText("Saved “merges when CI is green”. It passed.")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("scenario:open", { moduleId: MODULE.id });

    fireEvent.click(within(dialog).getByRole("button", { name: "Close the scenario chat" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add scenario" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Add scenario" }));
    const again = await screen.findByRole("dialog", { name: "Scenarios for Merge pull request" });
    expect(await within(again).findByText("It should merge once CI is green.")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    bridge({ "scenario:open": { conversation: conversation() } });
    renderSection(<AddScenario module={MODULE} />);
    fireEvent.click(screen.getByRole("button", { name: "Add scenario" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("sends what the person describes about this module, and Clear asks for a fresh thread", async () => {
    const invoke = bridge({
      "scenario:open": { conversation: conversation([message({ id: "a1", body: "Hello." })]) },
      "scenario:send": { conversation: conversation() },
      "scenario:clear": { conversation: conversation() },
    });
    renderSection(<AddScenario module={MODULE} />);
    fireEvent.click(screen.getByRole("button", { name: "Add scenario" }));
    const dialog = await screen.findByRole("dialog");

    const box = await within(dialog).findByRole("textbox", { name: "Describe a scenario" });
    await within(dialog).findByText("Hello.");
    fireEvent.change(box, { target: { value: "When CI is red it refuses." } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("scenario:send", {
        moduleId: MODULE.id,
        conversationId: conversation().id,
        body: "When CI is red it refuses.",
        attachmentIds: [],
        interrupt: false,
      }),
    );

    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Clear" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("scenario:clear", { moduleId: MODULE.id }));
  });

  it("shows a proposed change with Apply, which is the only thing that saves it", async () => {
    const card = message({ id: "c1", kind: "decision", body: "**Proposed change to Merge pull request**", canApprove: true, approves: "changes" });
    const invoke = bridge({
      "scenario:open": { conversation: conversation([card]) },
      "scenario:apply": { applied: true, problem: null, conversation: conversation() },
    });
    renderSection(<AddScenario module={MODULE} />);
    fireEvent.click(screen.getByRole("button", { name: "Add scenario" }));
    const dialog = await screen.findByRole("dialog");

    const apply = await within(dialog).findByRole("button", { name: "Apply change" });
    expect(invoke.mock.calls.filter(([channel]) => channel === "scenario:apply")).toHaveLength(0);
    fireEvent.click(apply);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("scenario:apply", { conversationId: conversation().id, messageId: "c1" }));
  });

  it("says there is nobody to write a scenario when no system agent is enabled, and opens nothing", async () => {
    const invoke = bridge({}, []);
    renderSection(<AddScenario module={MODULE} />);
    fireEvent.click(screen.getByRole("button", { name: "Add scenario" }));
    const dialog = await screen.findByRole("dialog");

    expect(await within(dialog).findByText(/There is no enabled system agent/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox", { name: "Describe a scenario" })).not.toBeInTheDocument();
    expect(invoke.mock.calls.filter(([channel]) => channel === "scenario:open")).toHaveLength(0);
  });

  it("keeps the transcript in order, with the newest turn last", async () => {
    const thread = conversation([
      message({ id: "m1", runId: "r1", body: "Before I write it, one thing.", createdAt: 1 }),
      message({ id: "a2", runId: null, authorType: "human", authorName: "You", body: "Write it anyway.", createdAt: 2 }),
      message({ id: "m3", runId: "r3", body: "Saved “merges when CI is green”. It passed.", createdAt: 3 }),
    ]);
    bridge({ "scenario:open": { conversation: thread } });
    renderSection(<AddScenario module={MODULE} />);
    fireEvent.click(screen.getByRole("button", { name: "Add scenario" }));
    const dialog = await screen.findByRole("dialog");

    const later = await within(dialog).findByText("Saved “merges when CI is green”. It passed.");
    const first = within(dialog).getByText("Before I write it, one thing.");
    const mine = within(dialog).getByText("Write it anyway.");
    expect(first.compareDocumentPosition(mine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mine.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dialog).getByLabelText("Scenario transcript").lastElementChild).toContainElement(later);
  });

  // EO-501: a case the turn wrote withdrew the module's approval, and EO's record of it carries Approve.
  describe("when a case it wrote withdrew the module's approval", () => {
    const RECORD = message({
      id: "w1",
      authorType: "engine",
      authorName: "EO",
      body: "**Merge pull request is no longer approved.** This turn added one of its test cases.",
      approvalWithdrawn: { moduleId: MODULE.id },
    });

    /** The bridge, with the catalog answering the module's approval as it stands, and Approve's answer. */
    function catalogBridge(approve: { approved: boolean; problem: string | null }, approvedAt: number | null = null) {
      const module = { id: MODULE.id, name: MODULE.name, slug: "merge-pr", approvedAt, archivedAt: null, machineSpecific: [] };
      const invoke = vi.fn(async (channel: string) => {
        if (channel === "agents:list") return { ok: true, data: { agents: [SYSTEM_AGENT] } };
        if (channel === "scenario:open") return { ok: true, data: { conversation: conversation([RECORD]) } };
        if (channel === "modules:list") return { ok: true, data: { modules: [module] } };
        if (channel === "modules:approve") {
          if (approve.approved) module.approvedAt = 2;
          return { ok: true, data: { ...approve, coverageAcknowledgementNeeded: false, lineCoverage: null } };
        }
        return { ok: true, data: {} };
      });
      window.eo.ipc.invoke = invoke as never;
      return invoke;
    }

    async function openChat() {
      renderSection(<AddScenario module={MODULE} />);
      fireEvent.click(screen.getByRole("button", { name: "Add scenario" }));
      return screen.findByRole("dialog");
    }

    it("offers Approve under EO's record, which runs the tests and names a failing case", async () => {
      const invoke = catalogBridge({ approved: false, problem: '"Merge pull request" was not approved:\n- retries a red check: expected a retry' });
      const dialog = await openChat();

      const record = await within(dialog).findByRole("region", { name: "Approval withdrawn" });
      expect(within(record).getByText(/Merge pull request is no longer approved\./)).toBeInTheDocument();
      fireEvent.click(await within(record).findByRole("button", { name: "Approve" }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("modules:approve", { id: MODULE.id, acknowledgeLowCoverage: false }));
      expect(await within(record).findByRole("alert")).toHaveTextContent("retries a red check");
    });

    it("shows the module as approved once Approve goes through", async () => {
      catalogBridge({ approved: true, problem: null });
      const dialog = await openChat();

      const record = await within(dialog).findByRole("region", { name: "Approval withdrawn" });
      fireEvent.click(await within(record).findByRole("button", { name: "Approve" }));
      expect(await within(record).findByText(/has been approved since/)).toBeInTheDocument();
      expect(within(record).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    });

    it("offers nothing on an ordinary note from EO", async () => {
      const invoke = vi.fn(async (channel: string) => {
        if (channel === "agents:list") return { ok: true, data: { agents: [SYSTEM_AGENT] } };
        if (channel === "scenario:open") {
          return { ok: true, data: { conversation: conversation([message({ id: "n1", authorType: "engine", authorName: "EO", body: "**Passed:** “merges when CI is green”.", approvalWithdrawn: null })]) } };
        }
        if (channel === "modules:list") return { ok: true, data: { modules: [{ id: MODULE.id, name: MODULE.name, slug: "merge-pr", approvedAt: null, archivedAt: null, machineSpecific: [] }] } };
        return { ok: true, data: {} };
      });
      window.eo.ipc.invoke = invoke as never;
      const dialog = await openChat();

      await within(dialog).findByText(/merges when CI is green/);
      expect(within(dialog).queryByRole("region", { name: "Approval withdrawn" })).not.toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    });
  });

  // EO-548: a press draws the thread it answered with, without waiting for `scenario:open` again.
  describe("what a press answers with, drawn without reading the thread again", () => {
    /** `scenario:open` answers once and then never; everything else as `answers` says. */
    function openedOnce(first: unknown, answers: Record<string, unknown>) {
      let opened = false;
      const invoke = vi.fn(async (channel: string) => {
        if (channel === "agents:list") return { ok: true, data: { agents: [SYSTEM_AGENT] } };
        if (channel === "scenario:open") {
          if (opened) return new Promise<never>(() => undefined);
          opened = true;
          return { ok: true, data: { conversation: first } };
        }
        if (channel in answers) return { ok: true, data: answers[channel] };
        return { ok: true, data: {} };
      });
      window.eo.ipc.invoke = invoke as never;
      const opens = () => invoke.mock.calls.filter(([channel]) => channel === "scenario:open").length;
      return { invoke, opens };
    }

    async function openChat() {
      renderSection(<AddScenario module={MODULE} />);
      fireEvent.click(screen.getByRole("button", { name: "Add scenario" }));
      return screen.findByRole("dialog");
    }

    it("closes a question card on the last answer as soon as scenario:answer answers", async () => {
      const question = message({ id: "q1", kind: "question", body: "Which branch?", options: ["main", "release"], canAnswer: true });
      const answered = conversation([{ ...question, canAnswer: false }, message({ id: "h1", authorType: "human", authorName: "You", body: "main", parentId: "q1", runId: null, createdAt: 2 })]);
      const { invoke, opens } = openedOnce(conversation([question]), { "scenario:answer": { answered: 1, problem: null, conversation: answered } });
      const dialog = await openChat();

      const card = await within(dialog).findByRole("group", { name: "Questions from the product owner" });
      fireEvent.click(within(card).getByRole("button", { name: "main" }));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("scenario:answer", { conversationId: conversation().id, answers: [{ questionId: "q1", answer: "main" }] }));
      expect(await within(dialog).findByLabelText("Questions you answered")).toBeInTheDocument();
      expect(within(dialog).queryByRole("group", { name: "Questions from the product owner" })).not.toBeInTheDocument();
      await waitFor(() => expect(opens()).toBeGreaterThan(1));
    });

    it("closes a question card another window answered, as soon as the refused scenario:answer answers", async () => {
      const question = message({ id: "q1", kind: "question", body: "Which branch?", options: ["main", "release"], canAnswer: true });
      const elsewhere = conversation([{ ...question, canAnswer: false }, message({ id: "h1", authorType: "human", authorName: "You", body: "release", parentId: "q1", runId: null, createdAt: 2 })]);
      const refusal = "Those questions have already been answered or replaced by a newer turn. Read the latest message and answer that instead.";
      const { invoke, opens } = openedOnce(conversation([question]), { "scenario:answer": { answered: 0, problem: refusal, conversation: elsewhere } });
      const dialog = await openChat();

      const card = await within(dialog).findByRole("group", { name: "Questions from the product owner" });
      fireEvent.click(within(card).getByRole("button", { name: "main" }));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("scenario:answer", expect.objectContaining({ answers: [{ questionId: "q1", answer: "main" }] })));
      expect(await within(dialog).findByLabelText("Questions you answered")).toHaveTextContent("release");
      expect(within(dialog).queryByRole("group", { name: "Questions from the product owner" })).not.toBeInTheDocument();
      await waitFor(() => expect(opens()).toBeGreaterThan(1));
    });

    it("takes Apply away as soon as scenario:apply answers", async () => {
      const card = message({ id: "c1", kind: "decision", body: "**Proposed change to Merge pull request**", canApprove: true, approves: "changes" });
      const applied = conversation([{ ...card, canApprove: false }]);
      const { opens } = openedOnce(conversation([card]), { "scenario:apply": { applied: true, problem: null, conversation: applied } });
      const dialog = await openChat();

      fireEvent.click(await within(dialog).findByRole("button", { name: "Apply change" }));

      await waitFor(() => expect(within(dialog).queryByRole("button", { name: /Apply change|Applying…/ })).not.toBeInTheDocument());
      expect(within(dialog).getByText("Proposed change to Merge pull request")).toBeInTheDocument();
      await waitFor(() => expect(opens()).toBeGreaterThan(1));
    });
  });
});
