import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uuidv7, type Uuid } from "@eo/core";
import { describeUpdateKey } from "@eo/engine";
import type { DbHandle } from "../db/client.js";
import {
  adoptPipeline,
  archiveAgent,
  createAgent,
  getMessage,
  listAgents,
  createPipeline,
  createStep,
  currentVersion,
  getItem,
  getPipelineOrigin,
  getStep,
  listPipelines,
  listPipelineVersions,
  listRoutesForPipeline,
  listStepsForPipeline,
  listUpdateConflicts,
  openUpdateConflict,
  publishSection,
  recordPipelineOrigin,
  replacePipelineGraph,
  setSetting,
  setStepAgent,
  updateAgent,
  versionAuthorName,
} from "../db/repos/index.js";
import { getActionDefinition, saveActionDefinition } from "../db/repos/actionDefinitionsRepo.js";
import { markReplica } from "../db/recordRole.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { agentOfKind, createTestItem, messagesFrom, openMigratedTestDb } from "../db/testHelpers.js";
import { storedGraphProblems } from "../ipc/configCommands.js";
import { pipelineVersionsCommand } from "../ipc/pipelineCommands.js";
import { ACTIVE_PROJECT_KEY } from "../ipc/repositoryCommands.js";
import { type TemplateHistory, type TemplateVersion } from "./history.js";
import { templateHistoryUpTo } from "./historyTestHelpers.js";
import { backfillPipelineOrigins } from "./origins.js";
import { applyTemplateUpdates, compareWithTemplate } from "./templateUpdates.js";
import { chooseTemplateAgent, TEMPLATE_AGENT_CHOICE_SOURCE } from "./updateAgents.js";
import { handleMessageHere, onMessageAnswered } from "../messages/messages.js";

/**
 * Template updates reach the pipelines made from them (EO-532): three
 * graphs compared, the update applied where nothing conflicts and held
 * where anything does.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
const SOFTWARE = "software-feature-to-merge";

let handle: DbHandle;
let history: TemplateHistory;

beforeEach(() => {
  handle = openMigratedTestDb();
  // As it stood at 1.4: these tests script updates against 1.4's graph.
  // 1.5's own update is tested on its own (EO-921).
  history = templateHistoryUpTo(GALLERY_DIRECTORY, SOFTWARE, "1.4");
});

afterEach(() => {
  handle.close();
});

/**
 * The seeded Delivery as it was before EO-461: no Watching pull
 * request, and Merge Request's `opened` going to `target`. Retiring the
 * step and re-pointing the route is the shortest way from the migrated
 * graph to that one.
 */
function deliveryBeforeEo461(target: string): void {
  handle.db.run(sql`DELETE FROM step_routes WHERE from_step_id = 'pull_request_watch'`);
  handle.db.run(sql`UPDATE pipeline_steps SET retired_version = 1 WHERE id = 'pull_request_watch'`);
  handle.db.run(sql`UPDATE step_routes SET target = ${target} WHERE from_step_id = 'merge_request' AND result_key = 'opened'`);
}

/** A Merge pipeline with a `merge_pr` step, as EO's own installation has one. */
function mergePipeline(): void {
  const merge = createPipeline(handle.db, { projectId: null, name: "Merge" });
  createStep(handle.db, { id: "merge_pr", pipelineId: merge.id as Uuid, position: 0, name: "Merge PR", type: "user" });
  createStep(handle.db, { pipelineId: merge.id as Uuid, position: 1, name: "Merged", type: "user", isTerminal: true });
}

/** The history as it stood when `version` was the newest this template shipped. */
function upTo(version: string): TemplateHistory {
  return templateHistoryUpTo(GALLERY_DIRECTORY, SOFTWARE, version);
}

function shipped(version: string): TemplateVersion {
  const found = history.get(SOFTWARE)?.find((entry) => entry.version === version);
  if (found === undefined) throw new Error(`no ${SOFTWARE} ${version} shipped`);
  return found;
}

describe("EO's own Delivery against the current template", () => {
  it("reports exactly one conflict, Merge Request's opened route, with the new step and its routes as the template's", () => {
    mergePipeline();
    deliveryBeforeEo461("merge_pr");
    backfillPipelineOrigins(handle.db, history);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.0");

    const compared = compareWithTemplate(handle.db, "default", shipped("1.1"));
    const comparison = compared!.merge.comparison;

    expect(comparison.conflicts).toEqual([
      {
        key: { kind: "route", fromStepId: "merge_request", resultKey: "opened" },
        outcome: "conflict",
        base: expect.objectContaining({ target: "ready_to_merge" }),
        current: expect.objectContaining({ target: "merge_pr" }),
        template: expect.objectContaining({ target: "pull_request_watch" }),
      },
    ]);
    // The base's target is the step called Done.
    expect(listStepsForPipeline(handle.db, "default").find((step) => step.id === "ready_to_merge")?.name).toBe("Done");

    const templateOnly = comparison.changes.filter((change) => change.outcome === "template").map((change) => describeUpdateKey(change.key));
    expect(templateOnly.sort()).toEqual(
      [
        "step pull_request_watch",
        ...["merged", "checks_failed", "changes_requested", "conflict", "closed", "ready", "failed"].map((result) => `pull_request_watch → ${result}`),
      ].sort(),
    );
  });

  it("is held: nothing applied, and an open update conflict with the key's three values", () => {
    mergePipeline();
    deliveryBeforeEo461("merge_pr");
    backfillPipelineOrigins(handle.db, history);
    const stepsBefore = listStepsForPipeline(handle.db, "default");
    const routesBefore = listRoutesForPipeline(handle.db, "default");
    const versionsBefore = listPipelineVersions(handle.db, "default").length;

    const results = applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    expect(results).toEqual([expect.objectContaining({ pipelineId: "default", outcome: "conflict", from: "1.0", to: "1.4" })]);
    expect(listStepsForPipeline(handle.db, "default")).toEqual(stepsBefore);
    expect(listRoutesForPipeline(handle.db, "default")).toEqual(routesBefore);
    expect(listPipelineVersions(handle.db, "default")).toHaveLength(versionsBefore);
    // The base stays where it was until the conflict is resolved.
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.0");

    const open = openUpdateConflict(handle.db, "default");
    expect(open).toMatchObject({ templateSlug: SOFTWARE, fromVersion: "1.0", toVersion: "1.4", problems: [] });
    expect(open?.notes).toContain("CI failures, merge conflicts and review comments send the work back to the implementer");
    expect(open?.conflicts).toHaveLength(1);
    expect(open?.conflicts[0]).toMatchObject({
      key: { kind: "route", fromStepId: "merge_request", resultKey: "opened" },
      base: { target: "ready_to_merge" },
      current: { target: "merge_pr" },
      template: { target: "pull_request_reply" },
    });
  });

  it("raises the same held update once, however many launches", () => {
    mergePipeline();
    deliveryBeforeEo461("merge_pr");
    backfillPipelineOrigins(handle.db, history);

    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toEqual([]);
    expect(listUpdateConflicts(handle.db, "default")).toHaveLength(1);
  });
  it("closes a held update as superseded when a newer version is compared", () => {
    mergePipeline();
    deliveryBeforeEo461("merge_pr");
    backfillPipelineOrigins(handle.db, history);
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    const first = openUpdateConflict(handle.db, "default")!;

    const v14 = shipped("1.4");
    const v15: TemplateVersion = { ...v14, version: "1.5", notes: "A later version.", document: { ...v14.document, template: { ...v14.document.template, version: "1.5" } } };
    applyTemplateUpdates(handle.db, new Map([[SOFTWARE, [...history.get(SOFTWARE)!, v15]]]), { isTheRecord: false });

    const all = listUpdateConflicts(handle.db, "default");
    expect(all.map((conflict) => [conflict.toVersion, conflict.resolution])).toEqual([
      ["1.4", "superseded"],
      ["1.5", null],
    ]);
    expect(openUpdateConflict(handle.db, "default")?.id).not.toBe(first.id);
    expect(openUpdateConflict(handle.db, "default")?.notes).toContain("A later version.");
  });
});

