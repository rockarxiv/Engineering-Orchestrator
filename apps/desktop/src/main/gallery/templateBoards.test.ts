import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USER_ATTENTION_TARGET, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  createPerson,
  createPipeline,
  createProject,
  createRoute,
  createStep,
  getPipelineOrigin,
  getStep,
  listPipelines,
  listPipelineVersions,
  listRoutesForPipeline,
  listStepsForPipeline,
  openUpdateConflict,
  replacePipelineGraph,
  type TemplateDocument,
} from "../db/repos/index.js";
import { createTestItem, messagesFrom, openMigratedTestDb } from "../db/testHelpers.js";
import { exportPipeline, importPipeline, parseExport } from "../modules/pipelineTransfer.js";
import { useTemplate } from "./commands.js";
import { galleryBlanks, galleryRoleSlots } from "./form.js";
import { loadTemplateHistory, type TemplateHistory, type TemplateVersion } from "./history.js";
import { backfillPipelineOrigins } from "./origins.js";
import { tokenFor, type GalleryTemplate } from "./templates.js";
import { applyTemplateUpdates } from "./templateUpdates.js";
import { describeUpdateConflict, resolveHeldUpdate } from "./updateConflictDetail.js";

/**
 * A template of several boards that route into each other (EO-762):
 * installed together, updated together — a board a new version adds is
 * made even where the update to another board is held — and exported
 * whole. Routes between the boards land on the steps as installed, which
 * may carry other ids than the template's.
 *
 * The template here is Delivery as 1.3 ships it, with a second board,
 * Comments, whose plan step a new Delivery step hands work to, and which
 * hands work back to Delivery's To Do and that new step.
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

function shipped(version: string): TemplateVersion {
  const found = history.get(SOFTWARE)?.find((entry) => entry.version === version);
  if (found === undefined) throw new Error(`no ${SOFTWARE} ${version} shipped`);
  return found;
}

function human(id: string, position: number, name: string, results: string[], isTerminal = false) {
  return {
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
  };
}

function route(fromStepId: string, resultKey: string, target: string) {
  return { fromStepId, resultKey, label: resultKey, tone: "info", target, position: 0 };
}

interface Shape {
  /** Whether Delivery gains a Reply step that hands work to Comments, and that Comments sends rejections to (otherwise to its Closed). */
  reply?: boolean;
  /** Whether Index is dropped from Delivery — which an item on it holds the update over. */
  dropIndex?: boolean;
  /** Pull request watch's check interval, to change Delivery and nothing else. */
  everyMinutes?: number;
  /** The prefix of Comments' step ids — a version that replaces every step of the board gives it another. */
  comments?: string;
  /** Whether Comments has a step running a module with a required input, and a human step deciding its plan. */
  notify?: boolean;
}

/** 1.3, with a Comments board beside Delivery, at this version. */
function twoBoards(version: string, shape: Shape = {}): TemplateVersion {
  const { reply = true, dropIndex = false, everyMinutes, comments: cm = "cm", notify = false } = shape;
  const raw = JSON.parse(JSON.stringify(shipped("1.3").document)) as {
    template: { version: string };
    steps: { id: string; watch?: { everyMinutes: number } }[];
    routes: { fromStepId: string; target: string }[];
    boards?: unknown[];
    modules: unknown[];
  };
  raw.template.version = version;
  if (reply) {
    raw.steps.push(human("dl_reply", 7, "Reply", ["replied"]));
    raw.routes.push(route("dl_reply", "replied", `${cm}_plan`));
  }
  if (dropIndex) {
    raw.steps = raw.steps.filter((step) => step.id !== "repository_index");
    raw.routes = raw.routes.filter((each) => each.fromStepId !== "repository_index").map((each) => (each.target === "repository_index" ? { ...each, target: "todo" } : each));
  }
  if (everyMinutes !== undefined) {
    const watch = raw.steps.find((step) => step.id === "pull_request_watch")!;
    watch.watch = { ...watch.watch!, everyMinutes };
  }
  raw.boards = [
    {
      key: "comments",
      pipeline: { name: "Comments", icon: null, entryStepId: `${cm}_plan`, entryRules: [] },
      steps: [
        human(`${cm}_plan`, 0, "Approve plan", ["approved", "rejected"]),
        human(`${cm}_closed`, 1, "Closed", [], true),
        ...(notify ? [{ ...human(`${cm}_notify`, 2, "Notify", ["sent"]), type: "module", entryAction: "notify" }] : []),
      ],
      routes: [
        route(`${cm}_plan`, "approved", "todo"),
        route(`${cm}_plan`, "rejected", reply ? "dl_reply" : `${cm}_closed`),
        ...(notify ? [route(`${cm}_notify`, "sent", `${cm}_closed`)] : []),
      ],
    },
  ];
  if (notify) {
    raw.modules.push({
      slug: "notify",
      name: "Notify",
      description: "Posts a note to a channel.",
      code: "export default async function run() {\n  return { ok: true, result: 'sent' };\n}",
      manifest: { name: "Notify", description: "Posts a note to a channel.", inputs: { channel: { type: "string", description: "Which channel" } }, results: ["sent"] },
      originalScript: null,
      tests: [],
    });
  }
  const parsed = parseExport(JSON.stringify(raw));
  if (!parsed.ok) throw new Error(parsed.reason);
  return { slug: SOFTWARE, version, notes: `${version} adds the Comments board.`, document: parsed.document as TemplateDocument };
}

