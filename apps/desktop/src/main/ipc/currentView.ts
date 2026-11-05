import {
  assistPageRouteOf,
  assistPageSubjectOf,
  changesComparedOf,
  changesShown,
  effectiveReference,
  gitStateOf,
  matchesAgentFilter,
  matchesArchiveFilter,
  matchesBoardQuery,
  matchesInboxFilter,
  matchesItemFilter,
  orderAgents,
  showsAgentList,
  orderInbox,
  parseItemSort,
  sortItems,
  type CurrentViewResult,
  type IpcPayload,
  type IpcResponse,
  type Item,
  type ItemSummary,
  type ProposalDetail,
  type ViewFilter,
  type ViewListKind,
  type ViewPipelineChanges,
  type VersionDiff,
  type ViewRoute,
  type ViewRow,
  type Uuid,
  type ViewSnapshot,
  watchLine,
} from "@eo/core";
import type { Db } from "../db/client.js";
import {
  getPipeline,
  getStep,
  getItem,
  listActiveRuns,
  listDependencies,
  listRoutesForPipeline,
  graphForItem,
  listPipelines,
  listRunsForItem,
  listStepsForPipeline,
  listItemsIncludingArchived,

  stepForItem,
} from "../db/repos/index.js";
import { declaredResults } from "@eo/engine";
import { listAgentDetails } from "./configCommands.js";
import { listArchivedSummaries, listInbox, listItemSummaries } from "./domainQueries.js";
import { originIndex } from "../jobs/origin.js";
import { activeProjectId } from "./repositoryCommands.js";
import { pipelineVersionsCommand } from "./pipelineCommands.js";

/**
 * What is on the person's screen, held in memory and read on demand
 * (EO-192).
 *
 * EO-189 solved this the other way round and the shape was wrong.
 * A section describing the page was built at dispatch and put into every
 * assist prompt: everything the agent might want had to be decided in
 * advance, was paid for whether or not it was read, and — the part that
 * cannot be fixed by choosing better — described the screen the person
 * was on *when the message was sent*. Walk to another one and the agent
 * is holding a description of somewhere they have left, with no way to
 * ask again.
 *
 * So there is no preloaded section. The renderer publishes what it knows
 * whenever it changes, this module holds the latest, and an agent asks
 * when it wants to know. Two calls across a navigation answer about two
 * screens with nothing dispatched in between, which is the whole point.
 *
 * **In memory, and deliberately not a table.** This is ephemeral UI
 * state: it is true for as long as the person is looking at that screen
 * and false the instant they are not. Persisting it would create exactly
 * the thing this feature removes — a stored answer that can be read back
 * after it stopped being true — and would survive a restart to describe
 * a window that no longer exists.
 *
 * **What the renderer is allowed to say.** Identifiers and view
 * parameters: the route, its parameters, the filter as typed, selected
 * ids, the sort, and what has been typed into a field and not saved.
 * Never prose and never a resolved fact. Everything below is looked up
 * here, from the database, which is invariant #5 applied to the one
 * input this feature adds. Three kinds of thing come back and they stay
 * apart: rows EO resolved, parameters of the view, and unsaved edits
 * that have no row behind them at all.
 */

/**
 * The one current view.
 *
 * Module state, like the push emitter next door, because there is one
 * window and one screen in front of one person. Replaced whole on every
 * publish: a merge would let a screen that stopped having a filter go on
 * reporting the last one it had.
 */
let published: ViewSnapshot | null = null;

/** Records where the person is now, replacing whatever was there. */
export function publishView(input: IpcPayload<"view:publish">): IpcResponse<"view:publish"> {
  published = input;
  return { published: true };
}

/** Forgets it. For tests, and for a window going away. */
export function clearPublishedView(): void {
  published = null;
}

/**
 * Where the person is, as the last publish said — or null if no window
 * has said yet.
 *
 * Exported for exactly one caller (EO-383). The chat layout's home is
 * not a screen about anything: asked which board a draft raised there
 * should be published against, its own route answers "none". With the
 * canvas popped out, the board is the one in the window beside it,
 * which is the board this snapshot is of — so `assistCommands.ts` reads
 * it here rather than being told by a renderer that cannot know.
 *
 * The descriptor only. Everything else on the snapshot is resolved
 * against the database by `readCurrentView`, and a second reader of the
 * resolved answer would be a second place that could disagree with it.
 */
