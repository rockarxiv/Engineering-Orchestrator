import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPreviewAgent, type Agent, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  createProject,
  getItem,
  listAgents,
  itemTypesFor,
  listItemsForProject,
  listPipelines,
  listProjects,
  listRunsForItem,
  listStepsForPipeline,
  listTransitionsForItem,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { providerForAgent } from "../engine.js";
import { decideItem } from "../ipc/domainCommands.js";
import { listItemSummaries } from "../ipc/domainQueries.js";
import { listGalleryCommand, previewGalleryCommand } from "../ipc/galleryCommands.js";
import { PREVIEW_BANNER } from "../preview.js";
import { PREVIEW_PROJECT_NAME } from "./commands.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { forgetListed } from "./session.js";
import { bundledTemplates } from "./templates.js";

/** A fetch that serves whatever body is handed to it. */
function serving(body: unknown): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
}

/**
 * Preview, from the gallery card (EO-316, `ARCHITECTURE.md`,
 * "Preview", step 3 of the original design).
 *
 * "Preview this pipeline walks an example item through every step with
 * canned output. The person sees the product work before it asks them
 * for anything."
 *
 * EO-313 built the mark and everything that reads it; what was missing
 * was anything that *makes* one, which is this. The test that matters
 * is therefore the walk itself, and it is run through the provider the
 * app actually builds rather than an injected one — the failure this
 * guards against is a preview stopping at the first agent step because
 * nobody on a fresh installation has signed into anything, which is the
 * exact situation the feature exists for and the one an injected
 * provider would hide.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
/**
 * A keychain stand-in. The gallery never writes a secret; what needs one
 * is the preflight behind every card's "what this needs" list, which
 * reads the names it already holds.
 */
const NO_SECRETS = {
  directory: join(tmpdir(), "eo-gallery-no-secrets"),
  store: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(""), decryptString: () => "" },
};
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let handle: DbHandle;
let runtimeRoot: string;

beforeEach(() => {
  handle = openMigratedTestDb();
  // Per test, which also keys `providerForAgent`'s module-level cache
  // apart — it holds one provider per agent id for the life of the
  // process.
  runtimeRoot = mkdtempSync(join(tmpdir(), "eo gallery preview "));
  // What a previous case listed is held in a module — see
  // `gallery/session.ts`.
  forgetListed();
});

afterEach(() => {
  handle.close();
  rmSync(runtimeRoot, { recursive: true, force: true });
});

/** The supervisor as the composition root wires it: no injected provider anywhere. */
function supervisor() {
  return createRunSupervisor({
    db: handle.db,
    provider: (agent: Agent) => providerForAgent(agent, join(runtimeRoot, "eoServer.mjs"), undefined, runtimeRoot, handle.db),
    limits: LIMITS,
    noDiskRoot: join(runtimeRoot, "no-disk"),
  });
}

function context() {
  return { directory: GALLERY_DIRECTORY, moduleSecrets: NO_SECRETS, signedInBackends: [] as string[] };
}

/**
 * Ticks until nothing moves, pressing the button on any human step the
 * item lands on.
 *
 * Deciding rather than skipping, because a human step on a preview is
 * not an obstacle to the demonstration — it *is* part of it. The original design is
 * explicit that the moment worth showing somebody is "when it lands on
 * their step"; a walk that jumped past the Approve column would have
 * shown them everything except the part that is theirs.
 */
async function walk(itemId: Uuid, maxTicks = 12): Promise<void> {
  const engine = supervisor();
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const before = getItem(handle.db, itemId);
    if (before === undefined) return;
    await engine.runOnce();

    const after = getItem(handle.db, itemId);
    if (after === undefined) return;
    if (after.stepId !== before.stepId) continue;

    // Standing still: either it is on a human step and waiting for
    // somebody, or it is finished.
    const step = listStepsForPipeline(handle.db, after.pipelineId ?? "").find((candidate) => candidate.id === after.stepId);
    const first = step?.results[0];
    if (step?.type !== "user" || first === undefined) return;
    const decided = decideItem(handle.db, undefined, { itemId, resultKey: first.key, comment: "" });
    if (!decided.decided) return;
  }
}

