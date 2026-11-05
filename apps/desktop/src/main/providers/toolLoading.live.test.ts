import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeProvider } from "./claude.js";
import { runtimeRoot } from "../runtimes/install.js";
import { RUNTIMES } from "../runtimes/catalog.js";
import { resolveRuntime } from "../runtimes/resolve.js";
import { CLAUDE_SDK, resolvePackageSet } from "../runtimes/packages.js";

/**
 * Are EO's own MCP tools in the prompt, or behind `ToolSearch` (EO-161)?
 *
 * **Only a real CLI can answer it, and no model has to.** Deferral is a
 * decision the binary EO downloads makes while it builds the request:
 * it either puts an MCP server's tool schemas in `tools[]` or replaces
 * them with a `ToolSearch` tool and a placeholder. A fixture proves
 * nothing about it, and a live model turn proves it only indirectly and
 * costs money to do so. So this drives the real CLI with EO's real
 * options and reads the request it produces, by pointing
 * `ANTHROPIC_BASE_URL` at a local server that captures the body and
 * answers with a canned stream. **No credit is spent and no key is
 * needed** — nothing leaves the machine.
 *
 * Opted in because it needs the managed runtimes on disk, which CI does
 * not have:
 *
 *     EO_LIVE_CLAUDE_WIRE=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/providers/toolLoading.live.test.ts
 *
 * **`ENABLE_TOOL_SEARCH=true` is set, and not setting it would make this
 * test pass for the wrong reason.** Up to Claude Code 2.1.302 the CLI
 * turned tool search off when the session was pointed at a host it did
 * not recognise as Anthropic's, saying so itself: "disabled:
 * ANTHROPIC_BASE_URL=... is not a first-party Anthropic host. Set
 * ENABLE_TOOL_SEARCH=true (or auto / auto:N) if your proxy forwards
 * tool_reference blocks." 2.1.304 dropped that, and EO now gives the old
 * answer itself (`toolSearchHeldOff`, EO-599), which the later cases
 * here measures. A capture server is exactly such a host, so without the
 * variable every tool would be in the prompt whatever EO did, and the
 * first case would assert nothing. With it, deferral is on and the only
 * variable left is EO's.
 *
 * **The control is inside the run rather than beside it.** All three
 * servers are the same script with the same shape of tools; what
 * differs is the route EO delivers them by. `eo` and `repo` go inline
 * through `options.mcpServers`, which is where `alwaysLoad` is set;
 * `probe` stands in for a server a person attached from the catalogue
 * and goes through the generated directory and `--mcp-config`, which
 * `alwaysLoad` never touches. One request body answers both halves of
 * the story, with everything else held constant.
 *
 * The paired measurement that established the option is the cause,
 * taken by flipping `ALWAYS_LOAD_EO_SERVERS` and changing nothing else:
 *
 *     alwaysLoad absent   tools[] 12, ToolSearch present,
 *                         mcp__eo__* / mcp__repo__* / mcp__probe__* all ABSENT
 *     alwaysLoad: true    tools[] 18, ToolSearch present,
 *                         mcp__eo__* and mcp__repo__* present and undeferred,
 *                         mcp__probe__* still ABSENT
 */

const OPTED_IN = process.env["EO_LIVE_CLAUDE_WIRE"] === "1";

/** A stdio MCP server that answers `tools/list` and nothing else interesting. */
const STUB_SERVER = `import { createInterface } from "node:readline";
const name = process.argv[2] ?? "stub";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const tool = (index) => ({
  name: name + "_tool_" + index,
  description: "Tool " + index + " of the " + name + " stub server.",
  inputSchema: { type: "object", properties: { note: { type: "string" } }, additionalProperties: false },
});
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name, version: "0.0.1" } } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [tool(0), tool(1), tool(2)] } });
  } else if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "pong" }] } });
  } else if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
`;

interface CapturedTool {
  name: string;
  description?: string;
  defer_loading?: boolean;
}

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

function unsetEnv(key: string): void {
  restore.push({ key, value: process.env[key] });
  delete process.env[key];
}

/** The tool the scripted first reply calls — EO's own server, undeferred. */
const CALLED_TOOL = "mcp__eo__stub_tool_0";

/**
 * One assistant turn's worth of SSE — enough for the CLI to act and exit.
 *
 * The first reply calls an `mcp__eo__` tool and the rest end the turn.
 * Scripting the call rather than paying a model to choose it is the
 * point: what is being established is that an exempt tool is *callable*
 * with nothing loaded first, which is a fact about the CLI and not about
 * the model's judgement. It is also a genuinely separate failure from
 * the tools being listed — a CLI that listed them and still demanded a
 * `tool_reference` load would pass every other assertion in this file.
 */
