import { ADMIN_MCP_SERVER_NAME, AssistOutputSchema, pageDescriptorFor, StepTeamSchema, type IpcChannel, type Item, type StepTeam, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { markReplica } from "../db/recordRole.js";
import {
  appendRunEvent,
  createPipeline,
  createProject,
  createRoute,
  createRun,
  createStep,
  currentVersion,
  getActionDefinition,
  getItem,
  listAgents,
  listCommentsForItem,
  listStepsForPipeline,
  publishSection,
  saveActionDefinition,
  setEntryStep,
  stepForItem,
  updateAgent,
  updateRun,
} from "../db/repos/index.js";
import { getTeamSession, openTeamSession } from "../db/repos/teamSessionsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { sectionLockFor } from "../managed/locks.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { readAssistDraftForPublish, sendToAssist } from "./assistCommands.js";
import { savePipeline } from "./configCommands.js";
import { handleIpcRequest } from "./handleRequest.js";
import { clearHandlerRegistry } from "./registry.js";

/**
 * A report-only team configured through the assistant's draft (EO-848):
 * the card a person reads before Publish shows the whole team, Publish
 * writes it — with any action definition the draft carries, both or
 * neither — and a team that could not run as drafted is refused with the
 * reason before any card is offered. Managed sections refuse as they
 * always did, and a team changed under live work files a new version
 * without touching what is already running on the old one.
 */
let handle: DbHandle;
let projectId: Uuid;
let pipelineId: Uuid;
let checkId: string;
let doneId: string;

const opts = { exposeErrorDetails: true };
const PIPELINE_READ = `mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_get`;

/** An independent team answering `reviewer / check`, whose answer is a result and a summary. */
const INDEPENDENT = {
  coordination: "independent",
  participants: [
    { key: "security", role: "reviewer", instructions: "Look for ways around authentication." },
    { key: "tests", role: "implementer", instructions: "Check the tests cover the change.", required: false },
  ],
  outcomes: [
    { key: "clear", label: "Clear", meaning: "Nothing here should stop it." },
    { key: "concerns", label: "Concerns", meaning: "Something should change first." },
  ],
  completion: { rules: [{ when: "any", outcomes: ["concerns"], result: "changes_requested" }], fallback: "approved" },
  limits: { maxParallel: 1, budgetCents: 300 },
};

/** A leader-led team on the same step. */
const LEADER = {
  coordination: "leader",
  leader: { role: "reviewer", instructions: "Split the review by risk, and weigh what comes back." },
  roles: ["implementer"],
  limits: { maxParticipants: 3, maxRounds: 2 },
};

beforeEach(() => {
  handle = openMigratedTestDb();
  // Members are held to report-only, which EO can do on Claude and not on
  // the seeded fake backend.
  for (const agent of listAgents(handle.db)) updateAgent(handle.db, agent.id, { provider: "claude" });
  const defined = saveActionDefinition(handle.db, {
    role: "reviewer",
    action: "check",
    results: [
      { key: "approved", meaning: "Nothing to change." },
      { key: "changes_requested", meaning: "Something to change." },
    ],
  });
  if (!defined.ok) throw new Error(JSON.stringify(defined));
  projectId = createProject(handle.db, { name: "Workbench", keyPrefix: "WRK" }).id as Uuid;
  pipelineId = createPipeline(handle.db, { projectId, name: "Checks" }).id as Uuid;
  checkId = createStep(handle.db, { pipelineId, position: 0, name: "Check", type: "agent", ownerRole: "reviewer", entryAction: "check" }).id;
  doneId = createStep(handle.db, { pipelineId, position: 1, name: "Done", type: "user", isTerminal: true }).id;
  createRoute(handle.db, { pipelineId, fromStepId: checkId, resultKey: "approved", label: "Approved", tone: "success", target: doneId, position: 0 });
  createRoute(handle.db, { pipelineId, fromStepId: checkId, resultKey: "changes_requested", label: "Changes", tone: "warning", target: doneId, position: 1 });
  setEntryStep(handle.db, pipelineId, checkId);
  // Every save files a version; the graph above is version 1.
  expect(savePipeline(handle.db, undefined, graphNow()).saved).toBe(true);
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

function graphNow() {
  const steps = listStepsForPipeline(handle.db, pipelineId);
  return {
    pipelineId,
    steps: steps.map((step) => ({ ...step })),
    routes: [
      { id: "r1", pipelineId, fromStepId: checkId, resultKey: "approved", label: "Approved", tone: "success" as const, target: doneId, position: 0 },
      { id: "r2", pipelineId, fromStepId: checkId, resultKey: "changes_requested", label: "Changes", tone: "warning" as const, target: doneId, position: 1 },
    ],
    entryStepId: checkId,
  };
}

async function conversation(): Promise<Item> {
  const sent = await sendToAssist(handle.db, undefined, { page: pageDescriptorFor(`/pipelines/${pipelineId}`), conversationId: null, body: "make Check a team", attachmentIds: [], interrupt: false });
  return getItem(handle.db, sent.conversation.id as Uuid)!;
}

/** The draft of this pipeline with Check given `team` and, optionally, other step fields. */
function draft(team: unknown, check: Record<string, unknown> = {}, routes?: { resultKey: string; label: string }[]) {
  const step = (id: string, position: number, rest: Record<string, unknown>) => ({ id, position, instructionsSummary: null, isTerminal: false, planMode: false, ...rest });
  return {
    rationale: "Check runs as a team.",
    entryStepId: checkId,
    target: { pipelineId },
    removes: [],
    steps: [
      step(checkId, 0, { name: "Check", type: "agent", ownerRole: "reviewer", entryAction: "check", ...(team === undefined ? {} : { team }), ...check }),
      step(doneId, 1, { name: "Done", type: "user", ownerRole: null, entryAction: null, isTerminal: true }),
    ],
    routes: (routes ?? [
      { resultKey: "approved", label: "Approved" },
      { resultKey: "changes_requested", label: "Changes" },
    ]).map((route, position) => ({ fromStepId: checkId, resultKey: route.resultKey, label: route.label, tone: "info", target: doneId, position })),
  };
}

/** A succeeded `assist` turn that read this pipeline and returned `output`, and what it posted. */
function turn(on: Item, output: unknown): { cardIds: Uuid[]; rejections: string[] } {
  const parsed = AssistOutputSchema.parse(output);
  const agent = assistAgent(handle.db)!;
  const asked = listCommentsForItem(handle.db, on.id).filter((comment) => comment.authorType === "human").at(-1)!;
  const run = createRun(handle.db, { itemId: on.id, agentId: agent.id, action: ASSIST_ACTION, initiationId: asked.id });
  appendRunEvent(handle.db, run.id, "tool_call", { name: PIPELINE_READ, args: { pipelineId }, callId: "call-1" });
  appendRunEvent(handle.db, run.id, "tool_result", { name: PIPELINE_READ, callId: "call-1", ok: true, output: "", truncated: false });
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(parsed), parsed } });
  postAssistReply(handle.db, on, agent.id, run.id, parsed);
  const posted = listCommentsForItem(handle.db, on.id).filter((comment) => comment.runId === run.id);
  return {
    cardIds: posted.filter((comment) => comment.kind === PROPOSAL_KIND).map((comment) => comment.id),
    rejections: posted.filter((comment) => comment.kind === "rejection").map((comment) => comment.body),
  };
}

