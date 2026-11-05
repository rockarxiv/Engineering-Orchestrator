import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_MCP_SERVER_NAME,
  adminToolsEnabled,
  AssistOutputSchema,
  type Agent,
  type AssistReply,
  pageDescriptorFor,
  type IpcChannel,
  type StepInputs,
  type IpcResponse,
  type Item,
  type UpdateConflictDetail,
  type Uuid,
} from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  appendRunEvent,
  createPerson,
  createPipeline,
  createRun,
  createStep,
  getItem,
  getPipelineOrigin,
  getUpdateConflict,
  listAgents,
  listCommentsForItem,
  listMentionsForComment,
  listPipelineVersions,
  listRoutesForPipeline,
  listStepsForPipeline,
  openUpdateConflict,
  replacePipelineGraph,
  resolveUpdateConflict,
  updateRun,
} from "../db/repos/index.js";
import { editsSinceBase } from "../gallery/updateConflictDetail.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createBuiltinRunners } from "../packs/developer/builtins.js";
import { checkRun, fakeGh, gitHubState } from "../packs/developer/forge/testForges.js";
import type { BuiltinContext } from "../supervisor/builtins.js";
import { loadTemplateHistory } from "../gallery/history.js";
import { backfillPipelineOrigins } from "../gallery/origins.js";
import { applyTemplateUpdates } from "../gallery/templateUpdates.js";
import { TOOLS } from "../mcpHost/catalog.js";
import { createFakeProvider } from "../providers/fake.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { fakePlatform } from "../testing/platform.js";
import { clearPublishedView } from "./currentView.js";
import { clearHandlerRegistry, dispatchIpc } from "./registry.js";

/**
 * The assistant reads a held template update and proposes merged drafts
 * (EO-534), and the person resolves it.
 *
 * Against EO's own Delivery, customised before EO-461 so Merge Request's
 * `opened` goes to a Merge pipeline's `merge_pr` — the shape whose 1.1 and 1.2
 * update EO-532 holds on exactly that route. Driven through the app's own
 * handlers: the tool through the catalog, the turn through the
 * supervisor with the fake provider, Publish as the draft card does it,
 * and Keep my pipeline through the card's button.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const ADMIN = (tool: string) => `mcp__${ADMIN_MCP_SERVER_NAME}__${tool}`;

let handle: DbHandle;

beforeEach(async () => {
  handle = openMigratedTestDb();
  const { registerAllHandlers } = await import("./handlers.js");
  registerAllHandlers(handle.db, undefined, { platform: fakePlatform() });
});

afterEach(() => {
  clearHandlerRegistry();
  clearPublishedView();
  handle.close();
});

async function call<K extends IpcChannel>(channel: K, payload: unknown): Promise<IpcResponse<K>> {
  const answer = await dispatchIpc(channel, payload);
  if (!answer.ok) throw new Error(`${channel} refused: ${answer.error.message}`);
  return answer.data as IpcResponse<K>;
}

/** EO's own Delivery with its 1.2 update held, and the notice posted on the adopting project's thread. */
function heldUpdate(): { conflictId: string; noticeId: string } {
  // The Merge pipeline is the project's own, as EO's is: a route hands
  // work only to a step of another of the project's pipelines.
  const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
  const merge = createPipeline(handle.db, { projectId: shop.id, name: "Merge" });
  createStep(handle.db, { id: "merge_pr", pipelineId: merge.id as Uuid, position: 0, name: "Merge PR", type: "user" });
  createStep(handle.db, { pipelineId: merge.id as Uuid, position: 1, name: "Merged", type: "user", isTerminal: true });
  handle.db.run(sql`DELETE FROM step_routes WHERE from_step_id = 'pull_request_watch'`);
  handle.db.run(sql`UPDATE pipeline_steps SET retired_version = 1 WHERE id = 'pull_request_watch'`);
  handle.db.run(sql`UPDATE step_routes SET target = 'merge_pr' WHERE from_step_id = 'merge_request' AND result_key = 'opened'`);
  const history = loadTemplateHistory(GALLERY_DIRECTORY);
  backfillPipelineOrigins(handle.db, history);
  handle.db.run(sql`UPDATE pipelines SET project_id = ${shop.id} WHERE id = 'default'`);
  applyTemplateUpdates(handle.db, history, { isTheRecord: false });
  const conflict = openUpdateConflict(handle.db, "default")!;
  return { conflictId: conflict.id, noticeId: conflict.noticeCommentIds[0]! };
}

/** The tool, called as the system agent's client calls it. */
async function readConflict(pipelineId = "default") {
  const tool = TOOLS.find((entry) => entry.name === "pipeline_update_conflict")!;
  const outcome = await tool.run(dispatchIpc, { pipelineId });
  if (!outcome.ok) throw new Error(outcome.message);
  return { text: outcome.text, refused: outcome.refused, data: outcome.data as IpcResponse<"pipeline:updateConflict"> };
}

