import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Item, ModuleManifest, Uuid } from "@eo/core";
import { dispatchBlocker, tick } from "@eo/engine";
import type { DbHandle } from "../db/client.js";
import {
  addDependency,
  createProject,
  createRoute,
  createRun,
  createRunEventBuffer,
  createStep,
  getItem,
  getItemByKey,
  getModule,
  getStep,
  listAllDependencies,
  listCommentsForItem,
  listDependencies,
  listItemsIncludingArchived,
  listRunEvents,
  listRunsForItem,
  saveModule,
  transitionItem,
  updateRun,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { getItemDetail, listItemSummaries } from "../ipc/domainQueries.js";
import { buildEligibilityInput, buildTickInput } from "../supervisor/buildTickInput.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { fakeWorkspaceKind, installedKinds, preparingAt } from "../supervisor/testWorkspaceKinds.js";
import { postModuleCreation } from "./moduleCreations.js";
import { createModuleRunnerLookup } from "./registry.js";

/**
 * `wait` and `dependsOn` on `ctx.createItem()` (EO-434).
 *
 * Through a real host and the real scheduler. Waiting is a dependency
 * edge and nothing in the engine was changed for it, so what is asked
 * here is the thing the story could not take on trust: that an item
 * which *gained* a dependency after it entered its pipeline is held at
 * the next step EO would dispatch, and let go on the first tick after
 * what it waits for is finished.
 */

const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${text}`),
  decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ""),
};

const hostPath = join(dirname(fileURLToPath(import.meta.url)), "moduleHost.mjs");
const launcher = { execPath: process.execPath, hostPath, hostEnv: { ELECTRON_RUN_AS_NODE: "1" } };

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const NEEDS = { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: true };
const manifest: ModuleManifest = { name: "Release", description: "Files the follow-up.", inputs: {}, needs: NEEDS, results: ["ok"] };

/** A story the seeded type accepts, on the seeded pipeline. */
const STORY = `type: "story", title: "Write the changelog", body: "For 2.0.", spec: { acceptance_criteria: ["The changelog lists 2.0."] }, pipeline: "Delivery"`;
/** The seeded pipeline's entry step, which EO runs, and its terminal one. */
const ENTRY = "worktree";
const FINISHED = "ready_to_merge";

let handle: DbHandle;
let root: string;
let work: string;
let item: Item;
let saves = 0;

beforeEach(() => {
  handle = openMigratedTestDb();
  root = mkdtempSync(join(tmpdir(), "eo module wait "));
  work = join(root, "work");
  mkdirSync(work);
  item = createTestItem(handle.db, { type: "story", title: "Ship 2.0", stepId: "todo" });
});

afterEach(() => {
  handle.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
});

function save(body: string): string {
  const saved = saveModule(handle.db, {
    slug: `release-${(saves += 1)}`,
    name: "Release",
    description: "Files the follow-up.",
    code: `
      export default async function run(ctx) {
        let answer = null;
        ${body}
        return { ok: true, result: "ok", detail: JSON.stringify(answer) };
      }`,
    manifest,
    approve: true,
  });
  if (!saved.ok) throw new Error(saved.reason);
  return saved.module.id;
}

const runnerLookup = () => createModuleRunnerLookup({ db: handle.db, launcher, secrets: { directory: join(root, "secrets"), store } });

/** Runs a module body on `on` and answers with what it assigned to `answer` and the run's transcript. */
async function run(body: string, on: Item = item) {
  const moduleId = save(body);
  const row = createRun(handle.db, { itemId: on.id, agentId: null, action: moduleId, status: "running", provider: "module" });
  const buffer = createRunEventBuffer(handle.db);
  const outcome = await runnerLookup()(moduleId)!({
    db: handle.db,
    item: on,
    prepareWorkspace: preparingAt(work),
    report: (text: string) => {
      buffer.append(row.id, "output", { type: "output", text });
      buffer.flush();
    },
    runId: row.id,
  });
  if (!outcome.ok) throw new Error(outcome.reason);
  // Over, as the supervisor would have recorded it: a run still marked
  // running holds its item for a reason that is not the one asked about.
  updateRun(handle.db, row.id, { status: "succeeded" });
  return {
    answer: JSON.parse(outcome.detail) as unknown,
    transcript: listRunEvents(handle.db, row.id)
      .map((event) => (event.payload as { text?: string }).text ?? "")
      .join(""),
  };
}

const created = (answer: unknown): Item => {
  expect(answer).toMatchObject({ created: true });
  return getItemByKey(handle.db, (answer as { key: string }).key)!;
};
const refused = (answer: unknown): string => {
  expect(answer).toMatchObject({ created: false });
  return (answer as { reason: string }).reason;
};

/** What the next tick would dispatch, by item id. The scheduler itself, asked of the real tables. */
const dispatched = (): string[] => tick(buildTickInput(handle.db, LIMITS, false)).map((dispatch) => dispatch.item.id);
const blocker = (id: string) => dispatchBlocker(buildEligibilityInput(handle.db, false), id as Uuid);
const finish = (id: string) => transitionItem(handle.db, { itemId: id as Uuid, toStepId: FINISHED, actor: "human" });
const waitsFor = (id: string): string[] => listDependencies(handle.db, id as Uuid).map((edge) => edge.dependsOnId as string);
const everyItem = () => listItemsIncludingArchived(handle.db);
const engineComments = (id: string): string[] =>
  listCommentsForItem(handle.db, id as Uuid)
    .filter((comment) => comment.authorType === "engine")
    .map((comment) => comment.body);

describe("wait: this_waits", () => {
  /**
   * The whole of it, through the supervisor: the module step runs, the
   * item moves along its result's route, and the step it lands on is
   * the one that is held.
   */
  it("lets the module return and its item move on, and holds the next step until the created item is finished", async () => {
    const moduleId = save(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, wait: "this_waits" });`);
    createStep(handle.db, { id: "release", pipelineId: "default" as Uuid, position: 15, name: "Release", type: "module", entryAction: moduleId });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "release", resultKey: "ok", label: "Done", target: "review" });
    const origin = createTestItem(handle.db, { type: "story", title: "Cut the release", stepId: "release" });
    // Only the module step is to run: the story the test began with
    // would otherwise be dispatched to a provider this test has none of.
    finish(item.id);

    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: { start: () => { throw new Error("only the module step runs here"); } } as never,
      limits: LIMITS,
      moduleRunner: runnerLookup(),
      kinds: installedKinds(fakeWorkspaceKind({ cwd: work })),
    });
    await supervisor.runOnce();

    // The module returned and the item moved along that route.
    expect(listRunsForItem(handle.db, origin.id)).toHaveLength(1);
    expect(getItem(handle.db, origin.id)?.stepId).toBe("review");
    const made = everyItem().find((entry) => entry.title === "Write the changelog")!;
    expect(made.stepId).toBe(ENTRY);
    expect(waitsFor(origin.id)).toEqual([made.id]);

    // Held where it landed, by a dependency it gained after it entered
    // its pipeline — while the item it waits for is free to be worked.
    expect(blocker(origin.id)).toMatchObject({ kind: "open_dependency", wait: "finished" });
    expect(dispatched()).not.toContain(origin.id);
    expect(dispatched()).toContain(made.id);

    // And let go on the first tick after the created item is finished.
    finish(made.id);
    expect(blocker(origin.id)).toBeNull();
    expect(dispatched()).toContain(origin.id);
  });

  it("leaves the originating item waiting on all three of three creations, and dispatches it only once all three are finished", async () => {
    const result = await run(`
      answer = [];
      for (const key of ["a", "b", "c"]) answer.push(await ctx.createItem({ idempotencyKey: key, ${STORY}, wait: "this_waits" }));
    `);
    const made = (result.answer as unknown[]).map(created);
    expect(waitsFor(item.id).sort()).toEqual(made.map((one) => one.id as string).sort());

    for (const one of made.slice(0, 2)) {
      expect(dispatched()).not.toContain(item.id);
      finish(one.id);
    }
    // Two of three finished: still held.
    expect(blocker(item.id)).toMatchObject({ kind: "open_dependency", wait: "finished" });
    expect(dispatched()).not.toContain(item.id);

    finish(made[2]!.id);
    expect(dispatched()).toContain(item.id);
  });

  it("says on the originating item that it now waits for the new one", async () => {
    const made = created((await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, wait: "this_waits" });`)).answer);

    expect(engineComments(item.id)).toEqual([`**Release** (module) created ${made.key}: Write the changelog\n\n${item.key} now waits for ${made.key}.`]);
    expect(engineComments(made.id).join("\n")).not.toContain("waits for");
  });

  it("counts one open dependency on the board and lists the created item on the item page, while it is open", async () => {
    const made = created((await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, wait: "this_waits" });`)).answer);
    const openDeps = () => listItemSummaries(handle.db, null).items.find((entry) => entry.id === item.id)?.openDependencyCount;

    expect(openDeps()).toBe(1);
    expect(getItemDetail(handle.db, { itemId: item.id })?.dependsOn.map((entry) => entry.key)).toEqual([made.key]);

    finish(made.id);
    expect(openDeps()).toBe(0);
  });
});

