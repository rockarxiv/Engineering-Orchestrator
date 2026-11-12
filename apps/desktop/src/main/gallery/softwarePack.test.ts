import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_RESULTS, qualifiedItemType, type Uuid } from "@eo/core";
import { validatePipeline } from "@eo/engine";
import type { DbHandle } from "../db/client.js";
import { listPipelines, listRoutesForPipeline, listStepsForPipeline } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { exportPipeline, importPipeline } from "../modules/pipelineTransfer.js";
import { registryForProject } from "../registry.js";
import { syncRolePrompts } from "../roles/prompts.js";
import { galleryRoleSlots } from "./form.js";
import { bundledTemplates } from "./templates.js";
import { loadTemplateHistory } from "./history.js";
import { backfillPipelineOrigins } from "./origins.js";
import { applyTemplateUpdates } from "./templateUpdates.js";
import { storedGraphProblems } from "../ipc/configCommands.js";

/**
 * "Software feature to merge" is the shipped Delivery pipeline, as a
 * data pack (EO-316, `ARCHITECTURE.md`, "The gallery").
 *
 * The story names it as one of the four the gallery is made of — "the
 * current EO pipeline as 'Software feature to merge'" — and the design says
 * what a data pack is: the graph *plus* the item types with their spec
 * shapes, the roles with their prompts and output schemas, the
 * connectors and the vocabulary. One file, one format version, the same
 * import gate.
 *
 * An earlier cut of this file was the graph alone. It looked right and
 * was not: its steps named `implementer` and `reviewer` and it shipped
 * no roles, so importing it wrote no agents and the card's "what this
 * needs" list said nothing about the two it needs; it filed
 * `developer:story` and shipped no types, so it worked only by landing
 * on an installation that already had EO's own seeded rows. A template
 * that silently depends on the machine it is installed on is the one
 * thing a pack is defined in opposition to.
 *
 * So the file is **generated from a real export** and this holds it
 * there. Two things it therefore catches, and both are silent otherwise:
 * the pack losing its own data again, and the shipped pipeline moving on
 * without the template that claims to be it — a step added to Delivery,
 * a prompt rewritten, a type gaining a field.
 *
 * **When this fails, regenerate the file rather than editing it.** What
 * it asserts is that the bundled pack *is* `exportPipeline(db,
 * "default")`, so the fix for a legitimate change to Delivery is to take
 * the export again. Only the two authored fields are the gallery's own —
 * see `authored` below.
 */

const here = dirname(fileURLToPath(import.meta.url));
const GALLERY_DIRECTORY = join(here, "..", "..", "..", "resources", "gallery");
/**
 * Where the role prompts live, applied before the export.
 *
 * `syncRolePrompts` is what the composition root runs at startup, and
 * without it the seeded rows still hold migration 0001's placeholder —
 * so an export taken from a bare test database would ship "TODO:
 * placeholder instructions for the implementer role" to every person who
 * installed this template.
 */
const PROMPTS_DIRECTORY = join(here, "..", "packs", "developer", "prompts");

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

/** The bundled file, through the same gate every other pack goes through. */
function bundled() {
  const template = bundledTemplates(GALLERY_DIRECTORY).find((candidate) => candidate.slug === "software-feature-to-merge");
  expect(template, "the gallery no longer ships software-feature-to-merge").toBeDefined();
  return template!;
}

/**
 * The two fields the gallery authors and an export cannot produce.
 *
 * `template` is the card's own words, and `previewItem` is the example
 * Preview walks — "authored, never harvested", because the newest item
 * on somebody's board is their actual work and putting it in a shipped
 * file would leak it (`PreviewItemSchema`). Everything else is the
 * export's, which is what the comparison below is for.
 */
const AUTHORED = ["template", "previewItem"] as const;

function withoutAuthored(document: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...document };
  for (const key of AUTHORED) delete copy[key];
  return copy;
}

