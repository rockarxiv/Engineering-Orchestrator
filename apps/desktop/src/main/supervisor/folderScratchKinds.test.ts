import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOLDER_KIND, gitStateOf, SCRATCH_KIND, type Item, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createRoute, createRun, createStep, createWorkspace, getItem, listAttachmentsForItem, listCommentsForItem, listRunsForItem, updateRun, type Workspace } from "../db/repos/index.js";
import { AttachmentStorage } from "../attachments/storage.js";
import { createDefaultProject } from "../db/repos/projectsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { folderWorkspaceKind } from "./folderKind.js";
import type { BuiltinRunner } from "./builtins.js";
import { createRunSupervisor, type ArtifactStore } from "./runSupervisor.js";
import { scratchWorkspaceKind } from "./scratchKind.js";
import { ANY_ACTION, describesChecks, verifier, verifies, verifyRun, type PreparedWorkspace, type VerifiableRun, type WorkspaceKind } from "./workspaceKind.js";

/**
 * The two kinds with a disk that belong to nobody's domain (EO-299,
 * ARCHITECTURE.md, "The four kinds").
 *
 * A marketing manager's report is drafted from a folder of CSVs or in a
 * scratch directory, and neither is a developer's idea of anything —
 * which is why both are in the core beside `none` rather than in the
 * developer pack, and why this file is here rather than under
 * `packs/developer`.
 *
 * What each of them is, is mostly what it *refuses* to be. A folder is
 * shared and full of other people's work, so "the file is there" is not
 * evidence that this run put it there; a scratch directory is EO's own
 * and empty, so everything in it is this run's output and the directory
 * itself is nobody's business afterwards. Most of what follows is one of
 * those two sentences, tested.
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let handle: DbHandle;
/** The shared drive, and where the per-run directories go. Never the person's `~/.eo`. */
let drive: string;
let scratchRoot: string;

beforeEach(() => {
  handle = openMigratedTestDb();
  drive = mkdtempSync(join(tmpdir(), "eo-drive-"));
  scratchRoot = mkdtempSync(join(tmpdir(), "eo-scratch-"));
});

afterEach(() => {
  handle.close();
  rmSync(drive, { recursive: true, force: true });
  rmSync(scratchRoot, { recursive: true, force: true });
});

/** A folder workspace on the drive, with a project of its own the way every door into EO attaches one. */
function folderWorkspace(options: { path?: string; perItemSubfolder?: boolean } = {}): Workspace {
  const workspace = createWorkspace(handle.db, {
    kind: FOLDER_KIND,
    config: { path: options.path ?? drive, ...(options.perItemSubfolder === undefined ? {} : { perItemSubfolder: options.perItemSubfolder }) },
  });
  createDefaultProject(handle.db, workspace, "EO");
  return workspace;
}

function scratchWorkspace(): Workspace {
  const workspace = createWorkspace(handle.db, { kind: SCRATCH_KIND });
  createDefaultProject(handle.db, workspace, "EO");
  return workspace;
}

function itemOn(workspace: Workspace, options: { title?: string; stepId?: string } = {}): Item {
  return createTestItem(handle.db, {
    type: "story",
    title: options.title ?? "Draft the quarterly report",
    stepId: options.stepId ?? "todo",
    workspaceId: workspace.id,
    projectId: workspace.projectId,
  });
}

/** A module step that says what it produces: a list of relative paths on the step's inputs JSON. */
function moduleStepProducing(outputs: string, id = "draft"): string {
  createStep(handle.db, {
    id,
    pipelineId: "default" as Uuid,
    position: 15,
    name: "Draft the report",
    type: "module",
    entryAction: "write-report",
    inputs: { outputs },
  });
  return id;
}

/**
 * A run row for a kind to be asked about, started `startedAgo`
 * milliseconds ago.
 *
 * The row rather than a fixture object, because "changed since the run
 * started" is read off `runs.started_at` — the run being verified, not
 * the clock — and a test that handed the kind a made-up timestamp would
 * be testing a comparison rather than the thing the comparison is
 * about.
 */