async function pipelineGetText(pipelineId = "default"): Promise<string> {
  const outcome = await TOOLS.find((entry) => entry.name === "pipeline_get")!.run(dispatchIpc, { pipelineId });
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.text;
}

const graphOf = (pipelineId = "default") => ({
  steps: listStepsForPipeline(handle.db, pipelineId)
    .filter((step) => !step.offBoard)
    .map(({ id, type, entryAction, ownerRole, watch, inputs, results, name, position }) => ({ id, type, entryAction, ownerRole, watch, inputs, results, name, position })),
  routes: listRoutesForPipeline(handle.db, pipelineId).map(({ fromStepId, resultKey, target, label, tone }) => ({ fromStepId, resultKey, target, label, tone })),
});

/** What the recommendation sets on Watching pull request: ready, and ready on the forge's word that it can merge. */
const READY_WHEN_MERGEABLE = { reportReady: true, readyWhen: "mergeable" };

/**
 * What the shipped `watch_pull_request` answers, run with these inputs,
 * for a pull request whose checks are green, that the forge says it can
 * merge, and that nobody approved — EO's own pull requests, opened and
 * merged by one account the forge will not let approve its own.
 */
async function watchAnswer(inputs: StepInputs): Promise<string> {
  const repository = attachWorkspace(handle.db, { name: "acme-api", keyPrefix: "API", repoPath: "/nonexistent/acme-api" });
  const item = createTestItem(handle.db, { type: "story", title: "Watched", stepId: "todo", workspaceId: repository.id, git: { branch: "eo/API-1", pullRequest: "https://github.com/acme/api/pull/7" } });
  const gh = fakeGh(() => gitHubState({ pr: { reviewDecision: "", mergeStateStatus: "CLEAN" }, checkRuns: [checkRun(14, "e2e", "completed", "success")] })).run;
  const context: BuiltinContext = {
    db: handle.db,
    item,
    prepareWorkspace: () => {
      throw new Error("watching a pull request needs nowhere to work");
    },
    report: () => {},
    runId: createRun(handle.db, { itemId: item.id, agentId: null, action: "watch_pull_request", status: "running", provider: "builtin" }).id,
    inputs,
    ensureRun: () => {},
  };
  const answer = await createBuiltinRunners(undefined, undefined, undefined, gh).watch_pull_request(context);
  return answer.ok ? answer.result : `not ok: ${answer.reason}`;
}

type ConflictGraph = UpdateConflictDetail["current"];
type DraftOf = NonNullable<AssistReply["draft"]>;

/** A step as a draft names it: what it is, with its settings left to the step unless given. */
function draftStep(step: ConflictGraph["steps"][number], position: number, settings: Record<string, unknown> = {}) {
  const { id, name, type, ownerRole, entryAction, instructionsSummary, isTerminal, planMode } = step;
  return { id, position, name, type, ownerRole, entryAction, instructionsSummary, isTerminal, planMode, ...settings };
}

const draftRoute = ({ fromStepId, resultKey, label, tone, target }: ConflictGraph["routes"][number], position: number) => ({ fromStepId, resultKey, label, tone, target, position });

/**
 * The recommended resolution, built from nothing but what the tool said:
 * the person's pipeline, with the template's new step put in front of the
 * person's own destination. `opened` → Watching pull request, and its
 * `ready` → `merge_pr`, with `reportReady` on — and `readyWhen:
 * "mergeable"`, since EO's pull requests are never approved on the forge
 * and `ready` would otherwise never come.
 */
function recommendedDraft(conflict: UpdateConflictDetail): DraftOf {
  const opened = conflict.changes.find((change) => change.changedBy === "conflict" && change.key.kind === "route" && change.key.resultKey === "opened")!;
  const mine = (opened.current as { target: string }).target;
  const added = conflict.changes.find((change) => change.changedBy === "template" && change.key.kind === "step")!;
  const watchId = (added.key as { stepId: string }).stepId;
  const watch = conflict.template.steps.find((step) => step.id === watchId)!;

  const steps = [...conflict.current.steps].sort((a, b) => a.position - b.position);
  const at = steps.findIndex((step) => step.id === (opened.key as { fromStepId: string }).fromStepId) + 1;
  const ordered = [...steps.slice(0, at), watch, ...steps.slice(at)];
  return {
    rationale: "Keeps your automatic squash merge (Merge PR) and adds the template's Watching pull request in front of it, so failed checks and review comments go back for autofix.",
    entryStepId: conflict.current.entryStepId!,
    steps: ordered.map((step, index) =>
      step.id === watchId ? draftStep(step, index, { watch: watch.watch ?? { everyMinutes: 5, giveUpAfterHours: 168 }, inputs: READY_WHEN_MERGEABLE }) : draftStep(step, index),
    ),
    // The template's routes out of its new step, with `ready` sent on to
    // the person's own destination.
    routes: [
      ...conflict.current.routes.map((route) => (route.fromStepId === "merge_request" && route.resultKey === "opened" ? { ...route, target: watchId } : route)),
      ...conflict.template.routes.filter((route) => route.fromStepId === watchId).map((route) => (route.resultKey === "ready" ? { ...route, target: mine } : route)),
    ].map(draftRoute),
    target: { pipelineId: conflict.pipelineId },
  } as DraftOf;
}

