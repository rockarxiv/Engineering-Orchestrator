import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuardConfigSchema, SkillDraftSchema, ipcContract, isDispatchable, NO_POLICY, PREVIEW_AGENT_KEY, NOT_ALLOWED_BY_YOUR_ORGANISATION, NO_WORKSPACE, resultsFromRoutes, USER_ATTENTION_TARGET } from "@eo/core";
import type { AgentDetail, IpcResponse, Uuid, PipelineStepView, StepRouteView } from "@eo/core";
import { TOOLS } from "../mcpHost/catalog.js";
import { writePolicy } from "../policy/policy.js";

/**
 * The agent a save wrote, or a thrown failure (EO-328).
 *
 * `agents:save` answers `{ saved, agent, problem }` since the
 * organisation's allowed-backends list gave it something it can refuse,
 * and every case below is a save that is meant to succeed — so the
 * unwrapping is here, once, and it is loud. A refusal here is a broken
 * test rather than a case to handle; the refusal that *is* the subject
 * has its own case, further down.
 */
function wrote(result: IpcResponse<"agents:save">): AgentDetail {
  if (!result.saved || result.agent === null) throw new Error(`the save was refused: ${result.problem ?? "no reason given"}`);
  return result.agent;
}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  addRepositoryToProjectCommand,
  createProjectCommand,
  listProjectsCommand,
  removeRepositoryFromProjectCommand,
  setActiveProjectCommand,
  updateProjectCommand,
} from "./projectCommands.js";
import {
  archiveAgent,
  archivePipeline,
  createPipeline,
  createJiraConnection,
  createProject,
  createRoute,
  deleteProject,
  createRun,
  createStep,
  getAgent,
  getItem,
  getRun,
  listActiveRuns,
  getJiraBinding,
  listAgents,
  listPipelineSteps,
  listStepsForPipeline,
  localPerson,
  postComment,
  replacePipelineGraph,
  saveJiraBinding,
  saveModule,
  setSetting,
  setItemArchived,
  suggestKeyPrefix,
  transitionItem,
} from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import {
  archiveAgentCommand,
  dailyBudgetDefaultApplies,
  deleteAgentCommand,
  DEFAULT_GUARD_CONFIG,
  listAgentDetails,
  readGuards,
  saveAgent,
  savePipeline,
  setAgentBinding,
  validatePipelineCommand,
  writeGuards,
} from "./configCommands.js";
import { getItemDetail, listItemSummaries, listPipelineStepViews } from "./domainQueries.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "./registry.js";
import { getAgentAttachments, setAgentAttachment } from "../db/repos/agentAttachmentsRepo.js";
import { getProject } from "../db/repos/projectsRepo.js";
import { saveSkill } from "../db/repos/skillsRepo.js";
import { createJob } from "../jobs/jobs.js";
import { mintWebhookSecret } from "../jobs/webhookSignature.js";
import { loadRolePrompt, promptHash, syncRolePrompts } from "../roles/prompts.js";
import { git } from "../packs/developer/workspace/git.js";
import {
  createRepositoryCommand,
  listRepositoriesCommand,
  removeRepositoryCommand,
  updateRepositoryCommand,
} from "./repositoryCommands.js";

let handle: DbHandle;

function currentStates(): PipelineStepView[] {
  return listPipelineStepViews(handle.db, { pipelineId: "default" }).steps;
}

function currentRoutes(): StepRouteView[] {
  return listPipelineStepViews(handle.db, { pipelineId: "default" }).routes;
}

/**
 * A submitted graph whose human steps declare exactly what they route
 * (EO-310).
 *
 * The step every *constructor* of a graph takes before submitting one:
 * the editor does it on publish, the architect's draft is turned into it,
 * and an imported document carries it. The commands deliberately do not
 * — a boundary that derived the declaration could not refuse a wrong one
 * — so a case about removing a step or renaming one has to do it here,
 * or it becomes a case about a declaration nobody meant to change.
 *
 * The cases that *are* about the declaration submit it by hand instead.
 */
function consistent(steps: PipelineStepView[], routes: StepRouteView[]): PipelineStepView[] {
  return steps.map((step) => ({ ...step, results: resultsFromRoutes(step, routes) }));
}

/**
 * The shipped routes with one step taken out (EO-423).
 *
 * Its own routes go with it, and whatever led to it leads to `instead`.
 * A case about removing a step used to submit no routes at all and let
 * every step walk to the next by position; an agent step now has to
 * route each result its action declares, so the graph a removal leaves
 * has to go on saying where a review's three verdicts go.
 */
function routesWithout(stepId: string, instead: string): StepRouteView[] {
  return currentRoutes()
    .filter((route) => route.fromStepId !== stepId)
    .map((route) => (route.target === stepId ? { ...route, target: instead } : route));
}

/** The shipped graph with `todo` removed: what led to it leads to Review. */
function withoutTodo(): { steps: PipelineStepView[]; routes: StepRouteView[] } {
  const routes = routesWithout("todo", "review");
  return { steps: consistent(currentStates().filter((state) => state.id !== "todo"), routes), routes };
}

const fakeEngine = () => ({ notifyStateChange: vi.fn() });

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

describe("guardrails", () => {
  it("start at the documented defaults, with concurrency 1 (§7)", () => {
    expect(readGuards(handle.db)).toEqual(DEFAULT_GUARD_CONFIG);
    expect(readGuards(handle.db).globalConcurrency).toBe(1);
  });

  it("round-trip and persist", () => {
    writeGuards(handle.db, { ...DEFAULT_GUARD_CONFIG, globalConcurrency: 3, dailyBudgetCents: 500 });

    expect(readGuards(handle.db)).toMatchObject({ globalConcurrency: 3, dailyBudgetCents: 500 });
  });

  /**
   * The guard the original design asked for "from the start, not after an incident"
   * (EO-211). A fresh install has a ceiling on the day without anybody
   * knowing to ask for one; the per-item budget stays unset, because
   * what a large story legitimately costs is not a figure EO can guess.
   */
  it("ships a daily spend ceiling and no per-item one", () => {
    expect(DEFAULT_GUARD_CONFIG.dailyBudgetCents).toBeGreaterThan(0);
    expect(DEFAULT_GUARD_CONFIG.perItemBudgetCents).toBeNull();

    expect(readGuards(handle.db).dailyBudgetCents).toBe(DEFAULT_GUARD_CONFIG.dailyBudgetCents);
    expect(readGuards(handle.db).perItemBudgetCents).toBeNull();
  });

  /**
   * A cleared field is a choice, and survives the upgrade (EO-211).
   *
   * The Guardrails screen writes an explicit null when somebody empties
   * the box, so a saved null is somebody saying "no ceiling" — not the
   * absence of an answer. Merging the default under it would overrule a
   * person, which is the one thing a default may never do.
   */
  it("keeps an explicitly cleared daily budget rather than replacing it with the default", () => {
    setSetting(handle.db, "engine.guards", { ...DEFAULT_GUARD_CONFIG, dailyBudgetCents: null });

    expect(readGuards(handle.db).dailyBudgetCents).toBeNull();
    expect(dailyBudgetDefaultApplies(handle.db)).toBe(false);
  });

  /** The other half: a config saved before the guard existed takes it. */
  it("gives a config that never mentioned a daily budget the default, and says so", () => {
    setSetting(handle.db, "engine.guards", { globalConcurrency: 2 });

    expect(readGuards(handle.db).dailyBudgetCents).toBe(DEFAULT_GUARD_CONFIG.dailyBudgetCents);
    expect(dailyBudgetDefaultApplies(handle.db)).toBe(true);
  });

  /**
   * Never opening the Guardrails screen is not a decision about the
   * daily budget (EO-211).
   *
   * An installation somebody has used for a year without touching
   * Settings has no saved row either, and it is precisely the one
   * running unbounded that the design wrote the guard for. Whether that is
   * *news* is a different question, and one this cannot answer — see
   * `guardDefaultNotice.ts`, which asks when the database was created.
   */
  it("counts an installation that never saved guardrails as running on the default", () => {
    expect(dailyBudgetDefaultApplies(handle.db)).toBe(true);
  });

  it("fills in a guard that did not exist when the config was saved", () => {
    // A stored config from an older version must not leave a newly added
    // guard undefined — that would disable it silently.
    setSetting(handle.db, "engine.guards", { globalConcurrency: 2 });

    expect(readGuards(handle.db)).toMatchObject({ globalConcurrency: 2, perItemAttemptLimit: DEFAULT_GUARD_CONFIG.perItemAttemptLimit });
  });

  /**
   * The design's mention-depth cap, as a setting (EO-212).
   *
   * Validated by the channel schema like every other guard, which is
   * what stops a zero — "no agent may ever answer another" — or a
   * fraction reaching the count that reads it.
   */
  it("caps agent-to-agent mentions at three, and refuses a depth that is not a whole number of hops", () => {
    expect(readGuards(handle.db).agentMentionDepth).toBe(3);

    expect(GuardConfigSchema.safeParse({ ...DEFAULT_GUARD_CONFIG, agentMentionDepth: 5 }).success).toBe(true);
    expect(GuardConfigSchema.safeParse({ ...DEFAULT_GUARD_CONFIG, agentMentionDepth: 0 }).success).toBe(false);
    expect(GuardConfigSchema.safeParse({ ...DEFAULT_GUARD_CONFIG, agentMentionDepth: 2.5 }).success).toBe(false);
    expect(GuardConfigSchema.safeParse({ ...DEFAULT_GUARD_CONFIG, agentMentionDepth: 21 }).success).toBe(false);
  });

  /** Each memory scope's caps (EO-480): guardrails like the rest, and filled in for a config saved before they existed. */
  it("caps each memory scope at 200 entries and 40,000 characters by default, and refuses a cap that is not a positive whole number", () => {
    setSetting(handle.db, "engine.guards", { globalConcurrency: 2 });
    expect(readGuards(handle.db)).toMatchObject({ memoryScopeMaxEntries: 200, memoryScopeMaxChars: 40_000 });

    expect(GuardConfigSchema.safeParse({ ...DEFAULT_GUARD_CONFIG, memoryScopeMaxEntries: 300, memoryScopeMaxChars: 60_000 }).success).toBe(true);
    expect(GuardConfigSchema.safeParse({ ...DEFAULT_GUARD_CONFIG, memoryScopeMaxEntries: 0 }).success).toBe(false);
    expect(GuardConfigSchema.safeParse({ ...DEFAULT_GUARD_CONFIG, memoryScopeMaxChars: 2.5 }).success).toBe(false);
  });

  /** An agent's unused skill (EO-720): stale after 20 runs without a load and archived after 50, filled in for an older config, and never archived before it is stale. */
  it("ages an agent's unused skill by 20 and 50 runs by default, and refuses an archive count below the stale count", () => {
    setSetting(handle.db, "engine.guards", { globalConcurrency: 2 });
    expect(readGuards(handle.db)).toMatchObject({ skillStaleAfterRuns: 20, skillArchiveAfterRuns: 50 });
    expect(GuardConfigSchema.safeParse({ ...DEFAULT_GUARD_CONFIG, skillStaleAfterRuns: 0 }).success).toBe(false);

    const refused = writeGuards(handle.db, { ...DEFAULT_GUARD_CONFIG, skillStaleAfterRuns: 30, skillArchiveAfterRuns: 10 });
    expect(refused.saved).toBe(false);
    expect(refused.problems.join(" ")).toMatch(/archived after 10 runs .* stale at 30/);

    expect(writeGuards(handle.db, { ...DEFAULT_GUARD_CONFIG, skillStaleAfterRuns: 5, skillArchiveAfterRuns: 8 }).saved).toBe(true);
    expect(readGuards(handle.db)).toMatchObject({ skillStaleAfterRuns: 5, skillArchiveAfterRuns: 8 });
  });

  it("says it saved, and what the limits now are", () => {
    const written = writeGuards(handle.db, { ...DEFAULT_GUARD_CONFIG, dailyBudgetCents: 500 });

    expect(written.saved).toBe(true);
    expect(written.problems).toEqual([]);
    expect(written.guards.dailyBudgetCents).toBe(500);
  });

  /**
   * The other half of the bound on a module step's time limit (EO-162).
   *
   * `validatePipeline` refuses a step that asks for longer than the run
   * timeout. Nothing stopped somebody arriving at the same contradiction
   * from this side — lower the run timeout afterwards and one of the two
   * numbers is a thing a person set that EO does not do. Refused here as
   * well, so stored state can never hold the pair, and dispatch never has
   * to decide which of them wins.
   */
  it("refuses a run timeout shorter than a module step's own limit, and writes nothing", () => {
    createStep(handle.db, {
      id: "merge_slow",
      pipelineId: "default" as Uuid,
      position: 40,
      name: "Merge",
      type: "module",
      entryAction: "some-module",
      timeoutMs: 20 * 60_000,
    });

    const written = writeGuards(handle.db, { ...DEFAULT_GUARD_CONFIG, wallClockTimeoutMs: 5 * 60_000 });

    expect(written.saved).toBe(false);
    expect(written.problems.join("\n")).toContain("Merge");
    expect(written.problems.join("\n")).toContain("20 minutes");
    // Nothing written — not the timeout, and not the fields that came
    // with it. A half-applied refusal is its own quiet surprise.
    expect(readGuards(handle.db)).toEqual(DEFAULT_GUARD_CONFIG);
    // And the answer says what is actually stored, so a screen redrawing
    // from it redraws the truth.
    expect(written.guards).toEqual(DEFAULT_GUARD_CONFIG);
  });

  it("accepts a run timeout that still covers every configured step", () => {
    createStep(handle.db, {
      id: "merge_ok",
      pipelineId: "default" as Uuid,
      position: 41,
      name: "Merge",
      type: "module",
      entryAction: "some-module",
      timeoutMs: 20 * 60_000,
    });

    expect(writeGuards(handle.db, { ...DEFAULT_GUARD_CONFIG, wallClockTimeoutMs: 25 * 60_000 }).saved).toBe(true);
    expect(readGuards(handle.db).wallClockTimeoutMs).toBe(25 * 60_000);
  });
});

/**
 * Publishing a step's own time limit (EO-162).
 *
 * Through `savePipeline` rather than the validator alone, because what
 * was missing before this story is exactly this wiring: a number that
 * validates, is stored, and is the number the step actually runs with.
 */
/**
 * Publishing must not unname the person a human step waits on (EO-302).
 *
 * The regression, exactly: `toDomainSteps` has to satisfy
 * `PipelineStep`, so it filled `ownerPersonId` in with null — and its
 * result went on to `replacePipelineGraph`, where `null` is a caller
 * *asking* to clear rather than a caller with nothing to say. The
 * screen that picks a person is 7b's and the editor's payload has no
 * such field, so there was no way to put the owner back and nothing in
 * the record to say it had gone.
 *
 * What makes it worth a test at this level rather than at the
 * repository's: every part below this boundary was already right. The
 * three-way distinction is in `CreateStepInput`, `replacePipelineGraph`
 * honours it, and `pipelineStepsRepo.test.ts` proves both directions.
 * The bug was one layer up, in the translation — which is where a
 * field that exists on the domain type and not on the wire will always
 * go wrong.
 */
