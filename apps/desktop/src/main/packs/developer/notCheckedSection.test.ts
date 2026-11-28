import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7, type Agent, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../db/client.js";
import { createRun, listAgents, updateRun } from "../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../db/testHelpers.js";
import { buildFollowUpContext, buildSeedContext } from "../../supervisor/buildDispatchContext.js";
import { developerPack } from "./index.js";
import type { VerificationResult } from "./workspace/verify.js";

/**
 * What the reviewer is told about checks verification never ran
 * (EO-927), read through the real rows and the prompt the pack's
 * renderers actually build.
 */
let handle: DbHandle;
let drive: string;
let implementer: Agent;
let reviewer: Agent;

beforeEach(() => {
  handle = openMigratedTestDb();
  drive = mkdtempSync(join(tmpdir(), "eo not checked "));
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
});

afterEach(() => {
  handle.close();
  rmSync(drive, { recursive: true, force: true });
});

const renderers = () => developerPack({ db: handle.db }).sectionRenderers ?? [];

const passed = (name: string) => ({ name, ok: true, detail: `\`${name}\` passed.` });
const skipped = (name: string) => ({ name, ok: true, skipped: true as const, detail: `No ${name} command configured — not checked.` });
const mechanical = [passed("branch"), passed("clean"), passed("rebase")];

function implemented(verification: VerificationResult): Item {
  attachWorkspace(handle.db, { name: "the repo", keyPrefix: "EO", repoPath: drive, baseBranch: "main" });
  const item = createTestItem(handle.db, { type: "story", title: "Fix the login screen", stepId: "review" });
  const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", stepId: "todo" });
  updateRun(handle.db, run.id, { status: "succeeded", endedAt: Date.now(), verification: verification as unknown as Record<string, unknown> });
  return item;
}

describe("the reviewer's dispatch", () => {
  it("says no tests were run when the repository has no commands configured", async () => {
    const item = implemented({ ok: true, steps: [...mechanical, skipped("test"), skipped("lint"), skipped("build")] });

    const text = await buildSeedContext(handle.db, item, reviewer, "review", renderers());

    expect(text).toContain("## No tests were run");
    expect(text).toContain("this repository has no test command configured");
    expect(text).toContain("There is no lint or build command configured either");
  });

  it("says nothing of the kind when all three are configured", async () => {
    const item = implemented({ ok: true, steps: [...mechanical, passed("test"), passed("lint"), passed("build")] });

    const text = await buildSeedContext(handle.db, item, reviewer, "review", renderers());

    expect(text).not.toContain("No tests were run");
    expect(text).not.toContain("Checks EO did not run");
  });

  it("names the checks it did not run when only the tests did", async () => {
    const item = implemented({ ok: true, steps: [...mechanical, passed("test"), skipped("lint"), passed("build")] });

    const text = await buildSeedContext(handle.db, item, reviewer, "review", renderers());

    expect(text).not.toContain("No tests were run");
    expect(text).toContain("## Checks EO did not run");
    expect(text).toContain("no lint command configured");
  });

  it("is said again to a resumed reviewer, since a command may have been configured since", () => {
    const item = implemented({ ok: true, steps: [...mechanical, skipped("test"), passed("lint"), passed("build")] });
    const prior = createRun(handle.db, { itemId: item.id, agentId: reviewer.id, action: "review", stepId: "review", threadId: uuidv7() });
    updateRun(handle.db, prior.id, { status: "succeeded", endedAt: Date.now() });

    const text = buildFollowUpContext(handle.db, item, reviewer, "review", prior, { sectionRenderers: renderers() }).fullText;

    expect(text).toContain("## No tests were run");
  });

  it("says no tests were run for a branch verified before skipped checks were marked, from what that run recorded", async () => {
    // The verifier's words for a missing command before EO-927, with no
    // `skipped` mark: the run row is what says the tests never ran.
    const legacy = (name: string) => ({ name, ok: true, detail: `No ${name} command configured — skipped.` });
    const item = implemented({ ok: true, steps: [...mechanical, legacy("test"), passed("lint"), legacy("build")] });

    const text = await buildSeedContext(handle.db, item, reviewer, "review", renderers());

    expect(text).toContain("## No tests were run");
    expect(text).toContain("There is no build command configured either");
  });

  it("does not take a passing step for a skipped one because its detail mentions skipping", async () => {
    const item = implemented({ ok: true, steps: [...mechanical, { name: "test", ok: true, detail: "`pnpm test -- --skipped` passed." }, passed("lint"), passed("build")] });

    expect(await buildSeedContext(handle.db, item, reviewer, "review", renderers())).not.toContain("No tests were run");
  });

  it("is not the implementer's", async () => {
    const item = implemented({ ok: true, steps: [...mechanical, skipped("test"), skipped("lint"), skipped("build")] });

    expect(await buildSeedContext(handle.db, item, implementer, "implement", renderers())).not.toContain("No tests were run");
  });
});
