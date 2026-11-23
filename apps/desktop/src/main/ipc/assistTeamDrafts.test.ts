import { ADMIN_MCP_SERVER_NAME, AssistOutputSchema, pageDescriptorFor, StepTeamSchema, TeamDefinitionSchema, uuidv7, type IpcChannel, type Item, type StepTeam, type Uuid } from "@eo/core";
import { getTeam, listTeamVersions, listTeams, setTeamLocked } from "../db/repos/teamsRepo.js";
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
import { createTestItem, openMigratedTestDb, agentOfKind } from "../db/testHelpers.js";
import { sectionLockFor } from "../managed/locks.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { readAssistDraftForPublish, sendToAssist } from "./assistCommands.js";
import { savePipeline, validatePipelineCommand } from "./configCommands.js";
import { handleIpcRequest } from "./handleRequest.js";
import { clearHandlerRegistry } from "./registry.js";

/**
 * A team configured through the assistant's draft (EO-848), a declared
 * team since EO-881: the draft declares the team in `teams` and names it
 * on the step, the card a person reads before Publish shows the whole
 * team, Publish writes it — with any action definition the draft carries,
 * both or neither — and a team that could not run as drafted is refused
 * with the reason before any card is offered. A draft changing a team the
 * project has files the team's next version, refused where a person
 * locked it. Managed sections refuse as they always did, and a team
 * changed under live work files a new version without touching what is
 * already running on the old one.
 */
let handle: DbHandle;
let projectId: Uuid;
let pipelineId: Uuid;
let checkId: string;
let doneId: string;

const opts = { exposeErrorDetails: true };
const PIPELINE_READ = `mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_get`;

/** The agent of a kind, by the name a draft names it by. */
function nameOf(kind: string): string {
  const id = agentOfKind(handle.db, kind);
  return listAgents(handle.db).find((agent) => agent.id === id)!.name;
}

/** An independent team answering `reviewer / check`, whose answer is a result and a summary, as a draft declares it. */
const INDEPENDENT = () => ({
  name: "Change review",
  coordination: "independent",
  members: [
    { key: "security", agent: nameOf("reviewer"), instructions: "Look for ways around authentication." },
    { key: "tests", agent: nameOf("implementer"), instructions: "Check the tests cover the change.", required: false },
  ],
  outcomes: [
    { key: "clear", label: "Clear", meaning: "Nothing here should stop it." },
    { key: "concerns", label: "Concerns", meaning: "Something should change first." },
  ],
  completion: { rules: [{ when: "any", outcomes: ["concerns"], result: "changes_requested" }], fallback: "approved" },
  limits: { maxParallel: 1, budgetCents: 300 },
});

/** What it runs as: each member as its agent's kind (`stepTeamOf`). */
const INDEPENDENT_RUNS = StepTeamSchema.parse({
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
});

/** A leader-led team for the same step. */
const LEADER = () => ({
  name: "Review leads",
  coordination: "leader",
  leader: { agent: nameOf("reviewer"), instructions: "Split the review by risk, and weigh what comes back." },
  members: [{ agent: nameOf("implementer") }],
  limits: { maxParticipants: 3, maxRounds: 2 },
});

const LEADER_RUNS = StepTeamSchema.parse({
  coordination: "leader",
  leader: { role: "reviewer", instructions: "Split the review by risk, and weigh what comes back." },
  roles: ["implementer"],
  limits: { maxParticipants: 3, maxRounds: 2 },
});

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
  checkId = createStep(handle.db, { pipelineId, position: 0, name: "Check", type: "agent", agentId: agentOfKind(handle.db, "reviewer"), entryAction: "check" }).id;
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

/** The name of the reviewer agent Check names, as a draft names it. */
function reviewerName(): string {
  return nameOf("reviewer");
}

/**
 * The draft of this pipeline with Check naming the team `team` (a name,
 * `"none"`, or left out), declaring `teams`, and optionally other step fields.
 */