describe("an update with no conflict", () => {
  /** A Delivery nobody re-pointed, on 1.0, on a project, with one change of the person's own. */
  function untouchedDelivery(): { projectId: Uuid } {
    deliveryBeforeEo461("ready_to_merge");
    // The person's own change: no Index step, Worktree straight to To Do.
    handle.db.run(sql`DELETE FROM step_routes WHERE from_step_id = 'repository_index'`);
    handle.db.run(sql`UPDATE pipeline_steps SET retired_version = 1 WHERE id = 'repository_index'`);
    handle.db.run(sql`UPDATE step_routes SET target = 'todo' WHERE from_step_id = 'worktree' AND target = 'repository_index'`);
    backfillPipelineOrigins(handle.db, history);
    // Delivery is the project's own, as every pipeline whose work a
    // project has is since EO-766, so the Pull request comments board
    // 1.4 adds is made on it too and Delivery's routes into it are
    // hand-offs within the project.
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    adoptPipeline(handle.db, "default", project.id as Uuid);
    return { projectId: project.id as Uuid };
  }

  it("files the merged graph as a new version by the template update, and moves the base", () => {
    const { projectId } = untouchedDelivery();
    createTestItem(handle.db, { type: "story", title: "On it", stepId: "todo", projectId });
    const before = currentVersion(handle.db, "default")!;

    const results = applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    expect(results).toEqual([expect.objectContaining({ pipelineId: "default", outcome: "applied", from: "1.0", to: "1.4", version: before.number + 1 })]);
    const after = currentVersion(handle.db, "default")!;
    expect(after.number).toBe(before.number + 1);
    expect(after.createdBy).toBe(`template:${SOFTWARE}@1.4`);
    expect(versionAuthorName(after.createdBy, () => null)).toBe(`the ${SOFTWARE} 1.4 template update`);

    const steps = listStepsForPipeline(handle.db, "default");
    expect(steps.map((step) => step.id)).toEqual(["worktree", "todo", "review", "merge_request", "pull_request_reply", "pull_request_watch", "ready_to_merge"]);
    expect(steps.find((step) => step.id === "pull_request_watch")).toMatchObject({ entryAction: "watch_pull_request", watch: { everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true } });
    const routes = listRoutesForPipeline(handle.db, "default");
    // The person's own change is kept: still no Index.
    expect(routes.find((route) => route.fromStepId === "worktree" && route.resultKey === "ready")?.target).toBe("todo");
    expect(routes.find((route) => route.fromStepId === "merge_request" && route.resultKey === "opened")?.target).toBe("pull_request_reply");
    expect(routes.filter((route) => route.fromStepId === "pull_request_watch")).toHaveLength(9);

    const origin = getPipelineOrigin(handle.db, "default");
    expect(origin?.version).toBe("1.4");
    expect(origin?.stepIds["pull_request_watch"]).toBe("pull_request_watch");
    expect(origin?.stepIds).not.toHaveProperty("repository_index");
    expect(openUpdateConflict(handle.db, "default")).toBeUndefined();
    // And the next launch has nothing left to do.
    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toEqual([]);
  });

  it("keeps items in flight on the version they entered on", () => {
    const { projectId } = untouchedDelivery();
    const inFlight = createTestItem(handle.db, { type: "story", title: "In flight", stepId: "merge_request", projectId });
    const entered = getItem(handle.db, inFlight.id)!.pipelineVersionId;
    expect(entered).not.toBeNull();

    applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    expect(getItem(handle.db, inFlight.id)?.pipelineVersionId).toBe(entered);
    expect(currentVersion(handle.db, "default")?.id).not.toBe(entered);
    const later = createTestItem(handle.db, { type: "story", title: "Later", stepId: "todo", projectId });
    expect(getItem(handle.db, later.id)?.pipelineVersionId).toBe(currentVersion(handle.db, "default")?.id);
  });

  it("posts nothing, and the version it files keeps the release notes the pipeline's version list shows (EO-728)", () => {
    const { projectId } = untouchedDelivery();
    createTestItem(handle.db, { type: "story", title: "On it", stepId: "todo", projectId });
    const before = currentVersion(handle.db, "default")!;

    applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    // No comment written anywhere.
    expect(handle.db.all(sql`select id from comments`)).toEqual([]);

    // And the board 1.4 adds, which the update made beside Delivery (EO-763).
    const notes = [...[shipped("1.1"), shipped("1.2"), shipped("1.3"), shipped("1.4")].map((version) => `${version.version}: ${version.notes}`), "Created the Pull request comments board this version adds."].join("\n");
    expect(currentVersion(handle.db, "default")!.releaseNotes).toBe(notes);
    const listed = pipelineVersionsCommand(handle.db, { pipelineId: "default" }).versions;
    expect(listed.find((version) => version.number === before.number + 1)?.releaseNotes).toBe(notes);
    // A version a person saved has none.
    expect(listed.find((version) => version.number === before.number)?.releaseNotes).toBeNull();
  });
});

/**
 * A template update compares steps by kind and action, never by which
 * agent runs them (EO-877): a person's choice of agent on a step is never
 * overwritten, and a step the update adds is bound like a new import —
 * to the agent the pipeline already runs for its kind.
 */
