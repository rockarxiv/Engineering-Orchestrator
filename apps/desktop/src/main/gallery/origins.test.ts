import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uuidv7, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createPipeline, createStep, getPipelineOrigin, getSetting, listStepsForPipeline } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { loadTemplateHistory, type TemplateHistory } from "./history.js";
import { backfillPipelineOrigins, matchTemplateVersion, ORIGINS_BACKFILLED_KEY } from "./origins.js";

/**
 * Origins for pipelines that predate them (EO-531): matched once, by
 * step id, against the template versions the app ships.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
const SOFTWARE = "software-feature-to-merge";

/** EO's own Delivery: the template's steps from `worktree` to `ready_to_merge`, and no `pull_request_watch`. */
const DELIVERY_BEFORE_EO_461 = ["worktree", "repository_index", "todo", "review", "merge_request", "ready_to_merge"];

let handle: DbHandle;
let history: TemplateHistory;

beforeEach(() => {
  handle = openMigratedTestDb();
  history = loadTemplateHistory(GALLERY_DIRECTORY);
});

afterEach(() => {
  handle.close();
});

describe("matching step ids against the history", () => {
  it("maps a pipeline shaped like EO's Delivery, with no pull_request_watch, to the version before EO-461", () => {
    const match = matchTemplateVersion(DELIVERY_BEFORE_EO_461, history);
    expect(match?.version.slug).toBe(SOFTWARE);
    expect(match?.version.version).toBe("1.0");
    expect(match?.stepIds).toEqual(Object.fromEntries(DELIVERY_BEFORE_EO_461.map((id) => [id, id])));
  });

  it("maps the same shape to 1.0 when the person has added a step of their own", () => {
    expect(matchTemplateVersion([...DELIVERY_BEFORE_EO_461, uuidv7()], history)?.version.version).toBe("1.0");
  });

  it("maps a pipeline that watches its pull request to the current version, when only its step ids are known", () => {
    expect(matchTemplateVersion([...DELIVERY_BEFORE_EO_461, "pull_request_watch"], history)?.version.version).toBe("1.3");
  });

  /**
   * 1.1 and 1.2 have the same step ids (EO-571), so the ids cannot tell
   * them apart. The steps can: a watch that gives up after a week is
   * 1.1's, and one that never gives up is 1.2's — or 1.3's, which differs
   * from 1.2 only in the question first run asks (EO-664), so the newest
   * of the two is the one.
   */
  it("tells two versions with the same steps apart by what the steps are set to", () => {
    const steps = listStepsForPipeline(handle.db, "default");
    const ids = steps.map((step) => step.id);
    expect(steps.find((step) => step.id === "pull_request_watch")?.watch).toEqual({ everyMinutes: 5, giveUpAfterHours: 168 });
    expect(matchTemplateVersion(ids, history, steps)?.version.version).toBe("1.1");

    const neverGivesUp = steps.map((step) => (step.id === "pull_request_watch" ? { ...step, watch: { everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true } } : step));
    expect(matchTemplateVersion(ids, history, neverGivesUp)?.version.version).toBe("1.3");
  });

  it("still matches a pipeline the person removed a step from, and leaves that step out of the map", () => {
    const held = DELIVERY_BEFORE_EO_461.filter((id) => id !== "repository_index");
    const match = matchTemplateVersion(held, history);
    expect(match?.version.version).toBe("1.0");
    expect(match?.stepIds).not.toHaveProperty("repository_index");
  });

  it("matches nothing for a pipeline somebody drew", () => {
    expect(matchTemplateVersion([uuidv7(), uuidv7(), uuidv7()], history)).toBeNull();
  });

  it("matches nothing for a pipeline holding only a minority of a version's steps", () => {
    expect(matchTemplateVersion(["todo", "review", uuidv7()], history)).toBeNull();
  });
});

describe("the one-time backfill", () => {
  /**
   * Migrations seed the 1.1 graph, whose watch gives up after a week, and
   * 1.2 (EO-571) is a template version rather than a migration. So the
   * seed's origin is the version it is, and `applyTemplateUpdates`
   * brings it to 1.2 like any other pipeline made from 1.1.
   */
  it("gives the seeded Delivery of a new installation the version the seed is — the first-run seed's origin", () => {
    const result = backfillPipelineOrigins(handle.db, history);

    expect(result.ran).toBe(true);
    expect(result.recorded).toEqual([{ pipelineId: "default", slug: SOFTWARE, version: "1.1" }]);
    const origin = getPipelineOrigin(handle.db, "default");
    expect(origin?.slug).toBe(SOFTWARE);
    expect(origin?.version).toBe("1.1");
    expect(origin?.base).toEqual(history.get(SOFTWARE)![1]!.document);
    expect(Object.keys(origin!.stepIds).sort()).toEqual(listStepsForPipeline(handle.db, "default").map((step) => step.id).sort());
  });

  it("gives a Delivery with no pull_request_watch the version before EO-461, with that version stored as its base", () => {
    // EO's own Delivery: its Merge Request routes into a Merge pipeline
    // rather than to Done, so migration 0123 never gave it the step.
    // Retiring it is the shortest way to that graph.
    handle.db.run(sql`UPDATE pipeline_steps SET retired_version = 1 WHERE id = 'pull_request_watch'`);
    expect(listStepsForPipeline(handle.db, "default").map((step) => step.id).sort()).toEqual([...DELIVERY_BEFORE_EO_461].sort());

    backfillPipelineOrigins(handle.db, history);

    const origin = getPipelineOrigin(handle.db, "default");
    expect(origin?.version).toBe("1.0");
    expect(origin?.base.steps.map((step) => step.id)).toEqual(DELIVERY_BEFORE_EO_461);
    expect(origin?.base.routes.find((route) => route.fromStepId === "merge_request" && route.resultKey === "opened")?.target).toBe("ready_to_merge");
  });

  it("leaves a pipeline that matches no template without an origin", () => {
    const drawn = createPipeline(handle.db, { projectId: null, name: "Drawn here" });
    for (const [position, name] of ["Write", "Check", "Done"].entries()) {
      createStep(handle.db, { pipelineId: drawn.id as Uuid, position, name, type: "user", isTerminal: name === "Done" });
    }

    const result = backfillPipelineOrigins(handle.db, history);

    expect(result.recorded.map((origin) => origin.pipelineId)).not.toContain(drawn.id);
    expect(getPipelineOrigin(handle.db, drawn.id)).toBeNull();
  });

  it("runs once: a later launch matches nothing again", () => {
    backfillPipelineOrigins(handle.db, history);
    expect(getSetting<number | null>(handle.db, ORIGINS_BACKFILLED_KEY, null)).not.toBeNull();

    handle.db.run(sql`UPDATE pipelines SET template_slug = NULL, template_version = NULL, template_base_id = NULL WHERE id = 'default'`);
    const again = backfillPipelineOrigins(handle.db, history);

    expect(again).toEqual({ ran: false, recorded: [] });
    expect(getPipelineOrigin(handle.db, "default")).toBeNull();
  });

  it("does not count as run where no history shipped, so a build that ships it still matches", () => {
    expect(backfillPipelineOrigins(handle.db, new Map())).toEqual({ ran: false, recorded: [] });
    expect(getSetting<number | null>(handle.db, ORIGINS_BACKFILLED_KEY, null)).toBeNull();
    expect(backfillPipelineOrigins(handle.db, history).recorded).toHaveLength(1);
  });
});
