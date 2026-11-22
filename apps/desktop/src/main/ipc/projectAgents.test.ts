import { McpServerDraftSchema, SkillDraftSchema, stepAgentKind, type Agent, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { archiveAgent, copyPipeline, createProject, getAgent, listAgents, listPipelines, listPipelineSteps, listStepsForPipeline, updateAgent } from "../db/repos/index.js";
import { getAgentAttachments, setAgentAttachment } from "../db/repos/agentAttachmentsRepo.js";
import { saveMcpServer } from "../db/repos/mcpServersRepo.js";
import { saveSkill } from "../db/repos/skillsRepo.js";
import { giveSeededDelivery, openMigratedTestDb } from "../db/testHelpers.js";
import { writePolicy } from "../policy/policy.js";
import { NO_POLICY } from "@eo/core";
import { customiseAgent, listAgentDetails, projectStaffing, saveAgent } from "./configCommands.js";
import { listPipelineStepViews } from "./domainQueries.js";
import { pipelines } from "../db/schema.js";
import { markReplica } from "../db/recordRole.js";
import { publishSection } from "../db/repos/publishedSectionsRepo.js";
import { markDiverged } from "../db/repos/divergenceRepo.js";
import { listPipelinesUpdatedSince } from "../db/repos/projectMoveRepo.js";
import { sectionLockFor } from "../managed/locks.js";

/**
 * A project's own agents, from the two commands the Agents screen and a
 * project's settings stand on (EO-475): `agents:customise`, which copies
 * a global agent for one project, and `projects:staffing`, which says who
 * runs each of that project's agent steps.
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

describe("customising changes what the project's own steps name", () => {
  it("points the project's steps that named the original at the copy, in the copy's transaction, and says which (EO-876)", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    giveSeededDelivery(handle.db, project.id);
    const other = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    copyPipeline(handle.db, "default", other.id);
    const named = (projectId: Uuid | null) =>
      listPipelines(handle.db, projectId ?? undefined)
        .filter((pipeline) => pipeline.projectId === projectId)
        .flatMap((pipeline) => listStepsForPipeline(handle.db, pipeline.id))
        .filter((step) => step.type === "agent")
        .map((step) => [step.id, step.agentId] as const);
    const before = { ours: named(project.id), theirs: named(other.id), global: named(null) };
    const implementing = before.ours.filter(([, agentId]) => agentId === implementer.id).map(([stepId]) => stepId);
    expect(implementing.length).toBeGreaterThan(0);

    const result = customiseAgent(handle.db, { agentId: implementer.id, projectId: project.id });

    const copy = result.agent!;
    // Said by step, so the screen can say which steps it changed.
    expect(result.changedSteps.map((step) => step.stepId).sort()).toEqual([...implementing].sort());
    const ours = new Set(listPipelines(handle.db, project.id).filter((pipeline) => pipeline.projectId === project.id).map((pipeline) => pipeline.id as string));
    expect(result.changedSteps.every((step) => ours.has(step.pipelineId))).toBe(true);
    // The project's steps that named the original name the copy; the
    // project's other steps, and every other project's and the global
    // pipeline's, are untouched.
    expect(named(project.id)).toEqual(before.ours.map(([stepId, agentId]) => [stepId, implementing.includes(stepId) ? copy.id : agentId]));
    expect(named(other.id)).toEqual(before.theirs);
    expect(named(null)).toEqual(before.global);
    // The copy now says it is named by them, and the original that it no longer is there.
    expect(copy.steps.map((step) => step.stepId).sort()).toEqual([...implementing].sort());
    expect(listAgentDetails(handle.db).agents.find((agent) => agent.id === implementer.id)!.steps.some((step) => implementing.includes(step.stepId))).toBe(false);
    // What runs there is the copy: its kind is the original's, so the steps' actions still hold.
    expect(getAgent(handle.db, copy.id as Uuid)!.role).toBe(implementer.role);
  });

  it("changes no step when the copy is refused", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    giveSeededDelivery(handle.db, project.id);
    updateAgent(handle.db, implementer.id, { provider: "codex" });
    writePolicy(handle.db, { ...NO_POLICY, allowedBackends: ["claude"] });
    const before = listPipelineSteps(handle.db).map((step) => [step.id, step.agentId]);

    const answer = customiseAgent(handle.db, { agentId: implementer.id, projectId: project.id });

    expect(answer.saved).toBe(false);
    expect(answer.changedSteps).toEqual([]);
    expect(listPipelineSteps(handle.db).map((step) => [step.id, step.agentId])).toEqual(before);
  });
});

describe("customising where the organisation manages pipelines (EO-876)", () => {
  let stopBeingAReplica: (() => void) | null = null;
  afterEach(() => {
    stopBeingAReplica?.();
    stopBeingAReplica = null;
  });

  it("refuses, writing nothing, where pipelines are published and agents are not, since the copy would rewrite a managed step", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    giveSeededDelivery(handle.db, project.id);
    stopBeingAReplica = markReplica(handle.db, () => true);
    publishSection(handle.db, { section: "pipelines", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });
    // The channel itself is the agents section's, which is not published.
    expect(sectionLockFor(handle.db, "agents:customise", { agentId: implementer.id, projectId: project.id })).toBeNull();
    const agents = listAgents(handle.db).length;
    const before = listPipelineSteps(handle.db).map((step) => [step.id, step.agentId]);

    const answer = customiseAgent(handle.db, { agentId: implementer.id, projectId: project.id });

    expect(answer).toMatchObject({ saved: false, agent: null, changedSteps: [], locked: { locked: true, section: "pipelines", publishedBy: "Dana" } });
    expect(answer.problem).toContain("The pipelines section is managed by your organisation. Dana published it.");
    expect(answer.problem).toContain("nothing was copied");
    expect(listAgents(handle.db)).toHaveLength(agents);
    expect(listPipelineSteps(handle.db).map((step) => [step.id, step.agentId])).toEqual(before);
  });

  it("copies and re-points a pipeline this machine diverged, which `pipeline:save` may edit too", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    giveSeededDelivery(handle.db, project.id);
    stopBeingAReplica = markReplica(handle.db, () => true);
    publishSection(handle.db, { section: "pipelines", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });
    markDiverged(handle.db, "default", null, Date.now());

    const answer = customiseAgent(handle.db, { agentId: implementer.id, projectId: project.id });

    expect(answer.saved).toBe(true);
    expect(answer.locked).toBeNull();
    expect(answer.changedSteps.length).toBeGreaterThan(0);
  });

  it("copies where no step of the project names the original, since no managed step is rewritten", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    stopBeingAReplica = markReplica(handle.db, () => true);
    publishSection(handle.db, { section: "pipelines", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });

    const answer = customiseAgent(handle.db, { agentId: implementer.id, projectId: project.id });

    expect(answer).toMatchObject({ saved: true, changedSteps: [], locked: null });
  });
});

describe("customising pages the re-pointed steps to replicas (EO-876)", () => {
  it("moves each changed pipeline's updated_at, so a replica that already read it reads its steps again", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    giveSeededDelivery(handle.db, project.id);
    // A replica that has read every pipeline up to here.
    handle.db.update(pipelines).set({ updatedAt: 1_000 }).run();
    const cursor = { ts: 1_000, id: "\uffff" };
    expect(listPipelinesUpdatedSince(handle.db, cursor, 100, project.id)).toEqual([]);

    const answer = customiseAgent(handle.db, { agentId: implementer.id, projectId: project.id });

    const changed = new Set(answer.changedSteps.map((step) => step.pipelineId));
    expect(changed.size).toBeGreaterThan(0);
    const paged = listPipelinesUpdatedSince(handle.db, cursor, 100, project.id);
    expect(new Set(paged.map((pipeline) => pipeline.id as string))).toEqual(changed);
    for (const pipeline of paged) {
      for (const step of answer.changedSteps.filter((each) => each.pipelineId === pipeline.id)) {
        expect(pipeline.steps.find((each) => each.id === step.stepId)?.agentId).toBe(answer.agent!.id);
      }
    }
  });
});

describe("who runs a project's steps", () => {
  it("lists each agent step of the project's pipelines with the agent the step names (EO-876)", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    giveSeededDelivery(handle.db, project.id);
    const agents = listAgents(handle.db);
    const expected = listPipelines(handle.db, project.id).flatMap((pipeline) =>
      listStepsForPipeline(handle.db, pipeline.id)
        .filter((step) => step.type === "agent")
        .map((step) => ({ stepId: step.id, agentId: step.agentId, kind: stepAgentKind(agents, step) })),
    );

    const { steps } = projectStaffing(handle.db, { projectId: project.id });

    expect(steps.map((step) => ({ stepId: step.stepId, agentId: step.agent?.id ?? null, kind: step.agent?.role ?? null }))).toEqual(expected);
    const implementing = steps.find((step) => step.agent?.id === implementer.id)!;
    expect(implementing.agent).toEqual({ id: implementer.id, name: implementer.name, role: "implementer", provider: implementer.provider, model: implementer.model, projectId: null });
    expect(implementing.problem).toBeNull();
  });

  it("reads the step, not a staffing rule: a project's own agent of the kind does not change the answer until a step names it", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    giveSeededDelivery(handle.db, project.id);
    // A project's own Implementer that no step names: a staffing rule would prefer it.
    saveAgent(handle.db, { name: "Our implementer", role: "implementer", provider: "fake", model: null, instructions: "Ours.", enabled: true, projectId: project.id });

    const { steps } = projectStaffing(handle.db, { projectId: project.id });

    expect(steps.some((step) => step.agent?.id === implementer.id)).toBe(true);
    expect(steps.some((step) => step.agent?.name === "Our implementer")).toBe(false);
  });

  it("says in words when the step's agent cannot run, rather than naming another of its kind", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    giveSeededDelivery(handle.db, project.id);
    updateAgent(handle.db, implementer.id, { enabled: false });

    const implementing = projectStaffing(handle.db, { projectId: project.id }).steps.filter((step) => step.agent?.role === "implementer");

    expect(implementing.length).toBeGreaterThan(0);
    for (const step of implementing) {
      expect(step.agent?.id).toBe(implementer.id);
      expect(step.problem).toBe(`${implementer.name} is disabled, so nothing runs here until it is enabled or the step names another agent.`);
    }
  });

  it("says so where the step's global agent was moved to another project after the step named it, as dispatch refuses it (EO-876)", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    giveSeededDelivery(handle.db, project.id);
    const other = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    // Moved through `agents:save`, the way the Agents screen moves it.
    const moved = saveAgent(handle.db, { id: implementer.id, name: implementer.name, role: implementer.role, provider: implementer.provider, model: implementer.model, instructions: implementer.instructions, enabled: true, projectId: other.id });
    expect(moved.saved).toBe(true);
    const sentence = `${implementer.name} works for another project, so nothing runs here until the step names another agent.`;

    // Project settings.
    const implementing = projectStaffing(handle.db, { projectId: project.id }).steps.filter((step) => step.agent?.id === implementer.id);
    expect(implementing.length).toBeGreaterThan(0);
    for (const step of implementing) expect(step.problem).toBe(sentence);
    // The Graph view, the board's column head and `pipeline_get` all read `pipelineSteps:list`.
    for (const pipelineId of new Set(implementing.map((step) => step.pipelineId))) {
      const graph = listPipelineStepViews(handle.db, { pipelineId });
      expect(graph.pipelineProjectId).toBe(project.id);
      for (const step of implementing.filter((each) => each.pipelineId === pipelineId)) expect(graph.stepAgents?.[step.stepId]?.problem).toBe(sentence);
    }
  });
});
