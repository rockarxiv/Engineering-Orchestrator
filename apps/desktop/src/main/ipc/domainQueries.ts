import { and, count, eq, gte } from "drizzle-orm";
import {
  acceptanceCriteriaOf,
  GIT_WORKTREE_KIND,
  effectiveReference,
  gitStateOf,
  ITEM_COMMENTS_PAGE,
  ITEM_SECTIONS,
  jiraStateOf,
  LOCAL_PERSON_ID,
  parsedResultOf,
  qualifiedItemType,
  type Agent,
  type Comment,
  type CommentView,
  type InboxItem,
  type ItemDetail,
  type ItemDep,
  type ItemSection,
  type ArchivedItemListFilters,
  type IpcPayload,
  type IpcResponse,
  type ItemListFilters,
  type Person,
  type PipelineStep,
  type PipelineStepView,
  type PipelineVersion,
  type WaitingOn,
  type Run,
  type RunView,
  type Item,
  type ItemSummary,
  type Uuid,
  type WorkspaceBadge,
  type WorkspaceKindSlug,
  entryRefusalSentence,
  entryRuleWords,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { featureIsDone, featureProgress } from "../roles/featureLifecycle.js";
import { comments, commentMentions } from "../db/schema.js";
import { runEvents } from "../db/schema.js";
import {
  itemsOnArchivedProjects,
  getPipeline,
  pipelineHasWebhookEntry,
  getItem,
  getItemType,
  listActiveRuns,
  listAgents,
  listAllDependencies,
  listCommentsForItem,
  countCommentsForItem,
  threadHoldsComment,
  listDependencies,
  latestRunForItem,
  currentOutputOf,
  type CommentWindow,
  listRunsForItem,
  listItemsIncludingArchived,
  jiraBaseUrlFor,
  listWorkspaces,
  listItems,
  listArchivedItems,
  listItemsForProject,
  listItemsByIds,
  getItemByKey,
  listTransitionsForItem,
  stepEntryTimes,
  isSoloMode,
  getGroup,
  getPerson,
  listPeople,
  listPipelineSteps,
  listProjects,
  listPipelines,
  listRoutableStepsElsewhere,
  listRoutesForPipeline,
  listIncomingHandOffs,
  listStepsForPipeline,
  listRetiredStepsForPipeline,
  currentVersion,
  itemsOnOlderVersions,
  listPipelineVersions,
  offBoardStepIds,
  needsAttention,
  projectWorkspaceList,
  openMentionsForHuman,
  asGitWorkspace,
  getJiraBinding,
  getWorkspace,
  workspaceLabel,
  isJiraConnected,
  listAttachmentsForItem,
  pendingPushesForItem,
  finishedItemIds,
  stepForItem,
  stepsByItemVersion,
  versionAuthorName,
} from "../db/repos/index.js";
import { actingCaller, visibleProjectIds } from "../identity/acting.js";
import { viewerFor } from "../identity/viewer.js";
import { decisionsFor } from "./decisions.js";
import { outputFor } from "./outputCommands.js";
import { originIndex, originOfItem } from "../jobs/origin.js";
import { projectWorkspaceKind, stepWorkspaceKind, resolveItemWorkspace } from "../supervisor/workspaceResolution.js";
import { verificationOfKind } from "../workspaceKinds.js";
import { activeProjectId } from "./repositoryCommands.js";
import { workspaceView } from "./workspaceCommands.js";
import { providerSteersLiveTurns } from "../providers/capabilities.js";
import { currentWatchViews, itemWatchView } from "../supervisor/watches.js";
import { runActionName } from "../modules/runName.js";
import { registry, registryForProject } from "../registry.js";
import { outsideReachForSteps } from "../trials/stepModes.js";

/**
 * A link to the mirrored issue, so a key on a card is clickable (J-02).
 *
 * Built here rather than stored: the base URL belongs to the connection
 * the project's binding names and can change when a site is renamed, and
 * a stored link would then point somewhere that no longer exists.
 */
function jiraUrlFor(db: Db, item: Item): string | null {
  const key = jiraStateOf(item).key;
  if (!key || !item.projectId) return null;
  const baseUrl = jiraBaseUrlFor(db, item.projectId);
  return baseUrl ? `${baseUrl}/browse/${key}` : null;
}

/**
 * Display name for a comment's author — "you", a colleague's name, the
 * agent's name, "EO", or "a module".
 *
 * A human comment says "you" unless it names somebody who is not the
 * reader (EO-326). `author_id` is null on every comment a desktop has
 * ever written, so that is still every row there; on a server it is the
 * person who posted, and an admin reading another team's thread has to
 * be told whose words they are — "you" on Anna's comment would be the
 * screen claiming the reader had said it.
 */
function authorName(comment: Comment, agentsById: Map<string, Agent>, people?: Map<string, Person>, viewerId: string = LOCAL_PERSON_ID): string {
  if (comment.authorType === "human") {
    if (comment.authorId === null || comment.authorId === viewerId) return "you";
    return people?.get(comment.authorId)?.name ?? "somebody else";
  }
  if (comment.authorType === "engine") return "EO";
  // Generic here and specific in the body (EO-75). The module's name is
  // written into the comment itself, because that is the only part Jira
  // receives — resolving it a second time for the header would name the
  // same module twice on the same card.
  if (comment.authorType === "module") return "a module";
  return (
    (comment.authorId && agentsById.get(comment.authorId)?.name) ??
    "unknown agent"
  );
}

function agentIndex(db: Db): Map<string, Agent> {
  return new Map(listAgents(db).map((agent) => [agent.id as string, agent]));
}

/**
 * Every item, shaped for a project card.
 *
 * `needsAttention` and `openDependencyCount` are computed here rather
 * than stored (ARCHITECTURE.md, "Needs-attention is derived"): a stored flag drifts the moment a
 * mention is
 * dismissed or a dependency lands, and the project is exactly where that
 * drift would be visible.
 */
/**
 * The project's items, for one repository or all of them.
 *
 * `repositoryId` is `undefined` for "every repository", which is what the
 * internal callers want; the IPC handler passes the active one, because
 * a project showing two repositories' columns interleaved is not a useful
 * picture of either (U-07).
 */
/**
 * The project's items (KAN-17).
 *
 * Scoped by project rather than by workspace since a project may span
 * several — and a workspace outlives the project it was attached to — so
 * neither derives from the other and the item has to say which project
 * it is on.
 */
export function listItemSummaries(
  db: Db,
  projectId: Uuid | null,
  filters: ItemListFilters = {},
): IpcResponse<"items:list"> {
  if (!isNarrowed(filters)) return summarise(db, onTheBoard(db, listItemsForProject(db, projectId)));
  // Every filter is a term of the statement that reads the rows (EO-539),
  // so what is hydrated and summarised is what matched and nothing else.
  const rows = onTheBoard(db, listItemsForProject(db, projectId, filters));
  return summarise(db, rows, containerStories(db, rows, (parentIds) => onTheBoard(db, listItemsForProject(db, projectId, { parentIds }))));
}

/**
 * What the board, and every list a person or an agent browses, shows of
 * these rows: not an archived project's, and never a trial item (EO-582,
 * ARCHITECTURE.md, "Trial pipelines"). A trial item was filed to test a
 * draft, on a pipeline no switcher lists, and is deleted with its trial;
 * the conversation it came from is where it is watched.
 *
 * Not `withoutArchivedProjects` itself, which the item detail reads too:
 * a trial item can still be opened by its id from that conversation.
 */
function onTheBoard(db: Db, items: Item[]): Item[] {
  return withoutArchivedProjects(db, items).filter((item) => item.trialAt === null);
}

/**
 * Whether a list call named any filter at all (EO-539).
 *
 * A call that named none is answered by exactly the path it was before
 * the filters existed, so an unfiltered board is the same answer it was.
 */
function isNarrowed(filters: ItemListFilters | ArchivedItemListFilters): boolean {
  return Object.values(filters).some((value) => value !== undefined);
}

/**
 * The stories a narrowed list's containers count their progress over.
 *
 * Unnarrowed, a container's progress is counted over the very rows being
 * listed, which are every item of the project. Narrowed, those rows are
 * no longer every item — a list of features alone holds none of their
 * stories — so the stories are read for the containers that were kept,
 * from the same set they would have been counted in: what the
 * unnarrowed list would have held. Absent when no container was kept.
 */
function containerStories(db: Db, rows: Item[], read: (parentIds: string[]) => Item[]): Item[] | undefined {
  const containers = rows.filter((item) => item.stepId === null).map((item) => item.id as string);
  return containers.length === 0 ? undefined : read(containers);
}

/**
 * The items left once every archived project's are taken out (EO-347).
 *
 * Asked of the rows rather than of the project id a read was scoped
 * to, because the id is not always the window's: `items:list` and
 * `inbox:list` take one explicitly — `tickets_list` passes whatever an
 * agent names — and a board or an Inbox drawn for an archived project
 * would be exactly the thing archiving takes out of sight. An item's
 * project is archived or it is not, so for a read scoped to one project
 * this is all of it or none of it.
 */
function withoutArchivedProjects(db: Db, items: Item[]): Item[] {
  const archived = itemsOnArchivedProjects(db);
  return archived.size === 0 ? items : items.filter((item) => !archived.has(item.id));
}

/** What the project has put away (KAN-33), newest first — same shape as the project's own rows. */
export function listArchivedSummaries(
  db: Db,
  projectId: Uuid | null,
  filters: ArchivedItemListFilters = {},
): IpcResponse<"items:listArchived"> {
  if (!isNarrowed(filters)) return summarise(db, withoutArchivedProjects(db, listArchivedItems(db, projectId)));
  const rows = withoutArchivedProjects(db, listArchivedItems(db, projectId, filters));
  return summarise(db, rows, containerStories(db, rows, (parentIds) => withoutArchivedProjects(db, listArchivedItems(db, projectId, { parentIds }))));
}

/**
 * The item a key names, through the project whose prefix it carries
 * (EO-539).
 *
 * Keys are unique across the installation, so the row is found by key
 * alone; the prefix is what decides whether it is the row the key
 * *means*. An item on a project carries that project's prefix, so it
 * is found only through that project. An item on no project carries the
 * default prefix, and is found by it only where no project has taken
 * that prefix for its own — otherwise the key means that project's item.
 *
 * Upper-cased first, because a prefix is stored upper-cased and a
 * person typing `eo-486` meant `EO-486`. Archived items are found:
 * this is a lookup, not a policy.
 */
export function resolveItemKey(db: Db, { key }: IpcPayload<"items:resolveKey">): IpcResponse<"items:resolveKey"> {
  const wanted = key.trim().toUpperCase();
  const dash = wanted.lastIndexOf("-");
  if (dash <= 0 || !/^\d+$/.test(wanted.slice(dash + 1))) {
    return { itemId: null, problem: `"${key}" is not an item key: a key is a project's prefix, a hyphen and a number, like EO-486.` };
  }
  const prefix = wanted.slice(0, dash);
  const project = listProjects(db).find((candidate) => candidate.keyPrefix === prefix);
  const item = getItemByKey(db, wanted);
  if (project === undefined && (item === undefined || item.projectId !== null)) {
    return { itemId: null, problem: `"${key}" names no item: no project's keys begin "${prefix}-". projects_list names every project.` };
  }
  if (item === undefined || item.projectId !== (project?.id ?? null)) {
    return { itemId: null, problem: `"${key}" names no item: ${project === undefined ? "nothing" : `nothing on ${project.name}`} has that key. items_list lists the keys there are.` };
  }
  return { itemId: item.id, problem: null };
}

/**
 * What to call where an item is.
 *
 * An item on a step is called that step's name. A feature is on none
 * (ARCHITECTURE.md, "One work entity"), and "which column" was always the wrong question for a
 * container — so it says how far the work under it has got, which is the
 * only state it has ever really had.
 *
 * `stories` is what a feature's progress is counted over where the
 * caller has already read it — every live item, or the part of it that
 * is this feature's (EO-556) — so a board of fifty features does not read
 * every item fifty times. Absent, it is read here.
 */
function stepLabel(db: Db, item: Item, step?: PipelineStep | undefined, stories?: Item[]): string {
  // The step as *this item's* version has it (EO-327): a name is what a
  // person reads the card by, and a step renamed under an item that
  // entered before the rename is not the step it is standing on.
  if (item.stepId !== null) return (step ?? stepForItem(db, item))?.name ?? item.stepId;
  const progress = featureProgress(db, item.id, stories);
  if (progress.total === 0) return "No stories yet";
  return featureIsDone(progress) ? "Done" : `${progress.done} of ${progress.total} done`;
}

/**
 * Is this item finished — so that anything waiting on it can proceed?
 *
 * For work, that is a terminal step. For a feature it is every story
 * being finished, since a dependency on a feature means "when all of that
 * is done", not "when someone moved a card". `stories` as for
 * `stepLabel`: the items already read, rather than every item again.
 */
function isFinished(db: Db, item: Item, finished: ReadonlySet<string>, stories: Item[]): boolean {
  // By the item's own version (EO-327, ARCHITECTURE.md, "Publish, lock and versions") —
  // `finishedItemIds` is
  // where that is decided, once for the whole listing. Whether work is
  // done is what everything waiting on it is waiting for, so a later
  // save marking a step terminal must not release the dependents of an
  // item that entered before it said so, nor hold back the dependents
  // of one that finished on a step a later save unmarked.
  if (item.stepId !== null) return finished.has(item.id);
  return featureIsDone(featureProgress(db, item.id, stories));
}

/**
 * Who is working on this item, or last did (ARCHITECTURE.md, "Vocabulary").
 *
 * Derived from the newest run rather than stored: the scheduler picks an
 * agent per dispatch, so an assignee written down at any earlier moment
 * would be a guess about a decision that had not been made yet. Null
 * before anything has run — nobody has picked it up.
 */
function assigneeOf(latest: Run | undefined, agentsById: Map<string, Agent>): string | null {
  if (!latest) return null;
  // A built-in step has no agent because EO itself acted.
  return latest.agentId === null ? "EO" : (agentsById.get(latest.agentId)?.name ?? null);
}

/**
 * Everyone EO knows, by id — for the two views that name one (EO-305).
 *
 * `agentIndex`'s counterpart, and built for its reason: a board of
 * fifty cards would otherwise be fifty reads of a table holding one row.
 */
function personIndex(db: Db): Map<string, Person> {
  return new Map(listPeople(db).map((person) => [person.id as string, person]));
}

/**
 * The person on a card, and whether it offers "Claim" (EO-305, ARCHITECTURE.md, "The board").
 *
 * Read off the *step*, not off the column. `items.assignee_id` is
 * deliberately left standing when an item leaves a human step — an
 * arrival on an agent step says nothing about the assignee, so the
 * person who last approved it is still written down — and a card that
 * showed that person while an agent was working would be naming the
 * wrong worker on the wrong step. The original design says which it is by where the
 * item is: "an agent's name on an agent step, a person's avatar on a
 * human step". So a person is offered only where a person is what the
 * step is waiting for, and the retained column becomes visible again
 * the moment the item comes back to one.
 *
 * Both fields are silent in solo mode as well, and that is the whole of
 * what "the surface is quiet" means in this story. There is one person:
 * an avatar on every card would be the same face fifty times, and a
 * Claim button would be asking the only pair of hands there is to
 * volunteer. So the mechanism is built, the column is written on
 * arrival, and neither is *displayed* until 7b brings colleagues —
 * which is exactly what makes the developer board unchanged (and what
 * the snapshot test holds to).
 *
 * **Except on a step that names a group** (EO-323). Solo mode is a fact
 * about *people* — how many this installation can name — and a step
 * offered to a team is not about a person at all: somebody has said "the
 * Support team takes this", the column head says "anyone claims", and a
 * card with no way to claim would be that head describing a gesture the
 * board does not offer.
 *
 * It is also the case that made the silence wrong rather than quiet. A
 * desktop signed in to an organisation holds one local row — itself —
 * so it is "solo" by this count while working against a list of
 * colleagues, and every card at its team's step was drawn unclaimable
 * under a head inviting anybody to claim it.
 *
 * Claimable is computed here rather than left to the renderer as
 * "human step and no assignee", so that "is there a Claim anywhere?" is
 * one question with one answer, askable by a test.
 */
function personAssignment(
  item: Item,
  step: PipelineStep | undefined,
  people: Map<string, Person>,
  solo: boolean,
): { assigneePerson: { id: string; name: string } | null; claimable: boolean } {
  const team = step?.type === "user" && step.ownerGroupId !== null;
  if (solo && !team) return { assigneePerson: null, claimable: false };
  const person = personOnStep(item, step, people);
  return {
    assigneePerson: person === undefined ? null : { id: person.id, name: person.name },
    // An agent step is never claimable either — its assignee is
    // whichever agent ran, which is not a thing to volunteer for.
    claimable: step?.type === "user" && person === undefined,
  };
}

/**
 * The person an item is with *right now*, or nobody (EO-305).
 *
 * The one place the step gates the column, so the card and the inbox
 * cannot come to different conclusions about the same item. An item
 * Anna approved and sent on to an agent is nobody's while the agent
 * has it: the column still names her, because that is what arriving
 * somewhere an agent works does not change, and this is what makes the
 * two readings of that column distinct rather than contradictory.
 */
function personOnStep(item: Item, step: PipelineStep | undefined, people: Map<string, Person>): Person | undefined {
  if (step?.type !== "user" || item.assigneeId === null) return undefined;
  return people.get(item.assigneeId);
}

/**
 * What to call the workspace this item is on, where there still is one
 * (EO-299).
 *
 * `repositoryName` in the view and the repository's own name until this
 * story, which is a field name the shape keeps and a question every
 * kind now answers: a folder workspace is called by its path. Null for
 * an item on no workspace, and for one naming a row that has gone.
 */
function workspaceNameOf(db: Db, workspaceId: Uuid | null): string | null {
  if (workspaceId === null) return null;
  const workspace = getWorkspace(db, workspaceId);
  return workspace ? workspaceLabel(workspace) : null;
}

/**
 * Version id → version number, for every version these items are on
 * that is not its pipeline's current one (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * A miss means "the current version", which is what the card wears
 * nothing for. Built from the items rather than from the pipelines so
 * that a board with a hundred versions behind it costs what its cards
 * cost, not what its history does.
 */
function olderVersionIndex(db: Db, rows: Item[]): Map<string, number> {
  const index = new Map<string, number>();
  const pipelineIds = new Set(rows.flatMap((item) => (item.pipelineId === null ? [] : [item.pipelineId as string])));
  for (const pipelineId of pipelineIds) {
    const current = currentVersion(db, pipelineId)?.id ?? null;
    for (const version of listPipelineVersions(db, pipelineId)) {
      if (version.id !== current) index.set(version.id, version.number);
    }
  }
  return index;
}

/** The feature a story belongs to, for the tag on its card (ARCHITECTURE.md, "One work entity"). */
function parentOf(db: Db, item: Item): Item | undefined {
  return item.parentId === null ? undefined : getItem(db, item.parentId);
}

/**
 * The read a summary takes of what happened to its rows rather than of
 * the rows themselves (EO-540): the dependency edges out of the rows.
 *
 * The board reads every edge there is, once. One item's own fields read
 * that item's edges alone.
 *
 * The run that names a card's status and assignee is read the same way
 * on both — `latestRunForItem`, one row per card (EO-556). The board
 * used to hydrate each card's whole run history, every result parsed, to
 * keep the head of it.
 */
interface SummaryReads {
  edges: (rows: Item[]) => ItemDep[];
}

function boardReads(db: Db): SummaryReads {
  return { edges: () => listAllDependencies(db) };
}

function oneItemReads(db: Db): SummaryReads {
  return { edges: (rows) => rows.flatMap((row) => listDependencies(db, row.id)) };
}

/**
 * One item's summary, as the board would give it, read for that item
 * alone (EO-540).
 *
 * The same rows the board would list, narrowed in the query to this
 * item's key (EO-539) — so an item the board leaves out, a conversation
 * or one on an archived project, has no summary here either — and the
 * same `summarise`, with its runs and edges read for this item only.
 */
function summaryOf(db: Db, item: Item): ItemSummary | undefined {
  const rows = withoutArchivedProjects(db, listItemsForProject(db, item.projectId, { keys: [item.key] }));
  const stories = containerStories(db, rows, (parentIds) => withoutArchivedProjects(db, listItemsForProject(db, item.projectId, { parentIds })));
  return summarise(db, rows, stories, oneItemReads(db)).items.find((entry) => entry.id === item.id);
}

/**
 * `stories` is what each container's progress is counted over, where
 * that is not `rows` itself — a narrowed list (EO-539), whose rows are
 * no longer every item a container's stories could be among.
 */
function summarise(db: Db, rows: Item[], stories: Item[] = rows, reads: SummaryReads = boardReads(db)): { items: ItemSummary[] } {
  const states = new Map(
    listPipelineSteps(db).map((state) => [state.id, state]),
  );
  const projectNames = new Map(
    listWorkspaces(db).map((workspace) => [
      workspace.id as string,
      workspaceLabel(workspace),
    ]),
  );
  // Both callers — the project and the archive — ask "what work is
  // there?", and a discussion is an item only so that it can
  // host runs and cost. Filtered here rather than in the two callers so
  // there is one place this can be got wrong.
  const offBoard = offBoardStepIds(db);
  // Asked once for the whole board rather than per card: both are reads
  // of a table with one row in it in solo mode, and fifty of each is
  // fifty answers that cannot differ.
  const people = personIndex(db);
  const solo = isSoloMode(db);
  // An item on no step is a feature (ARCHITECTURE.md, "One work entity"), which is real work to
  // show;
  // an off-board step is a conversation, which is not.
  const all = rows.filter((item) => item.stepId === null || !offBoard.has(item.stepId));
  const deps = reads.edges(all);
  const agentsById = agentIndex(db);
  // Which job filed each card, in one query rather than one per card —
  // the same index `view:current` narrows this board with, so the cards
  // drawn and the cards reported cannot be two different sets.
  const origins = originIndex(db, all.map((item) => item.id));
  // When each card arrived on its step (EO-570), for the whole listing
  // in one query. A miss is an item that has never moved, which arrived
  // when it was created.
  const enteredAt = stepEntryTimes(db, all.map((item) => item.id));
  // Which version ids are *not* the current one, by pipeline, and what
  // number each is (EO-327). Built once for the whole listing rather
  // than asked per card: a card on the current version is the ordinary
  // case and must cost nothing, and the map answers it with a miss.
  const olderVersionNumbers = olderVersionIndex(db, all);
  // Each row's step **as its own version defines it** (EO-327, ARCHITECTURE.md, "Publish, lock and
  // versions"),
  // where that is not the live one. A miss is an item on the current
  // version, which is every item until somebody edits a pipeline — so
  // the live map below is still what nearly every card is read from.
  //
  // Three answers on this row turn on it: what the step is called, who
  // the item is assigned to, and whether it is *finished* — which is
  // what everything waiting on it is waiting for. A save that marks a
  // step terminal must not release the dependents of work that entered
  // before it said so.
  const boundSteps = stepsByItemVersion(db, all);
  const stepOf = (item: Item): PipelineStep | undefined =>
    item.stepId === null ? undefined : (boundSteps.get(item.id) ?? states.get(item.stepId));
  // The watch on each card's step (EO-699), for the whole listing at
  // once: the card says when it checks next rather than "Done".
  const watches = currentWatchViews(db, all, stepOf);

  /**
   * What a dependency edge resolves against, which is *not* this board
   * (EO-335).
   *
   * `rows` is one project's live work with the conversations filtered
   * out; `listAllDependencies` is every edge there is. So an edge
   * routinely points at an item that is not on this board — archived
   * (KAN-33), on another project, or off-board — and reading that miss
   * as "not finished" made all three of them look like an open
   * dependency for ever. The archived one is the worst of the three,
   * because *finishing* the dependency is what causes it: the sweep
   * takes the item away, the edge stays, and the count goes to 1 and
   * never comes down. This has to agree with `scheduler.ts`, which is
   * the other half of the same question — one decides what runs, this
   * decides what the person is told about it.
   *
   * Every item, once for the whole listing rather than per card, and the
   * finished set over the same rows — so an archived dependency is still
   * judged by the version it entered on (EO-327) rather than by whatever
   * a later save did to the step it stopped on. A superset of this
   * board rather than a second set beside one scoped to it: two sets
   * answering the same question is how the two halves drifted apart in
   * the first place.
   */
  //
  // Every item *these rows depend on*, rather than every item there is
  // (EO-539): an edge from a row not listed is never read below, so a
  // list narrowed to three items reads three items' dependencies and not
  // the whole installation. The finished set is over the listed rows as
  // well, which `atTerminalStep` below is read from.
  //
  // The edges out of each listed row, grouped once for the whole listing
  // (EO-556) rather than filtered out of every edge there is for every
  // card.
  const listedIds = new Set(all.map((item) => item.id as string));
  const edgesOut = new Map<string, ItemDep[]>();
  for (const edge of deps) {
    if (!listedIds.has(edge.itemId)) continue;
    const out = edgesOut.get(edge.itemId);
    if (out === undefined) edgesOut.set(edge.itemId, [edge]);
    else out.push(edge);
  }
  const dependencyIds = new Set([...edgesOut.values()].flatMap((out) => out.map((edge) => edge.dependsOnId as string)));
  const dependencyById = new Map(listItemsByIds(db, [...dependencyIds]).map((item) => [item.id as string, item]));
  const finished = finishedItemIds(db, [...dependencyById.values(), ...all.filter((item) => !dependencyById.has(item.id))]);

  // What a feature's *name* and a feature *dependency* are counted over:
  // every live item, as `featureProgress` reads when asked alone — read
  // once for the whole listing (EO-556), and only if a feature is asked
  // about, then grouped by parent so each feature is handed its own
  // stories rather than filtering every item again. Not `stories`, which
  // is what the `progress` field is counted over: the two have always
  // been separate questions and this keeps them so.
  let liveStoriesByParent: Map<string, Item[]> | undefined;
  const liveStoriesOf = (featureId: string): Item[] => {
    if (liveStoriesByParent === undefined) {
      liveStoriesByParent = new Map();
      for (const candidate of listItems(db)) {
        if (candidate.parentId === null) continue;
        const siblings = liveStoriesByParent.get(candidate.parentId);
        if (siblings === undefined) liveStoriesByParent.set(candidate.parentId, [candidate]);
        else siblings.push(candidate);
      }
    }
    return liveStoriesByParent.get(featureId) ?? [];
  };

  const items: ItemSummary[] = all.map((item) => {
    const openDeps = (edgesOut.get(item.id) ?? []).filter((edge) => {
      const dependency = dependencyById.get(edge.dependsOnId);
      // An edge pointing at no item at all — the dependency was
      // deleted. Nothing will ever finish it, so it is not something
      // this item is waiting for; saying otherwise blocks it for good
      // and tells the person to go and wait for a ghost.
      if (dependency === undefined) return false;
      return !isFinished(db, dependency, finished, dependency.stepId === null ? liveStoriesOf(dependency.id) : []);
    });

    // The latest to start, a run not started yet counting as the oldest,
    // ties broken by the larger id — asked of the database as one row.
    const latest = latestRunForItem(db, item.id);

    // Looked up rather than read from these rows: a parent is not necessarily
    // in this result set — it can be filtered out here, and once a feature
    // stops being work on a pipeline (ARCHITECTURE.md, "One work entity") it will not be in one at
    // all.
    const parent = parentOf(db, item);

    return {
      id: item.id,
      key: item.key,
      type: item.type,
      typeLabel: item.typeLabel,
      container: item.container,
      parentId: item.parentId,
      parentKey: parent?.key ?? null,
      parentTitle: parent?.title ?? null,
      repositoryId: item.workspaceId,
      repositoryName:
        item.workspaceId === null
          ? null
          : (projectNames.get(item.workspaceId) ?? null),
      projectId: item.projectId,
      title: item.title,
      pipelineId: item.pipelineId,
      stepId: item.stepId,
      // The chip a card wears when its pipeline has moved on without it
      // (EO-327, ARCHITECTURE.md, "Publish, lock and versions"). Null — nothing drawn — for
      // everything on the
      // current version, which is every card on a board nobody has
      // edited since.
      pipelineVersion: olderVersionNumbers.get(item.pipelineVersionId ?? "") ?? null,
      // What the step is called — or, for a feature, how far its stories
      // have got, because that is the only sense in which a container has
      // a state at all (ARCHITECTURE.md, "One work entity").
      stepName: stepLabel(db, item, stepOf(item), item.stepId === null ? liveStoriesOf(item.id) : undefined),
      progress: item.stepId === null ? featureProgress(db, item.id, stories) : null,
      priority: item.priority,
      // The extension whole, not two fields picked out of it (KAN-169):
      // a view that flattened it would have to be widened again by the
      // next kind with state of its own.
      git: gitStateOf(item),
      workspace: workspaceBadge(db, item),
      jiraKey: jiraStateOf(item).key,
      jiraUrl: jiraUrlFor(db, item),
      updatedAt: item.updatedAt,
      stepEnteredAt: enteredAt.get(item.id) ?? item.createdAt,
      heldAt: item.heldAt,
      // What filed it, where a job did (EO-308): the card names it on
      // hover with what the occurrence cost, and the board filtered by
      // job is exactly the cards this is set on.
      origin: origins.get(item.id) ?? null,
      needsAttention: needsAttention(db, item.id),
      // Standing on a terminal step of its own version (EO-384) — the
      // same set the dependencies above are judged by, so the rail's
      // finished count and "what is this waiting for" cannot disagree.
      atTerminalStep: finished.has(item.id),
      // A preview, which every surface draws a banner for (EO-313,
      // ARCHITECTURE.md, "Preview"). Derived from the item's own mark rather than from
      // anything the caller knows, so the card and the rail say the
      // same thing about the same item.
      preview: item.previewAt !== null,
      openDependencyCount: openDeps.length,
      latestRunStatus: latest?.status ?? null,
      watch: watches.get(item.id) ?? null,
      // Who is actually on it (ARCHITECTURE.md, "Vocabulary"): the agent that ran most recently,
      // not
      // whichever agent happens to hold the step's role. Two implementers
      // are two different assignees, and a card that always named the
      // first one was telling you about the pipeline, not the item.
      assigneeName: assigneeOf(latest, agentsById),
      // Who *actually* has it where a person does, and the Claim
      // affordance where nobody does (EO-305, ARCHITECTURE.md, "The board"). The agent above and
      // the person here are two different facts about two kinds of step,
      // and the card reads whichever its step makes true.
      ...personAssignment(item, stepOf(item), people, solo),
    };
  });

  return { items };
}

/** Which comments still have an open mention waiting on the human — drives the `!` in a thread. */
function commentsAwaitingHuman(db: Db, itemId: Uuid): Set<string> {
  const rows = db
    .select({ commentId: commentMentions.commentId })
    .from(commentMentions)
    .innerJoin(comments, eq(comments.id, commentMentions.commentId))
    .where(
      and(
        eq(comments.itemId, itemId),
        eq(commentMentions.targetType, "human"),
        // The person, by id (EO-302, ARCHITECTURE.md, "Identity"). `isNull` said the same
        // thing while a human mention had no target to name.
        eq(commentMentions.targetId, LOCAL_PERSON_ID),
        eq(commentMentions.status, "open"),
      ),
    )
    .all();
  return new Set(rows.map((row) => row.commentId));
}

/**
 * One item as the screens draw it (`items:get`).
 *
 * Every section whole but the thread, which is its newest
 * `ITEM_COMMENTS_PAGE` comments and the count of the ones before them
 * (EO-559): a live thread can be megabytes, and the item page reads this
 * again on every push. Older pages are `getEarlierItemComments`.
 *
 * With `from` — the page's start, held still once history has been read
 * back behind it — the thread is that comment and everything after it,
 * so a page that would otherwise slide forward as comments arrive
 * leaves no gap between itself and the history. A `from` no longer in
 * the thread (deleted since) is answered as the newest page, which
 * starts with some other comment: that is how the caller sees its
 * anchor went.
 */
export function getItemDetail(
  db: Db,
  { itemId, from }: IpcPayload<"items:get">,
): IpcResponse<"items:get"> {
  const context = itemDetailContext(db, itemId);
  if (context === null) return null; // a deleted item is a legitimate answer, not an error
  const anchored = from !== undefined && threadHoldsComment(db, context.item.id, from);
  const detail = itemDetail(db, context, anchored ? { from } : { newest: ITEM_COMMENTS_PAGE });
  const first = detail.comments[0];
  return { ...detail, earlierComments: first === undefined ? 0 : countCommentsForItem(db, context.item.id, first.id) };
}

/**
 * One item read whole — every section, the whole thread — which is what
 * `item_get` answers when it is asked for nothing narrower (EO-540). The
 * screens read the thread a page at a time instead (`getItemDetail`);
 * what an MCP client is handed did not change with that (EO-559).
 */
function wholeItemDetail(db: Db, itemId: string): ItemDetail | null {
  const context = itemDetailContext(db, itemId);
  return context === null ? null : itemDetail(db, context, undefined);
}

/**
 * Every section `getItemSections` can leave out, built without leaving
 * any out, the thread as `window` narrows it. The screens and `item_get`
 * share each section's builder, so a field added to one part of the
 * detail cannot reach the screens and miss `item_get`, or the other way
 * about.
 */
function itemDetail(db: Db, context: ItemDetailContext, window: CommentWindow | undefined): ItemDetail {
  const { item, step, agentsById } = context;
  const own = ownFieldsSection(db, context);
  const thread = threadSection(db, context, window);
  return {
    item: own.item,
    comments: thread.comments,
    transitions: transitionsSection(db, item),
    runs: runsSection(db, item, agentsById, undefined),
    // What a person may decide here and now (EO-310, ARCHITECTURE.md, "The item"). Derived
    // from the step rather than stored on the item: it is the step's
    // declaration, so an item whose step gained a result a moment ago
    // has the button on the next read.
    decision: decisionsFor(db, item, step),
    // What the item has produced, where a person may act on it (EO-311,
    // ARCHITECTURE.md, "The output is a comment", "The item"). Null on an agent step and on an item
    // that has
    // produced nothing; the thread carries every output either way.
    currentOutput: thread.currentOutput,
    dependsOn: dependsOnSection(db, item),
    watch: own.watch,
    attachmentSync: own.attachmentSync,
  };
}

/**
 * The parts of one item a caller asked for (EO-540) — `item_get`.
 *
 * A call naming none of `include`, `commentsLimit`, `commentsSince`,
 * `pinnedOnly` or `runsLimit` is answered with the whole item, thread
 * and all, so it is the answer it always was — the screens' own read is
 * windowed (EO-559), and this is not. Otherwise each section is built only
 * when it is included: a part left out is not read from the database at
 * all, which is what makes leaving it out cheaper and not only shorter.
 * The limits are terms of the statements that read the comments and the
 * runs, for the same reason.
 *
 * The output lifted above the thread travels with `comments`, because it
 * is one of them (EO-311, "The output is a comment"); the watch and the
 * attachments' sync state travel with `ticket`, because they are facts
 * about the item rather than lists on it.
 */
export function getItemSections(db: Db, request: IpcPayload<"items:getSections">): IpcResponse<"items:getSections"> {
  const { itemId, include, commentsLimit, commentsSince, pinnedOnly, runsLimit } = request;
  if (include === undefined && commentsLimit === undefined && commentsSince === undefined && pinnedOnly === undefined && runsLimit === undefined) {
    return wholeItemDetail(db, itemId);
  }

  const context = itemDetailContext(db, itemId);
  if (context === null) return null;
  const { item, step, agentsById } = context;
  const wanted = new Set<ItemSection>(include ?? ITEM_SECTIONS);
  const own = wanted.has("ticket") ? ownFieldsSection(db, context) : undefined;
  const thread = wanted.has("comments") ? threadSection(db, context, { since: commentsSince, pinnedOnly, newest: commentsLimit }) : undefined;
  return {
    ...(own === undefined ? {} : { item: own.item }),
    ...(thread === undefined ? {} : { comments: thread.comments }),
    ...(wanted.has("transitions") ? { transitions: transitionsSection(db, item) } : {}),
    ...(wanted.has("runs") ? { runs: runsSection(db, item, agentsById, runsLimit) } : {}),
    ...(wanted.has("decision") ? { decision: decisionsFor(db, item, step) } : {}),
    ...(thread === undefined ? {} : { currentOutput: thread.currentOutput }),
    ...(wanted.has("dependsOn") ? { dependsOn: dependsOnSection(db, item) } : {}),
    ...(own === undefined ? {} : { watch: own.watch, attachmentSync: own.attachmentSync }),
  };
}

/** What every section of an item's detail reads off: its row, the step it stands on, and who the agents are. */
interface ItemDetailContext {
  item: Item;
  step: PipelineStep | undefined;
  agentsById: Map<string, Agent>;
}

function itemDetailContext(db: Db, itemId: string): ItemDetailContext | null {
  const item = getItem(db, itemId as Uuid);
  if (!item) return null;
  // The step the item is on, asked once. Three of the answers below
  // turn on what kind of step it is: who the item is assigned to, what
  // may be decided here, and whether what it has produced is offered
  // where a person could act on it.
  return { item, step: stepForItem(db, item), agentsById: agentIndex(db) };
}

/** The `ticket` section: the item's own fields, the watch on its step, and its attachments' sync state. */
function ownFieldsSection(db: Db, { item, step }: ItemDetailContext) {
  // The item's own project. This used to be the *active* repository's
  // summaries, so opening an item belonging to another one silently
  // fell through to the bare fallback below and lost its derived
  // fields — needsAttention, the dependency count, the run status.
  //
  // Read for this item alone (EO-540): the board's own summary, without
  // summarising the rest of the board or reading this item's whole run
  // history to name its latest run.
  const summary = summaryOf(db, item);
  // The type this item's row points at — asked once, and by id, because
  // both things read off it are things a slug cannot answer (KAN-147):
  // which property holds the criteria, and which pack's shape the
  // detail's editor should draw when two packs ship the word.
  const type = getItemType(db, item.typeId);
  const criteria = acceptanceCriteriaOf(item, type?.specShape);
  const attachmentPushes = pendingPushesForItem(db, item.id, "jira").filter(
    (entry) =>
      entry.kind === "attachment_upload" || entry.kind === "attachment_delete",
  );

  return {
    item: {
      ...(summary ?? {
        id: item.id,
        key: item.key,
        type: item.type,
        typeLabel: item.typeLabel,
        container: item.container,
        parentId: item.parentId,
        parentKey: parentOf(db, item)?.key ?? null,
        parentTitle: parentOf(db, item)?.title ?? null,
        repositoryId: item.workspaceId,
        repositoryName: workspaceNameOf(db, item.workspaceId),
        projectId: item.projectId,
        title: item.title,
        pipelineId: item.pipelineId,
        stepId: item.stepId,
        // This branch is for an item the board does not summarise — a
        // conversation, or one on no pipeline at all — and neither is
        // ever on an older version (EO-327).
        pipelineVersion: null,
        stepName: stepLabel(db, item),
        progress: item.stepId === null ? featureProgress(db, item.id) : null,
        priority: item.priority,
        git: gitStateOf(item),
        workspace: workspaceBadge(db, item),
        jiraKey: jiraStateOf(item).key,
        jiraUrl: jiraUrlFor(db, item),
        updatedAt: item.updatedAt,
        stepEnteredAt: stepEntryTimes(db, [item.id]).get(item.id) ?? item.createdAt,
        heldAt: item.heldAt,
        origin: null,
        needsAttention: false,
        // Read off the step in front of it, like `preview` below: a
        // fact about the item's own row rather than one this branch
        // has not computed.
        atTerminalStep: step?.isTerminal === true,
        openDependencyCount: 0,
        latestRunStatus: null,
        assigneeName: null,
        // The item's own mark (EO-313, ARCHITECTURE.md, "Preview"). Not a default of `false`
        // like the two above it: those are facts this branch genuinely
        // has not computed, and this one is written on the row in front
        // of it — a conversation started from a preview is a preview,
        // and a banner that appeared on the board and not on the detail
        // would be the surface a person actually reads dropping it.
        preview: item.previewAt !== null,
        // The same answer the board would give (EO-305), asked the same
        // way: this branch is for an item the board does not summarise —
        // a conversation, or one on no step — and a detail that said
        // "nobody" where the card says "Anna" would be two screens
        // disagreeing about one column.
        ...personAssignment(item, step, personIndex(db), isSoloMode(db)),
      }),
      body: item.body,
      acceptanceCriteria: criteria,
      // By the pack and the word, which is what the renderer's registry
      // is keyed by. The bare slug stays beside it as the word a person
      // reads; a type whose row has gone answers with the slug alone,
      // which resolves to nothing and draws nothing — the same as an
      // unknown type.
      typeKey: type === undefined ? item.type : qualifiedItemType(type),
      // The item's structured fields, whole (KAN-147). What the detail's
      // spec editor draws, against the shape the renderer holds from
      // `registry:get` — which is why this is the spec as stored rather
      // than a set of fields picked out here.
      spec: item.spec,
      createdAt: item.createdAt,
      // Outside the summary spread, because it belongs to neither
      // branch of it: the rail reads the switch off the item's own row
      // (EO-122 stores it there, and there is no dynamic inheritance to
      // resolve), whether or not this item had a summary to spread.
      jiraSync: jiraStateOf(item).sync,
      // Whether the rail draws its Jira row at all (EO-126). The same
      // predicate every Jira-shaped thing asks first (J-01), rather than
      // `jiraUrl !== null`: that is null for any item without a key,
      // and an item without a key on a connected project is the one
      // case the row exists for.
      jiraConnected: isJiraConnected(item.projectId === null ? undefined : getJiraBinding(db, item.projectId)),
      // Its own Reference, or its feature's when it has none (EO-637) —
      // read live off the parent, so changing the feature's changes what
      // every story under it without one of its own shows.
      reference: effectiveReference(item, parentOf(db, item)),
      // Which job made it (EO-304, ARCHITECTURE.md, "What a job records"). Resolved through the
      // occurrence that created it rather than read off a column,
      // because the occurrence is already the record of the firing.
      //
      // Asked again after the spread rather than taken from the summary,
      // because the branch above it may be the *fallback* — an item the
      // board does not summarise, a conversation or a job's own thread
      // — and those have provenance too.
      origin: originOfItem(db, item.id),
    },
    // When the watch on this item's step last checked and checks next
    // (EO-456). Null on every item that is not on a step that keeps
    // checking, which is nearly all of them.
    watch: itemWatchView(db, item, step),
    attachmentSync: {
      pending: attachmentPushes.length,
      error:
        attachmentPushes
          .map((entry) => entry.lastError)
          .find((error): error is string => error !== null) ?? null,
    },
  };
}

/**
 * Older comments of an item, a page at a time (`items:earlierComments`,
 * EO-559): the newest `limit` before `before`, drawn as the thread is,
 * and how many are older still. A deleted item, or a `before` that is
 * not in its thread, is an empty page.
 */
export function getEarlierItemComments(db: Db, { itemId, before, limit }: IpcPayload<"items:earlierComments">): IpcResponse<"items:earlierComments"> {
  const context = itemDetailContext(db, itemId);
  if (context === null) return { comments: [], earlier: 0 };
  const commentView = commentViewer(db, context);
  const page = listCommentsForItem(db, context.item.id, { before, newest: limit }).map(commentView);
  const oldest = page[0];
  return { comments: page, earlier: oldest === undefined ? 0 : countCommentsForItem(db, context.item.id, oldest.id) };
}

/**
 * The `comments` section: the thread, or the window of it a caller
 * asked for, and the output lifted above it.
 */
function threadSection(db: Db, context: ItemDetailContext, window: CommentWindow | undefined) {
  const { item, step } = context;
  const commentView = commentViewer(db, context);

  // Built before the return rather than inside it, because the output
  // below is one of these comments (EO-311): the panel above the thread
  // is the same row lifted, and resolving its author and its
  // attachments a second time would be a second answer to what is on
  // one comment.
  const commentViews = listCommentsForItem(db, item.id, window).map(commentView);

  // The output is looked up on its own (`currentOutputOf`), so a window
  // that left it out still answers with it — and with its author and
  // its attachments, which is the one view the window has to add back.
  let views = commentViews;
  if (window !== undefined && step?.type === "user") {
    const current = currentOutputOf(db, item.id);
    if (current !== undefined && !commentViews.some((view) => view.id === current.id)) views = [...commentViews, commentView(current)];
  }
  return { comments: commentViews, currentOutput: outputFor(db, item, step, views) };
}

/** How one comment of this item is drawn: its author named, its attachments with their sync state, and whether it waits on the person. */
function commentViewer(db: Db, { item, agentsById }: ItemDetailContext): (comment: Comment) => CommentView {
  const awaiting = commentsAwaitingHuman(db, item.id);
  const attachmentsById = new Map(
    listAttachmentsForItem(db, item.id).map((attachment) => [
      attachment.id as string,
      attachment,
    ]),
  );

  return function commentView(comment: Comment): CommentView {
    return {
      id: comment.id,
      authorType: comment.authorType,
      authorName: authorName(comment, agentsById),
      authorRole: comment.authorId
        ? (agentsById.get(comment.authorId)?.role ?? null)
        : null,
      runId: comment.runId,
      parentId: comment.parentId,
      body: comment.body,
      kind: comment.kind,
      options: comment.options,
      attachments: (comment.attachments ?? []).flatMap((attachment) => {
        if (!attachment.id || !attachment.itemId || !attachment.commentId)
          return [];
        const stored = attachmentsById.get(attachment.id);
        const syncStatus = stored?.jiraSyncError
          ? ("error" as const)
          : stored?.jiraAttachmentId
            ? ("synchronized" as const)
            : jiraStateOf(item).key
              ? ("pending" as const)
              : ("local" as const);
        return [
          {
            id: attachment.id,
            itemId: attachment.itemId,
            commentId: attachment.commentId,
            kind: attachment.kind,
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size,
            syncStatus,
            syncError: stored?.jiraSyncError ?? null,
          },
        ];
      }),
      pinned: comment.pinned,
      createdAt: comment.createdAt,
      awaitingHuman: awaiting.has(comment.id),
      mirroredInJira: comment.jiraCommentId !== null,
      // Never from this screen. Approving a decomposition is the
      // assistant's "Create item" (ARCHITECTURE.md, "A column is a responsibility, not a status") — the R-04
      // newest-plan-only rule lives in
      // `conversationView`, which is the surface that still offers it.
      //
      // This used to read `… && item.stepId === "pending_approval"`,
      // and migration 0030 deleted that step. The conjunct had been
      // unconditionally false ever since, so this is what the screen has
      // actually been doing — now said outright rather than left as a
      // rule a reader would take for live.
      canApprove: false,
    };
  };
}

/** The `transitions` section: every move the item has made, oldest first. */
function transitionsSection(db: Db, item: Item) {
  return listTransitionsForItem(db, item.id).map((transition) => ({
    id: transition.id,
    fromStepId: transition.fromStepId,
    toStepId: transition.toStepId,
    actor: transition.actor,
    reason: transition.reason,
    ts: transition.ts,
  }));
}

/** The `runs` section: every run against the item, or only the newest few, oldest first. */
function runsSection(db: Db, item: Item, agentsById: Map<string, Agent>, newest: number | undefined) {
  return listRunsForItem(db, item.id, newest).map((run) =>
    // "EO" for a builtin run: it has no agent because EO itself acted,
    // which is a different thing from an agent row having gone missing.
    runView(db, run, run.agentId === null ? "EO" : (agentsById.get(run.agentId)?.name ?? "unknown agent")),
  );
}

/** The `dependsOn` section: what the item waits for, each with the name of the step it is on. */
function dependsOnSection(db: Db, item: Item) {
  return listAllDependencies(db)
    .filter((edge) => edge.itemId === item.id)
    .flatMap((edge) => {
      const dependency = getItem(db, edge.dependsOnId);
      return dependency
        ? [
            {
              id: dependency.id as string,
              key: dependency.key,
              title: dependency.title,
              stepId: dependency.stepId,
              // Resolved here, not in the renderer: a dependency can be
              // in another pipeline entirely (cross-pipeline blocking is
              // legitimate), so the item's own steps cannot name it.
              stepName: stepLabel(db, dependency),
            },
          ]
        : [];
    });
}

/**
 * A page of a run's event log.
 *
 * `nextSeq` is null when the caller has reached the end, which is what
 * lets a transcript view (U-05) follow a live run by polling forward
 * from where it stopped rather than refetching the whole log.
 */
/**
 * One run as a screen reads it.
 *
 * A function of its own since EO-392, when the debug window became the
 * second reader: it lists runs across items, and two mappings of one row
 * are how a field comes to be on one screen and missing from the other.
 */
export function runView(db: Db, run: Run, agentName: string): RunView {
  return {
    id: run.id,
    agentId: run.agentId,
    agentName,
    action: run.action,
    actionName: runActionName(db, run),
    status: run.status,
    attempt: run.attempt,
    threadId: run.threadId,
    error: run.error,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    cacheReadTokens: run.cacheReadTokens,
    cacheWriteTokens: run.cacheWriteTokens,
    turns: run.turns,
    turnsScope: run.turnsScope,
    costCents: run.costCents,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    verificationOk: run.verification
      ? Boolean((run.verification as { ok?: boolean }).ok)
      : null,
    // What the workspace kind actually looked at, for the sidebar's
    // step block (EO-312, ARCHITECTURE.md, "The item"). The verdict above says whether the
    // branch check passed; this says what was checked, which is the
    // half invariant 5 gained when it was reworded.
    checks: run.checks ?? [],
    // Asked of the provider this run is actually on rather than of the
    // agent's current setting: somebody who switched an agent to Codex
    // mid-afternoon has not changed what the Claude run still going in
    // the background can be told (EO-176). Null means a run old enough
    // to predate the column, and "no" is the safe reading of that.
    steerable: run.provider !== null && providerSteersLiveTurns(run.provider),
  };
}

export function listRunEventsPage(
  db: Db,
  { runId, fromSeq, limit }: IpcPayload<"runs:listEvents">,
): IpcResponse<"runs:listEvents"> {
  const rows = db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gte(runEvents.seq, fromSeq)))
    .orderBy(runEvents.seq)
    .limit(limit + 1) // one extra: its presence is how we know there's more
    .all();

  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;

  const lastSeq = page.at(-1)?.seq;
  return {
    events: page.map((row) => ({
      seq: row.seq,
      ts: row.ts,
      type: row.type,
      payload: row.payload,
    })),
    nextSeq: hasMore && lastSeq !== undefined ? lastSeq + 1 : null,
    total: db.select({ lines: count() }).from(runEvents).where(eq(runEvents.runId, runId)).get()?.lines ?? 0,
  };
}

