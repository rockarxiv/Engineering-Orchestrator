import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import { join } from "node:path";
import { AssistOutputSchema, PipelineExportSchema, pageDescriptorFor, type AssistReply, type IpcChannel, type IpcResponse, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { markReplica } from "../db/recordRole.js";
import {
  createPipeline,
  createProject,
  createRoute,
  createRun,
  createStep,
  currentVersion,
  getItem,
  getPipeline,
  isDiverged,
  listAttachmentsForItem,
  listCommentsForItem,
  listModules,
  listPipelines,
  listProjects,
  listStepsForPipeline,
  markDiverged,
  publishSection,
  saveModule,
  setEntryStep,
  setSetting,
  updateRun,
} from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { TOOLS } from "../mcpHost/catalog.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { fakePlatform } from "../testing/platform.js";
import { savePipeline } from "./configCommands.js";
import { listPipelineStepViews } from "./domainQueries.js";
import { ACTIVE_PROJECT_KEY } from "./repositoryCommands.js";
import { PIPELINE_NEEDS_PROJECT } from "./pipelineHome.js";
import { clearHandlerRegistry, dispatchIpc } from "./registry.js";

/**
 * Export, import, delete and discard local edits, through the
 * assistant's cards (EO-521).
 *
 * The editor is going, and these four were things only it could do. The
 * claim is that the assistant applies none of them: it returns a card,
 * and the card's button carries the thing out through the channel the
 * editor called. So every test here drives the app's own handlers, wired
 * the way the app wires them against a machine with nobody at it — the
 * save dialog answers with a path chosen here — and asserts against the
 * rows and the file, not against what a card says.
 */

let handle: DbHandle;
let scratch: string;
let userData: string;
/** Where the save dialog says the person chose, or null for a dialog they closed. */
let chosenPath: string | null;
const saveFile = vi.fn(() => Promise.resolve(chosenPath));

beforeEach(async () => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo cards "));
  chosenPath = join(scratch, "Default.eo-pipeline.json");
  saveFile.mockClear();
  const platform = fakePlatform({ saveFile });
  userData = platform.userDataPath;
  const { registerAllHandlers } = await import("./handlers.js");
  registerAllHandlers(handle.db, undefined, { platform });
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

/** A channel's answer, as the renderer would get it — or the test fails with the refusal. */
async function call<K extends IpcChannel>(channel: K, payload: unknown): Promise<IpcResponse<K>> {
  const answer = await dispatchIpc(channel, payload);
  if (!answer.ok) throw new Error(`${channel} refused: ${answer.error.message}`);
  return answer.data as IpcResponse<K>;
}

/** The assistant's chat, after somebody said something in it — with files attached, when given. */
async function chat(body = "Can you do that?", files: { name: string; text: string }[] = []): Promise<Item> {
  const attachmentIds: string[] = [];
  for (const file of files) {
    const staged = await call("attachments:stage", { name: file.name, dataBase64: Buffer.from(file.text).toString("base64") });
    attachmentIds.push(staged.attachment.id);
  }
  const sent = await call("assist:send", { page: pageDescriptorFor("/settings"), conversationId: null, body, attachmentIds, interrupt: false });
  return getItem(handle.db, sent.conversation.id as Uuid)!;
}

/** A succeeded `assist` run carrying `output`, and what it posted. */
function turn(conversation: Item, output: AssistReply): { cardIds: Uuid[]; rejections: string[] } {
  const parsed = AssistOutputSchema.parse(output);
  const agent = assistAgent(handle.db)!;
  const initiationId = listCommentsForItem(handle.db, conversation.id)
    .filter((comment) => comment.authorType === "human" && comment.parentId === null)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .at(-1)!.id;
  const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION, initiationId });
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(output), parsed: output } });
  postAssistReply(handle.db, conversation, agent.id, run.id, parsed);
  const posted = listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.runId === run.id);
  return {
    cardIds: posted.filter((comment) => comment.kind === PROPOSAL_KIND).map((comment) => comment.id),
    rejections: posted.filter((comment) => comment.kind === "rejection").map((comment) => comment.body),
  };
}

async function messageOf(conversation: Item, id: string) {
  const view = await call("assist:open", undefined);
  expect(view.conversation.id).toBe(conversation.id);
  return view.conversation.messages.find((message) => message.id === id)!;
}

const press = (conversation: Item, messageId: string, choices: Record<string, "reuse" | "import"> = {}) =>
  call("assist:applyCard", { conversationId: conversation.id, messageId, choices });
