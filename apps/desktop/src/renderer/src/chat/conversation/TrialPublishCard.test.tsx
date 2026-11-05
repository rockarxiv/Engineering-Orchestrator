import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AssistCardDetail, DiscussionMessage } from "@eo/core";
import { ipcStub, renderSection, sent, type Answers } from "../views/settings/org/testing";
import { TrialPublishCard } from "./TrialPublishCard";

/**
 * The publish card after a draft's trials (EO-588), as the conversation
 * draws it: everything `assist:card` read from the trial, and one button,
 * `assist:publishTrial`. Where a test item did not end where it was
 * expected to, the card says which before the button.
 */

function message(outcome: { done: boolean; said: string } | null = null): DiscussionMessage {
  return {
    id: "card-1",
    authorType: "agent",
    authorName: "Assistant",
    body: "**Publish** the draft as it was tested.",
    attachments: [],
    kind: "decision",
    parentId: null,
    runId: "run-1",
    options: null,
    canAnswer: false,
    createdAt: 1,
    canApprove: outcome === null,
    approves: outcome === null ? "card" : null,
    moduleSlug: null,
    card: { kind: "trialPublish", outcome },
    proposedType: null,
    status: null,
  };
}

const step = (id: string, position: number, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  pipelineId: "",
  position,
  name,
  type: "user",
  ownerRole: null,
  entryAction: null,
  instructionsSummary: null,
  isTerminal: false,
  planMode: false,
  opensPullRequest: false,
  results: [],
  ...extra,
});

function detail(overrides: Partial<Extract<AssistCardDetail, { kind: "trialPublish" }>> = {}): Extract<AssistCardDetail, { kind: "trialPublish" }> {
  return {
    kind: "trialPublish",
    trialPipelineId: "trial-1",
    targetPipelineId: null,
    pipelineName: "Hotfix",
    round: 2,
    steps: [step("hf_deploy", 0, "Deploy", { type: "module", entryAction: "mod-1" }), step("hf_check", 1, "Check"), step("hf_done", 2, "Done", { isTerminal: true })] as never,
    routes: [],
    entryStepId: "hf_deploy",
    changes: ['the instructions of "Fix"'],
    modules: [{ id: "mod-1", slug: "deploy", name: "Deploy", codeChanged: true, needsChanged: true, replaces: null }],
    stepOutcomes: [
      { stepId: "hf_deploy", name: "Deploy", outcome: "mocked", reason: "It deploys to production." },
      { stepId: "hf_check", name: "Check", outcome: "tested", reason: null },
      { stepId: "hf_fix", name: "Fix", outcome: "not_run", reason: "It works on a branch of its own." },
      { stepId: "hf_done", name: "Done", outcome: "tested", reason: null },
    ],
    items: [
      { itemKey: "HOM-1", title: "Fix the login", expectedStepName: "Done", criteria: "the login works", endedStepName: "Done", result: "approve", verdict: "passed" },
      { itemKey: "HOM-2", title: "Drop the users table", expectedStepName: "Dropped", criteria: null, endedStepName: "Done", result: "approve", verdict: "failed" },
    ],
    onBehalf: [{ kind: "pressed", itemKey: "HOM-1", stepName: "Check", asked: null, answer: "Approve", choices: ["Approve", "Reject"] }],
    publishAnyway: true,
    problem: null,
    ...overrides,
  };
}

const PUBLISHED = { saved: true, pipelineId: "p-1", created: true, problem: null, modules: [], coverage: [] };

function draw(card: DiscussionMessage, read: AssistCardDetail | null, answers: Answers = {}) {
  const stub = ipcStub({ "assist:card": { card: read, problem: null }, "modules:list": { modules: [] }, ...answers });
  window.eo.ipc.invoke = stub.invoke as never;
  const onDone = vi.fn();
  renderSection(<TrialPublishCard message={card} conversationId="conv-1" onDone={onDone} />);
  return { calls: stub.calls, onDone };
}

describe("the publish card after trials", () => {
  it("never calls a mocked step tested, and marks a module whose needs changed apart from one whose code did", async () => {
    draw(message(), detail());
    const steps = await screen.findByRole("region", { name: "How each step was tested" });
    expect(within(steps).getByText("Deploy").parentElement).toHaveTextContent("Mocked — never ran");
    expect(within(steps).getByText("Check").parentElement).toHaveTextContent("Tested");
    // Reached and never run is never tested either.
    expect(within(steps).getByText("Fix").parentElement).toHaveTextContent("Reached, never ran");
    expect(screen.getByText("Needs changed since you approved")).toBeInTheDocument();
    expect(screen.getByText("Code changed since you approved")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Changed since you approved" })).getByText('the instructions of "Fix"')).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Answered on your behalf" })).getByText(/the assistant pressed/)).toHaveTextContent("Approve");
  });

  it("says which test items did not end where they were expected to before the button, and the button says Publish anyway", async () => {
    const { calls, onDone } = draw(message(), detail(), { "assist:publishTrial": PUBLISHED });
    const failed = await screen.findByRole("region", { name: "Test items that failed" });
    expect(failed).toHaveTextContent("HOM-2 “Drop the users table” — expected to end on Dropped, ended on Done");
    expect(failed).not.toHaveTextContent("HOM-1");
    const button = screen.getByRole("button", { name: "Publish anyway" });
    // Before the button, in the order a person reads them.
    expect(failed.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(button);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sent(calls, "assist:publishTrial")).toEqual([{ conversationId: "conv-1", messageId: "card-1", acknowledgeLowCoverage: [] }]);
    expect(sent(calls, "assist:applyCard")).toEqual([]);
  });

  it("offers Approve and publish where every test item ended where expected, and no button while the card cannot be pressed", async () => {
    const passing = detail({ items: [detail().items[0]!], publishAnyway: false });
    draw(message(), passing);
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve and publish" })).toBeEnabled());
    expect(screen.queryByRole("region", { name: "Test items that failed" })).not.toBeInTheDocument();
  });

  it("holds the button while EO says it cannot be pressed, saying why", async () => {
    draw(message(), detail({ problem: "Testing has stopped and waits for your answer — keep going, publish anyway or discard. Answer it first." }));
    expect(await screen.findByText(/Testing has stopped/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish anyway" })).toBeDisabled();
  });

  it("shows what came of it once pressed, with no button left", async () => {
    draw(message({ done: true, said: "**Published Hotfix** as a new pipeline." }), null);
    expect(await screen.findByText(/as a new pipeline/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
