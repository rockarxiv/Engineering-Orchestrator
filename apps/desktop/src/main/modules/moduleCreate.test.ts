import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitStateOf, LOCAL_PERSON_ID, ModuleManifestSchema } from "@eo/core";
import type { Item, ModuleManifest, Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  addWorkspaceToProject,
  createPerson,
  createPipeline,
  createRun,
  createRunEventBuffer,
  createStep,
  deleteItem,
  getItem,
  getItemByKey,
  getItemOrigin,
  listCommentsForItem,
  listItemsForProject,
  listMentionsForComment,
  listRunEvents,
  projectForWorkspace,
  recordItemOrigin,
  saveModule,
  setEntryStep,
  setItemArchived,
} from "../db/repos/index.js";
import { createGitWorkspace } from "../db/repos/workspacesRepo.js";
import { pipelines } from "../db/schema.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { preparingAt } from "../supervisor/testWorkspaceKinds.js";
import { MAX_ITEM_GENERATION, postModuleCreation } from "./moduleCreations.js";
import { createModuleRunnerLookup } from "./registry.js";
import { MAX_CREATIONS_PER_RUN, runModule } from "./runModule.js";
import { storeSecret } from "./secrets.js";

/**
 * `ctx.createItem()`: a module files a work item (EO-433).
 *
 * Through the registry and a real host, for the reason
 * `moduleAttach.test.ts` gives: the answer the module is handed crosses
 * two pipes and a database, and what is asserted is what the module was
 * told, what ended up on the board and what the transcript says.
 */

