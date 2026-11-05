import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { ThemeProvider } from "@eo/ui";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SECTION_LOCK_TEXT, type PublishedSectionView } from "@eo/core";
import { createQueryClient } from "../../query/client";
import { DivergedChip } from "./DivergedPipeline";

/**
 * The chat layout's diverged chip (EO-331, `ARCHITECTURE.md`,
 * "Divergence and suggestions"): the board says so in a chip, and the
 * chip opens what it is about.
 */

const DANA: PublishedSectionView = {
  section: "pipelines",
  subjectId: "default",
  versionId: "a-version",
  versionNumber: 7,
  publishedAt: 1_700_000_000_000,
  publishedBy: "dana-id",
  publishedByName: "Dana",
  document: null,
};

/** The two channels the chip reads. */
function mockIpc(world: { diverged: boolean }) {
  window.eo.ipc.invoke = vi.fn(async (channel: string) => {
    if (channel === "sections:list") {
      return { ok: true, data: { published: [DANA], locked: ["pipelines"], lockText: SECTION_LOCK_TEXT } };
    }
    if (channel === "pipelines:divergence") {
      return {
        ok: true,
        data: world.diverged
          ? { diverged: true, basedOn: 6, available: 7, line: "Edited locally · based on v6 · v7 available" }
          : { diverged: false, basedOn: null, available: 7, line: null },
      };
    }
    return { ok: true, data: {} };
  }) as never;
}

describe("the board's pipeline header", () => {
  const chip = () =>
    render(
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <MemoryRouter>
            <DivergedChip pipelineId="default" />
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>,
    );

  it("says diverged as a fact, and says nothing otherwise", async () => {
    mockIpc({ diverged: true });
    const { unmount } = chip();

    expect(await screen.findByText("diverged")).toBeInTheDocument();
    unmount();

    mockIpc({ diverged: false });
    chip();
    await waitFor(() => expect(screen.queryByText("diverged")).toBeNull());
  });

  it("opens the Changes view on this machine's own edits (EO-524)", async () => {
    mockIpc({ diverged: true });
    chip();

    await screen.findByText("diverged");
    expect(screen.getByRole("link", { name: /diverged/ })).toHaveAttribute("href", "/pipelines/default/changes?local");
  });
});
