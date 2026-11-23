import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { documentStepTeam, isExportedTeam, TeamDefinitionSchema, type ExportedTeam, type IpcChannel, type PipelineExport, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { agentOfKind, openMigratedTestDb } from "../db/testHelpers.js";
import { createAgent, getAgent, updateAgent } from "../db/repos/agentsRepo.js";
import { setAgentAttachment } from "../db/repos/agentAttachmentsRepo.js";
import { declareMcpServer, getMcpServerByName } from "../db/repos/mcpServersRepo.js";
import { createPipeline, createProject, createStep, listAgents, listStepsForPipeline, setEntryStep } from "../db/repos/index.js";
import { agentToolSurfaces, createTeam, getTeam } from "../db/repos/teamsRepo.js";
import { TOOLS, type Dispatch } from "../mcpHost/catalog.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "../ipc/registry.js";
import { exportPipeline, importPipeline, parseExport, preflightImport } from "./pipelineTransfer.js";
import type { ModuleSecretsOptions } from "./secrets.js";

/**
 * Declared teams through export and import (EO-885): a document carries
 * the team a step runs as, its agents by kind and instructions and never
 * by id, and an import binds each agent to one of the project's agents of
 * that kind with the same instructions, or creates one — and
 * `pipeline_import_check` says which, before anything is written.
 */

const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from([...text].reverse().join("")),
  decryptString: (buffer: Buffer) => [...buffer.toString()].reverse().join(""),
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/;

let handle: DbHandle;
let scratch: string;
let secrets: ModuleSecretsOptions;
let shop: Uuid;
let pipelineId: Uuid;
let reviewer: Uuid;
let checker: Uuid;

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo team transfer "));
  secrets = { directory: join(scratch, "secrets"), store };
  for (const agent of listAgents(handle.db)) updateAgent(handle.db, agent.id, { provider: "claude" });
  declareMcpServer(handle.db, { name: "docs", description: "Reads the docs." });
  declareMcpServer(handle.db, { name: "tracker", description: "Reads the tracker." });

  shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" }).id as Uuid;
  reviewer = agentOfKind(handle.db, "reviewer");
  // One agent every project has, and one only the shop has.
  checker = createAgent(handle.db, { name: "Checker", role: "reviewer", provider: "claude", instructions: "Check every criterion." }).id;
  const prober = createAgent(handle.db, { name: "Prober", role: "reviewer", provider: "claude", instructions: "Probe the edges.", projectId: shop }).id;

  pipelineId = createPipeline(handle.db, { projectId: shop, name: "Checks" }).id as Uuid;
  const team = createTeam(handle.db, {
    projectId: shop,
    author: { kind: "person", personId: null },
    definition: TeamDefinitionSchema.parse({
      coordination: "leader",
      name: "Shop reviewers",
      memberMode: "isolated",
      leader: { agentId: reviewer, instructions: "Give Checker the criteria and Prober the edges." },
      members: [{ agentId: checker }, { agentId: prober }],
      toolPool: { cliTools: [], mcpServers: ["docs"], skills: [] },
      modelRange: { runtimes: ["claude", "codex"], models: [], reasoning: ["high"] },
      memberCap: 4,
      limits: { maxRounds: 3 },
    }),
  });
  if (!team.ok) throw new Error(team.reason);
  const review = createStep(handle.db, { pipelineId, position: 0, name: "Review", type: "agent", agentId: reviewer, entryAction: "review", teamId: team.team.id });
  createStep(handle.db, { pipelineId, position: 1, name: "Done", type: "user", isTerminal: true });
  setEntryStep(handle.db, pipelineId, review.id);
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

function exported(): PipelineExport {
  const built = exportPipeline(handle.db, pipelineId);
  if (!built.ok) throw new Error(built.reason);
  // Through text, as a file travels.
  const parsed = parseExport(JSON.stringify(built.document));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.document;
}

const teamIn = (document: PipelineExport): ExportedTeam => {
  const team = document.steps.find((step) => step.name === "Review")?.team;
  if (team === undefined || !isExportedTeam(team)) throw new Error("Review carries no declared team");
  return team;
};

describe("exporting a step's declared team (EO-885)", () => {
  it("writes the team with its leader and members as kinds and their instructions, its pool by tool name, its model range, cap and limits, and no agent id", () => {
    const document = exported();
    const team = teamIn(document);
    expect(team).toMatchObject({
      coordination: "leader",
      name: "Shop reviewers",
      memberMode: "isolated",
      leader: { name: getAgent(handle.db, reviewer)!.name, kind: "reviewer", instructions: getAgent(handle.db, reviewer)!.instructions, teamInstructions: "Give Checker the criteria and Prober the edges." },
      members: [
        { name: "Checker", kind: "reviewer", instructions: "Check every criterion." },
        { name: "Prober", kind: "reviewer", instructions: "Probe the edges." },
      ],
      toolPool: { cliTools: [], mcpServers: ["docs"], skills: [] },
      modelRange: { runtimes: ["claude", "codex"], models: [], reasoning: ["high"] },
      memberCap: 4,
      limits: { maxRounds: 3 },
    });
    expect(JSON.stringify(team)).not.toMatch(UUID);
    expect(JSON.stringify(team)).not.toContain("agentId");
    expect(document.eoPipelineExport).toBe(18);
    // Every kind its agents are, carried as a role.
    expect(document.roles.map((role) => role.slug)).toContain("reviewer");
  });
});

describe("importing a step's declared team (EO-885)", () => {
  let elsewhere: Uuid;

  beforeEach(() => {
    elsewhere = createProject(handle.db, { name: "Elsewhere", keyPrefix: "ELS" }).id as Uuid;
    // The reviewer runs on Codex here, and may use both servers.
    updateAgent(handle.db, reviewer, { provider: "codex" });
    for (const agentId of [reviewer, checker]) {
      for (const name of ["docs", "tracker"]) setAgentAttachment(handle.db, { agentId, kind: "mcpServer", id: getMcpServerByName(handle.db, name)!.id, attached: true });
    }
  });

  it("binds each agent to one of its kind with the same instructions, creates the rest, and keeps every member to the team's pool", () => {
    const document = exported();
    const imported = importPipeline(handle.db, { document, projectId: elsewhere, agents: { reviewer } });
    if (!imported.ok) throw new Error(imported.reason);
    const step = listStepsForPipeline(handle.db, imported.pipelineId as Uuid).find((each) => each.name === "Review")!;
    const team = getTeam(handle.db, step.teamId!)!;
    expect(team).toMatchObject({ projectId: elsewhere, name: "Shop reviewers" });
    const definition = team.definition!;
    if (definition.coordination !== "leader") throw new Error("not leader-led");
    const [checkerHere, proberHere] = definition.members.map((member) => getAgent(handle.db, member.agentId as Uuid)!);
    const leaderHere = getAgent(handle.db, definition.leader.agentId as Uuid)!;

    // Every agent the team's own (EO-897), none of them an agent the project already had.
    for (const agent of [leaderHere, checkerHere!, proberHere!]) expect(agent.teamId, agent.name).toBe(team.id);
    // Bound: the leader and Checker, as copies of the agents with their instructions, on what those run on.
    expect(leaderHere).toMatchObject({ role: "reviewer", provider: "codex", instructions: getAgent(handle.db, reviewer)!.instructions });
    expect(checkerHere).toMatchObject({ name: "Checker", role: "reviewer", provider: "claude", instructions: "Check every criterion." });
    // Created: Prober, which only the shop has, with the document's name and instructions, made like the reviewer its step names.
    expect(proberHere).toMatchObject({ name: "Prober", role: "reviewer", provider: "codex", instructions: "Probe the edges." });
    // Each member given only what the pool declares; the leader is not a member and keeps what it was given.
    const surfaces = agentToolSurfaces(handle.db, [leaderHere.id, checkerHere!.id, proberHere!.id]);
    expect(surfaces[checkerHere!.id]!.mcpServers).toEqual(["docs"]);
    expect(surfaces[proberHere!.id]!.mcpServers).toEqual(["docs"]);
    expect([...surfaces[leaderHere.id]!.mcpServers].sort()).toEqual(["docs", "tracker"]);
    // Everything else the team declared, as the document carried it.
    expect(definition).toMatchObject({ memberMode: "isolated", memberCap: 4, toolPool: { mcpServers: ["docs"] }, modelRange: { runtimes: ["claude", "codex"], reasoning: ["high"] }, limits: { maxRounds: 3 } });
    expect(definition.leader.instructions).toBe("Give Checker the criteria and Prober the edges.");
    // The ordinary agents are left as they were.
    expect(getAgent(handle.db, checker)!.teamId).toBeNull();
    expect(step.team).toEqual(documentStepTeam(teamIn(document)));
  });

  it("is said by pipeline_import_check before anything is written: which agent each is bound to, and which is created", async () => {
    const document = exported();
    const preflight = preflightImport(handle.db, secrets, document, { projectId: elsewhere });
    const reviewerName = getAgent(handle.db, reviewer)!.name;
    expect(preflight.teams).toEqual([
      {
        stepName: "Review",
        teamName: "Shop reviewers",
        agents: [
          { name: reviewerName, kind: "reviewer", binding: "existing", agent: reviewerName },
          { name: "Checker", kind: "reviewer", binding: "existing", agent: "Checker" },
          { name: "Prober", kind: "reviewer", binding: "create", agent: reviewerName },
        ],
      },
    ]);

    const dispatch: Dispatch = (channel: IpcChannel, payload: unknown) => dispatchIpc(channel, payload);
    registerHandler("pipelines:importPreflight", () => ({ preflight: { ...preflight, collisions: [], missingBinaries: [], missingSecrets: [], moduleCount: 0 }, document: "{}", problem: null }), { exposeErrorDetails: true });
    const check = TOOLS.find((tool) => tool.name === "pipeline_import_check")!;
    const outcome = await check.run(dispatch, { document: "{}" });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.text).toContain('Team "Shop reviewers" (the step "Review"):');
    expect(outcome.text).toContain("- Checker (reviewer): bound to Checker, which has the same instructions, copied for the team");
    expect(outcome.text).toContain(`- Prober (reviewer): created with the document's instructions, on the runtime, model and tools of ${reviewerName}`);
  });

  it("names, for a created agent, the agent the import will make it like: the one the person chose for its kind", () => {
    const document = exported();
    const preflight = preflightImport(handle.db, secrets, document, { projectId: elsewhere, agents: { reviewer: checker } });
    expect(preflight.teams[0]!.agents.find((agent) => agent.name === "Prober")).toEqual({ name: "Prober", kind: "reviewer", binding: "create", agent: "Checker" });

    const imported = importPipeline(handle.db, { document, projectId: elsewhere, agents: { reviewer: checker } });
    if (!imported.ok) throw new Error(imported.reason);
    const step = listStepsForPipeline(handle.db, imported.pipelineId as Uuid).find((each) => each.name === "Review")!;
    const definition = getTeam(handle.db, step.teamId!)!.definition!;
    const prober = definition.members.map((member) => getAgent(handle.db, member.agentId as Uuid)!).find((agent) => agent.name === "Prober")!;
    // Made like Checker, which runs on Claude, not like the reviewer, which runs on Codex here.
    expect(prober).toMatchObject({ provider: "claude", instructions: "Probe the edges." });
  });

  it("imports a document written before declared teams travelled (format 17), its role-staffed team declared from the agents its roles bind to", () => {
    const document = exported();
    const legacy = JSON.parse(JSON.stringify({ ...document, eoPipelineExport: 17, steps: document.steps.map((step) => (step.team === undefined ? step : { ...step, team: documentStepTeam(step.team) })) })) as unknown;
    const parsed = parseExport(JSON.stringify(legacy));
    if (!parsed.ok) throw new Error(parsed.reason);
    const imported = importPipeline(handle.db, { document: parsed.document, projectId: elsewhere, agents: { reviewer } });
    if (!imported.ok) throw new Error(imported.reason);
    const step = listStepsForPipeline(handle.db, imported.pipelineId as Uuid).find((each) => each.name === "Review")!;
    expect(step.teamId).not.toBeNull();
    expect(getTeam(handle.db, step.teamId!)?.projectId).toBe(elsewhere);
    expect(step.team).toEqual(documentStepTeam(teamIn(document)));
  });

  it("refuses a newer format with the sentence to update, and an older build's format check is reached", () => {
    const parsed = parseExport(JSON.stringify({ ...exported(), eoPipelineExport: 19 }));
    expect(parsed).toEqual({ ok: false, reason: expect.stringContaining("Update EO and try again") });
  });
});
