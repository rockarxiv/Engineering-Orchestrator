import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { sql } from "drizzle-orm";
import { ipcContract, jiraStateOf, uuidv7, type Agent, type Item, type Uuid } from "@eo/core";
import { tick } from "@eo/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  addDependency,
  createJiraConnection,
  createRoute,
  appendSyncedRunEvents,
  createRun,
  createRunEventBuffer,
  getItem,
  getSetting,
  isJiraPullPending,
  listAgents,
  listCommentsForItem,
  needsAttention,
  pendingPushesForItem,
  postComment,
  projectForWorkspace,
  saveJiraBinding,
  setItemAssignee,
  setJiraSync,
  transitionItem,
  adoptProjectlessItems,
  updateRun,
  updateItem,
  archivePipeline,
  createPipeline,
  createProject,
  createStep,
  setEntryStep,
  syncItemTypes,
  updateStep,
} from "../db/repos/index.js";
import type { Workspace } from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import type { JiraContext } from "../packs/developer/jira/connection.js";
import { pullItem } from "../packs/developer/jira/pull.js";
import { handleIpcRequest } from "./handleRequest.js";
import { createFakeProvider } from "../providers/fake.js";
import { ENGINE_PAUSED_KEY } from "../engineActivity.js";
import { AttachmentStorage } from "../attachments/storage.js";

import { validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import {
  cancelRun,
  engineStatus,
  holdItem,
  moveItem,
  pauseEngine,
  postHumanComment,
  readSettings,
  resumeEngine,
  resumeHeldItem,
  setArchived,
  setPinned,
  updateItemText,
  writeSettings,
  type EngineHandle,
} from "./domainCommands.js";
import { createItemLock } from "../supervisor/itemLock.js";
import { setActiveProjectCommand } from "./projectCommands.js";
import { bridgePushChannels } from "./push.js";
import { webContentsTransport } from "../platform/webContentsTransport.js";
import { getItemDetail, listAgentViews, listArchivedSummaries, listInbox, listRunEventsPage, listItemSummaries, listPipelineStepViews, listPipelineViews, listWaitSteps } from "./domainQueries.js";
import { buildTickInput } from "../supervisor/buildTickInput.js";

let handle: DbHandle;
let item: Item;
let implementer: Agent;

function fakeEngine(): EngineHandle & { resumeItem: ReturnType<typeof vi.fn> } {
  let paused = false;
  return {
    resumeItem: vi.fn(async () => {}),
    cancelRun: vi.fn(),
    steerRun: vi.fn(async () => "no-live-run" as const),
    pause: vi.fn(() => {
      paused = true;
    }),
    resume: vi.fn(() => {
      paused = false;
    }),
    isPaused: () => paused,
    // The real supervisor answers this from the board *and* from the
    // rules the installed pack supplies (KAN-161). Nothing here is about
    // an item the scheduler would turn away, so the fake says so.
    dispatchBlockerFor: () => null,
    activeRunCount: () => 0,
    finishingRunCount: () => 0,
    notifyStateChange: vi.fn(),
    itemLock: createItemLock(),
    // Nothing in these tests is a record answering another device.
    offerWork: async () => [],
  };
}

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo", body: "Throttle it." });
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
});

afterEach(() => {
  handle.close();
});

describe("items:list", () => {
  it("derives needsAttention at query time rather than reading a stored flag (§6)", async () => {
    expect(listItemSummaries(handle.db, null).items[0]?.needsAttention).toBe(false);

    postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: implementer.id },
      body: "@user which limit?",
      mentions: [{ type: "human" }],
      kind: "escalation",
    });
    expect(listItemSummaries(handle.db, null).items[0]?.needsAttention).toBe(true);

    // Answering clears it — a stored boolean is exactly what drifts here.
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "100 a minute." });
    expect(listItemSummaries(handle.db, null).items[0]?.needsAttention).toBe(false);
  });

  it("counts only dependencies that are not yet terminal", async () => {
    const done = createTestItem(handle.db, { type: "story", title: "Done", stepId: "ready_to_merge" });
    const pending = createTestItem(handle.db, { type: "story", title: "Pending", stepId: "todo" });
    addDependency(handle.db, item.id, done.id);
    addDependency(handle.db, item.id, pending.id);

    const summary = listItemSummaries(handle.db, null).items.find((entry) => entry.id === item.id);
    expect(summary?.openDependencyCount).toBe(1); // the finished one no longer blocks
  });

  /**
   * A dependency the board cannot see is still judged by whether it
   * finished (EO-335).
   *
   * `listItemsForProject` scopes by project and `listAllDependencies`
   * scopes by nothing, so a cross-project edge resolves to nothing in
   * this listing's own rows. Reading that miss as "has not finished"
   * put a permanent 1 on the card — and the same miss, for the same
   * reason, is what archiving a finished dependency used to cause.
   */
  it("judges a dependency on another project by whether it finished, not by whether this board can see it", async () => {
    const other = attachWorkspace(handle.db, { name: "other", keyPrefix: "OTH", repoPath: "/tmp/other" });
    const otherProject = projectForWorkspace(handle.db, other.id)!;
    const shipped = createTestItem(handle.db, { type: "story", title: "Shipped elsewhere", stepId: "ready_to_merge", projectId: otherProject.id, workspaceId: other.id });
    addDependency(handle.db, item.id, shipped.id);

    const countFor = (id: Uuid): number | undefined => listItemSummaries(handle.db, null).items.find((entry) => entry.id === id)?.openDependencyCount;
    expect(countFor(item.id)).toBe(0);

    // And the mirror: off this board and *not* finished still counts.
    const running = createTestItem(handle.db, { type: "story", title: "Still going elsewhere", stepId: "todo", projectId: otherProject.id, workspaceId: other.id });
    addDependency(handle.db, item.id, running.id);
    expect(countFor(item.id)).toBe(1);
  });

  it("reports the most recent run's status", async () => {
    const first = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement" });
    updateRun(handle.db, first.id, { status: "failed", startedAt: 1_000 });
    const second = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement" });
    updateRun(handle.db, second.id, { status: "running", startedAt: 2_000 });

    expect(listItemSummaries(handle.db, null).items.find((entry) => entry.id === item.id)?.latestRunStatus).toBe("running");
  });

  it("reports the most recent run's status when two of them started in the same millisecond", () => {
    // `started_at` alone does not order these, and the card reads the
    // first of the sorted list for both its status and its assignee. Ids
    // are minted monotonically to break exactly this tie; without it the
    // card can show the older run and call a working item failed.
    const first = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement" });
    updateRun(handle.db, first.id, { status: "failed", startedAt: 5_000 });
    const second = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement" });
    updateRun(handle.db, second.id, { status: "running", startedAt: 5_000 });

    expect(listItemSummaries(handle.db, null).items.find((entry) => entry.id === item.id)?.latestRunStatus).toBe("running");
  });
});

/**
 * Where the work happens, as the card says it (EO-296, ARCHITECTURE.md, "The board").
 *
 * Derived here rather than stored, and derived by the same function the
 * dispatch itself asks — a badge reading "reads the repository, changes
 * nothing" over a run that cut a branch would be worse than no badge at
 * all, and two derivations is how that happens.
 */
describe("the workspace badge on a card", () => {
  it("says `none` with nothing to show for an item with no workspace anywhere", () => {
    // What used to be EO's own launch directory and a note in the thread
    // explaining that it was. The card carries the absence now.
    const summary = listItemSummaries(handle.db, null).items.find((entry) => entry.id === item.id);

    expect(summary?.workspace).toEqual({ kind: "none", mode: null, label: null });
  });

  it("names the branch for a step that works on one, once there is a branch to name", () => {
    const repository = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/eo/api", baseBranch: "main" });
    const story = createTestItem(handle.db, { type: "story", title: "Rate limit", stepId: "todo", workspaceId: repository.id });

    // Before its first dispatch there is no branch, and inventing one
    // would be showing a person something that does not exist.
    expect(listItemSummaries(handle.db, null).items.find((entry) => entry.id === story.id)?.workspace).toEqual({
      kind: "git-worktree",
      mode: "isolated",
      label: null,
    });

    updateItem(handle.db, story.id, { git: { branch: "eo/API-1" } });
    expect(listItemSummaries(handle.db, null).items.find((entry) => entry.id === story.id)?.workspace).toEqual({
      kind: "git-worktree",
      mode: "isolated",
      label: "eo/API-1",
    });
  });

  it("names the base branch for a step that only reads, which is what an agent reading the checkout sees", () => {
    const repository = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/eo/api", baseBranch: "trunk" });
    const story = createTestItem(handle.db, { type: "story", title: "Answer a question", stepId: "todo", workspaceId: repository.id });
    updateStep(handle.db, "todo", { workspaceMode: "read" });

    expect(listItemSummaries(handle.db, null).items.find((entry) => entry.id === story.id)?.workspace).toEqual({
      kind: "git-worktree",
      mode: "read",
      label: "trunk",
    });
  });

  it("says read for a container, which never carries its own code changes whatever its step says", () => {
    const repository = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/eo/api", baseBranch: "main" });
    const project = projectForWorkspace(handle.db, repository.id)!;
    // No workspace of its own: a feature spanning a project's
    // repositories, which is the ordinary case rather than a broken one.
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: "todo", projectId: project.id });

    const summary = listItemSummaries(handle.db, project.id).items.find((entry) => entry.id === feature.id);
    expect(summary?.workspace).toEqual({ kind: "git-worktree", mode: "read", label: "main" });
  });
});

/**
 * How long a card has stood on its step (EO-570): from its latest
 * arrival there, not from its latest edit — and from its creation when
 * it has never moved, because creating an item writes no transition.
 */
describe("the time an item entered its step", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const summaryOf = (id: string) => listItemSummaries(handle.db, null).items.find((entry) => entry.id === id);

  it("is its creation for an item that has never moved, and an assignee or workspace change leaves it there", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const story = createTestItem(handle.db, { type: "story", title: "Never moved", stepId: "todo" });
    expect(summaryOf(story.id)?.stepEnteredAt).toBe(story.createdAt);

    vi.setSystemTime(2_000_000);
    setItemAssignee(handle.db, story.id, null);
    const repository = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/eo/api" });
    adoptProjectlessItems(handle.db, repository.id, projectForWorkspace(handle.db, repository.id)!.id);

    const after = listItemSummaries(handle.db, projectForWorkspace(handle.db, repository.id)!.id).items.find((entry) => entry.id === story.id);
    expect(after?.repositoryId).toBe(repository.id);
    expect(after?.updatedAt).toBe(2_000_000);
    expect(after?.stepEnteredAt).toBe(1_000_000);
  });

  it("is the latest arrival on the step it stands on, not an earlier one or a later edit", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const story = createTestItem(handle.db, { type: "story", title: "Moves", stepId: "todo" });

    vi.setSystemTime(2_000_000);
    transitionItem(handle.db, { itemId: story.id, toStepId: "review", actor: "human" });
    expect(summaryOf(story.id)?.stepEnteredAt).toBe(2_000_000);

    vi.setSystemTime(3_000_000);
    transitionItem(handle.db, { itemId: story.id, toStepId: "todo", actor: "human" });
    vi.setSystemTime(4_000_000);
    setItemAssignee(handle.db, story.id, null);
    updateItem(handle.db, story.id, { title: "Moved back" });

    const summary = summaryOf(story.id);
    expect(summary?.updatedAt).toBe(4_000_000);
    expect(summary?.stepEnteredAt).toBe(3_000_000);
  });

  it("is read for the whole board in one query, not one per card", () => {
    for (const title of ["One", "Two", "Three", "Four"]) {
      const story = createTestItem(handle.db, { type: "story", title, stepId: "todo" });
      transitionItem(handle.db, { itemId: story.id, toStepId: "review", actor: "human" });
    }
    const client = (handle.db as unknown as { $client: { prepare: (source: string) => unknown } }).$client;
    const prepare = client.prepare.bind(client);
    const seen: string[] = [];
    client.prepare = (source: string) => {
      seen.push(source);
      return prepare(source);
    };
    let summaries: ReturnType<typeof listItemSummaries>["items"];
    try {
      summaries = listItemSummaries(handle.db, null).items;
    } finally {
      client.prepare = prepare;
    }

    expect(summaries.filter((entry) => entry.stepId === "review")).toHaveLength(4);
    expect(seen.filter((source) => source.includes(`from "transitions"`))).toHaveLength(1);
  });
});

describe("off-project states stay off every screen that shows work", () => {
  // A discussion is an item so that it can host runs,
  // run_events and cost. Everything below is what stops that
  // implementation detail leaking into the product.
  function conversation(): Item {
    return createTestItem(handle.db, { type: "feature", title: "Conversation", stepId: "discussion" });
  }

  it("leaves conversations out of the project", () => {
    const chat = conversation();

    expect(listItemSummaries(handle.db, null).items.map((entry) => entry.id)).not.toContain(chat.id);
    expect(listItemSummaries(handle.db, null).items.map((entry) => entry.id)).toContain(item.id);
  });

  it("leaves them out of the archive once one is closed", () => {
    const chat = conversation();
    setArchived(handle.db, { itemId: chat.id, archived: true });

    expect(listArchivedSummaries(handle.db, null).items.map((entry) => entry.id)).not.toContain(chat.id);
  });

  it("does not render `discussion` as a project column", () => {
    expect(listPipelineStepViews(handle.db, { pipelineId: "default" }).steps.map((state) => state.id)).not.toContain("discussion");
  });

  it("still offers an off-board step as one to wait for, and never the terminal one (EO-779)", () => {
    // A step the board draws no column for is as valid a gate as any
    // other: `judgeGate` takes it, so the item page's picker offers it.
    const delivery = createPipeline(handle.db, { name: "Delivery" });
    createStep(handle.db, { pipelineId: delivery.id, position: 0, name: "Talk it over", type: "user", offBoard: true });
    const build = createStep(handle.db, { pipelineId: delivery.id, position: 1, name: "Build", type: "user" });
    createStep(handle.db, { pipelineId: delivery.id, position: 2, name: "Shipped", type: "user", isTerminal: true });
    const dependency = createTestItem(handle.db, { type: "story", title: "Elsewhere", stepId: build.id, pipelineId: delivery.id });

    expect(listPipelineStepViews(handle.db, { pipelineId: delivery.id }).steps.map((step) => step.name)).toEqual(["Build", "Shipped"]);
    expect(listWaitSteps(handle.db, { itemId: dependency.id }).steps.map((step) => step.name)).toEqual(["Talk it over", "Build"]);
    // Nothing to offer for an item that is not there.
    expect(listWaitSteps(handle.db, { itemId: uuidv7() }).steps).toEqual([]);
  });

  it("does not let an open conversation answer 'is everything blocked?'", async () => {
    // A conversation is never terminal, so before this it counted as
    // live work forever — and one open chat meant the stall warning
    // could never fire again.
    conversation();
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: implementer.id },
      body: "@user which limit?",
      mentions: [{ type: "human" }],
      kind: "escalation",
    });
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement" });
    updateRun(handle.db, run.id, { status: "awaiting_input" });

    expect(listInbox(handle.db, null).summary.everythingBlocked).toBe(true);
  });
});

