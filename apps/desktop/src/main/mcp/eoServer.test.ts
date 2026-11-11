import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentWriteAnswer, AgentWriteRequest, Item, Uuid } from "@eo/core";
import {
  ALIAS_RETIREMENT_VERSION,
  ATTACHMENT_ADD_TOOL_NAME,
  COMMENT_TOOL_NAME,
  deprecationNotice,
  eoToolName,
  MAX_ATTACHMENT_ADD_PATHS,
  MAX_RUN_ATTACHMENTS,
  MEMORY_NOTE_TOOL_NAME,
  MEMORY_READ_TOOL_NAME,
  memoryNoteEnabled,
  REPOSITORY_CHECKOUT_TOOL_NAME,
  SKILL_CREATE_TOOL_NAME,
  SKILL_FILE_REMOVE_TOOL_NAME,
  SKILL_FILE_WRITE_TOOL_NAME,
  SKILL_PATCH_TOOL_NAME,
  SKILL_READ_TOOL_NAME,
  SKILL_VIEW_TOOL_NAME,
  SKILL_WRITE_TOOLS,
  summarizeInstructions,
  uuidv7,
} from "@eo/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DbHandle } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { AttachmentStorage, MAX_ATTACHMENT_BYTES } from "../attachments/storage.js";
import { addMemory, createRun, insertAttachments, listAgents, listCommentsForItem, postComment, retireMemory } from "../db/repos/index.js";
import { attachRunFiles } from "../supervisor/runAttachments.js";
import { startAgentWriteBridge, type AgentWriteBridge } from "./writeBridge.js";
// @ts-expect-error — the service is plain JavaScript, deliberately: it ships
// unbundled because Codex spawns it by path.
import * as service from "./eoServer.mjs";
import { eoMcpStdioConfig } from "./serviceConfig.js";

/**
 * A write bridge that answers as a test tells it and remembers what it
 * was asked (EO-543) — the real bridge, with the main process's half
 * scripted. What the server does with a write is hand it over and relay
 * the answer; what the main process does with it is tested where that
 * is (`runAttachments.test.ts`, `supervisor/memoryNote.test.ts`,
 * `mcp/bridge.test.ts`).
 */
async function scriptedBridge(answer: (request: AgentWriteRequest) => AgentWriteAnswer | Promise<AgentWriteAnswer>) {
  const asked: { itemId: string; request: AgentWriteRequest }[] = [];
  const bridge: AgentWriteBridge = await startAgentWriteBridge(async (itemId, request) => {
    asked.push({ itemId, request });
    return answer(request);
  });
  return { asked, bridge };
}

const serviceSummarize = (service as { summarizeInstructions: (instructions: string) => unknown }).summarizeInstructions;

import { attachWorkspace, createTestItem } from "../db/testHelpers.js";
const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "eoServer.mjs");
const migrationsFolder = join(here, "..", "db", "migrations");

/**
 * Windows keeps a handle open for a moment after the process that owned it
 * exits, and answers EBUSY to whoever tries to delete underneath. Retrying
 * covers the usual case; giving up quietly covers the rest, because this is
 * a directory under TEMP and a cleanup that loses a race is not a failed
 * test.
 */
function removeScratch(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  } catch {
    // Left for the operating system to reclaim.
  }
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };

async function callServer(
  dbPath: string,
  requests: unknown[],
  enableCommentTool = true,
  extraEnv: Record<string, string> = {},
): Promise<Record<string, unknown>[]> {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, EO_MCP_DB_PATH: dbPath, EO_MCP_COMMENT_ENABLED: enableCommentTool ? "1" : "0", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses: Record<string, unknown>[] = [];
  const expected = requests.filter((request) => (request as { id?: unknown }).id !== undefined).length;

  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) responses.push(JSON.parse(line));
      newline = buffer.indexOf("\n");
    }
  });

  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`MCP server returned ${responses.length}/${expected} responses`)), 4_000);
    const poll = setInterval(() => {
      if (responses.length < expected) return;
      clearInterval(poll);
      clearTimeout(deadline);
      resolve();
    }, 10);
  }).finally(() => child.kill());
  return responses;
}

function resultFor(responses: Record<string, unknown>[], id: number): Record<string, unknown> {
  return responses.find((response) => response["id"] === id)?.["result"] as Record<string, unknown>;
}

