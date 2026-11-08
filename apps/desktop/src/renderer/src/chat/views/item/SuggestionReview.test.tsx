import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SuggestionView } from "@eo/core";
import { ThemeProvider } from "@eo/ui";
import { createQueryClient } from "../../../query/client";
import { SuggestionReview } from "./SuggestionReview";

/** A suggested pipeline change on the admin's item (EO-331, ARCHITECTURE.md, "Divergence and suggestions"; `item/SuggestionReview.test.tsx` is the model). */

const SUGGESTION: SuggestionView = {
  itemId: "an-item",
  pipelineId: "default",
  pipelineName: "Delivery",
  basedOn: 6,
  publishedVersion: 7,
  diff: {
    from: 7,
    to: 8,
    steps: [{ stepId: "review", name: "Second opinion", change: "changed", kind: { type: "agent", ownerRole: "reviewer", entryAction: "review" }, fields: [{ field: "name", before: "Review", after: "Second opinion" }] }],
    routes: [],
  entryRules: null,
  },
  needs: [{ key: "modules", line: "1 module to read and approve", met: false, why: "A module is code from somebody else's machine.", fix: null }],
  unapprovedModules: ["Nightly digest"],
  author: "Anna",
  problem: null,
};

function renderReview(suggestion: SuggestionView | null) {
  window.eo.ipc.invoke = vi.fn(async (channel: string) => (channel === "suggestions:detail" ? { ok: true, data: { suggestion } } : { ok: true, data: {} })) as never;
  render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <SuggestionReview itemId="an-item" />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("a suggestion on the admin's item", () => {
  it("shows what changed, against what, and what approving it would publish", async () => {
    renderReview(SUGGESTION);

    expect(await screen.findByTestId("suggestion-review")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Suggested change to “Delivery”" })).toBeInTheDocument();
    expect(screen.getByText(/Anna/)).toHaveTextContent("based on v6");
    expect(screen.getByText(/Anna/)).toHaveTextContent("Approving it publishes v8");
    const steps = screen.getByRole("region", { name: "Steps" });
    expect(within(steps).getAllByText("Second opinion", { exact: false }).length).toBeGreaterThan(0);
    expect(within(steps).getByText("changed")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Steps" })).toHaveTextContent("name: Review → Second opinion");
    expect(screen.getByText("No route changed.")).toBeInTheDocument();
  });

  it("carries the needs list and the unapproved modules the author saw", async () => {
    renderReview(SUGGESTION);
    expect(await screen.findByText("1 module to read and approve")).toBeInTheDocument();
    expect(screen.getByText("Nightly digest")).toBeInTheDocument();
  });

  it("says what stops it being approvable before the button is pressed", async () => {
    renderReview({ ...SUGGESTION, problem: "Pipeline “Delivery” has moved on since this was suggested." });
    expect(await screen.findByRole("alert")).toHaveTextContent("has moved on");
  });

  it("draws nothing at all on an item that is not a suggestion", async () => {
    renderReview(null);
    await waitFor(() => expect(window.eo.ipc.invoke).toHaveBeenCalled());
    expect(screen.queryByTestId("suggestion-review")).not.toBeInTheDocument();
  });
});