describe("items:get", () => {
  it("returns the thread with authors resolved for display", async () => {
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Use a token bucket." });
    postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: implementer.id }, body: "Will do." });
    postComment(handle.db, { itemId: item.id, author: { type: "engine" }, body: "Verification failed." });

    const detail = getItemDetail(handle.db, { itemId: item.id })!;

    expect(detail.comments.map((comment) => comment.authorName)).toEqual(["you", implementer.name, "EO"]);
    expect(detail.comments[1]?.authorRole).toBe("implementer");
  });

  it("marks the comment the human still owes an answer to", async () => {
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: implementer.id },
      body: "@user which limit?",
      mentions: [{ type: "human" }],
      kind: "escalation",
    });
    postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: implementer.id }, body: "just a note" });

    const detail = getItemDetail(handle.db, { itemId: item.id })!;
    expect(detail.comments.map((comment) => comment.awaitingHuman)).toEqual([true, false]);
  });

  it("includes acceptance criteria, transitions, runs and dependencies", async () => {
    const spec = createTestItem(handle.db, {
      type: "story",
      title: "With criteria",
      stepId: "todo",
      spec: { acceptance_criteria: ["429 after 100 req/min"] },
    });
    const dependency = createTestItem(handle.db, { type: "story", title: "First", stepId: "todo" });
    addDependency(handle.db, spec.id, dependency.id);
    transitionItem(handle.db, { itemId: spec.id, toStepId: "review", actor: "human", reason: "manual" });
    const run = createRun(handle.db, { itemId: spec.id, agentId: implementer.id, action: "implement" });
    updateRun(handle.db, run.id, { status: "succeeded", verification: { ok: true } });

    const detail = getItemDetail(handle.db, { itemId: spec.id })!;

    expect(detail.item.acceptanceCriteria).toEqual(["429 after 100 req/min"]);
    expect(detail.transitions).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({ agentName: implementer.name, verificationOk: true });
    // The step's name comes with the dependency: it can sit in another
    // pipeline, whose steps this item's detail never loaded.
    expect(detail.dependsOn).toEqual([{ id: dependency.id, key: dependency.key, title: "First", stepId: "todo", stepName: "To Do", wait: "finished", waitStepId: null, waitStepName: null }]);
    // In review, so the page offers no editor its content would be refused through (EO-779).
    expect(detail.item.contentRefusal).toMatch(/is in review/);
  });

  it("says why an item's content may not change, by the rule every change is held to (EO-779)", async () => {
    const editable = createTestItem(handle.db, { type: "story", title: "Editable", stepId: "todo" });
    expect(getItemDetail(handle.db, { itemId: editable.id })!.item.contentRefusal).toBeNull();

    // Held by a running agent.
    createRun(handle.db, { itemId: editable.id, agentId: implementer.id, action: "implement" });
    expect(getItemDetail(handle.db, { itemId: editable.id })!.item.contentRefusal).toMatch(/being worked on right now/);

    // Finished.
    const finished = createTestItem(handle.db, { type: "story", title: "Shipped", stepId: "ready_to_merge" });
    expect(getItemDetail(handle.db, { itemId: finished.id })!.item.contentRefusal).toMatch(/is finished/);
  });

  it("carries the Jira switch, which the rail is the only reader of", async () => {
    // The rail throws this switch (EO-125), and a control that cannot
    // show its own state is one you have to guess at. Off with the key
    // still set is the state worth proving: it is invisible from
    // `jiraKey` alone, and it looks exactly like a broken sync.
    const mirrored = createTestItem(handle.db, { type: "story", title: "Mirrored", stepId: "todo", jiraKey: "KAN-1" });

    expect(getItemDetail(handle.db, { itemId: mirrored.id })?.item.jiraSync).toBe(true);

    setJiraSync(handle.db, mirrored.id, false);

    expect(getItemDetail(handle.db, { itemId: mirrored.id })?.item).toMatchObject({ jiraKey: "KAN-1", jiraSync: false });
  });

  it("says whether the item's project names a Jira site, which is what draws the rail's link row", async () => {
    // `jiraUrl` cannot answer this (EO-126): it is null for every item
    // without a key, connected project or not, and the item with no key
    // on a connected project is exactly the one that needs somewhere to
    // type one.
    //
    // The project rather than the repository since KAN-130: the binding
    // is one per project, so this is the row every Jira-shaped thing
    // asks about.
    const repository = attachWorkspace(handle.db, { name: "svc", keyPrefix: "SVC", repoPath: "/tmp/svc" });
    const project = projectForWorkspace(handle.db, repository.id)!;
    const unattached = createTestItem(handle.db, { type: "story", title: "Unattached", stepId: "todo", workspaceId: repository.id, projectId: project.id });

    expect(getItemDetail(handle.db, { itemId: unattached.id })?.item).toMatchObject({ jiraKey: null, jiraUrl: null, jiraConnected: false });

    const site = createJiraConnection(handle.db, { baseUrl: "https://jira.acme.internal", flavour: "datacenter" });
    saveJiraBinding(handle.db, project.id, { connectionId: site.id, projectKey: "ACME" });

    expect(getItemDetail(handle.db, { itemId: unattached.id })?.item).toMatchObject({ jiraKey: null, jiraUrl: null, jiraConnected: true });
    // An item on no project at all has nothing to be connected by.
    expect(getItemDetail(handle.db, { itemId: item.id })?.item.jiraConnected).toBe(false);
  });

  it("returns null for an item that doesn't exist rather than throwing", async () => {
    expect(getItemDetail(handle.db, { itemId: "00000000-0000-0000-0000-000000000000" })).toBeNull();
  });
});

describe("runs:listEvents", () => {
  it("says how long the whole log is on every page, so a follower can tell a line landed behind it", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Watched", stepId: "todo" });
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "wait_until" });
    appendSyncedRunEvents(handle.db, run.id, "anna", [
      { seq: 1_000, ts: 1, type: "output", payload: {} },
      { seq: 3_000, ts: 2, type: "output", payload: {} },
    ]);

    expect(listRunEventsPage(handle.db, { runId: run.id, fromSeq: 3_001, limit: 100 })).toEqual({ events: [], nextSeq: null, total: 2 });
  });

  it("pages rather than returning an unbounded log", async () => {
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement" });
    const buffer = createRunEventBuffer(handle.db);
    for (let i = 0; i < 250; i++) buffer.append(run.id, "output", { text: `line ${i}` });
    buffer.dispose();

    const first = listRunEventsPage(handle.db, { runId: run.id, fromSeq: 0, limit: 100 });
    expect(first.events).toHaveLength(100);
    expect(first.events[0]?.seq).toBe(0); // the very first event is included, not skipped

    const second = listRunEventsPage(handle.db, { runId: run.id, fromSeq: first.nextSeq!, limit: 100 });
    expect(second.events[0]?.seq).toBeGreaterThan(first.events.at(-1)!.seq); // no overlap

    // Walking the pages must cover every event exactly once — the
    // property a transcript follower actually depends on.
    const seen: number[] = [];
    let cursor = 0;
    for (;;) {
      const page = listRunEventsPage(handle.db, { runId: run.id, fromSeq: cursor, limit: 100 });
      seen.push(...page.events.map((event) => event.seq));
      if (page.nextSeq === null) break;
      cursor = page.nextSeq;
    }

    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250); // no duplicates across page boundaries
  });
});

describe("inbox:list", () => {
  it("is the open-mentions query, with enough item context to act on", async () => {
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: implementer.id },
      body: "@user 429 or 503?",
      mentions: [{ type: "human" }],
      kind: "escalation",
      options: ["429", "503"],
    });

    const { items } = listInbox(handle.db, null);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ itemKey: item.key, itemTitle: item.title, authorName: implementer.name, options: ["429", "503"] });
  });

  it("drops an item once it has been answered", async () => {
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: implementer.id },
      body: "@user?",
      mentions: [{ type: "human" }],
      kind: "escalation",
    });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "429." });

    expect(listInbox(handle.db, null).items).toHaveLength(0);
  });
});

/*
 * Mirroring a new item into Jira as it is created (J-03) was tested
 * here, against the form that created one. That door is gone: work
 * arrives from a decomposition approved in Discussions, or from Jira itself —
 * where there is nothing to mirror back. What is still mirrored, and
 * still covered, is everything after: status pushes, comments and
 * attachments, in `jira/`.
 */

describe("config reads", () => {
  it("lists agents and workflow states for the project and settings screens", async () => {
    // Four rows, three roles: 0062 merged the product owner and the
    // pipeline architect into `system` and retired the architect row
    // rather than deleting it, and this screen lists what exists.
    expect(listAgentViews(handle.db).agents.map((agent) => agent.role).sort()).toEqual([
      "implementer",
      "pipeline_architect",
      "reviewer",
      "system",
    ]);
    expect(listPipelineStepViews(handle.db, { pipelineId: "default" }).steps.map((state) => state.id)).toEqual([
      "worktree",
      "repository_index",
      "todo",
      "review",
      "merge_request",
      "pull_request_watch",
      "ready_to_merge",
    ]);
  });

  /**
   * Which kind of disk this pipeline's steps run on (EO-296).
   *
   * The step editor asks it to decide whether "Works on a branch /
   * Reads only" is a choice anybody has here — it is not on a helpdesk,
   * and not on no disk at all — so answering `none` for a pipeline whose
   * steps dispatch into a git worktree takes the control away from the
   * one pipeline everybody starts with.
   *
   * Which is exactly the shape of EO-72, one field over: `default` is
   * project-less, a project-less pipeline belongs to *every* project, and
   * asking with its own `null` collapses the question to "a pipeline on
   * no project", which is not what it is. The active project is the
   * context it is being configured in, and it is read here for the same
   * reason `elsewhere` reads it.
   */
  describe("which kind of disk these steps run on", () => {
    const kindForDefault = () => listPipelineStepViews(handle.db, { pipelineId: "default" }).workspaceKind;

    it("is the git kind for the shipped pipeline when the project it is open in has a repository", () => {
      attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/eo/api", baseBranch: "main" });

      expect(kindForDefault()).toBe("git-worktree");
    });

    it("is `none` when the project it is open in has nothing attached", () => {
      createProject(handle.db, { name: "Nothing attached yet", keyPrefix: "NEW" });

      expect(kindForDefault()).toBe("none");
    });

    it("is `none` when there is no project at all, which is EO before anything is configured", () => {
      expect(kindForDefault()).toBe("none");
    });

    it("prefers a pipeline's own project over the active one, because that pipeline is not shared", () => {
      // Belonging to every project is a property of belonging to none.
      // A pipeline that names one answers for that one wherever it is
      // opened from, the way `validationInput` scopes it.
      attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/eo/api", baseBranch: "main" });
      const bare = createProject(handle.db, { name: "No disk", keyPrefix: "ND" });
      const theirs = createPipeline(handle.db, { projectId: bare.id, name: "Reports" });
      createStep(handle.db, { pipelineId: theirs.id, position: 0, name: "Draft", type: "user" });

      expect(listPipelineStepViews(handle.db, { pipelineId: theirs.id }).workspaceKind).toBe("none");
      // And the shared one still answers for where it is open.
      expect(kindForDefault()).toBe("git-worktree");
    });
  });

  /**
   * What each step would take with it (EO-167).
   *
   * The configuration screen's answer to "can this step be removed?",
   * and it travels with the graph so that the Remove button can refuse
   * in the same render as the step it is asked about.
   */
  describe("what a step is holding", () => {
    const holds = () => listPipelineStepViews(handle.db, { pipelineId: "default" }).holds;

    it("counts the items on a step and the runs in flight on it, and says nothing about an empty one", () => {
      // `beforeEach` parks one item on `todo`; this puts an agent on it.
      const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement" });
      updateRun(handle.db, run.id, { status: "running", startedAt: 1_000 });

      expect(holds()).toContainEqual({ stepId: "todo", items: 1, running: 1, archived: 0, routesIn: [] });
      // Absent rather than reported as zero — which is also what a step
      // the editor has invented but not published looks like.
      expect(holds().map((held) => held.stepId)).not.toContain("review");
    });

    it("counts an archived item, whose foreign key is every bit as real — and says it is archived", () => {
      // The same reading `validationInput` takes. The two have to agree,
      // or the screen offers a removal that Publish then refuses. Counted
      // apart as well (EO-230): the board cannot show it, so the editor
      // sends a person to the Archive for it rather than to an empty
      // board.
      setArchived(handle.db, { itemId: item.id, archived: true });

      expect(holds()).toContainEqual({ stepId: "todo", items: 1, running: 0, archived: 1, routesIn: [] });
    });

    it("names the hand-offs from other pipelines that land on a step", () => {
      // The edge neither this screen nor `validatePipeline` can see: the
      // route belongs to Delivery, and removing `review` would leave it
      // pointing at nothing in a pipeline nobody had open (EO-58).
      const delivery = createPipeline(handle.db, { projectId: null, name: "Delivery" });
      const ship = createStep(handle.db, { pipelineId: delivery.id, position: 0, name: "Ship", type: "user" });
      createRoute(handle.db, { pipelineId: delivery.id, fromStepId: ship.id, resultKey: "shipped", label: "Shipped", target: "review" });

      expect(holds()).toContainEqual({ stepId: "review", items: 0, running: 0, archived: 0, routesIn: [{ pipelineName: "Delivery", label: "Shipped" }] });
      // Its own routes are not hand-offs into it: `todo` routes to
      // `review` from inside this very pipeline, and the editor draws
      // and removes those itself.
      expect(holds().find((held) => held.stepId === "todo")?.routesIn ?? []).toEqual([]);
    });
  });

  /**
   * Where the editor's picker may hand work to (EO-58, EO-69, EO-72).
   *
   * On the same read as the graph, and grouped by pipeline: step names
   * collide across pipelines, so "Merge" only reads as somewhere else
   * under a heading that says which pipeline it belongs to.
   *
   * A subset of what the validator accepts, never a superset: everything
   * offered here saves, and somewhere work cannot go is not offered.
   */
  describe("the other pipelines a route may hand work to", () => {
    const elsewhereForDefault = () => listPipelineStepViews(handle.db, { pipelineId: "default" }).elsewhere;

    /** A pipeline with a step and somewhere for work to enter it. */
    function pipelineWithEntry(projectId: Uuid | null, name: string) {
      const pipeline = createPipeline(handle.db, { projectId, name });
      const step = createStep(handle.db, { pipelineId: pipeline.id, position: 0, name, type: "user" });
      setEntryStep(handle.db, pipeline.id, step.id);
      return { pipeline, step };
    }

    it("groups them under their pipeline's name, and never repeats this pipeline's own steps", () => {
      const { pipeline } = pipelineWithEntry(null, "Merge");

      const elsewhere = elsewhereForDefault();

      expect(elsewhere).toContainEqual({ pipelineId: pipeline.id, pipelineName: "Merge", steps: [expect.objectContaining({ name: "Merge" })] });
      // Its own steps are already the ungrouped half of the picker, and a
      // step offered twice is a step you can pick the wrong one of.
      expect(elsewhere.flatMap((group) => group.steps).map((step) => step.id)).not.toContain("todo");
    });

    /**
     * `default` is project-less, and a project-less pipeline belongs to
     * every project — so it sees the pipelines of the project it is open
     * in too. Asking with its own `null` collapsed the filter to
     * "project-less only", which hid, from the one pipeline everybody
     * starts with, every pipeline they had created (EO-72).
     */
    it("offers a pipeline created on the project when the one being edited belongs to none", () => {
      const project = createProject(handle.db, { name: "EO", keyPrefix: "EO" });
      const { pipeline } = pipelineWithEntry(project.id, "Merge");

      expect(elsewhereForDefault().map((group) => group.pipelineId)).toContain(pipeline.id);
    });

    /**
     * And only that project's, which is why the active project is read
     * here at all: belonging to every project is not licence to hand work
     * to every project. `validationInput` scopes the same way, so a
     * cross-project target offered here would be one the save then refuses
     * — a picker that traps people, which is the thing this pair of lists
     * exists to avoid.
     */
    it("does not offer a pipeline of a project that is not the one open", () => {
      const ours = createProject(handle.db, { name: "Ours", keyPrefix: "OURS" });
      const theirs = createProject(handle.db, { name: "Theirs", keyPrefix: "THRS" });
      const mine = pipelineWithEntry(ours.id, "Merge");
      const other = pipelineWithEntry(theirs.id, "Someone else's Merge");
      setActiveProjectCommand(handle.db, { id: ours.id });

      const offered = elsewhereForDefault().map((group) => group.pipelineId);
      expect(offered).toContain(mine.pipeline.id);
      expect(offered).not.toContain(other.pipeline.id);
    });

    /**
     * `discussion` and `architecture` host conversations rather than hold
     * work — which is what `offBoardStepIds` keeps the dashboard, the
     * archive and the inbox away from — and nothing enters the pipeline
     * they belong to. A validator still accepts a route that names one, so
     * nothing saved stops saving; a picker proposing one invites somebody
     * to send real work into a conversation.
     */
    it("does not offer the steps that hold conversations", () => {
      const elsewhere = elsewhereForDefault();

      expect(elsewhere.map((group) => group.pipelineId)).not.toContain("discussions");
      expect(elsewhere.flatMap((group) => group.steps).map((step) => step.id)).not.toContain("discussion");
    });

    // Nowhere for the work to arrive — the same rule EO-70 applies to the
    // destinations a card's `⋯` menu offers.
    it("does not offer a pipeline work cannot enter", () => {
      const merge = createPipeline(handle.db, { projectId: null, name: "Merge" });
      createStep(handle.db, { pipelineId: merge.id, position: 0, name: "Merge", type: "user" });

      expect(elsewhereForDefault().map((group) => group.pipelineId)).not.toContain(merge.id);
    });

    it("leaves out an archived pipeline", () => {
      const { pipeline } = pipelineWithEntry(null, "Merge");
      archivePipeline(handle.db, pipeline.id);

      expect(elsewhereForDefault().map((group) => group.pipelineId)).not.toContain(pipeline.id);
    });
  });
});