function withVersions(...versions: TemplateVersion[]): TemplateHistory {
  return new Map([[SOFTWARE, [...history.get(SOFTWARE)!, ...versions]]]);
}

/** Delivery, its origin recorded and on 1.3. */
function deliveryOn13(): void {
  backfillPipelineOrigins(handle.db, history);
  applyTemplateUpdates(handle.db, history, { isTheRecord: false });
  expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.3");
}

function boardNamed(name: string, db = handle.db) {
  const found = listPipelines(db).find((pipeline) => pipeline.name === name);
  if (found === undefined) throw new Error(`no ${name} board`);
  return found;
}

function routeOf(pipelineId: string, fromStepId: string, resultKey: string, db = handle.db): string | undefined {
  return listRoutesForPipeline(db, pipelineId).find((each) => each.fromStepId === fromStepId && each.resultKey === resultKey)?.target;
}

/** The step a pipeline made from the template holds for one of the template's steps. */
function installed(pipelineId: string, templateStepId: string, db = handle.db): string {
  const id = getPipelineOrigin(db, pipelineId)?.stepIds[templateStepId];
  if (id === undefined) throw new Error(`${pipelineId} holds no ${templateStepId}`);
  return id;
}

describe("the import gate", () => {
  it("accepts a document of two boards routing into each other, and imports both", () => {
    const { document } = twoBoards("1.4");
    expect(document.boards).toHaveLength(1);

    const result = importPipeline(handle.db, { document });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.boardPipelineIds).toHaveLength(1);
    const comments = result.boardPipelineIds[0]!;
    expect(routeOf(result.pipelineId, installed(result.pipelineId, "dl_reply"), "replied")).toBe(installed(comments, "cm_plan"));
    expect(routeOf(comments, installed(comments, "cm_plan"), "approved")).toBe(installed(result.pipelineId, "todo"));
  });

  it("refuses a route whose target is a step none of its boards has, and writes nothing", () => {
    const { document } = twoBoards("1.4");
    const broken = { ...document, boards: [{ ...document.boards[0]!, routes: [route("cm_plan", "approved", "nowhere")].map((each) => ({ ...each, tone: "info" as const })) }] };
    const before = listPipelines(handle.db).length;

    const result = importPipeline(handle.db, { document: broken });

    expect(result).toEqual({ ok: false, reason: expect.stringContaining('"nowhere", which is not a step on any of this document\'s boards') });
    expect(listPipelines(handle.db)).toHaveLength(before);
  });
});

