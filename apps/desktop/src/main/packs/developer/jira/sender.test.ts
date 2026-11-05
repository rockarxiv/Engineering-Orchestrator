import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jiraStateOf, type Item, type Uuid } from "@eo/core";
import type { DbHandle } from "../../../db/client.js";
import {
  getJiraBinding,
  getItem,
  duePushes,
  enqueueOutbox,
  listCommentsForItem,
  pendingPushesForItem,
  postComment,
  projectForWorkspace,
  saveJiraBinding,
  setJiraSync,
  transitionItem,
  updateItem,
  type Workspace,
} from "../../../db/repos/index.js";
import { createJiraConnection } from "../../../db/repos/jiraConnectionsRepo.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import type { FetchLike } from "./client.js";
import type { JiraContext } from "./connection.js";
import { storeToken } from "./credentials.js";
import type { SecretStore } from "../../../secrets/store.js";
import { drainChannel, MAX_ATTEMPTS } from "../../../outbox/drain.js";
import { createJiraSender, withinJiraLimit } from "./sender.js";

/**
 * Keeping the issues current (J-04).
 *
 * The outbox exists so a push never blocks a dispatch and never gets
 * lost. These tests are mostly about the two things that are easy to get
 * wrong: order, and what happens when Jira says no.
 */
let handle: DbHandle;
let directory: string;
let workspace: Workspace;
/**
 * The project holding the Jira binding (KAN-130).
 *
 * A drain reads the *workspace* off the outbox entry — that is what the
 * enqueue denormalised — and hops to its project from there, so a
 * fixture needs both: the workspace to queue against, and the project to
 * configure.
 */
let projectId: Uuid;

const store: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`v1:${Buffer.from(plain).toString("base64")}`),
  decryptString: (encrypted) => Buffer.from(encrypted.toString().slice(3), "base64").toString(),
};

interface Sent {
  path: string;
  body: unknown;
}