describe("the agents a template update leaves a pipeline's steps running", () => {
  function deliveryRunningOwnChoices() {
    const { projectId } = untouchedDeliveryOn10();
    const implementer = createAgent(handle.db, { name: "Codex implementer", role: "implementer", provider: "codex", instructions: "Implement." });
    const reviewer = createAgent(handle.db, { name: "Codex reviewer", role: "reviewer", provider: "codex", instructions: "Review." });
    setStepAgent(handle.db, "todo", implementer.id);
    setStepAgent(handle.db, "review", reviewer.id);
    return { projectId, implementer, reviewer };
  }

  function untouchedDeliveryOn10(): { projectId: Uuid } {
    deliveryBeforeEo461("ready_to_merge");
    backfillPipelineOrigins(handle.db, history);
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    adoptPipeline(handle.db, "default", project.id as Uuid);
    return { projectId: project.id as Uuid };
  }

  it("keeps the person's agent on each step, and binds the steps of the board it adds to the same ones", () => {
    const { projectId, implementer, reviewer } = deliveryRunningOwnChoices();
    // Not the agents the binding rule would pick on its own.
    expect(agentOfKind(handle.db, "implementer")).not.toBe(implementer.id);

    const results = applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    expect(results).toEqual([expect.objectContaining({ pipelineId: "default", outcome: "applied", to: "1.4" })]);

    expect(getStep(handle.db, "todo")?.agentId).toBe(implementer.id);
    expect(getStep(handle.db, "review")?.agentId).toBe(reviewer.id);
    const added = listPipelines(handle.db, projectId)
      .filter((pipeline) => pipeline.id !== "default")
      .flatMap((pipeline) => listStepsForPipeline(handle.db, pipeline.id))
      .filter((step) => step.type === "agent");
    expect(added.map((step) => [step.entryAction, step.agentId])).toEqual([
      ["plan_comment_response", implementer.id],
      ["review_plan", reviewer.id],
    ]);
  });

  it("binds an agent step it adds to Delivery to the agent Delivery runs for that kind", () => {
    const { reviewer } = deliveryRunningOwnChoices();
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.4");

    // A 1.5 that adds a second review after the first.
    const v14 = shipped("1.4");
    const review = v14.document.steps.find((step) => step.id === "review")!;
    const document = structuredClone(v14.document);
    document.steps = [...document.steps.map((step) => (step.position > review.position ? { ...step, position: step.position + 1 } : step)), { ...review, id: "second_review", name: "Second review", position: review.position + 1 }];
    document.routes = [
      ...document.routes.map((route) => (route.fromStepId === "review" && route.resultKey === "approved" ? { ...route, target: "second_review" } : route)),
      ...v14.document.routes.filter((route) => route.fromStepId === "review").map((route) => ({ ...route, fromStepId: "second_review" })),
    ];
    const later = new Map([...history].map(([slug, versions]) => [slug, slug === SOFTWARE ? [...versions, { ...v14, version: "1.5", notes: "A second review.", document }] : versions]));

    const results = applyTemplateUpdates(handle.db, later, { isTheRecord: false });
    expect(results).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied", to: "1.5" }));
    expect(getStep(handle.db, "second_review")?.agentId).toBe(reviewer.id);
    expect(getStep(handle.db, "review")?.agentId).toBe(reviewer.id);
  });
});

/**
 * A kind an update adds that no board of the installation runs yet
 * (EO-877) is bound as an import binds it: the one agent there is; the
 * person's pick where there are several, the update waiting for it and
 * applied the moment they answer; or one made from the new version's
 * prompt where there is none. With no prompt either, it waits for them.
 */