describe("a human step's owner, across an ordinary publish", () => {
  /** The editor's own graph, read back exactly as the screen submits it. */
  const editorGraph = () => ({
    pipelineId: "default",
    steps: currentStates(),
    routes: currentRoutes(),
    entryStepId: "worktree",
  });

  function nameTheOwner(stepId: string, personId: Uuid): void {
    // Through the repository API, which is the only way to set one
    // today — and precisely the case the review describes: an owner
    // that exists, put there by something other than this screen.
    const graph = replacePipelineGraph(
      handle.db,
      "default",
      currentStates().map((step) => ({
        ...step,
        pipelineId: "default" as Uuid,
        ...(step.id === stepId ? { ownerPersonId: personId } : {}),
      })),
      currentRoutes().map((route) => ({ ...route, pipelineId: "default" as Uuid })),
    );
    expect(graph.replaced).toBe(true);
    expect(listPipelineSteps(handle.db).find((step) => step.id === stepId)?.ownerPersonId).toBe(personId);
  }

  it("survives a publish that says nothing about it", () => {
    const person = localPerson(handle.db).id;
    nameTheOwner("review", person);

    expect(savePipeline(handle.db, fakeEngine(), editorGraph()).saved).toBe(true);

    expect(listPipelineSteps(handle.db).find((step) => step.id === "review")?.ownerPersonId).toBe(person);
  });

  it("survives a publish that changes an unrelated setting on the very same step", () => {
    // The case a person actually hits: they open the pipeline to rename
    // a column or tick plan mode, and the step they touch is the one
    // somebody is assigned to.
    const person = localPerson(handle.db).id;
    nameTheOwner("review", person);

    const edited = editorGraph();
    const result = savePipeline(handle.db, fakeEngine(), {
      ...edited,
      steps: edited.steps.map((step) => (step.id === "review" ? { ...step, name: "Second pair of eyes", planMode: true } : step)),
    });
    expect(result.saved).toBe(true);

    const step = listPipelineSteps(handle.db).find((entry) => entry.id === "review");
    expect(step?.name).toBe("Second pair of eyes"); // the edit landed
    expect(step?.planMode).toBe(true);
    expect(step?.ownerPersonId).toBe(person); // and took nothing with it
  });

  it("survives repeated publishes, so it is not lost on the second one", () => {
    // A field cleared on the *first* save would fail the tests above; a
    // field cleared once the row exists in its final shape would not.
    const person = localPerson(handle.db).id;
    nameTheOwner("review", person);

    for (let i = 0; i < 3; i += 1) expect(savePipeline(handle.db, fakeEngine(), editorGraph()).saved).toBe(true);

    expect(listPipelineSteps(handle.db).find((step) => step.id === "review")?.ownerPersonId).toBe(person);
  });
});

describe("a module step's time limit", () => {
  function moduleStep(timeoutMs: number | null): PipelineStepView {
    const saved = saveModule(handle.db, {
      slug: "merge",
      name: "Merge",
      description: "Waits for CI and merges.",
      code: "export default async function run() { return { ok: true, result: 'merged', detail: '' }; }",
      manifest: {
        name: "Merge",
        description: "Waits for CI and merges.",
        inputs: {},
        needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
        results: ["merged"],
      },
      approve: true,
    });
    if (!saved.ok) throw new Error(saved.reason);
    return {
      id: "merge_step",
      pipelineId: "default",
      position: 0,
      name: "Merge",
      type: "module",
      ownerRole: null,
      entryAction: saved.module.id,
      instructionsSummary: null,
      isTerminal: false,
      planMode: false,
      workspaceMode: "isolated" as const,
      workspaceId: null,
      inputs: {},
      timeoutMs,
      watch: null,
      results: [],
    };
  }

  function publish(step: PipelineStepView) {
    const steps = [step, ...currentStates().map((current) => ({ ...current, position: current.position + 1 }))];
    return savePipeline(handle.db, fakeEngine(), {
      pipelineId: "default",
      steps,
      routes: [...currentRoutes(), { id: "r-merge", pipelineId: "default", fromStepId: "merge_step", resultKey: "merged", label: "Merged", tone: "info" as const, target: "worktree", position: 0 }],
      entryStepId: "merge_step",
    });
  }

  it("stores a raised value, and stores the number that was asked for", () => {
    expect(publish(moduleStep(20 * 60_000)).saved).toBe(true);

    // The point of the whole story: what comes back out is what went in.
    expect(listPipelineSteps(handle.db).find((step) => step.id === "merge_step")?.timeoutMs).toBe(20 * 60_000);
  });

  it("leaves a step that configures nothing on EO's default", () => {
    expect(publish(moduleStep(null)).saved).toBe(true);
    expect(listPipelineSteps(handle.db).find((step) => step.id === "merge_step")?.timeoutMs).toBeNull();
  });

  it("refuses a value longer than the run timeout instead of storing a smaller one", () => {
    writeGuards(handle.db, { ...DEFAULT_GUARD_CONFIG, wallClockTimeoutMs: 15 * 60_000 });

    const result = publish(moduleStep(40 * 60_000));

    expect(result.saved).toBe(false);
    expect(result.problems.map((problem) => problem.message).join("\n")).toContain("15 minutes");
    // Nothing stored at all — not the 40, and not a floored 15.
    expect(listPipelineSteps(handle.db).find((step) => step.id === "merge_step")).toBeUndefined();
  });

  it("accepts the same value once the run timeout has been raised to cover it", () => {
    expect(writeGuards(handle.db, { ...DEFAULT_GUARD_CONFIG, wallClockTimeoutMs: 45 * 60_000 }).saved).toBe(true);

    expect(publish(moduleStep(40 * 60_000)).saved).toBe(true);
    expect(listPipelineSteps(handle.db).find((step) => step.id === "merge_step")?.timeoutMs).toBe(40 * 60_000);
  });
});

describe("agents", () => {
  it("creates a new role, which is what makes roles configuration rather than code (§5)", () => {
    const created = saveAgent(handle.db, {
      name: "Tester",
      role: "tester",
      provider: "fake",
      model: null,
      instructions: "Run the suite and report.",
      enabled: true,
      config: {},
    });

    expect(wrote(created).role).toBe("tester");
    expect(listAgents(handle.db).some((agent) => agent.role === "tester")).toBe(true);
  });

  /**
   * Every agent whose runs are given memory scopes may write to them
   * (EO-593): a new agent is given `memory_note` whatever its role and
   * whoever wrote its instructions — the implementer, reviewer and system
   * agent as since EO-514, and now every other role too — and an edit
   * taking it away holds.
   */
  it("gives a new agent of any role memory_note, and an edit taking it away holds", () => {
    const create = (role: string, config?: Record<string, unknown>) =>
      wrote(saveAgent(handle.db, { name: `New ${role}`, role, provider: "fake", model: null, instructions: "Work.", enabled: true, ...(config === undefined ? {} : { config }) }));

    expect(create("implementer").id).toBeDefined();
    const configOf = (role: string) => listAgents(handle.db).find((agent) => agent.name === `New ${role}`)!.config;
    expect(configOf("implementer")).toEqual({ allowedTools: ["mcp__eo__memory_note"] });
    create("reviewer", { allowedTools: ["Read"], effort: "high" });
    expect(configOf("reviewer")).toEqual({ allowedTools: ["Read", "mcp__eo__memory_note"], effort: "high" });
    create("system", { allowedTools: ["mcp__eo_admin", "memory_note"] });
    expect(configOf("system")).toEqual({ allowedTools: ["mcp__eo_admin", "memory_note"] });
    create("tester", {});
    expect(configOf("tester")).toEqual({ allowedTools: ["mcp__eo__memory_note"] });
    create("editor", { allowedTools: ["Read"] });
    expect(configOf("editor")).toEqual({ allowedTools: ["Read", "mcp__eo__memory_note"] });
    // Somebody's own shape for the field is theirs to fix, and left.
    create("translator", { allowedTools: "everything" });
    expect(configOf("translator")).toEqual({ allowedTools: "everything" });

    // Taken away on an edit, and kept away by the next one.
    for (const name of ["New implementer", "New tester"]) {
      const agent = listAgentDetails(handle.db).agents.find((candidate) => candidate.name === name)!;
      saveAgent(handle.db, { ...agent, config: {} });
      saveAgent(handle.db, { ...agent, config: {} });
    }
    expect(configOf("implementer")).toEqual({});
    expect(configOf("tester")).toEqual({});
    // Only from those two.
    expect(configOf("editor")).toEqual({ allowedTools: ["Read", "mcp__eo__memory_note"] });
  });

  it("leaves a config it was not sent where it is, rather than emptying it (EO-185)", () => {
    // `config` used to be declared with `.default({})`, which made "I am
    // not changing the config" and "delete the config" the same request.
    // What that cost was not hypothetical: EO's own system agent lost an
    // `allowedTools` five migrations had built up — and with it
    // `thread_read`, the five configuration reads and the grant that
    // reaches `eo_admin` — to a save that only meant to set an effort.
    const existing = listAgentDetails(handle.db).agents.find((agent) => agent.role === "implementer")!;
    saveAgent(handle.db, { ...existing, config: { allowedTools: ["Read", "mcp__eo_admin"], effort: "high" } });

    // Through the schema, because that is where the default was: absent
    // has to survive the parse as absent or the handler never sees the
    // difference between the two requests.
    const parsed = ipcContract["agents:save"].request.parse({
      id: existing.id,
      name: existing.name,
      role: existing.role,
      provider: existing.provider,
      instructions: existing.instructions,
    });
    expect(parsed.config).toBeUndefined();

    saveAgent(handle.db, parsed);

    expect(listAgents(handle.db).find((agent) => agent.id === existing.id)?.config).toEqual({
      allowedTools: ["Read", "mcp__eo_admin"],
      effort: "high",
    });
  });

  it("replaces the config it was sent, so the editor can still take a key away", () => {
    // The other half, and the reason this channel is not a merge: the
    // Agents screen holds the whole config in front of it, and unticking
    // a box is expressed by the key being gone. Merging here would leave
    // no way to remove one from the surface that exists to remove it. A
    // caller holding only part of a config wants `agent_save` over MCP.
    const existing = listAgentDetails(handle.db).agents.find((agent) => agent.role === "reviewer")!;
    saveAgent(handle.db, { ...existing, config: { effort: "high", inheritAmbientConfig: true } });

    saveAgent(handle.db, { ...existing, config: { effort: "high" } });

    expect(listAgents(handle.db).find((agent) => agent.id === existing.id)?.config).toEqual({ effort: "high" });
  });

  it("edits instructions in place, for the next dispatch to read", () => {
    const existing = listAgentDetails(handle.db).agents.find((agent) => agent.role === "implementer")!;

    saveAgent(handle.db, { ...existing, instructions: "Be extremely careful." });

    const updated = listAgentDetails(handle.db).agents.find((agent) => agent.id === existing.id)!;
    expect(updated.instructions).toBe("Be extremely careful.");
  });

  it("switches an existing agent to another backend (U-06, A-06)", () => {
    // The save payload always carried `provider` and the update path
    // dropped it, so a seeded agent could never be pointed at a backend
    // the user had actually signed into — with no error to say so.
    const existing = listAgentDetails(handle.db).agents.find((agent) => agent.role === "reviewer")!;

    saveAgent(handle.db, { ...existing, provider: "claude" });

    const updated = listAgentDetails(handle.db).agents.find((agent) => agent.id === existing.id)!;
    expect(updated.provider).toBe("claude");
    expect(updated.role).toBe("reviewer"); // role is what the workflow dispatches against; only the backend moved
  });

  it("marks instructions a human saved as theirs, so no later default overwrites them", () => {
    const existing = listAgentDetails(handle.db).agents.find((agent) => agent.role === "implementer")!;

    saveAgent(handle.db, { ...existing, instructions: "Be extremely careful." });

    // Null provenance is the whole guarantee behind U-06: `syncRolePrompts`
    // updates what EO wrote and nothing else.
    expect(listAgents(handle.db).find((agent) => agent.id === existing.id)?.promptHash).toBeNull();
    syncRolePrompts(handle.db);
    expect(listAgents(handle.db).find((agent) => agent.id === existing.id)?.instructions).toBe("Be extremely careful.");
  });

  it("treats saving the shipped default unchanged as EO's text, not an edit", () => {
    const existing = listAgentDetails(handle.db).agents.find((agent) => agent.role === "implementer")!;

    // Pressing Save on the default — via the editor's "Load default" —
    // must not strand this agent on today's version forever.
    saveAgent(handle.db, { ...existing, instructions: loadRolePrompt("implementer")! });

    expect(listAgents(handle.db).find((agent) => agent.id === existing.id)?.promptHash).toBe(promptHash(loadRolePrompt("implementer")!));
  });

  it("offers the shipped default beside whatever the agent is running", () => {
    const implementer = listAgentDetails(handle.db).agents.find((agent) => agent.role === "implementer")!;
    expect(implementer.defaultInstructions).toBe(loadRolePrompt("implementer"));

    // A role EO ships no prompt for has nothing to offer, and says so
    // rather than offering an empty one.
    saveAgent(handle.db, { name: "Tester", role: "tester", provider: "fake", model: null, instructions: "Run the suite.", enabled: true, config: {} });
    expect(listAgentDetails(handle.db).agents.find((agent) => agent.role === "tester")?.defaultInstructions).toBeNull();
  });

  /**
   * Built-in-ness, said outright rather than inferred (EO-178).
   *
   * The Agents editor draws no thread-reuse checkbox for a role EO
   * ships, because EO has already decided it — so the answer has to
   * cross IPC. `defaultInstructions !== null` gives the same answer
   * today and gives it by accident: that field says "EO ships a prompt
   * for this role", and the two part company the day a shipped role
   * arrives without one.
   */
  it("says on the wire which roles EO ships", () => {
    const details = listAgentDetails(handle.db).agents;

    for (const role of ["system", "implementer", "reviewer"]) {
      expect(details.find((agent) => agent.role === role)?.builtin, role).toBe(true);
    }

    // And the row 0062 retired is not, which is the same rule read the
    // other way: `pipeline_architect` is no longer a role EO ships, so
    // the disabled row left behind reads as somebody's own agent. Nothing
    // dispatches to it, so what that costs is a thread-reuse checkbox on
    // an agent that is switched off.
    expect(details.find((agent) => agent.role === "pipeline_architect")?.builtin).toBe(false);

    // And a role somebody invented is not, on the way in and on the way
    // back out — the editor acts on the save response as readily as on
    // the list.
    const saved = saveAgent(handle.db, {
      name: "Tester", role: "tester", provider: "fake", model: null, instructions: "Run the suite.", enabled: true, config: {},
    });
    expect(wrote(saved).builtin).toBe(false);
    expect(listAgentDetails(handle.db).agents.find((agent) => agent.role === "tester")?.builtin).toBe(false);
  });

  /**
   * The whole agent surface, listed (EO-178, EO-186, EO-350).
   *
   * Deleting an agent exists now, and it came in through one door with
   * one confirmation: `agents:delete` and `agent_delete`, which answer
   * with what would be affected until the call confirms. Anything else
   * that could remove or retire an agent has to be added here by name,
   * so it cannot arrive without that confirmation unnoticed.
   *
   * `agent_attachments_*` is about what an agent is *given*, not about
   * the agent, and `set` there replaces a list rather than removing a
   * row.
   */
  it("lists every channel and tool that touches an agent", () => {
    const aboutAnAgent = /agent/i;
    const attachments = /^agent_?[aA]ttachments/;

    const channels = Object.keys(ipcContract).filter((name) => !attachments.test(name));
    const tools = TOOLS.map((tool) => tool.name).filter((name) => !attachments.test(name));

    expect(channels.filter((name) => aboutAnAgent.test(name)).sort()).toEqual([
      "agents:archive",
      // A project's own copy of a global agent (EO-475). It only ever
      // creates — the original is read and left as it was — so it
      // removes and retires nothing.
      "agents:customise",
      "agents:delete",
      "agents:list",
      "agents:listDetailed",
      "agents:save",
      // Which backend and model *this machine* runs an agent on
      // (EO-329, ARCHITECTURE.md, "An agent is a row"). A write, and the narrowest one on the
      // surface:
      // it cannot express a name, a role, a prompt or a tool surface,
      // and it refuses an id no agent here has rather than creating
      // one.
      "agents:setBinding",
    ]);
    expect(tools.filter((name) => aboutAnAgent.test(name)).sort()).toEqual(["agent_archive", "agent_delete", "agent_save", "agents_list"]);

    // And saving is create-or-update: saving an agent that is already
    // there leaves the count where it was.
    const before = listAgents(handle.db).length;
    const existing = listAgentDetails(handle.db).agents.find((agent) => agent.role === "reviewer")!;
    saveAgent(handle.db, { ...existing, name: "Renamed" });
    expect(listAgents(handle.db).length).toBe(before);
  });

  it("disabling an agent leaves its role unstaffed, which the workflow validator notices", () => {
    const existing = listAgentDetails(handle.db).agents.find((agent) => agent.role === "reviewer")!;
    saveAgent(handle.db, { ...existing, enabled: false });

    const { problems } = validatePipelineCommand(handle.db, { pipelineId: "default", steps: currentStates(), routes: currentRoutes(), entryStepId: "worktree" });
    expect(problems.some((problem) => problem.message.includes("reviewer") && problem.message.includes("no enabled agent"))).toBe(true);
  });

  it("answers with the steps it would leave with nobody, and archives nothing, until the call confirms", () => {
    // What used to be an outright refusal (EO-186) is now the
    // confirmation (EO-350): the last enabled reviewer is still named as
    // leaving the Review step with nobody, and a person who has read
    // that may go ahead.
    const reviewer = listAgentDetails(handle.db).agents.find((agent) => agent.role === "reviewer")!;
    const owned = listPipelineSteps(handle.db).filter((step) => step.type === "agent" && step.ownerRole === "reviewer");
    expect(owned.length).toBeGreaterThan(0);

    const asked = archiveAgentCommand(handle.db, { id: reviewer.id, confirm: false });

    expect(asked.archived).toBe(false);
    expect(asked.problem).toBeNull();
    expect(asked.impact?.leavesStepsWithNobody).toBe(true);
    expect(asked.impact?.coveredBy).toEqual([]);
    expect(asked.impact?.steps.map((step) => step.stepName).sort()).toEqual(owned.map((step) => step.name).sort());
    // Each step with the pipeline it is in, by name.
    expect(asked.impact?.steps.every((step) => step.pipelineName.length > 0)).toBe(true);
    expect(listAgents(handle.db).find((agent) => agent.id === reviewer.id)!.archivedAt).toBeNull();

    const confirmed = archiveAgentCommand(handle.db, { id: reviewer.id, confirm: true });

    expect(confirmed.archived).toBe(true);
    expect(listAgents(handle.db).find((agent) => agent.id === reviewer.id)!.archivedAt).not.toBeNull();
    // Which is the state the validator reports, now arrived at on purpose.
    const { problems } = validatePipelineCommand(handle.db, { pipelineId: "default", steps: currentStates(), routes: currentRoutes(), entryStepId: "worktree" });
    expect(problems.some((problem) => problem.message.includes("reviewer") && problem.message.includes("no enabled agent"))).toBe(true);
  });

  it("says who still covers the role when another enabled agent holds it", () => {
    const second = wrote(saveAgent(handle.db, { name: "Second Reviewer", role: "reviewer", provider: "fake", model: null, instructions: "x", enabled: true, config: {} }));
    const first = listAgentDetails(handle.db).agents.find((agent) => agent.role === "reviewer" && agent.id !== second.id)!;

    const asked = archiveAgentCommand(handle.db, { id: first.id, confirm: false });

    expect(asked.impact?.leavesStepsWithNobody).toBe(false);
    expect(asked.impact?.coveredBy).toEqual(["Second Reviewer"]);
    expect(asked.impact?.steps.length).toBeGreaterThan(0);
    expect(archiveAgentCommand(handle.db, { id: first.id, confirm: true }).archived).toBe(true);
    // …and now the second one is the last, which the next answer says.
    expect(archiveAgentCommand(handle.db, { id: second.id, confirm: false }).impact?.leavesStepsWithNobody).toBe(true);
  });

  it("names no steps for a role no step is owned by", () => {
    const spare = wrote(saveAgent(handle.db, { name: "Tester", role: "tester", provider: "fake", model: null, instructions: "x", enabled: true, config: {} }));

    const asked = archiveAgentCommand(handle.db, { id: spare.id, confirm: false });
    expect(asked.impact).toMatchObject({ steps: [], leavesStepsWithNobody: false, activeRuns: [], lastSystemAgent: false });
    expect(archiveAgentCommand(handle.db, { id: spare.id, confirm: true })).toMatchObject({ archived: true, problem: null });
  });

  it("does not warn about steps for a disabled agent, because it staffs nothing already", () => {
    const reviewer = listAgentDetails(handle.db).agents.find((agent) => agent.role === "reviewer")!;
    saveAgent(handle.db, { ...reviewer, enabled: false });

    expect(archiveAgentCommand(handle.db, { id: reviewer.id, confirm: false }).impact?.leavesStepsWithNobody).toBe(false);
  });

  it("never counts the gallery's preview agent as staffing a step, on either side (EO-316)", () => {
    // The preview's own agent runs rehearsals only. Archiving or deleting
    // it must not warn that the role's steps go empty…
    const reviewer = listAgentDetails(handle.db).agents.find((agent) => agent.role === "reviewer")!;
    const preview = wrote(
      saveAgent(handle.db, { name: "reviewer (preview)", role: "reviewer", provider: "fake", model: null, instructions: "x", enabled: true, config: { [PREVIEW_AGENT_KEY]: true } }),
    );

    expect(archiveAgentCommand(handle.db, { id: preview.id, confirm: false }).impact).toMatchObject({ leavesStepsWithNobody: false, coveredBy: [reviewer.name] });
    expect(deleteAgentCommand(handle.db, { id: preview.id, confirm: false }).impact?.leavesStepsWithNobody).toBe(false);

    // …even when it is the only *enabled* agent on the role, which is the
    // case that used to be refused as "the only enabled agent".
    saveAgent(handle.db, { ...reviewer, enabled: false });
    const alone = archiveAgentCommand(handle.db, { id: preview.id, confirm: false });
    expect(alone.impact?.leavesStepsWithNobody).toBe(false);
    expect(alone.impact?.coveredBy).toEqual([]);
    expect(deleteAgentCommand(handle.db, { id: preview.id, confirm: false }).impact?.leavesStepsWithNobody).toBe(false);

    // And it is not who covers the role when the real one goes.
    saveAgent(handle.db, { ...reviewer, enabled: true });
    expect(archiveAgentCommand(handle.db, { id: reviewer.id, confirm: false }).impact).toMatchObject({ leavesStepsWithNobody: true, coveredBy: [] });

    expect(archiveAgentCommand(handle.db, { id: preview.id, confirm: true }).archived).toBe(true);
  });

  it("names the item a run in progress is on, and cancels it as superseded only when confirmed", () => {
    const implementer = listAgentDetails(handle.db).agents.find((agent) => agent.role === "implementer")!;
    const item = createTestItem(handle.db, { type: "story", title: "Being built", stepId: "todo" });
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id as Uuid, action: "implement", status: "running" });
    const engine = { cancelRun: vi.fn() };

    const asked = archiveAgentCommand(handle.db, { id: implementer.id, confirm: false }, engine);
    expect(asked.impact?.activeRuns).toEqual([{ runId: run.id, itemId: item.id, itemKey: item.key, itemTitle: "Being built" }]);
    expect(engine.cancelRun).not.toHaveBeenCalled();

    expect(archiveAgentCommand(handle.db, { id: implementer.id, confirm: true }, engine).archived).toBe(true);
    expect(engine.cancelRun).toHaveBeenCalledWith(run.id, "superseded");
  });

  it("leaves no run it named looking active, including a queued one nothing is driving", () => {
    // `cancelRun` does nothing for a run it has no controller for — the
    // spy below stands in for exactly that. The confirmation promised
    // both runs would stop, so both rows end `cancelled`.
    const implementer = listAgentDetails(handle.db).agents.find((agent) => agent.role === "implementer")!;
    const first = createTestItem(handle.db, { type: "story", title: "Queued", stepId: "todo" });
    const second = createTestItem(handle.db, { type: "story", title: "Running", stepId: "todo" });
    const queued = createRun(handle.db, { itemId: first.id, agentId: implementer.id as Uuid, action: "implement", status: "queued" });
    const running = createRun(handle.db, { itemId: second.id, agentId: implementer.id as Uuid, action: "implement", status: "running" });
    const engine = { cancelRun: vi.fn() };

    const asked = deleteAgentCommand(handle.db, { id: implementer.id, confirm: false }, engine);
    expect(asked.impact?.activeRuns.map((run) => run.runId).sort()).toEqual([queued.id, running.id].sort());
    expect(getRun(handle.db, queued.id)?.status).toBe("queued");

    expect(deleteAgentCommand(handle.db, { id: implementer.id, confirm: true }, engine).deleted).toBe(true);

    expect(engine.cancelRun).toHaveBeenCalledWith(queued.id, "superseded");
    expect(getRun(handle.db, queued.id)?.status).toBe("cancelled");
    expect(getRun(handle.db, running.id)?.status).toBe("cancelled");
    expect(listActiveRuns(handle.db).filter((run) => run.agentId === implementer.id)).toEqual([]);
  });

  it("names the role's steps in archived pipelines too", () => {
    const retired = createPipeline(handle.db, { projectId: null, name: "Old Review" });
    createStep(handle.db, { pipelineId: retired.id, position: 0, name: "Second look", type: "agent", ownerRole: "reviewer" });
    archivePipeline(handle.db, retired.id);
    const reviewer = listAgentDetails(handle.db).agents.find((agent) => agent.role === "reviewer")!;

    const steps = archiveAgentCommand(handle.db, { id: reviewer.id, confirm: false }).impact?.steps ?? [];

    expect(steps).toContainEqual(expect.objectContaining({ stepName: "Second look", pipelineName: "Old Review", pipelineId: retired.id }));
  });

  it("says when the last enabled system agent would leave the Assistant and Discussions with nobody", () => {
    const system = listAgentDetails(handle.db).agents.find((agent) => agent.role === "system" && agent.archivedAt === null && agent.enabled)!;

    expect(deleteAgentCommand(handle.db, { id: system.id, confirm: false }).impact?.lastSystemAgent).toBe(true);

    wrote(saveAgent(handle.db, { name: "Second System", role: "system", provider: "fake", model: null, instructions: "x", enabled: true, config: {} }));
    expect(deleteAgentCommand(handle.db, { id: system.id, confirm: false }).impact?.lastSystemAgent).toBe(false);
  });

  it("answers as a sentence when the agent is not there, rather than throwing", () => {
    expect(archiveAgentCommand(handle.db, { id: "019fb8c6-de91-7cdd-b0c6-00000000dead", confirm: true })).toEqual({
      archived: false,
      problem: "That agent no longer exists.",
      impact: null,
    });
    expect(deleteAgentCommand(handle.db, { id: "019fb8c6-de91-7cdd-b0c6-00000000dead", confirm: true })).toEqual({
      deleted: false,
      problem: "That agent no longer exists.",
      impact: null,
    });
  });

  it("does not count an archived agent towards its role having an enabled agent", () => {
    // The other half of the same rule, on the validator's side (EO-186).
    // An archived agent that still counted would leave a step reported
    // as fine and dispatching nothing — the failure both this warning
    // and `no_enabled_agent` exist to make loud.
    const second = wrote(saveAgent(handle.db, { name: "Second Reviewer", role: "reviewer", provider: "fake", model: null, instructions: "x", enabled: true, config: {} }));
    const first = listAgentDetails(handle.db).agents.find((agent) => agent.role === "reviewer" && agent.id !== second.id)!;
    archiveAgentCommand(handle.db, { id: first.id, confirm: true });
    // Leaving the second one enabled and archived is not something the
    // command will do — it is the last holder — so the row is stamped
    // directly. Which is the case worth testing: `enabled` alone says
    // this role is staffed, and it is not.
    archiveAgent(handle.db, second.id as Uuid);

    const { problems } = validatePipelineCommand(handle.db, { pipelineId: "default", steps: currentStates(), routes: currentRoutes(), entryStepId: "worktree" });

    expect(problems.some((problem) => problem.message.includes("reviewer") && problem.message.includes("no enabled agent"))).toBe(true);
  });
});

