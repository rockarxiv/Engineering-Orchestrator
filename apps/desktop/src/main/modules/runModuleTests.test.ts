import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ModuleManifest } from "@eo/core";
import type { ModuleHostLauncher } from "./runModule.js";
import { runModuleTests, type ModuleTestCaseInput } from "./runModuleTests.js";

/**
 * A module's tests, end to end (EO-352).
 *
 * A real host per case, as production runs them: every property the
 * story promises — nothing spawned, nothing posted, no secrets, no
 * network, no writes outside the case's directory, faked time — is a
 * property of the boundary, and a stubbed host would only assert the stub.
 */

const here = dirname(fileURLToPath(import.meta.url));
const launcher: ModuleHostLauncher = { execPath: process.execPath, hostPath: join(here, "moduleHost.mjs"), hostEnv: { ELECTRON_RUN_AS_NODE: "1" } };

function manifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    name: "Merge pull request",
    description: "Waits for CI, then merges.",
    inputs: {},
    needs: { bin: ["gh"], env: [], network: false, item: false, comment: true, attach: false, create: false },
    results: ["merged", "failed"],
    ...overrides,
  };
}

let counter = 0;
function testCase(source: string, description = "a case"): ModuleTestCaseInput {
  counter += 1;
  return { id: `case-${counter}`, description, source };
}

/** A module shaped like Merge pull request: polls CI in a setTimeout loop, then merges and says so. */
const MERGE_MODULE = `
export default async function (ctx) {
  const pr = ctx.inputs.pr;
  for (;;) {
    const checks = await ctx.exec("gh", ["pr", "checks", pr]);
    if (checks.code === 0) break;
    if (checks.code !== 8) return { ok: false, reason: "CI failed: " + checks.tail };
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
  const merged = await ctx.exec("gh", ["pr", "merge", pr, "--squash"]);
  if (merged.code !== 0) return { ok: false, reason: merged.stderr };
  ctx.comment("Merged #" + pr + ".");
  return { ok: true, result: "merged", detail: "" };
}
`;

const MERGE_INPUTS = { pr: { type: "string" as const, default: "12" } };

