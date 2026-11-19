import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job, Uuid, WatchFinding } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { eq } from "drizzle-orm";
import {
  addWorkspaceToProject,
  createGitWorkspace,
  createProject,
  getItem,
  getPipeline,
  listCommentsForItem,
  listOccurrences,
  listRunsForItem,
  saveModule,
  setEntryStep,
  updateStep,
  type GitWorkspace,
} from "../db/repos/index.js";
import { jobs as jobRows } from "../db/schema.js";
import { attachWorkspace, openMigratedTestDb } from "../db/testHelpers.js";
import { createEngine } from "../engine.js";
import { runJobNowCommand } from "../ipc/jobCommands.js";
import type { ModuleOutcome } from "../modules/runModule.js";
import { createFakeProvider } from "../providers/fake.js";
import { happyPathFixture } from "../providers/fixtures.js";
import { run } from "../testing/git.js";
import { removeScratch } from "../testing/scratch.js";
import { fireJob } from "./fire.js";
import { createJob } from "./jobs.js";
import { runJobTick } from "./scheduler.js";
import { runWatchTick, type WatchCheck } from "./watch.js";

/**
 * What a job files on a project with one repository carries that
 * repository (EO-855), as an item from the board, an assistant's proposal
 * or `ctx.createItem` does — so a pipeline whose entry step cuts a branch
 * has one to cut. With several, the job has no way to name one, and the
 * item is filed with none, as it always was.
 */

let scratch: string;
let handle: DbHandle;
let repository: GitWorkspace;
let projectId: Uuid;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo job repo test "));
  const repoPath = join(scratch, "the repo");
  mkdirSync(repoPath, { recursive: true });
  await run(["init", "-b", "main"], repoPath);
  await run(["config", "user.email", "eo@example.com"], repoPath);
  await run(["config", "user.name", "EO Test"], repoPath);
  await run(["config", "commit.gpgsign", "false"], repoPath);
  writeFileSync(join(repoPath, "README.md"), "# fixture\n");
  await run(["add", "."], repoPath);
  await run(["commit", "-m", "initial"], repoPath);

  handle = openMigratedTestDb();
  repository = attachWorkspace(handle.db, { name: "the repo", keyPrefix: "EO", repoPath, baseBranch: "main" });
  projectId = repository.projectId as Uuid;
});

afterEach(() => {
  handle.close();
  removeScratch(scratch);
});

const TEMPLATE = { type: "developer:story", title: "{{job}} for {{date}}", body: "Filed by {{job}}." };

function manualJob(onProject: Uuid | null = projectId): Job {
  const created = createJob(handle.db, { projectId: onProject, name: "Weekly sweep", trigger: { kind: "manual" }, pipelineId: "default", template: TEMPLATE });
  if (!created.ok) throw new Error(created.problem);
  return created.job;
}

function watchJob(): Job {
  const saved = saveModule(handle.db, {
    slug: "dependabot-watch",
    name: "Dependabot watch",
    description: "Finds Dependabot pull requests.",
    code: 'export default async function run() { return { ok: true, result: "waiting" }; }',
    manifest: {
      name: "Dependabot watch",
      description: "Finds Dependabot pull requests.",
      inputs: {},
      needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
      results: [],
      watch: true,
    },
    approve: true,
  });
  if (!saved.ok) throw new Error(saved.reason);
  const created = createJob(handle.db, {
    projectId,
    name: "Dependabot",
    trigger: { kind: "watch", moduleId: saved.module.id, inputs: {}, everyMinutes: 60, waitWhileOpen: false },
    pipelineId: "default",
    template: TEMPLATE,
  });
  if (!created.ok) throw new Error(created.problem);
  return created.job;
}

const FINDING: WatchFinding = { key: "dependabot:eo/eo#1", title: "Bump zod", body: "Found by the watch." };
const finds: WatchCheck = async (): Promise<ModuleOutcome> => ({ ok: true, result: "waiting", detail: "", findings: [FINDING] });

