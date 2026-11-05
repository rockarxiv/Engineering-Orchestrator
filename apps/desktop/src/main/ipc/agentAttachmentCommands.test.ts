import { McpServerDraftSchema, SkillDraftSchema, ipcContract, type Agent } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { archiveMcpServer, listAgents, saveMcpServer, saveSkill } from "../db/repos/index.js";
import { listAgentAttachmentsCommand, setAgentAttachmentCommand } from "./agentAttachmentCommands.js";

/**
 * Attaching and detaching over IPC (EO-106).
 *
 * Against the real migrations, because what this boundary is for is the
 * round trip: a tick goes in and the agent's whole set has to come back
 * out — including entries pointing at rows somebody has since archived,
 * which is the case the catalogues archive rather than delete for.
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

function skill(name: string) {
  const saved = saveSkill(handle.db, SkillDraftSchema.parse({ name, description: "A house playbook.", body: "Read the diff." }));
  if (!saved.ok) throw new Error(saved.problems.join("\n"));
  return saved.skill;
}

describe("attachment over IPC", () => {
  it("attaches a server and a skill, then detaches both", () => {
    const github = server("github");
    const playbook = skill("House style");

    const withServer = setAgentAttachmentCommand(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: true });
    expect(withServer).toEqual({ attachments: { agentId: implementer.id, mcpServerIds: [github.id], skillIds: [] }, problem: null });

    const withBoth = setAgentAttachmentCommand(handle.db, { agentId: implementer.id, kind: "skill", id: playbook.id, attached: true });
    expect(withBoth.attachments).toEqual({ agentId: implementer.id, mcpServerIds: [github.id], skillIds: [playbook.id] });

    setAgentAttachmentCommand(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: false });
    const detached = setAgentAttachmentCommand(handle.db, { agentId: implementer.id, kind: "skill", id: playbook.id, attached: false });
    expect(detached.attachments).toEqual({ agentId: implementer.id, mcpServerIds: [], skillIds: [] });
  });

  it("lists one agent's, and every agent's", () => {
    const github = server("github");
    const playbook = skill("House style");
    setAgentAttachmentCommand(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: true });
    setAgentAttachmentCommand(handle.db, { agentId: reviewer.id, kind: "skill", id: playbook.id, attached: true });

    // Asked about by name, an agent answers even when the answer is
    // nothing — which is what a checkbox screen needs to render.
    const productOwner = listAgents(handle.db).find((agent) => agent.role === "system")!;
    expect(listAgentAttachmentsCommand(handle.db, { agentId: productOwner.id }).attachments).toEqual([
      { agentId: productOwner.id, mcpServerIds: [], skillIds: [] },
    ]);

    const all = listAgentAttachmentsCommand(handle.db, {}).attachments;
    expect(all).toHaveLength(2);
    expect(all).toContainEqual({ agentId: implementer.id, mcpServerIds: [github.id], skillIds: [] });
    expect(all).toContainEqual({ agentId: reviewer.id, mcpServerIds: [], skillIds: [playbook.id] });
  });

  /**
   * The reason both catalogues archive rather than delete.
   *
   * A server somebody is done with is still what an attachment points
   * at, so archiving it leaves the tick resolvable — and leaves the
   * screen able to say "archived" rather than showing a gap.
   */
  it("keeps an attachment to an archived server listed", () => {
    const github = server("github");
    setAgentAttachmentCommand(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: true });

    expect(archiveMcpServer(handle.db, github.id)).toBe(true);

    expect(listAgentAttachmentsCommand(handle.db, { agentId: implementer.id }).attachments).toEqual([
      { agentId: implementer.id, mcpServerIds: [github.id], skillIds: [] },
    ]);
  });

  it("refuses a tick against something that is gone, in a sentence rather than a throw", () => {
    const github = server("github");

    expect(setAgentAttachmentCommand(handle.db, { agentId: "gone", kind: "mcpServer", id: github.id, attached: true })).toEqual({
      attachments: null,
      problem: "That agent no longer exists.",
    });
    expect(setAgentAttachmentCommand(handle.db, { agentId: implementer.id, kind: "skill", id: "gone", attached: true })).toEqual({
      attachments: null,
      problem: "That skill no longer exists.",
    });
  });

  it("answers in the shape the contract promises, on both channels and both outcomes", () => {
    const github = server("github");
    const attached = setAgentAttachmentCommand(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: true });
    const refused = setAgentAttachmentCommand(handle.db, { agentId: "gone", kind: "mcpServer", id: github.id, attached: true });

    expect(ipcContract["agentAttachments:set"].response.safeParse(attached).success).toBe(true);
    expect(ipcContract["agentAttachments:set"].response.safeParse(refused).success).toBe(true);
    expect(ipcContract["agentAttachments:list"].response.safeParse(listAgentAttachmentsCommand(handle.db, {})).success).toBe(true);
    expect(
      ipcContract["agentAttachments:list"].response.safeParse(listAgentAttachmentsCommand(handle.db, { agentId: implementer.id })).success,
    ).toBe(true);
  });
});
