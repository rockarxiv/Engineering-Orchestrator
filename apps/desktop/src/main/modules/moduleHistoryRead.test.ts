import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uuidv7, type CustomModule, type Item, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { addItemAttachments, createRun, listAgents, transitionItem, updateRun } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { moduleItemReader, type ModuleItemReaderOptions } from "./moduleItemRead.js";
import { runModule, type ModuleHostLauncher, type ModuleOutcome } from "./runModule.js";

/**
 * An item's runs and step moves, the board searched, and a file's bytes
 * (EO-710) — through the real module host and the main process's reader,
 * so what is asserted is what a module reads.
 */
const here = dirname(fileURLToPath(import.meta.url));

function moduleWith(code: string): CustomModule {
  return {
    id: "019fb8c6-0000-7000-8000-0000000007a0" as Uuid,
    slug: "history",
    name: "History",
    description: "Reads what happened.",
    code,
    manifest: { name: "History", description: "A module.", inputs: {}, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false }, results: ["ok"] },
    originalScript: null,
    source: "user",
    approvedAt: 1,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
  };
}

function answered(outcome: ModuleOutcome): unknown {
  if (!outcome.ok) throw new Error(`the module failed: ${outcome.reason}`);
  return JSON.parse(outcome.detail) as unknown;
}