describe("the shared EO MCP service", () => {
  let directory: string;
  let dbPath: string;
  let handle: DbHandle;
  let item: Item;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo mcp "));
    dbPath = join(directory, "eo.db");
    handle = openDb(dbPath);
    runMigrations(handle.db, migrationsFolder);
    item = createTestItem(handle.db, { type: "story", title: "Read attachments", body: "Keep file bytes lazy.", stepId: "todo" });
  });

  afterEach(() => {
    handle.close();
    // The service runs as a subprocess and opens the same database file;
    // closing our own handle does not mean its is gone yet.
    removeScratch(directory);
  });

  it("handshakes and advertises the complete enabled tool list over stdio", async () => {
    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);

    expect((resultFor(responses, 1)["serverInfo"] as { name: string }).name).toBe("eo");
    const tools = resultFor(responses, 2)["tools"] as { name: string; inputSchema: Record<string, unknown> }[];
    expect(tools.map((tool) => tool.name)).toEqual(["item_detail", "ticket_detail", "attachment_read", "comment_read", "comment_search", "comment"]);
    expect(tools.find((tool) => tool.name === "attachment_read")?.inputSchema).toMatchObject({ required: ["attachmentId"], additionalProperties: false });
    expect(tools.find((tool) => tool.name === "comment_read")?.inputSchema).toMatchObject({ required: ["commentId"], additionalProperties: false });
  });

  it("omits comment only when that role has it disabled", async () => {
    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, { jsonrpc: "2.0", id: 2, method: "tools/list" }], false);
    const tools = resultFor(responses, 2)["tools"] as { name: string }[];
    // The reads stay: neither of them can change anything, and
    // `comment_read` reaches nothing `item_detail` does not.
    expect(tools.map((tool) => tool.name)).toEqual(["item_detail", "ticket_detail", "attachment_read", "comment_read", "comment_search"]);
  });

  it("lists attachment metadata beside its owning comment without file bytes or paths", async () => {
    const comment = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "The brief is here." });
    const path = join(directory, "secret-brief.txt");
    writeFileSync(path, "FILE_BYTES_MUST_BE_LAZY");
    const attachmentId = uuidv7();
    insertAttachments(handle.db, [{ id: attachmentId, itemId: item.id, commentId: comment.id, storagePath: path, name: "brief.txt", mimeType: "text/plain", size: 23 }]);

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, {
      jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "thread_read", arguments: { key: item.key } },
    }], true, { EO_MCP_FULL_THREAD_ENABLED: "1" });
    const text = ((resultFor(responses, 3)["content"] as { text: string }[])[0]?.text ?? "");

    expect(text).toContain("The brief is here.");
    expect(text).toContain(`ID: ${attachmentId}`);
    expect(text).toContain("name: brief.txt; MIME type: text/plain; size: 23 bytes; origin: eo; synchronization state: local");
    expect(text).not.toContain(path);
    expect(text).not.toContain("FILE_BYTES_MUST_BE_LAZY");
  });

  /**
   * Who a module's comment is from, on the paths an agent reads it through.
   *
   * A module's comment has no agent row behind it — `author_id` is null
   * by construction — so the heading fell through to "unknown agent",
   * naming an agent for something no agent said, on the two views a
   * dispatched agent actually reads a thread through. Both tools share
   * `commentBlock`, so both are asserted rather than one standing in for
   * the other: `ticket_detail` renders it in the thread and
   * `comment_read` renders it nested under what it replies to.
   */
  it("names a module as the author of its comment, in the thread and in a subtree", async () => {
    const question = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Did it deploy?", kind: "question" });
    // Signed the way `postModuleComment` signs it: the module's own name
    // goes in the body, because the body is the only part Jira receives.
    postComment(handle.db, { itemId: item.id, author: { type: "module" }, parentId: question.id, body: "**Deploy** (module)\n\nStaging is up." });

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED,
      { jsonrpc: "2.0", id: 48, method: "tools/call", params: { name: "thread_read", arguments: { key: item.key } } },
      { jsonrpc: "2.0", id: 49, method: "tools/call", params: { name: "comment_read", arguments: { commentId: question.id } } },
    ], true, { EO_MCP_FULL_THREAD_ENABLED: "1" });

    const detail = (resultFor(responses, 48)["content"] as { text: string }[])[0]?.text ?? "";
    // Generic in the heading and specific in the body: the module names
    // itself exactly once, and nothing calls it an agent or calls it EO.
    expect(detail).toContain("### a module — note");
    expect(detail).toContain("**Deploy** (module)");
    expect(detail).not.toContain("unknown agent");

    const subtree = (resultFor(responses, 49)["content"] as { text: string }[])[0]?.text ?? "";
    expect(subtree).toContain("> ### a module — note");
    expect(subtree).toContain("> **Deploy** (module)");
    expect(subtree).not.toContain("unknown agent");
  });

  it("returns equivalent MCP content shapes for text, image and binary attachments", async () => {
    const comment = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Three formats." });
    const fixtures = [
      { id: uuidv7(), name: "note.txt", mimeType: "text/plain", bytes: Buffer.from("hello") },
      { id: uuidv7(), name: "pixel.png", mimeType: "image/png", bytes: Buffer.from([137, 80, 78, 71]) },
      { id: uuidv7(), name: "data.bin", mimeType: "application/octet-stream", bytes: Buffer.from([0, 1, 2, 3]) },
    ];
    for (const fixture of fixtures) {
      const path = join(directory, fixture.name);
      writeFileSync(path, fixture.bytes);
      insertAttachments(handle.db, [{ id: fixture.id, itemId: item.id, commentId: comment.id, storagePath: path, name: fixture.name, mimeType: fixture.mimeType, size: fixture.bytes.length }]);
    }

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, ...fixtures.map((fixture, index) => ({
      jsonrpc: "2.0", id: index + 10, method: "tools/call", params: { name: "attachment_read", arguments: { attachmentId: fixture.id } },
    }))]);

    expect((resultFor(responses, 10)["content"] as { type: string; text: string }[])[0]).toEqual({ type: "text", text: "hello" });
    expect((resultFor(responses, 10)["structuredContent"] as object)).toMatchObject({ mimeType: "text/plain" });
    expect((resultFor(responses, 11)["content"] as { type: string; mimeType: string }[])[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect((resultFor(responses, 12)["content"] as { type: string; resource: { uri: string; mimeType: string } }[])[0]).toMatchObject({
      type: "resource",
      resource: { uri: `eo-attachment://${fixtures[2]!.id}`, mimeType: "application/octet-stream" },
    });
  });

  it("lists the item's own files in item_detail, apart from a comment's, and reads them with attachment_read (EO-703)", async () => {
    const comment = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "A screenshot." });
    const fixtures = [
      { id: uuidv7(), name: "limits.txt", mimeType: "text/plain", bytes: Buffer.from("100 a minute"), commentId: null },
      { id: uuidv7(), name: "mock.png", mimeType: "image/png", bytes: Buffer.from([137, 80, 78, 71]), commentId: null },
      { id: uuidv7(), name: "shot.png", mimeType: "image/png", bytes: Buffer.from([137, 80, 78, 71]), commentId: comment.id },
    ];
    for (const fixture of fixtures) {
      const path = join(directory, fixture.name);
      writeFileSync(path, fixture.bytes);
      insertAttachments(handle.db, [{ id: fixture.id, itemId: item.id, commentId: fixture.commentId, storagePath: path, name: fixture.name, mimeType: fixture.mimeType, size: fixture.bytes.length }]);
    }
    const [text, image, onComment] = fixtures;

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED,
      { jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "item_detail", arguments: { key: item.key } } },
      { jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "attachment_read", arguments: { attachmentId: text!.id } } },
      { jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "attachment_read", arguments: { attachmentId: image!.id } } },
    ]);

    const detail = (resultFor(responses, 30)["content"] as { text: string }[])[0]?.text ?? "";
    const files = detail.slice(detail.indexOf("## Files"));
    expect(detail).toContain("## Files");
    expect(files).toContain("attachment_read");
    expect(files).toContain(`- ID: ${text!.id}; name: limits.txt; MIME type: text/plain; size: 12 bytes; origin: eo; synchronization state: local`);
    expect(files).toContain(`- ID: ${image!.id}; name: mock.png; MIME type: image/png`);
    expect(detail).not.toContain(onComment!.id);
    expect(detail).not.toContain(directory);

    expect((resultFor(responses, 31)["content"] as { type: string; text: string }[])[0]).toEqual({ type: "text", text: "100 a minute" });
    expect((resultFor(responses, 32)["content"] as { type: string; mimeType: string }[])[0]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("says nothing about files in item_detail for an item with none (EO-703)", async () => {
    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED,
      { jsonrpc: "2.0", id: 33, method: "tools/call", params: { name: "item_detail", arguments: { key: item.key } } },
    ]);

    expect((resultFor(responses, 33)["content"] as { text: string }[])[0]?.text ?? "").not.toContain("## Files");
  });

  it("returns typed, path-free errors for missing and unreadable IDs", async () => {
    const comment = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Gone." });
    const unreadableId = uuidv7();
    const missingPath = join(directory, "not-there.txt");
    insertAttachments(handle.db, [{ id: unreadableId, itemId: item.id, commentId: comment.id, storagePath: missingPath, name: "gone.txt", mimeType: "text/plain", size: 1 }]);

    const absentId = "0198a000-0000-7000-8000-000000000099" as Uuid;
    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED,
      { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "attachment_read", arguments: { attachmentId: absentId } } },
      { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "attachment_read", arguments: { attachmentId: unreadableId } } },
    ]);

    expect(resultFor(responses, 20)).toMatchObject({ isError: true, structuredContent: { error: { code: "ATTACHMENT_NOT_FOUND" } } });
    expect(resultFor(responses, 21)).toMatchObject({ isError: true, structuredContent: { error: { code: "ATTACHMENT_UNREADABLE" } } });
    expect(JSON.stringify([resultFor(responses, 20), resultFor(responses, 21)])).not.toContain(missingPath);
  });

  /**
   * The half of a collapsed exchange that has to be recoverable: a
   * pointer an agent cannot follow is a comment that was lost, and
   * "re-read the item" is the cost collapsing it was paying to avoid.
   */
  it("returns one comment and the replies under it, at any depth, and nothing else on the item", async () => {
    const unrelated = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "UNRELATED_CHATTER" });
    const question = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Which limit?", kind: "question" });
    const answer = postComment(handle.db, { itemId: item.id, author: { type: "engine" }, parentId: question.id, body: "The one in the spec." });
    // Two deep, which is what a discussion does as a matter of course and
    // what a one-level walk used to hide (KAN-69).
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, parentId: answer.id, body: "Then raise it." });

    const path = join(directory, "secret-brief.txt");
    writeFileSync(path, "FILE_BYTES_MUST_BE_LAZY");
    const attachmentId = uuidv7();
    insertAttachments(handle.db, [{ id: attachmentId, itemId: item.id, commentId: answer.id, storagePath: path, name: "brief.txt", mimeType: "text/plain", size: 23 }]);

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED,
      { jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "comment_read", arguments: { commentId: question.id } } },
      { jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "comment_read", arguments: { commentId: unrelated.id } } },
    ]);
    const text = (resultFor(responses, 40)["content"] as { text: string }[])[0]?.text ?? "";

    expect(text).toContain(item.key);
    expect(text).toContain("### you — question");
    expect(text).toContain("Which limit?");
    // Rendered as the thread section renders it: nested under what it
    // answers, one "> " per level.
    expect(text).toContain("> ### EO — note");
    expect(text).toContain("> The one in the spec.");
    expect(text).toContain("> > ### you — note");
    expect(text).toContain("> > Then raise it.");
    // Attachment IDs survive, their bytes and paths do not.
    expect(text).toContain(`ID: ${attachmentId}`);
    expect(text).not.toContain(path);
    expect(text).not.toContain("FILE_BYTES_MUST_BE_LAZY");
    // The point of the tool: a subtree, not the item.
    expect(text).not.toContain("UNRELATED_CHATTER");
    expect(text).not.toContain("Keep file bytes lazy.");

    expect((resultFor(responses, 41)["content"] as { text: string }[])[0]?.text).toContain("It has no replies.");
  });

  /**
   * When each comment was written, on every comment the tool returns.
   *
   * A subtree arrives with none of the thread around it: an agent that
   * followed a pointer out of a collapsed exchange cannot date a reply
   * from its neighbours, because it was not handed any. The stamp is
   * what puts the exchange back in order beside the rest of the run.
   */
  it("stamps the comment it was asked for and every reply under it", async () => {
    const question = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Which limit?", kind: "question" });
    const answer = postComment(handle.db, { itemId: item.id, author: { type: "engine" }, parentId: question.id, body: "The one in the spec." });
    const followUp = postComment(handle.db, { itemId: item.id, author: { type: "human" }, parentId: answer.id, body: "Then raise it." });
    // UTC, to the second: unambiguous about the zone and readable the
    // same way by every reader, which a locale format is not.
    const stamp = (createdAt: number): string => `${new Date(createdAt).toISOString().slice(0, 19)}Z`;

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED,
      { jsonrpc: "2.0", id: 46, method: "tools/call", params: { name: "comment_read", arguments: { commentId: question.id } } },
      { jsonrpc: "2.0", id: 47, method: "tools/call", params: { name: "thread_read", arguments: { key: item.key } } },
    ], true, { EO_MCP_FULL_THREAD_ENABLED: "1" });
    const text = (resultFor(responses, 46)["content"] as { text: string }[])[0]?.text ?? "";

    // The root, and a reply two levels below it: the stamp travels with
    // the recursive walk rather than sitting only on the comment the
    // caller named.
    expect(text).toContain(`### you — question — ${stamp(question.createdAt)}`);
    expect(text).toContain(`> ### EO — note — ${stamp(answer.createdAt)}`);
    expect(text).toContain(`> > ### you — note — ${stamp(followUp.createdAt)}`);

    // The same shared renderer, and `ticket_detail` is unchanged by it:
    // the whole thread already arrives in order, and landing this must
    // not alter what a dispatched agent reads.
    const detail = (resultFor(responses, 47)["content"] as { text: string }[])[0]?.text ?? "";
    expect(detail).toContain("### you — question\n");
    expect(detail).not.toContain(stamp(question.createdAt));
  });

  it("bounds a very large subtree and says how much it left out", async () => {
    const root = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "The question.", kind: "question" });
    for (let i = 0; i < 55; i++) {
      postComment(handle.db, { itemId: item.id, author: { type: "engine" }, parentId: root.id, body: `reply ${i}` });
    }

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED,
      { jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "comment_read", arguments: { commentId: root.id } } },
    ]);
    const text = (resultFor(responses, 42)["content"] as { text: string }[])[0]?.text ?? "";

    expect(text.match(/### EO — note/g)?.length).toBe(50);
    // Said, not dropped quietly — and it names where the rest is.
    expect(text).toContain("[5 further replies not shown.");
    expect(text).toContain(`Read ${item.key} with item_detail`);
  });

  it("says a comment id does not exist the way a missing attachment does", async () => {
    const absentId = "0198a000-0000-7000-8000-000000000098" as Uuid;
    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED,
      { jsonrpc: "2.0", id: 43, method: "tools/call", params: { name: "comment_read", arguments: { commentId: absentId } } },
      { jsonrpc: "2.0", id: 44, method: "tools/call", params: { name: "comment_read", arguments: {} } },
      { jsonrpc: "2.0", id: 45, method: "tools/call", params: { name: "comment_read", arguments: { commentId: "  " } } },
    ]);

    expect(resultFor(responses, 43)).toMatchObject({ isError: true, structuredContent: { error: { code: "COMMENT_NOT_FOUND" } } });
    expect((resultFor(responses, 43)["content"] as { text: string }[])[0]?.text).toContain(absentId);
    for (const id of [44, 45]) {
      expect(resultFor(responses, id)).toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_ARGUMENT" } } });
    }
  });

  it("hands a comment to EO and answers with what EO did, refusing a malformed one itself (EO-543)", async () => {
    const { asked, bridge } = await scriptedBridge((request) =>
      (request.args as { blocking?: boolean }).blocking === true
        ? { ok: true, text: "Comment posted and the people you mentioned have been notified. Your run ends here; it will resume when someone replies. Stop working now.", data: { commentId: "c-1", blocking: true } }
        : { ok: false, code: "MENTION_REFUSED", problem: 'The comment was not posted. Unknown mention "nobody".' },
    );
    try {
      const env = eoMcpStdioConfig({ serverPath, dbPath, enableCommentTool: true, writeBridge: bridge.tokenFor(item.id) }).env;
      const responses = await callServer(
        dbPath,
        [
          INITIALIZE,
          INITIALIZED,
          { jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "comment", arguments: { body: "@user choose", mentions: ["user"], blocking: true } } },
          { jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "comment", arguments: { blocking: true } } },
          { jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "comment", arguments: { body: "over to you", mentions: ["nobody"] } } },
        ],
        true,
        env,
      );
      // EO's answer, on both of the result's parts: Claude shows an agent
      // the structured one, Codex the text.
      expect(resultFor(responses, 30)).toEqual({
        content: [{ type: "text", text: expect.stringContaining("Stop working now.") as unknown }],
        structuredContent: { commentId: "c-1", blocking: true, text: expect.stringContaining("Stop working now.") as unknown },
      });
      // Malformed: refused here, and EO never asked.
      expect(resultFor(responses, 31)).toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_ARGUMENT" } } });
      // Refused by EO: its code and its reason, nothing claimed.
      expect(resultFor(responses, 32)).toEqual({
        isError: true,
        content: [{ type: "text", text: 'MENTION_REFUSED: The comment was not posted. Unknown mention "nobody".' }],
        structuredContent: { error: { code: "MENTION_REFUSED", message: 'The comment was not posted. Unknown mention "nobody".' }, text: 'MENTION_REFUSED: The comment was not posted. Unknown mention "nobody".' },
      });
      expect(asked).toEqual([
        { itemId: item.id, request: { tool: COMMENT_TOOL_NAME, args: { body: "@user choose", mentions: ["user"], blocking: true } } },
        { itemId: item.id, request: { tool: COMMENT_TOOL_NAME, args: { body: "over to you", mentions: ["nobody"] } } },
      ]);
      // The service itself still writes nothing: its database is read-only.
      expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
    } finally {
      await bridge.close();
    }
  });

  it("answers that nothing was written, never that it was, when EO cannot be asked", async () => {
    const closed = await startAgentWriteBridge(() => Promise.resolve({ ok: true, text: "unreachable", data: {} }));
    const address = closed.tokenFor(item.id);
    await closed.close();
    const call = { jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "comment", arguments: { body: "fyi" } } };

    // No bridge given to the turn, and one given that is no longer there.
    const without = await callServer(dbPath, [INITIALIZE, INITIALIZED, call], true);
    const gone = await callServer(dbPath, [INITIALIZE, INITIALIZED, call], true, { EO_MCP_WRITE_BRIDGE: JSON.stringify(address) });
    for (const responses of [without, gone]) {
      expect(resultFor(responses, 40)).toMatchObject({ isError: true, structuredContent: { error: { code: "EO_UNREACHABLE" } } });
      expect((resultFor(responses, 40)["content"] as { text: string }[])[0]?.text).toContain("nothing");
    }
  });
});