/**
 * Deleting an agent (EO-350).
 *
 * A tombstone rather than a hole: `runs.agent_id` references the row, so
 * an agent that has run cannot lose it, and its runs and comments must
 * still say who did them.
 */
describe("deleting an agent", () => {
  it("deletes an agent with run history, and its runs and comments keep its name", () => {
    const implementer = listAgentDetails(handle.db).agents.find((agent) => agent.role === "implementer")!;
    const item = createTestItem(handle.db, { type: "story", title: "Built once", stepId: "todo" });
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id as Uuid, action: "implement", status: "succeeded" });
    postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: implementer.id as Uuid }, body: "Done.", runId: run.id });

    // Nothing is deleted until the call confirms.
    const asked = deleteAgentCommand(handle.db, { id: implementer.id, confirm: false });
    expect(asked.deleted).toBe(false);
    expect(asked.impact?.leavesStepsWithNobody).toBe(true);
    expect(listAgentDetails(handle.db).agents.some((agent) => agent.id === implementer.id)).toBe(true);

    expect(deleteAgentCommand(handle.db, { id: implementer.id, confirm: true })).toMatchObject({ deleted: true, problem: null });

    const detail = getItemDetail(handle.db, { itemId: item.id })!;
    expect(detail.runs.find((entry) => entry.id === run.id)?.agentName).toBe(implementer.name);
    expect(detail.comments.find((comment) => comment.body === "Done.")?.authorName).toBe(implementer.name);
  });

  it("leaves a tombstone off the Agents screen, archived ones included, and out of dispatch and the validator", () => {
    const reviewer = listAgentDetails(handle.db).agents.find((agent) => agent.role === "reviewer")!;

    deleteAgentCommand(handle.db, { id: reviewer.id, confirm: true });

    expect(listAgentDetails(handle.db).agents.some((agent) => agent.id === reviewer.id)).toBe(false);
    const tombstone = getAgent(handle.db, reviewer.id as Uuid)!;
    expect(tombstone).toMatchObject({ name: reviewer.name, role: "reviewer", instructions: "", config: {}, enabled: false });
    expect(tombstone.deletedAt).not.toBeNull();
    expect(isDispatchable(tombstone)).toBe(false);

    const { problems } = validatePipelineCommand(handle.db, { pipelineId: "default", steps: currentStates(), routes: currentRoutes(), entryStepId: "worktree" });
    expect(problems.some((problem) => problem.message.includes("reviewer") && problem.message.includes("no enabled agent"))).toBe(true);

    // Gone is gone: not deleted twice, not archived, not saved back.
    expect(deleteAgentCommand(handle.db, { id: reviewer.id, confirm: true }).deleted).toBe(false);
    expect(archiveAgentCommand(handle.db, { id: reviewer.id, confirm: true }).archived).toBe(false);
    expect(saveAgent(handle.db, { ...reviewer, instructions: "Back again." }).saved).toBe(false);
  });

  it("deletes an archived agent", () => {
    const spare = wrote(saveAgent(handle.db, { name: "Tester", role: "tester", provider: "fake", model: null, instructions: "x", enabled: true, config: {} }));
    archiveAgentCommand(handle.db, { id: spare.id, confirm: true });

    expect(deleteAgentCommand(handle.db, { id: spare.id, confirm: true }).deleted).toBe(true);
    expect(listAgentDetails(handle.db).agents.some((agent) => agent.id === spare.id)).toBe(false);
  });

  it("does not let the shipped prompt refill a deleted agent's instructions", () => {
    const reviewer = listAgentDetails(handle.db).agents.find((agent) => agent.role === "reviewer")!;
    deleteAgentCommand(handle.db, { id: reviewer.id, confirm: true });

    syncRolePrompts(handle.db);

    expect(getAgent(handle.db, reviewer.id as Uuid)!.instructions).toBe("");
  });
});

/**
 * A human step's declarations, judged at the boundary rather than
 * tidied up on the way in (EO-310, ARCHITECTURE.md, "A step").
 *
 * `validatePipeline` has both refusals, and for a while neither could be
 * reached from here: `toDomainSteps` derived each step's results from
 * its routes before handing them over, so an unrouted declared result
 * was dropped and an undeclared route key had a result invented for it.
 * Both malformed graphs arrived at the validator looking consistent, and
 * `pipeline:save` wrote them.
 *
 * So these cases are asked of the *commands* rather than of the engine.
 * The engine's own tests prove the rules; what is proven here is that a
 * graph carrying either mistake still carries it when the validator sees
 * it — which is the only reason a rule at this boundary is worth
 * anything.
 */
