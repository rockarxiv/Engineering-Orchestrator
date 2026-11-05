import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SECTION_LOCKED_CHANNELS, ipcContract, type IpcChannel, type ModuleManifest, type ModuleTestRun } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { getModule, getModuleTestResult, listModuleTests, moduleTestFingerprint, saveModuleTest, setModuleVersionsToKeep } from "../db/repos/index.js";
import { createModuleTestRunner, type ModuleTestRunner } from "../modules/moduleTestRunner.js";
import { TOOLS, type Dispatch } from "../mcpHost/catalog.js";
import {
  approveModuleCommand,
  getModuleVersionCommand,
  listModuleVersionsCommand,
  restoreModuleVersionCommand,
  saveModuleCommand,
} from "./moduleCommands.js";
import { deleteModuleTestCommand, saveModuleTestCommand } from "./moduleTestCommands.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "./registry.js";

/**
 * A module's versions over IPC and over `eo_admin` (EO-360).
 *
 * Mostly against a stand-in runner: what is under test there is which
 * version a save, an approval and a restore leave where. Whether a
 * restore's tests actually run is asked of the real runner driving the
 * real host, at the end, because that is a claim about a result landing.
 */

const manifest: ModuleManifest = {
  name: "Tag release",
  description: "Tags the release.",
  inputs: {},
  needs: { bin: ["git"], env: [], network: false, item: false, comment: false, attach: false, create: false },
  results: ["tagged"],
};

const code = (tag: string) => `export default async function (ctx) {
  await ctx.exec("git", ["tag", "${tag}"]);
  return { ok: true, result: "tagged" };
}`;

const PASSING_RUN: ModuleTestRun = {
  ranAt: 1,
  cases: [{ testId: "t", description: "tags", passed: true, failure: null, durationMs: 1, output: "" }],
  coverage: { lines: { covered: 10, total: 10, percent: 100 }, branches: { covered: 1, total: 1, percent: 100 } },
};

const opts = { exposeErrorDetails: true };

let handle: DbHandle;
/** Every `schedule` the stand-in runner was asked for, with whether it was forced. */
let scheduled: { moduleId: string; force: boolean }[];
let runner: ModuleTestRunner;