/** What the pipeline architect reads before it proposes anything. */
describe("the configuration tools", () => {
  let directory: string;
  let dbPath: string;
  let handle: DbHandle;

  const CONFIG_ON = { EO_MCP_CONFIG_ENABLED: "1" };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo mcp config "));
    dbPath = join(directory, "eo.db");
    handle = openDb(dbPath);
    runMigrations(handle.db, migrationsFolder);
  });

  afterEach(() => {
    handle.close();
    // The service runs as a subprocess and opens the same database file;
    // closing our own handle does not mean its is gone yet.
    removeScratch(directory);
  });

  function textOf(responses: Record<string, unknown>[], id: number): string {
    return (resultFor(responses, id)["content"] as { text: string }[])[0]?.text ?? "";
  }

  /**
   * The pair, and the version the old half is on a clock for (KAN-162).
   *
   * `eoServer.mjs` ships unbundled — Codex spawns it by path, so it
   * resolves nothing but Node's own builtins — which is why the
   * retirement version is written there as well as in `@eo/core`. This
   * is what keeps the two agreeing: the notice this file serves has to
   * be the one core composes, character for character.
   */
  it("advertises item_detail beside the name it replaces, with the notice core composes", async () => {
    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    const tools = resultFor(responses, 2)["tools"] as { name: string; description: string; inputSchema: Record<string, unknown> }[];

    const current = tools.find((entry) => entry.name === "item_detail");
    const deprecated = tools.find((entry) => entry.name === "ticket_detail");

    expect(deprecated?.description).toBe(`${deprecationNotice("item_detail")} ${current?.description ?? ""}`);
    expect(deprecated?.description).toContain(`v${ALIAS_RETIREMENT_VERSION}`);
    // And the two take the same argument, because they are one tool.
    expect(deprecated?.inputSchema).toEqual(current?.inputSchema);
  });

  it("answers identically whichever of the two names was called", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Read attachments", stepId: "todo", body: "Do the thing." });

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED,
      { jsonrpc: "2.0", id: 70, method: "tools/call", params: { name: "item_detail", arguments: { key: item.key } } },
      { jsonrpc: "2.0", id: 71, method: "tools/call", params: { name: "ticket_detail", arguments: { key: item.key } } },
    ]);

    expect(resultFor(responses, 70)).toEqual(resultFor(responses, 71));
    expect(textOf(responses, 70)).toContain("Do the thing.");
  });

  it("refuses a bad argument in the same words from either name", async () => {
    // EO's own name for the tool, from both doors. A refusal that
    // echoed `ticket_detail` would be the one sentence in the pair that
    // told a caller which of the two names it had used — and it would
    // name the door that is due to close.
    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED,
      { jsonrpc: "2.0", id: 72, method: "tools/call", params: { name: "item_detail", arguments: {} } },
      { jsonrpc: "2.0", id: 73, method: "tools/call", params: { name: "ticket_detail", arguments: {} } },
    ]);

    expect(resultFor(responses, 72)).toEqual(resultFor(responses, 73));
    expect(textOf(responses, 72)).toContain("item_detail requires");
  });

  it("answers item_detail with the item and not its discussion", async () => {
    // The whole point of the split: an agent working an item gets what
    // the item is, bounded, however long the argument about it has been.
    const item = createTestItem(handle.db, { type: "story", title: "Read attachments", stepId: "todo", body: "Do the thing." });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "A long argument about it." });

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, {
      jsonrpc: "2.0", id: 60, method: "tools/call", params: { name: "ticket_detail", arguments: { key: item.key } },
    }]);
    const text = (resultFor(responses, 60)["content"] as { text: string }[])[0]?.text ?? "";

    expect(text).toContain("Do the thing.");
    expect(text).not.toContain("A long argument about it.");
    // …and says where it went, rather than leaving the agent to assume
    // the discussion does not exist.
    expect(text).toContain("comment_search");
  });

  it("answers item_detail for a feature, which has no step", async () => {
    // A feature sits above the pipeline: no step, no pipeline. The lookup
    // used to inner-join the step table and so told an implementer that
    // its parent — the feature holding the why and the scope it was sent
    // to read — did not exist, while the board listing showed the key.
    const feature = createTestItem(handle.db, { type: "feature", title: "Platform phase 1", stepId: null, body: "The pack boundary." });
    const story = createTestItem(handle.db, { type: "story", title: "Split the IPC contract", stepId: "todo", parentId: feature.id });

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, {
      jsonrpc: "2.0", id: 63, method: "tools/call", params: { name: "ticket_detail", arguments: { key: feature.key } },
    }]);
    const text = textOf(responses, 63);

    expect(text).not.toContain("No ticket with key");
    expect(text).toContain(`# ${feature.key} — Platform phase 1`);
    expect(text).toContain("The pack boundary.");
    // Said rather than rendered as "step: null": the agent should learn
    // where the steps are, not wonder whether the row is broken.
    expect(text).toContain("- step: none");
    // The useful half of a feature is what hangs under it.
    expect(text).toContain("## Children");
    expect(text).toContain(`${story.key} (story, todo) — Split the IPC contract`);
  });

  it("refuses thread_read for a role that was not given it", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Gated", stepId: "todo" });

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, {
      jsonrpc: "2.0", id: 61, method: "tools/call", params: { name: "thread_read", arguments: { key: item.key } },
    }]);
    const result = resultFor(responses, 61);

    expect(result["isError"]).toBe(true);
    expect(JSON.stringify(result)).toContain("TOOL_DISABLED");
  });

  it("finds a comment by pattern, with its id and no reply tree", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Searchable", stepId: "todo" });
    const question = postComment(handle.db, { itemId: item.id, author: { type: "human" }, kind: "question", body: "Should we use the per-item limit?" });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, parentId: question.id, body: "Yes — the per-item one." });

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, {
      jsonrpc: "2.0", id: 62, method: "tools/call", params: { name: "comment_search", arguments: { key: item.key, pattern: "PER-ITEM" } },
    }]);
    const text = (resultFor(responses, 62)["content"] as { text: string }[])[0]?.text ?? "";

    // Case-insensitive, because the caller is searching prose for a word.
    expect(text).toContain(question.id);
    // An excerpt, not the comment: a search that answered with bodies
    // would rebuild the prompt the seed exists to avoid, one call at a time.
    expect(text).toContain("per-item limit");
    // The reply is a match of its own, and says where its exchange is.
    expect(text).toContain("comment_read");
  });

  it("says plainly when nothing matches, rather than answering with an empty list", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Searchable", stepId: "todo" });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Nothing to see." });

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, {
      jsonrpc: "2.0", id: 63, method: "tools/call", params: { name: "comment_search", arguments: { key: item.key, pattern: "rollback" } },
    }]);

    expect((resultFor(responses, 63)["content"] as { text: string }[])[0]?.text).toContain("No comment on");
  });

  it("refuses a pattern that is not a regular expression instead of guessing", async () => {
    // Never a substring fallback: an agent that asked for a pattern and
    // silently got something else cannot reason about what came back.
    const item = createTestItem(handle.db, { type: "story", title: "Searchable", stepId: "todo" });

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, {
      jsonrpc: "2.0", id: 64, method: "tools/call", params: { name: "comment_search", arguments: { key: item.key, pattern: "(unclosed" } },
    }]);
    const result = resultFor(responses, 64);

    expect(result["isError"]).toBe(true);
    expect(JSON.stringify(result)).toContain("INVALID_ARGUMENT");
  });

  it("refuses a pattern long enough to be something other than a search", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Searchable", stepId: "todo" });

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, {
      jsonrpc: "2.0", id: 65, method: "tools/call", params: { name: "comment_search", arguments: { key: item.key, pattern: "a".repeat(201) } },
    }]);

    expect(resultFor(responses, 65)["isError"]).toBe(true);
  });

  it("advertises all five only when the role has them enabled", async () => {
    const on = await callServer(dbPath, [INITIALIZE, INITIALIZED, { jsonrpc: "2.0", id: 2, method: "tools/list" }], false, CONFIG_ON);
    expect((resultFor(on, 2)["tools"] as { name: string }[]).map((tool) => tool.name)).toEqual([
      "item_detail",
      "ticket_detail",
      "attachment_read",
      "comment_read",
      "comment_search",
      "pipeline_list",
      "pipeline_read",
      "agents_list",
      "agent_read",
      "runtimes_list",
    ]);

    const off = await callServer(dbPath, [INITIALIZE, INITIALIZED, { jsonrpc: "2.0", id: 2, method: "tools/list" }], false);
    expect((resultFor(off, 2)["tools"] as { name: string }[]).map((tool) => tool.name)).toEqual(["item_detail", "ticket_detail", "attachment_read", "comment_read", "comment_search"]);
  });

  it("refuses them when they are not enabled, rather than answering", async () => {
    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pipeline_list", arguments: {} } },
    ]);
    expect(resultFor(responses, 3)).toMatchObject({ isError: true, structuredContent: { error: { code: "TOOL_DISABLED" } } });
  });

  it("lists the pipelines that hold work, and not the conversation pipeline", async () => {
    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED,
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pipeline_list", arguments: {} } },
    ], false, CONFIG_ON);

    const text = textOf(responses, 4);
    expect(text).toContain("`default`");
    // Every step of it is off-board, so it is not something anyone
    // configures — the same test `pipelines:list` applies.
    expect(text).not.toContain("`discussions`");
  });

  it("reads one pipeline's steps and routes, including what holds items", async () => {
    createTestItem(handle.db, { type: "story", title: "In flight", stepId: "review" });

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED,
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "pipeline_read", arguments: { pipelineId: "default" } } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "pipeline_read", arguments: { pipelineId: "nope" } } },
    ], false, CONFIG_ON);

    const text = textOf(responses, 5);
    expect(text).toContain("work enters at: worktree");
    expect(text).toContain("`review` **Review**");
    expect(text).toContain("`reviewer` runs `review`");
    // What makes changing a step consequential rather than structural.
    expect(text).toContain("1 ticket(s) sitting here right now");
    expect(text).toContain("`review` / `changes_requested` → `todo`");
    // A builtin names a function EO ships.
    expect(text).toContain("EO runs `create_worktree`");

    expect(textOf(responses, 6)).toContain('No pipeline with id "nope"');
  });

  /**
   * The reason this listing exists at all: deciding whether an agent that
   * already exists can own a new step is a question about what it is
   * instructed to do, which its name and role cannot answer.
   */
  it("says what each agent does and which steps it owns", async () => {
    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED,
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "agents_list", arguments: {} } },
    ], false, CONFIG_ON);

    const text = textOf(responses, 7);
    expect(text).toContain("## Reviewer");
    expect(text).toContain("role: `reviewer`");
    expect(text).toContain("what it does:");
    expect(text).toContain("Delivery / Review (`review`)");
    // The system agent owns no step — it is not a role that does work in
    // a column, and saying so is what stops one being wired to it.
    expect(text).toContain("## System");
    expect(text).toContain("owns no steps");
    // And the retired architect is not offered at all (EO-186). It is
    // archived, so it staffs nothing, and a step owned by its role would
    // wait for a dispatch that never comes.
    expect(text).not.toContain("## Architect");
  });

  it("reads one agent's full instructions", async () => {
    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED,
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "agent_read", arguments: { name: "reviewer" } } },
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "agent_read", arguments: { name: "Nobody" } } },
    ], false, CONFIG_ON);

    // Matched case-insensitively: the name is what a person typed.
    expect(textOf(responses, 8)).toContain("## Instructions");
    expect(textOf(responses, 9)).toContain('No agent named "Nobody"');
  });

  it("reports which runtimes are installed, from EO's own cache layout", async () => {
    mkdirSync(join(directory, "runtimes", "codex@0.147.0-linux-x64"), { recursive: true });
    // An interrupted download must not read as installed.
    mkdirSync(join(directory, "runtimes", "claude@0.3.227.partial"), { recursive: true });

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED,
      { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "runtimes_list", arguments: {} } },
    ], false, { ...CONFIG_ON, EO_MCP_RUNTIME_ROOT: join(directory, "runtimes") });

    const text = textOf(responses, 10);
    expect(text).toContain("`codex` **Codex** — installed and enabled");
    expect(text).toContain("`claude` **Claude Code** — not installed");
  });

  it("says it cannot tell when EO has not told it where the cache is", async () => {
    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED,
      { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "runtimes_list", arguments: {} } },
    ], false, CONFIG_ON);

    // Better than claiming both are missing: advising an install of
    // something already present is worse than staying quiet.
    expect(textOf(responses, 11)).toContain("cannot tell whether it is installed");
  });

  it("rejects arguments the advertised schemas do not allow", async () => {
    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED,
      { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "pipeline_list", arguments: { projectId: "x" } } },
      { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "pipeline_read", arguments: {} } },
      { jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "agent_read", arguments: { name: "  " } } },
    ], false, CONFIG_ON);

    for (const id of [12, 13, 14]) {
      expect(resultFor(responses, id)).toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_ARGUMENT" } } });
    }
  });
});

