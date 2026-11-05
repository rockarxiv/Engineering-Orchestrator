import { McpServerDraftSchema, SkillDraftSchema, type Agent, UNSCOPED_RUN } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { listAgents, saveMcpServer, saveSkill, setAgentAttachment, setMcpServerEnabled } from "../db/repos/index.js";
import { archiveMcpServer } from "../db/repos/mcpServersRepo.js";
import { agentAttachmentsHash, agentSurfaceKey, canonicalAttachments, EMPTY_ATTACHMENTS_HASH } from "./fingerprint.js";

/**
 * The fingerprint two stale things depend on (EO-106).
 *
 * The provider cache never clears and thread reuse never asked about the
 * tool surface. Both are fixed by one string, and everything below is a
 * property that string has to have for either fix to work.
 */
let handle: DbHandle;
let implementer: Agent;

beforeEach(() => {
  handle = openMigratedTestDb();
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
});

afterEach(() => {
  handle.close();
});

function server(overrides: Record<string, unknown> & { name: string }) {
  const saved = saveMcpServer(handle.db, McpServerDraftSchema.parse({ transport: "stdio", command: "gh-mcp", ...overrides }));
  if (!saved.ok) throw new Error(saved.problems.join("\n"));
  return saved.server;
}

function skill(overrides: Record<string, unknown> & { name: string }) {
  const saved = saveSkill(handle.db, SkillDraftSchema.parse({ description: "A house playbook.", body: "Read the diff.", ...overrides }));
  if (!saved.ok) throw new Error(saved.problems.join("\n"));
  return saved.skill;
}

const attach = (kind: "mcpServer" | "skill", id: string, attached = true) =>
  setAgentAttachment(handle.db, { agentId: implementer.id, kind, id, attached });

describe("agentAttachmentsHash", () => {
  it("is the empty-surface hash for an agent with nothing attached", () => {
    expect(agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN)).toBe(EMPTY_ATTACHMENTS_HASH);
  });

  it("moves when something is attached, and moves back when it is detached", () => {
    const github = server({ name: "github" });

    attach("mcpServer", github.id);
    const withServer = agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN);
    expect(withServer).not.toBe(EMPTY_ATTACHMENTS_HASH);

    attach("mcpServer", github.id, false);
    expect(agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN)).toBe(EMPTY_ATTACHMENTS_HASH);
  });

  /**
   * The whole reason this is a fingerprint of content and not of ids.
   *
   * A renamed command changes what the agent can reach while every id
   * stays exactly where it was. A hash over ids would report that
   * nothing had happened, and the provider built for the old command
   * would answer every dispatch until the app restarted.
   */
  it("moves when an attached server's command changes, though no id did", () => {
    const github = server({ name: "github" });
    attach("mcpServer", github.id);
    const before = agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN);

    const edited = saveMcpServer(handle.db, McpServerDraftSchema.parse({ id: github.id, name: "github", transport: "stdio", command: "gh-mcp-v2" }));
    expect(edited.ok).toBe(true);

    expect(agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN)).not.toBe(before);
  });

  it("moves when an attached skill's body changes", () => {
    const playbook = skill({ name: "House style" });
    attach("skill", playbook.id);
    const before = agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN);

    const edited = saveSkill(handle.db, SkillDraftSchema.parse({ id: playbook.id, name: "House style", description: "A house playbook.", body: "Read the diff twice." }));
    expect(edited.ok).toBe(true);

    expect(agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN)).not.toBe(before);
  });

  it("moves when an attached server is disabled or archived", () => {
    // Both flags decide whether the entry is delivered, and delivery is
    // EO-107's and EO-108's call — so a change of mind there must not
    // need a change here to take effect.
    const github = server({ name: "github" });
    attach("mcpServer", github.id);
    const attached = agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN);

    setMcpServerEnabled(handle.db, github.id, false);
    const disabled = agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN);
    expect(disabled).not.toBe(attached);

    archiveMcpServer(handle.db, github.id);
    expect(agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN)).not.toBe(disabled);
  });

  it("does not move when a save rewrites a row byte for byte", () => {
    // `updatedAt` moves on every save. If it were in the fingerprint, a
    // save that changed nothing would discard a warm provider and cost an
    // in-flight item its thread, for nothing.
    const github = server({ name: "github" });
    attach("mcpServer", github.id);
    const before = agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN);

    saveMcpServer(handle.db, McpServerDraftSchema.parse({ id: github.id, name: "github", transport: "stdio", command: "gh-mcp" }), Date.now() + 60_000);

    expect(agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN)).toBe(before);
  });

  it("does not move when the same set is attached in another order", () => {
    const github = server({ name: "github" });
    const jira = server({ name: "jira", command: "jira-mcp" });
    const reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;

    attach("mcpServer", github.id);
    attach("mcpServer", jira.id);
    setAgentAttachment(handle.db, { agentId: reviewer.id, kind: "mcpServer", id: jira.id, attached: true });
    setAgentAttachment(handle.db, { agentId: reviewer.id, kind: "mcpServer", id: github.id, attached: true });

    expect(agentAttachmentsHash(handle.db, reviewer.id, UNSCOPED_RUN)).toBe(agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN));
  });
});

