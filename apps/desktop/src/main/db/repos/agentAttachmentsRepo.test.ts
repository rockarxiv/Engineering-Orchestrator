import { McpServerDraftSchema, SkillDraftSchema, type Agent } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../client.js";
import { openMigratedTestDb } from "../testHelpers.js";
import { listAgents } from "./agentsRepo.js";
import { archiveMcpServer, saveMcpServer } from "./mcpServersRepo.js";
import { archiveSkill, saveSkill } from "./skillsRepo.js";
import {
  getAgentAttachments,
  listAgentAttachments,
  replaceReplicaAttachments,
  resolveAgentAttachments,
  setAgentAttachment,
} from "./agentAttachmentsRepo.js";

/**
 * The join between the two catalogues and `agents` (EO-106).
 *
 * Against the real migrations in an in-memory database, so a column this
 * repository writes and a column the migration creates cannot drift
 * apart without a test noticing.
 */
let handle: DbHandle;
let implementer: Agent;
let reviewer: Agent;

beforeEach(() => {
  handle = openMigratedTestDb();
  const agents = listAgents(handle.db);
  implementer = agents.find((agent) => agent.role === "implementer")!;
  reviewer = agents.find((agent) => agent.role === "reviewer")!;
});

afterEach(() => {
  handle.close();
});

function server(name: string, command = "gh-mcp") {
  const saved = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name, transport: "stdio", command }));
  if (!saved.ok) throw new Error(saved.problems.join("\n"));
  return saved.server;
}

function skill(name: string, body = "Read the whole diff.") {
  const saved = saveSkill(handle.db, SkillDraftSchema.parse({ name, description: "A house playbook.", body }));
  if (!saved.ok) throw new Error(saved.problems.join("\n"));
  return saved.skill;
}

describe("setAgentAttachment", () => {
  it("attaches a server and a skill, and reads both back", () => {
    const github = server("github");
    const playbook = skill("House style");

    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: true });
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "skill", id: playbook.id, attached: true });

    expect(getAgentAttachments(handle.db, implementer.id)).toEqual({
      agentId: implementer.id,
      mcpServerIds: [github.id],
      skillIds: [playbook.id],
    });
  });

  it("detaches without touching the catalogue entry", () => {
    const github = server("github");
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: true });

    const result = setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: false });

    expect(result).toEqual({ ok: true, attachments: { agentId: implementer.id, mcpServerIds: [], skillIds: [] } });
    // Detaching is not deleting: the server is still in the catalogue for
    // somebody else to be given.
    expect(resolveAgentAttachments(handle.db, reviewer.id).servers).toEqual([]);
    expect(setAgentAttachment(handle.db, { agentId: reviewer.id, kind: "mcpServer", id: github.id, attached: true }).ok).toBe(true);
  });

  it("is idempotent in both directions", () => {
    const github = server("github");

    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: true });
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: true });
    expect(getAgentAttachments(handle.db, implementer.id).mcpServerIds).toEqual([github.id]);

    // And detaching something that was never attached is not an error
    // either — a screen should not have to know what it last saw to send
    // the right verb.
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "skill", id: skill("House style").id, attached: false });
    expect(getAgentAttachments(handle.db, implementer.id).skillIds).toEqual([]);
  });

  it("keeps one agent's attachments out of another's", () => {
    const github = server("github");
    const jira = server("jira", "jira-mcp");

    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: true });
    setAgentAttachment(handle.db, { agentId: reviewer.id, kind: "mcpServer", id: jira.id, attached: true });

    expect(getAgentAttachments(handle.db, implementer.id).mcpServerIds).toEqual([github.id]);
    expect(getAgentAttachments(handle.db, reviewer.id).mcpServerIds).toEqual([jira.id]);
  });

  it("refuses a tick against an agent that is gone, in a sentence", () => {
    const github = server("github");

    const result = setAgentAttachment(handle.db, { agentId: "not-an-agent", kind: "mcpServer", id: github.id, attached: true });

    expect(result).toEqual({ ok: false, problem: "That agent no longer exists." });
  });

  it("refuses a tick against a catalogue entry that is gone, in a sentence", () => {
    // A row filed against an id nothing carries is a row nothing would
    // ever read and nothing would clean up. Both kinds say which.
    expect(setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: "nope", attached: true })).toEqual({
      ok: false,
      problem: "That MCP server no longer exists.",
    });
    expect(setAgentAttachment(handle.db, { agentId: implementer.id, kind: "skill", id: "nope", attached: true })).toEqual({
      ok: false,
      problem: "That skill no longer exists.",
    });
  });

  it("lets a detach of something that is gone through, since there is nothing left to point at", () => {
    // Only an *attach* needs the entry to exist. Refusing a detach would
    // leave a row nobody could remove.
    const result = setAgentAttachment(handle.db, { agentId: implementer.id, kind: "skill", id: "nope", attached: false });

    expect(result.ok).toBe(true);
  });
});

