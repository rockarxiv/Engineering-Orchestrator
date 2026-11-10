import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Item, ModuleManifest, StepWatch, Uuid } from "@eo/core";
import { openDb, type DbHandle } from "../db/client.js";
import { moduleItemReader } from "../modules/moduleItemRead.js";
import { runMigrations } from "../db/migrate.js";
import { createRoute, createStep, getItem, getItemWatch, listActiveRuns, listCommentsForItem, listRunEvents, listRunsForItem, saveModule } from "../db/repos/index.js";
import { createModuleRunnerLookup } from "../modules/registry.js";
import { createTestItem } from "../db/testHelpers.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { kindsPreparing } from "./testWorkspaceKinds.js";

/**
 * A module that is a check, end to end (EO-458, ARCHITECTURE.md,
 * "Modules: a step that is a script").
 *
 * What the watch does with a check's answer is `watchSteps.test.ts`'s,
 * against a stub runner. What only a real host can show is the module's
 * half: that `waiting` and its news cross the boundary from a module
 * whose manifest says `watch: true`, and that the same word from one
 * whose manifest does not is a failed run with a sentence saying why.
 *
 * On disk for `moduleTimeLimit.test.ts`' reason: the host opens EO's
 * database itself, and `:memory:` is private to the handle that made it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, "..", "modules", "moduleHost.mjs");
const migrationsFolder = join(here, "..", "db", "migrations");

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const MINUTE = 60_000;
const START = 1_800_000_000_000;

const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${text}`),
  decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ""),
};

/**
 * Asks about a signature, and hears the outside system's answer from a
 * file in its working directory — still waiting with nothing new, still
 * waiting with news, or signed — so each test says what it said this
 * time.
 */
const SIGNATURE = `
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
export default async function run(ctx) {
  const file = join(ctx.cwd, "answer.txt");
  const answer = existsSync(file) ? readFileSync(file, "utf8") : "nothing";
  if (answer === "signed") return { ok: true, result: "signed", detail: "Signed." };
  if (answer === "viewed") return { ok: true, result: "waiting", news: [{ id: "viewed-1", text: "Ada opened the document." }] };
  return { ok: true, result: "waiting" };
}`;

function manifest(watch: boolean): ModuleManifest {
  return {
    name: "Signature",
    description: "Asks whether the contract is signed.",
    inputs: {},
    needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
    results: ["signed", "failed"],
    ...(watch ? { watch: true } : {}),
  };
}

let directory: string;
let handle: DbHandle;
let item: Item;
let clock: number;

/** A `signature` step running the module, keeping checking or not, with an item standing on it. */
function seed(options: { watch: boolean; step: StepWatch | null }) {
  const saved = saveModule(handle.db, {
    slug: "signature",
    name: "Signature",
    description: "Asks whether the contract is signed.",
    code: SIGNATURE,
    manifest: manifest(options.watch),
    approve: true,
  });
  if (!saved.ok) throw new Error(saved.reason);

  createStep(handle.db, {
    id: "signature",
    pipelineId: "default" as Uuid,
    position: 15,
    name: "Wait for the signature",
    type: "module",
    entryAction: saved.module.id,
    watch: options.step,
  });
  createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "signature", resultKey: "signed", label: "Signed", target: "review" });

  item = createTestItem(handle.db, { type: "story", title: "Sign the contract", stepId: "signature" });

  return createRunSupervisor({
    db: handle.db,
    provider: { start: () => { throw new Error("a module must not reach a provider"); } } as never,
    limits: LIMITS,
    now: () => clock,
    moduleRunner: createModuleRunnerLookup({
      db: handle.db,
      launcher: { execPath: process.execPath, hostPath, hostEnv: { ELECTRON_RUN_AS_NODE: "1" }, items: moduleItemReader(handle.db) },
      secrets: { directory: join(directory, "secrets"), store },
    }),
    kinds: kindsPreparing(directory),
  });
}

/** What the module will hear from the outside system on its next run. */
function answering(answer: "nothing" | "viewed" | "signed"): void {
  writeFileSync(join(directory, "answer.txt"), answer);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eo module check "));
  handle = openDb(join(directory, "eo.db"));
  runMigrations(handle.db, migrationsFolder);
  clock = START;
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("a module that is a check", () => {
  it("answers waiting from a manifest that declares watch: true; the watch row is updated and nothing routes", async () => {
    const supervisor = seed({ watch: true, step: { everyMinutes: 5, giveUpAfterHours: 168 } });

    // Waiting with nothing new: the watch row and a line on the quiet
    // run, one check or two.
    await supervisor.runOnce();
    clock += 5 * MINUTE;
    await supervisor.runOnce();
    const [quiet, ...others] = listRunsForItem(handle.db, item.id);
    expect(others).toEqual([]);
    expect(quiet).toMatchObject({ provider: "module", status: "succeeded", startedAt: null });
    expect(listRunEvents(handle.db, quiet!.id).map((event) => event.payload)).toEqual([
      { type: "output", text: "Still waiting." },
      { type: "output", text: "Still waiting." },
    ]);
    expect(listActiveRuns(handle.db)).toEqual([]);
    let watch = getItemWatch(handle.db, item.id, "signature");
    expect(watch).toMatchObject({ checks: 2, consecutiveFailures: 0, lastCheckedAt: START + 5 * MINUTE, nextCheckAt: START + 10 * MINUTE, postedNewsIds: [] });
    expect(getItem(handle.db, item.id)?.stepId).toBe("signature");

    // Waiting with news: a run that completes without a result key, and
    // one comment carrying what the module noticed.
    clock += 5 * MINUTE;
    answering("viewed");
    await supervisor.runOnce();
    const [, run] = listRunsForItem(handle.db, item.id);
    expect(run).toMatchObject({ provider: "module", status: "succeeded" });
    expect(run?.result).toMatchObject({ parsed: { result: "waiting" } });
    watch = getItemWatch(handle.db, item.id, "signature");
    expect(watch).toMatchObject({ checks: 3, lastCheckedAt: START + 10 * MINUTE, postedNewsIds: ["viewed-1"] });
    const news = listCommentsForItem(handle.db, item.id).filter((comment) => comment.runId === run?.id);
    expect(news).toHaveLength(1);
    expect(news[0]?.body).toContain("> Ada opened the document.");
    expect(getItem(handle.db, item.id)?.stepId).toBe("signature");

    // A declared result routes as any module's does.
    clock += 5 * MINUTE;
    answering("signed");
    await supervisor.runOnce();
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
  }, 30_000);

  it("fails the run of a module whose manifest does not declare watch: true, with a comment saying so", async () => {
    const supervisor = seed({ watch: false, step: null });

    await supervisor.runOnce();

    // A module's `{ ok: false }` parks the item with an escalation rather
    // than routing (KAN-105), and that is what this is: the run ended
    // with the sentence as its error, and a person is asked.
    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("awaiting_input");
    expect(run?.endedAt).not.toBeNull();
    expect(run?.result).toBeNull();
    expect(run?.error).toContain("its manifest does not declare `watch: true`, so it cannot wait");
    const said = listCommentsForItem(handle.db, item.id).find((comment) => comment.runId === run?.id);
    expect(said?.kind).toBe("escalation");
    expect(said?.body).toContain("its manifest does not declare `watch: true`, so it cannot wait");
    // Never along a route, and never read as a result key.
    expect(getItem(handle.db, item.id)?.stepId).toBe("signature");
    expect(getItemWatch(handle.db, item.id, "signature")).toBeUndefined();
  }, 30_000);
});
