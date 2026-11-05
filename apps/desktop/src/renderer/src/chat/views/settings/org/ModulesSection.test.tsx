import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ALIAS_RETIREMENT_VERSION, SECTION_LOCK_TEXT } from "@eo/core";
import { ModulesSection } from "../sections/ModulesSection";
import { renderSection, sent, ipcStub, type Call, type Answers } from "./testing";

/** The shared stub, installed where only a test may put it. */
function stubIpc(answers?: Answers) {
  const stub = ipcStub(answers);
  window.eo.ipc.invoke = stub.invoke as never;
  return stub.calls;
}

/**
 * Settings → Modules in the chat layout (KAN-103, EO-74, EO-75, EO-80,
 * EO-353, EO-354, EO-357, EO-361, KAN-178, EO-329): the classic screen's
 * behaviour, case for case — what a person is asked to judge, the advice
 * that is not a gate, save-then-approve through the tests, the Tests panel,
 * one card open at a time, history and restore, and the lock.
 */

const RELEASE_NOTES = {
  id: "019fb8c6-0000-7000-8000-0000000000aa",
  slug: "release-notes",
  name: "Release notes",
  description: "Writes the notes from the work and its thread.",
  code: 'export default async function run(ctx) { return { ok: true, result: "written" }; }',
  manifest: {
    name: "Release notes",
    description: "Writes the notes.",
    inputs: {},
    needs: { bin: [], env: [], network: false, item: true, comment: false, attach: false, create: false },
    results: ["written"],
  },
  originalScript: null,
  source: "user",
  approvedAt: 1,
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
  usedByStepCount: 0,
  portability: [],
  machineSpecific: [],
  testRun: null,
  testsStale: false,
  testCount: 0,
};

const TIDY = {
  ...RELEASE_NOTES,
  id: "019fb8c6-0000-7000-8000-0000000000bb",
  slug: "tidy",
  name: "Tidy",
  manifest: { ...RELEASE_NOTES.manifest, name: "Tidy", needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false } },
};

const BASE = {
  "moduleSecrets:list": { names: [], overrides: [], organisation: [] },
  "moduleTests:list": { tests: [], problem: null },
  "moduleVersions:list": { versions: [], problem: null },
};

function mockIpc(modules: unknown[], answers: Record<string, unknown> = {}): Call[] {
  return stubIpc({ ...BASE, "modules:list": { modules }, ...answers });
}