function verifiableRun(item: Item, workspace: PreparedWorkspace, options: { action?: string; startedAgo?: number } = {}): VerifiableRun {
  const action = options.action ?? "write-report";
  const run = createRun(handle.db, { itemId: item.id, agentId: null, action, cwd: workspace.cwd });
  updateRun(handle.db, run.id, { status: "running", startedAt: Date.now() - (options.startedAgo ?? 0) });
  return { id: run.id, action, workspace, result: null, ended: "succeeded" };
}

/** A file on the drive, optionally dated before the run that is about to be verified. */
function fileOnTheDrive(relativePath: string, options: { agedMs?: number; under?: string } = {}): string {
  const path = join(options.under ?? drive, relativePath);
  mkdirSync(join(path, "..").toString(), { recursive: true });
  writeFileSync(path, "the report\n");
  if (options.agedMs !== undefined) {
    const when = (Date.now() - options.agedMs) / 1000;
    utimesSync(path, when, when);
  }
  return path;
}

async function prepared(kind: WorkspaceKind, item: Item, action = "write-report"): Promise<PreparedWorkspace> {
  const outcome = await kind.prepare(item, action);
  if (!outcome.ok) throw new Error(`prepare refused: ${outcome.reason}`);
  return outcome.workspace;
}

describe("the folder kind prepares the folder somebody already has", () => {
  it("hands back the folder itself when every item works in the same one", async () => {
    const workspace = folderWorkspace();
    const item = itemOn(workspace);

    const outcome = await folderWorkspaceKind({ db: handle.db }).prepare(item, "write-report");

    expect(outcome).toEqual({ ok: true, workspace: { cwd: drive, kind: FOLDER_KIND, workspaceId: workspace.id } });
  });

  it("gives each item a drawer of its own when the workspace asks for one, and makes it", async () => {
    const workspace = folderWorkspace({ perItemSubfolder: true });
    const item = itemOn(workspace);

    const cwd = (await prepared(folderWorkspaceKind({ db: handle.db }), item)).cwd;

    expect(cwd).toBe(join(drive, item.key));
    expect(existsSync(cwd)).toBe(true);
  });

  it("refuses, rather than creating anything, when the drive is not there this morning", async () => {
    // Checked again at preparation and not only at creation: a mounted
    // drive is a fact about this morning. The refusal escalates before
    // the agent starts, which is what preparing ahead of the run row is
    // for.
    const gone = join(drive, "unmounted");
    mkdirSync(gone);
    const workspace = folderWorkspace({ path: gone });
    rmSync(gone, { recursive: true, force: true });
    const item = itemOn(workspace);

    const outcome = await folderWorkspaceKind({ db: handle.db }).prepare(item, "write-report");

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain(gone);
    expect(existsSync(gone)).toBe(false);
  });
});

