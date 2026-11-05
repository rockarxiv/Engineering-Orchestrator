import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ATTACHMENT_ADD_TOOL_NAME, MAX_RUN_ATTACHMENTS, SCRATCH_KIND, type AgentEvent, type AgentProvider, type AgentWriteAnswer, type AttachmentSource, type Comment, type Item, type Uuid } from "@eo/core";
import { AttachmentStorage, MAX_ATTACHMENT_BYTES } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import {
  countAttachmentsForRun,
  createRun,
  createWorkspace,
  getRun,
  listAgents,
  listCommentsForItem,
  listMentionsForComment,
  listRunsForItem,
  needsAttention,
  openMentionsForHuman,
  pendingPushesForItem,
  projectForWorkspace,
  saveJiraBinding,
  type Workspace,
} from "../db/repos/index.js";
import { createJiraConnection } from "../db/repos/jiraConnectionsRepo.js";
import { createDefaultProject } from "../db/repos/projectsRepo.js";
import { attachWorkspace, createTestItem, openMigratedTestDbAt } from "../db/testHelpers.js";
// @ts-expect-error — the service is plain JavaScript, deliberately: it ships
// unbundled because Codex spawns it by path.
import * as eoServer from "../mcp/eoServer.mjs";
import { eoMcpStdioConfig } from "../mcp/serviceConfig.js";
import { validImplementResult } from "../providers/fixtures.js";
import { toolResultEvent } from "../providers/toolResult.js";
import { attachRunFiles, checkRunFile, type RunFileCheck, type RunFileStore } from "./runAttachments.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";

/**
 * An agent attaching files to its own item while it works (EO-412).
 *
 * Two processes are involved and neither is stubbed here. The `eo`
 * server takes the call — the real service, in process, started with
 * the environment `eoMcpStdioConfig` builds for a turn — and hands it
 * over the agent write bridge to the supervisor, which checks it,
 * writes, and answers; the tool's answer is that answer (EO-543). A
 * provider that made the answer up would be testing the supervisor
 * against a server that does not exist.
 */

interface EoService {
  tools: { name: string }[];
  handle(request: unknown): Promise<{ result: { isError?: boolean; content: { type: string; text?: string }[] } }>;
  close(): void;
}
const service = eoServer as {
  createEoMcpService(options: { dbPath: string; runId: string | null; runDirectory: string | null; writeBridge?: unknown }): EoService;
  checkAttachmentPath(directory: string, path: string): Promise<RunFileCheck>;
};

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "eoServer.mjs");

let handle: DbHandle;
let root: string;
let dbPath: string;
let scratchRoot: string;
let storage: AttachmentStorage;
let writes: TestWriteBridge;

beforeEach(async () => {
  writes = await startTestWriteBridge();
  root = mkdtempSync(join(tmpdir(), "eo-run-attachments-"));
  dbPath = join(root, "eo.db");
  // A file, because the service opens the same database from its own
  // connection — as it does from its own process — and `:memory:` is
  // one connection's.
  handle = openMigratedTestDbAt(dbPath);
  scratchRoot = join(root, "scratch");
  mkdirSync(scratchRoot);
  storage = new AttachmentStorage(join(root, "attachments"));
});

afterEach(async () => {
  await writes.close();
  handle.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
});

function scratchWorkspace(): Workspace {
  const workspace = createWorkspace(handle.db, { kind: SCRATCH_KIND });
  createDefaultProject(handle.db, workspace, "EO");
  return workspace;
}

function itemOn(workspace: Workspace | null): Item {
  return createTestItem(handle.db, {
    type: "story",
    title: "Fix the login screen",
    stepId: "todo",
    ...(workspace ? { workspaceId: workspace.id, projectId: workspace.projectId } : {}),
  });
}

