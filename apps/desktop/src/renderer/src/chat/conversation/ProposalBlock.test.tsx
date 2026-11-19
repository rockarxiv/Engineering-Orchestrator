import { useState } from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { developerRegistry, toRegistryView, type DiscussionMessage, type ProposalSummary } from "@eo/core";
import { ipcStub, renderSection, sent } from "../views/settings/org/testing";
import { ProposalBlock, withProposalBlocks } from "./ProposalBlock";
import type { TranscriptRow } from "./QuestionCard";

/**
 * One reply's work proposals as one paged block (EO-864): the pager a
 * reply's cards use, one proposal on show at a time drawn as it is alone,
 * each approved on its own — and "Approve all", which approves each
 * through the very call its own button makes.
 */

function proposal(id: string, { runId = "run-1", canApprove = true, closed = null }: { runId?: string; canApprove?: boolean; closed?: ProposalSummary["closed"] } = {}): DiscussionMessage {
  return {
    id,
    authorType: "agent",
    authorName: "Assistant",
    body: `The prose of ${id}.`,
    attachments: [],
    kind: "decision",
    parentId: null,
    runId,
    options: null,
    canAnswer: false,
    createdAt: 1,
    canApprove,
    approves: canApprove ? "items" : null,
    moduleSlug: null,
    proposedType: null,
    status: null,
    proposal: {
      container: null,
      rows: [{ kind: "new", title: `Work of ${id}`, typeLabel: "Story", acceptanceCriteria: ["it works"], waitsOn: [], under: null }],
      closed,
    },
  };
}

/**
 * What the main process holds: each proposal, approved by its press. A
 * press of one in `failing` applies nothing and says why, and the
 * proposal is left as it was.
 */
function server(ids: string[], { approved = [], failing = [] }: { approved?: string[]; failing?: string[] } = {}) {
  const applied = new Set(approved);
  const messages = () => ids.map((id) => (applied.has(id) ? proposal(id, { canApprove: false, closed: "applied" }) : proposal(id)));
  const approve = (payload: unknown) => {
    const id = (payload as { messageId: string }).messageId;
    const conversation = { id: "conv-1", messages: [] };
    if (failing.includes(id)) return { applied: false, problem: `${id} could not be created.`, createdKeys: [], changedKeys: [], conversation };
    applied.add(id);
    return { applied: true, problem: null, createdKeys: ["EO-1"], changedKeys: [], conversation };
  };
  return { messages, approve, applied };
}

/** The chat's row for the reply: re-read once a press is done, as the conversation's refresh does. */
function Row({ messages }: { messages: () => DiscussionMessage[] }) {
  const [, redraw] = useState(0);
  return <ProposalBlock messages={messages()} conversationId="conv-1" onDone={() => redraw((count) => count + 1)} />;
}

function draw(ids: string[], options: Parameters<typeof server>[1] = {}) {
  const room = server(ids, options);
  const stub = ipcStub({ "registry:get": toRegistryView(developerRegistry()), "assist:approve": room.approve });
  window.eo.ipc.invoke = stub.invoke as never;
  renderSection(<Row messages={room.messages} />);
  return { ...room, calls: stub.calls, stub };
}

const block = () => screen.getByRole("group", { name: "Proposals from the assistant" });
/** The one proposal on show: the others are in the block, hidden. */
const shown = () => within(block()).getByRole("region", { name: "Proposal" });

