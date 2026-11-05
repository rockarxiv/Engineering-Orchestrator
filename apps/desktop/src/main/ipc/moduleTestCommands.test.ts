import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ipcContract, type IpcChannel, type ModuleManifest } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { approveModule, archiveModule, getModule } from "../db/repos/index.js";
import { createModuleTestRunner, type ModuleTestRunner } from "../modules/moduleTestRunner.js";
import { TOOLS, type Dispatch } from "../mcpHost/catalog.js";
import { listModuleViews, saveModuleCommand } from "./moduleCommands.js";
import { deleteModuleTestCommand, listModuleTestsCommand, runModuleTestsCommand, saveModuleTestCommand } from "./moduleTestCommands.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "./registry.js";

/**
 * A module's tests over IPC and over `eo_admin` (EO-352).
 *
 * The runner is the real one driving the real host, because what the
 * criteria promise — a save marks the result stale and re-runs it, a
 * read returns the latest result — is about the result actually landing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const launcher = { execPath: process.execPath, hostPath: join(here, "..", "modules", "moduleHost.mjs"), hostEnv: { ELECTRON_RUN_AS_NODE: "1" } };

const manifest: ModuleManifest = {
  name: "Tag release",
  description: "Tags the release.",
  inputs: {},
  needs: { bin: ["git"], env: [], network: false, item: false, comment: false, attach: false, create: false },
  results: ["tagged"],
};

const TAGGING = `export default async function (ctx) {
  const tagged = await ctx.exec("git", ["tag", "v1"]);
  if (tagged.code !== 0) return { ok: false, reason: tagged.stderr };
  return { ok: true, result: "tagged" };
}`;

const PASSING = `import assert from "node:assert/strict";
export default async function (harness) {
  const run = await harness.run({ exec: [{ bin: "git", args: ["tag", "v1"] }] });
  assert.equal(run.outcome.ok, true);
}`;

let handle: DbHandle;
let runner: ModuleTestRunner;
/** Every module a background run stored a result for, in order. */
let stored: string[];
let waiters: Array<() => void>;

/** Resolves once the runner has stored `count` more results. */
function storedResults(count: number): Promise<void> {
  const target = stored.length + count;
  return new Promise((resolve) => {
    const check = (): void => {
      if (stored.length >= target) resolve();
      else waiters.push(check);
    };
    check();
  });
}

function saveTagging(code = TAGGING): string {
  const saved = saveModuleCommand(handle.db, { slug: "tag-release", name: "Tag release", description: "Tags the release.", code, manifest, originalScript: null });
  if (saved.module === null) throw new Error(saved.problem ?? "not saved");
  return saved.module.id;
}

function view(moduleId: string) {
  const found = listModuleViews(handle.db, {}).modules.find((module) => module.id === moduleId);
  if (!found) throw new Error("module not listed");
  return found;
}

beforeEach(() => {
  handle = openMigratedTestDb();
  stored = [];
  waiters = [];
  runner = createModuleTestRunner({
    db: handle.db,
    launcher,
    onStored: (moduleId) => {
      stored.push(moduleId);
      for (const waiter of waiters.splice(0)) waiter();
    },
  });
});

afterEach(() => {
  runner.dispose();
  clearHandlerRegistry();
  handle.close();
});

