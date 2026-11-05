import { ModuleManifestSchema, type Uuid } from "@eo/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { approveModule, archiveModule, createRun, getModule, listModuleTests, saveModule, saveModuleTest, updateRun } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { createAdminMcpHost } from "../mcpHost/admin.js";
import type { ModuleTestRunner } from "../modules/moduleTestRunner.js";
import { approvedModuleTestWriteRefusal } from "../roles/assist.js";
import { scenarioAgent, scenarioModuleWriteRefusal, SCENARIO_ACTION } from "../roles/scenario.js";
import { deleteModuleTestCommand, listModuleTestsCommand, saveModuleTestCommand } from "./moduleTestCommands.js";
import { clearHandlerRegistry, registerHandler } from "./registry.js";
import { sendToScenario } from "./scenarioCommands.js";

/**
 * `eo_admin`'s test-case tools on an approved module (EO-499).
 *
 * Any change to an approved module's test cases withdraws its approval
 * (EO-498), and in the help chat that change is the person's to apply on
 * a card. So `module_test_save` and `module_test_delete` are refused on
 * an approved module — unless a scenario turn about that module is
 * running, whose job is to write cases — and the refusal names the route
 * that is open. Asserted through the host the system agent reaches, with
 * the `refuseCall` the composition root builds, and against the rows.
 */

const manifest = ModuleManifestSchema.parse({ name: "Tag", description: "Tags a release.", inputs: {}, needs: { bin: ["git"] }, results: ["tagged"] });
const CODE = `export default async function (ctx) { await ctx.exec("git", ["tag", "v1"]); return { ok: true, result: "tagged" }; }`;
const TAGS = `import assert from "node:assert/strict";
export default async function (harness) {
  const run = await harness.run({ exec: [{ bin: "git", args: ["tag", "v1"], code: 0 }] });
  assert.equal(run.outcome.ok, true);
}`;

let handle: DbHandle;
const runner = { schedule: vi.fn() } as unknown as ModuleTestRunner;
const opts = { exposeErrorDetails: true };

beforeEach(() => {
  handle = openMigratedTestDb();
  vi.mocked(runner.schedule).mockClear();
  registerHandler("moduleTests:list", (payload) => listModuleTestsCommand(handle.db, payload), opts);
  registerHandler("moduleTests:save", (payload) => saveModuleTestCommand(handle.db, runner, payload), opts);
  registerHandler("moduleTests:delete", (payload) => deleteModuleTestCommand(handle.db, runner, payload), opts);
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

/** A module with one case, approved after it unless asked otherwise. */
function saveTag(approved = true): { moduleId: string; caseId: string } {
  const saved = saveModule(handle.db, { slug: "tag", name: "Tag", description: "Tags a release.", code: CODE, manifest, source: "user" });
  if (!saved.ok) throw new Error(saved.reason);
  const test = saveModuleTest(handle.db, { moduleId: saved.module.id, description: "tags v1", source: TAGS });
  if (!test.ok) throw new Error(test.reason);
  if (approved) approveModule(handle.db, saved.module.id);
  return { moduleId: saved.module.id, caseId: test.test.id };
}

/** What the module's cases and approval are, as the rows hold them. */
function rows(moduleId: string) {
  return { approvedAt: getModule(handle.db, moduleId)?.approvedAt ?? null, tests: listModuleTests(handle.db, moduleId).map((test) => [test.id, test.description, test.source]) };
}

async function adminClient() {
  // As `startMain.ts` composes it.
  const host = createAdminMcpHost({
    db: handle.db,
    version: "0.0.0-test",
    refuseCall: (tool, args) => scenarioModuleWriteRefusal(handle.db, tool, args) ?? approvedModuleTestWriteRefusal(handle.db, tool, args),
  });
  await host.start();
  const endpoint = host.endpoint()!;
  const token = endpoint.lease().token;
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    // @ts-expect-error — the SDK's client transport does not satisfy its own Transport type under
    // `exactOptionalPropertyTypes`; see admin.test.ts.
    new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  );
  return {
    client,
    stop: async () => {
      await client.close();
      await host.stop();
    },
  };
}

const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0]?.text ?? "";

describe("eo_admin's test-case tools on an approved module, with no scenario turn about it running", () => {
  it("refuses module_test_save with and without an id, and module_test_delete, writing nothing and naming `change`", async () => {
    const { moduleId, caseId } = saveTag();
    const before = rows(moduleId);
    expect(before.approvedAt).not.toBeNull();

    const { client, stop } = await adminClient();
    try {
      const calls = [
        { name: "module_test_save", arguments: { moduleId, description: "tags v2", source: TAGS } },
        { name: "module_test_save", arguments: { id: caseId, moduleId, description: "tags v1, renamed", source: TAGS } },
        { name: "module_test_delete", arguments: { id: caseId } },
      ];
      for (const call of calls) {
        const refused = await client.callTool(call);
        expect(refused.isError, call.name).toBe(true);
        const text = textOf(refused);
        expect(text).toContain(`EO refused ${call.name}: Tag is approved`);
        expect(text).toContain("Nothing has been written.");
        expect(text).toContain("Return the change as `change`");
        expect(text).toContain(`\`moduleId\` "${moduleId}"`);
        expect(text).toContain("`removeTests`");
      }
      expect(rows(moduleId)).toEqual(before);
      expect(runner.schedule).not.toHaveBeenCalled();
    } finally {
      await stop();
    }
  });

  it("lets module_tests_list through: reading changes nothing", async () => {
    const { moduleId } = saveTag();
    const { client, stop } = await adminClient();
    try {
      const listed = await client.callTool({ name: "module_tests_list", arguments: { moduleId } });
      expect(listed.isError).toBe(false);
      expect(textOf(listed)).toContain("tags v1");
    } finally {
      await stop();
    }
  });
});

