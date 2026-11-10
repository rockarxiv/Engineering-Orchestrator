import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEMPLATE_UPDATE_RECENT_MS, uuidv7, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  createPipeline,
  createStep,
  currentVersion,
  listPipelineVersions,
  listRoutesForPipeline,
  listStepsForPipeline,
  openUpdateConflict,
  publishSection,
  replacePipelineGraph,
  resolveUpdateConflict,
  setPipelineVersionsToKeep,
  setUpdateConflictChat,
} from "../db/repos/index.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { openUpdateConflictChat } from "../roles/updateConflictChat.js";
import { loadTemplateHistory, type TemplateHistory } from "./history.js";
import { backfillPipelineOrigins } from "./origins.js";
import { describeTemplateStatus } from "./templateStatus.js";
import { applyTemplateUpdates } from "./templateUpdates.js";
import { UPDATE_CONFLICT_ON_THE_RECORD } from "./updateConflictDetail.js";

/**
 * What a pipeline's head says about its template (EO-536): the origin,
 * an update applied in the last few days, and a held one with where
 * pressing it goes.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
const SOFTWARE = "software-feature-to-merge";

let handle: DbHandle;
let history: TemplateHistory;

beforeEach(() => {
  handle = openMigratedTestDb();
  history = loadTemplateHistory(GALLERY_DIRECTORY);
});

afterEach(() => {
  handle.close();
});

/** EO's Delivery as it was before EO-461, on 1.0, with Merge Request's `opened` going to `target`. */
function deliveryOn10(target: string): void {
  handle.db.run(sql`DELETE FROM step_routes WHERE from_step_id = 'pull_request_watch'`);
  handle.db.run(sql`UPDATE pipeline_steps SET retired_version = 1 WHERE id = 'pull_request_watch'`);
  handle.db.run(sql`UPDATE step_routes SET target = ${target} WHERE from_step_id = 'merge_request' AND result_key = 'opened'`);
  backfillPipelineOrigins(handle.db, history);
}

/** Delivery re-pointed at a Merge pipeline: the one conflict 1.1, and so 1.2 and 1.3, raise against it. */
function customisedDelivery(): void {
  const merge = createPipeline(handle.db, { projectId: null, name: "Merge" });
  createStep(handle.db, { id: "merge_pr", pipelineId: merge.id as Uuid, position: 0, name: "Merge PR", type: "user" });
  createStep(handle.db, { pipelineId: merge.id as Uuid, position: 1, name: "Merged", type: "user", isTerminal: true });
  deliveryOn10("merge_pr");
}

function adopted(): Uuid {
  const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
  handle.db.run(sql`UPDATE pipelines SET project_id = ${project.id} WHERE id = 'default'`);
  return project.id as Uuid;
}

/** When the update in these cases is applied: a fixed moment, so "a few days later" is exact. */
const APPLIED_AT = 1_800_000_000_000;

const notesOf = (version: string) => history.get(SOFTWARE)!.find((entry) => entry.version === version)!.notes;

describe("a pipeline's template origin", () => {
  it("is the template's title and the base's version", () => {
    deliveryOn10("ready_to_merge");

    expect(describeTemplateStatus(handle.db, "default", history)).toEqual({
      origin: { slug: SOFTWARE, title: "Software feature to merge", version: "1.0" },
      updated: null,
      waiting: null,
      problem: null,
    });
  });

  it("is nothing at all for a pipeline made from no template", () => {
    const own = createPipeline(handle.db, { projectId: null, name: "Mine" });
    createStep(handle.db, { pipelineId: own.id as Uuid, position: 0, name: "Only", type: "user", isTerminal: true });

    expect(describeTemplateStatus(handle.db, own.id, history)).toEqual({ origin: null, updated: null, waiting: null, problem: null });
  });

  it("falls back to the stored base's title where this build ships no history for the template", () => {
    deliveryOn10("ready_to_merge");

    expect(describeTemplateStatus(handle.db, "default", new Map()).origin).toEqual({ slug: SOFTWARE, title: "Software feature to merge", version: "1.0" });
  });

  it("is not this desktop's to say for a pipeline its organisation's record holds", () => {
    deliveryOn10("ready_to_merge");
    publishSection(handle.db, { section: "pipelines", subjectId: "default", versionId: uuidv7(), versionNumber: 1, document: null, publishedAt: 1, publishedBy: null, publishedByName: null });

    expect(describeTemplateStatus(handle.db, "default", history)).toEqual({ origin: null, updated: null, waiting: null, problem: UPDATE_CONFLICT_ON_THE_RECORD });
    // On the record itself, it is its own.
    expect(describeTemplateStatus(handle.db, "default", history, { onTheRecord: true }).origin?.version).toBe("1.0");
  });
});