describe("writes", () => {





  it("comments:post accepts an attachment-only reply", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eo reply attachment "));
    try {
      const storage = new AttachmentStorage(directory);
      const question = postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: implementer.id }, body: "Show me the log" });
      const draft = await storage.stageData({ name: "failure.log", dataBase64: Buffer.from("boom").toString("base64") });
      const result = await postHumanComment(handle.db, fakeEngine(), {
        itemId: item.id,
        body: "",
        attachmentIds: [draft.id],
        mentions: [],
        pinned: false,
        parentId: question.id,
      }, storage);

      const reply = getItemDetail(handle.db, { itemId: item.id })!.comments.find((comment) => comment.id === result.commentId)!;
      expect(reply).toMatchObject({ body: "", parentId: question.id });
      expect(reply.attachments).toEqual([expect.objectContaining({ id: draft.id, commentId: reply.id })]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });


  it("comments:post resolves @mentions into real targets", async () => {
    const engine = fakeEngine();
    await postHumanComment(handle.db, engine, { itemId: item.id, body: "@implementer take a look", mentions: ["implementer"], pinned: false, parentId: null });

    const detail = getItemDetail(handle.db, { itemId: item.id })!;
    expect(detail.comments[0]?.body).toContain("take a look");
  });

  it("comments:post rejects an unknown mention instead of dropping it silently", async () => {
    await expect(
      postHumanComment(handle.db, fakeEngine(), { itemId: item.id, body: "hi", mentions: ["nobody"], pinned: false, parentId: null }),
    ).rejects.toThrow(/nobody/);
  });

  it("answering a parked run resumes it — the reply path (§6)", async () => {
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", threadId: "thr_1" });
    updateRun(handle.db, run.id, { status: "awaiting_input" });

    const engine = fakeEngine();
    const result = await postHumanComment(handle.db, engine, { itemId: item.id, body: "100 a minute.", mentions: [], pinned: false, parentId: null });

    expect(result.resumedRun).toBe(true);
    expect(engine.resumeItem).toHaveBeenCalledWith(item.id);
  });

  it("an ordinary comment on an idle item resumes nothing", async () => {
    const engine = fakeEngine();
    const result = await postHumanComment(handle.db, engine, { itemId: item.id, body: "just thinking aloud", mentions: [], pinned: false, parentId: null });

    expect(result.resumedRun).toBe(false);
    expect(engine.resumeItem).not.toHaveBeenCalled();
  });

  it("returns before the resumed run finishes", async () => {
    // The reported bug. `resumeItem` drives an agent to completion —
    // minutes — and this used to be awaited inside the IPC handler, so
    // the renderer's promise stayed open for the whole run. The only
    // thing that makes a posted comment appear is that promise
    // resolving, which is why a reply was invisible until the run ended
    // or the item was closed and reopened.
    //
    // Before the fix this test does not fail with an assertion — it
    // hangs until vitest times out, which is exactly what the app did.
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", threadId: "thr_1" });
    updateRun(handle.db, run.id, { status: "awaiting_input" });

    let finishTheRun: () => void = () => {};
    const runFinished = new Promise<void>((resolve) => {
      finishTheRun = resolve;
    });
    const engine = { ...fakeEngine(), resumeItem: vi.fn(() => runFinished) };

    const result = await postHumanComment(handle.db, engine, { itemId: item.id, body: "100 a minute.", mentions: [], pinned: false, parentId: null });

    expect(result.resumedRun).toBe(true);
    expect(engine.resumeItem).toHaveBeenCalledWith(item.id);
    // And the comment is readable *now*, not when the run ends.
    expect(getItemDetail(handle.db, { itemId: item.id })!.comments.map((entry) => entry.body)).toContain("100 a minute.");

    finishTheRun(); // never leave a pending promise behind
    await runFinished;
  });

  it("does not start a second run while the resumed one is still going", async () => {
    // `resumeItem` creates a *new* run and leaves the parked row at
    // `awaiting_input` forever, so "some run is awaiting input" stays
    // true while the resumed run is working. With the resume no longer
    // awaited, a second reply would start a second concurrent run on the
    // same provider thread — invariant 10 twice over.
    const parked = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", threadId: "thr_1" });
    updateRun(handle.db, parked.id, { status: "awaiting_input", startedAt: 1_000 });
    const resumed = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", threadId: "thr_1" });
    updateRun(handle.db, resumed.id, { status: "running", startedAt: 2_000 });

    const engine = fakeEngine();
    const result = await postHumanComment(handle.db, engine, { itemId: item.id, body: "one more thing", mentions: [], pinned: false, parentId: null });

    expect(result.resumedRun).toBe(false);
    expect(engine.resumeItem).not.toHaveBeenCalled();
  });

  it("says so in the thread when picking the item back up fails", async () => {
    // Nobody awaits the resume any more, so a rejection has nowhere to
    // surface except the thread — invariant 8, and the only way the
    // person who wrote the reply learns their agent never restarted.
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", threadId: "thr_1" });
    updateRun(handle.db, run.id, { status: "awaiting_input" });

    const engine = { ...fakeEngine(), resumeItem: vi.fn(() => Promise.reject(new Error("provider went away"))) };
    await postHumanComment(handle.db, engine, { itemId: item.id, body: "100 a minute.", mentions: [], pinned: false, parentId: null });

    await vi.waitFor(() => {
      const note = getItemDetail(handle.db, { itemId: item.id })!.comments.find((entry) => entry.authorType === "engine");
      expect(note?.body).toContain("provider went away");
    });
  });

  it("items:move records a human override as its own transition", async () => {
    const engine = fakeEngine();
    const result = moveItem(handle.db, engine, { itemId: item.id, toStepId: "review", cancelActiveRun: false, comment: "" });

    expect(result).toEqual({ moved: true, cancelledRunId: null, blockedByActiveRun: false, commentId: null, problem: null });
    const detail = getItemDetail(handle.db, { itemId: item.id })!;
    expect(detail.item.stepId).toBe("review");
    expect(detail.transitions.at(-1)).toMatchObject({ fromStepId: "todo", toStepId: "review", actor: "human" });
  });

  it("posts the mover's note as a human comment, before the move (§5.2)", async () => {
    const result = moveItem(handle.db, fakeEngine(), {
      itemId: item.id,
      toStepId: "review",
      cancelActiveRun: false,
      comment: "Use a sliding window, not a bucket.",
    });

    expect(result.commentId).not.toBeNull();
    const detail = getItemDetail(handle.db, { itemId: item.id })!;
    const note = detail.comments.find((entry) => entry.id === result.commentId);
    // A comment, because comments are the only channel (invariant #4) and
    // the next agent's context is this thread.
    expect(note?.authorType).toBe("human");
    expect(note?.body).toBe("Use a sliding window, not a bucket.");
  });

  it("posts nothing when the note is left empty", async () => {
    const result = moveItem(handle.db, fakeEngine(), { itemId: item.id, toStepId: "review", cancelActiveRun: false, comment: "   " });

    // A silent tidy-up move should not leave an empty comment behind.
    expect(result.commentId).toBeNull();
    expect(getItemDetail(handle.db, { itemId: item.id })!.comments).toHaveLength(0);
  });

  it("refuses to move an item out from under a running agent without confirmation", async () => {
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement" });
    updateRun(handle.db, run.id, { status: "running" });

    const engine = fakeEngine();
    const result = moveItem(handle.db, engine, { itemId: item.id, toStepId: "review", cancelActiveRun: false, comment: "" });

    expect(result.blockedByActiveRun).toBe(true);
    expect(result.moved).toBe(false);
    expect(engine.cancelRun).not.toHaveBeenCalled();
    expect(getItemDetail(handle.db, { itemId: item.id })?.item.stepId).toBe("todo"); // work left alone
  });

  it("cancels the run and explains itself once confirmed", async () => {
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement" });
    updateRun(handle.db, run.id, { status: "running" });

    const engine = fakeEngine();
    const result = moveItem(handle.db, engine, { itemId: item.id, toStepId: "review", cancelActiveRun: true, comment: "" });

    expect(result).toEqual({ moved: true, cancelledRunId: run.id, blockedByActiveRun: false, commentId: null, problem: null });
    expect(engine.cancelRun).toHaveBeenCalledWith(run.id, "superseded");
    // Nothing silently drops work on the floor (invariant #8).
    const detail = getItemDetail(handle.db, { itemId: item.id })!;
    expect(detail.comments.at(-1)?.body).toContain("you moved this ticket");
    // Named, not identified: a step somebody created has a uuid for an id,
    // and this comment is permanent.
    expect(detail.comments.at(-1)?.body).toContain('from "To Do" to "Review"');
  });

  it("lands both comments when a note accompanies a cancelled run", async () => {
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement" });
    updateRun(handle.db, run.id, { status: "running" });

    moveItem(handle.db, fakeEngine(), { itemId: item.id, toStepId: "review", cancelActiveRun: true, comment: "Wrong approach — start again." });

    const comments = getItemDetail(handle.db, { itemId: item.id })!.comments;
    // The person's words first, then the engine's explanation: the note is
    // posted before the transition so it sits above the move (ARCHITECTURE.md, "Moving an item by
    // hand").
    expect(comments.map((entry) => entry.authorType)).toEqual(["human", "engine"]);
    expect(comments[0]?.body).toBe("Wrong approach — start again.");
  });

  it("items:update sets priority, and the engine dispatches by it", async () => {
    // The point of the control (U-13): the scheduler has sorted by
    // priority since E-02, and until now nothing could set it, so the
    // sort had nothing to sort by.
    const ordinary = createTestItem(handle.db, { type: "story", title: "Ordinary", stepId: "todo" });
    const urgent = createTestItem(handle.db, { type: "story", title: "Urgent", stepId: "todo" });

    expect(updateItemText(handle.db, { itemId: urgent.id, priority: 2 })).toEqual({ updated: true, problem: null });

    // One slot, so only the one that matters most gets it.
    const dispatched: string[] = [];
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ result: validImplementResult }),
      limits: { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 },
      buildContext: (_db, item) => {
        dispatched.push(item.title);
        return "";
      },
    });
    await supervisor.runOnce();

    expect(dispatched[0]).toBe("Urgent");
    expect(getItemDetail(handle.db, { itemId: ordinary.id })?.item.priority).toBe(0);
    expect(getItemDetail(handle.db, { itemId: urgent.id })?.item.priority).toBe(2);
  });



  it("the kill switch round-trips through the engine handle", async () => {
    const engine = fakeEngine();
    expect(engineStatus(handle.db, engine)).toEqual({ paused: false, activeRunCount: 0, finishingRunCount: 0 });
    expect(pauseEngine(handle.db, engine, { cancelRunning: true })).toEqual({ paused: true, activeRunCount: 0, finishingRunCount: 0 });
    expect(engine.pause).toHaveBeenCalledWith({ cancelRunning: true });
    expect(getSetting(handle.db, ENGINE_PAUSED_KEY, false)).toBe(true);
    expect(resumeEngine(handle.db, engine)).toEqual({ paused: false, activeRunCount: 0, finishingRunCount: 0 });
    expect(getSetting(handle.db, ENGINE_PAUSED_KEY, false)).toBe(false);
  });

  it("persists pause and resume even while the runtime engine is unavailable", () => {
    expect(pauseEngine(handle.db, undefined, { cancelRunning: false })).toEqual({ paused: true, activeRunCount: 0, finishingRunCount: 0 });
    expect(engineStatus(handle.db, undefined)).toEqual({ paused: true, activeRunCount: 0, finishingRunCount: 0 });

    expect(resumeEngine(handle.db, undefined)).toEqual({ paused: false, activeRunCount: 0, finishingRunCount: 0 });
    expect(engineStatus(handle.db, undefined)).toEqual({ paused: false, activeRunCount: 0, finishingRunCount: 0 });
  });

  it("exposes the supervisor's live active-run count", () => {
    const engine = { ...fakeEngine(), activeRunCount: () => 2 };
    expect(engineStatus(handle.db, engine)).toEqual({ paused: false, activeRunCount: 2, finishingRunCount: 0 });
  });

  it("reports the runs a pause is waiting for apart from the ones that carry on (EO-615)", () => {
    const engine = { ...fakeEngine(), activeRunCount: () => 3, finishingRunCount: () => 2 };
    expect(engineStatus(handle.db, engine)).toMatchObject({ activeRunCount: 3, finishingRunCount: 2 });
    expect(pauseEngine(handle.db, engine, { cancelRunning: false })).toMatchObject({ activeRunCount: 3, finishingRunCount: 2 });
    expect(resumeEngine(handle.db, engine)).toMatchObject({ activeRunCount: 3, finishingRunCount: 2 });
  });

  it("reports honestly when there is no engine rather than pretending it worked", async () => {
    expect(cancelRun(undefined, { runId: "whatever" })).toEqual({ cancelled: false });
  });
});