/** A Jira that accepts everything and records it, with two transitions available. */
function acceptingJira(currentStatus = "To Do"): { fetchImpl: FetchLike; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    if (init?.method === "POST") sent.push({ path, body: JSON.parse(String(init.body)) });

    if (path.match(/\/issue\/[^/]+$/) && init?.method !== "POST") {
      return new Response(JSON.stringify({ id: "10002", key: "ACME-8", fields: { summary: "Count requests", status: { name: currentStatus } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (path.endsWith("/transitions") && init?.method !== "POST") {
      return new Response(
        JSON.stringify({
          transitions: [
            { id: "21", name: "Start", to: { name: "In Progress" } },
            { id: "31", name: "Finish", to: { name: "Done" } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, sent };
}

function context(fetchImpl: FetchLike): JiraContext {
  return { credentials: { directory, store }, fetchImpl };
}

/** The drain, pointed at the Jira sender — the shape J-04's tests were written against. */
function drainJira(db: typeof handle.db, ctx: JiraContext, now?: number) {
  return now === undefined ? drainChannel(db, "jira", createJiraSender(ctx)) : drainChannel(db, "jira", createJiraSender(ctx), now);
}

function connect(statusMap: Record<string, string> = { review: "In Progress", ready_to_merge: "Done" }): void {
  const site = createJiraConnection(handle.db, { baseUrl: "https://jira.acme.internal", flavour: "datacenter" });
  saveJiraBinding(handle.db, projectId, {
    connectionId: site.id,
    projectKey: "ACME",
    statusMap,
  });
  storeToken({ directory, store }, site.id, "pat");
}

function mirrored(state = "todo"): Item {
  return createTestItem(handle.db, {
    type: "story",
    workspaceId: workspace.id,
    projectId,
    title: "Count requests",
    stepId: state,
    jiraKey: "ACME-8",
    jiraId: "10002",
  });
}

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo jira drain "));
  workspace = attachWorkspace(handle.db, { name: "acme-api", keyPrefix: "ACME", repoPath: "/tmp/acme", baseBranch: "main" });
  projectId = projectForWorkspace(handle.db, workspace.id)!.id;
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("what gets queued", () => {
  it("queues a status push when a mirrored item moves", () => {
    connect();
    const item = mirrored();

    transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "engine" });

    const pending = pendingPushesForItem(handle.db, item.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "status", payload: { toStepId: "review", fromStepId: "todo" } });
  });

  it("queues nothing for an item that is not mirrored", () => {
    // The invariant J-01 promised: with nothing connected, no code path
    // changes. An item with no key is every item in that case.
    connect();
    const item = createTestItem(handle.db, { type: "story", workspaceId: workspace.id, projectId, title: "Local only", stepId: "todo" });

    transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "engine" });

    expect(pendingPushesForItem(handle.db, item.id)).toEqual([]);
  });

  it("queues human and agent comments, but not EO's own notes", () => {
    // "Created ACME-8 in Jira" read back to you inside ACME-8 is noise.
    connect();
    const item = mirrored();

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Cap it at 100." });
    postComment(handle.db, { itemId: item.id, author: { type: "engine" }, kind: "note", body: "Created ACME-8 in Jira." });

    const pending = pendingPushesForItem(handle.db, item.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload).toMatchObject({ body: "Cap it at 100." });
  });

  it("writes the push in the same transaction as its cause", () => {
    // If the transition survived a crash and the push did not, Jira
    // would be permanently behind with nothing to say so.
    connect();
    const item = mirrored();

    expect(() =>
      handle.db.transaction(() => {
        transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "engine" });
        throw new Error("crash");
      }),
    ).toThrow("crash");

    expect(pendingPushesForItem(handle.db, item.id)).toEqual([]);
  });
});

describe("sending", () => {
  it("resolves the mapped status name to a transition id at push time", async () => {
    // Ids are per Jira project and depend on where the issue currently
    // sits, so a stored id would be wrong on someone else's Jira and
    // often on this one.
    connect();
    const jira = acceptingJira();
    const item = mirrored();
    transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "engine" });

    const result = await drainJira(handle.db, context(jira.fetchImpl));

    expect(result.sent).toBe(1);
    expect(jira.sent).toHaveLength(1);
    expect(jira.sent[0]?.path).toContain("/issue/ACME-8/transitions");
    expect(jira.sent[0]?.body).toEqual({ transition: { id: "21" } });
    expect(pendingPushesForItem(handle.db, item.id)).toEqual([]);
  });

  it("sends comments in the order they were written", async () => {
    connect();
    const jira = acceptingJira();
    const item = mirrored();

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "First." });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Second." });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Third." });

    await drainJira(handle.db, context(jira.fetchImpl));

    expect(jira.sent.map((call) => String((call.body as { body: string }).body).split("\n")[0])).toEqual(["First.", "Second.", "Third."]);
  });

  it("says which side a comment came from", async () => {
    connect();
    const jira = acceptingJira();
    const item = mirrored();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Cap it at 100." });

    await drainJira(handle.db, context(jira.fetchImpl));

    expect(String((jira.sent[0]?.body as { body: string }).body)).toContain("— via EO");
  });

  it("puts the branch on the issue, so it is findable from Jira", async () => {
    // The branch is the deliverable. Someone watching the issue rather
    // than the app has no other way to find where the work is.
    connect();
    const jira = acceptingJira();
    const item = mirrored();
    enqueueOutbox(handle.db, { itemId: item.id, workspaceId: workspace.id, channel: "jira", kind: "branch", payload: { branch: "eo/ACME-8" } });

    await drainJira(handle.db, context(jira.fetchImpl));

    expect(jira.sent[0]?.path).toContain("/issue/ACME-8/comment");
    expect(String((jira.sent[0]?.body as { body: string }).body)).toBe("Branch: eo/ACME-8");
  });

  it("does nothing at all when the project is not connected", async () => {
    const jira = acceptingJira();
    const item = mirrored();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Cap it." });

    await drainJira(handle.db, context(jira.fetchImpl));

    expect(jira.sent).toEqual([]);
  });
});

