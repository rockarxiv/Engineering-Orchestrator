import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ModuleTestCase, ModuleTestRun, ModuleView } from "@eo/core";
import { ipcStub, renderSection } from "../views/settings/org/testing";
import { DraftModuleRow } from "./DraftModuleRow";

/**
 * A module a pipeline draft needs, as a row on the draft card (EO-581):
 * what it does, what it needs and how its tests went without opening
 * anything; its code only once the row is expanded; and no Approve of
 * its own, since the card's one button approves it with the draft.
 */

const MERGES: ModuleTestCase = { id: "t1", moduleId: "mod-1", description: "merges once CI is green", source: "export default async function (h) { await h.run(); }", createdAt: 1, updatedAt: 1 };
const WAITS: ModuleTestCase = { id: "t2", moduleId: "mod-1", description: "waits while CI runs", source: "export default async function (h) { await h.run({ ci: 'pending' }); }", createdAt: 1, updatedAt: 1 };

const RUN: ModuleTestRun = {
  ranAt: 1,
  cases: [
    { testId: "t1", description: MERGES.description, passed: true, failure: null, durationMs: 4, output: "" },
    { testId: "t2", description: WAITS.description, passed: false, failure: "'merged' !== 'waiting'", durationMs: 4, output: "" },
  ],
  coverage: { lines: { covered: 84, total: 100, percent: 84 }, branches: { covered: 50, total: 100, percent: 50 } },
};

const CODE = "export default async (ctx) => {\n  await ctx.exec('gh', ['pr', 'merge']);\n  return { ok: true, result: 'merged' };\n};";

function module(overrides: Partial<ModuleView> = {}): ModuleView {
  return {
    id: "mod-1",
    slug: "release-merge",
    name: "Release merge",
    description: "Merges the release branch once CI is green.",
    code: CODE,
    manifest: {
      name: "Release merge",
      description: "Merges the release branch once CI is green.",
      inputs: { ciWaitSeconds: { type: "number", description: "How long to wait for CI.", default: 600 } },
      needs: { bin: ["gh"], env: ["GH_TOKEN"], network: true, item: false, comment: false, attach: false, create: true },
      results: ["merged", "ci_failed"],
      sideEffects: true,
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
    testRun: RUN,
    testsStale: false,
    testCount: 2,
    ...overrides,
  };
}

function draw(modules: ModuleView[], refusal: string | null = null) {
  const stub = ipcStub({ "modules:list": { modules }, "moduleTests:list": { tests: [MERGES, WAITS], problem: null } });
  window.eo.ipc.invoke = stub.invoke as never;
  renderSection(<DraftModuleRow slug="release-merge" refusal={refusal} />);
  return stub;
}

describe("a module row on a draft card", () => {
  it("shows its description, declared needs and test results without expanding, and its code only once expanded", async () => {
    draw([module()]);

    expect(await screen.findByText("Release merge")).toBeInTheDocument();
    expect(screen.getByText("Not approved")).toBeInTheDocument();
    expect(screen.getByText("Merges the release branch once CI is green.")).toBeInTheDocument();

    const needs = screen.getByLabelText("What Release merge needs");
    expect(needs).toHaveTextContent("Binariesgh");
    expect(needs).toHaveTextContent("Environment variables and secretsGH_TOKEN");
    expect(needs).toHaveTextContent("Network accessYes");
    expect(needs).toHaveTextContent("Outside effectsYes");
    expect(needs).toHaveTextContent(/Creates .*Yes/);

    const tests = screen.getByRole("region", { name: "Tests of Release merge" });
    expect(within(tests).getByText("2 test cases")).toBeInTheDocument();
    expect(within(tests).getByLabelText("Line coverage 84%, branch coverage 50%")).toBeInTheDocument();
    expect(await within(tests).findByText("merges once CI is green")).toBeInTheDocument();
    expect(within(tests).getByText("Passed")).toBeInTheDocument();
    expect(within(tests).getByText("Failed")).toBeInTheDocument();

    // The code is behind the expand.
    expect(screen.queryByLabelText("Code of Release merge")).not.toBeInTheDocument();
    const expand = screen.getByRole("button", { name: "Show code" });
    expect(expand).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(expand);

    expect(screen.getByLabelText("Code of Release merge")).toHaveTextContent("ctx.exec('gh', ['pr', 'merge'])");
    expect(screen.getByRole("region", { name: "Inputs" })).toHaveTextContent("ciWaitSeconds");
    expect(screen.getByRole("button", { name: "Hide code" })).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "Hide code" }));
    expect(screen.queryByLabelText("Code of Release merge")).not.toBeInTheDocument();
  });

  it("offers no Approve of its own", async () => {
    draw([module()]);

    expect(await screen.findByText("Release merge")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("says a module that declares nothing about outside effects has not said, rather than No", async () => {
    const quiet = module();
    const manifest = { ...quiet.manifest };
    delete manifest.sideEffects;
    draw([{ ...quiet, manifest }]);

    expect(await screen.findByLabelText("What Release merge needs")).toHaveTextContent("Outside effectsNot declared");
  });

  it("shows what Approve and publish said about this module when it refused", async () => {
    draw([module()], '"Release merge" was not approved: 1 of 2 test cases failed.\n- waits while CI runs: \'merged\' !== \'waiting\'');

    const refusal = await screen.findByRole("alert");
    expect(refusal).toHaveTextContent("1 of 2 test cases failed");
    expect(refusal).toHaveTextContent("waits while CI runs");
  });

  it("reads Approved once the module is approved, and drops a refusal that no longer applies", async () => {
    draw([module({ approvedAt: 9 })], "an old refusal");

    expect(await screen.findByText("Approved")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows values that only hold on this machine", async () => {
    const machineSpecific = [{ where: { in: "code" as const, line: 2 }, text: "0.0.0.0:8080", kind: "loopback" as const, instead: "take the address as a step input, or a declared environment variable or secret" }];
    draw([module({ machineSpecific })]);

    expect(await screen.findByRole("note", { name: "Machine-specific values" })).toHaveTextContent("code line 2: 0.0.0.0:8080 — take the address as a step input");
  });

  it("says a deleted module means the draft has to be asked for again", async () => {
    draw([module({ archivedAt: 9 })]);

    expect(await screen.findByText("Deleted")).toBeInTheDocument();
    expect(screen.getByText(/this draft cannot be published\. Ask for the draft again\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show code" })).not.toBeInTheDocument();
  });
});
