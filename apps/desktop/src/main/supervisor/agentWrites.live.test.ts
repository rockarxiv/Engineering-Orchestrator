import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eoToolName, FOLDER_KIND, type AgentEvent, type AgentProvider, type AgentWriteAnswer, type Uuid } from "@eo/core";
import { afterAll, describe, expect, it } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import { createProject, createRun, createWorkspace, listAgents, listCommentsForItem, listMemories } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDbAt } from "../db/testHelpers.js";
import { memoryReadScopes, memoryScopesFor } from "../memory/dispatchMemory.js";
import { writeMemoryNote } from "../memory/memoryNote.js";
import { startAgentWriteBridge } from "../mcp/writeBridge.js";
import { createClaudeProvider } from "../providers/claude.js";
import { createCodexProvider } from "../providers/codex.js";
import { createLocalRecord } from "../record/localRecord.js";
import { RUNTIMES } from "../runtimes/catalog.js";
import { runtimeRoot } from "../runtimes/install.js";
import { CLAUDE_SDK, resolvePackageSet } from "../runtimes/packages.js";
import { resolveRuntime } from "../runtimes/resolve.js";
import { writeAgentComment } from "./agentComments.js";
import { attachRunFiles } from "./runAttachments.js";

/**
 * An agent's three writes, made by the real CLIs (EO-543).
 *
 * The bug this story fixed lived in the one place no stub reaches: what a
 * real backend hands back for a tool's answer. Claude Code returns a
 * tool's `structuredContent` rather than its text, and EO read writes off
 * that text — so on Claude, 66 memory notes and 10 attachments were told
 * "done" and never written while every test passed. The suite holds the
 * adapters to both shapes now (`providerParity.test.ts`, "agent writes
 * through EO"); this asks the binaries themselves.
 *
 * Each backend is given a workspace with a file in it and told to call
 * the `eo` server's `memory_note`, `attachment_add` and a non-blocking
 * `comment`. The `eo` server is the real file both backends launch, with
 * the environment each adapter gives it, and the bridge behind it is the
 * real one. What answers the bridge is what `handleAgentWrite` dispatches
 * to — `writeMemoryNote` through the local record, `attachRunFiles` into
 * a real store, `writeAgentComment` — rather than a whole supervisor run,
 * which would add a pipeline, a sign-in probe and an answer schema to a
 * question about three tool calls. Then the database is read: the note,
 * the attachment and the comment have to exist, and the agent has to
 * have been told each was made.
 *
 * **Opt-in, because it spends real usage on real accounts** — two short
 * turns — and needs both runtimes installed by EO and signed in:
 *
 *     EO_LIVE_AGENT_WRITES=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/supervisor/agentWrites.live.test.ts
 *
 * `EO_CODEX_BIN` names a Codex binary other than the managed one, and
 * `EO_LIVE_AGENT_WRITES_BACKENDS` (`claude`, `codex`, or both, comma
 * separated) narrows the run to one backend.
 */
const OPTED_IN = process.env["EO_LIVE_AGENT_WRITES"] === "1";
const BACKENDS = (process.env["EO_LIVE_AGENT_WRITES_BACKENDS"] ?? "claude,codex").split(",").map((name) => name.trim()) as ("claude" | "codex")[];

const ROOT = runtimeRoot(join(homedir(), ".config", "EO"));
const EO_SERVER = fileURLToPath(new URL("../mcp/eoServer.mjs", import.meta.url));

function executableFor(backend: "claude" | "codex"): string | null {
  return backend === "codex" && process.env["EO_CODEX_BIN"] ? process.env["EO_CODEX_BIN"] : resolveRuntime({ spec: RUNTIMES[backend], root: ROOT }).path;
}

/** The three tools, each in either spelling an allowlist may use. */
const WRITE_TOOLS = ["comment", "attachment_add", "memory_note"];

function providerFor(backend: "claude" | "codex"): AgentProvider {
  const executablePath = executableFor(backend);
  if (backend === "claude") {
    return createClaudeProvider({
      executablePath,
      sdkEntryPath: resolvePackageSet(ROOT, CLAUDE_SDK),
      enableCommentTool: true,
      eoMcp: { serverPath: EO_SERVER, enableMemoryNote: true },
      config: { allowedTools: WRITE_TOOLS.map((tool) => eoToolName(tool)) },
    });
  }
  return createCodexProvider({ executablePath, eoMcp: { serverPath: EO_SERVER, enableCommentTool: true, enableMemoryNote: true } });
}