describe("runModuleTests", () => {
  it("reports every case as passed or failed, with line and branch coverage of the module alone", async () => {
    const run = await runModuleTests(launcher, {
      module: { code: MERGE_MODULE, manifest: manifest({ inputs: MERGE_INPUTS }) },
      tests: [
        testCase(
          `import assert from "node:assert/strict";
           export default async function (harness) {
             const run = await harness.run({ exec: [
               { bin: "gh", args: ["pr", "checks", "12"], code: 0 },
               { bin: "gh", args: ["pr", "merge", "12", "--squash"], code: 0 },
             ] });
             assert.deepEqual(run.outcome, { ok: true, result: "merged", detail: "" });
           }`,
          "merges when CI is green",
        ),
        testCase(
          `import assert from "node:assert/strict";
           export default async function (harness) {
             const run = await harness.run({ exec: [{ bin: "gh", args: ["pr", "checks", "12"], code: 1, stdout: "lint failed" }] });
             assert.equal(run.outcome.ok, true, "expected the module to succeed");
           }`,
          "a deliberately wrong expectation",
        ),
      ],
    });

    expect(run.cases.map((each) => [each.description, each.passed])).toEqual([
      ["merges when CI is green", true],
      ["a deliberately wrong expectation", false],
    ]);
    expect(run.cases[0]!.failure).toBeNull();
    expect(run.cases[1]!.failure).toContain("expected the module to succeed");
    // Between them the two cases reach every line but the merge's own
    // failure and the polling wait — so neither none nor all of it.
    expect(run.coverage.lines.total).toBeGreaterThan(0);
    expect(run.coverage.lines.percent).toBeGreaterThan(50);
    expect(run.coverage.lines.percent).toBeLessThan(100);
    expect(run.coverage.branches.total).toBeGreaterThan(0);
    expect(run.coverage.branches.percent).toBeLessThan(100);
  });

  it("measures the module's code only: a case's own branches do not count", async () => {
    const module = `export default async function () { return { ok: true, result: "merged" }; }`;
    const run = await runModuleTests(launcher, {
      module: { code: module, manifest: manifest() },
      tests: [
        testCase(`export default async function (harness) {
          const run = await harness.run();
          if (run.outcome.ok) { /* taken */ } else { throw new Error("never"); }
          function unused() { return 1; }
        }`),
      ],
    });
    expect(run.cases[0]!.passed).toBe(true);
    expect(run.coverage.lines).toEqual({ covered: 1, total: 1, percent: 100 });
    expect(run.coverage.branches.percent).toBe(100);
  });

  it("reports no cases as an empty run with nothing covered", async () => {
    const run = await runModuleTests(launcher, { module: { code: MERGE_MODULE, manifest: manifest() }, tests: [] });
    expect(run.cases).toEqual([]);
    expect(run.coverage.lines.percent).toBe(0);
    expect(run.coverage.branches.percent).toBe(0);
  });

  it("runs a module that polls in a setTimeout loop in under a second of wall-clock time", async () => {
    // Twenty polls thirty seconds apart: ten minutes of the module's time.
    const pending = Array.from({ length: 20 }, () => ({ bin: "gh", args: ["pr", "checks", "12"], code: 8, stdout: "pending" }));
    const started = Date.now();
    const run = await runModuleTests(launcher, {
      module: { code: MERGE_MODULE, manifest: manifest({ inputs: MERGE_INPUTS }) },
      tests: [
        testCase(`import assert from "node:assert/strict";
          export default async function (harness) {
            const before = Date.now();
            const run = await harness.run({ timeoutMs: 3_600_000, exec: [
              ...${JSON.stringify(pending)},
              { bin: "gh", args: ["pr", "checks", "12"], code: 0 },
              { bin: "gh", args: ["pr", "merge", "12", "--squash"], code: 0 },
            ] });
            assert.equal(run.outcome.ok, true, run.outcome.reason);
            assert.equal(run.execs.length, 22);
            assert.equal(Date.now() - before, 20 * 30_000, "the module's own clock moved by every wait");
          }`),
      ],
    });
    expect(run.cases[0]).toMatchObject({ passed: true, failure: null });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("fakes node:timers/promises and Date for the module as well", async () => {
    const module = `
      import { setTimeout as sleep } from "node:timers/promises";
      export default async function (ctx) {
        const start = Date.now();
        await sleep(5 * 60_000);
        return { ok: true, result: "merged", detail: String(Date.now() - start) };
      }`;
    const run = await runModuleTests(launcher, {
      module: { code: module, manifest: manifest() },
      tests: [
        testCase(`import assert from "node:assert/strict";
          export default async function (harness) {
            const run = await harness.run();
            assert.deepEqual(run.outcome, { ok: true, result: "merged", detail: "300000" });
          }`),
      ],
    });
    expect(run.cases[0]).toMatchObject({ passed: true });
  });

  it("fails a case whose module runs something unscripted, naming the binary and its arguments, even when the module catches it", async () => {
    const module = `
      export default async function (ctx) {
        try { await ctx.exec("gh", ["pr", "merge", "12", "--admin"]); } catch {}
        return { ok: true, result: "merged" };
      }`;
    const run = await runModuleTests(launcher, {
      module: { code: module, manifest: manifest() },
      tests: [testCase(`export default async function (harness) { await harness.run(); }`)],
    });
    expect(run.cases[0]!.passed).toBe(false);
    expect(run.cases[0]!.failure).toContain(`ctx.exec("gh", ["pr","merge","12","--admin"]) was not scripted`);
  });

  it("fails a case whose module calls a binary it never declared, naming it and its arguments, even when the module catches the refusal", async () => {
    // The refusal a real run gives is still what the module sees; the
    // case fails as well, because nothing could have scripted the call.
    const module = `
      export default async function (ctx) {
        let refusal = "";
        try { await ctx.exec("curl", ["-X", "POST", "https://example.com/deploy"]); } catch (error) { refusal = error.message; }
        return { ok: true, result: "merged", detail: refusal };
      }`;
    const run = await runModuleTests(launcher, {
      module: { code: module, manifest: manifest() },
      tests: [
        testCase(`import assert from "node:assert/strict";
          export default async function (harness) {
            const run = await harness.run({ exec: [{ bin: "curl" }] });
            assert.match(run.outcome.detail, /did not declare "curl" in needs.bin/);
          }`),
      ],
    });
    expect(run.cases[0]!.passed).toBe(false);
    expect(run.cases[0]!.failure).toContain(`ctx.exec("curl", ["-X","POST","https://example.com/deploy"])`);
    expect(run.cases[0]!.failure).toContain("did not declare in needs.bin");
  });

  it("records ctx.comment and ctx.commentOn for the case's assertions, and posts nothing", async () => {
    const module = `
      export default async function (ctx) {
        ctx.comment("On this one.");
        ctx.commentOn("EO-2", "On the other one.");
        const refused = ctx.commentOn("EO-404", "Nowhere.");
        ctx.log(refused.reason);
        return { ok: true, result: "merged" };
      }`;
    const run = await runModuleTests(launcher, {
      module: { code: module, manifest: manifest() },
      tests: [
        testCase(`import assert from "node:assert/strict";
          export default async function (harness) {
            const run = await harness.run({ item: { key: "EO-1" }, itemByKey: { "EO-2": { title: "Other" } } });
            assert.deepEqual(run.comments, [
              { key: "EO-1", body: "On this one." },
              { key: "EO-2", body: "On the other one." },
            ]);
            assert.deepEqual(run.logs, ['No ticket has the key "EO-404".']);
          }`),
      ],
    });
    expect(run.cases[0]).toMatchObject({ passed: true, failure: null });
  });

  /**
   * `ctx.attach` in a test (EO-414): held to the rules a real run is
   * held to, against the case's own directory, and recorded rather than
   * done — there is no attachment store on this side and no thread.
   */
  it("records ctx.attach for a file the case wrote in harness.cwd, and copies and posts nothing", async () => {
    const module = `
      export default async function (ctx) {
        const one = await ctx.attach("report.txt", "Nightly report");
        const many = await ctx.attach(["report.txt", "logs/ci.log"]);
        return { ok: true, result: "merged", detail: JSON.stringify([one, many]) };
      }`;
    const run = await runModuleTests(launcher, {
      module: { code: module, manifest: manifest({ needs: { bin: [], env: [], network: false, item: false, comment: false, attach: true, create: false } }) },
      tests: [
        testCase(`import assert from "node:assert/strict";
          import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
          import { join } from "node:path";
          export default async function (harness) {
            writeFileSync(join(harness.cwd, "report.txt"), "all green");
            mkdirSync(join(harness.cwd, "logs"));
            writeFileSync(join(harness.cwd, "logs", "ci.log"), "ok");
            const run = await harness.run({ item: { key: "EO-1" } });
            assert.deepEqual(JSON.parse(run.outcome.detail), [{ attached: true }, { attached: true }]);
            assert.deepEqual(run.attachments, [
              { key: "EO-1", caption: "Nightly report", paths: ["report.txt"] },
              { key: "EO-1", caption: "", paths: ["report.txt", "logs/ci.log"] },
            ]);
            assert.deepEqual(run.comments, []);
            // Nothing was copied anywhere the case can see.
            assert.deepEqual(readdirSync(harness.cwd).sort(), ["logs", "report.txt"]);
          }`),
      ],
    });
    expect(run.cases[0]).toMatchObject({ passed: true, failure: null });
    expect(run.cases[0]!.output).not.toContain("did not attach");
  });

  /**
   * `ctx.createItem` in a test (EO-433): recorded, never created. A
   * case has no database, so what is held is what the host holds on a
   * real run — the need, the key, a repeat and the cap — and the
   * parent's answer is the case's own script.
   */
  const CREATES = { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: true };

  it("records ctx.createItem, answering NEW-1, NEW-2 and so on, and writes nothing", async () => {
    const module = `
      export default async function (ctx) {
        const one = await ctx.createItem({ idempotencyKey: "a", type: "story", title: "First", body: "Why.", spec: { acceptance_criteria: ["x"] }, pipeline: "Delivery", parent: "EO-9", repository: "web", existingBranch: "dependabot/npm_and_yarn/foo-1.2.3" });
        const two = await ctx.createItem({ idempotencyKey: "b", type: "bug", title: "Second" });
        const again = await ctx.createItem({ idempotencyKey: "a", type: "story", title: "First, again" });
        return { ok: true, result: "merged", detail: JSON.stringify([one, two, again]) };
      }`;
    const run = await runModuleTests(launcher, {
      module: { code: module, manifest: manifest({ needs: CREATES }) },
      tests: [
        testCase(`import assert from "node:assert/strict";
          export default async function (harness) {
            const run = await harness.run({});
            assert.deepEqual(JSON.parse(run.outcome.detail), [
              { created: true, key: "NEW-1", existing: false },
              { created: true, key: "NEW-2", existing: false },
              { created: true, key: "NEW-1", existing: true },
            ]);
            assert.deepEqual(run.created, [
              { idempotencyKey: "a", key: "NEW-1", type: "story", title: "First", body: "Why.", spec: { acceptance_criteria: ["x"] }, pipeline: "Delivery", parent: "EO-9", repository: "web", existingBranch: "dependabot/npm_and_yarn/foo-1.2.3", wait: "none", dependsOn: [] },
              { idempotencyKey: "b", key: "NEW-2", type: "bug", title: "Second", body: "", spec: {}, pipeline: null, parent: null, repository: null, existingBranch: null, wait: "none", dependsOn: [] },
            ]);
            assert.deepEqual(run.comments, []);
          }`),
      ],
    });
    expect(run.cases[0]).toMatchObject({ passed: true, failure: null });
    expect(run.cases[0]!.output).not.toContain("did not create");
  });

  /**
   * Waiting in a test (EO-434): recorded as asked, and nothing is held.
   * What a case can check without a database is that the keys named are
   * ones it knows, and that `wait` is one of the three.
   */
  it("records wait and dependsOn, and refuses an unknown key and an unknown wait as a real run does", async () => {
    const module = `
      export default async function (ctx) {
        const answers = [
          await ctx.createItem({ idempotencyKey: "a", type: "story", title: "Held behind", wait: "this_waits", dependsOn: ["EO-40", "EO-40"] }),
          await ctx.createItem({ idempotencyKey: "b", type: "story", title: "Waits for this", wait: "created_waits", dependsOn: ["EO-1"] }),
          await ctx.createItem({ idempotencyKey: "c", type: "story", title: "Unknown key", dependsOn: ["EO-40", "EO-99"] }),
          await ctx.createItem({ idempotencyKey: "d", type: "story", title: "Unknown wait", wait: "both" }),
          await ctx.createItem({ idempotencyKey: "e", type: "story", title: "Not a list", dependsOn: "EO-40" }),
          await ctx.createItem({ idempotencyKey: "f", type: "story", title: "A loop", wait: "this_waits", dependsOn: ["EO-1"] }),
          await ctx.createItem({ idempotencyKey: "g", type: "story", title: "Null wait", wait: null }),
        ];
        return { ok: true, result: "merged", detail: JSON.stringify(answers) };
      }`;
    const run = await runModuleTests(launcher, {
      module: { code: module, manifest: manifest({ needs: CREATES }) },
      tests: [
        testCase(`import assert from "node:assert/strict";
          export default async function (harness) {
            // One scripted answer, and the refusals must not spend it.
            const run = await harness.run({ item: { key: "EO-1" }, itemByKey: { "EO-40": { title: "The API" } }, createItem: [{ key: "EO-41" }] });
            const answers = JSON.parse(run.outcome.detail);
            // Named by the key that nothing in the case has.
            assert.equal(answers[2].created, false);
            assert.match(answers[2].reason, /EO-99 for this to depend on/);
            assert.deepEqual([...answers.slice(0, 2), ...answers.slice(3)], [
              { created: true, key: "EO-41", existing: false },
              { created: true, key: "NEW-1", existing: false },
              { created: false, reason: 'wait is one of "none", "this_waits", "created_waits".' },
              { created: false, reason: 'dependsOn is a list of item keys, like ["EO-40"].' },
              { created: false, reason: "EO-1 cannot wait for the new item — that would make the dependencies circular: EO-1 → the new item → EO-1." },
              // Only leaving it out is the default; null is a value, and not one of the three.
              { created: false, reason: 'wait is one of "none", "this_waits", "created_waits".' },
            ]);
            assert.deepEqual(run.created.map((made) => [made.key, made.wait, made.dependsOn]), [
              ["EO-41", "this_waits", ["EO-40"]],
              ["NEW-1", "created_waits", ["EO-1"]],
            ]);
          }`),
      ],
    });
    expect(run.cases[0]).toMatchObject({ passed: true, failure: null });
    expect(run.cases[0]!.output).toMatch(/EO did not create an item: .*EO-99 for this to depend on/);
  });

  it("hands the module the answers a case scripts, in order, a refusal included", async () => {
    const module = `
      export default async function (ctx) {
        const answers = [];
        for (const key of ["a", "b", "c"]) answers.push(await ctx.createItem({ idempotencyKey: key, type: "story", title: key }));
        return { ok: true, result: "merged", detail: JSON.stringify(answers) };
      }`;
    const run = await runModuleTests(launcher, {
      module: { code: module, manifest: manifest({ needs: CREATES }) },
      tests: [
        testCase(`import assert from "node:assert/strict";
          export default async function (harness) {
            const run = await harness.run({ createItem: [{ key: "EO-41" }, { reason: "A story needs acceptance criteria." }] });
            assert.deepEqual(JSON.parse(run.outcome.detail), [
              { created: true, key: "EO-41", existing: false },
              { created: false, reason: "A story needs acceptance criteria." },
              { created: true, key: "NEW-1", existing: false },
            ]);
            assert.deepEqual(run.created.map((made) => [made.idempotencyKey, made.key]), [["a", "EO-41"], ["c", "NEW-1"]]);
          }`),
        testCase(`import assert from "node:assert/strict";
          export default async function (harness) {
            await assert.rejects(() => harness.run({ createItem: [{ key: "EO-1", reason: "both" }] }), /createItem is a list of answers/);
            await assert.rejects(() => harness.run({ createItem: { key: "EO-1" } }), /createItem is a list of answers/);
          }`),
      ],
    });
    expect(run.cases.map((one) => one.failure)).toEqual([null, null]);
    expect(run.cases[0]!.output).toContain("EO did not create an item: A story needs acceptance criteria.");
  });

  it("refuses in a test what the host refuses on a real run: the need, the key and the eleventh", async () => {
    const eleven = `
      export default async function (ctx) {
        const answers = [await ctx.createItem({ type: "story", title: "No key" })];
        for (let index = 0; index < 11; index += 1) answers.push(await ctx.createItem({ idempotencyKey: "k" + index, type: "story", title: "t" }));
        return { ok: true, result: "merged", detail: JSON.stringify(answers.map((answer) => answer.reason ?? answer.key)) };
      }`;
    const capped = await runModuleTests(launcher, {
      module: { code: eleven, manifest: manifest({ needs: CREATES }) },
      tests: [
        testCase(`import assert from "node:assert/strict";
          export default async function (harness) {
            const run = await harness.run({});
            const said = JSON.parse(run.outcome.detail);
            assert.match(said[0], /idempotencyKey/);
            assert.deepEqual(said.slice(1, 11), ["NEW-1", "NEW-2", "NEW-3", "NEW-4", "NEW-5", "NEW-6", "NEW-7", "NEW-8", "NEW-9", "NEW-10"]);
            assert.match(said[11], /may create 10 items in one run/);
            assert.equal(run.created.length, 10);
          }`),
      ],
    });
    expect(capped.cases[0]).toMatchObject({ passed: true, failure: null });
    expect(capped.cases[0]!.output).toContain("EO did not create an item");

    const undeclared = await runModuleTests(launcher, {
      module: {
        code: `export default async function (ctx) {
          return { ok: true, result: "merged", detail: JSON.stringify(await ctx.createItem({ idempotencyKey: "a", type: "story", title: "t" })) };
        }`,
        manifest: manifest(),
      },
      tests: [
        testCase(`import assert from "node:assert/strict";
          export default async function (harness) {
            const run = await harness.run({});
            const answer = JSON.parse(run.outcome.detail);
            assert.equal(answer.created, false);
            assert.match(answer.reason, /needs\\.create/);
            assert.deepEqual(run.created, []);
          }`),
      ],
    });
    expect(undeclared.cases[0]).toMatchObject({ passed: true, failure: null });
  });

  it("refuses in a test what a real run refuses, and records none of it", async () => {
    const module = `
      import { symlinkSync } from "node:fs";
      import { join } from "node:path";
      export default async function (ctx) {
        symlinkSync(join(ctx.cwd, "real.txt"), join(ctx.cwd, "link.txt"));
        const answers = [];
        for (const call of [
          ["missing.txt"],
          ["sub"],
          ["link.txt"],
          ["../outside.txt"],
          [["real.txt", "real.txt", "real.txt", "real.txt", "real.txt", "real.txt", "real.txt", "real.txt", "real.txt"]],
          ["real.txt", "x".repeat(4001)],
        ]) answers.push(await ctx.attach(...call));
        for (let index = 0; index < 10; index += 1) ctx.comment("note " + index);
        answers.push(await ctx.attach("real.txt"));
        return { ok: true, result: "merged", detail: JSON.stringify(answers.map((answer) => answer.reason ?? "attached")) };
      }`;
    const run = await runModuleTests(launcher, {
      module: { code: module, manifest: manifest() },
      tests: [
        testCase(`import assert from "node:assert/strict";
          import { mkdirSync, writeFileSync } from "node:fs";
          import { join } from "node:path";
          export default async function (harness) {
            writeFileSync(join(harness.cwd, "real.txt"), "real");
            mkdirSync(join(harness.cwd, "sub"));
            const run = await harness.run();
            const reasons = JSON.parse(run.outcome.detail);
            assert.match(reasons[0], /does not exist/);
            assert.match(reasons[1], /is a directory/);
            assert.match(reasons[2], /symbolic link/);
            assert.match(reasons[3], /outside the directory/);
            assert.match(reasons[4], /at most 8 files/);
            assert.match(reasons[5], /at most 4000 characters/);
            assert.match(reasons[6], /10 comments in one run/);
            assert.deepEqual(run.attachments, []);
            assert.equal(run.comments.length, 10);
          }`),
      ],
    });
    expect(run.cases[0]).toMatchObject({ passed: true, failure: null });
    // A refusal is in the case's transcript as it is in a run's.
    expect(run.cases[0]!.output).toContain("EO did not attach files:");
  });

  it("gives ctx.item, ctx.itemByKey, ctx.answer, ctx.inputs and ctx.timeoutMs the case's fixtures", async () => {
    const module = `
      export default async function (ctx) {
        return { ok: true, result: "merged", detail: JSON.stringify({
          item: ctx.item().item.title,
          other: ctx.itemByKey("EO-9").item.branch,
          answer: ctx.answer().matched,
          inputs: ctx.inputs,
          timeoutMs: ctx.timeoutMs,
          cwd: ctx.cwd === process.cwd(),
        }) };
      }`;
    const run = await runModuleTests(launcher, {
      module: { code: module, manifest: manifest({ inputs: { pr: { type: "string", default: "12" }, wait: { type: "number", default: 5 } } }) },
      tests: [
        testCase(`import assert from "node:assert/strict";
          export default async function (harness) {
            const run = await harness.run({
              item: { key: "EO-1", title: "Ship it" },
              itemByKey: { "EO-9": { branch: "eo/EO-9" } },
              answer: { text: "Yes.", offered: ["Yes", "No"], matched: "Yes" },
              inputs: { wait: 9 },
              timeoutMs: 120000,
            });
            assert.deepEqual(JSON.parse(run.outcome.detail), {
              item: "Ship it", other: "eo/EO-9", answer: "Yes", inputs: { pr: "12", wait: 9 }, timeoutMs: 120000, cwd: true,
            });
            const wrong = await harness.run({ inputs: { wait: "nine" } });
            assert.equal(wrong.outcome.ok, false);
            assert.match(wrong.outcome.reason, /"wait" expects a number/);
          }`),
      ],
    });
    expect(run.cases[0]).toMatchObject({ passed: true, failure: null });
  });

  /**
   * Every field EO-709 added, scripted in both fixtures and asserted on
   * in the case, and the shape a field left out takes: null, `false`,
   * `[]` or `{}`, never missing.
   */
  it("takes every field of the item in the item and itemByKey fixtures, and leaves out none", async () => {
    const module = `
      export default async function (ctx) {
        return { ok: true, result: "merged", detail: JSON.stringify({ item: ctx.item().item, other: ctx.itemByKey("EO-9").item, bare: ctx.itemByKey("EO-10").item }) };
      }`;
    const run = await runModuleTests(launcher, {
      module: { code: module, manifest: manifest() },
      tests: [
        testCase(`import assert from "node:assert/strict";
          const relation = { key: "EO-3", title: "Lay the groundwork", type: "story", stepName: "Review", finished: true };
          const full = {
            id: "0190-item", key: "EO-1", type: "story", title: "Ship it", body: "Body.", jiraKey: "KAN-1", createdAt: 1, updatedAt: 2,
            comments: [{ id: "c-1", body: "Hello." }],
            spec: { automerge: true, labels: ["a"] },
            fields: [{ name: "automerge", kind: "boolean", required: false }],
            priority: 3, heldAt: 4, archivedAt: 5, trial: true, createdBy: "Anna",
            pipeline: { id: "p-1", name: "Software" },
            step: { id: "merge", name: "Merge", kind: "module", ownerRole: "system" },
            pipelineVersion: { id: "v-1", number: 2 },
            git: { branch: "eo/EO-1", baseBranch: "release/2.4", namedBranch: true, attachedAt: "abc123", pullRequest: "https://forge.example/pull/1", reference: "JIRA-9", targetBranch: "release/2.4" },
            extensions: { jira: { key: "KAN-1" } },
            parent: { key: "EO-0", title: "The feature", type: "feature", stepName: "1 of 2 done", finished: false },
            children: [relation], dependsOn: [relation], dependedOnBy: [relation],
            attachments: [{ id: "a-1", name: "log.txt", mimeType: "text/plain", size: 12, commentId: "c-1", createdAt: 6 }],
          };
          export default async function (harness) {
            const run = await harness.run({ item: full, itemByKey: { "EO-9": { ...full, key: "EO-9" }, "EO-10": {} } });
            const { item, other, bare } = JSON.parse(run.outcome.detail);
            for (const read of [item, other]) {
              assert.equal(read.id, "0190-item");
              assert.equal(read.spec.automerge, true);
              assert.deepEqual(read.fields, [{ name: "automerge", kind: "boolean", required: false }]);
              assert.equal(read.priority, 3);
              assert.equal(read.heldAt, 4);
              assert.equal(read.archivedAt, 5);
              assert.equal(read.trial, true);
              assert.equal(read.createdBy, "Anna");
              assert.deepEqual(read.pipeline, { id: "p-1", name: "Software" });
              assert.deepEqual(read.step, { id: "merge", name: "Merge", kind: "module", ownerRole: "system" });
              assert.deepEqual(read.pipelineVersion, { id: "v-1", number: 2 });
              assert.deepEqual(read.git, full.git);
              assert.equal(read.branch, "eo/EO-1");
              assert.equal(read.prUrl, "https://forge.example/pull/1");
              assert.equal(read.parentKey, "EO-0");
              assert.deepEqual(read.extensions, { jira: { key: "KAN-1" } });
              assert.deepEqual(read.parent, full.parent);
              assert.deepEqual([read.children, read.dependsOn, read.dependedOnBy], [[relation], [relation], [relation]]);
              assert.deepEqual(read.attachments, full.attachments);
            }
            assert.equal(other.key, "EO-9");
            assert.deepEqual(bare, {
              id: null, key: "EO-10", type: null, title: null, body: null, parentKey: null, branch: null, prUrl: null, jiraKey: null,
              createdAt: null, updatedAt: null, comments: [], spec: {}, fields: [], priority: null, heldAt: null, archivedAt: null,
              trial: false, createdBy: null, pipeline: null, step: null, pipelineVersion: null,
              git: { branch: null, baseBranch: null, namedBranch: false, attachedAt: null, pullRequest: null, reference: null, targetBranch: null },
              extensions: {}, parent: null, children: [], dependsOn: [], dependedOnBy: [], attachments: [],
            });
          }`),
      ],
    });
    expect(run.cases[0]).toMatchObject({ passed: true, failure: null });
  });

  it("runs a case with no secrets in its environment, in a fresh directory that is removed afterwards", async () => {
    const previous = process.env.EO_TEST_SECRET;
    process.env.EO_TEST_SECRET = "hunter2";
    try {
      const run = await runModuleTests(launcher, {
        module: { code: `export default async function () { return { ok: true, result: "merged", detail: JSON.stringify(process.env) }; }`, manifest: manifest() },
        tests: [
          testCase(`import assert from "node:assert/strict";
            import { writeFileSync, existsSync } from "node:fs";
            import { join } from "node:path";
            export default async function (harness) {
              assert.equal(process.cwd(), harness.cwd);
              writeFileSync(join(harness.cwd, "scratch.txt"), "inside is fine");
              assert.ok(existsSync(join(harness.cwd, "scratch.txt")));
              const run = await harness.run();
              assert.deepEqual(JSON.parse(run.outcome.detail), {});
              console.log("CWD=" + harness.cwd);
            }`),
        ],
      });
      expect(run.cases[0]).toMatchObject({ passed: true, failure: null });
      const cwd = /CWD=(.*)/.exec(run.cases[0]!.output)?.[1];
      expect(cwd).toBeTruthy();
      expect(existsSync(cwd!)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.EO_TEST_SECRET;
      else process.env.EO_TEST_SECRET = previous;
    }
  });

  it("runs every case in a directory of its own", async () => {
    const source = `import assert from "node:assert/strict";
      import { existsSync, writeFileSync } from "node:fs";
      export default async function (harness) {
        assert.equal(existsSync("left-behind.txt"), false, "a previous case's file is visible");
        writeFileSync("left-behind.txt", "x");
      }`;
    const run = await runModuleTests(launcher, {
      module: { code: `export default async function () { return { ok: true, result: "merged" }; }`, manifest: manifest() },
      tests: [testCase(source), testCase(source)],
    });
    expect(run.cases.map((each) => each.passed)).toEqual([true, true]);
  });

  it.each([
    ["fetch", `await fetch("http://127.0.0.1:PORT/")`],
    ["node:http", `const { get } = await import("node:http"); await new Promise((resolve, reject) => get("http://127.0.0.1:PORT/", resolve).on("error", reject))`],
    ["node:https", `const https = await import("node:https"); await new Promise((resolve, reject) => https.request("https://127.0.0.1:PORT/", resolve).on("error", reject).end())`],
    ["node:net", `const net = await import("node:net"); await new Promise((resolve, reject) => net.connect(PORT, "127.0.0.1", resolve).on("error", reject))`],
    ["new net.Socket().connect", `const { Socket } = await import("node:net"); await new Promise((resolve, reject) => new Socket().connect(PORT, "127.0.0.1", resolve).on("error", reject))`],
  ])("fails a case whose module makes a direct network call through %s, even when it catches the error", async (_name, call) => {
    // A real listener, so a call that got through would succeed rather
    // than fail for some reason of its own.
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.end("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const module = `export default async function () {
        try { ${call.replaceAll("PORT", String(port))}; } catch {}
        return { ok: true, result: "merged" };
      }`;
      const run = await runModuleTests(launcher, {
        module: { code: module, manifest: manifest() },
        tests: [testCase(`export default async function (harness) { await harness.run(); }`)],
      });
      expect(run.cases[0]!.passed).toBe(false);
      expect(run.cases[0]!.failure).toMatch(/made a network call/);
      expect(connections).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it.each([
    ["writeFileSync", `const fs = await import("node:fs"); fs.writeFileSync(TARGET, "x")`],
    ["fs/promises writeFile", `const { writeFile } = await import("node:fs/promises"); await writeFile(TARGET, "x")`],
    ["createWriteStream", `const fs = await import("node:fs"); fs.createWriteStream(TARGET).end("x")`],
    ["openSync for writing", `const fs = await import("node:fs"); fs.closeSync(fs.openSync(TARGET, "w"))`],
  ])("fails a case that writes outside its directory with %s, even when it catches the error", async (_name, call) => {
    const target = join(here, `eo-352-escaped-${counter}.txt`);
    const module = `export default async function () {
      const TARGET = ${JSON.stringify(target)};
      try { ${call}; } catch {}
      return { ok: true, result: "merged" };
    }`;
    const run = await runModuleTests(launcher, {
      module: { code: module, manifest: manifest() },
      tests: [testCase(`export default async function (harness) { await harness.run(); }`)],
    });
    expect(run.cases[0]!.passed).toBe(false);
    expect(run.cases[0]!.failure).toMatch(/outside its temporary directory/);
    expect(existsSync(target)).toBe(false);
  });

  /**
   * Writes through a symbolic link the case made inside its own
   * directory, pointing out of it. The check is on where a write lands,
   * so every one of these is refused and the directory outside is left
   * exactly as it was.
   *
   * Not on Windows, where making a symbolic link needs a privilege a
   * test runner usually lacks.
   */
  describe.skipIf(process.platform === "win32")("writes through a symbolic link that leaves the case's directory", () => {
    let outside: string;

    /** `swallow` wraps the write in an empty catch, which is how a module that ignores a refusal looks. */
    const runThrough = async (arrange: string, write: string, swallow = true) => {
      const module = `export default async function () {
        const fs = await import("node:fs");
        const fsp = await import("node:fs/promises");
        ${swallow ? `try { ${write}; } catch {}` : write};
        return { ok: true, result: "merged" };
      }`;
      return runModuleTests(launcher, {
        module: { code: module, manifest: manifest() },
        tests: [
          testCase(`import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
            import { join } from "node:path";
            export default async function (harness) {
              const OUTSIDE = ${JSON.stringify(outside)};
              ${arrange};
              const run = await harness.run();
              if (!run.outcome.ok) throw new Error(run.outcome.reason);
            }`),
        ],
      });
    };

    const untouched = (): void => {
      expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("original");
      expect(existsSync(join(outside, "new.txt"))).toBe(false);
      expect(existsSync(join(outside, "missing"))).toBe(false);
    };

    it.each([
      ["a linked directory, overwriting a file there", `symlinkSync(OUTSIDE, join(harness.cwd, "escape"))`, `fs.writeFileSync("escape/victim.txt", "pwned")`],
      ["a linked directory, creating a file there", `symlinkSync(OUTSIDE, join(harness.cwd, "escape"))`, `fs.writeFileSync("escape/new.txt", "pwned")`],
      ["a linked directory, with fs/promises appendFile", `symlinkSync(OUTSIDE, join(harness.cwd, "escape"))`, `await fsp.appendFile("escape/victim.txt", "pwned")`],
      ["a linked directory, with createWriteStream", `symlinkSync(OUTSIDE, join(harness.cwd, "escape"))`, `fs.createWriteStream("escape/new.txt").end("pwned")`],
      ["a linked directory, opened for writing", `symlinkSync(OUTSIDE, join(harness.cwd, "escape"))`, `fs.closeSync(fs.openSync("escape/victim.txt", "w"))`],
      ["a link to the file itself", `symlinkSync(join(OUTSIDE, "victim.txt"), join(harness.cwd, "link.txt"))`, `fs.writeFileSync("link.txt", "pwned")`],
      ["a link to the parent, written relatively", `symlinkSync("..", join(harness.cwd, "up"))`, `fs.writeFileSync("up/eo-352-up-" + process.pid + ".txt", "pwned")`],
      ["a chain of two links", `symlinkSync(OUTSIDE, join(harness.cwd, "far")); symlinkSync("far", join(harness.cwd, "near"))`, `fs.writeFileSync("near/victim.txt", "pwned")`],
      ["a dangling link, made into a directory", `symlinkSync(join(OUTSIDE, "missing"), join(harness.cwd, "dangling"))`, `fs.mkdirSync("dangling/sub", { recursive: true })`],
      ["a hard link to a file outside", ``, `fs.linkSync(${JSON.stringify("OUTSIDE_VICTIM")}, "hard.txt"); fs.writeFileSync("hard.txt", "pwned")`],
      // A `..` after a link climbs from where the link *points*, not from
      // where it sits: folding `escape/..` away before following `escape`
      // checks the case's own directory and writes beside the link's
      // target. `child` is made inside OUTSIDE before the case runs.
      [
        "a link followed by .., written as an absolute path",
        `symlinkSync(join(OUTSIDE, "child"), join(harness.cwd, "escape"))`,
        `fs.writeFileSync(process.cwd() + "/escape/../victim.txt", "pwned")`,
      ],
      ["a link followed by .., written relatively", `symlinkSync(join(OUTSIDE, "child"), join(harness.cwd, "escape"))`, `fs.writeFileSync("escape/../victim.txt", "pwned")`],
      ["a link followed by .., with fs/promises appendFile", `symlinkSync(join(OUTSIDE, "child"), join(harness.cwd, "escape"))`, `await fsp.appendFile("escape/../new.txt", "pwned")`],
      // A recursive copy writes far more than the destination it is
      // handed: `dst` is inside, but `dst/sub` is a link out, so copying
      // `src/sub/victim.txt` lands on the outside victim.
      ...[
        ["cpSync", `fs.cpSync("src", "dst", { recursive: true, force: true })`],
        ["fs/promises cp", `await fsp.cp("src", "dst", { recursive: true, force: true })`],
        ["callback fs.cp", `await new Promise((resolve, reject) => fs.cp("src", "dst", { recursive: true, force: true }, (error) => (error ? reject(error) : resolve())))`],
      ].map(([name, call]): [string, string, string] => [
        `a recursive copy through a link below its destination, with ${name}`,
        `mkdirSync(join(harness.cwd, "src", "sub"), { recursive: true }); writeFileSync(join(harness.cwd, "src", "sub", "victim.txt"), "pwned"); mkdirSync(join(harness.cwd, "dst")); symlinkSync(OUTSIDE, join(harness.cwd, "dst", "sub"))`,
        call!,
      ]),
      [
        "a link whose own target climbs out through another link",
        `symlinkSync(join(OUTSIDE, "child"), join(harness.cwd, "escape")); symlinkSync("escape/..", join(harness.cwd, "up-from-escape"))`,
        `fs.writeFileSync("up-from-escape/victim.txt", "pwned")`,
      ],
    ])("refuses %s, fails the case and leaves the outside alone", async (_name, arrange, write) => {
      outside = mkdtempSync(join(tmpdir(), "eo-352-outside-"));
      try {
        writeFileSync(join(outside, "victim.txt"), "original");
        mkdirSync(join(outside, "child"));
        const run = await runThrough(arrange, write.replace("OUTSIDE_VICTIM", join(outside, "victim.txt")));
        expect(run.cases[0]!.passed).toBe(false);
        expect(run.cases[0]!.failure).toMatch(/outside its temporary directory/);
        untouched();
        // The `..` case lands in the OS's temporary directory, beside
        // every case's own.
        expect(readdirSync(tmpdir()).filter((name) => name.startsWith("eo-352-up-"))).toEqual([]);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("still allows a link that stays inside — with a .. after it too — and removing a link that points out", async () => {
      outside = mkdtempSync(join(tmpdir(), "eo-352-outside-"));
      try {
        writeFileSync(join(outside, "victim.txt"), "original");
        mkdirSync(join(outside, "keep"));
        const run = await runThrough(
          `symlinkSync(OUTSIDE, join(harness.cwd, "escape")); (await import("node:fs")).mkdirSync(join(harness.cwd, "inner-dir")); symlinkSync("inner-dir", join(harness.cwd, "inner"))`,
          // Not swallowed: a refusal of either would end the module in a
          // thrown error, and a write that did not land in the throw below.
          `fs.writeFileSync("inner/ok.txt", "fine"); fs.writeFileSync("inner/../beside.txt", "fine"); fs.unlinkSync("escape"); if (fs.readFileSync("inner-dir/ok.txt", "utf8") !== "fine" || fs.readFileSync("beside.txt", "utf8") !== "fine" || fs.existsSync("escape")) throw new Error("unexpected")`,
          false,
        );
        expect(run.cases[0]).toMatchObject({ passed: true, failure: null });
        untouched();
        expect(existsSync(join(outside, "keep"))).toBe(true);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it("stops a case that waits for ever at the module's time limit, and still runs the cases after it", async () => {
    const module = `export default async function () { for (;;) await new Promise((resolve) => setTimeout(resolve, 60_000)); }`;
    const run = await runModuleTests(launcher, {
      module: { code: module, manifest: manifest() },
      timeoutMs: 10 * 60_000,
      tests: [
        testCase(`export default async function (harness) { await harness.run(); }`, "polls for ever"),
        testCase(`export default async function (harness) { await new Promise(() => {}); }`, "awaits nothing"),
        testCase(`export default async function () {}`, "passes"),
      ],
    });
    expect(run.cases.map((each) => each.passed)).toEqual([false, false, true]);
    expect(run.cases[0]!.failure).toBe("This case did not finish within the module's time limit of 10 minutes, so EO stopped it.");
    expect(run.cases[1]!.failure).toContain("did not finish within the module's time limit of 10 minutes");
  });

  it("kills a case that never yields at the module's time limit in real time, and still runs the cases after it", async () => {
    const run = await runModuleTests(launcher, {
      module: { code: `export default async function () { for (;;) {} }`, manifest: manifest() },
      timeoutMs: 1500,
      tests: [testCase(`export default async function (harness) { await harness.run(); }`, "spins"), testCase(`export default async function () {}`, "passes")],
    });
    expect(run.cases.map((each) => each.passed)).toEqual([false, true]);
    expect(run.cases[0]!.failure).toBe("This case did not finish within the module's time limit of 1500ms, so EO stopped it.");
  }, 15_000);

  it("holds a case to the module's time limit even when a run asks for longer, and still runs the cases after it", async () => {
    // The fixture can shorten a run's limit but not lengthen the case's:
    // a run asking for a minute that then spins without yielding is
    // stopped at the module's 1.5 seconds, not after the minute.
    const started = Date.now();
    const run = await runModuleTests(launcher, {
      module: { code: `export default async function () { for (;;) {} }`, manifest: manifest() },
      timeoutMs: 1500,
      tests: [
        testCase(`export default async function (harness) { await harness.run({ timeoutMs: 60_000 }); }`, "asks for longer, then spins"),
        testCase(`export default async function () {}`, "passes"),
      ],
    });
    expect(run.cases.map((each) => each.passed)).toEqual([false, true]);
    expect(run.cases[0]!.failure).toBe("This case did not finish within the module's time limit of 1500ms, so EO stopped it.");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it("stops a spinning run at the shorter limit it asked for", async () => {
    const run = await runModuleTests(launcher, {
      module: { code: `export default async function () { for (;;) {} }`, manifest: manifest() },
      timeoutMs: 10 * 60_000,
      tests: [testCase(`export default async function (harness) { await harness.run({ timeoutMs: 1000 }); }`, "asks for less, then spins")],
    });
    expect(run.cases[0]!.failure).toBe("This case did not finish within the module's time limit of 1 second, so EO stopped it.");
  }, 20_000);

  it("allows a recursive copy that stays inside the case's directory", async () => {
    const module = `export default async function () {
      const fs = await import("node:fs");
      fs.mkdirSync("src/sub", { recursive: true });
      fs.writeFileSync("src/sub/file.txt", "copied");
      fs.cpSync("src", "dst", { recursive: true });
      await (await import("node:fs/promises")).cp("src", "dst2", { recursive: true });
      return { ok: true, result: "merged", detail: fs.readFileSync("dst/sub/file.txt", "utf8") + fs.readFileSync("dst2/sub/file.txt", "utf8") };
    }`;
    const run = await runModuleTests(launcher, {
      module: { code: module, manifest: manifest() },
      tests: [
        testCase(`import assert from "node:assert/strict";
          export default async function (harness) {
            const run = await harness.run();
            assert.deepEqual(run.outcome, { ok: true, result: "merged", detail: "copiedcopied" });
          }`),
      ],
    });
    expect(run.cases[0]).toMatchObject({ passed: true, failure: null });
  });

  it("holds a case to the import rule a module is held to", async () => {
    const run = await runModuleTests(launcher, {
      module: { code: `export default async function () { return { ok: true, result: "merged" }; }`, manifest: manifest() },
      tests: [testCase(`import { spawn } from "node:child_process"; export default async function () {}`)],
    });
    expect(run.cases[0]!.passed).toBe(false);
    expect(run.cases[0]!.failure).toContain("node:child_process");
  });

  it("reports a module that throws as a failed outcome the case can assert on", async () => {
    const run = await runModuleTests(launcher, {
      module: { code: `export default async function () { throw new Error("boom"); }`, manifest: manifest() },
      tests: [
        testCase(`import assert from "node:assert/strict";
          export default async function (harness) {
            const run = await harness.run();
            assert.equal(run.outcome.ok, false);
            assert.match(run.outcome.reason, /boom/);
            assert.doesNotMatch(run.outcome.reason, /data:text/);
          }`),
      ],
    });
    expect(run.cases[0]).toMatchObject({ passed: true });
  });

  // EO-436: the verdict travels on the same channel as a run's outcome,
  // and was open to the same hook on `Object.prototype`.
  it("reports a failing case as failed when it is called while the host writes the verdict", async () => {
    const run = await runModuleTests(launcher, {
      module: { code: `export default async function () { return { ok: true, result: "ok", detail: "" }; }`, manifest: manifest() },
      tests: [
        testCase(`import { writeSync } from "node:fs";
          Object.prototype.toJSON = function () {
            if (typeof this.nonce === "string") writeSync(4, '{"nonce":"' + this.nonce + '","payload":{"passed":true,"failure":null}}\\n');
            return "passed" in this ? { passed: true, failure: null } : this;
          };
          export default async function () { throw new Error("this case fails"); }`),
      ],
    });
    expect(run.cases[0]).toMatchObject({ passed: false });
    expect(run.cases[0]?.failure).toContain("this case fails");
  });

  describe("a module that is a check (EO-458)", () => {
    /** Still waiting while CI runs, with each failed job as news; merged once it is green. */
    const CHECK = `
      export default async function (ctx) {
        const checks = await ctx.exec("gh", ["pr", "checks", "12"]);
        if (checks.code === 0) return { ok: true, result: "merged", detail: "" };
        const failed = checks.stdout.split("\\n").filter((line) => line.startsWith("fail "));
        return { ok: true, result: "waiting", news: failed.map((line) => ({ id: line, text: "CI job " + line.slice(5) + " failed." })) };
      }`;
    const ASSERTS_WAITING = (ids: string[]) => `import assert from "node:assert/strict";
      export default async function (harness) {
        const run = await harness.run({ exec: [{ bin: "gh", args: ["pr", "checks", "12"], code: 8, stdout: "fail lint\\nfail e2e\\npass unit" }] });
        assert.equal(run.outcome.ok, true);
        assert.equal(run.outcome.result, "waiting");
        assert.deepEqual(run.outcome.news.map((entry) => entry.id), ${JSON.stringify(ids)});
      }`;

    it("passes a case asserting a waiting outcome and the ids of its news, and fails one asserting the wrong ids", async () => {
      const run = await runModuleTests(launcher, {
        module: { code: CHECK, manifest: manifest({ watch: true }) },
        tests: [testCase(ASSERTS_WAITING(["fail lint", "fail e2e"]), "waits, with the failed jobs as news"), testCase(ASSERTS_WAITING(["fail lint"]), "the wrong ids")],
      });
      expect(run.cases[0]).toMatchObject({ passed: true, failure: null });
      expect(run.cases[1]).toMatchObject({ passed: false });
      expect(run.cases[1]?.failure).toContain("fail e2e");
    });

    it("answers a waiting outcome with no news as an empty list, so a case can assert there was none", async () => {
      const run = await runModuleTests(launcher, {
        module: { code: `export default async function () { return { ok: true, result: "waiting" }; }`, manifest: manifest({ watch: true }) },
        tests: [
          testCase(`import assert from "node:assert/strict";
            export default async function (harness) {
              const run = await harness.run();
              assert.deepEqual(run.outcome, { ok: true, result: "waiting", detail: "", news: [] });
            }`),
        ],
      });
      expect(run.cases[0]).toMatchObject({ passed: true });
    });

    it("refuses waiting in a case exactly as a real run does when the manifest does not declare watch: true", async () => {
      const run = await runModuleTests(launcher, {
        module: { code: CHECK, manifest: manifest() },
        tests: [
          testCase(ASSERTS_WAITING(["fail lint", "fail e2e"]), "expects to wait"),
          testCase(`import assert from "node:assert/strict";
            export default async function (harness) {
              const run = await harness.run({ exec: [{ bin: "gh", code: 8 }] });
              assert.equal(run.outcome.ok, false);
              assert.match(run.outcome.reason, /does not declare \`watch: true\`/);
            }`, "sees the refusal"),
        ],
      });
      expect(run.cases[0]).toMatchObject({ passed: false });
      expect(run.cases[1]).toMatchObject({ passed: true });
    });
  });

  it("refuses a fixture it does not know, so a typo fails rather than being ignored", async () => {
    const run = await runModuleTests(launcher, {
      module: { code: `export default async function () { return { ok: true, result: "merged" }; }`, manifest: manifest() },
      tests: [testCase(`export default async function (harness) { await harness.run({ exce: [] }); }`)],
    });
    expect(run.cases[0]!.failure).toContain(`harness.run does not take "exce"`);
  });
});