async function expand(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Details of ${name}`, expanded: false }));
}

const draw = () => renderSection(<ModulesSection />);
const editor = (name: RegExp | string) => within(screen.getByRole("region", { name }));
const UNPORTABLE = /looks like it imports something that is not a Node builtin/;

describe("the modules screen", () => {
  it("says which module reads the work, beside the rest of what it declares", async () => {
    mockIpc([RELEASE_NOTES, TIDY, { ...TIDY, id: "x", name: "Deploy", manifest: { ...TIDY.manifest, needs: { bin: ["flyctl"], env: ["FLY_API_TOKEN"], network: true, item: false, comment: false, attach: false, create: false } } }]);
    draw();

    expect(await screen.findByText("reads items")).toBeInTheDocument();
    expect(screen.getAllByText("reads items")).toHaveLength(1);
    expect(screen.getByText("Needs nothing outside the worktree.")).toBeInTheDocument();
    const deploy = screen.getByLabelText("What Deploy needs");
    expect(deploy).toHaveTextContent("flyctl");
    expect(deploy).toHaveTextContent("FLY_API_TOKEN");
    expect(deploy).toHaveTextContent("network");
  });

  it("says which module comments, separately from which module reads", async () => {
    mockIpc([RELEASE_NOTES, { ...TIDY, name: "Announce", manifest: { ...TIDY.manifest, needs: { bin: [], env: [], network: false, item: false, comment: true, attach: false, create: false } } }]);
    draw();

    expect(await screen.findByText("comments")).toBeInTheDocument();
    expect(screen.getAllByText("comments")).toHaveLength(1);
    expect(screen.getAllByText("reads items")).toHaveLength(1);
    expect(screen.queryByText("Needs nothing outside the worktree.")).not.toBeInTheDocument();
  });

  /** A module declaring only `needs.attach` (EO-414) is not one that needs nothing. */
  it("says which module attaches files, and does not call that needing nothing", async () => {
    mockIpc([{ ...TIDY, name: "Report", manifest: { ...TIDY.manifest, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: true, create: false } } }]);
    draw();

    expect(await screen.findByText("attaches files")).toBeInTheDocument();
    expect(screen.queryByText("comments")).not.toBeInTheDocument();
    expect(screen.queryByText("Needs nothing outside the worktree.")).not.toBeInTheDocument();
  });

  /** A module declaring only `needs.create` (EO-433) is not one that needs nothing either. */
  it("says which module creates work, and does not call that needing nothing", async () => {
    mockIpc([{ ...TIDY, name: "Follow up", manifest: { ...TIDY.manifest, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: true } } }]);
    draw();

    expect(await screen.findByText("creates items")).toBeInTheDocument();
    expect(screen.queryByText("Needs nothing outside the worktree.")).not.toBeInTheDocument();
  });

  /**
   * A module the assistant's card just saved (EO-381): the screen is
   * already open, its list is cached, and the person has been asked to
   * approve something. `config:changed` is what the main process sends
   * when a card's module is saved, and it has to put the module in front
   * of them without their leaving the screen and coming back.
   */
  it("shows a module saved while the screen is open, waiting for approval, once the push arrives", async () => {
    const deliver: (() => void)[] = [];
    window.eo.ipc.subscribe = vi.fn((channel: string, callback: () => void) => {
      if (channel === "config:changed") deliver.push(callback);
      return () => {};
    }) as never;
    const catalog: unknown[] = [RELEASE_NOTES];
    stubIpc({ ...BASE, "modules:list": () => ({ modules: [...catalog] }) });
    draw();
    await screen.findByRole("button", { name: "Details of Release notes", expanded: false });
    expect(screen.queryByText("Release merge")).not.toBeInTheDocument();

    catalog.push({ ...TIDY, id: "019fb8c6-0000-7000-8000-0000000000dd", slug: "release-merge", name: "Release merge", source: "architect", approvedAt: null, testCount: 1 });
    act(() => deliver.forEach((callback) => callback()));

    expect(await screen.findByRole("button", { name: "Details of Release merge", expanded: false })).toBeInTheDocument();
  });

  it("offers an empty catalogue a way to start one", async () => {
    mockIpc([]);
    draw();
    expect(await screen.findByText("No modules yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New module" })).toBeEnabled();
  });

  it("says the manifest is the author's word rather than a limit EO enforces, and what a comment may do", async () => {
    mockIpc([]);
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "New module" }));

    const notice = screen.getByText(/A module runs on this machine with your permissions/);
    expect(notice).toHaveTextContent("it can read your items and their comments");
    expect(notice).toHaveTextContent("rather than a limit EO enforces");
    expect(notice).toHaveTextContent("Approving one is trusting whoever wrote it.");
    expect(notice).toHaveTextContent("post comments of its own");
    expect(notice).toHaveTextContent("signed with its name");
    expect(notice).toHaveTextContent("cannot mention anyone");
  });

  it("warns that a saved module looks unportable, names the line, and does not claim to be the limit", async () => {
    mockIpc([{ ...RELEASE_NOTES, portability: [{ specifier: "node-fetch", line: 4 }] }]);
    draw();
    await expand("Release notes");

    const notice = await screen.findByText(UNPORTABLE);
    expect(notice).toHaveTextContent("would not run on a machine that imported this pipeline");
    expect(notice).toHaveTextContent("this is a read of the text, so a sentence can set it off");
    expect(screen.getByText("node-fetch")).toBeInTheDocument();
    expect(screen.getByText(/line 4:/)).toBeInTheDocument();
  });

  it("warns about the code being typed, before anything is saved, and the warning is not a gate", async () => {
    const calls = mockIpc([]);
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "New module" }));
    expect(screen.queryByText(UNPORTABLE)).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: /^Code/ }), {
      target: { value: 'export default async function run() {\n  const { fetch } = await import("node-fetch");\n  return { ok: true, result: "ok" };\n}\n' },
    });

    expect(screen.getByText(UNPORTABLE)).toBeInTheDocument();
    expect(screen.getByText(/line 2:/)).toBeInTheDocument();
    const form = editor("New module");
    expect(form.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(form.getByRole("button", { name: "Save and approve" })).toBeEnabled();
    expect(sent(calls, "modules:save")).toEqual([]);
  });

  it("drops the warning from the editor when the draft no longer looks unportable", async () => {
    mockIpc([{ ...RELEASE_NOTES, code: 'import fetch from "node-fetch";\nexport default async function run() { return { ok: true, result: "ok" }; }\n', portability: [{ specifier: "node-fetch", line: 1 }] }]);
    draw();

    await expand("Release notes");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getAllByText(UNPORTABLE)).toHaveLength(2);

    fireEvent.change(screen.getByRole("textbox", { name: /^Code/ }), {
      target: { value: 'import { readFile } from "node:fs/promises";\nexport default async function run() { return { ok: true, result: "ok" }; }\n' },
    });
    expect(screen.getAllByText(UNPORTABLE)).toHaveLength(1);
  });

  /**
   * Values that only hold on one machine (EO-449): on the saved module's
   * card, and in the editor as the code and manifest are typed — with the
   * module's test cases scanned too. Each names where it is, and neither
   * button waits on it.
   */
  it("shows a saved module's machine-specific values on its card, naming where each one is", async () => {
    mockIpc([
      {
        ...RELEASE_NOTES,
        machineSpecific: [
          { where: { in: "code", line: 3 }, text: "/home/dev/app", kind: "machine_path", instead: "use ctx.cwd for the step's working directory, or take the path as a step input" },
          { where: { in: "manifest", entry: 'needs.bin "bash"' }, text: "bash", kind: "shell_binary", instead: "run the program you need directly, named on PATH" },
          { where: { in: "test", description: "posts the notes", line: 5 }, text: "localhost:3000", kind: "loopback", instead: "take the address as a step input, or a declared environment variable or secret" },
        ],
      },
    ]);
    draw();
    await expand("Release notes");

    const note = await screen.findByRole("note", { name: "Machine-specific values" });
    expect(note).toHaveTextContent("only exist on this machine");
    expect(note).toHaveTextContent("nothing is refused because of it");
    expect(note).toHaveTextContent("code line 3: /home/dev/app — use ctx.cwd");
    expect(note).toHaveTextContent('manifest needs.bin "bash": bash — run the program you need directly, named on PATH');
    expect(note).toHaveTextContent('test case "posts the notes" line 5: localhost:3000 — take the address as a step input');
  });

  it("warns about machine-specific values in the draft's code, manifest and test cases as they are typed, and still saves", async () => {
    const calls = mockIpc([RELEASE_NOTES], {
      "moduleTests:list": { tests: [{ id: "t1", moduleId: RELEASE_NOTES.id, description: "reads the notes", source: 'export default async (h) => {\n  await h.run({ inputs: { dir: "~/notes" } });\n};', createdAt: 1, updatedAt: 1 }], problem: null },
      "modules:save": { saved: true, module: RELEASE_NOTES, problem: null },
    });
    draw();

    await expand("Release notes");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const form = editor(/Edit Release notes/);
    const note = await form.findByRole("note", { name: "Machine-specific values" });
    expect(note).toHaveTextContent('test case "reads the notes" line 2: ~/notes — use harness.cwd');

    fireEvent.change(form.getByRole("textbox", { name: /^Code/ }), {
      target: { value: 'export default async function run(ctx) {\n  return { ok: true, result: "written", detail: "C:\\\\notes" };\n}' },
    });
    fireEvent.change(form.getByRole("textbox", { name: /^Manifest/ }), {
      target: { value: JSON.stringify({ ...RELEASE_NOTES.manifest, needs: { ...RELEASE_NOTES.manifest.needs, bin: ["/usr/local/bin/gh"] } }) },
    });
    expect(note).toHaveTextContent("code line 2: C:\\\\notes");
    expect(note).toHaveTextContent('manifest needs.bin "/usr/local/bin/gh": /usr/local/bin/gh — name the binary on PATH');

    expect(form.getByRole("button", { name: "Save and approve" })).toBeEnabled();
    fireEvent.click(form.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent(calls, "modules:save")).toHaveLength(1));
  });

  it("reports a manifest that is not valid JSON beside the editor, and saves nothing", async () => {
    const calls = mockIpc([]);
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "New module" }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Manifest/ }), { target: { value: "{ not json" } });
    fireEvent.click(editor("New module").getByRole("button", { name: "Save" }));

    expect(await editor("New module").findByRole("alert")).toBeInTheDocument();
    expect(sent(calls, "modules:save")).toEqual([]);
  });

  it("saves a new module with what was typed, and closes the editor", async () => {
    const calls = mockIpc([], { "modules:save": { saved: true, module: TIDY, problem: null } });
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "New module" }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Name/ }), { target: { value: "Tidy" } });
    fireEvent.change(screen.getByRole("textbox", { name: /^Slug/ }), { target: { value: "tidy" } });
    fireEvent.click(editor("New module").getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("region", { name: "New module" })).not.toBeInTheDocument());
    expect(sent(calls, "modules:save")[0]).toMatchObject({ name: "Tidy", slug: "tidy", source: "user", originalScript: null });
    expect(sent(calls, "modules:save")[0]).not.toHaveProperty("id");
    expect(sent(calls, "modules:approve")).toEqual([]);
  });

  /** The manifest's `watch` flag (EO-458): shown on the card, and edited with a switch that writes it into the manifest. */
  it("shows which module can keep checking, and turns the flag on and off in the manifest that is saved", async () => {
    const calls = mockIpc([TIDY, { ...RELEASE_NOTES, manifest: { ...RELEASE_NOTES.manifest, watch: true } }], { "modules:save": { saved: true, module: TIDY, problem: null } });
    draw();

    expect(await screen.findByText(/Returns written · can keep checking · used by 0 steps/)).toBeInTheDocument();
    expect(screen.getAllByText(/can keep checking/)).toHaveLength(1);

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]!);
    const flag = editor("Edit Release notes").getByRole("switch", { name: "Can keep checking" });
    expect(flag).toHaveAttribute("aria-checked", "true");
    fireEvent.click(flag);
    expect(flag).toHaveAttribute("aria-checked", "false");
    expect(JSON.parse((screen.getByRole("textbox", { name: /^Manifest/ }) as HTMLTextAreaElement).value)).not.toHaveProperty("watch");
    fireEvent.click(flag);
    fireEvent.click(editor("Edit Release notes").getByRole("button", { name: "Save" }));

    await waitFor(() => expect(sent(calls, "modules:save")).toHaveLength(1));
    expect(sent(calls, "modules:save")[0]).toMatchObject({ manifest: { watch: true } });
  });

  it("holds the flag still while the manifest is not JSON it can be read from", async () => {
    mockIpc([]);
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "New module" }));
    const flag = editor("New module").getByRole("switch", { name: "Can keep checking" });
    expect(flag).toHaveAttribute("aria-checked", "false");
    expect(flag).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox", { name: /^Manifest/ }), { target: { value: "{ not json" } });
    expect(flag).toBeDisabled();
    expect(editor("New module").getByText("Fix the manifest's JSON to change this here.")).toBeInTheDocument();
  });

  it("says a module still on a step cannot be deleted", async () => {
    const calls = mockIpc([TIDY], { "modules:archive": { archived: false, usedByStepCount: 2 } });
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Still used by 2 step(s). Take it off those steps first.")).toBeInTheDocument();
    expect(sent(calls, "modules:archive")).toEqual([{ id: TIDY.id }]);
  });
});

describe("a module still calling ctx.ticket()", () => {
  const OLD = { ...RELEASE_NOTES, code: 'export default async function run(ctx) { const it = await ctx.ticket(); return { ok: true, result: "written", detail: it.key }; }' };

  it("says so on the card, in the wording the other surfaces use", async () => {
    mockIpc([OLD]);
    draw();
    await expand("Release notes");

    const notice = await screen.findByText(new RegExp(`uses ticket_\\* names · retired after v${ALIAS_RETIREMENT_VERSION}`));
    expect(notice).toHaveTextContent("It still runs; what changes is the release after this one.");
    expect(screen.getByText("ctx.ticket()")).toBeInTheDocument();
    expect(screen.getByText("ctx.item()")).toBeInTheDocument();
  });

  it("says nothing about a module that has moved", async () => {
    mockIpc([{ ...RELEASE_NOTES, code: 'export default async function run(ctx) { await ctx.item(); return { ok: true, result: "written" }; }' }]);
    draw();
    await expand("Release notes");
    expect(screen.queryByText(/uses ticket_\* names/)).not.toBeInTheDocument();
  });

  it("says it about what is in the textarea, not only about what was saved", async () => {
    mockIpc([]);
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "New module" }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Code/ }), { target: { value: "export default async (ctx) => { await ctx.ticketByKey('KAN-1'); }" } });

    expect(screen.getByText(/uses ticket_\* names/)).toBeInTheDocument();
    expect(screen.getByText("ctx.itemByKey()")).toBeInTheDocument();
  });
});

describe("saving and approving a module", () => {
  type Approve = (payload: { id: string; acknowledgeLowCoverage?: boolean }) => Record<string, unknown>;

  function mockSaving(approve: Approve) {
    return mockIpc([TIDY], {
      "modules:save": { saved: true, module: TIDY, problem: null },
      "modules:approve": (payload: unknown) => approve(payload as { id: string; acknowledgeLowCoverage?: boolean }),
    });
  }

  async function saveAndApprove() {
    draw();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and approve" }));
  }

  it("offers no dry run", async () => {
    mockSaving(() => ({ approved: true, problem: null, lineCoverage: 100, coverageAcknowledgementNeeded: false }));
    draw();
    await screen.findByText("Tidy");
    expect(screen.queryByRole("button", { name: "Dry run" })).not.toBeInTheDocument();
  });

  it("saves without approving, then approves through the tests, with no window when coverage is at the bar", async () => {
    const calls = mockSaving(() => ({ approved: true, problem: null, lineCoverage: 85, coverageAcknowledgementNeeded: false }));
    await saveAndApprove();

    await waitFor(() => expect(screen.queryByRole("button", { name: "Save and approve" })).not.toBeInTheDocument());
    expect(sent(calls, "modules:save")[0]).not.toHaveProperty("approve");
    expect(sent(calls, "modules:save")[0]).toMatchObject({ id: TIDY.id });
    expect(sent(calls, "modules:approve")).toEqual([{ id: TIDY.id, acknowledgeLowCoverage: false }]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the editor open with every failing case named when the tests refuse it", async () => {
    mockSaving(() => ({
      approved: false,
      problem: '"Tidy" was not approved: 1 of 2 test cases failed.\n- tidies the branch: expected 0 to equal 1',
      lineCoverage: 90,
      coverageAcknowledgementNeeded: false,
    }));
    await saveAndApprove();

    const refusal = await screen.findByText(/1 of 2 test cases failed/);
    expect(refusal).toHaveTextContent("tidies the branch");
    expect(screen.getByRole("button", { name: "Save and approve" })).toBeInTheDocument();
  });

  it("says when a module has no tests to approve it on", async () => {
    mockSaving(() => ({ approved: false, problem: '"Tidy" has no tests, so it cannot be approved.', lineCoverage: null, coverageAcknowledgementNeeded: false }));
    await saveAndApprove();
    expect(await screen.findByText(/has no tests, so it cannot be approved/)).toBeInTheDocument();
  });

  it("states the coverage under the bar in a window, and approves only on confirm", async () => {
    const calls = mockSaving((payload) =>
      payload.acknowledgeLowCoverage
        ? { approved: true, problem: null, lineCoverage: 71.4, coverageAcknowledgementNeeded: false }
        : { approved: false, problem: "under the bar", lineCoverage: 71.4, coverageAcknowledgementNeeded: true },
    );
    await saveAndApprove();

    const dialog = await screen.findByRole("dialog", { name: "Approve Tidy?" });
    expect(dialog).toHaveTextContent("71.4%");
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve anyway" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Save and approve" })).not.toBeInTheDocument());
    expect(sent(calls, "modules:approve")).toEqual([
      { id: TIDY.id, acknowledgeLowCoverage: false },
      { id: TIDY.id, acknowledgeLowCoverage: true },
    ]);
  });

  it("leaves the module unapproved when the window is cancelled", async () => {
    const calls = mockSaving(() => ({ approved: false, problem: "under the bar", lineCoverage: 40, coverageAcknowledgementNeeded: true }));
    await saveAndApprove();

    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText(/Not approved\. Line coverage of "Tidy" is 40%/)).toBeInTheDocument();
    expect(sent(calls, "modules:approve")).toEqual([{ id: TIDY.id, acknowledgeLowCoverage: false }]);
  });
});

describe("a module's tests", () => {
  const MERGE = { ...TIDY, id: "019fb8c6-0000-7000-8000-0000000000cc", slug: "merge-pr", name: "Merge pull request" };
  const CASES = [
    { id: "t1", moduleId: MERGE.id, description: "merges once CI is green", source: "export default async function (h) { /* merges */ }", createdAt: 0, updatedAt: 0 },
    { id: "t2", moduleId: MERGE.id, description: "waits while CI runs", source: "export default async function (h) { /* waits */ }", createdAt: 0, updatedAt: 0 },
  ];
  function testRun(cases: { testId: string; description: string; passed: boolean; failure: string | null }[], lines: number, branches: number) {
    return {
      ranAt: 1,
      cases: cases.map((each) => ({ ...each, durationMs: 1, output: "" })),
      coverage: { lines: { covered: lines, total: 100, percent: lines }, branches: { covered: branches, total: 100, percent: branches } },
    };
  }
  const BOTH_RAN = testRun(
    [
      { testId: "t1", description: "merges once CI is green", passed: true, failure: null },
      { testId: "t2", description: "waits while CI runs", passed: false, failure: "AssertionError: expected the merge to wait" },
    ],
    72,
    50,
  );

  /** IPC whose answers a test can change, and a push it can deliver. */
  function live(state: { module: unknown; tests: unknown[] }) {
    const deliver: (() => void)[] = [];
    window.eo.ipc.subscribe = vi.fn((channel: string, callback: () => void) => {
      if (channel === "config:changed") deliver.push(callback);
      return () => {};
    }) as never;
    const calls = stubIpc({
      ...BASE,
      "modules:list": () => ({ modules: [state.module] }),
      "moduleTests:list": () => ({ tests: [...state.tests], problem: null }),
      "moduleTests:delete": { deleted: true, problem: null, approvalWithdrawn: true },
      "moduleTests:run": { run: null, problem: null },
    });
    return { calls, push: () => act(() => deliver.forEach((callback) => callback())) };
  }

  it("lists every case with its status, and opens one to its source and failure", async () => {
    live({ module: { ...MERGE, testRun: BOTH_RAN, testsStale: false, testCount: 2 }, tests: CASES });
    draw();
    await expand("Merge pull request");

    const panel = within(await screen.findByRole("region", { name: "Tests of Merge pull request" }));
    const rows = await panel.findAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Passed");
    expect(rows[0]).toHaveTextContent("merges once CI is green");
    expect(rows[1]).toHaveTextContent("Failed");
    expect(panel.getByText("72% lines")).toHaveAttribute("data-tone", "warning");
    expect(panel.getByText("50% branches")).toBeInTheDocument();

    fireEvent.click(panel.getByRole("button", { name: /waits while CI runs/, expanded: false }));
    expect(panel.getByLabelText("Failure of waits while CI runs")).toHaveTextContent("expected the merge to wait");
    expect(panel.getByLabelText("Source of waits while CI runs")).toHaveTextContent("/* waits */");
  });

  it("says a module with no tests is red 0%", async () => {
    live({ module: { ...MERGE, testRun: null, testsStale: false, testCount: 0 }, tests: [] });
    draw();
    await expand("Merge pull request");

    const panel = within(await screen.findByRole("region", { name: "Tests of Merge pull request" }));
    expect(panel.getByText("0% lines")).toHaveAttribute("data-tone", "danger");
    expect(await panel.findByText("No test cases yet.")).toBeInTheDocument();
  });

  it("deletes a case, and the coverage follows once the re-run lands", async () => {
    const state = { module: { ...MERGE, testRun: BOTH_RAN, testsStale: false, testCount: 2 } as unknown, tests: CASES as unknown[] };
    const ipc = live(state);
    draw();
    await expand("Merge pull request");

    const panel = within(await screen.findByRole("region", { name: "Tests of Merge pull request" }));
    await panel.findByText("waits while CI runs");
    fireEvent.click(panel.getByRole("button", { name: "Delete waits while CI runs" }));
    fireEvent.click(panel.getByRole("button", { name: "Confirm deleting waits while CI runs" }));
    // The module is approved, so the delete asks first (EO-500).
    expect(sent(ipc.calls, "moduleTests:delete")).toEqual([]);
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/steps that run Merge pull request stop until it is approved again/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "Delete and withdraw approval" }));
    await waitFor(() => expect(sent(ipc.calls, "moduleTests:delete")).toEqual([{ id: "t2" }]));
    // Withdrawn, and Approve offered, without the screen reloading.
    expect(await panel.findByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(panel.getByRole("status")).toHaveTextContent("Not approved");

    state.tests = [CASES[0]];
    state.module = { ...MERGE, approvedAt: null, testRun: testRun([{ testId: "t1", description: "merges once CI is green", passed: true, failure: null }], 55, 25), testsStale: false, testCount: 1 };
    ipc.push();

    expect(await panel.findByText("55% lines")).toHaveAttribute("data-tone", "danger");
    await waitFor(() => expect(panel.queryByText("waits while CI runs")).not.toBeInTheDocument());
  });

  it("re-runs the suite on Run tests, and says a stale run is being redone", async () => {
    const ipc = live({ module: { ...MERGE, testRun: BOTH_RAN, testsStale: true, testCount: 2 }, tests: CASES });
    draw();
    await expand("Merge pull request");

    const panel = within(await screen.findByRole("region", { name: "Tests of Merge pull request" }));
    expect(await panel.findAllByText("Not run")).toHaveLength(2);
    expect(panel.getByText(/the tests are re-running against what is saved now/)).toBeInTheDocument();
    fireEvent.click(panel.getByRole("button", { name: "Run tests" }));
    await waitFor(() => expect(sent(ipc.calls, "moduleTests:run")).toEqual([{ moduleId: MERGE.id }]));
  });
});

describe("collapsed module cards", () => {
  const OPEN_ONE = {
    ...RELEASE_NOTES,
    code: 'export default async function run(ctx) { await ctx.ticket(); return { ok: true, result: "written" }; }',
    portability: [{ specifier: "node-fetch", line: 4 }],
  };
  const tests = (name: string) => screen.queryByRole("region", { name: `Tests of ${name}` });

  it("opens with every card collapsed, showing the summary and nothing below it", async () => {
    mockIpc([OPEN_ONE, TIDY]);
    draw();

    expect(await screen.findByRole("button", { name: "Details of Release notes" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Details of Tidy" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("release-notes")).toBeInTheDocument();
    expect(screen.getAllByText("Approved")).toHaveLength(2);
    expect(screen.getAllByText(RELEASE_NOTES.description)).toHaveLength(2);
    expect(screen.getAllByText(/Returns written · used by 0 steps/)).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(2);
    expect(screen.queryByText(UNPORTABLE)).not.toBeInTheDocument();
    expect(screen.queryByText(/uses ticket_\* names/)).not.toBeInTheDocument();
    expect(tests("Release notes")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add scenario/ })).not.toBeInTheDocument();
  });

  it("shows the warnings, the Tests panel and the scenario chat's button of the card that is expanded", async () => {
    mockIpc([OPEN_ONE, TIDY]);
    draw();
    await expand("Release notes");

    expect(screen.getByRole("button", { name: "Details of Release notes" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(UNPORTABLE)).toBeInTheDocument();
    expect(screen.getByText(/uses ticket_\* names/)).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Tests of Release notes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add scenario" })).toBeInTheDocument();
    expect(tests("Tidy")).not.toBeInTheDocument();
  });

  it("collapses the expanded card when another is expanded, and on a second press", async () => {
    mockIpc([OPEN_ONE, TIDY]);
    draw();

    await expand("Release notes");
    await expand("Tidy");
    expect(screen.getByRole("button", { name: "Details of Release notes" })).toHaveAttribute("aria-expanded", "false");
    expect(tests("Release notes")).not.toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Tests of Tidy" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Details of Tidy", expanded: true }));
    expect(tests("Tidy")).not.toBeInTheDocument();
  });

  it("edits and deletes a collapsed card without expanding it", async () => {
    mockIpc([TIDY]);
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Save and approve" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(window.eo.ipc.invoke).toHaveBeenCalledWith("modules:archive", { id: TIDY.id }));
    expect(screen.getByRole("button", { name: "Details of Tidy" })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("a module's history", () => {
  const WRITES = ["modules:save", "modules:approve", "modules:archive", "moduleVersions:restore", "moduleTests:save", "moduleTests:delete"];
  const V2_CODE = 'export default async function run(ctx) { return { ok: true, result: "v2" }; }';
  const V2_MANIFEST = { ...TIDY.manifest, results: ["v2-result"] };
  const NOW = { ...TIDY, code: 'export default async function run(ctx) { return { ok: true, result: "v3" }; }', approvedAt: null, testCount: 3 };
  const VERSIONS = [
    { number: 3, createdAt: Date.UTC(2026, 9, 3, 12), approvedAt: null, approved: false, current: true, testCount: 3 },
    { number: 2, createdAt: Date.UTC(2026, 9, 2, 12), approvedAt: 5, approved: true, current: false, testCount: 2 },
    { number: 1, createdAt: Date.UTC(2026, 9, 1, 12), approvedAt: null, approved: false, current: false, testCount: 0 },
  ];
  const V2 = {
    ...VERSIONS[1],
    name: TIDY.name,
    description: TIDY.description,
    code: V2_CODE,
    manifest: V2_MANIFEST,
    tests: [
      { id: "c1", description: "tidies a merged branch", source: "export default async function (h) {}", createdAt: 0, updatedAt: 0 },
      { id: "c2", description: "leaves an open branch alone", source: "export default async function (h) {}", createdAt: 0, updatedAt: 0 },
    ],
  };

  function history({ restoredApproved, refuse = null }: { restoredApproved: boolean; refuse?: string | null }) {
    let module: Record<string, unknown> = NOW;
    const calls = stubIpc({
      ...BASE,
      "modules:list": () => ({ modules: [module] }),
      "moduleVersions:list": { versions: VERSIONS, problem: null },
      "moduleVersions:get": (payload: unknown) =>
        (payload as { number: number }).number === 2 ? { version: V2, problem: null } : { version: null, problem: "not mocked" },
      "moduleVersions:restore": () => {
        if (refuse !== null) return { restored: false, module: null, version: null, problem: refuse };
        module = { ...NOW, code: V2_CODE, manifest: V2_MANIFEST, testCount: 2, approvedAt: restoredApproved ? 5 : null };
        return { restored: true, module, version: 4, problem: null };
      },
    });
    return { calls, writes: () => calls.filter((call) => WRITES.includes(call.channel)) };
  }

  const restoring = async () => within(await screen.findByRole("region", { name: "Restoring Tidy" }));

  async function openHistory() {
    draw();
    await expand("Tidy");
    return within(await screen.findByRole("region", { name: "History of Tidy" }));
  }

  it("lists the kept versions newest first, with their dates, approvals and which is current", async () => {
    history({ restoredApproved: true });
    const panel = await openHistory();

    const rows = await panel.findAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["v3", "v2", "v1"]);
    expect(rows[0]).toHaveTextContent(new Date(VERSIONS[0]!.createdAt).toLocaleString());
    expect(within(rows[0]!).getByText("Current")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Approved")).toBeInTheDocument();
    expect(within(rows[0]!).queryByText("Approved")).not.toBeInTheDocument();
    expect(within(rows[0]!).queryByRole("button", { name: "Restore v3" })).not.toBeInTheDocument();
    expect(within(rows[1]!).getByRole("button", { name: "Restore v2" })).toBeInTheDocument();
    expect(within(rows[2]!).getByRole("button", { name: "Restore v1" })).toBeInTheDocument();
  });

  it("shows a selected version's code, manifest and test cases, with nothing to edit", async () => {
    const { writes } = history({ restoredApproved: true });
    const panel = await openHistory();

    fireEvent.click(await panel.findByRole("button", { name: "Show v2", expanded: false }));

    expect(await panel.findByLabelText("Code of v2")).toHaveTextContent('result: "v2"');
    expect(panel.getByLabelText("Manifest of v2")).toHaveTextContent('"v2-result"');
    const cases = within(panel.getByRole("list", { name: "Test cases of v2" }));
    expect(cases.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["tidies a merged branch", "leaves an open branch alone"]);
    expect(panel.queryAllByRole("textbox")).toHaveLength(0);
    expect(writes()).toEqual([]);
  });

  it("opens the editor read-only on a restored version, saves it through the restore, and the card shows it approved again", async () => {
    const { calls, writes } = history({ restoredApproved: true });
    const panel = await openHistory();
    expect(screen.getByText("Not approved")).toBeInTheDocument();

    fireEvent.click(await panel.findByRole("button", { name: "Restore v2" }));

    const form = await restoring();
    expect(form.getByRole("textbox", { name: /^Code/ })).toHaveValue(V2_CODE);
    expect(JSON.parse((form.getByRole("textbox", { name: /^Manifest/ }) as HTMLTextAreaElement).value)).toEqual(V2_MANIFEST);
    expect(form.getByRole("note", { name: "Restoring v2" })).toHaveTextContent("Saving restores v2 including its 2 test cases, replacing the current 3.");
    for (const field of [/^Name/, /^Slug/, /^Description/, /^Manifest/, /^Code/]) {
      expect(form.getByRole("textbox", { name: field })).toHaveAttribute("readonly");
    }
    expect(writes()).toEqual([]);

    fireEvent.click(form.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("region", { name: "Restoring Tidy" })).not.toBeInTheDocument());
    expect(writes()).toEqual([{ channel: "moduleVersions:restore", payload: { moduleId: TIDY.id, number: 2 } }]);
    expect(calls.some((call) => call.channel === "modules:save")).toBe(false);
    expect(await screen.findByText("Approved", { selector: "h3 ~ *" })).toBeInTheDocument();
    expect(screen.queryByText("Not approved")).not.toBeInTheDocument();
  });

  it("leaves the module as it was when the restore is refused, and when it is cancelled", async () => {
    const { writes } = history({ restoredApproved: true, refuse: 'v2 is already the version "Tidy" is on.' });
    const panel = await openHistory();

    fireEvent.click(await panel.findByRole("button", { name: "Restore v2" }));
    fireEvent.click((await restoring()).getByRole("button", { name: "Save" }));

    expect(await screen.findByText('v2 is already the version "Tidy" is on.')).toBeInTheDocument();
    expect(screen.getByRole("note", { name: "Restoring v2" })).toBeInTheDocument();
    expect(writes()).toEqual([{ channel: "moduleVersions:restore", payload: { moduleId: TIDY.id, number: 2 } }]);
    expect(screen.getByText("Not approved")).toBeInTheDocument();

    fireEvent.click((await restoring()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("note", { name: "Restoring v2" })).not.toBeInTheDocument();
    expect(writes()).toHaveLength(1);
  });
});

describe("Modules under a published section (EO-329)", () => {
  function locked(sections: string[]) {
    return {
      "sections:list": {
        published: sections.map((section) => ({
          section,
          subjectId: "",
          versionId: null,
          versionNumber: null,
          publishedAt: 1_700_000_000_000,
          publishedBy: "dana-id",
          publishedByName: "Dana",
          document: null,
        })),
        locked: sections,
        lockText: SECTION_LOCK_TEXT,
      },
    };
  }

  it("draws the lock and fences the screen when the pipelines section is published", async () => {
    mockIpc([TIDY], locked(["pipelines"]));
    draw();

    const lock = await screen.findByTestId("managed-lock-pipelines");
    expect(lock).toHaveTextContent("Your sign-ins, local folders and personal secrets are yours.");
    await waitFor(() => expect(screen.getByRole("button", { name: "New module" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
  });

  it("draws nothing when the organisation has published nothing", async () => {
    mockIpc([TIDY], locked([]));
    draw();

    await waitFor(() => expect(screen.getByRole("button", { name: "New module" })).toBeEnabled());
    expect(screen.queryByTestId("managed-lock-pipelines")).toBeNull();
  });
});

describe("the environment variables panel (EO-486)", () => {
  it("sits beside Secrets, says the values are not secret and who receives them, and adds one", async () => {
    let variables: unknown[] = [];
    const calls = mockIpc([RELEASE_NOTES], {
      "environmentVariables:list": () => ({ variables }),
      "environmentVariables:set": (payload: unknown) => {
        const { name, value } = payload as { name: string; value: string };
        variables = [{ name, value, scope: "shared" }];
        return { saved: true, problem: null };
      },
    });
    draw();

    const panel = await screen.findByRole("region", { name: "Environment variables" });
    expect(screen.getByRole("region", { name: "Secrets" })).toBeInTheDocument();
    expect(panel).toHaveTextContent("Not secret");
    expect(panel).toHaveTextContent("shown here in full");
    expect(panel).toHaveTextContent("appear in transcripts");
    expect(panel).toHaveTextContent("a module, for the names it declares in needs.env");
    expect(panel).toHaveTextContent("an MCP server, for the names it declares");
    expect(panel).toHaveTextContent("every agent run");

    fireEvent.change(within(panel).getByLabelText("Variable name"), { target: { value: "REGION" } });
    fireEvent.change(within(panel).getByLabelText("Variable value"), { target: { value: "eu-west-1" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Add variable" }));

    await waitFor(() => expect(sent(calls, "environmentVariables:set")).toEqual([{ name: "REGION", value: "eu-west-1", stepId: null }]));
    expect(await within(panel).findByLabelText("Value of variable REGION")).toHaveValue("eu-west-1");
  });
});
