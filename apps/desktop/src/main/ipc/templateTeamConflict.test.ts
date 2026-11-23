import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_MCP_SERVER_NAME,
  AssistOutputSchema,
  type AssistReply,
  type ExportedTeam,
  type IpcChannel,
  type IpcResponse,
  type Item,
  SkillDraftSchema,
  type UpdateConflictDetail,
  type Uuid,
} from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  adoptPipeline,
  appendRunEvent,
  createRun,
  getItem,
  getPipelineOrigin,
  getUpdateConflict,
  listAgents,
  listCommentsForItem,
  listRoutesForPipeline,
  listStepsForPipeline,
  openUpdateConflict,
  saveSkill,
  setAgentAttachment,
  updateRun,
} from "../db/repos/index.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { saveCliTool, setAgentCliTool } from "../db/repos/cliToolsRepo.js";
import { agentToolSurfaces, exportedTeamOf, getTeam, sameExportedTeam } from "../db/repos/teamsRepo.js";
import { agentOfKind, openMigratedTestDb } from "../db/testHelpers.js";
import type { TemplateVersion } from "../gallery/history.js";
import { loadTemplateHistory } from "../gallery/history.js";
import { templateHistoryUpTo } from "../gallery/historyTestHelpers.js";
import { backfillPipelineOrigins } from "../gallery/origins.js";
import { applyTemplateUpdates } from "../gallery/templateUpdates.js";
import { TOOLS } from "../mcpHost/catalog.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { fakePlatform } from "../testing/platform.js";
import { savePipeline } from "./configCommands.js";
import { clearPublishedView } from "./currentView.js";
import { clearHandlerRegistry, dispatchIpc } from "./registry.js";

/**
 * Taking a template's team on a conflicting update is one card (EO-898).
 *
 * Delivery on 1.7, whose person removed Review's team; the bundled 1.8
 * brings Review back as a declared team of a lead and six pass reviewers,
 * and is held as a conflict. The assistant reads the held update, which
 * offers the template's team ready for a draft — every agent declared
 * new — and puts "take the template's team" on a card beside "Keep my
 * pipeline". Publishing it gives Review the team, its seven agents the
 * team's own with the tools the person's reviewer had (EO-885, option B),
 * and creates no other agent.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
const SOFTWARE = "software-feature-to-merge";
const ADMIN = (tool: string) => `mcp__${ADMIN_MCP_SERVER_NAME}__${tool}`;
const shipped = loadTemplateHistory(GALLERY_DIRECTORY);
const bundled = JSON.parse(readFileSync(join(GALLERY_DIRECTORY, `${SOFTWARE}.json`), "utf8")) as TemplateVersion["document"];
/** Review's team as the bundled 1.8 ships it. */
const TEAM = bundled.steps.find((step) => step.id === "review")!.team as Extract<ExportedTeam, { coordination: "leader" }>;

let handle: DbHandle;
let tool: string;
let skill: string;

beforeEach(async () => {
  handle = openMigratedTestDb();
  const { registerAllHandlers } = await import("./handlers.js");
  registerAllHandlers(handle.db, undefined, { platform: fakePlatform() });

  // The person's reviewer has a CLI tool and a skill: the team's pool is those (EO-885, option B).
  const reviewer = agentOfKind(handle.db, "reviewer");
  const saved = saveCliTool(handle.db, { name: "GitHub CLI", command: "gh", description: "Pull requests and issues." });
  if (!saved.ok) throw new Error("the CLI tool was refused");
  expect(setAgentCliTool(handle.db, { agentId: reviewer, cliToolId: saved.cliTool.id, attached: true }).ok).toBe(true);
  const playbook = saveSkill(handle.db, SkillDraftSchema.parse({ name: "Review playbook", description: "How this house reviews.", body: "Read the diff." }));
  if (!playbook.ok) throw new Error(playbook.problems.join("\n"));
  expect(setAgentAttachment(handle.db, { agentId: reviewer, kind: "skill", id: playbook.skill.id, attached: true }).ok).toBe(true);
  tool = saved.cliTool.command;
  skill = playbook.skill.slug;

  // Delivery on 1.7, as the template installed it.
  const onSeventeen = templateHistoryUpTo(GALLERY_DIRECTORY, SOFTWARE, "1.7");
  backfillPipelineOrigins(handle.db, onSeventeen);
  adoptPipeline(handle.db, "default", createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" }).id as Uuid);
  applyTemplateUpdates(handle.db, onSeventeen, { isTheRecord: false });
  expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.7");

  // The person removes Review's team: Review is one agent again.
  const steps = listStepsForPipeline(handle.db, "default").filter((step) => !step.offBoard);
  const removed = savePipeline(handle.db, undefined, {
    pipelineId: "default",
    steps: steps.map((step) => (step.id === "review" ? { ...step, team: null, teamId: null } : step)),
    routes: listRoutesForPipeline(handle.db, "default"),
    entryStepId: "worktree",
  });
  expect(removed.saved).toBe(true);
  expect(review().teamId).toBeNull();

  // 1.8 is held: the person changed what the template changes.
  expect(applyTemplateUpdates(handle.db, shipped, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "conflict", from: "1.7", to: "1.8" }));
});

