import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEAM_EVIDENCE_TOOLS, type AgentEvent, type AgentWriteRequest } from "@eo/core";
import { afterEach, describe, expect, it } from "vitest";
import { startAgentWriteBridge, type AgentWriteBridge } from "../mcp/writeBridge.js";
import { codexClientOptions, createCodexProvider, type CodexProviderOptions } from "./codex.js";
import { CodexClient } from "./codexClient.js";
import { personCodexHome } from "./codexHome.js";

/**
 * A report-only team participant on the real Codex app-server (EO-845),
 * with **no credit spent**: a local server stands in for the model,
 * records what each request offered, and scripts the calls a participant
 * must not be able to make — a shell command and code mode's
 * `exec_command` that would each leave a marker, a patch, a subagent,
 * EO's `comment` — beside the one it may, `evidence_list`. Then it reads
 * back what the app-server did.
 *
 * Asserted on a fresh thread and on the same thread resumed: no marker
 * exists, no request offered a shell, code execution, a patch tool, the
 * multi-agent tools or web search, every forbidden call came back
 * refused, and EO's bridge was asked for the evidence and for nothing
 * else. Codex's own hook, EO's command and its trust are the real ones.
 *
 *     EO_LIVE_CODEX=1 EO_CODEX_BIN=<the pinned codex> pnpm exec vitest run --root apps/desktop \
 *       src/main/providers/reportOnlyCodex.live.test.ts
 *
 * Passed against 0.167.1 (EO-845): every forbidden call is answered
 * "unsupported call" — the tools are not offered at all — the sandbox is
 * read-only, and the `eo` server's tools are deferred behind Codex's
 * client-side `tool_search`, in the `mcp__eo` namespace, as the script
 * below asks for them.
 */

const OPTED_IN = process.env["EO_LIVE_CODEX"] === "1";
const CODEX = process.env["EO_CODEX_BIN"] ?? "codex";
const MODEL = process.env["EO_CODEX_MODEL"] ?? "gpt-6-luna";
const HERE = dirname(fileURLToPath(import.meta.url));

