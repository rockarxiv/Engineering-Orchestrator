import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModuleManifest, ModuleSource, ModuleTestRun, Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import {
  archiveModule,
  createPipeline,
  createStep,
  getModule,
  listModuleTests,
  moduleTestFingerprint,
  saveModule,
  saveModuleTest,
  storeModuleTestResult,
} from "../db/repos/index.js";
import { createModuleTestRunner, type ModuleTestRunner } from "../modules/moduleTestRunner.js";
import { approveModuleCommand, archiveModuleCommand, listModuleViews, saveModuleCommand } from "./moduleCommands.js";

const manifest: ModuleManifest = {
  name: "Deploy",
  description: "Builds and deploys the current branch to staging.",
  inputs: {},
  needs: { bin: ["flyctl"], env: ["FLY_API_TOKEN"], network: true, item: false, comment: false, attach: false, create: false },
  results: ["deployed", "failed"],
};

const code = "export default async function run() { return { ok: true, result: 'deployed', detail: '' }; }";

describe("moduleCommands", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("saves a module and reports a slug collision rather than throwing", () => {
    const first = saveModuleCommand(handle.db, {
      slug: "deploy",
      name: "Deploy",
      description: "Deploys the branch.",
      code,
      manifest,
      originalScript: null,
      source: "user",
    });
    expect(first.saved).toBe(true);

    const clash = saveModuleCommand(handle.db, {
      slug: "deploy",
      name: "Deploy elsewhere",
      description: "Deploys somewhere else.",
      code,
      manifest,
      originalScript: null,
      source: "user",
    });
    // A duplicate slug is a thing a person typed, not a programmer error,
    // so it comes back as a problem the editor can show beside the field.
    expect(clash.saved).toBe(false);
    expect(clash.problem).toContain("deploy");
  });

  /**
   * Portability advice, read off the code on every list (EO-80).
   *
   * Derived rather than stored, and for a sharper reason than
   * `usedByStepCount`: a warning kept in a column would go stale the
   * moment somebody edited the module, and stale advice about
   * portability is worse than none.
   *
   * It is advice and nothing more. Saving is not refused, approving is
   * not blocked, and the run is the loader's to decide — this is the
   * view telling whoever is about to approve what the text looks like it
   * asks for.
   */
  it("tells the view what a module looks like it imports, without refusing the save", () => {
    const saved = saveModuleCommand(handle.db, {
      slug: "deploy",
      name: "Deploy",
      description: "Deploys the branch.",
      code: 'import fetch from "node-fetch";\nexport default async function run() { return { ok: true, result: "deployed" }; }',
      manifest,
      originalScript: null,
      source: "user",
    });
    expect(saved.saved).toBe(true);
    expect(saved.module?.portability).toEqual([{ specifier: "node-fetch", line: 1 }]);

    const [listed] = listModuleViews(handle.db, {}).modules;
    expect(listed?.portability).toEqual([{ specifier: "node-fetch", line: 1 }]);
  });

  // The advice follows the code rather than the row, so an edit that
  // fixes the import clears it without anything having to remember to.
  it("recomputes the advice from the code it is looking at", () => {
    const first = saveModuleCommand(handle.db, {
      slug: "deploy",
      name: "Deploy",
      description: "Deploys the branch.",
      code: 'import fetch from "node-fetch";\nexport default async function run() { return { ok: true, result: "deployed" }; }',
      manifest,
      originalScript: null,
      source: "user",
    });
    expect(first.module?.portability).toHaveLength(1);

    const fixed = saveModuleCommand(handle.db, {
      id: first.module!.id,
      slug: "deploy",
      name: "Deploy",
      description: "Deploys the branch.",
      code,
      manifest,
      originalScript: null,
      source: "user",
    });
    expect(fixed.module?.portability).toEqual([]);
  });

  /**
   * Machine-specific values (EO-449), read off the code, the manifest and
   * every test case on each read — and, like the import advice, refusing
   * nothing.
   */
  it("tells the view what in the code, manifest and test cases only holds on one machine, without refusing the save", () => {
    const saved = saveModuleCommand(handle.db, {
      slug: "deploy",
      name: "Deploy",
      description: "Deploys the branch.",
      code: 'export default async function run(ctx) {\n  await ctx.exec("flyctl", ["deploy", "/home/dev/app"]);\n  return { ok: true, result: "deployed" };\n}',
      manifest: { ...manifest, needs: { ...manifest.needs, bin: ["flyctl", "bash"] } },
      originalScript: null,
      source: "user",
      tests: [{ description: "deploys", source: 'export default async (harness) => {\n  await harness.run({ inputs: { url: "http://localhost:3000" }, exec: [{ bin: "flyctl", stderr: "C:\\\\fly" }] });\n};' }],
    });
    expect(saved.saved).toBe(true);
    const expected = [
      { where: { in: "code", line: 2 }, text: "/home/dev/app", kind: "machine_path" },
      { where: { in: "manifest", entry: 'needs.bin "bash"' }, text: "bash", kind: "shell_binary" },
      { where: { in: "test", description: "deploys", line: 2 }, text: "localhost:3000", kind: "loopback" },
    ];
    expect(saved.module?.machineSpecific.map(({ instead: _instead, ...rest }) => rest)).toEqual(expected);

    const [listed] = listModuleViews(handle.db, {}).modules;
    expect(listed?.machineSpecific.map(({ instead: _instead, ...rest }) => rest)).toEqual(expected);
  });

  it("counts the steps that run a module, across every pipeline", () => {
    const saved = saveModule(handle.db, { slug: "deploy", name: "Deploy", description: "Deploys.", code, manifest });
    if (!saved.ok) throw new Error(saved.reason);

    const one = createPipeline(handle.db, { name: "Ship" });
    const two = createPipeline(handle.db, { name: "Hotfix" });
    createStep(handle.db, { pipelineId: one.id, position: 0, name: "Deploy", type: "module", entryAction: saved.module.id });
    createStep(handle.db, { pipelineId: two.id, position: 0, name: "Deploy", type: "module", entryAction: saved.module.id });
    // A step of another kind whose action happens to collide must not count.
    createStep(handle.db, { pipelineId: two.id, position: 1, name: "Worktree", type: "builtin", entryAction: saved.module.id });

    const listed = listModuleViews(handle.db, {});
    expect(listed.modules).toHaveLength(1);
    expect(listed.modules[0]!.usedByStepCount).toBe(2);
  });

  it("refuses to archive a module a step still runs, and says how many", () => {
    const saved = saveModule(handle.db, { slug: "deploy", name: "Deploy", description: "Deploys.", code, manifest });
    if (!saved.ok) throw new Error(saved.reason);
    const pipeline = createPipeline(handle.db, { name: "Ship" });
    createStep(handle.db, { pipelineId: pipeline.id, position: 0, name: "Deploy", type: "module", entryAction: saved.module.id });

    const refused = archiveModuleCommand(handle.db, { id: saved.module.id });
    expect(refused).toEqual({ archived: false, usedByStepCount: 1 });
    // Still listed, because nothing was archived.
    expect(listModuleViews(handle.db, {}).modules).toHaveLength(1);
  });

  it("archives a module nothing runs", () => {
    const saved = saveModule(handle.db, { slug: "deploy", name: "Deploy", description: "Deploys.", code, manifest });
    if (!saved.ok) throw new Error(saved.reason);

    expect(archiveModuleCommand(handle.db, { id: saved.module.id }).archived).toBe(true);
    expect(listModuleViews(handle.db, {}).modules).toHaveLength(0);
    expect(listModuleViews(handle.db, { includeArchived: true }).modules).toHaveLength(1);
  });

  it("reports nothing archived for a module that does not exist", () => {
    expect(archiveModuleCommand(handle.db, { id: "019fb8c6-0000-7000-8000-000000000000" as Uuid })).toEqual({ archived: false, usedByStepCount: 0 });
  });
});