const read = (conversation: Item, messageId: string) => call("assist:card", { conversationId: conversation.id, messageId });

/** A pipeline whose first step runs a module — so a document of it carries one, and importing it back collides. */
function shippingPipeline(projectId: Uuid | null = null): string {
  const saved = saveModule(handle.db, {
    slug: "deploy",
    name: "Deploy",
    description: "Deploys the branch.",
    code: "export default async function run() { return { ok: true, result: 'deployed', detail: '' }; }",
    manifest: { name: "Deploy", description: "Deploys the branch.", inputs: {}, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false }, results: ["deployed"] },
    approve: true,
  });
  if (!saved.ok) throw new Error(saved.reason);
  const pipeline = createPipeline(handle.db, { name: "Shipping", projectId });
  createStep(handle.db, { id: "ship-deploy", pipelineId: pipeline.id, position: 0, name: "Deploy", type: "module", entryAction: saved.module.id });
  createStep(handle.db, { id: "ship-done", pipelineId: pipeline.id, position: 1, name: "Done", type: "user", isTerminal: true });
  createRoute(handle.db, { pipelineId: pipeline.id, fromStepId: "ship-deploy", resultKey: "deployed", label: "Deployed", target: "ship-done" });
  setEntryStep(handle.db, pipeline.id, "ship-deploy");
  return pipeline.id;
}

describe("a card is the assistant's whole part", () => {
  it("is posted as a card naming what it is for, with nothing done", async () => {
    const conversation = await chat("Delete the default pipeline.");

    const { cardIds, rejections } = turn(conversation, { message: "That one is yours to press.", card: { kind: "pipelineDelete", pipelineId: "default" } });

    expect(rejections).toEqual([]);
    expect(cardIds).toHaveLength(1);
    const card = await messageOf(conversation, cardIds[0]!);
    expect(card).toMatchObject({ canApprove: true, approves: "card", card: { kind: "pipelineDelete", outcome: null } });
    expect(card.body).toContain("**Delete**");
    expect(getPipeline(handle.db, "default")?.archivedAt).toBeNull();
  });

  it("is refused as work: the approve channel sends it back to its own button", async () => {
    const conversation = await chat();
    const { cardIds } = turn(conversation, { message: "Here.", card: { kind: "pipelineExport", pipelineId: "default" } });

    const approved = await call("assist:approve", { conversationId: conversation.id, messageId: cardIds[0]! });

    expect(approved.applied).toBe(false);
    expect(approved.problem).toContain("button on the card");
  });

  it("names a pipeline that is not there as a sentence, with no card", async () => {
    const conversation = await chat();

    const { cardIds, rejections } = turn(conversation, { message: "Here.", card: { kind: "pipelineExport", pipelineId: "no-such-pipeline" } });

    expect(cardIds).toEqual([]);
    expect(rejections[0]).toContain("no pipeline with the ID");
  });

  it("is reached by no eo_admin tool, so pressing one — and discarding edits at all — is never an agent's", () => {
    const reached = TOOLS.flatMap((tool) => tool.channels);
    expect(reached).not.toContain("assist:applyCard");
    expect(reached).not.toContain("pipelines:discardEdits");
  });

  it("stops being pressable once a newer card replaces it — the rule every card in the room has", async () => {
    const conversation = await chat();
    const older = turn(conversation, { message: "Here.", card: { kind: "pipelineExport", pipelineId: "default" } });
    await call("assist:send", { page: pageDescriptorFor("/settings"), conversationId: conversation.id, body: "Delete it instead.", attachmentIds: [], interrupt: false });
    turn(conversation, { message: "Fine.", card: { kind: "pipelineDelete", pipelineId: "default" } });

    const pressed = await press(conversation, older.cardIds[0]!);

    expect(pressed).toMatchObject({ applied: false, said: null });
    expect(pressed.problem).toContain("superseded");
    expect(saveFile).not.toHaveBeenCalled();
    expect(await messageOf(conversation, older.cardIds[0]!)).toMatchObject({ canApprove: false, card: { outcome: null } });
  });
});

