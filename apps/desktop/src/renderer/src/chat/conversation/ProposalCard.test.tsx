import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { developerRegistry, toRegistryView, type DiscussionMessage, type ProposalSummary, type RegistryView } from "@eo/core";
import { ipcStub, renderSection, sent, type Answers } from "../views/settings/org/testing";
import { ProposalCard } from "./ProposalCard";

/**
 * A work proposal in the conversation, as compact rows (EO-407).
 *
 * The card is given a message and draws `message.proposal` — the
 * structured proposal the main process read off the run. Every case hands
 * it a body full of prose it must not draw, because the point of the card
 * is that the rows are the data and the body is not parsed.
 */

const DEVELOPER: RegistryView = toRegistryView(developerRegistry());

/** A project that also has a support pack, so no word is both packs' and the chrome says "item". */
const TWO_PACKS: RegistryView = {
  ...DEVELOPER,
  itemTypes: [
    ...DEVELOPER.itemTypes,
    { ...DEVELOPER.itemTypes.find((type) => !type.container)!, packSlug: "support", slug: "case", label: "Case" },
  ],
};

const PROSE = "**Rate limiting** — a new feature.\n\nBODY-ONE per key, per minute.\n\nBODY-TWO answer 429.";

function proposed(title: string, overrides: Partial<Extract<ProposalSummary["rows"][number], { kind: "new" }>> = {}) {
  return { kind: "new" as const, title, typeLabel: "Story", acceptanceCriteria: ["it works"], waitsOn: [], under: null, ...overrides };
}

const PLAN: ProposalSummary = {
  container: { title: "Rate limiting", typeLabel: "Feature" },
  rows: [
    proposed("Count requests", { acceptanceCriteria: ["counts are per key", "counts reset each minute", "counts survive a restart"] }),
    proposed("Refuse over the limit", { acceptanceCriteria: ["a 429 past the limit"], waitsOn: [{ key: null, title: "Count requests" }] }),
    proposed("Show the limit"),
  ],
  closed: null,
};

function message(overrides: Partial<DiscussionMessage>): DiscussionMessage {
  return {
    id: "p1",
    authorType: "agent",
    authorName: "Assistant",
    body: PROSE,
    attachments: [],
    kind: "decision",
    parentId: null,
    runId: "run-1",
    options: null,
    canAnswer: false,
    createdAt: 1,
    canApprove: true,
    approves: "items",
    moduleSlug: null,
    proposedType: null,
    status: null,
    ...overrides,
  };
}

function draw(card: DiscussionMessage, answers: Answers = {}, registry: RegistryView = DEVELOPER) {
  const stub = ipcStub({ "registry:get": registry, ...answers });
  window.eo.ipc.invoke = stub.invoke as never;
  const onDone = vi.fn();
  renderSection(<ProposalCard message={card} conversationId="conv-1" onDone={onDone} />);
  return { calls: stub.calls, onDone };
}

const rows = () => within(screen.getByRole("region", { name: "Proposal" })).getAllByRole("listitem");