describe("after an applied update", () => {
  it("says which version was applied, as which pipeline version, with that version's release notes", () => {
    deliveryOn10("ready_to_merge");
    createTestItem(handle.db, { type: "story", title: "On it", stepId: "todo", projectId: adopted() });

    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false, now: APPLIED_AT })).toEqual([expect.objectContaining({ outcome: "applied" })]);
    const filed = currentVersion(handle.db, "default")!;

    expect(describeTemplateStatus(handle.db, "default", history, { now: APPLIED_AT + 1 })).toEqual({
      origin: { slug: SOFTWARE, title: "Software feature to merge", version: "1.3" },
      updated: { version: "1.3", pipelineVersion: filed.number, at: APPLIED_AT, notes: notesOf("1.3") },
      waiting: null,
      problem: null,
    });
  });

  it("stops saying so a few days later", () => {
    deliveryOn10("ready_to_merge");
    adopted();
    applyTemplateUpdates(handle.db, history, { isTheRecord: false, now: APPLIED_AT });

    expect(describeTemplateStatus(handle.db, "default", history, { now: APPLIED_AT + TEMPLATE_UPDATE_RECENT_MS })?.updated?.version).toBe("1.3");
    const later = describeTemplateStatus(handle.db, "default", history, { now: APPLIED_AT + TEMPLATE_UPDATE_RECENT_MS + 1 });
    expect(later.updated).toBeNull();
    expect(later.origin?.version).toBe("1.3");
  });

  it("is still said after an ordinary edit has pruned the version the update filed", () => {
    deliveryOn10("ready_to_merge");
    adopted();
    // Nothing standing on the update's version, and only the newest kept.
    setPipelineVersionsToKeep(handle.db, 1);
    applyTemplateUpdates(handle.db, history, { isTheRecord: false, now: APPLIED_AT });
    const filed = currentVersion(handle.db, "default")!;
    expect(filed.createdBy).toBe(`template:${SOFTWARE}@1.3`);

    // The person renames a step: an ordinary save, which files a version and prunes.
    const steps = listStepsForPipeline(handle.db, "default").map(({ ownerPersonId: _person, ownerGroupId: _group, ...step }) => (step.id === "todo" ? { ...step, name: "Next up" } : step));
    const routes = listRoutesForPipeline(handle.db, "default").map(({ id: _id, ...route }) => route);
    expect(replacePipelineGraph(handle.db, "default", steps, routes, { createdBy: null })).toEqual(expect.objectContaining({ replaced: true }));
    expect(listPipelineVersions(handle.db, "default").map((version) => version.createdBy)).not.toContain(`template:${SOFTWARE}@1.3`);

    expect(describeTemplateStatus(handle.db, "default", history, { now: APPLIED_AT + 60_000 }).updated).toEqual({
      version: "1.3",
      pipelineVersion: filed.number,
      at: APPLIED_AT,
      notes: notesOf("1.3"),
    });
  });

  it("is no longer said once a held update resolved later moves the base past it", () => {
    deliveryOn10("ready_to_merge");
    adopted();
    applyTemplateUpdates(handle.db, history, { isTheRecord: false, now: APPLIED_AT });
    // The base moved on to a version this update did not take.
    handle.db.run(sql`UPDATE pipelines SET template_version = '1.4' WHERE id = 'default'`);

    expect(describeTemplateStatus(handle.db, "default", history, { now: APPLIED_AT + 1 }).updated).toBeNull();
  });

  it("is found by migration 0138 for an update applied before the pipeline kept it, while its version is still kept", () => {
    deliveryOn10("ready_to_merge");
    adopted();
    applyTemplateUpdates(handle.db, history, { isTheRecord: false, now: APPLIED_AT });
    const filed = currentVersion(handle.db, "default")!;
    handle.db.run(sql`UPDATE pipelines SET template_applied = NULL`);
    expect(describeTemplateStatus(handle.db, "default", history, { now: filed.createdAt }).updated).toBeNull();

    const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations", "0138_template_update_applied.sql"), "utf8");
    const backfill = migration.split("--> statement-breakpoint")[1]!;
    handle.db.run(sql.raw(backfill));

    expect(describeTemplateStatus(handle.db, "default", history, { now: filed.createdAt }).updated).toEqual({
      version: "1.3",
      pipelineVersion: filed.number,
      at: filed.createdAt,
      notes: notesOf("1.3"),
    });
  });

  it("is not said of a pipeline whose base was never moved by an applied update", () => {
    deliveryOn10("ready_to_merge");

    expect(describeTemplateStatus(handle.db, "default", history).updated).toBeNull();
  });
});

describe("with an update held", () => {
  it("counts the conflicts, and points at no notice, since a notice sent as a message is on no item (EO-727)", () => {
    customisedDelivery();
    adopted();
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    const conflict = openUpdateConflict(handle.db, "default")!;

    const status = describeTemplateStatus(handle.db, "default", history);

    expect(status.origin?.version).toBe("1.0");
    expect(status.updated).toBeNull();
    expect(status.waiting).toEqual({
      conflictId: conflict.id,
      fromVersion: "1.0",
      toVersion: "1.3",
      conflicts: 1,
      problems: 0,
      chatId: null,
      notice: null,
    });
  });

  it("points at the chat once Fix with assistant has opened one, and at none again once that chat is gone", () => {
    customisedDelivery();
    adopted();
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    const conflict = openUpdateConflict(handle.db, "default")!;
    const opened = openUpdateConflictChat(handle.db, { conflictId: conflict.id, commentId: null, fallbackProjectId: null, answeredBy: { kind: "here", agentId: uuidv7() } });
    if (!opened.ok) throw new Error(opened.problem);

    expect(describeTemplateStatus(handle.db, "default", history).waiting?.chatId).toBe(opened.chat.id);

    setUpdateConflictChat(handle.db, conflict.id, uuidv7());
    expect(describeTemplateStatus(handle.db, "default", history).waiting?.chatId).toBeNull();
  });

  it("says nothing is waiting once the conflict is resolved", () => {
    customisedDelivery();
    adopted();
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    resolveUpdateConflict(handle.db, openUpdateConflict(handle.db, "default")!.id, "kept");

    expect(describeTemplateStatus(handle.db, "default", history).waiting).toBeNull();
  });
});