/**
 * Which of the design's three sentences a row reads (EO-305).
 *
 * The item's assignee first, because that is who the work is with:
 * "Waiting on Anna" is the row that tells you it is in hands, and you
 * were copied in. Then "Unclaimed" for work sitting on a human step
 * that nobody has taken — the state a triaging team needs and the one
 * the Unassigned filter lists.
 *
 * And "Waiting on you" for everything else, which is every row in solo
 * mode and most rows anywhere: an agent asked a question halfway
 * through a run, the item is on its step with an agent on it, and the
 * person it is waiting on is the one this mention names. Falling back to
 * the mention's target rather than to "Unclaimed" is the difference
 * between an inbox that says what it wants from you and one that
 * describes the board.
 */
function waitingOnFor(item: Item, step: PipelineStep | undefined, people: Map<string, Person>, solo: boolean, viewerId: string = LOCAL_PERSON_ID): WaitingOn {
  // Through the same gate the card reads (`personOnStep`): an item Anna
  // approved and sent on to an agent is not waiting on Anna, whatever
  // the column still says, and a row telling you otherwise would be
  // pointing at somebody who is not holding anything up.
  const person = personOnStep(item, step, people);
  // "You" is whoever is reading, which on a desktop is the local person
  // and has never been anybody else. On a server it is the signed-in
  // caller, and the difference is the whole of why this takes an
  // argument: an admin reading every project's mentions must be told
  // "waiting on Anna" about Anna's work and "waiting on you" about their
  // own, and a row that named the reader back to themselves would be the
  // one sentence in the list that says nothing.
  if (person !== undefined && person.id !== viewerId) return { who: "person", personId: person.id, name: person.name };
  // Never in solo mode: the one person is who every human step assigns
  // to, and a row reading "Unclaimed" beside a board with no Claim
  // button on it would be describing an affordance that is not there.
  //
  // Which is exactly why a step naming a group is the exception here
  // too (EO-323): the board *does* draw a Claim on one, whatever this
  // machine knows about people, so an inbox saying "Waiting on you"
  // about it would be the two screens disagreeing about the same card.
  // The pair is `personAssignment`'s `team`, and the two must move
  // together or one of them is describing the other's board.
  const team = step?.type === "user" && step.ownerGroupId !== null;
  if (person === undefined && step?.type === "user" && (!solo || team)) return { who: "unclaimed" };
  return { who: "you" };
}

