import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUGGESTIONS_PIPELINE_NAME, USER_ATTENTION_TARGET, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  createPipeline,
  createPipelineVersion,
  createRun,
  createStep,
  currentVersion,
  createRoute,
  getItem,
  getJiraBinding,
  getPipelineVersion,
  getStep,
  graphForItem,
  getPipeline,
  getPipelineOrigin,
  listCommentsForItem,
  listPipelines,
  listPipelineSteps,
  listPipelineVersions,
  listRoutesForPipeline,
  listRunsForItem,
  listStepsForPipeline,
  listTransitionsForItem,
  postComment,
  saveJiraBinding,
  getSetting,
  setSetting,
  SHARED_UNTIL_SPLIT_SETTING,
  transitionItem,
  versionSnapshot,
} from "../db/repos/index.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { createJob } from "../jobs/jobs.js";
import { parseExport } from "../modules/pipelineTransfer.js";
import type { TemplateDocument } from "../db/repos/index.js";
import { listPipelineViews } from "../ipc/domainQueries.js";
import { resolveDecisionRoute } from "../ipc/decisions.js";
import { environmentFor, listSecretNames, storeSecret, storeVariable, type ModuleSecretsOptions } from "../modules/secrets.js";
import { items, jobs, messages, projects } from "../db/schema.js";
import { createTestItem, messagesFrom, openMigratedTestDb } from "../db/testHelpers.js";
import { PREVIEW_PROJECT_KEY } from "./commands.js";
import { loadTemplateHistory, type TemplateHistory } from "./history.js";
import { backfillPipelineOrigins } from "./origins.js";
import { settleSeededPipelines, SPLIT_FAILED_SOURCE, splitSharedPipelines, splitSharedPipelinesOrHold } from "./sharedPipelines.js";
import { applyTemplateUpdates } from "./templateUpdates.js";

/**
 * A secret copy that fails on demand (EO-766 review): after `copies`
 * scopes have been copied, the next one throws, as an unreadable scope
 * directory or a full disk would. Undefined copies everything.
 */
const secretCopies = vi.hoisted(() => ({ failAfter: undefined as number | undefined, copied: [] as string[] }));
vi.mock("../modules/secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../modules/secrets.js")>();
  return {
    ...actual,
    copyStepSecrets: (options: ModuleSecretsOptions, from: string, to: string): void => {
      if (secretCopies.failAfter !== undefined && secretCopies.copied.length >= secretCopies.failAfter) throw new Error("ENOSPC: no space left on device");
      actual.copyStepSecrets(options, from, to);
      secretCopies.copied.push(to);
    },
  };
});

/**
 * No pipeline shared between projects (EO-766): the upgrade that splits
 * the seeded Delivery among the projects that shared it, and the first
 * project made without its template, which archives it.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

/** A project made `at` a given moment, so which is oldest is not left to the clock. */
function projectAt(name: string, keyPrefix: string, at: number): Uuid {
  const project = createProject(handle.db, { name, keyPrefix });
  handle.db.update(projects).set({ createdAt: at }).where(eq(projects.id, project.id)).run();
  return project.id;
}

/** What a project's rail lists — `pipelines:list` for it. */
function listed(projectId: Uuid): string[] {
  return listPipelineViews(handle.db, { projectId }).pipelines.map((pipeline) => pipeline.id);
}

