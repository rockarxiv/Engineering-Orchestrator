import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServerDraftSchema, SkillDraftSchema, type Uuid } from "@eo/core";
import type { DbHandle } from "../client.js";
import { openMigratedTestDb } from "../testHelpers.js";
import { archiveAgent, createAgent, deleteAgent, getAgent, listAgents } from "./agentsRepo.js";
import { getAgentAttachments, setAgentAttachment } from "./agentAttachmentsRepo.js";
import { createRun, getRun } from "./runsRepo.js";
import { saveMcpServer } from "./mcpServersRepo.js";
import { saveSkill } from "./skillsRepo.js";
import { createTestItem } from "../testHelpers.js";

describe("agentsRepo", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("creates and reads back an agent as a domain type, not a raw row", () => {
    const agent = createAgent(handle.db, {
      name: "Test Agent",
      role: "tester",
      provider: "fake",
      instructions: "do the thing",
    });

    expect(agent.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(agent.model).toBeNull();
    expect(agent.config).toEqual({});
    expect(agent.enabled).toBe(true);
    expect(agent.archivedAt).toBeNull();

    expect(getAgent(handle.db, agent.id)).toEqual(agent);
  });

  it("lists agents, including the seeded defaults from the seed migration", () => {
    const seeded = listAgents(handle.db);
    // Four rows, three roles. 0062 merged the product owner and the
    // pipeline architect into `system` and retired the architect row
    // rather than deleting it — `runs.agent_id` references it — and 0063
    // archived that row. It is still listed here, still on its old role
    // and still switched off: this function answers "every row", because
    // a run and a comment still resolve their name through it.
    expect(seeded.map((agent) => agent.role).sort()).toEqual(["implementer", "pipeline_architect", "reviewer", "system"]);
    expect(seeded.filter((agent) => agent.enabled).map((agent) => agent.role).sort()).toEqual(["implementer", "reviewer", "system"]);

    createAgent(handle.db, { name: "Extra", role: "tester", provider: "fake", instructions: "x" });
    expect(listAgents(handle.db)).toHaveLength(5);
  });

  it("has exactly the three agents EO ships live on a fresh installation, with the architect archived", () => {
    // What the Agents screen shows after the migrations (EO-186). The
    // architect is reachable and is not one of the agents this
    // installation has — which was the whole bug: a row EO retired,
    // rendered as somebody's own custom agent.
    const seeded = listAgents(handle.db);

    expect(seeded.filter((agent) => agent.archivedAt === null).map((agent) => agent.name).sort()).toEqual(["Implementer", "Reviewer", "System"]);
    expect(seeded.filter((agent) => agent.archivedAt !== null).map((agent) => agent.name)).toEqual(["Architect"]);
  });

  it("archives an agent by stamping it, and keeps the row exactly where it was", () => {
    const agent = createAgent(handle.db, { name: "Tester", role: "tester", provider: "fake", instructions: "do the thing" });

    expect(archiveAgent(handle.db, agent.id, 1_700_000_000_000)).toBe(true);

    const archived = getAgent(handle.db, agent.id)!;
    expect(archived.archivedAt).toBe(1_700_000_000_000);
    // Everything else untouched, `enabled` included: archived and
    // disabled are different answers to different questions, and this
    // one must not quietly give the other.
    expect({ ...archived, archivedAt: null }).toEqual(agent);
    // Still listed: what points at a retired agent — its runs, its
    // comments — still resolves its name through this (invariant #3).
    expect(listAgents(handle.db).map((row) => row.id)).toContain(agent.id);
  });

  it("refuses to archive an id no row carries, rather than writing one", () => {
    expect(archiveAgent(handle.db, "019fb8c6-de91-7cdd-b0c6-00000000dead" as Uuid)).toBe(false);
  });
  it("deletes an agent that has run as a tombstone: name and role kept, the rest cleared, its runs untouched (EO-350)", () => {
    const agent = createAgent(handle.db, { name: "Doomed", role: "tester", provider: "fake", model: "m", instructions: "do it", config: { effort: "high" } });
    const item = createTestItem(handle.db, { type: "story", title: "Once", stepId: "todo" });
    const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement", status: "succeeded" });
    const server = saveMcpServer(handle.db, McpServerDraftSchema.parse({ transport: "stdio", command: "gh-mcp", name: "github" }));
    const skill = saveSkill(handle.db, SkillDraftSchema.parse({ name: "house", description: "A house playbook.", body: "Read the diff." }));
    if (!server.ok || !skill.ok) throw new Error("fixture refused");
    setAgentAttachment(handle.db, { agentId: agent.id, kind: "mcpServer", id: server.server.id, attached: true });
    setAgentAttachment(handle.db, { agentId: agent.id, kind: "skill", id: skill.skill.id, attached: true });

    // No foreign-key error: the row `runs.agent_id` points at is kept.
    expect(deleteAgent(handle.db, agent.id, 42)).toBe(true);

    expect(getAgent(handle.db, agent.id)).toMatchObject({
      name: "Doomed",
      role: "tester",
      provider: "",
      model: null,
      instructions: "",
      promptHash: null,
      config: {},
      enabled: false,
      archivedAt: 42,
      deletedAt: 42,
    });
    expect(getAgentAttachments(handle.db, agent.id)).toMatchObject({ mcpServerIds: [], skillIds: [] });
    expect(getRun(handle.db, run.id)?.agentId).toBe(agent.id);
    expect(deleteAgent(handle.db, "019fb8c6-de91-7cdd-b0c6-00000000dead" as Uuid)).toBe(false);
  });
});