describe("exporting a pipeline", () => {
  it("saves the file where the person chose, as the editor's Export did, and the card says so once", async () => {
    const conversation = await chat("Export the default pipeline.");
    const { cardIds } = turn(conversation, { message: "Press Export.", card: { kind: "pipelineExport", pipelineId: "default" } });
    const pipeline = getPipeline(handle.db, "default")!;

    expect(await read(conversation, cardIds[0]!)).toEqual({ card: { kind: "pipelineExport", pipelineId: "default", pipelineName: pipeline.name }, problem: null });

    const pressed = await press(conversation, cardIds[0]!);

    expect(pressed).toMatchObject({ applied: true, problem: null });
    expect(pressed.said).toContain(chosenPath!);
    expect(saveFile).toHaveBeenCalledTimes(1);
    const written = PipelineExportSchema.parse(JSON.parse(readFileSync(chosenPath!, "utf8")));
    expect(written.pipeline.name).toBe(pipeline.name);
    expect(await messageOf(conversation, cardIds[0]!)).toMatchObject({ canApprove: false, card: { outcome: { done: true, said: pressed.said } } });

    // And not twice: the outcome filed under it is what spends it.
    const again = await press(conversation, cardIds[0]!);
    expect(again).toMatchObject({ applied: false, said: null, problem: "That card has already been pressed." });
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  it("carries out a card pressed twice at once only once — another window, while the first waits on its dialog", async () => {
    const conversation = await chat();
    const { cardIds } = turn(conversation, { message: "Press Export.", card: { kind: "pipelineExport", pipelineId: "default" } });
    let answer!: (path: string) => void;
    saveFile.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));

    const first = press(conversation, cardIds[0]!);
    const second = await press(conversation, cardIds[0]!);
    answer(chosenPath!);

    expect(second).toMatchObject({ applied: false, said: null, problem: "That card is already being pressed." });
    expect((await first).applied).toBe(true);
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.parentId === cardIds[0])).toHaveLength(1);
  });

  it("files nothing when the person closes the save dialog, and the card can be pressed again", async () => {
    const conversation = await chat();
    const { cardIds } = turn(conversation, { message: "Press Export.", card: { kind: "pipelineExport", pipelineId: "default" } });
    chosenPath = null;

    const cancelled = await press(conversation, cardIds[0]!);

    expect(cancelled).toMatchObject({ applied: false, problem: null, said: null });
    expect(await messageOf(conversation, cardIds[0]!)).toMatchObject({ canApprove: true, card: { outcome: null } });
    chosenPath = join(scratch, "second-try.json");
    expect((await press(conversation, cardIds[0]!)).applied).toBe(true);
    expect(existsSync(chosenPath)).toBe(true);
  });
});

describe("importing an attached pipeline file", () => {
  // A pipeline goes on a project (EO-766): these chats are opened on
  // none, so what they import goes on the oldest — this one.
  beforeEach(() => {
    createProject(handle.db, { name: "Workbench", keyPrefix: "WRK" });
  });

  async function attachedExport(): Promise<{ conversation: Item; attachmentId: string }> {
    const exported = await call("pipelines:export", { pipelineId: shippingPipeline(), destination: "document" });
    const conversation = await chat("Import this.", [{ name: "shipping.eo-pipeline.json", text: exported.document! }]);
    return { conversation, attachmentId: listAttachmentsForItem(handle.db, conversation.id)[0]!.id };
  }

  it("shows what the import would create and each module it collides with, and imports with the person's choices", async () => {
    const { conversation, attachmentId } = await attachedExport();
    const { cardIds, rejections } = turn(conversation, { message: "The card shows what it needs.", card: { kind: "pipelineImport", attachmentId } });
    expect(rejections).toEqual([]);
    const before = { pipelines: listPipelines(handle.db).length, modules: listModules(handle.db).length };

    const shown = await read(conversation, cardIds[0]!);

    expect(shown.problem).toBeNull();
    expect(shown.card).toMatchObject({
      kind: "pipelineImport",
      attachmentName: "shipping.eo-pipeline.json",
      preflight: { pipelineName: "Shipping", moduleCount: 1, collisions: [{ slug: "deploy", localName: "Deploy", incomingName: "Deploy" }] },
    });
    // Reading it wrote nothing.
    expect(listPipelines(handle.db)).toHaveLength(before.pipelines);

    const pressed = await press(conversation, cardIds[0]!, { deploy: "import" });

    expect(pressed).toMatchObject({ applied: true, problem: null });
    expect(pressed.said).toContain("Imported");
    expect(listPipelines(handle.db)).toHaveLength(before.pipelines + 1);
    // Theirs, beside mine — what "Import theirs" means.
    expect(listModules(handle.db)).toHaveLength(before.modules + 1);
    expect(await messageOf(conversation, cardIds[0]!)).toMatchObject({ canApprove: false, card: { kind: "pipelineImport", outcome: { done: true } } });
  });

  it("keeps mine when that is the choice, bringing no second module", async () => {
    const { conversation, attachmentId } = await attachedExport();
    const { cardIds } = turn(conversation, { message: "Here.", card: { kind: "pipelineImport", attachmentId } });
    const modules = listModules(handle.db).length;

    expect((await press(conversation, cardIds[0]!, { deploy: "reuse" })).applied).toBe(true);

    expect(listModules(handle.db)).toHaveLength(modules);
  });

  it("offers no card for a file that is not attached to this chat", async () => {
    const conversation = await chat();

    const { cardIds, rejections } = turn(conversation, { message: "Here.", card: { kind: "pipelineImport", attachmentId: "019a0000-0000-7000-8000-000000000000" } });

    expect(cardIds).toEqual([]);
    expect(rejections[0]).toContain("attached to this chat");
  });

  it("says why a file that is not a pipeline cannot be imported, and offers nothing to press", async () => {
    const conversation = await chat("Import this.", [{ name: "notes.txt", text: "not a pipeline" }]);
    const attachmentId = listAttachmentsForItem(handle.db, conversation.id)[0]!.id;
    const { cardIds } = turn(conversation, { message: "Here.", card: { kind: "pipelineImport", attachmentId } });

    const shown = await read(conversation, cardIds[0]!);

    expect(shown.card).toBeNull();
    expect(shown.problem).toContain("notes.txt");
  });
});