/**
 * The inbox is this query (ARCHITECTURE.md, "Needs-attention is derived") — open mentions aimed at
 * the human,
 * newest first. Not a subsystem, and nothing about it is stored.
 *
 * An item is `blocking` when its item has a run parked awaiting input:
 * that is the difference between "nothing moves until you answer" and an
 * FYI, and it is what decides whether to interrupt someone.
 */
/**
 * Who "you" is, for one row.
 *
 * A caller that named itself is the reader — a browser served by a
 * server, where the machine is a server and has no "you" of its own.
 * Otherwise it is whichever of this machine's two identities holds this
 * item, which is EO-325's question and the same one the rows were
 * fetched by.
 */
function readerOf(db: Db, reader: Uuid | undefined, item: Item): string {
  return reader ?? viewerFor(db, item.id);
}

/**
 * Every open mention, as rows, paired with the item each is about.
 *
 * Pulled out of `listInbox` when the admin's cross-project view arrived
 * (EO-326, ARCHITECTURE.md, "Identity"): the two lists ask the same question of the same table
 * and differ only in whose mentions they want and how wide they look.
 * Two copies of this loop would be two answers to "what is unaddressed",
 * free to drift the first time either gained a field.
 */
function openMentionRows(
  db: Db,
  /**
   * Whose rows to fetch. `undefined` is "this machine's own", which is
   * every caller on a desktop and is what lets EO-325's per-item
   * identity decide — naming a person here instead would override it
   * and empty a kept project's inbox in silence.
   */
  viewer: Uuid | "anybody" | undefined,
  inScope: (item: Item) => boolean,
  /**
   * Who the rows are *written for*, which is not always who they are
   * fetched by: the admin's cross-project view fetches `anybody` and is
   * still read by one person, and "waiting on you" has to mean them.
   * Absent falls back to this machine's per-item answer.
   */
  reader?: Uuid,
): { item: Item; row: InboxItem }[] {
  const agentsById = agentIndex(db);
  const people = personIndex(db);
  const solo = isSoloMode(db);

  return openMentionsForHuman(db, viewer).flatMap(({ comment }) => {
    const item = getItem(db, comment.itemId);
    // Never a trial item (EO-582, ARCHITECTURE.md, "Trial pipelines"): on a
    // trial the assistant stands in for the person, and what only the
    // person can answer it brings to them in its own conversation.
    if (!item || item.heldAt !== null || item.trialAt !== null || !inScope(item)) return [];
    const blocking = listRunsForItem(db, item.id).some(
      (run) => run.status === "awaiting_input",
    );
    return [
      {
        item,
        row: {
          commentId: comment.id,
          itemId: item.id,
          itemKey: item.key,
          itemTitle: item.title,
          itemTypeLabel: item.typeLabel,
          itemState: item.stepId,
          authorName: authorName(comment, agentsById, people, readerOf(db, reader, item)),
          body: comment.body,
          kind: comment.kind,
          options: comment.options,
          createdAt: comment.createdAt,
          blocking,
          // Who "you" is, for the sentence on the row. A caller that
          // named itself is the reader; otherwise it is whichever of this
          // machine's two identities holds *this item* (EO-325), which is
          // the same question the rows were fetched by.
          // The step as this item's version has it (EO-327): who is
          // waiting at a step is part of what a version says, and an
          // inbox row is a sentence about the item rather than about the
          // pipeline as it stands.
          waitingOn: waitingOnFor(item, stepForItem(db, item), people, solo, readerOf(db, reader, item)),
          // Kept in the list and out of the counts below (EO-313, ARCHITECTURE.md, "Preview").
          // A preview that reaches a human step is waiting on somebody to
          // press a button, and a row nobody could see would be a preview
          // that stopped walking — which is the whole of what it was made
          // to do. What it must not do is put a number on the badge.
          preview: item.previewAt !== null,
        },
      },
    ];
  });
}

