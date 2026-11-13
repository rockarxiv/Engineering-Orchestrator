import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PIPELINE_ID,
  adminToolsEnabled,
  pageDescriptorFor,
  pipelineChangesPath,
  uuidv7,
  type IpcPayload,
  type PipelineStep,
  type PipelineStepView,
  type Uuid,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  addDependency,
  archiveAgent,
  createPipeline,
  createRun,
  createStep,
  listPipelineVersions,
  markDiverged,
  setEntryStep,
  deleteItem,
  getItem,
  postComment,
  setItemArchived,
  setItemHeld,
  updateItem,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { TOOLS } from "../mcpHost/catalog.js";
import { toolsFor } from "../mcpHost/gate.js";
import { fireJob } from "../jobs/fire.js";
import { createJob } from "../jobs/jobs.js";
import { assistAgent } from "../roles/assist.js";
import { clearPublishedView, publishView, readCurrentView } from "./currentView.js";
import { moveItem } from "./domainCommands.js";
import { handleIpcRequest } from "./handleRequest.js";
import { deletePipelineCommand } from "./pipelineCommands.js";
import { savePipeline } from "./configCommands.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "./registry.js";

/**
 * Reading the screen, live (EO-192).
 *
 * Two things are being proved here and they are not the same. The first
 * is that the answer is EO's: the renderer sends a route, its
 * parameters and how it has the screen set up, and every fact that comes
 * back was looked up against the database. The second is the one the
 * story exists for — that it is read *when asked*, so calling twice
 * across a navigation describes two screens with nothing dispatched in
 * between. A preloaded section could satisfy the first and could never
 * satisfy the second.
 */
let handle: DbHandle;

const opts = { exposeErrorDetails: true };

/** A window is open unless a case says otherwise. */
const LOOKING = { hasWindow: () => true };

let registered = false;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  clearPublishedView();
  clearHandlerRegistry();
  registered = false;
  handle.close();
});

/** What the renderer sends: a route and its parameters, and nothing it looked up. */
function publish(path: string, parameters: Partial<Omit<IpcPayload<"view:publish">, "page">> = {}) {
  return publishView({
    page: pageDescriptorFor(path),
    filter: null,
    selection: [],
    sort: null,
    unsavedEdits: [],
    ...parameters,
  });
}

function current() {
  return readCurrentView(handle.db, LOOKING);
}

/** What the agent actually reads — the rendered text, not the object behind it. */
async function asTheAgentReadsIt(): Promise<string> {
  // Registered once per case: `registerHandler` refuses a second
  // registration for one channel, which is what keeps the real app from
  // growing two answers to the same question.
  if (!registered) {
    registerHandler("view:current", () => readCurrentView(handle.db, LOOKING), opts);
    registered = true;
  }
  const tool = TOOLS.find((candidate) => candidate.name === "view_current")!;
  const outcome = await tool.run(dispatchIpc, {});
  expect(outcome.ok).toBe(true);
  return outcome.ok ? outcome.text : "";
}

describe("the view the renderer publishes", () => {
  it("is replaced rather than merged, so a screen with no filter reports none", () => {
    publish("/items", { filter: { text: "rate", facets: {} }, sort: "updated:desc" });
    expect(current().view?.parameters.filter?.text).toBe("rate");

    publish("/settings");
    expect(current().view?.parameters.filter).toBeNull();
    expect(current().view?.parameters.sort).toBeNull();
  });

  it("is validated at the IPC boundary, and a value that is not a descriptor is refused", async () => {
    const malformed = await handleIpcRequest("view:publish", { page: { route: 7 } }, (payload) => publishView(payload), opts);

    expect(malformed.ok).toBe(false);
  });

  /**
   * The window going away takes what it was showing with it (EO-192).
   *
   * On macOS closing the window leaves the app running, so reopening it
   * makes `hasWindow()` true again while the new renderer has not
   * published yet. Without this the tool would describe the *previous*
   * window's screen as though somebody were looking at it — the exact
   * staleness this feature was built to end, arriving through the one
   * door that is not a navigation.
   *
   * `main/platform/electron.ts` calls `clearPublishedView` from the
   * window's own `closed` handler, beside the push bridge it already
   * stops there.
   */
  it("is forgotten when the window that was showing it closes", () => {
    publish("/settings");
    expect(readCurrentView(handle.db, { hasWindow: () => true }).view).not.toBeNull();

    // What `closed` does.
    clearPublishedView();

    // A window exists again — reopened, its renderer not yet mounted.
    const reopened = readCurrentView(handle.db, { hasWindow: () => true });
    expect(reopened.view).toBeNull();
    expect(reopened.absence).toContain("has not said");
  });

  it("is cleared by the close handler of each window that publishes one, and never by the debug window's", () => {
    // The reason the case above is worth anything: production really
    // calls it. Read from the source rather than mocked, because what is
    // being claimed is that the wiring exists — and it was missing.
    // The window moved to `platform/electron.ts` in EO-318, with
    // index.ts left as the Electron entry point: same handler, same
    // line, a different file to read it out of.
    //
    // The main window clears. So does the canvas popped out into its own
    // window (EO-383), because it *is* a screen about something: while
    // it is out it is the window that publishes, so what it said has to
    // go with it — otherwise `view_current` describes a window nobody
    // has until the main one speaks again. The debug window (EO-392)
    // must not: it publishes nothing, and a window that cleared the
    // snapshot on its way out would blank the agent's account of the
    // screen every time somebody shut it. The behaviour is proved in
    // `platform/windows.test.ts`, against a fake Electron; this is the
    // structural half, here beside the module the call is about.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "platform", "electron.ts"), "utf8");
    const main = source.slice(source.indexOf("function createWindow("), source.indexOf("function createCanvasWindow("));
    const canvas = source.slice(source.indexOf("function createCanvasWindow("), source.indexOf("function createDebugWindow("));
    const debug = source.slice(source.indexOf("function createDebugWindow("), source.indexOf("function readBounds("));

    for (const window of [main, canvas, debug]) expect(window).not.toBe("");
    expect(main).toContain('window.on("closed"');
    expect(main).toContain("clearPublishedView()");
    expect(canvas).toContain('window.on("closed"');
    expect(canvas).toContain("clearPublishedView()");
    expect(debug).toContain('window.on("closed"');
    expect(debug).not.toContain("clearPublishedView(");
    // And exactly those two calls in the whole file — one per window
    // that publishes — so another window added later cannot quietly
    // acquire one.
    expect(source.match(/clearPublishedView\(\)/g)).toHaveLength(2);
  });

  it("is nowhere in the database — it is one object in memory", () => {
    publish("/settings");
    // Nothing was written, so nothing survives forgetting it. A table
    // would be a screen that can be read back after it stopped being
    // true, which is the defect this feature removes rather than moves.
    clearPublishedView();

    expect(current().view).toBeNull();
  });
});