/**
 * Which project an import card is about (EO-521 review). The card's
 * needs and the import itself are both the chat's project — never
 * whichever project the window happens to be on when it is drawn or
 * pressed, and never a project at all for a chat that has none.
 */
describe("importing into the chat's own project", () => {
  /** Two projects, by key prefix. */
  function twoProjects(): { a: Uuid; b: Uuid } {
    attachWorkspace(handle.db, { name: "alpha", repoPath: "/tmp/alpha", keyPrefix: "ALP" });
    attachWorkspace(handle.db, { name: "beta", repoPath: "/tmp/beta", keyPrefix: "BET" });
    const projects = listProjects(handle.db);
    const a = projects.find((project) => project.keyPrefix === "ALP")!.id;
    const b = projects.find((project) => project.keyPrefix === "BET")!.id;
    return { a, b };
  }

  const bugIn = (preflight: { itemTypes: { type: string; present: boolean }[] }) => preflight.itemTypes.find((type) => type.type.endsWith("bug"));

  it("checks and imports against the chat's project, not the one that became active since", async () => {
    const { a, b } = twoProjects();
    setSetting(handle.db, ACTIVE_PROJECT_KEY, a);
    const exported = await call("pipelines:export", { pipelineId: shippingPipeline(a), destination: "document" });
    const conversation = await chat("Import this.", [{ name: "shipping.eo-pipeline.json", text: exported.document! }]);
    expect(conversation.projectId).toBe(a);
    const attachmentId = listAttachmentsForItem(handle.db, conversation.id)[0]!.id;
    const { cardIds } = turn(conversation, { message: "Here.", card: { kind: "pipelineImport", attachmentId } });
    // The chat's project lacks a type the document brings, and the other has it.
    handle.db.run(sql`DELETE FROM item_types WHERE slug = 'bug' AND project_id = ${a}`);
    // The person moves to the other project before the card is drawn.
    setSetting(handle.db, ACTIVE_PROJECT_KEY, b);

    const shown = await read(conversation, cardIds[0]!);

    expect(shown.card?.kind).toBe("pipelineImport");
    if (shown.card?.kind !== "pipelineImport") return;
    expect(bugIn(shown.card.preflight)).toMatchObject({ present: false });
    // What the editor's Import, on the active project, would have said.
    const onActive = await call("pipelines:importPreflight", { document: exported.document! });
    expect(bugIn(onActive.preflight!)).toMatchObject({ present: true });

    const pressed = await press(conversation, cardIds[0]!, { deploy: "reuse" });

    expect(pressed.applied).toBe(true);
    const imported = listPipelines(handle.db).filter((pipeline) => pipeline.name.startsWith("Shipping") && pipeline.projectId !== null);
    expect(imported.map((pipeline) => pipeline.projectId)).toEqual([a, a]);
    // And the type it lacked arrived where the pipeline did.
    expect(handle.db.all(sql`SELECT project_id FROM item_types WHERE slug = 'bug'`)).toContainEqual({ project_id: a });
  });

  /**
   * A chat opened before any project existed is listed under the oldest
   * project, and what it imports goes there (EO-766) — never onto no
   * project, and never onto whichever project is active.
   */
  it("imports for a chat with no project onto the oldest project, not the active one", async () => {
    const exported = await call("pipelines:export", { pipelineId: shippingPipeline(), destination: "document" });
    const conversation = await chat("Import this.", [{ name: "shipping.eo-pipeline.json", text: exported.document! }]);
    expect(conversation.projectId).toBeNull();
    const before = new Set(listPipelines(handle.db).map((pipeline) => pipeline.id));
    // Projects exist by the time the card is pressed, and the newer is active.
    const { a, b } = twoProjects();
    setSetting(handle.db, ACTIVE_PROJECT_KEY, b);
    const attachmentId = listAttachmentsForItem(handle.db, conversation.id)[0]!.id;
    const { cardIds } = turn(conversation, { message: "Here.", card: { kind: "pipelineImport", attachmentId } });
    handle.db.run(sql`DELETE FROM item_types WHERE slug = 'bug' AND project_id = ${a}`);

    const shown = await read(conversation, cardIds[0]!);
    // Read against the oldest project's types, which lack the bug the active one has.
    expect(shown.card?.kind).toBe("pipelineImport");
    if (shown.card?.kind !== "pipelineImport") return;
    expect(bugIn(shown.card.preflight)).toMatchObject({ present: false });

    expect((await press(conversation, cardIds[0]!, { deploy: "reuse" })).applied).toBe(true);

    const created = listPipelines(handle.db).filter((pipeline) => !before.has(pipeline.id));
    expect(created.map((pipeline) => pipeline.projectId)).toEqual([a]);
  });

  it("refuses the import, writing nothing, while there is no project at all", async () => {
    const exported = await call("pipelines:export", { pipelineId: shippingPipeline(), destination: "document" });
    const conversation = await chat("Import this.", [{ name: "shipping.eo-pipeline.json", text: exported.document! }]);
    const before = listPipelines(handle.db, undefined, true).length;
    const attachmentId = listAttachmentsForItem(handle.db, conversation.id)[0]!.id;
    const { cardIds } = turn(conversation, { message: "Here.", card: { kind: "pipelineImport", attachmentId } });

    const shown = await read(conversation, cardIds[0]!);

    expect(shown.card).toBeNull();
    expect(shown.problem).toBe(PIPELINE_NEEDS_PROJECT);
    // And the editor's door says the same, with nothing written.
    const imported = await call("pipelines:import", { document: exported.document!, choices: { deploy: "reuse" }, projectId: null });
    expect(imported).toMatchObject({ imported: false, pipelineId: null, problem: PIPELINE_NEEDS_PROJECT });
    expect(listPipelines(handle.db, undefined, true)).toHaveLength(before);
  });

  it("leaves the editor's Import on the active project, as it always was", async () => {
    const { a, b } = twoProjects();
    setSetting(handle.db, ACTIVE_PROJECT_KEY, b);
    const exported = await call("pipelines:export", { pipelineId: shippingPipeline(a), destination: "document" });
    const before = new Set(listPipelines(handle.db).map((pipeline) => pipeline.id));

    const imported = await call("pipelines:import", { document: exported.document!, choices: { deploy: "reuse" }, projectId: null });

    expect(imported.imported).toBe(true);
    expect(listPipelines(handle.db).filter((pipeline) => !before.has(pipeline.id)).map((pipeline) => pipeline.projectId)).toEqual([b]);
  });
});

