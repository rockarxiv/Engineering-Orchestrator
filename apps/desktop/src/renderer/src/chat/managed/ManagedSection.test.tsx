import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SECTION_LOCK_TEXT, type PublishedSection, type PublishedSectionView } from "@eo/core";
import { renderSection, ipcStub, type Answers } from "../views/settings/org/testing";
import { ManagedLockNotice, ManagedSection } from "./ManagedSection";

/** The shared stub, installed where only a test may put it. */
function stubIpc(answers?: Answers) {
  const stub = ipcStub(answers);
  window.eo.ipc.invoke = stub.invoke as never;
  return stub.calls;
}

/**
 * The lock a person meets on a screen their organisation manages (EO-329,
 * ARCHITECTURE.md, "Publish, lock and versions"), as the chat layout draws it: the whole sentence —
 * including what
 * stays theirs — the fence, and nothing at all where nothing is published.
 */

const DANA: PublishedSectionView = {
  section: "pipelines",
  subjectId: "default",
  versionId: "a-version",
  versionNumber: 6,
  publishedAt: 1_700_000_000_000,
  publishedBy: "dana-id",
  publishedByName: "Dana",
  document: null,
};

function mockSections(locked: PublishedSection[], published: PublishedSectionView[] = []) {
  stubIpc({ "sections:list": { published, locked, lockText: SECTION_LOCK_TEXT } });
}

function renderLocked(section: PublishedSection) {
  return renderSection(
    <ManagedSection section={section}>
      <button type="button">Publish</button>
    </ManagedSection>,
  );
}

describe("a section the organisation manages, in the chat layout", () => {
  it("says what is managed and what stays the person's, and disables the controls", async () => {
    mockSections(["pipelines"], [DANA]);
    renderLocked("pipelines");

    const lock = await screen.findByTestId("managed-lock-pipelines");
    expect(lock).toHaveTextContent("Steps, routes and prompts are managed by your organisation.");
    expect(lock).toHaveTextContent("Your sign-ins, local folders and personal secrets are yours.");
    expect(lock).toHaveTextContent("Published by Dana.");
    expect(lock).toHaveAccessibleName("pipelines is managed by your organisation");
    await waitFor(() => expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled());
  });

  it("draws nothing where nothing was published", async () => {
    mockSections([]);
    renderLocked("pipelines");

    await waitFor(() => expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled());
    expect(screen.queryByTestId("managed-lock-pipelines")).toBeNull();
    expect(screen.queryByText(SECTION_LOCK_TEXT, { exact: false })).toBeNull();
  });

  it("draws nothing on a section beside a locked one", async () => {
    mockSections(["pipelines"], [DANA]);
    renderLocked("agents");

    await waitFor(() => expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled());
    expect(screen.queryByTestId("managed-lock-agents")).toBeNull();
  });

  it("draws a lock from a refusal in hand, with the one wording and what may be done about it", () => {
    renderSection(
      <ManagedLockNotice lock={{ locked: true, section: "agents", publishedBy: null }}>
        <button type="button">Suggest a change</button>
      </ManagedLockNotice>,
    );

    const lock = screen.getByTestId("managed-lock-agents");
    expect(lock).toHaveTextContent(SECTION_LOCK_TEXT);
    expect(lock).not.toHaveTextContent("Published by");
    expect(screen.getByRole("button", { name: "Suggest a change" })).toBeEnabled();
  });
});