/**
 * Approving runs the module's tests, at that moment (EO-353).
 *
 * Against the real runner and the real host, because what is promised is
 * about the tests actually running when somebody clicks — a stored
 * result is a claim about code as it was, and approval is the moment
 * that claim would be relied on.
 */
describe("approving a module", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const launcher = { execPath: process.execPath, hostPath: join(here, "..", "modules", "moduleHost.mjs"), hostEnv: { ELECTRON_RUN_AS_NODE: "1" } };

  const tagManifest: ModuleManifest = {
    name: "Tag release",
    description: "Tags the release.",
    inputs: {},
    needs: { bin: ["git"], env: [], network: false, item: false, comment: false, attach: false, create: false },
    results: ["tagged"],
  };

  /** A failure path long enough that a case reaching only the success path leaves it well under the bar. */
  const TAGGING = `export default async function (ctx) {
  const tagged = await ctx.exec("git", ["tag", "v1"]);
  if (tagged.code !== 0) {
    const reason = tagged.stderr.trim();
    ctx.log("the tag failed");
    ctx.log(reason);
    const detail = "git tag said: " + reason;
    ctx.log(detail);
    ctx.log("giving up");
    return { ok: false, reason: detail };
  }
  return { ok: true, result: "tagged" };
}`;

  const TAGS_V1 = `import assert from "node:assert/strict";
export default async function (harness) {
  const run = await harness.run({ exec: [{ bin: "git", args: ["tag", "v1"] }] });
  assert.equal(run.outcome.ok, true);
}`;

  const REPORTS_A_FAILED_TAG = `import assert from "node:assert/strict";
export default async function (harness) {
  const run = await harness.run({ exec: [{ bin: "git", args: ["tag", "v1"], code: 128, stderr: "tag exists" }] });
  assert.equal(run.outcome.ok, false);
}`;

  const EXPECTS_THE_WRONG_THING = `import assert from "node:assert/strict";
export default async function (harness) {
  const run = await harness.run({ exec: [{ bin: "git", args: ["tag", "v1"] }] });
  assert.equal(run.outcome.ok, false, "expected the tag to fail");
}`;

  let handle: DbHandle;
  let runner: ModuleTestRunner;

  beforeEach(() => {
    handle = openMigratedTestDb();
    runner = createModuleTestRunner({ db: handle.db, launcher });
  });

  afterEach(() => {
    runner.dispose();
    handle.close();
  });

  function tagRelease(source: ModuleSource, cases: Record<string, string>): string {
    const saved = saveModule(handle.db, { slug: `tag-${source}`, name: "Tag release", description: "Tags the release.", code: TAGGING, manifest: tagManifest, source });
    if (!saved.ok) throw new Error(saved.reason);
    for (const [description, testSource] of Object.entries(cases)) {
      const test = saveModuleTest(handle.db, { moduleId: saved.module.id, description, source: testSource });
      if (!test.ok) throw new Error(test.reason);
    }
    return saved.module.id;
  }

  const approvedAt = (id: string) => getModule(handle.db, id)?.approvedAt ?? null;

  // Every module, whoever wrote it. The exemption a hand-written module
  // had under the dry run is gone.
  for (const source of ["user", "architect", "import"] as const) {
    describe(`written by ${source}`, () => {
      it("refuses a module with no tests, and says so", async () => {
        const id = tagRelease(source, {});

        const answer = await approveModuleCommand(handle.db, runner, { id, acknowledgeLowCoverage: false });

        expect(answer).toMatchObject({ approved: false, lineCoverage: null, coverageAcknowledgementNeeded: false });
        expect(answer.problem).toContain("has no tests");
        expect(approvedAt(id)).toBeNull();
      });

      it("refuses while any case fails, naming each failing case", async () => {
        const id = tagRelease(source, {
          "tags v1": TAGS_V1,
          "expects the wrong thing": EXPECTS_THE_WRONG_THING,
          "reports a failed tag": REPORTS_A_FAILED_TAG,
        });

        const answer = await approveModuleCommand(handle.db, runner, { id, acknowledgeLowCoverage: true });

        expect(answer.approved).toBe(false);
        expect(answer.coverageAcknowledgementNeeded).toBe(false);
        expect(answer.problem).toContain("1 of 3 test cases failed");
        expect(answer.problem).toContain("expects the wrong thing");
        expect(answer.problem).not.toContain("tags v1");
        expect(approvedAt(id)).toBeNull();
      });

      it("approves at once when every case passes and line coverage is at the bar or over", async () => {
        const id = tagRelease(source, { "tags v1": TAGS_V1, "reports a failed tag": REPORTS_A_FAILED_TAG });

        const answer = await approveModuleCommand(handle.db, runner, { id, acknowledgeLowCoverage: false });

        expect(answer).toMatchObject({ approved: true, problem: null, coverageAcknowledgementNeeded: false });
        expect(answer.lineCoverage).toBeGreaterThanOrEqual(80);
        expect(approvedAt(id)).not.toBeNull();
      });
    });
  }

  it("asks for the coverage figure to be acknowledged when every case passes under the bar, and approves once it is", async () => {
    const id = tagRelease("architect", { "tags v1": TAGS_V1 });

    const asked = await approveModuleCommand(handle.db, runner, { id, acknowledgeLowCoverage: false });
    expect(asked.approved).toBe(false);
    expect(asked.coverageAcknowledgementNeeded).toBe(true);
    expect(asked.lineCoverage).toBeLessThan(80);
    expect(asked.problem).toContain(`${asked.lineCoverage}%`);
    // Asking is not approving.
    expect(approvedAt(id)).toBeNull();

    const acknowledged = await approveModuleCommand(handle.db, runner, { id, acknowledgeLowCoverage: true });
    expect(acknowledged).toMatchObject({ approved: true, problem: null, lineCoverage: asked.lineCoverage });
    expect(approvedAt(id)).not.toBeNull();
  });

  it("runs the tests now rather than trusting a stored result", async () => {
    const id = tagRelease("user", { "expects the wrong thing": EXPECTS_THE_WRONG_THING });
    // A stored result that says everything passed, about exactly this
    // code and these cases. It is not what is true.
    const module = getModule(handle.db, id)!;
    const flattering: ModuleTestRun = {
      ranAt: 1,
      cases: [{ testId: "x", description: "expects the wrong thing", passed: true, failure: null, durationMs: 1, output: "" }],
      coverage: { lines: { covered: 10, total: 10, percent: 100 }, branches: { covered: 2, total: 2, percent: 100 } },
    };
    storeModuleTestResult(handle.db, id, moduleTestFingerprint(module, listModuleTests(handle.db, id)), flattering);

    const answer = await approveModuleCommand(handle.db, runner, { id, acknowledgeLowCoverage: true });

    expect(answer.approved).toBe(false);
    expect(answer.problem).toContain("expects the wrong thing");
  });

  it("refuses when the code changed while its tests ran", async () => {
    const id = tagRelease("user", { "tags v1": TAGS_V1 });
    const before = moduleTestFingerprint(getModule(handle.db, id)!, listModuleTests(handle.db, id));
    const passing: ModuleTestRun = {
      ranAt: 1,
      cases: [{ testId: "x", description: "tags v1", passed: true, failure: null, durationMs: 1, output: "" }],
      coverage: { lines: { covered: 10, total: 10, percent: 100 }, branches: { covered: 2, total: 2, percent: 100 } },
    };
    // A save landing mid-run: the run is about the code before it.
    const racing = {
      run: async () => {
        saveModule(handle.db, { id, slug: "tag-user", name: "Tag release", description: "Tags the release.", code: `${TAGGING}\n// edited`, manifest: tagManifest });
        return { run: passing, fingerprint: before, problem: null } as const;
      },
    };

    const answer = await approveModuleCommand(handle.db, racing, { id, acknowledgeLowCoverage: true });

    expect(answer.approved).toBe(false);
    expect(answer.problem).toContain("changed while its tests were running");
    expect(approvedAt(id)).toBeNull();
  });

  /**
   * The gap after the judgement (EO-581). Returning from the tests'
   * judgement to the approval is itself an asynchronous boundary, so a
   * save can land after the fingerprint was compared and before the
   * approval is written. Scheduled at several microtask depths, so one of
   * them lands in that gap whatever its exact depth is: none may leave
   * the edited code approved.
   */
  for (const depth of [1, 2, 3, 4, 5]) {
    it(`does not approve code saved after its tests were judged (a save ${depth} microtask${depth === 1 ? "" : "s"} after the run answers)`, async () => {
      const id = tagRelease("user", { "tags v1": TAGS_V1 });
      const before = moduleTestFingerprint(getModule(handle.db, id)!, listModuleTests(handle.db, id));
      const passing: ModuleTestRun = {
        ranAt: 1,
        cases: [{ testId: "x", description: "tags v1", passed: true, failure: null, durationMs: 1, output: "" }],
        coverage: { lines: { covered: 10, total: 10, percent: 100 }, branches: { covered: 2, total: 2, percent: 100 } },
      };
      const edit = () => {
        saveModule(handle.db, { id, slug: "tag-user", name: "Tag release", description: "Tags the release.", code: `${TAGGING}\n// edited`, manifest: tagManifest });
      };
      const later = (remaining: number, then: () => void): void => queueMicrotask(remaining <= 1 ? then : () => later(remaining - 1, then));
      const racing = {
        run: async () => {
          later(depth, edit);
          return { run: passing, fingerprint: before, problem: null } as const;
        },
      };

      const answer = await approveModuleCommand(handle.db, racing, { id, acknowledgeLowCoverage: true });
      // Let every scheduled save land, wherever it fell.
      await new Promise((settled) => setTimeout(settled, 0));

      expect(getModule(handle.db, id)!.code).toContain("// edited");
      expect(approvedAt(id)).toBeNull();
      if (!answer.approved) expect(answer.problem).toContain("changed while its tests were running");
    });
  }

  it("refuses a module that is gone or deleted without running anything", async () => {
    const id = tagRelease("user", { "tags v1": TAGS_V1 });
    archiveModule(handle.db, id);
    const never = { run: async () => { throw new Error("ran the tests of a deleted module"); } };

    expect(await approveModuleCommand(handle.db, never, { id, acknowledgeLowCoverage: false })).toMatchObject({ approved: false, problem: "That module has been deleted." });
    expect(await approveModuleCommand(handle.db, never, { id: "019fb8c6-0000-7000-8000-000000000000", acknowledgeLowCoverage: false })).toMatchObject({
      approved: false,
      problem: "That module no longer exists.",
    });
  });

  // Approving takes an id and nothing else, so it cannot change what it
  // is approving in the same call.
  it("does not touch the code it approves", async () => {
    const id = tagRelease("user", { "tags v1": TAGS_V1, "reports a failed tag": REPORTS_A_FAILED_TAG });

    await approveModuleCommand(handle.db, runner, { id, acknowledgeLowCoverage: false });
    expect(getModule(handle.db, id)?.code).toBe(TAGGING);
  });

  /**
   * Machine-specific values are advice (EO-449): a module holding them in
   * its code, its manifest and its test cases approves exactly as one
   * without, and the answer carries what they are.
   */
  it("approves a module with machine-specific values, and answers with them", async () => {
    const saved = saveModule(handle.db, {
      slug: "tag-local",
      name: "Tag release",
      description: "Tags the release.",
      code: TAGGING.replace('ctx.log("giving up");', 'ctx.log("see /tmp/eo-tag.log");'),
      manifest: { ...tagManifest, needs: { ...tagManifest.needs, bin: ["git", "bash"] } },
    });
    if (!saved.ok) throw new Error(saved.reason);
    for (const [description, source] of Object.entries({ "tags v1": TAGS_V1.replace("harness.run({", 'harness.run({ inputs: { home: "~/repo" }, '), "reports a failed tag": REPORTS_A_FAILED_TAG })) {
      const test = saveModuleTest(handle.db, { moduleId: saved.module.id, description, source });
      if (!test.ok) throw new Error(test.reason);
    }

    const answer = await approveModuleCommand(handle.db, runner, { id: saved.module.id, acknowledgeLowCoverage: false });

    expect(answer).toMatchObject({ approved: true, problem: null });
    expect(approvedAt(saved.module.id)).not.toBeNull();
    expect(answer.machineSpecific.map((warning) => [warning.where.in, warning.text])).toEqual([
      ["code", "/tmp/eo-tag.log"],
      ["manifest", "bash"],
      ["test", "~/repo"],
    ]);
  });

  it("says why when the tests could not run at all", async () => {
    const id = tagRelease("user", { "tags v1": TAGS_V1 });
    const hostless = createModuleTestRunner({ db: handle.db, launcher: null });

    const answer = await approveModuleCommand(handle.db, hostless, { id, acknowledgeLowCoverage: true });

    expect(answer.approved).toBe(false);
    expect(answer.problem).toContain("module host is not available");
    hostless.dispose();
  });
});