describe("deleting a pipeline", () => {
  it("says how many items it holds, and Delete archives it with them through pipelines:delete", async () => {
    attachWorkspace(handle.db, { name: "api", repoPath: "/tmp/api", keyPrefix: "API" });
    const entry = getPipeline(handle.db, "default")!.entryStepId!;
    const projectId = listPipelines(handle.db).find((pipeline) => pipeline.id === "default")?.projectId ?? null;
    const items = [1, 2].map((n) => createTestItem(handle.db, { type: "story", projectId, title: `Work ${n}`, stepId: entry }));
    const conversation = await chat("Delete the default pipeline.");
    const { cardIds } = turn(conversation, { message: "Press Delete.", card: { kind: "pipelineDelete", pipelineId: "default" } });

    expect((await read(conversation, cardIds[0]!)).card).toMatchObject({ kind: "pipelineDelete", pipelineId: "default", itemCount: 2 });

    const pressed = await press(conversation, cardIds[0]!);

    expect(pressed).toMatchObject({ applied: true, problem: null });
    expect(pressed.said).toContain("Archive");
    expect(getPipeline(handle.db, "default")?.archivedAt).not.toBeNull();
    expect(items.map((item) => getItem(handle.db, item.id)?.archivedAt)).toEqual([expect.any(Number), expect.any(Number)]);
    expect(await messageOf(conversation, cardIds[0]!)).toMatchObject({ card: { outcome: { done: true } } });
  });

  it("shows a refusal on the card and archives nothing", async () => {
    // An organisation manages this machine's pipelines, so the channel
    // refuses the delete — and the card says so, rather than nothing.
    publishSection(handle.db, { section: "pipelines", subjectId: "default", versionId: "a-version", versionNumber: 1, publishedAt: Date.now(), publishedBy: "dana-id", publishedByName: "Dana" });
    const stopBeingAReplica = markReplica(handle.db, () => true);
    try {
      const conversation = await chat("Delete the default pipeline.");
      const { cardIds } = turn(conversation, { message: "Press Delete.", card: { kind: "pipelineDelete", pipelineId: "default" } });

      const pressed = await press(conversation, cardIds[0]!);

      expect(pressed.applied).toBe(false);
      expect(pressed.problem).toContain("not deleted");
      expect(pressed.problem).toContain("pipelines");
      expect(getPipeline(handle.db, "default")?.archivedAt).toBeNull();
      expect(await messageOf(conversation, cardIds[0]!)).toMatchObject({ canApprove: false, card: { outcome: { done: false, said: pressed.said } } });
    } finally {
      stopBeingAReplica();
    }
  });
});