describe("using the template from the gallery", () => {
  function card(document: TemplateDocument): GalleryTemplate {
    return {
      slug: document.template.slug,
      token: tokenFor(document),
      title: document.template.title,
      description: document.template.description,
      version: document.template.version,
      source: "Bundled with EO",
      bundled: true,
      document,
      template: document.template,
    };
  }

  it("creates every board it holds and the routes between them, each remembering which board it is", () => {
    // A project of somebody's own, so the seeded Delivery is not adopted and the template is imported.
    createProject(handle.db, { name: "Elsewhere", keyPrefix: "ELS" });
    const { document } = twoBoards("1.4");

    const used = useTemplate(handle.db, { template: card(document), answers: { keyPrefix: "ACME" }, roleSlots: {} });

    expect(used.ok).toBe(true);
    if (!used.ok) return;
    const boards = listPipelines(handle.db, used.projectId).filter((pipeline) => pipeline.projectId === used.projectId);
    expect(boards.map((pipeline) => pipeline.name).sort()).toEqual(["Comments", "Delivery"].sort());
    const comments = boards.find((pipeline) => pipeline.name === "Comments")!.id;
    expect(routeOf(used.pipelineId, installed(used.pipelineId, "dl_reply"), "replied")).toBe(installed(comments, "cm_plan"));
    expect(routeOf(comments, installed(comments, "cm_plan"), "rejected")).toBe(installed(used.pipelineId, "dl_reply"));
    expect(Object.keys(getPipelineOrigin(handle.db, comments)!.stepIds).sort()).toEqual(["cm_closed", "cm_plan"]);
    expect(Object.keys(getPipelineOrigin(handle.db, used.pipelineId)!.stepIds)).not.toContain("cm_plan");
  });

  it("makes the boards beside a Delivery it adopted rather than imported", () => {
    const { document } = twoBoards("1.3", { reply: false });

    const used = useTemplate(handle.db, { template: card(document), answers: { keyPrefix: "ACME" }, roleSlots: {} });

    expect(used.ok).toBe(true);
    if (!used.ok) return;
    expect(used.pipelineId).toBe("default");
    const comments = boardNamed("Comments");
    expect(comments.projectId).toBe(used.projectId);
    expect(routeOf(comments.id, installed(comments.id, "cm_plan"), "approved")).toBe("todo");
  });

  it("adopts a board an update already made for the unadopted Delivery, rather than making a second", () => {
    deliveryOn13();
    const next = twoBoards("1.4", { reply: false });
    applyTemplateUpdates(handle.db, withVersions(next), { isTheRecord: false });
    const made = boardNamed("Comments");
    expect(made.projectId).toBeNull();

    const used = useTemplate(handle.db, { template: card(next.document), answers: { keyPrefix: "ACME" }, roleSlots: {} });

    expect(used.ok).toBe(true);
    if (!used.ok) return;
    expect(used.pipelineId).toBe("default");
    expect(listPipelines(handle.db).filter((pipeline) => pipeline.name === "Comments").map((pipeline) => [pipeline.id, pipeline.projectId])).toEqual([[made.id, used.projectId]]);
  });
});

describe("setting up a template of several boards from the gallery", () => {
  function card(document: TemplateDocument): GalleryTemplate {
    return {
      slug: document.template.slug,
      token: tokenFor(document),
      title: document.template.title,
      description: document.template.description,
      version: document.template.version,
      source: "Bundled with EO",
      bundled: true,
      document,
      template: document.template,
    };
  }

  it("asks for a module input and an owner on the second board as it does on the first", () => {
    const { document } = twoBoards("1.4", { notify: true });

    expect(galleryBlanks(document)).toContainEqual(expect.objectContaining({ key: "cm_notify.channel", kind: "stepInput", required: true }));
    expect(galleryRoleSlots(document).map((slot) => slot.stepId)).toContain("cm_plan");

    // A required answer on the second board is required.
    const unanswered = useTemplate(handle.db, { template: card(document), answers: { keyPrefix: "ACME" }, roleSlots: {} });
    expect(unanswered).toEqual({ ok: false, reason: expect.stringContaining("Notify · channel") });
  });

  it("writes the second board's step input and its chosen owner onto the steps as imported", () => {
    createProject(handle.db, { name: "Elsewhere", keyPrefix: "ELS" });
    const priya = createPerson(handle.db, { name: "Priya" });
    const { document } = twoBoards("1.4", { notify: true });

    const used = useTemplate(handle.db, { template: card(document), answers: { keyPrefix: "ACME", "cm_notify.channel": "#reviews" }, roleSlots: { cm_plan: priya.id } });

    expect(used).toMatchObject({ ok: true });
    if (!used.ok) return;
    const comments = listPipelines(handle.db, used.projectId).find((pipeline) => pipeline.projectId === used.projectId && pipeline.name === "Comments")!.id;
    expect(installed(comments, "cm_notify")).not.toBe("cm_notify");
    expect(getStep(handle.db, installed(comments, "cm_notify"))?.inputs).toEqual({ channel: "#reviews" });
    expect(getStep(handle.db, installed(comments, "cm_plan"))?.ownerPersonId).toBe(priya.id);
    // And nothing of it landed on Delivery's steps at the same positions.
    expect(listStepsForPipeline(handle.db, used.pipelineId).filter((step) => step.ownerPersonId === priya.id || Object.keys(step.inputs).length > 0)).toEqual([]);
  });

  it("writes them onto a board made beside a Delivery it adopted, where the template's id was taken", () => {
    const priya = createPerson(handle.db, { name: "Priya" });
    const other = createPipeline(handle.db, { projectId: null, name: "Other" });
    createStep(handle.db, { id: "cm_plan", pipelineId: other.id as Uuid, position: 0, name: "Someone else's plan", type: "user" });
    const { document } = twoBoards("1.3", { reply: false, notify: true });

    const used = useTemplate(handle.db, { template: card(document), answers: { keyPrefix: "ACME", "cm_notify.channel": "#reviews" }, roleSlots: { cm_plan: priya.id } });

    expect(used).toMatchObject({ ok: true, pipelineId: "default" });
    const comments = boardNamed("Comments").id;
    const plan = installed(comments, "cm_plan");
    expect(plan).not.toBe("cm_plan");
    expect(getStep(handle.db, plan)?.ownerPersonId).toBe(priya.id);
    expect(getStep(handle.db, installed(comments, "cm_notify"))?.inputs).toEqual({ channel: "#reviews" });
    expect(getStep(handle.db, "cm_plan")?.ownerPersonId).toBeNull();
  });
});