describe("where the tools still write", () => {
  it("on a module that is not approved", async () => {
    const { moduleId, caseId } = saveTag(false);
    const { client, stop } = await adminClient();
    try {
      const added = await client.callTool({ name: "module_test_save", arguments: { moduleId, description: "tags v2", source: TAGS } });
      expect(added.isError).toBe(false);
      const edited = await client.callTool({ name: "module_test_save", arguments: { id: caseId, moduleId, description: "tags v1, renamed", source: TAGS } });
      expect(edited.isError).toBe(false);
      expect(listModuleTests(handle.db, moduleId).map((test) => test.description)).toEqual(["tags v1, renamed", "tags v2"]);
      const deleted = await client.callTool({ name: "module_test_delete", arguments: { id: caseId } });
      expect(deleted.isError).toBe(false);
      expect(listModuleTests(handle.db, moduleId).map((test) => test.description)).toEqual(["tags v2"]);
    } finally {
      await stop();
    }
  });

  it("on an approved module while a scenario turn about it is running, and not once it has ended", async () => {
    const { moduleId, caseId } = saveTag();
    const conversation = (await sendToScenario(handle.db, undefined, { moduleId, conversationId: null, body: "Add a case for v2.", interrupt: false })).conversation;
    const run = createRun(handle.db, { itemId: conversation.id as Uuid, agentId: scenarioAgent(handle.db)!.id, action: SCENARIO_ACTION, status: "running" });

    const { client, stop } = await adminClient();
    try {
      const added = await client.callTool({ name: "module_test_save", arguments: { moduleId, description: "tags v2", source: TAGS } });
      expect(added.isError).toBe(false);
      // The write is the scenario chat's, and it withdraws the approval like any other (EO-498).
      expect(getModule(handle.db, moduleId)?.approvedAt).toBeNull();

      approveModule(handle.db, moduleId);
      updateRun(handle.db, run.id, { status: "succeeded" });
      const after = await client.callTool({ name: "module_test_delete", arguments: { id: caseId } });
      expect(after.isError).toBe(true);
      expect(textOf(after)).toContain("EO refused module_test_delete");
      expect(listModuleTests(handle.db, moduleId)).toHaveLength(2);
    } finally {
      await stop();
    }
  });
});

describe("while a scenario turn about the module is queued but not running", () => {
  it("still refuses module_test_save with and without an id, and module_test_delete, writing nothing", async () => {
    const { moduleId, caseId } = saveTag();
    const conversation = (await sendToScenario(handle.db, undefined, { moduleId, conversationId: null, body: "Add a case for v2.", interrupt: false })).conversation;
    createRun(handle.db, { itemId: conversation.id as Uuid, agentId: scenarioAgent(handle.db)!.id, action: SCENARIO_ACTION, status: "queued" });
    const before = rows(moduleId);
    expect(before.approvedAt).not.toBeNull();

    const { client, stop } = await adminClient();
    try {
      for (const call of [
        { name: "module_test_save", arguments: { moduleId, description: "tags v2", source: TAGS } },
        { name: "module_test_save", arguments: { id: caseId, moduleId, description: "tags v1, renamed", source: TAGS } },
        { name: "module_test_delete", arguments: { id: caseId } },
      ]) {
        const refused = await client.callTool(call);
        expect(refused.isError, call.name).toBe(true);
        expect(textOf(refused)).toContain(`EO refused ${call.name}: Tag is approved`);
        expect(textOf(refused)).toContain("Return the change as `change`");
      }
      expect(rows(moduleId)).toEqual(before);
      expect(runner.schedule).not.toHaveBeenCalled();
    } finally {
      await stop();
    }
  });
});

describe("approvedModuleTestWriteRefusal", () => {
  it("has nothing to say about other tools, unknown cases, or a deleted module", () => {
    const { moduleId, caseId } = saveTag();
    expect(approvedModuleTestWriteRefusal(handle.db, "module_tests_run", { moduleId })).toBeNull();
    expect(approvedModuleTestWriteRefusal(handle.db, "module_save", { id: moduleId })).toBeNull();
    // No such case: the delete itself answers that nothing was there.
    expect(approvedModuleTestWriteRefusal(handle.db, "module_test_delete", { id: "no-such-case" })).toBeNull();
    expect(approvedModuleTestWriteRefusal(handle.db, "module_test_delete", { id: caseId })).toContain("EO refused module_test_delete");

    archiveModule(handle.db, moduleId);
    expect(approvedModuleTestWriteRefusal(handle.db, "module_test_save", { moduleId, description: "x", source: TAGS })).toBeNull();
  });
});