describe("a template update that adds steps of a kind the installation does not run yet", () => {
  function deliveryOn14(): { projectId: Uuid } {
    deliveryBeforeEo461("ready_to_merge");
    backfillPipelineOrigins(handle.db, history);
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    adoptPipeline(handle.db, "default", project.id as Uuid);
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.4");
    return { projectId: project.id as Uuid };
  }

  /** 1.4 with a system-kind Intake check after review, and the role's prompt where `prompt` is given. */
  function withIntakeStep(prompt: string | null): TemplateHistory {
    const v14 = shipped("1.4");
    const review = v14.document.steps.find((step) => step.id === "review")!;
    const approved = v14.document.routes.find((route) => route.fromStepId === "review" && route.resultKey === "approved")!;
    const document = structuredClone(v14.document);
    document.template = { ...document.template, version: "1.5" };
    document.steps = [
      ...document.steps.map((step) => (step.position > review.position ? { ...step, position: step.position + 1 } : step)),
      { ...review, id: "intake_check", name: "Intake check", ownerRole: "system", entryAction: "intake", position: review.position + 1 },
    ];
    document.routes = [
      ...document.routes.map((route) => (route === approved || (route.fromStepId === "review" && route.resultKey === "approved") ? { ...route, target: "intake_check" } : route)),
      { ...approved, fromStepId: "intake_check", resultKey: "done", label: "Done" },
      { ...approved, fromStepId: "intake_check", resultKey: "classified_non_feature", label: "Classified non-feature" },
    ];
    document.roles = [...document.roles.filter((role) => role.slug !== "system"), ...(prompt === null ? [] : [{ slug: "system", prompt, schemasByAction: {}, actions: [], allowedTools: null, backend: "claude", model: null }])];
    return new Map([...history].map(([slug, versions]) => [slug, slug === SOFTWARE ? [...versions, { ...v14, version: "1.5", notes: "An intake check.", document }] : versions]));
  }
  const choiceMessages = () => messagesFrom(handle.db, TEMPLATE_AGENT_CHOICE_SOURCE);

  it("waits for the person to pick between several, and applies with the one picked as soon as they answer", () => {
    deliveryOn14();
    const seeded = agentOfKind(handle.db, "system");
    const second = createAgent(handle.db, { name: "Second system", role: "system", provider: "codex", instructions: "Intake too." });
    const later = withIntakeStep("Intake.");
    const before = currentVersion(handle.db, "default")!.number;

    expect(applyTemplateUpdates(handle.db, later, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "waiting", to: "1.5", kinds: ["system"] }));
    expect(getStep(handle.db, "intake_check")).toBeUndefined();
    expect(currentVersion(handle.db, "default")!.number).toBe(before);
    const [asked] = choiceMessages();
    expect(asked?.body).toContain('adds "system" steps, and you have several "system" agents');
    expect(asked?.options).toEqual([`${listAgents(handle.db).find((agent) => agent.id === seeded)!.name} (${listAgents(handle.db).find((agent) => agent.id === seeded)!.provider})`, "Second system (codex)"]);
    // Asked once, however many launches.
    applyTemplateUpdates(handle.db, later, { isTheRecord: false });
    expect(choiceMessages()).toHaveLength(1);
    expect(listUpdateConflicts(handle.db, "default")).toEqual([]);

    // Answered as startMain wires it: the choice kept, the update run again.
    const stop = onMessageAnswered(TEMPLATE_AGENT_CHOICE_SOURCE, (db, message) => {
      if (chooseTemplateAgent(db, message)) applyTemplateUpdates(db, later, { isTheRecord: false });
    });
    try {
      expect(handleMessageHere(handle.db, { messageId: asked!.id, how: "answered", answer: "Second system (codex)" }).ok).toBe(true);
    } finally {
      stop();
    }

    expect(getStep(handle.db, "intake_check")?.agentId).toBe(second.id);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.5");
    // The steps whose agent was already chosen keep it.
    expect(getStep(handle.db, "review")?.agentId).toBe(agentOfKind(handle.db, "reviewer"));
  });

  it("makes one from the new version's prompt where there is none, unbound and off, and names it", () => {
    deliveryOn14();
    for (const agent of listAgents(handle.db).filter((one) => one.role === "system")) archiveAgent(handle.db, agent.id);

    expect(applyTemplateUpdates(handle.db, withIntakeStep("Intake."), { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied", to: "1.5" }));

    const made = listAgents(handle.db).filter((agent) => agent.role === "system" && agent.archivedAt === null);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ instructions: "Intake.", enabled: false });
    expect(getStep(handle.db, "intake_check")?.agentId).toBe(made[0]?.id);
  });

  it("waits, and says what to make, where there is none and no prompt to make one from", () => {
    deliveryOn14();
    for (const agent of listAgents(handle.db).filter((one) => one.role === "system")) archiveAgent(handle.db, agent.id);

    expect(applyTemplateUpdates(handle.db, withIntakeStep(null), { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "waiting", kinds: ["system"] }));
    expect(getStep(handle.db, "intake_check")).toBeUndefined();
    const [asked] = choiceMessages();
    expect(asked?.body).toContain('Make a "system" agent on the Agents screen');
    expect(asked?.options ?? []).toEqual([]);

    // Once there is one, the next launch applies, and the question closes.
    createAgent(handle.db, { name: "New system", role: "system", provider: "claude", instructions: "Intake." });
    expect(applyTemplateUpdates(handle.db, withIntakeStep(null), { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied" }));
    expect(choiceMessages()[0]?.handledHow).toBe("resolved");
  });

  /** 1.4 with a new Intake board whose one agent step is system-kind, and the role's prompt where `prompt` is given. */
  function withIntakeBoard(prompt: string | null): TemplateHistory {
    const v14 = shipped("1.4");
    const board = structuredClone(v14.document.boards[0]!);
    const [first] = board.steps;
    const document = structuredClone(v14.document);
    document.template = { ...document.template, version: "1.5" };
    document.boards = [
      ...document.boards,
      {
        key: "intake",
        pipeline: { ...board.pipeline, name: "Intake", entryStepId: "intake_only" },
        steps: [
          { ...first!, id: "intake_only", name: "Intake", ownerRole: "system", entryAction: "intake", position: 0, isTerminal: false },
          { ...first!, id: "intake_done", name: "Done", type: "user", ownerRole: null, entryAction: null, position: 1, isTerminal: true, results: [] },
        ],
        routes: [
          { fromStepId: "intake_only", resultKey: "done", label: "Done", tone: "success", target: "intake_done", position: 0 },
          { fromStepId: "intake_only", resultKey: "classified_non_feature", label: "Other", tone: "success", target: "intake_done", position: 1 },
        ],
      },
    ];
    document.roles = [...document.roles.filter((role) => role.slug !== "system"), ...(prompt === null ? [] : [{ slug: "system", prompt, schemasByAction: {}, actions: [], allowedTools: null, backend: "claude", model: null }])];
    return new Map([...history].map(([slug, versions]) => [slug, slug === SOFTWARE ? [...versions, { ...v14, version: "1.5", notes: "An intake board.", document }] : versions]));
  }
  const intakeBoards = () => listPipelines(handle.db).filter((pipeline) => pipeline.name === "Intake");

  it("does not make a board whose new kind has several agents until the person picks, and makes it naming the one picked", () => {
    deliveryOn14();
    const second = createAgent(handle.db, { name: "Second system", role: "system", provider: "codex", instructions: "Intake too." });
    const later = withIntakeBoard("Intake.");
    const boards = intakeBoards;

    expect(applyTemplateUpdates(handle.db, later, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "waiting", kinds: ["system"] }));
    expect(boards()).toEqual([]);
    const [asked] = choiceMessages();

    expect(handleMessageHere(handle.db, { messageId: asked!.id, how: "answered", answer: "Second system (codex)" }).ok).toBe(true);
    expect(chooseTemplateAgent(handle.db, getMessage(handle.db, asked!.id)!)).toBe(true);
    applyTemplateUpdates(handle.db, later, { isTheRecord: false });

    expect(boards()).toHaveLength(1);
    expect(listStepsForPipeline(handle.db, boards()[0]!.id).find((step) => step.name === "Intake")?.agentId).toBe(second.id);
  });

  /** Answers the open question about agents as startMain wires it: the choice kept, the update run again. */
  function answer(later: TemplateHistory, messageId: string, label: string): void {
    const stop = onMessageAnswered(TEMPLATE_AGENT_CHOICE_SOURCE, (db, message) => {
      if (chooseTemplateAgent(db, message)) applyTemplateUpdates(db, later, { isTheRecord: false });
    });
    try {
      expect(handleMessageHere(handle.db, { messageId, how: "answered", answer: label }).ok).toBe(true);
    } finally {
      stop();
    }
  }
  const archiveEverySystemAgent = () => {
    for (const agent of listAgents(handle.db).filter((one) => one.role === "system")) archiveAgent(handle.db, agent.id);
  };
  const liveOfKind = (kind: string) => listAgents(handle.db).filter((agent) => agent.role === kind && agent.archivedAt === null);

  it("tells apart two agents of one name and backend, and binds the one whose button was answered", () => {
    deliveryOn14();
    archiveEverySystemAgent();
    createAgent(handle.db, { name: "Intake", role: "system", provider: "codex", instructions: "One." });
    const second = createAgent(handle.db, { name: "Intake", role: "system", provider: "codex", instructions: "Two." });
    const later = withIntakeStep("Intake.");

    expect(applyTemplateUpdates(handle.db, later, { isTheRecord: false })).toContainEqual(expect.objectContaining({ outcome: "waiting", kinds: ["system"] }));
    const [asked] = choiceMessages();
    expect(asked?.options).toEqual(["Intake (codex) #1", "Intake (codex) #2"]);

    answer(later, asked!.id, "Intake (codex) #2");
    expect(getStep(handle.db, "intake_check")?.agentId).toBe(second.id);
  });

  it("binds the agent a button was offered for, however the agents were renamed before the answer", () => {
    deliveryOn14();
    archiveEverySystemAgent();
    const alpha = createAgent(handle.db, { name: "Alpha", role: "system", provider: "codex", instructions: "One." });
    const beta = createAgent(handle.db, { name: "Beta", role: "system", provider: "codex", instructions: "Two." });
    const later = withIntakeStep("Intake.");
    applyTemplateUpdates(handle.db, later, { isTheRecord: false });
    const [asked] = choiceMessages();
    expect(asked?.options).toEqual(["Alpha (codex)", "Beta (codex)"]);

    // Swapped names: the button that read "Beta" still means Beta's row.
    updateAgent(handle.db, alpha.id, { name: "Beta" });
    updateAgent(handle.db, beta.id, { name: "Alpha" });
    answer(later, asked!.id, "Beta (codex)");
    expect(getStep(handle.db, "intake_check")?.agentId).toBe(beta.id);
  });

  it("binds nothing where the agent answered is no longer one the installation can run", () => {
    deliveryOn14();
    archiveEverySystemAgent();
    const alpha = createAgent(handle.db, { name: "Alpha", role: "system", provider: "codex", instructions: "One." });
    createAgent(handle.db, { name: "Beta", role: "system", provider: "codex", instructions: "Two." });
    const later = withIntakeStep("Intake.");
    applyTemplateUpdates(handle.db, later, { isTheRecord: false });
    const [asked] = choiceMessages();
    archiveAgent(handle.db, alpha.id);

    expect(handleMessageHere(handle.db, { messageId: asked!.id, how: "answered", answer: "Alpha (codex)" }).ok).toBe(true);
    expect(chooseTemplateAgent(handle.db, getMessage(handle.db, asked!.id)!)).toBe(false);
  });

  /**
   * A replica whose organisation published the agents section makes no
   * agent here (EO-877): the update waits, saying who provides it,
   * whether the kind arrives on a new step or a new board.
   */
  describe("on a replica whose organisation published the agents section", () => {
    function lockedAgents<T>(run: () => T): T {
      publishSection(handle.db, { section: "agents", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });
      const stop = markReplica(handle.db, () => true);
      try {
        return run();
      } finally {
        stop();
      }
    }

    it("makes no agent for a step the update adds, and waits saying the organisation provides it", () => {
      deliveryOn14();
      archiveEverySystemAgent();
      const results = lockedAgents(() => applyTemplateUpdates(handle.db, withIntakeStep("Intake."), { isTheRecord: false }));

      expect(results).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "waiting", kinds: ["system"] }));
      expect(liveOfKind("system")).toEqual([]);
      expect(getStep(handle.db, "intake_check")).toBeUndefined();
      expect(choiceMessages()[0]?.body).toContain('you have no "system" agent. Your organisation has published its agents section (Dana)');
      expect(choiceMessages()[0]?.options ?? []).toEqual([]);
    });

    it("makes no agent for a board the update adds, and makes no board", () => {
      deliveryOn14();
      archiveEverySystemAgent();
      const results = lockedAgents(() => applyTemplateUpdates(handle.db, withIntakeBoard("Intake."), { isTheRecord: false }));

      expect(results).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "waiting", kinds: ["system"] }));
      expect(liveOfKind("system")).toEqual([]);
      expect(intakeBoards()).toEqual([]);
      expect(choiceMessages()[0]?.body).toContain("published its agents section (Dana)");
    });

    it("defines none of the actions a new kind brings, and waits saying so, though the kind has an agent", () => {
      deliveryOn14();
      createAgent(handle.db, { name: "QA", role: "qa", provider: "claude", instructions: "Verify." });
      const results = lockedAgents(() => applyTemplateUpdates(handle.db, withVerifyStep(), { isTheRecord: false }));

      expect(results).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "waiting", kinds: ["qa"] }));
      expect(getActionDefinition(handle.db, "qa", "verify")).toBeUndefined();
      expect(getStep(handle.db, "verify_check")).toBeUndefined();
      expect(choiceMessages()[0]?.body).toContain('the "qa" actions it brings are not defined here');
    });
  });

  /** 1.4 with a step after review of a kind and action no pack ships — "qa" / "verify" — the definition carried with the role. */
  function withVerifyStep(): TemplateHistory {
    const v14 = shipped("1.4");
    const review = v14.document.steps.find((step) => step.id === "review")!;
    const approved = v14.document.routes.find((route) => route.fromStepId === "review" && route.resultKey === "approved")!;
    const document = structuredClone(v14.document);
    document.template = { ...document.template, version: "1.5" };
    document.steps = [
      ...document.steps.map((step) => (step.position > review.position ? { ...step, position: step.position + 1 } : step)),
      { ...review, id: "verify_check", name: "Verify", ownerRole: "qa", entryAction: "verify", position: review.position + 1 },
    ];
    document.routes = [
      ...document.routes.map((route) => (route.fromStepId === "review" && route.resultKey === "approved" ? { ...route, target: "verify_check" } : route)),
      { ...approved, fromStepId: "verify_check", resultKey: "passed", label: "Passed" },
      { ...approved, fromStepId: "verify_check", resultKey: "failed", label: "Failed" },
    ];
    document.roles = [
      ...document.roles,
      {
        slug: "qa",
        prompt: "Verify.",
        schemasByAction: {},
        actions: [
          {
            action: "verify",
            description: "Check the change does what the story asks.",
            results: [
              { key: "passed", label: "Passed", meaning: "It does." },
              { key: "failed", label: "Failed", meaning: "It does not." },
            ],
            fields: {},
          },
        ],
        allowedTools: null,
        backend: "claude",
        model: null,
      },
    ];
    return new Map([...history].map(([slug, versions]) => [slug, slug === SOFTWARE ? [...versions, { ...v14, version: "1.5", notes: "A verify step.", document }] : versions]));
  }

  it("defines the actions a kind it adds brings, as an import does, so the new step validates and runs the agent it makes", () => {
    deliveryOn14();
    expect(liveOfKind("qa")).toEqual([]);

    expect(applyTemplateUpdates(handle.db, withVerifyStep(), { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied", to: "1.5" }));

    expect(getActionDefinition(handle.db, "qa", "verify")?.results.map((result) => result.key)).toEqual(["passed", "failed"]);
    const [made] = liveOfKind("qa");
    expect(made).toMatchObject({ instructions: "Verify." });
    expect(getStep(handle.db, "verify_check")?.agentId).toBe(made?.id);
  });

  it("keeps a definition of the action the installation already has", () => {
    deliveryOn14();
    createAgent(handle.db, { name: "QA", role: "qa", provider: "claude", instructions: "Verify." });
    expect(saveActionDefinition(handle.db, { role: "qa", action: "verify", description: "Ours.", results: [{ key: "passed", label: "Passed", meaning: "" }, { key: "failed", label: "Failed", meaning: "" }], fields: {} }).ok).toBe(true);

    expect(applyTemplateUpdates(handle.db, withVerifyStep(), { isTheRecord: false })).toContainEqual(expect.objectContaining({ outcome: "applied" }));
    expect(getActionDefinition(handle.db, "qa", "verify")?.description).toBe("Ours.");
  });
});

describe("a pipeline whose step ids were re-minted on import", () => {
  it("gives a step the template adds a fresh id where another pipeline holds the template's, and maps it", () => {
    // Delivery is on 1.4 and holds `pull_request_watch` itself.
    backfillPipelineOrigins(handle.db, history);
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.4");
    const v10 = shipped("1.0");
    const copy = createPipeline(handle.db, { projectId: null, name: "Imported" });
    const ids = new Map(v10.document.steps.map((step) => [step.id, uuidv7() as string]));
    const local = (id: string): string => ids.get(id) ?? id;
    replacePipelineGraph(
      handle.db,
      copy.id,
      // The document names kinds; the import binds each to this installation's agent of it (EO-875).
      v10.document.steps.map(({ ownerRole, ...step }) => ({
        ...step,
        agentId: step.type === "agent" && ownerRole !== null ? agentOfKind(handle.db, ownerRole) : null,
        id: local(step.id),
        pipelineId: copy.id as Uuid,
        moduleVersion: null,
      })),
      v10.document.routes.map((route) => ({ ...route, pipelineId: copy.id as Uuid, fromStepId: local(route.fromStepId), target: local(route.target) })),
      { entryStepId: local("worktree") },
    );
    recordPipelineOrigin(handle.db, { pipelineId: copy.id, document: v10.document, stepIds: Object.fromEntries(ids) });

    const results = applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    expect(results).toEqual([expect.objectContaining({ pipelineId: copy.id, outcome: "applied" })]);
    const watch = listStepsForPipeline(handle.db, copy.id).find((step) => step.entryAction === "watch_pull_request");
    expect(watch).toBeDefined();
    expect(watch!.id).not.toBe("pull_request_watch");
    const routes = listRoutesForPipeline(handle.db, copy.id);
    const reply = listStepsForPipeline(handle.db, copy.id).find((step) => step.entryAction === "reply_on_pull_request");
    expect(reply!.id).not.toBe("pull_request_reply");
    expect(routes.find((route) => route.fromStepId === local("merge_request") && route.resultKey === "opened")?.target).toBe(reply!.id);
    expect(routes.find((route) => route.fromStepId === reply!.id && route.resultKey === "replied")?.target).toBe(watch!.id);
    expect(routes.find((route) => route.fromStepId === watch!.id && route.resultKey === "merged")?.target).toBe(local("ready_to_merge"));
    expect(getPipelineOrigin(handle.db, copy.id)?.stepIds["pull_request_watch"]).toBe(watch!.id);
    // Delivery's own step is where it was.
    expect(listStepsForPipeline(handle.db, "default").find((step) => step.id === "pull_request_watch")?.pipelineId).toBe("default");
  });
});

describe("a merged graph that does not validate", () => {
  it("is not applied, and is recorded as a conflict with the reasons", () => {
    // A 1.5 that removes Index, which an item is standing on. Nothing
    // conflicts — the person never touched Index — but the graph would
    // strand the item, and `validatePipeline` refuses it.
    const current = shipped("1.4");
    const withoutIndex: TemplateVersion = {
      ...current,
      version: "1.5",
      notes: "Index is no longer a step of its own.",
      document: {
        ...current.document,
        template: { ...current.document.template, version: "1.5" },
        steps: current.document.steps.filter((step) => step.id !== "repository_index"),
        routes: current.document.routes
          .filter((route) => route.fromStepId !== "repository_index")
          .map((route) => (route.fromStepId === "worktree" && route.target === "repository_index" ? { ...route, target: "todo" } : route)),
      },
    };
    const withNext: TemplateHistory = new Map([[SOFTWARE, [...history.get(SOFTWARE)!, withoutIndex]]]);
    backfillPipelineOrigins(handle.db, history);
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.4");
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    createTestItem(handle.db, { type: "story", title: "Indexing", stepId: "repository_index", projectId: project.id as Uuid });
    const versionsBefore = listPipelineVersions(handle.db, "default").length;

    expect(compareWithTemplate(handle.db, "default", withoutIndex)?.merge.comparison.conflicts).toEqual([]);
    const results = applyTemplateUpdates(handle.db, withNext, { isTheRecord: false });

    // The Pull request comments board, which 1.5 leaves as it was, only has its base moved.
    expect(results).toEqual([expect.objectContaining({ pipelineId: "default", outcome: "conflict", to: "1.5" }), expect.objectContaining({ outcome: "caught-up", to: "1.5" })]);
    expect(listStepsForPipeline(handle.db, "default").map((step) => step.id)).toContain("repository_index");
    expect(listPipelineVersions(handle.db, "default")).toHaveLength(versionsBefore);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.4");
    const open = openUpdateConflict(handle.db, "default");
    expect(open).toMatchObject({ fromVersion: "1.4", toVersion: "1.5", conflicts: [] });
    expect(open?.problems.length).toBeGreaterThan(0);
  });
});

describe("judged for the projects a pipeline serves, not the one on screen", () => {
  /**
   * A Delivery carrying project B's work, whose Worktree hands `failed`
   * to a step of another of B's pipelines. Whichever project is
   * selected, the update is judged for B — the project whose work is on
   * it — and applies. Delivery is B's own, as every pipeline whose work
   * a project has is since EO-766, so the board 1.4 adds is B's too.
   */
  it.each(["the unrelated project", "the working project"])("applies the same update with %s selected", (selected) => {
    deliveryBeforeEo461("ready_to_merge");
    backfillPipelineOrigins(handle.db, history);
    const other = createProject(handle.db, { name: "Other", keyPrefix: "OTHER" });
    const working = createProject(handle.db, { name: "Work", keyPrefix: "WORK" });
    adoptPipeline(handle.db, "default", working.id as Uuid);
    const handOff = createPipeline(handle.db, { projectId: working.id, name: "Hand off" });
    const target = createStep(handle.db, { pipelineId: handOff.id as Uuid, position: 0, name: "Hand off", type: "user", isTerminal: true });
    handle.db.run(sql`UPDATE step_routes SET target = ${target.id} WHERE from_step_id = 'worktree' AND result_key = 'failed'`);
    createTestItem(handle.db, { type: "story", title: "On Work", stepId: "todo", projectId: working.id as Uuid });
    setSetting(handle.db, ACTIVE_PROJECT_KEY, selected === "the working project" ? working.id : other.id);

    const results = applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    expect(results).toEqual([expect.objectContaining({ pipelineId: "default", outcome: "applied" })]);
    expect(openUpdateConflict(handle.db, "default")).toBeUndefined();
    expect(listRoutesForPipeline(handle.db, "default").find((route) => route.fromStepId === "worktree" && route.resultKey === "failed")?.target).toBe(target.id);
  });
});

describe("a project in the middle of a move", () => {
  it("has its update applied all the same, with nothing posted: there is no notice to wait on (EO-728)", () => {
    deliveryBeforeEo461("ready_to_merge");
    backfillPipelineOrigins(handle.db, history);
    const moving = createProject(handle.db, { name: "Moving", keyPrefix: "MOVE" });
    handle.db.run(sql`UPDATE pipelines SET project_id = ${moving.id} WHERE id = 'default'`);
    handle.db.run(sql`UPDATE projects SET adopting_at = 123 WHERE id = ${moving.id}`);

    const applied = applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    expect(applied).toEqual([expect.objectContaining({ pipelineId: "default", outcome: "applied" })]);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.4");
    expect(currentVersion(handle.db, "default")!.releaseNotes).toContain(shipped("1.4").notes);
  });
});

describe("organisation mode", () => {
  it("never compares, on a desktop, a pipeline whose project was moved to the record", () => {
    deliveryBeforeEo461("ready_to_merge");
    backfillPipelineOrigins(handle.db, history);
    const moved = createProject(handle.db, { name: "Moved", keyPrefix: "MOVED", managed: true });
    handle.db.run(sql`UPDATE pipelines SET project_id = ${moved.id} WHERE id = 'default'`);

    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toEqual([]);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.0");
    expect(openUpdateConflict(handle.db, "default")).toBeUndefined();
  });

  it("never compares, on a desktop, a pipeline the organisation publishes", () => {
    deliveryBeforeEo461("ready_to_merge");
    backfillPipelineOrigins(handle.db, history);
    publishSection(handle.db, { section: "pipelines", subjectId: "default", publishedAt: Date.now() });

    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toEqual([]);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.0");
  });

  it("compares it on the record", () => {
    deliveryBeforeEo461("ready_to_merge");
    backfillPipelineOrigins(handle.db, history);
    const moved = createProject(handle.db, { name: "Moved", keyPrefix: "MOVED", managed: true });
    handle.db.run(sql`UPDATE pipelines SET project_id = ${moved.id} WHERE id = 'default'`);
    publishSection(handle.db, { section: "pipelines", subjectId: "default", publishedAt: Date.now() });

    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: true })).toEqual([expect.objectContaining({ pipelineId: "default", outcome: "applied" })]);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.4");
  });
});