let server: Server | null = null;
let bridge: AgentWriteBridge | null = null;
const cleanup: string[] = [];
afterEach(async () => {
  server?.close();
  server = null;
  await bridge?.close();
  bridge = null;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Every tool name a request offered, namespaces flattened, and what a code-mode `exec` would carry. */
function toolsOf(body: unknown): string[] {
  const names: string[] = [];
  const walk = (tools: unknown, prefix: string) => {
    for (const tool of (tools as { type?: string; name?: string; tools?: unknown; description?: string }[] | undefined) ?? []) {
      if (tool.type === "namespace") walk(tool.tools, `${prefix}${tool.name}.`);
      else {
        names.push(`${prefix}${tool.name ?? tool.type}`);
        for (const nested of (tool.description ?? "").matchAll(/^### `([^`]+)`/gm)) names.push(`${prefix}${tool.name}>${nested[1]}`);
      }
    }
  };
  const request = body as { tools?: unknown; input?: { type?: string; tools?: unknown }[] };
  walk(request.tools, "");
  for (const item of request.input ?? []) if (item.type === "additional_tools") walk(item.tools, "");
  return names;
}

type Input = { type?: string; role?: string; call_id?: string; output?: unknown }[];

function sse(events: Record<string, unknown>[]): string {
  return events.map((event) => `event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 };

describe.skipIf(!OPTED_IN)("a report-only participant on the real Codex app-server (EO-845, no credit)", () => {
  it("is offered no shell, code execution, patch, subagent or web tool, runs none of them, and reaches EO only for its evidence — fresh and resumed", { timeout: 300_000 }, async () => {
    const scratch = mkdtempSync(join(tmpdir(), "eo-report-only-codex-"));
    const home = mkdtempSync(join(homedir(), ".eo-report-only-codex-home-"));
    cleanup.push(scratch, home);
    mkdirSync(join(home, "sessions"), { recursive: true });
    const cwd = join(scratch, "participant");
    mkdirSync(cwd, { recursive: true });
    const markers = { shell: join(scratch, "shell-ran"), exec: join(scratch, "exec-ran"), patch: join(scratch, "patched") };

    const asked: AgentWriteRequest[] = [];
    bridge = await startAgentWriteBridge(async (_itemId, request) => {
      asked.push(request);
      return { ok: true, text: "EVIDENCE-LISTED: report.md", data: {} };
    });
    const credential = { ...bridge.tokenFor("item-1", TEAM_EVIDENCE_TOOLS, "attempt-1"), reportOnly: true };

    const bodies: { tools?: unknown; input?: Input }[] = [];
    const calls = (turn: number) => [
      { type: "function_call", id: `fc_shell_${String(turn)}`, call_id: `call_shell_${String(turn)}`, name: "shell", arguments: JSON.stringify({ command: ["touch", markers.shell] }) },
      { type: "function_call", id: `fc_exec_${String(turn)}`, call_id: `call_exec_${String(turn)}`, name: "exec_command", arguments: JSON.stringify({ cmd: `touch ${markers.exec}` }) },
      { type: "custom_tool_call", id: `ct_patch_${String(turn)}`, call_id: `call_patch_${String(turn)}`, name: "apply_patch", input: `*** Begin Patch\n*** Add File: ${markers.patch}\n+x\n*** End Patch\n` },
      { type: "function_call", id: `fc_spawn_${String(turn)}`, call_id: `call_spawn_${String(turn)}`, name: "spawn_agent", arguments: JSON.stringify({ message: `touch ${markers.shell}` }) },
      { type: "function_call", id: `fc_comment_${String(turn)}`, call_id: `call_comment_${String(turn)}`, name: "mcp__eo__comment", arguments: JSON.stringify({ body: "@user posted by a participant" }) },
      { type: "tool_search_call", id: `ts_${String(turn)}`, call_id: `call_search_${String(turn)}`, execution: "client", status: "completed", arguments: { query: "evidence list", limit: 8 } },
    ];
    let turn = 0;
    server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      request.on("end", () => {
        const body = (raw ? JSON.parse(raw) : {}) as (typeof bodies)[number];
        bodies.push(body);
        // A user message opens a turn: every call at once, the deferred
        // tools searched for among them. The search's answer is followed by
        // the evidence call, in the namespace Codex named, and its answer
        // by the report.
        const last = (body.input ?? []).at(-1);
        const opening = last?.type === "message";
        if (opening) turn += 1;
        const id = `resp_${String(bodies.length)}`;
        const items = opening
          ? calls(turn)
          : last?.type === "tool_search_output"
            ? [{ type: "function_call", id: `fc_evidence_${String(turn)}`, call_id: `call_evidence_${String(turn)}`, namespace: "mcp__eo", name: "evidence_list", arguments: "{}" }]
            : [{ type: "message", id: `msg_${String(bodies.length)}`, role: "assistant", content: [{ type: "output_text", text: "Reported.", annotations: [] }] }];
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          sse([
            { type: "response.created", response: { id } },
            ...items.map((item, index) => ({ type: "response.output_item.done", output_index: index, item })),
            { type: "response.completed", response: { id, usage } },
          ]),
        );
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const options: CodexProviderOptions = {
      reportOnly: true,
      executablePath: CODEX,
      eoMcp: { serverPath: join(HERE, "..", "mcp", "eoServer.mjs"), enableCommentTool: true },
      codexHome: () => home,
      searchHookCommandPath: join(HERE, "codexSearchHookCommand.mjs"),
      sideCallModelCaches: () => [join(personCodexHome(), "models_cache.json")],
      config: { model: MODEL },
    };
    const provider = createCodexProvider({
      ...options,
      createCodex: (repository, searchHook, attachFrom, memoryScopes, variables, writeBridge, withheld, adminDirectory, skillSlugs) => {
        const built = codexClientOptions(options, repository, searchHook, attachFrom, memoryScopes, variables, writeBridge, withheld, adminDirectory, skillSlugs);
        return new CodexClient({
          ...built,
          config: {
            ...built.config,
            model_provider: "capture",
            model_providers: { capture: { name: "capture", base_url: `http://127.0.0.1:${String(port)}/v1`, wire_api: "responses", request_max_retries: 0, stream_max_retries: 0 } },
          },
        });
      },
    });

    const run = async (resume: string | null): Promise<AgentEvent[]> => {
      const events: AgentEvent[] = [];
      const opts = { cwd, writeBridge: credential, signal: AbortSignal.timeout(240_000) };
      const stream = resume === null ? provider.start({ ...opts, instructions: "You are a probe.", context: "Report." }) : provider.resume(resume, "Report again.", opts);
      for await (const event of stream) events.push(event);
      return events;
    };
    const first = await run(null);
    const thread = first.find((event): event is Extract<AgentEvent, { type: "thread_started" }> => event.type === "thread_started")?.threadId;
    expect(thread, "the fresh turn must open a thread").toBeDefined();
    await run(thread!);

    for (const [name, marker] of Object.entries(markers)) expect(existsSync(marker), `the ${name} marker`).toBe(false);
    for (const body of bodies) {
      const offered = toolsOf(body);
      for (const forbidden of ["shell", "exec", "exec_command", "apply_patch", "spawn_agent", "web_search", "view_image", "comment"]) {
        expect(offered.filter((name) => name === forbidden || name.endsWith(`.${forbidden}`) || name.endsWith(`>${forbidden}`) || name.endsWith(`__${forbidden}`)), forbidden).toEqual([]);
      }
    }
    // Every forbidden call came back refused, and the evidence call answered by EO.
    const outputs = new Map<string, string>();
    for (const body of bodies) for (const item of body.input ?? []) if (item.call_id !== undefined && typeof item.output === "string") outputs.set(item.call_id, item.output);
    for (const name of ["shell", "exec", "patch", "spawn", "comment"]) {
      for (const turnNumber of [1, 2]) expect(outputs.get(`call_${name}_${String(turnNumber)}`), `${name} on turn ${String(turnNumber)}`).toMatch(/^unsupported|EO refused this call/);
    }
    expect(outputs.get("call_evidence_2")).toContain("EVIDENCE-LISTED");
    // The sandbox it ran in reads only.
    expect(JSON.stringify(bodies[0]?.input)).toContain("`sandbox_mode` is `read-only`");
    expect(asked.map((request) => request.tool)).toEqual(["evidence_list", "evidence_list"]);
    expect(turn).toBe(2);
  });
});