function draft(team: string | undefined, teams: unknown[] = [], check: Record<string, unknown> = {}, routes?: { resultKey: string; label: string }[]) {
  const step = (id: string, position: number, rest: Record<string, unknown>) => ({ id, position, instructionsSummary: null, isTerminal: false, planMode: false, ...rest });
  return {
    rationale: "Check runs as a team.",
    entryStepId: checkId,
    ...(teams.length === 0 ? {} : { teams }),
    target: { pipelineId },
    removes: [],
    steps: [
      // A draft names the step's agent by name (EO-876).
      step(checkId, 0, { name: "Check", type: "agent", agent: reviewerName(), entryAction: "check", ...(team === undefined ? {} : { team }), ...check }),
      step(doneId, 1, { name: "Done", type: "user", agent: null, entryAction: null, isTerminal: true }),
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
      // And the declared teams the card creates or changes (EO-881).
      ...((read.teams ?? []).length > 0 ? { teams: read.teams } : {}),
    },
    (payload) => savePipeline(handle.db, undefined, payload),
    { ...opts, sectionLock: (channel: IpcChannel, payload: unknown) => sectionLockFor(handle.db, channel, payload) },
  );
}

const teamOnCheck = () => listStepsForPipeline(handle.db, pipelineId).find((step) => step.id === checkId)!.team;