describe("module test cases over IPC", () => {
  it("creates, edits, lists and deletes a module's cases", async () => {
    const moduleId = saveTagging();

    const first = saveModuleTestCommand(handle.db, runner, { moduleId, description: "tags v1", source: PASSING });
    const second = saveModuleTestCommand(handle.db, runner, { moduleId, description: "reports a failed tag", source: PASSING });
    expect(first).toMatchObject({ saved: true, problem: null, test: { moduleId, description: "tags v1" } });
    expect(listModuleTestsCommand(handle.db, { moduleId }).tests.map((test) => test.description)).toEqual(["tags v1", "reports a failed tag"]);

    const edited = saveModuleTestCommand(handle.db, runner, { id: first.test!.id, moduleId, description: "tags v1 once", source: PASSING });
    expect(edited).toMatchObject({ saved: true, test: { id: first.test!.id, description: "tags v1 once" } });

    expect(deleteModuleTestCommand(handle.db, runner, { id: second.test!.id })).toEqual({ deleted: true, problem: null, approvalWithdrawn: false, moduleId });
    expect(listModuleTestsCommand(handle.db, { moduleId }).tests.map((test) => test.description)).toEqual(["tags v1 once"]);
    expect(deleteModuleTestCommand(handle.db, runner, { id: second.test!.id })).toEqual({ deleted: false, problem: "That test case no longer exists.", approvalWithdrawn: false, moduleId: null });
  });

  it("says how many cases a module has when it is read, whether or not they have run (EO-354)", () => {
    // A runner with no host, so nothing runs: "no tests" and "tests that
    // have not run yet" both have no stored run, and the count is what
    // tells a screen which of the two it is looking at.
    const idle = createModuleTestRunner({ db: handle.db, launcher: null });
    const moduleId = saveTagging();
    expect(view(moduleId)).toMatchObject({ testCount: 0, testRun: null });

    const first = saveModuleTestCommand(handle.db, idle, { moduleId, description: "tags v1", source: PASSING });
    saveModuleTestCommand(handle.db, idle, { moduleId, description: "reports a failed tag", source: PASSING });
    expect(view(moduleId)).toMatchObject({ testCount: 2, testRun: null });

    deleteModuleTestCommand(handle.db, idle, { id: first.test!.id });
    expect(view(moduleId).testCount).toBe(1);
    idle.dispose();
  });

  it("refuses a case for a module that does not exist, or editing a case through another module", () => {
    const moduleId = saveTagging();
    const other = saveModuleCommand(handle.db, { slug: "other", name: "Other", description: "Other.", code: TAGGING, manifest, originalScript: null }).module!.id;
    const test = saveModuleTestCommand(handle.db, runner, { moduleId, description: "tags v1", source: PASSING }).test!;

    expect(saveModuleTestCommand(handle.db, runner, { moduleId: "nope", description: "x", source: PASSING })).toEqual({ saved: false, test: null, problem: "That module no longer exists.", approvalWithdrawn: false });
    expect(saveModuleTestCommand(handle.db, runner, { id: test.id, moduleId: other, description: "x", source: PASSING })).toMatchObject({ saved: false, problem: "That test case belongs to a different module." });
    expect(listModuleTestsCommand(handle.db, { moduleId: "nope" })).toEqual({ tests: [], problem: "That module no longer exists." });
  });

  it("holds the save input to a description and a source", () => {
    const contract = ipcContract["moduleTests:save"].request;
    expect(contract.safeParse({ moduleId: "m", description: "  ", source: "x" }).success).toBe(false);
    expect(contract.safeParse({ moduleId: "m", description: "d", source: "" }).success).toBe(false);
    expect(contract.safeParse({ moduleId: "m", description: "d", source: "x" }).success).toBe(true);
  });

  it("runs a module's cases and stores the result, which reading the module returns", async () => {
    const moduleId = saveTagging();
    saveModuleTestCommand(handle.db, runner, { moduleId, description: "tags v1", source: PASSING });

    const answer = await runModuleTestsCommand(runner, { moduleId });
    expect(answer.problem).toBeNull();
    expect(answer.run?.cases).toMatchObject([{ description: "tags v1", passed: true, failure: null }]);
    expect(answer.run?.coverage.lines.percent).toBeGreaterThan(0);

    const read = view(moduleId);
    expect(read.testsStale).toBe(false);
    expect(read.testRun?.cases).toHaveLength(1);
  });

  it("answers a run of a module that does not exist with a problem", async () => {
    expect(await runModuleTestsCommand(runner, { moduleId: "nope" })).toEqual({ run: null, problem: "That module no longer exists." });
  });

  it("marks the stored result stale when a case is saved, and re-runs it in the background", async () => {
    const moduleId = saveTagging();
    const saving = storedResults(1);
    saveModuleTestCommand(handle.db, runner, { moduleId, description: "tags v1", source: PASSING });
    await saving;
    expect(view(moduleId)).toMatchObject({ testsStale: false, testRun: { cases: [{ passed: true }] } });

    // A second case, which fails: the stored result is stale the moment
    // the case is saved, and fresh again once the re-run lands.
    const rerun = storedResults(1);
    saveModuleTestCommand(handle.db, runner, { moduleId, description: "a failing case", source: `export default async function () { throw new Error("nope"); }` });
    expect(view(moduleId).testsStale).toBe(true);
    await rerun;
    const fresh = view(moduleId);
    expect(fresh.testsStale).toBe(false);
    expect(fresh.testRun?.cases.map((each) => [each.description, each.passed])).toEqual([
      ["tags v1", true],
      ["a failing case", false],
    ]);
  });

  it("marks the stored result stale when a case is deleted, and re-runs it", async () => {
    const moduleId = saveTagging();
    const test = saveModuleTestCommand(handle.db, runner, { moduleId, description: "tags v1", source: PASSING }).test!;
    await runModuleTestsCommand(runner, { moduleId });

    const rerun = storedResults(1);
    deleteModuleTestCommand(handle.db, runner, { id: test.id });
    expect(view(moduleId).testsStale).toBe(true);
    await rerun;
    expect(view(moduleId)).toMatchObject({ testsStale: false, testRun: { cases: [] } });
  });

  it("marks the stored result stale when the module's code is saved, and re-runs it through the modules:save handler", async () => {
    // The handler, not the command: the re-run is wired where the save
    // is registered, so that is what has to be exercised.
    registerHandler(
      "modules:save",
      (payload) => {
        const result = saveModuleCommand(handle.db, payload);
        if (result.module !== null) runner.schedule(result.module.id);
        return result;
      },
      { exposeErrorDetails: true },
    );
    const moduleId = saveTagging();
    saveModuleTestCommand(handle.db, runner, { moduleId, description: "tags v1", source: PASSING });
    await runModuleTestsCommand(runner, { moduleId });
    expect(view(moduleId).testsStale).toBe(false);

    const rerun = storedResults(1);
    const broken = TAGGING.replace('["tag", "v1"]', '["tag", "v2"]');
    const answer = await dispatchIpc("modules:save", { id: moduleId, slug: "tag-release", name: "Tag release", description: "Tags the release.", code: broken, manifest });
    expect(answer.ok).toBe(true);
    expect(view(moduleId).testsStale).toBe(true);
    await rerun;
    const fresh = view(moduleId);
    expect(fresh.testsStale).toBe(false);
    expect(fresh.testRun?.cases[0]?.failure).toContain(`ctx.exec("git", ["tag","v2"]) was not scripted`);
  });

  it("does not re-run for a save that changed nothing the result was taken against", async () => {
    const moduleId = saveTagging();
    saveModuleTestCommand(handle.db, runner, { moduleId, description: "tags v1", source: PASSING });
    await runModuleTestsCommand(runner, { moduleId });
    const before = stored.length;

    // A rename: the code, the manifest and the cases are as they were.
    saveModuleCommand(handle.db, { id: moduleId, slug: "tag-release", name: "Tag a release", description: "Tags the release.", code: TAGGING, manifest, originalScript: null });
    runner.schedule(moduleId);
    await runModuleTestsCommand(runner, { moduleId: "nope" });
    expect(stored.length).toBe(before);
    expect(view(moduleId).testsStale).toBe(false);
  });

  it("reports no run, and nothing stale, for a module whose tests have never run", () => {
    const moduleId = saveTagging();
    expect(view(moduleId)).toMatchObject({ testRun: null, testsStale: false });
  });
});

