import { describe, expect, it } from "vitest";
import { NO_GIT_STATE } from "./itemExtensions.js";
import type { ItemSummary } from "./ipc-schemas.js";
import {
  compareKeys,
  isEmptyItemFilter,
  matchesAgentFilter,
  matchesArchiveFilter,
  matchesBoardQuery,
  matchesInboxFilter,
  matchesItemFilter,
  NO_VALUE_FACET,
  orderAgents,
  orderInbox,
  parseItemSort,
  runStatusKeyOf,
  showsAgentList,
  sortItems,
  ITEM_FACETS,
} from "./viewFilters.js";
import { waitingOnLabel } from "./people.js";
import type { ViewFilter } from "./schemas/viewSnapshot.js";

/**
 * One definition of what a filtered list is showing (EO-192).
 *
 * The screen filters rows in the renderer and the handler answering
 * "what is this person looking at" filters them again in the main
 * process. Two implementations would disagree eventually, and the way
 * anyone would find out is an agent acting on seven items while six
 * are on screen. So both ask this.
 */
function item(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: "019fb8c6-de92-7a41-9c33-4471f0c2b1de",
    key: "EO-42",
    type: "story",
    typeLabel: "Story",
    container: false,
    parentId: null,
    parentKey: null,
    parentTitle: null,
    repositoryId: "repo-1",
    repositoryName: "api",
    projectId: "project-1",
    title: "Add rate limiting",
    pipelineId: "default",
    stepId: "todo",
    pipelineVersion: null,
    stepName: "To Do",
    progress: null,
    priority: 0,
    git: NO_GIT_STATE,
    workspace: { kind: "git-worktree", mode: "isolated", label: null },
    jiraKey: null,
    jiraUrl: null,
    updatedAt: 0,
    stepEnteredAt: 0,
    heldAt: null,
    origin: null,
    needsAttention: false,
    atTerminalStep: false,
    openDependencyCount: 0,
    openDependencyGates: [],
    latestRunStatus: null,
    assigneeName: null,
    assigneePerson: null,
    claimable: false,
    preview: false,
    ...overrides,
  };
}

function filter(overrides: Partial<ViewFilter> = {}): ViewFilter {
  return { text: "", facets: {}, ...overrides };
}