describe("listAgentAttachments", () => {
  it("answers for every agent that has something, and leaves out the ones that have nothing", () => {
    const github = server("github");
    const playbook = skill("House style");
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: true });
    setAgentAttachment(handle.db, { agentId: reviewer.id, kind: "skill", id: playbook.id, attached: true });

    const all = listAgentAttachments(handle.db);

    expect(all).toContainEqual({ agentId: implementer.id, mcpServerIds: [github.id], skillIds: [] });
    expect(all).toContainEqual({ agentId: reviewer.id, mcpServerIds: [], skillIds: [playbook.id] });
    expect(all).toHaveLength(2);
  });
});

describe("resolveAgentAttachments", () => {
  it("resolves an attachment to the row it points at", () => {
    const github = server("github");
    const playbook = skill("House style");
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: true });
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "skill", id: playbook.id, attached: true });

    const resolved = resolveAgentAttachments(handle.db, implementer.id);

    expect(resolved.servers).toEqual([github]);
    expect(resolved.skills).toEqual([playbook]);
  });

  /**
   * The reason both catalogues archive rather than delete.
   *
   * An agent that was given a server keeps pointing at something a
   * person can read. The alternative is an id that resolves to nothing,
   * and a screen with a gap in it where a row used to be.
   */
  it("still resolves a server and a skill that have been archived", () => {
    const github = server("github");
    const playbook = skill("House style");
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: true });
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "skill", id: playbook.id, attached: true });

    archiveMcpServer(handle.db, github.id);
    archiveSkill(handle.db, playbook.id);

    const resolved = resolveAgentAttachments(handle.db, implementer.id);

    expect(resolved.servers.map((entry) => entry.id)).toEqual([github.id]);
    expect(resolved.servers[0]?.archivedAt).toEqual(expect.any(Number));
    expect(resolved.skills.map((entry) => entry.id)).toEqual([playbook.id]);
    expect(resolved.skills[0]?.archivedAt).toEqual(expect.any(Number));
    // And the attachment itself is untouched — archiving is not
    // detaching, so bringing the server back needs no second act.
    expect(getAgentAttachments(handle.db, implementer.id).mcpServerIds).toEqual([github.id]);
  });
});

/**
 * The tool surface an organisation published for one agent (EO-329,
 * the original design).
 *
 * "A published agent carries role, prompt and tool surface", and the
 * surface is these rows — so a publication *replaces* them. A surface
 * that was the union of what the organisation gave and what this
 * machine had attached earlier would be a surface nobody decided, and
 * one an agent could have widened for itself before the section was
 * locked (invariant 11).
 */
describe("replaceReplicaAttachments", () => {
  it("replaces what an agent has rather than adding to it", () => {
    const github = server("github");
    const slack = server("slack", "slack-mcp");
    const playbook = skill("House style");
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: true });

    replaceReplicaAttachments(handle.db, implementer.id, [slack.id], [playbook.id]);

    expect(getAgentAttachments(handle.db, implementer.id)).toEqual({
      agentId: implementer.id,
      mcpServerIds: [slack.id],
      skillIds: [playbook.id],
    });
  });

  it("skips what this replica has not been sent yet rather than refusing the whole surface", () => {
    const github = server("github");

    // The catalogue arrives in the same document a line above the
    // agents (`configuration.ts`), but a row this machine does not hold
    // is a foreign key SQLite would refuse — and half a surface is
    // better than a publication that throws.
    replaceReplicaAttachments(handle.db, reviewer.id, [github.id, "019fb8c6-0000-7000-8000-00000000eeee"], ["019fb8c6-0000-7000-8000-00000000ffff"]);

    expect(getAgentAttachments(handle.db, reviewer.id)).toEqual({ agentId: reviewer.id, mcpServerIds: [github.id], skillIds: [] });
  });
});