describe("upgrading an installation whose projects share Delivery", () => {
  it("leaves the oldest project the original and gives the other a copy, each with its own items", () => {
    const db = handle.db;
    // The origin the seeded Delivery is given on launch, before the split.
    backfillPipelineOrigins(db, loadTemplateHistory(GALLERY_DIRECTORY));
    const alpha = projectAt("Alpha", "ALP", 1_000);
    const beta = projectAt("Beta", "BET", 2_000);

    const alphaItem = createTestItem(db, { type: "story", title: "Alpha's story", projectId: alpha, stepId: "todo" });
    const betaItem = createTestItem(db, { type: "story", title: "Beta's story", projectId: beta, stepId: "todo" });
    const betaFeature = createTestItem(db, { type: "feature", title: "Beta's feature", projectId: beta, stepId: null, pipelineId: "default" as Uuid });
    transitionItem(db, { itemId: betaItem.id, toStepId: "review", actor: "human", reason: "moved" });
    postComment(db, { itemId: betaItem.id, author: { type: "human" }, kind: "note", body: "Looks right to me." });
    createRun(db, { itemId: betaItem.id, agentId: null, action: "review", status: "succeeded" });

    const before = {
      versions: listPipelineVersions(db, "default").map((version) => version.id),
      alphaItem: getItem(db, alphaItem.id),
      betaTransitions: listTransitionsForItem(db, betaItem.id),
      betaVersion: getItem(db, betaItem.id)?.pipelineVersionId ?? null,
    };

    const splits = splitSharedPipelines(db);

    expect(splits).toHaveLength(1);
    expect(splits[0]?.keptBy).toBe(alpha);
    expect(splits[0]?.copies.map((copy) => ({ projectId: copy.projectId, movedItems: copy.movedItems }))).toEqual([{ projectId: beta, movedItems: 2 }]);

    // Alpha keeps the original: its id, its item, its versions.
    expect(getPipeline(db, "default")?.projectId).toBe(alpha);
    expect(listPipelineVersions(db, "default").map((version) => version.id)).toEqual(before.versions);
    expect(getItem(db, alphaItem.id)).toEqual(before.alphaItem);

    // Beta has a copy of its own, with step ids no other pipeline uses.
    const copyId = splits[0]!.copies[0]!.pipelineId;
    const copy = getPipeline(db, copyId)!;
    expect(copy.projectId).toBe(beta);
    expect(copy.name).toBe("Delivery");
    const copySteps = listStepsForPipeline(db, copyId);
    const originalSteps = listStepsForPipeline(db, "default");
    expect(copySteps.map((step) => step.name)).toEqual(originalSteps.map((step) => step.name));
    const elsewhere = new Set(listPipelineSteps(db).filter((step) => step.pipelineId !== copyId).map((step) => step.id));
    expect(copySteps.some((step) => elsewhere.has(step.id))).toBe(false);
    expect(copy.entryStepId).toBe(copySteps.find((step) => step.name === originalSteps.find((original) => original.id === getPipeline(db, "default")?.entryStepId)?.name)?.id);
    // Its routes run between its own steps.
    const ownIds = new Set(copySteps.map((step) => step.id));
    for (const route of listRoutesForPipeline(db, copyId)) expect(ownIds.has(route.fromStepId)).toBe(true);

    // Beta's item stands on the matching step of the copy, under the
    // matching version, with its thread, runs and history as they were.
    const moved = getItem(db, betaItem.id)!;
    expect(moved.pipelineId).toBe(copyId);
    expect(copySteps.find((step) => step.id === moved.stepId)?.name).toBe(originalSteps.find((step) => step.id === "review")?.name);
    expect(moved.pipelineVersionId).not.toBeNull();
    expect(listPipelineVersions(db, copyId).find((version) => version.id === moved.pipelineVersionId)?.number).toBe(
      listPipelineVersions(db, "default").find((version) => version.id === before.betaVersion)?.number,
    );
    expect(listCommentsForItem(db, betaItem.id).map((comment) => comment.body)).toContain("Looks right to me.");
    expect(listRunsForItem(db, betaItem.id)).toHaveLength(1);
    const transitions = listTransitionsForItem(db, betaItem.id);
    expect(transitions.slice(0, before.betaTransitions.length)).toEqual(before.betaTransitions);
    expect(transitions.at(-1)).toMatchObject({ fromStepId: "review", toStepId: moved.stepId });

    // Its feature, which stands on no step, is placed on the copy too.
    expect(getItem(db, betaFeature.id)).toMatchObject({ pipelineId: copyId, stepId: null });

    // Each project's list is its own.
    expect(listed(alpha)).toEqual(["default"]);
    expect(listed(beta)).toEqual([copyId]);
  });

  it("gives the copy the template its original remembers, so a template update reaches both", () => {
    const db = handle.db;
    const history = loadTemplateHistory(GALLERY_DIRECTORY);
    backfillPipelineOrigins(db, history);
    projectAt("Alpha", "ALP", 1_000);
    projectAt("Beta", "BET", 2_000);

    const copyId = splitSharedPipelines(db)[0]!.copies[0]!.pipelineId;

    const original = getPipelineOrigin(db, "default")!;
    const copied = getPipelineOrigin(db, copyId)!;
    expect(copied.slug).toBe(original.slug);
    expect(copied.version).toBe(original.version);
    expect(copied.base).toEqual(original.base);
    // The template's step ids now name the copy's own steps.
    const copySteps = new Map(listStepsForPipeline(db, copyId).map((step) => [step.id, step.name]));
    const originalSteps = new Map(listStepsForPipeline(db, "default").map((step) => [step.id, step.name]));
    for (const [templateStep, stepId] of Object.entries(copied.stepIds)) {
      expect(copySteps.get(stepId)).toBe(originalSteps.get(original.stepIds[templateStep]!));
    }

    const updated = applyTemplateUpdates(db, history, { isTheRecord: false });
    expect(updated.map((update) => update.pipelineId).sort()).toEqual([copyId, "default"].sort());
    expect(getPipelineOrigin(db, copyId)?.version).toBe(getPipelineOrigin(db, "default")?.version);
  });

  it("moves what else of the other project's pointed at the original: jobs, hand-offs and Jira statuses", () => {
    const db = handle.db;
    projectAt("Alpha", "ALP", 1_000);
    const beta = projectAt("Beta", "BET", 2_000);
    const job = createJob(db, {
      projectId: beta,
      name: "Weekly",
      trigger: { kind: "manual" },
      pipelineId: "default",
      template: { type: "story", title: "Weekly", body: null },
    });
    if (!job.ok) throw new Error(job.problem);
    const intake = createPipeline(db, { projectId: beta, name: "Intake" });
    const triage = createStep(db, { pipelineId: intake.id, position: 0, name: "Triage", type: "user", results: [{ key: "accept", label: "Accept", tone: "success", requiresComment: false }] });
    createRoute(db, { pipelineId: intake.id, fromStepId: triage.id, resultKey: "accept", label: "Accept", target: "todo" });
    saveJiraBinding(db, beta, { statusMap: { todo: "To Do", review: "In Review" } });

    const copy = splitSharedPipelines(db)[0]!.copies[0]!;
    const steps = new Map(listStepsForPipeline(db, copy.pipelineId).map((step) => [step.name, step.id]));
    const todoName = listStepsForPipeline(db, "default").find((step) => step.id === "todo")!.name;
    const reviewName = listStepsForPipeline(db, "default").find((step) => step.id === "review")!.name;

    expect(db.select({ pipelineId: jobs.pipelineId }).from(jobs).where(eq(jobs.id, job.job.id)).get()?.pipelineId).toBe(copy.pipelineId);
    expect(listRoutesForPipeline(db, intake.id)[0]?.target).toBe(steps.get(todoName));
    expect(getJiraBinding(db, beta)?.config.statusMap).toEqual({ [steps.get(todoName)!]: "To Do", [steps.get(reviewName)!]: "In Review" });
  });

  it("leaves Preview and the projects an organisation manages out of it", () => {
    const db = handle.db;
    const preview = projectAt("Preview", "PRE", 500);
    setSetting(db, PREVIEW_PROJECT_KEY, preview);
    const managed = projectAt("Theirs", "THE", 700);
    db.update(projects).set({ managedAt: 700 }).where(eq(projects.id, managed)).run();
    const served = createTestItem(db, { type: "story", title: "Served", projectId: managed, stepId: "todo" });
    const alpha = projectAt("Alpha", "ALP", 1_000);

    const splits = splitSharedPipelines(db);

    expect(splits).toEqual([{ pipelineId: "default", keptBy: alpha, copies: [] }]);
    expect(getItem(db, served.id)?.pipelineId).toBe("default");
    // The organisation's project still sees the pipeline its work stands on, as served.
    expect(listPipelines(db, managed).map((pipeline) => pipeline.id)).toContain("default");
    expect(listPipelines(db, preview).map((pipeline) => pipeline.id)).not.toContain("default");
  });

  it("leaves the Suggestions queue shared, and shows it to every project", () => {
    const db = handle.db;
    const suggestions = createPipeline(db, { name: SUGGESTIONS_PIPELINE_NAME });
    const alpha = projectAt("Alpha", "ALP", 1_000);
    const beta = projectAt("Beta", "BET", 2_000);

    splitSharedPipelines(db);

    expect(getPipeline(db, suggestions.id)?.projectId).toBeNull();
    expect(listPipelines(db, alpha).map((pipeline) => pipeline.id)).toContain(suggestions.id);
    expect(listPipelines(db, beta).map((pipeline) => pipeline.id)).toContain(suggestions.id);
  });

  it("does nothing a second time, and nothing before there is a project", () => {
    const db = handle.db;
    expect(splitSharedPipelines(db)).toEqual([]);
    expect(getPipeline(db, "default")?.projectId).toBeNull();

    projectAt("Alpha", "ALP", 1_000);
    projectAt("Beta", "BET", 2_000);
    expect(splitSharedPipelines(db)).toHaveLength(1);
    expect(splitSharedPipelines(db)).toEqual([]);
  });
});

