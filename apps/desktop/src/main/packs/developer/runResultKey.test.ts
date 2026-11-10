import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CustomModule, Item, Uuid } from "@eo/core";
import type { DbHandle } from "../../db/client.js";
import { createRun, listAgents, updateRun } from "../../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../../db/testHelpers.js";
import { moduleItemReader } from "../../modules/moduleItemRead.js";
import { runModule } from "../../modules/runModule.js";
import { createRunResultKey } from "./wiring.js";

/**
 * `ctx.runs()`'s `resultKey` (EO-710) on the runs this pack means
 * something by: a review's verdict read as the key it routed on, through
 * the real module host, so what is asserted is what a module reads.
 */
const here = dirname(fileURLToPath(import.meta.url));

const probe: CustomModule = {
  id: "019fb8c6-0000-7000-8000-0000000007a1" as Uuid,
  slug: "runs",
  name: "Runs",
  description: "Reads the item's runs.",
  code: `export default async function run(ctx) { return { ok: true, result: "ok", detail: JSON.stringify(await ctx.runs(ctx.item().item.key)) }; }`,
  manifest: { name: "Runs", description: "A module.", inputs: {}, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false }, results: ["ok"] },
  originalScript: null,
  source: "user",
  approvedAt: 1,
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
};

describe("the result key a module reads off a run", () => {
  let handle: DbHandle;
  let item: Item;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "Review me", stepId: "review" });
  });

  afterEach(() => handle.close());

  const agentId = (role: string): Uuid => listAgents(handle.db).find((agent) => agent.role === role)!.id;

  const runsOf = async (): Promise<{ action: string; resultKey: string | null; answer: unknown }[]> => {
    const outcome = await runModule(
      {
        execPath: process.execPath,
        hostPath: join(here, "..", "..", "modules", "moduleHost.mjs"),
        hostEnv: { ELECTRON_RUN_AS_NODE: "1" },
        items: moduleItemReader(handle.db, { resultKey: createRunResultKey(handle.db) }),
      },
      { module: probe, item, cwd: process.cwd(), env: {} },
    );
    if (!outcome.ok) throw new Error(`the module failed: ${outcome.reason}`);
    return (JSON.parse(outcome.detail) as { runs: { action: string; resultKey: string | null; answer: unknown }[] }).runs;
  };

  it("is the key a reviewer's verdict routed on, beside the reviewer's whole answer", async () => {
    const rejection = {
      verdict: "reject",
      feedback: "Close, but not yet.",
      criteria_coverage: [{ criterion: "It works", result: "not_met", note: "It does not." }],
      blocking_issues: ["No tests."],
      memoryUsed: [],
    };
    const rejected = createRun(handle.db, { itemId: item.id, agentId: agentId("reviewer"), action: "review" });
    updateRun(handle.db, rejected.id, { status: "succeeded", result: { raw: rejection, parsed: rejection } });
    const approval = { verdict: "approve", feedback: "Good.", memoryUsed: [] };
    const approved = createRun(handle.db, { itemId: item.id, agentId: agentId("reviewer"), action: "review" });
    updateRun(handle.db, approved.id, { status: "succeeded", result: { raw: approval, parsed: approval } });

    expect(await runsOf()).toEqual([
      expect.objectContaining({ action: "review", resultKey: "changes_requested", answer: rejection }),
      expect.objectContaining({ action: "review", resultKey: "approved", answer: approval }),
    ]);
  });

  it("is done for an implement run, and null for a run that has not answered", async () => {
    const implemented = createRun(handle.db, { itemId: item.id, agentId: agentId("implementer"), action: "implement" });
    updateRun(handle.db, implemented.id, { status: "succeeded", result: { raw: { summary: "Did it." }, parsed: { summary: "Did it." } } });
    createRun(handle.db, { itemId: item.id, agentId: agentId("reviewer"), action: "review" });

    expect((await runsOf()).map((run) => run.resultKey)).toEqual(["done", null]);
  });
});