describe("what a module reads beyond the item", () => {
  let handle: DbHandle;
  let directory: string;
  let feature: Item;
  let story: Item;

  beforeEach(() => {
    handle = openMigratedTestDb();
    directory = mkdtempSync(join(tmpdir(), "eo-710-"));
    feature = createTestItem(handle.db, { type: "feature", title: "Modules read everything", stepId: "todo" });
    story = createTestItem(handle.db, { type: "story", title: "Read the runs", stepId: "todo", parentId: feature.id });
  });

  afterEach(() => {
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const launcher = (options: ModuleItemReaderOptions = {}): ModuleHostLauncher => ({
    execPath: process.execPath,
    hostPath: join(here, "moduleHost.mjs"),
    hostEnv: { ELECTRON_RUN_AS_NODE: "1" },
    items: moduleItemReader(handle.db, options),
  });

  const runOn = (item: Item, body: string, options?: ModuleItemReaderOptions, env: Record<string, string> = {}) =>
    runModule(launcher(options), {
      module: moduleWith(`export default async function run(ctx) { const read = await (async () => { ${body} })(); return { ok: true, result: "ok", detail: JSON.stringify(read) }; }`),
      item,
      cwd: process.cwd(),
      env,
    });

  const agentId = (role: string): Uuid => listAgents(handle.db).find((agent) => agent.role === role)!.id;

  it("lists an item's step moves in order, each with step names, actor and reason", async () => {
    transitionItem(handle.db, { itemId: story.id, toStepId: "review", actor: agentId("implementer"), reason: "run succeeded" });
    transitionItem(handle.db, { itemId: story.id, toStepId: "todo", actor: agentId("reviewer"), reason: "changes requested" });

    const read = answered(await runOn(story, `return ctx.transitions(${JSON.stringify(story.key)});`)) as { found: boolean; transitions: unknown[] };

    expect(read.found).toBe(true);
    expect(read.transitions).toEqual([
      { from: { id: "todo", name: "To Do" }, to: { id: "review", name: "Review" }, actor: "Implementer", reason: "run succeeded", at: expect.any(Number) },
      { from: { id: "review", name: "Review" }, to: { id: "todo", name: "To Do" }, actor: "Reviewer", reason: "changes requested", at: expect.any(Number) },
    ]);
  });

  it("lists an item's runs, oldest first, with the answer each gave", async () => {
    const run = createRun(handle.db, { itemId: story.id, agentId: agentId("implementer"), action: "implement", attempt: 2 });
    const answer = { summary: "Did it.", result: "done" };
    updateRun(handle.db, run.id, { status: "succeeded", result: { raw: answer, parsed: answer }, costCents: 12, startedAt: 1000, endedAt: 2000 });
    const failed = createRun(handle.db, { itemId: story.id, agentId: agentId("implementer"), action: "implement" });
    updateRun(handle.db, failed.id, { status: "failed", error: "tests failed" });

    const read = answered(await runOn(story, `return ctx.runs(${JSON.stringify(story.key)});`)) as { found: boolean; runs: unknown[] };

    expect(read).toEqual({
      found: true,
      runs: [
        {
          id: run.id,
          step: { id: "todo", name: "To Do" },
          action: "implement",
          agentName: "Implementer",
          status: "succeeded",
          resultKey: "done",
          answer,
          error: null,
          attempt: 2,
          startedAt: 1000,
          endedAt: 2000,
          costCents: 12,
        },
        expect.objectContaining({ id: failed.id, status: "failed", resultKey: null, answer: null, error: "tests failed" }),
      ],
    });
  });

  it("takes the result key a pack reads off a run's answer, where one has an opinion", async () => {
    const run = createRun(handle.db, { itemId: story.id, agentId: agentId("reviewer"), action: "review" });
    updateRun(handle.db, run.id, { status: "succeeded", result: { raw: { verdict: "approve" }, parsed: { verdict: "approve" } } });

    const read = answered(await runOn(story, `return ctx.runs(${JSON.stringify(story.key)});`, { resultKey: (asked) => (asked.action === "review" ? "approved" : undefined) })) as {
      runs: { resultKey: string | null }[];
    };

    expect(read.runs.map((entry) => entry.resultKey)).toEqual(["approved"]);
  });

  it("answers a key no item has with a reason, for runs and transitions alike", async () => {
    const read = answered(await runOn(story, `return [await ctx.runs("NOPE-1"), await ctx.transitions("NOPE-1"), await ctx.runs(42)];`));

    expect(read).toEqual([
      { found: false, reason: 'No ticket has the key "NOPE-1".' },
      { found: false, reason: 'No ticket has the key "NOPE-1".' },
      { found: false, reason: 'A ticket key is a string, like "EO-42".' },
    ]);
  });

  it("lists every child of a feature with its step name, and matches on title", async () => {
    const second = createTestItem(handle.db, { type: "story", title: "Search the board", stepId: "review", parentId: feature.id });
    createTestItem(handle.db, { type: "story", title: "Unrelated work", stepId: "todo" });

    const read = answered(
      await runOn(story, `return { children: await ctx.items({ parentKey: ${JSON.stringify(feature.key)} }), titled: await ctx.items({ text: "SEARCH" }), paged: await ctx.items({ limit: 1 }) };`),
    ) as Record<string, { found: boolean; items: unknown[]; total: number; nextOffset: number | null }>;

    expect(read["children"]).toEqual({
      found: true,
      items: [
        { key: story.key, title: "Read the runs", type: "story", pipelineName: expect.any(String), stepName: "To Do", parentKey: feature.key },
        { key: second.key, title: "Search the board", type: "story", pipelineName: expect.any(String), stepName: "Review", parentKey: feature.key },
      ],
      total: 2,
      nextOffset: null,
    });
    expect(read["titled"]?.items).toEqual([expect.objectContaining({ key: second.key })]);
    expect(read["paged"]).toMatchObject({ found: true, total: 4, nextOffset: 1 });
    expect(read["paged"]?.items).toHaveLength(1);
  });

  it("refuses a filter it cannot read, with a reason and no throw", async () => {
    const read = answered(await runOn(story, `const loop = {}; loop.self = loop; return [await ctx.items({ colour: "red" }), await ctx.items({ limit: 0 }), await ctx.items(loop), await ctx.items("all"), await ctx.items({ toJSON() { return null; } }), await ctx.items({ toJSON() { return [1]; } }), await ctx.items({ toJSON() { return undefined; } })];`)) as {
      found: boolean;
      reason: string;
    }[];

    expect(read.map((entry) => entry.found)).toEqual([false, false, false, false, false, false, false]);
    for (const entry of read.slice(4)) expect(entry.reason).toContain("ctx.items() takes one object of filters");
    expect(read[0]?.reason).toContain('does not take "colour"');
    expect(read[1]?.reason).toContain("limit");
  });

  it("returns an attached file's exact bytes, and a reason for an id nothing has", async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 0x7f, 0x80, 10, 13, 0xe2, 0x82, 0xac]);
    const path = join(directory, "blob.bin");
    writeFileSync(path, bytes);
    const elsewhere = createTestItem(handle.db, { type: "story", title: "Holds the file", stepId: "todo" });
    const [attachment] = addItemAttachments(handle.db, elsewhere.id, [{ id: uuidv7() as Uuid, storagePath: path, name: "blob.bin", mimeType: "application/octet-stream", size: bytes.byteLength }]);

    const read = answered(
      await runOn(
        story,
        `const file = await ctx.readAttachment(${JSON.stringify(attachment!.id)});
         const missing = await ctx.readAttachment("019fb8c6-0000-7000-8000-00000000dead");
         return { name: file.attachment.name, mimeType: file.attachment.mimeType, size: file.attachment.size, bytes: [...file.attachment.content], isBytes: file.attachment.content instanceof Uint8Array, missing, bad: await ctx.readAttachment(null) };`,
      ),
    );

    expect(read).toEqual({
      name: "blob.bin",
      mimeType: "application/octet-stream",
      size: bytes.byteLength,
      bytes: [...bytes],
      isBytes: true,
      missing: { found: false, reason: 'No attachment has the id "019fb8c6-0000-7000-8000-00000000dead".' },
      bad: { found: false, reason: "An attachment id is a string, as ctx.item().attachments lists it." },
    });
  });

  it("puts no secret's and no environment variable's value in any of the four answers", async () => {
    process.env["EO_710_PROBE"] = "an-environment-value-710";
    try {
      const run = createRun(handle.db, { itemId: story.id, agentId: agentId("implementer"), action: "implement" });
      updateRun(handle.db, run.id, { status: "succeeded", result: { raw: { result: "done" }, parsed: { result: "done" } } });
      transitionItem(handle.db, { itemId: story.id, toStepId: "review", actor: "human", reason: "manual" });
      const outcome = await runOn(
        story,
        `return [await ctx.runs(${JSON.stringify(story.key)}), await ctx.transitions(${JSON.stringify(story.key)}), await ctx.items({}), await ctx.readAttachment("x")];`,
        {},
        { API_TOKEN: "a-secret-value-710" },
      );

      const detail = outcome.ok ? outcome.detail : "";
      expect(detail).toContain(story.key);
      for (const value of ["a-secret-value-710", "an-environment-value-710"]) expect(detail).not.toContain(value);
    } finally {
      delete process.env["EO_710_PROBE"];
    }
  });
});