export function publishedPage(): ViewSnapshot["page"] | null {
  return published?.page ?? null;
}

/** What the resolver needs from the world outside the database. */
export interface CurrentViewDeps {
  /**
   * Whether anybody is looking at anything.
   *
   * Injected rather than read off `BrowserWindow` here, so this module
   * stays testable without electron — and so "there is no window" is a
   * question asked at call time rather than a stale flag. A headless run
   * answers false, and the tool says there is no view, which is the
   * truth.
   */
  hasWindow: () => boolean;
  /**
   * The work proposal on a message, at full length, or null (EO-408).
   *
   * Injected because the reader belongs to the assistant's room
   * (`assistCommands.ts`, which already reads this module for the board
   * behind a draft), and the proposal is that room's to recognise. Absent
   * where nothing is wired, and a proposed item then resolves to no view
   * with a sentence saying so.
   */
  proposal?: (messageId: string) => ProposalDetail | null;
}

/** How many rows a filtered listing shows before it says how many more there are. */
const MAX_ROWS = 50;

/** A screen that is about no single row: what to call it, and what it is for. */
interface Screen {
  name: string;
  describes: string;
}

/**
 * The screens, named by EO rather than by whatever the renderer would
 * have called them.
 *
 * The names are the sidebar's own labels, because that is the word the
 * person just clicked and the word they will use in their message. The
 * sentence after each is what makes "this" and "here" resolvable on a
 * screen that is about no particular row.
 */
const SCREENS: Readonly<Record<string, Screen>> = {
  items: {
    name: "Tickets",
    describes: "the flat list of this project's live tickets, whatever pipeline and step each is on.",
  },
  inbox: {
    name: "Inbox",
    describes: "everything waiting on a person — open mentions, questions an agent asked, and runs that escalated.",
  },
  jobs: {
    name: "Jobs",
    describes:
      "what this project files on its own: each job is a trigger, a pipeline and a template for the item it stamps out, with a history of every occurrence including the ones that were skipped.",
  },
  archive: {
    name: "Archive",
    describes: "the work this project has put away. An archived ticket keeps its comments and runs and can be restored.",
  },
  agents: {
    name: "Agents",
    describes: "the agents this installation has — their roles, providers, models and instructions — and the runtimes they run on.",
  },
  "agent-tools": {
    name: "Agent tools",
    describes: "the MCP servers and skills agents are given. Not Settings → MCP server, which points the other way and lets another program drive EO.",
  },
  gallery: {
    name: "Templates",
    describes:
      "the gallery a project can be started from: each card is a template — a pipeline with its kinds of work, its roles and what it needs set up — with a Preview that runs on the fake backend and costs nothing.",
  },
  settings: {
    name: "Settings",
    describes: "how EO itself is configured: guardrails, projects and repositories, modules, Jira, and the archive sweep.",
  },
};

/** No view, and why. Never an error — see the channel's own comment. */
function nothing(absence: string): CurrentViewResult {
  return { view: null, absence };
}

/**
 * The screen right now, resolved.
 *
 * Null whenever there is nothing honest to describe, and the answer says
 * which: no window, nothing published yet, a route nobody listed, a
 * route missing the parameter that names its row, and a row deleted
 * since the screen was drawn. Every one of them is ordinary — a panel
 * sits open across a delete, and somebody wanders onto a screen this
 * table does not name — and the honest answer to each is that there is
 * no view rather than an invented one. Never a throw: a person who
 * wandered somewhere unlisted should cost the answer to "what am I
 * looking at", not the question they actually asked.
 */