describe("a new version that adds a board", () => {
  it("makes the board, applies the update that routes into it, and points the board's routes at the steps that update added", () => {
    deliveryOn13();

    const results = applyTemplateUpdates(handle.db, withVersions(twoBoards("1.4")), { isTheRecord: false });

    expect(results).toEqual([expect.objectContaining({ pipelineId: "default", outcome: "applied", to: "1.4" })]);
    const comments = boardNamed("Comments");
    expect(getPipelineOrigin(handle.db, comments.id)).toMatchObject({ slug: SOFTWARE, version: "1.4" });
    expect(routeOf("default", "dl_reply", "replied")).toBe("cm_plan");
    expect(routeOf(comments.id, "cm_plan", "approved")).toBe("todo");
    expect(routeOf(comments.id, "cm_plan", "rejected")).toBe("dl_reply");
    // The update names the board it made, in the notes its version keeps.
    expect(listPipelineVersions(handle.db, "default").at(-1)?.releaseNotes).toContain("Created the Comments board this version adds.");
    // Made once: a later launch finds it.
    applyTemplateUpdates(handle.db, withVersions(twoBoards("1.4")), { isTheRecord: false });
    expect(listPipelines(handle.db).filter((pipeline) => pipeline.name === "Comments")).toHaveLength(1);
  });

  it("routes into a step renamed because another pipeline holds the template's id", () => {
    deliveryOn13();
    const other = createPipeline(handle.db, { projectId: null, name: "Other" });
    createStep(handle.db, { id: "cm_plan", pipelineId: other.id as Uuid, position: 0, name: "Someone else's plan", type: "user" });

    applyTemplateUpdates(handle.db, withVersions(twoBoards("1.4")), { isTheRecord: false });

    const comments = boardNamed("Comments");
    const plan = installed(comments.id, "cm_plan");
    expect(plan).not.toBe("cm_plan");
    expect(listStepsForPipeline(handle.db, comments.id).map((step) => step.id)).toContain(plan);
    expect(routeOf("default", "dl_reply", "replied")).toBe(plan);
    expect(routeOf(comments.id, plan, "rejected")).toBe("dl_reply");
    // Nothing of the other pipeline's was touched.
    expect(listStepsForPipeline(handle.db, other.id).map((step) => step.id)).toEqual(["cm_plan"]);
  });

  it("leaves the routes into a board from the template's other boards where they were when that board is updated", () => {
    deliveryOn13();
    applyTemplateUpdates(handle.db, withVersions(twoBoards("1.4")), { isTheRecord: false });
    const comments = boardNamed("Comments");
    const before = listRoutesForPipeline(handle.db, comments.id);

    const results = applyTemplateUpdates(handle.db, withVersions(twoBoards("1.4"), twoBoards("1.5", { everyMinutes: 10 })), { isTheRecord: false });

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pipelineId: "default", outcome: "applied", to: "1.5" }),
        expect.objectContaining({ pipelineId: comments.id, outcome: "caught-up", to: "1.5" }),
      ]),
    );
    expect(listStepsForPipeline(handle.db, "default").find((step) => step.id === "pull_request_watch")?.watch?.everyMinutes).toBe(10);
    expect(listRoutesForPipeline(handle.db, comments.id)).toEqual(before);
    expect(routeOf("default", "dl_reply", "replied")).toBe("cm_plan");
    expect(openUpdateConflict(handle.db, comments.id)).toBeUndefined();
  });
});