describe("what a step a person decides on submits", () => {
  /** The shipped Delivery pipeline, whose "Done" step declares Approve and Send back. */
  function deciding() {
    return { pipelineId: "default", steps: currentStates(), routes: currentRoutes(), entryStepId: "worktree" };
  }

  const errors = (problems: { severity: string; message: string }[]) => problems.filter((problem) => problem.severity === "error").map((problem) => problem.message);

  it("takes the shipped graph, whose human step declares exactly what it routes", () => {
    expect(errors(validatePipelineCommand(handle.db, deciding()).problems)).toEqual([]);
  });

  it("refuses a declared result whose route was left out, and will not save it", () => {
    const submitted = deciding();
    // The declaration kept and the branch removed — a button that would
    // do nothing when pressed.
    submitted.routes = submitted.routes.filter((route) => !(route.fromStepId === "ready_to_merge" && route.resultKey === "send_back"));

    expect(errors(validatePipelineCommand(handle.db, submitted).problems)).toContain(
      '"Done" offers "Send back", but nothing says where it sends the item — the button would do nothing. Route it, or take it off the step.',
    );

    const saved = savePipeline(handle.db, fakeEngine(), submitted);
    expect(saved.saved).toBe(false);
    // And nothing was written: the branch is still there.
    expect(currentRoutes().some((route) => route.fromStepId === "ready_to_merge" && route.resultKey === "send_back")).toBe(true);
  });

  it("refuses a branch out of a human step that the step does not offer, and will not save it", () => {
    const submitted = deciding();
    // A route nobody can take: a person may only send a key the step
    // declares, and this one is not among them.
    submitted.routes = [
      ...submitted.routes,
      { id: "r_escalate", pipelineId: "default", fromStepId: "ready_to_merge", resultKey: "escalate", label: "Escalate", tone: "danger" as const, target: "todo", position: 2 },
    ];

    expect(errors(validatePipelineCommand(handle.db, submitted).problems)).toContain(
      '"escalate" routes out of "Done", which does not offer it (approved, send_back). Give it that result, or remove the branch.',
    );

    const saved = savePipeline(handle.db, fakeEngine(), submitted);
    expect(saved.saved).toBe(false);
    expect(currentRoutes().some((route) => route.resultKey === "escalate")).toBe(false);
  });

  /**
   * The mirror of the first case, and the one a derived declaration hid
   * most completely: the routes are untouched and the *results* are
   * wrong. Nothing about the wiring says so, which is why the
   * declaration has to travel.
   */
  it("refuses a result the step declares over a branch it does not draw", () => {
    const submitted = deciding();
    submitted.steps = submitted.steps.map((step) =>
      step.id === "ready_to_merge"
        ? { ...step, results: [...step.results, { key: "escalate", label: "Escalate", tone: "danger" as const, requiresComment: true }] }
        : step,
    );

    expect(errors(validatePipelineCommand(handle.db, submitted).problems)).toContain(
      '"Done" offers "Escalate", but nothing says where it sends the item — the button would do nothing. Route it, or take it off the step.',
    );
    expect(savePipeline(handle.db, fakeEngine(), submitted).saved).toBe(false);
  });

  /**
   * A decision pointed at a person's attention, refused where it is
   * drawn rather than where it is pressed.
   *
   * `items:decide` has always refused this one — the item is already
   * standing on the step whose business is asking a person, so taking
   * the result would leave it exactly where it stands. That refusal is a
   * sentence somebody reads *after* pressing a button published for
   * them, which is the wrong moment to learn it. Saying it here is what
   * makes a published decision actionable.
   */
  it("refuses a decision routed to a person's attention, and will not save it", () => {
    const submitted = deciding();
    submitted.routes = submitted.routes.map((route) =>
      route.fromStepId === "ready_to_merge" && route.resultKey === "send_back" ? { ...route, target: "user_attention" } : route,
    );

    expect(errors(validatePipelineCommand(handle.db, submitted).problems).some((message) => message.includes("which is where the item already is"))).toBe(true);

    expect(savePipeline(handle.db, fakeEngine(), submitted).saved).toBe(false);
    // The branch still goes where it went, so nothing on the board grew
    // a button that refuses itself while the save was being turned away.
    expect(currentRoutes().find((route) => route.resultKey === "send_back")?.target).toBe("todo");
  });

  /**
   * Two buttons under one key, which nothing but this refusal stops.
   *
   * `step_routes` carries a unique index on (step, result key), so the
   * routing side cannot hold a duplicate. `pipeline_steps.results` is
   * JSON and has no such index, so a `pipeline:save` by hand is all it
   * takes — and what comes out is an item offering two buttons that send
   * one answer, where the second one's words and its "needs a reason"
   * are decoration over the first one's.
   */
  it("refuses a result key declared twice on a human step, and will not save it", () => {
    const submitted = deciding();
    submitted.steps = submitted.steps.map((step) =>
      step.id === "ready_to_merge"
        ? { ...step, results: [...step.results, { key: "approved", label: "Accept", tone: "warning" as const, requiresComment: true }] }
        : step,
    );

    expect(errors(validatePipelineCommand(handle.db, submitted).problems).some((message) => message.includes('offers "approved" twice'))).toBe(true);

    expect(savePipeline(handle.db, fakeEngine(), submitted).saved).toBe(false);
    // The row still declares it once, so nothing on the board grew a
    // second button while the save was being refused.
    expect(currentStates().find((step) => step.id === "ready_to_merge")!.results.filter((result) => result.key === "approved")).toHaveLength(1);
  });

  /** And a consistent pair is written, so the refusals above are about the mistake rather than about the field. */
  it("saves a human step whose declaration and branches agree", () => {
    const submitted = deciding();
    submitted.steps = submitted.steps.map((step) =>
      step.id === "ready_to_merge"
        ? { ...step, results: [...step.results, { key: "escalate", label: "Escalate", tone: "danger" as const, requiresComment: true }] }
        : step,
    );
    submitted.routes = [
      ...submitted.routes,
      { id: "r_escalate", pipelineId: "default", fromStepId: "ready_to_merge", resultKey: "escalate", label: "Escalate", tone: "danger" as const, target: "todo", position: 2 },
    ];

    expect(savePipeline(handle.db, fakeEngine(), submitted).saved).toBe(true);
    const step = currentStates().find((candidate) => candidate.id === "ready_to_merge")!;
    // Written as submitted — the label somebody typed and their decision
    // that it needs a reason, not something re-derived from the route.
    expect(step.results).toContainEqual({ key: "escalate", label: "Escalate", tone: "danger", requiresComment: true });
  });
});

/**
 * A step may pick among **the project's** workspaces (EO-301,
 * ARCHITECTURE.md, "A workspace is a kind, attached to the project").
 *
 * The refusal is here rather than in `validatePipeline` because
 * `packages/engine` is pure and — more pointedly — invariant 13's
 * neutrality scan bans the word `workspaceId` from its sources outright:
 * the engine is not allowed to hold an opinion about what a disk is. So
 * the check is the main process's, and it has to be asked on both the
 * validate and the save, or the editor's refusal is a courtesy that a
 * direct call to `pipeline:save` walks straight past.
 */
describe("a step pointed at another project's workspace", () => {
  /** Two projects, each with a repository of its own — which is what attaching two repositories gives you. */
  function twoProjects() {
    const here = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: "/tmp/here" });
    const elsewhere = attachWorkspace(handle.db, { keyPrefix: "OTHER", name: "the other repo", repoPath: "/tmp/elsewhere" });
    // The shipped `default` pipeline belongs to no project, so the
    // project it is judged in is the active one — and attaching the
    // second repository made that the second project. Put it back, so
    // "elsewhere" really is elsewhere.
    setActiveProjectCommand(handle.db, { id: here.projectId! });
    return { here, elsewhere };
  }

  function stepsPicking(workspaceId: string | null): PipelineStepView[] {
    return currentStates().map((step) => (step.id === "worktree" ? { ...step, workspaceId } : step));
  }

  it("refuses the save, and says which step and why", () => {
    const { elsewhere } = twoProjects();

    const result = savePipeline(handle.db, fakeEngine(), {
      pipelineId: "default",
      steps: stepsPicking(elsewhere.id),
      routes: currentRoutes(),
      entryStepId: "worktree",
    });

    expect(result.saved).toBe(false);
    const message = result.problems.map((problem) => problem.message).join("\n");
    expect(message).toContain("the other repo");
    expect(message).toContain("belongs to another project");
    // Nothing written: the whole graph is refused, not the one step.
    expect(listPipelineSteps(handle.db).find((step) => step.id === "worktree")?.workspaceId).toBeNull();
  });

  it("refuses it at validate too, so the editor greys Publish out rather than finding out on the click", () => {
    const { elsewhere } = twoProjects();

    const { problems } = validatePipelineCommand(handle.db, {
      pipelineId: "default",
      steps: stepsPicking(elsewhere.id),
      routes: currentRoutes(),
      entryStepId: "worktree",
    });

    expect(problems.some((problem) => problem.severity === "error" && problem.stateId === "worktree")).toBe(true);
  });

  it("saves a step pointed at one of this project's own", () => {
    const { here } = twoProjects();

    expect(savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: stepsPicking(here.id), routes: currentRoutes(), entryStepId: "worktree" }).saved).toBe(true);
    expect(listPipelineSteps(handle.db).find((step) => step.id === "worktree")?.workspaceId).toBe(here.id);
  });

  it("says nothing about the two answers that name no workspace", () => {
    // Null is "the ticket's own", which is not a pick; the sentinel is
    // "no disk", which belongs to no project. Only an id can be another
    // project's, and a rule that refused either of these would refuse
    // every step in every installation.
    twoProjects();

    for (const pick of [null, NO_WORKSPACE]) {
      const result = savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: stepsPicking(pick), routes: currentRoutes(), entryStepId: "worktree" });
      expect(result.saved, `pick ${String(pick)}`).toBe(true);
    }
    expect(listPipelineSteps(handle.db).find((step) => step.id === "worktree")?.workspaceId).toBe(NO_WORKSPACE);
  });

  it("refuses a step naming a workspace that no longer exists, and says so in different words", () => {
    twoProjects();

    const result = savePipeline(handle.db, fakeEngine(), {
      pipelineId: "default",
      steps: stepsPicking("01a01be7-2005-7335-ac8b-000000000000"),
      routes: currentRoutes(),
      entryStepId: "worktree",
    });

    expect(result.saved).toBe(false);
    // Different words on purpose: a workspace that is gone is fixed by
    // picking another, and one that belongs elsewhere can also be fixed
    // on the Projects screen. Being sent to the wrong one of those costs
    // a trip to a screen with nothing to do with it.
    expect(result.problems.map((problem) => problem.message).join("\n")).toContain("no longer exists");
  });
});