describe("what the split carries besides the work (EO-766 review)", () => {
  /** A keychain that is no keychain, reversible so a value read back is the value written. */
  const store = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from([...text].reverse().join("")),
    decryptString: (buffer: Buffer) => [...buffer.toString()].reverse().join(""),
  };
  let directory: string;
  let moduleSecrets: ModuleSecretsOptions;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo split secrets "));
    moduleSecrets = { directory, store };
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("gives each copied step its original's secrets and variables, ahead of a conflicting shared value", () => {
    const db = handle.db;
    projectAt("Alpha", "ALP", 1_000);
    projectAt("Beta", "BET", 2_000);
    expect(storeSecret(moduleSecrets, "FLY_API_TOKEN", "production-token", "review")).toEqual({ ok: true });
    expect(storeSecret(moduleSecrets, "FLY_API_TOKEN", "staging-token")).toEqual({ ok: true });
    storeVariable(moduleSecrets, "REGION", "eu-west", "review");
    storeVariable(moduleSecrets, "REGION", "us-east");

    const copy = splitSharedPipelines(db, { moduleSecrets })[0]!.copies[0]!;
    const reviewName = getStep(db, "review")!.name;
    const copiedReview = listStepsForPipeline(db, copy.pipelineId).find((step) => step.name === reviewName)!.id;

    expect(environmentFor(moduleSecrets, ["FLY_API_TOKEN", "REGION"], copiedReview).env).toEqual({ FLY_API_TOKEN: "production-token", REGION: "eu-west" });
    // The original's are where they were.
    expect(environmentFor(moduleSecrets, ["FLY_API_TOKEN"], "review").env).toEqual({ FLY_API_TOKEN: "production-token" });
  });

  it("keeps an unreadable step value unreadable on the copy, so it still stops the shared fallback", () => {
    const db = handle.db;
    projectAt("Alpha", "ALP", 1_000);
    projectAt("Beta", "BET", 2_000);
    storeSecret(moduleSecrets, "FLY_API_TOKEN", "production-token", "review");
    storeSecret(moduleSecrets, "FLY_API_TOKEN", "staging-token");
    const broken: ModuleSecretsOptions = {
      directory,
      store: {
        ...store,
        decryptString: (buffer: Buffer) => {
          const value = store.decryptString(buffer);
          if (value === "production-token") throw new Error("no longer decrypts");
          return value;
        },
      },
    };

    const copy = splitSharedPipelines(db, { moduleSecrets: broken })[0]!.copies[0]!;
    const reviewName = getStep(db, "review")!.name;
    const copiedReview = listStepsForPipeline(db, copy.pipelineId).find((step) => step.name === reviewName)!.id;

    const resolved = environmentFor(broken, ["FLY_API_TOKEN"], copiedReview);
    expect(resolved.env).toEqual({});
    expect(resolved.unreadable).toEqual(["FLY_API_TOKEN"]);
  });

  it("hands work bound to an older version of the project's own pipeline to the project's copy, leaving that version as it was", () => {
    const db = handle.db;
    projectAt("Alpha", "ALP", 1_000);
    const beta = projectAt("Beta", "BET", 2_000);
    const intake = createPipeline(db, { projectId: beta, name: "Intake" });
    const triage = createStep(db, { pipelineId: intake.id, position: 0, name: "Triage", type: "user", results: [{ key: "accept", label: "Accept", tone: "success", requiresComment: false }] });
    createRoute(db, { pipelineId: intake.id, fromStepId: triage.id, resultKey: "accept", label: "Accept", target: "todo" });
    const v1 = createPipelineVersion(db, intake.id);
    const older = createTestItem(db, { type: "story", title: "Entered on v1", projectId: beta, stepId: triage.id, pipelineId: intake.id });
    expect(getItem(db, older.id)?.pipelineVersionId).toBe(v1.id);
    const v2 = createPipelineVersion(db, intake.id);
    const current = createTestItem(db, { type: "story", title: "Entered on v2", projectId: beta, stepId: triage.id, pipelineId: intake.id });
    expect(getItem(db, current.id)?.pipelineVersionId).toBe(v2.id);

    const copy = splitSharedPipelines(db)[0]!.copies[0]!;
    const todoName = getStep(db, "todo")!.name;
    const copiedTodo = listStepsForPipeline(db, copy.pipelineId).find((step) => step.name === todoName)!.id;

    // The history is untouched.
    expect(getPipelineVersion(db, v1.id)).toEqual(v1);
    expect(getPipelineVersion(db, v2.id)).toEqual(v2);
    for (const itemId of [older.id, current.id]) {
      const item = getItem(db, itemId)!;
      expect(item.pipelineVersionId).not.toBe(v1.id);
      expect(item.pipelineVersionId).not.toBe(v2.id);
      expect(graphForItem(db, item).routes.map((route) => route.target)).toEqual([copiedTodo]);
      expect(resolveDecisionRoute(db, item, getStep(db, triage.id)!, "accept")).toEqual({ kind: "step", stepId: copiedTodo, pipelineId: copy.pipelineId });
    }
    // The one that was on the current version still is.
    expect(getItem(db, current.id)?.pipelineVersionId).toBe(currentVersion(db, intake.id)?.id);
    expect(getItem(db, older.id)?.pipelineVersionId).not.toBe(currentVersion(db, intake.id)?.id);
  });

  it("points a copy's hand-offs at the project's own copies and pipelines, and parks one into another project's", () => {
    const db = handle.db;
    const alpha = projectAt("Alpha", "ALP", 1_000);
    const beta = projectAt("Beta", "BET", 2_000);
    const gamma = projectAt("Gamma", "GAM", 3_000);
    // A second shared pipeline Delivery hands work to.
    const release = createPipeline(db, { name: "Release" });
    const ship = createStep(db, { pipelineId: release.id, position: 0, name: "Ship", type: "user", results: [] });
    // And a pipeline of Beta's, which Delivery was drawn to while shared.
    const ops = createPipeline(db, { projectId: beta, name: "Ops" });
    const page = createStep(db, { pipelineId: ops.id, position: 0, name: "Page", type: "user", results: [] });
    createRoute(db, { pipelineId: "default" as Uuid, fromStepId: "todo", resultKey: "ship", label: "Ship", target: ship.id });
    createRoute(db, { pipelineId: "default" as Uuid, fromStepId: "todo", resultKey: "page", label: "Page", target: page.id });
    createPipelineVersion(db, "default");

    const splits = splitSharedPipelines(db);
    const delivery = splits.find((split) => split.pipelineId === "default")!;
    const releaseSplit = splits.find((split) => split.pipelineId === release.id)!;
    const copyOf = (split: typeof delivery, projectId: Uuid): string => split.copies.find((copy) => copy.projectId === projectId)!.pipelineId;
    const shipOf = (projectId: Uuid): string => listStepsForPipeline(db, copyOf(releaseSplit, projectId))[0]!.id;
    const targets = (pipelineId: string) => {
      const routes = listRoutesForPipeline(db, pipelineId);
      const versioned = versionSnapshot(db, currentVersion(db, pipelineId)!.id)!.routes.filter((route) => route.resultKey === "ship" || route.resultKey === "page");
      return {
        live: Object.fromEntries(routes.filter((route) => route.resultKey === "ship" || route.resultKey === "page").map((route) => [route.resultKey, route.target])),
        versioned: Object.fromEntries(versioned.map((route) => [route.resultKey, route.target])),
      };
    };

    // Alpha's original is exactly as it was.
    expect(targets("default")).toEqual({ live: { ship: ship.id, page: page.id }, versioned: { ship: ship.id, page: page.id } });
    // Beta's copy ships to Beta's own Release, and still pages Beta's Ops.
    const forBeta = { ship: shipOf(beta), page: page.id };
    expect(targets(copyOf(delivery, beta))).toEqual({ live: forBeta, versioned: forBeta });
    // Gamma's ships to Gamma's own, and asks a person rather than paging Beta's.
    const forGamma = { ship: shipOf(gamma), page: USER_ATTENTION_TARGET };
    expect(targets(copyOf(delivery, gamma))).toEqual({ live: forGamma, versioned: forGamma });

    // Both the parked route and the original's route into Beta's are said.
    const sent = db.select().from(messages).all();
    expect(sent.map((message) => message.projectId).sort()).toEqual([alpha, gamma].sort());
    expect(sent.find((message) => message.projectId === gamma)?.body).toContain('"Page" on "Ops", which belongs to Beta');
    expect(sent.find((message) => message.projectId === alpha)?.body).toContain('"Page" on "Ops", which belongs to Beta');
  });
});

