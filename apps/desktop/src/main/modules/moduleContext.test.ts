import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Item, ModuleManifest, Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  createRun,
  createStep,
  getItem,
  listTransitionsForItem,
  startItemWatch,
  listAgents,
  listItemTypes,
  listPipelines,
  listStepsForPipeline,
  saveModule,
  transitionItem,
  updateRun,
  updateWorkspace,
} from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { preparingAt } from "../supervisor/testWorkspaceKinds.js";
import { moduleItemReader, type ModuleItemReaderOptions } from "./moduleItemRead.js";
import { createModuleRunnerLookup } from "./registry.js";
import { storeSecret, storeVariable, type ModuleSecretsOptions } from "./secrets.js";

/**
 * `ctx.run`, `ctx.workspace` and `ctx.project` (EO-711) — through the
 * registry, the main process's reader and the real module host, so what
 * is asserted is what a module reads on a real run.
 */
const here = dirname(fileURLToPath(import.meta.url));

const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${text}`),
  decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ""),
};

const manifest: ModuleManifest = {
  name: "Context",
  description: "Reports what it was told.",
  inputs: {},
  needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
  results: ["ok"],
};

/** A module that answers with its three values, and `ctx.cwd` beside them. */
const REPORTER = `export default async function run(ctx) {
  return { ok: true, result: "ok", detail: JSON.stringify({ cwd: ctx.cwd, run: ctx.run, workspace: ctx.workspace, project: ctx.project }) };
}`;

interface Reported {
  cwd: string;
  run: {
    step: { id: string; name: string } | null;
    pipeline: { id: string; name: string } | null;
    attempt: number;
    cameFrom: { step: { id: string; name: string } | null; result: string | null };
    trial: boolean;
    watch: unknown;
  };
  workspace: {
    kind: string;
    id: string | null;
    name: string | null;
    git: {
      repositoryName: string;
      mainCheckout: string;
      worktreePath: string;
      baseBranch: string;
      testCommand: string | null;
      lintCommand: string | null;
      buildCommand: string | null;
      forge: { kind: string | null; remote: string; draft: boolean; opensPullRequests: boolean };
    } | null;
  };
  project: {
    id: string;
    name: string;
    keyPrefix: string;
    workspaces: { kind: string; id: string; name: string }[];
    itemTypes: { id: string; slug: string; label: string; container: boolean; fields: { name: string; kind: string; required: boolean }[] }[];
    pipelines: { id: string; name: string; steps: { id: string; name: string; kind: string }[] }[];
  } | null;
}

let handle: DbHandle;
let scratch: string;
let secrets: ModuleSecretsOptions;
let saves = 0;

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-711-"));
  secrets = { directory: join(scratch, "secrets"), store };
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
});

async function report(item: Item, options: { reader?: ModuleItemReaderOptions; env?: string[] } = {}): Promise<Reported> {
  const saved = saveModule(handle.db, {
    // A fresh slug each call: one test reports twice, and the slug is unique.

    slug: `context-${(saves += 1)}`,
    name: "Context",
    description: manifest.description,
    code: REPORTER,
    manifest: { ...manifest, needs: { ...manifest.needs, env: options.env ?? [] } },
    approve: true,
  });
  if (!saved.ok) throw new Error(saved.reason);
  const launcher = { execPath: process.execPath, hostPath: join(here, "moduleHost.mjs"), hostEnv: { ELECTRON_RUN_AS_NODE: "1" }, items: moduleItemReader(handle.db, options.reader) };
  const runner = createModuleRunnerLookup({ db: handle.db, launcher, secrets })(saved.module.id)!;
  const run = createRun(handle.db, { itemId: item.id, agentId: null, action: saved.module.id, status: "running", attempt: 3 });
  const outcome = await runner({ db: handle.db, item: getItem(handle.db, item.id)!, prepareWorkspace: preparingAt(scratch), report: () => {}, runId: run.id });
  if (!outcome.ok) throw new Error(`the module failed: ${outcome.reason}`);
  return JSON.parse(outcome.detail) as Reported;
}

const agentId = (role: string): Uuid => listAgents(handle.db).find((agent) => agent.role === role)!.id;

describe("ctx.run", () => {
  it("names the step it runs on, and the step and result that sent the item there", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Read the run", stepId: "todo" });
    const implemented = createRun(handle.db, { itemId: item.id, agentId: agentId("implementer"), action: "implement", stepId: "todo" });
    const answer = { summary: "Did it.", result: "done" };
    updateRun(handle.db, implemented.id, { status: "succeeded", result: { raw: answer, parsed: answer } });
    transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: agentId("implementer"), runId: implemented.id, reason: "run succeeded" });

    const { run } = await report(item);

    expect(run.step).toEqual({ id: "review", name: "Review" });
    expect(run.cameFrom).toEqual({ step: { id: "todo", name: "To Do" }, result: "done" });
    expect(run.attempt).toBe(3);
    expect(run.trial).toBe(false);
    expect(run.watch).toBeNull();
    expect(run.pipeline).toEqual({ id: item.pipelineId, name: expect.any(String) });
  });

  it("reads the result that routed it the way the installed pack reads it", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Reviewed", stepId: "review" });
    const reviewed = createRun(handle.db, { itemId: item.id, agentId: agentId("reviewer"), action: "review", stepId: "review" });
    const answer = { verdict: "changes" };
    updateRun(handle.db, reviewed.id, { status: "succeeded", result: { raw: answer, parsed: answer } });
    transitionItem(handle.db, { itemId: item.id, toStepId: "todo", actor: agentId("reviewer"), runId: reviewed.id, reason: "changes requested" });

    const { run } = await report(item, { reader: { resultKey: (each) => (each.action === "review" ? "changes_requested" : undefined) } });

    expect(run.step).toEqual({ id: "todo", name: "To Do" });
    expect(run.cameFrom).toEqual({ step: { id: "review", name: "Review" }, result: "changes_requested" });
  });

  it("says nothing sent an item that has stood on its step since it was made, or a person moved", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "New", stepId: "todo" });
    expect((await report(item)).run.cameFrom.result).toBeNull();

    transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "human", reason: "moved by hand" });
    expect((await report(item)).run.cameFrom).toEqual({ step: { id: "todo", name: "To Do" }, result: null });
  });
});

describe("ctx.run on a step that keeps checking", () => {
  it("says since when it has waited, how long so far and how often it checks", async () => {
    createStep(handle.db, { id: "wait", pipelineId: "default" as Uuid, position: 15, name: "Wait", type: "builtin", entryAction: "create_worktree", watch: { everyMinutes: 30, giveUpAfterHours: 168 } });
    const item = createTestItem(handle.db, { type: "story", title: "Waiting", stepId: "todo" });
    transitionItem(handle.db, { itemId: item.id, toStepId: "wait", actor: "engine" });
    const stay = listTransitionsForItem(handle.db, item.id).at(-1)!.id;
    const startedAt = Date.now() - 90_000;
    startItemWatch(handle.db, { itemId: item.id, stepId: "wait", initiationId: stay, startedAt });

    const { run } = await report(item);

    expect(run.step).toEqual({ id: "wait", name: "Wait" });
    expect(run.watch).toEqual({ startedAt, waitingMs: expect.any(Number), intervalMs: 30 * 60_000 });
    expect((run.watch as { waitingMs: number }).waitingMs).toBeGreaterThanOrEqual(90_000);
  });
});

describe("ctx.workspace", () => {
  it("gives a git repository's base branch, commands and forge, and its worktree path is ctx.cwd", async () => {
    const workspace = attachWorkspace(handle.db, { keyPrefix: "PAY", name: "payments", repoPath: "/repos/payments", baseBranch: "develop", testCommand: "pnpm test", lintCommand: "pnpm lint" });
    updateWorkspace(handle.db, workspace.id, { config: { ...workspace.config, forgeKind: "github", forgeDraft: true, forgeOpenPr: true } });
    const item = createTestItem(handle.db, { type: "story", title: "On a repository", stepId: "todo", workspaceId: workspace.id });

    const reported = await report(item);

    expect(reported.workspace).toEqual({
      kind: "git-worktree",
      id: workspace.id,
      name: "payments",
      git: {
        repositoryName: "payments",
        mainCheckout: "/repos/payments",
        worktreePath: scratch,
        baseBranch: "develop",
        testCommand: "pnpm test",
        lintCommand: "pnpm lint",
        buildCommand: null,
        forge: { kind: "github", remote: "origin", draft: true, opensPullRequests: true },
      },
    });
    expect(reported.workspace.git!.worktreePath).toBe(reported.cwd);
  });

  it("works the forge out from the remote where the repository does not name one", async () => {
    const workspace = attachWorkspace(handle.db, { keyPrefix: "PAY", name: "payments", repoPath: "/repos/payments" });
    const item = createTestItem(handle.db, { type: "story", title: "Unnamed forge", stepId: "todo", workspaceId: workspace.id });
    const asked: string[] = [];

    const reported = await report(item, {
      reader: {
        forgeKind: async (repoPath, remote) => {
          asked.push(`${repoPath} ${remote}`);
          return "gitlab";
        },
      },
    });

    expect(reported.workspace.git!.forge.kind).toBe("gitlab");
    expect(asked).toEqual(["/repos/payments origin"]);
  });
});

describe("ctx.project", () => {
  it("lists the project's workspaces, item types with their fields, and pipelines with their steps", async () => {
    const workspace = attachWorkspace(handle.db, { keyPrefix: "PAY", name: "payments", repoPath: "/repos/payments" });
    const projectId = workspace.projectId!;
    const item = createTestItem(handle.db, { type: "story", title: "On a project", stepId: "todo", workspaceId: workspace.id, projectId });

    const { project } = await report(item);

    expect(project).not.toBeNull();
    expect(project!.id).toBe(projectId);
    expect(project!.keyPrefix).toBe("PAY");
    expect(project!.workspaces).toEqual([{ kind: "git-worktree", id: workspace.id, name: "payments" }]);

    const types = listItemTypes(handle.db, projectId);
    expect(types.length).toBeGreaterThan(0);
    expect(project!.itemTypes.map((type) => type.slug)).toEqual(types.map((type) => type.slug));
    const story = project!.itemTypes.find((type) => type.slug === "story")!;
    expect(story.fields).toContainEqual({ name: "acceptance_criteria", kind: expect.any(String), required: expect.any(Boolean) });

    const pipelines = listPipelines(handle.db, projectId);
    expect(project!.pipelines).toEqual(
      pipelines.map((pipeline) => ({
        id: pipeline.id,
        name: pipeline.name,
        steps: listStepsForPipeline(handle.db, pipeline.id).map((step) => ({ id: step.id, name: step.name, kind: step.type })),
      })),
    );
    expect(project!.pipelines.find((pipeline) => pipeline.id === item.pipelineId)!.steps).toContainEqual({ id: "review", name: "Review", kind: expect.any(String) });
  });
});

describe("what the three values never hold", () => {
  it("contains no secret, no environment variable's value and no forge token", async () => {
    const workspace = attachWorkspace(handle.db, { keyPrefix: "PAY", name: "payments", repoPath: "/repos/payments", testCommand: "pnpm test" });
    const item = createTestItem(handle.db, { type: "story", title: "Holds nothing secret", stepId: "todo", workspaceId: workspace.id, projectId: workspace.projectId! });
    storeSecret(secrets, "GITHUB_TOKEN", "ghp-secret-value-711");
    storeVariable(secrets, "DEPLOY_REGION", "variable-value-711");
    process.env["EO_711_PROBE"] = "process-env-value-711";
    try {
      const reported = await report(item, { env: ["GITHUB_TOKEN", "DEPLOY_REGION"] });
      const text = JSON.stringify({ run: reported.run, workspace: reported.workspace, project: reported.project });
      expect(reported.project).not.toBeNull();
      expect(text).not.toContain("ghp-secret-value-711");
      expect(text).not.toContain("variable-value-711");
      expect(text).not.toContain("process-env-value-711");
      // And it is a real answer, not an empty one.
      expect(reported.workspace.git!.testCommand).toBe("pnpm test");
    } finally {
      delete process.env["EO_711_PROBE"];
    }
  });
});
