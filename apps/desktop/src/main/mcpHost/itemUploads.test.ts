import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withActingAgent, type Uuid } from "@eo/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentStorage, MAX_ATTACHMENT_BYTES } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import {
  addWorkspaceToProject,
  createAgent,
  createProject,
  getItem,
  getItemByKey,
  listAttachmentsForItem,
  listCommentsForItem,
  listItemAttachments,
  listItemsForProject,
} from "../db/repos/index.js";
import { attachWorkspace, openMigratedTestDbAt } from "../db/testHelpers.js";
import { postCommentCommand } from "../ipc/domainCommands.js";
import { submitItemCommand } from "../ipc/itemCommands.js";
import { updateItemCommand } from "../ipc/itemAttachmentCommands.js";
import { submitPlanCommand } from "../ipc/planCommands.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "../ipc/registry.js";
import type { ItemRecord } from "../record/record.js";
// @ts-expect-error — the service is plain JavaScript, deliberately: it ships
// unbundled because Codex spawns it by path.
import * as eoServer from "../mcp/eoServer.mjs";
import { createAdminMcpHost, type AdminMcpHost } from "./admin.js";
import { answerToolCall } from "./server.js";

/**
 * Files put on an item as its own, by path, when it is filed or edited
 * (EO-704): `work_submit_item`, `work_submit_plan` and `item_update`.
 *
 * The external host's client through `answerToolCall`; the system agent
 * over a real socket to the administrative host, holding a credential
 * leased for the directory its turn runs in — `commentUploads.test.ts`'s
 * arrangement, because the rule is `comment_post`'s (EO-700) and so is
 * the code that holds it.
 */
const SOCKET_TIMEOUT_MS = 30_000;
vi.setConfig({ testTimeout: SOCKET_TIMEOUT_MS, hookTimeout: SOCKET_TIMEOUT_MS });

const service = eoServer as {
  createEoMcpService(options: { dbPath: string; runId: string | null; runDirectory: string | null }): {
    handle(message: unknown): Promise<{ result: { content: { type: string; text?: string; data?: string; mimeType?: string }[] } }>;
    close(): void;
  };
};

/** A PNG's signature and nothing else: enough for main to know it is an image. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const opts = { exposeErrorDetails: true };

/** Never asked: no project here is held by an organisation's record. */
const NO_RECORD = { changeDependencies: () => Promise.reject(new Error("not reached")) } as unknown as Pick<ItemRecord, "changeDependencies">;

let root: string;
let dbPath: string;
let handle: DbHandle;
let storage: AttachmentStorage;
let storeRoot: string;
let host: AdminMcpHost;
let clients: Client[] = [];
let systemAgentId: Uuid;
let projectId: Uuid;
let turnDir: string;
let elsewhere: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eo-item-uploads-"));
  dbPath = join(root, "eo.db");
  handle = openMigratedTestDbAt(dbPath);
  storeRoot = join(root, "attachments");
  storage = new AttachmentStorage(storeRoot);
  turnDir = join(root, "turn");
  elsewhere = join(root, "elsewhere");
  mkdirSync(turnDir);
  mkdirSync(elsewhere);
  systemAgentId = createAgent(handle.db, { name: "Assistant", role: "system", provider: "fake", instructions: "", config: { allowedTools: ["mcp__eo_admin"] } }).id;
  projectId = createProject(handle.db, { name: "Board", keyPrefix: "BRD" }).id;
  addWorkspaceToProject(handle.db, projectId, attachWorkspace(handle.db, { name: "app", keyPrefix: "APP", repoPath: join(root, "repo") }).id);
  registerHandler("work:submitItem", (payload) => submitItemCommand(handle.db, undefined, payload, storage), opts);
  registerHandler("work:submitPlan", (payload) => submitPlanCommand(handle.db, undefined, payload, storage), opts);
  registerHandler("items:update", (payload) => updateItemCommand(handle.db, NO_RECORD, payload, storage), opts);
  registerHandler("comments:post", (payload) => postCommentCommand(handle.db, undefined, payload, storage), opts);
  host = createAdminMcpHost({ db: handle.db, version: "0.0.0-test" });
});