/**
 * The service is shipped unbundled and launched as a bare Node process,
 * so it cannot import `packages/core` and keeps its own copy of this.
 * The duplication is safe only because this test pins the two together.
 */
describe("summarizeInstructions agrees with packages/core", () => {
  it.each([
    "Implements scoped changes.\nMore detail.",
    "<!-- prompt-version: 3 -->\n\n# Reviewer\n\nReviews code and ensures quality.",
    "",
    "# Only a heading",
    "   \n\n  Indented first line.  ",
    "<!-- a -->\n<!-- b -->\nAfter two comments.",
  ])("matches on %j", (instructions) => {
    expect(serviceSummarize(instructions)).toEqual(summarizeInstructions(instructions));
  });
});

/**
 * `attachment_add` (EO-412): the service validates a call and answers it,
 * and writes nothing — the supervisor does that, off the run's event
 * stream. So everything here is about what is listed and what is said.
 */
describe("attachment_add on the shared EO MCP service", () => {
  let directory: string;
  let workspace: string;
  let dbPath: string;
  let handle: DbHandle;
  let item: Item;
  let runId: Uuid;
  let bridge: AgentWriteBridge;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "eo mcp attach "));
    workspace = join(directory, "workspace");
    mkdirSync(join(workspace, "shots"), { recursive: true });
    dbPath = join(directory, "eo.db");
    handle = openDb(dbPath);
    runMigrations(handle.db, migrationsFolder);
    item = createTestItem(handle.db, { type: "story", title: "Attach evidence", stepId: "todo" });
    runId = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", cwd: workspace }).id;
    // EO's half, as the supervisor does it (EO-543): the call handed over
    // the bridge is checked and written by `attachRunFiles`, against the
    // directory the run works in and into a real store.
    const storage = new AttachmentStorage(join(directory, "attachments"));
    const agent = listAgents(handle.db).find((entry) => entry.role === "implementer")!;
    bridge = await startAgentWriteBridge((itemId, request) =>
      attachRunFiles({ db: handle.db, store: storage, itemId: itemId as Uuid, runId, agent: { id: agent.id, name: agent.name }, directory: workspace, args: request.args }),
    );
  });

  afterEach(async () => {
    await bridge.close();
    handle.close();
    removeScratch(directory);
  });

  /** The environment either adapter gives the service on a turn of this run — built by the function both of them call. */
  const turnEnvironment = (): Record<string, string> =>
    eoMcpStdioConfig({ serverPath, dbPath, attachFrom: { runId, directory: workspace }, writeBridge: bridge.tokenFor(item.id) }).env;

  const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const call = (id: number, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: ATTACHMENT_ADD_TOOL_NAME, arguments: args } });
  const answerOf = (responses: Record<string, unknown>[], id: number): { isError?: boolean; text: string; structured: unknown } => {
    const result = resultFor(responses, id) as { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
    return { ...(result.isError ? { isError: true } : {}), text: result.content[0]?.text ?? "", structured: result.structuredContent };
  };
  const write = (relativePath: string, content = "bytes"): void => writeFileSync(join(workspace, relativePath), content);

  it("is listed on a turn told which run it is and where that run works, and not otherwise", async () => {
    const withRun = await callServer(dbPath, [INITIALIZE, INITIALIZED, LIST], false, turnEnvironment());
    const tools = resultFor(withRun, 2)["tools"] as { name: string; description: string; inputSchema: Record<string, unknown> }[];
    // `repository_checkout` beside them, because this turn has a bridge (EO-633).
    expect(tools.map((tool) => tool.name)).toEqual(["item_detail", "ticket_detail", "attachment_read", "attachment_add", "comment_read", "comment_search", REPOSITORY_CHECKOUT_TOOL_NAME]);

    const without = await callServer(dbPath, [INITIALIZE, INITIALIZED, LIST], false);
    expect((resultFor(without, 2)["tools"] as { name: string }[]).map((tool) => tool.name)).not.toContain(ATTACHMENT_ADD_TOOL_NAME);
    // A run id with no directory is a tool with nothing to check a path against.
    const half = await callServer(dbPath, [INITIALIZE, INITIALIZED, LIST], false, { EO_MCP_RUN_ID: runId });
    expect((resultFor(half, 2)["tools"] as { name: string }[]).map((tool) => tool.name)).not.toContain(ATTACHMENT_ADD_TOOL_NAME);
  });

  it("takes paths and a caption and nothing a caption could ask somebody with", async () => {
    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, LIST], false, turnEnvironment());
    const tool = (resultFor(responses, 2)["tools"] as { name: string; description: string; inputSchema: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } }[]).find(
      (entry) => entry.name === ATTACHMENT_ADD_TOOL_NAME,
    )!;

    expect(Object.keys(tool.inputSchema.properties)).toEqual(["paths", "caption"]);
    expect(tool.inputSchema).toMatchObject({ required: ["paths"], additionalProperties: false });
    // Invariant 12: the description is read on both backends, so it is
    // written in neither's spelling of a tool name.
    expect(tool.description).not.toContain(eoToolName(""));
    expect(tool.description).not.toMatch(/\beo\//);
  });

  it("hands an accepted call to EO and answers with the comment and the attachments EO wrote", async () => {
    write("shots/before.png");
    write("shots/after.png");
    write("test.log");

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, call(3, { paths: ["shots/before.png", "shots/after.png", "test.log"], caption: "Before and after." })], false, turnEnvironment());
    const answer = answerOf(responses, 3);

    // Written by EO before the tool answered, so the answer can name what exists.
    const [comment] = listCommentsForItem(handle.db, item.id);
    expect(comment?.body).toBe("Before and after.");
    const attached = (comment?.attachments ?? []).map((attachment) => ({ attachmentId: attachment.id, name: attachment.name }));
    expect(attached.map((attachment) => attachment.name)).toEqual(["before.png", "after.png", "test.log"]);
    expect(answer.isError).toBeUndefined();
    for (const { attachmentId } of attached) expect(answer.text).toContain(attachmentId);
    expect(answer.structured).toEqual({ commentId: comment?.id, attached, text: answer.text });
  });

  it("accepts an absolute path that is inside the run's directory, which is a spelling and not an escape", async () => {
    write("test.log");
    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, call(3, { paths: [join(workspace, "test.log")] })], false, turnEnvironment());
    expect(answerOf(responses, 3).isError).toBeUndefined();
  });

  it("refuses each kind of path it must not attach, naming the file and the reason", async () => {
    const outside = join(directory, "secret.txt");
    writeFileSync(outside, "not the run's");
    write("real.txt");
    // Creating a link needs a privilege a Windows runner does not have,
    // so the two link cases are left out there — as every other symlink
    // test in this repository is.
    const links = process.platform !== "win32";
    if (links) {
      symlinkSync(outside, join(workspace, "link.txt"));
      symlinkSync(directory, join(workspace, "linked-directory"));
    }
    writeFileSync(join(workspace, "huge.bin"), "");
    truncateSync(join(workspace, "huge.bin"), MAX_ATTACHMENT_BYTES + 1);

    const cases = (
      [
        ["missing.png", "does not exist"],
        ["shots", "is a directory"],
        ["link.txt", "symbolic link"],
        ["linked-directory/secret.txt", "symbolic link"],
        ["../secret.txt", "outside the directory this run works in"],
        [outside, "outside the directory this run works in"],
        ["huge.bin", "larger than the 20 MB attachment limit"],
      ] as [string, string][]
    ).filter(([, reason]) => links || reason !== "symbolic link");
    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, ...cases.map(([path], index) => call(10 + index, { paths: ["real.txt", path] }))], false, turnEnvironment());

    for (const [index, [path, reason]] of cases.entries()) {
      const answer = answerOf(responses, 10 + index);
      expect(answer.isError, path).toBe(true);
      expect(answer.text, path).toContain(`"${path}"`);
      expect(answer.text, path).toContain(reason);
      // One refused path refuses the call: the good file beside it is not attached either.
      expect(answer.text, path).toContain("Nothing was attached.");
    }
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
  });

  it("refuses a ninth path in one call, naming it", async () => {
    const paths = Array.from({ length: MAX_ATTACHMENT_ADD_PATHS + 1 }, (_unused, index) => `file-${index}.txt`);
    for (const path of paths) write(path);

    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, call(3, { paths }), call(4, { paths: paths.slice(0, MAX_ATTACHMENT_ADD_PATHS) })], false, turnEnvironment());

    const refused = answerOf(responses, 3);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('"file-8.txt"');
    expect(refused.text).toContain("at most 8 files");
    expect(answerOf(responses, 4).isError).toBeUndefined();
  });

  it("refuses the call that would take the run past sixteen files, counting what the run has attached already", async () => {
    for (let index = 0; index < 20; index += 1) write(`file-${index}.txt`);
    // Seven already on the item from this run, as the supervisor leaves them.
    const comment = postComment(handle.db, { itemId: item.id, runId, author: { type: "engine" }, body: "Earlier." });
    insertAttachments(handle.db, Array.from({ length: 7 }, (_unused, index) => ({
      id: uuidv7(), itemId: item.id, commentId: comment.id, storagePath: join(directory, `stored-${index}`), name: `stored-${index}.txt`, mimeType: "text/plain", size: 1, managed: true, createdAt: 1,
    })));

    const eight = Array.from({ length: 8 }, (_unused, index) => `file-${index}.txt`);
    const responses = await callServer(
      dbPath,
      [
        INITIALIZE,
        INITIALIZED,
        // 7 stored + 8 = 15: attached.
        call(3, { paths: eight }),
        // 15 + 2 = 17: refused, naming the one that goes over.
        call(4, { paths: ["file-8.txt", "file-9.txt"] }),
        // 15 + 1 = 16 is the cap, not past it.
        call(5, { paths: ["file-8.txt"] }),
        call(6, { paths: ["file-9.txt"] }),
      ],
      false,
      turnEnvironment(),
    );

    expect(answerOf(responses, 3).isError).toBeUndefined();
    const past = answerOf(responses, 4);
    expect(past.isError).toBe(true);
    expect(past.text).toContain('"file-9.txt"');
    expect(past.text).toContain(`at most ${MAX_RUN_ATTACHMENTS}`);
    expect(past.text).not.toContain('"file-8.txt"');
    expect(answerOf(responses, 5).isError).toBeUndefined();
    expect(answerOf(responses, 6).isError).toBe(true);
  });

  it("refuses arguments the schema does not name, so a caption cannot grow a mention", async () => {
    write("test.log");
    const responses = await callServer(
      dbPath,
      [INITIALIZE, INITIALIZED, call(3, { paths: ["test.log"], mentions: ["user"] }), call(4, { paths: [] }), call(5, { paths: "test.log" }), call(6, { paths: ["test.log"], blocking: true })],
      false,
      turnEnvironment(),
    );
    for (const id of [3, 4, 5, 6]) expect(resultFor(responses, id)).toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_ARGUMENT" } } });
  });

  it("refuses a call on a turn it was not listed for, rather than attaching from nowhere", async () => {
    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, call(3, { paths: ["test.log"] })], false);
    expect(resultFor(responses, 3)).toMatchObject({ isError: true, structuredContent: { error: { code: "TOOL_DISABLED" } } });
  });

  it("keeps the limit it restates for the module host equal to the one it restates", () => {
    // `checkAttachmentPath` is the module host's now, and ships alone
    // with this file; this holds its copy of the size limit to the store's.
    const own = service as Record<string, unknown>;
    expect(own["MAX_ATTACHMENT_ADD_BYTES"]).toBe(MAX_ATTACHMENT_BYTES);
    // And the prefix EO once read a write off is gone (EO-543).
    expect(own["ATTACHMENT_ADD_ACCEPTED_PREFIX"]).toBeUndefined();
  });
});