describe("when there is no view", () => {
  it("says so rather than inventing one, when no window is open", () => {
    publish("/settings");

    const answer = readCurrentView(handle.db, { hasWindow: () => false });

    expect(answer.view).toBeNull();
    expect(answer.absence).toContain("no window");
  });

  it("says so when the window has not published anything yet", () => {
    expect(current().view).toBeNull();
    expect(current().absence).toContain("has not said");
  });

  it("says so on a route nobody listed, naming the route", () => {
    publish("/somewhere-new");

    expect(current().view).toBeNull();
    expect(current().absence).toContain("/somewhere-new");
  });

  it("says so once the item the screen names has been deleted", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
    publish(`/items/${item.id}`);
    expect(current().view).not.toBeNull();

    deleteItem(handle.db, item.id);

    expect(current().view).toBeNull();
    expect(current().absence).toContain("not there any more");
  });

  it("says so once the pipeline the board shows has been deleted", async () => {
    publish("/pipelines/default");
    expect(current().view).not.toBeNull();

    // Through the real command: deleting a pipeline archives it, and
    // `getPipeline` answers with archived rows on purpose.
    registerHandler("pipelines:delete", (payload) => deletePipelineCommand(handle.db, payload), opts);
    expect((await dispatchIpc("pipelines:delete", { id: "default" })).ok).toBe(true);

    expect(current().view).toBeNull();
  });

  it("tells the agent to ask rather than guess", async () => {
    publish("/somewhere-new");

    const text = await asTheAgentReadsIt();

    expect(text).toContain("There is no view to describe");
    expect(text).toContain("Do not guess");
  });
});

describe("an item's screen", () => {
  it("names the item, its step and where each result sends it — all from the database", () => {
    const dependency = createTestItem(handle.db, { type: "story", title: "The assist room", stepId: "todo" });
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
    addDependency(handle.db, item.id, dependency.id);

    // Only the route and its parameter were sent. Everything asserted
    // below is therefore something EO looked up.
    publish(`/items/${item.id}`);
    const showing = current().view?.showing;

    expect(showing?.kind).toBe("item");
    if (showing?.kind !== "item") throw new Error("expected a ticket");
    expect(showing.item.key).toBe(item.key);
    expect(showing.item.title).toBe("Add rate limiting");
    expect(showing.item.step?.name).toBe("To Do");
    expect(showing.item.step?.results.map((result) => result.targetName)).toContain("Review");
    expect(showing.item.dependencies.map((dep) => dep.key)).toEqual([dependency.key]);
  });

  it("says which row a pronoun lands on, in the text the agent reads", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
    publish(`/items/${item.id}`);

    const text = await asTheAgentReadsIt();

    expect(text).toContain(`"this ticket", "it" and "here" mean **${item.key}**`);
    expect(text).toContain(item.id);
  });

  it("names the Reference its work is filed under, and the feature it is inherited from (EO-637)", async () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null });
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo", parentId: feature.id });
    updateItem(handle.db, feature.id, { git: { reference: "PROJ-123" } });
    publish(`/items/${item.id}`);

    const showing = current().view?.showing;
    if (showing?.kind !== "item") throw new Error("expected an item");
    expect(showing.item.reference).toEqual({ value: "PROJ-123", inheritedFrom: feature.key });
    expect(await asTheAgentReadsIt()).toContain(`- Reference: \`PROJ-123\` (inherited from ${feature.key})`);
  });

  it("names the pull request reviewers its work asks, and the feature they are inherited from (EO-742)", async () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null });
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo", parentId: feature.id });
    updateItem(handle.db, feature.id, { git: { reviewers: ["dave"] } });
    publish(`/items/${item.id}`);

    const showing = current().view?.showing;
    if (showing?.kind !== "item") throw new Error("expected an item");
    expect(showing.item.reviewers).toEqual({ value: ["dave"], inheritedFrom: feature.key });
    expect(await asTheAgentReadsIt()).toContain(`- Pull request reviewers: dave (inherited from ${feature.key})`);
  });
});