describe("a reply's proposals as one block", () => {
  it("pages three proposals, each with its own rows and its own working button", async () => {
    const { calls, applied } = draw(["p1", "p2", "p3"]);

    expect(within(block()).getByText("1 of 3")).toBeInTheDocument();
    expect(within(block()).getAllByRole("region", { name: "Proposal" })).toHaveLength(1);
    expect(within(shown()).getByRole("link", { name: /Work of p1/ })).toHaveAttribute("href", "/proposals/p1/0");
    expect(await within(shown()).findByRole("button", { name: "Create ticket" })).toBeEnabled();

    fireEvent.click(within(block()).getByRole("button", { name: "Next proposal" }));
    expect(within(block()).getByText("2 of 3")).toBeInTheDocument();
    expect(within(shown()).getByRole("link", { name: /Work of p2/ })).toHaveAttribute("href", "/proposals/p2/0");

    fireEvent.keyDown(block(), { key: "ArrowRight" });
    expect(within(block()).getByText("3 of 3")).toBeInTheDocument();
    expect(within(shown()).getByRole("link", { name: /Work of p3/ })).toHaveAttribute("href", "/proposals/p3/0");
    fireEvent.keyDown(block(), { key: "ArrowLeft" });

    // Its own button approves that proposal only, and the block moves on to the next one open.
    fireEvent.click(within(shown()).getByRole("button", { name: "Create ticket" }));
    await waitFor(() => expect(within(block()).getByText("3 of 3")).toBeInTheDocument());
    expect(sent(calls, "assist:approve")).toEqual([{ conversationId: "conv-1", messageId: "p2" }]);
    expect([...applied]).toEqual(["p2"]);
    expect(within(block()).getByText("1 of 3 done")).toBeInTheDocument();
    fireEvent.click(within(block()).getByRole("button", { name: "Previous proposal" }));
    expect(within(shown()).getByText("Approved.")).toBeInTheDocument();
    expect(within(shown()).queryByRole("button")).not.toBeInTheDocument();
  });

  it("draws a reply with one proposal as that card alone, with no pager", async () => {
    draw(["p1"]);

    expect(await screen.findByRole("button", { name: "Create ticket" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Proposal" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Work of p1/ })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Proposals from the assistant" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next proposal" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve all/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/of 1/)).not.toBeInTheDocument();
  });
});

describe("“Approve all”", () => {
  it("approves each open proposal in order through its own call; one that fails stays open with its reason, and the rest go ahead", async () => {
    const { calls, applied } = draw(["p1", "p2", "p3"], { failing: ["p2"] });

    fireEvent.click(await within(block()).findByRole("button", { name: "Approve all (3)" }));

    await waitFor(() => expect(within(block()).getByText("2 done, 1 failed")).toBeInTheDocument());
    // The very payload each proposal's own button sends, one at a time, in order.
    expect(sent(calls, "assist:approve")).toEqual(["p1", "p2", "p3"].map((messageId) => ({ conversationId: "conv-1", messageId })));
    expect([...applied]).toEqual(["p1", "p3"]);

    // On the one that failed: its reason, and its own button.
    expect(within(block()).getByText("2 of 3")).toBeInTheDocument();
    expect(within(shown()).getByRole("link", { name: /Work of p2/ })).toBeInTheDocument();
    expect(within(shown()).getByText("p2 could not be created.")).toBeInTheDocument();
    expect(within(shown()).getByRole("button", { name: "Create ticket" })).toBeEnabled();
    // One is left open, so there is nothing for "Approve all" to do.
    expect(within(block()).queryByRole("button", { name: /Approve all/ })).not.toBeInTheDocument();

    // The others are approved, each on its own page.
    fireEvent.click(within(block()).getByRole("button", { name: "Next proposal" }));
    expect(within(shown()).getByText("Approved.")).toBeInTheDocument();
    fireEvent.click(within(block()).getByRole("button", { name: "Previous proposal" }));
    fireEvent.click(within(block()).getByRole("button", { name: "Previous proposal" }));
    expect(within(shown()).getByText("Approved.")).toBeInTheDocument();
  });

  it("is offered for two open proposals, counting only those", async () => {
    draw(["p1", "p2", "p3"], { approved: ["p1"] });

    expect(await within(block()).findByRole("button", { name: "Approve all (2)" })).toBeEnabled();
  });

  it("is not offered when fewer than two proposals are open", async () => {
    draw(["p1", "p2", "p3"], { approved: ["p1", "p3"] });

    await within(block()).findByRole("button", { hidden: true, name: "Create ticket" });
    expect(within(block()).queryByRole("button", { name: /Approve all/ })).not.toBeInTheDocument();
  });

  it("holds every button in the block still while it runs", async () => {
    const { stub } = draw(["p1", "p2", "p3"]);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    window.eo.ipc.invoke = (async (channel: string, payload: unknown) => {
      if (channel === "assist:approve") await gate;
      return stub.invoke(channel, payload);
    }) as never;

    fireEvent.click(await within(block()).findByRole("button", { name: "Approve all (3)" }));

    await waitFor(() => expect(within(block()).getByRole("button", { name: "Applying…" })).toBeDisabled());
    for (const button of within(block()).getAllByRole("button", { hidden: true })) expect(button).toBeDisabled();
    fireEvent.keyDown(block(), { key: "ArrowRight" });
    expect(within(block()).getByText("1 of 3")).toBeInTheDocument();

    release();
    await waitFor(() => expect(within(block()).getByText("3 done")).toBeInTheDocument());
    expect(within(block()).getByRole("button", { name: "Previous proposal" })).toBeEnabled();
  });

  it("waits for a proposal approved on its own to land, and then approves each once", async () => {
    const { stub } = draw(["p1", "p2", "p3"]);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    /** Each approval as it is sent, before any answer. */
    const pressed: string[] = [];
    window.eo.ipc.invoke = (async (channel: string, payload: unknown) => {
      const id = (payload as { messageId?: string } | undefined)?.messageId;
      if (channel === "assist:approve") pressed.push(id!);
      if (channel === "assist:approve" && id === "p1") await gate;
      return stub.invoke(channel, payload);
    }) as never;

    const all = await within(block()).findByRole("button", { name: "Approve all (3)" });
    fireEvent.click(await within(shown()).findByRole("button", { name: "Create ticket" }));

    // The first one's own approval is in flight: no batch starts over it.
    await waitFor(() => expect(all).toBeDisabled());
    fireEvent.click(all);
    expect(pressed).toEqual(["p1"]);

    release();
    const rest = await within(block()).findByRole("button", { name: "Approve all (2)" });
    await waitFor(() => expect(rest).toBeEnabled());
    fireEvent.click(rest);

    await waitFor(() => expect(within(block()).getByText("2 done")).toBeInTheDocument());
    expect(pressed).toEqual(["p1", "p2", "p3"]);
  });
});

describe("withProposalBlocks", () => {
  const row = (message: DiscussionMessage): TranscriptRow => ({ kind: "message", message });
  const note = (id: string, runId: string): DiscussionMessage => ({ ...proposal(id, { runId, canApprove: false }), kind: "note", proposal: null });
  const shape = (rows: ReturnType<typeof withProposalBlocks>) =>
    rows.map((each) => (each.kind === "proposals" ? each.messages.map((message) => message.id) : each.kind === "message" ? each.message.id : "questions"));

  it("gathers each reply's proposals into one row where its first stood, and never merges two replies", () => {
    const rows = [
      row(note("said-a", "run-a")),
      row(proposal("a1", { runId: "run-a" })),
      row(proposal("a2", { runId: "run-a" })),
      row(note("said-b", "run-b")),
      row(proposal("b1", { runId: "run-b" })),
      row(proposal("b2", { runId: "run-b", canApprove: false, closed: "applied" })),
      row(proposal("b3", { runId: "run-b" })),
    ];

    expect(shape(withProposalBlocks(rows))).toEqual(["said-a", ["a1", "a2"], "said-b", ["b1", "b2", "b3"]]);
  });

  it("keeps a reply with one proposal as the message row it always was", () => {
    const rows = [row(proposal("a1", { runId: "run-a" })), row(proposal("b1", { runId: "run-b" })), row(proposal("b2", { runId: "run-b" }))];

    expect(shape(withProposalBlocks(rows))).toEqual(["a1", ["b1", "b2"]]);
  });
});