/**
 * A story or bug classification short-circuits the whole
 * backlog/refine detour (KAN-4, routed by KAN-37/EO-5): it lands on the
 * same human review gate a feature's plan stops at, the human can
 * reclassify it there through `items:update` before approving, and
 * approving moves the *same* item straight to `todo` — no child
 * item, no dependency edges.
 */
/*
 * The bug/story intake short-circuit's *approval* used to be tested here:
 * a classification comment on an item parked at `pending_approval`,
 * approved or reclassified from the item screen.
 *
 * Intake still classifies — `intake.test.ts` covers that, against a step
 * configured to run the action. What is gone is the column it parked in
 * and the item-screen gate above it; approving what a product owner
 * proposes happens in Discussions now (ARCHITECTURE.md, "A column is a responsibility, not a
 * status").
 */

/**
 * Regression (KAN-37/EO-5): a feature's own path — decomposition and
 * all — is unaffected by the bug/story short-circuit above.
 */

/**
 * Settings are written one key at a time (KAN-33).
 *
 * The Do Not Disturb toggle lives in the inbox and the archive delay
 * lives in Settings, so a whole-object write would let either screen
 * silently reset the other's value.
 */
describe("settings:set", () => {
  it("leaves alone what the caller did not send", async () => {
    await writeSettings(handle.db, { doNotDisturb: true, archiveAfterDays: 30 });

    // The inbox toggling Do Not Disturb knows nothing about archiving.
    const after = await writeSettings(handle.db, { doNotDisturb: false });

    expect(after).toMatchObject({ doNotDisturb: false, archiveAfterDays: 30 });
  });

  it("keeps the Jira interval when another screen writes a setting", async () => {
    // Same hazard as the archive delay: Settings owns this one, and the
    // inbox's Do Not Disturb toggle knows nothing about it.
    await writeSettings(handle.db, { jiraPullMinutes: 15 });

    expect((await writeSettings(handle.db, { doNotDisturb: true })).jiraPullMinutes).toBe(15);
  });

  it("can turn Jira sync off, and defaults to five minutes", async () => {
    expect((await readSettings(handle.db)).jiraPullMinutes).toBe(5);
    expect((await writeSettings(handle.db, { jiraPullMinutes: null })).jiraPullMinutes).toBeNull();
  });

  it("can turn archiving off, which is not the same as leaving it unset", async () => {
    // `null` is a value meaning never; an absent key means never
    // configured, which is what gives the 14-day default. A falsy check
    // would confuse both with 0, which means "archive immediately".
    expect((await readSettings(handle.db)).archiveAfterDays).toBe(14);

    expect((await writeSettings(handle.db, { archiveAfterDays: null })).archiveAfterDays).toBeNull();
    expect((await writeSettings(handle.db, { archiveAfterDays: 0 })).archiveAfterDays).toBe(0);
  });

  it("keeps a branch prefix once seeded, and lets it be edited (EO-15)", async () => {
    const first = await readSettings(handle.db);
    expect(first.branchPrefix.length).toBeGreaterThan(0);

    const after = await writeSettings(handle.db, { branchPrefix: "acme" });
    expect(after.branchPrefix).toBe("acme");
    expect((await readSettings(handle.db)).branchPrefix).toBe("acme");
  });

  it("keeps twenty pipeline versions until told otherwise, and only a whole number of one or more (EO-359)", async () => {
    expect((await readSettings(handle.db)).pipelineVersionsToKeep).toBe(20);

    expect((await writeSettings(handle.db, { pipelineVersionsToKeep: 3 })).pipelineVersionsToKeep).toBe(3);
    // Another screen's write leaves it where it is.
    expect((await writeSettings(handle.db, { doNotDisturb: true })).pipelineVersionsToKeep).toBe(3);

    // The contract is the door: nothing below one, nothing fractional.
    const request = ipcContract["settings:set"].request;
    expect(request.safeParse({ pipelineVersionsToKeep: 0 }).success).toBe(false);
    expect(request.safeParse({ pipelineVersionsToKeep: 2.5 }).success).toBe(false);
    expect(request.safeParse({ pipelineVersionsToKeep: 1 }).success).toBe(true);
  });

  it("keeps twenty module versions until told otherwise, separately from pipelines, and only a whole number of one or more (EO-360)", async () => {
    expect((await readSettings(handle.db)).moduleVersionsToKeep).toBe(20);

    const written = await writeSettings(handle.db, { moduleVersionsToKeep: 3 });
    expect(written.moduleVersionsToKeep).toBe(3);
    // Its own setting: the pipelines' one is where it was.
    expect(written.pipelineVersionsToKeep).toBe(20);
    expect((await writeSettings(handle.db, { doNotDisturb: true })).moduleVersionsToKeep).toBe(3);

    const request = ipcContract["settings:set"].request;
    expect(request.safeParse({ moduleVersionsToKeep: 0 }).success).toBe(false);
    expect(request.safeParse({ moduleVersionsToKeep: 2.5 }).success).toBe(false);
    expect(request.safeParse({ moduleVersionsToKeep: 1 }).success).toBe(true);
  });
});

describe("items:setArchived", () => {
  it("puts an item away by hand and brings it back", () => {
    // By hand works on any item, unlike the sweep: someone who wants
    // an abandoned item off the project should not have to delete it.
    const item = createTestItem(handle.db, { type: "story", title: "Abandoned", stepId: "todo" });

    expect(setArchived(handle.db, { itemId: item.id, archived: true })).toEqual({ archived: true, problem: null });
    expect(listItemSummaries(handle.db, null).items.map((entry) => entry.id)).not.toContain(item.id);

    setArchived(handle.db, { itemId: item.id, archived: false });
    expect(listItemSummaries(handle.db, null).items.map((entry) => entry.id)).toContain(item.id);
  });

  it("says so rather than failing on an item that is gone", () => {
    const result = setArchived(handle.db, { itemId: "01890000-0000-7000-8000-000000000000", archived: true });

    expect(result.archived).toBe(false);
    expect(result.problem).toContain("no longer exists");
  });
});

describe("item holds", () => {
  const limits = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

  it("holds on the same step, carries the hold in summaries, and orders the human note before EO's record", () => {
    const engine = fakeEngine();
    const pipelineId = item.pipelineId;
    const stepId = item.stepId;

    const result = holdItem(handle.db, engine, {
      itemId: item.id,
      cancelActiveRun: false,
      comment: "Park this while I check the API contract.",
    });

    expect(result).toMatchObject({ held: true, cancelledRunId: null, blockedByActiveRun: false });
    const held = getItem(handle.db, item.id)!;
    expect(held.heldAt).not.toBeNull();
    expect(held).toMatchObject({ pipelineId, stepId });
    expect(listItemSummaries(handle.db, null).items.find((entry) => entry.id === item.id)?.heldAt).toBe(held.heldAt);

    const comments = getItemDetail(handle.db, { itemId: item.id })!.comments;
    expect(comments.map((entry) => entry.authorType)).toEqual(["human", "engine"]);
    expect(comments[0]?.body).toBe("Park this while I check the API contract.");
    expect(comments[1]?.body).toContain("put on hold");
    expect(engine.notifyStateChange).toHaveBeenCalled();
  });

  it("refuses a hold under a queued run without changing or commenting on anything", () => {
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement" });
    updateRun(handle.db, run.id, { status: "queued" });
    const engine = fakeEngine();

    const result = holdItem(handle.db, engine, {
      itemId: item.id,
      cancelActiveRun: false,
      comment: "This must not be posted yet.",
    });

    expect(result).toEqual({ held: false, cancelledRunId: null, blockedByActiveRun: true, commentId: null });
    expect(getItem(handle.db, item.id)?.heldAt).toBeNull();
    expect(getItemDetail(handle.db, { itemId: item.id })?.comments).toEqual([]);
    expect(engine.cancelRun).not.toHaveBeenCalled();
    expect(engine.notifyStateChange).not.toHaveBeenCalled();
  });

  it("cancels an active run when confirmed and records the hold as the reason", () => {
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement" });
    updateRun(handle.db, run.id, { status: "running" });
    const engine = fakeEngine();

    const result = holdItem(handle.db, engine, {
      itemId: item.id,
      cancelActiveRun: true,
      comment: "",
    });

    expect(result).toEqual({ held: true, cancelledRunId: run.id, blockedByActiveRun: false, commentId: null });
    expect(engine.cancelRun).toHaveBeenCalledWith(run.id, "superseded");
    expect(getItem(handle.db, item.id)?.heldAt).not.toBeNull();
    const engineComment = getItemDetail(handle.db, { itemId: item.id })!.comments.at(-1);
    expect(engineComment).toMatchObject({ authorType: "engine", runId: run.id });
    expect(engineComment?.body).toContain("cancelled because you put this ticket on hold");
  });

  it("resumes on the same step and makes the next pure tick dispatchable again", () => {
    const pipelineId = item.pipelineId;
    const stepId = item.stepId;
    holdItem(handle.db, fakeEngine(), { itemId: item.id, cancelActiveRun: false, comment: "" });

    const heldInput = buildTickInput(handle.db, limits, false);
    expect(heldInput.heldItemIds).toEqual(new Set([item.id]));
    expect(tick(heldInput)).toEqual([]);

    const engine = fakeEngine();
    expect(resumeHeldItem(handle.db, engine, { itemId: item.id, cancelActiveRun: false })).toEqual({
      resumed: true,
      cancelledRunId: null,
      blockedByActiveRun: false,
    });
    expect(getItem(handle.db, item.id)).toMatchObject({ pipelineId, stepId, heldAt: null });
    expect(getItemDetail(handle.db, { itemId: item.id })!.comments.at(-1)?.body).toContain("resumed");
    expect(tick(buildTickInput(handle.db, limits, false)).map((dispatch) => dispatch.item.id)).toEqual([item.id]);
  });

  it("refuses a resume under an active run, leaving the hold in place", () => {
    holdItem(handle.db, fakeEngine(), { itemId: item.id, cancelActiveRun: false, comment: "" });
    const heldAt = getItem(handle.db, item.id)!.heldAt;
    const commentsBefore = getItemDetail(handle.db, { itemId: item.id })!.comments.length;

    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement" });
    updateRun(handle.db, run.id, { status: "queued" });
    const engine = fakeEngine();

    expect(resumeHeldItem(handle.db, engine, { itemId: item.id, cancelActiveRun: false })).toEqual({
      resumed: false,
      cancelledRunId: null,
      blockedByActiveRun: true,
    });
    expect(getItem(handle.db, item.id)?.heldAt).toBe(heldAt);
    expect(getItemDetail(handle.db, { itemId: item.id })!.comments).toHaveLength(commentsBefore);
    expect(engine.cancelRun).not.toHaveBeenCalled();
    expect(engine.notifyStateChange).not.toHaveBeenCalled();
    expect(tick(buildTickInput(handle.db, limits, false))).toEqual([]);
  });

  it("cancels the run and records why when a resume is confirmed", () => {
    holdItem(handle.db, fakeEngine(), { itemId: item.id, cancelActiveRun: false, comment: "" });
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement" });
    updateRun(handle.db, run.id, { status: "running" });
    const engine = fakeEngine();

    expect(resumeHeldItem(handle.db, engine, { itemId: item.id, cancelActiveRun: true })).toEqual({
      resumed: true,
      cancelledRunId: run.id,
      blockedByActiveRun: false,
    });
    expect(engine.cancelRun).toHaveBeenCalledWith(run.id, "superseded");
    expect(getItem(handle.db, item.id)?.heldAt).toBeNull();
    const engineComment = getItemDetail(handle.db, { itemId: item.id })!.comments.at(-1);
    expect(engineComment).toMatchObject({ authorType: "engine", runId: run.id });
    expect(engineComment?.body).toContain("Run cancelled because you resumed this ticket");
  });

  it("does not change attention, but removes a held item from the inbox", () => {
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: implementer.id },
      body: "@user which response code?",
      mentions: [{ type: "human" }],
      kind: "escalation",
    });
    const before = needsAttention(handle.db, item.id);
    expect(before).toBe(true);
    expect(listInbox(handle.db, null).items).toHaveLength(1);

    holdItem(handle.db, fakeEngine(), { itemId: item.id, cancelActiveRun: false, comment: "" });

    expect(needsAttention(handle.db, item.id)).toBe(before);
    expect(listItemSummaries(handle.db, null).items.find((entry) => entry.id === item.id)?.needsAttention).toBe(before);
    expect(listInbox(handle.db, null).items).toEqual([]);
  });
});

/**
 * Every write that changes what a screen renders must say so (the
 * staleness fix).
 *
 * Five content-mutating commands emitted nothing at all, so the only
 * thing that refreshed anything was the calling window's own mutation
 * callback — which meant a second window never saw the change, and the
 * calling window saw it only when its IPC promise resolved.
 *
 * Asserted through a real bridged window rather than by spying on
 * `emitPush`, so the wire channel and the payload are pinned too.
 */