describe("wait: created_waits", () => {
  it("holds the created item at its entry step until the originating item is finished", async () => {
    const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, wait: "created_waits" });`);
    const made = created(result.answer);

    expect(made.stepId).toBe(ENTRY);
    expect(waitsFor(made.id)).toEqual([item.id]);
    expect(waitsFor(item.id)).toEqual([]);
    expect(blocker(made.id)).toMatchObject({ kind: "open_dependency", wait: "finished" });
    expect(dispatched()).not.toContain(made.id);
    // The originating item is held by nothing.
    expect(dispatched()).toContain(item.id);

    finish(item.id);
    expect(dispatched()).toContain(made.id);
  });

  it("says on the new item that it waits for the originating one", async () => {
    const made = created((await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, wait: "created_waits" });`)).answer);

    expect(engineComments(made.id)).toEqual([`Created by **Release** (module) from its run on ${item.key}. It waits for ${item.key}.`]);
    expect(engineComments(item.id).join("\n")).not.toContain("waits for");
  });

  it("writes one edge where dependsOn names the originating item as well", async () => {
    const made = created((await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, wait: "created_waits", dependsOn: [${JSON.stringify(item.key)}] });`)).answer);
    expect(waitsFor(made.id)).toEqual([item.id]);
  });
});

describe("wait left out, or none", () => {
  it("adds no edge between the two and says nothing about waiting", async () => {
    const result = await run(`
      answer = [
        await ctx.createItem({ idempotencyKey: "a", ${STORY} }),
        await ctx.createItem({ idempotencyKey: "b", ${STORY}, wait: "none" }),
      ];
    `);
    (result.answer as unknown[]).map(created);

    expect(listAllDependencies(handle.db)).toEqual([]);
    expect(engineComments(item.id).join("\n")).not.toContain("waits for");
  });
});

describe("dependsOn", () => {
  it("leaves the new item depending on the items it names", async () => {
    const other = createTestItem(handle.db, { type: "story", title: "The API", stepId: "todo" });
    const made = created((await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, dependsOn: [${JSON.stringify(other.key)}, ${JSON.stringify(other.key)}] });`)).answer);

    expect(waitsFor(made.id)).toEqual([other.id]);
    expect(dispatched()).not.toContain(made.id);
    finish(other.id);
    expect(dispatched()).toContain(made.id);
  });

  it("refuses a key no item has, and one on another project, and creates nothing", async () => {
    const before = everyItem().length;

    const missing = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, dependsOn: ["EO-4040"] });`);
    expect(refused(missing.answer)).toContain("EO-4040 for this to depend on");
    expect(missing.transcript).toContain("EO did not create an item");

    const elsewhere = createProject(handle.db, { name: "Elsewhere", keyPrefix: "ELSE" });
    const foreign = createTestItem(handle.db, { type: "story", title: "Theirs", stepId: "todo", projectId: elsewhere.id });
    const other = await run(`answer = await ctx.createItem({ idempotencyKey: "b", ${STORY}, dependsOn: [${JSON.stringify(foreign.key)}] });`);
    expect(refused(other.answer)).toContain(`${foreign.key} is on a different project`);

    expect(everyItem()).toHaveLength(before + 1); // only the foreign item this test made
    expect(listAllDependencies(handle.db)).toEqual([]);
    expect(engineComments(item.id)).toEqual([]);
  });

  it("refuses a dependsOn that is not a list of keys", async () => {
    for (const bad of [`"EO-1"`, `[42]`, `[""]`]) {
      const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, dependsOn: ${bad} });`);
      expect(refused(result.answer)).toContain("dependsOn is a list of item keys");
    }
    expect(everyItem()).toHaveLength(1);
  });
});