describe("what an item filter matches", () => {
  it("matches everything when nothing is set", () => {
    expect(matchesItemFilter(item(), filter())).toBe(true);
    expect(isEmptyItemFilter(filter())).toBe(true);
  });

  it("searches every field on the row, case-insensitively", () => {
    // What you can see you can find: the key, the title, the branch, who
    // is on it, the feature, the repository and the Jira issue.
    expect(matchesItemFilter(item(), filter({ text: "RATE" }))).toBe(true);
    expect(matchesItemFilter(item({ git: { branch: "rockarxiv/EO-42", pullRequest: null, baseBranch: null, namedBranch: false, attachedAt: null, reference: null, reviewers: null } }), filter({ text: "rockarxiv" }))).toBe(true);
    expect(matchesItemFilter(item({ assigneeName: "Orion" }), filter({ text: "orion" }))).toBe(true);
    expect(matchesItemFilter(item({ jiraKey: "KAN-7" }), filter({ text: "kan-7" }))).toBe(true);
    expect(matchesItemFilter(item(), filter({ text: "nothing like this" }))).toBe(false);
  });

  it("trims the text, so a trailing space is not a filter nothing matches", () => {
    expect(matchesItemFilter(item(), filter({ text: "  rate  " }))).toBe(true);
  });

  it("treats a facet at `all`, or absent, as no filter", () => {
    expect(matchesItemFilter(item(), filter({ facets: { type: "all" } }))).toBe(true);
    expect(matchesItemFilter(item(), filter({ facets: {} }))).toBe(true);
  });

  it("matches a step by name, so one word covers the same column on two pipelines", () => {
    expect(matchesItemFilter(item({ stepName: "Review" }), filter({ facets: { step: "Review" } }))).toBe(true);
    expect(matchesItemFilter(item({ stepName: "To Do" }), filter({ facets: { step: "Review" } }))).toBe(false);
  });

  it("treats the absence of a value as a real answer", () => {
    expect(matchesItemFilter(item({ parentId: null }), filter({ facets: { parent: NO_VALUE_FACET } }))).toBe(true);
    expect(matchesItemFilter(item({ parentId: "feature-1" }), filter({ facets: { parent: NO_VALUE_FACET } }))).toBe(false);
  });

  it("filters on what a run means rather than on the raw status word", () => {
    expect(matchesItemFilter(item({ latestRunStatus: "queued" }), filter({ facets: { status: "running" } }))).toBe(true);
    expect(matchesItemFilter(item({ latestRunStatus: "orphaned" }), filter({ facets: { status: "failed" } }))).toBe(true);
    expect(matchesItemFilter(item({ latestRunStatus: null }), filter({ facets: { status: "idle" } }))).toBe(true);
  });

  it("filters on what is waiting for a person, which is derived and never stored", () => {
    expect(matchesItemFilter(item({ needsAttention: false }), filter({ facets: { attention: "true" } }))).toBe(false);
    expect(matchesItemFilter(item({ needsAttention: false }), filter({ facets: { attention: "false" } }))).toBe(true);
  });

  it("ignores a facet it does not know rather than guessing at it", () => {
    // Deliberate, and the reason `ITEM_FACETS` is written down and
    // checked against the screen: a dropdown added there and not here
    // would otherwise widen what the agent is told is on screen, and the
    // test that compares the two lists is what makes that a build
    // failure instead.
    expect(matchesItemFilter(item(), filter({ facets: { colour: "blue" } }))).toBe(true);
    expect(ITEM_FACETS).not.toContain("colour");
  });
});

describe("what a run's status means", () => {
  it("reads nothing-has-run as idle rather than as a state of its own", () => {
    expect(runStatusKeyOf(null)).toBe("idle");
    expect(runStatusKeyOf("cancelled")).toBe("idle");
  });

  it("collapses the pairs a person would not tell apart", () => {
    expect(runStatusKeyOf("queued")).toBe(runStatusKeyOf("running"));
    expect(runStatusKeyOf("orphaned")).toBe(runStatusKeyOf("failed"));
    expect(runStatusKeyOf("awaiting_input")).toBe("paused");
    expect(runStatusKeyOf("succeeded")).toBe("done");
  });
});

/**
 * The order, which matters for the same reason the filter does — and for
 * one more (EO-192).
 *
 * The answer lists the first fifty matches and says how many more there
 * are. "The first fifty" is a different fifty under a different
 * ordering, so a handler that filtered correctly and sorted differently
 * would name fifty rows the person cannot see while the fifty in front
 * of them go unmentioned.
 */
describe("the order the item list is in", () => {
  const named = (title: string, overrides: Partial<ItemSummary> = {}) => item({ key: `EO-${title.length}`, title, ...overrides });
  const noPipelines = () => "—";

  it("puts EO-9 before EO-10, which a string sort does not", () => {
    expect(compareKeys("EO-9", "EO-10")).toBeLessThan(0);
  });

  it("falls back to a plain comparison across different prefixes", () => {
    expect(["WEB-2", "API-3"].sort(compareKeys)).toEqual(["API-3", "WEB-2"]);
  });

  it("orders by a column, in both directions", () => {
    const rows = [named("Zebra"), named("Alpha"), named("Middle")];

    expect(sortItems(rows, "title", "asc", noPipelines).map((row) => row.title)).toEqual(["Alpha", "Middle", "Zebra"]);
    expect(sortItems(rows, "title", "desc", noPipelines).map((row) => row.title)).toEqual(["Zebra", "Middle", "Alpha"]);
  });

  it("breaks ties on the key, so the order is stable rather than whatever came before", () => {
    const rows = [item({ key: "EO-2", type: "story" }), item({ key: "EO-1", type: "story" })];

    expect(sortItems(rows, "type", "asc", noPipelines).map((row) => row.key)).toEqual(["EO-1", "EO-2"]);
  });

  it("orders by what a status means to a person, not by the raw word", () => {
    const rows = [item({ key: "EO-1", latestRunStatus: "queued" }), item({ key: "EO-2", latestRunStatus: "awaiting_input" })];

    // "Paused" before "Running" — the words on screen, which is what an
    // ordering by that column is alphabetical over.
    expect(sortItems(rows, "status", "asc", noPipelines).map((row) => row.key)).toEqual(["EO-2", "EO-1"]);
  });

  it("reads a published sort back, and refuses one it cannot honour", () => {
    expect(parseItemSort("updated:desc")).toEqual({ key: "updated", direction: "desc" });
    expect(parseItemSort(null)).toBeNull();
    // Better than a guess: a handler told the column is unknown can say
    // the rows are in no particular order instead of implying they are
    // the person's first fifty.
    expect(parseItemSort("whatever:asc")).toBeNull();
    expect(parseItemSort("updated:sideways")).toBeNull();
    expect(parseItemSort("updated")).toBeNull();
  });
});