export function listInbox(
  db: Db,
  projectId?: Uuid | null,
  /**
   * Whose inbox, where somebody other than this machine is asking
   * (EO-326, ARCHITECTURE.md, "Identity").
   *
   * Absent on a desktop, and that absence is load-bearing: it is what
   * leaves EO-325's per-item question in charge, so a signed-in desktop
   * still answers its kept projects on the local person and its managed
   * ones on the organisation's. Passing a single person here instead —
   * which an earlier draft did, defaulting to `LOCAL_PERSON_ID` — empties
   * a managed project's inbox without anything looking broken.
   */
  viewer?: Uuid,
): IpcResponse<"inbox:list"> {
  const states = new Map(
    listPipelineSteps(db).map((state) => [state.id, state]),
  );
  // Scoped like the project: an inbox mixing projects would make you read
  // the repository name on every row to know what you were answering.
  // `undefined` means every item, which is what notifications want —
  // every item on a live project, that is (EO-347). An archived
  // project's items are paused and out of sight, and a dock badge that
  // went on counting their open questions would be asking for attention
  // to work somebody deliberately put away. Filtered for a scoped read
  // too, since the project a read names is not always the window's.
  const inScope = new Set(
    withoutArchivedProjects(db, projectId === undefined ? listItems(db) : listItemsForProject(db, projectId)).map(
      (item) => item.id as string,
    ),
  );

  const items: InboxItem[] = openMentionRows(db, viewer, (item) => inScope.has(item.id), viewer).map(({ row }) => row);

  // "Everything is blocked" means every item the engine could still
  // move is waiting on a human. Items already finished don't count —
  // a project of completed work isn't a stalled pipeline.
  //
  // Nor do conversations. A chat thread is never terminal and never
  // blocking — nobody is waiting on you to reply to a chat — so leaving
  // it in would mean one open conversation permanently answering "no"
  // to "is everything blocked?".
  // A feature is excluded too, and for the same reason a conversation is:
  // nothing is waiting on you to answer a container, and it is finished
  // exactly when its stories are — counting it would double every feature.
  // Nor a preview, which is the same argument once more (EO-313, ARCHITECTURE.md, "Preview"):
  // nobody is waiting on you to answer something that was never real,
  // and one preview parked on a human step would otherwise answer "yes"
  // to "is everything blocked?" for as long as it sat there. Nor a trial
  // item (EO-582), which is not on any board to be blocked.
  // Each item by its own version (EO-327, the original design). "Everything is
  // blocked" is a claim about what the engine could still move, and an
  // item that finished on v1's terminal step has not become movable
  // again because v2 unmarked that step — nor has one that entered on v1
  // finished because v2 marked the step it is standing on.
  // Nor anything on an archived project (EO-347): the engine is not
  // going to move it whatever anybody answers, so an item there that
  // is not waiting on a human would keep "everything is blocked" false
  // for work nobody can see.
  const rows = withoutArchivedProjects(db, listItems(db));
  const finished = finishedItemIds(db, rows);
  const boundSteps = stepsByItemVersion(db, rows);
  const live = rows.filter((item) => {
    if (item.stepId === null || item.heldAt !== null || item.previewAt !== null || item.trialAt !== null) return false;
    if (finished.has(item.id)) return false;
    return !(boundSteps.get(item.id) ?? states.get(item.stepId))?.offBoard;
  });
  // Counted over the real rows only (EO-313, ARCHITECTURE.md, "Preview"). The list keeps its
  // preview rows so the preview can be answered and carry on; the badge,
  // which is EO deciding whether to interrupt somebody, counts what is
  // actually waiting on them.
  const real = items.filter((item) => !item.preview);
  const blockedItemIds = new Set(
    real.filter((item) => item.blocking).map((item) => item.itemId),
  );
  const everythingBlocked =
    live.length > 0 && live.every((item) => blockedItemIds.has(item.id));

  return {
    items,
    summary: {
      openCount: real.length,
      blockingCount: blockedItemIds.size,
      everythingBlocked,
    },
  };
}

