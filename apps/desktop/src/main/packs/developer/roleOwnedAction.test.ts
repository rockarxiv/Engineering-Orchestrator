import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { developerRegistry, outputSchemaFor, type AgentEvent, type AgentProviderStartOptions, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../db/client.js";
import { saveActionDefinition } from "../../db/repos/actionDefinitionsRepo.js";
import { createAgent } from "../../db/repos/agentsRepo.js";
import { listCommentsForItem } from "../../db/repos/commentsRepo.js";
import { createProject, createRoute, createRun, postComment, updateWorkspace, type Workspace } from "../../db/repos/index.js";
import { getItem } from "../../db/repos/itemsRepo.js";
import { createStep } from "../../db/repos/pipelineStepsRepo.js";
import { listRunsForItem } from "../../db/repos/runsRepo.js";
import { attachWorkspace, createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../../db/testHelpers.js";
import { packMeaningInForce } from "../../registry.js";
import { isProposal, PROPOSAL_KIND } from "../../roles/proposal.js";
import { buildSeedContext } from "../../supervisor/buildDispatchContext.js";
import { createRunSupervisor } from "../../supervisor/runSupervisor.js";
import { installedKinds, preparedIn } from "../../supervisor/testWorkspaceKinds.js";
import { reviewAppendix } from "./forge/reviewAppendix.js";
import { developerSectionRenderers } from "./sections.js";
import { createRoleWiring } from "./wiring.js";
import { gitWorkspaceKind } from "./workspace/gitKind.js";

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const DEFAULT = "default" as never;

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** Answers each dispatch with one scripted result, and keeps what the dispatch was sent. */
function recordingProvider(result: unknown) {
  const started: AgentProviderStartOptions[] = [];
  const corrections: string[] = [];
  return {
    started,
    corrections,
    provider: {
      async *start(opts: AgentProviderStartOptions): AsyncIterable<AgentEvent> {
        started.push(opts);
        yield { type: "thread_started", threadId: `t${started.length}` };
        yield { type: "result", data: result };
      },
      async *resume(_threadId: string, message: string): AsyncIterable<AgentEvent> {
        corrections.push(message);
        yield { type: "result", data: result };
      },
    },
  };
}

/** The action's own branch of the provider wrapper, beside the clarification. */
function answerBranch(schema: Record<string, unknown> | undefined): { properties: Record<string, { enum?: string[] }>; required: string[] } {
  return (schema?.["properties"] as { outcome: { anyOf: never[] } }).outcome.anyOf[1]!;
}

/**
 * A role's own definition replaces the pack's behaviour for that action
 * name (EO-422).
 *
 * The developer pack means something by `review` and by `implement`: a
 * verdict to read, feedback to post, a pull-request body to ask for, a
 * branch to verify, a diff to attach, a plan to ask for first. A `qa`
 * role that defines either name for itself means something else, and
 * gets none of it — while the same step owned by a custom role that
 * defined nothing still gets all of it, which is what makes this a
 * question about the role's definition and not about who shipped the
 * role.
 *
 * Through a real supervisor with the pack's own wiring, sections and git
 * kind installed, because the point is the sites agreeing: a schema sent
 * as the role's and a verdict read as the pack's is the bug.
 */
describe("a pack's action name, on a step owned by a custom role", () => {
  let handle: DbHandle;
  let scratch: string;
  let repoPath: string;
  let repository: Workspace;
  let projectId: string;
  let qaId: string;
  let auditorId: string;

  function supervisorWith(provider: ReturnType<typeof recordingProvider>["provider"]) {
    return createRunSupervisor({
      db: handle.db,
      provider,
      limits: LIMITS,
      sectionRenderers: developerSectionRenderers,
      ...createRoleWiring(handle.db),
      kinds: installedKinds({
        // The pack's own kind, over the fixture repository: only where
        // the run works is decided here, so its verifier and its
        // artifacts are the real ones and answer for themselves.
        ...gitWorkspaceKind({ db: handle.db, intelligenceFor: () => null, isGitRepository: () => true, verifyOptions: { timeoutMs: 15_000 } }),
        prepare: async (item) => preparedIn(item, repoPath),
      }),
    });
  }

  function storyOn(stepId: string): Item {
    return createTestItem(handle.db, {
      type: "story",
      title: "Rate limiting",
      stepId,
      workspaceId: repository.id,
      projectId: projectId as never,
      spec: REVIEWABLE_SPEC,
      git: { branch: "eo/RL-1" },
    });
  }

  beforeEach(() => {
    handle = openMigratedTestDb();
    scratch = mkdtempSync(join(tmpdir(), "eo role owned action "));
    repoPath = join(scratch, "repo");
    mkdirSync(repoPath, { recursive: true });
    git(["init", "-b", "main"], repoPath);
    git(["config", "user.email", "eo@example.com"], repoPath);
    git(["config", "user.name", "EO"], repoPath);
    git(["config", "commit.gpgsign", "false"], repoPath);
    git(["config", "tag.gpgsign", "false"], repoPath);
    writeFileSync(join(repoPath, "README.md"), "# repo\n");
    git(["add", "-A"], repoPath);
    git(["commit", "-m", "initial"], repoPath);

    repository = attachWorkspace(handle.db, { name: "acme-api", keyPrefix: "API", repoPath, baseBranch: "main" });
    // A repository that opens pull requests, which is when the pack's
    // review asks for a description.
    updateWorkspace(handle.db, repository.id, { config: { forgeOpenPr: true, forgeKind: "github" } });
    projectId = createProject(handle.db, { name: "Rate limits", keyPrefix: "RL", workspaceIds: [repository.id] }).id;

    qaId = createAgent(handle.db, { name: "QA", role: "qa", provider: "claude", instructions: "You check work." }).id;
    auditorId = createAgent(handle.db, { name: "Auditor", role: "auditor", provider: "claude", instructions: "You audit." }).id;

    createStep(handle.db, { id: "rework", pipelineId: DEFAULT, position: -2, name: "Rework", type: "user", ownerRole: null, entryAction: null });
    createStep(handle.db, { id: "accepted", pipelineId: DEFAULT, position: -1, name: "Accepted", type: "user", ownerRole: null, entryAction: null });

    // Two review steps and two implement steps, alike but for who owns
    // them. Plan mode is on for both implement steps.
    createStep(handle.db, { id: "qa_review", pipelineId: DEFAULT, position: -9, name: "QA", type: "agent", ownerRole: "qa", entryAction: "review" });
    createRoute(handle.db, { pipelineId: DEFAULT, fromStepId: "qa_review", resultKey: "passed", label: "Passed", target: "accepted", position: 0 });
    createRoute(handle.db, { pipelineId: DEFAULT, fromStepId: "qa_review", resultKey: "failed", label: "Failed", target: "rework", position: 1 });

    createStep(handle.db, { id: "audit", pipelineId: DEFAULT, position: -8, name: "Audit", type: "agent", ownerRole: "auditor", entryAction: "review" });
    createRoute(handle.db, { pipelineId: DEFAULT, fromStepId: "audit", resultKey: "approved", label: "Approved", target: "accepted", position: 0 });
    createRoute(handle.db, { pipelineId: DEFAULT, fromStepId: "audit", resultKey: "changes_requested", label: "Changes requested", target: "rework", position: 1 });

    createStep(handle.db, { id: "qa_build", pipelineId: DEFAULT, position: -7, name: "QA build", type: "agent", ownerRole: "qa", entryAction: "implement", planMode: true });
    createRoute(handle.db, { pipelineId: DEFAULT, fromStepId: "qa_build", resultKey: "built", label: "Built", target: "accepted", position: 0 });

    createStep(handle.db, { id: "audit_build", pipelineId: DEFAULT, position: -6, name: "Audit build", type: "agent", ownerRole: "auditor", entryAction: "implement", planMode: true });
    createRoute(handle.db, { pipelineId: DEFAULT, fromStepId: "audit_build", resultKey: "done", label: "Done", target: "accepted", position: 0 });

    // `qa` defines both names for itself; `auditor` defines neither.
    expect(
      saveActionDefinition(handle.db, {
        role: "qa",
        action: "review",
        description: "Exercise the change by hand.",
        results: [
          { key: "passed", label: "Passed", meaning: "Everything asked for works." },
          { key: "failed", label: "Failed", meaning: "Something asked for does not work." },
        ],
      }).ok,
    ).toBe(true);
    expect(saveActionDefinition(handle.db, { role: "qa", action: "implement", description: "Write the test plan.", results: [{ key: "built", meaning: "The plan is written." }] }).ok).toBe(true);
  });

  afterEach(() => {
    handle.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  describe("review, defined by the role", () => {
    it("is dispatched with the generated schema rather than the reviewer's verdict shape", async () => {
      storyOn("qa_review");
      const { provider, started } = recordingProvider({ result: "failed", summary: "The limiter never returns 429." });

      await supervisorWith(provider).runOnce();

      const branch = answerBranch(started[0]?.outputSchema);
      expect(branch.properties["result"]?.enum).toEqual(["passed", "failed"]);
      expect(branch.required).toEqual(["result", "summary"]);
      expect(JSON.stringify(started[0]?.outputSchema)).not.toContain("verdict");
    });

    it("routes on its result, and leaves its summary — not review feedback — in the thread", async () => {
      const story = storyOn("qa_review");
      const { provider, corrections } = recordingProvider({ result: "failed", summary: "The limiter never returns 429." });

      await supervisorWith(provider).runOnce();

      expect(corrections).toEqual([]);
      expect(listRunsForItem(handle.db, story.id)[0]?.status).toBe("succeeded");
      expect(getItem(handle.db, story.id)?.stepId).toBe("rework");

      const fromTheAgent = listCommentsForItem(handle.db, story.id).filter((comment) => comment.authorType === "agent");
      expect(fromTheAgent.map((comment) => [comment.kind, comment.body])).toEqual([["note", "The limiter never returns 429."]]);
      // Nothing in the reviewer's voice, from anyone.
      const everything = listCommentsForItem(handle.db, story.id);
      expect(everything.filter((comment) => comment.kind === "approval" || comment.kind === "rejection")).toEqual([]);
      expect(everything.map((comment) => comment.body).join("\n")).not.toMatch(/Changes requested\.|Approved\./);
    });

    it("has no review appendix in its task", async () => {
      const story = storyOn("qa_review");
      const { provider, started } = recordingProvider({ result: "passed", summary: "Works." });

      await supervisorWith(provider).runOnce();

      const prompt = started[0]?.context ?? "";
      expect(prompt).toContain("Exercise the change by hand.");
      expect(prompt).not.toContain("## If you approve");
      expect(prompt).not.toContain("pull_request_body");
      expect(await reviewAppendix(handle.db, story, "review", "qa")).toBeNull();
    });
  });

  describe("review, on a custom role that defined nothing", () => {
    it("still gets the pack's review in full: verdict-derived result key, feedback comment and appendix", async () => {
      const story = storyOn("audit");
      const { provider, started, corrections } = recordingProvider({ verdict: "approve", feedback: "Reads cleanly.", pull_request_body: "Adds a limiter." });

      await supervisorWith(provider).runOnce();

      // The reviewer's shape, by action name.
      expect(JSON.stringify(started[0]?.outputSchema)).toEqual(JSON.stringify(outputSchemaFor(developerRegistry(), "review")));
      expect(corrections).toEqual([]);
      // The appendix.
      expect(started[0]?.context).toContain("## If you approve");
      expect(started[0]?.context).toContain("pull_request_body");
      expect(await reviewAppendix(handle.db, story, "review", "auditor")).toContain("pull_request_body");
      // The key derived from the verdict: `approve` took the `approved` route.
      expect(getItem(handle.db, story.id)?.stepId).toBe("accepted");
      // And the feedback, posted as the reviewer's would be.
      const feedback = listCommentsForItem(handle.db, story.id).filter((comment) => comment.authorType === "agent");
      expect(feedback).toHaveLength(1);
      expect(feedback[0]).toMatchObject({ kind: "approval", authorId: auditorId });
      expect(feedback[0]?.body).toContain("Approved.");
      expect(feedback[0]?.body).toContain("Reads cleanly.");
    });
  });

  describe("implement, defined by the role, in a git workspace with plan mode on", () => {
    it("gets no plan-mode section and no word about a checked worktree", async () => {
      storyOn("qa_build");
      const { provider, started } = recordingProvider({ result: "built", summary: "The plan is in the thread." });

      await supervisorWith(provider).runOnce();

      const prompt = started[0]?.context ?? "";
      expect(prompt).toContain("Write the test plan.");
      expect(prompt).not.toContain("## Propose before you change anything");
      expect(prompt).not.toContain("The worktree is checked after this run");
    });

    it("runs no implement verification and posts no diff output", async () => {
      const story = storyOn("qa_build");
      const { provider } = recordingProvider({ result: "built", summary: "The plan is in the thread." });

      await supervisorWith(provider).runOnce();

      // A branch nobody cut: the pack's verification would have failed
      // this run on it. Nothing verified it, so it succeeded and moved.
      const run = listRunsForItem(handle.db, story.id)[0];
      expect(run?.status).toBe("succeeded");
      expect(run?.verification ?? null).toBeNull();
      expect(run?.checks ?? []).toEqual([]);
      expect(getItem(handle.db, story.id)?.stepId).toBe("accepted");

      const comments = listCommentsForItem(handle.db, story.id);
      expect(comments.filter((comment) => comment.kind === "output")).toEqual([]);
      // Nor the engine's report that plan mode was skipped: this run was
      // never asked to plan.
      expect(comments.filter((comment) => comment.authorType === "engine")).toEqual([]);
      // Nor the implementer's handoff. Its summary is the handoff.
      expect(comments.filter((comment) => comment.authorType === "agent").map((comment) => comment.body)).toEqual(["The plan is in the thread."]);
    });

    it("is told by the git kind itself: no checks and no artifacts for a run that is the role's own", async () => {
      const story = storyOn("qa_build");
      const kind = gitWorkspaceKind({ db: handle.db, intelligenceFor: () => null, isGitRepository: () => true, verifyOptions: { timeoutMs: 15_000 } });
      const run = { id: "01a0" as never, action: "implement", workspace: preparedIn(story, repoPath).workspace, result: null, ended: "succeeded" as const };

      expect(await kind.verifiers["implement"]!(story, { ...run, packAction: false })).toEqual([]);
      expect(await kind.artifacts(story, { ...run, packAction: false })).toEqual([]);
      // The same run as the pack's is checked, and fails on a branch
      // that does not exist — which is what the silence above is not.
      const checked = await kind.verifiers["implement"]!(story, { ...run, packAction: true });
      expect(checked.map((check) => [check.key, check.passed])).toEqual([["implementation", false]]);
    });
  });

  describe("implement, on a custom role that defined nothing", () => {
    it("is still asked to plan first, held to the implement shape and verified against its branch", async () => {
      const story = storyOn("audit_build");
      const { provider, started } = recordingProvider({ branch: "eo/RL-1", summary: "Did it.", files_changed: [], tests_run: false, handoff: "Nothing to add." });

      await supervisorWith(provider).runOnce();

      expect(JSON.stringify(started[0]?.outputSchema)).toEqual(JSON.stringify(outputSchemaFor(developerRegistry(), "implement")));
      expect(started[0]?.context).toContain("## Propose before you change anything");
      expect(started[0]?.context).toContain("The worktree is checked after this run");
      // Verified, and refused: the branch it claimed was never cut.
      expect(listRunsForItem(handle.db, story.id)[0]?.status).toBe("failed");
      expect(getItem(handle.db, story.id)?.stepId).toBe("audit_build");
    });
  });

  describe("the one question every site asks", () => {
    it("answers for the pair, and always yes for a preview", () => {
      const story = storyOn("qa_review");
      const rehearsal = createTestItem(handle.db, { type: "story", title: "Rehearsal", stepId: "qa_review", previewAt: Date.now() });

      expect(packMeaningInForce(handle.db, story, "qa", "review")).toBe(false);
      expect(packMeaningInForce(handle.db, story, "qa", "implement")).toBe(false);
      expect(packMeaningInForce(handle.db, story, "qa", "refine")).toBe(true);
      expect(packMeaningInForce(handle.db, story, "auditor", "review")).toBe(true);
      expect(packMeaningInForce(handle.db, story, "reviewer", "review")).toBe(true);
      expect(packMeaningInForce(handle.db, story, null, "review")).toBe(true);
      // A preview is held to no role's definition, so it is the pack's.
      expect(packMeaningInForce(handle.db, rehearsal, "qa", "review")).toBe(true);
    });

    it("keeps the already-written note off a refine the role defined for itself", async () => {
      expect(saveActionDefinition(handle.db, { role: "qa", action: "refine", results: [{ key: "ready" }] }).ok).toBe(true);
      createStep(handle.db, { id: "qa_refine", pipelineId: DEFAULT, position: -5, name: "QA refine", type: "agent", ownerRole: "qa", entryAction: "refine" });
      createStep(handle.db, { id: "audit_refine", pipelineId: DEFAULT, position: -4, name: "Audit refine", type: "agent", ownerRole: "auditor", entryAction: "refine" });
      const qa = { id: qaId, role: "qa" } as never;
      const auditor = { id: auditorId, role: "auditor" } as never;

      const own = await buildSeedContext(handle.db, storyOn("qa_refine"), qa, "refine", developerSectionRenderers);
      const packs = await buildSeedContext(handle.db, storyOn("audit_refine"), auditor, "refine", developerSectionRenderers);

      // A story is a leaf, so the pack's `refine` on it is the clarify
      // half — for the role that did not define its own.
      expect(packs).toContain("## This is already written — do not decompose it");
      expect(own).not.toContain("## This is already written — do not decompose it");
    });

    it("does not read a decision left during a role's own refine as a plan to approve", () => {
      expect(saveActionDefinition(handle.db, { role: "qa", action: "refine", results: [{ key: "ready" }] }).ok).toBe(true);
      const story = storyOn("qa_review");
      const decisionFrom = (agentId: string) => {
        const run = createRun(handle.db, { itemId: story.id, agentId: agentId as never, provider: "claude", action: "refine", attempt: 1 });
        return postComment(handle.db, { itemId: story.id, runId: run.id, author: { type: "agent", agentId: agentId as never }, kind: PROPOSAL_KIND, body: "A decision." });
      };

      expect(isProposal(handle.db, decisionFrom(auditorId))).toBe(true);
      expect(isProposal(handle.db, decisionFrom(qaId))).toBe(false);
    });
  });
});