describe("memory_read on the shared EO MCP service (EO-478)", () => {
  let directory: string;
  let dbPath: string;
  let handle: DbHandle;
  let projectScope: { kind: "project"; id: string; name: string };
  let workspaceScope: { kind: "workspace"; id: string; name: string };
  let elsewhere: { kind: "workspace"; id: string };
  const ids: Record<string, string> = {};

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo mcp memory "));
    dbPath = join(directory, "eo.db");
    handle = openDb(dbPath);
    runMigrations(handle.db, migrationsFolder);
    const app = attachWorkspace(handle.db, { keyPrefix: "P", name: "app", repoPath: "/tmp/app" });
    const other = attachWorkspace(handle.db, { keyPrefix: "Q", name: "other", repoPath: "/tmp/other" });
    projectScope = { kind: "project", id: app.projectId!, name: "P" };
    workspaceScope = { kind: "workspace", id: app.id, name: "app" };
    elsewhere = { kind: "workspace", id: other.id };
    const add = (key: string, scope: { kind: "project" | "workspace"; id: string }, body: string, now: number) => {
      const written = addMemory(handle.db, { scope, body, source: { type: "person", personId: null }, now });
      if (!written.ok) throw new Error(written.problem);
      ids[key] = written.entry.id;
    };
    add("setup", projectScope, "Run pnpm install before the tests.\nThe lockfile is checked.", 1_000);
    add("display", workspaceScope, "The e2e suite needs a display.", 2_000);
    add("secret", elsewhere, "Another project's entry.", 3_000);
    add("retired", workspaceScope, "An entry somebody retired.", 4_000);
    retireMemory(handle.db, ids["retired"]!);
  });

  afterEach(() => {
    handle.close();
    removeScratch(directory);
  });

  /** The environment either adapter gives the service on a turn delivered memory — built by the function both of them call. */
  const turnEnvironment = (): Record<string, string> => eoMcpStdioConfig({ serverPath, dbPath, memoryScopes: [projectScope, workspaceScope] }).env;
  const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const call = (id: number, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: MEMORY_READ_TOOL_NAME, arguments: args } });
  const textOf = (responses: Record<string, unknown>[], id: number): { isError: boolean; text: string } => {
    const result = resultFor(responses, id) as { isError?: boolean; content: { text: string }[] };
    return { isError: result.isError === true, text: result.content[0]?.text ?? "" };
  };

  it("pins its name to packages/core", () => {
    expect((service as { MEMORY_READ_TOOL_NAME: string }).MEMORY_READ_TOOL_NAME).toBe(MEMORY_READ_TOOL_NAME);
  });

  it("takes a container's scope as it takes a project's and a workspace's, and no other kind (EO-596)", () => {
    const parse = (service as { parseMemoryScopes: (raw: unknown) => unknown[] }).parseMemoryScopes;
    const container = { kind: "container", id: "c1", name: "P-7 Rate limiting" };
    expect(parse(JSON.stringify([projectScope, container, { kind: "feature", id: "f1", name: "F" }]))).toEqual([projectScope, container]);
  });

  it("is listed on a turn told which scopes it may read, and not otherwise", async () => {
    const withScopes = await callServer(dbPath, [INITIALIZE, INITIALIZED, LIST], false, turnEnvironment());
    const tools = resultFor(withScopes, 2)["tools"] as { name: string; description: string; inputSchema: Record<string, unknown> }[];
    expect(tools.map((tool) => tool.name)).toEqual(["item_detail", "ticket_detail", "attachment_read", "comment_read", "comment_search", MEMORY_READ_TOOL_NAME]);
    const tool = tools.find((entry) => entry.name === MEMORY_READ_TOOL_NAME)!;
    expect(tool.inputSchema).toMatchObject({ required: [], additionalProperties: false });
    // Invariant 12: read on both backends, so in neither's spelling.
    expect(tool.description).not.toContain(eoToolName(""));

    const without = await callServer(dbPath, [INITIALIZE, INITIALIZED, LIST], false);
    expect((resultFor(without, 2)["tools"] as { name: string }[]).map((entry) => entry.name)).not.toContain(MEMORY_READ_TOOL_NAME);
    const garbled = await callServer(dbPath, [INITIALIZE, INITIALIZED, LIST], false, { EO_MCP_MEMORY_SCOPES: "{not json" });
    expect((resultFor(garbled, 2)["tools"] as { name: string }[]).map((entry) => entry.name)).not.toContain(MEMORY_READ_TOOL_NAME);
  });

  it("lists the scopes, a scope's active entries by id and first line, and one entry in full", async () => {
    const responses = await callServer(
      dbPath,
      [INITIALIZE, INITIALIZED, call(3, {}), call(4, { scope: workspaceScope.id }), call(5, { scope: projectScope.id }), call(6, { entryId: ids["setup"] })],
      false,
      turnEnvironment(),
    );

    const scopes = textOf(responses, 3).text;
    expect(scopes).toContain(`Project: P (scope ${projectScope.id}) — 1 entry`);
    expect(scopes).toContain(`Workspace: app (scope ${workspaceScope.id}) — 1 entry`);

    const workspaceListing = textOf(responses, 4).text;
    expect(workspaceListing).toContain(`- ${ids["display"]} (written 1970-01-01): The e2e suite needs a display.`);
    // Retired entries are not listed.
    expect(workspaceListing).not.toContain("retired");

    const projectListing = textOf(responses, 5).text;
    expect(projectListing).toContain(`- ${ids["setup"]} (written 1970-01-01): Run pnpm install before the tests.`);
    expect(projectListing).not.toContain("The lockfile is checked.");

    const entry = textOf(responses, 6);
    expect(entry.isError).toBe(false);
    expect(entry.text).toContain("Run pnpm install before the tests.\nThe lockfile is checked.");
    expect(entry.text).toContain(`Project: P (scope ${projectScope.id})`);
  });

  it("reads nothing outside the scopes it was given, and refuses a malformed call", async () => {
    const responses = await callServer(
      dbPath,
      [INITIALIZE, INITIALIZED, call(3, { entryId: ids["secret"] }), call(4, { scope: elsewhere.id }), call(5, { scope: workspaceScope.id, entryId: ids["display"] }), call(6, { other: 1 })],
      false,
      turnEnvironment(),
    );

    expect(textOf(responses, 3)).toMatchObject({ isError: true, text: expect.stringContaining("MEMORY_NOT_FOUND") });
    expect(textOf(responses, 3).text).not.toContain("Another project's entry.");
    expect(textOf(responses, 4)).toMatchObject({ isError: true, text: expect.stringContaining("SCOPE_NOT_FOUND") });
    expect(textOf(responses, 5)).toMatchObject({ isError: true, text: expect.stringContaining("INVALID_ARGUMENT") });
    expect(textOf(responses, 6)).toMatchObject({ isError: true, text: expect.stringContaining("INVALID_ARGUMENT") });
  });

  it("refuses on a turn that was given no memory", async () => {
    const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, call(3, {})], false);
    expect(textOf(responses, 3)).toMatchObject({ isError: true, text: expect.stringContaining("TOOL_DISABLED") });
  });
});