/** The plain take-the-template option: the new version as it ships. */
function templateDraft(conflict: UpdateConflictDetail): DraftOf {
  const steps = [...conflict.template.steps].sort((a, b) => a.position - b.position);
  return {
    rationale: "Takes the template's 1.2 as it ships: Merge Request goes to Watching pull request, and your route to Merge PR is set aside.",
    entryStepId: conflict.template.entryStepId!,
    steps: steps.map((step, index) => draftStep(step, index, step.watch === null ? {} : { watch: step.watch })),
    routes: conflict.template.routes.map(draftRoute),
    target: { pipelineId: conflict.pipelineId },
  } as DraftOf;
}

/** The reply the assistant gives: the recommendation, take the template, and Keep my pipeline. */
function resolutionReply(conflict: UpdateConflictDetail): AssistReply {
  return {
    message: "Three ways to resolve it. I recommend the first: it keeps your squash merge and adds autofix.",
    draft: recommendedDraft(conflict),
    alternatives: [templateDraft(conflict)],
    card: { kind: "pipelineKeepMine", pipelineId: conflict.pipelineId },
  };
}

/** Fix with assistant, pressed: the chat, with EO's brief as its first message. */
async function openChat(conflictId: string, noticeId: string): Promise<Item> {
  const opened = await call("assist:openUpdateConflict", { conflictId, commentId: noticeId });
  return getItem(handle.db, opened.conversation!.id as Uuid)!;
}

/**
 * The assistant's first turn, with the fake provider: it reads the
 * conflict with the tool and the pipeline with pipeline_get, then answers
 * with `reply`.
 */
async function scriptedTurn(reply: AssistReply, toolAnswer: string, pipelineAnswer: string): Promise<void> {
  const fake = createFakeProvider({
    steps: [
      { toolCall: { name: ADMIN("pipeline_update_conflict"), args: { pipelineId: "default" }, answer: toolAnswer } },
      { toolCall: { name: ADMIN("pipeline_get"), args: { pipelineId: "default" }, answer: pipelineAnswer } },
      { output: "I have the three versions." },
    ],
    result: reply,
  });
  const supervisor = createRunSupervisor({
    db: handle.db,
    provider: fake,
    limits: LIMITS,
    onRunSucceeded: (item: Item, agent: Agent, action: string, parsedResult: unknown, runId: Uuid): void => {
      if (action === ASSIST_ACTION) postAssistReply(handle.db, item, agent.id, runId, parsedResult);
    },
  });
  await supervisor.runOnce();
}

/** The cards a chat's newest turn posted, and the reasons for any it could not. */
function postedCards(chat: Item): { cards: Uuid[]; rejections: string[] } {
  const said = listCommentsForItem(handle.db, chat.id).filter((comment) => comment.authorType === "agent");
  const runId = said.at(-1)?.runId;
  const ofRun = said.filter((comment) => comment.runId === runId);
  return { cards: ofRun.filter((comment) => comment.kind === PROPOSAL_KIND).map((comment) => comment.id), rejections: ofRun.filter((comment) => comment.kind === "rejection").map((comment) => comment.body) };
}

/** A turn posted directly, as the supervisor would on success. */
function turn(chat: Item, reply: AssistReply, readPipeline = "default"): void {
  const parsed = AssistOutputSchema.parse(reply);
  const agent = assistAgent(handle.db)!;
  const run = createRun(handle.db, { itemId: chat.id, agentId: agent.id, action: ASSIST_ACTION, initiationId: listCommentsForItem(handle.db, chat.id)[0]!.id });
  appendRunEvent(handle.db, run.id, "tool_call", { name: ADMIN("pipeline_get"), args: { pipelineId: readPipeline }, callId: "call-0" });
  appendRunEvent(handle.db, run.id, "tool_result", { name: ADMIN("pipeline_get"), callId: "call-0", ok: true, output: "", truncated: false });
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(parsed), parsed } });
  postAssistReply(handle.db, chat, agent.id, run.id, parsed);
}

/** Publish, as the draft card's button does it (`renderer/src/shared/assist/draft.ts`). */
async function publish(chat: Item, cardId: string) {
  const read = await call("assist:draft", { conversationId: chat.id, messageId: cardId });
  expect(read.problem).toBeNull();
  const saved = await call("pipeline:save", { pipelineId: read.pipelineId, steps: read.steps, routes: read.routes, entryStepId: read.entryStepId });
  expect(saved.saved).toBe(true);
  const resolved = read.updateConflictId === null ? null : await call("assist:draftPublished", { conversationId: chat.id, messageId: cardId });
  return { read, resolved };
}

