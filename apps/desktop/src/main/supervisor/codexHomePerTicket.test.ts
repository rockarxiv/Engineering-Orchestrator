import type { Agent, AgentProvider, AgentProviderStartOptions, Item, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listAgents, postComment } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { openAssist } from "../ipc/assistCommands.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { kindsPreparing } from "./testWorkspaceKinds.js";

/**
 * A locked-down Codex agent runs every turn on a ticket in a Codex home
 * for that agent and that ticket (EO-829), so the ticket has to reach
 * both places a home is made ready: the dispatch preflight (`checkAuth`)
 * and the turn (`AgentTurnOverrides.itemId`). A conversation — the
 * assistant's chat — names none, and runs in the agent's own home.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let handle: DbHandle;
let item: Item;
let systemAgent: Agent;

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
  systemAgent = listAgents(handle.db).find((agent) => agent.role === "system")!;
});

afterEach(() => {
  handle.close();
});

function recording(): { provider: AgentProvider; starts: AgentProviderStartOptions[] } {
  const fake = createFakeProvider({ steps: [{ output: "working" }], result: validImplementResult });
  const starts: AgentProviderStartOptions[] = [];
  return {
    starts,
    provider: {
      ...fake,
      start: (options) => {
        starts.push(options);
        return fake.start(options);
      },
    },
  };
}

describe("the ticket a turn works on", () => {
  it("reaches the dispatch preflight and the turn on a ticket", async () => {
    const { provider, starts } = recording();
    const checkAuth = vi.fn(async (_agent: Agent, _itemId?: string) => ({ ok: true as const }));
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS, kinds: kindsPreparing("/tmp/eo/worktrees/EO-829"), checkAuth });

    await supervisor.runOnce();
    await vi.waitFor(() => expect(starts).toHaveLength(1));

    expect(checkAuth).toHaveBeenCalledWith(expect.objectContaining({ role: "implementer" }), item.id);
    expect(starts[0]?.itemId).toBe(item.id);
  });

  it("is none on an assistant conversation, which keeps the agent's own home", async () => {
    const { provider, starts } = recording();
    const checkAuth = vi.fn(async (_agent: Agent, _itemId?: string) => ({ ok: true as const }));
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS, kinds: kindsPreparing("/tmp/eo/worktrees/EO-829"), checkAuth });
    const chat = openAssist(handle.db).conversation.id as Uuid;
    postComment(handle.db, { itemId: chat, author: { type: "human" }, body: "Hello.", mentions: [{ type: "agent", agentId: systemAgent.id }] });

    await supervisor.runOnce();
    await vi.waitFor(() => expect(starts.some((start) => start.context.includes("Hello."))).toBe(true));

    const chatCall = checkAuth.mock.calls.find(([agent]) => agent.id === systemAgent.id);
    expect(chatCall).toHaveLength(1);
    expect(starts.find((start) => start.context.includes("Hello."))).not.toHaveProperty("itemId");
  });
});
