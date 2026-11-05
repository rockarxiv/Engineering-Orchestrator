import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ModuleTestCase, ModuleTestRun, ModuleView } from "@eo/core";
import { ipcStub, renderSection, sent, type Answers } from "../views/settings/org/testing";
import { ModuleProposal } from "./ModuleProposal";

/**
 * A module the assistant proposed, as the conversation shows it (EO-398):
 * its name and where it stands, View code, and Approve.
 *
 * The component is given a slug and nothing else, so every case here is
 * about what the *catalog* says — which is the point: the card has to be
 * right when the module was approved somewhere else, or deleted.
 */

const MERGES: ModuleTestCase = { id: "t1", moduleId: "mod-1", description: "merges once CI is green", source: "export default async function (h) { await h.run(); }", createdAt: 1, updatedAt: 1 };
const WAITS: ModuleTestCase = { id: "t2", moduleId: "mod-1", description: "waits while CI runs", source: "export default async function (h) { await h.run({ ci: 'pending' }); }", createdAt: 1, updatedAt: 1 };

function run(lines: number, failing = false): ModuleTestRun {
  return {
    ranAt: 1,
    cases: [
      { testId: "t1", description: MERGES.description, passed: true, failure: null, durationMs: 4, output: "" },
      { testId: "t2", description: WAITS.description, passed: !failing, failure: failing ? "'merged' !== 'waiting'" : null, durationMs: 4, output: "" },
    ],
    coverage: { lines: { covered: lines, total: 100, percent: lines }, branches: { covered: 50, total: 100, percent: 50 } },
  };
}

function module(overrides: Partial<ModuleView> = {}): ModuleView {
  return {
    id: "mod-1",
    slug: "release-merge",
    name: "Release merge",
    description: "Merges the release branch once CI is green.",
    code: "export default async (ctx) => {\n  await ctx.exec('gh', ['pr', 'merge']);\n  return { ok: true, result: 'merged' };\n};",
    manifest: {
      name: "Release merge",
      description: "Merges the release branch once CI is green.",
      inputs: { ciWaitSeconds: { type: "number", description: "How long to wait for CI.", default: 600 } },
      needs: { bin: ["gh"], env: ["GH_TOKEN"], network: true, item: false, comment: false, attach: false, create: false },
      results: ["merged", "ci_failed"],
    },
    originalScript: null,
    source: "architect",
    approvedAt: null,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    usedByStepCount: 0,
    portability: [],
    machineSpecific: [],
    testRun: null,
    testsStale: false,
    testCount: 2,
    ...overrides,
  };
}

/** A catalog that can change under the card, as it does when an approval lands. */
function draw(initial: ModuleView[], answers: Answers = {}) {
  const catalog = { modules: initial };
  const stub = ipcStub({
    "modules:list": () => ({ modules: catalog.modules }),
    "moduleTests:list": { tests: [MERGES, WAITS], problem: null },
    ...answers,
  });
  window.eo.ipc.invoke = stub.invoke as never;
  renderSection(<ModuleProposal slug="release-merge" />);
  return { calls: stub.calls, catalog };
}