describe("a split that fails (EO-766 review)", () => {
  const store = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (buffer: Buffer) => buffer.toString(),
  };
  let directory: string;
  let moduleSecrets: ModuleSecretsOptions;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo split failure "));
    moduleSecrets = { directory, store };
    secretCopies.copied = [];
  });

  afterEach(() => {
    secretCopies.failAfter = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  it("undoes everything, keeps Delivery shared so no board is lost, tells the person, and succeeds on a later launch", () => {
    const db = handle.db;
    const alpha = projectAt("Alpha", "ALP", 1_000);
    const beta = projectAt("Beta", "BET", 2_000);
    const alphaItem = createTestItem(db, { type: "story", title: "Alpha's story", projectId: alpha, stepId: "todo" });
    const betaItem = createTestItem(db, { type: "story", title: "Beta's story", projectId: beta, stepId: "review" });
    // Two scoped steps, so the second fails after the first was copied.
    storeSecret(moduleSecrets, "FLY_API_TOKEN", "todo-token", "todo");
    storeSecret(moduleSecrets, "FLY_API_TOKEN", "review-token", "review");
    const before = { alphaItem: getItem(db, alphaItem.id), betaItem: getItem(db, betaItem.id), pipelines: listPipelines(db, undefined, true).map((pipeline) => pipeline.id) };
    secretCopies.failAfter = 1;

    expect(splitSharedPipelinesOrHold(db, { moduleSecrets })).toEqual([]);

    // Rolled back whole: no copy, nothing moved, Delivery nobody's, and
    // the one scope that was copied removed again.
    expect(secretCopies.copied).toHaveLength(1);
    expect(listPipelines(db, undefined, true).map((pipeline) => pipeline.id)).toEqual(before.pipelines);
    expect(getPipeline(db, "default")?.projectId).toBeNull();
    expect(getItem(db, alphaItem.id)).toEqual(before.alphaItem);
    expect(getItem(db, betaItem.id)).toEqual(before.betaItem);
    expect(listSecretNames(moduleSecrets, secretCopies.copied[0]!)).toEqual([]);
    expect(environmentFor(moduleSecrets, ["FLY_API_TOKEN"], "review").env).toEqual({ FLY_API_TOKEN: "review-token" });

    // Every project still reaches Delivery, as before the upgrade.
    expect(getSetting(db, SHARED_UNTIL_SPLIT_SETTING, [])).toEqual(["default"]);
    expect(listed(alpha)).toEqual(["default"]);
    expect(listed(beta)).toEqual(["default"]);

    // And the person is told, once however many launches it fails on.
    expect(splitSharedPipelinesOrHold(db, { moduleSecrets })).toEqual([]);
    const told = messagesFrom(db, SPLIT_FAILED_SOURCE);
    expect(told.filter((message) => message.handledAt === null)).toHaveLength(1);
    expect(told.at(-1)?.body).toContain('its own copy of "Delivery"');
    expect(told.at(-1)?.body).toContain("ENOSPC: no space left on device");
    expect(told.at(-1)?.body).toContain("stays shared among your projects as before");

    // The next launch that can copy the secrets splits it, stops sharing
    // it, and resolves the message.
    secretCopies.failAfter = undefined;
    const splits = splitSharedPipelinesOrHold(db, { moduleSecrets });
    expect(splits[0]?.copies.map((copy) => copy.projectId)).toEqual([beta]);
    const copyId = splits[0]!.copies[0]!.pipelineId;
    expect(getSetting(db, SHARED_UNTIL_SPLIT_SETTING, null)).toBeNull();
    expect(listed(alpha)).toEqual(["default"]);
    expect(listed(beta)).toEqual([copyId]);
    expect(getItem(db, betaItem.id)?.pipelineId).toBe(copyId);
    expect(messagesFrom(db, SPLIT_FAILED_SOURCE).every((message) => message.handledHow === "resolved")).toBe(true);
  });
});