export function readCurrentView(db: Db, deps: CurrentViewDeps): IpcResponse<"view:current"> {
  if (!deps.hasWindow()) return nothing("EO has no window open, so nobody is looking at a screen.");

  const snapshot = published;
  if (!snapshot) return nothing("The window has not said what it is showing yet.");

  const route = assistPageRouteOf(snapshot.page);
  if (!route) {
    return nothing(`EO does not describe \`${snapshot.page.route}\`. There is a window open, but this is not a screen it can resolve.`);
  }

  // `assistPageSubjectOf` rather than reading the parameter off the path,
  // because one route's id is not in its path at all: `/project` draws
  // the default pipeline's board with nothing in its address (EO-191).
  // Asking the shared answer here is what stops this file and the
  // conversation key disagreeing about which row a page is about.
  const id = assistPageSubjectOf(snapshot.page);
  if (route.param !== null && id === null) {
    return nothing(`\`${snapshot.page.route}\` names no ${route.param}, so there is nothing to look up.`);
  }

  if (route.key === "item" || route.key === "pipeline") {
    const row = route.key === "item" ? resolveItem(db, id ?? "") : resolvePipeline(db, id ?? "", snapshot.filter);
    // A screen sits open across a delete — this is ordinary rather than
    // exceptional, and the honest answer is that the thing it was about
    // has gone.
    if (!row) return nothing(`The ${route.key} \`${id}\` is not there any more. It has been deleted or archived since that screen was drawn.`);
    return describe(db, snapshot, route.key, row);
  }

  if (route.key === "pipelineChanges") {
    const changes = resolvePipelineChanges(db, id ?? "", snapshot.filter);
    if (!changes) return nothing(`The pipeline \`${id}\` is not there any more. It has been deleted since that screen was drawn.`);
    return describe(db, snapshot, route.key, { kind: "pipelineChanges", changes });
  }

  if (route.key === "proposal") {
    const proposed = resolveProposedItem(deps, id ?? "", snapshot.page.params["index"]);
    if (!proposed) return nothing("That proposed item is not there any more. The proposal it was part of cannot be read, or holds no item at that place.");
    return describe(db, snapshot, route.key, proposed);
  }

  const screen = SCREENS[route.key];
  // Unreachable while every keyed route above has an entry, and the
  // table one file over is free to grow. A screen nobody described is a
  // missing paragraph, not a wrong one.
  if (!screen) return nothing(`EO has nothing written down about \`${snapshot.page.route}\`.`);

  return describe(db, snapshot, route.key, { kind: "screen", screen });
}

/** One shape for the answer, whatever kind of screen it turned out to be. */
function describe(
  db: Db,
  snapshot: ViewSnapshot,
  key: string,
  showing: NonNullable<IpcResponse<"view:current">["view"]>["showing"],
): IpcResponse<"view:current"> {
  return {
    view: {
      route: snapshot.page.route,
      showing,
      matching: resolveMatching(db, key, snapshot),
      parameters: { filter: snapshot.filter, selection: snapshot.selection, sort: snapshot.sort },
      unsavedEdits: snapshot.unsavedEdits,
    },
    absence: null,
  };
}

/**
 * The rows a filtered list is actually showing.
 *
 * Computed here, from the database, and never taken from the renderer.
 * That is the difference between "the seven items matching that
 * filter" being a fact and being something a query cache believed a
 * moment ago — and an agent asked to act on a filtered set is about to
 * touch every one of these.
 *
 * Three screens the assistant can be asked from narrow a list, and all three are
 * answered rather than only the one. A screen that publishes a filter
 * and gets no rows back is the worst of both: the reply shows the agent
 * a filter is set and leaves it with no way to know what survived it,
 * which reads as "nothing matches" to anyone not looking closely.
 *
 * Every predicate and every ordering is the screen's own, shared through
 * `@eo/core`. That is not tidiness: the listing is capped, so what is
 * shown is *the head of the screen's order*, and a second opinion about
 * either would name rows the person cannot see.
 */
function resolveMatching(db: Db, key: string, snapshot: ViewSnapshot) {
  const filter = snapshot.filter;
  if (filter === null) return null;
  if (key === "items") return matchingItems(db, filter, snapshot.sort);
  if (key === "agents") return matchingAgents(db, filter);
  if (key === "inbox") return matchingInbox(db, filter);
  if (key === "archive") return matchingArchive(db, filter);
  return null;
}

/**
 * The archive's two tabs, of which one is a list of items.
 *
 * The other is the pipelines somebody deleted, which is a different kind
 * of row and one EO does not resolve here — so it answers null and the
 * reply says outright that it cannot list this screen, rather than
 * letting an absent list read as an empty archive.
 */