describe("a transition that asks for something (J-05)", () => {
  /** A Jira whose only route to Done demands a resolution. */
  function demandingJira(): { fetchImpl: FetchLike; sent: Sent[] } {
    const sent: Sent[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const path = new URL(url).pathname;
      if (init?.method === "POST") sent.push({ path, body: JSON.parse(String(init.body)) });

      if (path.endsWith("/transitions") && init?.method !== "POST") {
        return new Response(
          JSON.stringify({
            transitions: [
              {
                id: "31",
                name: "Finish",
                to: { name: "Done" },
                fields: {
                  resolution: {
                    name: "Resolution",
                    required: true,
                    schema: { type: "resolution" },
                    allowedValues: [
                      { id: "10000", value: "Done" },
                      { id: "10001", value: "Won't Do" },
                    ],
                  },
                  summary: { name: "Summary", required: true, schema: { type: "string" }, allowedValues: [] },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    };
    return { fetchImpl, sent };
  }

  it("refuses once, legibly, instead of failing six times", async () => {
    // "Resolution is required when moving to Done" is close to a Jira
    // default, and retrying a POST that is missing it fails identically
    // every time.
    connect({ ready_to_merge: "Done" });
    const jira = demandingJira();
    const item = mirrored();

    transitionItem(handle.db, { itemId: item.id, toStepId: "ready_to_merge", actor: "engine" });
    const result = await drainJira(handle.db, context(jira.fetchImpl));

    expect(result).toMatchObject({ dropped: 1, deferred: 0 });
    expect(jira.sent).toEqual([]);
    const note = listCommentsForItem(handle.db, item.id).at(-1)?.body ?? "";
    expect(note).toContain("Resolution");
    expect(note).toContain("Retrying cannot help");
    // Summary is sent from the item already, so asking for it here
    // would be asking twice.
    expect(note).not.toContain("Summary");
  });

  it("writes down what was asked for, so Settings can offer inputs", async () => {
    // Jira only describes transitions available from where an issue
    // currently sits, so this is the only moment the requirement can be
    // learned.
    connect({ ready_to_merge: "Done" });
    const item = mirrored();

    transitionItem(handle.db, { itemId: item.id, toStepId: "ready_to_merge", actor: "engine" });
    await drainJira(handle.db, context(demandingJira().fetchImpl));

    const recorded = getJiraBinding(handle.db, projectId)?.config.transitionFields?.["Done"];
    expect(recorded?.requires.map((field) => field.id)).toEqual(["resolution"]);
    expect(recorded?.requires[0]?.allowedValues).toEqual([
      { id: "10000", value: "Done" },
      { id: "10001", value: "Won't Do" },
    ]);
    expect(recorded?.values).toEqual({});
  });

  it("sends the values once they are filled in", async () => {
    connect({ ready_to_merge: "Done" });
    saveJiraBinding(handle.db, projectId, {
      transitionFields: { Done: { requires: [{ id: "resolution", name: "Resolution", schemaType: "resolution", allowedValues: [] }], values: { resolution: { id: "10000" } } } },
    });
    const jira = demandingJira();
    const item = mirrored();

    transitionItem(handle.db, { itemId: item.id, toStepId: "ready_to_merge", actor: "engine" });
    const result = await drainJira(handle.db, context(jira.fetchImpl));

    expect(result.sent).toBe(1);
    expect(jira.sent[0]?.body).toEqual({ transition: { id: "31" }, fields: { resolution: { id: "10000" } } });
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
  });

  it("sends no fields block at all when the transition asks for nothing", async () => {
    // Some Jira screens reject an empty fields object, and J-04's
    // behaviour should be untouched by any of this.
    connect();
    const jira = acceptingJira();
    const item = mirrored();

    transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "engine" });
    await drainJira(handle.db, context(jira.fetchImpl));

    expect(jira.sent[0]?.body).toEqual({ transition: { id: "21" } });
    expect(getJiraBinding(handle.db, projectId)?.config.transitionFields).toBeNull();
  });
});

describe("when Jira will not take it", () => {
  const offline: FetchLike = async () => {
    throw new TypeError("fetch failed");
  };

  // Entries are queued at the real clock, so a drain's `now` has to be
  // on that scale — and *after* the test enqueued them, which is what
  // the minute is for.
  let now: number;
  beforeEach(() => {
    now = Date.now() + 60_000;
  });

  it("keeps the push and tries again later", async () => {
    // Being offline must lose nothing.
    connect();
    const item = mirrored();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Cap it." });

    const result = await drainJira(handle.db, context(offline), now);

    expect(result).toMatchObject({ sent: 0, deferred: 1 });
    const [pending] = pendingPushesForItem(handle.db, item.id);
    expect(pending?.attempts).toBe(1);
    expect(pending?.lastError).toContain("Could not reach");
    // And not immediately: a Jira that is down stays down for a while.
    expect(pending!.nextAttemptAt).toBeGreaterThan(now);
    expect(duePushes(handle.db, "jira", now)).toEqual([]);
  });

  it("sends it once Jira is back, with nothing lost", async () => {
    connect();
    const item = mirrored();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Cap it." });
    await drainJira(handle.db, context(offline), now);

    const jira = acceptingJira();
    const result = await drainJira(handle.db, context(jira.fetchImpl), now + 10 * 60_000);

    expect(result.sent).toBe(1);
    expect(String((jira.sent[0]?.body as { body: string }).body)).toContain("Cap it.");
  });

  it("holds an item's later pushes behind its stuck one", async () => {
    // A status landing before the comment explaining it is worse than
    // both landing a minute late.
    connect();
    const item = mirrored();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "First." });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Second." });

    let calls = 0;
    const failsOnce: FetchLike = async (url, init) => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" }, ...(init ? {} : {}) });
    };

    const result = await drainJira(handle.db, context(failsOnce), now);

    expect(result).toMatchObject({ sent: 0, deferred: 1 });
    expect(pendingPushesForItem(handle.db, item.id)).toHaveLength(2);
  });

  it("does not let one item's problem hold up another's", async () => {
    connect();
    const stuck = mirrored();
    const fine = createTestItem(handle.db, { type: "story", workspaceId: workspace.id, projectId, title: "Other", stepId: "todo", jiraKey: "ACME-9", jiraId: "10003" });
    postComment(handle.db, { itemId: stuck.id, author: { type: "human" }, body: "Stuck." });
    postComment(handle.db, { itemId: fine.id, author: { type: "human" }, body: "Fine." });

    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("ACME-8")) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    };

    const result = await drainJira(handle.db, context(fetchImpl), now);

    expect(result).toMatchObject({ sent: 1, deferred: 1 });
    expect(pendingPushesForItem(handle.db, fine.id)).toEqual([]);
  });

  it("gives up eventually, and says so on the item", async () => {
    // Invariant #8: nothing silently drops work on the floor.
    connect();
    const item = mirrored();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Cap it." });

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await drainJira(handle.db, context(offline), now);
      now += 60 * 60_000; // well past any backoff, so each pass is a real attempt
    }

    expect(pendingPushesForItem(handle.db, item.id)).toEqual([]);
    const note = listCommentsForItem(handle.db, item.id).at(-1)?.body ?? "";
    expect(note).toContain("Gave up sending a comment to Jira");
    expect(note).toContain("Jira is now behind EO for this ticket");
  });

  it("drops an unmapped state quietly, because that is a choice not a failure", async () => {
    // Most pipelines have states Jira has no opinion about, and a
    // comment on every one of them would bury the thread.
    connect({ ready_to_merge: "Done" });
    const jira = acceptingJira();
    const item = mirrored();

    transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "engine" });
    const result = await drainJira(handle.db, context(jira.fetchImpl));

    expect(result).toMatchObject({ sent: 0, dropped: 1 });
    expect(jira.sent).toEqual([]);
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
  });

  it("refuses an entry queued before Jira sync was switched off, finally and quietly", async () => {
    // The switch can be thrown *after* something was queued, so the
    // enqueue gates are not enough on their own (EO-122). Final rather
    // than deferred: retrying cannot change it, and holding the entry
    // until somebody switches sync back on would eventually send a
    // status change that is by then several moves stale.
    connect();
    const jira = acceptingJira();
    const item = mirrored();
    transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "engine" });
    expect(pendingPushesForItem(handle.db, item.id)).toHaveLength(1);

    setJiraSync(handle.db, item.id, false);
    const result = await drainJira(handle.db, context(jira.fetchImpl));

    expect(result).toMatchObject({ sent: 0, dropped: 1, deferred: 0 });
    expect(jira.sent).toEqual([]);
    // Gone from the queue rather than waiting to be tried again.
    expect(pendingPushesForItem(handle.db, item.id)).toEqual([]);
    // Quiet: turning sync off is a deliberate act, and a note per queued
    // entry is a run of remarks about something the person just did.
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
    // The key is still there, which is what makes it reversible.
    expect(jiraStateOf(getItem(handle.db, item.id)!).key).toBe("ACME-8");
  });

  it("sends an entry queued while sync was off if it is switched back on first", async () => {
    // The other side of "final, not an error": nothing is discarded at
    // the moment the switch is thrown, so a drain that happens after it
    // is switched back on is an ordinary send.
    connect();
    const jira = acceptingJira();
    const item = mirrored();
    transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "engine" });
    setJiraSync(handle.db, item.id, false);
    setJiraSync(handle.db, item.id, true);

    expect(await drainJira(handle.db, context(jira.fetchImpl))).toMatchObject({ sent: 1, dropped: 0 });
  });

  it("treats an issue already in the target status as nothing to do", async () => {
    // Jira does not offer a transition into the status an issue is
    // already in, so "already right" and "not allowed" look identical
    // from the transitions endpoint. Complaining about the first would
    // be a false alarm on the noisiest path there is.
    connect({ review: "In Review" });
    const jira = acceptingJira("In Review");
    const item = mirrored();

    transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "engine" });
    const result = await drainJira(handle.db, context(jira.fetchImpl));

    expect(result).toMatchObject({ sent: 1 });
    // Nothing was posted, and nobody was told about a problem that
    // does not exist.
    expect(jira.sent).toEqual([]);
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
  });

  it("says so when Jira's workflow refuses the move", async () => {
    // Retrying cannot help, and silence would leave the two systems
    // disagreeing with nobody the wiser.
    connect({ review: "Released" });
    const jira = acceptingJira();
    const item = mirrored();

    transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "engine" });
    const result = await drainJira(handle.db, context(jira.fetchImpl));

    expect(result).toMatchObject({ dropped: 1 });
    const note = listCommentsForItem(handle.db, item.id).at(-1)?.body ?? "";
    expect(note).toContain('would not move ACME-8 from "To Do" to "Released"');
    expect(note).toContain("In Progress, Done");
  });
});

