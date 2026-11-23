import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEAM_EVIDENCE_TOOLS, type AgentEvent, type AgentWriteRequest } from "@eo/core";
import { afterEach, describe, expect, it } from "vitest";
import { startAgentWriteBridge, type AgentWriteBridge } from "../mcp/writeBridge.js";
import { RUNTIMES } from "../runtimes/catalog.js";
import { runtimeRoot } from "../runtimes/install.js";
import { CLAUDE_SDK, resolvePackageSet } from "../runtimes/packages.js";
import { resolveRuntime } from "../runtimes/resolve.js";
import { createClaudeProvider } from "./claude.js";

/**
 * A report-only team participant on the real Claude CLI and SDK (EO-845),
 * with **no credit spent**: a local server stands in for the model and
 * scripts the calls a participant must not be able to make — a shell
 * command and a file write that would each leave a marker, a subagent
 * that would run one, EO's `comment` and the repository index — beside
 * the one it may, `evidence_list`. Then it reads back what the CLI did.
 *
 * Asserted on a fresh session and on the same session resumed: no marker
 * exists, the request offered the four evidence tools and no built-in,
 * and EO's bridge was asked for the evidence and for nothing else.
 *
 *     EO_LIVE_CLAUDE_WIRE=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/providers/reportOnlyClaude.live.test.ts
 *
 * Passed against the pinned CLI (EO-845), last at 0.3.329 with SDK 0.3.329: each forbidden call is answered
 * "No such tool available … disabled for this session, in subagents as
 * well as here", so not even a subagent's own call has a tool to run.
 */

const OPTED_IN = process.env["EO_LIVE_CLAUDE_WIRE"] === "1";
const SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "eoServer.mjs");

let scratch: string | null = null;
let bridge: AgentWriteBridge | null = null;
const restore: { key: string; value: string | undefined }[] = [];