function matchingArchive(db: Db, filter: ViewFilter) {
  if ((filter.facets["tab"] ?? "items") !== "items") return null;

  // Newest first, which is the order `listArchivedSummaries` already
  // answers in and the order the screen draws. Narrowed by the screen's
  // own predicate (EO-230): the archive opened for one step's items
  // shows those and nothing else, and so does this.
  return capped(
    "items",
    listArchivedSummaries(db, activeProjectId(db))
      .items.filter((item) => matchesArchiveFilter(item, filter))
      .map(itemRow),
    true,
  );
}

/** The head of a list, with the real total beside it so a cap never reads as the whole set. */
function capped(kind: ViewListKind, rows: ViewRow[], ordered: boolean) {
  return { of: kind, count: rows.length, rows: rows.slice(0, MAX_ROWS), ordered };
}

function matchingItems(db: Db, filter: ViewFilter, sort: string | null) {
  const matched = listItemSummaries(db, activeProjectId(db)).items.filter((item) => matchesItemFilter(item, filter));

  // Ordered before it is capped, and in the screen's order. Filtering
  // alone was not enough: the table can be sorted by any column, and
  // "the first fifty" under one ordering is a different fifty under
  // another — so an unsorted cap names rows nobody can see while the
  // rows in front of the person go unmentioned.
  const order = parseItemSort(sort);
  if (order === null) return capped("items", matched.map(itemRow), false);

  // Pipelines are named because one of the columns sorts on the name,
  // and the board draws an unknown pipeline as a word rather than a
  // uuid — so the two orderings agree even on a pipeline archived out
  // from under an item.
  const names = new Map(listPipelines(db).map((pipeline) => [pipeline.id as string, pipeline.name]));
  const pipelineName = (id: string | null) => (id === null ? "—" : (names.get(id) ?? "Unknown pipeline"));

  return capped("items", sortItems(matched, order.key, order.direction, pipelineName).map(itemRow), true);
}

function itemRow(item: ItemSummary): ViewRow {
  return {
    id: item.id,
    name: item.key,
    facts: [
      { label: "title", value: item.title },
      { label: "type", value: item.type },
      { label: "step", value: item.stepName },
      ...(item.needsAttention ? [{ label: "needs attention", value: "yes" }] : []),
    ],
  };
}

function matchingAgents(db: Db, filter: ViewFilter) {
  // The Runtimes tab lists no agents, so there is no list to resolve.
  // Null rather than an empty one: "nothing matches your filter" and
  // "this screen is not showing a list" are different answers, and the
  // reply says which.
  if (!showsAgentList(filter)) return null;

  const rows = orderAgents(listAgentDetails(db).agents)
    .filter((agent) => matchesAgentFilter(agent, filter))
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      facts: [
        { label: "role", value: agent.role },
        { label: "provider", value: agent.provider },
        { label: "model", value: agent.model ?? "the provider's default" },
        // Three states, not two. A retired agent answers neither
        // enabled nor disabled (EO-186), and calling it "disabled"
        // would invite somebody to tick a box that brings nothing back.
        { label: "state", value: agent.archivedAt !== null ? "retired" : agent.enabled ? "enabled" : "disabled" },
      ],
    }));

  return capped("agents", rows, true);
}

function matchingInbox(db: Db, filter: ViewFilter) {
  const rows = orderInbox(listInbox(db, activeProjectId(db)).items)
    .filter((item) => matchesInboxFilter(item, filter))
    .map((item) => ({
      // The comment, which is what the row *is* and what a reply is
      // filed under. The item travels beside it as a fact, so an
      // agent asked to answer one has both without guessing which id
      // this is.
      id: item.commentId,
      name: item.itemKey,
      facts: [
        { label: "item", value: item.itemTitle },
        { label: "ticket id", value: item.itemId },
        { label: "from", value: item.authorName },
        { label: "kind", value: item.kind },
        { label: "blocking", value: item.blocking ? "yes — the run is parked until this is answered" : "no" },
      ],
    }));

  return capped("inbox", rows, true);
}

