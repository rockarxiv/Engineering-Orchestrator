import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DiscussionMessage } from "@eo/core";
import { createQueryClient } from "../../query/client";
import { OfferedAnswers } from "./OfferedAnswers";

/** A guardrail stopping a draft's testing (EO-586), as the conversation view sends it. */
function stop(overrides: Partial<DiscussionMessage> = {}): DiscussionMessage {
  return {
    id: "0198a000-0000-7000-8000-000000000901",
    authorType: "engine",
    authorName: "EO",
    body: "**Testing has stopped**: 8 rounds have run.",
    kind: "escalation",
    options: ["Keep going", "Publish anyway", "Discard"],
    canAnswer: true,
    ...overrides,
  } as DiscussionMessage;
}

function mount(message: DiscussionMessage, onDone = () => {}) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <OfferedAnswers message={message} conversationId="conversation-1" onDone={onDone} />
    </QueryClientProvider>,
  );
}

describe("the answers an EO message offers in the chat", () => {
  it("draws keep going, publish anyway and discard, and files the one pressed as the reply under the message", async () => {
    const invoke = vi.fn(async (_channel: string, _payload?: unknown) => ({ ok: true, data: { commentId: "reply", resumedRun: false, delivery: null } }));
    window.eo.ipc.invoke = invoke as never;
    const onDone = vi.fn();
    mount(stop(), onDone);

    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Keep going", "Publish anyway", "Discard"]);
    fireEvent.click(screen.getByRole("button", { name: "Keep going" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("comments:post", { itemId: "conversation-1", body: "Keep going", parentId: "0198a000-0000-7000-8000-000000000901", mentions: [], pinned: false }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("draws a long answer as one button holding all its words, grown rather than fixed in height (EO-722)", () => {
    const long = "Keep going for another eight rounds, and stop to ask again only if the same check fails twice in a row.";
    mount(stop({ options: [long, "Discard"] }));

    const button = screen.getByRole("button", { name: long });
    expect(button).toHaveTextContent(long);
    expect(button.className).not.toMatch(/(^|\s)h-\[26px\]/);
    expect(button.className).toMatch(/\bmin-h-\[26px\]/);
    expect(button.className).toMatch(/\bwhitespace-normal\b/);
  });

  it("offers nothing once it has been answered", () => {
    mount(stop({ canAnswer: false }));

    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});