/**
 * The same, on the runtime EO ships: Electron's binary under
 * ELECTRON_RUN_AS_NODE=1, whose Node is 22 where the tests above run on
 * whatever Node vitest has. The test mode leans on the inspector, on
 * `syncBuiltinESMExports` and on loader hooks, so it is run here rather
 * than assumed. Skipped where the binary cannot start — CI's unit job
 * installs the package without the libraries it links against — as
 * `runModule.test.ts` skips its own Electron block.
 */
const electronExport: unknown = createRequire(import.meta.url)("electron");
const electronBinary =
  typeof electronExport === "string" &&
  existsSync(electronExport) &&
  spawnSync(electronExport, ["-e", "process.exit(0)"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000, stdio: "ignore" }).status === 0
    ? electronExport
    : null;

describe.skipIf(electronBinary === null)("running a module's tests under ELECTRON_RUN_AS_NODE", () => {
  const onElectron: ModuleHostLauncher = { ...launcher, execPath: electronBinary ?? process.execPath };

  it("fakes time, refuses the unscripted and the network, and measures coverage", async () => {
    const pending = Array.from({ length: 5 }, () => ({ bin: "gh", args: ["pr", "checks", "12"], code: 8 }));
    const run = await runModuleTests(onElectron, {
      module: { code: MERGE_MODULE, manifest: manifest({ inputs: MERGE_INPUTS }) },
      tests: [
        testCase(`import assert from "node:assert/strict";
          export default async function (harness) {
            const run = await harness.run({ exec: [...${JSON.stringify(pending)}, { bin: "gh", args: ["pr", "checks", "12"] }, { bin: "gh", args: ["pr", "merge", "12", "--squash"] }] });
            assert.equal(run.outcome.ok, true);
            assert.deepEqual(run.comments, [{ key: "TEST-1", body: "Merged #12." }]);
          }`),
        testCase(`export default async function (harness) { await harness.run(); }`, "unscripted"),
        testCase(`export default async function () { await fetch("http://127.0.0.1:9/"); }`, "network"),
      ],
    });
    expect(run.cases.map((each) => each.passed)).toEqual([true, false, false]);
    expect(run.cases[1]!.failure).toContain('ctx.exec("gh", ["pr","checks","12"]) was not scripted');
    expect(run.cases[2]!.failure).toContain("made a network call");
    expect(run.coverage.lines.percent).toBeGreaterThan(50);
  });
});