describe("canonicalAttachments", () => {
  /**
   * A digest that is wrong is indistinguishable from one that is right,
   * so the one assertion worth making is which fields reached it.
   *
   * Named fields rather than a snapshot: a snapshot would go green on
   * being updated, which is the opposite of what this is for.
   */
  it("carries the content that decides the tool surface, and no timestamps", () => {
    const github = server({ name: "github", envNames: ["GITHUB_TOKEN"] });
    const playbook = skill({ name: "House style", body: "Read the diff." });
    attach("mcpServer", github.id);
    attach("skill", playbook.id);

    const canonical = canonicalAttachments({
      servers: [],
      skills: [],
    });
    expect(canonical).toBe(JSON.stringify({ servers: [], skills: [] }));

    const parsed = JSON.parse(
      canonicalAttachments({
        servers: [github],
        skills: [playbook],
      }),
    ) as { servers: Record<string, unknown>[]; skills: Record<string, unknown>[] };

    expect(parsed.servers[0]).toEqual({
      name: "github",
      transport: "stdio",
      command: "gh-mcp",
      args: [],
      headers: [],
      url: null,
      envNames: ["GITHUB_TOKEN"],
      enabled: true,
      archived: false,
    });
    expect(parsed.skills[0]).toEqual({
      slug: "house-style",
      name: "House style",
      description: "A house playbook.",
      body: "Read the diff.",
      files: [],
      disableModelInvocation: false,
      enabled: true,
      archived: false,
    });
    // The identity of the row is deliberately absent, along with both
    // timestamps: this describes what an agent is given, not which rows
    // it was given from, and `createdAt`/`updatedAt` move without the
    // surface moving.
    expect(canonicalAttachments({ servers: [github], skills: [playbook] })).not.toContain(github.id);
    expect(canonicalAttachments({ servers: [github], skills: [playbook] })).not.toContain(String(github.updatedAt));
  });
});

/**
 * The hash thread reuse compares is one run's, not the agent's (EO-470).
 *
 * Taken over the skills that run is actually given, so two runs of the
 * same agent that receive different scoped skill sets record different
 * hashes — and a thread born under one is never resumed under the other.
 */
describe("agentAttachmentsHash, per run scope (EO-470)", () => {
  const onP = { projectId: "project-p", workspaceId: "workspace-w" };
  const onQ = { projectId: "project-q", workspaceId: "workspace-v" };

  it("differs between two runs of one agent that receive different scoped skills", () => {
    attach("skill", skill({ name: "House style" }).id);
    attach("skill", skill({ name: "E2E for P", scope: { kind: "project", projectId: "project-p" } }).id);

    expect(agentAttachmentsHash(handle.db, implementer.id, onP)).not.toBe(agentAttachmentsHash(handle.db, implementer.id, onQ));
  });

  it("does not move for a run when a skill scoped somewhere else is attached", () => {
    attach("skill", skill({ name: "House style" }).id);
    attach("skill", skill({ name: "E2E for P", scope: { kind: "project", projectId: "project-p" } }).id);
    const onPByProject = agentAttachmentsHash(handle.db, implementer.id, onP);

    // A workspace skill in W reaches a run in W on any project; and a
    // project skill elsewhere does not change what a run on P is given.
    attach("skill", skill({ name: "Elsewhere", scope: { kind: "project", projectId: "project-q" } }).id);
    expect(agentAttachmentsHash(handle.db, implementer.id, onP)).toBe(onPByProject);
  });

  it("hashes a run given only global skills exactly as it did before scopes existed", () => {
    const global = skill({ name: "House style" });
    attach("skill", global.id);
    const before = agentAttachmentsHash(handle.db, implementer.id, onQ);

    attach("skill", skill({ name: "E2E for P", scope: { kind: "project", projectId: "project-p" } }).id);
    attach("skill", skill({ name: "Build in W", scope: { kind: "workspace", workspaceId: "workspace-w" } }).id);

    expect(agentAttachmentsHash(handle.db, implementer.id, onQ)).toBe(before);
    expect(canonicalAttachments({ servers: [], skills: [global] })).not.toContain("scope");
  });

  it("keys the provider cache on every attached skill's scope, so moving one discards a cached provider", () => {
    const e2e = skill({ name: "E2E", scope: { kind: "project", projectId: "project-p" } });
    attach("skill", e2e.id);
    const before = agentSurfaceKey(handle.db, implementer.id);

    saveSkill(handle.db, SkillDraftSchema.parse({ id: e2e.id, name: "E2E", description: "A house playbook.", body: "Read the diff.", scope: { kind: "project", projectId: "project-q" } }));

    expect(agentSurfaceKey(handle.db, implementer.id)).not.toBe(before);
  });
});