describe("the bundled software template", () => {
  /**
   * After the first launch's template update. Migrations seed the 1.1
   * graph, and 1.2 (EO-571) reaches the seed as a template version like
   * it reaches every other pipeline made from 1.1 — never as a migration
   * (ARCHITECTURE.md §15.5). Along with 1.3 (EO-664), which changed the
   * template's opening question and nothing in the graph. And 1.4
   * (EO-763), which adds the Pull request comments board: the export of
   * Delivery carries it, since Delivery routes into it.
   */
  it("is exactly what exporting the shipped Delivery pipeline produces, once the first launch has brought it up to date", () => {
    syncRolePrompts(handle.db, PROMPTS_DIRECTORY);
    const history = loadTemplateHistory(GALLERY_DIRECTORY);
    backfillPipelineOrigins(handle.db, history);
    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toEqual([expect.objectContaining({ pipelineId: "default", outcome: "applied", from: "1.1", to: "1.4" })]);
    expect(listPipelines(handle.db).map((pipeline) => pipeline.name)).toContain("Pull request comments");
    const built = exportPipeline(handle.db, "default");
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // EO recommends no backend, which is the one normalisation.
    //
    // The original design: "a pack names the role each agent step needs and the
    // installing machine chooses the agent … It may recommend a backend
    // and model. It may not require one." The seeded agents run on
    // `fake` because nobody has configured this installation, and
    // passing that on as advice would put "built on fake" beside every
    // role on the needs check of a template EO itself publishes.
    const expected = withoutAuthored({ ...built.document, roles: built.document.roles.map((role) => ({ ...role, backend: null, model: null })) });

    expect(withoutAuthored(bundled().document as unknown as Record<string, unknown>)).toEqual(expected);
  });

  /**
   * And the same thing said as intent rather than as equality, so a
   * failure above can be read.
   *
   * Equality catches everything and explains nothing; these three name
   * what a pack must carry to stand on its own, and would each have
   * failed against the graph-only version of this file.
   */
  it("ships a role for every agent step its own pipeline names", () => {
    const pack = bundled().document;
    const wanted = [...new Set(pack.steps.filter((step) => step.type === "agent" && step.ownerRole !== null).map((step) => step.ownerRole))];

    expect(wanted).toEqual(["implementer", "reviewer"]);
    for (const slug of wanted) {
      const role = pack.roles.find((candidate) => candidate.slug === slug);
      expect(role, `no role for "${slug}"`).toBeDefined();
      // The prompt, and the shape its runs are held to — the two things
      // the design says turn a pipeline document into a pack.
      expect(role!.prompt?.length ?? 0).toBeGreaterThan(200);
      expect(Object.keys(role!.schemasByAction).length).toBeGreaterThan(0);
      // Never a requirement (ARCHITECTURE.md, "An agent is a row").
      expect(role!.backend).toBeNull();
    }
  });

  it("ships the item types it files work under, with their spec shapes", () => {
    const pack = bundled().document;

    expect(pack.itemTypes.map((type) => qualifiedItemType(type)).sort()).toEqual(["developer:bug", "developer:feature", "developer:story"]);
    // The example Preview walks is one of them, or the preview could not
    // be filed on a project this pack made.
    expect(pack.itemTypes.some((type) => qualifiedItemType(type) === pack.previewItem?.type)).toBe(true);
    // A type whose shape did not travel demands nothing, so an item
    // filed under it is accepted without the fields the type exists to
    // collect (`ExportedItemTypeSchema`).
    const story = pack.itemTypes.find((type) => type.slug === "story");
    expect(Object.keys(story?.specShape.properties ?? {}).length).toBeGreaterThan(0);
  });

  it("says what it calls its types and its results", () => {
    const pack = bundled().document;

    expect(pack.vocabulary.types.map((entry) => entry.type).sort()).toEqual(["developer:bug", "developer:feature", "developer:story"]);
    // Every word on a button its human step offers.
    expect(pack.vocabulary.results.map((entry) => entry.key).sort()).toEqual(["approved", "rejected", "revise", "send_back"]);
  });

  /**
   * The template block, which is the one half an export cannot write.
   *
   * Asserted here rather than left to the equality above, because that
   * comparison deliberately drops it — and a bundled file whose card had
   * lost its description would otherwise pass everything.
   */
  it("carries the words its card is drawn from", () => {
    const template = bundled();

    expect(template.title).toBe("Software feature to merge");
    expect(template.description.length).toBeGreaterThan(40);
    expect(template.version).not.toBe("");
    expect(template.document.previewItem).not.toBeNull();
  });
});

