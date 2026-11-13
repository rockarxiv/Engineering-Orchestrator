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
 * Claude Code 2.1.317's account-email check, against EO's real options
 * (EO-644, `privacyPluginHeldOff` in `claudeCompatibility.ts`).
 *
 * The check is a built-in plugin that refuses a shell call whose input
 * holds the signed-in claude.ai account's email and names a User-Agent —
 * as 2.1.321 narrowed it (EO-774); 2.1.317 asked, which unattended is the
 * same refusal, for the email beside any network word. The command below
 * is one both rules catch. EO
 * switches the plugin off, as the CLI before it had none. This drives the
 * real CLI and SDK through EO's provider against a local capture server
 * that scripts the one call, and reads back what the tool returned. **No
 * credit is spent**: the claude.ai login is a stand-in token and an
 * account record in a scratch `CLAUDE_CONFIG_DIR`, and nothing leaves the
 * machine.
 *
 * The control is the person's own choice: their user settings turning
 * the plugin on, on an agent that loads them, is honoured — and the same
 * call is refused, which is also what shows the check was live at all.
 *
 *     EO_LIVE_CLAUDE_WIRE=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/providers/privacyPlugin.live.test.ts
 */

const OPTED_IN = process.env["EO_LIVE_CLAUDE_WIRE"] === "1";

const EMAIL = "probe@example.com";
const COMMAND = `echo curl --user-agent ${EMAIL}`;

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

function setEnv(key: string, value: string | undefined): void {
  restore.push({ key, value: process.env[key] });
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** One reply: the scripted Bash call first, plain text after it. */
function answer(response: ServerResponse, callBash: boolean): void {
  const message = { id: "msg_capture", type: "message", role: "assistant", model: "capture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  const body: [string, unknown][] = callBash
    ? [
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_capture", name: "Bash", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: COMMAND, description: "probe" }) } }],
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

/** What the scripted Bash call returned to the model, as the CLI sent it back. */
async function bashResult(userSettings: Record<string, unknown> | null): Promise<string> {
  const root = runtimeRoot(join(homedir(), ".config", "EO"));
  const executable = resolveRuntime({ spec: RUNTIMES.claude, root }).path;
  const sdkEntryPath = resolvePackageSet(root, CLAUDE_SDK);
  expect(executable, "the managed claude runtime must be installed").not.toBeNull();
  expect(sdkEntryPath, "the managed Claude Agent SDK must be installed").not.toBeNull();

  scratch = mkdtempSync(join(tmpdir(), "eo-privacy-plugin-"));
  const cwd = join(scratch, "repo");
  const config = join(scratch, "config");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(config, { recursive: true });
  // The stored claude.ai account the check reads the email from.
  writeFileSync(
    join(config, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      oauthAccount: { emailAddress: EMAIL, accountUuid: "00000000-0000-4000-8000-000000000001", organizationUuid: "00000000-0000-4000-8000-000000000002" },
    }),
  );
  if (userSettings) writeFileSync(join(config, "settings.json"), JSON.stringify(userSettings));

  const bodies: string[] = [];
  const capture = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const isTurn = request.url?.includes("/v1/messages") === true && request.url.includes("count_tokens") === false;
      if (isTurn) bodies.push(Buffer.concat(chunks).toString("utf8"));
      answer(response, isTurn && bodies.length === 1);
    });
  });
  await new Promise<void>((resolve) => capture.listen(0, "127.0.0.1", resolve));
  const { port } = capture.address() as { port: number };

  setEnv("ANTHROPIC_BASE_URL", `http://127.0.0.1:${port}`);
  setEnv("CLAUDE_CONFIG_DIR", config);
  setEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-capture-not-a-real-token");
  setEnv("ANTHROPIC_API_KEY", undefined);
  setEnv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");

  const provider = createClaudeProvider({
    sdkEntryPath,
    executablePath: executable,
    enableCommentTool: false,
    // The person's own setup, so that their user settings are loaded and
    // the control below is a choice the CLI would actually read.
    config: { inheritAmbientConfig: true },
  });
  try {
    for await (const _ of provider.start({ instructions: "You are a probe.", context: "Run it.", cwd, signal: new AbortController().signal } as never)) void _;
  } finally {
    capture.close();
  }
  const results = bodies.flatMap((body) =>
    ((JSON.parse(body) as { messages?: { content?: unknown }[] }).messages ?? []).flatMap((message) =>
      Array.isArray(message.content) ? (message.content as { type?: string; tool_use_id?: string; content?: unknown }[]).filter((block) => block.type === "tool_result" && block.tool_use_id === "toolu_capture") : [],
    ),
  );
  expect(results.length, "the CLI must have sent the call's result back").toBeGreaterThan(0);
  return JSON.stringify(results[0]?.content);
}

describe.skipIf(!OPTED_IN)("Claude Code's account-email check on an EO turn (EO-644)", () => {
  it("lets the call run, as the CLI before 2.1.317 did", { timeout: 240_000 }, async () => {
    // The command's own output: it ran.
    expect(JSON.parse(await bashResult(null))).toContain(`curl --user-agent ${EMAIL}`);
  });

  it("leaves it on where the person's own settings turn it on, and the call is refused", { timeout: 240_000 }, async () => {
    const result = await bashResult({ enabledPlugins: { "cc-plugin-privacy@builtin": true } });
    expect(result).toContain("denied by plugin cc-plugin-privacy");
  });
});