describe("a pipeline's screen", () => {
  function holdingOnTodo() {
    const showing = current().view?.showing;
    if (showing?.kind !== "pipeline") throw new Error("expected a pipeline");
    return showing.pipeline.steps.find((step) => step.id === "todo")?.holding;
  }

  it("names the steps, what each is holding, and the routes between them", async () => {
    const idle = createTestItem(handle.db, { type: "story", title: "Idle", stepId: "todo" });
    const busy = createTestItem(handle.db, { type: "story", title: "Busy", stepId: "todo" });
    createRun(handle.db, { itemId: busy.id, agentId: null, action: "implement", status: "running" });
    expect(idle.id).not.toBe(busy.id);

    publish("/pipelines/default");
    const showing = current().view?.showing;

    expect(showing?.kind).toBe("pipeline");
    if (showing?.kind !== "pipeline") throw new Error("expected a pipeline");
    const todo = showing.pipeline.steps.find((step) => step.id === "todo");
    expect(todo?.holding).toBe(2);
    expect(todo?.running).toBe(1);

    const text = await asTheAgentReadsIt();
    // The edges, not just the columns: "add a QA step after Review" is a
    // question about what leaves Review, which a list of names cannot
    // answer.
    expect(text).toContain("Its routes");
    expect(text).toMatch(/\*\*Review\*\* \(`review`\) \/ `approved`/);
  });

  /**
   * `/project` is the board the app launches on and its address names no
   * pipeline (EO-191). The id is implied by the route table rather than
   * carried in the path, and this file asks the shared answer for it —
   * so the screen somebody is most likely to be standing on resolves to
   * the board they are looking at rather than to nothing.
   */
  it("resolves the board the app opens on, whose address names no pipeline", () => {
    publish("/project");

    const showing = current().view?.showing;
    expect(showing?.kind).toBe("pipeline");
    if (showing?.kind !== "pipeline") throw new Error("expected a pipeline");
    expect(showing.pipeline.id).toBe(DEFAULT_PIPELINE_ID);
  });

  /**
   * A held item is not in a column (EO-44).
   *
   * The board lifts it out and into the paused rail, so a step reported
   * as holding it names a card that is not there — and "move everything
   * out of To Do" would then be asked about an item somebody
   * deliberately parked. Dropping it from the answer altogether would be
   * the other half-truth, so it is counted where the screen puts it.
   */
  it("keeps a held item out of its column and reports the rail it is in instead", async () => {
    const held = createTestItem(handle.db, { type: "story", title: "Parked by hand", stepId: "todo" });
    createTestItem(handle.db, { type: "story", title: "Still moving", stepId: "todo" });

    publish("/pipelines/default");
    expect(holdingOnTodo()).toBe(2);

    setItemHeld(handle.db, held.id, Date.now());

    expect(holdingOnTodo()).toBe(1);
    const showing = current().view?.showing;
    if (showing?.kind !== "pipeline") throw new Error("expected a pipeline");
    expect(showing.pipeline.paused).toBe(1);

    const text = await asTheAgentReadsIt();
    expect(text).toContain("a rail holds **1** card that is not in any of them");
  });

  it("keeps a held item out of the work-in-progress count too, even mid-run", () => {
    // Holding an item does not stop a run that is already going, so
    // this is the case where the two counts could disagree: the card is
    // in the rail, and a column reporting it as being worked would name
    // work standing on a step it is not standing on.
    const held = createTestItem(handle.db, { type: "story", title: "Parked by hand", stepId: "todo" });
    createRun(handle.db, { itemId: held.id, agentId: null, action: "implement", status: "running" });
    setItemHeld(handle.db, held.id, Date.now());

    publish("/pipelines/default");
    const showing = current().view?.showing;
    if (showing?.kind !== "pipeline") throw new Error("expected a pipeline");

    const todo = showing.pipeline.steps.find((step) => step.id === "todo");
    expect(todo?.holding).toBe(0);
    expect(todo?.running).toBe(0);
    expect(showing.pipeline.paused).toBe(1);
  });

  it("counts an agent's parked question in the rail as well, which is what the screen shows there", () => {
    const asking = createTestItem(handle.db, { type: "story", title: "Waiting on an answer", stepId: "todo" });
    createRun(handle.db, { itemId: asking.id, agentId: null, action: "implement", status: "awaiting_input" });

    publish("/pipelines/default");
    const showing = current().view?.showing;
    if (showing?.kind !== "pipeline") throw new Error("expected a pipeline");

    // Not held, so it stays in its column — the board draws it in both
    // places — and it is in the rail too.
    expect(showing.pipeline.steps.find((step) => step.id === "todo")?.holding).toBe(1);
    expect(showing.pipeline.paused).toBe(1);
  });

  it("narrows the rail by the board's search, like everything else on it", () => {
    const held = createTestItem(handle.db, { type: "story", title: "Parked by hand", stepId: "todo" });
    setItemHeld(handle.db, held.id, Date.now());

    publish("/pipelines/default", { filter: { text: "parked", facets: {} } });
    const shown = current().view?.showing;
    if (shown?.kind !== "pipeline") throw new Error("expected a pipeline");
    expect(shown.pipeline.paused).toBe(1);

    publish("/pipelines/default", { filter: { text: "something else", facets: {} } });
    const hidden = current().view?.showing;
    if (hidden?.kind !== "pipeline") throw new Error("expected a pipeline");
    expect(hidden.pipeline.paused).toBe(0);
  });

  it("counts work in progress as a subset of what is here, whatever a mid-run archive does", () => {
    const archived = createTestItem(handle.db, { type: "story", title: "Put away", stepId: "todo" });
    createRun(handle.db, { itemId: archived.id, agentId: null, action: "implement", status: "running" });
    setItemArchived(handle.db, archived.id, Date.now());

    publish("/pipelines/default");
    const showing = current().view?.showing;
    if (showing?.kind !== "pipeline") throw new Error("expected a pipeline");

    const todo = showing.pipeline.steps.find((step) => step.id === "todo");
    expect(todo?.holding).toBe(0);
    expect(todo?.running).toBe(0);
  });
});

/** One labelled fact off each resolved row, for a case that is about that fact. */
function factOf(rows: { facts: { label: string; value: string }[] }[], label: string): string[] {
  return rows.map((row) => row.facts.find((fact) => fact.label === label)?.value ?? "");
}

/**
 * The board's search box, which narrows more than a list (EO-192).
 *
 * What a step is *holding* is a count, and a count over the whole
 * pipeline while the board draws one card contradicts what the person
 * can see. "Move everything out of Review" against the wrong four
 * items is not a mistake anybody notices in time.
 */
describe("a narrowed pipeline board", () => {
  function twoCards() {
    createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
    createTestItem(handle.db, { type: "story", title: "Rename the sidebar", stepId: "todo" });
  }

  function holdingOnTodo() {
    const showing = current().view?.showing;
    if (showing?.kind !== "pipeline") throw new Error("expected a pipeline");
    return showing.pipeline.steps.find((step) => step.id === "todo")?.holding;
  }

  it("counts the cards the board is showing, not everything on the pipeline", () => {
    twoCards();

    publish("/pipelines/default", { filter: { text: "", facets: {} } });
    expect(holdingOnTodo()).toBe(2);

    publish("/pipelines/default", { filter: { text: "rate", facets: {} } });
    expect(holdingOnTodo()).toBe(1);
  });

  it("matches the key as well as the title, because that is what the cards show", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
    createTestItem(handle.db, { type: "story", title: "Rename the sidebar", stepId: "todo" });

    publish("/pipelines/default", { filter: { text: item.key, facets: {} } });

    expect(holdingOnTodo()).toBe(1);
  });

  it("counts work in progress against the narrowed board too", () => {
    const busy = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
    createRun(handle.db, { itemId: busy.id, agentId: null, action: "implement", status: "running" });

    publish("/pipelines/default", { filter: { text: "sidebar", facets: {} } });
    const showing = current().view?.showing;
    if (showing?.kind !== "pipeline") throw new Error("expected a pipeline");

    // The running item is not on the narrowed board, so it is not
    // being counted as work standing on that column.
    expect(showing.pipeline.steps.find((step) => step.id === "todo")?.running).toBe(0);
  });

  it("says the counts are of a narrowed board, so nobody reads them as the pipeline's", async () => {
    twoCards();
    publish("/pipelines/default", { filter: { text: "rate", facets: {} } });

    const text = await asTheAgentReadsIt();

    expect(text).toContain("The board is narrowed by the search below");
    // And not the sentence for a screen EO could not list: the board's
    // columns *are* its list, and they were resolved above.
    expect(text).not.toContain("does not resolve the rows of this screen's list");

    publish("/pipelines/default", { filter: { text: "", facets: {} } });
    expect(await asTheAgentReadsIt()).not.toContain("The board is narrowed");
  });
});

