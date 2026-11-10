import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModuleManifest, Item, Uuid } from "@eo/core";
import { openDb, type DbHandle } from "../db/client.js";
import { moduleItemReader } from "../modules/moduleItemRead.js";
import { runMigrations } from "../db/migrate.js";
import { createRoute, createStep, getItem, listCommentsForItem, listRunsForItem, saveModule } from "../db/repos/index.js";
import { createModuleRunnerLookup } from "../modules/registry.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { createRunSupervisor } from "./runSupervisor.js";

import { createTestItem } from "../db/testHelpers.js";
import { kindsPreparing } from "./testWorkspaceKinds.js";
/**
 * A module held to the step's own time limit, end to end (EO-162).
 *
 * The pieces are tested where they live — `modules/registry.test.ts` for
 * the number reaching `ctx.timeoutMs` and arming the timer,
 * `pipelineValidation.test.ts` and `ipc/config.test.ts` for the two
 * refusals. What only a test like this can catch is the last claim of the
 * story: a module that runs past its limit is still *stopped*, still
 * leaves nothing behind, and still ends in a comment somebody can read,
 * rather than a run that hangs onto the only slot in silence.
 *
 * The real supervisor, the real registry and a real `moduleHost.mjs`
 * subprocess, on disk for the reason `moduleQuestion.test.ts` is: the
 * host opens EO's database itself, and `:memory:` is private to the
 * handle that made it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, "..", "modules", "moduleHost.mjs");
const migrationsFolder = join(here, "..", "db", "migrations");

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${text}`),
  decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ""),
};

/**
 * Waits for CI, badly: it asks for a minute whatever it was told.
 *
 * A real timer rather than a promise that never settles — Node's loop
 * emptying is a clean exit and a different failure. It writes what it was
 * told first, so the transcript proves it saw the step's number and
 * ignored it rather than never having one.
 */
const overruns = `
export default async function run(ctx) {
  ctx.log("limit " + ctx.timeoutMs);
  await new Promise((resolve) => setTimeout(resolve, 60000));
  return { ok: true, result: "merged", detail: "" };
}`;

/** Finishes well inside a limit that a person raised for it. */
const finishes = `
export default async function run(ctx) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { ok: true, result: "merged", detail: "waited against " + ctx.timeoutMs };
}`;

const manifest: ModuleManifest = {
  name: "Merge",
  description: "Waits for CI and merges.",
  inputs: {},
  needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
  results: ["merged"],
};

let directory: string;
let handle: DbHandle;
let item: Item;

/** A `merge` step running `code`, with `timeoutMs` on it, and an item sitting there. */
function seed(code: string, timeoutMs: number | null) {
  const saved = saveModule(handle.db, { slug: "merge", name: "Merge", description: "Waits for CI and merges.", code, manifest, approve: true });
  if (!saved.ok) throw new Error(saved.reason);

  createStep(handle.db, {
    id: "merge_step",
    pipelineId: "default" as Uuid,
    position: 15,
    name: "Merge",
    type: "module",
    entryAction: saved.module.id,
    timeoutMs,
  });
  createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "merge_step", resultKey: "merged", label: "Merged", target: "review" });

  item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "merge_step" });

  return createRunSupervisor({
    db: handle.db,
    provider: { start: () => { throw new Error("a module must not reach a provider"); } } as never,
    ...createRoleWiring(handle.db),
    limits: LIMITS,
    moduleRunner: createModuleRunnerLookup({
      db: handle.db,
      launcher: { execPath: process.execPath, hostPath, hostEnv: { ELECTRON_RUN_AS_NODE: "1" }, items: moduleItemReader(handle.db) },
      secrets: { directory: join(directory, "secrets"), store },
    }),
    kinds: kindsPreparing(directory),
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eo module time limit "));
  handle = openDb(join(directory, "eo.db"));
  runMigrations(handle.db, migrationsFolder);
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("a module step held to its own time limit", () => {
  it("runs to the limit the step set, and tells the module what it is", async () => {
    // Raised well past what this module needs, so the assertion is that
    // the configured number is the one in force — not that a slow module
    // happened to fit.
    await seed(finishes, 20 * 60_000).runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("succeeded");
    expect(JSON.stringify(run?.result)).toContain(String(20 * 60_000));
  }, 20_000);

  /**
   * Past the limit: stopped, and stopped *visibly*.
   *
   * Concurrency is 1, so a module that waits holds the only slot — that
   * is the trade a person is making deliberately when they raise this,
   * and the reason the limit still has to bite when it is reached.
   */
  it("stops a module that overruns, ends the run, and says so in a comment", async () => {
    await seed(overruns, 700).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    // Ended, not held: invariant #9 — an escalation ends the run rather
    // than parking a subprocess against a person's attention.
    expect(run?.status).toBe("awaiting_input");
    expect(run?.endedAt).not.toBeNull();

    // Invariant #8 — every guard ends in a comment, and this one names
    // the limit and where it is set, because "it timed out" is not
    // something anybody can act on.
    const said = listCommentsForItem(handle.db, item.id).at(-1);
    expect(said?.kind).toBe("escalation");
    expect(said?.body).toContain("700ms");
    expect(said?.body).toContain("ask the assistant to raise it on the step");

    // Still where it was. A limit reached is not a result the graph can
    // route on — it is a question for whoever configured the step.
    expect(getItem(handle.db, item.id)?.stepId).toBe("merge_step");
  }, 30_000);
});