describe("the folder kind checks what the step says it produces", () => {
  /** The acceptance criterion, both ways round: a module step that declares `report.docx`. */
  async function verifyAfter(write: (cwd: string) => void, options: { declared?: string; startedAgo?: number } = {}) {
    const workspace = folderWorkspace();
    const stepId = moduleStepProducing(options.declared ?? "report.docx");
    const item = itemOn(workspace, { stepId });
    const kind = folderWorkspaceKind({ db: handle.db });
    const place = await prepared(kind, item);
    const run = verifiableRun(item, place, { startedAgo: options.startedAgo ?? 0 });
    write(place.cwd);
    return verifyRun(kind, item, run);
  }

  it("passes with one check when the module wrote the file it declared", async () => {
    const checks = await verifyAfter((cwd) => writeFileSync(join(cwd, "report.docx"), "the report"));

    expect(checks).toHaveLength(1);
    expect(checks[0]?.passed).toBe(true);
    expect(checks[0]?.describes).toContain("report.docx");
  });

  it("fails with a sentence naming the path when it did not", async () => {
    const checks = await verifyAfter(() => {});

    expect(checks).toHaveLength(1);
    expect(checks[0]?.passed).toBe(false);
    expect(checks[0]?.blocks).toBe(true);
    expect(checks[0]?.describes).toContain("report.docx");
    expect(checks[0]?.describes).toContain(drive);
  });

  it("fails when the file is there but is last quarter's, which is the mistake a folder makes possible", async () => {
    // The reason existence alone is not the check. A shared drive is
    // rarely empty: `report.docx` is sitting right there from the last
    // time somebody ran this, and a run that did nothing at all would
    // pass a check that only asked whether the file was present.
    const checks = await verifyAfter(() => fileOnTheDrive("report.docx", { agedMs: 60 * 60 * 1000 }), { startedAgo: 60_000 });

    expect(checks[0]?.passed).toBe(false);
    expect(checks[0]?.describes).toContain("has not changed since this run started");
  });

  it("checks each declared path separately, whether they are listed on lines or with commas", async () => {
    const checks = await verifyAfter((cwd) => writeFileSync(join(cwd, "report.docx"), "the report"), { declared: "report.docx, figures/q3.png" });

    expect(checks.map((check) => check.passed)).toEqual([true, false]);
    expect(checks[1]?.describes).toContain("figures/q3.png");
  });

  it("refuses a declared path that points outside the folder rather than going and looking", async () => {
    // Configuration a person typed, and `../secrets.txt` exists, was
    // modified recently and would pass a check that only asked those two
    // questions. What the check is for is what *this run* produced.
    const checks = await verifyAfter(() => {}, { declared: "../elsewhere/report.docx" });

    expect(checks[0]?.passed).toBe(false);
    expect(checks[0]?.describes).toContain("outside");
  });

  /**
   * And the column head says the same thing, before any run (EO-312,
   * ARCHITECTURE.md, "What 'EO checks' means on a step").
   *
   * The words and the checks are one decision here, read off the same
   * step: a head that described a file this step never named would be
   * claiming a check that will not run, which is the overstatement
   * invariant 5 exists to prevent.
   */
  it("says what it would check on a step, in the step's own declared paths", () => {
    const kind = folderWorkspaceKind({ db: handle.db });

    expect(describesChecks(kind, { id: "draft", entryAction: "write-report", inputs: { outputs: "report.docx, figures/q3.png" } })).toEqual([
      "report.docx was produced",
      "figures/q3.png was produced",
    ]);
  });

  it("says nothing about a step that declares nothing, because nothing about it will be checked", () => {
    const kind = folderWorkspaceKind({ db: handle.db });

    // Empty is read everywhere as "not checked": the head says "Not
    // checked until Approve" and the editor offers no route for a failed
    // check, because no check will run for one to fail.
    expect(describesChecks(kind, { id: "draft", entryAction: "write-report", inputs: {} })).toEqual([]);
  });

  it("checks nothing when the step declares nothing, and says so by returning no checks", async () => {
    const workspace = folderWorkspace();
    const item = itemOn(workspace, { stepId: moduleStepProducing("") });
    const kind = folderWorkspaceKind({ db: handle.db });

    const checks = await verifyRun(kind, item, verifiableRun(item, await prepared(kind, item)));

    expect(checks).toEqual([]);
  });

  it("checks an agent's claim the same way it checks a module's, whatever the action was called", async () => {
    // The difference from the git kind, which can only judge
    // `implement`: "is the file there and did this run write it" is the
    // same observable question whoever ran and whatever the step was
    // called.
    const workspace = folderWorkspace();
    const item = itemOn(workspace, { stepId: moduleStepProducing("report.docx") });
    const kind = folderWorkspaceKind({ db: handle.db });
    const place = await prepared(kind, item);
    const run = verifiableRun(item, place, { action: "implement" });
    writeFileSync(join(place.cwd, "report.docx"), "the report");

    expect((await verifyRun(kind, item, run)).map((check) => check.passed)).toEqual([true]);
  });
});