describe("Preview on \"Weekly report\"", () => {
  it("walks every step under the fake provider, with the banner shown", async () => {
    const weekly = bundledTemplates(GALLERY_DIRECTORY).find((template) => template.slug === "weekly-report")!;

    const started = await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });
    expect(started.problem).toBeNull();
    const itemId = started.itemId as Uuid;

    await walk(itemId);

    const item = getItem(handle.db, itemId)!;
    const steps = listStepsForPipeline(handle.db, item.pipelineId ?? "");
    const visited = new Set([...listTransitionsForItem(handle.db, itemId).map((transition) => transition.toStepId), steps[0]!.id]);

    // Every step of the pack's own graph — Gather, Draft, Approve,
    // Filed — and not merely "it moved".
    expect(steps).toHaveLength(weekly.document.steps.length);
    expect([...visited].sort()).toEqual(steps.map((step) => step.id).sort());
    expect(steps.find((step) => step.id === item.stepId)?.isTerminal).toBe(true);

    // On the fake provider throughout, whatever the agents say they run
    // on — which on a fresh installation is nothing at all.
    const runs = listRunsForItem(handle.db, itemId);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
    expect([...new Set(runs.map((run) => run.provider))]).toEqual(["fake"]);

    // And the banner: the item is marked, which is what every surface
    // draws it from (EO-313).
    expect(item.previewAt).not.toBeNull();
    const summary = listItemSummaries(handle.db, item.projectId).items.find((row) => row.id === itemId);
    expect(summary?.preview).toBe(true);
    expect(PREVIEW_BANNER).toBe("Preview. Nothing was sent, nothing cost money.");
  });

  /**
   * The preview lands in a project of its own and does not spend
   * anything — the two facts that make pressing this button free.
   */
  it("files the pack's own example in a preview project, costing nothing", async () => {
    const started = await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });

    const item = getItem(handle.db, started.itemId as Uuid)!;
    expect(item.title).toBe("Weekly report — week of 8 September");
    expect(item.projectId).toBe(started.projectId);
    // The pack's example type travelled with it and is a real row on the
    // preview project, or the item could not have been filed at all.
    expect(item.type).toBe("report");
  });

  /**
   * Pressing Preview twice is a gesture this screen is trying to make
   * free, and a second pipeline every time would punish it.
   */
  it("reuses the preview project and its pipeline on a second press", async () => {
    const first = await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });
    const second = await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });

    expect(second.projectId).toBe(first.projectId);
    expect(second.itemId).not.toBe(first.itemId);
    const one = getItem(handle.db, first.itemId as Uuid)!;
    const two = getItem(handle.db, second.itemId as Uuid)!;
    expect(two.pipelineId).toBe(one.pipelineId);
  });

  /**
   * A project called "Preview" that somebody else made is theirs
   * (EO-316).
   *
   * The gallery used to find its preview project by name, and project
   * names are not unique — "Preview" is an entirely ordinary thing for a
   * person to call one of their own. Pressing Preview then imported a
   * template's pipeline, its item types and its agents straight into
   * that project, and the only symptom was their board growing columns
   * nobody added. The gallery writes down which project it made and
   * reads that back instead.
   */
  it("does not touch a project of somebody else's that happens to be called Preview", async () => {
    const theirs = createProject(handle.db, { name: PREVIEW_PROJECT_NAME, keyPrefix: "MINE" });

    const started = await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });

    expect(started.problem).toBeNull();
    expect(started.projectId).not.toBe(theirs.id);
    // Nothing was written into it: no pipeline, no item, and none of the
    // pack's types.
    // Its own, rather than the project-less two every project sees.
    expect(listPipelines(handle.db, theirs.id).filter((pipeline) => pipeline.projectId === theirs.id)).toEqual([]);
    expect(listItemsForProject(handle.db, theirs.id)).toEqual([]);
    expect([...itemTypesFor(handle.db, theirs.id).values()].some((type) => type.slug === "report")).toBe(false);
    // And EO's own is beside it rather than on top of it.
    expect(listProjects(handle.db).find((project) => project.id === started.projectId)?.name).toBe("Preview 2");
  });

  /** The same project on the second press, which is what "made once and reused" means. */
  it("keeps using the project it made, even once a person adds one with the same name", async () => {
    const first = await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });
    createProject(handle.db, { name: PREVIEW_PROJECT_NAME, keyPrefix: "MINE" });

    const second = await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });

    expect(second.projectId).toBe(first.projectId);
  });

  /**
   * A preview's agent never takes somebody's real work (EO-316).
   *
   * It carries the pack's ordinary role name, because that is what the
   * steps it has to walk name — so left in the ordinary pool it answers
   * "who runs `reporter`?" for an item a person filed, and their work is
   * handed to a placeholder that makes things up. `staffsItem` is what
   * keeps the two apart, in core so that the scheduler, the preflight
   * and the validator cannot come to disagree about it.
   */
  it("is never dispatched to a real item on the same role", async () => {
    await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });
    const fake = listAgents(handle.db).find((agent) => agent.role === "reporter" && isPreviewAgent(agent));
    expect(fake?.enabled).toBe(true);

    // Somebody's own work, on a step the gallery's fake reporter could
    // run if anything let it.
    const project = listProjects(handle.db).find((candidate) => candidate.name === "Preview")!;
    const pipelineId = getItem(handle.db, (await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" })).itemId as Uuid)!.pipelineId!;
    const gather = listStepsForPipeline(handle.db, pipelineId)[0]!;
    const real = createTestItem(handle.db, { type: { packSlug: "weekly-report", slug: "report" }, projectId: project.id, title: "The real one", stepId: gather.id });

    await supervisor().runOnce();

    // Not dispatched at all, which is the honest outcome: the role has
    // nobody real in it, so the item waits rather than being answered by
    // a rehearsal's agent.
    expect(listRunsForItem(handle.db, real.id)).toEqual([]);
    expect(getItem(handle.db, real.id)?.stepId).toBe(gather.id);
  });

  /**
   * Which graph a preview walks is the document's, not its name's
   * (EO-316).
   *
   * Two things make the pipeline's name useless as an identity, and both
   * are ordinary. A pack republished under the same slug almost always
   * keeps its pipeline's name — that is what a version is. And two
   * unrelated templates may simply both call theirs "Weekly report".
   * Matching on the name meant an item created from one pack's example
   * walking another pack's imported graph, with nothing anywhere to say
   * the two had come apart.
   */
  describe("when two packs share a pipeline name", () => {
    /** The bundled weekly report, published elsewhere — same pipeline name, a different template. */
    function elsewhere(extraStep: boolean) {
      const weekly = bundledTemplates(GALLERY_DIRECTORY).find((template) => template.slug === "weekly-report")!;
      const pack = JSON.parse(JSON.stringify(weekly.document)) as Record<string, unknown>;
      pack["template"] = { ...weekly.template, slug: "board-pack", title: "Board pack" };
      if (extraStep) {
        (pack["steps"] as Record<string, unknown>[]).push({
          id: "archived",
          position: 9,
          name: "Archived",
          type: "user",
          ownerRole: null,
          entryAction: null,
          instructionsSummary: null,
          isTerminal: true,
          planMode: false,
          results: [],
        });
        (pack["routes"] as Record<string, unknown>[]).push({
          fromStepId: "approve",
          resultKey: "archive",
          label: "Archive",
          tone: "info",
          target: "archived",
          position: 2,
        });
      }
      return pack;
    }

    async function listWith(pack: Record<string, unknown>) {
      const fetchImpl = serving({ eoGalleryIndex: 1, templates: [{ source: "acme.example", pack }] });
      const answer = await listGalleryCommand(handle.db, { ...context(), fetchImpl });
      return answer.templates.find((template) => template.slug === "board-pack")!;
    }

    it("gives each its own graph, and the second its own example", async () => {
      const bundled = await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });
      const card = await listWith(elsewhere(false));
      expect(card.pipelineName).toBe("Weekly report");

      const other = await previewGalleryCommand(handle.db, context(), { slug: card.slug, token: card.token });

      expect(other.problem).toBeNull();
      const one = getItem(handle.db, bundled.itemId as Uuid)!;
      const two = getItem(handle.db, other.itemId as Uuid)!;
      expect(two.pipelineId).not.toBe(one.pipelineId);
    });

    it("imports a second graph when the same pack is republished with a changed one", async () => {
      const first = await listWith(elsewhere(false));
      const before = await previewGalleryCommand(handle.db, context(), { slug: first.slug, token: first.token });

      // The site publishes again: same slug, same pipeline name, one
      // step longer.
      const second = await listWith(elsewhere(true));
      expect(second.token).not.toBe(first.token);
      const after = await previewGalleryCommand(handle.db, context(), { slug: second.slug, token: second.token });

      const walked = getItem(handle.db, after.itemId as Uuid)!;
      const original = getItem(handle.db, before.itemId as Uuid)!;
      expect(walked.pipelineId).not.toBe(original.pipelineId);
      // The graph whose card was pressed, rather than the one that
      // happened to share its name.
      expect(listStepsForPipeline(handle.db, walked.pipelineId!).map((step) => step.name)).toContain("Archived");
      expect(listStepsForPipeline(handle.db, original.pipelineId!).map((step) => step.name)).not.toContain("Archived");
    });

    /** And the unchanged pack still reuses its own, which is what makes Preview free to press. */
    it("keeps one graph for a pack that has not changed", async () => {
      const first = await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });
      const second = await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });

      expect(getItem(handle.db, second.itemId as Uuid)?.pipelineId).toBe(getItem(handle.db, first.itemId as Uuid)?.pipelineId);
    });
  });

  it("says so rather than throwing when nothing goes by that name", async () => {
    const answer = await previewGalleryCommand(handle.db, context(), { slug: "not-a-template" });

    expect(answer.itemId).toBeNull();
    expect(answer.problem).toContain("not-a-template");
  });
});
