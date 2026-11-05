import { LOCAL_PERSON_ID, type Agent, type AgentWriteBridgeAddress, type Item } from "@eo/core";
import type { ThreadEvent } from "../providers/codexClient.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { comments, commentMentions } from "../db/schema.js";
import { getItem, listAgents, listRunEvents, listRunsForItem, needsAttention, postComment } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createCodexProvider } from "../providers/codex.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
// @ts-expect-error — the service is plain JavaScript, deliberately: it ships
// unbundled because Codex spawns it by path.
import { createEoMcpService } from "./eoServer.mjs";

// The point of A-05 is that a *real* agent can escalate. The MCP server
// itself is exercised over stdio in eoServer.test.ts; what's left to
// prove is the seam (EO-543): that a `comment` call an agent makes is
// handed by the `eo` server — started with the environment the adapter
// gave it — over the agent write bridge to the real supervisor, which
// posts it and, for a blocking one, ends the run; and that what Codex
// then reports about the call is recorded and acted on by nothing. So
// this drives a stubbed Codex that runs the real service for each call,
// through the real provider and the real supervisor.
let handle: DbHandle;
let item: Item;
let implementer: Agent;
let writes: TestWriteBridge;

const service = createEoMcpService as (options: Record<string, unknown>) => {
  handle(request: unknown): Promise<{ result: { content: unknown[]; structuredContent?: unknown; isError?: boolean } } | null>;
  close(): void;
};

/** A comment call: made against the real `eo` service on this turn's bridge, as the CLI would, then reported as Codex reports one. */
type Step = ThreadEvent | { comment: Record<string, unknown> };

function stubCodexEmitting(steps: Step[]) {
  const answers: unknown[] = [];
  const threadFor = (writeBridge: AgentWriteBridgeAddress | undefined) => ({
    runStreamed: vi.fn(async () => ({
      events: (async function* () {
        for (const step of steps) {
          if (!("comment" in step)) {
            yield step;
            continue;
          }
          const eo = service({ dbPath: undefined, enableCommentTool: true, writeBridge: writeBridge ?? null });
          const answered = await eo.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "comment", arguments: step.comment } });
          eo.close();
          answers.push(answered?.result);
          yield {
            type: "item.completed",
            item: {
              id: `call-${String(answers.length)}`,
              type: "mcp_tool_call",
              server: "eo",
              tool: "comment",
              arguments: step.comment,
              result: { content: answered?.result.content ?? [], structured_content: answered?.result.structuredContent ?? null },
              status: "completed",
            },
          } as ThreadEvent;
        }
      })(),
    })),
    run: vi.fn(),
  });
  const createCodex = (...args: unknown[]) => {
    const thread = threadFor(args[5] as AgentWriteBridgeAddress | undefined);
    return { startThread: vi.fn(() => thread), resumeThread: vi.fn(() => thread) };
  };
  return { createCodex, answers };
}

function supervisorOver(codex: ReturnType<typeof stubCodexEmitting>) {
  const supervisor = createRunSupervisor({
    db: handle.db,
    provider: createCodexProvider({ createCodex: codex.createCodex as never, eoMcp: { serverPath: "/tmp/eoServer.mjs", enableCommentTool: true } }),
    limits: { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 10 },
    agentWriteBridge: writes.agentWriteBridge,
  });
  writes.serve(supervisor);
  return supervisor;
}

beforeEach(async () => {
  writes = await startTestWriteBridge();
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "Needs a decision", stepId: "todo" });
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
});

afterEach(async () => {
  handle.close();
  await writes.close();
});