/** The comments an agent wrote, which is where an attached file lands — as opposed to EO's notes and the run's output. */
const agentNotes = (item: Item): Comment[] => listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "agent" && comment.kind === "note");
const engineNotes = (item: Item): Comment[] => listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine");
/** A persisted comment always carries the list; the type leaves room for a legacy fixture that does not. */
const filesOn = (comment: Comment | undefined) => comment?.attachments ?? [];

interface ScriptedCall {
  /** What the agent wrote in its workspace before calling, by relative path. */
  files?: Record<string, string | Buffer>;
  args: unknown;
  /** Runs once the tool has answered — that is, between this call and whatever the agent does next. */
  then?: (turn: { runId: Uuid; cwd: string }) => void;
}

/**
 * An agent that calls `attachment_add`, on a backend of the shape
 * `ToolResultEvent` describes: the call, then its answer, joined by an
 * id.
 */
function attachingAgent(calls: ScriptedCall[], ending: { throws?: string } = {}) {
  const seen: { attachFrom: AttachmentSource | undefined; cwd: string; listed: boolean; answers: { ok: boolean; text: string }[] } = { attachFrom: undefined, cwd: "", listed: false, answers: [] };
  const provider: AgentProvider = {
    async *start(opts): AsyncIterable<AgentEvent> {
      seen.attachFrom = opts.attachFrom;
      seen.cwd = opts.cwd;
      // The service exactly as either adapter would start it for this
      // turn: its environment is the one function both of them call.
      const env = eoMcpStdioConfig({ serverPath, dbPath, ...(opts.attachFrom ? { attachFrom: opts.attachFrom } : {}), ...(opts.writeBridge ? { writeBridge: opts.writeBridge } : {}) }).env;
      const eo = service.createEoMcpService({
        dbPath,
        runId: env["EO_MCP_RUN_ID"] ?? null,
        runDirectory: env["EO_MCP_RUN_DIRECTORY"] ?? null,
        writeBridge: env["EO_MCP_WRITE_BRIDGE"] === undefined ? null : JSON.parse(env["EO_MCP_WRITE_BRIDGE"]),
      });
      try {
        seen.listed = eo.tools.some((tool) => tool.name === ATTACHMENT_ADD_TOOL_NAME);
        yield { type: "thread_started", threadId: "thread-1" };
        for (const [index, call] of calls.entries()) {
          for (const [path, content] of Object.entries(call.files ?? {})) {
            mkdirSync(dirname(join(opts.cwd, path)), { recursive: true });
            writeFileSync(join(opts.cwd, path), content);
          }
          const callId = `call-${index}`;
          yield { type: "tool_call", name: ATTACHMENT_ADD_TOOL_NAME, args: call.args, callId };
          const { result } = await eo.handle({ jsonrpc: "2.0", id: index, method: "tools/call", params: { name: ATTACHMENT_ADD_TOOL_NAME, arguments: call.args } });
          const text = result.content[0]?.text ?? "";
          seen.answers.push({ ok: result.isError !== true, text });
          yield toolResultEvent({ name: ATTACHMENT_ADD_TOOL_NAME, callId, ok: result.isError !== true, output: text });
          if (opts.attachFrom) call.then?.({ runId: opts.attachFrom.runId as Uuid, cwd: opts.cwd });
          if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");
        }
        if (ending.throws) throw new Error(ending.throws);
        yield { type: "result", data: validImplementResult };
      } finally {
        eo.close();
      }
    },
    // eslint-disable-next-line require-yield
    async *resume(): AsyncIterable<AgentEvent> {
      throw new Error("these runs are not resumed");
    },
  };
  return { provider, seen };
}