describe("workflow saving", () => {
  /**
   * Inserts a step before `beforeId` and renumbers every position.
   *
   * Renumbering rather than hand-picking a slot: positions have to stay
   * unique or the validator refuses the save, and hard-coded numbers here
   * broke the moment the shipped pipeline grew a step.
   */
  function withStepBefore(step: PipelineStepView, beforeId: string): PipelineStepView[] {
    const ordered = [...currentStates()].sort((a, b) => a.position - b.position);
    const at = ordered.findIndex((candidate) => candidate.id === beforeId);
    ordered.splice(at, 0, step);
    return ordered.map((candidate, index) => ({ ...candidate, position: index }));
  }

  it("adds a state, which becomes a project column with no code change", () => {
    saveAgent(handle.db, { name: "Tester", role: "tester", provider: "fake", model: null, instructions: "", enabled: true, config: {} });

    const next = withStepBefore(
      { id: "qa", pipelineId: "default", position: 0, name: "qa", type: "agent", ownerRole: "tester", entryAction: "test", instructionsSummary: null, isTerminal: false, planMode: false, workspaceMode: "isolated", workspaceId: null, inputs: {}, timeoutMs: null, watch: null, results: [] },
      "merge_request",
    );

    const result = savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: next, routes: currentRoutes(), entryStepId: "worktree" });

    expect(result.saved).toBe(true);
    // The project derives its columns from exactly this list (U-02).
    expect(listPipelineStepViews(handle.db, { pipelineId: "default" }).steps.map((state) => state.id)).toContain("qa");
  });

  /**
   * What a module step sets for its declared inputs, across the editor's
   * round trip (EO-78).
   *
   * Published with the graph and read back by the same query the screen
   * loads with, because that is the whole claim: a value somebody typed
   * is still there after Publish and a reload, rather than resolving to
   * the manifest's default on every run.
   */
  describe("a module step's configured inputs", () => {
    function deployModule(inputs: Record<string, { type: "string" | "number" | "boolean"; default?: number }>) {
      const saved = saveModule(handle.db, {
        slug: "deploy",
        name: "Deploy",
        description: "Deploys the branch.",
        code: "export default async function run() { return { ok: true, result: 'deployed', detail: '' }; }",
        manifest: {
          name: "Deploy",
          description: "Deploys the branch.",
          inputs,
          needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
          results: ["deployed"],
        },
        approve: true,
      });
      if (!saved.ok) throw new Error(saved.reason);
      return saved.module;
    }

    const deployStep = (moduleId: string, inputs: Record<string, string | number | boolean>): PipelineStepView => ({
      id: "deploy",
      pipelineId: "default",
      position: 0,
      name: "Deploy",
      type: "module",
      ownerRole: null,
      entryAction: moduleId,
      instructionsSummary: null,
      isTerminal: false,
      planMode: false,
      workspaceMode: "isolated" as const,
      workspaceId: null,
      inputs,
      timeoutMs: null,
      watch: null,
      results: [],
    });

    it("survives a publish and the reload after it", () => {
      const module = deployModule({ wait_seconds: { type: "number", default: 900 } });
      const next = withStepBefore(deployStep(module.id, { wait_seconds: 90 }), "merge_request");

      expect(savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: next, routes: currentRoutes(), entryStepId: "worktree" }).saved).toBe(true);

      expect(currentStates().find((step) => step.id === "deploy")?.inputs).toEqual({ wait_seconds: 90 });
    });

    it("is empty on a step that configures nothing, so the manifest's default is what runs", () => {
      const module = deployModule({ wait_seconds: { type: "number", default: 900 } });
      const next = withStepBefore(deployStep(module.id, {}), "merge_request");

      savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: next, routes: currentRoutes(), entryStepId: "worktree" });

      expect(currentStates().find((step) => step.id === "deploy")?.inputs).toEqual({});
    });

    // Refused at the publish, so the wrong type is never stored at all —
    // the run-time check in `runModule` is the second line, not the first.
    it("refuses a publish whose value is not the declared type, naming the input", () => {
      const module = deployModule({ wait_seconds: { type: "number", default: 900 } });
      const next = withStepBefore(deployStep(module.id, { wait_seconds: "ninety" }), "merge_request");

      const result = savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: next, routes: currentRoutes(), entryStepId: "worktree" });

      expect(result.saved).toBe(false);
      expect(result.problems.some((problem) => problem.severity === "error" && problem.message.includes("wait_seconds"))).toBe(true);
      expect(currentStates().find((step) => step.id === "deploy")).toBeUndefined();
    });
  });

  it("creates a working human gate when owner_role is none", () => {
    const next = withStepBefore(
      { id: "sign_off", pipelineId: "default", position: 0, name: "sign_off", type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: false, planMode: false, workspaceMode: "isolated", workspaceId: null, inputs: {}, timeoutMs: null, watch: null, results: [] },
      "todo",
    );

    expect(savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: next, routes: currentRoutes(), entryStepId: "worktree" }).saved).toBe(true);

    const gate = listPipelineSteps(handle.db).find((state) => state.id === "sign_off")!;
    expect(gate.ownerRole).toBeNull(); // the scheduler's first skip condition
  });

  it("refuses an invalid workflow and says exactly why", () => {
    const next = currentStates().map((state) => ({ ...state, isTerminal: false }));

    const result = savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: next, routes: currentRoutes(), entryStepId: "worktree" });

    expect(result.saved).toBe(false);
    expect(result.problems.some((problem) => problem.severity === "error" && problem.message.includes("terminal"))).toBe(true);
    // Nothing was written — a rejected save must not half-apply.
    expect(listPipelineSteps(handle.db).some((state) => state.isTerminal)).toBe(true);
  });

  /**
   * The editor is a person acting directly, and EO-209 did not change it.
   *
   * A draft is an agent *proposing* a graph, so a step it omits might be
   * a step it forgot — which is why a draft now has to declare what it
   * removes. Somebody dragging a column out of the editor and pressing
   * Publish has done neither of those things: they are looking at the
   * board they are changing, and the deletion is the gesture rather than
   * a side effect of one. `pipeline:save` therefore takes no `removes`
   * and asks for none, and this is the case that would have broken if
   * the gate had been put in the publish path instead of the draft.
   */
  it("still publishes an editor graph that simply drops a step, with nothing declaring the removal", () => {
    const next = currentStates()
      .filter((state) => state.id !== "repository_index")
      .map((state, index) => ({ ...state, position: index }));
    const routes = currentRoutes()
      .filter((route) => route.fromStepId !== "repository_index")
      .map((route) => (route.target === "repository_index" ? { ...route, target: "todo" } : route));

    const result = savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: next, routes, entryStepId: "worktree" });

    expect(result.saved).toBe(true);
    // Off the current graph, which is what removing a step means since
    // EO-327: the row is retired rather than dropped, so an item still
    // finishing on a version that has the step has somewhere to stand.
    expect(listStepsForPipeline(handle.db, "default").some((state) => state.id === "repository_index")).toBe(false);
  });

  it("refuses to remove a state that still holds an item, in the singular", () => {
    createTestItem(handle.db, { type: "story", title: "In todo", stepId: "todo" });

    const result = savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: currentStates().filter((state) => state.id !== "todo"), routes: [], entryStepId: "worktree" });

    expect(result.saved).toBe(false);
    // Named, and counted in the singular (EO-167) — this is what a
    // person meets when an item lands on a step while their draft is
    // open, so it has to read as a sentence about a column.
    expect(result.problems[0]?.message).toBe("To Do has 1 item on it. Move it before removing the step.");
  });

  /**
   * The guard a step with items on it earns (EO-230): a graph that
   * removes it is refused with the step and the count, typed, and nothing
   * is written — then the same graph, after the items have moved, is
   * accepted. The full answer is pipeline versions (7c); this is the
   * honest first step, and it has to hold on both halves.
   */
  it("refuses to remove a step holding two items, writes nothing, and accepts the same save once they have moved", () => {
    const first = createTestItem(handle.db, { type: "story", title: "First", stepId: "todo" });
    const second = createTestItem(handle.db, { type: "story", title: "Second", stepId: "todo" });
    const before = listPipelineSteps(handle.db);
    const routesBefore = listPipelineStepViews(handle.db, { pipelineId: "default" }).routes;

    const withoutTodo = {
      pipelineId: "default",
      steps: currentStates()
        .filter((state) => state.id !== "todo")
        .map((state, index) => ({ ...state, position: index })),
      // What pointed at To Do now points at Review, so the graph is
      // otherwise sound: the refusal below has to be the only reason.
      routes: currentRoutes()
        .filter((route) => route.fromStepId !== "todo")
        .map((route) => (route.target === "todo" ? { ...route, target: "review" } : route)),
      entryStepId: "worktree",
    };

    const refused = savePipeline(handle.db, fakeEngine(), withoutTodo);

    expect(refused.saved).toBe(false);
    expect(refused.problems.filter((problem) => problem.severity === "error")).toEqual([
      {
        severity: "error",
        stateId: "todo",
        message: "To Do has 2 items on it. Move them before removing the step.",
        holdsItems: { stepId: "todo", stepName: "To Do", count: 2, archived: 0 },
      },
    ]);
    // Nothing written: the steps and the routes are exactly as they were.
    expect(listPipelineSteps(handle.db)).toEqual(before);
    expect(listPipelineStepViews(handle.db, { pipelineId: "default" }).routes).toEqual(routesBefore);

    for (const item of [first, second]) {
      transitionItem(handle.db, { itemId: item.id, toStepId: "worktree", actor: "human" });
    }

    const accepted = savePipeline(handle.db, fakeEngine(), withoutTodo);

    expect(accepted.saved).toBe(true);
    expect(listStepsForPipeline(handle.db, "default").some((state) => state.id === "todo")).toBe(false);
    expect(getItem(handle.db, first.id)?.stepId).toBe("worktree");
  });

  /**
   * An archived item holds the step exactly as a live one does, and the
   * refusal says it is archived (EO-230): the board cannot show it, so a
   * person is pointed at the Archive rather than at an empty column.
   */
  it("refuses for an archived item, and says it is archived", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Put away", stepId: "todo" });
    setItemArchived(handle.db, item.id, Date.now());

    const result = savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: currentStates().filter((state) => state.id !== "todo"), routes: [], entryStepId: "worktree" });

    expect(result.saved).toBe(false);
    expect(result.problems[0]).toMatchObject({
      message: "To Do has 1 item on it. Move it before removing the step. It is archived — restore it first.",
      holdsItems: { stepId: "todo", stepName: "To Do", count: 1, archived: 1 },
    });
  });

  it("lets a step with items on it be renamed and change type — only removal is refused", () => {
    createTestItem(handle.db, { type: "story", title: "In todo", stepId: "todo" });

    const result = savePipeline(handle.db, fakeEngine(), {
      pipelineId: "default",
      // Consistent, because `todo` becomes a step a person acts on and
      // keeps its branch — and a human step's branches are the results
      // it offers (EO-310). The case is about the rename and the type.
      steps: consistent(
        currentStates().map((state) => (state.id === "todo" ? { ...state, name: "Backlog", type: "user" as const, ownerRole: null, entryAction: null } : state)),
        currentRoutes(),
      ),
      routes: currentRoutes(),
      entryStepId: "worktree",
    });

    expect(result.saved).toBe(true);
    expect(listPipelineSteps(handle.db).find((state) => state.id === "todo")).toMatchObject({ name: "Backlog", type: "user" });
  });

  /**
   * The publish-time backstop for a hand-off in (EO-58, EO-167).
   *
   * The editor refuses this at the click, which is not enough on its own:
   * the route can be drawn after a draft was loaded, and `pipeline:save`
   * is a channel anything can call. Nothing else would catch it —
   * `validatePipeline` is given this pipeline's routes, `replacePipelineGraph`
   * would delete the step happily, and `step_routes.target` has no
   * foreign key. The other pipeline would simply be left pointing at
   * nothing, found when an item next took that branch.
   */
  it("refuses to remove a step another pipeline hands work to, naming the route and the pipeline", () => {
    const delivery = createPipeline(handle.db, { projectId: null, name: "Delivery" });
    const ship = createStep(handle.db, { pipelineId: delivery.id, position: 0, name: "Ship", type: "user" });
    createRoute(handle.db, { pipelineId: delivery.id, fromStepId: ship.id, resultKey: "shipped", label: "Shipped", target: "todo" });

    const result = savePipeline(handle.db, fakeEngine(), {
      pipelineId: "default",
      steps: currentStates().filter((state) => state.id !== "todo"),
      routes: [],
      entryStepId: "worktree",
    });

    expect(result.saved).toBe(false);
    // Named by the pipeline that declares it, because that is where the
    // person has to go — this save cannot rewrite Delivery's wiring.
    expect(result.problems.some((problem) => problem.severity === "error" && problem.message.includes("Delivery · Shipped"))).toBe(true);
    // And nothing was written: the step is still there for that route to
    // keep pointing at.
    expect(listPipelineSteps(handle.db).some((state) => state.id === "todo")).toBe(true);
  });

  it("still lets the step go once the hand-off pointing at it has gone", () => {
    // The refusal is about the dangling edge, not about the step. A
    // pipeline that no longer routes here holds nothing back.
    const delivery = createPipeline(handle.db, { projectId: null, name: "Delivery" });
    const ship = createStep(handle.db, { pipelineId: delivery.id, position: 0, name: "Ship", type: "user" });
    createRoute(handle.db, { pipelineId: delivery.id, fromStepId: ship.id, resultKey: "shipped", label: "Shipped", target: "review" });

    const result = savePipeline(handle.db, fakeEngine(), {
      pipelineId: "default",
      ...withoutTodo(),
      entryStepId: "worktree",
    });

    expect(result.saved).toBe(true);
    expect(listStepsForPipeline(handle.db, "default").some((state) => state.id === "todo")).toBe(false);
  });

  /**
   * A deleted pipeline is archived rather than dropped (KAN-59), and it
   * is nowhere work can flow — its items were archived with it. Holding
   * a step hostage to one would be a refusal with nothing anybody could
   * do about it: the route is not editable from anywhere.
   */
  it("does not count a hand-off from a pipeline that has been deleted", () => {
    const delivery = createPipeline(handle.db, { projectId: null, name: "Delivery" });
    const ship = createStep(handle.db, { pipelineId: delivery.id, position: 0, name: "Ship", type: "user" });
    createRoute(handle.db, { pipelineId: delivery.id, fromStepId: ship.id, resultKey: "shipped", label: "Shipped", target: "todo" });
    archivePipeline(handle.db, delivery.id);

    const result = savePipeline(handle.db, fakeEngine(), {
      pipelineId: "default",
      ...withoutTodo(),
      entryStepId: "worktree",
    });

    expect(result.saved).toBe(true);
  });

  it("nudges the scheduler after a save, since a new state may be dispatchable now", () => {
    const engine = fakeEngine();
    savePipeline(handle.db, engine, { pipelineId: "default", steps: currentStates(), routes: currentRoutes(), entryStepId: "worktree" });

    expect(engine.notifyStateChange).toHaveBeenCalled();
  });

  it("does not nudge — or write — when the save is refused", () => {
    const engine = fakeEngine();
    savePipeline(handle.db, engine, { pipelineId: "default", steps: [], routes: [], entryStepId: "worktree" });

    expect(engine.notifyStateChange).not.toHaveBeenCalled();
  });

  /**
   * A step can own secret values (KAN-105), reachable only through its
   * id — so a save that removes one has to say so, or it leaves
   * ciphertext on disk nothing can ever read or remove again.
   */
  it("reports the steps a save removed", () => {
    const removed = vi.fn();
    savePipeline(handle.db, fakeEngine(), { pipelineId: "default", ...withoutTodo(), entryStepId: "worktree" }, removed);

    expect(removed).toHaveBeenCalledWith(["todo"]);
  });

  it("reports nothing when a save removes nothing", () => {
    const removed = vi.fn();
    savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: currentStates(), routes: currentRoutes(), entryStepId: "worktree" }, removed);

    expect(removed).not.toHaveBeenCalled();
  });

  // Nothing is discarded on behalf of a save that did not happen.
  it("reports nothing when the save is refused", () => {
    const removed = vi.fn();
    createTestItem(handle.db, { type: "story", title: "In todo", stepId: "todo" });

    savePipeline(
      handle.db,
      fakeEngine(),
      { pipelineId: "default", steps: currentStates().filter((step) => step.id !== "todo"), routes: [], entryStepId: "worktree" },
      removed,
    );

    expect(removed).not.toHaveBeenCalled();
  });
});

/**
 * A builtin step's routes, checked against what its function can return
 * (EO-77).
 *
 * Through `pipeline:save` rather than through `validatePipeline`, because
 * what changed is that a builtin's outcomes are declared data at all: the
 * shipped Delivery pipeline routes `opened` and `skipped` off
 * `merge_request`, and until now a typo in either was caught by nothing —
 * not by the editor, which offered a free text box, and not by the
 * validator, which had nothing to compare a builtin's key against.
 */
describe("a builtin step's declared outcomes (EO-77)", () => {
  it("refuses a publish whose route key the function cannot return, and names the function", () => {
    const routes = currentRoutes().map((route) => (route.resultKey === "opened" ? { ...route, resultKey: "opend" } : route));

    const result = savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: currentStates(), routes, entryStepId: "worktree" });

    expect(result.saved).toBe(false);
    expect(result.problems.map((problem) => problem.message)).toContain('"opend" is not a result "open_pull_request" can return (opened, skipped, uncommitted_changes, remote_diverged, failed).');
    // A refused save writes nothing: the shipped route is still there.
    expect(currentRoutes().some((route) => route.resultKey === "opened")).toBe(true);
  });

  it("warns about an outcome nothing routes, the way it does for a module", () => {
    // `skipped` is what a story with no branch or no forge gets. With
    // nothing routing it the item parks and interrupts a person — worth
    // saying, and not worth refusing the save over.
    const routes = currentRoutes().filter((route) => route.resultKey !== "skipped");

    const result = savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: currentStates(), routes, entryStepId: "worktree" });

    expect(result.saved).toBe(true);
    expect(result.problems).toContainEqual(
      expect.objectContaining({ severity: "warning", stateId: "merge_request", resultKey: "skipped" }),
    );
  });

  // The shipped graph itself: both outcomes routed, and it publishes with
  // nothing to say. Worth asserting because this check is new — a warning
  // on the pipeline everyone starts with would be noise on day one.
  it("has nothing to say about the pipeline EO ships", () => {
    const result = savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: currentStates(), routes: currentRoutes(), entryStepId: "worktree" });

    expect(result.saved).toBe(true);
    expect(result.problems.filter((problem) => problem.stateId === "merge_request" || problem.stateId === "worktree")).toEqual([]);
  });
});

/**
 * A route that hands work to another pipeline (EO-58, EO-69).
 *
 * The engine has been able to *follow* one since EO-58; until EO-69
 * nothing could create one, because `validationInput` never told the
 * validator which steps live elsewhere and every such target came back as
 * "routes to a step that is in no pipeline". Exercised through the two
 * commands rather than through `validatePipeline` directly, because it is
 * exactly the wiring between them that was missing.
 */