describe("pipelines with nothing to compare", () => {
  it("leaves a pipeline already on the newest version alone", () => {
    backfillPipelineOrigins(handle.db, history);
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.4");
    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toEqual([]);
  });

  it("leaves a pipeline with no origin alone", () => {
    expect(getPipelineOrigin(handle.db, "default")).toBeNull();
    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toEqual([]);
  });
});

/**
 * 1.2 (EO-571): the pull request watch never gives up, reached through
 * 1.3 now, which changed only first run's question (EO-664). A pipeline made
 * from 1.1 whose watch is still the week it shipped with takes that as a
 * clean update — the setting is the template's change alone — and one
 * whose person set their own deadline keeps it, held as a conflict.
 *
 * Against the history as it stood at 1.3, since 1.4 (EO-763) changes the
 * graph too, and is compared below.
 */
describe("1.1 to 1.3: Watching pull request never gives up", () => {
  beforeEach(() => {
    history = upTo("1.3");
  });

  function deliveryOn11(): { projectId: Uuid } {
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    handle.db.run(sql`UPDATE pipelines SET project_id = ${project.id} WHERE id = 'default'`);
    backfillPipelineOrigins(handle.db, history);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.1");
    return { projectId: project.id as Uuid };
  }

  const watchStep = () => listStepsForPipeline(handle.db, "default").find((step) => step.id === "pull_request_watch");

  it("is applied with nothing held, as the one change of keep checking on the watch", () => {
    deliveryOn11();
    expect(watchStep()?.watch).toEqual({ everyMinutes: 5, giveUpAfterHours: 168 });

    const results = applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    expect(results).toEqual([
      expect.objectContaining({
        pipelineId: "default",
        outcome: "applied",
        from: "1.1",
        to: "1.3",
        changes: [
          expect.objectContaining({
            key: { kind: "setting", stepId: "pull_request_watch", field: "watch" },
            outcome: "template",
            base: { everyMinutes: 5, giveUpAfterHours: 168 },
            current: { everyMinutes: 5, giveUpAfterHours: 168 },
            template: { everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true },
          }),
        ],
      }),
    ]);
    expect(watchStep()?.watch).toEqual({ everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true });
    expect(openUpdateConflict(handle.db, "default")).toBeUndefined();
    expect(listUpdateConflicts(handle.db, "default")).toEqual([]);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.3");

    const notes = currentVersion(handle.db, "default")!.releaseNotes;
    expect(notes).toContain(shipped("1.2").notes);
    expect(notes).toContain(shipped("1.3").notes);
    expect(notes).not.toContain(shipped("1.1").notes);
  });

  it("holds a deadline the person set themselves as a conflict, and changes nothing", () => {
    deliveryOn11();
    handle.db.run(sql`UPDATE pipeline_steps SET watch_give_up_hours = 24 WHERE id = 'pull_request_watch'`);

    const results = applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    expect(results).toEqual([expect.objectContaining({ pipelineId: "default", outcome: "conflict", from: "1.1", to: "1.3" })]);
    expect(watchStep()?.watch).toEqual({ everyMinutes: 5, giveUpAfterHours: 24 });
    expect(openUpdateConflict(handle.db, "default")?.conflicts).toEqual([
      expect.objectContaining({ key: { kind: "setting", stepId: "pull_request_watch", field: "watch" }, current: { everyMinutes: 5, giveUpAfterHours: 24 } }),
    ]);
  });
});