describe("telling the windows an item changed", () => {
  function bridgedWindow() {
    const send = vi.fn();
    let destroyed = false;
    const fake = { isDestroyed: () => destroyed, webContents: { send }, destroy: () => void (destroyed = true) };
    const transport = webContentsTransport(fake as unknown as BrowserWindow);
    const dispose = bridgePushChannels(transport);
    return { send, dispose };
  }

  /** The item ids announced on `items:changed`, in order. */
  function announced(send: ReturnType<typeof vi.fn>): unknown[] {
    return send.mock.calls.filter(([channel]) => channel === "push:items:changed").map(([, payload]) => (payload as { itemId?: string }).itemId);
  }

  it("announces a move", () => {
    const { send, dispose } = bridgedWindow();

    moveItem(handle.db, fakeEngine(), { itemId: item.id, toStepId: "review", cancelActiveRun: false, comment: "" });

    expect(announced(send)).toContain(item.id);
    dispose();
  });

  it("says nothing when a move was refused, because nothing changed", () => {
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement" });
    updateRun(handle.db, run.id, { status: "running" });
    const { send, dispose } = bridgedWindow();

    const result = moveItem(handle.db, fakeEngine(), { itemId: item.id, toStepId: "review", cancelActiveRun: false, comment: "" });

    expect(result.blockedByActiveRun).toBe(true);
    expect(announced(send)).toEqual([]);
    dispose();
  });

  it("announces an edit", () => {
    const { send, dispose } = bridgedWindow();

    updateItemText(handle.db, { itemId: item.id, title: "Rate limit it properly" });

    expect(announced(send)).toContain(item.id);
    dispose();
  });

  it("refuses a reclassification to a type this project has no row for, and changes nothing (KAN-129)", () => {
    const { send, dispose } = bridgedWindow();
    const before = getItem(handle.db, item.id)!;
    handle.db.run(sql`DELETE FROM item_types WHERE slug = 'feature' AND project_id IS NULL`);

    const result = updateItemText(handle.db, { itemId: item.id, title: "A new title", type: "feature" });

    expect(result.updated).toBe(false);
    expect(result.problem).toContain('"feature"');
    // The title rode along in the same call: a refusal has to leave the
    // whole edit undone, not the half it got to first.
    expect(getItem(handle.db, item.id)?.title).toBe(before.title);
    expect(getItem(handle.db, item.id)?.type).toBe(before.type);
    expect(announced(send)).toEqual([]);
    dispose();
  });

  it("says nothing when an edit had no fields to apply", () => {
    const { send, dispose } = bridgedWindow();

    expect(updateItemText(handle.db, { itemId: item.id }).updated).toBe(false);

    expect(announced(send)).toEqual([]);
    dispose();
  });

  it("announces a pin, naming the item the comment is on", () => {
    // The command is handed a comment id, so it has to look the item
    // up — an announcement carrying the wrong id is worse than none.
    const comment = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Binding." });
    const { send, dispose } = bridgedWindow();

    const result = setPinned(handle.db, { commentId: comment.id, pinned: true });

    expect(result).toEqual({ pinned: true, found: true });
    expect(announced(send)).toContain(item.id);
    dispose();
  });

  it("says a comment it does not have was not pinned, and announces nothing", () => {
    // Pinning is an UPDATE by id, so an id nothing matches writes no
    // rows and raises nothing. Without `found` the reply would be the
    // `pinned` that was sent — indistinguishable from a pin that took.
    const { send, dispose } = bridgedWindow();

    const result = setPinned(handle.db, { commentId: uuidv7(), pinned: true });

    expect(result).toEqual({ pinned: true, found: false });
    expect(announced(send)).toEqual([]);
    dispose();
  });
});

describe("handing an item to another pipeline by hand (EO-70)", () => {
  const limits = { globalConcurrency: 2, perAgentConcurrency: 2, perRepositoryConcurrency: 2 };

  /**
   * The pipeline the Delivery graph hands its work to: a pull request is
   * open, and merging lives somewhere of its own.
   *
   * Its step deliberately has a role and an action the default pipeline's
   * `review` does not, so a dispatch can be told apart from one the old
   * pipeline would have produced.
   */
  function mergePipeline() {
    const pipeline = createPipeline(handle.db, { name: "Merge", position: 9 });
    const step = createStep(handle.db, {
      id: "mg_merge",
      pipelineId: pipeline.id,
      position: 0,
      name: "Merge It",
      ownerRole: "reviewer",
      entryAction: "review",
    });
    setEntryStep(handle.db, pipeline.id, step.id);
    return { pipeline, step };
  }

  it("writes both columns when the move names the step's own pipeline", () => {
    const { pipeline, step } = mergePipeline();
    const engine = fakeEngine();

    const result = moveItem(handle.db, engine, {
      itemId: item.id,
      toStepId: step.id,
      toPipelineId: pipeline.id,
      cancelActiveRun: false,
      comment: "",
    });

    expect(result).toEqual({ moved: true, cancelledRunId: null, blockedByActiveRun: false, commentId: null, problem: null });
    // On the row, not only in the answer: half a move is exactly the case
    // where the response would read fine and the item would be stranded.
    expect(getItem(handle.db, item.id)).toMatchObject({ stepId: step.id, pipelineId: pipeline.id });
    // An override is recorded like any other transition (invariant #1).
    const detail = getItemDetail(handle.db, { itemId: item.id })!;
    expect(detail.transitions.at(-1)).toMatchObject({ fromStepId: "todo", toStepId: step.id, actor: "human" });
  });

  it("leaves the item dispatchable on the pipeline it was sent to", () => {
    // The point of carrying the pipeline: the scheduler resolves a step as
    // this pipeline's step of that id, so an item whose two columns
    // disagreed would be skipped by every tick with nothing to say why.
    const { pipeline, step } = mergePipeline();
    // The step it is being sent to runs `review`, and EO does not
    // dispatch one of those against an item declaring nothing to judge
    // it by (EO-213). Given here rather than on the shared fixture,
    // whose whole point in other tests in this file is what an item
    // with no criteria does.
    updateItem(handle.db, item.id, { spec: REVIEWABLE_SPEC });
    moveItem(handle.db, fakeEngine(), {
      itemId: item.id,
      toStepId: step.id,
      toPipelineId: pipeline.id,
      cancelActiveRun: false,
      comment: "",
    });

    const dispatched = tick(buildTickInput(handle.db, limits, false)).find((dispatch) => dispatch.item.id === item.id);
    // The action and the role of the step it arrived on, not the one it
    // left: both pipelines have a step at position 0, and resolving the
    // wrong one would run an implementer against work that is waiting to
    // be merged.
    expect(dispatched?.action).toBe("review");
    expect(dispatched?.agent?.role).toBe("reviewer");
    expect(dispatched?.item.pipelineId).toBe(pipeline.id);
  });

  it("refuses a step and a pipeline that disagree, naming both, and writes nothing at all", () => {
    const { pipeline } = mergePipeline();
    const before = getItemDetail(handle.db, { itemId: item.id })!;
    const engine = fakeEngine();

    // `review` is a step of the default pipeline. Named together with
    // Merge, the two say different things and there is no correct one to
    // pick — so nothing is written and the answer says so in words.
    const result = moveItem(handle.db, engine, {
      itemId: item.id,
      toStepId: "review",
      toPipelineId: pipeline.id,
      cancelActiveRun: false,
      comment: "Ready to merge.",
    });

    expect(result).toMatchObject({ moved: false, blockedByActiveRun: false, cancelledRunId: null, commentId: null });
    // Readable, and naming both halves: a caller cannot act on "the step
    // does not belong to the pipeline" without being told which of the
    // two it got wrong.
    expect(result.problem).toContain("Review");
    expect(result.problem).toContain("Merge");
    expect(result.problem).toContain("Delivery");

    // The item, the thread and the transitions are all as they were —
    // the note especially: it is posted before the transition, so a
    // refusal that ran on would leave a comment about a move that never
    // happened.
    const after = getItemDetail(handle.db, { itemId: item.id })!;
    expect(after.item).toMatchObject({ stepId: "todo", pipelineId: "default" });
    expect(after.comments).toHaveLength(before.comments.length);
    expect(after.transitions).toHaveLength(before.transitions.length);
    expect(engine.notifyStateChange).not.toHaveBeenCalled();
  });

  it("names a step that exists nowhere rather than reporting an internal failure", () => {
    const { pipeline } = mergePipeline();

    const result = moveItem(handle.db, fakeEngine(), {
      itemId: item.id,
      toStepId: "no_such_step",
      toPipelineId: pipeline.id,
      cancelActiveRun: false,
      comment: "",
    });

    expect(result.moved).toBe(false);
    expect(result.problem).toContain("no_such_step");
    expect(result.problem).toContain("Merge");
    expect(getItem(handle.db, item.id)).toMatchObject({ stepId: "todo", pipelineId: "default" });
  });

  it("applies the active-run guard to a cross-pipeline move like any other", () => {
    const { pipeline, step } = mergePipeline();
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement" });
    updateRun(handle.db, run.id, { status: "running" });
    const engine = fakeEngine();
    const move = { itemId: item.id, toStepId: step.id, toPipelineId: pipeline.id, cancelActiveRun: false, comment: "" };

    expect(moveItem(handle.db, engine, move)).toMatchObject({ moved: false, blockedByActiveRun: true, problem: null });
    expect(engine.cancelRun).not.toHaveBeenCalled();
    expect(getItem(handle.db, item.id)).toMatchObject({ stepId: "todo", pipelineId: "default" });

    // And once confirmed, the same move goes through and says what it cost.
    expect(moveItem(handle.db, engine, { ...move, cancelActiveRun: true })).toMatchObject({ moved: true, cancelledRunId: run.id });
    expect(engine.cancelRun).toHaveBeenCalledWith(run.id, "superseded");
    expect(getItem(handle.db, item.id)).toMatchObject({ stepId: step.id, pipelineId: pipeline.id });
  });

  it("leaves the pipeline column untouched when no pipeline is named", () => {
    // The path everything else on the board takes, unchanged: a move
    // within the pipeline writes the step and nothing else.
    const result = moveItem(handle.db, fakeEngine(), { itemId: item.id, toStepId: "review", cancelActiveRun: false, comment: "" });

    expect(result).toEqual({ moved: true, cancelledRunId: null, blockedByActiveRun: false, commentId: null, problem: null });
    expect(getItem(handle.db, item.id)).toMatchObject({ stepId: "review", pipelineId: "default" });
  });
});

describe("listing pipelines (KAN-59, KAN-67)", () => {
  it("hides a conversation-only pipeline from the sidebar", () => {
    // `discussion` is a pipeline whose only step is off-dashboard. It holds
    // conversations, not work, so it is not something anyone picks — and
    // the rule is derived from the steps, not from its id.
    const ids = listPipelineViews(handle.db, { projectId: null }).pipelines.map((pipeline) => pipeline.id);
    expect(ids).toContain("default");
    expect(ids).not.toContain("discussion");
  });

  it("hides an archived pipeline until the Archive asks for it", () => {
    const pipeline = createPipeline(handle.db, { name: "Hotfix" });
    createStep(handle.db, { id: "hx", pipelineId: pipeline.id, position: 0, name: "Build", ownerRole: "implementer", entryAction: "implement" });

    expect(listPipelineViews(handle.db, { projectId: null }).pipelines.map((p) => p.id)).toContain(pipeline.id);

    archivePipeline(handle.db, pipeline.id, 1234);

    expect(listPipelineViews(handle.db, { projectId: null }).pipelines.map((p) => p.id)).not.toContain(pipeline.id);
    const archived = listPipelineViews(handle.db, { projectId: null, includeArchived: true }).pipelines.find((p) => p.id === pipeline.id);
    expect(archived?.archivedAt).toBe(1234);
  });
});

/**
 * Attaching an item to a Jira issue after the fact, moving it to
 * another, letting it go, and switching what it says (EO-125).
 *
 * The half that makes the link a setting rather than a submit-time
 * decision. Everything here goes through `items:update`, which is the
 * one door the item rail and `ticket_update` both come in by, so what
 * a person can do to a link an agent can do too.
 *
 * Nothing calls Jira — attaching is a local write (the pinned decision
 * on EO-121), and the pulls below prove it by refusing on the item's
 * own row.
 */