describe("handing work to another pipeline (EO-58, EO-69)", () => {
  /** A pipeline of its own to hand work to — Merge is the shipped example. */
  function mergePipeline(name = "Merge") {
    const pipeline = createPipeline(handle.db, { projectId: null, name });
    const step = createStep(handle.db, { pipelineId: pipeline.id, position: 0, name: "Merge", type: "user" });
    return { pipeline, step };
  }

  /**
   * The shipped graph with one more result leaving Review for `target`.
   *
   * `escalation`, because an agent step may only route what its action
   * declares or what the engine produces itself (EO-423) — and a review
   * that gave up being handed to another pipeline is a hand-off somebody
   * would draw.
   */
  function reviewRoutesTo(target: string): StepRouteView[] {
    return [
      ...currentRoutes(),
      { id: "r_review_hands_off", pipelineId: "default", fromStepId: "review", resultKey: "escalation", label: "Handed off", tone: "info", target, position: 3 },
    ];
  }

  it("validates and publishes a route whose target is a step of another pipeline", () => {
    const { step } = mergePipeline();
    const routes = reviewRoutesTo(step.id);

    const checked = validatePipelineCommand(handle.db, { pipelineId: "default", steps: currentStates(), routes, entryStepId: "worktree" });
    expect(checked.problems).toEqual([]);

    const saved = savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: currentStates(), routes, entryStepId: "worktree" });
    expect(saved.saved).toBe(true);
    expect(currentRoutes().find((route) => route.resultKey === "escalation")?.target).toBe(step.id);
  });

  /**
   * `default` belongs to no project, and a project-less pipeline belongs to
   * every project — so a pipeline created *on* the project it is being
   * edited in is somewhere it may hand work to (EO-72).
   *
   * Asking `listPipelines` with its own `null` collapsed the filter to the
   * other project-less pipelines, and every pipeline anyone had created
   * came back from the shipped one as "routes to a step that is in no
   * pipeline" — the message reserved for a typo.
   */
  it("validates and publishes a route into a pipeline created on the project", () => {
    const project = createProject(handle.db, { name: "EO", keyPrefix: "EO" });
    const pipeline = createPipeline(handle.db, { projectId: project.id, name: "Merge" });
    const step = createStep(handle.db, { pipelineId: pipeline.id, position: 0, name: "Merge", type: "user" });
    setActiveProjectCommand(handle.db, { id: project.id });
    const routes = reviewRoutesTo(step.id);

    expect(validatePipelineCommand(handle.db, { pipelineId: "default", steps: currentStates(), routes, entryStepId: "worktree" }).problems).toEqual([]);

    expect(savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: currentStates(), routes, entryStepId: "worktree" }).saved).toBe(true);
    expect(currentRoutes().find((route) => route.resultKey === "escalation")?.target).toBe(step.id);
  });

  /**
   * And a pipeline of a *different* project is not (EO-72).
   *
   * Which project a project-less pipeline is being edited in is the active
   * one, read here rather than taken from the caller for the same reason
   * the candidates themselves are. Handing work over stays a thing one
   * project's pipelines do among themselves, so a step of another
   * project's pipeline is still a target this graph cannot reach — and
   * saying so is the same message a typo gets, because from this
   * pipeline's side that is exactly what it is.
   */
  it("refuses a route into a pipeline of a project that is not the one open", () => {
    const ours = createProject(handle.db, { name: "Ours", keyPrefix: "OURS" });
    const theirs = createProject(handle.db, { name: "Theirs", keyPrefix: "THRS" });
    const pipeline = createPipeline(handle.db, { projectId: theirs.id, name: "Someone else's Merge" });
    const step = createStep(handle.db, { pipelineId: pipeline.id, position: 0, name: "Merge", type: "user" });
    setActiveProjectCommand(handle.db, { id: ours.id });
    const routes = reviewRoutesTo(step.id);

    const problem = validatePipelineCommand(handle.db, { pipelineId: "default", steps: currentStates(), routes, entryStepId: "worktree" }).problems.find(
      (candidate) => candidate.resultKey === "escalation",
    );

    expect(problem).toMatchObject({ severity: "error", stateId: "review" });
    expect(savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: currentStates(), routes, entryStepId: "worktree" }).saved).toBe(false);
  });

  /**
   * `discussion` is the shipped case: a step of a live pipeline that is not
   * a column of it.
   *
   * Off-dashboard is a statement about the board, not about whether the
   * step is there to be routed to — and `wiring.ts` hands `resolveRoute`
   * every step of every other pipeline, so refusing this would refuse to
   * save a route the engine would then follow perfectly happily.
   *
   * The editor stopped *offering* these in EO-72, which is a different
   * question — what a picker proposes is not what a validator tolerates.
   * This is the tolerating half, and it stays: a route already naming an
   * off-dashboard step has to keep saving.
   */
  it("validates and publishes a route to an off-dashboard step of another live pipeline", () => {
    const routes = reviewRoutesTo("discussion");

    expect(validatePipelineCommand(handle.db, { pipelineId: "default", steps: currentStates(), routes, entryStepId: "worktree" }).problems).toEqual([]);

    expect(savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: currentStates(), routes, entryStepId: "worktree" }).saved).toBe(true);
    expect(currentRoutes().find((route) => route.resultKey === "escalation")?.target).toBe("discussion");
  });

  // A typo must stay an error rather than become a silent cross-pipeline
  // jump: at runtime the item would simply stop, with nothing said.
  it("still refuses a target that is in no pipeline at all, naming the result", () => {
    const routes = reviewRoutesTo("merge");

    const problem = validatePipelineCommand(handle.db, { pipelineId: "default", steps: currentStates(), routes, entryStepId: "worktree" }).problems.find(
      (candidate) => candidate.resultKey === "escalation",
    );

    expect(problem).toMatchObject({ severity: "error", stateId: "review" });
    expect(problem!.message).toContain("escalation");
    expect(problem!.message).toContain("in no pipeline");
    expect(savePipeline(handle.db, fakeEngine(), { pipelineId: "default", steps: currentStates(), routes, entryStepId: "worktree" }).saved).toBe(false);
  });

  // A deleted pipeline is archived so the work that flowed through it
  // still points at something — not so new work can be sent into it.
  it("refuses a route into an archived pipeline", () => {
    const { pipeline, step } = mergePipeline();
    archivePipeline(handle.db, pipeline.id);

    const problems = validatePipelineCommand(handle.db, { pipelineId: "default", steps: currentStates(), routes: reviewRoutesTo(step.id), entryStepId: "worktree" }).problems;

    expect(problems.some((problem) => problem.resultKey === "escalation" && problem.severity === "error")).toBe(true);
  });

  /**
   * A pipeline that finishes by leaving rather than by arriving somewhere
   * terminal — Delivery ending with a pull request open, merging living in
   * a pipeline of its own.
   */
  describe("a pipeline whose only way out is the hand-off", () => {
    function handOverPipeline(): { pipelineId: string; steps: PipelineStepView[] } {
      const pipeline = createPipeline(handle.db, { projectId: null, name: "Delivery Two" });
      return {
        pipelineId: pipeline.id,
        steps: [
          // A person stands here and presses "Ready", which is what
          // hands the work to the other pipeline — so the step declares
          // it (EO-310). A branch out of a human step that the step does
          // not offer is one nobody could ever take.
          {
            id: "hand_over",
            pipelineId: pipeline.id,
            position: 0,
            name: "Hand over",
            type: "user",
            ownerRole: null,
            entryAction: null,
            instructionsSummary: null,
            isTerminal: false,
            planMode: false,
            workspaceMode: "isolated",
            workspaceId: null,
            inputs: {},
            timeoutMs: null,
            watch: null,
            results: [{ key: "ready", label: "Ready", tone: "success", requiresComment: false }],
          },
        ],
      };
    }

    it("validates, because a route out is a way out", () => {
      const { step } = mergePipeline();
      const { pipelineId, steps } = handOverPipeline();
      const routes: StepRouteView[] = [
        { id: "r_hand_over", pipelineId, fromStepId: "hand_over", resultKey: "ready", label: "Ready", tone: "success", target: step.id, position: 0 },
      ];

      expect(validatePipelineCommand(handle.db, { pipelineId, steps, routes, entryStepId: "hand_over" }).problems).toEqual([]);
    });

    it("fails with neither a terminal step nor a route out", () => {
      const { pipelineId, steps } = handOverPipeline();

      const problems = validatePipelineCommand(handle.db, { pipelineId, steps, routes: [], entryStepId: "hand_over" }).problems;

      expect(problems.some((problem) => problem.severity === "error" && problem.message.includes("nothing can ever finish"))).toBe(true);
    });
  });
});

describe("repositories", () => {
  // Jira credentials live outside the database (J-01); the commands take
  // the store so a repository view can say whether one exists.
  const credentials = {
    directory: join(tmpdir(), "eo-config-test-credentials"),
    store: { isEncryptionAvailable: () => true, encryptString: (plain: string) => Buffer.from(plain), decryptString: (b: Buffer) => b.toString() },
  };

  /**
   * Real repositories in a temp directory, rather than the `/tmp/a` and
   * `/tmp/b` these cases used to pass.
   *
   * Attaching a repository now checks that the path is one, so a
   * fixture that only looked like a path would be refused — and a check
   * exercised against nothing but its own refusal is a check nobody has
   * seen succeed.
   */
  let scratch: string;
  let repoA: string;
  let repoB: string;
  let plainFolder: string;

  async function makeRepo(name: string): Promise<string> {
    const path = join(scratch, name);
    mkdirSync(path, { recursive: true });
    const result = await git(["init", "-b", "main"], path);
    if (!result.ok) throw new Error(`git init failed: ${result.error}`);
    return path;
  }

  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), "eo config test "));
    repoA = await makeRepo("api");
    repoB = await makeRepo("web");
    plainFolder = join(scratch, "not a repository");
    mkdirSync(plainFolder, { recursive: true });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** A repository on a second project, for a case about two: made first, then added to, as a person would. */
  async function onAnotherProject(name: string, repoPath: string) {
    const made = await createProjectCommand(handle.db, { name: `${name} project`, keyPrefix: name.toUpperCase(), repositoryIds: [] });
    return createRepositoryCommand(handle.db, credentials, { name, repoPath, projectId: made.project!.id, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });
  }

  it("is absent until configured, and round-trips once set", async () => {
    expect(listRepositoriesCommand(handle.db, credentials)).toEqual({ repositories: [] });
    expect(listProjectsCommand(handle.db)).toEqual({ projects: [], activeProjectId: null });

    const created = await createRepositoryCommand(handle.db, credentials, {
      name: "the api",
      repoPath: repoA,
      baseBranch: "main",
      testCommand: "pnpm test",
      lintCommand: null,
      buildCommand: null,
    });

    expect(created.ok).toBe(true);
    const listed = listRepositoriesCommand(handle.db, credentials);
    expect(listed.repositories[0]).toMatchObject({ name: "the api", repoPath: repoA, testCommand: "pnpm test" });
    // With nothing to join a project is made for it and the window shows it
    // — one repository, one project, indistinguishable from how this worked
    // before projects existed.
    const projects = listProjectsCommand(handle.db);
    expect(projects.activeProjectId).toBe(projects.projects[0]?.id);
    expect(projects.projects[0]).toMatchObject({ name: "the api", repositoryIds: [listed.repositories[0]?.id] });
  });

  it("refuses a path that is not a git repository, and says which path", async () => {
    // A repository is a checkout that already exists: EO clones nothing,
    // and every worktree is cut from this path. Stored unchecked, a
    // wrong path is accepted in silence and only surfaces at the first
    // dispatch, hours later. The folder picker on the settings screen
    // proves a folder exists and nothing more, and a client over MCP has
    // no picker at all.
    const refused = await createRepositoryCommand(handle.db, credentials, {
      name: "the api",
      repoPath: plainFolder,
      baseBranch: "main",
      testCommand: null,
      lintCommand: null,
      buildCommand: null,
    });

    expect(refused.ok).toBe(false);
    // Named: "that is not a git repository" leaves a caller holding two
    // candidate paths and no way to tell which one it meant.
    expect(refused.problem).toContain(plainFolder);
    expect(refused.problem).toContain("not a git repository");
    // And nothing was written on the way to refusing.
    expect(listRepositoriesCommand(handle.db, credentials).repositories).toEqual([]);
    expect(listProjectsCommand(handle.db).projects).toEqual([]);
  });

  it("refuses to move an attached repository to a path that is not one", async () => {
    // The same mistake through the other door, and it fails the same way
    // at the first dispatch, so it is refused the same way here.
    const created = await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });

    const refused = await updateRepositoryCommand(handle.db, credentials, { id: created.repository!.id, repoPath: plainFolder });

    expect(refused.ok).toBe(false);
    expect(refused.problem).toContain(plainFolder);
    expect(listRepositoriesCommand(handle.db, credentials).repositories[0]?.repoPath).toBe(repoA);
  });

  it("refuses to move a repository onto a checkout another one already holds", async () => {
    // Attaching one path twice is refused, so two records for one checkout
    // is a state EO says it does not hold — but moving one there reached
    // it, and it would mean two key prefixes minting keys and two sets of
    // worktrees over the same branches.
    await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });
    const web = await createRepositoryCommand(handle.db, credentials, { name: "web", repoPath: repoB, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });

    const refused = await updateRepositoryCommand(handle.db, credentials, { id: web.repository!.id, repoPath: repoA });

    expect(refused.ok).toBe(false);
    expect(refused.problem).toContain(repoA);
    expect(listRepositoriesCommand(handle.db, credentials).repositories.map((repository) => repository.repoPath)).toEqual([repoA, repoB]);
  });

  it("leaves a repository where it is when the path it is given is its own", async () => {
    // The rule is one checkout per repository, not "never send repoPath" —
    // an update that resends what repositories_list reports is idempotent,
    // which is what the tool's own annotation promises.
    const created = await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });

    const again = await updateRepositoryCommand(handle.db, credentials, { id: created.repository!.id, repoPath: repoA, name: "the api" });

    expect(again.ok).toBe(true);
    expect(listRepositoriesCommand(handle.db, credentials).repositories[0]).toMatchObject({ repoPath: repoA, name: "the api" });
  });

  it("adds a second repository rather than overwriting the first", async () => {
    // The behaviour this whole story exists for: EO used to keep one
    // global workspace row, so a second repo replaced the first.
    await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });
    await createRepositoryCommand(handle.db, credentials, { name: "web", repoPath: repoB, baseBranch: "develop", testCommand: null, lintCommand: null, buildCommand: null });

    const { repositories } = listRepositoriesCommand(handle.db, credentials);
    expect(repositories.map((repository) => repository.repoPath)).toEqual([repoA, repoB]);
    // One project holds both, and numbers both from its one prefix (KAN-128).
    expect(listProjectsCommand(handle.db).projects.map((project) => project.keyPrefix)).toEqual(["API"]);
  });

  it("refuses a prefix the project a repository was attached with holds", async () => {
    // The prefix a repository is attached with is its project's (KAN-128),
    // so this is one project refusing another rather than two tables
    // being kept in agreement — and the refusal has to survive the move,
    // because the prefix is still one counter.
    attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: repoA });

    const clash = await createProjectCommand(handle.db, { name: "Also API", keyPrefix: "API", repositoryIds: [] });

    expect(clash.ok).toBe(false);
    expect(clash.problem).toContain("API");
    expect(listProjectsCommand(handle.db).projects.map((project) => project.name)).toEqual(["api"]);
  });

  it("suggests a prefix no project is using either, since the suggestion is handed to both", async () => {
    await createProjectCommand(handle.db, { name: "Api", keyPrefix: "API", repositoryIds: [] });

    expect(suggestKeyPrefix(handle.db, "api")).not.toBe("API");
  });

  it("keeps the description it was given, on the way in and on the way through", async () => {
    const created = await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, description: "the Go payments service", baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });

    expect(created.ok).toBe(true);
    // On a project spanning several repositories this is what a story is
    // routed on, so dropping it is not cosmetic.
    expect(created.repository?.description).toBe("the Go payments service");

    const id = listRepositoriesCommand(handle.db, credentials).repositories[0]!.id;
    const changed = await updateRepositoryCommand(handle.db, credentials, { id, description: "the Rust payments service" });

    expect(changed.ok).toBe(true);
    expect(listRepositoriesCommand(handle.db, credentials).repositories[0]!.description).toBe("the Rust payments service");
  });

  it("refuses a repository id it does not have, rather than attaching nothing and answering ok", async () => {
    // Both doors that take one. Attaching is a write of the workspace's
    // own project since KAN-130, so an unknown id lands on no row at
    // all: unchecked it is not even the thrown foreign-key error the
    // membership insert used to give, but a project reported as spanning
    // one fewer than was asked for.
    const stranger = "01920000-0000-7000-8000-0000000000ff" as Uuid;

    const created = await createProjectCommand(handle.db, { name: "Acme", keyPrefix: "ACME", repositoryIds: [stranger] });
    expect(created.ok).toBe(false);
    expect(created.problem).toContain(stranger);
    expect(listProjectsCommand(handle.db).projects).toEqual([]);

    await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });
    const project = listProjectsCommand(handle.db).projects[0]!;

    const added = addRepositoryToProjectCommand(handle.db, { projectId: project.id, repositoryId: stranger });

    expect(added.ok).toBe(false);
    expect(added.problem).toContain(stranger);
    expect(listProjectsCommand(handle.db).projects[0]!.repositoryIds).toEqual(project.repositoryIds);
  });

  it("mirrors everything on a project through the one Jira the project is bound to", async () => {
    // There is no member repository to nominate any more (KAN-130). A
    // project used to point `jiraProjectId` at one of its own
    // repositories and mirror its features through that one's eight Jira
    // columns, which meant the second repository on a project carried a
    // second, unread copy of the same settings — and pointing at a
    // repository the project did not span mirrored its features into
    // somebody else's Jira.
    //
    // One binding on the project is what replaced it, so this is the
    // assertion that carries that intent: both repositories report the
    // project's Jira, because it is not either of theirs.
    const api = await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });
    const web = await createRepositoryCommand(handle.db, credentials, { name: "web", repoPath: repoB, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });
    const project = await createProjectCommand(handle.db, { name: "Acme", keyPrefix: "ACME", repositoryIds: [api.repository!.id as Uuid, web.repository!.id as Uuid] });
    const site = createJiraConnection(handle.db, { baseUrl: "https://acme.atlassian.net", flavour: "cloud", email: "dev@acme.com" });

    saveJiraBinding(handle.db, project.project!.id as Uuid, { connectionId: site.id, projectKey: "ACME" });

    const listed = listRepositoriesCommand(handle.db, credentials).repositories;
    const jiraOf = (id: string) => listed.find((repository) => repository.id === id)!.jira;
    expect(jiraOf(api.repository!.id)).toMatchObject({ connectionId: site.id, projectKey: "ACME" });
    expect(jiraOf(web.repository!.id)).toEqual(jiraOf(api.repository!.id));

    // And `projects:update` has no way to point the project at one of
    // them: the argument is gone rather than kept as a control that
    // would do nothing (invariant 12), and what the channel can still
    // change leaves the binding exactly where it is.
    expect(ipcContract["projects:update"].request.shape).not.toHaveProperty("jiraProjectId");
    expect(updateProjectCommand(handle.db, { id: project.project!.id, name: "Acme Ltd" }).ok).toBe(true);
    expect(getJiraBinding(handle.db, project.project!.id as Uuid)?.config).toMatchObject({ connectionId: site.id, projectKey: "ACME" });
  });

  it("spans a repository once when the same one is named twice", async () => {
    // A list can repeat itself, and attaching is one write of the
    // workspace's project — so `[a, a]` writes it twice and the second
    // position is the one that sticks, silently renumbering the order a
    // feature's worktree is cut from.
    const api = await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });
    const repositoryId = api.repository!.id as Uuid;

    const created = await createProjectCommand(handle.db, { name: "Acme", keyPrefix: "ACME", repositoryIds: [repositoryId, repositoryId] });

    // Deduplicated rather than refused: `projects:addProject` on a
    // repository already there is an ok no-op, and one call saying it
    // twice means what two calls saying it once mean.
    expect(created.ok).toBe(true);
    expect(listProjectsCommand(handle.db).projects.find((project) => project.keyPrefix === "ACME")?.repositoryIds).toEqual([repositoryId]);
  });

  it("goes on mirroring through the same Jira when a repository is taken off", async () => {
    // Taking a repository off used to be able to stop the mirroring.
    // `jiraProjectId` named one of the project's own repositories and
    // the membership delete left it pointing at a repository the project
    // no longer spanned, so removal had to clear it and say so.
    //
    // The binding is the project's since KAN-130, so removing a member
    // cannot reach it — which is the state the old command was trying to
    // get back to, arrived at by not having it. Proved on the repository
    // the mirroring was set up through, because that is the one the old
    // shape broke on.
    const api = await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });
    const web = await createRepositoryCommand(handle.db, credentials, { name: "web", repoPath: repoB, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });
    const project = listProjectsCommand(handle.db).projects.find((candidate) => candidate.repositoryIds[0] === api.repository!.id)!;
    const site = createJiraConnection(handle.db, { baseUrl: "https://acme.atlassian.net", flavour: "cloud", email: "dev@acme.com" });
    saveJiraBinding(handle.db, project.id as Uuid, { connectionId: site.id, projectKey: "ACME" });

    const removed = removeRepositoryFromProjectCommand(handle.db, { projectId: project.id, repositoryId: api.repository!.id });

    expect(removed.ok).toBe(true);
    expect(listProjectsCommand(handle.db).projects.find((candidate) => candidate.id === project.id)!.repositoryIds).toEqual([web.repository!.id]);
    expect(getJiraBinding(handle.db, project.id as Uuid)?.config).toMatchObject({ connectionId: site.id, projectKey: "ACME" });
  });

  it("refuses to move a repository away from a project that still has tickets on it", async () => {
    // The mirror image of `projects:removeProject`'s refusal, which has
    // always been there. Attaching is a *move* since KAN-130 — a
    // workspace belongs to one project — so attaching another project's
    // repository takes it off that project, and any ticket left behind
    // is on a project whose workspace now belongs to somebody else.
    //
    // That is not merely untidy. Jira pull resolves a binding from the
    // ticket's project; the outbox sender resolves one from the
    // workspace's project. A stranded ticket pulls its comments from one
    // Jira account and pushes its status to another, silently.
    const api = await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });
    const web = await onAnotherProject("web", repoB);
    const webProject = listProjectsCommand(handle.db).projects.find((candidate) => candidate.repositoryIds[0] === web.repository!.id)!;
    const apiProject = listProjectsCommand(handle.db).projects.find((candidate) => candidate.repositoryIds[0] === api.repository!.id)!;
    createTestItem(handle.db, { type: "story", title: "On the web checkout", stepId: "todo", workspaceId: web.repository!.id as Uuid, projectId: webProject.id as Uuid });

    const moved = addRepositoryToProjectCommand(handle.db, { projectId: apiProject.id, repositoryId: web.repository!.id });

    expect(moved.ok).toBe(false);
    expect(moved.problem).toMatch(/ticket/i);
    // And nothing moved, so the two Jira paths still agree.
    expect(listProjectsCommand(handle.db).projects.find((candidate) => candidate.id === webProject.id)!.repositoryIds).toEqual([web.repository!.id]);
  });

  it("refuses to build a new project out of a repository another project has tickets on", async () => {
    // The same move through the other door. `projects:create` takes a
    // list of repositories and attaching each one is the same write.
    const web = await createRepositoryCommand(handle.db, credentials, { name: "web", repoPath: repoB, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });
    const webProject = listProjectsCommand(handle.db).projects.find((candidate) => candidate.repositoryIds[0] === web.repository!.id)!;
    createTestItem(handle.db, { type: "story", title: "On the web checkout", stepId: "todo", workspaceId: web.repository!.id as Uuid, projectId: webProject.id as Uuid });

    const created = await createProjectCommand(handle.db, { name: "Beta", keyPrefix: "BETA", repositoryIds: [web.repository!.id] });

    expect(created.ok).toBe(false);
    expect(created.problem).toMatch(/ticket/i);
    // Refused before anything was written, so the prefix is still free.
    expect(listProjectsCommand(handle.db).projects.map((candidate) => candidate.keyPrefix)).not.toContain("BETA");
  });

  it("still moves a repository no ticket is on", async () => {
    // The guard is about stranding tickets, not about forbidding the
    // move. An untouched repository changes hands exactly as before.
    const api = await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });
    const web = await onAnotherProject("web", repoB);
    const apiProject = listProjectsCommand(handle.db).projects.find((candidate) => candidate.repositoryIds[0] === api.repository!.id)!;

    const moved = addRepositoryToProjectCommand(handle.db, { projectId: apiProject.id, repositoryId: web.repository!.id });

    expect(moved.ok).toBe(true);
    expect(listProjectsCommand(handle.db).projects.find((candidate) => candidate.id === apiProject.id)!.repositoryIds).toContain(web.repository!.id);
  });

  it("leaves the repository attached to EO when a project lets go of it", async () => {
    // Detached, not deleted (KAN-130). The membership row that used to
    // carry this is gone, so "off the project" is now a nulled column on
    // the workspace itself — and a delete there would take the checkout's
    // record with it, which is `repositories:remove`'s decision to make
    // and not this one's.
    const api = await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });
    const web = await createRepositoryCommand(handle.db, credentials, { name: "web", repoPath: repoB, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });
    const project = listProjectsCommand(handle.db).projects.find((candidate) => candidate.repositoryIds[0] === api.repository!.id)!;

    const removed = removeRepositoryFromProjectCommand(handle.db, { projectId: project.id, repositoryId: web.repository!.id });

    expect(removed.ok).toBe(true);
    expect(listProjectsCommand(handle.db).projects.find((candidate) => candidate.id === project.id)!.repositoryIds).toEqual([api.repository!.id]);
    expect(listRepositoriesCommand(handle.db, credentials).repositories.map((repository) => repository.id)).toContain(web.repository!.id);
  });

  it("refuses to add the same repository twice", async () => {
    await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });

    const again = await createRepositoryCommand(handle.db, credentials, { name: "api again", repoPath: repoA, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });

    expect(again.ok).toBe(false);
    // Names the path, so the message says which one and where. It read
    // "That repository is already a repository" until the rename that
    // produced it was cleaned up.
    expect(again.problem).toContain(`${repoA} is already attached`);
  });

  it("hands items written before any repository to the first one", async () => {
    // EO is usable before a repo is attached; those items would
    // otherwise vanish from the project the moment onboarding finished.
    const early = createTestItem(handle.db, { type: "feature", title: "Written during onboarding", stepId: null });

    const created = await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });

    expect(created.adoptedItems).toBe(1);
    expect(getItem(handle.db, early.id)?.workspaceId).toBe(created.repository?.id);
  });

  it("does not hand a later repository the items of an earlier one", async () => {
    await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });
    const second = await createRepositoryCommand(handle.db, credentials, { name: "web", repoPath: repoB, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });

    expect(second.adoptedItems).toBe(0);
  });

  it("switches the active project, and remembers it", async () => {
    await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });
    const web = await onAnotherProject("web", repoB);
    const webProject = listProjectsCommand(handle.db).projects.find((project) => project.repositoryIds[0] === web.repository!.id)!;

    setActiveProjectCommand(handle.db, { id: webProject.id });

    expect(listProjectsCommand(handle.db).activeProjectId).toBe(webProject.id);
  });

  it("falls back to a real project when the stored active one is gone", async () => {
    const api = await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });
    await onAnotherProject("web", repoB);
    const apiProject = listProjectsCommand(handle.db).projects.find((project) => project.repositoryIds[0] === api.repository!.id)!;
    setActiveProjectCommand(handle.db, { id: apiProject.id });

    // The project goes, so the stored active id now points at nothing.
    deleteProject(handle.db, apiProject.id as Uuid);

    // Not the removed id, and not null while a project still exists —
    // either would render as a blank project that looks like lost work.
    const projects = listProjectsCommand(handle.db);
    expect(projects.projects).toHaveLength(1);
    expect(projects.activeProjectId).toBe(projects.projects[0]?.id);
  });

  it("will not remove a repository that still has items, because their run history is append-only", async () => {
    const created = await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });
    createTestItem(handle.db, { type: "story", title: "Real work", stepId: "todo", workspaceId: created.repository!.id as Uuid });

    const removed = removeRepositoryCommand(handle.db, { id: created.repository!.id });

    expect(removed.ok).toBe(false);
    expect(removed.problem).toContain("append-only");
    expect(listRepositoriesCommand(handle.db, credentials).repositories).toHaveLength(1);
  });

  it("has no key prefix to change, and leaves its project's alone", async () => {
    // The prefix is the project's (KAN-128). A repository reports none,
    // so there is nothing here for an update to change — and the project
    // that carries it is not touched by renaming the repository.
    const created = await createRepositoryCommand(handle.db, credentials, { name: "api", repoPath: repoA, keyPrefix: "API", baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null });

    const updated = await updateRepositoryCommand(handle.db, credentials, { id: created.repository!.id, name: "renamed", baseBranch: "develop" });

    expect(updated.repository).toMatchObject({ name: "renamed", baseBranch: "develop" });
    expect(updated.repository).not.toHaveProperty("keyPrefix");
    expect(listProjectsCommand(handle.db).projects.map((project) => project.keyPrefix)).toEqual(["API"]);
  });
});

