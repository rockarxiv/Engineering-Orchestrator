import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_WORKSPACE, type IpcPayload, type Job, type Uuid, type WatchFinding } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { eq } from "drizzle-orm";
import {
  addWorkspaceToProject,
  createGitWorkspace,
  createProject,
  getItem,
  getPipeline,
  heldEventCount,
  listCommentsForItem,
  listJobEvents,
  listOccurrences,
  listRunsForItem,
  removeWorkspaceFromProject,
  saveModule,
  setEntryStep,
  setJobPaused,
  updateStep,
  type GitWorkspace,
} from "../db/repos/index.js";
import { jobs as jobRows } from "../db/schema.js";
import { attachWorkspace, messagesAboutJob, messagesFrom, openMigratedTestDb } from "../db/testHelpers.js";
import { createEngine } from "../engine.js";
import { createJobCommand, getJobCommand, listJobsCommand, runJobNowCommand, updateJobCommand } from "../ipc/jobCommands.js";
import type { ModuleOutcome } from "../modules/runModule.js";
import { createFakeProvider } from "../providers/fake.js";
import { happyPathFixture } from "../providers/fixtures.js";
import { run } from "../testing/git.js";
import { removeScratch } from "../testing/scratch.js";
import { fireJob, jobEntryVerdicts } from "./fire.js";
import { createJob } from "./jobs.js";
import { JOB_MESSAGE_SOURCE } from "./ownerMessage.js";
import { runJobTick } from "./scheduler.js";
import { runWatchTick, type WatchCheck } from "./watch.js";
import { receiveWebhook, releaseHeldWebhookEvents } from "./webhook.js";
import { mintWebhookSecret, signWebhook } from "./webhookSignature.js";

/**
 * What a job files on a project with one repository carries that
 * repository (EO-855), as an item from the board, an assistant's proposal
 * or `ctx.createItem` does — so a pipeline whose entry step cuts a branch
 * has one to cut. With several, the job names one (EO-856, below).
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

function watchJob(workspaceId: Uuid | null = null): Job {
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
    workspaceId,
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

describe("a job on a project with no repository", () => {
  it("files with no repository", () => {
    const bare = createProject(handle.db, { name: "Notes", keyPrefix: "NOTE" });

    const fired = fireJob(handle.db, manualJob(bare.id as Uuid));

    expect(fired.item?.workspaceId ?? null).toBeNull();
  });
});

/**
 * A finding that names its repository is filed on it (EO-857): by the
 * name `repositories_list` gives it, or by the forge path of its remote,
 * either without regard to case. Anything matching none, or several, is
 * refused rather than guessed at, and the rest of the check is filed.
 */