afterEach(() => {
  clearHandlerRegistry();
  clearPublishedView();
  handle.close();
});

const review = () => listStepsForPipeline(handle.db, "default").find((step) => step.id === "review")!;

async function call<K extends IpcChannel>(channel: K, payload: unknown): Promise<IpcResponse<K>> {
  const answer = await dispatchIpc(channel, payload);
  if (!answer.ok) throw new Error(`${channel} refused: ${answer.error.message}`);
  return answer.data as IpcResponse<K>;
}

/** The held update, as `pipeline_update_conflict` answers the assistant. */
async function readConflict(): Promise<{ text: string; conflict: UpdateConflictDetail }> {
  const outcome = await TOOLS.find((entry) => entry.name === "pipeline_update_conflict")!.run(dispatchIpc, { pipelineId: "default" });
  if (!outcome.ok) throw new Error(outcome.message);
  return { text: outcome.text, conflict: (outcome.data as IpcResponse<"pipeline:updateConflict">).conflict! };
}

/** Fix with assistant, pressed on the update's notice. */
async function openChat(): Promise<Item> {
  const held = openUpdateConflict(handle.db, "default")!;
  const opened = await call("assist:openUpdateConflict", { conflictId: held.id, commentId: held.noticeIds[0]! });
  return getItem(handle.db, opened.conversation!.id as Uuid)!;
}

/** A turn posted as the supervisor would on success, having read the pipeline. */
function turn(chat: Item, reply: AssistReply): { cards: Uuid[]; rejections: string[] } {
  const parsed = AssistOutputSchema.parse(reply);
  const agent = assistAgent(handle.db)!;
  const run = createRun(handle.db, { itemId: chat.id, agentId: agent.id, action: ASSIST_ACTION, initiationId: listCommentsForItem(handle.db, chat.id)[0]!.id });
  appendRunEvent(handle.db, run.id, "tool_call", { name: ADMIN("pipeline_get"), args: { pipelineId: "default" }, callId: "call-0" });
  appendRunEvent(handle.db, run.id, "tool_result", { name: ADMIN("pipeline_get"), callId: "call-0", ok: true, output: "", truncated: false });
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(parsed), parsed } });
  postAssistReply(handle.db, chat, agent.id, run.id, parsed);
  const posted = listCommentsForItem(handle.db, chat.id).filter((comment) => comment.runId === run.id);
  return { cards: posted.filter((comment) => comment.kind === PROPOSAL_KIND).map((comment) => comment.id), rejections: posted.filter((comment) => comment.kind === "rejection").map((comment) => comment.body) };
}

/**
 * "Take the template's team", built from nothing but what the tool said:
 * the person's pipeline as it is, Review naming the template's team, and
 * that team's entry as the update offers it.
 */
function takeTheTeam(conflict: UpdateConflictDetail): NonNullable<AssistReply["draft"]> {
  const offered = conflict.templateTeams.find((entry) => entry.stepId === "review")!;
  const agents = listAgents(handle.db);
  const steps = [...conflict.current.steps].sort((a, b) => a.position - b.position);
  return {
    rationale: "Takes the template's Review team: a lead and six pass reviewers, each an agent of the team's own.",
    entryStepId: conflict.current.entryStepId!,
    steps: steps.map((step, position) => ({
      id: step.id,
      position,
      name: step.name,
      type: step.type,
      agent: step.type === "agent" ? (agents.find((agent) => agent.id === step.agentId)?.name ?? null) : null,
      entryAction: step.entryAction,
      instructionsSummary: step.instructionsSummary,
      isTerminal: step.isTerminal,
      planMode: step.planMode,
      ...(step.id === "review" ? { team: offered.team.name } : {}),
    })),
    routes: conflict.current.routes.map(({ fromStepId, resultKey, label, tone, target }, position) => ({ fromStepId, resultKey, label, tone, target, position })),
    target: { pipelineId: conflict.pipelineId },
    teams: [offered.team],
  } as NonNullable<AssistReply["draft"]>;
}