const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${text}`),
  decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ""),
};

const hostPath = join(dirname(fileURLToPath(import.meta.url)), "moduleHost.mjs");
const launcher = { execPath: process.execPath, hostPath, hostEnv: { ELECTRON_RUN_AS_NODE: "1" } };

const NEEDS = { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: true };
const manifest: ModuleManifest = { name: "Release", description: "Files the follow-up.", inputs: {}, needs: NEEDS, results: ["ok"] };

/** A story the seeded type accepts. */
const STORY = `type: "story", title: "Write the changelog", body: "For 2.0.", spec: { acceptance_criteria: ["The changelog lists 2.0."] }, pipeline: "Delivery"`;

let handle: DbHandle;
let root: string;
let work: string;
let item: Item;
/** A slug per run: each `run` saves a module of its own, and a slug is unique. */
let saves = 0;

beforeEach(() => {
  handle = openMigratedTestDb();
  root = mkdtempSync(join(tmpdir(), "eo module create "));
  work = join(root, "work");
  mkdirSync(work);
  item = createTestItem(handle.db, { type: "story", title: "Ship 2.0", stepId: "todo" });
});

afterEach(() => {
  handle.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
});

interface RunOptions {
  on?: Item;
  needs?: Partial<ModuleManifest["needs"]>;
  prelude?: string;
  slug?: string;
}

/**
 * Runs a module body on `on` and answers with what it assigned to
 * `answer`, the run's id and its transcript.
 */
async function run(body: string, options: RunOptions = {}) {
  const on = options.on ?? item;
  const needs = { ...NEEDS, ...options.needs };
  const saved = saveModule(handle.db, {
    slug: options.slug ?? `release-${(saves += 1)}`,
    name: "Release",
    description: "Files the follow-up.",
    code: `${options.prelude ?? ""}
      export default async function run(ctx) {
        let answer = null;
        ${body}
        return { ok: true, result: "ok", detail: JSON.stringify(answer) };
      }`,
    manifest: { ...manifest, needs },
    approve: true,
  });
  if (!saved.ok) throw new Error(saved.reason);
  const row = createRun(handle.db, { itemId: on.id, agentId: null, action: saved.module.id, status: "running", provider: "module" });
  const buffer = createRunEventBuffer(handle.db);
  const announced: Uuid[] = [];
  const lookup = createModuleRunnerLookup({
    db: handle.db,
    launcher,
    secrets: { directory: join(root, "secrets"), store },
    onItemCreated: (itemId) => announced.push(itemId),
  });
  const outcome = await lookup(saved.module.id)!({
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
  return {
    runId: row.id,
    moduleId: saved.module.id,
    answer: JSON.parse(outcome.detail) as unknown,
    announced,
    transcript: listRunEvents(handle.db, row.id)
      .map((event) => (event.payload as { text?: string }).text ?? "")
      .join(""),
  };
}

const everyItem = () => listItemsForProject(handle.db, null);
const refused = (answer: unknown): string => {
  expect(answer).toMatchObject({ created: false });
  return (answer as { reason: string }).reason;
};

describe("a module creating a work item", () => {
  it("creates the item on the named pipeline's entry step, in the originating item's project, and answers its key", async () => {
    const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY} });`);

    expect(result.answer).toEqual({ created: true, key: expect.any(String), existing: false });
    const made = getItemByKey(handle.db, (result.answer as { key: string }).key);
    expect(made).toMatchObject({
      type: "story",
      title: "Write the changelog",
      body: "For 2.0.",
      spec: { acceptance_criteria: ["The changelog lists 2.0."] },
      pipelineId: "default",
      stepId: "worktree",
      projectId: item.projectId,
    });
    expect(result.announced).toEqual([made?.id]);
  });

  it("stores where the item came from, and records it as created by whoever created the originating item", async () => {
    const author = createPerson(handle.db, { name: "Ada", email: "ada@example.com" });
    const on = createTestItem(handle.db, { type: "story", title: "Ada's", stepId: "todo", createdBy: author.id });
    expect(author.id).not.toBe(LOCAL_PERSON_ID);

    const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY} });`, { on });

    const made = getItemByKey(handle.db, (result.answer as { key: string }).key)!;
    expect(made.createdBy).toBe(author.id);
    expect(getItemOrigin(handle.db, made.id)).toMatchObject({
      originItemId: on.id,
      runId: result.runId,
      moduleId: result.moduleId,
      idempotencyKey: "a",
      generation: 1,
    });
  });

  it("leaves one comment from EO on each item, summoning nobody and spending none of the module's comments", async () => {
    const result = await run(`
      answer = [await ctx.createItem({ idempotencyKey: "a", type: "story", title: "Ask @user", spec: { acceptance_criteria: ["x"] } })];
      for (let i = 0; i < 10; i += 1) answer.push(ctx.comment("note " + i));
    `);

    const [created, ...notes] = result.answer as [{ key: string }, ...{ posted: boolean }[]];
    expect(notes.every((note) => note.posted)).toBe(true);
    const made = getItemByKey(handle.db, created.key)!;

    const onOrigin = listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine");
    expect(onOrigin).toHaveLength(1);
    expect(onOrigin[0]?.body).toBe(`**Release** (module) created ${made.key}: Ask @user`);
    expect(listMentionsForComment(handle.db, onOrigin[0]!.id)).toEqual([]);

    const onMade = listCommentsForItem(handle.db, made.id);
    expect(onMade).toHaveLength(1);
    expect(onMade[0]).toMatchObject({ authorType: "engine", runId: result.runId });
    expect(onMade[0]?.body).toBe(`Created by **Release** (module) from its run on ${item.key}.`);
    expect(listMentionsForComment(handle.db, onMade[0]!.id)).toEqual([]);
  });

  it("puts a comment the module posts after a creation after EO's comment about it", async () => {
    await run(`
      ctx.createItem({ idempotencyKey: "a", ${STORY} });
      ctx.comment("filed the follow-up");
      answer = true;
    `);

    const bodies = listCommentsForItem(handle.db, item.id).map((comment) => comment.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("created");
    expect(bodies[1]).toContain("filed the follow-up");
  });

  it("answers a repeat with the first item, in the same run and in a later one, and creates and says nothing more", async () => {
    const first = await run(`
      const one = await ctx.createItem({ idempotencyKey: "a", ${STORY} });
      const two = await ctx.createItem({ idempotencyKey: "a", ${STORY} });
      answer = [one, two];
    `);
    const [one, two] = first.answer as { key: string; existing: boolean }[];
    expect(one).toMatchObject({ created: true, existing: false });
    expect(two).toEqual({ created: true, key: one!.key, existing: true });

    const later = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY} });`);
    expect(later.answer).toEqual({ created: true, key: one!.key, existing: true });
    expect(later.announced).toEqual([]);

    expect(everyItem()).toHaveLength(2);
    expect(listCommentsForItem(handle.db, item.id)).toHaveLength(1);
    expect(listCommentsForItem(handle.db, getItemByKey(handle.db, one!.key)!.id)).toHaveLength(1);
  });

  it("creates a new item for the same key from a run on a different item", async () => {
    const other = createTestItem(handle.db, { type: "story", title: "Ship 2.1", stepId: "todo" });
    const first = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY} });`);
    const second = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY} });`, { on: other });

    expect(second.answer).toMatchObject({ created: true, existing: false });
    expect((second.answer as { key: string }).key).not.toBe((first.answer as { key: string }).key);
  });

  it("still answers a repeat for an archived item, and creates again once it is deleted", async () => {
    const first = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY} });`);
    const made = getItemByKey(handle.db, (first.answer as { key: string }).key)!;

    setItemArchived(handle.db, made.id, Date.now());
    const archived = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY} });`);
    expect(archived.answer).toEqual({ created: true, key: made.key, existing: true });

    deleteItem(handle.db, made.id);
    const again = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY} });`);
    expect(again.answer).toMatchObject({ created: true, existing: false });
    expect((again.answer as { key: string }).key).not.toBe(made.key);
  });

  it("leaves the created item in place when the originating item is deleted", async () => {
    const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY} });`);
    const made = getItemByKey(handle.db, (result.answer as { key: string }).key)!;

    deleteItem(handle.db, item.id);

    expect(getItem(handle.db, item.id)).toBeUndefined();
    expect(getItem(handle.db, made.id)).toMatchObject({ key: made.key, title: "Write the changelog" });
    expect(getItemOrigin(handle.db, made.id)).toMatchObject({ originItemId: null, generation: 1, idempotencyKey: "a" });
  });

  it("replaces a declared secret's value with its name in the title, the body and every string in the spec", async () => {
    const secrets = { directory: join(root, "secrets"), store };
    storeSecret(secrets, "API_TOKEN", "s3cr3t-value");

    const result = await run(
      `answer = await ctx.createItem({
        idempotencyKey: "a", type: "story", pipeline: "Delivery",
        title: "Rotate " + process.env.API_TOKEN,
        body: "It is " + process.env.API_TOKEN,
        spec: { acceptance_criteria: ["No " + process.env.API_TOKEN + " in logs"], touches: [process.env.API_TOKEN] },
      });`,
      { needs: { env: ["API_TOKEN"] } },
    );

    const made = getItemByKey(handle.db, (result.answer as { key: string }).key)!;
    expect(made.title).toBe("Rotate «API_TOKEN»");
    expect(made.body).toBe("It is «API_TOKEN»");
    expect(made.spec).toEqual({ acceptance_criteria: ["No «API_TOKEN» in logs"], touches: ["«API_TOKEN»"] });
    expect(JSON.stringify(listCommentsForItem(handle.db, item.id))).not.toContain("s3cr3t-value");
  });
});