/**
 * Keep checking on the board (EO-571): the column head says how often a
 * step checks and when it gives up, so a description of the board says
 * it too — and of a step that never gives up, that it never does.
 */
describe("a pipeline's steps that keep checking, as view_current says them", () => {
  it("says a step never gives up instead of a time, and nothing on a step that runs once", async () => {
    handle.db.run(sql`UPDATE pipeline_steps SET watch_never_gives_up = 1 WHERE id = 'pull_request_watch'`);
    publish("/pipelines/default", { filter: { text: "", facets: {} } });

    const showing = current().view?.showing;
    if (showing?.kind !== "pipeline") throw new Error("expected a pipeline");
    expect(showing.pipeline.steps.find((step) => step.id === "pull_request_watch")?.keepsChecking).toBe("Checks every 5 minutes · never gives up");
    expect(showing.pipeline.steps.find((step) => step.id === "todo")?.keepsChecking).toBeNull();

    const text = await asTheAgentReadsIt();
    const line = text.split("\n").find((candidate) => candidate.startsWith("- `pull_request_watch`"));
    expect(line).toContain("· checks every 5 minutes · never gives up");
    expect(text).not.toContain("gives up after");
    expect(text.split("\n").find((candidate) => candidate.startsWith("- `todo`"))).not.toContain("checks every");
  });

  it("says the time a step that gives up gives up after, as before", async () => {
    publish("/pipelines/default", { filter: { text: "", facets: {} } });

    expect((await asTheAgentReadsIt()).split("\n").find((candidate) => candidate.startsWith("- `pull_request_watch`"))).toContain(
      "· checks every 5 minutes · gives up after 7 days",
    );
  });
});

/**
 * The same board, narrowed to one job (EO-308, ARCHITECTURE.md, "The inbox, the archive and jobs").
 *
 * The board draws `ItemSummary` rows, which carry what filed each item;
 * this side counts raw `items` rows, which do not. Both hand the same
 * predicate from `@eo/core` the same filter — and for as long as this
 * side did not resolve the provenance first, `matchesBoardQuery` saw no
 * `origin` on any row and rejected every one of them. An agent asked
 * what the board was showing was told every column and the paused rail
 * were empty while the person looked at three cards, which is worse
 * than not answering: it is a confident wrong answer about what is on
 * screen, and "move everything out of To Do" is the next sentence.
 */
describe("a board narrowed to one job", () => {
  /** Two items the job filed, one it did not, and the id to narrow by. */
  function aJobAndItsWork() {
    const created = createJob(handle.db, {
      projectId: null,
      name: "Monday report",
      trigger: { kind: "manual" },
      pipelineId: DEFAULT_PIPELINE_ID,
      template: { type: "developer:story", title: "Monday report", body: null },
    });
    if (!created.ok) throw new Error(created.problem);
    const first = fireJob(handle.db, created.job).item!;
    const second = fireJob(handle.db, created.job).item!;
    // Filed by a person, on the same step, so the only thing separating
    // it from the two above is what the facet asks about.
    const typed = createTestItem(handle.db, { type: "story", title: "Typed by hand", stepId: first.stepId });
    return { jobId: created.job.id, first, second, typed };
  }

  function holdingOn(stepId: string) {
    const showing = current().view?.showing;
    if (showing?.kind !== "pipeline") throw new Error("expected a pipeline");
    return showing.pipeline.steps.find((step) => step.id === stepId)?.holding;
  }

  it("counts the job's cards, and not the one somebody typed beside them", () => {
    const { jobId, first } = aJobAndItsWork();
    const step = first.stepId!;

    publish(`/pipelines/${DEFAULT_PIPELINE_ID}`, { filter: { text: "", facets: {} } });
    expect(holdingOn(step)).toBe(3);

    publish(`/pipelines/${DEFAULT_PIPELINE_ID}`, { filter: { text: "", facets: { job: jobId } } });
    expect(holdingOn(step)).toBe(2);
  });

  it("counts nothing for a job that has filed nothing on this board", () => {
    const { first } = aJobAndItsWork();

    publish(`/pipelines/${DEFAULT_PIPELINE_ID}`, { filter: { text: "", facets: { job: "01a0a0af-0000-7000-8000-000000000000" } } });

    // The column is still there and still described; it is holding
    // nothing, which is a different sentence from "there is no column".
    expect(holdingOn(first.stepId!)).toBe(0);
  });

  it("narrows the work in progress and the paused rail by the job too", () => {
    const { jobId, first, typed } = aJobAndItsWork();
    createRun(handle.db, { itemId: first.id, agentId: null, action: "implement", status: "running" });
    // Parked by hand, so the board lifts it out of its column and into
    // the rail — which is part of this screen and has to be narrowed by
    // the same facet.
    setItemHeld(handle.db, typed.id, Date.now());

    publish(`/pipelines/${DEFAULT_PIPELINE_ID}`, { filter: { text: "", facets: { job: jobId } } });
    const showing = current().view?.showing;
    if (showing?.kind !== "pipeline") throw new Error("expected a pipeline");

    expect(showing.pipeline.steps.find((step) => step.id === first.stepId)?.running).toBe(1);
    // The held card is the one a person typed, so the job's board has an
    // empty rail rather than somebody else's card in it.
    expect(showing.pipeline.paused).toBe(0);
  });

  it("keeps the search box narrowing inside the job's own cards", () => {
    const { jobId, first } = aJobAndItsWork();

    publish(`/pipelines/${DEFAULT_PIPELINE_ID}`, { filter: { text: "nothing like this", facets: { job: jobId } } });

    expect(holdingOn(first.stepId!)).toBe(0);
  });
});