describe("what a folder run produced", () => {
  it("is the files that changed while it worked, and not the rest of the drive", async () => {
    const workspace = folderWorkspace();
    const item = itemOn(workspace);
    const kind = folderWorkspaceKind({ db: handle.db });
    fileOnTheDrive("last-quarter.docx", { agedMs: 90 * 24 * 60 * 60 * 1000 });
    const place = await prepared(kind, item);
    const run = verifiableRun(item, place, { startedAgo: 5_000 });
    fileOnTheDrive("report.docx");
    fileOnTheDrive("figures/q3.csv");

    const artifacts = await kind.artifacts(item, run);

    expect(artifacts.map((artifact) => artifact.name)).toEqual(["figures/q3.csv", "report.docx"]);
    // Paths rather than bodies: a report is a `.docx`, and reading one
    // through a JavaScript string would corrupt the thing this kind
    // exists to deliver.
    expect(artifacts.every((artifact) => artifact.path !== undefined && existsSync(artifact.path))).toBe(true);
    expect(artifacts[1]?.mediaType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("leaves the folder alone when the item settles, because the folder is the deliverable", async () => {
    const workspace = folderWorkspace({ perItemSubfolder: true });
    const item = itemOn(workspace);
    const kind = folderWorkspaceKind({ db: handle.db });
    const place = await prepared(kind, item);
    writeFileSync(join(place.cwd, "report.docx"), "the report");

    await kind.release({ what: "settled", item, step: { id: "done", pipelineId: "default", position: 9, name: "Done" } as never });
    await kind.release({ what: "stale", hasActiveRun: () => false });

    expect(existsSync(join(place.cwd, "report.docx"))).toBe(true);
  });
});

describe("the scratch kind is a directory per run and nothing afterwards", () => {
  it("prepares a fresh empty directory every time, so no run inherits the last one's mess", async () => {
    const workspace = scratchWorkspace();
    const item = itemOn(workspace);
    const kind = scratchWorkspaceKind({ db: handle.db, root: scratchRoot });

    const first = await prepared(kind, item);
    writeFileSync(join(first.cwd, "draft.md"), "half a report");
    const second = await prepared(kind, item);

    expect(second.cwd).not.toBe(first.cwd);
    expect(readdirSync(second.cwd)).toEqual([]);
    expect(second.kind).toBe(SCRATCH_KIND);
  });

  it("has nothing to check, and says so by returning no checks rather than by passing one", async () => {
    const workspace = scratchWorkspace();
    const item = itemOn(workspace);
    const kind = scratchWorkspaceKind({ db: handle.db, root: scratchRoot });

    expect(await verifyRun(kind, item, verifiableRun(item, await prepared(kind, item)))).toEqual([]);
  });

  it("offers every file in the directory as the run's output, and the directory is gone once it is released", async () => {
    const workspace = scratchWorkspace();
    const item = itemOn(workspace);
    const kind = scratchWorkspaceKind({ db: handle.db, root: scratchRoot });
    const place = await prepared(kind, item);
    const run = verifiableRun(item, place);
    writeFileSync(join(place.cwd, "report.docx"), "the report");
    mkdirSync(join(place.cwd, "figures"));
    writeFileSync(join(place.cwd, "figures", "q3.csv"), "a,b\n1,2\n");

    const artifacts = await kind.artifacts(item, run);

    // Everything, rather than what changed: this directory was made
    // empty for this run, so there is no older work in it to tell apart.
    expect(artifacts.map((artifact) => artifact.name)).toEqual(["figures/q3.csv", "report.docx"]);
    // Still readable when `artifacts` returns, which is what whatever
    // posts them needs — the deletion is the release below, not this
    // call, or the paths would name files nobody can copy.
    expect(artifacts.every((artifact) => artifact.path !== undefined && existsSync(artifact.path))).toBe(true);

    updateRun(handle.db, run.id, { status: "succeeded", endedAt: Date.now() });
    await kind.release({ what: "stale", hasActiveRun: () => false });

    expect(existsSync(place.cwd)).toBe(false);
  });

  it("keeps the directory of a run a person can still reply into", async () => {
    // `listActiveRuns` is queued and running, and a run parked on a
    // question is neither — but the reply resumes it into the cwd its
    // row records, and a session resumed from a directory that has been
    // swept is not the same session (EO-177).
    const workspace = scratchWorkspace();
    const item = itemOn(workspace);
    const kind = scratchWorkspaceKind({ db: handle.db, root: scratchRoot });
    const place = await prepared(kind, item);
    const run = verifiableRun(item, place);
    updateRun(handle.db, run.id, { status: "awaiting_input" });

    await kind.release({ what: "stale", hasActiveRun: () => false });

    expect(existsSync(place.cwd)).toBe(true);
  });

  it("leaves alone a directory whose item this database has never heard of", async () => {
    // The root is one path under `~/.eo`, so a second installation — or
    // a test run beside a running app — sees the same listing. A sweep
    // that removed whatever it did not recognise would be one EO
    // deleting another EO's live work.
    mkdirSync(join(scratchRoot, "SOMEONE-1-ab12cd"), { recursive: true });
    const kind = scratchWorkspaceKind({ db: handle.db, root: scratchRoot });

    await kind.release({ what: "stale", hasActiveRun: () => false });

    expect(existsSync(join(scratchRoot, "SOMEONE-1-ab12cd"))).toBe(true);
  });

  it("takes a settled item's directories, and leaves another item's alone", async () => {
    const workspace = scratchWorkspace();
    const finished = itemOn(workspace, { title: "Finished" });
    const other = itemOn(workspace, { title: "Still going" });
    const kind = scratchWorkspaceKind({ db: handle.db, root: scratchRoot });
    const finishedPlace = await prepared(kind, finished);
    const otherPlace = await prepared(kind, other);

    await kind.release({ what: "settled", item: finished, step: { id: "done", pipelineId: "default", position: 9, name: "Done" } as never });

    expect(existsSync(finishedPlace.cwd)).toBe(false);
    expect(existsSync(otherPlace.cwd)).toBe(true);
  });
});

describe("which bucket a run on a disk of these kinds is in", () => {
  /**
   * **Concurrency is per shared filesystem** (ARCHITECTURE.md, "Capacity and concurrency"), and the
   * two kinds answer opposite ways for the same reason: two items on
   * one folder are two runs in one directory, and two scratch items are
   * two directories that did not exist a moment ago.
   *
   * Through the scheduler rather than by asking `capacityKeyOf`
   * directly, because a key nothing keys anything on would pass that
   * test and change nothing about what runs.
   */
  async function startedInOneTick(workspaceOf: () => Workspace): Promise<string[]> {
    const started: string[] = [];
    const inner = createFakeProvider({ result: validImplementResult });
    for (const title of ["One", "Two"]) itemOn(workspaceOf(), { title });

    await createRunSupervisor({
      db: handle.db,
      // One run per filesystem, two overall: what decides whether both
      // start is the answer to "which bucket are you in?".
      limits: { globalConcurrency: 2, perAgentConcurrency: 2, perRepositoryConcurrency: 1 },
      scratchRoot,
      provider: {
        start: (options) => {
          started.push(options.cwd);
          return inner.start(options);
        },
        resume: inner.resume.bind(inner),
      },
    }).runOnce();
    return started;
  }

  it("keeps two items on one folder workspace behind each other, because they share the drive", async () => {
    const workspace = folderWorkspace({ perItemSubfolder: true });

    const started = await startedInOneTick(() => workspace);

    expect(started).toHaveLength(1);
    expect(started[0]?.startsWith(drive)).toBe(true);
  });

  it("puts two scratch items in no bucket at all, because they share nothing", async () => {
    const workspace = scratchWorkspace();

    const started = await startedInOneTick(() => workspace);

    expect(started).toHaveLength(2);
    expect(new Set(started).size).toBe(2);
    expect(started.every((cwd) => cwd.startsWith(scratchRoot))).toBe(true);
  });

  it("runs an item on a folder workspace in the folder, with nothing git about it", async () => {
    // The whole of the story in one dispatch: no branch is cut, nothing
    // is recorded on the item, and the agent's cwd is the drive.
    const workspace = folderWorkspace({ perItemSubfolder: true });
    const item = itemOn(workspace);
    let dispatchedIn: string | undefined;
    const inner = createFakeProvider({ result: validImplementResult });

    await createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      provider: {
        start: (options) => {
          dispatchedIn = options.cwd;
          return inner.start(options);
        },
        resume: inner.resume.bind(inner),
      },
    }).runOnce();

    expect(dispatchedIn).toBe(join(drive, item.key));
    expect(gitStateOf(getItem(handle.db, item.id)!).branch).toBeNull();
  });
});
describe("a module run answers to the workspace it worked in", () => {
  /** A module step the item sits on, wired to route its one result onward. */
  function moduleStepOn(workspace: Workspace, outputs: string): Item {
    const stepId = moduleStepProducing(outputs, "draft");
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: stepId, resultKey: "drafted", label: "Drafted", target: "review" });
    return itemOn(workspace, { stepId });
  }

  /** A module that writes what it was told to write, through the workspace EO prepared for it. */
  function moduleWriting(files: readonly string[]): BuiltinRunner {
    return async (context) => {
      const prepared = await context.prepareWorkspace(context.item, "write-report");
      if (!prepared.ok) return { ok: false, reason: prepared.reason };
      for (const file of files) {
        mkdirSync(join(prepared.workspace.cwd, file, ".."), { recursive: true });
        writeFileSync(join(prepared.workspace.cwd, file), `${file} says so\n`);
      }
      return { ok: true, result: "drafted", detail: "" };
    };
  }

  function supervisorRunning(runner: BuiltinRunner, store?: ArtifactStore) {
    return createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      provider: { start: () => { throw new Error("a module must not reach a provider"); } } as never,
      moduleRunner: () => runner,
      scratchRoot,
      ...(store ? { artifactStore: store } : {}),
    });
  }

  it("passes with one check, and routes, when the module wrote the file the step declares", async () => {
    const item = moduleStepOn(folderWorkspace(), "report.docx");

    await supervisorRunning(moduleWriting(["report.docx"])).runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "escalation")).toEqual([]);
  });

  it("stops the module, with the sentence naming the path, when it did not", async () => {
    // The acceptance criterion's other half, and the half that was
    // missing: the kind had the check and the supervisor never asked.
    const item = moduleStepOn(folderWorkspace(), "report.docx");

    await supervisorRunning(moduleWriting(["notes.txt"])).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    // Parked rather than failed: a builtin has no attempt cap, so an
    // item left where the scheduler can see it would re-run the module
    // on every tick forever.
    expect(run?.status).toBe("awaiting_input");
    expect(run?.error).toContain("report.docx");
    expect(getItem(handle.db, item.id)?.stepId).toBe("draft");
    const escalation = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "escalation");
    expect(escalation?.body).toContain("report.docx");
    expect(escalation?.body).toContain(drive);
  });

  it("posts a scratch run's files as attachments on an output comment, and the directory is gone afterwards", async () => {
    const store = new AttachmentStorage(mkdtempSync(join(tmpdir(), "eo-attachments-")));
    const item = moduleStepOn(scratchWorkspace(), "");

    await supervisorRunning(moduleWriting(["report.docx", "figures/q3.csv"]), store).runOnce();

    // Authored by the module that produced it, which is what every
    // other comment of its carries (EO-298).
    const output = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "output");
    expect(output?.authorType).toBe("module");
    expect(output?.body).toContain("report.docx");

    // Where each of them sat is in the body, because an attachment
    // carries a filename rather than a path — `safeDisplayName` takes
    // the leaf, which is right for a store that also takes files from
    // Jira, and would otherwise leave `figures/q3.csv` reading as
    // though it had been at the top.
    expect(output?.body).toContain("figures/q3.csv");

    // The files themselves, copied into EO's own store rather than
    // named where they were: the directory below is about to go.
    const attached = listAttachmentsForItem(handle.db, item.id);
    expect(attached.map((attachment) => attachment.name).sort()).toEqual(["q3.csv", "report.docx"]);
    expect(attached.every((attachment) => existsSync(attachment.path))).toBe(true);
    expect(readFileSync(attached.find((attachment) => attachment.name === "report.docx")!.path, "utf8")).toBe("report.docx says so\n");

    const cwd = listRunsForItem(handle.db, item.id)[0]?.cwd;
    expect(cwd?.startsWith(scratchRoot)).toBe(true);
    expect(existsSync(cwd!)).toBe(false);
  });

  it("keeps the scratch directory, and says why, when there is nowhere to copy what is in it", async () => {
    // The one state in which deleting would lose the work: EO could not
    // take a copy, so the copy on disk is the only one there is — and
    // the person reading the thread is the one who can go and get it
    // (invariant 8).
    const item = moduleStepOn(scratchWorkspace(), "");

    await supervisorRunning(moduleWriting(["report.docx"])).runOnce();

    const cwd = listRunsForItem(handle.db, item.id)[0]?.cwd;
    expect(existsSync(join(cwd!, "report.docx"))).toBe(true);
    const output = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "output");
    expect(output?.body).toContain("could not attach");
    expect(listAttachmentsForItem(handle.db, item.id)).toEqual([]);
  });

  it("leaves the folder's files where the team looks for them, output or no output", async () => {
    const store = new AttachmentStorage(mkdtempSync(join(tmpdir(), "eo-attachments-")));
    const item = moduleStepOn(folderWorkspace({ perItemSubfolder: true }), "report.docx");

    await supervisorRunning(moduleWriting(["report.docx"]), store).runOnce();

    expect(listAttachmentsForItem(handle.db, item.id).map((attachment) => attachment.name)).toEqual(["report.docx"]);
    // Attached *and* still on the drive: an attachment is a copy, and
    // the drive is where the team goes looking.
    expect(existsSync(join(drive, item.key, "report.docx"))).toBe(true);
  });
});