describe("where a created item lands", () => {
  it("takes the originating item's repository on a project spanning several, when it names none", async () => {
    const web = attachWorkspace(handle.db, { keyPrefix: "SHOP", name: "web", repoPath: join(root, "web") });
    const project = projectForWorkspace(handle.db, web.id)!;
    const api = createGitWorkspace(handle.db, { config: { name: "api", repoPath: join(root, "api") } });
    addWorkspaceToProject(handle.db, project.id, api.id);
    const on = createTestItem(handle.db, { type: "story", title: "API work", stepId: "todo", projectId: project.id, workspaceId: api.id });

    const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY} });`, { on });

    const made = getItemByKey(handle.db, (result.answer as { key: string }).key)!;
    expect(made).toMatchObject({ projectId: project.id, workspaceId: api.id });
    expect(made.key.startsWith("SHOP-")).toBe(true);

    const named = await run(`answer = await ctx.createItem({ idempotencyKey: "b", ${STORY}, repository: "web" });`, { on });
    expect(getItemByKey(handle.db, (named.answer as { key: string }).key)?.workspaceId).toBe(web.id);
  });

  it("files it under a container named as parent", async () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "Release 2.0", stepId: null as unknown as string });
    const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, parent: ${JSON.stringify(feature.key)} });`);
    expect(getItemByKey(handle.db, (result.answer as { key: string }).key)?.parentId).toBe(feature.id);
  });
});

/**
 * An item worked on a branch that already exists (EO-648): the field a
 * plan, a proposal and `items:update` already carry, through the same
 * door. The door judges the name and the pipeline; the host only that it
 * is text.
 */