describe("a watch finding that names its repository", () => {
  const ENGINEERING = "git@github.com:rockarxiv/Engineering-Orchestrator.git";
  const at = (hour: number): number => Date.UTC(2026, 10, 19, hour, 0);

  /** A repository on the project, a real checkout whose `origin` is `remote`. */
  async function addRepository(name: string, remote: string | null): Promise<GitWorkspace> {
    const repoPath = join(scratch, name.replace(/\//g, "-"));
    mkdirSync(repoPath, { recursive: true });
    await run(["init", "-b", "main"], repoPath);
    if (remote !== null) await run(["remote", "add", "origin", remote], repoPath);
    const workspace = createGitWorkspace(handle.db, { config: { name, repoPath } });
    addWorkspaceToProject(handle.db, projectId, workspace.id as Uuid);
    return workspace;
  }

  const reporting =
    (...findings: WatchFinding[]): WatchCheck =>
    async () => ({ ok: true, result: "waiting", detail: "", findings });

  beforeEach(() => {
    // The engine installs the workspace kinds, and the git kind is what
    // reads a repository's forge path; the job code never imports it.
    createEngine({ db: handle.db, eoMcpServerPath: "/unused", worktreeRoot: join(scratch, "work trees"), provider: createFakeProvider(happyPathFixture) });
  });

  it("files on the repository it names, without regard to case, rather than the job's", async () => {
    const web = await addRepository("Web", null);
    watchJob(repository.id as Uuid);

    const { filed } = await runWatchTick(handle.db, { check: reporting({ key: "k1", title: "Bump zod", repository: "wEB" }), now: () => at(9) });

    expect(filed).toHaveLength(1);
    expect(getItem(handle.db, filed[0] as Uuid)?.workspaceId).toBe(web.id);
  });

  it("files on the repository whose forge remote has the path it names", async () => {
    const engineering = await addRepository("eo", ENGINEERING);
    watchJob(repository.id as Uuid);

    const { filed } = await runWatchTick(handle.db, {
      check: reporting({ key: "k1", title: "Bump zod", repository: "rockarxiv/Engineering-Orchestrator" }, { key: "k2", title: "Bump vite", repository: "ROCKARXIV/engineering-orchestrator" }),
      now: () => at(9),
    });

    expect(filed).toHaveLength(2);
    expect(filed.map((id) => getItem(handle.db, id as Uuid)?.workspaceId)).toEqual([engineering.id, engineering.id]);
  });

  it("matches a GitLab subgroup's path", async () => {
    const gitlab = await addRepository("api", "https://gitlab.com/group/subgroup/api.git");
    watchJob(repository.id as Uuid);

    const { filed } = await runWatchTick(handle.db, { check: reporting({ key: "k1", title: "Bump zod", repository: "group/subgroup/api" }), now: () => at(9) });

    expect(getItem(handle.db, filed[0] as Uuid)?.workspaceId).toBe(gitlab.id);
  });

  it("refuses a finding naming no repository, messages the owner once naming them, and files the rest where the job files", async () => {
    await addRepository("eo", ENGINEERING);
    const job = watchJob(repository.id as Uuid);
    const check = reporting({ key: "lost", title: "Bump zod", repository: "rockarxiv/elsewhere" }, { key: "kept", title: "Bump vite" });

    const first = await runWatchTick(handle.db, { check, now: () => at(9) });
    const again = await runWatchTick(handle.db, { check, now: () => at(11) });

    expect(first.filed).toHaveLength(1);
    // Filed where the job files: the repository it names (EO-856).
    expect(getItem(handle.db, first.filed[0] as Uuid)?.workspaceId).toBe(repository.id);
    expect(again.filed).toEqual([]);
    const events = listJobEvents(handle.db, job.id as Uuid);
    expect(events.filter((event) => event.eventKey === "lost").map((event) => event.outcome)).toEqual(["refused"]);
    expect(events.filter((event) => event.eventKey === "kept").map((event) => event.outcome)).toEqual(["created"]);
    const messages = messagesAboutJob(handle.db, job.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain('"rockarxiv/elsewhere"');
    expect(messages[0]?.body).toContain('"the repo"');
    expect(messages[0]?.body).toContain('"eo" (rockarxiv/Engineering-Orchestrator)');
  });

  it("refuses a finding naming two repositories, and files the rest", async () => {
    await addRepository("eo", ENGINEERING);
    await addRepository("eo fork", ENGINEERING);
    const job = watchJob(repository.id as Uuid);

    const { filed } = await runWatchTick(handle.db, {
      check: reporting({ key: "both", title: "Bump zod", repository: "rockarxiv/Engineering-Orchestrator" }, { key: "named", title: "Bump vite", repository: "the repo" }),
      now: () => at(9),
    });

    expect(filed).toHaveLength(1);
    expect(getItem(handle.db, filed[0] as Uuid)?.workspaceId).toBe(repository.id);
    const refused = listJobEvents(handle.db, job.id as Uuid).filter((event) => event.eventKey === "both");
    expect(refused.map((event) => event.outcome)).toEqual(["refused"]);
    expect(refused[0]?.reason).toContain("matches 2 repositories");
    const messages = messagesAboutJob(handle.db, job.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain('"eo fork" (rockarxiv/Engineering-Orchestrator)');
  });

  it("refuses a finding whose repository leaves the project while its entry rules run, and files the rest", async () => {
    const engineering = await addRepository("eo", ENGINEERING);
    const job = watchJob(repository.id as Uuid);
    let detached = false;

    const { filed } = await runWatchTick(handle.db, {
      check: reporting({ key: "moved", title: "Bump zod", repository: "rockarxiv/Engineering-Orchestrator" }, { key: "stays", title: "Bump vite", repository: "the repo" }),
      now: () => at(9),
      // A person detaches the repository while the first finding's entry module runs.
      entryVerdicts: async (db, onJob, options) => {
        if (!detached) {
          detached = true;
          removeWorkspaceFromProject(db, projectId, engineering.id as Uuid);
        }
        return jobEntryVerdicts(db, onJob, options);
      },
    });

    expect(filed).toHaveLength(1);
    expect(getItem(handle.db, filed[0] as Uuid)?.workspaceId).toBe(repository.id);
    const events = listJobEvents(handle.db, job.id as Uuid);
    const refused = events.filter((event) => event.eventKey === "moved");
    expect(refused.map((event) => event.outcome)).toEqual(["refused"]);
    expect(refused[0]?.reason).toContain("left this project");
    expect(events.filter((event) => event.eventKey === "stays").map((event) => event.outcome)).toEqual(["created"]);
    const messages = messagesAboutJob(handle.db, job.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain('"rockarxiv/Engineering-Orchestrator"');
    expect(messages[0]?.body).toContain('This project\'s repositories are "the repo".');
  });

  it("files a finding naming its repository where the job names none and the project has gained a second, and refuses one naming none (EO-856)", async () => {
    const job = watchJob();
    const web = await addRepository("Web", null);

    const { filed } = await runWatchTick(handle.db, {
      check: reporting({ key: "named", title: "Bump zod", repository: "web" }, { key: "unnamed", title: "Bump vite" }),
      now: () => at(9),
    });

    expect(filed).toHaveLength(1);
    expect(getItem(handle.db, filed[0] as Uuid)?.workspaceId).toBe(web.id);
    const unnamed = listJobEvents(handle.db, job.id as Uuid).filter((event) => event.eventKey === "unnamed");
    expect(unnamed.map((event) => event.outcome)).toEqual(["refused"]);
    expect(unnamed[0]?.reason).toContain("this job names none");
  });

  it("files a finding with no repository on the project's only one, as before", async () => {
    watchJob();

    const { filed } = await runWatchTick(handle.db, { check: reporting({ key: "k1", title: "Bump zod" }), now: () => at(9) });

    expect(getItem(handle.db, filed[0] as Uuid)?.workspaceId).toBe(repository.id);
  });
});

/**
 * A job that names its repository (EO-856): where every item it files
 * goes, refused at the save where it is not the project's or where the
 * project has several and the entry step cuts a branch of the item's own,
 * and refused again at the firing when either stops being true.
 */
describe("a job that names its repository", () => {
  let other: GitWorkspace;
  const JOBS = { facts: async () => ({ authKind: () => "api_key" as const }) };

  /** A second repository on the project, so a job has to say which. */
  function addSecondRepository(): void {
    other = createGitWorkspace(handle.db, { config: { name: "the other repo", repoPath: join(scratch, "other") } });
    addWorkspaceToProject(handle.db, projectId, other.id as Uuid);
  }

  /** Delivery's Worktree as the entry, cutting a branch of the item's own repository. */
  function entryCutsABranch(): void {
    setEntryStep(handle.db, getPipeline(handle.db, "default")!.id, "worktree");
    updateStep(handle.db, "worktree", { workspaceMode: "isolated" });
  }

  const create = (overrides: Partial<IpcPayload<"jobs:create">> = {}) =>
    createJobCommand(handle.db, JOBS, { projectId, name: "Weekly sweep", trigger: { kind: "manual" }, pipelineId: "default", template: TEMPLATE, ...overrides });

  describe("when it is saved", () => {
    it("refuses a repository that is not one of the project's, naming the ones it has", async () => {
      const elsewhere = createGitWorkspace(handle.db, { config: { name: "somebody else's", repoPath: join(scratch, "elsewhere") } });

      const answer = await create({ workspaceId: elsewhere.id });

      expect(answer.job).toBeNull();
      expect(answer.problem).toContain(`"somebody else's" is not one of this job's project's repositories.`);
      expect(answer.problem).toContain(`'s repositories are "the repo".`);
    });

    it("refuses one that no longer exists", async () => {
      const answer = await create({ workspaceId: "0190aaaa-0000-7000-8000-000000000000" });

      expect(answer.job).toBeNull();
      expect(answer.problem).toContain("The repository this job names no longer exists.");
    });

    it("keeps the repository it names, and jobs_list and job_get report it", async () => {
      addSecondRepository();

      const answer = await create({ workspaceId: other.id });

      expect(answer.problem).toBeNull();
      expect(answer.job?.workspaceId).toBe(other.id);
      expect(answer.job?.workspaceName).toBe("the other repo");
      expect(listJobsCommand(handle.db, { projectId }).jobs.find((job) => job.id === answer.job!.id)?.workspaceName).toBe("the other repo");
      expect(getJobCommand(handle.db, { jobId: answer.job!.id }).job?.workspaceId).toBe(other.id);
    });

    it("refuses none where the project has several and the entry step cuts a branch of the item's own, naming them", async () => {
      addSecondRepository();
      entryCutsABranch();

      const answer = await create();

      expect(answer.job).toBeNull();
      expect(answer.problem).toContain("starts new work on a branch of the item's own repository, and this job names none.");
      expect(answer.problem).toContain(`'s repositories are "the repo", "the other repo".`);
    });

    it("saves none where the entry step picks a repository of its own", async () => {
      addSecondRepository();
      entryCutsABranch();
      updateStep(handle.db, "worktree", { workspaceId: other.id });

      const answer = await create();

      expect(answer.problem).toBeNull();
      expect(answer.job?.workspaceId).toBeNull();
    });

    it("saves none where the entry step works on no workspace", async () => {
      addSecondRepository();
      entryCutsABranch();
      updateStep(handle.db, "worktree", { workspaceId: NO_WORKSPACE });

      const answer = await create();

      expect(answer.problem).toBeNull();
    });

    it("lets jobs:update set, change and clear it, and refuses what jobs:create refuses", async () => {
      const job = (await create()).job!;
      const elsewhere = createGitWorkspace(handle.db, { config: { name: "somebody else's", repoPath: join(scratch, "elsewhere") } });

      const foreign = await updateJobCommand(handle.db, JOBS, { jobId: job.id, workspaceId: elsewhere.id });
      expect(foreign.job).toBeNull();
      expect(foreign.problem).toContain(`"the repo"`);

      const set = await updateJobCommand(handle.db, JOBS, { jobId: job.id, workspaceId: repository.id });
      expect(set.job?.workspaceId).toBe(repository.id);

      addSecondRepository();
      const changed = await updateJobCommand(handle.db, JOBS, { jobId: job.id, workspaceId: other.id });
      expect(changed.job?.workspaceId).toBe(other.id);

      entryCutsABranch();
      const cleared = await updateJobCommand(handle.db, JOBS, { jobId: job.id, workspaceId: null });
      expect(cleared.job).toBeNull();
      expect(cleared.problem).toContain(`"the repo", "the other repo"`);

      // A rename leaves it as it is.
      const renamed = await updateJobCommand(handle.db, JOBS, { jobId: job.id, name: "Monthly sweep" });
      expect(renamed.job?.workspaceId).toBe(other.id);

      updateStep(handle.db, "worktree", { workspaceId: NO_WORKSPACE });
      const clearedNow = await updateJobCommand(handle.db, JOBS, { jobId: job.id, workspaceId: null });
      expect(clearedNow.problem).toBeNull();
      expect(clearedNow.job?.workspaceId).toBeNull();
    });
  });

  describe("when it fires", () => {
    beforeEach(() => {
      addSecondRepository();
      entryCutsABranch();
    });

    it("files Run now's item there", async () => {
      const job = (await create({ workspaceId: other.id })).job!;

      const answer = runJobNowCommand(handle.db, undefined, { jobId: job.id });

      expect(answer.problem ?? null).toBeNull();
      expect(getItem(handle.db, answer.itemId as Uuid)?.workspaceId).toBe(other.id);
    });

    it("files a scheduled occurrence's item there", async () => {
      const due = Date.UTC(2026, 10, 19, 8, 0);
      const job = (
        await create({ trigger: { kind: "schedule", schedule: { kind: "daily", hour: 8, minute: 0 }, timeZone: "UTC", catchUpWithinMinutes: 180 }, workspaceId: other.id })
      ).job!;
      handle.db.update(jobRows).set({ createdAt: due - 60_000 }).where(eq(jobRows.id, job.id)).run();

      runJobTick(handle.db, { now: due });

      const occurrence = listOccurrences(handle.db, job.id as Uuid).find((row) => row.status === "fired");
      expect(getItem(handle.db, occurrence?.itemId as Uuid)?.workspaceId).toBe(other.id);
    });

    it("files what a watch finding files there", async () => {
      watchJob(other.id as Uuid);

      const { filed } = await runWatchTick(handle.db, { check: finds, now: () => Date.UTC(2026, 10, 19, 9, 0) });

      expect(filed).toHaveLength(1);
      expect(getItem(handle.db, filed[0] as Uuid)?.workspaceId).toBe(other.id);
    });

    it("files nothing once the repository it names has left the project: a failed occurrence, and the owner told", async () => {
      const job = (await create({ workspaceId: other.id })).job!;
      removeWorkspaceFromProject(handle.db, projectId, other.id as Uuid);

      const answer = runJobNowCommand(handle.db, undefined, { jobId: job.id });

      expect(answer.fired).toBe(false);
      expect(answer.itemId).toBeNull();
      const [occurrence] = listOccurrences(handle.db, job.id as Uuid);
      expect(occurrence?.status).toBe("failed");
      expect(occurrence?.reason).toContain(`"the other repo" is not one of this job's project's repositories.`);
      expect(occurrence?.reason).toContain(`'s repositories are "the repo".`);
      expect(messagesFrom(handle.db, JOB_MESSAGE_SOURCE.failed).map((message) => message.body)).toEqual([
        expect.stringContaining(`"Weekly sweep" could not run. "the other repo" is not one of`),
      ]);
    });

    it("refuses a watch finding once the repository has left the project, telling the owner once", async () => {
      const job = watchJob(other.id as Uuid);
      removeWorkspaceFromProject(handle.db, projectId, other.id as Uuid);

      await runWatchTick(handle.db, { check: finds, now: () => Date.UTC(2026, 10, 19, 9, 0) });
      await runWatchTick(handle.db, { check: finds, now: () => Date.UTC(2026, 10, 19, 11, 0) });

      const events = listJobEvents(handle.db, job.id as Uuid);
      // Refused again for the same reason, it writes nothing, as any refused finding does.
      expect(events.map((event) => event.outcome)).toEqual(["refused"]);
      expect(events[0]?.reason).toContain(`"the other repo" is not one of this job's project's repositories.`);
      expect(messagesFrom(handle.db, JOB_MESSAGE_SOURCE.watch)).toHaveLength(1);
    });
  });

  describe("a webhook event", () => {
    const SECRET = mintWebhookSecret();
    const AT = Date.UTC(2026, 10, 19, 9, 0);

    function webhookJob(workspaceId: Uuid | null): Job {
      const created = createJob(handle.db, {
        projectId,
        name: "Deploys",
        trigger: { kind: "webhook", path: "deploys", secret: SECRET, mapping: { title: null, body: null, eventKey: null, spec: {} } },
        pipelineId: "default",
        template: TEMPLATE,
        workspaceId,
      });
      if (!created.ok) throw new Error(created.problem);
      return created.job;
    }

    const deliver = (body: string, now = AT) =>
      receiveWebhook(handle.db, { path: "deploys", rawBody: body, signature: signWebhook(SECRET, now, body), timestamp: String(now), now });

    it("is filed on the repository the job names", async () => {
      addSecondRepository();
      webhookJob(other.id as Uuid);

      const answer = await deliver('{"id":"evt-1"}');

      expect(answer.outcome).toBe("created");
      expect(getItem(handle.db, answer.itemId as Uuid)?.workspaceId).toBe(other.id);
    });

    it("files nothing once the repository it names has left the project: a failed occurrence, a refused event, and the owner told", async () => {
      addSecondRepository();
      const job = webhookJob(other.id as Uuid);
      removeWorkspaceFromProject(handle.db, projectId, other.id as Uuid);

      const answer = await deliver('{"id":"evt-1"}');

      expect(answer).toMatchObject({ status: 422, outcome: "refused", itemId: null });
      expect(answer.event?.reason).toContain(`"the other repo" is not one of this job's project's repositories.`);
      const [occurrence] = listOccurrences(handle.db, job.id as Uuid);
      expect(occurrence?.status).toBe("failed");
      expect(occurrence?.reason).toContain(`"the other repo" is not one of this job's project's repositories.`);
      expect(listJobEvents(handle.db, job.id as Uuid).map((event) => event.outcome)).toEqual(["refused"]);
      expect(messagesFrom(handle.db, JOB_MESSAGE_SOURCE.failed).map((message) => message.body)).toEqual([
        expect.stringContaining(`"Deploys" could not run. "the other repo" is not one of`),
      ]);
    });

    it("files nothing where the project has gained a second repository and the job names none", async () => {
      const job = webhookJob(null);
      addSecondRepository();
      entryCutsABranch();

      const answer = await deliver('{"id":"evt-1"}');

      expect(answer).toMatchObject({ status: 422, outcome: "refused", itemId: null });
      expect(listOccurrences(handle.db, job.id as Uuid)[0]).toMatchObject({ status: "failed" });
      expect(listOccurrences(handle.db, job.id as Uuid)[0]?.reason).toContain("this job names none");
      expect(messagesFrom(handle.db, JOB_MESSAGE_SOURCE.failed)).toHaveLength(1);
    });

    it("refuses held events once the repository is wrong: a failed occurrence and a refused event each, and the owner told once", async () => {
      addSecondRepository();
      const job = webhookJob(other.id as Uuid);
      setJobPaused(handle.db, job.id as Uuid, AT, "by hand");
      await deliver('{"id":"evt-1"}', AT + 1);
      await deliver('{"id":"evt-2"}', AT + 2);
      removeWorkspaceFromProject(handle.db, projectId, other.id as Uuid);
      setJobPaused(handle.db, job.id as Uuid, null);

      await releaseHeldWebhookEvents(handle.db, { now: AT + 3 });

      expect(heldEventCount(handle.db, job.id as Uuid)).toBe(0);
      const occurrences = listOccurrences(handle.db, job.id as Uuid);
      expect(occurrences.map((occurrence) => occurrence.status)).toEqual(["failed", "failed"]);
      expect(occurrences[0]?.reason).toContain(`"the other repo" is not one of this job's project's repositories.`);
      const refused = listJobEvents(handle.db, job.id as Uuid).filter((event) => event.outcome === "refused");
      expect(refused).toHaveLength(2);
      expect(refused[0]?.reason).toContain(`"the other repo" is not one of this job's project's repositories.`);
      expect(messagesFrom(handle.db, JOB_MESSAGE_SOURCE.failed).map((message) => message.body)).toEqual([
        expect.stringContaining(`"Deploys" could not run. "the other repo" is not one of`),
      ]);
    });
  });

  it("files nothing where the project has gained a second repository since a job naming none was saved", () => {
    const job = manualJob();
    addSecondRepository();
    entryCutsABranch();

    const fired = fireJob(handle.db, job);

    expect(fired.item).toBeNull();
    expect(fired.occurrence?.status).toBe("failed");
    expect(fired.problem).toContain("this job names none");
    expect(messagesFrom(handle.db, JOB_MESSAGE_SOURCE.failed)).toHaveLength(1);
  });
});