/**
 * The proposed item a view is open on (EO-408): one row of the proposal
 * on a message, as that proposal says it.
 *
 * Resolved from the two identifiers the address carries — the message and
 * the row's place — like every other screen: the renderer says where it
 * is and EO reads the proposal off the run, so the assistant is told what
 * approving would file rather than what a view believed it was drawing.
 * Null for a message with no work proposal behind it, a place past the
 * end of its rows, and a row that amends an existing item, which opens as
 * that item and never as this.
 */
function resolveProposedItem(deps: CurrentViewDeps, messageId: string, place: string | undefined) {
  const proposal = deps.proposal?.(messageId) ?? null;
  const index = place !== undefined && /^\d+$/.test(place) ? Number(place) : -1;
  const row = proposal?.rows[index];
  if (!proposal || row?.kind !== "new") return null;

  return {
    kind: "proposedItem",
    proposed: {
      title: row.title,
      type: row.typeLabel,
      acceptanceCriteria: row.acceptanceCriteria,
      waitsOn: row.waitsOn.map((dependency) => (dependency.key === null ? dependency.title : `${dependency.key} ${dependency.title}`)),
      container: proposal.container?.title ?? (row.under === null ? null : `${row.under.key} ${row.under.title}`),
      landsOn: proposal.landsOn === null ? null : `${proposal.landsOn.pipelineName} · ${proposal.landsOn.stepName}`,
      proposedTogether: proposal.rows.length,
      position: index + 1,
      // A card in a conversation that was put away is closed with no reason of its own.
      state: proposal.canApprove ? "open" : (proposal.closed ?? "closed"),
    },
  } as const;
}

function resolveItem(db: Db, itemId: string) {
  const item = getItem(db, itemId as Uuid);
  if (!item) return null;

  return {
    kind: "item",
    item: {
      id: item.id as string,
      key: item.key,
      title: item.title,
      type: item.type,
      step: resolveItemStep(db, item),
      dependencies: listDependencies(db, item.id).flatMap((edge) => {
        const dep = getItem(db, edge.dependsOnId);
        return dep ? [{ key: dep.key, title: dep.title }] : [];
      }),
      // The git kind's state on the item (KAN-169), which this view has
      // spelled `branch` and `pullRequest` since before it was one.
      git: gitStateOf(item),
      // Own or the feature's (EO-637), as the item page shows it.
      reference: effectiveReference(item, item.parentId === null ? undefined : getItem(db, item.parentId)),
    },
  } as const;
}

/**
 * The step an item sits on, and everywhere a result can send it.
 *
 * `declaredResults` rather than a filter written out here: the
 * configuration screen orders a step's results by `position` and so does
 * routing, and a third ordering would show the person one thing and tell
 * the agent another.
 *
 * This is what makes "move this to Review" answerable — a move is a
 * result key and a target step id, and an agent holding neither has to
 * go looking for both.
 */
function resolveItemStep(db: Db, item: Item) {
  if (item.stepId === null || item.pipelineId === null) return null;
  // The step *as this item's version defines it* (EO-327): what an
  // agent is told it may do here has to be what it is judged by.
  const step = stepForItem(db, item);
  if (!step) return null;

  return {
    id: step.id as string,
    name: step.name,
    type: step.type,
    ownerRole: step.ownerRole,
    entryAction: step.entryAction,
    isTerminal: step.isTerminal,
    // And its routes from the same version (EO-327). What an agent is
    // told it may return here, and where each answer goes, is one
    // answer with the step above it: reading the results off v1 and the
    // routes off v2 would describe a step that exists in neither.
    results: declaredResults(step.id, graphForItem(db, item).routes).map((route) => ({
      resultKey: route.resultKey,
      label: route.label === "" ? null : route.label,
      target: route.target,
      // `terminal` and `user_attention` are targets that name no step,
      // and a step handed off to another pipeline (EO-58) is not in this
      // pipeline's list — `getStep` resolves by id across all of them,
      // and answers null for the two words, which render as themselves.
      targetName: getStep(db, route.target)?.name ?? null,
    })),
  };
}