describe("items:update and Jira", () => {
  let repository: Workspace;

  /**
   * Never reached. `pullItem` reads the switch off the item before
   * it resolves a connection, so a `fetchImpl` that rejects is the
   * assertion that nothing was fetched.
   */
  const jiraContext: JiraContext = {
    credentials: {
      directory: "/nonexistent",
      store: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(""), decryptString: () => "" },
    },
    fetchImpl: () => Promise.reject(new Error("Jira must not be called")),
  };

  beforeEach(() => {
    // A repository, because every push site gates on one as well as on
    // the key: without it "no push was queued" would prove nothing.
    repository = attachWorkspace(handle.db, { name: "svc", keyPrefix: "SVC", repoPath: "/tmp/svc" });
  });

  function mirrored(jiraKey: string | null, title = "Mirrored"): Item {
    return createTestItem(handle.db, {
      type: "story",
      title,
      stepId: "todo",
      workspaceId: repository.id,
      ...(jiraKey === null ? {} : { jiraKey }),
    });
  }

  function notes(itemId: Uuid): string[] {
    return listCommentsForItem(handle.db, itemId)
      .filter((comment) => comment.authorType === "engine")
      .map((comment) => comment.body);
  }

  it("attaches a key to an item that had none, and says so on the item", () => {
    const subject = mirrored(null);

    // The canonical spelling is what lands: `linkJiraKey` parses through
    // `JiraIssueKeySchema`, so the row holds what `jira/pull.ts` matches
    // on rather than what somebody typed.
    expect(updateItemText(handle.db, { itemId: subject.id, jiraKey: "  kan-123 " })).toEqual({ updated: true, problem: null });

    expect(jiraStateOf(getItem(handle.db, subject.id)!).key).toBe("KAN-123");
    expect(notes(subject.id).at(-1)).toContain("now mirrors KAN-123");
    // The half a reader needs most (invariant 8, and the same sentence
    // the submit path uses): the title and body they are looking at are
    // about to be replaced by Jira's, and a note that did not say so
    // would make the pull that follows look like EO losing their edit.
    expect(notes(subject.id).at(-1)).toMatch(/being brought in/i);
  });

  it("marks the attached item for the pull that brings the issue in (EO-127)", () => {
    // Attaching stays a local write — no request leaves `updateItemText`
    // — so the marker is what the pull schedule drains a moment later.
    const subject = mirrored(null);

    updateItemText(handle.db, { itemId: subject.id, jiraKey: "KAN-123" });

    expect(isJiraPullPending(handle.db, subject.id)).toBe(true);
  });

  it("marks an item moved from one issue to another", () => {
    // The new issue is as unread as a first attach: nothing about the
    // old one says what KAN-2 holds.
    const subject = mirrored("KAN-1");

    updateItemText(handle.db, { itemId: subject.id, jiraKey: "KAN-2" });

    expect(isJiraPullPending(handle.db, subject.id)).toBe(true);
  });

  it("clears the marker when the item is detached", () => {
    // A pull outstanding against an issue this item no longer mirrors
    // would either read the issue somebody just detached it from, or sit
    // in the drain being refused for a key that is null.
    const subject = mirrored("KAN-1");
    expect(isJiraPullPending(handle.db, subject.id)).toBe(true);

    updateItemText(handle.db, { itemId: subject.id, jiraKey: null });

    expect(isJiraPullPending(handle.db, subject.id)).toBe(false);
  });

  it("marks nothing when a key is attached to an item whose sync is off", () => {
    // The point of the switch: attaching with sync off pulls nothing,
    // and the note does not promise otherwise.
    const subject = mirrored(null);
    setJiraSync(handle.db, subject.id, false);

    updateItemText(handle.db, { itemId: subject.id, jiraKey: "KAN-123" });

    expect(jiraStateOf(getItem(handle.db, subject.id)!).key).toBe("KAN-123");
    expect(isJiraPullPending(handle.db, subject.id)).toBe(false);
    // And the note says so rather than staying quiet about it. Attaching
    // is where somebody expects the issue to arrive, so the one case
    // where it will not is the one worth naming — nothing else in this
    // edit mentions the switch, since it was already off.
    expect(notes(subject.id).at(-1)).toContain("Nothing is being brought in from KAN-123");
  });

  it("asks for the backlog when sync is switched back on over a key", () => {
    // An item that sat off for a week missed everything written on its
    // issue, and no ordinary sweep will find it: `pullProject` asks what
    // moved recently, not what this item missed.
    const subject = mirrored("KAN-1");
    updateItemText(handle.db, { itemId: subject.id, jiraSync: false });
    expect(isJiraPullPending(handle.db, subject.id)).toBe(false);

    updateItemText(handle.db, { itemId: subject.id, jiraSync: true });

    expect(isJiraPullPending(handle.db, subject.id)).toBe(true);
  });

  it("promises no backfill when one edit attaches a key and switches sync off", () => {
    // The two halves land in order, so a note written off the row as it
    // stands between them would promise a pull the next statement takes
    // away.
    const subject = mirrored(null);

    updateItemText(handle.db, { itemId: subject.id, jiraKey: "KAN-123", jiraSync: false });

    expect(isJiraPullPending(handle.db, subject.id)).toBe(false);
    const linkNote = notes(subject.id).find((body) => body.includes("now mirrors KAN-123"))!;
    expect(linkNote).toContain("Nothing is being brought in from KAN-123");
  });

  it("asks for nothing when sync is switched on over an item holding no key", () => {
    const subject = mirrored(null);

    updateItemText(handle.db, { itemId: subject.id, jiraSync: true });

    expect(isJiraPullPending(handle.db, subject.id)).toBe(false);
  });

  it("names the issue it left as well as the one it moved to", () => {
    const subject = mirrored("KAN-1");

    expect(updateItemText(handle.db, { itemId: subject.id, jiraKey: "KAN-2" })).toEqual({ updated: true, problem: null });

    expect(jiraStateOf(getItem(handle.db, subject.id)!).key).toBe("KAN-2");
    // Both keys, because "this item now mirrors KAN-2" alone leaves no
    // record of what it mirrored yesterday — which is exactly what
    // somebody reading the thread after a wrong key is looking for.
    expect(notes(subject.id).at(-1)).toContain("KAN-2");
    expect(notes(subject.id).at(-1)).toContain("KAN-1");
  });

  it("says nothing about a key that was already this item's", () => {
    const subject = mirrored("KAN-1");
    const before = notes(subject.id).length;

    // A form resubmitted unchanged. `linkJiraKey` writes nothing for it,
    // so neither does the thread — a note per save would bury the one
    // that recorded a real change.
    expect(updateItemText(handle.db, { itemId: subject.id, jiraKey: "kan-1" })).toEqual({ updated: true, problem: null });

    expect(notes(subject.id)).toHaveLength(before);
  });

  it("detaches, drops what was still queued for that issue, and notes it", () => {
    const subject = mirrored("KAN-1");
    transitionItem(handle.db, { itemId: subject.id, toStepId: "review", actor: "human" });
    expect(pendingPushesForItem(handle.db, subject.id, "jira")).not.toEqual([]);

    expect(updateItemText(handle.db, { itemId: subject.id, jiraKey: null })).toEqual({ updated: true, problem: null });

    expect(jiraStateOf(getItem(handle.db, subject.id)!).key).toBeNull();
    // The outbox is a queue, not a ledger — invariant 3 is about
    // `run_events` — and leaving the entries to fail one at a time would
    // produce a run of "no longer mirrored" notes for something the
    // person just asked for deliberately (the pinned decision on EO-121).
    expect(pendingPushesForItem(handle.db, subject.id, "jira")).toEqual([]);
    expect(notes(subject.id).at(-1)).toContain("no longer mirrors KAN-1");
  });

  it("refuses a key another item holds, names that item, and changes nothing at all", () => {
    const holder = mirrored("KAN-1", "Holder");
    const subject = mirrored("KAN-9", "Subject");
    const before = notes(subject.id).length;

    const result = updateItemText(handle.db, { itemId: subject.id, jiraKey: "kan-1", title: "Renamed" });

    expect(result).toEqual({ updated: false, problem: `${holder.key} is already linked to KAN-1.` });
    // The title too: the refusable half runs first precisely so a
    // refused edit cannot half-land, leaving somebody a renamed item
    // alongside a refusal saying nothing happened.
    expect(getItem(handle.db, subject.id)).toMatchObject({ title: "Subject" });
    expect(jiraStateOf(getItem(handle.db, subject.id)!).key).toBe("KAN-9");
    expect(jiraStateOf(getItem(handle.db, holder.id)!).key).toBe("KAN-1");
    expect(notes(subject.id)).toHaveLength(before);
  });

  it("answers a key that is not one with the problem, through the real request path", async () => {
    // Only this test proves it: the ones above call `updateItemText`
    // directly and so skip `handleIpcRequest`, which parses the payload
    // first. A `JiraIssueKeySchema` on the request would turn the
    // malformed case — and only that case — into `Invalid request
    // payload`, so `ticket_update`'s own refusal would never render and
    // the caller would be told its transport was wrong rather than which
    // of its fields was. The same correction EO-124 made to a plan.
    const subject = mirrored(null);

    const result = await handleIpcRequest(
      "items:update",
      { itemId: subject.id, jiraKey: "https://acme.atlassian.net/browse/KAN-1" },
      (parsed) => updateItemText(handle.db, parsed),
      { exposeErrorDetails: true },
    );

    // `ok: true` is the point: a refused edit is an answer, not a failed
    // request.
    expect(result.ok).toBe(true);
    expect(result.ok && result.data.updated).toBe(false);
    expect(result.ok && result.data.problem).toContain("KAN-123");
    expect(jiraStateOf(getItem(handle.db, subject.id)!).key).toBeNull();
  });

  it("refuses an edit to an item that is gone rather than throwing", () => {
    expect(updateItemText(handle.db, { itemId: uuidv7(), title: "Renamed" })).toEqual({
      updated: false,
      problem: "That ticket no longer exists.",
    });
  });

  it("stops a story's pushes and its pulls, and resumes them against the key it kept", async () => {
    const subject = mirrored("KAN-1");

    expect(updateItemText(handle.db, { itemId: subject.id, jiraSync: false })).toEqual({ updated: true, problem: null });

    transitionItem(handle.db, { itemId: subject.id, toStepId: "review", actor: "human" });
    expect(pendingPushesForItem(handle.db, subject.id, "jira")).toEqual([]);
    expect((await pullItem(handle.db, jiraContext, subject.id)).problem).toContain("sync switched off");
    // The point of having a switch at all: the key stays, so this is
    // reversible without anybody typing KAN-1 again.
    expect(jiraStateOf(getItem(handle.db, subject.id)!)).toMatchObject({ key: "KAN-1", sync: false });
    expect(notes(subject.id).at(-1)).toContain("Jira sync is off");
    // A story has no stories under it, and saying so on every item on
    // the board would be noise standing in for a fact nobody doubted.
    expect(notes(subject.id).at(-1)).not.toMatch(/stories under it/);

    expect(updateItemText(handle.db, { itemId: subject.id, jiraSync: true })).toEqual({ updated: true, problem: null });

    transitionItem(handle.db, { itemId: subject.id, toStepId: "todo", actor: "human" });
    expect(pendingPushesForItem(handle.db, subject.id, "jira").map((entry) => entry.kind)).toEqual(["status"]);
    // Not "nothing was pulled": the repository has no Jira connection in
    // this test, so the pull gets that far and stops there instead.
    expect((await pullItem(handle.db, jiraContext, subject.id)).problem).not.toContain("sync switched off");
    expect(notes(subject.id).at(-1)).toContain("Jira sync is on");
    expect(notes(subject.id).at(-1)).toContain("KAN-1");
  });

  it("carries the switch down a feature's stories and counts them on the feature", () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: "todo", workspaceId: repository.id, jiraKey: "KAN-10" });
    const first = createTestItem(handle.db, { type: "story", title: "One", stepId: "todo", parentId: feature.id, workspaceId: repository.id, jiraKey: "KAN-11" });
    const second = createTestItem(handle.db, { type: "story", title: "Two", stepId: "todo", parentId: feature.id, workspaceId: repository.id, jiraKey: "KAN-12" });
    // Archived, and still cascaded to: it holds its key, `pullProject`
    // still pulls it, and leaving it loud would be an item talking to
    // Jira after the feature it belongs to was silenced. The same
    // reading of "this feature" `pullItem` takes.
    const archived = createTestItem(handle.db, { type: "story", title: "Three", stepId: "todo", parentId: feature.id, workspaceId: repository.id, jiraKey: "KAN-13" });
    setArchived(handle.db, { itemId: archived.id, archived: true });

    expect(updateItemText(handle.db, { itemId: feature.id, jiraSync: false })).toEqual({ updated: true, problem: null });

    expect([feature, first, second, archived].map((entry) => jiraStateOf(getItem(handle.db, entry.id)!).sync)).toEqual([false, false, false, false]);
    expect(notes(feature.id).at(-1)).toContain("3 stories under it were switched off with it.");
    // On the feature and not on each story (the pinned decision on
    // EO-121): a plan of twelve stories would otherwise post twelve
    // identical notes for one action.
    expect(notes(first.id)).toEqual([]);
    expect(notes(second.id)).toEqual([]);
  });

  it("catches a story switched back on by hand, even when the feature was already off", () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: "todo", workspaceId: repository.id, jiraKey: "KAN-10" });
    const story = createTestItem(handle.db, { type: "story", title: "One", stepId: "todo", parentId: feature.id, workspaceId: repository.id, jiraKey: "KAN-11" });
    setJiraSync(handle.db, feature.id, false);
    setJiraSync(handle.db, story.id, true);

    // The feature's own row does not move here, so an implementation
    // that cascaded only when the parent changed would leave the story
    // talking to Jira and say the feature was already quiet.
    expect(updateItemText(handle.db, { itemId: feature.id, jiraSync: false })).toEqual({ updated: true, problem: null });

    expect(jiraStateOf(getItem(handle.db, story.id)!).sync).toBe(false);
    expect(notes(feature.id).at(-1)).toContain("1 story under it was switched off with it.");
  });

  it("counts a cascade that did nothing as none, and says why", () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: "todo", workspaceId: repository.id, jiraKey: "KAN-10" });
    const story = createTestItem(handle.db, { type: "story", title: "One", stepId: "todo", parentId: feature.id, workspaceId: repository.id, jiraKey: "KAN-11" });
    setJiraSync(handle.db, story.id, false);

    updateItemText(handle.db, { itemId: feature.id, jiraSync: false });

    expect(notes(feature.id).at(-1)).toContain("0 stories under it were switched off with it — every one was already off.");

    // And asked for again, with nothing left to change, it writes no
    // second note: every change ends in a comment, but a non-change is
    // not a change.
    const before = notes(feature.id).length;
    expect(updateItemText(handle.db, { itemId: feature.id, jiraSync: false })).toEqual({ updated: true, problem: null });
    expect(notes(feature.id)).toHaveLength(before);
  });

  it("says nought as plainly as three when a feature has no stories yet", () => {
    // A feature whose stories have not been written yet, or whose
    // stories have since been deleted. The count is what a reader has
    // instead of the board, so leaving it out here would read as "the
    // stories were dealt with" for a feature that has none.
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: "todo", workspaceId: repository.id, jiraKey: "KAN-10" });

    expect(updateItemText(handle.db, { itemId: feature.id, jiraSync: false })).toEqual({ updated: true, problem: null });
    expect(notes(feature.id).at(-1)).toContain("It has no stories under it, so 0 were switched off with it.");

    // And the same on the way back, which is the direction somebody
    // reaches for after silencing a feature by mistake.
    expect(updateItemText(handle.db, { itemId: feature.id, jiraSync: true })).toEqual({ updated: true, problem: null });
    expect(notes(feature.id).at(-1)).toContain("It has no stories under it, so 0 were switched on with it.");
    expect(jiraStateOf(getItem(handle.db, feature.id)!).sync).toBe(true);
  });

  it("leaves an ordinary edit exactly as it was", () => {
    // The path every edit written before this took: no Jira field named,
    // no note, no link touched.
    const subject = mirrored("KAN-1");

    expect(updateItemText(handle.db, { itemId: subject.id, title: "Renamed", priority: 2 })).toEqual({ updated: true, problem: null });

    expect(getItem(handle.db, subject.id)).toMatchObject({ title: "Renamed", priority: 2 });
    expect(jiraStateOf(getItem(handle.db, subject.id)!)).toMatchObject({ key: "KAN-1", sync: true });
    expect(notes(subject.id)).toEqual([]);
  });
});

/**
 * Correcting the definition of done (EO-166).
 *
 * The criteria were writable by exactly one actor before this — a Jira
 * pull, which replaces them wholesale and says in the thread what it
 * replaced — and by nobody sitting in front of EO. These go through
 * `items:update`, the one door the item screen and `ticket_update`
 * both come in by, so what a person can correct an agent can correct
 * too and neither can be told a different story about the refusals.
 *
 * The other direction is `jira/pull.test.ts`, which is where "Jira still
 * wins" is proved; nothing here relaxes it, because an item that
 * mirrors an issue is refused rather than allowed to diverge from it.
 */