describe("memory_note on the shared EO MCP service (EO-479)", () => {
  let directory: string;
  let dbPath: string;
  let handle: DbHandle;
  let projectScope: { kind: "project"; id: string; name: string };
  let workspaceScope: { kind: "workspace"; id: string; name: string };
  let elsewhere: string;
  let item: Item;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo mcp memory note "));
    dbPath = join(directory, "eo.db");
    handle = openDb(dbPath);
    runMigrations(handle.db, migrationsFolder);
    const app = attachWorkspace(handle.db, { keyPrefix: "P", name: "app", repoPath: "/tmp/app" });
    const other = attachWorkspace(handle.db, { keyPrefix: "Q", name: "other", repoPath: "/tmp/other" });
    projectScope = { kind: "project", id: app.projectId!, name: "P" };
    workspaceScope = { kind: "workspace", id: app.id, name: "app" };
    elsewhere = other.id;
    item = createTestItem(handle.db, { type: "story", title: "Note something", stepId: "todo" });
  });

  afterEach(() => {
    handle.close();
    removeScratch(directory);
  });

  /**
   * The environment either adapter gives the service for an agent with
   * this allowlist, on a turn told its scopes — the grant read by the
   * predicate `engine.ts` asks, and the environment built by the function
   * both adapters call.
   */
  const turnEnvironment = (allowedTools: string[] | undefined, scopes = [projectScope, workspaceScope], bridge?: AgentWriteBridge): Record<string, string> =>
    eoMcpStdioConfig({
      serverPath,
      dbPath,
      memoryScopes: scopes,
      enableMemoryNote: memoryNoteEnabled({ config: allowedTools === undefined ? {} : { allowedTools } }),
      ...(bridge ? { writeBridge: bridge.tokenFor(item.id) } : {}),
    }).env;
  const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const call = (id: number, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: MEMORY_NOTE_TOOL_NAME, arguments: args } });
  const textOf = (responses: Record<string, unknown>[], id: number): { isError: boolean; text: string } => {
    const result = resultFor(responses, id) as { isError?: boolean; content: { text: string }[] };
    return { isError: result.isError === true, text: result.content[0]?.text ?? "" };
  };
  const listed = async (env: Record<string, string>): Promise<string[]> =>
    (resultFor(await callServer(dbPath, [INITIALIZE, INITIALIZED, LIST], false, env), 2)["tools"] as { name: string }[]).map((tool) => tool.name);

  it("pins its name to packages/core, and restates no rule of a note's", () => {
    const own = service as unknown as Record<string, unknown>;
    expect(own["MEMORY_NOTE_TOOL_NAME"]).toBe(MEMORY_NOTE_TOOL_NAME);
    // The rules are EO's to apply (`checkMemoryNote`, EO-543); a copy
    // here could only disagree with them.
    for (const gone of ["MEMORY_NOTE_PROJECT_SCOPE", "MAX_MEMORY_NOTE_CHARS", "MEMORY_NOTE_ACCEPTED_PREFIX"]) expect(own[gone], gone).toBeUndefined();
  });

  it("is listed only for an agent whose allowedTools grant it, in either spelling, on a turn told its scopes", async () => {
    const tools = await listed(turnEnvironment([eoToolName(MEMORY_NOTE_TOOL_NAME)]));
    expect(tools).toContain(MEMORY_NOTE_TOOL_NAME);
    expect(await listed(turnEnvironment([MEMORY_NOTE_TOOL_NAME]))).toContain(MEMORY_NOTE_TOOL_NAME);

    // No grant: an allowlist that names other things, and none at all.
    expect(await listed(turnEnvironment(["Read", eoToolName("comment")]))).not.toContain(MEMORY_NOTE_TOOL_NAME);
    expect(await listed(turnEnvironment(undefined))).not.toContain(MEMORY_NOTE_TOOL_NAME);
    // A grant, and nowhere to write.
    expect(await listed(turnEnvironment([eoToolName(MEMORY_NOTE_TOOL_NAME)], []))).not.toContain(MEMORY_NOTE_TOOL_NAME);

    const full = (resultFor(await callServer(dbPath, [INITIALIZE, INITIALIZED, LIST], false, turnEnvironment([MEMORY_NOTE_TOOL_NAME])), 2)["tools"] as {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }[]).find((tool) => tool.name === MEMORY_NOTE_TOOL_NAME)!;
    expect(full.inputSchema).toMatchObject({ required: ["scope", "text"], additionalProperties: false });
    // The entries a note replaces (EO-594): optional, a list of ids.
    expect((full.inputSchema["properties"] as Record<string, unknown>)["replaces"]).toMatchObject({ type: "array", items: { type: "string" } });
    expect(full.description).toContain("still be true on the next run");
    expect(full.description).toContain("`replaces`");
    expect(full.description).toContain("never a person's");
    // Invariant 12: called on both backends, so in neither's spelling.
    expect(full.description).not.toContain(eoToolName(""));
  });

  it("hands a note to EO as the agent wrote it, and answers with what EO did — noted, or refused with the reason", async () => {
    const { asked, bridge } = await scriptedBridge((request) =>
      (request.args as { scope: string }).scope === elsewhere
        ? { ok: false, code: "MEMORY_NOTE_REFUSED", problem: `"${elsewhere}" is not a scope this run works in, so nothing was written.` }
        : { ok: true, text: `EO noted this in the memory of Project: P (scope ${projectScope.id}). Later runs on other items are given it from now on.`, data: { entryId: "m-1", scope: { kind: "project", id: projectScope.id } } },
    );
    try {
      const responses = await callServer(
        dbPath,
        [
          INITIALIZE,
          INITIALIZED,
          call(3, { scope: "project", text: "Run pnpm install before the tests." }),
          call(4, { scope: elsewhere, text: "Another project's fact." }),
          call(5, { scope: "project", text: "Run pnpm install first.", replaces: ["m-0"] }),
        ],
        false,
        turnEnvironment([MEMORY_NOTE_TOOL_NAME], [projectScope, workspaceScope], bridge),
      );

      const noted = resultFor(responses, 3) as { isError?: boolean; content: { text: string }[]; structuredContent: unknown };
      expect(noted.isError).toBeUndefined();
      expect(noted.content[0]?.text).toContain(`Project: P (scope ${projectScope.id})`);
      // Everything the text says, on the part Claude shows an agent.
      expect(noted.structuredContent).toEqual({ entryId: "m-1", scope: { kind: "project", id: projectScope.id }, text: noted.content[0]?.text });
      expect(textOf(responses, 4)).toEqual({ isError: true, text: `MEMORY_NOTE_REFUSED: "${elsewhere}" is not a scope this run works in, so nothing was written.` });
      // The note as the agent wrote it — the rules are EO's to apply, a
      // scope spelled as an id included — under this item's credential.
      expect(asked).toEqual([
        { itemId: item.id, request: { tool: MEMORY_NOTE_TOOL_NAME, args: { scope: "project", text: "Run pnpm install before the tests." } } },
        { itemId: item.id, request: { tool: MEMORY_NOTE_TOOL_NAME, args: { scope: elsewhere, text: "Another project's fact." } } },
        // What it replaces too (EO-594): whether each id may be replaced is EO's to say.
        { itemId: item.id, request: { tool: MEMORY_NOTE_TOOL_NAME, args: { scope: "project", text: "Run pnpm install first.", replaces: ["m-0"] } } },
      ]);
      // The service opens the database read-only, and writes nothing itself.
      expect(handle.db.all(sql`SELECT id FROM memories`)).toEqual([]);
    } finally {
      await bridge.close();
    }
  });

  it("refuses a malformed call and a call from an agent not granted it without asking EO", async () => {
    const { asked, bridge } = await scriptedBridge(() => ({ ok: true, text: "noted", data: {} }));
    try {
      const granted = await callServer(dbPath, [INITIALIZE, INITIALIZED, call(3, { scope: "project", text: "A fact.", mentions: ["user"] })], false, turnEnvironment([MEMORY_NOTE_TOOL_NAME], [projectScope], bridge));
      expect(textOf(granted, 3)).toMatchObject({ isError: true, text: expect.stringContaining("INVALID_ARGUMENT") });
      for (const replaces of ["m-1", [1], { id: "m-1" }]) {
        const malformed = await callServer(dbPath, [INITIALIZE, INITIALIZED, call(3, { scope: "project", text: "A fact.", replaces })], false, turnEnvironment([MEMORY_NOTE_TOOL_NAME], [projectScope], bridge));
        expect(textOf(malformed, 3), JSON.stringify(replaces)).toMatchObject({ isError: true, text: expect.stringContaining("`replaces` is a list of the ids") });
      }

      const ungranted = await callServer(dbPath, [INITIALIZE, INITIALIZED, call(3, { scope: "project", text: "A fact." })], false, turnEnvironment(["Read"], [projectScope], bridge));
      expect(textOf(ungranted, 3)).toMatchObject({ isError: true, text: expect.stringContaining("TOOL_DISABLED") });
      expect(asked).toEqual([]);
    } finally {
      await bridge.close();
    }
  });

  /**
   * The learning review (EO-717): a turn whose credential names the writes
   * it is served lists those and no other write tool, whatever the
   * agent's grant — `memory_note` for an agent not granted it, and no
   * `comment`, `attachment_add` or `repository_checkout` for one that is —
   * and refuses a call to any other without asking EO.
   */
  it("serves a turn whose credential names its writes exactly those, whatever the agent's grant", async () => {
    const { asked, bridge } = await scriptedBridge(() => ({ ok: true, text: "noted", data: { entryId: "m-1" } }));
    try {
      const reviewEnvironment = (allowedTools: string[] | undefined) =>
        eoMcpStdioConfig({
          serverPath,
          dbPath,
          enableCommentTool: true,
          attachFrom: { runId: "run-1", directory },
          memoryScopes: [projectScope, workspaceScope],
          enableMemoryNote: memoryNoteEnabled({ config: allowedTools === undefined ? {} : { allowedTools } }),
          writeBridge: bridge.tokenFor(item.id, [MEMORY_NOTE_TOOL_NAME]),
        }).env;
      for (const grant of [["Read"], [MEMORY_NOTE_TOOL_NAME, "comment"], undefined]) {
        const tools = await listed(reviewEnvironment(grant));
        expect(tools, JSON.stringify(grant)).toContain(MEMORY_NOTE_TOOL_NAME);
        expect(tools, JSON.stringify(grant)).toContain("memory_read");
        for (const write of ["comment", "attachment_add", "repository_checkout"]) expect(tools, `${write} for ${JSON.stringify(grant)}`).not.toContain(write);
      }

      const tool = (id: number, name: string, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
      const responses = await callServer(
        dbPath,
        [
          INITIALIZE,
          INITIALIZED,
          tool(3, "comment", { body: "From the review." }),
          tool(4, "attachment_add", { paths: ["a.txt"] }),
          tool(5, "repository_checkout", { repository: "EO", branch: "main" }),
          call(6, { scope: "project", text: "A fact." }),
        ],
        false,
        reviewEnvironment(["Read"]),
      );
      for (const id of [3, 4, 5]) expect(textOf(responses, id), String(id)).toMatchObject({ isError: true, text: expect.stringContaining("TOOL_DISABLED") });
      expect(textOf(responses, 6)).toEqual({ isError: false, text: "noted" });
      expect(asked).toEqual([{ itemId: item.id, request: { tool: MEMORY_NOTE_TOOL_NAME, args: { scope: "project", text: "A fact." } } }]);
    } finally {
      await bridge.close();
    }
  });

  /**
   * The learning review's skill tools (EO-718): listed on a turn whose
   * credential names them and on no other — not for any grant, not on a
   * credential that names no writes — and handed to EO whole when called.
   */
  it("lists the skill tools only on a credential that names them, and hands their calls to EO", async () => {
    const own = service as unknown as Record<string, unknown>;
    expect(own["SKILL_WRITE_TOOLS"]).toEqual([...SKILL_WRITE_TOOLS]);
    expect([own["SKILL_VIEW_TOOL_NAME"], own["SKILL_CREATE_TOOL_NAME"], own["SKILL_PATCH_TOOL_NAME"], own["SKILL_FILE_WRITE_TOOL_NAME"], own["SKILL_FILE_REMOVE_TOOL_NAME"]]).toEqual([
      SKILL_VIEW_TOOL_NAME,
      SKILL_CREATE_TOOL_NAME,
      SKILL_PATCH_TOOL_NAME,
      SKILL_FILE_WRITE_TOOL_NAME,
      SKILL_FILE_REMOVE_TOOL_NAME,
    ]);
    const { asked, bridge } = await scriptedBridge(() => ({ ok: true, text: "done", data: {} }));
    try {
      const environment = (writes: Parameters<AgentWriteBridge["tokenFor"]>[1], allowedTools: string[] = [...SKILL_WRITE_TOOLS.map(eoToolName), eoToolName(MEMORY_NOTE_TOOL_NAME)]) =>
        eoMcpStdioConfig({
          serverPath,
          dbPath,
          enableCommentTool: true,
          memoryScopes: [projectScope],
          enableMemoryNote: memoryNoteEnabled({ config: { allowedTools } }),
          writeBridge: bridge.tokenFor(item.id, writes),
        }).env;
      const review = await listed(environment([MEMORY_NOTE_TOOL_NAME, ...SKILL_WRITE_TOOLS]));
      for (const tool of SKILL_WRITE_TOOLS) expect(review, tool).toContain(tool);
      // A run's own turn — a credential naming no writes — is served none,
      // even for an agent whose allowlist names every one of them.
      const run = await listed(environment(undefined));
      for (const tool of SKILL_WRITE_TOOLS) expect(run, tool).not.toContain(tool);
      // Nor a credential naming other writes.
      const notes = await listed(environment([MEMORY_NOTE_TOOL_NAME]));
      for (const tool of SKILL_WRITE_TOOLS) expect(notes, tool).not.toContain(tool);
      // A skill-only review (EO-731), for a run that wrote its own notes:
      // the skill tools and memory_read, and not memory_note, even for an
      // agent whose allowlist names it.
      const skillsOnly = await listed(environment([...SKILL_WRITE_TOOLS]));
      for (const tool of SKILL_WRITE_TOOLS) expect(skillsOnly, tool).toContain(tool);
      expect(skillsOnly).toContain(MEMORY_READ_TOOL_NAME);
      expect(skillsOnly).not.toContain(MEMORY_NOTE_TOOL_NAME);

      const tool = (id: number, name: string, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
      const calls = [
        tool(3, SKILL_VIEW_TOOL_NAME, { slug: "csv-exports", file: "references/a.md" }),
        tool(4, SKILL_CREATE_TOOL_NAME, { slug: "csv-exports", description: "When.", body: "How." }),
        tool(5, SKILL_PATCH_TOOL_NAME, { slug: "csv-exports", old_text: "a", new_text: "b" }),
        tool(6, SKILL_FILE_WRITE_TOOL_NAME, { slug: "csv-exports", path: "references/a.md", content: "x" }),
        tool(7, SKILL_FILE_REMOVE_TOOL_NAME, { slug: "csv-exports", path: "references/a.md" }),
        tool(8, SKILL_PATCH_TOOL_NAME, { slug: "csv-exports", old_text: "a" }),
        tool(9, SKILL_VIEW_TOOL_NAME, { slug: "csv-exports", mentions: ["x"] }),
      ];
      const served = await callServer(dbPath, [INITIALIZE, INITIALIZED, ...calls], false, environment([MEMORY_NOTE_TOOL_NAME, ...SKILL_WRITE_TOOLS]));
      for (const id of [3, 4, 5, 6, 7]) expect(textOf(served, id), String(id)).toEqual({ isError: false, text: "done" });
      for (const id of [8, 9]) expect(textOf(served, id), String(id)).toMatchObject({ isError: true, text: expect.stringContaining("INVALID_ARGUMENT") });
      expect(asked.map((entry) => entry.request.tool)).toEqual([...SKILL_WRITE_TOOLS]);
      expect(asked[0]!.request.args).toEqual({ slug: "csv-exports", file: "references/a.md" });

      asked.length = 0;
      const refused = await callServer(dbPath, [INITIALIZE, INITIALIZED, ...calls.slice(0, 5)], false, environment(undefined));
      for (const id of [3, 4, 5, 6, 7]) expect(textOf(refused, id), String(id)).toMatchObject({ isError: true, text: expect.stringContaining("TOOL_DISABLED") });
      expect(asked).toEqual([]);
    } finally {
      await bridge.close();
    }
  });
});