afterEach(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
  clients = [];
  await host.stop();
  clearHandlerRegistry();
  handle.close();
  rmSync(root, { recursive: true, force: true });
});

type Answer = { text: string; isError: boolean };

/** A `tools/call` on the external host. */
async function external(name: string, args: Record<string, unknown>): Promise<Answer> {
  const answer = await answerToolCall({ name, arguments: args }, "external", false);
  return { text: (answer.content[0] as { text: string }).text, isError: answer.isError === true };
}

/** A `tools/call` from the system agent's turn, over the administrative host. */
async function systemAgent(directory: string | null, name: string, args: Record<string, unknown>): Promise<Answer> {
  const status = await host.start();
  expect(status.problem).toBeNull();
  const endpoint = host.endpoint()!;
  const lease = endpoint.lease(systemAgentId, directory);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { authorization: `Bearer ${lease.token}` } } }));
  clients.push(client);
  const answer = await client.callTool({ name, arguments: args });
  return { text: (answer.content as { text: string }[])[0]!.text, isError: answer.isError === true };
}

function file(directory: string, name: string, content: string | Buffer): string {
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}

function storedFiles(): string[] {
  try {
    return readdirSync(join(storeRoot, "files"));
  } catch {
    return [];
  }
}

const story = (paths?: string[]) => ({
  projectId,
  type: "story",
  title: "Redesign the board",
  body: "Built against the mock.",
  acceptanceCriteria: ["The board matches the mock."],
  ...(paths === undefined ? {} : { paths }),
});

/** The one item a call filed, by the key its answer names. */
function filed(answer: Answer) {
  const key = /Created ([A-Z]+-\d+)/.exec(answer.text)?.[1];
  expect(key, answer.text).toBeDefined();
  return getItemByKey(handle.db, key!)!;
}

/** Everything a refused filing could have left: an item, an attachment row, a file in the store. */
function nothingFiled() {
  expect(listItemsForProject(handle.db, projectId)).toEqual([]);
  expect(storedFiles()).toEqual([]);
}

