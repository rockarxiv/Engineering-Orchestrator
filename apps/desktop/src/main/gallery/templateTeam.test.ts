import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StepTeamSchema, type StepTeam, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { adoptPipeline, getPipelineOrigin, listStepsForPipeline, openUpdateConflict, replacePipelineGraph, listRoutesForPipeline } from "../db/repos/index.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { loadTemplateHistory, type TemplateHistory, type TemplateVersion } from "./history.js";
import { backfillPipelineOrigins } from "./origins.js";
import { applyTemplateUpdates, compareWithTemplate } from "./templateUpdates.js";

/**
 * A team in a template's next version (EO-843): compared with the
 * installed pipeline like any other step setting, taken where only the
 * template changed it, and held as a conflict where the person configured
 * a different one.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
const SOFTWARE = "software-feature-to-merge";

const TEMPLATE_TEAM = StepTeamSchema.parse({ coordination: "leader", leader: { role: "reviewer", instructions: "Split the review by concern." }, roles: ["reviewer"] });
const PERSON_TEAM = StepTeamSchema.parse({ ...TEMPLATE_TEAM, roles: ["implementer"] });

let handle: DbHandle;
let shipped: TemplateHistory;

beforeEach(() => {
  handle = openMigratedTestDb();
  shipped = loadTemplateHistory(GALLERY_DIRECTORY);
  // Delivery on the newest version shipped, as a fresh install has it after its first launch.
  // Adopted first, so the board the newest version adds is made on the same project (EO-763).
  backfillPipelineOrigins(handle.db, shipped);
  adoptPipeline(handle.db, "default", createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" }).id as Uuid);
  applyTemplateUpdates(handle.db, shipped, { isTheRecord: false });
});

afterEach(() => handle.close());

/** The shipped history and one more version, whose Review step runs as `TEMPLATE_TEAM`. */
function withTeamVersion(): { history: TemplateHistory; next: TemplateVersion } {
  const versions = shipped.get(SOFTWARE)!;
  const newest = versions.at(-1)!;
  const document = JSON.parse(JSON.stringify(newest.document)) as TemplateVersion["document"];
  document.steps = document.steps.map((step) => (step.id === "review" ? { ...step, team: TEMPLATE_TEAM } : step));
  const next: TemplateVersion = { slug: SOFTWARE, version: "99.0", notes: "Review runs as a team.", document };
  return { history: new Map([...shipped, [SOFTWARE, [...versions, next]]]), next };
}

const reviewTeam = (): StepTeam | null | undefined => listStepsForPipeline(handle.db, "default").find((step) => step.id === "review")?.team;

/** The person configures their own team on Review, through the repository every save goes through. */
function personConfigures(team: StepTeam): void {
  const steps = listStepsForPipeline(handle.db, "default").map((step) => (step.id === "review" ? { ...step, team } : step));
  replacePipelineGraph(handle.db, "default", steps, listRoutesForPipeline(handle.db, "default"));
}

describe("a template version that gives a step a team", () => {
  it("is compared as a change to that step's team, and applied where the person had none", () => {
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe(shipped.get(SOFTWARE)!.at(-1)!.version);
    expect(reviewTeam()).toBeNull();
    const { history, next } = withTeamVersion();

    const compared = compareWithTemplate(handle.db, "default", next)!;
    expect(compared.merge.comparison.changes).toEqual([
      expect.objectContaining({ key: { kind: "setting", stepId: "review", field: "team" }, outcome: "template", base: null, current: null, template: TEMPLATE_TEAM }),
    ]);

    const applied = applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    expect(openUpdateConflict(handle.db, "default")).toBeUndefined();
    expect(applied).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "applied", to: "99.0" }));
    expect(reviewTeam()).toEqual(TEMPLATE_TEAM);
  });

  it("is held as a conflict where the person configured a different team, and leaves theirs", () => {
    personConfigures(PERSON_TEAM);
    const { history } = withTeamVersion();

    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toContainEqual(expect.objectContaining({ pipelineId: "default", outcome: "conflict", to: "99.0" }));
    expect(reviewTeam()).toEqual(PERSON_TEAM);
    expect(openUpdateConflict(handle.db, "default")?.conflicts).toEqual([
      expect.objectContaining({ key: { kind: "setting", stepId: "review", field: "team" }, current: PERSON_TEAM, template: TEMPLATE_TEAM }),
    ]);
  });
});