beforeEach(() => {
  handle = openMigratedTestDb();
  scheduled = [];
  // Every run passes, against whatever is saved when it is asked.
  runner = {
    run: async (moduleId) => {
      const module = getModule(handle.db, moduleId)!;
      return { run: PASSING_RUN, fingerprint: moduleTestFingerprint(module, listModuleTests(handle.db, moduleId)), problem: null };
    },
    schedule: (moduleId, scheduling) => {
      scheduled.push({ moduleId, force: scheduling?.force === true });
    },
    dispose: () => {},
  };
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

function save(input: { id?: string; name?: string; code?: string; manifest?: ModuleManifest }): string {
  const saved = saveModuleCommand(handle.db, {
    ...(input.id === undefined ? {} : { id: input.id }),
    slug: "tag-release",
    name: input.name ?? "Tag release",
    description: "Tags the release.",
    code: input.code ?? code("v1"),
    manifest: input.manifest ?? manifest,
    originalScript: null,
  });
  if (saved.module === null) throw new Error(saved.problem ?? "not saved");
  return saved.module.id;
}

function addCase(moduleId: string, description: string): string {
  return saveModuleTestCommand(handle.db, runner, { moduleId, description, source: `// ${description}` }).test!.id;
}

async function approve(id: string): Promise<void> {
  const answer = await approveModuleCommand(handle.db, runner, { id, acknowledgeLowCoverage: false });
  if (!answer.approved) throw new Error(answer.problem ?? "not approved");
}

describe("module versions over IPC", () => {
  it("lists versions newest first with number, time, approval, current and case count", async () => {
    const id = save({});
    addCase(id, "tags v1");
    await approve(id);
    save({ id, code: code("v2") });
    addCase(id, "tags v2");
    // A rename files nothing.
    save({ id, code: code("v2"), name: "Tag a release" });

    const listed = listModuleVersionsCommand(handle.db, { moduleId: id });
    expect(listed.problem).toBeNull();
    expect(listed.versions.map(({ number, approved, current, testCount }) => ({ number, approved, current, testCount }))).toEqual([
      { number: 2, approved: false, current: true, testCount: 2 },
      { number: 1, approved: true, current: false, testCount: 1 },
    ]);
    expect(listed.versions.every((version) => typeof version.createdAt === "number")).toBe(true);
    expect(ipcContract["moduleVersions:list"].response.safeParse(listed).success).toBe(true);

    expect(listModuleVersionsCommand(handle.db, { moduleId: "nope" })).toEqual({ versions: [], problem: "That module no longer exists." });
  });

  it("returns one version's code, manifest and cases, and says when there is no such version", () => {
    const id = save({});
    const first = addCase(id, "tags v1");
    save({ id, code: code("v2"), manifest: { ...manifest, results: ["tagged", "skipped"] } });
    deleteModuleTestCommand(handle.db, runner, { id: first });

    const v1 = getModuleVersionCommand(handle.db, { moduleId: id, number: 1 });
    expect(v1.problem).toBeNull();
    expect(v1.version).toMatchObject({ number: 1, code: code("v1"), manifest, current: false, tests: [{ id: first, description: "tags v1", source: "// tags v1" }] });
    expect(ipcContract["moduleVersions:get"].response.safeParse(v1).success).toBe(true);

    expect(getModuleVersionCommand(handle.db, { moduleId: id, number: 2 }).version).toMatchObject({ current: true, tests: [] });
    expect(getModuleVersionCommand(handle.db, { moduleId: id, number: 7 })).toMatchObject({ version: null, problem: expect.stringContaining("no v7") });
  });

  it("marks the version current when the module is approved", async () => {
    const id = save({});
    addCase(id, "tags v1");
    save({ id, code: code("v2") });
    await approve(id);
    expect(listModuleVersionsCommand(handle.db, { moduleId: id }).versions.map((version) => [version.number, version.approved])).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  it("restores code, manifest and cases as a new version, re-approving only an approved code and manifest, and re-runs the tests", async () => {
    registerHandler("moduleVersions:restore", (payload) => restoreModuleVersionCommand(handle.db, runner, payload), opts);
    const id = save({});
    addCase(id, "tags v1");
    await approve(id);
    save({ id, code: code("v2"), manifest: { ...manifest, results: ["tagged", "skipped"] } });
    addCase(id, "tags v2");
    scheduled = [];

    const answer = await dispatchIpc("moduleVersions:restore", { moduleId: id, number: 1 });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.data).toMatchObject({ restored: true, version: 3, problem: null, module: { code: code("v1"), manifest, testCount: 1 } });
    expect(getModule(handle.db, id)?.approvedAt).not.toBeNull();
    // Forced: see the real-runner test below for why.
    expect(scheduled).toEqual([{ moduleId: id, force: true }]);
    expect(listModuleTests(handle.db, id).map((test) => test.description)).toEqual(["tags v1"]);
    // v2 kept what went with v2's code; v1 is as it was.
    expect(getModuleVersionCommand(handle.db, { moduleId: id, number: 2 }).version?.tests.map((test) => test.description)).toEqual(["tags v1", "tags v2"]);
    expect(getModuleVersionCommand(handle.db, { moduleId: id, number: 1 }).version).toMatchObject({ approved: true, current: false, code: code("v1") });

    // v2 was never approved, so restoring it is unapproved like any edit.
    const back = await dispatchIpc("moduleVersions:restore", { moduleId: id, number: 2 });
    expect(back.ok && back.data).toMatchObject({ restored: true, version: 4, module: { approvedAt: null, testCount: 2 } });
    expect(listModuleVersionsCommand(handle.db, { moduleId: id }).versions.map((version) => [version.number, version.approved, version.current])).toEqual([
      [4, false, true],
      [3, true, false],
      [2, false, false],
      [1, true, false],
    ]);

    // Refusals change nothing and run nothing.
    scheduled = [];
    expect(restoreModuleVersionCommand(handle.db, runner, { moduleId: id, number: 4 })).toMatchObject({ restored: false, module: null, version: null });
    expect(restoreModuleVersionCommand(handle.db, runner, { moduleId: id, number: 9 })).toMatchObject({ restored: false, problem: expect.stringContaining("no v9") });
    expect(scheduled).toEqual([]);
  });

  it("keeps only as many versions as the setting says, after five code saves at three", () => {
    setModuleVersionsToKeep(handle.db, 3);
    const id = save({});
    for (const tag of ["v2", "v3", "v4", "v5"]) save({ id, code: code(tag) });
    expect(listModuleVersionsCommand(handle.db, { moduleId: id }).versions.map((version) => [version.number, version.current])).toEqual([
      [5, true],
      [4, false],
      [3, false],
    ]);
    save({ id, code: code("v6") });
    expect(listModuleVersionsCommand(handle.db, { moduleId: id }).versions.map((version) => version.number)).toEqual([6, 5, 4]);
  });

  it("is refused while the organisation manages the pipelines section, like any module save", () => {
    expect(SECTION_LOCKED_CHANNELS.pipelines).toContain("moduleVersions:restore");
  });
});

describe("module versions through eo_admin", () => {
  const dispatch: Dispatch = (channel: IpcChannel, payload: unknown) => dispatchIpc(channel, payload);
  const tool = (name: string) => {
    const found = TOOLS.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  };

  beforeEach(() => {
    registerHandler("moduleVersions:list", (payload) => listModuleVersionsCommand(handle.db, payload), opts);
    registerHandler("moduleVersions:get", (payload) => getModuleVersionCommand(handle.db, payload), opts);
    registerHandler("moduleVersions:restore", (payload) => restoreModuleVersionCommand(handle.db, runner, payload), opts);
  });

  it("lists, reads and restores, and says whether the restore came back approved", async () => {
    const id = save({});
    addCase(id, "tags v1");
    save({ id, code: code("v2") });

    const listed = await tool("module_versions_list").run(dispatch, { moduleId: id });
    expect(listed).toMatchObject({ ok: true, refused: false });
    expect(listed.ok && listed.text).toContain("v2");
    expect(listed.ok && listed.text).toContain("(current)");

    const read = await tool("module_version_get").run(dispatch, { moduleId: id, number: 1 });
    expect(read).toMatchObject({ ok: true, refused: false });
    expect(read.ok && read.text).toContain('ctx.exec("git", ["tag", "v1"])');
    expect(read.ok && read.text).toContain("tags v1");

    const restored = await tool("module_version_restore").run(dispatch, { moduleId: id, number: 1 });
    expect(restored).toMatchObject({ ok: true, refused: false });
    expect(restored.ok && restored.text).toContain("Restored");
    expect(restored.ok && restored.text).toContain("not approved");

    const refused = await tool("module_version_restore").run(dispatch, { moduleId: id, number: 3 });
    expect(refused).toMatchObject({ ok: true, refused: true });
    expect(refused.ok && refused.text).toContain("Nothing was restored");
    expect(tool("module_version_restore").kind).toBe("dangerous");
  });

  it("no longer shows the current version as approved once a change to its test cases withdrew the approval (EO-498)", async () => {
    const id = save({});
    const first = addCase(id, "tags v1");
    await approve(id);
    const before = await tool("module_versions_list").run(dispatch, { moduleId: id });
    expect(before.ok && before.text).toContain("— approved, 1 test case(s) (current)");

    expect(saveModuleTestCommand(handle.db, runner, { id: first, moduleId: id, description: "tags v1", source: "// changed" })).toMatchObject({ approvalWithdrawn: true });

    const listed = await tool("module_versions_list").run(dispatch, { moduleId: id });
    expect(listed.ok && listed.text).toContain("— not approved, 1 test case(s) (current)");
    expect(listModuleVersionsCommand(handle.db, { moduleId: id }).versions).toEqual([expect.objectContaining({ number: 1, current: true, approved: false })]);
  });
});

describe("a restore's tests, on the real runner", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const launcher = { execPath: process.execPath, hostPath: join(here, "..", "modules", "moduleHost.mjs"), hostEnv: { ELECTRON_RUN_AS_NODE: "1" } };
  const TAGS_V1 = `import assert from "node:assert/strict";
export default async function (harness) {
  const run = await harness.run({ exec: [{ bin: "git", args: ["tag", "v1"] }] });
  assert.equal(run.outcome.ok, true);
}`;

  let real: ModuleTestRunner;
  let stored: number;
  let waiters: Array<() => void>;

  /** Resolves once the runner has stored `count` more results. */
  function storedResults(count: number): Promise<void> {
    const target = stored + count;
    return new Promise((resolve) => {
      const check = (): void => {
        if (stored >= target) resolve();
        else waiters.push(check);
      };
      check();
    });
  }

  beforeEach(() => {
    stored = 0;
    waiters = [];
    real = createModuleTestRunner({
      db: handle.db,
      launcher,
      onStored: () => {
        stored += 1;
        for (const waiter of waiters.splice(0)) waiter();
      },
    });
    registerHandler("moduleVersions:restore", (payload) => restoreModuleVersionCommand(handle.db, real, payload), opts);
  });

  afterEach(() => {
    real.dispose();
  });

  it("runs them after a restore even when an older stored result already matches what came back", async () => {
    const id = save({});
    const written = saveModuleTest(handle.db, { moduleId: id, description: "tags v1", source: TAGS_V1 });
    if (!written.ok) throw new Error(written.reason);
    await real.run(id);
    const before = getModuleTestResult(handle.db, id)!;
    expect(stored).toBe(1);

    // v2 saved, and restored away from before its tests ever ran.
    save({ id, code: code("v2") });
    const rerun = storedResults(1);
    const answer = await dispatchIpc("moduleVersions:restore", { moduleId: id, number: 1 });
    expect(answer.ok && answer.data).toMatchObject({ restored: true, version: 3 });

    // The situation the run must not be skipped in: v1's stored result
    // is about exactly the code, manifest and cases that came back.
    const restored = getModule(handle.db, id)!;
    expect(getModuleTestResult(handle.db, id)?.fingerprint).toBe(moduleTestFingerprint(restored, listModuleTests(handle.db, id)));

    await rerun;
    const after = getModuleTestResult(handle.db, id)!;
    expect(stored).toBe(2);
    expect(after.run.ranAt).toBeGreaterThanOrEqual(before.run.ranAt);
    expect(after.run.cases).toMatchObject([{ description: "tags v1", passed: true }]);
  }, 30_000);
});
