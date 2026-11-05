import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { developerRegistry, toRegistryView } from "@eo/core";
import { ThemeProvider } from "@eo/ui";
import { createQueryClient } from "../../../query/client";
import { RunComposer } from "./RunComposer";

/** The composer that knows an agent is working (EO-176; `item/RunComposer.test.tsx` is the model). */

const LIVE = { runId: "r1", agentName: "Nova", steerable: true };

function mount(props: Partial<Parameters<typeof RunComposer>[0]> = {}) {
  window.eo.ipc.invoke = vi.fn(async (channel: string) =>
    channel === "registry:get" ? { ok: true, data: toRegistryView(developerRegistry()) } : { ok: true, data: {} },
  ) as never;
  const onSubmit = props.onSubmit ?? vi.fn(async () => null);
  render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <RunComposer live={null} mentionables={["user"]} submitLabel="Send" {...props} onSubmit={onSubmit} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return onSubmit;
}

function send(text: string) {
  fireEvent.change(screen.getByLabelText("Write a comment"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("RunComposer", () => {
  it("says nothing about delivery when nothing is running, and asks for none", async () => {
    const onSubmit = mount();
    expect(screen.queryByLabelText("Send behavior")).not.toBeInTheDocument();
    send("For later.");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("For later.", [], [], undefined));
  });

  it("offers the choice while a steerable run is live, and sends the mode it showed", async () => {
    const onSubmit = mount({ live: LIVE });
    expect(screen.getByText(/Nova is working — this will be said to it now/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Send behavior"), { target: { value: "next" } });
    expect(screen.getByText(/read by the next run rather than interrupting/)).toBeInTheDocument();
    send("Check the retry maths.");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Check the retry maths.", [], [], "next"));
  });

  it("offers no choice on a backend that cannot be spoken to mid-turn, and queues", async () => {
    const onSubmit = mount({ live: { ...LIVE, steerable: false } });
    expect(screen.queryByLabelText("Send behavior")).not.toBeInTheDocument();
    expect(await screen.findByText(/cannot be spoken to mid-turn, so this will be read by the next run on this ticket/)).toBeInTheDocument();
    send("Stop.");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Stop.", [], [], "next"));
  });

  it("repeats what EO said about a message that missed its turn, and stays quiet otherwise", async () => {
    mount({ live: LIVE, onSubmit: vi.fn(async () => ({ requested: "now" as const, outcome: "next" as const, note: "The turn had already ended; this was queued." })) });
    send("Too late?");
    expect(await screen.findByRole("status")).toHaveTextContent("already ended");
  });
});
