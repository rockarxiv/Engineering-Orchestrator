import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SECTION_LOCK_TEXT } from "@eo/core";
import { PublishingSection } from "../sections/PublishingSection";
import { renderSection, sent, ipcStub, type Answers } from "./testing";

/** The shared stub, installed where only a test may put it. */
function stubIpc(answers?: Answers) {
  const stub = ipcStub(answers);
  window.eo.ipc.invoke = stub.invoke as never;
  return stub.calls;
}

/**
 * Settings → Publishing in the chat layout (EO-329, ARCHITECTURE.md, "Publish, lock and versions"):
 * every section
 * but policy, each saying whether and by whom it is published; Publish asks
 * the preflight first and confirms with its sentence; Cancel writes nothing;
 * a rollback names a pipeline and one of its versions.
 */

const PIPELINES = { pipelines: [{ id: "default", projectId: null, name: "Delivery", icon: null, entryStepId: "todo", position: 0, archivedAt: null }] };

function mockIpc(answers: Record<string, unknown> = {}) {
  return stubIpc({
    "sections:list": {
      published: [{ section: "pipelines", subjectId: "default", versionId: "v", versionNumber: 6, publishedAt: 1, publishedBy: "dana", publishedByName: "Dana", document: null }],
      locked: [],
      lockText: SECTION_LOCK_TEXT,
    },
    "pipelines:list": PIPELINES,
    "pipeline:versions": { versions: [{ number: 5 }, { number: 6 }] },
    "sections:publishPreflight": { confirmation: "3 items in flight across 2 desktops finish on v6.", problem: null },
    "sections:publish": { confirmation: "Published to every signed-in desktop.", problem: null },
    ...answers,
  });
}

const draw = () => renderSection(<PublishingSection />);

describe("the Publishing section, in the chat layout", () => {
  it("lists four sections — not policy — and says which is published, by whom and at which version", async () => {
    mockIpc();
    draw();

    const rows = within(await screen.findByRole("list", { name: "Sections" }));
    await waitFor(() => expect(rows.getByText(/Published by Dana · v6/)).toBeInTheDocument());
    expect(rows.getAllByText("Not published — every desktop edits this for itself.")).toHaveLength(3);
    expect(rows.queryByText("Policy")).not.toBeInTheDocument();
    expect(rows.getAllByRole("button", { name: /^Publish (again )?/ })).toHaveLength(4);
  });

  it("asks the preflight first, confirms with its sentence, and publishes only on Confirm", async () => {
    const calls = mockIpc();
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "Publish again Pipelines" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish Pipelines to every signed-in desktop?" });
    expect(dialog).toHaveTextContent("3 items in flight across 2 desktops finish on v6.");
    expect(sent(calls, "sections:preflight" as string)).toEqual([]);
    expect(sent(calls, "sections:publishPreflight")).toEqual([{ section: "pipelines", pipelineId: null, versionNumber: null }]);
    expect(sent(calls, "sections:publish")).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(sent(calls, "sections:publish")).toEqual([{ section: "pipelines", pipelineId: null, versionNumber: null }]));
    expect(await screen.findByText("Published to every signed-in desktop.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("writes nothing when the confirmation is cancelled", async () => {
    const calls = mockIpc();
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "Publish again Pipelines" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(sent(calls, "sections:publish")).toEqual([]);
  });

  it("says a refused publish in the main process's words", async () => {
    mockIpc({ "sections:publish": { confirmation: "", problem: "Only an admin may publish." } });
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "Publish again Pipelines" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Only an admin may publish.")).toBeInTheDocument();
  });

  it("rolls a pipeline back to a version it had, through the same confirmation", async () => {
    const calls = mockIpc();
    draw();

    const roll = within(await screen.findByRole("region", { name: "Roll back" }));
    expect(roll.getByRole("button", { name: "Roll back" })).toBeDisabled();
    await roll.findByRole("option", { name: "v5" });
    fireEvent.change(roll.getByLabelText("Version"), { target: { value: "5" } });
    fireEvent.click(roll.getByRole("button", { name: "Roll back" }));

    expect(await screen.findByRole("dialog", { name: "Roll this pipeline back to v5 and publish it?" })).toBeInTheDocument();
    expect(sent(calls, "sections:publishPreflight")).toEqual([{ section: "pipelines", pipelineId: "default", versionNumber: 5 }]);
  });
});