function supervisorOver(provider: AgentProvider, options: { store?: RunFileStore | null } = {}) {
  const supervisor = createRunSupervisor({
    db: handle.db,
    limits: LIMITS,
    scratchRoot,
    provider,
    agentWriteBridge: writes.agentWriteBridge,
    ...(options.store === null ? {} : { artifactStore: options.store ?? storage }),
  });
  writes.serve(supervisor);
  return supervisor;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const THREE = { "shots/before.png": PNG, "shots/after.png": Buffer.concat([PNG, Buffer.from([9])]), "test.log": "1 failed, 41 passed\n" };

describe("an agent attaches files from its workspace to its item mid-run", () => {
  it("is offered the tool on a run with a workspace directory, told which run it is and where it works", async () => {
    const item = itemOn(scratchWorkspace());
    const { provider, seen } = attachingAgent([]);

    await supervisorOver(provider).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(seen.attachFrom).toEqual({ runId: run!.id, directory: seen.cwd });
    expect(seen.cwd.startsWith(scratchRoot)).toBe(true);
    expect(seen.listed).toBe(true);
  });

  it("is not offered it on a workspace with no disk, though that run has a directory too", async () => {
    // `none` records the empty directory EO made as `runs.cwd`, so the
    // column alone would have offered a tool with nothing to attach.
    const item = itemOn(null);
    const { provider, seen } = attachingAgent([]);

    await supervisorOver(provider).runOnce();

    expect(getRun(handle.db, listRunsForItem(handle.db, item.id)[0]!.id)?.cwd).toBeTruthy();
    expect(seen.attachFrom).toBeUndefined();
    expect(seen.listed).toBe(false);
  });

  it("is not offered it on an installation with nowhere to keep a file", async () => {
    itemOn(scratchWorkspace());
    const { provider, seen } = attachingAgent([]);

    await supervisorOver(provider, { store: null }).runOnce();

    expect(seen.attachFrom).toBeUndefined();
    expect(seen.listed).toBe(false);
  });

  it("posts one comment for a call naming three files and a caption: the agent's, a note, on the run, with the files' bytes", async () => {
    const item = itemOn(scratchWorkspace());
    let duringTheRun: { status: string | undefined; comments: number } | undefined;
    const { provider, seen } = attachingAgent([
      {
        files: THREE,
        args: { paths: Object.keys(THREE), caption: "The login screen before and after, and the run that failed." },
        then: ({ runId }) => {
          duringTheRun = { status: getRun(handle.db, runId)?.status, comments: agentNotes(item).length };
        },
      },
    ]);

    await supervisorOver(provider).runOnce();

    expect(seen.answers).toHaveLength(1);
    expect(seen.answers[0]?.ok).toBe(true);
    const [run] = listRunsForItem(handle.db, item.id);
    const implementer = listAgents(handle.db).find((agent) => agent.id === run!.agentId)!;
    const notes = agentNotes(item);
    expect(notes).toHaveLength(1);
    const [comment] = notes;
    expect(comment).toMatchObject({
      authorType: "agent",
      authorId: implementer.id,
      kind: "note",
      runId: run!.id,
      body: "The login screen before and after, and the run that failed.",
    });
    expect(filesOn(comment).map((attachment) => attachment.name)).toEqual(["before.png", "after.png", "test.log"]);
    expect(filesOn(comment).map((attachment) => attachment.mimeType)).toEqual(["image/png", "image/png", "text/plain"]);
    const stored = await Promise.all(filesOn(comment).map((attachment) => storage.read(attachment.path)));
    expect(stored.map((bytes, index) => bytes?.equals(Buffer.from(Object.values(THREE)[index] as Buffer | string)))).toEqual([true, true, true]);
    // On the item before the tool answered, and the answer names it.
    expect(duringTheRun).toEqual({ status: "running", comments: 1 });
    for (const attachment of filesOn(comment)) expect(seen.answers[0]?.text).toContain(attachment.id);
    // And nothing was said about it by EO: an accepted call that worked needs no note.
    expect(engineNotes(item).filter((note) => note.body.includes("attach"))).toEqual([]);
  });

  it("serves each attached file back through attachment_read, by the id listed on that comment", async () => {
    const item = itemOn(scratchWorkspace());
    const { provider } = attachingAgent([{ files: { "test.log": "1 failed, 41 passed\n", "notes.md": "# What I tried\n" }, args: { paths: ["test.log", "notes.md"] } }]);
    await supervisorOver(provider).runOnce();

    const [comment] = agentNotes(item);
    // A caption left out is an empty body, not a refusal.
    expect(comment?.body).toBe("");
    const eo = service.createEoMcpService({ dbPath, runId: null, runDirectory: null });
    try {
      const read = await Promise.all(
        filesOn(comment).map((attachment) =>
          eo.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "attachment_read", arguments: { attachmentId: attachment.id } } }),
        ),
      );
      expect(read.map((response) => response.result.content[0]?.text)).toEqual(["1 failed, 41 passed\n", "# What I tried\n"]);
    } finally {
      eo.close();
    }
  });

  it("leaves the comment and its files on the item when the run fails after the call", async () => {
    const item = itemOn(scratchWorkspace());
    const { provider } = attachingAgent([{ files: THREE, args: { paths: Object.keys(THREE), caption: "Evidence." } }], { throws: "the backend fell over" });

    await supervisorOver(provider).runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.status).not.toBe("succeeded");
    const [comment] = agentNotes(item);
    expect(filesOn(comment)).toHaveLength(3);
    expect((await storage.read(filesOn(comment)[2]!.path))?.toString()).toBe("1 failed, 41 passed\n");
  });

  it("leaves them there when the run is cancelled after the call", async () => {
    const item = itemOn(scratchWorkspace());
    const holder: { supervisor?: ReturnType<typeof supervisorOver> } = {};
    const { provider } = attachingAgent([
      { files: THREE, args: { paths: Object.keys(THREE), caption: "Evidence." }, then: ({ runId }) => holder.supervisor!.cancelRun(runId) },
    ]);
    holder.supervisor = supervisorOver(provider);

    await holder.supervisor.runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("cancelled");
    expect(filesOn(agentNotes(item)[0])).toHaveLength(3);
  });

  it("attempts nothing for a call the tool refused: no comment, and no note", async () => {
    const item = itemOn(scratchWorkspace());
    const { provider, seen } = attachingAgent([
      { files: { "real.txt": "here" }, args: { paths: ["real.txt", "missing.png"], caption: "Half of this exists." } },
      { args: { paths: ["../../etc/passwd"] } },
      { args: { paths: ["real.txt"], mentions: ["user"] } },
    ]);

    await supervisorOver(provider).runOnce();

    expect(seen.answers.map((answer) => answer.ok)).toEqual([false, false, false]);
    expect(seen.answers[0]?.text).toContain('"missing.png" does not exist.');
    expect(agentNotes(item)).toEqual([]);
    expect(engineNotes(item).filter((note) => /attach/i.test(note.body))).toEqual([]);
  });

  it("holds the run to sixteen files when an agent makes its calls at once, through the real service and the bridge", async () => {
    // Three calls of eight files each, all in flight together: the
    // reviewer's reproduction of EO-543, where each call read the same
    // count before any had stored a file and twenty-four were attached.
    const item = itemOn(scratchWorkspace());
    const paths = Array.from({ length: 8 }, (_unused, index) => `file-${String(index)}.txt`);
    const answers: { ok: boolean; text: string }[] = [];
    const provider: AgentProvider = {
      async *start(opts): AsyncIterable<AgentEvent> {
        for (const path of paths) writeFileSync(join(opts.cwd, path), path);
        const eo = service.createEoMcpService({
          dbPath,
          runId: opts.attachFrom?.runId ?? null,
          runDirectory: opts.attachFrom?.directory ?? null,
          writeBridge: opts.writeBridge ?? null,
        });
        try {
          yield { type: "thread_started", threadId: "thread-1" };
          const results = await Promise.all(
            [1, 2, 3].map((id) => eo.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name: ATTACHMENT_ADD_TOOL_NAME, arguments: { paths } } })),
          );
          for (const { result } of results) answers.push({ ok: result.isError !== true, text: result.content[0]?.text ?? "" });
          yield { type: "result", data: validImplementResult };
        } finally {
          eo.close();
        }
      },
      // eslint-disable-next-line require-yield
      async *resume(): AsyncIterable<AgentEvent> {
        throw new Error("these runs are not resumed");
      },
    };

    await supervisorOver(provider).runOnce();

    // What the agent attached — the scratch workspace's own artifacts,
    // gathered when the run ends, are not the agent's calls.
    expect(agentNotes(item).map((comment) => filesOn(comment).length)).toEqual([8, 8]);
    // Two were made; the third was refused whole, and said why.
    expect(answers.map((answer) => answer.ok).sort()).toEqual([false, true, true]);
    expect(answers.find((answer) => !answer.ok)?.text).toContain(`a run may attach at most ${MAX_RUN_ATTACHMENTS}`);
  });

  it("writes nothing for a call reported in the stream that never reached EO", async () => {
    // The shape EO once wrote from (EO-543): a call, and an answer that
    // says it was accepted, with nothing handed over the bridge.
    const item = itemOn(scratchWorkspace());
    const provider: AgentProvider = {
      async *start(opts): AsyncIterable<AgentEvent> {
        writeFileSync(join(opts.cwd, "shot.png"), PNG);
        yield { type: "thread_started", threadId: "thread-1" };
        yield { type: "tool_call", name: ATTACHMENT_ADD_TOOL_NAME, args: { paths: ["shot.png"] }, callId: "call-1" };
        yield toolResultEvent({ name: ATTACHMENT_ADD_TOOL_NAME, callId: "call-1", ok: true, output: "EO accepted this file and is attaching it to the ticket in one comment:\n- shot.png" });
        yield { type: "result", data: validImplementResult };
      },
      // eslint-disable-next-line require-yield
      async *resume(): AsyncIterable<AgentEvent> {
        throw new Error("these runs are not resumed");
      },
    };

    await supervisorOver(provider).runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
    expect(agentNotes(item)).toEqual([]);
  });
});