/**
 * The newest shipped Delivery, at a later version that adds a Comments
 * board: Delivery gains a Reply step handing work to Comments, and
 * Comments hands work back to Delivery's To Do.
 */
function withCommentsBoard(history: TemplateHistory): TemplateHistory {
  const slug = "software-feature-to-merge";
  const newest = history.get(slug)!.at(-1)!;
  const raw = JSON.parse(JSON.stringify(newest.document)) as {
    template: { version: string };
    steps: unknown[];
    routes: unknown[];
    boards?: unknown[];
  };
  const human = (id: string, position: number, name: string, results: string[], isTerminal = false) => ({
    id,
    position,
    name,
    type: "user",
    ownerRole: null,
    entryAction: null,
    instructionsSummary: null,
    isTerminal,
    planMode: false,
    results: results.map((key) => ({ key, label: key, tone: "info", requiresComment: false })),
  });
  const route = (fromStepId: string, resultKey: string, target: string) => ({ fromStepId, resultKey, label: resultKey, tone: "info", target, position: 0 });
  raw.template.version = "99.0";
  raw.steps.push(human("dl_reply", 99, "Reply", ["replied"]));
  raw.routes.push(route("dl_reply", "replied", "cm_plan"));
  raw.boards = [
    {
      key: "comments",
      pipeline: { name: "Comments", icon: null, entryStepId: "cm_plan", entryRules: [] },
      steps: [human("cm_plan", 0, "Approve plan", ["approved", "rejected"]), human("cm_closed", 1, "Closed", [], true)],
      routes: [route("cm_plan", "approved", "todo"), route("cm_plan", "rejected", "cm_closed")],
    },
  ];
  const parsed = parseExport(JSON.stringify(raw));
  if (!parsed.ok) throw new Error(parsed.reason);
  const version = { slug, version: "99.0", notes: "Adds the Comments board.", document: parsed.document as TemplateDocument };
  return new Map([[slug, [...history.get(slug)!, version]]]);
}

