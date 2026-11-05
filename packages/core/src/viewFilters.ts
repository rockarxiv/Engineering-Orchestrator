import type { ItemSummary } from "./ipc-schemas.js";
import type { WaitingOn } from "./people.js";
import type { ViewFilter } from "./schemas/viewSnapshot.js";

/**
 * What a filtered list is showing, decided once (EO-192).
 *
 * Three screens narrow a list in the renderer — Items, Agents and the
 * Inbox — and `view:current` has to answer with *the rows the person can
 * see*, resolved by the handler from the database and never taken from a
 * count the renderer sent. Two implementations of "does this row match"
 * is how the agent comes to be told about seven items while six are on
 * screen, and the person is the one who finds out.
 *
 * So the predicates live here, in the package both sides already share
 * for everything that crosses IPC, and the screen and the handler ask
 * them the same question. The renderer holds the filter *state* and
 * draws the dropdowns; what a filter *means* is this file — and so is
 * what *order* the rows come in, because a listing capped at the first
 * fifty is only the same fifty if both sides sort alike.
 */

/** What an item's latest run means, as a word a filter can match on. */
export type RunStatusKey = "running" | "paused" | "done" | "failed" | "idle";

/**
 * What each of those is called on screen.
 *
 * Here rather than beside the colours because the item list can be
 * *ordered* by status, and an ordering is alphabetical over these words:
 * a handler reproducing the screen's order has to sort by the same
 * strings the screen sorted by. The tones stay in the renderer, which is
 * the only thing about a status that is purely a matter of looks.
 */
export const RUN_STATUS_LABELS: Readonly<Record<RunStatusKey, string>> = {
  running: "Running",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  idle: "Idle",
};

/**
 * `runs.status` as a person reads it.
 *
 * Here rather than beside the labels and the colours because it is half
 * of a filter as well as half of a badge: the list filters on this key
 * and so must anything answering "what is that list showing". Null —
 * nothing has ever run — is idle rather than a state of its own: an
 * item nobody has picked up and one whose run was cancelled are the
 * same thing to look at.
 */
export function runStatusKeyOf(latestRunStatus: string | null): RunStatusKey {
  switch (latestRunStatus) {
    case "running":
    case "queued":
      return "running";
    case "awaiting_input":
      return "paused";
    case "succeeded":
      return "done";
    case "failed":
    case "orphaned":
      return "failed";
    default:
      return "idle";
  }
}

/**
 * The absence of a value is a real answer to "which parent", so it is a
 * real option — and the same string on both sides of the wire.
 */
export const NO_VALUE_FACET = "__none__";

/** A facet that is set to everything is a facet that is not set. */
const ANY = "all";

/**
 * The facet names the item list publishes, and the only ones this
 * understands.
 *
 * Written down so the two sides can be checked against each other: a
 * dropdown added to the screen and not added here would silently widen
 * what the handler thinks is on screen, because an unrecognised facet is
 * ignored below rather than guessed at. The test that compares this list
 * to the screen's own filter keys is what turns that into a build
 * failure.
 */
export const ITEM_FACETS = ["type", "parent", "pipeline", "step", "repository", "status", "attention"] as const;

export type ItemFacet = (typeof ITEM_FACETS)[number];

function facet(filter: ViewFilter, name: ItemFacet): string {
  const value = filter.facets[name];
  return value === undefined || value === "" ? ANY : value;
}

/**
 * Whether an item survives the list's filter.
 *
 * Free text last, and over every field on the row, because everything
 * visible is searchable — what you can see you can find. Matched
 * case-insensitively here rather than by the caller, so the filter can
 * be carried and stored exactly as the person typed it.
 */