afterEach(async () => {
  await bridge?.close();
  bridge = null;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
  for (const { key, value } of restore.splice(0)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setEnv(key: string, value: string | undefined): void {
  restore.push({ key, value: process.env[key] });
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

type Block = { id: string; name: string; input: unknown };

function stream(response: ServerResponse, blocks: readonly Block[]): void {
  const message = { id: "msg_capture", type: "message", role: "assistant", model: "capture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  const body: [string, unknown][] =
    blocks.length > 0
      ? [
          ...blocks.flatMap((block, index): [string, unknown][] => [
            ["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }],
            ["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }],
            ["content_block_stop", { type: "content_block_stop", index }],
          ]),
          ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }],
        ]
      : [
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reported." } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
        ];
  const events: [string, unknown][] = [["message_start", { type: "message_start", message }], ...body, ["message_stop", { type: "message_stop" }]];
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  response.end();
}

describe.skipIf(!OPTED_IN)("a report-only participant on the real Claude CLI (EO-845, no credit)", () => {
  it("runs no shell, writes nothing, starts no subagent and reaches EO only for its evidence — fresh and resumed", { timeout: 300_000 }, async () => {
    const root = runtimeRoot(join(homedir(), ".config", "EO"));
    const executable = resolveRuntime({ spec: RUNTIMES.claude, root }).path;
    const sdkEntryPath = resolvePackageSet(root, CLAUDE_SDK);
    expect(executable, "the managed claude runtime must be installed").not.toBeNull();

    scratch = mkdtempSync(join(tmpdir(), "eo-report-only-claude-"));
    const cwd = join(scratch, "participant");
    const config = join(scratch, "config");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(config, { recursive: true });
    const markers = { shell: join(scratch, "shell-ran"), write: join(scratch, "written"), subagent: join(scratch, "subagent-ran") };

    const asked: AgentWriteRequest[] = [];
    bridge = await startAgentWriteBridge(async (_itemId, request) => {
      asked.push(request);
      return { ok: true, text: "EVIDENCE-LISTED: report.md", data: {} };
    });
    const credential = { ...bridge.tokenFor("item-1", TEAM_EVIDENCE_TOOLS, "attempt-1"), reportOnly: true };

    const bodies: { tools?: { name: string }[]; messages?: { content?: unknown }[] }[] = [];
    let turn = 0;
    const calls: Block[] = [
      { id: "toolu_shell", name: "Bash", input: { command: `touch ${markers.shell}`, description: "probe" } },
      { id: "toolu_write", name: "Write", input: { file_path: markers.write, content: "x" } },
      { id: "toolu_task", name: "Task", input: { description: "probe", prompt: `Run touch ${markers.subagent}`, subagent_type: "general-purpose" } },
      { id: "toolu_comment", name: "mcp__eo__comment", input: { body: "@user posted by a participant" } },
      { id: "toolu_repo", name: "mcp__repo__idx_symbol", input: { name: "x" } },
      { id: "toolu_evidence", name: "mcp__eo__evidence_list", input: {} },
    ];
    const capture = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const isTurn = request.url?.includes("/v1/messages") === true && !request.url.includes("count_tokens");
        if (!isTurn) return stream(response, []);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as (typeof bodies)[number];
        bodies.push(body);
        // The first request of each turn asks for every call; the next ends the turn.
        const last = body.messages?.at(-1)?.content;
        const answering = Array.isArray(last) && (last as { type?: string }[]).some((block) => block.type === "tool_result");
        turn += answering ? 0 : 1;
        stream(response, answering ? [] : calls.map((call) => ({ ...call, id: `${call.id}_${String(turn)}` })));
      });
    });
    await new Promise<void>((resolve) => capture.listen(0, "127.0.0.1", resolve));
    const { port } = capture.address() as { port: number };
    setEnv("ANTHROPIC_BASE_URL", `http://127.0.0.1:${port}`);
    setEnv("CLAUDE_CONFIG_DIR", config);
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-capture-not-a-real-token");
    setEnv("ANTHROPIC_API_KEY", undefined);
    setEnv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");

    const provider = createClaudeProvider({ reportOnly: true, sdkEntryPath, executablePath: executable, eoMcp: { serverPath: SERVER_PATH }, enableCommentTool: true, config: { model: "claude-sonnet-4-5" } });
    const run = async (resume: string | null): Promise<AgentEvent[]> => {
      const events: AgentEvent[] = [];
      const opts = { cwd, writeBridge: credential, signal: AbortSignal.timeout(240_000) };
      const turnStream = resume === null ? provider.start({ ...opts, instructions: "You are a probe.", context: "Report." }) : provider.resume(resume, "Report again.", opts);
      for await (const event of turnStream) events.push(event);
      return events;
    };
    try {
      const first = await run(null);
      const thread = first.find((event): event is Extract<AgentEvent, { type: "thread_started" }> => event.type === "thread_started")?.threadId;
      expect(thread, "the fresh turn must open a session").toBeDefined();
      await run(thread!);
    } finally {
      capture.close();
    }

    // Every call but the evidence one came back refused, as an error the model reads.
    const results = bodies.flatMap((body) => {
      const last = body.messages?.at(-1)?.content;
      return Array.isArray(last) ? (last as { type?: string; tool_use_id?: string; is_error?: boolean }[]).filter((block) => block.type === "tool_result") : [];
    });
    expect(results).toHaveLength(calls.length * 2);
    for (const result of results) expect(result.is_error === true, result.tool_use_id).toBe(!result.tool_use_id!.startsWith("toolu_evidence"));
    for (const [name, marker] of Object.entries(markers)) expect(existsSync(marker), `the ${name} marker`).toBe(false);
    // Each turn's request offered the evidence tools and no built-in tool.
    const offered = bodies.map((body) => (body.tools ?? []).map((tool) => tool.name).sort());
    for (const tools of offered) {
      expect(tools.filter((name) => !name.startsWith("mcp__eo__"))).toEqual([]);
      expect(tools).toEqual(TEAM_EVIDENCE_TOOLS.map((tool) => `mcp__eo__${tool}`).sort());
    }
    // Both turns reached EO for the evidence, and for nothing else.
    expect(asked.map((request) => request.tool)).toEqual(["evidence_list", "evidence_list"]);
    expect(turn).toBe(2);
  });
});