describe("a proposal that creates a container with several items", () => {
  it("names the container and draws one row per item, with none of the prose", async () => {
    draw(message({ proposal: PLAN }));

    const card = screen.getByRole("region", { name: "Proposal" });
    expect(within(card).getByText("Rate limiting")).toBeInTheDocument();
    expect(rows()).toHaveLength(3);
    expect(rows().map((row) => within(row).getByText(/^(Count requests|Refuse over the limit|Show the limit)$/).textContent)).toEqual([
      "Count requests",
      "Refuse over the limit",
      "Show the limit",
    ]);
    expect(card).not.toHaveTextContent("BODY-ONE");
    expect(card).not.toHaveTextContent("a new feature");
    // The developer pack's word, once the registry has answered.
    expect(await within(card).findByText(/Feature · 3 tickets/)).toBeInTheDocument();
  });

  it("shows each item's type label and its first criterion, counting the rest only when there are more", () => {
    draw(message({ proposal: PLAN }));

    const [first, second] = rows();
    expect(within(first!).getByText("Story")).toBeInTheDocument();
    expect(within(first!).getByText("counts are per key")).toBeInTheDocument();
    expect(within(first!).getByText("+2 more")).toBeInTheDocument();
    expect(first).not.toHaveTextContent("counts reset each minute");
    expect(within(second!).getByText("a 429 past the limit")).toBeInTheDocument();
    expect(second).not.toHaveTextContent("more");
  });

  it("shows what an item waits on by the other item's title", () => {
    draw(message({ proposal: PLAN }));

    const [first, second] = rows();
    expect(within(second!).getByText("Waits on Count requests")).toBeInTheDocument();
    expect(first).not.toHaveTextContent("Waits on");
  });

  it("keeps the button, its pending state and its error line, and approves the whole message", async () => {
    const { calls, onDone } = draw(message({ proposal: PLAN }));
    // Held open, so the pending state is something to look at: the stub answers a channel at once.
    let answer: (value: unknown) => void = () => undefined;
    const stubbed = window.eo.ipc.invoke as (channel: string, payload: unknown) => Promise<unknown>;
    window.eo.ipc.invoke = ((channel: string, payload: unknown) => {
      const sentOn = stubbed(channel, payload);
      return channel === "assist:approve" ? new Promise((resolve) => (answer = resolve)) : sentOn;
    }) as never;

    fireEvent.click(await screen.findByRole("button", { name: "Create ticket" }));
    expect(await screen.findByRole("button", { name: "Applying…" })).toBeDisabled();
    // One call for the card, never one per row.
    expect(sent(calls, "assist:approve")).toEqual([{ conversationId: "conv-1", messageId: "p1" }]);

    answer({ ok: true, data: { applied: false, problem: "This project has no pipeline for work to flow through yet.", createdKeys: [], changedKeys: [], conversation: { id: "conv-1", messages: [] } } });
    expect(await screen.findByText("This project has no pipeline for work to flow through yet.")).toBeInTheDocument();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("takes its words from the project's vocabulary rather than the developer pack's", async () => {
    draw(
      message({ proposal: { ...PLAN, container: { title: "Refund backlog", typeLabel: "Epic" }, rows: [proposed("Refund the March order", { typeLabel: "Case" })] } }),
      {},
      TWO_PACKS,
    );

    expect(await screen.findByRole("button", { name: "Create item" })).toBeInTheDocument();
    expect(screen.getByText(/Epic · 1 items/)).toBeInTheDocument();
    expect(within(rows()[0]!).getByText("Case")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Proposal" })).not.toHaveTextContent(/ticket|story|feature/i);
  });
});

describe("a row of new work", () => {
  it("opens that proposed item, by the card's message and the row's place", () => {
    draw(message({ proposal: PLAN }));

    expect(rows().map((row) => within(row).getByRole("link").getAttribute("href"))).toEqual(["/proposals/p1/0", "/proposals/p1/1", "/proposals/p1/2"]);
    // Still no key: nothing is filed.
    expect(screen.getByRole("region", { name: "Proposal" })).not.toHaveTextContent(/EO-\d/);
  });

  it("links to the item it became, showing its key, once the proposal is approved", () => {
    const created = PLAN.rows.map((row, index) => ({ ...row, created: { itemId: `item-${index}`, key: `EO-${50 + index}` } }));
    draw(message({ canApprove: false, approves: null, proposal: { ...PLAN, rows: created, closed: "applied" } }));

    expect(rows().map((row) => within(row).getByRole("link").getAttribute("href"))).toEqual(["/items/item-0", "/items/item-1", "/items/item-2"]);
    expect(rows().map((row) => within(row).getByText(/^EO-\d+$/).textContent)).toEqual(["EO-50", "EO-51", "EO-52"]);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps opening the proposed item when the item it became has been deleted", () => {
    draw(message({ canApprove: false, approves: null, proposal: { ...PLAN, rows: PLAN.rows.map((row) => ({ ...row, created: null })), closed: "applied" } }));

    expect(within(rows()[0]!).getByRole("link")).toHaveAttribute("href", "/proposals/p1/0");
  });
});

/** The priority a proposed item would be created with, named whenever it is not Normal (EO-568). */
describe("the priority a proposal creates work with", () => {
  it("names the level on each row that has one, and nothing on a Normal one", () => {
    draw(
      message({
        proposal: {
          container: { title: "Rate limiting", typeLabel: "Feature", priority: 1 },
          rows: [proposed("Count requests", { priority: 2 }), proposed("Refuse over the limit", { priority: 0 }), proposed("Show the limit"), proposed("Log it", { priority: 7 })],
          closed: null,
        },
      }),
    );

    const [urgent, normal, unsaid, far] = rows();
    expect(within(urgent!).getByText("Urgent")).toBeInTheDocument();
    expect(within(far!).getByText("Priority 7")).toBeInTheDocument();
    for (const row of [normal!, unsaid!]) expect(row).not.toHaveTextContent(/Normal|High|Urgent|Priority/);
    // The feature's own, on the container line rather than on any row.
    const card = screen.getByRole("region", { name: "Proposal" });
    expect(within(card).getByText("High")).toBeInTheDocument();
  });

  it("says nothing about priority on a card none of whose work has one", () => {
    draw(message({ proposal: PLAN }));

    expect(screen.getByRole("region", { name: "Proposal" })).not.toHaveTextContent(/Normal|High|Urgent|Priority/);
  });
});

describe("a proposal for a single standalone item", () => {
  it("draws one row and no container line", () => {
    draw(message({ proposal: { container: null, rows: [proposed("Refuse over the limit", { typeLabel: "Bug", acceptanceCriteria: [] })], closed: null } }));

    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]!).getByText("Bug")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Proposal" })).not.toHaveTextContent("·");
  });

  it("names the existing items it is filed under and waits on, by key and title", () => {
    draw(
      message({
        proposal: {
          container: null,
          rows: [proposed("Refuse over the limit", { under: { key: "EO-42", title: "Rate limiting" }, waitsOn: [{ key: "EO-43", title: "Count requests" }] })],
          closed: null,
        },
      }),
    );

    expect(within(rows()[0]!).getByText("Under EO-42 Rate limiting")).toBeInTheDocument();
    expect(within(rows()[0]!).getByText("Waits on EO-43 Count requests")).toBeInTheDocument();
  });
});

describe("the Reference a proposal creates work with (EO-739)", () => {
  it("names a plan's on the feature, not on any of its rows", () => {
    draw(message({ proposal: { ...PLAN, container: { title: "Rate limiting", typeLabel: "Feature", reference: "PROJ-123" } } }));

    const card = screen.getByRole("region", { name: "Proposal" });
    expect(within(card).getByText("Reference PROJ-123")).toBeInTheDocument();
    for (const row of rows()) expect(row).not.toHaveTextContent("Reference");
  });

  it("names a single item's on its row", () => {
    draw(message({ proposal: { container: null, rows: [proposed("Refuse over the limit", { typeLabel: "Bug", reference: "PROJ-9" })], closed: null } }));

    expect(within(rows()[0]!).getByText("Reference PROJ-9")).toBeInTheDocument();
  });

  it("has no Reference line on a proposal that names none", () => {
    draw(message({ proposal: PLAN }));

    expect(screen.getByRole("region", { name: "Proposal" })).not.toHaveTextContent("Reference");
  });
});

describe("a proposal that amends existing items", () => {
  const CHANGE: ProposalSummary = {
    container: null,
    rows: [{ kind: "change", itemId: "item-42", itemKey: "EO-42", itemTitle: "Add rate limiting", change: "Changes the title, to “Rate-limit the API”." }],
    closed: null,
  };

  it("names the item by key, says what changes, and links to the item's own view", async () => {
    draw(message({ approves: "changes", proposal: CHANGE, body: "A change to **EO-42**.\n\nBODY-ONE" }));

    const [row] = rows();
    expect(within(row!).getByRole("link", { name: "EO-42" })).toHaveAttribute("href", "/items/item-42");
    expect(within(row!).getByText("Changes the title, to “Rate-limit the API”.")).toBeInTheDocument();
    expect(row).not.toHaveTextContent("BODY-ONE");
    expect(await screen.findByRole("button", { name: "Apply change" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create ticket" })).not.toBeInTheDocument();
  });

  it("names an item deleted since without linking to it", () => {
    draw(message({ approves: "changes", proposal: { ...CHANGE, rows: [{ kind: "change", itemId: null, itemKey: "EO-42", itemTitle: null, change: "Changes the description." }] } }));

    expect(within(rows()[0]!).getByText("EO-42")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("a proposal that can no longer be approved", () => {
  it("keeps its rows, offers no button, and says a newer one replaced it", () => {
    draw(message({ canApprove: false, approves: null, proposal: { ...PLAN, closed: "superseded" } }));

    expect(rows()).toHaveLength(3);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Replaced by a newer proposal.")).toBeInTheDocument();
  });

  it("says so when it was approved", () => {
    draw(message({ canApprove: false, approves: null, proposal: { ...PLAN, closed: "applied" } }));

    expect(rows()).toHaveLength(3);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Approved.")).toBeInTheDocument();
  });
});

describe("a card with no readable proposal behind it", () => {
  it("draws its body, as every card did, and still offers the button", async () => {
    draw(message({ proposal: null, body: "A bug under EO-42." }));

    expect(screen.getByText("A bug under EO-42.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Create ticket" })).toBeInTheDocument();
  });
});
