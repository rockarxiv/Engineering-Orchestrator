import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { ThemeProvider } from "@eo/ui";
import { describe, expect, it, vi } from "vitest";
import { SECTION_LOCK_TEXT, WEBHOOK_UNATTENDED_CHIP, WEBHOOK_UNATTENDED_CHIP_TITLE } from "@eo/core";
import { createQueryClient } from "../../query/client";
import { PipelineTitle } from "../views/board/header";

/** The head the chat layout's board and graph both draw. */
const HEADER = <PipelineTitle name="Delivery" pipelineId="default" />;

/**
 * Letting one pipeline send what a webhook delivers without a person
 * reading it first (EO-405), as the chat layout draws it.
 *
 * What is asserted is that the board's header states the setting when
 * it is on and says nothing when it is off. The setting itself is
 * changed through the assistant's card (EO-522); the editor that drew a
 * switch for it is gone (EO-525).
 */

interface World {
  entry: boolean;
  unattended: boolean;
}

/** The two channels the header reads. */
function mockIpc(world: World) {
  const calls: { channel: string; payload: unknown }[] = [];
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === "pipelineSteps:list") {
      return { ok: true, data: { steps: [], routes: [], webhook: { entry: world.entry, unattended: world.unattended } } };
    }
    if (channel === "sections:list") {
      return { ok: true, data: { published: [], locked: [], lockText: SECTION_LOCK_TEXT } };
    }
    return { ok: true, data: {} };
  }) as never;
  return calls;
}

function draw(children: ReactNode) {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>{children}</QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("the statement on the board's pipeline header", () => {
  it("says so plainly when the setting is on, and nothing when it is off", async () => {
    mockIpc({ entry: true, unattended: true });
    const { unmount } = draw(HEADER);

    const chip = await screen.findByText(WEBHOOK_UNATTENDED_CHIP);
    expect(chip).toBeVisible();
    expect(chip).toHaveAttribute("title", WEBHOOK_UNATTENDED_CHIP_TITLE);
    // A statement, not an alarm.
    expect(screen.queryByRole("alert")).toBeNull();
    unmount();

    const calls = mockIpc({ entry: true, unattended: false });
    draw(HEADER);
    await waitFor(() => expect(calls.some((call) => call.channel === "pipelineSteps:list")).toBe(true));
    expect(screen.queryByText(WEBHOOK_UNATTENDED_CHIP)).toBeNull();
  });
});
