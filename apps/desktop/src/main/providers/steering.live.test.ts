import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@eo/core";
import { createClaudeProvider } from "./claude.js";
import { runtimeRoot } from "../runtimes/install.js";
import { RUNTIMES } from "../runtimes/catalog.js";
import { resolveRuntime } from "../runtimes/resolve.js";
import { CLAUDE_SDK, resolvePackageSet } from "../runtimes/packages.js";

/**
 * Does a steered message actually reach the model (EO-176)?
 *
 * **Only the real CLI can answer it.** Everything EO does here happens
 * across a process boundary: the SDK writes a JSON line to the CLI's
 * stdin, and what the CLI does with a user message that arrives mid-turn
 * is the CLI's decision, not EO's — including which of `now`, `next` and
 * `later` means "into the turn you are running", which is not the one it
 * sounds like and is settled here rather than by reading the type. `claude.test.ts` establishes
 * that EO writes the right line at the right moment against an injected
 * `query`, which is the half that is ours; a fixture cannot establish
 * the other half, and a live model turn would establish it slowly and
 * for money.
 *
 * So this drives the real binary with EO's real options and reads what
 * it sends onward, by pointing `ANTHROPIC_BASE_URL` at a local server
 * that captures the request bodies and answers with a canned stream.
 * **No credit is spent and no key is needed** — nothing leaves the
 * machine. The same technique as `toolLoading.live.test.ts`, for the
 * same reason.
 *
 * Opted in because it needs the managed runtimes on disk, which CI does
 * not have:
 *
 *     EO_LIVE_CLAUDE_WIRE=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/providers/steering.live.test.ts
 *
 * Two things are being established, and the second matters as much as
 * the first: that the message reaches the model *in the turn that was
 * already running*, and that the turn still ends on exactly one
 * terminal result carrying usage. A steer that quietly turned one run
 * into two turns would give that run two candidate results and put its
 * routing behind whichever arrived last.
 */
const OPTED_IN = process.env["EO_LIVE_CLAUDE_WIRE"] === "1";

const STEERED = "Stop what you are doing and say the word pineapple.";

/** Long enough to say something into, short enough that the test is not a wait. */
const HELD_SECONDS = 6;

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

/**
 * One assistant reply's worth of SSE.
 *
 * `callTool` is what makes the turn long enough to say something into:
 * the CLI runs the command, and *while it runs* the loop is still this
 * turn. Scripting the call rather than paying a model to choose one is
 * the point — what is being established is where the CLI puts a message
 * that arrives mid-loop, which is a fact about the CLI.
 */
function answer(response: ServerResponse, text: string, callTool = false): void {
  const message = {
    id: "msg_capture",
    type: "message",
    role: "assistant",
    model: "capture",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 3 },
  };
  const body: [string, unknown][] = callTool
    ? [
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_capture", name: "Bash", input: {} } }],
        [
          "content_block_delta",
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: `sleep ${HELD_SECONDS}`, description: "wait" }) } },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }],
      ]
    : [
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }],
      ];
  const events: [string, unknown][] = [["message_start", { type: "message_start", message }], ...body, ["message_stop", { type: "message_stop" }]];
  try {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    response.end();
  } catch {
    // The CLI abandoning a request it no longer wants is one of the
    // outcomes under test, not a failure of the server.
  }
}