describe("a template update that adds a board while a split is held (EO-766 review)", () => {
  let directory: string;
  let moduleSecrets: ModuleSecretsOptions;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo held split "));
    moduleSecrets = {
      directory,
      store: { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text), decryptString: (buffer: Buffer) => buffer.toString() },
    };
    secretCopies.copied = [];
  });

  afterEach(() => {
    secretCopies.failAfter = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  it("shares the new board with every project as Delivery is, and gives each project its own on the launch that splits", () => {
    const db = handle.db;
    const shipped = loadTemplateHistory(GALLERY_DIRECTORY);
    backfillPipelineOrigins(db, shipped);
    applyTemplateUpdates(db, shipped, { isTheRecord: false });
    const alpha = projectAt("Alpha", "ALP", 1_000);
    const beta = projectAt("Beta", "BET", 2_000);
    createTestItem(db, { type: "story", title: "Alpha's story", projectId: alpha, stepId: "todo" });
    const betaItem = createTestItem(db, { type: "story", title: "Beta's story", projectId: beta, stepId: "review" });
    storeSecret(moduleSecrets, "FLY_API_TOKEN", "todo-token", "todo");

    // The launch: the split fails, then the update adds Comments.
    secretCopies.failAfter = 0;
    expect(splitSharedPipelinesOrHold(db, { moduleSecrets })).toEqual([]);
    const updated = applyTemplateUpdates(db, withCommentsBoard(shipped), { isTheRecord: false });
    expect(updated).toEqual([expect.objectContaining({ pipelineId: "default", outcome: "applied", to: "99.0" })]);
    const comments = listPipelines(db).find((pipeline) => pipeline.name === "Comments")!;
    expect(comments.projectId).toBeNull();

    // Shared with every project as Delivery is, and Delivery's hand-off lands on it.
    expect(getSetting(db, SHARED_UNTIL_SPLIT_SETTING, [])).toEqual(["default", comments.id]);
    expect(listed(alpha)).toEqual(["default", comments.id]);
    expect(listed(beta)).toEqual(["default", comments.id]);
    const reply = listRoutesForPipeline(db, "default").find((each) => each.resultKey === "replied")!;
    expect(getStep(db, reply.target)?.pipelineId).toBe(comments.id);

    // The next launch splits both, and Beta's copies hand work to each other.
    secretCopies.failAfter = undefined;
    const splits = splitSharedPipelinesOrHold(db, { moduleSecrets });
    expect(splits.map((split) => split.pipelineId)).toEqual(["default", comments.id]);
    expect(getSetting(db, SHARED_UNTIL_SPLIT_SETTING, null)).toBeNull();
    const betaDelivery = splits[0]!.copies[0]!.pipelineId;
    const betaComments = splits[1]!.copies[0]!.pipelineId;
    expect(listed(alpha)).toEqual(["default", comments.id]);
    expect(listed(beta).sort()).toEqual([betaDelivery, betaComments].sort());
    expect(getItem(db, betaItem.id)?.pipelineId).toBe(betaDelivery);
    const betaReply = listRoutesForPipeline(db, betaDelivery).find((each) => each.resultKey === "replied")!;
    expect(getStep(db, betaReply.target)?.pipelineId).toBe(betaComments);
    const backToTodo = listRoutesForPipeline(db, betaComments).find((each) => each.resultKey === "approved")!;
    expect(getStep(db, backToTodo.target)?.pipelineId).toBe(betaDelivery);
  });
});

describe("the first project made without the Delivery template", () => {
  it("archives the seeded Delivery when it holds no work", () => {
    const db = handle.db;
    const first = projectAt("First", "FIR", 1_000);

    settleSeededPipelines(db, first);

    expect(getPipeline(db, "default")?.archivedAt).not.toBeNull();
    expect(listed(first)).toEqual([]);
  });

  it("gives it to that project instead where work was filed onto it before any project existed", () => {
    const db = handle.db;
    const early = createTestItem(db, { type: "story", title: "Before any project", stepId: "todo" });
    const first = projectAt("First", "FIR", 1_000);

    settleSeededPipelines(db, first);

    expect(getPipeline(db, "default")).toMatchObject({ projectId: first, archivedAt: null });
    expect(getItem(db, early.id)?.pipelineId).toBe("default");
  });

  it("leaves it alone once a second project exists", () => {
    const db = handle.db;
    projectAt("First", "FIR", 1_000);
    const second = projectAt("Second", "SEC", 2_000);

    settleSeededPipelines(db, second);

    expect(getPipeline(db, "default")).toMatchObject({ projectId: null, archivedAt: null });
    expect(db.select().from(items).all()).toEqual([]);
  });
});