/**
 * Claude Code hands an agent a tool's `structuredContent` rather than its
 * text whenever there is some, so a structured part that says less than
 * the text leaves a Claude agent told less than a Codex agent about the
 * same call (invariant 12, EO-543). The MCP host holds its own tools to
 * this (EO-202); this holds the `eo` server's, every one of them, on an
 * answer and on a refusal alike.
 */
/**
 * Every tool states all four MCP annotation hints (EO-723). A client
 * fills a missing hint with the spec default, and the defaults are the
 * cautious ones, so leaving `destructiveHint` off a write tells a client
 * the write destroys something.
 */
describe("every eo tool's annotations", () => {
  type Annotated = { name: string; annotations?: Record<string, unknown> };
  const list = (service as unknown as { eoToolList(options: Record<string, unknown>): Annotated[] }).eoToolList({
    enableCommentTool: true,
    enableConfigTools: true,
    enableFullThread: true,
    enableAttachmentAdd: true,
    enableMemoryRead: true,
    enableMemoryNote: true,
    enableRepositoryCheckout: true,
    enableSkillRead: true,
    skillTools: [...SKILL_WRITE_TOOLS],
  });

  /** The tools that change nothing. Written out, so a tool added tomorrow is a decision rather than a default. */
  const READ_ONLY = [
    "item_detail",
    "ticket_detail",
    "attachment_read",
    "comment_read",
    "comment_search",
    "memory_read",
    "skill_read",
    "skill_view",
    "thread_read",
    "pipeline_list",
    "pipeline_read",
    "agents_list",
    "agent_read",
    "runtimes_list",
  ];

  it("states all four hints, as booleans, on every tool with every switch on", () => {
    const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
    const missing = list.filter((tool) => HINTS.some((hint) => typeof tool.annotations?.[hint] !== "boolean"));

    expect(list.length).toBeGreaterThan(READ_ONLY.length);
    expect(missing.map((tool) => tool.name)).toEqual([]);
  });

  it("marks readOnlyHint on exactly the read-only tools, and destructiveHint on the learning review's skill changes alone", () => {
    const readOnly = list.filter((tool) => tool.annotations?.["readOnlyHint"] === true).map((tool) => tool.name);

    expect(readOnly.sort()).toEqual([...READ_ONLY].sort());
    // Nothing else here takes anything away: comments, files and notes
    // are added, and a checkout is EO's own copy to read. A skill change
    // replaces what it said (EO-718), though every version is kept.
    expect(list.filter((tool) => tool.annotations?.["destructiveHint"] !== false).map((tool) => tool.name)).toEqual([SKILL_PATCH_TOOL_NAME, SKILL_FILE_WRITE_TOOL_NAME, SKILL_FILE_REMOVE_TOOL_NAME]);
  });

  it("says repository_checkout reaches beyond EO, and nothing else does", () => {
    expect(list.filter((tool) => tool.annotations?.["openWorldHint"] === true).map((tool) => tool.name)).toEqual(["repository_checkout"]);
  });
});

describe("every eo tool's structuredContent carries everything its text does (EO-543)", () => {
  let directory: string;
  let dbPath: string;
  let handle: DbHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo mcp structured "));
    dbPath = join(directory, "eo.db");
    handle = openDb(dbPath);
    runMigrations(handle.db, migrationsFolder);
  });

  afterEach(() => {
    handle.close();
    removeScratch(directory);
  });

  type Service = { tools: { name: string }[]; handle(request: unknown): Promise<{ result: { content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> } }>; close(): void };
  const start = service as unknown as { createEoMcpService(options: Record<string, unknown>): Service; eoToolList(options: Record<string, boolean>): { name: string }[] };

  it("on every tool the service can list, with every switch on", async () => {
    const workspace = join(directory, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "a.txt"), "a");
    const app = attachWorkspace(handle.db, { keyPrefix: "P", name: "app", repoPath: "/tmp/app" });
    const item = createTestItem(handle.db, { type: "story", title: "Everything", body: "All of it.", stepId: "todo" });
    const comment = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "hello there" });
    const textFile = join(directory, "notes.txt");
    writeFileSync(textFile, "the attachment's own words");
    const attachmentId = uuidv7();
    insertAttachments(handle.db, [{ id: attachmentId, itemId: item.id, commentId: comment.id, storagePath: textFile, name: "notes.txt", mimeType: "text/plain", size: 26, managed: true, createdAt: 1 }]);
    const added = addMemory(handle.db, { scope: { kind: "project", id: app.projectId! }, body: "Settlements are in UTC.", source: { type: "person", personId: null } });
    if (!added.ok) throw new Error("the memory entry could not be added");
    const pipelineId = (handle.db.all(sql`SELECT id FROM pipelines LIMIT 1`)[0] as { id: string }).id;
    const agentName = listAgents(handle.db)[0]!.name;
    const runId = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", cwd: workspace }).id;
    const { bridge } = await scriptedBridge((request) =>
      request.tool === COMMENT_TOOL_NAME ? { ok: true, text: "Comment posted. Continue with your work.", data: { commentId: "c-1" } } : { ok: false, code: "WRITE_REFUSED", problem: "Refused, as this test asks." },
    );

    /** Calls for each tool: at least one EO answers and, where a tool can refuse, one it refuses. */
    const CALLS: Record<string, unknown[]> = {
      item_detail: [{ key: item.key }, { key: "NOPE-1" }, {}],
      ticket_detail: [{ key: item.key }, {}],
      attachment_read: [{ attachmentId }, { attachmentId: "missing" }],
      attachment_add: [{ paths: ["a.txt"] }, { paths: [] }],
      repository_checkout: [{ repository: "app", branch: "main" }, { repository: "app" }],
      skill_read: [{ slug: "house-style" }, { slug: "house-style", extra: 1 }],
      comment_read: [{ commentId: comment.id }, { commentId: "missing" }],
      comment_search: [{ key: item.key, pattern: "hello" }, { key: item.key, pattern: "(" }],
      memory_read: [{}, { scope: app.projectId }, { entryId: added.entry.id }, { entryId: "missing" }],
      memory_note: [{ scope: "project", text: "A fact." }, { scope: "project", text: "A fact.", replaces: ["m-1"] }, { scope: "project" , text: "A fact.", extra: 1 }, { scope: "project", text: "A fact.", replaces: "m-1" }],
      thread_read: [{ key: item.key }, {}],
      comment: [{ body: "fyi" }, { blocking: true }],
      pipeline_list: [{}, { extra: 1 }],
      pipeline_read: [{ pipelineId }, { pipelineId: "nope" }],
      agents_list: [{}],
      agent_read: [{ name: agentName }, { name: "nobody" }],
      runtimes_list: [{}],
    };

    const eo = start.createEoMcpService({
      dbPath,
      enableCommentTool: true,
      enableConfigTools: true,
      enableFullThread: true,
      runtimeRoot: directory,
      runId,
      runDirectory: workspace,
      memoryScopes: [{ kind: "project", id: app.projectId!, name: "P" }],
      enableMemoryNote: true,
      writeBridge: bridge.tokenFor(item.id),
      skillSlugs: ["house-style"],
    });
    try {
      // The whole list, as the service builds it with every switch on —
      // so a tool added tomorrow fails here until it has calls above.
      const everyTool = start.eoToolList({ enableCommentTool: true, enableConfigTools: true, enableFullThread: true, enableAttachmentAdd: true, enableMemoryRead: true, enableMemoryNote: true, enableRepositoryCheckout: true, enableSkillRead: true }).map((tool) => tool.name);
      expect(eo.tools.map((tool) => tool.name).sort()).toEqual([...everyTool].sort());
      expect(Object.keys(CALLS).sort(), "every tool needs calls in CALLS").toEqual([...everyTool].sort());

      let id = 0;
      const short: string[] = [];
      for (const name of everyTool) {
        for (const args of CALLS[name]!) {
          const { result } = await eo.handle({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } });
          const text = (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
          if (text === "") continue;
          if (result.structuredContent?.["text"] !== text) short.push(`${name} ${JSON.stringify(args)}`);
        }
      }
      expect(short, "these answers say less in structuredContent than in their text").toEqual([]);
      expect(id).toBeGreaterThan(everyTool.length);
    } finally {
      eo.close();
      await bridge.close();
    }
  });
});

