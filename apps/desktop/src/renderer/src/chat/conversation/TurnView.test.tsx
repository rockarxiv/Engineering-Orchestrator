import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { LiveTurn, TurnStep } from "@eo/core";
import { describe, expect, it } from "vitest";
import { ipcStub, renderSection, sent } from "../views/settings/org/testing";
import { LiveTurnBody, TurnFold, TurnSteps, doingSummary, groupSteps, turnSummaryLine, workedFor } from "./TurnView";

const tool = (seq: number, label: string, ok: boolean | null, output: string | null = "ok"): TurnStep => ({ kind: "tool", seq, callId: `c${seq}`, name: "Bash", label, input: '{\n  "command": "ls"\n}', ok, output });

describe("a turn's steps", () => {
  it("folds consecutive doing and leaves what was said standing", () => {
    const steps: TurnStep[] = [
      { kind: "text", seq: 0, text: "Looking." },
      tool(1, "Ran ls", true),
      { kind: "edit", seq: 2, path: "a.ts" },
      tool(3, "Ran pnpm test", true),
      { kind: "reasoning", seq: 4, text: "Fine." },
      tool(5, "Read b.ts", true),
    ];
    expect(groupSteps(steps).map((group) => (group.kind === "doing" ? `doing:${group.steps.length}` : group.step.kind))).toEqual(["text", "doing:3", "reasoning", "doing:1"]);
    expect(doingSummary(steps.slice(1, 4))).toBe("2 tool calls · 1 file edited");
  });

  it("opens a folded group to its calls, and a call to what it was asked and what came back", () => {
    renderSection(<TurnSteps steps={[tool(1, "Ran ls", true, "a.ts\nb.ts"), tool(2, "Ran false", false, "exit 1")]} />);
    const fold = screen.getByRole("button", { name: /2 tool calls/ });
    expect(fold).toHaveTextContent("a call failed");
    expect(screen.queryByText("Ran ls")).toBeNull();

    fireEvent.click(fold);
    fireEvent.click(screen.getByRole("button", { name: /Ran ls/ }));
    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText(/a\.ts\s+b\.ts/)).toBeInTheDocument();
  });

  it("shows a single call as itself, and reasoning folded under Thought", () => {
    renderSection(<TurnSteps steps={[tool(1, "Ran ls", true), { kind: "reasoning", seq: 2, text: "The board is the release one." }]} />);
    expect(screen.getByRole("button", { name: /Ran ls/ })).toBeInTheDocument();
    expect(screen.queryByText("The board is the release one.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Thought" }));
    expect(screen.getByText("The board is the release one.")).toBeInTheDocument();
  });

  it("shows a running call as running in a live turn", () => {
    renderSection(<TurnSteps live steps={[tool(1, "Ran pnpm test", null, null)]} />);
    expect(screen.getByLabelText("Running")).toBeInTheDocument();
  });

  it("never folds an error, and shows a message steered into the turn", () => {
    renderSection(<TurnSteps steps={[{ kind: "error", seq: 1, message: "overloaded" }, { kind: "steer", seq: 2, text: "use main" }]} />);
    expect(screen.getByRole("alert")).toHaveTextContent("overloaded");
    expect(screen.getByText("use main")).toBeInTheDocument();
  });
});

describe("the running turn", () => {
  const live = (over: Partial<LiveTurn> = {}): LiveTurn => ({ runId: "r", startedAt: 0, steps: [], drafts: [], lastDraftId: 0, answer: "", ...over });

  it("draws its steps, what it is thinking as it thinks, and the answer's message rather than its JSON", () => {
    renderSection(
      <LiveTurnBody
        turn={live({ steps: [{ kind: "text", seq: 0, text: "Reading the board." }] })}
        drafts={[
          { id: 1, stream: "reasoning", text: "Which step?" },
          { id: 2, stream: "text", text: '{"outcome":{"message":"It has three st' },
        ]}
      />,
    );
    expect(screen.getByText("Reading the board.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Thinking/ })).toBeInTheDocument();
    expect(screen.getByText("Which step?")).toBeInTheDocument();
    expect(screen.getByText("It has three st")).toBeInTheDocument();
    expect(screen.queryByText(/outcome/)).toBeNull();
  });

  it("draws the stored answer once no draft is writing it, and not twice", () => {
    const { unmount } = renderSection(<LiveTurnBody turn={live({ answer: "Three steps." })} drafts={[]} />);
    expect(screen.getAllByText("Three steps.")).toHaveLength(1);
    unmount();
    renderSection(<LiveTurnBody turn={live({ answer: "Three steps." })} drafts={[{ id: 1, stream: "text", text: '{"outcome":{"message":"Three steps."}}' }]} />);
    expect(screen.getAllByText("Three steps.")).toHaveLength(1);
  });
});

describe("a finished turn's fold", () => {
  it("says how long it worked and what it did", () => {
    expect(workedFor(45_000)).toBe("45s");
    expect(workedFor(133_000)).toBe("2m 13s");
    expect(workedFor(120_000)).toBe("2m");
    expect(turnSummaryLine({ runId: "r", durationMs: 61_000, toolCalls: 12, filesEdited: 1, reasoned: true })).toBe("Worked for 1m 1s · 12 tool calls · 1 file edited");
    expect(turnSummaryLine({ runId: "r", durationMs: null, toolCalls: 0, filesEdited: 0, reasoned: true })).toBe("Worked · thought it through");
  });

  it("reads the run's steps only when opened", async () => {
    const stub = ipcStub({ "runs:steps": { steps: [{ kind: "text", seq: 0, text: "Checked the board." }] } });
    window.eo.ipc.invoke = stub.invoke as never;
    renderSection(<TurnFold turn={{ runId: "run-9", durationMs: 5_000, toolCalls: 2, filesEdited: 0, reasoned: false }} />);
    expect(sent(stub.calls, "runs:steps")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /Worked for 5s · 2 tool calls/ }));
    await waitFor(() => expect(screen.getByText("Checked the board.")).toBeInTheDocument());
    expect(sent(stub.calls, "runs:steps")).toEqual([{ runId: "run-9" }]);
  });
});