describe("dependsOn with a rule (EO-777)", () => {
  /** The seeded Delivery's review step, by its name as a module would write it. */
  const review = () => getStep(handle.db, "review")!.name;

  it("takes { item, wait, step } beside a bare key, and stores the step's id", async () => {
    const api = createTestItem(handle.db, { type: "story", title: "The API", stepId: "todo" });
    const docs = createTestItem(handle.db, { type: "story", title: "The docs", stepId: "todo" });
    const made = created(
      (
        await run(
          `answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, dependsOn: [${JSON.stringify(docs.key)}, { item: ${JSON.stringify(api.key)}, wait: "reached", step: ${JSON.stringify(review())} }] });`,
        )
      ).answer,
    );

    const edges = listDependencies(handle.db, made.id);
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dependsOnId: docs.id, wait: "finished", waitStepId: null }),
        expect.objectContaining({ dependsOnId: api.id, wait: "reached", waitStepId: "review" }),
      ]),
    );
    // Released by the arrival, not by finishing.
    finish(docs.id);
    expect(dispatched()).not.toContain(made.id);
    transitionItem(handle.db, { itemId: api.id, toStepId: "review", actor: "human" });
    expect(dispatched()).toContain(made.id);
  });

  it("refuses a step not on the item's pipeline, naming the item and its steps, and creates nothing", async () => {
    const api = createTestItem(handle.db, { type: "story", title: "The API", stepId: "todo" });
    const before = everyItem().length;

    const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, dependsOn: [{ item: ${JSON.stringify(api.key)}, wait: "reached", step: "Deploy" }] });`);

    const reason = refused(result.answer);
    expect(reason).toContain(`${api.key}'s pipeline has no step "Deploy"`);
    expect(reason).toContain(`"${review()}"`);
    expect(everyItem()).toHaveLength(before);
    expect(listAllDependencies(handle.db)).toEqual([]);
  });

  it("refuses a step with wait: none, and an entry of the wrong shape, in the host before anything is sent", async () => {
    const api = createTestItem(handle.db, { type: "story", title: "The API", stepId: "todo" });

    const stepped = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, dependsOn: [{ item: ${JSON.stringify(api.key)}, wait: "none", step: ${JSON.stringify(review())} }] });`);
    expect(refused(stepped.answer)).toContain('A step goes only with wait: "reached"');

    for (const bad of [`[{ item: ${JSON.stringify(api.key)}, wait: "soon" }]`, `[{ key: ${JSON.stringify(api.key)}, wait: "none" }]`]) {
      const result = await run(`answer = await ctx.createItem({ idempotencyKey: "b", ${STORY}, dependsOn: ${bad} });`);
      expect(refused(result.answer)).toContain("or of { item, wait, step? }");
    }
    expect(listAllDependencies(handle.db)).toEqual([]);
  });

  it("refuses wait: created_waits beside a dependsOn naming the originating item with another rule, and creates nothing", async () => {
    const before = everyItem().length;

    for (const [index, entry] of [`{ item: ${JSON.stringify(item.key)}, wait: "reached", step: ${JSON.stringify(review())} }`, `{ item: ${JSON.stringify(item.key)}, wait: "none" }`].entries()) {
      const result = await run(`answer = await ctx.createItem({ idempotencyKey: "k${index}", ${STORY}, wait: "created_waits", dependsOn: [${entry}] });`);
      const reason = refused(result.answer);
      expect(reason).toContain(`wait: "created_waits" says the new item waits for ${item.key} to finish, and dependsOn names ${item.key} with wait: "${index === 0 ? "reached" : "none"}"`);
      expect(reason).toContain("nothing was created");
    }
    expect(everyItem()).toHaveLength(before);
    expect(listAllDependencies(handle.db)).toEqual([]);
    expect(engineComments(item.id)).toEqual([]);
  });

  it("refuses the same on a repeat, adding no edge to the item the first call made", async () => {
    const made = created((await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY} });`)).answer);

    const repeat = await run(
      `answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, wait: "created_waits", dependsOn: [{ item: ${JSON.stringify(item.key)}, wait: "reached", step: ${JSON.stringify(review())} }] });`,
    );

    expect(refused(repeat.answer)).toContain(`wait: "created_waits" says the new item waits for ${item.key} to finish`);
    expect(waitsFor(made.id)).toEqual([]);
  });
});