function answer(response: ServerResponse, callTool: boolean): void {
  const message = { id: "msg_capture", type: "message", role: "assistant", model: "capture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  const body: [string, unknown][] = callTool
    ? [
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_capture", name: CALLED_TOOL, input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }],
      ]
    : [
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
      ];
  const events: [string, unknown][] = [["message_start", { type: "message_start", message }], ...body, ["message_stop", { type: "message_stop" }]];
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  response.end();
}

/** How a capture is set up, beyond `ENABLE_TOOL_SEARCH`. */
interface CaptureSetup {
  /** Where the capture server's URL is given: the spawn environment, or only the repository's own settings file (EO-599). */
  baseUrlIn?: "env" | "projectSettings";
  /** Vertex, with this deployment named as the model, rather than Anthropic's API (EO-599). */
  vertexModel?: string;
  /** Anything else the person has set. */
  env?: Record<string, string>;
}

/**
 * One turn of the real CLI with EO's real options against the capture
 * server: what it put in its first request, and what EO streamed.
 * `enableToolSearch` is the variable as the person would have it, `null`
 * for not set at all.
 */
async function captureFirstRequest(enableToolSearch: string | null, setup: CaptureSetup = {}): Promise<{ tools: CapturedTool[]; streamed: { type: string; name?: string }[] }> {
  const root = runtimeRoot(join(homedir(), ".config", "EO"));
  const executable = resolveRuntime({ spec: RUNTIMES.claude, root }).path;
  const sdkEntryPath = resolvePackageSet(root, CLAUDE_SDK);
  expect(executable, "the managed claude runtime must be installed").not.toBeNull();
  expect(sdkEntryPath, "the managed Claude Agent SDK must be installed").not.toBeNull();

  scratch = mkdtempSync(join(tmpdir(), "eo-tool-loading-"));
  const serverPath = join(scratch, "stub-server.mjs");
  writeFileSync(serverPath, STUB_SERVER);

  const cwd = join(scratch, "repo");
  mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "eo@example.com");
  git("config", "user.name", "EO Tool Loading");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  writeFileSync(join(cwd, "README.md"), "# probe\n");
  git("add", "-A");
  git("commit", "-m", "initial");

  // The attached server, delivered exactly as a person's is: a
  // generated directory whose `.mcp.json` the CLI is pointed at.
  const toolDirectory = join(scratch, "tools");
  mkdirSync(join(toolDirectory, ".claude-plugin"), { recursive: true });
  writeFileSync(join(toolDirectory, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name: "eo-attachments", description: "attached", version: "0.0.0" }, null, 2)}\n`);
  writeFileSync(join(toolDirectory, ".mcp.json"), `${JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [serverPath, "probe"] } } }, null, 2)}\n`);

  const bodies: string[] = [];
  const capture = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      // Anthropic's API, or Vertex's spelling of the same request.
      const isTurn = request.url?.includes("/v1/messages") === true || request.url?.includes(":streamRawPredict") === true;
      if (isTurn) bodies.push(Buffer.concat(chunks).toString("utf8"));
      answer(response, isTurn && bodies.length === 1);
    });
  });
  await new Promise<void>((resolve) => capture.listen(0, "127.0.0.1", resolve));
  const { port } = capture.address() as { port: number };

  const url = `http://127.0.0.1:${port}`;
  if (setup.vertexModel) {
    unsetEnv("ANTHROPIC_BASE_URL");
    for (const [name, value] of Object.entries({ CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_SKIP_VERTEX_AUTH: "1", ANTHROPIC_VERTEX_BASE_URL: url, ANTHROPIC_VERTEX_PROJECT_ID: "eo-capture", CLOUD_ML_REGION: "us-east5" })) setEnv(name, value);
  } else if (setup.baseUrlIn === "projectSettings") {
    // Nowhere in the environment: only the repository's settings name it.
    unsetEnv("ANTHROPIC_BASE_URL");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "settings.json"), `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: url } }, null, 2)}\n`);
  } else {
    setEnv("ANTHROPIC_BASE_URL", url);
  }
  setEnv("ANTHROPIC_API_KEY", "sk-ant-capture-not-a-real-key");
  for (const [name, value] of Object.entries(setup.env ?? {})) setEnv(name, value);
  if (enableToolSearch === null) unsetEnv("ENABLE_TOOL_SEARCH");
  else setEnv("ENABLE_TOOL_SEARCH", enableToolSearch);
  setEnv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");

  const provider = createClaudeProvider({
    sdkEntryPath,
    executablePath: executable,
    eoMcp: { serverPath },
    // No turn cap (EO-375): the capture server answers the second
    // turn with plain text, which ends the run on its own.
  });

  const streamed: { type: string; name?: string }[] = [];
  try {
    for await (const event of provider.start({
      instructions: "You are a probe.",
      context: "Say ok.",
      cwd,
      toolDirectory,
      repositoryMcp: { name: "repo", command: process.execPath, args: [serverPath, "repo"], env: {} },
      ...(setup.vertexModel ? { model: setup.vertexModel } : {}),
      signal: new AbortController().signal,
    })) {
      streamed.push(event.type === "tool_call" ? { type: event.type, name: event.name } : { type: event.type });
    }
  } finally {
    capture.close();
  }
  expect(streamed, "the CLI must have run at all").not.toEqual([]);
  expect(bodies.length, "the CLI must have sent a request to the capture server").toBeGreaterThan(0);
  return { tools: (JSON.parse(bodies[0] as string) as { tools?: CapturedTool[] }).tools ?? [], streamed };
}