describe("a board whose every step a new version replaces", () => {
  it("is compared with the same board of the new version, by its key, never with Delivery", () => {
    deliveryOn13();
    applyTemplateUpdates(handle.db, withVersions(twoBoards("1.4", { reply: false })), { isTheRecord: false });
    const comments = boardNamed("Comments").id;
    const deliveryBefore = listStepsForPipeline(handle.db, "default").map((step) => step.id);

    const results = applyTemplateUpdates(handle.db, withVersions(twoBoards("1.4", { reply: false }), twoBoards("1.5", { reply: false, comments: "cx" })), { isTheRecord: false });

    expect(results).toContainEqual(expect.objectContaining({ pipelineId: comments, outcome: "applied", to: "1.5" }));
    expect(listStepsForPipeline(handle.db, comments).map((step) => step.id).sort()).toEqual(["cx_closed", "cx_plan"]);
    expect(Object.keys(getPipelineOrigin(handle.db, comments)!.stepIds).sort()).toEqual(["cx_closed", "cx_plan"]);
    expect(listStepsForPipeline(handle.db, "default").map((step) => step.id)).toEqual(deliveryBefore);
    expect(routeOf(comments, "cx_plan", "approved")).toBe("todo");
    // And on the next version it is still Comments, known by its new steps' base.
    const again = applyTemplateUpdates(
      handle.db,
      withVersions(twoBoards("1.4", { reply: false }), twoBoards("1.5", { reply: false, comments: "cx" }), twoBoards("1.6", { reply: false, comments: "cy" })),
      { isTheRecord: false },
    );
    expect(again).toContainEqual(expect.objectContaining({ pipelineId: comments, outcome: "applied", to: "1.6" }));
    expect(listStepsForPipeline(handle.db, comments).map((step) => step.id).sort()).toEqual(["cy_closed", "cy_plan"]);
  });
});

