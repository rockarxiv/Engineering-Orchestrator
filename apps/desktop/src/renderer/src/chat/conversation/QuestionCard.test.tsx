import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DiscussionMessage } from "@eo/core";
import { QuestionCard, questionsFrom, transcriptRows, type TranscriptRow } from "./QuestionCard";

// The grouping is the classic helpers re-exported, held here to the same cases so
// a drift between the two cards could not go unnoticed.

function message(overrides: Partial<DiscussionMessage> = {}): DiscussionMessage {
  return {
    id: "m1",
    authorType: "agent",
    authorName: "Product Owner",
    body: "Per API key or per account?",
    attachments: [],
    kind: "note",
    parentId: null,
    runId: null,
    options: null,
    canAnswer: false,
    createdAt: 1_000,
    canApprove: false,
    approves: null,
    moduleSlug: null,
    proposedType: null,
    status: null,
    ...overrides,
  };
}

function question(overrides: Partial<DiscussionMessage> = {}): DiscussionMessage {
  return message({ kind: "question", options: ["per key", "per account"], ...overrides });
}

describe("questionsFrom", () => {
  it("keeps each turn's questions in a batch of their own", () => {
    const { live, closed } = questionsFrom([
      question({ id: "q1", runId: "run-1", body: "Per API key or per account?", createdAt: 1 }),
      question({ id: "q2", runId: "run-1", body: "Which window?", createdAt: 2 }),
      message({ id: "a1", authorType: "human", authorName: "You", body: "per key", parentId: "q1", createdAt: 3 }),
      question({ id: "q3", runId: "run-2", body: "Per API key, or per account?", createdAt: 4 }),
    ]);

    expect(live).toEqual([]);
    // Two turns, two batches — not one five-row block holding two
    // rewordings of the same question (EO-338).
    expect(closed.map((batch) => batch.questions.map((asked) => asked.id))).toEqual([["q1", "q2"], ["q3"]]);
    expect(closed.map((batch) => batch.id)).toEqual(["run-1", "run-2"]);
    expect(closed[0]!.questions[0]!.answer).toBe("per key");
    expect(closed[0]!.questions[1]!.answer).toBeNull();
  });

  it("batches come back in the order they were asked", () => {
    const { closed } = questionsFrom([
      question({ id: "q1", runId: "run-1", createdAt: 1 }),
      question({ id: "q2", runId: "run-2", createdAt: 2 }),
      question({ id: "q3", runId: "run-3", createdAt: 3 }),
    ]);

    expect(closed.map((batch) => batch.id)).toEqual(["run-1", "run-2", "run-3"]);
  });

  it("leaves a question with no run standing alone rather than pooling it", () => {
    const { closed } = questionsFrom([
      question({ id: "q1", runId: null, createdAt: 1 }),
      question({ id: "q2", runId: null, createdAt: 2 }),
    ]);

    expect(closed.map((batch) => batch.questions.map((asked) => asked.id))).toEqual([["q1"], ["q2"]]);
  });

  it("holds the live batch flat, since the main process already scopes it to one run", () => {
    const { live, closed } = questionsFrom([
      question({ id: "q1", runId: "run-1", createdAt: 1 }),
      question({ id: "q2", runId: "run-2", canAnswer: true, createdAt: 2 }),
      question({ id: "q3", runId: "run-2", canAnswer: true, createdAt: 3 }),
    ]);

    expect(live.map((asked) => asked.id)).toEqual(["q2", "q3"]);
    expect(closed).toHaveLength(1);
  });

  it("ignores questions a person asked and notes the agent wrote", () => {
    const { live, closed } = questionsFrom([
      question({ id: "q1", authorType: "human", authorName: "You", runId: null, createdAt: 1 }),
      message({ id: "n1", runId: "run-1", createdAt: 2 }),
    ]);

    expect(live).toEqual([]);
    expect(closed).toEqual([]);
  });
});

/** A row as the id a test can read: the message's, or `[the batch's question ids]`. */
function shape(row: TranscriptRow): string {
  if (row.kind === "message") return row.message.id;
  return `${row.live ? "live" : "closed"}[${row.batch.questions.map((asked) => asked.id).join(",")}]`;
}

