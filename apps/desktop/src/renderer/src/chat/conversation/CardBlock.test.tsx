import { useState } from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AssistCardDetail, AssistCardKind, AssistCardView, DiscussionMessage } from "@eo/core";
import { ipcStub, renderSection, sent } from "../views/settings/org/testing";
import { CardBlock } from "./CardBlock";

/**
 * One reply's cards as one paged block (EO-863): the pager the questions
 * use, one card on show at a time drawn as it is alone, each pressed on
 * its own — and, when they are all of one kind, "do all", which presses
 * each through the very call its own button makes.
 */

type Outcome = AssistCardView["outcome"];

/**
 * What the main process holds: each card's outcome, filed by its press.
 * A press of a card in `failing` files nothing and says why, as
 * `assist:applyCard` does when it refuses before anything is done.
 */
function server(kinds: AssistCardKind[], { outcomes = [], failing = [] }: { outcomes?: Outcome[]; failing?: number[] } = {}) {
  const filed: Outcome[] = kinds.map((_, index) => outcomes[index] ?? null);
  const message = (): DiscussionMessage => {
    const cards = kinds.map((kind, index) => ({ index, kind, outcome: filed[index] ?? null }));
    const open = cards.some((card) => card.outcome === null);
    return {
      id: "reply-1",
      authorType: "agent",
      authorName: "Assistant",
      body: "Several things.",
      attachments: [],
      kind: "decision",
      parentId: null,
      runId: "run-1",
      options: null,
      canAnswer: false,
      createdAt: 1,
      canApprove: open,
      approves: open ? "card" : null,
      moduleSlug: null,
      cards,
      proposedType: null,
      status: null,
    };
  };
  const detail = (payload: unknown): { card: AssistCardDetail; problem: null } => {
    const index = (payload as { index: number }).index;
    switch (kinds[index]) {
      case "jobDelete":
        return { card: { kind: "jobDelete", jobId: `j-${index}`, jobName: `Job ${index + 1}`, lines: [], itemCount: 2 }, problem: null };
      case "pipelineDelete":
        return { card: { kind: "pipelineDelete", pipelineId: `p-${index}`, pipelineName: `Pipeline ${index + 1}`, itemCount: 0 }, problem: null };
      case "stepSecret":
      case "stepVariable":
        return {
          card: {
            kind: kinds[index],
            pipelineId: "delivery",
            pipelineName: "Delivery",
            stepId: "deploy",
            stepName: "Deploy",
            name: `TOKEN_${index + 1}`,
            action: "clear",
            set: true,
            setAsOther: false,
            shared: null,
            organisation: false,
          },
          problem: null,
        };
      default:
        return {
          card: {
            kind: "cliToolAttach",
            agentId: `a-${index}`,
            agentName: `Agent ${index + 1}`,
            cliToolId: "c-1",
            cliToolName: "GitHub CLI",
            command: "gh",
            attached: true,
            current: false,
            archived: false,
          },
          problem: null,
        };
    }
  };
  const apply = (payload: unknown) => {
    const index = (payload as { index: number }).index;
    if (failing.includes(index)) return { applied: false, problem: `Agent ${index + 1} could not be given it.`, said: null, conversation: {} };
    const said = `Gave Agent ${index + 1} GitHub CLI.`;
    filed[index] = { done: true, said };
    return { applied: true, problem: null, said, conversation: {} };
  };
  return { message, detail, apply, filed };
}

/** The chat's row for the reply: re-read once a press is done, as the conversation's refresh does. */
function Row({ message }: { message: () => DiscussionMessage }) {
  const [, redraw] = useState(0);
  return <CardBlock message={message()} conversationId="conv-1" onDone={() => redraw((count) => count + 1)} />;
}

function draw(kinds: AssistCardKind[], options: Parameters<typeof server>[1] = {}) {
  const room = server(kinds, options);
  const stub = ipcStub({ "assist:card": room.detail, "assist:applyCard": room.apply });
  window.eo.ipc.invoke = stub.invoke as never;
  renderSection(<Row message={room.message} />);
  return { ...room, calls: stub.calls, stub };
}