describe("work_submit_item with paths", () => {
  it("files the item with those files as its own, in the one call", async () => {
    const shot = file(elsewhere, "mock.png", PNG);
    const notes = file(elsewhere, "notes.md", "# What changed\n");

    const answer = await external("work_submit_item", story([shot, notes]));

    expect(answer.isError).toBe(false);
    const item = filed(answer);
    const own = listItemAttachments(handle.db, item.id);
    expect(own.map((one) => [one.name, one.mimeType, one.size, one.commentId])).toEqual(
      expect.arrayContaining([
        ["mock.png", "image/png", PNG.length, null],
        ["notes.md", "text/markdown", 15, null],
      ]),
    );
    expect(own).toHaveLength(2);
    // Item files, not something said: no comment carries them.
    expect(listCommentsForItem(handle.db, item.id).flatMap((comment) => comment.attachments ?? [])).toEqual([]);
  });

  it("leaves them readable by attachment_read the moment the item exists, as the eo server every backend starts answers it", async () => {
    const shot = file(elsewhere, "mock.png", PNG);
    const notes = file(elsewhere, "notes.txt", "Use the wide layout.\n");
    const item = filed(await external("work_submit_item", story([shot, notes])));
    const own = listItemAttachments(handle.db, item.id);

    const eo = service.createEoMcpService({ dbPath, runId: null, runDirectory: null });
    try {
      const read = async (attachmentId: string) =>
        (await eo.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "attachment_read", arguments: { attachmentId } } })).result.content[0]!;
      expect(await read(own.find((one) => one.name === "mock.png")!.id)).toMatchObject({ type: "image", mimeType: "image/png", data: PNG.toString("base64") });
      expect(await read(own.find((one) => one.name === "notes.txt")!.id)).toMatchObject({ type: "text", text: "Use the wide layout.\n" });
    } finally {
      eo.close();
    }
  });

  it("refuses the whole call over one bad path, naming it and why, and creates nothing", async () => {
    const shot = file(elsewhere, "mock.png", PNG);
    const missing = join(elsewhere, "gone.png");

    const answer = await external("work_submit_item", story([shot, missing, "relative.png"]));

    expect(answer.text).toContain("Nothing has changed");
    expect(answer.text).toContain(`"${missing}" does not exist, or cannot be read.`);
    expect(answer.text).toContain(`"relative.png" is not an absolute path`);
    expect(answer.text).toContain("Nothing has changed");
    nothingFiled();
  });

  it("refuses a file over the 20 MB limit, and creates nothing", async () => {
    const big = file(elsewhere, "huge.bin", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));

    const answer = await external("work_submit_item", story([big]));

    expect(answer.text).toContain("Nothing has changed");
    expect(answer.text).toContain(`"${big}" is larger than the 20 MB attachment limit.`);
    nothingFiled();
  });

  it("takes the stored files back when the item itself is refused after they were stored", async () => {
    const shot = file(elsewhere, "mock.png", PNG);

    // A story without criteria passes the path check and is refused by the item's own.
    const answer = await external("work_submit_item", { ...story([shot]), acceptanceCriteria: [] });

    expect(answer.text).toContain("Nothing has changed");
    nothingFiled();
  });

  it("refuses paths at a door that granted no reading by path — the renderer, a server's HTTP door", async () => {
    const shot = file(elsewhere, "mock.png", PNG);

    // What `platform/electron.ts` and `server/http.ts` do to every payload.
    const result = await dispatchIpc("work:submitItem", withActingAgent("work:submitItem", { ...story([shot]), pathsFrom: { kind: "anywhere" } }, undefined));

    expect(result).toMatchObject({ ok: true, data: { created: false, problem: expect.stringContaining("only through EO's MCP servers") } });
    nothingFiled();
  });
});

describe("work_submit_item from the system agent", () => {
  it("files a file inside the directory its turn runs in, named relative to it or absolutely", async () => {
    file(turnDir, "mock.png", PNG);
    const notes = file(turnDir, "notes.txt", "inside");

    const answer = await systemAgent(turnDir, "work_submit_item", story(["mock.png", notes]));

    expect(answer.isError, answer.text).toBe(false);
    const own = listItemAttachments(handle.db, filed(answer).id);
    expect(own.map((one) => one.name).sort()).toEqual(["mock.png", "notes.txt"]);
  });

  it("refuses a file outside that directory and one reached through a link leading out, and creates nothing", async () => {
    const outside = file(elsewhere, "secret.txt", "not yours");
    symlinkSync(outside, join(turnDir, "link.txt"));

    const answer = await systemAgent(turnDir, "work_submit_item", story([outside, "link.txt"]));

    expect(answer.text).toContain("Nothing has changed");
    expect(answer.text).toContain(outside);
    expect(answer.text).toContain("link.txt");
    nothingFiled();
  });

  it("refuses any path on a turn that runs in no directory, saying so", async () => {
    file(turnDir, "mock.png", PNG);

    const answer = await systemAgent(null, "work_submit_item", story(["mock.png"]));

    expect(answer.text).toContain("Nothing has changed");
    expect(answer.text).toContain("This turn runs in no directory");
    nothingFiled();
  });
});

