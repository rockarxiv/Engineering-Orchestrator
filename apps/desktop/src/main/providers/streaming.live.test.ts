import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liveMessageOf, type AgentEvent } from "@eo/core";
import { createClaudeProvider } from "./claude.js";
import { createCodexProvider } from "./codex.js";
import { runtimeRoot } from "../runtimes/install.js";
import { RUNTIMES } from "../runtimes/catalog.js";
import { resolveRuntime } from "../runtimes/resolve.js";
import { CLAUDE_SDK, resolvePackageSet } from "../runtimes/packages.js";

/**
 * Do the real backends stream a turn's words as they are written, the
 * way the chat now draws them?
 *
 * `providerParity.test.ts` holds both adapters to one reading of a
 * scripted stream. Whether the CLIs actually send partial messages and
 * item deltas for EO's real options — under an output schema, with
 * reasoning summaries asked for — is the CLIs' to answer, so this asks
 * them: one short turn on each, against the person's own sign-in.
 *
 * **Opt-in, because it spends real usage on a real account** — a
 * sentence each, and it needs both runtimes installed and signed in:
 *
 *     EO_LIVE_STREAMING=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/providers/streaming.live.test.ts
 *
 * What counts as streamed: more than one text delta, joining (read
 * through `liveMessageOf`, since the answer is the schema's JSON) to the
 * message the turn finally answers with, and every delta arriving before
 * the turn's result.
 */
const OPTED_IN = process.env["EO_LIVE_STREAMING"] === "1";

const SCHEMA = {
  type: "object",
  properties: { outcome: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false } },
  required: ["outcome"],
  additionalProperties: false,
};

const ASK =
  "Answer in the schema. In `outcome.message`, write three short sentences about why a kitchen timer is useful. Do not use any tools.";

let workspace: string | null = null;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

function repository(): string {
  workspace = mkdtempSync(join(tmpdir(), "eo-streaming-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "pipe" });
  writeFileSync(join(workspace, "README.md"), "# streaming\n");
  return workspace;
}

/** Every event of a turn, with when each arrived. */
async function timed(stream: AsyncIterable<AgentEvent>): Promise<{ event: AgentEvent; at: number }[]> {
  const seen: { event: AgentEvent; at: number }[] = [];
  for await (const event of stream) seen.push({ event, at: Date.now() });
  return seen;
}

function messageOf(data: unknown): string {
  const outcome = (data as { outcome?: { message?: unknown } } | null)?.outcome;
  return typeof outcome?.message === "string" ? outcome.message : "";
}

function expectStreamed(seen: { event: AgentEvent; at: number }[]): void {
  const deltas = seen.flatMap(({ event, at }) => (event.type === "output_delta" && event.stream === "text" ? [{ text: event.text, at }] : []));
  const result = seen.find(({ event }) => event.type === "result");
  expect(result, "the turn ended on a result").toBeDefined();
  const answered = messageOf(result!.event.type === "result" ? result!.event.data : null);
  expect(answered.length, "the answer has a message").toBeGreaterThan(20);

  // Many pieces, not a few: a few large chunks is a block arriving whole by instalments.
  expect(deltas.length, `the answer arrived in pieces (${deltas.length})`).toBeGreaterThan(10);
  expect(deltas.every(({ at }) => at <= result!.at), "every piece came before the result").toBe(true);
  // The pieces of the answer's block, joined and read as the chat reads
  // them, say what the turn answered. Narration before it, if any, is a
  // separate block whose pieces are joined into the same string here, so
  // the answer is looked for at the end.
  const written = liveMessageOf([deltas.map(({ text }) => text).join("")]);
  expect(written.replace(/\s+/g, " ").trim().endsWith(answered.replace(/\s+/g, " ").trim().slice(-40))).toBe(true);
}

describe.skipIf(!OPTED_IN)("a streamed turn on the real backends", () => {
  it(
    "Claude sends the answer's words as they are written",
    { timeout: 240_000 },
    async () => {
      const root = runtimeRoot(join(homedir(), ".config", "EO"));
      const executablePath = resolveRuntime({ spec: RUNTIMES.claude, root }).path;
      const sdkEntryPath = resolvePackageSet(root, CLAUDE_SDK);
      expect(executablePath, "the managed claude runtime must be installed").not.toBeNull();
      expect(sdkEntryPath, "the managed Claude Agent SDK must be installed").not.toBeNull();

      const provider = createClaudeProvider({ sdkEntryPath: sdkEntryPath!, executablePath: executablePath!, enableCommentTool: false });
      const seen = await timed(
        provider.start({
          instructions: "You are a concise assistant.",
          context: ASK,
          cwd: repository(),
          outputSchema: SCHEMA,
          streamDeltas: true,
          showReasoning: true,
          signal: new AbortController().signal,
        }),
      );
      expectStreamed(seen);
      // Nothing streamed is stored by the adapter's own events: the deltas
      // are separate from the finished blocks, which still arrive whole.
      expect(seen.some(({ event }) => event.type === "tool_call" && event.name === "StructuredOutput")).toBe(true);
    },
  );

  it(
    "Codex sends the answer's words as they are written",
    { timeout: 240_000 },
    async () => {
      const codex = process.env["EO_CODEX_BIN"] ?? join(homedir(), ".config", "EO", "runtimes", "codex@0.167.1-linux-x64", "vendor", "x86_64-unknown-linux-musl", "bin", "codex");
      const provider = createCodexProvider({ executablePath: codex });
      const seen = await timed(
        provider.start({
          instructions: "You are a concise assistant.",
          context: ASK,
          cwd: repository(),
          outputSchema: SCHEMA,
          streamDeltas: true,
          showReasoning: true,
          signal: new AbortController().signal,
        }),
      );
      expectStreamed(seen);
    },
  );
});