const block = () => screen.getByRole("group", { name: "Cards from the assistant" });
/** The one card on show: the others are in the block, hidden. */
const shownCard = () => within(block()).getByRole("region");

describe("a reply's cards as one block", () => {
  it("pages three cards with Previous/Next, “1 of 3” and the arrow keys", async () => {
    draw(["pipelineDelete", "cliToolAttach", "pipelineDelete"]);

    expect(within(block()).getByText("1 of 3")).toBeInTheDocument();
    expect(within(block()).getByRole("button", { name: "Previous card" })).toBeDisabled();
    // One card at a time, drawn as it is alone.
    expect(within(block()).getAllByRole("region")).toHaveLength(1);
    expect(await within(shownCard()).findByText("Pipeline 1")).toBeInTheDocument();

    fireEvent.click(within(block()).getByRole("button", { name: "Next card" }));
    expect(within(block()).getByText("2 of 3")).toBeInTheDocument();
    expect(await within(shownCard()).findByText("GitHub CLI · Agent 2")).toBeInTheDocument();

    fireEvent.keyDown(block(), { key: "ArrowRight" });
    expect(within(block()).getByText("3 of 3")).toBeInTheDocument();
    expect(within(block()).getByRole("button", { name: "Next card" })).toBeDisabled();
    expect(await within(shownCard()).findByText("Pipeline 3")).toBeInTheDocument();

    fireEvent.keyDown(block(), { key: "ArrowLeft" });
    fireEvent.keyDown(block(), { key: "ArrowLeft" });
    expect(within(block()).getByText("1 of 3")).toBeInTheDocument();
    expect(within(block()).getByText("0 of 3 done")).toBeInTheDocument();
  });

  it("draws a reply with one card as that card alone, with no pager", async () => {
    draw(["pipelineDelete"]);

    expect(await screen.findByText("Pipeline 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete pipeline" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Cards from the assistant" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Previous card" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next card" })).not.toBeInTheDocument();
    expect(screen.queryByText(/of 1/)).not.toBeInTheDocument();
  });

  it("files a pressed card's outcome only, and moves on to the next card still open", async () => {
    // The second is already done, so the next open one after the first is the third.
    const { calls, filed } = draw(["pipelineDelete", "pipelineDelete", "cliToolAttach"], { outcomes: [null, { done: true, said: "Deleted Pipeline 2." }] });

    expect(within(block()).getByText("1 of 3 done")).toBeInTheDocument();
    await within(shownCard()).findByText("Pipeline 1");
    fireEvent.click(within(shownCard()).getByRole("button", { name: "Delete pipeline" }));

    await waitFor(() => expect(within(block()).getByText("3 of 3")).toBeInTheDocument());
    expect(sent(calls, "assist:applyCard")).toEqual([{ conversationId: "conv-1", messageId: "reply-1", index: 0, choices: {} }]);
    expect(filed.map((outcome) => outcome?.done ?? null)).toEqual([true, true, null]);
    expect(within(block()).getByText("2 of 3 done")).toBeInTheDocument();
    expect(await within(shownCard()).findByText("GitHub CLI · Agent 3")).toBeInTheDocument();
    expect(within(shownCard()).getByRole("button", { name: "Give CLI" })).toBeInTheDocument();

    // The pressed card shows what came of it on its own page.
    fireEvent.click(within(block()).getByRole("button", { name: "Previous card" }));
    fireEvent.click(within(block()).getByRole("button", { name: "Previous card" }));
    expect(within(shownCard()).getByText("Deleted")).toBeInTheDocument();
    expect(within(shownCard()).queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("“do all”", () => {
  it("is offered when four open cards are of one kind, counting them in its kind's own verb", async () => {
    draw(["cliToolAttach", "cliToolAttach", "cliToolAttach", "cliToolAttach"]);

    expect(await within(block()).findByRole("button", { name: "Give all (4)" })).toBeEnabled();
  });

  it("is not offered when the cards are of two kinds", async () => {
    draw(["cliToolAttach", "pipelineDelete", "cliToolAttach", "cliToolAttach"]);

    await within(shownCard()).findByText("GitHub CLI · Agent 1");
    await waitFor(() => expect(within(block()).getAllByRole("button", { hidden: true, name: /^(Give CLI|Delete pipeline)$/ })).toHaveLength(4));
    expect(within(block()).queryByRole("button", { name: / all \(/ })).not.toBeInTheDocument();
  });

  it("is not offered when only one card of one kind is still open", async () => {
    draw(["cliToolAttach", "cliToolAttach", "cliToolAttach"], {
      outcomes: [
        { done: true, said: "Gave Agent 1 GitHub CLI." },
        { done: false, said: "Agent 2 was not given it." },
      ],
    });

    await within(block()).findByRole("button", { hidden: true, name: "Give CLI" });
    expect(within(block()).queryByRole("button", { name: / all \(/ })).not.toBeInTheDocument();
  });

  it("is never offered for a step's own secret, however many are open", async () => {
    draw(["stepSecret", "stepSecret", "stepSecret"]);

    await waitFor(() => expect(within(block()).getAllByRole("button", { hidden: true, name: "Clear secret" })).toHaveLength(3));
    expect(within(block()).queryByRole("button", { name: / all \(/ })).not.toBeInTheDocument();
  });

  it("is never offered for a step's own variable, however many are open", async () => {
    draw(["stepVariable", "stepVariable"]);

    await waitFor(() => expect(within(block()).getAllByRole("button", { hidden: true, name: "Clear variable" })).toHaveLength(2));
    expect(within(block()).queryByRole("button", { name: / all \(/ })).not.toBeInTheDocument();
  });

  it("presses each open card in order through its own call; one that fails stays open with its reason, and the rest go ahead", async () => {
    const { calls, filed } = draw(["cliToolAttach", "cliToolAttach", "cliToolAttach", "cliToolAttach"], { failing: [1] });

    fireEvent.click(await within(block()).findByRole("button", { name: "Give all (4)" }));

    await waitFor(() => expect(within(block()).getByText("3 done, 1 failed")).toBeInTheDocument());
    // The very payload each card's own button sends, one card at a time, in order.
    expect(sent(calls, "assist:applyCard")).toEqual([0, 1, 2, 3].map((index) => ({ conversationId: "conv-1", messageId: "reply-1", index, choices: {} })));
    expect(filed.map((outcome) => outcome?.done ?? null)).toEqual([true, null, true, true]);

    // On the one that failed: its reason, and its own button.
    expect(within(block()).getByText("2 of 4")).toBeInTheDocument();
    expect(within(shownCard()).getByText("GitHub CLI · Agent 2")).toBeInTheDocument();
    expect(within(shownCard()).getByRole("alert")).toHaveTextContent("Agent 2 could not be given it.");
    expect(within(shownCard()).getByRole("button", { name: "Give CLI" })).toBeEnabled();
    // One open card is left, so "do all" has nothing to do.
    expect(within(block()).queryByRole("button", { name: / all \(/ })).not.toBeInTheDocument();

    // The others are done, each on its own page.
    fireEvent.click(within(block()).getByRole("button", { name: "Next card" }));
    expect(within(shownCard()).getByText("Given")).toBeInTheDocument();
    expect(within(shownCard()).getByRole("status")).toHaveTextContent("Gave Agent 3 GitHub CLI.");
  });

  it("holds every button in the block still while it runs", async () => {
    const { stub } = draw(["cliToolAttach", "cliToolAttach", "cliToolAttach"]);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    window.eo.ipc.invoke = (async (channel: string, payload: unknown) => {
      if (channel === "assist:applyCard") await gate;
      return stub.invoke(channel, payload);
    }) as never;

    fireEvent.click(await within(block()).findByRole("button", { name: "Give all (3)" }));

    await waitFor(() => expect(within(block()).getByRole("button", { name: "Giving…" })).toBeDisabled());
    for (const button of within(block()).getAllByRole("button", { hidden: true })) expect(button).toBeDisabled();
    // The arrows hold still too.
    fireEvent.keyDown(block(), { key: "ArrowRight" });
    expect(within(block()).getByText("1 of 3")).toBeInTheDocument();

    release();
    await waitFor(() => expect(within(block()).getByText("3 done")).toBeInTheDocument());
    expect(within(block()).getByRole("button", { name: "Previous card" })).toBeEnabled();
  });

  it("holds a card's own choices still while it runs", async () => {
    const { stub, calls } = draw(["jobDelete", "jobDelete"]);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    window.eo.ipc.invoke = (async (channel: string, payload: unknown) => {
      if (channel === "assist:applyCard") await gate;
      return stub.invoke(channel, payload);
    }) as never;

    const doAll = await within(block()).findByRole("button", { name: "Delete all (2)" });
    // Each job's own keep-or-archive choice, on each card.
    const choice = () => within(shownCard()).getByRole("radiogroup", { name: "What happens to the job's items" });
    fireEvent.click(within(choice()).getByRole("radio", { name: "Archive them" }));
    fireEvent.click(doAll);

    await waitFor(() => expect(within(shownCard()).getByRole("button", { name: "Deleting…" })).toBeDisabled());
    for (const radio of within(block()).getAllByRole("radio", { hidden: true })) expect(radio).toBeDisabled();
    // Neither a click nor an arrow changes what was chosen.
    fireEvent.click(within(choice()).getByRole("radio", { name: "Keep them" }));
    fireEvent.keyDown(within(choice()).getByRole("radio", { name: "Archive them" }), { key: "ArrowLeft" });
    expect(within(choice()).getByRole("radio", { name: "Archive them" })).toHaveAttribute("aria-checked", "true");

    release();
    await waitFor(() => expect(within(block()).getByText("2 done")).toBeInTheDocument());
    // The first card's choice went with its press; the second's default with its own.
    expect(sent(calls, "assist:applyCard")).toEqual([
      { conversationId: "conv-1", messageId: "reply-1", index: 0, choices: {}, archiveItems: true },
      { conversationId: "conv-1", messageId: "reply-1", index: 1, choices: {}, archiveItems: false },
    ]);
  });

  it("waits for a card pressed on its own to land, and then presses each card once", async () => {
    const { stub } = draw(["cliToolAttach", "cliToolAttach", "cliToolAttach", "cliToolAttach"]);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    /** Each press as it is sent, before any answer. */
    const pressed: number[] = [];
    window.eo.ipc.invoke = (async (channel: string, payload: unknown) => {
      if (channel === "assist:applyCard") pressed.push((payload as { index: number }).index);
      if (channel === "assist:applyCard" && (payload as { index: number }).index === 0) await gate;
      return stub.invoke(channel, payload);
    }) as never;

    const doAll = await within(block()).findByRole("button", { name: "Give all (4)" });
    await waitFor(() => expect(within(shownCard()).getByRole("button", { name: "Give CLI" })).toBeEnabled());
    fireEvent.click(within(shownCard()).getByRole("button", { name: "Give CLI" }));

    // The first card's own press is in flight: no batch can start over it.
    await waitFor(() => expect(doAll).toBeDisabled());
    fireEvent.click(doAll);
    expect(pressed).toEqual([0]);

    release();
    const rest = await within(block()).findByRole("button", { name: "Give all (3)" });
    await waitFor(() => expect(rest).toBeEnabled());
    fireEvent.click(rest);

    await waitFor(() => expect(within(block()).getByText("3 done")).toBeInTheDocument());
    expect(pressed).toEqual([0, 1, 2, 3]);
  });
});