describe("an agent escalating over MCP", () => {
  it("ends the run awaiting_input, posts the comment and opens a human mention", async () => {
    const codex = stubCodexEmitting([
      { type: "thread.started", thread_id: "thr_1" },
      { comment: { body: "@user should this return 429 or 503?", mentions: ["user"], blocking: true } },
      { type: "item.completed", item: { id: "i2", type: "agent_message", text: "waiting" } },
    ]);

    const supervisor = supervisorOver(codex);

    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("awaiting_input"); // ARCHITECTURE.md, "Escalation ends the run": escalation ends the run
    expect(run?.threadId).toBe("thr_1"); // persisted, so the reply can resume it

    const posted = handle.db.select().from(comments).all();
    expect(posted[0]?.body).toContain("429 or 503");
    expect(posted[0]?.authorId).toBe(implementer.id); // attributed to the agent, not the engine
    expect(posted[0]?.kind).toBe("escalation");

    const mentions = handle.db.select().from(commentMentions).all();
    expect(mentions[0]?.targetType).toBe("human");
    expect(needsAttention(handle.db, item.id)).toBe(true); // the `!` marker, derived
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo"); // escalating is not progress
  });

  it("a non-blocking comment posts and the run carries on to its result", async () => {
    const codex = stubCodexEmitting([
      { type: "thread.started", thread_id: "thr_2" },
      { comment: { body: "fyi, taking the token-bucket approach", blocking: false } },
      { type: "item.completed", item: { id: "i2", type: "agent_message", text: '{"branch":"eo/EO-1","summary":"done","handoff":"Token-bucket approach; nothing surprising."}' } },
    ]);

    const supervisor = supervisorOver(codex);

    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("succeeded"); // the pipeline didn't stall
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
    expect(handle.db.select().from(comments).all()[0]?.body).toContain("token-bucket");
  });

  it("an unknown mention is refused back to the agent rather than silently dropped", async () => {
    const codex = stubCodexEmitting([
      { type: "thread.started", thread_id: "thr_3" },
      { comment: { body: "over to you", mentions: ["nobody-by-that-name"], blocking: true } },
    ]);

    const supervisor = supervisorOver(codex);

    await supervisor.runOnce();

    // A-03's guard, reached through MCP: nothing posted, and the agent
    // told so in the tool's own answer — on both of its parts, since a
    // Claude agent reads only the structured one — rather than told the
    // mention landed (EO-543).
    expect(handle.db.select().from(comments).all().filter((comment) => comment.authorType === "agent")).toHaveLength(0);
    const [answer] = codex.answers as { isError?: boolean; content: { text: string }[]; structuredContent: { text: string } }[];
    expect(answer?.isError).toBe(true);
    expect(answer?.content[0]?.text).toContain("nobody-by-that-name");
    expect(answer?.structuredContent.text).toContain("nobody-by-that-name");
    // And the run is not parked on a question nobody was asked.
    expect(listRunsForItem(handle.db, item.id)[0]?.status).not.toBe("awaiting_input");
  });

  it("writes nothing from what the backend reports about a call it never made through EO", async () => {
    // A call reported in the stream with an answer that claims success —
    // the shape EO once posted from — but never handed to the bridge.
    const codex = stubCodexEmitting([
      { type: "thread.started", thread_id: "thr_5" },
      {
        type: "item.completed",
        item: {
          id: "i1",
          type: "mcp_tool_call",
          server: "eo",
          tool: "comment",
          arguments: { body: "@user posted from the stream?", mentions: ["user"], blocking: true },
          result: { content: [{ type: "text", text: "Comment posted. Continue with your work." }], structured_content: null },
          status: "completed",
        },
      },
      { type: "item.completed", item: { id: "i2", type: "agent_message", text: '{"branch":"eo/EO-1","summary":"done","handoff":"Nothing surprising."}' } },
    ]);

    await supervisorOver(codex).runOnce();

    expect(handle.db.select().from(comments).all().filter((comment) => comment.authorType === "agent")).toEqual([]);
    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("succeeded"); // not parked on a mention nobody posted
    expect(listRunEvents(handle.db, run!.id).map((event) => event.type)).toEqual(expect.arrayContaining(["tool_call", "tool_result"]));
  });

  it("the mention-depth cap applies to MCP calls too, redirecting to the human", async () => {
    const reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
    for (let i = 0; i < 5; i++) {
      postComment(handle.db, {
        itemId: item.id,
        author: { type: "agent", agentId: i % 2 === 0 ? implementer.id : reviewer.id },
        body: "over to you",
        mentions: [{ type: "agent", agentId: i % 2 === 0 ? reviewer.id : implementer.id }],
        kind: "escalation",
      });
    }

    const codex = stubCodexEmitting([
      { type: "thread.started", thread_id: "thr_4" },
      { comment: { body: "@reviewer take a look", mentions: ["reviewer"], blocking: true } },
    ]);

    const supervisor = supervisorOver(codex);

    await supervisor.runOnce();

    const newest = handle.db.select().from(commentMentions).all().at(-1);
    expect(newest?.targetType).toBe("human"); // redirected, not looped agent-to-agent
    // At the local person rather than at nobody (EO-302): a redirect to
    // the human names which human, even when there is only one.
    expect(newest?.targetId).toBe(LOCAL_PERSON_ID);
  });
});