describe("a creation whose edges would be circular", () => {
  it("is refused with the items named by key, and leaves no new item and no new edge", async () => {
    // `blocked` already waits for the originating item. A new item that
    // waits for `blocked` while the originating item waits for the new
    // one closes the loop.
    const blocked = createTestItem(handle.db, { type: "story", title: "Waits for the release", stepId: "todo" });
    addDependency(handle.db, blocked.id, item.id);
    const itemsBefore = everyItem().map((entry) => entry.id);
    const edgesBefore = listAllDependencies(handle.db);

    const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, wait: "this_waits", dependsOn: [${JSON.stringify(blocked.key)}] });`);
    const reason = refused(result.answer);

    // In the words `addEdge` uses, with the item that does not exist
    // called what it is rather than given a key it will never have.
    expect(reason).toBe(
      `${item.key} cannot wait for the new item — that would make the dependencies circular: ${item.key} → the new item → ${blocked.key} → ${item.key}.`,
    );
    expect(result.transcript).toContain(reason);
    expect(everyItem().map((entry) => entry.id)).toEqual(itemsBefore);
    expect(listAllDependencies(handle.db)).toEqual(edgesBefore);
    expect(engineComments(item.id)).toEqual([]);

    // Nothing was spent on the refusal: the key the refused item would
    // have had goes to the next one, and the same idempotency key is free.
    const next = created((await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, wait: "this_waits" });`)).answer);
    expect(waitsFor(item.id)).toEqual([next.id]);
  });

  it("is refused where the new item would wait for the very item that waits for it", async () => {
    const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, wait: "this_waits", dependsOn: [${JSON.stringify(item.key)}] });`);

    expect(refused(result.answer)).toContain("that would make the dependencies circular");
    expect(everyItem()).toHaveLength(1);
    expect(listAllDependencies(handle.db)).toEqual([]);
  });
});

describe("a wait that is none of the three", () => {
  const REASON = 'wait is one of "none", "this_waits", "created_waits".';

  it("is refused with a reason naming them, and creates nothing", async () => {
    const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, wait: "both" });`);

    expect(refused(result.answer)).toBe(REASON);
    expect(result.transcript).toContain(REASON);
    expect(everyItem()).toHaveLength(1);
  });

  /**
   * Only leaving `wait` out means "none". A `null` is a value somebody
   * supplied, and reading it as "none" lets a module that meant to be
   * held run on.
   */
  it("refuses an explicit null as it refuses any other value", async () => {
    const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, wait: null });`);

    expect(refused(result.answer)).toBe(REASON);
    expect(result.transcript).toContain(REASON);
    expect(everyItem()).toHaveLength(1);

    // Left out, or undefined, is still the default.
    created((await run(`answer = await ctx.createItem({ idempotencyKey: "b", ${STORY}, wait: undefined });`)).answer);
    expect(listAllDependencies(handle.db)).toEqual([]);
  });

  it("refuses a null written straight to fd 3, and one that reaches the writer itself", async () => {
    const result = await run(`
      const { writeSync } = await import("node:fs");
      writeSync(3, JSON.stringify({ type: "create", id: "forged", creation: { idempotencyKey: "a", ${STORY}, wait: null } }) + "\\n");
      answer = true;
    `);
    expect(result.transcript).toContain(`EO did not create an item from ${item.key}: ${REASON}`);

    // Past both checks — what a record is sent by a device is a claim.
    const module = getModule(handle.db, save("answer = true;") as Uuid)!;
    const answer = postModuleCreation(
      handle.db,
      { module, item, runId: null },
      { idempotencyKey: "c", type: "story", title: "x", body: "", spec: { acceptance_criteria: ["y"] }, pipeline: "Delivery", wait: null as never },
    );
    expect(answer).toEqual({ created: false, reason: REASON });
    expect(everyItem()).toHaveLength(1);
  });

  it("is refused by the parent too, for an event written straight to fd 3", async () => {
    const result = await run(`
      const { writeSync } = await import("node:fs");
      writeSync(3, JSON.stringify({ type: "create", id: "forged", creation: { idempotencyKey: "a", ${STORY}, wait: "both" } }) + "\\n");
      writeSync(3, JSON.stringify({ type: "create", id: "forged", creation: { idempotencyKey: "b", ${STORY}, dependsOn: "EO-1" } }) + "\\n");
      answer = true;
    `);

    expect(result.transcript).toContain(`EO did not create an item from ${item.key}: ${REASON}`);
    expect(result.transcript).toContain("dependsOn is a list of item keys");
    expect(everyItem()).toHaveLength(1);
  });
});

describe("a repeat that names who waits", () => {
  it("leaves exactly one edge for each relationship it names", async () => {
    const other = createTestItem(handle.db, { type: "story", title: "The API", stepId: "todo" });
    const call = `await ctx.createItem({ idempotencyKey: "a", ${STORY}, wait: "this_waits", dependsOn: [${JSON.stringify(other.key)}] })`;

    const first = await run(`answer = [${call}, ${call}];`);
    const [one, two] = first.answer as { key: string }[];
    expect(two).toEqual({ created: true, key: one!.key, existing: true });
    const later = await run(`answer = ${call};`);
    expect(later.answer).toEqual({ created: true, key: one!.key, existing: true });

    const made = getItemByKey(handle.db, one!.key)!;
    expect(listAllDependencies(handle.db)).toHaveLength(2);
    expect(waitsFor(item.id)).toEqual([made.id]);
    expect(waitsFor(made.id)).toEqual([other.id]);
    // And a repeat still says nothing.
    expect(engineComments(item.id)).toHaveLength(1);
    expect(engineComments(made.id)).toHaveLength(1);
  });

  it("adds an edge the first call did not name, once", async () => {
    const made = created((await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY} });`)).answer);
    expect(listAllDependencies(handle.db)).toEqual([]);

    for (let again = 0; again < 2; again += 1) {
      const repeat = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, wait: "created_waits" });`);
      expect(repeat.answer).toEqual({ created: true, key: made.key, existing: true });
    }
    expect(listAllDependencies(handle.db)).toEqual([{ itemId: made.id, dependsOnId: item.id, wait: "finished", waitStepId: null }]);
  });

  it("is refused, and adds none of its edges, where one of them would be circular", async () => {
    const other = createTestItem(handle.db, { type: "story", title: "The API", stepId: "todo" });
    const made = created((await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, wait: "created_waits" });`)).answer);
    const edgesBefore = listAllDependencies(handle.db);

    // The new item already waits for the originating one; the repeat
    // asks for the reverse as well, after an edge that could be added.
    const repeat = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, wait: "this_waits", dependsOn: [${JSON.stringify(other.key)}] });`);

    const reason = refused(repeat.answer);
    expect(reason).toContain(`${item.key} cannot wait for ${made.key} — that would make the dependencies circular: `);
    expect(reason).toContain(`${item.key} → ${made.key}`);
    expect(listAllDependencies(handle.db)).toEqual(edgesBefore);
  });
});