describe("module test cases through eo_admin", () => {
  const dispatch: Dispatch = (channel: IpcChannel, payload: unknown) => dispatchIpc(channel, payload);
  const tool = (name: string) => {
    const found = TOOLS.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  };

  beforeEach(() => {
    const opts = { exposeErrorDetails: true };
    registerHandler("moduleTests:list", (payload) => listModuleTestsCommand(handle.db, payload), opts);
    registerHandler("moduleTests:save", (payload) => saveModuleTestCommand(handle.db, runner, payload), opts);
    registerHandler("moduleTests:delete", (payload) => deleteModuleTestCommand(handle.db, runner, payload), opts);
    registerHandler("moduleTests:run", (payload) => runModuleTestsCommand(runner, payload), opts);
  });

  it("saves, lists, runs and deletes a case through the four tools", async () => {
    const moduleId = saveTagging();

    const saved = await tool("module_test_save").run(dispatch, { moduleId, description: "tags v1", source: PASSING });
    expect(saved).toMatchObject({ ok: true, refused: false });
    if (!saved.ok) return;
    const id = (saved.data as { test: { id: string } }).test.id;

    const listed = await tool("module_tests_list").run(dispatch, { moduleId });
    expect(listed).toMatchObject({ ok: true, refused: false });
    if (!listed.ok) return;
    expect(listed.text).toContain(`tags v1 (id: ${id})`);
    expect(listed.text).toContain('args: ["tag", "v1"]');

    const ran = await tool("module_tests_run").run(dispatch, { moduleId });
    expect(ran).toMatchObject({ ok: true, refused: false });
    if (!ran.ok) return;
    expect(ran.text).toContain("- passed: tags v1");
    expect(ran.text).toMatch(/1 of 1 passed\. Line coverage \d+(\.\d)?% \(\d+ of \d+ lines\), branch coverage/);

    const deleted = await tool("module_test_delete").run(dispatch, { id });
    expect(deleted).toMatchObject({ ok: true, refused: false });
    expect(listModuleTestsCommand(handle.db, { moduleId }).tests).toEqual([]);
  });

  it("says why a failing case failed, with its output", async () => {
    const moduleId = saveTagging();
    await tool("module_test_save").run(dispatch, {
      moduleId,
      description: "expects the wrong thing",
      source: `import assert from "node:assert/strict";
        export default async function (harness) {
          console.log("about to run");
          const run = await harness.run({ exec: [{ bin: "git", args: ["tag", "v1"], code: 1, stderr: "tag exists" }] });
          assert.equal(run.outcome.ok, true, "the tag should have been made");
        }`,
    });

    const ran = await tool("module_tests_run").run(dispatch, { moduleId });
    expect(ran.ok).toBe(true);
    if (!ran.ok) return;
    expect(ran.text).toContain("- **failed**: expects the wrong thing");
    expect(ran.text).toContain("the tag should have been made");
    expect(ran.text).toContain("about to run");
    expect(ran.text).toContain("$ git tag v1 (scripted)");
  });

  it("refuses a save it cannot make, saying so", async () => {
    const saved = await tool("module_test_save").run(dispatch, { moduleId: "nope", description: "x", source: PASSING });
    expect(saved).toMatchObject({ ok: true, refused: true });
    if (!saved.ok) return;
    expect(saved.text).toContain("That module no longer exists.");
  });
});