export function matchesItemFilter(item: ItemSummary, filter: ViewFilter): boolean {
  // The type facet matches a slug, whatever the project's types are
  // called: `item_types` is data, so there is no list of words here to
  // keep in step with a project (KAN-146).
  if (facet(filter, "type") !== ANY && item.type !== facet(filter, "type")) return false;
  // `parent`, not `feature`: which type holds work is the container flag's
  // answer and a pack may call its container anything (KAN-146). The
  // dropdown is still labelled with the containers it found.
  if (facet(filter, "parent") !== ANY && (item.parentId ?? NO_VALUE_FACET) !== facet(filter, "parent")) return false;
  if (facet(filter, "pipeline") !== ANY && (item.pipelineId ?? NO_VALUE_FACET) !== facet(filter, "pipeline")) return false;
  // By name rather than by id: two pipelines can both have a Reviewer
  // step, and "show me everything in review" means both of them.
  if (facet(filter, "step") !== ANY && (item.stepId === null || item.stepName !== facet(filter, "step"))) return false;
  if (facet(filter, "repository") !== ANY && (item.repositoryId ?? NO_VALUE_FACET) !== facet(filter, "repository")) return false;
  if (facet(filter, "status") !== ANY && runStatusKeyOf(item.latestRunStatus) !== facet(filter, "status")) return false;
  // Only what has an open mention waiting on you (invariant #6 —
  // derived, never stored).
  if (facet(filter, "attention") === "true" && !item.needsAttention) return false;

  const needle = filter.text.trim().toLowerCase();
  if (needle === "") return true;

  // Destructured rather than read through the object, because the
  // branch is one field of the git workspace's state on this item now
  // (KAN-169) and the list below is a list of strings to match, not a
  // place to remember which extension each one came from.
  const { branch } = item.git;
  return [item.key, item.title, branch, item.assigneeName, item.parentTitle, item.repositoryName, item.jiraKey].some(
    (field) => field !== null && field !== undefined && field.toLowerCase().includes(needle),
  );
}

/** True when nothing is filtered out — every facet at `all` and an empty box. */
export function isEmptyItemFilter(filter: ViewFilter): boolean {
  return filter.text.trim() === "" && ITEM_FACETS.every((name) => facet(filter, name) === ANY || facet(filter, name) === "false");
}

/* ── The order the rows come in ────────────────────────────────────── */

/** Every column the item list can be ordered by. */
export type ItemSortKey = "key" | "title" | "type" | "step" | "pipeline" | "repository" | "assignee" | "status" | "priority" | "updated";

const ITEM_SORT_KEYS: readonly ItemSortKey[] = [
  "key",
  "title",
  "type",
  "step",
  "pipeline",
  "repository",
  "assignee",
  "status",
  "priority",
  "updated",
];

/**
 * `EO-9` before `EO-10`.
 *
 * A plain string sort puts EO-10 second, which for a list whose first
 * column is the key is the one ordering nobody means.
 */
const KEY_PARTS = /^(.*?)(\d+)$/;

export function compareKeys(a: string, b: string): number {
  const left = KEY_PARTS.exec(a);
  const right = KEY_PARTS.exec(b);
  if (left && right && left[1] === right[1]) return Number(left[2] ?? 0) - Number(right[2] ?? 0);
  return a.localeCompare(b);
}

/** What a column sorts on. Strings compare case-insensitively; the two numbers compare as numbers. */
function sortValue(item: ItemSummary, key: ItemSortKey, pipelineName: (id: string | null) => string): string | number {
  switch (key) {
    case "key":
      return item.key;
    case "title":
      return item.title.toLowerCase();
    case "type":
      return item.type;
    case "step":
      return item.stepName.toLowerCase();
    case "pipeline":
      return pipelineName(item.pipelineId).toLowerCase();
    case "repository":
      return (item.repositoryName ?? "").toLowerCase();
    case "assignee":
      return (item.assigneeName ?? "").toLowerCase();
    case "status":
      return RUN_STATUS_LABELS[runStatusKeyOf(item.latestRunStatus)];
    case "priority":
      return item.priority;
    case "updated":
      return item.updatedAt;
  }
}

/**
 * The item list in the order the person put it in.
 *
 * Shared with the handler for a reason the filter alone does not cover:
 * the answer lists the first fifty matches and says how many more there
 * are, and "the first fifty" is a different fifty under a different
 * ordering. Sorted by title, the tool would otherwise name fifty rows
 * the person cannot see while the fifty in front of them go unmentioned
 * — and every one of them is a row an agent might be asked to act on.
 */
export function sortItems(
  items: ItemSummary[],
  key: ItemSortKey,
  direction: "asc" | "desc",
  pipelineName: (id: string | null) => string,
): ItemSummary[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    if (key === "key") return sign * compareKeys(a.key, b.key);
    const left = sortValue(a, key, pipelineName);
    const right = sortValue(b, key, pipelineName);
    const order = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
    // Ties fall back to the key so the order is stable rather than
    // whatever the previous sort happened to leave behind.
    return order === 0 ? compareKeys(a.key, b.key) : sign * order;
  });
}