function cardBody(on: Item, id: Uuid): string {
  return listCommentsForItem(handle.db, on.id).find((comment) => comment.id === id)!.body;
}

/** Publish, as the draft card's button sends it: through `pipeline:save`, with the section lock every channel is asked. */
async function publish(on: Item, cardId: Uuid) {
  const read = readAssistDraftForPublish(handle.db, { conversationId: on.id, messageId: cardId });
  expect(read.problem).toBeNull();
  return handleIpcRequest(
    "pipeline:save",
    {
      pipelineId: read.pipelineId,
      steps: read.steps,
      routes: read.routes,
      entryStepId: read.entryStepId,
      ...((read.actions ?? []).length > 0 ? { actions: read.actions } : {}),
    },
    (payload) => savePipeline(handle.db, undefined, payload),
    { ...opts, sectionLock: (channel: IpcChannel, payload: unknown) => sectionLockFor(handle.db, channel, payload) },
  );
}

const teamOnCheck = () => listStepsForPipeline(handle.db, pipelineId).find((step) => step.id === checkId)!.team;

describe("a team drafted by the assistant (EO-848)", () => {
  it("shows the whole independent team on the card — members, coordination, completion and limits — and Publish writes exactly it", async () => {
    const on = await conversation();
    const { cardIds, rejections } = turn(on, { message: "Check runs as a team now.", draft: draft(INDEPENDENT) });
    expect(rejections).toEqual([]);
    expect(cardIds).toHaveLength(1);

    const body = cardBody(on, cardIds[0]!);
    expect(body).toContain("Team: one agent → an independent team");
    expect(body).toContain("Coordination: Independent — 2 participants each report on their own");
    expect(body).toContain("Member: security: a reviewer agent, required — Look for ways around authentication.");
    expect(body).toContain("Member: tests: a implementer agent, optional — Check the tests cover the change.");
    expect(body).toContain("Outcomes a member may report: Clear (clear) — Nothing here should stop it.; Concerns (concerns) — Something should change first.");
    expect(body).toContain("Completion: If any report concludes Concerns → changes_requested");
    expect(body).toContain("Completion: Otherwise → approved");
    expect(body).toContain("Limits: 1 participant at a time, 4 participants in all, 1 retry for a participant whose run fails, time: the run timeout, spending: $3 for the whole team");
    expect(body).toContain("None of them can edit the work");

    // What Publish would send carries the team, parsed whole.
    const read = readAssistDraftForPublish(handle.db, { conversationId: on.id, messageId: cardIds[0]! });
    expect(read.steps.find((step) => step.id === checkId)?.team).toEqual(StepTeamSchema.parse(INDEPENDENT));

    const before = currentVersion(handle.db, pipelineId)!.number;
    expect(await publish(on, cardIds[0]!)).toMatchObject({ ok: true, data: { saved: true } });
    expect(teamOnCheck()).toEqual(StepTeamSchema.parse(INDEPENDENT));
    expect(currentVersion(handle.db, pipelineId)!.number).toBe(before + 1);
  });

  it("drafts a leader-led team, changes one team into another on the card, and \"none\" back to one agent", async () => {
    const on = await conversation();
    const led = turn(on, { message: "Led.", draft: draft(LEADER) });
    expect(led.rejections).toEqual([]);
    const ledBody = cardBody(on, led.cardIds[0]!);
    expect(ledBody).toContain("Team: one agent → a leader-led team");
    expect(ledBody).toContain("Member: Leader: a reviewer agent — Split the review by risk, and weigh what comes back.");
    expect(ledBody).toContain("Member: May assign work to: implementer");
    expect(ledBody).toContain("2 rounds of assignments");
    expect(await publish(on, led.cardIds[0]!)).toMatchObject({ ok: true, data: { saved: true } });

    const swapped = turn(on, { message: "Independent instead.", draft: draft(INDEPENDENT) });
    expect(cardBody(on, swapped.cardIds[0]!)).toContain("Team: a leader-led team → an independent team");

    // Left out, the step keeps its team, and a draft that changes nothing else is nothing to apply.
    const kept = turn(on, { message: "Same.", draft: draft(undefined) });
    expect(kept.cardIds).toEqual([]);
    expect(kept.rejections.join(" ")).toContain("identical to the pipeline as it stands");

    const single = turn(on, { message: "One agent again.", draft: draft("none") });
    expect(cardBody(on, single.cardIds[0]!)).toContain("Team: a leader-led team → one agent");
    expect(await publish(on, single.cardIds[0]!)).toMatchObject({ ok: true, data: { saved: true } });
    expect(teamOnCheck()).toBeNull();
  });

  it("carries a report-compatible custom action for an independent team, and Publish writes the definition with the graph", async () => {
    const on = await conversation();
    const verdict = {
      role: "reviewer",
      action: "team_verdict",
      description: "The team's verdict, decided by EO from its reports.",
      results: [
        { key: "pass", label: "Pass", meaning: "Nothing should stop it." },
        { key: "fail", label: "Fail", meaning: "Something should change first." },
      ],
      fields: [],
    };
    const team = { ...INDEPENDENT, completion: { rules: [{ when: "any", outcomes: ["concerns"], result: "fail" }], fallback: "pass" } };
    const { cardIds, rejections } = turn(on, {
      message: "Check answers a verdict the team can give.",
      draft: draft(team, { entryAction: "team_verdict" }, [
        { resultKey: "pass", label: "Pass" },
        { resultKey: "fail", label: "Fail" },
      ]),
      actions: [verdict],
    });
    expect(rejections).toEqual([]);
    const body = cardBody(on, cardIds[0]!);
    expect(body).toContain("**New action** reviewer / team_verdict");
    expect(body).toContain("Completion: If any report concludes Concerns → fail");

    expect(getActionDefinition(handle.db, "reviewer", "team_verdict")).toBeUndefined();
    expect(await publish(on, cardIds[0]!)).toMatchObject({ ok: true, data: { saved: true } });
    expect(getActionDefinition(handle.db, "reviewer", "team_verdict")?.results.map((result) => result.key)).toEqual(["pass", "fail"]);
    expect(teamOnCheck()?.coordination).toBe("independent");
  });

  describe("refuses, with the reason and before any card, a team that could not run as drafted", () => {
    async function refused(team: unknown, check: Record<string, unknown> = {}, routes?: { resultKey: string; label: string }[]) {
      const on = await conversation();
      const posted = turn(on, { message: "A team.", draft: draft(team, check, routes) });
      expect(posted.cardIds).toEqual([]);
      expect(posted.rejections).toHaveLength(1);
      expect(teamOnCheck()).toBeNull();
      return posted.rejections[0]!;
    }

    it("an independent team on a pack's action, whose answer the pack shapes", async () => {
      const reason = await refused(INDEPENDENT, { entryAction: "review" }, [
        { resultKey: "approved", label: "Approved" },
        { resultKey: "changes_requested", label: "Changes" },
      ]);
      expect(reason).toContain("This graph cannot be published as proposed");
      expect(reason).toContain(`"review" is a pack's action, whose answer the pack shapes. Use a leader-led team, whose leader answers it.`);
    });

    it("an independent team on an action that needs fields it cannot fill", async () => {
      const audit = saveActionDefinition(handle.db, {
        role: "reviewer",
        action: "audit",
        results: [{ key: "approved" }, { key: "changes_requested" }],
        fields: { type: "object", properties: { findings: { type: "array", items: { type: "string" } } }, required: ["findings"] },
      });
      if (!audit.ok) throw new Error(JSON.stringify(audit));
      expect(await refused(INDEPENDENT, { entryAction: "audit" })).toMatch(/also requires "findings"\. Use a leader-led team/);
    });

    it("a completion result the action does not return", async () => {
      const team = { ...INDEPENDENT, completion: { rules: [], fallback: "merged" } };
      expect(await refused(team)).toContain(`can decide "merged", which "check" cannot return`);
    });

    it("a role nobody on this project staffs", async () => {
      expect(await refused({ ...LEADER, roles: ["auditor"] })).toContain(`needs a "auditor" agent, and this project has none enabled`);
    });

    it("a role an agent of which EO could not hold to report-only", async () => {
      const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
      updateAgent(handle.db, implementer.id, { config: { inheritAmbientConfig: true } });
      expect(await refused(INDEPENDENT)).toContain(`could be staffed by a "implementer" agent EO cannot hold to report-only: ${implementer.name} uses the person's own setup`);
    });

    it("a role an agent of which runs its own executable, whose version EO cannot vouch for (EO-850)", async () => {
      const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
      updateAgent(handle.db, implementer.id, { config: { executablePath: "/opt/claude/bin/claude" } });
      expect(await refused(INDEPENDENT)).toContain(`${implementer.name} runs its own Claude executable, whose version EO cannot vouch for`);
    });

    it("a team on a step that is not an agent's", async () => {
      const reason = await refused(INDEPENDENT, { type: "user", ownerRole: null, entryAction: null });
      expect(reason).toContain(`"Check" has a team, but only a step an agent does can run as one.`);
    });

    it("a team past its own limits", async () => {
      const on = await conversation();
      // The schema refuses it in the turn, before anything is drawn.
      expect(() => turn(on, { message: "Big.", draft: draft({ ...INDEPENDENT, limits: { maxParallel: 9 } }) })).toThrow();
    });
  });

  describe("managed sections", () => {
    let stopBeingAReplica: (() => void) | null = null;
    afterEach(() => {
      stopBeingAReplica?.();
      stopBeingAReplica = null;
    });

    it("refuses Publish of a team where the pipelines section is managed, and writes nothing", async () => {
      const on = await conversation();
      const { cardIds } = turn(on, { message: "A team.", draft: draft(INDEPENDENT) });
      stopBeingAReplica = markReplica(handle.db, () => true);
      publishSection(handle.db, { section: "pipelines", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });

      const answer = await publish(on, cardIds[0]!);
      expect(answer.ok).toBe(false);
      expect(JSON.stringify(answer)).toContain("pipelines");
      expect(teamOnCheck()).toBeNull();
    });

    it("refuses a team's custom action where the agents section is managed: neither the definition nor the team is written", async () => {
      const on = await conversation();
      const team = { ...INDEPENDENT, completion: { rules: [{ when: "any", outcomes: ["concerns"], result: "fail" }], fallback: "pass" } };
      const { cardIds } = turn(on, {
        message: "With its own action.",
        draft: draft(team, { entryAction: "team_verdict" }, [
          { resultKey: "pass", label: "Pass" },
          { resultKey: "fail", label: "Fail" },
        ]),
        actions: [{ role: "reviewer", action: "team_verdict", results: [{ key: "pass" }, { key: "fail" }], fields: [] }],
      });
      stopBeingAReplica = markReplica(handle.db, () => true);
      publishSection(handle.db, { section: "agents", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });

      const answer = await publish(on, cardIds[0]!);
      expect(answer).toMatchObject({ ok: true, data: { saved: false } });
      expect(JSON.stringify(answer)).toContain("The agents section is managed by your organisation. Dana published it.");
      expect(getActionDefinition(handle.db, "reviewer", "team_verdict")).toBeUndefined();
      expect(teamOnCheck()).toBeNull();
    });
  });

  it("files a new version for a changed team, and leaves work on the old version — and a session already running — with the team it entered on", async () => {
    const on = await conversation();
    const first = turn(on, { message: "Led.", draft: draft(LEADER) });
    expect(await publish(on, first.cardIds[0]!)).toMatchObject({ ok: true, data: { saved: true } });
    const entered = currentVersion(handle.db, pipelineId)!;

    // An item enters on that version, and its team starts.
    const item = createTestItem(handle.db, { type: "story", projectId, pipelineId, stepId: checkId as Uuid, title: "Harden login" });
    expect(getItem(handle.db, item.id)!.pipelineVersionId).toBe(entered.id);
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: checkId, team: StepTeamSchema.parse(LEADER), runId: null, now: Date.now() });

    const second = turn(on, { message: "Independent now.", draft: draft(INDEPENDENT) });
    expect(await publish(on, second.cardIds[0]!)).toMatchObject({ ok: true, data: { saved: true } });
    expect(currentVersion(handle.db, pipelineId)!.number).toBe(entered.number + 1);
    expect(teamOnCheck()?.coordination).toBe("independent");

    // The item still runs Check as its own version had it, and the open session keeps the team it was opened with.
    const step = stepForItem(handle.db, getItem(handle.db, item.id)!);
    expect(step?.team).toEqual(StepTeamSchema.parse(LEADER) satisfies StepTeam);
    expect(getTeamSession(handle.db, session.id)?.team).toEqual(StepTeamSchema.parse(LEADER));
    expect(getTeamSession(handle.db, session.id)?.status).toBe("open");
  });
});