/**
 * The screens whose only view parameter is which tab or section is open.
 *
 * Each decides what is drawn, so each has to reach the snapshot — and
 * where EO cannot resolve the rows behind one, the reply says so rather
 * than letting an absent list read as an empty screen.
 */
describe("a screen with tabs", () => {
  it("resolves the archive's items tab to the work that has been put away", () => {
    const archived = createTestItem(handle.db, { type: "story", title: "Old work", stepId: "todo" });
    setItemArchived(handle.db, archived.id, Date.now());
    createTestItem(handle.db, { type: "story", title: "Live work", stepId: "todo" });

    publish("/archive", { filter: { text: "", facets: { tab: "items" } } });
    const matching = current().view?.matching;

    expect(matching?.of).toBe("items");
    expect(matching?.rows.map((row) => row.name)).toEqual([archived.key]);
  });

  /**
   * The archive narrowed to one step (EO-230) — where the configure
   * screen sends somebody to restore what a step still holds there. The
   * screen applies `matchesArchiveFilter`; so does this, or the agent is
   * told about rows the person cannot see.
   */
  it("narrows the archive to the step it was opened for", () => {
    const onTodo = createTestItem(handle.db, { type: "story", title: "Old work", stepId: "todo" });
    setItemArchived(handle.db, onTodo.id, Date.now());
    const onReview = createTestItem(handle.db, { type: "story", title: "Older work", stepId: "review" });
    setItemArchived(handle.db, onReview.id, Date.now());

    publish("/archive", { filter: { text: "", facets: { tab: "items", step: "review" } } });

    expect(current().view?.matching?.rows.map((row) => row.name)).toEqual([onReview.key]);
  });

  /**
   * *Show archived* is the second thing the Agent tools screen narrows
   * by, and it is owned by the catalogue rather than the tabs (EO-192).
   * `ViewPublisher` merges the two, and both have to survive the round
   * trip — otherwise a later call cannot tell a live-only catalogue from
   * one showing archived rows.
   */
  it("carries Show archived beside the tab, so a live-only catalogue is distinguishable", async () => {
    publish("/agent-tools", { filter: { text: "", facets: { tab: "servers", archived: "false" } } });
    expect(current().view?.parameters.filter?.facets).toEqual({ tab: "servers", archived: "false" });

    publish("/agent-tools", { filter: { text: "", facets: { tab: "servers", archived: "true" } } });
    expect(current().view?.parameters.filter?.facets).toEqual({ tab: "servers", archived: "true" });

    // And it reaches the text the agent reads, where an `all`-shaped
    // facet would have been dropped as "not set".
    expect(await asTheAgentReadsIt()).toContain("archived=true");
  });

  it("resolves nothing on the archive's pipelines tab, and says which it is", async () => {
    publish("/archive", { filter: { text: "", facets: { tab: "pipelines" } } });

    expect(current().view?.matching).toBeNull();
    expect(await asTheAgentReadsIt()).toContain("does not resolve the rows of this screen's list");
  });

  it("carries which tab or section is open, and changes when it does", () => {
    for (const [path, facets] of [
      ["/agent-tools", { tab: "servers", archived: "false" }],
      ["/agent-tools", { tab: "skills", archived: "true" }],
      ["/settings", { section: "guardrails" }],
      ["/settings", { section: "jira" }],
      ["/archive", { tab: "pipelines" }],
    ] as const) {
      publish(path, { filter: { text: "", facets } });
      expect({ path, facets: current().view?.parameters.filter?.facets }).toEqual({ path, facets });
    }
  });
});

describe("a filtered list", () => {
  it("resolves to the rows that actually match, computed here rather than sent", async () => {
    const wanted = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
    const other = createTestItem(handle.db, { type: "story", title: "Rename the sidebar", stepId: "todo" });

    publish("/items", { filter: { text: "rate", facets: {} }, sort: "updated:desc" });
    const view = current().view;

    expect(view?.matching?.of).toBe("items");
    expect(view?.matching?.count).toBe(1);
    expect(view?.matching?.rows.map((row) => row.name)).toEqual([wanted.key]);
    expect(view?.matching?.rows.map((row) => row.name)).not.toContain(other.key);

    const text = await asTheAgentReadsIt();
    expect(text).toContain(wanted.key);
    expect(text).not.toContain(other.key);
    // An agent about to act on a filtered set is told to say back what
    // it is about to touch.
    expect(text).toContain("say back which rows");
  });

  it("applies the screen's structured filters too, so what it reports is what is on screen", () => {
    createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
    createTestItem(handle.db, { type: "bug", title: "Rate limiter throws", stepId: "todo" });

    publish("/items", { filter: { text: "rate", facets: { type: "bug" } } });

    expect(factOf(current().view?.matching?.rows ?? [], "type")).toEqual(["bug"]);
  });

  it("names only the filters that are actually set, so a whole list does not read as a narrowed one", async () => {
    createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
    publish("/items", { filter: { text: "", facets: { type: "all", status: "running", attention: "false" } } });

    const text = await asTheAgentReadsIt();

    expect(text).toContain("Filters set: status=running");
    expect(text).not.toContain("type=all");
    expect(text).not.toContain("attention=false");
  });

  /**
   * A cap is only honest if it caps the *screen's* order.
   *
   * Filtering alone matched rows and then took whichever fifty the query
   * happened to return first. Sorted by title, that is fifty rows the
   * person cannot see while the fifty in front of them go unmentioned —
   * and every one of them is a row an agent might be asked to act on.
   */
  it("lists rows in the order the person sorted them, not the order they came out of the database", () => {
    for (const title of ["Zebra crossing", "Alpha channel", "Middle ground"]) {
      createTestItem(handle.db, { type: "story", title, stepId: "todo" });
    }

    publish("/items", { filter: { text: "", facets: {} }, sort: "title:asc" });
    expect(factOf(current().view?.matching?.rows ?? [], "title")).toEqual(["Alpha channel", "Middle ground", "Zebra crossing"]);

    publish("/items", { filter: { text: "", facets: {} }, sort: "title:desc" });
    expect(factOf(current().view?.matching?.rows ?? [], "title")).toEqual(["Zebra crossing", "Middle ground", "Alpha channel"]);
  });

  it("caps the head of that order, and says which order it is the head of", async () => {
    // Enough to be capped, named so the alphabet and the insertion order
    // disagree: under the screen's sort the first rows are the Z ones,
    // which a cap over the query's own order would never show.
    for (let index = 0; index < 60; index += 1) createTestItem(handle.db, { type: "story", title: `Row ${index}`, stepId: "todo" });
    for (const title of ["Zebra one", "Zebra two"]) createTestItem(handle.db, { type: "story", title, stepId: "todo" });

    publish("/items", { filter: { text: "", facets: {} }, sort: "title:desc" });
    const matching = current().view?.matching;

    expect(matching?.count).toBe(62);
    expect(matching?.rows.length).toBe(50);
    expect(matching?.ordered).toBe(true);
    expect(factOf(matching?.rows ?? [], "title").slice(0, 2)).toEqual(["Zebra two", "Zebra one"]);

    expect(await asTheAgentReadsIt()).toContain("The first 50 are listed in the order the screen shows them; there are 62 in all.");
  });

  it("says the order is not the screen's rather than implying it is, when it cannot reproduce one", async () => {
    createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
    // A column this build does not order by. Guessing an order would be
    // worse than admitting there is none: "the first fifty" would read
    // as the person's first fifty.
    publish("/items", { filter: { text: "", facets: {} }, sort: "whatever:asc" });

    expect(current().view?.matching?.ordered).toBe(false);
    expect(await asTheAgentReadsIt()).toContain("could not reproduce this screen's ordering");
  });

  it("is absent on a screen that publishes no filter, rather than listing everything", () => {
    createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
    publish("/settings");

    expect(current().view?.matching).toBeNull();
  });
});

