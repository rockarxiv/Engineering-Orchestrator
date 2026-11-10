import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CustomModule, Item, Uuid } from "@eo/core";
import type { DbHandle } from "../../../db/client.js";
import { addDependency, updateItem } from "../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import { moduleItemReader } from "../../../modules/moduleItemRead.js";
import { runModule, type ModuleHostLauncher } from "../../../modules/runModule.js";
import { pullRequestTargetBranch } from "./openForItem.js";

/**
 * `ctx.item().git.targetBranch` (EO-709): the branch an item's pull
 * request is or will be opened against, worked out by the code
 * `open_pull_request` opens one with — through the real module host, so
 * what is asserted is what a module reads.
 */
const here = dirname(fileURLToPath(import.meta.url));
const launcherFor = (handle: DbHandle): ModuleHostLauncher => ({
  execPath: process.execPath,
  hostPath: join(here, "..", "..", "..", "modules", "moduleHost.mjs"),
  hostEnv: { ELECTRON_RUN_AS_NODE: "1" },
  items: moduleItemReader(handle.db, { targetBranch: (item) => pullRequestTargetBranch(handle.db, item) }),
});

const probe: CustomModule = {
  id: "019fb8c6-0000-7000-8000-0000000000ab" as Uuid,
  slug: "target",
  name: "Target",
  description: "Says where the pull request goes.",
  code: `export default async function run(ctx) { return { ok: true, result: "ok", detail: String(ctx.item().item.git.targetBranch) }; }`,
  manifest: { name: "Target", description: "A module.", inputs: {}, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false }, results: ["ok"] },
  originalScript: null,
  source: "user",
  approvedAt: 1,
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
};

describe("the branch a module is told an item's pull request targets", () => {
  let handle: DbHandle;
  let workspaceId: Uuid;

  beforeEach(() => {
    handle = openMigratedTestDb();
    workspaceId = attachWorkspace(handle.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/eo-709-app", baseBranch: "trunk" }).id;
  });

  afterEach(() => handle.close());

  const targetOf = async (item: Item): Promise<string> => {
    const outcome = await runModule(launcherFor(handle), { module: probe, item, cwd: process.cwd(), env: {} });
    if (!outcome.ok) throw new Error(`the module failed: ${outcome.reason}`);
    return outcome.detail;
  };

  it("is the repository's base branch when the item names none", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Ship it", stepId: "todo", workspaceId });

    expect(await pullRequestTargetBranch(handle.db, item)).toBe("trunk");
    expect(await targetOf(item)).toBe("trunk");
  });

  it("is the item's own base branch when it names one", async () => {
    const created = createTestItem(handle.db, { type: "story", title: "Backport it", stepId: "todo", workspaceId });
    const item = updateItem(handle.db, created.id, { git: { baseBranch: "release/2.4" } });

    expect(await pullRequestTargetBranch(handle.db, item)).toBe("release/2.4");
    expect(await targetOf(item)).toBe("release/2.4");
  });

  /**
   * A same-feature dependency with no branch recorded is unmerged
   * without asking the forge, so the item stacks on it — and with no
   * branch to name, `open_pull_request` would refuse rather than guess,
   * so the module is told null rather than the repository's base.
   */
  it("follows the stacking decision rather than falling back to the base", async () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "The feature", stepId: null, workspaceId });
    const first = createTestItem(handle.db, { type: "story", title: "First", stepId: "todo", parentId: feature.id, workspaceId });
    const second = createTestItem(handle.db, { type: "story", title: "Second", stepId: "todo", parentId: feature.id, workspaceId });
    addDependency(handle.db, second.id, first.id);

    expect(await pullRequestTargetBranch(handle.db, second)).toBeNull();
    expect(await targetOf(second)).toBe("null");
  });

  it("is null for an item with no git workspace", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Talk about it", stepId: "todo" });

    expect(await pullRequestTargetBranch(handle.db, item)).toBeNull();
    expect(await targetOf(item)).toBe("null");
  });
});