describe("items:update and acceptance criteria", () => {
  function story(criteria: string[], extra: { spec?: Record<string, unknown>; jiraKey?: string } = {}): Item {
    return createTestItem(handle.db, {
      type: "story",
      title: "Rate limit",
      stepId: "todo",
      body: "Throttle it.",
      spec: { ...(criteria.length > 0 ? { acceptance_criteria: criteria } : {}), ...(extra.spec ?? {}) },
      ...(extra.jiraKey === undefined ? {} : { jiraKey: extra.jiraKey }),
    });
  }

  function criteria(itemId: Uuid): string[] {
    // Read the way the item screen reads them, not off the row: this
    // is the thing a person is correcting.
    return getItemDetail(handle.db, { itemId })!.item.acceptanceCriteria;
  }

  function notes(itemId: Uuid): string[] {
    return listCommentsForItem(handle.db, itemId)
      .filter((comment) => comment.authorType === "engine")
      .map((comment) => comment.body);
  }

  it("corrects a criterion in place, leaving the rest of the spec alone", () => {
    const subject = story(["429 after 100 req/min", "Retry-After is set"], { spec: { touches: ["src/api.ts"] } });

    expect(updateItemText(handle.db, { itemId: subject.id, acceptanceCriteria: ["429 after 60 req/min", "Retry-After is set"] })).toEqual({
      updated: true,
      problem: null,
    });

    expect(criteria(subject.id)).toEqual(["429 after 60 req/min", "Retry-After is set"]);
    // `spec` also carries what a story touches and a bug's four fields.
    // An edit about none of them must not take them away.
    expect(getItem(handle.db, subject.id)?.spec?.["touches"]).toEqual(["src/api.ts"]);
  });

  it("records what they were, so a reviewer is never silently judging against a target that moved", () => {
    const subject = story(["429 after 100 req/min"]);

    updateItemText(handle.db, { itemId: subject.id, acceptanceCriteria: ["429 after 60 req/min"] });

    const note = notes(subject.id).at(-1) ?? "";
    expect(note).toContain("Acceptance criteria were edited");
    // The old wording verbatim, which is the half a reader cannot get
    // anywhere else — the screen already shows what they say now.
    expect(note).toContain("429 after 100 req/min");
  });

  it("adds criteria to an item that had none, and says that is what happened", () => {
    const subject = story([]);

    expect(updateItemText(handle.db, { itemId: subject.id, acceptanceCriteria: ["429 after 60 req/min"] })).toEqual({ updated: true, problem: null });

    expect(criteria(subject.id)).toEqual(["429 after 60 req/min"]);
    expect(notes(subject.id).at(-1)).toContain("none recorded");
  });

  it("leaves the criteria alone when the call does not mention them", () => {
    const subject = story(["429 after 100 req/min"]);

    expect(updateItemText(handle.db, { itemId: subject.id, title: "Rate limit the API" })).toEqual({ updated: true, problem: null });

    expect(criteria(subject.id)).toEqual(["429 after 100 req/min"]);
    expect(notes(subject.id)).toEqual([]);
  });

  it("refuses an empty list rather than reading it as an instruction to clear them", () => {
    const subject = story(["429 after 100 req/min"]);

    const result = updateItemText(handle.db, { itemId: subject.id, acceptanceCriteria: [] });

    // A story with no criteria is one `work:submitItem` would have
    // refused to create, so an edit must not be able to produce one.
    expect(result.updated).toBe(false);
    expect(result.problem).toContain("empty list");
    expect(criteria(subject.id)).toEqual(["429 after 100 req/min"]);
    expect(notes(subject.id)).toEqual([]);
  });

  it("drops the blank lines a textarea leaves behind, and trims the rest", () => {
    const subject = story([]);

    updateItemText(handle.db, { itemId: subject.id, acceptanceCriteria: ["  429 after 60 req/min  ", "", "   ", "Retry-After is set"] });

    expect(criteria(subject.id)).toEqual(["429 after 60 req/min", "Retry-After is set"]);
  });

  it("says nothing in the thread when the criteria come back unchanged", () => {
    const subject = story(["429 after 100 req/min"]);

    // A form resubmitted unchanged — the same answer a Jira key sent
    // again gets: the item holds what was asked for, and there is
    // nothing to tell a reviewer about.
    expect(updateItemText(handle.db, { itemId: subject.id, acceptanceCriteria: ["429 after 100 req/min"] })).toEqual({ updated: true, problem: null });
    expect(notes(subject.id)).toEqual([]);
  });

  it("refuses while an agent is holding the item, by the rule an amendment is held to", () => {
    const subject = story(["429 after 100 req/min"]);
    const run = createRun(handle.db, { itemId: subject.id, agentId: implementer.id, action: "implement" });
    updateRun(handle.db, run.id, { status: "running" });

    const result = updateItemText(handle.db, { itemId: subject.id, acceptanceCriteria: ["429 after 60 req/min"] });

    // `refuseIfUntouchable`'s own sentence, not a second one written to
    // resemble it: one rule, one wording, whichever door the edit came
    // in by.
    expect(result.updated).toBe(false);
    expect(result.problem).toContain("being worked on right now");
    expect(criteria(subject.id)).toEqual(["429 after 100 req/min"]);
  });

  it("refuses once the item is in review, whatever that step is called", () => {
    const subject = story(["429 after 100 req/min"]);
    transitionItem(handle.db, { itemId: subject.id, toStepId: "review", actor: "human", reason: "ready" });

    const result = updateItemText(handle.db, { itemId: subject.id, acceptanceCriteria: ["429 after 60 req/min"] });

    expect(result.updated).toBe(false);
    expect(result.problem).toContain("in review");
    expect(criteria(subject.id)).toEqual(["429 after 100 req/min"]);
  });

  it("lets the missing criteria through at review, since there is no review to invalidate", () => {
    // The escalation a refused review posts asks for exactly this edit
    // (EO-213), so the in-review clause must not be what turns it down.
    const subject = story([]);
    transitionItem(handle.db, { itemId: subject.id, toStepId: "review", actor: "human", reason: "ready" });

    expect(updateItemText(handle.db, { itemId: subject.id, acceptanceCriteria: ["429 after 60 req/min"] })).toEqual({
      updated: true,
      problem: null,
    });
    expect(criteria(subject.id)).toEqual(["429 after 60 req/min"]);

    // And once they are there, the clause is back: this is an exception
    // for a review that cannot start, not for an item at Review.
    const second = updateItemText(handle.db, { itemId: subject.id, acceptanceCriteria: ["429 after 100 req/min"] });
    expect(second.updated).toBe(false);
    expect(second.problem).toContain("in review");
  });

  it("refuses a title riding along with the missing criteria, rather than letting it through with them", () => {
    // The exception is one field, not a key to the item. A call that
    // renames the work while supplying the criterion EO asked for would
    // be using the one permitted edit as a way past the rule protecting
    // the rest — and the implementer has already finished against the
    // old title.
    const subject = story([]);
    transitionItem(handle.db, { itemId: subject.id, toStepId: "review", actor: "human", reason: "ready" });

    const result = updateItemText(handle.db, {
      itemId: subject.id,
      acceptanceCriteria: ["429 after 60 req/min"],
      title: "Something else entirely",
    });

    expect(result.updated).toBe(false);
    expect(result.problem).toContain("in review");
    // Nothing at all was written — not the title, and not the criteria
    // that would have been allowed on their own.
    expect(criteria(subject.id)).toEqual([]);
    expect(getItem(handle.db, subject.id)?.title).not.toBe("Something else entirely");
  });

  it("lets the priority through on an item whose criteria are refused", () => {
    // The exemption the shared guard already draws: priority only
    // changes the order work is picked up in, so it cannot corrupt
    // anything in flight, and refusing it would mean you could not
    // deprioritise an item precisely when you most want to.
    const subject = story(["429 after 100 req/min"]);
    const run = createRun(handle.db, { itemId: subject.id, agentId: implementer.id, action: "implement" });
    updateRun(handle.db, run.id, { status: "running" });

    expect(updateItemText(handle.db, { itemId: subject.id, priority: 2 })).toEqual({ updated: true, problem: null });
    expect(getItem(handle.db, subject.id)?.priority).toBe(2);
  });

  it("refuses on an item that mirrors a Jira issue, naming the issue that owns the words", () => {
    const subject = story(["429 after 100 req/min"], { jiraKey: "KAN-1" });

    const result = updateItemText(handle.db, { itemId: subject.id, acceptanceCriteria: ["429 after 60 req/min"] });

    // Refused rather than written and quietly lost: the criteria live in
    // that issue's description, and the next pull would replace them.
    expect(result.updated).toBe(false);
    expect(result.problem).toContain("KAN-1");
    expect(criteria(subject.id)).toEqual(["429 after 100 req/min"]);
  });

  it("allows the edit on an item whose Jira sync is off, key and all", () => {
    const subject = story(["429 after 100 req/min"], { jiraKey: "KAN-1" });
    setJiraSync(handle.db, subject.id, false);

    // Nothing is pulled into a silenced item (EO-122), so nothing can
    // overwrite this — the key stays attached for when it is switched
    // back on, and Jira wins again from that moment.
    expect(updateItemText(handle.db, { itemId: subject.id, acceptanceCriteria: ["429 after 60 req/min"] })).toEqual({ updated: true, problem: null });
    expect(criteria(subject.id)).toEqual(["429 after 60 req/min"]);
  });

  it("reads the link this very call is about to change, not the one the row still holds", () => {
    const subject = story(["429 after 100 req/min"], { jiraKey: "KAN-1" });

    // Detaching and correcting in one call: the caller has said this
    // item stops following the issue, so the criteria are theirs to
    // write from here on. Judging that on the row as it stands would
    // refuse an edit that is about to be perfectly safe.
    expect(updateItemText(handle.db, { itemId: subject.id, jiraKey: null, acceptanceCriteria: ["429 after 60 req/min"] })).toEqual({
      updated: true,
      problem: null,
    });
    expect(criteria(subject.id)).toEqual(["429 after 60 req/min"]);
    expect(jiraStateOf(getItem(handle.db, subject.id)!).key).toBeNull();
  });

  it("changes nothing at all when the criteria are refused — the Jira half included", () => {
    const subject = story(["429 after 100 req/min"]);
    const run = createRun(handle.db, { itemId: subject.id, agentId: implementer.id, action: "implement" });
    updateRun(handle.db, run.id, { status: "running" });

    const result = updateItemText(handle.db, { itemId: subject.id, jiraKey: "KAN-1", title: "Renamed", acceptanceCriteria: ["429 after 60 req/min"] });

    // `ticket_update` promises a refused edit changed nothing. Every
    // refusal is therefore decided before the first write, and this is
    // the case that would have caught it: a key attached, and then the
    // criteria turned away.
    expect(result.updated).toBe(false);
    expect(getItem(handle.db, subject.id)).toMatchObject({ title: "Rate limit" });
    expect(jiraStateOf(getItem(handle.db, subject.id)!).key).toBeNull();
    expect(criteria(subject.id)).toEqual(["429 after 100 req/min"]);
    expect(notes(subject.id)).toEqual([]);
  });

  it("carries criteria through the real request path, which is what MCP calls", async () => {
    // The cases above call `updateItemText` directly and so skip the
    // payload parse. `ticket_update`'s arguments are the channel's own
    // schema, so a field the schema does not know is dropped before the
    // handler ever sees it — this is the test that would catch that.
    const subject = story([]);

    const result = await handleIpcRequest(
      "items:update",
      { itemId: subject.id, acceptanceCriteria: ["429 after 60 req/min"] },
      (parsed) => updateItemText(handle.db, parsed),
      { exposeErrorDetails: true },
    );

    expect(result.ok && result.data).toEqual({ updated: true, problem: null });
    expect(criteria(subject.id)).toEqual(["429 after 60 req/min"]);
  });
});

/**
 * Editing the fields a type declares (KAN-147).
 *
 * The other half of the spec shape, and the half a person touches: the
 * detail screen draws a field per property and sends what was typed
 * under the names the type gave them. What holds it is the same shape
 * the creation doors are held to, so an edit cannot produce an item EO
 * would have refused to file — and the sentence a person reads is the
 * type's, not this handler's.
 */
