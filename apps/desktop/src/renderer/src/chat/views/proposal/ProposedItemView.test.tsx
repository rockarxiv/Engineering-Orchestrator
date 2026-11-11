import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { developerRegistry, toRegistryView, type DiscussionMessage, type ProposalDetail, type ProposedAddedField } from "@eo/core";
import { ipcStub, renderSection, sent } from "../settings/org/testing";
import { ProposalCard } from "../../conversation/ProposalCard";
import { ProposedItemView } from "./ProposedItemView";

/**
 * Creating an item from a proposal with fields the project added to its
 * type (EO-735): the proposed item's view offers them empty, and what a
 * person sets there goes with the approval — from this view's Create, or
 * from the card's in the chat — and nothing they left alone does.
 */

const DEVELOPER = toRegistryView(developerRegistry());

function row(title: string, addedFields: ProposedAddedField[]) {
  return { kind: "new" as const, title, typeLabel: "Story", acceptanceCriteria: ["it works"], waitsOn: [], under: null, description: "", addedFields };
}

const ADDED = [
  { name: "automerge", label: "Automerge", kind: "boolean" as const },
  { name: "reviewers", label: "Reviewers", kind: "number" as const },
];

function detail(): ProposalDetail {
  return {
    conversationId: "conv-1",
    canApprove: true,
    container: { title: "Rate limiting", typeLabel: "Feature" },
    rows: [row("Count requests", ADDED), row("Refuse over the limit", ADDED)],
    closed: null,
    landsOn: null,
  };
}

const NOT_APPLIED = { applied: false, problem: "Not yet.", createdKeys: [], changedKeys: [], conversation: { id: "conv-1", messages: [] } };

function draw(messageId: string, index: number) {
  const stub = ipcStub({ "registry:get": DEVELOPER, "assist:proposal": { proposal: detail() }, "assist:approve": NOT_APPLIED });
  window.eo.ipc.invoke = stub.invoke as never;
  renderSection(<ProposedItemView messageId={messageId} index={index} tabKey="tab-1" />);
  return stub.calls;
}

describe("a proposed item whose type has fields added in this project", () => {
  it("offers them empty, and sends nothing for them when nobody set any", async () => {
    const calls = draw("m-empty", 0);

    expect(await screen.findByRole("region", { name: "Added in this project" })).toBeInTheDocument();
    expect(screen.getByLabelText("Automerge")).toHaveValue("");
    expect(screen.getByLabelText("Reviewers")).toHaveValue(null);

    fireEvent.click(screen.getByRole("button", { name: /^Create/ }));
    await waitFor(() => expect(sent(calls, "assist:approve")).toEqual([{ conversationId: "conv-1", messageId: "m-empty" }]));
  });

  it("sends what was set, typed by kind, for the row it was set on", async () => {
    const calls = draw("m-set", 1);

    fireEvent.change(await screen.findByLabelText("Automerge"), { target: { value: "false" } });
    fireEvent.change(screen.getByLabelText("Reviewers"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /^Create/ }));

    await waitFor(() =>
      expect(sent(calls, "assist:approve")).toEqual([{ conversationId: "conv-1", messageId: "m-set", addedFields: [{ row: 1, values: { automerge: false, reviewers: 2 } }] }]),
    );
  });

  it("takes a field back to unset when it is cleared", async () => {
    const calls = draw("m-cleared", 0);

    fireEvent.change(await screen.findByLabelText("Automerge"), { target: { value: "true" } });
    fireEvent.change(screen.getByLabelText("Automerge"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /^Create/ }));

    await waitFor(() => expect(sent(calls, "assist:approve")).toEqual([{ conversationId: "conv-1", messageId: "m-cleared" }]));
  });

  it("carries what was set on the item's view to the card's Create in the chat", async () => {
    draw("m-card", 0);
    fireEvent.change(await screen.findByLabelText("Automerge"), { target: { value: "true" } });

    const stub = ipcStub({ "registry:get": DEVELOPER, "assist:approve": NOT_APPLIED });
    window.eo.ipc.invoke = stub.invoke as never;
    const message = { id: "m-card", authorType: "agent", authorName: "Assistant", body: "", attachments: [], kind: "decision", parentId: null, runId: "run-1", options: null, canAnswer: false, createdAt: 1, canApprove: true, approves: "items", moduleSlug: null, proposedType: null, status: null, proposal: { container: detail().container, rows: detail().rows, closed: null } } as DiscussionMessage;
    renderSection(<ProposalCard message={message} conversationId="conv-1" onDone={() => undefined} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^Create/ }).at(-1)!);

    await waitFor(() => expect(sent(stub.calls, "assist:approve")).toEqual([{ conversationId: "conv-1", messageId: "m-card", addedFields: [{ row: 0, values: { automerge: true } }] }]));
  });
});