/**
 * The board's search, which is narrower than the list's on purpose.
 *
 * The cards show a key and a title, so those are what it matches. It
 * matters more than a list's filter because what it narrows is a
 * *count*: a column reported as holding four while the board draws one
 * is a number that contradicts the screen.
 */
describe("what the pipeline board is showing", () => {
  const card = { key: "EO-42", title: "Add rate limiting", stepId: "review" };

  it("shows everything when nothing has been typed", () => {
    expect(matchesBoardQuery(card, filter())).toBe(true);
    expect(matchesBoardQuery(card, filter({ text: "   " }))).toBe(true);
  });

  it("matches the title and the key, case-insensitively", () => {
    expect(matchesBoardQuery(card, filter({ text: "RATE" }))).toBe(true);
    expect(matchesBoardQuery(card, filter({ text: "eo-42" }))).toBe(true);
    expect(matchesBoardQuery(card, filter({ text: "nothing like this" }))).toBe(false);
  });

  it("does not match on anything the card does not show", () => {
    // The item list searches the branch, the assignee and the Jira key
    // too. The board draws none of those, so matching them here would
    // leave a card counted and not drawn.
    expect(matchesBoardQuery(card, filter({ text: "rockarxiv" }))).toBe(false);
  });

  /**
   * Opened from a refusal to remove a step (EO-230), the board shows
   * what that step holds and nothing else — by id, since that is how
   * the configure screen knows the step that cannot go.
   */
  it("narrows to one step's cards when the step facet is set", () => {
    expect(matchesBoardQuery(card, filter({ facets: { step: "review" } }))).toBe(true);
    expect(matchesBoardQuery(card, filter({ facets: { step: "implement" } }))).toBe(false);
    expect(matchesBoardQuery({ ...card, stepId: null }, filter({ facets: { step: "review" } }))).toBe(false);
    // Both narrow: the search box still applies inside the column.
    expect(matchesBoardQuery(card, filter({ text: "nothing like this", facets: { step: "review" } }))).toBe(false);
  });

  /**
   * A job's past items are the board filtered by job, and not a second
   * list (EO-308, the original design). "Exactly the job's items" is the whole of the
   * criterion: an item a person typed beside them is not one of them,
   * however similar it looks.
   */
  it("narrows to one job's cards when the job facet is set", () => {
    const filed = { ...card, origin: { jobId: "job-1" } };
    expect(matchesBoardQuery(filed, filter({ facets: { job: "job-1" } }))).toBe(true);
    expect(matchesBoardQuery(filed, filter({ facets: { job: "job-2" } }))).toBe(false);
    // Typed by a person, so it belongs to no job and survives no job filter.
    expect(matchesBoardQuery(card, filter({ facets: { job: "job-1" } }))).toBe(false);
    // Both facets narrow, and so does the search box.
    expect(matchesBoardQuery(filed, filter({ facets: { job: "job-1", step: "implement" } }))).toBe(false);
    expect(matchesBoardQuery(filed, filter({ text: "nothing like this", facets: { job: "job-1" } }))).toBe(false);
  });
});