describe("work_submit_plan with paths", () => {
  const plan = (featurePaths: string[], storyPaths: (string[] | undefined)[]) => ({
    projectId,
    title: "Board redesign",
    understanding: "We agreed to rebuild the board against the mocks.",
    stories: storyPaths.map((paths, index) => ({
      title: `Story ${index + 1}`,
      body: "b",
      acceptance_criteria: ["done"],
      depends_on: [],
      touches: [],
      ...(paths === undefined ? {} : { paths }),
    })),
    paths: featurePaths,
  });

  it("puts the feature's files on the feature and each story's on that story", async () => {
    const spec = file(elsewhere, "spec.pdf", "%PDF-1.4");
    const first = file(elsewhere, "first.png", PNG);
    const second = file(elsewhere, "second.txt", "second");

    const answer = await external("work_submit_plan", plan([spec], [[first], undefined, [second]]));

    expect(answer.isError, answer.text).toBe(false);
    const [featureKey, ...storyKeys] = [...answer.text.matchAll(/[A-Z]+-\d+/g)].map((match) => match[0]);
    const namesOn = (key: string) => listItemAttachments(handle.db, getItemByKey(handle.db, key)!.id).map((one) => one.name);
    expect(namesOn(featureKey!)).toEqual(["spec.pdf"]);
    expect(storyKeys.map(namesOn)).toEqual([["first.png"], [], ["second.txt"]]);
  });

  it("refuses the whole plan over one story's bad path, naming it, and creates nothing", async () => {
    const spec = file(elsewhere, "spec.pdf", "%PDF-1.4");
    const missing = join(elsewhere, "gone.png");

    const answer = await external("work_submit_plan", plan([spec], [undefined, [missing]]));

    expect(answer.text).toContain("Nothing has changed");
    expect(answer.text).toContain(`"${missing}" does not exist, or cannot be read.`);
    nothingFiled();
  });

  it("refuses more than eight files across the feature and its stories together, before anything is stored", async () => {
    const featureFiles = Array.from({ length: 8 }, (_unused, index) => file(elsewhere, `feature-${index}.txt`, `f${index}`));
    const storyFile = file(elsewhere, "story.txt", "s");

    const answer = await external("work_submit_plan", plan(featureFiles, [[storyFile]]));

    expect(answer.text).toContain("One call may name at most 8 files by path, and this one names 9 across the feature and its stories.");
    expect(answer.text).toContain("Nothing has changed");
    nothingFiled();
  });

  it("holds the system agent to its turn's directory on the plan too", async () => {
    file(turnDir, "spec.pdf", "%PDF-1.4");
    const outside = file(elsewhere, "secret.txt", "not yours");

    const refused = await systemAgent(turnDir, "work_submit_plan", plan(["spec.pdf"], [[outside]]));
    expect(refused.text).toContain("Nothing has changed");
    expect(refused.text).toContain(outside);
    nothingFiled();

    const answer = await systemAgent(turnDir, "work_submit_plan", plan(["spec.pdf"], [undefined]));
    expect(answer.isError, answer.text).toBe(false);
    const featureKey = /[A-Z]+-\d+/.exec(answer.text)![0];
    expect(listItemAttachments(handle.db, getItemByKey(handle.db, featureKey)!.id).map((one) => one.name)).toEqual(["spec.pdf"]);
  });
});