describe.skipIf(!OPTED_IN)("what the CLI puts in the prompt", () => {
  it(
    "carries EO's own servers undeferred and leaves an attached one behind ToolSearch",
    { timeout: 240_000 },
    async () => {
      const { tools, streamed } = await captureFirstRequest("true");
      const names = tools.map((tool) => tool.name);

      // Deferral is genuinely on, so the assertions below mean something.
      expect(names, "tool search must be enabled for this measurement to say anything").toContain("ToolSearch");

      // EO's own two servers: in the prompt, and not marked deferred.
      for (const server of ["eo", "repo"]) {
        const own = tools.filter((tool) => tool.name.startsWith(`mcp__${server}__`));
        expect(own.map((tool) => tool.name), `${server} tools belong in the prompt`).toHaveLength(3);
        expect(own.filter((tool) => tool.defer_loading), `${server} tools must not be deferred`).toEqual([]);
      }

      // A server a person attached is untouched: still behind ToolSearch,
      // which is what EO-161 scoped and what a catalogue of ten servers
      // depends on.
      expect(names.filter((name) => name.startsWith("mcp__probe__")), "an attached server stays deferred").toEqual([]);

      // And the acceptance criterion in its own words: the run's events
      // show one of EO's tools called, with no ToolSearch anywhere
      // before it. The name is the one EO records, prefix stripped by
      // `normaliseToolName` so the supervisor's own branches fire.
      const called = streamed.findIndex((event) => event.type === "tool_call" && event.name === "stub_tool_0");
      expect(called, "the exempt tool must have been called").toBeGreaterThanOrEqual(0);
      expect(
        streamed.slice(0, called).filter((event) => event.name === "ToolSearch"),
        "nothing may need loading first",
      ).toEqual([]);
    },
  );

  it(
    "keeps tool search off behind a host that is not Anthropic's, as the CLI did before 2.1.304 (EO-599)",
    { timeout: 240_000 },
    async () => {
      // The person has not set `ENABLE_TOOL_SEARCH`, and the capture
      // server is a host the old CLI did not recognise as Anthropic's —
      // the case 2.1.304 turned tool search on for, and EO holds off
      // (`toolSearchHeldOff`). Every tool is then in the prompt, the
      // attached server's included, as it was at claude@0.3.302.
      const { tools } = await captureFirstRequest(null);
      const names = tools.map((tool) => tool.name);
      expect(names, "tool search must stay off").not.toContain("ToolSearch");
      expect(names.filter((name) => name.startsWith("mcp__probe__")), "the attached server's tools are in the prompt").toHaveLength(3);
      expect(tools.filter((tool) => tool.defer_loading), "nothing is deferred").toEqual([]);
    },
  );
  it(
    "keeps tool search off for a base URL only the repository's settings name (EO-599)",
    { timeout: 240_000 },
    async () => {
      // The same case as above, but the gateway is named nowhere EO's own
      // environment could see it: only in `.claude/settings.json`, which a
      // locked-down agent loads. 2.1.302 and 2.1.312 both route there, and
      // without the hold 2.1.312 put the attached server behind ToolSearch.
      const { tools } = await captureFirstRequest(null, { baseUrlIn: "projectSettings" });
      const names = tools.map((tool) => tool.name);
      expect(names, "tool search must stay off").not.toContain("ToolSearch");
      expect(names.filter((name) => name.startsWith("mcp__probe__")), "the attached server's tools are in the prompt").toHaveLength(3);
    },
  );

  it(
    "keeps the full tool descriptions for a custom deployment on Vertex (EO-599)",
    { timeout: 480_000 },
    async () => {
      // 2.1.312 sends a deployment name it does not recognise the lean
      // descriptions; 2.1.302 sent the full ones. With EO's hold the
      // request is the one the person would get by asking for the full
      // prompt themselves, and not the one they would get asking for the
      // short one.
      const descriptions = (tools: CapturedTool[]): string => JSON.stringify(tools.filter((tool) => !tool.name.startsWith("mcp__")).map((tool) => [tool.name, tool.description]));
      const held = descriptions((await captureFirstRequest("true", { vertexModel: "my-custom-deployment" })).tools);
      const full = descriptions((await captureFirstRequest("true", { vertexModel: "my-custom-deployment", env: { CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: "0" } })).tools);
      const lean = descriptions((await captureFirstRequest("true", { vertexModel: "my-custom-deployment", env: { CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: "1" } })).tools);
      expect(full, "the two prompts must differ for this to say anything").not.toBe(lean);
      expect(held).toBe(full);
    },
  );
});