/**
 * A module saved with its test cases (EO-355).
 *
 * `modules:save` — and so `module_save` — takes the cases a module
 * arrives with, so a module the system agent writes from the assistant
 * is saved with the tests approving it will run.
 */
describe("a module saved with its test cases", () => {
  const REFUSING = `import assert from "node:assert/strict";
export default async function (harness) {
  const run = await harness.run({ exec: [{ bin: "git", args: ["tag", "v1"], code: 1, stderr: "exists" }] });
  assert.deepEqual(run.outcome, { ok: false, reason: "exists" });
}`;
  const cases = [
    { description: "tags v1", source: PASSING },
    { description: "refuses when the tag exists", source: REFUSING },
  ];

  function saveWith(tests: { description: string; source: string }[], id?: string) {
    return saveModuleCommand(handle.db, {
      ...(id === undefined ? {} : { id }),
      slug: "tag-release",
      name: "Tag release",
      description: "Tags the release.",
      code: TAGGING,
      manifest,
      originalScript: null,
      tests,
    });
  }

  it("creates the module and its cases together, in the order given", () => {
    const saved = saveWith(cases);
    expect(saved).toMatchObject({ saved: true, problem: null, module: { testCount: 2 } });
    expect(listModuleTestsCommand(handle.db, { moduleId: saved.module!.id }).tests.map((test) => [test.description, test.source])).toEqual(
      cases.map((test) => [test.description, test.source]),
    );
  });

  it("adds to an existing module's cases, never twice and never removing one", () => {
    const moduleId = saveWith([cases[0]!]).module!.id;
    saveModuleTestCommand(handle.db, runner, { moduleId, description: "a case written on the module page", source: PASSING });

    const again = saveWith(cases, moduleId);
    expect(again).toMatchObject({ saved: true, module: { testCount: 3 } });
    expect(listModuleTestsCommand(handle.db, { moduleId }).tests.map((test) => test.description)).toEqual([
      "tags v1",
      "a case written on the module page",
      "refuses when the tag exists",
    ]);
  });

  it("keeps two cases in one save that read identically as two, and does not double them on a second save", () => {
    const twin = { description: "tags v1", source: PASSING };
    const moduleId = saveWith([twin, twin]).module!.id;
    expect(listModuleTestsCommand(handle.db, { moduleId }).tests).toHaveLength(2);

    saveWith([twin, twin], moduleId);
    expect(listModuleTestsCommand(handle.db, { moduleId }).tests).toHaveLength(2);
  });

  it("leaves the cases alone when the save carries none", () => {
    const moduleId = saveWith(cases).module!.id;
    const edited = saveModuleCommand(handle.db, { id: moduleId, slug: "tag-release", name: "Tag release", description: "Tags the release.", code: TAGGING.replace("v1", "v2"), manifest, originalScript: null });
    expect(edited.saved).toBe(true);
    expect(listModuleTestsCommand(handle.db, { moduleId }).tests).toHaveLength(2);
  });

  it("saves neither when a case cannot be saved, and says why", () => {
    const moduleId = saveWith([]).module!.id;
    archiveModule(handle.db, moduleId);

    const refused = saveModuleCommand(handle.db, { id: moduleId, slug: "tag-release", name: "Tag release", description: "Tags the release.", code: "export default async () => ({ ok: true, result: 'tagged' });", manifest, originalScript: null, tests: cases });
    expect(refused).toMatchObject({ saved: false, module: null, problem: expect.stringContaining("That module has been deleted.") });
    // Rolled back: the code is what it was, and there are no cases.
    expect(getModule(handle.db, moduleId)?.code).toBe(TAGGING);
    expect(listModuleTestsCommand(handle.db, { moduleId }).tests).toEqual([]);
  });

  it("refuses a case with no description or no source before anything is written", () => {
    const contract = ipcContract["modules:save"].request;
    const base = { slug: "tag-release", name: "Tag release", description: "Tags the release.", code: TAGGING, manifest, originalScript: null };
    expect(contract.safeParse({ ...base, tests: [{ description: "  ", source: PASSING }] }).success).toBe(false);
    expect(contract.safeParse({ ...base, tests: [{ description: "tags v1", source: "" }] }).success).toBe(false);
    expect(contract.safeParse(base).success).toBe(true);
  });

  describe("through eo_admin's module_save", () => {
    const dispatch: Dispatch = (channel: IpcChannel, payload: unknown) => dispatchIpc(channel, payload);
    const tool = (name: string) => {
      const found = TOOLS.find((candidate) => candidate.name === name);
      if (!found) throw new Error(`no tool named ${name}`);
      return found;
    };

    beforeEach(() => {
      const opts = { exposeErrorDetails: true };
      // As `handlers.ts` registers it: a save schedules a run of the tests.
      registerHandler(
        "modules:save",
        (payload) => {
          const result = saveModuleCommand(handle.db, payload);
          if (result.module !== null) runner.schedule(result.module.id);
          return result;
        },
        opts,
      );
      registerHandler("moduleTests:list", (payload) => listModuleTestsCommand(handle.db, payload), opts);
    });

    it("saves the module with its cases, and they are on the module's page once the run lands", async () => {
      const landed = storedResults(1);
      const saved = await tool("module_save").run(dispatch, {
        slug: "tag-release",
        name: "Tag release",
        description: "Tags the release.",
        code: TAGGING,
        manifest,
        tests: cases,
      });
      expect(saved).toMatchObject({ ok: true, refused: false });
      if (!saved.ok) return;
      expect(saved.text).toContain("It has 2 test case(s)");
      const moduleId = (saved.data as { module: { id: string } }).module.id;

      // What the module page lists them from.
      const listed = await tool("module_tests_list").run(dispatch, { moduleId });
      if (!listed.ok) throw new Error("not listed");
      expect(listed.text).toContain("tags v1");
      expect(listed.text).toContain("refuses when the tag exists");

      await landed;
      expect(view(moduleId).testRun?.cases.map((each) => [each.description, each.passed])).toEqual([
        ["tags v1", true],
        ["refuses when the tag exists", true],
      ]);
    });

    it("tells an agent that saved a module with no cases that it cannot be approved yet", async () => {
      const saved = await tool("module_save").run(dispatch, { slug: "tag-release", name: "Tag release", description: "Tags the release.", code: TAGGING, manifest });
      if (!saved.ok) throw new Error("not saved");
      expect(saved.text).toContain("It has no test cases yet, and cannot be approved until it has at least one.");
    });

    it("advertises tests on the tool, each a description and source", () => {
      const advertised = JSON.stringify(tool("module_save").inputSchema);
      expect(advertised).toContain('"tests"');
      expect(advertised).toContain('"description"');
      expect(advertised).toContain('"source"');
    });
  });
});