describe("item_update with paths and removeAttachmentIds", () => {
  async function anItem(paths: string[] = []) {
    return filed(await external("work_submit_item", story(paths)));
  }

  it("adds files with paths, beside the ones the item has", async () => {
    const item = await anItem([file(elsewhere, "first.png", PNG)]);
    const second = file(elsewhere, "second.txt", "second");

    const answer = await external("item_update", { itemId: item.id, paths: [second] });

    expect(answer.isError, answer.text).toBe(false);
    expect(listItemAttachments(handle.db, item.id).map((one) => one.name)).toEqual(["first.png", "second.txt"]);
  });

  it("removes an item file by id, its row and its stored bytes, with a text edit in the same call", async () => {
    const item = await anItem([file(elsewhere, "first.png", PNG), file(elsewhere, "keep.txt", "keep")]);
    const [first] = listItemAttachments(handle.db, item.id);
    expect(storedFiles()).toHaveLength(2);

    const answer = await external("item_update", { itemId: item.id, title: "Redesign the board, wide", removeAttachmentIds: [first!.id] });

    expect(answer.isError, answer.text).toBe(false);
    expect(listItemAttachments(handle.db, item.id).map((one) => one.name)).toEqual(["keep.txt"]);
    expect(storedFiles()).toHaveLength(1);
    expect(getItem(handle.db, item.id)!.title).toBe("Redesign the board, wide");
  });

  it("lists the item's own files on ticket_get, with the ids removeAttachmentIds takes", async () => {
    const item = await anItem([file(elsewhere, "first.png", PNG)]);
    registerHandler("items:getSections", (payload) => import("../ipc/domainQueries.js").then(({ getItemSections }) => getItemSections(handle.db, payload)), opts);
    const [first] = listItemAttachments(handle.db, item.id);

    const answer = await external("ticket_get", { itemId: item.id });

    expect(answer.text).toContain("## Files");
    expect(answer.text).toContain(`- attachment ${first!.id}: first.png (image/png, ${PNG.length} bytes)`);
  });

  it("refuses to remove a comment's file, and changes nothing else the call asked for", async () => {
    const item = await anItem([file(elsewhere, "own.png", PNG)]);
    await external("comment_post", { itemId: item.id, body: "A screenshot.", paths: [file(elsewhere, "said.png", PNG)] });
    const said = listAttachmentsForItem(handle.db, item.id).find((one) => one.commentId !== null)!;
    const before = storedFiles().length;

    const answer = await external("item_update", {
      itemId: item.id,
      title: "Not this",
      paths: [file(elsewhere, "more.txt", "more")],
      removeAttachmentIds: [said.id],
    });

    expect(answer.text).toContain("Nothing has changed");
    expect(answer.text).toContain("said.png");
    expect(answer.text).toContain("is on a comment, and goes only with that comment.");
    expect(listAttachmentsForItem(handle.db, item.id).map((one) => one.name).sort()).toEqual(["own.png", "said.png"]);
    expect(getItem(handle.db, item.id)!.title).toBe("Redesign the board");
    expect(storedFiles()).toHaveLength(before);
  });

  it("refuses an id that is no file on this item, and a bad path, both at once, and changes nothing", async () => {
    const item = await anItem([file(elsewhere, "own.png", PNG)]);
    const other = await anItem([file(elsewhere, "theirs.png", PNG)]);
    const theirs = listItemAttachments(handle.db, other.id)[0]!;
    const missing = join(elsewhere, "gone.png");
    const before = storedFiles().length;

    const answer = await external("item_update", { itemId: item.id, paths: [missing], removeAttachmentIds: [theirs.id] });

    expect(answer.text).toContain("Nothing has changed");
    expect(answer.text).toContain(`There is no file ${theirs.id} on ${item.key}.`);
    expect(answer.text).toContain(`"${missing}" does not exist, or cannot be read.`);
    expect(listItemAttachments(handle.db, item.id).map((one) => one.name)).toEqual(["own.png"]);
    expect(listItemAttachments(handle.db, other.id).map((one) => one.name)).toEqual(["theirs.png"]);
    expect(storedFiles()).toHaveLength(before);
  });

  it("takes the stored files back when the text edit beside them is refused", async () => {
    const item = await anItem();

    const answer = await external("item_update", { itemId: item.id, acceptanceCriteria: [], paths: [file(elsewhere, "more.txt", "more")] });

    expect(answer.text).toContain("Nothing has changed");
    expect(listItemAttachments(handle.db, item.id)).toEqual([]);
    expect(storedFiles()).toEqual([]);
  });

  it("holds the system agent to its turn's directory", async () => {
    const item = await anItem();
    file(turnDir, "inside.txt", "inside");
    const outside = file(elsewhere, "secret.txt", "not yours");

    const refused = await systemAgent(turnDir, "item_update", { itemId: item.id, paths: [outside] });
    expect(refused.text).toContain("Nothing has changed");
    expect(refused.text).toContain(outside);
    expect(listItemAttachments(handle.db, item.id)).toEqual([]);

    const answer = await systemAgent(turnDir, "item_update", { itemId: item.id, paths: ["inside.txt"] });
    expect(answer.isError, answer.text).toBe(false);
    expect(listItemAttachments(handle.db, item.id).map((one) => one.name)).toEqual(["inside.txt"]);
  });
});