describe("transcriptRows", () => {
  it("puts each batch where its first question was asked, not after the thread", () => {
    const rows = transcriptRows([
      message({ id: "m1", body: "Let me check a few things.", createdAt: 1 }),
      question({ id: "q1", runId: "run-1", createdAt: 2 }),
      question({ id: "q2", runId: "run-1", createdAt: 3 }),
      message({ id: "a1", authorType: "human", authorName: "You", body: "per key", parentId: "q1", createdAt: 4 }),
      message({ id: "m2", body: "Approved. Created EO-1.", createdAt: 5 }),
      question({ id: "q3", runId: "run-2", createdAt: 6 }),
      message({ id: "m3", body: "Done.", createdAt: 7 }),
      question({ id: "q4", runId: "run-3", canAnswer: true, createdAt: 8 }),
      question({ id: "q5", runId: "run-3", canAnswer: true, createdAt: 9 }),
    ]);

    // The pile this replaced: m1, a1, m2, m3, then every card (EO-362).
    expect(rows.map(shape)).toEqual(["m1", "closed[q1,q2]", "a1", "m2", "closed[q3]", "m3", "live[q4,q5]"]);
  });

  it("keys the live batch on its first question, so a new batch is a new card", () => {
    const rows = transcriptRows([question({ id: "q1", runId: "run-1", canAnswer: true })]);
    expect(rows).toEqual([{ kind: "questions", live: true, batch: { id: "q1", questions: [expect.objectContaining({ id: "q1" })] } }]);
  });

  it("drops a question a person asked, as the batches do", () => {
    const rows = transcriptRows([question({ id: "q1", authorType: "human", authorName: "You" }), message({ id: "m1" })]);
    expect(rows.map(shape)).toEqual(["m1"]);
  });
});