/**
 * The other two screens the widget sits on that narrow a list.
 *
 * Both published a filter and got no rows back, which is the worst of
 * both: the reply showed a filter was set and left the agent with no way
 * to know what survived it — which reads as "nothing matches" to anyone
 * not looking closely.
 */
describe("the Agents screen's list", () => {
  it("resolves to the agents that match, in the screen's own order", async () => {
    publish("/agents", { filter: { text: "system", facets: { archived: "false" } } });
    const matching = current().view?.matching;

    expect(matching?.of).toBe("agents");
    expect(matching?.count).toBeGreaterThan(0);
    // Resolved from the database: the role and the provider are things
    // EO looked up, not things the renderer sent.
    expect(factOf(matching?.rows ?? [], "role")).toContain("system");

    expect(await asTheAgentReadsIt()).toContain("the agents this installation has");
  });

  it("narrows by role and by the search box, the same way the screen does", () => {
    publish("/agents", { filter: { text: "", facets: { role: "system", archived: "false" } } });
    expect(factOf(current().view?.matching?.rows ?? [], "role").every((role) => role === "system")).toBe(true);

    publish("/agents", { filter: { text: "nothing is called this", facets: { archived: "false" } } });
    expect(current().view?.matching?.count).toBe(0);
  });

  /**
   * The Agents screen has two tabs and only one of them lists agents.
   *
   * A resolver reading the role and the search box and ignoring the tab
   * answers with agents while the person is looking at runtimes: rows
   * that are real, resolved correctly, and not on screen — which is the
   * one failure this whole feature exists to prevent.
   */
  it("resolves no list on the Runtimes tab, and says so rather than reading as nothing matching", async () => {
    publish("/agents", { filter: { text: "", facets: { tab: "runtimes" } } });

    expect(current().view?.matching).toBeNull();
    // The tab is still a view parameter and is still reported; what is
    // absent is a list of rows nobody is looking at.
    expect(current().view?.parameters.filter?.facets["tab"]).toBe("runtimes");

    const text = await asTheAgentReadsIt();
    expect(text).toContain("does not resolve the rows of this screen's list");
    expect(text).not.toContain("Nothing matches it.");
  });

  it("resolves the list again once the Agents tab is back", () => {
    publish("/agents", { filter: { text: "", facets: { tab: "runtimes" } } });
    expect(current().view?.matching).toBeNull();

    publish("/agents", { filter: { text: "", facets: { tab: "agents", archived: "false" } } });
    expect(current().view?.matching?.of).toBe("agents");
    expect(current().view?.matching?.count).toBeGreaterThan(0);
  });

  /**
   * A retired agent is hidden unless the box is ticked (EO-186), so a
   * handler that ignored the box would report agents nobody can see —
   * and call one of them "disabled", inviting somebody to tick a
   * checkbox that brings nothing back.
   */
  it("hides a retired agent until the screen says it is showing them, and never calls it disabled", () => {
    const agent = assistAgent(handle.db)!;
    archiveAgent(handle.db, agent.id);

    publish("/agents", { filter: { text: agent.name, facets: { archived: "false" } } });
    expect(current().view?.matching?.count).toBe(0);

    publish("/agents", { filter: { text: agent.name, facets: { archived: "true" } } });
    expect(factOf(current().view?.matching?.rows ?? [], "state")).toEqual(["retired"]);
  });
});

describe("the Inbox's list", () => {
  /** A mention on an item, which is what puts a row in the inbox. */
  function mention(title: string, body: string) {
    const item = createTestItem(handle.db, { type: "story", title, stepId: "todo" });
    postComment(handle.db, {
      id: uuidv7(),
      itemId: item.id,
      author: { type: "agent", agentId: assistAgent(handle.db)!.id },
      body,
      kind: "question",
      mentions: [{ type: "human" }],
    });
    return item;
  }

  it("resolves to the items that match, with the comment's id and the item behind it", async () => {
    const item = mention("Add rate limiting", "Which limit did you want?");
    publish("/inbox", { filter: { text: "", facets: { category: "all" } } });

    const matching = current().view?.matching;
    expect(matching?.of).toBe("inbox");
    expect(matching?.rows.map((row) => row.name)).toEqual([item.key]);
    expect(factOf(matching?.rows ?? [], "ticket id")).toEqual([item.id]);

    expect(await asTheAgentReadsIt()).toContain("everything waiting on a person");
  });

  it("narrows by the tab that is open and by the search box", () => {
    mention("Add rate limiting", "Which limit did you want?");

    // Nothing is blocking: a mention does not by itself park a run, and
    // the two must not be conflated — that is what makes an FYI look
    // like a stoppage.
    publish("/inbox", { filter: { text: "", facets: { category: "blocking" } } });
    expect(current().view?.matching?.count).toBe(0);

    publish("/inbox", { filter: { text: "rate", facets: { category: "all" } } });
    expect(current().view?.matching?.count).toBe(1);

    publish("/inbox", { filter: { text: "nothing like this", facets: { category: "all" } } });
    expect(current().view?.matching?.count).toBe(0);
  });
});