/**
 * Every unaddressed mention the caller may see, across projects
 * (EO-326, ARCHITECTURE.md, "Identity").
 *
 * The admin's counterpart to the inbox, and the one question the inbox
 * cannot be asked. An inbox narrows to one project and one person
 * because the person reading it is working; this widens to every project
 * the caller may see and every person on them, because the person
 * reading it is not — "the admin sees every project's board and inbox".
 * So each row carries its project, and `waitingOn` carries the person,
 * which is what turns a list of unanswered questions into a list of who
 * to go and ask.
 *
 * Scoped by `visibleProjectIds`, which for an admin is everything and for
 * anybody else is their own projects — so this is a wider view of the
 * same rows and never a way around that rule. An item on no project at
 * all is in the answer for whoever sees every project and out of it
 * otherwise: it belongs to nobody's list, and putting it in everybody's
 * would be the one row on this screen with no team behind it.
 *
 * Not paged. Its bound is the number of *unaddressed* mentions on a
 * record, which is a queue people are working down rather than a log
 * that grows — an installation where this is long has a problem that
 * pagination would hide rather than solve.
 */
export function listOpenMentions(
  db: Db,
  allowedProjectIds: Set<string> | null,
  /** Who is reading, for the "waiting on you" half. Absent on a desktop — see `openMentionRows`. */
  reader?: Uuid,
): IpcResponse<"mentions:open"> {
  const projectNames = new Map(listProjects(db).map((project) => [project.id as string, project.name]));
  // Not on an archived project (EO-347), for the Inbox's reason.
  const archived = itemsOnArchivedProjects(db);
  const rows = openMentionRows(
    db,
    "anybody",
    (item) =>
      !archived.has(item.id) &&
      (allowedProjectIds === null || (item.projectId !== null && allowedProjectIds.has(item.projectId))),
    reader,
  );

  return {
    mentions: rows.map(({ item, row }) => ({
      ...row,
      projectId: item.projectId,
      projectName: item.projectId === null ? null : (projectNames.get(item.projectId) ?? null),
    })),
  };
}