describe("the closed question card", () => {
  const asked = (overrides: Partial<{ id: string; body: string; options: string[]; answer: string | null }> = {}) => ({
    id: "q1",
    body: "Per API key or per account?",
    options: ["per key", "per account"],
    answer: null,
    ...overrides,
  });

  const closedCard = (questions: ReturnType<typeof asked>[]) =>
    render(<QuestionCard questions={questions} live={false} busy={false} onSubmit={async () => undefined} />);

  it("does not announce a batch nobody answered as one you answered", () => {
    closedCard([asked({ id: "q1" }), asked({ id: "q2", body: "Which window?" })]);

    expect(screen.getByLabelText("Questions that closed unanswered")).toBeInTheDocument();
    expect(screen.queryByLabelText("Questions you answered")).not.toBeInTheDocument();
  });

  it("says so when only some of the batch was answered", () => {
    closedCard([asked({ id: "q1", answer: "per key" }), asked({ id: "q2", body: "Which window?" })]);

    expect(screen.getByLabelText("Questions you partly answered")).toBeInTheDocument();
  });

  it("keeps the answered label when every question was answered", () => {
    closedCard([asked({ id: "q1", answer: "per key" })]);

    expect(screen.getByLabelText("Questions you answered")).toBeInTheDocument();
  });

  it("marks an unanswered row differently from an answered one", () => {
    const { container } = closedCard([asked({ id: "q1", answer: "per key" }), asked({ id: "q2", body: "Which window?" })]);

    const markers = [...container.querySelectorAll("span[aria-hidden].rounded-full")];
    expect(markers).toHaveLength(2);
    // A decision is a filled mark; one never made is an empty ring.
    // The old card ticked both and then printed "Not answered" beside
    // the second (EO-338). Neutral rather than the accent, which marks
    // only what can be pressed (EO-689).
    expect(markers[0]!.className).toContain("bg-canvas-active");
    expect(markers[0]!.className).not.toMatch(/accent/);
    expect(markers[1]!.className).not.toContain("bg-canvas-active");
    expect(markers[1]!.className).toContain("border-line");
    expect(screen.getByText("Not answered")).toBeInTheDocument();
  });

  it("keeps the options a closed question was asked with, and marks the one picked", () => {
    closedCard([asked({ id: "q1", answer: "per key" }), asked({ id: "q2", body: "Which window?", options: ["an hour", "a day"] })]);

    const [first, second] = screen.getAllByLabelText("Suggested answers");
    expect([...within(first!).getAllByRole("listitem")].map((item) => item.textContent)).toEqual(["per key", "per account"]);
    // Nothing was picked here, and the record still shows what was on offer.
    expect([...within(second!).getAllByRole("listitem")].map((item) => item.textContent)).toEqual(["an hour", "a day"]);
    expect(within(first!).getByText("per key").closest("li")!.className).toContain("bg-accent-subtle");
    expect(within(first!).getByText("per account").closest("li")!.className).not.toContain("bg-accent-subtle");
  });

  it("offers nothing to click — a closed batch is a record, not a question", () => {
    closedCard([asked({ id: "q1" })]);

    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});

describe("the live question card", () => {
  const batch = [
    { id: "q1", body: "Per API key or per account?\n_This decides the limiter's key._", options: ["per key", "per account"], answer: null },
    { id: "q2", body: "Which window?", options: ["an hour", "a day"], answer: null },
  ];

  const liveCard = (onSubmit: (answers: { questionId: string; answer: string | null }[]) => Promise<unknown> = vi.fn(async () => undefined), busy = false) =>
    render(<QuestionCard questions={batch} live busy={busy} onSubmit={onSubmit} />);

  it("takes focus when it arrives, one question on it at a time, with the why under it", () => {
    liveCard();
    const card = screen.getByRole("group", { name: "Questions from the product owner" });

    expect(card).toHaveFocus();
    expect(within(card).getByText("Per API key or per account?")).toBeInTheDocument();
    expect(within(card).getByText("This decides the limiter's key.")).toBeInTheDocument();
    expect(within(card).getByText("1 of 2")).toBeInTheDocument();
    expect(within(card).queryByText("Which window?")).not.toBeInTheDocument();
  });

  it("sends nothing until the last answer, then sends the set together", async () => {
    const onSubmit = vi.fn(async () => undefined);
    liveCard(onSubmit);

    fireEvent.click(screen.getByRole("button", { name: "per account" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Which window?")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 answered — the product owner reads them together")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "a day" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith([
        { questionId: "q1", answer: "per account" },
        { questionId: "q2", answer: "a day" },
      ]),
    );
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("answers with the number keys and moves with the arrows", async () => {
    const onSubmit = vi.fn(async () => undefined);
    liveCard(onSubmit);
    const card = screen.getByRole("group", { name: "Questions from the product owner" });

    fireEvent.keyDown(card, { key: "ArrowRight" });
    expect(screen.getByText("Which window?")).toBeInTheDocument();
    fireEvent.keyDown(card, { key: "ArrowLeft" });
    expect(screen.getByText("Per API key or per account?")).toBeInTheDocument();

    fireEvent.keyDown(card, { key: "1" });
    // A number past the options is not an answer.
    fireEvent.keyDown(card, { key: "3" });
    fireEvent.keyDown(card, { key: "2" });

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith([
        { questionId: "q1", answer: "per key" },
        { questionId: "q2", answer: "a day" },
      ]),
    );
  });

  it("moves between questions on its own buttons", () => {
    liveCard();

    expect(screen.getByRole("button", { name: "Previous question" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next question" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Previous question" }));
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("takes an answer in the person's own words, and lets Escape put it down", async () => {
    const onSubmit = vi.fn(async () => undefined);
    liveCard(onSubmit);

    fireEvent.click(screen.getByRole("button", { name: "Something else" }));
    const own = screen.getByRole("textbox", { name: "Answer in your own words" });
    expect(own).toHaveFocus();
    fireEvent.change(own, { target: { value: "never mind" } });
    fireEvent.keyDown(own, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Answer in your own words" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Something else" }));
    // An empty answer is not one.
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Answer in your own words" }), { key: "Enter" });
    expect(screen.getByText("Per API key or per account?")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Answer in your own words" }), { target: { value: "  per team  " } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Answer in your own words" }), { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith([
        { questionId: "q1", answer: "per team" },
        { questionId: "q2", answer: null },
      ]),
    );
  });

  it("skips whatever is left on the ✕, and sends the batch anyway", async () => {
    const onSubmit = vi.fn(async () => undefined);
    liveCard(onSubmit);

    fireEvent.click(screen.getByRole("button", { name: "per key" }));
    const skipRest = screen.getByRole("button", { name: "Skip the rest" });
    expect(skipRest).toHaveAttribute("title", "Skip whatever is left and let the product owner decide");
    fireEvent.click(skipRest);

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith([
        { questionId: "q1", answer: "per key" },
        { questionId: "q2", answer: null },
      ]),
    );
  });

  it("keeps every pick on screen when the send fails, and says why", async () => {
    liveCard(async () => {
      throw new Error("The run has already moved on.");
    });

    fireEvent.click(screen.getByRole("button", { name: "per key" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "an hour" }));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("The run has already moved on.");
    // The last question is still the one showing, with its pick marked.
    expect(screen.getByText("Which window?")).toBeInTheDocument();
  });

  it("closes on the last answer at once, drawn from the picks and marked as sending (EO-549)", async () => {
    let land: () => void = () => undefined;
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => (land = resolve)));
    const { rerender } = liveCard(onSubmit);

    fireEvent.click(screen.getByRole("button", { name: "per account" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    // Before the answer has landed: the closed form, with what was picked, saying it is on its way.
    const closed = screen.getByLabelText("Questions you partly answered");
    expect(closed).toHaveAttribute("aria-busy", "true");
    expect(within(closed).getByRole("status")).toHaveTextContent("Sending your answers…");
    expect(within(closed).getByText("per account", { selector: "p" })).toBeInTheDocument();
    expect(within(closed).getByText("Not answered")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Questions from the product owner" })).not.toBeInTheDocument();

    // Landed, and still closed while the conversation that closed it is on its way…
    await act(async () => land());
    expect(screen.getByLabelText("Questions you partly answered")).not.toHaveAttribute("aria-busy");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Questions from the product owner" })).not.toBeInTheDocument();

    // …and the record once it is.
    rerender(
      <QuestionCard questions={[{ ...batch[0]!, answer: "per account" }, { ...batch[1]! }]} live={false} busy={false} onSubmit={onSubmit} />,
    );
    expect(screen.getByLabelText("Questions you partly answered")).not.toHaveAttribute("aria-busy");
  });

  it("is live again with every pick kept and the reason shown when the answer is refused (EO-549)", async () => {
    let refuse: (error: Error) => void = () => undefined;
    const onSubmit = vi.fn(() => new Promise<void>((_resolve, reject) => (refuse = reject)));
    liveCard(onSubmit);

    fireEvent.click(screen.getByRole("button", { name: "per key" }));
    fireEvent.click(screen.getByRole("button", { name: "an hour" }));
    expect(screen.getByLabelText("Questions you answered")).toHaveAttribute("aria-busy", "true");

    await act(async () => refuse(new Error("The database is locked.")));

    const card = screen.getByRole("group", { name: "Questions from the product owner" });
    expect(within(card).getByRole("alert")).toHaveTextContent("The database is locked.");
    expect(card).toHaveFocus();
    expect(screen.queryByLabelText("Questions you answered")).not.toBeInTheDocument();
    // Both picks are still on the card: sending what is left to answer sends them again, unchanged.
    fireEvent.click(within(card).getByRole("button", { name: "Skip the rest" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit).toHaveBeenLastCalledWith([
      { questionId: "q1", answer: "per key" },
      { questionId: "q2", answer: "an hour" },
    ]);
  });

  it("opens again when the conversation still asks after an answer landed", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const { rerender } = liveCard(onSubmit);

    fireEvent.click(screen.getByRole("button", { name: "per key" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "an hour" }));
    });
    expect(screen.queryByRole("group", { name: "Questions from the product owner" })).not.toBeInTheDocument();

    // A newer drawing of the same card, still live: the answer did not close it after all.
    rerender(<QuestionCard questions={batch.map((asked) => ({ ...asked }))} live busy={false} onSubmit={onSubmit} />);
    expect(await screen.findByRole("group", { name: "Questions from the product owner" })).toBeInTheDocument();
  });

  it("holds every control while the conversation is busy", () => {
    const onSubmit = vi.fn(async () => undefined);
    liveCard(onSubmit, true);
    const card = screen.getByRole("group", { name: "Questions from the product owner" });

    expect(screen.getByRole("button", { name: "per key" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Skip" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Skip the rest" })).toBeDisabled();
    fireEvent.keyDown(card, { key: "1" });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