/**
 * A published `<column>:<direction>` read back, or null.
 *
 * Null on a column this build does not order by, rather than a guess:
 * the handler then leaves the rows in the order the query gave them and
 * the answer says the ordering is unknown. Claiming an order EO did not
 * apply is how the first fifty stop being the person's first fifty.
 */
export function parseItemSort(sort: string | null): { key: ItemSortKey; direction: "asc" | "desc" } | null {
  if (sort === null) return null;
  const [column, direction] = sort.split(":");
  if (direction !== "asc" && direction !== "desc") return null;
  const key = ITEM_SORT_KEYS.find((candidate) => candidate === column);
  return key === undefined ? null : { key, direction };
}

/* ── The pipeline board ────────────────────────────────────────────── */

/** Just enough of an item to decide whether the board is showing its card. */
export interface FilterableCard {
  key: string;
  title: string;
  /** Which column it is in, or null for something on no step. */
  stepId: string | null;
  /** Which job filed it, for the job facet. Null for work a person typed (EO-308). */
  origin?: { jobId: string } | null;
}

/**
 * The first facet the board and the archive understand: a step id,
 * narrowing the rows to what that step holds (EO-230).
 *
 * By id rather than by name, unlike the item list's `step` facet: what
 * asks for this is the configure screen refusing to remove a step it
 * knows by id — "Reviewer" could be two steps across pipelines, but the
 * one that cannot go is exactly one row. The board gets the live items
 * and the archive the put-away ones, which is why both read it.
 */
export const STEP_ID_FACET = "step";

/**
 * The second facet both read: a job id, narrowing the rows to the items
 * that job filed (EO-308, `ARCHITECTURE.md`, "The inbox, the archive and jobs").
 *
 * The design's own sentence is what makes this a facet rather than a
 * screen: "a job's past items are **not** a separate history view —
 * they are the board and the archive filtered by job". So the Job page
 * hands the board a filter exactly as the configure screen hands it a
 * step, and there is one board rather than a board and a job-shaped
 * imitation of one.
 */
export const JOB_ID_FACET = "job";

/** Whether a row survives the step-id facet, when one is set. */
function onStep(row: { stepId: string | null }, filter: ViewFilter): boolean {
  const step = filter.facets[STEP_ID_FACET];
  return step === undefined || step === "" || row.stepId === step;
}

/**
 * Whether a row survives the job facet, when one is set.
 *
 * An item with no origin never survives a job filter, which is the
 * point: "exactly the job's items" means the ones it filed and nothing
 * a person typed alongside them.
 */
function fromJob(row: { origin?: { jobId: string } | null }, filter: ViewFilter): boolean {
  const job = filter.facets[JOB_ID_FACET];
  return job === undefined || job === "" || row.origin?.jobId === job;
}

/**
 * Whether the archive is showing this item.
 *
 * The archive has no search box and two facets: the step it was opened
 * for (EO-230), when the configure screen sent somebody here to restore
 * what a step still holds, and the job it was opened for (EO-308), when
 * the Job page sent somebody here to find what that job has filed and
 * put away. Shared with the handler for the reason the
 * board's is — an answer about "the archive" while the screen is
 * narrowed to one step's items is an answer about a screen nobody is
 * looking at.
 */
export function matchesArchiveFilter(
  item: { stepId: string | null; origin?: { jobId: string } | null },
  filter: ViewFilter,
): boolean {
  return onStep(item, filter) && fromJob(item, filter);
}

/**
 * Whether the board is showing this card.
 *
 * Narrower than the item list's search on purpose — the board matches
 * the key and the title and nothing else, because that is what its cards
 * show. Shared for a reason the columns make sharper than any list does:
 * what a step is *holding* is a count, and a count computed over
 * everything while the board draws a narrowed set is a number that
 * contradicts what the person can see. "Move everything out of Review"
 * against the wrong four items is not a misunderstanding anybody
 * notices in time.
 *
 * The step facet narrows first (EO-230): a board opened from a refusal
 * to remove a step shows what that step holds and nothing else, so the
 * items to move are the only cards on it.
 */
export function matchesBoardQuery(card: FilterableCard, filter: ViewFilter): boolean {
  if (!onStep(card, filter)) return false;
  if (!fromJob(card, filter)) return false;
  const needle = filter.text.trim().toLowerCase();
  return needle === "" || card.title.toLowerCase().includes(needle) || card.key.toLowerCase().includes(needle);
}

/* ── The Agents screen ─────────────────────────────────────────────── */