/** `mentions:open`, with the caller resolved — see `listOpenMentions`. */
export function openMentionsCommand(db: Db, payload?: IpcPayload<"mentions:open">): IpcResponse<"mentions:open"> {
  const caller = actingCaller(db, payload?.actingDeviceId);
  // Named only where somebody authenticated. On a desktop the reader is
  // whichever identity holds each item, which `readerOf` answers per row.
  const reader = caller.served ? (caller.person?.id as Uuid | undefined) : undefined;
  return listOpenMentions(db, visibleProjectIds(db, caller), reader);
}

/**
 * Every agent, archived ones included (EO-186).
 *
 * The listing answers two questions and only one of them is about
 * pickers: a transcript header and a transition line resolve an agent's
 * name from here, and those are read long after an agent is retired.
 * Dropping the row would print a UUID where a name belongs, which is the
 * history archiving exists to keep. `archivedAt` travels instead, and
 * the screens that offer an agent to be *chosen* filter on it.
 */
export function listAgentViews(db: Db): IpcResponse<"agents:list"> {
  return {
    agents: listAgents(db).map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      provider: agent.provider,
      model: agent.model,
      enabled: agent.enabled,
      archivedAt: agent.archivedAt,
    })),
  };
}

/**
 * Where this item's work happens, as the card says it (EO-296, ARCHITECTURE.md, "The board").
 *
 * The same resolution the dispatch itself uses, asked one turn earlier —
 * which is the point. A badge derived from anything else would be a
 * second opinion about where an agent is about to be pointed, and the
 * moment the two disagreed the card would be quietly lying about
 * whether a branch was cut.
 *
 * `mode` is null for anything that is not a git workspace, because a
 * mode is a git thing: `none` has no branch to work on and nothing to
 * read, and a kind a pack contributed has whatever it has.
 */