describe("pipeline_update_conflict", () => {
  it("answers with the versions, the release notes, the three graphs and every changed key with its three values and side, conflicts first", async () => {
    const { conflictId } = heldUpdate();

    const { data, text, refused } = await readConflict();

    expect(refused).toBe(false);
    const conflict = data.conflict!;
    expect(conflict).toMatchObject({ conflictId, pipelineId: "default", pipelineName: "Delivery", templateSlug: "software-feature-to-merge", fromVersion: "1.0", toVersion: "1.2" });
    expect(conflict.releaseNotes).toContain("1.1: Adds Watching pull request after Merge Request");
    expect(conflict.releaseNotes).toContain("1.2: Watching pull request no longer gives up");
    // The three graphs, each in the pipeline's own ids.
    const target = (graph: ConflictGraph) => graph.routes.find((route) => route.fromStepId === "merge_request" && route.resultKey === "opened")?.target;
    expect(target(conflict.base)).toBe("ready_to_merge");
    expect(target(conflict.current)).toBe("merge_pr");
    expect(target(conflict.template)).toBe("pull_request_watch");
    expect(conflict.base.steps.some((step) => step.id === "pull_request_watch")).toBe(false);
    expect(conflict.current.steps.some((step) => step.id === "pull_request_watch")).toBe(false);
    expect(conflict.template.steps.find((step) => step.id === "pull_request_watch")).toMatchObject({ entryAction: "watch_pull_request", watch: { everyMinutes: 5, giveUpAfterHours: 168 } });
    expect(conflict.current.entryStepId).toBe("worktree");

    // Conflicts first, then every other key with the side that changed it.
    expect(conflict.changes[0]).toMatchObject({
      key: { kind: "route", fromStepId: "merge_request", resultKey: "opened" },
      changedBy: "conflict",
      base: { target: "ready_to_merge" },
      current: { target: "merge_pr" },
      template: { target: "pull_request_watch" },
    });
    expect(conflict.changes.filter((change) => change.changedBy === "conflict")).toHaveLength(1);
    expect(conflict.changes.find((change) => change.key.kind === "step" && change.key.stepId === "pull_request_watch")).toMatchObject({ changedBy: "template", base: null, current: null });
    expect(conflict.changes.filter((change) => change.changedBy === "template" && change.key.kind === "route").map((change) => (change.key as { resultKey: string }).resultKey)).toContain("merged");
    expect(conflict.changes[0]!.description).toContain("**Merge Request**'s 'opened' route");
    expect(conflict.takenStepIds).toEqual([]);

    // Said as text too, with the same facts.
    expect(text).toContain('"Delivery" (id: default) holds the Software feature to merge template\'s update (software-feature-to-merge) from 1.0, its base, to 1.2.');
    expect(text).toContain("[conflict] **Merge Request**'s 'opened' route");
    expect(text).toContain("The person's edits since the base");
  });

  it("lists the person's own edits since the base — who changed what, and when — and not the template's", async () => {
    heldUpdate();
    const dana = createPerson(handle.db, { name: "Dana" });
    const steps = listStepsForPipeline(handle.db, "default").filter((step) => !step.offBoard);
    const routes = listRoutesForPipeline(handle.db, "default");
    replacePipelineGraph(
      handle.db,
      "default",
      steps.map(({ ownerPersonId: _person, ownerGroupId: _group, ...step }) => (step.id === "review" ? { ...step, name: "Code review" } : step)),
      routes.map(({ id: _id, ...route }) => route),
      { createdBy: dana.id },
    );

    const { data } = await readConflict();

    const edits = data.conflict!.edits;
    const danas = edits.filter((edit) => edit.createdBy === dana.id);
    expect(danas).toHaveLength(1);
    expect(danas[0]).toMatchObject({ createdByName: "Dana" });
    expect(danas[0]!.changes.join("\n")).toContain("Changed **Code review**: name Review → Code review");
    expect(danas[0]!.createdAt).toBeGreaterThan(0);
    expect(edits.every((edit) => !(edit.createdBy ?? "").startsWith("template:"))).toBe(true);
    // In version order, so "since the base" reads oldest first.
    expect(edits.map((edit) => edit.version)).toEqual([...edits.map((edit) => edit.version)].sort((a, b) => a - b));
  });

  it("is read-only: asking writes nothing and resolves nothing", async () => {
    const { conflictId } = heldUpdate();
    const before = { conflict: getUpdateConflict(handle.db, conflictId), origin: getPipelineOrigin(handle.db, "default"), graph: graphOf(), versions: listPipelineVersions(handle.db, "default") };

    await readConflict();
    await readConflict();

    expect(getUpdateConflict(handle.db, conflictId)).toEqual(before.conflict);
    expect(getPipelineOrigin(handle.db, "default")).toEqual(before.origin);
    expect(graphOf()).toEqual(before.graph);
    expect(listPipelineVersions(handle.db, "default")).toEqual(before.versions);
    const tool = TOOLS.find((entry) => entry.name === "pipeline_update_conflict")!;
    expect(tool.kind).toBe("read");
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("is served on EO's administrative server, which only the system agent is given", () => {
    expect(TOOLS.some((tool) => tool.name === "pipeline_update_conflict")).toBe(true);
    expect(
      listAgents(handle.db)
        .filter((agent) => adminToolsEnabled(agent))
        .map((agent) => agent.role),
    ).toEqual(["system"]);
  });

  it("refuses, saying so, for a pipeline with no held update", async () => {
    const history = loadTemplateHistory(GALLERY_DIRECTORY);
    backfillPipelineOrigins(handle.db, history);

    const { data, refused, text } = await readConflict();

    expect(refused).toBe(true);
    expect(data.conflict).toBeNull();
    expect(text).toBe('"Delivery" has no held template update: nothing is waiting to be resolved.');
  });
});

describe("resolving a held update from its chat", () => {
  it("a scripted turn using the tool produces the recommended draft for EO's Delivery, which passes validatePipeline; publishing it resolves the conflict and moves the base", async () => {
    const { conflictId, noticeId } = heldUpdate();
    const chat = await openChat(conflictId, noticeId);
    const { data, text } = await readConflict();
    const reply = resolutionReply(data.conflict!);

    await scriptedTurn(reply, text, await pipelineGetText());

    // Three options: the recommendation, take the template, and Keep my pipeline.
    const { cards, rejections } = postedCards(chat);
    expect(rejections).toEqual([]);
    expect(cards).toHaveLength(3);
    const view = await call("assist:open", undefined);
    expect(view.conversation.id).toBe(chat.id);
    expect(cards.map((id) => view.conversation.messages.find((message) => message.id === id)?.approves)).toEqual(["pipeline", "pipeline", "card"]);
    // Each card says in one line what it keeps.
    expect(view.conversation.messages.find((message) => message.id === cards[0])!.body).toContain("Keeps your automatic squash merge");

    // Both drafts pass validatePipeline as they would be published.
    for (const cardId of cards.slice(0, 2)) {
      const read = await call("assist:draft", { conversationId: chat.id, messageId: cardId });
      expect(read.problem).toBeNull();
      expect(read.updateConflictId).toBe(conflictId);
      const problems = await call("pipeline:validate", { pipelineId: "default", steps: read.steps, routes: read.routes, entryStepId: read.entryStepId });
      expect(problems.problems.filter((problem) => problem.severity === "error")).toEqual([]);
    }

    const recommended = await call("assist:draft", { conversationId: chat.id, messageId: cards[0]! });
    const watch = recommended.steps.find((step) => step.id === "pull_request_watch")!;
    expect(watch).toMatchObject({ entryAction: "watch_pull_request", inputs: READY_WHEN_MERGEABLE });
    const routeOf = (from: string, key: string) => recommended.routes.find((route) => route.fromStepId === from && route.resultKey === key)?.target;
    expect(routeOf("merge_request", "opened")).toBe("pull_request_watch");
    expect(routeOf("pull_request_watch", "ready")).toBe("merge_pr");

    // Published from the chat that holds the conflict.
    const { resolved } = await publish(chat, cards[0]!);

    expect(resolved).toEqual({ resolved: true, problem: null });
    const conflict = getUpdateConflict(handle.db, conflictId)!;
    expect(conflict.resolution).toBe("published");
    expect(conflict.resolvedAt).not.toBeNull();
    const origin = getPipelineOrigin(handle.db, "default")!;
    expect(origin.version).toBe("1.2");
    expect(origin.baseId).toBe(conflict.templateId);
    expect(origin.stepIds["pull_request_watch"]).toBe("pull_request_watch");
    // The graph is the draft's.
    const live = graphOf();
    expect(live.routes.find((route) => route.fromStepId === "merge_request" && route.resultKey === "opened")?.target).toBe("pull_request_watch");
    expect(live.routes.find((route) => route.fromStepId === "pull_request_watch" && route.resultKey === "ready")?.target).toBe("merge_pr");
    expect(live.steps.find((step) => step.id === "pull_request_watch")?.inputs).toEqual(READY_WHEN_MERGEABLE);
    // And it reaches Merge PR at run time: the watch, run with the inputs
    // it was published with, answers `ready` for a green pull request
    // nobody approved — which is every one of EO's.
    expect(await watchAnswer(live.steps.find((step) => step.id === "pull_request_watch")!.inputs)).toBe("ready");
    // The notice closes.
    expect(listMentionsForComment(handle.db, noticeId as Uuid).map((mention) => mention.status)).not.toContain("open");
    // And the same conflict is never raised again.
    expect(applyTemplateUpdates(handle.db, loadTemplateHistory(GALLERY_DIRECTORY), { isTheRecord: false })).toEqual([]);
    expect(openUpdateConflict(handle.db, "default")).toBeUndefined();
  });

  it("publishes the take-the-template draft just as well, and resolves with it", async () => {
    const { conflictId, noticeId } = heldUpdate();
    const chat = await openChat(conflictId, noticeId);
    turn(chat, resolutionReply((await readConflict()).data.conflict!));
    const { cards } = postedCards(chat);

    const { resolved } = await publish(chat, cards[1]!);

    expect(resolved).toEqual({ resolved: true, problem: null });
    expect(graphOf().routes.find((route) => route.fromStepId === "merge_request" && route.resultKey === "opened")?.target).toBe("pull_request_watch");
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.2");
  });

  it("does not believe a draft was published until the pipeline is that draft", async () => {
    const { conflictId, noticeId } = heldUpdate();
    const chat = await openChat(conflictId, noticeId);
    turn(chat, resolutionReply((await readConflict()).data.conflict!));
    const { cards } = postedCards(chat);

    const claimed = await call("assist:draftPublished", { conversationId: chat.id, messageId: cards[0]! });

    expect(claimed.resolved).toBe(false);
    expect(claimed.problem).toContain("The template update is still held");
    expect(getUpdateConflict(handle.db, conflictId)?.resolvedAt).toBeNull();
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.0");
  });

  it("resolves nothing when a draft is published from a chat that holds no conflict", async () => {
    heldUpdate();
    const sent = await call("assist:send", { page: pageDescriptorFor("/pipelines/default"), conversationId: null, body: "Tidy this up", attachmentIds: [], interrupt: false });
    const chat = getItem(handle.db, sent.conversation.id as Uuid)!;
    const conflict = (await readConflict()).data.conflict!;
    turn(chat, { message: "Here.", draft: recommendedDraft(conflict) });
    const { cards } = postedCards(chat);

    const { read } = await publish(chat, cards[0]!);

    expect(read.updateConflictId).toBeNull();
    expect(openUpdateConflict(handle.db, "default")).toBeDefined();
  });
});

describe("Keep my pipeline", () => {
  it("resolves the conflict and moves the base without changing the graph, and closes the notice", async () => {
    const { conflictId, noticeId } = heldUpdate();
    const chat = await openChat(conflictId, noticeId);
    turn(chat, resolutionReply((await readConflict()).data.conflict!));
    const { cards } = postedCards(chat);
    const keep = cards[2]!;
    const before = { graph: graphOf(), versions: listPipelineVersions(handle.db, "default").length };

    const shown = await call("assist:card", { conversationId: chat.id, messageId: keep });
    expect(shown.card).toEqual({ kind: "pipelineKeepMine", pipelineId: "default", pipelineName: "Delivery", held: { templateTitle: "Software feature to merge", fromVersion: "1.0", toVersion: "1.2" } });

    const pressed = await call("assist:applyCard", { conversationId: chat.id, messageId: keep });

    expect(pressed.applied).toBe(true);
    expect(pressed.said).toContain("Kept Delivery as it is and skipped the template update to 1.2");
    const conflict = getUpdateConflict(handle.db, conflictId)!;
    expect(conflict.resolution).toBe("kept");
    expect(getPipelineOrigin(handle.db, "default")).toMatchObject({ version: "1.2", baseId: conflict.templateId });
    // Not one step or route changed, and no version was filed.
    expect(graphOf()).toEqual(before.graph);
    expect(listPipelineVersions(handle.db, "default")).toHaveLength(before.versions);
    expect(listMentionsForComment(handle.db, noticeId as Uuid).map((mention) => mention.status)).not.toContain("open");
    // Never raised again for this version, and pressing again is refused.
    expect(applyTemplateUpdates(handle.db, loadTemplateHistory(GALLERY_DIRECTORY), { isTheRecord: false })).toEqual([]);
    expect((await call("assist:applyCard", { conversationId: chat.id, messageId: keep })).applied).toBe(false);
  });

  it("is not offered for a pipeline with no held update", async () => {
    const { conflictId, noticeId } = heldUpdate();
    const chat = await openChat(conflictId, noticeId);
    turn(chat, { message: "Keep it?", card: { kind: "pipelineKeepMine", pipelineId: "default" } });
    expect(postedCards(chat).cards).toHaveLength(1);

    await call("pipeline:keepOwnVersion", { pipelineId: "default" });
    turn(chat, { message: "Keep it?", card: { kind: "pipelineKeepMine", pipelineId: "default" } });

    expect(postedCards(chat)).toEqual({ cards: [], rejections: [expect.stringContaining('No card was offered: "Delivery" has no held template update')] });
  });
});

describe("alternative drafts in one reply", () => {
  it("posts each draft as its own card after the message, the Keep card last, and reads each back as its own graph", async () => {
    const { conflictId, noticeId } = heldUpdate();
    const chat = await openChat(conflictId, noticeId);
    turn(chat, resolutionReply((await readConflict()).data.conflict!));
    const { cards } = postedCards(chat);

    const reads = await Promise.all(cards.slice(0, 2).map((cardId) => call("assist:draft", { conversationId: chat.id, messageId: cardId })));
    const target = (read: (typeof reads)[number]) => read.routes.find((route) => route.fromStepId === "pull_request_watch" && route.resultKey === "ready")?.target ?? null;
    // The recommendation sends `ready` on to the person's Merge PR; the template's version asks a person.
    expect(reads.map(target)).toEqual(["merge_pr", "user_attention"]);
    const keep = await call("assist:draft", { conversationId: chat.id, messageId: cards[2]! });
    expect(keep.problem).not.toBeNull();
  });

  it("keeps an alternative's place when one is refused, posting its reason there", async () => {
    const { conflictId, noticeId } = heldUpdate();
    const chat = await openChat(conflictId, noticeId);
    const conflict = (await readConflict()).data.conflict!;
    const broken = { ...templateDraft(conflict), entryStepId: "no_such_step" } as DraftOf;
    turn(chat, { message: "Two.", draft: recommendedDraft(conflict), alternatives: [broken] });

    const { cards, rejections } = postedCards(chat);
    expect(cards).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    const read = await call("assist:draft", { conversationId: chat.id, messageId: cards[0]! });
    expect(read.routes.find((route) => route.fromStepId === "pull_request_watch" && route.resultKey === "ready")?.target).toBe("merge_pr");
  });
});

/** The pipeline's graph as rows to write again, with `change` applied to each step. */
type StepRow = Omit<ReturnType<typeof listStepsForPipeline>[number], "ownerPersonId" | "ownerGroupId">;
function rewritten(change: (step: StepRow) => StepRow = (step) => step) {
  return {
    steps: listStepsForPipeline(handle.db, "default")
      .filter((step) => !step.offBoard)
      .map(({ ownerPersonId: _person, ownerGroupId: _group, ...step }) => change(step)),
    routes: listRoutesForPipeline(handle.db, "default").map(({ id: _id, ...route }) => route),
  };
}

describe("the person's edits since the base", () => {
  it("tell an edit to a step's inputs or time limit alone, with its value before and after", async () => {
    heldUpdate();
    const dana = createPerson(handle.db, { name: "Dana" });
    const tuned = rewritten((step) => (step.id === "merge_request" ? { ...step, inputs: { draft: true }, timeoutMs: 600_000 } : step));
    replacePipelineGraph(handle.db, "default", tuned.steps, tuned.routes, { createdBy: dana.id });

    const edit = (await readConflict()).data.conflict!.edits.at(-1)!;

    expect(edit).toMatchObject({ createdBy: dana.id, createdByName: "Dana" });
    expect(edit.previousVersion).toBe(edit.version - 1);
    expect(edit.changes).toEqual(['Changed **Merge Request**: inputs {} → {"draft":true}; timeoutMs (none) → 600000']);
  });

  it("are counted from the moment the base last moved, an update the person had already made included", async () => {
    const { conflictId } = heldUpdate();
    const dana = createPerson(handle.db, { name: "Dana" });
    // Dana makes the template's change herself, and the next launch finds
    // nothing left to apply: the base moves with no version filed.
    const conflict = (await readConflict()).data.conflict!;
    replacePipelineGraph(
      handle.db,
      "default",
      conflict.template.steps as Parameters<typeof replacePipelineGraph>[2],
      conflict.template.routes.map(({ id: _id, ...route }) => route) as Parameters<typeof replacePipelineGraph>[3],
      { createdBy: dana.id },
    );
    resolveUpdateConflict(handle.db, conflictId, "superseded");
    expect(applyTemplateUpdates(handle.db, loadTemplateHistory(GALLERY_DIRECTORY), { isTheRecord: false }).find((update) => update.pipelineId === "default")?.outcome).toBe("caught-up");
    const movedAt = getPipelineOrigin(handle.db, "default")!.baseMovedAt;
    expect(movedAt).not.toBeNull();

    // A later update, held against the new base, sees none of what came before the move.
    expect(editsSinceBase(handle.db, "default", { id: "later", templateSlug: "software-feature-to-merge", fromVersion: "1.2" })).toEqual([]);
    // And sees what Dana does after it.
    const renamed = rewritten((step) => (step.id === "review" ? { ...step, name: "Code review" } : step));
    replacePipelineGraph(handle.db, "default", renamed.steps, renamed.routes, { createdBy: dana.id });
    const after = editsSinceBase(handle.db, "default", { id: "later", templateSlug: "software-feature-to-merge", fromVersion: "1.2" });
    expect(after.map((edit) => edit.changes)).toEqual([["Changed **Code review**: name Review → Code review"]]);
  });

  it("start again once the conflict is resolved: what the published draft was, is the base's", async () => {
    const { conflictId, noticeId } = heldUpdate();
    const chat = await openChat(conflictId, noticeId);
    turn(chat, resolutionReply((await readConflict()).data.conflict!));
    await publish(chat, postedCards(chat).cards[0]!);

    expect(editsSinceBase(handle.db, "default", { id: "later", templateSlug: "software-feature-to-merge", fromVersion: "1.2" })).toEqual([]);
  });

  it("are every version a backfilled origin has: its pipeline was made from the base long before anybody recorded it", async () => {
    heldUpdate();
    // Backfilled, so no moment was kept.
    expect(getPipelineOrigin(handle.db, "default")!.baseMovedAt).toBeNull();

    const edits = (await readConflict()).data.conflict!.edits;

    expect(edits.map((edit) => edit.version)).toEqual(listPipelineVersions(handle.db, "default").map((version) => version.number));
  });
});

/** The shipped history with a 1.3 of the template on top, which checks the pull request every ten minutes instead of five. */
function historyWithEveryTenMinutes() {
  const history = loadTemplateHistory(GALLERY_DIRECTORY);
  const versions = history.get("software-feature-to-merge")!;
  const latest = versions.at(-1)!;
  const document = structuredClone(latest.document);
  document.template.version = "1.3";
  for (const step of document.steps) if (step.id === "pull_request_watch") Object.assign(step, { watch: { everyMinutes: 10, giveUpAfterHours: 168, neverGivesUp: true } });
  return new Map(history).set("software-feature-to-merge", [...versions, { ...latest, version: "1.3", notes: "Checks every ten minutes.", document }]);
}

describe("a template step published under a fresh id", () => {
  /** The recommendation with the template's watch renamed, said in `templateStepIds`. */
  function freshDraft(conflict: UpdateConflictDetail, map: Record<string, string> | undefined): DraftOf {
    const draft = recommendedDraft(conflict);
    const fresh = (id: string) => (id === "pull_request_watch" ? "delivery_watch" : id);
    return {
      ...draft,
      steps: draft.steps.map((step) => ({ ...step, id: fresh(step.id) })),
      routes: (draft.routes ?? []).map((route) => ({ ...route, fromStepId: fresh(route.fromStepId), target: fresh(route.target) })),
      ...(map === undefined ? {} : { templateStepIds: map }),
    };
  }

  it("is carried through Publish onto the new base, so the template's next version still knows the step", async () => {
    const { conflictId, noticeId } = heldUpdate();
    const chat = await openChat(conflictId, noticeId);
    const conflict = (await readConflict()).data.conflict!;
    turn(chat, { message: "Under a fresh id.", draft: freshDraft(conflict, { pull_request_watch: "delivery_watch" }) });

    const { resolved } = await publish(chat, postedCards(chat).cards[0]!);

    expect(resolved).toEqual({ resolved: true, problem: null });
    expect(getPipelineOrigin(handle.db, "default")!.stepIds["pull_request_watch"]).toBe("delivery_watch");
    // 1.3 changes how often the template's watch checks: a change only
    // the template made, applied to the person's step of that name.
    const [update] = applyTemplateUpdates(handle.db, historyWithEveryTenMinutes(), { isTheRecord: false }).filter((entry) => entry.pipelineId === "default");
    expect(update?.outcome).toBe("applied");
    expect(listStepsForPipeline(handle.db, "default").find((step) => step.id === "delivery_watch")?.watch).toMatchObject({ everyMinutes: 10 });
    expect(listStepsForPipeline(handle.db, "default").some((step) => step.id === "pull_request_watch")).toBe(false);
  });

  it("without templateStepIds is read by the next version as the person's own step, the template's as removed — which is why the prompt asks for it", async () => {
    const { conflictId, noticeId } = heldUpdate();
    const chat = await openChat(conflictId, noticeId);
    turn(chat, { message: "Under a fresh id.", draft: freshDraft((await readConflict()).data.conflict!, undefined) });
    await publish(chat, postedCards(chat).cards[0]!);

    expect(getPipelineOrigin(handle.db, "default")!.stepIds["pull_request_watch"]).toBeUndefined();
    const [update] = applyTemplateUpdates(handle.db, historyWithEveryTenMinutes(), { isTheRecord: false }).filter((entry) => entry.pipelineId === "default");
    expect(update?.outcome).toBe("conflict");
  });

  it("is refused before anything is published when the map cannot be believed", async () => {
    const { conflictId, noticeId } = heldUpdate();
    const chat = await openChat(conflictId, noticeId);
    // The template's watch said to be the person's Review: a different kind of step.
    turn(chat, { message: "Wrong.", draft: freshDraft((await readConflict()).data.conflict!, { pull_request_watch: "review" }) });

    const read = await call("assist:draft", { conversationId: chat.id, messageId: postedCards(chat).cards[0]! });

    expect(read.problem).toContain('maps the template\'s "pull_request_watch" (builtin watch_pull_request) to "review", which is a different kind of step');
    expect(getUpdateConflict(handle.db, conflictId)?.resolvedAt).toBeNull();
  });
});