describe("a new version that adds a board, where the update to Delivery is held", () => {
  /** 1.4 also drops Index, and an item on Index holds Delivery's update. Comments' plan step is renamed: another pipeline holds `cm_plan`. */
  function heldAt14(): { comments: string; plan: string } {
    deliveryOn13();
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    createTestItem(handle.db, { type: "story", title: "Indexing", stepId: "repository_index", projectId: project.id as Uuid });
    const other = createPipeline(handle.db, { projectId: null, name: "Other" });
    createStep(handle.db, { id: "cm_plan", pipelineId: other.id as Uuid, position: 0, name: "Someone else's plan", type: "user" });

    const results = applyTemplateUpdates(handle.db, withVersions(twoBoards("1.4", { dropIndex: true })), { isTheRecord: false });

    expect(results).toEqual([expect.objectContaining({ pipelineId: "default", outcome: "conflict", to: "1.4" })]);
    const comments = boardNamed("Comments").id;
    return { comments, plan: installed(comments, "cm_plan") };
  }

  it("still makes the board, its route into a step Delivery has going there, and its route into the step the held update adds waiting for a person", () => {
    const { comments, plan } = heldAt14();

    expect(listStepsForPipeline(handle.db, "default").map((step) => step.id)).not.toContain("dl_reply");
    expect(routeOf(comments, plan, "approved")).toBe("todo");
    expect(routeOf(comments, plan, "rejected")).toBe(USER_ATTENTION_TARGET);
    expect(getPipelineOrigin(handle.db, comments)?.version).toBe("1.4");
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.3");
  });

  it("names the board it made, and the route waiting on the update, in the notice", () => {
    heldAt14();

    const [notice] = messagesFrom(handle.db, "template_conflict");
    expect(notice?.body).toContain("EO created the **Comments** board");
    expect(notice?.body).toContain("Its 'rejected' route waits for a person until this update is resolved");
  });

  it("lists the steps of the template's other boards the update routes into, by their installed ids", () => {
    const { comments, plan } = heldAt14();

    const answer = describeUpdateConflict(handle.db, "default");

    expect(answer.conflict?.linkedSteps).toEqual([{ id: plan, name: "Approve plan", templateStepId: "cm_plan", pipelineId: comments, pipelineName: "Comments" }]);
    // And the held version's route into that board, in the template's graph, already reads that id.
    expect(answer.conflict?.template.routes.find((each) => each.fromStepId === "dl_reply" && each.resultKey === "replied")?.target).toBe(plan);
  });
  it("points the waiting route at the step the resolved update adds, by the id the person's draft gave it, on a later launch", () => {
    const { comments, plan } = heldAt14();
    // A later launch: nothing the first one knew is held anywhere but the database.
    applyTemplateUpdates(handle.db, withVersions(twoBoards("1.4", { dropIndex: true })), { isTheRecord: false });
    expect(routeOf(comments, plan, "rejected")).toBe(USER_ATTENTION_TARGET);

    // The person's draft adds the reply step under an id of its own, and routes it into Comments' plan.
    createStep(handle.db, { id: "my_reply", pipelineId: "default" as Uuid, position: 40, name: "Reply on the pull request", type: "user" });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "my_reply", resultKey: "replied", label: "replied", target: plan });
    const conflict = openUpdateConflict(handle.db, "default")!;

    expect(resolveHeldUpdate(handle.db, conflict, "published", { templateStepIds: { dl_reply: "my_reply" } })).toEqual({ ok: true });

    expect(routeOf(comments, plan, "rejected")).toBe("my_reply");
    expect(routeOf(comments, plan, "approved")).toBe("todo");
    expect(listPipelineVersions(handle.db, comments).at(-1)?.releaseNotes).toContain("Pointed the routes that waited for Delivery");
    expect(getPipelineOrigin(handle.db, "default")?.stepIds.dl_reply).toBe("my_reply");
    // The board's next comparison reads the route as the template's, not as the person's change.
    applyTemplateUpdates(handle.db, withVersions(twoBoards("1.4", { dropIndex: true })), { isTheRecord: false });
    expect(routeOf(comments, plan, "rejected")).toBe("my_reply");
  });

  it("leaves the route with a person where the update is resolved by keeping Delivery as it is", () => {
    const { comments, plan } = heldAt14();

    expect(resolveHeldUpdate(handle.db, openUpdateConflict(handle.db, "default")!, "kept")).toEqual({ ok: true });

    expect(routeOf(comments, plan, "rejected")).toBe(USER_ATTENTION_TARGET);
  });

  it("leaves a waiting route somebody pointed elsewhere meanwhile where they pointed it", () => {
    const { comments, plan } = heldAt14();
    const closed = installed(comments, "cm_closed");
    const steps = listStepsForPipeline(handle.db, comments).map(({ ownerPersonId: _person, ownerGroupId: _group, ...step }) => step);
    const routes = listRoutesForPipeline(handle.db, comments).map(({ id: _id, ...each }) => (each.resultKey === "rejected" ? { ...each, target: closed } : each));
    replacePipelineGraph(handle.db, comments, steps, routes);
    createStep(handle.db, { id: "my_reply", pipelineId: "default" as Uuid, position: 40, name: "Reply", type: "user" });

    resolveHeldUpdate(handle.db, openUpdateConflict(handle.db, "default")!, "published", { templateStepIds: { dl_reply: "my_reply" } });

    expect(routeOf(comments, plan, "rejected")).toBe(closed);
  });
});

describe("exporting a board that routes into another board of its template", () => {
  it("carries that board, and imports on another installation without being refused", () => {
    deliveryOn13();
    applyTemplateUpdates(handle.db, withVersions(twoBoards("1.4")), { isTheRecord: false });

    const built = exportPipeline(handle.db, "default");
    if (!built.ok) throw new Error(built.reason);
    expect(built.document.boards.map((board) => board.pipeline.name)).toEqual(["Comments"]);
    expect(built.document.routes.find((each) => each.fromStepId === "dl_reply")?.target).toBe("cm_plan");

    const parsed = parseExport(JSON.stringify(built.document));
    if (!parsed.ok) throw new Error(parsed.reason);
    const target = openMigratedTestDb();
    try {
      const imported = importPipeline(target.db, { document: parsed.document });
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;
      const [comments] = imported.boardPipelineIds;
      const plan = listStepsForPipeline(target.db, comments!).find((step) => step.name === "Approve plan")!.id;
      const reply = listStepsForPipeline(target.db, imported.pipelineId).find((step) => step.name === "Reply")!.id;
      expect(routeOf(imported.pipelineId, reply, "replied", target.db)).toBe(plan);
      expect(routeOf(comments!, plan, "rejected", target.db)).toBe(reply);
    } finally {
      target.close();
    }
  });
});