const cleanup: string[] = [];
afterAll(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe.skipIf(!OPTED_IN).each(BACKENDS)("an agent's writes on the real %s CLI (EO-543)", (backend) => {
  it(
    "writes the memory note, the attachment and the comment it asks for, and tells the agent each was made",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), `eo-agent-writes-${backend}-`));
      cleanup.push(directory);
      const cwd = join(directory, "workspace");
      const handle = openMigratedTestDbAt(join(directory, "eo.db"));
      try {
        // A project with one workspace, as a run on a folder has.
        mkdirSync(cwd);
        const workspace = createWorkspace(handle.db, { kind: FOLDER_KIND, config: { path: cwd } });
        const project = createProject(handle.db, { name: "Payments", keyPrefix: "PAY", workspaceIds: [workspace.id] });
        const item = createTestItem(handle.db, { type: "story", title: "Add CSV export", stepId: "todo", projectId: project.id, workspaceId: workspace.id });
        const agent = listAgents(handle.db).find((entry) => entry.role === "implementer")!;
        const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement", cwd });
        const scopes = memoryScopesFor(handle.db, item, { worksInWorkspace: true });
        const record = createLocalRecord(handle.db);
        const storage = new AttachmentStorage(join(directory, "attachments"));

        // Random, so the agent cannot have them from anywhere but here.
        const fact = `Settlement files are reconciled at ${String(Math.floor(Math.random() * 9) + 1)}:00 UTC, code ${Math.random().toString(36).slice(2, 8)}.`;
        const caption = `Evidence ${Math.random().toString(36).slice(2, 8)}`;
        const remark = `Status ${Math.random().toString(36).slice(2, 8)}`;
        writeFileSync(join(cwd, "evidence.txt"), "1 failed, 41 passed\n");

        // EO's half: what `handleAgentWrite` dispatches each tool to.
        const answers: AgentWriteAnswer[] = [];
        const bridge = await startAgentWriteBridge(async (_itemId, request) => {
          const answer: AgentWriteAnswer =
            request.tool === "comment"
              ? writeAgentComment(handle.db, { itemId: item.id, runId: run.id, agentId: agent.id }, request.args).answer
              : request.tool === "attachment_add"
                ? await attachRunFiles({ db: handle.db, store: storage, itemId: item.id, runId: run.id, agent, directory: cwd, args: request.args })
                : await writeMemoryNote({ record, args: request.args, scopes, runId: run.id, item }).then(
                    (written): AgentWriteAnswer => (written.ok ? { ok: true, text: "EO noted this.", data: { entryId: written.entry.id } } : { ok: false, code: "MEMORY_NOTE_REFUSED", problem: written.problem }),
                  );
          answers.push(answer);
          return answer;
        });

        let events: AgentEvent[];
        try {
          events = await collect(
            providerFor(backend).start({
              instructions:
                "You are an agent working for EO. You work in the current directory. Use the tools of the `eo` MCP server exactly as you are told, once each, in this order, and do nothing else.",
              context: [
                `1. Call \`memory_note\` with scope "project" and text: ${fact}`,
                `2. Call \`attachment_add\` with paths ["evidence.txt"] and caption: ${caption}`,
                `3. Call \`comment\` with body "${remark}", no mentions, and blocking false.`,
                "4. Reply with the single word `done`.",
              ].join("\n"),
              cwd,
              signal: new AbortController().signal,
              attachFrom: { runId: run.id, directory: cwd },
              memoryScopes: memoryReadScopes(scopes),
              writeBridge: bridge.tokenFor(item.id),
            }),
          );
        } finally {
          await bridge.close();
        }
        const said = events.flatMap((event) => (event.type === "output" ? [event.text] : [])).join("\n");

        // The note, the attachment and the comment exist.
        expect(listMemories(handle.db, { kind: "project", id: project.id }).map((entry) => entry.body), `the agent said: ${said}`).toEqual([fact]);
        const comments = listCommentsForItem(handle.db, item.id as Uuid).filter((comment) => comment.authorType === "agent");
        const attachedOn = comments.find((comment) => comment.body === caption);
        expect(attachedOn?.attachments?.map((attachment) => attachment.name), `the agent said: ${said}`).toEqual(["evidence.txt"]);
        expect(comments.some((comment) => comment.body === remark), `the agent said: ${said}`).toBe(true);

        // EO said yes to each, and the backend handed that answer back.
        expect(answers.map((answer) => answer.ok)).toEqual([true, true, true]);
        for (const tool of WRITE_TOOLS) {
          const result = events.find((event) => event.type === "tool_result" && event.name === tool);
          expect(result, `no recorded answer to ${tool}; the agent said: ${said}`).toMatchObject({ ok: true });
        }
      } finally {
        handle.close();
      }
    },
    300_000,
  );
});