describe("discarding this machine's edits to an organisation pipeline", () => {
  /** "default", published by the organisation, and renamed here since. */
  function divergedDefault(): { version: number; stop: () => void } {
    const graph = listPipelineStepViews(handle.db, { pipelineId: "default" });
    const saved = savePipeline(handle.db, undefined, { pipelineId: "default", steps: graph.steps, routes: graph.routes, entryStepId: graph.entryStepId });
    if (!saved.saved) throw new Error("could not save the default pipeline");
    const version = currentVersion(handle.db, "default")!;
    publishSection(handle.db, {
      section: "pipelines",
      subjectId: "default",
      versionId: version.id,
      versionNumber: version.number,
      publishedAt: Date.now(),
      publishedBy: "dana-id",
      publishedByName: "Dana",
    });
    const stop = markReplica(handle.db, () => true);
    markDiverged(handle.db, "default", version.id, Date.now());
    const renamed = graph.steps.map((step, index) => (index === 0 ? { ...step, name: "Edited here" } : step));
    const edited = savePipeline(handle.db, undefined, { pipelineId: "default", steps: renamed, routes: graph.routes, entryStepId: graph.entryStepId });
    if (!edited.saved) throw new Error("could not edit the diverged copy");
    return { version: version.number, stop };
  }

  it("offers Discard my edits, which puts the organisation's version back and lets its updates resume", async () => {
    const { version, stop } = divergedDefault();
    try {
      const firstStep = listStepsForPipeline(handle.db, "default").sort((a, b) => a.position - b.position)[0]!;
      expect(firstStep.name).toBe("Edited here");
      const conversation = await chat("Throw my edits away.");
      const { cardIds, rejections } = turn(conversation, { message: "Press Discard my edits.", card: { kind: "pipelineDiscardEdits", pipelineId: "default" } });
      expect(rejections).toEqual([]);
      expect((await read(conversation, cardIds[0]!)).card).toMatchObject({ kind: "pipelineDiscardEdits", pipelineId: "default", version });
      expect((await messageOf(conversation, cardIds[0]!)).body).toContain("updates resume");

      const pressed = await press(conversation, cardIds[0]!);

      expect(pressed).toMatchObject({ applied: true, problem: null });
      expect(pressed.said).toContain(`v${version}`);
      expect(pressed.said).toContain("updates apply to it again");
      expect(isDiverged(handle.db, "default")).toBe(false);
      expect(listStepsForPipeline(handle.db, "default").find((step) => step.id === firstStep.id)?.name).not.toBe("Edited here");
    } finally {
      stop();
    }
  });

  it("offers no card for a pipeline whose copy here is not edited", async () => {
    const conversation = await chat();

    const { cardIds, rejections } = turn(conversation, { message: "Here.", card: { kind: "pipelineDiscardEdits", pipelineId: "default" } });

    expect(cardIds).toEqual([]);
    expect(rejections[0]).toContain("has not been edited locally");
  });
});