describe("the project reflects config changes", () => {
  it("an item in a newly added state appears under it", () => {
    saveAgent(handle.db, { name: "Tester", role: "tester", provider: "fake", model: null, instructions: "", enabled: true, config: {} });
    savePipeline(handle.db, fakeEngine(), {
      pipelineId: "default",
      entryStepId: "worktree",
      routes: currentRoutes(),
      steps: [
        ...currentStates().map((state) => (state.position >= 5 ? { ...state, position: state.position + 1 } : state)),
        { id: "qa", pipelineId: "default", position: 5, name: "qa", type: "agent", ownerRole: "tester", entryAction: "test", instructionsSummary: null, isTerminal: false, planMode: false, workspaceMode: "isolated", workspaceId: null, inputs: {}, timeoutMs: null, watch: null, results: [] },
      ],
    });

    const item = createTestItem(handle.db, { type: "story", title: "Needs QA", stepId: "qa" });

    expect(listItemSummaries(handle.db, null).items.find((entry) => entry.id === item.id)?.stepId).toBe("qa");
  });
});

describe("an agent's pipeline count (KAN-67)", () => {
  it("counts the pipelines whose steps name the agent's role, not the steps", () => {
    // Two steps of one pipeline owned by the same role is still one
    // pipeline: the number answers "how much stops if I disable this?".
    const pipeline = createPipeline(handle.db, { name: "Hotfix" });
    createStep(handle.db, { id: "hx_a", pipelineId: pipeline.id, position: 0, name: "A", ownerRole: "implementer", entryAction: "implement" });
    createStep(handle.db, { id: "hx_b", pipelineId: pipeline.id, position: 1, name: "B", ownerRole: "implementer", entryAction: "implement" });

    const implementer = listAgentDetails(handle.db).agents.find((agent) => agent.role === "implementer");

    // The seeded pipeline plus the hotfix one.
    expect(implementer?.pipelineCount).toBe(2);
  });

  it("is zero for a role no step names", () => {
    saveAgent(handle.db, { name: "Tester", role: "tester", provider: "fake", model: null, instructions: "", enabled: true, config: {} });
    expect(listAgentDetails(handle.db).agents.find((agent) => agent.role === "tester")?.pipelineCount).toBe(0);
  });
});

/**
 * What the organisation allows a device to bind an agent to (EO-328,
 * `ARCHITECTURE.md`, "Policy", "Publish, lock and versions").
 *
 * Enforced in the domain command rather than in the picker, and that is
 * the design's rule applied to this section: the system agent's admin
 * MCP server reaches this handler through the same dispatch the renderer
 * does, so a greyed dropdown is a lock only one of the two callers knows
 * about. `mcpHost/dispatch.test.ts` is where the *other* door is walked;
 * this is the command.
 */
describe("binding an agent to a backend the organisation does not allow", () => {
  function published(allowedBackends: string[] | null): void {
    writePolicy(handle.db, { ...NO_POLICY, allowedBackends, publishedAt: 1 });
  }

  it("refuses a create, and writes no row", () => {
    published(["claude"]);

    const result = saveAgent(handle.db, {
      name: "Tester", role: "tester", provider: "codex", model: null, instructions: "x", enabled: true, config: {},
    });

    expect(result.saved).toBe(false);
    expect(result.agent).toBeNull();
    expect(result.problem).toContain(NOT_ALLOWED_BY_YOUR_ORGANISATION);
    expect(result.problem).toContain('"claude"');
    expect(listAgents(handle.db).some((agent) => agent.role === "tester")).toBe(false);
  });

  it("refuses an edit that would re-point a row onto one, leaving the row as it was", () => {
    published(null);
    const agent = wrote(saveAgent(handle.db, { name: "Tester", role: "tester", provider: "fake", model: null, instructions: "x", enabled: true, config: {} }));
    published(["fake"]);

    const result = saveAgent(handle.db, { ...agent, provider: "codex" });

    expect(result.saved).toBe(false);
    expect(listAgents(handle.db).find((one) => one.id === agent.id)?.provider).toBe("fake");
  });

  it("still lets somebody edit a row that is already on a disallowed backend", () => {
    // The case that decides whether this rule is usable. A row bound
    // before the policy was published, or by the admin server, has to
    // stay editable from the one screen that exists to fix it —
    // refusing every save would leave it unrenameable, undisableable
    // and, worst of all, un-re-pointable.
    published(null);
    const agent = wrote(saveAgent(handle.db, { name: "Tester", role: "tester", provider: "codex", model: null, instructions: "x", enabled: true, config: {} }));
    published(["fake"]);

    const disabled = saveAgent(handle.db, { ...agent, enabled: false });
    expect(disabled.saved).toBe(true);
    expect(wrote(disabled).provider).toBe("codex");

    // …and re-pointing it at an allowed backend is exactly what somebody
    // came here to do.
    const fixed = saveAgent(handle.db, { ...agent, provider: "fake" });
    expect(wrote(fixed).provider).toBe("fake");
  });

  it("is untouched on an installation nobody has published to", () => {
    const result = saveAgent(handle.db, {
      name: "Tester", role: "tester", provider: "codex", model: null, instructions: "x", enabled: true, config: {},
    });

    expect(wrote(result).provider).toBe("codex");
  });

  /**
   * The same rule on the second door onto the same column (EO-329).
   *
   * `agents:setBinding` exists because a published agents section must
   * not strand somebody signed in to one backend and not the other
   * (ARCHITECTURE.md, "Publish, lock and versions") — it writes `provider` and `model` and can
   * express nothing
   * else. Which makes it exactly the shape of a way round the design: local
   * and *unconstrained* are different claims, and an organisation that
   * narrowed the list has narrowed it here too.
   */
  it("refuses a binding the organisation does not allow, on the channel a locked agents section leaves open", () => {
    published(null);
    const agent = wrote(saveAgent(handle.db, { name: "Tester", role: "tester", provider: "fake", model: null, instructions: "x", enabled: true, config: {} }));
    published(["fake"]);

    const refused = setAgentBinding(handle.db, { agentId: agent.id, provider: "codex", model: null });

    expect(refused.bound).toBe(false);
    expect(refused.problem).toContain(NOT_ALLOWED_BY_YOUR_ORGANISATION);
    expect(listAgents(handle.db).find((one) => one.id === agent.id)?.provider).toBe("fake");

    // …and the binding the organisation does allow is still the
    // person's to make, which is the whole reason this channel exists.
    const bound = setAgentBinding(handle.db, { agentId: agent.id, provider: "fake", model: "a-model" });
    expect(bound).toEqual({ bound: true, problem: null });
    expect(listAgents(handle.db).find((one) => one.id === agent.id)?.model).toBe("a-model");
  });
});