/**
 * Every result the pull request step can return has somewhere to go, in
 * both places the pipeline ships (EO-429).
 *
 * A builtin's unrouted result is only a warning — EO parks the ticket
 * and asks — which is exactly why it is asserted: adding a key to
 * `BUILTIN_RESULTS` breaks nothing, and the first anybody hears of the
 * missing route is a ticket stopped on a step nobody was watching.
 */
describe("the pull request step's results, routed in what EO ships", () => {
  function problemsOnThePullRequestStep(pipelineId: string) {
    const steps = listStepsForPipeline(handle.db, pipelineId as Uuid);
    const routes = listRoutesForPipeline(handle.db, pipelineId as Uuid);
    const step = steps.find((candidate) => candidate.entryAction === "open_pull_request")!;
    const implementer = steps.find((candidate) => candidate.ownerRole === "implementer")!;

    const problems = validatePipeline({
      steps,
      routes,
      entryStepId: listPipelines(handle.db).find((pipeline) => pipeline.id === pipelineId)?.entryStepId ?? null,
      staffedRoles: ["implementer", "reviewer"],
      itemCountByStep: {},
      existingSteps: [],
      registry: registryForProject(handle.db, null),
    });

    const routed = routes.filter((route) => route.fromStepId === step.id);
    expect(routed.map((route) => route.resultKey).sort()).toEqual([...BUILTIN_RESULTS.open_pull_request].sort());
    for (const key of ["uncommitted_changes", "remote_diverged"]) {
      expect(routed.find((route) => route.resultKey === key)?.target, key).toBe(implementer.id);
    }
    return problems.filter((problem) => problem.stateId === step.id);
  }

  it("leaves the shipped default pipeline with nothing unrouted", () => {
    expect(problemsOnThePullRequestStep("default")).toEqual([]);
  });

  it("leaves the bundled template with nothing unrouted, once imported", () => {
    const imported = importPipeline(handle.db, { document: bundled().document, projectId: null, signedInBackends: [] });
    if (!imported.ok) throw new Error(imported.reason);

    expect(problemsOnThePullRequestStep(imported.pipelineId)).toEqual([]);
  });
});

/**
 * The pull request is watched once it is open (EO-461): the template
 * carries a step that keeps checking between Merge Request and Done, and
 * every result that step can give goes somewhere.
 */