describe("the three kinds of thing in the answer", () => {
  it("keeps the view's parameters apart from the rows EO resolved", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
    publish("/agents", { selection: [item.id], sort: "name:asc", filter: { text: "review", facets: { role: "reviewer" } } });

    const view = current().view;
    expect(view?.parameters.selection).toEqual([item.id]);
    expect(view?.parameters.sort).toBe("name:asc");

    const text = await asTheAgentReadsIt();
    expect(text).toContain("The view's own parameters");
    expect(text).toContain("facts about the screen, not about the work");
  });

  it("labels an unsaved edit as typed and not saved, never as a stored value", async () => {
    publish("/settings", { unsavedEdits: [{ field: "Base branch", value: "release/next" }] });

    expect(current().view?.unsavedEdits).toEqual([{ field: "Base branch", value: "release/next" }]);

    const text = await asTheAgentReadsIt();
    const section = text.slice(text.indexOf("## Typed and not saved"));
    expect(section).toContain("**These are not stored values.**");
    expect(section).toContain("Base branch: release/next");
    // The value appears under that heading and nowhere above it, so it
    // cannot be read as part of what EO resolved.
    expect(text.slice(0, text.indexOf("## Typed and not saved"))).not.toContain("release/next");
  });

  /**
   * An empty list means *nothing was reported*, and the reply says so
   * rather than claiming every field holds what is stored.
   *
   * It could not honestly claim that. A screen publishes the edits it
   * names, one at a time, and it never names a credential — a Jira API
   * token and a licence key are both typed into fields that hold them
   * before they are saved, and putting those in a snapshot an agent
   * reads would be a leak dressed as helpfulness. So the strong sentence
   * is exactly the kind of confident falsehood this whole feature exists
   * to avoid, and it is not made.
   */
  it("says nothing was reported rather than claiming every field holds what is stored", async () => {
    publish("/settings");

    const text = await asTheAgentReadsIt();

    expect(text).toContain("Nothing has been reported as unsaved");
    expect(text).toContain("not a guarantee");
    expect(text).not.toContain("Every field on this screen holds what is stored");
  });

  it("keeps several editors' unsaved values apart, and under that heading alone", async () => {
    publish("/settings", {
      unsavedEdits: [
        { field: "Branch prefix", value: "" },
        { field: "New project name", value: "Shop" },
      ],
    });

    const text = await asTheAgentReadsIt();
    const section = text.slice(text.indexOf("## Typed and not saved"));

    // A cleared field is a value nothing holds, and reads as cleared
    // rather than as an omission.
    expect(section).toContain("Branch prefix: (cleared)");
    expect(section).toContain("New project name: Shop");
    expect(text.slice(0, text.indexOf("## Typed and not saved"))).not.toContain("Shop");
  });
});

/**
 * The acceptance criterion the whole story turns on.
 *
 * Nothing is dispatched between the two calls — no message is sent, no
 * turn is built, no context is assembled. The person walks, and the same
 * tool call answers about where they are now. EO-189's section could not
 * do this at any price: it was rendered when the message was sent, so
 * the second question was answered with the first question's screen.
 */
describe("calling twice across a navigation", () => {
  it("answers about the new screen the second time, with no dispatch in between", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });

    publish(`/items/${item.id}`);
    const first = await asTheAgentReadsIt();
    expect(first).toContain(item.key);
    expect(first).not.toContain("**Settings**");

    // The only thing that happens between the two reads: the person
    // navigates, and the window says so.
    publish("/settings");

    const second = await asTheAgentReadsIt();
    expect(second).toContain("**Settings**");
    expect(second).not.toContain(item.key);
  });
});

/**
 * Where the tool lives, and who can reach it.
 *
 * `eo_admin` rather than the stdio `eo` server, because that is the one
 * that reaches the main process through `dispatchIpc` — the stdio server
 * is a child process with a read-only SQLite handle and no route back
 * into a handler, so it could not answer this if it wanted to. The
 * consequence is the access rule: only an agent holding `eo_admin` can
 * ask what is on screen.
 */
describe("the tool", () => {
  it("is a read tool in the catalogue the admin server serves whole", () => {
    const tool = TOOLS.find((candidate) => candidate.name === "view_current");

    expect(tool).toBeDefined();
    expect(tool?.kind).toBe("read");
    expect(tool?.annotations.readOnlyHint).toBe(true);
    // Not withheld by the destructive-operations gate: it reads, and the
    // admin server is ungated in any case.
    // And served by exactly one of EO's two listeners. `gate.test.ts`
    // and `http.test.ts` hold the boundary itself, over a real socket;
    // what is pinned here is that this tool is on the admin side of it.
    expect(tool?.adminOnly).toBe(true);
    expect(toolsFor(true, "admin").map((candidate) => candidate.name)).toContain("view_current");
    expect(toolsFor(true, "external").map((candidate) => candidate.name)).not.toContain("view_current");
  });

  it("is not offered by the stdio server every other agent gets", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "eoServer.mjs"), "utf8");

    expect(source).not.toContain("view_current");
    expect(source).not.toContain("view:current");
  });

  it("is held by the system agent, which is the agent the widget talks to", () => {
    // EO-185's grant, read off the row a migration writes rather than
    // one this test hands itself.
    expect(adminToolsEnabled(assistAgent(handle.db)!)).toBe(true);
  });
});

/**
 * "Move this to Review", now through the tool.
 *
 * Everything the move is made with is read back out of the tool's own
 * answer — the item's id, and the step its result routes to under the
 * name the person used. Nothing is taken from this test's knowledge of
 * the database, which is the only way to claim the turn could have acted
 * without the item being named. The message really does not name it.
 */