describe("what the supervisor writes for an attachment_add call", () => {
  /** A run in a directory of its own, with nothing dispatched: the writing, without the loop around it. */
  function runIn(item: Item): { runId: Uuid; directory: string; agent: { id: Uuid; name: string } } {
    const directory = mkdtempSync(join(root, "workspace-"));
    const agent = listAgents(handle.db).find((entry) => entry.role === "implementer")!;
    const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement", cwd: directory });
    return { runId: run.id, directory, agent: { id: agent.id, name: agent.name } };
  }

  const attach = (item: Item, run: ReturnType<typeof runIn>, args: unknown, store: RunFileStore | undefined = storage): Promise<AgentWriteAnswer> =>
    attachRunFiles({ db: handle.db, store, itemId: item.id, runId: run.runId, agent: run.agent, directory: run.directory, args });

  it("creates no mention, parks nothing and dispatches nothing for a caption that at-mentions the person or an agent", async () => {
    const item = itemOn(null);
    const run = runIn(item);
    writeFileSync(join(run.directory, "shot.png"), PNG);
    const reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
    const runsBefore = listRunsForItem(handle.db, item.id).length;

    await attach(item, run, { paths: ["shot.png"], caption: `@user have a look, and @${reviewer.name} too` });

    const [comment] = agentNotes(item);
    expect(comment?.body).toBe(`@user have a look, and @${reviewer.name} too`);
    expect(listMentionsForComment(handle.db, comment!.id)).toEqual([]);
    expect(needsAttention(handle.db, item.id)).toBe(false);
    // The whole inbox, which on a database this young is this item's alone.
    expect(openMentionsForHuman(handle.db, "anybody")).toEqual([]);
    // Nothing for a mention to dispatch: a tick finds no reply waiting for anybody.
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(runsBefore);
  });

  it("attaches nothing when one file cannot be stored, and names it with the reason", async () => {
    // All or nothing (EO-543): the agent hears the refusal while it can
    // still act on it, so the comment that results is always the one it
    // asked for, never a part of it.
    const item = itemOn(null);
    const run = runIn(item);
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(run.directory, name), name);
    const failing: RunFileStore = {
      storeImported: (input) => (input.name === "b.txt" ? Promise.reject(new Error("no space left on device")) : storage.storeImported(input)),
      rollback: (records) => storage.rollback(records),
    };

    const answer = await attach(item, run, { paths: ["a.txt", "b.txt", "c.txt"], caption: "Three." }, failing);

    expect(answer).toEqual({ ok: false, code: "ATTACHMENT_REFUSED", problem: expect.stringContaining('"b.txt" could not be stored: no space left on device') as unknown });
    expect(answer.ok === false && answer.problem).toContain("Nothing was attached.");
    expect(agentNotes(item)).toEqual([]);
    // Said to the agent, not on the item: nothing happened there.
    expect(engineNotes(item)).toEqual([]);
  });

  /** Every file in EO's attachment store, which is where an orphan would be. */
  const storedFiles = (): string[] => readdirSync(join(root, "attachments", "files")).sort();

  // Not on Windows, where a directory's mode does not stop a write into
  // it, and not as root, which no mode stops: the failure has to be real
  // for this to say anything.
  const cannotRefuseAWrite = process.platform === "win32" || process.getuid?.() === 0;

  it.skipIf(cannotRefuseAWrite)("leaves no bytes in the store when a file fails part-way, the files stored before it included", async () => {
    // A write that really fails, in the real store, rather than a
    // stand-in that throws before touching the disk: the directory is
    // made unwritable for the one file, so `storeImported` gets as far
    // as it gets and has to clean up after itself. What is left in the
    // store afterwards is exactly what the comment owns.
    const item = itemOn(null);
    const run = runIn(item);
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(run.directory, name), name);
    const files = join(root, "attachments", "files");
    const failing: RunFileStore = {
      storeImported: async (input) => {
        if (input.name !== "b.txt") return storage.storeImported(input);
        chmodSync(files, 0o555);
        try {
          return await storage.storeImported(input);
        } finally {
          chmodSync(files, 0o755);
        }
      },
    };

    const answer = await attach(item, run, { paths: ["a.txt", "b.txt", "c.txt"], caption: "Three." }, { ...failing, rollback: (records) => storage.rollback(records) });

    expect(answer.ok === false && answer.problem).toContain('"b.txt" could not be stored');
    // The one stored before it is taken back, the one after it never
    // stored: nothing in the store that no comment owns.
    expect(agentNotes(item)).toEqual([]);
    expect(storedFiles()).toEqual([]);
  });

  it("takes back the files it stored when the comment they were for cannot be written", async () => {
    // The other way bytes end up owned by nothing: every file stored,
    // and then no comment. Forced here with an item that does not
    // exist, which is a write the database refuses.
    const item = itemOn(null);
    const run = runIn(item);
    writeFileSync(join(run.directory, "a.txt"), "a");
    writeFileSync(join(run.directory, "b.txt"), "b");

    const answer = await attachRunFiles({ db: handle.db, store: storage, itemId: "018f0000-0000-7000-8000-0000000dead1" as Uuid, runId: run.runId, agent: run.agent, directory: run.directory, args: { paths: ["a.txt", "b.txt"] } });
    expect(answer).toMatchObject({ ok: false, code: "ATTACHMENT_REFUSED" });

    expect(storedFiles()).toEqual([]);
    expect(agentNotes(item)).toEqual([]);
  });

  it("posts no empty comment when nothing in the call could be stored", async () => {
    const item = itemOn(null);
    const run = runIn(item);
    writeFileSync(join(run.directory, "a.txt"), "a");

    const answer = await attach(item, run, { paths: ["a.txt"] }, { storeImported: () => Promise.reject(new Error("no space left on device")) });

    expect(agentNotes(item)).toEqual([]);
    expect(answer.ok === false && answer.problem).toContain("Nothing was attached.");
  });

  it("counts what earlier calls stored when calls on one run arrive together", async () => {
    const item = itemOn(null);
    const run = runIn(item);
    const names = Array.from({ length: 8 }, (_unused, index) => `file-${String(index)}.txt`);
    for (const name of names) writeFileSync(join(run.directory, name), name);

    const answers = await Promise.all([1, 2, 3].map(() => attach(item, run, { paths: names })));

    // Taken in the order they came: the first two fill the run, the third goes over.
    expect(answers.map((answer) => answer.ok)).toEqual([true, true, false]);
    expect(countAttachmentsForRun(handle.db, run.runId)).toBe(MAX_RUN_ATTACHMENTS);
    expect(storedFiles()).toHaveLength(MAX_RUN_ATTACHMENTS);
  });

  it("goes on taking calls for a run after one of them failed", async () => {
    const item = itemOn(null);
    const run = runIn(item);
    writeFileSync(join(run.directory, "a.txt"), "a");
    const broken: RunFileStore = { storeImported: () => Promise.reject(new Error("no space left on device")) };

    const [failed, next] = await Promise.all([attach(item, run, { paths: ["a.txt"] }, broken), attach(item, run, { paths: ["a.txt"] })]);

    expect(failed.ok).toBe(false);
    expect(next.ok).toBe(true);
  });

  it("holds the run to sixteen files, refusing the call that would go past them", async () => {
    const item = itemOn(null);
    const run = runIn(item);
    const names = Array.from({ length: 18 }, (_unused, index) => `file-${String(index).padStart(2, "0")}.txt`);
    for (const name of names) writeFileSync(join(run.directory, name), name);

    await attach(item, run, { paths: names.slice(0, 8) });
    await attach(item, run, { paths: names.slice(8, 15) });
    const over = await attach(item, run, { paths: names.slice(15, 18) });
    const last = await attach(item, run, { paths: names.slice(15, 16) });

    // 15 + 3 would be 18: refused whole, naming the two that go over.
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.problem).toContain('"file-16.txt" would be file 17');
    expect(over.ok === false && over.problem).toContain('"file-17.txt" would be file 18');
    expect(over.ok === false && over.problem).toContain(`at most ${MAX_RUN_ATTACHMENTS}`);
    expect(over.ok === false && over.problem).not.toContain('"file-15.txt"');
    // 15 + 1 is the cap, not past it.
    expect(last.ok).toBe(true);
    expect(countAttachmentsForRun(handle.db, run.runId)).toBe(MAX_RUN_ATTACHMENTS);
    expect(agentNotes(item).map((comment) => filesOn(comment).length)).toEqual([8, 7, 1]);
  });

  it("queues each file for upload on an item mirrored to Jira, as a file a person attaches is", async () => {
    const workspace = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" });
    const project = projectForWorkspace(handle.db, workspace.id)!;
    const site = createJiraConnection(handle.db, { baseUrl: "https://jira.example", flavour: "datacenter" });
    saveJiraBinding(handle.db, project.id, { connectionId: site.id, projectKey: "API" });
    const item = createTestItem(handle.db, { type: "story", title: "Upload", stepId: "todo", workspaceId: workspace.id, projectId: project.id, jiraKey: "API-1" });
    const run = runIn(item);
    writeFileSync(join(run.directory, "a.txt"), "a");
    writeFileSync(join(run.directory, "b.txt"), "b");

    await attach(item, run, { paths: ["a.txt", "b.txt"], caption: "For the issue." });

    const attached = filesOn(agentNotes(item)[0]).map((attachment) => attachment.id);
    expect(attached).toHaveLength(2);
    const uploads = pendingPushesForItem(handle.db, item.id, "jira").filter((entry) => entry.kind === "attachment_upload");
    expect(uploads.map((entry) => (entry.payload as { attachmentId: string }).attachmentId)).toEqual(attached);
  });

  it("queues nothing on an item that is not mirrored", async () => {
    const item = itemOn(null);
    const run = runIn(item);
    writeFileSync(join(run.directory, "a.txt"), "a");

    await attach(item, run, { paths: ["a.txt"] });

    expect(filesOn(agentNotes(item)[0])).toHaveLength(1);
    expect(pendingPushesForItem(handle.db, item.id)).toEqual([]);
  });
});