describe("the pull request watch in the bundled template", () => {
  it("keeps checking every five minutes for a week, after Merge Request and its reply, and before Done", () => {
    const pack = bundled().document;
    const watch = pack.steps.find((step) => step.name === "Watching pull request");

    expect(watch).toMatchObject({ type: "builtin", entryAction: "watch_pull_request", ownerRole: null, isTerminal: false, watch: { everyMinutes: 5, giveUpAfterHours: 168 } });
    const order = [...pack.steps].sort((a, b) => a.position - b.position).map((step) => step.name);
    expect(order.slice(-4)).toEqual(["Merge Request", "Reply on pull request", "Watching pull request", "Done"]);
  });

  it("routes merged to Done, what the implementer can fix and the person's comments to To Do, other accounts' comments to planning, and the rest to a person", () => {
    const pack = bundled().document;
    const watch = pack.steps.find((step) => step.entryAction === "watch_pull_request")!;
    const done = pack.steps.find((step) => step.name === "Done")!;
    const implementer = pack.steps.find((step) => step.ownerRole === "implementer")!;
    const targets = Object.fromEntries(pack.routes.filter((route) => route.fromStepId === watch.id).map((route) => [route.resultKey, route.target]));

    expect(targets).toEqual({
      merged: done.id,
      checks_failed: implementer.id,
      conflict: implementer.id,
      author_commented: implementer.id,
      // Other accounts' comments are never instructions on their own
      // (EO-763): they are planned for on the Pull request comments board.
      changes_requested: "pr_comments_plan",
      others_commented: "pr_comments_plan",
      closed: "user_attention",
      // Never answered here — the step does not set `reportReady` — and
      // routed so that nothing the step can return is left unrouted.
      ready: "user_attention",
      failed: "user_attention",
    });
    expect(Object.keys(targets).sort()).toEqual([...BUILTIN_RESULTS.watch_pull_request].sort());
    // Merge Request's success leads into the reply, and every answer of the reply into the watch, but a refusal.
    const reply = pack.steps.find((step) => step.entryAction === "reply_on_pull_request")!;
    expect(pack.routes.find((route) => route.fromStepId === "merge_request" && route.resultKey === "opened")?.target).toBe(reply.id);
    const replied = Object.fromEntries(pack.routes.filter((route) => route.fromStepId === reply.id).map((route) => [route.resultKey, route.target]));
    expect(replied).toEqual({ replied: watch.id, nothing_to_reply: watch.id, failed: "user_attention" });
    expect(Object.keys(replied).sort()).toEqual([...BUILTIN_RESULTS.reply_on_pull_request].sort());
  });

  /**
   * Both boards (EO-763), each judged as a stored pipeline is: Delivery's
   * hand-offs land on the Pull request comments board's steps, and that
   * board's on Delivery's, so neither is judged as a graph on its own.
   */
  it("passes validatePipeline with nothing to say, on both of its boards, once imported", () => {
    const imported = importPipeline(handle.db, { document: bundled().document, projectId: null, signedInBackends: [] });
    if (!imported.ok) throw new Error(imported.reason);

    expect(imported.boardPipelineIds).toHaveLength(1);
    for (const pipelineId of [imported.pipelineId, ...imported.boardPipelineIds]) {
      const steps = listStepsForPipeline(handle.db, pipelineId);
      const entry = listPipelines(handle.db).find((pipeline) => pipeline.id === pipelineId)?.entryStepId ?? null;
      expect(storedGraphProblems(handle.db, pipelineId, steps, listRoutesForPipeline(handle.db, pipelineId), entry), pipelineId).toEqual([]);
    }
    // And the watch arrived watching, which is what a version-8 reader
    // would have dropped, and never giving up, which is what a version-9
    // reader would have (`PIPELINE_EXPORT_VERSION`).
    expect(listStepsForPipeline(handle.db, imported.pipelineId).find((step) => step.entryAction === "watch_pull_request")?.watch).toEqual({
      everyMinutes: 5,
      giveUpAfterHours: 168,
      neverGivesUp: true,
    });
  });
});

/**
 * A terminal step is where work comes to rest, not a decision somebody
 * owns (ARCHITECTURE.md, "The gallery").
 *
 * The shipped Delivery pipeline has never put an owner on
 * `ready_to_merge`, and the gallery must not start: a form asking "who
 * owns Done?" is a question with no consequence, and solo mode answering
 * it on the person's behalf writes an owner onto a column with nothing
 * to decide.
 */
describe("the role slots a template names", () => {
  it("leaves out the terminal step of every bundled template", () => {
    for (const template of bundledTemplates(GALLERY_DIRECTORY)) {
      const terminal = template.document.steps.filter((step) => step.isTerminal).map((step) => step.id);
      const slots = galleryRoleSlots(template.document).map((slot) => slot.stepId);

      expect(slots.filter((stepId) => terminal.includes(stepId)), `${template.slug} offers a terminal step as a slot`).toEqual([]);
    }
  });

  it("names Approve on the weekly report, and nothing else", () => {
    const weekly = bundledTemplates(GALLERY_DIRECTORY).find((template) => template.slug === "weekly-report")!;

    // "Filed" is a `user` step too, and is where the report ends up
    // rather than something anybody presses.
    expect(galleryRoleSlots(weekly.document).map((slot) => slot.name)).toEqual(["Approve"]);
  });

  it("names Approve plan on the software template, and not Done", () => {
    const software = bundled();

    expect(software.document.steps.filter((step) => step.type === "user").map((step) => step.name)).toEqual(["Done"]);
    // The person approving a plan for other accounts' comments, on the
    // Pull request comments board (EO-763).
    expect(galleryRoleSlots(software.document)).toEqual([{ stepId: "pr_comments_approve", name: "Approve plan" }]);
  });
});