describe("Delivery with Review's team removed, updating to the bundled 1.8 (EO-898)", () => {
  it("offers the template's team ready for a draft, every agent declared new, its pool the person's reviewer's tools", async () => {
    const { conflict, text } = await readConflict();
    expect(conflict.changes).toContainEqual(expect.objectContaining({ key: { kind: "setting", stepId: "review", field: "team" }, changedBy: "conflict" }));
    const offered = conflict.templateTeams.find((entry) => entry.stepId === "review")!;
    expect(offered.stepName).toBe("Review");
    const team = offered.team;
    if (team.coordination !== "leader") throw new Error("not leader-led");
    expect(team.leader).toEqual({ agent: TEAM.leader.name, instructions: TEAM.leader.teamInstructions });
    expect(team.members.map((member) => member.agent)).toEqual(TEAM.members.map((member) => member.name));
    const reviewerName = listAgents(handle.db).find((agent) => agent.id === agentOfKind(handle.db, "reviewer"))!.name;
    expect(team.newMembers).toEqual([TEAM.leader, ...TEAM.members].map((part) => ({ name: part.name, kind: "reviewer", instructions: part.instructions, from: reviewerName })));
    expect(team.toolPool).toEqual({ cliTools: [tool], mcpServers: [], skills: [skill] });
    // Said to the assistant, with the entry as a draft takes it.
    expect(text).toContain("The declared teams this version gives its steps, each ready for a draft (EO-898).");
    expect(text).toContain(`- Review (id: review): ${JSON.stringify(team)}`);
  });

  it("puts \"take the template's team\" on a card beside Keep my pipeline; Publishing it gives Review the lead and six pass reviewers as the team's own agents, with the reviewer's tools, and creates no other agent", async () => {
    const chat = await openChat();
    const { conflict } = await readConflict();
    const { cards, rejections } = turn(chat, {
      message: "Two ways: take the template's Review team, or keep your pipeline.",
      draft: takeTheTeam(conflict),
      cards: [{ kind: "pipelineKeepMine", pipelineId: "default" }],
    });
    expect(rejections).toEqual([]);
    expect(cards).toHaveLength(2);
    const body = listCommentsForItem(handle.db, chat.id).find((comment) => comment.id === cards[0])!.body;
    for (const part of [TEAM.leader, ...TEAM.members]) expect(body).toContain(`New member: ${part.name} (new), a reviewer agent on `);

    const agentsBefore = listAgents(handle.db);
    const read = await call("assist:draft", { conversationId: chat.id, messageId: cards[0]! });
    expect(read.problem).toBeNull();
    expect(read.updateConflictId).not.toBeNull();
    // Nothing exists before Publish.
    expect(listAgents(handle.db)).toEqual(agentsBefore);
    const saved = await call("pipeline:save", { pipelineId: read.pipelineId, steps: read.steps, routes: read.routes, entryStepId: read.entryStepId, teams: read.teams });
    expect(saved.saved).toBe(true);
    await call("assist:draftPublished", { conversationId: chat.id, messageId: cards[0]! });

    // The update is resolved, and the base is 1.8.
    expect(openUpdateConflict(handle.db, "default")).toBeUndefined();
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.8");

    // Review runs as the template's team, its seven agents the team's own.
    const teamId = review().teamId!;
    const team = getTeam(handle.db, teamId)!;
    const definition = team.definition!;
    if (definition.coordination !== "leader") throw new Error("not leader-led");
    const ids = [definition.leader.agentId, ...definition.members.map((member) => member.agentId)];
    const made = ids.map((id) => listAgents(handle.db).find((agent) => agent.id === id)!);
    expect(made.map((agent) => [agent.name, agent.role, agent.teamId, agent.instructions])).toEqual(
      [TEAM.leader, ...TEAM.members].map((part) => [part.name, "reviewer", teamId, part.instructions]),
    );
    // Exactly those seven are new, and no ordinary agent was made.
    const added = listAgents(handle.db).filter((agent) => !agentsBefore.some((one) => one.id === agent.id));
    expect(added.map((agent) => agent.id).sort()).toEqual([...ids].sort());
    expect(listAgents(handle.db).filter((agent) => agent.teamId === null || agent.teamId === undefined)).toEqual(agentsBefore.filter((agent) => agent.teamId === null || agent.teamId === undefined));

    // With the tool pool the person's reviewer had, every one of them given its tools.
    expect(definition.toolPool).toEqual({ cliTools: [tool], mcpServers: [], skills: [skill] });
    for (const id of ids) {
      const surface = agentToolSurfaces(handle.db, [id])[id]!;
      expect(surface.cliTools).toEqual([tool]);
      expect(surface.skills).toEqual([skill]);
    }
    // And it is the template's team, so the next version compares with it as untouched.
    expect(sameExportedTeam(exportedTeamOf(handle.db, teamId), TEAM)).toBe(true);
  });

  it("Keep my pipeline still works: Review stays one agent, the base moves to 1.8, and no agent or team is made", async () => {
    const chat = await openChat();
    const { conflict } = await readConflict();
    const { cards } = turn(chat, { message: "Two ways.", draft: takeTheTeam(conflict), cards: [{ kind: "pipelineKeepMine", pipelineId: "default" }] });
    const agentsBefore = listAgents(handle.db);
    const conflictId = openUpdateConflict(handle.db, "default")!.id;

    const pressed = await call("assist:applyCard", { conversationId: chat.id, messageId: cards[1]! });

    expect(pressed.applied).toBe(true);
    expect(getUpdateConflict(handle.db, conflictId)?.resolution).toBe("kept");
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.8");
    expect(review().teamId).toBeNull();
    expect(listAgents(handle.db)).toEqual(agentsBefore);
    // Never raised again for this version.
    expect(applyTemplateUpdates(handle.db, shipped, { isTheRecord: false })).toEqual([]);
  });
});
