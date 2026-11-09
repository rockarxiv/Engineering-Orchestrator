import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withActingAgent, type Item, type Uuid } from "@eo/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentStorage, MAX_ATTACHMENT_BYTES } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import { createAgent, listAttachmentsForItem, listCommentsForItem } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDbAt } from "../db/testHelpers.js";
import { postCommentCommand } from "../ipc/domainCommands.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "../ipc/registry.js";
// @ts-expect-error — the service is plain JavaScript, deliberately: it ships
// unbundled because Codex spawns it by path.
import * as eoServer from "../mcp/eoServer.mjs";
import { buildDispatchContext } from "../supervisor/buildDispatchContext.js";
import { createAdminMcpHost, type AdminMcpHost } from "./admin.js";
import { TOOLS } from "./catalog.js";
import { answerToolCall } from "./server.js";

/**
 * Files put on a comment by path, over `comment_post` (EO-700).
 *
 * The external host's client through `answerToolCall`, which is what a
 * `tools/call` on that host is answered by; the system agent over a real
 * socket to the administrative host, holding a credential leased for the
 * directory its turn runs in, because which directory a call may read is
 * decided by that credential and nothing the call says.
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

let root: string;
let dbPath: string;
let handle: DbHandle;
let storage: AttachmentStorage;
let storeRoot: string;
let host: AdminMcpHost;
let clients: Client[] = [];
let systemAgentId: Uuid;
let item: Item;
/** Where the system agent's turn runs. */
let turnDir: string;
/** Somewhere else on the machine, which only the external client may read from. */
let elsewhere: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eo-comment-uploads-"));
  dbPath = join(root, "eo.db");
  handle = openMigratedTestDbAt(dbPath);
  storeRoot = join(root, "attachments");
  storage = new AttachmentStorage(storeRoot);
  turnDir = join(root, "turn");
  elsewhere = join(root, "elsewhere");
  mkdirSync(turnDir);
  mkdirSync(elsewhere);
  systemAgentId = createAgent(handle.db, { name: "Assistant", role: "system", provider: "fake", instructions: "", config: { allowedTools: ["mcp__eo_admin"] } }).id;
  item = createTestItem(handle.db, { type: "story", title: "Redesign the board", stepId: "todo" });
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

/** A `tools/call` on the external host. */
async function external(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const answer = await answerToolCall({ name: "comment_post", arguments: { itemId: item.id, ...args } }, "external", false);
  return { text: (answer.content[0] as { text: string }).text, isError: answer.isError === true };
}

/** A `tools/call` from the system agent's turn, over the administrative host. */
async function systemAgent(directory: string | null, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const status = await host.start();
  expect(status.problem).toBeNull();
  const endpoint = host.endpoint()!;
  const lease = endpoint.lease(systemAgentId, directory);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { authorization: `Bearer ${lease.token}` } } }));
  clients.push(client);
  const answer = await client.callTool({ name: "comment_post", arguments: { itemId: item.id, ...args } });
  return { text: (answer.content as { text: string }[])[0]!.text, isError: answer.isError === true };
}

function file(directory: string, name: string, content: string | Buffer): string {
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}

/** Everything a refused call could have left: a comment, an attachment row, a file in the store. */
function leftBehind() {
  const stored = (folder: string) => {
    try {
      return readdirSync(join(storeRoot, folder));
    } catch {
      return [];
    }
  };
  return { comments: listCommentsForItem(handle.db, item.id).length, attachments: listAttachmentsForItem(handle.db, item.id).length, files: stored("files") };
}

const NOTHING = { comments: 0, attachments: 0, files: [] };

