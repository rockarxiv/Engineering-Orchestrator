import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModuleManifest } from "@eo/core";
import type { DbHandle } from "../client.js";
import { openMigratedTestDb } from "../testHelpers.js";
import { archiveModule, getModule, getModuleBySlug, listModules, saveModule, upsertReplicaModule } from "./modulesRepo.js";

const manifest: ModuleManifest = {
  name: "Deploy",
  description: "Builds and deploys the current branch to staging.",
  inputs: {},
  needs: { bin: ["flyctl"], env: ["FLY_API_TOKEN"], network: true, item: false, comment: false, attach: false, create: false },
  results: ["deployed", "failed"],
};

function deploy(overrides: Partial<Parameters<typeof saveModule>[1]> = {}) {
  return {
    slug: "deploy",
    name: "Deploy",
    description: "Builds and deploys the current branch to staging.",
    code: "export default async function run() { return { ok: true, result: 'deployed', detail: '' }; }",
    manifest,
    ...overrides,
  };
}

describe("modulesRepo", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("creates a module and finds it by slug", () => {
    const saved = saveModule(handle.db, deploy());
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    expect(saved.module.slug).toBe("deploy");
    expect(saved.module.manifest.results).toEqual(["deployed", "failed"]);
    // Never approved by saving. Approval is a separate act, because a save
    // that carried it would make every edit self-approving.
    expect(saved.module.approvedAt).toBeNull();
    expect(getModuleBySlug(handle.db, "deploy")?.id).toBe(saved.module.id);
  });

  it("refuses a slug another module already uses", () => {
    saveModule(handle.db, deploy());
    const second = saveModule(handle.db, deploy({ name: "Deploy again" }));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toContain("deploy");
  });

  it("keeps the slug when a module is edited in place", () => {
    const first = saveModule(handle.db, deploy());
    if (!first.ok) return;
    const again = saveModule(handle.db, deploy({ id: first.module.id, name: "Deploy to staging" }));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.module.name).toBe("Deploy to staging");
    expect(listModules(handle.db)).toHaveLength(1);
  });

  it("approves only when asked, and records when", () => {
    const created = saveModule(handle.db, deploy());
    if (!created.ok) return;
    const approved = saveModule(handle.db, deploy({ id: created.module.id, approve: true }), 1000);
    expect(approved.ok && approved.module.approvedAt).toBe(1000);
  });

  // The rule the whole approval gate rests on: approving is about a body
  // of code, so changing the code has to withdraw it. Without this an
  // approved module is an editable one and the gate protects only the
  // first version anyone wrote.
  it("clears the approval when the code changes", () => {
    const created = saveModule(handle.db, deploy());
    if (!created.ok) return;
    saveModule(handle.db, deploy({ id: created.module.id, approve: true }), 1000);

    const edited = saveModule(handle.db, deploy({ id: created.module.id, code: "export default async function run() { throw new Error('x'); }" }), 2000);
    expect(edited.ok && edited.module.approvedAt).toBeNull();
  });

  it("clears the approval when the manifest changes", () => {
    const created = saveModule(handle.db, deploy());
    if (!created.ok) return;
    saveModule(handle.db, deploy({ id: created.module.id, approve: true }), 1000);

    const widened = saveModule(handle.db, deploy({ id: created.module.id, manifest: { ...manifest, needs: { bin: ["flyctl", "curl"], env: [], network: true, item: false, comment: false, attach: false, create: false } } }), 2000);
    expect(widened.ok && widened.module.approvedAt).toBeNull();
  });

  it("keeps the approval when only the name or description changes", () => {
    const created = saveModule(handle.db, deploy());
    if (!created.ok) return;
    saveModule(handle.db, deploy({ id: created.module.id, approve: true }), 1000);

    const renamed = saveModule(handle.db, deploy({ id: created.module.id, name: "Ship it", description: "Deploys the branch." }), 2000);
    expect(renamed.ok && renamed.module.approvedAt).toBe(1000);
  });

  it("archives rather than deletes, and keeps the code", () => {
    const created = saveModule(handle.db, deploy());
    if (!created.ok) return;
    archiveModule(handle.db, created.module.id, 3000);

    expect(listModules(handle.db)).toHaveLength(0);
    const archived = listModules(handle.db, true);
    expect(archived).toHaveLength(1);
    // A historical run's transcript still refers to this source.
    expect(archived[0]!.code).toContain("deployed");
    expect(archived[0]!.archivedAt).toBe(3000);
  });
});

/**
 * A module as the organisation published it (EO-329, ARCHITECTURE.md, "Publish, lock and
 * versions").
 *
 * Code and approval together: a `module` step runs the code on the
 * machine the work is on, and a replica that dropped the approval would
 * hold a published pipeline that refuses to run everywhere, with nobody
 * able to approve it — the section is locked.
 */
describe("upsertReplicaModule", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  function published(overrides: Partial<Parameters<typeof upsertReplicaModule>[1]> = {}) {
    return {
      id: "019fb8c6-0000-7000-8000-00000000bbbb",
      slug: "deploy",
      name: "Deploy",
      description: "Ships the branch.",
      code: "export default async () => ({ result: 'shipped' });",
      manifest,
      originalScript: null,
      source: "import",
      approvedAt: 1_700_000_000_000,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      archivedAt: null,
      ...overrides,
    };
  }

  it("writes the code and the approval, by the record's id", () => {
    upsertReplicaModule(handle.db, published());

    const landed = getModule(handle.db, "019fb8c6-0000-7000-8000-00000000bbbb");
    expect(landed?.code).toBe("export default async () => ({ result: 'shipped' });");
    expect(landed?.approvedAt).not.toBeNull();

    upsertReplicaModule(handle.db, published({ code: "export default async () => ({ result: 'rolled-back' });" }));
    expect(getModule(handle.db, "019fb8c6-0000-7000-8000-00000000bbbb")?.code).toContain("rolled-back");
    expect(listModules(handle.db, true)).toHaveLength(1);
  });

  it("stands a local module of the same slug aside rather than colliding with it", () => {
    const mine = saveModule(handle.db, deploy());
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;

    upsertReplicaModule(handle.db, published());

    expect(getModuleBySlug(handle.db, "deploy")?.id).toBe("019fb8c6-0000-7000-8000-00000000bbbb");
    // Archived rather than deleted: a step and a run still
    // point at the row.
    expect(getModule(handle.db, mine.module.id)?.archivedAt).not.toBeNull();
    expect(getModule(handle.db, mine.module.id)?.slug).not.toBe("deploy");
  });
});