/**
 * The rules exist twice, because `eoServer.mjs` ships alone and can
 * import nothing of EO's — and the module host, which ships alone the
 * same way, checks a module's `ctx.attach` with the server's copy. One
 * table, both checkers, the same answer, down to the sentence.
 */
describe("the server's copy and the supervisor agree on every path", () => {
  let directory: string;
  let outside: string;

  beforeEach(() => {
    directory = join(root, "workspace");
    mkdirSync(join(directory, "nested", "deeper"), { recursive: true });
    outside = join(root, "outside.txt");
    writeFileSync(outside, "not the run's");
    writeFileSync(join(directory, "ok.txt"), "fine");
    writeFileSync(join(directory, "nested", "deeper", "ok.txt"), "fine");
    if (LINKS) {
      symlinkSync(outside, join(directory, "link.txt"));
      symlinkSync(root, join(directory, "linked-directory"));
    }
    writeFileSync(join(directory, "huge.bin"), "");
    truncateSync(join(directory, "huge.bin"), MAX_ATTACHMENT_BYTES + 1);
    writeFileSync(join(directory, "exactly.bin"), "");
    truncateSync(join(directory, "exactly.bin"), MAX_ATTACHMENT_BYTES);
  });

  /** Creating a link needs a privilege a Windows runner does not have, so the link cases are left out there. */
  const LINKS = process.platform !== "win32";

  const everyCase: [string, (paths: { directory: string; outside: string }) => string, string | null][] = [
    ["a file", () => "ok.txt", null],
    ["a nested file", () => "nested/deeper/ok.txt", null],
    ["a path that leaves and comes back", () => "nested/../ok.txt", null],
    ["an absolute path inside", (paths) => join(paths.directory, "ok.txt"), null],
    ["a file of exactly 20 MB", () => "exactly.bin", null],
    ["a path that does not exist", () => "missing.txt", "does not exist"],
    ["a path under a file", () => "ok.txt/inside", "does not exist"],
    ["a directory", () => "nested", "is a directory"],
    ["the directory itself", () => ".", "is a directory"],
    ["a symbolic link", () => "link.txt", "symbolic link"],
    ["a file reached through a linked directory", () => "linked-directory/outside.txt", "symbolic link"],
    ["a path climbing out", () => "../outside.txt", "outside the directory this run works in"],
    ["an absolute path outside", (paths) => paths.outside, "outside the directory this run works in"],
    ["a file over 20 MB", () => "huge.bin", "larger than the 20 MB attachment limit"],
  ];
  const cases = everyCase.filter(([, , refusal]) => LINKS || refusal !== "symbolic link");

  it.each(cases)("%s", async (_name, pathOf, refusal) => {
    const path = pathOf({ directory, outside });

    const fromSupervisor = await checkRunFile(directory, path);
    const fromServer = await service.checkAttachmentPath(directory, path);

    expect(fromSupervisor).toEqual(fromServer);
    if (refusal === null) {
      expect(fromSupervisor.ok).toBe(true);
      expect(fromSupervisor.ok && readFileSync(fromSupervisor.absolutePath).byteLength).toBe(fromSupervisor.ok && fromSupervisor.size);
    } else {
      expect(fromSupervisor).toEqual({ ok: false, reason: expect.stringContaining(refusal) as unknown });
      expect(fromSupervisor.ok === false && fromSupervisor.reason).toContain(`"${path}"`);
    }
  });
});