describe("comment_post with paths, from a client of the external host", () => {
  it("uploads any absolute path the person's account can read, onto the comment it posts, beside a staged attachment", async () => {
    const shot = file(elsewhere, "mock.png", PNG);
    const notes = file(elsewhere, "notes.md", "# What changed\n");
    const staged = await storage.stageData({ name: "earlier.txt", dataBase64: Buffer.from("staged in the app").toString("base64") });

    const answer = await external({ body: "The mocks.", paths: [shot, notes], attachmentIds: [staged.id] });

    expect(answer.isError).toBe(false);
    const [comment] = listCommentsForItem(handle.db, item.id);
    expect(answer.text).toBe(`Comment posted (${comment!.id}).`);
    expect(comment!.body).toBe("The mocks.");
    const files = listAttachmentsForItem(handle.db, item.id);
    expect(files.map((one) => [one.name, one.mimeType, one.size, one.commentId])).toEqual(
      expect.arrayContaining([
        ["earlier.txt", "text/plain", 17, comment!.id],
        ["mock.png", "image/png", PNG.length, comment!.id],
        ["notes.md", "text/markdown", 15, comment!.id],
      ]),
    );
    expect(files).toHaveLength(3);
  });

  it("refuses a relative path with a sentence, and posts nothing", async () => {
    file(elsewhere, "mock.png", PNG);

    const answer = await external({ body: "The mocks.", paths: ["mock.png"] });

    expect(answer.text).toContain(`"mock.png" is not an absolute path`);
    expect(answer.text).toMatch(/^Nothing was posted\./);
    expect(leftBehind()).toEqual(NOTHING);
  });

  it("refuses the whole call over one missing path, naming it, and writes nothing — not even the files that were there", async () => {
    const shot = file(elsewhere, "mock.png", PNG);
    const missing = join(elsewhere, "gone.png");

    const answer = await external({ body: "The mocks.", paths: [shot, missing] });

    expect(answer.text).toContain(`"${missing}" does not exist`);
    expect(leftBehind()).toEqual(NOTHING);
  });

  it("refuses a directory, which is not a regular file", async () => {
    const answer = await external({ body: "x", paths: [elsewhere] });
    expect(answer.text).toContain(`"${elsewhere}" is a directory`);
    expect(leftBehind()).toEqual(NOTHING);
  });

  it("refuses a file over the 20 MB limit, by the size main reads rather than anything the caller says", async () => {
    const big = file(elsewhere, "huge.bin", "");
    truncateSync(big, MAX_ATTACHMENT_BYTES + 1);

    const answer = await external({ body: "x", paths: [big] });

    expect(answer.text).toContain(`"${big}" is larger than the 20 MB attachment limit`);
    expect(leftBehind()).toEqual(NOTHING);
  });

  it("refuses more than eight files counting attachmentIds, before anything is staged or stored", async () => {
    const paths = Array.from({ length: 6 }, (_, index) => file(elsewhere, `shot-${index}.png`, PNG));
    const staged = await Promise.all(
      [0, 1, 2].map((index) => storage.stageData({ name: `staged-${index}.txt`, dataBase64: Buffer.from("x").toString("base64") })),
    );

    const answer = await external({ body: "x", paths, attachmentIds: staged.map((one) => one.id) });

    expect(answer.text).toContain("a comment may carry at most 8 files, and this one names 6 by path and 3 by attachment id");
    expect(leftBehind()).toEqual(NOTHING);
    // The staged ones are still staged, for the person who staged them.
    expect(readdirSync(join(storeRoot, "staging")).filter((name) => name.endsWith(".bin"))).toHaveLength(3);
  });

  it("offers paths in the tool's schema and never the grant, which is the host's to stamp", () => {
    const tool = TOOLS.find((candidate) => candidate.name === "comment_post")!;
    expect(Object.keys(tool.inputSchema.properties ?? {})).toContain("paths");
    expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("pathsFrom");
    expect(tool.description).toContain("absolute path");
    expect(tool.description).toContain("directory its turn runs in");
  });

  it("cannot widen what it may read by sending the grant itself", async () => {
    // The external host stamps `anywhere` already, so the claim that
    // matters is the system agent's — below. Here: a claim is taken off,
    // and a relative path is still refused as the external host's rule says.
    file(elsewhere, "mock.png", PNG);
    const answer = await external({ body: "x", paths: ["mock.png"], pathsFrom: { kind: "directory", directory: elsewhere } });
    expect(answer.text).toContain(`"mock.png" is not an absolute path`);
    expect(leftBehind()).toEqual(NOTHING);
  });
});

