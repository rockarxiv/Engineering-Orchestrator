import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DraftInput } from "./draftInput";

/**
 * The shared settings box (EO-563), against a store that answers late:
 * what reaches the store, in what order, and what the box draws meanwhile.
 */
function Harness({ replyMs, writes, fail = () => false }: { replyMs: number; writes: string[]; fail?: (text: string) => boolean }) {
  const [stored, setStored] = useState("3");
  return (
    <>
      <label>
        Limit
        <DraftInput
          type="number"
          value={stored}
          onCommit={async (text) => {
            writes.push(text);
            await new Promise((resolve) => setTimeout(resolve, replyMs));
            if (fail(text)) return false;
            setStored(text);
            return true;
          }}
        />
      </label>
      <output aria-label="Stored">{stored}</output>
    </>
  );
}

describe("a draft settings box", () => {
  it("going back to the stored value while a save is on its way still saves it, so the newer edit wins", async () => {
    const writes: string[] = [];
    render(<Harness replyMs={50} writes={writes} />);
    const field = screen.getByLabelText("Limit");

    fireEvent.change(field, { target: { value: "7" } });
    fireEvent.blur(field);
    // Before 7 has been answered, back to what is stored.
    fireEvent.change(field, { target: { value: "3" } });
    expect(field).toHaveValue(3);
    fireEvent.blur(field);

    await waitFor(() => expect(writes).toEqual(["7", "3"]));
    await waitFor(() => expect(screen.getByLabelText("Stored")).toHaveTextContent("3"));
    expect(field).toHaveValue(3);
    // And it stays 3 once the late 7 has come and gone.
    await act(() => new Promise((resolve) => setTimeout(resolve, 120)));
    expect(screen.getByLabelText("Stored")).toHaveTextContent("3");
    expect(field).toHaveValue(3);
  });

  it("an older save of the same text does not swallow a newer edit (7, 9, then 7 again)", async () => {
    const writes: string[] = [];
    const replies: Array<() => void> = [];
    function Store() {
      const [stored, setStored] = useState("3");
      return (
        <DraftInput
          aria-label="Limit"
          type="number"
          value={stored}
          onCommit={(text) => {
            writes.push(text);
            return new Promise<boolean>((resolve) =>
              replies.push(() => {
                setStored(text);
                resolve(true);
              }),
            );
          }}
        />
      );
    }
    render(<Store />);
    const field = screen.getByLabelText("Limit");

    fireEvent.change(field, { target: { value: "7" } });
    fireEvent.blur(field);
    fireEvent.change(field, { target: { value: "9" } });
    fireEvent.blur(field);
    // 7 again, no blur: only the pause will send it.
    fireEvent.change(field, { target: { value: "7" } });

    // Both earlier saves answer inside the pause.
    await act(async () => replies[0]?.());
    expect(field).toHaveValue(7);
    await act(async () => replies[1]?.());
    expect(field).toHaveValue(7);

    await waitFor(() => expect(writes).toEqual(["7", "9", "7"]));
    await act(async () => replies[2]?.());
    expect(field).toHaveValue(7);
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(writes).toEqual(["7", "9", "7"]);
    expect(field).toHaveValue(7);
  });

  it("does not send the same text twice when a blur follows the pause", async () => {
    const writes: string[] = [];
    render(<Harness replyMs={50} writes={writes} />);
    const field = screen.getByLabelText("Limit");

    fireEvent.change(field, { target: { value: "9" } });
    await waitFor(() => expect(writes).toEqual(["9"]));
    fireEvent.blur(field);
    await waitFor(() => expect(screen.getByLabelText("Stored")).toHaveTextContent("9"));
    expect(writes).toEqual(["9"]);
  });

  it("does not send a saved edit again from a blur before React has drawn the answer", async () => {
    // The race test-windows found (EO-670): the save comes back stored, and
    // the blur lands before the render that drops the draft.
    const writes: string[] = [];
    const replies: Array<() => void> = [];
    render(
      <DraftInput
        aria-label="Limit"
        type="number"
        value="3"
        onCommit={(text) => {
          writes.push(text);
          return new Promise<boolean>((resolve) => replies.push(() => resolve(true)));
        }}
      />,
    );
    const field = screen.getByLabelText("Limit");

    fireEvent.change(field, { target: { value: "9" } });
    await waitFor(() => expect(writes).toEqual(["9"]));
    // Answered outside act, so React has not drawn it when the blur arrives.
    replies[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.blur(field);

    expect(writes).toEqual(["9"]);
  });

  it("keeps a failed value, and a later blur tries it again", async () => {
    const writes: string[] = [];
    let failing = true;
    render(<Harness replyMs={0} writes={writes} fail={() => failing} />);
    const field = screen.getByLabelText("Limit");

    fireEvent.change(field, { target: { value: "8" } });
    fireEvent.blur(field);
    await waitFor(() => expect(writes).toEqual(["8"]));
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(field).toHaveValue(8);
    expect(screen.getByLabelText("Stored")).toHaveTextContent("3");

    failing = false;
    fireEvent.blur(field);
    await waitFor(() => expect(screen.getByLabelText("Stored")).toHaveTextContent("8"));
    expect(writes).toEqual(["8", "8"]);
  });

  it("saves what was typed when it is taken off screen inside the pause", async () => {
    const writes: string[] = [];
    function Toggle() {
      const [shown, setShown] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShown(false)}>
            Leave
          </button>
          {shown ? <DraftInput aria-label="Limit" value="3" onCommit={async (text) => (writes.push(text), true)} /> : null}
        </>
      );
    }
    render(<Toggle />);
    fireEvent.change(screen.getByLabelText("Limit"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(writes).toEqual(["6"]);
  });
});