describe("items:update and the type's own fields", () => {
  const CASE = {
    packSlug: "support",
    slug: "case",
    label: "Case",
    plural: "Cases",
    container: false,
    specShape: {
      type: "object" as const,
      properties: {
        customer: { type: "string" as const, minLength: 1, title: "the customer it is for" },
        channel: { type: "string" as const, enum: ["email", "phone"] },
        outcomes: { type: "array" as const, items: { type: "string" as const }, "x-eo-criteria": true },
      },
      required: ["customer"],
    },
    actionOverrides: {},
  };

  function supportCase(spec: Record<string, unknown>): Item {
    syncItemTypes(handle.db, [CASE]);
    return createTestItem(handle.db, { type: "case", title: "ACME cannot sign in", stepId: "todo", spec });
  }

  /** What EO said on the item, which is where a criteria edit leaves its record. */
  function notes(itemId: Uuid): string[] {
    return listCommentsForItem(handle.db, itemId)
      .filter((comment) => comment.authorType === "engine")
      .map((comment) => comment.body);
  }

  it("names the item's type by its pack as well as its word", () => {
    // The detail's spec editor draws the shape of *this* item's type,
    // and `item_types` is unique on (project, pack, slug) — so two packs
    // may ship a `case` and the slug alone names two shapes. The
    // qualified key is what tells the editor which row it is looking at.
    syncItemTypes(handle.db, [CASE, { ...CASE, packSlug: "legal", specShape: { type: "object" as const, properties: {}, required: [] } }]);
    const subject = createTestItem(handle.db, {
      type: { packSlug: "support", slug: "case" },
      title: "ACME cannot sign in",
      stepId: "todo",
      spec: { customer: "ACME" },
    });

    const detail = getItemDetail(handle.db, { itemId: subject.id })!;

    expect(detail.item.typeKey).toBe("support:case");
    // The word stays beside it, because that is what a person reads.
    expect(detail.item.type).toBe("case");
  });

  it("writes the fields the type declares, leaving the rest of the spec alone", () => {
    const subject = supportCase({ customer: "ACME", channel: "email", touches: ["support/acme.md"] });

    expect(updateItemText(handle.db, { itemId: subject.id, spec: { channel: "phone" } })).toEqual({ updated: true, problem: null });

    // Per field, not whole-object: the editor draws what the type
    // declares, and an item may carry more than that.
    expect(getItem(handle.db, subject.id)?.spec).toEqual({ customer: "ACME", channel: "phone", touches: ["support/acme.md"] });
  });

  it("refuses a reclassification the item's own fields would not satisfy", () => {
    // A reclassification writes no spec and still changes what a valid
    // one is: a story turned into a `case` has no customer, and the item
    // would sit there as a Case its own type rejects. The fields it
    // keeps are as much part of the answer as the fields a call sends.
    syncItemTypes(handle.db, [CASE]);
    const subject = createTestItem(handle.db, {
      type: "story",
      title: "Rate limit",
      stepId: "todo",
      spec: { acceptance_criteria: ["429 after 100 req/min"] },
    });

    const result = updateItemText(handle.db, { itemId: subject.id, type: "case" });

    expect(result.updated).toBe(false);
    expect(result.problem).toContain("customer");
    // And the item is exactly as it was: not the type, not the spec.
    expect(getItem(handle.db, subject.id)?.type).toBe("story");
  });

  it("allows a reclassification the item's own fields do satisfy", () => {
    syncItemTypes(handle.db, [CASE]);
    const subject = createTestItem(handle.db, {
      type: "story",
      title: "ACME cannot sign in",
      stepId: "todo",
      spec: { customer: "ACME", channel: "email" },
    });

    expect(updateItemText(handle.db, { itemId: subject.id, type: "case" })).toEqual({ updated: true, problem: null });
    expect(getItem(handle.db, subject.id)?.type).toBe("case");
  });

  it("refuses an edit the type's shape will not accept, even when nothing is missing", () => {
    // The edit door reads the whole validator, exactly as the hand-over
    // door does: a type that closes its shape complains at the root,
    // where no declared field is named, and an edit that slipped past
    // that would produce what creation refuses.
    const sealed = { ...CASE, slug: "sealed", specShape: { ...CASE.specShape, additionalProperties: false } };
    syncItemTypes(handle.db, [sealed]);
    const subject = createTestItem(handle.db, { type: "sealed", title: "ACME cannot sign in", stepId: "todo", spec: { customer: "ACME" } });

    const result = updateItemText(handle.db, { itemId: subject.id, spec: { invented: "no" } });

    expect(result.updated).toBe(false);
    expect(result.problem).toContain("additional properties");
    expect(getItem(handle.db, subject.id)?.spec).not.toHaveProperty("invented");
  });

  it("refuses an edit that would leave a field the type demands empty, in the type's words", () => {
    const subject = supportCase({ customer: "ACME", channel: "email" });

    const result = updateItemText(handle.db, { itemId: subject.id, spec: { customer: "" } });

    expect(result.updated).toBe(false);
    expect(result.problem).toContain("the customer it is for");
    // And nothing was written: a refused edit leaves the item as it was.
    expect(getItem(handle.db, subject.id)?.spec).toMatchObject({ customer: "ACME" });
  });

  it("reads and writes the criteria by the name the type gives them", () => {
    // The `case` shape calls them `outcomes`. The rail's criteria editor
    // is about the field the type declares, so both halves — what the
    // detail shows and what an edit writes — follow the shape.
    const subject = supportCase({ customer: "ACME", outcomes: ["The sign-in works"] });

    expect(getItemDetail(handle.db, { itemId: subject.id })!.item.acceptanceCriteria).toEqual(["The sign-in works"]);

    expect(updateItemText(handle.db, { itemId: subject.id, acceptanceCriteria: ["They can sign in again"] })).toEqual({ updated: true, problem: null });
    expect(getItem(handle.db, subject.id)?.spec).toMatchObject({ outcomes: ["They can sign in again"] });
  });

  /**
   * The criteria are a spec field like any other, so `spec` is a second
   * door onto the one act `acceptanceCriteria` has always been the first
   * door onto (KAN-147). Both go through one guard and leave one record;
   * a door without the guard would move the review target on an item in
   * review, mirroring a Jira issue, or held by the agent working on it.
   */
  describe("criteria sent as a spec field", () => {
    it("is refused where an `acceptanceCriteria` edit is refused, and writes nothing", () => {
      const subject = supportCase({ customer: "ACME", outcomes: ["They can sign in"] });
      transitionItem(handle.db, { itemId: subject.id, toStepId: "review", actor: "human", reason: "ready" });

      const result = updateItemText(handle.db, { itemId: subject.id, spec: { outcomes: ["Something else entirely"] } });

      expect(result.updated).toBe(false);
      expect(result.problem).toContain("in review");
      expect(getItem(handle.db, subject.id)?.spec).toMatchObject({ outcomes: ["They can sign in"] });
    });

    it("leaves the same record in the thread as the other door does", () => {
      const subject = supportCase({ customer: "ACME", outcomes: ["They can sign in"] });

      expect(updateItemText(handle.db, { itemId: subject.id, spec: { outcomes: ["They can sign in again"] } })).toEqual({
        updated: true,
        problem: null,
      });

      expect(getItem(handle.db, subject.id)?.spec).toMatchObject({ outcomes: ["They can sign in again"] });
      // The decision comment `noteCriteriaEdit` posts, which is what
      // makes moving the target somebody is judged against visible —
      // and it says what it replaced.
      expect(notes(subject.id).join("\n")).toContain("Acceptance criteria were edited");
      expect(notes(subject.id).join("\n")).toContain("They can sign in");
    });

    it("cannot empty them, any more than the other door can", () => {
      const subject = supportCase({ customer: "ACME", outcomes: ["They can sign in"] });

      const emptied = updateItemText(handle.db, { itemId: subject.id, spec: { outcomes: [] } });
      expect(emptied.updated).toBe(false);
      expect(emptied.problem).toContain("An empty list is not an edit");

      // And a value that is not a list of criteria at all reads as none,
      // which is the same refusal rather than a silent write.
      const notAList = updateItemText(handle.db, { itemId: subject.id, spec: { outcomes: "They can sign in" } });
      expect(notAList.updated).toBe(false);
      expect(getItem(handle.db, subject.id)?.spec).toMatchObject({ outcomes: ["They can sign in"] });
    });

    it("is refused when the same call sends them both ways", () => {
      const subject = supportCase({ customer: "ACME", outcomes: ["They can sign in"] });

      const result = updateItemText(handle.db, {
        itemId: subject.id,
        acceptanceCriteria: ["One thing"],
        spec: { outcomes: ["Another thing"] },
      });

      expect(result.updated).toBe(false);
      expect(result.problem).toContain("more than once");
      expect(result.problem).toContain("outcomes");
      expect(getItem(handle.db, subject.id)?.spec).toMatchObject({ outcomes: ["They can sign in"] });
    });

    it("is refused on an item whose criteria belong to a Jira issue", () => {
      // The deliberate half of EO-166's Jira criterion: EO writes no
      // field back, so an edit here would last until the next pull
      // replaced it. The spec door must not be the way round that.
      const subject = supportCase({ customer: "ACME", outcomes: ["They can sign in"] });
      updateItem(handle.db, subject.id, { jiraKey: "KAN-1" });

      const result = updateItemText(handle.db, { itemId: subject.id, spec: { outcomes: ["Something else"] } });

      expect(result.updated).toBe(false);
      expect(result.problem).toContain("KAN-1");
    });
  });

  /**
   * Reclassifying and editing in one breath (KAN-147).
   *
   * Which property holds the criteria has two answers while a call is
   * doing both — the type the item is, and the type it is becoming — and
   * recognising only one leaves the other as an ordinary spec field.
   * That was a way past every protection criteria have: the Jira
   * refusal, the lifecycle lock, and the record in the thread.
   */
  describe("criteria and a reclassification in one call", () => {
    it("recognises the target type's criteria field, not only the item's", () => {
      // A `Case` keeps its criteria in `outcomes`; a story's are
      // `acceptance_criteria`. Sending the *story's* name while becoming
      // one used to look like an ordinary spec field.
      const subject = supportCase({ customer: "ACME", outcomes: ["They can sign in"] });
      updateItem(handle.db, subject.id, { jiraKey: "KAN-1" });

      const result = updateItemText(handle.db, { itemId: subject.id, type: "story", spec: { acceptance_criteria: ["changed"] } });

      expect(result.updated).toBe(false);
      expect(result.problem).toContain("KAN-1");
      // Nothing was written — not the criteria, and not the
      // reclassification that carried them.
      expect(getItem(handle.db, subject.id)).toMatchObject({ type: "case" });
      expect(getItem(handle.db, subject.id)?.spec).not.toMatchObject({ acceptance_criteria: ["changed"] });
    });

    it("recognises the item's own criteria field when it is leaving that type", () => {
      // The other direction: a story becoming a `Case`, with the
      // criteria sent under the name it has now.
      syncItemTypes(handle.db, [CASE]);
      const subject = createTestItem(handle.db, {
        type: "story",
        title: "Rate limit",
        stepId: "todo",
        spec: { acceptance_criteria: ["429 after 100 req/min"] },
      });
      updateItem(handle.db, subject.id, { jiraKey: "KAN-2" });

      const result = updateItemText(handle.db, { itemId: subject.id, type: "case", spec: { acceptance_criteria: ["changed"] } });

      expect(result.updated).toBe(false);
      expect(result.problem).toContain("KAN-2");
      expect(getItem(handle.db, subject.id)).toMatchObject({ type: "story" });
    });

    it("writes them under the field the item will have, and records the change", () => {
      // Allowed this time — no Jira issue, nothing locking the item — so
      // this is about *where* they land: under the type's field as the
      // item will be read, not the one it is leaving.
      const subject = supportCase({ customer: "ACME", outcomes: ["They can sign in"] });

      expect(updateItemText(handle.db, { itemId: subject.id, type: "story", spec: { acceptance_criteria: ["429 after 100 req/min"] } })).toEqual({
        updated: true,
        problem: null,
      });

      const after = getItem(handle.db, subject.id)!;
      expect(after.type).toBe("story");
      expect(after.spec).toMatchObject({ acceptance_criteria: ["429 after 100 req/min"] });
      // Read back the way the screen reads them, which is by the field
      // the item's type declares.
      expect(getItemDetail(handle.db, { itemId: subject.id })!.item.acceptanceCriteria).toEqual(["429 after 100 req/min"]);
      // And the record that the target moved, which is the whole reason
      // this goes through one path.
      expect(notes(subject.id).join("\n")).toContain("Acceptance criteria were edited");
      expect(notes(subject.id).join("\n")).toContain("They can sign in");
    });

    it("moves an unchanged list to the field the new type reads, and takes the old one with it", () => {
      // The list is identical, so nothing about what the work is judged
      // against has changed — but *where* it is read from has. Comparing
      // only the lists would leave it under the field the item is
      // leaving, and the story would come out declaring nothing its own
      // type can see: an item no review can start on, produced by a call
      // that answered `updated: true`.
      const subject = supportCase({ customer: "ACME", outcomes: ["They can sign in"] });

      expect(updateItemText(handle.db, { itemId: subject.id, type: "story", acceptanceCriteria: ["They can sign in"] })).toEqual({
        updated: true,
        problem: null,
      });

      const after = getItem(handle.db, subject.id)!;
      expect(after.spec).toMatchObject({ acceptance_criteria: ["They can sign in"] });
      // One item declares its criteria in one place, or a later edit
      // corrects one copy while a reclassification back finds the other.
      expect(after.spec).not.toHaveProperty("outcomes");
      expect(getItemDetail(handle.db, { itemId: subject.id })!.item.acceptanceCriteria).toEqual(["They can sign in"]);
      // Nothing was said in the thread, because nothing about the
      // criteria themselves changed — only which property holds them.
      expect(notes(subject.id).join("\n")).not.toContain("Acceptance criteria were edited");
    });

    it("does the same in the other direction, into a custom criteria field", () => {
      syncItemTypes(handle.db, [CASE]);
      const subject = createTestItem(handle.db, {
        type: "story",
        title: "Rate limit",
        stepId: "todo",
        spec: { acceptance_criteria: ["429 after 100 req/min"] },
      });

      expect(updateItemText(handle.db, { itemId: subject.id, type: "case", spec: { acceptance_criteria: ["429 after 100 req/min"], customer: "ACME" } })).toEqual({
        updated: true,
        problem: null,
      });

      const after = getItem(handle.db, subject.id)!;
      expect(after.type).toBe("case");
      expect(after.spec).toMatchObject({ outcomes: ["429 after 100 req/min"], customer: "ACME" });
      expect(after.spec).not.toHaveProperty("acceptance_criteria");
      expect(getItemDetail(handle.db, { itemId: subject.id })!.item.acceptanceCriteria).toEqual(["429 after 100 req/min"]);
    });

    it("still records a list that genuinely changed while it moved", () => {
      const subject = supportCase({ customer: "ACME", outcomes: ["They can sign in"] });

      updateItemText(handle.db, { itemId: subject.id, type: "story", acceptanceCriteria: ["They can sign in twice"] });

      expect(getItem(handle.db, subject.id)?.spec).toMatchObject({ acceptance_criteria: ["They can sign in twice"] });
      expect(notes(subject.id).join("\n")).toContain("Acceptance criteria were edited");
      expect(notes(subject.id).join("\n")).toContain("They can sign in");
    });

    it("refuses the same field sent under both types' names", () => {
      const subject = supportCase({ customer: "ACME", outcomes: ["They can sign in"] });

      const result = updateItemText(handle.db, {
        itemId: subject.id,
        type: "story",
        spec: { outcomes: ["One thing"], acceptance_criteria: ["Another thing"] },
      });

      expect(result.updated).toBe(false);
      expect(result.problem).toContain("more than once");
      expect(getItem(handle.db, subject.id)).toMatchObject({ type: "case" });
    });
  });

  it("refuses a spec edit on an item nobody may change the content of", () => {
    // A type's other fields are the work's own terms — a bug's
    // `expected`, a `Case`'s customer — so editing one under an
    // in-review item is the content change `refuseIfUntouchable` exists
    // to stop, exactly as renaming it would be.
    const subject = supportCase({ customer: "ACME", outcomes: ["They can sign in"] });
    transitionItem(handle.db, { itemId: subject.id, toStepId: "review", actor: "human", reason: "ready" });

    const result = updateItemText(handle.db, { itemId: subject.id, spec: { channel: "phone" } });

    expect(result.updated).toBe(false);
    expect(result.problem).toContain("in review");
    expect(getItem(handle.db, subject.id)?.spec).not.toMatchObject({ channel: "phone" });
  });

  it("does not let a spec field ride along with the criteria the escalation asked for", () => {
    // The missing-criteria exception is one field, not a key to the
    // item (EO-213): a call that also rewrites the type's own fields is
    // the content change it is.
    const subject = supportCase({ customer: "ACME" });
    transitionItem(handle.db, { itemId: subject.id, toStepId: "review", actor: "human", reason: "ready" });

    const result = updateItemText(handle.db, { itemId: subject.id, acceptanceCriteria: ["They can sign in"], spec: { channel: "phone" } });

    expect(result.updated).toBe(false);
    expect(result.problem).toContain("in review");
    expect(getItem(handle.db, subject.id)?.spec).toMatchObject({ customer: "ACME" });
  });

  it("carries the spec through the real request path, which is what MCP calls", async () => {
    const subject = supportCase({ customer: "ACME" });

    const result = await handleIpcRequest(
      "items:update",
      { itemId: subject.id, spec: { channel: "phone" } },
      (parsed) => updateItemText(handle.db, parsed),
      { exposeErrorDetails: true },
    );

    expect(result.ok && result.data).toEqual({ updated: true, problem: null });
    expect(getItem(handle.db, subject.id)?.spec).toMatchObject({ channel: "phone" });
  });
});