describe("a job on a project with one repository", () => {
  it("gives what Run now files that repository", () => {
    const job = manualJob();

    const answer = runJobNowCommand(handle.db, undefined, { jobId: job.id });

    expect(answer.problem ?? null).toBeNull();
    expect(getItem(handle.db, answer.itemId as Uuid)?.workspaceId).toBe(repository.id);
  });

  it("gives a scheduled occurrence's item that repository", () => {
    const due = Date.UTC(2026, 10, 19, 8, 0);
    const created = createJob(handle.db, {
      projectId,
      name: "Morning sweep",
      trigger: { kind: "schedule", schedule: { kind: "daily", hour: 8, minute: 0 }, timeZone: "UTC", catchUpWithinMinutes: 180 },
      pipelineId: "default",
      template: TEMPLATE,
    });
    if (!created.ok) throw new Error(created.problem);
    // Made before the occurrence it is due, so the tick has one to fire.
    handle.db.update(jobRows).set({ createdAt: due - 60_000 }).where(eq(jobRows.id, created.job.id)).run();

    const tick = runJobTick(handle.db, { now: due });

    expect(tick.fired).toEqual([created.job.id]);
    const occurrence = listOccurrences(handle.db, created.job.id as Uuid).find((row) => row.status === "fired");
    expect(getItem(handle.db, occurrence?.itemId as Uuid)?.workspaceId).toBe(repository.id);
  });

  it("gives what a watch finding files that repository", async () => {
    watchJob();

    const result = await runWatchTick(handle.db, { check: finds, now: () => Date.UTC(2026, 10, 19, 9, 0) });

    expect(result.filed).toHaveLength(1);
    expect(getItem(handle.db, result.filed[0] as Uuid)?.workspaceId).toBe(repository.id);
  });

  it("files a watch finding that a create_worktree entry step in isolated mode prepares a branch for, rather than refusing it", async () => {
    // Delivery as seeded: its entry is the Worktree step, a builtin
    // `create_worktree` — made explicit, so the test says what it is about.
    const delivery = getPipeline(handle.db, "default")!;
    setEntryStep(handle.db, delivery.id, "worktree");
    updateStep(handle.db, "worktree", { workspaceMode: "isolated" });
    watchJob();
    const { filed } = await runWatchTick(handle.db, { check: finds, now: () => Date.UTC(2026, 10, 19, 9, 0) });
    const itemId = filed[0] as Uuid;
    expect(getItem(handle.db, itemId)?.stepId).toBe("worktree");

    const engine = createEngine({ db: handle.db, eoMcpServerPath: "/unused", worktreeRoot: join(scratch, "work trees"), provider: createFakeProvider(happyPathFixture) });
    await engine.runOnce();

    const said = listCommentsForItem(handle.db, itemId).map((comment) => comment.body);
    expect(said.filter((body) => body.includes("no repository assigned"))).toEqual([]);
    expect(listRunsForItem(handle.db, itemId).map((run) => [run.action, run.status])).toEqual([["create_worktree", "succeeded"]]);
    expect(getItem(handle.db, itemId)?.stepId).not.toBe("worktree");
  });
});

describe("a job on a project with no repository, or several", () => {
  it("files with no repository where the project has several, as it always has", async () => {
    const second = createGitWorkspace(handle.db, { config: { name: "the other repo", repoPath: join(scratch, "other") } });
    addWorkspaceToProject(handle.db, projectId, second.id as Uuid);

    const manual = fireJob(handle.db, manualJob());
    watchJob();
    const { filed } = await runWatchTick(handle.db, { check: finds, now: () => Date.UTC(2026, 10, 19, 9, 0) });

    expect(manual.problem).toBeNull();
    expect(manual.item?.workspaceId).toBeNull();
    expect(filed).toHaveLength(1);
    expect(getItem(handle.db, filed[0] as Uuid)?.workspaceId).toBeNull();
  });

  it("files with no repository where the project has none", () => {
    const bare = createProject(handle.db, { name: "Notes", keyPrefix: "NOTE" });

    const fired = fireJob(handle.db, manualJob(bare.id as Uuid));

    expect(fired.item?.workspaceId ?? null).toBeNull();
  });
});