/**
 * The archive's two facets: the step it was opened for (EO-230), when
 * the configure screen sent somebody to restore what a step still holds
 * there, and the job it was opened for (EO-308), when the Job page sent
 * somebody to find what that job filed and somebody put away. The same
 * two keys the board reads, and by id for the same reason.
 */
describe("what the archive is showing", () => {
  it("shows everything until a step is named, then only that step's rows", () => {
    expect(matchesArchiveFilter({ stepId: "review" }, filter({ facets: { tab: "items" } }))).toBe(true);
    expect(matchesArchiveFilter({ stepId: "review" }, filter({ facets: { step: "review" } }))).toBe(true);
    expect(matchesArchiveFilter({ stepId: "todo" }, filter({ facets: { step: "review" } }))).toBe(false);
    expect(matchesArchiveFilter({ stepId: null }, filter({ facets: { step: "review" } }))).toBe(false);
  });

  it("narrows to one job's rows when the job facet is set", () => {
    const filed = { stepId: "review", origin: { jobId: "job-1" } };
    expect(matchesArchiveFilter(filed, filter({ facets: { job: "job-1" } }))).toBe(true);
    expect(matchesArchiveFilter(filed, filter({ facets: { job: "job-2" } }))).toBe(false);
    expect(matchesArchiveFilter({ stepId: "review" }, filter({ facets: { job: "job-1" } }))).toBe(false);
  });
});

describe("what the Agents screen is showing", () => {
  const agent = (overrides: Partial<Parameters<typeof matchesAgentFilter>[0]> = {}) => ({
    name: "Orion",
    role: "implementer",
    provider: "claude",
    enabled: true,
    archivedAt: null,
    ...overrides,
  });

  it("searches the name, the role and the provider", () => {
    expect(matchesAgentFilter(agent(), filter({ text: "ORI" }))).toBe(true);
    expect(matchesAgentFilter(agent(), filter({ text: "claude" }))).toBe(true);
    expect(matchesAgentFilter(agent(), filter({ text: "nothing like this" }))).toBe(false);
  });

  it("narrows by role and by whether an agent is switched on", () => {
    expect(matchesAgentFilter(agent(), filter({ facets: { role: "reviewer" } }))).toBe(false);
    expect(matchesAgentFilter(agent({ enabled: false }), filter({ facets: { status: "enabled" } }))).toBe(false);
    expect(matchesAgentFilter(agent({ enabled: false }), filter({ facets: { status: "disabled" } }))).toBe(true);
  });

  /**
   * A retired agent is past both Enabled and Disabled (EO-186), so it is
   * hidden unless the box is ticked and answers neither status filter. A
   * handler that ignored this would report agents nobody can see.
   */
  it("hides a retired agent unless the screen says it is showing them", () => {
    const retired = agent({ archivedAt: 1 });

    expect(matchesAgentFilter(retired, filter())).toBe(false);
    expect(matchesAgentFilter(retired, filter({ facets: { archived: "true" } }))).toBe(true);
    expect(matchesAgentFilter(retired, filter({ facets: { archived: "true", status: "enabled" } }))).toBe(false);
    expect(matchesAgentFilter(retired, filter({ facets: { archived: "true", status: "disabled" } }))).toBe(false);
  });

  it("says whether that screen is listing agents at all", () => {
    // Two tabs, one list. A resolver that read the role and the search
    // box and ignored the tab would answer with agents while the person
    // is looking at runtimes.
    expect(showsAgentList(filter({ facets: { tab: "agents" } }))).toBe(true);
    expect(showsAgentList(filter({ facets: { tab: "runtimes" } }))).toBe(false);
    // A caller that publishes no tab is asking for the obvious list.
    expect(showsAgentList(filter())).toBe(true);
  });

  it("lists the live ones before the retired ones, as the screen does", () => {
    const rows = [agent({ name: "Retired", archivedAt: 1 }), agent({ name: "Live" })];

    expect(orderAgents(rows).map((row) => row.name)).toEqual(["Live", "Retired"]);
  });
});