/** The facets the Agents screen publishes, and the only ones this understands. */
export const AGENT_FACETS = ["role", "status", "tab", "archived"] as const;

/**
 * Whether that screen is showing a list of agents at all.
 *
 * The Agents screen has two tabs and only one of them lists agents; the
 * other lists the runtimes they run on. A resolver that read the role
 * and the search box and ignored the tab would answer with agents while
 * the person is looking at runtimes — rows that are real, resolved
 * correctly, and not on screen, which is the one failure this whole
 * feature is built to prevent.
 *
 * A missing facet means yes, so a caller that publishes no tab at all
 * still gets the list it is obviously asking for.
 */
export function showsAgentList(filter: ViewFilter): boolean {
  const tab = filter.facets["tab"];
  return tab === undefined || tab === "agents";
}

/** Just enough of an agent to decide whether this screen is showing it. */
export interface FilterableAgent {
  name: string;
  role: string;
  provider: string;
  enabled: boolean;
  archivedAt: number | null;
}

/**
 * Whether an agent survives the Agents screen's filter.
 *
 * The archived rule is the one worth stating: a retired agent answers
 * neither Enabled nor Disabled — it is past both — so filtering by
 * either leaves it out, and it is hidden entirely unless the person has
 * asked to see archived ones. An answer that listed retired agents among
 * live ones would be describing a screen nobody is looking at.
 */
export function matchesAgentFilter(agent: FilterableAgent, filter: ViewFilter): boolean {
  const facets = filter.facets;
  if (agent.archivedAt !== null && facets["archived"] !== "true") return false;

  const role = facets["role"];
  if (role !== undefined && role !== ANY && agent.role !== role) return false;

  const status = facets["status"];
  if (status !== undefined && status !== ANY && !(agent.archivedAt === null && (status === "enabled") === agent.enabled)) return false;

  const needle = filter.text.trim().toLowerCase();
  return needle === "" || `${agent.name} ${agent.role} ${agent.provider}`.toLowerCase().includes(needle);
}

/**
 * The order the Agents screen lists them in: live first, then retired.
 *
 * Not a sort — the source order inside each group is the listing's own —
 * so this is a partition, which is exactly what the screen does.
 */
export function orderAgents<T extends FilterableAgent>(agents: readonly T[]): T[] {
  return [...agents.filter((agent) => agent.archivedAt === null), ...agents.filter((agent) => agent.archivedAt !== null)];
}

/* ── The Inbox ─────────────────────────────────────────────────────── */

/** The facets the Inbox publishes. One: which of its tabs is open. */
export const INBOX_FACETS = ["category"] as const;

/** Just enough of an inbox item to decide whether the screen is showing it. */
export interface FilterableInboxItem {
  itemKey: string;
  itemTitle: string;
  body: string;
  kind: string;
  blocking: boolean;
  createdAt: number;
  /**
   * Who the row waits on (EO-305, ARCHITECTURE.md, "The inbox, the archive and jobs") — what the
   * Unassigned filter
   * asks about, and the label the row reads.
   */
  waitingOn: WaitingOn;
}

/**
 * Whether an inbox item survives the category the person has open.
 *
 * The distinction the design insists on keeping straight, and it is the reason
 * this is not a one-line predicate: a mention does not by itself block an
 * item. An item is blocked because its run *ended awaiting a reply*,
 * which is what `blocking` carries. Conflating the two makes an FYI look
 * like a stoppage and hides the real ones among them.
 */
export function matchesInboxFilter(item: FilterableInboxItem, filter: ViewFilter): boolean {
  const category = filter.facets["category"] ?? "all";
  const inCategory =
    category === "all"
      ? true
      : category === "blocking"
        ? item.blocking
        : category === "mentions"
          ? !item.blocking && item.kind !== "note"
          : category === "fyi"
            ? !item.blocking && item.kind === "note"
            : // The design's Unassigned filter: the work on a human step that
              // nobody has picked up. Never anything in solo mode, where
              // arriving on a human step assigns the one person there is.
              category === "unassigned"
              ? item.waitingOn.who === "unclaimed"
              : true;
  if (!inCategory) return false;

  const needle = filter.text.trim().toLowerCase();
  return needle === "" || `${item.itemKey} ${item.itemTitle} ${item.body}`.toLowerCase().includes(needle);
}

/** The order the inbox lists them in: newest first. */
export function orderInbox<T extends FilterableInboxItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => b.createdAt - a.createdAt);
}