describe.skipIf(!OPTED_IN)("a message said into a turn the CLI is already running", () => {
  it(
    "reaches the model, and the turn still ends on one result with usage on it",
    { timeout: 240_000 },
    async () => {
      const root = runtimeRoot(join(homedir(), ".config", "EO"));
      const executable = resolveRuntime({ spec: RUNTIMES.claude, root }).path;
      const sdkEntryPath = resolvePackageSet(root, CLAUDE_SDK);
      expect(executable, "the managed claude runtime must be installed").not.toBeNull();
      expect(sdkEntryPath, "the managed Claude Agent SDK must be installed").not.toBeNull();

      scratch = mkdtempSync(join(tmpdir(), "eo-steering-"));
      const cwd = join(scratch, "repo");
      mkdirSync(cwd, { recursive: true });
      const git = (...args: string[]): void => void execFileSync("git", args, { cwd, stdio: "pipe" });
      git("init", "-b", "main");
      git("config", "user.email", "eo@example.com");
      git("config", "user.name", "EO Steering");
      git("config", "commit.gpgsign", "false");
      git("config", "tag.gpgsign", "false");
      writeFileSync(join(cwd, "README.md"), "# probe\n");
      git("add", "-A");
      git("commit", "-m", "initial");

      const bodies: string[] = [];
      let sawFirstRequest!: () => void;
      // Resolved when the CLI has been told to run the slow command, so
      // the message that follows lands while the turn is still going.
      const turnUnderWay = new Promise<void>((resolve) => {
        sawFirstRequest = resolve;
      });

      const capture = createServer((request: IncomingMessage, response: ServerResponse) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          if (request.url?.includes("/v1/messages") !== true) {
            answer(response, "ok");
            return;
          }
          bodies.push(Buffer.concat(chunks).toString("utf8"));
          const first = bodies.length === 1;
          answer(response, "pineapple", first);
          if (first) sawFirstRequest();
        });
      });
      await new Promise<void>((resolve) => capture.listen(0, "127.0.0.1", resolve));
      const { port } = capture.address() as { port: number };

      setEnv("ANTHROPIC_BASE_URL", `http://127.0.0.1:${port}`);
      setEnv("ANTHROPIC_API_KEY", "sk-ant-capture-not-a-real-key");
      setEnv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");

      const provider = createClaudeProvider({ sdkEntryPath, executablePath: executable });
      const stream = provider.start({
        instructions: "You are a probe.",
        context: "Count slowly to twenty.",
        cwd,
        signal: new AbortController().signal,
      });

      const events: AgentEvent[] = [];
      const draining = (async () => {
        for await (const event of stream) events.push(event);
      })();

      try {
        await turnUnderWay;
        // A moment for the CLI to actually start the command it was just
        // told to run: the request is answered before the tool begins.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(await stream.steer!(STEERED), "the CLI was mid-turn, so the message must have been taken").toBe(true);
        await draining;
      } finally {
        capture.close();
      }

      // The message reached the model, in the request the CLI sent to
      // carry on the turn it was already running.
      expect(bodies.length, "the CLI must have gone back to the model with what it was told").toBe(2);
      expect(bodies[1]).toContain("say the word pineapple");
      // …and it was not in the opening request, which is what makes the
      // one above mean "mid-turn" rather than "in the prompt".
      expect(bodies[0]).not.toContain("say the word pineapple");
      // The CLI's own words for what it did with it. Asserted because
      // this sentence *is* the capability: it says the message was
      // surfaced inside the running turn rather than as a turn of its
      // own, and a CLI that stopped doing this would still pass every
      // assertion above.
      expect(bodies[1]).toContain("The user sent a new message while you were working");

      // One turn, one result, and the accounting the run's cost is summed
      // from still on it (KAN-24). This is the assertion that would have
      // caught `priority: "now"`, which ends the running turn on an empty
      // result and opens a second one.
      expect(events.filter((event) => event.type === "result")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: "result", data: "pineapple" });
      expect(events.filter((event) => event.type === "usage")).not.toEqual([]);
    },
  );

  it(
    "opens no turn of its own when it arrives with no turn left to join",
    { timeout: 240_000 },
    async () => {
      // The other half of the measurement, and the reason the steered
      // message carries `shouldQuery: false`. A message that lands after
      // the model has finished has nothing to be folded into; left to
      // itself the CLI would start a *second* turn with it — a second
      // result and a second bill, on a run EO has already stopped
      // reading. Here it is appended and asked about nothing, which is
      // visible as an entire request that does not happen.
      const root = runtimeRoot(join(homedir(), ".config", "EO"));
      const executable = resolveRuntime({ spec: RUNTIMES.claude, root }).path;
      const sdkEntryPath = resolvePackageSet(root, CLAUDE_SDK);
      expect(executable, "the managed claude runtime must be installed").not.toBeNull();
      expect(sdkEntryPath, "the managed Claude Agent SDK must be installed").not.toBeNull();

      scratch = mkdtempSync(join(tmpdir(), "eo-steering-late-"));
      const cwd = join(scratch, "repo");
      mkdirSync(cwd, { recursive: true });
      const git = (...args: string[]): void => void execFileSync("git", args, { cwd, stdio: "pipe" });
      git("init", "-b", "main");
      git("config", "user.email", "eo@example.com");
      git("config", "user.name", "EO Steering");
      git("config", "commit.gpgsign", "false");
      git("config", "tag.gpgsign", "false");
      writeFileSync(join(cwd, "README.md"), "# probe\n");
      git("add", "-A");
      git("commit", "-m", "initial");

      const bodies: string[] = [];
      let sawFirstRequest!: () => void;
      const asked = new Promise<void>((resolve) => {
        sawFirstRequest = resolve;
      });
      let letTurnEnd!: () => void;
      const held = new Promise<void>((resolve) => {
        letTurnEnd = resolve;
      });

      const capture = createServer((request: IncomingMessage, response: ServerResponse) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          if (request.url?.includes("/v1/messages") !== true) {
            answer(response, "ok");
            return;
          }
          bodies.push(Buffer.concat(chunks).toString("utf8"));
          if (bodies.length === 1) {
            sawFirstRequest();
            // Held open with no tool call in it, so the turn ends the
            // moment it is answered and the message has missed it.
            void held.then(() => answer(response, "twenty"));
            return;
          }
          answer(response, "pineapple");
        });
      });
      await new Promise<void>((resolve) => capture.listen(0, "127.0.0.1", resolve));
      const { port } = capture.address() as { port: number };

      setEnv("ANTHROPIC_BASE_URL", `http://127.0.0.1:${port}`);
      setEnv("ANTHROPIC_API_KEY", "sk-ant-capture-not-a-real-key");
      setEnv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");

      const stream = createClaudeProvider({ sdkEntryPath, executablePath: executable }).start({
        instructions: "You are a probe.",
        context: "Count slowly to twenty.",
        cwd,
        signal: new AbortController().signal,
      });

      const events: AgentEvent[] = [];
      const draining = (async () => {
        for await (const event of stream) events.push(event);
      })();

      try {
        await asked;
        await stream.steer!(STEERED);
        letTurnEnd();
        await draining;
      } finally {
        capture.close();
      }

      // One request: the model was never asked about the message. That
      // is the whole claim — a second turn would be a second request
      // here, and with `priority: "later"` (or `now`) it is exactly what
      // this server would have been sent.
      expect(bodies).toHaveLength(1);

      // And the turn's own answer is the first result, which is the only
      // one anything acts on: `processStream` returns on it and the run
      // is routed from it. The CLI does emit a trailing empty result as
      // its stdin closes — drained here because this test reads to the
      // end, never seen in a run, and carrying nothing either way.
      const first = events.find((event) => event.type === "result");
      expect(first).toMatchObject({ type: "result", data: "twenty" });
    },
  );
});
