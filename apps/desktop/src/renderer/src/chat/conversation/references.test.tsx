import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ItemReferenceProvider } from "./ItemReferenceProvider";
import { createQueryClient } from "../../query/client";
import { QuestionCard } from "./QuestionCard";
import { ItemKeyLink, ReferenceText } from "./references";

function withCatalog(children: React.ReactNode, client = createQueryClient()) {
  window.eo.ipc.invoke = vi.fn(async (channel: string) => {
    if (channel === "projects:list") return { ok: true, data: { projects: [], activeProjectId: null } };
    if (channel === "items:list") return { ok: true, data: { items: [{ id: "t2", key: "EO-2" }] } };
    if (channel === "items:listArchived") return { ok: true, data: { items: [{ id: "t9", key: "EO-9" }] } };
    return { ok: true, data: {} };
  }) as never;
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ItemReferenceProvider>{children}</ItemReferenceProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("item keys in the chat layout's sentences", () => {
  it("is the text, unlinked, where there is no catalog to read", () => {
    render(<ReferenceText>{"EO-2 is closed."}</ReferenceText>);
    expect(screen.getByText("EO-2 is closed.")).toBeInTheDocument();
  });

  it("links every key EO holds, archived ones too, and leaves code and unknown keys as written", async () => {
    withCatalog(
      <p data-testid="line">
        <ReferenceText>{"EO-2 waits on EO-9, not EO-3 or `EO-2`."}</ReferenceText>
      </p>,
    );

    const line = screen.getByTestId("line");
    await waitFor(() => expect(within(line).getByRole("link", { name: "EO-2" })).toHaveAttribute("href", "/items/t2"));
    expect(within(line).getByRole("link", { name: "EO-9" })).toHaveAttribute("href", "/items/t9");
    expect(within(line).getAllByRole("link")).toHaveLength(2);
    expect(line).toHaveTextContent("EO-2 waits on EO-9, not EO-3 or `EO-2`.");
  });

  it("keeps a key in an option a link of its own, beside the option's button", async () => {
    withCatalog(
      <QuestionCard
        questions={[{ id: "q1", body: "Merge into EO-2?", options: ["Yes, into EO-2", "No"], answer: null }]}
        live
        busy={false}
        onSubmit={async () => undefined}
      />,
    );

    const card = screen.getByRole("group", { name: "Questions from the product owner" });
    await waitFor(() => expect(within(card).getAllByRole("link", { name: "EO-2" })).toHaveLength(2));
    expect(within(card).getByRole("button", { name: "Yes, into EO-2" })).toBeInTheDocument();
  });

  it("reads the catalog without subscribing to the query cache, however many keys are on screen (EO-561)", async () => {
    /** How many subscriptions to the whole cache a window with these keys takes. */
    async function cacheSubscriptions(keys: number) {
      const client = createQueryClient();
      const subscribe = vi.spyOn(client.getQueryCache(), "subscribe");
      withCatalog(
        <p data-testid={`keys-${keys}`}>
          {Array.from({ length: keys }, (_, index) => (
            <ItemKeyLink key={index} itemKey="EO-2" />
          ))}
          <ReferenceText>{"EO-2"}</ReferenceText>
        </p>,
        client,
      );
      await waitFor(() => expect(within(screen.getByTestId(`keys-${keys}`)).getAllByRole("link")).toHaveLength(keys + 1));
      return subscribe.mock.calls.length;
    }

    // The provider's own reads may watch the cache; a key on screen does not.
    expect(await cacheSubscriptions(20)).toBe(await cacheSubscriptions(0));
  });
});