/**
 * Any change to an approved module's test cases withdraws its approval
 * (EO-498), and every answer says whether it did.
 */
describe("an approved module's test cases", () => {
  const OTHER = PASSING.replace("assert.equal(run.outcome.ok, true);", "assert.ok(run.outcome.ok);");

  /** An approved module with one case. Answers both ids. */
  function approvedWithACase(): { moduleId: string; testId: string } {
    const moduleId = saveTagging();
    const testId = saveModuleTestCommand(handle.db, runner, { moduleId, description: "tags v1", source: PASSING }).test!.id;
    approveModule(handle.db, moduleId);
    expect(getModule(handle.db, moduleId)?.approvedAt).not.toBeNull();
    return { moduleId, testId };
  }
  const approvedAt = (moduleId: string) => getModule(handle.db, moduleId)?.approvedAt ?? null;

  it("loses its approval when moduleTests:save adds a case, and the answer says so", () => {
    const { moduleId } = approvedWithACase();
    const saved = saveModuleTestCommand(handle.db, runner, { moduleId, description: "refuses a second tag", source: PASSING });
    expect(saved).toMatchObject({ saved: true, problem: null, approvalWithdrawn: true });
    expect(approvedAt(moduleId)).toBeNull();
    expect(ipcContract["moduleTests:save"].response.safeParse(saved).success).toBe(true);
  });

  it("loses it when a case is saved by id with a different description or source, and keeps it when saved as it is", () => {
    const { moduleId, testId } = approvedWithACase();

    expect(saveModuleTestCommand(handle.db, runner, { id: testId, moduleId, description: "tags v1", source: PASSING })).toMatchObject({ saved: true, approvalWithdrawn: false });
    expect(approvedAt(moduleId)).not.toBeNull();

    expect(saveModuleTestCommand(handle.db, runner, { id: testId, moduleId, description: "tags v1", source: OTHER })).toMatchObject({ saved: true, approvalWithdrawn: true });
    expect(approvedAt(moduleId)).toBeNull();

    approveModule(handle.db, moduleId);
    expect(saveModuleTestCommand(handle.db, runner, { id: testId, moduleId, description: "tags the release v1", source: OTHER })).toMatchObject({ saved: true, approvalWithdrawn: true });
    expect(approvedAt(moduleId)).toBeNull();
  });

  it("loses it when moduleTests:delete removes a case, and the answer says so", () => {
    const { moduleId, testId } = approvedWithACase();
    const deleted = deleteModuleTestCommand(handle.db, runner, { id: testId });
    expect(deleted).toEqual({ deleted: true, problem: null, approvalWithdrawn: true, moduleId });
    expect(approvedAt(moduleId)).toBeNull();
    expect(ipcContract["moduleTests:delete"].response.safeParse(deleted).success).toBe(true);
  });

  it("says no approval was withdrawn, and changes none, on a module that is not approved", () => {
    const moduleId = saveTagging();
    const added = saveModuleTestCommand(handle.db, runner, { moduleId, description: "tags v1", source: PASSING });
    expect(added).toMatchObject({ saved: true, approvalWithdrawn: false });
    expect(saveModuleTestCommand(handle.db, runner, { id: added.test!.id, moduleId, description: "tags v1", source: OTHER })).toMatchObject({ approvalWithdrawn: false });
    expect(deleteModuleTestCommand(handle.db, runner, { id: added.test!.id })).toMatchObject({ deleted: true, approvalWithdrawn: false });
    expect(approvedAt(moduleId)).toBeNull();
  });

  describe("through modules:save", () => {
    const resave = (moduleId: string, tests?: { description: string; source: string }[]) =>
      saveModuleCommand(handle.db, { id: moduleId, slug: "tag-release", name: "Tag release", description: "Tags the release.", code: TAGGING, manifest, originalScript: null, ...(tests === undefined ? {} : { tests }) });

    it("withdraws it when the save adds a case, though the code and manifest are unchanged", () => {
      const { moduleId } = approvedWithACase();
      const saved = resave(moduleId, [
        { description: "tags v1", source: PASSING },
        { description: "refuses a second tag", source: PASSING },
      ]);
      expect(saved).toMatchObject({ saved: true, approvalWithdrawn: true, module: { approvedAt: null, testCount: 2 } });
      expect(approvedAt(moduleId)).toBeNull();
      expect(ipcContract["modules:save"].response.safeParse(saved).success).toBe(true);
    });

    it("leaves it standing when every case listed is already there, or none is", () => {
      const { moduleId } = approvedWithACase();
      expect(resave(moduleId, [{ description: "tags v1", source: PASSING }])).toMatchObject({ saved: true, approvalWithdrawn: false, module: { testCount: 1 } });
      expect(resave(moduleId)).toMatchObject({ saved: true, approvalWithdrawn: false });
      expect(approvedAt(moduleId)).not.toBeNull();
    });

    it("says it withdrew it when the code changed, and nothing on a module that was not approved", () => {
      const { moduleId } = approvedWithACase();
      const edited = saveModuleCommand(handle.db, { id: moduleId, slug: "tag-release", name: "Tag release", description: "Tags the release.", code: TAGGING.replace("v1", "v2"), manifest, originalScript: null });
      expect(edited).toMatchObject({ saved: true, approvalWithdrawn: true });
      expect(resave(moduleId, [{ description: "another", source: PASSING }])).toMatchObject({ saved: true, approvalWithdrawn: false });
    });
  });

  describe("through eo_admin", () => {
    const dispatch: Dispatch = (channel: IpcChannel, payload: unknown) => dispatchIpc(channel, payload);
    const tool = (name: string) => {
      const found = TOOLS.find((candidate) => candidate.name === name);
      if (!found) throw new Error(`no tool named ${name}`);
      return found;
    };
    const WITHDRAWN = "This withdrew the module's approval";

    beforeEach(() => {
      const opts = { exposeErrorDetails: true };
      registerHandler("moduleTests:save", (payload) => saveModuleTestCommand(handle.db, runner, payload), opts);
      registerHandler("moduleTests:delete", (payload) => deleteModuleTestCommand(handle.db, runner, payload), opts);
      registerHandler("modules:save", (payload) => saveModuleCommand(handle.db, payload), opts);
    });

    it("says in module_test_save's answer when the save withdrew the approval, and not when it did not", async () => {
      const { moduleId, testId } = approvedWithACase();

      const unchanged = await tool("module_test_save").run(dispatch, { id: testId, moduleId, description: "tags v1", source: PASSING });
      expect(unchanged.ok && unchanged.text).not.toContain(WITHDRAWN);

      const added = await tool("module_test_save").run(dispatch, { moduleId, description: "refuses a second tag", source: PASSING });
      expect(added.ok && added.text).toContain(WITHDRAWN);
      expect(added.ok && added.text).toContain("module_approve");
    });

    it("says in module_test_delete's answer when the deletion withdrew the approval", async () => {
      const { testId } = approvedWithACase();
      const deleted = await tool("module_test_delete").run(dispatch, { id: testId });
      expect(deleted).toMatchObject({ ok: true, refused: false });
      expect(deleted.ok && deleted.text).toContain(WITHDRAWN);
    });

    it("says in module_save's answer whether the save withdrew the approval, or left it standing", async () => {
      const { moduleId } = approvedWithACase();
      const base = { id: moduleId, slug: "tag-release", name: "Tag release", description: "Tags the release.", code: TAGGING, manifest };

      const kept = await tool("module_save").run(dispatch, { ...base, tests: [{ description: "tags v1", source: PASSING }] });
      expect(kept.ok && kept.text).toContain("It is still approved");

      const added = await tool("module_save").run(dispatch, { ...base, tests: [{ description: "refuses a second tag", source: PASSING }] });
      expect(added.ok && added.text).toContain("This save withdrew its approval");
    });

    it("states the rule in each tool's description", () => {
      expect(tool("module_test_save").description).toContain("Any change to an approved module's test cases withdraws its approval");
      expect(tool("module_test_delete").description).toContain("Deleting a case of an approved module withdraws its approval");
      expect(tool("module_save").description).toContain("any change to an approved module's test cases withdraws its approval");
    });
  });
});