function workspaceBadge(db: Db, item: Item): WorkspaceBadge {
  const resolved = resolveItemWorkspace(db, item);
  if (resolved.kind !== GIT_WORKTREE_KIND) return { kind: resolved.kind, mode: null, label: null };
  // The base branch in read mode, because that is what an agent reading
  // the checkout actually sees — not the item's own, which for a
  // discussion or a container is null and for anything else would name
  // a branch this run is not on.
  const { branch } = gitStateOf(item);
  const label =
    resolved.mode === "read" ? (asGitWorkspace(resolved.workspace)?.config.baseBranch ?? null) : branch;
  return { kind: resolved.kind, mode: resolved.mode, label };
}

function toStepView(step: PipelineStep): PipelineStepView {
  return {
    id: step.id,
    pipelineId: step.pipelineId,
    position: step.position,
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
    // Keep checking (EO-456): the editor sets it and the column head
    // reads it.
    watch: step.watch,
    // What a person may decide here (EO-310). On the wire because the
    // configuration screen edits them beside the routes they are held
    // to — a screen that could not see them would publish a graph with
    // its buttons silently cleared.
    results: step.results,
  };
}

/**
 * The other pipelines a route out of this one may name, each under its own
 * name (EO-69).
 *
 * Grouped rather than flattened because step names collide across
 * pipelines: "Merge" under a "Merge" heading cannot be mistaken for a step
 * of the pipeline being edited, and a bare list of both would make the two
 * indistinguishable.
 *
 * A subset of what `validationInput` gives the validator, never a superset
 * (EO-72): everything offered here saves, and the steps left out — those of
 * a pipeline with no entry step, and the off-dashboard ones that host
 * conversations rather than work — are somewhere a route may still point
 * but nowhere the screen should propose sending work.
 *
 * Scoped to the same project the validator scopes to, and by the same
 * reading of the active project: a picker offering another project's
 * pipeline would be offering a hand-off that `validationInput` then refuses.
 */
function handOffTargets(db: Db, pipelineId: string): IpcResponse<"pipelineSteps:list">["elsewhere"] {
  const names = new Map(listPipelines(db).map((pipeline) => [pipeline.id as string, pipeline.name]));
  const grouped = new Map<string, PipelineStepView[]>();
  for (const step of listRoutableStepsElsewhere(db, pipelineId, activeProjectId(db))) {
    const steps = grouped.get(step.pipelineId) ?? [];
    steps.push(toStepView(step));
    grouped.set(step.pipelineId, steps);
  }
  return [...grouped].map(([id, steps]) => ({ pipelineId: id, pipelineName: names.get(id) ?? id, steps }));
}

/**
 * What each of this pipeline's steps would take with it (EO-167).
 *
 * The editor's answer to "can this step be removed?", and for the items
 * it has to be the same answer `validatePipeline` gives at Publish — so
 * it counts what `validationInput` counts: every item whose `stepId` is
 * this step, archived ones included. The foreign key from `items.stepId`
 * is real whether or not the dashboard is showing the item, so a step
 * holding only archived work is still a step nothing can delete.
 *
 * `running` is the narrower and stronger case, and separate because it
 * asks for a different sentence: an item sitting on a step can be moved,
 * a run in flight on it has to be stopped first. Counted the way
 * `deletePipelineCommand` counts it — the active runs, matched to the
 * items on the step.
 *
 * `routesIn` is the half no validator covers. A route out of another
 * pipeline may name a step of this one (EO-58), and neither the editor
 * nor `validatePipeline` is given that route — both see this pipeline's.
 * Removing its target would leave it pointing at nothing, in a pipeline
 * nobody had open, found when an item next takes that branch.
 *
 * Steps with nothing on them are left out rather than reported as zero:
 * the caller asks by step id and treats a missing entry as empty, which
 * is also what a step the editor invented but has not published is.
 */
function stepOccupancy(db: Db, pipelineId: string): IpcResponse<"pipelineSteps:list">["holds"] {
  const mine = new Set(listStepsForPipeline(db, pipelineId).map((step) => step.id));
  const active = new Set(listActiveRuns(db).map((run) => run.itemId));

  const held = new Map<string, IpcResponse<"pipelineSteps:list">["holds"][number]>();
  const entry = (stepId: string) => {
    const existing = held.get(stepId) ?? { stepId, items: 0, running: 0, archived: 0, routesIn: [] };
    held.set(stepId, existing);
    return existing;
  };

  for (const item of listItemsIncludingArchived(db)) {
    if (item.stepId === null || !mine.has(item.stepId)) continue;
    const step = entry(item.stepId);
    step.items += 1;
    if (active.has(item.id)) step.running += 1;
    // Apart from the total, so the editor can send a person to the
    // Archive for these rather than to a board that cannot show them
    // (EO-230).
    if (item.archivedAt !== null) step.archived += 1;
  }

  // The same list `validationInput` judges the publish against, from the
  // same function: a screen that refuses on one reading while the save
  // refuses on another is worse than either alone.
  for (const handOff of listIncomingHandOffs(db, pipelineId)) {
    entry(handOff.target).routesIn.push({ pipelineName: handOff.pipelineName, label: handOff.label });
  }

  return [...held.values()];
}

/**
 * One pipeline's steps and its routes, together (KAN-59).
 *
 * Together rather than as two channels because the dashboard and the
 * configuration screen both always want both, and fetching them separately
 * would let the two disagree for a render.
 */
/**
 * The workspaces a step of this pipeline may be pointed at (EO-301).
 *
 * The project's own, and nothing else. An installation with no project
 * at all — EO before anything is configured — offers none, which leaves
 * the picker with the two answers that need no row: inherit the
 * ticket's workspace, or no disk.
 */