/**
 * `repository_checkout` (EO-633): the service checks the call's shape and
 * hands it to EO over the bridge, and answers with what EO said — the
 * checkout, or EO's refusal as the tool's error, word for word. The
 * checkout itself is the supervisor's, through the git kind, and is
 * tested against real repositories in `referenceCheckouts.test.ts`.
 */
describe("repository_checkout on the shared EO MCP service", () => {
  let directory: string;
  let dbPath: string;
  let handle: DbHandle;
  let item: Item;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo mcp checkout "));
    dbPath = join(directory, "eo.db");
    handle = openDb(dbPath);
    runMigrations(handle.db, migrationsFolder);
    item = createTestItem(handle.db, { type: "story", title: "Read web's release", stepId: "todo" });
  });

  afterEach(() => {
    handle.close();
    removeScratch(directory);
  });

  const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const call = (id: number, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: REPOSITORY_CHECKOUT_TOOL_NAME, arguments: args } });
  const REFUSED = "web has no branch `release/9.9`, on its remote `origin` or locally. Nothing was checked out.";
  const MADE = "EO checked out `release/2.4` of web at /repos/web/.git/eo-references/P-1/release%2F2.4, detached at abc123.";

  it("pins its name to packages/core", () => {
    expect((service as { REPOSITORY_CHECKOUT_TOOL_NAME: string }).REPOSITORY_CHECKOUT_TOOL_NAME).toBe(REPOSITORY_CHECKOUT_TOOL_NAME);
  });

  it("is listed on a turn with somewhere to hand the call, taking a repository and a branch, and not otherwise", async () => {
    const { bridge } = await scriptedBridge(() => ({ ok: true, text: MADE, data: {} }));
    try {
      const withBridge = await callServer(dbPath, [INITIALIZE, INITIALIZED, LIST], false, eoMcpStdioConfig({ serverPath, dbPath, writeBridge: bridge.tokenFor(item.id) }).env);
      const tool = (resultFor(withBridge, 2)["tools"] as { name: string; description: string; inputSchema: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } }[]).find(
        (entry) => entry.name === REPOSITORY_CHECKOUT_TOOL_NAME,
      );
      expect(tool).toBeDefined();
      expect(Object.keys(tool!.inputSchema.properties)).toEqual(["repository", "branch"]);
      expect(tool!.inputSchema).toMatchObject({ required: ["repository", "branch"], additionalProperties: false });
      // Read on both backends, so written in neither's spelling of a tool name.
      expect(tool!.description).not.toContain(eoToolName(""));
      expect(tool!.description).not.toMatch(/\beo\//);

      const without = await callServer(dbPath, [INITIALIZE, INITIALIZED, LIST], false, eoMcpStdioConfig({ serverPath, dbPath }).env);
      expect((resultFor(without, 2)["tools"] as { name: string }[]).map((entry) => entry.name)).not.toContain(REPOSITORY_CHECKOUT_TOOL_NAME);
    } finally {
      await bridge.close();
    }
  });

  it("hands the call to EO and answers with what EO said: the checkout, or EO's refusal as the tool's error in the same sentence", async () => {
    const { asked, bridge } = await scriptedBridge((request) =>
      (request.args as { branch: string }).branch === "release/2.4"
        ? { ok: true, text: MADE, data: { path: "/repos/web/.git/eo-references/P-1/release%2F2.4", commit: "abc123", source: "remote" } }
        : { ok: false, code: "REPOSITORY_CHECKOUT_REFUSED", problem: REFUSED },
    );
    try {
      const responses = await callServer(
        dbPath,
        [
          INITIALIZE,
          INITIALIZED,
          call(10, { repository: "web", branch: "release/2.4" }),
          call(11, { repository: "web", branch: "release/9.9" }),
          call(12, { repository: "web" }),
          call(13, { repository: "web", branch: "main", depth: 1 }),
          call(14, { repository: " ", branch: "main" }),
        ],
        true,
        eoMcpStdioConfig({ serverPath, dbPath, writeBridge: bridge.tokenFor(item.id) }).env,
      );
      expect(resultFor(responses, 10)).toEqual({
        content: [{ type: "text", text: MADE }],
        structuredContent: { path: "/repos/web/.git/eo-references/P-1/release%2F2.4", commit: "abc123", source: "remote", text: MADE },
      });
      expect(resultFor(responses, 11)).toEqual({
        isError: true,
        content: [{ type: "text", text: `REPOSITORY_CHECKOUT_REFUSED: ${REFUSED}` }],
        structuredContent: { error: { code: "REPOSITORY_CHECKOUT_REFUSED", message: REFUSED }, text: `REPOSITORY_CHECKOUT_REFUSED: ${REFUSED}` },
      });
      // Malformed: refused here, and EO never asked.
      for (const id of [12, 13, 14]) expect(resultFor(responses, id)).toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_ARGUMENT" } } });
      expect(asked).toEqual([
        { itemId: item.id, request: { tool: REPOSITORY_CHECKOUT_TOOL_NAME, args: { repository: "web", branch: "release/2.4" } } },
        { itemId: item.id, request: { tool: REPOSITORY_CHECKOUT_TOOL_NAME, args: { repository: "web", branch: "release/9.9" } } },
      ]);
    } finally {
      await bridge.close();
    }
  });
});

/**
 * `skill_read` (EO-721): listed only on a turn EO gave skills to load with
 * it — a Codex turn — and handed to EO over the bridge, which answers with
 * the skill's instructions or refuses one the run was not given.
 */
describe("skill_read on the shared EO MCP service", () => {
  let directory: string;
  let dbPath: string;
  let handle: DbHandle;
  let item: Item;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo mcp skill read "));
    dbPath = join(directory, "eo.db");
    handle = openDb(dbPath);
    runMigrations(handle.db, migrationsFolder);
    item = createTestItem(handle.db, { type: "story", title: "Load a skill", stepId: "todo" });
  });

  afterEach(() => {
    handle.close();
    removeScratch(directory);
  });

  const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const call = (id: number, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: SKILL_READ_TOOL_NAME, arguments: args } });
  const BODY = "Read the whole diff before you judge any of it.";
  const REFUSED = "EO did not give this run a skill called `ghost`, so nothing was loaded. The skills EO gave this run are `house-style`.";

  it("pins its name to packages/core", () => {
    expect((service as { SKILL_READ_TOOL_NAME: string }).SKILL_READ_TOOL_NAME).toBe(SKILL_READ_TOOL_NAME);
  });

  it("is listed on a turn given skills, taking a slug, and not otherwise", async () => {
    const { bridge } = await scriptedBridge(() => ({ ok: true, text: BODY, data: {} }));
    try {
      const given = await callServer(dbPath, [INITIALIZE, INITIALIZED, LIST], false, eoMcpStdioConfig({ serverPath, dbPath, writeBridge: bridge.tokenFor(item.id), skillSlugs: ["house-style"] }).env);
      const tool = (resultFor(given, 2)["tools"] as { name: string; description: string; inputSchema: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } }[]).find(
        (entry) => entry.name === SKILL_READ_TOOL_NAME,
      );
      expect(tool).toBeDefined();
      expect(Object.keys(tool!.inputSchema.properties)).toEqual(["slug"]);
      expect(tool!.inputSchema).toMatchObject({ required: ["slug"], additionalProperties: false });
      expect(tool!.description).not.toContain(eoToolName(""));
      expect(tool!.description).not.toMatch(/\beo\//);

      for (const skillSlugs of [undefined, []]) {
        const without = await callServer(dbPath, [INITIALIZE, INITIALIZED, LIST], false, eoMcpStdioConfig({ serverPath, dbPath, writeBridge: bridge.tokenFor(item.id), ...(skillSlugs ? { skillSlugs } : {}) }).env);
        expect((resultFor(without, 2)["tools"] as { name: string }[]).map((entry) => entry.name)).not.toContain(SKILL_READ_TOOL_NAME);
      }
    } finally {
      await bridge.close();
    }
  });

  it("hands the call to EO and answers with what EO said: the instructions, or EO's refusal as the tool's error", async () => {
    const { asked, bridge } = await scriptedBridge((request) =>
      (request.args as { slug: string }).slug === "house-style"
        ? { ok: true, text: BODY, data: { slug: "house-style", directory: null, files: [] } }
        : { ok: false, code: "SKILL_NOT_GIVEN", problem: REFUSED },
    );
    try {
      const responses = await callServer(
        dbPath,
        [INITIALIZE, INITIALIZED, call(10, { slug: "house-style" }), call(11, { slug: "ghost" }), call(12, {}), call(13, { slug: "house-style", depth: 1 }), call(14, { slug: " " })],
        true,
        eoMcpStdioConfig({ serverPath, dbPath, writeBridge: bridge.tokenFor(item.id), skillSlugs: ["house-style"] }).env,
      );
      expect(resultFor(responses, 10)).toEqual({
        content: [{ type: "text", text: BODY }],
        structuredContent: { slug: "house-style", directory: null, files: [], text: BODY },
      });
      expect(resultFor(responses, 11)).toEqual({
        isError: true,
        content: [{ type: "text", text: `SKILL_NOT_GIVEN: ${REFUSED}` }],
        structuredContent: { error: { code: "SKILL_NOT_GIVEN", message: REFUSED }, text: `SKILL_NOT_GIVEN: ${REFUSED}` },
      });
      // Malformed: refused here, and EO never asked.
      for (const id of [12, 13, 14]) expect(resultFor(responses, id)).toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_ARGUMENT" } } });
      expect(asked).toEqual([
        { itemId: item.id, request: { tool: SKILL_READ_TOOL_NAME, args: { slug: "house-style" } } },
        { itemId: item.id, request: { tool: SKILL_READ_TOOL_NAME, args: { slug: "ghost" } } },
      ]);
    } finally {
      await bridge.close();
    }
  });

  it("refuses the call on a turn given no skills, without asking EO", async () => {
    const { asked, bridge } = await scriptedBridge(() => ({ ok: true, text: BODY, data: {} }));
    try {
      const responses = await callServer(dbPath, [INITIALIZE, INITIALIZED, call(10, { slug: "house-style" })], true, eoMcpStdioConfig({ serverPath, dbPath, writeBridge: bridge.tokenFor(item.id) }).env);
      expect(resultFor(responses, 10)).toMatchObject({ isError: true, structuredContent: { error: { code: "TOOL_DISABLED" } } });
      expect(asked).toEqual([]);
    } finally {
      await bridge.close();
    }
  });
});