/**
 * The edges of a pipeline, named at both ends.
 *
 * In board order — by the step they leave, then by the order that step
 * declares them — because that is the order the configuration screen
 * shows them in, and a third ordering would describe a graph the person
 * cannot match to what is in front of them.
 *
 * Routes out of an off-board step are dropped, so the listing agrees
 * with the steps above it: a route from a step the answer does not show
 * is an edge to nowhere as far as the reader is concerned.
 */
function pipelineRoutes(db: Db, pipelineId: string): ViewRoute[] {
  const steps = listStepsForPipeline(db, pipelineId).filter((step) => !step.offBoard);
  const positions = new Map(steps.map((step) => [step.id as string, step.position]));
  const names = new Map(steps.map((step) => [step.id as string, step.name]));

  return listRoutesForPipeline(db, pipelineId)
    .filter((route) => positions.has(route.fromStepId))
    .sort((a, b) => (positions.get(a.fromStepId) ?? 0) - (positions.get(b.fromStepId) ?? 0) || a.position - b.position)
    .map((route) => ({
      fromStepId: route.fromStepId,
      fromStepName: names.get(route.fromStepId) ?? null,
      resultKey: route.resultKey,
      label: route.label === "" ? null : route.label,
      target: route.target,
      targetName: getStep(db, route.target)?.name ?? null,
    }));
}

/**
 * The status of an item's newest run, which is what puts a card in the
 * paused rail without anybody holding it.
 *
 * Ties broken by id, exactly as the item listing breaks them: two runs
 * can start in the same millisecond, and the newest is what the card
 * shows.
 */
function latestRunStatusOf(db: Db, item: Item): string | null {
  const runs = listRunsForItem(db, item.id).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.id.localeCompare(a.id));
  return runs[0]?.status ?? null;
}

function resolvePipeline(db: Db, pipelineId: string, filter: ViewFilter | null) {
  const pipeline = getPipeline(db, pipelineId);
  // Archived is *deleted*, for a pipeline. `pipelines:delete` archives
  // rather than drops (KAN-59) so the work that flowed through one still
  // has something to point at, and `getPipeline` answers with archived
  // rows for exactly that reason. Neither of those is a licence to
  // describe a deleted pipeline to somebody as though it were still on
  // their screen.
  if (!pipeline || pipeline.archivedAt !== null) return null;

  // Which column an item is in, or null if it is in none of this
  // pipeline's.
  //
  // One predicate for both counts below, rather than the same three
  // conditions written twice. They *were* written twice, and the copies
  // disagreed: `holding` excluded archived items and `running` did
  // not. Nothing stops an item being archived mid-run — `setArchived`
  // takes any item and never looks at its runs — so a column holding
  // one idle live item beside an archived one still running read as
  // "1 item here now, 1 being worked". Both numbers were individually
  // defensible and the sentence they made was false.
  //
  // The board's search box narrows the cards, and therefore narrows
  // these counts too (EO-192). A count over the whole project while the
  // board draws one card is a number that contradicts what the person
  // can see — and "move everything out of Review" against the wrong four
  // items is not a mistake anybody notices in time. The predicate is
  // the board's own, from `@eo/core`.
  //
  // **Which means the rows handed to it must be the rows the board
  // draws.** The board filters `ItemSummary`, which carries what filed
  // each item (EO-308); this side has raw `items` rows, which do not —
  // so `matchesBoardQuery` on them saw `origin` undefined and, the
  // moment the Job page narrowed the board to a job, rejected every row
  // and reported an empty board to an agent looking at four cards. The
  // provenance is resolved here, once for the whole board, by the same
  // index `listItemSummaries` builds: sharing the predicate is only
  // worth anything if both sides feed it the same shape.
  const origins = originIndex(db, listItemsIncludingArchived(db).map((item) => item.id));
  const shown = (item: Item) =>
    filter === null || matchesBoardQuery({ key: item.key, title: item.title, stepId: item.stepId, origin: origins.get(item.id) ?? null }, filter);

  /** On this board at all — before asking which column, or whether it is in one. */
  const onBoard = (item: Item | undefined): item is Item =>
    item !== undefined && item.stepId !== null && item.archivedAt === null && item.pipelineId === pipeline.id && shown(item);

  /**
   * Which column an item is in, or null if it is in none of this
   * board's.
   *
   * **A held item is in none of them.** The board lifts it out of its
   * column and into the paused rail (EO-44), so a step reported as
   * holding it names a card that is not there — and "move everything out
   * of To Do" would then be asked about an item somebody deliberately
   * parked. It is counted below instead, where the screen puts it.
   */
  const columnOf = (item: Item | undefined): string | null => (onBoard(item) && item.heldAt === null ? item.stepId : null);

  const holding = new Map<string, number>();
  for (const candidate of listItemsIncludingArchived(db)) {
    const column = columnOf(candidate);
    if (column !== null) holding.set(column, (holding.get(column) ?? 0) + 1);
  }

  const running = new Map<string, number>();
  for (const run of listActiveRuns(db)) {
    const column = columnOf(getItem(db, run.itemId));
    if (column !== null) running.set(column, (running.get(column) ?? 0) + 1);
  }

  /**
   * The rail beside the columns, which is part of this screen too.
   *
   * Excluding held work from the columns without saying where it went
   * would make it vanish from the description of a board that is
   * visibly showing it. The rail holds two kinds of card and the screen
   * makes no distinction between them: work an agent stopped to ask
   * about, and work a person parked by hand.
   */
  const paused = listItemsIncludingArchived(db).filter(
    (item) => onBoard(item) && (item.heldAt !== null || latestRunStatusOf(db, item) === "awaiting_input"),
  ).length;

  return {
    kind: "pipeline",
    pipeline: {
      id: pipeline.id as string,
      name: pipeline.name,
      // Off-board steps are not columns of this pipeline — they hold
      // conversations — so a person looking at the board is not looking
      // at them.
      steps: listStepsForPipeline(db, pipeline.id)
        .filter((step) => !step.offBoard)
        .map((step) => ({
          id: step.id as string,
          name: step.name,
          position: step.position,
          type: step.type,
          ownerRole: step.ownerRole,
          entryAction: step.entryAction,
          holding: holding.get(step.id) ?? 0,
          running: running.get(step.id) ?? 0,
          keepsChecking: watchLine(step),
        })),
      routes: pipelineRoutes(db, pipeline.id),
      paused,
    },
  } as const;
}