/**
 * 1.4 (EO-763): Delivery replies on the pull request, and other accounts'
 * comments go to a board of their own, Pull request comments, which every
 * installation on the template gets — whether its Delivery takes the
 * update or holds it.
 */
describe("1.3 to 1.4: the Pull request comments board", () => {
  const board = () => listPipelines(handle.db).find((pipeline) => pipeline.name === "Pull request comments");
  const routeOf = (pipelineId: string, fromStepId: string, resultKey: string) =>
    listRoutesForPipeline(handle.db, pipelineId).find((route) => route.fromStepId === fromStepId && route.resultKey === resultKey)?.target;
  const errorsOf = (pipelineId: string) =>
    storedGraphProblems(
      handle.db,
      pipelineId,
      listStepsForPipeline(handle.db, pipelineId),
      listRoutesForPipeline(handle.db, pipelineId),
      listPipelines(handle.db).find((pipeline) => pipeline.id === pipelineId)?.entryStepId ?? null,
    ).filter((problem) => problem.severity === "error");

  /** Delivery made from 1.3 and on it, as an installation that last launched before 1.4 shipped. */
  function deliveryOn13(): void {
    backfillPipelineOrigins(handle.db, upTo("1.3"));
    applyTemplateUpdates(handle.db, upTo("1.3"), { isTheRecord: false });
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.3");
    expect(board()).toBeUndefined();
  }

  it("gives a new installation both boards on its first launch, routed into each other", () => {
    backfillPipelineOrigins(handle.db, history);

    const results = applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    expect(results).toEqual([expect.objectContaining({ pipelineId: "default", outcome: "applied", from: "1.1", to: "1.4" })]);
    const comments = board()!;
    expect(getPipelineOrigin(handle.db, comments.id)?.version).toBe("1.4");
    expect(listStepsForPipeline(handle.db, comments.id).map((step) => step.id)).toEqual(["pr_comments_plan", "pr_comments_review", "pr_comments_approve"]);
    expect(routeOf("default", "pull_request_watch", "author_commented")).toBe("todo");
    expect(routeOf("default", "pull_request_watch", "others_commented")).toBe("pr_comments_plan");
    expect(routeOf("default", "pull_request_watch", "changes_requested")).toBe("pr_comments_plan");
    expect(routeOf("default", "merge_request", "opened")).toBe("pull_request_reply");
    expect(routeOf(comments.id, "pr_comments_approve", "approved")).toBe("todo");
    expect(routeOf(comments.id, "pr_comments_approve", "rejected")).toBe("pull_request_reply");
    expect(errorsOf("default")).toEqual([]);
    expect(errorsOf(comments.id)).toEqual([]);
  });

  it("updates a Delivery with no edits of its own to 1.4, and makes the new board beside it", () => {
    deliveryOn13();

    const results = applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    expect(results).toEqual([expect.objectContaining({ pipelineId: "default", outcome: "applied", from: "1.3", to: "1.4" })]);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.4");
    expect(openUpdateConflict(handle.db, "default")).toBeUndefined();
    const comments = board()!;
    expect(getPipelineOrigin(handle.db, comments.id)?.version).toBe("1.4");
    expect(routeOf("default", "pull_request_watch", "others_commented")).toBe("pr_comments_plan");
    expect(routeOf("default", "pull_request_reply", "replied")).toBe("pull_request_watch");
    expect(routeOf(comments.id, "pr_comments_approve", "rejected")).toBe("pull_request_reply");
    expect(currentVersion(handle.db, "default")!.releaseNotes).toContain("Created the Pull request comments board this version adds.");
    // Made once: a later launch has nothing left to do.
    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toEqual([]);
    expect(listPipelines(handle.db).filter((pipeline) => pipeline.name === "Pull request comments")).toHaveLength(1);
  });

  it("makes the new board for a Delivery with edits of its own, and holds Delivery's update with a notice", () => {
    deliveryOn13();
    // The person's own edit, which 1.4 changes too: a request for changes goes to them rather than to the implementer.
    handle.db.run(sql`UPDATE step_routes SET target = 'user_attention' WHERE from_step_id = 'pull_request_watch' AND result_key = 'changes_requested'`);
    // Work on it, in a project for the notice to be about.
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    createTestItem(handle.db, { type: "story", title: "On it", stepId: "todo", projectId: project.id as Uuid });
    const stepsBefore = listStepsForPipeline(handle.db, "default");

    const results = applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    expect(results).toEqual([expect.objectContaining({ pipelineId: "default", outcome: "conflict", from: "1.3", to: "1.4" })]);
    expect(listStepsForPipeline(handle.db, "default")).toEqual(stepsBefore);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.3");
    expect(openUpdateConflict(handle.db, "default")?.conflicts).toEqual([
      expect.objectContaining({ key: { kind: "route", fromStepId: "pull_request_watch", resultKey: "changes_requested" } }),
    ]);

    const comments = board()!;
    expect(getPipelineOrigin(handle.db, comments.id)?.version).toBe("1.4");
    expect(routeOf(comments.id, "pr_comments_approve", "approved")).toBe("todo");
    // Reject goes to the reply step only the held update adds, so it is not offered until that update is resolved.
    expect(routeOf(comments.id, "pr_comments_approve", "rejected")).toBeUndefined();
    expect(getStep(handle.db, "pr_comments_approve")?.results.map((result) => result.key)).toEqual(["approved", "revise"]);
    expect(errorsOf(comments.id)).toEqual([]);

    const [notice] = messagesFrom(handle.db, "template_conflict");
    expect(notice?.body).toContain("EO created the **Pull request comments** board");
  });
});

