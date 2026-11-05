import { McpServerDraftSchema, SkillDraftSchema, type Agent, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { archiveAgent, createProject, getAgent, listAgents, listPipelineSteps, updateAgent } from "../db/repos/index.js";
import { getAgentAttachments, setAgentAttachment } from "../db/repos/agentAttachmentsRepo.js";
import { saveMcpServer } from "../db/repos/mcpServersRepo.js";
import { saveSkill } from "../db/repos/skillsRepo.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { writePolicy } from "../policy/policy.js";
import { NO_POLICY } from "@eo/core";
import { customiseAgent, projectStaffing, saveAgent } from "./configCommands.js";

/**
 * A project's own agents, from the two commands the Agents screen and a
 * project's settings stand on (EO-475): `agents:customise`, which copies
 * a global agent for one project, and `projects:staffing`, which says who
 * that project's work goes to, role by role.
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

function server(name: string) {
  const saved = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name, transport: "stdio", command: "gh-mcp" }));
  if (!saved.ok) throw new Error(saved.problems.join("\n"));
  return saved.server;
}

function skill(name: string) {
  const saved = saveSkill(handle.db, SkillDraftSchema.parse({ name, description: "A house playbook.", body: "Be brief." }));
  if (!saved.ok) throw new Error(saved.problems.join("\n"));
  return saved.skill;
}

describe("customising a global agent for a project", () => {
  it("copies role, backend, model, effort, instructions and attachments onto a project's own agent", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    updateAgent(handle.db, implementer.id, { provider: "claude", model: "claude-opus-5", instructions: "Our own words.", config: { effort: "high" } });
    const github = server("github");
    const playbook = skill("House style");
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: true });
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "skill", id: playbook.id, attached: true });

    const result = customiseAgent(handle.db, { agentId: implementer.id, projectId: project.id });

    expect(result.saved).toBe(true);
    const copy = getAgent(handle.db, result.agent!.id as Uuid)!;
    expect(copy.id).not.toBe(implementer.id);
    expect(copy).toMatchObject({
      name: `${implementer.name} (Support)`,
      role: "implementer",
      provider: "claude",
      model: "claude-opus-5",
      instructions: "Our own words.",
      config: { effort: "high" },
      enabled: true,
      projectId: project.id,
    });
    expect(getAgentAttachments(handle.db, copy.id)).toEqual({ agentId: copy.id, mcpServerIds: [github.id], skillIds: [playbook.id] });
  });

  it("leaves the original alone when the copy is edited", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const playbook = skill("House style");
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "skill", id: playbook.id, attached: true });
    const before = { agent: getAgent(handle.db, implementer.id), attachments: getAgentAttachments(handle.db, implementer.id) };
    const copy = customiseAgent(handle.db, { agentId: implementer.id, projectId: project.id }).agent!;

    saveAgent(handle.db, { id: copy.id, name: copy.name, role: copy.role, provider: copy.provider, model: "other", instructions: "Changed.", enabled: true, config: { effort: "low" } });
    setAgentAttachment(handle.db, { agentId: copy.id, kind: "skill", id: playbook.id, attached: false });

    expect({ agent: getAgent(handle.db, implementer.id), attachments: getAgentAttachments(handle.db, implementer.id) }).toEqual(before);
    expect(getAgent(handle.db, copy.id as Uuid)).toMatchObject({ instructions: "Changed.", model: "other", projectId: project.id });
  });

  it("refuses the system agent, a project's own agent, an archived one and a project that does not exist, writing nothing", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const system = listAgents(handle.db).find((agent) => agent.role === "system")!;
    const reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
    const own = customiseAgent(handle.db, { agentId: implementer.id, projectId: project.id }).agent!;
    archiveAgent(handle.db, reviewer.id);
    const before = listAgents(handle.db);

    const answers = {
      system: customiseAgent(handle.db, { agentId: system.id, projectId: project.id }),
      own: customiseAgent(handle.db, { agentId: own.id, projectId: project.id }),
      archived: customiseAgent(handle.db, { agentId: reviewer.id, projectId: project.id }),
      nowhere: customiseAgent(handle.db, { agentId: implementer.id, projectId: "0199aa00-0000-7000-8000-00000000dead" }),
    };

    for (const answer of Object.values(answers)) {
      expect(answer.saved).toBe(false);
      expect(answer.agent).toBeNull();
    }
    expect(answers.system.problem).toContain("A system agent cannot belong to a project");
    expect(answers.own.problem).toContain("already belongs to a project");
    expect(answers.archived.problem).toContain("is archived");
    expect(answers.nowhere.problem).toContain("no project with that id");
    expect(listAgents(handle.db)).toEqual(before);
  });

  it("refuses a copy onto a backend the organisation no longer allows", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    updateAgent(handle.db, implementer.id, { provider: "codex" });
    writePolicy(handle.db, { ...NO_POLICY, allowedBackends: ["claude"] });
    const before = listAgents(handle.db).length;

    const answer = customiseAgent(handle.db, { agentId: implementer.id, projectId: project.id });

    expect(answer.saved).toBe(false);
    expect(answer.problem).not.toBeNull();
    expect(listAgents(handle.db)).toHaveLength(before);
  });
});

describe("who a project's work goes to", () => {
  const rolesOfShippedPipeline = () => [...new Set(listPipelineSteps(handle.db).filter((step) => step.type === "agent" && step.ownerRole !== null).map((step) => step.ownerRole!))];

  it("names the global agents in every role the project's pipelines use while the project has none of its own", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });

    const { roles } = projectStaffing(handle.db, { projectId: project.id });

    expect(roles.map((entry) => entry.role)).toEqual(rolesOfShippedPipeline());
    const implementing = roles.find((entry) => entry.role === "implementer")!;
    expect(implementing).toEqual({ role: "implementer", from: "global", agents: [{ id: implementer.id, name: implementer.name }] });
  });

  it("names the project's own agent once it has one, and only for that project", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const other = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    const own = customiseAgent(handle.db, { agentId: implementer.id, projectId: project.id }).agent!;

    const ours = projectStaffing(handle.db, { projectId: project.id }).roles.find((entry) => entry.role === "implementer");
    const theirs = projectStaffing(handle.db, { projectId: other.id }).roles.find((entry) => entry.role === "implementer");

    expect(ours).toEqual({ role: "implementer", from: "project", agents: [{ id: own.id, name: own.name }] });
    expect(theirs).toEqual({ role: "implementer", from: "global", agents: [{ id: implementer.id, name: implementer.name }] });
  });

  it("falls back to the global agent when the project's own is switched off, and says nobody when no agent holds the role", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const own = customiseAgent(handle.db, { agentId: implementer.id, projectId: project.id }).agent!;
    updateAgent(handle.db, own.id as Uuid, { enabled: false });

    expect(projectStaffing(handle.db, { projectId: project.id }).roles.find((entry) => entry.role === "implementer")?.from).toBe("global");

    updateAgent(handle.db, implementer.id, { enabled: false });
    expect(projectStaffing(handle.db, { projectId: project.id }).roles.find((entry) => entry.role === "implementer")).toEqual({
      role: "implementer",
      from: "nobody",
      agents: [],
    });
  });
});