/**
 * `ANY_ACTION`, which the folder kind is the reason for (EO-299).
 *
 * A record keyed by action (EO-297) says which actions a kind can vouch
 * for, and the folder kind's answer is "all of them, if the step
 * declares anything" — over a set nobody can enumerate, because a module
 * id is one of them. These are the two halves of that: the lookup falls
 * back to the wildcard, and a named entry still wins over it, so a kind
 * can say "everything, except that this one is special".
 */
describe("a kind that checks whatever ran", () => {
  it("is asked whatever the action was called, and answers for a step that declares nothing with no checks", async () => {
    const kind = folderWorkspaceKind({ db: handle.db });

    expect(verifies(kind, "implement")).toBe(true);
    expect(verifies(kind, "01a01be7-2005-7335-ac8b-11c395830f54")).toBe(true); // a module id
    // And a kind that checks nothing says so, whatever it is asked.
    expect(verifies(scratchWorkspaceKind({ db: handle.db, root: scratchRoot }), "implement")).toBe(false);
  });

  it("prefers the entry an action names over the wildcard", async () => {
    const asked: string[] = [];
    const kind: WorkspaceKind = {
      ...folderWorkspaceKind({ db: handle.db }),
      verifiers: {
        [ANY_ACTION]: verifier(["anything"], async () => {
          asked.push("any");
          return [];
        }),
        implement: verifier(["an implementation"], async () => {
          asked.push("implement");
          return [];
        }),
      },
    };
    const item = itemOn(folderWorkspace());
    const place = await prepared(kind, item);

    await verifyRun(kind, item, verifiableRun(item, place, { action: "implement" }));
    await verifyRun(kind, item, verifiableRun(item, place, { action: "write-report" }));

    expect(asked).toEqual(["implement", "any"]);
  });
});