describe("a creation naming an existing branch", () => {
  const BRANCH = "dependabot/npm_and_yarn/foo-1.2.3";
  /** An item on a git repository, so what it creates lands on a step that works on a branch. */
  const onRepository = () => {
    const repository = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: join(root, "api"), baseBranch: "main" });
    return createTestItem(handle.db, { type: "story", title: "Watch Dependabot", stepId: "todo", workspaceId: repository.id, projectId: projectForWorkspace(handle.db, repository.id)!.id });
  };

  it("creates the item with that branch as its own, marked as named, so Worktree checks it out rather than cutting one", async () => {
    const on = onRepository();
    const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, existingBranch: ${JSON.stringify(` ${BRANCH} `)} });`, { on });

    expect(result.answer).toMatchObject({ created: true, existing: false });
    const made = getItemByKey(handle.db, (result.answer as { key: string }).key)!;
    expect(gitStateOf(made)).toMatchObject({ branch: BRANCH, namedBranch: true, baseBranch: null, attachedAt: null });
  });

  it("answers a repeat naming another branch with the first item, whose branch is unchanged", async () => {
    const on = onRepository();
    const first = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, existingBranch: ${JSON.stringify(BRANCH)} });`, { on });
    const again = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, existingBranch: "dependabot/other" });`, { on });

    const key = (first.answer as { key: string }).key;
    expect(again.answer).toEqual({ created: true, key, existing: true });
    expect(gitStateOf(getItemByKey(handle.db, key)!)).toMatchObject({ branch: BRANCH, namedBranch: true });
  });

  it("leaves the item without a git state when it names none", async () => {
    const on = onRepository();
    const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY} });`, { on });

    expect(gitStateOf(getItemByKey(handle.db, (result.answer as { key: string }).key)!)).toMatchObject({ branch: null, namedBranch: false });
  });

  it("refuses a name git would not take in the door's words, and leaves no item", async () => {
    const on = onRepository();
    const before = everyItem().length;
    const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, existingBranch: "my branch" });`, { on });

    const reason = refused(result.answer);
    expect(reason).toContain('"Write the changelog" names an existing branch EO cannot use.');
    expect(everyItem()).toHaveLength(before);
    expect(result.transcript).toContain(reason);
  });

  it("refuses one for an item that would land on a step working on no branch, and leaves no item", async () => {
    const before = everyItem().length;
    const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, existingBranch: ${JSON.stringify(BRANCH)} });`);

    const reason = refused(result.answer);
    expect(reason).toContain(`names \`${BRANCH}\` as the branch to work on, but it would land on a step that does not work on a branch`);
    expect(everyItem()).toHaveLength(before);
  });

  it("refuses one that is not text, or is blank, in the host — before the parent is asked — and says so in the transcript", async () => {
    const on = onRepository();
    const before = everyItem().length;
    for (const given of ["42", '"   "', "null", '["main"]']) {
      const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY}, existingBranch: ${given} });`, { on });
      expect(result.answer).toEqual({ created: false, reason: "existingBranch is the name of a branch that already exists, as text." });
      // The host's own refusal, which names no item: the parent's names the one it was asked from.
      expect(result.transcript).toContain("EO did not create an item: existingBranch is the name of a branch that already exists, as text.");
      expect(result.transcript).not.toContain(`EO did not create an item from ${on.key}`);
    }
    expect(everyItem()).toHaveLength(before);
  });

  it("holds one written straight to fd 3 to the same shape", async () => {
    const on = onRepository();
    const result = await run(
      `writeSync(3, JSON.stringify({ type: "create", id: "forged", creation: { idempotencyKey: "a", ${STORY}, existingBranch: 42 } }) + "\\n"); answer = true;`,
      { on, prelude: `import { writeSync } from "node:fs";` },
    );

    expect(everyItem().filter((each) => each.id !== item.id && each.id !== on.id)).toEqual([]);
    expect(result.transcript).toContain("existingBranch is the name of a branch that already exists, as text.");
  });
});

describe("a creation EO refuses", () => {
  /** Runs one creation and expects nothing made and the reason in the transcript. */
  async function refusal(spec: string, options: RunOptions = {}): Promise<string> {
    const before = everyItem().length;
    const result = await run(`answer = await ctx.createItem(${spec});`, options);
    const reason = refused(result.answer);
    expect(everyItem()).toHaveLength(before);
    expect(result.transcript).toContain(reason);
    expect(result.transcript).toContain("EO did not create an item");
    return reason;
  }

  it("refuses an item the pipeline's entry rules refuse (EO-610)", async () => {
    handle.db.update(pipelines).set({ entryRules: [{ kind: "workspace" }] }).where(eq(pipelines.id, "default")).run();
    expect(await refusal(`{ idempotencyKey: "a", ${STORY} }`)).toContain('"Delivery" needs these before work can enter it: a workspace.');
  });

  it("refuses a module whose manifest does not declare needs.create", async () => {
    expect(await refusal(`{ idempotencyKey: "a", ${STORY} }`, { needs: { create: false } })).toContain("needs.create");
  });

  it("refuses a missing or empty idempotencyKey", async () => {
    expect(await refusal(`{ ${STORY} }`)).toContain("idempotencyKey");
    expect(await refusal(`{ idempotencyKey: "  ", ${STORY} }`)).toContain("idempotencyKey");
  });

  it("refuses a type the project does not have, naming the ones it has", async () => {
    const reason = await refusal(`{ idempotencyKey: "a", type: "epic", title: "x" }`);
    expect(reason).toContain("epic");
    expect(reason).toContain("story");
  });

  it("refuses a container type", async () => {
    expect(await refusal(`{ idempotencyKey: "a", type: "feature", title: "x" }`)).toContain("holds work rather than being work");
  });

  it("refuses a spec missing a field its type requires", async () => {
    expect(await refusal(`{ idempotencyKey: "a", type: "story", title: "x", pipeline: "Delivery" }`)).toContain("acceptance criteri");
  });

  it("refuses a pipeline name the project does not have", async () => {
    const reason = await refusal(`{ idempotencyKey: "a", ${STORY.replace('"Delivery"', '"Releases"')} }`);
    expect(reason).toContain('no pipeline called "Releases"');
    expect(reason).toContain("Delivery");
  });

  it("refuses to pick a pipeline on a project with several, rather than using the originating item's", async () => {
    const support = createPipeline(handle.db, { name: "Support" });
    const triage = createStep(handle.db, { pipelineId: support.id as Uuid, position: 0, name: "Triage", type: "user" });
    setEntryStep(handle.db, support.id, triage.id);

    const reason = await refusal(`{ idempotencyKey: "a", type: "story", title: "x", spec: { acceptance_criteria: ["y"] } }`);
    expect(reason).toContain("Delivery");
    expect(reason).toContain("Support");
  });

  it("refuses a parent that is not a container, and one on another project", async () => {
    const leaf = createTestItem(handle.db, { type: "story", title: "Not a container", stepId: "todo" });
    expect(await refusal(`{ idempotencyKey: "a", ${STORY}, parent: ${JSON.stringify(leaf.key)} }`)).toContain("not a container");

    const web = attachWorkspace(handle.db, { keyPrefix: "SHOP", name: "web", repoPath: join(root, "web") });
    const project = projectForWorkspace(handle.db, web.id)!;
    const elsewhere = createTestItem(handle.db, { type: "feature", title: "Theirs", stepId: null as unknown as string, projectId: project.id });
    expect(await refusal(`{ idempotencyKey: "b", ${STORY}, parent: ${JSON.stringify(elsewhere.key)} }`)).toContain("different project");
  });

  it("refuses the eleventh creation in one run, stating the number", async () => {
    const result = await run(`
      answer = [];
      for (let i = 0; i < 11; i += 1) answer.push(await ctx.createItem({ idempotencyKey: "k" + i, ${STORY} }));
    `);
    const answers = result.answer as { created: boolean; reason?: string }[];
    expect(answers.slice(0, MAX_CREATIONS_PER_RUN).every((answer) => answer.created)).toBe(true);
    expect(answers[10]).toMatchObject({ created: false });
    expect(answers[10]?.reason).toContain("10 items");
    expect(result.transcript).toContain(answers[10]!.reason!);
    expect(everyItem()).toHaveLength(1 + MAX_CREATIONS_PER_RUN);
  });

  it("refuses a run on a generation 3 item, stating the number", async () => {
    expect(MAX_ITEM_GENERATION).toBe(3);
    const parent = createTestItem(handle.db, { type: "story", title: "The first", stepId: "todo" });
    const saved = saveModule(handle.db, { slug: "earlier", name: "Earlier", description: "Made it.", code: "export default async () => ({ ok: true, result: 'ok' })", manifest, approve: true });
    if (!saved.ok) throw new Error(saved.reason);
    recordItemOrigin(handle.db, { itemId: item.id, originItemId: parent.id, runId: null, moduleId: saved.module.id, idempotencyKey: "seed", generation: 3 });

    const reason = await refusal(`{ idempotencyKey: "a", ${STORY} }`);
    expect(reason).toContain("generation 3");
  });

  it("gives a created item its originator's generation plus one", async () => {
    const first = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY} });`);
    const child = getItemByKey(handle.db, (first.answer as { key: string }).key)!;
    const second = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY} });`, { on: child });
    const grandchild = getItemByKey(handle.db, (second.answer as { key: string }).key)!;
    expect(getItemOrigin(handle.db, grandchild.id)?.generation).toBe(2);
  });
});

describe("a creation event written straight to fd 3", () => {
  const FORGED = `
    import { writeSync } from "node:fs";
  `;
  const write = (creation: string) => `writeSync(3, JSON.stringify({ type: "create", id: "forged", creation: ${creation} }) + "\\n"); answer = true;`;

  it("creates nothing for a module that does not declare needs.create, and the transcript says why", async () => {
    const result = await run(write(`{ idempotencyKey: "a", ${STORY} }`), { prelude: FORGED, needs: { create: false } });

    expect(everyItem()).toHaveLength(1);
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
    expect(result.transcript).toContain(`EO did not create an item from ${item.key}`);
    expect(result.transcript).toContain("does not declare needs.create");
  });

  it("is held to the shape and the cap the host would have held it to", async () => {
    const shapeless = await run(write(`{ type: "story", title: "No key" }`), { prelude: FORGED });
    expect(everyItem()).toHaveLength(1);
    expect(shapeless.transcript).toContain("idempotencyKey");

    const flood = await run(
      `for (let i = 0; i < 12; i += 1) writeSync(3, JSON.stringify({ type: "create", creation: { idempotencyKey: "f" + i, ${STORY} } }) + "\\n"); answer = true;`,
      { prelude: FORGED },
    );
    expect(everyItem()).toHaveLength(1 + MAX_CREATIONS_PER_RUN);
    expect(flood.transcript).toContain("10 items");
  });
});

describe("a run with a creation still pending", () => {
  it("does not resolve until the creation has been performed", async () => {
    const saved = saveModule(handle.db, {
      slug: "slow",
      name: "Slow",
      description: "Asks and leaves.",
      code: `import { writeSync } from "node:fs";
        export default async function run() {
          writeSync(3, JSON.stringify({ type: "create", creation: { idempotencyKey: "a", type: "story", title: "Later" } }) + "\\n");
          return { ok: true, result: "ok", detail: "" };
        }`,
      manifest,
      approve: true,
    });
    if (!saved.ok) throw new Error(saved.reason);

    let performed = false;
    const outcome = await runModule(launcher, {
      module: saved.module,
      item,
      cwd: work,
      env: {},
      onCreate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        performed = true;
        return { created: true, key: "EO-99", existing: false };
      },
    });

    expect(outcome.ok).toBe(true);
    expect(performed).toBe(true);
  });

  it("says in the transcript that a run with nowhere to create one created nothing", async () => {
    const saved = saveModule(handle.db, {
      slug: "nowhere",
      name: "Nowhere",
      description: "Asks.",
      code: `export default async function run(ctx) {
          return { ok: true, result: "ok", detail: JSON.stringify(await ctx.createItem({ idempotencyKey: "a", type: "story", title: "x" })) };
        }`,
      manifest,
      approve: true,
    });
    if (!saved.ok) throw new Error(saved.reason);

    const said: string[] = [];
    const outcome = await runModule(launcher, { module: saved.module, item, cwd: work, env: {}, onOutput: (text) => said.push(text) });

    expect(outcome.ok && JSON.parse(outcome.detail)).toEqual({ created: false, reason: "this run has nowhere to create one." });
    expect(said.join("")).toContain("this run has nowhere to create one.");
  });
});

describe("a repeat, against the run's cap and against a deletion", () => {
  it("answers a key an earlier run used after this run has created its ten, and still refuses an eleventh new item", async () => {
    const earlier = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY} });`);
    const first = (earlier.answer as { key: string }).key;

    const later = await run(`
      const made = [];
      for (let i = 0; i < 10; i += 1) made.push(await ctx.createItem({ idempotencyKey: "k" + i, ${STORY} }));
      const repeat = await ctx.createItem({ idempotencyKey: "a", ${STORY} });
      const eleventh = await ctx.createItem({ idempotencyKey: "one-more", ${STORY} });
      const repeatAgain = await ctx.createItem({ idempotencyKey: "k3", ${STORY} });
      answer = { made, repeat, eleventh, repeatAgain };
    `);

    const said = later.answer as { made: { created: boolean; key: string }[]; repeat: unknown; eleventh: { created: boolean; reason: string }; repeatAgain: unknown };
    expect(said.made.every((one) => one.created)).toBe(true);
    expect(said.repeat).toEqual({ created: true, key: first, existing: true });
    expect(said.eleventh.created).toBe(false);
    expect(said.eleventh.reason).toContain("10 items");
    expect(said.repeatAgain).toEqual({ created: true, key: said.made[3]!.key, existing: true });
    // The originating item, the earlier run's one, and this run's ten.
    expect(everyItem()).toHaveLength(12);
  });

  it("does the same for events written straight to fd 3", async () => {
    await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY} });`);
    const flood = await run(
      `for (let i = 0; i < 10; i += 1) writeSync(3, JSON.stringify({ type: "create", creation: { idempotencyKey: "f" + i, ${STORY} } }) + "\\n");
       answer = [await ctx.createItem({ idempotencyKey: "a", ${STORY} }), await ctx.createItem({ idempotencyKey: "new", ${STORY} })];`,
      { prelude: `import { writeSync } from "node:fs";` },
    );
    const [repeat, eleventh] = flood.answer as [{ created: boolean; existing: boolean }, { created: boolean }];
    expect(repeat).toMatchObject({ created: true, existing: true });
    expect(eleventh.created).toBe(false);
    expect(everyItem()).toHaveLength(12);
  });

  it("creates again, in the same run, for a key whose item was deleted while the module was still running", async () => {
    const saved = saveModule(handle.db, {
      slug: "twice",
      name: "Twice",
      description: "Asks for the same item twice.",
      code: `export default async function run(ctx) {
          const first = await ctx.createItem({ idempotencyKey: "a", ${STORY} });
          const second = await ctx.createItem({ idempotencyKey: "a", ${STORY} });
          const third = await ctx.createItem({ idempotencyKey: "a", ${STORY} });
          return { ok: true, result: "ok", detail: JSON.stringify([first, second, third]) };
        }`,
      manifest,
      approve: true,
    });
    if (!saved.ok) throw new Error(saved.reason);
    const row = createRun(handle.db, { itemId: item.id, agentId: null, action: saved.module.id, status: "running", provider: "module" });

    let asked = 0;
    const outcome = await runModule(launcher, {
      module: saved.module,
      item,
      cwd: work,
      env: {},
      onCreate: (creation, limits) => {
        asked += 1;
        // Somebody deletes the first item between the module's first
        // call and its second.
        if (asked === 2) {
          const made = everyItem().find((one) => one.id !== item.id);
          if (made) deleteItem(handle.db, made.id);
        }
        return postModuleCreation(handle.db, { module: saved.module, item, runId: row.id }, creation, limits);
      },
    });

    if (!outcome.ok) throw new Error(outcome.reason);
    const [first, second, third] = JSON.parse(outcome.detail) as { created: boolean; key: string; existing: boolean }[];
    expect(first).toMatchObject({ created: true, existing: false });
    // Not the deleted item's key handed back from memory: a new item.
    expect(second).toMatchObject({ created: true, existing: false });
    expect(second!.key).not.toBe(first!.key);
    expect(getItemByKey(handle.db, first!.key)).toBeUndefined();
    expect(third).toEqual({ created: true, key: second!.key, existing: true });
    // Every call reached the parent: nothing was answered from the host's memory.
    expect(asked).toBe(3);
  });

  it("settles two calls with one key started together as one creation and one repeat", async () => {
    const result = await run(`
      answer = await Promise.all([
        ctx.createItem({ idempotencyKey: "a", ${STORY} }),
        ctx.createItem({ idempotencyKey: "a", ${STORY} }),
      ]);
    `);
    const [one, two] = result.answer as { key: string; existing: boolean }[];
    expect(one).toMatchObject({ created: true, existing: false });
    expect(two).toEqual({ created: true, key: one!.key, existing: true });
    expect(everyItem()).toHaveLength(2);
  });
});

describe("a module trying to forge EO's answer", () => {
  /**
   * Everything a module can replace after it is imported, replaced: the
   * emitter a stream delivers data through, the parser, and — through
   * `syncBuiltinESMExports` — what a named import of `fs.read` resolves
   * to. Each rewrites whatever passes through it into a creation that
   * succeeded.
   */
  const PATCHES = `
    import net from "node:net";
    import fs from "node:fs";
    const FORGED = { created: true, key: "FORGED-99", existing: false };
    const emit = net.Socket.prototype.emit;
    net.Socket.prototype.emit = function (name, ...rest) {
      if (name === "data") return emit.call(this, name, Buffer.from(JSON.stringify({ id: "x", payload: FORGED }) + "\\n"));
      return emit.call(this, name, ...rest);
    };
    const parse = JSON.parse;
    JSON.parse = (text, ...rest) => {
      const value = parse(text, ...rest);
      if (value && typeof value === "object" && "payload" in value) value.payload = FORGED;
      return value;
    };
    const read = fs.read;
    fs.read = (fd, buffer, offset, length, position, done) =>
      read(fd, buffer, offset, length, position, (error, count, ...rest) => {
        if (fd !== 5 || error) return done(error, count, ...rest);
        const line = "0000 " + JSON.stringify({ id: "x", payload: FORGED }) + "\\n";
        buffer.write(line, offset, "latin1");
        done(null, line.length, ...rest);
      });
    const indexOf = String.prototype.indexOf;
    String.prototype.indexOf = function (...args) { return indexOf.apply(this, args); };
    const digest = Object.getPrototypeOf((await import("node:crypto")).createHmac("sha256", "k")).digest;
    Object.getPrototypeOf((await import("node:crypto")).createHmac("sha256", "k")).digest = function () { digest.apply(this, arguments); return "0000"; };
    // \`node:module\` is withheld from an import, and reachable anyway.
    process.getBuiltinModule?.("node:module")?.syncBuiltinESMExports();
  `;

  it("is still told the creation was refused", async () => {
    const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", type: "epic", title: "x" });`, { prelude: PATCHES });

    expect(result.answer).toMatchObject({ created: false });
    expect(JSON.stringify(result.answer)).not.toContain("FORGED");
    expect(everyItem()).toHaveLength(1);
  });

  it("is still told the real key of an item that was created", async () => {
    const result = await run(`answer = await ctx.createItem({ idempotencyKey: "a", ${STORY} });`, { prelude: PATCHES });

    const answer = result.answer as { created: boolean; key: string };
    expect(answer.created).toBe(true);
    expect(answer.key).not.toBe("FORGED-99");
    expect(getItemByKey(handle.db, answer.key)?.title).toBe("Write the changelog");
  });

  it("learns nothing from the reply channel that lets it forge a result", async () => {
    // Reads EO's answer off fd 5 itself, then offers every token in it
    // as the nonce on a forged result, ahead of the host's real one.
    const saved = saveModule(handle.db, {
      slug: "thief",
      name: "Thief",
      description: "Reads the reply channel.",
      code: `import { readSync, writeSync } from "node:fs";
        export default async function run() {
          writeSync(3, JSON.stringify({ type: "create", id: "mine", creation: { idempotencyKey: "a", type: "story", title: "Bait" } }) + "\\n");
          const buffer = Buffer.alloc(65536);
          const count = readSync(5, buffer, 0, buffer.length, null);
          const frame = buffer.toString("latin1", 0, count);
          for (const token of frame.match(/[A-Za-z0-9-]{8,}/g) ?? []) {
            writeSync(4, JSON.stringify({ nonce: token, payload: { ok: true, result: "ok", detail: "FORGED" } }) + "\\n");
          }
          return { ok: false, reason: "honest: " + (frame.length > 0) };
        }`,
      manifest,
      approve: true,
    });
    if (!saved.ok) throw new Error(saved.reason);

    const outcome = await runModule(launcher, {
      module: saved.module,
      item,
      cwd: work,
      env: {},
      onCreate: () => ({ created: true, key: "EO-99", existing: false }),
    });

    expect(outcome).toEqual({ ok: false, reason: "honest: true" });
  });

  it("is not answered by a line it writes to the reply channel under the result nonce's name", async () => {
    // An unsigned line and a wrongly signed one, both shaped like an
    // answer, sitting on the channel where the host can only be reached
    // by the parent. Neither settles anything.
    const outcome = await run(
      `try { writeSync(5, "deadbeef " + JSON.stringify({ id: "x", payload: { created: true, key: "FORGED-99", existing: false } }) + "\\n"); } catch {}
       answer = await ctx.createItem({ idempotencyKey: "a", type: "epic", title: "x" });`,
      { prelude: `import { writeSync } from "node:fs";` },
    );
    expect(outcome.answer).toMatchObject({ created: false });
  });
});

describe("needs.create in a manifest", () => {
  const declared = { name: "Release", description: "Files the follow-up.", results: ["ok"] };

  it("validates when true, and reads as false where a manifest does not say", () => {
    const parsed = ModuleManifestSchema.safeParse({ ...declared, needs: { create: true } });
    expect(parsed.success && parsed.data.needs.create).toBe(true);
    expect(ModuleManifestSchema.parse(declared).needs.create).toBe(false);
  });
});