/**
 * 1.5 (EO-921) limits Review → Changes requested to four rounds since a
 * person last commented. An installation on 1.4 gets the limit from this
 * update at launch; no migration edits its graph.
 */
describe("1.4 to 1.5: a limit on Review → Changes requested", () => {
  const sentBack = () => listRoutesForPipeline(handle.db, "default").find((route) => route.fromStepId === "review" && route.resultKey === "changes_requested");

  /** Delivery made from 1.4 and on it, as an installation that last launched before 1.5 shipped. */
  function deliveryOn14(): void {
    backfillPipelineOrigins(handle.db, upTo("1.4"));
    applyTemplateUpdates(handle.db, upTo("1.4"), { isTheRecord: false });
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.4");
    expect(sentBack()?.traversalLimit).toBeNull();
  }

  it("gives a new installation's Delivery the limit on its first launch, and no other route one", () => {
    const shippedHistory = templateHistoryUpTo(GALLERY_DIRECTORY, SOFTWARE, "1.5");
    backfillPipelineOrigins(handle.db, shippedHistory);

    expect(applyTemplateUpdates(handle.db, shippedHistory, { isTheRecord: false })).toEqual([expect.objectContaining({ pipelineId: "default", outcome: "applied", from: "1.1", to: "1.5" })]);
    expect(sentBack()?.traversalLimit).toBe(4);
    const limited = listPipelines(handle.db)
      .flatMap((pipeline) => listRoutesForPipeline(handle.db, pipeline.id))
      .filter((route) => route.traversalLimit !== null);
    expect(limited.map((route) => [route.fromStepId, route.resultKey, route.traversalLimit])).toEqual([["review", "changes_requested", 4]]);
  });

  it("sets the limit on a Delivery with no edits of its own, and says so in the version's release notes", () => {
    deliveryOn14();

    const results = applyTemplateUpdates(handle.db, upTo("1.5"), { isTheRecord: false });

    expect(results).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied", from: "1.4", to: "1.5" }));
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.5");
    expect(sentBack()).toMatchObject({ target: "todo", label: "Changes requested", traversalLimit: 4 });
    expect(currentVersion(handle.db, "default")!.releaseNotes).toContain("Review → Changes requested now has a limit");
    expect(applyTemplateUpdates(handle.db, upTo("1.5"), { isTheRecord: false })).toEqual([]);
  });

  it("holds the update where the person set a limit of their own on that route", () => {
    deliveryOn14();
    handle.db.run(sql`UPDATE step_routes SET traversal_limit = 7 WHERE from_step_id = 'review' AND result_key = 'changes_requested'`);
    handle.db.run(sql`UPDATE pipelines SET updated_at = updated_at + 1 WHERE id = 'default'`);

    const results = applyTemplateUpdates(handle.db, upTo("1.5"), { isTheRecord: false });

    expect(results).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "conflict", from: "1.4", to: "1.5" }));
    expect(sentBack()?.traversalLimit).toBe(7);
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.4");
    expect(openUpdateConflict(handle.db, "default")?.conflicts).toEqual([expect.objectContaining({ key: { kind: "route", fromStepId: "review", resultKey: "changes_requested" } })]);
  });
});