/**
 * Publishing a pipeline a stranger's event can enter (EO-334,
 * `ARCHITECTURE.md`, "Results and routes").
 *
 * Asked of the *commands* for the reason the decided-results cases above
 * are: the rule is the engine's and its own tests prove it, but whether
 * a webhook job points at this pipeline is two database reads, and a
 * validator that was never told would refuse nothing while every test it
 * has passes.
 *
 * The shipped Delivery pipeline is the case without anyone having to
 * invent one: work is indexed, implemented, reviewed and then
 * `open_pull_request` opens the pull request, which the developer pack
 * marks as a side effect. Nobody is asked in between.
 */
describe("a pipeline a webhook can enter", () => {
  const submitted = () => ({ pipelineId: "default", steps: currentStates(), routes: currentRoutes(), entryStepId: "worktree" });
  const errors = (problems: { severity: string; message: string }[]) => problems.filter((problem) => problem.severity === "error").map((problem) => problem.message);

  function webhookJobHere(): void {
    const created = createJob(handle.db, {
      projectId: null,
      name: "Support",
      trigger: { kind: "webhook", path: "support", secret: mintWebhookSecret(), mapping: { title: null, body: null, eventKey: null, spec: {} } },
      pipelineId: "default",
      template: { type: "developer:story", title: "A case", body: "" },
    });
    if (!created.ok) throw new Error(created.problem);
  }

  /** The same graph with a person in front of the step that sends. */
  function withApproveBeforeTheForge() {
    const ordered = [...currentStates()].sort((a, b) => a.position - b.position);
    const at = ordered.findIndex((step) => step.id === "merge_request");
    ordered.splice(at, 0, {
      id: "approve",
      pipelineId: "default",
      position: 0,
      name: "Approve",
      type: "user",
      ownerRole: null,
      entryAction: null,
      instructionsSummary: null,
      isTerminal: false,
      planMode: false,
      workspaceMode: "isolated",
      workspaceId: null,
      inputs: {},
      timeoutMs: null,
      watch: null,
      results: [],
    });
    const steps = ordered.map((step, index) => ({ ...step, position: index }));
    const routes = [
      ...currentRoutes().filter((route) => !(route.fromStepId === "review" && route.resultKey === "approved")),
      { id: "r_review_approve", pipelineId: "default", fromStepId: "review", resultKey: "approved", label: "Approved", tone: "success" as const, target: "approve", position: 0 },
      { id: "r_approve_send", pipelineId: "default", fromStepId: "approve", resultKey: "approved", label: "Approve", tone: "success" as const, target: "merge_request", position: 0 },
    ];
    return { pipelineId: "default", steps: consistent(steps, routes), routes, entryStepId: "worktree" };
  }

  it("takes the shipped graph while nothing can arrive from outside", () => {
    expect(errors(validatePipelineCommand(handle.db, submitted()).problems)).toEqual([]);
  });

  it("refuses it once a webhook job files onto it, in §7.4's own words", () => {
    webhookJobHere();

    expect(errors(validatePipelineCommand(handle.db, submitted()).problems)).toEqual([
      "Cases arriving by webhook go straight to Merge Request. Add an approve step before Merge Request.",
    ]);
    // And it is the publish that is refused, not only the preview.
    expect(savePipeline(handle.db, fakeEngine(), submitted()).saved).toBe(false);
  });

  it("publishes once a person stands between the event and the send", () => {
    webhookJobHere();

    expect(errors(validatePipelineCommand(handle.db, withApproveBeforeTheForge()).problems)).toEqual([]);
    expect(savePipeline(handle.db, fakeEngine(), withApproveBeforeTheForge()).saved).toBe(true);
  });
});

describe("an agent's project (EO-474)", () => {
  const opts = { exposeErrorDetails: true };
  const SYSTEM_REFUSAL = "A system agent cannot belong to a project";

  beforeEach(() => {
    registerHandler("agents:save", (payload) => saveAgent(handle.db, payload), opts);
  });

  afterEach(() => {
    clearHandlerRegistry();
  });

  async function saveOverIpc(payload: unknown): Promise<IpcResponse<"agents:save">> {
    const answer = await dispatchIpc("agents:save", payload);
    if (!answer.ok) throw new Error(`the save failed rather than answering: ${answer.error.message}`);
    return answer.data as IpcResponse<"agents:save">;
  }

  it("creates a global agent when no project is named, and a project's own when one is", async () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });

    const global = await saveOverIpc({ name: "Writer", role: "writer", provider: "fake", instructions: "Write." });
    const own = await saveOverIpc({ name: "Support writer", role: "writer", provider: "fake", instructions: "Write.", projectId: project.id });

    expect(wrote(global).projectId).toBeNull();
    expect(wrote(own).projectId).toBe(project.id);
    expect(listAgentDetails(handle.db).agents.find((agent) => agent.name === "Support writer")?.projectId).toBe(project.id);
  });

  it("keeps an agent's project through an edit that does not mention it, and makes it global on an explicit null", async () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const own = wrote(await saveOverIpc({ name: "Support writer", role: "writer", provider: "fake", instructions: "Write.", projectId: project.id }));

    await saveOverIpc({ id: own.id, name: "Renamed", role: own.role, provider: own.provider, instructions: own.instructions });
    expect(getAgent(handle.db, own.id as Uuid)?.projectId).toBe(project.id);

    await saveOverIpc({ id: own.id, name: "Renamed", role: own.role, provider: own.provider, instructions: own.instructions, projectId: null });
    expect(getAgent(handle.db, own.id as Uuid)?.projectId).toBeNull();
  });

  it("refuses a system agent with a project, with a sentence, and writes nothing", async () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const system = listAgents(handle.db).find((agent) => agent.role === "system")!;
    const before = listAgents(handle.db);

    const created = await saveOverIpc({ name: "Support assistant", role: "system", provider: "fake", instructions: "Help.", projectId: project.id });
    const edited = await saveOverIpc({ id: system.id, name: system.name, role: "system", provider: system.provider, instructions: system.instructions, projectId: project.id });

    for (const result of [created, edited]) {
      expect(result.saved).toBe(false);
      expect(result.agent).toBeNull();
      expect(result.problem).toContain(SYSTEM_REFUSAL);
    }
    expect(listAgents(handle.db)).toEqual(before);
  });

  it("refuses a project that does not exist, rather than failing on the key", async () => {
    const result = await saveOverIpc({ name: "Writer", role: "writer", provider: "fake", instructions: "Write.", projectId: "0199aa00-0000-7000-8000-00000000dead" });

    expect(result.saved).toBe(false);
    expect(result.problem).toContain("no project with that id");
    expect(listAgents(handle.db).some((agent) => agent.name === "Writer")).toBe(false);
  });

  it("a deletion the database refuses leaves the project's own agents exactly as they were, attachments included", async () => {
    // Archiving and detaching the agents comes before the project's
    // delete, so the two have to be one transaction: a project that still
    // has items fails on `items.project_id`, and must keep its agents
    // live, scoped and attached on the way to failing.
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const own = wrote(
      await saveOverIpc({ name: "Support writer", role: "writer", provider: "fake", instructions: "Valuable instructions", config: { effort: "high" }, projectId: project.id }),
    );
    const playbook = saveSkill(handle.db, SkillDraftSchema.parse({ name: "House style", description: "How we write.", body: "Be brief." }));
    if (!playbook.ok) throw new Error(playbook.problems.join("\n"));
    expect(setAgentAttachment(handle.db, { agentId: own.id, kind: "skill", id: playbook.skill.id, attached: true }).ok).toBe(true);
    createTestItem(handle.db, { type: "story", title: "Still here", stepId: "todo", projectId: project.id });
    const before = { agent: getAgent(handle.db, own.id as Uuid), attachments: getAgentAttachments(handle.db, own.id) };

    expect(() => deleteProject(handle.db, project.id)).toThrow();

    expect(getProject(handle.db, project.id)).toBeDefined();
    expect({ agent: getAgent(handle.db, own.id as Uuid), attachments: getAgentAttachments(handle.db, own.id) }).toEqual(before);
    expect(before.agent).toMatchObject({ instructions: "Valuable instructions", projectId: project.id, archivedAt: null, deletedAt: null });
    expect(before.attachments.skillIds).toEqual([playbook.skill.id]);
  });

  it("deleting a project archives its own agents rather than deleting them, history and all (EO-476)", async () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const own = wrote(
      await saveOverIpc({ name: "Support writer", role: "writer", provider: "fake", instructions: "Write in our voice.", config: { effort: "high" }, projectId: project.id }),
    );
    const playbook = saveSkill(handle.db, SkillDraftSchema.parse({ name: "House style", description: "How we write.", body: "Be brief." }));
    if (!playbook.ok) throw new Error(playbook.problems.join("\n"));
    expect(setAgentAttachment(handle.db, { agentId: own.id, kind: "skill", id: playbook.skill.id, attached: true }).ok).toBe(true);
    const rowsBefore = listAgents(handle.db).length;

    deleteProject(handle.db, project.id);

    // The row is still there — not a tombstone, an archived agent with
    // everything it had — and nothing dispatches it.
    expect(listAgents(handle.db)).toHaveLength(rowsBefore);
    const after = getAgent(handle.db, own.id as Uuid)!;
    expect(after).toMatchObject({ name: "Support writer", instructions: "Write in our voice.", config: { effort: "high" }, provider: "fake", deletedAt: null, projectId: null });
    expect(after.archivedAt).not.toBeNull();
    expect(getAgentAttachments(handle.db, own.id).skillIds).toEqual([playbook.skill.id]);
    expect(isDispatchable(after)).toBe(false);
  });

  it("deleting a project keeps the stamp on an agent of its that was already archived (EO-476)", async () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const own = wrote(await saveOverIpc({ name: "Support writer", role: "writer", provider: "fake", instructions: "Write.", projectId: project.id }));
    archiveAgent(handle.db, own.id as Uuid, 1_000);

    deleteProject(handle.db, project.id);

    expect(getAgent(handle.db, own.id as Uuid)).toMatchObject({ archivedAt: 1_000, deletedAt: null, projectId: null });
  });
});

describe("keep checking across a save that does not mention it (EO-506)", () => {
  const opts = { exposeErrorDetails: true };

  beforeEach(() => {
    registerHandler("pipeline:save", (payload) => savePipeline(handle.db, fakeEngine(), payload), opts);
  });

  afterEach(() => {
    clearHandlerRegistry();
  });

  async function saveOverIpc(payload: unknown): Promise<IpcResponse<"pipeline:save">> {
    const answer = await dispatchIpc("pipeline:save", payload);
    if (!answer.ok) throw new Error(`the save failed rather than answering: ${answer.error.message}`);
    return answer.data as IpcResponse<"pipeline:save">;
  }

  /** The shipped graph as it stands, each step passed through `edit`. */
  function graphWith(edit: (step: PipelineStepView) => Record<string, unknown>) {
    const graph = listPipelineStepViews(handle.db, { pipelineId: "default" });
    return { pipelineId: "default", steps: graph.steps.map(edit), routes: graph.routes, entryStepId: graph.entryStepId };
  }

  /**
   * The shipped graph with the pull request watch handed to a person, and
   * `watch` as given. The one valid way to stop it keeping checking:
   * `watch_pull_request` answers "waiting", so the validator refuses it on
   * a step that runs once (EO-505), and a person's step cannot keep
   * checking at all.
   */
  function watchHandedToAPerson(watch: Record<string, unknown>) {
    const graph = listPipelineStepViews(handle.db, { pipelineId: "default" });
    const steps = graph.steps.map((step) => (step.id === "pull_request_watch" ? { ...step, type: "user" as const, entryAction: null, ownerRole: null } : step));
    // Less the branches that went to a person: on a person's step that is
    // where the item already is.
    const routes = graph.routes.filter((route) => route.fromStepId !== "pull_request_watch" || route.target !== USER_ATTENTION_TARGET);
    return {
      pipelineId: "default",
      // `watch` taken off before the override goes on, so `{}` is a step
      // that leaves the field out rather than one resending what it had.
      steps: consistent(steps, routes).map(({ watch: stored, ...step }) => (step.id === "pull_request_watch" ? { ...step, ...watch } : { ...step, watch: stored })),
      routes,
      entryStepId: graph.entryStepId,
    };
  }

  const watchOf = (id: string) => listStepsForPipeline(handle.db, "default").find((step) => step.id === id)?.watch;

  it("keeps the shipped pull request watch when no step says anything about watch", async () => {
    expect(watchOf("pull_request_watch")).toEqual({ everyMinutes: 5, giveUpAfterHours: 168 });

    const saved = await saveOverIpc(graphWith(({ watch: _watch, ...step }) => step));

    expect(saved.saved).toBe(true);
    expect(watchOf("pull_request_watch")).toEqual({ everyMinutes: 5, giveUpAfterHours: 168 });
    expect(saved.watchTurnedOff).toEqual([]);
  });

  it("turns it off on an explicit null, and the answer names the step", async () => {
    const saved = await saveOverIpc(watchHandedToAPerson({ watch: null }));

    expect(saved.problems.filter((problem) => problem.severity === "error")).toEqual([]);
    expect(saved.saved).toBe(true);
    expect(watchOf("pull_request_watch")).toBeNull();
    expect(saved.watchTurnedOff).toEqual([{ stepId: "pull_request_watch", name: "Watching pull request" }]);
  });

  it("stores a changed interval, and does not report it as turned off", async () => {
    const saved = await saveOverIpc(graphWith((step) => (step.id === "pull_request_watch" ? { ...step, watch: { everyMinutes: 15, giveUpAfterHours: 24 } } : step)));

    expect(saved.saved).toBe(true);
    expect(watchOf("pull_request_watch")).toEqual({ everyMinutes: 15, giveUpAfterHours: 24 });
    expect(saved.watchTurnedOff).toEqual([]);
  });

  it("stores a watch that never gives up, reads it back unchanged, and keeps it on a save that leaves watch out (EO-571)", async () => {
    const never = { everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true };
    const saved = await saveOverIpc(graphWith((step) => (step.id === "pull_request_watch" ? { ...step, watch: { everyMinutes: 5, neverGivesUp: true } } : step)));

    expect(saved.saved).toBe(true);
    expect(watchOf("pull_request_watch")).toEqual(never);
    expect(saved.watchTurnedOff).toEqual([]);

    // Sent back as it reads, it is the same; left out, it is kept.
    expect((await saveOverIpc(graphWith((step) => (step.id === "pull_request_watch" ? { ...step, watch: watchOf("pull_request_watch")! } : step)))).saved).toBe(true);
    expect(watchOf("pull_request_watch")).toEqual(never);
    expect((await saveOverIpc(graphWith(({ watch: _watch, ...step }) => step))).saved).toBe(true);
    expect(watchOf("pull_request_watch")).toEqual(never);

    // And a number of hours again is a deadline again, exactly as before.
    expect((await saveOverIpc(graphWith((step) => (step.id === "pull_request_watch" ? { ...step, watch: { everyMinutes: 5, giveUpAfterHours: 24 } } : step)))).saved).toBe(true);
    expect(watchOf("pull_request_watch")).toEqual({ everyMinutes: 5, giveUpAfterHours: 24 });
  });

  it("judges a step that leaves watch out by the setting it keeps", async () => {
    // Handed to a person without a word about watch: the step still keeps
    // checking as far as this save is concerned, and a person's step
    // cannot — so the save is refused rather than quietly turning it off.
    const graph = watchHandedToAPerson({});
    expect(graph.steps.find((step) => step.id === "pull_request_watch")).not.toHaveProperty("watch");

    const refused = await saveOverIpc(graph);

    expect(refused.saved).toBe(false);
    expect(refused.problems.map((problem) => problem.message)).toContain(
      `"Watching pull request" is set to keep checking, which only a step EO runs or a step a script runs can do.`,
    );
    expect(watchOf("pull_request_watch")).toEqual({ everyMinutes: 5, giveUpAfterHours: 168 });
  });

  it("says nothing on a save of a step that was not keeping checking", async () => {
    expect((await saveOverIpc(watchHandedToAPerson({ watch: null }))).saved).toBe(true);

    // Already off: a second save that says null again changed nothing.
    const again = await saveOverIpc(watchHandedToAPerson({ watch: null }));

    expect(again.saved).toBe(true);
    expect(again.watchTurnedOff).toEqual([]);
  });
});