describe("a team drafted by the assistant (EO-848)", () => {
  it("shows the whole independent team on the card — members, coordination, completion and limits — and Publish writes exactly it", async () => {
    const on = await conversation();
    const { cardIds, rejections } = turn(on, { message: "Check runs as a team now.", draft: draft("Change review", [INDEPENDENT()]) });
    expect(rejections).toEqual([]);
    expect(cardIds).toHaveLength(1);

    const body = cardBody(on, cardIds[0]!);
    expect(body).toContain('Team: one agent → "Change review"');
    expect(body).toContain("**Teams**");
    expect(body).toContain('- New: "Change review", an independent team of report-only members');
    expect(body).toContain("Coordination: Independent — 2 participants each report on their own");
    expect(body).toContain(`Member security: ${nameOf("reviewer")}, required — Look for ways around authentication.`);
    expect(body).toContain(`Member tests: ${nameOf("implementer")}, optional — Check the tests cover the change.`);
    expect(body).toContain("Tool pool: nothing");
    expect(body).toContain("Member cap: 8");
    expect(body).toContain("Outcomes a member may report: Clear (clear) — Nothing here should stop it.; Concerns (concerns) — Something should change first.");
    expect(body).toContain("Completion: If any report concludes Concerns → changes_requested");
    expect(body).toContain("Completion: Otherwise → approved");
    expect(body).toContain("Limits: 1 participant at a time, 4 participants in all, 1 retry for a participant whose run fails, time: the run timeout, spending: $3 for the whole team");
    expect(body).toContain("None of them can edit the work");

    // What Publish would send declares the team, its agents bound to ids, and names it on the step.
    const read = readAssistDraftForPublish(handle.db, { conversationId: on.id, messageId: cardIds[0]! });
    expect(read.teams).toHaveLength(1);
    expect(read.teams[0]!.definition).toMatchObject({ name: "Change review", members: [{ agentId: agentOfKind(handle.db, "reviewer") }, { agentId: agentOfKind(handle.db, "implementer") }] });
    expect(read.steps.find((step) => step.id === checkId)?.teamId).toBe(read.teams[0]!.id);

    const before = currentVersion(handle.db, pipelineId)!.number;
    expect(await publish(on, cardIds[0]!)).toMatchObject({ ok: true, data: { saved: true } });
    expect(teamOnCheck()).toEqual(INDEPENDENT_RUNS);
    expect(currentVersion(handle.db, pipelineId)!.number).toBe(before + 1);
    // Declared on the project, its first version the assistant's.
    const declared = listTeams(handle.db, projectId);
    expect(declared.map((team) => team.name)).toEqual(["Change review"]);
    expect(listTeamVersions(handle.db, declared[0]!.id).map((version) => version.author)).toEqual([{ kind: "assistant" }]);
  });

  it("drafts a leader-led team, changes one team into another on the card, and \"none\" back to one agent", async () => {
    const on = await conversation();
    const led = turn(on, { message: "Led.", draft: draft("Review leads", [LEADER()]) });
    expect(led.rejections).toEqual([]);
    const ledBody = cardBody(on, led.cardIds[0]!);
    expect(ledBody).toContain('Team: one agent → "Review leads"');
    expect(ledBody).toContain(`Leader: ${nameOf("reviewer")} — Split the review by risk, and weigh what comes back.`);
    expect(ledBody).toContain(`Members: ${nameOf("implementer")}`);
    expect(ledBody).toContain("2 rounds of assignments");
    expect(await publish(on, led.cardIds[0]!)).toMatchObject({ ok: true, data: { saved: true } });
    expect(teamOnCheck()).toEqual(LEADER_RUNS);

    const swapped = turn(on, { message: "Independent instead.", draft: draft("Change review", [INDEPENDENT()]) });
    expect(cardBody(on, swapped.cardIds[0]!)).toContain('Team: "Review leads" → "Change review"');

    // Left out, the step keeps its team, and a draft that changes nothing else is nothing to apply.
    const kept = turn(on, { message: "Same.", draft: draft(undefined) });
    expect(kept.cardIds).toEqual([]);
    expect(kept.rejections.join(" ")).toContain("identical to the pipeline as it stands");

    const single = turn(on, { message: "One agent again.", draft: draft("none") });
    expect(cardBody(on, single.cardIds[0]!)).toContain('Team: "Review leads" → one agent');
    expect(await publish(on, single.cardIds[0]!)).toMatchObject({ ok: true, data: { saved: true } });
    expect(teamOnCheck()).toBeNull();
  });

  it("points a step at a team the project has without restating it, and changes that team as its next version, made by the assistant (EO-881)", async () => {
    const on = await conversation();
    const first = turn(on, { message: "Led.", draft: draft("Review leads", [LEADER()]) });
    expect(await publish(on, first.cardIds[0]!)).toMatchObject({ ok: true, data: { saved: true } });
    const team = listTeams(handle.db, projectId)[0]!;
    expect(await publish(on, turn(on, { message: "One agent.", draft: draft("none") }).cardIds[0]!)).toMatchObject({ ok: true, data: { saved: true } });

    // Named again, by name alone: the card says which team, and declares nothing.
    const named = turn(on, { message: "Back to the leads.", draft: draft("Review leads") });
    const namedBody = cardBody(on, named.cardIds[0]!);
    expect(namedBody).toContain('Team: one agent → "Review leads"');
    expect(namedBody).not.toContain("**Teams**");
    expect(await publish(on, named.cardIds[0]!)).toMatchObject({ ok: true, data: { saved: true } });
    expect(listStepsForPipeline(handle.db, pipelineId).find((step) => step.id === checkId)?.teamId).toBe(team.id);

    // Changed, under its own name: the team's next version, the step's team unchanged.
    const changed = turn(on, { message: "Three rounds.", draft: draft(undefined, [{ ...LEADER(), limits: { maxParticipants: 3, maxRounds: 3 } }]) });
    expect(changed.rejections).toEqual([]);
    expect(cardBody(on, changed.cardIds[0]!)).toContain('- Changed: "Review leads", a leader-led team of report-only members');
    expect(await publish(on, changed.cardIds[0]!)).toMatchObject({ ok: true, data: { saved: true } });
    expect(getTeam(handle.db, team.id)).toMatchObject({ version: 2, definition: expect.objectContaining({ limits: expect.objectContaining({ maxRounds: 3 }) }) });
    expect(listTeamVersions(handle.db, team.id).map((version) => version.author.kind)).toEqual(["assistant", "assistant"]);
    expect(teamOnCheck()?.coordination === "leader" && teamOnCheck()).toMatchObject({ limits: { maxRounds: 3 } });
  });

  it("refuses a change to a team a person locked before any card is offered, as Publish and the editor's check do (EO-881)", async () => {
    const on = await conversation();
    expect(await publish(on, turn(on, { message: "Led.", draft: draft("Review leads", [LEADER()]) }).cardIds[0]!)).toMatchObject({ ok: true, data: { saved: true } });
    const team = listTeams(handle.db, projectId)[0]!;
    expect(setTeamLocked(handle.db, team.id, true).ok).toBe(true);
    const locked = 'The team "Review leads" is locked: a person must unlock it before this draft can change it.';

    const changed = turn(on, { message: "Three rounds.", draft: draft(undefined, [{ ...LEADER(), limits: { maxParticipants: 3, maxRounds: 3 } }]) });
    expect(changed.cardIds).toEqual([]);
    expect(changed.rejections.join(" ")).toContain(locked);

    // The editor's check says the same of what Publish would send.
    const changedTeam = { ...getTeam(handle.db, team.id)!.definition!, limits: { ...getTeam(handle.db, team.id)!.definition!.limits, maxRounds: 3 } };
    const checked = await handleIpcRequest("pipeline:validate", { ...graphNow(), teams: [{ id: team.id, definition: changedTeam }] }, (payload) => validatePipelineCommand(handle.db, payload), opts);
    expect(JSON.stringify(checked)).toContain(locked.replaceAll('"', '\\"'));

    // Naming the locked team unchanged is no change to it.
    expect(turn(on, { message: "Again.", draft: draft("Review leads", [LEADER()]) }).rejections.join(" ")).not.toContain("is locked");
    expect(getTeam(handle.db, team.id)?.version).toBe(1);
  });

  it("refuses Publish of a card whose team a person locked after it was offered, and writes nothing (EO-881)", async () => {
    const on = await conversation();
    expect(await publish(on, turn(on, { message: "Led.", draft: draft("Review leads", [LEADER()]) }).cardIds[0]!)).toMatchObject({ ok: true, data: { saved: true } });
    const team = listTeams(handle.db, projectId)[0]!;

    const changed = turn(on, { message: "Three rounds.", draft: draft(undefined, [{ ...LEADER(), limits: { maxParticipants: 3, maxRounds: 3 } }]) });
    expect(changed.cardIds).toHaveLength(1);
    // What the card's Publish sends, read while it still applied.
    const read = readAssistDraftForPublish(handle.db, { conversationId: on.id, messageId: changed.cardIds[0]! });
    expect(read.problem).toBeNull();
    expect(setTeamLocked(handle.db, team.id, true).ok).toBe(true);
    const locked = 'The team "Review leads" is locked: a person must unlock it before this draft can change it.';

    // Read again, the card no longer applies; and what it sent is refused by the save.
    expect(readAssistDraftForPublish(handle.db, { conversationId: on.id, messageId: changed.cardIds[0]! }).problem).toContain(locked);
    const answer = await handleIpcRequest(
      "pipeline:save",
      { pipelineId: read.pipelineId, steps: read.steps, routes: read.routes, entryStepId: read.entryStepId, teams: read.teams },
      (payload) => savePipeline(handle.db, undefined, payload),
      opts,
    );
    expect(answer).toMatchObject({ ok: true, data: { saved: false } });
    expect(JSON.stringify(answer)).toContain(locked.replaceAll('"', '\\"'));
    expect(getTeam(handle.db, team.id)?.version).toBe(1);
  });

  it("refuses two draft teams of one name, as names are read, before any card is offered — and Publish refuses them alike (EO-881)", async () => {
    const on = await conversation();
    const twice = turn(on, { message: "Two teams.", draft: draft("Review leads", [LEADER(), { ...INDEPENDENT(), name: "  review LEADS " }]) });
    expect(twice.cardIds).toEqual([]);
    expect(twice.rejections.join(" ")).toContain('Two teams are called "review LEADS": each of a project\'s teams needs a name of its own.');

    // What Publish would be sent for the same two teams is refused, and nothing is written.
    const definition = (name: string) =>
      TeamDefinitionSchema.parse({
        name,
        coordination: "leader",
        leader: { agentId: agentOfKind(handle.db, "reviewer"), instructions: "Split the review by risk." },
        members: [{ agentId: agentOfKind(handle.db, "implementer") }],
        limits: { maxParticipants: 3, maxRounds: 2 },
      });
    const saved = await handleIpcRequest(
      "pipeline:save",
      { ...graphNow(), teams: [{ id: uuidv7(), definition: definition("Review leads") }, { id: uuidv7(), definition: definition("review leads") }] },
      (payload) => savePipeline(handle.db, undefined, payload),
      opts,
    );
    expect(saved).toMatchObject({ ok: true, data: { saved: false } });
    expect(JSON.stringify(saved)).toContain("Two teams are called");
    expect(listTeams(handle.db, projectId)).toEqual([]);
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
    const team = { ...INDEPENDENT(), completion: { rules: [{ when: "any", outcomes: ["concerns"], result: "fail" }], fallback: "pass" } };
    const { cardIds, rejections } = turn(on, {
      message: "Check answers a verdict the team can give.",
      draft: draft("Change review", [team], { entryAction: "team_verdict" }, [
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
    async function refused(team: { name: string } & Record<string, unknown>, check: Record<string, unknown> = {}, routes?: { resultKey: string; label: string }[]) {
      const on = await conversation();
      const posted = turn(on, { message: "A team.", draft: draft(team.name, [team], check, routes) });
      expect(posted.cardIds).toEqual([]);
      expect(posted.rejections).toHaveLength(1);
      expect(teamOnCheck()).toBeNull();
      return posted.rejections[0]!;
    }

    it("an independent team on a pack's action, whose answer the pack shapes", async () => {
      const reason = await refused(INDEPENDENT(), { entryAction: "review" }, [
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
      expect(await refused(INDEPENDENT(), { entryAction: "audit" })).toMatch(/also requires "findings"\. Use a leader-led team/);
    });

    it("a completion result the action does not return", async () => {
      const team = { ...INDEPENDENT(), completion: { rules: [], fallback: "merged" } };
      expect(await refused(team)).toContain(`can decide "merged", which "check" cannot return`);
    });

    it("a member nobody here is", async () => {
      expect(await refused({ ...LEADER(), members: [{ agent: "Auditor" }] })).toContain(`"Check" runs as the team "Review leads": A member is an agent EO does not have (Auditor).`);
    });

    it("EO's system agent as a member (EO-881)", async () => {
      expect(await refused({ ...LEADER(), members: [{ agent: nameOf("system") }] })).toContain(`is EO's system agent, which administers EO and can never be a team member.`);
    });

    it("a leader whose kind lacks the step's action (EO-881)", async () => {
      const reason = await refused({ ...LEADER(), leader: { agent: nameOf("implementer"), instructions: "Lead." }, members: [{ agent: nameOf("reviewer") }] });
      expect(reason).toContain(`"Check" runs as the team "Review leads", whose leader "${nameOf("implementer")}" is a implementer agent, and that kind has no "check" action to answer.`);
    });

    it("a role an agent of which EO could not hold to report-only", async () => {
      const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
      updateAgent(handle.db, implementer.id, { config: { inheritAmbientConfig: true } });
      expect(await refused(INDEPENDENT())).toContain(`could be staffed by a "implementer" agent EO cannot hold to report-only: ${implementer.name} uses the person's own setup`);
    });

    it("a role an agent of which runs its own executable, whose version EO cannot vouch for (EO-850)", async () => {
      const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
      updateAgent(handle.db, implementer.id, { config: { executablePath: "/opt/claude/bin/claude" } });
      expect(await refused(INDEPENDENT())).toContain(`${implementer.name} runs its own Claude executable, whose version EO cannot vouch for`);
    });

    it("a team on a step that is not an agent's", async () => {
      const reason = await refused(INDEPENDENT(), { type: "user", agent: null, entryAction: null });
      expect(reason).toContain(`"Check" runs as the team "Change review", but only a step an agent does can run as a team.`);
    });

    it("a team no step names, with EO's system agent in it, judged as Publish judges it (EO-881)", async () => {
      const on = await conversation();
      const posted = turn(on, { message: "A team.", draft: draft(undefined, [{ ...LEADER(), members: [{ agent: nameOf("system") }] }]) });
      expect(posted.cardIds).toEqual([]);
      expect(posted.rejections).toHaveLength(1);
      expect(posted.rejections[0]).toContain(`The team "Review leads": "${nameOf("system")}" is EO's system agent, which administers EO and can never be a team member.`);
      expect(listTeams(handle.db, projectId)).toEqual([]);
    });

    it("a change to a team another pipeline's step names that would leave that step refused, naming that pipeline (EO-881)", async () => {
      const on = await conversation();
      expect(await publish(on, turn(on, { message: "Led.", draft: draft("Review leads", [LEADER()]) }).cardIds[0]!)).toMatchObject({ ok: true, data: { saved: true } });
      const team = listTeams(handle.db, projectId)[0]!;
      const gates = createPipeline(handle.db, { projectId, name: "Gates" }).id as Uuid;
      const gate = createStep(handle.db, { pipelineId: gates, position: 0, name: "Gate", type: "agent", agentId: agentOfKind(handle.db, "reviewer"), entryAction: "check", teamId: team.id });
      setEntryStep(handle.db, gates, gate.id);

      // Check stops being a team, so only Gate is left naming it — and Gate could not run a leader without `check`.
      const changed = { ...LEADER(), leader: { agent: nameOf("implementer"), instructions: "Lead." }, members: [{ agent: nameOf("reviewer") }] };
      const posted = turn(on, { message: "Led by the implementer.", draft: draft("none", [changed]) });
      expect(posted.cardIds).toEqual([]);
      expect(posted.rejections[0]).toContain(
        `In the pipeline "Gates", which names the same team: "Gate" runs as the team "Review leads", whose leader "${nameOf("implementer")}" is a implementer agent, and that kind has no "check" action to answer.`,
      );
      expect(getTeam(handle.db, team.id)?.version).toBe(1);
    });

    it("a team past its own limits", async () => {
      const on = await conversation();
      // The schema refuses it in the turn, before anything is drawn.
      expect(() => turn(on, { message: "Big.", draft: draft("Change review", [{ ...INDEPENDENT(), limits: { maxParallel: 9 } }]) })).toThrow();
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
      const { cardIds } = turn(on, { message: "A team.", draft: draft("Change review", [INDEPENDENT()]) });
      stopBeingAReplica = markReplica(handle.db, () => true);
      publishSection(handle.db, { section: "pipelines", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });

      const answer = await publish(on, cardIds[0]!);
      expect(answer.ok).toBe(false);
      expect(JSON.stringify(answer)).toContain("pipelines");
      expect(teamOnCheck()).toBeNull();
    });

    it("refuses a team's custom action where the agents section is managed: neither the definition nor the team is written", async () => {
      const on = await conversation();
      const team = { ...INDEPENDENT(), completion: { rules: [{ when: "any", outcomes: ["concerns"], result: "fail" }], fallback: "pass" } };
      const { cardIds } = turn(on, {
        message: "With its own action.",
        draft: draft("Change review", [team], { entryAction: "team_verdict" }, [
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
      expect(listTeams(handle.db, projectId)).toEqual([]);
    });
  });

  it("files a new version for a changed team, and leaves work on the old version — and a session already running — with the team it entered on", async () => {
    const on = await conversation();
    const first = turn(on, { message: "Led.", draft: draft("Review leads", [LEADER()]) });
    expect(await publish(on, first.cardIds[0]!)).toMatchObject({ ok: true, data: { saved: true } });
    const entered = currentVersion(handle.db, pipelineId)!;

    // An item enters on that version, and its team starts.
    const item = createTestItem(handle.db, { type: "story", projectId, pipelineId, stepId: checkId as Uuid, title: "Harden login" });
    expect(getItem(handle.db, item.id)!.pipelineVersionId).toBe(entered.id);
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: checkId, team: LEADER_RUNS, runId: null, now: Date.now() });

    const second = turn(on, { message: "Independent now.", draft: draft("Change review", [INDEPENDENT()]) });
    expect(await publish(on, second.cardIds[0]!)).toMatchObject({ ok: true, data: { saved: true } });
    expect(currentVersion(handle.db, pipelineId)!.number).toBe(entered.number + 1);
    expect(teamOnCheck()?.coordination).toBe("independent");

    // The item still runs Check as its own version had it, and the open session keeps the team it was opened with.
    const step = stepForItem(handle.db, getItem(handle.db, item.id)!);
    expect(step?.team).toEqual(LEADER_RUNS satisfies StepTeam);
    expect(getTeamSession(handle.db, session.id)?.team).toEqual(LEADER_RUNS);
    expect(getTeamSession(handle.db, session.id)?.status).toBe("open");
  });
});