/**
 * A pipeline's Changes view (EO-524): which pipeline, and which versions
 * it compares.
 *
 * The view publishes the version numbers its address names as facets —
 * identifiers, never what it drew — and the comparison is made again
 * here by the channel the view itself reads (`pipeline:versions`), so
 * the pair named is the pair EO has. A number the pipeline does not have
 * falls back as the view's does, to the newest and the one before it.
 */
function resolvePipelineChanges(db: Db, pipelineId: string, filter: ViewFilter | null): ViewPipelineChanges | null {
  const pipeline = getPipeline(db, pipelineId);
  if (!pipeline || pipeline.archivedAt !== null) return null;

  const compared = changesComparedOf((name) => filter?.facets[name] ?? null);
  const shown = changesShown(compared);
  const answer = pipelineVersionsCommand(
    db,
    compared.kind === "versions"
      ? { pipelineId, ...(compared.from === null ? {} : { from: compared.from }), ...(compared.to === null ? {} : { to: compared.to }) }
      : { pipelineId },
  );

  const version = (number: number) => {
    const row = answer.versions.find((candidate) => candidate.number === number);
    return { number, createdByName: row?.createdByName ?? null, createdAt: row?.createdAt ?? 0 };
  };
  // Names and how each changed: the field-by-field detail is the screen's, and the agent can ask `pipeline_versions` for it.
  const summary = (diff: Pick<VersionDiff, "steps" | "routes">) => ({
    steps: diff.steps.map((step) => ({ name: step.name, change: step.change })),
    routes: diff.routes.map((route) => ({ fromStepName: route.fromStepName, resultKey: route.resultKey, change: route.change })),
  });

  return {
    id: pipeline.id as string,
    name: pipeline.name,
    versions: shown.versions && answer.diff !== null ? { from: version(answer.diff.from), to: version(answer.diff.to), ...summary(answer.diff) } : null,
    local: shown.local && answer.local !== null ? { basedOn: answer.local.basedOn, ...summary(answer.local.diff) } : null,
  };
}