describe("an agent asked to move the item the person is looking at", () => {
  it("has everything it needs to act, and acts, without the item being named", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
    const message = "move this to Review";
    expect(message).not.toContain(item.key);

    publish(`/items/${item.id}`);
    const text = await asTheAgentReadsIt();

    const id = /Its id, which is what a tool takes: `([^`]+)`/.exec(text)?.[1];
    const toStepId = /\*\*Review\*\* \(`([^`]+)`\)/.exec(text)?.[1];
    expect(id).toBeDefined();
    expect(toStepId).toBeDefined();

    registerHandler("items:move", (payload) => moveItem(handle.db, undefined, payload), opts);
    const move = TOOLS.find((tool) => tool.name === "ticket_move")!;
    const outcome = await move.run(dispatchIpc, { ticketId: id, toStepId, comment: "Asked for from the ticket's screen." });

    expect(outcome.ok).toBe(true);
    expect(getItem(handle.db, item.id as Uuid)?.stepId).toBe(toStepId);
  });
});

/**
 * A pipeline's Changes view (EO-524): which pipeline, and which versions
 * are compared — resolved here from the numbers the view publishes, and
 * compared again by the channel the view itself reads.
 */
describe("a pipeline's Changes view", () => {
  let pipelineId: Uuid;

  /** A pipeline with three versions: the step renamed in v2, a step added in v3. */
  function threeVersions(): void {
    const pipeline = createPipeline(handle.db, { projectId: null, name: "Approvals" });
    pipelineId = pipeline.id as Uuid;
    const intake = createStep(handle.db, { pipelineId, position: 0, name: "Intake", type: "user" });
    const done = createStep(handle.db, { pipelineId, position: 1, name: "Done", type: "user", isTerminal: true });
    setEntryStep(handle.db, pipelineId, intake.id);
    const asView = (steps: PipelineStep[]): PipelineStepView[] =>
      steps.map((step, index) => ({
        id: step.id,
        pipelineId,
        position: index,
        name: step.name,
        type: step.type,
        ownerRole: step.ownerRole,
        entryAction: step.entryAction,
        instructionsSummary: step.instructionsSummary,
        isTerminal: step.isTerminal,
        planMode: step.planMode,
        workspaceMode: step.workspaceMode,
        workspaceId: step.workspaceId,
        inputs: step.inputs,
        timeoutMs: step.timeoutMs,
        watch: step.watch,
        results: step.results,
        moduleVersion: null,
      }));
    const save = (steps: PipelineStep[]) => savePipeline(handle.db, { notifyStateChange: () => {} }, { pipelineId, steps: asView(steps), routes: [], entryStepId: intake.id });
    // An item binds the pipeline to v1, so each save after files a version.
    createTestItem(handle.db, { type: "story", title: "Binds v1", stepId: intake.id });
    expect(save([{ ...intake, name: "Triage" }, done]).saved).toBe(true);
    expect(save([{ ...intake, name: "Triage" }, { ...done, id: "step-qa" as Uuid, name: "QA", isTerminal: false, position: 1 }, { ...done, position: 2 }]).saved).toBe(true);
    expect(listPipelineVersions(handle.db, pipelineId).map((version) => version.number)).toEqual([1, 2, 3]);
  }

  /** What the view publishes for an address: its route, and what it compares as facets. */
  function publishChanges(path: string): void {
    const [pathname, query = ""] = path.split("?");
    const facets = Object.fromEntries(
      query
        .split("&")
        .filter((pair) => pair !== "")
        .map((pair) => [pair.split("=")[0]!, pair.split("=")[1] || "true"]),
    );
    publish(pathname!, { filter: { text: "", facets } });
  }

  it("names the pipeline and the two versions the address compares, and what changed between them", async () => {
    threeVersions();
    publishChanges(pipelineChangesPath(pipelineId, { kind: "versions", from: 1, to: 2 }));

    const view = current().view!;
    expect(view.showing.kind).toBe("pipelineChanges");
    if (view.showing.kind !== "pipelineChanges") return;
    expect(view.showing.changes).toMatchObject({
      id: pipelineId,
      name: "Approvals",
      versions: { from: { number: 1 }, to: { number: 2 }, steps: [{ name: "Triage", change: "changed" }], routes: [] },
      local: null,
    });

    const text = await asTheAgentReadsIt();
    expect(text).toContain("They are looking at the **Changes** view of a pipeline: **Approvals**");
    expect(text).toContain("Comparing **v1**");
    expect(text).toContain("with **v2**");
    expect(text).toContain("Step **Triage**: changed");
  });

  it("compares the newest two when the address names none", () => {
    threeVersions();
    publishChanges(pipelineChangesPath(pipelineId));

    const view = current().view!;
    if (view.showing.kind !== "pipelineChanges") throw new Error("not the Changes view");
    // QA added, and Done moved down to make room for it.
    expect(view.showing.changes.versions).toMatchObject({
      from: { number: 2 },
      to: { number: 3 },
      steps: [
        { name: "QA", change: "added" },
        { name: "Done", change: "changed" },
      ],
    });
  });

  it("names this machine's own edits and the version they were based on, and no published pair, when opened on them", async () => {
    threeVersions();
    const v2 = listPipelineVersions(handle.db, pipelineId).find((version) => version.number === 2)!;
    markDiverged(handle.db, pipelineId, v2.id, Date.now());
    publishChanges(pipelineChangesPath(pipelineId, { kind: "local" }));

    const view = current().view!;
    if (view.showing.kind !== "pipelineChanges") throw new Error("not the Changes view");
    expect(view.showing.changes.versions).toBeNull();
    expect(view.showing.changes.local).toMatchObject({ basedOn: 2, steps: [{ name: "QA", change: "added" }, { name: "Done", change: "changed" }] });
    expect(await asTheAgentReadsIt()).toContain("**This machine's own edits**, against v2");
  });

  it("says the pipeline has gone when it was deleted under the open view", () => {
    threeVersions();
    publishChanges(pipelineChangesPath(pipelineId));
    deletePipelineCommand(handle.db, { id: pipelineId });

    expect(current().view).toBeNull();
    expect(current().absence).toContain("is not there any more");
  });
});