/**
 * Remembering which Jira comment a pushed one became.
 *
 * The link exists for a single moment: Jira answers with the new
 * comment's id, and `completePush` deletes the outbox row — the only
 * thing that knows which local comment this was — as soon as the send
 * reports success. Recording it in between is what lets an inbound sync
 * recognise EO's own words instead of importing them back.
 */
describe("what a pushed comment leaves behind", () => {
  /** A Jira that answers a comment POST the way the real one does — with the created comment. */
  function jiraThatAssignsIds(id = "10501"): FetchLike {
    return async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/comment") && init?.method === "POST") {
        return new Response(JSON.stringify({ id, body: "…" }), { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    };
  }

  it("writes the Jira comment id onto the local comment", async () => {
    connect();
    const item = createTestItem(handle.db, { type: "story", title: "Count requests", stepId: "todo", workspaceId: workspace.id, projectId });
    updateItem(handle.db, item.id, { jiraKey: "ACME-8" });
    const comment = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Cap it at 100." });
    expect(comment.jiraCommentId, "nothing is known before the push").toBeNull();

    await drainJira(handle.db, context(jiraThatAssignsIds("10501")));

    const stored = listCommentsForItem(handle.db, item.id).find((entry) => entry.id === comment.id);
    expect(stored?.jiraCommentId).toBe("10501");
  });

  it("leaves it alone when Jira never answered", async () => {
    // A failed push must not claim a link that does not exist — the
    // comment is still owed to Jira and will be retried.
    connect();
    const item = createTestItem(handle.db, { type: "story", title: "Count requests", stepId: "todo", workspaceId: workspace.id, projectId });
    updateItem(handle.db, item.id, { jiraKey: "ACME-8" });
    const comment = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Cap it at 100." });

    const refusing: FetchLike = async () => new Response(JSON.stringify({ errorMessages: ["nope"] }), { status: 500 });
    await drainJira(handle.db, context(refusing));

    expect(listCommentsForItem(handle.db, item.id).find((entry) => entry.id === comment.id)?.jiraCommentId).toBeNull();
    expect(pendingPushesForItem(handle.db, item.id)).toHaveLength(1);
  });

  /**
   * A comment longer than Jira will take (EO-298).
   *
   * Nothing sent Jira was close to its 32,767-character ceiling until an
   * output comment could be a whole diff. What a refusal costs is not
   * only the comment: it is not final, so the *item* is marked blocked
   * and everything queued behind it — the status transition for the move
   * that just happened — waits through six backoffs before EO gives up
   * on a push that could never have succeeded.
   */
  describe("a body longer than Jira will take", () => {
    it("is sent as an excerpt that says where the rest is", () => {
      const enormous = "x".repeat(40_000);
      const sent = withinJiraLimit(enormous);

      expect(sent.length).toBeLessThan(enormous.length);
      expect(sent.startsWith("x".repeat(30_000))).toBe(true);
      expect(sent).toContain("10000 more characters");
      // Nothing is lost: EO's copy of the record is the comment on the
      // item, and Jira has always been the mirror rather than the record.
      expect(sent).toContain("the whole of it is on this ticket in EO");
    });

    it("leaves an ordinary comment exactly as it was written", () => {
      expect(withinJiraLimit("Cap it at 100.")).toBe("Cap it at 100.");
    });

    it("reaches Jira, where the whole of it would have been refused", async () => {
      connect();
      const item = createTestItem(handle.db, { type: "story", title: "Count requests", stepId: "todo", workspaceId: workspace.id, projectId });
      updateItem(handle.db, item.id, { jiraKey: "ACME-8" });
      postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "d".repeat(40_000) });

      let posted = "";
      const capturing: FetchLike = async (input, init) => {
        const url = String(input);
        if (url.includes("/comment")) {
          posted = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          return new Response(JSON.stringify({ id: "10600" }), { status: 201 });
        }
        return new Response("{}", { status: 200 });
      };
      await drainJira(handle.db, context(capturing));

      expect(posted.length).toBeLessThan(32_767);
      expect(posted).toContain("more characters");
      expect(pendingPushesForItem(handle.db, item.id)).toHaveLength(0);
    });
  });
});
