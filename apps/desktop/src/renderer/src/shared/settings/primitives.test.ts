import { describe, expect, it } from "vitest";
import { unsavedEditsBetween } from "./primitives";

/**
 * The repository editor's labels, as Settings → Workspaces publishes its
 * git form under them (`chat/views/settings/sections/WorkspacesSection`).
 *
 * Copied rather than imported: the classic screen exported its own
 * `unsavedGitWorkspaceEdits`, which went with that layout (EO-529), and
 * the rule these cases hold is the shared one — that the labels are the
 * enumeration, and a cleared field is an edit.
 */
const GIT_FIELD_LABELS = {
  name: "Name",
  description: "What this repository is",
  repoPath: "Repository path",
  baseBranch: "Base branch",
  testCommand: "test command",
  lintCommand: "lint command",
  buildCommand: "build command",
  forgeOpenPr: "Open a pull request when a story is approved",
  forgeKind: "Forge",
  forgeRemote: "Remote",
  forgeDraft: "Open it as a draft",
  forgeTemplatePath: "Template",
};

function unsavedGitWorkspaceEdits(draft: Record<keyof typeof GIT_FIELD_LABELS, unknown>, saved: Record<keyof typeof GIT_FIELD_LABELS, unknown>) {
  return unsavedEditsBetween(draft, saved, GIT_FIELD_LABELS);
}

/**
 * What has been typed here and not saved (EO-192).
 *
 * Published so an agent asked "what did I just set the base branch to"
 * can answer — and, the half that matters, cannot report it as what is
 * stored. A field nobody has touched must not appear at all, because an
 * unsaved edit that is really the saved value is the same lie one step
 * removed.
 */
describe("the repository editor's unsaved edits", () => {
  const saved = {
    name: "api",
    description: "the Go payments service" as string | null,
    repoPath: "/repos/api",
    baseBranch: "main",
    testCommand: null,
    lintCommand: null,
    buildCommand: null,
    // The five the forge settings became when they moved onto this form
    // (EO-301). Present because the form publishes them like any other
    // field — there is no secret among them, which is the only thing
    // that keeps a field off the list.
    forgeOpenPr: false,
    forgeKind: null,
    forgeRemote: "origin",
    forgeDraft: false,
    forgeTemplatePath: null,
  };

  it("publishes nothing for a form nobody has touched", () => {
    expect(unsavedGitWorkspaceEdits(saved, saved)).toEqual([]);
  });

  it("publishes only what differs, under the label on the field", () => {
    expect(unsavedGitWorkspaceEdits({ ...saved, baseBranch: "release/next" }, saved)).toEqual([
      { field: "Base branch", value: "release/next" },
    ]);
  });

  it("publishes only the fields it was given a label for, which is how a credential stays out", () => {
    // The enumeration is the labels, not the object. A Jira API token
    // and a licence key are typed into fields that hold them before they
    // are saved, and a rule that published "everything unsaved" would
    // put both in a snapshot an agent reads. A field with no label is a
    // field this screen has decided not to publish.
    const typed = { name: "api", token: "supersecret" };
    const stored = { name: "api", token: "" };

    expect(unsavedEditsBetween(typed, stored, { name: "Name" })).toEqual([]);
    expect(JSON.stringify(unsavedEditsBetween(typed, stored, { name: "Name" }))).not.toContain("supersecret");
  });

  it("treats a cleared optional field as an edit rather than as nothing", () => {
    expect(unsavedGitWorkspaceEdits({ ...saved, testCommand: "pnpm test" }, saved)).toEqual([{ field: "test command", value: "pnpm test" }]);
    expect(unsavedGitWorkspaceEdits({ ...saved, description: null }, saved)).toEqual([{ field: "What this repository is", value: "" }]);
  });
});