function pickableWorkspaces(db: Db, projectId: Uuid | null): IpcResponse<"pipelineSteps:list">["workspaces"] {
  if (projectId === null) return [];
  return projectWorkspaceList(db, projectId).map((workspace) => workspaceView(db, workspace));
}

/**
 * What each step's head says stands behind it (EO-312, ARCHITECTURE.md, "What 'EO checks' means on
 * a step", "The board").
 *
 * Resolved per step, because a step names its own workspace since
 * EO-301 and a pipeline that drafts in `scratch` and publishes to a
 * repository is exactly the board this line exists for.
 *
 * A human step is asked a different question and answers it here rather
 * than in the renderer: who is waiting. Silent in solo mode, like every
 * other person on this screen (EO-305) — the head then reads "You
 * approve here", which is true and says nothing about anybody.
 */
function stepVerifications(db: Db, steps: readonly PipelineStep[], inherited: WorkspaceKindSlug): IpcResponse<"pipelineSteps:list">["verification"] {
  const solo = isSoloMode(db);
  return steps.map((step) => {
    const owner = step.ownerPersonId === null || solo ? undefined : getPerson(db, step.ownerPersonId);
    // A group, and *not* silenced by solo mode (EO-323, ARCHITECTURE.md, "Identity"). The
    // silence is about telling one person their own name fifty times;
    // "Support team · anyone claims" is not that. A solo installation
    // that has made a group and pointed a step at it has said something
    // about who is expected to act, and hiding it would leave a head
    // reading "You approve here" on a step that is waiting for a team.
    const group = step.ownerGroupId === null ? undefined : getGroup(db, step.ownerGroupId);
    const waitsOn = group?.name ?? owner?.name ?? null;
    // The step, not only its action: the folder kind checks the files
    // this step says it produces, and a step that says nothing is
    // checked for nothing (EO-312).
    const kind = verificationOfKind(stepWorkspaceKind(db, step, inherited), step);
    return {
      stepId: step.id,
      // Nothing runs on a human step, so there is no action for a kind
      // to answer for and no claim to check. Its head names the person
      // instead, and reporting a workspace's checks beside that would be
      // describing a run that never happens.
      checks: step.type === "user" ? [] : [...kind.checks],
      verifiesAction: step.type === "user" ? false : kind.verifiesAction,
      kindVerifies: step.type === "user" ? false : kind.kindVerifies,
      waitsOn,
      // Absent rather than null when nobody is named, because absent is
      // what every client already understood — see `waitsOnKind`.
      ...(group === undefined ? {} : { waitsOnKind: "group" as const }),
      // The id the picker on the head sends back. Null on a step naming
      // nobody, and null in solo mode on a step naming a person, because
      // the head is silent about that person and a control pre-filled
      // with a name the head does not show is a control that disagrees
      // with the screen it is on.
      waitsOnId: group?.id ?? owner?.id ?? null,
    };
  });
}

export function listPipelineStepViews(
  db: Db,
  input: IpcPayload<"pipelineSteps:list">,
): IpcResponse<"pipelineSteps:list"> {
  // Off-dashboard steps are not columns. `discussion` would otherwise render
  // as one, at the far left, holding every conversation ever had.
  const onBoard = listStepsForPipeline(db, input.pipelineId).filter((step) => !step.offBoard);
  // The project this pipeline is being configured in, which for a
  // project-less one is not its own (EO-72's shape, one field over).
  // `default` is project-less and belongs to *every* project, so
  // asking with its own `null` answered "a pipeline on no disk" about
  // the one pipeline everybody starts with — and took the mode control
  // off every step of it, in a project with a repository attached.
  // The active project is read here for the reason `elsewhere` reads
  // it: it is the context the screen is open in.
  const projectId = getPipeline(db, input.pipelineId)?.projectId ?? activeProjectId(db);
  const inheritedKind = projectWorkspaceKind(db, projectId);
  const { entryRules = [], name: pipelineName = "" } = getPipeline(db, input.pipelineId) ?? {};
  return {
    steps: onBoard.map(toStepView),
    // Where work enters, alongside the graph it enters: the configuration
    // screen edits and publishes all three together (ARCHITECTURE.md, "Vocabulary").
    entryStepId: getPipeline(db, input.pipelineId)?.entryStepId ?? null,
    // What it asks of work coming in (EO-610), and the sentence a refusal
    // would say, composed here for `pipeline_get` and the graph alike.
    entryRules,
    entrySentence: entryRules.length === 0 ? null : entryRefusalSentence(pipelineName, entryRules.map((rule) => entryRuleWords(rule, registry.entryRuleKinds))),
    routes: listRoutesForPipeline(db, input.pipelineId).map((route) => ({
      id: route.id,
      pipelineId: route.pipelineId,
      fromStepId: route.fromStepId,
      resultKey: route.resultKey,
      label: route.label,
      tone: route.tone,
      target: route.target,
      position: route.position,
    })),
    // What the pipeline's steps inherit when they name no disk of their
    // own, resolved above so that the per-step answer below and this one
    // cannot come apart.
    workspaceKind: inheritedKind,
    // What a step's picker may offer (EO-301). The same project the
    // line above resolves, for the same reason and by the same
    // fallback: a project-less pipeline belongs to every project, so the
    // one it is open in is the one whose disks it may name.
    //
    // A subset of what the save will accept, never a superset — the rule
    // `elsewhere` states one line down. `pipeline:save` refuses a step
    // whose workspace is another project's, so offering one here would
    // be the editor proposing something the save rejects.
    workspaces: pickableWorkspaces(db, projectId),
    // What each column head says is checked, and who a human step waits
    // on (EO-312). Only the steps that are columns: nothing draws a head
    // for `discussion`, and `verification_failed` is not a route
    // anybody edits on a step the editor never shows.
    verification: stepVerifications(db, onBoard, inheritedKind),
    elsewhere: handOffTargets(db, input.pipelineId),
    // Off-dashboard steps are counted here even though they are not
    // listed above: the editor never shows `discussion`, never submits
    // it, and so can never remove it — but a caller asking what a step
    // holds should not be told "nothing" about one that holds every
    // conversation ever had.
    holds: stepOccupancy(db, input.pipelineId),
    // Which version this is, what is finishing on older ones, and which
    // steps are ghosts (EO-327, ARCHITECTURE.md, "Publish, lock and versions"). `currentVersion`
    // rather than
    // `ensureCurrentVersion`: reading a board is not a reason to write a
    // row, and a pipeline that has never been saved has nothing to say.
    version: versionView(db, input.pipelineId),
    finishingOn: itemsOnOlderVersions(db, input.pipelineId).map((older) => ({ number: older.number, items: older.items })),
    ghosts: ghostColumns(db, input.pipelineId),
    // Whether a webhook job files here, and whether somebody has let
    // what it delivers be sent on unread (EO-405). The first is derived
    // and decides whether the editor shows the control at all; the
    // second is the stored setting, which the board's header states.
    webhook: {
      entry: pipelineHasWebhookEntry(db, input.pipelineId),
      unattended: getPipeline(db, input.pipelineId)?.webhookUnattended ?? false,
    },
    // Which steps send or create outside EO (EO-584), classified as the
    // webhook refusal classifies them, with the registry the validator
    // judges this project's pipelines by.
    outsideReach: outsideReachForSteps(db, onBoard, registryForProject(db, projectId)),
  };
}

/** This pipeline's current version, with the name to put in "by Dana". */
function versionView(db: Db, pipelineId: string): PipelineVersion | null {
  const version = currentVersion(db, pipelineId);
  if (!version) return null;
  return {
    ...version,
    // Resolved here rather than stored on the row, so a person who
    // changes their name changes it everywhere at once.
    createdByName: versionAuthorName(version.createdBy, (personId) => getPerson(db, personId as Uuid)?.name ?? null),
  };
}

/**
 * The steps drawn to the right of the board because they are not on it
 * any more (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * A retired step holding live work, and nothing else: a retired step
 * with nothing on it is a step that has finished being anything, and the
 * column disappears the moment the last item leaves — which is the
 * whole of the third acceptance criterion.
 *
 * Archived items are not counted, for `itemsOnOlderVersions`' reason:
 * this is a column on a board, and a ghost saying "2 finishing" over an
 * empty space would be a column describing the Archive.
 */
function ghostColumns(db: Db, pipelineId: string): IpcResponse<"pipelineSteps:list">["ghosts"] {
  const live = listItems(db).filter((item) => item.stepId !== null);
  return listRetiredStepsForPipeline(db, pipelineId).flatMap((retired) => {
    const holding = live.filter((item) => item.stepId === retired.step.id).length;
    return holding === 0 ? [] : [{ stepId: retired.step.id, name: retired.step.name, version: retired.retiredVersion, holding }];
  });
}

export function listPipelineViews(
  db: Db,
  input: IpcPayload<"pipelines:list">,
): IpcResponse<"pipelines:list"> {
  // A pipeline whose every step is off-dashboard holds something other than
  // work — the discussion is the shipped one — so it is not
  // something anyone picks from the sidebar. Derived from the steps rather
  // than from a hard-coded `discussion` id, for the reason invariant #7 gives:
  // the next such pipeline should need no code change either.
  const holdsWork = (pipelineId: string) => {
    const steps = listStepsForPipeline(db, pipelineId);
    return steps.length === 0 || steps.some((step) => !step.offBoard);
  };

  return {
    pipelines: listPipelines(db, (input.projectId as Uuid | null | undefined) ?? undefined, input.includeArchived ?? false)
      .filter((pipeline) => (input.includeArchived ? true : holdsWork(pipeline.id)))
      .map((pipeline) => ({
        id: pipeline.id,
        projectId: pipeline.projectId,
        name: pipeline.name,
        icon: pipeline.icon,
        entryStepId: pipeline.entryStepId,
        position: pipeline.position,
        archivedAt: pipeline.archivedAt,
      })),
  };
}

/** Exported for the item-detail handler; `parsedResultOf` keeps A-02's raw/parsed split out of the UI. */
export { parsedResultOf };