describe("comment_post with paths, from the system agent over eo_admin", () => {
  it("uploads a file inside the directory its turn runs in, named relative to it or absolutely", async () => {
    file(turnDir, "board.png", PNG);
    const log = file(turnDir, "run.log", "1 failed, 41 passed\n");

    const answer = await systemAgent(turnDir, { body: "What I made.", paths: ["board.png", log] });

    expect(answer.isError).toBe(false);
    const files = listAttachmentsForItem(handle.db, item.id);
    expect(files.map((one) => [one.name, one.mimeType])).toEqual(
      expect.arrayContaining([
        ["board.png", "image/png"],
        ["run.log", "text/plain"],
      ]),
    );
    expect(listCommentsForItem(handle.db, item.id)).toHaveLength(1);
  });

  it("refuses a path outside that directory, naming it, and posts nothing", async () => {
    const outside = file(elsewhere, "secret.txt", "not the turn's");

    const answer = await systemAgent(turnDir, { body: "x", paths: [outside] });

    expect(answer.text).toContain(`"${outside}" is outside the directory`);
    expect(leftBehind()).toEqual(NOTHING);
  });

  it("refuses ../ out of it", async () => {
    file(elsewhere, "secret.txt", "not the turn's");
    const answer = await systemAgent(turnDir, { body: "x", paths: ["../elsewhere/secret.txt"] });
    expect(answer.text).toContain(`"../elsewhere/secret.txt" is outside the directory`);
    expect(leftBehind()).toEqual(NOTHING);
  });

  it("refuses a symbolic link leading out, whether it is the file or a directory on the way to it", async () => {
    file(elsewhere, "secret.txt", "not the turn's");
    symlinkSync(join(elsewhere, "secret.txt"), join(turnDir, "looks-local.txt"));
    symlinkSync(elsewhere, join(turnDir, "looks-local-dir"));

    const viaFile = await systemAgent(turnDir, { body: "x", paths: ["looks-local.txt"] });
    const viaDirectory = await systemAgent(turnDir, { body: "x", paths: ["looks-local-dir/secret.txt"] });

    expect(viaFile.text).toContain(`"looks-local.txt" is a symbolic link`);
    expect(viaDirectory.text).toContain(`"looks-local-dir/secret.txt" is a symbolic link, or is reached through one`);
    expect(leftBehind()).toEqual(NOTHING);
  });

  it("refuses paths on a turn that runs in no directory, saying why", async () => {
    const outside = file(elsewhere, "mock.png", PNG);

    const answer = await systemAgent(null, { body: "x", paths: [outside] });

    expect(answer.text).toContain("this turn runs in no directory");
    expect(leftBehind()).toEqual(NOTHING);
  });

  it("cannot claim the external client's reach by sending the grant itself", async () => {
    const outside = file(elsewhere, "secret.txt", "not the turn's");

    const answer = await systemAgent(turnDir, { body: "x", paths: [outside], pathsFrom: { kind: "anywhere" } });

    expect(answer.text).toContain("is outside the directory");
    expect(leftBehind()).toEqual(NOTHING);
  });

  it("posts an ordinary comment as it always did when it names no paths", async () => {
    const answer = await systemAgent(null, { body: "Just words." });
    expect(answer.isError).toBe(false);
    expect(listCommentsForItem(handle.db, item.id).map((comment) => comment.body)).toEqual(["Just words."]);
  });
});

describe("a door that is not one of EO's MCP hosts", () => {
  it("reads no file by path, whatever grant the payload claims — the renderer's and an organisation server's doors strip it", async () => {
    const outside = file(elsewhere, "secret.txt", "not yours");

    // What `platform/electron.ts` and `server/http.ts` do to every payload.
    const result = await dispatchIpc("comments:post", withActingAgent("comments:post", { itemId: item.id, body: "x", paths: [outside], pathsFrom: { kind: "anywhere" } }, undefined));

    expect(result).toMatchObject({ ok: true, data: { commentId: null, problem: expect.stringContaining("only through EO's MCP servers") } });
    expect(leftBehind()).toEqual(NOTHING);
  });
});

describe("an agent later dispatched on the item", () => {
  it("is told the uploaded files in its context, and reads the image as an image and the text as text through attachment_read", async () => {
    const shot = file(elsewhere, "mock.png", PNG);
    const notes = file(elsewhere, "notes.txt", "Use the wide layout.\n");
    await external({ body: "The mocks.", paths: [shot, notes] });
    const files = listAttachmentsForItem(handle.db, item.id);
    const png = files.find((one) => one.name === "mock.png")!;
    const txt = files.find((one) => one.name === "notes.txt")!;

    const context = await buildDispatchContext(handle.db, item, "implement");
    expect(context).toContain(`ID: ${png.id}; name: mock.png; MIME type: image/png; size: ${PNG.length} bytes`);
    expect(context).toContain(`ID: ${txt.id}; name: notes.txt; MIME type: text/plain; size: 21 bytes`);

    // One service, which is what both backends start: `attachment_read`'s
    // answer is the same whichever of them asked.
    const eo = service.createEoMcpService({ dbPath, runId: null, runDirectory: null });
    try {
      const read = async (attachmentId: string) =>
        (await eo.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "attachment_read", arguments: { attachmentId } } })).result.content[0]!;
      expect(await read(png.id)).toMatchObject({ type: "image", mimeType: "image/png", data: PNG.toString("base64") });
      expect(await read(txt.id)).toMatchObject({ type: "text", text: "Use the wide layout.\n" });
    } finally {
      eo.close();
    }
  });
});
