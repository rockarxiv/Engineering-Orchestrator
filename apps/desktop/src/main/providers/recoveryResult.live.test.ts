import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@eo/core";
import { createClaudeProvider } from "./claude.js";
import { loadClaudeSdk } from "./claudeSdk.js";
import { runtimeRoot } from "../runtimes/install.js";
import { RUNTIMES } from "../runtimes/catalog.js";
import { resolveRuntime } from "../runtimes/resolve.js";
import { CLAUDE_SDK, resolvePackageSet } from "../runtimes/packages.js";

/**
 * What a resumed CLI writes before it reads EO's message (EO-495).
 *
 * EO-487's restart recovery resumed a session killed mid-tool-call with
 * background shells running. The CLI first closed out what the kill had
 * left — reported the shells orphaned, answered the dangling call
 * itself — and wrote a `result` for it, empty and 0 turns, before the
 * turn carrying EO's recovery prompt. `answersTurn` (claude.ts) tells
 * the two apart by the user-message uuid the CLI echoes on a result,
 * which only the real binary can show it does.
 *
 * Driven against the managed CLI with a capture server standing in for
 * the API, as `steering.live.test.ts` is: **no credit is spent and no key
 * is needed.** Opted in, because it needs the managed runtimes on disk:
 *
 *     EO_LIVE_CLAUDE_WIRE=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/providers/recoveryResult.live.test.ts
 */
const OPTED_IN = process.env["EO_LIVE_CLAUDE_WIRE"] === "1";

let scratch: string | null = null;
const restore: { key: string; value: string | undefined }[] = [];

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
  for (const { key, value } of restore.splice(0)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setEnv(key: string, value: string): void {
  restore.push({ key, value: process.env[key] });
  process.env[key] = value;
}

/** One reply: a Bash call (in the background or not), or plain text. */
function answer(response: ServerResponse, reply: { bash: string; background: boolean } | { text: string }): void {
  const message = { id: "msg_capture", type: "message", role: "assistant", model: "capture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 3 } };
  const body: [string, unknown][] =
    "bash" in reply
      ? [
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${randomUUID().slice(0, 8)}`, name: "Bash", input: {} } }],
          [
            "content_block_delta",
            { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: reply.bash, description: "wait", ...(reply.background ? { run_in_background: true } : {}) }) } },
          ],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }],
        ]
      : [
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.text } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }],
        ];
  const events: [string, unknown][] = [["message_start", { type: "message_start", message }], ...body, ["message_stop", { type: "message_stop" }]];
  try {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    response.end();
  } catch {
    // The CLI going away mid-answer is the point of the first half.
  }
}

/** The CLI this worker spawned, and only that: never any other `claude` on the machine — this one's own runner included. */
function spawnedCli(executable: string): number {
  const children = execFileSync("pgrep", ["-P", String(process.pid)]).toString().trim().split("\n").filter(Boolean);
  const ours = children.filter((pid) => {
    try {
      return execFileSync("ps", ["-o", "args=", "-p", pid]).toString().includes(executable);
    } catch {
      return false;
    }
  });
  if (ours.length !== 1) throw new Error(`expected exactly one CLI under this worker, found ${ours.length}`);
  return Number(ours[0]);
}

describe.skipIf(!OPTED_IN)("a session resumed after the process running its turn was killed", () => {
  it(
    "closes the interrupted turn with a result of its own, and the resumed turn ends on EO's",
    { timeout: 240_000 },
    async () => {
      const root = runtimeRoot(join(homedir(), ".config", "EO"));
      const executable = resolveRuntime({ spec: RUNTIMES.claude, root }).path;
      const sdkEntryPath = resolvePackageSet(root, CLAUDE_SDK);
      expect(executable, "the managed claude runtime must be installed").not.toBeNull();
      expect(sdkEntryPath, "the managed Claude Agent SDK must be installed").not.toBeNull();

      scratch = mkdtempSync(join(tmpdir(), "eo-recovery-result-"));
      const cwd = join(scratch, "repo");
      mkdirSync(cwd, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "pipe" });
      writeFileSync(join(cwd, "README.md"), "# probe\n");

      const RECOVERY = "(EO restarted after an interruption; continuing this thread from where it left off.)";
      let requests = 0;
      let midCall!: () => void;
      const killable = new Promise<void>((resolve) => {
        midCall = resolve;
      });
      const capture = createServer((request: IncomingMessage, response: ServerResponse) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          if (request.url?.includes("/v1/messages") !== true) return answer(response, { text: "ok" });
          const body = Buffer.concat(chunks).toString("utf8");
          if (body.includes(RECOVERY)) return answer(response, { text: "recovered" });
          requests += 1;
          // A shell left running in the background, then a call the kill
          // lands in the middle of: EO-487's shape.
          answer(response, requests === 1 ? { bash: "sleep 20", background: true } : { bash: "sleep 20", background: false });
          if (requests === 2) midCall();
        });
      });
      await new Promise<void>((resolve) => capture.listen(0, "127.0.0.1", resolve));
      const { port } = capture.address() as { port: number };
      setEnv("ANTHROPIC_BASE_URL", `http://127.0.0.1:${port}`);
      setEnv("ANTHROPIC_API_KEY", "sk-ant-capture-not-a-real-key");
      setEnv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");

      try {
        // The first half is set-up, run on the SDK directly so the CLI it
        // kills is a plain child of this worker.
        const sdk = await loadClaudeSdk(sdkEntryPath!);
        let sessionId = "";
        let closeInput!: () => void;
        const inputClosed = new Promise<void>((resolve) => {
          closeInput = resolve;
        });
        const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
          yield { type: "user", session_id: "", message: { role: "user", content: [{ type: "text", text: "Count slowly." }] }, parent_tool_use_id: null };
          await inputClosed;
        })();
        const first = sdk.query({ prompt, options: { cwd, pathToClaudeCodeExecutable: executable!, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, settingSources: [] } });
        const killed = (async () => {
          try {
            for await (const message of first as AsyncIterable<SDKMessage>) if (message.session_id) sessionId = message.session_id;
          } catch {
            // Killed, as intended.
          }
        })();
        await killable;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        process.kill(spawnedCli(executable!), "SIGKILL");
        await killed;
        closeInput();
        expect(sessionId).not.toBe("");

        // The recovery: EO's adapter, resuming the session as the supervisor does.
        const provider = createClaudeProvider({ sdkEntryPath, executablePath: executable, enableCommentTool: false, onUnmappedMessage: () => undefined });
        const events: AgentEvent[] = [];
        // Read as the supervisor reads a turn: up to its first result.
        for await (const event of provider.resume(sessionId, RECOVERY, { cwd, signal: new AbortController().signal })) {
          events.push(event);
          if (event.type === "result") break;
        }

        expect(events.filter((event) => event.type === "result")).toEqual([{ type: "result", data: "recovered" }]);
      } finally {
        capture.close();
      }
    },
  );
});