describe("what the Inbox is showing", () => {
  const entry = (overrides: Partial<Parameters<typeof matchesInboxFilter>[0]> = {}): Parameters<typeof matchesInboxFilter>[0] => ({
    itemKey: "EO-1",
    itemTitle: "Rate limiting",
    body: "Which limit did you want?",
    kind: "question",
    blocking: false,
    createdAt: 0,
    waitingOn: { who: "you" },
    ...overrides,
  });

  it("shows everything under All", () => {
    expect(matchesInboxFilter(entry(), filter({ facets: { category: "all" } }))).toBe(true);
    expect(matchesInboxFilter(entry(), filter())).toBe(true);
  });

  /**
   * The distinction the design insists on keeping straight: a mention does not
   * by itself block an item. Conflating the two makes an FYI look like
   * a stoppage and hides the real ones among them.
   */
  it("keeps blocking apart from merely mentioned", () => {
    expect(matchesInboxFilter(entry({ blocking: true }), filter({ facets: { category: "blocking" } }))).toBe(true);
    expect(matchesInboxFilter(entry({ blocking: false }), filter({ facets: { category: "blocking" } }))).toBe(false);

    expect(matchesInboxFilter(entry({ blocking: false, kind: "question" }), filter({ facets: { category: "mentions" } }))).toBe(true);
    expect(matchesInboxFilter(entry({ blocking: true, kind: "question" }), filter({ facets: { category: "mentions" } }))).toBe(false);

    expect(matchesInboxFilter(entry({ kind: "note" }), filter({ facets: { category: "fyi" } }))).toBe(true);
    expect(matchesInboxFilter(entry({ kind: "question" }), filter({ facets: { category: "fyi" } }))).toBe(false);
  });

  /**
   * The design's Unassigned filter: work on a human step that nobody has
   * taken. Not "no agent has run yet" — an item an agent is working on
   * is nobody's to claim — and never anything in solo mode, where
   * arriving on a human step assigns the one person there is.
   */
  it("lists what nobody has claimed under Unassigned", () => {
    const unassigned = filter({ facets: { category: "unassigned" } });

    expect(matchesInboxFilter(entry({ waitingOn: { who: "unclaimed" } }), unassigned)).toBe(true);
    expect(matchesInboxFilter(entry({ waitingOn: { who: "you" } }), unassigned)).toBe(false);
    expect(matchesInboxFilter(entry({ waitingOn: { who: "person", personId: "p2", name: "Anna Ruiz" } }), unassigned)).toBe(false);

    // And All still means all of them.
    expect(matchesInboxFilter(entry({ waitingOn: { who: "unclaimed" } }), filter())).toBe(true);
  });

  it("says who each row waits on, in §6.4's three sentences", () => {
    expect(waitingOnLabel({ who: "you" })).toBe("Waiting on you");
    expect(waitingOnLabel({ who: "person", personId: "p2", name: "Anna Ruiz" })).toBe("Waiting on Anna");
    expect(waitingOnLabel({ who: "unclaimed" })).toBe("Unclaimed");
  });

  it("searches the item and the message together", () => {
    expect(matchesInboxFilter(entry(), filter({ text: "rate" }))).toBe(true);
    expect(matchesInboxFilter(entry(), filter({ text: "which limit" }))).toBe(true);
    expect(matchesInboxFilter(entry(), filter({ text: "EO-1" }))).toBe(true);
    expect(matchesInboxFilter(entry(), filter({ text: "nothing like this" }))).toBe(false);
  });

  it("lists the newest first, as the screen does", () => {
    const rows = [entry({ itemKey: "old", createdAt: 1 }), entry({ itemKey: "new", createdAt: 2 })];

    expect(orderInbox(rows).map((row) => row.itemKey)).toEqual(["new", "old"]);
  });
});