describe("a card whose module a corrected one has replaced", () => {
  it("offers no Approve and no View code, and says a newer version is below", async () => {
    const stub = ipcStub({ "modules:list": () => ({ modules: [module()] }), "moduleTests:list": { tests: [MERGES, WAITS], problem: null } });
    window.eo.ipc.invoke = stub.invoke as never;
    renderSection(<ModuleProposal slug="release-merge" replaced="below" />);

    expect(await screen.findByText("Release merge")).toBeInTheDocument();
    expect(screen.getByText("Replaced")).toBeInTheDocument();
    expect(screen.getByText(/A newer version of this module is below/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View code" })).not.toBeInTheDocument();
    expect(screen.queryByText("Not approved")).not.toBeInTheDocument();
  });
});

describe("a card whose module was replaced somewhere else", () => {
  it("offers no Approve and no View code, and says where it is approved instead", async () => {
    const stub = ipcStub({ "modules:list": () => ({ modules: [module()] }), "moduleTests:list": { tests: [MERGES, WAITS], problem: null } });
    window.eo.ipc.invoke = stub.invoke as never;
    renderSection(<ModuleProposal slug="release-merge" replaced="elsewhere" />);

    expect(await screen.findByText("Replaced")).toBeInTheDocument();
    expect(screen.getByText(/was changed after this card was posted/)).toBeInTheDocument();
    expect(screen.queryByText(/is below/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View code" })).not.toBeInTheDocument();
  });
});

describe("a proposed module, in the conversation", () => {
  it("shows its name, description, slug, that it is not approved, and how many test cases it has", async () => {
    const { calls } = draw([module()]);

    expect(await screen.findByText("Release merge")).toBeInTheDocument();
    expect(screen.getByText("Merges the release branch once CI is green.")).toBeInTheDocument();
    expect(screen.getByText("release-merge")).toBeInTheDocument();
    expect(screen.getByText("Not approved")).toBeInTheDocument();
    expect(screen.getByText("2 test cases")).toBeInTheDocument();
    // Its tests have not run, so there is no figure to show yet.
    expect(screen.getByLabelText("Coverage not measured yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "View code" })).toBeInTheDocument();
    // Deleted modules are asked for, so one that is gone can be told from one not loaded.
    expect(sent(calls, "modules:list")[0]).toEqual({ includeArchived: true });
  });

  it("shows its line coverage once its tests have run", async () => {
    draw([module({ testRun: run(91) })]);
    expect(await screen.findByLabelText("Line coverage 91%, branch coverage 50%")).toBeInTheDocument();
  });

  it("opens the code, what the manifest declares, and the test cases with their last result", async () => {
    draw([module({ testRun: run(91, true) })]);

    fireEvent.click(await screen.findByRole("button", { name: "View code" }));
    const dialog = await screen.findByRole("dialog", { name: "Release merge" });

    expect(within(dialog).getByLabelText("Code of Release merge")).toHaveTextContent("await ctx.exec('gh', ['pr', 'merge']);");
    const declares = within(dialog).getByRole("region", { name: "What it declares" });
    expect(declares).toHaveTextContent("Binariesgh");
    expect(declares).toHaveTextContent("Environment variablesGH_TOKEN");
    expect(declares).toHaveTextContent("Network accessYes");
    expect(declares).toHaveTextContent("Resultsmergedci_failed");
    const inputs = within(dialog).getByRole("region", { name: "Inputs" });
    expect(inputs).toHaveTextContent("ciWaitSeconds · number · default 600 — How long to wait for CI.");

    const cases = within(await within(dialog).findByRole("list", { name: "Test cases" })).getAllByRole("listitem");
    expect(cases).toHaveLength(2);
    expect(cases.some((row) => row.textContent?.includes("Passed") && row.textContent.includes(MERGES.description))).toBe(true);
    expect(cases.some((row) => row.textContent?.includes("Failed") && row.textContent.includes(WAITS.description))).toBe(true);
    expect(within(dialog).getByLabelText("Line coverage 91%, branch coverage 50%")).toBeInTheDocument();
    // Read-only: nothing in the window changes the module.
    expect(within(dialog).queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says a module declares that it attaches files, beside whether it comments", async () => {
    draw([module({ manifest: { name: "Release merge", description: "Merges.", inputs: {}, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: true, create: false }, results: ["merged"] } })]);

    fireEvent.click(await screen.findByRole("button", { name: "View code" }));
    const declares = within(await screen.findByRole("dialog", { name: "Release merge" })).getByRole("region", { name: "What it declares" });
    expect(declares).toHaveTextContent("Posts commentsNo");
    expect(declares).toHaveTextContent("Attaches filesYes");
  });

  it("says a module declares that it creates work, beside whether it comments and attaches", async () => {
    draw([module({ manifest: { name: "Release merge", description: "Merges.", inputs: {}, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: true }, results: ["merged"] } })]);

    fireEvent.click(await screen.findByRole("button", { name: "View code" }));
    const declares = within(await screen.findByRole("dialog", { name: "Release merge" })).getByRole("region", { name: "What it declares" });
    expect(declares).toHaveTextContent("Posts commentsNo");
    expect(declares).toHaveTextContent("Attaches filesNo");
    expect(declares).toHaveTextContent("Creates itemsYes");
  });

  it("says a manifest that declares nothing declares nothing", async () => {
    draw([module({ manifest: { name: "Release merge", description: "Merges.", inputs: {}, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false }, results: ["merged"] } })]);

    fireEvent.click(await screen.findByRole("button", { name: "View code" }));
    const dialog = await screen.findByRole("dialog", { name: "Release merge" });
    const declares = within(dialog).getByRole("region", { name: "What it declares" });
    expect(declares).toHaveTextContent("BinariesNone");
    expect(declares).toHaveTextContent("Environment variablesNone");
    expect(declares).toHaveTextContent("Network accessNo");
    expect(declares).toHaveTextContent("Posts commentsNo");
    expect(declares).toHaveTextContent("Attaches filesNo");
    expect(declares).toHaveTextContent("Creates itemsNo");
    expect(within(dialog).getByRole("region", { name: "Inputs" })).toHaveTextContent("It declares no inputs.");
  });

  // EO-449: advice before Approve, naming where each value is — and Approve still there to press.
  it("shows its machine-specific values, naming where each one is, beside an Approve that still works", async () => {
    const machineSpecific = [
      { where: { in: "manifest" as const, entry: 'needs.bin "pwsh"' }, text: "pwsh", kind: "shell_binary" as const, instead: "run the program you need directly, named on PATH" },
      { where: { in: "test" as const, description: MERGES.description, line: 3 }, text: "%APPDATA%", kind: "home_reference" as const, instead: "use harness.cwd, a step input, or a declared environment variable" },
    ];
    const drawn = draw([module({ machineSpecific })], { "modules:approve": { approved: true, problem: null, lineCoverage: 91, coverageAcknowledgementNeeded: false, machineSpecific } });

    const note = await screen.findByRole("note", { name: "Machine-specific values" });
    expect(note).toHaveTextContent('manifest needs.bin "pwsh": pwsh — run the program you need directly, named on PATH');
    expect(note).toHaveTextContent(`test case "${MERGES.description}" line 3: %APPDATA% — use harness.cwd`);

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(sent(drawn.calls, "modules:approve")).toHaveLength(1));
  });

  it("says nothing about machine-specific values when there are none", async () => {
    draw([module()]);
    expect(await screen.findByText("Release merge")).toBeInTheDocument();
    expect(screen.queryByRole("note", { name: "Machine-specific values" })).not.toBeInTheDocument();
  });

  it("approves through modules:approve, then reads Approved and offers no Approve", async () => {
    const drawn = draw([module()], {
      "modules:approve": () => {
        // The main process approved it; the catalog says so from now on.
        drawn.catalog.modules = [module({ approvedAt: 5, testRun: run(91) })];
        return { approved: true, problem: null, lineCoverage: 91, coverageAcknowledgementNeeded: false };
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    expect(await screen.findByText("Approved")).toBeInTheDocument();
    expect(screen.queryByText("Not approved")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Line coverage 91%, branch coverage 50%")).toBeInTheDocument();
    expect(sent(drawn.calls, "modules:approve")).toEqual([{ id: "mod-1", acknowledgeLowCoverage: false }]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the refusal naming each failing case, and stays unapproved", async () => {
    draw([module()], {
      "modules:approve": {
        approved: false,
        problem: '"Release merge" was not approved: 1 of 2 test cases failed.\n- waits while CI runs: \'merged\' !== \'waiting\'',
        lineCoverage: 90,
        coverageAcknowledgementNeeded: false,
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    const refusal = await screen.findByRole("alert");
    expect(refusal).toHaveTextContent("1 of 2 test cases failed");
    expect(refusal).toHaveTextContent("waits while CI runs");
    expect(screen.getByText("Not approved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("states the coverage figure under the bar, and approves on Approve anyway", async () => {
    const drawn = draw([module()], {
      "modules:approve": (payload: unknown) => {
        if (!(payload as { acknowledgeLowCoverage: boolean }).acknowledgeLowCoverage) {
          return { approved: false, problem: "under the bar", lineCoverage: 71.4, coverageAcknowledgementNeeded: true };
        }
        drawn.catalog.modules = [module({ approvedAt: 5, testRun: run(71.4) })];
        return { approved: true, problem: null, lineCoverage: 71.4, coverageAcknowledgementNeeded: false };
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve Release merge?" });
    expect(dialog).toHaveTextContent("71.4%");
    // Nothing is approved by the question being asked.
    expect(screen.getByText("Not approved")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Approve anyway" }));

    expect(await screen.findByText("Approved")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(sent(drawn.calls, "modules:approve")).toEqual([
      { id: "mod-1", acknowledgeLowCoverage: false },
      { id: "mod-1", acknowledgeLowCoverage: true },
    ]);
  });

  it("reads Approved for a module approved somewhere else, with no Approve to press", async () => {
    draw([module({ approvedAt: 9 })]);

    expect(await screen.findByText("Approved")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View code" })).toBeInTheDocument();
  });

  it("says a deleted module is deleted, and offers no Approve", async () => {
    draw([module({ archivedAt: 9 })]);

    expect(await screen.findByText("Deleted")).toBeInTheDocument();
    expect(screen.getByText(/no longer in the catalog/)).toBeInTheDocument();
    expect(screen.getByText("Release merge")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("says the same of a module the catalog does not hold at all", async () => {
    draw([]);

    expect(await screen.findByText("Deleted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });
});
