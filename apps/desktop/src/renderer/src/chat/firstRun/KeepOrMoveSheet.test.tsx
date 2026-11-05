import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThemeProvider } from "@eo/ui";
import { describe, expect, it, vi } from "vitest";
import { KEEP_OR_MOVE_LINE, MOVE_IS_ONE_WAY_LINE } from "@eo/core";
import { createQueryClient } from "../../query/client";
import { DEFAULT_PRESET_ID, paletteOf, setThemeChoice } from "../theme";
import { KeepOrMoveSheet } from "./KeepOrMoveSheet";

/**
 * "You have 2 local projects · keep local / move to the record"
 * (EO-325, the original design).
 *
 * The claims here are the ones a person's work depends on, rather than
 * the ones a snapshot would cover: that nothing is moved unless
 * somebody picked "move", that the one-way sentence is on the screen
 * *before* they pick, and that the sheet is simply not there on a
 * desktop that has no record to move anything to.
 */

const SUPPORT = { id: "p1", name: "Support", keyPrefix: "SUP", repositoryIds: [], itemCount: 4, managedAt: null, keptLocalAt: null };
const MARKETING = { id: "p2", name: "Marketing", keyPrefix: "MKT", repositoryIds: [], itemCount: 2, managedAt: null, keptLocalAt: null };

function mockIpc(projects: unknown[]) {
  const calls: { channel: string; payload: unknown }[] = [];
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === "projects:undecided") return { ok: true, data: { projects, line: KEEP_OR_MOVE_LINE } };
    return { ok: true, data: { project: null, moved: null, problem: null } };
  }) as never;
  return calls;
}

function renderSheet() {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <KeepOrMoveSheet />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("the keep-or-move sheet", () => {
  it("is not there when nothing is undecided", async () => {
    mockIpc([]);
    renderSheet();

    // A solo desktop, and a signed-in one whose projects have all been
    // answered for. Both are "no list", and no list is no sheet.
    await waitFor(() => expect(window.eo.ipc.invoke).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: "Your local projects" })).toBeNull();
  });

  it("lists every local project and says the move cannot be undone", async () => {
    mockIpc([SUPPORT, MARKETING]);
    renderSheet();

    expect(await screen.findByText("You have 2 local projects")).toBeTruthy();
    expect(screen.getByText("Support")).toBeTruthy();
    expect(screen.getByText("Marketing")).toBeTruthy();
    // Said before anybody chooses, not after — it is the thing to know
    // in order to choose.
    expect(screen.getByText(MOVE_IS_ONE_WAY_LINE)).toBeTruthy();
  });

  /**
   * In the chat layout's look (EO-527), with the theme on the sheet
   * itself: it is drawn over the window, and must not repaint the board
   * behind it.
   */
  it("wears this device's chat theme on itself, and leaves the window behind it alone", async () => {
    setThemeChoice({ kind: "preset", id: "nord" });
    mockIpc([SUPPORT]);
    renderSheet();

    const sheet = await screen.findByRole("dialog", { name: "Your local projects" });
    expect(sheet.style.getPropertyValue("--color-canvas")).toBe(paletteOf({ kind: "preset", id: "nord" })["--color-canvas"]);
    expect(document.documentElement.style.getPropertyValue("--color-canvas")).toBe("");
    setThemeChoice({ kind: "preset", id: DEFAULT_PRESET_ID });
  });

  it("keeps everything when nobody picks anything", async () => {
    const calls = mockIpc([SUPPORT, MARKETING]);
    renderSheet();

    fireEvent.click(await screen.findByRole("button", { name: "Keep them here" }));

    await waitFor(() => expect(calls.some((call) => call.channel === "projects:keepLocal")).toBe(true));
    // The whole point of the default: silence moves nothing.
    expect(calls.filter((call) => call.channel === "projects:keepLocal").map((call) => call.payload)).toEqual([
      { projectId: "p1" },
      { projectId: "p2" },
    ]);
    expect(calls.some((call) => call.channel === "projects:moveToRecord")).toBe(false);
  });

  it("moves only the ones somebody switched, and keeps the rest", async () => {
    const calls = mockIpc([SUPPORT, MARKETING]);
    renderSheet();

    fireEvent.click(await screen.findByRole("radio", { name: "Move to the record — Support" }));
    fireEvent.click(screen.getByRole("button", { name: "Move 1 and keep the rest" }));

    await waitFor(() => expect(calls.some((call) => call.channel === "projects:moveToRecord")).toBe(true));
    expect(calls.filter((call) => call.channel === "projects:moveToRecord").map((call) => call.payload)).toEqual([{ projectId: "p1" }]);
    expect(calls.filter((call) => call.channel === "projects:keepLocal").map((call) => call.payload)).toEqual([{ projectId: "p2" }]);
  });

  it("says what it could not do rather than closing over it", async () => {
    window.eo.ipc.invoke = vi.fn(async (channel: string) => {
      if (channel === "projects:undecided") return { ok: true, data: { projects: [SUPPORT], line: KEEP_OR_MOVE_LINE } };
      return { ok: true, data: { project: null, moved: null, problem: "EO could not reach https://eo.example." } };
    }) as never;
    renderSheet();

    fireEvent.click(await screen.findByRole("radio", { name: "Move to the record — Support" }));
    fireEvent.click(screen.getByRole("button", { name: "Move 1 and keep the rest" }));

    // The project is untouched and still on the sheet, which is the
    // state it is safe to be left in — and the reason is on the screen.
    expect(await screen.findByText("Support: EO could not reach https://eo.example.")).toBeTruthy();
  });
});
